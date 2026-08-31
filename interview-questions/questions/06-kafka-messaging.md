# 6. Kafka / 메시징 / 이벤트 기반 아키텍처

## 기본 ⭐

- 메시지 큐를 도입하는 이유는? 동기 호출 대비 장단점은?
- Kafka의 기본 구성요소(Broker, Topic, Partition, Consumer Group)를 설명해주세요.
- 파티션과 컨슈머 수의 관계는? 컨슈머를 파티션보다 많이 띄우면 어떻게 되나요?
- Kafka와 RabbitMQ(전통적 MQ)의 차이는?
- 오프셋 커밋이란? 자동 커밋의 위험은?

## 중급 ⭐⭐

- 메시지 순서 보장은 어떤 단위로 되나요? 특정 사용자의 이벤트 순서를 보장하려면?
- at-least-once, at-most-once, exactly-once 전달 의미론을 설명해주세요. 실무에서 exactly-once는 현실적인가요?
- 컨슈머가 메시지 처리에 실패하면 어떻게 하나요? 재시도/DLQ(Dead Letter Queue) 설계를 설명해주세요.
- 컨슈머 리밸런싱은 언제 발생하고, 처리 중이던 메시지는 어떻게 되나요?
- 프로듀서의 `acks` 설정(0/1/all)과 내구성의 관계는?
- 멱등 컨슈머(idempotent consumer)를 어떻게 구현하나요?
- Kafka로 이벤트를 발행하는 서비스에서 "DB 커밋은 됐는데 발행이 실패"하는 문제를 어떻게 해결하나요? (Transactional Outbox + CDC)
- 새 토픽을 만들 때 파티션 수는 어떤 기준으로 산정하나요? 처음부터 크게 잡는 것의 비용은?
- 파티션을 늘리지 않고 컨슈머 한 대의 처리량을 높이는 방법은? (배치 폴링, 컨슈머 내부 병렬화) 이때 오프셋 커밋은 어떻게 다뤄야 하나요?
- 이벤트 페이로드에 전체 상태를 담을까(fat event), ID만 담을까(thin event)? 이 결정이 1년 뒤 시스템의 무엇을 좌우하나요?

## 고난이도 ⭐⭐⭐

- 컨슈머 랙(lag)이 계속 증가하고 있습니다. 원인 진단과 해소 방법을 단계적으로 설명해주세요.
- 파티션 수를 늘리면 어떤 부작용이 있나요? 키 기반 순서는 어떻게 되나요?
- 이벤트 스키마가 변경될 때(스키마 진화) 호환성을 어떻게 관리하나요? (Schema Registry, forward/backward compatibility)
- 대량 이벤트 재처리(replay)가 필요한 상황에서 실시간 처리와 격리하는 방법은?
- 이벤트 기반 아키텍처에서 최종 일관성(eventual consistency)으로 인한 UX 문제를 어떻게 다루나요?
- Saga 패턴(choreography vs orchestration)을 비교하고, 보상 트랜잭션 설계 시 주의점을 설명해주세요.

## 알면 좋은 +α

- `max.poll.interval.ms`와 `session.timeout.ms`의 차이는? 리밸런싱이 반복될 때 무엇부터 확인하나요?
- Log compaction(compacted topic)이란? 어떤 용도에 적합한가요?
- 수 MB 이상의 큰 페이로드를 이벤트로 전달해야 한다면 어떻게 설계하나요? (claim check)
