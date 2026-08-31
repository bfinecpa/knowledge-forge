# Integer 캐시와 == 비교 — 127은 true, 128은 false인 이유

> 핵심 관전 포인트: **`Integer a = 127` 같은 오토박싱은 컴파일러가
> `Integer.valueOf(127)` 호출로 바꾸는데, valueOf는 -128~127 범위의
> 값을 미리 만들어 둔 캐시에서 꺼내 준다. 그래서 127은 두 변수가
> 같은 객체라 `==`(참조 비교)가 true, 128은 매번 새 객체라 false다.
> 위험은 명확하다 — `==`는 값이 아니라 참조를 비교하는데 작은 값에서만
> 우연히 맞으므로, 작은 값으로 도는 테스트·개발 환경은 전부 통과하고
> 운영 데이터(id가 127을 넘는 순간)에서만 틀리는 재현 어려운 버그가 된다.
> 래퍼 타입 비교는 반드시 `equals`(null 가능하면 `Objects.equals`)를 쓴다.**

---

## 0. 질문 + 의도

**질문**: "`Integer a = 127, b = 127`일 때 `a == b`는 true인데 128이면
false인 이유는? 이런 코드의 위험은 무엇인가요?"

**출제 의도**: `==`와 `equals` 혼동이 만드는 "작은 값 테스트는 전부
통과하고 운영 데이터에서만 틀리는" 버그의 대표 사례. 언어의 미묘한 규칙이
재현 안 되는 버그로 나타나는 전형을 아는지 본다.

## 1. 원리: 오토박싱 = `Integer.valueOf()` 호출

`Integer a = 127;`이라고 쓰면 컴파일러가 이렇게 바꿔치기한다(오토박싱).

```java
Integer a = 127;                 // 소스 코드
Integer a = Integer.valueOf(127); // 컴파일 결과 (바이트코드 수준)
```

`Integer.valueOf`는 **-128 ~ 127 범위의 Integer 객체를 클래스 로딩 시점에
미리 만들어 둔 캐시(IntegerCache)** 를 갖고 있어, 이 범위면 캐시에 있는
같은 객체를 돌려주고 범위 밖이면 새 객체를 만든다.

```java
Integer a = 127, b = 127;
a == b;      // true  — 둘 다 캐시의 같은 객체를 가리킴

Integer c = 128, d = 128;
c == d;      // false — 캐시 범위 밖이라 각각 새 객체
c.equals(d); // true  — 값 비교는 당연히 같음
```

핵심을 한 문장으로: **`==`는 두 참조가 같은 객체인지를 비교할 뿐,
값을 비교한 적이 없다.** 127에서 true가 나온 건 캐시 때문에 "우연히"
같은 객체였을 뿐이다.

- 이 캐시 동작은 JVM 구현 디테일이 아니라 **언어 명세(JLS)가 보장하는
  범위**다: int -128~127, boolean, byte, char 0~127 등은 박싱 결과가
  항상 동일 객체여야 한다 (가산점 포인트).
- 캐시 상한은 JVM 옵션(`-XX:AutoBoxCacheMax`)으로 늘릴 수 있지만,
  이 옵션에 기대는 코드는 환경 따라 동작이 달라지므로 해결책이 아니다.

## 2. 이 버그가 특히 위험한 이유 — "테스트는 통과한다"

일반적인 버그는 실행하면 틀린다. 이 버그는 **작은 값에서는 맞는다.**

```java
// 주문 소유자 검증 — userId가 Long 래퍼 타입
public void validateOwner(Order order, Long currentUserId) {
    if (order.getUserId() != currentUserId) {   // 참조 비교!
        throw new AccessDeniedException();
    }
}
```

- 개발 DB의 유저 id는 1, 2, 3... — 캐시 범위 안이라 **전부 정상 동작**.
  단위 테스트도 `userId = 1L`로 쓰니 통과한다.
- 운영에서 유저가 늘어 id가 128을 넘는 순간, **본인 주문인데 접근 거부**가
  나기 시작한다. 그것도 "id가 큰 유저만, 항상"이 아니라 코드 경로에 따라
  간헐적으로 보여서, 로그만 봐서는 원인을 특정하기 어렵다.
- `Long`도 `Integer`와 동일하게 -128~127 캐시를 갖기 때문에 id 타입으로
  흔한 `Long`에서 정확히 같은 함정이 재현된다.

이처럼 **입력 데이터의 크기에 따라 정답 여부가 갈리는 버그**는 재현
조건을 못 찾아 며칠을 태우는 유형의 대표다 — 출제 의도가 짚는 지점.

## 3. Before / After — 올바른 비교 방법

```java
// Before: 래퍼 타입을 == 로 비교 — 캐시 범위에서만 우연히 정답
if (order.getUserId() == currentUserId) { ... }

// After 1: equals — 값 비교 (좌변이 null이면 NPE 주의)
if (order.getUserId().equals(currentUserId)) { ... }

// After 2: Objects.equals — 둘 다 null 안전 (실무 기본값으로 추천)
if (Objects.equals(order.getUserId(), currentUserId)) { ... }

// After 3: null이 아님이 보장되면 primitive로 꺼내 비교
if (order.getUserId().longValue() == currentUserId.longValue()) { ... }
```

주의할 혼합 케이스: **한쪽이 primitive면 `==`도 값 비교가 된다.**

```java
Integer boxed = 128;
int primitive = 128;
boxed == primitive;   // true — boxed가 언박싱되어 int끼리 값 비교
// 단, boxed가 null이면 언박싱하다가 NullPointerException!
```

그래서 "래퍼끼리 `==`는 참조 비교, 래퍼와 primitive의 `==`는 언박싱 후
값 비교(null이면 NPE)"까지 구분해 말하면 정확한 답이 된다.

## 4. 실무 방어 전략

1. **비교 규칙을 컨벤션으로**: 래퍼 타입 비교는 `Objects.equals`,
   primitive로 충분한 필드는 처음부터 primitive 선언(`long id` 등,
   null 표현이 필요한 경우만 래퍼).
2. **도구로 강제**: IntelliJ의 "Number comparison using ==" 인스펙션,
   ErrorProne(`BoxedPrimitiveEquality`), SonarQube 룰이 이 패턴을 잡아준다.
   사람의 주의력 대신 정적 분석에 맡기는 게 답이라고 말하면 가산점.
3. **AI 생성 코드 리뷰 관점**: 이런 코드는 생성 시점엔 그럴듯하고
   테스트도 통과하므로, 리뷰에서 "래퍼 타입 + `==`" 조합 자체를
   기계적으로 걸러내는 눈이 필요하다.

## 5. 꼬리질문 대비 포인트

### "왜 하필 -128~127만 캐시하나요?"

작은 정수는 압도적으로 자주 쓰이므로(루프 인덱스, 상태 코드, 소량 id),
그 구간만 미리 만들어 재사용하면 객체 생성과 GC 부담을 줄일 수 있다.
byte 하나로 표현되는 범위(-128~127)를 기본으로 잡았고, 상한은
`-XX:AutoBoxCacheMax`로 조정 가능하지만 하한(-128)은 고정이다.

### "Integer 말고 다른 래퍼 타입도 캐시가 있나요?"

`Byte`, `Short`, `Long`은 -128~127, `Character`는 0~127, `Boolean`은
true/false 두 개를 캐시한다. 반면 **`Float`/`Double`은 캐시가 없다**
(실수는 "자주 쓰이는 값" 구간을 정의하기 어렵기 때문). 실무에서 id로
흔한 `Long`에 같은 함정이 있다는 점을 짚으면 좋다.

### "`new Integer(127) == new Integer(127)`은 어떻게 되나요?"

false다. `new`는 캐시를 거치지 않고 **무조건 새 객체**를 만든다.
그래서 래퍼 생성자는 deprecated 되었고 `valueOf`(또는 오토박싱)를 쓰는 게
표준이다 — 캐시를 활용할 수 있고, 동일성에 의존하는 착각도 줄인다.

### "String의 `==` 비교와 같은 문제인가요?"

같은 뿌리(참조 비교 vs 값 비교)다. String도 리터럴은 String pool에서
공유되어 `==`가 true지만 `new String(...)`이나 런타임 조합 문자열은
false다. "리터럴/작은 값 테스트에서는 통과하고 실데이터에서 틀린다"는
버그 패턴까지 동일하다고 연결하면 원리를 이해했다는 신호가 된다.

### "그럼 처음부터 primitive를 쓰면 되지 않나요? 래퍼는 언제 필요한가요?" (시니어 변별 포인트)

성능·안전 면에서 primitive가 기본값이 맞다. 하지만 래퍼가 필요한 자리가
있다 — (1) **null이 의미를 갖는 필드**: JPA 엔티티의 id(저장 전 null),
"값 없음"을 표현해야 하는 DTO 필드. primitive는 0과 "없음"을 구분 못 한다.
(2) **제네릭**: `List<Integer>`처럼 타입 파라미터에는 primitive를 못 쓴다.
따라서 "래퍼를 쓰는 자리를 의도적으로 한정하고, 래퍼가 등장하는 순간
`==` 금지 + null 처리라는 비용이 따라온다는 걸 인지하고 설계한다"고
답하면 트레이드오프를 아는 답이 된다. 컬렉션·루프에서의 반복 박싱이
GC 압력을 만드는 성능 이슈(합계 계산에 `Long sum` 을 쓰는 안티패턴)까지
언급하면 가산점.

---

## 한 줄 요약

`==`는 처음부터 참조 비교였고, 127에서 true가 나온 건 **오토박싱 캐시가
같은 객체를 재사용한 우연**일 뿐이다 — 작은 값에서만 맞는 코드는 테스트를
전부 통과하고 운영에서 터지므로, 래퍼 타입 비교는 무조건
`equals`/`Objects.equals`로 쓴다.
