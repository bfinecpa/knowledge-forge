# 대량 UPSERT의 부작용 — 갱신에도 id를 태우고, 순서 없는 배치는 서로를 잠근다

> 핵심 관전 포인트: **`INSERT ... ON DUPLICATE KEY UPDATE`는 "없으면 넣고
> 있으면 고친다"를 한 문장으로 끝내 왕복 한 번·check-then-act 틈 없음·멱등이라는
> 세 가지 편의를 준다. 그 편의는 두 가지 숨은 비용 위에 서 있다. ① AUTO_INCREMENT
> 소모 — 행은 저장 엔진에 넘어가기 전에 id를 먼저 받고, 그 뒤 중복 키를 만나
> UPDATE 경로로 빠져도 받은 id는 반납되지 않으며, 카운터는 되돌아가지 않는다
> (8.0부터 redo 로그로 영속화돼 재시작에도 유지). 그래서 갱신 위주 동기화 배치가
> 돌 때마다 카운터가 배치 행 수만큼 점프하고, INT PK는 테이블이 크지 않아도
> "배치 처리량"의 속도로 고갈된다 — 10분마다 20만 건이면 signed INT 21억은 약
> 두 달 반 만에 `Duplicate entry '2147483647' for key 'PRIMARY'`로 모든 INSERT가
> 멈춘다. ② 데드락 — 중복 키를 만난 행마다 유니크 인덱스 레코드에 배타(X) 락
> (세컨더리 유니크 키면 넥스트 키 락)을 잡고 커밋까지 쥐는데, 다건 UPSERT는 VALUES
> 순서대로 행을 처리하므로 두 세션이 겹치는 키를 서로 다른 순서로 처리하면 락
> 획득 순서가 교차해 순환 대기가 된다 — 격리 수준을 낮춰도 순서 교차는 사라지지
> 않는다. 처방은 "UPSERT를 쓰지 말자"가 아니라 대가를 알고 쓰는 것이다 — 유니크
> 키 순 정렬을 타입으로 강제하고, 청크 단위 짧은 트랜잭션에 트랜잭션 밖의
> 상한·지터 있는 재시도(UPSERT는 멱등이라 안전)를 얹고, 갱신 위주 배치라면
> UPDATE-먼저 분기나 자연 키 PK로 id 소모 자체를 없애며,
> `information_schema.TABLES.AUTO_INCREMENT`를 타입 최대치 대비 사용률로 알람에
> 건다. `INSERT IGNORE`(오류 은폐)와 `REPLACE INTO`(DELETE+INSERT라 FK 연쇄·새
> id·인덱스 이중 작업)는 대안이 아니라 다른 함정이다.**

---

## 0. 질문 + 의도

**질문**: "대량 UPSERT(`INSERT ... ON DUPLICATE KEY UPDATE`)의 동작과 주의점은?
(AUTO_INCREMENT 소모, 데드락)"

**출제 의도**: rationale은 이렇게 적는다 — "**편리한 한 방 쿼리가 AUTO_INCREMENT를
갱신에도 소모해 ID 고갈을 앞당기고, 갭 락과 얽혀 데드락을 만드는 것을 아는지 —
동기화·적재 배치의 단골 도구가 갖는 숨은 비용까지 확인하고 쓰는 습관을 본다.**"
채점 지점은 셋이다. ① 두 부작용을 "낭비한다", "데드락 난다"는 이름이 아니라
**메커니즘 사슬**로 끝까지 말하는가 ② 대안(`INSERT IGNORE`, `REPLACE`, SELECT 후
분기, 정렬, BIGINT, RC)마다 **대가를 같은 호흡에** 붙이는가 ③ 배치를 "짜는" 것이
아니라 "운영되게" 만드는 **안전망**(정렬 규약, 재시도, 사용률 알람, 재현 테스트)을
코드로 말하는가. +α 문항이므로 ①만 정확해도 통과지만, ②③이 있어야 "확인하고
쓰는 습관"이 있는 사람으로 읽힌다.

> 이 문서는 사전 학습용이다(면접 전). 4장 진행 기록에서 반복된 네 가지 약점을
> 이 문항의 지점에 직접 대응시킨다.
>
> - **인과를 사슬로 서술하지 못함** — §2-1(AUTO_INCREMENT 다섯 고리)과 §3-2(데드락
>   타임라인)를 한 스텝씩 그리고, §2-4에서 뭉뚱그린 표현을 사슬로 교체하는 훈련
>   표를 둔다.
> - **트레이드오프 한쪽 면만** — §4에서 대안 아홉 가지 각각의 "얻는 것 / 내주는
>   것"을 표로 고정한다.
> - **안전망을 코드로 고정하지 않음** — §6에서 정렬 규약을 타입으로, 재시도를
>   빈으로, 사용률을 알람으로, 데드락을 재현 테스트로 박는다.
> - **목록 인출 실패** — §7에 "주의점 8가지"와 "체크리스트 10항"을 명시적 목록으로
>   둔다.
>
> 락의 일반 원리(락 4종·호환 규칙·RR/RC별 락 범위·로그 읽기)는
> [`gap-lock-next-key-lock-deadlock.md`](gap-lock-next-key-lock-deadlock.md)에
> 있고, 이 문서는 **UPSERT 고유의 부작용**에 집중한다. JPA 쪽 관점(영속성 컨텍스트
> 우회, rollback-only)은
> [`unique-constraint-concurrent-insert.md` §5](../03-jpa-orm/unique-constraint-concurrent-insert.md),
> JDBC 배치 자체의 원리는
> [`bulk-insert-jdbc-batch.md`](../03-jpa-orm/bulk-insert-jdbc-batch.md)를 전제한다.

---

## 1. 동작 — 한 문장 안에서 실제로 무슨 일이 일어나는가

### 1-1. 문장과 의미

이 문서의 예제는 **상품 가격 동기화 배치**다. 외부 가격 시스템이 10분마다 약
20만 건의 `(sku, region, price, updated_at)`을 보내고, 그중 99% 이상은 이미 있는
행의 가격 갱신이다.

```sql
CREATE TABLE product_price (
    id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,   -- ← 이 INT 가 §2 의 주인공
    sku        VARCHAR(32)  NOT NULL,
    region     CHAR(2)      NOT NULL,
    price      DECIMAL(12,2) NOT NULL,
    updated_at DATETIME(6)  NOT NULL,
    UNIQUE KEY uk_sku_region (sku, region)                          -- ← 중복 판정 기준
);

-- UPSERT 한 문장. "중복"의 기준은 PRIMARY KEY 또는 아무 UNIQUE 인덱스다.
INSERT INTO product_price (sku, region, price, updated_at)
VALUES ('A-100', 'KR', 12900, '2026-08-31 09:00:00')
ON DUPLICATE KEY UPDATE
    price      = VALUES(price),          -- "삽입하려던 값"을 참조하는 함수 (8.0.20부터 deprecated)
    updated_at = VALUES(updated_at);

-- 8.0.20+ 권장 구문: 삽입하려던 행에 별칭을 붙여 참조한다
INSERT INTO product_price (sku, region, price, updated_at)
VALUES ('A-100', 'KR', 12900, '2026-08-31 09:00:00') AS new
ON DUPLICATE KEY UPDATE
    price      = new.price,
    updated_at = new.updated_at;
```

의미는 정확히 이렇다 — **"이 행을 INSERT하되, PRIMARY KEY나 UNIQUE 인덱스 중 어느
하나라도 충돌하면 그 기존 행을 `UPDATE` 절대로 고쳐라."** 갱신되는 컬럼은 `UPDATE`
절에 적은 것뿐이다. 적지 않은 컬럼은 그대로 남는다(`REPLACE INTO`와의 결정적
차이, §4-2).

### 1-2. 행 하나가 지나가는 순서 — id 할당이 중복 판정보다 앞이다

다건 UPSERT는 VALUES에 적힌 순서대로 **행 하나씩** 다음 단계를 밟는다. 이 순서가
§2와 §3의 뿌리라서 외워 둘 가치가 있다.

```text
행 하나가 처리되는 순서 (InnoDB, 다건 INSERT ... ON DUPLICATE KEY UPDATE)

  ① AUTO_INCREMENT 값 할당      ← 저장 엔진에 행을 넘기기 "전" MySQL 서버 층에서 채운다
        ↓
  ② 클러스터드/유니크 인덱스에 삽입 시도 → 중복 판정
        ↓                                   ↓
   중복 없음                              중복 있음 (PK 또는 어느 UNIQUE 든)
        ↓                                   ↓
  ③-a 삽입 완료                          ③-b 기존 행에 X 락 → UPDATE 절 적용
      (새 행에 X 레코드 락)                   PK 중복: X 레코드 락
      affected rows += 1                     UNIQUE 중복: X 넥스트 키 락 (갭 포함)
                                             ①에서 받은 id 는 쓰이지 않고 사라진다
                                             affected rows += 2 (실제 변경) 또는 0 (값 동일)
        ↓
  ④ 다음 행으로 — 지금까지 잡은 락은 문장이 아니라 "트랜잭션" 끝까지 유지
```

두 가지가 여기서 이미 보인다. ①이 ②보다 앞이라서 **중복 행도 id를 소모하고**
(§2), ③-b에서 잡은 X 락이 ④에서 풀리지 않고 쌓이므로 **행을 처리하는 순서가 곧 락
획득 순서**가 된다(§3).

### 1-3. affected rows의 의미 — 1 / 2 / 0, 그리고 드라이버의 함정 (가산점 포인트)

MySQL은 UPSERT의 결과를 **행당 영향 수**로 알려준다.

- **1** — 새 행이 INSERT됨
- **2** — 기존 행이 실제로 UPDATE됨 (값이 바뀜)
- **0** — 기존 행을 찾았지만 UPDATE 절을 적용해도 값이 그대로라 변경 없음

그래서 `ON DUPLICATE KEY UPDATE user_id = user_id` 같은 no-op 관용구로 "있으면
무시"를 구현하면 중복일 때 0이 돌아오고, `affected == 1`로 "새로 만들어졌다"를
판정할 수 있다([유니크 제약 문서 §5-2](../03-jpa-orm/unique-constraint-concurrent-insert.md)).

**그런데 JDBC에서는 이 숫자가 다르게 올 수 있다.** MySQL 프로토콜에는
`CLIENT_FOUND_ROWS` 플래그가 있어, 켜져 있으면 UPDATE 계열의 결과를 "바뀐 행
수"가 아니라 "조건에 걸린 행 수"로 돌려준다. **MySQL Connector/J는 기본값
`useAffectedRows=false`, 즉 이 플래그를 켠 채 접속한다.** 그러면 위의 0이 **1**로
바뀐다 — "값이 그대로인 UPDATE"와 "새로 INSERT"가 둘 다 1이 되어 구분이 불가능해진다.

```text
# Before — Connector/J 기본값: 0 이 1 로 올라와 INSERT 와 구분 불가
jdbc:mysql://host:3306/shop

# After — 서버가 주는 0 / 1 / 2 를 그대로 받는다
jdbc:mysql://host:3306/shop?useAffectedRows=true
```

이 옵션은 UPSERT뿐 아니라 **모든 UPDATE의 반환 값 의미를 바꾼다**(같은 값으로
UPDATE하면 0). 낙관적 락처럼 "`WHERE version = ?`로 1건이 맞았는가"를 보는 코드는
영향이 없지만(값이 반드시 바뀌므로), "몇 건이 매치됐는가"를 세던 코드가 있다면 함께
검토한다. 다건 배치가 `rewriteBatchedStatements`로 한 문장으로 재작성되면 행별
구분은 어차피 문장 합계로만 온다(§5-3).

### 1-4. 유니크 인덱스가 여럿이면 어느 키로 충돌했는지 모른다

`ON DUPLICATE KEY UPDATE`의 "KEY"는 **아무 유니크 키**다. 테이블에 유니크 인덱스가
둘 이상이면 의도한 키가 아닌 다른 키에서 충돌한 행을 갱신할 수 있고, MySQL은 어느
키였는지 알려주지 않는다. 또 이런 문장은 문장 기반 복제에서 unsafe로 표시된다.
PostgreSQL은 `ON CONFLICT (sku, region)`으로 충돌 대상을 명시할 수 있어 이 문제가
없다(§8). 상세는 [유니크 제약 문서 §5-4](../03-jpa-orm/unique-constraint-concurrent-insert.md).

---

## 2. 주의점 ① — AUTO_INCREMENT 소모, 사슬로 말하기

### 2-1. 다섯 고리

"UPSERT는 AUTO_INCREMENT를 낭비한다"에서 멈추지 않는다. 고리 다섯 개를 순서대로
잇는다.

```text
① 행이 처리될 때 id 를 먼저 받는다
   — AUTO_INCREMENT 값은 저장 엔진이 행을 받기 전에 채워진다(§1-2 ①). 중복인지는 그 다음에 안다.
   — MySQL 문서도 INSERT ... ON DUPLICATE KEY UPDATE 를 "mixed-mode insert" 로 분류하며
     "할당된 AUTO_INCREMENT 값이 UPDATE 단계에서 쓰일 수도, 안 쓰일 수도 있다" 고 명시한다.
        ↓
② 중복이면 UPDATE 경로로 빠지고, 받은 id 는 반납되지 않는다
   — 카운터에는 "돌려주기" 연산이 없다. 기본 락 모드(8.0 기본 innodb_autoinc_lock_mode=2,
     5.7 기본 1)에서는 문장 단위로 값을 묶어 할당하므로 다건 문장 하나가 행 수만큼 카운터를 올린다.
        ↓
③ 카운터는 단조 증가만 하고, 되돌아오지 않는다
   — 8.0 부터는 카운터가 바뀔 때마다 redo 로그에 기록되고 체크포인트마다 저장된다.
     5.7 까지는 재시작 시 MAX(id)+1 로 다시 계산했지만(끝쪽 구멍이 우연히 메워짐), 8.0 은 유지된다.
   — ALTER TABLE ... AUTO_INCREMENT = n 으로도 현재 최댓값 아래로는 못 내린다.
        ↓
④ 갱신 위주 배치가 돌 때마다 카운터가 "배치 행 수" 만큼 점프한다
   — 20 만 건 UPSERT 에서 199,800 건이 갱신이어도 카운터는 200,000 오른다. 테이블 행 수는 200 개 늘 뿐.
        ↓
⑤ id 소모 속도 = 행 증가 속도가 아니라 "배치 처리량" → INT 고갈이 예측보다 수십 배 빠르다
   — 고갈 시 증상: 카운터가 타입 최댓값에 멈추고 다음 INSERT 부터 전부
     ERROR 1062 Duplicate entry '2147483647' for key 'PRIMARY' — 갱신 배치는 계속 돌지만 신규 상품 등록만 죽는다.
```

⑤의 증상이 악질인 이유는 **에러 메시지가 원인을 가리키지 않는다**는 것이다.
"PRIMARY 중복"이라고 하니 애플리케이션 버그를 먼저 의심하게 되고, 그 사이 신규
INSERT가 전부 실패한다.

### 2-2. 숫자로 — 두 달 반

사슬을 숫자로 닫아야 설득력이 생긴다.

```text
배치: 10 분 주기 × 20 만 건  →  하루 144 회 × 200,000 = 28,800,000 id / 일
signed INT 상한 2,147,483,647 ÷ 28,800,000 ≈ 74.6 일
unsigned INT 상한 4,294,967,295 ÷ 28,800,000 ≈ 149 일

테이블 실제 행 수: 20 만 → 30 만 (신규 sku 하루 200 개 기준 1 년 뒤)
행 수 기준 예측이라면 INT 고갈까지 수천 년. 실제로는 두 달 반.
```

"수십 배 빠르다"는 말은 여기서 나온다 — 소모 속도의 분모가 "새 행"이 아니라 "배치가
훑은 행"이기 때문이다. 같은 논리로 **재시도도 id를 태운다**: 데드락으로 롤백된
청크를 다시 돌리면 그 청크 행 수만큼 카운터가 또 오른다(§6-2에서 상한을 두는 이유
중 하나).

### 2-3. 왜 "그냥 BIGINT로 만들면 끝" 이 아닌가

새 테이블이면 BIGINT가 맞다. 문제는 **이미 INT로 만들어 수억 건이 쌓인 운영
테이블**이다. 컬럼 타입 변경은 InnoDB online DDL에서 **INSTANT도 INPLACE도 아닌
COPY**(테이블 재작성, DML 차단)라서 gh-ost/pt-online-schema-change 절차가 필요하고,
그 PK를 참조하는 **모든 자식 테이블의 FK 컬럼**과 **모든 세컨더리 인덱스**(PK를
품는다)가 4→8바이트로 함께 커지며, 애플리케이션의 `int`/`Integer`도 `long`으로
바뀌어야 한다. 절차는
[`online-ddl-zero-downtime-schema-change.md`](online-ddl-zero-downtime-schema-change.md),
PK 폭이 세컨더리 인덱스에 전파되는 이유는
[`clustered-vs-secondary-index.md`](clustered-vs-secondary-index.md). 그래서 순서는
"BIGINT 전환"이 아니라 **① 출혈부터 멈추고(§4-2의 UPDATE-먼저·중복 제거) ② 남은
시간을 §2-2처럼 계산한 뒤 ③ 무중단 절차로 전환**이다(§9 꼬리질문).

### 2-4. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 사슬로 바꾼 표현 |
|---|---|
| "UPSERT는 AUTO_INCREMENT를 낭비해요" | "행마다 id를 먼저 받고 → 중복이면 UPDATE로 가지만 id는 반납이 없고 → 카운터는 단조 증가에 8.0부턴 영속이라 → 갱신 위주 배치가 돌 때마다 행 수만큼 점프하고 → 소모 속도가 배치 처리량에 비례해 INT 고갈이 행 증가 기준 예측보다 수십 배 빠릅니다" |
| "대량 UPSERT는 데드락이 나요" | "중복 행마다 X(세컨더리 유니크면 넥스트 키) 락을 잡고 커밋까지 쥐고 → 다건 문장은 VALUES 순서로 처리하니 → 두 세션이 겹치는 키를 다른 순서로 처리하면 획득 순서가 교차해 → 순환 대기가 되고 → InnoDB가 한쪽 문장을 통째로 롤백(1213)합니다" |
| "정렬하면 돼요" | "정렬은 순서 교차형을 없애고 → 남는 갭 락형은 재시도로 받치고 → 재시도는 UPSERT가 멱등이라 안전하며 → 단 재시도도 id를 태우니 상한과 지터를 둡니다" |

---

## 3. 주의점 ② — 데드락, 락 획득 순서의 교차

### 3-1. UPSERT가 잡는 락 — 갭 락 문서의 패턴 B와 무엇이 다른가

MySQL 문서의 정의 그대로다. **UPSERT가 중복 키를 만나면 단순 INSERT처럼 공유(S)
락이 아니라 배타(X) 락을 잡는다.** PK 중복이면 X 레코드 락, 유니크 인덱스
중복이면 X 넥스트 키 락(앞 갭 포함).

이 한 줄이 [갭 락 문서 §3-2 패턴 B](gap-lock-next-key-lock-deadlock.md)와의 차이를
만든다. 패턴 B는 "여러 세션이 같은 키에 S 락을 나란히 얻은 뒤 서로 X로 못 올라가는"
승격 경쟁이었고, UPSERT는 처음부터 X를 잡으므로 **그 구조가 생기지 않는다**(갭 락
문서가 UPSERT를 처방 ③으로 꼽은 이유). 대신 UPSERT는 **다른 종류**의 데드락을
만든다 — 3장에서 본 **락 순서 역전**([갭 락 문서 §3-3](gap-lock-next-key-lock-deadlock.md))이
문장 하나 안의 행 처리 순서 수준에서 재현되는 것이다.

### 3-2. 타임라인 — 두 세션, 반대 순서

`product_price`에 sku `A-100`~`A-999`가 전부 존재한다(→ 모두 UPDATE 경로). 배치
인스턴스 두 대가 같은 20만 건을 각각 다른 순서로 UPSERT한다고 하자.

```text
세션 1: INSERT ... VALUES ('A-100',..), ('A-101',..), ..., ('A-999',..) ON DUPLICATE KEY UPDATE ...
세션 2: INSERT ... VALUES ('A-999',..), ('A-998',..), ..., ('A-100',..) ON DUPLICATE KEY UPDATE ...

시간 →  세션 1                            세션 2                            보유 락
t1      'A-100' 중복 → X 락 → UPDATE                                          S1: A-100
t2                                        'A-999' 중복 → X 락 → UPDATE        S1: A-100 / S2: A-999
t3      'A-101' … 'A-549' 차례로 X 락     'A-998' … 'A-551' 차례로 X 락       S1: A-100~549 / S2: A-551~999
t4      'A-550' X 락 획득                                                     S1: A-100~550
t5                                        'A-550' X 요청 → S1 보유 → 대기     S2 → S1
t6      'A-551' X 요청 → S2 보유 → 대기                                       S1 → S2  = 순환
t7      InnoDB 데드락 감지 → 되돌릴 양이 적은 쪽을 희생자로 골라 롤백 (ERROR 1213)
        희생자 세션의 "문장 전체" 가 취소된다 — 지금까지 갱신한 450 건도 함께
```

읽어야 할 포인트 셋. ⑴ 각 행에서 잡은 X 락은 다음 행으로 넘어가도 **풀리지 않고
쌓인다**(§1-2 ④). ⑵ 그래서 VALUES의 순서가 곧 락 획득 순서이고, **두 세션의 순서가
다르면 언젠가 중간에서 만난다**. ⑶ 희생자는 문장 단위로 롤백되므로, 자동 커밋 한
문장이었다면 그 청크가 통째로 사라지고 트랜잭션 하나에 여러 청크를 묶었다면
트랜잭션 전체가 사라진다.

이 데드락은 "같은 자원을 같은 순서로 잠갔는데도 나는" 갭 락 데드락(패턴 A)과
달리 **순서를 통일하면 사라지는 종류**다. 그래서 1순위 처방이 **유니크 키 순
정렬**이다(§5). 다만 정렬로 다 끝나지 않는 이유가 다음 절에 있다.

### 3-3. REPEATABLE READ의 넥스트 키 락이 얹는 것 — 그리고 RC가 못 끄는 것

유니크 인덱스 중복은 X **넥스트 키** 락이다. 즉 `A-550` 레코드만이 아니라 **그 앞
갭 `(A-549, A-550)`도 잠긴다.** 이 갭에 들어갈 **새 키**를 INSERT하려는 제3의
세션(예: 신규 상품 등록 API가 `A-5495`를 넣는다)은 인서트 인텐션 락이 갭 락에 막혀
대기한다. 순서를 정렬한 배치끼리는 안전해도, **배치가 쥔 갭이 무관한 신규 INSERT를
세우거나** 그 신규 INSERT가 다른 락을 쥔 채 기다리면 순환의 한 변이 될 수 있다.

"그럼 READ COMMITTED로 내리면?" — RC는 검색·스캔의 갭 락을 끄지만, **문서가 명시한
예외 두 가지가 외래 키 검사와 중복 키 검사**다. UPSERT의 중복 판정은 바로 그 중복
키 검사라서 넥스트 키 락이 남는다. 그리고 §3-2의 순서 교차는 격리 수준과 아무
관계가 없다 — X 레코드 락은 어느 격리 수준에서든 잡힌다. RC는 팬텀을 허용하는
대가만 내고 UPSERT 데드락은 거의 못 줄이므로 이 문항의 처방이 아니다
([격리 수준 문서 §5](transaction-isolation-levels.md) — 격리 수준 지정은 트랜잭션을
새로 여는 쪽에서만 유효하다는 점도 같이).

### 3-4. 운영에서 겹치는 키가 생기는 얼굴 — 목록

"한 번에 한 배치만 도는데 왜 겹치죠?"에 답할 목록이다. 겹치는 키가 생기는 경로가
있는 한 순서 교차는 시간 문제다.

1. **변경 이력형 피드** — 외부 시스템이 "수정된 순서"로 보내므로 같은 sku가 한
   배치 안에 여러 번 등장한다. 청크 A와 청크 B가 같은 sku를 다른 위치에서 만난다.
2. **실행 겹침** — 이전 배치가 끝나기 전에 다음 스케줄이 시작된다(처리 시간이
   주기를 넘는 날). 두 인스턴스가 대부분 같은 키 집합을 다른 순서로 처리한다.
3. **다중 인스턴스** — 배치를 파드 2개로 스케일 아웃했는데 파티션 없이 같은 입력을
   나눠 가진 경우.
4. **다른 쓰기 경로** — 운영자 가격 수정 API, 프로모션 배치, 재고 연동 배치가 같은
   행을 UPDATE한다. 이쪽은 UPSERT가 아니어도 X 락을 잡는다.
5. **재시도 폭풍** — 데드락 희생자가 지터 없이 곧바로 재시도해 같은 박자로 다시
   충돌한다([갭 락 문서 §5-4](gap-lock-next-key-lock-deadlock.md)).

---

## 4. 대안과 대가 — 얻는 것 / 내주는 것

한쪽 면만 말하는 습관을 깨기 위해 대안 아홉 가지를 두 열로 고정한다. 면접에서
어느 하나를 고르면 반드시 **오른쪽 열까지 한 호흡에** 말한다.

### 4-1. 표

| 대안 | 얻는 것 | 내주는 것 |
|---|---|---|
| `ON DUPLICATE KEY UPDATE` (기준선) | 왕복 1회, check-then-act 틈 없음, 멱등 | 갱신 행도 id 소모, 락 순서는 스스로 해결 안 됨, 벤더 종속, 어느 유니크 키 충돌인지 모름 |
| `INSERT IGNORE` | 더 짧음, "있으면 무시"가 요구사항일 때 직관적 | 갱신 불가, **중복 외 오류(잘림·타입 변환 실패)까지 경고로 은폐**, id 소모는 동일 |
| `REPLACE INTO` | 구문 단순, "전 컬럼 교체" 의도가 명확 | **DELETE+INSERT**: 항상 새 id(PK가 바뀜), FK 자식 `ON DELETE CASCADE` 연쇄 삭제/`RESTRICT`면 실패, DELETE·INSERT 트리거 발화, 세컨더리 인덱스 전부 삭제·재삽입, 안 적은 컬럼은 기본값으로 초기화, binlog 2배 |
| SELECT 후 분기 (INSERT 묶음 / UPDATE 묶음) | 신규 행만 id 소모, 갱신은 순수 UPDATE, 문장별 카운트가 명확 | 왕복 +1, SELECT와 쓰기 사이 **레이스** → 유니크 제약 + 충돌 시 폴백 필수, 코드 양 |
| UPDATE 먼저 → affected 0만 INSERT | 갱신 위주 배치면 id 소모 ≈ 0 | 신규 위주면 왕복 2배, UPDATE와 INSERT 사이 레이스 동일, 다건 배치에선 결과 매핑이 번거로움 |
| 유니크 키 정렬 + 청크 | 순서 교차형 데드락 소멸, 락 보유 짧음, 실패 범위 작음 | 정렬 비용(메모리·CPU, 스트리밍 불가), 커밋 횟수 증가, 청크 간 원자성 없음 → 멱등 재실행 전제 |
| 키 범위/해시 파티셔닝 병렬 | 워커 간 겹치는 키 없음 → **구조적으로** 데드락 0, 처리량 | 파티션 경계 설계, 워커 수만큼 커넥션, 키 편중(스큐) 시 한 워커만 느림 |
| BIGINT 전환 | 고갈 문제 사실상 소멸 | PK 4→8B가 모든 세컨더리 인덱스·자식 FK 컬럼에 전파, 타입 변경은 COPY → 무중단 도구 필요, 앱 타입 `int→long` 전파 |
| RC 격리 | 스캔 갭 락 소멸, 쓰기 동시성 상승 | 팬텀 허용, **중복 검사 갭 락은 남음**, 순서 교차 데드락은 그대로, ROW 바이너리 로그 필요 |
| 자연 키 PK / 외부 채번 | id 소모 문제 원천 제거 | 넓은 복합 PK가 세컨더리 인덱스에 복제되거나, Snowflake 같은 채번 인프라 운영 |

### 4-2. 각 항목에서 놓치기 쉬운 지점

**`INSERT IGNORE`** — "IGNORE"가 무시하는 것은 중복 키만이 아니다. `VARCHAR(32)`에
40자를 넣어 잘리거나 숫자 컬럼에 문자열이 들어가 0이 되는 오류까지 경고로 낮춰
통과시킨다. 배치는 사람이 안 보는 시간에 돌므로 **조용히 틀린 데이터가 실패보다
나쁘다.** 의도가 "중복만 무시"면 no-op UPSERT를 쓴다.

**`REPLACE INTO`** — 이름 때문에 "UPDATE의 다른 이름"으로 오해되지만 **정확히 DELETE
후 INSERT**다. 사슬로 말하면: 기존 행 삭제 → 새 행 삽입 → (a) 새 AUTO_INCREMENT
발급, PK가 바뀌므로 그 id를 들고 있던 모든 곳(자식 테이블 FK, 캐시, 외부 시스템)이
고아가 된다 → (b) FK가 `CASCADE`면 자식 행이 **함께 지워지고**, `RESTRICT`면
REPLACE 자체가 실패한다 → (c) 세컨더리 인덱스마다 옛 엔트리 delete-mark + 새 엔트리
삽입, undo·redo·binlog 모두 두 배 → (d) 문장에 적지 않은 컬럼(`created_at`,
`memo`)은 **기본값으로 초기화**된다. UPSERT의 대안으로 꺼내는 순간 시니어 면접관은
(b)와 (d)를 묻는다.

**SELECT 후 분기 / UPDATE 먼저** — 갱신 위주 동기화 배치에서 **id 출혈을 멈추는
가장 현실적인 처방**이다. 배치 키 집합을 `SELECT sku, region FROM product_price
WHERE (sku, region) IN (...)`으로 조회해 "있는 것 / 없는 것"으로 가른 뒤, 있는
것은 `UPDATE ... WHERE sku = ? AND region = ?` 배치, 없는 것만 INSERT 배치로 보낸다.
대가는 check-then-act 레이스다 — 조회와 INSERT 사이에 다른 경로가 같은 키를 넣으면
INSERT가 유니크 위반으로 죽는다. 그래서 **유니크 제약은 그대로 두고, 위반 시 그
행만 UPDATE로 폴백**(또는 그 청크만 UPSERT로 재시도)하는 코드가 반드시 붙는다.
왕복이 하나 늘지만 20만 건에 왕복 1회는 무시할 수준이고, 그 대가로 id 소모가 신규
200건으로 내려간다.

**정렬 + 청크** — 정렬은 **유니크 인덱스의 컬럼 순서 그대로** 한다.
`uk_sku_region(sku, region)`이면 `sku` 오름차순, 같으면 `region` 오름차순. 인덱스
위 레코드 순서와 락 획득 순서를 일치시키는 것이 목적이므로, 다른 기준(`updated_at`
순, 해시 순)으로 정렬하면 의미가 없다. 청크 크기는 "락 보유 시간 × 재시도 시
버릴 양 × `max_allowed_packet`"의 균형이고 500~1,000이 흔한 출발점이다. 청크
크기는 id 소모 총량을 바꾸지 않는다(행당 1개는 그대로).

**파티셔닝 병렬** — 정렬이 "겹쳐도 같은 순서"라면 파티셔닝은 "아예 안 겹치게"다.
`hash(sku) % 워커 수`로 입력을 갈라 워커마다 서로소인 키 집합을 주면 워커 간
데드락은 **구조적으로** 없다. 각 워커 안에서는 여전히 정렬한다(다른 쓰기 경로와의
교차 대비). 대가는 스큐와 커넥션 수([커넥션 수 문서](connection-count-vs-throughput.md)).

**자연 키 PK** — `(sku, region)`이 행의 정체성이고 다른 테이블이 이 행을 FK로
참조하지 않는다면 대리 키 `id`가 애초에 필요 없다. 복합 PK로 만들면 AUTO_INCREMENT
자체가 없어 소모 문제가 사라진다. 대가는 PK 폭(`VARCHAR(32)+CHAR(2)`)이 모든
세컨더리 인덱스에 복제되는 것과, 나중에 이 행을 참조해야 할 때 FK 컬럼이 넓어지는
것이다. 대량 매핑 테이블(좋아요, 팔로우, 가격표)에선 자주 옳은 선택이다.
외부 채번(Snowflake)은 [`unique-id-generation-at-scale.md`](unique-id-generation-at-scale.md).

---

## 5. 안전한 대량 UPSERT — before / after

### 5-1. before — 외부 순서 그대로, 병렬 청크, 재시도 없음

```java
// ❌ BEFORE — 잘 돌다가 어느 날 새벽 "Deadlock found when trying to get lock" 과 함께 가격 5,000 건이 유실됐다
@Service
@RequiredArgsConstructor
public class PriceSyncService {

    private static final String UPSERT = """
            INSERT INTO product_price (sku, region, price, updated_at)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE price = VALUES(price), updated_at = VALUES(updated_at)
            """;

    private final JdbcTemplate jdbcTemplate;

    @Transactional
    public void sync(List<PriceRow> rows) {                    // rows: 외부 시스템이 보낸 순서 = 수정 시각 순 = 키 기준 무작위
        Lists.partition(rows, 5_000).parallelStream()          // ① 병렬 → 워커 스레드마다 다른 커넥션 = 세션 여러 개
            .forEach(chunk -> jdbcTemplate.batchUpdate(UPSERT, chunk, chunk.size(), (ps, r) -> {
                ps.setString(1, r.sku());
                ps.setString(2, r.region());
                ps.setBigDecimal(3, r.price());
                ps.setObject(4, r.updatedAt());
            }));
        // ② @Transactional 은 호출 스레드에만 바인딩된다 — 워커 스레드의 batchUpdate 는 각자 auto-commit
        // ③ 같은 sku 가 피드에 여러 번(변경 이력형) → 청크끼리 겹치는 키를 다른 순서로 → 데드락
        // ④ 희생자 청크는 예외로 끝나고 아무도 재시도하지 않는다 → 그 5,000 건은 다음 배치까지 옛 가격
        // ⑤ 20 만 건 중 199,800 건이 UPDATE 인데 id 는 200,000 개 소모 → INT PK 두 달 반
    }
}
```

문제 다섯 개가 한 메서드에 있다. ①②는 스프링 트랜잭션 경계의 오해(부수 버그지만
"세션 여러 개"를 만드는 원인), ③④가 이 문항의 데드락, ⑤가 AUTO_INCREMENT 소모다.

### 5-2. after — 중복 제거 → 유니크 키 정렬(타입 강제) → 청크 트랜잭션 → 트랜잭션 밖 재시도

```java
// ✅ AFTER
@Service
@RequiredArgsConstructor
public class PriceSyncService {

    private static final int CHUNK = 1_000;

    /** uk_sku_region(sku, region) 의 컬럼 순서와 동일해야 한다 — 인덱스 위 레코드 순서 = 락 획득 순서 */
    private static final Comparator<PriceRow> UNIQUE_KEY_ORDER =
            Comparator.comparing(PriceRow::sku).thenComparing(PriceRow::region);

    private static final String UPSERT = """
            INSERT INTO product_price (sku, region, price, updated_at)
            VALUES (?, ?, ?, ?) AS new
            ON DUPLICATE KEY UPDATE
                price      = IF(new.updated_at > product_price.updated_at, new.price,      product_price.price),
                updated_at = IF(new.updated_at > product_price.updated_at, new.updated_at, product_price.updated_at)
            """;   // 늦게 도착한 옛 데이터가 새 데이터를 덮지 않도록 조건부 갱신 — 덮을 게 없으면 affected 0

    private final JdbcTemplate jdbcTemplate;
    private final TransactionTemplate tx;            // 청크 = 트랜잭션 경계 (호출 스레드에서 명시적으로)
    private final RetryTemplate deadlockRetry;       // §6-2 — 상한 3회, 지수 백오프 + 지터

    public void sync(List<PriceRow> rows) {
        List<PriceRow> latestPerKey = dedupeKeepLatest(rows);                          // ① 같은 키는 최신 1건만 — 행 수 = id 소모량
        SortedBatch<PriceRow> sorted = SortedBatch.of(latestPerKey, UNIQUE_KEY_ORDER); // ② 정렬은 타입으로 강제 (§6-1)

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
            ps.setObject(4, r.updatedAt());
        });
    }

    private static List<PriceRow> dedupeKeepLatest(List<PriceRow> rows) {
        Map<PriceKey, PriceRow> latest = new HashMap<>();
        for (PriceRow r : rows) {
            latest.merge(r.key(), r, (a, b) -> a.updatedAt().isAfter(b.updatedAt()) ? a : b);
        }
        return List.copyOf(latest.values());
    }
}
```

바뀐 것을 사슬로 읽는다. ① 같은 키를 최신 1건으로 접어 **행 수 = id 소모량**을
줄이고(PostgreSQL이라면 필수, §8), ② 유니크 인덱스 순서로 정렬해 **모든 세션의 락
획득 순서를 통일**하며, ③ 청크마다 트랜잭션을 끊어 락 보유 시간과 실패 시 버릴
양을 줄이고, ④ 데드락 희생자는 트랜잭션이 이미 롤백됐으므로 **밖에서** 청크를 처음부터
다시 돌린다 — UPSERT는 같은 입력에 같은 결과라 재실행이 안전하다.

**갱신 위주 배치라면 여기서 한 단계 더 간다.** ⑤ 청크를 `SELECT ... WHERE (sku,
region) IN (...)`으로 갈라 있는 것은 `UPDATE` 배치, 없는 것만 `INSERT` 배치로
보내면(§4-2) id 소모가 신규 행 수로 떨어진다. 그때도 정렬·청크·재시도 골격은
그대로고, INSERT가 유니크 위반으로 죽는 레이스는 그 행만 UPSERT로 폴백한다.

병렬이 필요하면 ②의 정렬 위에 **`hash(sku) % N`으로 입력을 갈라 워커 N개에 서로소
키 집합**을 준다. 워커 간 데드락은 구조적으로 사라지고, 각 워커는 자기 파티션
안에서 위 코드를 그대로 돈다.

### 5-3. `rewriteBatchedStatements`와 UPSERT를 결합할 때 확인할 것

MySQL Connector/J는 기본 상태에서 `executeBatch()`를 받아도 문장을 하나씩 보낸다.
URL에 `rewriteBatchedStatements=true`가 있어야 `INSERT ... VALUES (...), (...), (...)
ON DUPLICATE KEY UPDATE ...`라는 **다중 행 한 문장**으로 재작성돼 왕복이 진짜로
줄어든다([대량 INSERT 문서 §5](../03-jpa-orm/bulk-insert-jdbc-batch.md) — 이 설정은
하이버네이트 로그로 절대 확인되지 않는다는 점까지 같다). UPSERT와 결합할 때 추가로
볼 것:

- **`ON DUPLICATE KEY UPDATE` 절은 `VALUES(col)` 또는 행 별칭(`new.col`)으로 삽입
  값을 참조하고, 절 안에 별도의 `?` 바인딩을 두지 않는다.** 재작성은 VALUES 목록을
  이어 붙이는 방식이라 절 뒤에 파라미터가 있으면 드라이버가 재작성을 포기하고
  한 건씩 보낼 수 있다. **재작성이 실제로 성립했는지는 서버 general log로 한 번은
  눈으로 확인한다** — 로그 모양은 어느 쪽이든 같다.
- **다중 행 한 문장 = 락 획득 순서가 VALUES 순서 그대로.** 정렬이 문장 안에서도
  유효한 이유이자, 정렬 안 된 배치가 문장 하나만으로도 데드락을 만드는 이유다.
- **한 문장 = 원자적.** 1,000행 중 한 행이 NOT NULL 위반이면 문장 전체가 실패한다.
  데드락 희생자도 문장 전체가 롤백된다. 청크 크기가 곧 "한 번에 버리는 양"이다.
- **`max_allowed_packet`.** 청크 1,000 × 행 크기가 서버 한도를 넘으면 실패한다.
  청크 크기와 함께 조정한다.
- **행별 affected rows(0/1/2)는 잃는다.** 다중 행 한 문장에는 합계 하나만 돌아온다.
  "이번 배치에서 몇 건이 신규였나"가 필요하면 §4-2의 분기 방식이 맞다.
- **생성 키 반환은 기대하지 말 것.** 재작성된 문장에서 `getGeneratedKeys()`는
  신뢰할 수 없다. UPSERT로 갱신된 행의 id가 필요하면 `ON DUPLICATE KEY UPDATE id =
  LAST_INSERT_ID(id)` 관용구를 단건에서 쓰거나 별도 조회한다(가산점 포인트).

---

## 6. 안전망을 코드로 고정한다

"배치 UPSERT 전엔 키를 정렬합시다"를 위키에 적어 두는 것과 코드가 그것을 강제하는
것은 다른 능력이다. 네 가지를 구조로 박는다.

### 6-1. 정렬 규약을 타입으로 — 정렬 안 된 배치는 컴파일이 안 되게

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
기억이 아니라 컴파일러가 막는다. 남는 구멍은 Comparator가 인덱스 순서와 다른
경우인데, 이것은 §6-4의 재현 테스트가 잡는다.

### 6-2. 재시도 정책 — 트랜잭션 밖, 상한, 지터, 그리고 "재시도도 id를 태운다"

```java
@Configuration
public class BatchRetryConfig {

    @Bean
    RetryTemplate deadlockRetry() {
        return RetryTemplate.builder()
                // 1213 데드락 → DeadlockLoserDataAccessException, 1205 락 대기 타임아웃 → CannotAcquireLockException
                // 둘 다 PessimisticLockingFailureException 의 하위 — 스프링이 벤더 코드를 번역해 준다
                .retryOn(PessimisticLockingFailureException.class)
                .maxAttempts(3)                                    // 상한 — 구조적 데드락이면 매번 같은 자리에서 죽는다
                .exponentialBackoff(50, 2.0, 1_000, true)          // withRandom=true → 지터: 같은 박자로 재충돌하지 않게
                .build();
    }
}
```

세 규칙은 [갭 락 문서 §5-4](gap-lock-next-key-lock-deadlock.md)와 같다 — **트랜잭션
밖에서**(안에서 잡으면 rollback-only 위에서 도는 셈), **상한**, **지터**. UPSERT
고유의 네 번째 이유가 있다: **재시도 1회 = 청크 행 수만큼 id 추가 소모**다. 상한
없는 재시도는 커넥션만 태우는 게 아니라 §2의 고갈도 앞당긴다. 그리고 재시도는
진통제다 — `SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'`(또는
`information_schema.INNODB_METRICS`의 `lock_deadlocks`)가 우상향이면 정렬이 깨졌거나
새 쓰기 경로가 생긴 것이므로 §3-4 목록으로 돌아간다.

### 6-3. AUTO_INCREMENT 사용률 모니터링 — 타입 최대치 대비 %로

```sql
-- 8.0: information_schema 통계는 기본 24시간 캐시된다(information_schema_stats_expiry).
--      현재 값을 보려면 세션에서 0으로 내리거나 ANALYZE TABLE 뒤에 본다.
SET SESSION information_schema_stats_expiry = 0;

SELECT t.TABLE_SCHEMA, t.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, t.AUTO_INCREMENT,
       ROUND(t.AUTO_INCREMENT * 100 /
             CASE
                 WHEN c.COLUMN_TYPE LIKE 'bigint%unsigned' THEN 18446744073709551615
                 WHEN c.COLUMN_TYPE LIKE 'bigint%'         THEN 9223372036854775807
                 WHEN c.COLUMN_TYPE LIKE 'int%unsigned'    THEN 4294967295
                 WHEN c.COLUMN_TYPE LIKE 'int%'            THEN 2147483647
                 WHEN c.COLUMN_TYPE LIKE 'mediumint%unsigned' THEN 16777215
                 WHEN c.COLUMN_TYPE LIKE 'mediumint%'      THEN 8388607
                 WHEN c.COLUMN_TYPE LIKE 'smallint%unsigned'  THEN 65535
                 WHEN c.COLUMN_TYPE LIKE 'smallint%'       THEN 32767
             END, 2) AS used_pct
FROM information_schema.TABLES t
JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
 AND c.EXTRA LIKE '%auto_increment%'
WHERE t.AUTO_INCREMENT IS NOT NULL
  AND t.TABLE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema')
ORDER BY used_pct DESC;
```

이 쿼리를 **주기 잡 → 메트릭 → 알람**으로 잇는다. 예를 들어 `db.autoinc.used_ratio{table}`
게이지를 1시간마다 발행하고 50%에서 경고, 70%에서 긴급으로 건다(임계값은 예시).
경고의 목적은 "지금 큰일"이 아니라 **§2-3의 무중단 전환 절차를 시작할 시간을 버는
것**이다 — 사용률과 함께 **일간 증가량**을 같이 찍으면 "며칠 남았는가"가 그래프에서
바로 읽힌다(§2-2의 나눗셈을 시스템이 대신 한다).

```java
@Scheduled(fixedDelay = 3_600_000)
public void publishAutoIncrementUsage() {
    for (AutoIncUsage u : repo.autoIncrementUsage()) {                 // 위 SQL 의 결과
        Gauge.builder("db.autoinc.used_ratio", u, AutoIncUsage::ratio)
             .tag("table", u.table())
             .register(meterRegistry);
    }
}
```

### 6-4. 데드락 재현 테스트 — 순서 교차를 타임라인으로 강제한다

다건 문장 하나로도 데드락은 나지만 확률적이다. 테스트에서는 **문장을 둘로 쪼개고
래치로 타임라인을 강제**해 결정적으로 재현한다 — 갭 락 문서 §5-3과 같은 기법이다.
DB는 실제 MySQL(Testcontainers)이어야 한다. H2는 InnoDB 락을 흉내 내지 않는다.

```java
@SpringBootTest
@Testcontainers
class PriceUpsertDeadlockTest {

    @Container static final MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");

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

        long victims = results.stream().filter(f -> failedWith(f, DeadlockLoserDataAccessException.class)).count();
        assertThat(victims).isEqualTo(1);                                 // InnoDB 가 한쪽만 롤백한다
    }

    @Test
    void 유니크_키_순으로_정렬하면_같은_두_세션이_모두_정상_완료된다() throws Exception {
        seed("A-100", "A-200");
        List<PriceRow> input = List.of(row("A-200"), row("A-100"), row("A-200"), row("A-100"));   // 일부러 뒤섞인 입력
        ExecutorService pool = Executors.newFixedThreadPool(2);

        List<Future<Void>> results = pool.invokeAll(List.of(
                () -> { service.sync(input); return null; },              // 안에서 dedupe + 정렬 + 청크 + 재시도
                () -> { service.sync(input); return null; }), 30, TimeUnit.SECONDS);

        for (Future<Void> f : results) f.get();                           // 예외 없이 둘 다 끝난다 (한쪽은 잠깐 대기)
    }

    private void upsertOne(String sku) {
        jdbc.update("""
            INSERT INTO product_price (sku, region, price, updated_at) VALUES (?, 'KR', 1, NOW(6)) AS new
            ON DUPLICATE KEY UPDATE price = new.price, updated_at = new.updated_at
            """, sku);
    }

    private static void await(CountDownLatch latch) {
        try { if (!latch.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("timeline broken"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IllegalStateException(e); }
    }
}
```

첫 번째 테스트는 **문제가 실재함을 팀에 증명**하고(위키 문장이 아니라 빨간
테스트), 두 번째는 **§5-2의 골격이 그것을 막는다는 사실을 회귀로 고정**한다.
누군가 `UNIQUE_KEY_ORDER`를 `updated_at` 순으로 바꾸거나 `SortedBatch`를 우회하는
리팩터링을 하면 두 번째가 깨진다.

### 6-5. id 소모 특성 테스트 — 선택한 설계를 숫자로 고정

§4-2의 "UPDATE 먼저" 분기를 택했다면 그 결정을 테스트로 박는다. UPSERT를 그대로
쓰기로 했다면 같은 테스트를 `isEqualTo(1_000)`으로 두고 **"알고 내는 비용"임을
주석으로 남긴다** — 어느 쪽이든 나중에 누군가 방식을 바꿀 때 이 테스트가 먼저
말을 건다.

```java
@Test
void 갱신_전용_배치는_AUTO_INCREMENT를_소모하지_않는다() {
    seed(1_000);                                                   // 1,000 행 존재
    long before = currentAutoIncrement("product_price");

    service.sync(sameKeysWithNewPrices(1_000));                    // 전부 갱신, 신규 0

    long after = currentAutoIncrement("product_price");
    assertThat(after - before).isZero();                           // 단일 UPSERT 로 되돌리면 1,000 이 나와 여기서 깨진다
}

private long currentAutoIncrement(String table) {
    jdbc.execute("SET SESSION information_schema_stats_expiry = 0");
    return jdbc.queryForObject("""
            SELECT AUTO_INCREMENT FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
            """, Long.class, table);
}
```

---

## 7. 목록 인출용 — 주의점 8가지 / 체크리스트 10항

면접에서 "주의점이 뭐가 있죠?"에 **번호를 붙여** 내놓는다. 앞의 두 개가 질문에 적힌
것이고, 나머지가 변별점이다.

**UPSERT 주의점 8가지**

1. **AUTO_INCREMENT 소모** — 갱신 행도 id를 받고 반납하지 않는다. 갱신 위주 배치는
   행 수만큼 카운터가 점프한다(§2).
2. **데드락(순서 교차)** — 중복 행마다 X 락을 커밋까지 쥐고, VALUES 순서가 락
   순서다. 겹치는 키를 다른 순서로 처리하는 두 세션은 순환한다(§3-2).
3. **넥스트 키 락(RR)** — 유니크 중복은 앞 갭까지 잠근다. 무관한 신규 INSERT가 서고,
   RC로 내려도 중복 검사 갭 락은 남는다(§3-3).
4. **affected rows 의미** — 1 삽입 / 2 갱신 / 0 변화 없음. Connector/J 기본값
   (`useAffectedRows=false`)은 0을 1로 올린다(§1-3).
5. **유니크 키가 여럿이면 어느 키 충돌인지 모른다** — 의도치 않은 행 갱신, 문장 기반
   복제 unsafe(§1-4).
6. **`UPDATE` 절에 적은 컬럼만 바뀐다** — `updated_at`을 빼먹으면 갱신 흔적이 없고,
   조건 없이 덮으면 늦게 온 옛 데이터가 새 데이터를 덮는다(§5-2의 `IF`).
7. **JPA를 우회한다** — 네이티브 문장이라 1차 캐시·Auditing·`@Version`·리스너가
   동작하지 않는다([유니크 제약 문서 §5-3](../03-jpa-orm/unique-constraint-concurrent-insert.md)).
8. **벤더 종속** — MySQL `ON DUPLICATE KEY UPDATE`, PostgreSQL `ON CONFLICT`,
   표준 `MERGE`가 각각 다르고 의미도 다르다(§8).

**안전한 대량 UPSERT 체크리스트 10항**

1. 이 배치는 **신규 위주인가 갱신 위주인가** — 갱신 위주면 UPDATE-먼저 분기로 id
   소모를 신규 행 수로 낮춘다.
2. 대리 키가 **정말 필요한가** — 매핑 테이블이면 자연 키 PK로 AUTO_INCREMENT를
   없앤다.
3. PK 타입은 **BIGINT**인가 — 새 테이블은 BIGINT, 기존 INT는 §6-3 알람 + §2-3 절차.
4. 입력에서 **같은 키를 최신 1건으로 접었는가** — 행 수 = id 소모량, PG는 필수.
5. **유니크 인덱스 컬럼 순서로 정렬**했는가 — 그리고 그 정렬이 타입으로
   강제되는가(§6-1).
6. **청크 = 트랜잭션**인가 — 500~1,000, `max_allowed_packet` 안에서.
7. **재시도는 트랜잭션 밖**에 상한·지터와 함께 있는가 — 멱등이므로 안전, 단
   재시도도 id를 태운다.
8. 병렬이면 **키 파티셔닝으로 워커 간 키가 서로소**인가.
9. JDBC URL에 **`rewriteBatchedStatements=true`**가 있고, general log로 재작성을
   **한 번은 확인**했는가.
10. **데드락 재현 테스트와 사용률 알람**이 있는가 — `Innodb_deadlocks` 추세,
    `AUTO_INCREMENT / 타입 최대치`.

---

## 8. PostgreSQL `ON CONFLICT`와의 차이 (가산점 포인트)

같은 UPSERT지만 다섯 군데가 다르다. 짧게 짚을 수 있으면 "MySQL만 아는 사람"이 아님이
드러난다.

```sql
INSERT INTO product_price (sku, region, price, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (sku, region)                              -- ① 충돌 대상을 명시 — 이 컬럼 조합에 유니크 인덱스가 있어야 한다
DO UPDATE SET price = EXCLUDED.price,                  -- ② 삽입하려던 행은 EXCLUDED 로 참조
              updated_at = EXCLUDED.updated_at
WHERE product_price.updated_at < EXCLUDED.updated_at;  -- ③ 조건부 갱신을 IF 없이 WHERE 로
```

- **① 충돌 대상 명시** — 어느 유니크 제약에서 충돌할지 지정한다. MySQL의 "아무
  유니크 키" 문제(§1-4)가 없다. `DO NOTHING`은 "있으면 무시"를 오류 은폐 없이 한다.
- **시퀀스도 소모된다** — 기본값 `nextval()`은 충돌 판정 전에 평가되고 시퀀스는
  트랜잭션과 무관하게 전진하므로, `DO NOTHING`이든 `DO UPDATE`든 갱신 행도 시퀀스
  값을 태운다. 이 문항의 ①은 PostgreSQL에서도 그대로다(다만 기본 `bigserial`/
  `bigint identity`를 쓰는 관행이 있어 체감이 덜하다).
- **affected rows는 삽입+갱신 행 수** — MySQL의 0/1/2 인코딩이 없다. `DO NOTHING`
  으로 건너뛴 행은 세지 않는다.
- **한 문장에서 같은 키가 두 번 나오면 오류** — `ON CONFLICT DO UPDATE command
  cannot affect row a second time`. MySQL은 두 번째를 순서대로 갱신하지만 PG는
  문장을 거부하므로 §5-2 ①의 중복 제거가 선택이 아니라 필수다.
- **데드락은 같다** — 행 락을 잡는 순서가 VALUES 순서이고, 두 세션의 순서가 다르면
  교차한다. 정렬·청크·재시도 골격은 그대로 쓴다.

---

## 9. 꼬리질문 대비 포인트

### "UPDATE로 처리된 행인데 왜 AUTO_INCREMENT가 늘어나죠? 안 썼으면 안 쓴 것 아닌가요?"

"안 썼다"와 "반납했다"는 다르다. AUTO_INCREMENT 값은 저장 엔진이 행을 받기 전에
MySQL 서버 층에서 채워지고, 중복 여부는 그 뒤 인덱스에 넣어 봐야 안다(§1-2). 중복이면
UPDATE 경로로 가지만 카운터에 "돌려주기"가 없고, 문서도 UPSERT를 "할당된 값이 UPDATE
단계에서 쓰이지 않을 수 있는 mixed-mode insert"로 명시한다. 카운터는 단조 증가만
하며 8.0부터는 redo 로그로 영속화돼 재시작해도 그대로다. 그래서 20만 건 중 199,800건이
갱신이어도 카운터는 200,000 오른다. 갱신된 행의 **기존 id가 필요**하면 `ON DUPLICATE
KEY UPDATE id = LAST_INSERT_ID(id)` 관용구로 `LAST_INSERT_ID()`에 실어 받을 수
있다(가산점 포인트) — 이건 카운터를 되돌리는 게 아니라 값을 읽는 방법일 뿐이다.

### "그럼 `REPLACE INTO`로 바꾸면 안 되나요?" (시니어 변별 포인트)

안 된다 — 그리고 이유를 DELETE+INSERT 사슬로 말한다. `REPLACE`는 기존 행을 지우고
새로 넣는다. 따라서 ⑴ **항상 새 AUTO_INCREMENT**를 받아 소모는 그대로거나 더 나쁘고,
PK 자체가 바뀌어 그 id를 들고 있던 자식 FK·캐시·외부 시스템이 고아가 된다 ⑵ FK가
`ON DELETE CASCADE`면 **자식 행이 함께 삭제**되고 `RESTRICT`면 문장이 실패한다 ⑶
DELETE·INSERT 트리거가 발화하고 세컨더리 인덱스마다 delete-mark + 재삽입이 일어나
undo·redo·binlog가 두 배다 ⑷ 문장에 적지 않은 컬럼(`created_at`, `memo`)은 **기본값으로
초기화**된다 — "가격만 바꿨는데 등록일이 오늘로 바뀌었다"가 이 사고다. `REPLACE`가
맞는 자리는 "행 전체를 통째로 교체하는 것이 의미상 맞고, 아무도 이 행의 id를
참조하지 않는" 캐시성 테이블뿐이다.

### "키를 정렬하면 데드락이 완전히 사라지나요?" (시니어 변별 포인트)

순서 교차형은 사라지고, 나머지는 줄어들 뿐이다. 정렬이 없애는 것은 "두 세션이
겹치는 키를 다른 순서로 잠그는" §3-2의 구조다 — 모든 세션이 같은 전순서로 락을 잡으면
순환이 생기지 않는다는 자원 순서화 원리다. 남는 것은 ⑴ RR의 넥스트 키 락이 잠근
갭에 **새 키**를 넣는 제3 세션과의 얽힘(§3-3) ⑵ 정렬 규약을 안 지키는 **다른 쓰기
경로**(운영 API, 다른 배치) ⑶ 세컨더리 유니크 인덱스와 클러스터드 인덱스 양쪽에
락이 잡히는 미세한 순서 차이. 그래서 정렬 위에 **트랜잭션 밖의 상한·지터 있는
재시도**를 반드시 얹고(§6-2), 병렬이면 **키 파티셔닝으로 겹침 자체를 없애며**(§4-2),
`Innodb_deadlocks` 추세를 본다 — 재시도가 자주 발동하면 정렬이 깨졌거나 새 쓰기
경로가 생긴 것이다. "RC로 내리면요?"가 이어지면 §3-3 — 중복 검사 갭 락은 RC가 안
끄고, 순서 교차는 격리 수준과 무관하다.

### "affected rows로 INSERT/UPDATE를 구분하려는데 값이 이상하게 나옵니다. 왜죠?"

두 층을 순서대로 의심한다. ⑴ **드라이버 플래그** — Connector/J는 기본으로
`CLIENT_FOUND_ROWS`를 켜고 접속해(`useAffectedRows=false`) "변화 없는 UPDATE"의 0을
1로 올려 보낸다. INSERT(1)와 구분이 안 되는 것이 정상 동작이고, `useAffectedRows=true`로
서버 값을 그대로 받는다 — 단 이 옵션은 모든 UPDATE의 반환 의미를 "매치 수"에서 "변경
수"로 바꾸므로 그것에 의존한 코드가 있는지 함께 본다(§1-3). ⑵ **배치 재작성** —
`rewriteBatchedStatements=true`로 다중 행 한 문장이 됐다면 행별 값은 없고 문장 합계
하나뿐이다. 행별 판정이 필요하면 단건으로 보내거나 §4-2처럼 SELECT로 먼저 갈라
INSERT 배치와 UPDATE 배치의 카운트를 따로 받는다.

### "INT PK인 운영 테이블이 이미 60%입니다. 어떻게 하시겠어요?" (시니어 변별 포인트)

순서가 답이다. **① 출혈부터 멈춘다** — 이 테이블에 UPSERT를 치는 배치를 찾아(§6-3
쿼리 + 일간 증가량) 갱신 위주면 UPDATE-먼저 분기로 바꾸고, 입력 중복을 접는다.
이것만으로 소모 속도가 수백 분의 1이 되어 시간을 산다. **② 남은 시간을 숫자로** —
바뀐 일간 증가량으로 `(최대치 − 현재) / 일간 증가량`을 계산해 데드라인을 정한다.
**③ BIGINT 전환은 무중단 절차로** — 컬럼 타입 변경은 COPY라 gh-ost/pt-osc가
필요하고, 자식 테이블의 FK 컬럼도 같은 절차로 먼저 넓히며, 애플리케이션의
`Integer`를 `Long`으로 바꾸는 배포를 DB 변경보다 앞세운다(둘 다 호환되는 순서로).
디스크는 PK 4→8B가 모든 세컨더리 인덱스에 전파되는 만큼 늘어난다. **④ 이 테이블에
대리 키가 필요했는지 되묻는다** — 매핑 테이블이면 이 기회에 자연 키 PK로 가는 것이
전환 한 번으로 문제를 영구히 없애는 길일 수 있다. **⑤ 재발 방지** — 사용률 알람과
§6-5 테스트를 남긴다. "BIGINT로 바꾸겠습니다" 한 줄로 끝내면 ①②④가 빠진 것이고,
그 사이에 고갈이 먼저 올 수 있다.

---

## 한 줄 요약

`INSERT ... ON DUPLICATE KEY UPDATE`는 왕복 한 번에 틈 없이 멱등하게 "없으면 넣고
있으면 고치는" 대신, 행마다 id를 먼저 받고 중복이면 반납 없이 버려 갱신 위주 배치가
돌 때마다 카운터를 배치 행 수만큼 밀어 INT PK를 행 수가 아니라 처리량의 속도로
고갈시키고, 중복 행마다 X(넥스트 키) 락을 커밋까지 쥔 채 VALUES 순서로 처리해 겹치는
키를 다른 순서로 치는 두 세션을 순환 대기에 빠뜨린다 — 그래서 대량 UPSERT는 입력
중복을 접고 유니크 인덱스 순으로 정렬한 청크를 짧은 트랜잭션으로 보내며 트랜잭션
밖에서 상한·지터 있는 재시도를 걸고, 갱신 위주면 UPDATE-먼저 분기나 자연 키 PK로 id
소모 자체를 없애며, 사용률 알람과 데드락 재현 테스트로 그 결정을 코드에 고정하는
것이지, `INSERT IGNORE`나 `REPLACE INTO`로 갈아타는 것이 아니다.
