# 트랜잭션 격리 수준 4가지와 이상 현상 — 매트릭스 암기가 아니라 "무엇이 끼어들어 무엇이 달라 보이는가"로 답하기

> 핵심 관전 포인트: **격리 수준은 "동시에 도는 다른 트랜잭션의 변경이
> 나에게 얼마나 보이는가"를 4단계(READ UNCOMMITTED → READ COMMITTED →
> REPEATABLE READ → SERIALIZABLE)로 정한 SQL 표준이고, 각 단계는 허용하는
> 이상 현상으로 정의된다. 세 이상 현상의 구분 — dirty read(커밋 안 된
> 값을 읽음) / non-repeatable read(같은 행의 값이 바뀜, 원인은 UPDATE) /
> phantom read(조건에 걸리는 행 개수가 바뀜, 원인은 INSERT·DELETE) — 이
> 1차 변별 포인트다. 스프링에서는 `@Transactional(isolation = ...)`로
> 트랜잭션 단위 지정이 가능한데, 기본값 `Isolation.DEFAULT`는 특정 수준이
> 아니라 "DB 기본값을 그대로 따른다"는 뜻이고(MySQL은 REPEATABLE READ,
> PostgreSQL은 READ COMMITTED), 기존 트랜잭션에 합류(REQUIRED join)하는
> 경우에는 지정해도 적용되지 않는다는 것까지 말하면 실무 답변이 된다.**

---

## 0. 질문 + 의도

**질문**: "트랜잭션 격리 수준 4가지와 각각에서 발생 가능한 문제(dirty
read, non-repeatable read, phantom read)를 설명해주세요."

**출제 의도**: 격리 수준은 "정합성 버그가 재현 안 되는 이유"의 단골
원인이다. non-repeatable read를 모르면 "같은 트랜잭션에서 두 번 읽었는데
값이 달라요"라는 버그 리포트 앞에서 코드만 백날 들여다본다 — 동시성
버그를 코드가 아니라 격리 수준 관점에서 진단할 수 있는지 확인하는
질문이다.

## 1. 격리 수준이란 — "완벽한 격리에서 얼마나 양보할 것인가"의 4단계

트랜잭션의 ACID 중 I(Isolation, 격리)는 "동시에 실행되는 트랜잭션들이
서로 없는 것처럼 보이게 한다"는 성질이다. 이걸 완벽하게 지키려면 사실상
트랜잭션을 한 줄로 세워 순차 실행해야 하는데, 그러면 동시성이 죽는다.
그래서 SQL 표준은 **"어떤 이상 현상까지는 허용할 것인가"를 4단계로
정의**했다. 격리 수준의 정의 자체가 이상 현상의 허용 여부다.

### 4단계 × 이상 현상 매트릭스 (답변의 뼈대)

| 격리 수준 | Dirty Read | Non-Repeatable Read | Phantom Read |
|---|---|---|---|
| READ UNCOMMITTED | 발생 가능 | 발생 가능 | 발생 가능 |
| READ COMMITTED | 방지 | 발생 가능 | 발생 가능 |
| REPEATABLE READ | 방지 | 방지 | 발생 가능 |
| SERIALIZABLE | 방지 | 방지 | 방지 |

아래로 갈수록 격리가 강해지고(이상 현상이 줄고), 대신 동시성이
떨어진다 — 락을 더 오래·넓게 잡거나 스냅샷 관리 비용이 커진다.
즉 격리 수준 선택은 **정합성과 동시성의 트레이드오프**다.

## 2. 세 가지 이상 현상 — "B가 무엇을 했고, A에게 무엇이 달라 보이는가"

세 현상 모두 "트랜잭션 A가 읽는 중에 트랜잭션 B가 끼어드는" 시나리오다.
표를 외우는 것보다 이 시간 순서를 그릴 수 있어야 면접에서 무너지지 않는다.

### 2-1. Dirty Read — 커밋 안 된 데이터를 읽음

```text
시간 →
Tx A                              Tx B
                                  UPDATE 잔액 = 0  (아직 커밋 안 함!)
SELECT 잔액 → 0 을 읽음   ← 더티 리드
                                  ROLLBACK  (없던 일이 됨)
A는 "세상에 존재한 적 없는 값"을 근거로 로직을 진행
```

B가 롤백하면 잔액 0은 **한 번도 확정된 적 없는 값**인데, A는 그걸 읽고
"잔액 부족" 같은 판정을 내려버릴 수 있다. 가장 위험한 현상이라
READ UNCOMMITTED를 빼고는 전부 막으며, 실무에서 READ UNCOMMITTED를
쓰는 경우는 사실상 없다(PostgreSQL은 이 수준을 아예 지원하지 않고,
설정해도 READ COMMITTED로 동작한다).

### 2-2. Non-Repeatable Read — 같은 행을 두 번 읽었는데 값이 다름 (원인: UPDATE)

```text
시간 →
Tx A                              Tx B
SELECT 잔액 WHERE id=1 → 10,000
                                  UPDATE 잔액 = 5,000 WHERE id=1
                                  COMMIT
SELECT 잔액 WHERE id=1 → 5,000   ← 같은 트랜잭션 안인데 값이 바뀜
```

두 번 다 "커밋된 정상 값"을 읽었다는 게 포인트다. 문제는 **한 트랜잭션
안에서 같은 행을 다시 읽었을 때 결과가 달라진다**는 것 — "잔액을 확인한
뒤 그 값을 전제로 계산"하는 로직이 중간에 무너진다. READ COMMITTED까지는
발생하고(커밋된 것만 읽되 매 SELECT마다 최신 커밋을 읽으므로),
REPEATABLE READ부터 막힌다(첫 읽기 시점의 스냅샷을 트랜잭션 끝까지 유지).

### 2-3. Phantom Read — 같은 조건으로 두 번 조회했는데 행 개수가 다름 (원인: INSERT/DELETE)

```text
시간 →
Tx A                              Tx B
SELECT * WHERE 급여 > 500 → 3건
                                  INSERT 급여=600 인 직원 추가
                                  COMMIT
SELECT * WHERE 급여 > 500 → 4건  ← 유령(phantom) 행이 나타남
```

non-repeatable read와의 구분이 **면접 1차 변별 포인트**다:

- **Non-repeatable read**: 이미 읽었던 **기존 행의 값**이 바뀜 → 원인은 **UPDATE**
- **Phantom read**: 같은 **조건(범위)에 걸리는 행의 개수**가 바뀜 → 원인은 **INSERT/DELETE**

왜 굳이 따로 구분하나 — **막는 방법이 다르기 때문**이다. 기존 행의
변경은 그 행에 락을 걸면 막히지만, "아직 존재하지 않는 행의 INSERT"는
행 락으로 막을 수 없다. 조건에 해당하는 범위 자체를 잠그거나(갭 락),
순차 실행에 준하는 제어(SERIALIZABLE)가 필요하다. 그래서 표준에서는
REPEATABLE READ까지도 phantom은 허용된다. 이 "왜 구분하는가"까지
말하면 암기가 아니라 이해로 들린다. (가산점 포인트)

## 3. 교과서 vs 실제 DB — 기본값과 InnoDB의 특수성

실무 답변에는 "표준의 정의"와 "우리가 쓰는 DB의 실제 동작"을 분리하는
한 마디가 들어가야 한다.

| DB | 기본 격리 수준 |
|---|---|
| MySQL (InnoDB) | **REPEATABLE READ** |
| PostgreSQL / Oracle / SQL Server | READ COMMITTED |

- 대부분 READ COMMITTED가 기본인데 **MySQL만 REPEATABLE READ**다.
  "지금 쓰는 서비스 DB의 기본 격리 수준이 뭔지 아는가"는 실무 감각을
  보는 단골 확인 질문.
- **InnoDB의 REPEATABLE READ는 교과서보다 강하다**: 일반 SELECT는
  MVCC 스냅샷(첫 읽기 시점의 스냅샷을 트랜잭션 내내 재사용)으로,
  잠금 읽기(UPDATE/DELETE/`FOR UPDATE`)는 갭 락(gap lock)으로 범위
  INSERT를 차단해 **phantom read까지 상당 부분 막는다**. 단 같은
  트랜잭션에서 스냅샷 읽기와 잠금 읽기를 섞으면 phantom처럼 보이는
  결과가 나올 수 있어 완전 무결은 아니다. (가산점 포인트)
- **SERIALIZABLE의 실체**: InnoDB는 일반 SELECT까지 공유 락을 잡는
  잠금 읽기로 바꾸고, PostgreSQL은 충돌을 감지해 한쪽 트랜잭션을
  강제 실패(직렬화 오류)시킨다. 처리량 급감·데드락/재시도 급증 —
  전역으로 켜는 수준이 아니라 정합성이 절대적인 특수 구간용 도구다.

DB 내부 동작(MVCC, 갭 락, 언두 로그)의 깊은 내용은
`04-rdb-sql/transaction-isolation-levels.md`가 다루므로, 이 문서는
아래 스프링 관점으로 이어간다.

## 4. 스프링 관점 — @Transactional(isolation = ...)의 동작과 함정

이 질문이 02-spring 섹션에 있는 이유다. 격리 수준을 "아는 것"과
"스프링 코드에서 올바르게 다루는 것" 사이에 함정이 몇 개 있다.

### 4-1. 기본값 Isolation.DEFAULT = "스프링이 정하지 않는다"

```java
@Transactional  // isolation = Isolation.DEFAULT
public BalanceSummary summarize(Long accountId) { ... }
```

`Isolation.DEFAULT`는 특정 수준이 아니라 **"커넥션(=DB)의 기본 격리
수준을 그대로 따른다"**는 뜻이다. 즉 같은 코드가 MySQL 위에서는
REPEATABLE READ로, PostgreSQL 위에서는 READ COMMITTED로 돈다.
"스프링 트랜잭션의 기본 격리 수준은?"에 "READ_COMMITTED"라고 박아
답하면 틀린다 — **DB 위임이 정답**이다. 이 말은 곧 "DB를 이전(예:
MySQL → PostgreSQL)하면 아무 코드도 안 바꿨는데 격리 수준이 바뀐다"는
뜻이기도 하다.

### 4-2. 명시 지정 시 무슨 일이 일어나나

```java
@Transactional(isolation = Isolation.REPEATABLE_READ)
public SettlementReport settle(YearMonth month) { ... }
```

트랜잭션 매니저가 트랜잭션을 **새로 시작할 때** 커넥션에
`Connection.setTransactionIsolation(...)`을 호출해 그 트랜잭션 동안만
적용하고, 트랜잭션이 끝나면 원래 값으로 되돌린다. 커넥션 풀을 여러
스레드가 공유하므로, DB 전역 설정을 바꾸는 대신 이렇게 **트랜잭션
단위로 지정하는 것이 정석**이다.

### 4-3. 함정 — 합류(join)하는 트랜잭션에는 적용되지 않는다

격리 수준은 **커넥션에, 트랜잭션 시작 시점에** 설정된다. 그래서
전파(propagation)가 REQUIRED인 메서드가 **이미 열린 트랜잭션에
합류**하면, 거기에 붙인 `isolation` 지정은 조용히 무시된다.

```java
// before — 의도대로 동작하지 않는 코드
@Service
public class OrderService {
    @Transactional  // DB 기본값 (MySQL이면 REPEATABLE READ)
    public void placeOrder(OrderCommand cmd) {
        ...
        stockService.checkStock(cmd);  // 아래 메서드 호출
    }
}

@Service
public class StockService {
    // "재고 확인은 최신 커밋을 봐야 하니 READ_COMMITTED로!"
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void checkStock(OrderCommand cmd) { ... }
    // ❌ placeOrder의 트랜잭션에 REQUIRED로 합류하므로
    //    격리 수준 지정은 기본 설정에서 조용히 무시된다.
    //    실제로는 바깥 트랜잭션의 격리 수준(REPEATABLE READ)으로 돈다.
}
```

```java
// after — 선택지 두 가지
// (1) 정말 다른 격리 수준이 필요하면 트랜잭션을 새로 시작한다
@Transactional(isolation = Isolation.READ_COMMITTED,
               propagation = Propagation.REQUIRES_NEW)
public void checkStock(OrderCommand cmd) { ... }
// 단, REQUIRES_NEW는 커넥션을 하나 더 점유한다 — 풀 고갈/데드락 비용을
// 알고 써야 한다 (12번 문서 참고).

// (2) 불일치를 조용히 넘기지 말고 예외로 드러나게 한다
//     트랜잭션 매니저 설정: setValidateExistingTransaction(true)
//     → 합류 시 격리 수준이 다르면 IllegalTransactionStateException
```

"격리 수준은 트랜잭션을 새로 시작하는 쪽이 정한다"는 문장으로
정리하면 전파 질문(12번)과 자연스럽게 연결된다. (가산점 포인트)

### 4-4. 애초에 트랜잭션이 "있는지"부터 — 자기 호출과 격리 수준의 착시

"같은 메서드에서 두 번 읽었는데 값이 달라요"가 격리 수준 문제가 아닐
수도 있다. 프록시 자기 호출 등으로 `@Transactional`이 적용되지 않으면
각 SELECT가 **별도의 auto-commit 트랜잭션**으로 돌아서, REPEATABLE READ
DB에서도 non-repeatable read처럼 보이는 현상이 난다. 격리 수준을
의심하기 전에 "두 읽기가 정말 같은 트랜잭션 안인가"(트랜잭션 로그,
`TransactionSynchronizationManager.isActualTransactionActive()`)를 먼저
확인하는 순서가 실무 진단의 정석이다.

## 5. 격리 수준으로 풀 문제 vs 락으로 풀 문제

격리 수준을 올리는 비용: 동시성 하락(락 대기 증가), 갭 락으로 인한
데드락 증가, 스냅샷 유지 비용. 그래서 실무 구분선은 **"격리 수준은
읽기 일관성의 기본기, 쓰기 충돌은 락으로"**다.

전형적인 오답 시나리오 — 재고 차감 동시성 문제:

```sql
-- ❌ "SERIALIZABLE로 올리면 되지 않나?" → 무관한 트래픽까지 처리량 붕괴
-- ✅ 문제가 되는 그 지점만 잠근다

-- 방법 A: 비관적 락 (그 행만 잠그고 읽기)
SELECT stock FROM item WHERE id = 1 FOR UPDATE;

-- 방법 B: 원자적 UPDATE (읽기-계산-쓰기를 한 문장으로)
UPDATE item SET stock = stock - 1 WHERE id = 1 AND stock >= 1;
-- affected rows = 0 이면 재고 부족

-- 방법 C: 낙관적 락 (버전 컬럼 + 충돌 시 재시도)
UPDATE item SET stock = 9, version = version + 1
 WHERE id = 1 AND version = 5;
```

격리 수준은 "트랜잭션 전체가 세상을 얼마나 일관되게 보는가"라는
**광역 설정**이고, 재고 차감은 "이 행 하나의 갱신 충돌"이라는 **국소
문제**다. 국소 문제를 광역 설정으로 풀면 무관한 트랜잭션까지 전부
비용을 치른다 — 이 구분을 말할 수 있으면 시니어 답변이 된다.

---

## 6. 꼬리질문 대비 포인트

### "같은 트랜잭션에서 같은 행을 두 번 읽었는데 값이 달라요 — 무슨 현상이고 어떻게 진단하나?"

전형적인 **non-repeatable read**이고, 격리 수준이 READ COMMITTED
이하일 때 가능한 현상이다. 진단 순서: ① 실제 격리 수준 확인 —
MySQL `SELECT @@transaction_isolation`, PostgreSQL
`SHOW transaction_isolation`. ② 코드에서 `@Transactional(isolation=...)`
지정 여부, 그리고 애초에 두 읽기가 **정말 같은 트랜잭션 안인지** 확인 —
프록시 자기 호출 등으로 트랜잭션이 안 걸려 각 SELECT가 별도
auto-commit으로 돈 것일 수 있다. 해결은 그 로직만 REPEATABLE READ로
올리거나, 값을 다시 읽지 말고 첫 읽기 결과를 변수로 들고 가거나,
갱신 충돌이 본질이면 `FOR UPDATE`로 잠그고 읽는 것 중 요구사항에 맞는
것을 고른다.

### "스프링 @Transactional의 격리 수준 기본값은 무엇인가?"

`Isolation.DEFAULT` — 특정 수준이 아니라 **DB 기본값을 따른다**는
의미다. 같은 애플리케이션 코드도 MySQL(REPEATABLE READ)과
PostgreSQL(READ COMMITTED) 위에서 다른 격리 수준으로 돈다. 명시
지정하면 트랜잭션 시작 시점에 커넥션에 `setTransactionIsolation`을
호출했다가 종료 시 원복하며, 이미 열린 트랜잭션에 REQUIRED로 합류하는
경우에는 적용되지 않는다(기본 설정에서는 조용히 무시,
`validateExistingTransaction`을 켜면 예외).

### "non-repeatable read와 phantom read를 왜 따로 구분하나? 둘 다 '다시 읽으니 다르다' 아닌가?"

막는 메커니즘이 다르기 때문이다. non-repeatable read의 원인은 기존
행의 UPDATE라서 **그 행에 락**(또는 행 단위 스냅샷)으로 막을 수 있다.
phantom read의 원인은 아직 존재하지 않던 행의 INSERT라서 행 락으로는
막을 수 없고, 조건 **범위 자체를 잠그는 갭 락**이나 SERIALIZABLE급
제어가 필요하다. 그래서 SQL 표준도 REPEATABLE READ까지는 phantom을
허용하는 것으로 단계를 나눴다. "현상의 분류가 아니라 방어 수단의
분류"라고 답하면 정확하다.

### "동시성 버그가 났을 때 격리 수준을 올려서 풀면 안 되나?" (시니어 변별 포인트)

문제의 스코프부터 판별해야 한다. "트랜잭션 안의 여러 읽기가 일관돼야
한다"는 읽기 일관성 문제라면 격리 수준(또는 스냅샷)이 맞는 도구지만,
"두 트랜잭션이 같은 행을 갱신하며 충돌한다"는 쓰기 충돌은 국소
문제라서 원자적 UPDATE, `FOR UPDATE` 비관적 락, 버전 기반 낙관적 락으로
그 지점만 잠그는 게 정석이다. SERIALIZABLE로 올리면 기술적으로는
막히지만 무관한 조회 트래픽까지 락 대기/직렬화 오류 재시도 비용을
치르고 데드락이 폭증한다. 또 격리 수준 인상은 전파 구조에 따라
적용조차 안 될 수 있다(합류 시 무시) — "격리 수준은 광역 설정, 쓰기
충돌은 국소 락"이라는 구분과 그 비용을 함께 말하는 것이 변별 포인트다.

### "MySQL REPEATABLE READ에서 phantom read가 정말 발생하나?"

일반 SELECT(일관된 읽기)만 쓰는 한 발생하지 않는다 — 첫 읽기 시점의
MVCC 스냅샷을 트랜잭션 내내 재사용해 다른 트랜잭션의 INSERT가 보이지
않고, 잠금 읽기는 갭 락이 범위 INSERT를 차단한다. 단 같은 트랜잭션에서
스냅샷 읽기와 잠금 읽기(`FOR UPDATE` 등)를 섞으면 후자는 최신 데이터를
읽으므로 phantom처럼 보이는 결과가 나온다. "표준 정의상 허용 / InnoDB
구현상 대부분 방지 / 잠금 읽기 혼용 시 예외"의 3단 구조로 답하면
표준과 구현을 분리해 말하는 것 자체가 가산점이다.

---

## 한 줄 요약

격리 수준 4단계는 dirty read(커밋 안 된 값) / non-repeatable read(같은
행의 값 변경, UPDATE) / phantom read(행 개수 변경, INSERT·DELETE)를
어디까지 허용하느냐의 매트릭스이고, 스프링 `@Transactional`의 기본값
`Isolation.DEFAULT`는 DB 기본값 위임이라 MySQL(REPEATABLE READ)과
PostgreSQL(READ COMMITTED)에서 같은 코드가 다르게 돌며, 격리 수준
지정은 트랜잭션을 새로 시작하는 쪽에만 적용되고(합류 시 무시), 쓰기
충돌 같은 국소 동시성 문제는 격리 수준 인상이 아니라 락/원자적
UPDATE로 푸는 것이 정석이다.
