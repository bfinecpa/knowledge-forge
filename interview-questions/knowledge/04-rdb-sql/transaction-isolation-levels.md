# 트랜잭션 격리 수준 4가지와 이상 현상 — "같은 걸 두 번 읽었는데 값이 다른" 문제의 지도

> 핵심 관전 포인트: **격리 수준은 "동시에 도는 다른 트랜잭션의 변경이
> 나에게 얼마나 보이는가"를 4단계로 정한 표준(SQL 표준)이고, 각 단계는
> 허용하는 이상 현상(dirty read / non-repeatable read / phantom read)으로
> 정의된다. 세 이상 현상의 구분 — 커밋 안 된 걸 읽음 / 같은 행의 값이
> 바뀜(UPDATE) / 행 개수가 바뀜(INSERT·DELETE) — 이 1차 변별 포인트고,
> "MySQL InnoDB는 REPEATABLE READ가 기본인데 MVCC + 갭 락으로 phantom도
> 상당 부분 막는다"는 교과서와 실제 DB의 차이, 그리고 "동시성 제어를
> 격리 수준 올리기로 풀면 안 되는 이유"까지 가면 시니어 답변이다.**

---

## 0. 질문 + 의도

**질문**: "트랜잭션 격리 수준 4가지와 각각에서 발생 가능한 문제(dirty read,
non-repeatable read, phantom read)를 설명해주세요."

**출제 의도**: 격리 수준은 "정합성 버그가 재현 안 되는 이유"의 단골 원인이다.
non-repeatable read를 모르면 "같은 트랜잭션에서 두 번 읽었는데 값이 달라요"
라는 버그 리포트 앞에서 코드만 백날 들여다본다 — 동시성 버그를 코드가 아닌
격리 수준 관점에서 진단할 수 있는지 확인하는 질문이다.

## 1. 큰 그림 — 격리 수준이란 무엇을 정하는 규칙인가

트랜잭션의 ACID 중 I(Isolation, 격리)는 "동시에 실행되는 트랜잭션들이
서로 없는 것처럼 보이게 한다"는 성질인데, 이를 완벽하게 지키면
(= 전부 순차 실행하는 것과 같게 만들면) 동시성이 죽는다. 그래서
SQL 표준은 **"완벽한 격리에서 얼마나 양보할 것인가"를 4단계로 정의**하고,
각 단계를 "이 단계에서는 이런 이상 현상까지는 일어날 수 있다"로 규정했다.

### 4단계 × 이상 현상 매트릭스 (이 표가 답변의 뼈대)

| 격리 수준 | Dirty Read | Non-Repeatable Read | Phantom Read |
|---|---|---|---|
| READ UNCOMMITTED | 발생 가능 | 발생 가능 | 발생 가능 |
| READ COMMITTED | 방지 | 발생 가능 | 발생 가능 |
| REPEATABLE READ | 방지 | 방지 | 발생 가능 |
| SERIALIZABLE | 방지 | 방지 | 방지 |

아래로 내려갈수록 격리가 강해지고(이상 현상이 줄고), 대신 동시성이
떨어진다(락을 더 오래/넓게 잡거나 스냅샷 관리 비용이 커진다).

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

B가 롤백하면 잔액 0은 **한 번도 확정된 적 없는 값**인데, A는 그걸
읽고 "잔액 부족" 판정을 내려버릴 수 있다. 가장 위험한 현상이라
READ UNCOMMITTED 빼고는 전부 막으며, 실무에서 READ UNCOMMITTED를
쓰는 경우는 사실상 없다 (PostgreSQL은 아예 이 수준을 지원하지 않고
READ UNCOMMITTED로 설정해도 READ COMMITTED로 동작한다).

### 2-2. Non-Repeatable Read — 같은 행을 두 번 읽었는데 값이 다름 (UPDATE)

```text
시간 →
Tx A                              Tx B
SELECT 잔액 WHERE id=1 → 10,000
                                  UPDATE 잔액 = 5,000 WHERE id=1
                                  COMMIT
SELECT 잔액 WHERE id=1 → 5,000   ← 같은 트랜잭션인데 값이 바뀜
```

읽은 값 자체는 둘 다 "커밋된 정상 값"이다. 문제는 **한 트랜잭션 안에서
같은 행을 다시 읽었을 때 결과가 달라진다**는 것 — "잔액 확인 후 그 값을
전제로 계산"하는 로직이 중간에 무너진다. READ COMMITTED까지는 발생하고
(커밋된 것만 읽되, 매 SELECT마다 최신 커밋을 읽으므로),
REPEATABLE READ부터 막힌다(첫 읽기 시점의 스냅샷을 트랜잭션 끝까지 유지).

### 2-3. Phantom Read — 같은 조건으로 두 번 조회했는데 행 개수가 다름 (INSERT/DELETE)

```text
시간 →
Tx A                              Tx B
SELECT * WHERE 급여 > 500 → 3건
                                  INSERT 급여=600 인 직원 추가
                                  COMMIT
SELECT * WHERE 급여 > 500 → 4건  ← 유령(phantom) 행이 나타남
```

Non-repeatable read와의 구분이 **면접 변별 포인트**다:

- **Non-repeatable read**: 이미 읽었던 **기존 행의 값**이 바뀜 → 원인은 **UPDATE**
- **Phantom read**: 같은 **조건(범위)**에 걸리는 **행의 개수**가 바뀜 → 원인은 **INSERT/DELETE**

왜 따로 구분하나 — 막는 방법이 다르기 때문이다. 기존 행의 변경은
그 **행에 락**을 걸면 막히지만, "아직 존재하지 않는 행의 INSERT"는
행 락으로는 막을 수 없다. 조건에 해당하는 **범위(갭)** 자체를 잠그거나
(갭 락), 순차 실행에 준하는 제어(SERIALIZABLE)가 필요하다.
그래서 표준에서는 REPEATABLE READ까지도 phantom은 허용된다.

## 3. 교과서 vs 실제 DB — 기본값과 InnoDB의 특수성 (시니어 변별 포인트)

### 실무 기본값

| DB | 기본 격리 수준 |
|---|---|
| MySQL (InnoDB) | **REPEATABLE READ** |
| PostgreSQL | READ COMMITTED |
| Oracle | READ COMMITTED |
| SQL Server | READ COMMITTED |

대부분 READ COMMITTED가 기본인데 MySQL만 REPEATABLE READ다.
"우리 서비스 DB의 기본 격리 수준이 뭔지 아는가"는 실무 감각을 보는
단골 확인 질문이다.

### InnoDB의 REPEATABLE READ는 교과서보다 강하다

교과서 매트릭스대로면 REPEATABLE READ에서 phantom read가 발생해야
하지만, **InnoDB는 MVCC + 갭 락으로 phantom을 상당 부분 막는다.**

- **일반 SELECT (일관된 읽기, consistent read)**: MVCC 스냅샷 —
  트랜잭션의 첫 읽기 시점 스냅샷을 끝까지 재사용하므로, 다른
  트랜잭션이 INSERT를 커밋해도 내 조회 결과에 나타나지 않는다.
  락 없이 스냅샷만으로 non-repeatable read와 phantom을 동시에 방지.
- **잠금 읽기 (SELECT ... FOR UPDATE / FOR SHARE, UPDATE/DELETE)**:
  스냅샷이 아니라 **최신 데이터**를 읽는다. 대신 조건 범위에
  **갭 락(gap lock) / 넥스트 키 락**을 걸어 그 범위로의 INSERT 자체를
  차단해 phantom을 막는다.

단, 완전 무결은 아니다. 예를 들어 같은 트랜잭션에서 일반 SELECT
(스냅샷 읽기)와 잠금 읽기(최신 읽기)를 섞어 쓰면 두 읽기가 서로 다른
세상을 보게 되어 phantom처럼 보이는 결과가 나올 수 있다. 그래서 정확한
답은 "InnoDB REPEATABLE READ는 **일관된 읽기 기준으로는** phantom이
발생하지 않지만, 잠금 읽기를 섞는 순간 이야기가 달라진다"이다 —
"표준의 정의"와 "특정 DB의 구현"을 분리해서 말하는 것 자체가 가산점.

### SERIALIZABLE의 실체

가장 강한 수준. InnoDB에서는 일반 SELECT까지 전부 공유 락을 잡는
잠금 읽기로 바뀌고, PostgreSQL은 SSI(Serializable Snapshot Isolation)로
충돌을 감지해 한쪽 트랜잭션을 **강제 실패(직렬화 오류)**시킨다.
읽기끼리도 서로를 기다리거나 죽이므로 처리량이 급감하고 데드락/재시도가
급증한다 — 일반 서비스 트래픽에서 전역으로 켜는 수준이 아니라,
정합성이 절대적인 특수 구간에 한정해서 쓰는 도구다.

## 4. 격리 수준으로 풀 문제 vs 락으로 풀 문제

격리 수준을 올리는 비용: 동시성 하락(락 대기 증가), 갭 락으로 인한
데드락 증가, 스냅샷(undo) 유지 비용. 그래서 **"격리 수준은 읽기 일관성의
기본기, 쓰기 충돌은 락으로"**가 실무 구분선이다.

전형적인 오답 시나리오 — 재고 차감 동시성 문제:

```sql
-- ❌ "SERIALIZABLE로 올리면 되지 않나?" → 전 구간 처리량 붕괴, 데드락 폭증
-- ✅ 문제가 되는 그 지점만 잠근다

-- 방법 A: 비관적 락 (그 행만 잠그고 읽기)
SELECT stock FROM item WHERE id = 1 FOR UPDATE;
UPDATE item SET stock = stock - 1 WHERE id = 1;

-- 방법 B: 원자적 UPDATE (읽기-계산-쓰기를 한 문장으로)
UPDATE item SET stock = stock - 1 WHERE id = 1 AND stock >= 1;
-- affected rows = 0 이면 재고 부족으로 처리

-- 방법 C: 낙관적 락 (버전 컬럼, 충돌 시 재시도)
UPDATE item SET stock = 9, version = version + 1
 WHERE id = 1 AND version = 5;
```

격리 수준은 "트랜잭션 전체가 세상을 얼마나 일관되게 보는가"라는
**광역 설정**이고, 재고 차감은 "이 행 하나의 갱신 충돌"이라는
**국소 문제**다. 국소 문제를 광역 설정으로 풀면 무관한 트랜잭션까지
전부 비용을 치른다 — 이 구분을 말할 수 있으면 시니어 답변이 된다.

## 5. 스프링 연결 — @Transactional(isolation = ...)

```java
@Transactional(isolation = Isolation.READ_COMMITTED)
public BalanceSummary summarize(Long accountId) { ... }
```

- 선택지: `Isolation.DEFAULT` / `READ_UNCOMMITTED` / `READ_COMMITTED` /
  `REPEATABLE_READ` / `SERIALIZABLE`
- **기본값은 `Isolation.DEFAULT`** — 스프링이 정하는 게 아니라
  **DB의 기본 격리 수준을 그대로 따른다**는 뜻이다. 즉 같은 코드가
  MySQL에서는 REPEATABLE READ로, PostgreSQL에서는 READ COMMITTED로
  돈다. "스프링 기본이 뭐냐"에 "READ_COMMITTED"라고 박아 답하면
  틀린다 — DB 기본값 위임이 정답.
- 동작 방식: 트랜잭션 시작 시 커넥션에
  `Connection.setTransactionIsolation(...)`을 호출해 그 트랜잭션
  동안만 적용하고, 끝나면 원복한다. 커넥션 풀을 공유하므로
  **트랜잭션 단위로 지정하는 이 방식이 정석**이고, DB 전역 설정을
  바꾸는 것은 전체 서비스에 영향을 주는 별개의 결정이다.
- 주의: 전파 속성으로 **기존 트랜잭션에 합류(REQUIRED로 join)하는
  경우 격리 수준 지정은 적용되지 않는다** — 격리 수준은 트랜잭션을
  새로 시작하는 쪽이 정한다. 합류하면서 다른 격리 수준을 요구하면
  기본 설정에서는 조용히 무시된다(`validateExistingTransaction`을
  켜면 예외).

---

## 6. 꼬리질문 대비 포인트

### "같은 트랜잭션에서 같은 행을 두 번 읽었는데 값이 달라요"라는 버그 리포트 — 무슨 현상이고 어떻게 확인하나?

전형적인 **non-repeatable read**이고, 격리 수준이 **READ COMMITTED
이하**일 때 가능한 현상이다(REPEATABLE READ부터는 스냅샷으로 막힘).
확인 순서: ① 그 DB/커넥션의 실제 격리 수준 확인 — MySQL은
`SELECT @@transaction_isolation`, PostgreSQL은 `SHOW transaction_isolation`.
② 코드에서 `@Transactional(isolation = ...)` 지정 여부와, 애초에
두 읽기가 **정말 같은 트랜잭션 안**인지 확인 — 트랜잭션이 없거나
(프록시 자기 호출 등으로) 끊겨서 각 SELECT가 별도 트랜잭션(auto-commit)으로
돈 것일 수도 있다. 해결은 그 로직만 REPEATABLE READ로 올리거나,
값을 다시 읽지 말고 첫 읽기 결과를 변수로 들고 가거나, 갱신 충돌이
본질이면 `FOR UPDATE`로 잠그고 읽는 것 중 요구사항에 맞는 것을 고른다.

### "MySQL REPEATABLE READ에서 phantom read가 정말 발생하나?"

일반 SELECT(일관된 읽기)만 쓰는 한 발생하지 않는다 — 첫 읽기 시점의
MVCC 스냅샷을 트랜잭션 내내 재사용하므로 다른 트랜잭션의 INSERT가
보이지 않고, 잠금 읽기(UPDATE/DELETE/`FOR UPDATE`)는 갭 락이 범위
INSERT를 차단한다. 단 예외가 있다: **같은 트랜잭션에서 스냅샷 읽기와
잠금 읽기를 섞으면** — 예컨대 SELECT로 3건을 확인한 뒤 `SELECT ...
FOR UPDATE`를 하면 후자는 최신 데이터를 읽으므로 그 사이 커밋된
4번째 행이 나타난다 — phantom처럼 보이는 결과가 나온다. 또 스냅샷은
읽기에만 적용되고 UPDATE는 최신 행에 적용되므로, 남의 커밋 행을
내가 UPDATE하면 그 행이 이후 내 스냅샷에 나타나는 케이스도 있다.
"표준 정의상 허용 / InnoDB 구현상 대부분 방지 / 잠금 읽기 혼용 시
예외"의 3단 구조로 답하면 정확하다.

### "재고 차감 동시성 문제를 SERIALIZABLE로 풀면 안 되나?"

기술적으로는 막을 수 있지만 정석이 아니다. SERIALIZABLE은 읽기까지
락을 잡거나(InnoDB) 충돌 트랜잭션을 강제 실패시키는(PostgreSQL SSI)
방식이라, 재고와 무관한 조회 트래픽까지 전부 대기/재시도 비용을
치르고 데드락이 폭증한다. 재고 차감은 "특정 행의 갱신 충돌"이라는
국소 문제이므로 국소 도구로 푼다 — 원자적 UPDATE
(`SET stock = stock - 1 WHERE ... AND stock >= 1`, affected rows로
성공 판정)가 가장 싸고, 차감 전후로 검증/부가 로직이 필요하면
`SELECT ... FOR UPDATE`(비관적 락), 충돌이 드물면 버전 컬럼 기반
낙관적 락 + 재시도. "격리 수준은 광역 설정, 쓰기 충돌은 국소 락"이
답의 뼈대다.

### "격리 수준을 실무에서 바꾸거나 확인해본 경험이 있나?"

경험 스토리를 만들 때의 뼈대: ① 운영 DB의 기본값을 실제로 확인해본
경험(`SELECT @@transaction_isolation`) — "MySQL이라 REPEATABLE READ가
기본이었다"만 말해도 실무 감각 전달. ② 배치/통계성 긴 조회에서
스냅샷 유지 비용(undo 로그 누적, purge 지연) 때문에 READ COMMITTED로
낮추는 판단, 또는 반대로 정합성이 중요한 정산 로직에서
`FOR UPDATE`를 선택한 판단처럼 **"바꿨다"보다 "왜 그 수준이면
충분했다/부족했다를 판단했다"**를 말하는 게 좋다. ③ 갭 락으로 인한
데드락 로그(`SHOW ENGINE INNODB STATUS`)를 추적해본 경험이 있다면
REPEATABLE READ의 비용을 체감으로 안다는 강한 신호가 된다.

### "스프링 @Transactional의 격리 수준 기본값은?"

`Isolation.DEFAULT` — 특정 수준이 아니라 **DB 기본값을 따른다**는
의미다. 그래서 같은 애플리케이션 코드도 MySQL(REPEATABLE READ)과
PostgreSQL(READ COMMITTED) 위에서 다른 격리 수준으로 돈다.
명시 지정 시 트랜잭션 시작 시점에 커넥션에 설정했다가 종료 시
원복하며, 이미 열린 트랜잭션에 합류하는 경우에는 적용되지 않는다.

---

## 한 줄 요약

격리 수준 4단계는 dirty read(커밋 안 된 값) / non-repeatable read
(같은 행의 값 변경, UPDATE) / phantom read(행 개수 변경, INSERT·DELETE)를
어디까지 허용하느냐의 매트릭스인데, 실제 DB는 표준과 다르게 동작하고
(MySQL 기본 REPEATABLE READ는 MVCC+갭 락으로 phantom까지 대부분 방지,
PostgreSQL/Oracle 기본은 READ COMMITTED), 스프링 `@Transactional`의
기본값은 이 DB 기본값을 그대로 따르며(ISOLATION_DEFAULT), 쓰기 충돌
같은 국소 동시성 문제는 격리 수준 올리기가 아니라 락/원자적 UPDATE로
푸는 것이 정석이다.
