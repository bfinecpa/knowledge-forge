# 반복되는 인증 사용자 조회 제거 — 인터셉터 + 커스텀 ArgumentResolver

> 핵심 관전 포인트: **컨트롤러마다 반복되는 "토큰 추출 → 사용자 조회 → 검증" 코드는 역할을 둘로 쪼개 제거한다. 검증하고 차단하는 일은 요청 앞단(필터 또는 인터셉터)이 맡고, 컨트롤러 파라미터에 사용자 객체를 채워 넣는 일은 커스텀 `HandlerMethodArgumentResolver`가 맡는다. 이 분리가 취향이 아니라 필수인 이유는, 검증까지 리졸버에 넣으면 `@AuthUser` 파라미터가 없는 컨트롤러 메서드는 리졸버가 호출조차 되지 않아 검증을 통째로 건너뛰기 때문이다 — 인증이 "붙이면 되는 것"이 아니라 "빠뜨릴 수 없는 것"이 되게 만드는 구조가 출제 의도의 본체다. 앞단을 필터로 할지 인터셉터로 할지는 예외 처리 일관성·커버리지·경로 매칭 세 축으로 갈리고(`06-filter-vs-interceptor.md`), 전달 통로로 ThreadLocal을 쓴다면 톰캣 스레드가 재사용되므로 `afterCompletion`에서 반드시 `remove()`해야 다음 요청이 이전 사용자 정보를 보는 사고를 막는다. 스프링 시큐리티를 쓰고 있다면 `@AuthenticationPrincipal`이 이미 같은 구조를 제공한다는 것도 정직하게 짚어야 한다.**

---

## 0. 질문 + 의도

**질문**: "컨트롤러마다 반복되는 인증 사용자 조회/검증 코드를 어떻게 제거하나요? (커스텀 ArgumentResolver, 인터셉터)"

**출제 의도**: 컨트롤러마다 토큰 파싱·사용자 조회가 복붙되면 검증 누락 한 곳이 곧 보안 구멍이다. 횡단 관심사를 프레임워크 확장점으로 옮겨 "실수할 수 없는 구조"를 만드는지 — 프레임워크를 쓰는 수준을 넘어 확장하는 수준인지 본다.

## 1. 문제 — 수십 곳에 박제된 같은 코드

```java
// Before: 모든 컨트롤러 메서드마다 반복되는 네 줄
@GetMapping("/orders")
public List<Order> myOrders(@RequestHeader("Authorization") String token) {
    String userId = tokenParser.parse(token);          // ① 헤더에서 토큰을 꺼내 파싱
    LoginUser user = userService.findById(userId);     // ② 사용자 조회
    if (user == null || user.isLocked()) {             // ③ 검증
        throw new UnauthorizedException();
    }
    return orderService.findByUser(user);              // ④ 여기서부터가 진짜 로직
}
```

이 코드의 문제를 "중복이 있다"로만 보면 해결책도 얕아진다. 중복 제거가 아니라 **왜 이 중복이 위험한가**를 두 층으로 봐야 한다.

**첫째, 변경 비용이 곱해진다.** "잠긴 계정도 조회는 허용" 같은 정책이 하나 바뀌면 수십 곳을 고쳐야 한다.

**둘째, 그리고 이게 진짜 문제인데 — 빠뜨려도 아무 일도 일어나지 않는다.** 새 엔드포인트를 추가하면서 ①~③을 안 붙이면 컴파일 에러도, 테스트 실패도, 런타임 예외도 없다. 그냥 **인증 없이 잘 동작하는 API가 하나 생긴다.** 아무도 모르는 채로.

```text
인증을 "각 메서드에서 챙기는 것"으로 두면

  붙인 메서드   : 정상 동작 ✓
  빠뜨린 메서드 : 정상 동작 ✓   ← 구멍이 정상처럼 보인다
```

**실패가 눈에 보이지 않는 구조가 보안에서 가장 나쁜 구조다.** 그래서 목표는 "코드를 줄이는 것"이 아니라 **"빠뜨릴 자리를 없애는 것"**이 된다. 이 관점이 서야 3-1의 설계 논점이 이해된다.

목표 지점은 이 모양이다.

```java
// After: 컨트롤러에는 비즈니스 로직만 남는다
@GetMapping("/orders")
public List<Order> myOrders(@AuthUser LoginUser user) {
    return orderService.findByUser(user);
}
```

## 2. 확장점의 정체 — `HandlerMethodArgumentResolver`는 우리가 발명하는 물건이 아니다

`@AuthUser LoginUser user`라는 파라미터에 값이 어떻게 들어가는지를 이해하려면, **컨트롤러 메서드의 파라미터를 원래 누가 채우는가**를 먼저 알아야 한다. 이걸 모르면 커스텀 리졸버가 "마법 같은 특수 기능"으로 보이는데, 실제로는 정반대다.

### 2-1. 컨트롤러 파라미터는 누가 채우는가

컨트롤러 메서드는 평범한 자바 메서드다. 누군가 인자를 만들어서 넘겨줘야 실행된다.

```java
@GetMapping("/orders/{id}")
public Order get(@PathVariable Long id,
                 @RequestParam String sort,
                 @RequestBody OrderFilter filter,
                 HttpServletRequest request) { ... }
```

이 네 개의 값은 성격이 전부 다르다. URL 경로에서 뽑아야 하고, 쿼리 스트링에서 뽑아야 하고, 요청 본문 JSON을 Jackson으로 역직렬화해야 하고, 서블릿 객체를 그대로 넘겨야 한다. 스프링은 이 "파라미터 하나를 무엇으로 채울지"를 판단하고 실제로 채우는 일을 **`HandlerMethodArgumentResolver`라는 인터페이스에 위임한다.**

**`HandlerMethodArgumentResolver`는 컨트롤러 메서드의 파라미터 하나하나를 무엇으로 채울지 결정하고 실제 값을 만들어 내는 부품이다.** 이름을 뜯어보면 그대로다 — 핸들러 메서드(handler method)의 인자(argument)를 풀어내는(resolve) 자.

중요한 것은 이것이 우리를 위한 특별 확장 슬롯이 아니라, **스프링 MVC가 이미 자기 기능을 전부 이 인터페이스로 구현하고 있다**는 점이다.

| 애너테이션·타입 | 담당 구현체 |
|---|---|
| `@PathVariable` | `PathVariableMethodArgumentResolver` |
| `@RequestParam` | `RequestParamMethodArgumentResolver` |
| `@RequestBody` | `RequestResponseBodyMethodProcessor` |
| `@ModelAttribute` | `ServletModelAttributeMethodProcessor` |
| `HttpServletRequest` 등 | `ServletRequestMethodArgumentResolver` |
| `@AuthenticationPrincipal` (Security) | `AuthenticationPrincipalArgumentResolver` |
| **`@AuthUser` (우리가 만들 것)** | **`AuthUserArgumentResolver`** |

**즉 우리는 새로운 메커니즘을 만드는 것이 아니라, 스프링이 이미 쓰고 있는 확장점에 구현체를 하나 더 얹는 것이다.** `@RequestBody`가 동작하는 것과 `@AuthUser`가 동작하는 것은 완전히 같은 원리다. 이 관점이 서면 "커스텀 리졸버는 무겁고 위험한 기술"이라는 오해가 사라진다.

### 2-2. 파이프라인에서의 위치

`05-spring-mvc-request-flow.md`가 다루는 요청 파이프라인 안에서 리졸버가 언제 불리는지를 겹쳐 보면 위치가 정확해진다.

```text
① Filter                    서블릿 컨테이너 — 스프링 MVC 바깥
       ↓
② DispatcherServlet         프론트 컨트롤러
       ↓
③ HandlerMapping            "누가 처리할 컨트롤러 메서드인가" 탐색
       ↓
④ HandlerAdapter            "찾은 핸들러를 어떻게 실행하는가"
   ├─ ④-a Interceptor.preHandle    ← 검증·차단은 여기
   ├─ ④-b ArgumentResolver         ← 파라미터를 채우는 것은 여기
   ├─ ④-c 컨트롤러 메서드 실행
   ├─ ④-d ReturnValueHandler
   └─ ④-e Interceptor.postHandle
       ↓
⑤ 예외가 났다면 HandlerExceptionResolver
       ↓
⑥ 응답 직렬화 · ⑦ Interceptor.afterCompletion
```

`HandlerAdapter`가 "찾은 핸들러를 실행하는" 절차를 총괄하고, 그 절차의 한 단계가 인자 바인딩(④-b)이다. **인자 바인딩은 컨트롤러 진입 "전"에 끝난다** — 컨트롤러 메서드가 시작될 때는 이미 모든 파라미터가 채워져 있다. 이 사실이 3-1의 논점으로 이어진다.

### 2-3. 두 메서드가 각각 언제 불리는가

`HandlerMethodArgumentResolver`에는 메서드가 딱 둘이다.

```java
public interface HandlerMethodArgumentResolver {

    boolean supportsParameter(MethodParameter parameter);

    Object resolveArgument(MethodParameter parameter,
                           ModelAndViewContainer mavContainer,
                           NativeWebRequest webRequest,
                           WebDataBinderFactory binderFactory) throws Exception;
}
```

**`supportsParameter`는 "이 파라미터를 내가 담당하는가"를 답한다.** 스프링은 등록된 리졸버들을 순서대로 돌면서 이 메서드에 물어보고, **`true`를 답한 첫 번째 리졸버**에게 그 파라미터를 맡긴다. 즉 순서가 이르면 이긴다.

**`resolveArgument`는 실제 값을 만들어 반환한다.** 여기서 반환한 객체가 그대로 컨트롤러 메서드의 인자로 들어간다.

여기서 정확히 알아 둘 동작이 하나 있다. **`supportsParameter`의 결과는 캐싱된다.**

```text
[첫 요청 — /orders]
  파라미터 (myOrders 메서드의 0번 인자)에 대해
    리졸버 목록을 순회하며 supportsParameter 호출
    → AuthUserArgumentResolver가 true
    → 이 (메서드, 인자 번호) 조합의 담당자로 기록해 둔다

[두 번째 요청부터 — /orders]
  기록된 담당자를 바로 꺼내 쓴다 → supportsParameter는 호출되지 않는다
  resolveArgument만 매 요청 호출된다
```

스프링 MVC 내부에서 여러 리졸버를 묶어 관리하는 `HandlerMethodArgumentResolverComposite`가 `MethodParameter`를 키로 하는 맵에 "이 파라미터는 이 리졸버 담당"을 기억해 두기 때문이다. `MethodParameter`는 메서드와 인자 인덱스로 동등성이 정해지므로 요청마다 새 객체가 만들어져도 같은 자리로 취급된다.

**이 사실에서 따라 나오는 규칙이 중요하다.**

```java
// 문제: supportsParameter가 요청 내용에 따라 다른 답을 하려고 한다
@Override
public boolean supportsParameter(MethodParameter p) {
    // 첫 요청의 판정 결과가 캐싱되므로 두 번째 요청부터는 이 코드가 아예 안 돈다.
    // 관리자 요청이 먼저 들어왔다면 이후 모든 요청이 "관리자용 리졸버" 담당이 된다.
    return p.hasParameterAnnotation(AuthUser.class) && currentRequestIsAdmin();
}
```

```java
// 고침: supportsParameter는 "파라미터의 생김새"만 보고 판정한다.
//       요청마다 달라지는 판단은 전부 resolveArgument 쪽에 둔다.
@Override
public boolean supportsParameter(MethodParameter p) {
    return p.hasParameterAnnotation(AuthUser.class)
        && p.getParameterType().equals(LoginUser.class);
}
```

**`supportsParameter`는 파라미터의 정적 생김새(애너테이션, 타입)만 보는 순수 판정이어야 하고, 요청마다 달라지는 것은 `resolveArgument`에서 다뤄야 한다.** 캐싱을 모르면 "왜 가끔만 동작하지?" 하는 재현 안 되는 버그가 된다.

타입까지 함께 검사하는 이유도 짚어 두자. 애너테이션만 보고 `true`를 반환하면, 누군가 `@AuthUser String userId`라고 적었을 때 우리 리졸버가 `LoginUser` 객체를 만들어 `String` 자리에 넣으려다 런타임에 터진다. 타입이 다르면 아예 담당하지 않겠다고 답하는 편이 오류가 명확해진다.

### 2-4. 등록 위치와 순서

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new AuthUserArgumentResolver());
    }
}
```

여기 추가한 리졸버는 **스프링의 기본 리졸버들 뒤, 그리고 맨 끝의 포괄 리졸버 앞**에 놓인다. 포괄 리졸버란 "애너테이션이 없는 단순 타입은 `@RequestParam`으로 간주"처럼 아무거나 받아 주는 마지막 후보들이다.

이 배치가 실무에서 무슨 뜻인지가 중요하다.

- **기본 리졸버가 이미 담당하는 모양은 뺏어 올 수 없다.** 예를 들어 `@RequestBody`가 붙은 파라미터는 우리 차례가 오기 전에 이미 담당자가 정해진다.
- **반대로 포괄 리졸버에 잡히기 전에 우리가 먼저 잡는다.** `@AuthUser LoginUser user`는 기본 리졸버 중 아무도 담당하지 않으므로 우리에게 오고, 만약 우리 리졸버가 없었다면 맨 끝의 `@ModelAttribute` 포괄 처리로 넘어가 **쿼리 파라미터로 `LoginUser`를 조립하려 드는** 엉뚱한 동작이 된다.

담당할 리졸버가 하나도 없으면 스프링은 요청 처리 중에 "적절한 리졸버가 없다"는 예외를 던진다. 조용히 `null`이 들어가는 것이 아니라 명시적으로 실패한다는 점은 다행이다. 다만 `resolveArgument`가 `null`을 반환하는 경우는 그대로 `null`이 인자로 들어가므로, 이건 우리가 책임져야 한다(3-1 참고).

## 3. 설계 — 역할을 나누고, 전달 통로를 고른다

### 3-1. 왜 검증을 리졸버에 두면 안 되는가 — 이 문서의 설계 논점

리졸버가 사용자 객체를 만들 수 있다면, 굳이 인터셉터를 따로 두지 말고 **리졸버 안에서 검증까지 끝내면 되지 않나?** 코드가 한 곳으로 모이니 더 단순해 보인다.

```java
// 문제: 검증까지 리졸버가 한다
public class AuthUserArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter p) {
        return p.hasParameterAnnotation(AuthUser.class);
    }

    @Override
    public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav,
                                  NativeWebRequest req, WebDataBinderFactory bf) {
        String token = req.getHeader("Authorization");
        LoginUser user = authService.verify(token);   // 검증도 여기서
        if (user == null) throw new UnauthorizedException();
        return user;
    }
}
```

동작은 한다. 그런데 **인증이 걸리는 조건이 "그 컨트롤러 메서드에 `@AuthUser` 파라미터가 있는가"로 바뀌어 버린다.** 2-2에서 확인했듯 리졸버는 **파라미터를 채우기 위해** 호출되는 부품이므로, 채울 파라미터가 없으면 애초에 호출되지 않는다.

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping                      // @AuthUser 있음 → 리졸버 호출됨 → 검증됨
    public List<Order> myOrders(@AuthUser LoginUser user) {
        return orderService.findByUser(user);
    }

    @DeleteMapping("/{id}")          // @AuthUser 없음 → 리졸버가 호출조차 안 됨
    public void cancel(@PathVariable Long id) {
        orderService.cancel(id);     // 토큰 없이도 남의 주문이 취소된다
    }
}
```

```text
GET    /api/orders          Authorization 헤더 없음 → 401  ✓
DELETE /api/orders/1234     Authorization 헤더 없음 → 200  ✗  ← 무인증 통과
```

**같은 컨트롤러 안에서도 메서드마다 인증이 걸렸다 안 걸렸다 한다.** 그리고 1절에서 본 최악의 성질이 그대로 돌아온다 — 구멍이 정상처럼 보인다. 리졸버로 인증을 옮긴 것은 "각 메서드에서 챙기는 구조"를 **"각 메서드가 파라미터를 선언했는지에 달린 구조"**로 바꾼 것일 뿐, 빠뜨릴 자리를 없애지 못했다.

여기서 원리를 하나 뽑아낼 수 있다.

> **차단은 "모든 요청이 반드시 지나가는 자리"에 있어야 하고, 주입은 "값이 필요한 곳"에 있으면 된다.**

리졸버는 후자의 자리다. 앞단(필터·인터셉터)은 경로 패턴으로 적용 범위가 정해지므로 **컨트롤러 메서드의 시그니처와 무관하게** 모든 요청을 통과시킨다. 그래서 역할은 이렇게 갈린다.

| 역할 | 담당 | 이유 |
|---|---|---|
| 토큰 검증·차단 (401) | 인터셉터 `preHandle` 또는 필터 | 컨트롤러 진입 전에 한 번만, 경로 패턴으로 적용 범위를 제어한다. 메서드 시그니처와 무관하게 걸린다 |
| 사용자 객체를 파라미터로 주입 | `HandlerMethodArgumentResolver` | 인터셉터는 컨트롤러 메서드에 값을 직접 넘길 수 없다 — 파라미터 바인딩은 리졸버의 소관이다 |

그리고 이 분리를 하고 나면 리졸버 쪽 코드가 오히려 단순해진다. **앞단이 통과시킨 요청만 여기 도달하므로, 리졸버는 "사용자 정보가 이미 있다"를 전제로 꺼내기만 하면 된다.**

다만 전제가 깨졌을 때의 처리는 남겨 둔다. 앞단 경로 패턴에서 빠진 URL이 있으면 리졸버가 `null`을 만나는데, 이때 조용히 `null`을 넘기면 컨트롤러 깊은 곳에서 `NullPointerException`이 나서 원인 추적이 어렵다.

```java
@Override
public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav,
                              NativeWebRequest req, WebDataBinderFactory bf) {
    Object user = req.getAttribute(LOGIN_USER, RequestAttributes.SCOPE_REQUEST);
    if (user == null) {
        // 여기 도달했다는 것은 "인증 앞단을 안 거친 경로에 @AuthUser를 붙였다"는
        // 설정 실수라는 뜻이다. null을 넘겨 컨트롤러에서 NPE가 나게 두는 대신
        // 원인을 이름으로 말해 주는 예외로 즉시 실패시킨다.
        throw new IllegalStateException(
                "인증 앞단을 거치지 않은 요청에 @AuthUser가 사용됐다: " + p.getMethod());
    }
    return user;
}
```

**빠뜨릴 자리를 없애고, 그래도 어긋나면 시끄럽게 실패하게 만드는 것** — 이 두 겹이 "실수할 수 없는 구조"의 실제 모습이다.

### 3-2. 구현 — 네 조각

```java
// 1) 마커 애너테이션 — 이 파라미터가 인증 사용자 자리임을 표시한다.
//    RUNTIME 유지가 필수다. 리플렉션으로 런타임에 읽어야 하기 때문이다.
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface AuthUser {}
```

```java
// 2) 인터셉터 — 검증하고, 통과한 요청에 사용자 정보를 실어 둔다.
public class AuthInterceptor implements HandlerInterceptor {

    public static final String LOGIN_USER = AuthInterceptor.class.getName() + ".LOGIN_USER";

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        // 검증 실패는 여기서 예외로 끝낸다 — 컨트롤러는 시작조차 되지 않는다.
        LoginUser user = authService.verify(req.getHeader("Authorization"));

        // 리졸버가 꺼내 갈 수 있도록 요청에 실어 둔다.
        // 키를 상수로 두는 이유: 문자열을 양쪽에 손으로 적으면 오타가 나도
        // 컴파일 에러가 없고, 리졸버가 조용히 null을 받게 된다.
        req.setAttribute(LOGIN_USER, user);
        return true;   // false를 반환하면 이후 단계가 실행되지 않는다
    }
}
```

```java
// 3) 리졸버 — 실어 둔 것을 꺼내 파라미터로 넘긴다.
public class AuthUserArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter p) {
        // 2-3에서 본 대로 정적 생김새만 본다. 이 판정은 캐싱된다.
        return p.hasParameterAnnotation(AuthUser.class)
            && p.getParameterType().equals(LoginUser.class);
    }

    @Override
    public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav,
                                  NativeWebRequest req, WebDataBinderFactory bf) {
        Object user = req.getAttribute(AuthInterceptor.LOGIN_USER, RequestAttributes.SCOPE_REQUEST);
        if (user == null) {
            throw new IllegalStateException(
                    "인증 앞단을 거치지 않은 요청에 @AuthUser가 사용됐다: " + p.getMethod());
        }
        return user;
    }
}
```

```java
// 4) 등록 — 둘 다 WebMvcConfigurer에서 붙인다.
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new AuthInterceptor())
                .addPathPatterns("/api/**")                 // 기본은 전부 차단
                .excludePathPatterns("/api/auth/**", "/api/health");  // 공개 경로만 예외
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new AuthUserArgumentResolver());
    }
}
```

`addPathPatterns`를 넓게 걸고 `excludePathPatterns`로 예외를 파는 **방향**이 중요하다. 3-5에서 다시 다룬다.

### 3-3. 전달 통로 — request attribute vs ThreadLocal

앞단에서 만든 사용자 정보를 리졸버까지 어떻게 전달하는가. 두 가지 통로가 있고, 성질이 정반대다.

| | `request.setAttribute` | ThreadLocal |
|---|---|---|
| 수명 | 요청 객체와 함께 사라진다 — 뒤처리 불요 | **직접 정리해야 한다** |
| 꺼내는 곳 | 리졸버의 `NativeWebRequest`에서 바로 | 어디서든 static 접근 |
| 도달 범위 | 요청 객체를 들고 있는 곳까지 | 같은 스레드라면 서비스 깊은 곳까지 |
| 대표 사례 | 위 구현 | 스프링 시큐리티의 `SecurityContextHolder` |
| 권장 | **기본값으로 권장** | 컨트롤러 밖에서도 사용자 정보가 꼭 필요할 때 |

**request attribute를 기본값으로 두는 이유는 수명 관리가 필요 없다는 것 하나로 충분하다.** 요청이 끝나면 요청 객체가 버려지고 그 안의 attribute도 함께 사라진다. 개발자가 지울 일이 없으니 지우는 것을 잊을 일도 없다.

**ThreadLocal은 편의를 주는 대신 정리 책임을 떠넘긴다.** ThreadLocal이 편한 이유는 파라미터로 넘기지 않아도 어느 계층에서든 `AuthContext.currentUser()`로 꺼낼 수 있기 때문이다. 서비스 열 겹 아래에서 사용자 정보가 필요할 때 메서드 시그니처를 전부 고치지 않아도 된다.

그런데 여기에 치명적인 함정이 있다. **톰캣 스레드는 요청이 끝나도 죽지 않고 풀로 돌아가 재사용된다.** ThreadLocal에 담긴 값은 스레드에 붙어 있으므로, 지우지 않으면 **다음 요청이 그 값을 그대로 본다.**

```text
[정리를 빠뜨렸을 때 — 톰캣 스레드 #7의 시간 흐름]

t0   요청 A 도착 (사용자 alice)  → 스레드 #7 배정
t1   preHandle: AuthContext.set(alice)      스레드 #7 ┃ alice
t2   컨트롤러 실행 → 응답 완료
t3   스레드 #7이 풀로 반납된다               스레드 #7 ┃ alice  ← 값이 그대로 남아 있다
     (스레드가 죽지 않으므로 ThreadLocal도 살아 있다)

t4   요청 B 도착 (토큰이 없거나, 다른 사용자 bob) → 스레드 #7 재배정
t5   ★ 앞단이 값을 덮어쓰기 전에 무언가가 AuthContext.currentUser()를 읽으면
     → alice가 반환된다
     → bob이 alice의 데이터를 보거나, 비로그인 요청이 alice로 인증된다
```

인증 도메인에서는 이것이 **데이터 유출로 직결되는 사고 유형**이다. 그리고 재현이 어렵다 — 스레드 풀이 여유로운 개발 환경에서는 같은 스레드가 재사용되는 일이 드물고, 트래픽이 있는 운영에서만 터진다.

```java
// 고침: 요청이 어떻게 끝나든 반드시 지운다
public class AuthInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        AuthContext.set(authService.verify(req.getHeader("Authorization")));
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest req, HttpServletResponse res,
                                Object handler, Exception ex) {
        // postHandle이 아니라 afterCompletion인 이유:
        // postHandle은 핸들러에서 예외가 나면 건너뛴다. 그러면 예외가 난 요청의
        // 값이 스레드에 남아 다음 요청으로 새어 나간다.
        // afterCompletion은 예외 발생 시에도, 뷰 렌더링 후에도 반드시 실행된다.
        AuthContext.clear();   // 내부적으로 threadLocal.remove()
    }
}
```

`set(null)`이 아니라 `remove()`를 부르는 것도 이유가 있다. `set(null)`은 스레드의 맵에 "null이라는 값"을 남겨 두는 것이라 엔트리 자체는 살아 있고, 스레드 풀이 오래 유지되는 환경에서 누적되면 메모리 누수의 원인이 된다. `remove()`는 엔트리를 제거한다.

같은 계열의 함정이 하나 더 있다. **`@Async`로 스레드가 바뀌면 ThreadLocal은 전파되지 않는다.** 비동기 메서드는 별도 스레드 풀에서 실행되므로 요청 스레드의 ThreadLocal을 볼 수 없고, 값을 파라미터로 명시 전달하거나 `TaskDecorator`로 복사해 넘겨야 한다. ThreadLocal의 저장 구조와 스레드 풀 환경의 위험 전반은 `01-java-kotlin/16-threadlocal-thread-pool-risks.md`가 본론이고, 요청 스레드에 묶이는 다른 자원(트랜잭션·커넥션)의 이야기는 `24-transaction-synchronization-connection-binding.md`로 이어진다.

### 3-4. 앞단을 필터로 할까 인터셉터로 할까

"인터셉터 또는 필터"라는 병렬 표현은 **필터 = 시큐리티 전용**이라는 오해를 부르기 쉽다. 순수 서블릿 필터로 JWT를 검증하는 구현은 흔하고 정당하다. 둘 다 가능하고, 실제로 갈리는 지점은 셋뿐이다.

| | 필터 | 인터셉터 |
|---|---|---|
| 예외 → 에러 응답 | `@ControllerAdvice`가 **못 잡는다** (DispatcherServlet 바깥) | 잡힌다 — 기존 예외 처리 체계 그대로 |
| 커버리지 | 정적 리소스·404·다른 서블릿까지 **전부** 지나간다 | DispatcherServlet이 **핸들러를 찾은 요청만** |
| 경로 매칭 | 서블릿 스펙(`/api/*`, `*.json`) — **제외라는 개념이 없다** | `addPathPatterns` / `excludePathPatterns` |

이 세 축이 왜 그렇게 갈리는지(소속이 다르면 아는 것과 할 수 있는 것이 다르다)의 본론은 `06-filter-vs-interceptor.md`에 있다. 여기서는 **인증을 어디에 둘 것인가**라는 관점에서 필요한 만큼만 본다.

#### 필터 인증의 최대 불편 — 에러 포맷이 깨진다

필터에서 `throw new UnauthorizedException()`을 해도 `@RestControllerAdvice`의 핸들러를 타지 않는다. 부트 기본 `/error` 응답이 나가 버려서 팀이 정한 `{"code":"AUTH_001", ...}` 포맷을 못 맞춘다. 클라이언트 입장에서는 인증 실패만 응답 모양이 다른 셈이다.

응답을 손으로 조립할 수도 있지만, 더 나은 우회법은 **`HandlerExceptionResolver`를 주입받아 직접 호출**하는 것이다. 필터에서 던진 예외를 기존 `@ExceptionHandler` 체계에 그대로 얹을 수 있다.

```java
public class JwtAuthFilter extends OncePerRequestFilter {

    private final HandlerExceptionResolver resolver;   // 부트가 등록한 것을 빌려 쓴다

    public JwtAuthFilter(@Qualifier("handlerExceptionResolver") HandlerExceptionResolver resolver) {
        // 이름을 지정해야 정확히 그 빈이 주입된다.
        // HandlerExceptionResolver 타입 빈이 여러 개라 타입만으로는 특정되지 않는다.
        this.resolver = resolver;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        try {
            req.setAttribute(AuthInterceptor.LOGIN_USER,
                    authService.verify(req.getHeader("Authorization")));
            chain.doFilter(req, res);
        } catch (AuthException e) {
            resolver.resolveException(req, res, null, e);   // @ExceptionHandler를 태운다
        }
    }
}
```

#### 반대로 필터가 유리한 지점 — 엔드포인트 존재 노출

인터셉터는 **핸들러 매핑이 성공한 요청만** 탄다. 존재하지 않는 URL은 `preHandle`이 불리지 않고 곧장 404가 나간다.

```text
[인터셉터로 인증]
  GET /api/orders          (있는 URL, 토큰 없음)  → 401
  GET /api/secret-admin    (없는 URL, 토큰 없음)  → 404
  → 응답 코드의 차이만으로 "이 경로가 존재하는지"를 토큰 없이 알아낼 수 있다 (엔드포인트 열거)

[필터로 인증]
  GET /api/orders          → 401
  GET /api/secret-admin    → 401
  → 존재 여부와 무관하게 같은 응답. 아무것도 알아낼 수 없다.
```

노출도까지 통제해야 하는 API라면 이 차이가 실제 의미를 갖는다.

#### 인터셉터만 할 수 있는 것 — 핸들러 정보 접근

필터는 URL 문자열밖에 못 본다. 그래서 "이 URL은 ADMIN만" 같은 규칙을 **URL → 권한 매핑 테이블로 필터 안에 따로** 들고 있어야 한다.

```java
// Before: 필터 — 정책이 컨트롤러에서 멀리 떨어져 산다
private static final Map<String, String> URL_ROLES = Map.of(
    "/api/admin/**",        "ADMIN",
    "/api/orders/*/cancel", "MANAGER",
    "/api/settlements/**",  "FINANCE"
);
```

```java
// After: 인터셉터 — 정책이 핸들러에 붙어 있어 경로를 바꿔도 따라온다
@RequiresRole("MANAGER")
@PostMapping("/orders/{id}/cancel")
public void cancel(@PathVariable Long id) { ... }
```

Before의 진짜 문제는 중복이 아니다. **컨트롤러의 `@PostMapping` 경로를 바꾸는 순간 이 표가 조용히 틀어진다**는 것이다. 컴파일 에러도 안 나고 테스트가 없으면 아무도 모르는 채로 권한 검사가 통째로 빠진다 — **URL 리네이밍이 곧 인가 구멍**이 되는 구조다. 1절에서 본 "실패가 보이지 않는 구조"가 여기서 다시 나온다. 인터셉터는 핸들러에서 애너테이션을 직접 읽으므로 그 연결이 끊어질 수 없다.

```java
@Override
public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
    // 정적 리소스 등은 HandlerMethod가 아니다 — 여기서 걸러야 아래에서 캐스팅 오류가 안 난다.
    if (!(handler instanceof HandlerMethod hm)) return true;

    RequiresRole ann = hm.getMethodAnnotation(RequiresRole.class);
    if (ann == null) ann = hm.getBeanType().getAnnotation(RequiresRole.class);  // 클래스 단위도 지원
    if (ann != null && !currentUser(req).hasRole(ann.value())) {
        throw new ForbiddenException();   // @ControllerAdvice가 받아 준다
    }
    return true;
}
```

같은 원리로 파생되는 것들이 있다.

- **`@RateLimit(perMinute = 10)`** — 엔드포인트마다 다른 한도를 메서드 옆에 선언한다.
- **`@Idempotent`** — 이 애너테이션이 붙은 핸들러에서만 `Idempotency-Key` 헤더를 검사한다.
- **메트릭 카디널리티** — URL로 태깅하면 `/orders/1`, `/orders/2`가 전부 다른 시계열이 되어 폭발한다. `hm.getBeanType().getSimpleName() + "#" + hm.getMethod().getName()`으로 태깅하면 `OrderController#get` 하나로 수렴한다. 필터는 `{id}`가 무엇으로 치환됐는지 모르니 이걸 할 수 없다.

#### 필터만 할 수 있는 것 — 요청/응답 객체 교체

필터는 `chain.doFilter(감싼요청, 감싼응답)`으로 **다음 단계에 다른 객체를 넘길 수 있고**, 인터셉터는 그게 불가능하다(이미 만들어진 요청을 받아 `boolean`만 반환한다). 그래서 이건 필터밖에 못 한다.

```java
// 요청 본문을 두 번 읽으려면 (로깅 + 컨트롤러의 @RequestBody) — 필터만 가능
var wrapped = new ContentCachingRequestWrapper(req);
chain.doFilter(wrapped, res);
log.info("body={}", new String(wrapped.getContentAsByteArray()));
```

`InputStream`은 한 번만 읽히므로, 감싸서 교체하지 않으면 로깅한 순간 컨트롤러의 `@RequestBody`가 빈 본문을 받는다. XSS 파라미터 치환, 응답 압축도 전부 이 범주다.

#### 판단 기준 — 질문 네 개로 갈린다

```text
① 요청/응답 객체 자체를 바꿔치기해야 하나?  ── YES ─▶ 필터 (인터셉터는 구조적으로 불가능)
② 스프링 MVC 밖의 요청까지 적용돼야 하나?    ── YES ─▶ 필터
③ "어느 컨트롤러 메서드인지" 알아야 하나?    ── YES ─▶ 인터셉터
④ 기존 예외 처리 체계에 태우고 싶은가?       ── YES ─▶ 인터셉터
```

| 필터가 맞는 기능 | 인터셉터가 맞는 기능 |
|---|---|
| 문자 인코딩, CORS, gzip | 애너테이션 기반 인가 (`@RequiresRole`) |
| 요청/응답 본문 로깅 (래핑 필요) | 핸들러 단위 처리 시간·메트릭 |
| XSS 파라미터 치환 (래핑 필요) | `@Idempotent` 중복 요청 차단 |
| trace id(MDC) 생성 — 정적 리소스 로그까지 커버 | `postHandle`에서 공통 모델 값 추가 |
| 시큐리티 인증·인가 | 세션 로그인 체크, 화면 단위 접근 제어 |

**선택 근거 교정**: "인터셉터는 스프링 빈을 쓸 수 있어서"는 약한 근거다 — **필터도 빈으로 등록하면 주입받을 수 있다.** 진짜 근거는 위의 세 축(예외 처리 일관성 · 커버리지 · 경로 매칭)이다.

### 3-5. 경로 설정의 방향이 안전을 결정한다

서블릿 필터의 `url-pattern`은 세 형태만 지원한다 — 완전 일치(`/api/login`), 경로 접두(`/api/*`), 확장자(`*.json`). **제외(exclude)라는 개념 자체가 없다.** 그런데 실무의 인증 설정은 거의 항상 "전부 막고 몇 개만 연다" 모양이다.

```java
registry.addInterceptor(authInterceptor)
        .addPathPatterns("/api/**")                       // 기본은 전부 차단
        .excludePathPatterns(
            "/api/auth/login", "/api/auth/signup",        // 공개 엔드포인트만 예외
            "/api/health", "/api/docs/**")
        .order(1);
```

필터로 하면 이 화이트리스트를 필터 코드 안에서 `AntPathMatcher`로 직접 굴려야 한다. 스프링 시큐리티의 `permitAll()`이 제공하는 게 정확히 이 기능이다. **시큐리티 없이 필터로 인증하겠다면 결국 이 경로 매칭 로직을 손으로 만들게 된다.**

**그런데 문법보다 중요한 것은 방향이다.**

```text
[방향 ①] "전부 차단 + 공개 경로만 예외"   ← 안전한 방향
   새 API를 추가하면 → 자동으로 인증이 걸린다
   실수하면 → 401 장애로 즉시 드러난다 (시끄럽게 실패)

[방향 ②] "이 URL들만 인증"                ← 위험한 방향
   새 API를 추가하면 → 조용히 인증이 빠진다
   실수하면 → 아무 일도 안 일어난다 (1절의 보이지 않는 구멍)
```

**실패가 안전한 쪽으로 기울게 설계하는 것**이 핵심이고, 이 문서 전체를 관통하는 원칙이기도 하다.

패턴 문법 자체도 인터셉터 쪽이 훨씬 세다 — `/api/v1/orders/*`(한 세그먼트), `/api/**`(나머지 전부), `/api/{version}/users/**`(변수). 단 부트 3부터 `PathPatternParser`가 기본이라 `**`는 패턴 맨 끝에만 올 수 있다. 여러 인터셉터가 각기 다른 범위와 순서를 갖는 것도 자연스럽다.

```java
registry.addInterceptor(localeInterceptor).addPathPatterns("/**").order(0);
registry.addInterceptor(authInterceptor).addPathPatterns("/api/**").order(1);
registry.addInterceptor(auditInterceptor).addPathPatterns("/api/admin/**").order(2);
```

### 3-6. 정리 — 그래서 인증은 어디에 두나

| 상황 | 선택 |
|---|---|
| 스프링 시큐리티 도입 | 필터 체인 + `@AuthenticationPrincipal` — 프레임워크가 이미 제공한다 |
| 시큐리티 미도입, 일반 REST API | **인터셉터** — 에러 응답 포맷 일관성과 `excludePathPatterns`의 이득이 크다 |
| 시큐리티 미도입, 엔드포인트 존재 노출까지 막아야 함 | **필터** + `HandlerExceptionResolver` 주입 |
| 인증은 앞단, 인가는 애너테이션 | **필터(인증) + 인터셉터(인가)** — 실무에서 흔한 조합 |

마지막 줄이 핵심이다. 둘은 택일이 아니라 **역할을 한 번 더 나눌 수 있다.** "이 사람이 누구인가"(신원 확인, 모든 요청)는 필터가, "이 사람이 이걸 해도 되는가"(핸들러별 권한)는 인터셉터가 맡는다. 3-1의 "차단은 앞단, 주입은 리졸버" 분리를 3단으로 넓힌 형태다.

### 3-7. 스프링 시큐리티를 쓴다면 — `@AuthenticationPrincipal`이 이미 같은 일을 한다

여기까지 만든 구조를 스프링 시큐리티는 이미 갖고 있다. 이 사실을 정직하게 짚는 것이 면접에서도 실무에서도 옳다.

| 우리가 만든 것 | 시큐리티의 대응물 |
|---|---|
| `AuthInterceptor` (검증·차단) | 인증 필터 체인 (`UsernamePasswordAuthenticationFilter` 등) |
| `request.setAttribute` / ThreadLocal | `SecurityContextHolder` (ThreadLocal 기반) |
| `@AuthUser` + `AuthUserArgumentResolver` | `@AuthenticationPrincipal` + `AuthenticationPrincipalArgumentResolver` |

```java
// 시큐리티를 쓰고 있다면 이게 정석이다 — 리졸버를 따로 만들 이유가 없다
@GetMapping("/orders")
public List<Order> myOrders(@AuthenticationPrincipal CustomUserDetails user) {
    return orderService.findByUser(user.getId());
}
```

**그럼에도 커스텀 리졸버를 만드는 경우는 두 가지다.**

**(1) 스프링 시큐리티를 쓰지 않는 경우.** 사내 게이트웨이가 이미 인증을 끝내고 헤더로 사용자 ID만 넘겨주는 구조, 또는 자체 토큰 체계를 쓰는 서비스라면 시큐리티 전체를 들이는 것이 과할 수 있다. 이때 필요한 것은 이 문서의 조합이다.

**(2) 시큐리티는 쓰지만 도메인 사용자 객체로 변환이 필요한 경우.** `SecurityContextHolder`에 들어 있는 것은 `UserDetails`(또는 JWT 클레임)이지 우리 도메인의 `Member` 엔티티가 아니다. 컨트롤러가 도메인 객체를 받고 싶다면 변환 지점이 필요하고, 그 자리가 리졸버다.

```java
// 시큐리티 위에 얹는 커스텀 리졸버 — 검증은 시큐리티가 이미 끝냈고,
// 여기서는 인증 주체를 우리 도메인 객체로 바꾸는 일만 한다.
@Override
public Object resolveArgument(MethodParameter p, ModelAndViewContainer mav,
                              NativeWebRequest req, WebDataBinderFactory bf) {
    var principal = (CustomUserDetails) SecurityContextHolder.getContext()
            .getAuthentication().getPrincipal();
    return memberRepository.findById(principal.getId()).orElseThrow();
}
```

이때도 3-1의 원칙은 그대로다. **검증은 여전히 시큐리티 필터 체인이 하고, 리졸버는 변환만 한다.** 시큐리티 필터 체인의 구조와 인증 흐름은 `31-spring-security-filter-chain-authentication.md`가 본론이다.

한 가지 더 정직하게 말할 것이 있다. 커스텀 조합을 선택할 때는 **"시큐리티가 이미 해결해 둔 문제를 우리가 다시 풀게 된다"는 비용**을 계산에 넣어야 한다. 경로 화이트리스트, CSRF, 세션 고정 공격 방어, 인가 애너테이션(`@PreAuthorize`), 익명 사용자 처리 같은 것들이 전부 직접 만들어야 할 목록에 올라온다.

## 4. 꼬리질문 대비 포인트

### "`HandlerMethodArgumentResolver`가 정확히 뭔가요?"

**컨트롤러 메서드의 파라미터 하나하나를 무엇으로 채울지 결정하고 실제 값을 만들어 내는 부품**이다. 컨트롤러 메서드도 평범한 자바 메서드라 누군가 인자를 만들어 넘겨야 실행되는데, 그 일을 스프링이 이 인터페이스에 위임한다.

여기서 관점 하나를 반드시 얹어야 한다. **이건 우리를 위한 특별 확장 슬롯이 아니라 스프링 MVC가 자기 기능을 구현하는 데 이미 쓰고 있는 인터페이스다.** `@PathVariable`은 `PathVariableMethodArgumentResolver`, `@RequestParam`은 `RequestParamMethodArgumentResolver`, `@RequestBody`는 `RequestResponseBodyMethodProcessor`가 담당한다. 즉 우리는 새 메커니즘을 만드는 것이 아니라 **이미 돌아가는 확장점에 구현체를 하나 더 얹는 것**이다.

파이프라인 위치까지 말하면 완성된다. `HandlerAdapter`가 핸들러 실행 절차를 총괄하고, 그 안의 인자 바인딩 단계가 리졸버의 자리다. **인자 바인딩은 컨트롤러 진입 전에 끝난다.**

### "`supportsParameter`와 `resolveArgument`는 각각 언제 불리나요?" (시니어 변별 포인트)

`supportsParameter`는 "이 파라미터를 내가 담당하는가"를 답하고, 스프링은 등록된 리졸버를 순서대로 물어 **`true`를 답한 첫 번째 리졸버**에게 그 파라미터를 맡긴다. `resolveArgument`는 실제 값을 만들어 반환하고, 그 반환값이 컨트롤러 인자로 들어간다.

**정확히 답해야 하는 지점은 호출 빈도다. `supportsParameter`의 결과는 캐싱된다.** 여러 리졸버를 묶는 `HandlerMethodArgumentResolverComposite`가 `MethodParameter`를 키로 "이 파라미터는 이 리졸버 담당"을 기억하기 때문에, 같은 (메서드, 인자 번호) 조합에 대해서는 사실상 첫 요청에만 호출된다. `resolveArgument`는 매 요청 호출된다.

여기서 실무 규칙이 나온다. **`supportsParameter`는 파라미터의 정적 생김새(애너테이션·타입)만 보는 순수 판정이어야 한다.** 요청 내용을 보고 판정을 바꾸려 하면 첫 요청의 결과가 굳어져 "가끔만 동작하는" 재현 불가 버그가 된다.

타입까지 함께 검사하라는 것도 덧붙이면 좋다. 애너테이션만 보면 `@AuthUser String userId` 같은 오용에서 엉뚱한 타입을 넣으려다 런타임에 터진다.

### "인터셉터 없이 리졸버 혼자 검증까지 다 하면 안 되나요?" (시니어 변별 포인트)

**안 된다. 그리고 그 이유가 이 질문의 핵심이다.**

리졸버는 **파라미터를 채우기 위해** 호출되는 부품이다. 채울 파라미터가 없으면 애초에 호출되지 않는다. 그래서 검증을 리졸버에 넣으면 인증이 걸리는 조건이 **"그 컨트롤러 메서드에 `@AuthUser` 파라미터가 있는가"**로 바뀐다.

```text
@GetMapping    myOrders(@AuthUser LoginUser user)   → 리졸버 호출 → 검증됨   ✓
@DeleteMapping cancel(@PathVariable Long id)        → 리졸버 미호출 → 무검증  ✗
```

같은 컨트롤러 안에서도 메서드마다 인증이 걸렸다 안 걸렸다 하고, 빠진 쪽은 예외도 경고도 없이 정상 동작한다. 결국 "각 메서드에서 챙기는 구조"를 "각 메서드가 파라미터를 선언했는지에 달린 구조"로 바꾼 것일 뿐, **빠뜨릴 자리를 없애지 못했다.**

원리로 정리하면 이렇다. **차단은 "모든 요청이 반드시 지나가는 자리"에 있어야 하고, 주입은 "값이 필요한 곳"에 있으면 된다.** 앞단(필터·인터셉터)은 경로 패턴으로 범위가 정해지므로 컨트롤러 시그니처와 무관하게 모든 요청을 통과시킨다.

여기에 "그럼에도 리졸버가 `null`을 만나면 예외로 즉시 실패시킨다"는 두 번째 겹까지 말하면 완성된다 — 앞단 경로 패턴에서 빠진 URL이 있을 때 조용한 NPE 대신 원인을 이름으로 말하는 예외가 나야 한다.

### "`@RequestAttribute`로 충분하지 않나요?"

`@RequestAttribute("loginUser") LoginUser user`로도 꺼낼 수는 있다. 스프링이 기본 제공하는 리졸버로 처리되므로 커스텀 리졸버 없이 동작한다.

커스텀 리졸버의 이득은 셋이다. **① 문자열 키 은닉** — `"loginUser"`라는 문자열이 컨트롤러 수십 곳에 흩어지지 않는다. 오타가 나도 컴파일 에러가 없는 문자열을 노출하지 않는 것 자체가 값이다. **② 타입 검사** — `supportsParameter`에서 타입을 함께 확인하므로 잘못된 타입 선언이 걸러진다. **③ 미인증·null 처리 정책의 한 곳 집중** — "없으면 예외인가, `Optional`인가, 익명 사용자 객체인가"를 리졸버 한 곳에서 결정한다.

**그리고 통로를 바꿀 수 있다는 점이 결정적이다.** `@RequestAttribute`는 "request attribute에서 꺼낸다"는 구현을 컨트롤러 시그니처에 박아 넣는다. 나중에 ThreadLocal이나 `SecurityContextHolder`로 통로를 바꾸면 컨트롤러를 전부 고쳐야 한다. 커스텀 리졸버는 그 지식을 리졸버 하나에 가둬 둔다.

### "ThreadLocal 정리를 왜 `afterCompletion`에서 하나요?"

**요청이 어떻게 끝나든 반드시 실행되는 훅이기 때문**이다. `afterCompletion`은 핸들러에서 예외가 났을 때도, 뷰 렌더링이 끝난 뒤에도 호출된다. 반면 `postHandle`은 **핸들러에서 예외가 나면 건너뛴다** — 그러면 예외가 난 요청의 값이 스레드에 그대로 남는다.

왜 반드시 지워야 하는지를 함께 말해야 한다. **톰캣 스레드는 요청이 끝나도 죽지 않고 풀로 돌아가 재사용된다.** ThreadLocal 값은 스레드에 붙어 있으므로, 안 지우면 다음 요청 — 다른 사용자 — 이 이전 사용자 정보를 본다. 앞단이 값을 덮어쓰기 전에 누군가 읽으면 그대로 유출이다. 개발 환경에서는 스레드 재사용이 드물어 재현되지 않고 트래픽이 있는 운영에서만 터진다는 점도 악질이다.

`set(null)`이 아니라 `remove()`를 부르는 이유까지 말하면 정확한 답이 된다. `set(null)`은 "null이라는 값"을 남길 뿐 엔트리 자체는 스레드의 맵에 남아 있어, 스레드 풀이 오래 유지되는 환경에서 누적되면 메모리 누수가 된다.

### "`@Async` 서비스에서 그 사용자 정보가 필요하면요?"

ThreadLocal은 새 스레드에 전파되지 않는다. `@Async` 메서드는 별도 스레드 풀에서 실행되므로 요청 스레드의 ThreadLocal을 볼 수 없다.

대응은 둘이다. **값을 파라미터로 명시 전달하거나**, `TaskDecorator`로 요청 스레드의 컨텍스트를 복사해 비동기 스레드에 넘긴다. 후자를 쓸 때는 **읽기용 컨텍스트만** 복사하고, 비동기 작업이 끝날 때 그쪽에서도 정리해야 한다는 조건이 붙는다.

이게 특별한 함정이 아니라 **"요청 스레드에 묶인 것은 스레드를 벗어나면 사라진다"는 하나의 원리**라는 점을 말하면 좋다. 트랜잭션과 DB 커넥션도 같은 방식으로 요청 스레드에 묶여 있어서 `@Async` 경계를 넘으면 함께 사라진다. `15-async-annotation.md`와 `24-transaction-synchronization-connection-binding.md`가 각각의 본론이다.

### "인증을 필터에서 하면 안 되나요? 시큐리티가 없어도?"

된다. 순수 서블릿 필터로 JWT를 검증하는 것은 흔한 구현이고 **"필터 = 시큐리티 전용"이 아니다.** 갈리는 축은 셋이다.

**① 예외 처리 일관성.** 필터에서 던진 예외는 `@ControllerAdvice`가 못 잡아 부트 기본 `/error` 응답이 나가고 팀의 에러 포맷이 깨진다. `@Qualifier("handlerExceptionResolver")`로 `HandlerExceptionResolver`를 주입받아 직접 호출하면 우회할 수 있다.

**② 커버리지.** 인터셉터는 핸들러 매핑이 성공한 요청만 타므로, 없는 URL은 401이 아니라 404가 나간다 — 토큰 없이도 경로 존재 여부를 알아낼 수 있다(엔드포인트 열거). 필터로 막으면 존재 여부와 무관하게 401이다.

**③ 경로 매칭.** 서블릿 필터에는 `excludePathPatterns`가 없어 공개 엔드포인트 화이트리스트를 `AntPathMatcher`로 직접 구현해야 한다. 시큐리티의 `permitAll()`이 제공하는 게 정확히 그 기능이다.

실무에서는 **인증은 필터, 애너테이션 기반 인가는 인터셉터**로 나누는 조합도 흔하다. 셋 중 무엇이 어느 축에서 이기는지의 본론은 `06-filter-vs-interceptor.md`에 있다.

### "인터셉터로는 못 하고 필터로만 되는 게 있나요?"

**요청/응답 객체 자체의 교체**다. 필터는 `chain.doFilter(감싼요청, 감싼응답)`으로 래퍼를 다음 단계에 넘길 수 있고, 인터셉터는 이미 만들어진 요청을 받아 `boolean`만 반환하므로 구조적으로 불가능하다.

대표적인 것이 요청 본문 로깅이다. `InputStream`은 한 번만 읽히므로 `ContentCachingRequestWrapper`로 감싸서 교체하지 않으면, 로깅한 순간 컨트롤러의 `@RequestBody`가 빈 본문을 받는다. XSS 파라미터 치환, 응답 압축도 전부 이 범주다.

### "스프링 시큐리티를 쓰는데도 커스텀 리졸버를 만들 이유가 있나요?"

먼저 **`@AuthenticationPrincipal`이 이미 같은 일을 한다는 것을 인정하는 것**이 정직한 시작이다. 시큐리티는 인증 필터 체인(검증·차단), `SecurityContextHolder`(전달 통로), `AuthenticationPrincipalArgumentResolver`(주입)로 이 문서의 구조를 그대로 갖고 있다. 시큐리티를 쓰면서 같은 것을 다시 만드는 것은 중복이다.

**그럼에도 만드는 경우는 둘이다.**

**(1) 시큐리티를 안 쓰는 경우.** 사내 게이트웨이가 인증을 끝내고 헤더로 사용자 ID만 넘겨주는 구조나 자체 토큰 체계라면 시큐리티 전체를 들이는 것이 과할 수 있다.

**(2) 도메인 사용자 객체로 변환이 필요한 경우.** `SecurityContextHolder`에 있는 것은 `UserDetails`나 JWT 클레임이지 우리 도메인의 `Member` 엔티티가 아니다. 컨트롤러가 도메인 객체를 받게 하려면 변환 지점이 필요하고, 그 자리가 리졸버다. 이때도 **검증은 시큐리티가 하고 리졸버는 변환만 한다** — 3-1의 원칙은 그대로다.

커스텀 조합을 고를 때의 비용까지 말하면 시니어다운 답이 된다. 경로 화이트리스트, CSRF, 세션 고정 공격 방어, `@PreAuthorize` 같은 인가 애너테이션, 익명 사용자 처리를 전부 직접 만들게 된다는 것이다.

---

## 한 줄 요약

반복되는 인증 코드는 "검증·차단은 모든 요청이 반드시 지나가는 앞단(필터 또는 인터셉터), 주입은 커스텀 `HandlerMethodArgumentResolver`"로 역할을 나눠 제거하는데 — 이 분리가 필수인 이유는 검증까지 리졸버에 넣으면 `@AuthUser` 파라미터가 없는 메서드는 리졸버가 호출조차 되지 않아 인증이 통째로 빠지고 그 구멍이 정상처럼 보이기 때문이고, 리졸버는 `@RequestBody`·`@PathVariable`도 쓰고 있는 기존 확장점이라 우리는 구현체를 하나 얹을 뿐이며(`supportsParameter`의 판정은 캐싱되므로 정적 생김새만 봐야 한다), 앞단을 필터로 할지 인터셉터로 할지는 예외 처리 일관성·커버리지·경로 매칭 세 축으로 갈리고, ThreadLocal을 통로로 쓴다면 톰캣 스레드 재사용 때문에 `afterCompletion`에서 반드시 `remove()`해야 하며, 스프링 시큐리티를 쓰고 있다면 `@AuthenticationPrincipal`이 이미 같은 구조를 제공하므로 커스텀은 시큐리티 미도입이거나 도메인 객체 변환이 필요할 때의 선택지다.
