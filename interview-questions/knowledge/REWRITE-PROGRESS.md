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
| 08-network-http | 22 | 22 | 완료 |
| 09-rest-api | 18 | 18 | 완료 |
| 01-java-kotlin | 32 | 32 | 완료 |
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
