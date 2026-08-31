# 트랜잭션 동기화(TransactionSynchronizationManager)와 커넥션 바인딩 원리 — 한 트랜잭션의 쿼리는 어떻게 같은 커넥션을 타는가

> 핵심 관전 포인트: `@Transactional`이 시작되면 트랜잭션 매니저가 커넥션을 하나 얻어 **TransactionSynchronizationManager의 ThreadLocal 리소스 맵**(DataSource → ConnectionHolder)에 바인딩한다. 이후 JdbcTemplate·JPA 등 모든 데이터 접근 코드는 커넥션을 풀에서 직접 꺼내지 않고 **DataSourceUtils를 경유해 "내 스레드에 바인딩된 커넥션이 있으면 그걸 재사용"**한다. 그래서 한 트랜잭션 안의 모든 쿼리가 같은 커넥션을 타고, 반대로 **스레드가 바뀌면(@Async 등) 바인딩이 안 보여 트랜잭션이 전파되지 않는다.**

## 0. 질문 + 의도

**질문**: "Spring의 트랜잭션 동기화(TransactionSynchronizationManager)와
커넥션 바인딩 원리를 설명해주세요."

**출제 의도**: 멀티 데이터소스, 배치+API 혼재, 비동기 경계에서 트랜잭션이
"왜 안 타는지"를 추적하려면 이 내부 구조까지 알아야 한다. 프레임워크의
추상화가 새는(leaky) 지점에서 일할 수 있는 깊이인지 확인하는 질문이다.

## 1. 내부 구조 — 무엇이 어디에 저장되나

```
TransactionSynchronizationManager (전부 static + ThreadLocal)
├─ resources:        ThreadLocal<Map<Object, Object>>   // DataSource → ConnectionHolder
├─ synchronizations: ThreadLocal<Set<TransactionSynchronization>>  // 콜백(afterCommit 등)
├─ currentTransactionReadOnly / IsolationLevel / Name / actualTransactionActive
```

- `@Transactional` 진입 → `DataSourceTransactionManager`(또는 `JpaTransactionManager`)의 `doBegin()`:
  1. 풀(HikariCP)에서 커넥션 획득
  2. `setAutoCommit(false)`
  3. `ConnectionHolder`로 감싸 **`TransactionSynchronizationManager.bindResource(dataSource, holder)`** — 키가 DataSource 객체라 멀티 데이터소스도 각각 바인딩 가능
- 커밋/롤백 후 `doCleanupAfterCompletion()` → `unbindResource()` + 커넥션 풀 반환

## 2. 데이터 접근 코드가 같은 커넥션을 공유하는 경로

```java
// JdbcTemplate 내부
Connection con = DataSourceUtils.getConnection(dataSource);
// → TransactionSynchronizationManager.getResource(dataSource) 먼저 조회
//   바인딩된 ConnectionHolder가 있으면 그 커넥션 재사용 (없으면 풀에서 새로 획득)
```

- 반납도 대칭: `DataSourceUtils.releaseConnection()`은 커넥션이 트랜잭션에 바인딩된 것이면 **닫지 않고 그대로 둔다** — 실제 반환은 트랜잭션 종료 시점에 한 번만. 쿼리마다 close를 불러도 안전한 이유.
- JPA는 `EntityManagerHolder`를 같은 방식으로 바인딩하고, `JpaTransactionManager`가 (HibernateJpaDialect 등 JpaDialect가 커넥션을 노출하면) 그 EM의 커넥션을 `ConnectionHolder`로도 함께 바인딩 → **JPA와 JdbcTemplate(MyBatis 포함)을 한 트랜잭션에서 섞어 써도 같은 커넥션·같은 트랜잭션**.
- 이것이 "트랜잭션 동기화": 트랜잭션 리소스를 코드에 파라미터로 넘기지 않고 **스레드에 동기화**해 어디서든 꺼내 쓰게 하는 것.

## 3. 왜 @Async / CompletableFuture에서는 트랜잭션이 안 타나

- 바인딩 저장소가 **ThreadLocal**이므로, 새 스레드의 리소스 맵은 비어 있음 → `DataSourceUtils.getConnection()`이 풀에서 **새 커넥션**을 얻음 → 원 트랜잭션과 무관하게 auto-commit(또는 자기만의 새 트랜잭션)으로 동작.
- `@Transactional`을 `@Async` 메서드에 붙이면? **새 스레드에서 새 트랜잭션이 열린다**(참여가 아니라 분리). 이것이 정석.

### 함정: "ThreadLocal을 물려주면 되지 않나?" → 절대 안 됨

TaskDecorator 등으로 리소스 맵을 복사해 두 스레드가 **같은 커넥션**을 쥐게 만들면:

1. **JDBC Connection은 스레드세이프하지 않다** — 두 스레드가 동시에 statement를 날리는 순간 이미 깨진 설계.
2. **라이프사이클 붕괴** — 원 스레드 트랜잭션이 끝나면 커넥션이 풀에 **반환**되는데, 비동기 스레드는 그걸 계속 사용. 풀은 그 커넥션을 **제3의 요청에 재대여** → 서로 다른 요청의 쿼리가 한 커넥션·한 트랜잭션에 섞임(타 요청 데이터 커밋/롤백 오염).

TaskDecorator로 전파해도 되는 것은 MDC·SecurityContext 같은 **읽기용 컨텍스트**이지, 트랜잭션 리소스가 아니다.

## 4. 비동기 작업과 원 트랜잭션의 정합성 — AFTER_COMMIT

비동기 작업이 "원 트랜잭션이 커밋된 데이터"를 전제로 한다면, 실행 시점을 커밋 뒤로 미뤄야 한다.

```java
// ❌ before: 트랜잭션 안에서 @Async 직접 호출 — 레이스
@Transactional
public Order complete(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();
    statisticsService.aggregateAsync(orderId);  // @Async — 새 스레드가 즉시 조회 시작
    return order;
}   // 커밋은 여기서. 비동기 스레드는 별도 커넥션이라
    // 조회 시점에 커밋 전 데이터가 안 보이면 작업이 영영 유실된다
```

```java
// ✅ after: 이벤트만 발행하고, 실행 시작을 커밋 뒤로 보장
@Transactional
public Order complete(Long orderId) {
    ...
    eventPublisher.publishEvent(new OrderCompletedEvent(orderId));
    return order;
}

@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderCompleted(OrderCompletedEvent e) { ... }  // 커밋 확정 후에만 실행
```

- 핵심은 "커밋됐는지 조회/폴링"이 아니라 **시작 시점 자체를 커밋 뒤로 보장**하는 것.
- 내부 원리: `@TransactionalEventListener`는 즉시 실행되지 않고 `TransactionSynchronizationManager.registerSynchronization()`으로 **afterCommit 콜백에 등록**됐다가 커밋 후 호출된다 — 1번의 `synchronizations` 저장소가 쓰이는 지점.
- 주의: AFTER_COMMIT 리스너는 **이미 커밋이 끝난 트랜잭션의 잔여 리소스(바인딩된 커넥션)에 편승**해 실행된다. 여기서 DB 쓰기를 하면 에러 없이 도는데 다시 커밋될 일이 없어 **조용히 증발** — `@Transactional(propagation = REQUIRES_NEW)`로 새 트랜잭션을 열어야 한다(@Async로 새 스레드면 바인딩이 없으니 일반 @Transactional로 충분).
- 발행 자체의 유실까지 막아야 하면(서버 사망 등) → Transactional Outbox (`16-spring-event-transactional-event-listener.md` 참고).

## 5. 꼬리질문 대비 포인트

- **"멀티 데이터소스면?"** — 리소스 맵의 키가 DataSource라 각각 따로 바인딩. 단 `@Transactional`은 지정된 트랜잭션 매니저의 DataSource만 트랜잭션으로 관리 — 다른 DataSource 접근은 그 트랜잭션 밖(각자 커밋). 둘을 묶으려면 ChainedTransactionManager(베스트에포트 순차 커밋일 뿐 원자성 없음 — deprecated)나 JTA/XA.
- **"트랜잭션 없이 JdbcTemplate만 쓰면?"** — 바인딩이 없으니 쿼리마다 풀에서 획득→auto-commit→즉시 반환.
- **"@Async 메서드에 @Transactional 붙이면 self-invocation 문제는?"** — 같은 클래스 내부 호출이면 프록시를 안 타서 둘 다 무시됨. 별도 빈으로 분리해야 함.
- **"AFTER_COMMIT인데 롤백에도 실행돼야 하는 기록(감사 로그, 시도 이력)은?"** — AFTER_COMMIT은 롤백 시 실행 안 됨. 그런 기록은 `REQUIRES_NEW`로 선커밋(write-ahead)해야 한다.

## 한 줄 요약

Spring 트랜잭션은 "커넥션을 ThreadLocal 리소스 맵에 바인딩하고, 모든 데이터 접근이 DataSourceUtils로 그걸 재사용"하는 구조라 한 스레드 안에서만 전파된다 — 비동기 경계에서는 커넥션을 물려주는 게 아니라(비스레드세이프·풀 재대여 위험) 새 트랜잭션으로 분리하고, 원 트랜잭션과의 정합성은 `@TransactionalEventListener(AFTER_COMMIT)`으로 시작 시점을 커밋 뒤로 보장한다.
