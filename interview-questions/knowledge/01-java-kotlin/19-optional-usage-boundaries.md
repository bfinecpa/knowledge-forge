# Optional의 올바른 사용 범위 — 왜 필드·파라미터에는 쓰지 말라는가

> 핵심 관전 포인트: **Optional은 "null을 대체하는 범용 타입"이 아니라 "이 메서드는 결과가 없을 수도 있다"는 사실을 시그니처에 적어 넣기 위한 반환 전용 컨테이너다. Java 8 이전에는 메서드가 null을 돌려줄 수 있다는 사실이 시그니처 어디에도 안 적혀 있어서 호출자가 문서를 읽거나 운영 중 NPE를 맞고 배워야 했고, Optional은 그 사실을 타입으로 끌어올린 장치다. 설계자 Brian Goetz가 "라이브러리 메서드의 반환 타입에 한정한 장치"라고 못 박았고, 필드에 쓰는 순간 상태가 줄기는커녕 `null` / `Optional.empty()` / 값 존재의 셋으로 늘어나 null을 없애려던 도구가 null 검사와 isPresent 검사를 둘 다 요구하는 역설에 빠진다. 여기에 직렬화 불가, JPA 매핑 불가, 객체 할당 비용이 얹힌다. 파라미터에 쓰면 호출자 전원에게 포장 의무만 지우고 정작 null 유입은 못 막는다. 올바른 범위는 조회성 메서드의 반환 타입 + `map`/`orElseThrow` 체이닝으로 즉시 소비하는 데까지이고, 그 안에서도 `isPresent()`+`get()`은 `if (x != null)`의 장황한 재현일 뿐이며 `orElse`는 값이 있어도 인자를 먼저 평가한다는 함정이 남는다.**

---

## 0. 질문 + 의도

**질문**: "`Optional`을 필드나 메서드 파라미터에 쓰지 말라는 권고의 이유는? 실무에서 `Optional`의 올바른 사용 범위는 어디까지인가요?"

**출제 의도**: Optional을 필드·파라미터·컬렉션 원소에 쓰는 코드는 "null 안전"이 아니라 관용구 위반이다. 도구의 설계 의도(반환 타입으로 부재를 표현)를 이해하고 쓰는지 — 편리해 보이는 API를 원래 목적 밖으로 확장할 때 멈출 수 있는 절제가 있는지를 본다.

## 1. Optional의 설계 의도 — 무엇을 대체하러 나온 물건인가

### 1-1. 전제 — "null을 돌려줄 수 있다"는 사실은 어디에도 안 적혀 있었다

"Optional은 반환 타입 전용"이라는 결론부터 외우면 왜 그런지가 남지 않는다. 그러니 **Optional이 없던 시절에 무엇이 불편했는지**부터 보자.

```java
Member findByEmail(String email);
```

이 시그니처를 보고 답할 수 있는가. **이메일이 없는 회원을 조회하면 무엇이 반환되는가?**

가능한 답이 셋이다. null을 반환할 수도 있고, 예외를 던질 수도 있고, 빈 Member 객체를 만들어 줄 수도 있다. **시그니처는 이 중 어느 것인지 한 글자도 말해주지 않는다.** 호출자가 알 수 있는 방법은 셋뿐이었다.

- Javadoc을 읽는다 — 있다면. 그리고 그것이 최신이라면.
- 구현을 열어 본다 — 다른 팀 라이브러리라면 어렵다.
- 운영에서 NPE를 맞는다.

셋째가 실제로 가장 흔했다. 그리고 이 NPE가 고약한 것은 **터지는 곳이 원인에서 멀다**는 점이다.

```
findByEmail()이 null 반환
     |
     v
지역 변수에 담긴다        <- 여기서는 아무 일도 안 일어난다
     |
     v
다른 메서드에 인자로 넘어간다
     |
     v
필드나 컬렉션에 저장된다
     |
     v
한참 뒤, 전혀 다른 코드에서 member.getName() 호출  --> NPE 발생
     |
     +-- 스택트레이스는 이 지점만 가리킨다.
         "누가 null을 넣었는가"는 추적해서 거슬러 올라가야 한다.
```

Java 8 이전에 "결과가 없을 수 있는 메서드"를 만드는 사람에게는 나쁜 선택지 두 개밖에 없었다.

| 방식 | 문제 |
|---|---|
| `null` 반환 | 호출자가 null 검사를 잊으면 위 그림처럼 한참 뒤 엉뚱한 곳에서 NPE가 난다. 시그니처만 봐서는 null 가능성 자체를 알 수 없다 |
| 예외 던지기 | "없음"이 정상 흐름인데 예외로 표현하게 된다. 제어 흐름을 예외로 다루는 것도 문제고, 스택트레이스를 채우는 비용도 붙는다 |

즉 문제의 핵심은 **"없을 수 있다"는 정보가 타입 시스템 바깥에 있었다**는 것이다. 컴파일러도 IDE도 그 사실을 모르니 아무도 경고해 줄 수 없다.

### 1-2. 세 번째 선택지 — 그 사실을 타입으로 끌어올린다

Optional은 그 정보를 **반환 타입에 적어 넣는다.**

```java
Optional<Member> findByEmail(String email);
```

바뀐 것을 정확히 짚자. **null 검사가 사라진 것이 아니다.** 호출자가 값을 꺼내려면 반드시 Optional의 API를 거쳐야 하고, 그 API들이 전부 "없을 때는 어떻게 할지"를 함께 적도록 강제한다.

```java
// 값을 그냥 꺼낼 방법이 없다. 없을 때의 처리를 같이 적어야 값이 나온다
String name = memberRepository.findByEmail(email)
        .map(Member::getName)
        .orElse("탈퇴한 회원");

Member member = memberRepository.findByEmail(email)
        .orElseThrow(() -> new MemberNotFoundException(email));
```

비유하면 Optional은 **"내용물이 없을 수도 있음"이라고 인쇄된 상자**다. 상자 자체가 경고문이라, 받는 사람이 뜯기 전에 그 가능성을 인지하게 된다. 예전에는 상자 없이 물건을 그냥 건넸고, 손이 비어 있어도 받는 사람은 뭔가 받았다고 생각한 채 걸어가다 넘어졌다.

여기서 이미 **Optional이 어느 위치에서만 값을 하는지**가 드러난다. **경고문은 "건네는 순간"에만 의미가 있다.** 물건을 창고에 보관하는 데 이 상자를 쓰면 창고 공간만 먹고, 상자 자체를 잃어버릴 수도 있다(그게 2절의 이야기다).

### 1-3. 설계자가 못 박은 범위

이건 관습이나 스타일 취향이 아니다. Java 8의 람다·스트림 설계를 이끈 Brian Goetz가 Optional 도입 직후 공개 답변에서 범위를 명시적으로 좁혔다.

> "Optional is intended to provide a *limited* mechanism for library method **return types** where there needed to be a clear way to represent 'no result', and using null for such was overwhelmingly likely to cause errors."

문장에서 두 단어가 핵심이다. **limited**(제한적인)와 **return types**(반환 타입). 즉 **반환 타입, 그중에서도 "없음이 정상인 조회 결과"가 유일한 설계 목적**이었다. 필드, 파라미터, 컬렉션 원소는 처음부터 용도 밖이다.

그래서 이 질문의 답은 "필드에 쓰면 좀 안 예쁘다"가 아니라 **"애초에 그 자리를 위해 만들어진 물건이 아니고, 그 자리에 두면 구체적으로 이런 손해가 난다"**가 되어야 한다. 그 손해가 2절이다.

## 2. 쓰면 안 되는 자리와 그 이유

### 2-1. 필드 — 상태가 줄지 않고 늘어난다 (가장 강한 논거)

```java
private Optional<String> nickname;
```

null을 없애려고 감쌌다. 그런데 **이 필드가 가질 수 있는 상태를 세어 보면 늘어나 있다.**

```
String nickname                     Optional<String> nickname
(상태 2개)                           (상태 3개)

  +-- null                            +-- null                    (Optional 참조 자체가 null)
  |                                   |
  +-- "hanjoo"                        +-- Optional.empty()        ("값 없음"의 정상 표현)
                                      |
                                      +-- Optional.of("hanjoo")   (값 존재)

                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                        위의 둘은 "닉네임이 없다"는 같은 뜻인데
                        표현이 두 가지로 갈렸다
```

표로 다시 보면 각 상태가 어떻게 생기는지가 드러난다.

| 상태 | 의미 | 어떻게 만들어지나 |
|---|---|---|
| `nickname == null` | Optional 참조 자체가 null | 초기화되지 않은 필드, 리플렉션 기반 객체 생성(Jackson·JPA), 실수로 null 대입 |
| `Optional.empty()` | "값 없음"의 정상 표현 | 의도한 빈 상태 |
| `Optional.of("...")` | 값 존재 | 정상 값 |

네 번째 상태인 `Optional.of(null)`은 존재하지 않는다. `Optional.of`는 인자가 null이면 그 자리에서 NPE를 던지고, `Optional.ofNullable(null)`은 두 번째 상태로 수렴한다. 그래서 정확히 셋이다.

**문제의 본질은 개수가 아니라 첫째와 둘째가 의미가 같은데 표현이 다르다는 것**이다. 방어적으로 짜려면 이렇게 된다.

```java
// Before: plain 필드 - 검사 한 번
if (nickname != null) { use(nickname); }

// After(?): Optional 필드 - 검사 두 번. 나아진 것이 없다
if (nickname != null && nickname.isPresent()) { use(nickname.get()); }
```

**null을 제거하려던 도구가 "null인 Optional"이라는 새 케이스를 만들었고, 검사는 오히려 하나 늘었다.** 이것이 필드 금지의 가장 강한 논거다.

왜 반환 타입에서는 이 문제가 안 생기는지도 짚어야 한다. **지켜야 할 사람 수가 다르기 때문이다.**

- **반환값**: "이 메서드는 null을 반환하지 않는다"는 규약을 **그 메서드를 구현한 한 명**이 지키면 끝난다. 그리고 그 메서드는 대개 한 곳에 있다.
- **필드**: 생성자, 세터, 리플렉션으로 객체를 만드는 프레임워크, 나중에 필드를 하나 더 추가하는 사람까지 **그 클래스를 만지는 모두가** 규약을 지켜야 한다.

언어가 강제하지 못하는 규약은 참여자가 늘어날수록 반드시 깨진다. 필드는 참여자가 많은 자리다.

### 2-2. 필드 — 직렬화가 안 된다

`Optional`은 **`Serializable`을 구현하지 않는다.** 실수가 아니라 의도된 설계다. 반환 전용 장치라면 객체의 상태로 저장될 일이 없어야 한다는 입장이 코드로 표현된 것이다.

그래서 Optional 필드를 가진 클래스는 Java 직렬화를 쓰는 모든 경로에서 즉시 깨진다.

```java
public class MemberDto implements Serializable {
    private Optional<String> nickname;   // 이 필드 하나 때문에
}
// 직렬화 시도 -> java.io.NotSerializableException: java.util.Optional
```

실무에서 이 경로는 생각보다 여러 곳에 있다. Java 직렬화 기반 세션 저장소(Spring Session의 기본 직렬화 설정, 톰캣 세션 복제), 일부 캐시 구현체, RMI 계열 통신이 전부 여기에 해당한다.

### 2-3. 필드 — 프레임워크가 못 다룬다

**JPA/Hibernate.** 엔티티 필드는 DB 컬럼과 매핑되는 실제 타입이어야 한다. `Optional<String>`은 매핑 대상 타입이 아니라 그대로 두면 매핑에 실패한다. 절충안은 **필드는 nullable 실제 타입으로 두고 getter에서 감싸는 것**이다.

```java
@Entity
public class Member {
    private String nickname;   // 필드는 실제 타입. DB 컬럼과 1:1로 대응한다

    // 호출자에게는 "없을 수 있음"을 알린다
    public Optional<String> getNickname() {
        return Optional.ofNullable(nickname);
    }
}
```

**Jackson.** Optional은 그냥 두면 Jackson이 평범한 객체로 보고 그 안의 `isPresent()` 게터를 읽어 `{"present": true}` 같은 엉뚱한 JSON을 만든다. 이걸 제대로 다루려면 `jackson-datatype-jdk8` 모듈이 등록돼 있어야 한다(Spring Boot는 자동 등록해 준다).

모듈이 등록돼 있어도 **역직렬화 쪽에는 함정이 하나 남는다.** JSON에 그 프로퍼티가 아예 없으면 Jackson은 해당 필드를 건드리지 않고 지나간다. 그러면 그 필드는 **초기화되지 않은 null 그대로** 남는다 — 2-1에서 본 첫 번째 상태다. `Optional.empty()`가 아니라 진짜 null이므로, 그 필드에 `isPresent()`를 부르면 NPE가 난다.

**JavaBeans 규약.** 게터가 `Optional<String>`을 반환하면 "프로퍼티 `nickname`의 타입은 `String`"이라는 규약과 어긋난다. 리플렉션으로 프로퍼티 타입을 추론하는 도구(일부 매핑 라이브러리, 폼 바인딩, 리포팅 툴)에서 마찰이 생길 수 있다.

### 2-4. 필드 — 비용

Optional은 **값을 담은 별도의 힙 객체**다. 반환 후 즉시 소비하고 버리는 용법에서는 이 비용이 사실상 무시할 수준이고, JIT의 탈출 분석(escape analysis)으로 할당 자체가 사라지는 경우도 많다. **객체가 메서드 밖으로 새어 나가지 않는 것이 확인되면 힙에 만들지 않아도 된다는 최적화**다.

그런데 필드는 정확히 그 반대다. **객체와 함께 계속 살아 있고, 인스턴스 수만큼 곱해진다.** 수십만 건을 메모리에 올리는 조회나 배치에서는 이 곱셈이 GC 압력으로 나타난다.

원시 타입이면 더 나쁘다. `Optional<Integer>`는 **박싱된 Integer 객체 + 그것을 감싼 Optional 객체**로 래핑이 두 겹이 된다. 그래서 JDK는 이 경우를 위해 `OptionalInt`, `OptionalLong`, `OptionalDouble`을 따로 제공한다. 이들은 원시값을 그대로 들고 있어 박싱 한 겹이 사라진다.

```java
Optional<Integer> a = Optional.of(3);   // Integer 객체 + Optional 객체 = 2개
OptionalInt      b = OptionalInt.of(3); // Optional 객체 1개 (int를 직접 보관)
```

한 가지 더. Optional은 **값 기반 클래스(value-based class)**로 지정돼 있다. "이 타입의 인스턴스는 값으로만 다뤄야 하며 개별 객체의 정체성에 의존하지 말라"는 뜻이라, `==`로 비교하거나 `synchronized (opt)`로 락을 잡는 사용이 금지 대상이다. **오래 살아남는 자리(필드)에 둘수록 누군가 그런 코드를 쓸 여지가 커진다.**

### 2-5. 메서드 파라미터 — 호출자 전원에게 부담만 넘긴다

```java
// 잘못됨
void updateProfile(String name, Optional<String> nickname) { ... }
```

이유가 셋이다.

**첫째, 부담의 방향이 잘못됐다.** 값을 받는 쪽은 어차피 분기 한 번이면 된다. 그런데 이 시그니처는 **호출하는 쪽 전원에게** 매번 포장 의무를 지운다.

```java
// 호출부마다 이 포장이 반복된다
updateProfile("kim", Optional.ofNullable(nickname));
updateProfile("lee", Optional.empty());
```

**둘째, 정작 null 방어는 사라지지 않는다.** 파라미터 자리에는 `null`을 그대로 넘길 수 있다. 2-1의 첫 번째 상태가 여기서도 그대로 재현된다.

```java
updateProfile("kim", null);   // 컴파일된다. 아무도 못 막는다

void updateProfile(String name, Optional<String> nickname) {
    // 그래서 메서드 안에서는 결국 이렇게 써야 한다
    if (nickname != null && nickname.isPresent()) { ... }
}
```

**Optional이 여기서 보장해주는 것이 하나도 없다.** 반환 타입에서는 "구현자가 empty를 반환하기로" 규약을 지키면 됐지만, 파라미터는 넘기는 쪽 전부가 지켜야 하는데 강제 수단이 없다.

**셋째, 같은 의도를 표현하는 더 좋은 방법이 이미 있다.**

```java
// 대안 1: 오버로딩 - "닉네임이 없는 호출"을 시그니처로 분리한다
void updateProfile(String name);
void updateProfile(String name, String nickname);

// 대안 2: @Nullable - 정적 분석기가 호출부를 검사한다
void updateProfile(String name, @Nullable String nickname);
```

이건 개인 취향이 아니라 도구들의 공통 판정이기도 하다. IntelliJ, SonarQube, Error Prone 모두 Optional 파라미터를 경고 규칙으로 갖고 있다(Sonar 규칙 `java:S3553`).

생성자 파라미터도 같다. 선택 인자가 많으면 정적 팩토리 메서드나 빌더로 표현한다.

### 2-6. 그 밖에 쓰지 말아야 하는 자리

**컬렉션의 원소로 쓰지 않는다.** `List<Optional<String>>`은 "없음"을 두 겹으로 표현한 것이다. 값이 없는 원소는 애초에 리스트에 넣지 않으면 된다. 순회할 때마다 매 원소를 풀어야 하는 비용만 남는다.

**컬렉션 자체를 감싸지 않는다.** `Optional<List<Item>>`은 안티패턴이다. 컬렉션에는 이미 "없음"을 표현하는 수단 — **빈 컬렉션** — 이 있기 때문이다.

```java
// 잘못됨: 호출자가 두 단계로 풀어야 한다
Optional<List<Item>> findItems(Long id);
findItems(id).orElse(List.of()).forEach(...);

// 이렇게: 없으면 빈 리스트를 반환한다. 호출자는 분기 없이 바로 순회한다
List<Item> findItems(Long id);
findItems(id).forEach(...);
```

Effective Java Item 54("null이 아닌, 빈 컬렉션이나 배열을 반환하라")가 정확히 이 이야기다. 빈 컬렉션 반환은 Optional 이전부터 정답이었고, Optional이 그것을 대체하지 않는다.

**모든 반환 타입에 기계적으로 붙이지 않는다.** "항상 값이 있어야 하는" 메서드까지 Optional로 감싸면 호출자에게 의미 없는 없음 처리를 강제하게 된다. 값이 없는 것이 **버그이거나 복구 불가능한 상황**이라면 그냥 예외를 던지는 것이 맞다.

```java
// 결제 금액은 항상 있어야 한다. 없으면 그건 정상 흐름이 아니라 데이터 이상이다
long getAmount();                 // 이렇게
Optional<Long> getAmount();       // 이렇게 하면 호출자마다 의미 없는 orElse가 붙는다
```

판단 기준은 한 줄이다. **"없음"이 정상 흐름이면 Optional, "없음"이 예외 상황이면 예외.**

## 3. 올바른 사용 범위와 소비 패턴

### 3-1. 써야 하는 곳

| 위치 | 예 |
|---|---|
| "없음이 정상"인 조회 메서드의 반환 타입 | `Optional<Member> findByEmail(String email)` — Spring Data JPA의 `findById`가 표준 예다 |
| Stream 종단 연산의 결과 | `stream.max(...)`, `findFirst()` — 빈 스트림이 정상 케이스이므로 결과가 없을 수 있다 |
| 반환 직후 체이닝으로 소비 | `repo.findById(id).map(Member::getName).orElseThrow(...)` — 이것이 Optional의 본래 사용 모습이다 |

세 번째가 특히 중요하다. **Optional은 오래 들고 다니는 물건이 아니다.** 반환받은 그 자리에서 풀어 쓰고 버리는 것이 정상 수명이다. 지역 변수에 담아 여러 메서드를 통과시키기 시작하면 그때부터 2절의 문제들이 슬금슬금 따라온다.

### 3-2. `isPresent()` + `get()` — null 검사의 장황한 재현

반환 타입에 제대로 썼더라도 소비하는 방식이 틀리면 얻는 것이 없다. 가장 흔한 것이 이 패턴이다.

```java
// Before: Optional을 쓰기 전
Member member = repo.findByEmail(email);
if (member != null) {
    sendMail(member);
}

// After(?): Optional을 썼지만 구조가 똑같다
Optional<Member> found = repo.findByEmail(email);
if (found.isPresent()) {
    sendMail(found.get());
}
```

두 코드를 나란히 놓으면 **하는 일이 완전히 같다.** `if (x != null)`이 `if (found.isPresent())`로 이름만 바뀌었고, 값을 꺼내는 `.get()`이 한 단계 추가됐을 뿐이다. 얻은 것은 없고 줄만 길어졌다.

게다가 `get()`은 **빈 Optional에 부르면 `NoSuchElementException`을 던진다.** `isPresent()` 검사를 빼먹으면 NPE 대신 다른 예외가 날 뿐 아무것도 나아지지 않는다. 실제로 JDK는 이 위험 때문에 `get()`에 `orElseThrow()`라는 같은 동작의 대체 이름을 추가했다 — 이름 자체로 "빈 값이면 예외가 난다"를 드러내기 위해서다.

Optional을 제대로 쓴다는 것은 **분기를 직접 쓰지 않고 Optional이 제공하는 연산에 맡기는 것**이다.

```java
// After: 부재 처리를 연산에 맡긴다
repo.findByEmail(email).ifPresent(this::sendMail);

// 값을 꺼내야 하면 "없을 때 무엇을 할지"를 같은 표현식에 적는다
String name = repo.findByEmail(email)
        .map(Member::getName)
        .orElse("탈퇴한 회원");

Member member = repo.findByEmail(email)
        .orElseThrow(() -> new MemberNotFoundException(email));
```

### 3-3. `orElse`와 `orElseGet` — 인자가 언제 평가되는가

이 둘의 차이는 "스타일"이 아니라 **실행 순서**의 문제다. 그리고 코드를 눈으로 보면 차이가 안 보이기 때문에 실무에서 조용히 사고를 낸다.

핵심 전제는 Java의 평가 규칙이다. **Java는 메서드를 호출하기 전에 인자를 먼저 전부 평가한다.** `orElse`도 평범한 메서드이므로 이 규칙에서 예외가 아니다.

```java
Optional<Config> found = Optional.of(cachedConfig);   // 값이 있는 상태

Config c = found.orElse(loadDefaultFromDb());
```

이 한 줄이 실제로 실행되는 순서를 따라가 보자.

```
1. loadDefaultFromDb() 를 호출한다        <- DB 왕복이 여기서 이미 발생한다
2. 그 반환값을 인자로 들고 orElse 를 호출한다
3. found 에 값이 있으므로 인자는 무시되고 cachedConfig 가 반환된다

   결과: 1번의 DB 왕복은 통째로 낭비됐다.
         값이 있든 없든 매번 DB를 때린다.
```

`orElseGet`은 인자의 모양이 다르다. 값이 아니라 **"값을 만드는 방법"(Supplier)**을 넘긴다.

```java
Config c = found.orElseGet(this::loadDefaultFromDb);
```

```
1. this::loadDefaultFromDb 라는 "호출 방법"만 만들어 넘긴다   <- 아직 실행되지 않았다
2. orElseGet 을 호출한다
3. found 에 값이 있으므로 Supplier 를 호출하지 않는다

   결과: DB 왕복이 아예 일어나지 않는다.
```

판단 기준은 단순하다. **기본값이 이미 있는 상수면 `orElse`, 만드는 데 비용이 드는 것이면 `orElseGet`.**

```java
opt.orElse("");                        // 문자열 상수 - orElse로 충분하다
opt.orElse(new ArrayList<>());         // 매번 리스트를 하나씩 만들어 버린다
opt.orElseGet(ArrayList::new);         // 없을 때만 만든다

opt.orElse(repository.findDefault());  // 값이 있어도 매번 DB를 때린다
opt.orElseGet(repository::findDefault);
```

`orElseThrow(Supplier)`도 같은 이유로 Supplier를 받는다. 예외 객체를 만드는 순간 스택트레이스가 채워지는데, 값이 있을 때는 그 비용을 낼 이유가 없기 때문이다.

### 3-4. Optional 반환 메서드가 null을 반환하면

```java
// 절대 금지
Optional<Member> findByEmail(String email) {
    Member m = ...;
    if (m == null) return null;   // 규약 파괴
    return Optional.of(m);
}
```

이건 단순한 실수가 아니라 **Optional의 존재 이유를 정면으로 무너뜨리는 코드**다. 호출자는 시그니처를 믿고 `.map(...)`을 바로 부를 텐데, 거기서 NPE가 난다. Optional을 안 썼을 때보다 나쁘다 — 안 썼으면 호출자가 null을 의심이라도 했을 것이다.

없으면 `Optional.empty()`를 반환한다. 값이 null일 수 있으면 `Optional.ofNullable(m)`을 쓰면 한 줄로 끝난다.

### 3-5. 언어 차원 대비 — Java는 왜 이 어정쩡한 도구를 갖게 됐나

**Kotlin과 C#은 nullable을 언어 문법에 넣었다.** `String`은 null이 될 수 없고 `String?`은 될 수 있다. 그리고 컴파일러가 **모든 위치에서** — 필드든 파라미터든 반환이든 — 검사한다.

```kotlin
var nickname: String? = null       // null 가능. 컴파일러가 안다
val len = nickname.length          // 컴파일 에러: null 검사 없이 접근할 수 없다
val len = nickname?.length ?: 0    // 이렇게 써야 통과한다
```

여기서는 2-1의 "상태가 늘어나는" 문제가 아예 없다. `String?`의 상태는 여전히 둘(null 또는 값)이고, 상자를 하나 더 만드는 것이 아니라 **타입 자체에 표시를 붙인 것**이기 때문이다.

**Java는 왜 이렇게 못 했나.** 하위 호환 때문이다. 언어에 nullable 타입을 넣으려면 기존의 모든 타입에 "null 가능/불가능"을 정해야 하고, 이미 배포된 수십억 줄의 코드와 라이브러리 시그니처가 전부 그 판정을 받아야 한다. 그래서 **라이브러리 레벨의 절충안**을 택한 것이 Optional이고, 그것이 반환 위치에서만 어색하지 않은 이유이기도 하다. **Optional은 언어 기능의 흉내이지 대체가 아니다.**

그래서 필드·파라미터의 null 계약은 Optional이 아니라 다른 도구로 푼다. **`@Nullable`/`@NonNull` 애너테이션 + 정적 분석**이 Java 진영의 현재 방향이다. Error Prone과 NullAway가 빌드 단계에서 검사하고, 표준 애너테이션을 통일하려는 시도가 JSpecify다. 애너테이션은 런타임 객체를 만들지 않으므로 2-4의 비용 문제도, 2-1의 상태 증가 문제도 없다.

### 3-6. 실무 경험 답변 예시

> "Spring Data JPA의 `findById`가 Optional을 반환하는 것처럼, 조회 결과가 없는 게 정상 흐름인 메서드의 반환 타입에만 씁니다. 서비스 계층에서 `repo.findById(id).orElseThrow(() -> new MemberNotFoundException(id))`처럼 반환 즉시 체이닝으로 소비하고, Optional을 지역 변수에 담아 오래 들고 다니지는 않습니다. 예전에 DTO 필드를 `Optional<String>`으로 선언한 코드를 본 적이 있는데, 요청 JSON에 그 프로퍼티가 아예 없는 경우 Jackson이 필드를 건드리지 않고 지나가서 `Optional.empty()`가 아니라 진짜 null로 남았고, `isPresent()`를 부르는 지점에서 NPE가 났습니다. 필드에 쓰면 null인 Optional이라는 세 번째 상태가 생겨 검사가 오히려 늘어난다는 걸 그때 체감했고, 이후로는 필드는 nullable로 두고 getter에서 `Optional.ofNullable`로 감싸 반환하는 방식으로 통일했습니다. `orElse` 인자에 DB 조회를 넣어 값이 있어도 매번 조회가 나가던 것을 `orElseGet`으로 바꾼 경험도 있어서, 코드리뷰에서는 그 두 가지 — 필드·파라미터의 Optional, `orElse`의 즉시 평가 — 를 꼭 봅니다."

## 4. 꼬리질문 대비 포인트

### "`Optional<String> nickname;` 필드가 가질 수 있는 상태는 몇 가지인가요? 그게 왜 문제인가요?"

**세 가지다.** 참조 자체가 `null`인 상태, `Optional.empty()`, 값이 든 상태. `Optional.of(null)`은 생성 시점에 NPE라 존재하지 않고, `Optional.ofNullable(null)`은 `empty()`로 수렴하므로 정확히 셋이다.

문제는 개수가 아니라 **첫째와 둘째가 "닉네임이 없다"는 같은 의미의 다른 표현**이라는 점이다. 그냥 `String nickname`이면 상태는 둘(null 또는 값)인데, null을 없애려고 감쌌더니 하나 늘었다. 방어적으로 짜면 `nickname != null && nickname.isPresent()`가 되어 검사가 두 겹이 된다.

"필드가 null이 될 일 없게 잘 짜면 되지 않나"는 반문에는 **규약을 지켜야 하는 사람 수**로 답한다. 반환값은 그 메서드를 구현한 한 명이 지키면 되지만, 필드는 생성자·세터·리플렉션으로 객체를 만드는 프레임워크·나중에 필드를 추가하는 사람까지 전부가 지켜야 한다. 언어가 강제하지 못하는 규약은 참여자가 늘어날수록 반드시 깨진다.

### "`orElse`와 `orElseGet`의 차이는 뭔가요?"

**인자가 평가되는 시점이 다르다.** Java는 메서드 호출 전에 인자를 먼저 평가하므로, `orElse(x)`의 `x`는 **Optional에 값이 있든 없든 항상 실행된다.** 반면 `orElseGet(supplier)`는 값이 없을 때만 supplier를 호출한다.

```java
opt.orElse(loadFromDb());        // 값이 있어도 DB를 때린다. 그 결과는 그냥 버려진다
opt.orElseGet(this::loadFromDb); // 없을 때만 DB를 때린다
```

판단은 **기본값이 이미 있는 상수인가, 만드는 데 비용이 드는가**로 한다. 상수 문자열이나 이미 계산된 값이면 `orElse`가 읽기 좋고, 객체 생성·DB 조회·외부 호출이 들어가면 반드시 `orElseGet`이다. `orElseThrow(Supplier)`가 Supplier를 받는 것도 같은 이유다 — 예외 객체 생성은 스택트레이스를 채우는 비용이 있는데, 값이 있을 때 그 값을 낼 이유가 없다.

### "getter가 Optional을 반환하는 건 괜찮나요?"

**널리 쓰이는 절충안이다.** 필드는 nullable 실제 타입으로 두고, getter에서만 감싼다.

```java
private String nickname;   // 직렬화·JPA 매핑·비용 문제가 없다

public Optional<String> getNickname() {
    return Optional.ofNullable(nickname);   // 호출자에게는 "없을 수 있음"을 알린다
}
```

이러면 2절의 손해(3-상태, 직렬화 불가, JPA 매핑 불가, 인스턴스마다 곱해지는 할당)를 전부 피하면서 호출자에게는 반환 타입으로 부재 가능성을 알릴 수 있다. Optional의 설계 의도와도 정확히 맞는다 — 어차피 **반환 타입**이기 때문이다.

단서는 두 가지다. JavaBeans 프로퍼티 규약에 민감한 도구와 마찰이 생길 수 있고, 이 getter를 그대로 JSON 직렬화 경로에 태우면 2-3의 Jackson 이슈를 다시 만난다.

### "Optional을 쓰면 NPE가 사라지나요? 성능 부담은 어느 정도인가요?" (시니어 변별 포인트)

**사라지지 않는다.** 이 지점을 정확히 답하는지가 "유행어로 아는 사람"과 갈리는 자리다.

- 빈 Optional에 `get()`을 부르면 `NoSuchElementException`이 난다. 예외 이름만 바뀐 것이다.
- Optional 참조 자체가 null이면 여전히 NPE다(2-1).
- `Optional.of(null)`은 그 자리에서 NPE다.

**Optional의 가치는 NPE 제거가 아니라 "없을 수 있음"을 시그니처에 드러내 호출자가 처리하도록 유도하는 것**이다. 그래서 그 유도가 작동하는 위치, 즉 반환 타입에서만 의미가 있다. 필드에 쓰면 유도할 호출자가 없으니 비용만 남는다.

성능은 **위치에 따라 결론이 갈린다.** 반환 후 즉시 소비하는 정상 용법에서는 호출당 객체 하나이고, JIT의 탈출 분석으로 할당 자체가 사라지는 경우도 많아 대부분의 비즈니스 로직에서 무시할 수준이다. 문제가 되는 것은 둘이다. **필드로 장기 보유해 인스턴스 수만큼 곱해질 때**, 그리고 **루프 안에서 원시값을 `Optional<Integer>`로 이중 박싱할 때**다. 후자는 `OptionalInt`/`OptionalLong`/`OptionalDouble`로 박싱 한 겹을 없앤다.

### "모든 반환 타입에 Optional을 붙이면 안 되나요?"

**안 된다. 판단 기준은 "없음"이 정상 흐름인가 아닌가다.**

값이 없는 것이 정상적으로 일어나는 일이면 Optional이 맞다(이메일로 회원 조회, 스트림의 최댓값). 반면 값이 없는 것이 **버그이거나 복구 불가능한 데이터 이상**이면 그냥 예외를 던지는 것이 맞다. 결제 건에 금액이 없다면 그건 정상 흐름이 아니다. Optional로 감싸면 호출자마다 의미 없는 `orElse(0L)`이 붙고, 진짜 이상 상황이 조용히 기본값으로 덮인다.

**컬렉션은 특히 감싸면 안 된다.** `Optional<List<Item>>`은 "없음"을 표현하는 수단이 이미 있는 타입을 또 감싼 것이다. 없으면 **빈 컬렉션을 반환**하면 호출자는 분기 없이 바로 순회할 수 있다(Effective Java Item 54). 같은 이유로 `List<Optional<T>>`처럼 원소를 감싸는 것도 안티패턴이다 — 값이 없는 원소는 애초에 넣지 않으면 된다.

정리하면 Effective Java Item 55의 제목 그대로다. **"Optional은 신중하게 반환하라(Return optionals judiciously)"** — 반환에만, 컬렉션은 감싸지 말고, 성능이 민감한 구간은 한 번 더 생각하라.

---

## 한 줄 요약

Optional은 "메서드가 null을 돌려줄 수 있다"는 사실이 시그니처 어디에도 안 적혀 있던 문제를 타입으로 끌어올리기 위해 설계자가 **반환 타입 전용**으로 만든 장치이므로, 필드에 쓰면 `null`/`empty()`/값의 **세 상태**가 되어 null을 없애려던 도구가 검사를 이중으로 만들고 직렬화 불가·JPA 매핑 불가·인스턴스마다 곱해지는 할당까지 얹으며, 파라미터에 쓰면 호출자 전원에게 포장 부담만 지우고 정작 null 유입은 못 막는다 — 올바른 범위는 "없음이 정상"인 조회 메서드의 반환 타입 + `map`/`ifPresent`/`orElseThrow` 체이닝으로 즉시 소비하는 데까지이고, 그 안에서도 `isPresent()`+`get()`은 null 검사의 장황한 재현일 뿐이며 `orElse`는 값이 있어도 인자를 먼저 평가한다는 것까지 알아야 하고, 필드·파라미터의 null 계약은 nullable 필드 + getter의 `ofNullable`, 오버로딩, `@Nullable` + 정적 분석으로 각각 대체한다.
