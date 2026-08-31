# Checked vs Unchecked 예외 — 컴파일러 강제의 차이가 아니라 "예외 처리 설계"의 차이

> 핵심 관전 포인트: **Checked는 컴파일러가 처리(catch 또는 throws 선언)를
> 강제하는 예외(`Exception` 하위 중 `RuntimeException` 제외), Unchecked는
> 강제하지 않는 예외(`RuntimeException`과 그 하위 + `Error`)다.
> 원래 설계 의도는 "호출자가 복구할 수 있는 상황 = Checked, 프로그래밍
> 오류 = Unchecked"였지만, 실무에서는 Checked가 시그니처 오염·기계적
> `catch` 삼키기를 유발해서 **대부분 Unchecked(도메인 예외) + 전역 예외
> 핸들러에서 일괄 변환**하는 방향으로 수렴했다. 단, Spring의
> `@Transactional`은 기본으로 Unchecked에서만 롤백한다는 함정까지 알고
> 있어야 "선택 기준"을 안다고 말할 수 있다.**

---

## 0. 질문 + 의도

**질문**: "Checked Exception과 Unchecked Exception의 차이는? 실무에서 어떤
기준으로 선택하나요?"

**출제 의도**: 팀의 예외 처리 컨벤션(어디서 잡고, 어디서 변환하고, 무엇을
롤백시키는가)을 설계하거나 따를 때 필요한 판단을 본다. 실무에서
`catch (Exception e) {}`로 삼켜진 예외가 장애 원인 은폐의 단골이라,
예외를 문법이 아니라 **"설계의 일부"**로 보는 사람인지 확인한다.

## 1. 개념 — 예외 계층과 컴파일러의 개입 여부

```
Throwable
├── Error                  ← Unchecked. JVM 수준 심각한 문제 (OutOfMemoryError, StackOverflowError)
│                             애플리케이션이 잡아서 복구할 대상이 아님
└── Exception
    ├── (그 외 전부)        ← Checked. IOException, SQLException, InterruptedException ...
    │                         컴파일러가 catch 또는 throws 선언을 강제
    └── RuntimeException   ← Unchecked. NullPointerException, IllegalArgumentException,
        └── ...               IllegalStateException ... 강제 없음
```

- **Checked**: 메서드가 던질 수 있으면 반드시 시그니처에 `throws`로
  선언하거나 내부에서 `catch`해야 한다. 안 하면 **컴파일 에러**.
- **Unchecked**: 선언도 catch도 강제되지 않는다. 어디서든 터질 수 있고,
  잡지 않으면 호출 스택을 타고 위로 전파된다.

### 원래의 설계 의도 (Java 언어 설계자들의 구분)

| 구분 | 의도된 용도 | 예 |
|---|---|---|
| Checked | **호출자가 예상하고 복구할 수 있는** 외부 상황 | 파일 없음, 네트워크 단절 |
| Unchecked | **코드의 버그** — 복구가 아니라 수정 대상 | null 참조, 잘못된 인자, 배열 범위 초과 |

"복구 가능하면 Checked"가 교과서 답이다 (Effective Java Item 70).
그런데 **실무는 이 구분대로 흘러가지 않았다** — 그 이유가 이 질문의
진짜 몸통이다.

## 2. 실무에서 Checked가 외면당한 이유 — 그리고 선택 기준

### 2-1. 시그니처 오염 (전파 비용)

Checked 예외는 처리하지 않는 모든 중간 계층의 시그니처에 번져 나간다.

```java
// Checked를 그대로 전파하면 — 예외와 무관한 중간 계층까지 전부 오염
public Order findOrder(Long id) throws SQLException { ... }      // repository
public OrderDto getOrder(Long id) throws SQLException { ... }     // service — DB 알 필요 없는데 SQLException을 앎
public ResponseEntity<?> order(Long id) throws SQLException { ... } // controller까지
```

- 하위 구현 세부사항(DB를 쓴다는 사실)이 상위 계층 시그니처에 노출된다 —
  **추상화 누수**. 나중에 저장소를 바꾸면 시그니처를 전부 고쳐야 한다.
- 람다·Stream과의 궁합도 최악이다. `Function`, `Supplier` 등 표준 함수형
  인터페이스는 Checked 예외를 던질 수 없어서, Stream 안에서 Checked를
  만나면 매번 try-catch로 감싸는 장식 코드가 생긴다.

### 2-2. 기계적 catch → 예외 삼키기 (장애 은폐의 단골)

컴파일러가 "처리하라"고 강제하면, 바쁜 개발자는 **"처리한 척"**을 한다.

```java
// 최악의 패턴 — 컴파일 에러만 없앤 코드. 장애 원인 은폐의 단골
try {
    reader.read();
} catch (IOException e) {
    // TODO: 나중에 처리
}
// 파일을 못 읽었는데 아무 일 없다는 듯 다음 로직 진행 →
// 한참 뒤 엉뚱한 곳에서 데이터가 비어있다는 오류 → 원인 추적 불가
```

```java
// e.printStackTrace()나 로그만 남기고 진행하는 것도 본질은 같다
} catch (SQLException e) {
    log.error("DB 오류", e);   // 기록은 남지만...
    return null;               // 호출자는 실패를 모른 채 null을 받는다 → NPE 폭탄 돌리기
}
```

Checked 예외의 강제가 오히려 "형식적 catch"를 양산해 **실패를 조용히
성공처럼 보이게** 만든다는 것 — 이것이 Kotlin, C#이 Checked 예외를
아예 언어에서 뺀 이유이고, Spring이 `SQLException`(Checked)을
`DataAccessException`(Unchecked) 계층으로 전부 변환해서 제공하는 이유다.

### 2-3. 그래서 실무 선택 기준

**기본값: Unchecked (RuntimeException 상속 도메인 예외) + 경계에서 일괄 처리.**

```java
// 도메인 예외는 Unchecked로
public class OrderNotFoundException extends RuntimeException {
    public OrderNotFoundException(Long orderId) {
        super("주문을 찾을 수 없습니다: " + orderId);
    }
}

// 비즈니스 코드는 시그니처 오염 없이 던지기만
public Order findOrder(Long id) {
    return orderRepository.findById(id)
            .orElseThrow(() -> new OrderNotFoundException(id));
}

// 처리는 시스템 경계 한 곳에서 — Spring이면 @RestControllerAdvice
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(OrderNotFoundException.class)
    public ResponseEntity<ErrorResponse> handle(OrderNotFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(ErrorResponse.of(e.getMessage()));
    }
}
```

**Checked를 (그래도) 고려할 좁은 경우**: 호출자가 **그 자리에서 반드시
복구 분기를 타야 하고, 그걸 잊으면 안 되는** API를 설계할 때. 예:
라이브러리 경계에서 "재시도 가능한 실패"를 호출자에게 강제로 인지시키고
싶은 경우. 단, 요즘은 이것도 예외 대신 **결과 타입(Result/sealed 타입,
Optional)**으로 표현하는 흐름이 강하다 — "실패가 정상 흐름의 일부"라면
예외가 아니라 반환값으로 모델링하는 게 낫다. (가산점 포인트)

**경계에서 만난 Checked는 즉시 Unchecked로 번역(translate)한다** — 이때
반드시 원인(cause)을 보존한다:

```java
// before — 원인 유실: 스택트레이스가 여기서 끊겨 근본 원인을 못 찾는다
} catch (IOException e) {
    throw new FileProcessingException("파일 처리 실패");   // e가 버려짐!
}

// after — cause 체이닝: 로그에 Caused by: 로 원본 예외가 이어진다
} catch (IOException e) {
    throw new FileProcessingException("파일 처리 실패: " + path, e);
}
```

## 3. 실무 함정 — `@Transactional` 롤백 규칙과 예외 삼키기 사고

### 3-1. Spring은 기본으로 Unchecked에서만 롤백한다

Spring `@Transactional`의 기본 롤백 정책:
**`RuntimeException`과 `Error`에서만 롤백, Checked 예외는 롤백하지 않고
커밋한다.** (EJB 시절 관례를 계승 — "Checked = 복구 가능한 비즈니스
상황이므로 트랜잭션은 유효하다"는 가정)

```java
@Transactional
public void placeOrder(OrderRequest req) throws StockException {  // Checked
    orderRepository.save(order);        // ① 저장됨
    stockService.decrease(req);         // ② StockException(Checked) 발생
}
// ②에서 Checked 예외가 던져져도 ①은 롤백되지 않고 커밋된다!
// → 재고 차감은 실패했는데 주문은 생성된 데이터 정합성 사고
```

```java
// 해결 1 — 도메인 예외를 Unchecked로 설계 (권장, 위 2-3 기준과 일치)
public class StockException extends RuntimeException { ... }

// 해결 2 — Checked를 유지해야 한다면 롤백 대상을 명시
@Transactional(rollbackFor = StockException.class)
```

이 함정 하나가 "Checked/Unchecked 구분이 문법 지식이 아니라 데이터
정합성 문제"임을 보여주는 대표 사례다. (가산점 포인트)

### 3-2. `catch (Exception e) {}`가 장애를 은폐한 전형적 시나리오

배치 작업에서 건별 실패를 "건너뛰기 위해" 광범위 catch를 걸어둔 코드:

```java
for (Payment p : payments) {
    try {
        settle(p);
    } catch (Exception e) {   // 일시적 오류를 건너뛰려던 의도였지만...
        log.warn("정산 실패 skip: {}", p.getId());   // 예외 객체 e를 로그에 안 남김
    }
}
```

- 어느 날 DB 커넥션 풀 고갈로 `settle()`이 **전건 실패**했는데, 로그에는
  "skip" 라인만 수천 줄 — **무엇 때문에** 실패했는지(스택트레이스)가 없어
  원인 추적에 반나절을 쓴다.
- 교훈: ① 광범위 catch를 쓰더라도 **예외 객체를 반드시 로그에 포함**
  (`log.warn("...", e)`), ② "건너뛸 수 있는 실패"와 "중단해야 하는
  실패"(인프라 장애)를 예외 타입으로 구분해 후자는 전파한다.

## 4. 꼬리질문 대비 포인트

### "Spring `@Transactional`은 Checked 예외가 발생하면 롤백하나요?"

기본 설정으로는 **롤백하지 않는다**. 기본 롤백 대상은 `RuntimeException`과
`Error`뿐이다. Checked 예외로도 롤백하려면
`@Transactional(rollbackFor = MyCheckedException.class)`를 명시해야 한다.
반대로 특정 Unchecked 예외에서 롤백을 막으려면 `noRollbackFor`를 쓴다.
실무에서는 도메인 예외를 처음부터 `RuntimeException` 기반으로 설계해
이 함정 자체를 없애는 편이 안전하다.

### "왜 Kotlin이나 C# 같은 최신 언어는 Checked 예외를 없앴나요?" (시니어 변별 포인트)

Checked 예외의 이론(복구 가능성을 타입으로 강제)은 좋았지만, 실제로는
① 처리할 수 없는 중간 계층까지 시그니처가 오염되고(추상화 누수),
② 강제된 catch가 "형식적 처리(삼키기)"를 양산했으며,
③ 람다·고차함수와 조합이 안 돼 함수형 스타일을 막았기 때문이다.
대규모 코드베이스에서 Checked의 강제가 안정성 향상보다 보일러플레이트와
은폐 버그를 더 많이 낳았다는 경험적 결론이 쌓였고, Kotlin 설계진은 이를
근거로 제외했다. 대신 "실패가 정상 흐름"인 경우는 sealed class나
`Result` 같은 **반환 타입으로 모델링**하는 쪽으로 발전했다 — 컴파일러
강제라는 목표는 유지하되, 예외가 아니라 값으로 강제하는 방식이다.

### "예외를 감쌀 때(wrapping) 꼭 지켜야 할 것은?"

**원인 예외를 cause로 반드시 전달**하는 것
(`new DomainException(msg, e)`). cause를 빠뜨리면 스택트레이스 체인이
끊겨서 로그에 최종 예외만 남고 근본 원인(어느 SQL, 어느 파일)이 유실된다.
또 하나, **잡아서 다시 던질 거면 로그는 한 군데서만** — 잡는 곳마다
로그를 찍으면 같은 예외가 3~4번 중복 기록돼 로그 노이즈로 실제 원인
찾기가 더 어려워진다 ("log and rethrow" 안티패턴).

### "Error는 catch하면 안 되나요? OutOfMemoryError는요?"

`Error`는 JVM 수준의 복구 불가능한 상태라 잡아서 처리할 대상이 아니다.
특히 `OutOfMemoryError`를 catch하고 진행하면 이미 힙이 망가진 상태에서
어떤 동작도 신뢰할 수 없다 — 잡더라도 로그 남기고 프로세스를 종료시키는
용도까지만이다. 실무 대응은 catch가 아니라
`-XX:+HeapDumpOnOutOfMemoryError`로 덤프를 남기고 재시작 후 원인을
분석하는 것이다. 예외적으로 프레임워크 최상위 루프(스레드풀의 작업
래퍼 등)가 `Throwable`을 잡는 경우가 있는데, 이는 "복구"가 아니라
"기록 후 격리/종료"가 목적이다.

### "예외를 흐름 제어(if 대용)로 쓰면 왜 안 되나요?"

① 의미론 왜곡 — 예외는 "예외적 상황"의 신호인데 정상 분기에 쓰면 코드를
읽는 사람과 모니터링 시스템(에러율 지표, APM) 모두를 속인다.
② 비용 — 예외 생성 시 `fillInStackTrace()`가 호출 스택 전체를 캡처하는
비싼 작업이라, 루프 안에서 예외로 분기하면 성능이 눈에 띄게 나빠진다.
"없음이 정상"인 경우는 `Optional` 반환이나 boolean 검사 메서드로
모델링하는 게 맞다. (가산점 포인트: 그래서 예외를 흐름 제어에 쓰는
일부 라이브러리는 스택트레이스 캡처를 생략하는 생성자 옵션
`writableStackTrace=false`를 쓴다)

---

## 한 줄 요약

Checked는 컴파일러가 처리를 강제하는 "복구 가능 상황"용, Unchecked는
강제 없는 "버그·도메인 실패"용으로 설계됐지만, 실무에서는 시그니처
오염과 형식적 catch(예외 삼키기)의 폐해 때문에 **도메인 예외는
Unchecked로 통일하고 시스템 경계(전역 핸들러)에서 일괄 변환·응답하며,
Checked를 만나면 cause를 보존해 즉시 번역하고, `@Transactional`의
"Unchecked만 롤백" 기본값까지 챙기는 것**이 예외를 설계의 일부로 다루는
방식이다.
