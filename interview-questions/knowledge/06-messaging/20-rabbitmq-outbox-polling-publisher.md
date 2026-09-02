# RabbitMQ 환경의 Transactional Outbox — CDC 없이 폴링 퍼블리셔로 발행을 보장하기

> 핵심 관전 포인트: **"DB는 커밋됐는데 발행이 실패"하는 문제의 원인은 하나다 — DB와 브로커는 서로 다른 시스템이라 한 트랜잭션으로 묶이지 않는다. 해법의 뼈대는 Kafka와 같다: 이벤트를 같은 DB 트랜잭션 안에서 outbox 테이블에 INSERT하고, 별도 프로세스가 그것을 읽어 발행한다. 그러면 "주문 저장"과 "이벤트 기록"이 한 트랜잭션이므로 둘 다 되거나 둘 다 안 된다. 다른 것은 읽어서 발행하는 방법이다. Kafka에는 Debezium + Kafka Connect라는 CDC 정석 경로가 있지만 RabbitMQ에는 그만큼 표준화된 경로가 없어, 실무의 기본 선택은 폴링 퍼블리셔 — 스케줄러가 미발행 행을 주기적으로 읽어 발행하고 publisher confirm을 받으면 발행됨으로 표시하는 방식이다. 그리고 반드시 짚어야 할 두 가지가 있다. confirm은 비동기라서 "발행 완료" 표시를 응답 콜백에서 해야 한다는 것, 그리고 이 구조는 본질적으로 at-least-once라 중복이 반드시 생기므로 멱등 컨슈머가 짝으로 따라와야 한다는 것이다.**

---

## 0. 질문 + 의도

**질문**: "RabbitMQ를 쓰는 서비스에서 \"DB 커밋은 됐는데 발행이 실패\"하는 문제를 어떻게 해결하나요? (CDC 없이 Outbox + 폴링 퍼블리셔, publisher confirms와의 결합)"

**출제 의도**: Kafka에는 Debezium CDC라는 정석 경로가 있지만 RabbitMQ는 그렇지 않다. 같은 원자성 문제를 다른 재료로 풀어내는지 — 패턴을 암기한 것이 아니라 이해했는지 가리는 문항이다. 폴링 방식의 대가(지연, 중복, 순서, 테이블 관리)를 스스로 꺼내는지도 함께 본다.

## 1. 전제 — 왜 트랜잭션으로 못 묶는가

### 1-1. 이중 쓰기 문제

코드로 보면 문제가 선명하다.

```java
@Transactional
public void completeOrder(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();                                    // ① DB 변경
    rabbitTemplate.convertAndSend("order.events",
            "order.completed", new OrderCompleted(order)); // ② 브로커 발행
}
```

**두 개의 서로 다른 저장소에 쓰고 있다.** 실패 조합이 넷이고, 그중 둘이 문제다.

| ① DB | ② 발행 | 결과 |
|---|---|---|
| 성공 | 성공 | 정상 |
| 실패 | 실패 | 정상 (아무 일도 안 일어남) |
| **성공** | **실패** | 주문은 완료됐는데 정산·알림이 안 온다 |
| **실패(롤백)** | **성공** | 일어나지 않은 일에 대한 이벤트가 나갔다 |

세 번째는 `@Transactional` 안에서 발행이 예외를 던지면 롤백되므로 막히는 것처럼 보이지만, **발행은 성공했는데 그 뒤 커밋이 실패하는 경우**(DB 커넥션 끊김, 제약 위반)에는 네 번째가 된다. 그리고 발행 호출 직후 프로세스가 죽으면 세 번째다.

**순서를 바꿔도 해결되지 않는다.** 어느 쪽을 먼저 해도 그 사이에 죽을 수 있다. 이것이 이중 쓰기(dual write) 문제이며, 두 시스템에 걸친 원자성이 필요한데 그럴 수단이 없다는 것이 본질이다.

### 1-2. 분산 트랜잭션은 왜 답이 아닌가

"2단계 커밋(2PC)으로 묶으면 되지 않나"라는 생각이 자연스럽지만 실무에서 쓰지 않는다.

**첫째, RabbitMQ는 XA 트랜잭션을 지원하지 않는다.** AMQP에 `tx.select`가 있지만 이것은 브로커 내부 트랜잭션이지 DB와 묶이는 분산 트랜잭션이 아니다.

**둘째, 2PC 자체가 비싸고 취약하다.** 준비 단계에서 자원을 잠그고 코디네이터의 결정을 기다리므로, 코디네이터가 죽으면 참가자들이 잠긴 채 멈춘다. 마이크로서비스 환경에서 피하는 것이 정석이다.

그래서 **"두 시스템을 묶는 대신, 쓰기를 한 시스템으로 몰아넣는다"**는 발상 전환이 필요하다. 그것이 Outbox다.

### 1-3. Outbox — 보낼 편지함을 DB 안에 둔다

핵심 아이디어는 단순하다. **이벤트를 브로커에 바로 보내지 말고, 같은 DB의 테이블에 INSERT한다.**

```java
@Transactional
public void completeOrder(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();                          // ① 업무 데이터 변경
    outboxRepository.save(OutboxEvent.of(      // ② 같은 DB, 같은 트랜잭션
            "order.events", "order.completed", new OrderCompleted(order)));
}
// 커밋 -> ①과 ②가 원자적으로 함께 반영된다. 둘 다 되거나 둘 다 안 된다.
```

**이제 실패 조합이 둘로 줄었다.** 커밋 성공(주문 + 이벤트 기록)이거나 롤백(둘 다 없음)이거나.

남은 일은 **outbox 테이블에 기록된 이벤트를 브로커로 옮기는 것**이고, 이 옮기는 작업은 **실패해도 재시도할 수 있다.** 기록이 DB에 남아 있으니 언제든 다시 시도하면 된다. 원자성 문제가 "재시도 가능한 전달 문제"로 바뀐 것이 이 패턴의 본질이다.

## 2. 옮기는 방법 — Kafka와 갈리는 지점

### 2-1. 두 갈래

outbox의 행을 브로커로 옮기는 방법은 둘이다.

**CDC(Change Data Capture)**는 DB의 트랜잭션 로그를 구독해 변경을 감지하는 방식이다. Kafka 진영에는 Debezium + Kafka Connect라는 성숙한 경로가 있어 사실상 표준이다. 자세한 원리는 `28-transactional-outbox-cdc-kafka.md`에서 다룬다.

**폴링 퍼블리셔(polling publisher)**는 애플리케이션이 주기적으로 outbox 테이블을 조회해 미발행 행을 발행하는 방식이다.

### 2-2. RabbitMQ에서 폴링이 기본 선택인 이유

RabbitMQ에도 CDC를 붙일 수는 있다. Debezium의 독립 실행 형태를 써서 변경을 RabbitMQ로 흘리거나, Kafka Connect로 받은 것을 다시 옮기는 구성이 가능하다.

그런데 실무에서 잘 안 쓴다. 이유가 셋이다.

**첫째, 구성 요소가 늘어난다.** Kafka를 쓰지 않는 조직이 CDC를 위해 Kafka Connect를 도입하는 것은 배보다 배꼽이 크다.

**둘째, 생태계가 얇다.** Kafka의 outbox event router 같은 정형화된 조각이 RabbitMQ 쪽에는 그만큼 갖춰져 있지 않아, 직접 만들어야 하는 부분이 많다.

**셋째, RabbitMQ를 쓰는 시스템의 규모에서는 폴링으로 충분한 경우가 많다.** CDC의 이점은 초당 수만 건 규모에서 커지는데, 그 규모라면 애초에 Kafka를 검토하게 된다.

**"도구의 생태계가 해법 선택을 바꾼다"**는 점을 짚으면 좋다. 같은 패턴이라도 재료에 따라 구현이 달라진다는 것이 이 질문의 핵심이다.

## 3. 폴링 퍼블리셔 구현

### 3-1. 테이블 설계

```sql
CREATE TABLE outbox_event (
    id             BIGSERIAL     PRIMARY KEY,   -- 발행 순서의 기준
    aggregate_type VARCHAR(50)   NOT NULL,      -- ORDER, PAYMENT ...
    aggregate_id   VARCHAR(64)   NOT NULL,      -- 순서 보장 단위 (주문 ID 등)
    event_type     VARCHAR(100)  NOT NULL,      -- order.completed
    exchange_name  VARCHAR(100)  NOT NULL,
    routing_key    VARCHAR(255)  NOT NULL,
    payload        JSONB         NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'PENDING',  -- PENDING/PUBLISHED/FAILED
    retry_count    INT           NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ
);

-- 폴링이 매번 때리는 쿼리이므로 부분 인덱스로 좁게 만든다.
-- 발행 완료된 행은 인덱스에서 빠지므로, 테이블이 커져도 조회는 빠르다.
CREATE INDEX idx_outbox_pending
    ON outbox_event (id)
    WHERE status = 'PENDING';
```

`aggregate_id`를 두는 이유는 **순서 보장 단위**를 표현하기 위해서다. 같은 주문의 이벤트는 순서를 지켜야 하지만 서로 다른 주문끼리는 상관없다. 나중에 병렬 발행으로 확장할 때 이 컬럼이 분할 기준이 된다.

`payload`를 JSON으로 두는 이유는 **발행 시점에 도메인 객체를 다시 조회하지 않기 위해서**다. 이벤트는 "그때 일어난 사실"이므로 발행 시점의 최신 상태가 아니라 기록 시점의 상태를 담아야 한다.

### 3-2. 폴링 루프

```java
@Component
@RequiredArgsConstructor
public class OutboxPublisher {

    private final OutboxRepository repository;
    private final RabbitTemplate rabbitTemplate;

    @Scheduled(fixedDelay = 500)   // 0.5초 — 지연과 DB 부하의 균형점
    @Transactional
    public void publishPending() {
        // SKIP LOCKED: 다른 인스턴스가 잠근 행은 건너뛰고 가져온다.
        // 이게 없으면 여러 인스턴스가 같은 행을 집어 중복 발행한다.
        List<OutboxEvent> events = repository.findPendingForUpdateSkipLocked(200);

        for (OutboxEvent e : events) {
            rabbitTemplate.convertAndSend(
                    e.getExchangeName(), e.getRoutingKey(), e.getPayload(),
                    msg -> {
                        // 컨슈머가 중복을 걸러낼 수 있게 고유 ID를 심는다
                        msg.getMessageProperties().setMessageId(String.valueOf(e.getId()));
                        return msg;
                    },
                    new CorrelationData(String.valueOf(e.getId())));  // confirm 식별자
        }
    }
}
```

```java
// 조회 쿼리 — 잠금과 건너뛰기가 핵심
@Query(value = """
        SELECT * FROM outbox_event
        WHERE status = 'PENDING'
        ORDER BY id                    -- 기록 순서대로 발행한다
        LIMIT :limit
        FOR UPDATE SKIP LOCKED
        """, nativeQuery = true)
List<OutboxEvent> findPendingForUpdateSkipLocked(@Param("limit") int limit);
```

`FOR UPDATE SKIP LOCKED`가 이 구현의 핵심이다. **여러 인스턴스가 동시에 폴링해도 서로 다른 행을 가져간다.** 이것이 없으면 인스턴스 3대가 같은 200건을 각자 발행해 3배 중복이 난다.

### 3-3. publisher confirms와 결합 — 여기가 승부처

가장 많이 틀리는 부분이다. **발행 호출이 리턴했다고 발행이 성공한 것이 아니다.**

```java
// 잘못된 코드 — 발행 직후 완료로 표시
for (OutboxEvent e : events) {
    rabbitTemplate.convertAndSend(...);
    e.markPublished();          // 아직 브로커가 받았는지 모른다
}
// 브로커가 죽어 있었다면? 이벤트는 발행됨으로 표시됐지만 실제로는 사라졌다.
// 재시도 대상에서도 빠졌으므로 영구 유실이다.
```

정확한 구현은 **confirm 콜백에서 상태를 갱신하는 것**이다.

```java
@Bean
RabbitTemplate outboxRabbitTemplate(ConnectionFactory cf, OutboxRepository repo) {
    RabbitTemplate t = new RabbitTemplate(cf);
    t.setMandatory(true);   // 라우팅 실패도 잡아야 한다 (아래 4-2)

    t.setConfirmCallback((correlation, ack, cause) -> {
        Long id = Long.valueOf(correlation.getId());
        if (ack) {
            // 브로커가 책임을 넘겨받은 것이 확인된 시점에만 완료 표시
            repo.markPublished(id);
        } else {
            // 브로커가 거부했다. PENDING으로 남겨두면 다음 폴링에서 재시도된다
            repo.increaseRetryCount(id, cause);
        }
    });

    t.setReturnsCallback(returned -> {
        // confirm은 ack인데 이쪽이 호출됐다면 = 브로커는 받았지만 갈 큐가 없었다.
        // 설정 오류이므로 재시도해도 같다. 알람이 필요하다.
        log.error("outbox 라우팅 실패: rk={}", returned.getRoutingKey());
    });
    return t;
}
```

여기서 반드시 알아야 할 것이 있다. **콜백은 폴링 트랜잭션과 다른 스레드에서, 나중에 호출된다.** 그래서 `markPublished`는 별도 트랜잭션이어야 하고, 폴링 루프는 confirm을 기다리지 않고 다음 배치로 넘어간다.

이 구조가 만드는 성질이 하나 있다. **confirm이 아직 안 온 행은 여전히 PENDING이므로, 다음 폴링 주기에 다시 발행될 수 있다.** 중복이다.

이 중복을 줄이려면 `IN_FLIGHT` 같은 중간 상태를 두고 폴링 대상에서 제외하되, **일정 시간이 지나도 confirm이 안 오면 다시 PENDING으로 되돌리는** 처리가 필요하다(발행 중 프로세스가 죽으면 영원히 IN_FLIGHT로 남기 때문이다).

**그리고 아무리 정교하게 해도 중복을 완전히 없앨 수는 없다.** 브로커가 받고 confirm을 보내는 도중 네트워크가 끊기면 "도달 못 함"과 "응답만 유실"을 구분할 방법이 없다. **이 구조는 본질적으로 at-least-once이며, 멱등 컨슈머가 필수 전제**다.

### 3-4. 지연을 줄이는 방법 — 커밋 후 즉시 깨우기

폴링 주기가 500ms면 이벤트는 평균 250ms, 최악 500ms 늦게 발행된다. 대부분 괜찮지만 더 빠르게 하고 싶을 때가 있다.

**트랜잭션 커밋 직후 퍼블리셔를 즉시 깨우면** 평상시 지연이 거의 사라진다.

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onCommitted(OutboxRecorded event) {
    // 커밋이 확정된 뒤에만 호출된다. 폴링 주기를 기다리지 않고 바로 한 번 돌린다.
    outboxPublisher.publishPending();
}
```

핵심은 **이것이 최적화일 뿐 보장 수단이 아니라는 점**이다. 이 호출이 실패하거나 프로세스가 죽어도 **주기 폴링이 여전히 남아 있어 결국 발행된다.** 즉시 발행은 지연을 줄이고, 주기 폴링은 유실을 막는다. 역할이 다르다.

**여기서 흔한 오해를 짚어야 한다.** `@TransactionalEventListener(AFTER_COMMIT)`으로 직접 발행하는 것만으로 outbox를 대체하려는 시도가 많은데, **이것만으로는 부족하다.** 커밋과 발행 사이에 프로세스가 죽으면 이벤트가 사라지고, DB에는 그 이벤트가 있었다는 기록조차 없다. **outbox 테이블이 있어야 재시도할 근거가 남는다.**

## 4. 운영에서 반드시 챙길 것

### 4-1. 테이블이 무한히 커지지 않게 한다

발행된 행을 그냥 두면 테이블이 계속 커진다. 처리 방법은 둘이다.

**즉시 삭제.** 발행 확인 후 DELETE한다. 테이블이 작게 유지되지만 **이벤트 발행 이력이 남지 않는다.** 그리고 PostgreSQL에서는 삭제된 행이 즉시 사라지지 않고 VACUUM 대상으로 남으므로, 삭제가 잦으면 테이블 부풀림(bloat)에 신경 써야 한다.

**보관 후 배치 삭제.** `published_at`이 N일 지난 행을 주기적으로 지운다. 이력이 남아 **"이 이벤트가 언제 발행됐는가"를 조사할 수 있다는 점**이 크다. 장애 조사에서 이 이력의 값이 매우 높으므로 대부분 이쪽을 택한다.

어느 쪽이든 **부분 인덱스(`WHERE status = 'PENDING'`)를 쓰면 테이블이 커져도 폴링 성능은 유지된다.** 발행 완료된 행은 인덱스에서 빠지기 때문이다.

### 4-2. 감시 지표는 "가장 오래된 미발행 행의 나이"

건수를 보는 것보다 **나이**를 보는 것이 정확하다.

```sql
SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))
FROM outbox_event WHERE status = 'PENDING';
```

이 값이 커진다는 것은 **퍼블리셔가 멈췄거나 밀리고 있다**는 뜻이다. 건수는 트래픽에 따라 오르내리지만 나이는 그렇지 않으므로 오탐이 적다. **"건수가 아니라 나이로 본다"는 지표 선택 자체가 이 패턴을 운영해본 흔적이다.** (가산점 포인트)

여기에 **재시도 횟수가 높은 행**에 대한 알람을 더한다. 특정 행이 계속 실패한다면 라우팅 오류나 페이로드 문제이므로 사람이 봐야 한다.

### 4-3. 순서

`ORDER BY id`로 발행하면 **기록 순서 = 발행 순서**가 된다. 단일 퍼블리셔라면 이것으로 충분하다.

병렬 발행이 필요하면 `aggregate_id`로 나눈다. 같은 집합체의 이벤트는 같은 워커가 순서대로 처리하고, 서로 다른 집합체는 병렬로 간다. **Kafka의 파티션 키와 같은 발상**이다.

그리고 근본적으로, **컨슈머가 순서에 의존하지 않게 만드는 것**이 가장 견고하다. 이벤트에 버전을 넣고 오래된 것은 무시하는 방식이며, `15-rabbitmq-message-ordering.md`에서 다룬다.

### 4-4. 실패한 행의 처리

몇 번을 재시도해도 실패하는 행이 생긴다. 무한히 재시도하면 그 행이 폴링 배치의 앞자리를 계속 차지해 **뒤의 정상 이벤트까지 밀린다.**

```java
// 재시도 상한을 넘기면 FAILED로 옮겨 폴링 대상에서 제외한다
if (event.getRetryCount() >= MAX_RETRY) {
    event.markFailed();     // status = 'FAILED' -> 부분 인덱스에서 빠진다
    alertService.notify("outbox 발행 영구 실패", event.getId());
}
```

**컨슈머의 DLQ와 같은 역할**을 outbox 쪽에도 만드는 것이다. 실패한 것을 격리해 흐름을 지키고, 사람이 볼 수 있게 알람을 건다.

## 5. 꼬리질문 대비 포인트

### "폴링이 DB에 부담되지 않나요?"

부분 인덱스를 걸면 대부분 문제가 없다. `WHERE status = 'PENDING'` 인덱스는 **미발행 행만 담으므로 평상시 매우 작다**(수십~수백 건). 테이블에 1억 건이 쌓여 있어도 인덱스는 작게 유지된다.

부담이 되는 경우는 둘이다. **폴링 주기가 지나치게 짧을 때**(10ms 등), 그리고 **미발행 행이 대량으로 밀렸을 때**. 후자는 이미 다른 문제(퍼블리셔 장애)의 증상이다.

그래도 부담이 크다면 **커밋 후 즉시 깨우기를 주 경로로 쓰고 주기 폴링은 길게(수 초) 두는** 조합이 좋다. 평상시에는 폴링이 거의 빈손으로 돌고, 안전망 역할만 한다.

### "CDC와 비교하면 폴링의 약점은 무엇인가요?"

셋이다.

**지연.** 폴링 주기만큼 늦다. CDC는 트랜잭션 로그를 실시간으로 따라가므로 더 빠르다.

**DB 부하.** 폴링은 주기적 조회를 발생시키지만 CDC는 로그를 읽으므로 테이블을 건드리지 않는다.

**애플리케이션 코드.** 폴링 퍼블리셔는 직접 만들어 유지해야 하고, 인스턴스 간 경쟁·재시도·정리를 다 다뤄야 한다. CDC는 그 역할을 별도 제품이 맡는다.

반대로 폴링의 이점도 분명하다. **구성 요소가 늘지 않고, DB 설정 권한(논리적 복제 활성화 등)이 필요 없으며, 디버깅이 쉽다** — SQL로 상태를 바로 볼 수 있다. **규모가 크지 않다면 폴링이 합리적**이라는 판단을 말할 수 있어야 한다.

### "outbox를 쓰면 중복이 없어지나요?" (시니어 변별 포인트)

없어지지 않는다. 오히려 **outbox는 at-least-once를 보장하는 장치이고, 그 대가가 중복**이다.

중복이 생기는 지점을 짚을 수 있어야 한다.

- **confirm을 못 받아 재발행하는 경우.** 브로커는 받았는데 응답만 유실됐을 수 있다.
- **markPublished 직전에 퍼블리셔가 죽는 경우.** 발행은 됐지만 표시가 안 되어 다음 주기에 다시 발행된다.
- **인스턴스 간 경쟁을 막는 잠금이 없는 경우.** 여러 인스턴스가 같은 행을 발행한다.

그래서 **outbox와 멱등 컨슈머는 세트**다. outbox가 "반드시 한 번 이상"을 보장하고, 멱등 컨슈머가 "여러 번 와도 결과가 같게"를 보장한다. 둘을 합쳐야 실질적인 exactly-once에 가까워진다.

메시지에 고유 ID를 심는 것(위 코드의 `setMessageId`)이 이 짝을 잇는 고리다. 컨슈머는 그 ID로 처리 이력을 확인해 중복을 걸러낸다.

### "이벤트 페이로드를 outbox에 저장하지 않고 발행 시점에 조회하면 안 되나요?"

안 하는 것이 맞다. 두 가지가 깨진다.

**첫째, 이벤트의 의미가 달라진다.** 이벤트는 "그 시점에 일어난 사실"이다. 발행 시점에 다시 조회하면 그 사이 바뀐 최신 상태를 담게 되어, "주문이 완료되었다"는 이벤트에 이미 취소된 주문의 상태가 실릴 수 있다.

**둘째, 순서가 뒤집힌 결과가 나온다.** 이벤트 A(완료)와 B(취소)가 순서대로 기록됐는데 발행 시점에 둘 다 조회하면 둘 다 "취소" 상태를 담는다. 이벤트 이력이 무의미해진다.

**"이벤트는 기록 시점의 스냅샷"**이라는 원칙을 지켜야 하고, 그래서 payload를 함께 저장한다.

### "outbox 테이블이 같은 DB에 있어야 하나요?"

**반드시 같은 DB, 같은 트랜잭션이어야 한다.** 다른 DB에 두면 이중 쓰기 문제가 그대로 돌아온다 — 업무 DB는 커밋됐는데 outbox DB 쓰기가 실패하는 상황이 생긴다.

같은 DB 안이라면 스키마를 분리하는 것은 무방하다. 다만 **트랜잭션이 같아야 한다**는 조건은 절대적이다.

한 가지 실무 주의점이 있다. **outbox INSERT가 업무 트랜잭션을 길게 만들지 않아야 한다.** 이벤트를 여러 건 기록해야 한다면 한 번에 배치 INSERT하고, 페이로드 직렬화 같은 무거운 작업은 트랜잭션 밖에서 미리 해둔다. 트랜잭션이 길어지면 락 유지 시간이 늘어 다른 요청에 영향을 준다.

---

## 한 줄 요약

DB와 브로커는 한 트랜잭션으로 못 묶이므로 **이벤트를 같은 트랜잭션 안에서 outbox 테이블에 기록하고 별도 퍼블리셔가 옮기는 것**이 정석이고, Kafka와 달리 RabbitMQ에는 CDC 정석 경로가 없어 **`FOR UPDATE SKIP LOCKED` 폴링 + publisher confirm 콜백에서 완료 표시**가 실무 기본형이다 — 이 구조는 본질적으로 at-least-once이므로 **멱등 컨슈머가 반드시 짝으로 따라와야 한다.**
