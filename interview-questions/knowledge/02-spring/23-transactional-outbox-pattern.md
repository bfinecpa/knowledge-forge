# Transactional Outbox 패턴 — 스프링에서 "커밋됐는데 발행 실패"를 구조로 없애는 법

> 핵심 관전 포인트: **DB와 메시지 브로커는 서로 다른 시스템이라 하나의 트랜잭션으로 묶을 수 없다(이중 쓰기 문제). 커밋을 먼저 하면 발행 직전 크래시에서 이벤트가 유실되고, 발행을 먼저 하면 롤백 시 존재하지 않는 데이터의 거짓 이벤트가 나간다 — 순서를 어떻게 바꿔도 깨지고 try-catch로도 못 막는다(프로세스가 죽으면 catch도 안 돈다). XA/2PC로 묶는 길은 이론상 존재하나 가용성이 두 시스템의 곱으로 떨어지고 Kafka·RabbitMQ 모두 XA를 지원하지 않아 실무에서 배제된다. 스프링에서의 출발점은 `@TransactionalEventListener(AFTER_COMMIT)`인데, 이것은 "발행 먼저" 방향의 거짓 이벤트만 막을 뿐 이벤트가 JVM 메모리에만 있어 유실을 못 막는다(at-most-once). 그래서 "보낼 이벤트"를 비즈니스 변경과 같은 트랜잭션으로 같은 DB의 outbox 테이블에 INSERT해 이중 쓰기를 단일 쓰기로 바꾸고, 별도 릴레이가 그 행을 읽어 발행한다 — 폴링 릴레이는 PostgreSQL의 `FOR UPDATE SKIP LOCKED`로 여러 인스턴스가 같은 행을 집지 않게 하고, RabbitMQ라면 비동기 publisher confirm 콜백에서, Kafka라면 ack 확인 후에 발행 완료를 표시한다. 결과 보장은 at-least-once이므로 소비자 멱등성이 반드시 짝으로 따라온다.**

---

## 0. 질문 + 의도

**질문**: "DB 커밋 후에 이벤트를 발행해야 하는 요구사항을 어떻게 구현하나요? (AFTER_COMMIT, Transactional Outbox)"

**출제 의도**: "커밋됐는데 발행 실패" / "발행됐는데 롤백"의 양쪽 실패를 다 짚는지 본다. 분산 시스템 정합성의 축소판이라, 이 문제를 이해한 사람은 Kafka·MSA 정합성 문제 전반을 이해할 준비가 된 것이다.

이 문서의 자리를 먼저 못박아 둔다. 아웃박스는 여러 장에 걸치는 주제라 문서마다 맡은 각도가 다르다.

| 문서 | 맡는 각도 |
|---|---|
| **이 문서** | **스프링에서 어떻게 구현하는가** — 스프링 이벤트에서 출발해 아웃박스로 넘어가는 경로, 폴링 릴레이 구현, 운영 |
| `16-spring-event-transactional-event-listener.md` | `ApplicationEventPublisher`와 phase의 기본 동작·함정 |
| `06-kafka-messaging/12-transactional-outbox-cdc-kafka.md` | Kafka·CDC 관점 — WAL 논리적 디코딩, Debezium, 복제 슬롯 운영 |
| `06-kafka-messaging/35-rabbitmq-outbox-polling-publisher.md` | RabbitMQ 관점 — publisher confirms 결합의 상세 |
| `06-kafka-messaging/11-idempotent-consumer-implementation.md` | 소비자 쪽 중복 제거 구현 |
| `10-payment-consistency/10-distributed-saga-compensation-idempotency.md` | 분산 트랜잭션 일반론(Saga·보상)에서 아웃박스가 놓이는 위치 |

기준 버전은 Spring Boot 3.x / Spring Framework 6.x, DB는 PostgreSQL 14 이상이다.

## 1. 이중 쓰기 — 순서를 어떻게 바꿔도 실패하고, 2PC도 답이 아니다

### 1-1. 요구사항이 실제로 요구하는 것

"주문을 완료 처리하고, 주문 완료 이벤트를 브로커에 발행한다." 한 문장이지만 실행 시점에는 **서로 다른 두 저장소에 쓰기 2번**이다.

```java
@Transactional
public void complete(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();                                        // ① PostgreSQL에 쓰기
    rabbitTemplate.convertAndSend("order.events",
            "order.completed", new OrderCompleted(order));   // ② RabbitMQ에 쓰기
}
```

우리가 원하는 것은 **둘 다 되거나 둘 다 안 되는 것**이다. 그런데 `@Transactional`이 관리하는 것은 ①의 DB 커넥션뿐이고, ②는 완전히 다른 프로토콜로 다른 서버에 나가는 네트워크 호출이다. 롤백 신호는 브로커에 도달하지 않는다.

이렇게 **한 논리적 작업이 원자성 보장 없이 두 시스템에 쓰기를 하는 상황**을 이중 쓰기(dual write) 문제라고 부른다. 이름 그대로 "쓰기가 두 번"이라는 사실 자체가 문제의 이름이 된 것이다.

### 1-2. 순서 A: 커밋 먼저 — 이벤트가 유실된다

이벤트 발행을 커밋 뒤로 미루면 거짓 이벤트는 사라진다. 대신 다른 구멍이 열린다.

```
스레드                DB(PostgreSQL)              브로커
  │                        │                        │
  │  BEGIN                 │                        │
  ├───────────────────────>│                        │
  │  UPDATE orders ...     │                        │
  ├───────────────────────>│                        │
  │  COMMIT                │                        │
  ├───────────────────────>│ ★ 주문 완료 확정        │
  │                        │   (되돌릴 수 없다)      │
  │                        │                        │
  │   ✗ 여기서 프로세스 사망 (kill -9 / OOM / 파드 축출 / 배포 재시작)
  │     또는 브로커 순단으로 send() 실패
  │                        │                        │
  X  발행 코드에 도달 못 함  │                        │  (아무것도 안 옴)
                           │                        │
결과: 주문은 완료됐는데 정산·재고·알림 등 후속 처리가 영영 시작되지 않는다.
      더 나쁜 점 — 아무 데서도 에러가 안 난다. 조용히 한 건이 빠진다.
```

이 실패의 성질을 정확히 짚자. **유실은 소리를 내지 않는다.** 예외 로그도, 실패 카운터도 남지 않는다. 며칠 뒤 정산이 안 맞아서 대사(reconciliation)로 발견하는 것이 보통이다.

### 1-3. 순서 B: 발행 먼저 — 거짓 이벤트가 나간다

그러면 순서를 뒤집어 보자.

```
스레드                DB(PostgreSQL)              브로커
  │                        │                        │
  │  BEGIN                 │                        │
  ├───────────────────────>│                        │
  │  UPDATE orders ...     │  (아직 커밋 전)         │
  ├───────────────────────>│                        │
  │  publish OrderCompleted│                        │
  ├────────────────────────┼───────────────────────>│ ★ 발행 확정
  │                        │                        │   (되돌릴 수 없다)
  │                        │                        │      │
  │                        │                        │      ▼
  │                        │                        │  소비자가 이미 읽어 처리 시작
  │  COMMIT                │                        │
  ├───────────────────────>│ ✗ 실패                  │
  │                        │  (유니크 제약 위반,      │
  │                        │   데드락 롤백, 크래시)   │
  │                        │                        │
결과: 존재하지 않는 주문의 완료 이벤트가 세상에 나갔다.
      정산 서비스는 없는 주문을 정산하고, 재고 서비스는 없는 주문 때문에 재고를 깎는다.
```

**브로커 발행에는 롤백이 없다.** 메시지가 브로커에 들어가는 순간 그것은 이미 소비자에게 전달됐을 수도 있는 과거다. 우리 트랜잭션이 롤백된다고 해서 소비자의 머릿속에서 그 이벤트가 지워지지 않는다.

두 순서를 나란히 놓으면 이렇다.

| 순서 | 실패 지점 | 결과 | 발견 난이도 |
|---|---|---|---|
| 커밋 → 발행 | 커밋 성공 후, 발행 전 크래시 / 발행 실패 | **이벤트 유실** — 주문은 있는데 후속 처리가 없음 | 어렵다 (조용히 빠짐) |
| 발행 → 커밋 | 발행 성공 후 커밋 실패 | **거짓 이벤트** — 없는 주문의 이벤트가 소비됨 | 쉽다 (소비자에서 예외) |

### 1-4. "try-catch로 잘 감싸면 되지 않나요?"

가장 흔한 반론이고, 안 되는 이유가 명확하다.

**catch 블록은 프로세스가 살아 있어야 실행된다.** `kill -9`, OOM Killer, 쿠버네티스의 파드 축출, 노드 장애, 그냥 배포로 인한 재시작 — 이 중 어느 것도 catch를 실행시켜 주지 않는다. 두 쓰기 사이의 틈은 아무리 좁혀도 0이 되지 않고, 그 틈에서 프로세스가 사라질 확률은 요청량에 비례해 반드시 현실화된다.

한 걸음 더 나아간 반론인 "발행 실패하면 보상으로 DB를 되돌리면 되지 않나"도 같은 이유로 막힌다. 그 보상 코드 역시 프로세스 안에 있다.

그래서 결론이 이것이다. **이건 코드로 푸는 문제가 아니라 구조로 푸는 문제다.** 이 인식이 이 질문의 절반이다.

### 1-5. 왜 2PC(2단계 커밋)로 묶지 않는가

"두 시스템을 한 트랜잭션으로 묶을 수 없다"고 했지만, 이론적으로는 방법이 있다. **2단계 커밋(2PC, two-phase commit)**이다. 배제하는 이유를 말할 수 있어야 "선택지가 왜 아웃박스로 좁혀지는가"의 설명이 완성된다.

2PC에는 **코디네이터(coordinator, 조정자)**라는 중앙 심판이 있고 절차가 두 단계다.

```
[1단계 prepare]  코디네이터 --"커밋할 수 있나?"--> DB, 브로커
                 각 참여자는 자기 몫을 실행해 두되 커밋하지 않고,
                 자원을 잠근 채 "예, 언제든 커밋 가능합니다"로 답한다.

[2단계 commit]   전원 OK      -> "커밋하라" 전파
                 하나라도 NO  -> "중단하라" 전파
```

이 절차에 참여하려면 자원이 **XA**라는 표준 인터페이스를 구현해야 한다. XA는 "prepare와 commit을 나눠서 받을 수 있는" 자원 관리자 규격이고, 자바 쪽 코디네이터가 JTA 트랜잭션 매니저(Atomikos, Narayana 등)다.

배제 이유는 셋이다.

**(1) 가용성이 두 시스템의 곱으로 떨어진다.** 2PC 트랜잭션이 성공하려면 DB와 브로커가 **동시에** 살아 있어야 한다. 각각 99.9%라면 합쳐서 `0.999 × 0.999 = 99.8%`다. 연간 다운타임으로 환산하면 `8760시간 × 0.1% = 8.76시간`이 `8760 × 0.2% = 17.5시간`으로 두 배가 된다. **브로커가 흔들리면 주문 저장 자체가 실패한다** — 이벤트 발행 하나 때문에 핵심 기능의 가용성을 브로커에 묶는 셈이다.

**(2) prepare 이후 참여자가 잠금을 쥔 채 블로킹된다.** "커밋 가능합니다"라고 답한 참여자는 최종 결정이 올 때까지 행 잠금을 풀 수 없다. 이때 코디네이터가 죽으면 결정을 못 받은 트랜잭션(in-doubt transaction)이 잠금을 쥔 채 남고, 운영자가 수동으로 커밋/롤백을 판정해 줘야 한다. **한 지점의 장애가 DB 전체의 잠금 정체로 번지는 구조**다.

**(3) 무엇보다 브로커가 XA를 지원하지 않는다.** Kafka의 트랜잭션은 Kafka 내부(프로듀서 → 토픽 → 컨슈머 오프셋)의 원자성이지 외부 DB와 묶이는 XA가 아니다. RabbitMQ에는 AMQP 채널 트랜잭션(`txSelect`/`txCommit`)이 있지만 이 역시 브로커 내부 원자성이고 XA가 아니며, 성능 대가도 크다. **참여 자격 자체가 없으므로 2PC는 애초에 성립하지 않는다.**

### 1-6. 그래서 선택지는 하나로 좁혀진다

두 시스템을 원자적으로 묶을 수 없다면, 남은 길은 하나다. **원자성이 필요한 두 쓰기를 같은 시스템 안으로 끌어들이는 것.**

브로커에 보내야 할 것은 결국 "이런 이벤트를 발행해야 한다"는 사실이다. 그 사실을 브로커가 아니라 **같은 DB의 테이블에 적으면**, 비즈니스 변경과 이벤트 기록이 한 트랜잭션 안의 DB 쓰기 두 번이 되어 원자성이 자동으로 성립한다. 이것이 아웃박스다.

다만 스프링을 쓰고 있다면 그 앞에 한 정거장이 더 있다. `@TransactionalEventListener`다 — 많은 팀이 여기서 출발하고, 여기서 왜 막히는지를 알아야 아웃박스가 필요한 이유가 몸에 붙는다.

## 2. 스프링 이벤트로 어디까지 되고, 어디서 막히는가

### 2-1. `AFTER_COMMIT`이 막아주는 것 — "발행 먼저"의 거짓 이벤트

`ApplicationEventPublisher`로 발행한 이벤트는 기본이 **동기·같은 스레드·같은 트랜잭션**이다. `@EventListener`를 붙이면 `publishEvent()` 호출 즉시 리스너가 실행되므로 아직 커밋 전이다 — 1-3의 "발행 먼저"와 똑같은 상황이 된다.

`@TransactionalEventListener`는 실행 시점을 트랜잭션의 phase에 묶는다. 기본값인 `AFTER_COMMIT`이면 커밋이 확정된 뒤에만 리스너가 돈다.

```java
@Transactional
public void complete(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();
    // 이 시점에는 아직 아무것도 발행되지 않는다. 이벤트는 커밋 후 실행될
    // 콜백으로 등록만 된다 — 등록 메커니즘은 24번 문서의 동기화 콜백이다.
    eventPublisher.publishEvent(new OrderCompletedEvent(order.getId()));
}

@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) {
    rabbitTemplate.convertAndSend("order.events", "order.completed", event);
}
```

롤백되면 리스너는 실행 자체를 하지 않으므로 **거짓 이벤트가 원천적으로 없다.** 그리고 `@Async`까지 얹으면 발행이 원래 트랜잭션 스레드 밖으로 나가므로 응답 지연에도 영향을 주지 않는다. (phase 종류와 함정 상세는 `16-spring-event-transactional-event-listener.md`, 이 콜백이 실제로 어떤 기계 위에서 도는지는 `24-transaction-synchronization-connection-binding.md`에 있다.)

여기까지는 좋다. 문제는 우리가 표의 첫 줄, **"커밋 → 발행" 순서로 옮겨 탔을 뿐**이라는 점이다.

### 2-2. 못 막는 것 — 이벤트가 JVM 메모리에만 있다

```java
@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) {
    rabbitTemplate.convertAndSend("order.events", "order.completed", event);
    // ① 브로커 순단으로 여기서 예외가 나면? 커밋은 이미 확정, 이벤트만 증발한다.
    // ② 커밋 직후 이 메서드에 도달하기 전에 서버가 재시작되면?
    //    이벤트 객체는 힙에만 있었으므로 흔적도 없이 사라진다.
    // ③ @Async 큐(인메모리)에 대기 중이던 이벤트들도 재시작 시 통째로 사라진다.
}
```

한계를 셋으로 정리한다.

**이벤트가 휘발성이다.** `publishEvent()`가 만든 이벤트 객체는 JVM 힙에만 존재한다. 디스크에도, DB에도 없다. 프로세스가 사라지면 같이 사라진다.

**재시도할 근거가 없다.** 발행에 실패했을 때 재시도하려 해도 "무엇을 못 보냈는지"의 기록이 어디에도 없다. 재시도 로직 자체가 프로세스 생존을 전제로 하므로 1-4와 같은 벽에 부딪힌다.

**그래서 전달 보장이 at-most-once다.** 여기서 용어를 정리하고 가자.

| 보장 | 뜻 | 어긋났을 때 |
|---|---|---|
| at-most-once (최대 1회) | 중복은 없지만 **유실될 수 있다** | 이벤트가 한 건 빠진다 |
| at-least-once (최소 1회) | 유실은 없지만 **중복될 수 있다** | 같은 이벤트가 두 번 처리된다 |
| exactly-once (정확히 1회) | 유실도 중복도 없다 | 분산 환경에서 단독으로는 실질적으로 불가능 |

`AFTER_COMMIT` 리스너의 보장은 at-most-once다. **"커밋됐으면 반드시 언젠가는 발행된다"가 요구사항이라면 이 도구로는 도달할 수 없다.**

### 2-3. 그럼 언제까지 이벤트로 충분한가 — 판단 기준

무조건 아웃박스로 가는 것이 정답은 아니다. 아웃박스에는 테이블, 릴레이 프로세스, 정리 배치, 적체 모니터링이 전부 딸려 온다. 요구사항이 그 비용을 정당화하는지 판단하는 것이 설계다.

기준은 **"이 이벤트가 한 건 빠지면 무슨 일이 생기는가"** 하나다.

- **빠져도 되는 것**: 마케팅 푸시 알림, 최근 본 상품 기록, 대시보드 집계 갱신. 한 건 유실이 데이터 불일치를 만들지 않는다 → `AFTER_COMMIT` + `@Async` + 실패 로그로 충분하다.
- **빠지면 안 되는 것**: 정산 원장 기록, 재고 차감, 타 서비스의 상태 동기화, 포인트 적립. **유실이 곧 정합성 깨짐**이고 나중에 대사로 찾아내 수동 보정해야 한다 → 아웃박스로 간다.

이 구분을 요구사항에서 스스로 끌어내는 것이 답변의 설계 감각 부분이다.

## 3. 아웃박스 — 구현과 운영

### 3-1. 발상 — 브로커를 트랜잭션에 넣지 말고, "보낼 사실"을 DB에 넣는다

발상의 전환은 한 줄이다. **브로커 발행을 트랜잭션에 묶으려 애쓰지 말고, "발행해야 한다는 사실"을 같은 DB에 같은 트랜잭션으로 기록한다.**

아웃박스(outbox)는 말 그대로 **"보낼 편지함"**이다. 편지를 직접 우체국까지 들고 뛰는 대신 집 앞 편지함에 넣어 두면, 집배원(릴레이)이 와서 가져간다. 내가 편지를 넣는 행위와 집배원이 가져가는 행위가 분리되므로, 내가 넣자마자 쓰러져도 편지는 편지함에 남아 있다.

DB 쓰기 2번은 한 로컬 트랜잭션으로 묶을 수 있으므로 **이중 쓰기가 단일 쓰기로 바뀐다.** 이것이 패턴의 전부다.

```
[애플리케이션]
   │  BEGIN
   │    UPDATE orders SET status='COMPLETED' ...
   │    INSERT INTO outbox_event (...)          <- 이벤트를 "보내는" 게 아니라 "적는다"
   │  COMMIT   ← 둘 다 남거나 둘 다 없다
   ▼
[outbox_event 테이블]
   │
   │  ← 별도 프로세스(릴레이)가 폴링 또는 CDC로 읽는다
   ▼
[브로커: RabbitMQ / Kafka] ──> [소비자]
```

### 3-2. 테이블 스키마 — 컬럼마다 이유가 있다

PostgreSQL 기준 DDL이다.

```sql
CREATE TABLE outbox_event (
    id             bigserial     PRIMARY KEY,
    -- 이벤트 고유 ID. 소비자가 중복 제거의 멱등 키로 쓸 값이므로
    -- 반드시 메시지에 실어 보낸다. (UUID를 쓰면 릴레이가 여러 대여도
    -- 충돌 걱정이 없지만, bigserial은 대략의 생성 순서를 준다.)

    aggregate_type varchar(50)   NOT NULL,   -- 예: 'ORDER'. 토픽/라우팅 키 결정에 쓴다
    aggregate_id   varchar(64)   NOT NULL,
    -- 이 이벤트가 어느 애그리거트(하나로 묶여 변경되는 데이터 단위, 여기선 주문 1건)의
    -- 것인지. Kafka 파티션 키 / RabbitMQ 라우팅에 쓰이며 순서 보장의 단위가 된다.

    event_type     varchar(100)  NOT NULL,   -- 예: 'ORDER_COMPLETED'
    payload        jsonb         NOT NULL,   -- 이벤트 본문
    schema_version int           NOT NULL DEFAULT 1,
    -- 스키마 버전을 처음부터 넣어 둔다. 아웃박스에는 코드 배포 전에 쌓인
    -- 과거 이벤트가 남아 있을 수 있어, 소비자가 버전을 보고 분기해야 하는
    -- 순간이 반드시 온다. 나중에 추가하면 그때 쌓인 행에는 값이 없다.

    created_at     timestamptz   NOT NULL DEFAULT now(),
    processed_at   timestamptz,
    -- NULL이면 미발행. 상태를 별도 varchar 컬럼 대신 이 타임스탬프의
    -- NULL 여부로 표현하면 "언제 발행됐는가"까지 한 컬럼으로 얻는다.

    attempts       int           NOT NULL DEFAULT 0,
    last_error     text
    -- 실패가 반복되는 독성 이벤트(poison event)를 골라내기 위한 운영 컬럼.
    -- 이 값이 임계치를 넘으면 알람을 걸고 별도 처리한다.
);

-- 부분 인덱스: 조건에 맞는 행만 인덱스에 넣는 PostgreSQL 기능이다.
-- 폴링 쿼리는 항상 "미발행 행"만 찾으므로, 발행 완료된 행까지 인덱스에
-- 담을 이유가 없다. 발행 완료 행이 수천만 건 쌓여도 이 인덱스는
-- "아직 안 보낸 몇 건" 크기로 유지된다.
CREATE INDEX idx_outbox_unprocessed
    ON outbox_event (id)
    WHERE processed_at IS NULL;
```

`payload`를 `jsonb`로 둔 것은 운영 중 조회·필터가 쉬워서다. 다만 `jsonb`는 입력 JSON을 파싱해 내부 표현으로 저장하므로 **키 순서와 공백이 보존되지 않는다.** 발행 바이트를 그대로 지켜야 하는 경우(예: 서명 검증)에는 `text`로 둬야 한다.

**여기서 한 가지 함정을 미리 짚는다.** 릴레이를 만들 때 "마지막으로 처리한 `id` 이후"라는 고수위 표시(high-water mark) 방식을 쓰고 싶어지는데, **PostgreSQL에서 이건 이벤트를 건너뛴다.** 시퀀스 값은 INSERT 시점에 할당되지만 커밋 순서는 그와 다를 수 있기 때문이다.

```
트랜잭션 A: INSERT -> id=100 받음 ... 처리가 길어져 나중에 커밋
트랜잭션 B: INSERT -> id=101 받음 ... 먼저 커밋

릴레이가 이 사이에 조회하면 101만 보인다.
"마지막 처리 id = 101"을 기록해 두면, 뒤늦게 커밋된 100은 영영 조회되지 않는다.
```

그래서 기준은 반드시 **미처리 플래그(`processed_at IS NULL`)**여야 한다. 커밋되지 않은 행은 애초에 보이지 않고, 뒤늦게 커밋되면 그때 보이기 시작한다.

### 3-3. 쓰기 경로 — 스프링 이벤트에서 아웃박스로 넘어가는 지점

2절의 코드를 어떻게 바꾸는지가 이 문서의 실질적 출발점이다.

```java
// before: 커밋 후 브로커로 직접 발행 — 이벤트가 메모리에만 있어 유실된다
@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) {
    rabbitTemplate.convertAndSend("order.events", "order.completed", event);
}
```

```java
// after: 같은 트랜잭션 안에서 outbox 테이블에 INSERT한다
@Service
@RequiredArgsConstructor
public class OrderService {

    @Transactional
    public void complete(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.complete();

        // 브로커는 이 메서드에 등장하지 않는다. 트랜잭션 안에는 DB 작업만 남는다
        // — 22번 문서의 "트랜잭션 안 외부 호출" 문제를 동시에 피하는 효과도 있다.
        outboxRepository.save(OutboxEvent.of(
                "ORDER", order.getId().toString(), "ORDER_COMPLETED", toJson(order)));
    }   // 주문 변경과 outbox INSERT가 함께 커밋되거나 함께 롤백된다
}
```

스프링 이벤트를 쓰던 코드라면 리스너를 지우지 말고 **phase만 바꾸는 방법**도 있다. 도메인 레이어는 계속 `publishEvent()`로 이벤트를 던지고, 리스너가 그것을 outbox 행으로 바꿔 넣는 형태다.

```java
// 도메인은 그대로 이벤트를 발행하고, 어댑터가 아웃박스에 적는다.
// phase가 BEFORE_COMMIT인 것이 핵심이다 — 아직 커밋 전이므로 이 INSERT가
// 원래 트랜잭션에 그대로 포함된다. AFTER_COMMIT이면 커밋이 이미 끝난 뒤라
// 이 INSERT는 flush될 기회를 얻지 못하고 조용히 사라진다.
@TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
public void toOutbox(OrderCompletedEvent event) {
    outboxRepository.save(OutboxEvent.from(event));
}
```

이 형태의 값은 **도메인 코드가 아웃박스의 존재를 모른다**는 점이다. 발행 인프라를 나중에 바꿔도 도메인은 그대로다.

### 3-4. 발행 경로 — 릴레이를 만드는 두 갈래

outbox 테이블에 쌓인 행을 읽어 브로커로 보내는 별도 프로세스를 **릴레이(relay, 중계기)**라고 부른다. 만드는 방법은 크게 둘이다.

- **폴링 퍼블리셔(polling publisher)**: 스케줄러가 짧은 주기로 미발행 행을 조회해 발행한다. 애플리케이션 코드와 DB만으로 만들 수 있다.
- **CDC(Change Data Capture, 변경 데이터 캡처)**: DB의 트랜잭션 로그를 구독해 INSERT를 실시간으로 감지한다. PostgreSQL이라면 WAL을 논리적 디코딩으로 읽고, Debezium 같은 커넥터가 그 스트림을 브로커로 흘린다.

먼저 폴링부터 본다. 대부분의 팀이 여기서 시작하고, 이 문서에서 가장 실무적인 대목도 여기다.

### 3-5. 폴링 릴레이 — `FOR UPDATE SKIP LOCKED`가 핵심이다

**먼저 문제부터.** 릴레이를 여러 인스턴스로 띄우면(가용성을 위해 보통 그렇게 한다) 두 인스턴스가 **같은 미발행 행을 동시에 집는다.** 둘 다 발행하면 중복이고, 둘 다 "발행 완료" 표시를 하면 아무도 이상을 눈치채지 못한다.

`SELECT ... FOR UPDATE`로 잠그면 어떨까. 중복은 막지만 이번엔 **두 번째 인스턴스가 첫 번째 인스턴스의 잠금이 풀릴 때까지 그냥 대기한다.** 릴레이를 두 대 띄운 의미가 없어진다 — 처리량이 한 대 몫으로 고정된다.

**`SKIP LOCKED`가 정확히 이 지점을 푼다.** "이미 잠긴 행은 기다리지 말고 건너뛰고 그다음 행을 잠가라"는 지시다. 그러면 인스턴스마다 서로 다른 행 묶음을 집게 되어 릴레이를 늘린 만큼 처리량이 늘어난다. PostgreSQL 9.5부터 지원한다.

```
릴레이 A: SELECT ... LIMIT 3 FOR UPDATE SKIP LOCKED  -> id 1,2,3 을 잠근다
릴레이 B: SELECT ... LIMIT 3 FOR UPDATE SKIP LOCKED  -> 1,2,3 은 잠겨 있으니 건너뛰고
                                                        id 4,5,6 을 잠근다
릴레이 C: 같은 방식으로 7,8,9

-> 대기 없이 세 대가 동시에 서로 다른 일을 한다.
```

구현은 두 단계로 나눈다. 여기에 22번 문서에서 배운 원칙이 그대로 적용된다 — **DB 트랜잭션을 쥔 채 브로커로 네트워크 호출을 하지 않는다.**

```java
@Repository
@RequiredArgsConstructor
public class OutboxClaimRepository {

    private final JdbcTemplate jdbcTemplate;

    // 1단계: "내가 이 행들을 맡는다"를 짧은 트랜잭션으로 선점(claim)만 한다.
    // 발행은 이 트랜잭션 밖에서 한다 — 브로커가 느려져도 커넥션을 물지 않기 위해서다.
    @Transactional
    public List<OutboxEvent> claim(String workerId, int size) {
        return jdbcTemplate.query("""
            WITH picked AS (
                SELECT id
                  FROM outbox_event
                 WHERE processed_at IS NULL
                   AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
                 ORDER BY id
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED
                 -- SKIP LOCKED: 다른 릴레이가 이미 잠근 행은 기다리지 않고 건너뛴다.
                 -- ORDER BY id: 같은 애그리거트의 이벤트가 생성 순서대로 나가게 한다.
            )
            UPDATE outbox_event o
               SET claimed_at = now(), claimed_by = ?, attempts = attempts + 1
              FROM picked
             WHERE o.id = picked.id
         RETURNING o.*
            """, rowMapper, size, workerId);
        // claimed_at 만료 조건(5분)이 있는 이유: 발행 중 릴레이가 죽으면 그 행은
        // 선점된 채 영영 남는다. 시간이 지나면 다른 릴레이가 다시 주워 가게 한다.
        // 그래서 이 구조는 필연적으로 at-least-once다 — 이미 발행됐는데 표시 전에
        // 죽은 행이 재발행될 수 있다.
    }

    @Transactional
    public void markPublished(long id) {
        jdbcTemplate.update(
            "UPDATE outbox_event SET processed_at = now() WHERE id = ?", id);
    }
}
```

```java
@Component
@RequiredArgsConstructor
public class OutboxRelay {

    private final OutboxClaimRepository repository;
    private final EventPublishPort publisher;   // RabbitMQ / Kafka 구현체
    private final String workerId = UUID.randomUUID().toString();

    // fixedDelay: 이전 실행이 "끝난 뒤" 1초를 센다. fixedRate로 두면 발행이
    // 느려질 때 실행이 겹쳐 쌓이므로, 릴레이에는 fixedDelay가 맞다.
    @Scheduled(fixedDelay = 1000)
    public void relay() {
        List<OutboxEvent> events = repository.claim(workerId, 100);
        for (OutboxEvent event : events) {
            // 이 호출은 DB 트랜잭션 밖이다. 브로커가 3초 걸려도 커넥션은 풀에 있다.
            publisher.publish(event);
        }
    }
}
```

**한 가지 정직하게 짚을 것.** 선점과 발행을 나누지 않고 트랜잭션 안에서 그대로 발행하는 구현도 흔하다(코드가 훨씬 짧다). 배치 100건에 브로커 응답이 빠르다면 실무에서 대체로 견딘다. 다만 그 구조는 **브로커 지연이 릴레이의 DB 커넥션 점유로 번역되는 경로**를 그대로 남기므로, 릴레이에 전용 커넥션풀을 주고 배치 크기를 작게 잡는 등의 제한을 함께 둬야 한다. 판단 근거를 말할 수 있으면 어느 쪽을 골라도 된다.

### 3-6. RabbitMQ로 발행할 때 — publisher confirm 콜백에서 표시한다

여기가 RabbitMQ 특유의 함정이다.

`rabbitTemplate.convertAndSend()`는 **메시지를 소켓에 밀어 넣고 바로 리턴한다.** 브로커가 그 메시지를 받아 디스크에 안전하게 넣었는지는 아직 모른다. 이 상태에서 `processed_at`을 찍으면 "발행했다고 표시했지만 실제로는 브로커에 안 들어간" 유실이 생긴다 — 아웃박스를 만든 이유가 통째로 무너진다.

**publisher confirms**는 브로커가 "이 메시지 내가 책임진다"고 보내주는 확인 응답이다. 이걸 받고 나서 표시해야 한다.

```java
@Configuration
public class RabbitConfig {
    @Bean
    public CachingConnectionFactory connectionFactory() {
        CachingConnectionFactory factory = new CachingConnectionFactory(host);
        // CORRELATED: 확인 응답에 우리가 붙인 식별자를 함께 돌려준다.
        // 이게 있어야 "어느 메시지에 대한 ack인지" 알 수 있다.
        factory.setPublisherConfirmType(CachingConnectionFactory.ConfirmType.CORRELATED);
        // 라우팅될 큐가 하나도 없으면 되돌려 받기 위한 설정.
        // confirm만으로는 "브로커는 받았지만 아무 큐에도 안 들어간" 상황을 못 잡는다.
        factory.setPublisherReturns(true);
        return factory;
    }
}

@Component
@RequiredArgsConstructor
public class RabbitOutboxPublisher implements EventPublishPort {

    private final RabbitTemplate rabbitTemplate;
    private final OutboxClaimRepository repository;

    @PostConstruct
    void registerCallback() {
        // 확인 응답은 비동기로 온다. 그래서 "발행 완료" 표시는 반드시
        // 이 콜백 안에서 해야 한다 — convertAndSend() 직후가 아니다.
        rabbitTemplate.setConfirmCallback((correlation, ack, cause) -> {
            long outboxId = Long.parseLong(correlation.getId());
            if (ack) {
                repository.markPublished(outboxId);
            } else {
                // nack: 브로커가 책임질 수 없다고 답한 것. 표시하지 않고 두면
                // claimed_at 만료 후 다른 주기에 다시 집어 재시도된다.
                log.warn("outbox nack id={} cause={}", outboxId, cause);
            }
        });
        rabbitTemplate.setMandatory(true);
        rabbitTemplate.setReturnsCallback(returned ->
            log.error("라우팅 실패 — 바인딩 설정 오류 가능: {}", returned.getMessage()));
    }

    @Override
    public void publish(OutboxEvent event) {
        // CorrelationData에 outbox의 PK를 실어 보낸다. 콜백에서 이 값으로
        // 어느 행을 PUBLISHED로 표시할지 찾는다.
        rabbitTemplate.convertAndSend(
                exchangeOf(event), routingKeyOf(event), event.payload(),
                new CorrelationData(String.valueOf(event.id())));
    }
}
```

메시지가 실제로 살아남으려면 세 가지가 동시에 필요하다는 것도 함께 알아 두자 — **메시지 persistent + 큐 durable + 브로커 확인(confirm)**. 셋 중 하나라도 빠지면 브로커 재시작 시 메시지가 사라진다. (상세는 `06-kafka-messaging/28-rabbitmq-durability-publisher-confirms.md`, 아웃박스와의 결합 전체는 `06-kafka-messaging/35-rabbitmq-outbox-polling-publisher.md`.)

### 3-7. Kafka로 발행할 때의 차이

Kafka는 확인 응답을 `CompletableFuture`로 돌려주므로 형태가 조금 다르다.

```java
@Override
public void publish(OutboxEvent event) {
    // 키를 aggregate_id로 준다. Kafka는 같은 키를 같은 파티션에 보내고
    // 파티션 안에서는 순서가 보장되므로, "같은 주문의 이벤트 순서"가 지켜진다.
    kafkaTemplate.send(topicOf(event), event.aggregateId(), event.payload())
        .whenComplete((result, ex) -> {
            if (ex == null) {
                repository.markPublished(event.id());   // ack 확인 후에만 표시
            } else {
                log.warn("kafka 발행 실패 id={}", event.id(), ex);
            }
        });
}
```

프로듀서 설정에서 `acks=all`(모든 in-sync 복제본이 받아야 ack)을 함께 잡아야 브로커 한 대가 죽어도 유실되지 않는다. `acks=1`이면 리더만 받고 ack가 오므로, 리더가 복제 전에 죽으면 아웃박스에는 PUBLISHED로 표시됐는데 메시지는 사라진 상태가 된다.

### 3-8. CDC 릴레이 — 폴링을 없애는 길

CDC는 애플리케이션 릴레이를 아예 없앤다. Debezium 커넥터가 PostgreSQL의 **WAL(Write-Ahead Log, 커밋 전에 변경 내용을 먼저 기록해 두는 로그)**을 논리적 디코딩으로 읽어 `outbox_event`의 INSERT를 감지하고 그대로 Kafka로 흘린다.

핵심 성질은 **커밋이 WAL에 남는 순간 발행이 예약된 것과 같다**는 것이다. 폴링처럼 주기를 기다리지 않고, 조회 쿼리로 DB를 때리지도 않는다.

대가는 인프라다. Debezium과 Kafka Connect라는 운영 대상이 늘고, 그중에서도 **복제 슬롯(replication slot)**이 급소다. 슬롯은 "아직 이 소비자가 안 읽은 WAL"을 서버가 지우지 못하게 붙잡는 장치라, 커넥터가 오래 죽어 있으면 데이터가 사라지는 게 아니라 **WAL이 계속 쌓여 디스크가 차고 DB 전체가 멈춘다.** (이 운영 상세는 `06-kafka-messaging/12-transactional-outbox-cdc-kafka.md`에 있다.)

그리고 RabbitMQ에는 Debezium 같은 표준 경로가 없다. Kafka로 흘린 뒤 다시 옮기는 구성은 배보다 배꼽이 크므로, **RabbitMQ 환경의 사실상 기본 선택은 폴링 퍼블리셔**다.

### 3-9. 폴링 vs CDC — 무엇을 기준으로 고르는가

| | 폴링 퍼블리셔 | CDC (Debezium) |
|---|---|---|
| 추가 인프라 | 없음 (스케줄러 + DB) | Kafka Connect, Debezium |
| 발행 지연 | 폴링 주기만큼 (보통 0.5~수 초) | 수십 ms 수준 |
| DB 부하 | 주기적 SELECT + UPDATE가 계속 발생 | 조회 부하 없음 (WAL 구독) |
| 운영 급소 | 릴레이가 조용히 죽는 것, 테이블 비대화 | 복제 슬롯 적체 → 디스크 고갈 |
| 브로커 | RabbitMQ·Kafka 모두 가능 | 사실상 Kafka |
| 코드 위치 | 애플리케이션 안 | 애플리케이션 밖 |

트레이드오프 축은 **지연 · DB 부하 · 운영 복잡도** 셋이다. 폴링은 주기를 줄이면 지연이 줄고 DB 부하가 늘며, 늘리면 반대가 된다 — 이 다이얼을 돌릴 수 있다는 것 자체가 폴링의 장점이기도 하다.

일반적인 경로는 **폴링으로 시작해서, 이벤트량이 늘고 지연 요구가 빡빡해지고 팀에 Kafka Connect 운영 역량이 생겼을 때 CDC로 옮기는 것**이다. 아웃박스 테이블 스키마와 쓰기 경로는 그대로 두고 읽는 쪽만 바꾸면 되므로 전환 비용이 크지 않다.

### 3-10. 운영 1 — 아웃박스 테이블은 반드시 커진다

발행이 끝난 행을 그대로 두면 테이블은 서비스 트래픽에 비례해 무한히 커진다. 초당 50건이면 하루 432만 건, 한 달이면 1억 3천만 건이다. 3-2의 부분 인덱스 덕분에 폴링 쿼리 자체는 빠르지만, 테이블 크기는 백업·복제·`VACUUM` 비용으로 되돌아온다.

**방법 A: 정리 배치로 지운다.**

```sql
-- 발행 후 7일 지난 행 삭제. 한 번에 전부 지우면 긴 트랜잭션이 되어
-- 락과 WAL 폭증을 부르므로, 배치 크기를 끊어 반복 실행한다.
DELETE FROM outbox_event
 WHERE ctid IN (
     SELECT ctid FROM outbox_event
      WHERE processed_at < now() - interval '7 days'
      LIMIT 10000
 );
```

여기서 PostgreSQL 특유의 주의점이 있다. **PostgreSQL의 DELETE는 행을 즉시 지우지 않고 "죽은 튜플(dead tuple)"로 표시만 한다.** 실제 공간 회수는 `VACUUM`이 한다. 아웃박스처럼 INSERT와 DELETE가 쉴 새 없이 도는 테이블은 죽은 튜플이 빠르게 쌓이므로, autovacuum이 따라오지 못하면 테이블과 인덱스가 부풀어(bloat) 조회가 점점 느려진다. 이 테이블만 autovacuum을 공격적으로 설정하는 것이 실무 대응이다.

```sql
ALTER TABLE outbox_event SET (
    autovacuum_vacuum_scale_factor = 0.02,   -- 기본 0.2 -> 2%만 죽어도 청소 시작
    autovacuum_vacuum_cost_delay = 0         -- 청소를 느리게 하지 않는다
);
```

**방법 B: 파티셔닝으로 통째로 떼어낸다.** 규모가 크면 이쪽이 정석이다.

```sql
-- created_at 기준 범위 파티셔닝 (일 단위)
CREATE TABLE outbox_event (
    ...
) PARTITION BY RANGE (created_at);

CREATE TABLE outbox_event_20260902 PARTITION OF outbox_event
    FOR VALUES FROM ('2026-09-02') TO ('2026-09-03');

-- 보관 기간이 지난 파티션은 삭제가 아니라 통째로 드롭한다.
DROP TABLE outbox_event_20260826;
```

`DROP TABLE`은 파일을 지우는 것이라 **죽은 튜플도, VACUUM도 발생하지 않는다.** DELETE의 부풀림 문제를 원천적으로 없애는 것이 파티셔닝의 진짜 값이다.

### 3-11. 운영 2 — 순서 보장은 릴레이가 여러 대일 때 깨진다

"같은 주문의 `CREATED` → `PAID` → `SHIPPED`가 순서대로 소비돼야 한다"는 요구가 있다면 주의할 지점이 셋이다.

**브로커 쪽 순서**는 비교적 쉽다. Kafka는 `aggregate_id`를 키로 주면 같은 파티션에 들어가고 파티션 내 순서가 보장된다. RabbitMQ는 하나의 큐 안에서는 FIFO지만, 컨슈머를 여러 개 붙이거나 prefetch를 크게 잡으면 처리 순서가 흔들린다.

**릴레이 쪽 순서가 진짜 문제다.** 릴레이 A가 id=10을 집고 릴레이 B가 id=11을 집었는데 A가 잠깐 느리면, **11이 10보다 먼저 발행된다.** `SKIP LOCKED`가 처리량을 준 대가로 순서를 가져간 것이다.

대응은 셋 중 하나다.

- **단일 릴레이로 운영한다.** 가장 단순하고, 이벤트량이 적으면 이걸로 충분하다. ShedLock 같은 분산 락으로 "여러 인스턴스 중 한 번에 하나만 실행"을 강제하면 가용성은 유지하면서 순서를 지킬 수 있다.
- **애그리거트 단위로 릴레이를 나눈다.** `hash(aggregate_id) % 릴레이수`로 담당을 고정하면, 같은 주문의 이벤트는 항상 같은 릴레이가 처리하므로 순서가 유지되면서 전체 처리량은 릴레이 수만큼 늘어난다.
- **순서를 포기하고 소비자가 흡수한다.** 이벤트에 시퀀스 번호를 넣고 소비자가 "이미 더 나중 상태면 무시"하도록 만든다. 상태 기계 가드와 같은 발상이다.

**순서 요구가 실제로 있는지부터 따지는 것**도 답변에 넣으면 좋다. 상당수의 이벤트는 순서와 무관하고, 순서 보장은 공짜가 아니다.

### 3-12. 운영 3 — 릴레이는 조용히 죽는다

아웃박스 운영에서 가장 위험한 장애는 **릴레이가 멈추는 것**이다. 애플리케이션은 정상이고 주문도 잘 저장되며 에러 로그도 안 나온다. 다만 outbox 테이블에 행만 쌓인다. 며칠 뒤 다른 팀이 "우리 쪽에 이벤트가 안 들어온다"고 알려주기 전까지 아무도 모른다.

그래서 **지표에 알람을 거는 것이 구현의 일부**다.

```sql
-- 발행 적체: 미처리인 채 N분 넘은 건수. 이 값이 0보다 크게 유지되면 릴레이 이상.
SELECT count(*) AS backlog,
       max(now() - created_at) AS oldest_age
  FROM outbox_event
 WHERE processed_at IS NULL
   AND created_at < now() - interval '5 minutes';

-- 독성 이벤트: 반복 실패로 attempts만 올라가는 행
SELECT id, event_type, attempts, last_error
  FROM outbox_event
 WHERE processed_at IS NULL AND attempts > 10;
```

첫 번째 쿼리의 `oldest_age`가 특히 좋은 지표다. 건수는 트래픽에 따라 출렁이지만, **가장 오래된 미처리 행의 나이는 "발행이 얼마나 밀렸는가"를 직접 말해준다.**

### 3-13. 결론 — 보장은 at-least-once이고, 그래서 멱등 소비자가 짝이다

릴레이는 "발행 → 표시" 순서로 일한다. 발행은 성공했는데 `processed_at`을 찍기 전에 릴레이가 죽으면, 그 행은 미처리로 남아 **다음 주기에 한 번 더 발행된다.**

이 창을 없앨 수는 없다. 발행과 표시가 서로 다른 시스템에 대한 쓰기이므로, **아웃박스가 풀었던 이중 쓰기 문제가 릴레이 안에서 축소판으로 재현되는 것**이다. 차이는 이번엔 유실이 아니라 중복이라는 점이고, 우리는 그 교환을 의도적으로 받아들인다 — 유실은 되돌릴 수 없지만 중복은 소비자가 흡수할 수 있기 때문이다.

그래서 아웃박스의 보장은 **at-least-once**이고, 결론은 하나다. **소비자는 반드시 멱등해야 한다.**

```java
@RabbitListener(queues = "settlement.order-completed")
@Transactional
public void consume(OrderCompletedMessage message) {
    // 프로듀서가 실어 보낸 outbox id(= 이벤트 고유 ID)를 멱등 키로 쓴다.
    // INSERT를 먼저 시도하는 것이 핵심이다 — "이미 있나?" 조회 후 INSERT는
    // 그 사이에 다른 스레드가 끼어들 수 있지만, 유니크 제약은 DB가
    // 쓰기 시점에 원자적으로 판정한다.
    if (!processedEventRepository.insertIfAbsent(message.eventId())) {
        return;   // 중복 배달이다. 예외가 아니라 정상 상황이므로 조용히 끝낸다.
    }
    settlementService.settle(message.payload());
    // 처리 이력 INSERT와 비즈니스 처리가 같은 트랜잭션이므로,
    // 정산이 실패하면 이력도 함께 롤백되어 재시도 대상으로 남는다.
}
```

**"아웃박스를 씁니다"라고만 답하고 멱등 소비자를 빠뜨리면 반쪽 답변이다.** 생산 측은 유실을 막고(아웃박스), 소비 측은 중복을 제거해야(멱등 소비자) 비로소 "커밋됐으면 정확히 한 번의 효과가 반영된다"에 도달한다. 키 선정·원자성·이력 보관 기간 같은 구현 디테일은 `06-kafka-messaging/11-idempotent-consumer-implementation.md`에 있다.

## 4. 꼬리질문 대비 포인트

### "`AFTER_COMMIT` 리스너에서 발행하고, 실패하면 재시도하면 아웃박스 없이도 되지 않나요?"

재시도 로직은 **프로세스가 살아 있어야 실행된다.** 커밋 직후 서버가 크래시되거나 재배포로 재시작되면 이벤트 객체는 힙에만 있었으므로 재시도할 대상 자체가 사라진다. `@Async`를 썼다면 실행 대기 중이던 인메모리 큐도 통째로 사라진다.

그리고 더 근본적인 문제는 **"무엇을 못 보냈는지"의 영속적 기록이 없다**는 것이다. 장애 복구 후 어떤 이벤트를 다시 보내야 하는지 알아낼 방법이 없어, 결국 비즈니스 테이블을 뒤져 "이벤트가 나갔어야 할 것 같은" 행을 추정해야 한다.

**아웃박스의 본질은 재시도가 아니라 "보내야 할 것"의 내구성 있는 기록**이고, 그 기록을 비즈니스 변경과 원자적으로 남긴다는 점이다. 재시도는 그 기록이 있어서 가능해진 부수 효과에 가깝다.

### "그럼 브로커에 먼저 발행하고 나서 DB를 커밋하면 안 되나요?"

방향만 바뀔 뿐 똑같이 깨진다. 발행 후 커밋이 실패하면(유니크 제약 위반, 데드락 롤백, 크래시) **존재하지 않는 데이터에 대한 거짓 이벤트가 이미 소비자에게 전달된 뒤**다. 브로커 발행에는 롤백이 없다.

굳이 비교하면 유실보다 거짓 이벤트가 **발견은 쉽다** — 소비자가 없는 주문을 조회하다 예외를 던지므로 로그에 남는다. 하지만 그 사이 재고가 깎이거나 정산이 잡혔다면 이미 오염이 발생한 뒤다.

핵심은 **순서 조정으로는 못 푼다**는 것이다. 원자성이 필요한 두 쓰기가 서로 다른 시스템에 있는 한, 어느 순서로 놓아도 그 사이에 틈이 있다. 두 쓰기를 같은 시스템(DB) 안으로 모으는 구조 변경만이 답이다.

### "왜 XA/2PC로 DB와 브로커를 묶지 않나요?" (시니어 변별 포인트)

세 가지를 순서대로 말한다.

**첫째, 가용성이 곱으로 떨어진다.** 2PC는 두 참여자가 동시에 살아 있어야 성립하므로 `99.9% × 99.9% = 99.8%`, 연간 다운타임이 8.76시간에서 17.5시간으로 두 배가 된다. 그리고 그 영향이 "이벤트 발행 실패"에 그치지 않고 **주문 저장 자체의 실패**로 나타난다 — 부수적인 기능 때문에 핵심 기능의 가용성을 깎는 셈이다.

**둘째, prepare 이후 참여자가 잠금을 쥔 채 블로킹된다.** 코디네이터가 죽으면 결정을 못 받은 in-doubt 트랜잭션이 잠금을 쥔 채 남아 운영자의 수동 판정이 필요해진다. 한 지점의 장애가 DB 전체의 잠금 정체로 번진다.

**셋째, 애초에 브로커가 XA를 지원하지 않는다.** Kafka 트랜잭션은 Kafka 내부의 원자성이지 XA가 아니고, RabbitMQ의 채널 트랜잭션도 마찬가지다. **참여 자격이 없으므로 논의가 성립하지 않는다.**

여기에 한 문장을 덧붙이면 좋다. **아웃박스는 "분산 원자성을 포기하고, 로컬 원자성 + 비동기 전달 + 소비자 멱등성으로 같은 효과를 재구성한 것"**이다. 문제를 푼 것이 아니라 문제가 성립하지 않는 형태로 바꾼 것에 가깝다.

### "아웃박스는 중복 발행이 가능하다는데, 그러면 정합성이 깨지는 것 아닌가요?"

아웃박스가 제공하는 것은 at-least-once다. 유실은 없지만 중복은 있다. 그리고 그것은 결함이 아니라 **의도적 교환**이다 — 유실된 이벤트는 되돌릴 수 없지만 중복된 이벤트는 소비자가 걸러낼 수 있으므로, 둘 중 하나를 골라야 한다면 중복이 훨씬 다루기 쉽다.

중복 제거는 소비 측에서 한다. 이벤트 고유 ID를 처리 이력 테이블에 유니크 제약으로 INSERT하고, 이미 있으면 조용히 스킵한다. 이때 **처리 이력 기록과 비즈니스 처리를 같은 트랜잭션으로 묶는 것**이 핵심이다 — 따로 커밋하면 "이력은 남았는데 처리는 롤백된" 이벤트가 영영 재처리되지 않는다.

정리하면 **"생산 측은 유실 방지, 소비 측은 중복 제거"**로 역할을 나눠 결과적으로 exactly-once에 상응하는 효과에 도달하는 구조다. 이때의 exactly-once는 전달 보장이 아니라 **효과의 일회성**이라는 점까지 짚으면 정확하다.

### "폴링 릴레이와 CDC 중 무엇을 선택하나요?"

트레이드오프 축은 **지연 · DB 부하 · 운영 복잡도** 셋이다.

폴링은 추가 인프라 없이 스케줄러로 끝나지만 주기만큼 지연되고 주기적 쿼리가 DB를 때린다. 이벤트 빈도가 낮고 몇 초 지연이 허용되면 이걸로 충분하다. 특히 **RabbitMQ 환경에서는 Debezium 같은 표준 CDC 경로가 없으므로 폴링이 사실상 기본 선택**이다.

CDC는 WAL 구독이라 지연과 부하 면에서 우수하지만 Debezium/Kafka Connect 운영이라는 새 부담이 생기고, 복제 슬롯이 적체되면 WAL이 쌓여 **DB 디스크가 차는** 종류의 장애를 새로 떠안는다.

판단 기준에 **"우리 팀이 그 인프라를 운영할 수 있는가"**를 넣어 답하면 좋다. 그리고 아웃박스 테이블 스키마와 쓰기 경로가 동일하므로 **폴링으로 시작해 나중에 CDC로 갈아타는 경로가 열려 있다**는 점을 덧붙이면, 되돌릴 수 있는 결정과 아닌 결정을 구분하는 감각을 보여줄 수 있다.

### "릴레이를 여러 인스턴스로 띄우면 같은 이벤트를 동시에 발행하지 않나요?"

폴링 쿼리에 `SELECT ... FOR UPDATE SKIP LOCKED`를 쓴다. `FOR UPDATE`만 쓰면 두 번째 인스턴스가 잠금이 풀릴 때까지 **기다리므로** 릴레이를 늘린 의미가 없어지는데, `SKIP LOCKED`는 잠긴 행을 건너뛰고 다음 행을 집게 해서 인스턴스 수만큼 처리량이 늘어난다. PostgreSQL 9.5부터 쓸 수 있다.

더 단순하게 가려면 ShedLock 같은 분산 락으로 릴레이 자체가 한 번에 하나만 돌게 만든다. 순서 보장이 필요한 도메인에서는 오히려 이쪽이 맞다 — `SKIP LOCKED`는 처리량을 주는 대신 **같은 애그리거트 이벤트의 발행 순서를 흔든다.**

어느 쪽이든 **at-least-once 특성은 남는다.** 발행 후 표시 전에 죽으면 재발행되므로 멱등 소비자는 여전히 필수다.

### "아웃박스 테이블이 병목이 되지는 않나요?" (가산점 포인트)

세 방향으로 답한다.

**쓰기 부하**: 아웃박스 INSERT는 비즈니스 트랜잭션에 쓰기 한 건을 더한다. append-only INSERT라 인덱스 갱신도 가볍지만, 트랜잭션 지속 시간이 조금 길어지는 것은 사실이다. 커넥션 점유 시간이 늘어나므로 22번 문서의 계산이 그대로 적용된다.

**읽기 부하**: 3-2의 부분 인덱스(`WHERE processed_at IS NULL`)로 해결한다. 발행 완료 행이 아무리 쌓여도 인덱스 크기는 미처리 건수에 비례하므로, 폴링 쿼리는 테이블 크기와 무관하게 일정한 비용을 유지한다.

**공간과 부풀림**: 3-10의 정리 배치 또는 파티셔닝이다. PostgreSQL에서는 DELETE가 죽은 튜플을 남긴다는 점 때문에 대량 삭제보다 **파티션 드롭**이 우월하다 — VACUUM 없이 파일 삭제로 끝난다.

정말로 병목이 된다면 그다음 선택지는 **아웃박스 전용 DB 분리**인데, 그 순간 비즈니스 변경과 outbox INSERT가 다시 다른 시스템이 되어 **이중 쓰기 문제가 부활한다.** 아웃박스는 "같은 DB"라는 전제 위에서만 성립하는 패턴이라는 점을 짚으면 패턴을 이해했다는 신호가 된다.

---

## 한 줄 요약

DB와 브로커는 서로 다른 시스템이라 한 트랜잭션으로 묶을 수 없어 커밋 먼저면 유실, 발행 먼저면 거짓 이벤트라는 이중 쓰기 딜레마가 생기고, 프로세스가 죽으면 catch도 안 돌기에 코드가 아니라 구조로 풀어야 하며, XA/2PC는 가용성이 곱으로 떨어지고 Kafka·RabbitMQ 모두 참여 자격이 없어 배제된다 — 스프링의 `@TransactionalEventListener(AFTER_COMMIT)`은 거짓 이벤트만 막을 뿐 메모리 이벤트의 유실(at-most-once)을 못 막으므로, "보낼 이벤트"를 비즈니스 변경과 같은 트랜잭션으로 같은 DB의 outbox 테이블에 INSERT해 이중 쓰기를 단일 쓰기로 바꾸고, 폴링 릴레이가 `FOR UPDATE SKIP LOCKED`로 행을 나눠 집어 RabbitMQ publisher confirm(또는 Kafka ack) 콜백에서 발행 완료를 표시하며, 테이블 비대화는 파티션 드롭으로, 순서는 릴레이 분할로, 남는 at-least-once 중복은 멱등 소비자로 마감하는 것이 완성형이다.
