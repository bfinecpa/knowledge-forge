# Transactional Outbox 패턴 — "커밋됐는데 발행 실패"를 구조로 없애는 법

> 핵심 관전 포인트: **DB와 메시지 브로커는 하나의 트랜잭션으로 묶을 수
> 없다(이중 쓰기 문제). 커밋 먼저 하면 발행 실패 시 이벤트 유실,
> 발행 먼저 하면 롤백 시 거짓 이벤트 — 순서를 어떻게 바꿔도 실패한다.
> AFTER_COMMIT 리스너는 "롤백됐는데 발행됨"은 막지만 이벤트가
> 메모리에만 있어서 발행 실패·서버 크래시 시 유실된다(at-most-once).
> Outbox는 이벤트를 비즈니스 변경과 같은 DB 트랜잭션으로 outbox
> 테이블에 저장하고, 별도 릴레이(폴링 또는 CDC)가 읽어 발행한다 —
> 원자성은 DB 트랜잭션 하나로 확보하고, 전달은 at-least-once + 멱등
> 소비자로 완성한다.**

---

## 0. 질문 + 의도

**질문**: "DB 커밋 후에 이벤트를 발행해야 하는 요구사항을 어떻게
구현하나요? (AFTER_COMMIT, Transactional Outbox)"

**출제 의도**: "커밋됐는데 발행 실패" / "발행됐는데 롤백"의 양쪽
실패를 다 짚는지 본다. 분산 시스템 정합성의 축소판이라, 이 문제를
이해한 사람은 Kafka·MSA 정합성 문제 전반을 이해할 준비가 된 것이다.

> Spring Event와 `@TransactionalEventListener`의 기본 동작·phase·함정은
> `16-spring-event-transactional-event-listener.md`에 정리되어 있다.
> 이 문서는 그 다음 단계 — **AFTER_COMMIT으로도 안 되는 지점과
> Outbox 구현** — 에 집중한다.

## 1. 문제의 본질 — 이중 쓰기(dual write): 순서를 어떻게 바꿔도 실패한다

"주문을 저장하고, 주문 완료 이벤트를 Kafka에 발행한다"는 요구사항은
**서로 다른 두 시스템(DB, 브로커)에 쓰기 2번**을 뜻한다. 두 쓰기를
하나의 원자적 단위로 묶을 방법이 없다는 게 문제의 뿌리다.

가능한 순서는 둘뿐이고, 둘 다 깨진다:

| 순서 | 실패 시나리오 | 결과 |
|---|---|---|
| 커밋 → 발행 | 커밋 성공 후 발행 실패 (브로커 순단, 서버 크래시) | **이벤트 유실** — 주문은 있는데 후속 처리가 영영 없음 |
| 발행 → 커밋 | 발행 성공 후 커밋 실패 (제약 위반, 데드락 롤백) | **거짓 이벤트** — 존재하지 않는 주문의 이벤트가 소비됨 |

"try-catch로 잘 감싸면 되지 않나"가 안 되는 이유: 두 쓰기 사이 어느
지점에서든 프로세스가 죽을 수 있고(kill -9, OOM), 그 순간에는 어떤
catch 블록도 실행되지 않는다. **코드가 아니라 구조로 풀어야 하는
문제**라는 인식이 이 질문의 절반이다.

## 2. AFTER_COMMIT의 한계 — 방향 하나만 막고, 유실은 못 막는다

`@TransactionalEventListener(phase = AFTER_COMMIT)`는 "발행 → 커밋"
순서의 거짓 이벤트 문제를 깔끔하게 막는다. 롤백되면 리스너가 실행
자체를 안 하니까. 그런데 이 순간 우리는 표의 첫 줄, "커밋 → 발행"
순서로 옮겨 탔을 뿐이다:

```java
// AFTER_COMMIT: 거짓 이벤트는 막지만 유실은 못 막는다
@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) {
    kafkaTemplate.send("order-completed", event.payload());
    // ① 여기서 브로커 장애로 실패하면? → 커밋은 이미 확정, 이벤트만 증발
    // ② send() 직전에 서버가 재시작되면? → 이벤트는 메모리에만 있었으므로 증발
}
```

한계를 정리하면:

- **이벤트가 휘발성**: publishEvent()로 발행된 이벤트는 JVM 메모리에만
  존재한다. 커밋과 리스너 실행 사이에 프로세스가 죽으면 흔적도 없다.
- **발행 실패 시 재시도 근거가 없다**: 재시도하려 해도 "무엇을 못
  보냈는지"의 기록이 어디에도 없다. 재시도 로직 자체가 프로세스
  생존을 전제한다.
- 결국 전달 보장이 **at-most-once**(0번 또는 1번)다. "커밋됐으면
  반드시 언젠가는 발행된다"가 요구사항이라면 이 도구로는 안 된다.

알림처럼 한 건쯤 빠져도 되는 부수 작업이면 AFTER_COMMIT + @Async +
실패 로그로 충분하다. 정산·재고 차감·타 서비스 상태 동기화처럼
**유실이 곧 정합성 깨짐**인 이벤트라면 Outbox로 간다 — 이 구분을
요구사항에서 끌어내는 것이 설계 판단이다.

## 3. Outbox 패턴 — 이벤트를 메모리가 아니라 DB에 남긴다

발상의 전환: 브로커 발행을 트랜잭션에 묶으려 하지 말고, **"발행해야
한다는 사실"을 같은 DB에, 같은 트랜잭션으로 기록**한다. DB 쓰기 2번은
하나의 로컬 트랜잭션으로 묶을 수 있으니까.

### 3-1. 쓰기 경로 — 비즈니스 변경과 이벤트 레코드를 원자적으로

```sql
CREATE TABLE outbox_event (
    id             BIGINT PRIMARY KEY,          -- 이벤트 고유 ID (소비자 멱등 처리의 키)
    aggregate_type VARCHAR(50)  NOT NULL,       -- 예: "ORDER"
    aggregate_id   VARCHAR(50)  NOT NULL,       -- 예: 주문 ID (파티션 키 → 순서 보장 단위)
    event_type     VARCHAR(100) NOT NULL,       -- 예: "ORDER_COMPLETED"
    payload        TEXT         NOT NULL,       -- 이벤트 본문 (JSON)
    status         VARCHAR(20)  NOT NULL,       -- PENDING / PUBLISHED
    created_at     TIMESTAMP    NOT NULL,
    published_at   TIMESTAMP
);
```

```java
@Transactional
public Order complete(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();
    outboxRepository.save(OutboxEvent.of(
        "ORDER", order.getId(), "ORDER_COMPLETED", toJson(order)));
    return order;
    // 주문 변경과 outbox INSERT가 같은 트랜잭션:
    // 커밋되면 둘 다 확정, 롤백되면 둘 다 없던 일 — 이중 쓰기 문제 소멸
}
```

이 시점에 브로커는 등장하지도 않는다. 트랜잭션 안에는 DB 작업만 있다
(트랜잭션 안 외부 호출 문제를 피하는 효과도 겸한다 —
`22-external-api-call-inside-transaction.md` 참고).

### 3-2. 발행 경로 — 릴레이가 outbox를 읽어 브로커로

**방법 A: 폴링 퍼블리셔 (Polling Publisher)**

스케줄러가 주기적으로 미발행 이벤트를 집어 발행하고 마킹한다.

```java
@Scheduled(fixedDelay = 1000)
public void relay() {
    // 멀티 인스턴스에서 같은 이벤트를 동시에 집지 않도록 SKIP LOCKED
    List<OutboxEvent> events = outboxRepository.findPendingForUpdateSkipLocked(100);
    for (OutboxEvent event : events) {
        kafkaTemplate.send(topicOf(event), event.getAggregateId(), event.getPayload())
                     .get();                    // 브로커 ack까지 확인
        event.markPublished();                  // 성공한 것만 PUBLISHED로
    }
    // 발행 실패 시 마킹하지 않고 예외 → PENDING으로 남아 다음 주기에 재시도
}
```

- 장점: DB와 스케줄러만으로 구현 가능, 추가 인프라 없음.
- 단점: 폴링 주기만큼의 발행 지연, 주기적 SELECT가 DB 부하,
  주기를 줄이면 부하가 늘고 늘리면 지연이 커지는 트레이드오프.

**방법 B: CDC (Change Data Capture) — 로그 테일링**

Debezium 같은 CDC 커넥터가 DB의 트랜잭션 로그(MySQL binlog 등)에서
outbox 테이블의 INSERT를 감지해 Kafka로 흘려보낸다.

- 장점: 폴링 없음(지연 낮고 DB 부하 없음), 애플리케이션 코드에서
  릴레이가 사라짐.
- 단점: Debezium/Kafka Connect라는 인프라 운영 부담, 커넥터 장애
  시 발행 중단을 감시할 모니터링 체계 필요.

소규모·저빈도면 폴링으로 시작하고, 이벤트가 많아지고 지연 요구가
빡빡해지면 CDC로 진화시키는 경로가 일반적이다.

### 3-3. 전달 보장 — at-least-once, 그래서 소비자 멱등성이 세트다

릴레이는 "발행 성공 → 마킹" 순서인데, 발행은 됐고 마킹 전에 릴레이가
죽으면 다음 주기에 **같은 이벤트가 한 번 더 발행**된다. 즉 Outbox의
보장은 exactly-once가 아니라 **at-least-once**다. 유실 대신 중복을
받아들인 것이고, 중복은 소비자 쪽에서 제거한다:

```java
@KafkaListener(topics = "order-completed")
@Transactional
public void consume(OutboxMessage message) {
    // 이벤트 ID를 처리 이력 테이블에 INSERT (PK/unique 제약)
    // 이미 있으면 중복 → 조용히 스킵
    if (!processedEventRepository.tryInsert(message.eventId())) {
        return;
    }
    settlementService.settle(message.payload());
    // 처리 이력 INSERT와 비즈니스 처리가 같은 트랜잭션 → 소비 측 원자성
}
```

"Outbox를 쓴다"고 답하고 멱등 소비자를 빠뜨리면 반쪽 답변이다.
**유실 방지(Outbox) + 중복 제거(멱등 소비자)가 한 세트**여야
"커밋됐으면 정확히 한 번 효과가 반영된다"에 도달한다.

## 4. 운영에서 만나는 문제들 (가산점 포인트)

- **순서 보장**: 같은 주문의 이벤트들이 순서 바뀌어 소비되면 안 되는
  경우, `aggregate_id`를 Kafka 파티션 키로 보내 같은 파티션에 태운다.
  릴레이가 멀티 인스턴스면 같은 aggregate의 이벤트를 서로 다른
  인스턴스가 집어 순서가 흔들릴 수 있으므로, 순서가 중요한 도메인은
  aggregate 단위로 잠그거나 단일 릴레이로 운영한다.
- **outbox 테이블 비대화**: PUBLISHED 레코드는 계속 쌓인다. 보존
  기간을 정해 배치로 삭제/아카이브하지 않으면 폴링 쿼리가 점점
  느려진다. status + created_at 인덱스도 함께 설계한다.
- **적체 모니터링**: "PENDING인 채 N분 경과" 건수가 곧 발행 지연의
  지표다. 릴레이가 조용히 죽어 있는 장애는 에러 로그가 안 나므로,
  이 지표에 알람을 걸어야 발견된다.
- **payload 스키마 진화**: outbox에 쌓인 과거 이벤트와 새 코드의
  스키마가 어긋날 수 있다 — 이벤트 버전 필드를 처음부터 넣어두면
  마이그레이션이 쉬워진다.

## 5. 꼬리질문 대비 포인트

### "AFTER_COMMIT 리스너에서 발행하고, 실패하면 재시도하면 Outbox 없이도 되지 않나?"

재시도 로직은 프로세스가 살아 있어야 실행된다. 커밋 직후 서버가
재시작·크래시되면 이벤트는 메모리에만 있었으므로 재시도할 대상
자체가 사라진다. 또 "무엇을 못 보냈는지"의 영속적 기록이 없어서
장애 후 복구 시 어떤 이벤트를 다시 보내야 할지 알 수 없다. Outbox의
본질은 재시도가 아니라 **"보내야 할 것"의 내구성 있는 기록**이고,
그 기록을 비즈니스 변경과 원자적으로 남긴다는 점이다.

### "그럼 브로커에 먼저 발행하고 나서 DB 커밋하면 안 되나?"

방향만 바뀔 뿐 똑같이 깨진다. 발행 후 커밋이 실패(제약 위반, 데드락,
크래시)하면 존재하지 않는 데이터에 대한 거짓 이벤트가 이미 소비자에게
전달된 뒤다. 브로커 발행은 롤백이 없다. 커밋 먼저는 유실, 발행 먼저는
거짓 이벤트 — 순서 조정으로는 못 풀고 원자성의 단위를 DB 하나로
모으는 구조 변경(Outbox)이 필요하다는 게 이중 쓰기 문제의 결론이다.

### "Outbox는 중복 발행이 가능하다는데, 그럼 정합성이 깨지는 것 아닌가?"

Outbox가 제공하는 건 at-least-once — 유실은 없지만 중복은 있다.
중복은 소비자 멱등성으로 제거한다: 이벤트 고유 ID를 처리 이력
테이블에 유니크 제약으로 INSERT하고, 이미 있으면 스킵. 처리 이력
기록과 비즈니스 처리를 같은 트랜잭션으로 묶으면 소비 측도 원자적이
된다. "생산 측은 유실 방지, 소비 측은 중복 제거"로 역할을 나눠
사실상 exactly-once 효과에 도달하는 구조라고 답하면 된다.

### "폴링 릴레이와 CDC 중 무엇을 선택하나?" (시니어 변별 포인트)

트레이드오프 축은 지연·DB 부하·운영 복잡도다. 폴링은 추가 인프라
없이 스케줄러로 끝나지만 주기만큼 지연되고 주기적 쿼리가 DB를
때린다 — 이벤트 빈도가 낮고 몇 초 지연이 허용되면 충분하다. CDC는
binlog 기반이라 지연·부하 면에서 우수하지만 Debezium/Kafka Connect
운영이라는 새 부담이 생긴다 — 이벤트가 많고 지연 요구가 빡빡하며
이미 Kafka 인프라 운영 역량이 있는 조직에 맞다. "우리 팀이 그 인프라를
운영할 수 있는가"까지 넣어 판단한다고 답하면 시니어 답변이다.

### "릴레이를 여러 인스턴스로 띄우면 같은 이벤트를 동시에 발행하지 않나?"

폴링 쿼리에 `SELECT ... FOR UPDATE SKIP LOCKED`를 쓰면 각 인스턴스가
서로 잠긴 행을 건너뛰고 다른 행을 집으므로 동시 발행이 방지된다.
DB가 SKIP LOCKED를 지원하지 않거나 더 단순하게 가려면 분산 락
(ShedLock 등)으로 릴레이 자체를 한 번에 하나만 돌게 한다. 단 어느
쪽이든 at-least-once 특성(마킹 전 죽으면 재발행)은 남으므로 멱등
소비자는 여전히 필요하다.

---

## 한 줄 요약

DB와 브로커는 한 트랜잭션으로 묶을 수 없어 커밋 먼저면 유실, 발행
먼저면 거짓 이벤트라는 이중 쓰기 딜레마가 생기고, AFTER_COMMIT은
거짓 이벤트만 막을 뿐 메모리 이벤트의 유실(at-most-once)은 못 막는다
— Outbox는 "발행할 사실"을 비즈니스 변경과 같은 DB 트랜잭션으로
기록해 원자성을 확보하고, 릴레이(폴링/CDC)의 at-least-once 발행 +
소비자 멱등성으로 "커밋됐으면 정확히 한 번 효과가 반영된다"를
완성하는 패턴이다.
