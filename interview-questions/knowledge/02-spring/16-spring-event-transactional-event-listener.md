# Spring Event와 @TransactionalEventListener — "커밋도 안 됐는데 알림부터 나간" 사고를 막는 도구

> 핵심 관전 포인트: **`ApplicationEventPublisher`로 발행한 이벤트는 기본이 동기·같은 스레드·같은 트랜잭션이다 — "이벤트니까 비동기겠지"는 오해이고, 리스너가 던진 예외는 발행자에게 그대로 튀어 발행자의 트랜잭션을 롤백시킨다. `@EventListener`가 발행 즉시 실행이라면 `@TransactionalEventListener`는 실행을 트랜잭션 phase(기본 `AFTER_COMMIT`)까지 미루는 장치다. Redis·메일·MQ 같은 외부 시스템은 DB 트랜잭션에 참여하지 않아 롤백으로 되돌릴 수 없으므로, 커밋이 확정되기 전에 건드리면 "DB는 안 바뀌었는데 외부만 바뀐" 거짓 알림·거짓 캐시가 남는다. `AFTER_COMMIT`은 그 방향의 사고를 원천 차단하는 대신 반대 방향의 문제를 만든다 — 커밋은 이미 끝났으므로 리스너가 실패해도 롤백할 트랜잭션이 없고, 스프링은 그 예외를 로그 한 줄로 삼켜 호출자에게 알려주지도 않는다. 게다가 이미 커밋이 끝난 트랜잭션에 얹혀 도는 자리라 리스너 안의 DB 쓰기는 조용히 증발하고(해법은 `REQUIRES_NEW`), 트랜잭션이 없는 곳에서 발행하면 리스너 자체가 조용히 스킵된다. 그래서 이 질문의 본체는 phase 암기가 아니라, 커밋 뒤 실패 경로를 수용·재시도·보상·아웃박스 중 무엇으로 막을지 요구사항의 심각도로 고르는 판단이다.**

---

## 0. 질문 + 의도

**질문**: "Spring Event(`ApplicationEventPublisher`)를 활용해본 경험이 있나요? `@TransactionalEventListener`는 언제 유용한가요?"
"DB 커밋 후에 이벤트를 발행해야 하는 요구사항을 어떻게 구현하나요? (AFTER_COMMIT, Transactional Outbox)"

**출제 의도**: 결합도를 낮추면서 "커밋 후에만 알림 발송" 같은 정합성 요구를 지키는 실무 패턴을 아는지 본다. 이벤트를 써봤다는 사람에게 커밋 전/후 실행 시점을 물으면 진짜 이해도가 드러난다. 고난이도 버전에서는 "커밋됐는데 발행 실패" / "발행됐는데 롤백"의 양쪽 실패를 다 짚는지 — 분산 시스템 정합성의 축소판이라, 이 문제를 이해한 사람은 Kafka·MSA 정합성 문제 전반을 이해할 준비가 된 것이다.

> 이 문서의 서술은 **Spring Framework 6.x / Spring Boot 3.x** 기준이며, 동작 근거는 `TransactionalApplicationListenerMethodAdapter`·`AbstractPlatformTransactionManager`·`SimpleApplicationEventMulticaster`의 소스로 확인했다. 비동기 실행 스레드풀 자체의 설정은 `15-async-annotation.md`, 아웃박스의 구현은 `23-transactional-outbox-pattern.md`에 있다.

## 1. Spring Event 기본 — 발행과 구독, 그리고 "동기"라는 증거

### 1-1. 무엇을 해결하려고 만든 도구인가

이벤트는 **한 컴포넌트가 "무슨 일이 일어났다"고 외치면 관심 있는 컴포넌트들이 각자 알아서 반응하는** 구조다. 발행자는 구독자가 누구인지, 몇 명인지 몰라도 된다. 결합도를 낮추는 것이 유일한 목적이다.

```java
// 발행: "주문이 완료됐다"고 외치기만 한다
@Service
@RequiredArgsConstructor
public class OrderService {
    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public Order complete(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.complete();
        // 누가 이 이벤트를 받는지 이 클래스는 모른다. 컴파일 시점에도 모른다.
        eventPublisher.publishEvent(new OrderCompletedEvent(order.getId()));
        return order;
    }
}

// 구독: 알림과 통계가 각자의 리스너로 반응한다 — 서로의 존재도 모른다
@Component
public class NotificationListener {
    @EventListener
    public void on(OrderCompletedEvent event) { /* 알림 발송 */ }
}

@Component
public class StatisticsListener {
    @EventListener
    public void on(OrderCompletedEvent event) { /* 통계 집계 */ }
}
```

이벤트가 없었다면 `OrderService`가 알림·통계·캐시 서비스를 전부 주입받아 순서대로 호출해야 한다. 이벤트를 쓰면 "주문 완료 후 할 일"이 하나 늘어도 `OrderService`는 한 줄도 바뀌지 않는다. 리스너 클래스를 하나 추가하면 끝이다.

### 1-2. 가장 흔한 오해 — "이벤트니까 비동기겠지"

아니다. **기본은 동기, 같은 스레드, 같은 트랜잭션이다.** 말로만 하면 잘 안 믿기니 증거를 보자. 스레드 이름을 찍어보면 한 번에 끝난다.

```java
@Transactional
public Order complete(Long orderId) {
    log.info("발행 직전 thread={}", Thread.currentThread().getName());
    eventPublisher.publishEvent(new OrderCompletedEvent(orderId));
    log.info("발행 직후 thread={}", Thread.currentThread().getName());
    return order;
}

@EventListener
public void on(OrderCompletedEvent event) {
    log.info("리스너 안 thread={}", Thread.currentThread().getName());
}
```

```text
발행 직전 thread=http-nio-8080-exec-3
리스너 안 thread=http-nio-8080-exec-3    <- ① 발행자와 같은 요청 스레드다
발행 직후 thread=http-nio-8080-exec-3    <- ② 리스너가 끝난 뒤에야 이 줄이 찍힌다
```

두 가지를 동시에 증명하는 로그다. ①은 **같은 스레드**라는 사실이고, ②의 순서는 **`publishEvent()`가 리스너를 전부 실행한 뒤에야 리턴한다**는 사실이다. 리스너가 3초 걸리면 `publishEvent()`도 3초 걸린다.

즉 실행 흐름만 놓고 보면 **발행자가 리스너 메서드를 직접 호출한 것과 완전히 같다.** 다른 점은 발행자가 리스너의 존재를 컴파일 타임에 모른다는 것뿐이다.

### 1-3. 그래서 리스너의 예외가 발행자의 트랜잭션을 롤백시킨다

같은 스레드·같은 호출 스택이라는 말은, 리스너에서 던진 예외가 **`publishEvent()` 호출 지점으로 그대로 튀어 오른다**는 뜻이다.

```java
@Component
public class NotificationListener {
    @EventListener
    public void on(OrderCompletedEvent event) {
        // 알림 서버가 죽어 있어서 여기서 RuntimeException이 난다고 하자
        throw new IllegalStateException("알림 서버 연결 실패");
    }
}
```

```java
@Transactional
public Order complete(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.complete();
    // 이 줄에서 IllegalStateException이 그대로 튀어나온다.
    // 메서드 밖으로 나가는 순간 @Transactional이 런타임 예외를 보고 롤백을 결정한다.
    eventPublisher.publishEvent(new OrderCompletedEvent(order.getId()));
    return order;
}
// 결과: 알림 하나가 실패했다는 이유로 주문 완료 자체가 취소된다.
```

근거는 `SimpleApplicationEventMulticaster`에 있다. 이 클래스는 `errorHandler`가 설정돼 있을 때만 리스너 예외를 잡아 넘기고, **설정돼 있지 않으면(스프링 부트의 기본 상태) 예외를 감싸지 않고 그대로 올려보낸다.**

이 사실에서 실무 결론 둘이 나온다.

**하나, 부가 작업의 실패가 본체를 무너뜨리는 구조가 기본값이다.** 알림 실패로 주문이 취소되는 게 맞는지는 요구사항의 문제이지 프레임워크가 정해줄 문제가 아니다. 아니라면 리스너 안에서 try-catch로 삼키거나 실행 시점을 커밋 뒤로 미뤄야 한다.

**둘, 리스너 안의 DB 작업은 발행자와 같은 트랜잭션에서 실행된다.** 리스너가 무엇을 저장하든 아직 커밋 전이며, 발행자가 나중에 롤백하면 리스너가 쓴 것도 함께 사라진다.

## 2. @TransactionalEventListener — 실행 시점을 트랜잭션 타임라인에 묶는다

`@EventListener`가 "발행 즉시 실행"이라면 `@TransactionalEventListener`는 **"발행은 해두되 실행은 트랜잭션이 특정 단계에 도달할 때까지 미룬다"**이다. 발행 시점에 이벤트를 곧바로 처리하지 않고 현재 트랜잭션에 콜백을 등록해 두었다가, 트랜잭션이 그 단계에 이르면 그때 리스너를 부른다.

### 2-1. phase 4종을 타임라인 위에 올려놓기

표로만 외우면 `AFTER_COMMIT`과 `AFTER_COMPLETION`의 차이가 잘 안 잡힌다. 트랜잭션이 끝나는 과정을 시간축으로 그려놓고 각 phase가 어느 지점인지 표시하면 한 번에 정리된다.

```text
  트랜잭션 시작
       │
       v
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 비즈니스 로직 실행                                                     │
  │   publishEvent()  <- 여기서 발행해도 @TransactionalEventListener는     │
  │                      아직 안 돈다. "이 트랜잭션이 이 단계에 오면       │
  │                      불러 달라"는 예약만 걸어둔다.                     │
  └──────────────────────────────────────────────────────────────────────┘
       │
       ├── BEFORE_COMMIT ──────> 아직 커밋 전, 같은 트랜잭션 안이다.
       │                         여기서 한 DB 쓰기는 본 트랜잭션과 함께 커밋된다.
       │                         여기서 예외가 나면 커밋이 취소되고 롤백된다.
       v
   [ COMMIT 실행 ]
       │
       ├─ 성공 ──> AFTER_COMMIT ─────┐  커밋이 확정된 뒤. 외부 시스템 반영의 자리.
       │                              │
       └─ 롤백 ──> AFTER_ROLLBACK ───┤  롤백이 확정된 뒤. 실패 알림·실패 지표의 자리.
                                      │
                  AFTER_COMPLETION ───┘  위 둘 중 무엇이었든 무조건 실행. 정리 작업의 자리.
       │
       v
   [ 리소스 정리 — 커넥션·EntityManager를 스레드에서 풀고 커넥션풀에 반납 ]
       ★ AFTER_* 리스너는 이 정리보다 '먼저' 돈다.
         2-4의 함정이 정확히 이 틈에서 발생한다.
```

| phase | 실행 시점 | 무엇을 넣는 자리인가 |
|---|---|---|
| `BEFORE_COMMIT` | 커밋 직전, 같은 트랜잭션 안 | 커밋 전 마지막 검증, 파생 데이터의 추가 저장 |
| `AFTER_COMMIT` | 커밋 성공 후 (**기본값**) | 외부 시스템 반영 — 알림, 캐시 무효화, MQ 발행 |
| `AFTER_ROLLBACK` | 롤백 후 | 실패 알림, 실패 지표 적재 |
| `AFTER_COMPLETION` | 커밋이든 롤백이든 완료 후 | 결과와 무관한 정리 작업 |

```java
@Component
public class NotificationListener {
    // phase를 생략하면 AFTER_COMMIT이다 — 커밋이 확정된 뒤에만 실행된다
    @TransactionalEventListener
    public void on(OrderCompletedEvent event) { /* 알림 발송 */ }
}
```

### 2-2. AFTER_COMMIT이 존재하는 이유 — 외부 시스템은 트랜잭션에 참여하지 않는다

이 질문의 핵심이다. 먼저 전제 하나를 깔아야 한다. **DB 트랜잭션의 롤백은 그 DB 안의 변경만 되돌린다.** DB 엔진이 변경 전 값을 보관하고 있다가 `ROLLBACK` 신호에 되돌려주는 기능이기 때문이다.

Redis 쓰기, 메일 발송, 푸시 알림, 메시지 발행은 그 DB 바깥의 세계다. 한번 나가면 되돌릴 수단이 없다 — 발송된 메일을 회수하는 SQL은 존재하지 않는다.

그래서 커밋이 확정되기 **전에** 외부 시스템을 건드리면, 그 뒤에 트랜잭션이 롤백됐을 때 "DB는 안 바뀌었는데 외부만 바뀐" 불일치가 남는다.

```java
// before: 커밋 전에 알림이 나간다
@Service
public class OrderService {
    @Transactional
    public Order complete(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.complete();
        eventPublisher.publishEvent(new OrderCompletedEvent(order.getId()));
        // @EventListener라면 위 줄에서 이미 푸시가 나갔다. 아직 커밋 전인데도.
        applyCoupon(order);   // 문제: 여기서 예외가 나면 트랜잭션 전체가 롤백된다
        return order;
    }
}
// 결과: DB의 주문은 "완료 안 됨"으로 되돌아갔는데
//       고객 휴대폰에는 "주문이 완료되었습니다" 푸시가 남았다 — 거짓 알림.
```

```java
// after: 커밋이 확정된 뒤에만 알림이 나간다
@Component
public class NotificationListener {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderCompletedEvent event) {
        // 롤백된 경우 이 메서드는 호출조차 되지 않는다.
        // "실행하고 되돌리기"가 아니라 "애초에 실행하지 않기"로 문제를 없앤 것이다.
        pushService.send(event.orderId(), "주문이 완료되었습니다");
    }
}
```

되돌릴 수 없는 작업을 다루는 정석은 **되돌리는 방법을 마련하는 것이 아니라 되돌릴 일이 없게 순서를 잡는 것**이다. `AFTER_COMMIT`은 그 원칙을 애노테이션 한 줄로 강제한다.

### 2-3. 실전 사례 — 보안 설정 변경 후 Redis 토큰 차단

실제로 겪은 사례를 각색하면 이렇다. 보안 설정(예: 특정 앱의 접근 차단)이 변경되면 Redis에 살아 있는 해당 사용자들의 토큰을 차단해야 하는 요구사항이 있었다.

**설정 저장과 같은 트랜잭션 안에서(또는 `BEFORE_COMMIT`에서) 토큰을 차단하면** — 이후 로직에서 예외가 나 설정 저장이 롤백됐을 때 **설정은 그대로인데 사용자 토큰만 차단된** 상태가 된다. 사용자는 아무 이유 없이 강제 로그아웃당하고, 운영자는 "설정을 안 바꿨는데 왜 로그아웃됐냐"는 문의를 받는다. DB만 보면 아무 흔적이 없어서 원인 추적도 어렵다.

**`@TransactionalEventListener(phase = AFTER_COMMIT)`로 옮기면** 설정 변경이 DB에 확정된 경우에만 토큰이 차단된다. 롤백 시나리오에서 Redis는 손도 대지 않는다.

**"외부 시스템 반영은 커밋이라는 사실이 확정된 뒤에"** — 이 한 문장이 `AFTER_COMMIT`의 존재 이유 전부다.

### 2-4. 함정 ① — AFTER_COMMIT 리스너 안의 DB 쓰기가 조용히 사라진다

주니어가 거의 반드시 한 번은 밟는 함정이다.

```java
// before: 예외도 로그도 없는데 DB에 데이터가 없다
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) {
    historyRepository.save(new OrderHistory(event.orderId()));
    // 문제: save()는 예외 없이 정상 리턴한다. 그런데 테이블을 조회하면 행이 없다.
}
```

왜 그런지는 2-1 타임라인의 ★ 지점을 다시 보면 나온다. `AFTER_COMMIT` 리스너는 **커밋이 이미 끝났지만 리소스 정리는 아직 안 된 틈**에서 실행된다. 이 틈의 상태를 정확히 쪼개면 이렇다.

```text
[ COMMIT 완료 ]
      │
      ├─ 트랜잭션 동기화 목록: 이미 비워졌다
      │    (스프링이 콜백을 꺼내면서 목록을 clear한 뒤 호출하기 때문)
      │
      ├─ 커넥션 / EntityManager: 아직 스레드에 묶여 있다  ★ 여기가 원인
      │
      v
  AFTER_COMMIT 리스너 실행  <- 이 시점의 save()는 "이미 커밋이 끝난 그 트랜잭션"을
      │                        살아 있는 트랜잭션으로 착각하고 거기에 합류한다
      v
[ 리소스 정리 — 여기서 EntityManager가 닫히고 커넥션이 풀로 반납된다 ]
```

리스너의 `save()`는 기본 전파 속성인 `REQUIRED`로 동작한다. `REQUIRED`는 "진행 중인 트랜잭션이 있으면 거기 합류하고 없으면 새로 연다"는 뜻이다. 그런데 커넥션이 아직 묶여 있으니 스프링은 "진행 중인 트랜잭션이 있다"고 판단해 **합류**시킨다.

합류한 참여자는 **스스로 커밋하지 않는다.** 트랜잭션을 시작한 바깥쪽이 커밋할 것이라는 전제로 동작하기 때문이다. 그런데 그 바깥쪽은 이미 커밋을 끝냈다. 다시 커밋할 일이 없으므로, 리스너가 저장한 내용은 리소스 정리 단계에서 **커밋 없이 버려진다.** 예외도 경고 로그도 없다.

해법은 **합류시키지 말고 새 트랜잭션을 열게 하는 것**이다.

```java
// after: 자기 손으로 커밋하는 새 트랜잭션을 연다
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void on(OrderCompletedEvent event) {
    // REQUIRES_NEW는 묶여 있던 (이미 끝난) 트랜잭션을 잠시 밀어두고
    // 새 커넥션으로 트랜잭션을 열기 때문에, 이 save()는 이 메서드가 끝날 때
    // 자기 힘으로 커밋된다.
    historyRepository.save(new OrderHistory(event.orderId()));
}
```

`REQUIRED`와 `REQUIRES_NEW`가 각각 무엇이고 새 커넥션을 하나 더 쓴다는 대가가 왜 중요한지는 `12-transaction-propagation-required-vs-requires-new.md`에 있다. 커넥션을 하나 더 잡는다는 점은 반드시 인지해야 한다 — 리스너가 오래 걸리면 그만큼 커넥션 두 개를 동시에 점유하는 셈이다.

### 2-5. 함정 ② — 트랜잭션이 없으면 리스너가 조용히 스킵된다

`@TransactionalEventListener`는 "진행 중인 트랜잭션에 콜백을 걸어두는" 장치다. 그렇다면 **걸어둘 트랜잭션이 없으면 어떻게 되는가?**

답은 **아무 일도 일어나지 않는다**이다. 예외도, 경고도 없다. 스프링은 DEBUG 레벨로 "No transaction is active - skipping ..." 한 줄만 남기고 이벤트를 버린다. 기본 로그 레벨이 INFO이므로 그 줄조차 보이지 않는다.

이것이 **"테스트에서 리스너가 안 불려 몇 시간을 헤매는"** 전형적인 원인이다. 대표적으로 이런 경우에 발생한다.

- 발행하는 메서드에 `@Transactional`을 안 붙였다.
- 붙였지만 같은 클래스 안에서 `this.method()`로 호출해 프록시를 타지 않았다(`11-transactional-self-invocation.md`).
- 테스트가 서비스 메서드를 거치지 않고 `publishEvent()`를 직접 호출했다.

트랜잭션이 없어도 즉시 실행되게 하려면 명시적으로 열어줘야 한다.

```java
// 트랜잭션이 없을 때는 @EventListener처럼 즉시 실행하고,
// 있을 때는 AFTER_COMMIT까지 미룬다.
@TransactionalEventListener(fallbackExecution = true)
public void on(OrderCompletedEvent event) { ... }
```

다만 `fallbackExecution = true`를 습관적으로 붙이는 것은 권하지 않는다. **"트랜잭션이 없다"는 사실 자체가 대개는 발행 지점의 버그 신호**인데, 이 옵션은 그 신호를 지워버리기 때문이다. 원인을 찾을 때 잠깐 켜보고, 정말로 트랜잭션 밖 발행이 정상 경로인 경우에만 남긴다.

### 2-6. 함정 ③ — 여전히 동기다, 느린 리스너가 응답을 붙잡는다

`@TransactionalEventListener`는 실행 **시점**만 미룰 뿐 **여전히 요청 스레드에서 동기로** 돈다. 커밋 직후, 응답이 나가기 전에 실행되므로 리스너의 메일 발송이 3초 걸리면 사용자 응답도 3초 늦어진다.

응답과 무관한 부수 작업이라면 `@Async`를 겹쳐 실행 스레드까지 분리한다.

```java
@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) { mailService.send(...); }
```

이때 무슨 일이 일어나는지 정확히 알고 써야 한다. **커밋 후 요청 스레드가 작업을 async 풀에 제출하고 곧바로 응답을 내보내며, 실제 실행은 그 뒤에 워커 스레드에서 일어난다.** 그래서 `15-async-annotation.md`의 이슈 세트가 그대로 따라붙는다.

- **스레드풀 설정**: 기본 큐가 무제한이라 동시 처리가 core 8개에 고정되고, 리스너가 느리면 큐만 무한히 쌓인다.
- **예외 처리**: `void` 리턴이면 예외가 `AsyncUncaughtExceptionHandler`의 로그 한 줄로 끝난다.
- **컨텍스트 미전파**: 워커 스레드에는 트랜잭션도, `SecurityContext`도, MDC의 trace id도 없다. 커밋 후 별도 스레드이므로 **트랜잭션 전파는 애초에 존재하지 않고**, 리스너에서 DB를 쓰려면 2-4와 무관하게 자기 트랜잭션을 열어야 한다.
- **유실**: async 큐는 JVM 힙 위에 있다. 제출은 됐는데 실행 전에 배포로 프로세스가 내려가면 그 작업은 사라진다. `AFTER_COMMIT` 하나만 쓸 때보다 **유실 구간이 오히려 넓어진다** — 동기라면 최소한 응답이 나가기 전에는 시도라도 했겠지만, `@Async`를 붙이면 시도조차 못 한 채 사라질 수 있다.

정리하면 **`@Async`는 응답 지연을 줄이는 대가로 유실 위험을 키운다.** "느리니까 `@Async` 붙이면 되지"가 아니라 이 교환을 인지하고 선택했다고 말해야 한다.

## 3. 커밋 뒤의 실패에는 롤백이 없다 — 실패 경로 설계 (시니어 변별 핵심)

### 3-1. 문제의 정확한 모양 — 롤백도 없고, 예외조차 안 올라온다

`AFTER_COMMIT`은 "롤백됐는데 외부만 바뀐" 문제를 막지만 **반대 방향의 문제를 새로 만든다.** 커밋은 이미 확정됐는데 리스너가 실패하면? DB는 바뀌었는데 Redis 토큰 차단은 안 된 상태다. 이번엔 되돌릴 트랜잭션이 없다.

여기에 많은 사람이 모르는 사실이 하나 더 붙는다. **`AFTER_COMMIT` 리스너에서 던진 예외는 호출자에게 전달되지 않는다.**

`@TransactionalEventListener`의 `AFTER_COMMIT`은 내부적으로 트랜잭션 완료 콜백으로 실행되는데, 스프링은 그 콜백들을 하나씩 부르면서 `Throwable`을 통째로 잡아 `"TransactionSynchronization.afterCompletion threw exception"` 이라는 에러 로그만 남기고 다음 콜백으로 넘어간다. 나머지 콜백을 지키기 위한 설계지만, 결과적으로 **컨트롤러는 아무 일도 없었던 것처럼 200 OK를 내려보낸다.**

```text
  [ COMMIT 성공 ]
        │
        v
  AFTER_COMMIT 리스너 실행 -> 예외 발생
        │
        ├─ 스프링이 예외를 잡아 ERROR 로그 한 줄로 기록
        │  (호출자에게 전파하지 않는다)
        v
  나머지 콜백 계속 실행 -> 리소스 정리 -> 컨트롤러가 200 OK 응답
        ★ 사용자도, 호출한 코드도, 실패했다는 사실을 모른다
```

그래서 이 문제의 정확한 모양은 **"롤백이 없다"가 아니라 "롤백도 없고 신호도 없다"**이다. 방어선을 설계할 때 **가장 먼저 해야 할 일이 실패를 관측 가능하게 만드는 것**인 이유가 여기 있다. 리스너 안을 try-catch로 감싸 실패를 지표와 알림으로 승격시키지 않으면, 아래의 어떤 대책도 발동할 계기를 얻지 못한다.

이제 관측된 실패를 어떻게 다룰지를 정한다. 요구사항의 심각도에 따라 네 갈래가 있고, 뒤로 갈수록 신뢰성과 복잡도가 함께 올라간다.

### 3-2. ① 불일치를 유계(bounded)로 만들고 수용

불일치가 "영원히"가 아니라 "최대 N분"이라면 수용 가능한 경우가 많다.

토큰 차단 사례가 정확히 그렇다. 토큰의 TTL이 30분이라면, 차단에 실패해도 그 토큰은 30분 뒤 만료된다. **TTL이 곧 불일치 지속 시간의 상한**이 되는 것이다. 무한한 위험이 유한한 위험으로 바뀌면 판단의 성격 자체가 달라진다.

그러면 이것은 기술 문제가 아니라 **"우리 보안 스펙상 최대 30분의 지연은 허용되는가"**라는 스펙 레벨 의사결정이 된다. 기술로 다 막으려 하지 않고 비즈니스와 합의해 답을 얻는 것도 설계다. 다만 **"어쩔 수 없다"와 "상한이 30분임을 확인하고 합의했다"는 완전히 다른 답변**이라는 점이 중요하다.

### 3-3. ② 재시도

실패 원인이 Redis 순단이나 메일 서버의 일시 장애처럼 **몇 초 뒤면 낫는 종류**라면 재시도로 흡수하는 것이 가장 값싼 해법이다.

단 무한 재시도는 금물이다. 재시도 상한과, 상한을 넘겼을 때의 알림이 세트로 따라와야 한다. 재시도 간격은 1초, 2초, 4초처럼 늘려가는 **지수 백오프**로 잡는다 — 이미 힘들어하는 상대 시스템에 재시도 폭풍으로 부하를 더 얹지 않기 위해서다.

재시도로도 안 되는 실패는 결국 ①(수용)이나 ③(보상)으로 넘어간다. 재시도는 문제를 없애는 대책이 아니라 **일시 장애를 걸러내 진짜 실패의 빈도를 낮추는 필터**다.

### 3-4. ③ 보상 트랜잭션

**보상 트랜잭션**은 이미 커밋된 변경을 **새 트랜잭션으로 역연산해 되돌리는** 것이다. "완료 처리"의 보상은 "완료 취소"다. 커밋 기록을 지우는 것이 아니라 반대 방향의 변경을 한 번 더 쌓는다는 점에서 롤백과 다르다.

겉보기엔 깔끔하지만 허점이 둘 있다.

**첫째, 원 커밋과 보상 커밋 사이의 시간 동안 다른 요청이 이미 변경된 상태를 읽고 행동했을 수 있다.** 주문이 완료로 바뀐 것을 보고 배송 준비가 시작됐다면, 주문 상태를 되돌려도 그 행동은 되돌아오지 않는다.

**둘째, 보상 트랜잭션 자체가 실패할 수 있다.** 실패 처리의 실패라는 무한 후퇴에 빠진다. 실무에서는 보상도 재시도하고, 그마저 실패하면 수동 개입 큐에 적재해 사람을 부르는 것으로 끝을 맺는다.

그래서 보상은 **"안 되면 원래 변경을 취소하는 것이 사용자에게 더 나은 경우"**에만 고른다. 예약을 확정했는데 좌석 배정이 실패했다면 예약을 취소하는 편이 낫다. 반대로 알림 발송이 실패했다고 주문을 취소하는 것은 명백히 과하다.

### 3-5. ④ 아웃박스 패턴 — 신뢰성이 요구사항일 때

**"커밋됐으면 반드시, 언젠가는, 외부 반영도 된다"**가 요구사항이라면 위의 셋으로는 부족하다. 이벤트가 메모리에만 있는 한 프로세스가 죽는 순간 사라지기 때문이다.

해법은 이벤트를 메모리가 아니라 **DB에 남기는 것**이다.

```java
@Transactional
public void changeSecuritySetting(SettingRequest request) {
    settingRepository.save(setting);
    // 발행할 이벤트를 같은 DB의 outbox 테이블에 INSERT한다.
    // 설정 변경과 발행 예약이 '같은 트랜잭션의 두 쓰기'가 되므로
    // 둘 다 커밋되거나 둘 다 롤백된다 — 어긋날 방법이 없다.
    outboxRepository.save(OutboxEvent.of("TOKEN_BLOCK", payload));
}

// 별도 릴레이(스케줄러 폴링 또는 CDC)가 outbox 테이블의 미발행 행을 읽어
// 실제 발행을 수행하고, 성공한 것만 발행 완료로 표시한다.
// 실패하면 다음 주기에 다시 시도한다 — 행이 DB에 있으므로 사라지지 않는다.
```

같은 트랜잭션이므로 "커밋됐는데 이벤트가 유실"도, "롤백됐는데 이벤트만 발행"도 구조적으로 불가능하다. 대가는 테이블·릴레이·재발행에 대비한 멱등 소비자 같은 운영 복잡도다.

구현 상세 — 폴링과 CDC의 선택, `FOR UPDATE SKIP LOCKED`를 쓴 릴레이의 동시 실행, at-least-once 전달과 멱등 소비자 — 는 `23-transactional-outbox-pattern.md`가 이 문서의 후속편으로 다룬다.

### 3-6. 그래서 무엇을 고르는가 — 후속 작업의 성격으로 가른다

네 갈래를 "신뢰성 순서"로만 외우면 실전에서 못 고른다. **후속 작업이 어떤 성격인가**로 매핑해두면 바로 답이 나온다.

| 후속 작업의 성격 | 맞는 방어선 | 예시 |
|---|---|---|
| 늦어도 되고, 다른 장치가 결국 정리해준다 | ① 유계 불일치 수용 | TTL 있는 캐시 무효화, 토큰 차단 |
| 실패 원인이 대개 일시적이라 곧 낫는다 | ② 재시도 + 상한 + 알림 | Redis 순단, 메일 서버 일시 장애 |
| 안 되면 원래 변경을 취소하는 편이 낫다 | ③ 보상 트랜잭션 | 예약 확정 후 좌석 배정 실패 |
| 절대 유실되면 안 되고 언젠가는 반드시 반영돼야 한다 | ④ 아웃박스 | 결제 후처리, 정산, 타 서비스 통지 |

①에서 ④로 갈수록 신뢰성이 올라가고 복잡도도 올라간다. **"무조건 아웃박스"가 아니라 요구사항이 감당할 수 있는 불일치의 크기로 도구를 고르는 것**이 시니어 답변이다.

## 4. 꼬리질문 대비 포인트

### "@EventListener와 @TransactionalEventListener의 차이는?"

실행 **시점**이 다르다. `@EventListener`는 `publishEvent()` 호출 즉시 그 자리에서 실행된다 — 발행자의 트랜잭션 안, 커밋 전이다. `@TransactionalEventListener`는 이벤트 처리를 트랜잭션 콜백으로 예약해 두었다가 지정한 phase에 실행한다.

기본값인 `AFTER_COMMIT`이면 커밋이 확정된 뒤에만 실행되고, 롤백되면 실행 자체가 안 된다. **"커밋이라는 사실이 확정된 뒤에만 해야 하는 일", 즉 되돌릴 수 없는 외부 시스템 반영**이 후자의 존재 이유다.

한 가지 더 붙이면 좋다. **트랜잭션이 아예 없으면 `@TransactionalEventListener`는 조용히 스킵된다** — `@EventListener`와 갈리는 또 하나의 지점이다.

### "이벤트 발행-리스너는 기본이 비동기인가?"

아니다. **동기, 같은 스레드, 같은 트랜잭션**이다.

`publishEvent()`가 리턴하기 전에 리스너들이 전부 실행되므로 스레드 이름을 찍어보면 발행자와 동일하고, 리스너의 예외는 발행자에게 그대로 전파되어 **발행자의 트랜잭션을 롤백시킨다.** 리스너 안의 DB 작업도 발행자와 같은 트랜잭션에 합류한다.

비동기로 만들려면 `@Async`를 명시적으로 조합해야 하고, 그 순간 `15-async-annotation.md`의 이슈 세트가 전부 따라온다. "이벤트니까 당연히 비동기"라고 답하면 바로 감점되는 지점이다.

### "AFTER_COMMIT 리스너에서 repository.save()가 조용히 안 먹는 이유는?"

`AFTER_COMMIT` 리스너는 **커밋은 끝났지만 리소스 정리는 아직 안 된 틈**에서 실행되기 때문이다. 커넥션과 `EntityManager`가 여전히 스레드에 묶여 있으므로, 기본 전파 속성 `REQUIRED`인 `save()`는 "진행 중인 트랜잭션이 있다"고 판단해 **이미 커밋이 끝난 그 트랜잭션에 참여자로 합류한다.**

참여자는 스스로 커밋하지 않고 바깥쪽이 커밋해줄 것을 기대하는데, 그 바깥쪽은 이미 커밋을 끝냈다. 결국 리소스 정리 단계에서 커밋 없이 버려진다. 예외가 안 나서 운영에서 한참 뒤에 발견되는 유형이다.

해결은 리스너 메서드에 `@Transactional(propagation = REQUIRES_NEW)`를 붙여 **기존 트랜잭션을 밀어두고 새 커넥션으로 자기 트랜잭션을 열게** 하는 것이다. 커넥션을 하나 더 점유한다는 대가까지 언급하면 완결이다.

### "AFTER_COMMIT 리스너가 실패하면? 커밋은 이미 됐는데 — 정합성은 어떻게 지키나?" (시니어 변별 포인트)

**롤백은 불가능하다는 사실부터 인정하고 시작한다.** 그리고 한 가지를 덧붙이면 깊이가 드러난다 — **그 예외는 호출자에게 전파되지도 않는다.** 스프링이 트랜잭션 완료 콜백의 예외를 잡아 에러 로그만 남기므로 컨트롤러는 정상 응답을 내려보낸다. 그래서 첫 번째 대책은 **리스너 안에서 실패를 잡아 지표와 알림으로 승격시켜 관측 가능하게 만드는 것**이다.

그다음 방어선을 요구사항의 심각도로 고른다.

① 불일치를 유계로 만들고 수용한다 — 토큰 TTL 30분이 불일치 상한이 되므로 스펙 레벨 의사결정으로 격상시킨다. ② 일시 장애라면 지수 백오프 재시도 + 상한 + 실패 알림. ③ 원래 변경을 취소하는 편이 나은 작업이라면 보상 트랜잭션 — 단 원 커밋과 보상 사이에 상태를 읽고 행동한 다른 요청은 되돌릴 수 없고 보상 자체도 실패할 수 있다는 허점을 짚는다. ④ 유실이 절대 안 되면 아웃박스 패턴으로 이벤트를 같은 트랜잭션에 저장하고 별도 릴레이가 발행한다.

**요구사항이 감당할 불일치의 크기로 단계를 고른다**고 답하면 시니어 답변이다.

### "@TransactionalEventListener를 붙였는데 리스너가 아예 안 불립니다. 왜죠?"

가장 흔한 원인은 **발행 시점에 트랜잭션이 없는 것**이다. 이 애노테이션은 진행 중인 트랜잭션에 콜백을 등록하는 방식이라 등록할 트랜잭션이 없으면 이벤트를 그냥 버리고, DEBUG 레벨 로그 한 줄만 남긴다. 기본 로그 레벨에서는 그 줄조차 안 보인다.

점검 순서는 이렇다. 발행 메서드에 `@Transactional`이 붙어 있는가, 붙어 있다면 그 메서드가 프록시를 거쳐 호출됐는가(같은 클래스 안의 `this` 호출이면 트랜잭션이 안 열린다), 테스트가 서비스 메서드를 거치지 않고 `publishEvent()`를 직접 부르고 있지는 않은가.

`fallbackExecution = true`로 트랜잭션 없이도 즉시 실행되게 할 수 있지만, **"트랜잭션이 없다"는 사실 자체가 대개 발행 지점의 버그 신호**이므로 원인을 먼저 확인하는 편이 낫다.

### "Spring Event로 계속 갈지, Kafka나 RabbitMQ 같은 브로커로 갈아탈지 — 기준은?"

Spring Event는 **한 프로세스 안**의 결합도를 낮추는 도구다. 이벤트가 애플리케이션 메모리에만 존재하므로 서버가 죽으면 유실되고, 다른 서비스(프로세스)에는 전달할 수 없다.

갈아타는 신호는 넷이다. 소비자가 다른 프로세스나 다른 서비스일 때, 이벤트 유실이 허용되지 않을 때(브로커는 디스크에 보존하고 ack를 받아야 지운다), 소비 속도를 발행 속도와 분리해 버퍼링해야 할 때, 재처리나 리플레이가 필요할 때.

반대로 같은 프로세스 안에서 부수 작업을 떼어내는 것이 목적이라면 브로커는 과투자다. 그리고 **아웃박스 + 브로커 조합은 "커밋과 발행의 원자성"이 실제 요구사항일 때 꺼내는 카드**이지 기본값이 아니다.

---

## 한 줄 요약

Spring Event는 기본이 동기·같은 스레드·같은 트랜잭션이라 결합도만 낮출 뿐 실행 흐름은 직접 호출과 같고(리스너의 예외가 발행자를 롤백시킨다), `@TransactionalEventListener(AFTER_COMMIT)`는 "트랜잭션에 참여하지 못하는 외부 시스템은 커밋이 확정된 뒤에만 건드린다"는 원칙을 코드로 강제해 거짓 알림·거짓 캐시를 막는다 — 대신 커밋이 끝난 자리라 리스너의 DB 쓰기는 `REQUIRES_NEW` 없이는 조용히 증발하고 트랜잭션이 없으면 리스너 자체가 스킵되며 실패해도 롤백은커녕 예외조차 올라오지 않으므로, 실패를 먼저 관측 가능하게 만든 뒤 수용·재시도·보상·아웃박스 중 요구사항이 감당할 불일치의 크기에 맞는 방어선을 고르는 것까지가 설계다.
