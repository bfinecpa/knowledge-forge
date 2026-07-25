# 반복되는 인증 사용자 조회 제거 — 인터셉터 + 커스텀 ArgumentResolver

> 핵심 관전 포인트: 컨트롤러마다 반복되는 "토큰 추출→사용자 조회→검증" 코드는 **역할을 둘로 쪼개** 제거한다. **검증·차단은 인터셉터**(또는 Security 필터)가 요청 앞단에서 한 번, **컨트롤러에 사용자 객체를 넘겨주는 건 커스텀 `HandlerMethodArgumentResolver`**가 담당해 `@AuthUser LoginUser user` 파라미터로 주입한다. 둘 사이의 전달 통로는 기본적으로 `request.setAttribute`(요청 생명주기와 함께 소멸), ThreadLocal을 쓴다면 **`afterCompletion`에서 반드시 `remove()`** — 톰캣 스레드는 재사용되므로 안 지우면 다음 요청에 다른 사용자 정보가 남는 오염 사고가 난다.

## 0. 질문 + 의도

**질문**: "컨트롤러마다 반복되는 인증 사용자 조회/검증 코드를 어떻게 제거하나요? (커스텀 ArgumentResolver, 인터셉터)"

**출제 의도**: 컨트롤러마다 토큰 파싱·사용자 조회가 복붙되면 검증 누락 한 곳이 곧 보안 구멍이다. 횡단 관심사를 프레임워크 확장점으로 옮겨 "실수할 수 없는 구조"를 만드는지 — 프레임워크를 쓰는 수준을 넘어 확장하는 수준인지 본다.

## 1. 문제 — 수십 곳에 박제된 같은 코드

```java
// ❌ before: 모든 컨트롤러 메서드마다 반복
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
// ✅ after: 컨트롤러는 비즈니스 로직만
@GetMapping("/orders")
public List<Order> myOrders(@AuthUser LoginUser user) {
    return orderService.findByUser(user);
}
```

| 역할 | 담당 | 이유 |
|---|---|---|
| 토큰 검증·차단 (401) | 인터셉터 `preHandle` (또는 Security 필터) | 컨트롤러 진입 전에 한 번만, URL 패턴으로 적용 범위 제어 |
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
| 대표 사례 | 위 구현 | Spring Security의 `SecurityContextHolder`가 이 방식 ([[spring-security-filter-chain-authentication]] 참조) |
| 권장 | **기본값으로 권장** | 컨트롤러 밖(서비스 깊은 곳)에서도 사용자 정보가 필요할 때 |

**ThreadLocal의 함정**: 톰캣 스레드는 풀에서 **재사용**된다. `afterCompletion`에서 `remove()`를 빠뜨리면 다음 요청 — **다른 사용자** — 에 이전 사용자 정보가 남는다. 인증 도메인(IAM)에서는 데이터 유출로 직결되는 치명적 사고 유형. `@Async`로 스레드가 바뀌면 ThreadLocal이 전파되지 않는 것도 동일 계열 함정([[transaction-synchronization-connection-binding]] 참조).

## 5. 확장 지점 구분 — 무엇이 누구 소관인가

| 확장 지점 | 위치 | 소관 |
|---|---|---|
| Filter | 서블릿 컨테이너 (DispatcherServlet 앞) | 인증·로깅 등 스프링 MVC 무관 관심사, Security 필터 체인 |
| Interceptor | DispatcherServlet 안, 핸들러 앞뒤 | 핸들러 정보 접근 가능한 공통 검증·차단 |
| ArgumentResolver | 핸들러 호출 직전 파라미터 바인딩 | 컨트롤러 시그니처로 값 주입 |
| @ControllerAdvice | 핸들러 실행 후 | 예외 → 에러 응답 변환 (전역) |

**선택 근거 교정**: "인터셉터는 스프링 빈을 쓸 수 있어서"는 약한 근거다 — **필터도 빈으로 등록하면 주입받을 수 있다**. 인터셉터의 진짜 강점은 DispatcherServlet 안쪽이라 **핸들러(컨트롤러 메서드) 정보에 접근**할 수 있고 `addPathPatterns`로 적용 범위를 유연하게 제어한다는 것.

**Spring Security를 이미 쓰고 있다면**: 커스텀 인터셉터 대신 **필터 체인 + `SecurityContextHolder` + `@AuthenticationPrincipal`**이 정석이다 — 위 구조를 프레임워크가 이미 제공한다(인증 필터가 검증·저장, `@AuthenticationPrincipal`이 주입용 리졸버). 커스텀 조합은 Security 미도입이거나 별도 토큰 체계일 때의 선택지.

## 6. 꼬리질문 대비 포인트

- **"인터셉터 없이 리졸버 혼자 다 하면?"** — 가능하지만, 검증 실패(401)가 파라미터 바인딩 단계에서 터져 책임이 섞이고, 사용자 파라미터가 없는 엔드포인트는 검증이 누락된다. 차단은 앞단, 주입은 바인딩 — 분리가 맞다.
- **"@RequestAttribute로 충분하지 않나?"** — `@RequestAttribute("loginUser")`로도 꺼낼 수는 있다. 커스텀 리졸버의 이득은 문자열 키 은닉, 타입 검사, null/미인증 처리 정책의 한 곳 집중.
- **"ThreadLocal 정리를 왜 afterCompletion에서?"** — preHandle에서 넣었다면 예외가 나도 반드시 실행되는 훅이 afterCompletion(뷰 렌더링·예외 포함 요청 종료 시점)이기 때문. postHandle은 핸들러 예외 시 건너뛴다.
- **"@Async 서비스에서 그 사용자 정보가 필요하면?"** — ThreadLocal은 새 스레드에 전파되지 않는다. 값을 파라미터로 명시 전달하거나 TaskDecorator로 복사(읽기용 컨텍스트만).

## 한 줄 요약

반복되는 인증 코드는 "차단은 인터셉터(preHandle에서 검증 후 request attribute에 저장), 주입은 커스텀 HandlerMethodArgumentResolver(@AuthUser 파라미터)"로 역할을 나눠 제거하고 — 전달 통로로 ThreadLocal을 쓴다면 스레드 풀 재사용 오염을 막기 위해 afterCompletion에서 반드시 remove(), Security가 이미 있다면 @AuthenticationPrincipal이 정석이다.
