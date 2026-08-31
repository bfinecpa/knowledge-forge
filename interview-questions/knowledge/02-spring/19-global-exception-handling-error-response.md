# 전역 예외 처리와 에러 응답 표준화 — 에러 응답도 API 계약이다

> 핵심 관전 포인트: **@RestControllerAdvice + @ExceptionHandler로
> "예외 → HTTP 응답" 변환을 한 곳에 모은다. 핵심은 애너테이션이
> 아니라 계약 설계다: ErrorCode(코드·메시지·HTTP status)를 enum으로
> 단일화하고, 모든 에러가 같은 포맷(ErrorResponse)으로 나가게 해서
> 프론트엔드가 에러 코드 하나로 분기하고, 운영이 코드별 에러율을
> 집계할 수 있게 만든다. 5xx는 error 로그 + 알람, 4xx는 warn 이하로
> 구분하고, 내부 정보(스택트레이스·SQL)는 절대 응답에 노출하지 않는다.
> 마지막으로 @ControllerAdvice가 못 잡는 구역 — 필터(Security) 예외,
> @Async — 까지 같은 포맷으로 맞추는 것이 마무리다.**

---

## 0. 질문 + 의도

**질문**: "예외를 전역으로 처리하는 방법(`@ControllerAdvice`)과
에러 응답 표준화를 어떻게 설계하나요?"

**출제 의도**: 에러 응답의 일관성은 프론트엔드·모바일 팀과의 협업
비용, 그리고 장애 시 에러율 집계 가능성을 결정한다. "혼자 잘 짜는"
것 너머 "시스템의 계약을 설계"해본 사람인지 본다. 애너테이션 사용법을
아는지가 아니라, 에러 응답을 시스템 간 인터페이스로 다루는지를 보는
질문.

## 1. @ControllerAdvice의 동작 원리 — 예외 처리를 한 곳에 모으는 장치

전역 처리가 없으면 어떻게 되는지부터. 컨트롤러/서비스마다
try-catch가 흩어지고, 응답 포맷이 사람마다 달라진다:

```java
// ❌ before: 컨트롤러마다 제각각 — 포맷도, 상태코드도, 로그도 다르다
@PostMapping("/orders")
public ResponseEntity<?> order(@RequestBody OrderRequest request) {
    try {
        return ResponseEntity.ok(orderService.order(request));
    } catch (SoldOutException e) {
        // A 개발자: Map으로 대충
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    } catch (Exception e) {
        // B 개발자: 문자열로, 게다가 500인데 로그도 안 남김
        return ResponseEntity.status(500).body("서버 오류");
    }
}
```

프론트엔드는 API마다 에러 파싱 코드를 따로 짜야 하고, 운영은 "어떤
에러가 얼마나 나는지"를 집계할 방법이 없다.

`@ControllerAdvice`는 이 처리를 모든 컨트롤러에 걸치는 한 클래스로
모은다. 동작 원리: 컨트롤러(및 그 이후 계층)에서 예외가 던져져
DispatcherServlet까지 올라오면, DispatcherServlet은 등록된
**HandlerExceptionResolver**들에게 처리를 위임한다. 그중
`ExceptionHandlerExceptionResolver`가 @ControllerAdvice 빈들에서
예외 타입과 매칭되는 `@ExceptionHandler` 메서드를 찾아 실행하고,
그 리턴값으로 응답을 만든다. 즉 **컨트롤러의 정상 리턴과 같은
방식으로 "예외를 응답으로 변환하는 핸들러"가 하나 더 실행되는 것**이다.

- `@RestControllerAdvice` = `@ControllerAdvice` + `@ResponseBody`.
  REST API라면 이걸 쓴다 (리턴 객체가 JSON으로 직렬화).
- 핸들러 매칭은 **가장 구체적인 예외 타입 우선**. `SoldOutException`
  핸들러와 `Exception` 핸들러가 둘 다 있으면 전자가 잡는다.
- 컨트롤러 클래스 안에 선언한 `@ExceptionHandler`는 그 컨트롤러
  전용이며, 전역 Advice보다 **우선**한다.

## 2. 에러 응답 표준화 설계 — ErrorCode를 단일 진실 공급원으로

표준화의 뼈대는 세 조각이다: **에러 코드 enum → 비즈니스 예외 →
공통 응답 포맷**. 핵심은 "코드·메시지·HTTP status의 조합"이 코드베이스
전체에서 딱 한 곳(enum)에만 존재하게 만드는 것.

```java
// ① 에러 코드 enum — 코드/메시지/status의 단일 진실 공급원
public enum ErrorCode {
    // 도메인 접두어로 코드 체계화 — 프론트가 이 문자열로 분기한다
    ORDER_SOLD_OUT("ORDER-001", "재고가 소진된 상품입니다", HttpStatus.CONFLICT),
    ORDER_NOT_FOUND("ORDER-002", "주문을 찾을 수 없습니다", HttpStatus.NOT_FOUND),
    INVALID_INPUT("COMMON-001", "입력값이 올바르지 않습니다", HttpStatus.BAD_REQUEST),
    INTERNAL_ERROR("COMMON-999", "일시적인 오류가 발생했습니다", HttpStatus.INTERNAL_SERVER_ERROR);

    private final String code;
    private final String message;
    private final HttpStatus status;
    // 생성자/게터 생략
}

// ② 비즈니스 예외 — ErrorCode를 품는 단일 베이스
public class BusinessException extends RuntimeException {
    private final ErrorCode errorCode;
    public BusinessException(ErrorCode errorCode) {
        super(errorCode.getMessage());
        this.errorCode = errorCode;
    }
}

// ③ 공통 에러 응답 포맷 — 모든 에러가 이 모양으로만 나간다
public record ErrorResponse(
        String code,              // "ORDER-001" — 프론트 분기·에러율 집계 키
        String message,           // 사용자에게 보여도 되는 문구만
        List<FieldError> errors   // 검증 실패 시 필드별 상세 (없으면 빈 리스트)
) {
    public record FieldError(String field, String reason) {}
}
```

```java
// ✅ after: 전역 핸들러 — 컨트롤러에서 try-catch가 사라진다
@RestControllerAdvice
public class GlobalExceptionHandler {

    // 비즈니스 예외: ErrorCode가 응답의 전부를 결정한다
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ErrorResponse> handleBusiness(BusinessException e) {
        ErrorCode code = e.getErrorCode();
        log.warn("business error: {}", code.getCode());   // 4xx는 warn
        return ResponseEntity.status(code.getStatus())
                .body(ErrorResponse.of(code));
    }

    // @Valid 검증 실패: 필드별 상세를 같은 포맷에 담는다
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException e) {
        List<ErrorResponse.FieldError> errors = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new ErrorResponse.FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        return ResponseEntity.badRequest()
                .body(ErrorResponse.of(ErrorCode.INVALID_INPUT, errors));
    }

    // 최후의 안전망: 예상 못 한 예외 — 절대 내부 정보를 흘리지 않는다
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception e) {
        log.error("unexpected error", e);                  // 5xx는 error + 스택 전체
        return ResponseEntity.internalServerError()
                .body(ErrorResponse.of(ErrorCode.INTERNAL_ERROR));
                // e.getMessage()를 그대로 내보내면 SQL·클래스명이 노출될 수 있다
    }
}
```

이 구조의 효과:

- **프론트엔드 계약**: 어떤 API가 실패해도 응답 모양이 같으므로
  에러 처리 코드를 한 번만 짠다. `code` 문자열로 "재고 소진이면 재입고
  알림 버튼, 인증 만료면 로그인 이동" 같은 분기가 가능해진다 —
  HTTP status만으로는 이 구분이 안 된다(둘 다 4xx).
- **운영 집계**: 로그·APM에서 `code`별 에러율을 셀 수 있다. 장애
  상황에서 "COMMON-999가 5분 새 급증"처럼 이상 감지의 기준선이 된다.
- **중복 제거**: 새 에러가 필요하면 enum에 한 줄 추가 + 던지기만
  하면 된다. status·메시지·포맷을 어디에 어떻게 쓸지 고민할 일이
  없다.

## 3. 실무 설계 포인트 — 애너테이션 밖에서 갈리는 것들

### 3-1. 로그 전략: 4xx와 5xx를 다르게 다룬다

- **4xx(클라이언트 잘못)**: 정상 운영 중에도 계속 발생한다. error로
  찍으면 알람이 노이즈가 되어 진짜 장애를 묻어버린다 → warn 이하,
  스택트레이스 없이 코드·요청 식별자만.
- **5xx(서버 잘못)**: 전부 조사 대상이다 → error + 스택트레이스
  전체 + 알람 연동. "500인데 로그가 없다"가 최악의 상황이다.

### 3-2. 응답에 넣지 말아야 할 것 / 넣어야 할 것

- 금지: 스택트레이스, 예외 메시지 원문(SQL, 파일 경로, 클래스명이
  섞여 나온다), 내부 시스템 구조를 유추할 수 있는 정보. 특히
  `Exception.class` 안전망에서 `e.getMessage()`를 그대로 내보내는
  실수가 흔하다.
- 권장: 요청 추적 식별자(trace id). 사용자가 "오류가 났어요"라고
  문의했을 때 그 응답에 찍힌 trace id로 서버 로그를 바로 찾을 수
  있다 — 에러 응답이 장애 추적의 진입점이 된다. (가산점 포인트)

### 3-3. 표준 포맷이 필요하면 RFC의 ProblemDetail (가산점 포인트)

에러 응답 표준화에는 이미 국제 표준이 있다 — RFC 7807 "Problem
Details for HTTP APIs" (`type`, `title`, `status`, `detail`,
`instance` 필드). Spring Framework 6부터 `ProblemDetail` 타입과
`ResponseEntityExceptionHandler`의 기본 지원이 들어와, 사내 자체
포맷 대신 표준을 채택하는 선택지가 생겼다. 외부 공개 API나 여러
회사가 붙는 API라면 표준 채택이 계약 비용을 더 줄인다 — "자체 포맷
vs 표준 포맷"을 트레이드오프로 언급하면 좋다.

### 3-4. 스프링 기본 예외까지 포맷 통일

`@Valid` 실패(MethodArgumentNotValidException), 본문 파싱 실패
(HttpMessageNotReadableException), 지원하지 않는 메서드
(HttpRequestMethodNotSupportedException) 같은 스프링 MVC 기본 예외도
그냥 두면 스프링 기본 에러 응답으로 나가 포맷이 깨진다.
`ResponseEntityExceptionHandler`를 상속해 이들의 처리 메서드를
오버라이드하면 한 세트로 표준 포맷에 편입시킬 수 있다.

## 4. @ControllerAdvice가 못 잡는 구역 — 여기서 포맷이 깨진다

@ControllerAdvice는 **DispatcherServlet 안쪽**의 장치다. 그 바깥에서
터진 예외는 여기 도달하지 않는다 — 표준화를 끝까지 밀어붙이려면
이 구역들을 따로 막아야 한다.

- **서블릿 필터에서 터진 예외**: 필터는 DispatcherServlet보다 앞
  단계라 Advice가 못 잡는다. 예외는 서블릿 컨테이너의 에러 처리로
  넘어가 `/error`(BasicErrorController)의 기본 포맷으로 나간다.
  대표 사례가 **Spring Security**: 인증 실패는
  `AuthenticationEntryPoint`, 인가 실패는 `AccessDeniedHandler`를
  구현해 **같은 ErrorResponse 포맷으로 직접 직렬화**해야 프론트가
  받는 에러 모양이 통일된다. 여기를 놓치면 "401/403만 포맷이 다른"
  API가 된다 — 실무에서 표준화가 깨지는 1순위 지점.
- **@Async 메서드의 예외**: 별도 스레드에서 실행되므로 HTTP 요청
  흐름 자체가 없다. AsyncUncaughtExceptionHandler 등 비동기 쪽
  예외 처리 체계로 다뤄야 한다. @Scheduled도 마찬가지.

## 5. 꼬리질문 대비 포인트

### "@ControllerAdvice가 못 잡는 예외는 어떤 게 있나?"

필터에서 터진 예외(DispatcherServlet 앞 단계 — Security의 인증/인가
실패가 대표)와, HTTP 요청 스레드 밖에서 실행되는 코드(@Async,
@Scheduled)의 예외. 전자는 AuthenticationEntryPoint /
AccessDeniedHandler에서 같은 포맷으로 응답을 직접 써주고, 후자는
비동기 예외 핸들러에서 로깅·알람으로 다룬다. 이 질문은 "표준화를
끝까지 해봤는가"를 확인하는 것 — Advice 하나로 다 되는 줄 알았다면
Security 붙은 실서비스에서 포맷 깨짐을 안 겪어본 것이다.

### "같은 예외의 핸들러가 컨트롤러 안과 전역 Advice에 둘 다 있으면?"

컨트롤러 로컬 `@ExceptionHandler`가 우선한다. 그리고 예외 타입
매칭은 상속 계층에서 가장 구체적인 핸들러가 이긴다 —
`BusinessException` 핸들러와 `Exception` 핸들러가 있으면 전자가
잡는다. 이 규칙 덕분에 "특정 컨트롤러만 다른 에러 응답이 필요한"
예외 케이스를 전역 규칙을 깨지 않고 처리할 수 있다.

### "왜 예외를 catch해서 200 OK에 에러 바디로 주면 안 되나?"

HTTP status는 클라이언트·인프라·모니터링이 공유하는 1차 신호이기
때문이다. 200으로 감싸면 ① 게이트웨이/로드밸런서/APM의 에러율
지표가 전부 0이 되어 장애가 관측되지 않고, ② HTTP 캐시가 에러
응답을 정상 응답으로 캐싱할 수 있으며, ③ 클라이언트 공통 에러
처리(인터셉터)가 동작하지 않아 매 호출마다 바디를 열어봐야 한다.
status로 기계가 읽는 분류를, 바디의 code로 사람/프론트가 읽는 세부
구분을 담당시키는 이중 구조가 맞다.

### "에러 코드 체계는 어떻게 설계하나? HTTP status만으로는 왜 부족한가?" (시니어 변별 포인트)

HTTP status는 종류가 적어 비즈니스 구분을 담지 못한다 — "재고 소진"과
"쿠폰 만료"가 둘 다 409/400이면 프론트는 message 문자열 비교라는
최악의 분기를 하게 되고, 메시지 문구 수정이 프론트 장애가 된다.
그래서 `도메인-일련번호`(예: ORDER-001) 같은 기계 판독용 코드를
별도 축으로 두고, 이 코드 목록을 **문서화해서 프론트와 공유하는
것까지가 설계**다 — 에러 코드는 성공 응답 스키마와 동급의 API
계약이다. 운영 관점에서도 코드가 있어야 에러율을 의미 단위로 집계해
"어떤 실패가 늘고 있나"를 알 수 있다. 반대로 코드를 너무 잘게 쪼개면
프론트가 처리 불가능한 코드가 쏟아지므로, "클라이언트가 다르게
행동해야 하는 경우에만 코드를 분리한다"는 기준을 말하면 시니어답다.

### "검증 실패(@Valid)처럼 에러가 여러 개인 경우는 응답을 어떻게 설계하나?"

단일 message로는 "첫 번째 오류만" 알려주게 되어 사용자가 고치고
제출하면 또 다음 오류가 나는 최악의 UX가 된다. 공통 포맷에 필드별
상세 배열(`errors: [{field, reason}]`)을 두고,
MethodArgumentNotValidException의 BindingResult에서 전체 필드
오류를 변환해 담는다. 포인트는 이 배열이 검증 실패가 아닌 에러에서는
빈 배열로 나가면서 **포맷 자체는 하나로 유지**된다는 것 — 에러
종류마다 응답 모양이 달라지면 표준화가 아니다.

---

## 한 줄 요약

전역 예외 처리의 본질은 @ControllerAdvice라는 애너테이션이 아니라
"모든 실패가 하나의 계약된 모양으로 나간다"는 시스템 간 약속이다 —
ErrorCode enum을 단일 진실 공급원으로 예외→응답 변환을 한 곳에
모으고, 4xx/5xx 로그 전략과 내부 정보 비노출을 지키고, Advice가 못
잡는 필터(Security)·비동기 구역까지 같은 포맷으로 막아야 프론트엔드
협업 비용과 장애 시 에러 집계라는 실익이 완성된다.
