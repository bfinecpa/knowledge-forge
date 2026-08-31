# Optional의 올바른 사용 범위 — 왜 필드·파라미터에는 쓰지 말라는가

> 핵심 관전 포인트: **Optional은 "null을 대체하는 범용 타입"이 아니라
> "메서드가 결과 없음을 반환할 수 있다"를 시그니처에 드러내는 반환 전용
> 컨테이너다.** 설계자(Brian Goetz)가 명시적으로 반환 타입 한정 용도로
> 만들었고, 필드·파라미터에 쓰는 순간 오히려 상태가 하나 **늘어난다** —
> `Optional<String>` 필드는 `null` / `Optional.empty()` / 값 존재의
> **3가지 상태**를 가지므로, null을 없애려던 도구가 null 검사 + isPresent
> 검사를 둘 다 요구하는 역설에 빠진다.

---

## 0. 질문 + 의도

**질문**: "`Optional`을 필드나 메서드 파라미터에 쓰지 말라는 권고의 이유는?
실무에서 `Optional`의 올바른 사용 범위는 어디까지인가요?"

**출제 의도**: Optional을 필드·파라미터·컬렉션 원소에 쓰는 코드는 "null
안전"이 아니라 관용구 위반이다. 도구의 설계 의도(반환 타입으로 부재를
표현)를 이해하고 쓰는지 — 편리해 보이는 API를 원래 목적 밖으로 확장할 때
멈출 수 있는 절제가 있는지를 본다.

## 1. Optional의 설계 의도 — 무엇을 풀려고 만든 물건인가

Java 8 이전, "결과가 없을 수 있는 메서드"는 두 가지 나쁜 선택지뿐이었다:

| 방식 | 문제 |
|---|---|
| `null` 반환 | 호출자가 null 체크를 잊으면 **한참 뒤 엉뚱한 곳에서 NPE** — 시그니처만 봐서는 null 가능성을 알 수 없다 |
| 예외 던지기 | "없음"이 정상 흐름인데 예외로 표현 — 제어 흐름 남용 + 스택트레이스 비용 |

Optional은 세 번째 선택지다: **"없을 수 있음"을 타입 시스템에 올려서
컴파일러와 IDE가 호출자에게 처리를 강제하게 만드는 것.**

```java
Optional<Member> findByEmail(String email);
// 시그니처만 봐도 "없을 수 있다"가 보이고,
// 호출자는 .map/.orElseThrow 등으로 '없음' 케이스를 다루지 않고는 값을 못 꺼낸다
```

설계자 Brian Goetz의 공식 입장 (Stack Overflow, 2014):

> "Optional is intended to provide a *limited* mechanism for library method
> **return types** where there needed to be a clear way to represent
> 'no result', and using null for such was overwhelmingly likely to cause errors."

즉 **반환 타입, 그중에서도 "없음이 정상인 조회 결과"가 유일한 설계 목적**이다.
필드·파라미터·컬렉션 원소는 처음부터 용도 밖이었다.

---

## 2. 왜 필드에 쓰면 안 되는가

### 2-1. 상태가 줄지 않고 늘어난다 (핵심 논거)

```java
private Optional<String> nickname;
```

이 필드가 가질 수 있는 상태는 **3가지**다:

| 상태 | 의미 | 어떻게 생기나 |
|---|---|---|
| ① `nickname == null` | Optional 참조 자체가 null | 초기화 안 된 필드, 리플렉션 생성(Jackson/JPA), 실수로 null 대입 |
| ② `Optional.empty()` | "값 없음"의 정상 표현 | 의도된 빈 상태 |
| ③ `Optional.of("...")` | 값 존재 | 정상 값 |

- 그냥 `String nickname`이면 상태는 **2가지**(null / 값)다.
  Optional로 감쌌더니 상태가 하나 **늘었다** — null을 제거하려던 도구가
  "null인 Optional"이라는 새 케이스를 만든 것
- ①과 ②는 **의미가 같은데 표현이 다르다**. 방어적으로 짜려면
  `nickname != null && nickname.isPresent()` — 원래 null 체크보다 나빠졌다
- ④ `Optional.of(null)`은 없다 — `Optional.of`는 null에 즉시 NPE,
  `ofNullable(null)`은 ②로 수렴한다. 그래서 정확히 3가지

> 참고: 필드 선언은 언어가 null 대입을 막아주지 않는다. 반환값은
> "메서드 구현자가 null을 반환하지 않는다"는 규약을 한 명만 지키면 되지만,
> 필드는 그 클래스를 만지는 모두가 규약을 지켜야 해서 깨지기 쉽다.

### 2-2. 직렬화 불가

- `Optional`은 **`Serializable`을 구현하지 않는다** — 의도된 설계
  (반환 전용이므로 객체 상태로 저장될 일이 없어야 한다는 입장)
- 필드에 쓰면 Java 직렬화, 일부 캐시/세션 저장, RPC에서 즉시 깨진다

### 2-3. 프레임워크 호환성

| 프레임워크 | 문제 |
|---|---|
| JPA/Hibernate | `Optional` 필드는 매핑 불가 — 엔티티 필드는 반드시 실제 타입. (getter만 Optional로 감싸 반환하는 건 가능) |
| Jackson | 기본 상태로는 `{"present": true}` 같은 이상한 JSON — `jackson-datatype-jdk8` 모듈 필요 |
| JavaBeans 규약 | `getNickname()`이 `Optional<String>`을 반환하면 프로퍼티 타입 추론이 어긋나는 도구들이 있다 |

### 2-4. 비용

- Optional은 매번 **별도 힙 객체**다(원시값 박싱까지 겹치면 이중 래핑).
  필드마다 감싸면 객체 수가 배로 늘고, 수백만 건을 다루는 엔티티/DTO에서
  메모리·GC 압력이 실측될 수준이 된다
- 값 기반 클래스(value-based class)라 **동일성(`==`) 비교·락 사용이 금지**
  대상 — 필드처럼 오래 살아남는 위치에 둘수록 오용 여지가 커진다

---

## 3. 왜 파라미터에 쓰면 안 되는가

```java
// 나쁜 예
void updateProfile(String name, Optional<String> nickname) { ... }
```

1. **호출자 부담만 늘어난다** — 호출부가
   `updateProfile("kim", Optional.ofNullable(nickname))`처럼 매번 포장해야
   한다. 값을 "받는 쪽"은 어차피 분기 한 번이면 되는데, "주는 쪽" 전원에게
   래핑 의무가 생긴다
2. **null 방어가 사라지지 않는다** — 파라미터로 `null`이 그대로 들어올 수
   있으므로(§2-1의 ① 상태) 메서드 안에서는
   `nickname != null && nickname.isPresent()`를 또 해야 한다.
   Optional이 보장해주는 게 아무것도 없다
3. **의도 표현은 더 좋은 대안이 있다**:

```java
// 대안 1: 오버로딩 — "없는 경우"를 시그니처로 분리
void updateProfile(String name);
void updateProfile(String name, String nickname);

// 대안 2: @Nullable 어노테이션 — 정적 분석기가 검사
void updateProfile(String name, @Nullable String nickname);
```

IntelliJ·SonarQube·Error Prone 모두 Optional 파라미터를 경고 규칙으로
갖고 있다 (Sonar `java:S3553`).

---

## 4. 그럼 어디까지가 올바른 사용 범위인가

### ✅ 써야 하는 곳

| 위치 | 예 |
|---|---|
| **"없음이 정상"인 조회 메서드의 반환 타입** | `Optional<Member> findByEmail(...)` — Spring Data JPA `findById`가 표준 예 |
| Stream 종단 연산 결과 | `stream.max(...)`, `findFirst()` — 빈 스트림이 정상 케이스 |
| 반환 직후 **체이닝으로 소비** | `repo.findById(id).map(Member::getName).orElseThrow(...)` — 이게 Optional의 본래 사용 모습 |

### ❌ 쓰지 말아야 하는 곳

| 위치 | 이유 | 대안 |
|---|---|---|
| 필드 | §2 전부 (3-상태, 직렬화, JPA, 비용) | 그냥 nullable 필드 + getter에서 `Optional.ofNullable` 반환 |
| 메서드 파라미터 | §3 (호출자 부담, null 방어 중복) | 오버로딩, `@Nullable` |
| 생성자 파라미터 | 파라미터와 동일 | 정적 팩토리/빌더로 선택 인자 표현 |
| 컬렉션 원소/Map 키·값 | `List<Optional<T>>`는 "없음"을 두 겹으로 표현 — 그냥 빼면 된다 | 원소를 필터링하거나 빈 컬렉션 |
| **컬렉션 자체를 감싸기** | `Optional<List<T>>`는 "없음"의 표현이 이미 있는 타입을 또 감싼 것 | **빈 컬렉션 반환** (Effective Java Item 54) |
| 모든 반환 타입에 기계적으로 | "항상 있어야 하는 값"까지 감싸면 없음 처리가 의미 없이 강제됨 | 없으면 예외가 맞는 곳은 그냥 던진다 |

### ❌ 반환 타입에 썼더라도 피해야 할 소비 패턴

```java
// 안티패턴 1: isPresent + get — null 체크에 단계만 추가한 것
if (opt.isPresent()) { use(opt.get()); }
// → opt.ifPresent(this::use) 또는 map/orElseThrow 체이닝

// 안티패턴 2: orElse에 비싼 호출 — orElse 인자는 값이 있어도 '항상' 평가된다
opt.orElse(loadDefaultFromDb());     // 값이 있어도 DB를 때린다!
opt.orElseGet(this::loadDefaultFromDb);  // 지연 평가 — 없을 때만 실행

// 안티패턴 3: Optional 반환 메서드가 null을 반환
Optional<Foo> find() { return null; }  // 규약 파괴 — 절대 금지, empty()를 반환
```

- 원시값은 `OptionalInt/OptionalLong/OptionalDouble` — 이중 박싱 회피
- Effective Java 3판 Item 55 "Return Optionals judiciously"가 이 절 전체의
  출처격: 반환에만, 컬렉션은 감싸지 말고, 성능 민감 구간은 재고하라

### 참고 — 언어 차원 대비

- **Kotlin/C#**: nullable 타입(`String?`)이 언어에 내장 — 상태가 늘지 않고
  컴파일러가 모든 위치(필드·파라미터 포함)에서 검사한다. Optional은
  이걸 라이브러리로 흉내 낸 것이라 반환 위치에서만 어색하지 않은 것
- Java도 필드·파라미터의 null 계약은 `@Nullable`/`@NonNull` + 정적 분석
  (Error Prone, NullAway, JSpecify)으로 푸는 것이 현재 방향

---

## 5. 한 문장 결론 (모범답안 요약)

> Optional은 설계자가 명시했듯 **"결과 없음이 정상인 메서드의 반환 타입"
> 전용** 컨테이너다. 필드에 쓰면 `null` / `empty()` / 값의 **3-상태**가
> 되어 null을 없애려던 도구가 검사를 이중으로 만들고, 직렬화 불가·JPA 매핑
> 불가·객체 할당 비용까지 얹는다. 파라미터에 쓰면 호출자에게 래핑 부담만
> 지우고 정작 null 유입은 못 막는다. 올바른 범위는 조회성 반환 타입 +
> `map/filter/orElseThrow` 체이닝 소비까지이고, 필드·파라미터·컬렉션
> 원소·컬렉션 래핑은 nullable 필드, 오버로딩/@Nullable, 빈 컬렉션 반환으로
> 각각 대체한다.

### 실무 경험 답변 예시

> "Spring Data JPA의 `findById`가 Optional을 반환하는 것처럼, 조회 결과가
> 없는 게 정상 흐름인 메서드의 반환 타입에만 씁니다. 서비스 계층에서
> `repo.findById(id).orElseThrow(() -> new MemberNotFoundException(id))`처럼
> 반환 즉시 체이닝으로 소비하고 Optional을 오래 들고 다니지 않습니다.
> 예전에 DTO 필드를 `Optional<String>`으로 선언한 코드를 본 적이 있는데,
> Jackson 역직렬화 경로에서 Optional 필드가 null로 남아
> `isPresent()` 호출에서 NPE가 난 적이 있습니다 — 필드에 쓰면 null인
> Optional이라는 세 번째 상태가 생겨서 오히려 검사가 늘어난다는 걸 그때
> 체감했고, 이후로는 필드는 nullable로 두고 getter에서
> `Optional.ofNullable`로 감싸 반환하는 방식으로 통일했습니다.
> `orElse`에 DB 조회를 넣어 값이 있어도 매번 조회가 나가던 걸
> `orElseGet`으로 바꾼 경험도 있어서, 코드리뷰에서 그 두 가지
> (필드/파라미터 Optional, orElse의 즉시 평가)는 꼭 봅니다."

---

## 부록: 자주 헷갈리는 포인트 Q&A

**Q1. `Optional<String> nickname;` 필드가 가질 수 있는 상태는 몇 가지?**
→ **3가지**: ① 참조 자체가 `null`, ② `Optional.empty()`, ③ 값 존재.
`Optional.of(null)`은 생성 시점에 NPE라 존재하지 않고, `ofNullable(null)`은
②로 수렴한다. ①과 ②가 같은 의미의 다른 표현이라는 게 문제의 본질 —
plain 필드(2-상태)보다 상태가 늘었다. (§2-1)

**Q2. "필드가 null이 될 일은 없게 잘 짜면 되지 않나?"**
→ 반환값은 구현자 한 명이 규약을 지키면 되지만, 필드는 생성자·세터·
리플렉션(Jackson/JPA가 기본 생성자로 만들면 필드는 null) 등 모든 경로가
지켜야 한다. 언어가 강제하지 못하는 규약은 결국 깨진다. (§2-1)

**Q3. getter가 Optional을 반환하는 건 괜찮나?**
→ 절충안으로 널리 쓰인다 — 필드는 nullable로 두고
`Optional<String> getNickname() { return Optional.ofNullable(nickname); }`.
직렬화·JPA 문제를 피하면서 호출자에게는 "없을 수 있음"을 알린다.
단 JavaBeans 프로퍼티 규약에 민감한 도구와는 마찰이 있을 수 있다. (§2-3, §4)

**Q4. `orElse`와 `orElseGet`의 차이는?**
→ `orElse(x)`의 x는 **값이 있어도 항상 평가**되고, `orElseGet(supplier)`는
없을 때만 호출된다. 기본값이 상수면 orElse, 생성 비용이 있으면(객체 생성,
DB 조회 등) 반드시 orElseGet. (§4)

**Q5. `Optional<List<T>>`를 반환하는 건?**
→ 안티패턴. 컬렉션은 "없음"을 표현하는 수단(빈 컬렉션)이 이미 있다.
`null`도 `Optional`도 아닌 **빈 컬렉션을 반환**하면 호출자는 분기 없이
바로 순회할 수 있다. (§4, Effective Java Item 54)

**Q6. Optional을 쓰면 NPE가 사라지나?**
→ 아니다. `opt.get()`을 빈 상태에서 부르면 `NoSuchElementException`,
Optional 참조 자체가 null이면 여전히 NPE다. Optional의 가치는 NPE 제거가
아니라 **"없을 수 있음"을 시그니처에 드러내 호출자가 처리하도록 유도**하는
것이다. 그래서 그 유도가 작동하는 위치(반환)에서만 의미가 있다. (§1, §2-1)

**Q7. 성능이 문제라는데 어느 정도인가?**
→ 호출당 객체 하나라 대부분의 비즈니스 로직에서는 무시 가능하다. 문제가
되는 건 (a) 필드로 장기 보유해 인스턴스 수가 곱해질 때, (b) 루프 안
원시값을 `Optional<Integer>`로 이중 박싱할 때 — 후자는
`OptionalInt`로 푼다. "반환 후 즉시 소비" 패턴이면 최신 JIT의 탈출 분석으로
할당이 제거되는 경우도 많다. (§2-4)

**Q8. 왜 Java는 Kotlin처럼 nullable 타입을 언어에 안 넣었나?**
→ 기존 타입 시스템과의 하위 호환 때문에 라이브러리 레벨 해법(Optional)을
택했다. 언어 내장 nullable 타입은 모든 위치에서 컴파일러가 검사하므로
필드·파라미터에 써도 상태가 늘지 않지만, Optional은 그 자체가 참조 타입이라
null이 될 수 있다는 근본 한계가 있다. Java 진영의 현재 방향은
JSpecify 등 어노테이션 + 정적 분석이다. (§4)
