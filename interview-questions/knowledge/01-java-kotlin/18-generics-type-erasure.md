# 제네릭의 타입 소거(Type Erasure) — 원리와 실무 제약

> 핵심 관전 포인트: **Java 제네릭은 "컴파일러만 아는 타입"이다.
> 컴파일러가 타입 검사를 끝낸 뒤 타입 파라미터를 지우고(Object 또는 bound로
> 치환) 필요한 곳에 캐스트를 심는 방식이라, 런타임의 JVM은 `List<String>`과
> `List<Integer>`를 구분하지 못한다. 하위 호환을 위한 설계 선택이었고,
> 그 대가로 "런타임에 T를 알아야 하는 모든 일"이 막힌다 —
> 실무에서는 JSON 역직렬화(TypeReference)에서 가장 자주 부딪힌다.**

---

## 0. 질문 + 의도

**질문**: "제네릭의 타입 소거(type erasure)란? 런타임에 타입 정보가 없어서
생기는 실무 제약은? 와일드카드(`? extends`, `? super`)의 사용 기준(PECS)은?"

**출제 의도**: 제네릭이 컴파일 타임 전용 장치임을 알아야 런타임 타입 분기가
안 되는 이유, 직렬화 라이브러리가 TypeReference 같은 우회를 쓰는 이유가
이해된다. PECS는 공통 모듈·라이브러리의 API 시그니처를 설계하는 사람과
소비만 하는 사람을 가르는 표지다.

## 1. 타입 소거란 무엇인가

제네릭 타입 정보는 **컴파일 타임에만 존재**하고, 바이트코드에서는 지워진다.

컴파일러가 하는 일 세 가지:

```java
// 소스 코드
List<String> list = new ArrayList<>();
list.

add("hello");

String s = list.get(0);

// 컴파일 후 (개념적으로)
List list = new ArrayList();        // ① 타입 파라미터 제거
list.

add("hello");

String s = (String) list.get(0);    // ② 캐스트 삽입
```

| 컴파일러의 작업     | 내용                                                                    |
|--------------|-----------------------------------------------------------------------|
| ① 타입 파라미터 소거 | unbounded `T` → `Object`, `T extends Number` → `Number` (첫 bound로 치환) |
| ② 캐스트 삽입     | 꺼내 쓰는 지점에 형변환 코드를 자동 삽입                                               |
| ③ 브리지 메서드 생성 | 제네릭 클래스 상속 시 시그니처 불일치를 메꾸는 합성 메서드 생성                                  |

```java
// ③의 예: Comparable<MyClass> 구현 시
public int compareTo(MyClass o) { ...}        // 내가 쓴 메서드

public int compareTo(Object o) {               // 컴파일러가 만든 브리지
    return compareTo((MyClass) o);
}
```

결과: **런타임에 `List<String>`과 `List<Integer>`는 완전히 같은 클래스**다.

```java
new ArrayList<String>().

getClass() ==new ArrayList<Integer>().

getClass()  // true
```

### 왜 이렇게 설계했나 — 하위 호환

- 제네릭은 Java 5(2004)에 도입됐고, 이미 세상에는 raw type `List`를 쓰는
  코드와 컴파일된 바이트코드가 산더미였다
- 소거 방식이면 `List<String>`도 결국 예전과 같은 `List` 클래스라서
  **기존 바이트코드·라이브러리와 그대로 섞어 쓸 수 있다** (마이그레이션 불필요)
- 대비: C#은 런타임에 타입을 유지하는 **reified generics**를 택했다
  (CLR을 뜯어고치는 비용을 치름). Java는 JVM 무변경 + 하위 호환을 택한 것

---

## 2. 소거 때문에 언어 차원에서 막히는 것들

| 불가능한 코드                                      | 이유                                        |
|----------------------------------------------|-------------------------------------------|
| `new T()`                                    | 런타임에 T가 뭔지 몰라 생성자를 찾을 수 없음                |
| `new T[10]`                                  | 배열은 런타임에 원소 타입을 검사(reified)하는데 T를 모름      |
| `obj instanceof List<String>`                | 런타임엔 전부 그냥 `List` → 검사 불가 (`List<?>`만 허용) |
| `T.class`, `List<String>.class`              | 그런 Class 객체 자체가 없음 (`List.class` 하나뿐)     |
| `catch (T e)`                                | 예외 매칭은 런타임 타입 기반                          |
| static 필드에 T 사용                              | T는 인스턴스별인데 static은 클래스당 하나                |
| 오버로딩: `f(List<String>)` / `f(List<Integer>)` | 소거하면 시그니처가 동일 → 컴파일 에러                    |

### 힙 오염(heap pollution) — 소거의 어두운 뒷문

**정의**: `List<String>`이라고 선언된 변수가 가리키는 실제 객체 안에
String이 아닌 것이 들어가 있는 상태. "힙에 있는 객체의 실제 내용물"과
"변수의 선언 타입"이 어긋난 것 — 그 어긋난 객체가 힙에 존재하므로
"힙이 오염됐다"고 부른다.

raw type(타입 인자 없이 쓰는 제네릭 클래스, `List`)이 뒷문이 된다.
Java 5 이전 코드 호환을 위해 지금도 **컴파일 에러가 아니라 경고만** 나온다.

```java
List<String> strings = new ArrayList<>();  // ① String만 담기로 한 리스트
List raw = strings;                        // ② raw 변수로 같은 객체를 가리킴
raw.add(42);                               // ③ Integer가 들어감! (힙 오염 발생)
String s = strings.get(0);                 // ④ 💥 ClassCastException
```

단계별로 누가 왜 못 막는지:

| 단계 | 무슨 일이 | 왜 안 막히나 |
|---|---|---|
| ② 대입 | `strings`와 `raw`가 **같은 ArrayList 객체**를 가리키게 됨 | raw type = "옛날 방식으로 쓰겠다"라서 경고만 하고 허용 |
| ③ add | Integer 42가 `List<String>` 안으로 | **컴파일러**: raw type이라 원소 타입 검사 안 함. **런타임**: 소거 때문에 이 객체는 자기가 String용이었다는 걸 모름(내부는 그냥 `Object[]`) → 검사할 능력이 없음 |
| ③ 직후 | **아무 예외도 안 터짐** — 시한폭탄 설치만 된 상태 | 이 순간이 힙 오염 |
| ④ get | 컴파일러가 심어둔 `(String)` 캐스트에서 폭발 | 꺼낸 게 Integer라서 |

핵심 통찰:

- 제네릭의 타입 안전성은 **컴파일러 검사가 전부**다. 컴파일러는 안 봤고(raw
  type), 런타임은 볼 능력이 없으니(소거) 아무도 못 막는다
- **터지는 위치(④ get)와 원인 위치(③ add)가 다르다** — 실무에서는 둘이
  다른 클래스·다른 모듈·다른 날일 수 있고, 스택트레이스는 무고한 ④만
  가리켜 디버깅이 어렵다
- 대비 — 배열이었다면 **넣는 즉시** 터진다:

```java
Object[] arr = new String[10];
arr[0] = 42;   // 💥 ArrayStoreException — 배열은 런타임에 원소 타입을 기억(reified)
```

- 제네릭 가변인자(`T... args`)가 내부적으로 `Object[]`를 만들며 같은 위험이
  있어 `@SafeVarargs`가 존재한다

> 한 줄 요약: raw type 우회 = 유일한 방어선인 컴파일 검사를 끄는 것.
> 런타임은 소거 때문에 검사 능력이 없으므로 엉뚱한 타입이 들어가고(힙 오염),
> 예외는 넣을 때가 아니라 한참 뒤 꺼내는 지점에서 터진다.

---

## 3. 실무 제약 — 어디서 부딪히나

### 3-1. JSON 역직렬화 (가장 흔한 조우 지점)

```java
// 컴파일은 되지만 원하는 대로 동작하지 않음
List<OrderDto> orders = objectMapper.readValue(json, List.class);
// → 원소가 OrderDto가 아니라 LinkedHashMap으로 들어옴
orders.

get(0).

getId();   // 💥 ClassCastException: LinkedHashMap cannot be cast to OrderDto
```

- Jackson은 런타임에 "원소 타입이 뭔지" 알아야 매핑할 수 있는데,
  `List.class`에는 그 정보가 없다 (소거됨) → 기본값인 Map으로 채움
- 역시 **넣는 시점이 아니라 꺼내 쓰는 시점에 터지는** 게 고약하다

**해법 — super type token 패턴:**

```java
List<OrderDto> orders = objectMapper.readValue(
    json, new TypeReference<List<OrderDto>>() {
    });   // 익명 서브클래스!
```

이름을 쪼개면: **type token**(타입을 실어 나르는 증표) + **super**(그 타입
정보가 실린 위치가 "부모 타입 선언"). 원래 type token은
`readValue(json, OrderDto.class)`처럼 Class 객체를 증표로 넘기는 패턴인데,
`List<OrderDto>.class`라는 문법은 존재하지 않아 제네릭 앞에서 무력해진다.
그 탈출구가 아래 단계다.

**1단계 — 소거가 못 지우는 곳이 하나 있다: 클래스 선언문**

```java
var list = new ArrayList<OrderDto>();              // 인스턴스: <OrderDto> 소거됨
class MyRef extends TypeReference<List<OrderDto>> { }  // 클래스 선언: 안 지워짐!
```

- 인스턴스의 타입 인자는 실행 중에 흘러가는 정보라 소거되지만,
  **extends 절에 적은 건 소스에 고정된 텍스트**라서 컴파일러가
  `MyRef.class` 파일에 문서처럼 기록해둔다 (Signature 속성)
- 비유: **물건(객체)에는 꼬리표가 안 붙지만, 설계도(클래스 파일)에 쓴
  글자는 영원히 남는다**

**2단계 — 남아 있으니 리플렉션으로 읽을 수 있다**

```java
Type t = MyRef.class.getGenericSuperclass();
// → TypeReference<java.util.List<OrderDto>>   ← 살아 있다!
Type inner = ((ParameterizedType) t).getActualTypeArguments()[0];
// → java.util.List<OrderDto>                  ← 전달하고 싶던 바로 그것
```

**3단계 — 트릭의 발상**: "전달하고 싶은 타입을 extends 절에 적은
**일회용 클래스**를 만들어서 넘기자." 클래스를 "타입 정보를 적는 종이"로
쓰는 것 — `MyRef`의 존재 이유는 부모 선언 자리에 `List<OrderDto>`라는
글자를 실어 나르는 것뿐이다.

**4단계 — 익명 클래스는 그 축약형**

```java
new TypeReference<List<OrderDto>>() {}
//                                ^^ 이 중괄호 = "이름 없는 서브클래스를 정의하라"
```

- 컴파일하면 실제로 `호출클래스$1.class` 파일이 생기고, 거기에 1단계의
  `MyRef`와 똑같이 "부모: `TypeReference<List<OrderDto>>`"가 기록된다
- **`{}`는 장식이 아니라 '클래스 파일을 하나 만들어라'는 명령**

**5단계 — 받는 쪽(Jackson)은 2단계 코드 그대로**: 받은 객체 자체엔 정보가
없지만 `getClass()`로 그 객체의 클래스(4단계에서 만든 익명 클래스 파일)로
올라가 `getGenericSuperclass()`로 부모 선언을 읽는다.

같은 원리의 API들: Spring `ParameterizedTypeReference` (RestTemplate/WebClient),
Gson/Guava `TypeToken`.

**주의 — 만능은 아니다**: extends 절에 **구체 타입을 직접 적을 때만** 동작한다.

```java
<T> List<T> parse(String json) {
    return mapper.readValue(json, new TypeReference<List<T>>() {});  // ❌
    // 메타데이터에 박히는 건 문자 그대로 "List<T>" — T가 뭔지는 여전히 모름
    // → 이런 경우엔 호출자에게서 토큰을 파라미터로 넘겨받아야 한다
}
```

```java
// RestTemplate에서 같은 문제와 해법
ResponseEntity<List<OrderDto>> res = restTemplate.exchange(
        url, GET, null, new ParameterizedTypeReference<List<OrderDto>>() {
        });
```

### 3-2. 캐시/직렬화 계층

- Redis 등에서 JSON으로 저장한 제네릭 컬렉션을 꺼낼 때 동일한 문제 —
  역직렬화기가 원소 타입을 몰라 `List<LinkedHashMap>`이 돌아온다
- 캐시 조회 직후가 아니라 **한참 뒤 필드 접근 시점에 CCE가 터져서**
  캐시 문제인지 즉시 알기 어렵다 → 캐시 값 타입을 명시하는 설계
  (타입별 캐시 매니저, 래퍼 DTO, activateDefaultTyping 등)로 예방

### 3-3. 프레임워크/유틸 작성 시

- **제네릭 타입별 분기 불가**: `instanceof List<String>`이 안 되므로,
  타입별 처리가 필요한 유틸은 `Class<T>` 파라미터를 명시적으로 받아야 한다

```java
// 흔한 관용구: Class 토큰을 같이 넘긴다
public <T> T fromJson(String json, Class<T> type) { ...}
```

- **제네릭 배열 생성 불가**: 컬렉션 구현체나 유틸에서
  `(T[]) new Object[n]` unchecked 캐스트 관용구가 불가피
  (ArrayList 내부도 `Object[]`로 들고 꺼낼 때 캐스트)
- **오버로딩 불가**: `process(List<UserDto>)` / `process(List<OrderDto>)`
  두 메서드를 만들 수 없어 메서드 이름을 나누거나 파라미터로 구분해야 한다
- Spring이 `List<UserHandler>` 같은 제네릭 빈 주입을 해내는 건,
  주입 지점(필드/생성자 시그니처)의 제네릭이 메타데이터에 남아 있어
  `ResolvableType`으로 읽기 때문 — 3-1과 같은 원리

### 3-4. 대비: 소거가 없는 언어에서는

- **Kotlin** — 기본은 Java와 같은 소거지만, `inline fun <reified T>`는
  호출 지점에 코드가 인라인되며 T가 실제 타입으로 박혀 `T::class`,
  `is T`가 가능 (그래서 `objectMapper.readValue<List<OrderDto>>(json)`
  확장함수가 TypeReference 없이 동작)
- **C#** — reified generics라 `typeof(T)`, `new T()`(제약 하에)가 그냥 된다

---

## 4. 한 문장 결론 (모범답안 요약)

> 타입 소거는 제네릭 타입 검사를 컴파일 타임에 끝낸 뒤 타입 파라미터를
> bound(없으면 Object)로 치환하고 캐스트를 삽입해, **런타임 바이트코드에는
> 타입 인자가 남지 않는** Java 5의 하위 호환 설계다. 그래서 `new T()`,
> `instanceof List<String>`, 제네릭 배열, 타입 인자만 다른 오버로딩이
> 불가능하고, raw type으로 우회하면 힙 오염이 생긴다.
> 실무에서는 JSON 역직렬화에서 `List.class`로는 원소 타입을 전달할 수 없어
> `LinkedHashMap`이 돌아오는 문제로 가장 자주 만나며, 클래스 메타데이터의
> 제네릭 시그니처는 소거되지 않는다는 점을 이용한 super type token
> (`TypeReference`, `ParameterizedTypeReference`의 익명 서브클래스)으로 푼다.

### 실무 경험 답변 예시 (질문 후반부 대응)

> "외부 API 응답을 `objectMapper.readValue(json, List.class)`로 받았는데,
> 컴파일도 되고 역직렬화도 성공하는데 한참 뒤 DTO 필드에 접근하는 지점에서
> `LinkedHashMap cannot be cast to ...` 예외가 터진 적이 있습니다.
> 소거 때문에 `List.class`로는 원소 타입이 전달되지 않아 Jackson이 기본값인
> Map으로 채운 것이 원인이었고, `new TypeReference<List<OrderDto>>() {}`로
> 해결했습니다. 익명 서브클래스의 extends 절에 박힌 제네릭 시그니처는
> 소거되지 않고 리플렉션으로 읽을 수 있다는 super type token 패턴이라는 걸
> 그때 알게 됐습니다. 이후로는 Redis 캐시 역직렬화, RestTemplate의
> `ParameterizedTypeReference`처럼 '런타임에 제네릭 타입이 필요한 경계'를
> 만나면 타입 토큰을 명시하는 습관이 생겼습니다."

---

## 부록: 자주 헷갈리는 포인트 Q&A

**Q1. 소거되는데 어떻게 컴파일러는 타입 안전을 보장하나?**
→ 검사가 전부 컴파일 타임에 끝나기 때문. 통과한 코드는 캐스트가 자동
삽입된 상태로 소거돼도 안전하다. 단 raw type/unchecked 캐스트로 검사를
우회하면 런타임은 막아주지 않는다(힙 오염). (§1, §2)

**Q2. 런타임에 제네릭 정보가 "전부" 사라지나?**
→ 아니다. **인스턴스**는 타입 인자를 모르지만, 클래스 메타데이터의
제네릭 **시그니처**(필드·메서드 선언, extends 절)는 남아 리플렉션으로
읽을 수 있다. TypeReference·ParameterizedTypeReference·Spring의
ResolvableType이 전부 이걸 이용한다. (§3-1)

**Q3. `new TypeReference<List<OrderDto>>() {}` 끝의 `{}`는 왜 붙나?**
→ 익명 서브클래스를 만들기 위해서다. `extends TypeReference<List<OrderDto>>`
라는 선언이 그 익명 클래스의 메타데이터에 박제되고, Jackson이
`getGenericSuperclass()`로 읽는다. `{}`를 빼면 그냥 인스턴스 생성이라
(추상 클래스라 컴파일도 안 되지만) 타입 정보를 얻을 수 없다. (§3-1)

**Q4. 배열은 되는데 제네릭 배열은 왜 안 되나?**
→ 배열은 런타임에 원소 타입을 검사하는 reified 구조(공변)라서
`new T[10]`을 지원하려면 런타임에 T를 알아야 하는데 소거로 모른다.
그래서 컬렉션 내부는 `Object[]`를 들고 꺼낼 때 캐스트하는 관용구를 쓴다. (§2, §3-3)

**Q5. `List<String>` 받는 메서드와 `List<Integer>` 받는 메서드를 오버로딩하면?**
→ 컴파일 에러. 소거 후 두 메서드의 시그니처가 `f(List)`로 동일해지기
때문이다. 런타임에 구분 못 하는 게 아니라 아예 클래스 파일을 만들 수 없다. (§2)

**Q6. 왜 C#처럼 reified로 만들지 않았나?**
→ 제네릭 도입(Java 5) 시점에 이미 방대한 raw type 기반 코드·바이트코드가
있었고, 소거 방식이면 JVM 변경 없이 기존 코드와 완전 호환된다.
C#은 CLR 수정 비용을 치르고 reified를 택한 것 — 트레이드오프다. (§1)

**Q7. Kotlin의 reified는 소거를 없앤 건가?**
→ 아니다. Kotlin도 기본은 JVM 소거를 따른다. `inline fun <reified T>`는
함수 본문이 호출 지점에 인라인 복사되면서 T 자리에 실제 타입이 박히는
것 — 컴파일 트릭이지 런타임 타입 유지가 아니다. 그래서 inline 함수에서만
가능하다. (§3-4)

**Q8. 브리지 메서드는 왜 필요한가?**
→ `Comparable<MyClass>`를 구현하면 내 메서드는 `compareTo(MyClass)`인데,
소거된 인터페이스의 시그니처는 `compareTo(Object)`다. 이 불일치를 메꾸려고
컴파일러가 `compareTo(Object)` → 캐스트 후 위임하는 합성 메서드를 만든다.
리플렉션에서 메서드가 두 개 보이는 이유. (§1)
