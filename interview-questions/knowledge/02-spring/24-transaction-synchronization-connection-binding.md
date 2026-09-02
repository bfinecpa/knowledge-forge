# 트랜잭션 동기화(TransactionSynchronizationManager)와 커넥션 바인딩 원리 — 한 트랜잭션의 쿼리는 어떻게 같은 커넥션을 타는가

> 핵심 관전 포인트: **`@Transactional`이 시작되면 트랜잭션 매니저가 풀에서 커넥션을 하나 얻어 `TransactionSynchronizationManager`의 ThreadLocal 리소스 맵(키가 `DataSource` 객체, 값이 `ConnectionHolder`)에 바인딩한다. 이후 JdbcTemplate·JPA·MyBatis 등 모든 데이터 접근 코드는 커넥션을 풀에서 직접 꺼내지 않고 `DataSourceUtils`를 경유해 "내 스레드에 바인딩된 커넥션이 있으면 그것을 재사용"한다 — 그래서 한 트랜잭션의 모든 쿼리가 같은 커넥션을 타고, 쿼리마다 `close()`를 불러도 안전하다. 반대로 이 규칙을 우회해 `dataSource.getConnection()`을 직접 부르면 트랜잭션 밖의 별개 커넥션이 나와 방금 쓴 데이터가 안 보이고 커넥션도 두 개를 점유한다. 저장소가 ThreadLocal이라는 사실에서 나머지 전부가 따라 나온다 — `@Async`나 `CompletableFuture`로 스레드가 바뀌면 새 스레드의 리소스 맵이 비어 있어 트랜잭션이 전파되지 않고, 그렇다고 리소스 맵을 복사해 물려주면 JDBC 커넥션이 스레드세이프하지 않은 데다 원 트랜잭션 종료 시 풀로 반환된 커넥션을 제3의 요청과 나눠 쓰는 참사가 난다. 같은 저장소의 짝인 `synchronizations`에는 `beforeCommit → beforeCompletion → 커밋 → afterCommit → afterCompletion` 순서로 불리는 콜백이 등록되며, `@TransactionalEventListener`와 OSIV는 전부 이 기계 위에 얹힌 것이다.**

---

## 0. 질문 + 의도

**질문**: "Spring의 트랜잭션 동기화(TransactionSynchronizationManager)와 커넥션 바인딩 원리를 설명해주세요."

**출제 의도**: 멀티 데이터소스, 배치+API 혼재, 비동기 경계에서 트랜잭션이 "왜 안 타는지"를 추적하려면 이 내부 구조까지 알아야 한다. 프레임워크의 추상화가 새는(leaky) 지점에서 일할 수 있는 깊이인지 확인하는 질문이다.

이 문서는 Spring Framework 6.x / Spring Boot 3.x, HikariCP, PostgreSQL 기준으로 쓴다. 형제 문서와의 관계는 이렇다 — 이 문서가 **내부 구조**(무엇이 어디에 바인딩되는가), `22-external-api-call-inside-transaction.md`가 **그 구조가 만드는 장애**(경계 안에 외부 호출을 두면 벌어지는 일), `23-transactional-outbox-pattern.md`가 **경계를 넘는 일의 정합성 해법**이다.

## 1. 내부 구조 — 무엇이 어디에 바인딩되는가

### 1-1. 전제 지식 — `ThreadLocal`이 무엇인가

이 문서 전체가 `ThreadLocal`이라는 저장소 하나 위에 서 있으므로 여기부터 정확히 잡고 간다.

**`ThreadLocal`은 스레드마다 각자 자기 값을 갖는 저장소다.** 같은 변수 이름으로 읽어도 스레드마다 다른 값이 나온다. 코드로 보면 이해가 빠르다.

```java
private static final ThreadLocal<String> currentUser = new ThreadLocal<>();

// 스레드 A에서
currentUser.set("alice");
currentUser.get();   // "alice"

// 스레드 B에서 — 같은 static 필드를 읽는데
currentUser.get();   // null. A가 넣은 값이 안 보인다.
```

`static` 필드인데 스레드마다 값이 다르다는 것이 처음에는 이상하게 보인다. 이름이 오해를 부르는데, **값은 `ThreadLocal` 객체 안에 있는 것이 아니라 `Thread` 객체 안에 있다.** 각 `Thread`는 `ThreadLocalMap`이라는 자기만의 맵을 들고 있고, `ThreadLocal` 인스턴스는 그 맵의 **키**로 쓰일 뿐이다. `currentUser.get()`은 "현재 스레드의 맵에서 `currentUser`라는 키로 값을 꺼내라"는 뜻이다. (이 구조에서 나오는 메모리 누수·정보 유출 위험은 `01-java-kotlin/16-threadlocal-thread-pool-risks.md`에 따로 있다.)

**사물함에 비유하면** 이렇다. `ThreadLocal` 인스턴스는 "3번 칸"이라는 번호표이고, 사물함 자체는 스레드마다 하나씩 따로 있다. 모두가 "3번 칸을 열어라"라는 같은 지시를 받지만, 각자 자기 사물함의 3번 칸을 열기 때문에 안에 든 물건이 다르다.

### 1-2. 왜 트랜잭션 리소스를 하필 `ThreadLocal`에 두는가

스프링이 이 저장소를 고른 이유는 **"요청 하나 = 스레드 하나 = 트랜잭션 하나"**라는 전제 때문이다.

블로킹 방식의 Spring MVC에서 요청 하나는 톰캣 워커 스레드 하나가 처음부터 끝까지 처리한다. 컨트롤러 → 서비스 → 리포지토리로 내려가는 호출 스택 전체가 같은 스레드 위에 있다. 그러므로 **"현재 스레드"는 곧 "현재 요청"이고, 요청 하나가 쓰는 트랜잭션도 보통 하나다.**

대안을 생각해 보면 이 선택의 값이 분명해진다. 트랜잭션 커넥션을 파라미터로 넘긴다면 이렇게 된다.

```java
// 만약 스프링이 ThreadLocal을 안 썼다면 — 모든 메서드에 커넥션이 따라다녀야 한다
public Order placeOrder(Connection con, OrderRequest request) {
    orderRepository.save(con, order);
    couponRepository.use(con, couponId);
    pointRepository.deduct(con, userId, amount);
}
```

비즈니스 로직과 아무 상관 없는 `Connection`이 모든 시그니처를 오염시킨다. 게다가 중간에 한 군데라도 다른 커넥션을 넘기면 트랜잭션이 조용히 쪼개진다.

그래서 스프링은 **커넥션을 파라미터로 넘기는 대신 스레드에 걸어 두고, 필요한 곳에서 "현재 스레드의 커넥션"을 꺼내 쓰게** 했다. 이것이 "트랜잭션 **동기화**(synchronization)"라는 이름의 뜻이다 — 여러 스레드를 맞추는 동기화가 아니라, **트랜잭션 리소스를 스레드에 맞춰(동기화해) 두고 어디서든 꺼내 쓰게 하는 것**이다. 용어가 헷갈리기 쉬운 지점이니 면접에서 이 뜻을 정확히 말하면 좋다.

### 1-3. `TransactionSynchronizationManager` — 저장소의 실물

실제 클래스를 보면 필드가 전부 `static` + `ThreadLocal`이다.

```java
public abstract class TransactionSynchronizationManager {

    // ① 리소스 맵: 이 문서의 주인공. 키 = DataSource/EntityManagerFactory 객체
    private static final ThreadLocal<Map<Object, Object>> resources
            = new NamedThreadLocal<>("Transactional resources");

    // ② 동기화 콜백 집합: 커밋 전후에 불릴 훅들 (3-3에서 다룬다)
    private static final ThreadLocal<Set<TransactionSynchronization>> synchronizations
            = new NamedThreadLocal<>("Transaction synchronizations");

    // ③ 현재 트랜잭션의 메타 정보 — @Transactional의 속성이 여기 실려 다닌다
    private static final ThreadLocal<String>  currentTransactionName        = ...;
    private static final ThreadLocal<Boolean> currentTransactionReadOnly    = ...;
    private static final ThreadLocal<Integer> currentTransactionIsolationLevel = ...;
    private static final ThreadLocal<Boolean> actualTransactionActive       = ...;
}
```

`@Transactional` 트랜잭션이 열린 상태의 스레드를 그림으로 그리면 이렇다.

```
[톰캣 워커 스레드 http-nio-8080-exec-3]
 └─ ThreadLocalMap (이 스레드 전용)
     ├─ resources ──> { HikariDataSource@1a2b : ConnectionHolder(Connection#7) }
     │                   ▲ 키가 DataSource 객체다 (1-5에서 이유를 다룬다)
     │                                            ▲ 값이 실제 커넥션을 감싼 홀더
     ├─ synchronizations ──> { TransactionalApplicationListenerSynchronization, ... }
     ├─ actualTransactionActive ──> true
     ├─ currentTransactionReadOnly ──> false
     ├─ currentTransactionIsolationLevel ──> null (DB 기본값 사용)
     └─ currentTransactionName ──> "com.example.OrderService.placeOrder"
```

`ConnectionHolder`가 커넥션을 그냥 두지 않고 한 겹 감싸는 이유가 있다. 홀더는 **참조 카운트**를 들고 있어서, 같은 트랜잭션 안에서 여러 번 `getConnection()`이 불려도 "몇 명이 이 커넥션을 쓰고 있는지"를 센다. 이 카운트가 있어야 2-2에서 볼 "쿼리마다 `close()`를 불러도 실제로 닫히지 않는" 동작이 가능해진다.

### 1-4. `@Transactional` 진입 시 실제로 일어나는 일

`@Transactional`이 붙은 메서드에 프록시를 통해 들어가면(프록시를 통하지 않으면 아무 일도 안 일어난다 — `11-transactional-self-invocation.md`), 트랜잭션 매니저의 `doBegin()`이 순서대로 이 일을 한다.

```
① 풀에서 커넥션 획득
   Connection con = dataSource.getConnection();          // HikariCP에서 빌려온다
   ★ 이 줄부터 커넥션 점유가 시작된다. 22번 문서의 계산이 시작되는 지점이다.

② 트랜잭션 시작 준비
   con.setAutoCommit(false);                             // 이제 명시적 commit 전까지 확정 안 됨
   con.setTransactionIsolation(...);                     // @Transactional(isolation=...)이 있으면
   con.setReadOnly(true);                                // @Transactional(readOnly=true)면

③ 홀더로 감싸 스레드에 바인딩
   ConnectionHolder holder = new ConnectionHolder(con);
   TransactionSynchronizationManager.bindResource(dataSource, holder);
                                     ▲ 여기서 resources 맵에 들어간다

④ 트랜잭션 메타 정보 설정
   TSM.setActualTransactionActive(true);
   TSM.setCurrentTransactionReadOnly(...); TSM.setCurrentTransactionName(...);
   TSM.initSynchronization();                            // synchronizations 집합을 빈 Set으로 초기화
```

메서드가 끝나면 정확히 역순으로 정리된다.

```
① 커밋 또는 롤백           con.commit() / con.rollback()
② 동기화 콜백 실행         afterCommit, afterCompletion (3-3에서 상세)
③ 언바인딩                TSM.unbindResource(dataSource)
④ 커넥션 상태 복원         con.setAutoCommit(true), isolation·readOnly 되돌리기
⑤ 풀로 반환               con.close()  ← HikariCP에서 close는 "풀에 반납"이다
```

**⑤에서 `close()`가 실제로 커넥션을 끊지 않는다**는 점을 짚어 두자. 풀이 내주는 커넥션은 실제 커넥션을 감싼 프록시라, `close()`를 호출하면 물리적 연결을 끊는 대신 풀로 돌아간다. 커넥션풀의 핵심 아이디어가 이 프록시에 있다.

### 1-5. 왜 키가 `DataSource` 객체인가 — 멀티 데이터소스

리소스 맵의 키를 문자열이나 상수로 두지 않고 **`DataSource` 객체 자체**로 둔 이유는 하나다. **데이터소스가 여러 개인 환경에서 각각 따로 바인딩하기 위해서다.**

주 DB와 통계 DB를 함께 쓰는 구성을 보자.

```java
@Configuration
public class DataSourceConfig {

    @Bean @Primary
    public DataSource mainDataSource() { /* 주문·회원 DB */ }

    @Bean
    public DataSource statsDataSource() { /* 통계 DB */ }

    // 트랜잭션 매니저는 DataSource 하나에 하나씩 붙는다.
    // 매니저는 자기가 아는 DataSource만 트랜잭션으로 관리한다.
    @Bean @Primary
    public PlatformTransactionManager mainTxManager(DataSource mainDataSource) {
        return new DataSourceTransactionManager(mainDataSource);
    }

    @Bean
    public PlatformTransactionManager statsTxManager(DataSource statsDataSource) {
        return new DataSourceTransactionManager(statsDataSource);
    }
}
```

```java
@Service
@RequiredArgsConstructor
public class StatsService {

    // @Transactional의 value는 "어느 트랜잭션 매니저를 쓸 것인가"다.
    // 생략하면 @Primary 매니저(여기서는 mainTxManager)가 선택되므로,
    // 통계 DB에 쓰면서 이 값을 빼먹으면 트랜잭션이 엉뚱한 DB에 열린다.
    @Transactional("statsTxManager")
    public void writeDailyStats(DailyStats stats) {
        statsJdbcTemplate.update("INSERT INTO daily_stats ...", ...);

        // 문제: 이 줄은 mainDataSource를 쓴다. 그런데 지금 스레드에 바인딩된 것은
        // statsDataSource의 커넥션뿐이다. mainDataSource로는 바인딩이 없으므로
        // 풀에서 새 커넥션을 꺼내 auto-commit으로 즉시 확정된다 —
        // 이 트랜잭션이 롤백돼도 이 INSERT는 남는다.
        mainJdbcTemplate.update("INSERT INTO audit_log ...", ...);
    }
}
```

이 코드가 도는 동안 리소스 맵은 이렇다.

```
resources ──> { HikariDataSource(stats)@3c4d : ConnectionHolder(Connection#12) }
               ▲ main 데이터소스는 키로 존재하지 않는다.
                 그래서 mainJdbcTemplate은 "내 것이 없네" 하고 풀에서 새로 꺼낸다.
```

**두 DB를 하나의 원자적 단위로 묶고 싶다면** 선택지는 둘뿐이고 둘 다 대가가 있다.

- **`ChainedTransactionManager`**: 여러 매니저를 순서대로 커밋한다. 그런데 첫 번째가 커밋된 뒤 두 번째가 실패하면 첫 번째는 이미 확정이라 되돌릴 수 없다. **원자성이 없는 최선 노력(best-effort) 순차 커밋**일 뿐이고, 그래서 Spring Data에서 deprecated 됐다.
- **JTA/XA**: 진짜 2단계 커밋이다. 다만 가용성이 두 시스템의 곱으로 떨어지고 prepare 이후 잠금 블로킹이 생기는 등의 대가가 크다 (상세는 `23-transactional-outbox-pattern.md` 1-5).

실무의 현실적인 답은 **"묶지 않는 설계"**다. 감사 로그처럼 정확성 요구가 다른 쓰기는 애초에 원자적으로 묶을 필요가 없는 경우가 많고, 정말 묶여야 하는 데이터라면 같은 DB에 있어야 한다는 신호로 읽는 편이 낫다.

## 2. 같은 커넥션을 공유하는 경로 — `DataSourceUtils`

### 2-1. 분기 하나가 전부다 — 의사코드로 보기

1절에서 커넥션을 스레드에 걸어 뒀다. 이제 JdbcTemplate이 그것을 어떻게 찾아 쓰는지가 이 문서의 본론이다.

**JdbcTemplate은 `dataSource.getConnection()`을 부르지 않는다.** 대신 `DataSourceUtils.getConnection(dataSource)`를 부른다. 이 메서드가 하는 일을 의사코드로 펼치면 이렇다.

```java
Connection getConnection(DataSource dataSource) {

    // ① 먼저 "내 스레드에 이 DataSource로 바인딩된 커넥션이 있나?"를 본다.
    ConnectionHolder holder =
        (ConnectionHolder) TransactionSynchronizationManager.getResource(dataSource);

    if (holder != null && holder.hasConnection()) {
        holder.requested();              // 참조 카운트 +1 — 지금 몇 명이 쓰는지 센다
        return holder.getConnection();   // ★ 트랜잭션의 커넥션을 그대로 재사용한다
    }                                    //   여기가 "한 트랜잭션 = 한 커넥션"의 실체다

    // ② 바인딩이 없다 = 트랜잭션 밖이다. 그러면 풀에서 새로 꺼낸다.
    Connection con = dataSource.getConnection();

    // ③ 트랜잭션은 없지만 "동기화만" 활성인 경우(OSIV 등)에는
    //    이 커넥션도 스레드에 걸어 두고, 정리 콜백을 등록해 둔다.
    if (TransactionSynchronizationManager.isSynchronizationActive()) {
        holder = new ConnectionHolder(con);
        TransactionSynchronizationManager.bindResource(dataSource, holder);
        TransactionSynchronizationManager.registerSynchronization(
                new ConnectionSynchronization(holder, dataSource));
    }
    return con;
}
```

**①의 분기 한 줄이 이 질문의 답 전체다.** 트랜잭션 안이면 스레드에 걸린 커넥션을 재사용하고, 밖이면 풀에서 새로 꺼낸다. JPA도, MyBatis도, 스프링 배치도 전부 이 경로를 지난다.

### 2-2. 반납도 대칭이다 — 쿼리마다 `close()`를 불러도 안전한 이유

JdbcTemplate은 쿼리 하나가 끝날 때마다 `DataSourceUtils.releaseConnection()`을 부른다. 그런데 트랜잭션 안이라면 커넥션이 풀로 돌아가면 안 된다. 여기도 같은 분기가 있다.

```java
void releaseConnection(Connection con, DataSource dataSource) {

    ConnectionHolder holder =
        (ConnectionHolder) TransactionSynchronizationManager.getResource(dataSource);

    if (holder != null && connectionEquals(holder, con)) {
        holder.released();   // 참조 카운트 -1만 하고 끝. close()를 부르지 않는다.
        return;              // ★ 트랜잭션 소속 커넥션은 트랜잭션이 끝날 때 한 번만 반환된다
    }

    con.close();             // 트랜잭션 밖의 커넥션이면 여기서 풀로 반납
}
```

이 대칭 덕분에 **데이터 접근 코드는 자기가 트랜잭션 안인지 밖인지 신경 쓰지 않아도 된다.** 항상 "얻고 쓰고 반납한다"고 쓰면, 트랜잭션 안이면 재사용되고 밖이면 즉시 반납된다. 프레임워크가 감춰 준 것이 정확히 이 분기다.

### 2-3. 함정 — `dataSource.getConnection()`을 직접 부르면 무슨 일이 생기는가

이 규칙을 우회하는 코드는 생각보다 자주 나온다. 레거시 JDBC 코드를 옮겨 오거나, 배치에서 대량 처리를 하려고 커넥션을 직접 다루거나, 생성 도구가 만들어 준 코드를 그대로 쓸 때다.

```java
// before: 같은 메서드 안인데 방금 쓴 데이터가 안 보인다
@Service
@RequiredArgsConstructor
public class OrderService {

    private final DataSource dataSource;
    private final JdbcTemplate jdbcTemplate;

    @Transactional
    public void payAndVerify(Long orderId) {
        // ① 트랜잭션 커넥션(#7)으로 UPDATE. 아직 커밋 전이다.
        jdbcTemplate.update("UPDATE orders SET status='PAID' WHERE id=?", orderId);

        // ② 문제: 풀에서 완전히 별개인 커넥션(#19)을 꺼낸다.
        //    다른 커넥션 = 다른 트랜잭션이다.
        try (Connection con = dataSource.getConnection();
             PreparedStatement ps = con.prepareStatement(
                     "SELECT status FROM orders WHERE id=?")) {
            ps.setLong(1, orderId);
            ResultSet rs = ps.executeQuery();
            rs.next();
            String status = rs.getString("status");
            // ③ 'PAID'가 아니라 'PENDING'이 나온다.
            //    커넥션 #7의 UPDATE는 아직 커밋되지 않았고, PostgreSQL의 기본
            //    격리 수준 READ COMMITTED에서 커넥션 #19는 커밋된 것만 볼 수 있다.
            if (!"PAID".equals(status)) {
                throw new IllegalStateException("결제 반영 실패");  // 항상 터진다
            }
        }
    }
}
```

증상이 세 가지로 나타난다.

**첫째, 방금 쓴 데이터가 안 보인다.** 위 코드가 그것이다. "분명히 UPDATE했는데 SELECT하면 옛날 값"이라는 신고의 전형적인 원인이고, 원인이 격리 수준이라 코드만 봐서는 잘 안 보인다.

**둘째, 커넥션을 두 개 점유한다.** 트랜잭션 커넥션 #7을 쥔 채로 #19를 추가로 빌린다. 요청당 필요 커넥션이 두 배가 되므로 풀이 절반의 트래픽에서 고갈된다. 더 나쁜 경우는 **자기 교착**이다 — 동시 요청 수가 풀 크기와 비슷하면, 모든 요청이 첫 번째 커넥션을 쥔 채 두 번째 커넥션을 기다리며 아무도 진행하지 못한다. 아무도 커넥션을 놓지 않으므로 30초 타임아웃이 날 때까지 풀린다.

**셋째, 반대로 락 대기에 걸릴 수도 있다.** 커넥션 #19가 #7이 이미 잠근 행을 갱신하려 하면, 같은 스레드가 만든 두 트랜잭션이 서로를 기다린다. DB는 두 커넥션이 같은 스레드에서 왔다는 사실을 모르므로 데드락 탐지에도 안 걸리고, 그냥 락 타임아웃까지 멈춰 있다.

고치는 방법은 규칙을 따르는 것뿐이다.

```java
// after: DataSourceUtils를 경유해 트랜잭션 커넥션에 합류한다
@Transactional
public void payAndVerify(Long orderId) {
    jdbcTemplate.update("UPDATE orders SET status='PAID' WHERE id=?", orderId);

    // 바인딩된 커넥션(#7)을 그대로 돌려받는다 — 같은 트랜잭션이므로
    // 커밋 전 변경이 그대로 보인다.
    Connection con = DataSourceUtils.getConnection(dataSource);
    try (PreparedStatement ps = con.prepareStatement(
             "SELECT status FROM orders WHERE id=?")) {
        ...
    } finally {
        // 중요: try-with-resources로 con을 닫으면 안 된다.
        // con.close()는 HikariCP 프록시에서 "풀에 반납"이라, 트랜잭션이
        // 아직 안 끝났는데 커넥션이 반납되어 이후 커밋이 실패한다.
        // releaseConnection은 2-2의 분기 덕분에 트랜잭션 커넥션이면 아무것도 안 한다.
        DataSourceUtils.releaseConnection(con, dataSource);
    }
}
```

그리고 애초에 **JdbcTemplate을 쓰면 이 문제가 생기지 않는다.** JdbcTemplate이 하는 일이 정확히 이 획득·반납 처리이기 때문이다. 커넥션을 직접 만지는 코드를 발견하면 그 자체를 의심 신호로 삼는 것이 리뷰 관점이다.

### 2-4. JPA와 JdbcTemplate을 한 트랜잭션에서 섞어 쓸 수 있는 이유

같은 메커니즘이 JPA에도 적용되는데, 바인딩되는 것이 하나 더 있다.

`JpaTransactionManager`는 **`EntityManagerFactory`를 키로 `EntityManagerHolder`를 바인딩**한다. 그리고 여기에 더해, JPA 구현체가 자기가 쓰는 JDBC 커넥션을 노출할 수 있으면(Hibernate의 `HibernateJpaDialect`가 그렇다) **같은 커넥션을 `DataSource` 키로 `ConnectionHolder`로도 함께 바인딩**한다.

```
resources ──> {
    LocalContainerEntityManagerFactoryBean@aa : EntityManagerHolder(EM@x),
    HikariDataSource@1a2b                     : ConnectionHolder(Connection#7)
                                                                 ▲ EM이 쓰는 것과 같은 커넥션
}
```

그래서 같은 트랜잭션 안에서 JPA로 저장하고 JdbcTemplate이나 MyBatis로 조회해도 **같은 커넥션, 같은 트랜잭션**이다. 마이그레이션 중인 프로젝트에서 두 기술이 공존할 수 있는 근거가 이 이중 바인딩이다.

**다만 여기에 실무에서 자주 걸리는 함정이 하나 있다.** 같은 커넥션이라고 해서 JPA로 방금 저장한 데이터가 JdbcTemplate에 바로 보이는 것은 아니다.

```java
@Transactional
public void register(Member member) {
    memberRepository.save(member);        // 영속성 컨텍스트에만 들어간다. INSERT는 아직 안 나갔다

    // 문제: 쓰기 지연 때문에 INSERT SQL이 아직 DB로 전송되지 않았다.
    // 커넥션은 같지만 DB 입장에서는 그 행이 존재하지 않는다.
    Integer count = jdbcTemplate.queryForObject(
            "SELECT count(*) FROM member WHERE email=?", Integer.class, member.getEmail());
    // count == 0
}
```

```java
// 고침: JPA에게 지금 SQL을 보내라고 지시한 뒤 조회한다
@Transactional
public void register(Member member) {
    memberRepository.save(member);
    entityManager.flush();   // 쌓여 있던 INSERT를 DB로 전송한다 (커밋은 아니다)
    Integer count = jdbcTemplate.queryForObject(...);   // 이제 1
}
```

**`flush()`는 커밋이 아니다.** 영속성 컨텍스트에 모아 둔 SQL을 지금 DB로 보내는 것일 뿐, 트랜잭션은 여전히 열려 있고 롤백하면 함께 사라진다. (쓰기 지연과 flush 시점의 상세는 `03-jpa-orm/15-flush-timing-and-sql-ordering.md`에 있다.)

## 3. 이 구조 위에서 벌어지는 일 — 비동기 경계, 동기화 콜백, OSIV

### 3-1. `@Async`·`CompletableFuture`에서 트랜잭션이 안 타는 이유

지금까지 본 것을 한 문장으로 줄이면 **"트랜잭션 리소스는 스레드에 걸려 있다"**이다. 이 문장 하나에서 비동기 경계의 모든 현상이 따라 나온다.

**새 스레드는 빈 `ThreadLocalMap`을 갖고 시작한다.** 원래 스레드가 무엇을 걸어 뒀든 새 스레드에는 아무것도 없다.

```
[요청 스레드 http-nio-8080-exec-3]              [비동기 스레드 task-1]
 ThreadLocalMap                                  ThreadLocalMap
 ├─ resources ──> {                              ├─ resources ──> (없음)
 │     HikariDataSource@1a2b :                   │
 │         ConnectionHolder(Connection#7)  }     │
 ├─ synchronizations ──> { ... }                 ├─ synchronizations ──> (없음)
 ├─ actualTransactionActive ──> true             ├─ actualTransactionActive ──> (없음)
 └─ currentTransactionName ──> "OrderService..." └─ currentTransactionName ──> (없음)

        같은 static 필드 resources 를 읽어도
        스레드마다 다른 ThreadLocalMap을 보므로 서로의 값이 보이지 않는다.
```

그래서 비동기 스레드에서 `DataSourceUtils.getConnection()`을 부르면 2-1의 ①이 실패하고 ②로 간다 — **풀에서 완전히 새 커넥션을 꺼낸다.** 이 커넥션은 원래 트랜잭션과 아무 관계가 없어서, `@Transactional`이 없으면 auto-commit으로 쿼리마다 즉시 확정되고 `@Transactional`이 있으면 **참여가 아니라 완전히 별개인 새 트랜잭션**이 열린다.

이 사실이 만드는 사고가 이것이다.

```java
// before: 트랜잭션 안에서 @Async를 직접 호출 — 레이스가 생긴다
@Transactional
public Order complete(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();                            // 아직 커밋 전이다

    statisticsService.aggregateAsync(orderId);   // @Async — 새 스레드가 즉시 출발한다
    return order;
}   // 커밋은 여기서 일어난다

// 비동기 스레드는 별개 커넥션·별개 트랜잭션이므로, 커밋 전에 조회하면
// 완료 처리 이전 상태를 읽는다. 조용히 잘못된 집계가 만들어지고 에러도 안 난다.
```

`@Async` 자체의 동작 원리와 스레드풀·예외 처리 함정은 `15-async-annotation.md`에 있다. 여기서 필요한 결론은 하나다. **비동기 작업이 원 트랜잭션의 커밋된 데이터를 전제한다면, 실행 시작 시점 자체를 커밋 뒤로 보장해야 한다.** 방법은 3-4에서 본다.

### 3-2. "그러면 리소스 맵을 물려주면 되지 않나요?" — 절대 안 된다

`TaskDecorator`(비동기 작업 실행 전후에 훅을 거는 스프링 인터페이스)로 요청 스레드의 `ThreadLocal` 값을 복사해 넘기는 기법이 있다. MDC나 `SecurityContext`를 전파할 때 실제로 쓴다. 그러면 트랜잭션 리소스도 그렇게 넘기면 되지 않을까.

**안 된다. 두 가지가 동시에 깨진다.**

**첫째, JDBC `Connection`은 스레드세이프하지 않다.** 두 스레드가 같은 커넥션에 동시에 statement를 날리면 프로토콜 수준에서 깨진다. 응답이 뒤섞이거나 드라이버가 예외를 던지거나, 최악의 경우 조용히 잘못된 결과를 돌려준다. 두 스레드가 같은 커넥션을 쥔 순간 이미 깨진 설계다.

**둘째, 라이프사이클이 붕괴한다.** 이쪽이 더 위험하다.

```
[요청 스레드]                          [비동기 스레드]
 tx 시작, Connection#7 바인딩
 ├─ 리소스 맵 복사해서 전달 ─────────>  Connection#7을 쥐고 작업 시작
 │
 커밋 완료
 Connection#7을 풀에 반환                  아직 #7로 쿼리 중
 │                                         │
 ▼                                         ▼
 풀이 #7을 [다른 요청]에 다시 빌려줌   ← ★ 서로 다른 요청의 쿼리가
                                            한 커넥션·한 트랜잭션에 섞인다
```

풀은 반환된 커넥션을 다음 요청에 그대로 빌려준다. 그런데 비동기 스레드가 아직 그 커넥션을 쓰고 있으면, **A 요청의 비동기 작업과 B 요청의 처리가 같은 트랜잭션 안에 들어간다.** B가 롤백하면 A의 작업까지 사라지고, A가 커밋하면 B의 중간 상태가 확정된다. 재현도 안 되고 로그로도 안 잡히는, 가장 나쁜 종류의 버그다.

**정리하면 이렇다.** `TaskDecorator`로 전파해도 되는 것은 MDC·`SecurityContext`처럼 **읽기 전용 컨텍스트**이지, 소유권과 수명이 있는 트랜잭션 리소스가 아니다. 경계를 넘어야 하는 작업은 리소스를 물려받는 것이 아니라 **자기 트랜잭션을 새로 여는 것**이 정석이다.

### 3-3. 동기화 콜백 — `synchronizations` 저장소가 하는 일

1-3에서 본 두 번째 저장소 `synchronizations`가 이제 등장한다. 여기에는 **트랜잭션의 특정 시점에 불릴 콜백**이 등록된다.

콜백을 직접 등록하는 코드는 이렇게 생겼다.

```java
@Transactional
public void placeOrder(OrderRequest request) {
    Order order = orderRepository.save(Order.of(request));

    // 등록만 하고 지금 실행되지는 않는다.
    // isSynchronizationActive()가 false면(= 트랜잭션 밖이면) IllegalStateException이 난다.
    TransactionSynchronizationManager.registerSynchronization(
        new TransactionSynchronization() {

            @Override
            public void beforeCommit(boolean readOnly) {
                // 아직 커밋 전이다. 여기서 하는 DB 쓰기는 원 트랜잭션에 그대로 포함된다.
                // "커밋 직전에 마지막으로 검증하거나 파생 데이터를 남기는" 자리다.
            }

            @Override
            public void afterCommit() {
                // 커밋이 성공했을 때만 불린다. 캐시 무효화·알림 발송처럼
                // "확정된 뒤에만 해야 하는" 일의 자리다.
                // 여기서 예외를 던져도 커밋은 이미 끝나서 롤백되지 않는다.
                cacheManager.evict("orders", order.getId());
            }

            @Override
            public void afterCompletion(int status) {
                // 커밋이든 롤백이든 항상 불린다. try-finally의 finally에 해당한다.
                if (status == STATUS_ROLLED_BACK) {
                    metrics.increment("order.rollback");
                }
            }
        });
}
```

호출 순서를 도식으로 고정해 두자. **이 순서를 외우고 있는지가 이 문서의 실질적 변별점**이다.

```
[커밋 경로]
  @Transactional 메서드 정상 종료
    │
    ├─ beforeCommit(readOnly)          아직 커밋 전. 여기서의 DB 쓰기는 같은 트랜잭션에 포함
    │
    ├─ beforeCompletion()              커밋/롤백 공통의 사전 정리. 결과는 아직 미확정
    │
    ├─ ★ 실제 COMMIT (con.commit())    여기서 DB에 확정된다
    │
    ├─ afterCommit()                   커밋 성공 시에만. 예외를 던져도 되돌릴 수 없다
    │
    ├─ afterCompletion(STATUS_COMMITTED)   커밋/롤백 공통의 사후 정리
    │
    └─ [리소스 언바인딩 + 커넥션 풀 반환]   ← 언바인딩은 콜백이 전부 끝난 뒤다

[롤백 경로]
    ├─ beforeCompletion()              beforeCommit은 불리지 않는다
    ├─ ★ 실제 ROLLBACK
    ├─ afterCompletion(STATUS_ROLLED_BACK)
    └─ [언바인딩 + 반환]
```

마지막 줄에 중요한 사실이 숨어 있다. **`afterCommit`과 `afterCompletion`이 실행되는 시점에도 커넥션은 아직 스레드에 바인딩된 채다.** 언바인딩은 콜백이 전부 끝난 다음이다.

그래서 이런 함정이 생긴다. `afterCommit` 안에서 JPA로 엔티티를 수정하면, 2-1의 분기가 여전히 바인딩된 리소스를 찾아 주므로 **코드는 에러 없이 잘 돈다.** 그런데 트랜잭션은 이미 커밋이 끝났으므로 그 변경은 flush될 기회를 얻지 못하고 **조용히 사라진다.** 에러가 안 나는 것이 이 버그의 가장 나쁜 점이다. 확실히 저장하려면 `@Transactional(propagation = REQUIRES_NEW)`로 새 트랜잭션을 열어야 한다 (전파 옵션은 `12-transaction-propagation-required-vs-requires-new.md`).

### 3-4. `@TransactionalEventListener`는 이 기계 위에 얹힌 것이다

3-3의 콜백을 직접 등록하는 코드를 실무에서 자주 쓰지는 않는다. **`@TransactionalEventListener`가 그것을 감싼 편의 장치**이기 때문이다.

```java
@Transactional
public void complete(Long orderId) {
    ...
    eventPublisher.publishEvent(new OrderCompletedEvent(orderId));
    // 스프링은 이 이벤트를 즉시 리스너에 전달하지 않고,
    // registerSynchronization()으로 콜백에 등록해 뒀다가 지정된 phase에 실행한다.
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) { ... }
```

phase와 콜백의 대응은 그대로 1:1이다.

| `TransactionPhase` | 실제로 불리는 콜백 |
|---|---|
| `BEFORE_COMMIT` | `beforeCommit()` |
| `AFTER_COMMIT` (기본값) | `afterCommit()` |
| `AFTER_ROLLBACK` | `afterCompletion(STATUS_ROLLED_BACK)` |
| `AFTER_COMPLETION` | `afterCompletion(...)` |

**그래서 3-3의 함정이 `@TransactionalEventListener`에도 그대로 적용된다.** `AFTER_COMMIT` 리스너에서의 DB 쓰기가 조용히 사라지는 현상, `@Async`를 붙이면 새 스레드라 바인딩이 없어져 일반 `@Transactional`로도 저장되는 차이 — 전부 이 절의 구조에서 나온다. 이벤트 쪽의 사용법·phase 선택·실패 경로 설계는 `16-spring-event-transactional-event-listener.md`가 본론이므로 그쪽에 맡기고, 여기서 기억할 것은 **"그 편의 장치의 아래에 `synchronizations` 저장소와 네 개의 콜백이 있다"**는 연결이다.

### 3-5. OSIV — 같은 바인딩 구조를 요청 끝까지 늘려 놓은 것 (가산점 포인트)

이 구조를 알면 OSIV(Open Session In View)가 무엇을 하는 장치인지도 한 문장으로 설명된다.

**OSIV는 트랜잭션이 끝나도 `EntityManagerHolder`의 바인딩을 풀지 않고 HTTP 응답이 끝날 때까지 유지하는 장치다.** 스프링 부트의 `spring.jpa.open-in-view` 기본값이 `true`라 기본으로 켜져 있고, 구현은 `OpenEntityManagerInViewInterceptor`가 요청 시작 시 `EntityManager`를 만들어 2-4에서 본 바로 그 리소스 맵에 바인딩하고 응답 완료 시 언바인딩하는 것이다.

즉 **트랜잭션 경계와 영속성 컨텍스트 경계를 일부러 어긋나게 만든다.** 그래서 서비스 메서드에서 트랜잭션이 끝난 뒤에도 컨트롤러나 JSON 직렬화 단계에서 지연 로딩이 통과한다.

대가는 **커넥션 반환 시점**이다. 컨트롤러나 응답 단계에서 지연 로딩이 일어나면 그 시점에 다시 커넥션이 필요해지고, 그 커넥션은 요청이 끝날 때까지 붙잡힌다. 그 사이에 외부 API 호출 같은 느린 I/O가 있으면 **아무 일도 하지 않는 커넥션이 그 시간만큼 점유**되어, 22번 문서에서 본 것과 정확히 같은 형태로 풀이 마른다.

트레이드오프 전체와 이미 돌아가는 서비스에서 이 값을 안전하게 끄는 절차는 `03-jpa-orm/09-osiv-tradeoff-and-migration.md`가 본론이다. 이 문서에서 얻을 것은 **OSIV가 별도의 마법이 아니라 지금까지 본 바인딩 구조의 수명을 늘린 것뿐**이라는 이해다.

## 4. 꼬리질문 대비 포인트

### "멀티 데이터소스 환경에서는 어떻게 동작하나요?"

리소스 맵의 **키가 `DataSource` 객체**이므로 데이터소스마다 따로 바인딩된다. 그래서 두 DB를 동시에 쓰는 것 자체는 아무 문제가 없다.

문제는 **`@Transactional`이 관리하는 것은 지정된 트랜잭션 매니저의 `DataSource` 하나뿐**이라는 점이다. `@Transactional("statsTxManager")` 안에서 main 데이터소스에 쿼리를 날리면, main 쪽에는 바인딩이 없으므로 풀에서 새 커넥션을 꺼내 auto-commit으로 즉시 확정된다. **트랜잭션이 롤백돼도 그 쓰기는 남는다.** 매니저 이름을 빼먹으면 `@Primary` 매니저가 선택되므로, 엉뚱한 DB에 트랜잭션이 열리는 사고도 흔하다.

둘을 원자적으로 묶으려면 `ChainedTransactionManager`(순차 커밋일 뿐 원자성이 없어 deprecated)나 JTA/XA인데, 실무의 답은 대개 **"묶어야 한다면 같은 DB에 있어야 한다"**는 설계 신호로 읽는 것이다.

### "트랜잭션 없이 JdbcTemplate만 쓰면 어떻게 되나요?"

2-1의 ①에서 바인딩을 못 찾으므로 ②로 간다. **쿼리마다 풀에서 커넥션을 꺼내 auto-commit으로 실행하고 즉시 반납한다.**

이 동작의 함의가 둘이다. 첫째, 쿼리 하나하나가 각각의 트랜잭션이므로 여러 쿼리 사이의 원자성이 없다. 둘째, **커넥션 점유 시간이 최소**라 읽기 전용 단순 조회에서는 오히려 효율적이다. 조회만 하는 메서드에 `@Transactional`을 습관적으로 붙이면 점유 구간만 길어지는 경우가 있으니, 여러 쿼리의 일관된 스냅샷이 필요한지 따져 보고 붙이는 것이 맞다.

### "`@Async` 메서드에 `@Transactional`을 붙이면 어떻게 되나요?"

**참여가 아니라 분리다.** 새 스레드의 리소스 맵이 비어 있으므로 원 트랜잭션에 합류할 방법이 없고, 풀에서 새 커넥션을 꺼내 **완전히 별개인 새 트랜잭션**이 열린다. 원 트랜잭션이 롤백돼도 이쪽은 이미 커밋됐을 수 있다.

여기에 별개의 함정이 하나 더 겹친다. **같은 클래스 안에서 `this.asyncMethod()`처럼 자기 자신을 호출하면 프록시를 타지 않아 `@Async`와 `@Transactional`이 둘 다 무시된다.** `@Async`가 무시되면 동기 실행이 되어 원 스레드에서 도는데, 이 경우엔 오히려 트랜잭션에 참여하게 되므로 **"어떤 날은 되고 어떤 날은 안 되는" 것처럼 보이는 혼란**이 생긴다. 호출 경로가 프록시를 지나는지부터 확인하는 것이 진단의 첫걸음이다 (`11-transactional-self-invocation.md`).

### "`AFTER_COMMIT`인데 롤백일 때도 남아야 하는 기록(감사 로그, 시도 이력)은 어떻게 하나요?"

`AFTER_COMMIT`은 롤백 시 아예 실행되지 않으므로 그 자리에 둘 수 없다. 선택지는 둘이다.

**`AFTER_COMPLETION`으로 옮긴다.** 커밋이든 롤백이든 실행되고 `status` 인자로 어느 쪽인지 알 수 있다. 다만 이 시점은 원 트랜잭션이 이미 끝난 뒤라 여기서의 DB 쓰기는 3-3의 함정에 걸린다 — `REQUIRES_NEW`로 새 트랜잭션을 열어야 실제로 저장된다.

**`REQUIRES_NEW`로 선커밋(write-ahead)한다.** 작업을 시작하기 전에 별도 트랜잭션으로 "시도했다"는 기록을 먼저 커밋해 두는 방식이다. 본 트랜잭션이 롤백돼도 그 기록은 남는다. 시도 이력이나 외부 호출 로그처럼 **실패 자체를 남겨야 하는** 데이터에는 이쪽이 정석이다.

주의할 점은 `REQUIRES_NEW`가 기존 트랜잭션을 **끝내는 것이 아니라 잠시 보류하고 새 트랜잭션을 여는** 것이라, 그동안 **커넥션을 2개 점유한다**는 사실이다. 풀 크기가 동시 요청 수보다 작으면 자기 교착이 생길 수 있다.

### "`TransactionSynchronization`을 직접 등록해 본 적이 있나요? 콜백 순서를 말해주세요." (시니어 변별 포인트)

순서는 `beforeCommit → beforeCompletion → 실제 커밋 → afterCommit → afterCompletion → 리소스 언바인딩`이고, 롤백 경로에서는 `beforeCommit`이 빠진다.

각 자리의 성격을 함께 말하면 좋다. **`beforeCommit`은 아직 커밋 전이라 여기서의 DB 쓰기가 같은 트랜잭션에 포함**되고, **`afterCommit`은 확정 후라 여기서 예외를 던져도 되돌릴 수 없으며**, **`afterCompletion`은 커밋·롤백 공통의 `finally` 자리**다.

가장 중요한 디테일은 **언바인딩이 콜백 전부가 끝난 뒤에 일어난다**는 것이다. 그래서 `afterCommit`에서 JPA 쓰기를 하면 리소스가 아직 붙어 있어 에러 없이 실행되지만, 커밋할 트랜잭션이 없어 조용히 사라진다. 이 함정을 설명할 수 있으면 구조를 실제로 이해한 것으로 읽힌다.

실무에서 직접 등록이 필요한 경우도 짚어 두면 좋다. `@TransactionalEventListener`는 이벤트 객체를 만들어 발행해야 하는데, **한 메서드 안에서 로컬 변수를 붙잡아 커밋 후에 쓰고 싶은 정도의 일**이라면 익명 클래스로 `registerSynchronization`을 부르는 편이 짧다. 파일 업로드 후 커밋 실패 시 업로드된 파일을 지우는 정리 작업이 전형적인 예다 — `afterCompletion`에서 `status`를 보고 롤백이면 지운다.

### "OSIV는 이 구조와 어떤 관계인가요?" (가산점 포인트)

**OSIV는 같은 바인딩 구조의 수명을 요청 끝까지 늘려 놓은 것**이다. `OpenEntityManagerInViewInterceptor`가 요청 시작 시 `EntityManager`를 만들어 리소스 맵에 바인딩하고 응답 완료 시 언바인딩하므로, 서비스 트랜잭션이 끝난 뒤에도 영속성 컨텍스트는 살아 있다. 그래서 컨트롤러와 JSON 직렬화 단계의 지연 로딩이 통과한다.

여기서 정확히 말해야 하는 것은 **트랜잭션 경계와 영속성 컨텍스트 경계가 별개**라는 점이다. OSIV는 둘을 일부러 어긋나게 만드는 장치다.

대가는 컨트롤러·응답 단계의 지연 로딩이 커넥션을 다시 요구하고, 그 커넥션이 요청 끝까지 붙잡힌다는 것이다. 그 구간에 외부 API 호출 같은 느린 I/O가 있으면 **아무 일도 하지 않는 커넥션을 그 시간만큼 점유**하게 되어 풀이 마른다. 트레이드오프와 안전한 전환 절차는 `03-jpa-orm/09-osiv-tradeoff-and-migration.md`에 있다.

---

## 한 줄 요약

Spring 트랜잭션은 "풀에서 얻은 커넥션을 `TransactionSynchronizationManager`의 ThreadLocal 리소스 맵에 `DataSource`를 키로 바인딩해 두고, 모든 데이터 접근이 `DataSourceUtils`를 경유해 그것을 재사용"하는 구조라서 한 트랜잭션의 쿼리가 같은 커넥션을 타고 쿼리마다 `close()`를 불러도 안전하며, 이 규칙을 우회한 `dataSource.getConnection()`은 별개 커넥션·별개 트랜잭션을 만들어 방금 쓴 데이터가 안 보이고 커넥션도 두 개를 점유하게 만든다 — 저장소가 ThreadLocal이므로 스레드가 바뀌는 `@Async` 경계에서는 트랜잭션이 전파되지 않고 커넥션을 물려주는 것은 비스레드세이프와 풀 재대여 오염 때문에 금지이니 새 트랜잭션으로 분리해야 하며, 짝인 `synchronizations` 저장소의 `beforeCommit → beforeCompletion → 커밋 → afterCommit → afterCompletion → 언바인딩` 콜백 순서가 `@TransactionalEventListener`와 OSIV를 떠받치는 하부 기계다.
