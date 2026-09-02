# Bean Validation(@Valid)과 도메인 검증의 역할 분담 — "이 검증은 누구의 책임인가"를 계층 설계로 답하기

> 핵심 관전 포인트: **분담 기준은 하나다 — "이 검증을 하는 데 요청 값 말고 다른 정보가 필요한가?" 요청 값만 보고 판정 가능한 형식 검증은 컨트롤러 진입 시점에 Bean Validation으로 걸러 400으로 끝내고, DB 상태가 필요하면 애플리케이션 서비스가, 객체 자신이 항상 지켜야 할 조건(불변식)이면 도메인 객체가 맡는다. 계층 간 "중복"은 목적이 다르면 중복이 아니다 — `@Valid`는 웹이라는 하나의 입구만 지키고 도메인 불변식은 배치·컨슈머·테스트까지 모든 경로를 지키므로, 이 이중 방어는 낭비가 아니라 설계다. 정리해야 할 진짜 중복은 같은 규칙이 여러 DTO와 서비스에 복붙된 것이고, 답은 검증을 지우는 방향이 아니라 커스텀 제약 애너테이션과 값 객체로 한곳에 봉인해 "검증을 잊을 수 없는 구조"를 만드는 방향이다.**

---

## 0. 질문 + 의도

**질문**: "Bean Validation(`@Valid`)과 도메인 검증의 역할 분담은 어떻게 하나요? 같은 검증이 계층마다 중복되는 문제는 어떻게 정리하나요?"

**출제 의도**: 형식 검증(컨트롤러)과 비즈니스 규칙 검증(도메인)의 경계가 없으면 검증이 중복되거나, 더 나쁘게는 "저쪽에서 하겠지"로 누락된다. "이 검증은 누구의 책임인가"를 계층 설계로 답할 수 있는지 — 검증을 애너테이션 장식이 아니라 설계 요소로 다루는지 본다.

*(이 문서의 버전 의존 서술은 Spring Boot 3.2 이상 / Spring Framework 6.1 이상 기준이며, 예외 타입은 Spring Framework 6.1과 6.2 소스에서 직접 확인한 것이다. 6.0 이하에서 달라지는 부분은 그때마다 표시한다.)*

## 1. Bean Validation이 하는 일 — 그리고 `@Valid`와 `@Validated`의 정확한 차이

### 1-1. 무엇이고, 요청 처리의 어느 지점에서 도는가

**Bean Validation은 "객체의 필드가 지켜야 할 제약을 애너테이션으로 선언하면 그것을 검사해 주는" 자바 표준 스펙이다.** 패키지 이름이 `jakarta.validation`이고, 스펙은 규격만 정의할 뿐 실제 검사를 수행하는 구현체는 따로 있다. 스프링 부트가 기본으로 끌고 오는 구현체는 **Hibernate Validator**다. `spring-boot-starter-validation` 의존성을 넣어야 이 구현체가 들어오고, 그게 없으면 애너테이션은 붙어 있어도 아무 일도 일어나지 않는다.

스프링 MVC는 컨트롤러 파라미터에 `@Valid`나 `@Validated`가 붙어 있으면 **컨트롤러 메서드 본문에 들어가기 전에** 검증을 실행한다. 정확히 어느 지점인지를 파이프라인 위에 찍으면 이렇다.

```text
 ④-b ArgumentResolver 단계
      │
      ├─ JSON 본문을 SignUpRequest 객체로 역직렬화 (바인딩)
      ├─ @Valid 가 붙어 있으면 여기서 검증 실행       ★ 이 자리다
      └─ 실패하면 예외를 던진다 → 컨트롤러 메서드는 실행되지 않는다
      ▼
 ④-c 컨트롤러 메서드 실행
```

전체 파이프라인은 `05-spring-mvc-request-flow.md`의 2-6절에 있다. 여기서 기억할 것은 **검증 실패 시 컨트롤러 본문이 아예 실행되지 않는다**는 점이다. 잘못된 요청을 가장 싼 지점에서 돌려보내는 것이 이 계층의 목적이다.

```java
public record SignUpRequest(
        @NotBlank @Email String email,
        @NotBlank @Size(min = 8, max = 64) String password,
        @NotNull @Past LocalDate birthDate
) {}

@PostMapping("/members")
public MemberResponse signUp(@RequestBody @Valid SignUpRequest request) {
    // 여기 도달했다는 것은 위 제약을 전부 통과했다는 뜻이다.
    // 그래서 이 메서드 안에서 email 이 null 인지 다시 확인할 필요가 없다.
    return memberService.signUp(request.toCommand());
}
```

**여기서 거르는 것은 전부 "요청 값 자체만 보고 판정 가능한 것"**이다. null·공백 여부, 길이, 숫자 범위, 날짜의 과거/미래, 정규식 패턴. DB를 볼 필요도, 다른 객체를 볼 필요도 없다. 이 성질이 2절 분담 기준의 출발점이 된다.

### 1-2. `@Valid`와 `@Validated`는 무엇이 다른가

주니어가 가장 많이 헷갈리는 지점이다. **둘은 서로 다른 물건이고, 소속부터 다르다.**

- **`@Valid`**는 `jakarta.validation.Valid` — 자바 표준(Bean Validation 스펙)이 정의한 애너테이션이다.
- **`@Validated`**는 `org.springframework.validation.annotation.Validated` — 스프링이 만든 애너테이션이다.

차이는 세 가지이고, 각각이 실무에서 어떤 상황에 대응하는지가 다르다.

| | `@Valid` (표준) | `@Validated` (스프링) |
|---|---|---|
| 컨트롤러 파라미터에서 검증 트리거 | 된다 | 된다 |
| 검증 그룹(groups) 지정 | 불가능 | **가능** |
| 클래스에 붙여 메서드 파라미터 검증(AOP) 켜기 | 불가능 | **가능** |
| 필드에 붙여 중첩 객체로 검증 전파(cascade) | **가능** | 불가능 |

**차이 ① 검증 그룹.** 같은 DTO를 등록과 수정에서 다른 규칙으로 검증하고 싶을 때 쓴다. 예를 들어 `id`는 수정 요청에는 필수지만 등록 요청에는 없어야 한다. 제약마다 어느 그룹에 속하는지 표시해 두고, 파라미터에서 그룹을 골라 지정한다.

```java
public interface OnCreate {}
public interface OnUpdate {}

public record ProductRequest(
        @Null(groups = OnCreate.class)      // 등록 때는 id 가 없어야 한다
        @NotNull(groups = OnUpdate.class)   // 수정 때는 id 가 있어야 한다
        Long id,
        @NotBlank(groups = {OnCreate.class, OnUpdate.class}) String name
) {}

// @Validated 의 괄호 안에 그룹을 지정한다. @Valid 에는 이 자리가 없다.
@PostMapping("/products")
public void create(@RequestBody @Validated(OnCreate.class) ProductRequest req) { ... }

@PutMapping("/products/{id}")
public void update(@RequestBody @Validated(OnUpdate.class) ProductRequest req) { ... }
```

**차이 ② 클래스에 붙이면 메서드 파라미터 검증이 켜진다.** 컨트롤러가 아닌 일반 스프링 빈(서비스 등)의 메서드 파라미터에 제약을 걸고 싶을 때 쓴다. 이때 동작 방식은 컨트롤러 파라미터 검증과 완전히 다르다 — **AOP 프록시가 메서드 호출을 가로채 검사한다.** 이 사실이 3-6절의 자기 호출 함정으로 이어진다.

```java
@Service
@Validated   // 클래스에 붙여야 이 빈의 메서드 파라미터 검증이 활성화된다
public class PointService {

    // 컨트롤러가 아닌 서비스 메서드인데도 제약이 검사된다
    public void charge(@NotNull Long memberId, @Min(1000) int amount) { ... }
}
```

**차이 ③ 중첩 객체로 파고드는 것은 `@Valid`만 한다.** DTO 안에 또 다른 객체가 있을 때, 그 필드에 `@Valid`를 붙여야 안쪽까지 검증한다. 이건 Bean Validation 스펙이 `@Valid`를 "여기서부터 안으로 들어가라"는 표시(cascade 마커)로 정해 놓았기 때문이고, 스프링 애너테이션인 `@Validated`를 필드에 붙여 봐야 아무 일도 일어나지 않는다.

```java
public record OrderRequest(
        @NotNull Long itemId,
        // @Valid 가 없으면 shipping 이 null 인지만 보고, 그 안의 제약은 검사하지 않는다.
        // 겉만 검증되고 속은 그대로 통과하는 대표적인 함정이다.
        @Valid @NotNull ShippingInfo shipping,

        // 컬렉션은 요소 하나하나까지 파고들어야 한다.
        // 타입 인자 자리의 @Valid 표기(Bean Validation 2.0 의 컨테이너 요소 검증)를 쓰거나,
        // 필드 자체에 @Valid 를 붙여도 요소로 전파된다.
        @NotEmpty List<@Valid OrderLine> lines
) {}
```

정리하면 이렇다. **컨트롤러 `@RequestBody` 파라미터에는 둘 다 쓸 수 있고 검증도 둘 다 돈다.** 실제로 스프링 내부에서 두 애너테이션을 함께 인식하는 곳이 하나 있고(`ValidationAnnotationUtils`), `@Validated`는 거기서 그룹까지 함께 넘긴다. **그룹이 필요하면 `@Validated`, 중첩 전파가 필요하면 `@Valid`**라고 외우면 헷갈리지 않는다. 실무에서는 파라미터에 `@Valid`, 그룹이 필요한 자리에만 `@Validated`를 쓰는 것이 일반적이다.

### 1-3. 검증 실패 시 실제로 무엇이 던져지는가

**검증 실패 예외는 한 종류가 아니다.** 이걸 모르면 "`MethodArgumentNotValidException` 핸들러를 만들어 뒀는데 어떤 요청은 응답 포맷이 깨져 나간다"는 상황을 만난다. 검증이 어디서 어떻게 돌았느냐에 따라 예외가 갈린다.

| 검증이 걸린 자리 | 던져지는 예외 | 기본 상태 코드 |
|---|---|---|
| `@RequestBody` + `@Valid` (JSON 본문 DTO) | `MethodArgumentNotValidException` | 400 |
| `@ModelAttribute` (쿼리 파라미터·폼 바인딩) | `MethodArgumentNotValidException` (6.1 이상) | 400 |
| 컨트롤러 메서드 파라미터에 직접 붙은 제약 (`@RequestParam @Min(1) int page`) | `HandlerMethodValidationException` (6.1 이상) | 400 |
| `@Validated` 클래스의 메서드 파라미터 검증 (서비스 빈 등) | `ConstraintViolationException` | 없음 → 그대로 두면 500 |

버전에 따라 달라지는 부분이 있어 정확히 짚어야 한다.

**`@ModelAttribute` 실패는 지금 `BindException`이 아니다.** 오래된 자료에는 "`@RequestBody`면 `MethodArgumentNotValidException`, `@ModelAttribute`면 `BindException`"이라고 적혀 있는데, Spring Framework 6.x의 `ModelAttributeMethodProcessor`는 `MethodArgumentNotValidException`을 던진다. 다만 **`MethodArgumentNotValidException`이 `BindException`을 상속하도록 바뀌었기 때문에** `@ExceptionHandler(BindException.class)`를 등록해 두면 양쪽 다 잡힌다. 옛 방식으로 짠 핸들러가 여전히 동작하는 이유가 이것이다.

**단일 파라미터 제약은 6.1부터 `@Validated` 없이도 검증된다.** 예전에는 `@RequestParam @Min(1) int page` 같은 제약을 검사하려면 컨트롤러 클래스에 `@Validated`를 붙여야 했고, 실패하면 `ConstraintViolationException`이 나왔다. Spring Framework 6.1부터는 컨트롤러 메서드 파라미터에 제약 애너테이션이 있으면 **프레임워크가 내장 메서드 검증을 수행하고 `HandlerMethodValidationException`(입력 검증 실패는 400)을 던진다.** `@Validated`가 필요 없어진 것이다.

그런데 여기에 함정이 하나 붙는다. **클래스에 `@Validated`가 붙어 있으면 내장 검증이 꺼지고 AOP 프록시 쪽으로 넘어간다.** 스프링이 그렇게 만들어 둔 이유는 같은 검증이 두 번 돌지 않게 하기 위해서인데, 결과적으로 **`@Validated`를 붙였느냐 안 붙였느냐에 따라 같은 코드에서 예외 타입이 달라진다.**

```text
컨트롤러 메서드에 @Min(1) 같은 제약이 직접 붙어 있을 때 (Spring 6.1 이상)

  클래스에 @Validated 없음 → 프레임워크 내장 메서드 검증
                            → HandlerMethodValidationException (400)

  클래스에 @Validated 있음 → AOP 프록시의 메서드 검증
                            → ConstraintViolationException (핸들러 없으면 500)
```

**이 셋 중 `ConstraintViolationException`만 스프링이 챙겨 주지 않는다.** `ResponseEntityExceptionHandler`가 기본으로 등록해 둔 예외 목록에는 `MethodArgumentNotValidException`과 `HandlerMethodValidationException`은 있지만 `ConstraintViolationException`은 없다. 그래서 서비스 빈에 `@Validated`를 쓴다면 **전역 핸들러에 이 예외를 직접 매핑해야** 응답 형식이 통일된다. 안 하면 사용자 입력 문제인데 500이 나가고, 5xx 알람까지 울린다.

```java
// 세 종류를 같은 포맷으로 수렴시킨다. 하나라도 빠지면 그 경로만 응답 모양이 다르다.
@RestControllerAdvice
public class ValidationExceptionHandler {

    // ① @RequestBody / @ModelAttribute 실패.
    //    BindException 으로 받으면 MethodArgumentNotValidException 도 함께 잡힌다(상속 관계).
    @ExceptionHandler(BindException.class)
    public ResponseEntity<ErrorResponse> handleBind(BindException e) {
        List<ErrorResponse.FieldError> errors = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new ErrorResponse.FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        return ResponseEntity.badRequest()
                .body(ErrorResponse.of(ErrorCode.INVALID_INPUT, errors));
    }

    // ② @Validated 빈의 메서드 파라미터 검증 실패.
    //    스프링이 기본 처리해 주지 않으므로 직접 등록해야 500 이 안 나간다.
    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ErrorResponse> handleConstraint(ConstraintViolationException e) {
        List<ErrorResponse.FieldError> errors = e.getConstraintViolations().stream()
                // propertyPath 는 "charge.amount" 같은 메서드.파라미터 형태다.
                // 클라이언트에게는 마지막 마디(파라미터명)만 주는 편이 쓸모 있다.
                .map(v -> new ErrorResponse.FieldError(
                        lastNode(v.getPropertyPath()), v.getMessage()))
                .toList();
        return ResponseEntity.badRequest()
                .body(ErrorResponse.of(ErrorCode.INVALID_INPUT, errors));
    }
}
```

에러 응답 포맷 자체를 어떻게 설계하고 어디에 못 박는지는 `19-global-exception-handling-error-response.md`가 다룬다. **검증 실패 예외가 세 종류라는 사실이 그 문서의 "핸들러를 빠뜨리면 그 경로만 포맷이 깨진다"는 이야기와 만나는 지점**이 여기다.

## 2. 역할 분담 기준 — "이 검증에 무엇이 필요한가"

### 2-1. 판단 순서도

계층마다 어떤 검증을 놓을지를 감으로 정하면 사람마다 팀마다 달라진다. 질문 두 개로 기계적으로 나눌 수 있다.

```text
  이 검증을 하는 데 요청 값 말고 다른 정보가 필요한가?
        │
        ├─ 아니오 (요청 값만 보면 판정된다)
        │      예: 이메일 형식, 비밀번호 길이, 수량이 1 이상인가, 날짜가 과거인가
        │      → Bean Validation (컨트롤러 DTO)          실패 시 400 + 필드별 에러
        │
        └─ 예 → 무엇이 더 필요한가?
                 │
                 ├─ DB나 외부 시스템의 상태가 필요하다
                 │      예: 이 이메일이 이미 가입돼 있나, 이 쿠폰이 발급된 것인가
                 │      → 애플리케이션 서비스                실패 시 409 등 비즈니스 에러
                 │
                 └─ 그 객체 자신이 들고 있는 상태만 있으면 된다
                        예: 이 주문이 배송 전인가, 잔액이 출금액 이상인가
                        → 도메인 객체 (불변식 + 상태 전이 메서드)  실패 시 비즈니스 예외
```

같은 것을 표로 보면 이렇다.

| 검증 | 필요한 정보 | 담당 | 실패 시 |
|---|---|---|---|
| 이메일 형식, 비밀번호 길이 | 요청 값뿐 | 컨트롤러 DTO (`@Valid`) | 400 + 필드 에러 |
| 이메일 중복 여부 | DB 조회 | 애플리케이션 서비스 | 409 등 비즈니스 에러 |
| 주문 취소 가능 여부(배송 전인가) | 주문의 현재 상태 | 도메인 객체 | 비즈니스 예외 |
| 잔액 ≥ 출금액 | 계좌 상태 | 도메인 객체 | 비즈니스 예외 |

각 계층이 답하는 질문을 한 줄로 요약하면 경계가 더 선명해진다.

**컨트롤러 DTO는 "요청이 말이 되는 형태인가"에 답한다.** 여기서 걸러지면 비즈니스 로직은 시작조차 하지 않는다. DB 커넥션도 안 잡고 트랜잭션도 안 연다. 잘못된 요청을 가장 싼 지점에서 돌려보내는 것이 목적이다.

**애플리케이션 서비스는 "지금 이 시스템의 상태에서 이 요청이 허용되는가"에 답한다.** DB를 봐야 알 수 있는 것들이다.

**도메인 객체는 "이 상태 변화가 비즈니스 규칙상 허용되는가"에 답하고, 더 근본적으로 자기 자신의 불변식을 지킨다.**

### 2-2. 불변식 — 그 자리에서 정의하고 간다

**불변식(invariant)은 "그 객체가 살아 있는 동안 언제나 참이어야 하는 조건"이다.** 생성자에서 그것을 보장하고, 이후 어떤 메서드도 그것을 깨뜨리지 않는다. "금액은 음수일 수 없다", "주문에는 최소 한 개의 주문 항목이 있다", "계좌 잔액은 0 이상이다" 같은 것들이다. 이름의 "불변"은 값이 안 바뀐다는 뜻이 아니라 **조건이 항상 참으로 유지된다**는 뜻이다.

검증과 불변식의 관계를 한 문장으로 하면 이렇다. **검증은 "지금 이 값이 맞는지 확인하는 행위"이고, 불변식은 "틀린 상태가 애초에 존재할 수 없게 만드는 성질"이다.** 후자가 훨씬 강하다.

```java
// before: 도메인이 무방비 — 검증을 전부 바깥(컨트롤러)에 의존한다
@Entity
public class Money {
    private long amount;

    public void setAmount(long amount) { this.amount = amount; }
    // 누가 -1000 을 넣어도 막을 방법이 없다.
    // 컨트롤러를 거치지 않는 경로 — 배치, 메시지 컨슈머, 내부 API, 테스트 —
    // 에서는 "저쪽에서 검증하겠지" 가 그대로 구멍이 된다.
}
```

```java
// after: 생성 시점에 불변식을 강제 — 유효하지 않은 Money 는 존재할 수 없다
public class Money {
    private final long amount;

    public Money(long amount) {
        if (amount < 0) {
            throw new IllegalArgumentException("금액은 음수일 수 없다: " + amount);
        }
        this.amount = amount;
    }

    // 값을 바꾸는 연산도 새 인스턴스를 만들어 돌려준다.
    // 그래야 생성자를 다시 지나가면서 불변식이 재확인된다 —
    // "이후 어떤 메서드도 불변식을 깨뜨리지 않는다" 를 구조로 보장하는 방법이다.
    public Money minus(Money other) {
        return new Money(this.amount - other.amount);
    }
}
```

**컨트롤러의 `@Valid`는 웹이라는 하나의 입구만 지킨다. 도메인 불변식은 모든 경로를 지킨다.** 이것이 도메인 검증을 컨트롤러 검증이 있어도 생략하면 안 되는 이유이고, 3-1절에서 다룰 "중복인가 아닌가" 논쟁의 답이기도 하다.

## 3. "중복" 문제 정리 — 그리고 실무 함정

### 3-1. 먼저 구분한다: 겉보기 중복과 진짜 중복

DTO에서 `@Size(min = 8)`을 검증했는데 도메인 생성자에서도 길이를 확인한다. 이건 중복인가?

**목적이 다르므로 중복이 아니다.** DTO 검증의 목적은 "사용자에게 친절한 400 응답"이다 — 필드별 메시지, 다국어, 여러 오류를 한 번에 알려주기. 도메인 검증의 목적은 "유효하지 않은 객체의 존재 자체를 차단"이다 — 개발자 실수 방어, 웹 아닌 경로 방어.

목적이 다르니 만듦새도 달라야 한다. **도메인 쪽은 사용자 응답용 메시지를 다듬을 필요 없이 `IllegalArgumentException`으로 단순하게 던지면 된다.** 정상 운영에서는 DTO 검증이 먼저 걸러 주므로 도메인 예외가 실제로 터진다는 것은 앞 계층이 뚫렸다는 뜻이고, 그래서 도메인 예외는 **사용자 안내가 아니라 버그 감지기**로 동작한다.

이 이중 방어는 비용이 거의 없고 이득이 커서 **의도된 중복**으로 받아들이는 것이 일반적인 결론이다.

정리해야 할 진짜 중복은 두 가지다.

**① 같은 형식 규칙이 여러 DTO에 복붙돼 있다.** 전화번호 정규식이 가입·수정·관리자 등록 DTO에 각각 박혀 있고, 정책이 바뀌면 하나를 빼먹는다.

**② 같은 비즈니스 검증이 서비스 여기저기에 복붙돼 있다.** "취소 가능한 상태인가"를 여러 서비스 메서드가 각자 if문으로 검사한다.

### 3-2. 형식 규칙의 중복 → 커스텀 제약 애너테이션으로 한곳에

```java
// before: 정규식이 DTO 마다 복붙돼 있다
public record SignUpRequest(
        @Pattern(regexp = "^01[0-9]-\\d{3,4}-\\d{4}$") String phone, ...) {}

public record UpdateProfileRequest(
        @Pattern(regexp = "^01[0-9]-\\d{3,4}-\\d{4}$") String phone, ...) {}

// 규칙이 바뀌면 grep 으로 전부 찾아 고쳐야 하고, 하나를 놓치면 그게 그대로 구멍이 된다.
// 게다가 "이 정규식이 우리 팀의 공식 전화번호 규칙인가" 를 판단할 근거가 어디에도 없다.
```

```java
// after: 제약을 애너테이션 하나로 정의해 재사용한다
@Documented
@Constraint(validatedBy = {})            // 별도 Validator 클래스 없이 아래 제약을 합성만 한다
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Pattern(regexp = "^01[0-9]-\\d{3,4}-\\d{4}$")
@ReportAsSingleViolation                 // 내부 제약이 여러 개여도 위반 메시지는 하나로 묶는다
public @interface PhoneNumber {
    String message() default "휴대전화 형식이 올바르지 않습니다";
    Class<?>[] groups() default {};                     // 이 셋은 스펙이 요구하는 필수 속성이다
    Class<? extends Payload>[] payload() default {};
}

public record SignUpRequest(@PhoneNumber String phone, ...) {}
public record UpdateProfileRequest(@PhoneNumber String phone, ...) {}
// 규칙 변경이 한 파일 수정으로 끝나고, 규칙의 이름(@PhoneNumber)이 곧 문서가 된다.
```

### 3-3. 값 객체로 봉인 — "검증되지 않은 값"이 타입 수준에서 존재할 수 없게 만든다

애너테이션으로 규칙을 모으는 것은 **DTO 계층 안에서만** 통한다. 그 값이 DTO를 떠나 서비스와 도메인을 떠돌기 시작하면 다시 "이 문자열은 검증된 것인가?"를 매번 물어야 한다.

**값 객체(Value Object)는 형식과 의미가 있는 값을 원시 타입 대신 전용 타입으로 감싸, 그 타입이 존재한다는 사실 자체가 유효성의 증거가 되게 만드는 기법이다.** "값"이라는 이름은 식별자(id)로 구분되는 엔티티와 달리 **값이 같으면 같은 것으로 취급된다**는 성질에서 왔다.

```java
// before: String email 이 계층을 떠돌고, 받는 쪽마다 알아서 검증한다
public class MemberService {

    public void changeEmail(Long memberId, String email) {
        // 여기서도 검증한다. 이 메서드를 부르는 쪽이 검증했는지 알 수 없기 때문이다.
        if (email == null || !email.contains("@")) {
            throw new IllegalArgumentException("이메일 형식 오류");
        }
        ...
    }

    public void sendWelcomeMail(String email) {
        // 여기서도 검증해야 하나? 안 하면 불안하고, 하면 또 중복이다.
        // "이 String 이 검증된 이메일인지" 를 타입이 말해 주지 않는 것이 문제의 뿌리다.
        ...
    }
}
```

```java
// after: Email 타입이 존재한다 = 유효하다
public record Email(String value) {

    private static final Pattern PATTERN = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    // record 의 compact 생성자 — 모든 생성 경로가 반드시 이 검사를 지나간다.
    // new Email(...) 로 만들든 역직렬화로 만들든 우회할 방법이 없다.
    public Email {
        if (value == null || !PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException("이메일 형식 오류: " + value);
        }
    }
}

public class MemberService {

    // 시그니처가 Email 을 받는 순간, 이 메서드 안에서 형식 검증은
    // "안 해도 되는" 것이 아니라 "할 수 없는"(이미 보장된) 것이 된다.
    public void changeEmail(Long memberId, Email email) { ... }

    public void sendWelcomeMail(Email email) { ... }
}
```

두 방식의 차이를 그림으로 보면 이렇다.

```text
[before]  String 이 떠다닌다 — 검증 여부를 타입이 말해 주지 않는다

   컨트롤러 ──String──▶ 서비스 ──String──▶ 도메인 ──String──▶ 메일 발송
      @Email          "검증됐나?"       "검증됐나?"      "검증됐나?"
                          ↓                 ↓                ↓
                      또 검사한다        또 검사한다      그냥 믿는다(위험)

   ★ "검증되지 않은 이메일 문자열" 이 시스템 안에 존재할 수 있다.
     배치나 메시지 컨슈머처럼 컨트롤러를 안 거치는 경로가 그 통로다.

[after]  Email 타입이 떠다닌다 — 존재 자체가 유효성 증명이다

   컨트롤러 ──Email──▶ 서비스 ──Email──▶ 도메인 ──Email──▶ 메일 발송
              ↑
      Email 을 만드는 유일한 통로(생성자)에서 한 번 검사한다

   ★ "검증되지 않은 Email" 은 타입 수준에서 만들어질 수가 없다.
     검증 코드는 시스템 전체에 딱 한 곳(Email 의 생성자)에만 존재한다.
```

**핵심은 검증 횟수를 줄인 것이 아니라 "검증되지 않은 상태"라는 것을 표현 불가능하게 만든 것**이다. 잘못된 상태를 만들 방법이 없으면 그 상태를 검사할 필요도 없어진다.

값 객체가 주는 이득이 하나 더 있다. **같은 타입의 값이 여러 개일 때 순서 실수를 컴파일러가 잡는다.** `transfer(String from, String to)`에 계좌번호 두 개를 바꿔 넣으면 컴파일도 통과하고 테스트도 어쩌면 통과하지만, `transfer(AccountNo from, Email to)`처럼 타입이 다르면 애초에 컴파일이 안 된다. 원시 타입으로 모든 것을 표현하려는 습관을 **원시 타입 집착(primitive obsession)**이라 부르고, 값 객체가 그 처방이다.

비용도 정직하게 말하면 클래스 수가 늘고 JPA 매핑(`@Embeddable`이나 `AttributeConverter`) 손질이 필요하다는 것 정도다. 그래서 **모든 String을 감싸는 것이 아니라 규칙이 있고 여러 계층을 떠도는 핵심 도메인 값부터 선별 적용**한다.

### 3-4. 상태 전이 규칙의 중복 → 도메인 메서드로 봉인

형식이 아니라 "지금 이 상태에서 이 동작이 가능한가"라는 규칙도 같은 방식으로 한곳에 모은다.

```java
// before: 여러 서비스가 각자 if 문으로 같은 규칙을 검사한다
public class OrderService {
    public void cancel(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        if (order.getStatus() != OrderStatus.BEFORE_SHIPPING) { throw new ...; }
        order.setStatus(OrderStatus.CANCELED);
    }
}

public class AdminOrderService {
    public void forceCancel(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        // 같은 규칙이 또 있다. 규칙이 바뀌면 두 곳을 고쳐야 하고, 하나를 놓치면 구멍이다.
        // 더 나쁜 것은 세 번째 호출자가 이 검사를 아예 빼먹는 경우다 — 아무도 못 막는다.
        order.setStatus(OrderStatus.CANCELED);
    }
}
```

```java
// after: 검증과 상태 변경을 한 메서드 안에 묶는다
public class Order {

    private OrderStatus status;

    public void cancel() {
        if (status != OrderStatus.BEFORE_SHIPPING) {
            throw new OrderCancelNotAllowedException(id, status);
        }
        this.status = OrderStatus.CANCELED;
    }
    // status 에 setter 가 없다는 것이 이 설계의 핵심이다.
    // 취소하려면 cancel() 을 부를 수밖에 없고, cancel() 은 검증을 건너뛸 수 없다.
    // "검증을 잊을 수 없는 구조" 가 중복 제거의 종착점이다.
}
```

정리하면 **중복 정리는 "검증을 지우는" 방향이 아니라 "검증을 한곳에 모으고 나머지는 그 타입과 메서드를 믿게 만드는" 방향**이다. 검증을 지워서 정리하면 언젠가 그 빈틈으로 잘못된 데이터가 들어온다.

### 3-5. 계층별 실패를 에러 응답으로 옮기기

역할 분담의 마무리는 예외 매핑이다. 각 계층의 실패가 서로 다른 뜻을 가지므로 응답도 달라야 한다.

| 어디서 실패했나 | 예외 | 응답 | 왜 |
|---|---|---|---|
| DTO 형식 검증 | `BindException` 계열 | 400 + 필드별 에러 | 사용자가 입력을 고치면 해결된다 |
| 애플리케이션/도메인 비즈니스 규칙 | 비즈니스 예외 | 409·422·400 + 에러 코드 | 상황에 맞는 코드를 팀 규칙으로 정한다 |
| 도메인 불변식 위반 | `IllegalArgumentException` 등 | **500 + 알람** | 사용자 잘못이 아니라 앞 계층 검증이 뚫린 버그다 |

세 번째 줄이 이 표의 핵심이다. **"정상 흐름에서는 나올 수 없는" 예외를 400으로 내려보내면 사용자에게 "입력을 확인하세요"라고 거짓말을 하면서 우리 버그는 알람도 없이 묻힌다.** 400과 500의 구분은 "누구 잘못인가"의 선언이고, 그 선언이 정확해야 로그와 알람이 제 역할을 한다. 상태 코드 선택 기준과 로그 정책은 `19-global-exception-handling-error-response.md`의 2-4절과 3-1절이 다룬다.

### 3-6. 실무 함정 모음

**함정 ① `@NotNull` · `@NotEmpty` · `@NotBlank`를 구분하지 않는다.** 이름이 비슷해 아무거나 쓰다가 공백 문자열이 통과한다.

| 애너테이션 | 적용 대상 | `null` | `""` | `"   "` (공백만) |
|---|---|---|---|---|
| `@NotNull` | 모든 타입 | 거부 | **통과** | **통과** |
| `@NotEmpty` | 문자열, 컬렉션, 맵, 배열 | 거부 | 거부 | **통과** |
| `@NotBlank` | 문자열만 | 거부 | 거부 | 거부 |

**문자열에는 거의 항상 `@NotBlank`가 맞다.** `@NotNull`만 붙은 이름 필드는 `"   "`를 받아들이고, 그 값은 DB에 그대로 저장돼 나중에 화면에서 빈칸으로 보인다. 반대로 **컬렉션에는 `@NotBlank`를 쓸 수 없고**(문자열 전용이다) `@NotEmpty`를 쓴다. 숫자나 날짜처럼 "비어 있음"이라는 개념이 없는 타입에는 `@NotNull`이 맞다.

**함정 ② 중첩 객체와 컬렉션 요소에 `@Valid`를 빠뜨린다.** 1-2절에서 본 그대로다. 필드에 `@Valid`가 없으면 그 안쪽 제약은 검사되지 않고, 겉만 통과한 요청이 서비스로 들어온다. 컬렉션도 `List<@Valid OrderLine>`처럼 요소까지 챙긴다. **가장 흔하면서 가장 조용한 함정**이라 코드 리뷰 체크리스트에 넣을 값어치가 있다.

**함정 ③ `@Validated` 메서드 검증은 프록시 기반이라 자기 호출에 무력하다.** 1-2절에서 본 대로 이 검증은 AOP 프록시가 호출을 가로채 수행한다. 그런데 같은 클래스 안에서 `this.charge(...)`로 부르면 그 호출은 프록시를 거치지 않고 원본 객체 안에서 곧바로 일어나므로, **가로챌 기회 자체가 없어 검증이 통째로 건너뛰어진다.**

```java
@Service
@Validated
public class PointService {

    public void chargeAll(List<Long> memberIds) {
        for (Long id : memberIds) {
            // 문제: 이 호출은 프록시를 거치지 않는다.
            //       amount 가 0 이어도 @Min(1000) 이 검사되지 않는다.
            //       에러가 나는 것이 아니라 "조용히 검증 없이" 통과한다는 점이 악질이다.
            this.charge(id, 0);
        }
    }

    public void charge(@NotNull Long memberId, @Min(1000) int amount) { ... }
}
```

**`@Transactional` 자기 호출 함정과 정확히 같은 뿌리**다. 원인 분석(메모리에 원본과 프록시 두 객체가 있고 `this`는 프록시가 아니다)과 해법 네 가지의 트레이드오프는 `11-transactional-self-invocation.md`가 다룬다. 여기서 알아야 할 것은 **"프록시 기반 부가 기능은 전부 이 함정을 공유한다"**는 일반화다.

**함정 ④ DB 조회가 필요한 검증을 `ConstraintValidator` 안에 숨긴다.** 커스텀 Validator는 스프링 빈이라 Repository를 주입받을 수 있고, 그래서 "이메일 중복 검사"를 `@UniqueEmail` 같은 애너테이션으로 만들고 싶어진다. 권하지 않는 이유는 4절 꼬리질문에서 다룬다.

**함정 ⑤ AI 생성 코드의 검증 배치.** AI가 만든 코드는 두 극단으로 치우치는 패턴이 흔하다 — 검증을 서비스 메서드 첫머리의 if문 뭉치로 몰아넣거나, 반대로 DTO 애너테이션만 붙이고 도메인을 무방비로 두거나. 리뷰 체크리스트는 셋이다. **① 형식 검증이 DTO에 있는가 ② 도메인 객체가 불변식을 스스로 지키는가(setter로 상태를 바꾸고 있지 않은가) ③ DB가 필요한 검증이 Validator 안에 숨어 있지 않은가.**

## 4. 꼬리질문 대비 포인트

### "`@Valid`와 `@Validated`의 차이는 무엇인가요?"

**소속이 다르다**는 것부터 말한다. `@Valid`는 `jakarta.validation`의 자바 표준이고, `@Validated`는 스프링이 만든 것이다.

차이는 셋이다. **① `@Validated`는 검증 그룹을 지정할 수 있다** — 같은 DTO를 등록과 수정에서 다른 규칙으로 검증할 때 쓴다. **② `@Validated`를 클래스에 붙이면 컨트롤러 밖 스프링 빈의 메서드 파라미터 검증이 AOP 프록시로 켜진다.** **③ 반대로 중첩 객체로 검증을 전파하는 것은 `@Valid`만 한다** — cascade 마커는 Bean Validation 스펙이 `@Valid`로 정해 놓았기 때문이다.

**컨트롤러 `@RequestBody` 파라미터에는 둘 다 쓸 수 있고 검증도 둘 다 돈다**는 점을 정확히 말하는 것이 중요하다. "`@Valid`는 컨트롤러, `@Validated`는 서비스"라는 식으로 외운 답은 절반만 맞다. **그룹이 필요하면 `@Validated`, 중첩 전파가 필요하면 `@Valid`**가 정확한 기준이다.

여기에 ②의 대가를 덧붙이면 좋다. **프록시 기반이라 자기 호출에는 적용되지 않고**, 실패 예외도 달라서 전역 예외 처리에서 따로 매핑해야 한다.

### "검증 실패 시 어떤 예외가 던져지나요?" (실무 함정)

**한 종류가 아니라는 것**이 이 질문의 답이다. Spring Framework 6.1 이상 기준으로 셋을 구분한다.

**① `@RequestBody`나 `@ModelAttribute` 바인딩 검증 실패 → `MethodArgumentNotValidException`.** 이 예외가 `BindException`을 상속하므로 `@ExceptionHandler(BindException.class)` 하나로 둘 다 잡힌다. (오래된 자료의 "`@ModelAttribute`는 `BindException`"은 6.x에서는 정확하지 않다.)

**② 컨트롤러 메서드 파라미터에 직접 붙은 제약 → `HandlerMethodValidationException`.** 6.1부터는 `@Validated` 없이도 프레임워크가 내장 검증을 수행한다. 다만 **클래스에 `@Validated`를 붙이면 내장 검증이 꺼지고 AOP 쪽으로 넘어가 `ConstraintViolationException`이 나온다** — 애너테이션 하나로 예외 타입이 바뀐다는 것이 핵심이다.

**③ `@Validated` 클래스의 메서드 파라미터 검증 → `ConstraintViolationException`.**

마무리로 실무 결론을 낸다. **③만 스프링이 챙겨 주지 않는다.** `ResponseEntityExceptionHandler`의 기본 처리 목록에 ①과 ②는 있지만 `ConstraintViolationException`은 없어서, 매핑을 빠뜨리면 사용자 입력 문제인데 500이 나가고 5xx 알람까지 울린다.

### "DTO에서 검증했는데 도메인에서 또 검증하는 건 낭비 아닌가요?" (시니어 변별 포인트)

**목적이 달라서 낭비가 아니다.** DTO 검증은 웹 입구에서 사용자에게 친절한 400을 주기 위한 것이고, 도메인 검증(불변식)은 **웹을 거치지 않는 모든 경로 — 배치, 메시지 컨슈머, 다른 서비스 메서드, 테스트 — 에서 유효하지 않은 객체가 만들어지는 것 자체를 막기 위한 것**이다.

**도메인 방어를 지우고 DTO만 믿으면 "컨트롤러를 거칠 때만 안전한" 시스템이 된다.** 그리고 컨트롤러를 안 거치는 경로는 시간이 지날수록 늘어난다.

다만 비용을 줄이는 방향은 분명히 있다는 것도 말한다. **도메인 쪽은 메시지 국제화 같은 응답 품질을 신경 쓸 필요 없이 `IllegalArgumentException`만 던지면 되고, 값 객체를 쓰면 검증 코드 자체는 한곳에만 존재한다.**

한 문장으로 압축하면 **"중복처럼 보이는 이중 방어는 유지하되, 검증 로직의 소스는 하나로"**다.

### "이메일 중복 검사처럼 DB 조회가 필요한 검증은 어느 계층에서 하나요? 커스텀 Validator에서 Repository를 주입받으면 안 되나요?"

**애플리케이션/도메인 계층이 정답이다.** 기술적으로는 `ConstraintValidator`가 스프링 빈이라 Repository 주입이 가능하지만 권하지 않고, 이유가 셋이다.

**① 트랜잭션 경계가 어긋난다.** 검증은 바인딩 직후, 즉 서비스의 트랜잭션이 열리기 전에 돈다. 그래서 검증 조회와 본 로직이 서로 다른 트랜잭션에서 일어나고, 그 사이에 데이터가 바뀔 수 있다.

**② 어차피 시점 문제를 못 막는다.** "중복 없음" 판정 직후 다른 요청이 끼어들어 같은 이메일을 넣으면 판정은 무의미해진다. 이렇게 **검사한 시점과 사용하는 시점 사이에 상태가 바뀔 수 있는 문제를 TOCTOU(time-of-check to time-of-use)**라고 부른다. 그래서 DB 유니크 제약이라는 최종 방어가 반드시 필요하다.

**③ DTO 단위 테스트가 무거워진다.** 형식 검증기에 DB 의존이 생기면 그 DTO를 검증하는 테스트마다 Repository를 준비해야 한다.

정석은 **이중 구조**다. **사전 중복 검사는 서비스에서 UX용으로 하고(사용자에게 친절한 메시지를 주기 위해), 최종 보장은 유니크 제약 + `DataIntegrityViolationException` 처리로 한다.** 앞의 것은 편의이고 뒤의 것이 진짜 방어라는 역할 구분을 말하면 정확한 답이 된다.

### "값 객체로 검증을 옮기면 구체적으로 무엇이 좋아지나요?"

셋을 든다.

**① 검증 로직이 타입 하나에 봉인되어 중복이 사라진다.** 규칙 변경이 한 파일 수정으로 끝난다.

**② 시그니처가 문서가 된다.** `String email`은 "검증됐는지 알 수 없는 문자열"이지만 `Email`은 존재 자체가 유효성 증명이라, 받는 쪽에서 재검증할 필요가 없어진다. **핵심은 검증 횟수를 줄인 것이 아니라 "검증되지 않은 이메일"이라는 상태를 타입 수준에서 표현 불가능하게 만든 것**이다.

**③ 같은 타입의 값이 여러 개일 때 순서 실수를 컴파일러가 잡는다.** `transfer(from, to)`에 계좌번호 문자열 두 개를 바꿔 넣는 류의 버그다.

비용도 함께 말한다. 클래스 수가 늘고 JPA 매핑(`@Embeddable`, `AttributeConverter`) 손질이 필요하다. 그래서 **모든 원시 타입을 감싸는 것이 아니라 규칙이 있고 여러 계층을 떠도는 핵심 도메인 값부터 선별 적용**한다는 판단 기준까지 말하면 균형이 잡힌다.

### "검증 실패 응답은 어떻게 표준화하나요?"

**세 종류의 예외를 하나의 형식(에러 코드, 메시지, 필드별 상세 목록)으로 수렴시킨다.** `BindException`으로 ①과 ②를 받고(상속 관계 덕분에 `MethodArgumentNotValidException`도 함께 잡힌다), `ConstraintViolationException`을 따로 받고, 비즈니스 예외는 도메인별 에러 코드와 4xx로 매핑한다.

**포인트는 클라이언트 입장에서 "어느 계층에서 실패했는지"가 아니라 "무엇을 고쳐 보내야 하는지"가 보이는 일관된 스키마를 유지하는 것**이다. 검증이 컨트롤러에서 걸렸든 서비스 메서드에서 걸렸든 클라이언트에게는 같은 모양이 가야 한다.

여기에 하나를 분리해 말하면 답이 완성된다. **도메인 불변식 위반은 400이 아니라 500 + 알람으로 분리한다.** 앞단 검증이 뚫렸다는 버그 신호이므로 사용자에게 "입력을 확인하세요"라고 안내하는 것 자체가 틀렸고, 그렇게 처리하면 우리 버그가 4xx 통계에 섞여 영영 안 보인다.

### "`@Validated`를 서비스에 붙여 파라미터를 검증하려는데 안 걸립니다. 무엇을 확인하나요?" (실무 함정)

세 가지를 순서대로 확인한다.

**① 클래스에 `@Validated`가 붙어 있는가.** 파라미터에만 제약을 붙이고 클래스 애너테이션을 빼먹으면 AOP가 꽂히지 않아 아무 검증도 돌지 않는다. 컨트롤러가 아닌 일반 빈에서는 이것이 가장 흔한 원인이다.

**② 자기 호출이 아닌가.** 같은 클래스 안에서 `this.method(...)`로 부르면 프록시를 거치지 않아 검증이 통째로 건너뛰어진다. `@Transactional` 자기 호출과 같은 뿌리이고, **에러가 나는 것이 아니라 조용히 통과한다**는 점이 악질이다. 별도 빈으로 분리하는 것이 정석 해법이다.

**③ 호출자가 프록시를 통해 부르고 있는가.** 다른 빈에서 주입받아 부른 것이라면 프록시를 거치므로 정상이다. `new`로 직접 만든 인스턴스나, `final` 메서드라 CGLIB이 오버라이드하지 못하는 경우는 걸리지 않는다.

**"프록시 기반 부가 기능은 전부 같은 조건을 공유한다"**는 일반화까지 말하면 좋다. `@Transactional`, `@Cacheable`, `@Async`, `@Validated`가 안 먹는다는 신고는 대체로 이 셋 중 하나다.

---

## 한 줄 요약

역할 분담의 기준은 "이 검증에 요청 값 말고 무엇이 더 필요한가" 하나이고 — 요청 값만으로 판정되는 형식 검증은 컨트롤러의 Bean Validation이 400으로 걸러 내고(그때 `@Valid`는 중첩 전파, `@Validated`는 그룹과 메서드 검증이라는 서로 다른 물건이며 실패 시 던져지는 예외도 셋으로 갈린다), DB 상태가 필요하면 애플리케이션 서비스가, 객체가 살아 있는 동안 언제나 참이어야 할 불변식이면 도메인 객체가 스스로 지킨다 — 목적이 다른 이중 방어는 중복이 아니라 "웹 입구만 지키는 것"과 "모든 경로를 지키는 것"의 역할 분담이고, 정리해야 할 진짜 중복(복붙된 규칙)은 검증을 지워서가 아니라 커스텀 제약 애너테이션과 값 객체로 한곳에 봉인해 "검증되지 않은 값이 타입 수준에서 존재할 수 없는 구조"로 만드는 것이 답이다.
