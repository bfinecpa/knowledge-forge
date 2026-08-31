# 18. 비동기 / Non-blocking 프로그래밍

## 기본 ⭐

- 동기/비동기, 블로킹/논블로킹의 차이를 조합(4분면)으로 설명해주세요.
- `CompletableFuture`의 기본 사용법과 예외 처리 방법은?
- 이벤트 루프 모델(Node.js, Netty)은 어떻게 적은 스레드로 많은 연결을 처리하나요?

## 중급 ⭐⭐

- `CompletableFuture.thenApply`와 `thenApplyAsync`의 차이 — 어느 스레드에서 실행되나요?
- 비동기 처리에서 스레드풀을 분리해야 하는 이유는? (I/O bound vs CPU bound)
- Reactor의 `Mono`/`Flux` 기본 개념과 backpressure를 설명해주세요.
- WebClient로 여러 API를 병렬 호출하고 조합하는 코드를 어떻게 작성하나요?
- 비동기 코드에서 MDC(로그 컨텍스트)와 트랜잭션이 왜 깨지나요? 어떻게 전파하나요?

## 고난이도 ⭐⭐⭐

- 리액티브 스택에서 블로킹 호출(JDBC 등)이 하나 섞이면 무슨 일이 벌어지나요? 어떻게 감지하나요? (BlockHound)
- R2DBC와 JDBC의 차이, 리액티브 DB 접근이 실제로 이득인 경우와 아닌 경우는?
- Virtual Thread 시대에 WebFlux의 존재 가치에 대한 본인의 견해는?

<!-- - Coroutine과 Reactor를 혼용하는 코드베이스에서의 상호 변환과 컨텍스트 전파 문제를 설명해주세요. -->

## 알면 좋은 +α

- 비동기 처리 수단(스레드풀+CompletableFuture, Spring Event, 메시지큐)은 어떤 기준으로 선택하나요?
- CompletableFuture에 타임아웃과 취소는 어떻게 적용하나요? cancel하면 실행 중인 작업은 어떻게 되나요?
- `scheduleAtFixedRate`로 도는 주기 작업이 어느 날 조용히 멈춰 있었습니다. 가능한 원인은?
