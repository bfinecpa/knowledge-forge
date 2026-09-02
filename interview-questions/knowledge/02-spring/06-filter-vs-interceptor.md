# Filter vs Interceptor — 소속이 다르면 아는 것과 할 수 있는 것이 다르다

> 핵심 관전 포인트: **Filter는 서블릿 컨테이너(톰캣) 소속으로 DispatcherServlet 바깥에서 돌고, Interceptor는 Spring MVC 소속으로 HandlerMapping이 핸들러를 찾은 뒤에 돈다. 이 소속 차이 하나에서 실질적인 차이 셋이 파생된다. Filter는 요청/응답 객체 자체를 다른 것으로 갈아끼워 체인에 넘길 수 있지만 어떤 컨트롤러가 처리할지는 모르고, Interceptor는 `HandlerMethod`를 손에 쥐고 있어 핸들러별로 선별 처리할 수 있으며, Filter에서 터진 예외는 DispatcherServlet에 도달한 적이 없으므로 `@ControllerAdvice`가 구조적으로 잡을 수 없다. 그래서 배치 기준은 "모든 요청을, 스프링 밖에서 덮어야 하는 일은 Filter(인코딩·CORS·인증·본문 캐싱·trace id), 어떤 핸들러가 처리하는지 알아야 하는 일은 Interceptor(애너테이션 기반 인가·핸들러별 감사 로깅)"가 된다. 잘못 놓으면 인증 실패 응답에만 trace id가 빠지는 관측 사각지대가 생긴다.**

---

## 0. 질문 + 의도

**질문**: "Filter와 Interceptor의 차이, 각각 어떤 용도에 적합한가요?"

**출제 의도**: 인증, 로깅, 트레이싱을 어느 계층에 넣을지의 실무 결정을 할 수 있는지 본다. 잘못 놓으면 "인증 실패 응답에는 trace id가 안 찍히는" 류의 관측 사각지대가 생긴다 — 차이를 암기했는지가 아니라, 차이로부터 배치 결정을 도출할 수 있는지가 관전 포인트다.

요청이 지나가는 전체 파이프라인의 단계별 흐름은 `05-spring-mvc-request-flow.md`에서 다룬다. 이 문서는 그중 Filter와 Interceptor 두 계층의 비교와, 공통 관심사를 어느 쪽에 둘 것인가의 결정에 집중한다.

## 1. 위치와 소속 — 모든 차이의 뿌리

### 1-1. 전제 지식 — 서블릿 컨테이너와 서블릿 스펙

두 부품의 차이를 말하려면 "서블릿 컨테이너"와 "서블릿 스펙"이 무엇인지부터 정해 두어야 한다. 이 두 단어를 정의 없이 쓰면 나머지 설명이 전부 공중에 뜬다.

**서블릿 컨테이너는 HTTP를 자바 객체로 바꿔 우리 코드에 넘겨주는 서버다.** 톰캣이 대표적이다. 톰캣이 실제로 하는 일을 순서대로 보면 이렇다. TCP 소켓을 열고 접속을 기다린다. 도착한 바이트 스트림을 HTTP 규격에 맞춰 파싱해 `HttpServletRequest` 객체를 만든다. 스레드 풀에서 스레드를 하나 꺼내 그 위에서 우리 코드를 호출한다. 우리가 `HttpServletResponse`에 써 놓은 내용을 다시 HTTP 텍스트로 조립해 소켓으로 내보낸다. **"컨테이너"라는 이름은 이 서버가 우리가 만든 부품(서블릿)을 담아 두고 그 생명주기를 대신 관리해 주는 그릇이기 때문에 붙었다.**

**서블릿 스펙은 그 그릇과 부품 사이의 계약서다.** 정식 명칭은 Jakarta Servlet Specification이고, 부품이 구현해야 할 인터페이스(`Servlet`, `Filter`, `HttpServletRequest` 등)와 컨테이너가 그것들을 언제 어떤 순서로 호출하는지가 문서로 못 박혀 있다. 계약이 표준이라서 톰캣을 제티나 언더토우로 바꿔도 같은 코드가 그대로 돈다.

**그리고 스프링 MVC는 이 스펙 위에 얹힌 애플리케이션이다.** 이 문장이 이 문서 전체의 열쇠다. 컨테이너 입장에서 보면 스프링 MVC 전체가 `DispatcherServlet`이라는 **서블릿 한 개**일 뿐이다. 컨테이너는 스프링이라는 것이 존재하는지도 모르고, 그저 계약대로 서블릿 하나를 호출할 뿐이다.

### 1-2. 계층 관계

```
톰캣 (서블릿 컨테이너)   ── 소켓을 열고 HTTP를 파싱하고 스레드를 배정한다
│
├─ Filter 체인           ── 서블릿 스펙의 표준 부품. 스프링이 없어도 존재하는 개념이다
│   │                       jakarta.servlet.Filter 를 구현한다
│   │
│   └─ DispatcherServlet ── 컨테이너가 보기엔 그냥 "서블릿 한 개"다
│        │                  그 안쪽 세계 전부가 컨테이너에겐 블랙박스다
│        │
│        ├─ HandlerMapping · HandlerAdapter
│        ├─ Interceptor    ── Spring MVC 의 부품. 서블릿 스펙에는 없는 개념이다
│        │                    org.springframework.web.servlet.HandlerInterceptor
│        ├─ 컨트롤러
│        └─ HandlerExceptionResolver → @ControllerAdvice
│
└─ (정적 리소스 서블릿 등 다른 서블릿도 여기 나란히 놓일 수 있다)
```

이 그림에서 두 가지를 읽어야 한다.

첫째, **Filter는 DispatcherServlet의 바깥에 있다.** 필터는 스프링이 아니라 컨테이너가 호출하고, 스프링을 전혀 쓰지 않는 웹 애플리케이션에도 똑같이 존재한다.

둘째, **Interceptor는 DispatcherServlet의 안쪽에 있다.** 컨테이너는 인터셉터라는 개념 자체를 모른다. 인터셉터는 DispatcherServlet이 자기 처리 과정 중간에 불러 주는, 순수한 스프링의 확장점이다.

### 1-3. 두 부품의 정의와 호출 시점

**Filter**는 서블릿 스펙이 정의한 부품으로, 서블릿에 도달하기 전과 응답이 나간 뒤에 끼어들 수 있다. 여러 개가 사슬처럼 연결돼 있어 **체인**이라 부르고, 각 필터는 `chain.doFilter(req, res)`를 호출해 다음 차례로 넘긴다. **이 호출을 하지 않으면 요청은 거기서 끝난다** — 뒤의 필터도 DispatcherServlet도 실행되지 않는다. 이렇게 흐름을 중간에 끊는 것을 단락(short-circuit)이라 한다.

**Interceptor**는 Spring MVC가 정의한 부품이다. HandlerMapping이 "이 요청은 누가 처리할지"를 찾아낸 **뒤**에 실행되므로, 처음부터 핸들러 정보를 손에 쥐고 시작한다. `preHandle`이 `false`를 반환하면 컨트롤러로 가지 않는다.

```
요청 ─▶ Filter.doFilter 앞부분
         ─▶ DispatcherServlet
              ─▶ HandlerMapping (핸들러 + 인터셉터 목록 확정)
                   ─▶ Interceptor.preHandle
                        ─▶ 바인딩 ─▶ 컨트롤러
                   ◀─ Interceptor.postHandle       (예외가 나면 건너뛴다)
                   ◀─ Interceptor.afterCompletion  (예외가 나도 항상 실행)
      ◀─ Filter.doFilter 뒷부분 (chain.doFilter 이후 코드)
응답 ◀─
```

비유하자면 Filter는 **건물 정문의 보안 게이트**다. 방문자가 어느 부서에 가는지 몰라도 출입증 검사와 소지품 검사는 할 수 있다. Interceptor는 **부서 입구의 안내 데스크**다. 방문자가 만날 담당자가 누구인지 이미 알고 있어서, 그 담당자에 맞는 절차를 밟게 할 수 있다.

나머지 차이는 전부 이 소속과 위치에서 파생된다.

## 2. 소속이 만드는 세 가지 실질적 차이

### 2-1. ① 요청/응답 객체를 교체할 수 있는가 — Filter만 가능

Filter는 `chain.doFilter(req, res)`를 부를 때 **자기가 받은 객체가 아니라 다른 객체를 넘길 수 있다.** 반면 Interceptor는 `preHandle`의 인자로 요청 객체를 받아 볼 뿐이고, 뒤 단계에 전달될 객체를 바꿔치기할 수단이 없다.

이 차이가 실무에서 가장 아프게 드러나는 곳이 **요청 본문 로깅**이다.

전제부터 짚자. **HTTP 요청 본문은 한 번만 읽을 수 있다.** `HttpServletRequest.getInputStream()`은 소켓에서 흘러들어오는 스트림이고, 스트림은 한 번 소비하면 되감을 수 없다. 그래서 로깅 코드가 본문을 먼저 읽어버리면, 뒤에서 `@RequestBody`를 바인딩하려던 `HttpMessageConverter`는 이미 비어버린 스트림을 만난다.

```java
// before: Interceptor에서 본문을 로깅하려 했다
public class BodyLoggingInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler)
            throws IOException {
        String body = StreamUtils.copyToString(req.getInputStream(), UTF_8);
        log.info("req body: {}", body);
        // 문제 1: 스트림을 여기서 소비해 버렸다. 뒤이어 ④-b 바인딩 단계에서
        //         Jackson이 읽으려 하면 본문이 비어 있어
        //         HttpMessageNotReadableException("Required request body is missing")이 난다.
        // 문제 2: "읽은 내용을 되돌려 놓은 새 request"를 만들어 넘기고 싶어도,
        //         Interceptor에는 뒤 단계로 전달될 객체를 교체할 방법이 없다.
        return true;
    }
}
```

해법은 **읽은 바이트를 따로 보관해 두는 래퍼로 갈아끼운 뒤 체인에 넘기는 것**이고, 그 래퍼가 스프링이 제공하는 `ContentCachingRequestWrapper`다. 이름 그대로 "내용을 캐싱하는 요청 래퍼"이며, 아래 단계가 스트림을 읽을 때마다 그 바이트를 내부 버퍼에도 복사해 둔다.

```java
// after: Filter에서 캐싱 래퍼로 교체해 체인에 넘긴다
@Component
public class BodyLoggingFilter extends OncePerRequestFilter {
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        var wrappedReq = new ContentCachingRequestWrapper(req);
        var wrappedRes = new ContentCachingResponseWrapper(res);

        // 원본이 아니라 래퍼를 넘긴다 — 이 교체가 Filter에서만 가능한 일이다.
        chain.doFilter(wrappedReq, wrappedRes);

        // 로깅은 반드시 doFilter '뒤'에 온다. 래퍼는 본문을 미리 읽어 두는 물건이 아니라
        // 아래 단계가 읽어 갈 때 곁에서 받아 적는 물건이라, 아래가 읽기 전에는 버퍼가 비어 있다.
        log.info("req body: {}", new String(wrappedReq.getContentAsByteArray(), UTF_8));
        log.info("res body: {}", new String(wrappedRes.getContentAsByteArray(), UTF_8));

        // 응답 래퍼는 본문을 자기 버퍼에 붙들고 있으므로, 이 줄이 없으면
        // 클라이언트에게 빈 본문이 나간다. 빠뜨리기 쉬운 함정이다.
        wrappedRes.copyBodyToResponse();
    }
}
```

주석에 적은 두 함정이 실제로 자주 터진다. **아래 단계가 본문을 읽지 않으면 캐시도 비어 있다** — 예를 들어 인증 실패로 요청이 컨트롤러에 닿지 못하면 `getContentAsByteArray()`는 빈 배열을 돌려준다. 본문을 무조건 남겨야 한다면 필터에서 직접 전부 읽어 보관하는 커스텀 래퍼가 필요하다.

정리하면 **인코딩 설정, 응답 압축, 본문 캐싱처럼 요청/응답 스트림 자체를 다루는 일은 구조적으로 Filter의 영역**이다. "Filter는 요청/응답 객체를 교체할 수 있다"는 추상적인 서술의 실체가 이것이다.

### 2-2. ② 핸들러 문맥을 아는가 — Interceptor만 가능

Interceptor의 `preHandle`은 세 번째 인자로 핸들러 객체를 받는다. `HandlerMethod`로 캐스팅하면 **어떤 컨트롤러의 어떤 메서드가, 어떤 애너테이션을 달고** 이 요청을 처리할 예정인지 알 수 있다.

```java
public class AdminAuthInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        // 정적 리소스 요청 등은 HandlerMethod가 아니다. 캐스팅 전에 반드시 걸러야 한다.
        if (!(handler instanceof HandlerMethod method)) return true;

        // 핸들러 메서드에 붙은 커스텀 애너테이션을 보고 분기한다.
        // Filter 단계에서는 어떤 메서드가 처리할지 아직 정해지지도 않아 불가능한 판단이다.
        if (method.hasMethodAnnotation(AdminOnly.class) && !isAdmin(req)) {
            res.setStatus(HttpServletResponse.SC_FORBIDDEN);
            return false;   // false를 반환하면 컨트롤러는 실행되지 않는다
        }
        return true;
    }
}
```

"이 애너테이션이 붙은 핸들러에만", "이 URL 그룹에만" 같은 **선별적 공통 처리**는 Interceptor가 자연스럽다. 등록할 때 `addPathPatterns`와 `excludePathPatterns`로 경로 기반 선별도 가능한데, 서블릿의 URL 패턴 문법보다 표현력이 좋다(`/api/**` 같은 다중 와일드카드, 경로 변수 패턴 등).

Filter에서 같은 일을 하려면 URL 문자열을 직접 비교해야 하고, 컨트롤러가 리팩터링되어 경로가 바뀌면 조용히 어긋난다. 애너테이션은 메서드를 따라다니므로 그런 어긋남이 없다.

### 2-3. ③ 예외가 어디까지 올라가는가 — 에러 응답 일관성의 분기점

셋 중 가장 실무적인 차이다. 그리고 "Filter의 예외는 `@ControllerAdvice`가 못 잡는다"는 문장을 외우는 것과, 왜 못 잡는지를 아는 것은 전혀 다르다.

#### 2-3-1. 왜 못 잡는가 — 인과

`@ControllerAdvice` + `@ExceptionHandler`는 스스로 동작하는 장치가 아니다. **`DispatcherServlet`이 자기 처리 과정에서 예외를 잡은 뒤 `HandlerExceptionResolver`에게 넘겨야 비로소 실행된다.** 그중 `ExceptionHandlerExceptionResolver`가 `@ControllerAdvice`에 등록된 핸들러를 찾아 호출하는 구현이다.

`DispatcherServlet`의 처리 코드는 대략 이런 모양이다.

```java
// DispatcherServlet.doDispatch() 의 뼈대
try {
    mappedHandler = getHandler(request);              // ③ HandlerMapping
    if (!mappedHandler.applyPreHandle(req, res)) return;  // ④-a Interceptor.preHandle
    mv = ha.handle(req, res, mappedHandler.getHandler()); // ④-b 바인딩 + ④-c 컨트롤러
    mappedHandler.applyPostHandle(req, res, mv);      // ④-e postHandle
}
catch (Exception ex) {
    dispatchException = ex;     // 이 try 안에서 난 예외만 여기로 들어온다
}
// 잡은 예외를 HandlerExceptionResolver 들에게 넘긴다 → @ControllerAdvice 실행
processDispatchResult(req, res, mappedHandler, mv, dispatchException);
```

여기서 결론이 그대로 따라 나온다. **이 `try` 블록 안에서 난 예외만 `@ControllerAdvice`에 도달한다.** 그런데 Filter는 이 코드가 실행되기도 전, `doDispatch`를 부른 적조차 없는 바깥에서 돈다. **Filter의 예외는 DispatcherServlet에 도달한 적이 없는 예외**이므로 잡힐 방법이 원천적으로 없다.

`05-spring-mvc-request-flow.md`의 파이프라인 위에 "예외가 어디까지 올라가는가"를 표시하면 이렇게 된다.

```
톰캣 (서블릿 컨테이너)
│  ▲  예외 (B)는 결국 여기까지 올라온다 → 톰캣의 에러 페이지 처리로 넘어간다
│  │
├─ Filter 체인 ───────────────────────── 여기서 던진 예외 = (B)
│   │  ▲
│   │  │  (A)는 여기까지 올라오지 않는다. 아래에서 이미 잡혀 응답으로 바뀌었다
│   │  │
│   └─ DispatcherServlet
│        │   doDispatch()가 아래 전부를 try 로 감싸고 있다
│        │
│        ├─ ④-a Interceptor.preHandle ──┐
│        ├─ ④-b 바인딩(ArgumentResolver) ┤  여기서 던진 예외 = (A)
│        ├─ ④-c 컨트롤러 메서드 ─────────┘
│        │        │
│        │        ▼  catch (Exception ex) 로 잡힌다
│        └─ ⑤ HandlerExceptionResolver
│               └─ @ControllerAdvice + @ExceptionHandler 실행 → 팀 표준 에러 응답
```

경계선은 **DispatcherServlet의 `try` 블록**이다. 그 안이면 (A), 그 밖이면 (B). 이 한 줄로 정리하면 헷갈릴 일이 없다.

#### 2-3-2. 그래서 실제로 무슨 응답이 나가는가

이 부분을 구체적으로 말할 수 있느냐가 아는 사람과 외운 사람을 가른다. (Spring Boot 3.x · 내장 톰캣 기준)

예외가 필터 체인을 뚫고 톰캣까지 올라가면, 톰캣은 **에러 페이지 처리**를 시작한다. 스프링 부트는 기동할 때 컨테이너에 `/error` 경로를 에러 페이지로 등록해 두므로, 톰캣은 같은 스레드에서 `/error`로 **ERROR 디스패치**라는 새 요청 처리를 한 번 더 일으킨다. 그 요청을 받는 것이 스프링 부트의 `BasicErrorController`다.

```
Filter 에서 예외 발생
   │
   ▼
필터 체인을 뚫고 톰캣까지 전파
   │
   ▼
톰캣이 등록된 에러 페이지(/error)로 ERROR 디스패치를 건다
   │
   ▼
BasicErrorController 가 Accept 헤더를 보고 응답 형태를 고른다
   │
   ├─ Accept: text/html      → Whitelabel Error Page (HTML 한 페이지)
   └─ Accept: application/json → 스프링 부트 기본 JSON
                                 {"timestamp":..., "status":500,
                                  "error":"Internal Server Error", "path":"/orders"}
```

여기서 정확히 짚어야 할 점이 둘이다.

**첫째, 어느 쪽이든 `@ControllerAdvice`는 실행되지 않는다.** ERROR 디스패치는 원래 예외를 들고 다시 들어온 별개의 요청이고, `BasicErrorController`는 예외를 던지지 않으므로 예외 처리기가 돌 일이 없다. 그래서 팀이 정한 `{"code": "...", "message": "..."}` 형태 대신 스프링 부트 기본 형태가 나간다. **"다른 에러는 다 우리 포맷인데 인증 에러만 포맷이 다르다"**는 현상의 정체가 이것이다.

**둘째, 에러 페이지 처리 자체가 없으면 진짜로 HTML이 나간다.** `server.error.whitelabel.enabled=false`로 꺼 두고 `/error`를 대체할 컨트롤러도 없거나, 스프링 부트가 아닌 순수 서블릿 환경이라면, 톰캣 자신의 기본 에러 페이지가 나간다. 이건 `<html><head><title>HTTP Status 500</title>...` 로 시작하는 HTML 문서다. JSON을 기대하고 `response.json()`을 부른 프런트엔드는 파싱 단계에서 터지고, 콘솔에는 원래 서버 에러와는 아무 상관 없는 `Unexpected token '<'` 같은 메시지가 찍힌다. **원인 파악이 한참 지연되는 전형적인 사고다.**

(가산점 포인트) `OncePerRequestFilter`는 기본적으로 이 ERROR 디스패치에서는 실행되지 않는다(`shouldNotFilterErrorDispatch()`가 `true`). 그래서 필터에서 MDC에 심어 둔 trace id를 `finally`에서 지웠다면, 에러 페이지 처리 과정의 로그에는 trace id가 없다. 3절의 사각지대 이야기와 이어지는 지점이다.

#### 2-3-3. 대응책

에러 응답을 팀 표준으로 통일하려면 필터 계층까지 포함해 설계해야 한다. 실무에서 쓰는 방법이 넷이다.

**(1) 예외 처리 전용 Filter를 체인 맨 앞에 둔다.** 뒤에서 올라온 예외를 잡아 표준 포맷 JSON을 직접 써서 응답한다. 가장 직관적이고 의존성이 없다.

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)   // 다른 필터보다 바깥에 있어야 그들의 예외를 잡는다
public class ErrorResponseFilter extends OncePerRequestFilter {
    private final ObjectMapper objectMapper;

    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            chain.doFilter(req, res);
        } catch (Exception e) {
            log.error("filter chain error", e);
            // 여기서 직접 쓰지 않으면 톰캣의 에러 페이지 처리로 넘어가 버린다.
            res.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
            res.setContentType(MediaType.APPLICATION_JSON_VALUE);
            res.setCharacterEncoding("UTF-8");   // 빠뜨리면 한글 메시지가 깨진다
            objectMapper.writeValue(res.getWriter(),
                    ErrorResponse.of("INTERNAL_ERROR", "일시적인 오류가 발생했습니다"));
        }
    }
}
```

**(2) `HandlerExceptionResolver`를 필터에 주입해 직접 호출한다.** MVC의 예외 처리 로직, 즉 `@ControllerAdvice`에 이미 써 놓은 것을 필터 계층에서 재사용하는 방법이다. 포맷 정의가 한 곳에만 남는다는 것이 장점이다.

```java
private final HandlerExceptionResolver resolver;   // "handlerExceptionResolver" 빈을 주입

// catch 블록에서
resolver.resolveException(req, res, null, e);   // handler 자리는 null — 핸들러가 없는 예외다
```

**(3) `/error`를 우리 컨트롤러로 받는다.** `ErrorController` 인터페이스를 구현한 컨트롤러를 만들어 `BasicErrorController`를 대체하면, 필터에서 올라온 예외든 다른 경로든 결국 `/error`로 모이므로 **마지막 그물**이 된다. 다만 이때는 원래 예외가 요청 속성(`jakarta.servlet.error.exception`)에 담겨 오므로 그것을 꺼내 써야 한다.

**(4) 인증·인가 실패는 Spring Security의 표준 확장점에서 처리한다.** Spring Security는 이 문제를 이미 알고 있어서, 필터 체인 안에 `ExceptionTranslationFilter`를 두고 인증 예외는 `AuthenticationEntryPoint`(401), 인가 예외는 `AccessDeniedHandler`(403)로 넘긴다. 이 둘을 구현해 팀 표준 JSON을 쓰면 된다. **Spring Security가 굳이 자체 예외 처리기를 갖고 있는 이유가 바로 "필터 안에서는 `@ControllerAdvice`를 쓸 수 없기 때문"이다.**

```java
@Bean
public AuthenticationEntryPoint authenticationEntryPoint(ObjectMapper om) {
    return (request, response, authException) -> {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        om.writeValue(response.getWriter(), ErrorResponse.of("UNAUTHORIZED", "인증이 필요합니다"));
    };
}
```

실무에서는 (4)로 인증·인가를 덮고, 그 밖의 필터 예외를 (1) 또는 (2)로 받고, (3)을 최후의 그물로 두는 조합이 흔하다.

### 2-4. 차이가 아닌 것 — 의존성 주입

오래된 자료에는 "Filter는 스프링 빈이 아니라 DI를 못 받는다"는 설명이 남아 있는데, **지금은 차이가 아니다.** 스프링 부트에서는 Filter를 `@Component`로 등록하거나 `FilterRegistrationBean`으로 감싸 등록하면 그대로 스프링 빈이고, 생성자 주입도 된다. 위 예제들이 `ObjectMapper`를 주입받는 것이 그 증거다.

원래 문제였던 것 — 컨테이너가 관리하는 필터가 스프링 빈을 쓰지 못하는 상황 — 은 `DelegatingFilterProxy`로 해결됐다. 컨테이너에 등록된 껍데기 필터가 실제 처리를 스프링 빈에게 위임하는 구조이고, Spring Security의 필터 체인이 바로 이 방식으로 꽂힌다.

## 3. 배치 결정 — 그리고 trace id 사각지대

### 3-1. 판단 기준

선택 기준은 한 문장으로 정리된다. **"그 일을 하려면 무엇을 알아야 하고 무엇을 만져야 하는가?"**

요청/응답 스트림 자체를 만져야 하거나, 스프링에 들어오지 못한 요청까지 포함해 **모든** 요청을 덮어야 한다면 **Filter**다. 문자 인코딩, CORS, 인증(Spring Security 필터 체인), 요청/응답 본문 캐싱과 로깅, 압축, MDC에 trace id 심기가 여기 속한다.

**어떤 핸들러가 처리하는지**를 알아야 한다면 **Interceptor**다. 애너테이션 기반 인가, 핸들러별 감사 로깅, 특정 URL 그룹의 로그인 확인, 컨트롤러 진입 전 공통 검증이 여기 속한다.

### 3-2. 사고 사례 — trace id를 Interceptor에 심었을 때

**trace id**는 요청 하나에 부여하는 고유 식별자로, 그 요청이 남긴 모든 로그에 같은 값을 찍어 흩어진 로그를 한 줄기로 잇는 데 쓴다. 보통 **MDC**(Mapped Diagnostic Context, 로깅 라이브러리가 스레드마다 들고 있는 작은 키-값 저장소)에 넣어 두면 로그 패턴이 자동으로 찍어 준다.

이걸 Interceptor에 심으면 어떻게 되는지, 인증이 실패한 요청의 타임라인을 따라가 보자.

```java
// before: Interceptor에서 MDC에 trace id를 심는다
public class TraceInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        MDC.put("traceId", UUID.randomUUID().toString());
        return true;
    }
}
```

```
[인증 토큰이 만료된 요청의 타임라인]

t0  요청 도착
t1  ① Filter 체인 진입
t2    Spring Security 필터가 토큰 검증 → 만료 → AuthenticationException
t3    ExceptionTranslationFilter가 AuthenticationEntryPoint 호출
t4    401 응답을 기록하고 체인을 되돌아 나간다
        ✗ 여기서 요청 처리가 끝난다. chain.doFilter 로 더 내려가지 않는다
        │
        └─ 실행되지 '않는' 것들
             ② DispatcherServlet          ✗
             ③ HandlerMapping             ✗
             ④-a Interceptor.preHandle    ✗  ← MDC.put 이 있는 바로 그 줄
t5  로그에 남는 것: 401 관련 로그 몇 줄, traceId 없음

결과: "특정 사용자가 계속 401을 받는다"는 문의가 들어와도
      그 사용자의 요청 로그를 하나의 흐름으로 이어붙일 수가 없다.
      정상 요청에는 trace id가 있고 실패 요청에만 없으니
      "장애가 난 요청일수록 추적이 안 되는" 최악의 사각지대가 된다.
```

원인은 단순하다. **인증은 Filter 계층에서 끝나므로, 그보다 안쪽에 있는 Interceptor까지 요청이 오지 않는다.** 2-3에서 본 예외 경계와 같은 구조의 문제다.

```java
// after: 필터 체인의 맨 앞에 Filter로 심는다
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)   // Security 필터(기본 순서 -100)보다 앞에 놓는다
public class TraceIdFilter extends OncePerRequestFilter {
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        // 앞단 게이트웨이가 헤더로 넘겨준 값이 있으면 이어받고, 없으면 새로 만든다.
        // 이어받아야 서비스 경계를 넘는 요청도 하나의 흐름으로 추적된다.
        MDC.put("traceId", resolveOrGenerate(req));
        res.setHeader("X-Trace-Id", MDC.get("traceId"));   // 클라이언트도 알 수 있게
        try {
            chain.doFilter(req, res);
        } finally {
            // 톰캣은 스레드를 재사용한다. 지우지 않으면 다음 요청이 남의 trace id를
            // 물려받아 로그가 엉킨다 — 관측 데이터가 오염되는 조용한 버그다.
            MDC.clear();
        }
    }
}
```

순서 지정이 핵심이다. Spring Security의 필터 체인은 스프링 부트에서 기본 순서 `-100`으로 등록되므로, trace id 필터를 그보다 앞에 두어야 인증 실패 요청에도 trace id가 찍힌다.

### 3-3. 같은 원리가 적용되는 다른 것들

접근 로그, 요청 카운트 메트릭, 응답 시간 측정도 마찬가지다. **Filter 계층의 가능한 한 앞쪽**에 둬야 차단된 요청까지 포함한 전체 그림이 잡힌다.

Interceptor에 두면 스프링 MVC에 진입한 요청만 세게 되어, 예를 들어 인증 실패가 폭증하는 공격 상황에서 오히려 지표상으로는 트래픽이 조용해 보이는 왜곡이 생긴다. "가장 알아야 할 때 안 보이는 지표"가 되는 셈이다.

## 4. 꼬리질문 대비 포인트

### "Spring Security는 왜 Interceptor가 아니라 Filter 체인으로 구현돼 있나요?"

이유가 셋이다.

인증과 인가는 **차단이 목적**이므로 최대한 바깥 경계에서 끝나야 한다. 스프링 MVC 안까지 들여보낸 뒤 막는 것보다, 들어오기 전에 막는 편이 공격 표면이 작다.

보호 대상이 컨트롤러만이 아니다. 정적 리소스를 포함해 **서블릿 컨테이너로 들어오는 모든 요청**을 덮어야 하는데, Interceptor는 DispatcherServlet 안쪽이라 그 범위를 커버하지 못한다.

Filter는 **서블릿 스펙 표준**이라 특정 웹 프레임워크에 묶이지 않는다. Spring MVC가 아닌 환경에도 같은 보안 계층을 얹을 수 있다.

"스프링 빈이 아닌 컨테이너 관할이라 DI를 못 받지 않느냐"는 반문에는 `DelegatingFilterProxy`로 답한다. 컨테이너에 등록되는 것은 껍데기 프록시 필터이고, 실제 처리는 스프링 빈인 `FilterChainProxy`에게 위임한다. **"필터인데 스프링 빈의 DI를 온전히 쓴다"**는 구조까지 말하면 가산점이다.

### "Filter에서 발생한 예외를 `@ControllerAdvice`가 못 잡는다면, 에러 응답 표준화는 어떻게 하나요?"

먼저 왜 못 잡는지를 한 문장으로 말한다. **`@ControllerAdvice`는 DispatcherServlet이 자기 `try` 안에서 잡은 예외를 `HandlerExceptionResolver`에게 넘겨야 실행되는 장치인데, Filter의 예외는 DispatcherServlet에 도달한 적이 없다.**

그다음 대응책을 든다. 체인 맨 앞의 예외 처리 전용 Filter에서 표준 JSON을 직접 쓰거나, `HandlerExceptionResolver` 빈을 필터에 주입해 호출함으로써 MVC의 예외 처리 로직을 재사용하거나, `/error`를 우리 `ErrorController`로 받아 마지막 그물을 치거나, 인증·인가 실패는 `AuthenticationEntryPoint`와 `AccessDeniedHandler`로 처리한다.

여기에 **아무 대응도 하지 않으면 실제로 무엇이 나가는지**까지 말하면 확실해진다. 스프링 부트라면 `/error`로 재진입해 부트 기본 JSON이나 Whitelabel HTML이 나가고, 그 처리마저 없으면 톰캣의 HTML 에러 페이지가 나가 JSON 파서가 `Unexpected token '<'`로 터진다.

핵심 인식은 **"에러 응답의 일관성은 `@ControllerAdvice`만으로 완성되지 않고, 필터 계층까지 포함해 설계해야 한다"**는 것이다.

### "Interceptor의 세 훅(preHandle / postHandle / afterCompletion)은 각각 언제 쓰나요?"

`preHandle`은 컨트롤러 실행 전이고, `false`를 반환해 요청을 차단할 수 있다. 인가와 선행 검증의 자리다.

`postHandle`은 컨트롤러가 정상 완료된 뒤, 뷰 렌더링 전이다. **예외가 나면 아예 호출되지 않는다.** ModelAndView를 손보는 용도라 REST API에서는 쓸 일이 거의 없다.

`afterCompletion`은 요청 처리가 끝난 뒤 **예외가 나도 항상** 호출된다. 자원 정리, 소요 시간 기록처럼 반드시 실행돼야 하는 일의 자리다.

"정리 로직을 `postHandle`에 두면 예외 경로에서 조용히 누수된다"까지 말하면 가산점이다. `try-finally`의 `finally`에 해당하는 것이 `afterCompletion`이라고 대응시키면 기억하기 쉽다.

### "Filter와 Interceptor 각각 실행 순서는 어떻게 제어하나요?"

Filter는 `FilterRegistrationBean.setOrder()` 또는 빈에 붙인 `@Order`로 정하며, **숫자가 작을수록 바깥쪽(먼저 실행)**이다. Spring Security의 필터 체인도 이 순서 체계 안의 한 자리(스프링 부트 기본값 `-100`)를 차지하므로, "Security보다 앞이어야 하나 뒤여야 하나"를 명시적으로 설계해야 한다. 3-2의 trace id 필터가 그 예다.

Interceptor는 `WebMvcConfigurer.addInterceptors`에서 등록한 순서대로 `preHandle`이 실행되고, `postHandle`과 `afterCompletion`은 **역순**으로 실행된다. 먼저 들어간 것이 나중에 나오는 양파 껍질 구조이고, Filter 체인도 같은 모양이다.

```
등록 순서: A, B, C

preHandle        A → B → C
                         │
컨트롤러                  ▼
                         │
postHandle       A ← B ← C   (역순)
afterCompletion  A ← B ← C   (역순)
```

### "AOP까지 포함하면 셋 중 무엇을 언제 쓰나요?" (시니어 변별 포인트)

"무엇을 알아야 하는가"를 기준으로 세 계층을 나눈다.

**Filter**는 HTTP 요청/응답 객체 자체가 대상이고 스프링 진입 전이어야 할 때다. 인코딩, 인증, 본문 캐싱, trace id가 여기 속한다.

**Interceptor**는 HTTP 문맥에 더해 **핸들러 정보**가 필요할 때다. 애너테이션 기반 인가, 핸들러별 감사 로깅이 여기 속한다.

**AOP**는 HTTP와 무관하게 **메서드 단위**로 걸어야 할 때다. 서비스 계층 메서드의 인자와 반환값에 접근할 수 있고, 웹이 아닌 진입점 — 스케줄러, 배치, 메시지 컨슈머 — 에도 그대로 적용된다. 반대로 Filter와 Interceptor는 웹 요청에만 걸린다. 트랜잭션과 캐시가 AOP로 구현돼 있는 이유가 이것이다.

트레이드오프도 짚는다. AOP는 프록시 기반이라 같은 클래스 안의 자기 호출에 무력하고, 포인트컷이 넓으면 영향 범위를 파악하기 어렵다. Interceptor는 웹 계층에 묶인다. Filter는 핸들러 문맥이 없어 세밀한 선별이 힘들다.

**"트랜잭션·캐시처럼 도메인 메서드에 붙는 관심사는 AOP, HTTP 경계의 관심사는 Filter/Interceptor로 나누되, 같은 관심사를 두 계층에 중복해 두지 않는다"**는 배치 원칙을 말하면 설계 감각이 드러난다. 중복해서 걸어 두면 나중에 "왜 로그가 두 번 찍히지"를 추적하는 데 시간을 쓰게 된다.

---

## 한 줄 요약

Filter는 서블릿 컨테이너 소속이라 DispatcherServlet 바깥에서 모든 요청을 덮고 요청/응답 객체 자체를 교체할 수 있으며(인코딩·인증·본문 캐싱·trace id), Interceptor는 Spring MVC 소속이라 `HandlerMethod`를 알고 있어 핸들러별 선별 처리에 적합하다(애너테이션 기반 인가·감사 로깅) — 배치 기준은 **"모든 요청을 스프링 밖에서 덮어야 하면 Filter, 핸들러를 알고서 처리해야 하면 Interceptor"**이고, 이 경계는 예외에도 그대로 적용되어 Filter의 예외는 DispatcherServlet에 닿은 적이 없으므로 `@ControllerAdvice`가 아니라 톰캣의 에러 페이지 처리로 넘어가며, 잘못 놓으면 인증 실패 응답에만 trace id가 빠지는 관측 사각지대가 생긴다.
