# @Async의 동작 원리와 주의점 — "동시 처리가 8개에서 안 늘어나는" 스레드풀 함정과 조용히 묻히는 예외

> 핵심 관전 포인트: **@Async도 @Transactional과 같은 프록시 기반이다 —
> 프록시가 메서드 호출을 가로채 톰캣 요청 스레드풀과는 별개인
> TaskExecutor(스레드풀)에 작업으로 넘기고 호출자는 즉시 리턴한다.
> 그래서 자기 호출(this.method())은 조용히 동기 실행된다.
> 실무 함정은 세 가지: ① ThreadPoolTaskExecutor는 "큐가 가득
> 차야" max까지 스레드를 늘리는데 스프링 부트 기본 큐가 무제한이라
> 동시 처리가 core 개수(8)에 고정된다, ② void 리턴이면 예외가 호출자에게
> 절대 전달되지 않고 조용히 묻힌다, ③ 새 스레드에는 트랜잭션·SecurityContext·
> MDC가 전파되지 않아 로그 추적이 끊긴다. 그리고 인메모리 큐라 서버가
> 재시작되면 대기 중인 작업이 통째로 유실된다 — 내구성이 필요하면
> @Async가 아니라 메시지 큐로 가야 한다.**

---

## 0. 질문 + 의도

**질문**: "`@Async`의 동작 원리와 주의점(스레드풀 설정, 예외 처리, 프록시)은?"

**출제 의도**: 기본 스레드풀 방치(무제한 큐), 조용히 사라지는 예외,
프록시 제약 — 셋 다 운영에서만 터지는 유형이다. 비동기를 "빠르게 하는
마법"이 아니라 "관리해야 할 자원"으로 보는지 확인한다.

## 1. 동작 원리 — 프록시가 호출을 가로채 스레드풀에 던진다

`@EnableAsync`를 켜면 스프링은 `@Async`가 붙은 빈을 감싸는
**프록시 객체**(대리인)를 만들어 컨테이너에 등록한다. 다른 빈이
주입받는 것은 원본이 아니라 이 프록시다 — `@Transactional`과 완전히
같은 메커니즘이고, 하는 일만 다르다.

프록시가 하는 일을 의사코드로 풀면 이렇다:

```java
// 프록시가 하는 일 (개념적으로)
public void sendWelcomeMail(Long memberId) {
    executor.submit(() -> target.sendWelcomeMail(memberId));  // ① 작업을 스레드풀에 제출
    return;                                                    // ② 실행을 기다리지 않고 즉시 리턴
}
```

- 진짜 메서드는 **다른 스레드**에서, 나중에(스레드가 비면) 실행된다.
- 호출자는 제출만 하고 바로 다음 줄로 넘어간다 — 응답 지연에서
  부가 작업(메일 발송, 알림, 이력 적재)을 떼어내는 것이 @Async의 용도다.

### 프록시 기반의 함정 — 자기 호출은 조용히 동기 실행

```java
@Service
public class OrderService {

    public Order order(OrderRequest request) {
        Order order = save(request);
        this.sendWelcomeMail(order.memberId());  // ❌ this = 원본, 프록시를 안 거침
        return order;                            //    → 그냥 같은 스레드에서 동기 실행
    }

    @Async
    public void sendWelcomeMail(Long memberId) { ... }
}
```

비동기 전환 코드는 프록시에 있는데 `this.sendWelcomeMail()`은 프록시를
거치지 않고 원본을 직접 부르기 때문이다. 에러도 경고도 없이
**조용히 동기로 실행**되어 "비동기로 뺐는데 왜 응답이 여전히 느리지?"가
된다. 해결은 @Transactional 때와 동일 — 메서드를 다른 빈으로 분리해
프록시를 통해 호출되게 하는 것이 정석이다.

### 그 스레드풀은 톰캣 요청 스레드풀과 완전히 별개다

의사코드의 `executor`가 정확히 무엇인지가 뒤에 나올 함정들의 출발점이다.
**이 풀은 톰캣이 요청을 받아 처리하는 스레드풀과 아무 관계가 없다** —
관리 주체부터 다른, 서로를 모르는 두 개의 풀이다.

| | 톰캣 요청 스레드풀 | @Async 스레드풀 |
|---|---|---|
| 관리 주체 | 서블릿 컨테이너(내장 톰캣) | 스프링 빈 (`ThreadPoolTaskExecutor`) |
| 기본 빈 | 톰캣 내부 `Executor` | `applicationTaskExecutor` |
| 설정 키 | `server.tomcat.threads.*` | `spring.task.execution.*` |
| 기본값 | max **200**, min-spare 10 | core **8**, queue/max = `Integer.MAX_VALUE` |
| 스레드 이름 | `http-nio-8080-exec-1` | `task-1` (prefix 지정 시 `mail-1`) |
| 점유 단위 | 요청 1건 — 수신부터 응답 완료까지 | 작업 1건 — 실행 후 다음 작업 대기 |

스레드 덤프를 뜨면 이름으로 바로 갈린다. 아래 설정에서
`setThreadNamePrefix("mail-")`을 챙기는 이유가 이것이다 — 장애 때
"지금 막혀 있는 게 요청 스레드인가 메일 워커인가"를 즉시 구분하려고.

```flow
# 응답이 빨라지는 이유는 일이 줄어서가 아니라 **점유하는 풀이 바뀌어서**다. ③에서 톰캣 스레드가 반납되고, ④는 그 뒤에 다른 풀의 스레드가 이어받는다.
== 톰캣 요청 스레드풀 · http-nio-8080-exec-3 (기본 max 200)
① 요청 수신 → OrderService.order() | 컨트롤러 → 서비스, 여기까지는 평범한 동기 호출
② 프록시가 executor.submit(...) | 작업만 큐에 던지고 실행은 기다리지 않는다
③ 응답 반환 → 스레드를 톰캣 풀에 반납 | 다음 요청을 받을 수 있게 된다 — 이것이 @Async의 이득 전부
== @Async 스레드풀 · task-1 (기본 core 8)
④ sendWelcomeMail() 실제 실행 | 응답이 나간 뒤에도 계속 — 호출자와는 완전히 다른 스레드
```

일의 총량은 그대로고 점유하는 자원만 바뀐 것이다. 여기서 파생되는
실무 포인트 네 가지:

- **용량 산정을 따로 해야 한다.** 톰캣이 200개여도 비동기 작업의 동시
  처리 상한은 async 풀의 core 8개다. 톰캣 스레드는 멀쩡한데 큐만 무한히
  쌓이는 그림이 바로 다음 2장의 내용이다.
- **`CallerRunsPolicy`는 이 경계를 뚫는다.** 거절이 발생하는 순간
  호출자 — 즉 톰캣 요청 스레드 — 가 작업을 떠맡는다. 역압이 공짜가 아니라
  **톰캣 풀을 담보로 잡는 거래**라는 뜻이고, async 풀 포화가 톰캣 스레드
  고갈로 번져 서비스 전체 응답이 느려질 수 있다.
- **컨텍스트 미전파의 근본 원인이 이 분리다.** SecurityContext·MDC·
  트랜잭션 커넥션은 `http-nio-...-exec-3`의 ThreadLocal에 들어 있고
  `task-1`은 남남이다(4장).
- **스레드풀은 갈라져도 DB 커넥션풀은 공유한다.** async 워커가 DB를 쓰면
  톰캣 스레드와 **같은 HikariCP**에서 커넥션을 가져간다. async max-size를
  32로 키웠는데 Hikari가 10이면 워커가 커넥션을 물고 있는 동안 요청 처리
  쪽이 커넥션 대기로 막힌다 — 스레드풀만 보고 튜닝하면 병목이 커넥션풀로
  옮겨갈 뿐이다.

참고로 `@Scheduled`용 풀(`spring.task.scheduling.pool.size`, **기본 1개**)은
또 다른 세 번째 풀이다. 스케줄 작업 하나가 오래 걸리면 나머지 스케줄이
통째로 밀리는 사고가 이 기본값에서 나온다.

> **가상 스레드를 켜면**(Spring Boot 3.2+, `spring.threads.virtual.enabled=true`)
> 양쪽 다 가상 스레드로 바뀐다 — 톰캣은 요청당 가상 스레드를 쓰고,
> @Async는 풀링이 없는 `SimpleAsyncTaskExecutor`가 된다. 논리적으로는
> 여전히 별개지만 "고정 크기 풀"이라는 전제가 사라져 다음 2장의
> core/max/queue 튜닝 논의 자체가 무의미해진다. 대신 동시성 상한이
> 없어지므로 병목은 커넥션풀 같은 다음 자원으로 이동한다.

## 2. 스레드풀 함정 — "동시 처리가 8개에서 안 늘어난다" (실무 핵심)

실제 면접에서 **"max-size를 늘렸는데 동시 처리가 8개에서 안 늘어난다,
왜냐"** 시나리오로 출제되는 파트다. ThreadPoolTaskExecutor(내부는 자바
ThreadPoolExecutor)의 증설 순서를 알아야 답할 수 있다.

### 증설 순서 — 스레드보다 큐가 먼저다

작업이 들어왔을 때 스레드풀이 판단하는 순서:

1. core 스레드에 빈 자리가 있으면 → 스레드로 즉시 실행
2. core가 다 바쁘면 → **큐에 넣는다** (스레드를 늘리지 않는다!)
3. **큐까지 가득 차야** → 그제서야 max까지 스레드를 추가로 만든다
4. max도 다 찼고 큐도 가득이면 → 거절(RejectedExecutionHandler)

직관과 반대다. "바쁘면 일꾼을 늘리겠지"가 아니라 "바쁘면 일단 줄을
세우고, 줄이 넘칠 때만 일꾼을 늘린다"는 설계다.

### 스프링 부트 기본값이 함정을 완성한다

```yaml
# spring.task.execution.pool 의 기본값
core-size: 8
max-size: 2147483647        # Integer.MAX_VALUE
queue-capacity: 2147483647  # Integer.MAX_VALUE — 사실상 무제한 큐
```

큐가 무제한이면 3단계(큐가 가득 참)에 **영원히 도달하지 않는다.**
max-size가 아무리 커도 의미가 없고, 결과는:

- 동시 처리는 **core 개수인 8개에 고정** — 트래픽이 늘어도 안 늘어난다
- 넘치는 작업은 전부 큐에 쌓임 → 작업 지연이 무한히 길어지고,
  큐에 쌓인 작업 객체가 힙을 잠식해 **OOM**까지 갈 수 있다

### 고친 설정 (after) — 세 값 + 거절 정책을 세트로 설계

```java
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean
    public ThreadPoolTaskExecutor mailExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);        // 평시 처리량
        executor.setMaxPoolSize(32);        // 피크 처리량
        executor.setQueueCapacity(100);     // ★ 유한하게 — 이래야 max가 의미 있음
        executor.setThreadNamePrefix("mail-");  // 스레드 덤프/로그에서 식별
        executor.setRejectedExecutionHandler(
                new ThreadPoolExecutor.CallerRunsPolicy());  // 거절 정책까지 세트
        return executor;
    }
}
```

```java
@Async("mailExecutor")   // 이름으로 풀 지정 — 용도별 풀 분리
public void sendWelcomeMail(Long memberId) { ... }
```

핵심 문장: **core / max / queue-capacity / 거절 정책은 넷이 한 세트다.**
큐를 유한하게 만드는 순간 "큐가 넘치면 어떻게 할 것인가"라는 질문이
따라오므로, 거절 정책을 정하지 않은 큐 제한은 설계가 끝난 게 아니다.

거절 정책(RejectedExecutionHandler) 4종:

| 정책 | 동작 |
|---|---|
| `AbortPolicy` (기본) | `RejectedExecutionException`을 던짐 — 호출자가 실패를 인지 |
| `CallerRunsPolicy` | **호출자 스레드가 직접 실행** — 호출자가 느려지며 유입 속도가 자연히 줄어드는 역압(backpressure) 효과 |
| `DiscardPolicy` | 조용히 버림 — 유실을 아무도 모름, 거의 쓰면 안 됨 |
| `DiscardOldestPolicy` | 큐에서 가장 오래된 작업을 버리고 새 작업을 넣음 |

`CallerRunsPolicy`가 실무에서 자주 선택되는 이유: 작업을 버리지 않으면서,
풀이 포화되면 호출자(예: 톰캣 요청 스레드)가 직접 일하느라 느려져
**유입 자체가 감속**된다 — 시스템이 스스로 속도를 조절하는 역압 밸브다.
단, 그 순간만큼은 "비동기"가 아니게 된다는 트레이드오프는 알고 써야 한다.

## 3. 예외 처리 — 리턴 타입에 따라 예외의 운명이 갈린다

@Async 메서드에서 던진 예외는 **다른 스레드**에서 터진다. 호출자는
이미 리턴받고 떠난 뒤라, 예외가 호출자의 try-catch에 잡힐 방법이
원천적으로 없다. 그다음 예외가 어디로 가는지는 리턴 타입이 결정한다.

### void — 호출자에게 절대 전달되지 않는다

```java
// 사고 나는 코드 (before)
public Order order(OrderRequest request) {
    Order order = save(request);
    try {
        mailService.sendWelcomeMail(order.memberId());  // @Async void
    } catch (Exception e) {
        log.error("메일 발송 실패", e);   // ❌ 여기에 절대 안 잡힌다
    }                                     //    제출만 하고 즉시 리턴했으므로
    return order;
}
```

void 리턴이면 예외를 담아 돌려줄 그릇 자체가 없다. 예외는
`AsyncUncaughtExceptionHandler`로만 관측할 수 있고, **기본 구현은
로그 한 줄 남기고 끝**이다 — 알림 발송 실패 같은 장애가 조용히 묻힌다.

```java
// 고친 코드 (after) — 전역 핸들러로 최소한 관측 가능하게
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> {
            log.error("[async-fail] {} params={}", method.getName(), params, ex);
            // 여기서 메트릭 증가, 알림, 실패 이력 적재 등
        };
    }
}
```

### Future / CompletableFuture — 예외가 결과에 담긴다

```java
@Async
public CompletableFuture<MailResult> sendWelcomeMail(Long memberId) {
    // 예외가 나면 CompletableFuture 안에 예외가 담긴다
    return CompletableFuture.completedFuture(doSend(memberId));
}

// 호출자
CompletableFuture<MailResult> future = mailService.sendWelcomeMail(id);
future.join();   // ← 이 시점에 예외를 수령 (CompletionException으로 감싸져 나옴)
// 또는 논블로킹으로:
future.exceptionally(ex -> { log.error("발송 실패", ex); return MailResult.failed(); });
```

예외가 결과 객체에 담겨 있다가 `get()`/`join()` 호출 시점에 던져진다.
**단, 호출자가 결과를 확인하지 않으면(fire-and-forget으로 리턴값을 버리면)
void와 똑같이 조용히 묻힌다.** "CompletableFuture를 리턴하니 안전하다"가
아니라 "결과를 소비하는 코드까지 있어야 안전하다"가 정확한 답이다.

## 4. 컨텍스트 미전파 — 새 스레드는 빈손으로 시작한다

작업이 실행되는 곳은 **새 스레드**다. 호출자 스레드가 ThreadLocal에
들고 있던 것들이 전파되지 않는다:

- **트랜잭션**: 트랜잭션은 커넥션을 ThreadLocal에 바인딩하는 구조라
  스레드가 바뀌면 남남이다. @Async 메서드에 @Transactional을 같이 붙이면
  동작은 하지만 **호출자 트랜잭션과 완전히 별개의 새 트랜잭션**이다 —
  호출자가 롤백돼도 @Async 쪽은 커밋될 수 있다(그 역도 성립).
  심지어 호출자 트랜잭션이 커밋되기 전에 @Async 쪽이 먼저 실행되어
  "아직 커밋 안 된 데이터를 조회 못 하는" 타이밍 문제도 생긴다.
- **SecurityContext**: 기본 전략(ThreadLocal)에서는 새 스레드에
  인증 정보가 없어 `SecurityContextHolder.getContext().getAuthentication()`이
  null — 권한 체크가 있는 코드를 호출하면 실패한다.
- **MDC (trace id 등)**: 로그에 찍히던 요청 추적 id가 새 스레드에서는
  비어 있다 — **비동기 구간부터 로그 추적이 뚝 끊긴다.** 장애 분석 때
  "메일 발송 로그가 어느 요청 건인지 못 찾는" 형태로 대가를 치른다.

### TaskDecorator로 컨텍스트 복사 (after)

```java
public class ContextCopyingDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable task) {
        // ① 제출 시점(호출자 스레드)에 컨텍스트를 캡처
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        SecurityContext security = SecurityContextHolder.getContext();

        return () -> {
            try {
                // ② 실행 시점(워커 스레드)에 복원
                if (mdc != null) MDC.setContextMap(mdc);
                SecurityContextHolder.setContext(security);
                task.run();
            } finally {
                MDC.clear();                    // ③ 풀 스레드는 재사용되므로
                SecurityContextHolder.clearContext();  //    반드시 청소 — 다음 작업에 오염 방지
            }
        };
    }
}
```

```java
executor.setTaskDecorator(new ContextCopyingDecorator());
```

③의 청소가 중요하다. 풀 스레드는 재사용되므로, 안 지우면 **다른 사용자의
인증 정보/trace id가 다음 작업에 묻어 들어가는** 보안 사고급 오염이 된다.

## 5. @Async vs 메시지 큐 — 언제 갈아타야 하나

@Async의 큐는 **JVM 힙 위의 인메모리 큐**다. 이 한 문장에서 판단 기준이
전부 나온다:

- **서버가 재시작(배포, 크래시)되면 큐에 쌓여 있던 작업이 통째로
  유실된다.** 실행 중이던 작업도 중간에 끊긴다. 재시도도, 유실 감지도 없다.
- 큐가 서버 안에 있으므로 **다른 서버로 부하를 분산할 수 없다** —
  처리량의 상한이 그 서버의 스레드풀이다.

그래서 기준은 "이 작업이 유실돼도 되는가":

| 판단 기준 | @Async로 충분 | 메시지 큐(Kafka, RabbitMQ 등)로 |
|---|---|---|
| 유실 허용 | 유실돼도 재시도/무시 가능 (캐시 워밍, 조회수 집계) | 유실 불가 (결제 후처리, 포인트 적립, 정산) |
| 재시도/실패 추적 | 불필요 | 필요 (DLQ, 재처리) |
| 처리 주체 | 같은 서버, 같은 프로세스면 충분 | 별도 컨슈머로 확장/분리 필요 |

한 단계 더: "DB 커밋과 이벤트 발행이 원자적이어야 한다"(주문은 저장됐는데
발행만 실패하는 사고 방지)까지 요구되면 **아웃박스 패턴**(같은 트랜잭션으로
DB에 이벤트를 쓰고, 별도 프로세스가 읽어 발행)으로 답하면 가산점이다.
@Async는 "빨라 보이게 하는 도구"지 "반드시 실행됨을 보장하는 도구"가
아니다 — 이 구분이 시니어 답변의 핵심이다.

---

## 6. 꼬리질문 대비 포인트

### "void @Async 메서드에서 예외가 나면 어디로 가나? 어떻게 관측하나?"

호출자에게는 절대 전달되지 않는다. 호출자는 작업을 제출하고 이미
리턴받아 떠났고, void라 예외를 담아 줄 그릇도 없기 때문이다. 예외는
`AsyncUncaughtExceptionHandler`가 받는데 **기본 구현은 로그 한 줄**이라
사실상 조용히 묻힌다. 관측하려면 `AsyncConfigurer`로 커스텀 핸들러를
등록해 에러 로그 + 메트릭/알림을 태우거나, 애초에 `CompletableFuture`를
리턴하고 호출자가 `exceptionally` 등으로 결과를 소비하게 설계한다 —
단 후자도 리턴값을 버리면 똑같이 묻힌다는 점까지 말해야 완결이다.

### "@Async가 쓰는 스레드풀은 톰캣 요청 스레드풀과 같은 건가?"

완전히 별개다. 톰캣 풀은 서블릿 컨테이너가 관리하고
(`server.tomcat.threads.*`, 기본 max 200, 스레드 이름 `http-nio-...-exec-N`),
@Async 풀은 스프링 빈 `applicationTaskExecutor`다
(`spring.task.execution.*`, 기본 core 8, 이름 `task-N`). 요청 스레드는
작업을 제출한 뒤 응답을 내보내고 풀로 반납되며, 실제 실행은 그 뒤에
워커 스레드에서 일어난다 — 응답이 빨라지는 건 일이 줄어서가 아니라
**점유하는 풀이 바뀌어서**다. 여기서 세 가지가 따라온다: ① 톰캣이
200개여도 비동기 동시 처리 상한은 core 8개라 용량 산정을 따로 해야 하고,
② `CallerRunsPolicy`는 그 경계를 뚫어 톰캣 스레드가 작업을 떠맡게 만들며,
③ ThreadLocal(SecurityContext·MDC·트랜잭션)이 안 넘어가는 이유도 결국
이 분리다. 단, **스레드풀은 갈라져도 HikariCP 커넥션풀은 공유**하므로
async 풀만 키우면 병목이 커넥션풀로 옮겨간다는 점까지 말하면 완결이다.

### "max-size를 늘렸는데 동시 처리가 core 개수에서 안 늘어난다 — 왜?"

ThreadPoolExecutor의 증설 순서 때문이다. core가 다 바쁘면 스레드를
늘리는 게 아니라 **큐에 먼저 넣고**, **큐가 가득 차야** max까지 스레드를
추가한다. 스프링 부트 기본 queue-capacity가 `Integer.MAX_VALUE`(사실상
무제한)라 큐가 영원히 안 차고, 따라서 max-size는 값이 얼마든 도달
불가능한 설정이 된다 — 동시 처리는 core=8에 고정되고 나머지는 큐에서
무한 대기한다. 해결은 queue-capacity를 유한하게 제한하는 것이고, 그
순간 거절 상황이 생기므로 거절 정책까지 한 세트로 설계해야 한다.

### "큐까지 가득 차면 어떻게 되나?"

`RejectedExecutionHandler`가 호출된다. 기본인 `AbortPolicy`는
`RejectedExecutionException`을 던져 호출자가 실패를 인지하게 하고,
`CallerRunsPolicy`는 호출자 스레드가 그 작업을 직접 실행한다 —
호출자가 느려지면서 유입 속도가 자연히 줄어드는 **역압(backpressure)**
효과가 있어 "버리지 않으면서 시스템을 보호하는" 선택지로 자주 쓰인다
(단 그 순간은 동기 실행이 된다). `DiscardPolicy`는 조용히 버리고
`DiscardOldestPolicy`는 가장 오래된 것을 버린다 — 유실을 아무도 모르게
되므로 명시적 근거 없이는 쓰지 않는다.

### "@Async와 @Transactional을 한 메서드에 같이 붙이면?"

동작은 하지만 **호출자 트랜잭션과는 완전히 별개**다. 트랜잭션은
커넥션을 ThreadLocal에 묶는 구조라 스레드가 바뀌는 순간 남남이 되고,
@Async 쪽은 자기 스레드에서 새 트랜잭션을 연다. 그래서 호출자가
롤백돼도 @Async 쪽은 커밋될 수 있고(역도 성립), 호출자 커밋 전에
@Async가 먼저 돌아 "아직 커밋 안 된 데이터가 안 보이는" 타이밍 문제도
난다. 둘의 원자성이 필요하면 @Async가 아니라 트랜잭션 커밋 후 실행
(`@TransactionalEventListener(phase = AFTER_COMMIT)` + @Async)이나
아웃박스 패턴으로 설계를 바꿔야 한다.

### "@Async 작업이 큐에 쌓인 채 서버가 재시작되면?"

전부 유실된다. @Async의 큐는 JVM 힙 위 인메모리 큐라 프로세스가
내려가면 같이 사라지고, 실행 중이던 작업도 중간에 끊긴다. 재시도도
유실 감지도 없다. 그래서 "유실돼도 되는 작업"(캐시 워밍, 통계 집계)에만
@Async를 쓰고, 유실 불가한 작업(결제 후처리, 포인트 적립)은 브로커가
디스크에 보존해주는 메시지 큐로, DB 커밋과의 원자성까지 필요하면
아웃박스 패턴으로 간다 — 도구를 내구성 요구사항 기준으로 고르는 것이
답의 핵심이다.

### "같은 클래스 안에서 this.asyncMethod()를 부르면?"

비동기가 아니라 **조용히 동기 실행**된다. 비동기 전환 코드는 프록시에
있는데 `this` 호출은 프록시를 거치지 않고 원본을 직접 부르기 때문 —
@Transactional의 자기 호출 미적용과 완전히 같은 원리다. 에러가 없어서
"비동기로 뺐는데 응답이 안 빨라진다"로만 드러난다. 해결은 해당 메서드를
별도 빈으로 분리하는 것이 정석이다.

---

## 한 줄 요약

@Async는 프록시가 호출을 가로채 **톰캣 요청 스레드풀과는 별개인**
인메모리 스레드풀 큐에 작업을 던지고 즉시 리턴하는 구조라서 —
자기 호출 미적용(프록시), 무제한 기본 큐로
인한 "동시 처리 core 고정"(큐가 차야 max 증설), void 예외의 조용한
증발(AsyncUncaughtExceptionHandler), 트랜잭션·SecurityContext·MDC
미전파(TaskDecorator), 재시작 시 작업 유실(내구성 필요하면 MQ/아웃박스)
까지 전부 "다른 스레드의 인메모리 큐에서 나중에 실행된다"는 한 문장에서
파생되고, 이 파생 관계를 아는 사람은 설정 네 개(core/max/queue/거절 정책)를
세트로 설계한다.
