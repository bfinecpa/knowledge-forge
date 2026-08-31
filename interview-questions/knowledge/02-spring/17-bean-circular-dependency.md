# Bean 순환 참조 — @Lazy로 덮기 전에 설계를 고쳐라

> 핵심 관전 포인트: **순환 참조는 A가 B를, B가 다시 A를 주입받는
> 의존 사이클이다. 생성자 주입에서는 "서로가 먼저 만들어져 있어야
> 내가 만들어지는" 교착이라 컨테이너가 시작 시점에 즉시 실패시킨다 —
> 이것은 버그가 아니라 조기 경보다. 해결의 1순위는 @Lazy 같은 우회가
> 아니라 설계 수정이다: 두 빈이 서로를 부른다는 건 하나의 책임이
> 두 클래스에 찢어져 있다는 증상이므로, 공통 책임을 제3의 컴포넌트로
> 추출하거나 이벤트로 역방향 의존을 끊어 단방향으로 만든다.
> @Lazy·ObjectProvider는 설계를 못 고칠 때의 차선책이고,
> 필드 주입으로 바꿔 "해결"하는 건 경보기를 끄는 짓이다.**

---

## 0. 질문 + 의도

**질문**: "Bean 순환 참조가 발생하는 원인과 해결 방법은?"

**출제 의도**: 순환 참조는 대부분 잘못된 책임 분배의 증상이다.
`@Lazy`로 덮는 답과 설계를 고치는 답 중 무엇이 먼저 나오는지로
설계 감각을 본다. 에러를 없애는 법만 아는 사람과, 에러가 가리키는
구조 문제를 읽는 사람을 가르는 질문.

## 1. 순환 참조란 — 그리고 왜 생성자 주입에서 터지는가

순환 참조(circular dependency)는 빈들의 의존 관계가 고리를 이루는
상태다. A → B → A 처럼 둘일 수도, A → B → C → A 처럼 셋 이상일 수도
있다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final PaymentService paymentService;  // A는 B가 필요
}

@Service
@RequiredArgsConstructor
public class PaymentService {
    private final OrderService orderService;      // B는 A가 필요
}
```

생성자 주입에서 이 코드는 애플리케이션이 **시작조차 못 한다**
(`BeanCurrentlyInCreationException`). 이유는 단순하다:

- `OrderService`를 만들려면 생성자 인자로 완성된 `PaymentService`가
  필요하다.
- `PaymentService`를 만들려면 완성된 `OrderService`가 필요하다.
- 닭이 먼저냐 달걀이 먼저냐 — 어느 쪽도 먼저 완성될 수 없는
  교착이라 컨테이너가 감지 즉시 예외를 던진다.

### 필드/세터 주입에서는 왜 (과거에) 넘어갔나

필드 주입은 순서가 다르다. **일단 기본 생성자로 껍데기 인스턴스를
만들고, 그 다음에 필드를 채운다.** "인스턴스 생성"과 "의존성 주입"이
두 단계로 분리되어 있어서, 미완성 상태의 A를 B에게 먼저 건네주는
꼼수가 가능하다:

1. A 인스턴스 생성 (필드는 아직 비어 있음) → A의 조기 참조를
   컨테이너에 노출
2. A의 필드를 채우려고 B 생성 시작
3. B가 A를 요구 → 컨테이너가 1번에서 노출해 둔 **미완성 A의 참조**를
   건네줌 → B 완성
4. 완성된 B를 A의 필드에 주입 → A도 완성

Spring 내부적으로는 싱글턴 빈을 3단계 캐시(완성 빈 / 조기 노출 빈 /
빈 팩토리)로 관리하면서 이 "미완성 참조 미리 꺼내주기"를 구현한다
(가산점 포인트 — 상세는 꼬리질문 참고).

**그러나 이건 해결이 아니라 은폐다.** Spring Boot 2.6부터는 필드·세터
주입이어도 순환 참조를 기본적으로 금지한다
(`spring.main.allow-circular-references`가 기본 false). 프레임워크
스스로 "이 꼼수는 켜지 말라"고 기본값을 바꾼 것 — 순환 참조가
설계 문제라는 공식 입장인 셈이다.

## 2. 해결 1순위 — 설계를 고친다 (순환은 증상이다)

서로를 부르는 두 빈은 대부분 **하나의 관심사가 두 클래스에 찢어져
있다**는 신호다. 해결법은 세 가지 방향이 있고, 전부 "의존을
단방향으로 만든다"로 수렴한다.

### 2-1. 공통 책임을 제3의 컴포넌트로 추출

A와 B가 서로에게 원하는 기능을 들여다보면, 양쪽이 공유하는 하위
책임인 경우가 많다. 그 부분을 C로 뽑아내면 A → C ← B 의 단방향
구조가 된다.

```java
// ❌ before: 주문이 결제를 부르고, 결제가 주문 상태 변경을 위해 주문을 부른다
@Service
public class OrderService {
    private final PaymentService paymentService;
    public void order(...) { paymentService.pay(...); }
    public void markPaid(Long orderId) { ... }   // PaymentService가 이걸 호출
}

@Service
public class PaymentService {
    private final OrderService orderService;      // 역방향 의존 — 순환!
    public void pay(...) {
        ...
        orderService.markPaid(orderId);
    }
}
```

```java
// ✅ after: "주문 상태 변경"이라는 공통 관심사를 별도 컴포넌트로 추출
@Service
public class OrderService {
    private final PaymentService paymentService;
    public void order(...) { paymentService.pay(...); }
}

@Service
public class PaymentService {
    private final OrderStatusChanger orderStatusChanger;  // 제3의 빈
    public void pay(...) {
        ...
        orderStatusChanger.markPaid(orderId);
    }
}

@Component
public class OrderStatusChanger {   // 양쪽 어디에도 의존하지 않는다
    private final OrderRepository orderRepository;
    public void markPaid(Long orderId) { ... }
}
```

의존 그래프가 `OrderService → PaymentService → OrderStatusChanger`
한 방향으로 흐른다. 순환이 사라졌을 뿐 아니라, "주문 상태 변경"이라는
책임의 주인이 명확해졌다.

### 2-2. 이벤트로 역방향 의존 제거

"B가 끝나면 A가 뭔가 해야 한다"는 요구 때문에 B → A 역방향 의존이
생겼다면, B는 이벤트를 발행만 하고 A(또는 별도 리스너)가 구독하게
바꾼다. B는 더 이상 A의 존재를 모른다.

```java
// ✅ 결제 완료를 이벤트로 알린다 — PaymentService는 OrderService를 모른다
@Service
public class PaymentService {
    private final ApplicationEventPublisher eventPublisher;
    public void pay(...) {
        ...
        eventPublisher.publishEvent(new PaymentCompletedEvent(orderId));
    }
}

@Component
public class PaymentCompletedListener {
    private final OrderRepository orderRepository;
    @EventListener
    public void on(PaymentCompletedEvent event) { /* 주문 상태 변경 */ }
}
```

### 2-3. 책임 재배치·병합

추출·이벤트 어느 쪽도 어색하다면, 애초에 두 클래스의 경계가 잘못
그어진 것일 수 있다. 메서드를 옮겨 의존 방향을 한쪽으로 정리하거나,
지나치게 잘게 쪼개진 두 클래스라면 하나로 합치는 것도 답이다.
"쪼개져 있다 = 좋은 설계"가 아니다 — 서로를 계속 부르는 두 클래스는
사실상 한 덩어리다.

## 3. 차선책 — 우회 수단들과 각각의 대가

설계 수정이 당장 어렵다면(대규모 레거시, 릴리즈 직전 등) 우회
수단이 있다. 단, 전부 **"순환은 그대로 두고 초기화 시점만 미룬다"**는
공통점과 대가가 있다.

### @Lazy — 프록시를 대신 주입해 시점을 미룬다

```java
@Service
public class PaymentService {
    private final OrderService orderService;

    public PaymentService(@Lazy OrderService orderService) {
        // 진짜 OrderService가 아니라 프록시가 주입된다.
        // 실제 빈 조회는 orderService의 메서드를 처음 호출하는 순간 일어난다.
        this.orderService = orderService;
    }
}
```

생성 시점에 진짜 빈이 필요 없어지므로 교착이 풀린다. 대가:
**시작 시점 검증을 잃는다.** 생성자 주입 순환의 최대 장점은 "잘못된
구조를 부팅에서 즉시 알려주는 것"인데, @Lazy는 그 경보를 런타임으로
미룬다 — 실제 호출 시점에 문제가 있으면 그때 터진다. 또한 코드만
봐서는 순환이 있다는 사실이 안 보이게 되어, 다음 사람이 순환을
더 키우기 쉽다.

### ObjectProvider — 조회 시점을 코드로 명시

```java
@Service
@RequiredArgsConstructor
public class PaymentService {
    private final ObjectProvider<OrderService> orderServiceProvider;

    public void pay(...) {
        // 사용하는 순간에 컨테이너에서 꺼낸다
        orderServiceProvider.getObject().markPaid(orderId);
    }
}
```

@Lazy와 원리는 같지만(지연 조회), "이 의존은 지연 조회다"가 코드에
명시적으로 드러난다는 점에서 낫다. 그래도 순환 자체는 남아 있다.

### 하지 말아야 할 것 — 필드/세터 주입으로 전환

`allow-circular-references=true` + 필드 주입으로 바꾸면 에러는
사라진다. 하지만 이것은 **경보기를 끄는 것**이다: 순환 구조는
그대로인 채 생성자 주입의 다른 장점(불변성, 필수 의존성 보장,
테스트 용이성)까지 함께 버린다. 면접에서 이걸 첫 번째 해결책으로
말하면 설계 감각을 의심받는다.

우선순위를 한 줄로: **설계 수정(추출/이벤트/재배치) > ObjectProvider ≈
@Lazy(임시, 부채 기록) > 필드 주입 전환(사실상 금지)**.

## 4. 꼬리질문 대비 포인트

### "필드 주입으로 바꾸면 에러가 사라지는데, 그럼 해결된 것 아닌가?"

에러가 사라진 것이지 문제가 사라진 게 아니다. 순환이라는 구조적
결함은 그대로고, 컨테이너가 미완성 빈의 조기 참조로 억지로 조립해
줬을 뿐이다. Spring Boot 2.6부터 이 방식조차 기본 금지로 바뀐 것이
프레임워크의 판단을 보여준다. 게다가 생성자 주입이 주던 불변성·필수
의존성 보장·부팅 시점 검증까지 잃는다. "생성자 주입에서 순환이
컴파일 타임에 가깝게 터져주는 건 단점이 아니라 조기 발견이라는
장점"이라고 답하는 것이 포인트.

### "@Lazy는 내부적으로 어떻게 순환을 끊나?"

진짜 빈 대신 **프록시**를 주입한다. 생성자 인자로는 프록시만 넘기면
되므로 상대 빈이 완성돼 있을 필요가 없고, 프록시의 메서드가 처음
호출되는 순간 컨테이너에서 실제 빈을 조회해 위임한다. 즉 "주입
시점의 의존"을 "사용 시점의 의존"으로 바꿔서 생성 교착을 푸는 것.
대가는 시작 시점 검증 상실 — 문제가 런타임 첫 호출로 미뤄진다.

### "필드 주입 순환을 Spring이 내부적으로 어떻게 조립해줬는지 아는가?" (가산점 포인트)

싱글턴 3단계 캐시로 답한다. 1차 캐시(singletonObjects)는 완성된 빈,
2차 캐시(earlySingletonObjects)는 조기 노출된 미완성 빈, 3차
캐시(singletonFactories)는 조기 참조를 만들어낼 팩토리를 보관한다.
A 생성 중에 B가 A를 요구하면 3차 캐시의 팩토리로 A의 조기 참조를
꺼내 B에 주입한다 — 이때 A가 AOP 대상이면 팩토리가 프록시를 미리
만들어 넘기는 것까지 처리한다. 생성자 주입은 "인스턴스 생성" 단계
자체가 서로를 요구하므로 이 메커니즘으로도 풀 수 없다 — 조기 참조는
인스턴스가 일단 만들어진 뒤에나 존재할 수 있기 때문이다.

### "순환 참조 에러를 만나면 설계에서 무엇부터 의심하나?" (시니어 변별 포인트)

두 빈이 서로에게 원하는 게 뭔지부터 본다. 대부분 세 패턴 중
하나다: ① 양쪽이 공유하는 하위 책임이 있는데 각자 안에 박혀 있다 →
제3의 컴포넌트로 추출. ② "B의 작업이 끝나면 A가 반응해야 한다"는
알림성 요구가 직접 호출로 구현돼 있다 → 이벤트로 역전. ③ 클래스
경계 자체가 잘못 그어져 메서드가 엉뚱한 집에 산다 → 책임 재배치
또는 병합. 어느 경우든 목표는 의존 그래프를 단방향으로 만드는 것이고,
@Lazy는 이 진단을 끝낸 뒤에도 당장 못 고칠 때 부채로 기록하고 쓰는
임시 조치라고 답한다. 우회를 먼저 말하고 설계를 나중에 말하면
순서가 뒤집힌 것.

### "@Lazy로 풀어둔 순환, 운영에서 어떤 식으로 문제가 되나?"

첫째, 부팅은 성공하지만 실제 호출 경로에서 처음 프록시가 풀리는
순간 문제가 드러난다 — 장애가 배포 시점이 아니라 트래픽이 특정
경로를 밟는 시점에 터져 원인 추적이 어려워진다. 둘째, 코드 리뷰에서
순환의 존재가 안 보이므로 그 위에 의존이 계속 쌓여 사이클이
자라난다. 셋째, 초기화 순서에 암묵적으로 의존하는 로직(@PostConstruct
등)이 섞이면 "어쩌다 되는" 코드가 된다. 그래서 @Lazy를 쓸 때는
왜 순환이 있고 언제 걷어낼지를 주석/이슈로 남기는 것까지가 조치다.

---

## 한 줄 요약

순환 참조는 컨테이너의 버그가 아니라 "하나의 책임이 두 클래스에
찢어져 있다"는 설계 경보다 — 생성자 주입이 부팅 시점에 즉시
실패시켜 주는 건 장점이고, 해결은 공통 책임 추출·이벤트 역전·책임
재배치로 의존을 단방향으로 만드는 것이 1순위이며, @Lazy와
ObjectProvider는 그 진단 후에도 당장 못 고칠 때 부채로 기록하고
쓰는 차선책이다.
