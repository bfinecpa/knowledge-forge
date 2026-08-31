# Java record — 불변 데이터 캐리어의 언어 차원 지원, 어디에 쓰고 어디엔 못 쓰나

> 핵심 관전 포인트: **record는 "데이터를 담아 나르는 불변 캐리어"를 선언
> 한 줄로 만드는 기능이다 (Java 16 정식).** 헤더에 컴포넌트만 선언하면
> private final 필드, 생성자, 접근자, `equals`/`hashCode`/`toString`이
> 자동 생성된다. **DTO·값 객체·복합 키·스트림 중간 결과**처럼 "상태가 곧
> 정체성"인 곳에 쓰고, **JPA 엔티티처럼 식별자 기반 정체성과 가변 상태가
> 필요한 곳에는 못 쓴다**는 경계까지 말하는 것이 답이다. 자동 생성이
> 주는 진짜 가치는 타이핑 절약이 아니라 **equals/hashCode 규약 위반
> 버그의 원천 차단**이다.

---

## 0. 질문 + 의도

**질문**: "Java의 record는 언제 쓰나요?"

**출제 의도**: 불변 데이터 캐리어를 언어가 직접 지원하는 흐름(Java 16+)을
따라오고 있는지, DTO 보일러플레이트를 어떻게 줄이는지 — 언어 버전 업의
이점을 실무에 수용하는 속도를 본다. "record가 뭔지"보다 "우리 코드베이스의
어떤 클래스를 record로 바꿨는가/안 바꿨는가"의 판단을 본다.

## 1. record가 해결한 문제 — "값 4개를 나르는 데 50줄"

Java 16 이전, 필드 몇 개를 담는 불변 클래스 하나를 규약에 맞게 만들려면:

```java
// before — 순수한 데이터 캐리어인데도 이만큼 필요하다
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

    @Override public boolean equals(Object o) { /* 필드 3개 비교... */ }
    @Override public int hashCode() { /* 필드 3개 조합... */ }
    @Override public String toString() { /* ... */ }
}
```

```java
// after — 같은 것을 한 줄로. 이 한 줄이 '의도 선언'이기도 하다
public record OrderSummary(Long orderId, String customerName, long amount) {}
```

자동으로 생겨나는 것:

| 자동 생성 | 형태 |
|---|---|
| 필드 | 컴포넌트마다 `private final` |
| 표준(canonical) 생성자 | 모든 컴포넌트를 받는 생성자 |
| 접근자 | `orderId()`, `customerName()` — **get 접두사 없음** |
| `equals`/`hashCode` | 모든 컴포넌트 기반 — 규약 자동 준수 |
| `toString` | `OrderSummary[orderId=1, ...]` |

두 가지를 짚어야 한다:

1. **줄 수 절약이 본질이 아니다.** 손으로 쓴 equals/hashCode는 필드가
   추가될 때 갱신을 잊는 순간 규약이 깨지고, `HashMap`/`HashSet`에서
   "분명 넣었는데 못 찾는" 버그가 된다 (equals/hashCode 문항과 연결).
   record는 컴포넌트가 바뀌면 **컴파일러가 다시 생성**하므로 이 버그
   계열이 원천 차단된다.
2. **record 선언 자체가 문서다.** "이 타입은 불변이고, 상태가 같으면 같은
   것으로 취급한다(값 의미론)"를 읽는 사람에게 언어 차원에서 보증한다.
   Lombok이 붙은 클래스는 어노테이션 조합을 읽어야 알 수 있는 것과 대비.

### 컴팩트 생성자 — 검증·정규화를 넣는 자리

```java
public record Money(long amount, String currency) {
    public Money {                       // 파라미터 목록이 없는 '컴팩트 생성자'
        if (amount < 0) throw new IllegalArgumentException("음수 금액");
        currency = currency.toUpperCase();  // 파라미터를 재대입하면 그 값이 필드에 저장됨
    }                                       // 필드 대입은 끝에서 자동 수행
}
```

생성 시점 검증이 언어 구조에 자리 잡고 있어서, "유효하지 않은 상태의
인스턴스는 존재할 수 없다"는 값 객체의 원칙을 지키기 쉽다.

---

## 2. 언제 쓰나 — 실무 사용처

### 2-1. API 요청/응답 DTO (가장 흔한 자리)

```java
public record OrderResponse(Long id, String status, long amount) {
    public static OrderResponse from(Order order) {   // 정적 팩토리, 인스턴스 메서드 추가 가능
        return new OrderResponse(order.getId(), order.getStatus().name(), order.getAmount());
    }
}
```

- Jackson이 record를 지원하므로 Spring MVC의 `@RequestBody`/응답 본문에
  그대로 쓴다. 요청 DTO가 불변이면 "컨트롤러 어딘가에서 요청 객체를
  수정했나?"를 의심할 필요가 없어진다.
- Bean Validation 어노테이션도 컴포넌트에 붙는다:
  `public record SignupRequest(@NotBlank String email, ...)`.

### 2-2. 조회 전용 프로젝션

JPA에서 화면에 필요한 컬럼만 담는 조회 결과로 — 리포지토리의 DTO
프로젝션 대상으로 record를 쓰면 "조회 결과는 수정해도 DB에 반영되지
않는다"는 사실이 타입(불변)으로 표현된다. 엔티티를 그대로 응답에 노출하는
안티패턴을 막는 장치이기도 하다.

### 2-3. 값 객체 (도메인의 Money, Period, 좌표)

상태가 같으면 같은 것으로 취급해야 하는 개념들. equals가 자동이라 값
의미론이 공짜다.

### 2-4. Map의 복합 키, 스트림 중간 결과

```java
// equals/hashCode가 자동이라 복합 키로 안전하다
record CacheKey(Long memberId, String category) {}
Map<CacheKey, List<Item>> cache = ...;

// 메서드 안에서만 쓰는 로컬 record — 스트림 중간 결과에 이름 붙이기
List<TopCustomer> top(List<Order> orders) {
    record NameAmount(String name, long amount) {}    // 메서드 지역 선언 가능
    return orders.stream()
            .map(o -> new NameAmount(o.getCustomerName(), o.getAmount()))
            ...
}
```

로컬 record는 `Map.Entry`나 `Object[]`로 얼버무리던 "임시 튜플"에 이름과
타입 안전을 준다 — 작지만 코드 리뷰에서 체감이 큰 활용처. (가산점 포인트)

### 2-5. sealed interface와의 조합 (가산점 포인트)

```java
public sealed interface PaymentResult permits Approved, Declined {}
public record Approved(String approvalCode) implements PaymentResult {}
public record Declined(String reason) implements PaymentResult {}

// switch 패턴 매칭(Java 21 정식)과 만나면: 새 결과 타입 추가 시 컴파일러가 누락을 잡는다
String message = switch (result) {
    case Approved a -> "승인 " + a.approvalCode();
    case Declined d -> "거절: " + d.reason();
};
```

"불변 데이터 + 닫힌 타입 계층 + 패턴 매칭"은 결제 결과·이벤트 같은
상태 표현을 컴파일러가 검증하게 만드는 조합이다 — Kotlin
sealed class + data class로 하던 설계의 Java 판.

### 2-6. 설정 바인딩

Spring Boot의 `@ConfigurationProperties`를 record로 선언하면 생성자
바인딩으로 채워진다 — "설정은 기동 후 불변"이라는 성질과 정확히 맞는 자리.

---

## 3. 언제 못 쓰나 / 함정

### 3-1. JPA 엔티티는 불가

엔티티는 record가 될 수 없다 — 이유를 말할 수 있어야 한다:

- JPA는 **인자 없는 생성자**로 객체를 만들고 필드에 값을 나중에 채우며,
  지연 로딩 **프록시는 엔티티를 상속**해서 만든다. record는 모든 필드가
  final이고 클래스도 암묵적으로 final이라 둘 다 불가능.
- 더 본질적으로, 엔티티의 동일성은 **식별자(id)** 기준이고 상태는 변한다.
  "모든 상태가 같아야 같은 것"인 record의 값 의미론과 정면충돌한다.
- 그래서 역할 분담이 명확해진다: **엔티티는 클래스, 계층을 오가는 데이터는
  record.**

### 3-2. 얕은 불변(shallow immutability) 함정

```java
// 함정 — 참조가 final일 뿐, 참조 너머의 내용은 보호되지 않는다
public record Cart(List<Item> items) {}

var cart = new Cart(items);
items.add(newItem);        // 밖에서 원본 리스트를 바꾸면 cart 내용도 바뀐다!

// 올바른 예 — 컴팩트 생성자에서 방어적 복사
public record Cart(List<Item> items) {
    public Cart { items = List.copyOf(items); }   // 불변 복사본으로 교체
}
```

record는 **필드 재대입만** 막는다. 가변 객체(List, Date 등)를 컴포넌트로
받으면 방어적 복사가 여전히 필요하다 (방어적 복사 문항과 연결).

### 3-3. 그 외 제약

- 다른 클래스를 **extends 못 한다** (암묵적으로 `java.lang.Record` 상속).
  인터페이스 구현은 가능.
- 컴포넌트 외 **인스턴스 필드를 추가할 수 없다** — "상태는 전부 헤더에"가
  강제된다. static 필드/메서드, 인스턴스 메서드는 추가 가능.
- 빌더가 없다 — 컴포넌트가 많고 선택 인자가 섞이면 표준 생성자 호출이
  읽기 어려워진다. 정적 팩토리를 곁들이거나, 그 정도로 크면 record가 맞는
  모양인지부터 의심한다.
- 필드 일부만 바꾼 사본을 만드는 내장 수단(wither)이 없어서
  `new OrderSummary(old.orderId(), old.customerName(), 새값)`처럼 전부
  나열해야 한다 — Kotlin data class의 `copy()`와 대비되는 지점.

---

## 4. 꼬리질문 대비 포인트

### "record면 불변이 완전히 보장되나요?"

아니다 — **얕은 불변**이다. 필드 재대입만 막고, 컴포넌트가 가변 객체(List,
배열 등)면 그 내용물은 밖에서 바뀔 수 있다. 컴팩트 생성자에서
`List.copyOf` 등으로 방어적 복사를 해야 진짜 불변이 된다. "record니까
스레드 세이프"라고 단정하는 코드 리뷰 코멘트가 있으면 이 지점을 확인한다.

### "JPA 엔티티를 record로 선언하면 왜 안 되나요?"

기술적으로는 JPA가 요구하는 인자 없는 생성자·비-final 필드·상속 기반
프록시(지연 로딩)가 record의 all-final·암묵적 final 클래스와 충돌해서
불가능하다. 개념적으로는 엔티티의 동일성이 식별자 기준이고 생명주기 동안
상태가 변하는 반면, record는 "모든 상태가 곧 정체성"인 값 의미론이라
모델 자체가 다르다. 대신 조회 프로젝션·DTO 자리에서는 record가 정확히
맞는 도구다.

### "Lombok(@Value, @Data)을 쓰고 있는데 record로 갈아탈 가치가 있나요?" (시니어 변별 포인트)

불변 데이터 캐리어(@Value 자리)는 record가 상위 호환에 가깝다 — 어노테이션
프로세싱이라는 빌드 의존성 없이 언어가 보증하고, 읽는 사람도 record 키워드
하나로 성질을 안다. 반면 **전부는 대체 못 한다**: 가변 객체의
@Getter/@Setter(JPA 엔티티 등), 필드 많은 타입의 @Builder는 record에
대응물이 없다. 그래서 현실적 판단은 "일괄 교체"가 아니라 **신규 DTO·값
객체부터 record를 기본값으로, 엔티티·빌더 필요 타입은 Lombok 유지** 같은
경계 설정이고, 마이그레이션 시 접근자 이름이 `getX()` → `x()`로 바뀌어
호출부와 일부 리플렉션 기반 도구에 영향이 있다는 것까지 짚으면 좋다.

### "record의 equals/hashCode 자동 생성이 실무에서 왜 중요한가요?"

손으로 쓴 equals/hashCode는 필드 추가 시 갱신을 잊으면 조용히 규약이
깨진다 — HashSet 중복 판정, HashMap 키 조회, 테스트의 동등성 단언이
전부 어긋나는데 컴파일러는 아무 말도 없다. record는 컴포넌트 정의에서
매번 다시 생성되므로 이 "필드는 늘었는데 equals는 옛날" 버그 계열이
구조적으로 사라진다. AI가 생성한 DTO 코드 리뷰에서도 equals 구현을
검증하는 대신 record인지 확인하는 쪽이 싸다.

### "Kotlin data class와의 차이를 안다면?" (가산점 포인트)

방향은 같다(데이터 캐리어의 언어 지원 + equals/hashCode/toString 자동).
차이는 — data class는 `var` 프로퍼티를 허용해 가변일 수 있지만 record는
전 컴포넌트 final로 불변이 강제되고, data class에는 `copy()`와 구조 분해가
있지만 record에는 대응물이 없어 부분 수정 사본이 번거롭다. 반대로 record는
로컬 선언·sealed/패턴 매칭과의 결합이 Java 표준 문법으로 들어와 있다.

---

## 한 줄 요약

record는 "상태가 곧 정체성인 불변 데이터 캐리어"를 언어가 직접 지원하는
기능으로, DTO·값 객체·복합 키·로컬 튜플에는 기본값으로 쓰되, 식별자
정체성과 가변 상태·프록시가 필요한 JPA 엔티티에는 쓸 수 없고, 가변
컴포넌트에는 방어적 복사가 여전히 필요하다는 경계까지 아는 것이 실무
수용의 완성이다.
