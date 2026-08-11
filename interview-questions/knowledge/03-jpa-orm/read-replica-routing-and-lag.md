# read replica 라우팅과 replication lag — 코드에는 버그가 없는데 "쓰고 바로 읽으면 없어요"

> 핵심 관전 포인트: **라우팅의 골격은 세 조각이다 — `AbstractRoutingDataSource`를 상속해 `determineCurrentLookupKey()`에서 `TransactionSynchronizationManager.isCurrentTransactionReadOnly()`를 읽고 마스터/리플리카 키를 돌려준다.** 그런데 **이것만 붙이면 대개 동작하지 않는다.** 스프링은 트랜잭션을 시작하는 시점에 커넥션을 먼저 확보하는데, 그때는 아직 `readOnly` 플래그가 올라가기 전이라 라우팅 키가 항상 기본값(마스터)으로 잡힌다. **`LazyConnectionDataSourceProxy`로 감싸 실제 쿼리가 나가는 순간까지 커넥션 획득을 미뤄야** 비로소 라우팅이 걸린다 — "리플리카로 안 가는데요"의 1순위 원인이다. 그리고 **`@Transactional`이 아예 없는 조회는 라우팅 자체를 못 탄다.** 트랜잭션 밖에는 `readOnly` 정보가 존재하지 않기 때문이다. 그래서 규율(조회 메서드에 `readOnly = true`)이 필요하고, 규율은 사람이 아니라 **ArchUnit 룰과 런타임 카운터로 고정**한다. lag 쪽은 **"애플리케이션이 지연을 알 수 없다"는 전제부터 틀렸다** — `SHOW REPLICA STATUS`의 `Seconds_Behind_Source`, 더 정확하게는 **하트비트 테이블**(마스터에 주기적으로 현재 시각을 기록하고 리플리카에서 읽어 차이를 잰다)로 밀리초 단위 실측이 가능하고, 그 값이 헬스체크 지표가 된다. 마지막이 이 문항의 결론이다 — **읽기 일관성은 하나의 처방이 아니라 층으로 쌓는다**: ① 쓰기 응답에 결과를 담아 재조회 자체를 없애고 ② 쓴 직후 몇 초간은 **그 사용자의 요청만** 마스터로 보내고(read-your-writes) ③ 정합성이 필수인 조회만 명시적으로 마스터를 강제하고 ④ 지연이 임계치를 넘은 리플리카는 라우팅 풀에서 뺀다. **단, ④에는 반드시 상한과 폴백이 함께 와야 한다 — 리플리카를 다 빼면 그 부하를 마스터가 전부 받는다. 장애 대응이 장애를 만드는 전형이다.**

---

## 0. 질문 + 의도

**질문**: "멀티 DB(read replica) 환경에서 `@Transactional(readOnly = true)` 기반 라우팅을
어떻게 구현하나요? replication lag은 어떻게 다루나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**'쓰고 바로 읽었는데 없어요'라는, 코드에는
버그가 없는 버그.** 인프라 구조가 애플리케이션 로직에 스며드는 지점을 다뤄본 경험을
확인하며, **대용량 서비스는 replica 없이 운영이 불가능하므로 사실상 필수 경험 검증**이다."

세 문장 각각이 채점 지점이다.

- **"코드에는 버그가 없는 버그"** — 재현이 안 되고, 로컬에서는 절대 안 나오고, 테스트도
  전부 통과한다. **증상에서 인프라 구조로 거슬러 올라가는 진단 능력**을 본다.
- **"인프라 구조가 애플리케이션 로직에 스며드는 지점"** — 이게 이 문항의 본질이다.
  마스터/리플리카 분리는 인프라 팀의 결정인데, 그 결과로 **애플리케이션 코드에
  `@Transactional(readOnly = true)`라는 규율이 생기고, 세션에 마지막 쓰기 시각을 기록하는
  로직이 생기고, 헬스체크 스케줄러가 생긴다.** "인프라는 인프라 팀이 알아서"가 성립하지
  않는 영역이라는 걸 아는지를 본다.
- **"사실상 필수 경험 검증"** — 일정 규모 이상 서비스에서 리플리카는 옵션이 아니다.
  경험이 없다면 최소한 **구현 장치의 이름과 함정**은 알고 있어야 한다는 뜻이다.

**함정 두 개**:

- **"`readOnly`를 보고 DB를 고르면 된다"에서 멈추는 것.** 방향은 맞지만 이건 요구사항을
  다시 말한 것에 가깝다. 면접관은 바로 **"그 판단을 정확히 어디서 하나? 어떤 클래스인가?"**
  로 들어온다. 그리고 그 다음이 진짜 관문인 `LazyConnectionDataSourceProxy`다.
- **lag을 "어쩔 수 없는 것"으로 두는 것.** "복제 지연은 DB 특성이라 애플리케이션이 할 수
  있는 게 없다"고 답하면 절반이 날아간다. **지연은 측정 가능하고, 측정되면 라우팅
  결정에 쓸 수 있다.** 그리고 그 조치가 새 장애를 만들지 않도록 상한을 두는 것까지가 답이다.

---

## 1. 라우팅의 골격 — "readOnly를 보고 고른다"를 코드로 내리면

### 1-1. 판단이 일어나는 정확한 지점

스프링에는 **"커넥션을 달라고 할 때마다 어느 DataSource에서 꺼낼지 그 자리에서 고르는"**
DataSource가 있다. `AbstractRoutingDataSource`다.

```java
// 스프링이 제공하는 골격 (개념적으로 이런 모양이다)
public abstract class AbstractRoutingDataSource implements DataSource {

    private Map<Object, DataSource> resolvedDataSources;   // 키 → 실제 DataSource
    private DataSource resolvedDefaultDataSource;          // 키를 못 찾았을 때

    @Override
    public Connection getConnection() throws SQLException {
        return determineTargetDataSource().getConnection();
    }

    protected DataSource determineTargetDataSource() {
        Object key = determineCurrentLookupKey();          // ← 우리가 구현하는 곳
        DataSource ds = resolvedDataSources.get(key);
        if (ds == null) ds = resolvedDefaultDataSource;
        return ds;
    }

    protected abstract Object determineCurrentLookupKey();  // ← 이 한 메서드가 전부다
}
```

핵심은 이 구조가 **`Map<키, DataSource>` + "지금 키가 뭔지 알려주는 함수" 하나**로 되어
있다는 것이다. 우리가 할 일은 그 함수를 채우는 것뿐이다.

그러면 "지금 이 트랜잭션이 읽기 전용인가"는 어디서 알 수 있나. 스프링은 트랜잭션의
현재 상태를 **스레드에 묶인 전역 저장소**(`ThreadLocal`)에 올려두는데, 그 창구가
`TransactionSynchronizationManager`다.

```java
TransactionSynchronizationManager.isCurrentTransactionReadOnly()
// → 현재 스레드에서 진행 중인 트랜잭션이 @Transactional(readOnly = true) 인가?

TransactionSynchronizationManager.isActualTransactionActive()
// → 애초에 트랜잭션이 열려 있기는 한가? (뒤에서 중요해진다)
```

두 조각을 합치면 라우팅 판단부가 나온다.

```java
public class RoutingDataSource extends AbstractRoutingDataSource {

    @Override
    protected Object determineCurrentLookupKey() {
        return TransactionSynchronizationManager.isCurrentTransactionReadOnly()
                ? DataSourceKey.REPLICA
                : DataSourceKey.MASTER;
    }
}
```

**면접에서 이 세 이름(`AbstractRoutingDataSource` / `determineCurrentLookupKey` /
`TransactionSynchronizationManager.isCurrentTransactionReadOnly`)을 말할 수 있으면
"구현 장치를 안다"는 신호가 확실히 전달된다.** 그리고 여기까지가 **틀린 답**이다 —
정확히는 "여기까지만 하면 동작하지 않는다." 그 이유가 §2다.

### 1-2. 설정 코드 ① — 두 개(정확히는 세 개)의 DataSource 빈

먼저 물리 DataSource를 만든다. Spring Boot의 자동 설정에 맡기면 DataSource가 하나만
만들어지므로, 여기서는 직접 만든다.

```yaml
# application.yml
datasource:
  master:
    jdbc-url: jdbc:mysql://master.internal:3306/shop
    username: app
    password: ${DB_PASSWORD}
    maximum-pool-size: 20
  replicas:
    replica1:
      jdbc-url: jdbc:mysql://replica-1.internal:3306/shop
      username: app_ro
      password: ${DB_PASSWORD}
      maximum-pool-size: 30
    replica2:
      jdbc-url: jdbc:mysql://replica-2.internal:3306/shop
      username: app_ro
      password: ${DB_PASSWORD}
      maximum-pool-size: 30
```

> **설계 포인트**: 리플리카 계정을 **읽기 전용 권한(`app_ro`)** 으로 따로 파는 것을
> 권한다. 라우팅 버그로 쓰기가 리플리카로 흘러가면 **DB가 거부해서 시끄럽게 실패**한다.
> 조용히 잘못 동작하는 것보다 낫다. **안전망을 코드가 아니라 권한으로 거는 층**이다.

```java
public enum DataSourceKey { MASTER, REPLICA1, REPLICA2 }
```

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("datasource.master")
    public DataSource masterDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    @ConfigurationProperties("datasource.replicas.replica1")
    public DataSource replica1DataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    @ConfigurationProperties("datasource.replicas.replica2")
    public DataSource replica2DataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }
}
```

**커넥션 풀은 DataSource마다 따로 생긴다.** 즉 마스터 풀 20 + 리플리카 풀 30×2 = 총 80개의
커넥션을 이 애플리케이션 인스턴스가 잡을 수 있다는 뜻이다. 인스턴스가 10대면 800개다.
**각 DB 서버의 `max_connections` 안에 들어오는지 계산하고 잡아야 한다** — 라우팅 도입이
조용히 커넥션 총량을 늘린다는 것은 놓치기 쉬운 부작용이다.

### 1-3. 설정 코드 ② — 라우팅 DataSource

```java
public class RoutingDataSource extends AbstractRoutingDataSource {

    private final ReplicaRegistry replicaRegistry;   // 건강한 리플리카 목록 + 순번

    public RoutingDataSource(ReplicaRegistry replicaRegistry) {
        this.replicaRegistry = replicaRegistry;
    }

    @Override
    protected Object determineCurrentLookupKey() {
        DataSourceKey key = decide();
        MDC.put("dsKey", key.name());          // 로그로 어디로 갔는지 남긴다 (§8)
        RoutingMetrics.count(key);             // 마스터로 새는 조회 비율 관측 (§8)
        return key;
    }

    private DataSourceKey decide() {
        // ① 명시적 마스터 강제가 걸려 있으면 무조건 마스터 (§6-3, §6-4)
        if (MasterRouteContext.isForced()) {
            return DataSourceKey.MASTER;
        }
        // ② 읽기 전용 트랜잭션이 아니면 마스터
        if (!TransactionSynchronizationManager.isCurrentTransactionReadOnly()) {
            return DataSourceKey.MASTER;
        }
        // ③ 건강한 리플리카 중 하나. 하나도 없으면 마스터로 폴백 (§7)
        return replicaRegistry.next().orElse(DataSourceKey.MASTER);
    }
}
```

세 갈래를 **이 순서로** 두는 것이 중요하다.

- **①이 맨 앞인 이유** — "이 조회만은 반드시 최신값이어야 한다"는 요구는 `readOnly`
  여부보다 강하다. `readOnly = true` 트랜잭션이면서도 마스터로 가야 하는 경우가 실재한다
  (§6-3).
- **③의 `orElse(MASTER)`** — 리플리카가 전부 빠졌을 때 조회가 실패하는 대신 마스터로
  간다. **가용성을 택한 것이고, 그 대가가 §7의 "마스터가 전부 받는다"** 이다. 이
  한 줄이 폴백 설계 전체를 부르는 지점이라 그냥 지나치면 안 된다.

```java
@Bean
public DataSource routingDataSource(DataSource masterDataSource,
                                    DataSource replica1DataSource,
                                    DataSource replica2DataSource,
                                    ReplicaRegistry replicaRegistry) {

    RoutingDataSource routing = new RoutingDataSource(replicaRegistry);

    Map<Object, Object> targets = new EnumMap<>(DataSourceKey.class);
    targets.put(DataSourceKey.MASTER,   masterDataSource);
    targets.put(DataSourceKey.REPLICA1, replica1DataSource);
    targets.put(DataSourceKey.REPLICA2, replica2DataSource);

    routing.setTargetDataSources(targets);
    routing.setDefaultTargetDataSource(masterDataSource);   // 키를 못 찾으면 마스터
    return routing;
}
```

### 1-4. 설정 코드 ③ — 리플리카가 여러 대일 때 고르기

리플리카 2대를 번갈아 쓰려면 순번을 도는 선택기가 필요하다. 헬스체크(§5)와 붙여
"건강한 것 중에서만 고르는" 형태로 만든다.

```java
@Component
public class ReplicaRegistry {

    private static final List<DataSourceKey> ALL =
            List.of(DataSourceKey.REPLICA1, DataSourceKey.REPLICA2);

    /** 헬스체크 스케줄러가 갱신한다. 읽기는 초당 수천 번이므로 락 없이 읽어야 한다. */
    private volatile List<DataSourceKey> healthy = ALL;

    private final AtomicInteger cursor = new AtomicInteger();

    public Optional<DataSourceKey> next() {
        List<DataSourceKey> candidates = this.healthy;    // 스냅샷을 한 번만 읽는다
        if (candidates.isEmpty()) {
            return Optional.empty();
        }
        // getAndIncrement 는 Integer.MAX_VALUE 를 넘으면 음수가 된다 → floorMod 로 방어
        int i = Math.floorMod(cursor.getAndIncrement(), candidates.size());
        return Optional.of(candidates.get(i));
    }

    void updateHealthy(List<DataSourceKey> next) {        // §5 의 헬스체커가 호출
        this.healthy = List.copyOf(next);
    }
}
```

**세부 두 가지가 실무 신호가 된다.**

- **`volatile` + 통째 교체** — 목록을 그 자리에서 수정하지 않고 **새 불변 리스트로
  갈아끼운다.** 라우팅 경로는 모든 쿼리마다 지나가는 초고빈도 경로라 락을 걸면 안 되고,
  읽는 쪽이 중간 상태를 보면 안 된다.
- **`candidates`를 지역 변수로 한 번만 읽는 것** — `healthy.isEmpty()`와
  `healthy.get(i)` 사이에 스케줄러가 목록을 바꾸면 `IndexOutOfBoundsException`이 난다.
  **필드를 두 번 읽지 않는다**는 습관이다. **(가산점 포인트)**

분배 방식으로 라운드로빈이면 충분한가? 대부분 충분하다. 요청 하나하나가 짧고 균질하면
순번 분배가 곧 균등 분배다. **지연이 큰 리플리카에 가중치를 낮게 주는 방식**도 가능하지만,
지연이 큰 리플리카는 애초에 §5에서 목록에서 빠지므로 **"제외 아니면 균등"이라는 이진
정책이 운영상 단순하고 예측 가능하다.** 복잡한 가중치는 장애 시 "왜 이 리플리카로 갔나"를
설명하기 어렵게 만든다.

---

## 2. 이 문항의 최대 함정 — `LazyConnectionDataSourceProxy`

§1까지 만들고 배포하면 대개 이런 일이 생긴다.

> **"라우팅을 붙였는데 리플리카 쪽 QPS가 0입니다. 전부 마스터로 갑니다."**

코드는 맞다. `readOnly = true`도 잘 붙어 있다. 그런데 안 간다.

### 2-1. 원인은 "판단 시점"이 아니라 "커넥션을 언제 잡느냐"

`determineCurrentLookupKey()`는 **누군가 `getConnection()`을 부를 때** 실행된다. 그러니
질문은 하나로 좁혀진다 — **스프링은 커넥션을 정확히 언제 가져가는가?**

기본 동작에서는 **트랜잭션을 시작하는 그 순간**이다. 그리고 스프링이 `readOnly` 플래그를
`TransactionSynchronizationManager`에 올려놓는 것은 **트랜잭션 시작 처리가 끝난 뒤**다.
순서가 이렇게 어긋난다.

```
❌ BEFORE — LazyConnectionDataSourceProxy 없음

  시간 ──────────────────────────────────────────────────────────────▶

  ① @Transactional(readOnly = true) 프록시 진입
        │
  ② 트랜잭션 매니저가 트랜잭션을 연다 → DataSource.getConnection() 호출
        │      ↑
        │      └── 여기서 determineCurrentLookupKey() 가 실행된다
        │          이 시점의 isCurrentTransactionReadOnly() → false
        │          (readOnly 플래그가 아직 올라오지 않았다)
        │          ⇒ 키 = MASTER. 마스터 커넥션이 잡히고 트랜잭션에 묶인다.
        │
  ③ 트랜잭션 동기화 준비 → setCurrentTransactionReadOnly(true)
        │      ↑
        │      └── 이제야 readOnly 가 true 가 된다. 그러나 커넥션은 이미 마스터다.
        │
  ④ 실제 SELECT 실행 → 이미 잡아둔 마스터 커넥션을 그대로 쓴다
        │              (getConnection() 을 다시 부르지 않으므로 라우팅 기회 없음)
        │
  ⑤ 커밋/종료 → 마스터 커넥션 반환
```

**"라우팅 로직이 틀린 게 아니라, 라우팅 로직이 실행되는 시점이 너무 이르다."** 이 한
문장이 원인의 전부다.

### 2-2. 처방 — 커넥션 획득을 실제 쿼리 시점까지 미룬다

스프링에는 이 문제를 위해 만들어진 데코레이터가 있다. `LazyConnectionDataSourceProxy`다.

동작은 이름 그대로다. `getConnection()`을 부르면 **진짜 커넥션을 가져오지 않고 껍데기
프록시만 즉시 돌려준다.** 그 프록시에 대해 **처음으로 실제 SQL을 실행하려 할 때** 비로소
대상 DataSource의 `getConnection()`을 호출한다.

```java
@Bean
@Primary
public DataSource dataSource(DataSource routingDataSource) {
    return new LazyConnectionDataSourceProxy(routingDataSource);
}
```

`@Primary`가 붙은 이 빈이 JPA·`JdbcTemplate`이 실제로 쓰는 DataSource가 된다. 즉
**바깥에서 보이는 DataSource는 lazy 프록시이고, 그 안에 라우팅 DataSource가 들어 있고,
그 안에 물리 DataSource 세 개가 있다.** 순서를 뒤집으면(라우팅이 lazy를 감싸면) 아무
의미가 없다.

```
✅ AFTER — LazyConnectionDataSourceProxy 로 감쌈

  시간 ──────────────────────────────────────────────────────────────▶

  ① @Transactional(readOnly = true) 프록시 진입
        │
  ② 트랜잭션 매니저가 트랜잭션을 연다 → getConnection() 호출
        │      ↑
        │      └── lazy 프록시가 "빈 껍데기 커넥션"을 즉시 돌려준다.
        │          물리 커넥션은 아직 없다. 라우팅도 아직 안 일어났다.
        │
  ③ 트랜잭션 동기화 준비 → setCurrentTransactionReadOnly(true)   ← 플래그 세팅
        │
  ④ 실제 SELECT 실행
        │      ↑
        │      └── 이때 껍데기가 진짜 커넥션을 요청 → determineCurrentLookupKey() 실행
        │          이 시점의 isCurrentTransactionReadOnly() → true
        │          ⇒ 키 = REPLICA1. 리플리카 커넥션이 잡힌다. 🎉
        │
  ⑤ 커밋/종료 → 리플리카 커넥션 반환
```

**바뀐 것은 단 하나 — ③과 커넥션 획득의 순서가 뒤집혔다.** 그래서 라우팅 판단이 올바른
정보를 보고 이뤄진다.

### 2-3. 데코레이터 구성도

```
     JPA / JdbcTemplate 이 보는 DataSource
                 │
                 ▼
   LazyConnectionDataSourceProxy      ← 커넥션 획득을 첫 쿼리까지 미룬다
                 │
                 ▼
       RoutingDataSource              ← 그 순간 readOnly 를 보고 키를 고른다
          ┌──────┼──────┐
          ▼      ▼      ▼
       master  replica1  replica2     ← 각자 HikariCP 풀을 갖는다
```

### 2-4. 덤으로 따라오는 이득 — 놀고 있는 커넥션이 사라진다

`LazyConnectionDataSourceProxy`는 라우팅이 없어도 그 자체로 쓸 만한 도구다. **트랜잭션은
열렸지만 아직 쿼리를 하나도 안 한 구간에서 커넥션을 점유하지 않기 때문**이다.

```java
@Transactional
public void register(SignupCommand cmd) {
    validate(cmd);                       // 순수 검증 로직 300ms
    externalClient.verifyEmail(cmd);     // 외부 API 200ms
    memberRepository.save(cmd.toEntity());   // ← 커넥션은 여기서 처음 필요하다
}
```

lazy 프록시가 없으면 위 메서드는 **첫 줄부터 커넥션을 잡고 500ms 동안 아무 일도 안 하면서
자리를 차지한다.** [OSIV 트레이드오프와 전환](osiv-tradeoff-and-migration.md)에서 다룬
**"아무 일도 하지 않는 커넥션을 잡는다"** 와 정확히 같은 문제이고, 처방도 같은 계열이다.
OSIV가 트랜잭션 **뒤쪽**의 낭비를 만든다면, lazy 프록시가 없는 상태는 트랜잭션 **앞쪽**의
낭비를 만든다. 두 문항을 이렇게 연결해 말하면 개별 지식이 아니라 **커넥션 점유 시간이라는
하나의 축**을 갖고 있다는 신호가 된다. **(가산점 포인트)**

### 2-5. lazy 프록시를 쓸 때 걸리는 것들

편의만 있는 도구는 아니다. 함께 말하면 "붙여봤다"로 읽힌다.

- **커넥션을 한 번도 안 잡는 트랜잭션이 생긴다.** 쿼리를 하나도 실행하지 않고 끝나는
  트랜잭션은 물리 커넥션을 아예 안 쓴다. 대개 이득이지만, "트랜잭션 = 커넥션 1개"라는
  전제로 만든 모니터링 대시보드가 있다면 숫자의 의미가 달라진다.
- **기본 속성을 미리 알려주지 않으면 시작 시 커넥션을 한 번 연다.** lazy 프록시는
  `Connection`의 auto-commit·격리 수준 기본값을 알아야 껍데기를 제대로 흉내 낼 수 있어서,
  모르면 대상 DataSource에서 커넥션을 하나 열어 확인한다. 기본값을 명시하면 그 과정을
  건너뛴다.

  ```java
  LazyConnectionDataSourceProxy proxy = new LazyConnectionDataSourceProxy();
  proxy.setTargetDataSource(routingDataSource);
  proxy.setDefaultAutoCommit(false);
  proxy.setDefaultTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
  ```

- **예외가 나는 위치가 뒤로 밀린다.** DB가 죽어 있으면 원래는 트랜잭션 시작에서 즉시
  실패하는데, lazy 프록시가 있으면 **첫 쿼리 지점에서 실패**한다. 스택트레이스가 가리키는
  자리가 달라지므로 장애 분석 시 헷갈릴 수 있다.

> **확인 범위**: "트랜잭션 시작 시점에 커넥션을 먼저 잡는다"는 동작의 **정확한 호출
> 순서는 트랜잭션 매니저 종류(`DataSourceTransactionManager` / `JpaTransactionManager`)와
> Hibernate의 커넥션 획득 모드 설정에 따라 달라질 수 있다.** 위 타임라인은 라우팅이
> 실패하는 전형적 형태를 설명하는 모델이다. **우리 환경에서 실제로 어떻게 도는지는
> 추론이 아니라 관측으로 확인한다** — §8의 "라우팅 키를 MDC에 넣어 로그로 찍기"가 바로
> 그 확인 수단이고, 5분이면 사실 여부가 끝난다. 면접에서도 "정확한 순서는 매니저 구현에
> 따라 다를 수 있어 라우팅 키를 로그로 확인한다"고 붙이면 오히려 신뢰도가 올라간다.

---

## 3. `@Transactional`이 없는 조회는 라우팅을 못 탄다

### 3-1. 왜 못 타나

라우팅 판단의 재료가 `TransactionSynchronizationManager.isCurrentTransactionReadOnly()`
하나다. 그런데 **트랜잭션이 아예 없으면 이 값은 그냥 `false`** 다. "읽기 전용이 아니다"가
아니라 **"읽기 전용이라는 정보 자체가 없다"** 이고, 결과는 마스터행이다.

```java
// ❌ BEFORE — 라우팅을 못 탄다
@Service
public class PostQueryService {

    public List<PostSummary> list(Pageable pageable) {   // @Transactional 없음
        return postRepository.findSummaries(pageable);
    }
}
```

여기서 흔한 오해 하나를 정리해야 한다. **"Spring Data JPA 리포지토리 메서드는 내부적으로
트랜잭션이 걸려 있지 않나?"** — 걸려 있다. `SimpleJpaRepository`에 `@Transactional`이
붙어 있어서 리포지토리 메서드 호출은 자체 트랜잭션에서 돈다. **하지만 그건 리포지토리
메서드마다 각각 열리는 트랜잭션이고**, 서비스 메서드에 아무것도 안 붙었다면 그 서비스는
**한 요청에서 여러 개의 짧은 트랜잭션**을 쓰는 셈이다.

- 조회 메서드 상당수는 리포지토리 기본 구현의 `readOnly = true` 덕에 **어쩌다 리플리카로
  갈 수도 있다.** 하지만 `@Query`로 직접 만든 메서드나 QueryDSL 커스텀 구현에는 그 보장이
  없다.
- 더 나쁜 것은 **결과가 균일하지 않다는 것**이다. 어떤 조회는 리플리카로 가고 어떤 조회는
  마스터로 가는데, 그 차이가 코드에 드러나지 않는다. **"의도한 대로 도는가"를 사람이 볼
  수 없는 상태**가 가장 나쁘다.

```java
// ✅ AFTER — 조회 서비스 메서드에는 반드시 붙인다
@Service
public class PostQueryService {

    @Transactional(readOnly = true)
    public List<PostSummary> list(Pageable pageable) {
        return postRepository.findSummaries(pageable);
    }
}
```

`readOnly = true`가 원래 갖고 있던 효과(변경 감지 스냅샷 생략, flush 생략)는
[조회 전용 DTO 프로젝션](dto-projection-for-read-only.md)에서 다뤘으므로 여기서는 반복하지
않는다. **다만 이 문항에서 강조할 것은 그 효과가 하나 더 늘었다는 사실이다** —
`readOnly = true`는 이제 성능 힌트가 아니라 **어느 DB로 갈지를 결정하는 라우팅 신호**다.
같은 애너테이션의 무게가 달라졌다.

### 3-2. 규율은 사람이 아니라 빌드가 지킨다 — ArchUnit

"조회 메서드에는 `readOnly = true`를 붙이자"는 컨벤션은, 팀이 커지고 시간이 지나면
반드시 새는 종류의 약속이다. 그리고 이 약속이 새면 **에러가 나지 않고 조용히 마스터
부하가 늘어난다.** 발견 경로가 없다.

그래서 빌드에서 막는다.

```java
@AnalyzeClasses(packages = "com.example",
                importOptions = ImportOption.DoNotIncludeTests.class)
class DataSourceRoutingRulesTest {

    private static final Pattern QUERY_METHOD =
            Pattern.compile("^(find|get|search|list|count|exists|load)[A-Z].*|^(find|get|list|count)$");

    @ArchTest
    static final ArchRule 조회_메서드는_readOnly_트랜잭션이어야_한다 =
            methods()
                .that().areDeclaredInClassesThat().resideInAPackage("..service..")
                .and().arePublic()
                .and().haveNameMatching(QUERY_METHOD.pattern())
                .should(readOnlyTransactional());

    @ArchTest
    static final ArchRule 쓰기_메서드에_readOnly를_붙이면_안_된다 =
            methods()
                .that().areDeclaredInClassesThat().resideInAPackage("..service..")
                .and().arePublic()
                .and().haveNameMatching("^(save|create|register|update|modify|delete|remove|cancel)[A-Z].*")
                .should(notReadOnlyTransactional());

    private static ArchCondition<JavaMethod> readOnlyTransactional() {
        return new ArchCondition<>("@Transactional(readOnly = true) 여야 한다") {
            @Override
            public void check(JavaMethod method, ConditionEvents events) {
                boolean ok = method.tryGetAnnotationOfType(Transactional.class)
                                   .map(Transactional::readOnly)
                                   .orElse(false);
                if (!ok) {
                    events.add(SimpleConditionEvent.violated(method,
                            method.getFullName() + " 은(는) 조회 메서드인데 "
                          + "@Transactional(readOnly = true) 가 없다 "
                          + "→ 리플리카로 라우팅되지 않고 마스터 부하가 된다"));
                }
            }
        };
    }
    // notReadOnlyTransactional() 은 위의 반대 조건
}
```

**두 방향을 모두 거는 것이 이 룰의 핵심이다.**

- **정방향**(조회에 `readOnly` 강제)이 잡는 것 — 마스터로 새는 조회.
- **역방향**(쓰기에 `readOnly` 금지)이 잡는 것 — **더 무서운 쪽**이다. 쓰기 메서드에
  실수로 `readOnly = true`가 붙으면 **변경 감지 기반 수정이 flush 자체를 건너뛰어 조용히
  사라진다.** 예외도 안 나고 로그도 없다. 게다가 라우팅까지 붙은 지금은 그 트랜잭션이
  **리플리카로 가서** INSERT/UPDATE가 권한 오류로 터지거나(읽기 전용 계정을 썼다면), 최악의
  경우 리플리카에 직접 쓰기가 들어가 복제가 깨진다.

**ArchUnit 룰의 한계도 같이 말해야 트레이드오프 서술이 된다.**

- **이름 규칙 기반이라 완전하지 않다.** `retrieveOrderHistory()` 같은 이름은 패턴에
  안 걸린다. 룰은 **탐지율 100%를 목표로 하는 게 아니라, 흔한 실수를 기계가 대신 보게
  하는 장치**다.
- **"조회처럼 생겼지만 실제로는 쓰는 메서드"를 구분하지 못한다.** `findOrCreate...`류가
  대표적이다. 이런 건 이름을 바꾸는 것이 룰을 예외 처리하는 것보다 낫다.
- 기존 코드에 위반이 대량으로 있다면 `FreezingArchRule.freeze(...)`로 현재 위반을 동결하고
  **신규 위반만 빌드를 깨게** 한다. 고치는 속도보다 늘어나는 속도가 빠르면 영원히 못
  끝난다([OSIV 문서](osiv-tradeoff-and-migration.md) §4-3과 같은 요령).

### 3-3. 이름 규칙이 못 잡는 것은 런타임이 잡는다

정적 룰의 구멍은 실행 시점 관측으로 메운다. **"트랜잭션 없이 실행된 쿼리"를 세는
카운터**를 하나 두면 된다.

```java
@Aspect
@Component
public class NonTransactionalQueryDetector {

    @Before("execution(* com.example..repository..*(..))")
    public void detect(JoinPoint jp) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            Metrics.counter("db.query.no_transaction",
                            "method", jp.getSignature().toShortString())
                   .increment();
            // 운영에서는 로그 폭탄이 되므로 샘플링하거나 메트릭만 남긴다
        }
    }
}
```

이 카운터가 0이 아니면 **라우팅을 못 타는 조회가 실재한다는 증거**이고, 태그에 그 메서드
이름이 그대로 찍힌다. 정적 룰은 "규칙을 어긴 코드"를 잡고, 이 카운터는 **"규칙이 미처
다루지 못한 코드"** 를 잡는다. 둘은 대체 관계가 아니라 보완 관계다.

---

## 4. "등록했는데 목록에 없어요" — 무슨 일이 일어난 것인가

### 4-1. 타임라인

제보를 그대로 시간축에 놓으면 원인이 그림 하나로 끝난다.

| 시각 | 마스터 | 리플리카 | 애플리케이션 / 사용자 |
|---|---|---|---|
| T+0ms | `INSERT INTO post ...` | | 글쓰기 요청, 쓰기 트랜잭션 시작 |
| T+4ms | **COMMIT 완료** | | |
| T+5ms | binlog에 이벤트 기록 | | **200 OK 응답** |
| T+8ms | | | 클라이언트가 목록 화면으로 이동 |
| T+10ms | | 아직 이벤트를 받지 못함 | `GET /posts` → `readOnly=true` → **리플리카로** |
| T+11ms | | SELECT 결과에 새 글 **없음** | **"등록했는데 목록에 없어요"** |
| T+60ms | | 이벤트 수신·적용 완료 | |
| T+3s | | 새 글 존재 | 사용자가 새로고침 → **이번엔 보임** |

**코드에는 버그가 없다.** INSERT는 성공했고 커밋도 됐다. SELECT도 정상이다. 두 문장 사이에
**"복제가 아직 안 끝난 40ms"** 가 끼어 있을 뿐이다. rationale이 말한 "코드에는 버그가 없는
버그"가 이것이다.

그리고 이 버그의 성질이 고약하다.

- **로컬·개발 환경에서 절대 재현되지 않는다.** 대개 DB가 한 대다.
- **재현율이 낮다.** 사용자가 조금 느리게 움직이면 안 나타난다. 그래서 "가끔 그래요"라는
  제보로만 들어온다.
- **테스트가 전부 통과한다.** 통합 테스트도 단일 DB를 쓴다면 이 경로를 아예 안 지난다.
- **트래픽이 늘수록 심해진다.** 복제 지연은 마스터의 쓰기량에 비례해 커진다. 즉
  **서비스가 잘될수록 나빠진다.**

### 4-2. 지연은 왜 생기고 언제 커지나

복제는 대략 이 세 구간을 거친다.

```
마스터: 트랜잭션 커밋 → binlog 기록
              │  (네트워크 전송)
              ▼
리플리카: I/O 스레드가 relay log 에 받아 적음
              │  (적용 대기 — 여기가 보통 가장 오래 걸린다)
              ▼
리플리카: SQL(적용) 스레드가 relay log 를 실제 테이블에 반영
```

**평소 50ms가 갑자기 초 단위로 벌어지는 전형적 원인**은 정해져 있다.

- **대량 쓰기 배치** — 100만 건 INSERT가 binlog로 쏟아지면 리플리카의 적용 스레드가
  못 따라간다([대량 INSERT와 JDBC batch](bulk-insert-jdbc-batch.md)의 작업이 바로 이걸
  만든다). 새벽 배치 시간대에 지연이 튀는 이유다.
- **마스터의 긴 단일 트랜잭션** — 한 트랜잭션이 큰 변경을 담으면 리플리카에서도 통째로
  적용되어야 한다.
- **리플리카에서 도는 무거운 조회** — 통계·리포트 쿼리가 리플리카의 CPU/IO를 먹으면 적용
  스레드가 밀린다. **읽기 부하 분산이 지연을 만드는 자기모순**이다.
- **DDL / 스키마 변경** — 큰 테이블의 인덱스 추가 같은 작업.
- **리플리카 하드웨어가 마스터보다 약한 경우** — 비용 절감으로 흔히 벌어진다.

**이 목록이 실무에서 중요한 이유**: "지연을 어떻게 다루나"는 질문에 애플리케이션 처방만
말하면 절반이다. **지연을 만드는 쪽(배치 쓰기를 나눠서 커밋, 리포트 전용 리플리카 분리)을
같이 말해야** 원인과 증상을 모두 다룬 답이 된다.

---

## 5. "애플리케이션은 지연을 알 수 없다"는 오해

여기가 이 문항에서 가장 자주 틀리는 전제다. **알 수 있다.** 그것도 꽤 정확하게.

### 5-1. 방법 ① — 리플리카 상태를 물어본다

MySQL 계열이라면 리플리카에 직접 물어볼 수 있다.

```sql
SHOW REPLICA STATUS;     -- 최신 명칭
SHOW SLAVE STATUS;       -- 구 명칭 (버전에 따라 이쪽만 동작한다)
```

결과의 `Seconds_Behind_Source`(구 명칭 `Seconds_Behind_Master`)가 지연 추정치다. 가장
쉽게 얻을 수 있는 값이지만, **왜 부정확할 수 있는지를 같이 말해야** 이 값을 그대로
임계치에 쓰는 위험을 안다는 신호가 된다.

- **해상도가 초 단위다.** 300ms 지연도 700ms 지연도 전부 `0`으로 보인다. 그런데 우리가
  다루려는 문제(§4의 40ms)는 **1초 미만 영역**이다. 즉 **정작 필요한 구간에서 눈이 멀어
  있다.**
- **"적용 스레드가 지금 처리 중인 이벤트"를 기준으로 계산한다.** 그래서 네트워크가 막혀
  **아직 받아오지도 못한 이벤트는 계산에 안 들어간다.** I/O 스레드가 뒤처진 상황에서는
  실제보다 작게 나온다 — **가장 위험한 순간에 과소평가한다.**
- **마스터가 한가하면 `0`이다.** 쓰기가 없으면 밀릴 것도 없으니 정상이지만, "0이니까
  건강하다"는 판단을 자동화하면 **연결이 끊긴 상태와 구분이 안 되는** 경우가 생긴다.
- **복제가 멈추면 `NULL`** 이 된다. 숫자 비교만 하는 코드는 `NULL`을 조용히 무시하고
  "정상"으로 판단하기 쉽다. **`NULL`은 반드시 최악(제외)으로 취급해야 한다.**

### 5-2. 방법 ② — 하트비트 테이블 (더 정확한 쪽)

원리는 단순하다. **마스터에 "지금 몇 시"를 계속 적고, 리플리카에서 그 값을 읽어 현재
시각과 비교한다.** 그 차이가 곧 "이 리플리카는 몇 ms 전의 세상을 보고 있는가"다.

```sql
-- 마스터에서: 1초마다 한 행을 갱신한다 (복제를 타고 리플리카로 흘러간다)
REPLACE INTO replication_heartbeat (id, beat_at) VALUES (1, NOW(3));
```

```sql
-- 각 리플리카에서: 복제되어 온 시각과 지금을 비교한다
SELECT TIMESTAMPDIFF(MICROSECOND, beat_at, NOW(3)) / 1000 AS lag_ms
  FROM replication_heartbeat
 WHERE id = 1;
```

```java
@Component
@RequiredArgsConstructor
public class ReplicaLagHealthChecker {

    private static final long THRESHOLD_MS = 500;     // 라우팅 풀에서 뺄 기준
    private static final int  FAIL_STREAK  = 3;       // 연속 3회 초과 시 제외
    private static final int  OK_STREAK    = 5;       // 연속 5회 정상 시 복귀

    private final Map<DataSourceKey, JdbcTemplate> perReplica;   // 리플리카 직결 템플릿
    private final ReplicaRegistry registry;
    private final Map<DataSourceKey, Streak> streaks = new EnumMap<>(DataSourceKey.class);

    @Scheduled(fixedDelay = 1000)
    public void check() {
        List<DataSourceKey> healthy = new ArrayList<>();

        for (var entry : perReplica.entrySet()) {
            DataSourceKey key = entry.getKey();
            long lagMs = measure(entry.getValue());       // 실패·NULL 이면 Long.MAX_VALUE
            Metrics.gauge("db.replica.lag_ms", List.of(Tag.of("replica", key.name())), lagMs);

            Streak s = streaks.computeIfAbsent(key, k -> new Streak());
            if (s.record(lagMs <= THRESHOLD_MS, FAIL_STREAK, OK_STREAK)) {
                healthy.add(key);
            }
        }
        registry.updateHealthy(capExclusion(healthy));    // §7 — 제외에 상한을 건다
    }
}
```

**설계 포인트 네 개** — 이걸 말하면 "돌려본 사람"으로 읽힌다.

- **연속 횟수(streak)로 판단한다.** 한 번 튄 값으로 리플리카를 빼면 **깜빡이는(flapping)
  라우팅**이 된다. 나갔다 들어왔다 하면서 커넥션 풀이 계속 흔들리고, 원인 분석도 불가능해진다.
  **들어올 때의 조건을 나갈 때보다 빡빡하게(히스테리시스)** 두는 것이 정석이다.
- **측정 실패는 최악으로 친다.** 쿼리가 타임아웃 나거나 `NULL`이면 `Long.MAX_VALUE`.
  "모르면 건강하다"는 기본값은 헬스체크에서 가장 흔한 사고 원인이다.
- **헬스체크는 라우팅을 타면 안 된다.** 리플리카 각각에 직접 붙는 `JdbcTemplate`을 써야
  한다. 라우팅 DataSource로 헬스체크를 하면 **어느 리플리카를 재고 있는지 알 수 없다.**
- **하트비트는 덤을 준다.** 마스터가 한가해도 1초마다 쓰기가 발생하므로 §5-1의 "마스터가
  유휴하면 지연이 0으로 보이는" 문제가 사라지고, **복제 자체가 멈췄는지도 즉시 드러난다**
  (값이 갱신되지 않으면 lag이 선형으로 증가한다).

**하트비트의 전제와 한계도 정직하게 말한다.**

- **마스터와 리플리카의 시계가 맞아야 한다.** 시각을 비교하는 방식이므로 NTP 동기화가
  전제다. 시계가 어긋나면 지연이 음수로 나오는데, **음수가 나온다는 것 자체가 시계 문제의
  탐지 신호**이므로 그대로 알람을 걸어두면 된다.
- **해상도는 하트비트 주기가 결정한다.** 1초마다 찍으면 지연 측정 오차도 최대 1초 수준이다.
  더 정밀하게 보려면 주기를 줄여야 하고, 그만큼 마스터 쓰기와 binlog가 늘어난다.
- 이 방식은 널리 쓰이는 표준 기법이라 **전용 도구도 있다**(Percona Toolkit의
  `pt-heartbeat`). 직접 만들기 전에 이미 있는 도구를 먼저 보는 것도 답변에 넣을 만하다.

### 5-3. 두 방법의 자리

| 방법 | 정확도 | 얻는 것 | 못 보는 것 |
|---|---|---|---|
| `SHOW REPLICA STATUS` | 초 단위 | 즉시 사용 가능, 복제 중단 여부 | **1초 미만 지연**, 미수신 이벤트 |
| **하트비트 테이블** | **ms 단위** | 실제 체감 지연, 복제 중단도 함께 | 시계 동기화에 의존, 주기만큼의 오차 |

**둘 중 하나를 고르는 문제가 아니다.** 라우팅 판단(§7)에는 하트비트 값을 쓰고, 복제 중단
같은 굵은 이상은 상태 조회로 함께 확인하는 것이 실무 구성이다.

---

## 6. 읽기 일관성은 층으로 쌓는다

여기가 이 문항의 결론부다. **"lag은 어떻게 다루나"에 처방을 하나만 대면 반드시 구멍이
남는다.** 각 처방이 무엇을 해결하고 무엇을 못 해결하는지가 명확하므로, 층으로 쌓아야 한다.

| 층 | 처방 | 해결하는 것 | **해결 못 하는 것** | 비용 |
|---|---|---|---|---|
| ① | **쓰기 응답에 결과를 담아 재조회를 없앤다** | 방금 쓴 그 데이터를 바로 보여주는 화면 | 목록·집계 화면, 다른 화면으로 이동, 다른 기기 | API 설계 변경, 개발자가 매번 판단 |
| ② | **쓴 직후 N초간 그 사용자만 마스터로** | 그 사용자의 **모든** 후속 조회(read-your-writes) | 다른 사용자가 즉시 봐야 하는 경우, N초 경과 후, 쿠키/세션 없는 클라이언트 | 마스터 부하 소폭 증가 |
| ③ | **정합성 필수 조회만 명시적 마스터 강제** | 잔액·재고처럼 틀리면 안 되는 조회 | 개발자가 지정을 빠뜨린 지점 | 지정한 만큼 마스터 부하 |
| ④ | **지연 임계치 초과 리플리카를 풀에서 제외** | 배치·장애로 지연이 튀는 이상 상황 | **정상 범위 지연(수십 ms)에서의 read-your-writes** | **마스터 과부하 위험(§7)** |

**표에서 읽어야 할 것**: ④는 ①②③을 대체하지 못하고, ①②③도 ④를 대체하지 못한다.
④는 **이상 상황**을 다루고, ①②③은 **정상 상황에서도 남는 수십 ms**를 다룬다. 성격이 다른
층이다.

### 6-1. 층 ① — 쓰기 응답에 결과를 담는다

가장 먼저 시도할 처방이다. **lag을 우회하는 게 아니라 lag을 만나는 상황 자체를 없앤다.**

```java
// ❌ BEFORE — 쓰고 나서 다시 읽는다 (그 사이에 lag 이 끼어든다)
@PostMapping("/posts")
public ResponseEntity<Void> create(@RequestBody PostCreateRequest req) {
    postService.create(req);
    return ResponseEntity.created(...).build();
}
// 클라이언트: 201 을 받고 GET /posts 를 호출 → 리플리카 → 새 글 없음

// ✅ AFTER — 쓰기 응답이 결과를 그대로 돌려준다
@PostMapping("/posts")
public ResponseEntity<PostResponse> create(@RequestBody PostCreateRequest req) {
    PostResponse created = postService.create(req);   // 마스터 트랜잭션 안에서 만든 응답
    return ResponseEntity.created(...).body(created);
}
// 클라이언트: 응답의 데이터를 목록 맨 위에 끼워 넣는다 → 재조회 없음 → lag 무관
```

이 처방의 좋은 점은 **읽기 일관성 문제를 "해결"하는 게 아니라 "발생시키지 않는다"** 는
것이다. 마스터 부하도 안 늘고, 라운드트립도 하나 줄어든다.

**대신 못 덮는 범위가 분명하다.**

- **목록 전체**를 보여줘야 하는 화면(내가 쓴 글 하나만이 아니라 남의 글까지 정렬된 목록)
- **다른 화면으로 이동**한 뒤의 조회
- **집계·카운트**가 함께 바뀌는 경우("내 글 수 12 → 13")
- **다른 기기·다른 탭**에서 보는 경우
- 그리고 결정적으로, **개발자가 매 API마다 이걸 판단해야 한다.** 판단이 누락된 화면은
  지연이 커지는 순간 조용히 깨진다.

그래서 ①은 **훌륭한 첫 층이지만 마지막 층일 수 없다.**

### 6-2. 층 ② — 쓴 직후 N초간, 그 사용자의 요청만 마스터로

**read-your-writes(자기가 쓴 것은 자기가 읽을 수 있다)를 전역 성능 손해 없이 만족시키는
표준 기법**이다. 아이디어가 이 문항 전체에서 가장 값어치 있는 한 줄이다.

> **"방금 쓴 사람만" 잠깐 마스터로 보낸다.** 전체 트래픽에서 그런 사용자는 극소수라
> 마스터 부하는 거의 안 늘고, 정작 문제가 되는 사용자 경험은 전부 사라진다.

구현은 두 조각이다.

**(1) 쓰기가 커밋되면 그 시각을 기록한다.**

```java
@Aspect
@Component
public class WriteMarkAspect {

    /** 쓰기 트랜잭션이 '커밋된 뒤'에 표시를 남긴다. 롤백되면 남기지 않는다. */
    @Around("@annotation(org.springframework.transaction.annotation.Transactional) "
          + "&& within(com.example..service..*)")
    public Object mark(ProceedingJoinPoint pjp) throws Throwable {
        Object result = pjp.proceed();

        if (TransactionSynchronizationManager.isSynchronizationActive()
                && !TransactionSynchronizationManager.isCurrentTransactionReadOnly()) {
            TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override public void afterCommit() {
                        RecentWriteMarker.mark();     // 응답 쿠키에 커밋 시각을 심는다
                    }
                });
        }
        return result;
    }
}
```

**`afterCommit`에서 기록하는 것이 핵심이다.** 롤백된 트랜잭션까지 마스터 강제를 걸면
아무 이유 없이 마스터 부하만 늘어난다.

**(2) 다음 요청이 들어오면, 표시가 아직 유효한지 보고 마스터를 강제한다.**

```java
@Component
public class ReadYourWritesFilter extends OncePerRequestFilter {

    private final Duration window;   // = 관측된 지연의 p99 + 여유 (§5 의 지표에서 정한다)

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            RecentWriteMarker.lastWriteAt(req)                       // 서명된 쿠키에서 읽는다
                    .filter(at -> Duration.between(at, Instant.now()).compareTo(window) < 0)
                    .ifPresent(at -> MasterRouteContext.force());    // 이 요청은 마스터로

            chain.doFilter(req, res);
        } finally {
            MasterRouteContext.clear();     // ThreadLocal 은 반드시 정리한다
        }
    }
}
```

```java
public final class MasterRouteContext {

    private static final ThreadLocal<Boolean> FORCED = new ThreadLocal<>();

    public static void force()      { FORCED.set(Boolean.TRUE); }
    public static boolean isForced(){ return Boolean.TRUE.equals(FORCED.get()); }
    public static void clear()      { FORCED.remove(); }
}
```

**놓치면 사고가 되는 세부 네 가지.**

- **`ThreadLocal`은 `finally`에서 반드시 지운다.** 톰캣은 스레드를 재사용하므로 안 지우면
  **다음 사용자의 요청까지 마스터로 간다.** 트래픽이 많을수록 조용히 번지고, 증상은
  "마스터 부하가 왜 안 줄지" 하나뿐이라 원인을 찾기 매우 어렵다.
- **판단은 트랜잭션이 열리기 전(필터)에 끝나야 한다.** §2에서 봤듯 커넥션이 한 번 잡히면
  트랜잭션 도중에는 바꿀 수 없다. **필터가 맞는 자리다.**
- **세션이 아니라 쿠키를 권한다.** 인스턴스가 여러 대인 환경에서 세션은 스티키 설정이나
  세션 저장소가 필요하다. 쿠키는 그런 게 필요 없다. 다만 **클라이언트가 값을 조작하면
  마스터로 무한히 보낼 수 있으므로 서명(HMAC)이 필요**하고, 그마저 신뢰가 어렵다면
  Redis에 `userId → lastWriteAt`을 짧은 TTL로 두는 방식이 낫다. **(가산점 포인트)**
- **창(window)의 길이는 감이 아니라 지표로 정한다.** §5에서 재는 지연의 상위 백분위수에
  여유를 더한 값을 쓰고, 지연 분포가 변하면 창도 조정한다. **창이 짧으면 문제가 남고,
  길면 마스터 부하가 는다** — 이 교환 관계를 수치로 관리한다는 것이 답변의 완성이다.

**층 ②가 못 덮는 것**도 분명히 말한다. **"다른 사용자가 즉시 봐야 하는 경우"** 는
여전히 남는다. 예를 들어 상담원이 고객의 방금 변경사항을 봐야 하는 화면이라면, 쓴 사람과
읽는 사람이 다르므로 이 기법이 작동하지 않는다. 그런 화면은 층 ③으로 내려간다.

### 6-3. 층 ③ — 정합성이 필수인 조회만 마스터를 강제한다

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiresMaster {}
```

```java
@Aspect
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)   // @Transactional 보다 먼저 실행돼야 한다
public class RequiresMasterAspect {

    @Around("@annotation(com.example.routing.RequiresMaster)")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        boolean alreadyForced = MasterRouteContext.isForced();
        if (!alreadyForced) MasterRouteContext.force();
        try {
            return pjp.proceed();
        } finally {
            if (!alreadyForced) MasterRouteContext.clear();
        }
    }
}
```

```java
@RequiresMaster
@Transactional(readOnly = true)
public Balance currentBalance(Long accountId) {   // 잔액은 최신이어야 한다
    return accountRepository.findBalance(accountId);
}
```

**`@Order(HIGHEST_PRECEDENCE)`가 중요하다.** 트랜잭션이 열리기 전에 플래그가 서야
§2의 순서 문제에 걸리지 않는다. 이 애스펙트가 `@Transactional`보다 늦게 돌면 아무 효과가
없다 — **그리고 아무 에러도 안 난다.** 관측(§8) 없이는 발견 불가능한 부류의 버그다.

**중첩 호출을 고려한 `alreadyForced` 처리**도 놓치기 쉽다. 마스터 강제 메서드 안에서 다른
마스터 강제 메서드를 부르면, 안쪽이 끝날 때 플래그를 지워버려 **바깥쪽의 나머지 조회가
리플리카로 새는** 일이 생긴다.

**이 층의 근본 한계**: **개발자가 붙이는 것을 잊으면 아무 일도 일어나지 않는다.** 그래서
"정합성이 중요한 조회는 마스터로"라는 답만 단독으로 내면 부족하다. **어떤 조회가 정합성
필수인지 판별하는 기준**을 함께 말해야 한다. 실무 기준은 대개 이렇다.

- **그 값을 근거로 쓰기를 결정하는 조회** — 잔액 확인 후 차감, 재고 확인 후 예약.
  (사실 이런 것은 애초에 조회-판단-쓰기를 한 트랜잭션에 묶거나 원자적 UPDATE로 바꾸는 게
  맞다 — [동시성 업데이트 4가지 접근](concurrency-update-four-approaches.md))
- **금전·권한처럼 틀렸을 때 되돌리기 비싼 것**
- **방금 쓴 사람이 아닌 제3자가 즉시 확인해야 하는 화면**(관리자·상담원)

### 6-4. 층 ④ — 지연이 큰 리플리카를 뺀다

§5의 헬스체커가 이미 만들어둔 층이다. 여기서는 **성격**만 못 박는다.

**이 층은 read-your-writes를 해결하지 않는다.** 임계치를 500ms로 잡아도 §4의 40ms 지연은
그대로 남아 있고, "등록했는데 목록에 없어요"는 여전히 발생한다. ④가 막는 것은
**"새벽 배치 때 5초"처럼 정상 범위를 벗어난 상황에서 전체 조회 품질이 무너지는 것**이다.

**그리고 이 층은 혼자 두면 위험하다.** 그 이유가 §7이다.

---

## 7. "리플리카를 다 빼면 마스터가 그 부하를 다 받는다"

### 7-1. 장애 대응이 장애를 만드는 전형

시나리오를 끝까지 따라가 보자.

```
새벽 2시, 대량 배치가 돈다
   → 리플리카 2대 모두 지연 5초
   → 헬스체커: 둘 다 임계치 초과 → 라우팅 풀에서 제외
   → 모든 조회가 마스터로 폴백 (§1-3 의 orElse(MASTER))
   → 마스터는 이미 배치 쓰기로 바쁘다. 여기에 조회 트래픽 전량이 얹힌다
   → 마스터 커넥션 풀 고갈 → 쓰기까지 느려짐
   → 배치가 더 느려짐 → binlog 가 더 밀림 → 리플리카 지연이 더 커짐
   → 복귀 조건은 영원히 충족되지 않는다
   ⇒ 읽기 지연을 막으려던 조치가 전면 장애를 만들었다
```

**"지연된 데이터를 보여주지 않으려다, 아무것도 보여주지 못하게 됐다."** 이 문장이 이
문항의 시니어 포인트다. 제외 로직은 **그 자체가 부하 이동 장치**이므로, 이동한 부하를
받을 쪽의 여력을 반드시 함께 설계해야 한다.

### 7-2. 반드시 함께 오는 네 가지

**(1) 제외에 상한을 둔다.**

```java
/** 전체 리플리카의 절반 미만까지만 제외한다. 그 이상이면 '전부 제외'가 아니라 다른 모드로 간다. */
private List<DataSourceKey> capExclusion(List<DataSourceKey> healthy) {
    int total = ALL.size();
    if (healthy.size() >= (total + 1) / 2) {
        return healthy;
    }
    // 절반 이상을 빼야 하는 상황 = 개별 리플리카 문제가 아니라 시스템 전체 문제다.
    // 이때는 "지연을 감수하고 계속 리플리카를 쓴다"가 더 나은 선택인 경우가 많다.
    Alerts.critical("복제 지연이 광범위하다. 지연 허용 모드로 전환한다.");
    Metrics.counter("db.replica.degraded_mode").increment();
    return ALL;              // 전부 되돌린다 — 느린 데이터가 없는 데이터보다 낫다
}
```

**판단의 근거를 한 문장으로**: *리플리카 한 대만 이상하면 그건 그 리플리카의 문제이므로
빼는 게 맞다. 전부 이상하면 그건 복제 전체의 문제이고, 마스터도 이미 아프다는 뜻이므로
빼면 안 된다.* **"몇 대가 아픈가"가 아니라 "무엇이 아픈가"를 보고 판단이 갈린다.**

**(2) 마스터 폴백에 서킷 브레이커를 건다.** 폴백으로 마스터에 가는 조회가 일정 비율·건수를
넘으면 차단하고, 조회는 실패시키거나 캐시로 돌린다. **폴백은 무한 통로가 아니라 좁은
비상구여야 한다.**

**(3) 저하 응답(degraded response)을 미리 정의해둔다.** 장애 시 선택지를 "정확한 데이터
아니면 에러"로 두면 답이 없다. 미리 정해둘 것들:

- **캐시된 값을 허용한다** — "3분 전 기준" 같은 표시와 함께 응답한다.
- **일부 기능만 끈다** — 실시간성이 낮은 통계·추천을 먼저 끄고 핵심 조회에 여력을 남긴다.
- **읽기 제한을 건다** — 페이지 크기 축소, 무거운 정렬/검색 차단.

**(4) 사람에게 알린다.** 자동 조치는 **시간을 벌어주는 것**이지 문제를 해결하지 않는다.
제외가 발생했다는 사실 자체가 알람이어야 하고, "지연 허용 모드"로 전환됐다면 그건 최고
등급 알람이다.

### 7-3. 애초에 부하 이동이 감당 가능한 크기인지 계산해둔다

설계 시점에 해둘 계산이 하나 있다. **리플리카 1대가 빠지면 남은 곳에 얼마가 얹히는가?**

- 리플리카 2대로 읽기를 나누고 있었다면, 1대가 빠지는 순간 **남은 1대의 부하가 2배**다.
  평소 사용률이 60%였다면 120%가 되어 **그 리플리카도 곧 지연이 커지고 함께 빠진다.**
  **연쇄 제외**다.
- 즉 **"1대가 빠져도 나머지가 감당 가능한 사용률"** 이 리플리카 대수 결정의 기준이 된다.
  2대 구성에서 각 리플리카 사용률이 50%를 넘으면 이미 여유가 없다는 뜻이다.

이 계산을 말하면 "제외 로직을 짜봤다"를 넘어 **"제외가 가능한 구성을 설계해봤다"** 로
읽힌다. **(가산점 포인트)**

---

## 8. 라우팅이 포기하는 것 — 양면으로 말하기

읽기 부하를 나누는 이득은 명확하다. 그 대가도 명확하다. **얻는 것만 말하면 트레이드오프
서술이 아니다.**

### 8-1. "이 쿼리가 어느 DB로 갔는가"가 코드에서 안 보인다

가장 큰 대가다. 라우팅은 **개발자 눈에 안 보이게 만드는 것이 목적인 장치**라, 문제가
생겼을 때도 안 보인다. 그래서 **관측을 코드로 심는 것이 선택이 아니라 필수**다.

```java
// RoutingDataSource 안에서 — §1-3 에 이미 넣어둔 두 줄이 여기서 값을 한다
MDC.put("dsKey", key.name());
RoutingMetrics.count(key);
```

```
# 로그 패턴에 %X{dsKey} 를 넣어두면 모든 쿼리 로그에 목적지가 찍힌다
2026-08-10 02:11:04.221 [http-nio-8080-exec-3] [dsKey=REPLICA2] DEBUG ... select p1_0.id ...
```

**MDC의 함정도 같이 알아야 한다.** MDC는 스레드에 묶이므로, `@Async`나 별도 스레드로
넘어가면 값이 따라가지 않는다. 그리고 요청이 끝날 때 정리하지 않으면 **다음 요청 로그에
이전 값이 남는다.** `ThreadLocal` 정리 규율(§6-2)과 정확히 같은 이야기다.

### 8-2. 트랜잭션 안에서 읽기와 쓰기를 섞을 수 없다

라우팅은 **트랜잭션 단위**로 결정된다. 그래서 이런 코드가 문제가 된다.

```java
// ❌ 무거운 조회가 쓰기 트랜잭션에 묶여 전부 마스터로 간다
@Transactional
public void settle(Long sellerId) {
    List<Order> orders = orderRepository.findAllForSettlement(sellerId);  // 수십만 건 조회
    // ↑ readOnly 가 아니므로 마스터. 리플리카로 뺄 수 있었던 부하가 마스터에 남는다
    settlementRepository.save(calculate(orders));
}

// ✅ 조회 트랜잭션과 쓰기 트랜잭션을 분리한다
public void settle(Long sellerId) {
    List<Order> orders = orderQueryService.findAllForSettlement(sellerId);  // readOnly → 리플리카
    settlementCommandService.save(calculate(orders));                        // 쓰기 → 마스터
}
```

**대신 분리하면서 잃는 것이 있다.** 조회와 쓰기가 다른 트랜잭션이 되므로 **그 사이에
데이터가 바뀔 수 있다.** 즉 이 리팩터링은 "성능을 위해 정합성 보장 구간을 줄이는" 선택이고,
바뀌면 안 되는 경우에는 버전 검증(낙관적 락) 같은 장치가 따라와야 한다
([낙관적 락 vs 비관적 락](optimistic-vs-pessimistic-lock.md)). **부하 분산과 정합성이
정면으로 부딪히는 지점**이라, 무조건 쪼개라고 말하면 안 된다.

### 8-3. `readOnly`를 잘못 붙이면 조용히 실패한다

§3-2에서 다룬 역방향 룰의 근거다. 실패 방식이 두 갈래로 갈린다.

- **변경 감지 기반 수정** — `readOnly = true`면 flush 자체를 건너뛰므로 **예외도 없이
  변경이 사라진다.** 가장 나쁜 형태다
  ([영속성 컨텍스트와 변경 감지](persistence-context-dirty-checking.md)).
- **명시적 INSERT/UPDATE** — 리플리카로 라우팅된 상태라면 DB가 거부해 예외가 난다.
  **시끄럽게 실패하므로 오히려 낫다.** §1-2에서 리플리카 계정을 읽기 전용으로 파라고
  한 이유가 이것이다 — **조용한 실패를 시끄러운 실패로 바꾸는 장치**다.

### 8-4. 테스트가 복잡해진다

로컬과 CI에서 실제 복제 구성을 띄우는 것은 비용이 크다. **그래서 대부분 테스트는 단일
DB로 돌고, 라우팅 경로는 테스트가 한 번도 지나지 않는다.** 이 사각지대를 인정하고
푸는 방법이 §9다.

### 8-5. 그 밖

- **스키마 변경 중 마스터와 리플리카의 스키마가 잠시 다르다.** 컬럼을 추가하면 리플리카에
  반영되기 전까지 조회가 깨질 수 있다. **컬럼 추가 → 코드 배포**의 순서와 하위 호환
  변경만 하는 규율이 더 중요해진다.
- **커넥션 총량이 늘어난다**(§1-2). DataSource마다 풀이 따로 생긴다.
- **운영 중 리플리카 추가/제거가 애플리케이션 설정 변경을 요구한다.** 인프라 변경이
  배포를 부르는 구조가 된다(§10의 Aurora 질문이 여기서 나온다).

---

## 9. 관측과 안전망 — 이 문항에서 가장 실무적인 부분

라우팅은 **틀려도 에러가 안 나는 기능**이다. 그래서 "돌아가는지"를 사람의 확인이 아니라
기계가 말해줘야 한다.

### 9-1. 봐야 할 지표 네 개

| 지표 | 정상 신호 | 이상하면 의심할 것 |
|---|---|---|
| **리플리카별 지연(ms)** | 평소 수준에서 안정 | 배치·롱 트랜잭션·리플리카 리소스 |
| **라우팅 키별 쿼리 수 비율** | 읽기 대부분이 리플리카 | **§2의 lazy 프록시 누락**, `@Transactional` 누락 |
| **마스터 폴백 발생 수** | 0에 가깝게 | 리플리카 제외가 실제로 일어나고 있다 |
| **마스터 강제(force) 비율** | 낮고 안정적 | `ThreadLocal` 미정리, 창(window) 과다 |

**두 번째 지표가 이 문항의 핵심 안전망이다.** "리플리카로 가는 조회 비율"이 배포 이후
갑자기 0에 가까워졌다면 §2의 함정에 다시 빠진 것이고, 그 사실을 **에러가 아니라 지표로만**
알 수 있다.

### 9-2. 통합 테스트에서 "정말 리플리카를 탔는지" 단정하는 법

여기 실용적인 요령이 하나 있다. **테스트에서 복제를 흉내 내려 하지 말고, 복제를 아예 하지
않는다.**

> **마스터용 DB와 리플리카용 DB를 각각 띄우되 복제를 걸지 않고, 두 DB에 서로 다른 데이터를
> 넣는다. 그리고 조회 결과가 어느 쪽 데이터인지로 라우팅을 판정한다.**

```java
@SpringBootTest
class ReadRoutingTest {

    // Testcontainers 로 두 개의 DB 를 띄운다. 복제는 설정하지 않는다.
    @Autowired PostQueryService postQueryService;
    @Autowired @Qualifier("masterDataSource")   DataSource master;
    @Autowired @Qualifier("replica1DataSource") DataSource replica;

    @BeforeEach
    void setUp() {
        new JdbcTemplate(master).update("insert into post(id, title) values (1, 'FROM-MASTER')");
        new JdbcTemplate(replica).update("insert into post(id, title) values (1, 'FROM-REPLICA')");
    }

    @Test
    void 읽기전용_트랜잭션은_리플리카로_간다() {
        // @Transactional(readOnly = true) 인 조회
        assertThat(postQueryService.findTitle(1L)).isEqualTo("FROM-REPLICA");
    }

    @Test
    void 마스터_강제_조회는_마스터로_간다() {
        assertThat(postQueryService.findTitleRequiringMaster(1L)).isEqualTo("FROM-MASTER");
    }

    @Test
    void 쓰기_트랜잭션의_조회는_마스터로_간다() {
        assertThat(postCommandService.readInsideWriteTx(1L)).isEqualTo("FROM-MASTER");
    }
}
```

**이 테스트의 가치**는 §2의 함정을 **CI가 잡아준다**는 데 있다. 누군가 DataSource 설정을
리팩터링하다 `LazyConnectionDataSourceProxy`를 빼면, 운영에 나가기 전에 이 테스트가 빨갛게
된다. **"리플리카로 안 갑니다"를 운영에서 발견하지 않는 유일한 방법**이다.

**반드시 함께 말할 함정**: 테스트 클래스에 `@Transactional`을 붙이면 안 된다. 테스트 자체가
트랜잭션을 열어버리면 서비스 메서드의 `readOnly` 설정이 그 바깥 트랜잭션에 흡수되어
(`REQUIRED` 전파) **라우팅 판단이 테스트의 트랜잭션 기준으로 정해진다.** 결과가 항상
마스터로 나오면서 "라우팅이 안 된다"는 거짓 실패를 보게 된다. [OSIV 문서](osiv-tradeoff-and-migration.md)
§4-2의 "테스트에 `@Transactional`을 붙이면 검증이 무의미해진다"와 **똑같은 함정의 다른
얼굴**이다. **(가산점 포인트)**

### 9-3. 이 도구 상자는 3장 전체에서 반복된다

쿼리 수 단정 테스트, 경고 로그를 실패로 승격, ArchUnit 구조 룰, 프로파일을 바꿔 다시
돌리는 통합 테스트, 그리고 여기의 **라우팅 키 로그·데이터로 판정하는 통합 테스트**는
전부 같은 계열이다.

> **문제를 만나면 잘 푸는 것과, 문제가 오기 전에 잡는 장치를 만드는 것은 다른 능력이다.**
> 라우팅은 특히 후자가 없으면 **틀린 채로 몇 달을 돌 수 있는** 기능이라, 안전망 없이
> 도입하는 것 자체가 설계 결함이다.

---

## 10. 꼬리질문 대비 포인트

### "`@Transactional(readOnly = true)`를 붙였는데 리플리카로 안 갑니다. 무엇부터 확인하나요?"

**순서를 정해놓고 위에서부터 훑는다.** 이 질문은 §2를 아는지 확인하는 질문이므로 첫 항목이
가장 중요하다.

1. **`LazyConnectionDataSourceProxy`로 감쌌는가.** 1순위다. 없으면 커넥션이 트랜잭션 시작
   시점에 잡혀 항상 기본 DataSource(마스터)로 간다.
2. **감싸는 순서가 맞는가.** `Lazy(Routing(...))`이어야 한다. 반대로 되어 있으면 효과가 없다.
3. **JPA가 실제로 그 DataSource를 쓰는가.** 자동 설정이 만든 DataSource가 `@Primary`로
   남아 있고 우리가 만든 게 무시되고 있을 수 있다.
4. **트랜잭션이 실제로 걸려 있는가.** 같은 클래스 안에서 메서드를 직접 호출하면(self-invocation)
   프록시를 안 타서 `@Transactional`이 아예 적용되지 않는다. 이 경우
   `isActualTransactionActive()`가 `false`다.
5. **`readOnly`가 전파 과정에서 흡수되지 않았는가.** 바깥에 `readOnly = false` 트랜잭션이
   이미 열려 있으면 `REQUIRED`로 참여하면서 안쪽의 `readOnly = true`는 무시된다.
6. **확인 수단** — 추측하지 말고 §8-1의 MDC 로그를 본다. 어느 키로 갔는지가 즉시 나온다.

**4번과 5번이 "라우팅 자체는 맞는데 안 가는" 두 경우**라, 1~3번을 다 확인하고도 안 될 때
여기서 답이 나오는 일이 많다.

### "쓰기 트랜잭션 안에서 무거운 조회를 하면 그것도 마스터로 갑니다. 어떻게 하나요?"

§8-2 그대로다. **트랜잭션을 쪼개 조회를 별도의 `readOnly` 트랜잭션으로 뺀다.** 다만 답을
여기서 끝내면 안 된다.

**쪼개면서 잃는 것은 "조회 시점과 쓰기 시점 사이의 원자성"** 이다. 그 사이에 데이터가
바뀌어도 모른 채 쓰게 된다. 그래서 처방은 상황에 따라 갈린다.

- **조회 결과가 쓰기의 근거가 아닌 경우**(정산 대상 목록을 읽어 리포트를 만든다 등)
  → 그냥 쪼갠다. 잃는 것이 없다.
- **조회 결과를 근거로 값을 계산해 쓰는 경우** → 쪼갠 뒤 **버전 검증이나 조건부 UPDATE로
  중간 변경을 감지**해야 한다. 낙관적 락이 이 자리에 정확히 맞는 도구다.
- **애초에 한 트랜잭션이 너무 큰 경우** → 조회 범위를 줄이거나 배치로 나누는 것이
  근본 처방이다([트랜잭션 경계와 도메인 이벤트](transaction-boundary-and-domain-events.md)).

### "마스터 풀과 리플리카 풀 크기는 어떻게 잡나요?"

**계산의 출발점은 세 가지다.**

- **필요 커넥션 수 = 초당 요청 수 × 커넥션 점유 시간.** 읽기와 쓰기를 각각 계산한다.
- **DB 서버의 `max_connections` ≥ (인스턴스 수 × 그 DB를 가리키는 풀 크기).** 라우팅을
  도입하면 이 곱셈이 DataSource 개수만큼 늘어난다는 걸 놓치기 쉽다.
- **읽기가 쓰기보다 훨씬 많으므로 리플리카 풀이 마스터 풀보다 크게 잡히는 것이 보통이다.**

**그리고 이 문항 고유의 함정이 하나 더 있다.** 리플리카가 빠지면 그 조회가 전부 마스터로
간다(§7). **그런데 마스터 풀은 쓰기 기준으로 잡혀 있어 그 부하를 못 받는다.** 그래서
선택지는 둘이다 — ① 마스터 풀에 폴백 여유를 미리 얹어둔다(평상시 낭비) ② 폴백에
서킷 브레이커를 걸어 애초에 다 못 들어오게 한다(§7-2). **②가 정석**이다. 풀을 키워
버티는 방식은 DB 쪽 경합으로 문제를 옮길 뿐이다.

### "반동기 복제(semi-synchronous replication)를 쓰면 lag이 없어지지 않나요?" (가산점 포인트)

**없어지지 않는다.** 이 질문은 "복제 방식으로 해결하면 되지 않나"라는 흔한 오해를 확인하는
자리다.

반동기 복제가 보장하는 것은 **"리플리카가 이벤트를 받았다"** 까지다. **받은 것을 실제
테이블에 적용했다는 보장이 아니다.** 즉 커밋 응답이 돌아온 직후에 그 리플리카로 조회해도
**아직 적용 전일 수 있다** — 우리가 겪는 문제는 그대로 남는다.

대신 **치르는 값은 확실하다.** 마스터의 모든 커밋이 리플리카의 응답을 기다리므로 **쓰기
지연이 늘고, 리플리카나 네트워크가 느려지면 마스터 쓰기 전체가 느려진다.** 즉 반동기
복제는 **읽기 일관성을 위한 도구가 아니라 데이터 유실 방지(내구성)를 위한 도구**다. 목적이
다르다.

**결론 한 문장**: *복제 방식을 바꿔 읽기 일관성을 얻으려는 시도는 대개 비싼 값을 치르고
문제는 그대로 남긴다. 일관성은 §6의 층으로 애플리케이션에서 만든다.*

### "관리형 DB(예: Aurora)는 리더 엔드포인트가 알아서 분산해주는데, 애플리케이션 라우팅이 필요한가요?" (가산점 포인트)

**부하 분산은 인프라가 해준다. 그러나 이 문항이 다루는 문제의 대부분은 해결해주지 않는다.**

인프라 레벨 엔드포인트가 해주는 것:
- 여러 리플리카에 연결을 분산한다 → §1-4의 라운드로빈이 필요 없어진다.
- 장애 난 인스턴스를 목록에서 뺀다 → §5의 "죽었는지" 판정은 대신 해준다.

**해주지 못하는 것:**
- **"이 요청은 마스터로"를 표현하지 못한다.** §6-2·§6-3의 read-your-writes와 마스터 강제는
  **애플리케이션만이 아는 정보**(방금 이 사용자가 썼다 / 이 조회는 정합성이 필수다)에
  기반한다. 엔드포인트는 그걸 알 수 없다.
- **"살아 있지만 지연이 큰" 리플리카를 빼주지 않는 경우가 많다.** 헬스체크는 대개 응답
  가능 여부를 보지, **우리 서비스가 감당 가능한 지연 임계치**를 보지 않는다.
- **`@Transactional(readOnly = true)`와 연결되지 않는다.** 결국 읽기용 DataSource와 쓰기용
  DataSource를 코드에서 나눠 써야 하는데, 그 판단을 자동화하는 것이 §1의 라우팅이다.

**정리하면 인프라 엔드포인트는 §1-4와 §5의 일부를 대신해주고, §6 전체는 그대로 우리 몫이다.**
"관리형을 쓰니 라우팅이 필요 없다"가 아니라 **"라우팅의 대상이 개별 리플리카 주소에서 읽기
엔드포인트 하나로 바뀔 뿐"** 이라고 답하면 정확하다.

### "지금 리플리카 지연이 5초입니다. 무엇을 하시겠습니까?" (시니어 변별 포인트)

**자동 조치가 이미 돌고 있다는 전제에서 시작한다.** 헬스체커가 리플리카를 뺐거나
(§6-4), 광범위해서 지연 허용 모드로 갔거나(§7-2) 둘 중 하나다. **먼저 어느 쪽인지 확인하는
것이 1번**이다 — 지금 트래픽이 어디로 가고 있는지 모르는 상태로 손대면 안 된다.

그다음은 **원인을 세 갈래로 가른다.** 처방이 완전히 다르기 때문이다.

1. **마스터의 쓰기량이 튀었나** (배치·이벤트·마이그레이션) → **원인 쪽을 조절한다.**
   배치의 커밋 단위를 줄이거나 속도를 낮춘다. 가장 빠르고 확실한 처방인데, 애플리케이션
   조치만 생각하면 이 선택지를 놓친다.
2. **리플리카가 무거운 조회에 눌렸나** (리포트·통계) → 그 조회를 차단하거나 전용 리플리카로
   분리한다.
3. **리플리카 자체 문제인가** (디스크·CPU·복제 스레드 정지) → 그 한 대를 빼고 교체한다.
   1·2와 달리 **한 대만의 문제이므로 제외가 정확히 맞는 처방**이다.

**그리고 판단해야 할 것 하나** — *지금 지연된 데이터를 보여주는 것이 사용자에게 더 나쁜가,
아니면 마스터를 위험에 빠뜨리는 것이 더 나쁜가?* 서비스 성격에 따라 답이 다르다. 커머스의
상품 목록은 **5초 전 데이터를 보여주는 편이 낫고**, 결제 잔액은 **틀린 값을 보여주느니
에러가 낫다.** 그래서 §6-3의 마스터 강제 목록이 평소에 정리돼 있어야 이 순간에 판단이
빨라진다.

**마지막으로 재발 방지 항목을 남긴다.** 지연 원인이 배치였다면 배치의 쓰기 속도 상한,
리포트였다면 전용 리플리카, 그리고 공통으로 **§5의 지연 지표에 사전 경보 임계치**(제외
임계치보다 낮은 값)를 걸어 "빼기 직전"에 사람이 먼저 알게 만든다. **자동 조치가 발동한 것
자체가 이미 늦은 신호**라는 프레임을 말하면 운영 감각으로 읽힌다.

---

## 한 줄 요약

`@Transactional(readOnly = true)` 기반 라우팅은 **`AbstractRoutingDataSource`의
`determineCurrentLookupKey()`에서 `TransactionSynchronizationManager.isCurrentTransactionReadOnly()`를
읽어 키를 고르고, 그 전체를 `LazyConnectionDataSourceProxy`로 감싸 커넥션 획득을 실제 쿼리
시점까지 미루는 것**이 골격이다(감싸지 않으면 트랜잭션 시작 시점에 커넥션이 잡혀 **항상
마스터로 간다**). 조회에 `@Transactional(readOnly = true)`를 붙이는 규율은 ArchUnit 룰로
고정하고, **replication lag은 하트비트 테이블로 밀리초 단위 실측이 가능하다.** 그리고 읽기
일관성은 하나의 처방이 아니라 **쓰기 응답으로 재조회 제거 → 쓴 직후 그 사용자만 마스터로
→ 정합성 필수 조회만 마스터 강제 → 지연 초과 리플리카 제외**라는 층으로 쌓되, **마지막
층에는 반드시 상한과 폴백이 함께 와야 한다 — 리플리카를 다 빼면 그 부하를 마스터가 전부
받는다.**
