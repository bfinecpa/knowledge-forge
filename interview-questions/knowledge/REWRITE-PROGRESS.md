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
| 09-rest-api | 18 | 0 | 다음 차례 |
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
