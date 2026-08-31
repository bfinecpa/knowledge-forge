# BigDecimal의 equals vs compareTo — 스케일이 만드는 금액 비교 버그

> 핵심 관전 포인트: **BigDecimal의 `equals`는 값뿐 아니라 스케일(소수점
> 자릿수)까지 같아야 true이고, `compareTo`는 수학적인 값만 비교한다.
> 그래서 `1.0`과 `1.00`은 equals로는 다르고 compareTo로는 같다.
> 금액 비교에서 equals를 쓰면 "같은 금액인데 다르다"고 판단하는 버그가
> 생기고, 특히 HashSet/HashMap 키나 List.contains처럼 equals를 강제로
> 쓰는 자리에서 예외도 없이 조용히 틀어진다.
> 금액 값 비교는 반드시 `compareTo() == 0`을 쓴다.**

---

## 0. 질문 + 의도

**질문**: "`BigDecimal`의 `equals`와 `compareTo`가 다르게 동작하는 경우는?
금액 비교 코드에서 어떤 버그를 만드나요?"

**출제 의도**: 1.0과 1.00이 equals로는 다르고 compareTo로는 같다는 스케일
함정은 "금액 일치 검증이 간헐적으로 실패하는" 재현 어려운 버그를 만든다.
금액을 다루는 타입의 미묘한 규약까지 확인해봤는지 — 부동소수점 금지의
다음 단계 디테일을 아는지를 본다.

## 1. 왜 다르게 동작하는가

BigDecimal은 내부적으로 **unscaledValue(정수) × 10^-scale(자릿수)**
두 값으로 숫자를 표현한다.

```java
new BigDecimal("1.0")    // unscaledValue = 10,  scale = 1
new BigDecimal("1.00")   // unscaledValue = 100, scale = 2
```

수학적으로는 같은 1이지만, **내부 표현이 다르다.**

| 메서드       | 비교 기준                                    | 의미      |
|-----------|------------------------------------------|---------|
| equals    | unscaledValue와 scale이 **둘 다** 같아야 true   | 표현의 동일성 |
| compareTo | 스케일을 맞춰서 **수학적 값만** 비교                   | 값의 동등성  |

```java
BigDecimal a = new BigDecimal("1.0");
BigDecimal b = new BigDecimal("1.00");

a.equals(b);         // false — scale이 1 vs 2로 다름
a.compareTo(b) == 0; // true  — 수학적으로 같은 값
```

이는 `compareTo() == 0 ⟺ equals()`라는 `Comparable` 인터페이스의
**권장 규약을 의도적으로 깬** 드문 표준 클래스다.
(Javadoc에도 "consistent with equals가 아니다"라고 명시 —
꼬리질문 가산점 포인트)

## 2. 스케일이 달라지는 건 생각보다 흔하다

"내 코드에서는 스케일을 통일하니까 괜찮다"고 생각하기 쉽지만,
스케일은 여러 경로로 달라진다.

```java
new BigDecimal("100");            // scale = 0
new BigDecimal("100.00");         // scale = 2  ← DB DECIMAL(19,2) 조회 결과가 보통 이 형태
BigDecimal.valueOf(100L);         // scale = 0
new BigDecimal("50.5").multiply(new BigDecimal("2"));
                                  // 101.0 → scale = 1 (곱셈은 scale 합산)
```

**전형적인 시나리오**: 코드에서 만든 `BigDecimal.valueOf(100)`(scale 0)과
DB에서 읽어온 `100.00`(scale 2)을 비교 — 같은 금액인데 equals는 false.

## 3. 금액 비교에서 생기는 실제 버그

### 버그 ① 직접 비교 — "결제 금액 검증 실패"

```java
// Before: equals 사용 — 버그
BigDecimal requested = new BigDecimal("100");     // 요청 파라미터에서 생성, scale 0
BigDecimal orderAmount = order.getAmount();       // DB DECIMAL(19,2) → 100.00, scale 2

if (!requested.equals(orderAmount)) {
    throw new PaymentAmountMismatchException();   // 같은 금액인데 결제 거절!
}

// After: compareTo 사용 — 정상
if (requested.compareTo(orderAmount) != 0) {
    throw new PaymentAmountMismatchException();
}
```

### 버그 ② 컬렉션 — 조용히 틀어지는 케이스 (더 위험)

HashSet/HashMap/List.contains는 내부적으로 equals(+hashCode)를 쓰기
때문에, compareTo로 바꿔 끼울 방법이 없다.

```java
Set<BigDecimal> paidAmounts = new HashSet<>();
paidAmounts.add(new BigDecimal("100.00"));        // DB에서 온 값

paidAmounts.contains(new BigDecimal("100"));      // false! — 중복 결제 감지 실패
```

- hashCode도 scale을 포함해 계산되므로 HashMap에서는
  **아예 다른 버킷**으로 간다.
- 중복 제거하려고 Set에 넣었는데 `1.0`과 `1.00`이 둘 다 들어가는 식으로,
  **예외도 안 나고 조용히 틀어지는** 게 이 버그의 무서운 점이다.

### 버그 ③ 0 비교

```java
// Before: 잔액이 0인지 검사 — scale에 따라 실패
balance.equals(BigDecimal.ZERO);           // balance가 0.00이면 false (ZERO는 scale 0)

// After
balance.compareTo(BigDecimal.ZERO) == 0;   // 항상 정확
balance.signum() == 0;                     // 더 간결한 대안 (양수 1, 0, 음수 -1)
```

## 4. 실무 방어 전략 (꼬리질문 대비)

1. **값 비교는 항상 `compareTo() == 0`** — 팀 컨벤션/정적 분석
   (ErrorProne의 `BigDecimalEquals`, SonarQube 룰)으로 강제한다.
2. **경계에서 스케일 정규화** — DB 저장/조회, 외부 API 수신 직후
   `setScale(2, RoundingMode.HALF_UP)` 등으로 통일하면
   컬렉션 문제까지 예방된다.
3. **컬렉션 키로 써야 한다면** — 정규화된 스케일로 넣거나,
   `TreeSet`/`TreeMap`(comparator 기반이라 compareTo 사용)을 쓰는
   방법도 있다. 단, "equals와 일관되지 않은 정렬 컬렉션"은 `Set` 규약상
   주의가 필요하다는 점을 언급하면 가산점.
4. **`stripTrailingZeros()`** 로 비교 전 정규화하는 방법도 있으나,
   `100`이 `1E+2`로 표현되는 등 출력 포맷 이슈가 있어
   비교 용도로는 compareTo가 우선이다.

---

## 한 줄 요약

`equals`는 **"표현까지 같은가"**, `compareTo`는 **"값이 같은가"**를 본다.
금액은 값의 문제이므로 `compareTo() == 0`으로 비교하고,
HashSet/HashMap처럼 equals를 강제로 쓰는 자리에는
**스케일을 정규화한 값만** 넣는 것이 원칙이다.
