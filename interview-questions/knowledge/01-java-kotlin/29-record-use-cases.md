# Java record — "이 클래스는 그 필드들이 전부다"라는 선언, 어디에 쓰고 어디엔 못 쓰나

> 핵심 관전 포인트: **record는 보일러플레이트를 줄이는 문법 설탕이 아니라 "이 타입의 상태는 헤더에 적힌 컴포넌트가 전부이고, 상태가 같으면 같은 것으로 취급한다"는 의미 선언이다. 그 선언을 했기 때문에 컴파일러가 `equals`/`hashCode`/`toString`/접근자를 대신 만들어 줄 수 있는 것이고, 순서가 반대가 아니다. 그래서 진짜 가치는 타이핑 절약이 아니라 필드를 추가했는데 `equals`를 갱신하지 않아 HashMap에서 조용히 못 찾게 되는 버그 계열의 원천 차단이다. DTO·값 객체·복합 키·스트림 중간 결과처럼 "상태가 곧 정체성"인 자리에 쓰고, 검증과 정규화는 컴팩트 생성자에 둔다. 반대로 JPA 엔티티에는 쓸 수 없고(기본 생성자 없음, 필드가 final이라 리플렉션 주입과 더티 체킹 불가, 클래스가 final이라 지연 로딩 프록시 불가, 그리고 근본적으로 식별자 정체성과 값 정체성의 충돌), 가변 컬렉션을 컴포넌트로 받으면 얕은 불변에 그치므로 컴팩트 생성자에서 `List.copyOf`로 방어적 복사를 해야 한다.**

---

## 0. 질문 + 의도

**질문**: "Java의 record는 언제 쓰나요?"

**출제 의도**: 불변 데이터 캐리어를 언어가 직접 지원하는 흐름(Java 16+)을 따라오고 있는지, DTO 보일러플레이트를 어떻게 줄이는지 — 언어 버전 업의 이점을 실무에 수용하는 속도를 본다. "record가 뭔지"보다 "우리 코드베이스의 어떤 클래스를 record로 바꿨는가/안 바꿨는가"의 판단을 본다.

## 1. record가 선언하는 것 — 문법 절약이 아니라 의미 선언

### 1-1. 출발점 — 값 세 개를 나르는 데 필요했던 코드

Java 16 이전, 필드 몇 개를 담는 불변 클래스 하나를 규약에 맞게 만들려면 이만큼이 필요했다.

```java
// before - 하는 일은 값 세 개를 담아 나르는 것뿐인데
public final class OrderSummary {
    private final Long orderId;
    private final String customerName;
    private final long amount;

    public OrderSummary(Long orderId, String customerName, long amount) {
        this.orderId = orderId;
        this.customerName = customerName;
        this.amount = amount;
    }
    public Long getOrderId() { return orderId; }
    public String getCustomerName() { return customerName; }
    public long getAmount() { return amount; }

    @Override public boolean equals(Object o) { /* 필드 3개를 하나씩 비교 */ }
    @Override public int hashCode() { /* 필드 3개를 조합 */ }
    @Override public String toString() { /* 필드 3개를 나열 */ }
}
```

```java
// after - 같은 것이 한 줄이다
public record OrderSummary(Long orderId, String customerName, long amount) {}
```

여기서 대부분의 설명이 멈춘다. "50줄이 한 줄이 됐다, 편하다." **그런데 이렇게만 소개하면 절반만 전달된다.** 왜 컴파일러가 이 코드를 대신 써 줄 수 있는지가 빠져 있기 때문이다.

### 1-2. 컴파일러가 대신 써 줄 수 있는 이유 — 내가 무엇을 약속했는가

일반 클래스에서 컴파일러는 `equals`를 대신 만들어 줄 수 없다. **무엇이 같음의 기준인지 알 방법이 없기 때문**이다.

`Member` 클래스에 `id`, `email`, `lastLoginAt` 세 필드가 있다고 하자. 두 Member가 같다는 것은 무슨 뜻인가?

- `id`만 같으면 같은 회원인가? (엔티티라면 대개 그렇다)
- 세 필드가 전부 같아야 같은가? (값 객체라면 그렇다)
- `lastLoginAt`은 비교에서 빼야 하나? (자주 바뀌는 부수 정보라면)

**답은 클래스마다 다르고, 그 답을 아는 것은 설계자뿐이다.** 그래서 자바는 지금까지 이 판단을 사람에게 맡겨 왔다.

`record`라고 쓰는 순간 그 답이 정해진다. record 선언은 **"이 타입의 상태는 헤더에 적힌 컴포넌트가 전부다"**라는 약속이고, 여기서 두 가지가 자동으로 따라 나온다.

- 숨은 상태가 없으므로, **모든 컴포넌트가 같으면 두 인스턴스는 구별할 방법이 없다.** 즉 값 의미론(value semantics)이 성립한다.
- 상태가 전부 드러나 있으므로, **`toString`에 무엇을 찍을지도 자명하다.**

이런 타입을 이론에서는 **명목 튜플(nominal tuple)**이라 부른다. 튜플(tuple)은 값을 순서대로 묶어 놓은 것이고, 명목(nominal)은 거기에 `OrderSummary`라는 **이름을 붙였다**는 뜻이다. `Object[]`나 `Map.Entry`로 얼버무리던 "값 묶음"에 타입 이름과 컴포넌트 이름을 준 것이 record다.

**정리하면 순서는 이렇다.**

```
① 개발자가 "상태는 이 컴포넌트가 전부다"라고 선언한다   (record 키워드)
        |
        v
② 그 선언이 참이라면 "같음"의 기준이 유일하게 정해진다   (모든 컴포넌트가 같으면 같다)
        |
        v
③ 그러니 컴파일러가 equals/hashCode/toString/접근자를 만들 수 있다
```

**보일러플레이트 제거는 ③의 결과이지 목적이 아니다.** 이 순서로 말할 수 있으면 "record는 DTO 짧게 쓰는 문법"이라고 답하는 사람과 갈린다.

자동으로 생겨나는 것을 정리하면 이렇다.

| 자동 생성 | 형태 |
|---|---|
| 필드 | 컴포넌트마다 `private final` |
| 표준 생성자(canonical constructor) | 모든 컴포넌트를 순서대로 받는 생성자 |
| 접근자 | `orderId()`, `customerName()` — `get` 접두사가 없다 |
| `equals`/`hashCode` | 모든 컴포넌트 기반. 규약을 자동으로 만족한다 |
| `toString` | `OrderSummary[orderId=1, customerName=kim, amount=9900]` |

접근자에 `get`이 없는 것도 의미가 있다. `getOrderId()`는 "이 객체에게 orderId를 계산해서 달라고 요청한다"는 뉘앙스지만, `orderId()`는 **"이 값이 곧 그것이다"**에 가깝다. 자바빈즈 규약을 따르는 것이 아니라 값을 그대로 드러낸다는 표현이다.

### 1-3. 진짜 가치 — equals/hashCode 규약 위반 버그의 원천 차단

자동 생성의 실무적 가치가 어디서 나오는지 구체적으로 보자. **손으로 쓴 `equals`/`hashCode`가 조용히 깨지는 시나리오**다.

```java
// 처음: 필드 2개로 만들었고 equals/hashCode도 맞게 썼다
public final class CacheKey {
    private final Long memberId;
    private final String category;
    @Override public boolean equals(Object o) { /* memberId, category 비교 */ }
    @Override public int hashCode() { return Objects.hash(memberId, category); }
}

// 6개월 뒤: 요구사항이 늘어 필드를 하나 추가했다
public final class CacheKey {
    private final Long memberId;
    private final String category;
    private final String region;   // 추가. 그런데 equals/hashCode는 그대로다
    ...
}
```

이 순간 무슨 일이 생기는지 따라가 보자.

```
new CacheKey(1L, "book", "KR")  와  new CacheKey(1L, "book", "US")

  hashCode()  -> region을 안 보므로 같은 값
  equals()    -> region을 안 보므로 true

  -> HashMap 입장에서 이 둘은 완전히 같은 키다.
     KR 사용자의 캐시를 US 사용자가 그대로 받아 간다.
```

**컴파일러는 아무 말도 하지 않는다.** 테스트도 대개 통과한다 — region이 다른 두 키를 같은 맵에 넣는 케이스를 일부러 만들지 않았다면. 그리고 이 종류의 버그는 운영에서 "가끔 남의 데이터가 보인다"는 형태로 나타나 원인 추적이 매우 어렵다.

record는 **컴포넌트 정의에서 매번 다시 생성**하므로 이 계열이 구조적으로 사라진다.

```java
// 컴포넌트를 추가하면 equals/hashCode/toString이 전부 함께 갱신된다
public record CacheKey(Long memberId, String category, String region) {}
```

같은 이유로, AI가 생성한 DTO 코드를 리뷰할 때도 **`equals` 구현이 맞는지 한 줄씩 검증하는 것보다 "record인지 확인하는 쪽"이 훨씬 싸다.**

### 1-4. record 선언 자체가 문서다

한 가지 더. `record`라는 키워드 하나가 읽는 사람에게 **언어 차원의 보증**을 준다. "이 타입은 불변이고, 상태가 같으면 같은 것으로 취급하며, 숨은 필드가 없다."

Lombok이 붙은 클래스와 대비해 보면 차이가 분명하다. `@Data`가 붙은 클래스를 만나면 어노테이션 조합을 하나씩 확인해야 그 성질을 알 수 있고, 어노테이션 프로세서 동작을 알아야 정확히 무엇이 생성됐는지 안다. record는 키워드 하나로 끝난다.

### 1-5. 컴팩트 생성자 — 검증과 정규화의 자리

record가 자동으로 만들어 주는 표준 생성자는 값을 그대로 필드에 넣기만 한다. 그런데 값 객체라면 **유효하지 않은 상태의 인스턴스가 애초에 만들어지지 못하게** 막고 싶다. 그 자리가 **컴팩트 생성자(compact constructor)**다.

```java
public record Money(long amount, String currency) {
    // 파라미터 목록을 적지 않는다. 이 형태가 컴팩트 생성자다
    public Money {
        // ① 검증: 유효하지 않으면 인스턴스가 존재조차 못 하게 막는다
        if (amount < 0) throw new IllegalArgumentException("음수 금액: " + amount);

        // ② 정규화: 파라미터에 재대입한다. this.currency = 가 아니라는 점이 핵심이다
        currency = currency.toUpperCase();

        // ③ 여기서 필드 대입이 자동으로 일어난다.
        //    this.amount = amount; this.currency = currency; 를 컴파일러가 써 넣는다
    }
}
```

`this.currency =`가 아니라 `currency =`라는 점을 정확히 이해해야 한다. **컴팩트 생성자의 본문은 "필드에 넣기 직전의 파라미터를 손볼 기회"**다. 본문이 끝나는 지점에서 컴파일러가 **그 시점의 파라미터 값들을** 필드에 대입한다. 그래서 본문에서 파라미터를 바꿔 두면 바뀐 값이 저장된다.

실제로 실행해 보면 이렇다.

```java
System.out.println(new Money(100, "krw"));
// 출력: Money[amount=100, currency=KRW]     <- 소문자로 넣었는데 대문자로 저장됐다

new Money(-1, "KRW");
// java.lang.IllegalArgumentException: 음수 금액: -1
```

이 자리가 있어서 **"유효하지 않은 상태의 인스턴스는 존재할 수 없다"**는 값 객체의 원칙을 언어 구조 안에서 지킬 수 있다. 도메인의 `Money`, `Email`, `PhoneNumber` 같은 타입은 이 검증이 있느냐 없느냐가 값 객체인지 그냥 데이터 묶음인지를 가른다.

컴포넌트 검증에 Bean Validation을 쓸 수도 있다.

```java
public record SignupRequest(@NotBlank String email, @Size(min = 8) String password) {}
```

## 2. 언제 쓰나 — 실무 사용처

### 2-1. API 요청·응답 DTO (가장 흔한 자리)

```java
public record OrderResponse(Long id, String status, long amount) {
    // record에도 정적 팩토리와 인스턴스 메서드를 추가할 수 있다
    public static OrderResponse from(Order order) {
        return new OrderResponse(order.getId(), order.getStatus().name(), order.getAmount());
    }
}
```

Jackson이 record를 지원하므로 Spring MVC의 `@RequestBody`와 응답 본문에 그대로 쓴다. 얻는 것이 둘이다.

**첫째, 요청 객체가 불변이면 "컨트롤러나 서비스 어딘가에서 요청 객체를 수정했나?"를 의심할 필요가 없어진다.** 요청 DTO를 중간에 고쳐 놓고 나중에 다시 읽는 코드는 추적이 매우 어려운데, 그 가능성 자체가 없어진다.

**둘째, 요청 DTO에 검증을 1-5의 컴팩트 생성자로 넣으면 컨트롤러에 도달한 객체는 이미 유효한 상태다.**

### 2-2. 조회 전용 프로젝션

JPA에서 화면에 필요한 컬럼만 담는 DTO 프로젝션 대상으로 record를 쓴다.

여기서 record가 주는 것은 **"이 조회 결과는 수정해도 DB에 반영되지 않는다"는 사실이 타입으로 표현된다**는 점이다. 엔티티를 그대로 조회해 응답에 노출하면 영속성 컨텍스트가 살아 있는 동안 변경이 DB로 흘러갈 수 있는데(더티 체킹), record 프로젝션은 애초에 그럴 수 없는 물건이다. **엔티티를 응답에 그대로 노출하는 안티패턴을 막는 장치이기도 하다.**

### 2-3. 값 객체 — 도메인의 Money, Period, 좌표

"상태가 같으면 같은 것으로 취급해야 하는" 개념들이다. 1-2에서 본 대로 record의 값 의미론이 정확히 이 요구와 일치하므로 `equals`가 공짜로 맞아 들어간다. 1-5의 컴팩트 생성자를 곁들이면 불변식(invariant)까지 언어가 지켜 준다.

### 2-4. Map의 복합 키, 스트림 중간 결과

```java
// equals/hashCode가 컴포넌트 기반으로 자동 생성되므로 복합 키로 안전하다
record CacheKey(Long memberId, String category) {}
Map<CacheKey, List<Item>> cache = new HashMap<>();
```

복합 키야말로 `equals`/`hashCode`가 틀리면 즉시 사고가 나는 자리인데(1-3), record는 그 위험이 없다.

메서드 안에서만 쓰는 **로컬 record**도 유용하다.

```java
List<TopCustomer> top(List<Order> orders) {
    record NameAmount(String name, long amount) {}   // 메서드 지역 선언이 가능하다

    return orders.stream()
            .map(o -> new NameAmount(o.getCustomerName(), o.getAmount()))
            ...
}
```

로컬 record는 `Map.Entry`나 `Object[]`로 얼버무리던 "이름 없는 임시 튜플"에 **이름과 타입 안전**을 준다. `entry.getValue().getKey()` 같은 코드가 `x.amount()`가 되는 차이다. 작지만 코드 리뷰에서 체감이 큰 활용처다. (가산점 포인트)

### 2-5. sealed interface와의 조합 (가산점 포인트)

record의 값을 극대화하는 조합이 있다. **닫힌 타입 계층 + 불변 데이터 + 패턴 매칭**이다.

`sealed`는 "이 인터페이스를 구현할 수 있는 타입은 여기 적힌 것들뿐"이라고 못 박는 키워드다. 구현체가 유한하게 닫혀 있으므로 **컴파일러가 "전부 다뤘는지"를 검사할 수 있게 된다.**

```java
public sealed interface PaymentResult permits Approved, Declined {}
public record Approved(String approvalCode) implements PaymentResult {}
public record Declined(String reason) implements PaymentResult {}

// switch 패턴 매칭(Java 21 정식)
String message = switch (result) {
    case Approved a -> "승인 " + a.approvalCode();
    case Declined d -> "거절: " + d.reason();
    // default가 필요 없다. permits 목록을 전부 다뤘다는 것을 컴파일러가 안다
};
```

여기서 진짜 이득은 **나중에 결과 타입이 하나 늘어날 때** 나온다. `permits`에 `Pending`을 추가하는 순간, 이 switch를 포함해 **모든 분기 지점에서 컴파일 에러가 난다.** "새 케이스를 처리하지 않은 곳"을 사람이 찾아다니는 대신 컴파일러가 목록으로 뽑아 주는 것이다.

결제 결과, 도메인 이벤트, 상태 표현처럼 **"경우의 수가 정해져 있고 하나 늘 때마다 전부 챙겨야 하는" 모델링에 맞는 조합**이다. Kotlin의 sealed class + data class로 하던 설계의 Java 판이다.

### 2-6. 설정 바인딩

Spring Boot의 `@ConfigurationProperties`를 record로 선언하면 생성자 바인딩으로 값이 채워진다.

```java
@ConfigurationProperties(prefix = "payment")
public record PaymentProperties(String apiKey, Duration timeout, int retryCount) {}
```

**"설정은 기동 시점에 정해지고 그 뒤로는 바뀌지 않는다"**는 성질과 불변 타입이 정확히 맞는 자리다. 세터가 없으므로 런타임에 누가 설정을 바꿔 놓는 경로 자체가 없다.

## 3. 언제 못 쓰나 / 함정

### 3-1. 얕은 불변 함정 — record라고 다 불변이 아니다

이것이 이 문서의 시니어 포인트다. **record가 보장하는 것은 "필드 재대입 금지"뿐이고, 참조 너머의 내용물은 보호하지 않는다.** 이것을 **얕은 불변(shallow immutability)**이라고 한다.

```java
// 문제 - 컴포넌트로 가변 리스트를 그대로 받는다
public record Order(Long id, List<Item> items) {}
```

무슨 일이 일어나는지 실제로 실행해 보면 이렇다.

```java
List<Item> items = new ArrayList<>(List.of(new Item("book")));
Order order = new Order(1L, items);

items.add(new Item("pen"));      // 밖에 남아 있는 원본 리스트를 수정한다

System.out.println(order.items());
// 출력: [Item[name=book], Item[name=pen]]
//       -> order를 만든 뒤에 order의 내용이 바뀌었다
```

`order.items` 필드는 final이라 **다른 리스트를 가리키게 바꾸지는 못한다.** 그런데 가리키는 그 리스트 자체는 여전히 `ArrayList`이고, 생성자에 넘긴 쪽이 참조를 그대로 들고 있으므로 언제든 내용을 바꿀 수 있다.

```
order.items ---> [ ArrayList ]  <--- items (호출자가 아직 들고 있는 같은 객체)
   ^                   ^
   |                   |
final이라 이 화살표는  그런데 이 상자 안의 내용물은
바꿀 수 없다           밖에서 얼마든지 바꿀 수 있다
```

**해법은 컴팩트 생성자에서 방어적 복사를 하는 것이다.**

```java
// 개선 - 받은 순간 불변 복사본으로 교체한다
public record Order(Long id, List<Item> items) {
    public Order {
        items = List.copyOf(items);
    }
}
```

같은 시나리오를 다시 실행하면 이렇게 된다.

```java
List<Item> items = new ArrayList<>(List.of(new Item("book")));
Order order = new Order(1L, items);
items.add(new Item("pen"));

System.out.println(order.items());
// 출력: [Item[name=book]]        <- 밖의 변경이 전혀 영향을 주지 못한다

order.items().add(new Item("x"));
// java.lang.UnsupportedOperationException   <- 꺼내 간 리스트도 수정할 수 없다
```

`List.copyOf`가 한 번에 두 가지를 해준다는 점이 중요하다. **원본과 연결을 끊고(복사), 결과가 수정 불가능한 리스트다(불변).** 그래서 밖에서 원본을 바꿔도, 접근자로 꺼내 간 쪽에서 수정을 시도해도 둘 다 막힌다. 덤으로 원소에 null이 섞여 있으면 그 자리에서 NPE를 던져 주므로 검증 역할도 한다.

**한 단계 더 들어가면**, `List.copyOf`도 리스트 구조만 고정할 뿐 **원소 자체가 가변이면 그 안은 여전히 바뀔 수 있다.** `Item`이 세터를 가진 클래스라면 `order.items().get(0).setName(...)`이 통한다. 그래서 진짜 깊은 불변이 필요하면 원소 타입까지 불변(record 등)이어야 한다.

`Date`, 배열 같은 다른 가변 타입도 마찬가지다. **"record니까 스레드 세이프"라는 코드 리뷰 코멘트를 보면 이 지점을 확인해야 한다.**

### 3-2. JPA 엔티티로는 쓸 수 없다

"엔티티를 record로 만들면 안 되나요"는 자주 나오는 질문이고, **막연히 "안 된다"가 아니라 이유를 셋으로 나눠 답할 수 있어야 한다.**

**첫째, JPA는 인자 없는 기본 생성자로 객체를 만든다.** JPA 명세는 엔티티에 인자 없는 생성자(protected 이상)를 요구한다. 조회 시 하이버네이트는 먼저 빈 객체를 만들고 그다음에 값을 채우는 순서로 동작하기 때문이다. record는 컴포넌트를 전부 받는 표준 생성자가 강제되고, 인자 없는 생성자를 만들려 해도 결국 표준 생성자에 값을 넘겨야 한다.

**둘째, 값을 나중에 채울 수가 없다.** 하이버네이트는 빈 객체를 만든 뒤 리플렉션으로 필드에 값을 주입한다. 그런데 **record의 필드는 리플렉션으로도 수정할 수 없다.** 일반 클래스의 `private final` 필드와도 다른 대우다.

```java
record P(String name) {}
Field f = P.class.getDeclaredField("name");
f.setAccessible(true);
f.set(new P("a"), "b");
// java.lang.IllegalAccessException: Can not set final java.lang.String field P.name

// 비교: 일반 클래스의 private final 필드는 같은 방법으로 수정된다
class C { private final String name = "a"; }
// -> setAccessible(true) 후 set 성공
```

record는 언어 차원에서 이 경로를 막아 두었다. 그래서 조회 시 값 주입이 불가능하고, 같은 이유로 **더티 체킹**(영속 상태 엔티티의 필드가 바뀐 것을 감지해 UPDATE를 날리는 기능)도 성립할 수 없다. 바꿀 수 없는 필드에는 감지할 변경이 없다.

**셋째, 지연 로딩 프록시를 만들 수 없다.** 하이버네이트의 지연 로딩은 **엔티티를 상속한 프록시 클래스**를 만들어 그것을 대신 넘겨주는 방식이다. 그런데 record는 암묵적으로 `final` 클래스라 상속이 불가능하다.

```java
System.out.println(Modifier.isFinal(P.class.getModifiers()));   // true
System.out.println(P.class.getSuperclass());                    // class java.lang.Record
```

**그리고 기술적 제약보다 근본적인 이유가 하나 더 있다. 동일성의 기준이 다르다.**

- **엔티티의 정체성은 식별자(id)** 다. 회원의 닉네임이 바뀌어도 같은 회원이다. 상태가 변하는 것이 정상이고, 상태가 달라도 id가 같으면 같은 것으로 취급해야 한다.
- **record의 정체성은 값 전체**다. 컴포넌트가 하나라도 다르면 다른 것이다.

이 둘은 정면으로 충돌한다. 설령 위의 세 가지 기술적 제약이 전부 해결되더라도 **모델 자체가 다르므로 record를 엔티티로 쓰는 것은 여전히 틀린 선택**이다.

그래서 역할 분담이 깔끔하게 갈린다. **엔티티는 클래스, 계층을 오가는 데이터(DTO·프로젝션·값 객체)는 record.**

### 3-3. 그 밖의 제약

**다른 클래스를 상속할 수 없다.** 모든 record는 암묵적으로 `java.lang.Record`를 상속하기 때문이다(위 출력에서 확인했다). 인터페이스 구현은 자유롭게 가능하므로 2-5의 sealed interface 조합에는 문제가 없다.

**컴포넌트 외에 인스턴스 필드를 추가할 수 없다.** 이건 제약이면서 동시에 **1-2의 약속을 언어가 강제하는 장치**다. "상태는 전부 헤더에"가 지켜지지 않으면 자동 생성된 `equals`가 거짓말이 되기 때문이다. static 필드와 static 메서드, 인스턴스 메서드는 자유롭게 추가할 수 있다.

**빌더가 없다.** 컴포넌트가 많고 선택 인자가 섞이면 `new Config(a, b, null, null, c, false)` 같은 호출이 되어 읽기 어려워진다. 정적 팩토리 메서드를 곁들이거나, 그 정도로 인자가 많으면 **이 타입이 record로 맞는 모양인지부터 의심하는 것**이 낫다.

**일부만 바꾼 사본을 만드는 수단이 없다.** Kotlin data class의 `copy()`에 해당하는 것이 없어서, 금액만 바꾸려 해도 전부 나열해야 한다.

```java
var updated = new OrderSummary(old.orderId(), old.customerName(), 새금액);
```

컴포넌트가 늘어날수록 이 코드가 길어지고, 나중에 컴포넌트를 추가하면 이런 자리를 전부 고쳐야 한다(다행히 컴파일 에러로 잡히기는 한다).

## 4. 꼬리질문 대비 포인트

### "record면 불변이 완전히 보장되나요?"

**아니다. 얕은 불변이다.** record가 막는 것은 필드 재대입뿐이고, 컴포넌트가 `List`·배열·`Date` 같은 가변 객체면 그 내용물은 밖에서 바뀔 수 있다.

```java
record Order(Long id, List<Item> items) {}

List<Item> items = new ArrayList<>(List.of(new Item("book")));
Order order = new Order(1L, items);
items.add(new Item("pen"));
System.out.println(order.items());   // [Item[name=book], Item[name=pen]]
```

생성자에 넘긴 쪽이 같은 리스트 객체의 참조를 계속 들고 있기 때문이다. 컴팩트 생성자에서 `List.copyOf(items)`로 방어적 복사를 하면 원본과의 연결이 끊기고 결과가 불변 리스트라 접근자로 꺼내 간 쪽의 수정도 막힌다.

**한 겹 더 들어가면**, 그래도 원소 자체가 가변이면(`Item`에 세터가 있으면) 그 안은 여전히 바뀐다. 깊은 불변이 필요하면 원소 타입까지 불변이어야 한다. "record니까 스레드 세이프"라고 단정하는 코드가 있으면 여기를 확인한다.

### "JPA 엔티티를 record로 선언하면 왜 안 되나요?"

기술적 이유가 셋, 개념적 이유가 하나다.

**기술적으로는**, ① JPA는 인자 없는 생성자로 빈 객체를 먼저 만드는데 record에는 그것이 없고, ② 그 뒤 리플렉션으로 필드에 값을 주입하는데 **record의 필드는 `setAccessible(true)`를 해도 수정이 거부되며**(일반 클래스의 private final 필드와 다른 대우다), 같은 이유로 더티 체킹도 성립하지 않고, ③ 지연 로딩 프록시는 엔티티를 상속해 만드는데 record는 암묵적으로 final 클래스라 상속할 수 없다.

**개념적으로는** 동일성의 기준이 다르다. 엔티티의 정체성은 **식별자(id)** 이고 상태는 생명주기 동안 변하는 것이 정상이다. record는 **모든 상태가 곧 정체성**인 값 의미론이다. 기술적 제약이 전부 풀리더라도 이 충돌은 남는다.

대신 **조회 프로젝션과 DTO 자리에서는 record가 정확히 맞는 도구**다. "엔티티는 클래스, 계층을 오가는 데이터는 record"라는 경계까지 말하면 깔끔하다.

### "Lombok의 `@Value`나 `@Data`를 쓰고 있는데 record로 갈아탈 가치가 있나요?" (시니어 변별 포인트)

**불변 데이터 캐리어 자리(`@Value`)는 record가 상위 호환에 가깝다.** 근거가 셋이다.

- 어노테이션 프로세싱이라는 **빌드 의존성 없이** 언어가 보증한다. Lombok은 컴파일 과정에 개입해 AST를 조작하는 방식이라 JDK 버전이 오를 때마다 호환성 이슈를 겪어 왔다.
- 읽는 사람이 **키워드 하나로** 성질을 안다. `@Data`가 붙은 클래스는 어노테이션 조합을 확인해야 불변인지 가변인지, `equals`에 무엇이 들어가는지 알 수 있다.
- IDE·디버거·리플렉션이 record를 **언어 구성 요소로 인식**한다(`Class.isRecord()`, `getRecordComponents()`).

**그런데 전부는 대체하지 못한다.** 이 단서를 말할 수 있어야 한다.

- **가변 객체의 `@Getter`/`@Setter`** — JPA 엔티티 등. record는 애초에 불변이라 대응물이 없다.
- **`@Builder`** — 컴포넌트가 많고 선택 인자가 섞인 타입에서 record는 표준 생성자 호출이 길어진다.
- **`@Slf4j` 같은 부가 어노테이션** — record와 무관하게 계속 쓰인다.

그래서 현실적 판단은 "일괄 교체"가 아니라 **경계 설정**이다. **신규 DTO·값 객체·프로젝션은 record를 기본값으로 두고, 엔티티와 빌더가 필요한 타입은 Lombok을 유지**하는 식이다.

마이그레이션할 때 챙길 것도 짚으면 좋다. **접근자 이름이 `getX()`에서 `x()`로 바뀌므로** 호출부를 전부 고쳐야 하고, 자바빈즈 프로퍼티 규약에 의존하는 도구(일부 매핑 라이브러리, 폼 바인딩, 리포팅 툴)에 영향이 갈 수 있다.

### "record의 equals/hashCode 자동 생성이 실무에서 왜 그렇게 중요한가요?"

**손으로 쓴 `equals`/`hashCode`는 필드가 추가될 때 조용히 깨지기 때문**이다.

필드를 하나 추가하고 `equals` 갱신을 잊으면, 새 필드가 다른 두 객체가 서로 같다고 판정된다. 그러면 `HashSet`이 중복으로 보고 하나를 버리고, `HashMap`이 남의 값을 돌려주고, 테스트의 동등성 단언이 통과하지 말아야 할 때 통과한다. **그런데 컴파일러는 아무 말도 하지 않는다.** 운영에서 "가끔 남의 캐시 데이터가 보인다" 같은 형태로 나타나 원인 추적이 매우 어렵다.

record는 컴포넌트 정의로부터 매번 다시 생성되므로 **"필드는 늘었는데 equals는 옛날"이라는 상태 자체가 존재할 수 없다.** 이건 편의가 아니라 버그 계열 하나를 구조적으로 없애는 일이다.

부수적 효과도 있다. AI가 생성한 DTO 코드를 리뷰할 때 `equals` 구현을 한 줄씩 검증하는 것보다 **record인지 확인하는 쪽이 훨씬 싸다.**

### "Kotlin의 data class와 무엇이 다른가요?" (가산점 포인트)

**방향은 같다.** 데이터 캐리어를 언어가 직접 지원하고, `equals`/`hashCode`/`toString`을 자동 생성한다.

**차이는 셋이다.**

- **불변성 강제**: data class는 `var` 프로퍼티를 허용해 가변일 수 있다. record는 전 컴포넌트가 final이라 불변이 강제된다.
- **부분 수정 사본**: data class에는 `copy()`와 구조 분해 선언(`val (a, b) = obj`)이 있어 일부만 바꾼 사본을 쉽게 만든다. record에는 대응물이 없어 전 컴포넌트를 나열해야 한다.
- **언어 통합**: record는 로컬 선언, sealed 인터페이스, switch 패턴 매칭과의 결합이 Java 표준 문법으로 들어와 있다.

한 줄로 말하면 **record가 더 엄격하고(불변 강제, 숨은 상태 금지) data class가 더 편리하다(copy, 구조 분해).**

---

## 한 줄 요약

record는 "이 타입의 상태는 헤더의 컴포넌트가 전부이고 상태가 같으면 같은 것"이라는 **의미 선언**이며 `equals`/`hashCode`/`toString`/접근자 자동 생성은 그 선언에서 따라 나오는 결과이므로, 진짜 가치는 줄 수 절약이 아니라 **필드 추가 시 equals 갱신을 잊어 HashMap이 조용히 오작동하는 버그 계열의 원천 차단**에 있다 — DTO·조회 프로젝션·값 객체·복합 키·로컬 튜플에는 기본값으로 쓰고 검증과 정규화는 컴팩트 생성자에 두되, 가변 컬렉션을 컴포넌트로 받으면 얕은 불변에 그치므로 `List.copyOf`로 방어적 복사를 해야 하고, 기본 생성자 부재·리플렉션 주입 불가·final 클래스로 인한 프록시 불가에 더해 식별자 정체성과 값 정체성이 충돌하는 JPA 엔티티에는 쓸 수 없다는 경계까지 아는 것이 실무 수용의 완성이다.
