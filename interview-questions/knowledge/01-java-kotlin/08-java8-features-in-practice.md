# Java 8+ 기능의 실무 활용 — Stream·Optional·람다는 "쓰는 것"보다 "절제"가 실력

> 핵심 관전 포인트: **Java 8의 세 기능은 각각 다른 문제를 푼다 — 람다는
> "동작을 값처럼 전달", Stream은 "컬렉션 처리를 선언형으로", Optional은
> "결과 없음을 시그니처에 노출".** 실무 활용의 핵심은 문법이 아니라
> **팀 코드베이스의 관용구를 읽고 쓰는 능력 + 남용을 분별하는 감각**이다.
> DTO 변환·집계·정렬은 Stream 관용구로, "없을 수 있는 조회"는
> `Optional` 반환 + `orElseThrow` 체이닝으로 처리하되, **스트림 안
> 사이드이펙트와 가독성을 해치는 긴 체이닝은 for문/메서드 추출로
> 되돌리는 판단**까지가 답이다.

---

## 0. 질문 + 의도

**질문**: "Java 8 이후 추가된 주요 기능(Stream, Optional, 람다)을 실무에서
어떻게 활용했나요?"

**출제 의도**: 버전별 문법 암기가 아니라, "팀 코드베이스의 관용구를 읽고
쓸 수 있는가"와 Stream 남용(가독성 해치는 체이닝, 스트림 안 사이드이펙트)을
분별하는 감각을 본다. 즉 "기능을 아느냐"가 아니라 "언제 쓰고 언제 멈추느냐"를
말할 수 있는지가 관전 포인트다.

## 1. 세 기능이 각각 해결한 문제

### 1-1. 람다 — "동작"을 값처럼 전달한다

Java 8 이전에는 메서드에 **동작(코드 조각)** 을 넘기려면 익명 클래스라는
무거운 포장이 필요했다.

```java
// before — 익명 클래스: 정렬 기준 하나 넘기는 데 5줄
Collections.sort(members, new Comparator<Member>() {
    @Override
    public int compare(Member a, Member b) {
        return a.getName().compareTo(b.getName());
    }
});

// after — 람다 + 메서드 참조: "무엇을 기준으로"만 남는다
members.sort(Comparator.comparing(Member::getName));
```

- 람다는 **추상 메서드가 1개인 인터페이스(함수형 인터페이스)** 의 구현체를
  간결하게 만드는 문법이다 (`Function`, `Predicate`, `Consumer`, `Supplier`
  등 `java.util.function` 표준 세트를 팀 전체가 공유하게 됐다는 점이 실무적
  의의).
- 실무에서 람다 단독보다 **"동작을 파라미터로 받는 API 설계"** 가 진짜
  활용처다: 템플릿 콜백(`transactionTemplate.execute(status -> ...)`),
  재시도 유틸(`retry(3, () -> client.call())`), `Map.computeIfAbsent` 같은
  표준 API.

```java
// 관용구 예: "없으면 만들어 넣기"를 원자적 한 줄로
cache.computeIfAbsent(key, k -> loadFromDb(k));
```

### 1-2. Stream — 컬렉션 처리를 "어떻게"가 아니라 "무엇을"로

```java
// before — 반복문: 순회·조건·수집이라는 '방법'이 코드에 다 드러난다
List<String> names = new ArrayList<>();
for (Order o : orders) {
    if (o.isPaid()) {
        names.add(o.getCustomerName());
    }
}

// after — Stream: "결제된 주문의 고객명 목록"이라는 '의도'만 남는다
List<String> names = orders.stream()
        .filter(Order::isPaid)
        .map(Order::getCustomerName)
        .toList();
```

- 중간 연산(`filter`, `map`, `sorted`)은 **지연 평가** — 종단 연산
  (`collect`, `count`, `findFirst`)이 불릴 때까지 실행되지 않고,
  `findFirst` 같은 단락(short-circuit) 연산은 조건을 만족하는 순간 순회를
  멈춘다. (가산점 포인트)
- 실무 최다 빈출 관용구는 **집계**다:

```java
// 주문을 상태별로 묶기 — 손으로 짜면 10줄짜리 Map 초기화 로직
Map<OrderStatus, List<Order>> byStatus =
        orders.stream().collect(Collectors.groupingBy(Order::getStatus));

// 상태별 금액 합계 — groupingBy + 다운스트림 컬렉터 조합
Map<OrderStatus, Long> amountByStatus = orders.stream()
        .collect(Collectors.groupingBy(Order::getStatus,
                 Collectors.summingLong(Order::getAmount)));
```

### 1-3. Optional — "없을 수 있음"을 타입으로 노출

```java
// before — null 반환: 시그니처만 봐서는 null 가능성을 알 수 없다
Member findByEmail(String email);   // 호출자가 체크를 잊으면 한참 뒤 NPE

// after — Optional 반환: '없음' 처리를 안 하고는 값을 못 꺼낸다
Optional<Member> findByEmail(String email);

member = memberRepository.findByEmail(email)
        .orElseThrow(() -> new MemberNotFoundException(email));
```

- 올바른 사용 범위는 **"없음이 정상인 조회 메서드의 반환 타입" + 반환 직후
  체이닝 소비**까지다. 필드·파라미터·컬렉션 원소에 쓰는 것은 관용구 위반
  (상세는 `19-optional-usage-boundaries.md`).

### 1-4. 같이 언급하면 좋은 Java 8의 나머지 축 (가산점 포인트)

- **java.time** — `SimpleDateFormat`/`Date`의 가변·비스레드세이프 문제를
  불변 타입(`LocalDateTime`, `DateTimeFormatter`)으로 해소. "Java 8 활용"
  질문에서 Stream보다 실무 체감이 큰 경우가 많다.
- **CompletableFuture** — 외부 API 여러 개 병렬 호출 후 조합하는
  비동기 파이프라인.
- **인터페이스 default 메서드** — 배포된 인터페이스에 메서드를 추가해도
  기존 구현체가 깨지지 않게 함 (Stream이 `Collection.stream()`으로
  소급 추가될 수 있었던 이유).

---

## 2. 실무 활용의 실제 모습 — "어떻게 활용했나"에 대한 답변 골격

경험 답변은 기능 나열이 아니라 **장면**으로 말한다:

1. **계층 간 변환**: 엔티티 목록 → 응답 DTO 목록.
   `orders.stream().map(OrderResponse::from).toList()` — 팀 전체가 같은
   모양으로 쓰는 관용구라 리뷰 비용이 준다.
2. **집계/그룹핑**: 관리자 화면 통계를 `groupingBy` + `counting`/`summingLong`
   조합으로. SQL로 내릴지 애플리케이션에서 묶을지의 판단 기준(데이터 양,
   이미 메모리에 있는가)까지 말하면 좋다.
3. **다중 기준 정렬**: `Comparator.comparing(...).thenComparing(...)
   .reversed()` — 정렬 요구가 바뀔 때 비교 로직 대신 체인만 수정.
4. **"없음" 흐름 통일**: 리포지토리 반환을 Optional로 통일하고 서비스에서
   `orElseThrow`로 도메인 예외 변환 — null 체크 누락으로 인한 NPE 계열
   버그가 구조적으로 줄어든다.
5. **절제한 경험**: 아래 3장의 남용 사례를 하나 들고 "그래서 되돌렸다"까지
   말하는 것이 이 질문의 진짜 변별 지점이다.

---

## 3. 남용 분별 — 면접관이 정말 확인하고 싶은 것

### 3-1. 스트림 안 사이드이펙트 (가장 위험)

```java
// 나쁜 예 — 스트림 밖의 리스트를 안에서 변경 (사이드이펙트)
List<String> result = new ArrayList<>();
orders.stream()
      .filter(Order::isPaid)
      .forEach(o -> result.add(o.getCustomerName()));  // 외부 상태 변경!

// 올바른 예 — 수집은 스트림 자신이 한다
List<String> result = orders.stream()
        .filter(Order::isPaid)
        .map(Order::getCustomerName)
        .toList();
```

- 왜 문제인가: 스트림 명세 자체가 동작 파라미터를 **무상태·무간섭**으로
  요구한다. 지금은 돌아가도 (a) 누군가 `parallelStream()`으로 바꾸는 순간
  `ArrayList` 동시 수정으로 **데이터 유실/`ArrayIndexOutOfBoundsException`**
  이 나고, (b) "선언형으로 읽히는데 실제로는 명령형"이라 코드를 읽는 사람의
  가정을 배신한다.
- 같은 이유로 `peek`에 로깅 이상의 로직을 넣는 것도 금물 — 중간 연산이라
  종단 연산에 따라 **아예 실행되지 않거나 일부만 실행**될 수 있다.

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

판단 기준:

| Stream이 유리 | for문이 유리 |
|---|---|
| 변환·필터·수집·집계의 정형 파이프라인 | 인덱스가 필요하거나 두 컬렉션을 나란히 순회 |
| 각 단계가 한 줄 메서드 참조로 떨어짐 | 중간에 조기 `break`/`continue`가 여러 갈래 |
| 로직이 선형(중첩 없음) | 체크 예외를 던지는 호출이 섞임 |

- 긴 체인은 **중간 단계를 이름 있는 메서드로 추출**하거나, 그래도 안 읽히면
  for문이 정답이다. "Stream을 썼다"가 아니라 "읽히게 만들었다"가 목표.
- 람다 안에서 체크 예외를 던지는 호출은 try-catch 래핑으로 체인을
  누더기로 만든다 — 이 경우도 루프가 낫거나, 예외를 언체크로 변환하는
  경계를 먼저 만든다.

### 3-3. parallelStream — 편해 보이는 API의 숨은 공유 자원

`.stream()`을 `.parallelStream()`으로 바꾸는 비용이 0이라는 점이 함정이다.
기본적으로 **JVM 전체가 공유하는 공용 ForkJoinPool**에서 돌기 때문에, 웹
요청 처리 중에 쓰면 한 기능의 부하가 다른 기능까지 굶긴다. I/O 작업에는
절대 금물. (상세는 `17-parallelstream-pitfalls.md` — 여기서는 "기본은
순차, 병렬은 측정 후"라는 원칙만.)

### 3-4. Optional 남용

- `if (opt.isPresent()) { opt.get() }` — null 체크에 단계만 추가한 것.
  `map`/`ifPresent`/`orElseThrow` 체이닝으로.
- `orElse(비싼호출())` — 값이 있어도 **항상 평가**된다. `orElseGet`으로.
- 단순 null 분기 하나를 `Optional.ofNullable(x).map(...).orElse(...)`로
  포장하는 것 — if 한 줄이 더 읽힌다. Optional은 "반환 타입" 도구지
  "null 체크 대체 문법"이 아니다.

---

## 4. 꼬리질문 대비 포인트

### "Stream과 for문 중 무엇을 쓸지, 팀 기준을 정한다면?" (시니어 변별 포인트)

성능이 아니라 **가독성과 안전성**으로 정한다고 답한다. (1) 변환·필터·집계의
선형 파이프라인이고 각 단계가 짧으면 Stream — 의도가 선언적으로 드러나고
수집·집계 코드의 버그 여지가 준다. (2) 인덱스 접근, 다중 조기 탈출, 체크
예외, 두 컬렉션 동시 순회는 for문 — Stream으로 우기면 오히려 흐름이 숨는다.
(3) 성능 민감 핫패스는 어느 쪽이든 **측정으로** 결정하되, 대부분의 비즈니스
로직에서 둘의 차이는 병목이 아니다. 핵심은 "한 파일 안에서 두 스타일이
근거 없이 섞이지 않게" 리뷰 기준을 문서화하는 것.

### "스트림 안에서 외부 컬렉션에 add하는 코드, 뭐라고 리뷰하겠습니까?"

collect로 바꾸라고 한다. 근거는 두 겹 — 첫째, 스트림의 동작 파라미터는
무상태여야 한다는 명세 위반이라 `parallelStream()`으로 바뀌는 순간
`ArrayList` 동시 수정으로 데이터가 유실될 수 있는 **잠복 버그**다. 둘째,
수집을 스트림 밖 변수로 빼는 순간 선언형이라는 Stream의 이점(읽는 사람이
"수집 로직은 검증할 필요 없음"이라고 가정할 수 있는 것)이 사라진다.

### "람다가 캡처하는 지역 변수는 왜 effectively final이어야 하나요?"

람다가 캡처하는 것은 변수 자체가 아니라 **값의 복사본**이다. 지역 변수는
스택에 살고 메서드가 끝나면 사라지는데, 람다는 그보다 오래 살아남을 수
있으므로(다른 스레드에서 실행 등) 값을 복사해 간다. 변수가 이후에 바뀔 수
있다면 "복사본과 원본이 다른 값"이라는 혼란이 생기므로, 언어가 아예
재대입을 금지한 것이다. 실무에서는 루프 카운터를 람다에 쓰려다 컴파일
에러를 만나는 장면이 대표적이고, 우회하려고 배열 한 칸(`int[] count`)에
담는 코드는 사이드이펙트 신호라 리팩터링 대상이다.

### "map과 flatMap의 차이는?"

`map`은 원소를 1:1로 변환하고(`Stream<Order>` → `Stream<String>`),
`flatMap`은 원소 하나가 **스트림(0..N개)** 으로 펼쳐질 때 그것을 한 층으로
평탄화한다(`Stream<Team>` → 각 팀의 멤버들 → `Stream<Member>`).
`Stream<List<T>>`나 `Stream<Stream<T>>`가 중간에 보이면 flatMap 자리다.
Optional에도 같은 구분이 있다 — 변환 함수가 이미 `Optional`을 반환하면
`flatMap`을 써야 `Optional<Optional<T>>` 중첩을 피한다.

### "Java 8 '이후' 버전에서 이 축이 어떻게 이어졌는지 아는 대로?" (가산점 포인트)

Stream/Optional/람다라는 축이 이후 버전에서 계속 다듬어졌다 —
`Optional.ifPresentOrElse`·`or`(9), `Stream.takeWhile`/`dropWhile`(9),
`Collectors.teeing`(12), `Stream.toList()`(16), 컬렉션 팩토리
`List.of`/`Map.of`(9)로 불변 컬렉션이 한 줄이 된 것, 그리고 `var`(10)가
긴 제네릭 타입의 스트림 중간 변수 선언을 가볍게 만든 것. "8에서 멈춘
지식이 아니라 흐름을 따라가고 있다"는 신호로 두세 개만 골라 말하면 된다.

---

## 한 줄 요약

Java 8의 람다·Stream·Optional은 각각 "동작 전달·선언형 컬렉션 처리·부재의
타입화"라는 다른 문제를 푸는 도구이고, 실무 역량은 관용구(변환·집계·
orElseThrow 체이닝)를 팀의 공용어로 쓰는 것과 남용(스트림 안 사이드이펙트,
안 읽히는 체이닝, 무분별한 parallelStream)을 알아보고 되돌리는 절제에서
갈린다.
