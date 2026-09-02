# Bean 순환 참조 — @Lazy로 덮기 전에 설계를 고쳐라

> 핵심 관전 포인트: **순환 참조는 A가 B를, B가 다시 A를 주입받아 의존 그래프가 고리를 이루는 상태다. 컨테이너가 기동을 실패시키는 것은 버그가 아니라 조기 경보이므로, 답의 1순위는 경보를 끄는 우회(`@Lazy`, 필드 주입 전환)가 아니라 의존을 단방향으로 되돌리는 설계 수정이다 — 공통 책임을 제3의 컴포넌트로 추출하거나, 사후 알림 성격의 역방향 호출을 이벤트로 끊거나, 인터페이스를 호출하는 쪽에 두어 의존 방향을 뒤집는다. `@Lazy`·`ObjectProvider`는 순환을 없애는 것이 아니라 첫 호출 시점으로 미루는 것이라 "부팅에서 잡히던 문제가 트래픽에서 터진다"는 대가가 붙고, 그래서 진단을 끝낸 뒤 부채로 기록하고 쓰는 차선책이다.**

---

## 0. 질문 + 의도

**질문**: "Bean 순환 참조가 발생하는 원인과 해결 방법은?"

**출제 의도**: 순환 참조는 대부분 잘못된 책임 분배의 증상이다. `@Lazy`로 덮는 답과 설계를 고치는 답 중 무엇이 먼저 나오는지로 설계 감각을 본다. 에러를 없애는 법만 아는 사람과, 에러가 가리키는 구조 문제를 읽는 사람을 가르는 질문.

*(이 문서의 버전 의존 서술은 Spring Boot 3.x / Spring Framework 6.x 기준이며, 내부 구현 인용은 Spring Framework 6.2 소스를 확인한 것이다.)*

## 1. 무엇이 왜 터지는가 — 그리고 왜 주입 방식에 따라 결과가 갈리는가

### 1-1. 순환 참조의 정의

**순환 참조(circular dependency)는 빈들의 의존 관계를 화살표로 그렸을 때 출발한 자리로 돌아오는 고리가 생긴 상태다.** A → B → A 처럼 둘일 수도 있고, A → B → C → A 처럼 셋 이상이 돌아 만드는 큰 고리일 수도 있다. 셋 이상짜리는 각 클래스만 따로 보면 아무 이상이 없어 보여서 눈으로 찾기가 훨씬 어렵다.

가장 흔한 두 개짜리 형태는 이렇게 생겼다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final PaymentService paymentService;   // A는 B가 있어야 만들어진다
}

@Service
@RequiredArgsConstructor
public class PaymentService {
    private final OrderService orderService;       // B는 A가 있어야 만들어진다
}
```

### 1-2. 생성자 주입에서는 어느 쪽도 시작할 수 없다

생성자 주입에서 위 코드는 애플리케이션이 **시작조차 못 한다**. 이유는 논리적이다.

```text
[생성자 주입 — 시작점이 존재하지 않는다]

  컨테이너: OrderService 를 만들자
              → new OrderService(paymentService) 를 호출하려면
                인자로 넘길 "완성된 PaymentService" 가 손에 있어야 한다
            그럼 PaymentService 를 먼저 만들자
              → new PaymentService(orderService) 를 호출하려면
                인자로 넘길 "완성된 OrderService" 가 손에 있어야 한다
            OrderService 는? 지금 만드는 중이고 완성본이 없다
              → BeanCurrentlyInCreationException (기동 실패)

  ★ 닭이 먼저냐 달걀이 먼저냐가 코드로 성립해버린 상태다.
    스프링이 게을러서가 아니라, 어느 쪽도 먼저 완성될 수 없어서 못 만드는 것이다.
```

반면 세터 주입과 필드 주입은 **껍데기(의존성이 아직 비어 있는 인스턴스)를 먼저 만들 수 있다.** 인자 없는 생성자로 객체를 일단 찍어낸 뒤 값을 나중에 꽂는 방식이라, 미완성인 A를 B에게 먼저 건네주고 나중에 이어붙이는 것이 가능하다. 그래서 과거에는 이 두 방식에서만 순환이 조용히 성립했다.

주입 방식별 시점 차이 자체와 "그래서 왜 생성자 주입을 권장하는가"는 `03-constructor-injection-over-field-injection.md`가 정면으로 다룬다. 이 문서는 그 위에서 **"성립하는 쪽은 스프링이 정확히 무슨 수를 쓴 것인가"**와 **"그래서 순환을 어떻게 없앨 것인가"**에 무게를 둔다.

### 1-3. 3단계 캐시 — 필드 주입 순환이 성립하는 진짜 메커니즘

"필드 주입은 되고 생성자 주입은 안 된다"의 진짜 답은 스프링이 싱글턴 빈을 담아 두는 **세 개의 맵**에 있다. `DefaultSingletonBeanRegistry`가 들고 있는 이 셋을 흔히 3단계 캐시라고 부른다.

| 단계 | 맵 이름 | 무엇이 들어 있는가 |
|---|---|---|
| 1차 | `singletonObjects` | 의존성 주입과 초기화까지 전부 끝난 **완성된 빈** |
| 2차 | `earlySingletonObjects` | 완성 전인데 이미 남에게 건네준 적이 있는 **미완성 참조** |
| 3차 | `singletonFactories` | 미완성 참조를 **필요할 때 만들어 낼 팩토리** |

빈을 찾을 때는 1차 → 2차 → 3차 순으로 뒤진다. 3차에서 팩토리를 찾으면 그것을 실행해 참조를 얻고, 그 결과를 2차로 올린 뒤 3차에서는 지운다. **같은 미완성 참조를 두 번 만들어 서로 다른 객체가 돌아다니는 것을 막기 위한 승격**이다.

핵심은 **완성되기 전에 참조를 미리 공개한다**는 것 하나다. A ↔ B 필드 주입 순환의 전 과정을 따라가면 이렇게 된다.

```text
① getBean("orderService")
     1차 캐시에 없다 → "지금 만드는 중" 으로 표시하고 생성 시작
②   new OrderService()            — 인자가 없으므로 껍데기가 즉시 만들어진다
③   singletonFactories 에 "orderService" 팩토리를 등록
       ★ 이 한 줄이 순환을 가능하게 만드는 지점이다.
         "아직 미완성이지만 참조는 꺼내 갈 수 있다" 고 공개한 것
④   populateBean — orderService.paymentService 필드를 채우려고
                   getBean("paymentService") 호출
⑤     1차 캐시에 없다 → paymentService 생성 시작
⑥     new PaymentService()        — 역시 껍데기
⑦     singletonFactories 에 "paymentService" 팩토리 등록
⑧     populateBean — paymentService.orderService 를 채우려고
                     getBean("orderService") 호출
⑨       1차 singletonObjects       : 없음 (아직 완성 전)
         2차 earlySingletonObjects : 없음
         3차 singletonFactories    : 있다!
           → 팩토리를 실행해 ② 의 껍데기 참조를 얻는다
           → 2차 캐시로 승격, 3차에서는 제거
           → paymentService.orderService = 미완성 orderService
⑩     paymentService 초기화 완료 → 1차 캐시에 등록
⑪   orderService.paymentService = 완성된 paymentService
     orderService 초기화 완료 → 1차 캐시에 등록

  결과: 서로를 가리키는 두 빈이 완성됐고 기동은 성공한다.
        ⑨ 에서 건네진 참조는 그 시점엔 미완성이었지만,
        ⑪ 에서 같은 객체가 완성되므로 결국은 온전한 빈을 가리킨다.
```

**생성자 주입에서 이 수법이 통하지 않는 이유가 ②에 있다.** 3차 캐시에 등록할 팩토리는 "이미 만들어진 인스턴스"를 감싸는 물건인데, 생성자 주입은 상대 빈이 없으면 그 인스턴스를 만드는 것부터가 불가능하다. 조기 참조는 **인스턴스가 일단 존재한 뒤에나 존재할 수 있다.** 그래서 생성자 주입 순환은 3단계 캐시로도 풀리지 않는다.

여기서 자연스럽게 따라오는 질문 하나. **왜 굳이 3단계인가, 미완성 객체를 2차 캐시에 바로 넣으면 안 되나?** 3차 캐시가 보관하는 것이 객체가 아니라 팩토리인 이유는 **AOP 프록시** 때문이다. 어떤 빈이 `@Transactional`처럼 프록시가 필요한 대상이면, 남에게 건네줄 참조는 원본이 아니라 프록시여야 한다. 그런데 프록시는 원래 초기화가 끝난 뒤에 만들어진다. 3차의 팩토리는 실행될 때 "이 빈이 프록시 대상이면 프록시를 지금 미리 만들어 내보내라"는 처리를 수행한다. **아무도 조기 참조를 요구하지 않으면 팩토리는 실행되지 않으므로, 프록시를 앞당겨 만드는 비용을 순환이 실제로 있는 경우에만 치른다.**

(가산점 포인트) 이 지점에는 순환을 허용해도 여전히 실패하는 함정이 하나 있다. 조기 참조를 넘겨준 뒤 초기화 과정에서 그 빈이 **다른 객체로 감싸지면**(예상 밖의 후처리로 프록시가 나중에 씌워지는 경우), 남들이 붙들고 있는 참조와 최종 빈이 서로 다른 객체가 된다. 스프링은 이 상황을 감지해 `Bean with name '...' has been injected into other beans [...] in its raw version as part of a circular reference, but has eventually been wrapped`라는 메시지로 기동을 실패시킨다. **순환을 허용해도 안전이 보장되는 것은 아니라는 근거**로 쓸 수 있다.

### 1-4. Spring Boot 2.6부터는 필드 주입 순환도 기본 금지다

여기가 옛 자료를 그대로 믿으면 안 되는 지점이다. 인터넷에는 아직도 "생성자 주입에서 순환이 나면 필드 주입으로 바꾸면 된다"는 글이 남아 있는데, **지금 기본 설정에서는 그렇게 해도 기동이 실패한다.**

사실 관계를 정확히 나눠 두자. 순환 허용 여부를 정하는 스위치는 `AbstractAutowireCapableBeanFactory.allowCircularReferences`이고, **Spring Framework 자체의 기본값은 `true`**다. 그런데 **Spring Boot는 2.6부터 이 값을 `false`로 뒤집어 놓는다.** 즉 순환을 금지한 것은 프레임워크 코어가 아니라 부트의 판단이다. Boot 3.x도 이 기본값을 유지한다.

```yaml
# 이 설정이 없으면(=기본값 false) 세터·필드 주입 순환도 기동에 실패한다
spring:
  main:
    allow-circular-references: true   # 임시 우회. 켰다는 사실 자체가 부채다
```

이 값이 `false`이면 1-3의 ③ 단계, 즉 **3차 캐시에 조기 참조 팩토리를 등록하는 일 자체를 건너뛴다.** 그래서 ⑨에서 팩토리를 못 찾고, 이미 생성 중인 빈을 또 만들려 한다는 판정이 나 `BeanCurrentlyInCreationException`으로 끝난다. 3단계 캐시가 아예 작동하지 않는 것이다.

**프레임워크 스스로 "이 꼼수는 기본으로 켜 두지 말라"고 기본값을 바꿨다**는 사실은 면접에서 그대로 근거가 된다. 순환 참조가 취향 문제가 아니라 설계 결함이라는 공식 입장인 셈이다.

### 1-5. 에러 메시지를 읽어 문제의 클래스 쌍을 특정하는 법

기동 실패 로그는 길지만, 순환 참조일 때는 부트가 사이클을 그림으로 그려 준다. `BeanCurrentlyInCreationFailureAnalyzer`가 예외의 `cause` 사슬을 거슬러 올라가며 같은 빈 이름이 두 번 나오는 지점을 찾아 아래 형태로 출력한다.

```text
***************************
APPLICATION FAILED TO START
***************************

Description:

The dependencies of some of the beans in the application context form a cycle:

┌─────┐
|  orderService defined in file [/app/classes/com/example/order/OrderService.class]
↑     ↓
|  paymentService defined in file [/app/classes/com/example/payment/PaymentService.class]
└─────┘

Action:

Relying upon circular references is discouraged and they are prohibited by default.
Update your application to remove the dependency cycle between beans. As a last resort,
it may be possible to break the cycle automatically by setting
spring.main.allow-circular-references to true.
```

읽는 법은 세 가지만 기억하면 된다.

**첫째, `┌`와 `└` 사이에 나열된 빈 이름이 고리의 구성원 전부다.** 두 줄이면 두 개짜리 순환이고, 다섯 줄이면 다섯 개가 도는 큰 고리다. 화살표는 위에서 아래로 "이 빈이 아래 빈을 필요로 한다"는 뜻이고, 마지막 줄에서 다시 첫 줄로 돌아온다.

**둘째, 빈 이름 옆의 괄호가 어느 자리에서 걸렸는지를 알려준다.** 클래스 파일 경로가 찍히면 그 클래스 정의 자체이고, `(field private com.example.PaymentService com.example.OrderService.paymentService)` 형태로 필드가 찍히면 **그 필드가 문제의 주입 지점**이다. 필드가 명시된 줄이 있으면 거기부터 보면 된다.

**셋째, 고리가 셋 이상이면 "가장 어색한 화살표"를 찾는다.** `orderService → paymentService → notificationService → orderService`라면, 세 화살표 중 도메인 상식에 비추어 가장 부자연스러운 하나가 끊어야 할 지점이다. 보통 마지막 화살표(알림이 주문을 다시 부르는 것 같은 역방향)가 그렇다. 2절의 처방은 이 "끊을 화살표"를 정한 뒤에 고르는 것이다.

## 2. 1순위 해결 — 설계를 고쳐 의존을 단방향으로 만든다

### 2-1. 먼저 진단한다 — 두 빈이 서로에게 원하는 것이 무엇인가

순환을 발견하면 코드를 고치기 전에 질문 하나를 던진다. **"A가 B에게 시키는 일과, B가 A에게 시키는 일이 각각 무엇인가?"** 이 답에 따라 처방이 갈린다.

```text
A → B 와 B → A 의 내용을 적어 본다
   │
   ├─ 양쪽이 사실 같은 하위 작업을 서로에게 부탁하고 있다
   │     → ① 공통 책임을 제3의 컴포넌트로 추출 (2-2)
   │
   ├─ B → A 가 "B의 일이 끝났으니 A도 반응하라" 는 사후 통지다
   │   (본 흐름이 그 결과값을 쓰지 않는다)
   │     → ② 이벤트로 역방향을 끊는다 (2-3)
   │
   ├─ B → A 가 본 흐름 안에서 결과를 받아 써야 하는 동기 호출이다
   │     → ③ 인터페이스를 B 쪽에 두어 의존 방향을 뒤집는다 (2-4)
   │
   └─ 두 클래스가 계속 서로를 부르며 한 시나리오를 완성한다
         → ④ 애초에 한 책임이므로 병합한다 (2-5)
```

세 방향 전부 목표는 하나다. **의존 그래프에서 고리를 없애 화살표가 한 방향으로만 흐르게 만드는 것.**

### 2-2. ① 공통 책임을 제3의 컴포넌트로 추출한다

가장 흔한 원인이자 가장 자주 정답인 처방이다. A와 B가 서로에게 요구하는 기능을 들여다보면, 그것이 **양쪽 어느 쪽의 고유 책임도 아닌 공통 하위 작업**인 경우가 많다.

```java
// before: 주문이 결제를 부르고, 결제가 주문 상태를 바꾸려고 주문을 다시 부른다
@Service
@RequiredArgsConstructor
public class OrderService {
    private final PaymentService paymentService;

    public void order(Long orderId) {
        paymentService.pay(orderId);
    }

    // 이 메서드 하나 때문에 PaymentService 가 OrderService 를 알아야 한다
    public void markPaid(Long orderId) { /* 주문 상태를 PAID 로 */ }
}

@Service
@RequiredArgsConstructor
public class PaymentService {
    private final OrderService orderService;   // 역방향 의존 — 여기서 고리가 닫힌다

    public void pay(Long orderId) {
        // ... 결제 처리 ...
        orderService.markPaid(orderId);
    }
}
```

`markPaid`가 무엇인지 다시 보자. 이것은 "주문 상태를 바꾼다"는 **주문 도메인의 상태 전이 작업**이지, `OrderService`의 주문 접수 흐름에 붙어 있어야 할 이유가 없다. 그러니 그 부분만 떼어 자기 집을 만들어 준다.

```java
// after: "주문 상태 전이" 라는 공통 관심사를 자기 컴포넌트로 독립시킨다
@Component
@RequiredArgsConstructor
public class OrderStatusUpdater {
    // 이 빈은 OrderService 도 PaymentService 도 모른다.
    // 양쪽 어디에도 의존하지 않으므로 고리에 참여할 수가 없다.
    private final OrderRepository orderRepository;

    @Transactional
    public void markPaid(Long orderId) { /* 주문 상태를 PAID 로 */ }
}

@Service
@RequiredArgsConstructor
public class OrderService {
    private final PaymentService paymentService;

    public void order(Long orderId) { paymentService.pay(orderId); }
}

@Service
@RequiredArgsConstructor
public class PaymentService {
    private final OrderStatusUpdater orderStatusUpdater;   // 제3의 빈에만 의존한다

    public void pay(Long orderId) {
        // ... 결제 처리 ...
        orderStatusUpdater.markPaid(orderId);
    }
}
```

의존 그래프를 그려 보면 차이가 분명하다.

```text
before                              after
  OrderService ⇄ PaymentService       OrderService → PaymentService → OrderStatusUpdater
      ↑_____________|                                                        ↓
   화살표가 되돌아온다 (고리)                                          OrderRepository

                                     화살표가 한 방향으로만 흐른다
```

**이 방법이 좋은 이유는 순환이 사라져서만이 아니다.** "주문 상태 변경"이라는 책임의 주인이 하나로 정해졌다. 나중에 배송 서비스나 정산 배치가 같은 상태 전이를 해야 할 때, 그들도 `OrderService` 전체를 끌어오지 않고 `OrderStatusUpdater`만 가져다 쓴다.

**언제 쓰나**: 두 빈이 서로에게 요구하는 일이 도메인적으로 어느 한쪽의 고유 책임이 아닐 때. 순환의 가장 흔한 원인이므로 이것부터 검토한다.

### 2-3. ② 이벤트로 역방향 의존을 끊는다

`markPaid` 같은 상태 전이가 아니라 **"결제가 끝났으니 알림도 보내고 포인트도 적립하라"**처럼 뒤에 따라붙는 후속 작업이라면, 추출보다 이벤트가 맞다. 후속 작업은 앞으로 계속 늘어나는데, 늘어날 때마다 `PaymentService`의 의존성이 하나씩 늘어나는 구조를 만들고 싶지 않기 때문이다.

**이벤트 발행은 "이런 일이 일어났다"는 사실만 컨테이너에 던지고, 누가 그것을 받아 무엇을 하는지는 신경 쓰지 않는 방식이다.** 발행하는 쪽이 구독하는 쪽의 존재를 모른다는 점이 핵심이고, 그래서 컴파일 의존이 한 방향으로 끊긴다.

```java
// after: PaymentService 는 OrderService 를 모른다. 사실만 발행한다.
@Service
@RequiredArgsConstructor
public class PaymentService {
    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public void pay(Long orderId) {
        // ... 결제 처리 ...
        // "결제가 완료됐다" 는 사실만 던진다. 받는 쪽이 몇 개든 여기 코드는 안 바뀐다.
        eventPublisher.publishEvent(new PaymentCompletedEvent(orderId));
    }
}

@Component
@RequiredArgsConstructor
public class PaymentCompletedListener {
    private final OrderRepository orderRepository;

    // AFTER_COMMIT: 결제 트랜잭션이 커밋된 뒤에만 실행하라는 뜻이다.
    // 커밋 전에 실행하면 "롤백됐는데 알림은 이미 나간" 사고가 난다.
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(PaymentCompletedEvent event) { /* 주문 상태 변경, 알림 등 */ }
}
```

여기서 반드시 짚고 넘어가야 할 함정이 둘 있다.

**첫째, 스프링 이벤트는 기본이 동기다.** `publishEvent`는 리스너를 같은 스레드에서 곧바로 호출하고 끝날 때까지 기다린다. "이벤트로 바꿨으니 비동기가 됐다"고 생각하면 느린 리스너가 그대로 응답 시간을 붙잡는다.

**둘째, `AFTER_COMMIT` 리스너 안의 DB 쓰기는 조용히 반영되지 않을 수 있다.** 이미 커밋이 끝난 트랜잭션에 얹혀 실행되기 때문이다. 순환을 없애려다 정합성 사고를 새로 만드는 대표적인 경로이므로, 이벤트로 갈아탈 때는 실행 시점과 실패 경로를 함께 설계해야 한다. 이 두 함정의 자세한 동작과 대응은 `16-spring-event-transactional-event-listener.md`가 다룬다.

**언제 쓰나**: 역방향 호출이 사후 통지 성격이고, 본 흐름이 그 결과값을 쓰지 않을 때. 반대로 결과를 받아 다음 분기를 해야 한다면 이벤트는 맞지 않는다.

### 2-4. ③ 인터페이스를 호출하는 쪽에 두어 의존 방향을 뒤집는다

본 흐름 안에서 동기로 결과를 받아 써야 해서 이벤트가 맞지 않고, 그렇다고 공통 하위 작업으로 떼어낼 것도 아닌 경우가 있다. 이때 쓰는 것이 **의존성 역전**이다.

먼저 용어를 풀어 두자. **의존성 역전(Dependency Inversion)은 "구체적인 구현이 아니라 추상(인터페이스)에 의존하게 만든다"는 원칙이고, 핵심은 그 인터페이스를 누가 소유하느냐에 있다.** 인터페이스를 **호출하는 쪽 패키지에 두면**, 호출하는 쪽은 자기 패키지 안의 인터페이스만 알면 되고 구현체가 사는 패키지를 몰라도 된다. 그러면 화살표가 뒤집힌다 — 원래 "호출하는 쪽 → 구현체"였던 컴파일 의존이 "구현체 → 호출하는 쪽의 인터페이스"가 된다. 이름의 "역전"은 이 화살표 방향이 뒤집힌다는 뜻이다.

비유하면 **콘센트 규격을 전자제품 회사가 아니라 건물이 정하는 것**과 같다. 건물이 "여기 꽂을 거면 이 모양이어야 한다"는 규격(인터페이스)을 자기 벽에 박아 두면, 건물은 어느 회사 제품이 꽂힐지 몰라도 되고 제품 쪽이 규격에 맞춰 온다.

```java
// before: 결제가 주문 정보를 조회해야 해서 OrderService 를 직접 부른다
package com.example.payment;

@Service
@RequiredArgsConstructor
public class PaymentService {
    private final OrderService orderService;   // com.example.order 를 직접 안다 — 순환

    public PaymentResult pay(Long orderId) {
        int amount = orderService.getPayableAmount(orderId);   // 결과가 바로 필요하다
        return charge(amount);
    }
}
```

```java
// after: 필요한 능력을 "결제 쪽이 정의한 인터페이스" 로 선언한다
package com.example.payment;

// 이 인터페이스는 결제 패키지가 소유한다.
// "결제가 남에게 요구하는 최소한의 능력" 만 담는다 — 주문 도메인 전체가 아니다.
public interface PayableAmountProvider {
    int getPayableAmount(Long orderId);
}

@Service
@RequiredArgsConstructor
public class PaymentService {
    private final PayableAmountProvider amountProvider;   // 자기 패키지의 인터페이스만 안다

    public PaymentResult pay(Long orderId) {
        return charge(amountProvider.getPayableAmount(orderId));
    }
}
```

```java
// after: 구현체는 주문 쪽에 둔다. 화살표가 order → payment 한 방향이 된다.
package com.example.order;

@Component
@RequiredArgsConstructor
public class OrderPayableAmountProvider implements PayableAmountProvider {
    private final OrderRepository orderRepository;   // OrderService 가 아니라 저장소에 의존한다

    @Override
    public int getPayableAmount(Long orderId) {
        return orderRepository.findAmount(orderId);
    }
}
```

```text
before                                   after
  order  ──────────→ payment               order ──────────→ payment
    ↑                   │                    │   (OrderService → PaymentService)
    └───────────────────┘                    │
       payment → order 로 되돌아온다          └── OrderPayableAmountProvider
                                                    implements payment.PayableAmountProvider
                                                    (구현이 인터페이스를 따라가므로
                                                     화살표는 여전히 order → payment)

  payment 패키지는 order 패키지를 컴파일 시점에 전혀 모른다.
  빈 그래프도 OrderService → PaymentService → OrderPayableAmountProvider → OrderRepository
  로 고리 없이 흐른다.
```

여기서 흔한 실수 하나. **구현체가 `OrderService`를 주입받으면 고리가 그대로 돌아온다.** `OrderPayableAmountProvider`가 `OrderRepository` 같은 하위 계층에 의존하도록 만들어야 순환이 실제로 끊긴다. 구현체를 얇게 유지하는 것이 이 처방의 전제다.

**언제 쓰나**: 동기 호출이 필요하고 결과값을 본 흐름에서 써야 할 때. 모듈 경계를 유지하면서 순환만 끊고 싶을 때. 대가는 인터페이스와 구현체가 서로 다른 패키지에 흩어져 "구현을 찾아가기가 조금 번거로워진다"는 것 정도다.

### 2-5. ④ 애초에 한 책임이면 합친다

추출도 이벤트도 역전도 전부 어색하게 느껴진다면, 마지막 가능성을 봐야 한다. **두 클래스가 사실은 한 책임을 억지로 나눠 가진 것**일 수 있다. 서로를 계속 부르면서 한 시나리오를 완성하고 있다면 그건 이미 한 덩어리다.

"쪼개져 있다 = 좋은 설계"가 아니다. 응집도는 **관련된 것이 함께 있는 정도**를 말하는데, 서로를 끊임없이 부르는 두 클래스는 응집도가 높은 하나를 억지로 둘로 자른 결과인 경우가 많다. 이때는 메서드를 한쪽으로 옮겨 병합하는 것이 정답이고, 그 결과 클래스가 너무 커진다면 **원래 나눴던 선이 아니라 다른 선으로** 다시 나눠야 한다는 뜻이다.

### 2-6. 처방 선택표

| 두 빈의 관계 | 처방 | 남는 의존 방향 |
|---|---|---|
| 양쪽이 같은 하위 작업을 서로에게 부탁 | ① 제3의 컴포넌트 추출 | A → C ← B |
| B의 완료를 A에게 통지, 결과값은 불필요 | ② 이벤트 발행/구독 | B → (이벤트) ← 리스너 |
| B가 A의 정보를 동기로 받아 써야 함 | ③ 인터페이스를 B 패키지에 두고 역전 | A → B (구현체가 따라감) |
| 둘이 계속 왕복하며 한 시나리오를 완성 | ④ 병합 후 다른 선으로 재분할 | 고리 자체가 소멸 |

## 3. 차선책 — 우회 수단과 각각이 치르는 대가

설계 수정이 당장 불가능한 상황은 실제로 있다. 대규모 레거시라 파급이 크거나, 릴리즈 직전이거나, 순환의 한쪽이 우리가 못 고치는 라이브러리 빈일 수 있다. 그때 쓰는 수단들인데, **전부 "순환을 없애는 것이 아니라 해소 시점을 뒤로 미루는 것"**이라는 공통점과 그에 따르는 대가가 있다.

### 3-1. `@Lazy` — 프록시를 끼워 넣어 시점을 미룬다

먼저 무엇이 주입되는지부터 정확히 하자. **`@Lazy`가 붙은 주입 지점에는 진짜 빈이 아니라 프록시가 들어간다. 프록시는 원본인 척하는 대리인 객체로, 메서드 호출을 먼저 받아 그때 컨테이너에서 진짜 빈을 조회한 뒤 그 호출을 넘긴다.**

```java
@Service
public class PaymentService {
    private final OrderService orderService;

    public PaymentService(@Lazy OrderService orderService) {
        // 여기 들어오는 것은 OrderService 타입의 프록시다.
        // 프록시를 만드는 데는 진짜 OrderService 가 필요 없으므로
        // "완성된 상대가 있어야 나를 만들 수 있다" 는 교착이 풀린다.
        this.orderService = orderService;
    }

    public void pay(Long orderId) {
        // 이 줄이 처음 실행되는 순간에야 컨테이너에서 진짜 OrderService 를 찾아 위임한다.
        orderService.markPaid(orderId);
    }
}
```

```text
[@Lazy 가 실제로 한 일]

  기동 시점   PaymentService 생성  ←  프록시만 있으면 되므로 통과
              OrderService 생성    ←  완성된 PaymentService 를 받아 통과
              ★ 순환은 그대로 있는데 기동만 성공했다

  첫 호출     pay() → 프록시.markPaid() → 컨테이너에서 orderService 조회 → 위임
              ★ 문제가 있다면 여기서 처음 드러난다
```

**대가는 시작 시점 검증을 잃는다는 것이다.** 순환을 기동에서 잡아 주던 조기 경보가 사라지고, 문제가 "특정 트래픽이 그 경로를 밟는 시점"으로 미뤄진다. 배포 직후 헬스체크는 초록색인데 한참 뒤 실제 사용자 요청에서 터지므로, 배포와 장애의 시간 간격 때문에 원인 추적이 어려워진다.

부수적인 대가도 둘 있다. **코드만 봐서는 순환이 있다는 사실이 보이지 않아** 다음 사람이 그 위에 의존을 더 쌓고, **프록시가 끼어들었으므로** 상대 빈이 프록시로 감쌀 수 없는 형태(final 클래스 등)면 그마저도 실패한다.

### 3-2. `ObjectProvider` — 지연 조회를 코드에 드러낸다

`@Lazy`와 원리는 같지만 지연이 타입에 드러난다는 점이 다르다.

```java
@Service
@RequiredArgsConstructor
public class PaymentService {
    // 타입 자체가 "이건 지금 꺼내는 게 아니라 나중에 꺼내는 의존" 이라고 말한다
    private final ObjectProvider<OrderService> orderServiceProvider;

    public void pay(Long orderId) {
        orderServiceProvider.getObject().markPaid(orderId);
    }
}
```

`@Lazy`보다 나은 점은 **숨지 않는다는 것 하나**다. 코드 리뷰에서 `ObjectProvider`가 보이면 "여기 순환이 있구나"를 바로 알 수 있다. 대신 사용하는 자리마다 `getObject()`가 붙어 코드가 조금 지저분해진다. **순환은 여전히 그대로 있다**는 점도 `@Lazy`와 똑같다.

### 3-3. `ApplicationContext`를 직접 주입받아 조회 — 마지막 수단

```java
// 문제: 컨테이너 자체를 의존성으로 들고 다니게 된다
@Service
@RequiredArgsConstructor
public class PaymentService {
    private final ApplicationContext context;

    public void pay(Long orderId) {
        context.getBean(OrderService.class).markPaid(orderId);
    }
}
```

이 방식은 앞의 둘보다 확실히 나쁘다. 이유가 셋이다.

**첫째, 의존성이 생성자 시그니처에서 사라진다.** 이 클래스가 실제로 무엇을 필요로 하는지가 메서드 본문을 다 읽어야 알 수 있게 되고, `03-constructor-injection-over-field-injection.md`가 말하는 "의존성을 공개 계약으로 드러낸다"는 이득이 통째로 없어진다.

**둘째, 단위 테스트가 무거워진다.** 목을 넣으려면 `ApplicationContext`를 모킹해 `getBean` 호출까지 스텁해야 한다.

**셋째, 빈이 없으면 기동이 아니라 호출 시점에 터진다.** `@Lazy`와 같은 문제인데, 타입 안전성까지 더 잃는다.

이 패턴에는 **서비스 로케이터(service locator)**라는 이름이 붙어 있다. 필요한 것을 주입받는 대신 "찾아 주는 창구"에 매번 물어보는 방식이라 그렇게 부르고, 의존성 주입이 해결한 문제로 되돌아가는 것이라 안티패턴으로 취급된다.

### 3-4. 하지 말아야 할 것 — 필드 주입 전환으로 "해결"

`spring.main.allow-circular-references=true`를 켜고 필드 주입으로 바꾸면 에러 메시지는 사라진다. 하지만 이것은 **경보기를 끄는 것**이지 해결이 아니다.

잃는 것을 세어 보면 손해가 분명하다. 순환 구조는 그대로 남고, 여기에 더해 생성자 주입이 주던 것들 — `final`로 보장되는 불변성, 컨테이너 밖에서 반제품 객체가 만들어지지 않는다는 보장, 컨테이너 없이 도는 단위 테스트, 의존성이 늘어나는 것이 눈에 보이는 설계 신호 — 을 **한꺼번에** 버린다. 순환 하나를 덮으려고 코드베이스 전체의 주입 정책을 후퇴시키는 거래다.

면접에서 이것을 첫 번째 해결책으로 말하면 설계 감각을 의심받는다. 우선순위를 한 줄로 정리하면 이렇다.

**설계 수정(추출 / 이벤트 / 역전 / 병합) > `ObjectProvider` ≈ `@Lazy`(부채로 기록) > `ApplicationContext` 직접 조회 > 필드 주입 전환(사실상 금지)**

우회를 쓰기로 했다면 **왜 순환이 있고 언제 걷어낼지를 주석과 이슈로 남기는 것까지가 조치**다. 기록이 없으면 다음 사람은 그것을 정상적인 구조로 오해한다.

## 4. 꼬리질문 대비 포인트

### "필드 주입으로 바꾸면 에러가 사라지는데, 그럼 해결된 것 아닌가요?"

**에러가 사라진 것이지 문제가 사라진 것이 아니다.** 순환이라는 구조는 그대로고, 컨테이너가 3단계 캐시로 미완성 참조를 미리 꺼내 억지로 이어붙여 준 것뿐이다.

그리고 **지금은 그마저도 안 된다.** Spring Boot 2.6부터 `spring.main.allow-circular-references`의 기본값이 `false`라서, 필드 주입이어도 기동이 실패한다. 옛 자료를 보고 온 답이라는 인상을 주지 않으려면 이 버전 사실을 정확히 말하는 것이 좋다.

마무리는 관점 전환으로 한다. **"생성자 주입에서 순환이 기동 시점에 터져 주는 것은 단점이 아니라 조기 발견이라는 장점"**이고, 그것을 끄는 방향의 조치는 진단이 끝난 뒤에 부채로 기록하고 쓰는 것이다.

### "필드 주입 순환을 스프링이 내부적으로 어떻게 조립해 주나요?" (가산점 포인트)

싱글턴 3단계 캐시로 답한다. **1차 `singletonObjects`는 완성된 빈, 2차 `earlySingletonObjects`는 이미 남에게 건네준 미완성 참조, 3차 `singletonFactories`는 그 미완성 참조를 만들어 낼 팩토리**를 보관한다. 조회는 1차 → 2차 → 3차 순이고, 3차에서 만들어진 참조는 2차로 승격되면서 3차에서 제거된다.

A를 만드는 도중 B가 A를 요구하면 3차 캐시의 팩토리로 A의 조기 참조를 꺼내 B에 주입하고, B가 완성된 뒤 그 B를 A의 필드에 넣어 A도 완성시킨다.

**3차가 객체가 아니라 팩토리인 이유**까지 말하면 깊이가 드러난다. 그 빈이 AOP 대상이면 남에게 건넬 참조는 프록시여야 하는데, 프록시는 원래 초기화 후에 만들어진다. 팩토리는 실행되는 순간 프록시를 앞당겨 만들어 내보내고, **아무도 조기 참조를 요구하지 않으면 실행되지 않으므로 그 비용을 순환이 있는 경우에만 치른다.**

그리고 **생성자 주입은 이 메커니즘으로도 못 푼다.** 조기 참조를 3차 캐시에 등록하려면 인스턴스가 일단 존재해야 하는데, 생성자 주입은 그 인스턴스를 만드는 것부터가 상대를 요구하기 때문이다.

### "`@Lazy`는 내부적으로 어떻게 순환을 끊나요? 대가는 없나요?"

진짜 빈 대신 **프록시**를 주입한다. 프록시를 만드는 데는 상대 빈이 필요 없으므로 생성 교착이 풀리고, 프록시의 메서드가 처음 호출되는 순간 컨테이너에서 실제 빈을 조회해 위임한다. 즉 **"주입 시점의 의존"을 "사용 시점의 의존"으로 바꾼 것**이다.

대가는 명확히 말해야 한다. **순환은 없어지지 않았고 해소 시점만 뒤로 밀렸다.** 부팅에서 잡히던 문제가 특정 트래픽이 그 경로를 밟는 시점으로 옮겨가므로, 배포와 장애 사이에 시간 간격이 생겨 원인 추적이 어려워진다. 코드에서 순환이 보이지 않게 되어 사이클이 조용히 자라는 것도 대가다.

### "순환 참조 에러를 만나면 설계에서 무엇부터 의심하나요?" (시니어 변별 포인트)

**두 빈이 서로에게 원하는 것이 각각 무엇인지부터 적어 본다.** 그 내용에 따라 처방이 갈리기 때문이다.

**① 양쪽이 공유하는 하위 작업이 각자 안에 박혀 있다** → 제3의 컴포넌트로 추출한다. 가장 흔하고 대개 정답이다. "주문 상태 변경"처럼 어느 쪽의 고유 책임도 아닌 것이 한쪽 클래스에 얹혀 있는 경우다.

**② "B가 끝나면 A가 반응해야 한다"는 사후 통지가 직접 호출로 구현돼 있다** → 이벤트로 역전한다. 단, 스프링 이벤트는 기본이 동기이고 `AFTER_COMMIT` 리스너의 DB 쓰기는 반영되지 않을 수 있다는 함정을 함께 알고 있어야 한다.

**③ 동기로 결과를 받아 써야 해서 이벤트가 안 맞는다** → 인터페이스를 호출하는 쪽 패키지에 두어 의존 방향을 뒤집는다. 이때 구현체가 다시 원래 서비스를 주입받으면 고리가 그대로 돌아오므로, 구현체는 저장소 같은 하위 계층에만 의존하게 얇게 만든다.

**④ 두 클래스가 계속 왕복하며 한 시나리오를 완성한다** → 애초에 경계를 잘못 그은 것이므로 병합한 뒤 다른 선으로 다시 나눈다.

마무리는 순서를 밝히는 것이다. **`@Lazy`는 이 진단을 끝낸 뒤에도 당장 못 고칠 때 부채로 기록하고 쓰는 임시 조치**이고, 우회를 먼저 말하고 설계를 나중에 말하면 순서가 뒤집힌 것이다.

### "셋 이상이 도는 순환은 어떻게 찾고 끊나요?"

두 개짜리는 눈에 보이지만 `A → B → C → A`는 각 클래스만 보면 아무 이상이 없다. 그래서 **부트의 실패 메시지를 읽는 것이 출발점**이다. `The dependencies of some of the beans in the application context form a cycle:` 아래에 `┌`와 `└` 사이로 고리 구성원 전부가 순서대로 나열되고, 필드 주입이면 문제의 필드까지 괄호에 찍힌다.

끊을 지점을 고르는 기준은 **"도메인 상식에 비추어 가장 부자연스러운 화살표"**다. 보통 하위 개념이 상위 개념을 되부르는 화살표(알림이 주문을 부르고, 결제가 주문을 부르는 식)가 그렇다. 그 하나를 2절의 처방 중 하나로 끊으면 고리가 열린다. 고리를 이루는 모든 화살표를 다 손볼 필요는 없다.

여기에 예방책을 덧붙이면 좋다. **패키지 간 의존 방향을 테스트로 못 박아 두는 것**이다. ArchUnit 같은 도구로 "`payment` 패키지는 `order` 패키지를 참조하지 않는다"는 규칙을 테스트로 만들어 두면, 순환이 만들어지는 순간이 아니라 만들어지려는 순간에 CI가 잡는다. 기동 실패보다 한 단계 더 앞에서 막는 셈이다.

### "`@Lazy`로 풀어 둔 순환은 운영에서 어떤 식으로 문제가 되나요?"

세 가지가 순서대로 온다.

**첫째, 장애 시점이 배포에서 트래픽으로 옮겨간다.** 부팅과 헬스체크는 통과하지만 실제 호출 경로에서 프록시가 처음 풀리는 순간 문제가 드러난다. 배포 직후가 아니라 몇 시간 뒤 특정 요청에서 터지므로 "방금 배포한 것과 관계있나"를 판단하기 어려워진다.

**둘째, 사이클이 조용히 자란다.** 코드 리뷰에서 순환의 존재가 보이지 않으므로, 그 위에 의존이 계속 쌓여 나중에는 두 개짜리였던 고리가 넷·다섯짜리가 된다. 그때는 끊을 지점을 고르는 것부터 어려워진다.

**셋째, 초기화 순서에 암묵적으로 기대는 코드가 섞이면 "어쩌다 되는" 코드가 된다.** `@PostConstruct`에서 상대 빈을 건드리는 로직이 대표적이다. 프록시가 아직 안 풀린 상태에서 호출되면 빈 조회가 그 자리에서 일어나며 예상치 못한 순서 문제를 만든다.

그래서 `@Lazy`를 쓸 때는 **왜 순환이 있고 언제 걷어낼지를 주석과 이슈로 남기는 것까지가 조치**라고 답한다.

---

## 한 줄 요약

순환 참조는 컨테이너의 버그가 아니라 "하나의 책임이 두 클래스에 찢어져 있다"는 설계 경보이며 — 세터·필드 주입에서 성립하던 것은 스프링이 3단계 캐시로 완성 전의 미완성 참조를 미리 노출해 서로를 이어붙여 준 덕분이지 문제가 없어서가 아니고, Spring Boot 2.6부터는 `spring.main.allow-circular-references`가 기본 `false`라 그 경로마저 기동에 실패한다 — 그러니 답은 부트가 그려 주는 사이클 메시지로 문제의 빈 쌍을 특정한 뒤 공통 책임 추출·이벤트 역전·인터페이스 소유 역전·병합 중 하나로 의존을 단방향으로 되돌리는 것이고, `@Lazy`와 `ObjectProvider`는 순환을 없애는 것이 아니라 첫 호출 시점으로 미루는 것이므로 진단을 끝낸 뒤 부채로 기록하고 쓰는 차선책이다.
