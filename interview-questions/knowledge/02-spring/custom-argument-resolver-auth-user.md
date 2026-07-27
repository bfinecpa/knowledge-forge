# 반복되는 인증 사용자 조회 제거 — 인터셉터 + 커스텀 ArgumentResolver

> 핵심 관전 포인트: 컨트롤러마다 반복되는 "토큰 추출→사용자 조회→검증" 코드는 **역할을 둘로 쪼개** 제거한다. **검증·차단은 요청 앞단**(인터셉터 또는 필터 — 선택 기준은 5장), **컨트롤러에 사용자 객체를 넘겨주는 건 커스텀 `HandlerMethodArgumentResolver`**가 담당해 `@AuthUser LoginUser user` 파라미터로 주입한다. 둘 사이의 전달 통로는 기본적으로 `request.setAttribute`(요청 생명주기와 함께 소멸), ThreadLocal을 쓴다면 **`afterCompletion`에서 반드시 `remove()`** — 톰캣 스레드는 재사용되므로 안 지우면 다음 요청에 다른 사용자 정보가 남는 오염 사고가 난다.

## 0. 질문 + 의도

**질문**: "컨트롤러마다 반복되는 인증 사용자 조회/검증 코드를 어떻게 제거하나요? (커스텀 ArgumentResolver, 인터셉터)"

**출제 의도**: 컨트롤러마다 토큰 파싱·사용자 조회가 복붙되면 검증 누락 한 곳이 곧 보안 구멍이다. 횡단 관심사를 프레임워크 확장점으로 옮겨 "실수할 수 없는 구조"를 만드는지 — 프레임워크를 쓰는 수준을 넘어 확장하는 수준인지 본다.

## 1. 문제 — 수십 곳에 박제된 같은 코드

```java
// Before: 모든 컨트롤러 메서드마다 반복
@GetMapping("/orders")
public List<Order> myOrders(@RequestHeader("Authorization") String token) {
    String userId = tokenParser.parse(token);          // 추출
    LoginUser user = userService.findById(userId);     // 조회
    if (user == null || user.isLocked()) {             // 검증
        throw new UnauthorizedException();
    }
    return orderService.findByUser(user);              // 여기부터가 진짜 로직
}
```

반복 자체도 문제지만, 검증 규칙이 바뀌면 수십 곳을 고쳐야 하고 한 곳이라도 빠뜨리면 인증 구멍이 된다.

## 2. 구조 — 역할을 둘로 나눈다

```java
// After: 컨트롤러는 비즈니스 로직만
@GetMapping("/orders")
public List<Order> myOrders(@AuthUser LoginUser user) {
    return orderService.findByUser(user);
}
```

| 역할 | 담당 | 이유 |
|---|---|---|
| 토큰 검증·차단 (401) | 인터셉터 `preHandle` 또는 필터 | 컨트롤러 진입 전에 한 번만, 경로 패턴으로 적용 범위 제어 (둘 중 무엇을 고르는지는 5장) |
| 사용자 객체를 파라미터로 주입 | `HandlerMethodArgumentResolver` | 인터셉터는 컨트롤러 메서드에 값을 직접 넘길 수 없다 — 파라미터 바인딩은 리졸버의 소관 |

## 3. 구현

```java
// 1) 마커 애너테이션
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface AuthUser {}

// 2) 인터셉터 — 검증하고 request attribute 에 심는다
public class AuthInterceptor implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        LoginUser user = authService.verify(req.getHeader("Authorization")); // 실패 시 예외 → 401
        req.setAttribute("loginUser", user);
        return true;
    }
}

// 3) 리졸버 — attribute 에서 꺼내 파라미터로
public class AuthUserArgumentResolver implements HandlerMethodArgumentResolver {
    @Override
    public boolean supportsParameter(MethodParameter p) {
        return p.hasParameterAnnotation(AuthUser.class)
            && p.getParameterType().equals(LoginUser.class);
    }
    @Override
    public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav,
                                  NativeWebRequest req, WebDataBinderFactory bf) {
        return req.getAttribute("loginUser", RequestAttributes.SCOPE_REQUEST);
    }
}

// 4) 등록
@Configuration
public class WebConfig implements WebMvcConfigurer {
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new AuthInterceptor()).addPathPatterns("/api/**");
    }
    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new AuthUserArgumentResolver());
    }
}
```

## 4. 전달 통로 — request attribute vs ThreadLocal

| | `request.setAttribute` | ThreadLocal |
|---|---|---|
| 수명 | 요청 생명주기와 함께 소멸 — 뒤처리 불요 | **직접 정리해야 함** |
| 꺼내는 곳 | 리졸버의 `NativeWebRequest`에서 바로 | 어디서든 static 접근 |
| 대표 사례 | 위 구현 | Spring Security의 `SecurityContextHolder`가 이 방식 (`spring-security-filter-chain-authentication.md` 참조) |
| 권장 | **기본값으로 권장** | 컨트롤러 밖(서비스 깊은 곳)에서도 사용자 정보가 필요할 때 |

**ThreadLocal의 함정**: 톰캣 스레드는 풀에서 **재사용**된다. `afterCompletion`에서 `remove()`를 빠뜨리면 다음 요청 — **다른 사용자** — 에 이전 사용자 정보가 남는다. 인증 도메인(IAM)에서는 데이터 유출로 직결되는 치명적 사고 유형. `@Async`로 스레드가 바뀌면 ThreadLocal이 전파되지 않는 것도 동일 계열 함정(`transaction-synchronization-connection-binding.md` 참조).

## 5. 확장 지점 구분 — 무엇이 누구 소관인가

| 확장 지점 | 위치 | 소관 |
|---|---|---|
| Filter | 서블릿 컨테이너 (DispatcherServlet 앞) | 요청/응답 객체 래핑, 스프링 MVC 무관 관심사, Security 필터 체인 |
| Interceptor | DispatcherServlet 안, 핸들러 앞뒤 | 핸들러 정보 접근이 필요한 공통 검증·차단 |
| ArgumentResolver | 핸들러 호출 직전 파라미터 바인딩 | 컨트롤러 시그니처로 값 주입 |
| @ControllerAdvice | 핸들러 실행 후 | 예외 → 에러 응답 변환 (전역) |

```flow
# 같은 요청이 지나는 지점들. **위로 갈수록 커버리지가 넓고, 아래로 갈수록 아는 정보가 많다** — 이 맞바꿈이 필터/인터셉터 선택의 전부다.
== 서블릿 컨테이너 — 스프링 MVC 바깥
① Filter | 요청/응답 객체를 감싸 교체할 수 있는 유일한 지점. 정적 리소스·404·다른 서블릿까지 전부 지나간다
  ! 여기서 던진 예외는 @ControllerAdvice 가 못 잡는다 → 부트 기본 /error 응답으로 나간다
== DispatcherServlet 관할
② HandlerMapping | 요청을 처리할 컨트롤러 메서드를 찾는다. 못 찾으면 404 — 아래 단계는 아예 실행되지 않는다
③ Interceptor.preHandle | 핸들러가 누구인지 안다 → 메서드 애너테이션 기반 정책. addPathPatterns / excludePathPatterns 로 범위 제어
④ ArgumentResolver | @AuthUser LoginUser 로 주입 — 값을 컨트롤러 시그니처에 넣는 유일한 지점
⑤ 컨트롤러 메서드 | 비즈니스 로직만 남는다
```

### 5-1. 인증은 Security가 없어도 필터로 할 수 있다

"인터셉터 또는 Security 필터"라는 병렬 표현은 **필터 = Security 전용**이라는 오해를 부르기 쉽다. 순수 서블릿 필터로 JWT를 검증하는 구현은 흔하고 정당하다. 셋 다 가능하고, 실제로 갈리는 지점은 세 가지뿐이다.

| | 필터 | 인터셉터 |
|---|---|---|
| 예외 → 에러 응답 | `@ControllerAdvice`가 **못 잡는다** (DispatcherServlet 바깥) | 잡힌다 — 기존 예외 처리 체계 그대로 |
| 커버리지 | 정적 리소스·404·다른 서블릿까지 **전부** 지나감 | DispatcherServlet이 **핸들러를 찾은 요청만** |
| 경로 매칭 | 서블릿 스펙(`/api/*`, `*.json`) — **제외 불가** | `addPathPatterns` / `excludePathPatterns` |

**필터 인증의 최대 불편은 첫 줄이다.** 필터에서 `throw new UnauthorizedException()`을 해도 `@RestControllerAdvice`의 핸들러를 타지 않는다. 부트 기본 `/error` 응답이 나가버려 팀이 정한 `{"code":"AUTH_001", ...}` 포맷을 못 맞춘다. 그래서 응답을 손으로 조립하게 되는데, 더 나은 우회법은 **`HandlerExceptionResolver`를 주입해 직접 호출**하는 것이다 — 필터에서 던진 예외를 기존 `@ExceptionHandler` 체계에 그대로 얹을 수 있다.

```java
public class JwtAuthFilter extends OncePerRequestFilter {

    private final HandlerExceptionResolver resolver;   // 부트가 등록한 것을 빌려 쓴다

    public JwtAuthFilter(@Qualifier("handlerExceptionResolver") HandlerExceptionResolver resolver) {
        this.resolver = resolver;   // ★ 이름을 지정해야 정확히 그 빈이 주입된다
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        try {
            req.setAttribute("loginUser", authService.verify(req.getHeader("Authorization")));
            chain.doFilter(req, res);
        } catch (AuthException e) {
            resolver.resolveException(req, res, null, e);   // @ExceptionHandler 를 태운다
        }
    }
}
```

**반대로 필터가 유리한 지점은 두 번째 줄이다.** 인터셉터는 핸들러 매핑이 **성공한** 요청만 탄다. 존재하지 않는 URL은 `preHandle`이 불리지 않고 곧장 404가 나간다 — 즉 **토큰 없이도 "이 경로가 존재하는지"를 알아낼 수 있다**(엔드포인트 열거). 필터로 막으면 존재 여부와 무관하게 401이다. 노출도까지 통제해야 하는 API라면 이 차이가 실제 의미를 갖는다.

### 5-2. 판단 기준 — 질문 네 개로 갈린다

```text
① 요청/응답 객체 자체를 바꿔치기해야 하나?  ── YES ─▶ 필터 (인터셉터는 구조적으로 불가능)
② 스프링 MVC 밖의 요청까지 적용돼야 하나?    ── YES ─▶ 필터
③ "어느 컨트롤러 메서드인지" 알아야 하나?    ── YES ─▶ 인터셉터
④ 기존 예외 처리 체계에 태우고 싶은가?       ── YES ─▶ 인터셉터
```

①이 가장 결정적인데 자주 잊힌다. 필터는 `chain.doFilter(감싼요청, 감싼응답)`으로 **다음 단계에 다른 객체를 넘길 수 있고**, 인터셉터는 그게 불가능하다(이미 만들어진 요청을 받아 boolean만 리턴). 그래서 이건 필터밖에 못 한다:

```java
// 요청 본문을 두 번 읽으려면 (로깅 + 컨트롤러의 @RequestBody) — 필터만 가능
var wrapped = new ContentCachingRequestWrapper(req);
chain.doFilter(wrapped, res);
log.info("body={}", new String(wrapped.getContentAsByteArray()));
```

`InputStream`은 한 번만 읽히므로, 감싸서 교체하지 않으면 로깅한 순간 컨트롤러의 `@RequestBody`가 빈 본문을 받는다.

| 필터가 맞는 기능 | 인터셉터가 맞는 기능 |
|---|---|
| 문자 인코딩, CORS, gzip | 애너테이션 기반 인가 (`@RequiresRole`) |
| 요청/응답 본문 로깅 (래핑 필요) | 핸들러 단위 처리 시간·메트릭 |
| XSS 파라미터 치환 (래핑 필요) | `@Idempotent` 중복 요청 차단 |
| trace id(MDC) 생성 — 정적 리소스 로그까지 커버 | `postHandle`에서 공통 모델 값 추가 |
| Security 인증·인가 | 세션 로그인 체크, 화면 단위 접근 제어 |

### 5-3. "핸들러 정보 접근"이 결정적인 상황 — 애너테이션으로 정책을 선언한다

필터는 URL 문자열밖에 못 본다. 그래서 "이 URL은 ADMIN만" 같은 규칙을 **URL→권한 매핑 테이블로 필터 안에 따로** 들고 있어야 한다.

```java
// Before: 필터 — 정책이 컨트롤러에서 멀리 떨어져 산다
private static final Map<String, String> URL_ROLES = Map.of(
    "/api/admin/**",        "ADMIN",
    "/api/orders/*/cancel", "MANAGER",
    "/api/settlements/**",  "FINANCE"
);

// After: 인터셉터 — 정책이 핸들러에 붙어 있어 경로를 바꿔도 따라온다
@RequiresRole("MANAGER")
@PostMapping("/orders/{id}/cancel")
public void cancel(@PathVariable Long id) { ... }
```

Before의 진짜 문제는 중복이 아니라 **컨트롤러의 `@PostMapping` 경로를 바꾸는 순간 이 표가 조용히 틀어진다**는 것이다. 컴파일 에러도 안 나고 테스트가 없으면 아무도 모르는 채로 권한 검사가 통째로 빠진다 — **URL 리네이밍이 곧 인가 구멍**이 되는 구조다. 인터셉터는 핸들러에서 애너테이션을 직접 읽으므로 그 연결이 끊어질 수 없다.

```java
@Override
public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
    if (!(handler instanceof HandlerMethod hm)) return true;   // 정적 리소스 등은 통과

    RequiresRole ann = hm.getMethodAnnotation(RequiresRole.class);
    if (ann == null) ann = hm.getBeanType().getAnnotation(RequiresRole.class);  // 클래스 단위도 지원
    if (ann != null && !currentUser(req).hasRole(ann.value())) {
        throw new ForbiddenException();   // ← @ControllerAdvice 가 받아 준다
    }
    return true;
}
```

같은 원리로 파생되는 것들:

- **`@RateLimit(perMinute = 10)`** — 엔드포인트마다 다른 한도를 메서드 옆에 선언한다.
- **`@Idempotent`** — 이 애너테이션이 붙은 핸들러에서만 `Idempotency-Key` 헤더를 검사한다.
- **메트릭 카디널리티** — URL로 태깅하면 `/orders/1`, `/orders/2`가 전부 다른 시계열이 되어 폭발한다. `hm.getBeanType().getSimpleName() + "#" + hm.getMethod().getName()`으로 태깅하면 `OrderController#get` 하나로 수렴한다. 필터는 `{id}`가 무엇으로 치환됐는지 모르니 이걸 할 수 없다.

### 5-4. "addPathPatterns"가 결정적인 상황 — 공개 엔드포인트 예외

서블릿 필터의 `url-pattern`은 세 형태만 지원한다: 완전 일치(`/api/login`), 경로 접두(`/api/*`), 확장자(`*.json`). **제외(exclude)라는 개념 자체가 없다.** 그런데 실무의 인증 설정은 거의 항상 이 모양이다.

```java
registry.addInterceptor(authInterceptor)
        .addPathPatterns("/api/**")                       // 기본은 전부 차단
        .excludePathPatterns(
            "/api/auth/login", "/api/auth/signup",        // 공개 엔드포인트만 예외
            "/api/health", "/api/docs/**")
        .order(1);
```

필터로 하면 이 화이트리스트를 필터 코드 안에서 `AntPathMatcher`로 직접 굴려야 한다 — Spring Security의 `permitAll()`이 제공하는 게 정확히 이 기능이다. **Security 없이 필터로 인증하겠다면 결국 이 경로 매칭 로직을 손으로 만들게 된다.**

여기서 방향이 중요하다. `/api/**` 전부 차단 + 예외 허용은 **새 API를 추가하면 자동으로 인증이 걸린다** — 실수하면 401 장애로 즉시 드러난다. 반대로 "이 URL들만 인증"으로 짜면 새 API 추가 시 **조용히 인증이 빠진다** — 아무도 모르는 보안 구멍이다. 실패가 안전한 쪽으로 기울게 설계하는 것이 핵심이다.

패턴 문법 자체도 훨씬 세다 — `/api/v1/orders/*`(한 세그먼트), `/api/**`(나머지 전부), `/api/{version}/users/**`(변수). 단 Boot 3부터 `PathPatternParser`가 기본이라 `**`는 패턴 맨 끝에만 올 수 있다. 여러 인터셉터가 각기 다른 범위와 순서를 갖는 것도 자연스럽다.

```java
registry.addInterceptor(localeInterceptor).addPathPatterns("/**").order(0);
registry.addInterceptor(authInterceptor).addPathPatterns("/api/**").order(1);
registry.addInterceptor(auditInterceptor).addPathPatterns("/api/admin/**").order(2);
```

### 5-5. 정리 — 그래서 인증은 어디에 두나

| 상황 | 선택 |
|---|---|
| Spring Security 도입 | 필터 체인 + `@AuthenticationPrincipal` — 프레임워크가 이미 제공 |
| Security 미도입, 일반 REST API | **인터셉터** — 에러 응답 포맷 일관성과 `excludePathPatterns`의 이득이 크다 |
| Security 미도입, 엔드포인트 존재 노출까지 막아야 함 | **필터** + `HandlerExceptionResolver` 주입 |
| 인증은 앞단, 인가는 애너테이션 | **필터(인증) + 인터셉터(인가)** — 실무에서 흔한 조합 |

마지막 줄이 핵심이다. 둘은 택일이 아니라 **역할을 한 번 더 나눌 수 있다** — "이 사람이 누구인가"(신원 확인, 모든 요청)는 필터, "이 사람이 이걸 해도 되는가"(핸들러별 권한)는 인터셉터. 2장의 "차단은 앞단, 주입은 리졸버" 분리를 3단으로 넓힌 형태다.

**선택 근거 교정**: "인터셉터는 스프링 빈을 쓸 수 있어서"는 약한 근거다 — **필터도 빈으로 등록하면 주입받을 수 있다**. 진짜 근거는 위의 세 축(예외 처리 일관성 · 커버리지 · 경로 매칭)이고, 인터셉터 쪽 강점은 **핸들러 정보 접근**(5-3)과 **`excludePathPatterns`**(5-4)로 구체화된다.

**Spring Security를 이미 쓰고 있다면**: 커스텀 인터셉터 대신 **필터 체인 + `SecurityContextHolder` + `@AuthenticationPrincipal`**이 정석이다 — 위 구조를 프레임워크가 이미 제공한다(인증 필터가 검증·저장, `@AuthenticationPrincipal`이 주입용 리졸버). 커스텀 조합은 Security 미도입이거나 별도 토큰 체계일 때의 선택지.

## 6. 꼬리질문 대비 포인트

- **"인터셉터 없이 리졸버 혼자 다 하면?"** — 가능하지만, 검증 실패(401)가 파라미터 바인딩 단계에서 터져 책임이 섞이고, 사용자 파라미터가 없는 엔드포인트는 검증이 누락된다. 차단은 앞단, 주입은 바인딩 — 분리가 맞다.
- **"@RequestAttribute로 충분하지 않나?"** — `@RequestAttribute("loginUser")`로도 꺼낼 수는 있다. 커스텀 리졸버의 이득은 문자열 키 은닉, 타입 검사, null/미인증 처리 정책의 한 곳 집중.
- **"ThreadLocal 정리를 왜 afterCompletion에서?"** — preHandle에서 넣었다면 예외가 나도 반드시 실행되는 훅이 afterCompletion(뷰 렌더링·예외 포함 요청 종료 시점)이기 때문. postHandle은 핸들러 예외 시 건너뛴다.
- **"@Async 서비스에서 그 사용자 정보가 필요하면?"** — ThreadLocal은 새 스레드에 전파되지 않는다. 값을 파라미터로 명시 전달하거나 TaskDecorator로 복사(읽기용 컨텍스트만). @Async 풀은 톰캣 요청 스레드풀과 별개라서 생기는 현상이다(`async-annotation.md` 참조).
- **"인증을 필터에서 하면 안 되나? Security가 없어도?"** — 된다. 순수 서블릿 필터로 JWT를 검증하는 건 흔한 구현이고 "필터 = Security 전용"이 아니다. 갈리는 축은 셋 — ① 필터 예외는 `@ControllerAdvice`가 못 잡아 에러 포맷이 깨진다(`HandlerExceptionResolver` 주입으로 우회 가능), ② 인터셉터는 핸들러 매핑이 성공한 요청만 타므로 없는 URL은 401이 아니라 404가 나가 엔드포인트 존재가 노출된다, ③ 필터에는 `excludePathPatterns`가 없어 공개 엔드포인트 화이트리스트를 직접 구현해야 한다. 실무에서는 인증은 필터, 애너테이션 기반 인가는 인터셉터로 나누는 조합도 흔하다.
- **"인터셉터로는 못 하고 필터로만 되는 게 있나?"** — 요청/응답 객체 자체의 교체다. 필터는 `chain.doFilter(감싼요청, 감싼응답)`으로 래퍼를 다음 단계에 넘길 수 있고, 인터셉터는 이미 만들어진 요청을 받아 boolean만 리턴하므로 불가능하다. 요청 본문 로깅(`ContentCachingRequestWrapper`), XSS 파라미터 치환, 응답 압축이 전부 이 범주다.

## 한 줄 요약

반복되는 인증 코드는 "차단은 요청 앞단(preHandle에서 검증 후 request attribute에 저장), 주입은 커스텀 HandlerMethodArgumentResolver(@AuthUser 파라미터)"로 역할을 나눠 제거하고 — 앞단을 필터로 할지 인터셉터로 할지는 예외 처리 일관성·커버리지·경로 매칭 세 축으로 가르며(인증은 필터, 애너테이션 인가는 인터셉터로 또 나누는 조합도 흔하다), 전달 통로로 ThreadLocal을 쓴다면 스레드 풀 재사용 오염을 막기 위해 afterCompletion에서 반드시 remove(), Security가 이미 있다면 @AuthenticationPrincipal이 정석이다.
