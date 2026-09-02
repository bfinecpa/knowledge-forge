# HikariCP 커넥션 고갈 진단 — 증상은 하나, 원인은 넷: "오래 점유"와 "미반환(누수)"을 구분하라

> 핵심 관전 포인트: **`Connection is not available, request timed out after 30000ms`는 증상이 하나인데 원인은 여럿인 전형적 상황이라, 이 질문이 보는 것은 지식이 아니라 진단 방법론이다. 고갈의 물리는 하나뿐이다 — 필요 동시 점유 수 L = λ × W가 풀 크기 c를 넘으면 나머지는 대기한다. 그래서 원인은 λ가 커졌거나(① 풀 크기 부족), W가 커졌거나(② 느린 쿼리·락 대기, ③ 트랜잭션 안 외부 호출·CPU 작업), W가 아예 무한대이거나(④ 커넥션 누수) 넷뿐이다. 진단의 결정적 갈림은 "오래 점유"와 "미반환"의 구분이고, 이건 시계열 모양으로 가른다 — 트래픽이 빠졌는데도 `hikaricp.connections.active`가 max에 붙어 안 내려오면 누수, 트래픽과 함께 오르내리면 점유다. 앱 쪽 메트릭으로 계열을 좁힌 뒤 PostgreSQL의 `pg_stat_activity`로 교차 확인하는데, 여기서 가장 자주 나오는 범인이 `state = 'idle in transaction'` — 트랜잭션은 열려 있는데 쿼리를 안 보내는 상태로, 커넥션과 락을 쥐는 것에 더해 VACUUM이 그 트랜잭션의 스냅샷보다 최신인 죽은 튜플을 회수하지 못하게 만들어 테이블 블로트까지 유발한다. 누수 지점 특정은 `leakDetectionThreshold`가 대여 시점 스택트레이스를 로그로 뱉어 코드 라인 단위로 잡아주고, 스레드 덤프로 "커넥션을 기다리는 스레드(피해자)"와 "쥐고 있는 스레드(용의자)"를 갈라 읽어 교차 확인한다. 그리고 처방까지 가야 답이 완성된다 — 풀을 늘리는 것은 ①일 때만 정답이고, W가 원인이면 c를 늘려도 대기 줄이 DB 앞으로 옮겨져 DB만 더 힘들어지며(점유가 50ms → 3초가 되면 500 TPS를 감당하는 데 커넥션 1,500개가 필요하다), 누수면 마르는 시간만 미룰 뿐 반드시 다시 마른다.**

---

## 0. 질문 + 의도

**질문**: "HikariCP에서 커넥션 고갈(connection pool exhaustion)이 발생했습니다. 원인 후보와 진단 방법은?"

**출제 의도**: 증상(timeout 로그)은 하나인데 원인은 여럿(누수, 느린 쿼리, 트랜잭션 내 외부 호출, 풀 크기)인 전형적 상황이다. 원인 후보를 나열하고 각각의 배제 방법을 말할 수 있는지 — 진단 방법론 자체를 평가한다.

**이 문서의 기준**: Spring Boot 3.x + HikariCP 5.x + PostgreSQL 14 이상. DB 진단 어휘는 PostgreSQL 기준으로 쓰고, MySQL과 갈리는 지점만 한 줄로 대비한다.

**이 문서의 자리**: 이 질문은 "이미 잡아놨는데 왜 고갈됐는가"(진단)를 다룬다. "애초에 얼마로 잡을 것인가"(산정)는 `25-thread-pool-connection-pool-sizing.md`가 앞에 있고, 산정 계산과 지표 읽는 법은 거기서 이어받는다.

## 1. 증상 하나, 원인 넷 — 감별 진단의 뼈대

### 1-1. 먼저 로그 한 줄을 끝까지 읽는다

장애 채널에 올라오는 것은 보통 이 예외다.

```
java.sql.SQLTransientConnectionException:
  HikariPool-1 - Connection is not available, request timed out after 30001ms
  (total=10, active=10, idle=0, waiting=27)
```

대부분 앞부분만 읽고 넘어가는데, **괄호 안이 진단의 절반**이다. HikariCP는 타임아웃 예외를 던질 때 그 순간의 풀 통계를 함께 찍어 준다.

| 필드 | 뜻 | 이 예시가 말하는 것 |
|---|---|---|
| `total` | 풀이 현재 들고 있는 커넥션 총수 | 10 — `maximumPoolSize` 기본값 그대로다 |
| `active` | 대여 중(사용 중)인 커넥션 수 | 10 — 하나도 안 남았다 |
| `idle` | 풀에서 놀고 있는 커넥션 수 | 0 |
| `waiting` | `getConnection()`에서 대기 중인 스레드 수 | 27 — 27개 요청이 줄 서 있다 |

`total=10`이라는 것부터 이미 정보다. **HikariCP의 `maximumPoolSize` 기본값이 10**이므로, 이 서비스는 풀 크기를 한 번도 손대지 않았다는 뜻이다. 그리고 `waiting=27`은 대기 줄의 길이다 — 이 27개는 각자 톰캣 스레드를 하나씩 문 채로 30초를 기다린다(3-3의 연쇄).

`30001ms`는 `connectionTimeout` 기본값 30초를 다 채웠다는 뜻이다. **기본값 30초는 장애를 30초 동안 붙들고 있으라는 설정이라는 점**을 기억해 두자(3-3).

여기에 더해, `com.zaxxer.hikari.pool.HikariPool` 로거를 DEBUG로 켜 두면 HikariCP가 30초마다 같은 형식의 통계를 평상시에도 찍는다. **장애 전후의 추이**를 보려면 이 로그가 있어야 한다.

```
DEBUG com.zaxxer.hikari.pool.HikariPool - HikariPool-1 - Pool stats
      (total=10, active=3, idle=7, waiting=0)
```

### 1-2. 고갈의 물리는 하나뿐이다

원인이 넷이라고 하지만, **고갈이 일어나는 메커니즘 자체는 하나**다. 25번 문서의 Little's law를 그대로 가져오면 이렇게 된다.

```
필요한 동시 점유 수  L = λ × W

  λ (초당 요청 수)      들어오는 속도
  W (커넥션 점유 시간)  하나가 커넥션을 잡고 있는 시간
  c (maximumPoolSize)   풀이 동시에 내줄 수 있는 개수

  L ≤ c 이면  대기 없음
  L > c 이면  나머지 (L - c) 개가 getConnection() 에서 대기
             -> connectionTimeout 을 넘기면 SQLTransientConnectionException
```

그러니 **고갈의 원인은 논리적으로 셋뿐이다.** λ가 커졌거나, W가 커졌거나, c가 작거나. 여기에 W가 사실상 무한대가 되는 특수한 경우(반환 자체가 없는 누수)를 따로 떼면 넷이 된다.

이 틀이 왜 유용한가. 어떤 현상을 보든 **"이건 λ 얘기인가, W 얘기인가, c 얘기인가"**로 분류할 수 있고, 그러면 처방도 자동으로 갈리기 때문이다. 원인 목록을 외우는 것과 이 식에서 유도하는 것은 면접에서 완전히 다르게 들린다.

### 1-3. 원인 4계열

| 계열 | 식에서 무엇이 변했나 | 한 줄 정의 |
|---|---|---|
| ① 풀 크기 부족 | λ↑ 또는 c가 애초에 작음 | 정상적인 트래픽을 풀이 못 받는다 |
| ② 느린 쿼리·락 대기 | W↑ (DB 안에서 오래 걸림) | 쿼리가 오래 돈다 |
| ③ 트랜잭션 내 외부 호출·CPU 작업 | W↑ (DB 밖에서 오래 걸림) | 커넥션을 문 채 다른 일을 한다 |
| ④ 커넥션 누수 | W = ∞ (반환이 없음) | 빌려간 커넥션이 영영 안 돌아온다 |

②와 ③을 굳이 나누는 이유는 **관측 위치가 다르기 때문**이다. ②는 DB에 흔적이 남고 ③은 앱에만 남는다. 이 차이가 진단 도구를 가른다.

### 1-4. ① 풀 크기 부족 — 정상 동작이 용량을 넘어선 경우

가장 단순한 계열이다. 코드에 아무 문제가 없고 커넥션도 제때 반환되는데, **동시에 필요한 개수가 풀 크기를 넘었을 뿐**이다.

```
풀 크기 c = 10, 커넥션 점유 W = 50ms
  이 풀이 감당하는 최대 처리량 λ_max = c / W = 10 / 0.05s = 200 TPS

트래픽이 150 TPS -> L = 150 × 0.05 = 7.5개  (여유 있음)
트래픽이 300 TPS -> L = 300 × 0.05 = 15개   (10개를 넘음 -> 고갈)
```

**전형적인 모양**은 이렇다. 프로모션·푸시 발송·배치와 겹친 시각에 트래픽이 평소의 2~3배로 뛰고, 그 시간대에만 고갈이 나며, 트래픽이 빠지면 저절로 정상으로 돌아온다. 쿼리는 여전히 빠르고 DB CPU도 한가하다.

이 계열의 특징 하나를 짚어 두자. **어떤 커넥션도 오래 붙들려 있지 않다.** `hikaricp.connections.usage`(점유 시간)가 평소와 같은데 `active`만 max에 붙어 있다면 ①일 가능성이 높다.

### 1-5. ② 느린 쿼리·락 대기 — DB 안에서 W가 늘어난 경우

같은 트래픽인데 **쿼리 한 건이 오래 걸려** 커넥션이 오래 잡히는 경우다. W가 늘면 L이 비례해 늘고, c는 그대로이므로 고갈이 난다.

```
평소  500 TPS × 0.05s =  25개 필요
느린 쿼리로 점유가 300ms가 되면
      500 TPS × 0.30s = 150개 필요   <- 풀이 36개여도 즉시 마른다
```

원인은 대개 셋 중 하나다.

- **인덱스 누락 또는 실행 계획 변경.** 데이터가 쌓이면서 옵티마이저가 인덱스 스캔에서 순차 스캔으로 계획을 바꾸는 일이 실제로 일어난다. 어제까지 5ms였던 쿼리가 오늘 800ms가 된다.
- **락 대기.** 다른 트랜잭션이 같은 행에 `UPDATE`나 `SELECT ... FOR UPDATE`를 걸고 있으면 내 쿼리는 그 트랜잭션이 끝날 때까지 아무것도 못 한다. **쿼리 자체는 빠른데 시작조차 못 하고 서 있는 상태**라 슬로우 쿼리 로그로는 잘 안 잡힌다(로그는 보통 실행 시간을 기준으로 하는데, 대기 시간도 실행 시간에 포함되어 찍히므로 "왜 이렇게 오래 걸렸는지"가 로그만으로는 안 보인다).
- **DB 자체의 포화.** 커넥션이 많아 DB 안에서 경합이 나는 상황. 이건 25번 문서 3-3의 "풀은 작을수록 좋다"와 직접 연결된다 — 풀을 늘린 것이 원인이 되어 W가 늘어난 경우다.

**진단은 DB 쪽에서 한다.** 2-3에서 실제 쿼리를 본다.

### 1-6. ③ 트랜잭션 내 외부 호출·CPU 작업 — DB 밖에서 W가 늘어난 경우

②와 결과는 같지만 원인 위치가 정반대다. **쿼리는 5ms에 끝났는데 커넥션은 3초 동안 잡혀 있는** 경우다.

```java
// before: 트랜잭션 경계 안에 외부 API 호출이 들어와 있다
@Transactional
public Order place(OrderRequest req) {
    Order order = orderRepository.save(Order.of(req));
    // 위 save 로 트랜잭션이 시작되며 커넥션이 잡혔고, 이 메서드가 끝날 때까지
    // 그 커넥션은 반환되지 않는다. 트랜잭션 경계 = 커넥션 점유 구간이기 때문이다.

    PaymentResult result = paymentClient.charge(order);   // 외부 PG 호출 — 평소 300ms
    // 이 300ms 동안 커넥션은 아무 쿼리도 보내지 않으면서 대여 상태로 남아 있다.
    // DB 입장에서는 'idle in transaction' 으로 보인다 (2-4).
    // PG사가 느려져 3초가 되면? 커넥션 점유도 그대로 3초가 된다.

    order.markPaid(result);
    return order;
}
```

여기서 반드시 알아야 하는 전제가 하나 있다. **Spring에서 트랜잭션 경계와 커넥션 점유 구간은 같다.** `@Transactional` 메서드에 진입해 첫 DB 접근이 일어나는 순간 커넥션이 잡혀 `TransactionSynchronizationManager`의 ThreadLocal에 묶이고, 메서드가 끝나 커밋/롤백될 때까지 그 스레드에 붙어 있다. 중간에 DB를 안 쓰는 구간이 있어도 반환되지 않는다(`24-transaction-synchronization-connection-binding.md`).

그래서 **트랜잭션 안에 들어간 모든 것이 커넥션 점유 시간에 그대로 더해진다.** 외부 API 호출, 파일 I/O, 무거운 연산, 심지어 `Thread.sleep`까지.

이 계열의 위험은 **평소에는 안 터진다**는 데 있다. 300ms면 500 TPS에서 150개가 필요해 이미 아슬아슬하지만, 트래픽이 낮은 서비스에서는 몇 달 동안 아무 일 없이 돌아간다. 그러다 **외부 PG사가 느려지는 날 한 번에 터진다.** 상세한 장애 시뮬레이션은 `22-external-api-call-inside-transaction.md`에 있다.

### 1-7. ④ 커넥션 누수 — 반환 자체가 없는 경우

앞의 셋은 커넥션이 결국은 돌아온다. 누수는 **영영 안 돌아온다.**

```java
// before: 트랜잭션 관리 밖에서 수동으로 얻고, 정상 경로에서만 닫는다
public List<Row> report(String sql) throws SQLException {
    Connection con = dataSource.getConnection();
    // 여기서 커넥션을 잡는다 — 이 줄부터 close() 까지가 점유 구간이다.
    PreparedStatement ps = con.prepareStatement(sql);
    ResultSet rs = ps.executeQuery();
    // executeQuery 가 SQLException 을 던지면 아래 close 는 실행되지 않는다.
    // 예외가 위로 던져지며 con 참조가 사라지고, 풀은 이 커넥션을 영영 못 돌려받는다.
    List<Row> rows = map(rs);
    con.close();
    return rows;
}
```

```java
// after: try-with-resources — 정상이든 예외든 close 가 보장된다
public List<Row> report(String sql) throws SQLException {
    try (Connection con = dataSource.getConnection();
         PreparedStatement ps = con.prepareStatement(sql);
         ResultSet rs = ps.executeQuery()) {
        // try 블록을 어떤 경로로 벗어나든 선언의 역순으로 close 가 호출된다.
        // HikariCP 에서 close() 는 실제로 닫는 게 아니라 풀에 반납하는 동작이다.
        return map(rs);
    }
}
```

여기서 오해를 하나 걷어내자. **`Connection.close()`는 커넥션을 끊는 것이 아니다.** HikariCP가 돌려주는 것은 진짜 커넥션이 아니라 그것을 감싼 프록시(`HikariProxyConnection`)이고, 그 프록시의 `close()`는 "풀에 반납한다"는 뜻이다. 그래서 close를 빠뜨리면 커넥션이 끊기는 게 아니라 **대여 상태로 영원히 남는다** — 이것이 누수라는 이름의 정확한 의미다.

누수가 무서운 이유는 **누적된다**는 점이다. 점유 시간 문제는 트래픽이 빠지면 저절로 회복되지만, 누수는 요청이 들어올 때마다 남은 커넥션이 하나씩 줄어들 뿐 절대 회복되지 않는다.

```
누수 속도가 분당 5개일 때 고갈까지 걸리는 시간
  풀 10개  ->  2분
  풀 50개  -> 10분
  풀 100개 -> 20분

풀을 10배로 늘려도 죽는 시각이 10배 뒤로 밀릴 뿐, 반드시 죽는다.
```

**단, `@Transactional`을 정상적으로 쓰는 코드에서는 누수가 잘 안 난다.** Spring이 트랜잭션 종료 시 반환을 책임지기 때문이다. 누수는 대개 `dataSource.getConnection()`을 직접 부르는 코드, 레거시 JDBC 코드, 커넥션을 필드나 컬렉션에 담아 두는 코드에서 나온다. 진단할 때 **먼저 뒤져야 할 곳이 어디인지**를 알려주는 단서다.

## 2. 관측 — 앱과 PostgreSQL 양쪽에서 계열을 좁힌다

진단 순서의 대원칙은 이것이다. **코드부터 뒤지지 말고, 장애 중인 장비에서 관측 데이터를 먼저 본다.** 코드 리뷰는 후보를 좁힌 다음에 하는 일이다.

### 2-1. 앱 쪽 — Hikari 메트릭 네 개면 대부분 갈린다

Spring Boot에 Micrometer가 붙어 있으면 다음 지표가 자동으로 나온다.

| 지표 | 뜻 | 읽는 법 |
|---|---|---|
| `hikaricp.connections.active` | 대여 중인 커넥션 수 | max에 붙어 있으면 포화 |
| `hikaricp.connections.pending` | `getConnection()` 대기 스레드 수 | **0보다 크면 이미 고갈 중** |
| `hikaricp.connections.usage` | 대여 ~ 반환까지 걸린 시간 | 이것이 Little's law의 W 실측치다 |
| `hikaricp.connections.acquire` | 커넥션을 얻는 데 걸린 시간 | pending이 생기면 함께 치솟는다 |

이 중 **`usage`가 계열을 가르는 핵심 지표**다. 1-2의 식에서 W에 해당하기 때문이다.

- `active`가 포화인데 **`usage`는 평소와 같다** → W가 안 변했으니 λ나 c 문제, 즉 **① 풀 크기 부족**.
- `active`가 포화이고 **`usage`가 늘었다** → W가 늘었으니 **② 또는 ③**.
- `active`가 포화이고 **`usage`가 아예 기록되지 않는다** → 반환 이벤트가 없어 측정이 끝나지 않는 것, 즉 **④ 누수**.

마지막 항목이 중요하다. `usage`는 **반환 시점에 기록되는 타이머**다. 누수된 커넥션은 반환되지 않으므로 이 타이머에 아무것도 남기지 않는다. **"누수는 지표에 안 나타난다"가 아니라 "안 나타난다는 것 자체가 지표"**다.

### 2-2. 결정적 갈림 — "오래 점유"와 "미반환"의 시계열 모양

이 문서에서 가장 중요한 구분이다. 그리고 이건 **단일 시점의 값이 아니라 시간에 따른 모양**으로 갈린다.

핵심 질문은 하나다. **트래픽이 빠졌을 때 `active`가 따라 내려오는가.**

```
[오래 점유 (②③) — 트래픽과 함께 오르내린다]

 트래픽 ┤      ╭──────╮
        │     ╱        ╲
        ┤────╯          ╰────────
 active ┤      ╭──────╮
  (max) ┼──────█████████──────────   <- 피크 동안만 max에 붙는다
        ┤    ╱          ╲
        ┤───╯            ╰───────    <- 트래픽 빠지면 함께 내려온다
        └──────────────────────────> 시간
              09:00   09:30   10:00

 해석: 커넥션이 느리게라도 돌아오고 있다. 유입이 줄면 회복된다.
       -> DB나 APM 트레이스에 "오래 걸린 흔적"이 남아 있다.
```

```
[미반환 = 누수 (④) — 계단식으로 올라가 절대 안 내려온다]

 트래픽 ┤      ╭──────╮
        │     ╱        ╲
        ┤────╯          ╰────────    <- 트래픽은 정상적으로 빠졌는데
 active ┤          ┌────────────────
  (max) ┼──────────█████████████████  <- 한 번 붙으면 안 내려온다
        ┤    ┌─────┘
        ┤────┘                        <- 계단식으로 한 칸씩 올라간다
        └──────────────────────────> 시간
              09:00   09:30   10:00

 pending┤                ╱▔▔▔▔▔▔▔▔▔   <- 대기만 계속 쌓인다
        └──────────────────────────>

 해석: 커넥션이 돌아오지 않는다. 유입이 줄어도 회복되지 않는다.
       -> 재시작해야만 풀린다. 재시작 후 같은 속도로 다시 차오른다.
```

**"재시작하면 잠깐 살아났다가 몇 십 분 뒤 똑같이 죽는다"**는 증언이 나오면 그것만으로 누수를 강하게 의심할 수 있다. 계단의 기울기가 곧 누수 속도이고, 1-7의 계산으로 다음 고갈 시각을 예측할 수도 있다.

시그니처를 표로 정리하면 이렇다.

| | 오래 점유 (②③) | 미반환 = 누수 (④) |
|---|---|---|
| 트래픽 감소 시 `active` | 함께 내려온다 | 안 내려온다 |
| `usage` 타이머 | 값이 커진다 | 아예 기록이 없다 |
| DB 쪽 흔적 | 느린 쿼리 또는 `idle in transaction` | **DB는 한가하다** |
| APM 트레이스 | 긴 스팬이 보인다 | 안 잡힌다 (반환 이벤트가 없으므로) |
| 재시작 후 | 트래픽 오면 다시 발생 | 일정 시간 뒤 정확히 재발 |

**"쿼리는 빠르고 DB는 한가한데 `active`가 max에 붙어 안 내려온다"** — 이 조합이 누수의 지문이다.

### 2-3. DB 쪽 — `pg_stat_activity`로 교차 확인한다

앱 메트릭으로 계열을 좁혔으면 DB에서 확인한다. PostgreSQL에서 지금 무슨 일이 벌어지는지 보는 창은 `pg_stat_activity` 뷰 하나다. 백엔드 프로세스(=커넥션) 하나가 한 행이다.

먼저 전체 그림부터 본다.

```sql
-- 이 DB에 붙은 커넥션이 어떤 상태로 몇 개씩 있는가
SELECT state, count(*)
  FROM pg_stat_activity
 WHERE datname = current_database()
 GROUP BY state
 ORDER BY 2 DESC;
```

`state` 값이 곧 진단이다.

| `state` | 뜻 | 고갈과의 관계 |
|---|---|---|
| `active` | 지금 쿼리를 실행 중 | 많고 오래 지속되면 ② |
| `idle` | 트랜잭션 없이 놀고 있음 | 정상. 풀에 반납된 커넥션이 여기 있다 |
| `idle in transaction` | **트랜잭션은 열려 있는데 쿼리를 안 보내는 중** | ③의 지문. 다음 절에서 자세히 |
| `idle in transaction (aborted)` | 위와 같은데 이미 오류가 나서 롤백만 남은 상태 | 예외 처리 누락 의심 |

`active`가 오래 지속되는 쿼리를 찾는다.

```sql
-- 1초 넘게 돌고 있는 쿼리 — 무엇을 기다리는지까지 함께 본다
SELECT pid,
       now() - query_start        AS running_for,
       wait_event_type, wait_event,   -- 무엇을 기다리는가 (Lock, IO, CPU면 NULL)
       left(query, 120)           AS query
  FROM pg_stat_activity
 WHERE state = 'active'
   AND now() - query_start > interval '1 second'
 ORDER BY query_start;
```

`wait_event_type`이 특히 유용하다. `Lock`이면 **다른 트랜잭션을 기다리는 중**이고(2-5), `IO`면 디스크를 기다리는 중이며, `NULL`이면 실제로 CPU를 쓰며 돌고 있다는 뜻이다. **"느리다"의 원인이 계산인지 대기인지를 이 한 컬럼이 갈라 준다.**

MySQL을 쓴다면 대응되는 것이 `SHOW PROCESSLIST` 또는 `information_schema.processlist`이고, `idle in transaction`에 해당하는 상태는 `Sleep`이면서 트랜잭션이 열려 있는 세션이라 `information_schema.innodb_trx`를 함께 봐야 한다. **PostgreSQL 쪽이 한 뷰에서 다 보인다는 점이 진단상 유리하다.**

### 2-4. `idle in transaction`이 왜 특별히 위험한가

`idle in transaction`은 **`BEGIN`은 했는데 아직 `COMMIT`도 `ROLLBACK`도 안 했고, 지금 이 순간 실행 중인 쿼리도 없는** 상태다. 1-6의 코드가 외부 API를 호출하는 300ms 동안 DB에서 보이는 모습이 정확히 이것이다.

"쿼리를 안 보내고 있으니 DB는 놀고 있는 것 아닌가"라고 생각하기 쉽지만 정반대다. **세 가지를 동시에 붙잡고 있다.**

**(1) 커넥션을 붙잡는다.** 이게 이 문서의 주제다. 앱 쪽에서는 Hikari 커넥션 하나가 대여 중이고, DB 쪽에서는 백엔드 프로세스 하나가 살아 있다.

**(2) 획득한 락을 붙잡는다.** 트랜잭션이 끝나야 락이 풀린다. `UPDATE`를 한 번이라도 했다면 그 행의 배타 락을 계속 쥐고 있고, 다른 트랜잭션들이 그 뒤에 줄을 선다. **하나의 느린 외부 API 호출이 무관한 요청 수십 개를 세우는 경로**가 여기다.

**(3) VACUUM을 방해한다.** 이게 PostgreSQL 특유의 문제이고, 가장 늦게 발견되는 피해다.

먼저 전제를 깔자. PostgreSQL은 **MVCC(다중 버전 동시성 제어)**를 쓴다. `UPDATE`는 기존 행을 덮어쓰지 않고 **새 버전의 튜플을 추가**하며, 옛 버전은 그것을 아직 봐야 하는 트랜잭션이 있을 수 있으므로 그대로 남겨 둔다. 이렇게 남은 옛 버전을 **죽은 튜플(dead tuple)**이라 하고, 아무도 안 보게 되면 **VACUUM**이 회수해 공간을 재사용한다.

여기서 "아무도 안 본다"의 기준이 문제다. 기준은 **현재 살아 있는 트랜잭션 중 가장 오래된 것의 스냅샷**이다. 그보다 나중에 죽은 튜플은 그 오래된 트랜잭션이 볼 수도 있으므로 회수할 수 없다.

```
[정상]
  t0 ─ 트랜잭션 A 시작 ─ t1 종료
                          t2 ─ B 시작 ─ t3 종료
  VACUUM 은 t3 이후 시점 기준으로 t0~t3 사이의 죽은 튜플을 전부 회수한다.

[idle in transaction 이 방치된 경우]
  t0 ─ 트랜잭션 X 시작 ────────────────── (30분째 idle in transaction) ──>
       그 사이 수만 건의 UPDATE/DELETE 발생
  VACUUM 은 X 의 스냅샷 시점(t0)보다 최신인 죽은 튜플을 하나도 회수하지 못한다.
  -> 죽은 튜플이 계속 쌓인다 = 테이블 블로트(bloat)
```

**테이블 블로트**는 실제 데이터는 그대로인데 죽은 튜플 때문에 테이블과 인덱스의 물리 크기가 부풀어 오르는 현상이다. 결과는 순차 스캔이 읽어야 할 페이지 수 증가, 공유 버퍼 적중률 하락, 인덱스 비대화다. **즉 ③이 방치되면 결국 ②(느린 쿼리)를 유발한다** — 계열끼리 서로를 만들어내는 것이다.

한 가지 정확히 해 둘 것이 있다. **`BEGIN`만 하고 쿼리를 한 번도 실행하지 않은 트랜잭션은 아직 스냅샷을 잡지 않아 VACUUM을 막지 않는다.** 문제가 되는 것은 이미 쿼리를 실행한 뒤 열린 채로 방치된 트랜잭션이고, 1-6 같은 실무 코드는 전부 여기 해당한다.

이 상태를 찾는 쿼리는 이렇다.

```sql
-- 10초 넘게 idle in transaction 인 세션 — state_change 가 그 상태로 들어간 시각이다
SELECT pid,
       usename, application_name, client_addr,
       now() - state_change AS idle_in_tx_for,   -- 이 상태로 얼마나 있었나
       now() - xact_start   AS tx_age,           -- 트랜잭션 전체 나이
       left(query, 120)     AS last_query        -- 마지막으로 실행한 쿼리
  FROM pg_stat_activity
 WHERE state = 'idle in transaction'
   AND state_change < now() - interval '10 seconds'
 ORDER BY state_change;
```

`state_change`가 핵심 컬럼이다. **현재 상태로 전환된 시각**이므로 `now() - state_change`가 곧 "이 상태로 얼마나 방치됐는가"다. 그리고 `query` 컬럼은 지금 실행 중인 쿼리가 아니라 **마지막으로 실행한 쿼리**이므로, 트랜잭션이 어디까지 진행하다 멈췄는지를 그대로 알려준다 — 코드의 어느 지점인지 특정하는 데 결정적이다.

VACUUM 방해 여부까지 확인하려면 가장 오래된 스냅샷을 본다.

```sql
-- backend_xmin 이 오래될수록 VACUUM 이 회수하지 못하는 튜플이 많다
SELECT pid, state, backend_xmin, age(backend_xmin) AS xmin_age,
       now() - xact_start AS tx_age
  FROM pg_stat_activity
 WHERE backend_xmin IS NOT NULL
 ORDER BY age(backend_xmin) DESC
 LIMIT 10;
```

**안전장치도 함께 알아 두자.** PostgreSQL에는 이 상태를 강제로 끊는 설정이 있다.

```
idle_in_transaction_session_timeout = '30s'
  -- idle in transaction 상태가 이 시간을 넘으면 그 세션을 종료시킨다.
  -- 기본값 0(비활성). PostgreSQL 9.6 이상.

statement_timeout = '5s'    -- 쿼리 하나가 이 시간을 넘으면 취소. 기본 0.
lock_timeout      = '2s'    -- 락을 이 시간 안에 못 얻으면 실패. 기본 0.
```

`idle_in_transaction_session_timeout`을 켜면 ③의 피해가 무한정 번지는 것을 DB 쪽에서 끊을 수 있다. 대신 **애플리케이션은 커넥션이 끊긴 것으로 보이므로 예외 처리가 필요하다.** 근본 대책이 아니라 방화벽이라는 점을 분명히 하고 쓴다.

### 2-5. 락 대기 추적 — `pg_blocking_pids()`

②의 하위 유형인 락 대기는 **"누가 누구를 막고 있는가"**를 알아야 진단이 끝난다. PostgreSQL 9.6부터 이걸 한 함수로 해결할 수 있다.

```sql
-- 지금 잠금 때문에 서 있는 세션과, 그 세션을 막고 있는 세션의 pid
SELECT a.pid,
       now() - a.query_start        AS waiting_for,
       a.wait_event_type, a.wait_event,
       pg_blocking_pids(a.pid)      AS blocked_by,   -- 나를 막고 있는 pid 배열
       left(a.query, 100)           AS my_query
  FROM pg_stat_activity a
 WHERE cardinality(pg_blocking_pids(a.pid)) > 0
 ORDER BY waiting_for DESC;
```

`pg_blocking_pids(pid)`는 그 세션이 기다리는 락을 쥐고 있는 세션들의 pid를 배열로 돌려준다. 여기서 나온 pid를 다시 `pg_stat_activity`에서 조회하면 **막고 있는 쪽의 상태와 마지막 쿼리**가 보인다.

```sql
-- 막고 있는 쪽을 조회 — 여기서 state 가 'idle in transaction' 이면 원인이 ③이다
SELECT pid, state, now() - state_change AS in_state_for, left(query, 120)
  FROM pg_stat_activity
 WHERE pid = ANY (
        SELECT unnest(pg_blocking_pids(pid))
          FROM pg_stat_activity
         WHERE cardinality(pg_blocking_pids(pid)) > 0);
```

**막는 쪽이 `idle in transaction`으로 나오는 순간 진단이 끝난다.** "쿼리도 안 하면서 락을 쥐고 있는 트랜잭션"이므로 원인은 ③이고, 코드에서 트랜잭션 안에 들어간 외부 호출을 찾으면 된다. 이 한 갈래를 짚을 수 있으면 이 질문은 사실상 통과다.

### 2-6. 누수 지점 특정 — `leakDetectionThreshold`

계열이 ④로 좁혀졌으면 **코드의 어느 줄이 새는지**를 찾아야 한다. HikariCP가 이를 위한 기능을 내장하고 있다.

```yaml
spring:
  datasource:
    hikari:
      # 대여된 커넥션이 이 시간(ms) 안에 반환되지 않으면 경고 로그를 남긴다.
      # 최소 2000ms 이며 maxLifetime 보다 크면 HikariCP 가 무시한다. 0 이면 비활성(기본).
      leak-detection-threshold: 10000
```

**동작 원리를 알아야 값을 제대로 잡을 수 있다.** HikariCP는 커넥션이 대여될 때마다 다음 두 가지를 한다.

1. **그 순간의 스택트레이스를 담은 예외 객체를 하나 만들어 둔다.** 던지지 않고 보관만 한다. 이게 나중에 "어디서 빌려갔는지"를 알려줄 증거다.
2. **임계 시간 뒤에 실행될 태스크를 내부 스케줄러에 등록한다.** 커넥션이 제때 반환되면 이 태스크는 취소된다.

반환 전에 태스크가 먼저 실행되면 보관해 둔 스택트레이스를 WARN으로 찍는다.

```
WARN com.zaxxer.hikari.pool.ProxyLeakTask -
  Connection leak detection triggered for org.postgresql.jdbc.PgConnection@3f2a1b
  on thread http-nio-8080-exec-12, stack trace follows
java.lang.Exception: Apparent connection leak detected
    at com.example.report.ReportDao.report(ReportDao.java:41)   <- 대여 지점
    at com.example.report.ReportService.build(ReportService.java:88)
    ...
```

**이 스택은 "지금 어디서 멈춰 있는지"가 아니라 "어디서 빌려갔는지"다.** 두 가지가 다르다는 점이 중요하다. 지금 어디에 멈춰 있는지를 보려면 스레드 덤프가 필요하다(2-7). 둘을 함께 봐야 "이 지점에서 빌려간 커넥션이 저기서 멈춰 있다"는 완전한 그림이 된다.

**값은 얼마로 잡는가.** 기준은 "정상적인 최장 점유 시간보다 넉넉히 위"다.

- `hikaricp.connections.usage`의 p99를 본다. p99가 500ms라면 10초 정도가 무난하다.
- 배치·리포트처럼 정상적으로 오래 점유하는 작업이 있으면 그것보다 위로 잡거나, **그 작업을 별도 데이터소스로 분리**해 임계를 따로 준다.
- `maxLifetime`(기본 30분)보다 크면 HikariCP가 설정을 무시하고 경고한다.

**운영에 상시 켜도 되는가.** 결론부터 말하면 **켜도 된다.** 다만 "오버헤드가 0"이라고 말하면 안 되고, 무엇을 대가로 치르는지 정확히 알고 말해야 한다.

- 비용은 **대여마다 예외 객체 1개(스택트레이스 채우기) + 스케줄 태스크 1개**다. 스택트레이스를 채우는 것은 공짜가 아니다.
- 그런데 커넥션 대여 자체가 이미 그보다 훨씬 비싼 작업이고, `getConnection()` 뒤에는 대개 수 ms 이상 걸리는 쿼리가 따라온다. 상대적으로 **무시할 만한 비율**이다.
- 비활성(`0`)일 때는 이 경로 자체를 타지 않아 정말로 비용이 0이다. 그래서 "끄면 빨라진다"가 아니라 "켜도 거의 안 느려진다"가 정확한 표현이다.

**오탐 주의.** 이 로그는 "누수 확정"이 아니라 **"이 획득 지점이 임계 시간 이상 커넥션을 물고 있었다"**는 사실만 말한다. 배치의 정상적인 장기 점유도 걸린다. 다만 오탐이라도 정보 가치가 있다 — **커넥션을 오래 물고 있다는 사실 자체는 ③의 신호**이기 때문이다.

### 2-7. 스레드 덤프로 교차 확인 — 피해자와 용의자를 갈라 읽는다

`jstack <pid>` 또는 Actuator의 `/actuator/threaddump`로 덤프를 뜨면, 커넥션 관련 스레드가 **두 부류**로 나뉜다. 이 둘을 섞어 읽으면 진단이 산으로 간다.

**부류 A — 커넥션을 기다리는 스레드(피해자).** 이들이 수십 개 보이면 고갈이 확정된 것이지만, 원인은 여기 없다.

```
"http-nio-8080-exec-88" #188 daemon prio=5 tid=0x... nid=0x... waiting on condition
   java.lang.Thread.State: TIMED_WAITING (parking)
        at jdk.internal.misc.Unsafe.park(Native Method)
        at java.util.concurrent.locks.LockSupport.parkNanos(...)
        at java.util.concurrent.SynchronousQueue$TransferStack.awaitFulfill(...)
        at java.util.concurrent.SynchronousQueue.poll(...)
        at com.zaxxer.hikari.util.ConcurrentBag.borrow(...)      <- 풀에서 대기 중
        at com.zaxxer.hikari.pool.HikariPool.getConnection(...)
        at com.zaxxer.hikari.pool.HikariDataSource.getConnection(...)
        at org.springframework.jdbc.datasource.DataSourceUtils.fetchConnection(...)
```

`ConcurrentBag.borrow` → `HikariPool.getConnection`이 이 부류의 지문이다. 이런 스택의 스레드 개수가 곧 로그의 `waiting` 값이다.

**부류 B — 커넥션을 쥐고 있는 스레드(용의자).** 여기가 진짜 원인이고, 스택 최상단이 계열을 그대로 알려준다.

```
[② 느린 쿼리 — DB 응답을 기다리는 중]
"http-nio-8080-exec-31"  java.lang.Thread.State: RUNNABLE
        at sun.nio.ch.Net.poll(Native Method)
        at org.postgresql.core.PGStream.receiveChar(...)
        at org.postgresql.jdbc.PgStatement.executeQuery(...)     <- DB 응답 대기

[③ 트랜잭션 안 외부 호출 — 커넥션을 문 채 남의 서버를 기다리는 중]
"http-nio-8080-exec-17"  java.lang.Thread.State: RUNNABLE
        at sun.nio.ch.Net.poll(Native Method)
        at java.net.Socket$SocketInputStream.read(...)
        at org.apache.hc.core5.http.impl.io.SessionInputBufferImpl.fillBuffer(...)
        at com.example.pay.PaymentClient.charge(PaymentClient.java:52)  <- 외부 API!
        at com.example.order.OrderService.place(OrderService.java:37)   <- @Transactional
```

**③의 스택은 그 자체로 결정적 증거다.** 프레임을 아래에서 위로 읽으면 `@Transactional` 메서드 안에서 HTTP 클라이언트 호출로 내려가 소켓에서 멈춰 있는 경로가 그대로 보인다. "커넥션을 문 채 무엇을 하고 있는지"를 코드 라인 단위로 특정한 것이다.

여기서 25번 문서 2-1의 함정이 다시 나온다. **소켓 대기 스레드는 `BLOCKED`가 아니라 `RUNNABLE`로 표시된다.** 상태 이름을 보고 "실행 중"이라고 읽으면 정반대의 진단이 나오므로, **스택 최상단이 무엇인지**로 판단해야 한다.

**④ 누수의 경우 부류 B가 아예 안 보인다.** 커넥션을 빌려간 스레드는 이미 그 요청을 끝내고 다음 요청을 처리하고 있거나 풀에 돌아가 있다 — 커넥션만 두고 온 것이다. **"기다리는 스레드는 수십 개인데 쥐고 있는 스레드가 안 보인다"**는 것이 누수의 덤프 상 지문이고, 이때 `leakDetectionThreshold` 로그(2-6)가 유일한 단서가 된다.

## 3. 처방 — 계열별 대응과 "풀을 늘린다"가 대개 오답인 이유

진단만 하고 끝나면 절반이다. 계열을 좁혔으면 처방이 달라져야 하고, **계열마다 처방이 다르다는 사실 자체가 진단을 하는 이유**다.

### 3-1. 계열별 처방

| 계열 | 처방 | 처방의 성격 |
|---|---|---|
| ① 풀 크기 부족 | 풀 확대 (단 DB 상한 확인) 또는 인스턴스 증설 | c를 키운다 |
| ② 느린 쿼리·락 대기 | 인덱스·실행 계획 교정, 락 범위 축소, `statement_timeout`·`lock_timeout` | W를 줄인다 |
| ③ 트랜잭션 내 외부 호출 | 트랜잭션 경계 밖으로 빼기, 상태 기반 재설계, 아웃박스 | W를 줄인다 |
| ④ 커넥션 누수 | try-with-resources, 수동 `getConnection()` 제거 | W = ∞ 를 없앤다 |

**①에 대한 처방**은 25번 문서가 통째로 다룬다. 다만 그냥 늘리면 안 된다 — 앱 쪽 계산값과 DB 쪽 상한 중 작은 쪽이 실질 상한이고, 앱 인스턴스 수를 곱한 총합이 PostgreSQL `max_connections`(기본 100)를 넘지 않아야 한다.

**②에 대한 처방**에서 자주 빠뜨리는 것이 타임아웃이다. `statement_timeout`과 `lock_timeout`을 설정하면 **최악의 W에 상한이 생긴다.** 이게 중요한 이유는 1-2의 식 때문이다 — W에 상한이 없으면 L에도 상한이 없고, 그러면 어떤 c로도 방어가 안 된다. 타임아웃은 성능 설정이 아니라 **W의 상한을 선언하는 안전장치**다.

**③에 대한 처방**은 트랜잭션 경계를 옮기는 것이다.

```java
// after: 커넥션을 쥐는 구간과 외부를 기다리는 구간을 분리한다
public Order place(OrderRequest req) {
    // ① 짧은 트랜잭션 — 주문을 PENDING 으로 저장하고 즉시 커밋해 커넥션을 반납한다
    Order order = orderService.createPending(req);

    // ② 트랜잭션 밖 — 여기서 3초가 걸려도 커넥션을 하나도 잡고 있지 않다
    PaymentResult result = paymentClient.charge(order);

    // ③ 다시 짧은 트랜잭션 — 결과를 반영하고 커밋
    return orderService.applyResult(order.getId(), result);
}
```

점유 시간이 3초에서 두 번의 5ms로 줄었으니, 같은 트래픽에서 필요한 커넥션이 300분의 1이 된다. **풀 크기를 손대지 않고 W만으로 문제를 없앤 것**이다. 상태를 PENDING으로 두는 설계와 실패 처리는 `22-external-api-call-inside-transaction.md`, 발행 정합성은 `23-transactional-outbox-pattern.md`에 있다.

**④에 대한 처방**은 코드 수정뿐이다. 여기엔 우회로가 없다.

### 3-2. "풀을 늘린다"가 왜 대개 오답인가

고갈이 나면 가장 먼저 나오는 제안이 `maximumPoolSize`를 늘리는 것이다. **①일 때만 정답이고 나머지 셋에서는 상황을 악화시킨다.** 왜 그런지 계열별로 계산해 보자.

**②③(W가 원인)일 때 — 산술적으로 감당이 안 된다.**

```
목표 500 TPS 에서 필요한 커넥션 수 = 500 × W

  W = 50ms  ->  25개    (정상)
  W = 300ms ->  150개
  W = 1초   ->  500개
  W = 3초   ->  1,500개
```

**W가 60배 나빠지면 필요 커넥션도 60배**다. 1,500개를 꽂을 수 있는 PostgreSQL은 실무에 없다 — `max_connections` 기본값이 100이고, 늘린다 해도 커넥션마다 백엔드 프로세스가 하나씩 붙으므로 DB 서버가 먼저 무너진다.

그리고 늘리면 **더 나빠진다.** 25번 문서 3-3에서 본 그대로다 — 커넥션이 늘면 DB 안에서 컨텍스트 스위칭·락 경합·버퍼 오염이 늘어 W가 더 커지고, W가 커지면 더 많은 커넥션이 필요해진다. **양의 되먹임이라 풀을 늘릴수록 상황이 나빠지는 구간이 실제로 존재한다.**

한 줄로 말하면 이렇다. **대기 줄이 없어지는 것이 아니라, 앱 앞에 서 있던 줄이 DB 앞으로 옮겨 가는 것이다.** 그리고 DB 앞의 줄은 앱 앞의 줄보다 훨씬 비싸다.

**④(누수)일 때 — 죽는 시각만 미룬다.**

```
누수 속도가 분당 5개일 때
  풀 10  ->  2분 뒤 고갈
  풀 50  -> 10분 뒤 고갈
  풀 100 -> 20분 뒤 고갈
```

**누수 속도는 풀 크기와 무관하다.** 새는 코드가 그대로면 새는 속도도 그대로이고, 풀을 10배로 늘리면 죽는 시각이 10배 뒤로 밀릴 뿐이다. 오히려 "재시작하니 괜찮아졌다, 풀 늘렸더니 며칠 갔다"는 경험이 쌓이면서 **진짜 원인을 영영 안 찾게 되는** 것이 더 큰 손해다.

그래서 결론은 이렇다. **풀 확대는 진단의 결과여야지 진단의 대체물이면 안 된다.** "고갈 났으니 늘리자"는 ①이라는 진단을 이미 내렸다는 뜻인데, 대개는 그 진단을 하지 않은 채로 나온 말이다.

### 3-3. 연쇄를 끊는다 — `connection-timeout`을 짧게

커넥션 고갈은 커넥션에서 끝나지 않는다. 25번 문서 3-5에서 본 연쇄가 여기서 실현된다.

```
Hikari 고갈
   -> 커넥션을 기다리는 요청들이 톰캣 스레드를 문 채 30초씩 대기
   -> 톰캣 스레드 200개가 전부 "커넥션 대기" 상태로 채워짐
   -> DB를 안 쓰는 API도, 헬스체크 엔드포인트도 응답 못 함
   -> LB 가 인스턴스를 비정상으로 판정해 제외
   -> 남은 인스턴스로 트래픽이 몰려 거기서도 같은 일이 발생
   -> 전면 장애
```

**DB 하나의 문제가 서비스 전체의 문제로 번지는 경로가 이것이다.** 끊는 지점은 "30초씩 대기"다.

```yaml
spring:
  datasource:
    hikari:
      # 기본 30초. 커넥션을 못 얻으면 30초를 꽉 채운 뒤 실패한다는 뜻이다.
      # 짧게 잡으면 못 받을 요청이 빨리 실패해, 톰캣 스레드가 대기로 채워지지 않는다.
      connection-timeout: 2000
```

**30초를 2초로 줄이면 같은 시간에 톰캣 스레드가 대기에 잠기는 양이 15분의 1이 된다.** 요청은 여전히 실패하지만 **빨리 실패하고 스레드를 놓아준다.** 그러면 DB를 안 쓰는 기능과 헬스체크가 살아남고, 장애가 그 기능 안에 갇힌다.

이건 벌크헤드(bulkhead, 격벽) 관점이다 — 배가 한 구획에 구멍이 나도 격벽이 있으면 그 구획만 잠기고 배는 뜬다. 다만 **증상 처리라는 점을 분명히 하자.** 근본 원인은 여전히 ①~④ 중 하나이고, 짧은 타임아웃은 그것이 전면 장애로 번지지 않게 막아줄 뿐이다. 계열별 연쇄 메커니즘은 `07-traffic-performance/18-cascading-failure-mechanism-and-bulkhead.md`에서 더 다룬다.

### 3-4. 재발 방지 — 평소에 걸어 두는 것들

장애 대응의 마지막은 "다음에 같은 일이 나면 5분 안에 계열을 좁힐 수 있는가"다.

**관측**: `hikaricp.connections.active`/`pending`/`usage`/`acquire`를 대시보드에 올리고, `pending > 0`이 일정 시간 지속되면 알람을 건다. **`pending`은 0이 정상값이므로 임계치를 정하기 쉬운 훌륭한 알람 지표**다. 톰캣 지표(`tomcat.threads.busy`)는 `server.tomcat.mbeanregistry.enabled=true`를 켜야 나온다는 점도 함께 챙긴다.

**탐지**: `leak-detection-threshold`를 상시 설정한다(2-6). 오탐이 조금 있어도 켜 두는 편이 낫다.

**상한 선언**: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `connection-timeout`. **네 개 모두 "W나 대기 시간에 상한을 두는" 같은 성격의 장치**다. 기본값이 전부 무제한이거나 30초라는 점을 기억하자 — 아무것도 안 하면 상한이 없는 상태로 운영하는 것이다.

**예방**: 트랜잭션 안에서 외부 호출·긴 연산을 금지하는 컨벤션을 코드 리뷰 체크리스트에 넣는다. `@Transactional` 메서드에 HTTP 클라이언트 호출이 들어오는 것을 정적 분석이나 ArchUnit 규칙으로 막는 팀도 있다. **③은 사후 진단보다 사전 차단이 훨씬 싸다.**

## 4. 꼬리질문 대비 포인트

### "장애 상황입니다. 지금 무엇부터 보시겠어요?"

**순서 자체가 답**인 질문이다. 코드를 뒤지겠다고 하면 안 된다.

```
① 예외 로그의 괄호  (total, active, idle, waiting) 를 읽는다        [1-1]
     -> 풀 크기가 기본값 10인지, 대기 줄이 얼마나 긴지 즉시 파악

② Hikari 메트릭 시계열에서 active 와 usage 를 본다                 [2-1, 2-2]
     -> 트래픽 빠졌는데 active 가 안 내려오면 누수(④)로 직행
     -> usage 가 평소와 같으면 ①, 늘었으면 ②③

③ pg_stat_activity 를 state 별로 집계한다                          [2-3]
     -> active 가 많고 오래 걸리면 ②
     -> idle in transaction 이 쌓여 있으면 ③
     -> DB 가 한가한데 앱은 고갈이면 ④ 확정

④ 계열이 좁혀진 뒤에야 코드를 본다
     -> ③이면 @Transactional 안의 외부 호출
     -> ④면 leakDetectionThreshold 로그의 스택트레이스
```

**"앱과 DB 양쪽에서 교차 확인한다"**는 원칙을 명시적으로 말하면 좋다. 앱 지표만 보면 ②와 ③이 안 갈리고, DB만 보면 ④를 영영 못 찾는다.

### "쿼리도 빠르고 DB도 한가한데 커넥션이 계속 마릅니다. 왜죠?" (시니어 변별 포인트)

이 조합이 나오는 순간 **누수(④)로 좁혀야 한다.**

근거를 논리로 말할 수 있어야 한다. 고갈은 L = λW > c일 때 일어나는데, DB가 한가하다는 것은 λ도 W도 크지 않다는 뜻이다. **그런데도 c를 다 썼다면, 남은 가능성은 대여된 커넥션이 계산에 잡히지 않는 것 — 즉 반환되지 않는 것뿐이다.**

확인 순서는 이렇다.

1. **`active`의 시계열 모양**을 본다. 트래픽이 빠졌는데도 max에 붙어 있으면 누수다(2-2).
2. **`usage` 타이머에 기록이 없는지** 본다. 반환 시점에 기록되는 지표이므로 누수 커넥션은 흔적을 남기지 않는다.
3. **`leak-detection-threshold`를 켜고** 대여 지점 스택트레이스를 받는다(2-6).
4. **스레드 덤프**에서 "기다리는 스레드는 많은데 쥐고 있는 스레드가 없다"를 확인한다(2-7).
5. **재시작 후 재발 주기**를 잰다. 일정한 주기로 정확히 재발하면 누수 속도가 일정하다는 뜻이다.

그리고 **누수는 대개 `@Transactional` 밖에 있다**는 것까지 말하면 좋다. Spring이 관리하는 트랜잭션은 반환을 보장하므로, 범인은 `dataSource.getConnection()`을 직접 부르는 코드나 레거시 JDBC 코드다. **코드를 뒤질 때 어디부터 볼지를 아는 것이 진단 속도를 가른다.**

### "`idle in transaction`은 왜 위험한가요?"

세 층위로 답한다(2-4).

**(1) 커넥션을 쥔다.** 트랜잭션이 열려 있는 동안 Hikari 커넥션 하나가 계속 대여 상태다. 이게 고갈로 직결된다.

**(2) 락을 쥔다.** 이미 `UPDATE`를 했다면 그 행의 배타 락을 트랜잭션이 끝날 때까지 붙들고 있다. **무관한 요청들이 그 뒤에 줄을 서므로, 하나의 느린 외부 호출이 서비스 전반의 지연으로 번진다.**

**(3) VACUUM을 막아 테이블 블로트를 만든다.** PostgreSQL의 MVCC에서 죽은 튜플은 "가장 오래된 활성 트랜잭션의 스냅샷"보다 최신이면 회수되지 않는다. 30분째 열려 있는 트랜잭션 하나가 그 30분 동안 생긴 모든 죽은 튜플의 회수를 막는다. 결과는 테이블·인덱스 비대화와 스캔 성능 저하 — **③이 결국 ②를 만들어낸다.**

정확히 하면 가산점이다. **`BEGIN`만 하고 쿼리를 한 번도 안 한 트랜잭션은 스냅샷이 없어 VACUUM을 막지 않는다.** 문제가 되는 것은 쿼리를 한 뒤 열린 채로 방치된 트랜잭션이다.

대응은 코드 수정(트랜잭션 밖으로 외부 호출 빼기)이 근본이고, `idle_in_transaction_session_timeout`은 피해 확산을 막는 방화벽이다.

### "고갈 났으니 풀을 늘리면 되지 않나요?" (시니어 변별 포인트)

**"①일 때만 정답"**이라고 못 박고 나머지를 계산으로 반박한다(3-2).

- **②③이면 산술적으로 감당이 안 된다.** 점유 시간이 50ms에서 3초로 늘면 500 TPS를 감당하는 데 커넥션이 1,500개 필요하다. PostgreSQL의 `max_connections` 기본값은 100이다. 그리고 늘리면 DB 안 경합이 늘어 W가 더 나빠지는 **양의 되먹임**이 생긴다. 대기 줄이 사라지는 게 아니라 앱 앞에서 DB 앞으로 옮겨 가는 것이고, DB 앞의 줄이 더 비싸다.
- **④면 마르는 시간만 미룬다.** 분당 5개씩 새는 코드에서 풀을 10에서 100으로 늘리면 2분이 20분이 될 뿐이다.

그리고 **올바른 방향을 함께 제시**해야 답이 완성된다. L = λW ≤ c에서 c를 못 늘리면 남는 것은 **W를 줄이는 것**이다 — 트랜잭션 밖으로 외부 호출 빼기, 인덱스·실행 계획 교정, 락 범위 축소. `hikaricp.connections.usage`가 그 개선을 직접 측정해 준다.

### "그럼 `maximumPoolSize`를 아주 크게 잡아두면 최소한 고갈은 안 나지 않나요?"

**고갈이 다른 곳으로 옮겨 갈 뿐이다.** 커넥션 풀은 병목이면서 동시에 **문지기**이기도 하다.

풀 크기 10이 하던 일은 "DB에 동시에 10개까지만 보낸다"는 유입 제어다. 이걸 500으로 열면 DB가 500개의 동시 요청을 받게 되고, 25번 문서 3-3에서 본 대로 DB 쪽 경합이 폭증해 **모든 쿼리가 같이 느려진다.** 일부가 실패하던 것이 전부가 느려지는 것으로 바뀐다.

여기에 3-4의 계산이 붙는다. 앱 인스턴스가 6대면 6 × 500 = 3,000개다. PostgreSQL은 접속 자체를 거부한다(`FATAL: sorry, too many clients already`).

**"상한은 제약이 아니라 신호 장치"**라는 표현까지 쓰면 좋다. 상한이 없으면 시스템은 자기가 과부하라는 사실을 알 방법이 없다(`07-traffic-performance/16-backpressure-and-application-points.md`).

### "`leakDetectionThreshold`를 운영에 상시 켜도 되나요?" (가산점 포인트)

**켜도 된다. 다만 공짜라고 말하면 안 된다.**

비용은 대여마다 **예외 객체 1개(스택트레이스 채우기) + 스케줄 태스크 1개**다. 커넥션 대여와 그 뒤에 따라오는 쿼리에 비하면 무시할 만한 비율이라 실무에서는 상시 켜 두는 것이 일반적이다. 비활성(`0`)일 때는 이 경로를 아예 타지 않으므로 그때의 비용은 정말로 0이다.

값은 `hikaricp.connections.usage`의 p99보다 넉넉히 위로 잡고, `maxLifetime`(기본 30분)보다 크면 HikariCP가 무시한다는 점, 최솟값이 2,000ms라는 점을 함께 알아 두면 좋다.

**로그가 찍혔는데 누수가 아닌 경우**도 답할 수 있어야 한다. 배치나 대량 처리의 정상적인 장기 점유가 걸린 것이다. 대응은 임계값을 그 작업보다 크게 잡거나, 그 작업을 별도 데이터소스로 분리하거나, **애초에 그 작업의 점유 자체를 줄이는 것**(청크 단위 커밋)이다. 마지막 선택지가 가장 낫다 — 그런 장기 점유는 오탐이기 이전에 이미 ③의 신호이기 때문이다.

---

## 한 줄 요약

커넥션 고갈은 증상 하나에 원인 넷이지만 물리는 하나다 — L = λ × W가 풀 크기 c를 넘으면 대기가 생기므로, 원인은 λ·c 문제(① 풀 크기 부족)이거나 W 문제(② 느린 쿼리·락 대기, ③ 트랜잭션 안 외부 호출)이거나 W가 무한대인 경우(④ 누수)뿐이다. 진단은 앱 메트릭으로 계열을 좁히고(`pending > 0`이면 고갈, `usage`가 W의 실측치, `active`가 트래픽과 함께 안 내려오면 누수) PostgreSQL의 `pg_stat_activity`로 교차 확인하되(오래 도는 `active`는 ②, 쌓인 `idle in transaction`은 ③ — 이건 커넥션·락에 더해 VACUUM까지 막아 블로트를 만든다), 누수 지점은 `leakDetectionThreshold`의 대여 시점 스택트레이스로 특정하고 스레드 덤프에서 "기다리는 스레드(피해자)"와 "쥐고 있는 스레드(용의자)"를 갈라 읽어 확정한다. 그리고 처방은 계열마다 달라서 풀 확대는 ①일 때만 정답이다 — W가 원인이면 점유가 3초일 때 500 TPS에 커넥션 1,500개가 필요해 산술적으로 감당이 안 되고 DB 경합만 키우며, 누수면 마르는 시각만 뒤로 밀린다. 남는 답은 W를 줄이는 것이고, 그동안 전면 장애로 번지지 않게 `connection-timeout`을 짧게 잡아 연쇄를 끊는다.
