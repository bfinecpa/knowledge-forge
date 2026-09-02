# 트랜잭션 격리 수준 4가지와 이상 현상 — PostgreSQL에서 "같은 걸 두 번 읽었는데 값이 다른" 문제의 지도

> 핵심 관전 포인트: **격리 수준은 "동시에 도는 다른 트랜잭션의 변경이
> 나에게 얼마나 보이는가"를 4단계로 정한 SQL 표준이고, 각 단계는 허용하는
> 이상 현상(dirty read / non-repeatable read / phantom read)으로 정의된다.
> 세 현상의 구분 — 커밋 안 된 걸 읽음 / 같은 행의 값이 바뀜(UPDATE) /
> 행 개수가 바뀜(INSERT·DELETE) — 이 1차 변별 포인트다. PostgreSQL은
> 이 표준을 **MVCC 스냅샷으로 구현한 3단계**로 제공한다 — 기본
> **READ COMMITTED**(문장마다 새 스냅샷), **REPEATABLE READ**(트랜잭션
> 스냅샷 고정 = 스냅샷 격리라 phantom까지 안 보이지만, 갱신 충돌은
> `40001`로 실패시키고 **write skew는 못 막음**), **SERIALIZABLE**(SSI —
> 락으로 막지 않고 의존성을 추적해 `40001`로 abort → **재시도 루프 필수**).
> READ UNCOMMITTED는 문법만 있고 RC로 동작한다. 여기에 "쓰기 충돌 같은
> 국소 문제를 격리 수준 올리기로 풀면 안 되는 이유"까지 가면 시니어
> 답변이다.**

---

## 0. 질문 + 의도

**질문**: "트랜잭션 격리 수준 4가지와 각각에서 발생 가능한 문제(dirty read,
non-repeatable read, phantom read)를 설명해주세요."

**출제 의도**: 격리 수준은 "정합성 버그가 재현 안 되는 이유"의 단골 원인이다.
non-repeatable read를 모르면 "같은 트랜잭션에서 두 번 읽었는데 값이 달라요"
라는 버그 리포트 앞에서 코드만 백날 들여다본다 — PostgreSQL 기본이 READ
COMMITTED라 이 현상은 **기본 설정에서 정상 동작**이다. 동시성 버그를
"스냅샷을 언제 찍는가" 관점에서 진단할 수 있는지, `40001` 직렬화 실패를
"DB 장애"가 아니라 "재시도하라는 신호"로 읽을 수 있는지 확인하는 질문이다.

## 1. 큰 그림 — 격리 수준이란 무엇을 정하는 규칙인가

ACID의 I(Isolation)는 "동시에 실행되는 트랜잭션들이 서로 없는 것처럼
보이게 한다"는 성질인데, 완벽하게 지키면(= 전부 순차 실행한 것과 같게)
동시성이 죽는다. 그래서 SQL 표준은 **"완벽한 격리에서 얼마나 양보할
것인가"를 4단계로 정의**하고, 각 단계를 "여기서는 이런 이상 현상까지는
일어날 수 있다"로 규정했다.

### 4단계 × 이상 현상 매트릭스 — SQL 표준 (이 표가 답변의 뼈대)

| 격리 수준 | Dirty Read | Non-Repeatable Read | Phantom Read |
|---|---|---|---|
| READ UNCOMMITTED | 발생 가능 | 발생 가능 | 발생 가능 |
| READ COMMITTED | 방지 | 발생 가능 | 발생 가능 |
| REPEATABLE READ | 방지 | 방지 | 발생 가능 |
| SERIALIZABLE | 방지 | 방지 | 방지 |

### 같은 표를 PostgreSQL이 실제로 구현한 모습

PostgreSQL 매뉴얼은 이 표에 열 하나를 더 붙인다 — 표준 셋으로는 설명이
안 되는 네 번째 현상, **직렬화 이상(serialization anomaly)**이다.

| 요청한 수준 | 실제 동작 | Dirty | Non-Repeatable | Phantom | 직렬화 이상 |
|---|---|---|---|---|---|
| READ UNCOMMITTED | **READ COMMITTED로 동작** | 불가 | 가능 | 가능 | 가능 |
| READ COMMITTED (**기본**) | 문장마다 새 스냅샷 | 불가 | 가능 | 가능 | 가능 |
| REPEATABLE READ | 트랜잭션 스냅샷 고정 | 불가 | 불가 | **불가**(표준보다 강함) | 가능 |
| SERIALIZABLE | SSI — 의존성 추적 후 abort | 불가 | 불가 | 불가 | 불가 |

PostgreSQL은 사실상 **3단계**다 — 커밋 안 된 튜플은 스냅샷에 절대 안
들어가므로 dirty read가 구조적으로 불가능하고, REPEATABLE READ는 표준보다
강해 phantom까지 막으며, 대신 표준에 없는 **직렬화 이상(대표 사례 write
skew)**은 SERIALIZABLE만 막는다. 세 수준의 차이는 한 문장 — **"스냅샷을
언제 찍고, 충돌을 어떻게 처리하는가."** RC는 문장마다 찍고 충돌 시 최신
행을 다시 읽는다. RR은 첫 문장에서 한 번 찍고 충돌 시 실패시킨다.
SERIALIZABLE은 RR 스냅샷 + 읽기/쓰기 의존성 추적으로 "순차 실행과 다를
가능성"까지 실패시킨다. "표준의 정의"와 "특정 DB의 구현"을 분리해 말하는
것 자체가 가산점이다.

## 2. 세 가지 이상 현상 — 두 트랜잭션의 시간 순서로 이해하기

세 현상 모두 "트랜잭션 A가 읽는 중에 트랜잭션 B가 끼어드는" 시나리오다.
차이는 **B가 무엇을 했고, A에게 무엇이 다르게 보이는가**뿐이다.

### 2-1. Dirty Read — 커밋 안 된 데이터를 읽음

```text
시간 →
Tx A                              Tx B
                                  UPDATE 잔액 = 0 (아직 커밋 안 함!)
SELECT 잔액 → 0 을 읽음  ← 더티 리드
                                  ROLLBACK (없던 일이 됨)
A는 "세상에 존재한 적 없는 값"을 근거로 로직을 진행
```

B가 롤백하면 잔액 0은 **한 번도 확정된 적 없는 값**인데, A는 그걸 읽고
"잔액 부족" 판정을 내려버릴 수 있다. 가장 위험한 현상이라 표준도 READ
UNCOMMITTED에서만 허용한다. **PostgreSQL에서는 원천적으로 불가능하다** —
B가 만든 새 튜플 버전의 `xmin`은 아직 커밋되지 않은 B의 트랜잭션 ID라
A의 스냅샷이 걸러낸다([MVCC 문서](11-mvcc-postgresql.md)). 그래서 READ
UNCOMMITTED를 요청해도 조용히 READ COMMITTED로 돈다.

### 2-2. Non-Repeatable Read — 같은 행을 두 번 읽었는데 값이 다름 (UPDATE)

```text
시간 →
Tx A (READ COMMITTED)             Tx B
SELECT 잔액 WHERE id=1 → 10,000   ← 문장 1의 스냅샷
                                  UPDATE 잔액 = 5,000 WHERE id=1
                                  COMMIT
SELECT 잔액 WHERE id=1 → 5,000    ← 문장 2의 새 스냅샷: B의 커밋이 보임
```

읽은 값 자체는 둘 다 "커밋된 정상 값"이다. 문제는 **한 트랜잭션 안에서
같은 행을 다시 읽었을 때 결과가 달라진다**는 것 — "잔액 확인 후 그 값을
전제로 계산"하는 로직이 중간에 무너진다. PostgreSQL 기본인 READ
COMMITTED는 **문장(statement)마다 스냅샷을 새로 찍으므로** 이 현상이
그대로 일어난다 — 버그가 아니라 사양이다. REPEATABLE READ는 첫 문장의
스냅샷을 끝까지 재사용하므로 두 번째 SELECT도 10,000을 돌려준다.

### 2-3. Phantom Read — 같은 조건으로 두 번 조회했는데 행 개수가 다름 (INSERT/DELETE)

```text
시간 →
Tx A (READ COMMITTED)             Tx B
SELECT * WHERE 급여 > 500 → 3건
                                  INSERT 급여=600 인 직원 추가
                                  COMMIT
SELECT * WHERE 급여 > 500 → 4건  ← 유령(phantom) 행이 나타남
```

Non-repeatable read와의 구분이 **면접 변별 포인트**다:

- **Non-repeatable read**: 이미 읽었던 **기존 행의 값**이 바뀜 → 원인은 **UPDATE**
- **Phantom read**: 같은 **조건(범위)**에 걸리는 **행의 개수**가 바뀜 → 원인은 **INSERT/DELETE**

왜 따로 구분하나 — **락으로 막으려 하면 난이도가 다르기** 때문이다. 기존
행의 변경은 그 **행에 락**을 걸면 막히지만, "아직 존재하지 않는 행의
INSERT"는 행 락으로 막을 수 없다. 그래서 표준은 REPEATABLE READ까지도
phantom을 허용했다. PostgreSQL은 이 문제를 락이 아니라 **스냅샷**으로
우회한다 — REPEATABLE READ에서는 B의 INSERT가 커밋돼도 A의 스냅샷보다
나중이라 보이지 않는다. 대신 PG에는 **존재하지 않는 행/범위를 잠그는 수단
자체가 없다**(갭 락 없음). "조회해서 없으면 INSERT" 경쟁은 격리 수준이
아니라 UNIQUE 제약 + `ON CONFLICT`, advisory lock, 또는 SERIALIZABLE의
몫이다([갭 락 문서](12-gap-lock-next-key-lock-deadlock.md)).

> MySQL 대조: InnoDB는 반대로 **락으로** 푼다 — 잠금 읽기(`FOR UPDATE`,
> UPDATE/DELETE)가 조건 범위에 갭 락·넥스트 키 락을 걸어 INSERT를 차단한다.
> phantom 방지의 대가가 PG는 스냅샷 유지 비용, MySQL은 락 대기·데드락이다.

### 2-4. (가산점 포인트) 네 번째 현상 — Write Skew: 각자 다른 행을 고쳤는데 규칙이 깨진다

규칙: **"당직 의사는 항상 1명 이상."** 현재 Alice, Bob 둘 다 당직 중.

```text
시간 →
Tx A (Alice, REPEATABLE READ)              Tx B (Bob, REPEATABLE READ)
SELECT count(*) WHERE on_call → 2
  ("나 빠져도 1명 남네")
                                           SELECT count(*) WHERE on_call → 2
                                             ("나 빠져도 1명 남네")
UPDATE doctors SET on_call = false
 WHERE name = 'Alice'
                                           UPDATE doctors SET on_call = false
                                            WHERE name = 'Bob'
COMMIT                                     COMMIT
결과: 당직 0명. 두 트랜잭션 모두 각자의 스냅샷 안에서는 완벽하게 옳았다.
```

Non-repeatable도 phantom도 아니다 — 읽은 값은 끝까지 안 변했고 행이
나타나거나 사라지지도 않았다. **서로 다른 행을 갱신했기 때문에 REPEATABLE
READ의 갱신 충돌 감지(3-2)에도 안 걸린다.** 그런데 순차 실행이었다면 두
번째 트랜잭션은 count=1을 보고 멈췄어야 한다 — 이것이 "순차 실행과
결과가 다른" 직렬화 이상이고, DB 차원에서 막는 것은 **SERIALIZABLE뿐**
이다(3-3). 격리 수준을 안 올린다면 두 트랜잭션이 **같은 행**을 두고
경쟁하게 만들어야 한다 — 병동 행에 `FOR UPDATE`, 또는
`pg_advisory_xact_lock(병동ID)`.

## 3. 교과서 vs PostgreSQL — 기본값과 세 수준의 실체 (시니어 변별 포인트)

### 실무 기본값

| DB | 기본 격리 수준 |
|---|---|
| **PostgreSQL** | **READ COMMITTED** |
| Oracle | READ COMMITTED |
| SQL Server | READ COMMITTED |
| MySQL (InnoDB) | REPEATABLE READ (예외) |

"우리 서비스 DB의 기본 격리 수준이 뭔지 아는가"는 실무 감각을 보는 단골
확인 질문 — PostgreSQL이라면 `SHOW transaction_isolation;`(현재 트랜잭션),
`SHOW default_transaction_isolation;`(세션 기본값)으로 확인한다.

### 3-1. READ COMMITTED — 문장마다 새 스냅샷, 갱신은 최신 버전을 다시 읽는다

SELECT는 **문장 시작 시점**의 스냅샷을 쓴다 — 문장 하나가 아무리 오래
돌아도 그 안에서는 일관되고, 다음 문장은 새 스냅샷이다. 쓰기에는 규칙이
하나 더 있다: UPDATE/DELETE/`FOR UPDATE`가 찾은 행을 **다른 트랜잭션이
갱신 중**이면 끝날 때까지 기다렸다가, 커밋됐으면 **최신 버전으로 WHERE를
재평가해** 여전히 맞으면 그 버전에 적용한다.

```sql
-- ✅ 원자적 UPDATE: RC에서도 유실되지 않는다 (stock = 10, A·B 동시 실행)
UPDATE item SET stock = stock - 1 WHERE id = 1;
-- B는 A의 커밋을 기다렸다가 최신 버전(9)을 읽어 8로 만든다. 결과 8.

-- ❌ 읽고-계산하고-쓰기: RC에서 갱신 유실(lost update)
-- A: SELECT stock → 10             B: SELECT stock → 10
-- A: UPDATE ... SET stock = 9      B: (대기 후) UPDATE ... SET stock = 9
-- 결과 9. 차감 한 건이 사라졌다. WHERE id = 1은 여전히 참이라 재평가도 못 잡는다.
```

RC는 **문장 안**의 정합성만 보장하고, **문장 사이**에 애플리케이션이 들고
있는 값은 모른다 — 4절의 "한 문장으로 넣어라"가 RC 기본에서 제일 싼
처방인 이유다.

### 3-2. REPEATABLE READ — 스냅샷 격리: phantom은 없지만 충돌은 실패로 돌려준다

트랜잭션의 **첫 번째 문장**(BEGIN이 아니라 첫 SELECT/UPDATE) 시점에
스냅샷을 찍고 끝까지 재사용한다. 교과서보다 강한 이유는 "락을 더
잡아서"가 아니라 **"세상을 한 시점에 고정해서"**다 — 학계 이름은
**스냅샷 격리(Snapshot Isolation)**다.

쓰기에는 **"먼저 커밋한 쪽이 이긴다(first-committer-wins)"** 규칙이
붙는다. 내 스냅샷 이후에 남이 갱신·커밋한 행을 내가 UPDATE/DELETE/
`FOR UPDATE`하려 하면, RC처럼 다시 읽는 게 아니라 **트랜잭션을 실패시킨다**:

```text
ERROR:  could not serialize access due to concurrent update
SQLSTATE 40001 (serialization_failure)
```

위의 read-modify-write를 RR로 돌리면 B의 UPDATE가 이 에러로 죽는다 —
갱신 유실이 "조용히 발생"에서 "명시적 실패"로 바뀌고, 대가는
**애플리케이션의 재시도**다(5절). 한계 둘: ① 서로 **다른 행**을 갱신하는
write skew(2-4)는 못 잡는다 — 스냅샷 격리의 유명한 구멍. ② 스냅샷을 오래
붙들면 그 사이 생긴 죽은 튜플을 VACUUM이 못 치운다
(`pg_stat_activity.backend_xmin`이 잡고 있다) — 리포트성 롱 트랜잭션을
RR로 돌릴 때의 비용은 락이 아니라 **bloat**다
([롱 트랜잭션 문서](16-long-transaction-harm-and-shortening.md)).

> MySQL 대조: InnoDB RR은 UPDATE를 **최신 버전에 조용히 적용**하고 `40001`
> 같은 실패가 없다 — 그래서 일반 SELECT(스냅샷)와 잠금 읽기(최신)를 섞으면
> phantom처럼 보이는 결과가 난다. PG RR은 그 순간을 에러로 드러낸다.

### 3-3. SERIALIZABLE — SSI: 락 대신 "의존성 추적 + abort"

교과서의 SERIALIZABLE은 "읽는 것마다 공유 락"이라 처리량이 붕괴하는데,
PostgreSQL은 **SSI(Serializable Snapshot Isolation)**를 쓴다. RR과 같은
스냅샷 위에서 돌되, 각 트랜잭션이 **무엇을 읽었는지를 predicate lock**으로
기록한다(`pg_locks`의 `SIReadLock` — 이름에 lock이 붙었지만 **아무도 막지
않는 표식**이다). "A가 읽은 것을 B가 고치고, B가 읽은 것을 A가 고쳤다"
같은 읽기/쓰기 의존성이 **순차 실행으로 설명 불가능한 모양**이 되는 순간
한쪽을 실패시킨다:

```text
ERROR:  could not serialize access due to read/write dependencies among transactions
SQLSTATE 40001 (serialization_failure)
```

2-4의 당직 예시가 정확히 이렇게 잡힌다. 알아 둘 성질 넷: ① **블로킹이
없다** — 기다리게 하는 대신 죽이므로 데드락 대신 **재시도**가 운영의
핵심이고, 재시도 루프 없는 SERIALIZABLE은 "가끔 실패하는 DB"일 뿐이다.
② **관련 트랜잭션 전부가 SERIALIZABLE이어야** 보장된다. ③ **오탐이 있다**
— predicate lock이 메모리 한도(`max_pred_locks_per_transaction`)를 넘으면
튜플 → 페이지 → 테이블 단위로 뭉뚱그려져 실제 충돌이 아닌데도 abort될 수
있다. ④ 비용은 읽기 락 방식보다 훨씬 싸고, 가산점으로 순수 조회는
`BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE`로 열면 안전한
스냅샷을 잠깐 기다린 뒤 **실패 가능성 0으로** 돈다(긴 리포트에 적합).

> MySQL 대조: InnoDB SERIALIZABLE은 모든 일반 SELECT를 `FOR SHARE`로 바꿔
> 읽기끼리도 기다리고 데드락이 급증한다. MySQL에서 "사실상 금기"인 수준이
> PG에서는 "재시도만 갖추면 쓸 수 있는 도구"다.

### 3-4. 수준을 지정하고 확인하는 법

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;   -- 첫 문장 전에 지정 (스냅샷을 찍은 뒤엔 에러)
-- 또는 BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SHOW transaction_isolation;              -- 현재 트랜잭션의 수준
COMMIT;
ALTER ROLE report_user SET default_transaction_isolation = 'repeatable read';  -- 롤 기본값
```

## 4. 격리 수준으로 풀 문제 vs 락으로 풀 문제

격리 수준을 올리는 비용을 PG 기준으로 적으면 — RR: 롱 스냅샷의 bloat와
갱신 충돌 `40001` 재시도. SERIALIZABLE: predicate lock 메모리, 오탐 포함
`40001` 재시도, 처리량 하락. 그래서 **"격리 수준은 읽기 일관성의 기본기,
쓰기 충돌은 락 또는 한 문장으로"**가 실무 구분선이다.

전형적인 오답 시나리오 — 재고 차감 동시성 문제:

```sql
-- ❌ "SERIALIZABLE로 올리면 되지 않나?" → 재고와 무관한 트랜잭션까지
--    의존성 추적 대상이 되고, 피크 때 40001 재시도가 폭증한다
-- ✅ 문제가 되는 그 행만 다룬다

-- 방법 A: 원자적 UPDATE (읽기-계산-쓰기를 한 문장으로) — 가장 싸다
UPDATE item SET stock = stock - 1
 WHERE id = $1 AND stock >= 1
RETURNING stock;
-- 반환 행이 없으면 재고 부족. RC에서도 유실 없음(3-1).

-- 방법 B: 비관적 락 (그 행만 잠그고 읽은 뒤 검증·부가 로직)
SELECT stock FROM item WHERE id = $1 FOR NO KEY UPDATE;
UPDATE item SET stock = stock - 1 WHERE id = $1;
-- FOR UPDATE가 아니라 FOR NO KEY UPDATE인 이유: 키를 안 바꾸는 갱신이라
-- 이 행을 참조하는 자식 INSERT(FK의 KEY SHARE)를 막지 않는다 (가산점)

-- 방법 C: 낙관적 락 (버전 컬럼, 충돌 시 재시도) — JPA @Version이 만드는 문장
UPDATE item SET stock = 9, version = version + 1
 WHERE id = $1 AND version = 5;
-- 갱신 0건이면 누가 먼저 바꾼 것 → 다시 읽고 재시도
```

격리 수준은 "트랜잭션 전체가 세상을 얼마나 일관되게 보는가"라는 **광역
설정**이고, 재고 차감은 "이 행 하나의 갱신 충돌"이라는 **국소 문제**다.
국소 문제를 광역 설정으로 풀면 무관한 트랜잭션까지 비용을 치른다 — 이
구분을 말할 수 있으면 시니어 답변이 된다. 반대로 **SERIALIZABLE이 맞는
자리**도 있다: 2-4처럼 불변식이 **여러 행에 걸쳐** "어느 행을 잠가야
하는지" 자체가 애매하고, 트랜잭션이 짧고, 재시도가 가능한 곳.

### 세 수준의 선택 기준 (암기)

| 상황 | 수준 | 이유 |
|---|---|---|
| 일반 OLTP 대부분 | READ COMMITTED (기본) | 문장 단위 일관성 + 원자적 UPDATE/행 락으로 충분 |
| 여러 문장이 **같은 시점**을 봐야 하는 조회(리포트·정산 검증 — `pg_dump`도 이 수준) | REPEATABLE READ | 스냅샷 고정. 오래 붙들면 bloat |
| 불변식이 여러 행에 걸치고 락으로 표현이 어려움 | SERIALIZABLE + 재시도 | write skew까지 DB가 잡아 줌 |

## 5. 스프링 연결 — @Transactional(isolation = ...) 과 40001 재시도

```java
@Transactional(isolation = Isolation.REPEATABLE_READ, readOnly = true)
public SettlementReport summarize(LocalDate day) { ... }
```

- 선택지: `Isolation.DEFAULT` / `READ_UNCOMMITTED` / `READ_COMMITTED` /
  `REPEATABLE_READ` / `SERIALIZABLE`
- **기본값은 `Isolation.DEFAULT`** — 스프링이 정하는 게 아니라 **DB의 기본
  격리 수준을 그대로 따른다**는 뜻이다. PostgreSQL 위에서는 READ
  COMMITTED, 같은 코드가 MySQL 위에서는 REPEATABLE READ로 돈다. "스프링
  기본이 뭐냐"에 "READ_COMMITTED"라고 박아 답하면 틀린다.
  `READ_UNCOMMITTED`를 지정해도 PG에서는 RC로 동작한다.
- 동작 방식: 트랜잭션 시작 시 `Connection.setTransactionIsolation(...)`을
  호출하면 pgjdbc가 격리 수준 설정 SQL(`SET ... TRANSACTION ISOLATION
  LEVEL ...`)을 보내고, 끝나면 스프링이 원래 값으로 원복한다. HikariCP
  풀을 공유하므로 **트랜잭션 단위로 지정하는 이 방식이 정석**이다. 풀
  전체 기본(HikariCP `transactionIsolation`)이나 롤 기본
  (`default_transaction_isolation`)은 전체 서비스에 영향을 주는 별개의
  결정이다.
- 주의: **기존 트랜잭션에 합류(REQUIRED로 join)하는 경우 격리 수준 지정은
  적용되지 않는다** — 격리 수준은 트랜잭션을 새로 시작하는 쪽이 정한다
  (PG도 첫 문장 이후엔 바꿀 수 없다). 다른 수준을 요구하며 합류하면 기본
  설정에서는 조용히 무시된다(`validateExistingTransaction`을 켜면 예외).

### 40001은 예외가 아니라 "다시 하라"는 신호 — 재시도는 트랜잭션 밖에서

RR·SERIALIZABLE을 쓰는 순간 `40001`은 정상 운영의 일부다. 스프링 예외
번역은 PostgreSQL SQLSTATE `40001`을 `CannotSerializeTransactionException`,
데드락 `40P01`을 `DeadlockLoserDataAccessException`으로 바꾸며 둘 다
`PessimisticLockingFailureException` → `TransientDataAccessException`
(재시도하면 성공할 수 있는 일시적 실패) 계열이다. JPA 경로에서는 번역이
달라질 수 있으니 **원인 체인의 SQLSTATE로 판단**하는 게 가장 견고하다.

```java
// ❌ 트랜잭션 안에서 잡고 그 자리에서 재시도 — PG에서는 통하지 않는다.
//    에러가 난 트랜잭션은 이미 abort 상태라 이후 문장이 전부
//    "current transaction is aborted, commands ignored until end of
//     transaction block" (25P02) 로 거부된다. 재시도 단위는 항상 트랜잭션 전체.

// ✅ 트랜잭션 경계 바깥에서, 매 시도마다 새 트랜잭션으로 (spring-retry)
@Retryable(retryFor = CannotSerializeTransactionException.class,
           maxAttempts = 3, backoff = @Backoff(delay = 50, multiplier = 2))
public void transferWithRetry(...) {
    transferService.transfer(...);   // 이 안이 @Transactional(SERIALIZABLE)
}
// 같은 빈의 자기 호출이면 프록시를 안 타므로 재시도 메서드는 다른 빈에 둔다.
// 재시도 대상은 멱등해야 한다(외부 API 호출·이벤트 발행은 트랜잭션 밖으로).
```

---

## 6. 꼬리질문 대비 포인트

### "같은 트랜잭션에서 같은 행을 두 번 읽었는데 값이 달라요"라는 버그 리포트 — 무슨 현상이고 어떻게 확인하나?

전형적인 **non-repeatable read**이고, PostgreSQL 기본인 READ COMMITTED
에서는 **정상 동작**이다. 확인 순서: ① 실제 격리 수준 —
`SHOW transaction_isolation;`, 롤/DB 기본값이 덮어씌워져 있는지
`SHOW default_transaction_isolation;`. ② 두 읽기가 **정말 같은 트랜잭션
안**인지 — 트랜잭션이 없거나(프록시 자기 호출, `@Transactional` 누락)
끊겨서 각 SELECT가 auto-commit으로 따로 돈 것일 수 있다. 운영 중이면
`pg_stat_activity.xact_start`가 두 문장 사이에 바뀌는지로 확인한다.
③ 해결은 요구사항에 따라 — 그 로직만 `REPEATABLE_READ`로 올리거나(재시도
준비), 첫 읽기 결과를 변수로 들고 가거나, 갱신 충돌이 본질이면
`FOR NO KEY UPDATE`로 잠그고 읽는다.

### "PostgreSQL REPEATABLE READ에서 phantom read가 정말 발생하지 않나?"

발생하지 않는다 — 첫 문장 시점의 스냅샷을 끝까지 쓰므로 다른 트랜잭션의
INSERT/DELETE 커밋이 보이지 않고, 잠금 읽기를 섞어도 "안 보이던 행이
갑자기 보이는" 일은 없다(대신 내 스냅샷 이후 남이 갱신한 행을 건드리면
`40001`). 단 둘을 덧붙여야 정확하다: ① **"안 보인다"와 "없다"는 다르다**
— `FOR UPDATE`로 행이 없음을 확인하고 INSERT하는 패턴은 남이 같은 키를
이미 커밋했어도 내 스냅샷에 안 보일 뿐이라 UNIQUE 위반으로 터진다.
존재하지 않는 행은 PG에서 잠글 수 없으므로 이 경쟁은 UNIQUE +
`ON CONFLICT`나 advisory lock으로 푼다. ② 서로 다른 행을 고치는 write
skew는 phantom과 별개 현상이고 RR로는 못 막는다. "표준 정의상 허용 / PG
스냅샷 구현상 불가 / 대신 40001과 write skew"의 3단 구조로 답한다.

### "재고 차감 동시성 문제를 SERIALIZABLE로 풀면 안 되나?"

기술적으로는 막을 수 있지만 정석이 아니다. 재고와 무관한 조회·갱신까지
predicate lock 비용과 `40001` 재시도 확률을 떠안고, 피크 때 재시도가
재시도를 부르는 악순환이 생긴다. 재고 차감은 "특정 행의 갱신 충돌"이라는
국소 문제이므로 국소 도구로 푼다 — 원자적 UPDATE(`... AND stock >= 1
RETURNING stock`)가 가장 싸고 RC 기본에서 그대로 안전하며, 검증/부가
로직이 필요하면 `FOR NO KEY UPDATE`, 충돌이 드물면 `@Version` 낙관적 락 +
재시도. "격리 수준은 광역 설정, 쓰기 충돌은 국소 락 또는 한 문장"이 답의
뼈대다.

### "REPEATABLE READ면 충분해 보이는데, SERIALIZABLE이 꼭 필요한 경우는?" (시니어 변별 포인트)

**불변식이 여러 행에 걸쳐 있을 때**다. RR의 충돌 감지는 "같은 행을 두
트랜잭션이 갱신"할 때만 작동하므로, 당직 의사(2-4)·"계좌 두 개의 합이 0
이상"처럼 **각자 다른 행을 쓰면서 공통 조건을 읽는** 패턴은 통과시킨다.
선택지는 셋 — ① 경쟁을 같은 행으로 모은다(부모 행 `FOR UPDATE`,
`pg_advisory_xact_lock`): 잠글 대상이 분명할 때 가장 예측 가능. ② 제약으로
박는다(합계 컬럼 + CHECK, 겹침 금지는 `EXCLUDE`): 표현 가능할 때 가장
싸다. ③ SERIALIZABLE + 재시도: 불변식이 복잡하거나 잠글 행이 애매할 때.
트레이드오프는 "①·②는 사람이 충돌 지점을 다 알아야 하고, ③은 몰라도
되지만 재시도 인프라와 짧은 트랜잭션이 전제"다.

### "격리 수준을 실무에서 바꾸거나 확인해본 경험이 있나?"

경험 스토리의 뼈대: ① 운영 DB 기본값을 실제로 확인한 경험
(`SHOW default_transaction_isolation`) — "PostgreSQL이라 READ COMMITTED가
기본이었고, 여러 문장에 걸친 조회는 같은 시점을 본다는 보장이 없다는 걸
전제로 코드를 봤다"만 말해도 실무 감각이 전달된다. ② 정산·리포트처럼
여러 SELECT가 같은 시점을 봐야 하는 로직을 `REPEATABLE_READ + readOnly`로
올리되, 배치가 길어지자 `backend_xmin`이 VACUUM을 막아 `n_dead_tup`이
쌓이는 걸 보고 청크로 쪼갠 판단 — **"바꿨다"보다 "왜 그 수준이면
충분했다/부족했다를 판단했다"**가 핵심. ③ `40001` 로그를 집계해 재시도
성공률과 충돌 지점을 본 경험이 있다면 SERIALIZABLE의 비용을 체감으로
안다는 강한 신호다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **기본값** — MySQL은 REPEATABLE READ, PG는 READ
COMMITTED. 같은 스프링 코드의 `Isolation.DEFAULT`가 다른 수준으로 돈다.
② **phantom을 막는 방식** — InnoDB RR은 잠금 읽기에 갭 락·넥스트 키 락을
걸어 범위 INSERT를 차단하고, PG RR은 스냅샷으로 안 보이게 할 뿐 범위를
잠그지 못한다. 그래서 "없으면 INSERT" 경쟁의 해법이 MySQL은 `FOR UPDATE`
(갭 락), PG는 UNIQUE + `ON CONFLICT`/advisory lock으로 갈린다. ③ **갱신
충돌의 처리** — InnoDB RR은 남이 갱신한 행에 내 UPDATE를 조용히 최신
버전에 적용하지만, PG RR은 `40001`로 실패시킨다(first-committer-wins).
PG에서 RR을 쓰는 순간 재시도가 필수인 이유다. ④ **SERIALIZABLE의 실체** —
InnoDB는 모든 SELECT에 공유 락(읽기끼리 대기, 데드락 급증), PG는 SSI
(블로킹 없이 abort). ⑤ **롱 스냅샷의 비용** — InnoDB는 언두 로그 누적·
퍼지 지연, PG는 VACUUM이 못 치우는 bloat와 `backend_xmin`. 이 다섯을
짚으면 "한쪽만 써봤다"가 아니라 "차이를 원리로 이해했다"로 들린다.

---

## 한 줄 요약

**격리 수준 4단계는 dirty read(커밋 안 된 값) / non-repeatable read(같은
행의 값 변경, UPDATE) / phantom read(행 개수 변경, INSERT·DELETE)를
어디까지 허용하느냐의 표준 매트릭스인데, PostgreSQL은 이를 MVCC 스냅샷으로
구현한 3단계로 제공한다 — 기본 READ COMMITTED는 문장마다 스냅샷을 새로
찍고, REPEATABLE READ는 트랜잭션 스냅샷을 고정해 phantom까지 막되 갱신
충돌은 `40001`로 실패시키며 write skew는 못 막고, SERIALIZABLE은 SSI로
의존성을 추적해 블로킹 없이 abort하므로 재시도 루프가 필수다. 스프링
`@Transactional`의 기본값은 DB 기본값 위임(`Isolation.DEFAULT`)이라 PG에서는
RC로 돌고, 재고 차감 같은 국소 쓰기 충돌은 격리 수준 올리기가 아니라
원자적 UPDATE·`FOR NO KEY UPDATE`·낙관적 락으로 푸는 것이 정석이다.**
