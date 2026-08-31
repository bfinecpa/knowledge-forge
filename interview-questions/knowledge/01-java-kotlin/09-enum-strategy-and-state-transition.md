# enum 활용 패턴 — 상수 집합을 넘어 전략·상태 머신으로

> 핵심 관전 포인트: **Java의 enum은 단순 상수 나열이 아니라 "인스턴스 개수가
> 상수 개수로 고정된 클래스"다. 그래서 상수마다 다른 동작(전략 메서드)을
> 타입 안에 실을 수 있고, 허용되는 상태 전이 규칙을 enum 스스로 들고 있게 해
> 상태 머신으로 쓸 수 있다. 이렇게 하면 서비스 코드 곳곳에 흩어지던
> if-else/switch 분기가 enum 한 곳으로 모이고, 새 상수를 추가할 때
> 컴파일러가 구현 누락을 잡아준다 — 규칙을 문서가 아니라
> 타입 시스템에 실어 컴파일러가 지키게 만드는 설계다.**

---

## 0. 질문 + 의도

**질문**: "enum을 단순 상수 집합 이상으로 활용하는 패턴(전략 메서드 보유,
허용 상태 전이 정의)을 설명해주세요."

**출제 의도**: enum을 상수 나열로만 쓰는 사람과 동작(전략 메서드)·허용
전이(상태 머신)를 타입에 싣는 사람은 코드 전반의 분기문 산탄(if-else 산재)
양이 다르다. "타입 시스템에 규칙을 실어 컴파일러가 지키게 한다"는 사고를
Java에서 실천할 수 있는지 — Kotlin sealed class 문항과 같은 사고의 Java 판.

## 1. 전제: enum은 클래스다

enum의 각 상수는 **그 클래스의 유일한 인스턴스(싱글턴)** 다.
클래스이므로 필드·생성자·메서드를 가질 수 있고, 심지어
**상수마다 다른 메서드 구현(상수별 클래스 몸체)** 도 가질 수 있다.

```java
public enum Grade {
    BASIC(0), VIP(5), VVIP(10);   // 각각이 Grade의 인스턴스

    private final int discountRate;   // 상수마다 다른 값을 가진 필드

    Grade(int discountRate) {         // 생성자 (외부에서 호출 불가)
        this.discountRate = discountRate;
    }
}
```

이 사실을 아는 순간 "enum = 이름 붙은 int 대체품"이라는 인식에서 벗어나
아래 두 패턴이 자연스럽게 나온다.

## 2. 패턴 ① 전략 메서드 보유 — 분기문을 타입 안으로

### Before: 분기문 산탄 — 로직이 enum 밖에 흩어진다

```java
// 할인 계산이 서비스 코드에 switch로 존재
public BigDecimal discount(Grade grade, BigDecimal price) {
    switch (grade) {
        case BASIC: return BigDecimal.ZERO;
        case VIP:   return price.multiply(new BigDecimal("0.05"));
        case VVIP:  return price.multiply(new BigDecimal("0.10"));
        default:    throw new IllegalStateException();  // 방어 코드까지 필요
    }
}
// 문제점:
// 1. 같은 모양의 switch가 할인/적립/배송비... 코드베이스 곳곳에 복제된다
// 2. Grade에 GOLD를 추가해도 컴파일러는 아무 말이 없다
//    → 어딘가의 switch 하나를 빼먹으면 런타임에 default로 흘러 들어간다
```

### After: 추상 메서드 + 상수별 구현 — 누락을 컴파일러가 잡는다

```java
public enum Grade {
    BASIC {
        @Override public BigDecimal discount(BigDecimal price) {
            return BigDecimal.ZERO;
        }
    },
    VIP {
        @Override public BigDecimal discount(BigDecimal price) {
            return price.multiply(new BigDecimal("0.05"));
        }
    },
    VVIP {
        @Override public BigDecimal discount(BigDecimal price) {
            return price.multiply(new BigDecimal("0.10"));
        }
    };

    public abstract BigDecimal discount(BigDecimal price);  // 전략 메서드
}

// 호출부: 분기가 사라진다
BigDecimal discounted = price.subtract(member.getGrade().discount(price));
```

- **GOLD를 추가하면 discount 구현이 없다는 컴파일 에러**가 난다.
  "새 상수 추가 시 관련 로직 전부 수정"이라는 규칙을 사람의 기억이 아니라
  컴파일러가 강제한다.
- 로직이 단순하면 추상 메서드 대신 **함수형 필드**로 더 짧게 쓸 수도 있다
  (가산점 포인트):

```java
public enum Operation {
    PLUS((a, b) -> a + b),
    MINUS((a, b) -> a - b);

    private final IntBinaryOperator op;
    Operation(IntBinaryOperator op) { this.op = op; }

    public int apply(int a, int b) { return op.applyAsInt(a, b); }
}
```

- enum은 **인터페이스도 구현할 수 있으므로**, 여러 enum이 같은 전략
  인터페이스를 구현하게 해 다형적으로 다루는 확장도 가능하다.

## 3. 패턴 ② 허용 상태 전이 정의 — enum이 상태 머신이 된다

주문 상태처럼 "어떤 상태에서 어떤 상태로만 갈 수 있다"는 규칙은
방치하면 서비스 메서드마다 if 검사로 흩어지고, 하나만 빼먹으면
"배송 완료된 주문이 취소되는" 류의 버그가 된다.

### Before: 전이 규칙이 서비스 코드에 흩어짐

```java
public void cancel(Order order) {
    // 취소 가능 상태 검사를 이 메서드가 직접 안다
    if (order.getStatus() == OrderStatus.PAID
            || order.getStatus() == OrderStatus.CREATED) {
        order.setStatus(OrderStatus.CANCELED);
    }
    // 문제점: ship(), refund()... 메서드마다 같은 류의 if가 복제되고,
    // 상태가 추가되면 모든 메서드를 찾아다니며 고쳐야 한다
}
```

### After: 전이 규칙을 enum이 소유

```java
public enum OrderStatus {
    CREATED, PAID, SHIPPED, DELIVERED, CANCELED;

    private Set<OrderStatus> allowedNext;   // 이 상태에서 갈 수 있는 다음 상태들

    static {
        // 상수 정의 시점에는 앞의 상수를 참조할 수 없어 static 블록에서 연결
        CREATED.allowedNext   = EnumSet.of(PAID, CANCELED);
        PAID.allowedNext      = EnumSet.of(SHIPPED, CANCELED);
        SHIPPED.allowedNext   = EnumSet.of(DELIVERED);
        DELIVERED.allowedNext = EnumSet.noneOf(OrderStatus.class);
        CANCELED.allowedNext  = EnumSet.noneOf(OrderStatus.class);
    }

    public boolean canTransitionTo(OrderStatus next) {
        return allowedNext.contains(next);
    }
}

// 도메인 객체는 전이할 때 이 규칙 하나만 통과시킨다
public void changeStatus(OrderStatus next) {
    if (!status.canTransitionTo(next)) {
        throw new IllegalStateException(
            "허용되지 않는 상태 전이: " + status + " -> " + next);
    }
    this.status = next;
}
```

- 전이 규칙이 **한 곳(enum)에 표로 모여** 있어, 정책이 바뀌면 여기만 고친다.
  코드가 곧 상태 전이 다이어그램 문서 역할을 한다.
- `EnumSet`은 내부적으로 비트 벡터라 일반 HashSet보다 훨씬 가볍고 빠르다
  (가산점 포인트 — enum 키에는 `EnumMap`도 같은 이유로 우선).

## 4. 꼬리질문 대비 포인트

### "switch로도 되는데, 굳이 enum 안에 로직을 넣는 이유는?"

switch는 로직이 enum **밖**에 있어서 같은 분기가 여러 곳에 복제되고,
상수 추가 시 누락을 컴파일러가 못 잡는다(default로 조용히 흘러감).
전략 메서드는 상수 추가 시 **구현이 없으면 컴파일 에러**로 즉시 드러난다.
다만 최신 Java의 switch 식(화살표 문법)은 default 없이 쓰면 enum 상수를
전부 다루는지 컴파일러가 검사해 주므로, "한 곳에서만 쓰는 분기"라면
switch 식도 충분히 좋은 선택이라고 답하면 균형 잡힌 답이 된다.

### "enum에 로직을 넣는 게 과해지는 지점은 어디인가요?" (시니어 변별 포인트)

두 가지 기준으로 답한다. (1) **의존성** — enum은 JVM이 로딩하는 싱글턴이라
스프링 빈(Repository, 외부 API 클라이언트)을 주입받을 수 없다. 로직이
DB 조회나 외부 호출을 필요로 하는 순간 enum을 벗어나 전략 빈
(인터페이스 + 구현 클래스, `Map<Grade, DiscountPolicy>`로 주입)으로
옮겨야 한다. (2) **로직의 크기와 변경 주기** — 할인율처럼 코드 배포 없이
바뀌어야 하는 값이라면 애초에 enum 하드코딩이 아니라 DB/설정으로 뺄
문제다. enum 전략은 "규칙이 타입과 함께 컴파일 타임에 고정되어도 좋은
가벼운 로직"까지가 적정선이다.

### "enum을 DB에 저장할 때는 어떻게 하나요? ordinal 저장의 위험은?"

`ordinal()`(선언 순서 정수)로 저장하면 상수 순서를 바꾸거나 중간에
추가하는 순간 **기존 데이터 전체의 의미가 틀어진다.** 문자열 `name()`으로
저장하는 게 원칙이고(JPA면 `@Enumerated(EnumType.STRING)`), 이름 변경까지
견디려면 enum에 별도 코드 값 필드를 두고 컨버터(`AttributeConverter`)로
매핑한다 — 저장된 값과 코드의 결합을 한 곳에서 통제할 수 있다(가산점 포인트).

### "상태 전이 정의에서 왜 static 블록을 썼나요?"

enum 상수는 선언 순서대로 생성되는데, 생성자 시점에는 아직 만들어지지
않은 **뒤의 상수를 참조할 수 없다**(전방 참조 금지 — 컴파일 에러).
그래서 상수 간 관계(전이 그래프)는 모든 상수 생성이 끝난 뒤인 static
블록에서 연결한다. 이걸 설명하면 실제로 구현해 본 사람이라는 신호가 된다.

### "Kotlin이라면 어떻게 풀겠어요?"

같은 문제를 Kotlin은 `sealed class`/`sealed interface` + `when`의
**완전성 검사(exhaustiveness)** 로 푼다. sealed는 상태마다 다른 필드를
가질 수 있어(예: CANCELED만 취소 사유 보유) enum보다 표현력이 높고,
상태별 데이터가 필요 없다면 Kotlin에서도 enum이 더 간결하다 —
"둘 다 타입 시스템에 규칙을 실어 컴파일러가 지키게 한다는 점은 같다"고
묶어 답하면 출제 의도에 정확히 부합한다.

---

## 한 줄 요약

enum은 상수마다 하나뿐인 인스턴스를 가진 클래스이므로, **동작(전략
메서드)과 규칙(허용 상태 전이)을 상수 곁에 실을 수 있다** — 흩어진
분기문을 타입 안으로 모으고, 상수 추가 시 누락을 컴파일러가 잡게 만드는
것이 "상수 집합 이상"의 핵심이다.
