# BigDecimal의 equals vs compareTo — 스케일이 만드는 금액 비교 버그

> 핵심 관전 포인트: **`BigDecimal`은 숫자를 부호 있는 정수 `unscaledValue`와 소수점 위치 `scale` 두 개로 나눠 담는다 — `1.0`은 `(10, 1)`, `1.00`은 `(100, 2)`라서 수학적으로는 같은 값인데 **객체의 상태가 실제로 다르다.** 그래서 `equals`가 `false`인 것은 버그가 아니라 "필드가 전부 같아야 같다"는 상태 동등성 계약을 그대로 지킨 결과이고, 수학적 값만 견주고 싶으면 스케일을 맞춘 뒤 비교하는 `compareTo`를 써야 한다. 문제는 `hashCode`도 스케일을 반영한다는 것이다 — `1.0`은 311, `1.00`은 3102라서 `HashSet`·`HashMap`에서 아예 다른 버킷으로 가고, 여기서는 `compareTo`를 끼워 넣을 방법조차 없어 **예외 하나 없이 조용히 틀린다.** 그리고 스케일은 생각보다 쉽게 어긋난다 — PostgreSQL `NUMERIC(19,2)` 조회 결과는 scale 2로 오는데 코드에서 만든 `BigDecimal.valueOf(100)`은 scale 0이고, `setScale`·곱셈(스케일 합산)·나눗셈(스케일 뺄셈)이 전부 스케일을 바꾼다. 값 비교는 예외 없이 `compareTo(...) == 0`(0 비교는 `signum() == 0`)으로 하고, 컬렉션에 넣거나 저장할 값은 **경계에서 스케일을 통일**해 문제를 애초에 안 만드는 것이 정공법이다.**

---

## 0. 질문 + 의도

**질문**: "`BigDecimal`의 `equals`와 `compareTo`가 다르게 동작하는 경우는? 금액 비교 코드에서 어떤 버그를 만드나요?"

**출제 의도**: 1.0과 1.00이 equals로는 다르고 compareTo로는 같다는 스케일 함정은 "금액 일치 검증이 간헐적으로 실패하는" 재현 어려운 버그를 만든다. 금액을 다루는 타입의 미묘한 규약까지 확인해봤는지 — 부동소수점 금지의 다음 단계 디테일을 아는지를 본다.

## 1. 왜 다르게 동작하는가

### 1-1. 전제 지식 — BigDecimal은 숫자를 어떻게 들고 있는가

"`equals`가 스케일까지 본다"는 결론부터 외우면 납득이 안 된다. **`BigDecimal`이 내부에 무엇을 들고 있는지**를 먼저 보면 그 결론이 자연스럽게 유도된다.

`double`은 숫자 하나를 부호·지수·가수라는 정해진 비트 묶음에 밀어 넣는다. 그래서 2진수로 딱 떨어지지 않는 `0.1` 같은 값은 애초에 정확히 담기지 않는다. `BigDecimal`은 이 문제를 피하려고 접근을 아예 바꿨다 — **숫자를 두 개의 값으로 나눠 담는다.**

- **`unscaledValue`**: 소수점을 없앤 정수. 자릿수 제한이 없는 `BigInteger`다.
- **`scale`**: 소수점을 왼쪽으로 몇 칸 옮겨야 하는지를 나타내는 정수.

실제 값은 이 둘로 계산된다.

```
값 = unscaledValue × 10^(-scale)
```

숫자 몇 개를 넣어 보면 바로 잡힌다.

```java
new BigDecimal("1.0")   // unscaledValue = 10,  scale = 1   ->  10 × 10^-1 = 1.0
new BigDecimal("1.00")  // unscaledValue = 100, scale = 2   -> 100 × 10^-2 = 1.00
new BigDecimal("100")   // unscaledValue = 100, scale = 0   -> 100 × 10^0  = 100
```

```
                 unscaledValue    scale
  "1.0"    ->         10            1      ┐ 수학적으로는 둘 다 1
  "1.00"   ->        100            2      ┘ 그런데 필드 값은 완전히 다르다

  "100"    ->        100            0      ← "1.00"과 unscaledValue는 같은데 scale이 다르다
```

**여기가 이 문서 전체의 출발점이다.** `1.0`과 `1.00`은 수학적으로 같은 수를 가리키지만, **객체가 들고 있는 필드 값이 실제로 다르다.** 이건 표현 방식의 우연한 부작용이 아니라 의도된 설계다 — `BigDecimal`은 "숫자 1"만이 아니라 **"소수점 아래 몇 자리까지 유효한 숫자인가"라는 정보까지 함께 표현하는 타입**이기 때문이다. 금액 계산에서 "1원"과 "1.00원"은 정밀도가 다른 서로 다른 진술이고, `BigDecimal`은 그 구분을 버리지 않는다.

### 1-2. equals가 false인 것은 버그가 아니라 계약을 지킨 결과다

`Object.equals`의 계약은 "논리적으로 같은 객체인가"이고, 값 객체에서 그 판단 기준은 통상 **필드가 전부 같은가**다. `1.0`과 `1.00`은 필드가 다르므로 `equals`는 `false`를 반환해야 한다. **규약을 어긴 것이 아니라 규약대로 동작한 것이다.**

```java
BigDecimal a = new BigDecimal("1.0");
BigDecimal b = new BigDecimal("1.00");

System.out.println(a.equals(b));         // 출력: false
System.out.println(a.compareTo(b));      // 출력: 0
System.out.println(a.compareTo(b) == 0); // 출력: true
```

`compareTo`는 다른 질문에 답한다. **두 값의 스케일을 큰 쪽에 맞춰 정렬시킨 뒤 수학적 크기만 비교**한다. `1.0`을 `1.00`으로 맞춰 놓고 보면 같으므로 0을 돌려준다.

| | 비교 기준 | 답하는 질문 |
|---|---|---|
| `equals` | `unscaledValue`와 `scale`이 **둘 다** 같아야 `true` | "표현까지 완전히 같은 객체인가" |
| `compareTo` | 스케일을 맞춘 뒤 **수학적 값만** 비교 | "수로서 같은가" |

**금액 검증에서 우리가 알고 싶은 것은 거의 언제나 오른쪽 질문이다.** 요청 금액 100원과 주문 금액 100.00원은 같은 금액이다. 소수점 표기가 몇 자리인지는 관심사가 아니다. 그래서 값 비교에는 `compareTo`를 쓴다.

여기서 짚고 갈 것이 하나 더 있다. **`Comparable` 인터페이스는 `x.compareTo(y) == 0`과 `x.equals(y)`가 일치할 것을 "강력히 권장"한다.** 정렬 순서와 동등성 판단이 어긋나면 정렬 기반 컬렉션(`TreeSet`, `TreeMap`)이 `Set`·`Map` 인터페이스의 일반 계약과 어긋나게 동작하기 때문이다.

`BigDecimal`은 이 권장을 **의도적으로 깬** 드문 표준 클래스이고, Javadoc에도 자연 순서가 equals와 일관되지 않는다고 명시돼 있다. 왜 그 선택을 했는지까지 말할 수 있으면 좋은데, 그건 4장 첫 꼬리질문에서 다룬다.

### 1-3. hashCode도 스케일을 반영한다 — 여기서 진짜 문제가 시작된다

`equals`만 다르면 "값 비교할 때 `compareTo` 쓰자"로 끝난다. 문제는 **`hashCode`도 스케일을 반영한다**는 것이다.

```java
System.out.println(new BigDecimal("1.0").hashCode());     // 출력: 311
System.out.println(new BigDecimal("1.00").hashCode());    // 출력: 3102
System.out.println(new BigDecimal("100").hashCode());     // 출력: 3100
System.out.println(new BigDecimal("100.00").hashCode());  // 출력: 310002
```

값이 어떻게 나오는지 계산해 보면 스케일이 어떻게 섞여 들어가는지가 보인다. **(가산점 포인트)** 실행 결과를 보면 이 JDK(OpenJDK 21)에서는 `31 × unscaledValue.hashCode() + scale`로 계산된다.

```
"1.0"    -> 31 × 10   + 1 = 311
"1.00"   -> 31 × 100  + 2 = 3102
"100"    -> 31 × 100  + 0 = 3100
"100.00" -> 31 × 10000+ 2 = 310002
```

정확한 식은 구현 세부사항이지만, **Javadoc이 보장하는 것은 "hashCode는 unscaledValue와 scale의 함수"라는 사실**이고 그것만으로 결론은 확정된다. **스케일이 다르면 해시값이 다르다.**

왜 이게 치명적인지는 `HashMap`이 값을 찾는 절차를 알아야 보인다(`03-equals-hashcode-contract.md`에 본편이 있다). `HashMap`은 두 단계를 밟는다.

```
[1단계] key.hashCode()로 정수를 얻고, 그것으로 배열 인덱스(버킷)를 계산한다
        new BigDecimal("100.00").hashCode() = 310002 -> 배열 길이 16이면 6번 칸
        new BigDecimal("100")   .hashCode() =   3100 -> 배열 길이 16이면 12번 칸

[2단계] 그 칸에 매달린 후보들만 꺼내 key.equals(후보)로 대조한다
        6번 칸을 열었는데 찾는 것이 12번 칸에 있으면? -> 2단계는 아예 실행되지 않고 "없음"
```

**무너지는 지점이 2단계(비교)가 아니라 1단계(칸 선택)다.** `100`과 `100.00`은 애초에 서로 다른 칸을 배정받으므로 만나지를 못한다. 그리고 여기서는 `compareTo`를 쓰라고 고칠 수도 없다 — **`HashMap`·`HashSet`·`List.contains`는 내부적으로 `equals`와 `hashCode`를 쓰도록 만들어져 있고, 그 자리에 비교 방식을 끼워 넣을 파라미터가 없다.**

예외도 안 나고 컴파일 에러도 안 나고, 그냥 "없다"는 답이 나온다. 이것이 이 버그가 무서운 이유다.

## 2. 스케일이 달라지는 경로 — "우리는 통일하니까 괜찮다"가 안 통하는 이유

"우리 코드는 스케일을 통일하니까 이 문제가 없다"고 생각하기 쉽다. 그런데 스케일은 **우리가 명시적으로 지정하지 않아도** 여러 경로로 달라진다. 경로를 하나씩 확인해 두면 어디에 방어선을 쳐야 하는지가 정해진다.

### 2-1. DB에서 읽어온 값 — 가장 흔한 출처

PostgreSQL에서 금액 컬럼을 `NUMERIC(19, 2)`로 잡았다면, 그 컬럼은 **항상 소수점 둘째 자리까지 저장한다.** JDBC가 그것을 `BigDecimal`로 읽어 오면 **scale이 2인 객체**가 된다. 값이 100원이어도 `100.00`, 즉 `(10000, 2)`다.

반면 코드에서 만드는 값은 대개 scale이 0이다.

```java
BigDecimal fromDb = order.getAmount();          // NUMERIC(19,2) -> 100.00, scale 2
BigDecimal fromReq = new BigDecimal("100");     // 요청 파라미터 문자열 -> 100, scale 0
BigDecimal fromCode = BigDecimal.valueOf(100L); // 코드 상수 -> 100, scale 0
```

**여기서 이미 어긋난다.** DB 경계를 넘어온 값과 코드에서 만든 값이 만나는 자리가 곧 사고 지점이고, 결제 금액 검증이 정확히 그 자리다.

### 2-2. 산술 연산 — 연산마다 스케일 규칙이 다르다

연산 결과의 스케일은 자동으로 정해지는데, **규칙이 연산마다 다르다.** 직접 돌려본 결과를 보자.

```java
new BigDecimal("50.5").multiply(new BigDecimal("2"));     // 101.0    scale = 1
new BigDecimal("100.00").add(new BigDecimal("50.5"));     // 150.50   scale = 2
new BigDecimal("100.00").subtract(new BigDecimal("100")); // 0.00     scale = 2
new BigDecimal("100.00").divide(new BigDecimal("4"));     // 25.00    scale = 2
```

규칙을 정리하면 이렇다.

| 연산 | 결과 스케일 | 위 예시 |
|---|---|---|
| 덧셈·뺄셈 | 두 피연산자 스케일 중 **큰 쪽** | max(2, 1) = 2 |
| 곱셈 | 두 피연산자 스케일의 **합** | 1 + 0 = 1 |
| 나눗셈 | 피제수 스케일 **빼기** 제수 스케일 (나누어떨어질 때) | 2 - 0 = 2 |

세 번째 줄을 특히 눈여겨볼 만하다. `100.00 - 100`의 결과는 `0`이 아니라 **`0.00`**이다. 값은 0인데 scale이 2다. 그래서 이 결과를 `BigDecimal.ZERO`(scale 0)와 `equals`로 비교하면 `false`가 나온다. **"잔액이 0인지" 검사가 조용히 실패하는 전형적인 경로**가 여기다.

### 2-3. `setScale` — 명시적으로 바꾸는 경우

```java
new BigDecimal("100").setScale(2, RoundingMode.HALF_UP);  // 100.00  (scale 0 -> 2)
```

`setScale`은 이름 그대로 스케일을 지정한다. 자리를 늘리는 쪽은 0을 붙이면 되니 문제가 없는데, **줄이는 쪽은 버릴 자리를 어떻게 처리할지 정해야 한다.** 반올림 모드를 안 주면 예외가 난다.

```java
new BigDecimal("100.50").setScale(0);
// ArithmeticException: Rounding necessary
```

`setScale`은 원본을 바꾸지 않고 **새 객체를 반환**한다는 점도 자주 놓친다. `amount.setScale(2, HALF_UP);`이라고만 쓰고 반환값을 안 받으면 아무 일도 일어나지 않는다. `BigDecimal`은 불변 객체이기 때문이다(`04-string-immutability-stringbuilder.md`의 String과 같은 성질이다).

### 2-4. 생성자 세 가지 — `double` 생성자가 왜 위험한가

이 셋은 이름이 비슷한데 결과가 다르다. 실제 출력을 확인해 보면 차이가 명확하다.

```java
new BigDecimal("1.0")        // 1.0    scale = 1
BigDecimal.valueOf(1.0)      // 1.0    scale = 1
new BigDecimal(1.0)          // 1      scale = 0
```

여기까지만 보면 `new BigDecimal(1.0)`이 그냥 scale이 다를 뿐인 것처럼 보인다. **`0.1`을 넣어 보면 진짜 문제가 드러난다.**

```java
System.out.println(new BigDecimal("0.1"));
// 출력: 0.1

System.out.println(BigDecimal.valueOf(0.1));
// 출력: 0.1

System.out.println(new BigDecimal(0.1));
// 출력: 0.1000000000000000055511151231257827021181583404541015625
// scale = 55
```

**왜 이런 값이 나오는가.** `0.1`이라는 리터럴은 컴파일 시점에 이미 `double`이 되는데, `double`은 2진 분수의 합으로 숫자를 표현하므로 10진수 `0.1`을 정확히 담을 수 없다. 가장 가까운 2진수 값으로 근사되고, 그 근사값의 **정확한 10진수 표기**가 위의 긴 숫자다.

`new BigDecimal(double)` 생성자는 **그 근사값을 하나도 버리지 않고 그대로 옮겨 담는다.** 정직하다면 정직한 동작이지만, 우리가 원한 것은 "0.1"이었지 "double이 표현할 수 있는 0.1에 가장 가까운 값"이 아니었다. 그리고 이 값이 금액 계산에 들어가면 자릿수가 계속 불어나며 오차가 번진다.

`BigDecimal.valueOf(double)`이 안전한 이유는 **내부적으로 `Double.toString(d)`를 거쳐 문자열로 바꾼 뒤 파싱하기 때문**이다. `Double.toString`은 "그 double을 다시 읽었을 때 같은 값이 되는 가장 짧은 표기"를 돌려주므로 `0.1`이 나오고, 그것을 파싱하니 `0.1`이 된다.

**실무 결론은 셋으로 정리된다.**

1. 가장 안전한 것은 **문자열 생성자** `new BigDecimal("0.1")`이다. 애초에 `double`을 거치지 않는다.
2. 이미 `double` 변수를 손에 들고 있다면 `BigDecimal.valueOf(d)`를 쓴다.
3. **`new BigDecimal(double)`은 쓰지 않는다.** 이 생성자가 필요한 상황은 "double의 비트가 실제로 무슨 값인지 조사할 때" 정도다.

그리고 더 근본적인 조언은 **금액이 `double`로 표현된 적이 아예 없게 만드는 것**이다. JSON 파싱 설정, DTO 필드 타입, 외부 API 응답 매핑까지 전부 `BigDecimal`이나 문자열로 받으면 이 함정 자체를 만날 일이 없다.

## 3. 실제 버그와 방어 전략

### 3-1. 버그 1: 직접 비교 — "결제 금액 검증 실패"

```java
// Before: equals 사용 — 버그
BigDecimal requested = new BigDecimal("100");   // 요청 파라미터에서 생성. scale 0
BigDecimal orderAmount = order.getAmount();     // NUMERIC(19,2) 조회 결과 100.00. scale 2

if (!requested.equals(orderAmount)) {
    throw new PaymentAmountMismatchException();  // 같은 금액인데 결제가 거절된다
}

// After: compareTo 사용 — 정상
if (requested.compareTo(orderAmount) != 0) {
    throw new PaymentAmountMismatchException();
}
```

이 버그의 성질을 정확히 짚어야 한다. **로컬 테스트는 대개 통과한다.** 테스트에서는 요청 금액과 주문 금액을 같은 방식(둘 다 `new BigDecimal("100")`)으로 만들기 때문이다. **실제 DB를 한 번 거쳐 스케일이 붙는 운영 경로에서만 틀린다.**

### 3-2. 버그 2: 컬렉션 — 조용히 틀어지는 케이스 (더 위험)

`HashSet`·`HashMap`·`List.contains`는 `equals`와 `hashCode`를 쓰도록 만들어져 있어, **`compareTo`로 바꿔 낄 방법이 없다.**

```java
Set<BigDecimal> paidAmounts = new HashSet<>();
paidAmounts.add(new BigDecimal("100.00"));           // DB에서 온 값

System.out.println(paidAmounts.contains(new BigDecimal("100")));
// 출력: false        <- 중복 결제 감지 실패

paidAmounts.add(new BigDecimal("100"));
System.out.println(paidAmounts);
// 출력: [100.00, 100]       같은 금액이 두 항목으로 들어갔다
System.out.println(paidAmounts.size());
// 출력: 2

System.out.println(List.of(new BigDecimal("100.00")).contains(new BigDecimal("100")));
// 출력: false        List.contains도 equals 기반이라 같다
```

1-3에서 본 대로 두 값의 해시가 3100과 310002라 배열 길이 16 기준으로 12번 칸과 6번 칸으로 흩어진다. **애초에 만나지를 않으므로 `equals` 비교는 실행조차 되지 않는다.**

증상이 어떻게 나타나는지가 중요하다. 예외도 로그도 없이 **중복 제거가 안 되고, 중복 결제 감지가 통과하고, 캐시가 매번 미스**가 난다. 원인 지점(스케일)과 증상이 나타나는 지점(정산 불일치, 이중 결제)이 멀리 떨어져 있어 추적이 어렵다.

### 3-3. 버그 3: 0 비교

```java
// Before: 잔액이 0인지 검사 — 스케일에 따라 실패한다
BigDecimal balance = new BigDecimal("100.00").subtract(new BigDecimal("100")); // 0.00, scale 2

System.out.println(balance.equals(BigDecimal.ZERO));
// 출력: false      <- BigDecimal.ZERO는 scale 0이고 balance는 scale 2

// After
System.out.println(balance.compareTo(BigDecimal.ZERO) == 0);   // 출력: true
System.out.println(balance.signum() == 0);                     // 출력: true
```

`BigDecimal.ZERO`, `ONE`, `TEN` 같은 상수는 전부 **scale 0**이다. 반면 계산으로 나온 0은 2-2에서 봤듯 피연산자의 스케일을 물려받아 `0.00`이 되는 경우가 흔하다. **그래서 `equals(BigDecimal.ZERO)`는 사실상 늘 위험한 코드다.**

`signum()`은 부호를 `-1`, `0`, `1`로 돌려주는 메서드다. 0 판정에는 `compareTo(BigDecimal.ZERO) == 0`보다 짧고, "부호를 본다"는 의도도 더 직접적이다. 잔액이 음수인지 확인할 때도 `signum() < 0`으로 쓸 수 있다.

### 3-4. 방어 전략 — 네 겹으로 막는다

버그 세 개를 다 보면 방어선이 어디에 있어야 하는지가 정해진다. **비교 시점에서만 막으면 3-2의 컬렉션 문제는 못 막는다.** 그래서 층을 나눈다.

**(1) 값 비교는 예외 없이 `compareTo(...) == 0`.** 0 비교는 `signum() == 0`. 이건 사람이 기억해서 지킬 규칙이 아니라 **도구로 강제해야 하는 규칙**이다. ErrorProne의 `BigDecimalEquals` 체크처럼 `BigDecimal`에 `equals`를 쓰면 빌드를 실패시키는 정적 분석 규칙을 켜 두면, 신규 입사자나 AI가 생성한 코드에서도 이 실수가 통과하지 못한다.

**(2) 경계에서 스케일을 정규화한다.** 진짜 정공법은 여기다. 값이 시스템 안으로 들어오는 지점(DB 조회 후 도메인 객체 생성, 외부 API 응답 파싱, 요청 DTO 변환)에서 **`setScale(2, RoundingMode.HALF_UP)`으로 스케일을 통일**해 버리면, 그 이후로는 시스템 안에 스케일이 다른 같은 금액이 존재하지 않는다. 비교 문제도, 컬렉션 문제도 함께 사라진다.

```java
// 도메인 객체 안으로 들어오는 순간 정규화한다
public record Money(BigDecimal amount) {
    private static final int SCALE = 2;

    public Money {
        // 생성자에서 한 번 정규화하면 이후 이 객체의 amount는 항상 scale 2다.
        // 컬렉션 키로 써도, equals로 비교해도 안전해진다.
        amount = amount.setScale(SCALE, RoundingMode.HALF_UP);
    }
}
```

**(3) 컬렉션 키로 써야 한다면 정규화된 값만 넣는다.** (2)가 되어 있으면 자동으로 해결된다. 대안으로 `TreeSet`/`TreeMap`을 쓰는 방법도 있다 — 이들은 `equals`가 아니라 `compareTo`(또는 주입한 `Comparator`)로 판정하므로 스케일 차이를 무시한다.

```java
Set<BigDecimal> hashSet = new HashSet<>();
hashSet.add(new BigDecimal("100.00"));
hashSet.add(new BigDecimal("100"));
System.out.println(hashSet.size());   // 출력: 2   — equals 기반이라 둘 다 들어간다

Set<BigDecimal> treeSet = new TreeSet<>();
treeSet.add(new BigDecimal("100.00"));
treeSet.add(new BigDecimal("100"));
System.out.println(treeSet.size());   // 출력: 1   — compareTo 기반이라 같은 값으로 본다
System.out.println(treeSet);          // 출력: [100.00]   먼저 들어온 쪽이 남는다
```

다만 여기에 트레이드오프가 하나 붙는다. **(가산점 포인트)** **`TreeSet`은 "정렬 순서가 equals와 일관되지 않은" 상태가 되어 `Set` 인터페이스의 일반 계약에서 벗어난다.** 우리가 원하는 동작이긴 하지만, 그 코드를 읽는 다른 사람은 `Set`의 표준 동작(중복 판정이 `equals` 기준)을 가정할 것이므로 **왜 `TreeSet`인지 주석이나 타입 이름으로 드러내야** 한다.

**(4) 출력 정규화에 `stripTrailingZeros()`를 쓸 때는 함정을 알고 쓴다.** 뒤에 붙은 0을 떼어 `1.00`을 `1`로 만들어 주는 메서드인데, **정수에 쓰면 지수 표기가 튀어나온다.**

```java
System.out.println(new BigDecimal("1.00").stripTrailingZeros());   // 출력: 1
System.out.println(new BigDecimal("100").stripTrailingZeros());    // 출력: 1E+2
System.out.println(new BigDecimal("100").stripTrailingZeros().scale());  // 출력: -2
```

`100`의 뒤쪽 0 두 개를 떼면 unscaledValue가 1이 되고 그것을 100으로 되돌리려면 scale이 **-2**가 되어야 한다. 그리고 scale이 음수인 `BigDecimal`의 `toString()`은 지수 표기 `1E+2`를 쓴다. **이 값이 그대로 화면이나 응답 JSON에 나가면 그대로 사고다.**

지수 표기를 피하려면 `toPlainString()`을 쓴다.

```java
System.out.println(new BigDecimal("100").stripTrailingZeros().toPlainString());  // 출력: 100
```

정리하면 **비교 목적으로는 `compareTo`가 정답이고, `stripTrailingZeros`는 표시 목적으로 쓰되 반드시 `toPlainString()`과 짝지어 쓴다.**

## 4. 꼬리질문 대비 포인트

### "`equals`가 스케일까지 보는 건 잘못 설계된 것 아닌가요? 왜 안 고쳤을까요?"

먼저 **의도된 설계라는 것부터 인정**하고 시작한다. `BigDecimal`은 "수 하나"가 아니라 **"수 + 그 수가 소수점 아래 몇 자리까지 유효한가"**를 함께 표현하는 타입이다. 회계·계량 도메인에서 `1.0`과 `1.00`은 정밀도가 다른 서로 다른 진술이고, `equals`가 그 차이를 지워 버리면 그 정보를 다시 얻을 방법이 없어진다.

그리고 `Comparable`의 권장을 깬 대가로 얻은 것이 하나 더 있다. **`compareTo`가 스케일을 무시하기 때문에 정렬은 우리가 기대하는 대로 수학적 크기순으로 동작한다.** 만약 두 메서드를 일치시키려고 `compareTo`가 스케일까지 봤다면 `1.0`과 `1.00` 사이에 임의의 순서가 생겨 훨씬 이상한 정렬이 됐을 것이다. **둘 중 하나는 규약을 깰 수밖에 없는 구조였고, 값 비교 쪽을 살린 것**이다.

이제 와서 고칠 수 없는 이유는 명확하다. `equals`의 동작을 바꾸면 **기존에 `HashMap` 키나 `Set` 원소로 쓰던 모든 코드의 동작이 조용히 달라진다.** 컴파일 에러도 안 나고 예외도 안 나는 변경이라 어떤 코드가 영향을 받는지 알 방법도 없다. 그래서 Javadoc에 "자연 순서가 equals와 일관되지 않는다"고 명시하고 사용자에게 알리는 쪽을 택했다.

**"잘못 설계된 게 아니라, 잘못 쓰기 쉬운 설계"**라고 정리하면 정확하다.

### "`new BigDecimal(0.1)`과 `BigDecimal.valueOf(0.1)`은 뭐가 다른가요?"

`new BigDecimal(double)`은 **`double`이 실제로 들고 있는 2진 근사값을 한 자리도 버리지 않고 그대로 10진수로 옮긴다.** 그래서 결과가 이렇게 나온다.

```java
new BigDecimal(0.1)      // 0.1000000000000000055511151231257827021181583404541015625  (scale 55)
BigDecimal.valueOf(0.1)  // 0.1  (scale 1)
new BigDecimal("0.1")    // 0.1  (scale 1)
```

`0.1`은 2진 분수로 정확히 표현되지 않으므로 `double`에는 가장 가까운 근사값이 담기는데, 그 근사값의 정확한 10진 표기가 위의 긴 숫자다. `BigDecimal`은 잘못한 게 없다 — **`double`이 이미 갖고 있던 오차를 정직하게 드러냈을 뿐**이다.

`valueOf`가 안전한 이유는 **내부에서 `Double.toString(d)`를 거치기 때문**이다. `Double.toString`은 "다시 읽으면 같은 double이 되는 가장 짧은 표기"를 주므로 `"0.1"`이 나오고, 그것을 파싱하니 우리가 의도한 값이 된다.

실무 기준은 셋이다. **문자열 생성자를 1순위로, `double`을 이미 들고 있으면 `valueOf`, `new BigDecimal(double)`은 쓰지 않는다.** 그리고 근본 대응은 **금액이 `double`이 되는 지점 자체를 없애는 것** — JSON 역직렬화 설정, DTO 필드 타입, 외부 API 응답 매핑을 전부 `BigDecimal`이나 문자열로 받으면 이 질문 자체가 사라진다.

### "`stripTrailingZeros()`로 스케일을 없애고 비교하면 되지 않나요?"

동작은 한다. `1.0`과 `1.00`을 둘 다 `1`로 만든 뒤 `equals`로 비교하면 `true`가 나온다. 그런데 **비교 목적으로 쓰기에는 두 가지 이유로 나쁜 선택**이다.

**첫째, 정수에서 지수 표기가 튀어나온다.**

```java
new BigDecimal("100").stripTrailingZeros();              // 1E+2   (scale = -2)
new BigDecimal("100").stripTrailingZeros().toString();   // "1E+2"
new BigDecimal("100").stripTrailingZeros().toPlainString(); // "100"
```

뒤쪽 0 두 개를 떼면 unscaledValue가 1이 되므로 원래 값 100을 유지하려면 scale이 -2가 되어야 하고, scale이 음수면 `toString()`이 지수 표기를 쓴다. 비교만 하고 버릴 값이면 상관없지만, **그 객체가 로그·응답·다음 계산으로 흘러가면 `1E+2`가 그대로 노출된다.**

**둘째, 정규화 후 `equals`는 `compareTo`보다 느리고 의도가 덜 드러난다.** 새 객체를 만드는 비용이 붙고, 읽는 사람은 "왜 여기서 0을 떼고 있지?"를 한 번 더 생각해야 한다. `compareTo(other) == 0`은 그 자체로 "값이 같은지 본다"는 뜻이다.

**결론은 역할 분담이다. 비교는 `compareTo`, 표시 정규화는 `stripTrailingZeros` + `toPlainString`.** 다만 표시 목적이라도 대개는 `setScale(2, HALF_UP)`이나 `NumberFormat`으로 자릿수를 고정하는 편이 낫다. 금액 화면에서 `1000원`과 `1000.00원`이 섞여 나오는 것도 결함이기 때문이다.

### "`divide()`를 쓸 때 주의할 점은 무엇인가요?"

**반올림 모드를 안 주면 예외가 난다는 것**이 첫 번째다.

```java
new BigDecimal("10").divide(new BigDecimal("3"));
// ArithmeticException: Non-terminating decimal expansion; no exact representable decimal result.
```

10을 3으로 나누면 3.333...으로 무한히 이어진다. `BigDecimal`은 유한한 자릿수만 표현할 수 있으므로 **"어디서 끊을지"를 알려주지 않으면 계산을 시작조차 못 한다.** 그래서 예외를 던진다. 값을 대충 잘라 반환해 오차를 조용히 만드는 것보다 낫다는 판단이다.

해결은 자릿수와 반올림 모드를 명시하는 것이다.

```java
new BigDecimal("10").divide(new BigDecimal("3"), 2, RoundingMode.HALF_UP);   // 3.33
new BigDecimal("10.00").divide(new BigDecimal("3"), RoundingMode.HALF_UP);   // 3.33
```

위쪽은 결과 스케일을 2로 직접 지정한 것이고, 아래쪽은 스케일을 생략해 **피제수의 스케일(2)을 그대로 쓰는** 형태다.

**이 예외가 잠복 버그라는 점이 중요하다.** `divide(a, b)`처럼 반올림 없이 쓴 코드는 나누어떨어지는 값에서는 아무 문제 없이 돌아간다. 개발·테스트 데이터가 `100 / 4`처럼 딱 떨어지는 값이면 전부 통과하고, **운영에서 3으로 나누는 케이스가 들어오는 순간 터진다.** 그래서 팀 규칙으로 **`divide` 호출에는 항상 스케일과 `RoundingMode`를 명시**하도록 강제하는 편이 좋다.

반올림 모드 선택도 도메인 판단이다. `HALF_UP`(5는 올림)이 일반적인 감각과 맞지만, 회계·통계 영역에서는 반올림 편향을 줄이는 `HALF_EVEN`(5는 짝수 쪽으로)을 쓰기도 한다. 부가세나 수수료 계산이라면 **절사할지 올림할지가 계약서에 적혀 있는 경우가 많으므로 그 문서를 따라야 한다.**

### "금액 타입을 팀 표준으로 정한다면 어떻게 설계하시겠습니까?" (시니어 변별 포인트)

**"`compareTo`를 씁시다"라는 규칙만 정하는 것으로는 부족하다**는 인식에서 출발해야 한다. 사람이 매번 기억해야 하는 규칙은 반드시 새는데, 이 버그는 새도 티가 안 나기 때문이다. 그래서 **틀린 코드를 애초에 쓸 수 없게 만드는 쪽**으로 설계한다.

**(1) 금액 전용 값 객체를 만들고 `BigDecimal`을 그 안에 가둔다.** `Money`가 유일한 금액 타입이 되고, `BigDecimal`은 도메인 코드에 직접 등장하지 않게 한다.

```java
public record Money(BigDecimal amount, Currency currency) {
    private static final int SCALE = 2;

    public Money {
        // 경계 정규화: 어떤 경로로 들어온 값이든 여기서 스케일이 통일된다.
        // 이 한 줄이 3-2의 컬렉션 버그를 구조적으로 없앤다.
        amount = amount.setScale(SCALE, RoundingMode.HALF_UP);
    }

    public boolean isSameAmount(Money other) {
        // 밖으로는 compareTo 기반의 비교만 노출한다.
        // 호출자가 equals를 잘못 쓸 기회 자체를 주지 않는다.
        return currency.equals(other.currency)
            && amount.compareTo(other.amount) == 0;
    }

    public boolean isZero() { return amount.signum() == 0; }

    public Money plus(Money other) { /* 통화 검증 후 더한다 */ }
}
```

정규화를 생성자에 두는 것이 핵심이다. **`Money` 객체는 만들어지는 순간 항상 scale 2이므로, `record`가 자동 생성해 준 `equals`/`hashCode`도 그대로 안전해진다.** `HashMap` 키로 써도 되고 `Set`에 넣어도 된다. "값 비교는 `compareTo`"라는 규칙이 타입 안으로 흡수되어 사라진 것이다.

**(2) 경계를 한 겹으로 좁힌다.** 정규화가 의미를 가지려면 `Money`를 거치지 않고 금액이 들어오는 경로가 없어야 한다. JPA 컨버터나 `@Embeddable`로 DB 경계를, 커스텀 역직렬화로 API 경계를 막는다. **경계가 여러 곳이면 정규화도 여러 곳에서 새고, 그러면 처음 문제로 돌아간다.**

**(3) 스케일과 반올림 정책을 도메인 규칙으로 명시한다.** 저장 스케일(예: 원화 0, 달러 2), 나눗셈 시 자릿수와 `RoundingMode`, 부가세·수수료 절사 규칙을 **코드가 아니라 정책 문서에서 가져와 상수 한 곳에 모은다.** 여기저기 흩어진 `setScale(2, HALF_UP)`은 나중에 정책이 바뀔 때 전부 찾아 고쳐야 한다.

**(4) DB 컬럼 타입을 맞춘다.** PostgreSQL에서 금액은 `NUMERIC(19, 2)`처럼 **정밀도와 스케일을 명시한 `NUMERIC`**으로 잡는다. `double precision`이나 `real`로 잡으면 2-4에서 본 부동소수점 오차가 저장 계층에서 발생하므로 애플리케이션에서 아무리 `BigDecimal`을 써도 소용이 없다.

**(5) 정적 분석으로 잔여 경로를 막는다.** 그래도 `BigDecimal`을 직접 써야 하는 자리는 남으므로, ErrorProne의 `BigDecimalEquals` 같은 규칙을 CI에서 켜 두어 `equals` 사용을 빌드 실패로 잡는다.

마지막으로 트레이드오프도 말할 수 있어야 한다. **`Money` 타입을 도입하면 초반에 변환 코드가 늘고, 이미 `BigDecimal`이 시그니처에 박혀 있는 레거시 코드에서는 경계 어댑터가 필요하다.** 그래서 현실적인 순서는 신규 도메인부터 `Money`를 쓰고, 레거시는 정적 분석으로 `equals`만 먼저 막은 뒤 점진적으로 흡수하는 것이다. **"규칙을 지키게 만드는 것"과 "규칙이 필요 없게 만드는 것" 중 후자를 목표로 두되, 이행 경로는 단계적으로 잡는다**는 판단이 이 질문의 답이다.

---

## 한 줄 요약

`BigDecimal`은 값을 `unscaledValue`와 `scale` 두 개로 나눠 들고 있어 `1.0`은 `(10, 1)`, `1.00`은 `(100, 2)`로 **객체 상태가 실제로 다르므로**, `equals`가 `false`인 것은 계약을 지킨 결과이고 수학적 값 비교는 `compareTo(...) == 0`(0 판정은 `signum() == 0`)의 몫이다 — 문제는 `hashCode`도 스케일을 반영해 `HashSet`·`HashMap`에서 다른 버킷으로 갈라지는데 거기서는 비교 방식을 바꿔 낄 수조차 없다는 것이므로, DB `NUMERIC(19,2)`·`setScale`·산술 연산·`double` 생성자로 스케일이 어긋나기 전에 **경계에서 스케일을 통일한 금액 값 객체**로 가두는 것이 정공법이다.
