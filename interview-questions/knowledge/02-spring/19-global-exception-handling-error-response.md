# 전역 예외 처리와 에러 응답 표준화 — 에러 응답도 API 계약이다

> 핵심 관전 포인트: **`@RestControllerAdvice` + `@ExceptionHandler`는 "예외를 HTTP 응답으로 바꾸는 일"을 한곳에 모으는 장치이고, 핵심은 애너테이션이 아니라 그 한곳에서 정하는 계약이다 — `ErrorCode` enum이 코드·메시지·HTTP status의 단일 진실 공급원이 되고, 모든 실패가 같은 `ErrorResponse` 모양으로 나가야 프론트엔드가 파서를 한 번만 짜고 운영이 코드별 에러율을 집계할 수 있다. 여기에 4xx는 warn·5xx는 error+알람이라는 로그 정책(4xx를 error로 찍으면 알람 피로로 진짜 장애를 놓친다)과 내부 정보 비노출을 얹고, 마지막으로 `@ControllerAdvice`가 구조적으로 닿지 못하는 구역 — 필터·`/error`·비동기 — 까지 같은 포맷으로 맞추는 것이 마무리다. 그 통일의 방법은 핸들러마다 JSON을 따로 쓰는 것이 아니라 공통 `ErrorResponse` 생성기를 만들어 세 구역이 함께 쓰게 만드는 것이다.**

---

## 0. 질문 + 의도

**질문**: "예외를 전역으로 처리하는 방법(`@ControllerAdvice`)과 에러 응답 표준화를 어떻게 설계하나요?"

**출제 의도**: 에러 응답의 일관성은 프론트엔드·모바일 팀과의 협업 비용, 그리고 장애 시 에러율 집계 가능성을 결정한다. "혼자 잘 짜는" 것 너머 "시스템의 계약을 설계"해본 사람인지 본다. 애너테이션 사용법을 아는지가 아니라, 에러 응답을 시스템 간 인터페이스로 다루는지를 보는 질문.

*(이 문서의 버전 의존 서술은 Spring Boot 3.x / Spring Framework 6.x 기준이며, 내부 동작 인용은 Spring Framework 6.2 소스를 확인한 것이다. 응답 스키마 자체의 설계 — status와 code의 이중 축, 코드의 불변 계약성, RFC 9457 채택 판단 — 는 `../09-rest-api/05-error-response-body-standardization.md`가 다루고, 상태 코드 각각의 의미는 `../08-network-http/05-http-status-codes-usage-criteria.md`가 다룬다. 이 문서는 그것을 스프링에서 어디에 어떻게 구현하느냐에 집중한다.)*

## 1. `@ControllerAdvice`는 어떻게 동작하는가

### 1-1. 전제 — 전역 처리가 없으면 무엇이 흩어지는가

```java
// before: 컨트롤러마다 제각각 — 포맷도, 상태 코드도, 로그도 다르다
@PostMapping("/orders")
public ResponseEntity<?> order(@RequestBody OrderRequest request) {
    try {
        return ResponseEntity.ok(orderService.order(request));
    } catch (SoldOutException e) {
        // A 개발자: Map 으로 즉석에서 만든다. 키 이름이 "error" 다.
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    } catch (Exception e) {
        // B 개발자: 문자열 한 줄. 500 인데 로그조차 안 남는다 —
        // 나중에 이 장애를 조사할 단서가 아무 데도 없다.
        return ResponseEntity.status(500).body("서버 오류");
    }
}
```

이 코드가 만드는 비용은 두 방향이다. **프론트엔드는 API마다 에러 파싱 코드를 따로 짜야 하고**, HTTP 클라이언트에 에러 인터셉터를 하나 두고 전부 거기서 처리하는 흔한 패턴이 성립하지 않는다. 인터셉터가 바디를 열어도 어떤 키를 읽어야 할지 API마다 다르기 때문이다.

**운영은 "어떤 실패가 얼마나 나는지"를 셀 공통 키가 없다.** 로그 수집기에서 `code` 필드로 group by 하면 몇 초면 나올 답을, 로그 문자열을 눈으로 세는 작업으로 대신하게 된다.

### 1-2. 파이프라인의 어디에 놓인 장치인가

`@ControllerAdvice`는 스스로 도는 물건이 아니다. **Spring MVC 요청 파이프라인의 한 단계에서 불려야 실행된다.**

`05-spring-mvc-request-flow.md`의 전체 도식 중 예외와 관련된 부분만 떼어 보면 이렇다.

```text
 ① Filter 체인             ← 여기서 터진 예외는 아래로 내려가지 않는다 (3-3 참고)
  ▼
 ② DispatcherServlet        doDispatch() 가 아래 전부를 try 로 감싸고 있다
  │
  ├─ ③ HandlerMapping
  ├─ ④-a Interceptor.preHandle  ─┐
  ├─ ④-b ArgumentResolver 바인딩 ├─ 이 안에서 던져진 예외만
  ├─ ④-c 컨트롤러 메서드         ─┘  catch (Exception ex) 로 잡힌다
  │        │
  │        ▼
  └─ ⑤ HandlerExceptionResolver   잡은 예외를 여기 넘긴다
         └─ ExceptionHandlerExceptionResolver
              └─ @ControllerAdvice 의 @ExceptionHandler 실행 → 응답 생성
```

**`HandlerExceptionResolver`는 "예외 하나를 받아 응답으로 바꿔 보는" 인터페이스**이고, `DispatcherServlet`은 이런 리졸버를 여러 개 등록해 두고 앞에서부터 차례로 물어본다. 스프링 MVC의 기본 구성은 셋이다.

| 순서 | 리졸버 | 담당 |
|---|---|---|
| 1 | `ExceptionHandlerExceptionResolver` | `@ExceptionHandler` 메서드를 찾아 실행한다 — 우리가 쓰는 것 |
| 2 | `ResponseStatusExceptionResolver` | 예외에 붙은 `@ResponseStatus`나 `ResponseStatusException`을 상태 코드로 바꾼다 |
| 3 | `DefaultHandlerExceptionResolver` | 스프링 MVC 표준 예외를 규격에 맞는 상태 코드로 바꾼다(예: 지원하지 않는 메서드 → 405) |

앞의 리졸버가 응답을 만들어 내면 뒤는 실행되지 않는다. **`@ExceptionHandler`가 가장 먼저 기회를 얻기 때문에, 우리가 잡기로 한 예외는 스프링 기본 처리보다 항상 우선한다.**

`@RestControllerAdvice`는 `@ControllerAdvice` + `@ResponseBody`다. 리턴 객체가 JSON으로 직렬화되므로 REST API에서는 이쪽을 쓴다.

### 1-3. 여러 핸들러 중 무엇이 실행되는가 — 세 단계 규칙

여기가 실무에서 자주 헷갈리는 지점이다. **`RuntimeException` 핸들러와 `IllegalArgumentException` 핸들러가 둘 다 있으면 어느 쪽이 이기는가?** 답은 세 단계 규칙으로 정해진다.

```text
[1단계] 컨트롤러 클래스 안에 선언된 @ExceptionHandler 를 먼저 본다
          → 있으면 전역 Advice 는 아예 조회하지 않는다

[2단계] 없으면 등록된 @ControllerAdvice 빈들을 순서대로 훑는다
          → 순서는 @Order / Ordered 로 정해지고, 지정이 없으면 가장 낮은 우선순위다
          → "매칭되는 메서드를 가진 첫 Advice" 에서 멈춘다  ★ 함정 지점

[3단계] 그 Advice 안에서 여러 메서드가 매칭되면 예외 타입이 가장 가까운 것을 고른다
          → 상속 계층에서의 거리(depth)로 비교한다
```

3단계부터 보자. **거리는 던져진 예외에서 핸들러가 선언한 타입까지 상속을 몇 번 거슬러 올라가는지다.**

```text
던져진 예외: IllegalArgumentException

  IllegalArgumentException  ← @ExceptionHandler(IllegalArgumentException.class)  거리 0
        ↑ extends
  RuntimeException          ← @ExceptionHandler(RuntimeException.class)          거리 1
        ↑ extends
  Exception                 ← @ExceptionHandler(Exception.class)                 거리 2

  → 거리가 가장 작은 IllegalArgumentException 핸들러가 이긴다
```

그래서 **`@ExceptionHandler(Exception.class)` 안전망을 하나 깔아 두어도, 구체적인 예외에 전용 핸들러가 있으면 그쪽이 먼저 잡는다.** 안전망이 모든 것을 삼켜버릴 걱정은 하지 않아도 된다.

**단, 2단계에는 진짜 함정이 있다.** 매칭은 Advice 빈 단위로 먼저 끊긴다. `@Order(1)`인 Advice에 `Exception` 핸들러만 있고 `@Order(2)`인 Advice에 `SoldOutException` 전용 핸들러가 있다면, `SoldOutException`이 던져져도 **1번 Advice에서 매칭에 성공해 버리므로 2번은 조회되지 않는다.** 전용 핸들러가 있는데도 안 불리는 현상의 정체가 이것이다.

```java
// 문제: 순서가 앞선 Advice 의 넓은 핸들러가 뒤쪽의 구체 핸들러를 가려 버린다
@Order(1) @RestControllerAdvice
class CommonAdvice { @ExceptionHandler(Exception.class) ... }     // 여기서 매칭 종료

@Order(2) @RestControllerAdvice
class OrderAdvice { @ExceptionHandler(SoldOutException.class) ... }  // 실행되지 않는다
```

```java
// 고침: 안전망은 항상 가장 낮은 우선순위에 둔다
@Order(Ordered.LOWEST_PRECEDENCE) @RestControllerAdvice
class CommonAdvice { @ExceptionHandler(Exception.class) ... }

@Order(Ordered.HIGHEST_PRECEDENCE) @RestControllerAdvice
class OrderAdvice { @ExceptionHandler(SoldOutException.class) ... }
```

**규칙 하나로 정리하면: 넓게 잡는 Advice일수록 뒤에 둔다.** 실무에서는 Advice를 여러 개로 쪼갤 때만 문제가 되므로, 하나로 시작해 필요할 때 쪼개면서 순서를 명시하는 편이 안전하다.

## 2. 응답 계약 설계 — `ErrorCode`를 단일 진실 공급원으로

### 2-1. 뼈대는 세 조각이다

표준화의 목표를 정확히 잡자. **"코드 · 사용자 메시지 · HTTP status"라는 세 값의 조합이 코드베이스 전체에서 딱 한 곳에만 존재하게 만드는 것**이다. 그 한 곳이 enum이다.

```java
// ① 에러 코드 enum — 코드·메시지·status 의 단일 진실 공급원
public enum ErrorCode {

    ORDER_SOLD_OUT("ORDER-001", "재고가 소진된 상품입니다", HttpStatus.CONFLICT),
    ORDER_NOT_FOUND("ORDER-002", "주문을 찾을 수 없습니다", HttpStatus.NOT_FOUND),
    INVALID_INPUT("COMMON-001", "입력값이 올바르지 않습니다", HttpStatus.BAD_REQUEST),
    INTERNAL_ERROR("COMMON-999", "일시적인 오류가 발생했습니다", HttpStatus.INTERNAL_SERVER_ERROR);

    private final String code;
    private final String message;
    private final HttpStatus status;
    // 생성자·게터 생략
}

// ② 비즈니스 예외 — ErrorCode 를 품는 단일 베이스
// 예외 클래스를 에러마다 만들지 않고 하나로 두는 이유는,
// 핸들러를 하나만 쓰기 위해서다. 예외 종류가 늘 때마다 핸들러가 늘면 표준화가 아니다.
public class BusinessException extends RuntimeException {
    private final ErrorCode errorCode;

    public BusinessException(ErrorCode errorCode) {
        super(errorCode.getMessage());
        this.errorCode = errorCode;
    }
}

// ③ 공통 응답 포맷 — 모든 실패가 이 모양으로만 나간다
public record ErrorResponse(
        String code,                    // "ORDER-001" — 프론트 분기·에러율 집계의 키
        String message,                 // 사용자에게 보여도 되는 문구만
        List<FieldError> errors,        // 검증 실패 시 필드별 상세. 아니면 빈 리스트
        String traceId                  // 로그 검색의 진입점 (3-2)
) {
    public record FieldError(String field, String reason) {}
}
```

`errors`가 검증 실패가 아닐 때 **빈 리스트로 나간다**는 점이 중요하다. 에러 종류에 따라 필드가 생겼다 없어졌다 하면 소비자는 파서를 다시 분기해야 하고, 그러면 "포맷이 여러 개인 상태"에 표준화라는 이름만 붙인 것이 된다.

### 2-2. 전역 핸들러

```java
// after: 컨트롤러에서 try-catch 가 사라진다
@Slf4j
@RestControllerAdvice
@RequiredArgsConstructor
public class GlobalExceptionHandler {

    // 비즈니스 예외: ErrorCode 가 응답의 전부(코드·메시지·status)를 결정한다
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ErrorResponse> handleBusiness(BusinessException e) {
        ErrorCode code = e.getErrorCode();
        // 4xx 는 warn 이하 + 스택트레이스 없이. 근거는 3-1 에서 계산으로 보인다.
        log.warn("business error: code={}, message={}", code.getCode(), e.getMessage());
        return ResponseEntity.status(code.getStatus()).body(ErrorResponse.of(code));
    }

    // @RequestBody + @Valid 검증 실패. 필드별 상세를 같은 포맷의 errors 자리에 담는다.
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException e) {
        List<ErrorResponse.FieldError> errors = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new ErrorResponse.FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        // 실패한 필드를 전부 담는 이유: 하나만 알려주면 사용자가 고치고 제출할 때마다
        // 다음 오류를 새로 만나는 UX 가 된다.
        return ResponseEntity.badRequest()
                .body(ErrorResponse.of(ErrorCode.INVALID_INPUT, errors));
    }

    // 최후의 안전망. 여기 걸린다는 것은 "우리가 예상하지 못한 실패" 라는 뜻이다.
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception e) {
        log.error("unexpected error", e);   // 5xx 는 error + 스택트레이스 전체 + 알람
        return ResponseEntity.internalServerError()
                .body(ErrorResponse.of(ErrorCode.INTERNAL_ERROR));
        // e.getMessage() 를 그대로 내보내면 SQL 문·테이블명·내부 클래스명이 새어 나간다.
        // 사용자에게는 고정 문구를, 원인은 위의 error 로그에 남긴다.
    }
}
```

검증 실패 예외가 `MethodArgumentNotValidException` 하나가 아니라는 점은 별도의 함정이고, `21-bean-validation-vs-domain-validation.md`가 예외 종류별 발생 조건을 정리한다. 여기서는 **"검증 실패 예외가 여러 종류라서 핸들러를 따로 등록해야 응답 형식이 통일된다"**는 사실만 기억하면 된다.

### 2-3. 에러 코드 체계를 어떻게 짜는가

enum의 첫 칸에 들어갈 문자열의 형식을 정하는 문제다. 실무에서 갈리는 축이 둘이다.

**축 ① 도메인 접두사를 붙일 것인가.** 붙이는 쪽이 낫고 이유가 둘이다. 장애 대시보드에서 접두사로 group by 하면 "어느 도메인의 실패가 늘었나"가 바로 나오고, 코드만 보고 어느 팀에 물어봐야 할지 안다. 마이크로서비스라면 접두사가 곧 소유 팀의 이름표다.

**축 ② 접두사 뒤를 일련번호로 할 것인가, 의미 있는 이름으로 할 것인가.** `ORDER-001` 대 `ORDER_SOLD_OUT`이다. 트레이드오프를 정리하면 이렇다.

| | `ORDER-001` (번호) | `ORDER_SOLD_OUT` (의미) |
|---|---|---|
| 로그·대시보드 가독성 | 표를 찾아봐야 뜻을 안다 | 그 자체가 문서다 |
| 프론트 분기 코드 | 오타가 나도 눈에 안 띈다 | 오타가 나면 읽는 순간 보인다 |
| 채번 관리 | "다음 번호가 몇 번이지"를 관리해야 하고 팀이 나뉘면 번호대가 겹친다 | 관리할 것이 없다 |
| 응답 크기 | 짧다 | 조금 길다 |

**어느 쪽이든 프론트가 문자열 비교로 분기한다는 사실은 같다.** 번호 쪽이 오타에 강해 보이지만 실제로는 반대다 — `"ORDER-001"`을 `"ORDER-01"`로 잘못 쓰면 눈으로 못 잡고, 조건문이 조용히 안 걸려 "알 수 없는 오류" 화면으로 떨어진다. `"ORDER_SOLD_OUT"`은 오타가 나면 읽을 때 티가 난다. 응답 크기 이득은 실무에서 문제가 되는 경우가 거의 없다.

그래서 **의미 있는 이름 쪽을 권한다.** 다만 어느 쪽을 고르든 **조직 전체에서 형식 하나로 통일**하는 것이 개별 선택보다 중요하다. 어떤 API는 하이픈, 어떤 API는 대문자 스네이크면 소비자가 다시 API마다 다른 파싱을 하게 된다.

코드를 얼마나 잘게 나눌지의 기준, 그리고 **한번 공개한 코드는 클라이언트 분기문에 박히므로 필드명과 같은 급의 불변 계약이 된다**는 논점은 `../09-rest-api/05-error-response-body-standardization.md`의 2-6절이 다룬다.

### 2-4. 각 `ErrorCode`의 HTTP status를 어떻게 고르는가

enum의 세 번째 칸이다. 코드 체계는 우리가 만드는 것이지만 status는 이미 표준이 뜻을 정해 놓은 값이고, **게이트웨이·로드밸런서·APM·클라이언트 라이브러리의 재시도 로직이 바디를 열어 보지 않고 이 숫자만 읽는다.** 그래서 아무 값이나 넣으면 안 된다.

실패를 status로 옮길 때 던지는 질문은 순서가 있다.

```text
① 우리 잘못인가, 요청 쪽 잘못인가?
     우리 잘못(버그·의존 시스템 장애) ─────────────→ 5xx
     요청 쪽 잘못 ↓
② 누구인지 모르는가, 알지만 권한이 없는가?
     인증이 없거나 만료됐다 ────────────────────→ 401
     인증은 됐지만 권한이 없다 ──────────────────→ 403
③ 그 자원이 아예 없는가?
     식별자에 해당하는 자원이 없다 ───────────────→ 404
④ 요청의 형태·값 자체가 잘못됐는가?
     필수값 누락, 타입 불일치, 형식 오류 ──────────→ 400
⑤ 값은 다 유효한데 현재 상태와 맞지 않는가?
     이미 취소된 주문을 또 취소, 재고 소진, 중복 가입 → 409
     값들 각각은 유효한데 조합이 규칙에 어긋난다 ───→ 422 (또는 팀 규칙에 따라 400)
```

각 코드의 정확한 의미와 401/403 구분, 409의 사례, 5xx 계열의 세부(502·503·504)는 `../08-network-http/05-http-status-codes-usage-criteria.md`가 다룬다. 여기서 짚어야 할 것은 **이 판단을 어디에 못 박느냐**다.

**"비즈니스 규칙 위반에 400을 줄지 409나 422를 줄지"는 실무에서 늘 논쟁이 된다.** 이 논쟁의 결론을 개인이 그때그때 내리게 두는 것이 진짜 문제다. `ErrorCode` enum이 있으면 판단이 코드 리뷰 대상이 되고, 새 코드를 추가할 때 옆줄의 기존 항목이 곧 기준선이 된다. 반대로 컨트롤러마다 `ResponseEntity.status(...)`를 직접 쓰면 같은 성격의 실패가 API마다 다른 status로 나가고, 클라이언트는 결국 status를 믿지 못해 바디만 보게 된다. **status가 장식이 되는 순간 앞서 말한 인프라 계층 전부가 눈을 잃는다.**

팀 규칙으로 정할 때 실용적인 출발점은 이렇다. **검증 실패는 전부 400으로 통일하고(422를 굳이 나누지 않는다), 상태 충돌만 409로 분리한다.** 400과 422를 나누는 실익은 클라이언트가 어차피 바디의 코드를 보고 분기하기 때문에 작은 반면, 400과 409의 차이는 클라이언트에게 주는 지시가 다르므로("입력을 고쳐라" 대 "최신 상태를 다시 조회하라") 실익이 분명하다.

여기에 반드시 붙일 규칙이 하나 더 있다. **도메인 불변식 위반은 4xx가 아니라 5xx다.** `IllegalArgumentException`처럼 "정상 흐름에서는 나올 수 없는" 예외가 API 경계까지 올라왔다면 그것은 사용자 입력 문제가 아니라 **앞 계층 검증이 뚫렸다는 버그 신호**다. 이걸 400으로 내려보내면 사용자에게 "입력을 확인하세요"라고 거짓말을 하면서 우리 버그는 알람도 없이 묻힌다.

### 2-5. 스프링 표준 예외까지 한 번에 흡수 — `ResponseEntityExceptionHandler`

우리가 정의한 예외만 잡아서는 포맷이 통일되지 않는다. 바인딩 실패, 본문 파싱 실패, 지원하지 않는 메서드, 매핑되지 않은 경로 같은 **스프링 MVC 자신이 던지는 예외**가 남기 때문이다. 그대로 두면 이들은 스프링 기본 응답으로 나가고, 프론트는 "어떤 에러는 우리 포맷, 어떤 에러는 스프링 포맷"을 만난다.

`ResponseEntityExceptionHandler`는 이 표준 예외들을 **한 메서드에 몰아 등록해 둔 추상 클래스**다. Spring Framework 6.2 기준으로 여기에 걸려 있는 예외는 `HttpRequestMethodNotSupportedException`, `HttpMediaTypeNotSupportedException`, `MissingServletRequestParameterException`, `MethodArgumentNotValidException`, `HandlerMethodValidationException`, `NoResourceFoundException`, `HttpMessageNotReadableException`, `TypeMismatchException`, `MaxUploadSizeExceededException` 등 스무 개 가까이 된다. 상속만 하면 이 전부가 우리 Advice의 관할로 들어온다.

```java
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    // 상속한 표준 예외들의 응답은 이 한 곳을 거쳐 나간다.
    // 예외 종류별로 메서드를 따로 오버라이드하지 않아도 포맷이 통일되는 이유다.
    @Override
    protected ResponseEntity<Object> handleExceptionInternal(
            Exception ex, Object body, HttpHeaders headers,
            HttpStatusCode statusCode, WebRequest request) {

        ErrorCode code = mapToErrorCode(statusCode);   // status → 우리 ErrorCode 로 환산
        log.warn("spring standard exception: {}", ex.getClass().getSimpleName());
        return ResponseEntity.status(statusCode)
                .body(ErrorResponse.of(code));         // 우리 포맷으로 갈아 끼운다
    }

    // 검증 실패만은 필드별 상세가 필요하므로 따로 오버라이드한다
    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex, HttpHeaders headers,
            HttpStatusCode status, WebRequest request) {
        List<ErrorResponse.FieldError> errors = ex.getBindingResult().getFieldErrors().stream()
                .map(f -> new ErrorResponse.FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        return ResponseEntity.badRequest()
                .body(ErrorResponse.of(ErrorCode.INVALID_INPUT, errors));
    }
}
```

주의할 점이 하나 있다. 상속하면 `MethodArgumentNotValidException`이 이미 부모의 `@ExceptionHandler`에 등록돼 있으므로, **자식 클래스에 같은 예외의 `@ExceptionHandler`를 또 선언하면 중복 등록으로 기동이 실패한다.** 상속한 뒤에는 새 메서드를 만드는 것이 아니라 `handleMethodArgumentNotValid`를 오버라이드해야 한다.

### 2-6. `ProblemDetail`과 RFC 9457 (가산점 포인트)

에러 응답 포맷에는 이미 국제 표준이 있다. **RFC 9457 "Problem Details for HTTP APIs"**이고, 2016년의 RFC 7807을 2023년에 개정해 그 자리를 물려받은 문서다. `type`(문제 유형 식별 URI), `title`(유형의 짧은 요약), `status`, `detail`(이번 한 건의 설명), `instance`(이번 한 건의 식별 URI) 다섯 멤버로 이루어지고, `application/problem+json`이라는 전용 미디어 타입을 쓴다.

**Spring Framework 6부터 `ProblemDetail` 타입이 프레임워크에 들어와 있다.** 스프링 표준 예외들은 `ErrorResponse` 인터페이스를 구현하며 이미 `ProblemDetail` 본문을 들고 다니고, 우리 예외도 `ErrorResponseException`을 던지거나 `ProblemDetail`을 직접 반환하면 표준 형식으로 나간다.

```java
@ExceptionHandler(SoldOutException.class)
public ProblemDetail handleSoldOut(SoldOutException e) {
    ProblemDetail pd = ProblemDetail.forStatusAndDetail(
            HttpStatus.CONFLICT, "상품 " + e.getProductId() + "의 재고가 소진되었습니다");
    pd.setType(URI.create("https://api.example.com/problems/sold-out"));  // 유형 식별자
    pd.setTitle("재고 소진");
    pd.setProperty("code", "ORDER_SOLD_OUT");    // 표준 다섯 멤버 위에 자체 필드를 얹을 수 있다
    return pd;
}
```

Spring Boot 3에는 이것을 자동으로 켜는 스위치도 있다. **`spring.mvc.problemdetails.enabled=true`**(기본값 `false`)를 주면 부트가 `ResponseEntityExceptionHandler`를 상속한 Advice를 하나 등록해, 스프링이 처리하는 예외들의 응답을 Problem Details 형식으로 내보낸다.

여기에 함정이 하나 있다. **자체 Advice에서 이미 같은 예외들을 처리하고 있는데 이 스위치까지 켜면, 어느 쪽이 이기는지는 1-3의 Advice 순서 규칙에 달린다.** 둘을 동시에 켜 놓고 "왜 내 포맷이 안 나오지"를 뒤지는 상황이 생기므로, 표준을 쓸지 자체 포맷을 쓸지 하나로 정하는 편이 낫다.

**자체 포맷과 표준 중 무엇을 고를지의 판단 기준은 소비자다.** 사내 프론트 팀 하나가 소비자면 자체 포맷이 편하고, 외부 파트너나 여러 회사가 붙는 공개 API면 "RFC 9457입니다" 한 줄이 포맷 설명서보다 훨씬 싸다. 이미 자체 포맷으로 운영 중인 API를 표준으로 바꾸는 것 자체가 모든 소비자의 파서를 고치게 만드는 파괴적 변경이라는 점까지가 판단 재료다. 이 선택의 전체 논의는 `../09-rest-api/05-error-response-body-standardization.md`의 3절에 있다.

## 3. 운영 설계 — 로그 정책과 Advice 바깥 구역

### 3-1. 4xx와 5xx를 다르게 다뤄야 하는 이유 — 숫자로 확인한다

"4xx는 warn, 5xx는 error"라는 규칙은 자주 인용되지만 근거를 대지 못하면 그냥 관습이다. 근거는 **알람 피로(alert fatigue)** — 알람이 너무 자주 울려 사람이 그것을 무시하게 되고, 그래서 진짜 장애의 알람도 함께 무시되는 현상이다.

숫자로 보면 명확하다. 하루 100만 요청을 받는 서비스에서 4xx 비율이 2%라고 하자. 잘못된 요청, 만료된 토큰, 존재하지 않는 리소스 조회 — 정상 운영 중에도 계속 발생하는 것들이다.

```text
  하루 4xx  = 1,000,000 × 0.02 = 20,000 건
  하루 5xx  = 20 건 (조사해야 할 진짜 장애)

  [4xx 를 error 로 찍는 경우]
    error 로그 총량 = 20,000 + 20 = 20,020 건/일
    그중 조사 대상  = 20 / 20,020 = 0.0999... ≈ 0.1%
    → "error 로그가 급증하면 알람" 규칙을 걸면 4xx 변동에 계속 울린다.
      며칠이면 아무도 안 본다.
    → 5xx 20건은 20,000건 사이에 묻혀 검색으로도 안 찾아진다.

  [4xx 를 warn 으로 찍는 경우]
    error 로그 총량 = 20 건/일
    그중 조사 대상  = 20 / 20 = 100%
    → error 로그가 뜨는 것 자체가 신호가 된다. 알람을 그대로 걸어도 된다.
```

**로그 레벨은 "이 줄이 얼마나 심각한가"를 표시하는 장식이 아니라, 알람 규칙이 실제로 읽는 입력값이다.** 4xx를 error로 찍는 것은 알람 시스템에 노이즈를 주입하는 일이다.

정책을 정리하면 이렇다.

**4xx(클라이언트 잘못)**: warn 이하로, **스택트레이스 없이** 코드·요청 식별자만 남긴다. 스택트레이스를 빼는 이유는 심각도 때문만이 아니다. 예외 하나당 수십 줄이 쌓여 로그 저장 비용과 검색 속도에 직접 영향을 준다. 원인이 요청 안에 있으므로 스택을 봐도 새로 알 것이 없기도 하다.

**5xx(서버 잘못)**: error + 스택트레이스 전체 + 알람 연동. **"500이 났는데 로그가 없다"가 최악의 상황**이므로, 안전망 핸들러에서 로그를 빠뜨리지 않는 것이 핵심이다.

**다만 4xx를 무시하라는 뜻은 아니다.** 401이 평소의 100배로 튀면 그것은 크리덴셜 스터핑 시도이고, 특정 API의 400이 급증하면 클라이언트가 잘못 배포된 것이다. **개별 발생은 warn으로 조용히 남기되, 감시는 "코드별 발생률의 급변"이라는 집계 지표로 건다.** 개별 이벤트로 울리는 알람과 비율 변화로 울리는 알람은 다른 물건이다.

### 3-2. 응답에 무엇을 담고 무엇을 담지 않는가

**담지 말 것**: 스택트레이스, 예외 메시지 원문, 내부 시스템 구조를 유추할 수 있는 정보.

특히 위험한 것이 `Exception.class` 안전망에서 `e.getMessage()`를 그대로 내보내는 습관이다. 이 문자열에는 SQL 문 전체, 테이블·컬럼명, 내부 클래스 패키지, 파일 경로, 심지어 연결 실패한 내부 호스트명이 섞여 나온다. **계약 문제이기 이전에 보안 문제다** — 예외 원문 하나로 프레임워크 버전과 스키마 구조가 공격자에게 넘어간다.

**담을 것**: 요청 추적 식별자(trace id). 사용자가 "오류가 났어요"라고 문의했을 때 그 응답에 찍힌 값으로 서버 로그를 바로 찾을 수 있어서, **에러 응답이 CS와 로그를 잇는 진입점이 된다.**

```java
// trace id 를 응답에 싣는 자리 — MDC 에서 꺼낸다
private ErrorResponse toResponse(ErrorCode code, List<ErrorResponse.FieldError> errors) {
    // MDC 는 로깅 라이브러리가 스레드마다 들고 다니는 키-값 맵이다.
    // 필터에서 심어 둔 값을 여기서 그대로 꺼내 쓰면 로그와 응답이 같은 값을 갖는다.
    return new ErrorResponse(code.getCode(), code.getMessage(), errors, MDC.get("traceId"));
}
```

trace id를 어디서 만들어 어떻게 전파하는지, 왜 그 값을 외부에 노출해도 안전한지(그리고 순차 증가하는 요청 번호를 그 자리에 넣으면 왜 안 되는지)는 `../09-rest-api/05-error-response-body-standardization.md`의 2-5절이 다룬다. 값을 **어느 계층에서 심어야 하는지**는 `06-filter-vs-interceptor.md`의 3-2절이 다루는데, 결론만 옮기면 **인터셉터가 아니라 필터 체인의 맨 앞에서 심어야** 인증 실패로 컨트롤러에 닿지 못한 요청에도 trace id가 찍힌다.

### 3-3. `@ControllerAdvice`가 못 잡는 구역 — 그래서 포맷을 어떻게 통일하는가

1-2에서 본 그대로다. **`@ControllerAdvice`는 `DispatcherServlet`이 자기 `try` 안에서 잡은 예외를 리졸버에 넘겨야 실행되는 장치이므로, `DispatcherServlet`에 도달한 적 없는 예외는 구조적으로 잡을 수 없다.** 해당하는 구역이 셋이다.

| 구역 | 왜 못 잡는가 | 그대로 두면 나가는 응답 |
|---|---|---|
| 서블릿 필터 (Spring Security 인증·인가 포함) | `DispatcherServlet`보다 앞 단계 | 톰캣이 `/error`로 재진입 → 부트 기본 JSON 또는 Whitelabel HTML |
| 매핑되지 않은 경로·정적 리소스 404 | 컨트롤러 자체가 없다 | 부트 기본 `/error` 응답 |
| `@Async` · `@Scheduled` | HTTP 요청 스레드 밖이라 응답 자체가 없다 | 응답 없음. 로그만 남거나 그마저 없다 |

**필터 계층의 예외가 왜 못 잡히는지의 인과와, 대응 수단 네 가지(예외 처리 전용 필터 / `HandlerExceptionResolver` 직접 호출 / `ErrorController` 대체 / Security의 `AuthenticationEntryPoint`·`AccessDeniedHandler`)의 비교는 `06-filter-vs-interceptor.md`의 2-3절이 정면으로 다룬다.** 여기서는 그다음 질문에 답한다 — **그래서 이 여러 구역의 응답 포맷을 실제로 어떻게 하나로 만드는가?**

답은 **"각 구역에서 JSON을 따로 쓰지 말고, 공통 생성기 하나를 만들어 세 구역이 함께 쓰게 한다"**이다. 이걸 안 하면 `ErrorResponse`의 필드를 하나 추가할 때 고쳐야 할 자리가 네 곳이 되고, 그중 하나를 빠뜨려 "인증 에러만 `traceId`가 없는" 상태가 된다.

```java
// 공통 생성기 — 응답을 직접 써야 하는 모든 자리가 이 빈 하나만 부른다
@Component
@RequiredArgsConstructor
public class ErrorResponseWriter {

    private final ObjectMapper objectMapper;

    public void write(HttpServletResponse response, ErrorCode code) throws IOException {
        response.setStatus(code.getStatus().value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        // 이 줄이 없으면 한글 메시지가 깨져 나간다. 필터 계층에서 특히 자주 빠뜨린다.
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());

        // 포맷 결정이 이 한 줄에만 존재한다.
        // ErrorResponse 에 필드가 추가돼도 고칠 곳이 여기 하나다.
        objectMapper.writeValue(response.getWriter(),
                new ErrorResponse(code.getCode(), code.getMessage(), List.of(),
                        MDC.get("traceId")));
    }
}
```

```java
// 소비자 ①: Spring Security 인증 실패 (401) — 필터 안이라 Advice 가 못 온다
@Bean
public AuthenticationEntryPoint authenticationEntryPoint(ErrorResponseWriter writer) {
    return (request, response, e) -> writer.write(response, ErrorCode.UNAUTHORIZED);
}

// 소비자 ②: Spring Security 인가 실패 (403)
@Bean
public AccessDeniedHandler accessDeniedHandler(ErrorResponseWriter writer) {
    return (request, response, e) -> writer.write(response, ErrorCode.FORBIDDEN);
}
```

```java
// 소비자 ③: 그 밖의 필터 예외를 잡는 그물. 체인 맨 앞에 둬야 뒤쪽 필터의 예외를 잡는다.
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@RequiredArgsConstructor
public class ErrorHandlingFilter extends OncePerRequestFilter {

    private final ErrorResponseWriter writer;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            chain.doFilter(req, res);
        } catch (Exception e) {
            log.error("filter chain error", e);
            // 여기서 직접 쓰지 않으면 톰캣의 에러 페이지 처리로 넘어가 포맷이 깨진다.
            writer.write(res, ErrorCode.INTERNAL_ERROR);
        }
    }
}
```

```java
// 소비자 ④: 마지막 그물. 어떤 경로로 새어 나온 에러든 결국 /error 로 모인다.
@RestController
@RequiredArgsConstructor
public class GlobalErrorController implements ErrorController {

    private final ErrorResponseWriter writer;

    @RequestMapping("/error")
    public void handle(HttpServletRequest req, HttpServletResponse res) throws IOException {
        // 매핑 없는 경로의 404 도 여기로 온다. status 속성을 보고 코드를 고른다.
        Object status = req.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        writer.write(res, ErrorCode.fromStatus(status));
    }
}
```

**`@Async`와 `@Scheduled`는 성격이 다르다.** 이쪽은 돌려줄 HTTP 응답 자체가 없으므로 "포맷 통일"의 대상이 아니고, **누락 없이 로그와 알람으로 흘려보내는 것**이 목표다. `AsyncUncaughtExceptionHandler`(반환 타입이 `void`인 `@Async` 메서드의 예외를 받는 자리)를 등록하지 않으면 예외가 조용히 사라진다는 점만 기억하면 된다.

## 4. 꼬리질문 대비 포인트

### "`@ControllerAdvice`가 못 잡는 예외는 어떤 게 있나요?"

먼저 **왜** 못 잡는지를 한 문장으로 말한다. **`@ControllerAdvice`는 `DispatcherServlet`이 자기 `try` 안에서 잡은 예외를 `HandlerExceptionResolver`에 넘겨야 실행되는 장치인데, 필터의 예외는 `DispatcherServlet`에 도달한 적이 없다.** 위치 때문이지 설정 문제가 아니라는 것이 핵심이다.

그다음 구역을 든다. **필터 계층**(Spring Security의 인증·인가 실패가 대표), **매핑되지 않은 경로**, 그리고 **HTTP 요청 스레드 밖**(`@Async`, `@Scheduled`)이다.

대응은 앞의 둘과 마지막을 나눠 말한다. 앞의 둘은 응답을 직접 써야 하므로 `AuthenticationEntryPoint`·`AccessDeniedHandler`·예외 처리 필터·`ErrorController`에서 처리하되, **핵심은 각자 JSON을 만드는 것이 아니라 공통 `ErrorResponse` 생성기를 주입받아 함께 쓰는 것**이다. 그래야 포맷 정의가 한 곳에만 남는다. 마지막은 돌려줄 응답이 없으므로 비동기 예외 핸들러에서 로깅·알람으로 다룬다.

**아무 대응도 안 하면 실제로 무엇이 나가는지**까지 말하면 확실해진다. 스프링 부트라면 톰캣이 `/error`로 재진입시켜 부트 기본 JSON이나 Whitelabel HTML이 나가고, 그 처리마저 없으면 톰캣의 HTML 에러 페이지가 나가 프론트의 JSON 파서가 터진다.

### "같은 예외의 핸들러가 여러 곳에 있으면 무엇이 실행되나요?"

세 단계로 답한다. **① 컨트롤러 클래스 안의 `@ExceptionHandler`가 최우선**이고, 있으면 전역 Advice는 조회조차 되지 않는다. **② 없으면 Advice 빈들을 `@Order` 순으로 훑어 매칭되는 메서드를 가진 첫 Advice에서 멈춘다.** **③ 그 Advice 안에서 여러 메서드가 매칭되면 예외 상속 계층에서 거리가 가장 가까운 것을 고른다.**

③ 덕분에 `Exception` 안전망을 깔아 둬도 구체 핸들러가 있으면 그쪽이 이긴다는 점, 그리고 ② 때문에 **순서가 앞선 Advice의 넓은 핸들러가 뒤쪽 Advice의 구체 핸들러를 통째로 가려 버리는 함정**이 있다는 점을 함께 말하면 실제로 겪어 본 답이 된다. 규칙은 하나다 — **넓게 잡는 Advice일수록 뒤에 둔다.**

### "왜 예외를 catch해서 200 OK에 에러 바디로 주면 안 되나요?"

**HTTP status는 바디를 파싱하지 않는 소비자들이 읽는 유일한 신호**이기 때문이다. 200으로 감싸면 세 가지가 한꺼번에 망가진다.

**① 관측이 죽는다.** 게이트웨이·로드밸런서·APM의 에러율 지표가 전부 0이 되어, 결제가 전부 실패하는 중에도 대시보드는 초록색이다. 장애를 사용자 문의로 처음 알게 된다.

**② 캐시와 재시도가 오동작한다.** 프록시·CDN이 에러 응답을 정상 응답으로 캐싱할 수 있고, 클라이언트 라이브러리의 자동 재시도가 "성공했다"고 판단해 돌지 않는다.

**③ 클라이언트가 매번 바디를 열어야 한다.** HTTP 클라이언트에 에러 인터셉터 하나를 두는 공통 처리가 불가능해진다.

정리는 이중 축으로 한다. **status로 기계가 읽는 부류를, 바디의 code로 클라이언트가 읽는 세부 구분을 담당시킨다.** 어느 한쪽만으로는 안 된다.

### "에러 코드 체계는 어떻게 설계하나요? HTTP status만으로는 왜 부족한가요?" (시니어 변별 포인트)

**status는 종류가 적어 비즈니스 구분을 담지 못한다.** 실무에서 쓰는 4xx는 400·401·403·404·409·422·429 정도인데, 결제 하나가 낼 수 있는 실패는 잔액 부족·한도 초과·카드 만료·필수값 누락처럼 훨씬 많고 **각각 클라이언트가 사용자를 보내야 할 화면이 다르다.** status만 있으면 넷이 전부 같은 400이고, 클라이언트가 구분할 방법은 `message` 문자열 비교뿐이다. 그 순간 **서버가 문구를 다듬는 커밋이 프론트 장애가 된다.**

그래서 기계 판독용 코드를 별도 축으로 둔다. 도메인 접두사를 붙이는 이유는 장애 대시보드에서 접두사로 group by 하면 어느 도메인의 실패가 늘었는지 바로 나오고, 코드만 보고 어느 팀에 물어볼지 알기 때문이다. 접두사 뒤는 일련번호보다 의미 있는 이름을 권하는데, **번호는 로그에서 뜻을 알려면 표를 찾아야 하고 채번 관리 부담이 생기며, 오타가 나도 눈에 안 띄기 때문**이다.

여기서 시니어답게 보이는 지점은 **분리 기준**이다. **"클라이언트가 다르게 행동해야 하는 경우에만 코드를 분리한다."** 코드가 200개인데 클라이언트가 8개만 분기하고 나머지를 "기타 오류"로 뭉갠다면 그 192개는 만든 사람만 아는 코드다. "상품 ID 형식 오류"와 "쿠폰 ID 형식 오류"를 나눌 이유가 없다면 `errors[]`의 `field`로 구분하면 된다.

마지막으로 **코드 목록을 문서화해 프론트와 공유하는 것까지가 설계**라고 말한다. 에러 코드는 성공 응답 스키마와 동급의 API 계약이고, 한번 공개한 코드의 의미 변경·삭제는 응답 필드 삭제와 같은 파괴적 변경이다. 특히 앱 스토어에 나간 모바일 앱은 서버 배포로 회수되지 않는다.

### "비즈니스 규칙 위반에는 400과 409·422 중 무엇을 주나요?"

**먼저 이 판단이 개인이 아니라 팀 규칙의 대상이라는 점을 말한다.** 같은 성격의 실패가 API마다 다른 status로 나가면 클라이언트는 결국 status를 믿지 못하고 바디만 보게 되고, 그러면 status는 장식이 된다. 코드 하나를 정확히 고르는 것보다 일관성이 중요하다.

그다음 실용적 기준을 든다. **400과 409의 차이는 클라이언트에게 주는 지시가 다르므로 반드시 나눈다** — 400은 "입력을 고쳐서 다시 보내라"이고, 409는 "입력은 멀쩡하니 최신 상태를 다시 조회한 뒤 판단하라"다. 이미 취소된 주문을 또 취소하거나, 재고가 소진됐거나, 낙관적 락이 충돌한 경우가 409다.

**반면 400과 422는 굳이 나누지 않는 팀이 많고 그것도 합리적이다.** 클라이언트가 어차피 바디의 코드를 보고 필드별 메시지를 띄우므로 구분의 실익이 작기 때문이다.

여기에 한 가지를 더 붙이면 답이 완성된다. **도메인 불변식 위반은 4xx가 아니라 5xx로 분리한다.** "정상 흐름에서는 나올 수 없는" 예외가 API 경계까지 올라온 것은 사용자 입력 문제가 아니라 앞 계층 검증이 뚫렸다는 버그 신호이므로, 400으로 내려보내면 사용자에게 거짓말을 하면서 우리 버그를 알람 없이 묻는 셈이 된다.

### "4xx를 error 로그로 남기면 안 되는 이유가 뭔가요?"

**알람 피로** 때문이라고 답하고 숫자로 뒷받침한다. 하루 100만 요청에 4xx가 2%면 2만 건인데, 이걸 error로 찍으면 하루 error 로그 2만 20건 중 실제 조사 대상인 5xx 20건은 **0.1%**가 된다. "error 급증 시 알람" 규칙은 4xx 변동에 계속 울려 며칠이면 아무도 안 보게 되고, 5xx 20건은 검색으로도 안 찾아진다.

**로그 레벨은 심각도 표시가 아니라 알람 규칙이 읽는 입력값**이라는 것이 핵심이다. 여기에 스택트레이스를 4xx에서 빼는 이유(예외당 수십 줄이 쌓여 저장 비용과 검색 속도에 직접 영향, 원인이 요청 안에 있어 스택을 봐도 새로 알 것이 없음)를 덧붙이면 좋다.

마무리는 균형이다. **4xx를 무시하라는 뜻은 아니다.** 401이 평소의 100배로 튀면 크리덴셜 스터핑이고, 특정 API의 400 급증은 클라이언트 오배포 신호다. **개별 발생은 warn으로 조용히 남기되 감시는 코드별 발생률의 급변이라는 집계 지표로 건다** — 개별 이벤트 알람과 비율 변화 알람은 다른 물건이라는 구분을 말하면 운영 감각이 드러난다.

### "검증 실패처럼 에러가 여러 개인 경우는 응답을 어떻게 설계하나요?"

단일 `message`로 첫 오류만 알려주면 **"고치고 제출 → 다음 오류 → 또 고치고 제출"**이라는 최악의 UX가 된다. 사용자는 자기가 세 군데를 틀렸다는 사실을 세 번 나눠 알게 된다.

그래서 공통 포맷에 필드별 상세 배열(`errors: [{field, reason}]`)을 두고, `MethodArgumentNotValidException`의 `BindingResult`에서 전체 필드 오류를 변환해 담는다.

**포인트는 이 배열이 검증 실패가 아닌 에러에서도 사라지지 않고 빈 배열로 나간다는 것**이다. 에러 종류마다 응답 모양이 달라지면 소비자가 파서를 다시 분기해야 하고, 그건 표준화가 아니라 "포맷이 여러 개인 상태"에 이름만 붙인 것이다.

한 걸음 더 들어가면 **`field`에 무엇을 넣을지도 계약**이다. 중첩 객체와 배열이 섞이면 경로 표기가 필요한데, 서버는 `items.0.quantity`로 보내고 클라이언트는 `items[0].quantity`로 찾는 어긋남이 실제로 생긴다. 폼의 어느 칸에 빨간 줄을 그을지가 이 문자열 하나에 달려 있다.

---

## 한 줄 요약

전역 예외 처리의 본질은 `@ControllerAdvice`라는 애너테이션이 아니라 "모든 실패가 하나의 계약된 모양으로 나간다"는 시스템 간 약속이다 — `ExceptionHandlerExceptionResolver`가 예외 타입이 가장 가까운 핸들러를 골라 준다는 동작을 알고(그래서 넓게 잡는 Advice는 뒤에 둔다), `ErrorCode` enum을 코드·메시지·status의 단일 진실 공급원으로 삼아 "비즈니스 규칙 위반에 400인가 409인가" 같은 판단을 개인이 아니라 코드 리뷰의 대상으로 만들며, 4xx는 warn·5xx는 error+알람이라는 로그 정책을 알람 피로라는 근거 위에 세우고, 스프링 표준 예외는 `ResponseEntityExceptionHandler` 상속으로 흡수하고, 마지막으로 Advice가 구조적으로 닿지 못하는 필터·`/error`·비동기 구역까지 공통 `ErrorResponse` 생성기 하나를 함께 쓰게 만들어야 프론트엔드 협업 비용과 장애 시 에러 집계라는 실익이 완성된다.
