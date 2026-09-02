# 생성자 주입을 권장하는 이유 — 필드 주입 대비, 컨벤션이 아니라 근거로

> 핵심 관전 포인트: **생성자 주입은 "의존성이 다 갖춰지지 않으면 객체 자체를 만들 수 없다"는 불변식을 자바 컴파일러가 강제하게 만드는 유일한 방식이다. 필드 주입은 스프링이 생성자가 끝난 뒤 리플렉션으로 `private` 필드에 값을 꽂아 넣는 방식이라 그 불변식이 없다 — 그래서 `final`을 붙일 수 없고, 컨테이너 밖에서는 필드가 전부 `null`인 반제품 객체가 만들어지며, 순환 참조가 껍데기끼리 이어붙어 조용히 성립하고, 의존성이 몇 개로 불어나든 겉으로 드러나지 않는다. 즉 권장 근거 네 가지(불변성, 순환 참조 조기 발견, 컨테이너 없는 단위 테스트, 책임 비대화의 가시화)는 서로 다른 장점 넷이 아니라 "객체가 불완전한 상태로 존재할 수 있는가"라는 한 가지 질문에서 전부 파생된 결과다.**

---

## 0. 질문 + 의도

**질문**: "생성자 주입을 권장하는 이유는 무엇인가요? (필드 주입 대비)"

**출제 의도**: 순환 참조의 조기 발견, 불변성, 테스트 시 목 주입 용이성까지 연결해 말하는지 본다. 컨벤션을 "팀 규칙이라서"가 아니라 근거로 이해하는 사람은 새로운 상황에서도 올바른 선택을 한다.

*(이 문서의 버전 의존 서술은 Spring Boot 3.x / Spring Framework 6.x, Java 21 기준이다.)*

## 1. 주입 방식 세 가지 — 값이 언제 어떻게 들어가는가

세 방식의 차이는 문법이 아니라 **"객체가 만들어지는 시점 대비 값이 언제 들어가는가"** 에 있다. 이 시점 차이 하나에서 뒤의 모든 결론이 나온다.

### 1-1. 먼저 리플렉션이 무엇인지 정의하고 간다

필드 주입 설명에 반드시 나오는 단어인데 정의 없이 넘어가는 경우가 많다.

**리플렉션(reflection)은 실행 중에 클래스의 내부 정보(필드 목록, 메서드 목록, 애너테이션)를 뒤져 보고, 심지어 `private` 필드에도 값을 강제로 집어넣을 수 있게 해주는 자바 기능이다.** 이름은 프로그램이 실행 도중 **자기 자신을 거울에 비춰 들여다본다**는 뜻에서 왔다.

스프링이 필드 주입을 처리할 때 실제로 하는 일이 이것이다.

```java
// 스프링(AutowiredAnnotationBeanPostProcessor)이 하는 일을 풀어 쓰면 대략 이렇다
Field field = OrderService.class.getDeclaredField("gateway");
field.setAccessible(true);          // private 접근 제한을 강제로 연다
field.set(orderServiceInstance, gateway);   // 값을 직접 꽂아 넣는다
```

`setAccessible(true)` 한 줄이 핵심이다. **자바 문법상 접근할 수 없는 곳에 값을 넣기 위해 언어의 접근 제어를 우회한다.** 편리하지만, 이 우회가 없으면 그 객체를 완성할 방법이 없다는 뜻이기도 하다. 즉 **필드 주입으로 짜인 클래스는 리플렉션 없이는 완성될 수 없는 클래스**다. 이 사실이 3-4절(테스트)에서 그대로 비용이 된다.

### 1-2. 시점 도식 — 값이 들어가는 자리가 생성자 안인가 밖인가

```text
[생성자 주입]
  t1  컨테이너가 PaymentGateway 빈을 먼저 준비한다
  t2  new OrderService(gateway)  ── 생성자 진입
  t3    this.gateway = gateway   ── 생성자 "안"에서 값이 정해진다
  t4  생성자 종료                 ── 이 순간 객체는 이미 완전하다
      ★ t4 이후로 "의존성이 비어 있는 OrderService" 라는 상태는 존재할 수 없다.

[필드 주입]
  t1  new OrderService()         ── 인자 없는 생성자 진입
  t2  생성자 종료                 ── gateway 는 아직 null
  t3  ← 여기, 반제품 객체가 실재하는 구간 →
  t4  field.setAccessible(true); field.set(bean, gateway)
                                 ── 생성자 "밖"에서, 리플렉션으로 나중에 꽂는다
      ★ t2~t4 사이에 "의존성이 비어 있는 OrderService" 가 실제로 존재한다.

[세터 주입]
  t1  new OrderService()
  t2  생성자 종료                 ── gateway 는 아직 null
  t3  bean.setGateway(gateway)   ── 공개 메서드로 나중에 넣는다
      ★ 반제품 구간이 있는 것은 같고, 다만 그 통로가 공개 API 라는 점만 다르다.
```

| 방식 | 값이 들어가는 자리 | 주입 시점 | 자바 문법만으로 완성 가능한가 |
|---|---|---|---|
| 생성자 주입 | 생성자 파라미터 | 인스턴스 생성과 동시에 | 가능 (`new`) |
| 세터 주입 | `setXxx()` 메서드 | 생성 후, 공개 메서드로 | 가능 (`new` + `set`) |
| 필드 주입 | 필드에 직접 | 생성 후, 리플렉션으로 | **불가능** |

### 1-3. 코드로 보는 대비

```java
// before: 필드 주입 — 세 줄로 짧아 보이지만 계약을 숨긴다
@Service
public class OrderService {
    @Autowired
    private PaymentGateway gateway;
    // 이 클래스의 생성자 시그니처는 OrderService() 다.
    // 즉 겉보기 계약은 "아무것도 없어도 만들 수 있다" 인데, 실제로는 거짓이다.
}

// after: 생성자 주입 — 의존성이 클래스의 공개 계약(생성자 시그니처)에 드러난다
@Service
public class OrderService {
    private final PaymentGateway gateway;

    // "나를 만들려면 PaymentGateway 가 반드시 있어야 한다" 를 시그니처로 선언한다.
    // 이 선언은 문서가 아니라 컴파일러가 검사하는 규칙이다.
    public OrderService(PaymentGateway gateway) {
        this.gateway = gateway;
    }
}
```

**핵심 차이는 의존성이 어디에 드러나는가다.** 생성자 주입은 "이 객체를 만들려면 이것들이 반드시 필요하다"를 생성자 시그니처라는 공개 계약으로 선언한다. 필드 주입은 그 계약을 클래스 내부에 감추고, 스프링이 리플렉션으로 몰래 채워주기를 기대한다.

## 2. 권장 근거 네 가지 — 그것이 없으면 실제로 무슨 사고가 나는가

### 2-1. `final` 불변 — 왜 필드 주입은 `final`을 못 붙이는가

먼저 사실 확인부터. 필드 주입에 `final`을 붙이면 **스프링이 실패하는 게 아니라 컴파일 자체가 안 된다.**

```java
@Service
public class OrderService {
    @Autowired
    private final PaymentGateway gateway;   // 컴파일 에러
}
```

javac 21로 실제 확인한 메시지는 이것이다.

```text
error: variable gateway not initialized in the default constructor
    private final PaymentGateway gateway;
                                 ^

(생성자를 명시적으로 쓰고 거기서 대입하지 않은 경우에는 메시지가 이렇게 나온다)
error: variable gateway might not have been initialized
    public OrderService() { }
                          ^
```

이유는 스프링과 무관한 **자바 언어 규칙**이다. **`final` 필드는 생성자가 끝나는 순간까지 값이 정해져 있어야 한다.** 컴파일러는 모든 생성자를 훑어 "이 경로로 나가면 `final` 필드가 아직 비어 있다"는 경우가 하나라도 있으면 컴파일을 거부한다.

1-2절의 시점 도식을 여기에 겹쳐 보면 왜 필드 주입과 `final`이 양립할 수 없는지가 정확히 보인다.

```text
              생성자 종료 시점
                    │
  [생성자 주입]      │  값이 이미 들어와 있다 -> final 규칙 만족 -> 컴파일 통과
     this.gateway = gateway 는 이 선 "왼쪽" 에서 실행된다
                    │
  [필드 주입]        │  값이 아직 없다 -> final 규칙 위반 -> 컴파일 거부
     field.set(...) 은 이 선 "오른쪽" 에서 실행된다
                    │
```

**필드 주입이 값을 꽂는 시점이 생성자가 끝난 뒤이기 때문에, 컴파일러가 요구하는 마감 시한을 원천적으로 지킬 수 없다.** `final`을 못 쓰는 것은 스프링의 제약이 아니라 순서의 필연이다.

그럼 `final`이 없으면 무슨 사고가 나는가. 두 가지다.

**(1) 나중에 누가 바꿔 끼울 수 있다.** `final`이 아닌 필드는 클래스 안 어디서든 재대입할 수 있고, 밖에서도 리플렉션으로 바꿀 수 있다. 실제로 이런 코드가 만들어진다.

```java
// 문제: "테스트에서만 잠깐 바꾸려고" 열어둔 통로가 프로덕션 코드에 남는다
@Service
public class OrderService {
    @Autowired
    private PaymentGateway gateway;

    // 처음에는 테스트 편의로 추가됐지만, 일단 열리면 프로덕션 코드에서도 불린다.
    // 그러면 "지금 이 싱글턴 빈의 gateway 가 무엇인지"를 시점마다 따져야 한다.
    public void setGateway(PaymentGateway gateway) { this.gateway = gateway; }
}
```

여기서 02번 문서의 싱글턴 이야기와 만난다. **서비스 빈은 싱글턴이라 모든 요청 스레드가 그 인스턴스 하나를 공유한다.** 어떤 요청 처리 중에 이 필드가 바뀌면 그 순간 다른 스레드들의 동작이 함께 바뀐다. `final`은 "이 필드는 만들어진 뒤 절대 안 바뀐다"를 컴파일러가 보증하게 만들어, **싱글턴 빈이 공유해도 안전한 유일한 형태**를 강제한다.

**(2) 안전한 발행(safe publication) 보장을 잃는다.** 자바 메모리 모델은 `final` 필드에 대해 특별한 보장을 준다 — **생성자 안에서 `final` 필드에 쓴 값은, 생성자가 끝난 뒤 그 객체 참조를 받은 다른 스레드에게 반드시 올바르게 보인다.** 별도 동기화가 없어도 그렇다. `final`이 아닌 필드에는 이 보장이 없어서, 이론적으로는 다른 스레드가 초기화 이전의 `null`을 볼 수도 있다. 실제 스프링 애플리케이션에서는 컨테이너 기동이 끝난 뒤에 요청이 들어오므로 이 문제가 드러나는 일은 드물지만, **`final`이 왜 동시성 관점에서도 이득인지**를 말할 수 있으면 깊이가 드러난다. (가산점 포인트)

### 2-2. 컨테이너 밖에서 반제품 객체가 만들어진다

여기에 흔한 오해가 하나 있어 짚고 간다. **"필드 주입은 주입이 빠져도 조용히 넘어가서 나중에 NPE가 난다"는 설명은 정확하지 않다.**

`@Autowired`는 기본값이 `required = true`이므로, **주입할 빈을 못 찾으면 필드 주입이든 생성자 주입이든 똑같이 기동이 실패한다.** 둘 다 `UnsatisfiedDependencyException`으로 애플리케이션이 안 뜬다. 이 점에서는 차이가 없다.

진짜 차이는 **컨테이너 밖**에서 드러난다.

```java
// 필드 주입된 클래스: 컴파일러가 이것을 막지 못한다
OrderService service = new OrderService();
// 컴파일 통과. 객체도 만들어진다. 그런데 gateway 는 null 이다.
service.placeOrder(order);   // 첫 호출에서 NullPointerException

// 생성자 주입된 클래스: 애초에 이 코드가 컴파일되지 않는다
OrderService service = new OrderService();
// error: constructor OrderService in class OrderService cannot be applied to given types;
//   required: PaymentGateway
//   found:    no arguments
// -> 불완전한 객체를 만들려는 시도 자체가 컴파일 단계에서 차단된다
```

이 차이가 실무에서 나타나는 자리가 셋이다.

- **테스트 코드**: `new OrderService()`로 만들어 놓고 필드를 채우는 것을 잊으면, 테스트가 NPE로 실패하며 진짜 원인이 가려진다.
- **`@Configuration`에서 수동 등록**: `new`로 빈을 만들어 등록하는 코드에서 세팅을 빠뜨리면 그대로 반제품이 빈으로 올라간다.
- **`@Autowired(required = false)` 나 선택적 의존성**: 이때는 빈이 없어도 기동이 되므로, 정말로 `null`인 필드를 들고 운영에 나간다.

정리하면 이렇다. **생성자 주입의 진짜 값은 "기동 시점에 실패한다"가 아니라 "불완전한 객체가 존재할 수 있는 경로를 컴파일러가 전부 막는다"는 것이다.** 실패 시점을 앞당기는 정도가 아니라, **잘못된 상태 자체를 표현 불가능하게 만든다.**

### 2-3. 순환 참조 — 왜 생성자 주입에서만 조기에 드러나는가

A가 B를 필요로 하고 B가 A를 필요로 하는 구조를 순환 참조라고 한다. 두 방식에서 컨테이너가 무엇을 할 수 있는지가 갈린다.

```text
[생성자 주입 — 어느 쪽도 먼저 완성될 수 없다]

  컨테이너: A 를 만들자
              -> A 의 생성자가 B 를 요구한다. B 없이는 new A(...) 를 호출할 수 없다.
            그럼 B 를 먼저 만들자
              -> B 의 생성자가 A 를 요구한다. 완성된 A 가 있어야 한다.
            A 는? "지금 만드는 중" 이고 아직 완성본이 없다.
              -> BeanCurrentlyInCreationException  (기동 실패)

  ★ 닭이 먼저냐 달걀이 먼저냐가 코드로 성립해버린 상태다.
    이것은 스프링이 게을러서가 아니라 논리적으로 불가능한 것이다.

[필드 주입 — 껍데기를 먼저 만들 수 있어서 순환이 성립한다]

  컨테이너: new A()            -> A 껍데기 완성 (필드는 전부 null)
            new B()            -> B 껍데기 완성 (필드는 전부 null)
            field.set(B, "a", A 껍데기)   -> B 의 a 필드에 A 참조를 꽂는다
            field.set(A, "b", B)          -> A 의 b 필드에 B 참조를 꽂는다
              -> 서로를 가리키는 두 객체가 완성됐다. 기동은 성공한다.

  ★ 껍데기를 먼저 만들 수 있다는 것이 순환을 가능하게 만든 유일한 이유다.
```

스프링이 필드 주입에서 이것을 해내는 장치가 **3단계 캐시**다. 만들다 만 객체의 참조를 미리 꺼내 쓸 수 있게 임시 보관소에 넣어두고, 순환의 반대편이 그 미완성 참조를 가져다 쓰게 한다. 생성자 주입에서는 이 수법이 통하지 않는다 — **미완성 참조라도 꺼내려면 객체가 일단 만들어져 있어야 하는데, 생성자 주입은 의존성이 없으면 객체를 만드는 것부터가 불가능**하기 때문이다. (가산점 포인트)

여기서 중요한 판단이 하나 붙는다. **기동이 되는 쪽이 좋은 게 아니다.** 순환 참조는 대부분 책임 분배가 잘못됐다는 증상이므로, 조용히 굴러가는 것보다 기동 실패로 드러나는 편이 낫다. 숨은 채로 굴러가면 나중에 호출 순서에 따라 `null`을 보거나, 리팩터링 중에 정체 모를 초기화 순서 버그로 되돌아온다.

버전 사실도 함께 알아둘 것. **Spring Boot 2.6부터는 순환 참조가 기본적으로 금지**되어, 필드 주입이라도 기동이 실패하고 `spring.main.allow-circular-references=true`를 명시해야 예전처럼 동작한다. Boot 3.x도 이 기본값을 유지한다. **프레임워크 스스로 "순환은 허용할 상태가 아니라 오류다"라는 생성자 주입의 관점을 채택한 것**이다.

### 2-4. 테스트 — mock을 넣을 "자리"가 있는가

실무에서 체감이 가장 큰 차이다. 1-1절에서 본 "리플렉션 없이는 완성될 수 없는 클래스"라는 성질이 여기서 비용으로 돌아온다.

```java
// before: 필드 주입된 클래스의 단위 테스트 — 정상적인 자바 문법으로는 방법이 없다
OrderService service = new OrderService();
// gateway 는 private 이고 setter 도 없다. 넣을 통로가 언어 차원에 없다.
// 남는 선택지는 둘뿐이다.

// 선택지 ①: 테스트도 리플렉션을 쓴다
OrderService service = new OrderService();
ReflectionTestUtils.setField(service, "gateway", mock(PaymentGateway.class));
// 필드명을 문자열 "gateway" 로 지정한다는 점이 문제다.
// 나중에 필드명을 paymentGateway 로 바꾸면 컴파일은 멀쩡히 통과하고,
// 테스트는 런타임에 IllegalArgumentException 으로 깨진다.
// IDE 의 리네임 리팩터링도 이 문자열은 따라오지 못한다.

// 선택지 ②: 스프링 컨테이너를 띄운다
@SpringBootTest
class OrderServiceTest {
    @Autowired OrderService service;
    @MockitoBean PaymentGateway gateway;
    // 메서드 하나 검증하려고 애플리케이션 전체를 기동한다.
    // 수 초 걸리는 기동이 테스트 스위트마다 반복되며 피드백 루프가 무너진다.
}

// after: 생성자 주입 — 컨테이너도 리플렉션도 없이 끝난다
PaymentGateway fake = mock(PaymentGateway.class);
when(fake.pay(any())).thenReturn(PaymentResult.success());

OrderService service = new OrderService(fake);   // 그냥 new
service.placeOrder(order);                        // 밀리초 단위로 끝나는 단위 테스트
```

정리하면 **생성자 주입은 테스트 코드가 프로덕션 코드와 똑같은 공개 계약(생성자)만 사용하게 만든다.** 테스트가 클래스 내부 구현(필드명)이나 프레임워크(컨테이너 기동)에 기대지 않으므로, 리팩터링에 깨지지 않고 빠르다.

한 줄로 압축하면 **"컨테이너 없이 인스턴스화할 수 있는가"가 테스트 가능성의 분기점**이다.

### 2-5. 설계 신호 — 나쁜 냄새를 숨기지 못하게 한다

의존성이 8개인 클래스를 두 방식으로 써 보면 차이가 눈에 보인다.

```java
// 필드 주입: 8줄이 조용히 늘어난다. 아무도 불편하지 않다.
@Service
public class OrderService {
    @Autowired private PaymentGateway gateway;
    @Autowired private OrderRepository orderRepository;
    @Autowired private CouponService couponService;
    @Autowired private PointService pointService;
    @Autowired private StockService stockService;
    @Autowired private NotificationService notificationService;
    @Autowired private AuditLogger auditLogger;
    @Autowired private ShippingClient shippingClient;
}

// 생성자 주입: 파라미터 8개짜리 생성자가 된다. 보는 순간 불편하다.
public OrderService(PaymentGateway gateway, OrderRepository orderRepository,
                    CouponService couponService, PointService pointService,
                    StockService stockService, NotificationService notificationService,
                    AuditLogger auditLogger, ShippingClient shippingClient) { ... }
```

이 **눈에 보이는 고통**이 "이 클래스가 책임을 너무 많이 진 것 아닌가(SRP 위반)"를 묻게 만들고, 리팩터링을 촉발하는 압력으로 작동한다. 필드 주입은 그 신호를 무음 처리한다 — `@Autowired` 한 줄을 더 붙이는 데는 아무 저항이 없기 때문이다.

즉 생성자 주입의 "불편함"은 결함이 아니라 **의도된 기능**이다. 설계가 나빠지고 있다는 사실을 코드가 스스로 드러내게 만드는 장치다.

## 3. 실무 작성법 — 보일러플레이트는 도구로 지우되, 함정은 알고 지운다

### 3-1. `@Autowired`는 생략할 수 있다

**Spring 4.3부터는 클래스에 생성자가 하나뿐이면 그 생성자에 `@Autowired`를 붙이지 않아도 스프링이 주입 대상으로 인식한다.**

```java
@Service
public class OrderService {
    private final PaymentGateway gateway;

    // @Autowired 없음. 생성자가 하나뿐이므로 스프링이 알아서 이 생성자를 쓴다.
    public OrderService(PaymentGateway gateway) {
        this.gateway = gateway;
    }
}
```

생성자가 둘 이상이면 어느 것을 쓸지 알 수 없으므로, 그때는 사용할 생성자에 `@Autowired`를 명시해야 한다.

부수 효과가 하나 있다. 이 규칙 덕분에 **프로덕션 코드에서 스프링 애너테이션이 하나 줄어든다.** 클래스가 프레임워크에 덜 묶일수록 순수 자바로 테스트하기도, 나중에 다른 곳에서 재사용하기도 쉬워진다.

### 3-2. Lombok으로 생성자를 지운다

"생성자 코드가 길어진다"는 반론은 도구로 해소된다.

```java
// @RequiredArgsConstructor 는 final 필드(그리고 @NonNull 필드)를 파라미터로 받는
// 생성자를 컴파일 시점에 만들어준다. 생성자가 하나뿐이므로 @Autowired 도 불필요하다.
@Service
@RequiredArgsConstructor
public class OrderService {
    private final PaymentGateway gateway;
    private final OrderRepository orderRepository;
}
```

```java
// Kotlin — 주 생성자 문법이라 애초에 보일러플레이트가 없다
@Service
class OrderService(
    private val gateway: PaymentGateway,
    private val orderRepository: OrderRepository,
)
```

결과적으로 필드 주입보다 코드가 길지 않다. **"짧아서 필드 주입을 쓴다"는 이유는 이 시점에 성립하지 않는다.**

### 3-3. `@RequiredArgsConstructor`의 함정 — `@Qualifier`가 사라진다

Lombok을 쓸 때 반드시 알아야 하는 함정이 하나 있다. **Lombok이 생성한 생성자의 파라미터에는 필드에 붙은 `@Qualifier`가 기본적으로 복사되지 않는다.**

먼저 `@Qualifier`가 무엇인지 짚고 가자. **같은 타입의 빈이 둘 이상일 때 "이 중 어느 것을 주입할지"를 이름으로 지정하는 애너테이션**이다. 타입만으로는 후보가 좁혀지지 않으니 이름표를 하나 더 다는 것이다.

```java
// 문제: 필드에만 @Qualifier 가 남고, 생성자 파라미터에는 안 붙는다
@Service
@RequiredArgsConstructor
public class OrderService {

    @Qualifier("tossGateway")
    private final PaymentGateway gateway;
    // Lombok 이 만들어내는 것은 OrderService(PaymentGateway gateway) 뿐이다.
    // @Qualifier 는 필드에만 남아 있고 파라미터에는 전달되지 않는다.
    //
    // 스프링은 생성자 파라미터 타입으로만 후보를 찾으므로,
    // PaymentGateway 구현 빈이 tossGateway / kakaoGateway 둘이라면
    //   NoUniqueBeanDefinitionException: expected single matching bean but found 2
    // 로 기동이 실패한다. 구현이 하나뿐일 때는 멀쩡히 돌다가,
    // 나중에 두 번째 구현을 추가하는 순간 터진다는 점이 특히 고약하다.
}
```

고치는 방법은 둘이다.

```text
고침 ①: 프로젝트 루트의 lombok.config 에 복사 대상 애너테이션을 등록한다

  # lombok.config
  lombok.copyableAnnotations += org.springframework.beans.factory.annotation.Qualifier
  lombok.copyableAnnotations += org.springframework.beans.factory.annotation.Value

  -> 이렇게 두면 Lombok 이 필드의 해당 애너테이션을 생성자 파라미터로 복사해준다.
     @Value 로 프로퍼티 값을 주입받는 필드도 같은 문제를 겪으므로 함께 등록한다.
```

```java
// 고침 ②: 이 클래스만 Lombok 을 포기하고 생성자를 직접 쓴다
@Service
public class OrderService {

    private final PaymentGateway gateway;

    public OrderService(@Qualifier("tossGateway") PaymentGateway gateway) {
        this.gateway = gateway;   // 파라미터에 직접 붙였으므로 의도가 그대로 전달된다
    }
}
```

**팀 규칙으로는 ①(lombok.config 설정)을 한 번 깔아두는 편이 안전하다.** ②는 개별 클래스에서 기억해야 하는 규칙이라, 사람이 잊는 순간 같은 사고가 반복된다. (가산점 포인트)

## 4. 꼬리질문 대비 포인트

### "그럼 setter 주입은 언제 쓰나요?"

원칙은 **"필수 의존성은 생성자, 선택적 의존성은 setter"** 다. **없어도 객체가 성립하는 의존성**이나 런타임에 교체될 수 있는 의존성에 쓴다.

다만 실무에서 이 자리는 거의 비어 있다는 점을 함께 말하는 게 좋다. 선택적 의존성 자체가 드물고, 그마저도 대안이 있기 때문이다.

- 있으면 쓰고 없으면 넘어가는 의존성은 `ObjectProvider<T>`를 생성자로 받아 `getIfAvailable()`로 처리하면 된다. 그러면 "없을 수도 있다"는 사실이 타입에 드러난다.
- 기본 구현이 있는 경우라면 기본값을 넣은 생성자를 두는 편이 낫다.

setter 주입이 실제로 필요한 경우는 프레임워크가 객체를 만든 뒤에 값을 넣어줘야 하는 레거시 연동 정도다.

### "필드 주입을 써도 되는 자리는 정말 하나도 없나요?"

**테스트 클래스 안은 예외로 볼 수 있다.** JUnit 5와 스프링 테스트 컨텍스트가 테스트 인스턴스를 직접 만들어주므로, 테스트 클래스에서 `@Autowired` 필드를 쓰는 것은 관행이고 문제가 되지 않는다. 테스트 클래스는 `new`로 만들어 재사용할 대상이 아니고, 순환 참조나 불변성 이슈도 없기 때문이다.

프로덕션 코드에서는 예외를 두지 않는 편이 낫다. "이 클래스만은 괜찮다"는 판단이 쌓이면 결국 컨벤션이 무너진다.

한 가지 더 덧붙이면, 필드 주입을 없애야 할 이유가 **"@SpringBootTest 없이 테스트를 짤 수 있게 하기 위함"** 이라는 점은 꼭 말하는 게 좋다. 필드 주입이 퍼진 코드베이스는 필연적으로 통합 테스트 위주가 되고, 그러면 전체 테스트 시간이 늘어 아무도 로컬에서 테스트를 돌리지 않게 된다. **주입 방식 하나가 팀의 테스트 문화까지 끌고 간다.**

### "생성자 주입인데 순환 참조가 발생하면 어떻게 해결하나요?" (시니어 변별 포인트)

`@Lazy`를 한쪽에 붙이면 그 자리에 프록시가 주입되어 기동은 통과한다. 하지만 이것은 **증상을 덮는 임시방편**이다. 순환은 대부분 책임 분배가 잘못됐다는 신호이므로, 설계를 고치는 답이 먼저 나와야 한다.

**1. 공통 로직을 제3의 빈으로 추출한다.** A와 B가 서로 부르는 부분을 C로 빼면 `A → C ← B`의 단방향이 된다. 순환의 원인이 "두 클래스가 같은 일을 서로에게 부탁하고 있었다"인 경우가 가장 많고, 이 방법이 대개 정답이다.

**2. 이벤트로 방향을 끊는다.** B가 A를 직접 호출하는 대신 `ApplicationEventPublisher`로 이벤트를 발행하고 A가 그것을 구독하게 하면, B는 A를 알 필요가 없어져 컴파일 의존이 한쪽으로만 남는다. "주문이 완료되면 알림을 보낸다" 같은 부수 효과 성격의 호출에 특히 잘 맞는다.

**3. 경계 자체를 재검토한다.** 두 클래스가 사실은 한 책임을 억지로 나눠 가진 것은 아닌지 본다. 이 경우 답은 합치는 것이다.

**"@Lazy로 돌리겠다"가 첫 답으로 나오면 설계 감각을 의심받는다.** 순서를 "설계 수정 → 그래도 불가피하면 `@Lazy`"로 두어야 한다.

### "생성자 파라미터가 10개가 됐습니다. 어떻게 하시겠어요?"

**주입 방식을 바꿀 문제가 아니라 클래스 분리 신호로 읽는다.** 2-5절에서 말한 "눈에 보이는 고통"이 제 역할을 하고 있는 상황이므로, 그 신호에 응답하는 것이 맞다.

구체적으로는 파라미터들을 용도별로 묶어본다. 보통 2~3개의 응집된 덩어리가 나온다.

```text
  현재: OrderService(gateway, orderRepo, couponService, pointService,
                     stockService, notificationService, auditLogger, shippingClient, ...)

  묶어보면:
    [주문 검증]  couponService, pointService, stockService   -> OrderValidator 로 추출
    [결제]       gateway, orderRepo                          -> OrderService 에 남긴다
    [사후 처리]  notificationService, auditLogger, shippingClient
                                                             -> 이벤트 리스너로 분리

  결과: OrderService(gateway, orderRepo, orderValidator)  — 파라미터 3개
```

특히 세 번째 덩어리(알림, 감사 로그, 배송 연동)는 대개 "주문 완료 이후에 일어나는 부수 효과"라서 `ApplicationEventPublisher`로 밀어내기 좋다. 그러면 `OrderService`는 주문 자체에만 집중하게 된다.

**"롬복으로 가려서 계속 간다"는 답은 감점 요인이다.** 생성자 주입의 네 번째 장점을 스스로 무력화하는 선택이기 때문이다.

### "`final`을 붙이는 게 동시성에도 도움이 되나요?" (가산점 포인트)

된다. 자바 메모리 모델은 **생성자 안에서 `final` 필드에 쓴 값은 생성자 종료 후 그 객체 참조를 받은 다른 스레드에게 반드시 올바르게 보인다**고 보장한다. 이를 **안전한 발행(safe publication)** 이라 부르고, 별도의 `synchronized`나 `volatile` 없이도 성립한다.

이 보장은 `final`이 아닌 필드에는 없다. 이론적으로는 다른 스레드가 초기화되기 전의 `null`을 볼 수 있는 여지가 남는다.

스프링 애플리케이션에서 이 차이가 실제 버그로 나타나는 일은 드물다. 컨테이너가 모든 빈을 만들고 연결한 뒤에야 요청 처리가 시작되므로, 사실상 기동이 하나의 큰 동기화 지점 역할을 하기 때문이다. 그래도 이 사실을 알고 있으면 **`final`이 "실수로 재대입하는 것을 막는 스타일 규칙"이 아니라 언어 차원의 보장을 끌어오는 장치**임을 설명할 수 있다. 02번 문서의 "싱글턴 빈이 공유해도 안전한 필드는 불변인 것뿐"이라는 원칙과 정확히 같은 지점에서 만난다.

---

## 한 줄 요약

생성자 주입은 의존성을 생성자 시그니처라는 공개 계약으로 드러내어 **"불완전한 객체는 아예 만들 수 없다"는 불변식을 컴파일러가 강제**하게 만드는 방식이고, 필드 주입은 생성자가 끝난 뒤 리플렉션으로 `private` 필드에 값을 꽂아 넣기에 그 불변식이 없다 — `final`을 붙일 수 없고(생성자 종료 시한을 못 지키므로), 컨테이너 밖에서는 `new`로 반제품이 만들어지며, 껍데기끼리 이어붙어 순환 참조가 성립하고, 의존성이 몇 개로 불어나든 겉으로 드러나지 않는다. "팀 규칙이라서"가 아니라 **잘못된 상태를 표현 불가능하게 만들고 나쁜 설계를 숨기지 못하게 하는 구조적 근거**가 있는 선택이다.
