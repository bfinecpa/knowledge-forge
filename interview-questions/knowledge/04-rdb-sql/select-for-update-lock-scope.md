# `SELECT ... FOR UPDATE`의 락 범위 — 락은 "찾은 행"이 아니라 "스캔한 인덱스 레코드"에 걸린다

> 핵심 관전 포인트: **InnoDB에서 `SELECT ... FOR UPDATE`는 ① 테이블에
> IX(의도 배타) 락, ② 탐색 중 만난 모든 인덱스 레코드에 배타(X) 레코드 락,
> ③ REPEATABLE READ면 그 레코드 앞의 갭까지 묶은 넥스트 키 락(유니크
> 인덱스 등호 단건 조회만 예외로 레코드 락만), ④ 세컨더리 인덱스로 찾았으면
> 그 세컨더리 레코드에 더해 대응하는 클러스터드(PK) 레코드까지 잠근다.
> 원리는 하나다 — **InnoDB는 WHERE 조건을 기억하지 않고 어떤 인덱스 범위를
> 스캔했는지만 알기 때문에, 락은 "조건에 맞아 찾은 행"이 아니라 "찾는
> 과정에서 스캔한 레코드"에 걸린다.** 그래서 WHERE가 인덱스를 못 타면
> 사슬이 시작된다: 클러스터드 인덱스 풀스캔(`type=ALL`) → 전 행에 X 락 +
> RR이면 전 갭에 갭 락 → 사실상 테이블 배타 락 → 이 테이블에 쓰는 모든
> 트랜잭션이 `innodb_lock_wait_timeout`까지 대기 → 대기 트랜잭션마다
> 커넥션을 쥔 채 멈춤 → 커넥션 풀 고갈 → 이 테이블과 무관한 API까지 커넥션
> 획득 실패 → 전면 장애. **한 건 잠그려다 서비스를 세운다.** 그래서
> `FOR UPDATE`는 PK/유니크 인덱스 등호 조건으로만 걸고, 코드 리뷰에서
> `EXPLAIN` 증빙(`type=const/eq_ref/ref`, `rows` 한 자릿수)을 요구하며,
> 락 대기 상한을 3층(DB·JPA·커넥션 풀)으로 걸고,
> `performance_schema.data_locks`로 잠긴 레코드 수를 눈으로 확인하는
> 안전망을 붙인다.**

---

## 0. 질문 + 의도

**질문**: "`SELECT ... FOR UPDATE`는 어떤 락을 잡나요? WHERE 조건이 인덱스를
못 타면 무슨 일이 벌어지나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "조건이 인덱스를 못 타면 스캔한
행 전부에 락이 걸려 **'한 건 잠그려다 테이블을 세우는' 사고**가 난다. 락을
'무엇을 잠그는가'가 아니라 **'어떻게 찾은 행을 잠그는가'**로 이해하는지 —
실행 계획과 락이 결합되는 한 단계 깊은 이해를 확인한다." 즉 채점 지점은
"행 락(X 락)을 잡는다"라는 정의가 아니라, ① 잡히는 락의 **종류를 목록으로**
꺼낼 수 있는가 ② 그 락이 **실행 계획(어떤 인덱스를 어떻게 스캔했나)에 의해
결정된다**는 것을 아는가 ③ 인덱스를 못 탔을 때의 결과를 "느려진다"가 아니라
**풀스캔 → 전 행 락 → 쓰기 전원 대기 → 커넥션 고갈**이라는 이름 붙은 사슬로
말할 수 있는가 ④ 그 사고를 **리뷰·설정·모니터링으로 미리 막는 안전망**을
갖고 있는가다.

**이 문서가 선행 문서와 나누는 경계**: 비관적 락 vs 낙관적 락의 선택 기준과
"대기 중 붙잡히는 건 스레드가 아니라 커넥션"이라는 대가는
[낙관적 락 vs 비관적 락](../03-jpa-orm/optimistic-vs-pessimistic-lock.md)과
[동시성 갱신 4가지 비교](../03-jpa-orm/concurrency-update-four-approaches.md)에서
이미 다뤘다. 여기서는 **DB 안에서 락이 몇 개의 레코드에, 어떤 모양으로 걸리는가**
— 락의 **폭**에 집중한다. 갭 락·넥스트 키 락 자체의 상세와 그것이 만드는
데드락은 [갭 락과 데드락](gap-lock-next-key-lock-deadlock.md)에 맡기고 링크만 건다.

---

## 1. 무엇을 잠그는가 — 락 목록을 통째로 인출한다

### 1-1. 가장 안전한 형태부터 — PK 등호 조회

```sql
-- orders(PK id), REPEATABLE READ(MySQL 기본)
SELECT * FROM orders WHERE id = 42 FOR UPDATE;
```

이 한 문장이 잡는 락을 **네 칸 목록**으로 말한다.

```text
① 테이블 수준: IX (Intention eXclusive, 의도 배타) 락
   "이 테이블의 어떤 행에 X 락을 걸 예정"이라는 예고. IX끼리는 서로 호환되므로
   다른 트랜잭션의 행 락과는 충돌하지 않는다. LOCK TABLES ... WRITE 같은
   테이블 전체 락과만 충돌.
   (+ 서버 레벨의 메타데이터 락(MDL) — 트랜잭션이 끝날 때까지 이 테이블의
      DDL(ALTER)이 들어오지 못하게 막는다. 락의 종류는 다르지만 "열린
      트랜잭션이 테이블을 붙잡는다"는 효과는 같다)

② 레코드 락 (X, REC_NOT_GAP): 클러스터드 인덱스 레코드 id=42 하나에 배타 락
   → 다른 트랜잭션의 UPDATE / DELETE / FOR UPDATE / FOR SHARE 는 이 행에서 대기
   → 일반 SELECT(일관된 읽기)는 MVCC 스냅샷을 읽으므로 막히지 않는다

③ 갭 락 / 넥스트 키 락: 이 경우는 없음
   → "유니크 인덱스 + 등호 + 단건"은 갭을 잠글 이유가 없다(같은 값이 또 INSERT될 수 없으니)

④ 세컨더리 → 클러스터드 연쇄 잠금: 이 경우는 없음
   → 처음부터 클러스터드 인덱스를 탐색했으므로
```

`FOR UPDATE`를 안전하게 쓰는 기본형이 왜 "PK 등호"인지가 이 목록에서 드러난다.
**②만 남고 ③④가 비기 때문**이다.

### 1-2. 일반형 — 세컨더리(비유니크) 인덱스로 찾는 경우

```sql
-- idx_customer(customer_id) 가 있는 비유니크 세컨더리 인덱스, REPEATABLE READ
SELECT * FROM orders WHERE customer_id = 7 FOR UPDATE;
```

```text
① IX 테이블 락 (동일)

②+③ 세컨더리 인덱스 idx_customer 에서 customer_id=7 인 레코드 각각에 넥스트 키 락
     = 레코드 X 락 + 그 레코드 "앞" 갭의 갭 락
     + 마지막 매치 다음 레코드 앞 갭에 갭 락
     → customer_id=7 인 새 주문 INSERT 가 차단된다 (phantom 방지)
     → 비유니크라서 "7이 또 있을 수 있다"고 보고 범위를 잠근다

④ 매치된 각 레코드의 PK 값으로 클러스터드 인덱스 레코드에도 X 레코드 락
     → 세컨더리 3건이 매치되면 클러스터드에도 3건이 잠긴다
```

### 1-3. 왜 세컨더리 인덱스로 찾아도 PK(클러스터드) 레코드까지 잠기나

InnoDB의 락은 "행"에 붙는 게 아니라 **인덱스 레코드에 붙는다.** 그런데 행의
실체 — 모든 컬럼이 들어 있는 진짜 데이터 — 는
[클러스터드 인덱스의 리프](clustered-vs-secondary-index.md)에만 있고,
세컨더리 인덱스 리프에는 `(인덱스 컬럼 값, PK)`만 있다.

만약 세컨더리 레코드만 잠그고 클러스터드 레코드를 그냥 둔다면:

```text
Tx A: SELECT * FROM orders WHERE customer_id = 7 FOR UPDATE;
      → idx_customer 의 (7, id=42) 레코드만 잠갔다고 가정

Tx B: UPDATE orders SET status = 'CANCELLED' WHERE id = 42;
      → B 는 PK 로 접근하므로 idx_customer 는 건드리지도 않는다
      → 클러스터드 레코드 id=42 는 잠겨 있지 않다 → B 가 그냥 통과
      → A 는 "내가 잠갔다"고 믿는 행이 B 에 의해 바뀐다 = 락이 뚫린 것
```

행에 도달하는 경로는 여러 개(PK, 각 세컨더리 인덱스)지만 **모든 경로가
마지막에 반드시 통과하는 지점은 클러스터드 레코드 하나**다. 그래서 InnoDB는
X 락을 걸어야 하는 잠금 읽기가 세컨더리 인덱스를 탔으면 **대응하는
클러스터드 레코드를 찾아가 거기에도 락을 건다.** 클러스터드 레코드 락이
"이 행은 잠겼다"의 **정본**이고, 세컨더리 레코드 락은 그 인덱스 범위의 갭을
지키는 보조다.

> **도서관 비유** — 색인 카드(세컨더리)에만 "대출 중" 스티커를 붙이면, 서가
> 번호(PK)를 이미 알고 직접 서가로 가는 사람은 못 막는다. 책 자체(클러스터드
> 레코드)에 붙여야 어떤 경로로 오든 막힌다.

**(가산점 포인트)** 이 규칙은 **커버링 인덱스여도 적용된다.** 조회 컬럼이 전부
세컨더리 인덱스 안에 있어 북마크 룩업이 필요 없는 쿼리라도, `FOR UPDATE`면
InnoDB는 클러스터드 레코드를 찾아가 잠근다 — `FOR UPDATE`는 "곧 갱신하겠다"는
선언이고 갱신은 클러스터드 레코드에서 일어나기 때문이다. (공유 락 `FOR SHARE`는
락 모드가 배타가 아니어서 커버링일 때 클러스터드까지 안 갈 수 있다 — "X 락을
걸어야 할 때"라는 단서가 붙는 이유다.) 반대 방향도 성립한다: 인덱스 컬럼 값을
바꾸는 `UPDATE`는 클러스터드 레코드뿐 아니라 **영향받는 세컨더리 인덱스
레코드도 잠근다.**

### 1-4. 격리 수준이 락의 모양을 바꾼다 — RR vs RC

같은 `FOR UPDATE`라도 격리 수준에 따라 ③이 있느냐 없느냐가 갈린다.

| | REPEATABLE READ (MySQL 기본) | READ COMMITTED |
|---|---|---|
| 스캔한 레코드 | 넥스트 키 락(레코드 + 앞 갭) | 레코드 락만 |
| 조건에 안 맞는 레코드 | 락 유지 (커밋까지) | WHERE 평가 후 해제 |
| 범위 안 INSERT | 갭 락으로 차단 | 허용 |
| 유니크 인덱스 등호 단건 | 레코드 락만 (예외) | 레코드 락만 |

RC에서는 갭 락이 사라지고(외래 키 검사·중복 키 검사 제외), 서버가 WHERE를
평가해 조건에 안 맞는 행의 락은 풀어준다. 그래서 "RC로 낮추면 락 사고가
줄어든다"는 말은 절반은 맞다 — 다만 **"안 잠그는 것"이 아니라 "잡았다가
푸는 것"** 이고, 그 차이가 §2에서 중요해진다. 갭 락과 넥스트 키 락의 상세,
그리고 그것이 만드는 "INSERT만 하는데 데드락"은
[갭 락과 데드락](gap-lock-next-key-lock-deadlock.md)에서 다룬다. 격리 수준 자체는
[격리 수준 4가지](transaction-isolation-levels.md).

### 1-5. 락은 SELECT가 끝나도 안 풀린다 — 커밋까지

InnoDB의 행 락은 **트랜잭션이 커밋/롤백될 때 한꺼번에 풀린다**(2단계 잠금).
`FOR UPDATE` 문장이 결과를 돌려준 순간이 아니다. 따라서 **락 보유 기간 =
그 SELECT 이후 트랜잭션이 끝날 때까지의 시간 전부**이고, 그 안에 자바 계산,
왕복 몇 번, 외부 API 호출이 들어가면 그만큼 남들이 기다린다.
[03 문서 §4](../03-jpa-orm/optimistic-vs-pessimistic-lock.md)가 다룬
"얼마나 오래 잠그느냐"가 이 축이고, 트랜잭션이 길어질 때 락 점유 외에
무엇이 더 무너지는지는 [긴 트랜잭션의 해악](long-transaction-harm-and-shortening.md)에서
다룬다. 이 문서의 주제인 **폭(몇 개를)** 과
저 문서의 **기간(얼마나 오래)** 을 곱한 것이 락 비용의 총량이다.

---

## 2. 인덱스를 못 타면 — 메커니즘 사슬로 말하기

### 2-1. 원리 한 문장: InnoDB는 WHERE를 기억하지 않는다

MySQL의 실행 구조를 한 줄로 요약하면 — **스토리지 엔진(InnoDB)이 인덱스 순서로
레코드를 하나씩 읽어 올리고, SQL 계층이 그 레코드가 WHERE에 맞는지 판정한다.**
잠금 읽기에서는 InnoDB가 레코드를 읽어 올리는 **그 시점에** 락을 건다. 조건에
맞는지는 아직 아무도 모른다. 그리고 InnoDB 문서의 표현대로, InnoDB는 정확한
WHERE 조건을 기억하지 못하고 **"어떤 인덱스 범위를 스캔했는가"만 안다.** 그래서
락은 그 범위 안의 모든 레코드에 남는다.

이걸 눈으로 보면:

```text
orders: PK id, order_no 컬럼에 인덱스 없음, REPEATABLE READ
SELECT * FROM orders WHERE order_no = 'A-1003' FOR UPDATE;

쓸 인덱스가 없다 → 클러스터드 인덱스를 처음부터 끝까지 읽는다:

 id=1  order_no='A-1001'  읽음 → 넥스트 키 락 → 조건 불일치 → 그래도 잠긴 채
 id=2  order_no='A-1002'  읽음 → 락 → 불일치 → 잠긴 채
 id=3  order_no='A-1003'  읽음 → 락 → 일치! (이 행만 반환된다)
 id=4  order_no='A-1004'  읽음 → 락 → 불일치   ← "더 있을지 모르니" 끝까지 간다
 ...
 id=N                     읽음 → 락
 supremum(테이블 끝 가상 레코드) → 마지막 갭까지 갭 락
                          ← AUTO_INCREMENT 로 테이블 끝에 붙는 새 INSERT 가 전부 막힌다

결과: 반환 1행 / 잠긴 레코드 = 테이블 전체 + 모든 갭
```

**반환된 행 수와 잠긴 레코드 수는 다른 숫자다.** 이 문장이 이 질문의 전부다.
"한 건만 조회하는 쿼리인데요"는 반환 행 이야기고, 락은 스캔 이야기다.

### 2-2. 사슬 8단계 — 각 단계에 이름과 관측 증거를 붙인다

비용을 "락이 많이 걸려서 느려진다"로 뭉뚱그리지 않는다. 단계마다 **이름**과
**그 단계에서 무엇이 보이는가**를 붙여 말한다.

```text
① 인덱스 부재 (또는 있어도 못 탐: 함수·타입 불일치·낮은 선택도)
   증거: EXPLAIN → type=ALL, key=NULL, rows ≈ 전체 행 수
        ↓
② 클러스터드 인덱스 풀스캔 + 스캔한 모든 레코드에 X 락 (RR: 넥스트 키 + supremum 갭)
   증거: performance_schema.data_locks 에 행 수만큼 RECORD/X 가 쌓임
        information_schema.INNODB_TRX.trx_rows_locked ≈ 테이블 행 수
        ↓
③ 사실상 테이블 배타 락 — 이름은 행 락, 효과는 테이블 락
   행 락이 전부 + 갭 락이 전부 = UPDATE/DELETE 도, INSERT 도 어디에도 못 들어간다
   증거: "조회는 되는데 저장이 안 된다" (일반 SELECT 는 MVCC 라 살아 있다)
        ↓
④ 이 테이블에 쓰는 모든 트랜잭션이 대기 — innodb_lock_wait_timeout(기본 50초)까지
   증거: sys.innodb_lock_waits 에 blocking 1건 : waiting 수십 건
        앱 로그 "Lock wait timeout exceeded; try restarting transaction"
        ↓
⑤ 대기 트랜잭션은 커넥션을 쥔 채 멈춘다
   FOR UPDATE/UPDATE 를 보내 놓고 응답을 기다리는 중 = 커넥션 반납 불가 (03 문서 §3-2)
   증거: HikariCP active ≈ maximumPoolSize, idle = 0, pending 증가
        ↓
⑥ 커넥션 풀 고갈 → 이 테이블과 무관한 API(로그인·조회)까지 커넥션을 못 얻는다
   증거: connectionTimeout(HikariCP 기본 30초) 후
        "SQLTransientConnectionException: Connection is not available, request timed out"
        무관한 엔드포인트의 p99 가 동시에 튄다
        ↓
⑦ 전면 장애 + 호송 효과(convoy)
   원인 트랜잭션이 커밋해도 대기열 맨 앞의 다음 트랜잭션이 또 같은 쿼리 → 또 전체 락
   클라이언트 재시도까지 겹치면 대기열이 줄지 않고 늘어난다
        ↓
⑧ 회복: 원인 트랜잭션 KILL → 인덱스 추가 / 쿼리 수정 배포. 재발 방지는 §4
```

면접에서 한 호흡으로 말할 버전:

> **인덱스 부재 → 풀스캔 → 스캔한 전 레코드에 X 락(RR이면 갭까지) → 사실상
> 테이블 락 → 쓰기 트랜잭션 전원 대기 → 대기마다 커넥션 점유 → 풀 고갈 →
> 무관한 API로 전파.** 잠그려던 건 한 행이었다.

### 2-3. 같은 쿼리, 두 실행 계획, 두 락 개수 — EXPLAIN과 data_locks를 나란히

```sql
-- ❌ BEFORE — coupon.code 에 인덱스가 없다
EXPLAIN SELECT * FROM coupon WHERE code = 'SUMMER-2026' FOR UPDATE;
-- type=ALL | key=NULL | rows=1,203,441        ← 전부 읽겠다는 뜻

-- 이 트랜잭션이 잡은 락 (다른 세션에서)
SELECT index_name, lock_type, lock_mode, lock_status, lock_data
  FROM performance_schema.data_locks
 WHERE engine_transaction_id = <trx_id>;
-- NULL    | TABLE  | IX | GRANTED | NULL
-- PRIMARY | RECORD | X  | GRANTED | 1              ← X 만 있으면 "넥스트 키 락"
-- PRIMARY | RECORD | X  | GRANTED | 2
-- ...      (행 수만큼 계속)
-- PRIMARY | RECORD | X  | GRANTED | supremum pseudo-record   ← 테이블 끝 갭
```

```sql
-- ✅ AFTER — 유니크 인덱스를 걸었다
ALTER TABLE coupon ADD UNIQUE INDEX ux_coupon_code (code);

EXPLAIN SELECT * FROM coupon WHERE code = 'SUMMER-2026' FOR UPDATE;
-- type=const | key=ux_coupon_code | rows=1     ← 딱 하나

SELECT index_name, lock_type, lock_mode, lock_status, lock_data FROM performance_schema.data_locks ...;
-- NULL           | TABLE  | IX            | GRANTED | NULL
-- ux_coupon_code | RECORD | X,REC_NOT_GAP | GRANTED | 'SUMMER-2026', 42   ← 세컨더리 레코드 (갭 없음)
-- PRIMARY        | RECORD | X,REC_NOT_GAP | GRANTED | 42                  ← ④ 클러스터드 레코드까지
```

`lock_mode` 표기를 읽는 법 — `X`만 있으면 **넥스트 키 락**(레코드 + 앞 갭),
`X,REC_NOT_GAP`은 **레코드만**, `X,GAP`은 **갭만**. `lock_data`의
`supremum pseudo-record`는 테이블 끝의 열린 갭이다. 이 표를 읽을 수 있으면
"지금 이 트랜잭션이 몇 개를, 어떤 모양으로 잠갔나"를 추측이 아니라 관측으로
말할 수 있다.

### 2-4. 실무 변형 — 인덱스가 "있는데도" 테이블이 잠기는 네 가지

[풀스캔 원인 6종](index-not-used-full-scan.md)이 그대로 `FOR UPDATE`에 붙는다.
읽기 쿼리에서는 "느린 쿼리"로 끝나던 것이 잠금 읽기에서는 "테이블 락"이 된다.

```sql
-- (a) 타입 불일치 — code 는 VARCHAR 인데 숫자 리터럴/파라미터를 넘겼다
SELECT * FROM coupon WHERE code = 20260801 FOR UPDATE;
--  → 컬럼 쪽이 숫자로 형변환 → 인덱스 무효 → 풀스캔 → 전체 락
--  JPA 에서 파라미터 타입이 엔티티 필드 타입과 다를 때 조용히 발생한다

-- (b) 컬럼에 함수
SELECT * FROM reservation WHERE DATE(starts_at) = CURDATE() FOR UPDATE;

-- (c) 낮은 선택도 — 옵티마이저가 인덱스를 버린다
SELECT * FROM job WHERE status = 'PENDING' FOR UPDATE;
--  → 인덱스를 타도 PENDING 전부 + 갭, 안 타면 테이블 전부

-- (d) LIMIT 은 반환 행을 제한하지 잠기는 레코드를 제한하지 않는다
SELECT * FROM job WHERE status = 'PENDING' ORDER BY created_at LIMIT 10 FOR UPDATE;
--  → ORDER BY 를 인덱스로 못 풀면 filesort: 조건에 맞는 행을 "전부" 읽어 정렬한 뒤 10건을 자른다
--  → 읽은 전부가 잠긴다. (status, created_at) 인덱스가 있어야 10건에서 스캔이 멈춘다
```

(d)가 특히 뼈아프다. "10건만 가져오니 락도 10개겠지"는 반환 행과 스캔 행을
혼동한 것이고, 배치 워커의 `LIMIT n FOR UPDATE`가 큐 테이블 전체를 잠그는
사고의 정체다.

### 2-5. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "락이 많이 걸려서 느려진다" | **스캔 = 잠금** | 인덱스 부재 → 풀스캔 → 스캔한 전 레코드에 X 락(+갭) → 사실상 테이블 락 |
| "DB가 멈춘다" | **커넥션 풀 고갈** | 쓰기 트랜잭션 전원 대기 → 대기마다 커넥션 점유 → 풀 소진 → 무관 API 전파 |
| "한 건만 잠그는 쿼리인데요" | **반환 행 ≠ 잠긴 레코드** | 락은 스캔 시점에, WHERE 는 그 뒤에 서버가 평가 → 조건도 LIMIT 도 락 수를 안 줄인다 |
| "인덱스 있으니 괜찮다" | **실행 계획이 폭을 정한다** | 함수·타입 불일치·낮은 선택도로 인덱스를 못 타면 읽기 쿼리의 "느림"이 잠금 읽기의 "테이블 락"으로 격상 |

---

## 3. 트레이드오프 — 비관적 락의 대가와 선택 기준, `NOWAIT` / `SKIP LOCKED`

### 3-1. `FOR UPDATE`가 지불하는 것 — 폭 · 기간 · 자원

락 비용을 세 축으로 나누면 누가 무엇을 결정하는지가 분명해진다.

- **폭(몇 개의 레코드를)** — **실행 계획**이 정한다. 쿼리를 쓴 사람의 의도가
  아니라 옵티마이저가 고른 접근 경로가 정한다. 이 문서의 주제.
- **기간(얼마나 오래)** — **트랜잭션 경계**가 정한다. 커밋까지. 락 구간 안의
  왕복·계산·외부 호출이 그대로 남의 대기 시간이 된다
  ([03 문서 §4](../03-jpa-orm/optimistic-vs-pessimistic-lock.md)).
- **자원(기다리는 동안 무엇을 붙잡나)** — **커넥션 풀 크기**가 상한을 정한다.
  대기자는 스레드가 아니라 커넥션을 붙잡는다
  ([03 문서 §3-2](../03-jpa-orm/optimistic-vs-pessimistic-lock.md)).

비관적 락을 "간단하고 확실하다"고 고를 때 치르는 값은 이 셋의 **곱**이다.
폭이 1이면 기간과 자원만 관리하면 되지만, 폭이 테이블 전체가 되는 순간 나머지
둘이 아무리 잘 관리돼도 사고다. 그래서 **선택의 첫 관문은 "충돌이 잦은가"가
아니라 "잠글 행을 PK/유니크 등호로 특정할 수 있는가"** 다.

### 3-2. 선택 기준 — 03의 판단 플로우에 관문 하나를 앞에 붙인다

[동시성 갱신 4가지 비교 §4-1](../03-jpa-orm/concurrency-update-four-approaches.md)의
플로우(DB 밖 자원? → SQL 한 문장으로 압축? → 충돌 빈도?)는 그대로 유효하다.
여기에 DB 락 범위 관점의 **Q0**을 앞에 둔다.

```text
Q0. 잠글 행을 PK 또는 유니크 인덱스의 등호 조건으로 특정할 수 있는가?
    ├─ 예   → 비관적 락 후보 유지 (폭 = 1, 갭 없음)
    └─ 아니오 → 먼저 인덱스를 만들거나 "조회 → PK로 잠금" 2단계로 바꾼다 (§4-1)
              그래도 안 되면 비관적 락은 후보에서 뺀다
              (주의: 원자적 UPDATE 도 잠금 읽기라 같은 폭 문제를 갖는다 — §5)
```

세 방식과의 비교를 폭 관점으로만 짧게:

- **원자적 UPDATE** — `UPDATE ... WHERE id = ? AND qty >= ?`. 락의 **폭 규칙은
  동일**하다(UPDATE도 스캔한 레코드를 잠근다). 이기는 것은 **기간**(왕복 1회)이다.
- **낙관적 락** — 읽기가 일반 SELECT라 **읽는 동안 아무것도 잠그지 않는다.**
  인덱스가 없어도 느릴 뿐 남을 세우지 않는다. 대신 충돌 시 재시도 비용을 진다.
- **비관적 락** — 폭·기간·자원 셋 다 진다. 대신 재시도가 없고 복잡한 로직을
  락 안에서 안전하게 수행한다.

### 3-3. `NOWAIT` — "기다리느니 실패"

```sql
SELECT * FROM seat WHERE id = 1042 FOR UPDATE NOWAIT;
-- 이미 잠겨 있으면 대기하지 않고 즉시 에러 (MySQL 8.0+, PostgreSQL)
-- ERROR 3572: Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set.
```

- **용도**: 사용자 대면 선점(좌석·쿠폰·예약 버튼)처럼 **"기다리는 것"이 "실패
  응답"보다 나쁜 경우.** 100ms 기다려서 성공할 확률이 낮고, 그 사이 커넥션을
  붙잡는 비용이 크며, 사용자는 "다시 시도" 버튼을 누르면 된다.
- **얻는 것**: 대기열이 아예 생기지 않는다 → **대기자 쪽 커넥션 보호에 가장
  강력**하다. §2 사슬의 ④⑤⑥을 대기자 입장에서 끊는다.
- **대가**: ① 실패를 애플리케이션이 반드시 처리해야 한다(에러 매핑, 사용자
  메시지, 재시도 정책) ② 클라이언트가 자동 재시도하면 **재시도 폭풍**으로
  모양만 바뀐다 ③ **잠근 쪽의 폭 사고는 고치지 못한다** — 풀스캔 `FOR UPDATE`가
  테이블을 잡고 있으면 `NOWAIT` 쿼리는 전부 즉시 실패할 뿐이다. 피해자를
  빨리 죽이는 것이지 가해자를 고치는 게 아니다.
- **JPA**: `jakarta.persistence.lock.timeout = 0` 힌트가 MySQL 8 방언에서
  `FOR UPDATE NOWAIT`로 번역된다. 실패 시 `LockTimeoutException`
  (Spring: `CannotAcquireLockException` 계열). **생성 SQL을 로그로 확인하고
  쓴다** — 방언마다 지원이 다르다.

### 3-4. `SKIP LOCKED` — "잠긴 건 남의 것, 다음 것"

```sql
-- 워커 N 개가 동시에 도는 작업 큐
SELECT id, payload
  FROM job
 WHERE status = 'PENDING'
 ORDER BY id
 LIMIT 10
   FOR UPDATE SKIP LOCKED;     -- 다른 트랜잭션이 잠근 행은 건너뛰고, 안 잠긴 10건만 잠가서 가져온다
```

- **용도**: **여러 워커가 같은 테이블에서 서로 다른 행을 나눠 가져가야 할 때.**
  작업 큐, 아웃박스 릴레이, 배치 분산 처리. 이 패턴의 표준 해법이다.
- **얻는 것**: 워커들이 같은 행에서 줄 서지 않는다. `SKIP LOCKED` 없이
  `LIMIT 10 FOR UPDATE`를 N개 워커가 치면 **전원이 맨 앞 10건에서 직렬화**되고,
  첫 워커가 커밋하면 나머지는 이미 처리된 행을 잡아 "할 일 없음"으로 끝난다.
- **대가**: ① **결과가 비결정적**이다 — 같은 쿼리를 두 번 쳐도 다른 행이 온다.
  "몇 건 남았나", "이 행이 존재하나" 같은 **정합성 판단에 쓰면 안 된다.**
  오직 "내 몫 가져오기" 전용 ② 순서·공정성은 최선 노력이다 — 잠긴 행을
  건너뛰므로 `ORDER BY`는 "대체로 그 순서"일 뿐 ③ 가져온 행은 커밋까지 잠긴다
  → 워커는 `status = 'PROCESSING'`으로 바꾸고 **바로 커밋**한 뒤 실제 처리를
  해야 한다. 처리를 락 안에서 하면 §1-5의 기간 문제가 그대로 온다 ④
  **폭 문제를 없애주지 않는다** — `(status, id)` 인덱스가 없어 filesort가
  되면 `SKIP LOCKED`는 "안 잠긴 PENDING 행 전부"를 읽고 잠근 뒤 10건을 자른다.
  인덱스가 있어야 10건에서 스캔이 멈춘다.
- **JPA**: 가장 확실한 방법은 네이티브 쿼리에 `FOR UPDATE SKIP LOCKED`를 직접
  쓰는 것. 하이버네이트는 `jakarta.persistence.lock.timeout = -2`
  (`LockOptions.SKIP_LOCKED`)를 MySQL 8 방언에서 `SKIP LOCKED`로 번역하지만,
  역시 **생성 SQL 확인이 전제**다.

```java
// ❌ BEFORE — 워커 5개가 전부 같은 10건에서 줄을 선다. 인덱스도 없어 큐 테이블 전체가 잠긴다
@Lock(LockModeType.PESSIMISTIC_WRITE)
List<Job> findTop10ByStatusOrderByCreatedAt(JobStatus status);

// ✅ AFTER — 잠긴 건 건너뛰고, 인덱스로 10건에서 스캔을 멈추고, 상태만 바꾸고 바로 커밋
@Query(value = """
        SELECT * FROM job
         WHERE status = 'PENDING'
         ORDER BY id
         LIMIT :n
           FOR UPDATE SKIP LOCKED
        """, nativeQuery = true)
List<Job> claimPending(@Param("n") int n);       // 인덱스 (status, id) 필수

@Transactional
public List<Long> claim(int n) {
    List<Job> jobs = jobRepository.claimPending(n);
    jobs.forEach(j -> j.markProcessing(workerId));   // dirty checking → UPDATE
    return jobs.stream().map(Job::getId).toList();   // 커밋 → 락 해제. 실제 처리는 이 트랜잭션 밖에서
}
```

### 3-5. 한 장으로 정리

| 도구 | 잠긴 행을 만나면 | 어울리는 상황 | 지불하는 것 |
|---|---|---|---|
| `FOR UPDATE` | 대기 (타임아웃까지) | 단건 정합성 갱신, 락 안에서 복잡한 로직 | 커넥션 점유 대기열, 폭 사고 위험 |
| `FOR UPDATE NOWAIT` | 즉시 실패 | 사용자 대면 선점 | 실패 처리·재시도 설계, 가해자는 못 고침 |
| `FOR UPDATE SKIP LOCKED` | 건너뜀 | 워커 간 작업 분배 | 결과 비결정성, 정합성 판단 불가 |
| 원자적 UPDATE | 대기 | 읽기-계산-쓰기가 한 문장으로 압축될 때 | 폭 규칙은 동일, 영속성 컨텍스트 우회 (03) |
| 낙관적 락 | (읽을 때 안 잠금) | 충돌이 드물 때 | 재시도 코드, 실패 노출 (03) |

표는 비교용이고, 선택의 문장은 이것이다 — **폭을 먼저 1로 만들고(PK/유니크
등호), 그 다음 기간을 줄이고(락 안에서 왕복·외부 호출 제거), 마지막에 대기
정책(대기/NOWAIT/SKIP LOCKED)을 고른다.**

---

## 4. JPA before/after와 안전망 — 사람의 기억에 맡기지 않는다

### 4-1. before / after

```java
// ❌ BEFORE
public interface CouponRepository extends JpaRepository<Coupon, Long> {

    // 파생 쿼리 + 비관적 락. 나가는 SQL: select ... from coupon c where c.code=? for update
    // 문제 1: coupon.code 에 인덱스가 없다 → 클러스터드 풀스캔 → 쿠폰 테이블 전체 + 모든 갭 잠금
    // 문제 2: 파생 쿼리라 SQL 이 코드에 안 보인다 → 리뷰어가 "findByCode 니까 한 건이겠지" 하고 지나간다
    // 문제 3: 락 대기 상한이 없다 → 기본 50초를 기다리며 커넥션을 쥔다
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<Coupon> findByCode(String code);
}

@Transactional
public void redeem(String code, Long userId) {
    Coupon coupon = couponRepository.findByCode(code).orElseThrow();   // 여기서 테이블이 선다
    coupon.redeem(userId);
}
```

```java
// ✅ AFTER (A) — 유니크 인덱스 + 명시적 쿼리 + 대기 상한
@Entity
@Table(name = "coupon",
       indexes = @Index(name = "ux_coupon_code", columnList = "code", unique = true))
public class Coupon { ... }
// 운영 DB 의 인덱스는 @Index 가 아니라 마이그레이션(Flyway 등)으로 만든다. @Index 는 의도를 코드에 남기는 문서 역할

public interface CouponRepository extends JpaRepository<Coupon, Long> {

    // 유니크 인덱스 등호 → EXPLAIN type=const → 레코드 락 1개(세컨더리) + 클러스터드 레코드 1개, 갭 없음
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    @Query("select c from Coupon c where c.code = :code")
    Optional<Coupon> findByCodeForUpdate(@Param("code") String code);
}
```

```java
// ✅ AFTER (B) — "락은 항상 PK 로만 건다" 규칙으로 폭 사고를 원천 차단
@Transactional
public void redeem(String code, Long userId) {
    // 1) 락 없는 일반 조회로 PK 만 얻는다 — 인덱스가 없어도 느릴 뿐, 남을 세우지 않는다(MVCC)
    Long couponId = couponRepository.findIdByCode(code).orElseThrow();

    // 2) PK 로 잠근다 — select ... where id=? for update. 실행 계획이 const 로 "고정"된다
    Coupon coupon = em.find(Coupon.class, couponId, LockModeType.PESSIMISTIC_WRITE);

    // 3) 잠근 뒤 조건을 다시 검증한다 — 1)과 2) 사이에 다른 트랜잭션이 바꿨을 수 있다
    if (coupon.isRedeemed()) throw new AlreadyRedeemedException(code);
    coupon.redeem(userId);
}
```

(B)의 가치는 **누가 나중에 인덱스를 지우거나 조건을 바꿔도 락의 폭이 1로
유지된다**는 데 있다. 폭이 코드 구조에 고정되므로 리뷰어의 기억에 의존하지
않는다. 대가는 왕복 1회 추가와 3)의 재검증 습관이다.

### 4-2. 코드 리뷰 체크리스트 — `FOR UPDATE` / `@Lock(PESSIMISTIC_WRITE)`가 보이면

```text
[ ] 1. WHERE 컬럼에 PK 또는 유니크 인덱스가 있는가?
       비유니크 인덱스면 넥스트 키 락이 잡는 범위(매치 행 + 갭)를 계산해 봤는가?
[ ] 2. PR 에 EXPLAIN 결과가 첨부돼 있는가?
       type = const / eq_ref / ref / range, key ≠ NULL, rows 가 의도한 자릿수.
       파생 쿼리·@Lock 이면 먼저 생성 SQL 을 확보한다 (p6spy / hibernate show_sql)
       — "SQL 이 안 보이는 락"은 리뷰가 불가능한 락이다
[ ] 3. 파라미터 타입 = 컬럼 타입인가? (암묵적 형변환) 컬럼에 함수·연산이 없는가?
[ ] 4. 락 보유 구간(FOR UPDATE ~ 커밋)에 외부 호출·긴 계산·불필요한 왕복이 없는가? (기간)
[ ] 5. 락 대기 상한과 실패 시 동작이 정해져 있는가? (대기 n초 / NOWAIT / SKIP LOCKED, 예외 매핑)
[ ] 6. 락 범위 회귀 테스트가 있는가? (§4-5)
```

2번이 핵심이다. `FOR UPDATE`가 붙은 쿼리는 **EXPLAIN 없이 머지하지 않는다**를
팀 규칙으로 두면([EXPLAIN 읽는 법](explain-and-slow-query-process.md)), 사고의 절대다수(인덱스 없음·형변환·선택도)가 리뷰 단계에서
걸린다. 이 규칙은 기억이 아니라 PR 템플릿의 체크박스로 고정한다.

### 4-3. 락 대기 타임아웃 — 세 층으로 상한을 건다

기본값으로 두면 §2 사슬의 ④⑤⑥이 **50초 + 30초** 동안 진행된다. 상한을 세
층에 걸고, **아래층이 위층보다 짧게** 맞춘다.

```text
① DB 락 대기    innodb_lock_wait_timeout   기본 50초 → 3~5초
                SET SESSION innodb_lock_wait_timeout = 3;
                (JDBC URL: ?sessionVariables=innodb_lock_wait_timeout=3)
                API 가 50초 기다리는 것 자체가 이미 장애다. 초과 시 그 문장만 실패한다
                (트랜잭션은 살아 있으므로 애플리케이션이 롤백/재시도를 결정한다)

② 트랜잭션      @Transactional(timeout = 5)  또는 JPA 힌트 jakarta.persistence.lock.timeout
                — MySQL 은 "WAIT n" 구문이 없어 양수 힌트가 SQL 로 안 나간다.
                  0(NOWAIT) 과 -2(SKIP LOCKED) 만 번역된다 → 실질 상한은 ①
                — PostgreSQL 은 SET LOCAL lock_timeout 이 같은 역할
                @Transactional(timeout) 은 락 대기가 아니라 트랜잭션 전체 시간을 묶는다
                → "락을 얼마나 오래 쥐느냐"(기간) 쪽의 상한

③ 커넥션 풀     HikariCP connectionTimeout  기본 30초
                여기까지 오면 이미 무관한 API 로 전파된 뒤다. 마지막 방어선이지 대책이 아니다
```

순서를 지키는 이유 — ①이 ③보다 길면, 락을 기다리는 요청이 아직 안 끝났는데
그 뒤에서 커넥션을 기다리던 요청이 먼저 실패한다. **피해가 가해보다 먼저
터지면 원인 추적이 어려워진다.**

### 4-4. 잠긴 레코드 수 확인법 — 세 개의 창

"몇 개나 잠겼나"를 추측하지 않는다. MySQL 8.0 기준 세 곳을 본다.

```sql
-- ① 지금 잡혀 있는 락 전부 (8.0+; 5.7 은 information_schema.INNODB_LOCKS)
SELECT engine_transaction_id AS trx, object_name, index_name,
       lock_type, lock_mode, lock_status, lock_data
  FROM performance_schema.data_locks
 ORDER BY trx;
-- lock_type: TABLE(IX) / RECORD
-- lock_mode: X = 넥스트 키, X,REC_NOT_GAP = 레코드만, X,GAP = 갭만, X,INSERT_INTENTION = INSERT 대기
-- lock_status: GRANTED / WAITING

-- ② 트랜잭션별 요약 — trx_rows_locked 가 테이블 행 수에 가까우면 그게 범인이다
SELECT trx_id, trx_state, trx_started,
       trx_rows_locked, trx_lock_structs, trx_query
  FROM information_schema.INNODB_TRX
 ORDER BY trx_rows_locked DESC;

-- ③ 누가 누구를 막고 있나 — 장애 중 가장 먼저 여는 창
SELECT wait_started, wait_age, locked_table, locked_index,
       blocking_trx_id, blocking_query, waiting_query,
       sql_kill_blocking_query
  FROM sys.innodb_lock_waits;
```

```text
-- SHOW ENGINE INNODB STATUS\G  의 TRANSACTIONS 섹션 — 옛날부터 쓰던 창
---TRANSACTION 421874, ACTIVE 37 sec
mysql tables in use 1, locked 1
1203442 lock struct(s), heap size 138412032, 1203441 row lock(s)   ← 이 숫자가 테이블 행 수면 폭 사고
MySQL thread id 88, query id 9127 app-server-3 ... Sending data
select * from coupon where code='SUMMER-2026' for update
```

그리고 **알림**은 누적 카운터로 건다 — `SHOW GLOBAL STATUS LIKE 'Innodb_row_lock%'`의
`Innodb_row_lock_waits`(대기 횟수)와 `Innodb_row_lock_time_avg`(평균 대기 ms)가
평소 대비 튀면 사람이 보기 전에 알람이 먼저 운다.

### 4-5. 테스트로 고정 — 락 범위 회귀 테스트

"이 `FOR UPDATE`는 한 행만 잠근다"를 테스트로 박아 두면, 누가 인덱스를 지우거나
조건을 바꿔 폭이 넓어지는 순간 CI가 잡는다. 두 커넥션을 직접 쓴다 —
`@Transactional` 테스트 안에서는 두 트랜잭션이 재현되지 않는다
([03 문서 §6-2](../03-jpa-orm/optimistic-vs-pessimistic-lock.md)). 그리고
**H2가 아니라 Testcontainers로 운영과 같은 MySQL**을 띄운다. 락 모양은 엔진마다
다르다.

```java
@Test
void forUpdate_on_code_locks_only_that_row() throws Exception {
    try (Connection holder = dataSource.getConnection();
         Connection other  = dataSource.getConnection()) {

        holder.setAutoCommit(false);
        try (var ps = holder.prepareStatement(
                "select id from coupon where code = ? for update")) {
            ps.setString(1, "SUMMER-2026");
            ps.executeQuery();                              // 락을 쥔 채 커밋하지 않는다
        }

        other.setAutoCommit(false);
        other.createStatement().execute("set session innodb_lock_wait_timeout = 1");

        // 다른 행의 갱신은 막히면 안 된다 — 막히면 폭이 1이 아니라는 뜻
        assertDoesNotThrow(() -> other.createStatement()
                .executeUpdate("update coupon set redeemed = redeemed where code = 'WINTER-2026'"));

        // 새 행의 INSERT 도 막히면 안 된다 — 막히면 갭/supremum 까지 잠겼다는 뜻
        assertDoesNotThrow(() -> other.createStatement()
                .executeUpdate("insert into coupon(code, redeemed) values ('TEST-NEW', false)"));

        other.rollback();
        holder.rollback();
    }
}
```

이 테스트는 인덱스가 사라지면 두 번째 `assertDoesNotThrow`에서
`Lock wait timeout exceeded`로 실패한다. **"PK/유니크로만 잠근다"는 규칙이
사람의 리뷰가 아니라 빨간 불로 지켜진다.**

---

## 5. 꼬리질문 대비 포인트

### "READ COMMITTED로 낮추면 이 문제가 해결되나요?"

**완화되지만 해결은 아니다.** RC에서는 ① 갭 락이 사라져 INSERT는 막히지 않고
② 서버가 WHERE를 평가한 뒤 조건에 안 맞는 행의 락을 풀어주므로 **유지되는
락은 매치된 행으로 줄어든다.** 그러나 ③ 풀스캔 자체의 비용(수백만 행 읽기)은
그대로고 ④ 스캔 중 각 행을 **잠갔다가 푸는 것**이므로, 다른 트랜잭션이 잡고
있는 행을 만나면 그 자리에서 대기한다(`UPDATE`는 세미 컨시스턴트 읽기로 이
대기를 피하지만 `SELECT ... FOR UPDATE`는 아니다) ⑤ 격리 수준은 세션·전역
설정이라 이 쿼리 하나를 위해 바꾸면 다른 모든 쿼리의 phantom 동작과 바이너리
로그 형식(ROW 필수)까지 바뀐다. **처방은 인덱스이고, RC는 기껏해야 응급
완화책**이다. "격리 수준은 광역 설정, 폭 문제는 국소 수정"이라는
[격리 수준 문서](transaction-isolation-levels.md) §4의 구분이 여기도 적용된다.

### "세컨더리 인덱스로 찾았는데 왜 PK 레코드까지 잠기나요? 커버링 인덱스면 안 잠기나요?"

락은 행이 아니라 **인덱스 레코드**에 붙고, 행의 실체는 클러스터드 리프에만
있다. 세컨더리 레코드만 잠그면 PK로 직접 오는 `UPDATE ... WHERE id = ?`가
그 행을 그냥 고친다 — 락이 뚫린다. 모든 접근 경로가 마지막에 통과하는 지점이
클러스터드 레코드이므로 그것을 잠가야 "이 행은 잠겼다"가 경로와 무관하게
성립한다. **커버링 인덱스여도 `FOR UPDATE`면 클러스터드까지 잠근다** —
북마크 룩업이 필요 없는 건 "읽기" 이야기고, `FOR UPDATE`는 갱신 의도의
선언이며 갱신은 클러스터드 레코드에서 일어나기 때문이다. (`FOR SHARE`는
배타가 아니라 커버링일 때 클러스터드까지 안 갈 수 있다 — "X 락을 걸어야 할
때"라는 단서가 정확한 표현이다.)

### "락이 걸려 있는 동안 다른 트랜잭션의 일반 SELECT는 왜 안 막히나요? 그럼 그 값을 믿어도 되나요?"

일반 SELECT는 잠금 읽기가 아니라 **MVCC 스냅샷 읽기**([MVCC](mvcc-innodb.md))라
락 큐에 서지 않는다. 그래서 풀스캔 `FOR UPDATE` 장애의 증상이 "조회는 되는데
저장이 안 된다"로 나타난다. 그 값을 **믿어도 되는 용도와 안 되는 용도**가 갈린다 — 화면 표시,
통계, 목록에는 충분하다. 그러나 **"읽은 값을 근거로 쓰기를 결정"하는 로직**
(재고 확인 후 차감, 쿠폰 상태 확인 후 사용)에는 안 된다. 읽는 순간 이미 남이
잠그고 바꾸는 중일 수 있고, 내 스냅샷은 그걸 모른다. 결정에 쓰이는 읽기는
잠금 읽기(`FOR UPDATE`)이거나, 읽기-결정-쓰기를 한 문장으로 압축한 원자적
UPDATE여야 한다. 03 문서의 "check-then-act 틈"이 DB 레벨에서 같은 얼굴로
나타난 것이다.

### "PostgreSQL에서도 같은 사고가 나나요?" (시니어 변별 포인트)

**같은 모양으로는 안 난다.** PostgreSQL의 `FOR UPDATE`는 실행 계획에서 스캔
위에 `LockRows` 노드가 올라가고, **WHERE를 통과한 행만** 잠근다(잠근 뒤 그
사이 바뀌었으면 조건을 재평가한다). 갭 락도 없다. 따라서 "인덱스 없는
`FOR UPDATE` 한 건 → 테이블 전체 락"이라는 InnoDB식 사고는 나지 않는다.
대신 다른 비용이 있다 — PostgreSQL의 행 락은 메모리 락 테이블이 아니라
**튜플 헤더(`xmax`)에 기록**되므로, 많은 행을 잠그면 그만큼 페이지가
더러워지고 WAL이 쓰인다. 그리고 **풀스캔 비용, 커밋까지의 락 보유 기간,
대기자가 커넥션을 붙잡는 구조는 완전히 동일**하다. 결론은 "함정의 모양은
엔진마다 다르지만, 규율(PK/유니크로 잠근다·짧게 쥔다·대기 상한을 건다)은
엔진과 무관하다." 엔진의 구현을 먼저 묻고 결론을 내리는 순서가 중요하다.

### "`SELECT FOR UPDATE` 대신 `UPDATE ... WHERE code = ?`로 바로 치면 이 문제가 없어지나요?" (시니어 변별 포인트)

**없어지지 않는다.** `UPDATE`와 `DELETE`도 잠금 읽기다 — 스캔한 인덱스
레코드에 X 락(RR이면 넥스트 키)을 거는 규칙이 똑같이 적용된다.
`UPDATE coupon SET ... WHERE code = ?`에 인덱스가 없으면 역시 클러스터드
풀스캔 + 전 행 락이다. 원자적 UPDATE가 `FOR UPDATE`보다 나은 것은 **폭이
아니라 기간**(왕복 1회로 락 구간이 끝난다)이고, RC에서 조건 불일치 행의
락을 풀어주는 완화도 양쪽에 같이 적용된다. **폭은 문장의 종류가 아니라
접근 경로(실행 계획)가 정한다** — 이 한 문장이 이 꼬리질문의 채점 포인트다.
그러니 `UPDATE ... WHERE status = 'PENDING'` 같은 배치 갱신도 인덱스와
청크 분할 없이 날리면 같은 사고다.

### "운영 중 '락 대기' 알림이 왔습니다. 어디부터 보나요?" (가산점 포인트)

순서를 정해 둔다. ① `sys.innodb_lock_waits`로 **가해자(blocking_trx_id,
blocking_query)와 대기 시간(wait_age)** 을 본다 — 대기자 수십 건에 가해자가
한 건이면 폭 사고 의심. ② `information_schema.INNODB_TRX`에서 그 트랜잭션의
`trx_rows_locked`를 본다 — 테이블 행 수에 가까우면 확정. ③ 그 쿼리를
`EXPLAIN` — `type=ALL`이면 원인은 인덱스. ④ 즉시 조치는 가해 트랜잭션
`KILL`(대기열이 풀린다) + 커넥션 풀 회복 확인, ⑤ 근본 조치는 인덱스 추가 또는
"조회 → PK 잠금" 구조 변경 배포, ⑥ 재발 방지는 §4-2 체크리스트와 §4-5
테스트 추가. "느려요"에서 시작해 `EXPLAIN`까지 가는 이 다섯 단계를 이름으로
말할 수 있으면 장애를 겪어 본 사람으로 읽힌다.

---

## 한 줄 요약

**`SELECT ... FOR UPDATE`는 InnoDB에서 테이블 IX 락 + 스캔한 모든 인덱스
레코드에 X 락(RR이면 갭까지 넥스트 키, 유니크 등호 단건만 예외) + 세컨더리로
찾았으면 클러스터드 레코드까지 잠그며, 락은 "찾은 행"이 아니라 "스캔한
레코드"에 걸린다. 그래서 WHERE가 인덱스를 못 타면 풀스캔 → 전 행 락 →
사실상 테이블 락 → 쓰기 전원 대기 → 커넥션 점유 → 풀 고갈 → 무관 API 전파로
한 건 잠그려다 서비스를 세운다. 처방은 폭을 1로 만드는 것(PK/유니크 등호,
또는 조회 후 PK 잠금)이고, 그것을 EXPLAIN 증빙·락 대기 상한 3층·
`data_locks` 관측·락 범위 회귀 테스트로 사람의 기억 밖에 고정한다.**
