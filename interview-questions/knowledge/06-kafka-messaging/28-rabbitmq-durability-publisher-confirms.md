# RabbitMQ 내구성 3종 — durable queue, persistent message, publisher confirms가 각각 막는 유실 지점

> 핵심 관전 포인트: **"메시지 안 잃게 하려면 durable 켜면 되죠"는 반쪽 답이다. 유실 지점이 셋이고 각각을 막는 장치가 따로 있다. ① 큐 정의가 재시작 때 사라지는 것 → durable queue, ② 큐는 살아남았는데 안에 든 메시지가 메모리에만 있어 날아가는 것 → persistent message(delivery mode 2), ③ 프로듀서가 보냈는데 브로커에 도달했는지 자체를 모르는 것 → publisher confirms. 셋 중 하나만 켜면 나머지 구멍은 그대로 열려 있다. 그리고 셋을 다 켜도 남는 구멍이 있다 — confirm은 "브로커가 책임을 넘겨받았다"는 뜻이지 "어떤 큐에 들어갔다"는 뜻이 아니라서, 라우팅에 실패한 메시지도 정상 confirm을 받는다. 그래서 `mandatory` + return 콜백이 짝으로 따라붙어야 하고, 마지막으로 "DB는 커밋됐는데 발행이 실패한" 구간은 브로커 설정으로는 절대 못 막아 Outbox가 필요해진다.**

---

## 0. 질문 + 의도

**질문**: "RabbitMQ에서 메시지를 잃지 않으려면 무엇을 켜야 하나요? (durable queue, persistent message, publisher confirms) 각 설정이 막아주는 유실 지점은 어디인가요?"

**출제 의도**: 세 설정은 각각 다른 유실 지점을 막는다. 셋 중 하나만 켜고 "영속화했다"고 믿는 사고가 실무에서 매우 흔하다. 유실 경로를 단계별로 분해해 사고하는지, 그리고 "브로커 설정으로 막을 수 있는 구간"과 "애플리케이션 설계로만 막을 수 있는 구간"의 경계를 아는지 본다.

## 1. 전제 — 메시지 한 건이 지나는 구간과 각 구간의 실패

### 1-1. 유실은 한 곳에서 일어나지 않는다

"메시지가 유실된다"고 뭉뚱그리면 대책도 뭉뚱그려진다. 발행부터 처리까지의 경로를 구간으로 끊고 각 구간에서 무엇이 죽을 수 있는지 나열하는 것이 출발점이다.

```
[프로듀서 앱]
   |
   | (A) DB 커밋은 됐는데 여기서 앱이 죽음 -> 이벤트가 아예 발행 안 됨
   v
   | (B) 네트워크로 전송 중 커넥션 끊김 -> 도달 여부를 프로듀서가 모름
   v
[브로커 수신]
   |
   | (C) 라우팅 대상 큐가 0개 -> 조용히 폐기
   v
[큐에 적재]
   |
   | (D) 메모리에만 있는 상태에서 브로커 재시작 -> 소멸
   | (E) 큐 정의 자체가 비영속 -> 큐째로 소멸
   v
[컨슈머에게 전달]
   |
   | (F) 처리 중 컨슈머 사망 -> ack 안 했으면 복구, auto-ack이면 유실
   v
[처리 완료 + ack]
```

여섯 구간이고 대책이 전부 다르다.

| 구간 | 막는 장치 | 다루는 문서 |
|---|---|---|
| (A) 발행 자체가 안 됨 | **Outbox 패턴** (브로커 설정으로 불가) | `35-rabbitmq-outbox-polling-publisher.md` |
| (B) 도달 여부 모름 | **publisher confirms** | 이 문서 3절 |
| (C) 라우팅 실패 | **mandatory + return** 또는 alternate exchange | 이 문서 4절 |
| (D) 메시지 소멸 | **persistent message** | 이 문서 2-2 |
| (E) 큐 소멸 | **durable queue** | 이 문서 2-1 |
| (F) 처리 중 사망 | **manual ack** | `27-rabbitmq-ack-nack-prefetch.md` |

면접에서 이 표를 머릿속에 갖고 있으면 "durable 켭니다" 대신 **"어느 구간을 막고 싶으신가요"**로 시작할 수 있다. 그 자체가 변별점이다.

### 1-2. 브로커가 죽는다는 것이 무슨 뜻인가

(D)와 (E)를 이해하려면 브로커가 메시지를 어디에 들고 있는지 알아야 한다.

RabbitMQ는 **성능을 위해 메시지를 기본적으로 메모리에 들고 있다.** 큐가 짧고 컨슈머가 빠르면 메시지는 디스크를 거치지 않고 메모리에서 메모리로 흘러간다. 이것이 RabbitMQ가 낮은 지연을 내는 이유다.

문제는 프로세스가 죽는 순간이다. 메모리에 있던 것은 전부 사라진다. 그래서 "디스크에도 적어라"라고 지시해야 하고, 그 지시가 persistent다.

그런데 디스크에 적어도 **큐 정의가 재시작 후에 복원되지 않으면** 그 안의 메시지도 의미가 없다. 그래서 큐 자체도 "재시작 후 복원하라"고 지시해야 하고, 그 지시가 durable이다.

**둘은 층위가 다르다.** durable은 그릇에 대한 설정이고, persistent는 내용물에 대한 설정이다. 그릇이 사라지면 내용물도 사라지고, 그릇만 남고 내용물이 메모리에만 있었다면 그릇은 빈 채로 복원된다.

## 2. 저장 쪽 두 설정 — durable과 persistent

### 2-1. durable queue — 큐 정의를 살린다

큐를 선언할 때 `durable=true`를 주면 **큐의 정의(이름, 속성, 바인딩)가 디스크에 기록되어 브로커 재시작 후 자동으로 복원된다.**

`durable=false`인 큐는 재시작과 함께 사라진다. 큐가 사라지면 바인딩도 사라지고, 그 뒤에 도착한 메시지는 라우팅 대상이 없어 폐기된다. **재시작 한 번에 "그 이후 모든 메시지"가 조용히 사라지는** 형태의 장애가 되므로, 처음 몇 건이 아니라 지속적인 유실이 된다.

```java
// 잘못된 코드 — 기본값에 맡긴 임시 큐
@Bean Queue paymentQueue() {
    return new Queue("payment.done"); // durable 여부를 명시하지 않음
}

// 올바른 코드 — 업무 큐는 명시적으로 durable
@Bean Queue paymentQueue() {
    return QueueBuilder.durable("payment.done")   // 재시작 후에도 큐가 살아남는다
            .deadLetterExchange("payment.dlx")
            .build();
}
```

`Queue` 생성자의 기본값은 durable이지만, **명시하는 습관이 낫다.** 리뷰어가 "이 큐는 재시작을 견디는가"를 코드에서 바로 확인할 수 있어야 하기 때문이다.

exchange에도 같은 설정이 있다. exchange가 durable이 아니면 재시작 시 exchange가 사라지고, 그러면 프로듀서의 발행이 "존재하지 않는 exchange" 오류로 실패한다.

### 2-2. persistent message — 내용물을 디스크에 적는다

메시지를 발행할 때 `delivery_mode = 2`(persistent)로 표시하면 브로커가 **그 메시지를 디스크에도 기록한다.** `delivery_mode = 1`(transient)이면 메모리에만 둔다.

Spring AMQP의 기본값은 persistent이며(`MessageDeliveryMode.PERSISTENT`), 이것이 안전한 기본값이다.

```java
// 명시적으로 지정하려면
MessageProperties props = new MessageProperties();
props.setDeliveryMode(MessageDeliveryMode.PERSISTENT); // 디스크에도 기록
Message message = new Message(body, props);
rabbitTemplate.send("order.events", "payment.done", message);
```

여기서 반드시 짚어야 할 조건이 있다. **persistent 메시지라도 durable이 아닌 큐에 들어가면 재시작 후 사라진다.** 큐 정의가 복원되지 않으므로 복원할 대상이 없기 때문이다.

```
durable 큐 + persistent 메시지  -> 재시작 후에도 남는다  (유일한 안전 조합)
durable 큐 + transient 메시지   -> 큐는 복원, 메시지는 소멸
비durable 큐 + persistent 메시지 -> 큐가 없으므로 메시지도 소멸 (디스크 기록이 무의미)
비durable 큐 + transient 메시지  -> 전부 소멸
```

**"둘 다 켜야 한다"**는 것이 이 항목의 핵심이며, 하나만 켜고 안심하는 것이 가장 흔한 오해다.

### 2-3. persistent를 켜도 남는 아주 작은 구멍

여기까지가 교과서고, 한 단계 더 들어가면 이런 사실이 있다. **디스크에 "적는다"와 "확실히 적혔다"는 다르다.**

운영체제는 쓰기 요청을 곧바로 디스크에 밀어 넣지 않고 페이지 캐시에 모았다가 내보낸다. RabbitMQ도 성능을 위해 **여러 메시지를 모아 주기적으로 fsync**(캐시 내용을 물리 디스크에 강제로 내려쓰는 시스템 호출)한다. 매 건마다 fsync하면 디스크 성능에 묶여 처리량이 급락하기 때문이다.

그래서 **fsync 직전에 브로커 서버가 통째로 전원이 나가면** 그 사이 몇 건은 사라질 수 있다. 이 구멍은 persistent 설정으로 못 막는다.

막는 방법은 **복제**다. 여러 노드에 메시지를 복제해두면 한 노드가 죽어도 다른 노드에 남는다. 그리고 이 복제를 안전하게 하는 것이 **quorum queue**의 역할이다 — Raft라는 합의 알고리즘으로 과반 노드에 기록된 뒤에야 확정으로 처리한다. 이 이야기는 `31-classic-vs-quorum-queue.md`에서 이어간다.

**"단일 노드에서는 persistent가 최선이고, 그 이상을 원하면 복제로 가야 한다"**는 계단을 말할 수 있으면 내구성의 층위를 이해하고 있는 것이다. (가산점 포인트)

## 3. publisher confirms — 프로듀서 쪽의 눈

### 3-1. 왜 필요한가

여기까지의 설정은 전부 **브로커에 도착한 뒤**의 이야기다. 도착하지 못했다면 아무 의미가 없다.

기본적으로 AMQP의 발행은 **단방향(fire-and-forget)**이다. 프로듀서는 소켓에 바이트를 쓰고 끝낸다. 브로커가 받았는지, 큐에 넣었는지, 디스크에 적었는지 **알 방법이 없다.**

```java
// 이 호출이 정상 리턴했다는 것은 "소켓에 썼다"는 뜻일 뿐이다
rabbitTemplate.convertAndSend("order.events", "payment.done", event);
// 이 시점에 브로커가 죽어 있었어도 예외가 안 날 수 있다
```

**Publisher confirms(발행 확인)**는 이 구간에 응답을 만든다. 채널을 confirm 모드로 전환하면, 브로커가 메시지를 처리한 뒤 **해당 발행 번호에 대해 ack(성공) 또는 nack(실패)를 비동기로 돌려준다.**

confirm이 돌아오는 시점은 브로커가 **책임을 넘겨받았다고 말할 수 있게 된 시점**이다. persistent 메시지가 durable 큐로 갔다면 디스크 기록이 끝난 뒤, transient라면 큐에 적재된 뒤다.

### 3-2. Spring에서 켜기

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated  # 어떤 발행에 대한 응답인지 식별자로 연결
    publisher-returns: true             # 라우팅 실패 메시지를 되돌려받는다 (4절)
```

```java
@Bean
RabbitTemplate rabbitTemplate(ConnectionFactory cf) {
    RabbitTemplate t = new RabbitTemplate(cf);
    t.setMandatory(true); // 라우팅 실패 시 폐기하지 말고 되돌려 달라

    t.setConfirmCallback((correlation, ack, cause) -> {
        if (ack) {
            // 브로커가 책임을 넘겨받았다. 여기서 outbox 행을 '발행됨'으로 표시한다
            outboxRepository.markPublished(correlation.getId());
        } else {
            // 브로커가 못 받았거나 내부 오류. 재발행 대상이다
            log.error("발행 실패: id={}, cause={}", correlation.getId(), cause);
        }
    });

    t.setReturnsCallback(returned ->
        // confirm은 성공인데 이쪽이 호출됐다면 = 브로커는 받았지만 갈 큐가 없었다
        log.error("라우팅 실패: rk={}", returned.getRoutingKey()));
    return t;
}

// 발행 시 식별자를 함께 넘겨야 콜백에서 어떤 메시지인지 알 수 있다
rabbitTemplate.convertAndSend("order.events", "payment.done", event,
        new CorrelationData(event.getId()));
```

`correlated` 타입을 쓰는 이유가 이 마지막 줄에 있다. **콜백은 비동기로 오므로 "무엇에 대한 응답인지" 식별자가 없으면 아무 조치도 할 수 없다.** 식별자 없이 confirm만 켜두는 것은 사실상 로그만 찍는 것과 같다.

### 3-3. confirm은 비동기다 — 착각하기 쉬운 지점

confirm 콜백은 **발행 호출과 다른 스레드에서, 나중에** 온다. 그래서 이렇게 쓰면 안 된다.

```java
// 잘못된 코드 — 발행 직후 성공했다고 간주
rabbitTemplate.convertAndSend(exchange, rk, event);
order.markEventPublished();   // 아직 confirm 안 왔다. 실패하면 이 표시가 거짓이 된다
orderRepository.save(order);
```

올바른 흐름은 둘 중 하나다.

**첫째, 콜백에서 상태를 갱신한다.** 위 3-2 코드처럼 confirm ack을 받은 시점에 "발행 완료"로 표시한다. 그러면 confirm이 안 오거나 nack이면 그 행은 미발행 상태로 남아 재발행 대상이 된다.

**둘째, 동기적으로 기다린다.** `waitForConfirmsOrDie()` 계열을 쓰면 confirm이 올 때까지 블로킹한다. 구현이 단순하지만 **처리량이 급락한다** — 발행마다 왕복을 기다리기 때문이다. 배치의 마지막에 한 번만 기다리는 식으로 절충하는 것이 보통이다.

### 3-4. AMQP 트랜잭션은 왜 안 쓰는가

AMQP에는 `tx.select` / `tx.commit`이라는 트랜잭션 기능도 있다. 발행을 트랜잭션으로 묶어 커밋하면 확실히 반영된다.

그런데 실무에서 거의 쓰지 않는다. **매 커밋마다 브로커와 동기 왕복이 필요해 처리량이 크게 떨어지기 때문**이다. publisher confirms는 같은 보장을 **비동기로** 제공하므로, 발행을 계속 밀어 넣으면서 응답을 나중에 받아 처리할 수 있다.

**"확실성을 얻는 방법이 둘인데, 동기 방식은 느려서 비동기 방식(confirms)이 사실상 표준이 되었다"**로 정리하면 된다.

## 4. 셋을 다 켜도 남는 구멍 둘

### 4-1. confirm은 "라우팅됐다"는 뜻이 아니다

가장 중요한 함정이다. **라우팅 대상 큐가 0개여도 브로커는 정상 confirm(ack)을 돌려준다.**

브로커 입장에서는 라우팅 규칙을 적용했고 결과가 "대상 없음"이었을 뿐, 오류가 아니다. 그래서 프로듀서는 "성공적으로 발행했다"고 기록하지만 **메시지는 어디에도 없다.**

```
프로듀서: publish(rk="payment.faild")   <- 오타
브로커:   매칭 큐 0개 -> 폐기 -> confirm ack 회신
프로듀서: "발행 성공" 로그
결과:     아무도 못 받았는데 모든 지표가 정상
```

그래서 **confirm에는 반드시 `mandatory` + return 콜백이 짝으로 따라붙어야 한다.** mandatory를 켜면 라우팅 실패 메시지를 프로듀서가 되돌려받고, return 콜백에서 알람을 올릴 수 있다.

브로커 쪽 대안은 **alternate exchange**다. 라우팅에 실패한 메시지를 지정한 대체 exchange로 흘려보내 별도 큐에 모으는 방식이며, 프로듀서 코드 없이 동작하고 프로듀서가 죽어도 메시지가 남는다는 장점이 있다. 자세한 내용은 `25-rabbitmq-core-components.md`에 있다.

### 4-2. DB 커밋과 발행 사이의 구간

마지막 구멍은 브로커 설정으로 **절대** 못 막는다.

```java
@Transactional
public void completePayment(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();                    // ① DB 상태 변경
    // ② 여기서 프로세스가 죽으면?
    rabbitTemplate.convertAndSend(...);  // ③ 이벤트 발행
}
```

②에서 죽으면 DB는 커밋됐는데(또는 커밋될 예정인데) 이벤트가 없다. 반대로 ③을 먼저 하고 트랜잭션이 롤백되면 **일어나지 않은 일에 대한 이벤트**가 나간다.

이것은 **DB와 브로커라는 두 시스템에 걸친 원자성 문제**이고, 한쪽의 설정으로 풀리지 않는다. 표준 해법은 **Transactional Outbox** — 이벤트를 같은 DB 트랜잭션 안에서 outbox 테이블에 저장하고, 별도 프로세스가 그 테이블을 읽어 발행하는 것이다. RabbitMQ 환경에서의 구현은 `35-rabbitmq-outbox-polling-publisher.md`에서 다룬다.

**면접에서 이 구간을 스스로 꺼내는 것이 중요하다.** "durable, persistent, confirms를 다 켜도 DB와 브로커 사이의 원자성은 남습니다"라고 덧붙이면, 설정 나열이 아니라 문제의 경계를 아는 답이 된다.

## 5. 꼬리질문 대비 포인트

### "persistent를 켜면 성능이 얼마나 떨어지나요?"

정확한 배수를 말하는 것은 위험하다. 디스크 종류, 메시지 크기, 큐 길이에 따라 크게 달라지기 때문이다. 대신 **왜 떨어지는지**를 말하면 된다.

메모리 큐는 쓰기가 RAM 접근이지만 persistent는 디스크 I/O와 주기적 fsync가 끼어든다. 특히 **큐가 짧게 유지될 때는 차이가 작고**(메시지가 금방 소비되어 디스크 기록이 상쇄됨), **큐가 길게 쌓일 때 차이가 커진다.**

실무 판단은 데이터 성격으로 한다. 결제·주문처럼 유실이 곧 돈인 메시지는 예외 없이 persistent다. 초당 수만 건의 지표·로그성 메시지는 transient가 정당할 수 있다. **한 클러스터 안에서도 큐마다 다르게 가져가는 것이 정답**이며, "전부 persistent" 또는 "전부 transient"라는 일괄 결정이 오히려 이상하다.

### "Kafka의 acks 설정과 대응시키면 어떻게 되나요?"

목적은 같고 층위가 다르다.

| 보장 | Kafka | RabbitMQ |
|---|---|---|
| 도달 여부 확인 | `acks=1` (리더가 받음) | publisher confirms |
| 복제까지 확인 | `acks=all` + `min.insync.replicas` | quorum queue + confirms (과반 복제 후 confirm) |
| 디스크 기록 | 기본적으로 로그 파일에 기록 | `delivery_mode=2` (persistent) |
| 정의 영속성 | 토픽은 항상 영속 | `durable=true` (명시 필요) |

핵심 차이는 **Kafka는 디스크 기록과 복제가 기본 전제이고 RabbitMQ는 선택 사항**이라는 점이다. Kafka는 애초에 로그 저장소로 설계되어 "안 적는다"는 선택지가 없지만, RabbitMQ는 메모리 큐가 기본이고 필요한 만큼 켜서 쓴다. 이 차이가 두 도구의 기본 성능 특성과 설정 실수의 위험도를 갈라놓는다.

### "confirm을 받지 못하면 재발행해야 하는데, 그럼 중복이 생기지 않나요?" (시니어 변별 포인트)

생긴다. 그리고 **피할 수 없다.**

브로커가 메시지를 받고 confirm을 보내는 도중에 네트워크가 끊기면, 프로듀서는 "도달 못 함"과 "도달했지만 응답을 못 받음"을 구분할 방법이 없다. 재발행하면 중복이고, 안 하면 유실이다.

여기서 **유실보다 중복이 낫다**는 판단이 표준이다. 중복은 컨슈머 쪽 멱등 처리로 흡수할 수 있지만 유실은 복구 수단이 없기 때문이다. 그래서 설계는 이렇게 간다.

- 프로듀서는 **confirm을 못 받으면 재발행**한다 (at-least-once 발행).
- 메시지에는 **비즈니스 의미의 고유 ID**를 넣는다 (`message_id` 속성 또는 페이로드 필드).
- 컨슈머는 그 ID로 **처리 이력을 확인해 중복을 걸러낸다.**

Kafka에는 프로듀서 멱등성(`enable.idempotence`) 기능이 있어 브로커 수준에서 재전송 중복을 제거하지만, **RabbitMQ에는 그에 해당하는 기능이 없다.** 그래서 RabbitMQ 환경에서는 멱등 컨슈머가 선택이 아니라 필수라는 점을 짚으면 좋다.

### "메시지가 유실됐다는 신고를 받았습니다. 어디부터 확인하나요?"

**구간을 좁히는 순서**로 답하면 된다. 1-1의 표가 그대로 진단 순서가 된다.

1. **발행 로그와 DB 상태를 대조한다.** DB에는 주문이 완료로 남아 있는데 발행 로그가 없으면 (A) 구간 — Outbox 부재 문제다.
2. **exchange의 in/out 지표를 본다.** 들어온 수보다 나간 수가 적으면 (C) 라우팅 실패다. unroutable 큐가 있으면 거기 쌓여 있을 것이다.
3. **큐의 durable 여부와 브로커 재시작 이력을 본다.** 재시작 시각과 유실 구간이 겹치면 (D)(E)다.
4. **컨슈머의 ack 모드를 본다.** `NONE`(auto-ack)이면 컨슈머 재시작·크래시 시점과 대조한다 — (F)다.
5. **DLQ를 본다.** 유실이 아니라 실패 후 격리된 것일 수 있다. 실제로 "유실됐다"는 신고의 상당수가 DLQ에 얌전히 들어 있는 경우다.

5번을 먼저 확인하는 습관을 말하면 실전 감각이 드러난다. **유실 조사에서 가장 먼저 볼 곳은 DLQ**다.

---

## 한 줄 요약

durable queue는 그릇을, persistent message는 내용물을, publisher confirms는 도달 여부를 지킨다 — **셋은 서로 다른 구간을 막으므로 전부 켜야 하고**, 그러고도 남는 "라우팅 실패"는 mandatory/alternate exchange로, "DB 커밋과 발행 사이"는 Outbox로 따로 막아야 한다.
