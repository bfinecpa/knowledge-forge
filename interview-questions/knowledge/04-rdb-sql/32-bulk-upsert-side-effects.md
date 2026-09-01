# 대량 UPSERT의 부작용 — 갱신에도 시퀀스를 태우고, 값이 같아도 새 튜플을 낳고, 순서 없는 배치는 서로를 잠근다

> 핵심 관전 포인트: **`INSERT ... ON CONFLICT (키) DO UPDATE`는 "없으면 넣고
> 있으면 고친다"를 한 문장으로 끝내 왕복 한 번·check-then-act 틈 없음·멱등이라는
> 세 가지 편의를 준다. PostgreSQL에서 그 편의는 **세 가지** 숨은 비용 위에 서
> 있다. ① **시퀀스 소모** — 행의 기본값(`nextval()`)은 충돌 판정보다 먼저
> 평가되고 시퀀스는 트랜잭션 밖에서 전진하므로, 갱신 경로로 빠진 행이 받은 값도
> 롤백해도 반납되지 않는다. 그래서 갱신 위주 배치가 돌 때마다 시퀀스가 배치 행
> 수만큼 점프하고, 옛 스키마가 `serial`(= `int4`)이면 테이블이 크지 않아도
> "배치 처리량"의 속도로 고갈된다. ② **값이 같아도 새 튜플 버전** — PG의
> UPDATE는 제자리 수정이 아니라 "새 튜플 삽입 + 옛 튜플에 `xmax` 표시"라, 같은
> 값을 써도 죽은 튜플·WAL·(HOT이 깨지면) 모든 인덱스 갱신·트리거·CDC 이벤트가
> 실제로 발생한다 → `WHERE ... IS DISTINCT FROM`으로 애초에 막는다.
> ③ **데드락** — 충돌한 행마다 행 락을 잡고 커밋까지 쥐는데, 다건 UPSERT는
> VALUES 순서대로 행을 처리하므로 두 배치가 겹치는 키를 다른 순서로 만나면 락
> 획득 순서가 교차해 순환 대기가 되고, PG는 `deadlock_timeout`(기본 1s) 뒤
> `40P01`로 **트랜잭션 전체를 abort**한다. 처방은 "쓰지 말자"가 아니라 대가를
> 알고 쓰는 것이다 — 입력 중복을 접고(PG는 한 문장 안 중복 키가 **에러**다),
> 유니크 키 순으로 정렬한 청크를 짧은 트랜잭션으로 보내고, 트랜잭션 밖의 상한·
> 지터 있는 재시도를 얹고, 갱신 위주면 UPDATE-먼저 분기나 `COPY` + 스테이징
> 테이블로 시퀀스 소모 자체를 없애며, `pg_sequences`의 사용률을 알람에 건다.**

---

## 0. 질문 + 의도

**질문**: "대량 UPSERT(`INSERT ... ON DUPLICATE KEY UPDATE`)의 동작과 주의점은?
(AUTO_INCREMENT 소모, 데드락)"

**PostgreSQL 기준 재해석**: "대량 UPSERT(`INSERT ... ON CONFLICT DO UPDATE`)의
동작과 주의점은? (시퀀스 소모, 값이 같아도 생기는 새 튜플 버전, 데드락)"

**출제 의도**: rationale은 이렇게 적는다 — "**편리한 한 방 쿼리가 AUTO_INCREMENT를
갱신에도 소모해 ID 고갈을 앞당기고, 갭 락과 얽혀 데드락을 만드는 것을 아는지 —
동기화·적재 배치의 단골 도구가 갖는 숨은 비용까지 확인하고 쓰는 습관을 본다.**"
PostgreSQL로 옮기면 앞 절은 **시퀀스**로 그대로 살아남고, 뒷 절의 "갭 락과 얽혀"는
PG에 갭 락이 없으므로 **"행 락 획득 순서가 교차해"**로 바뀐다. 그리고 MySQL에는
없던 **세 번째 비용**이 얹힌다 — MVCC 구조상 값이 같아도 새 튜플 버전이 생겨
bloat·WAL을 낸다. 채점 지점은 셋이다. ① 부작용을 "낭비한다", "데드락 난다"는
이름이 아니라 **메커니즘 사슬**로 끝까지 말하는가 ② 대안(`DO NOTHING`, `MERGE`,
UPDATE-먼저 분기, 정렬, `COPY` 스테이징, bigint 전환)마다 **대가를 같은 호흡에**
붙이는가 ③ 배치를 "짜는" 것이 아니라 "운영되게" 만드는 **안전망**(정렬 규약,
재시도, 사용률 알람, 재현 테스트)을 코드로 말하는가. +α 문항이므로 ①만 정확해도
통과지만, ②③이 있어야 "확인하고 쓰는 습관"이 있는 사람으로 읽힌다.

> 이 문서는 사전 학습용이다(면접 전). 4장 진행 기록에서 반복된 네 가지 약점을
> 이 문항의 지점에 직접 대응시킨다.
>
> - **인과를 사슬로 서술하지 못함** — §2-1(시퀀스 다섯 고리), §3-1(튜플 버전
>   여섯 고리), §4-2(데드락 타임라인)를 한 스텝씩 그리고, §2-5에 뭉뚱그린 표현을
>   사슬로 교체하는 훈련 표를 둔다.
> - **트레이드오프 한쪽 면만** — §6에서 대안 열 가지의 "얻는 것 / 내주는 것"을
>   표로 고정한다.
> - **안전망을 코드로 고정하지 않음** — §8에서 정렬 규약을 타입·SQL로, 재시도를
>   빈으로, 사용률을 알람으로, 데드락과 낭비 UPDATE를 테스트로 박는다.
> - **목록 인출 실패** — §10에 "주의점 8가지"와 "체크리스트 10항"을 둔다.
>
> 락의 일반 원리(PG 행 락 4종·충돌표·`pg_locks` 읽기)는
> [`12-gap-lock-next-key-lock-deadlock.md`](12-gap-lock-next-key-lock-deadlock.md)에,
> 튜플 버전·죽은 튜플·VACUUM의 원리는
> [`11-mvcc-postgresql.md`](11-mvcc-postgresql.md)에 있고, 이 문서는 **UPSERT
> 고유의 부작용**에 집중한다. JPA 쪽 관점은
> [`14-unique-constraint-concurrent-insert.md` §5](../03-jpa-orm/14-unique-constraint-concurrent-insert.md),
> JDBC 배치 자체의 원리는
> [`21-bulk-insert-jdbc-batch.md`](../03-jpa-orm/21-bulk-insert-jdbc-batch.md)를 전제한다.

---

## 1. 동작 — 한 문장 안에서 실제로 무슨 일이 일어나는가

### 1-1. 문장과 의미

이 문서의 예제는 **상품 가격 동기화 배치**다. 외부 가격 시스템이 10분마다 약
20만 건의 `(sku, region, price, updated_at)`을 보내고, 그중 99% 이상은 이미 있는
행의 가격 갱신이다. 게다가 그중 대부분은 **가격이 바뀌지도 않았다**(전체 스냅샷을
매번 보내는 피드라서).

```sql
CREATE TABLE product_price (
    id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- ← 이 integer 가 §2 의 주인공
    sku        text          NOT NULL,
    region     char(2)       NOT NULL,
    price      numeric(12,2) NOT NULL,
    updated_at timestamptz   NOT NULL,
    CONSTRAINT uk_product_price_sku_region UNIQUE (sku, region)   -- ← 충돌 대상(arbiter)
);
```

> 현실 확인 — PostgreSQL의 관행은 `bigint GENERATED ALWAYS AS IDENTITY`라
> 고갈 사고가 MySQL보다 드물다. 그런데 **`serial`은 `int4`다**(`bigserial`이
> `int8`). 옛 마이그레이션이 `serial`로 만든 테이블은 그대로 고갈 후보이므로
> 예제를 `integer`로 둔다.

```sql
-- UPSERT 한 문장. "충돌"의 기준은 ON CONFLICT 에 적은 유니크 인덱스/제약 하나다.
INSERT INTO product_price AS p (sku, region, price, updated_at)   -- AS p: DO UPDATE 에서 짧게 참조
VALUES ('A-100', 'KR', 12900, '2026-08-31 09:00:00+09')
ON CONFLICT (sku, region) DO UPDATE                               -- ① 충돌 대상 명시
   SET price      = EXCLUDED.price,                               -- ② 삽입하려던 행 = EXCLUDED
       updated_at = EXCLUDED.updated_at
 WHERE p.updated_at < EXCLUDED.updated_at;                        -- ③ 조건부 갱신 (§3-2)
```

의미는 정확히 이렇다 — **"이 행을 INSERT하되, `(sku, region)` 유니크 인덱스에서
충돌하면 그 기존 행을 `SET` 절대로 고쳐라. 단 `WHERE`가 참일 때만."** 갱신되는
컬럼은 `SET`에 적은 것뿐이고, 적지 않은 컬럼은 그대로 남는다.

세 가지 이름을 고정하고 간다.

- **`EXCLUDED`** — "충돌 때문에 삽입되지 못한, 내가 넣으려던 행". 의사(pseudo)
  테이블이라 `EXCLUDED.price`처럼 컬럼을 꺼내 쓴다. 기존 행은 테이블 이름
  (또는 `AS p` 별칭)으로 참조한다. MySQL의 `VALUES(col)` / 행 별칭 자리다.
- **arbiter(충돌 대상)** — `ON CONFLICT (sku, region)`의 괄호. "어느 유니크
  인덱스에서의 충돌을 UPSERT로 처리할 것인가"를 지정한다(§1-2).
- **`DO NOTHING`** — 충돌 행을 그냥 건너뛴다. `ON CONFLICT DO NOTHING`처럼
  arbiter를 생략하면 "**어떤** 제약에서 충돌하든 건너뛴다"가 된다.

### 1-2. 충돌 대상(arbiter)을 반드시 지정한다 — 얻는 것과 대가

`DO UPDATE`는 arbiter를 **생략할 수 없다.** 이게 MySQL과의 첫 번째 구조적 차이다.

**얻는 것.** MySQL의 `ON DUPLICATE KEY UPDATE`에서 "KEY"는 *아무* 유니크 키라서,
유니크 인덱스가 둘 이상이면 의도하지 않은 키에서 충돌한 행을 갱신할 수 있고 어느
키였는지 알려주지도 않는다. PG는 그 모호함이 없다.

**대가.** 그래서 **arbiter가 아닌 유니크 제약에서 충돌하면 UPSERT가 처리하지
않고 그냥 터진다.** `uk_barcode`가 따로 있는데 arbiter를 `(sku, region)`으로
지정했다면, 바코드가 겹치는 행은 `ERROR 23505 duplicate key value violates unique
constraint "uk_barcode"`로 문장 전체가 실패한다. "UPSERT를 썼으니 중복은 다
알아서 처리된다"는 오해가 여기서 깨진다.

세부 규칙 셋을 같이 외워 둔다.

- **arbiter로 쓸 유니크 인덱스가 없으면 에러다** — `ERROR 42P10 there is no
  unique or exclusion constraint matching the ON CONFLICT specification`.
  UPSERT는 "유니크 인덱스가 판정해 준다"는 전제 위에 서 있다.
- **부분 유니크 인덱스는 술어까지 적어야 한다.** 소프트 삭제 테이블에서 흔한
  `CREATE UNIQUE INDEX ... ON product_price (sku, region) WHERE deleted_at IS
  NULL`을 arbiter로 쓰려면 `ON CONFLICT (sku, region) WHERE deleted_at IS NULL`
  이라고 인덱스의 `WHERE`를 그대로 반복한다. 빠뜨리면 42P10이다.
- **제약 이름으로도 지정할 수 있다** — `ON CONFLICT ON CONSTRAINT
  uk_product_price_sku_region`. 단 이건 **제약** 이름이지 인덱스 이름이 아니라서,
  `CREATE UNIQUE INDEX`로만 만든 인덱스에는 못 쓴다(컬럼 목록으로 적는다).
  표현식 인덱스면 `ON CONFLICT (lower(email))`처럼 표현식을 그대로 적는다.
- **`EXCLUDE` 제약은 `DO NOTHING`만 된다** — `DO UPDATE`의 arbiter로는 못 쓴다.

### 1-3. 행 하나가 지나가는 순서 — 시퀀스 소모가 충돌 판정보다 앞이다

다건 UPSERT는 VALUES에 적힌 순서대로 **행 하나씩** 다음 단계를 밟는다. 이 순서가
§2·§3·§4의 뿌리라서 외워 둘 가치가 있다.

```text
행 하나가 처리되는 순서 (PostgreSQL, 다건 INSERT ... ON CONFLICT DO UPDATE)

  ① 튜플을 만든다 — 이때 기본값이 평가된다. id 의 nextval() 이 여기서 당겨진다.
        ↓            ← 충돌 여부는 아직 모른다. nextval() 은 트랜잭션 밖에서 전진한다.
  ② arbiter 인덱스를 먼저 확인해 충돌을 판정한다
        ↓                                   ↓
   충돌 없음                              충돌 있음
        ↓                                   ↓
  ③-a 힙에 삽입 + 모든 인덱스에 엔트리   ③-b 기존 행에 행 락(FOR UPDATE 수준)을 건다
      (새 튜플 xmin = 내 XID, xmax = 0)     → DO UPDATE 의 WHERE 를 평가
      결과 카운트 += 1                       → 참이면 새 튜플 버전 생성(옛 튜플에 xmax 표시)
                                              → 거짓이면 갱신 없음. 그래도 락은 잡은 채 지나간다
                                            ①에서 받은 시퀀스 값은 쓰이지 않고 사라진다
        ↓
  ④ 다음 행으로 — 지금까지 잡은 행 락은 문장이 아니라 "트랜잭션" 끝까지 유지
```

세 가지가 여기서 이미 보인다. ①이 ②보다 앞이라서 **충돌 행도 시퀀스를 소모하고**
(§2), ③-b가 제자리 수정이 아니라 **새 튜플 버전**이라서 값이 같아도 비용이 들며
(§3), ③-b에서 잡은 락이 ④에서 풀리지 않고 쌓이므로 **행을 처리하는 순서가 곧 락
획득 순서**가 된다(§4).

> **(가산점 포인트) speculative insertion.** ②의 사전 확인을 통과했는데 실제로
> 넣는 사이에 다른 트랜잭션이 같은 키를 커밋하는 경쟁이 있다. PG는 "일단 넣고
> 취소할 수 있는" 튜플(speculative tuple)을 쓰고, 충돌이 드러나면 즉시 무효화한 뒤
> UPDATE 경로로 돌아간다(그 경우 **죽은 튜플이 하나 더 남는다**). 이 메커니즘 덕에
> `ON CONFLICT`는 check-then-act 틈이 없다 — 경쟁 보호가 애플리케이션이 아니라
> **인덱스 수준**에 있다는 뜻이고, §9의 `MERGE`와 갈리는 지점이 정확히 여기다.

### 1-4. 결과 카운트의 의미와 `RETURNING (xmax = 0)` (가산점 포인트)

PG가 돌려주는 행 수는 **실제로 삽입되거나 갱신된 행 수 하나**다. MySQL 같은
행당 1/2/0 인코딩도, 그것을 뒤집는 드라이버 플래그도 없다. 대신 **세지 않는
것**이 둘 있다.

- `DO NOTHING`으로 건너뛴 행
- `DO UPDATE ... WHERE`가 거짓이라 갱신하지 않은 행(§3-2)

그래서 "1,000건을 보냈는데 카운트가 12"는 정상일 수 있다 — 988건은 값이 그대로라
가드에 걸린 것이다. **배치의 성공 판정을 "카운트 == 보낸 건수"로 하면 이 설계를
넣는 순간 배치가 실패로 뒤집힌다.** 카운트의 의미를 바꿨다는 사실을 로그 문구와
알람 조건에 같이 반영해야 한다.

그럼 "이번 배치에서 몇 건이 **새로** 들어왔나"는 어떻게 아나. 정공법은
`RETURNING`이다.

```sql
INSERT INTO product_price AS p (sku, region, price, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (sku, region) DO UPDATE
   SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at
RETURNING id, (xmax = 0) AS inserted;   -- ← INSERT 였으면 true, UPDATE 였으면 false
```

원리는 튜플 헤더다. 새로 삽입된 튜플은 아직 아무도 지우거나 잠그지 않았으므로
`xmax = 0`이고, 충돌해서 갱신된 행은 ③-b에서 **먼저 잠갔던** 흔적이 새 버전에
남아 `xmax`가 0이 아니다. 다만 이것은 문서로 보증된 API가 아니라 **튜플 헤더의
구현 세부를 읽는 트릭**이므로 통계·로그 용도로 쓰고, 비즈니스 분기의 유일한
근거로 삼을 거면 §6-2처럼 **문장을 나눠 카운트를 분리**하는 쪽이 정직하다.
(PG 17부터는 `MERGE`의 `RETURNING`에서 `merge_action()`으로 분기를 공식적으로
받을 수 있다 — §9.)

> **MySQL 대조**: MySQL은 행당 **1**(삽입) / **2**(갱신) / **0**(값 동일)이라는
> 인코딩을 쓰고, Connector/J가 기본값 `useAffectedRows=false`로 접속하면
> `CLIENT_FOUND_ROWS`가 켜져 0이 1로 올라와 삽입과 구분이 불가능해진다. PG에는
> 이 층이 통째로 없는 대신 "갱신된 건지 삽입된 건지"를 카운트로는 알 수 없어
> `RETURNING`이 필요하다. 얻는 것과 잃는 것이 뒤바뀐 셈이다.

---

## 2. 주의점 ① — 시퀀스 소모, 사슬로 말하기

### 2-1. 다섯 고리

"UPSERT는 시퀀스를 낭비한다"에서 멈추지 않는다. 고리 다섯 개를 순서대로 잇는다.

```text
① 행이 만들어질 때 기본값이 먼저 평가된다
   — id 컬럼의 nextval() 은 튜플을 조립하는 시점에 당겨진다(§1-3 ①). 충돌인지는 그 다음에 안다.
   — DO NOTHING 이어도 마찬가지다. "삽입이 안 됐으니 안 썼겠지" 가 틀리는 지점.
        ↓
② 시퀀스는 트랜잭션의 지배를 받지 않는다
   — nextval() 은 롤백해도 되돌아가지 않는다. 버그가 아니라 설계다: 되돌린다면 동시 세션들이
     같은 값을 받게 되므로 "빈 번호가 생겨도 중복은 없게" 를 택했다. CACHE 를 켜면 세션이
     값을 뭉치로 받아 가고 남은 값은 세션 종료 시 버려진다.
        ↓
③ 시퀀스는 단조 증가만 한다 (되돌리려면 사람이 setval 을 불러야 한다 — §2-4)
   — 크래시·재시작에도 값은 유지된다(WAL 로 기록된다).
        ↓
④ 갱신 위주 배치가 돌 때마다 시퀀스가 "배치 행 수" 만큼 점프한다
   — 20 만 건 UPSERT 에서 199,800 건이 갱신이어도 시퀀스는 200,000 오른다. 테이블 행 수는 200 개 늘 뿐.
        ↓
⑤ 소모 속도 = 행 증가 속도가 아니라 "배치 처리량" → int4 고갈이 예측보다 수십 배 빠르다
   — 고갈 시 증상: ERROR: nextval: reached maximum value of sequence
     "product_price_id_seq" (2147483647) — 갱신 배치는 계속 돌지만 신규 상품 등록만 죽는다.
```

⑤에서 PG가 MySQL보다 **친절한** 점이 하나 있다. MySQL은 카운터가 상한에 멈춘 뒤
같은 값을 다시 쓰려다 `Duplicate entry '2147483647' for key 'PRIMARY'`를 내므로
에러 메시지가 원인을 가리지 않는다(애플리케이션 버그를 먼저 의심하게 된다).
PG는 **`reached maximum value of sequence`라고 원인을 직접 말한다.** 진단 시간이
몇 시간 단위로 갈린다.

### 2-2. 숫자로 — 두 달 반

사슬을 숫자로 닫아야 설득력이 생긴다.

```text
배치: 10 분 주기 × 20 만 건  →  하루 144 회 × 200,000 = 28,800,000 개 / 일

int  (integer identity / serial)  상한 2,147,483,647          ÷ 28,800,000 ≈  74.6 일
bigint (bigint identity / bigserial) 상한 9,223,372,036,854,775,807 ÷ 28,800,000 ≈ 8.8 억 년

테이블 실제 행 수: 20 만 → 30 만 (신규 sku 하루 200 개 기준 1 년 뒤)
행 수 기준 예측이라면 int 고갈까지 수천 년. 실제로는 두 달 반.
```

"수십 배 빠르다"는 말은 여기서 나온다 — 소모 속도의 분모가 "새 행"이 아니라
"배치가 훑은 행"이기 때문이다. 같은 논리로 **재시도도 시퀀스를 태운다**: 데드락으로
abort된 청크를 다시 돌리면 그 청크 행 수만큼 또 오른다(§8-2에서 상한을 두는 이유
중 하나).

> PG에는 **unsigned 정수 타입이 없다.** MySQL이 급할 때 꺼내는 "일단
> `INT UNSIGNED`로 두 배 벌기" 카드가 PG에는 아예 없고, 선택지는 `bigint`
> 전환뿐이다.

### 2-3. 왜 "그냥 bigint로 만들면 끝"이 아닌가

새 테이블이면 `bigint GENERATED ALWAYS AS IDENTITY`가 맞다. 문제는 **이미
`serial`로 만들어 수억 건이 쌓인 운영 테이블**이다. PG에서 `ALTER TABLE ... ALTER
COLUMN id TYPE bigint`는 **테이블 전체 재작성 + `ACCESS EXCLUSIVE` 잠금**이다.
그 잠금은 진행 중인 롱 쿼리 뒤에 줄을 서고, **그 뒤로 도착하는 모든 SELECT까지
줄 세운다** — 수억 건 테이블에서 이걸 그냥 실행하면 재작성 시간 내내 서비스가
멈춘다.

그래서 정석은 무중단 절차다(상세는
[`14-online-ddl-zero-downtime-schema-change.md`](14-online-ddl-zero-downtime-schema-change.md)):

1. `bigint` 새 컬럼을 추가한다(NULL 허용이면 카탈로그만 바꾸므로 즉시).
2. 트리거로 신규·갱신 행의 새 컬럼을 채우고, 배치로 과거 행을 나눠 백필한다.
3. 새 컬럼에 `CREATE UNIQUE INDEX CONCURRENTLY`로 인덱스를 만든다.
4. `lock_timeout`을 건 짧은 트랜잭션에서 PK를 교체한다 — `ADD CONSTRAINT ...
   PRIMARY KEY USING INDEX ...`로 3의 인덱스를 재사용해 전체 스캔을 피하고,
   실패하면 재시도한다.
5. 시퀀스도 `ALTER SEQUENCE ... AS bigint`로 함께 넓힌다. 컬럼만 넓히면 고갈은
   그대로다. **자식 테이블 FK 컬럼**과 앱의 `Integer → Long`도 같은 계획에.

> **MySQL 대조**: InnoDB에서 이 작업의 통증은 다른 데 있다. ⑴ 타입 변경이
> INSTANT도 INPLACE도 아닌 **COPY**라 gh-ost/pt-osc 같은 외부 도구가 필요하고
> ⑵ 세컨더리 인덱스 리프가 PK를 복제하므로 **PK 4→8바이트가 모든 세컨더리
> 인덱스를 함께 부풀린다**. PG는 인덱스 리프가 PK가 아니라 TID(6바이트)를
> 담으므로 **그 곱셈 효과가 없다** — 커지는 곳은 PK 인덱스 자신과 FK 컬럼·
> 조인 키다([`03-clustered-vs-secondary-index.md`](03-clustered-vs-secondary-index.md)).

그래서 순서는 "bigint 전환"이 아니라 **① 출혈부터 멈추고(§6-2의 UPDATE-먼저·
스테이징) ② 남은 시간을 §2-2처럼 계산한 뒤 ③ 무중단 절차로 전환**이다
(§11 꼬리질문).

### 2-4. PostgreSQL에서만 되는 완화 — `setval`로 구멍을 메울 수 있다 (가산점 포인트)

MySQL의 `AUTO_INCREMENT`는 현재 최댓값 아래로 내릴 수 없지만, PG의 시퀀스는
**독립된 객체라 아래로도 옮길 수 있다.**

```sql
-- 갱신 위주 배치가 벌려 놓은 간격을 실제 최댓값까지 되돌린다
SELECT setval(pg_get_serial_sequence('product_price', 'id'),
              (SELECT max(id) FROM product_price));
```

응급 처치로는 강력하지만 조건이 까다롭다. ⑴ **동시에 INSERT가 없어야 한다** —
누군가 이미 큰 값을 받아 커밋 전이면 그 값과 충돌한다. ⑵ 그 id를 외부 시스템·
캐시·감사 로그가 들고 있다면, 지워진 행의 번호를 다시 발급하는 셈이 되어
**"지운 주문의 번호가 새 주문에 붙는"** 사고가 난다. 그래서 이건 "고갈이 코앞인데
전환 시간을 벌어야 하는" 상황의 카드이지 상시 운영 수단이 아니다. 근본 처방은
소모 자체를 없애는 §6-2다.

### 2-5. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 사슬로 바꾼 표현 |
|---|---|
| "UPSERT는 시퀀스를 낭비해요" | "행을 조립할 때 `nextval()`이 먼저 평가되고 → 충돌이면 UPDATE로 가지만 시퀀스는 트랜잭션 밖이라 반납이 없고 → 단조 증가라 되돌아오지도 않으며 → 갱신 위주 배치가 돌 때마다 배치 행 수만큼 점프하고 → 소모 속도가 배치 처리량에 비례해 `serial`(int4) 고갈이 행 증가 기준 예측보다 수십 배 빠릅니다" |
| "값이 같으면 UPDATE는 공짜죠" | "PG의 UPDATE는 제자리 수정이 아니라 새 튜플 삽입 + 옛 튜플에 xmax 표시라 → 값이 같아도 죽은 튜플이 하나 생기고 → WAL이 그만큼 쓰이고 → 같은 페이지에 여유가 없으면 HOT이 깨져 모든 인덱스에 엔트리가 꽂히며 → VACUUM이 따라오지 못하면 bloat로 남고 → 트리거와 논리 복제 이벤트까지 발화합니다. 그래서 `WHERE ... IS DISTINCT FROM`으로 애초에 갱신을 막습니다" |
| "대량 UPSERT는 데드락이 나요" | "충돌 행마다 행 락을 잡고 커밋까지 쥐고 → 다건 문장은 VALUES 순서로 처리하니 → 두 배치가 겹치는 키를 다른 순서로 만나면 획득 순서가 교차해 → 순환 대기가 되고 → `deadlock_timeout` 1초 뒤 감지돼 한쪽이 `40P01`로 **트랜잭션째** abort됩니다" |
| "정렬하면 돼요" | "정렬은 순서 교차형을 없애고 → 남는 것(다른 쓰기 경로, 유니크 키 삽입 대기)은 재시도로 받치고 → 재시도는 UPSERT가 멱등이라 안전하며 → 단 재시도도 시퀀스를 태우니 상한과 지터를 둡니다" |

---

## 3. 주의점 ② — 값이 같아도 새 튜플 버전이 생긴다 (PostgreSQL 고유)

MySQL을 기준으로 배운 사람이 PG에서 가장 자주 밟는 지뢰가 이것이다. "어차피 같은
값을 쓰는 UPDATE니까 비용이 없겠지"가 **PG에서는 정확히 틀린다.**

### 3-1. 여섯 고리

```text
① UPDATE 는 제자리 수정이 아니다
   — PG 의 MVCC 는 옛 튜플을 힙에 그대로 두고 새 버전 튜플을 추가한 뒤,
     옛 튜플 헤더의 xmax 에 "이 XID 가 지웠다" 를 적는다. 값이 같아도 이 절차는 동일하다.
        ↓
② 죽은 튜플이 하나 생긴다
   — 20 만 건 UPSERT 가 전부 "안 바뀐 갱신" 이면 죽은 튜플 20 만 개. 10 분마다.
        ↓
③ WAL 이 쓰인다
   — 변경은 전부 WAL 에 남는다. 체크포인트 직후 첫 변경이면 full_page_writes 로
     8KB 페이지 이미지가 통째로 실린다 → 레플리카 전송량·아카이브 용량·디스크 I/O 로 번진다.
        ↓
④ HOT 이 깨지면 모든 인덱스에 엔트리가 꽂힌다
   — 인덱스된 컬럼이 하나도 안 바뀌고 같은 페이지에 여유 공간이 있으면 HOT 업데이트로
     인덱스를 안 건드린다. 그런데 죽은 튜플이 쌓여 페이지 여유가 사라지면 조건이 깨지고,
     그 순간부터 새 튜플은 다른 페이지에 앉아 그 테이블의 **모든** 인덱스에 엔트리를 추가한다.
        ↓
⑤ VACUUM 이 따라오지 못하면 bloat 로 굳는다
   — autovacuum 임계는 기본 "죽은 튜플이 살아 있는 행의 20%". 10 분마다 20 만 건이면
     VACUUM 이 상시 돌고, 롱 트랜잭션이 하나라도 열려 있으면 회수 자체가 막힌다
     → 테이블·인덱스가 부풀고, Index Only Scan 이 힙 페치로 퇴화한다.
        ↓
⑥ 트리거·감사 로그·CDC 가 발화한다
   — UPDATE 트리거가 20 만 번 돌고, 논리 복제/Debezium 은 20 만 건의 변경 이벤트를
     다운스트림(검색 색인, 캐시 무효화, 웹훅)으로 흘려보낸다.
```

⑥이 실무에서 가장 아프다. DB 부하는 그래프로 보이지만, **"가격이 안 바뀐 상품
20만 건의 변경 이벤트"가 10분마다 검색 색인과 캐시 무효화를 때리는 것**은 원인을
찾기 전까지 "왜 캐시 적중률이 낮지?"로만 보인다.

### 3-2. 처방 — `WHERE ... IS DISTINCT FROM`

```sql
-- ❌ before: 값이 같아도 무조건 새 튜플을 만든다
INSERT INTO product_price AS p (sku, region, price, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (sku, region) DO UPDATE
   SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at;

-- ✅ after: 실제로 달라진 행만 갱신한다
INSERT INTO product_price AS p (sku, region, price, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (sku, region) DO UPDATE
   SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at
 WHERE (p.price, p.updated_at) IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.updated_at);
```

**`IS DISTINCT FROM`을 쓰는 이유는 NULL이다.** `p.price <> EXCLUDED.price`는 한쪽이
NULL이면 결과가 NULL(=거짓 취급)이라, "NULL이었던 값이 실제 값으로 바뀌는" 갱신을
조용히 건너뛴다. `IS DISTINCT FROM`은 NULL을 하나의 값처럼 비교해
`NULL vs NULL → 같음`, `NULL vs 100 → 다름`으로 판정한다. 행 생성자
`(a, b) IS DISTINCT FROM (c, d)`로 여러 컬럼을 한 번에 비교할 수 있다.

주의할 대가 셋.

- **걸러진 행도 락은 잡힌다.** ③-b에서 이미 행 락을 걸고 나서 `WHERE`를 평가하기
  때문이다. 즉 이 가드는 **쓰기 비용은 없애지만 데드락 위험은 줄이지 않는다.**
  §4의 정렬 처방은 그대로 필요하다.
- **결과 카운트의 의미가 바뀐다**(§1-4). 걸러진 행은 카운트에도 `RETURNING`에도
  나오지 않는다.
- **컬럼을 추가할 때 조건절도 같이 고쳐야 한다.** 새 컬럼을 `SET`에만 넣고
  `WHERE`에서 빠뜨리면 그 컬럼만 바뀐 행이 영영 갱신되지 않는다 — 에러가 아니라
  "데이터가 조용히 안 맞는" 버그다. §8-4의 회귀 테스트가 이걸 잡는다.

> **(가산점 포인트) 트리거로도 막을 수 있다.** PG에는 내장 트리거 함수
> `suppress_redundant_updates_trigger()`가 있어 `BEFORE UPDATE FOR EACH ROW`로
> 걸면 "새 행이 옛 행과 완전히 같으면" 갱신을 건너뛴다. 문장을 못 고치는
> 상황(외부 도구가 SQL을 생성하는 경우)의 카드이고, 대가는 모든 UPDATE에 행별
> 트리거 비용이 붙는 것이다. 문장을 고칠 수 있으면 `WHERE`가 낫다.

### 3-3. 측정 — "안 바뀐 갱신"이 얼마나 있는지 숫자로 본다

주장만 하지 말고 재는 법까지 말하면 한 단계 위다. PG는 **DML의 WAL 발생량을
직접 보여준다.**

```sql
-- DML 이므로 실제로 실행된다 → 반드시 트랜잭션으로 감싸 되돌린다
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL)
INSERT INTO product_price AS p (sku, region, price, updated_at)
SELECT sku, region, price, updated_at FROM stage_price
ON CONFLICT (sku, region) DO UPDATE
   SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at;
ROLLBACK;

--  ❌ 가드 없음 : WAL: records=412031 fpi=1893 bytes=48213904
--  ✅ 가드 있음 : WAL: records=41     fpi=0    bytes=6122
```

상시 관찰은 두 뷰로 한다.

```sql
-- ① 얼마나 갱신되고 있고, 그중 HOT 은 얼마나 되나
SELECT n_tup_ins, n_tup_upd, n_tup_hot_upd, n_dead_tup, n_live_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'product_price';
-- n_tup_upd 가 배치 행 수만큼 뛰는데 실제 가격 변동은 몇 건 안 된다면 그 차이가 곧 낭비다.
-- n_tup_hot_upd / n_tup_upd 비율이 낮으면 ④가 깨져 모든 인덱스가 갱신되고 있다는 뜻.

-- ② 이 문장이 쓰는 WAL 총량 (pg_stat_statements, PG 13+ 의 WAL 컬럼)
SELECT calls, rows, mean_exec_time, wal_records, wal_fpi, wal_bytes
FROM pg_stat_statements WHERE query LIKE 'INSERT INTO product_price%';
```

`n_tup_hot_upd` 비율이 낮으면 처방은 두 갈래다 — ⑴ 애초에 갱신을 줄이거나(§3-2)
⑵ 테이블 `fillfactor`를 낮춰(예: 90) 페이지에 HOT 여지를 남긴다. 대가는 테이블이
그만큼 커지고 순차 스캔이 읽을 페이지가 늘어난다는 것.

> **MySQL 대조**: InnoDB는 행을 **제자리에서** 고치고 옛 이미지를 언두 세그먼트에
> 남긴다. 그래서 "같은 값으로 UPDATE"의 비용 구조가 다르고(변경 없으면 binlog에도
> 안 남는 경우가 있다), bloat 대신 **언두 증가·퍼지 지연**으로 나타난다. PG에서
> 이 가드가 훨씬 중요한 이유가 이 구조 차이다.

---

## 4. 주의점 ③ — 데드락, 락 획득 순서의 교차

### 4-1. UPSERT가 잡는 락

`ON CONFLICT DO UPDATE`가 충돌 행에 거는 것은 **행 락**이다(그 행을 실제로 갱신할
것이므로 `FOR UPDATE` 수준). PG의 행 락은 별도 락 테이블이 아니라 **튜플 헤더의
`xmax`에 기록**되므로 락 에스컬레이션도, 잠글 수 있는 행 수 제한도 없다. 대기하는
쪽은 "그 XID가 끝나기를" 기다리며 `pg_stat_activity`에
`wait_event_type = 'Lock'`, `wait_event = 'transactionid'`로 나타난다.

여기에 하나 더 있다. **충돌 없이 삽입되는 행**도 다른 세션을 대기시킨다. 같은
유니크 키를 두 세션이 동시에 넣으면, 두 번째 세션은 첫 번째 트랜잭션이 커밋/롤백할
때까지 기다린 뒤 결과에 따라 충돌 처리로 넘어가거나 삽입한다. 즉 **신규 키 삽입도
락 대기의 한 변이 될 수 있다.**

> **MySQL 대조 — 여기서 없어지는 사고 하나, 남는 사고 하나.**
> InnoDB는 유니크 인덱스 중복 판정에 **넥스트 키 락**(레코드 + 앞 갭)을 걸어서,
> 배치가 쥔 갭에 들어갈 **무관한 새 키**를 넣으려는 제3의 세션까지 세운다.
> READ COMMITTED로 내려도 문서가 명시한 예외(외래 키 검사, 중복 키 검사)라
> 이 갭 락은 남는다. **PostgreSQL에는 갭 락이 없다** — 존재하지 않는 행/범위는
> 잠글 수 없으므로 이 유형의 사고 자체가 없고, 팬텀 방지는 스냅샷 격리나
> SERIALIZABLE(SSI)이 맡는다
> ([`12-gap-lock-next-key-lock-deadlock.md`](12-gap-lock-next-key-lock-deadlock.md)).
> 그 대신 PG에 남는 것은 ⑴ 아래의 **순서 교차**와 ⑵ §3의 **죽은 튜플**이다.

### 4-2. 타임라인 — 두 세션, 반대 순서

`product_price`에 sku `A-100`~`A-999`가 전부 존재한다(→ 모두 UPDATE 경로). 배치
인스턴스 두 대가 같은 20만 건을 각각 다른 순서로 UPSERT한다고 하자.

```text
세션 1: INSERT ... VALUES ('A-100',..), ('A-101',..), ..., ('A-999',..) ON CONFLICT ... DO UPDATE ...
세션 2: INSERT ... VALUES ('A-999',..), ('A-998',..), ..., ('A-100',..) ON CONFLICT ... DO UPDATE ...

시간 →  세션 1                              세션 2                              보유 락
t1      'A-100' 충돌 → 행 락 → 새 버전                                          S1: A-100
t2                                          'A-999' 충돌 → 행 락 → 새 버전      S1: A-100 / S2: A-999
t3      'A-101' … 'A-549' 차례로 행 락      'A-998' … 'A-551' 차례로 행 락      S1: A-100~549 / S2: A-551~999
t4      'A-550' 행 락 획득                                                      S1: A-100~550
t5                                          'A-550' 요청 → S1 의 XID 대기       S2 → S1
t6      'A-551' 요청 → S2 의 XID 대기                                           S1 → S2  = 순환
t7      deadlock_timeout(기본 1s) 경과 → 데드락 감지 → 한쪽을 ERROR 40P01 로 abort
        희생자는 "문장" 이 아니라 트랜잭션 전체가 무효 — 지금까지 갱신한 450 건도 함께 사라진다
```

읽어야 할 포인트 넷.

⑴ 각 행에서 잡은 락은 다음 행으로 넘어가도 **풀리지 않고 쌓인다**(§1-3 ④).
⑵ 그래서 VALUES의 순서가 곧 락 획득 순서이고, **두 세션의 순서가 다르면 언젠가
중간에서 만난다.**
⑶ **감지에 최소 `deadlock_timeout`(기본 1초)이 걸린다.** PG는 락을 기다리기
시작하고 이 시간이 지나야 순환을 검사한다 — 데드락 한 번의 대가는 "실패 + 최소
1초의 지연"이고, 이 값을 무작정 낮추면 정상적인 락 대기마다 검사 비용이 붙는다.
⑷ **희생자는 트랜잭션 전체가 abort된다.** PG의 트랜잭션은 오류가 나면 **abort
상태**가 되어 이후 모든 문장이 `ERROR 25P02 current transaction is aborted`를
내고 `ROLLBACK`만 받아들인다. "실패한 문장만 건너뛰고 계속"이 불가능하므로
**청크 단위로 트랜잭션을 끊어 두는 설계가 필수**가 된다(§7-2). 중간 지점을
살리고 싶으면 `SAVEPOINT`가 있지만 행마다 잡는 건 그 자체로 비싸다.

서버 로그에는 이렇게 남는다(`log_lock_waits = on`을 켜 두면 대기 단계부터 보인다).

```text
ERROR:  deadlock detected
DETAIL:  Process 4711 waits for ShareLock on transaction 88123; blocked by process 4712.
         Process 4712 waits for ShareLock on transaction 88120; blocked by process 4711.
         Process 4711: INSERT INTO product_price AS p (sku, region, ...
CONTEXT: while updating tuple (1423,7) in relation "product_price"
```

실시간 관찰은 이 쿼리 하나면 된다.

```sql
SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
       now() - xact_start AS tx_age, left(query, 60) AS query
FROM pg_stat_activity WHERE wait_event_type = 'Lock' ORDER BY tx_age DESC;
```

이 데드락은 **순서를 통일하면 사라지는 종류**다. 그래서 1순위 처방이 **유니크 키
순 정렬**이다(§7). 다만 정렬로 다 끝나지 않는 이유가 §4-4에 있다.

### 4-3. 격리 수준을 바꿔도 사라지지 않는다

"REPEATABLE READ로 올리면?" / "READ COMMITTED로 내리면?" 둘 다 이 문항의 처방이
아니다. **행 락은 어느 격리 수준에서든 잡히고, 순서 교차는 격리 수준과 무관하다.**
오히려 REPEATABLE READ 이상에서는 다른 트랜잭션이 먼저 갱신한 행을 만나면
`ERROR 40001 could not serialize access due to concurrent update`가 나서
**재시도할 상황이 하나 더 늘어난다**(RC였다면 최신 버전을 다시 읽고 진행했을
경우다). 배치 UPSERT는 기본값 READ COMMITTED로 두고 순서와 재시도로 푸는 것이
정석이다([`transaction-isolation-levels.md`](transaction-isolation-levels.md)).

### 4-4. 운영에서 겹치는 키가 생기는 얼굴 — 목록

"한 번에 한 배치만 도는데 왜 겹치죠?"에 답할 목록이다. 겹치는 키가 생기는 경로가
있는 한 순서 교차는 시간 문제다.

1. **변경 이력형 피드** — 외부가 "수정된 순서"로 보내므로 같은 sku가 한 배치 안에
   여러 번 등장한다. 청크 A와 B가 같은 sku를 다른 위치에서 만난다. (PG에서는 이게
   **한 문장 안이면 아예 에러**다 — §5.)
2. **실행 겹침** — 이전 배치가 끝나기 전에 다음 스케줄이 시작된다(처리 시간이
   주기를 넘는 날). 두 인스턴스가 대부분 같은 키 집합을 다른 순서로 처리한다.
3. **다중 인스턴스** — 파드 2개로 스케일 아웃했는데 파티션 없이 같은 입력을 나눠
   가진 경우.
4. **다른 쓰기 경로** — 운영자 가격 수정 API, 프로모션 배치, 재고 연동 배치가 같은
   행을 UPDATE한다. 이쪽은 UPSERT가 아니어도 같은 행 락을 잡는다.
5. **재시도 폭풍** — 희생자가 지터 없이 곧바로 재시도해 같은 박자로 재충돌한다.

---

## 5. 한 문장 안의 중복 키 — PostgreSQL은 에러로 거부한다

MySQL에서 잘 돌던 배치를 PG로 옮겼을 때 가장 먼저 터지는 것이 이 에러다.

```text
ERROR:  ON CONFLICT DO UPDATE command cannot affect row a second time
HINT:   Ensure that no rows proposed for insertion within the same command
        have duplicate constrained values.
```

**한 INSERT 문장의 VALUES 목록에 같은 `(sku, region)`이 두 번 들어 있으면 문장
전체가 실패한다.** MySQL은 두 번째 행을 순서대로 다시 갱신하고 넘어가지만, PG는
"한 문장이 같은 행을 두 번 건드리는 것"을 금지한다 — 두 번째 갱신이 첫 번째의
결과를 볼 수 없어(같은 문장은 하나의 스냅샷을 쓴다) 의미가 정의되지 않기
때문이다. 그래서 §7-2 ①의 **입력 중복 제거는 PG에서 선택이 아니라 필수**다.
세 가지를 구분해 둔다.

- **`DO UPDATE`** — 문장 내 중복이면 위 에러. 문장 전체 실패.
- **`DO NOTHING`** — 에러가 아니다. 첫 행만 들어가고 나머지는 조용히 건너뛴다.
  "어느 것이 살아남는지"를 통제할 수 없다는 게 대가다.
- **`MERGE`** — 같은 대상 행을 두 번 건드리면 역시 에러(`MERGE command cannot
  affect row a second time`). 문제가 사라지지 않는다.

가장 깔끔한 처방은 **SQL 안에서 접는 것**이다. PG 고유 문법인 `DISTINCT ON`이
중복 제거와 키 순 정렬을 한 번에 한다.

```sql
INSERT INTO product_price AS p (sku, region, price, updated_at)
SELECT DISTINCT ON (sku, region) sku, region, price, updated_at
FROM   stage_price
ORDER  BY sku, region, updated_at DESC   -- 키가 같으면 updated_at 이 가장 큰 행 1 건만 남는다
ON CONFLICT (sku, region) DO UPDATE
   SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at
 WHERE (p.price, p.updated_at) IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.updated_at);
```

`DISTINCT ON (a, b)`는 "`ORDER BY`가 만든 순서에서 `(a, b)`가 같은 그룹의 **첫
행**만 남긴다"는 뜻이다. `ORDER BY`가 `sku, region`으로 시작하므로 결과는
**유니크 키 순으로 정렬된 채** 나오고 — 이게 §4의 데드락 처방을 **덤으로**
해결한다. 중복 제거와 정렬을 자바 쪽 `HashMap` + `Comparator`로 하던 일을 문장
하나가 대신하는 것이다.

---

## 6. 대안과 대가 — 얻는 것 / 내주는 것

한쪽 면만 말하는 습관을 깨기 위해 대안 열 가지를 두 열로 고정한다. 면접에서
어느 하나를 고르면 반드시 **오른쪽 열까지 한 호흡에** 말한다.

### 6-1. 표

| 대안 | 얻는 것 | 내주는 것 |
|---|---|---|
| `ON CONFLICT (키) DO UPDATE` (기준선) | 왕복 1회, check-then-act 틈 없음(보호가 인덱스 수준), 멱등, 충돌 대상이 명시적 | 충돌 행도 시퀀스 소모, 값이 같아도 새 튜플 버전, 락 순서는 스스로 해결 안 됨, **한 문장 내 중복 키는 에러**, arbiter 밖 유니크 충돌은 그냥 23505 |
| `DO NOTHING` | "있으면 무시"를 **오류 은폐 없이** 수행, arbiter 생략 가능, 문장 내 중복도 통과 | 갱신 불가, 시퀀스는 그대로 소모, 건너뛴 행은 카운트·`RETURNING`에 안 나와 "이미 있었다"를 알려면 추가 조회 |
| `DO UPDATE ... WHERE ... IS DISTINCT FROM` | 무의미한 새 튜플·WAL·트리거·CDC 이벤트 제거 | 조건절 유지보수(컬럼 추가 시 빠뜨리면 조용한 미갱신), **걸러진 행도 락은 잡힘**, 카운트 의미가 바뀜 |
| `MERGE` (PG 15+) | 표준 SQL, MATCHED/NOT MATCHED 분기 + DELETE까지, 소스가 테이블·서브쿼리 | **동시 INSERT 보호가 없어 23505 가능 → 재시도 필수**, 같은 대상 행 두 번이면 에러, `RETURNING`은 PG 17부터 |
| UPDATE 먼저 → 없는 것만 INSERT | 갱신 위주면 시퀀스 소모 ≈ 신규 행 수, 갱신/신규 카운트가 분리돼 명확 | 문장 2개, 사이의 레이스 → 유니크 위반 폴백 필수, **`UPDATE`에는 `ORDER BY`가 없어** 락 순서 통제가 헐거움 |
| `COPY` → 임시 테이블 → 단일 UPSERT | 왕복·파싱 최소, 중복 제거·정렬·가드를 전부 SQL로, 파라미터 개수 한도 무관 | 스테이징 쓰기 비용, 임시 테이블은 세션 상태(PgBouncer 트랜잭션 풀링 주의), 트랜잭션이 길어짐 |
| 유니크 키 정렬 + 청크 | 순서 교차형 데드락 소멸, 락 보유 짧음, 실패 시 버릴 양이 작음 | 정렬 비용(메모리·CPU, 스트리밍 불가), 커밋 횟수↑, 청크 간 원자성 없음 → 멱등 재실행 전제 |
| 키 해시/범위 파티셔닝 병렬 | 워커 간 겹치는 키 없음 → **구조적으로** 데드락 0, 처리량 | 파티션 경계 설계, 워커 수만큼 커넥션(**PG는 커넥션 = 프로세스**라 더 비싸다), 키 편중 시 한 워커만 느림 |
| `bigint identity` 전환 | 고갈 문제 사실상 소멸 | 타입 변경 = 테이블 재작성 + ACCESS EXCLUSIVE → 새 컬럼·백필·스왑 절차 필요, 시퀀스도 `AS bigint`로, 앱 타입 전파 |
| 자연 키 PK (대리 키 제거) | 시퀀스 자체가 없어져 소모 문제 원천 제거 | PK 인덱스가 넓어지고 **FK 컬럼·조인 키**에 그 폭이 전파, PK 교체 마이그레이션 비용 |

### 6-2. 각 항목에서 놓치기 쉬운 지점

**`DO NOTHING`은 MySQL `INSERT IGNORE`의 대응이 아니다.** `INSERT IGNORE`가
나쁜 이유는 "중복만 무시"가 아니라 **문자열 잘림·타입 변환 실패까지 경고로 낮춰
통과시키기** 때문인데, PG의 `DO NOTHING`은 오직 지정한 충돌만 건너뛴다. 게다가
PG는 애초에 `varchar(32)`에 40자를 넣으면 에러다. **"조용히 틀린 데이터"라는
위험 자체가 PG 쪽에는 없다** — 이건 PG의 명확한 우위이므로 대조로 말할 가치가
있다.

**`REPLACE INTO`는 PG에 없다.** 흉내 내려면 `DELETE` + `INSERT`인데 PG에서는 대가가
더 크다: ⑴ 새 시퀀스 값을 또 받아 PK가 바뀌고(그 id를 들고 있던 자식 FK·캐시·외부
시스템이 고아가 된다) ⑵ **죽은 튜플이 삭제분 + 새 삽입으로 두 번** 생기며 ⑶ 새
행이라 HOT이 성립할 여지가 없어 **모든 인덱스에 엔트리가 꽂히고** ⑷ 문장에 적지
않은 컬럼은 기본값으로 초기화된다("가격만 바꿨는데 등록일이 오늘이 됐다"가 이
사고다). 전 컬럼 교체는 `DO UPDATE SET`에 컬럼을 다 적는 쪽이 모든 면에서 낫다.

**UPDATE 먼저 → 없는 것만 INSERT** — 갱신 위주 동기화 배치에서 **시퀀스 출혈을
멈추는 가장 현실적인 처방**이고, PG에서는 왕복을 늘리지 않고 **세트 기반 두
문장**으로 쓸 수 있다.

```sql
-- ① 있는 것만 갱신 (실제로 달라진 행만)
UPDATE product_price p
   SET price = s.price, updated_at = s.updated_at
  FROM stage_price s
 WHERE p.sku = s.sku AND p.region = s.region
   AND (p.price, p.updated_at) IS DISTINCT FROM (s.price, s.updated_at);

-- ② 없는 것만 삽입 — 여기까지 살아남은 행만 nextval() 을 소모한다
INSERT INTO product_price (sku, region, price, updated_at)
SELECT s.sku, s.region, s.price, s.updated_at
  FROM stage_price s
 WHERE NOT EXISTS (SELECT 1 FROM product_price p
                    WHERE p.sku = s.sku AND p.region = s.region);
```

시퀀스 소모가 20만에서 신규 200건으로 내려간다. 대가는 두 가지다. ⑴ ①과 ② 사이의
레이스 — 다른 경로가 같은 키를 그 틈에 넣으면 ②가 23505로 죽는다. 그래서
**유니크 제약은 그대로 두고, 위반 시 그 청크만 `ON CONFLICT`로 폴백**하는 코드가
반드시 붙는다. ⑵ **`UPDATE`에는 `ORDER BY`가 없다** — 행 처리 순서를 플래너가
정하므로 정렬 처방이 헐거워진다. 병렬 배치라면 이 방식과 **키 파티셔닝**을 같이
써야 한다. (한 문장으로 묶고 싶으면 쓰기 가능 CTE — `WITH upd AS (UPDATE ...
RETURNING sku, region) INSERT ... WHERE (sku, region) NOT IN (SELECT ... FROM
upd)` — 도 가능하다. PG 고유 가산점이지만 가독성 대가가 있다.)

**정렬 + 청크** — 정렬은 **유니크 인덱스의 컬럼 순서 그대로** 한다. 인덱스 위
레코드 순서와 락 획득 순서를 일치시키는 것이 목적이므로 다른 기준(`updated_at`
순, 해시 순)으로 정렬하면 의미가 없다. 청크 크기는 "락 보유 시간 × 재시도 시 버릴
양 × **문장당 파라미터 개수 한도**"의 균형이다 — PG의 확장 질의 프로토콜은 바인드
파라미터를 **65,535개**까지만 허용하므로 컬럼 4개짜리 다건 VALUES면 이론상
16,383행에서 막힌다. 500~1,000이 흔한 출발점이고, 청크 크기는 시퀀스 소모 총량을
바꾸지 않는다(행당 1개는 그대로).

**파티셔닝 병렬** — 정렬이 "겹쳐도 같은 순서"라면 파티셔닝은 "아예 안 겹치게"다.
해시로 입력을 갈라 워커마다 서로소인 키 집합을 주면 워커 간 데드락은 **구조적으로**
없다. 각 워커 안에서는 여전히 정렬한다(다른 쓰기 경로와의 교차 대비). 대가는
스큐와 커넥션 수인데, **PG의 커넥션은 스레드가 아니라 OS 프로세스**라 워커를
늘리는 비용이 MySQL보다 크다
([`15-connection-count-vs-throughput.md`](15-connection-count-vs-throughput.md)).

**자연 키 PK** — `(sku, region)`이 행의 정체성이고 다른 테이블이 이 행을 FK로
참조하지 않는다면 대리 키 `id`가 애초에 필요 없다. 복합 PK로 만들면 시퀀스 자체가
없어 소모 문제가 사라진다. **PG에서 대가의 모양이 MySQL과 다르다** — PG는 인덱스
리프가 PK가 아니라 TID를 담으므로 "넓은 PK가 모든 세컨더리 인덱스를 부풀리는"
곱셈 효과가 없고, 커지는 곳은 PK 인덱스 자신과 이 행을 참조하게 될 **FK 컬럼·
조인 키**다. 대량 매핑 테이블(좋아요, 팔로우, 가격표)에선 자주 옳은 선택이다.
외부 채번은 [`26-unique-id-generation-at-scale.md`](26-unique-id-generation-at-scale.md).

---

## 7. 안전한 대량 UPSERT — before / after

### 7-1. before — 외부 순서 그대로, 병렬 청크, 가드 없음, 재시도 없음

```java
// ❌ BEFORE — 잘 돌다가 어느 날 새벽 "deadlock detected" 와 함께 가격 5,000 건이 유실됐다
@Service
@RequiredArgsConstructor
public class PriceSyncService {

    private static final String UPSERT = """
            INSERT INTO product_price AS p (sku, region, price, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (sku, region) DO UPDATE
               SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at
            """;

    private final JdbcTemplate jdbcTemplate;

    @Transactional
    public void sync(List<PriceRow> rows) {                    // rows: 외부가 보낸 순서 = 수정 시각 순 = 키 기준 무작위
        Lists.partition(rows, 5_000).parallelStream()          // ① 병렬 → 워커 스레드마다 다른 커넥션 = 세션 여러 개
            .forEach(chunk -> jdbcTemplate.batchUpdate(UPSERT, chunk, chunk.size(), (ps, r) -> {
                ps.setString(1, r.sku());
                ps.setString(2, r.region());
                ps.setBigDecimal(3, r.price());
                ps.setObject(4, r.updatedAt());
            }));
        // ② @Transactional 은 호출 스레드에만 바인딩된다 — 워커 스레드의 batchUpdate 는 각자 auto-commit
        // ③ 같은 sku 가 피드에 여러 번(변경 이력형) → 청크끼리 겹치는 키를 다른 순서로 → 40P01
        //    (같은 청크 안에 중복이 들어오면 문장 자체가 "cannot affect row a second time" 으로 죽는다)
        // ④ 희생자 청크는 예외로 끝나고 아무도 재시도하지 않는다 → 그 5,000 건은 다음 배치까지 옛 가격
        // ⑤ 20 만 건 중 199,800 건이 갱신인데 시퀀스는 200,000 소모 → serial(int4) 두 달 반
        // ⑥ 그 199,800 건 중 대부분은 값도 안 바뀌었다 → 죽은 튜플 20 만 개 + WAL, 10 분마다
    }
}
```

문제 여섯 개가 한 메서드에 있다. ①②는 스프링 트랜잭션 경계의 오해(부수 버그지만
"세션 여러 개"를 만드는 원인), ③④가 §4의 데드락, ⑤가 §2의 시퀀스 소모, ⑥이
PG에서 새로 추가된 §3의 비용이다.

### 7-2. after — 중복 제거 → 유니크 키 정렬(타입 강제) → 가드 → 청크 트랜잭션 → 트랜잭션 밖 재시도

```java
// ✅ AFTER
@Service
@RequiredArgsConstructor
public class PriceSyncService {

    private static final int CHUNK = 1_000;

    /** uk_product_price_sku_region(sku, region) 의 컬럼 순서와 동일해야 한다 — 인덱스 순서 = 락 획득 순서 */
    private static final Comparator<PriceRow> UNIQUE_KEY_ORDER =
            Comparator.comparing(PriceRow::sku).thenComparing(PriceRow::region);

    private static final String UPSERT = """
            INSERT INTO product_price AS p (sku, region, price, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (sku, region) DO UPDATE
               SET price      = EXCLUDED.price,
                   updated_at = EXCLUDED.updated_at
             WHERE p.updated_at < EXCLUDED.updated_at                    -- 늦게 도착한 옛 데이터가 새 값을 덮지 않게
               AND (p.price, p.updated_at)
                   IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.updated_at) -- 값이 같으면 새 튜플을 만들지 않는다
            """;

    private final JdbcTemplate jdbcTemplate;
    private final TransactionTemplate tx;            // 청크 = 트랜잭션 경계 (호출 스레드에서 명시적으로)
    private final RetryTemplate deadlockRetry;       // §8-2 — 상한 3회, 지수 백오프 + 지터

    public void sync(List<PriceRow> rows) {
        List<PriceRow> latestPerKey = dedupeKeepLatest(rows);                          // ① 같은 키는 최신 1건만 — PG는 필수
        SortedBatch<PriceRow> sorted = SortedBatch.of(latestPerKey, UNIQUE_KEY_ORDER); // ② 정렬을 타입으로 강제 (§8-1)

        for (SortedBatch.Chunk<PriceRow> chunk : sorted.chunks(CHUNK)) {               // ③ 청크 = 짧은 트랜잭션
            deadlockRetry.execute(ctx -> tx.execute(status -> upsertChunk(chunk)));    // ④ 재시도는 트랜잭션 "밖"
        }
    }

    /** List<PriceRow> 가 아니라 SortedBatch.Chunk 만 받는다 — 정렬 안 된 입력은 컴파일이 안 된다 */
    private int[] upsertChunk(SortedBatch.Chunk<PriceRow> chunk) {
        return jdbcTemplate.batchUpdate(UPSERT, chunk.rows(), chunk.rows().size(), (ps, r) -> {
            ps.setString(1, r.sku());
            ps.setString(2, r.region());
            ps.setBigDecimal(3, r.price());
            ps.setObject(4, r.updatedAt());        // OffsetDateTime ↔ timestamptz
        });
    }

    private static List<PriceRow> dedupeKeepLatest(List<PriceRow> rows) {
        Map<PriceKey, PriceRow> latest = new HashMap<>();
        for (PriceRow r : rows)
            latest.merge(r.key(), r, (a, b) -> a.updatedAt().isAfter(b.updatedAt()) ? a : b);
        return List.copyOf(latest.values());
    }
}
```

바뀐 것을 사슬로 읽는다. ① 같은 키를 최신 1건으로 접어 **문장 내 중복 에러(§5)를
없애고 동시에 시퀀스 소모량을 행 수까지 낮추고**, ② 유니크 인덱스 순서로 정렬해
**모든 세션의 락 획득 순서를 통일**하며, ③ 청크마다 트랜잭션을 끊어 락 보유
시간과 실패 시 버릴 양을 줄이고(PG는 데드락이 트랜잭션 전체를 abort하므로 이
경계가 곧 손실 단위다), ④ 데드락 희생자는 트랜잭션이 이미 abort됐으므로
**밖에서** 청크를 처음부터 다시 돌린다 — UPSERT는 같은 입력에 같은 결과라
재실행이 안전하다. 그리고 `WHERE ... IS DISTINCT FROM` 가드가 §3의 죽은 튜플·WAL·
CDC 이벤트를 잘라 낸다.

**갱신 위주 배치라면 한 단계 더 간다.** §6-2의 "UPDATE 먼저 → 없는 것만 INSERT"로
시퀀스 소모를 신규 행 수까지 떨어뜨린다. 그때도 정렬·청크·재시도 골격은 그대로고,
INSERT가 유니크 위반으로 죽는 레이스는 그 청크만 `ON CONFLICT`로 폴백한다.
병렬이 필요하면 ②의 정렬 위에 **해시로 입력을 갈라 워커 N개에 서로소 키 집합**을
준다 — 워커 간 데드락은 구조적으로 사라지고, 각 워커는 자기 파티션 안에서 위
코드를 그대로 돈다.

### 7-3. 전량 동기화라면 정석은 `COPY` + 스테이징 테이블

20만 건을 매번 통째로 받는 배치라면, 한 건씩 바인딩해 보내는 것보다 **`COPY`로
스테이징에 쏟아붓고 SQL 한 문장으로 병합**하는 쪽이 PG의 정석이다.

```sql
BEGIN;

CREATE TEMP TABLE stage_price (
    sku text, region char(2), price numeric(12,2), updated_at timestamptz
) ON COMMIT DROP;

-- pgjdbc 의 CopyManager 로 스트림을 그대로 밀어 넣는다 (파싱·바인딩 비용이 거의 없다)
COPY stage_price (sku, region, price, updated_at) FROM STDIN;

-- 중복 제거 + 유니크 키 순 정렬 + 가드 + UPSERT 를 한 문장으로 (§5)
INSERT INTO product_price AS p (sku, region, price, updated_at)
SELECT DISTINCT ON (sku, region) sku, region, price, updated_at
FROM   stage_price
ORDER  BY sku, region, updated_at DESC
ON CONFLICT (sku, region) DO UPDATE
   SET price = EXCLUDED.price, updated_at = EXCLUDED.updated_at
 WHERE (p.price, p.updated_at) IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.updated_at);

COMMIT;
```

얻는 것 — 왕복과 파싱이 사실상 1회, 중복 제거·정렬·가드가 **전부 SQL 안에서**
일어나 자바 쪽 규약에 의존하지 않고, 바인드 파라미터 한도(65,535)와도 무관하며,
§6-2의 "UPDATE 먼저 → 없는 것만 INSERT"로 갈아타기도 문장만 바꾸면 된다.

내주는 것 — ⑴ 스테이징에 한 번 쓰는 비용 ⑵ **트랜잭션 하나가 길어진다** — 20만
건을 한 트랜잭션에 묶으면 그동안 VACUUM이 그 시점 이후의 죽은 튜플을 회수하지
못하고, 실패 시 전부 날아간다 ⑶ **임시 테이블은 세션 상태**라 PgBouncer의
transaction pooling과 상성이 나쁘다 — 위처럼 `ON COMMIT DROP`으로 한 트랜잭션
안에서 생성·사용·소멸시키면 안전하지만, 트랜잭션 밖으로 넘기면 다음 문장이 다른
서버 커넥션으로 갈 수 있다. 아주 큰 스테이징이면 `UNLOGGED` 테이블도 후보다.

### 7-4. 드라이버·배치에서 확인할 것

- **pgjdbc의 JDBC 배치는 이미 한 번의 왕복으로 간다.** `addBatch()` /
  `executeBatch()`로 보낸 문장들은 드라이버가 파이프라인으로 몰아 보내므로,
  "배치를 썼는데 왜 안 빨라지지"의 원인이 MySQL만큼 자주 왕복인 것은 아니다.
- **`reWriteBatchedInserts=true`는 만능이 아니다.** 이 옵션은 단순
  `INSERT ... VALUES (...)` 배치를 다중 행 한 문장으로 재작성해 **서버 쪽 문장
  실행 횟수**를 줄이지만, 성립 조건이 까다로워 VALUES 뒤에 절이 붙는 UPSERT에서는
  드라이버가 재작성을 포기할 수 있다. **재작성에 기대지 말고**, 꼭 한 문장으로
  보내야 하면 §7-3의 스테이징이나 배열 파라미터 방식을 쓴다.
- **배열 파라미터 + `unnest`** — 다건을 한 문장으로 보내면서 파라미터 개수 한도도
  피하는 PG식 관용구다. 그리고 이 형태에서는 **정렬을 SQL이 보증**한다.

  ```sql
  INSERT INTO product_price AS p (sku, region, price, updated_at)
  SELECT * FROM unnest($1::text[], $2::bpchar[], $3::numeric[], $4::timestamptz[])
                AS t(sku, region, price, updated_at)
  ORDER  BY sku, region                      -- ← 락 획득 순서를 SQL 로 고정
  ON CONFLICT (sku, region) DO UPDATE SET price = EXCLUDED.price, ...;
  ```

- **한 문장 = 원자적.** 1,000행 중 한 행이 NOT NULL 위반이면 문장 전체가
  실패하고, 데드락이면 **트랜잭션 전체**가 abort된다. 청크 크기가 곧 "한 번에
  버리는 양"이다.
- **JPA는 이 문장을 만들어 주지 않는다.** `saveAll()`은 UPSERT가 아니라
  "isNew 판정 → SELECT → INSERT 또는 UPDATE"라 왕복이 행 수만큼 늘 수 있다.
  UPSERT는 네이티브 쿼리나 `JdbcTemplate`으로 쓰게 되고, 그 순간 1차 캐시·
  Auditing·`@Version`·엔티티 리스너가 **동작하지 않는다**
  ([`14-unique-constraint-concurrent-insert.md` §5](../03-jpa-orm/14-unique-constraint-concurrent-insert.md)).
  `updated_at`을 DB 트리거로 채우고 있었다면 그 트리거는 §3의 "안 바뀐 갱신"을
  매번 발화시키는 주범이 되므로 함께 점검한다.

---

## 8. 안전망을 코드로 고정한다

"배치 UPSERT 전엔 키를 정렬합시다"를 위키에 적어 두는 것과 코드가 그것을 강제하는
것은 다른 능력이다. 다섯 가지를 구조로 박는다.

### 8-1. 정렬 규약을 타입으로 — 정렬 안 된 배치는 컴파일이 안 되게

```java
// 정렬된 배치만 만들 수 있는 타입. 생성 경로가 of() 하나뿐이라 "정렬 안 함" 상태가 존재하지 않는다.
public final class SortedBatch<T> {

    public static final class Chunk<T> {
        private final List<T> rows;
        private Chunk(List<T> rows) { this.rows = rows; }      // SortedBatch 만 만들 수 있다
        public List<T> rows() { return rows; }
    }

    private final List<T> sorted;
    private SortedBatch(List<T> sorted) { this.sorted = sorted; }

    public static <T> SortedBatch<T> of(Collection<T> rows, Comparator<? super T> uniqueKeyOrder) {
        return new SortedBatch<>(rows.stream().sorted(uniqueKeyOrder).toList());
    }

    public List<Chunk<T>> chunks(int size) {
        return Lists.partition(sorted, size).stream().map(Chunk::new).toList();
    }
}
```

`upsertChunk(SortedBatch.Chunk<PriceRow>)`처럼 **UPSERT를 실행하는 메서드가 이 타입만
받으면**, 새로 합류한 사람이 `List<PriceRow>`를 그대로 넘기는 코드는 리뷰어의
기억이 아니라 컴파일러가 막는다. 남는 구멍은 `Comparator`가 인덱스 순서와 다른
경우인데, 이것은 §8-5의 재현 테스트가 잡는다.

**더 단단한 선택지는 정렬을 아예 SQL로 옮기는 것이다**(§5의 `DISTINCT ON` +
`ORDER BY`, §7-4의 `unnest ... ORDER BY`). 자바 규약은 사람이 우회할 수 있지만
문장 안의 `ORDER BY`는 우회할 수 없다. 스테이징을 쓸 수 있는 배치라면 이쪽이 더
낫다.

### 8-2. 재시도 정책 — 트랜잭션 밖, 상한, 지터, 그리고 "재시도도 시퀀스를 태운다"

```java
@Configuration
public class BatchRetryConfig {

    @Bean
    RetryTemplate deadlockRetry() {
        return RetryTemplate.builder()
                // PostgreSQL SQLSTATE → 스프링 예외 (spring-jdbc 의 에러 코드 매핑)
                //   40P01 deadlock detected        → DeadlockLoserDataAccessException
                //   40001 serialization failure    → CannotSerializeTransactionException
                //   55P03 lock not available       → CannotAcquireLockException  (lock_timeout / NOWAIT)
                // 셋 다 PessimisticLockingFailureException 의 하위라 하나로 잡힌다
                .retryOn(PessimisticLockingFailureException.class)
                .maxAttempts(3)                                    // 상한 — 구조적 데드락이면 매번 같은 자리에서 죽는다
                .exponentialBackoff(50, 2.0, 1_000, true)          // withRandom=true → 지터: 같은 박자로 재충돌하지 않게
                .build();
    }
}
```

세 규칙은 락 문서와 같다 — **트랜잭션 밖에서**(안에서 잡으면 이미 abort된
트랜잭션 위에서 도는 셈이고, PG에서는 그 안의 모든 문장이 25P02로 죽는다),
**상한**, **지터**. UPSERT 고유의 네 번째 이유가 있다: **재시도 1회 = 청크 행
수만큼 시퀀스 추가 소모**다. 상한 없는 재시도는 커넥션만 태우는 게 아니라 §2의
고갈도 앞당긴다.

그리고 재시도는 진통제다. 추세를 본다 — 데드락 누적 카운터가 우상향이면 정렬이
깨졌거나 새 쓰기 경로가 생긴 것이다.

```sql
SELECT datname, deadlocks, xact_commit, xact_rollback
FROM pg_stat_database WHERE datname = current_database();
```

`log_lock_waits = on`을 켜 두면 `deadlock_timeout`을 넘긴 대기가 서버 로그에
남아, 데드락으로 번지기 전 단계(누가 누구를 얼마나 기다렸는지)까지 잡힌다.

### 8-3. 시퀀스 사용률 모니터링 — 타입 최대치 대비 %로

```sql
-- pg_sequences 는 시퀀스의 현재 값(last_value)과 상한(max_value)을 함께 보여준다.
-- max_value 에는 이미 시퀀스 타입의 상한이 들어 있다 (int4 면 2147483647).
SELECT schemaname, sequencename, data_type, last_value, max_value,
       round(last_value::numeric * 100 / max_value, 2) AS used_pct
FROM   pg_sequences WHERE last_value IS NOT NULL ORDER BY used_pct DESC;

-- 특정 테이블의 identity/serial 컬럼이 어느 시퀀스를 쓰는지
SELECT pg_get_serial_sequence('product_price', 'id');
```

두 가지 함정을 같이 본다. ⑴ `last_value`는 **아직 아무도 호출하지 않았으면
NULL**이고, `CACHE`가 크면 세션이 미리 가져간 값까지 반영된 수치다. ⑵ 시퀀스는
`bigint`인데 **컬럼만 `integer`**면 `max_value`가 안전해 보여도 `ERROR: integer
out of range`로 먼저 죽는다 — 시퀀스뿐 아니라 **컬럼 타입도 같이** 확인한다.

이 쿼리를 **주기 잡 → 메트릭 → 알람**으로 잇는다. `db.sequence.used_ratio{sequence}`
게이지를 1시간마다 발행하고 50%에서 경고, 70%에서 긴급으로 건다(임계값은 예시).
경고의 목적은 "지금 큰일"이 아니라 **§2-3의 무중단 전환 절차를 시작할 시간을 버는
것**이다 — 사용률과 함께 **일간 증가량**을 같이 찍으면 "며칠 남았는가"가 그래프에서
바로 읽힌다(§2-2의 나눗셈을 시스템이 대신 한다).

```java
@Scheduled(fixedDelay = 3_600_000)
public void publishSequenceUsage() {
    for (SequenceUsage u : repo.sequenceUsage())                       // 위 SQL 의 결과
        Gauge.builder("db.sequence.used_ratio", u, SequenceUsage::ratio)
             .tag("sequence", u.name()).register(meterRegistry);
}
```

### 8-4. "안 바뀐 갱신" 회귀 테스트 — 가드가 살아 있는지 숫자로 고정

§3-2의 가드는 컬럼을 추가할 때 조용히 깨지는 종류라 테스트로 박아야 한다. 카운트
단정이 가장 결정적이다.

```java
@Test
void 값이_같은_동기화는_한_행도_갱신하지_않는다() {
    seed(1_000);                                                  // 1,000 행 존재
    List<PriceRow> identical = currentRowsAsFeed();               // DB 와 완전히 같은 값
    assertThat(service.syncAndCountAffected(identical)).isZero(); // 가드가 빠지면 1,000 → 실패
}

@Test
void 가격이_바뀐_행만_갱신된다() {
    seed(1_000);
    List<PriceRow> feed = withPriceChanged(currentRowsAsFeed(), 3);   // 3 건만 값 변경
    assertThat(service.syncAndCountAffected(feed)).isEqualTo(3);
}

@Test
void 갱신_전용_배치는_시퀀스를_소모하지_않는다() {
    seed(1_000);
    long before = lastValue("product_price_id_seq");

    service.sync(sameKeysWithNewPrices(1_000));                   // 전부 갱신, 신규 0

    // ON CONFLICT 한 문장으로 되돌리면 1,000 이 나와 여기서 깨진다 (§6-2 의 분기를 택했을 때의 회귀 테스트)
    assertThat(lastValue("product_price_id_seq") - before).isZero();
}
```

운영 쪽 짝은 §3-3의 `pg_stat_user_tables.n_tup_upd`다 — 배치 전후 증가량이 실제
가격 변동 건수와 자릿수로 벌어지면 가드가 깨진 것이다. WAL 발생량까지 보고 싶으면
배치 전후 `pg_current_wal_lsn()` 차이를 찍어 두면 되지만, 다른 활동이 섞이므로
테스트 단정보다는 대시보드 지표로 쓴다.

### 8-5. 데드락 재현 테스트 — 순서 교차를 타임라인으로 강제한다

다건 문장 하나로도 데드락은 나지만 확률적이다. 테스트에서는 **문장을 둘로 쪼개고
래치로 타임라인을 강제**해 결정적으로 재현한다. DB는 실제 PostgreSQL
(Testcontainers)이어야 한다 — H2는 PG의 행 락을 흉내 내지 않는다.

```java
@SpringBootTest
@Testcontainers
class PriceUpsertDeadlockTest {

    @Container static final PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:16");

    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired PriceSyncService service;

    @Test
    void 반대_순서_UPSERT_두_세션은_정확히_하나가_데드락_희생자가_된다() throws Exception {
        seed("A-100", "A-200");                                           // 둘 다 존재 → 모두 UPDATE 경로
        CountDownLatch bothLockedFirst = new CountDownLatch(2);           // 양쪽이 첫 행을 잠글 때까지 서로 기다린다
        ExecutorService pool = Executors.newFixedThreadPool(2);

        Callable<Void> s1 = () -> { tx.executeWithoutResult(st -> {
            upsertOne("A-100"); bothLockedFirst.countDown(); await(bothLockedFirst);
            upsertOne("A-200");                                           // S2 가 쥔 A-200 을 기다린다
        }); return null; };
        Callable<Void> s2 = () -> { tx.executeWithoutResult(st -> {
            upsertOne("A-200"); bothLockedFirst.countDown(); await(bothLockedFirst);
            upsertOne("A-100");                                           // S1 이 쥔 A-100 을 기다린다 → 순환
        }); return null; };

        List<Future<Void>> results = pool.invokeAll(List.of(s1, s2), 30, TimeUnit.SECONDS);

        long victims = results.stream()
                .filter(f -> failedWith(f, DeadlockLoserDataAccessException.class))   // SQLSTATE 40P01
                .count();
        assertThat(victims).isEqualTo(1);                                 // PG 가 한쪽만 abort 한다
        // 감지까지 deadlock_timeout(기본 1s)이 걸리므로 테스트 타임아웃은 넉넉히 잡는다
    }

    @Test
    void 한_문장에_같은_키가_두_번_들어오면_문장이_거부된다() {
        seed("A-100");
        assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO product_price AS p (sku, region, price, updated_at)
                VALUES ('A-100','KR',1,now()), ('A-100','KR',2,now())
                ON CONFLICT (sku, region) DO UPDATE SET price = EXCLUDED.price
                """))
            .hasMessageContaining("cannot affect row a second time");     // §5 — dedupe 가 필수임을 고정
    }

    @Test
    void 유니크_키_순으로_정렬하면_같은_두_세션이_모두_정상_완료된다() throws Exception {
        seed("A-100", "A-200");
        List<PriceRow> input = List.of(row("A-200"), row("A-100"), row("A-200"), row("A-100"));   // 일부러 뒤섞인 입력
        ExecutorService pool = Executors.newFixedThreadPool(2);

        List<Future<Void>> results = pool.invokeAll(List.of(
                () -> { service.sync(input); return null; },              // 안에서 dedupe + 정렬 + 청크 + 재시도
                () -> { service.sync(input); return null; }), 60, TimeUnit.SECONDS);

        for (Future<Void> f : results) f.get();                           // 예외 없이 둘 다 끝난다 (한쪽은 잠깐 대기)
    }

    private void upsertOne(String sku) {
        jdbc.update("""
            INSERT INTO product_price AS p (sku, region, price, updated_at)
            VALUES (?, 'KR', 1, now())
            ON CONFLICT (sku, region) DO UPDATE SET price = EXCLUDED.price
            """, sku);
    }

    private static void await(CountDownLatch latch) {
        try { if (!latch.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("timeline broken"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IllegalStateException(e); }
    }
}
```

첫 번째 테스트는 **문제가 실재함을 팀에 증명**하고(위키 문장이 아니라 빨간
테스트), 두 번째는 PG 고유의 문장 내 중복 규칙을 고정하며, 세 번째는 **§7-2의
골격이 그것을 막는다는 사실을 회귀로 고정**한다. 누군가 `UNIQUE_KEY_ORDER`를
`updated_at` 순으로 바꾸거나 `SortedBatch`를 우회하는 리팩터링을 하면 세 번째가
깨진다.

---

## 9. `MERGE`(PG 15+)와의 차이 (가산점 포인트)

PG 15부터 표준 SQL의 `MERGE`를 쓸 수 있다. "그럼 이제 `ON CONFLICT` 말고 `MERGE`를
쓰면 되나요?"는 좋은 꼬리질문이고, **답은 "용도가 다르다"**이다.

```sql
MERGE INTO product_price p
USING stage_price s
   ON p.sku = s.sku AND p.region = s.region
WHEN MATCHED AND (p.price, p.updated_at) IS DISTINCT FROM (s.price, s.updated_at)
     THEN UPDATE SET price = s.price, updated_at = s.updated_at
WHEN NOT MATCHED
     THEN INSERT (sku, region, price, updated_at) VALUES (s.sku, s.region, s.price, s.updated_at);
```

| | `INSERT ... ON CONFLICT` | `MERGE` |
|---|---|---|
| 판정 기준 | **유니크 인덱스**에서의 충돌 | `ON` 조건 + **스냅샷**으로 본 매칭 여부 |
| 동시 INSERT 경쟁 | 인덱스 수준에서 막아 준다(speculative insertion) | **보호 없음** — 동시에 같은 키가 들어오면 `NOT MATCHED`로 판정해 INSERT하고 `23505`로 실패할 수 있다 |
| 필요한 것 | arbiter(유니크 인덱스/제약) | 유니크 인덱스가 없어도 됨 |
| 할 수 있는 일 | 삽입 + 갱신(또는 무시) | 조건별 분기, `DELETE`, `DO NOTHING`까지 |
| 한 문장 내 중복 | 에러 | 역시 에러 |

**결정적 차이는 동시성이다.** `MERGE`는 문장이 시작할 때의 스냅샷으로
MATCHED/NOT MATCHED를 정하므로, READ COMMITTED에서 그 사이 커밋된 같은 키를 보지
못해 INSERT로 가고 유니크 위반을 낸다. 그래서 `MERGE`를 동시 쓰기 경로에서 쓰려면
**23505 재시도 루프를 반드시 붙이거나** 격리 수준을 올려야 한다(그러면 40001
재시도가 필요해진다 — 재시도가 사라지는 게 아니라 이름만 바뀐다).

선택 기준은 이렇게 말한다. **"단순 UPSERT + 동시 쓰기가 있는 경로면
`ON CONFLICT`, 배치 전용이고 삭제나 조건별 분기가 필요하면 `MERGE`."** 야간 배치가
스테이징을 상대로 "없으면 넣고, 바뀌었으면 고치고, 사라졌으면 지운다"를 한 문장에
담아야 하는 상황이 `MERGE`의 자리다. (PG 17부터는 `MERGE`에도 `RETURNING`이 생기고
`merge_action()`으로 각 행이 어떤 분기를 탔는지 받을 수 있어, §1-4의 `xmax`
트릭보다 정직한 답이 된다.)

---

## 10. 목록 인출용 — 주의점 8가지 / 체크리스트 10항

면접에서 "주의점이 뭐가 있죠?"에 **번호를 붙여** 내놓는다. 앞의 세 개가 §2·§3·§4의
본론이고, 나머지가 변별점이다.

**UPSERT 주의점 8가지 (PostgreSQL)**

1. **시퀀스 소모** — 기본값 평가가 충돌 판정보다 앞이고 `nextval()`은 트랜잭션 밖이라
   반납이 없다. 갱신 위주 배치는 행 수만큼 시퀀스가 점프한다(§2).
2. **값이 같아도 새 튜플 버전** — 죽은 튜플·WAL·(HOT이 깨지면) 모든 인덱스 갱신·
   트리거·CDC 이벤트. 처방은 `WHERE ... IS DISTINCT FROM`(§3).
3. **데드락(순서 교차)** — 충돌 행마다 행 락을 커밋까지 쥐고 VALUES 순서가 락
   순서다. 감지에 `deadlock_timeout` 1초가 걸리고, 희생자는 **트랜잭션 전체**가
   abort된다(§4).
4. **한 문장 안의 중복 키는 에러** — `DO UPDATE`는 `cannot affect row a second
   time`. `DO NOTHING`은 통과하되 어느 행이 남는지 통제 불가(§5).
5. **arbiter가 필수이고, 그 밖의 유니크 충돌은 못 잡는다** — 유니크/제외 제약이
   없으면 42P10, arbiter가 아닌 제약에서 충돌하면 그냥 23505. 부분 유니크
   인덱스는 술어까지 적는다(§1-2).
6. **결과 카운트의 의미** — 걸러진 행·`DO NOTHING` 행은 세지 않는다. INSERT/UPDATE
   구분은 카운트로 못 하고 `RETURNING (xmax = 0)`이나 문장 분리로 한다(§1-4).
7. **JPA를 우회한다** — 네이티브 문장이라 1차 캐시·Auditing·`@Version`·리스너가
   동작하지 않고, `saveAll()`은 UPSERT가 아니다(§7-4).
8. **벤더 종속** — MySQL `ON DUPLICATE KEY UPDATE`, PG `ON CONFLICT`, 표준 `MERGE`가
   문법도 **동시성 보장도** 다르다(§9).

**안전한 대량 UPSERT 체크리스트 10항**

1. 이 배치는 **신규 위주인가 갱신 위주인가** — 갱신 위주면 UPDATE-먼저 분기로
   시퀀스 소모를 신규 행 수로 낮춘다.
2. 대리 키가 **정말 필요한가** — 매핑 테이블이면 자연 키 PK로 시퀀스를 없앤다.
3. 시퀀스가 **`int4`인가 `int8`인가** — `serial`은 int4다. `pg_sequences`
   사용률 알람이 걸려 있는가(§8-3).
4. 입력에서 **같은 키를 최신 1건으로 접었는가** — PG는 선택이 아니라 필수(§5).
5. **`DO UPDATE ... WHERE ... IS DISTINCT FROM` 가드**가 있는가 — 그리고 컬럼을
   추가할 때 조건절도 같이 고치는가(§8-4의 테스트).
6. **유니크 인덱스 컬럼 순서로 정렬**했는가 — 자바 `Comparator`면 타입으로 강제하고,
   가능하면 `ORDER BY`/`DISTINCT ON`으로 SQL에 넘긴다(§8-1).
7. **청크 = 짧은 트랜잭션**인가 — 500~1,000, 바인드 파라미터 65,535 한도 안에서.
   데드락이 트랜잭션째 abort시키므로 이 경계가 곧 손실 단위다.
8. **재시도는 트랜잭션 밖**에 상한·지터와 함께 있는가 — 40P01/40001/55P03을 한
   예외로 잡되, 재시도도 시퀀스를 태운다는 것을 아는가.
9. 병렬이면 **키 파티셔닝으로 워커 간 키가 서로소**인가 — PG는 커넥션이 프로세스라
   워커 수 자체도 비용이다.
10. **데드락 재현 테스트 + 지표**가 있는가 — `pg_stat_database.deadlocks` 추세,
    `pg_stat_user_tables`의 `n_tup_upd`/`n_tup_hot_upd`/`n_dead_tup`,
    `pg_sequences` 사용률.

---

## 11. 꼬리질문 대비 포인트

### "UPDATE로 처리된 행인데 왜 시퀀스가 늘어나죠? 안 썼으면 안 쓴 것 아닌가요?"

"안 썼다"와 "반납했다"는 다르다. `nextval()`은 튜플을 **조립하는 시점**에
평가되고, 충돌 여부는 그 뒤 arbiter 인덱스를 확인해야 안다(§1-3). 그리고 시퀀스는
**트랜잭션의 지배를 받지 않는다** — 롤백해도 되돌아오지 않는데, 되돌린다면 동시
세션들이 같은 값을 받게 되기 때문이다. 즉 "빈 번호가 생겨도 중복은 없게"를
의도적으로 택한 설계이고, `DO NOTHING`이어도 마찬가지다. **PG에만 있는 완화책**을
덧붙이면 좋다 — MySQL의 AUTO_INCREMENT와 달리 시퀀스는 독립 객체라 `setval()`로
되돌릴 수 있다(동시 INSERT가 없고 그 id를 외부가 안 들고 있을 때만 안전한 응급
처치다, §2-4). 이어서 "그럼 몇 건이 신규였는지는?"이 오면
`RETURNING id, (xmax = 0) AS inserted` 트릭(구현 세부에 기대므로 통계용)과 정직한
방법인 §6-2의 문장 분리를 같이 말한다.

### "값이 똑같은데도 UPDATE가 비싼가요?" (시니어 변별 포인트)

**PostgreSQL에서는 비싸다 — 이게 MySQL에서 온 사람이 가장 자주 놓치는 지점이다.**
PG의 UPDATE는 제자리 수정이 아니라 "새 튜플 삽입 + 옛 튜플 헤더의 `xmax` 표시"라서,
같은 값을 써도 ⑴ 죽은 튜플이 하나 생기고 ⑵ 그만큼 WAL이 쓰이며(체크포인트 직후면
8KB 전체 페이지 이미지까지) ⑶ 페이지에 여유가 없어 HOT이 깨지면 **그 테이블의 모든
인덱스**에 엔트리가 꽂히고 ⑷ VACUUM이 못 따라오면 bloat로 굳으며 ⑸ 트리거와 논리
복제 이벤트가 발화해 다운스트림(검색 색인, 캐시 무효화)까지 때린다. 처방은
`DO UPDATE ... WHERE (p.a, p.b) IS DISTINCT FROM (EXCLUDED.a, EXCLUDED.b)`이고,
`<>`가 아닌 이유는 NULL 비교가 NULL이 되어 "NULL → 값" 갱신을 조용히 건너뛰기
때문이다. 대가도 같이 말한다 — 걸러진 행도 **락은 잡히므로** 데드락 위험은 안 줄고,
결과 카운트의 의미가 바뀌며, 컬럼을 추가할 때 조건절을 빠뜨리면 조용한 미갱신
버그가 된다. 효과는 `EXPLAIN (ANALYZE, WAL)`의 `WAL: bytes=`와
`pg_stat_user_tables.n_tup_upd`로 숫자로 보여줄 수 있다.

### "키를 정렬하면 데드락이 완전히 사라지나요?" (시니어 변별 포인트)

순서 교차형은 사라지고, 나머지는 줄어들 뿐이다. 정렬이 없애는 것은 "두 세션이
겹치는 키를 다른 순서로 잠그는" §4-2의 구조다 — 모든 세션이 같은 전순서로 락을
잡으면 순환이 생기지 않는다는 자원 순서화 원리다. 남는 것은 ⑴ 정렬 규약을 안
지키는 **다른 쓰기 경로**(운영 API, 다른 배치) ⑵ **유니크 키 삽입 대기** — 같은
신규 키를 동시에 넣는 두 세션은 한쪽이 다른 쪽의 XID를 기다리므로 이 대기도 순환의
한 변이 될 수 있다 ⑶ **세트 기반 문장의 순서 미보장** — `UPDATE ... FROM`에는
`ORDER BY`가 없어 행 처리 순서를 플래너가 정한다. 그래서 정렬 위에 **트랜잭션
밖의 상한·지터 있는 재시도**를 반드시 얹고(§8-2), 병렬이면 **키 파티셔닝으로 겹침
자체를 없애며**(§6-2), `pg_stat_database.deadlocks` 추세를 본다. "격리 수준을
바꾸면요?"가 이어지면 §4-3 — 행 락은 어느 수준에서든 잡히고 순서 교차는 격리
수준과 무관하며, RR 이상으로 올리면 오히려 40001 재시도가 하나 더 생긴다.
**PG에서 좋아지는 점도 한 줄 덧붙인다**: MySQL이라면 여기에 넥스트 키 락이 얹혀
무관한 신규 INSERT까지 갭에 걸려 세워졌겠지만, PG에는 갭 락이 없어 그 유형은
아예 없다.

### "`ON CONFLICT` 말고 `MERGE`를 쓰면 안 되나요?" (시니어 변별 포인트)

용도가 다르다. `MERGE`(PG 15+)는 표준 SQL이고 조건별 분기와 `DELETE`까지 한 문장에
담을 수 있지만, **동시성 보호가 `ON CONFLICT`와 다르다.** `ON CONFLICT`는 유니크
인덱스 수준에서 충돌을 잡아 주지만, `MERGE`는 문장 시작 시점의 스냅샷으로
MATCHED/NOT MATCHED를 판정하므로 그 사이에 커밋된 같은 키를 못 보고 INSERT로 가
`23505 unique_violation`으로 실패할 수 있다. 그래서 동시 쓰기가 있는 경로에서
`MERGE`를 쓰려면 **유니크 위반 재시도를 반드시 붙이거나** 격리 수준을 올려야 하고,
올리면 이번엔 40001 재시도가 필요해진다 — 재시도가 사라지지 않고 이름만 바뀐다.
정리하면 **"단순 UPSERT + 동시 쓰기 = `ON CONFLICT`, 배치 전용 + 삭제·조건 분기 =
`MERGE`"**. 참고로 한 문장이 같은 대상 행을 두 번 건드리면 에러가 나는 것은
양쪽 다 같아서, **입력 중복 제거는 어느 쪽을 골라도 필요하다.**

### "`serial`(int) PK인 운영 테이블이 이미 60%입니다. 어떻게 하시겠어요?" (시니어 변별 포인트)

순서가 답이다. **① 출혈부터 멈춘다** — 이 테이블에 UPSERT를 치는 배치를 찾아
(§8-3 쿼리 + 일간 증가량) 갱신 위주면 UPDATE-먼저 분기나 `COPY` + 스테이징으로
바꾸고, 입력 중복을 접는다. 이것만으로 소모 속도가 수백 분의 1이 되어 시간을 산다.
**② 남은 시간을 숫자로** — 바뀐 일간 증가량으로 `(max_value − last_value) / 일간
증가량`을 계산해 데드라인을 정한다. 급하면 `setval()`로 간격을 되감는 응급 카드가
있지만 동시 INSERT가 없고 그 id를 외부가 안 들고 있을 때만이다(§2-4). **③ bigint
전환은 무중단 절차로** — PG에서 `ALTER COLUMN TYPE`은 테이블 재작성 + ACCESS
EXCLUSIVE이고, **그 잠금 요청이 진행 중인 롱 쿼리 뒤에 줄 서면서 그 뒤의 모든
SELECT까지 세운다**는 것이 진짜 위험이다. 그래서 새 `bigint` 컬럼 추가 → 트리거 +
배치 백필 → `CREATE UNIQUE INDEX CONCURRENTLY` → `lock_timeout`을 건 짧은
트랜잭션에서 PK 교체(`ADD CONSTRAINT ... PRIMARY KEY USING INDEX`) 순으로 가고,
**시퀀스도 `ALTER SEQUENCE ... AS bigint`로 함께 넓힌다.** 자식 테이블 FK 컬럼과
앱의 `Integer → Long`도 같은 계획에 넣는다. **④ 이 테이블에 대리 키가 필요했는지
되묻는다** — 매핑 테이블이면 이 기회에 자연 키 PK로 가는 것이 전환 한 번으로
문제를 영구히 없애는 길일 수 있다. **⑤ 재발 방지** — 사용률 알람과 §8-4 테스트를
남긴다. "bigint로 바꾸겠습니다" 한 줄로 끝내면 ①②④가 빠진 것이고, 그 사이에
고갈이 먼저 올 수 있다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다.

| 축 | MySQL / InnoDB | PostgreSQL |
|---|---|---|
| 충돌 대상 | `ON DUPLICATE KEY UPDATE` — **아무** 유니크 키. 어느 키였는지 모른다 | `ON CONFLICT (컬럼)` — arbiter 명시가 **필수**. 대신 그 밖의 유니크 충돌은 23505로 그냥 터진다 |
| 문장 내 중복 키 | 두 번째를 순서대로 다시 갱신 | **에러** — `cannot affect row a second time`. dedupe가 필수 |
| 갱신 비용 | 제자리 수정 + 언두. 값이 같으면 거의 공짜 | **새 튜플 버전** — 죽은 튜플·WAL·HOT 탈락·트리거·CDC. `IS DISTINCT FROM` 가드가 필요 |
| 데드락 | 순서 교차 + **넥스트 키 락**(갭)이 무관한 신규 INSERT까지 세운다. RC로 내려도 중복 키 검사 갭 락은 남는다 | 갭 락 없음 → 순서 교차와 유니크 키 삽입 대기만. 감지에 `deadlock_timeout` 1초, 희생자는 **트랜잭션 전체** abort(이후 25P02) |
| 결과 판정 | 행당 1/2/0 + `useAffectedRows` 플래그 함정 | 카운트 하나뿐. 구분은 `RETURNING (xmax = 0)` 또는 문장 분리 |

여기에 세 개를 더 얹으면 좋다. ⑴ **`INSERT IGNORE`의 위험이 PG에는 없다** —
MySQL의 IGNORE는 중복뿐 아니라 문자열 잘림·타입 변환 실패까지 경고로 낮춰
"조용히 틀린 데이터"를 만들지만, PG의 `DO NOTHING`은 지정한 충돌만 건너뛴다.
⑵ **`REPLACE INTO`가 PG에는 없다** — 흉내 내면 DELETE+INSERT인데 죽은 튜플 두 개 +
모든 인덱스 재삽입 + 새 시퀀스 값이라 더 나쁘다. ⑶ **ID 고갈의 전환 비용 구조**도
다르다 — InnoDB는 PK가 모든 세컨더리 인덱스에 복제돼 4→8바이트가 인덱스 전체를
부풀리지만, PG는 리프가 TID라 그 곱셈이 없고 **테이블 재작성 잠금**이 장벽이다.

---

## 한 줄 요약

**`INSERT ... ON CONFLICT (키) DO UPDATE`는 왕복 한 번에 틈 없이 멱등하게 "없으면
넣고 있으면 고치는" 대신 PostgreSQL에서 세 가지 비용을 낸다 — ① 행을 조립할 때
`nextval()`이 먼저 평가되고 시퀀스는 트랜잭션 밖이라, 갱신 위주 배치가 돌 때마다
시퀀스가 행 수만큼 점프해 `serial`(int4) PK를 행 증가 속도가 아니라 처리량의
속도로 고갈시키고 ② UPDATE가 제자리 수정이 아니라 새 튜플 버전이라 값이 같아도
죽은 튜플·WAL·HOT 탈락·트리거·CDC 이벤트가 실제로 발생하며 ③ 충돌 행마다 행 락을
커밋까지 쥔 채 VALUES 순서로 처리해, 겹치는 키를 다른 순서로 치는 두 배치를
순환 대기에 빠뜨려 `40P01`로 **트랜잭션째** 잃게 만든다. 그래서 대량 UPSERT는
입력 중복을 접고(PG는 한 문장 안 중복이 에러다) 유니크 키 순으로 정렬한 청크를
짧은 트랜잭션으로 보내며, `WHERE ... IS DISTINCT FROM` 가드로 무의미한 갱신을
잘라 내고, 트랜잭션 밖에서 상한·지터 있는 재시도를 걸고, 갱신 위주면 UPDATE-먼저
분기나 `COPY` + 스테이징 + `DISTINCT ON`으로 시퀀스 소모 자체를 없애며,
`pg_sequences` 사용률 알람과 데드락·낭비 UPDATE 재현 테스트로 그 결정을 코드에
고정하는 것이지, `DO NOTHING`이나 `MERGE`로 갈아타면 해결되는 문제가 아니다.**
