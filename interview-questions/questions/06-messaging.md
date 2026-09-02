# 6. 메시징 — 메시지 큐 · RabbitMQ · Kafka

> 3부 구성. **1부**는 브로커를 가리지 않는 메시지 큐·이벤트 기반 아키텍처 공통 개념, **2부**는 RabbitMQ, **3부**는 Kafka다. 각 부 안에서 기본 ⭐ → 중급 ⭐⭐ → 고난이도 ⭐⭐⭐ → +α 순으로 진행한다.

---

## 1부. 메시지 큐 공통

### 기본 ⭐

- 메시지 큐를 도입하는 이유는? 동기 호출 대비 장단점은?
- RabbitMQ와 Kafka의 차이는? 어떤 요구사항일 때 무엇을 고르나요?

### 중급 ⭐⭐

- at-least-once, at-most-once, exactly-once 전달 의미론을 설명해주세요. 실무에서 exactly-once는 현실적인가요?
- 멱등 컨슈머(idempotent consumer)를 어떻게 구현하나요?
- 이벤트 페이로드에 전체 상태를 담을까(fat event), ID만 담을까(thin event)? 이 결정이 1년 뒤 시스템의 무엇을 좌우하나요?

### 고난이도 ⭐⭐⭐

- 이벤트 스키마가 변경될 때(스키마 진화) 호환성을 어떻게 관리하나요? (Schema Registry, forward/backward compatibility)
- 이벤트 기반 아키텍처에서 최종 일관성(eventual consistency)으로 인한 UX 문제를 어떻게 다루나요?
- Saga 패턴(choreography vs orchestration)을 비교하고, 보상 트랜잭션 설계 시 주의점을 설명해주세요.

### 알면 좋은 +α

- 수 MB 이상의 큰 페이로드를 이벤트로 전달해야 한다면 어떻게 설계하나요? (claim check)

---

## 2부. RabbitMQ

### 기본 ⭐

- RabbitMQ의 기본 구성요소(Exchange, Queue, Binding, Routing Key)와 메시지가 흐르는 경로를 설명해주세요. 어느 큐에도 라우팅되지 못한 메시지는 어떻게 되나요?
- Exchange 타입(direct/fanout/topic/headers)의 차이와 선택 기준은? 하나의 이벤트를 여러 서비스가 각자 받아야 한다면 어떻게 설계하나요?
- RabbitMQ의 ack/nack과 prefetch(QoS)는 각각 무엇을 결정하나요? auto-ack의 위험은?

### 중급 ⭐⭐

- RabbitMQ에서 메시지를 잃지 않으려면 무엇을 켜야 하나요? (durable queue, persistent message, publisher confirms) 각 설정이 막아주는 유실 지점은 어디인가요?
- RabbitMQ에서 재시도와 DLQ를 어떻게 설계하나요? (Dead Letter Exchange, TTL 기반 지연 재시도, requeue 무한 루프 함정)
- RabbitMQ에서 메시지 순서는 어디까지 보장되나요? 무엇이 순서를 깨뜨리나요?
- RabbitMQ 컨슈머의 처리량을 높이는 방법은? (prefetch 튜닝, 리스너 동시성, connection/channel 모델) 이때 순서 보장과 ack 처리는 어떻게 달라지나요?

### 고난이도 ⭐⭐⭐

- Classic queue와 Quorum queue의 차이는? 미러링 큐가 왜 quorum queue로 대체되었나요? 네트워크 파티션(split-brain) 상황에서 각각 어떻게 동작하나요?
- RabbitMQ 큐에 메시지가 계속 쌓일 때(적체) 원인 진단과 해소를 단계적으로 설명해주세요. (flow control, 메모리/디스크 alarm, lazy queue)
- RabbitMQ에서 지연 메시지·스케줄링을 어떻게 구현하나요? (TTL + DLX vs delayed message exchange 플러그인)
- RabbitMQ를 쓰는 서비스에서 "DB 커밋은 됐는데 발행이 실패"하는 문제를 어떻게 해결하나요? (CDC 없이 Outbox + 폴링 퍼블리셔, publisher confirms와의 결합)

---

## 3부. Kafka

### 기본 ⭐

- Kafka의 기본 구성요소(Broker, Topic, Partition, Consumer Group)를 설명해주세요.
- 파티션과 컨슈머 수의 관계는? 컨슈머를 파티션보다 많이 띄우면 어떻게 되나요?
- 오프셋 커밋이란? 자동 커밋의 위험은? (RabbitMQ의 ack와 비교해서 설명해주세요)

### 중급 ⭐⭐

- 메시지 순서 보장은 어떤 단위로 되나요? 특정 사용자의 이벤트 순서를 보장하려면? (RabbitMQ의 큐 단위 순서와 비교해서 설명해주세요)
- 컨슈머가 메시지 처리에 실패하면 어떻게 하나요? 재시도/DLQ 설계를 설명해주세요.
- 컨슈머 리밸런싱은 언제 발생하고, 처리 중이던 메시지는 어떻게 되나요?
- 프로듀서의 `acks` 설정(0/1/all)과 내구성의 관계는?
- Kafka로 이벤트를 발행하는 서비스에서 "DB 커밋은 됐는데 발행이 실패"하는 문제를 어떻게 해결하나요? (Transactional Outbox + CDC)
- 새 토픽을 만들 때 파티션 수는 어떤 기준으로 산정하나요? 처음부터 크게 잡는 것의 비용은?
- 파티션을 늘리지 않고 컨슈머 한 대의 처리량을 높이는 방법은? (배치 폴링, 컨슈머 내부 병렬화) 이때 오프셋 커밋은 어떻게 다뤄야 하나요?

### 고난이도 ⭐⭐⭐

- 컨슈머 랙(lag)이 계속 증가하고 있습니다. 원인 진단과 해소 방법을 단계적으로 설명해주세요. (RabbitMQ 큐 적체와 증상이 어떻게 다른가요?)
- 파티션 수를 늘리면 어떤 부작용이 있나요? 키 기반 순서는 어떻게 되나요?
- 대량 이벤트 재처리(replay)가 필요한 상황에서 실시간 처리와 격리하는 방법은?
- 지금 RabbitMQ로 운영 중인 시스템을 Kafka로 옮겨야 하는 시점은 언제인가요? 판단 기준과 마이그레이션 전략, 그리고 RabbitMQ Streams라는 중간 선택지는?

### 알면 좋은 +α

- `max.poll.interval.ms`와 `session.timeout.ms`의 차이는? 리밸런싱이 반복될 때 무엇부터 확인하나요?
- Log compaction(compacted topic)이란? 어떤 용도에 적합한가요?
