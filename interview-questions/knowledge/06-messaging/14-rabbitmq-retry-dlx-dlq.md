# RabbitMQ 재시도와 DLQ 설계 — DLX, TTL 지연 재시도, 그리고 requeue 무한 루프

> 핵심 관전 포인트: **RabbitMQ에는 "실패한 메시지를 자동으로 보낼 곳"이 브로커 기능으로 있다 — 큐에 `x-dead-letter-exchange`를 걸어두면 거부되거나(nack requeue=false) TTL이 만료되거나 큐 길이 한도를 넘긴 메시지가 그 exchange로 넘어간다. 여기서 실무의 핵심 트릭이 나온다. DLX가 다시 원래 큐를 가리키게 하면 "지연 재시도"가 공짜로 만들어진다 — TTL 5초짜리 대기 큐에 넣었다가 만료되면 본 큐로 돌아오는 구조다. 반대로 절대 하면 안 되는 것이 `basic.nack(requeue=true)`의 무제한 반복이다. 지연이 전혀 없어 초당 수천 번 재시도하며 CPU를 태우고, 파싱 불가 메시지 하나가 워커 전체를 마비시킨다. 그리고 Spring AMQP의 기본값이 바로 requeue=true라서, 아무 설정도 안 한 컨슈머는 첫 번째 불량 메시지에서 이 루프에 빠진다.**

---

## 0. 질문 + 의도

**질문**: "RabbitMQ에서 재시도와 DLQ를 어떻게 설계하나요? (Dead Letter Exchange, TTL 기반 지연 재시도, requeue 무한 루프 함정)"

**출제 의도**: Kafka의 재시도 토픽에 대응하는 RabbitMQ의 표준 해법을 아는지 본다. 특히 `basic.nack(requeue=true)`가 만드는 무한 루프는 실무에서 CPU를 100%로 태우는 대표적 사고다. 실패 경로를 설계하지 않은 컨슈머가 치르는 대가를 겪어봤는지, 그리고 "재시도할 가치가 있는 실패"와 "몇 번을 해도 같은 실패"를 구분하는 감각이 있는지 확인한다.

## 1. 전제 — 실패는 두 종류이고 대응이 정반대다

### 1-1. 분류가 먼저다

컨슈머가 메시지 처리에 실패했다. 재시도해야 하는가?

답은 **실패의 원인이 시간에 따라 변하는가**에 달렸다.

**일시적 실패(transient)**는 지금은 실패하지만 나중엔 성공할 수 있는 것이다. DB 커넥션 풀 고갈, 외부 API 타임아웃, 락 경합, 배포 중인 다운스트림 서비스. 이런 것들은 **잠시 뒤 다시 하면 성공한다.**

**영구적 실패(permanent)**는 몇 번을 해도 결과가 같은 것이다. JSON 파싱 불가, 필수 필드 누락, 존재하지 않는 상품 ID, 비즈니스 규칙 위반. **재시도는 자원 낭비이며, 즉시 격리해 사람이 봐야 한다.**

이 분류를 코드에서 표현하지 않으면 둘 중 하나가 된다. 전부 재시도하면 영구 실패가 무한 루프를 돌고, 전부 격리하면 일시적 네트워크 흔들림 하나로 DLQ가 가득 찬다.

```java
// 코드로 표현한 분류 — 예외 타입이 곧 실패 유형이다
try {
    handler.handle(event);
} catch (DataAccessResourceFailureException | ResourceAccessException e) {
    throw e; // 일시적 -> 재시도 대상 (프레임워크가 재시도 후 지연 큐로)
} catch (JsonParseException | ValidationException e) {
    // 영구적 -> 되돌리지 말고 즉시 DLQ로
    throw new AmqpRejectAndDontRequeueException("복구 불가 메시지", e);
}
```

`AmqpRejectAndDontRequeueException`은 Spring AMQP가 특별 취급하는 예외로, **재시도 없이 곧바로 거부**하게 만든다. 영구 실패를 표현하는 표준 수단이다.

### 1-2. Kafka와 비교하면 RabbitMQ가 유리한 지점

이 문제에서 RabbitMQ는 구조적 이점이 있다.

Kafka의 오프셋은 "여기까지 처리했다"는 숫자 하나라서, 5번 메시지가 계속 실패하면 6번 이후를 처리할 방법이 없다. **한 건이 파티션 전체를 막는다**(poison pill). 그래서 재시도 토픽이라는 우회로를 반드시 설계해야 한다.

RabbitMQ는 메시지마다 상태를 추적하므로 **실패한 한 건만 떼어내 DLQ로 보내고 나머지는 그대로 흘려보낼 수 있다.** 뒤가 막히지 않는다.

```
Kafka:      [1][2][3][4:실패][5][6][7]
                      ^^^^^^ 여기서 오프셋이 멈추면 5,6,7도 대기

RabbitMQ:   [1:ack][2:ack][3:ack][4:nack->DLQ][5:ack][6:ack]
                                  ^^^^^^^^^^^ 4만 격리, 나머지 정상 진행
```

**단, 이 이점은 컨슈머가 여러 건을 동시에 처리할 수 있을 때의 이야기다.** prefetch=1에 컨슈머 1대이고 그 한 건을 계속 requeue하면, 결국 그 메시지가 계속 앞에 서 있어 뒤가 막힌다. 구조가 유리해도 설계를 안 하면 같은 곳에 도달한다.

## 2. Dead Letter Exchange — 실패 메시지가 흘러가는 길

### 2-1. 무엇이 dead letter가 되는가

**Dead letter(사장 편지)**는 우편에서 "배달도 반송도 못 하는 편지"를 뜻하는 말이다. RabbitMQ는 큐에 `x-dead-letter-exchange` 인자를 주면, 아래 세 경우에 메시지를 그 exchange로 넘긴다.

| 조건 | 언제 발생하나 | x-death의 reason |
|---|---|---|
| `basic.nack`/`basic.reject`를 `requeue=false`로 | 컨슈머가 "다시 주지 마라"며 거부 | `rejected` |
| 메시지 TTL 만료 | 큐나 메시지에 설정한 수명이 다 됨 | `expired` |
| 큐 길이 한도 초과 | `x-max-length`를 넘겨 오래된 것부터 밀려남 | `maxlen` |

세 번째는 잘 안 쓰이지만, 두 번째가 이 문서의 핵심 도구다. **"TTL이 만료되면 DLX로 간다"는 성질을 뒤집어 쓰면 지연 재시도가 만들어진다.**

### 2-2. 기본 구성

```java
@Bean Queue paymentQueue() {
    return QueueBuilder.durable("payment.process")
            .deadLetterExchange("payment.dlx")        // 실패 시 갈 곳
            .deadLetterRoutingKey("payment.dead")     // 그때 붙일 라우팅 키
            .build();
}

@Bean DirectExchange paymentDlx() { return new DirectExchange("payment.dlx"); }

@Bean Queue paymentDlq() { return QueueBuilder.durable("payment.dlq").build(); }

@Bean Binding dlqBinding() {
    return BindingBuilder.bind(paymentDlq()).to(paymentDlx()).with("payment.dead");
}
```

`deadLetterRoutingKey`를 지정하지 않으면 **원래 라우팅 키가 그대로 유지된다.** 이것이 뜻밖의 사고를 만든다 — DLX가 원본 exchange와 같은 바인딩 구조를 갖고 있으면 메시지가 원래 큐로 돌아가 순환한다. **DLX용 라우팅 키를 명시하는 습관**이 안전하다.

### 2-3. x-death 헤더 — 몇 번 죽었는지 브로커가 세어 준다

메시지가 dead letter가 될 때마다 브로커는 `x-death`라는 헤더 배열을 붙이거나 갱신한다. 여기에는 **원래 큐 이름, 이유, 시각, 그리고 몇 번째인지(count)**가 들어 있다.

이 count가 실무에서 매우 유용하다. **애플리케이션이 재시도 횟수를 따로 저장하지 않아도, 브로커가 세어준 값으로 "이제 그만하고 DLQ로"를 판단할 수 있다.**

```java
@SuppressWarnings("unchecked")
private int deathCount(Message message) {
    List<Map<String, Object>> deaths =
            (List<Map<String, Object>>) message.getMessageProperties()
                    .getHeaders().get("x-death");
    if (deaths == null || deaths.isEmpty()) return 0;
    // count는 "같은 큐/이유 조합으로 몇 번 죽었는가"를 브로커가 누적한 값이다
    return ((Long) deaths.get(0).get("count")).intValue();
}
```

주의할 점이 하나 있다. **메시지를 새로 발행하면 `x-death`가 초기화된다.** 재시도 구현이 "원본을 그대로 되돌리는" 방식이면 count가 누적되지만, "새 메시지로 다시 발행하는" 방식이면 매번 0부터 시작해 무한 재시도가 된다. 후자를 쓴다면 재시도 횟수를 **커스텀 헤더에 직접 담아 증가**시켜야 한다.

## 3. 지연 재시도 — TTL과 DLX를 엮는 표준 패턴

### 3-1. 즉시 재시도가 왜 나쁜가

일시적 실패에 즉시 재시도하면 대개 또 실패한다. DB가 죽어 있는데 1ms 뒤에 살아날 리 없다. 그런데 즉시 재시도는 **부하를 더한다.** 다운스트림이 힘들어서 실패한 것인데 재시도가 트래픽을 증폭시켜 회복을 더 어렵게 만든다.

그래서 재시도에는 **지연**이 필요하고, 보통 **점점 늘어나는 지연(exponential backoff)**을 쓴다: 5초 → 30초 → 5분.

문제는 **RabbitMQ의 큐에는 "N초 뒤에 배달" 기능이 없다**는 것이다. 큐는 들어온 순서대로 즉시 내보낸다. 그래서 우회가 필요하다.

### 3-2. 대기 큐(wait queue) 패턴

핵심 아이디어는 **컨슈머가 없는 큐에 TTL을 걸어두고, 만료되면 DLX를 통해 본 큐로 돌려보내는 것**이다.

```
                     처리 실패 (nack, requeue=false)
[본 큐: payment.process] ---------------------------> [payment.retry.dlx]
        ^                                                     |
        |                                                     v
        |                                         [대기 큐: payment.retry.5s]
        |                                          - x-message-ttl: 5000
        |                                          - 컨슈머 없음 (아무도 안 가져간다)
        |                                          - x-dead-letter-exchange: payment.exchange
        |                                                     |
        +------------- 5초 뒤 TTL 만료 -> DLX로 방출 ----------+
```

대기 큐에는 **컨슈머를 붙이지 않는다.** 아무도 가져가지 않으므로 메시지는 TTL이 다할 때까지 그 자리에 머물고, 만료되는 순간 dead letter가 되어 본 큐로 되돌아간다. **"컨슈머 없는 큐 + TTL"이 곧 타이머**인 셈이다.

단계별 백오프가 필요하면 대기 큐를 여러 개 만든다.

```java
// 5초, 30초, 5분 — 세 단계 대기 큐
@Bean Queue retry5s()  { return delayQueue("payment.retry.5s",  5_000); }
@Bean Queue retry30s() { return delayQueue("payment.retry.30s", 30_000); }
@Bean Queue retry5m()  { return delayQueue("payment.retry.5m",  300_000); }

private Queue delayQueue(String name, int ttlMillis) {
    return QueueBuilder.durable(name)
            .ttl(ttlMillis)                                // 이 큐의 모든 메시지 수명
            .deadLetterExchange("payment.exchange")        // 만료되면 본 exchange로
            .deadLetterRoutingKey("payment.process")       // 본 큐로 라우팅
            .build();
}

// 컨슈머는 x-death count를 보고 다음 단계 대기 큐를 고른다
private String nextRetryQueue(int attempt) {
    return switch (attempt) {
        case 0 -> "payment.retry.5s";
        case 1 -> "payment.retry.30s";
        case 2 -> "payment.retry.5m";
        default -> "payment.dlq";   // 상한 초과 -> 사람이 봐야 한다
    };
}
```

### 3-3. 반드시 알아야 할 함정 — head-of-line blocking

여기서 실무자를 가르는 지점이 나온다. **TTL을 큐 단위(`x-message-ttl`)가 아니라 메시지 단위(`expiration` 속성)로 주면 순서 문제가 생긴다.**

RabbitMQ는 큐의 **맨 앞 메시지만** 만료 여부를 검사한다. 뒤쪽에 있는 메시지는 앞의 것이 나가야 검사 대상이 된다.

```
대기 큐 (메시지마다 다른 TTL을 준 경우)

  [앞] TTL 5분 남음 | TTL 5초 남음 | TTL 5초 남음 [뒤]
        ^^^^^^^^^^
        이게 만료될 때까지 뒤의 두 건은 검사조차 되지 않는다
        -> 5초짜리들이 5분을 기다린다
```

그래서 **지연 시간이 서로 다르면 대기 큐를 나눠야 한다.** 5초 큐, 30초 큐, 5분 큐를 따로 두면 각 큐 안에서는 TTL이 모두 같으므로 앞의 것이 먼저 만료되어 순서가 자연스럽게 맞는다.

**"메시지 단위 TTL은 큐 안의 지연 시간이 모두 같을 때만 안전하다"**는 문장을 말할 수 있으면 실제로 구현해본 사람이다. (가산점 포인트)

### 3-4. 애플리케이션 내부 재시도와의 역할 분담

Spring AMQP는 리스너 컨테이너 수준의 재시도도 제공한다.

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        default-requeue-rejected: false   # 무한 루프 방지 (4절)
        retry:
          enabled: true
          max-attempts: 3
          initial-interval: 200ms
          multiplier: 2
```

이것은 **같은 스레드에서 sleep하며 재시도**한다. 그래서 성질이 다르다.

| | 인프로세스 재시도 (Spring retry) | 대기 큐 재시도 (TTL + DLX) |
|---|---|---|
| 지연 동안 | 스레드가 잡혀 있다 | 스레드가 자유롭다 |
| 적합한 지연 | 밀리초~수 초 | 수 초~수 시간 |
| 컨슈머 재시작 시 | 재시도 상태가 사라진다 (메시지는 unacked라 복구됨) | 브로커에 남아 있어 무관 |
| 순서 | 그 메시지가 앞을 막는다 | 뒤로 빠지므로 안 막는다 |

**둘을 같이 쓰는 것이 정석이다.** 짧은 흔들림은 인프로세스 재시도로 즉시 흡수하고(수백 ms), 그래도 실패하면 대기 큐로 넘겨 길게 기다린다(수 분). 인프로세스만 쓰면 긴 장애에서 스레드가 다 잠기고, 대기 큐만 쓰면 아주 짧은 흔들림에도 왕복 비용을 치른다.

## 4. requeue 무한 루프 — 가장 흔한 사고

### 4-1. 어떻게 만들어지는가

`basic.nack(requeue=true)`는 메시지를 **지연 없이 즉시** 큐로 되돌린다. 그 메시지가 다시 배달되고, 또 실패하고, 또 되돌아간다.

```
[컨슈머] 수신 -> 파싱 실패 -> nack(requeue=true)
    ^                                |
    +---------- 지연 0ms ------------+

초당 수천 회. CPU 100%. 처리량 0. 로그 폭증으로 디스크까지 찬다.
```

**Spring AMQP의 `default-requeue-rejected` 기본값이 `true`**라는 점이 이 사고를 흔하게 만든다. 리스너에서 예외를 던지면 프레임워크가 requeue하므로, 별도 설정 없이 파싱 불가 메시지 하나만 들어오면 바로 이 상태가 된다.

### 4-2. 세 가지 방어선

**첫째, 기본값을 바꾼다.** `default-requeue-rejected: false`로 두면 실패한 메시지가 DLX로 넘어간다. 재시도가 필요하면 위의 대기 큐 구조를 명시적으로 설계한다.

**둘째, 재시도 상한을 건다.** Spring의 `max-attempts`, 또는 `x-death` count 기반 판단으로 상한을 넘으면 DLQ로 보낸다.

**셋째, 브로커 수준 안전망을 건다.** quorum queue에는 `x-delivery-limit` 설정이 있어 **같은 메시지가 지정 횟수를 넘겨 배달되면 브로커가 자동으로 dead letter 처리**한다. 애플리케이션 버그로 무한 requeue가 발생해도 브로커가 끊어준다.

```java
@Bean Queue paymentQueue() {
    return QueueBuilder.durable("payment.process")
            .quorum()                                 // quorum queue로 선언
            .deliveryLimit(5)                         // 5회 배달 후 자동 dead letter
            .deadLetterExchange("payment.dlx")
            .build();
}
```

세 번째를 아는 것이 변별점이다. **애플리케이션이 실수해도 인프라가 막아주는 층을 하나 두는 것**이 운영 관점의 사고다.

### 4-3. 진단 방법

이 사고가 났을 때의 증상은 특징적이다.

- CPU가 높은데 **처리량(ack rate)은 0에 가깝다.**
- 큐의 **Ready 수는 그대로**인데 **deliver rate만 비정상적으로 높다.** 배달은 되는데 완료가 안 된다는 뜻이다.
- 컨슈머 로그에 **같은 메시지 ID의 같은 에러**가 반복된다.

관리 콘솔에서 `deliver rate`와 `ack rate`를 나란히 보면 즉시 판별된다. **둘의 차이가 곧 재배달량**이다.

## 5. DLQ 운영 — 버리는 곳이 아니라 병원이다

### 5-1. 진단 정보를 함께 담는다

DLQ에 메시지 본문만 들어 있으면 "왜 실패했는지" 알 수 없다. 원본 메시지는 실패 이유를 모른다.

Spring AMQP의 `RepublishMessageRecoverer`는 이 문제를 위해 있다. 재시도 소진 시 메시지를 **지정한 exchange로 다시 발행하면서 예외 정보를 헤더에 붙인다.**

```java
@Bean
MessageRecoverer messageRecoverer(RabbitTemplate template) {
    // 단순 거부 대신 재발행 -> 스택트레이스와 원인 예외가 헤더로 붙는다
    // x-exception-message, x-exception-stacktrace, x-original-exchange,
    // x-original-routingKey 등이 자동 추가된다
    return new RepublishMessageRecoverer(template, "payment.dlx", "payment.dead");
}
```

여기에 직접 담으면 좋은 것들이 더 있다. **실패 시각, 컨슈머 애플리케이션 버전, 요청 추적 ID(trace id).** 특히 추적 ID가 있으면 DLQ 메시지 하나에서 전체 호출 경로 로그로 바로 넘어갈 수 있다.

### 5-2. 유입 자체를 알람으로 건다

DLQ는 **정상 상태에서 비어 있어야 하는 큐**다. 그래서 알람 조건이 단순하다. **깊이가 0보다 크면 알람.**

임계치를 100건 같은 값으로 잡는 것은 좋지 않다. 결제 실패 1건은 그 자체로 사람이 봐야 하는 사건이기 때문이다. 대신 **큐마다 심각도를 다르게** 두면 된다 — 결제 DLQ는 즉시 호출, 알림 DLQ는 근무 시간 내 확인.

또 하나 유용한 지표는 **DLQ 유입 속도**다. 갑자기 초당 수십 건이 들어오면 개별 메시지 문제가 아니라 **다운스트림 장애**다. 이때는 메시지를 보는 것보다 다운스트림을 먼저 봐야 한다.

### 5-3. 재투입(redrive) 절차를 미리 만든다

DLQ에 쌓인 메시지는 원인을 고친 뒤 다시 처리해야 한다. 이 절차를 **장애 상황에서 처음 만들면 늦는다.**

RabbitMQ에는 `rabbitmq_shovel`이라는 플러그인이 있어 **한 큐의 메시지를 다른 큐/exchange로 옮길 수 있다.** DLQ → 본 exchange로 shovel을 임시로 걸었다가 비면 끄는 방식이 손이 가장 덜 간다.

직접 구현한다면 이런 컨슈머를 만들어 둔다.

```java
// 평소에는 꺼져 있다가 운영자가 켜서 돌리는 재투입 컨슈머
@RabbitListener(queues = "payment.dlq", autoStartup = "false", id = "dlqRedrive")
public void redrive(Message message) {
    // 재투입 이력을 남긴다 — 몇 번 재투입됐는지 모르면 또 무한 루프다
    message.getMessageProperties().setHeader("x-redrive-count",
            redriveCount(message) + 1);
    rabbitTemplate.send("payment.exchange", "payment.process", message);
}
// 운영자가 rabbitListenerEndpointRegistry.getListenerContainer("dlqRedrive").start()
```

재투입에서 반드시 지킬 것이 셋이다.

- **속도를 제한한다.** DLQ에 10만 건이 있는데 한 번에 밀어 넣으면 이제 막 회복한 다운스트림이 다시 죽는다.
- **재투입 횟수를 헤더에 남긴다.** 원인이 안 고쳐졌는데 재투입하면 DLQ → 본 큐 → DLQ 순환이 된다.
- **원인을 먼저 고친다.** 당연해 보이지만, 장애 대응 중에 "일단 다시 돌려보자"는 유혹이 크다.

## 6. 꼬리질문 대비 포인트

### "DLQ 대신 그냥 로그만 남기고 버리면 안 되나요?"

로그는 **재처리할 수 없다.** 원인을 고친 뒤 그 메시지들을 다시 처리하려면 로그에서 본문을 긁어 파싱해 재발행해야 하는데, 본문이 로그에 온전히 남아 있는 경우가 드물고(길이 잘림, 마스킹) 순서도 알 수 없다.

DLQ는 **메시지를 원형 그대로, 헤더까지 보존한 채** 보관한다. 그래서 고친 뒤 그대로 되돌릴 수 있다. **"버리는 곳이 아니라 나중에 되돌릴 수 있게 격리하는 곳"**이라는 점이 로그와의 결정적 차이다.

### "DLQ에도 메시지가 무한히 쌓이면 어떻게 하나요?"

DLQ 자체에 `x-max-length`와 `x-message-ttl`을 걸어 상한을 둔다. 다만 이건 브로커를 보호하는 최후 수단이고, **DLQ가 무한히 쌓인다는 것 자체가 운영이 실패했다는 신호**다.

정상 운영이라면 DLQ에 들어온 건은 알람이 울리고 사람이 처리한다. 쌓여만 간다면 알람이 없거나, 있어도 무시되고 있거나, 유입 속도가 처리 능력을 넘은 것이다. 셋 다 설정으로 푸는 문제가 아니다.

### "재시도 대기 큐를 쓰면 순서가 깨지지 않나요?" (시니어 변별 포인트)

깨진다. 그리고 **이것이 지연 재시도의 본질적 대가**다.

메시지 5가 실패해 5초 대기 큐로 빠지면, 그 사이 메시지 6·7이 먼저 처리된다. 5가 돌아왔을 때는 이미 6·7이 끝난 뒤다. 같은 주문에 대한 이벤트라면 상태가 뒤집힐 수 있다.

대응은 셋이다.

**첫째, 순서가 필요 없게 만든다.** 이벤트에 버전이나 타임스탬프를 넣고, 컨슈머가 "이미 더 최신 상태를 반영했으면 무시"하도록 한다. 가장 견고하고 가장 흔한 해법이다.

**둘째, 같은 키의 메시지는 순서를 지키게 격리한다.** 주문 ID별로 큐를 나누거나(consistent hash exchange 플러그인), 처리 시 그 키에 대한 락을 잡는다.

**셋째, 순서가 절대적으로 중요하면 지연 재시도를 포기한다.** 실패하면 그 자리에서 멈추고(블로킹 재시도) 사람이 개입한다. 처리량을 순서와 맞바꾸는 선택이다.

**"지연 재시도는 순서를 대가로 흐름을 지키는 것"**이라는 트레이드오프를 먼저 말하면 좋다. Kafka의 재시도 토픽에서도 완전히 같은 대가를 치른다.

### "Kafka의 재시도 토픽 방식과 비교하면 어떤가요?"

구조가 거의 같다. 실패한 메시지를 **다른 저장소로 옮겨 두었다가 나중에 다시 넣는다**는 발상이 동일하다.

차이는 **지연을 누가 만드는가**다. Kafka에는 "N초 뒤 배달" 기능이 없으므로 재시도 토픽의 컨슈머가 **메시지의 타임스탬프를 보고 스스로 sleep**하거나, 스케줄러가 주기적으로 옮긴다. RabbitMQ는 TTL + DLX로 **브로커가 타이머 역할을 해준다.**

그래서 지연 재시도 구현은 RabbitMQ 쪽이 확실히 간결하다. 반대로 **재처리(replay)는 Kafka가 압도적**이다 — DLQ 없이도 오프셋을 되감아 전체를 다시 돌릴 수 있다. RabbitMQ는 ack하면 메시지가 사라지므로 그런 선택지가 없고, 그래서 DLQ 설계가 더 중요해진다.

### "실패 원인이 다운스트림 전체 장애라면 재시도가 의미가 있나요?"

없다. 오히려 해롭다. 죽어 있는 서비스에 재시도 트래픽을 계속 보내면 회복을 방해하고, 그동안 DLQ가 정상 메시지로 가득 차 진짜 불량 메시지가 묻힌다.

이때 필요한 것은 **서킷 브레이커와 소비 중단**이다.

- 다운스트림 실패율이 임계치를 넘으면 **리스너 컨테이너를 아예 멈춘다.** 메시지는 큐에 그대로 쌓이고, 브로커가 이미 저장소 역할을 하고 있으므로 유실되지 않는다.
- 다운스트림이 회복되면 컨테이너를 다시 시작한다. 쌓인 메시지가 순서대로 처리된다.

```java
// 헬스 체크 실패가 지속되면 소비를 멈춘다 — 재시도로 두들기지 않는다
if (!downstreamHealth.isUp()) {
    registry.getListenerContainer("paymentListener").stop();
}
```

**"장애 상황에서는 재시도보다 멈추는 것이 낫고, 큐가 이미 버퍼 역할을 한다"**는 판단은 메시징 시스템을 운영해본 사람의 답이다.

---

## 한 줄 요약

RabbitMQ의 재시도는 **`x-dead-letter-exchange`와 TTL을 엮어 "컨슈머 없는 대기 큐"를 타이머로 쓰는 것**이 표준이고, 절대 하면 안 되는 것은 지연 없는 `requeue=true`의 무제한 반복이다 — 실패를 일시적/영구적으로 나누고, 상한과 백오프를 두고, 넘어간 것은 진단 정보와 함께 DLQ에 격리해 사람이 보게 만들어야 한다.
