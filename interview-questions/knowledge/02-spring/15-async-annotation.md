# @Async의 동작 원리와 주의점 — "동시 처리가 8개에서 안 늘어나는" 스레드풀 함정과 조용히 묻히는 예외

> 핵심 관전 포인트: **`@Async`는 프록시가 메서드 호출을 가로채 톰캣 요청 스레드풀과는 별개인 `TaskExecutor`에 작업으로 던지고 호출자는 즉시 리턴하는 구조다. 여기서 실무 사고 네 가지가 전부 파생된다 — ① 스레드풀은 "바쁘면 스레드를 늘리는" 것이 아니라 "큐에 먼저 쌓고 큐가 넘칠 때만 늘리는" 순서라, 스프링 부트 기본 큐 용량이 `Integer.MAX_VALUE`인 채로 `max-size`만 올리면 동시 처리가 `core-size`(기본 8)에 영영 고정된다. ② `void` 리턴이면 예외가 호출자에게 전달될 길이 원천적으로 없어 로그 한 줄만 남고 묻힌다. ③ 트랜잭션·`SecurityContext`·MDC는 셋 다 `ThreadLocal`에 들어 있고 새 스레드는 자기만의 `ThreadLocal`을 갖기 때문에 하나도 넘어가지 않는다. ④ 큐가 JVM 힙 위에 있으므로 배포·크래시로 프로세스가 내려가면 대기 중이던 작업이 통째로 사라진다. 그래서 `@Async`는 "빨라 보이게 하는 도구"이지 "반드시 실행됨을 보장하는 도구"가 아니며, 내구성이 필요하면 RabbitMQ·Kafka 같은 브로커나 아웃박스 패턴으로 도구 자체를 바꿔야 한다.**

---

## 0. 질문 + 의도

**질문**: "`@Async`의 동작 원리와 주의점(스레드풀 설정, 예외 처리, 프록시)은?"

**출제 의도**: 기본 스레드풀 방치(무제한 큐), 조용히 사라지는 예외, 프록시 제약 — 셋 다 운영에서만 터지는 유형이다. 비동기를 "빠르게 하는 마법"이 아니라 "관리해야 할 자원"으로 보는지 확인한다.

> 이 문서는 **스레드풀 자체의 설정**에 지면을 집중한다. 커밋 시점에 맞춰 비동기 작업을 태우는 이야기는 `16-spring-event-transactional-event-listener.md`, 스케줄러 스레드를 여러 작업이 공유해서 생기는 지연 전파는 `34-scheduled-tasks-threading.md`에 있다. 셋 다 "요청 스레드가 아닌 다른 스레드에서 일이 돈다"는 같은 뿌리에서 나온 문제다.

## 1. 동작 원리 — 프록시가 호출을 가로채 "다른 풀"에 던진다

### 1-1. 전제 지식 — 프록시가 무엇인가

`@Async`를 이해하려면 **프록시**부터 알아야 한다. 프록시는 **원본 객체인 척하면서 호출을 먼저 받아 부가 작업을 한 뒤 원본에 넘기는 대리인 객체**다. 원본과 똑같은 타입이라 호출하는 쪽은 대리인인지 원본인지 구분하지 못한다.

`@EnableAsync`를 켜면 스프링은 `@Async`가 붙은 메서드를 가진 빈을 찾아 그 빈을 감싸는 프록시를 만들고, **컨테이너에 원본 대신 프록시를 등록한다.** 다른 빈이 `@Autowired`로 주입받는 것은 원본이 아니라 이 프록시다. `@Transactional`이 트랜잭션을 열고 닫는 것과 완전히 같은 메커니즘이고, 프록시가 끼워 넣는 부가 작업만 다르다.

프록시가 하는 부가 작업을 의사코드로 풀면 이렇다.

```java
// @Async 프록시가 하는 일 (개념적으로)
public void sendWelcomeMail(Long memberId) {
    // 원본 메서드를 지금 부르지 않는다. "나중에 부를 일감" 형태로 포장해 풀에 맡긴다.
    executor.submit(() -> target.sendWelcomeMail(memberId));
    // 맡긴 일이 끝나기를 기다리지 않고 곧바로 호출자에게 돌아간다.
    // @Async가 응답을 빠르게 만드는 이유의 전부가 이 두 줄이다.
    return;
}
```

핵심은 **진짜 메서드가 다른 스레드에서, 나중에(그 풀의 스레드가 비면) 실행된다**는 것이다. 호출자는 제출만 하고 다음 줄로 넘어간다. 메일 발송·알림·이력 적재처럼 "응답을 늦출 이유가 없는 부가 작업"을 응답 경로에서 떼어내는 것이 `@Async`의 용도다.

### 1-2. 프록시 기반이라 자기 호출에는 무력하다

```java
@Service
public class OrderService {

    public Order order(OrderRequest request) {
        Order order = save(request);
        // 문제: this는 프록시가 아니라 원본 자신이다.
        // 비동기 전환 코드는 프록시에만 있으므로 이 호출은 그냥 같은 스레드에서 동기로 돈다.
        this.sendWelcomeMail(order.memberId());
        return order;
    }

    @Async
    public void sendWelcomeMail(Long memberId) { ... }
}
```

에러도 경고도 없이 **조용히 동기로 실행**되어 "비동기로 뺐는데 왜 응답이 여전히 느리지?"가 된다. 원인과 해법(별도 빈 분리가 정석, 자기 주입·`TransactionTemplate`·`AopContext` 등 대안의 대가)은 `@Transactional`의 자기 호출 문제와 한 글자도 다르지 않으므로 `11-transactional-self-invocation.md`에 맡긴다.

### 1-3. 그 스레드풀은 톰캣 요청 스레드풀과 완전히 별개다

의사코드의 `executor`가 정확히 무엇인지가 뒤에 나올 함정들의 출발점이다. **이 풀은 톰캣이 요청을 받아 처리하는 스레드풀과 아무 관계가 없다.** 관리 주체부터 다른, 서로를 모르는 두 개의 풀이다. (아래 기본값은 Spring Boot 3.x 기준으로 확인한 값이다.)

| | 톰캣 요청 스레드풀 | @Async 스레드풀 |
|---|---|---|
| 관리 주체 | 서블릿 컨테이너(내장 톰캣) | 스프링 빈 (`ThreadPoolTaskExecutor`) |
| 기본 빈 | 톰캣 내부 `Executor` | `applicationTaskExecutor` |
| 설정 키 | `server.tomcat.threads.*` | `spring.task.execution.*` |
| 기본값 | max **200**, min-spare 10 | core **8**, max·queue = `Integer.MAX_VALUE` |
| 스레드 이름 | `http-nio-8080-exec-1` | `task-1` (prefix 지정 시 `mail-1`) |
| 점유 단위 | 요청 1건 — 수신부터 응답 완료까지 | 작업 1건 — 실행 후 다음 작업 대기 |

요청 하나가 처리되는 동안 스레드가 어떻게 갈아타는지를 시간순으로 보면 이렇다.

```text
[톰캣 요청 스레드풀]  http-nio-8080-exec-3          [@Async 스레드풀]  task-1
      │                                                    │
 t0   │ ① 요청 수신 → OrderService.order()                  │  (놀고 있음)
      │    컨트롤러 → 서비스, 여기까지는 평범한 동기 호출     │
      │                                                    │
 t1   │ ② 프록시가 executor.submit(...)  ─────────────────> │ 큐에 일감 적재
      │    실행을 기다리지 않는다                            │
      │                                                    │
 t2   │ ③ 응답 반환 → 스레드를 톰캣 풀에 반납                │ ④ sendWelcomeMail() 실제 실행
      │    다음 요청을 받을 수 있게 된다                     │    응답이 나간 뒤에도 계속 돈다
      │    ← @Async가 주는 이득은 여기까지가 전부            │
      v                                                    v
```

**일의 총량은 그대로고 점유하는 자원만 바뀐 것**이다. 응답이 빨라지는 이유는 일이 줄어서가 아니라 톰캣 스레드가 t2에 반납되기 때문이다.

스레드 덤프를 뜨면 이름으로 바로 갈린다. 뒤의 설정 코드에서 `setThreadNamePrefix("mail-")`을 챙기는 이유가 이것이다 — 장애가 났을 때 "지금 막혀 있는 게 요청 스레드인가 메일 워커인가"를 즉시 구분하려고 붙인다.

여기서 파생되는 실무 포인트가 셋이다.

**첫째, 용량 산정을 따로 해야 한다.** 톰캣이 200개여도 비동기 작업의 동시 처리 상한은 async 풀의 core 8개다. 톰캣 스레드는 멀쩡한데 async 큐만 무한히 쌓이는 그림이 바로 2절의 내용이다.

**둘째, `CallerRunsPolicy`는 이 경계를 뚫는다.** 큐가 넘쳐 거부가 발생하는 순간 호출자 — 즉 톰캣 요청 스레드 — 가 그 작업을 떠맡는다. 뒤에서 보겠지만 이 정책의 백프레셔는 공짜가 아니라 **톰캣 풀을 담보로 잡는 거래**다.

**셋째, 컨텍스트가 안 넘어가는 근본 원인이 이 분리다.** `SecurityContext`·MDC·트랜잭션 커넥션은 `http-nio-...-exec-3`의 `ThreadLocal`에 들어 있고 `task-1`은 그 저장소에 접근할 방법이 없다(3-2).

### 1-4. 스레드풀은 갈라져도 DB 커넥션풀은 공유한다

풀이 둘로 갈렸다고 해서 자원이 전부 갈린 것은 아니다. async 워커가 DB를 쓰면 톰캣 스레드와 **같은 HikariCP 인스턴스**에서 커넥션을 가져간다.

숫자로 보면 위험이 분명해진다. async `max-size`를 32로 키웠는데 Hikari 풀이 10이라고 하자. 워커 32개가 동시에 DB를 쓰려 들면 10개만 커넥션을 잡고 22개는 대기하는데, 그 10개는 **요청 처리 쪽이 쓸 커넥션까지 먹어치운 것**이다. 톰캣 스레드는 커넥션 대기로 막히고, 스레드풀만 보고 튜닝한 결과 병목이 커넥션풀로 옮겨간 셈이 된다. 크기 산정의 원칙은 `25-thread-pool-connection-pool-sizing.md`, 고갈 진단은 `26-hikaricp-connection-pool-exhaustion.md`에 있다.

참고로 `@Scheduled`용 풀(`spring.task.scheduling.pool.size`, **기본 1개**)은 또 다른 세 번째 풀이다. 스케줄 작업 하나가 오래 걸리면 나머지 스케줄이 통째로 밀리는 사고가 이 기본값에서 나오는데, 그 이야기는 `34-scheduled-tasks-threading.md`에 있다.

### 1-5. 가상 스레드를 켜면 이 절의 전제가 바뀐다

Spring Boot 3.2부터 `spring.threads.virtual.enabled=true`를 주면 양쪽 다 가상 스레드로 바뀐다. 톰캣은 요청마다 가상 스레드를 만들어 쓰고, `@Async`는 풀링이 없는 `SimpleAsyncTaskExecutor` 계열로 대체된다.

논리적으로는 여전히 별개의 실행 경로지만 **"고정 크기 풀"이라는 전제가 사라지므로 2절의 core/max/queue 튜닝 논의 자체가 무의미해진다.** 대신 동시성 상한이 없어지니 병목은 그다음 자원 — 대개 커넥션풀이나 외부 API의 처리량 — 으로 이동한다. "가상 스레드를 켜면 튜닝이 필요 없다"가 아니라 **"튜닝해야 할 지점이 스레드풀에서 다음 자원으로 옮겨간다"**가 정확한 표현이다.

## 2. 스레드풀 설정 — 큐가 가득 차야 스레드가 늘어난다 (실무 핵심)

실제 면접에서 **"max-size를 100으로 올렸는데 동시 처리가 8개에서 안 늘어난다, 왜냐"** 시나리오로 출제되는 파트다.

### 2-1. 전제 지식 — 세 개의 숫자가 각각 무엇인가

`ThreadPoolTaskExecutor`(내부는 자바의 `ThreadPoolExecutor`)를 설정할 때 다루는 숫자는 셋이다.

- **`corePoolSize`**: 평상시 유지하는 스레드 개수. 일이 없어도 살려두는 상비 인력이다.
- **`queueCapacity`**: 스레드가 다 바쁠 때 일감을 쌓아두는 대기열의 길이.
- **`maxPoolSize`**: 임시 인력까지 포함한 스레드 개수의 절대 상한.

여기까지는 이름만 봐도 짐작이 간다. 함정은 **이 셋이 어떤 순서로 쓰이는가**에 있다.

### 2-2. ★ 분기 순서 — 직관과 반대다

작업 하나가 `executor.submit()`으로 들어왔을 때 풀이 판단하는 순서를 그대로 그리면 이렇다.

```text
                        작업 1건 도착
                             │
                             v
              ┌──────────────────────────────┐
              │ 현재 스레드 수 < corePoolSize? │
              └──────────────────────────────┘
                   예 │              │ 아니오
                      v              v
            새 스레드를 만들어   ┌─────────────────────┐
            즉시 실행           │  큐에 빈 자리가 있나? │
                               └─────────────────────┘
                                  예 │         │ 아니오
                                     v         v
                              ★ 큐에 적재    ┌──────────────────────────┐
                              (스레드를      │ 스레드 수 < maxPoolSize?  │
                               늘리지 않는다) └──────────────────────────┘
                                                예 │        │ 아니오
                                                   v        v
                                        새 스레드를 만들어   RejectedExecutionHandler
                                        즉시 실행            (거부 정책 호출)
```

★ 표시한 분기가 전부다. **"바쁘면 일꾼을 늘리겠지"가 아니라 "바쁘면 일단 줄을 세우고, 줄이 넘칠 때만 일꾼을 늘린다"**는 설계다. 은행 창구로 비유하면, 창구 8개가 다 찼을 때 창구를 더 여는 게 아니라 대기 번호표를 뽑게 하고, **대기 의자가 전부 차야** 비로소 예비 창구를 여는 방식이다.

이 순서를 택한 이유가 있다. 스레드를 새로 만드는 비용(스택 메모리 할당, OS 스케줄링 대상 추가)이 큐에 객체 하나를 넣는 비용보다 훨씬 크기 때문이다. 순간적인 부하 급증이라면 줄을 세워 흡수하는 편이 낫고, 줄이 넘칠 만큼 지속되는 부하일 때만 스레드를 늘리자는 판단이다.

### 2-3. 스프링 부트 기본값이 함정을 완성한다

```yaml
# spring.task.execution.pool 의 기본값 (Spring Boot 3.x)
core-size: 8
max-size: 2147483647        # Integer.MAX_VALUE
queue-capacity: 2147483647  # Integer.MAX_VALUE — 사실상 무제한 큐
```

2-2의 흐름도에 이 값을 대입해 보자. 큐 용량이 21억이므로 **"큐에 빈 자리가 있나?"라는 분기가 항상 '예'로 떨어진다.** 그러면 오른쪽 아래의 `maxPoolSize` 분기에는 **영원히 도달하지 않는다.** `max-size`를 100으로 올리든 1000으로 올리든 도달할 수 없는 설정이 되는 것이다.

결과는 둘이다.

- 동시 처리가 **`core-size`인 8개에 고정**된다. 트래픽이 열 배가 되어도 여전히 8개다. 나머지는 전부 줄만 선다.
- 넘치는 작업이 무한히 쌓이므로 **작업 지연이 계속 길어지고**, 큐에 들어간 작업 객체(람다가 캡처한 인자까지)가 힙을 잠식해 **`OutOfMemoryError`**까지 갈 수 있다.

"메일이 나가긴 나가는데 30분씩 늦게 나간다"는 증상이 전형적이다. 큐가 무한하니 거부도 없고 예외도 없어서, 지표를 안 보면 아무 일도 없는 것처럼 보인다.

### 2-4. 고치는 법 — 큐를 유한하게 잡아야 max가 의미를 갖는다

```java
@Configuration
@EnableAsync
public class AsyncConfig {

    @Bean
    public ThreadPoolTaskExecutor mailExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);        // 평시에 상시 유지할 처리량
        executor.setMaxPoolSize(32);        // 피크에 임시로 늘릴 상한
        // 이 한 줄이 2-2 흐름도의 오른쪽 아래 분기를 "도달 가능"하게 만든다.
        // 유한한 큐가 없으면 위의 maxPoolSize 32는 영원히 쓰이지 않는 숫자다.
        executor.setQueueCapacity(100);
        // 스레드 덤프와 로그에서 톰캣 스레드와 구분하기 위한 이름표(1-3 참고)
        executor.setThreadNamePrefix("mail-");
        // 큐를 유한하게 만든 순간 "넘치면 어떻게 할 것인가"가 반드시 따라온다
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        return executor;
    }
}
```

```java
// 풀 이름을 지정해 용도별로 격리한다. 이름을 안 주면 공용 applicationTaskExecutor를
// 쓰게 되어, 메일 발송이 밀리면 통계 집계까지 같이 밀린다.
@Async("mailExecutor")
public void sendWelcomeMail(Long memberId) { ... }
```

**core / max / queue-capacity / 거부 정책은 넷이 한 세트다.** 큐를 유한하게 만드는 순간 "큐가 넘치면 어떻게 할 것인가"라는 질문이 반드시 따라오므로, 거부 정책을 정하지 않은 큐 제한은 설계가 끝난 게 아니다.

#### 큐 용량은 무엇을 보고 정하는가

100이라는 숫자는 어디서 나오는가. **큐 길이는 곧 "최악의 대기 시간"을 정하는 손잡이**라는 관점으로 잡는다.

메일 발송 1건이 평균 200ms 걸린다고 하자. core 8개가 모두 돌 때의 처리량은 이렇게 계산된다.

```text
초당 처리 건수 = 스레드 수 ÷ 1건 처리 시간
              = 8 ÷ 0.2초 = 40건/초        (core 8개일 때)
              = 32 ÷ 0.2초 = 160건/초      (max 32개까지 늘어났을 때)

큐가 100까지 찼을 때, 맨 뒤에 들어간 작업의 대기 시간
              = 100 ÷ 40건/초 = 2.5초      (스레드가 core에 머무는 최악의 경우)
```

즉 큐 100은 "메일이 최대 2.5초 늦게 나가는 것까지는 허용한다"는 선언이다. 여기서 트레이드오프가 드러난다.

- **큐를 길게 잡으면**: 거부가 거의 없어지지만 대기 시간이 그만큼 길어지고, 스레드 증설이 늦게 시작되며, 힙 사용량이 커진다. 극단이 기본값(21억)이고 그 결과가 2-3이다.
- **큐를 짧게 잡으면**: 스레드가 빨리 늘어나 지연은 짧아지지만 거부가 잦아진다. 극단은 `SynchronousQueue`(용량 0)로, 남는 스레드가 없으면 즉시 max까지 늘리고 그마저 없으면 바로 거부한다.

판단 기준은 **작업의 성격**이다. 지연이 곧 사용자 불만인 작업(알림 발송)은 큐를 짧게 잡아 스레드를 빨리 늘리고, 지연이 아무래도 상관없는 작업(통계 집계, 캐시 워밍)은 큐를 넉넉히 잡아 스레드 수를 아낀다.

### 2-5. 거부 정책 4종 — 각각 무슨 일이 벌어지는가

큐도 차고 max도 찬 순간 `RejectedExecutionHandler`가 호출된다. 네 가지 기본 구현이 각각 무엇을 하는지 정확히 알아야 한다.

| 정책 | 그 순간 실제로 벌어지는 일 | 작업의 운명 |
|---|---|---|
| `AbortPolicy` (기본) | 제출한 스레드에 `RejectedExecutionException`을 던진다 | 실행 안 됨. 단, 호출자가 실패를 **인지**한다 |
| `CallerRunsPolicy` | 제출한 스레드가 그 자리에서 `run()`을 직접 호출한다 | 실행됨. 단, 호출자 스레드가 그동안 묶인다 |
| `DiscardPolicy` | 아무것도 하지 않고 조용히 반환한다 | 실행 안 됨. 아무도 모른다 |
| `DiscardOldestPolicy` | 큐 맨 앞(가장 오래된) 작업을 버리고 새 작업을 큐에 넣는다 | 새 작업은 실행됨. 가장 오래 기다린 작업이 희생된다 |

`AbortPolicy`가 기본인 이유는 **"모르는 것보다 아는 것이 낫다"**는 원칙 때문이다. 예외가 올라오면 최소한 로그와 지표에 남는다.

`DiscardPolicy`와 `DiscardOldestPolicy`는 **유실을 아무도 모르게 만든다.** 명시적인 근거 — 예를 들어 "1초마다 갱신되는 시세 스냅샷이라 오래된 건 버리는 게 맞다" 같은 — 없이는 쓰지 않는다. 특히 `DiscardOldestPolicy`는 가장 오래 기다린 작업, 즉 **가장 먼저 들어온 요청이 가장 늦게 버려지는** 불공평한 특성이 있다.

`CallerRunsPolicy`는 실무에서 가장 자주 선택되지만, 양면을 다 알고 써야 한다.

**밝은 면 — 백프레셔가 공짜로 생긴다.** 백프레셔(backpressure)는 하류가 소화하지 못할 때 상류의 유입 속도를 강제로 늦추는 장치를 말한다. 풀이 포화되면 호출자가 직접 일하느라 다음 요청을 받지 못하니, 유입 속도가 처리 속도에 자동으로 맞춰진다. 작업을 버리지도 않는다.

**어두운 면 — 그 호출자가 톰캣 요청 스레드다.** 1-3에서 두 풀이 별개라고 했는데, 이 정책은 그 경계를 의도적으로 허문다. async 풀이 포화된 동안 톰캣 스레드가 메일 발송을 대신 수행하므로, **async 풀의 포화가 톰캣 풀의 고갈로 번진다.** 메일 발송이 2초 걸린다면 그 2초 동안 그 요청 스레드는 새 요청을 못 받는다. 200개짜리 톰캣 풀이 이런 식으로 소진되면 비동기로 뺐던 부가 작업 때문에 서비스 전체 응답이 느려지는, 원래 피하려던 바로 그 상황이 된다.

그래서 정확한 결론은 이렇다. **`CallerRunsPolicy`는 "버리지 않는 대신 톰캣 풀을 담보로 잡는" 거래이며, 그 순간만큼은 비동기가 아니게 된다.** 담보로 잡히는 것이 요청 스레드가 아닌 전용 호출 경로(예: 스케줄러 스레드)라면 부담이 훨씬 적다.

## 3. 조용한 실패 세 가지 — 묻히는 예외, 안 넘어가는 컨텍스트, 사라지는 큐

여기서부터는 설정이 아니라 **"다른 스레드에서 나중에 실행된다"는 사실 자체가 만드는 문제**다. 셋 다 예외도 경고도 없이 조용히 일어난다는 공통점이 있다.

### 3-1. 예외 — 리턴 타입이 예외의 운명을 가른다

`@Async` 메서드에서 던진 예외는 **다른 스레드**에서 터진다. 호출자는 이미 리턴받고 떠난 뒤이므로 예외가 호출자의 try-catch에 잡힐 방법이 원천적으로 없다. 그다음 예외가 어디로 가는지는 **리턴 타입**이 결정한다.

#### void — 담아 돌려줄 그릇 자체가 없다

```java
// before: 잡히지 않는 catch
public Order order(OrderRequest request) {
    Order order = save(request);
    try {
        mailService.sendWelcomeMail(order.memberId());   // @Async void
    } catch (Exception e) {
        // 문제: 여기는 절대 실행되지 않는다.
        // 위 호출은 "제출"만 하고 즉시 리턴했고, 실제 발송은 아직 시작도 안 했다.
        log.error("메일 발송 실패", e);
    }
    return order;
}
```

`void`는 예외를 담아 돌려줄 그릇이 없다. 이때 예외를 받는 것은 `AsyncUncaughtExceptionHandler`인데, **기본 구현(`SimpleAsyncUncaughtExceptionHandler`)은 에러 로그 한 줄을 남기고 끝난다.** 알림 발송 실패 같은 사고가 로그 파일 어딘가에만 남고 아무에게도 도달하지 않는다는 뜻이다.

```java
// after: 전역 핸들러를 등록해 최소한 관측 가능하게 만든다
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    // AsyncConfigurer를 구현하면 스프링이 이 핸들러를 void @Async 메서드의
    // 미처리 예외 수신자로 등록한다. 기본 구현을 덮어쓰는 유일한 지점이다.
    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) -> {
            log.error("[async-fail] {} params={}", method.getName(), params, ex);
            // 로그만으로는 아무도 안 본다. 여기서 실패 카운터를 올리고
            // 임계치를 넘으면 알림이 가도록 지표에 연결하는 것까지가 설계다.
            meterRegistry.counter("async.failure", "method", method.getName()).increment();
        };
    }
}
```

#### CompletableFuture — 예외가 결과 객체에 담긴다

리턴 타입을 `CompletableFuture`로 바꾸면 예외의 행선지가 달라진다. 스프링이 작업을 `CompletableFuture`로 감싸 제출하기 때문에, 메서드 안에서 터진 예외는 사라지지 않고 **그 Future 안에 "예외로 완료됨" 상태로 저장된다.**

```java
@Async
public CompletableFuture<MailResult> sendWelcomeMail(Long memberId) {
    // 여기서 예외가 나면 스프링이 그 예외를 잡아 반환될 Future에 담는다.
    // 스레드가 조용히 죽는 것이 아니라 "실패라는 결과"가 남는다.
    return CompletableFuture.completedFuture(doSend(memberId));
}
```

호출자가 그 예외를 수령하는 방법은 셋이고, **각각 예외가 다른 껍데기에 싸여 나온다.** (아래는 Java 21에서 직접 실행해 확인한 결과다.)

```java
CompletableFuture<MailResult> future = mailService.sendWelcomeMail(id);

// ① get(): ExecutionException으로 감싸여 나온다. 원인은 getCause()에 들어 있다.
try {
    future.get();
} catch (ExecutionException e) {
    log.error("발송 실패", e.getCause());   // getCause() == 원래 던진 예외
}

// ② join(): CompletionException으로 감싸여 나온다. 체크 예외 선언이 필요 없다.
try {
    future.join();
} catch (CompletionException e) {
    log.error("발송 실패", e.getCause());
}

// ③ exceptionally(): 스레드를 붙잡지 않고 실패를 처리한다.
//    ①②는 결과가 나올 때까지 호출자 스레드를 블로킹하므로,
//    "비동기로 뺀 이득"을 그 자리에서 반납하게 된다는 점에 주의한다.
future.exceptionally(ex -> {
    log.error("발송 실패", ex);
    return MailResult.failed();
});
```

정리하면 **`get()`은 `ExecutionException`, `join()`은 `CompletionException`으로 감싸고, 둘 다 `getCause()`에 원래 예외가 들어 있다.**

여기에 결정적인 단서가 하나 붙는다. **호출자가 결과를 확인하지 않으면(리턴값을 그냥 버리면) `void`와 똑같이 조용히 묻힌다.** `CompletableFuture`는 예외를 **보관**해줄 뿐 누구에게 알려주지는 않기 때문이다. 그래서 정확한 답은 "`CompletableFuture`를 리턴하니 안전하다"가 아니라 **"결과를 소비하는 코드까지 있어야 안전하다"**이다.

### 3-2. 컨텍스트 미전파 — 원인은 셋이 아니라 하나다

`@Async` 메서드 안에서 트랜잭션도 안 이어지고, `SecurityContext`도 비어 있고, MDC의 trace id도 사라진다. 셋을 따로 외울 필요는 없다. **원인이 하나이기 때문이다.**

셋 다 `ThreadLocal`에 저장된다. `ThreadLocal`은 이름 그대로 **스레드마다 별도의 저장 칸을 갖는 변수**로, 같은 객체를 참조해도 스레드가 다르면 다른 값을 본다. 스프링이 요청 스코프의 정보를 메서드 인자로 일일이 넘기지 않고도 어디서든 꺼내 쓸 수 있게 만든 장치다.

```text
[http-nio-8080-exec-3]의 ThreadLocal 저장소     [task-1]의 ThreadLocal 저장소
  ├─ 트랜잭션 리소스(커넥션/EntityManager)         ├─ (비어 있음)
  ├─ SecurityContext(인증 정보)                    ├─ (비어 있음)
  └─ MDC(traceId=abc-123)                          └─ (비어 있음)

           작업만 큐를 통해 넘어간다 ────────────>  저장소는 넘어가지 않는다
```

`executor.submit()`으로 넘어가는 것은 **실행할 코드(Runnable)뿐**이다. 호출자 스레드의 `ThreadLocal` 저장소는 그 스레드에 그대로 남는다. 그래서 새 스레드는 언제나 빈손으로 시작한다.

이 하나의 원인에서 세 가지 증상이 각각 다른 모습으로 나온다.

**트랜잭션**: 스프링의 트랜잭션은 커넥션(JPA라면 `EntityManager`)을 `ThreadLocal`에 묶어두고 같은 스레드의 쿼리들이 그것을 공유하게 하는 구조다(원리는 `24-transaction-synchronization-connection-binding.md`). 스레드가 바뀌면 그 바인딩이 없으므로, `@Async` 메서드에 `@Transactional`을 같이 붙이면 동작은 하지만 **호출자와 완전히 별개인 새 트랜잭션**이 열린다. 호출자가 롤백돼도 `@Async` 쪽은 커밋될 수 있고 그 역도 성립한다. 게다가 호출자가 커밋하기 **전에** `@Async` 쪽이 먼저 실행될 수 있어, 방금 저장한 데이터를 조회했는데 안 보이는 타이밍 문제까지 생긴다. 커밋 이후를 보장해야 한다면 이 조합이 아니라 `16-spring-event-transactional-event-listener.md`의 `AFTER_COMMIT`으로 시점을 고정해야 한다.

**SecurityContext**: 기본 전략인 `MODE_THREADLOCAL`에서는 새 스레드에 인증 정보가 없다. `SecurityContextHolder.getContext().getAuthentication()`이 `null`이 되어, `@PreAuthorize`가 붙은 메서드를 호출하면 권한 없음으로 실패한다.

**MDC**: MDC(Mapped Diagnostic Context)는 로그 프레임워크가 스레드별로 들고 있는 키-값 저장소로, 요청마다 부여한 trace id를 모든 로그 줄에 자동으로 찍기 위해 쓴다. 새 스레드에서는 비어 있으므로 **비동기 구간부터 로그 추적이 뚝 끊긴다.** 장애 분석 때 "이 메일 발송 실패 로그가 어느 요청 건인지 못 찾는" 형태로 대가를 치른다.

#### 해법 ① `TaskDecorator` — 제출 시점에 캡처해 실행 시점에 복원

`TaskDecorator`는 풀에 제출되는 모든 `Runnable`을 한 번 감쌀 수 있게 해주는 확장점이다. 감싸는 코드는 **호출자 스레드에서** 실행되므로, 그 시점에 컨텍스트를 복사해 두었다가 워커 스레드에서 되살릴 수 있다.

```java
public class ContextCopyingDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable task) {
        // ① 이 세 줄은 decorate()를 호출한 스레드 = 호출자(톰캣) 스레드에서 실행된다.
        //    그래서 아직 컨텍스트가 살아 있고, 지금이 복사할 수 있는 유일한 시점이다.
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        SecurityContext security = SecurityContextHolder.getContext();

        return () -> {
            // ② 이 람다 안은 워커 스레드에서 실행된다. 캡처해 둔 값을 자기 ThreadLocal에 심는다.
            try {
                if (mdc != null) MDC.setContextMap(mdc);
                SecurityContextHolder.setContext(security);
                task.run();
            } finally {
                // ③ 풀 스레드는 재사용된다 — 이 작업이 끝나면 같은 스레드가 다른 사용자의
                //    작업을 받는다. 안 지우면 A의 인증 정보로 B의 작업이 도는 보안 사고가 된다.
                MDC.clear();
                SecurityContextHolder.clearContext();
            }
        };
    }
}
```

```java
executor.setTaskDecorator(new ContextCopyingDecorator());
```

③의 청소가 특히 중요하다. 톰캣도 스프링도 요청이 끝나면 자기 `ThreadLocal`을 청소해주지만, **내가 직접 심은 값은 내가 지워야 한다.** 안 지우면 다음 작업에 앞 사용자의 인증 정보와 trace id가 묻어 들어간다.

트랜잭션은 이 방식으로 옮기지 않는다. 커넥션은 복사할 수 있는 값이 아니라 **한 번에 한 스레드만 써야 하는 자원**이라, 두 스레드가 같은 커넥션을 동시에 쓰면 그때부터는 정합성 문제가 아니라 커넥션 상태 손상 문제가 된다.

#### 해법 ② 기성품 데코레이터를 쓴다

`SecurityContext`만 필요하다면 Spring Security가 제공하는 `DelegatingSecurityContextAsyncTaskExecutor`로 기존 실행기를 감싸면 된다. 직접 짠 데코레이터와 달리 청소 로직까지 검증돼 있다.

```java
@Bean
public AsyncTaskExecutor mailExecutor() {
    ThreadPoolTaskExecutor delegate = new ThreadPoolTaskExecutor();
    // ... core/max/queue/거부 정책 설정 (2-4) ...
    delegate.initialize();
    // 이 래퍼가 제출 시점의 SecurityContext를 캡처해 워커 스레드에 심고,
    // 작업이 끝나면 원래 상태로 되돌려 놓는 일까지 대신한다.
    return new DelegatingSecurityContextAsyncTaskExecutor(delegate);
}
```

MDC까지 함께 옮겨야 하면 두 방식을 합치거나, 관측 라이브러리(Micrometer Context Propagation 등)가 제공하는 전파 장치를 쓴다. 어느 쪽이든 **"제출 시점에 캡처해서 실행 시점에 복원하고 끝나면 청소한다"**는 뼈대는 동일하다.

### 3-3. 인메모리 큐 — 재시작하면 대기 중인 작업이 통째로 사라진다

`@Async`의 큐는 **JVM 힙 위에 있는 자바 객체**다(`LinkedBlockingQueue`). 이 한 문장에서 판단 기준이 전부 나온다.

- **프로세스가 내려가면 큐도 같이 사라진다.** 배포로 인한 재시작이든 크래시든 마찬가지다. 대기 중이던 작업은 흔적도 없이 없어지고, 실행 중이던 작업은 중간에 끊긴다. 재시도도, 유실 감지도, "몇 건이 사라졌는지"를 아는 방법조차 없다.
- **큐가 그 서버 안에 있으므로 다른 서버가 나눠 처리할 수 없다.** 한 서버의 async 풀이 포화돼도 옆 서버는 그 사실조차 모른다. 처리량의 상한이 그 서버의 스레드풀 하나로 고정된다.

그레이스풀 셧다운(`server.shutdown=graceful`)을 켜면 진행 중인 요청은 기다려주지만, 그것은 **톰캣 스레드**의 이야기다. async 풀까지 안전하게 비우려면 `setWaitForTasksToCompleteOnShutdown(true)`와 `setAwaitTerminationSeconds(...)`를 별도로 줘야 하고, 그마저 대기 시간을 넘긴 작업은 결국 버려진다. 크래시에는 아무 대비도 되지 않는다.

#### 그래서 언제 메시지 큐로 갈아타는가

판단 기준은 단 하나, **"이 작업이 유실돼도 되는가"**다.

| 판단 기준 | `@Async`로 충분 | 메시지 큐(RabbitMQ, Kafka)로 |
|---|---|---|
| 유실 허용 | 유실돼도 재시도하거나 무시 가능 (캐시 워밍, 조회수 집계) | 유실 불가 (결제 후처리, 포인트 적립, 정산) |
| 재시도·실패 추적 | 불필요 | 필요 — 재시도 큐와 DLQ로 실패 건을 붙잡아 둔다 |
| 처리 주체 | 같은 프로세스 안에서 처리해도 됨 | 별도 컨슈머로 분리·확장해야 함 |
| 부하 분산 | 그 서버 한 대로 충분 | 컨슈머를 늘려 여러 대가 나눠 처리 |

브로커가 이 문제를 푸는 방식을 한 줄로 요약하면 **"큐를 프로세스 밖의 디스크로 옮기고, 처리 완료를 확인받은 뒤에야 큐에서 지운다"**이다. RabbitMQ라면 컨슈머의 ack를 받아야 메시지를 제거하고, ack 없이 연결이 끊기면 다른 컨슈머에게 다시 전달한다. 실패한 메시지는 DLQ(dead letter queue, 처리에 반복 실패한 메시지를 모아두는 별도 큐)로 보내 사람이 확인할 수 있게 남긴다. Kafka라면 메시지를 로그에 append해 보관 기간 동안 유지하고 컨슈머가 오프셋을 커밋하는 방식으로, 재처리와 리플레이가 쉽다는 성격이 더해진다. 어느 쪽이든 `@Async`의 인메모리 큐에는 없는 **"프로세스가 죽어도 남는다"**는 성질이 핵심이다.

한 단계 더 나아간 요구가 하나 있다. **"DB 커밋과 메시지 발행이 원자적이어야 한다"** — 주문은 저장됐는데 발행만 실패하는 사고를 막아야 하는 경우다. DB와 브로커는 서로 다른 시스템이라 하나의 트랜잭션으로 묶을 수 없으므로, 발행할 메시지를 **같은 DB의 outbox 테이블에 INSERT**해 비즈니스 변경과 한 트랜잭션으로 커밋하고, 별도 릴레이 프로세스가 그 테이블을 읽어 발행한다. 이것이 **트랜잭셔널 아웃박스 패턴**이고 `23-transactional-outbox-pattern.md`에서 다룬다.

결론은 이 한 문장이다. **`@Async`는 "빨라 보이게 하는 도구"이지 "반드시 실행됨을 보장하는 도구"가 아니다.** 도구를 성능이 아니라 **내구성 요구사항**을 기준으로 고르는 것이 이 파트의 핵심이다.

## 4. 꼬리질문 대비 포인트

### "void @Async 메서드에서 예외가 나면 어디로 가나? 어떻게 관측하나?"

호출자에게는 절대 전달되지 않는다. 호출자는 작업을 제출하고 이미 리턴받아 떠났고, `void`라 예외를 담아 돌려줄 그릇도 없기 때문이다.

예외는 `AsyncUncaughtExceptionHandler`가 받는데 **기본 구현은 에러 로그 한 줄**이라 사실상 조용히 묻힌다. 관측하려면 `AsyncConfigurer`를 구현해 커스텀 핸들러를 등록하고 로그와 함께 지표·알림을 태우거나, 애초에 `CompletableFuture`를 리턴하고 호출자가 `exceptionally` 등으로 결과를 소비하게 설계한다.

**후자도 리턴값을 버리면 똑같이 묻힌다**는 점까지 말해야 완결이다.

### "@Async가 쓰는 스레드풀은 톰캣 요청 스레드풀과 같은 건가?"

완전히 별개다. 톰캣 풀은 서블릿 컨테이너가 관리하고(`server.tomcat.threads.*`, 기본 max 200, 스레드 이름 `http-nio-...-exec-N`), `@Async` 풀은 스프링 빈 `applicationTaskExecutor`다(`spring.task.execution.*`, 기본 core 8, 이름 `task-N`).

요청 스레드는 작업을 제출한 뒤 응답을 내보내고 풀로 반납되며, 실제 실행은 그 뒤에 워커 스레드에서 일어난다 — **응답이 빨라지는 건 일이 줄어서가 아니라 점유하는 풀이 바뀌어서**다.

여기서 세 가지가 따라온다. 톰캣이 200개여도 비동기 동시 처리 상한은 core 8개라 용량 산정을 따로 해야 하고, `CallerRunsPolicy`는 그 경계를 뚫어 톰캣 스레드가 작업을 떠맡게 만들며, `ThreadLocal`(`SecurityContext`·MDC·트랜잭션)이 안 넘어가는 이유도 결국 이 분리다.

**단, 스레드풀은 갈라져도 HikariCP 커넥션풀은 공유**하므로 async 풀만 키우면 병목이 커넥션풀로 옮겨간다는 점까지 말하면 완결이다.

### "max-size를 늘렸는데 동시 처리가 core 개수에서 안 늘어난다 — 왜?" (시니어 변별 포인트)

`ThreadPoolExecutor`의 분기 순서 때문이다. core가 다 바쁘면 스레드를 늘리는 게 아니라 **큐에 먼저 넣고**, **큐가 가득 차야** max까지 스레드를 추가한다.

스프링 부트 기본 `queue-capacity`가 `Integer.MAX_VALUE`(사실상 무제한)라 큐가 영원히 안 차고, 따라서 `max-size`는 값이 얼마든 도달 불가능한 설정이 된다. 동시 처리는 core=8에 고정되고 나머지는 큐에서 무한 대기하며, 큐에 쌓인 객체가 힙을 잠식해 OOM까지 갈 수 있다.

해결은 `queue-capacity`를 유한하게 제한하는 것이고, 그 순간 거부 상황이 생기므로 **거절 정책까지 한 세트로** 설계해야 한다. 큐 길이는 "최악의 대기 시간 = 큐 길이 ÷ 초당 처리 건수"로 역산해 잡는다고 말하면 근거까지 갖춘 답이 된다.

### "큐까지 가득 차면 어떻게 되나?"

`RejectedExecutionHandler`가 호출된다.

기본인 `AbortPolicy`는 `RejectedExecutionException`을 던져 호출자가 실패를 인지하게 한다. `CallerRunsPolicy`는 호출자 스레드가 그 작업을 직접 실행해 유입 속도가 자연히 줄어드는 백프레셔 효과를 내지만, **그 호출자가 톰캣 요청 스레드라면 async 풀의 포화가 톰캣 풀 고갈로 번진다**는 대가가 있고 그 순간은 동기 실행이 된다.

`DiscardPolicy`는 조용히 버리고 `DiscardOldestPolicy`는 큐에서 가장 오래된 것을 버린다 — 유실을 아무도 모르게 되므로 명시적 근거 없이는 쓰지 않는다.

### "@Async와 @Transactional을 한 메서드에 같이 붙이면?"

동작은 하지만 **호출자 트랜잭션과는 완전히 별개**다. 트랜잭션은 커넥션을 `ThreadLocal`에 묶는 구조라 스레드가 바뀌는 순간 남남이 되고, `@Async` 쪽은 자기 스레드에서 새 트랜잭션을 연다.

그래서 호출자가 롤백돼도 `@Async` 쪽은 커밋될 수 있고(역도 성립), 호출자 커밋 전에 `@Async`가 먼저 돌아 "방금 저장한 데이터가 안 보이는" 타이밍 문제도 난다.

커밋 이후를 보장해야 하면 `@TransactionalEventListener(phase = AFTER_COMMIT)`로 시점을 고정하고, 그 위에 `@Async`를 얹어 실행 스레드까지 분리한다(`16-spring-event-transactional-event-listener.md`). 유실까지 막아야 하면 아웃박스 패턴으로 설계를 바꾼다.

### "@Async 작업이 큐에 쌓인 채 서버가 재시작되면?"

전부 유실된다. `@Async`의 큐는 JVM 힙 위의 자바 객체라 프로세스가 내려가면 같이 사라지고, 실행 중이던 작업도 중간에 끊긴다. 재시도도 유실 감지도 없다.

`setWaitForTasksToCompleteOnShutdown(true)`로 정상 종료 시 큐를 비울 시간을 벌 수는 있지만, 대기 시간을 넘긴 작업은 결국 버려지고 크래시에는 아무 대비가 안 된다.

그래서 유실돼도 되는 작업(캐시 워밍, 통계 집계)에만 `@Async`를 쓰고, 유실 불가한 작업(결제 후처리, 포인트 적립)은 브로커가 디스크에 보존하고 ack 기반으로 재전달해주는 메시지 큐(RabbitMQ, Kafka)로, DB 커밋과의 원자성까지 필요하면 아웃박스 패턴으로 간다. **도구를 성능이 아니라 내구성 요구사항 기준으로 고르는 것**이 답의 핵심이다.

### "같은 클래스 안에서 this.asyncMethod()를 부르면?"

비동기가 아니라 **조용히 동기 실행**된다. 비동기 전환 코드는 프록시에 있는데 `this` 호출은 프록시를 거치지 않고 원본을 직접 부르기 때문이다 — `@Transactional`의 자기 호출 미적용과 완전히 같은 원리다.

에러가 없어서 "비동기로 뺐는데 응답이 안 빨라진다"로만 드러난다. 해결은 해당 메서드를 별도 빈으로 분리하는 것이 정석이며, 대안들의 대가는 `11-transactional-self-invocation.md`에 정리돼 있다.

### "가상 스레드를 켜면 이 튜닝은 다 필요 없어지나?" (가산점 포인트)

Spring Boot 3.2 이상에서 `spring.threads.virtual.enabled=true`를 주면 `@Async`가 풀링 없는 실행기로 바뀌므로 **core/max/queue라는 손잡이 자체가 사라진다.**

하지만 "튜닝이 필요 없어진다"가 아니라 **"튜닝할 지점이 이동한다"**가 맞다. 스레드가 사실상 무제한이 되면 동시 실행 수를 막아주던 방벽이 없어지므로, 병목은 그다음 유한한 자원 — HikariCP 커넥션풀, 외부 API의 처리량, DB의 동시 처리 능력 — 으로 옮겨간다. 이전에는 core 8이 자연스러운 동시성 제한 역할을 해줬다는 사실을 짚으면 이해도가 드러난다.

---

## 한 줄 요약

`@Async`는 프록시가 호출을 가로채 **톰캣 요청 스레드풀과는 별개인** 인메모리 큐에 작업을 던지고 즉시 리턴하는 구조이며, 자기 호출 미적용·"큐가 차야 max가 는다"는 분기 순서와 무제한 기본 큐가 만드는 동시 처리 8개 고정·`void` 예외의 조용한 증발·`ThreadLocal`이라 넘어가지 않는 트랜잭션과 `SecurityContext`와 MDC·재시작 시 작업 유실이 전부 그 한 문장에서 파생되므로, 이 파생 관계를 아는 사람은 설정 네 개(core·max·queue·거부 정책)를 한 세트로 설계하고 내구성이 필요한 순간에는 도구 자체를 브로커나 아웃박스로 바꾼다.
