# Java 8+ 기능의 실무 활용 — Stream·Optional·람다는 "쓰는 것"보다 "절제"가 실력

> 핵심 관전 포인트: **Java 8의 세 기능은 문법 세 개가 아니라 각각 다른 제약을 푼 도구다. 람다는 "자바에서는 데이터만 값처럼 넘길 수 있고 동작은 넘길 수 없다"는 제약을 풀었고(익명 클래스가 그 우회로였는데, 람다는 그것의 축약이 아니라 `invokedynamic`으로 처리되어 클래스 파일조차 만들지 않는 다른 메커니즘이다), Stream은 "순회하는 방법(how)"을 코드에서 걷어내고 "무엇을 원하는가(what)"만 남겼으며, Optional은 "결과가 없을 수 있다"는 사실을 주석이 아니라 시그니처에 못 박았다. Stream을 예쁜 for문과 가르는 것은 지연 평가다 — 중간 연산은 최종 연산이 붙기 전까지 한 줄도 실행되지 않고, 실행될 때도 단계별이 아니라 원소 하나가 파이프라인 끝까지 갔다 오는 방식이라 `findFirst`가 첫 원소에서 순회를 멈출 수 있다. 그리고 실무 역량이 갈리는 지점은 문법이 아니라 절제다 — 스트림 안에서 외부 컬렉션을 건드리는 사이드이펙트(병렬로 바뀌는 순간 실제로 데이터가 유실된다), 퍼즐이 된 긴 체이닝, 아무 근거 없는 `parallelStream()`, 반환 타입 밖으로 새어 나간 Optional을 알아보고 for문이나 if로 되돌리는 판단까지가 답이다.**

---

## 0. 질문 + 의도

**질문**: "Java 8 이후 추가된 주요 기능(Stream, Optional, 람다)을 실무에서 어떻게 활용했나요?"

**출제 의도**: 버전별 문법 암기가 아니라, "팀 코드베이스의 관용구를 읽고 쓸 수 있는가"와 Stream 남용(가독성 해치는 체이닝, 스트림 안 사이드이펙트)을 분별하는 감각을 본다. 즉 "기능을 아느냐"가 아니라 "언제 쓰고 언제 멈추느냐"를 말할 수 있는지가 관전 포인트다.

## 1. 세 기능이 각각 어떤 문제를 풀었는가

이 질문에 "Stream은 이렇게 쓰고요, Optional은 이렇게 쓰고요"라고 기능을 소개하는 순서로 답하면 문법 암기로 들린다. **각 기능이 없던 시절에 무엇이 불편했는지**부터 말하는 순서로 가면 같은 내용이 설계 이해로 들린다.

### 1-1. 람다 — "동작을 값처럼 넘길 수 없다"는 제약을 푼 것

#### 전제 지식 — 자바가 넘길 수 있었던 것과 없었던 것

메서드에 인자로 넘길 수 있는 것을 떠올려 보자. `int`, `String`, `Order` 객체, 리스트. 전부 **데이터**다. 자바에서 값처럼 다룰 수 있는 것은 데이터뿐이었고, **"이렇게 처리하라"는 동작 자체는 넘길 수 없었다.**

그런데 실무에서 넘기고 싶은 것은 자주 동작이다. 정렬 로직을 예로 들면, "리스트를 순회하며 비교해 자리를 바꾼다"는 부분은 어디서나 똑같고 **딱 한 조각, 무엇을 기준으로 비교하는가만 다르다.** 그 한 조각을 넘길 수 없으니 정렬 알고리즘 전체를 매번 다시 쓰거나, 기준마다 다른 메서드를 만들어야 했다.

자바가 마련한 우회로가 **익명 클래스**다. 동작을 직접 넘길 수는 없으니 **인터페이스로 한 겹 감싸 객체로 만들어** 넘기는 것이다. 넘어가는 것은 여전히 객체(데이터)지만, 그 객체 안에 우리가 원하는 동작이 들어 있다.

```java
// before — 익명 클래스: 정말 하고 싶은 말은 "이름순"이라는 한 줄인데
Collections.sort(members, new Comparator<Member>() {
    @Override
    public int compare(Member a, Member b) {
        return a.getName().compareTo(b.getName());
    }
});
// 위 5줄 중 "이름순"이라는 정보를 담고 있는 것은 compareTo 한 줄뿐이다.
// 나머지 4줄은 "동작을 객체로 포장하기 위한" 껍데기다.

// after — 람다: 껍데기가 사라지고 의도만 남는다
members.sort(Comparator.comparing(Member::getName));
```

**람다는 이 껍데기를 걷어낸 것**이고, 그 결과 "동작을 값처럼 넘긴다"는 원래 하고 싶었던 일이 코드에 그대로 드러난다.

#### 람다는 익명 클래스의 축약이 아니다 (가산점 포인트)

여기서 흔한 오해가 하나 있다. "람다는 익명 클래스를 짧게 쓴 문법 설탕"이라는 것인데, **바이트코드 수준에서 아예 다른 메커니즘이다.** 실제로 두 형태를 컴파일해 산출물을 비교해 보면 차이가 바로 보인다.

```java
public class Lam {
    Comparator<String> anon() {
        return new Comparator<String>() {
            @Override public int compare(String a, String b) { return a.compareTo(b); }
        };
    }
    Comparator<String> lambda() { return (a, b) -> a.compareTo(b); }
}
```

```
// javac 후 생성된 파일 목록
Lam$1.class      <- 익명 클래스는 별도의 클래스 파일이 하나 생긴다
Lam.class
                 <- 람다는 클래스 파일이 생기지 않는다

// javap -c 로 본 lambda() 메서드
0: invokedynamic #12,  0   // InvokeDynamic #0:compare:()Ljava/util/Comparator;
5: areturn

// 그리고 같은 클래스 안에 이런 메서드가 하나 만들어져 있다
private static int lambda$lambda$0(java.lang.String, java.lang.String);
```

**익명 클래스는 컴파일 시점에 클래스 파일이 하나 더 만들어지고, 실행 시점에 그 클래스를 로딩해 인스턴스를 만든다.** 반면 람다는 **람다 본문이 같은 클래스 안의 `private static` 메서드로 들어가고, 그 자리에는 `invokedynamic`이라는 명령 하나만 남는다.** `invokedynamic`은 "여기서 무엇을 부를지는 실행 시점에 정한다"는 뜻의 바이트코드 명령으로, 처음 실행될 때 JVM(`LambdaMetafactory`)이 그 자리에 맞는 구현체를 만들어 끼워 넣고 이후에는 재사용한다.

실무에서 이 차이가 드러나는 지점이 둘 있다. **클래스 파일이 안 늘어나므로 클래스 로딩 부담과 Metaspace 사용이 줄고**, **상태를 캡처하지 않는 람다는 인스턴스를 매번 새로 만들지 않고 재사용된다.** 반대로 익명 클래스를 루프 안에서 반복 생성하면 인스턴스가 매번 새로 생긴다.

### 1-2. 함수형 인터페이스 — 람다가 들어갈 수 있는 자리의 정의

람다를 아무 데나 쓸 수 있는 것은 아니다. **람다는 결국 "추상 메서드가 딱 하나뿐인 인터페이스"의 구현체 자리에만 들어간다.** 추상 메서드가 하나여야 "이 람다가 그 메서드다"라는 대응이 애매하지 않기 때문이다. 이런 인터페이스를 **함수형 인터페이스(functional interface)**라고 부른다.

```java
@FunctionalInterface   // 추상 메서드가 2개 이상이면 컴파일 에러로 잡아준다
public interface RetryAction<T> {
    T execute() throws Exception;
}
```

`@FunctionalInterface`는 **필수가 아니라 안전장치**다. 붙이지 않아도 추상 메서드가 하나면 함수형 인터페이스로 동작하지만, 붙여 두면 나중에 누군가 메서드를 하나 더 추가할 때 **그 인터페이스를 쓰던 모든 람다가 깨지기 전에 컴파일 단계에서 막아 준다.** "이 인터페이스는 람다로 쓰라고 만든 것"이라는 의도 표시이기도 하다.

Java 8은 매번 이런 인터페이스를 직접 만들지 않아도 되도록 `java.util.function` 패키지에 표준 세트를 넣었다. 실무에서 압도적으로 자주 보는 것은 넷이다.

| 인터페이스 | 추상 메서드 | 하는 일 | 전형적 자리 |
|---|---|---|---|
| `Function<T, R>` | `R apply(T t)` | 받아서 다른 것으로 변환 | `map` |
| `Predicate<T>` | `boolean test(T t)` | 받아서 참/거짓 판정 | `filter` |
| `Consumer<T>` | `void accept(T t)` | 받아서 소비(반환 없음) | `forEach`, `ifPresent` |
| `Supplier<T>` | `T get()` | 아무것도 안 받고 만들어 냄 | `orElseGet`, 지연 생성 |

이름이 곧 성질이라 외울 것이 별로 없다. **받아서 바꾸면 Function, 받아서 판정하면 Predicate, 받아서 삼키면 Consumer, 안 받고 내놓으면 Supplier**다. 팀 전체가 이 표준 타입을 공유하게 됐다는 것 자체가 실무적으로 큰 의미다 — 예전이라면 팀마다 이름이 다른 콜백 인터페이스를 따로 만들었을 자리가 표준으로 통일됐다.

그리고 **람다의 진짜 활용처는 람다를 쓰는 쪽이 아니라 "동작을 파라미터로 받는 API를 설계하는 쪽"**이다. 이 감각이 있는지가 실무 답변의 깊이를 가른다.

```java
// 트랜잭션 템플릿: "트랜잭션 열고 닫는 절차"는 고정, 그 안의 동작만 받는다
transactionTemplate.execute(status -> orderRepository.save(order));

// 재시도 유틸: "3번까지 재시도"라는 절차는 고정, 재시도할 동작만 받는다
retry(3, () -> pgClient.approve(paymentId));

// 표준 API도 같은 형태다. "없으면 만들어 넣기"를 원자적 한 줄로
cache.computeIfAbsent(key, k -> loadFromDb(k));
```

세 코드의 공통 구조는 **"반복되는 절차는 라이브러리가 갖고, 매번 달라지는 한 조각만 호출자가 넘긴다"**는 것이다. 람다가 없던 시절에는 이런 API를 만들어도 호출부가 익명 클래스로 지저분해져 잘 쓰이지 않았다. 람다가 그 장벽을 없앴다.

### 1-3. Stream — "어떻게"를 "무엇을"로, 그리고 그것을 가능하게 하는 지연 평가

#### 무엇이 달라지는가

```java
// before — 반복문: 순회·조건·수집이라는 '방법'이 코드에 전부 드러난다
List<String> names = new ArrayList<>();
for (Order o : orders) {          // 어떻게 순회할지
    if (o.isPaid()) {             // 어떻게 걸러낼지
        names.add(o.getCustomerName());   // 어떻게 모을지
    }
}

// after — Stream: "결제된 주문의 고객명 목록"이라는 '의도'만 남는다
List<String> names = orders.stream()
        .filter(Order::isPaid)
        .map(Order::getCustomerName)
        .toList();
```

before를 읽는 사람은 `names`라는 빈 리스트가 어디서 어떻게 채워지는지를 눈으로 따라가며 **수집 로직에 버그가 없는지 검증해야 한다.** after를 읽는 사람은 그 검증을 생략할 수 있다 — 수집은 라이브러리가 하기 때문이다. 이것이 선언형의 실질적 이득이다.

#### 지연 평가 — 이게 없으면 Stream은 그냥 예쁜 for문이다

Stream의 연산은 두 종류로 나뉜다.

- **중간 연산(intermediate operation)**: `filter`, `map`, `sorted`, `peek`. Stream을 받아 Stream을 돌려준다.
- **최종 연산(terminal operation)**: `toList`, `count`, `findFirst`, `forEach`. Stream을 받아 Stream이 아닌 것(리스트, 숫자, Optional)을 돌려주거나 아무것도 안 돌려준다.

**중간 연산은 최종 연산이 붙기 전까지 단 한 줄도 실행되지 않는다.** 이것을 **지연 평가(lazy evaluation)**라고 한다. "게으르다"는 이름은 시켜도 당장 안 하고 결과가 정말 필요해질 때까지 미룬다는 뜻이다.

말로만 들으면 와닿지 않으니 실행 순서를 직접 찍어 보자. 아래는 실제로 돌린 코드와 그 출력이다.

```java
List<String> names = List.of("kim", "lee", "park", "choi");

// (1) 최종 연산 없이 파이프라인만 만들어 둔다
Stream<String> s = names.stream()
    .filter(n -> { System.out.println("  filter: " + n); return n.length() == 3; })
    .map(n -> { System.out.println("  map: " + n); return n.toUpperCase(); });
System.out.println("여기까지 출력 없음 = 아무것도 실행 안 됨");
```

```
--- (1) 최종 연산 없음 ---
여기까지 출력 없음 = 아무것도 실행 안 됨
```

`filter`와 `map` 안의 `println`이 **한 번도 실행되지 않았다.** 파이프라인을 조립해 뒀을 뿐 아직 아무 일도 하지 않은 것이다.

```java
// (2) 최종 연산을 붙이면 그때 흐른다
List<String> r = s.toList();
```

```
--- (2) toList() 붙였을 때 ---
  filter: kim
  map: kim
  filter: lee
  map: lee
  filter: park
  filter: choi
결과: [KIM, LEE]
```

**이 출력이 지연 평가의 두 번째 얼굴을 보여준다.** 순서를 잘 보면 `filter`가 네 원소를 다 돌고 나서 `map`이 도는 것이 **아니다.** kim이 filter를 통과하자마자 곧바로 map으로 가고, 그다음에야 lee가 filter로 들어간다.

```
[사람들이 흔히 상상하는 그림 — 틀렸다]
  filter 단계: kim, lee, park, choi 전부 통과 -> [kim, lee]
  map 단계   : kim, lee 전부 변환             -> [KIM, LEE]
  (중간 리스트가 단계마다 만들어진다)

[실제 동작 — 원소 하나가 파이프라인 끝까지 갔다 온다]
  kim  -> filter(통과) -> map -> 수집
  lee  -> filter(통과) -> map -> 수집
  park -> filter(탈락)                 <- map은 호출조차 되지 않는다
  choi -> filter(탈락)
  (중간 리스트가 만들어지지 않는다)
```

`park`과 `choi`는 `map:` 줄이 아예 안 찍혔다. 걸러진 원소에는 뒤 단계를 실행할 이유가 없기 때문이다.

이 구조 덕분에 **순회를 중간에 멈출 수 있다.** 조건을 만족하는 순간 나머지를 포기하는 연산을 **단락(short-circuit) 연산**이라 하고, `findFirst`, `anyMatch`, `limit`이 여기 해당한다.

```java
Optional<String> f = names.stream()
    .filter(n -> { System.out.println("  filter: " + n); return n.length() == 3; })
    .map(n -> { System.out.println("  map: " + n); return n.toUpperCase(); })
    .findFirst();
```

```
--- (3) findFirst() 단락 ---
  filter: kim
  map: kim
결과: KIM
```

**네 명 중 한 명만 보고 끝났다.** 첫 결과를 찾은 순간 lee, park, choi는 쳐다보지도 않는다. 100만 건짜리 리스트에서 조건에 맞는 첫 건을 찾을 때 for문으로 `break`를 거는 것과 같은 일을, 코드를 명령형으로 바꾸지 않고 얻는 것이다.

**지연 평가가 없다면 Stream은 그냥 문법이 예쁜 for문이다.** 단계마다 중간 리스트를 만들고 전부 순회한 뒤 다음 단계로 넘긴다면, 짧게 쓰인 대신 메모리와 순회 횟수를 더 쓰는 손해 보는 거래가 된다. 지연 평가가 그 손해를 없앤다.

#### 실무 최다 빈출은 집계다

```java
// 주문을 상태별로 묶기 — 손으로 짜면 "Map에 키가 있나 없나" 분기부터 시작하는 10줄
Map<OrderStatus, List<Order>> byStatus =
        orders.stream().collect(Collectors.groupingBy(Order::getStatus));

// 상태별 금액 합계 — groupingBy의 두 번째 인자(다운스트림 컬렉터)로
// "각 그룹을 리스트로 모으는 대신 합계로 접어라"를 지시한다
Map<OrderStatus, Long> amountByStatus = orders.stream()
        .collect(Collectors.groupingBy(Order::getStatus,
                 Collectors.summingLong(Order::getAmount)));
```

`groupingBy`의 두 번째 인자를 **다운스트림 컬렉터(downstream collector)**라고 부른다. "그룹으로 나눈 다음, 각 그룹을 어떻게 접을 것인가"를 따로 지정하는 자리다. 지정하지 않으면 기본값이 `toList()`라서 첫 번째 예시처럼 그룹별 리스트가 나온다.

### 1-4. Optional — "결과 없음"을 시그니처에 노출

```java
// before — null 반환: 시그니처만 봐서는 null 가능성을 알 수 없다
Member findByEmail(String email);   // 호출자가 체크를 잊으면 한참 뒤 엉뚱한 곳에서 NPE

// after — Optional 반환: '없음' 처리를 하지 않고는 값을 꺼낼 수 없다
Optional<Member> findByEmail(String email);

Member member = memberRepository.findByEmail(email)
        .orElseThrow(() -> new MemberNotFoundException(email));
```

핵심은 **"없을 수 있다"는 사실이 주석이나 팀 구전이 아니라 타입에 박혀 있어 컴파일러가 강제한다**는 것이다.

다만 Optional은 **쓸 자리가 좁게 정해진 도구**다. 설계자가 명시적으로 "메서드 반환 타입"용으로 만들었고, 필드·파라미터·컬렉션 원소에 쓰는 순간 오히려 상태가 하나 늘어나는 역설이 생긴다. 이 경계와 근거는 `19-optional-usage-boundaries.md`에 본편이 있으므로 여기서는 **"반환 타입 한정, 반환 직후 체이닝으로 소비"**라는 선만 긋고 넘어간다.

### 1-5. 같이 언급하면 좋은 Java 8의 나머지 축 (가산점 포인트)

이 질문에 Stream·Optional·람다만 말하면 "면접 대비 세 개만 외웠구나"로 보인다. 나머지 축을 하나만 얹어도 인상이 달라진다.

**java.time.** `Date`와 `SimpleDateFormat`이 가변인 데다 스레드 안전하지 않아 생기던 사고(`22-static-simpledateformat-shared-mutable-state.md`)를 `LocalDateTime`·`DateTimeFormatter`라는 불변 타입으로 해소했다. "Java 8 활용"에서 실무 체감이 가장 큰 것이 이것인 경우가 많다.

**CompletableFuture.** 외부 API를 여러 개 병렬 호출하고 결과를 조합하는 비동기 파이프라인. 콜백 중첩을 체이닝으로 편 것이다.

**인터페이스 default 메서드.** 이미 배포된 인터페이스에 메서드를 추가해도 기존 구현체가 깨지지 않게 하는 장치다. 이것이 없었다면 `Collection` 인터페이스에 `stream()`을 추가하는 순간 세상의 모든 `Collection` 구현체가 컴파일 에러가 났을 것이다. **Stream이 기존 컬렉션에 소급 적용될 수 있었던 것 자체가 default 메서드 덕분**이라는 연결까지 말하면 좋다.

## 2. "어떻게 활용했나"에 답하는 골격 — 기능이 아니라 장면으로

경험 질문이므로 기능 나열이 아니라 **구체적인 장면**으로 답해야 한다. 다섯 개면 충분하다.

**(1) 계층 간 변환.** 엔티티 목록을 응답 DTO 목록으로 바꾸는 `orders.stream().map(OrderResponse::from).toList()`. 팀 전체가 같은 모양으로 쓰면 리뷰어가 "여기 변환 로직에 버그 없나"를 확인할 필요가 없어져 리뷰 비용이 준다. **관용구의 가치는 짧아지는 것이 아니라 읽는 사람이 검증을 생략할 수 있게 되는 것**이다.

**(2) 집계와 그룹핑.** 관리자 화면 통계를 `groupingBy` + `counting`/`summingLong` 조합으로 만드는 것. 여기서 한 걸음 더 나가 **"이걸 SQL로 내릴지 애플리케이션에서 묶을지"의 판단 기준**까지 말하면 좋다 — 데이터가 크면 DB에서 집계해 결과만 가져오고, 이미 다른 이유로 메모리에 올라와 있는 목록이면 애플리케이션에서 묶는 편이 왕복을 아낀다.

**(3) 다중 기준 정렬.** `Comparator.comparing(...).thenComparing(...).reversed()`. 정렬 요구가 바뀌어도 비교 알고리즘이 아니라 체인만 고치면 된다.

**(4) "없음" 흐름의 통일.** 리포지토리 반환을 전부 `Optional`로 통일하고 서비스 계층에서 `orElseThrow`로 도메인 예외로 바꾸는 것. null 체크 누락으로 인한 NPE가 구조적으로 줄고, 예외 메시지에 식별자가 담기므로 장애 추적도 쉬워진다.

**(5) 절제한 경험.** 3장의 남용 사례 중 하나를 실제로 겪고 **"그래서 되돌렸다"**까지 말하는 것. 앞의 넷은 누구나 말할 수 있지만 이건 겪어야 나오는 이야기라, 이 질문의 진짜 변별 지점이 여기다.

## 3. 남용 분별 — 면접관이 정말 확인하고 싶은 것

### 3-1. 스트림 안 사이드이펙트 — 가장 위험하다

**사이드이펙트(side effect, 부수 효과)**란 어떤 코드가 자기 결과를 돌려주는 것 말고 **바깥 세상의 상태까지 바꾸는 것**을 말한다. 스트림의 람다 안에서 스트림 밖의 변수나 컬렉션을 건드리는 것이 대표적이다.

```java
// 나쁜 예 — 스트림 밖의 리스트를 안에서 변경한다
List<String> result = new ArrayList<>();
orders.stream()
      .filter(Order::isPaid)
      .forEach(o -> result.add(o.getCustomerName()));   // 외부 상태 변경

// 올바른 예 — 수집은 스트림 자신이 한다
List<String> result = orders.stream()
        .filter(Order::isPaid)
        .map(Order::getCustomerName)
        .toList();
```

**왜 문제인가.** 스트림 명세는 중간·최종 연산에 넘기는 동작 파라미터가 **무상태(stateless)·무간섭(non-interfering)**일 것을 요구한다. 무상태란 "이전 원소를 처리한 결과를 기억하지 않는다", 무간섭이란 "순회 중에 원본 데이터를 건드리지 않는다"는 뜻이다. 위 코드는 무상태 조건을 어긴다.

그런데 "지금은 잘 돌아가는데 왜 문제냐"는 반문이 자연스럽다. 답은 **누군가 `.stream()`을 `.parallelStream()`으로 바꾸는 순간 조용히 틀리기 시작한다**는 것이다. `ArrayList`는 스레드 안전하지 않아서, 여러 스레드가 동시에 `add`하면 크기 필드와 배열 쓰기가 어긋난다.

실제로 재현해 보면 심각도가 눈에 들어온다. 아래는 20만 건을 병렬로 외부 `ArrayList`에 담는 코드를 40번 반복한 결과다.

```
IntStream.range(0, 200000).boxed().parallel().forEach(sink::add);

40회 중 데이터 유실(size != 200000) : 32회
40회 중 ArrayIndexOutOfBoundsException : 6회
정상적으로 20만 건이 담긴 경우          : 2회
```

**거의 매번 틀리는데 예외조차 안 나는 경우가 대부분**이다. 담긴 건수가 20만이 아니라 매번 다른 숫자가 되는데, 그 숫자를 아무도 검증하지 않으면 데이터가 조용히 사라진 채로 배포된다.

같은 이유로 **`peek`에 로깅 이상의 로직을 넣는 것도 금물**이다. `peek`는 중간 연산이라 최종 연산이 무엇이냐에 따라 실행 여부가 달라진다. 실제로 확인해 보면 이렇다.

```java
// 최종 연산이 없으면 peek는 한 번도 실행되지 않는다
names.stream().peek(n -> System.out.println("  peek: " + n));
// 출력: (없음)

// count()는 원소를 실제로 훑지 않고 크기만으로 답할 수 있으면 그렇게 한다
long c = names.stream().peek(n -> System.out.println("  peek: " + n)).count();
// 출력: count=4     <- peek 출력이 한 줄도 안 찍혔다
```

`count()`는 원소를 세는 연산인데, 원본 소스가 크기를 알고 있고 그 사이에 개수를 바꾸는 연산(`filter` 같은)이 없으면 **순회 자체를 생략하고 크기만 돌려준다.** 그래서 `peek` 안의 코드는 실행되지 않는다. **`peek`에 상태 변경 로직을 넣어 뒀다면 그 로직이 통째로 사라지는 것**이고, 최종 연산을 `toList()`에서 `count()`로 바꾸는 것 같은 무해해 보이는 수정이 그 트리거가 된다.

### 3-2. 가독성을 해치는 체이닝 — for문으로 되돌릴 용기

```java
// 나쁜 예 — 중첩 스트림 + 긴 체인: '무엇을'이 아니라 퍼즐이 됐다
var top = teams.stream()
    .flatMap(t -> t.getMembers().stream()
        .filter(m -> m.getJoinedAt().isAfter(base))
        .map(m -> Map.entry(t.getName(), score(m, t.getWeight()))))
    .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
    .limit(10)
    .toList();
```

Stream을 쓰는 명분이 "의도가 드러난다"였는데, 이 코드에서 의도를 읽어내려면 안쪽 람다부터 역순으로 해독해야 한다. **명분이 사라졌으면 도구를 바꿔야 한다.**

판단 기준을 표로 정리하면 이렇다.

| Stream이 유리 | for문이 유리 |
|---|---|
| 변환·필터·수집·집계의 정형 파이프라인 | 인덱스가 필요하거나 두 컬렉션을 나란히 순회 |
| 각 단계가 한 줄 메서드 참조로 떨어짐 | 중간에 조기 `break`/`continue`가 여러 갈래 |
| 로직이 선형(중첩 없음) | 체크 예외를 던지는 호출이 섞임 |

표 밖의 실무 판단을 덧붙이면 이렇다.

긴 체인을 만났을 때 첫 번째 수는 for문이 아니라 **중간 단계를 이름 있는 메서드로 추출하는 것**이다. 위 예시라면 `recentMembersOf(team, base)`와 `toScoredEntry(team, member)`로 쪼개면 바깥 체인이 세 줄로 줄고 이름이 설명 역할을 한다. 그래도 안 읽히면 그때 for문이 정답이다. **목표는 "Stream을 썼다"가 아니라 "읽히게 만들었다"이다.**

체크 예외는 별도로 짚어둘 만하다. 람다 안에서 `IOException`을 던지는 호출을 하면 함수형 인터페이스의 시그니처가 그것을 허용하지 않아 컴파일 에러가 나고, 억지로 try-catch로 감싸면 체인이 누더기가 된다. 이 경우도 루프가 낫거나, **예외를 언체크로 변환하는 경계를 먼저 만들고** 그다음에 스트림을 쓰는 편이 낫다.

### 3-3. parallelStream — 편해 보이는 API의 숨은 공유 자원

`.stream()`을 `.parallelStream()`으로 바꾸는 데 드는 타이핑이 8글자라는 점이 함정이다. 비용이 0처럼 보이지만 실제로는 **JVM 전체가 공유하는 단 하나의 `ForkJoinPool.commonPool()`**을 쓴다. 그 풀의 워커 수는 기본적으로 `코어 수 - 1`이라 8코어 서버에서 7명뿐인데, 톰캣은 이미 수백 개 요청을 동시에 처리하고 있다.

그래서 웹 요청 처리 경로에서 부르면 **한 기능의 부하가 아무 상관 없는 다른 기능까지 굶긴다.** 특히 그 람다 안에 블로킹 I/O(DB 조회, 외부 API 호출)를 넣으면 워커 전원이 잠들어 전역 장애가 된다. 여기에 더해 실행 스레드가 톰캣 워커가 아니므로 `SecurityContext`·MDC·트랜잭션 바인딩이 전부 유실된다.

**이 주제는 `17-parallelstream-pitfalls.md`에 본편이 있다.** 여기서는 원칙만 잡고 넘어간다 — **기본은 순차, 병렬은 측정 후.** 그리고 "CPU 바운드 + 충분히 큰 데이터 + 분할이 싼 소스 + 상태 없는 연산"이라는 조건이 전부 맞을 때만 이득이 나는데, 웹 요청에서 다루는 수백 건 DTO 변환은 여기에 하나도 해당하지 않는다.

### 3-4. Optional 남용

**`if (opt.isPresent()) { opt.get(); }`** — null 체크를 Optional 문법으로 옮겨 적었을 뿐 단계만 하나 늘었다. `map`/`ifPresent`/`orElseThrow` 체이닝으로 바꾼다.

**`orElse(비싼호출())`** — 값이 있어도 인자가 **항상 평가된다.** 자바의 메서드 호출은 인자를 먼저 계산한 뒤 넘기기 때문이다. 실제로 확인해 보면 이렇다.

```java
Optional<String> present = Optional.of("real");

present.orElse(expensive());        // expensive()가 실행된다. 결과는 "real"
present.orElseGet(Misc::expensive); // expensive()가 실행되지 않는다. 결과는 "real"
```

```
orElse:   expensive() 호출됨
real
orElseGet: real
```

`orElseGet`은 `Supplier`를 받으므로 **정말 필요할 때만 `get()`을 부른다.** 기본값이 상수면 `orElse`, 계산이나 조회가 들어가면 `orElseGet`이라는 기준으로 나누면 된다.

**단순 null 분기 하나를 `Optional.ofNullable(x).map(...).orElse(...)`로 포장하는 것** — if 한 줄이 더 읽힌다. **Optional은 "반환 타입" 도구지 "null 체크 대체 문법"이 아니다.**

## 4. 꼬리질문 대비 포인트

### "Stream과 for문 중 무엇을 쓸지, 팀 기준을 정한다면?" (시니어 변별 포인트)

**성능이 아니라 가독성과 안전성으로 정한다**고 답하는 것이 출발점이다. 대부분의 비즈니스 로직에서 둘의 성능 차이는 병목이 아니고, 성능을 기준으로 삼는 순간 근거 없는 논쟁이 된다.

기준은 셋으로 정리한다. **(1)** 변환·필터·집계의 선형 파이프라인이고 각 단계가 짧으면 Stream — 의도가 선언적으로 드러나고, 읽는 사람이 수집 로직을 검증할 필요가 없어진다. **(2)** 인덱스 접근, 여러 갈래 조기 탈출, 체크 예외, 두 컬렉션 동시 순회는 for문 — Stream으로 우기면 오히려 흐름이 숨는다. **(3)** 성능 민감 핫패스는 어느 쪽이든 측정으로 결정한다.

그리고 실제로 중요한 마지막 조항이 있다. **"한 파일 안에서 두 스타일이 근거 없이 섞이지 않게" 리뷰 기준을 문서화하는 것**이다. 기준 자체가 완벽할 필요는 없고, 팀이 같은 기준을 공유하는 것이 개인 취향으로 매번 다투는 것보다 낫다.

### "스트림 안에서 외부 컬렉션에 add하는 코드, 뭐라고 리뷰하겠습니까?"

`collect`(또는 `toList()`)로 바꾸라고 한다. 근거는 두 겹이다.

**첫째, 잠복 버그다.** 스트림의 동작 파라미터는 무상태여야 한다는 명세 위반이고, 누군가 `parallelStream()`으로 바꾸는 순간 `ArrayList` 동시 수정으로 데이터가 유실된다. 3-1에서 확인했듯 20만 건 기준 40회 중 32회가 유실, 6회가 예외였고 정상은 2회뿐이었다. **예외가 안 나는 쪽이 더 위험하다** — 건수가 조용히 줄어든 채로 배포된다.

**둘째, 선언형의 이점이 사라진다.** 수집을 스트림 밖 변수로 빼는 순간, 읽는 사람은 "이 리스트가 어디서 어떻게 채워지는지"를 다시 눈으로 따라가야 한다. Stream을 쓴 명분 자체가 없어진 것이다.

### "람다가 캡처하는 지역 변수는 왜 effectively final이어야 하나요?"

먼저 실제로 어떤 에러가 나는지 짚고 시작하면 좋다.

```java
int count = 0;
xs.forEach(x -> System.out.println(count));   // count를 캡처
count = 1;                                     // 이후에 재대입
```

```
error: local variables referenced from a lambda expression
       must be final or effectively final
```

**effectively final**이란 "`final` 키워드가 붙어 있지는 않지만 한 번 대입된 뒤 다시 대입되지 않아서 사실상 final인 상태"를 말한다. 위 코드는 `count = 1`이 있어서 그 조건을 깬다.

**왜 이런 제약이 있는가.** 람다가 캡처하는 것은 **변수 자체가 아니라 그 시점의 값을 복사한 것**이기 때문이다. 그리고 왜 복사할 수밖에 없냐면, **지역 변수는 스택 프레임에 살고 그 프레임은 메서드가 리턴하는 순간 통째로 걷히기 때문**이다(`01-jvm-memory-structure.md`).

```
메서드 f() 실행 중
  ┌─ f()의 스택 프레임 ──────┐
  │  count = 0               │   람다는 이 값을 복사해 간다
  └──────────────────────────┘
            │
            │ f()가 리턴하면 프레임이 통째로 사라진다
            ▼
  (프레임 없음)                    그런데 람다는 아직 살아 있을 수 있다
                                   — 다른 스레드에서, 콜백으로, 나중에.
                                   원본 변수가 이미 없으니 참조할 방법이 없다.
```

즉 **람다는 원본 변수보다 오래 살아남을 수 있으므로 값을 복사해 갈 수밖에 없다.** 그런데 복사해 간 뒤에 원본이 바뀌면 **"복사본과 원본이 다른 값"**이라는 상태가 된다. 어느 쪽이 맞는 값인지 정할 방법이 없고, 특히 다른 스레드에서 실행되는 경우 언제 바뀐 값인지도 알 수 없다. 그래서 **언어가 아예 재대입을 금지해 그 혼란이 생길 여지를 없앤 것**이다.

인스턴스 필드는 이 제약을 받지 않는다는 점도 대비로 말하면 좋다. 필드는 힙의 객체 안에 있어 메서드가 끝나도 사라지지 않으므로, 복사가 아니라 **객체 참조를 통해 실시간으로 읽는다.** 그래서 얼마든지 바뀌어도 된다(대신 동시성 문제는 그대로 남는다).

실무에서는 루프 카운터를 람다에서 쓰려다 이 에러를 만나는 장면이 대표적이다. 이때 `int[] count = new int[1]`처럼 배열 한 칸에 담아 우회하는 코드를 종종 보는데, **그건 사이드이펙트를 억지로 만들어 넣는 신호이므로 리팩터링 대상**이다. 대개는 `IntStream.range`나 `collect`로 다시 표현할 수 있다.

### "map과 flatMap의 차이는?"

`map`은 **원소를 1:1로 변환**한다. `Stream<Order>`에 `map(Order::getCustomerName)`을 걸면 원소 하나당 문자열 하나가 나오므로 `Stream<String>`이 된다. 개수가 변하지 않는다.

`flatMap`은 **원소 하나가 0개에서 N개로 펼쳐질 때 그것을 한 층으로 평탄화**한다. 팀 하나에 멤버가 여럿이므로 `Stream<Team>`에서 멤버를 꺼내면 원소당 여러 개가 나온다. 여기에 `map`을 쓰면 `Stream<List<Member>>`(스트림 안에 리스트가 들어 있는 상태)가 되어 다음 연산을 걸 수 없는데, `flatMap`을 쓰면 `Stream<Member>`로 펴진다. **"flat"이 평평하게 편다는 뜻이고, 중첩된 한 겹을 벗기는 것이다.**

판별 기준은 간단하다. **`Stream<List<T>>`나 `Stream<Stream<T>>`가 중간에 보이면 거기가 flatMap 자리다.**

Optional에도 같은 구분이 있다. 변환 함수가 이미 `Optional`을 반환하는데 `map`을 쓰면 `Optional<Optional<T>>`가 되므로, 그럴 때는 `flatMap`을 쓴다. 원리가 같다.

### "Java 8 '이후' 버전에서 이 축이 어떻게 이어졌는지 아는 대로?" (가산점 포인트)

세 축이 이후 버전에서 계속 다듬어졌다는 것을 보여주면 된다. 전부 나열할 필요는 없고 두세 개만 골라 말한다.

- `Optional.ifPresentOrElse`, `Optional.or` (Java 9) — "있으면 A, 없으면 B"를 if 없이 표현
- `Stream.takeWhile` / `dropWhile` (Java 9) — 정렬된 스트림에서 조건이 깨지는 지점까지만 취하거나 버린다
- `Collectors.teeing` (Java 12) — 한 번의 순회로 두 가지 집계를 동시에
- `Stream.toList()` (Java 16) — `collect(Collectors.toList())`가 한 단어로
- `List.of` / `Map.of` (Java 9) — 불변 컬렉션 생성이 한 줄로
- `var` (Java 10) — 긴 제네릭 타입의 스트림 중간 변수 선언을 가볍게

**"8에서 멈춘 지식이 아니라 흐름을 따라가고 있다"**는 신호를 주는 것이 이 질문의 목적이다. 여기에 Java 21의 가상 스레드가 `parallelStream`이 풀지 못한 "블로킹 I/O 병렬화" 문제에 다른 답을 내놓았다는 것까지 연결하면(`28-virtual-threads-pinning.md`) 더 좋다.

---

## 한 줄 요약

Java 8의 세 기능은 각각 "동작을 값처럼 넘길 수 없다"(람다, 그리고 그것은 익명 클래스의 축약이 아니라 클래스 파일조차 만들지 않는 `invokedynamic` 메커니즘이다), "순회 방법이 코드에 다 드러난다"(Stream, 그것을 예쁜 for문과 가르는 것은 원소가 파이프라인을 하나씩 통과하며 필요한 만큼만 도는 지연 평가다), "결과 없음이 시그니처에 안 보인다"(Optional, 반환 타입 한정)는 서로 다른 제약을 푼 도구이고 — 실무 역량은 관용구를 팀의 공용어로 쓰는 것과, 스트림 안 사이드이펙트·퍼즐이 된 체이닝·근거 없는 parallelStream·경계를 넘은 Optional을 알아보고 for문과 if로 되돌리는 절제에서 갈린다.
