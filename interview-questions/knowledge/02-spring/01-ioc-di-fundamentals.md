# IoC와 DI — 제어의 역전과 의존성 주입, 왜 쓰는가

> 핵심 관전 포인트: **IoC(제어의 역전)는 "객체를 언제 만들고, 누구와 연결하고, 언제 없앨지"를 결정하는 주도권을 내 코드에서 스프링 컨테이너로 넘기는 설계 원칙이고, DI(의존성 주입)는 그 원칙을 실현하는 구체적 수단이다 — 필요한 협력 객체를 클래스 안에서 `new`로 직접 만들지 않고 밖에서 넣어받는 것. 이렇게 하면 클래스가 구현체 이름이 아니라 인터페이스에만 의존하게 되어, 결제사를 Toss에서 Kakao로 바꿀 때 고쳐야 하는 곳이 `new`가 흩어진 파일 전부에서 빈 설정 한 곳으로 줄고, 테스트에서는 컨테이너를 띄우지 않고 `new OrderService(가짜 게이트웨이)` 한 줄로 진짜 결제 API를 차단할 수 있다. 여기에 컨테이너가 객체를 손에 쥐고 있기에 가능해지는 것이 하나 더 있다 — `@Transactional`·`@Cacheable` 같은 프록시 기반 AOP다. 내가 `new`로 만든 객체에는 스프링이 프록시를 씌울 기회가 없으므로 그 애너테이션들이 조용히 무효가 된다.**

---

## 0. 질문 + 의도

**질문**: "IoC와 DI란 무엇이고, 왜 사용하나요?"

**출제 의도**: "왜"를 묻는 이유는 테스트 가능성과 결합도 관점에서 설명할 수 있는지 보기 위해서다. 이걸 설명 못 하는 사람은 DI를 쓰면서도 static 유틸과 `new`를 남발해 테스트 불가능한 코드를 만든다.

## 1. 전제 지식 — 컨테이너와 빈이 도대체 무엇인가

`@Autowired`나 `@Service`를 써 본 사람도 "컨테이너에게 넘긴다"는 문장에서 막힌다. **넘기는 대상이 무엇인지**를 한 번도 정의받지 못했기 때문이다. IoC를 말하기 전에 이 둘부터 세우고 간다.

### 1-1. 컨테이너 — 완성된 객체들을 이름표 붙여 보관하는 창고

**스프링 컨테이너는 애플리케이션이 쓸 객체들을 대신 만들어 서로 연결해 놓고, 이름표를 붙여 보관하다가 필요할 때 꺼내주는 저장소다.** 자바 코드로서의 정체는 `ApplicationContext` 라는 인터페이스의 구현체이고, 그 안에는 대단한 마법이 아니라 사실상 **`Map<빈 이름, 완성된 객체>`** 한 벌과 그 객체들을 어떻게 만들지 적어둔 설계도 목록이 들어 있다.

"컨테이너(container, 담는 그릇)"라는 이름은 정확히 그 역할에서 왔다. 객체들을 담아두는 그릇이라는 뜻이다.

기동할 때 컨테이너가 하는 일을 순서대로 보면 이렇다.

```text
[애플리케이션 기동]
 1. 스캔        @Component·@Service·@Repository·@Configuration 이 붙은 클래스를 찾는다
                  -> "이런 것들을 만들어야 한다"는 설계도(빈 정의)를 등록한다
 2. 인스턴스화   설계도를 보고 실제 객체를 new 한다
 3. 연결(주입)   OrderService 가 PaymentGateway 를 필요로 한다고 적혀 있으면
                  타입이 맞는 객체를 찾아 넣어준다
 4. 보관        완성된 객체를 이름표와 함께 Map 에 넣는다
                  { "orderService" -> OrderService 인스턴스,
                    "tossPaymentGateway" -> TossPaymentGateway 인스턴스, ... }
[기동 완료 — 이후 요청이 오면 이 Map 에서 꺼내 쓴다]
```

이 그림에서 놓치면 안 되는 점은 **3번(연결)이 기동 시점에 이미 끝나 있다**는 것이다. 요청이 들어올 때마다 객체를 찾아 조립하는 게 아니라, 애플리케이션이 뜨는 동안 객체 그래프 전체를 한 번 완성해 놓는다. 그래서 의존성이 빠져 있거나 서로 물고 도는 문제가 **배포 후 첫 요청이 아니라 기동 로그에서** 드러난다.

### 1-2. 빈(bean) — 컨테이너가 관리하는 객체

**빈은 "컨테이너가 만들고, 연결하고, 생명주기를 책임지는 객체"다.** 같은 클래스라도 내가 `new`로 만든 인스턴스는 빈이 아니다. 컨테이너의 Map 안에 들어 있어야 빈이다. 이 구분이 뒤에서 계속 되돌아온다 — 빈이 아니면 `@Transactional`도 안 먹는다(3-3절).

이름의 유래도 알아두면 기억에 남는다. 자바에서 재사용 가능한 부품 객체를 부르는 옛 규격 이름이 **JavaBeans**였고, 자바(Java)가 커피 산지 이름이라 그 부품들을 **커피콩(bean)**에 빗댄 것이다. 스프링은 이 관례를 그대로 물려받아 자기가 관리하는 객체를 빈이라 부른다. 즉 "콩"에 기술적 의미는 없고, **"컨테이너에 담긴 부품 하나"** 라는 뜻으로 읽으면 된다.

### 1-3. IoC — 제어의 주도권이 뒤집힌다

이제 IoC를 말할 수 있다. 전통적인 코드에서는 **내 코드가 주도권을 갖는다.** 필요한 객체를 내가 만들고, 내가 호출한다.

```java
// 전통적 방식: 생성 시점도 대상도 전부 내가 결정한다
public class OrderService {
    // 이 한 줄에 "무엇을(TossPaymentGateway) 언제(OrderService 가 만들어질 때)
    // 어떻게(기본 생성자로)" 만들지가 전부 박혀 있다.
    private final PaymentGateway gateway = new TossPaymentGateway();
}
```

**IoC(Inversion of Control, 제어의 역전)는 이 주도권을 컨테이너로 넘기는 것이다.** 무엇을 만들고 누구와 연결하고 언제 없앨지는 컨테이너가 결정하고, 내 코드는 **호출당하는 입장**이 된다. "역전"이라는 말은 호출의 방향이 뒤집혔다는 뜻이다 — 내가 프레임워크를 부르던 것에서, 프레임워크가 나를 부르는 쪽으로.

비유하자면 직접 장을 봐서 요리하는 것(전통)과 뷔페에서 차려진 음식을 받는 것(IoC)의 차이다. 무엇을 먹을지(비즈니스 로직)는 여전히 내가 정하지만, 조리와 배식(객체 생성·조립)은 주방이 한다.

이 관계를 한 마디로 정리한 표현이 **할리우드 원칙(Hollywood Principle)** — "Don't call us, we'll call you"(우리한테 전화하지 마세요, 저희가 연락드릴게요)다. 오디션에 떨어진 배우에게 하는 상투적인 말에서 따온 이름으로, **프레임워크가 내 코드를 호출한다**는 구조를 가리킨다.

여기서 미리 못 박아둘 것이 하나 있다. **IoC는 DI보다 넓은 개념이다.** 템플릿 메서드 패턴(뼈대는 상위 클래스가 갖고 세부 단계만 내가 구현하면 상위 클래스가 그것을 불러주는 것), 서블릿 컨테이너가 서블릿의 `init`·`service`·`destroy`를 알아서 부르는 것, `JdbcTemplate`이 내가 넘긴 콜백을 대신 호출해주는 것 — 전부 DI 없이 성립하는 IoC다. DI는 IoC를 구현하는 여러 방법 중 스프링이 주력으로 택한 하나일 뿐이다.

## 2. DI — `new` 한 줄이 왜 나쁜가

### 2-1. 결합도부터 정의하자

"결합도가 낮아진다"는 결론을 먼저 외우면 아무 쓸모가 없다. **결합도(coupling)는 "B가 바뀌었을 때 A도 같이 고쳐야 하는 정도"다.** A를 고칠 이유가 A 자신의 요구가 아니라 B의 변경 때문에 생긴다면, A는 B에 결합돼 있다.

`new TossPaymentGateway()` 한 줄이 만드는 결합은 두 겹이다.

첫째, **컴파일 타임 의존**이다. `OrderService.class` 안에 `TossPaymentGateway`라는 클래스 이름이 상수 풀에 박힌다. `TossPaymentGateway`가 사라지면 `OrderService`는 컴파일조차 안 된다.

둘째, **생성 방법에 대한 의존**이다. `new TossPaymentGateway()`는 "이 클래스는 인자 없는 생성자로 만들 수 있다"는 사실에 기대고 있다. 나중에 Toss가 API 키와 타임아웃을 생성자로 받게 바뀌면, 그 클래스와 아무 상관없는 `OrderService`가 깨진다.

### 2-2. "PG사를 바꿔주세요" 요구가 들어왔을 때 실제로 열어야 하는 파일

추상적인 설명 대신 실제 작업 목록으로 보자. 결제 게이트웨이를 각 서비스에서 직접 `new` 하고 있었다면, 교체 작업의 첫 단계는 **grep**이 된다.

```text
$ grep -rn "new TossPaymentGateway()" src/

  src/main/java/.../order/OrderService.java:18          -> 수정
  src/main/java/.../order/RefundService.java:22         -> 수정
  src/main/java/.../subscription/SubscriptionService.java:31  -> 수정
  src/main/java/.../settlement/SettlementBatch.java:47  -> 수정
  src/main/java/.../admin/ManualPaymentService.java:15  -> 수정
  src/test/java/.../order/OrderServiceTest.java:29      -> 수정 (Toss 전제로 짜인 테스트)
  src/test/java/.../order/RefundServiceTest.java:34     -> 수정

  = 프로덕션 5개 + 테스트 2개, 총 7개 파일을 열어 고치고 전부 다시 검증해야 한다.
    한 군데를 빠뜨리면 "환불만 아직 Toss로 나가는" 상태가 되고,
    그 사실은 정산이 안 맞는 날에야 발견된다.
```

DI로 바꾸면 같은 요구가 이렇게 처리된다.

```text
$ grep -rn "new TossPaymentGateway()" src/

  src/main/java/.../config/PaymentConfig.java:14        -> 수정

  = 1개 파일. OrderService·RefundService·SettlementBatch 는 한 글자도 건드리지 않는다.
    빠뜨릴 곳이 애초에 하나뿐이라 "일부만 교체된 상태"가 존재할 수 없다.
```

**7개에서 1개로 줄어든 것, 이것이 "결합도가 낮아진다"의 실체다.** 결합도는 형용사가 아니라 이렇게 셀 수 있는 수치로 나타난다.

### 2-3. before / after

```java
// before: 직접 생성 — 강한 결합
public class OrderService {
    private final PaymentGateway gateway = new TossPaymentGateway();
    // 문제 1: Toss -> Kakao 로 바꾸려면 이 클래스 파일을 열어야 한다.
    //         (그리고 같은 짓을 하는 다른 6개 파일도 함께)
    // 문제 2: 테스트를 돌리면 진짜 결제 API 로 HTTP 요청이 나간다.
    //         가짜로 바꿔 끼울 자리가 코드 어디에도 없다.
    // 문제 3: TossPaymentGateway 의 생성자 시그니처가 바뀌면 여기가 깨진다.
}

// after: 생성자 주입 — 느슨한 결합
public class OrderService {
    private final PaymentGateway gateway;   // 인터페이스 타입. 구현체 이름이 없다.

    // "나를 만들려면 PaymentGateway 하나가 필요하다"만 선언하고,
    // 그것을 누가 어떻게 구해오는지는 알지도 못하고 알 필요도 없다.
    public OrderService(PaymentGateway gateway) {
        this.gateway = gateway;
    }
}
```

after 코드에서 사라진 것은 `new` 한 줄이 아니라 **"어떤 구현체를 쓸지 결정하는 책임"** 자체다. 그 책임이 `OrderService` 밖으로 나가 설정(`@Configuration` 또는 컴포넌트 스캔)으로 옮겨졌다.

의존 방향을 그림으로 보면 무엇이 뒤집혔는지 분명해진다.

```text
[before]  OrderService  ──────────▶  TossPaymentGateway
          (상위 정책)                   (하위 세부구현)
          정책이 세부구현을 직접 가리킨다. 세부가 바뀌면 정책이 흔들린다.

[after]   OrderService  ──────▶  «interface» PaymentGateway
                                        ▲
                                        │ implements
                          TossPaymentGateway / KakaoPaymentGateway
          둘 다 인터페이스를 향한다. 구현체는 언제든 갈아 끼워도 정책은 그대로다.
```

이렇게 **고수준 모듈과 저수준 모듈이 모두 추상화를 향하도록 만드는 것**이 SOLID의 DIP(의존관계 역전 원칙)이고, **기능 확장(구현체 추가) 시 기존 코드를 수정하지 않게 되는 것**이 OCP(개방-폐쇄 원칙)다. DI는 이 두 원칙을 코드 수준에서 성립시키는 도구다.

### 2-4. 주입 방식은 세 가지가 있다

의존성을 밖에서 넣어주는 통로는 세 개다.

| 방식 | 값이 들어가는 자리 |
|---|---|
| 생성자 주입 | 생성자 파라미터 |
| 수정자(setter) 주입 | `setXxx()` 메서드 |
| 필드 주입 | `@Autowired`가 붙은 필드에 직접 |

셋 중 무엇을 왜 골라야 하는지, 필드 주입이 구체적으로 어떤 사고를 부르는지는 **[03-constructor-injection-over-field-injection.md](03-constructor-injection-over-field-injection.md)** 에서 통째로 다룬다. 여기서는 "통로가 셋 있고 기본은 생성자 주입"까지만 알고 넘어가면 된다.

## 3. 왜 쓰는가 — 세 가지 실익을 시나리오로

### 3-1. 구현 교체 — "다음 달부터 신규 가입자만 새 PG로" 같은 요구를 받았을 때

교체는 전부-아니면-전무로 오지 않는다. 실제로 오는 요구는 이런 모양이다.

- "정산 배치는 그대로 두고 결제 요청만 새 PG로 보내주세요."
- "장애 나면 5분 안에 예전 PG로 되돌릴 수 있어야 합니다."
- "스테이징에서는 PG를 태우지 말고 항상 성공하는 가짜로 두세요."

`new`가 흩어져 있으면 이 셋 다 코드 수정과 재배포를 요구한다. **DI 구조에서는 "어떤 구현체를 빈으로 올릴지"만 바꾸면 되므로 설정 문제로 축소된다.**

```java
@Configuration
public class PaymentConfig {

    // 프로필로 갈아 끼운다. prod 에서는 Kakao, local/staging 에서는 가짜.
    // 되돌리기가 필요하면 프로필이나 설정값만 바꿔 재기동하면 되고,
    // OrderService·RefundService·SettlementBatch 는 손대지 않는다.
    @Bean
    @Profile("prod")
    public PaymentGateway paymentGateway(PgProperties props) {
        return new KakaoPaymentGateway(props.apiKey(), props.timeout());
    }

    @Bean
    @Profile("!prod")
    public PaymentGateway fakePaymentGateway() {
        return new AlwaysSuccessPaymentGateway();
    }
}
```

여기서 한 가지 짚어야 한다. **DI를 쓴다고 자동으로 이 이점이 생기지는 않는다.** `OrderService(TossPaymentGateway gateway)` 처럼 **구현체 타입을 주입받으면** 주입은 했지만 결합은 그대로다. 이점은 "주입받는다"가 아니라 **"인터페이스 타입으로 받는다"** 에서 나온다.

### 3-2. 테스트 — mock을 끼워 넣을 "자리"가 있는가

출제 의도가 테스트 가능성을 짚는 이유가 여기 있다. `new`로 직접 만드는 구조에서는 테스트가 물리적으로 불가능해진다.

먼저 용어 하나. **목(mock)은 진짜 협력 객체 대신 세워두는 가짜 객체**로, 미리 정해둔 값을 돌려주고 "몇 번 어떤 인자로 호출됐는지"를 기록해준다. 진짜 결제 API를 부르지 않고도 "결제가 성공하면 주문이 PAID로 바뀌는가"를 검증하기 위한 도구다.

```java
// before: 내부에서 new 하는 구조 — 테스트가 성립하지 않는다
public class OrderService {
    private final PaymentGateway gateway = new TossPaymentGateway();
}

// 테스트에서 할 수 있는 일이 없다.
OrderService service = new OrderService();
service.placeOrder(order);
// 이 한 줄이 실제로 Toss 서버로 HTTP 요청을 날린다.
// - CI 서버에 결제사 API 키가 있어야 한다
// - 네트워크가 끊기면 내 주문 로직과 무관하게 테스트가 빨간불이 된다
// - "결제가 실패했을 때 주문이 CANCELLED 로 가는가" 는 검증할 방법이 아예 없다.
//   실패를 일으키려면 진짜로 결제를 실패시켜야 하기 때문이다.

// after: 생성자 주입 — 컨테이너도 네트워크도 없이 끝난다
PaymentGateway fake = mock(PaymentGateway.class);
when(fake.pay(any())).thenReturn(PaymentResult.success());

OrderService service = new OrderService(fake);   // 가짜를 그냥 넣는다
service.placeOrder(order);
assertThat(order.status()).isEqualTo(PAID);

// 실패 경로도 한 줄로 만들어낸다 — 진짜 API 로는 재현조차 어려운 상황이다
when(fake.pay(any())).thenThrow(new PgTimeoutException());
assertThatThrownBy(() -> service.placeOrder(order))
        .isInstanceOf(OrderFailedException.class);
```

핵심은 속도가 아니라 **검증 가능한 상황의 범위**다. `new`가 박힌 구조에서는 "PG 타임아웃", "잔액 부족", "중복 결제 응답" 같은 **예외 경로를 테스트할 수단이 없다.** 그런데 장애는 정확히 그 경로에서 난다.

여기서 `new OrderService(fake)` 라는 표현을 다시 보자. **스프링을 전혀 띄우지 않았다.** 생성자 주입으로 짜인 클래스는 그냥 자바 객체이므로, 테스트는 컨테이너 기동 없이 밀리초 단위로 끝난다. 뒤집어 말하면 **"컨테이너 없이 인스턴스화할 수 있는가"가 테스트 가능성의 분기점**이다.

### 3-3. 컨테이너가 객체를 쥐고 있어야 가능한 것들 — 생명주기와 AOP

세 번째 실익은 앞의 둘과 성격이 다르다. **컨테이너가 객체를 직접 만들었기 때문에 비로소 할 수 있는 일**들이다.

컨테이너는 자기가 만든 객체에 대해 초기화 콜백(`@PostConstruct`)과 소멸 콜백(`@PreDestroy`)을 불러줄 수 있고, 싱글턴 보장도 해줄 수 있다. 이 생명주기 전체는 [02-bean-lifecycle-singleton-scope.md](02-bean-lifecycle-singleton-scope.md) 에서 다룬다.

그중 실무에서 가장 자주 사고로 이어지는 것이 **프록시 기반 AOP**다. **프록시는 원본 객체인 척하면서 호출을 먼저 받아 부가 작업을 한 뒤 원본에 넘기는 대리인 객체**다. `@Transactional`이 하는 일이 정확히 이것이다 — 컨테이너가 원본 서비스를 감싼 프록시를 만들어 두고, 그 프록시가 메서드 호출을 가로채 트랜잭션을 시작하고, 원본을 부르고, 결과에 따라 커밋하거나 롤백한다.

```text
[빈으로 등록된 경우]
  호출자 -> [OrderService 프록시]  --(1) 트랜잭션 시작(BEGIN)
                   |
                   +--(2) 원본 호출 -> [OrderService 원본]
                   |
                   <--(3) 반환 -> 커밋 또는 롤백

[내가 new 로 만든 경우]
  호출자 -> [OrderService 원본]    프록시가 없다. 감쌀 기회 자체가 없었다.
                                   @Transactional 은 아무 일도 하지 않는다.
```

그래서 이렇게 정리할 수 있다. **"DI가 안 되면 `@Transactional`도 안 먹는다."** 컨테이너 밖에서 `new`로 만든 객체는 스프링이 존재조차 모르므로 프록시를 씌울 기회가 없고, 애너테이션은 조용히 무시된다. 예외도 로그도 없이 그냥 트랜잭션이 없는 채로 돈다는 점이 특히 위험하다. (가산점 포인트)

## 4. 꼬리질문 대비 포인트

### "IoC와 DI의 관계를 한 문장으로 정리하면요?"

**IoC는 "제어를 넘긴다"는 원칙(what)이고, DI는 그것을 "의존성을 밖에서 주입받는 방식으로" 실현하는 패턴(how)이다.**

관계를 분명히 하려면 **DI 없이 성립하는 IoC의 예**를 들 수 있어야 한다. 템플릿 메서드 패턴, 서블릿 컨테이너의 생명주기 관리, `JdbcTemplate`의 콜백 호출은 전부 주입 없이도 제어가 역전돼 있다. 스프링은 그 넓은 IoC 중에서 **DI를 주된 구현 수단으로 택한 컨테이너**다.

### "주입 방식은 어떤 게 있고, 무엇을 쓰나요?"

생성자 주입, 수정자(setter) 주입, 필드 주입 셋이 있고 **기본값은 생성자 주입**이다. 근거를 한 줄로 압축하면 **"의존성이 다 갖춰지지 않으면 객체 자체가 만들어지지 않게 만드는 유일한 방식"** 이기 때문이다. 여기서 `final` 불변 보장, 순환 참조 조기 발견, 컨테이너 없는 단위 테스트, 책임 비대화의 가시화가 전부 파생된다.

각각이 없으면 실제로 어떤 사고가 나는지는 [03번 문서](03-constructor-injection-over-field-injection.md)에서 하나씩 전개한다.

### "DIP(의존관계 역전 원칙)와는 다른 건가요?"

층위가 다르다.

- **DIP**는 "고수준 모듈은 저수준 모듈이 아니라 추상화에 의존하라"는 SOLID의 설계 **원칙**이다. 지향점이지 문법이 아니다.
- **DI**는 그 원칙을 지킬 수 있도록 의존성을 밖에서 넣어주는 **구현 기법**이다.

결정적인 것은 **DI를 쓴다고 DIP가 자동으로 지켜지지는 않는다**는 점이다. `OrderService(TossPaymentGateway gateway)` 처럼 구현체 타입을 주입받으면 DI는 했지만 DIP는 위반이다. 여전히 `OrderService`가 Toss라는 저수준 세부에 컴파일 타임으로 묶여 있고, 2-2절의 grep 결과도 줄어들지 않는다.

### "서비스 로케이터와는 뭐가 다른가요?" (가산점 포인트)

**서비스 로케이터(service locator)는 필요한 객체를 중앙 등록소에 이름이나 타입으로 요청해 꺼내 쓰는 방식**이다. 제어가 넘어가 있다는 점에서는 이것도 IoC의 한 형태다.

차이는 **"의존성이 밖에서 보이는가"** 다.

```java
// 서비스 로케이터: 의존성이 메서드 본문 안에 숨는다
public class OrderService {
    public void placeOrder(Order order) {
        PaymentGateway gateway = Locator.get(PaymentGateway.class);  // 여기서 꺼낸다
        gateway.pay(order);
    }
    // 생성자 시그니처만 봐서는 이 클래스가 무엇을 필요로 하는지 알 수 없다.
    // 테스트하려면 Locator 라는 전역 상태를 테스트마다 세팅하고 되돌려야 한다.
    // 등록을 빠뜨리면 기동이 아니라 그 메서드가 호출되는 순간에 터진다.
}

// DI: 의존성이 생성자 시그니처라는 공개 계약에 드러난다
public class OrderService {
    private final PaymentGateway gateway;
    public OrderService(PaymentGateway gateway) { this.gateway = gateway; }
}
```

즉 **DI는 의존성을 드러내고, 서비스 로케이터는 감춘다.** 그리고 로케이터를 쓰는 클래스는 로케이터 자체에 결합되므로, 결합 대상이 결제사에서 로케이터로 바뀌었을 뿐 없어지지는 않았다. 스프링에서도 `ApplicationContext`를 주입받아 `getBean()`을 호출하는 코드는 사실상 서비스 로케이터이며, 같은 이유로 지양한다.

### "단점이나 비용은 없나요?" (시니어 변별 포인트)

세 가지를 균형 있게 말할 수 있어야 한다.

**(1) 흐름 추적이 어려워진다.** `gateway.pay()`를 IDE에서 따라가면 인터페이스로 간다. 실제로 어떤 구현체가 도는지는 코드가 아니라 **빈 설정과 활성 프로필을 봐야** 알 수 있다. 구현체가 여럿이고 `@Profile`·`@ConditionalOnProperty`까지 얽히면 "지금 운영에서 뭐가 뜬 거지"가 곧바로 안 나온다. 완화책은 기동 로그에 어떤 구현체가 선택됐는지 남기거나, 액추에이터의 빈 목록 엔드포인트를 열어두는 것이다.

**(2) 기동 비용과 러닝 커브.** 컨테이너가 모든 빈을 미리 만들고 연결하므로 기동 시간이 붙는다. 빈이 수천 개인 모놀리식에서는 로컬 개발의 재기동 시간이 체감상 문제가 된다.

**(3) 과도한 추상화.** 이것이 실무에서 가장 흔한 실수다. 구현체가 하나뿐이고 바뀔 일도 없는데 인터페이스부터 만들면, 파일 수와 점프 횟수만 늘고 얻는 게 없다. **"교체 가능성이 있거나, 테스트에서 가짜로 바꿔 끼워야 하는 지점에 선별 적용한다"** 는 기준을 말하면 균형 잡힌 인상을 준다.

세 번째에 덧붙이면 좋은 판단 기준이 하나 더 있다. **외부 시스템(PG, 메일, 외부 API, 파일 스토리지)과 맞닿는 지점은 거의 항상 인터페이스로 두는 값이 있다.** 교체 가능성보다 **테스트에서 그 경계를 끊어야 하기 때문**이다. 반대로 순수한 도메인 계산 로직은 인터페이스 없이 구체 클래스로 두는 편이 대개 낫다.

---

## 한 줄 요약

IoC는 객체의 생성·조립·생명주기 주도권을 내 코드에서 컨테이너(빈들을 만들어 연결해 보관하는 저장소)로 넘기는 **원칙**이고, DI는 그것을 "필요한 협력 객체를 인터페이스 타입으로 밖에서 주입받는다"는 방식으로 실현하는 **패턴**이다 — 그 대가로 얻는 것은 결제사 교체 시 고칠 파일이 7개에서 1개로 줄어드는 낮은 결합도, 진짜 API 없이 타임아웃·실패 경로까지 검증할 수 있는 `new OrderService(mock)` 테스트, 그리고 컨테이너가 객체를 쥐고 있어야만 가능한 `@Transactional` 같은 프록시 AOP다.
