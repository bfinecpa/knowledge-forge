# enum 활용 패턴 — 상수 집합을 넘어 전략·상태 머신으로

> 핵심 관전 포인트: **이 주제는 "enum은 클래스다"라는 전제 하나에서 전부 따라 나온다. 바이트코드로 보면 `enum Grade`는 `java.lang.Enum`을 상속한 클래스로 컴파일되고, `BASIC`·`VIP` 같은 상수는 그 클래스의 `public static final` 필드에 담긴 **인스턴스**이며, 상수별로 `{ ... }` 블록을 달면 그 상수만의 **익명 하위 클래스**(`Grade$1`)가 실제로 만들어진다. 클래스이므로 필드·생성자·메서드를 가질 수 있고, 상수마다 메서드를 다르게 구현할 수 있다 — "enum 안에 로직을 넣는다"는 말이 자연스러워지는 근거가 이것이다. 여기서 두 패턴이 나온다. **패턴 ① 전략 메서드 보유**는 상수마다 갈리는 동작을 `switch` 대신 추상 메서드 + 상수별 구현으로 옮기는 것인데, 진짜 이득은 코드가 짧아지는 것이 아니라 **새 상수를 추가할 때 구현 누락을 컴파일러가 잡아준다**는 데 있다 — 흩어진 `switch`를 하나 빼먹어 런타임에 조용히 잘못된 분기로 흘러가는 산탄 수술(shotgun surgery)이 구조적으로 불가능해진다. **패턴 ② 허용 상태 전이**는 "어느 상태에서 어디로 갈 수 있는가"의 표를 enum이 직접 소유하게 해 코드가 곧 상태 전이 다이어그램이 되게 하는 것이다. 여기서 초기화 순서가 함정이 되는데 — enum 상수는 클래스 초기화(`static` 블록)에서 선언 순서대로 만들어지므로 **생성자에서 아직 만들어지지 않은 뒤쪽 상수나 정적 필드를 건드리면 컴파일 에러이고, 정적 메서드를 한 단계 끼워 그 검사를 우회하면 `ExceptionInInitializerError`를 감싼 `NullPointerException`으로 터진다.** 마지막으로 DB 저장에서 `ordinal()`은 절대 쓰지 않는다. 상수 순서를 바꾸거나 중간에 하나 끼워 넣는 순간 저장된 모든 행의 의미가 통째로 밀리기 때문이다.**

---

## 0. 질문 + 의도

**질문**: "enum을 단순 상수 집합 이상으로 활용하는 패턴(전략 메서드 보유, 허용 상태 전이 정의)을 설명해주세요."

**출제 의도**: enum을 상수 나열로만 쓰는 사람과 동작(전략 메서드)·허용 전이(상태 머신)를 타입에 싣는 사람은 코드 전반의 분기문 산탄(if-else 산재) 양이 다르다. "타입 시스템에 규칙을 실어 컴파일러가 지키게 한다"는 사고를 Java에서 실천할 수 있는지 — Kotlin sealed class 문항과 같은 사고의 Java 판.

## 1. 전제 — enum은 클래스다

### 1-1. 전제 지식 — enum 이전에는 무엇을 썼고 왜 위험했나

enum이 없던 시절, "값이 몇 가지로 정해져 있는 것"은 `int` 상수로 표현했다.

```java
public static final int GRADE_BASIC = 0;
public static final int GRADE_VIP   = 1;
public static final int GRADE_VVIP  = 2;

public BigDecimal discount(int grade, BigDecimal price) { ... }
```

이 방식의 문제는 **타입이 `int`라는 것**이다. `discount(999, price)`도, `discount(userId, price)`도 컴파일이 된다. 등급 자리에 회원 번호를 넣는 실수를 컴파일러가 잡아 줄 방법이 없다. 값을 출력해도 `1`이라고만 나와서 로그를 봐도 무슨 뜻인지 모른다.

enum은 이 문제를 **"등급은 등급 타입이다"**라고 선언해서 푼다. `discount(Grade.VIP, price)`만 컴파일되고, 다른 어떤 값도 그 자리에 못 들어간다. 여기까지가 대부분이 아는 enum의 용도 — **타입 안전한 상수 집합**이다.

그런데 이 문서가 다루는 두 패턴은 그 다음 사실에서 나온다.

### 1-2. 상수 하나하나가 그 타입의 인스턴스다

**enum은 문법 설탕이 아니라 진짜 클래스로 컴파일된다.** 컴파일 결과를 직접 열어 보면 분명하다.

```java
public enum Simple { A, B }
```

```text
$ javap -p Simple.class

public final class Simple extends java.lang.Enum<Simple> {
  public static final Simple A;          <- 상수는 Simple 타입의 인스턴스다
  public static final Simple B;
  private static final Simple[] $VALUES;
  public static Simple[] values();
  public static Simple valueOf(java.lang.String);
  private Simple();                      <- 생성자는 private이다
  static {};                             <- 여기서 A와 B가 만들어진다
}
```

여기서 세 가지를 읽어야 한다.

**첫째, `enum Simple`은 `java.lang.Enum`을 상속한 클래스다.** 그래서 `name()`, `ordinal()`, `compareTo()`, `equals()` 같은 메서드가 이미 붙어 있다. 그리고 이미 `Enum`을 상속하고 있으므로 **enum은 다른 클래스를 상속할 수 없다** — 단일 상속 슬롯이 이미 소비된 상태다. (인터페이스 구현은 자유롭다. 2-5에서 쓴다.)

**둘째, `A`와 `B`는 `public static final Simple` 필드다.** 즉 상수처럼 보이지만 실체는 **그 클래스의 인스턴스**이고, 각각 딱 하나만 존재한다. JVM이 클래스를 로딩할 때 한 번 만들고 그 뒤로는 절대 새로 만들지 않으므로, 상수 하나하나가 **싱글턴**이다. `==` 비교가 안전한 이유가 이것이다.

**셋째, 생성자가 `private`이고, 인스턴스는 `static {}` 블록 안에서 만들어진다.** `static {}`은 **클래스가 처음 사용될 때 JVM이 딱 한 번 실행하는 초기화 블록**이다. 이 사실이 §3-4의 함정으로 이어진다.

### 1-3. 클래스이므로 필드·생성자·메서드를 가질 수 있다

인스턴스라면 자기 상태를 가질 수 있다. 상수마다 다른 값을 들려 보내려면 생성자에 넘기면 된다.

```java
public enum Grade {
    BASIC(0), VIP(5), VVIP(10);   // 괄호 안이 생성자 인자다. 각각이 Grade의 인스턴스가 된다

    private final int discountRate;   // 상수마다 다른 값을 담는 인스턴스 필드

    // 생성자는 항상 private이다. 밖에서 Grade를 새로 만들 수 없으므로
    // "이 타입의 인스턴스는 선언된 세 개가 전부"라는 것이 언어 차원에서 보장된다.
    Grade(int discountRate) {
        this.discountRate = discountRate;
    }

    public int discountRate() {
        return discountRate;
    }
}
```

`Grade.VIP.discountRate()`가 자연스럽게 읽히는 이유는 **`VIP`가 값이 아니라 객체이기 때문**이다. "VIP에게 물어보니 할인율이 5라고 답한다"는 구조다.

### 1-4. 상수별 클래스 바디 = 익명 하위 클래스

한 걸음 더 나가면, **상수마다 메서드를 다르게 구현할 수도 있다.** 상수 뒤에 `{ ... }` 블록을 붙이면 된다. 이것을 **상수별 클래스 바디(constant-specific class body)**라고 부른다.

```java
public enum Grade {
    BASIC { public int rate() { return 0;  } },
    VIP   { public int rate() { return 5;  } },
    VVIP  { public int rate() { return 10; } };

    public abstract int rate();
}
```

문법이 낯설어 보이지만, 컴파일 결과를 보면 무슨 일이 일어나는지 정확히 드러난다.

```text
$ javac Grade.java && ls *.class
Grade$1.class  Grade$2.class  Grade$3.class  Grade.class

$ javap -p Grade.class
public abstract class Grade extends java.lang.Enum<Grade> {   <- abstract가 됐다
  public static final Grade BASIC;
  ...
  public abstract int rate();
}

$ javap -p 'Grade$1.class'
final class Grade$1 extends Grade {     <- BASIC 전용 익명 하위 클래스
  public int rate();
}
```

**상수별 바디를 쓰면 enum 자신은 `abstract` 클래스가 되고, 상수마다 그것을 상속한 익명 하위 클래스가 하나씩 만들어진다.** `BASIC`은 `Grade` 타입이 아니라 정확히는 `Grade$1` 인스턴스다.

(1-2에서 상수별 바디가 없는 `Simple`은 `public final class`였던 것과 대비된다. 바디가 하나라도 있으면 `final`이 풀리고 `abstract`가 붙는다.)

**이 사실을 알고 나면 "enum 안에 로직을 넣는다"는 말이 전혀 이상하지 않다.** 그것은 특별한 문법이 아니라 그냥 **다형성**이다. 상위 타입(`Grade`)이 추상 메서드를 선언하고, 하위 클래스(각 상수)가 그것을 다르게 구현하는, 자바에서 매일 쓰는 그 구조다. 다만 하위 클래스의 개수와 인스턴스가 컴파일 타임에 고정돼 있을 뿐이다.

아래 두 패턴은 이 다형성을 각각 **동작**과 **규칙**에 적용한 것이다.

## 2. 패턴 ① 전략 메서드 보유 — 분기문을 타입 안으로

### 2-1. 먼저 문제를 정의하자 — 산탄 수술이란

`switch`가 나쁘다는 말부터 하면 안 된다. 문제는 `switch` 자체가 아니라 **그것이 번지는 방식**이다.

등급별 할인율이 필요해서 `switch`를 하나 썼다고 하자. 얼마 뒤 등급별 적립률이 필요해져 또 하나, 등급별 무료배송 기준에 또 하나, 등급 표시 색상에 또 하나. **같은 모양의 `switch`가 코드베이스 곳곳에 흩어진다.**

이제 `GOLD` 등급을 추가한다. 고쳐야 할 곳은 한 군데가 아니라 **그 흩어진 `switch` 전부**다. 어디에 몇 개가 있는지 아는 사람은 없다.

이렇게 **하나의 개념적 변경을 반영하려면 여러 곳을 흩어서 고쳐야 하는 구조**를 산탄총으로 쏜 자국 같다고 해서 **산탄 수술(shotgun surgery)**이라 부른다. 문제의 본질은 손이 많이 가는 것이 아니라 **하나를 빠뜨렸을 때 아무도 모른다**는 것이다.

```java
// Before: 할인 계산이 서비스 코드에 switch로 존재한다
public BigDecimal discount(Grade grade, BigDecimal price) {
    switch (grade) {
        case BASIC: return BigDecimal.ZERO;
        case VIP:   return price.multiply(new BigDecimal("0.05"));
        case VVIP:  return price.multiply(new BigDecimal("0.10"));
        default:    throw new IllegalStateException();   // 방어 코드까지 필요하다
    }
}
```

`GOLD`를 추가하고 이 메서드를 고치는 것을 잊으면 어떻게 되는가. **컴파일은 성공한다.** `default` 절이 있으니 문법적으로 완전하기 때문이다. 그리고 `GOLD` 회원이 처음 결제하는 순간 `IllegalStateException`이 터진다. `default`에 예외 대신 `return BigDecimal.ZERO`를 써 뒀다면 예외조차 안 나고 **할인이 조용히 0원으로 계산된다.**

**컴파일러는 아무 말도 하지 않았고, 규칙을 지키는 책임은 전적으로 사람의 기억에 있었다.** 이것이 고쳐야 할 지점이다.

### 2-2. 전략 메서드로 옮긴다 — 누락이 컴파일 에러가 된다

동작을 enum 안으로 가져오면 구조가 뒤집힌다.

```java
// After: 추상 메서드 + 상수별 구현
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

    // 이 한 줄이 "모든 상수는 자기 할인 규칙을 반드시 갖는다"는 계약이 된다
    public abstract BigDecimal discount(BigDecimal price);
}
```

```java
// 호출부: 분기가 통째로 사라진다
BigDecimal discounted = price.subtract(member.getGrade().discount(price));
```

### 2-3. 왜 "컴파일러가 잡아준다"가 결정적인 이득인가

이제 `GOLD`를 추가해 보자.

```java
public enum Grade {
    BASIC { ... }, VIP { ... }, VVIP { ... },
    GOLD;                                        // 바디 없이 추가했다

    public abstract BigDecimal discount(BigDecimal price);
}
// error: Grade is abstract; cannot be instantiated
```

바디를 열어 두고 메서드를 안 채워도 마찬가지다. 이때는 1-4에서 본 익명 하위 클래스가 에러 메시지에 그대로 등장한다.

```java
    GOLD { };
// error: <anonymous Grade$4> is not abstract and does not override
//        abstract method discount(BigDecimal) in Grade
```

**어느 쪽이든 컴파일이 안 된다.** 상수를 추가한 그 자리에서, 그것도 커밋하기도 전에 막힌다.

차이를 정리하면 이렇다.

| | `switch` 방식 | 전략 메서드 방식 |
|---|---|---|
| 로직이 사는 곳 | enum 밖, 여러 곳에 복제 | enum 안, 상수 옆에 한 벌 |
| 상수 추가 시 누락하면 | 컴파일 성공 → 런타임에 드러남 | 컴파일 에러 → 그 자리에서 막힘 |
| 누락을 막는 주체 | 사람의 기억과 리뷰 | 컴파일러 |

**이것이 이 패턴의 본질이다. 코드가 짧아지는 것이 아니라, 지켜야 할 규칙을 문서와 기억에서 꺼내 타입 시스템에 실어 컴파일러가 대신 지키게 만드는 것이다.** 사람은 잊지만 컴파일러는 잊지 않는다.

### 2-4. 최신 switch 식과의 균형 잡힌 비교

여기서 "그럼 `switch`는 언제나 나쁜가"라고 물으면 답은 "아니다"다. 최신 자바의 **switch 식**(화살표 문법)은 `default` 없이 쓰면 **완전성 검사(exhaustiveness check)**를 해준다. enum 상수를 하나라도 안 다루면 컴파일 에러다.

```java
static int rate(Grade g) {
    return switch (g) {          // default를 쓰지 않았다
        case BASIC -> 0;
        case VIP   -> 5;
    };
}
// error: the switch expression does not cover all possible input values
```

그러니 판단 기준은 이렇게 잡는다.

- **그 분기가 한 곳에만 있고 앞으로도 그럴 것 같다** → switch 식으로 충분하다. `default`를 쓰지 않아 완전성 검사가 살아 있게만 하면 된다.
- **같은 축의 분기가 둘 이상 생겼다** → enum 안으로 옮긴다. 여기서부터 산탄 수술이 시작되기 때문이다.

**주의할 점은 `default`를 쓰는 순간 완전성 검사가 꺼진다는 것**이다. "혹시 모르니 `default`도 넣자"는 습관이 컴파일러의 도움을 스스로 반납하는 행위가 된다.

### 2-5. 로직이 가벼우면 함수형 필드로 (가산점 포인트)

상수별 바디는 상수마다 익명 하위 클래스를 만들어 내므로(1-4) 코드가 길어진다. 로직이 한 줄짜리라면 **동작 자체를 필드에 담는** 방식이 더 짧다.

```java
public enum Operation {
    PLUS ((a, b) -> a + b),
    MINUS((a, b) -> a - b);

    private final IntBinaryOperator op;   // 동작을 값으로 들고 있는다

    Operation(IntBinaryOperator op) {
        this.op = op;
    }

    public int apply(int a, int b) {
        return op.applyAsInt(a, b);
    }
}
```

이 방식도 **새 상수를 추가하면 생성자 인자를 반드시 넘겨야 하므로 누락은 여전히 컴파일 에러**다. 다만 상수별 바디와 달리 `protected` 헬퍼를 공유한다든가 여러 메서드를 상수마다 다르게 구현한다든가 하는 것은 어려우므로, **한 줄짜리 동작 하나면 함수형 필드, 로직이 여러 줄이거나 메서드가 여럿이면 상수별 바디**로 가른다.

### 2-6. enum은 인터페이스를 구현할 수 있다

1-2에서 본 대로 enum은 이미 `java.lang.Enum`을 상속하고 있어 다른 클래스는 상속할 수 없다. 하지만 **인터페이스 구현에는 제약이 없다.**

```java
public interface DiscountPolicy {
    BigDecimal discount(BigDecimal price);
}

public enum Grade implements DiscountPolicy { ... }
public enum Coupon implements DiscountPolicy { ... }

// 호출부는 Grade인지 Coupon인지 모른 채 같은 방식으로 다룬다
List<DiscountPolicy> policies = List.of(member.getGrade(), order.getCoupon());
```

**서로 다른 enum들을 하나의 상위 타입으로 묶어 다형적으로 다룰 수 있다**는 뜻이다. 상수 집합을 확장할 수는 없어도(enum은 상속으로 늘릴 수 없다), 여러 enum이 같은 계약을 구현하게 해서 계약 단위의 확장은 열 수 있다.

## 3. 패턴 ② 허용 상태 전이 — 그리고 enum을 실무에 얹을 때의 경계

### 3-1. 먼저 규칙을 그림으로 확정한다

주문 상태처럼 "어떤 상태에서 어떤 상태로만 갈 수 있다"는 규칙이 있는 도메인을 생각하자. 이런 규칙의 집합을 **상태 머신(state machine)**이라 하고, 그것을 그린 것이 **상태 전이 다이어그램**이다.

```text
                    [CREATED]
                    /        \
              결제 완료        취소
                  /            \
            [PAID] ---취소---> [CANCELED]   (종착)
               |
             출고
               |
           [SHIPPED]
               |
            배송 완료
               |
          [DELIVERED]                        (종착)
```

같은 규칙을 표로 옮기면 이렇다.

| 현재 상태 | 갈 수 있는 다음 상태 |
|---|---|
| CREATED | PAID, CANCELED |
| PAID | SHIPPED, CANCELED |
| SHIPPED | DELIVERED |
| DELIVERED | (없음 — 종착) |
| CANCELED | (없음 — 종착) |

여기서 **표에 없는 전이는 전부 금지**다. `SHIPPED → CANCELED`가 없다는 것은 "이미 출고된 주문은 취소할 수 없다"는 정책이고, `DELIVERED → PAID`가 없다는 것은 상태가 거꾸로 갈 수 없다는 뜻이다.

문제는 **이 표가 어디에 사는가**다.

### 3-2. Before — 전이 규칙이 서비스 코드에 흩어진다

```java
public void cancel(Order order) {
    // 취소 가능 상태 검사를 이 메서드가 직접 알고 있다
    if (order.getStatus() == OrderStatus.PAID
            || order.getStatus() == OrderStatus.CREATED) {
        order.setStatus(OrderStatus.CANCELED);
    }
}
```

`ship()`, `deliver()`, `refund()`에도 같은 성격의 `if`가 하나씩 생긴다. **표가 코드베이스에 흩어져 있고, 어디에도 표 전체가 보이는 곳이 없다.** 2-1의 산탄 수술이 이번에는 분기가 아니라 규칙에서 재현된 것이다.

그리고 실패 방식이 더 나쁘다. 위 코드는 조건에 안 맞으면 **아무 일도 안 하고 조용히 끝난다.** 호출한 쪽은 취소가 된 줄 알고 다음 단계로 넘어간다.

### 3-3. After — 전이 규칙을 enum이 소유한다

허용 전이 집합을 enum이 직접 들고 있게 만든다.

```java
public enum OrderStatus {
    CREATED, PAID, SHIPPED, DELIVERED, CANCELED;

    private Set<OrderStatus> allowedNext;   // 이 상태에서 갈 수 있는 다음 상태들

    static {
        // 왜 생성자가 아니라 static 블록인지는 3-4에서 다룬다
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
```

```java
// 도메인 객체는 전이할 때 이 관문 하나만 통과시킨다
public void changeStatus(OrderStatus next) {
    if (!status.canTransitionTo(next)) {
        // 조용히 무시하지 않고 예외로 드러낸다.
        // 허용되지 않은 전이를 시도했다는 것은 호출부에 버그가 있다는 뜻이므로,
        // 아무 일도 안 하고 넘어가면 그 버그가 영영 안 보인다.
        throw new IllegalStateException(
            "허용되지 않는 상태 전이: " + status + " -> " + next);
    }
    this.status = next;
}
```

**얻는 것이 셋이다.** 규칙이 한곳에 표로 모여 있으므로 정책이 바뀌면 여기만 고치고, 그 코드 블록 자체가 3-1의 다이어그램 역할을 하는 살아 있는 문서가 되며, 위반이 조용한 무시가 아니라 예외로 드러난다.

**`EnumSet`을 쓴 이유**도 짚어 두자. `EnumSet`은 **enum 전용 Set 구현체**로, 내부적으로 각 상수를 비트 하나에 대응시킨 **비트 벡터**로 원소를 표현한다(상수가 64개 이하면 `long` 하나로 끝난다). 그래서 `contains`가 비트 연산 한 번이고, `HashSet`처럼 해시 계산이나 버킷 탐색이 없다. enum을 키로 쓰는 Map에는 같은 이유로 `EnumMap`이 우선이다 (가산점 포인트).

### 3-4. 왜 생성자가 아니라 static 블록인가 — 초기화 순서의 함정

여기가 이 패턴에서 가장 자주 막히는 지점이다. **왜 전이 규칙을 생성자에서 넘겨받지 않는가?**

1-2에서 본 사실을 다시 꺼내야 한다. **enum 상수는 클래스 초기화 시점의 `static {}` 안에서 위에서 아래로 하나씩 만들어진다.** 그러니 `CREATED`의 생성자가 도는 시점에는 `PAID`가 **아직 존재하지 않는다.**

자바는 이 상황을 두 가지 방식으로 막는다. **실제로 컴파일해 보면 정확히 이런 메시지가 나온다.**

**(1) 생성자 인자로 다른 상수를 넘기면 — `illegal forward reference`**

```java
public enum T2 {
    CREATED(PAID),      // 아직 만들어지지 않은 PAID를 참조한다
    PAID();
    private final T2 next;
    T2(T2... next) { ... }
}
// error: illegal forward reference
```

**(2) 생성자 본문에서 상수(정적 필드)를 읽으면 — `illegal reference to static field from initializer`**

```java
public enum T1 {
    CREATED, PAID, SHIPPED;
    private final Set<T1> allowedNext;
    T1() {
        this.allowedNext = EnumSet.of(PAID);   // 생성자 안에서 정적 필드를 읽는다
    }
}
// error: illegal reference to static field from initializer
```

**둘 다 컴파일 에러다.** 자바 언어 명세가 enum의 생성자·인스턴스 초기화 블록에서 정적 필드에 접근하는 것을 아예 금지해 두었기 때문이다. 그래서 **이 실수는 런타임까지 가지 않는다.**

**다만 우회 경로가 하나 열려 있고, 그쪽으로 가면 런타임에 터진다.** 정적 필드를 직접 읽는 대신 정적 **메서드**를 호출하면 컴파일러의 검사를 통과한다.

```java
public enum T4 {                                               // 1
    A, B;                                                      // 2
    private static final Map<String, T4> INDEX = new HashMap<>();  // 3
                                                               // 4
    T4() { register(this); }                                   // 5  컴파일은 된다
    private static void register(T4 v) { INDEX.put(v.name(), v); } // 6
}
```

```text
$ java T4
Exception in thread "main" java.lang.ExceptionInInitializerError
Caused by: java.lang.NullPointerException:
    Cannot invoke "java.util.Map.put(Object, Object)" because "T4.INDEX" is null
	at T4.register(T4.java:6)
	at T4.<init>(T4.java:5)
	at T4.<clinit>(T4.java:3)
```

스택트레이스를 아래에서 위로 읽으면 순서가 그대로 보인다. `<clinit>`(클래스 초기화)이 시작 → 상수 `A`의 생성자 `<init>` 실행 → `register` 호출 → **그런데 `INDEX = new HashMap<>()` 줄은 상수 생성 다음에 있으므로 아직 `null`.** 상수가 정적 필드보다 **먼저** 초기화된다는 것이 이 에러가 알려 주는 사실이다.

그리고 `ExceptionInInitializerError`는 **클래스 초기화 중에 예외가 났다**는 뜻인데, 이게 특히 고약하다. 한번 초기화에 실패한 클래스는 그 뒤로 접근할 때마다 `NoClassDefFoundError`를 던져서, **처음 한 번만 진짜 원인이 찍히고 그 뒤로는 원인이 안 보이는 로그**가 남는다.

**결론: 상수들 사이의 관계는 모든 상수 생성이 끝난 뒤인 `static` 블록에서 연결한다.** 이걸 근거까지 설명할 수 있으면 실제로 만들어 본 사람이라는 신호가 된다.

### 3-5. 한 걸음 더 — 전이 규칙도 컴파일러가 강제하게 만들기 (가산점 포인트)

3-3의 `static` 블록 방식에는 약점이 하나 있다. **새 상태를 추가했을 때 `static` 블록에 그 상태의 줄을 넣는 것을 잊어도 컴파일이 된다.** 그러면 `allowedNext`가 `null`인 상수가 생기고, 그 상태에서 전이를 시도하는 순간 `NullPointerException`이 난다. 패턴 ①에서 얻었던 "컴파일러가 누락을 잡아준다"는 이득이 여기서는 빠져 있는 것이다.

패턴 ①의 방식을 그대로 가져오면 이 약점이 사라진다. **전이 집합을 필드가 아니라 추상 메서드로 선언하는 것**이다.

```java
public enum OrderStatus {
    CREATED   { public Set<OrderStatus> allowedNext() { return EnumSet.of(PAID, CANCELED); } },
    PAID      { public Set<OrderStatus> allowedNext() { return EnumSet.of(SHIPPED, CANCELED); } },
    SHIPPED   { public Set<OrderStatus> allowedNext() { return EnumSet.of(DELIVERED); } },
    DELIVERED { public Set<OrderStatus> allowedNext() { return EnumSet.noneOf(OrderStatus.class); } },
    CANCELED  { public Set<OrderStatus> allowedNext() { return EnumSet.noneOf(OrderStatus.class); } };

    public abstract Set<OrderStatus> allowedNext();

    public boolean canTransitionTo(OrderStatus next) {
        return allowedNext().contains(next);
    }
}
```

**메서드 본문 안에서는 다른 상수를 참조해도 된다.** 3-4의 제약은 "생성자와 인스턴스 초기화 시점"에 걸리는 것인데, 이 메서드는 클래스 초기화가 전부 끝난 뒤 호출되는 시점에 실행되기 때문이다.

이제 상수를 추가하면 `allowedNext()` 구현이 없다는 컴파일 에러가 난다. 대신 상수마다 익명 하위 클래스가 생기고(1-4) 호출할 때마다 `EnumSet`을 새로 만든다는 비용이 붙으므로, **호출 빈도가 아주 높다면 `static` 블록 방식으로 미리 만들어 두는 쪽이 낫다.** 어느 쪽을 고르든 트레이드오프를 알고 고르면 된다.

### 3-6. DB에 저장할 때 — `ordinal()`은 왜 위험한가

enum을 DB에 저장하는 방법은 크게 둘이다. **선언 순서를 나타내는 정수**(`ordinal()`)를 저장하거나, **상수 이름 문자열**(`name()`)을 저장하거나.

**JPA의 기본값이 순서 정수라는 점부터 알아야 한다.** `@Enumerated`를 안 붙이거나 그냥 붙이면 `EnumType.ORDINAL`이다. 즉 아무 생각 없이 매핑하면 위험한 쪽이 선택된다.

무엇이 위험한지 실제 데이터로 보자.

```text
[v1 — 최초 배포]

public enum OrderStatus { CREATED, PAID, SHIPPED }
                             0       1       2

order 테이블에 저장된 값
  id | status
  ---+--------
   1 |   0        CREATED
   2 |   1        PAID
   3 |   2        SHIPPED
```

이제 결제 대기 상태가 필요해져서 `CREATED` 다음에 `PAYMENT_PENDING`을 끼워 넣는다. **enum 선언 한 줄을 추가했을 뿐이고, DB는 한 행도 건드리지 않았다.**

```text
[v2 — 상수를 중간에 추가]

public enum OrderStatus { CREATED, PAYMENT_PENDING, PAID, SHIPPED }
                             0            1           2       3

같은 데이터를 v2 코드로 다시 읽으면
  id | 저장된 값 | v1에서의 의미 | v2에서 읽히는 값
  ---+----------+--------------+-------------------
   1 |    0     | CREATED      | CREATED           (우연히 일치)
   2 |    1     | PAID         | PAYMENT_PENDING   <- 결제 완료가 결제 대기로 바뀐다
   3 |    2     | SHIPPED      | PAID              <- 출고된 주문이 결제 완료로 바뀐다
```

**결제가 끝난 주문이 결제 대기가 되고, 이미 출고된 주문이 결제 완료 상태로 되돌아간다.** 배송 상태가 뒤로 밀렸으니 배치가 다시 출고를 걸 수도 있다. 그런데 **예외는 하나도 나지 않는다.** 값이 유효 범위 안에 있으니 JPA가 문제 삼을 이유가 없다.

`ordinal()`의 진짜 문제는 "순서가 바뀌면 틀린다"가 아니라 **"틀렸다는 사실이 어디에도 드러나지 않는다"**는 것이다. 그리고 상수를 중간에 추가하는 것은 언제든 자연스럽게 일어나는 일이라, 이 사고는 **평범한 기능 추가 커밋에서 발생한다.**

**대응은 두 단계다.**

**(1) 기본은 문자열 저장.** JPA라면 `@Enumerated(EnumType.STRING)`을 명시한다. 순서를 어떻게 바꾸든 `"PAID"`는 `PAID`다. DB를 직접 조회했을 때 의미가 읽힌다는 부수 효과도 크다.

```java
@Enumerated(EnumType.STRING)   // 이 한 줄을 빼먹으면 기본값인 ORDINAL이 된다
@Column(length = 20, nullable = false)
private OrderStatus status;
```

**(2) 이름 변경까지 견디려면 별도 코드값 필드를 둔다.** 문자열 저장은 순서 변경에는 안전하지만 **상수 이름을 리팩터링하면 깨진다.** `CANCELED`를 `CANCELLED`로 고치는 순간 기존 데이터를 못 읽는다. 그래서 저장용 코드값을 enum이 따로 들고, 변환기(`AttributeConverter`)로 매핑한다.

```java
public enum OrderStatus {
    CREATED("C"), PAID("P"), SHIPPED("S"), DELIVERED("D"), CANCELED("X");

    private final String code;   // DB에 저장되는 값. 상수 이름과 분리돼 있다

    OrderStatus(String code) { this.code = code; }

    public String code() { return code; }

    public static OrderStatus from(String code) {
        return Arrays.stream(values())
                     .filter(s -> s.code.equals(code))
                     .findFirst()
                     .orElseThrow(() -> new IllegalArgumentException("알 수 없는 코드: " + code));
    }
}
```

**이렇게 하면 저장된 값과 코드의 이름이 분리되므로, 상수 이름은 리팩터링해도 DB는 안 건드린다.** 저장 값과 코드의 결합을 한곳에서 통제할 수 있다는 것이 이 방식의 값이다 (가산점 포인트).

### 3-7. enum에 로직을 넣는 것이 과해지는 지점

지금까지 "enum 안으로 옮겨라"라고 말했지만, **여기에는 분명한 상한선이 있다.** 이 선을 아는 것이 패턴을 아는 것보다 중요하다.

**경계 ①: 도메인 의존성이 enum으로 역류하기 시작할 때.**

enum 상수는 JVM이 클래스 로딩 시점에 만드는 싱글턴이다(1-2). 그래서 **스프링 컨테이너가 관여할 여지가 없다** — 리포지토리나 외부 API 클라이언트를 주입받을 방법이 없다.

로직이 DB 조회나 외부 호출을 필요로 하는 순간 enum은 자리를 내줘야 한다. 이때 흔히 나오는 회피책이 **정적 홀더에 빈을 넣어 두고 enum이 그것을 꺼내 쓰는 것**인데, 이건 의존성을 숨긴 전역 상태라 테스트에서 갈아 끼울 수 없고 초기화 순서에도 취약하다. 옳은 방향은 전략을 **스프링 빈**으로 옮기는 것이다.

```java
// enum은 "무엇인지"만 남기고, "어떻게 하는지"는 빈으로 나간다
public interface DiscountPolicy {
    BigDecimal discount(Member member, BigDecimal price);
}

@Service
public class DiscountService {
    // enum을 키로 쓰는 전략 맵. 스프링이 구현체들을 모아 넣어 준다.
    private final Map<Grade, DiscountPolicy> policies;

    public BigDecimal discount(Member member, BigDecimal price) {
        return policies.get(member.getGrade()).discount(member, price);
    }
}
```

**enum이 사라지는 것이 아니라 "식별자" 역할로 돌아가는 것**이 요점이다.

**경계 ②: 상수마다 로직이 크게 갈려 테스트가 어려워질 때.**

상수별 바디가 몇십 줄씩 자라기 시작하면 문제가 생긴다. 상수는 인스턴스를 새로 만들 수 없으므로 **테스트에서 상태를 주입하거나 협력 객체를 대역으로 바꿔 끼울 수 없다.** 결국 `Grade.VVIP.discount(...)`처럼 실제 상수를 그대로 불러 결과만 검증하게 되고, 로직이 커질수록 준비할 수 있는 조건이 부족해진다.

**경계 ③: 값이 배포 없이 바뀌어야 할 때.**

할인율 같은 것은 마케팅 판단으로 수시로 바뀐다. enum에 하드코딩하면 **값 하나 바꾸는 데 배포가 필요하다.** 이건 enum의 잘못이 아니라 애초에 코드가 아니라 설정이나 DB에 있어야 할 값을 코드에 둔 것이다.

**세 경계를 한 문장으로 묶으면 이렇다. enum 전략은 "규칙이 타입과 함께 컴파일 타임에 고정되어도 좋은, 외부 의존이 없는 가벼운 로직"까지가 적정선이다.** 이 선을 넘으면 enum은 식별자로 돌아가고 로직은 빈으로 나간다.

## 4. 꼬리질문 대비 포인트

### "switch로도 되는데, 굳이 enum 안에 로직을 넣는 이유는?"

**핵심은 코드 길이가 아니라 누락을 누가 잡아 주느냐다.**

`switch`는 로직이 enum **밖**에 있어서 같은 축의 분기가 여러 곳에 복제된다(할인, 적립, 배송비, 표시 색상...). 상수를 하나 추가할 때 그 흩어진 `switch`를 전부 찾아 고쳐야 하는데, 하나를 빠뜨려도 **컴파일은 성공한다.** `default` 절이 있으니 문법적으로 완전하기 때문이다. 그리고 새 상수가 처음 들어오는 순간 런타임 예외가 나거나, 더 나쁘게는 `default`의 기본값이 조용히 반환된다. 이렇게 하나의 변경을 위해 여러 곳을 흩어서 고쳐야 하는 구조를 **산탄 수술(shotgun surgery)**이라 부른다.

전략 메서드는 상수 추가 시 **구현이 없으면 그 자리에서 컴파일 에러**다. 규칙을 지키는 책임이 사람의 기억에서 컴파일러로 옮겨 간다.

**균형 잡힌 마무리까지 붙이면 좋다.** 최신 자바의 switch 식(화살표 문법)은 `default` 없이 쓰면 enum 상수를 전부 다루는지 컴파일러가 검사해 주므로, **한 곳에서만 쓰는 분기라면 switch 식도 충분히 좋은 선택**이다. 다만 `default`를 넣는 순간 그 검사가 꺼진다는 점, 그리고 같은 축의 분기가 두 번째로 생기는 순간이 enum으로 옮길 신호라는 점까지 말하면 정리가 깔끔하다.

### "상태 전이 정의에서 왜 생성자가 아니라 static 블록을 썼나요?"

**enum 상수가 만들어지는 시점 때문이다.**

enum 상수는 클래스 초기화(`static {}`) 안에서 선언 순서대로 하나씩 생성된다. 그래서 `CREATED`의 생성자가 도는 시점에는 `PAID`가 아직 존재하지 않는다. 자바는 이 상황을 컴파일 단계에서 금지한다 — 생성자 인자로 뒤의 상수를 넘기면 `illegal forward reference`, 생성자 본문에서 상수(정적 필드)를 읽으면 `illegal reference to static field from initializer`가 난다.

**"그래서 런타임 NPE가 난다"고 답하면 부정확하다는 점을 짚어 두면 좋다** — 직접 참조는 컴파일러가 막으므로 런타임까지 가지 않는다. 다만 **정적 메서드를 한 단계 끼워 우회하면 컴파일러 검사를 통과하고, 그때는 `ExceptionInInitializerError`로 감싸인 `NullPointerException`이 난다.** 상수가 정적 필드보다 먼저 초기화되기 때문이다. 한번 초기화에 실패한 클래스는 이후 접근마다 `NoClassDefFoundError`를 던져서 진짜 원인이 처음 한 번만 로그에 남는다는 점도 알아 두면 좋다.

**결론은 "상수들 사이의 관계는 모든 상수 생성이 끝난 뒤인 `static` 블록에서 연결한다"**이고, 한 걸음 더 나가면 **추상 메서드로 선언해 상수별 바디에서 반환하는 방식**도 있다 — 메서드 본문은 클래스 초기화가 끝난 뒤 실행되므로 다른 상수를 자유롭게 참조할 수 있고, 새 상태 추가 시 구현 누락을 컴파일러가 잡아 준다는 이점까지 붙는다.

### "enum을 DB에 저장할 때는 어떻게 하나요? ordinal 저장의 위험은?"

**`ordinal()` 저장은 상수 순서를 바꾸거나 중간에 하나 추가하는 순간 기존 데이터 전체의 의미가 밀린다.**

`{CREATED, PAID, SHIPPED}` 상태에서 `1`로 저장된 행은 `PAID`인데, `CREATED` 다음에 `PAYMENT_PENDING`을 끼워 넣으면 같은 `1`이 `PAYMENT_PENDING`으로 읽힌다. **결제 완료된 주문이 결제 대기가 되고 출고된 주문이 결제 완료로 되돌아가는데, DB는 한 행도 안 바뀌었고 예외도 나지 않는다.** 값이 유효 범위 안이라 아무도 문제를 못 느낀다.

**JPA의 기본값이 `EnumType.ORDINAL`이라는 점을 반드시 언급해야 한다.** `@Enumerated`를 생략하거나 그냥 붙이면 위험한 쪽이 선택되므로, `@Enumerated(EnumType.STRING)`을 명시하는 것이 원칙이다.

**한 단계 더 들어가면** 문자열 저장도 완전하지 않다 — **상수 이름을 리팩터링하면 기존 데이터를 못 읽는다.** 그래서 enum에 저장용 코드값 필드(`CREATED("C")`)를 따로 두고 `AttributeConverter`로 매핑하면, 상수 이름과 저장 값이 분리되어 이름 변경에도 안전해진다. 저장 값과 코드의 결합을 한곳에서 통제할 수 있다는 것이 이 방식의 값이다 (가산점 포인트).

### "enum에 로직을 넣는 게 과해지는 지점은 어디인가요?" (시니어 변별 포인트)

**세 가지 경계로 답한다.**

**(1) 도메인 의존성이 enum으로 역류할 때.** enum 상수는 JVM이 클래스 로딩 시점에 만드는 싱글턴이라 스프링 빈(리포지토리, 외부 API 클라이언트)을 주입받을 수 없다. 로직이 DB 조회나 외부 호출을 필요로 하는 순간 enum을 벗어나야 한다. 정적 홀더에 빈을 넣어 두고 enum이 꺼내 쓰는 회피책은 의존성을 숨긴 전역 상태라 테스트에서 갈아 끼울 수 없으므로 답이 아니다. 옳은 방향은 **전략을 빈으로 옮기고 enum은 그 전략을 고르는 키로 되돌리는 것**이다 — `Map<Grade, DiscountPolicy>` 형태.

**(2) 상수마다 로직이 크게 갈려 테스트가 어려워질 때.** 상수는 인스턴스를 새로 만들 수 없으므로 테스트에서 상태를 주입하거나 협력 객체를 대역으로 바꿔 끼울 수 없다. 로직이 커질수록 준비할 수 있는 조건이 모자라진다.

**(3) 값이 배포 없이 바뀌어야 할 때.** 할인율처럼 마케팅 판단으로 수시로 바뀌는 값을 enum에 하드코딩하면 값 하나 바꾸는 데 배포가 필요하다. 이건 애초에 코드가 아니라 설정이나 DB에 있어야 할 값이다.

**한 문장으로 묶으면 — enum 전략은 "규칙이 타입과 함께 컴파일 타임에 고정되어도 좋은, 외부 의존이 없는 가벼운 로직"까지가 적정선이다.**

### "Kotlin이라면 어떻게 풀겠어요?"

**같은 문제를 Kotlin은 `sealed class`/`sealed interface` + `when`의 완전성 검사로 푼다.**

`sealed`는 "이 타입을 상속할 수 있는 하위 타입이 컴파일 타임에 전부 정해져 있다"는 선언이라, `when`에서 하위 타입을 하나라도 빠뜨리면 컴파일 에러가 난다. enum의 추상 메서드가 주는 이득과 정확히 같은 성격이다.

**차이는 상태를 담을 수 있느냐다.** sealed 하위 타입은 각자 다른 필드를 가질 수 있어서 `Canceled(val reason: String)`처럼 그 상태에서만 의미 있는 데이터를 붙일 수 있고, 인스턴스도 여러 개 만들 수 있다. enum 상수는 인스턴스가 하나씩 고정이라 이런 표현이 불가능하다. 반대로 **상태별 데이터가 필요 없다면 Kotlin에서도 enum이 더 간결하다.**

**"둘 다 규칙을 타입 시스템에 실어 컴파일러가 지키게 한다는 점은 같고, 상태별 데이터가 필요한가에서 갈린다"**고 묶어 답하면 출제 의도에 정확히 부합한다.

---

## 한 줄 요약

`enum`은 `java.lang.Enum`을 상속한 **클래스**로 컴파일되고 상수 하나하나가 그 타입의 인스턴스이며 상수별 바디는 실제 익명 하위 클래스가 되므로, "enum 안에 로직을 넣는다"는 것은 특별한 문법이 아니라 그냥 다형성이다 — 그래서 상수마다 갈리는 **동작**은 추상 메서드 + 상수별 구현으로, 상수 사이의 **규칙**(허용 상태 전이)은 enum이 소유한 표로 옮길 수 있고, 이때의 진짜 이득은 코드가 짧아지는 것이 아니라 **흩어진 `switch` 하나를 빠뜨려 런타임에 조용히 틀리는 산탄 수술이 컴파일 에러로 바뀐다**는 데 있다. 다만 세 가지 경계를 알아야 실무가 된다 — 상수는 클래스 초기화 중 생성되므로 **생성자에서 서로를 참조할 수 없고**(직접 참조는 컴파일 에러, 정적 메서드 우회는 `ExceptionInInitializerError`), DB에는 `ordinal()`이 아니라 문자열이나 별도 코드값을 저장해야 하며(순서를 바꾸는 순간 저장된 모든 행의 의미가 소리 없이 밀린다), 외부 의존이 필요해지거나 값이 배포 없이 바뀌어야 하는 순간 enum은 식별자로 돌아가고 로직은 스프링 빈으로 나가야 한다.
