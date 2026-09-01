# knowledge 문서 서술 기준 재작성 — 진행 현황

기준: "시니어의 깊이를 주니어에게 설명한다" (`README.md`의 서술 기준 섹션).
모범 사례: `10-payment-consistency/10-distributed-saga-compensation-idempotency.md`.

10장(18건)은 별도 세션에서 완료했다(커밋 `5e732e6`). 이 문서는 01~09장 243건의 진행을 기록한다.

## 디렉토리별 현황

| 디렉토리 | 건수 | 완료 | 상태 |
|---|---|---|---|
| 05-redis-caching | 27 | 27 | 완료 |
| 06-kafka-messaging | 24 | 24 | 완료 |
| 07-traffic-performance | 23 | 23 | 완료 |
| 08-network-http | 22 | 0 | 다음 차례 |
| 09-rest-api | 18 | 0 | 대기 |
| 01-java-kotlin | 32 | 0 | 대기 |
| 02-spring | 35 | 0 | 대기 |
| 03-jpa-orm | 27 | 0 | 대기 (이미 깊이 있음 — 조정 위주) |
| 04-rdb-sql | 35 | 0 | 대기 (PostgreSQL 기준 유지) |

## 작업 규약 (세션이 끊겨도 동일하게 이어간다)

- 본문 구조는 `## 0.` ~ `## 4.` 다섯 섹션으로 고정한다. 세부는 `###`로 나눈다. (기존 05장 문서 다수가 `## 5.`, `## 6.`까지 뻗어 있어 이번에 정리한다.)
- 질문 원문과 출제 의도 문구는 손대지 않는다.
- 하드랩(72자 고정 줄바꿈)을 푼다. 한 문단은 한 줄로 이어 쓰고 문단을 짧게 끊는다.
- 이모지 금지. 분량 목표 없음.
- DB 예시는 PostgreSQL 기준(커밋 `ae54d88`의 전환을 되돌리지 않는다).
- 서브에이전트는 최대 5개까지 병렬로 돌린다. 한 에이전트에 2~3건씩 맡긴다.

## 05-redis-caching (27/27) — 완료

| 파일 | 상태 |
|---|---|
| 01-redis-single-thread-performance.md | 완료 |
| 02-redis-data-structures-use-cases.md | 완료 |
| 03-cache-suitability-criteria.md | 완료 |
| 04-ttl-expiration-eviction-policies.md | 완료 |
| 05-look-aside-cache-aside-pattern.md | 완료 |
| 06-cache-stampede.md | 완료 |
| 07-cache-db-consistency-update-vs-delete.md | 완료 |
| 08-redis-persistence-rdb-vs-aof.md | 완료 |
| 09-sentinel-vs-cluster-hash-slot.md | 완료 |
| 10-sorted-set-realtime-ranking.md | 완료 |
| 11-redis-as-session-store.md | 완료 |
| 12-keys-vs-scan.md | 완료 |
| 13-hot-key-detection-and-mitigation.md | 완료 |
| 14-cache-key-design-and-versioning.md | 완료 |
| 15-ttl-cache-pr-review-at-10x-traffic.md | 완료 |
| 16-distributed-lock-pitfalls-redlock.md | 완료 |
| 17-flash-sale-coupon-issuance-design.md | 완료 |
| 18-redis-oom-and-defense.md | 완료 |
| 19-cache-failure-db-protection.md | 완료 |
| 20-two-tier-cache-caffeine-redis.md | 완료 |
| 21-loop-get-vs-mget-vs-pipeline.md | 완료 |
| 22-lua-script-atomicity.md | 완료 |
| 23-big-key-risk-and-unlink.md | 완료 |
| 24-redis-streams-vs-pubsub.md | 완료 |
| 25-hyperloglog-bitmap-cheap-counting.md | 완료 |
| 26-cold-cache-and-cache-warming.md | 완료 |
| 27-multi-exec-watch-vs-lua.md | 완료 |

## 06-kafka-messaging (24/24 — 완료)

| 파일 | 상태 |
|---|---|
| 01-why-message-queue-sync-vs-async.md | 완료 |
| 02-kafka-core-components.md | 완료 |
| 03-partition-vs-consumer-count.md | 완료 |
| 04-kafka-vs-rabbitmq.md | 완료 |
| 05-offset-commit-and-auto-commit-risk.md | 완료 |
| 06-message-ordering-partition-key.md | 완료 |
| 07-delivery-semantics-and-exactly-once-reality.md | 완료 |
| 08-consumer-retry-dlq-design.md | 완료 |
| 09-consumer-rebalancing-and-in-flight-messages.md | 완료 |
| 10-producer-acks-durability.md | 완료 |
| 11-idempotent-consumer-implementation.md | 완료 |
| 12-transactional-outbox-cdc-kafka.md | 완료 |
| 13-partition-count-sizing.md | 완료 |
| 14-single-consumer-throughput-and-offset-commit.md | 완료 |
| 15-fat-vs-thin-event-payload.md | 완료 |
| 16-consumer-lag-diagnosis-and-resolution.md | 완료 |
| 17-partition-increase-side-effects.md | 완료 |
| 18-schema-evolution-compatibility.md | 완료 |
| 19-bulk-replay-isolation.md | 완료 |
| 20-eventual-consistency-ux.md | 완료 |
| 21-saga-choreography-orchestration-compensation.md | 완료 |
| 22-max-poll-interval-vs-session-timeout.md | 완료 |
| 23-log-compaction-compacted-topic.md | 완료 |
| 24-large-payload-claim-check.md | 완료 |

메모: 12번은 MySQL binlog 중심 서술을 PostgreSQL(WAL·논리적 디코딩·복제 슬롯) 기준으로 전환한다.
22번은 꼬리질문이 `## 3.`에 있던 것을 본문 3섹션 + 꼬리질문 `## 4.`로 재구성 완료.


## 07-traffic-performance (23/23) — 완료

1차 배치(15건, 5에이전트 병렬) / 2차 배치(8건, 4에이전트 병렬)로 진행한다.

| 파일 | 배치 | 상태 |
|---|---|---|
| 01-throughput-latency-p99.md | 1 | 완료 |
| 02-scale-out-vs-scale-up.md | 1 | 완료 |
| 17-littles-law-resource-limits.md | 1 | 완료 |
| 03-load-balancer-role-and-algorithms.md | 1 | 완료 |
| 04-stateless-server-design-and-session.md | 1 | 완료 |
| 05-cdn-webtoon-image-serving.md | 1 | 완료 |
| 06-api-latency-bottleneck-investigation.md | 1 | 완료 |
| 07-load-test-design-tps-scenario-tools.md | 1 | 완료 |
| 23-load-test-production-gap-causes.md | 1 | 완료 |
| 08-rate-limiting-algorithms-distributed.md | 1 | 완료 |
| 16-backpressure-and-application-points.md | 1 | 완료 |
| 21-load-shedding-priority-and-location.md | 1 | 완료 |
| 09-circuit-breaker-state-transition-tuning.md | 1 | 완료 |
| 10-timeout-layers-and-budget.md | 1 | 완료 |
| 11-retry-storm-backoff-jitter.md | 1 | 완료 |
| 18-cascading-failure-mechanism-and-bulkhead.md | 2 | 완료 |
| 15-graceful-degradation-design.md | 2 | 완료 |
| 13-scheduled-traffic-spike-preparation.md | 2 | 완료 |
| 22-autoscaling-metrics-beyond-cpu.md | 2 | 완료 |
| 14-waiting-queue-system-design.md | 2 | 완료 |
| 12-mass-push-notification-design.md | 2 | 완료 |
| 19-realtime-count-aggregation-pipeline.md | 2 | 완료 |
| 20-multi-region-locality-latency-consistency.md | 2 | 완료 |

메모: 01·02는 하드랩이 이미 풀려 있었으나 불릿·표로 압축돼 있어 설명 문단 보강이 주 작업이다.
01·02·06·07·17·23은 섹션이 `## 5.`~`## 8.`까지 뻗어 있어 다섯 섹션으로 재편했다.
20·23은 코드 블록이 0개였다.


### 중단 이력 (2026-09-01)

1차 배치 중 5개 에이전트가 org 스펜드 리밋(HTTP 429)으로 동시 종료됐다. 그 시점에 06과 18은 이미 파일로 완성돼 있었고(각 61KB·74KB, 검증 통과), 나머지는 원본 그대로였다. 리밋 해제 후 재투입했고, 12·14·15는 메인 세션에서 직접 작성했다.
리밋 해제 후 전건 완료했다.


### 이번 장에서 정정한 원문 사실 오류 (6건)

전부 직접 검산해 확인했다.

| 문서 | 원문 | 정정 |
|---|---|---|
| 01 | 99건 10ms + 1건 4,000ms → "p99 = 4,000ms" | nearest-rank 순위는 `ceil(0.99 × 100) = 99`번째이므로 p99 = 10ms. 4초는 p100에만 잡힌다. 원래 숫자를 사례 1로 살려 "1건뿐이면 p99에 안 잡힌다"는 교육 포인트로 전환하고, p99가 실제로 4,000ms가 되는 사례 2(98건 + 2건)를 나란히 붙였다 |
| 17 | 톰캣 W = 100ms인데 같은 요청의 외부 API W = 200ms | 부분이 전체보다 큼 — 물리적으로 불가능. 전체 응답시간 300ms로 재구성해 구간 합이 맞게 고쳤다 |
| 17 | "평균 기반 계산보다 실제 필요 L이 커진다" | `L = λ × 산술평균 W`는 항등식이므로 평균을 쓰면 정확하다. 실제 함정은 사람들이 평균 대신 **중앙값**을 대입하는 것 |
| 11 | `## 1.`은 "3회 재시도 = 4배", 다층 절은 "계층당 3회 = 27배" — 같은 "3회"를 재시도 횟수와 총 시도 횟수 두 뜻으로 씀 | 두 용어를 정의하고 27(계층당 총 시도 3회)과 64(계층당 재시도 3회)를 표에 병기 |
| 22 | "I/O bound면 CPU가 낮다"를 무조건 명제로 서술 | 8코어·200스레드 파드에서 요청당 CPU 50ms면 만석 시 CPU 수요가 33.3코어이므로 **CPU가 먼저 마른다**. 경계는 `8 × 0.3 ÷ 200 = 12ms`. 명제를 판정식으로 바꿔 세 경우를 모두 설명하게 했다 |
| 19 | 예시 코드가 `increment("view:webtoon:"+id)`로 쓰고 `getAndSet("view:delta:"+id)`로 읽음 | 키 불일치로 delta가 항상 null — 배치 UPDATE가 영원히 실행되지 않는 코드였다. 키 체계를 통일했다 |

### 분량 메모

07장 평균이 11.3KB → 57KB가 됐다. 다만 20번(122KB)·19번(85KB)·23번(78KB)·18번(74KB)은 모범 사례 문서(37KB)와 06장 최대치(52KB)를 크게 넘는다. 규칙상 분량 목표는 없으므로 위반은 아니지만, 08장 이후에서 같은 밀도를 유지할지 아니면 20번급을 상한으로 볼지는 판단이 필요하다.

## 기계 검증

`/private/tmp/.../scratchpad/verify.py` 로 구조 6요소·섹션 번호 연속성·이모지·하드랩 해제·꼬리질문 표기를 확인한다.
06-kafka-messaging 01~24는 전부 통과한다(기준선). 25~36(RabbitMQ 12건, 커밋 `3ff7425`)은 `## 5.`~`## 7.`까지 쓰는 다른 관례라 이 검증에서는 실패로 나온다 — 별도 판단 사항.
