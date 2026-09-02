# knowledge 문서 서술 기준 재작성 — 진행 현황

기준: "시니어의 깊이를 주니어에게 설명한다" (`README.md`의 서술 기준 섹션).
모범 사례: `10-payment-consistency/10-distributed-saga-compensation-idempotency.md`.

10장(18건)은 별도 세션에서 완료했다(커밋 `5e732e6`). 이 문서는 01~09장 243건의 진행을 기록한다.

## 디렉토리별 현황

| 디렉토리 | 건수 | 완료 | 상태 |
|---|---|---|---|
| 05-redis-caching | 27 | 27 | 완료 |
| 06-messaging | 36 | 36 | 완료 |
| 07-traffic-performance | 23 | 23 | 완료 |
| 08-network-http | 22 | 22 | 완료 |
| 09-rest-api | 18 | 18 | 완료 |
| 01-java-kotlin | 32 | 32 | 완료 |
| 02-spring | 35 | 35 | 완료 |
| 03-jpa-orm | 27 | 27 | 완료 |
| 04-rdb-sql | 35 | 35 | 완료. `8deef26`의 삭제는 `f1b2a4f`로 revert되어 35건 복구됨 |

## 작업 규약 (세션이 끊겨도 동일하게 이어간다)

- 본문 구조는 `## 0.` ~ `## 4.` 다섯 섹션으로 고정한다. 세부는 `###`로 나눈다. (기존 05장 문서 다수가 `## 5.`, `## 6.`까지 뻗어 있어 이번에 정리한다.)
- 질문 원문과 출제 의도 문구는 손대지 않는다.
- 하드랩(72자 고정 줄바꿈)을 푼다. 한 문단은 한 줄로 이어 쓰고 문단을 짧게 끊는다.
- 이모지 금지. 분량 목표 없음.
- DB 예시는 PostgreSQL 기준(커밋 `ae54d88`의 전환을 되돌리지 않는다).
- 서브에이전트는 항상 5개가 돌아가게 유지한다. 한 에이전트에 2~3건씩 맡기고, 하나가 끝나면 곧바로 다음 하나를 투입한다(다섯이 모두 끝나기를 기다리지 않는다). 동시 실행 수만 5를 넘지 않으면 된다.

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

## 06-messaging (36/36 — 완료)

> 2026-09-02 질문지 재편(MQ 공통 → RabbitMQ → Kafka)에 맞춰 파일 번호를 01~36으로 재부여했다. 아래 표는 **새 번호** 기준이다.
>
> 같은 날 RabbitMQ 12건(10~20·34)의 구조를 정리해 36건 전부 `0 → 1 → 2 → 3 → 4 → 한 줄 요약` 규약에 맞췄다. 본문 섹션이 4~7개이던 것을 셋으로 합치면서, 헤딩만 강등해 이어붙이지 않고 새 부모 섹션의 도입 문단으로 "왜 이 둘이 한 섹션인가"를 밝히는 방식을 썼다. 02번의 번호 없는 h2(RabbitMQ 문서 지도)는 `### 3-3.`으로 강등했다.

| 파일 | 상태 |
|---|---|
| 01-why-message-queue-sync-vs-async.md | 완료 |
| 02-kafka-vs-rabbitmq.md | 완료 |
| 03-delivery-semantics-and-exactly-once-reality.md | 완료 |
| 04-idempotent-consumer-implementation.md | 완료 |
| 05-fat-vs-thin-event-payload.md | 완료 |
| 06-schema-evolution-compatibility.md | 완료 |
| 07-eventual-consistency-ux.md | 완료 |
| 08-saga-choreography-orchestration-compensation.md | 완료 |
| 09-large-payload-claim-check.md | 완료 |
| 10-rabbitmq-core-components.md | 완료 |
| 11-rabbitmq-exchange-types-routing.md | 완료 |
| 12-rabbitmq-ack-nack-prefetch.md | 완료 |
| 13-rabbitmq-durability-publisher-confirms.md | 완료 |
| 14-rabbitmq-retry-dlx-dlq.md | 완료 |
| 15-rabbitmq-message-ordering.md | 완료 |
| 16-rabbitmq-consumer-throughput-prefetch.md | 완료 |
| 17-classic-vs-quorum-queue.md | 완료 |
| 18-rabbitmq-queue-backlog-diagnosis.md | 완료 |
| 19-rabbitmq-delayed-message-scheduling.md | 완료 |
| 20-rabbitmq-outbox-polling-publisher.md | 완료 |
| 21-kafka-core-components.md | 완료 |
| 22-partition-vs-consumer-count.md | 완료 |
| 23-offset-commit-and-auto-commit-risk.md | 완료 |
| 24-message-ordering-partition-key.md | 완료 |
| 25-consumer-retry-dlq-design.md | 완료 |
| 26-consumer-rebalancing-and-in-flight-messages.md | 완료 |
| 27-producer-acks-durability.md | 완료 |
| 28-transactional-outbox-cdc-kafka.md | 완료 |
| 29-partition-count-sizing.md | 완료 |
| 30-single-consumer-throughput-and-offset-commit.md | 완료 |
| 31-consumer-lag-diagnosis-and-resolution.md | 완료 |
| 32-partition-increase-side-effects.md | 완료 |
| 33-bulk-replay-isolation.md | 완료 |
| 34-rabbitmq-to-kafka-migration.md | 완료 |
| 35-max-poll-interval-vs-session-timeout.md | 완료 |
| 36-log-compaction-compacted-topic.md | 완료 |

메모: 28번은 MySQL binlog 중심 서술을 PostgreSQL(WAL·논리적 디코딩·복제 슬롯) 기준으로 전환한다.
35번은 꼬리질문이 `## 3.`에 있던 것을 본문 3섹션 + 꼬리질문 `## 4.`로 재구성 완료.


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
06-messaging은 36건 전부 통과한다. RabbitMQ 12건(새 번호 10~20·34)이 `## 5.`~`## 7.`까지 쓰던 것을 2026-09-02에 정리해 해소했다.

## 08-network-http (22/22) — 완료

1차 배치(11건, 5에이전트 병렬) / 2차 배치(11건, 5에이전트 병렬)로 진행했다.

| 파일 | 배치 | 상태 |
|---|---|---|
| 01-url-to-page-dns-tcp-tls-http.md | 1 | 완료 |
| 03-tcp-vs-udp.md | 1 | 완료 |
| 09-http1-http2-http3-hol-blocking.md | 1 | 완료 |
| 02-tcp-3way-4way-handshake.md | 1 | 완료 |
| 10-keepalive-connection-pool-time-wait.md | 1 | 완료 |
| 04-http-method-idempotency-and-safety.md | 1 | 완료 |
| 05-http-status-codes-usage-criteria.md | 1 | 완료 |
| 06-tls-handshake-symmetric-asymmetric-keys.md | 1 | 완료 |
| 17-tls-termination-lb-vs-app.md | 1 | 완료 |
| 07-cookie-session-token-auth.md | 1 | 완료 |
| 08-cors-and-preflight.md | 1 | 완료 |
| 11-502-vs-504-troubleshooting.md | 2 | 완료 |
| 13-nginx-tomcat-timeout-buffer-mismatch.md | 2 | 완료 |
| 12-nginx-roles-and-event-driven-architecture.md | 2 | 완료 |
| 16-l4-vs-l7-load-balancer.md | 2 | 완료 |
| 14-websocket-sse-polling-selection.md | 2 | 완료 |
| 15-large-file-upload-download-design.md | 2 | 완료 |
| 18-intermittent-timeout-tcpdump-mtu-retransmission.md | 2 | 완료 |
| 19-dns-ttl-failover-traffic-switching.md | 2 | 완료 |
| 20-http-caching-headers-and-304.md | 2 | 완료 |
| 21-response-compression-tradeoffs.md | 2 | 완료 |
| 22-real-client-ip-behind-proxy-xff-trust.md | 2 | 완료 |

배치 편성은 **주제가 겹치는 문서를 한 에이전트에 묶는** 원칙으로 짰다. TIME_WAIT을 양쪽에서 다루는 02·10,
TLS를 원리와 배치로 나눈 06·17, 같은 간헐적 502를 증상과 원인으로 나눈 11·13이 그 예다.
한 에이전트가 두 문서를 함께 쓰면 역할 분담(원리 쪽 / 운영 쪽)과 상호 참조가 어긋나지 않는다.

2차 배치 에이전트에는 "01~10·17은 이미 재작성이 끝났으니 읽고 용어·사실을 맞추라"는 지시를 넣었다.

메모: 재편이 필요했던 문서는 8건이다 — 05(`## 0~7`), 08·13·17·18·19·20·21(`## 0~5`).
16번은 22건 중 가장 짧아(10.2KB, 코드 블록 1개) 깊이 보강이 주 작업이다.
20·23번이 없던 07장과 달리 08장은 전 문서에 코드 블록이 있으나 03·09·14·16·21은 1개뿐이라 보강 대상으로 지목했다.

### 이번 장에서 정정한 원문 사실 오류 (1차 배치)

전부 직접 검산해 확인했다.

| 문서 | 원문 | 정정 |
|---|---|---|
| 04 | 멱등성 키의 "After" 코드가 `findResponse(key)` 조회 → 없으면 결제 → 저장 구조 | check-then-act 경합이 그대로 남은 깨진 구현이다. 같은 문서의 꼬리질문이 경고하는 바로 그 버그를 모범 코드가 저지르고 있었다. Before로 강등하고 유니크 제약 + `ON CONFLICT DO NOTHING` 선점을 After로 새로 썼다 |
| 04 | "connection timeout은 요청이 서버에 도달하기 전이므로 POST라도 안전" | 요청 전송 도중 끊긴 경우를 포섭하지 못하는 과잉 단정. 안전 조건을 "요청 바이트를 한 바이트도 쓰지 않았음이 확실할 때"로 정밀화 |
| 04 | 생성 API 예시가 `ResponseEntity.ok`(200) | 05번의 "생성은 201 + Location" 기준과 충돌. 201로 정정 |
| 10 | "초당 500개면 60초 후 3만 개" 예시만 있고 고갈 임계값 없음 | 임계선을 도출해 넣었다. `(60999 − 32768 + 1) ÷ 60 = 470.5` → **초당 약 470개**가 한계선이고, R=500이면 고갈은 60초가 아니라 **약 56.5초**다 |
| 09 | Nginx `listen 443 ssl http2;` | 1.25 계열부터 `http2 on;` 지시자 방식. 두 방식과 버전 경계를 함께 명시 |
| 09 | 서버 푸시 "브라우저 지원도 제거되는 추세다" | 이미 제거된 상태. "주요 브라우저가 지원을 제거했다"로 정정 |
| 01 | "TLS 협상 — 왕복 1~2회" | 조건 없이 뭉뚱그려져 있던 것을 TLS 1.2 = 2 RTT / 1.3 = 1 RTT / 세션 재개 = 0~1 RTT로 분리 |
| 06 | "비대칭 연산은 대칭 대비 수백 배 이상 무겁다" | 근거가 불확실하고 연산 단위가 다른 비교(연산당 vs 바이트당)라 "비용의 자릿수가 다르다"로 약화 |
| 17 | "LB 종료 시 두 가지 정보가 사라진다" | 실제로는 셋(클라이언트 IP·원래 스킴·클라이언트 인증서). 각각을 별도 절로 분리 |
| 17 | 표의 "앱 종료 시 L7 기능 불가" | SNI 기반 라우팅은 L4에서도 가능하므로 "불가(SNI 라우팅만)"로 정정 |
| 07 | JWT 다이어그램의 payload와 셸 디코딩 예시의 payload가 서로 다름 | 메인 세션에서 직접 디코딩해 확인하고 일치시켰다(`iat`/`exp` 포함 80자 payload, 패딩 불필요) |

직접 검산한 수치: 임시 포트 28,232개 / 임계 470.5 conn·s⁻¹ / R=500 고갈 56.5초 / 포트 범위 확대 시 921.6 /
slow start 누적(14.6 → 43.8 → 102.2 → 219.0KB) / SYN 재시도 총 127초 / `curl -w` 구간 합 0.845초 / RTT 130ms × 3 = 390ms.

### 검증기 보완

`verify.py`를 두 곳 고쳤다.

- 다이어그램 글리프 `✓`·`✗`를 허용 목록에 추가했다. 07장 20번이 이미 같은 용법으로 쓰고 있어 관례에 맞춘 것이다.
- 질문·출제 의도 비교에서 공백을 전부 제거한 뒤 대조하도록 바꿨다. 하드랩을 풀면 줄바꿈 자리의 공백이 사라지는데,
  기존 정규화(`\s+` → 한 칸)로는 이것이 문구 변경으로 오탐됐다(08번이 그 사례였다).

### 이번 장에서 정정한 원문 사실 오류 (2차 배치)

| 문서 | 원문 | 정정 |
|---|---|---|
| 13 | "`proxy_next_upstream`에 타임아웃까지 넣으면 POST가 다른 서버에서 한 번 더 실행될 수 있다" | 기본값이 이미 `error timeout`이라 타임아웃은 처음부터 포함돼 있고, 최근 Nginx는 요청을 보낸 뒤라면 비멱등 메서드를 기본적으로 넘기지 않는다(`non_idempotent`를 켜야 넘어간다). 위험의 위치를 그 옵션을 켜는 것과 부작용 있는 GET 쪽으로 바로잡음 |
| 13 | 예제 YAML의 `max-file-size: 20MB` / `max-request-size: 20MB` | multipart 경계·파트 헤더 오버헤드 때문에 정확히 20MB 파일 하나가 `max-request-size`에 걸린다. 20MB/25MB로 고치고 이유를 본문에 설명 — "한도를 10MB로 맞췄는데 10MB 파일이 안 올라간다"의 정답 |
| 13 | `proxy_read_timeout`을 "응답을 기다리는 상한"으로 정의 | 연속된 두 읽기 **사이 간격**의 상한이다. 스트리밍 응답이 왜 안 걸리는지가 여기서 설명된다 |
| 11 | 504를 사실상 "백엔드가 느리다"로만 서술 | `proxy_connect_timeout` 만료도 504이며 이는 느린 것이 아니라 **닿지 못한 것**이다. 로그의 `while connecting` / `while reading response header`로 구분 |
| 12 | "전통적인 웹서버(Apache prefork, Tomcat의 블로킹 커넥터)" | Tomcat BIO 커넥터는 8.5에서 제거됐고 NIO가 기본이다. "커넥션 관리는 NIO(Acceptor/Poller), 요청 처리는 스레드 풀"로 정확히 갈랐다 |
| 16 | "L4 헬스체크가 확인하는 것은 프로세스가 포트를 리스닝하고 있는가까지" | 커널이 handshake를 완료해 accept 큐에 넣으므로 앱이 `accept()`를 호출하지 않아도 통과한다. 실제로 검증되는 것은 "커널의 리스닝 소켓이 존재하는가"뿐이라 완전 데드락도 통과한다 |
| 16 | "가중치 분배(카나리 5%)"를 L7 전용으로 분류 | 가중치 분배 자체는 L4에도 있다. L4의 5%는 **커넥션의 5%**라 keep-alive 아래에서 요청 기준 비율과 어긋난다는 것이 정확한 명제 |
| 16 | "L4는 클라이언트↔서버 사실상 직결" | SNAT 구성에서는 L4도 클라이언트 IP를 잃고 PROXY protocol이 필요하다는 예외를 달았다 |
| 14 | "서블릿 스레드-퍼-리퀘스트로 장수 커넥션을 다루면 커넥션 수만큼 스레드가 잠긴다"를 무조건 명제로 서술 | 블로킹 루프 구현에서만 참이다. `SseEmitter`·비동기 서블릿을 쓰면 요청 스레드는 즉시 반환되고, 실제 상한은 `maxConnections`와 파일 디스크립터가 된다 |
| 15 | `getInputStream()` 스트리밍을 "요청 스트림에서 저장소로 흘려보낸다"로 서술 | 컨트롤러 실행 시점에 요청 본문은 이미 전부 수신돼 임시 파일로 스풀링을 마친 상태다. 여기서 임시 디렉토리 고갈 사고가 나온다 |
| 18 | "TCP는 RTO만큼 기다렸다 다시 보낸다" | 빠른 재전송(중복 ACK 3회, 대략 1 RTT)이 누락돼 p99 꼬리의 원인을 오도한다. 두 경로를 분리해 03번과 용어를 맞췄다 |
| 19 | `-Dnetworkaddress.cache.ttl=10` | 이 값은 시스템 프로퍼티가 아니라 **보안 프로퍼티**라 `-D`로 주면 신뢰할 수 없게 동작한다. 01번이 이미 `Security.setProperty(...)`로 올바르게 다루므로 참조로 대체하고 틀린 코드를 제거 |
| 22 | 다이어그램 주석 "(위조값 10.0.0.1은 도달 전에 무시됨)" | 위조값은 앱까지 **도달한다.** 알고리즘이 체인의 왼쪽이라 버릴 뿐이다. "우리 장비가 관측한 것이 아니므로 검사 범위 밖"으로 정정 |

2차 배치에서 직접 검산한 수치: 타임아웃 체인(외부 호출 6.5s → 앱 내부 8.0s → 가드 10s → Nginx 15s → LB 20s → CDN 25s → 클라이언트 30s) /
C10K 메모리(1MB × 10,000 = 약 10GB) / 버퍼링 처리량(200 ÷ 10.05 ≈ 20 vs 200 ÷ 0.055 ≈ 3,636) /
롤링 재시작 편중(8·8·8 → 0·12·12 → 6·0·18 → 15·9·0, 합계 24 유지) / 일관성 해시 재배치율 80% /
헬스체크 감지 지연 250 × 17 = 4,250건 / 파일 전송(1GB @5Mbps = 1,600초, 5GB @20Mbps = 2,000초 — 10진 GB 기준으로 일관) /
분할 업로드 조각 하한(100GB ÷ 10,000 = 10.24MB, 8MB면 12,800개로 초과) / 이더넷 프레임 14+20+20+1460+4 = 1518 /
`max-age=31536000` = 3,600 × 24 × 365 / gzip 최소 오버헤드 10+5+8 = 23바이트.

### 검증기 추가 보완

다이어그램의 대각 화살표 `↗`·`↘`(`↖`·`↙` 포함)를 허용 목록에 추가했다. 이미 허용하던 `→`·`↑`와 같은 용법이다.

### 분량 메모

08장 평균이 12.1KB → 55.2KB가 됐다. 최대는 14번(85KB)·15번(75KB)·18번(71KB)이고,
07장의 20번(122KB) 같은 이상치는 없다. 06장 최대치(52KB)보다는 크지만 전체가 40~85KB 구간에 고르게 들어와
07장에서 남겨둔 "20번급을 상한으로 볼 것인가"라는 물음은 이 장에서는 문제가 되지 않았다.

## 09-rest-api (18/18) — 완료

1차 배치(10건, 5에이전트 병렬) / 2차 배치(8건, 4에이전트 병렬)로 진행한다.

| 파일 | 배치 | 상태 |
|---|---|---|
| 01-restful-design-principles-resource-naming.md | 1 | 완료 |
| 02-put-vs-patch.md | 1 | 완료 |
| 03-api-versioning-strategies.md | 1 | 완료 |
| 04-pagination-offset-vs-cursor-api-contract.md | 1 | 완료 |
| 05-error-response-body-standardization.md | 1 | 완료 |
| 06-idempotency-key-design.md | 1 | 완료 |
| 07-chatty-api-call-explosion.md | 1 | 완료 |
| 08-backward-compatible-api-changes.md | 1 | 완료 |
| 09-partner-api-vs-internal-api.md | 1 | 완료 |
| 10-long-running-operations-202-polling-callback.md | 1 | 완료 |
| 11-rest-vs-graphql-vs-grpc.md | 2 | 완료 |
| 12-etag-if-match-optimistic-concurrency.md | 2 | 완료 |
| 13-aggregation-api-partial-failure-contract.md | 2 | 완료 |
| 14-gateway-vs-service-responsibility-boundary.md | 2 | 완료 |
| 15-api-docs-implementation-sync.md | 2 | 완료 |
| 16-bulk-api-partial-failure-response.md | 2 | 완료 |
| 17-list-api-filter-sort-search-params.md | 2 | 완료 |
| 18-api-datetime-format-contract.md | 2 | 완료 |

착수 시점 검증기 결과: 18건 전부 FAIL. 하드랩 18건, 이모지 5건(04·05·07·16·17·18),
섹션 번호가 `## 0.`~`## 6.`으로 뻗은 문서 3건(05·16·18).

이 장에서 특히 주의할 것:

- 17번이 정렬 비용을 MySQL 용어 `filesort`로 서술하고 검색 대안에 MySQL FULLTEXT를 앞세운다.
  PostgreSQL 기준(`Sort` 노드, `work_mem` 초과 시 디스크 정렬, `tsvector`/GIN)으로 바꾼다.
- 18번이 DB 타임존 처리를 "확인해 보라"로 뭉뚱그린다. PostgreSQL `timestamptz`의 실제 동작
  (입력을 UTC로 변환해 저장, 출력 시 세션 `TimeZone`으로 변환 — 타임존 자체는 저장하지 않는다)으로 구체화한다.
- 06번의 멱등성 키 선점이 MySQL 문법이면 `INSERT ... ON CONFLICT DO NOTHING`으로 바꾼다.
- 13번과 16번이 둘 다 207 Multi-Status를 다룬다. 결론이 어긋나지 않게 맞춘다.

### 1차 배치(01~10)에서 정정한 원문 사실 오류

| 문서 | 원문 | 정정 |
|---|---|---|
| 01 | "캐시 가능·계층화 시스템·균일한 인터페이스까지가 REST의 제약 조건" | 클라이언트-서버와 코드 온 디맨드가 빠져 6개(5 필수 + 선택 1)다. 더 중요한 건 원문이 ①②③(URI 식별·메서드·상태 코드)을 균일한 인터페이스와 **병렬 항목처럼** 배치한 것 — 실제로는 그 제약의 하위 규칙이다. 표로 소속을 명시 |
| 01 | `204 No Content`를 "돌려줄 바디 없음"으로만 서술 | 본문을 실을 수 있는 것처럼 읽힌다. "없음(있으면 규약 위반)"으로 못박음 |
| 02 | "`JsonNullable`/`Optional` 래퍼 필드"를 동급 선택지로 나열 | Jackson에서 `Optional` 필드는 명시적 null이 `Optional.empty()`, 키 부재가 필드 `null`이라 **의미가 뒤집힌 3상태**가 된다. 오독 위험을 설명하고 `JsonNullable` 권장 근거로 교체 |
| 02 | `marketingAgreed`가 "null/false로 덮임" | `Boolean`이면 null, `boolean`이면 `false`. **원시 타입일 때가 더 위험**하다(NOT NULL 제약에도 안 걸리고 정상값처럼 "동의 해제"로 저장) |
| 03 | `Deprecation`·`Sunset`을 이름만 나열 | 형식이 서로 다르다. `Sunset`은 RFC 8594의 HTTP-date, `Deprecation`은 RFC 9745의 구조화 필드 Date(`@1798761599`). RFC 9745의 "Sunset은 Deprecation보다 이르면 안 된다" 제약과, 초안 형태(`Deprecation: true`)가 아직 통용된다는 현실을 병기 |
| 03·08 | "필드 추가는 안전"의 근거가 막연 | Jackson 자체 기본값은 `FAIL_ON_UNKNOWN_PROPERTIES`가 **켜져 예외**이고 Spring Boot 자동 구성이 꺼 준다. 즉 "추가는 안전"은 소비자 설정에 의존하는 조건부 명제 |
| 04 | "정확한 실시간 count는 매 요청 전체 스캔" | PostgreSQL 기준으로 부정확. MVCC라 확정 행수가 애초에 없고, 인덱스 엔트리에 가시성 정보가 없어 힙 확인이 필요하며, **가시성 맵**이 신선한 페이지에 한해 `Index Only Scan`으로 이를 건너뛴다. 근사치는 `pg_class.reltuples` |
| 06 | 선점을 `try { insert } catch (DuplicateKeyException) { findByKey }` 로 구현 | **PostgreSQL에서 동작하지 않는다.** 유니크 위반이 터지면 트랜잭션 전체가 중단(aborted) 상태가 되어 catch 안의 조회가 다시 실패한다. `INSERT ... ON CONFLICT DO NOTHING` + 영향 행 수 판정으로 교체(우회로는 `REQUIRES_NEW` 또는 `SAVEPOINT`) |
| 06 | 선점 INSERT의 트랜잭션 경계 미명시 | 핸들러 전체를 `@Transactional`로 묶으면 IN_PROGRESS 표식이 커밋 전까지 안 보여 설계 목적이 무너지고, 뒤에 온 INSERT가 PG 승인이 끝날 때까지 인덱스에서 대기해 409 대신 수 초를 붙잡힌다 |
| 07 | "화면 하나에 **21 RPS**를 쓰는 클라이언트" | RPS는 초당 요청률이라 단위 오류. "요청 21건" |
| 07 | "서버·프록시마다 URL 길이 상한이 있어(수 KB 수준)" | HTTP 스펙에 상한이 없다. RFC 7230의 8,000 옥텟은 **하한 권고**이고 실질 한계는 Nginx `large_client_header_buffers`(초과 시 414)·Tomcat `maxHttpHeaderSize`·통념상 2,000자로 주체가 각각 다르다. "수백 개면 걸리나"의 답이 id 형태에 달렸다로 바뀜 |
| 08 | Tolerant Reader 서술에 Jackson 기본값 부재 | 모르는 **필드**는 `UnrecognizedPropertyException`, 모르는 **enum 값**은 `InvalidFormatException`으로 예외 타입이 다르다. `@JsonEnumDefaultValue`는 `READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE`를 켜야 동작한다 |
| 09 | SLA–SLO 간격을 error budget이라 서술 | error budget은 SLO가 허용하는 실패 총량(1−SLO)이다. 둘을 분리 정의 |
| 09 | `RateLimit-*` 를 표준인 양 서술 | IETF 초안이며 아직 RFC가 아니고, 초안 자체가 개별 헤더 3개에서 구조화 필드 하나로 통합되는 방향으로 바뀌었다. 현장 관행은 여전히 `X-RateLimit-*`. `429`(RFC 6585)·`Retry-After`(RFC 9110)만 확정 표준 |
| 10 | `Retry-After`를 `202`에 붙이는 것을 표준처럼 서술 | RFC 9110이 규정한 것은 `503`·`3xx`(그리고 `429`는 RFC 6585)이고 `202`는 용법의 확장이다. 표준 위반은 아니나 클라이언트가 자동 해석해 줄 것으로 가정하면 안 된다 |
| 10 | `Location`이 `202`의 정의된 메커니즘인 것처럼 서술 | RFC 9110 §15.3.3은 "응답 표현이 상태 모니터를 가리키도록" 권할 뿐이고 `Location`에 담는 것은 관행이다 |
| 10 | 타임아웃 계층 다이어그램이 층 이름·수치 없이 07·08장과 어긋남 | `08-network-http/13`의 정렬 스택(앱 내부 8.0s → 가드 10s → Nginx 15s → LB 20s → CDN 25s → 클라이언트 30s)에 맞춤 |

오케스트레이터가 직접 고친 2건:

- 08번이 `Deprecation: true`(초안 형태)를 아무 단서 없이 예시로 써서, 03번이 정리한 RFC 9745 형식과의 관계를 한 문단으로 잇고 참조를 걸었다.
- 06번이 `SET key value NX PX 30000`을 "예전 이름은 `SETNX`"라고 서술했다. `SETNX`는 별도 명령이고 만료를 못 걸어 `EXPIRE`를 따로 보내야 하는 **비원자적** 조합이라, 하필 원자성을 논하는 자리에서 의미가 뒤집혔다. `05-redis-caching/16`이 이미 정확히 서술하고 있어 그쪽에 맞추고 링크를 걸었다.

1차 배치 검산: 0.999⁵ = 99.50% / 30일 43,200분 · 99.9% 43.2분 · 99.95% 21.6분 /
`Deprecation: @1798761599` = 2026-12-31 23:59:59 UTC / 12345÷20 = 617.25 → 618페이지 /
5,001페이지 = `OFFSET 100000`, 100,020행, 5,001배 / 21회×300ms = 6.3초 /
HTTP/1.1 병렬 1+⌈20/6⌉ = 5 RTT, HTTP/2 = 2 RTT / 1−0.99²¹ ≈ 19% /
URL 2,000자에 숫자 id 222개·UUID 54개 / 1,000,000×1KB ≈ 977MB / SHA-256 = 16진수 64자 /
리틀의 법칙 1건/초×300초 = 300스레드 > 톰캣 기본 200, 소진 200초 /
고정 5초 폴링 60회 중 헛질의 59회(98.3%), 지수 백오프(1s·×2·cap 30s)는 14회에 300초 초과(4.3배 감소) /
rate limit 사례 30,000÷3분 = 10,000회/분(한도의 16.7배), 통과 1,800건·거절 28,200건, 분산 시 50분.

### 2차 배치(11~18)에서 정정한 원문 사실 오류

| 문서 | 원문 | 정정 |
|---|---|---|
| 12 | 약한 ETag에 대해 "`If-Match` 비교에서도 강한 ETag를 쓰는 것이 **안전하다**" | 과소 서술이다. RFC 9110 §13.1.1상 `If-Match`는 **강한 비교**를 쓰므로 약한 ETag는 **절대 일치하지 않는다** — `W/"7"`에 `If-Match: W/"7"`을 보내도 항상 412다. "안전하다"가 아니라 "아예 동작하지 않는다". 압축 필터가 강한 ETag를 약한 것으로 낮추면 `If-Match`가 상시 412가 되는 함정으로 연결(08장 20번과 일치) |
| 12 | `@Version`의 UPDATE를 `SET ..., version = version + 1` 형태로 기대 | 하이버네이트는 새 버전 값을 메모리에서 계산해 바인딩하므로 실제 로그는 `version=?`이다. `03-jpa-orm/10`이 이미 이 점을 짚고 있어 개념형과 실제 로그형을 둘 다 보이고 차이를 설명 |
| 12 | `@RequestHeader(required = false)`의 이유 미설명 | `required = true`면 Spring이 먼저 400을 내버려 **428을 쓸 기회 자체가 사라진다** |
| 11 | "gRPC는 HTTP/2 프레임을 세밀하게 제어(트레일러 헤더 등)해야 하는데" | 원인을 뭉갠 서술. `grpc-status`가 **트레일러에 실리고** 브라우저 fetch/XHR이 트레일러를 노출하지 않는다는 정확한 인과로 교체 |
| 13 | 예산 배분표가 검산 불가·자기모순 | ① `## 1.`의 5개 중 상품 서비스가 표에서 누락 ② 순차로 읽으면 700+500+300+300 = 1,800ms로 전체 예산 1,000ms를 80% 초과 ③ 다이어그램은 4개인데 코드는 3개만 호출. 의존 관계를 명시한 2단계 구조로 재설계: 400 + max(300,300,200,200) = 700ms + 여유 300 = 1,000ms (전부 순차면 1,400ms로 초과) |
| 13 | status enum이 `OK / UNAVAILABLE / TIMEOUT` | **문서가 자기 주장을 스키마로 지키지 못한다.** 본문은 "'데이터 없음'과 '가져오지 못했다'는 달라야 한다"고 주장하는데 둘 다 `OK` + `data: null`로 뭉개진다. `EMPTY` 추가로 해결하고 `TIMEOUT` 같은 사유는 상태값이 아니라 `error.code`로 |
| 13 | 207을 "중간 장비가 **오해할** 수 있다" | 207은 2xx라 대부분 도구가 성공으로 분류한다. 오해가 아니라 **특별 취급을 안 해서 얻는 게 없는 것**. 16번과 결론 일치 |
| 16 | AWS SQS 배치를 "재시도 가능 여부 성격의 정보" | 실제 계약으로 대체 — 요청 엔트리마다 클라이언트가 부여한 `Id`, 응답은 `Successful`/`Failed` 두 목록, 실패 엔트리에 `Code`·`Message`·`SenderFault` 불리언, 요청당 최대 10건 |
| 17 | "`LIMIT 20`이 있어도 정렬 대상 전체를 읽는 비용은 그대로다" | 결론은 맞지만 근거가 틀렸다. PostgreSQL은 `LIMIT`이 붙으면 `top-N heapsort`를 골라 **정렬 메모리는 억제한다**. "메모리는 아끼되 하위 `Seq Scan`의 전량 읽기는 그대로"로 정정. §3 사례의 `EXPLAIN` 결과를 `external merge Disk`로 단정한 것도 같은 이유로 자기모순이라 `top-N heapsort`로 수정 |
| 17 | "중간 일치(`%키워드%`)는 인덱스를 탈 수 없어 전체 스캔" | PostgreSQL에서는 `pg_trgm` 트라이그램 GIN이 후보 축소에 쓰이므로 단정이 틀린다. 완화하고 대가(인덱스 크기·쓰기 비용, 3글자 미만이면 무효)를 명시 |
| 18 | epoch 예시 값 `1756600000` | 2025-08-31T00:26:40Z라 같은 JSON의 다른 2026년 필드와 **자기모순**. `1788134400`(2026-08-31T00:00:00Z)로 교체 |
| 18 | JS 파싱 예시 `"2026-08-31T09:00"` | 파싱 규칙 서술 자체는 정확했으나, 이 값은 KST에서 우연히 `"2026-08-31"`과 같은 순간이 되어 **9시간 차이를 실증하지 못한다**. 실제로 어긋나는 `"2026-08-31T00:00:00"`으로 교체 |
| 18 | `ZonedDateTime`을 미래 예약 저장 타입으로 권고 | 권고는 맞지만 함정 누락 — Jackson은 기본 설정에서 직렬화 시 `[Asia/Seoul]`을 떼고 오프셋만 내보낸다(`WRITE_DATES_WITH_ZONE_ID` 기본 비활성). API 계약에서는 `startsAt` + `timeZone` 두 필드로 나누라는 권고 추가 |
| 18 | date-only는 안전하다는 인상 | date-only 문자열도 JS `Date`에 넣으면 UTC 시점이 되어 같은 문제가 재발한다(`TZ=America/New_York`에서 `new Date("2026-08-31")`이 8/30로 표시) |

PostgreSQL 전환: 17번의 `filesort` 4곳을 `Sort` 노드 / `work_mem` 초과 시 외부 병합 정렬 /
`Sort Method: external merge Disk:` 관측으로 교체하고, 전문 검색의 "PostgreSQL `tsvector`/GIN, MySQL FULLTEXT" 병기에서
MySQL을 빼고 `tsvector`·GIN·`pg_trgm` 3단계로 확장했다. 18번은 뭉뚱그려져 있던 DB 타임존 서술을
`timestamptz`의 실동작(입력을 세션 타임존으로 해석해 UTC로 변환 저장, 출력 시 세션 `TimeZone`으로 변환 —
타임존 자체는 저장하지 않는다)과 `timestamp`/`date`와의 대비, 그리고 Java 타입 대응표로 구체화했다.

2차 배치 검산: 0.999¹⁻⁵ = 99.9000/99.8001/99.7003/99.6006/99.5010%,
월 장애 43.2/86.4/129.5/172.5/215.6분(30일 43,200분 기준) /
예산 병렬 400+max(300,300,200,200) = 700ms, 순차 1,400ms /
벌크 건당 20ms × 1,000건 = 20초 > 앱 가드 10초(한도가 이미 깨져 있음), 역산 8초÷20ms = 400건, 여유 50%면 200건 /
Protobuf 태그 `(1<<3)|0` = `0x08`, 값 42 = `0x2A` → 2바이트 vs JSON `{"order_id":42}` 15바이트,
필드번호 15까지 1바이트 태그(`(15<<3)|7` = 127 < 128) / N+1 users 10명 → 11회, orders 20건 → 21회 /
epoch `1788134400` = 2026-08-31T00:00:00Z, 초를 ms로 오해 시 1970-01-21, ms를 초로 오해 시 20,696,000일 ÷ 365.2425 ≈ 56,664년(서기 58,634) /
KST 23:59:59 = `14:59:59Z`.

18번은 에이전트가 Java 21 + Node 20을 실제로 실행해 검증했고, 오케스트레이터가 재현해 일치를 확인했다:
`"2026-08-31"`(Seoul) → `2026-08-31T00:00:00.000Z`, `"2026-08-31T00:00:00"`(Seoul) → `2026-08-30T15:00:00.000Z`(9시간 어긋남),
`"2026-08-31"`(New York 표시) → `8/30/2026, 8:00:00 PM`, `"1990-05-15T00:00:00Z"`(New York) → `5/14/1990`.

### 09장 마감 검증

18건 전부 `verify.py [OK]`. 이모지 0건, 장 내부 상호 참조 링크 23건 전부 실재, 섹션 번호 전부 0~4.
13.0KB → 평균 41KB(합계 742KB). 07장 20번(122KB) 같은 이상치 없이 35~51KB에 고르게 들어왔다.

### 다음 세션 인수인계

다음 차례는 01-java-kotlin(32건)이다. 05~09장은 작고 균질해 2~3건씩 5에이전트 병렬이 잘 맞았으나,
01·02장은 건수가 많고(32·35) 03·04장은 이미 분량이 커서(48KB·58KB) 성격이 다르다.
03·04는 "전면 재작성"이 아니라 **설명 방식 조정 + 하드랩 해제 위주**임을 잊지 말 것.

## 01-java-kotlin (32/32) — 완료

이 장의 사전 진단: 32건 전부 72자 하드랩. 11건은 섹션 번호가 `## 5.`~`## 9.`까지 뻗거나 `## 부록`이 붙어 있고, 그중 10건은 `## 4. 꼬리질문 대비 포인트`와 `## 한 줄 요약`이 아예 없다. 이모지는 8개 파일에 63건.

| 파일 | 상태 | 비고 |
|---|---|---|
| 01-jvm-memory-structure.md | 완료 | 참조란 무엇인가를 1-1에 신설, `new` 한 줄의 스택·힙 배치 도식 |
| 02-gc-basics-generational.md | 완료 | 순환 참조 코드, Eden→Survivor→Old 타임라인, Minor GC 비용 6단계 계산 |
| 03-equals-hashcode-contract.md | 완료 | 조회 2단계를 규약보다 먼저 설명하도록 순서 반전 |
| 04-string-immutability-stringbuilder.md | 완료 | 불변 정의부터, String pool을 원인이 아닌 결과로 재배치, O(n²) 합산식 |
| 05-checked-vs-unchecked-exceptions.md | 완료 | 예외 계층도 선행, 예외 삼킴 장애 타임라인, 롤백 기본값의 근거 |
| 06-interface-vs-abstract-class.md | 완료 | 공통점→갈리는 두 지점(상태·다중 부착) 순서로 재구성, 다이아몬드 도식, 템플릿/전략 코드 대비, 이모지 6건 제거 |
| 07-final-keyword-semantics.md | 완료 | "final은 주소 칸을 잠근다" 그림 선행, effectively final 근거(스택 프레임 소멸), static final 인라이닝 실측, 이모지 4건 제거 |
| 08-java8-features-in-practice.md | 완료 | 지연 평가를 각주에서 본문으로 승격, 실행 순서 추적 코드 |
| 09-enum-strategy-and-state-transition.md | 완료 | javap로 "enum은 클래스" 실증, 상태 전이 다이어그램 선행, static 블록 근거 실측(컴파일 에러 2종 + ExceptionInInitializerError), ordinal 밀림 before/after 데이터 |
| 10-g1gc-vs-zgc.md | 완료 | `## 8.`+부록 → 0~4 재편, 컬러 포인터·로드 배리어 정의, 이모지 26건 제거 |
| 11-full-gc-troubleshooting.md | 완료 | 런북 결정 트리 도식, 판단 기준 용어 전부 정의 |
| 12-hashmap-internals.md | 완료 | 비트 연산 3곳을 실제 비트 패턴 계산으로 전개 |
| 13-concurrenthashmap-internals.md | 완료 | 구조 재편(선행 개념·부록 흡수), 복합 연산 원자성 신설 |
| 14-volatile-visibility-vs-atomicity.md | 완료 | 캐시 계층 도식 + `count++` 인터리빙 타임라인 |
| 15-jmm-happens-before.md | 완료 | "먼저 실행"이 아니라 "반드시 보인다" 오해 격파 중심 |
| 16-threadlocal-thread-pool-risks.md | 완료 | ThreadLocalMap 저장 구조 도식 하나에서 세 결론을 유도 |
| 17-parallelstream-pitfalls.md | 완료 | 공용 풀 크기의 근거, reduce 결합법칙 단계별 계산 |
| 18-generics-type-erasure.md | 완료 | 질문에 있으나 본문에 없던 PECS 신설, `javap` 실물 출력, 깨진 코드블록 3곳 복구 |
| 19-optional-usage-boundaries.md | 완료 | 3-상태 논거 도식화, `orElse`/`orElseGet` 평가 시점, 제목 이모지 제거 |
| 20-try-with-resources-resource-leaks.md | 완료 | 예외 은폐를 1절 본체로 승격, suppressed 스택트레이스 대비 |
| 21-defensive-copy-collection-exposure.md | 완료 | 참조 다이어그램 선행, 얕은 복사의 한계 신설, TOCTOU 두 스레드 타임라인 |
| 22-static-simpledateformat-shared-mutable-state.md | 완료 | 내부 Calendar 2단계 분해, 싱글톤 빈으로 주제 확장 |
| 23-jvm-heap-thread-dump.md | 완료 | 구조 전면 재편, 8GB 덤프 15초 STW 타임라인, `nid` 표기 오류 교정 |
| 24-deadlock-analysis-prevention.md | 완료 | 4조건을 "깨면 왜 불가능해지는가"와 짝지음, 미탐지 케이스 상태표 |
| 25-jit-compiler-performance.md | 완료 | "빨리 시작 vs 빨리 실행" 트레이드오프 선행, JMH dead code 제거 실증 |
| 26-synchronization-tool-selection.md | 완료 | 선택의 축을 도구 나열보다 먼저, 판단 순서도 |
| 27-longadder-false-sharing.md | 완료 | CAS 실패가 캐시 라인 소유권 왕복이라는 데까지 연결 |
| 28-virtual-threads-pinning.md | 완료 | `## 9.` → 0~4 재편, Continuation freeze/thaw 도식, 커넥션 풀 상한 계산 |
| 29-record-use-cases.md | 완료 | "상태는 컴포넌트가 전부"라는 의미 선언을 문법 설명보다 먼저 |
| 30-integer-cache-boxed-equality.md | 완료 | `==`가 왜 컴파일 에러가 아닌지부터 전제로 |
| 31-reference-types-weakhashmap.md | 완료 | 참조 강도의 존재 이유부터 선행, JDK 21 실측(Soft 압박 정리·expunge 시점·리터럴/박싱 캐시 키·Guava 동일성) 전면 반영 |
| 32-bigdecimal-equals-compareto.md | 완료 | `## 4. 꼬리질문` 신설, unscaledValue/scale 표현부터 선행 |

### 기계 검증 도구

`verify.pl`(구조 6요소 / 섹션 번호 0~4 연속성 / 이모지 / 하드랩 잔존)과 `cmp.py`(질문·출제 의도 원문을 git HEAD 기준과 문자 단위 대조)로 배치마다 확인한다. 완료된 09-rest-api 18건에 돌려 18/18 통과로 캘리브레이션했다. ①②③이나 박스드로잉 문자는 이모지로 세지 않는다.

## 02-spring (35/35) — 완료

### 장 사전 진단

`verify.pl` 기준 35건 전부 구조 위반이다. 파일이 두 부류로 갈린다.

- **01~23·35번 (24건)**: 72자 하드랩. 문단이 인위적으로 끊겨 있고, `> 핵심 관전 포인트:` 블록이 5~8줄짜리 개념 압축 덩어리다. 본문에서 한 문단씩 풀 것을 미리 압축해 던지는 구조라서, 관전 포인트만 읽으면 아는 사람에게만 말이 된다.
- **24~34번 (11건)**: 하드랩은 없으나 `---` 구분선이 빠져 있고 불릿 압축이 심하다. 24·25·26·29·30·31·32·34번은 5.8~10.4KB로 이 장에서 가장 얇다 — 깊이가 아니라 설명이 없어서 얇다.

그 밖에: 21건이 `## 5.`~`## 8.`까지 섹션이 뻗어 있어 0~4 재편 대상. 13번은 `## 답변의 축`, 29·34번은 `## 꼬리질문 대비 포인트`가 번호 없는 h2. 24~34번은 관전 포인트가 굵은 글씨(`**`)가 아니다. 이모지는 21개 파일에 총 249건(08번 44건, 18번 43건이 최다). **단 이 수치는 과대 집계였다** — 초기 조사 정규식이 화살표(`→`)를 이모지로 셌다. 교정 후 실제 값은 26번 0건(화살표 9건), 27번 2건(화살표 12건)이다. 파일별 진단서에 잘못된 수치가 그대로 전달됐으나, 에이전트들이 `verify.pl`로 실제 잔존을 확인하며 작업해 결과에는 영향이 없었다.

14번 문서가 `04-rdb-sql/transaction-isolation-levels.md`를 "저기서 다룬다"며 미루는데, **04-rdb-sql은 커밋 `8deef26`에서 35건 전부 삭제되어 현재 비어 있다.** 해당 참조를 지우고 DB 내부 동작을 14번 안에서 자족적으로 설명하도록 지시했다.

### 배치 편성 (관련 주제를 한 에이전트에 묶는다)

| 배치 | 파일 | 묶은 이유 |
|---|---|---|
| B1 | 01, 02, 03 | 컨테이너 기초 — IoC/DI → 빈 생명주기 → 주입 방식 |
| B2 | 04, 05, 06 | 웹 계층 — 스테레오타입, MVC 파이프라인, Filter/Interceptor |
| B3 | 07, 10, 11 | 프록시 3부작 — 역할 분담 후 상호 참조 |
| B4 | 12, 13, 14 | 트랜잭션 속성 3부작 — 전파·readOnly·격리 수준 |
| B5 | 08, 09, 29 | 설정 계열 — 자동 구성, 프로파일, @Value/@ConfigurationProperties |
| B6 | 15, 16, 34 | 비동기·스케줄 — @Async, 이벤트, @Scheduled |
| B7 | 17, 19, 21 | 순환 참조, 전역 예외, 검증 |
| B8 | 18, 20, 33 | HTTP 클라이언트, @Cacheable, ArgumentResolver |
| B9 | 22, 23, 24 | 트랜잭션 경계 — 외부 호출, 아웃박스, 커넥션 바인딩 |
| B10 | 25, 26, 27 | 풀·스레드 모델 — 사이징, 고갈, WebFlux |
| B11 | 28, 30, 32 | 운영 — 무중단 배포, actuator, 기동 지연 |
| B12 | 31, 35 | 시큐리티 필터 체인, AI 코드 리뷰 체크리스트 |

### 기계 검증 도구 (이번 세션에서 재작성)

`verify.pl`과 `cmp.py`가 이전 세션 스크래치패드와 함께 사라져 다시 만들었다.
완료된 6개 디렉토리(01·05·07·08·09·10장, 140건)에 돌려 전부 `0 fail`로 캘리브레이션했다.

- `verify.pl`: 구조 6요소 / 관전 포인트 굵은 글씨 / 섹션 번호 0~4 연속성 / 이모지 / 하드랩 잔존
- 이모지 판정에서 `★ ☆ ✓ ✗ ①②③` 과 박스드로잉은 제외한다 — 완료된 장들이 도식 마커로 쓰고 있다.
- `cmp.py`: 질문·출제 의도 문구를 git HEAD 기준과 공백 정규화 후 문자 단위 대조

### 장 밖에서 발견한 것

- ~~**04-rdb-sql이 비었다.**~~ 커밋 `8deef26`("4장 knowledge 문서 35건 삭제")로 비었다고 기록했으나, 이후 `f1b2a4f`로 revert되어 **35건이 복구돼 있다**(2026-09-02 실측). 이 항목은 해소됐다.
- ~~**06-messaging에 12건이 기준 미달이다.**~~ 2026-09-02에 해소했다. RabbitMQ 12건(10~20·34)의 본문 섹션을 셋으로 합치고 꼬리질문을 `## 4.`로 내렸으며, 02번의 번호 없는 h2도 `### 3-3.`으로 강등했다. 진단대로 내용 자체는 새 기준으로 쓰여 있어 구조 정리와 합치는 과정의 서술 보강만 했다.

### 파일별 현황

| 파일 | 상태 | 비고 |
|---|---|---|
| 01-ioc-di-fundamentals.md | 완료 | 컨테이너를 `Map<빈 이름, 완성된 객체>`로 실체화 + 기동 4단계 도식 신설, 결합도를 "PG 교체 시 고칠 파일 수 7건 → 1건"으로 수치화, 목 주입 테스트 코드 신설(예외 경로 생성이 진짜 차이), DI 3방식은 03번으로 넘겨 중복 제거 |
| 02-bean-lifecycle-singleton-scope.md | 완료 | 두 스레드가 싱글턴 필드를 밟는 t1~t5 타임라인 신설(주문#1 미결제 + 주문#2 이중 결제 + 응답 혼선), `BeanPostProcessor`가 `Object`를 반환해 빈을 바꿔치기한다는 점으로 AOP 프록시 시점 연결, "상태가 필요하면 프로토타입?" 함정을 시점 도식으로 정면 답변, 이모지 15건 제거 |
| 03-constructor-injection-over-field-injection.md | 완료 | **원문 사실 오류 정정** — "필드 주입은 주입 누락이 런타임 NPE로 늦게 드러난다"는 서술이 틀렸다. `@Autowired`는 기본 `required=true`라 필드 주입도 기동 시 `UnsatisfiedDependencyException`으로 죽는다. 진짜 차이는 컨테이너 **밖**에서 반제품 객체가 만들어지는 경로라는 축으로 재작성. javac 21 실제 에러 메시지 2종 인용, Boot 2.6 순환 참조 기본 금지, `@RequiredArgsConstructor`의 `@Qualifier` 미복사 함정 추가 |
| 04-stereotype-annotations.md | 완료 | 메타 애너테이션 2단 탐색 트리 도식, `@Repository` 예외 변환을 JPA/MyBatis 같은 유니크 위반의 예외 타입 대비로 실증. **원문 사실 오류 2건 정정** — ① after 예제가 JPA 경로에 `DuplicateKeyException`을 잡고 있었으나 Hibernate 경로는 `DataIntegrityViolationException`이 온다(`DuplicateKeyException`은 JDBC/MyBatis SQLSTATE 23505 경로) ② "`SimpleJpaRepository`에 `@Repository`가 붙어서 변환된다"는 인과가 틀렸다 — 이 클래스는 컴포넌트 스캔 대상이 아니라 후처리기 시야 밖이고, 실제로는 리포지토리 프록시의 `PersistenceExceptionTranslationInterceptor`가 일한다 |
| 05-spring-mvc-request-flow.md | 완료 | HandlerMapping/HandlerAdapter가 왜 둘로 갈리는지를 독립 절로 신설(`supports(handler)` + OCP), 메시지 컨버터 vs ViewResolver 두 갈래 도식, **실제 스택트레이스 3종**(필터/바인딩/컨트롤러)으로 판별 절차 신설 — `MethodArgumentNotValidException`은 컨트롤러 시그니처가 메시지 텍스트로만 있고 `at` 프레임엔 없다는 함정 포함. 이모지 25건 제거, `flow` 커스텀 블록 3개를 박스드로잉으로 교체 |
| 06-filter-vs-interceptor.md | 완료 | 서블릿 컨테이너·스펙 정의 절 신설, `@ControllerAdvice`가 못 잡는 경계선을 `doDispatch()`의 try 블록으로 못 박음. **오케스트레이터 지시의 오류를 에이전트가 정정** — "톰캣 기본 HTML이 나간다"는 Boot 3.x 기본 설정에서 성립하지 않는다(톰캣이 `/error`로 ERROR 디스패치를 걸어 `BasicErrorController`가 Accept에 따라 Whitelabel HTML 또는 부트 기본 JSON을 낸다). 에러 페이지 처리가 없는 경우로 한정해 두 갈래로 기술. trace id 사각지대 t0~t5 타임라인, `OncePerRequestFilter.shouldNotFilterErrorDispatch()` 기본 true 함정 추가 |
| 07-transactional-default-behavior-rollback.md | 완료 | "왜 checked는 롤백하지 않는가"에 근거 신설(자바가 예외를 둘로 나눈 기준 → 트랜잭션 규칙이 따라 나온다 → 그 전제가 "비즈니스 예외를 RuntimeException으로" 관행과 어긋나 사고가 난다). 예외 계층 도식에 롤백선, rollback-only를 t0~t15 호출 스택 타임라인으로. **원문 사실 오류 정정** — "public 메서드에만 적용된다"는 스프링 6.0 이후 틀렸다(class-based 프록시는 `protected`·패키지 프라이빗도 대상, 인터페이스 기반만 public 한정, `private`은 양쪽 불가). 오케스트레이터가 GitHub 이슈 #31057과 공식 레퍼런스로 재확인. 스프링 6.2 `@EnableTransactionManagement(rollbackOn = ALL_EXCEPTIONS)` 추가(기본값 `RUNTIME_EXCEPTIONS`) — 이것도 재확인 |
| 10-aop-jdk-dynamic-proxy-vs-cglib.md | 완료 | AOP를 "객체는 명사로 자르는데 트랜잭션은 전부를 가로지르는 또 다른 절단면"으로 정의. JDK 프록시에 인터페이스가 필수인 인과를 `Proxy.newProxyInstance`가 인터페이스 배열을 유일한 타입 통로로 받는다는 점 + 이미 `java.lang.reflect.Proxy`를 상속해 단일 상속상 자리가 없다는 점으로 세움. `BeanNotOfRequiredTypeException` 함정 → 부트가 `proxyTargetClass=true`를 기본값으로 삼은 이유로 연결. `final` 함정을 "시끄럽게 죽는다 / 조용히 샌다"로 대비. 이모지 18건 제거 |
| 11-transactional-self-invocation.md | 완료 | 트랜잭션 부재 시 실제 증상 5종 신설 — 특히 **OSIV로 영속성 컨텍스트는 열려 있으나 flush 시점이 없어 변경 감지 UPDATE가 아예 안 나가는** 경우가 원문에 빠져 있었다. D+0~D+12 발견 타임라인. "내 코드에 이 버그가 있는지 확인하는 절차" 신설 — 오케스트레이터가 지시한 `AopUtils.isAopProxy(this)`는 원본 메서드 안에서 항상 false라 탐지기가 아님을 에이전트가 바로잡고 `getCurrentTransactionName()`이 결정적이라고 정정. 해법 4종을 각각 대가 3개씩과 짝지음 |
| 08-spring-boot-auto-configuration.md | 완료 | "자동 구성 = yml 안 써도 되는 것"이라는 오해를 걷는 설정값 vs 설정 클래스 구분표를 문서 맨 앞으로. 조건 평가 시점(런타임 아님, 빈 정의 등록 단계)과 순서(`DeferredImportSelector` → 사용자 설정이 끝난 뒤 마지막)를 도식화 — "내 DataSource 빈이 자동 구성을 이기는" 메커니즘의 전부. spring-boot 3.5 소스 직접 확인: imports 경로 `META-INF/spring/%s.imports` 확정, **원문의 "150개 남짓"을 실측 156줄로 교정**, `CONDITIONS EVALUATION REPORT` 실제 출력 형태로 교체. 이모지 44건 제거 |
| 09-application-yml-profile.md | 완료 | **인과 오류 교정** — "프로파일을 쓰면 저절로 fail-fast가 된다"로 읽히던 것을, 원인은 "기동 필수 설정을 공통 yml에서 비워 두는 설계 결정"이고 프로파일은 수단이라고 분리(안티패턴 구성도 프로파일을 쓰고 있었다는 반례를 앞에 배치). 우선순위 표에 **시스템 프로퍼티(`-D`)가 환경변수보다 위**라는 층 추가(원문은 뭉뚱그림). **오케스트레이터 지시 교정** — 부트 2.4+에서 옛 키 `spring.profiles`는 조용히 무시되지 않고 `InvalidConfigDataPropertyException`으로 기동 실패한다. 오케스트레이터가 spring-boot 3.3.5 바이트코드에서 ERRORS 맵 등록을 직접 확인 |
| 29-value-vs-configuration-properties.md | 완료 | 5.8KB → 36KB. 2절을 "차이 → 그것이 없어서 난 사고" 5건으로 재구성(기본값 붙은 키의 침묵을 t0~t5 타임라인으로). relaxed binding 정의 → 환경변수에 점·하이픈을 못 쓰는 셸 제약 → k8s `env:`가 곧 설정 오버라이드가 되는 경로로 연결. **흔한 오해 정정** — `@Value`도 `SystemEnvironmentPropertySource`의 밑줄 치환 덕에 환경변수 오버라이드가 동작한다(없는 것은 yml 키 표기 사이의 유연함). `@Validated` 실패 시 실제 출력 4줄 수록 |
| 12-transaction-propagation-required-vs-requires-new.md | 완료 | 전파를 "바깥 트랜잭션을 물려받을 것인가의 규칙"으로 정의하고 전제(트랜잭션은 커넥션 위에 산다)를 선행. 합류의 물리적 의미를 커넥션 관점 도식으로, 안쪽 커밋이 "주인 여부 분기 → 아무 일도 안 함"임을 흐름도로. 풀 데드락을 t0~t3로 검산하고 회피식 `Tn × (Cm-1) + 1` 유도(사례 11, 톰캣 200이면 201). **사실 정정 2건** — ① "전원이 영원히 교착"이 아니라 HikariCP `connectionTimeout` 30초 후 전원 실패 → "간헐적 30초 정지"로 관측된다 ② NESTED가 JPA에서 안 되는 근거(`nestedTransactionAllowed` 기본 꺼짐 → `NestedTransactionNotSupportedException`, 켜도 세이브포인트는 JDBC만 되감아 영속성 컨텍스트가 어긋남) |
| 13-transactional-readonly-optimization.md | 완료 | `## 답변의 축` 번호 없는 h2를 `### 2-1.`로 흡수. `## 1.` 전체를 전제 지식(영속성 컨텍스트 → 스냅샷/더티 체킹 → 플러시)으로 신설. **사실 정정 3건** — ① "메모리 2배/절반"은 부정확(스냅샷은 `Object[필드수]` + 박싱이라 엔티티보다 클 수도 있다). 필드 20개 기준 약 300B/건 → 10만 건 ≈ 30MB로 계산 근거 제시(오케스트레이터 검산: 28.6MB) ② 스냅샷 생략은 **스프링 5.1(부트 2.1)부터** — 그 이전은 FlushMode만 MANUAL ③ MANUAL에서 JPQL 실행 전 자동 플러시는 일어나지 않으며, `IDENTITY` 채번·`@Modifying` 벌크는 SQL이 DB에 도달해 PostgreSQL에서 `25006`으로 거부된다. `LazyConnectionDataSourceProxy`가 없으면 왜 전부 리더로 가는지(커넥션 획득이 readOnly 설정보다 앞선다)를 순서 도식으로 |
| 14-transaction-isolation-levels.md | 완료 | 세 이상 현상을 전부 두 트랜잭션 × 시간축 타임라인으로. non-repeatable vs phantom을 "같은 행의 값 vs 같은 조건의 행 수 / UPDATE vs INSERT·DELETE" 두 축으로 분리. **비어 있는 `04-rdb-sql` 참조를 지우고 `## 2.`를 자족적 메커니즘 절로 신설** — MVCC xmin/xmax, 스냅샷 가시성 판정, READ COMMITTED=문장마다 새 스냅샷, REPEATABLE READ=첫 문장 스냅샷 고정(BEGIN 아님), SERIALIZABLE=SSI 사후 감지 + `40001` 재시도 필수. PostgreSQL RR이 표준과 달리 phantom까지 막고 write skew만 남는다는 것, MySQL InnoDB는 대비표로만. **스프링 함정 정정** — 조용히 무시되는 경우는 합류 하나뿐이고 나머지는 `InvalidIsolationLevelException`. 재고 차감 네 갈래 비교표. 이모지 22건 제거 |
| 15-async-annotation.md | 완료 | "큐가 가득 차야 max까지 늘어난다"를 **분기 흐름도**로 도식화 — 부트 기본 큐가 `Integer.MAX_VALUE`라 max 분기에 영영 도달하지 않는다는 인과가 그림 하나로 끝난다. 큐 용량 판단 기준을 계산으로(200ms × core 8 = 40건/초 → 큐 100 = 최악 대기 2.5초). 컨텍스트 미전파 3종을 `ThreadLocal` 저장소 도식으로 **하나의 원인**으로 묶음. Java 21 실행으로 `get()` → `ExecutionException` / `join()` → `CompletionException` 확인. 이모지 13건 제거 |
| 16-spring-event-transactional-event-listener.md | 완료 | "기본은 동기"의 증거를 스레드 이름 로그 + 리스너 예외가 발행자 트랜잭션을 롤백시키는 코드로 제시. phase 4종을 트랜잭션 타임라인 도식 위에 배치. **원문 사실 오류 정정** — `AFTER_COMMIT` 리스너의 DB 쓰기가 사라지는 이유가 "트랜잭션 동기화가 아직 살아 있어서"라고 돼 있었으나 정반대다. `triggerAfterCompletion`이 `clearSynchronization()`을 **먼저** 부르므로 동기화 목록은 이미 비어 있고, 남은 것은 `cleanupAfterCompletion` 전이라 스레드에 묶인 커넥션/EntityManager 리소스다 — `REQUIRED`인 `save()`가 이미 커밋된 트랜잭션에 참여자로 합류해 스스로 커밋하지 않는 것이 실제 메커니즘. **신규 사실** — `AFTER_COMMIT` 리스너의 예외는 호출자에게 전파되지 않는다(`invokeAfterCompletion`이 `Throwable`을 잡아 로그만 남김 → 컨트롤러는 200 OK) |
| 17-bean-circular-dependency.md | 완료 | **3단계 캐시**로 필드 주입 순환이 성립하는 11단계 타임라인 신설 + "왜 굳이 3단계인가"(3차가 팩토리인 이유는 AOP 프록시를 조기 참조 시점에만 앞당겨 만들기 위함). 실제 기동 실패 메시지(`┌─────┐` 사이클 박스) 수록. 리팩터링 4종 before/after + 판단 순서도. **정밀화** — "Boot 2.6부터 기본 금지"는 맞으나 소유 주체가 부정확했다. 프레임워크 코어의 `allowCircularReferences` 기본값은 여전히 `true`이고 부트가 뒤집는 것. 이모지 20건 제거 |
| 19-global-exception-handling-error-response.md | 완료 | 핸들러 선택 3단계 규칙 신설(컨트롤러 로컬 우선 → Advice 순서로 첫 매칭 종료 → 예외 상속 거리 최소) — "순서가 앞선 Advice의 넓은 핸들러가 뒤쪽 구체 핸들러를 통째로 가린다"는 함정을 before/after로. 로그 정책 근거를 계산으로(하루 100만 요청·4xx 2% → error 20,020건 중 조사 대상 20건 = 0.1% → 알람 피로). 공통 `ErrorResponseWriter`를 4곳이 함께 쓰는 통일 방법. Spring 6 `ProblemDetail`/RFC 9457 추가 |
| 21-bean-validation-vs-domain-validation.md | 완료 | `@Valid`/`@Validated` 4행 비교표(그룹은 `@Validated`만, 중첩 cascade는 `@Valid`만). 불변식 정의, `String email` vs `Email` VO before/after. **원문 사실 오류 정정** — "`@RequestParam` 검증은 클래스에 `@Validated`가 필요하고 `ConstraintViolationException`이 난다"는 **스프링 6.1부터 틀리다**. 내장 메서드 검증이 도입돼 `@Validated` 없이도 돌고 `HandlerMethodValidationException`(400)이 난다. 반대로 클래스에 `@Validated`가 붙으면 내장 검증이 꺼지고 AOP로 넘어간다 — 오케스트레이터가 공식 레퍼런스로 재확인. `@ModelAttribute` 실패도 6.1부터 `MethodArgumentNotValidException`(단 `extends BindException`), `ConstraintViolationException`은 `ResponseEntityExceptionHandler` 기본 목록에 없어 빠뜨리면 500이 나간다 |
| 34-scheduled-tasks-threading.md | 완료 | 7KB → 38.2KB. 정산 배치 40분 블록을 시간축 도식으로(토큰 정리 8회·통계 4회 미실행 수치화). `fixedDelay`/`fixedRate`/`cron`을 "끝난 시점 vs 예정 시각" 축으로 도식화. ShedLock 세 속성을 "무엇을 막는가"로 풀고 `lockAtMostFor` 만료 중 미완료 시 두 인스턴스 동시 실행 실패 모드를 타임라인으로. **오케스트레이터 지시 교정** — "예외를 던지면 스케줄 등록이 취소된다"는 스프링 `@Scheduled`에서는 틀리다. `ThreadPoolTaskScheduler`가 `errorHandlingTask(task, true)`로 감싸고 기본 핸들러가 로그 후 삼키므로 다음 회차가 계속 돈다(영구 정지는 순수 JDK `ScheduledExecutorService`의 동작). Java 21 실측으로 `fixedRate` 따라잡기(밀린 5회차가 t=551~553ms에 연달아 실행, 동시 실행은 아님)도 수록 |
| 18-resttemplate-webclient-restclient.md | 완료 | 26KB → 58KB. `.block()`의 스레드 도식으로 "톰캣 스레드는 그대로 묶이고 리액터 스레드만 하나 더 는다"를 보이고 처리량 상한 `200 ÷ 0.2s = 1,000 rps`로 RestTemplate과 동일함을 증명(오케스트레이터 검산 일치). 타임아웃을 연결/읽기/**풀 대기** 세 시계로 구분하고 리틀의 법칙으로 고갈 시점 계산. **사실 정정 2건** — ① "기본 타임아웃은 사실상 무제한"은 부정확(JDK `SimpleClientHttpRequestFactory`·reactor-netty `responseTimeout`은 무한이나 Apache HttpClient 5는 분 단위 기본값이 있다) ② `RestTemplate`은 deprecated가 아니라 유지보수 모드. `ClientHttpRequestFactorySettings` API가 부트 3.4에서 바뀐 점 반영 |
| 20-spring-cache-cacheable.md | 완료 | 세 애너테이션을 "원본 메서드를 실행하는가" 한 축으로 선행 정리. **키 충돌의 핵심 사실 — 키에 클래스도 메서드도 안 들어간다** — 를 세우고 충돌 3종 시연(같은 클래스의 다른 메서드 → 반환 타입이 같으면 예외조차 없음 / 다른 클래스의 같은 이름 → 관리자용 조회가 마스킹 해제 값을 캐시에 올림 / `find(long)`·`find(Long)`은 프록시에 도달할 땐 둘 다 `Long`). `condition`(실행 전) vs `unless`(실행 후)를 타임라인으로 분리하고 `@CachePut`의 `condition`은 실행 후 평가라는 예외 추가. TTL이 없는 이유를 `Cache` SPI 설계로 답함. `sync=true`의 로컬 한계를 "4대면 4번"으로 수치화 |
| 33-custom-argument-resolver-auth-user.md | 완료 | **낡은 참조 정정** — `5장` 2건을 `06-filter-vs-interceptor.md`로, `2장`을 절 번호로 교정(`N장` 형식 잔존 0건). `supportsParameter` 결과가 `MethodParameter` 키로 캐싱되어 **사실상 첫 요청에만 불린다** → 요청 내용에 따라 판정을 바꾸면 "가끔만 동작하는" 버그가 된다는 것을 before/after로. **설계 논점 신설** — 검증을 리졸버에 두면 `@AuthUser` 파라미터가 없는 메서드는 리졸버가 호출조차 안 돼 무인증 통과한다는 구멍을 같은 컨트롤러의 두 메서드로 시연(`GET → 401` / `DELETE → 200`). ThreadLocal 오염 t0~t5 타임라인 |
| 22-external-api-call-inside-transaction.md | 완료 | **시나리오 값 불일치 정정** — 본문은 외부 300ms → 10초로 계산했는데 같은 문서의 관전 포인트("3초")·출제 의도("3초짜리 외부 호출")와 어긋났다. 200ms → 3,000ms 기준으로 전 단계 재계산: W 0.21s → 3.01s, L 10.5개 → 150.5개, 풀 30개 처리 상한 9.97 TPS(초과 40 TPS), 고갈 t=0.6초, 톰캣 포화까지 +4.25초 → **총 약 4.9초**(오케스트레이터 검산 일치). 원문에 없던 시간 축을 전부 신설. 장애 전파 마지막 고리(헬스체크 실패 → 인스턴스 제외 → λ 50→75로 재분배 → 붕괴 가속)를 도식화. 네 가지 실패 조합 표 + 타임아웃을 (A)미도달/(B)처리 중/(C)승인 완료·응답만 유실로 분해. 상태 전이도에 **`UNKNOWN` 신설**(재시도 가능성이 PENDING과 다르다). 이모지 23건 제거 |
| 23-transactional-outbox-pattern.md | 완료 | 같은 주제 문서가 셋(10장·06-12·06-35) 있어 자리 표를 서두에 넣고 "스프링 구현"으로 초점을 좁힘. **2PC 절 신설** — 가용성이 곱으로 떨어짐(99.9%² = 99.8%, 연간 8.76h → 17.51h, 오케스트레이터 검산 일치), Kafka 트랜잭션과 RabbitMQ 채널 트랜잭션은 브로커 내부 원자성이지 XA가 아니라 참여 자격이 없다. DDL을 PostgreSQL로 재작성(`bigserial`/`jsonb`/`timestamptz`, `WHERE processed_at IS NULL` 부분 인덱스). **중요한 함정 신설** — 릴레이를 "마지막 처리 id 이후"(고수위) 기준으로 만들면 이벤트를 건너뛴다(시퀀스는 INSERT 시점에 할당되나 커밋 순서는 다를 수 있다). CDC를 MySQL binlog → PostgreSQL WAL 논리 디코딩으로 교체. 폴링 릴레이를 CTE + `FOR UPDATE SKIP LOCKED`로, **선점(트랜잭션 안)/발행(트랜잭션 밖)** 분리해 22번 원칙과 충돌 제거(원문 코드는 트랜잭션 안에서 발행했다). RabbitMQ `ConfirmType.CORRELATED` 경로 신설 |
| 24-transaction-synchronization-connection-binding.md | 완료 | 8.2KB → 43.6KB. `ThreadLocal`을 그 자리에서 정의(값은 `Thread`의 `ThreadLocalMap`에 있고 `ThreadLocal`은 키다)하고 "동기화"라는 이름의 오해까지 풀었다. `dataSource.getConnection()` 직접 호출 함정을 before/after로 — 방금 쓴 값이 안 보임, 커넥션 2개 점유 → 자기 교착, 같은 스레드가 만든 두 트랜잭션의 락 대기는 **데드락 탐지에도 안 걸린다**. 두 스레드의 ThreadLocalMap을 나란히 그린 도식으로 `@Async` 미전파 설명. `registerSynchronization` 콜백 순서 도식 신설 — **언바인딩이 콜백 이후**라는 사실이 `afterCommit`의 JPA 쓰기가 사라지는 이유의 구조적 근거(16번과 정합). **잘못된 링크 정정** — "Outbox는 `16-spring-event-...md` 참고"가 엉뚱한 파일을 가리켜 `23-transactional-outbox-pattern.md`로 수정 |
| 25-thread-pool-connection-pool-sizing.md | 완료 | Little's law를 식보다 직관 먼저(초당 10명 × 3초 = 30명), 단위 환산을 "실제 시간 1초마다 스레드-시간 50초어치"로 전개. 여유 계수를 **c = L/ρ**로 유도(ρ=0.7 → 1.43배, ρ=0.8 → 1.25배 — 흔히 쓰는 "×1.5"의 정체는 ρ≈0.67). 병목 연쇄 절 신설 — 톰캣 200 + Hikari 10 = 200 TPS 천장, 인스턴스 수 × 풀 크기 vs PostgreSQL `max_connections` 100. HikariCP 공식의 `core_count`가 **DB 서버 코어**임을 별도 강조. **사실 오류 정정** — 원문(27번 포함)의 "DB 대기 중 스레드는 BLOCKED"는 틀렸다. 자바의 `Thread.State.BLOCKED`는 `synchronized` 락 경쟁만 뜻하고 소켓 대기는 `RUNNABLE`로 보인다(장애 중 오진을 부르는 지점). 원문 예제 수치(500 TPS → 톰캣 50 / Hikari 25, CPU 상한 4×1000/8 = 500)는 검산 결과 전부 맞아 유지 |
| 26-hikaricp-connection-pool-exhaustion.md | 완료 | 6.8KB → 52KB. 표 안에 갇혀 있던 설명을 `###`로 펴고, 고갈의 물리를 `L = λW > c` 하나로 통일해 "원인이 왜 넷뿐인가"를 유도. 예외 로그의 `(total=10, active=10, idle=0, waiting=27)` 괄호 읽는 법 신설. 오래 점유 vs 미반환을 **시계열 그래프 도식 2장**으로 분리. DB 어휘를 PostgreSQL로 전면 정리(`pg_stat_activity` state별 집계, `state_change` 기준 `idle in transaction` 탐지, `pg_blocking_pids()` 역추적, `idle_in_transaction_session_timeout`). **처방 절 신설**(원문은 진단만 하고 끝났다) — 풀 확대가 오답인 이유를 계산으로: W가 50ms→3초면 500 TPS에 커넥션 1,500개 필요(`max_connections` 기본 100). `leakDetectionThreshold` 비용을 "오버헤드 0"이 아니라 "대여마다 예외 객체 1개 + 스케줄 태스크 1개"로 정확히 |
| 27-webflux-vs-mvc-threading-model.md | 완료 | `## 1.`을 전제 지식 절로 신설 — 블로킹 `read`가 커널 대기 큐에서 스레드를 재우는 그림 → 논블로킹 단독은 폴링이라 더 나쁨 → `epoll`이 준비된 것만 돌려줌 → 이벤트 루프 뼈대 코드. **"CPU를 놓아준 것과 스레드를 놓아준 것은 다르다"**를 문서 전체의 축으로. **핵심 수치 신설(검산 완료)** — 50ms 블로킹 감당량이 이벤트 루프 4개 = 80 TPS vs 톰캣 200스레드 = 4,000 TPS로 **50배** 차이라, "이점이 사라진다"가 아니라 "80 TPS만 흘러도 선다"로 격상. 우회로 `boundedElastic`(40) = 800 TPS라 **MVC보다 5배 좁다**는 대비 추가. **오케스트레이터 지시 교정** — 블로킹 소스 격리는 `publishOn`이 아니라 `subscribeOn`이어야 맞다(원문이 옳았다). **깨진 링크 수정** — `17-parallelstream-pitfalls.md`가 02-spring을 가리키고 있어 `01-java-kotlin/`으로 |
| 31-spring-security-filter-chain-authentication.md | 완료 | 7.9KB → 54KB. 인증("누구인가")과 인가("이걸 해도 되는가")를 먼저 깔고 그것이 그대로 필터 배치가 된다는 인과를 세움. 3층의 존재 이유를 각각 밝힘 — `DelegatingFilterProxy`는 "컨테이너가 만드는 필터가 스프링 빈을 못 쓴다"는 간극의 다리, `FilterChainProxy`는 "경로마다 인증 방식이 다른 것이 정상"이라 체인을 고르는 물건. "첫 체인 하나만 실행"을 본문으로 올려 `/api/**`가 `/api/admin/**`를 가려 관리자 API가 열리는 사고를 before/after로. **원문 보강** — `SecurityContextHolderFilter`는 **6.0부터 자동 저장을 하지 않는다**(`saveContext` 명시 호출 필요). 5.x→6.x 마이그레이션에서 인증이 다음 요청에 사라지는 회귀의 원인인데 원문에 없었다. 6의 `AuthorizationFilter`가 ERROR 디스패치에서도 인가를 재수행해 401 대신 403이 나가는 함정도 신설. 커스텀 필터 예외가 `ExceptionTranslationFilter`를 못 만나고 톰캣 `/error`로 새는 함정 추가. 오케스트레이터가 `DEFAULT_FILTER_ORDER = -100`을 바이트코드로 확인 |
| 35-ai-code-transaction-review-checklist.md | 완료 | 각 항목을 **찾는 대상(ripgrep 명령까지) → AI 결함 코드 → 고침 → 테스트가 못 잡는 이유** 4단으로 재편. **가장 중요한 신설** — `@Transactional` 롤백 테스트가 4항목을 전부 덮는다는 것을 "테스트가 물리 트랜잭션을 먼저 열면 서비스 선언은 합류가 된다"는 한 원인으로 통합 설명(자기 호출은 `isActualTransactionActive()`가 `true`로 나오고, `UnexpectedRollbackException`은 커밋 시도가 없어 발생 불가, `readOnly=true`는 합류하며 무시). 자동화 가능(ArchUnit, 테스트 프로파일 `ClientHttpRequestInterceptor`로 트랜잭션 안 외부 호출 런타임 탐지) vs 사람 판단 분리. 07·11번의 신규 사실 반영 — 6.2 `rollbackOn = ALL_EXCEPTIONS`가 켜져 있으면 항목별 `rollbackFor` 점검이 프로젝트 설정 확인 한 번으로 대체된다는 절차 변화, OSIV로 변경 감지 UPDATE가 증발하면 부분 커밋조차 안 남아 대사 배치로도 못 잡는다는 대비. 이모지 17건 제거 |
| 28-graceful-shutdown-zero-downtime-deploy.md | 완료 | 경로 A(kubelet→SIGTERM)와 경로 B(EndpointSlice→kube-proxy→인그레스→LB)가 갈리는 **초 단위 타임라인 도식** 신설 — t=0.06s~6.0s 사이 약 3,000건 실패까지 계산. preStop sleep을 "정리 시간이 아니라 멀쩡한 채 기다려주는 시간"으로 명확화(sleep 유/무 대비). 시간 예산을 기본값 그대로 뒀을 때 SIGKILL이 먼저 오는 과정까지 계산. **사실 정정(중요)** — 원문의 "기본값은 `immediate`"는 **부트 3.4부터 틀리다**(3.4 릴리스 노트가 graceful shutdown 기본 활성화를 명시, 3.3 이하는 `immediate`). 오케스트레이터가 릴리스 노트로 재확인. 쿠버네티스 문서 검증 2건 추가 — 유예 기간 카운트다운은 preStop **실행 전에** 시작되고(preStop 시간이 예산에서 차감됨), 초과 시 2초 일회성 연장 뒤 SIGKILL. 이모지 18건 제거 |
| 30-actuator-endpoints-security.md | 완료 | 넓게 터진 표를 엔드포인트 + 한 줄 용도만 남기고 `###`로 폄. **활성화(enabled)와 노출(exposure) 구분**을 선행. `/heapdump` 위험을 5단계 공격 시나리오(스캐너 → 300MB 다운로드 → 문자열 검색 → 세션 토큰 → 인증 우회)로 — "애플리케이션 취약점이 하나도 필요 없다". `/actuator/loggers`가 POST 쓰기 엔드포인트임을 별도로 세움. **사실 정정(중요)** — "부트가 `password`/`secret` 류를 마스킹하지만 규약 밖 키는 노출"은 **부트 2.x 이야기다**. 3.0부터 `/env`·`/configprops`는 `show-values` 기본 `never`로 값 전부 마스킹이고, 3.x에서 남는 위험은 값이 아니라 프로퍼티 이름·소스 구조가 새는 정찰 정보다. **함정 2건 신설** — ① `management.server.port` 분리 시 관리 포트가 자식 컨텍스트라 메인 시큐리티 필터 체인이 자동 적용되지 않는다 ② `ManagementWebSecurityAutoConfiguration`은 `@ConditionalOnDefaultWebSecurity`라 **내 `SecurityFilterChain`을 하나라도 정의하면 물러난다** — 실무 앱 대부분에서 "시큐리티 붙였으니 actuator는 보호됨"이 거짓. 섹션 순서 뒤집힘(꼬리질문 뒤에 `## 5.`) 정상화 |
| 32-slow-application-startup-diagnosis.md | 완료 | 7.5KB → 50.7KB. 운영 맥락을 계산으로 선행(10파드 × 30초 = 5분 vs 90초 = 15분, 롤백도 같은 시간, **startupProbe 예산 초과 시 무한 재시작 루프**). 진단을 3층(로그 → `/actuator/startup` → 스레드 덤프)으로 세우고 `ApplicationStartup`을 스레드 덤프 **앞자리**로 승격(원문은 얇게만 언급). GET(스냅샷) vs POST(드레인) 구분 추가. 기동 중 스레드 덤프 뜨는 법을 급할 때 쓰는 순서로 구체화(`kill -3` → stdout → `kubectl logs` 회수 / jdk 베이스 이미지 / `jattach` / `kubectl debug --target`). **통념 정정** — HikariCP는 기동 시 `minimumIdle`만큼 미리 만들지 않는다. `checkFailFast`가 동기적으로 **1개만** 만들고 나머지는 하우스키퍼가 비동기로 채운다(기동을 붙잡는 것은 개수가 아니라 첫 한 개의 확보 시간). `initialSize`만큼 미리 만드는 것은 Tomcat JDBC/DBCP2 쪽 이야기 |

### 02-spring 마감 검증

35건 전부 `verify.pl [OK]` / `cmp.py 0 diff`. 이모지 0건, 섹션 전부 `## 0.`~`## 4.` + `## 한 줄 요약`, 하드랩 전부 해제.
마크다운 링크 57건과 백틱 파일 참조 149건 전부 실재 확인(깨진 링크 0건). `04-rdb-sql` 참조 0건.

에이전트가 원문에서 잡아 고친 사실 오류가 누적 20여 건이고, 그중 **오케스트레이터 지시가 틀렸던 것이 5건**이다
(`@Transactional` public 한정 / `spring.profiles` 조용한 무시 / `@Scheduled` 예외 시 스케줄 취소 / 블로킹 소스 격리 `publishOn` / 이모지 집계).
버전 의존 사실은 스프링 프레임워크 6.x·부트 3.x 기준임을 각 문서에 명시했다.

### 다음 세션 인수인계

남은 것은 **03-jpa-orm 27건과 04-rdb-sql 35건**이다. (이 문단은 04-rdb-sql이 비어 있다고 적고 있었으나 사실이 아니다 —
`8deef26`의 삭제가 `f1b2a4f`로 revert되어 35건이 그대로 있다. 2026-09-02 정정.)
두 장 모두 평균 48~58KB로 이미 깊이가 있으므로 "전면 재작성"이 아니라
**설명 방식 조정 + 하드랩 해제 + 섹션 0~4 재편** 위주다.
02-spring의 트랜잭션 문서들(07·11·12·13·22·24)이 JPA 내용을 상당히 참조하므로 상호 링크를 맞춰야 한다.


## 03-jpa-orm (27/27) — 완료

### 착수 전 기계 진단 (2026-09-02)

프롬프트 문서의 표는 이 장을 "하드랩" 상태로 적고 있었으나 실측은 다르다. **27건 중 하드랩이 남은 것은 16건**이고
11·14·15·16·17·20·22·24·25·26·27은 이미 풀려 있었다. 반면 **섹션 구조는 27건 전부가 규약 위반**으로,
본문이 `## 5.`~`## 11.`까지 뻗어 있었다(최다: 27번 11개, 22·23·24·25번 10개). 이모지·픽토그램은 22건에 잔존(최다: 11번 36개).

즉 이 장의 실제 과제는 하드랩이 아니라 **본문 섹션을 셋으로 묶어 `### N-M.` 소절로 내리는 재편**이다.
06-messaging RabbitMQ 12건에서 쓴 것과 같은 방법을 적용한다.

### 파일별 현황

| 파일 | 상태 | 비고 |
|---|---|---|
| 01-jpa-vs-mybatis.md | 완료 | 20KB → 40KB. 영속성 컨텍스트 네 기능을 각각 한 소절로 풀고 소절마다 "MyBatis에서라면" 대비를 붙여 대비 축 유지. 내부 동작은 02번에 위임. Dialect·VO·CQRS·쓰기 지연·임피던스 불일치 등 정의 신설. **`---` 구분선 누락 보정** |
| 02-persistence-context-dirty-checking.md | 완료 | 45KB → 58KB. `em.find()` 한 줄이 1차 캐시 등록 + 스냅샷 복사로 갈라지는 과정을 도식화하고 **"왜 사본을 두는가"**(자바에 변경 통보 장치가 없어 감지 방법이 원리적으로 셋뿐)에 답함. flush vs commit을 첫 등장 자리에서 타임라인으로 못 박음. **산술 오류 정정** — 배치 누적 비교량이 125만이 아니라 **1,275,000건**(flush 1회 평균 25,500건). 검산 완료. "메모리 2배"도 정밀화(불변 타입은 참조만 복사, `Object[20]` = 96바이트 근거) |
| 03-eager-vs-lazy-fetch-strategy.md | 완료 | 40KB → 45KB. **"JPQL은 EAGER를 무시한다"를 관찰이 아니라 근본 이유로 재서술** — 번역 단계에서 EAGER를 몰래 반영하면 컬렉션 조인으로 행이 곱셈으로 늘어 `count`·`limit`·`distinct`가 개발자 의도와 달라지므로, "작성한 대로 번역한다"는 계약이고 EAGER는 번역 후 보조 SELECT로 지킬 수밖에 없다. `@OneToOne` 비주인 측 LAZY 불가도 "프록시를 넣어도 null을 넣어도 둘 다 틀리다"는 인과로. 원문 오타 `locker.locker` 제거 |
| 04-n-plus-one-detection-and-fixes.md | 완료 | 65KB → 85KB. N의 정체를 **주문 1,000건 고정 + 회원 수만 1↔100으로 바꾸는 통제 비교**로 실증(`1+1` vs `1+100`). `em.clear()` 유무 두 벌로 거짓 통과 실증. 조인 6행 표에 `limit 2`를 그어 "개수 부족이 아니라 데이터가 틀린다"를 시각화. 탐지 장치 3종을 import 포함 완전 코드로 승격하고 각각 **"이 장치가 못 잡는 것"** 소절 추가. 쿼리 수 계산 전부 검산 — 원문대로 정확 |
| 05-merge-vs-dirty-checking.md | 완료 | 20KB → 31KB. 네 상태 전이 다이어그램 신설(각 전이에 `persist`·조회·`merge`·`detach`·`clear`·`close`·`remove`·트랜잭션 종료를 화살표로). **준영속이 생기는 세 경로**를 신설해 상태 나열에 그치지 않게 함. null 덮어쓰기를 실행 전/후 DB 행 비교 표로 실증. "변경 감지에는 스냅샷이라는 기준선이 있고 merge에는 없다"를 문서 전체 축으로 |
| 06-association-owner-and-mappedby.md | 완료 | 18KB → 30KB. **객체 그래프와 테이블 스키마를 좌우로 놓은 다이어그램**으로 "참조 2개 vs 컬럼 1개" 비대칭을 시각화. 주인 아닌 쪽에 넣었을 때를 **SELECT 2건 + UPDATE 0건 로그**로 실증하고 진단 관점을 "잘못 나간 쿼리"가 아니라 **"안 나간 쿼리"**로 전환. 1차 캐시 증상은 메모리/DB 두 열 t1~t6 표로 |
| 07-lazy-initialization-exception.md | 완료 | 18KB → 36KB. 트랜잭션·EntityManager·프록시 초기화를 한 시간축에 놓고 OSIV 끔/켬 두 벌 타임라인으로 그림 — 차이가 t4 한 칸뿐이고 켠 쪽은 **트랜잭션이 닫힌 뒤에도 지연 로딩이 성공**한다는 것이 "트랜잭션이 끝나서"가 틀린 이유. **예외 메시지 정정** — 단일 값 프록시는 `Could not initialize proxy [...] - no session`(대문자 C·소문자 s), 컬렉션은 `could not initialize proxy - no Session`(소문자 c·대문자 S)로 **대소문자가 다르다**. Hibernate 6.6.53 소스로 오케스트레이터가 직접 재확인함. 로그 알람을 `no Session` 문자열로 걸면 절반을 놓친다는 실무 귀결까지 |
| 08-fetch-join-pagination-in-memory.md | 완료 | 33KB → 42KB. 회원 2명 × 주문 3건 → 조인 6행 → `LIMIT 2` 결과를 순서대로 표로 놓고 **"`LIMIT`은 행만 셀 수 있고 부모 단위 N건을 세는 문법이 SQL에 없다"**를 못 박음. Hibernate가 (A) LIMIT 붙이고 틀린 결과 / (B) 전량 로딩 중 (B)를 고른 선택지 표로 인과 연결. `HHH90003004` 경고를 세 토막으로 해부. batch fetch의 `IN`은 조인이 아니라 필터라 행이 안 늘어 `limit`이 의미를 되찾는다는 설명 |
| 09-osiv-tradeoff-and-migration.md | 완료 | 46KB → 54KB. 요청을 진입/서비스(DB 20ms)/렌더링(DB 0건, 200ms)/응답으로 쪼개 OSIV on·off 두 줄 타임라인으로 **"놀고 있는 커넥션"** 구간을 시각화. **정량 신설** — 풀 10개에서 500 req/s → 45 req/s(11배 하락), 100 req/s면 커넥션 22개 필요. 오케스트레이터 검산 완료. 커넥션 풀이 왜 유한 자원인지를 계산 앞에 전제로 깔음 |
| 10-optimistic-vs-pessimistic-lock.md | 완료 | 50KB → 58KB. **lost update를 락보다 먼저** t1~t5 타임라인으로 신설하고, 격리 수준으로는 안 막힌다는 점과 대책이 사전 차단 vs 사후 감지 두 갈래뿐임을 보인 뒤에 락 이름이 등장하게 순서를 바꿈. 재시도가 영원히 실패하는 이유를 1차 캐시(동일성 보장으로 두 번째 `findById`가 DB에 안 감) + rollback-only 두 겹으로 설명하고 회차별 다이어그램 추가. **사실 오류 정정** — "`@Version`을 떼면 최종 재고가 100보다 훨씬 크게 남는다"는 성립 불가(초기 100에서 차감만 하므로 100을 넘을 수 없다). "0이 아니라 한참 큰 값으로 남는다"로 수정. 픽토그램 22건 제거 |

### 오케스트레이터 검증 방식

에이전트 보고를 그대로 믿지 않고 매 배치마다 직접 확인한다.

- `scratchpad/audit.py` — 하드랩 잔존 수, 픽토그램 수, 산문 최대 줄폭, `## ` 섹션 번호 목록, 관전 포인트·한 줄 요약 존재 여부
- `scratchpad/cmp0.py` — `git show HEAD:<path>`의 질문·출제 의도 **문단 전체**를 공백 정규화해 대조.
  (라인 단위 grep으로 비교하면 하드랩된 원문의 둘째 줄이 안 잡혀 거짓 차이가 난다 — 문단 단위로 볼 것.)
- 수치·계산은 `python3 -c`로 직접 검산
- 예외 메시지·API 동작은 로컬 Hibernate 6.6.53.Final 소스 jar에 직접 대조
  (`~/.gradle/caches/modules-2/files-2.1/org.hibernate.orm/hibernate-core/6.6.53.Final/*/hibernate-core-6.6.53.Final-sources.jar`)

### 부수 정리

비표준 코드펜스 ` ```flow `를 ` ```text ` 박스드로잉으로 전환 중이다(02·03·04 완료, 17·21 진행 중).

### 11~27번 현황 (요약)

| 파일 | 비고 |
|---|---|
| 11 | flushAutomatically(반영)/clearAutomatically(폐기)를 한 타임라인에. 픽토그램 36건 제거 |
| 12 | opt-out/opt-in 정의 신설 + password_hash 추가 PR의 응답 JSON before/after. OSIV "조용한 실패"를 SQL 로그 대비로 |
| 13 | Q타입 생성 파이프라인을 전제로. 통(가변) vs 값(불변)을 합성·재사용·단위테스트 세 코드로. null 비대칭 3행 표 |
| 14 | check-then-act의 틈을 두 스레드 타임라인으로. **정정** — JPA 경로에서 `DuplicateKeyException`은 안 잡힌다(`HibernateJpaDialect`가 `DataIntegrityViolationException`으로만 변환, `jdbcExceptionTranslator` 기본 null). spring-orm 6.2.19 소스 대조 |
| 15 | query space를 역방향 논증으로 정의. **정정** — `ActionQueue.OrderedActions`는 7단계가 아니라 **9단계**(맨 앞 `OrphanCollectionRemoveAction`, UPDATE 뒤 `QueuedOperationCollectionAction` 누락) |
| 16 | 예외 두 갈래를 세션 생존 여부 판정 흐름도로. **정정 2건** — 프록시 클래스명은 6.x에서 `<타입명>$HibernateProxy` 고정 접미사(5.x 난수형 아님), `canBeDeletedWithoutLoading()` 조건은 7개가 아니라 **8개**(`!implementsLifecycle()` 누락) |
| 17 | 세 전략 테이블 그림 3장. 자식 15종이 "조인 비용"이 아니라 옵티마이저 문제로 성질이 바뀌는 인과(16! = 20,922,789,888,000, `geqo_threshold` 12) |
| 18 | readOnly로 없어지는 것 2 / 남는 것 3을 근거 열이 붙은 표로. 1층 비용 수치화(643KB 중 2.7KB 유효, 하루 2.59TB vs 10.9GB) — 오케스트레이터 검산 완료 |
| 19 | "성능이 아니라 계약" 축을 논증으로. **정정 3건** — `in_clause_parameter_padding`은 1~1000에서 10종이 아니라 **11종**, MySQL `max_allowed_packet`(기본 64MB)에는 10만 건이 안 걸린다, Oracle in-list 상한은 23부터 65,535. 추가 확인 — `PostgreSQLDialect`는 `getInExpressionCountLimit()`을 재정의하지 않아 0(무제한) |
| 20 | 임계 구간을 lost update에서 유도해 정의. 분산 락이 뚫리는 세 경로를 각각 타임라인으로. 픽토그램 17건 제거 |
| 21 | IDENTITY 무력화 4단계 도식. "켰는데 왜 안 묶이나" 8행 체크리스트. **정정** — `hibernate.jdbc.batch_versioned_data`는 6.x 기본값이 이미 `true`(`SessionFactoryOptionsBuilder:540`). MySQL `rewriteBatchedStatements` 중심 서술을 PostgreSQL(pgjdbc 파이프라이닝, `reWriteBatchedInserts`)로 재정렬 |
| 22 | 네 경계가 왜 같은 선인지를 세 물리적 사실로. 락 점유 타임라인. **정정** — `AFTER_COMMIT`에서 `REQUIRED`는 "애매해서"가 아니라 이미 끝난 트랜잭션에 **확실히 참여해 변경이 버려진다**. PostgreSQL 데드락은 `40P01` → `LockAcquisitionException`(`PostgreSQLDialect:1084`) |
| 23 | `LazyConnectionDataSourceProxy` 함정을 커넥션 획득 시점 타임라인으로. 복제 지연을 `pg_stat_replication`의 3구간(write/flush/replay)으로. **정정** — 동기 복제 답변이 PostgreSQL에서는 틀렸다(`synchronous_commit = remote_apply`는 재생까지 기다려 실제로 보인다) |
| 24 | 방아쇠 개수 차이 6행 표. JPA cascade vs DB `ON DELETE CASCADE` 세 축 대비. **정정** — orphan deletion 예외 문구가 5 이전 것이었다(6.x는 `A collection with orphan deletion was no longer referenced...`), `@Where`는 6.3부터 deprecated |
| 25 | HashSet 버킷을 t1/t2/t3 세 시점 도식으로. **정정 4건** — 프록시 이름(6.x), "상수 hashCode라 프록시가 초기화 안 된다"는 서술이 틀림(`BasicLazyInitializer.invoke()`는 `!overridesEquals`일 때만 가로챈다), **문서의 테스트 코드 2건이 실제로는 아무것도 검증하지 못하고 있었다**(`findById`가 기존 프록시를 그대로 돌려줘 자기 자신과 비교) |
| 26 | `NULL`의 유니크 통과 성질을 전제로 분리하고 부분 유니크 인덱스를 기본 해법으로 승격. PG 15+ `nulls not distinct` 추가. **정정** — 삭제 행은 죽은 튜플이 아니라 살아 있는 행이라 VACUUM으로 회수되지 않는다. `@Filter`의 `autoEnabled`·`applyToLoadByKey` 현행화 |
| 27 | 콜백 발화 8단계와 벌크 경로의 건너뜀을 겹쳐 그림. **정정** — `AuditorAware`가 비면 `updatedBy`가 `null`이 되는 게 아니라 **직전 값이 남는다**(`touchAuditor`는 조기 리턴, `touchDate`는 아님) — 행이 엉뚱한 사람을 지목한다 |

### 03-jpa-orm 마감

27건 전부 `## ` 헤딩 6개, 질문·출제 의도 원문 일치, 이모지 0건, 하드랩 0건.
비표준 ` ```flow ` 펜스는 전부 ` ```text `로 전환했다(잔존 0건).
소스 대조로 잡은 사실 오류가 **누적 20여 건**이고, 오케스트레이터가 Hibernate 6.6.53 / spring-orm 6.2.19 /
spring-data-commons 3.5.12 소스와 산술로 **전건 재확인**했다. 확인 못 한 것은 MySQL 중복 키 메시지 형식 1건뿐이다
(로컬에 MySQL이 없다. 이 저장소 기준 DB가 아니라 영향은 작다).

## 04-rdb-sql (35/35) — 완료

### 착수 전 기계 진단 (2026-09-02)

- **35건 전부 하드랩**(산문 최대 줄폭 100~170), 32건에 픽토그램 잔존
- 섹션 구조는 **8건(03·04·05·06·07·18·23·30)이 이미 규약을 지키고** 있고 나머지 27건이 `## 5.`~`## 11.`까지 뻗어 있다(최다: 32번 11개)
- 이 장은 자체 3분할 관례가 있다 — `## 1. 개념/구조` → `## 2. 동작·설계·판별` → `## 3. 실무 사례·안전망`.
  03장처럼 임의로 묶지 않고 이 관례에 맞춘다.
- PostgreSQL 기준(`ae54d88`)을 되돌리지 않는지를 각 배치의 자가 점검 항목에 명시적으로 넣는다.

### 파일별 현황

| 파일 | 상태 | 비고 |
|---|---|---|
| 05-transaction-acid.md | 완료 | 29KB → 41KB. 메커니즘 네 개를 이름이 아니라 동작으로(롤백은 되돌리기가 아니라 새 버전 버리기 + `pg_xact` 판정, WAL이 빠르면서 안전한 이유). 이체 T1/T2를 t0~t6 타임라인에 놓고 A·I·D·C 개입 지점 표시. 3절을 "DB가 강제 가능/불가능"으로 갈라 전체 DDL과 "제약이 없으면 생기는 깨진 상태" 표 |
| 06-join-types-and-execution.md | 완료 | 30KB → 39KB. 자바 의사코드 / EXPLAIN 노드 / 비용의 모양 / 필요한 것 4열 대응표. 선택 기준을 비용 공식과 손익분기로(`N×c` vs `S`, 2.5만~4.5만 행). LEFT JOIN이 WHERE로 INNER가 되는 것을 3행 미니 데이터의 TRUE/UNKNOWN/FALSE 판정표로 |
| 07-where-vs-having.md | 완료 | 18KB → 27KB. 6단계 실행 순서 도식에서 세 귀결(집계 불가·별칭 불가·ORDER BY는 가능)을 각각 에러 메시지와 함께 유도. 부서 3개·5행으로 단계마다 표 추적. GROUP BY가 `HashAggregate`/`GroupAggregate`라 비용이 입력 행 수에 달렸다는 사슬 |

### 완료 파일 (01~24 + transaction-isolation-levels)

| 파일 | 비고 |
|---|---|
| 01-index-and-bplus-tree.md | 팬아웃 계산을 처음부터(8,152B ÷ 20B = 407 → 보수적으로 300 → 3층 2,700만 행). 조회당 페이지 4장 대 Seq Scan 28.6만 장 = 약 7만 배. B-Tree vs B+Tree가 사는 것 둘을 각각 그림으로(내부 노드 팬아웃 40 대 400 / 범위 스캔 옆으로 훑기) |
| 02-index-not-used-full-scan.md | 다섯 원인이 한 문장의 변형임을 되짚는 절 신설. **부류 A(못 탄다) / B(안 탄다) 대조표** — 선택도 90%면 인덱스 경로가 108배 패배, 1%면 3.4배 승리 |
| 03-clustered-vs-secondary-index.md | 클러스터드 있는 구조와 힙 구조를 나란히 그린 뒤 "전부 세컨더리"로. `ctid`를 핵심 어휘로 승격 + HOT으로 인덱스 유지 비용 연결. UUID PK 반박을 MySQL(행 물리 정렬)과 PostgreSQL(B-tree 삽입 지역성·워킹셋·WAL FPI)로 분리 |
| 04-normalization-vs-denormalization.md | 수정/삽입/삭제 이상을 4행 실제 데이터로. 정규형을 "이 단계가 막는 이상"으로만 서술. 핫 로우 사슬을 동시성 축과 저장 축 둘로 |
| 05-transaction-acid.md | 롤백은 되돌리기가 아니라 새 버전 버리기 + `pg_xact` 판정. 이체 T1/T2를 t0~t6 타임라인에 놓고 A·I·D·C 개입 지점 표시 |
| 06-join-types-and-execution.md | 자바 의사코드 / EXPLAIN 노드 / 비용의 모양 4열 대응표. 손익분기 `N×c` vs `S`(2.5만~4.5만 행). LEFT JOIN이 WHERE로 INNER가 되는 것을 TRUE/UNKNOWN/FALSE 판정표로. **정정** — Hash Join 총비용 내부 산술 1.2 어긋남 |
| 07-where-vs-having.md | 6단계 실행 순서에서 세 귀결(집계 불가·별칭 불가·ORDER BY는 가능)을 각각 에러 메시지와 함께 유도 |
| 08-composite-index-column-order.md | 리프를 11행 목록으로 펼치고 구간을 그어 "범위 뒤는 못 거른다" 실증. BitmapAnd 우회와 부분 인덱스. **정정** — `shared hit=42`는 3,000행 Index Scan에서 불가능(힙 접근만 3,000회) → 4,203 대 3,015. "순서 틀리면 100배"는 인덱스 페이지 기준이고 총 버퍼로는 1.4배 |
| 09-covering-index.md | 인덱스 스캔 2단계를 그림으로 먼저. visibility map을 독립 소절로. "취약"을 EXPLAIN 전후로 — `Heap Fetches` 줄이 값 0이 아니라 **아예 사라진다** |
| 10-explain-and-slow-query-process.md | 계획 트리를 안쪽부터 읽는 법을 실제 출력에 번호를 달아. 오추정 연쇄를 계획 두 벌로(추정 1,000행 → NL 선택 → 실제 50만 행이면 21배 패배). `BUFFERS`로 I/O 병목과 CPU 병목 가르기 |
| 11-mvcc-postgresql.md | MVCC가 없는 세계를 먼저 그리고 도입. UPDATE 한 번의 힙 페이지 before/after. 긴 트랜잭션이 VACUUM을 막는 이유를 `xmin horizon` 도식으로 |
| 12-gap-lock-next-key-lock-deadlock.md | 갭 락·넥스트 키 락이 무엇인지를 먼저 깔고 "PG에는 없다"로 순서를 뒤집음. SSI 사후 감지와 `40001` 재시도 코드 |
| 13-deep-pagination-offset-vs-cursor.md | 복합 키 비교를 5행 데이터로 실증(누락 / 중복 / 정답). **오케스트레이터 지시 정정** — `OFFSET`이 버린 행은 `Rows Removed by Filter`에 안 잡힌다 |
| 14-online-ddl-zero-downtime-schema-change.md | 락 큐 2단 전달을 세션 3개 타임라인으로 — "위험한 것은 실행 시간이 아니라 대기 시간". 재작성 여부를 "저장된 행의 바이트 배치를 바꿔야 하는가"로 원리화. 번호 없는 h2 강등 |
| 15-connection-count-vs-throughput.md | 처리량 곡선과 p99 곡선을 나란히 — "정점 이후엔 교환조차 없다". 네 사슬에 "왜 커넥션 수에 비례하나" 열(락 충돌 쌍 `n(n-1)/2`라 동시성 2배면 약 4배). **정정** — "8코어 → 20 전후"는 식과 안 맞는다(`(8×2)+1 = 17`), 문서 내부 모순(17 대 120)도 해소 |
| 16-long-transaction-harm-and-shortening.md | "길다"를 자원으로 정의하고 "언제 놓아주나" 열로 다섯 기법의 근거 연결. `transaction_timeout`은 PostgreSQL 17로 버전 명시 |
| 17-total-count-cost-and-alternatives.md | "어떤 인덱스도 개수를 미리 알고 있지 않다"는 따름정리(리프에 `xmin`/`xmax`가 없다). `Page` 2쿼리 / `Slice` 1쿼리를 실제 SQL 로그로. **정정** — Before 계획의 "힙 페이지 수십만 장"을 Buffers(41만 장)와 정합화 |
| 18-json-column-tradeoffs.md | 반납 목록을 "공짜로 오는 것 / 없음 / 없으면 나는 사고" 3열 표로. 통계를 독립 소절로 — 추정이 60배 빗나가면 조인 방식이 뒤집힌다. 표현식 인덱스의 식 일치 함정(타는 조건 1개 / 안 타는 조건 4개). 스키마 진화 = 마이그레이션이 읽는 쪽 분기로 옮겨간 것 |
| 19-select-for-update-lock-scope.md | 행 락 4종을 두 축으로 유도하고 충돌 행렬을 빈칸 없이. `synchronize_seqscans` 때문에 세션마다 스캔 시작점이 달라져 락 순서가 어긋난다는 PG 고유 사슬. **정정** — `LockRows`의 startup은 Seq Scan과 같아야 한다(통과 노드), 비용도 29786.01 → 29784.01. **출제 의도에서 `(§5 경험 대조)` → `(§4 경험 대조)` 한 곳 변경** — 재편으로 옛 §5가 §4가 되어 같은 대상을 계속 가리키기 위한 갱신. 규칙에서 벗어난 유일한 변경이니 되돌리려면 이 한 글자만 고치면 된다 |
| 20-like-wildcard-fulltext-search-engine.md | `pg_trgm`의 전환을 실제 절단 과정으로(패딩 → 길이 3 창 → 7조각). 층위 ④에서 처음으로 색인이 DB 밖에 산다는 점을 대가 목록 앞에. **제거** — 한글 `show_trgm` 출력 예시(멀티바이트 트라이그램은 내부 압축되어 단정 불가). **미확인**: 한글 `show_trgm` 실제 반환 형태는 실행 환경에서 확인할 값이 있다 |
| 21-dashboard-stats-oltp-olap-separation.md | OLTP/OLAP 정의 + 캐시 오염 도식(전부 적중 0.4ms → 랜덤 읽기 8ms). 사다리 각 단에 "얻는 것 / 못 막는 것 / 비용 / 올라갈 신호" 4칸 표. MV의 `CONCURRENTLY`가 유니크 인덱스를 요구하는 이유. **정정** — EXPLAIN 예시가 문서 자신의 `work_mem 4MB` 전제와 모순(Sort Disk 1.6GB → 20MB, Parallel Hash 버킷 4194304개는 포인터 배열만 32MB로 24MB 예산 초과) |
| 22-db-cpu-spike-without-deployment.md | "우리가 안 바꿨다 ≠ 아무것도 안 바뀌었다"로 일곱 방향이 전부 팀 통제 밖임을 명시. 사슬을 "변한 것 → 늘어난 일 → 그 일이 쓰는 자원" 3마디로. 안전망을 "사후에 되살릴 수 있나"로 채점해 `auto_explain` 1순위 |
| 23-high-frequency-counter-hot-row.md | 처리량 상한을 `1 ÷ 락 보유 시간`으로 공식화 + 대입표. "줄은 두 군데에 선다"로 서버 증설이 무효인 이유. 행 샤딩 완성 SQL과 N 결정 공식. **정정** — 유실 창이 "약 3분 → 90만 건"이었으나 60+60+10 = **130초 → 65만 건**. "샤드 수 변경이 어렵다"도 절반만 참(늘리는 것은 합계가 SUM이라 쉽다) |
| 24-sharding-timing-shard-key-and-cross-shard.md | 사다리 표에 "이 칸이 늘려 주는 자원" 열 — 세로로 읽으면 쓰기 처리량을 대수만큼 늘리는 칸은 샤딩뿐. 크로스 샤드가 비싼 이유를 정렬·페이징·집계·조인 넷으로(조인은 느려짐이 아니라 **불가능**). **정정** — "`hash % 4`에서 8대로 늘리면 거의 전량 재분배"는 틀렸다. `h % 8`이 0~3인 키는 제자리라 **정확히 50%**만 이동한다(오케스트레이터가 해시 10만 개로 실측 확인). 4→5는 80%, 8→10도 80% |
| transaction-isolation-levels.md | 격리 수준을 "남의 중간 상태가 얼마나 보이는가의 눈금"으로 정의하고 교환 관계를 표로. non-repeatable vs phantom을 네 축으로(특히 "잠글 대상이 존재하는가"). RR 스냅샷은 `BEGIN`이 아니라 **첫 문장** 시점. 스프링에서 조용히 무시되는 경우는 기존 트랜잭션 합류 하나뿐. `40001` 재시도를 spring-retry / `TransactionTemplate` 두 형태로, 판정은 예외 타입이 아니라 **SQLSTATE로** |

### 25~34 재작성 완료분 (마지막 10건)

| 파일 | 크기 | 비고 |
|---|---|---|
| 25-mass-delete-archiving-and-partitioning.md | 95KB → 113KB | 24줄짜리 관전 포인트를 한 문단으로. 1-1을 여섯 문단으로 쪼개고 "가장 오래된 스냅샷보다 나중에 죽은 튜플은 못 치운다"를 T1/T2 타임라인으로. "롤백 O(1)"을 MySQL InnoDB 6행 대조표로. 2장 앞에 "왜 선택지가 셋뿐인가" 논리. **정정** — "5,000건 청크면 며칠"은 틀렸다(40,000회 × 0.3초 = **3시간 20분**). 실무 사례의 "하루 수백만 건 × 2년 = 수억 건"도 안 맞아 하루 30만 건으로 정정(30만 × 730 = 2억 1,900만). "3개월 = 전체의 12%" → 12.5% |
| 26-unique-id-generation-at-scale.md | 72KB → 94KB | 1장의 결론 유출 제거 — "PG에서 정렬성은 힙이 아니라 인덱스 문제"를 1-2에서 정면으로(힙은 FSM이 자리를 고르고 B-tree는 키가 자리를 강제한다, 두 다이어그램). 순차 키 vs 무작위 키 삽입을 나란한 두 그림으로 + FPI 41MB/s 대 0.5MB/s. 크기 계수가 MySQL InnoDB의 세컨더리 리프에서 **자식 FK 컬럼·인덱스로 자리를 옮겼다**를 1억 행 실수치로. **정정** — Snowflake ID "19자리(10^18)"는 18자리(2.207×10^17), "최솟값이 이미 10^17"은 에포크+30일 기준 1.087×10^16 |
| 28-db-failover-application-behavior.md | 97KB → 148KB | 이 장 최대. `### 1-0` 신설 — "앱 장애 = 인프라 RTO 40초 + 앱이 자기 실수를 깨닫는 시간"을 타임라인 한 장으로 세우고 이후 절이 그 확대도가 되게. 반개방 소켓을 TCP 전제 없이 네 문단으로(연결은 양쪽 메모리의 자료구조일 뿐 → 사라져도 알 방법이 없다 → `read()`가 잔다 → 무엇이 침묵을 깨나). 커넥션 3부류 6행 표에 "기본값에서 몇 분 지속되나" 열. **타임아웃 16개를 한 표에** + 단위 함정(pgjdbc 초 / HikariCP·GUC 밀리초). `synchronous_commit` 5값이 6단계 경로 어디서 응답하는지. **정정** — "풀 20개 교체 = maxLifetime × 20"은 오해(각자 독립 만료, HikariCP 편차는 `maxLifetime ÷ 40` = 30분이면 45초라 거의 동시) |
| 30-datetime-vs-timestamp-timezone.md | 65KB → 80KB | 섹션 구조는 원래 규약을 지켜 하드랩·설명 보강 위주. 1-3을 "결론 먼저"에서 "질문 둘 먼저"로 뒤집고 저장된 8바이트 / 세션 TZ / 보이는 문자열 3열 표(LA 행에서 날짜가 전날로 넘어간다). `AT TIME ZONE` 양방향 표. 값 추적 계층 다이어그램(JVM → Hibernate/JDBC → 세션 TimeZone → 저장). `now()`가 트랜잭션 시각인 것을 커서 페이지네이션 9,980건 소실·증분 동기화 누락 두 사고로. **정정** — 원문이 "`date_trunc` 표현식 인덱스 자체를 만들 수 없다"고 단정했으나 틀렸다. 존을 리터럴로 박은 `AT TIME ZONE`은 IMMUTABLE이라 인덱스가 된다(세션 의존인 `::date`·`date_trunc('day', timestamptz)`가 안 되는 것). "존을 명시하면 되고 세션에 맡기면 안 된다"로 정정하고 3-4·꼬리질문 ⑤도 정합화 |
| 33-backup-vs-restore-pitr-recovery-drill.md | 61KB → 79KB | PITR·WAL 정의를 1장 맨 앞으로("고치기 전에 무엇을 고칠지 먼저 적는 로그" → 그래서 재생만으로 어느 시점이든 재구성 → PITR은 아주 긴 크래시 복구). RPO/RTO를 사고 t=0 기준 좌우 타임라인으로 그리고 **둘이 독립이라 처방이 다르다**(RPO=WAL 아카이빙 / RTO=베이스 백업 신선도)로 개편. 물리 로그 vs 논리 로그 6행 표. "복제본은 백업이 아니다"를 밀리초 타임라인 + 8행 × 3열 장애 매트릭스로. **추가 계산** — `archive_timeout` 미설정 시 한산할수록 RPO가 나빠짐(5KB/s면 55분), 재생이 RTO의 지배 항(일주일치 2,953GiB → 8.4시간) |
| 29-order-by-index-and-filesort.md | 64KB → 98KB | 파일명 유지, 0장에 "filesort는 MySQL 용어, PG 대응물은 `Sort` 노드" 용어 정리 신설. `### 1-1`로 "인덱스 리프가 정렬돼 있다" 전제를 깔고 시작. "접·범·방·한·원·드"를 글자별 소절로 해체하고 **범**은 08번 기법대로 리프 7행을 펼쳐 구간 밑줄로 실증. `Sort Method` 세 값을 결정 트리 + 실제 EXPLAIN 출력 3벌로. 6고리 vs 3고리를 4열 표 + N=8만 실계산(130만 회 대 8만 회 = 16배). `IN`이 순서를 죽이는 과정과 `Merge Append`가 서는 조건. **오케스트레이터 정정** — 0장 `**PostgreSQL 기준 재해석**` 라벨 문단이 통째로 대체돼 있어 원문 복원(보강 설명은 뒤에 유지). `temp written=1912`가 자체 산술(15.3MB)과 안 맞아 1953으로 |
| 34-fk-constraint-in-production-debate.md | 69KB → 94KB | 찬반 양면 유지 — 2장 첫머리에 두 목록을 나란히 놓고 2-8 뒤 "여기까지가 저울의 한쪽" 전환, 끝은 "빼서 얻는 것 / 내주는 것" 8행 대응표(⑩⑪ 칸이 비어 있는 것이 요점). 1-2 "검사가 일어나는 네 순간"을 3열 표로 하고 "①②는 자식→부모라 락 문제, ③④는 부모→자식이라 인덱스 문제" 축을 세워 2장 이유의 근거로. `FOR KEY SHARE`를 "자식이 부모에게 바라는 것은 그 키로 계속 존재할 것 하나"로 유도 + 3×3 충돌 행렬. `pg_constraint`를 읽고 자동으로 일하는 도구를 분류별 표로. **정정** — "자식 1억 건 Seq Scan에 `Trigger time=8412ms`"는 모순(192B 행 → 41행/페이지 → 1억이면 18.6GB → 약 76초). **1천만 건**으로 정정하니 1.9GB → 7.6초 + CPU ≈ 8.4초로 일치. `orders` Seq Scan `shared read=412000`도 스키마(56B 행 → 136행/페이지)와 안 맞아 368,000으로 |
| 27-payment-succeeded-order-missing-incident.md | 75KB → 103KB | **PG 약어 충돌 해소** — 이 문서의 PG는 결제대행사이고 04장 나머지에서는 PostgreSQL이라 상단에 표기 대조표를 두고 DB를 가리키던 자리를 전부 풀어 씀. "두 개의 원장"을 나란한 두 상자 + 승인요청/승인응답/웹훅 화살표로 그려 원인 6종의 무대로. 원인 6종을 같은 형식 타임라인 + "무엇이 남는가 / 로그 단서 / 배제하는 법" 3칸으로 통일. 멱등·아웃박스·대사 정의 절 신설(대사는 "두 장부를 줄마다 맞춰 보는 일"). 방어선 대응표를 5겹 소개 **앞으로** 옮겨 "한 겹으로는 못 막는다"가 먼저 보이게 |
| 31-execution-plan-sudden-change.md | 76KB → 99KB | "계획 = f(후보 집합, 입력)"을 한 다이어그램으로 확장하고 "출력이 바뀌는 경우는 셋뿐"을 그림에서 도출. 통계를 "표본으로 떠 둔 요약"으로 정의하고 `pg_stats` 실제 값 두 벌 + **등호 선택도 세 갈래 규칙**(MCV에 있음/없음/값을 모름)으로. 커스텀 vs 제네릭을 준비문 → 재사용 동기 → 딜레마 → PG의 타협 순으로 뒤집음. index dive를 MySQL 대비 좌우 도식으로. **중대 정정** — 원문의 제네릭 계획 사고가 **방향이 반대**였다. `choose_custom_plan()`은 제네릭 추정 비용이 커스텀 평균보다 **쌀 때만** 채택하므로 "희귀 값 조회 → 제네릭이 과대 추정 → Seq Scan 고정"은 성립하지 않는다(커스텀 160 vs 제네릭 137만이면 채택 자체가 안 된다). **평균보다 훨씬 흔한 값만 조회하는 화면**으로 사고를 다시 세움(커스텀 339,160 vs 제네릭 4,377 → 채택 → 실제 150만 행). 부분 인덱스가 "근본 해결"이라던 서술도 같은 절의 "내는 것"과 자기모순(제네릭은 파라미터가 그 상수임을 증명 못 해 후보에 못 넣는다) → "경로 분리 + 부분 인덱스" 한 묶음으로. n_distinct 붕괴 시나리오도 Haas-Stokes로 재현 불가라 **MCV 목록 교체**로 사슬을 다시 짬. `Limit` 비용이 자식 `Sort`보다 큰 불가능한 EXPLAIN도 기본 비용 상수로 재계산 |
| 32-bulk-upsert-side-effects.md | 84KB → 111KB | **본문 11섹션 → 4섹션**(04장에서 가장 많이 어긋나 있던 문서). 옛 `###` 33개 전부 대응물 확인, `§` 참조 129건 갱신. 세 부작용의 공통 뿌리를 §1 도입부에 — "UPSERT는 UPDATE 문장이 아니라 INSERT를 **시도**하는 문장". §1-3을 "되돌려지는 것 / 되돌려지지 않는 것" 5단계도로 재작성하고 시퀀스 비트랜잭션 설계의 근거를 사고실험으로 도출. `IS DISTINCT FROM` 3×2 진리표, HOT 성립 조건, `xmax = 0` 트릭의 원리를 저장 구조에서. **정정** — "수십 배 빠르다"는 자릿수가 네 자리 틀렸다(행 증가 기준 2.9만 년 대 실제 74.6일 = **144,000배**). "20만 대 200"은 배치 대 하루로 단위가 섞여 있어 하루 기준으로 통일. "이미 60%" 꼬리질문에 남은 시간(29.8일)을 계산해 넣어 무중단 절차가 데드라인을 못 맞춘다는 논지를 성립시킴 |

### 남은 건 — 없음. 04-rdb-sql 35건 전부 완료.

마지막 10건 작업 중 **04장 전체를 훑어 깨진 상호참조 9건을 함께 고쳤다.** 02·03장이 `## 0.`~`## 4.` 규약으로 재편되면서, 그 장의 `§5` 이상을 가리키던 04장 문서들의 링크가 전부 죽어 있었다(08·13·16·19·21·27·28·32). 다른 장을 재편할 때도 **재편 대상을 가리키는 바깥 문서의 절 번호 참조**를 함께 훑어야 한다 — 재편한 장 안에서는 안 보이는 종류의 파손이다.

### 04-rdb-sql 작업 규약 (앞의 25건에서 확립된 것)

- 이 장의 3분할 관례는 **① 개념/구조 → ② 동작·설계·판별 → ③ 실무 사례·안전망**이다. 03장처럼 임의로 묶지 말고 이 관례에 맞춘다.
- 톤 견본: `01-index-and-bplus-tree.md`, `03-clustered-vs-secondary-index.md`, `10-explain-and-slow-query-process.md`
- **PostgreSQL 기준(`ae54d88`)을 되돌리지 않았는지**를 배치마다 자가 점검 항목에 넣는다.
  MySQL 대조를 하려면 **같은 줄에 "MySQL"을 명시**한다(이 규칙으로 25건 전부 통과시켰다).
- 다이어그램 코드펜스는 ` ```text `로 통일(무표기 펜스 금지).
- 서브에이전트 프롬프트에는 파일별 진단(무엇이 주니어에게 불친절한지)을 미리 넣는다 — 이것이 결과 품질을 가장 크게 갈랐다.

### 오케스트레이터 검증 (반드시 직접 할 것)

에이전트 보고를 그대로 믿지 않는다. 실제로 **에이전트가 정정했다고 보고한 것 중 오케스트레이터 지시가 틀렸던 경우가 1건**(13번 `Rows Removed by Filter`) 있었고, 계산 정정은 전건 재검산해 전부 맞았다.

- `scratchpad/audit.py` — 하드랩·픽토그램·섹션 번호·구조 요소
- `scratchpad/cmp.py` — **재작성 착수 전 커밋(`e4531f7`) 기준**으로 질문·출제 의도 원문이 새 파일에 부분 문자열로 남아 있는지.
  (커밋된 파일을 `HEAD`와 비교하면 검사가 무의미해진다. 첫 문단만 비교하면 문단이 나뉜 것을 누락으로 오탐한다 — 둘 다 겪었다.)
- 수치·계산은 `python3 -c`로 직접 검산. 소스 대조가 가능하면 로컬 jar에 직접 확인.
