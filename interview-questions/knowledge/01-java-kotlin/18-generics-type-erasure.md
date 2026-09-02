# 제네릭의 타입 소거 — 컴파일러만 아는 타입, 그리고 그 대가

> 핵심 관전 포인트: **Java 제네릭은 "컴파일러만 아는 타입"이다. 컴파일러가 타입 검사를 전부 끝낸 뒤 타입 파라미터를 지우고(제약이 없으면 `Object`, `T extends Number`면 `Number`로 치환) 값을 꺼내는 자리마다 캐스트를 심는 방식이라, 실행 중인 JVM은 `List<String>`과 `List<Integer>`를 구분하지 못한다. Java 5에서 제네릭을 도입할 때 이미 세상에 배포돼 있던 `List` 코드·바이너리와 그대로 섞여 돌아가야 했기 때문에 선택한 설계이고, 그 대가로 "런타임에 T가 뭔지 알아야 하는 모든 일"이 막힌다 — `new T[]`, `instanceof List<String>`, 타입 인자만 다른 오버로딩이 전부 불가능하고, raw type으로 검사를 우회하면 힙 오염이 생긴다. 실무에서는 JSON 역직렬화에서 가장 자주 부딪히며, 클래스 선언문의 제네릭 시그니처는 소거되지 않는다는 예외를 이용한 super type token(`TypeReference`의 익명 하위 클래스)으로 푼다. 그리고 제네릭은 무공변이라 `List<String>`이 `List<Object>`의 하위 타입이 아니므로, API 시그니처는 PECS — 읽기만 하는 파라미터는 `? extends`, 쓰기만 하는 파라미터는 `? super` — 로 유연성을 되찾는다.**

---

## 0. 질문 + 의도

**질문**: "제네릭의 타입 소거(type erasure)란? 런타임에 타입 정보가 없어서 생기는 실무 제약은? 와일드카드(`? extends`, `? super`)의 사용 기준(PECS)은?"

**출제 의도**: 제네릭이 컴파일 타임 전용 장치임을 알아야 런타임 타입 분기가 안 되는 이유, 직렬화 라이브러리가 TypeReference 같은 우회를 쓰는 이유가 이해된다. PECS는 공통 모듈·라이브러리의 API 시그니처를 설계하는 사람과 소비만 하는 사람을 가르는 표지다.

## 1. 타입 소거란 무엇인가 — 소스, 컴파일러, 바이트코드를 나란히 놓고 본다

### 1-1. "컴파일 타임에만 존재한다"는 말의 실감

타입 소거를 설명하는 문장은 대개 이렇게 시작한다. "제네릭 타입 정보는 컴파일 타임에만 존재하고 런타임에는 지워진다."

이 문장은 맞지만, 처음 읽으면 아무 실감이 없다. 내가 쓴 `List<String>`이 어느 순간에 어떻게 사라진다는 것인지가 그려지지 않기 때문이다. 그래서 여기서는 **같은 코드를 세 단계로 나란히 놓고** 본다. ① 내가 쓴 소스, ② 컴파일러가 타입 검사를 마친 뒤 만들어내는 코드, ③ 실제로 클래스 파일에 남은 바이트코드.

**① 내가 쓴 소스**

```java
static String demo() {
    List<String> list = new ArrayList<>();
    list.add("hello");
    return list.get(0);   // 캐스트를 안 썼는데도 String이 나온다
}
```

**② 컴파일러가 만들어내는 코드 (개념적으로 이런 변형이 일어난다)**

```java
static String demo() {
    List list = new ArrayList();          // <String>이 통째로 사라졌다 (raw type과 같은 모양)
    list.add("hello");                    // add(Object)를 부르는 것이 된다
    return (String) list.get(0);          // get은 Object를 돌려주므로 캐스트가 필요한데,
}                                         // 그 캐스트를 컴파일러가 대신 써 넣었다
```

여기서 중요한 것은 **캐스트가 사라진 게 아니라 자리를 옮겼다는 점**이다. 제네릭 이전에 우리가 손으로 쓰던 `(String)` 캐스트를 컴파일러가 대신 써 준다. 제네릭의 가치는 "캐스트가 없어졌다"가 아니라 **"컴파일러가 검사를 끝낸 뒤에 캐스트를 넣어주므로 그 캐스트가 실패할 수 없다"**는 것이다.

**③ 실제 바이트코드** — 여기까지 봐야 실감이 온다. 위 코드를 컴파일하고 `javap -c`(바이트코드를 사람이 읽을 수 있게 풀어 보여주는 JDK 기본 도구)로 열어 보자.

```
$ javap -c -s Demo.class

  static java.lang.String demo();
    descriptor: ()Ljava/lang/String;
    Code:
       0: new           #7    // class java/util/ArrayList
       3: dup
       4: invokespecial #9    // Method java/util/ArrayList."<init>":()V
       7: astore_0
       8: aload_0
       9: ldc           #10   // String hello
      11: invokeinterface #12,  2   // InterfaceMethod java/util/List.add:(Ljava/lang/Object;)Z
      16: pop
      17: aload_0
      18: iconst_0
      19: invokeinterface #18,  2   // InterfaceMethod java/util/List.get:(I)Ljava/lang/Object;
      24: checkcast     #22   // class java/lang/String
      27: areturn
```

세 줄만 짚으면 된다.

- `List.add:(Ljava/lang/Object;)Z` — 내가 부른 것은 `add(String)`이었는데 **바이트코드에 남은 것은 `add(Object)`다.** `<String>`은 여기 없다.
- `List.get:(I)Ljava/lang/Object;` — `get`도 `Object`를 돌려준다고 적혀 있다.
- `checkcast class java/lang/String` — 그 바로 다음 줄에 **컴파일러가 심어 놓은 캐스트 명령**이 있다. ②에서 개념적으로 설명한 `(String)`이 실제 명령어로 존재하는 것을 눈으로 확인할 수 있다.

즉 **`List<String>`이라는 글자는 이 메서드의 실행 코드 어디에도 남아 있지 않다.** 남은 것은 `Object`로 주고받는 옛날 코드 + 꺼낼 때의 캐스트 한 방이다.

### 1-2. 컴파일러가 하는 일 세 가지

지금까지 본 변형을 정리하면 컴파일러의 작업은 셋이다.

**첫째, 타입 파라미터를 지운다.** 지울 때 무엇으로 바꾸느냐는 **경계(bound)**가 있느냐로 갈린다. 경계란 `T extends Number`처럼 "T는 적어도 이것의 하위 타입이어야 한다"고 적어 둔 상한이다.

- 경계가 없는 `<T>` → `Object`
- `<T extends Number>` → `Number` (첫 번째 경계로 치환)

경계가 있으면 그것으로 치환하는 이유는 간단하다. **T 자리에 무엇이 오든 최소한 `Number`이므로, `Number`로 적어 두면 `doubleValue()` 같은 메서드 호출이 바이트코드 상에서도 성립**하기 때문이다. `Object`로 지워 버리면 그 호출이 깨진다.

실제로 확인해 보면 이렇다.

```java
static <T extends Number> T first(List<T> list) {
    return list.get(0);
}
```

```
  static <T extends java.lang.Number> T first(java.util.List<T>);
    descriptor: (Ljava/util/List;)Ljava/lang/Number;
                                    ^^^^^^^^^^^^^^^^^
                        T가 Number로 치환됐고, List<T>는 그냥 List가 됐다
```

**여기서 이상한 점이 하나 보인다.** `descriptor`는 소거된 모습인데, 그 위의 선언 줄에는 `<T extends java.lang.Number> T first(java.util.List<T>)`라고 **제네릭이 그대로 적혀 있다.** javap이 지어낸 것이 아니다. 클래스 파일에는 실행에 쓰이는 `descriptor`와 별개로 **Signature 속성**이라는 자리가 있고, 컴파일러가 원래의 제네릭 선언을 거기에 문자열로 기록해 둔다.

이 예외를 지금 기억해 두자. 3-1의 `TypeReference` 트릭이 전부 이 한 줄에서 나온다.

**둘째, 꺼내는 자리마다 캐스트를 심는다.** 1-1의 `checkcast`가 그것이다.

**셋째, 브리지 메서드(bridge method)를 만든다.** 이건 설명이 필요하다.

`Comparable<T>`는 소거되면 `compareTo(Object)`가 된다. 그런데 내가 `Comparable<Money>`를 구현하며 쓴 메서드는 `compareTo(Money)`다. **시그니처가 다르므로 이대로는 인터페이스를 구현한 것이 되지 않는다.** JVM은 `compareTo(Object)`를 찾는데 클래스에는 `compareTo(Money)`밖에 없기 때문이다.

이 틈을 메우려고 컴파일러가 `compareTo(Object)`를 하나 더 만들어 준다. 다리를 놓아 준다고 해서 브리지(bridge) 메서드다.

```java
public class Money implements Comparable<Money> {
    long amount;
    public int compareTo(Money o) { return Long.compare(amount, o.amount); }
}
```

```
$ javap -c Money.class

  public int compareTo(Money);        <- 내가 쓴 메서드
    ...

  public int compareTo(java.lang.Object);   <- 컴파일러가 만든 브리지
    Code:
       0: aload_0
       1: aload_1
       2: checkcast     #8    // class Money      <- Object를 Money로 캐스트하고
       5: invokevirtual #19   // Method compareTo:(LMoney;)I   <- 진짜 메서드로 넘긴다
       8: ireturn
```

소스에는 메서드가 하나인데 클래스 파일에는 둘이다. **리플렉션으로 메서드 목록을 뽑았을 때 같은 이름이 두 개 보이는 이유**가 이것이다.

이게 실무에서 문제가 되는 자리는 애너테이션 기반 프레임워크나 AOP를 직접 만들 때다. `getDeclaredMethods()`로 메서드를 훑으면 소스에는 하나뿐인 메서드가 둘로 잡혀 같은 처리를 두 번 하게 된다. 그래서 이런 코드는 `Method.isBridge()`가 true인 것을 걸러내야 한다.

### 1-3. 결과 — 런타임의 JVM은 두 리스트를 구분하지 못한다

여기까지 오면 다음 결과가 당연해진다.

```java
new ArrayList<String>().getClass() == new ArrayList<Integer>().getClass()   // true
```

`<String>`도 `<Integer>`도 실행 코드에 남지 않았으니, 두 객체는 **똑같이 `java.util.ArrayList` 클래스의 인스턴스**다. 클래스 객체가 하나뿐이므로 `==`가 참이다.

비유하면 이렇다. 제네릭은 **공장 검수원**이다. 부품을 조립 라인에 올리기 전에 규격이 맞는지 전부 확인하고, 통과한 것만 상자에 담아 내보낸다. 그런데 **상자에는 "String 전용"이라는 라벨을 붙이지 않는다.** 검수를 이미 끝냈으니 라벨이 필요 없다는 판단이다. 검수원이 제대로 일한 한 문제가 없지만, 누군가 검수를 건너뛰고 상자에 물건을 넣으면(2-2의 raw type) 아무도 못 막는다.

### 1-4. 왜 이렇게 설계했나 — 2004년에 이미 세상에 있던 코드

"C#은 런타임에도 제네릭 타입을 유지하는데 Java는 왜 지웠나"는 질문에는 **역사적 배경**이 답이다. 결론만 외우면 꼬리질문에서 무너지므로 상황부터 보자.

제네릭이 Java에 들어온 것은 **Java 5(2004년)**다. Java 1.0이 1996년이니 그 시점에 이미 8년치 코드가 세상에 깔려 있었다. 그리고 그 코드들은 전부 이렇게 생겼다.

```java
List list = new ArrayList();          // 타입 인자가 없다. 당시엔 문법 자체가 없었다
list.add("hello");
String s = (String) list.get(0);      // 캐스트는 사람이 직접 썼다
```

이 상태에서 제네릭을 도입하려면 답해야 하는 질문이 있다. **"`List<String>`은 기존의 `List`와 같은 것인가, 다른 것인가?"** 이 질문의 답에 따라 길이 두 갈래로 갈린다.

**길 A — 소거(erasure).** `List<String>`을 실행 시점에는 그냥 `List`로 취급한다. 그러면 새로 컴파일한 제네릭 코드와 예전에 컴파일된 `.class` 파일이 **같은 클래스를 가리키므로 그대로 섞여 돌아간다.** JVM은 한 줄도 고칠 필요가 없다.

**길 B — 실체화(reification).** `List<String>`과 `List<Integer>`를 런타임에도 서로 다른 타입으로 유지한다. 그러려면 **JVM 자체가 타입 인자를 이해하도록 고쳐야 한다.** 그리고 예전에 컴파일된 `List` 기반 바이트코드는 이 새 세계에서 어떤 타입인지 애매해진다.

Java가 A를 고른 핵심 이유는 **마이그레이션 호환성(migration compatibility)**이다. 이건 단순한 "옛날 코드가 안 깨진다"보다 강한 요구다.

- 기존에 컴파일된 라이브러리 `.jar`를 **다시 컴파일하지 않고** 새 코드와 섞어 쓸 수 있어야 한다.
- 반대로 `java.util.Collections` 같은 표준 라이브러리를 제네릭으로 고쳐도, 그것을 raw type으로 쓰던 **기존 호출부가 그대로 컴파일되고 그대로 실행돼야** 한다.

소거 방식이면 이 둘이 공짜로 성립한다. `List<String>`도 결국 `List`이기 때문이다. 그래서 Java 5는 "표준 라이브러리를 통째로 제네릭화했는데 세상의 아무 코드도 안 깨지는" 전환을 해냈다.

C#은 반대로 갔다. **C# 2.0(2005년)에서 CLR(런타임)을 직접 수정해** 실체화 제네릭을 넣었다. 그래서 C#에서는 `typeof(T)`, 제약이 있으면 `new T()`가 그냥 된다. 이게 가능했던 배경은 .NET이 2002년에 나온 신생 플랫폼이라 **고쳐야 할 배포된 자산이 훨씬 적었다**는 점이다.

**정리하면 트레이드오프다.** Java는 "런타임 능력"을 내주고 "기존 자산과의 호환"을 샀다. 지금부터 볼 모든 제약은 그때 지불한 값의 청구서다.

## 2. 소거가 언어 차원에서 막는 것들

### 2-1. 컴파일조차 안 되는 코드들

먼저 목록으로 보고, 그다음 중요한 것들을 하나씩 풀어 본다.

| 못 쓰는 코드 | 막히는 이유 |
|---|---|
| `new T()` | 런타임에 T가 무엇인지 모르니 어느 클래스의 생성자를 부를지 결정할 수 없다 |
| `new T[10]` | 배열은 실행 중에 원소 타입을 기억하고 검사하는데, T를 모르니 기억시킬 타입이 없다 |
| `o instanceof List<String>` | 실행 중에는 전부 그냥 `List`라 `<String>` 여부를 판정할 수단이 없다 (`List<?>`만 허용) |
| `T.class`, `List<String>.class` | 그런 Class 객체가 아예 존재하지 않는다. `List.class` 하나뿐이다 |
| `catch (T e)` | 예외 매칭은 실행 중 타입 비교로 이뤄진다 |
| static 필드에 T 사용 | static은 클래스당 하나인데 T는 인스턴스마다 다르다 |
| `f(List<String>)`과 `f(List<Integer>)` 오버로딩 | 소거하면 둘 다 `f(List)`가 되어 시그니처가 충돌한다 |

실제 컴파일 에러 메시지는 이렇게 나온다(JDK 21 기준).

```
error: generic array creation
    T[] make() { return new T[10]; }

error: Object cannot be safely cast to List<String>
    boolean check(Object o) { return o instanceof List<String>; }

error: non-static type variable T cannot be referenced from a static context
    static T shared;

error: name clash: f(List<Integer>) and f(List<String>) have the same erasure
    void f(List<Integer> a) {}
```

이 중 셋은 이유를 한 겹 더 들어가야 한다.

**`new T[10]`이 왜 막히는가.** 배열은 제네릭과 반대로 **실체화(reified)** 되어 있다. `new String[10]`을 만들면 그 배열 객체는 자기가 String 전용이라는 사실을 실행 중에도 기억하고, 원소를 저장할 때마다 JVM이 그 타입을 확인한다. 그런데 `new T[10]`은 만드는 시점에 T가 무엇인지 알 수 없으므로 **기억시킬 타입 자체가 없다.** 배열의 자기 검사 기능이 성립하지 않는 것이다. 그래서 컬렉션 구현체들은 내부에 `Object[]`를 들고 꺼낼 때 캐스트하는 관용구를 쓴다(`ArrayList` 내부도 `Object[] elementData`다).

**`instanceof List<String>`이 왜 막히는가.** `instanceof`는 **실행 중에 객체의 실제 클래스를 확인하는 연산**이다. 그런데 1-3에서 봤듯 실행 중의 리스트는 전부 똑같은 `ArrayList` 클래스다. 확인할 근거가 존재하지 않으므로 컴파일러가 아예 문법으로 막는다. `o instanceof List<?>`는 허용되는데, 이건 "원소 타입은 묻지 않고 List인지만 본다"는 뜻이라 실행 중에 판정이 가능하기 때문이다.

**static 필드에 T를 왜 못 쓰는가.** 이건 소거와 조금 결이 다른, **더 근본적인 이유**다. `Box<String>`과 `Box<Integer>`를 만들어도 클래스는 `Box` 하나이고, static 필드는 그 클래스에 하나만 존재한다. 그런데 T는 인스턴스마다 달라야 한다. `Box<String>`의 T와 `Box<Integer>`의 T가 같은 저장 공간을 공유하면 의미가 성립하지 않는다. 소거가 없더라도 이 모순은 남는다.

### 2-2. 힙 오염 — 소거가 열어 둔 뒷문

**힙 오염(heap pollution)**은 `List<String>`이라고 선언된 변수가 가리키는 실제 객체 안에 String이 아닌 것이 들어가 있는 상태다. "변수의 선언 타입"과 "힙에 놓인 객체의 실제 내용물"이 어긋난 것이고, 그 어긋난 객체가 힙에 존재하므로 힙이 오염됐다고 부른다.

이 상태가 만들어지는 뒷문이 **raw type** — 타입 인자를 아예 붙이지 않고 쓰는 `List` 같은 형태다. Java 5 이전 코드와 섞여 돌아가야 했으므로(1-4) raw type은 지금도 **컴파일 에러가 아니라 경고**로만 처리된다.

```java
List<String> strings = new ArrayList<>();  // ① String만 담기로 한 리스트
List raw = strings;                        // ② raw 변수로 같은 객체를 가리킨다
raw.add(42);                               // ③ Integer가 들어간다 (힙 오염 발생)
String s = strings.get(0);                 // ④ ClassCastException
```

단계별로 누가 왜 못 막는지 따라가 보자.

| 단계 | 무슨 일이 일어나나 | 왜 아무도 못 막나 |
|---|---|---|
| ② 대입 | `strings`와 `raw`가 **같은 ArrayList 객체**를 가리키게 된다 | raw type은 "옛날 방식으로 쓰겠다"는 선언이라 경고만 하고 허용한다 |
| ③ add | Integer 42가 `List<String>` 안으로 들어간다 | 컴파일러는 raw type이라 원소 타입을 검사하지 않는다. 런타임은 소거 때문에 이 객체가 String용이었다는 사실 자체를 모른다(내부는 그냥 `Object[]`다) |
| ③ 직후 | **아무 예외도 안 터진다.** 시한폭탄만 설치된 상태 | 이 순간이 힙 오염이다 |
| ④ get | 컴파일러가 심어 둔 `checkcast String`에서 터진다 | 꺼낸 것이 Integer이기 때문 |

여기서 얻을 통찰이 둘이다.

**첫째, 제네릭의 타입 안전성은 컴파일러 검사가 전부다.** 컴파일러는 안 봤고(raw type이라서), 런타임은 볼 능력이 없으니(소거되어서) 아무도 못 막는다. 1-3의 비유로 돌아가면, 검수를 건너뛰고 상자에 물건을 넣은 것이다.

**둘째, 터지는 위치와 원인 위치가 다르다.** 원인은 ③의 `add`인데 예외는 ④의 `get`에서 난다. 실무에서 이 둘은 다른 클래스, 다른 모듈, 심지어 다른 날일 수 있다. 스택트레이스는 무고한 ④만 가리키므로 원인 추적이 어렵다.

**대비 — 배열이었다면 넣는 즉시 터진다.**

```java
Object[] arr = new String[10];
arr[0] = 42;
// 실행 결과: Exception in thread "main" java.lang.ArrayStoreException: java.lang.Integer
```

배열은 실체화되어 있어 저장할 때마다 JVM이 원소 타입을 확인하므로 **넣는 그 줄에서** 잡아낸다. 제네릭은 컴파일에 잡고 배열은 실행에 잡는다 — 둘 다 잡기는 하지만, 잡는 시점이 다르고 **제네릭은 검사를 건너뛸 뒷문이 있다**는 것이 차이다.

### 2-3. 제네릭 가변인자와 `@SafeVarargs`

힙 오염이 raw type 없이도 생기는 자리가 하나 더 있다. **제네릭 가변인자(`T... args`)**다.

가변인자는 컴파일러가 **배열을 하나 만들어서** 넘기는 문법 설탕이다. 그런데 `T...`의 T는 소거되므로 실제로 만들어지는 배열은 `T[]`가 아니라 `Object[]`다. 여기서 2-1에서 본 "제네릭 배열은 못 만든다"는 제약과 정면으로 부딪힌다.

Effective Java에도 나오는 고전적인 예를 실제로 컴파일하고 실행해 보자.

```java
static <T> T[] toArray(T... args) { return args; }        // args의 실체는 Object[]
static <T> T[] pick(T a, T b) { return toArray(a, b); }

public static void main(String[] x) {
    String[] s = pick("a", "b");    // 여기서 터진다
}
```

컴파일하면 경고 두 개가 나온다.

```
warning: [unchecked] Possible heap pollution from parameterized vararg type T
    static <T> T[] toArray(T... args) { return args; }

warning: [unchecked] unchecked generic array creation for varargs parameter of type T[]
    static <T> T[] pick(T a, T b) { return toArray(a, b); }
```

그리고 실행하면 이렇게 터진다.

```
Exception in thread "main" java.lang.ClassCastException:
    class [Ljava.lang.Object; cannot be cast to class [Ljava.lang.String;
    at Var.main(Var.java:6)
```

무슨 일이 일어났는지 따라가 보자. `pick`의 T는 호출 지점에서 String이지만, `pick` 안에서 `toArray(a, b)`를 부를 때 컴파일러가 만드는 가변인자 배열은 **T가 소거된 `Object[]`**다. 그 `Object[]`가 그대로 반환돼 나오고, `main`에서 `String[]`에 대입하려는 순간 컴파일러가 심어 둔 캐스트가 실패한다. **배열 하나도 잘못 넣은 적이 없는데 배열의 타입 자체가 틀린 것**이다.

그래서 제네릭 가변인자를 쓰는 메서드는 기본적으로 "위험할 수 있다"는 경고를 매번 낸다. **`@SafeVarargs`**는 그 경고를 끄는 애너테이션인데, 그 의미는 "컴파일러가 검사해 줬다"가 아니라 **"이 메서드는 가변인자 배열에 아무것도 저장하지 않고, 그 배열의 참조를 밖으로 내보내지도 않는다고 내가 보증한다"**는 개발자의 선언이다.

```java
// 안전한 사용: 배열을 읽기만 하고, 배열 자체를 밖으로 내보내지 않는다
@SafeVarargs
static <T> List<T> listOf(T... args) {
    return new ArrayList<>(Arrays.asList(args));   // 내용을 복사해 담는다
}

// 위험한 사용: 배열의 참조를 그대로 반환한다 -> @SafeVarargs를 붙이면 안 된다
static <T> T[] toArray(T... args) { return args; }
```

두 조건 중 하나라도 어기면 `@SafeVarargs`는 거짓말이 되고, 위에서 본 `ClassCastException`이 호출자 쪽에서 터진다. `List.of`, `Arrays.asList`, `EnumSet.of` 같은 JDK 메서드들이 이 애너테이션을 달고 있는 이유가 여기 있다.

## 3. 실무 제약과 와일드카드 설계 — 어디서 부딪히고, 시그니처를 어떻게 쓰나

### 3-1. JSON 역직렬화 — 가장 흔한 조우 지점

실무에서 소거를 처음 만나는 자리는 대부분 여기다.

```java
// 컴파일도 되고 역직렬화도 "성공"하는데, 원하는 대로 동작하지 않는다
List<OrderDto> orders = objectMapper.readValue(json, List.class);
String id = orders.get(0).getId();
// ClassCastException: LinkedHashMap cannot be cast to OrderDto
```

Jackson은 JSON의 각 객체를 어떤 클래스로 만들지 **실행 중에** 알아야 한다. 그런데 우리가 넘긴 정보는 `List.class` 하나뿐이고, 거기에는 "원소가 OrderDto다"라는 내용이 없다 — 소거됐기 때문이다. 정보가 없으니 Jackson은 기본값인 `LinkedHashMap`으로 각 원소를 채운다. 그리고 2-2에서 본 것과 똑같은 패턴으로, **넣는 시점이 아니라 꺼내 쓰는 시점에** 터진다.

#### 해법의 출발점 — 타입 토큰

원래 이 문제를 푸는 방법은 단순하다. **타입 토큰(type token)** — 타입 정보를 실어 나르는 증표로 Class 객체를 같이 넘기는 것이다.

```java
OrderDto order = objectMapper.readValue(json, OrderDto.class);   // 이건 잘 동작한다
```

그런데 제네릭 앞에서 이 방법이 무력해진다. **`List<OrderDto>.class`라는 문법이 존재하지 않기 때문**이다(2-1의 표 참고). 증표로 쓸 물건 자체를 만들 수 없다.

#### 탈출구 — 소거가 못 지우는 곳이 하나 있다

1-2에서 기억해 두라고 한 예외가 여기서 쓰인다. **인스턴스의 타입 인자는 지워지지만, 클래스 선언문에 적은 제네릭은 클래스 파일의 Signature 속성에 남는다.**

```java
var list = new ArrayList<OrderDto>();                    // 인스턴스: <OrderDto> 소거됨
class MyRef extends TypeReference<List<OrderDto>> { }    // 클래스 선언: 안 지워진다
```

비유하면 이렇다. **물건(객체)에는 꼬리표가 안 붙지만, 설계도(클래스 파일)에 적힌 글자는 영원히 남는다.** 인스턴스의 타입 인자는 실행 중에 흘러가는 정보라 지워지지만, `extends` 절에 적은 것은 **소스에 고정된 텍스트**라서 컴파일러가 클래스 파일에 문서처럼 기록해 둔다.

남아 있으니 리플렉션으로 읽을 수 있다.

```java
Type t = MyRef.class.getGenericSuperclass();
// -> TypeReference<java.util.List<OrderDto>>     살아 있다
Type inner = ((ParameterizedType) t).getActualTypeArguments()[0];
// -> java.util.List<OrderDto>                    전달하고 싶던 바로 그 정보
```

#### 발상 — 클래스를 "타입을 적는 종이"로 쓴다

여기서 트릭이 나온다. **전달하고 싶은 타입을 `extends` 절에 적어 둔 일회용 클래스를 만들어서 넘기자.** `MyRef`가 하는 일은 아무것도 없다. 존재 이유는 오직 부모 선언 자리에 `List<OrderDto>`라는 글자를 실어 나르는 것뿐이다.

그런데 이런 클래스를 매번 이름 붙여 만드는 것은 번거롭다. 그래서 **익명 하위 클래스**로 줄인다.

```java
List<OrderDto> orders = objectMapper.readValue(
        json, new TypeReference<List<OrderDto>>() {});
//                                              ^^ 이 중괄호가 핵심이다
```

**`{}`는 장식이 아니라 "이름 없는 하위 클래스를 하나 정의하라"는 명령**이다. 컴파일하면 실제로 `호출클래스$1.class` 파일이 생기고, 거기에 `MyRef`와 똑같이 "부모: `TypeReference<List<OrderDto>>`"가 기록된다. `{}`를 빼면 그냥 인스턴스 생성이 되어(추상 클래스라 컴파일도 안 되지만) 클래스 파일이 생기지 않으므로 실을 곳이 없어진다.

받는 쪽 Jackson은 넘겨받은 객체에 `getClass()`를 호출해 그 익명 클래스로 올라간 뒤, 위에서 본 `getGenericSuperclass()`로 부모 선언을 읽는다. 이 패턴 전체를 **super type token**이라 부른다 — 타입을 실어 나르는 증표(type token)인데, 그 정보가 실린 위치가 **부모 타입 선언(super)**이라는 뜻이다.

같은 원리로 동작하는 API들이 여럿이다. Spring의 `ParameterizedTypeReference`(RestTemplate·WebClient), Gson과 Guava의 `TypeToken`이 전부 이것이다.

```java
ResponseEntity<List<OrderDto>> res = restTemplate.exchange(
        url, HttpMethod.GET, null, new ParameterizedTypeReference<List<OrderDto>>() {});
```

#### 주의 — 만능은 아니다

이 트릭은 **`extends` 절에 구체 타입을 직접 적을 때만** 동작한다.

```java
<T> List<T> parse(String json) {
    return mapper.readValue(json, new TypeReference<List<T>>() {});   // 동작하지 않는다
    // 클래스 파일에 박히는 것은 문자 그대로 "List<T>"이고,
    // T가 실제로 무엇인지는 여전히 어디에도 없다
}
```

이런 경우에는 우회할 방법이 없다. **호출자에게서 타입 토큰을 파라미터로 넘겨받아야 한다.**

### 3-2. 캐시·직렬화 계층

Redis 등에 JSON으로 저장한 제네릭 컬렉션을 꺼낼 때 3-1과 완전히 같은 문제가 재현된다. 역직렬화기가 원소 타입을 모르므로 `List<LinkedHashMap>`이 돌아온다.

캐시에서 더 고약한 것은 **터지는 위치가 더 멀다**는 점이다. 캐시 조회는 성공으로 끝나고, 한참 뒤 DTO 필드에 접근하는 지점에서 `ClassCastException`이 나므로 "이게 캐시 문제였구나"를 알아채기까지 시간이 걸린다. 게다가 캐시 미스일 때는 원본 조회 경로를 타서 멀쩡히 동작하므로 **캐시가 채워진 뒤에만 재현되는** 성격까지 붙는다.

예방은 **캐시 값의 타입을 설계 단계에서 명시**하는 것이다. 타입별로 캐시 매니저(직렬화기)를 나누거나, 컬렉션을 감싼 래퍼 DTO를 캐시 단위로 쓰거나, 직렬화 시 타입 정보를 함께 기록하는 설정(Jackson의 `activateDefaultTyping` 계열)을 쓴다. 마지막 방법은 역직렬화 시 임의 클래스를 만들 여지가 있어 보안상 신중해야 한다.

### 3-3. 프레임워크·공용 유틸을 만들 때

**타입별 분기가 안 된다.** `instanceof List<String>`이 불가능하므로, 타입에 따라 다르게 처리해야 하는 유틸은 `Class<T>`를 파라미터로 명시적으로 받는 관용구를 쓴다.

```java
public <T> T fromJson(String json, Class<T> type) { ... }   // 타입을 값으로 받아 온다
```

**제네릭 배열을 못 만든다.** 그래서 컬렉션·유틸 내부에서는 `(T[]) new Object[n]` 같은 unchecked 캐스트가 불가피하다. 이 캐스트는 **배열이 밖으로 새어 나가지 않는다는 전제에서만** 안전하다 — 2-3의 `@SafeVarargs` 조건과 같은 이야기다.

**타입 인자만 다른 오버로딩이 안 된다.** `process(List<UserDto>)`와 `process(List<OrderDto>)`를 나란히 둘 수 없으므로, 메서드 이름을 나누거나(`processUsers`/`processOrders`) 타입 토큰을 파라미터로 받아 구분한다.

**반대로, 남아 있는 시그니처를 이용하는 쪽도 있다.** Spring이 `List<UserHandler>` 같은 제네릭 빈 주입을 해내는 것이 그렇다. 주입 지점(필드나 생성자의 파라미터 시그니처)에 적힌 제네릭은 클래스 메타데이터에 남으므로, Spring은 그것을 `ResolvableType`으로 읽어 어떤 타입의 빈을 모아 넣을지 판단한다. 3-1의 `TypeReference`와 정확히 같은 원리다.

### 3-4. 와일드카드와 PECS — 무공변이라는 전제부터

여기서부터는 소거와는 다른 축의 이야기다. 소거가 "런타임에 못 하는 일"이라면, PECS는 **"컴파일 타임에 API를 어떻게 써야 유연해지는가"**의 문제다. 그리고 그 출발점은 리스코프 치환이 제네릭에서 성립하지 않는다는 사실이다.

#### 3-4-1. 전제 — `List<String>`은 `List<Object>`의 하위 타입이 아니다

**리스코프 치환 원칙(Liskov Substitution Principle)**은 "하위 타입은 상위 타입이 오는 자리에 대신 들어갈 수 있어야 한다"는 규칙이다. `String`은 `Object`의 하위 타입이므로, `Object`를 받는 자리에 `String`을 넘길 수 있다.

그렇다면 `List<String>`도 `List<Object>` 자리에 들어갈 수 있을까? 직관은 "그렇다"고 답하지만 **컴파일러는 거부한다.**

```java
List<Integer> ints = List.of(1, 2, 3);
double total = sum(ints);
// error: incompatible types: List<Integer> cannot be converted to List<Number>
```

왜 막는지는 **허용했다고 가정해 보면** 바로 드러난다.

```java
List<String> names = new ArrayList<>();
List<Object> objs = names;      // 가정: 이 대입이 허용된다면
objs.add(42);                   // objs는 Object 리스트니까 Integer도 넣을 수 있다
String s = names.get(0);        // 같은 객체인데 Integer가 나온다 -> ClassCastException
```

**허용하는 순간 2-2의 힙 오염이 raw type 없이도 만들어진다.** 그래서 제네릭은 **무공변(invariant)**으로 설계됐다. 타입 인자가 조금이라도 다르면 서로 아무 관계도 아니라는 뜻이다.

```
      Object                      List<Object>
        |                              |
      Number      이지만               |  (아무 선도 없다)
        |                              |
      Integer                     List<Integer>

값의 세계에서는 상속 관계가 있어도, 그것을 담은 List끼리는 관계가 없다.
```

#### 3-4-2. 대비 — 배열은 공변이라 런타임에 터진다

같은 질문을 배열에 던지면 답이 다르다. **`String[]`은 `Object[]`의 하위 타입이다.** 이것을 **공변(covariant)**이라고 한다.

왜 배열만 이런가. 배열은 Java 1.0부터 있었고 그때는 제네릭이 없었다. 공변을 허용하지 않으면 `void sort(Object[] a)` 같은 범용 메서드를 만들어도 `String[]`에 쓸 수 없어서, **어떤 범용 유틸도 작성할 수 없었다.** 그래서 공변을 허용하고, 대신 **검사를 런타임으로 미뤘다.**

```java
Object[] arr = new String[10];   // 컴파일 통과 (배열은 공변)
arr[0] = 42;
// Exception in thread "main" java.lang.ArrayStoreException: java.lang.Integer
```

배열은 자기가 String 전용이라는 사실을 실행 중에도 기억하고 있어서, 저장하는 순간 JVM이 확인하고 거부한다.

| | 배열 | 제네릭 |
|---|---|---|
| 하위 타입 관계 | 공변 — `String[]`은 `Object[]`다 | 무공변 — `List<String>`은 `List<Object>`가 아니다 |
| 원소 타입 검사 시점 | 런타임 (저장할 때마다) | 컴파일 타임 |
| 잘못 넣으면 | `ArrayStoreException` — 넣는 그 줄에서 | 컴파일 에러 — 애초에 못 넣는다 |

**둘 다 잘못된 저장을 막기는 한다. 다른 것은 언제 막느냐다.** 배열은 실행해 봐야 알고, 제네릭은 빌드에서 안다. Effective Java가 "배열보다 리스트를 써라"라고 하는 근거가 이 표 한 장에 다 들어 있다.

#### 3-4-3. 무공변의 대가 — API가 뻣뻣해진다

무공변은 안전하지만 **너무 뻣뻣하다.** 방금 본 예제를 다시 보자.

```java
// Before: 무공변 때문에 호출자가 좁아진다
public static double sum(List<Number> numbers) {
    double total = 0;
    for (Number n : numbers) total += n.doubleValue();   // 읽기만 한다
    return total;
}

List<Integer> ints = List.of(1, 2, 3);
sum(ints);   // 컴파일 에러: List<Integer> cannot be converted to List<Number>
```

이 메서드는 리스트에서 값을 **꺼내 읽기만** 한다. `List<Integer>`를 받아도 안전하다는 것을 사람은 알 수 있다. 그런데 시그니처가 `List<Number>`라 컴파일러는 거부한다. `List<Integer>`, `List<Double>`, `List<BigDecimal>`용 메서드를 따로 만들 수도 없다(2-1의 오버로딩 제약).

**이 뻣뻣함을 푸는 장치가 와일드카드 `?`다.** `?`는 "어떤 타입인지는 모르지만 하나로 고정된 어떤 타입"이라는 뜻이고, 여기에 경계를 붙여 범위를 좁힌다.

- `? extends Number` — Number이거나 그 하위 타입 중 **하나인데, 어느 것인지는 모른다**
- `? super Integer` — Integer이거나 그 상위 타입 중 **하나인데, 어느 것인지는 모른다**

"어느 것인지는 모른다"가 이 절 전체의 열쇠다. 무엇이 되고 무엇이 안 되는지가 전부 여기서 결정된다.

#### 3-4-4. `? extends` — 읽기는 되고 쓰기는 안 되는 이유

```java
public static double sum(List<? extends Number> numbers) {
    double total = 0;
    for (Number n : numbers) total += n.doubleValue();
    return total;
}

List<Integer> ints = List.of(1, 2, 3);
List<Double> doubles = List.of(1.5, 2.5);
sum(ints);      // 통과
sum(doubles);   // 통과
```

**읽기가 되는 이유**: 실제 타입 인자가 무엇이든 **Number의 하위 타입임은 확실하다.** 그러니 꺼낸 것을 `Number`에 담는 것은 언제나 안전하다.

**쓰기가 막히는 이유**: 컴파일러 입장에서 이 리스트는 `List<Integer>`일 수도, `List<Double>`일 수도, `List<BigDecimal>`일 수도 있다. 여기에 Integer를 넣었는데 실제로는 `List<Double>`이었다면? 힙 오염이다. **무엇을 넣어야 맞는지 결정할 수 없으므로 전부 막는다.**

```java
void produce(List<? extends Number> src) {
    Number n = src.get(0);   // OK
    src.add(1);              // 컴파일 에러
}
```

에러 메시지를 그대로 보면 컴파일러의 사고가 보인다.

```
error: incompatible types: int cannot be converted to CAP#1
    src.add(1);
            ^
  where CAP#1 is a fresh type-variable:
    CAP#1 extends Number from capture of ? extends Number
```

**`CAP#1`은 컴파일러가 "이 자리의 실제 타입 인자"에 임시로 붙인 이름**이다(capture, 포획). 이름은 붙였지만 정체는 모르므로, 그 자리에 넣을 수 있는 값을 만들어 낼 방법이 없다. 예외는 `null` 하나뿐이다 — null은 모든 참조 타입의 값이므로 무엇이든 상관없다.

#### 3-4-5. `? super` — 쓰기는 되고 읽기는 Object로만 되는 이유

방향이 정확히 반대다.

```java
public static void collectIds(List<? super Long> dst, List<Order> orders) {
    for (Order o : orders) dst.add(o.getId());   // Long을 넣기만 한다
}

List<Long> ids = new ArrayList<>();
List<Object> log = new ArrayList<>();
collectIds(ids, orders);   // 통과
collectIds(log, orders);   // 통과 - List<Object>도 받는다
```

**쓰기가 되는 이유**: 실제 타입 인자가 무엇이든 **Long이거나 Long의 상위 타입**이다. `List<Long>`이든 `List<Number>`든 `List<Object>`든, Long 하나를 넣는 것은 셋 다에서 안전하다.

**읽기가 막히는 이유**: 꺼낸 값의 타입이 Long인지 Number인지 Object인지 모른다. 확실한 것은 **적어도 Object이긴 하다**는 것뿐이다. 그래서 `Object`로 받는 것만 허용된다.

```java
void consume(List<? super Integer> dst) {
    dst.add(1);                  // OK
    Object o = dst.get(0);       // OK - Object까지는 보장된다
    Integer i = dst.get(0);      // 컴파일 에러
}
```

```
error: incompatible types: CAP#1 cannot be converted to Integer
  where CAP#1 is a fresh type-variable:
    CAP#1 extends Object super: Integer from capture of ? super Integer
```

그림으로 나란히 놓으면 대칭이 보인다.

```
List<? extends Number>          실제 타입 인자는 Number "아래" 어딘가
                                     Number
                                    /   |   \
                              Integer Double BigDecimal   <- 이 중 하나인데 모른다

   읽기: 무엇이 나오든 Number다              -> 안전, 허용
   쓰기: 무엇을 넣어야 맞는지 모른다          -> 금지

List<? super Integer>           실제 타입 인자는 Integer "위" 어딘가
                                     Object
                                       |
                                     Number
                                       |
                                     Integer            <- 이 중 하나인데 모른다

   쓰기: Integer는 저 셋 어디에나 들어간다   -> 안전, 허용
   읽기: Object라는 것만 보장된다            -> Object로만 허용
```

#### 3-4-6. PECS — 파라미터가 하는 일을 보고 고른다

이제 규칙을 이름으로 정리할 수 있다. **PECS: Producer-Extends, Consumer-Super.** 생산자면 extends, 소비자면 super라는 뜻이다.

여기서 생산자·소비자는 **메서드 입장에서 그 파라미터가 무엇을 하는지**를 기준으로 판단한다.

- **생산자(producer)** — 파라미터가 값을 **내놓고** 메서드가 그것을 읽는다. 메서드 안에서 `param.get(...)`, `for (X x : param)`만 나온다면 생산자다. → `? extends T`
- **소비자(consumer)** — 메서드가 값을 **건네고** 파라미터가 그것을 받아 담는다. 메서드 안에서 `param.add(...)`만 나온다면 소비자다. → `? super T`

읽기와 쓰기를 **둘 다** 한다면 와일드카드를 쓸 수 없다. 그냥 `List<T>`로 둔다 — 이것도 규칙의 일부다.

JDK 시그니처를 이 눈으로 다시 보면 전부 읽힌다.

```java
// src에서 읽어 dest에 쓴다. src는 생산자, dest는 소비자 - PECS가 한 줄에 다 들어 있다
public static <T> void copy(List<? super T> dest, List<? extends T> src)

// coll에서 원소를 꺼내 비교만 한다 - 생산자
public static <T extends Object & Comparable<? super T>> T max(Collection<? extends T> coll)

// mapper는 T를 받아(소비) R을 내놓는다(생산)
<R> Stream<R> map(Function<? super T, ? extends R> mapper)

// 정렬기는 리스트의 원소를 받아 비교한다 - 원소의 소비자
void sort(Comparator<? super E> c)
```

마지막 `Comparator<? super E>`가 실무에서 가장 자주 마주치는 형태다. 이 `? super` 덕분에 **상위 타입용으로 만들어 둔 비교기를 하위 타입 리스트 정렬에 재사용**할 수 있다.

```java
Comparator<Object> byString = Comparator.comparing(Object::toString);

List<String> names = new ArrayList<>(List.of("b", "a"));
names.sort(byString);   // Comparator<String>이 아닌데도 통과한다
// 시그니처가 Comparator<E>였다면 여기서 컴파일 에러가 났을 것이다
```

before/after로 정리하면 이렇다.

```java
// Before: 호출자가 정확히 그 타입으로만 리스트를 만들어야 한다
public static double sum(List<Number> numbers)
public static void collectIds(List<Long> dst, List<Order> orders)

// After: 파라미터가 하는 일에 맞춰 와일드카드를 붙인다
public static double sum(List<? extends Number> numbers)          // 읽기만 -> extends
public static void collectIds(List<? super Long> dst, ...)        // 쓰기만 -> super
```

**중요한 것은 이 변경으로 호출자 코드는 한 글자도 안 바뀐다는 점이다.** 바뀌는 것은 "어떤 리스트를 넘길 수 있느냐"뿐이다. 즉 **와일드카드는 API를 만드는 쪽이 감당하고, 쓰는 쪽은 이득만 본다.** 공용 모듈의 시그니처에서 이것을 챙기느냐가 갈리는 지점이다.

#### 3-4-7. 와일드카드를 쓰지 말아야 하는 자리

**반환 타입에는 쓰지 않는다.** 반환 타입에 와일드카드가 있으면 그것을 받는 쪽 변수에도 와일드카드가 따라붙고, 그 변수를 넘기는 다음 메서드에도 번져 나간다. 유연성을 주는 게 아니라 **호출자 코드 전체에 와일드카드를 전염시킨다.**

```java
// 이렇게 하지 않는다
public static List<? extends Number> loadAll() { ... }

List<? extends Number> ns = loadAll();
ns.add(BigDecimal.ONE);   // 호출자는 이제 아무것도 넣을 수 없다
```

**메서드 안에서 여러 자리를 같은 타입으로 묶어야 하면 와일드카드로는 안 된다.** `?`는 "이름 없는 하나의 타입"이라 두 자리가 같은 타입이라는 것을 표현하지 못한다. (가산점 포인트)

```java
// 컴파일 에러: ? 에는 아무것도 넣을 수 없다 (3-4-4)
public static void swap(List<?> list, int i, int j) {
    list.set(i, list.set(j, list.get(i)));
    // error: incompatible types: Object cannot be converted to CAP#1
}
```

이때 쓰는 것이 **캡처 도우미 메서드(capture helper)**다. 와일드카드에 `T`라는 이름을 붙여 주는 private 메서드를 하나 두고 위임한다.

```java
// 공개 시그니처는 와일드카드로 유연하게 두고
public static void swap(List<?> list, int i, int j) {
    swapHelper(list, i, j);
}
// 내부에서는 T라는 이름이 생겨 같은 타입임을 표현할 수 있다
private static <T> void swapHelper(List<T> list, int i, int j) {
    list.set(i, list.set(j, list.get(i)));
}
```

**정리하면 판단 기준은 이렇다.** 파라미터가 읽기 전용이면 `? extends`, 쓰기 전용이면 `? super`, 둘 다면 `T`, 반환 타입이면 와일드카드를 쓰지 않는다.

### 3-5. 대비 — 소거가 없는 언어에서는

**Kotlin**은 JVM 위에서 돌아가므로 기본은 Java와 같은 소거다. 다만 `inline fun <reified T>`라는 탈출구가 있다. `inline` 함수는 **호출 지점에 함수 본문이 그대로 복사**되는데, 그때 T 자리에 실제 타입이 문자 그대로 박힌다. 그래서 `T::class`, `is T`가 가능해진다.

```kotlin
// Jackson의 Kotlin 확장 - TypeReference 없이 동작하는 이유가 reified다
val orders: List<OrderDto> = objectMapper.readValue(json)
```

**이것은 런타임에 타입을 유지하는 것이 아니라 컴파일 타임의 코드 복사 트릭**이라는 점이 중요하다. 그래서 inline 함수에서만 쓸 수 있고, 일반 함수나 클래스의 타입 파라미터에는 `reified`를 붙일 수 없다.

**C#**은 1-4에서 본 대로 CLR이 제네릭을 이해하므로 `typeof(T)`, 제약이 있으면 `new T()`가 그냥 된다. 대가는 그 시점에 런타임을 고쳤다는 것이다.

### 3-6. 실무 경험 답변 예시

> "외부 API 응답을 `objectMapper.readValue(json, List.class)`로 받았는데, 컴파일도 되고 역직렬화도 성공하는데 한참 뒤 DTO 필드에 접근하는 지점에서 `LinkedHashMap cannot be cast to OrderDto` 예외가 터진 적이 있습니다. 소거 때문에 `List.class`로는 원소 타입이 전달되지 않아 Jackson이 기본값인 Map으로 채운 것이 원인이었고, `new TypeReference<List<OrderDto>>() {}`로 해결했습니다. 익명 하위 클래스의 extends 절에 박힌 제네릭 시그니처는 소거되지 않고 리플렉션으로 읽을 수 있다는 super type token 패턴이라는 걸 그때 알게 됐습니다. 이후로는 Redis 캐시 역직렬화, RestTemplate의 `ParameterizedTypeReference`처럼 '런타임에 제네릭 타입이 필요한 경계'를 만나면 타입 토큰을 명시하는 습관이 생겼습니다. 공용 모듈 시그니처를 쓸 때는 파라미터가 읽기만 하는지 쓰기만 하는지를 보고 `? extends`/`? super`를 붙이는데, 호출자 코드는 그대로인 채 받을 수 있는 타입만 넓어지기 때문에 라이브러리 쪽에서 챙기면 이득이 큰 부분이라고 생각합니다."

## 4. 꼬리질문 대비 포인트

### "소거되는데 컴파일러는 어떻게 타입 안전을 보장하나요?"

**검사가 전부 컴파일 타임에 끝나기 때문**이다. 컴파일러가 모든 `add`와 `get`의 타입을 확인하고, 통과한 코드에만 캐스트를 심어 소거한다. 검사를 이미 통과했으므로 그 캐스트는 실패할 수 없다.

바꿔 말하면 **컴파일러 검사가 유일한 방어선**이라는 뜻이기도 하다. raw type이나 unchecked 캐스트로 그 검사를 건너뛰면 런타임은 아무것도 막아주지 못한다(힙 오염, 2-2). 그래서 unchecked 경고를 그냥 지우지 말고, 안전하다고 확신할 때만 `@SuppressWarnings("unchecked")`를 **가능한 가장 좁은 범위에** 붙이고 왜 안전한지 주석으로 남기는 것이 관행이다.

### "런타임에 제네릭 정보가 '전부' 사라지나요? `TypeReference` 뒤의 `{}`는 왜 붙나요?" (시니어 변별 포인트)

**아니다. 이 구분을 못 하면 3-1의 TypeReference를 설명할 수 없다.**

- **인스턴스**는 타입 인자를 모른다. `new ArrayList<String>()`으로 만든 객체는 자기가 String용이라는 사실을 어디에도 갖고 있지 않다.
- **클래스 메타데이터의 제네릭 시그니처**는 남는다. 필드 선언, 메서드 선언, `extends`/`implements` 절에 적은 제네릭은 클래스 파일의 Signature 속성에 문자열로 기록되고 리플렉션으로 읽을 수 있다.

차이는 **"실행 중에 흘러가는 정보인가, 소스에 고정된 텍스트인가"**다. Jackson의 `TypeReference`, Spring의 `ParameterizedTypeReference`와 `ResolvableType`, Gson·Guava의 `TypeToken`이 전부 후자를 이용한다. Spring이 `List<UserHandler>` 빈 주입을 해내는 것도 같은 원리다(3-3).

그래서 `new TypeReference<List<OrderDto>>() {}` 끝의 `{}`가 필요하다. **익명 하위 클래스를 만들기 위해서다.** `{}`가 있으면 컴파일러가 `호출클래스$1.class`라는 클래스 파일을 실제로 하나 생성하고, 그 파일에 "부모는 `TypeReference<List<OrderDto>>`"라는 선언을 기록한다. Jackson은 넘겨받은 객체의 `getClass().getGenericSuperclass()`로 그 기록을 읽는다.

`{}`를 빼면 클래스 파일이 만들어지지 않으므로 타입 정보를 실을 곳이 사라진다(`TypeReference`가 추상 클래스라 애초에 컴파일도 안 된다). **`{}`는 문법 장식이 아니라 "클래스 파일을 하나 만들어라"는 명령**이라고 이해하면 정확하다.

### "배열은 되는데 제네릭 배열은 왜 안 되나요?"

두 가지가 얽혀 있다.

**첫째, 배열은 실체화되어 있다.** 배열 객체는 자기 원소 타입을 실행 중에도 기억하고 저장할 때마다 검사한다(그래서 `ArrayStoreException`이 존재한다). `new T[10]`을 지원하려면 만드는 순간 T를 알아야 하는데 소거 때문에 모른다.

**둘째, 배열은 공변이고 제네릭은 무공변이라 섞이면 안전성이 무너진다.** 만약 `new T[]`가 허용된다면 `T[]`를 `Object[]`에 대입하고 아무 값이나 넣는 경로가 열린다. 2-3에서 본 가변인자 사례가 바로 이 조합이 만들어 내는 실제 사고다.

그래서 컬렉션 내부는 `Object[]`를 들고 꺼낼 때 캐스트하는 관용구를 쓰고, Effective Java는 배열보다 리스트를 권한다.

### "왜 C#처럼 실체화 제네릭으로 만들지 않았나요? Kotlin의 `reified`는 소거를 없앤 건가요?"

**시점의 문제였다.** 제네릭이 들어간 Java 5는 2004년이고 Java 1.0은 1996년이다. 그 8년 동안 raw type 기반 코드와 컴파일된 바이너리가 세상에 쌓여 있었다. 실체화를 하려면 JVM을 고쳐야 하고, 기존 바이트코드가 새 타입 체계에서 어떤 위치인지가 애매해진다.

소거를 택하면 `List<String>`도 결국 같은 `List` 클래스이므로 **기존 라이브러리를 재컴파일하지 않고 섞어 쓸 수 있고, 표준 라이브러리를 제네릭화해도 기존 호출부가 그대로 컴파일된다.** 이 마이그레이션 호환성이 런타임 타입 능력보다 우선순위가 높다고 판단한 것이다.

C#은 2005년(C# 2.0)에 CLR을 고쳐 실체화를 넣었는데, .NET이 2002년에 나온 신생 플랫폼이라 감당해야 할 배포 자산이 훨씬 적었다. **어느 쪽이 옳다기보다 처한 상황이 달랐다**로 정리하는 편이 정확하다.

이어서 Kotlin을 묻는 경우가 많은데, **`reified`도 소거를 없앤 것이 아니다.** Kotlin 역시 JVM 위에서 돌아가므로 기본은 같은 소거다. `inline fun <reified T>`는 **함수 본문이 호출 지점에 인라인 복사되면서 T 자리에 실제 타입이 문자 그대로 박히는** 컴파일 트릭이다. 런타임이 타입을 기억하게 된 것이 아니라, 컴파일 시점에 각 호출마다 타입이 확정된 코드가 따로 생기는 것이다.

증거는 제약 자체다. `reified`는 **inline 함수에서만** 쓸 수 있고 클래스의 타입 파라미터에는 붙일 수 없다. 인라인될 자리가 없으면 트릭이 성립하지 않기 때문이다.

### "PECS를 실무 시그니처로 설명해 보세요." (시니어 변별 포인트)

전제부터 깐다. **제네릭은 무공변이라 `List<Integer>`를 `List<Number>` 자리에 넘길 수 없다.** 허용하면 그 리스트에 Double을 넣는 경로가 열려 힙 오염이 되기 때문이다. 그래서 안전한데 뻣뻣하다.

**와일드카드가 그 뻣뻣함을 푸는 장치**이고, 어느 쪽을 쓸지는 **그 파라미터가 메서드 안에서 무엇을 하는지**로 정한다.

- 값을 꺼내 읽기만 하면 생산자다 → `? extends T`. 실제 타입이 무엇이든 T의 하위 타입이라 읽어서 T에 담는 것은 항상 안전하고, 무엇을 넣어야 맞는지는 알 수 없어 쓰기가 막힌다.
- 값을 받아 담기만 하면 소비자다 → `? super T`. 실제 타입이 무엇이든 T의 상위 타입이라 T를 넣는 것은 항상 안전하고, 꺼내면 Object까지만 보장된다.
- 읽고 쓰기를 둘 다 하면 와일드카드를 쓰지 않고 `List<T>`로 둔다.

JDK에서 바로 짚을 수 있는 예로 `Collections.copy(List<? super T> dest, List<? extends T> src)`가 있다. 한 시그니처 안에 소비자와 생산자가 나란히 있다. 실무에서 가장 자주 만나는 것은 `list.sort(Comparator<? super E> c)`인데, 이 `? super` 덕분에 상위 타입용 비교기를 하위 타입 리스트에 재사용할 수 있다.

**반환 타입에는 쓰지 않는다**는 단서까지 붙이면 완성이다. 반환 타입의 와일드카드는 호출자 코드로 전염되어 유연성이 아니라 제약이 된다.

---

## 한 줄 요약

타입 소거는 컴파일러가 제네릭 타입 검사를 전부 끝낸 뒤 타입 파라미터를 경계(없으면 Object)로 치환하고 꺼내는 자리에 캐스트를 심어 **바이트코드에는 타입 인자를 남기지 않는** Java 5의 마이그레이션 호환성 설계이고, 그 대가로 `new T[]`·`instanceof List<String>`·타입 인자만 다른 오버로딩이 막히며 raw type이나 제네릭 가변인자로 검사를 우회하면 원인과 폭발 지점이 어긋나는 힙 오염이 생긴다 — 실무에서는 JSON 역직렬화에서 `List.class`로 원소 타입을 전달하지 못해 `LinkedHashMap`이 돌아오는 문제로 가장 자주 만나고, "클래스 선언문의 제네릭 시그니처는 소거되지 않는다"는 예외를 이용한 super type token(`TypeReference`의 익명 하위 클래스)으로 풀며, 여기에 더해 제네릭이 무공변이라 생기는 API의 뻣뻣함은 읽기 전용 파라미터에 `? extends`, 쓰기 전용 파라미터에 `? super`를 붙이는 PECS로 푸는 것까지가 이 질문의 완성형이다.
