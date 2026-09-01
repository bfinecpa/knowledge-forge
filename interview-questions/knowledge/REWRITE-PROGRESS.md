# knowledge 문서 서술 기준 재작성 — 진행 현황

기준: "시니어의 깊이를 주니어에게 설명한다" (`README.md`의 서술 기준 섹션).
모범 사례: `10-payment-consistency/10-distributed-saga-compensation-idempotency.md`.

10장(18건)은 별도 세션에서 완료했다(커밋 `5e732e6`). 이 문서는 01~09장 243건의 진행을 기록한다.

## 디렉토리별 현황

| 디렉토리 | 건수 | 완료 | 상태 |
|---|---|---|---|
| 05-redis-caching | 27 | 27 | 완료 |
| 06-kafka-messaging | 24 | 0 | 다음 차례 |
| 07-traffic-performance | 23 | 0 | 대기 |
| 08-network-http | 22 | 0 | 대기 |
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
