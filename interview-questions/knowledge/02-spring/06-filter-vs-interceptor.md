# Filter vs Interceptor — 소속이 다르면 아는 것과 할 수 있는 것이 다르다

> 핵심 관전 포인트: **Filter는 서블릿 컨테이너 소속으로 DispatcherServlet
> 바깥(스프링 진입 전)에서, Interceptor는 Spring MVC 소속으로
> HandlerMapping 이후에 동작한다. 이 소속 차이에서 세 가지 실질적 차이가
> 나온다 — Filter는 요청/응답 객체 자체를 감싸거나 교체할 수 있지만 어떤
> 핸들러가 처리할지 모르고, Interceptor는 HandlerMethod(컨트롤러 메서드
> 정보)에 접근할 수 있으며, Filter에서 터진 예외는 `@ControllerAdvice`가
> 못 잡는다. 용도는 여기서 갈린다: 인코딩·CORS·인증(Spring Security)·요청
> 본문 캐싱·trace id처럼 "모든 요청에, 스프링 진입 전에" 필요한 일은
> Filter, 인가·감사 로깅처럼 "어떤 컨트롤러가 처리하는지" 알아야 하는 일은
> Interceptor.**

---

## 0. 질문 + 의도

**질문**: "Filter와 Interceptor의 차이, 각각 어떤 용도에 적합한가요?"

**출제 의도**: 인증, 로깅, 트레이싱을 어느 계층에 넣을지의 실무 결정을
할 수 있는지 본다. 잘못 놓으면 "인증 실패 응답에는 trace id가 안 찍히는"
류의 관측 사각지대가 생긴다 — 차이를 암기했는지가 아니라, 차이로부터
배치 결정을 도출할 수 있는지가 관전 포인트다.

(전체 요청 파이프라인의 단계별 흐름은 `05-spring-mvc-request-flow.md`
참고. 이 문서는 Filter/Interceptor 두 계층의 차이와 용도 선택에 집중한다.)

## 1. 위치와 소속 — 모든 차이의 뿌리

```text
클라이언트
  → [Filter 체인]            ... 서블릿 컨테이너(Tomcat) 관할, 서블릿 스펙
  → DispatcherServlet        ─┐
  → [Interceptor.preHandle]   │ Spring MVC 관할
  → 컨트롤러                    │
  → [Interceptor.postHandle]  │ (예외 시 건너뜀)
  → [Interceptor.afterCompletion] ... 예외가 나도 항상 실행
  ← 응답
```

- **Filter**: 서블릿 스펙(`jakarta.servlet.Filter`)의 표준 부품. 스프링이
  없어도 존재하는 개념이고, DispatcherServlet **앞**에서 요청/응답을
  통째로 쥔다. 체인 방식이라 `chain.doFilter()`를 호출하지 않으면 요청이
  거기서 끝난다(단락).
- **Interceptor**: 스프링 MVC(`HandlerInterceptor`)의 부품.
  HandlerMapping이 "누가 처리할지"를 찾은 **뒤**에 실행되므로 핸들러
  정보를 알고 있다. `preHandle`이 false를 반환하면 컨트롤러로 가지 않는다.

비유: Filter는 **건물 정문 보안 게이트** — 방문자가 어느 부서에 가는지
몰라도 출입증 검사·소지품 검사(요청 자체의 가공)를 한다. Interceptor는
**부서 입구의 안내 데스크** — 방문자가 만날 담당자(핸들러)가 누군지 알고,
그에 맞는 절차(핸들러별 처리)를 밟게 한다.

나머지 차이는 전부 이 "소속과 위치"에서 파생된다.

## 2. 소속이 만드는 세 가지 실질적 차이

### ① 요청/응답 객체를 교체할 수 있는가 — Filter만 가능

Filter는 체인에 **다른 객체를 넘길 수 있다.** 요청 본문 로깅이 대표
사례다 — HTTP 요청 본문(InputStream)은 한 번 읽으면 끝이라, 로깅이
먼저 읽어버리면 컨트롤러의 `@RequestBody` 바인딩이 실패한다. 그래서
"읽은 내용을 저장해두는 래퍼"로 갈아끼운 뒤 체인에 넘겨야 한다.

```java
// Before: Interceptor에서 본문 로깅 시도
public class LoggingInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, ...) {
        req.getInputStream();  // 문제 1: 여기서 읽으면 @RequestBody 바인딩 실패
        // 문제 2: Interceptor는 뒤 단계에 전달될 request 객체를
        //         교체할 방법이 없다 (인자로 받을 뿐)
        return true;
    }
}

// After: Filter에서 캐싱 래퍼로 교체해 체인에 넘긴다
public class BodyLoggingFilter extends OncePerRequestFilter {
    protected void doFilterInternal(HttpServletRequest req,
                                    HttpServletResponse res,
                                    FilterChain chain) throws ... {
        var wrappedReq = new ContentCachingRequestWrapper(req);
        var wrappedRes = new ContentCachingResponseWrapper(res);
        chain.doFilter(wrappedReq, wrappedRes);   // 교체된 객체가 흘러감
        log.info("req body: {}", new String(wrappedReq.getContentAsByteArray()));
        wrappedRes.copyBodyToResponse();          // 캐싱한 응답을 실제로 내보냄
    }
}
```

인코딩 설정, 압축, 응답 본문 변조 감지처럼 **요청/응답 스트림 자체를
다루는 일**은 구조적으로 Filter의 영역이다.

### ② 핸들러 문맥을 아는가 — Interceptor만 가능

Interceptor는 `preHandle`의 세 번째 인자로 핸들러를 받는다.
`HandlerMethod`로 캐스팅하면 **어떤 컨트롤러의 어떤 메서드가, 어떤
애너테이션을 달고** 처리하는지 알 수 있다.

```java
public class AdminAuthInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res,
                             Object handler) {
        if (!(handler instanceof HandlerMethod method)) return true;

        // 핸들러 메서드의 애너테이션을 보고 분기 — Filter에서는 불가능
        if (method.hasMethodAnnotation(AdminOnly.class)
                && !isAdmin(req)) {
            res.setStatus(HttpServletResponse.SC_FORBIDDEN);
            return false;   // 컨트롤러 실행 차단
        }
        return true;
    }
}
```

"이 URL 그룹에만", "이 애너테이션이 붙은 핸들러에만" 같은 **선별적
공통 처리**는 Interceptor가 자연스럽다. 등록 시 `addPathPatterns` /
`excludePathPatterns`로 경로 기반 선별도 서블릿 URL 패턴보다 정교하게
할 수 있다.

### ③ 예외가 어디로 가는가 — 에러 응답 일관성의 분기점

- **Interceptor(및 컨트롤러)에서 던진 예외**: DispatcherServlet 안에서
  발생하므로 `HandlerExceptionResolver` → `@ControllerAdvice` +
  `@ExceptionHandler`가 잡는다. 팀의 표준 에러 포맷으로 응답된다.
- **Filter에서 던진 예외**: DispatcherServlet **바깥**이라
  `@ControllerAdvice`가 못 잡는다. 서블릿 컨테이너까지 전파된 뒤
  Spring Boot의 에러 처리(`/error`, `BasicErrorController`)로 넘어가
  **기본 포맷의 에러 응답**이 나간다 — 표준 포맷과 다른 응답이 섞이는
  원인이다.

이 차이를 모르면 "다른 에러는 다 우리 포맷인데 인증 에러만 포맷이 왜
다르지?"의 원인을 못 찾는다. Spring Security가
`AuthenticationEntryPoint` / `AccessDeniedHandler`라는 별도 처리기를
필터 체인 안에 두는 이유가 바로 이것이다.

(참고) DI 가능 여부는 이제 차이가 아니다 — Spring Boot에서는 Filter도
빈으로 등록(`@Component` 또는 `FilterRegistrationBean`)하므로 둘 다
스프링 빈의 혜택을 받는다.

## 3. 용도 선택 기준 + 실무 사례 — trace id 사각지대

선택 기준은 한 문장으로 정리된다:
**"그 일을 하려면 무엇을 알아야/만져야 하는가?"**

- 요청/응답 **스트림 자체**를 만지거나, **모든 요청**(스프링 밖 정적
  리소스, 인증 실패 포함)을 덮어야 한다 → **Filter**
  - 문자 인코딩, CORS, 인증(Spring Security 필터 체인), 요청/응답 본문
    캐싱·로깅, 압축, MDC trace id 심기
- **어떤 핸들러가 처리하는지**를 알아야 한다 → **Interceptor**
  - 애너테이션 기반 인가, 핸들러별 감사 로깅, 특정 URL 그룹 로그인 체크,
    컨트롤러 진입 전 공통 검증

출제 의도가 짚는 사고 사례 — **trace id를 Interceptor에 심은 경우**:

```java
// Before: Interceptor에서 MDC에 trace id 심기
public class TraceInterceptor implements HandlerInterceptor {
    public boolean preHandle(...) {
        MDC.put("traceId", generate());   // 문제: 인증은 Security "필터"에서
        return true;                       // 이미 끝났다. 인증 실패(401) 응답은
    }                                      // 여기까지 오지도 않는다
}
// → 결과: 인증 실패 로그에 trace id가 없다.
//   "특정 사용자의 401 문의"가 들어와도 로그를 이어붙일 수가 없는
//   관측 사각지대가 생긴다.
```

```java
// After: 필터 체인의 "맨 앞"에 Filter로 심는다
@Component
public class TraceIdFilter extends OncePerRequestFilter {
    protected void doFilterInternal(HttpServletRequest req,
                                    HttpServletResponse res,
                                    FilterChain chain) throws ... {
        MDC.put("traceId", resolveOrGenerate(req));  // Security보다 먼저
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.clear();   // 스레드 재사용 대비 — 반드시 정리
        }
    }
}
// 등록 시 순서를 최우선으로 지정해 Security 필터보다 앞에 놓는다
// (FilterRegistrationBean.setOrder 또는 @Order)
```

같은 원리로 **접근 로그, 요청 카운트 메트릭**도 Filter 계층(가능한 한
앞쪽)에 둬야 "차단된 요청까지 포함한 전체 그림"이 잡힌다. Interceptor에
두면 스프링에 진입한 요청만 세는 반쪽짜리 지표가 된다.

## 4. 꼬리질문 대비 포인트

### "Spring Security는 왜 Interceptor가 아니라 Filter 체인으로 구현돼 있나요?"

인증/인가는 (1) **스프링 MVC에 진입하기 전에** 끝나야 하고(차단이
목적이므로 최대한 바깥 경계에서), (2) 컨트롤러뿐 아니라 정적 리소스 등
**서블릿으로 들어오는 모든 요청**을 보호해야 하며, (3) 서블릿 스펙
표준이라 특정 웹 프레임워크에 묶이지 않기 때문이다. 스프링 빈이 아닌
컨테이너 관할이라는 문제는 `DelegatingFilterProxy`(컨테이너에 등록된
프록시 필터가 실제 처리를 스프링 빈 `FilterChainProxy`에 위임)로
해결한다 — "필터인데 스프링 빈의 DI를 쓰는" 구조까지 말하면 가산점.

### "Filter에서 발생한 예외를 @ControllerAdvice가 못 잡는다면, 에러 응답 표준화는 어떻게 하나요?"

세 가지 접근이 실무에서 쓰인다:

1. **예외 처리 전용 Filter를 체인 맨 앞에** 두고, 뒤에서 올라온 예외를
   잡아 표준 포맷 JSON을 직접 써서 응답한다.
2. **`HandlerExceptionResolver`를 필터에 주입**해 호출한다 — MVC의
   예외 처리(=`@ControllerAdvice` 로직)를 필터 계층에서 재사용하는 방법.
3. 인증/인가 실패는 Spring Security의 표준 확장점인
   `AuthenticationEntryPoint`(401) / `AccessDeniedHandler`(403)에서
   표준 포맷으로 응답한다.

핵심은 "에러 응답의 일관성은 MVC 안(@ControllerAdvice)만으로는 완성되지
않고, 필터 계층까지 포함해 설계해야 한다"는 인식이다.

### "Interceptor의 세 가지 훅(preHandle/postHandle/afterCompletion)은 각각 언제 쓰나요?"

- `preHandle`: 컨트롤러 실행 **전**. false 반환으로 차단 가능 —
  인가, 선행 검증.
- `postHandle`: 컨트롤러 정상 완료 후, 뷰 렌더링 전. **예외가 나면
  건너뛴다** — ModelAndView 가공(REST API에서는 쓸 일이 적다).
- `afterCompletion`: 요청 처리 완료 후 **예외가 나도 항상** 호출 —
  자원 정리, 소요 시간 기록. "정리 로직을 postHandle에 두면 예외 경로에서
  누수된다"까지 말하면 가산점.

### "Filter와 Interceptor 각각 실행 순서는 어떻게 제어하나요?"

- Filter: `FilterRegistrationBean.setOrder()` 또는 빈에 `@Order` —
  숫자가 작을수록 앞. Security 필터 체인도 이 순서 체계 안의 한
  자리이므로, "Security보다 앞/뒤"가 필요하면 상대 순서를 명시적으로
  설계해야 한다.
- Interceptor: `WebMvcConfigurer.addInterceptors`에서 등록한 순서(또는
  `order()` 지정)대로 `preHandle`이 실행되고, `postHandle`/
  `afterCompletion`은 **역순**으로 실행된다(양파 껍질 구조).

### "AOP까지 포함하면 셋 중 무엇을 언제 쓰나요?" (시니어 변별 포인트)

"무엇을 알아야 하는가"를 기준으로 세 계층을 나눈다:

- **Filter** — HTTP 요청/응답 자체가 대상이고, 스프링 진입 전이어야 할 때
  (인코딩, 인증, 본문 캐싱, trace id).
- **Interceptor** — HTTP 문맥 + **핸들러 정보**가 필요할 때
  (애너테이션 기반 인가, 핸들러별 감사 로깅).
- **AOP** — HTTP와 무관하게 **메서드 단위**로 걸어야 할 때. 서비스 계층
  메서드의 인자·반환값에 접근할 수 있고, 웹이 아닌 진입점(스케줄러, 배치,
  메시지 컨슈머)에도 적용된다. 반대로 Filter/Interceptor는 웹 요청에만
  걸린다.

트레이드오프까지: AOP는 프록시 기반이라 자기 호출에 무력하고, 포인트컷이
넓으면 영향 범위 파악이 어렵다. Interceptor는 웹 계층에 묶이고, Filter는
핸들러 문맥이 없어 세밀한 선별이 힘들다. "트랜잭션·캐시처럼 도메인
메서드에 붙는 관심사는 AOP, HTTP 경계의 관심사는 Filter/Interceptor로
나누되, 같은 관심사를 두 계층에 중복으로 두지 않는다"는 배치 원칙을
말하면 설계 감각을 보여줄 수 있다.

---

## 한 줄 요약

Filter는 서블릿 컨테이너 소속이라 스프링 진입 전에 요청/응답 객체
자체를 다룰 수 있고(인코딩·인증·본문 캐싱·trace id), Interceptor는
Spring MVC 소속이라 핸들러 정보를 아는 선별적 처리(인가·감사 로깅)에
적합하다 — **"모든 요청을, 스프링 밖에서" 는 Filter, "핸들러를 알고서"
는 Interceptor**가 배치 기준이며, 잘못 놓으면 인증 실패 응답에 trace
id가 빠지는 관측 사각지대가 생긴다.
