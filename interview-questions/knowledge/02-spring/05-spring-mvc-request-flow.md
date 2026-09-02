# Spring MVC 요청 처리 흐름 — DispatcherServlet이 지휘하는 프론트 컨트롤러 파이프라인

> 핵심 관전 포인트: **모든 HTTP 요청은 단 하나의 프론트 컨트롤러인 DispatcherServlet으로 모이고, 그 앞뒤로 정해진 파이프라인을 통과한다. 순서는 Filter(서블릿 컨테이너) → DispatcherServlet → HandlerMapping(누가 처리할지 탐색) → HandlerAdapter(인터셉터 preHandle → 인자 바인딩 → 컨트롤러 실행 → 반환값 처리) → 예외가 났다면 HandlerExceptionResolver → 뷰 렌더링 또는 메시지 컨버터 직렬화 → 응답이다. 탐색과 실행이 HandlerMapping과 HandlerAdapter로 갈라져 있다는 점, 그리고 인자 바인딩이 컨트롤러 진입 전에 끝난다는 점이 이 파이프라인을 이해하는 두 축이다. 이 순서를 쥐고 있으면 스택트레이스에 어떤 프레임이 보이고 어떤 프레임이 없는지만으로 요청이 어느 단계에서 죽었는지 특정할 수 있어서, 인증·바인딩·비즈니스 로직 중 어디를 열어봐야 할지가 즉시 정해진다.**

---

## 0. 질문 + 의도

**질문**: "Spring MVC의 요청 처리 흐름(DispatcherServlet → HandlerMapping → ...)을 설명해주세요."

**출제 의도**: 필터에서 죽었는지, 인터셉터에서 죽었는지, 컨트롤러 전 바인딩에서 죽었는지 — 에러 로그의 스택트레이스를 보고 "어느 단계"인지 즉시 아는 사람과 모르는 사람의 디버깅 속도 차이가 크다. 파이프라인의 순서를 아는 것이 곧 디버깅 방향을 잡는 능력임을 확인하는 질문이다.

## 1. 큰 그림 — 왜 "프론트 컨트롤러" 구조인가

### 1-1. 전제 지식 — 스프링 이전에 요청을 받던 물건

HTTP 요청을 받아 자바 객체로 바꿔주는 일은 스프링이 발명한 것이 아니다. **서블릿 컨테이너**(톰캣 같은 것)가 소켓을 열고 HTTP 텍스트를 파싱해 `HttpServletRequest` 객체로 만들어 주면, 개발자는 **서블릿**이라는 자바 클래스로 그 요청을 처리했다. 컨테이너와 서블릿의 계층 관계는 `06-filter-vs-interceptor.md`에서 한 절을 들여 설명한다. 여기서는 "DispatcherServlet도 결국 서블릿 하나이며, 그 앞에는 스프링이 아닌 컨테이너의 세계가 있다"는 사실만 쥐고 가면 된다.

문제는 URL마다 서블릿을 하나씩 만들던 구조에 있었다. 인코딩 설정, 인증 확인, 파라미터 파싱, 뷰 이동 같은 **공통 작업이 모든 서블릿에 그대로 복사**된다.

```java
// before: URL마다 서블릿 하나 — 공통 로직이 전부 중복된다
public class OrderServlet extends HttpServlet {
    protected void doPost(HttpServletRequest req, HttpServletResponse res) {
        req.setCharacterEncoding("UTF-8");          // 중복 1: 인코딩. 빠뜨리면 한글이 깨진다
        if (!isAuthenticated(req)) { ... }          // 중복 2: 인증. 서블릿 하나만 빠뜨려도 구멍
        String itemId = req.getParameter("itemId"); // 중복 3: 문자열을 손으로 꺼내 타입 변환
        // ... 비즈니스 로직 ...
        req.getRequestDispatcher("/order.jsp")      // 중복 4: 뷰 경로를 코드에 직접 박는다
           .forward(req, res);
    }
}
```

### 1-2. 프론트 컨트롤러 — 관문 하나로 모은다

**프론트 컨트롤러 패턴은 모든 요청이 반드시 지나가는 관문을 하나 두고, 공통 처리를 그 관문에 모으고, 관문이 "이 요청은 누가 처리할지"를 찾아 위임하는 구조다.** "프론트"는 앞단이라는 뜻이고, 이름 그대로 모든 컨트롤러의 앞에 서 있다.

Spring MVC에서 그 관문이 `DispatcherServlet`이다. `dispatch`는 "적임자에게 배정해 보낸다"는 뜻으로, 이 서블릿이 하는 일 자체가 이름이 됐다.

비유하자면 대형 병원의 **원무과 접수 창구**다. 환자는 무조건 창구로 오고, 창구가 증상을 보고 어느 진료과로 보낼지 정한다. 접수·보험 확인·수납 같은 공통 절차는 창구가 처리하므로, 진료과 의사는 진료에만 집중하면 된다.

```java
// after: 개발자는 핸들러 메서드만 쓴다 — 공통 처리는 파이프라인이 대신한다
@RestController
public class OrderController {
    @PostMapping("/orders")
    public OrderResponse create(@RequestBody OrderRequest request) {
        // 인코딩·인증·JSON 역직렬화·검증·직렬화가 전부 이 메서드 바깥에서 끝나 있다.
        // 그래서 이 메서드에 도달하지 못한 요청은 여기 로그가 한 줄도 안 남는다 — 3절의 주제다.
        return orderService.create(request);
    }
}
```

편해진 대신 대가가 하나 생긴다. **내 코드가 실행되기 전에 벌어지는 일이 프레임워크 뒤로 숨는다.** 그래서 이 파이프라인의 단계를 아는 것이 그대로 디버깅 능력이 된다.

## 2. 단계별 흐름 — 요청이 지나가는 순서 그대로

### 2-1. 전체 도식

```
클라이언트
  │
  ▼                        ┌─ 서블릿 컨테이너(Tomcat)의 영역. 스프링은 아직 없다
 ① Filter 체인             │  인코딩 · CORS · Spring Security 인증 · trace id 심기
  │                        └─ 여기서 응답이 나가면 DispatcherServlet은 요청을 구경도 못 한다
  ▼
 ② DispatcherServlet       ┌─ 여기부터 Spring MVC의 영역
  │                        │
  ▼                        │
 ③ HandlerMapping          │  "이 URL·메서드는 누가 처리하지?"  (탐색)
  │   핸들러 + 그 핸들러에 적용될 인터셉터 목록을 함께 반환한다
  ▼                        │
 ④ HandlerAdapter          │  "찾은 핸들러를 어떻게 실행하지?"  (실행)
  │   ├─ ④-a Interceptor.preHandle    false를 반환하면 여기서 끝난다
  │   ├─ ④-b ArgumentResolver         @RequestParam·@RequestBody 바인딩, @Valid 검증
  │   ├─ ④-c 컨트롤러 메서드 실행       ★ 내가 쓴 코드가 처음 실행되는 지점
  │   ├─ ④-d ReturnValueHandler       @ResponseBody면 여기서 응답 본문이 완성된다
  │   └─ ④-e Interceptor.postHandle   예외가 났다면 건너뛴다
  ▼                        │
 ⑤ HandlerExceptionResolver│  예외가 났을 때만 — @ControllerAdvice가 여기서 실행된다
  ▼                        │
 ⑥ ViewResolver → 렌더링    │  ④-d에서 본문이 완성됐다면 통째로 생략된다
  ▼                        │
 ⑦ Interceptor.afterCompletion  예외가 나도 항상 실행 — 정리 작업의 자리
  │                        └─ Spring MVC의 영역은 여기까지
  ▼
 응답이 ① Filter 체인을 역순으로 되돌아 나간다
```

### 2-2. ① Filter — 스프링에 들어오기 전

톰캣 같은 서블릿 컨테이너가 관리하며 **DispatcherServlet보다 먼저** 실행된다. Spring Security의 인증·인가도 사실은 이 필터 체인(`FilterChainProxy`)에서 동작한다.

디버깅 단서는 명확하다. **컨트롤러에 브레이크포인트를 걸었는데 아예 안 걸리고 401이나 403이 떨어진다면, 요청은 여기서 이미 끝난 것이다.** 컨트롤러 코드를 아무리 들여다봐도 답이 없다.

Filter와 Interceptor를 어떻게 나눠 쓰는지, 이 계층에서 터진 예외가 왜 `@ControllerAdvice`에 안 잡히는지는 `06-filter-vs-interceptor.md`에서 다룬다.

### 2-3. ② DispatcherServlet — 직접 일하지 않는 지휘자

`DispatcherServlet`은 스스로 요청을 처리하지 않는다. 각 단계를 **교체 가능한 전략 객체에게 위임**한다. 핸들러 찾기는 `HandlerMapping`에, 실행은 `HandlerAdapter`에, 예외 처리는 `HandlerExceptionResolver`에, 뷰 결정은 `ViewResolver`에 맡긴다.

여기서 "전략 객체"란 **같은 역할을 하는 여러 구현 중 하나를 골라 끼울 수 있게 인터페이스로 분리해 둔 부품**을 말한다. Spring MVC의 확장성은 전부 이 위임 구조에서 나온다 — 새로운 방식의 핸들러나 새로운 뷰 기술을 붙일 때 `DispatcherServlet`을 고칠 필요가 없다.

### 2-4. ③ HandlerMapping — "누가 처리할지" 찾기

요청 URL, HTTP 메서드, 헤더 등을 보고 실행할 핸들러(대개는 컨트롤러 메서드)를 찾는다. `@RequestMapping` 계열 애너테이션을 담당하는 구현이 `RequestMappingHandlerMapping`이다.

이때 **해당 핸들러에 적용될 인터셉터 목록도 함께 묶어서** 반환한다. 이 사실이 인터셉터의 성격을 결정한다 — 인터셉터는 "어떤 핸들러가 처리하는지 정해진 뒤"에야 존재할 수 있는 부품이라, 필터처럼 모든 요청을 무조건 덮을 수는 없다.

디버깅 단서: **404가 났는데 컨트롤러 코드는 멀쩡해 보인다면 이 단계다.** 매핑 자체가 안 된 것이고, 원인은 URL 오타, 컴포넌트 스캔 누락, `@Controller` 미부착(`04-stereotype-annotations.md`) 같은 것들이다. 매핑이 없을 때 스프링은 보통 예외 없이 404를 만들지만, 설정과 버전에 따라 `NoHandlerFoundException`·`NoResourceFoundException` 같은 예외로 만들어 ⑤로 보내기도 한다.

### 2-5. ④ HandlerAdapter — 왜 "찾기"와 "실행하기"가 둘로 갈라져 있는가

여기가 주니어가 가장 많이 헷갈리는 지점이다. **"핸들러를 찾았으면 그냥 호출하면 되지, 왜 어댑터가 또 필요한가?"**

답은 **핸들러의 형태가 하나가 아니기 때문**이다. 우리가 매일 쓰는 `@RequestMapping` 메서드 말고도, Spring MVC가 실행할 수 있는 핸들러는 여러 종류다.

```
같은 "핸들러"라도 실행하는 방법이 전혀 다르다

@RequestMapping 메서드          → 애너테이션을 읽어 인자를 만들어 채운 뒤
  create(OrderRequest req)        리플렉션으로 메서드를 호출해야 한다
                                  담당: RequestMappingHandlerAdapter

함수형 라우팅 핸들러             → ServerRequest 하나를 넘기고
  route(RouterFunction …)         ServerResponse 하나를 돌려받으면 된다
                                  담당: HandlerFunctionAdapter

정적 리소스 핸들러               → 파일을 찾아 스트림으로 흘려보내면 된다
  ResourceHttpRequestHandler      담당: HttpRequestHandlerAdapter

레거시 Controller 인터페이스     → handleRequest(req, res) 한 번 부르면 된다
  handleRequest(...)              담당: SimpleControllerHandlerAdapter
```

만약 실행 방법을 `DispatcherServlet`이 직접 알고 있다면, 핸들러 형태가 하나 늘 때마다 `DispatcherServlet` 안의 `if-else`가 하나씩 늘어난다. 프레임워크의 심장을 매번 수정해야 하는 구조이고, 이것이 **개방-폐쇄 원칙(OCP) 위반**의 전형이다 — 확장에는 열려 있고 수정에는 닫혀 있어야 한다는 원칙에서, 확장할 때마다 수정이 발생하는 상황이다.

그래서 역할을 이렇게 쪼갰다.

| 부품 | 답하는 질문 | 아는 것 |
|---|---|---|
| `HandlerMapping` | 누가(which) 처리하는가 | URL·메서드·헤더 → 핸들러 객체 |
| `HandlerAdapter` | 어떻게(how) 실행하는가 | 이 핸들러 종류의 실행 절차 |

`DispatcherServlet`이 하는 일은 이제 이렇게 단순해진다. "매핑들에게 물어 핸들러를 하나 얻는다. 등록된 어댑터들에게 `supports(handler)`를 물어 이 핸들러를 다룰 줄 아는 어댑터를 찾는다. 그 어댑터에게 실행을 맡긴다." **핸들러 형태가 새로 생기면 어댑터를 하나 추가해 등록하면 끝이고, `DispatcherServlet`은 손대지 않는다.**

비유하면 콘센트 어댑터다. 나라마다 플러그 모양(핸들러 형태)이 다른데, 벽면 콘센트(DispatcherServlet)를 나라마다 새로 뚫는 대신 어댑터를 끼운다. 콘센트는 어댑터라는 하나의 규격만 알면 된다.

`@RequestMapping` 메서드를 담당하는 `RequestMappingHandlerAdapter`가 실행 중에 하는 일을 순서대로 풀면 아래 ④-a부터 ④-e까지다.

### 2-6. ④-b ArgumentResolver — 컨트롤러 진입 "전"에 벌어지는 일

`@RequestParam`, `@PathVariable`, `@RequestBody` 같은 애너테이션을 보고 HTTP 요청을 자바 객체로 바꾸는 부품이 **ArgumentResolver**다. 애너테이션 종류마다 담당 구현이 하나씩 있고, `@RequestBody`를 맡는 것은 `RequestResponseBodyMethodProcessor`다.

`@RequestBody`의 JSON 역직렬화는 여기서 **HttpMessageConverter**(기본 구현은 Jackson)를 호출해 이뤄지고, `@Valid` 검증도 값이 채워진 직후 같은 자리에서 실행된다.

**이 문서에서 반드시 기억해야 할 사실이 하나 있다.**

```
InvocableHandlerMethod.invokeForRequest() 의 내부 순서

  ① getMethodArgumentValues()   ← 여기서 바인딩과 검증이 전부 끝난다
        │  실패하면 예외가 여기서 던져지고
        │  ↓
        ✗  아래로 내려가지 못한다
  ② doInvoke(args)              ← 컨트롤러 메서드는 여기서 호출된다
```

즉 **바인딩·검증 실패로 던져지는 예외는 컨트롤러 메서드가 한 줄도 실행되기 전에 발생한다.**

- `HttpMessageNotReadableException` — 요청 본문이 JSON 문법에 안 맞거나, 타입이 안 맞아 역직렬화가 실패했다.
- `MethodArgumentNotValidException` — 역직렬화는 됐는데 `@Valid` 제약(`@NotNull`, `@Min` 등)에 걸렸다.
- `MethodArgumentTypeMismatchException` — `@PathVariable Long id`에 `abc`가 들어오는 등 타입 변환이 실패했다.

이 셋 중 하나가 로그에 보이는데 컨트롤러 첫 줄의 로그가 안 찍혔다면, 그건 로거 설정이 잘못된 것이 아니라 **애초에 그 줄이 실행된 적이 없는 것**이다. 이 인과를 모르면 비즈니스 로직을 몇 시간 뒤지게 된다.

### 2-7. ④-d ReturnValueHandler — 응답이 두 갈래로 갈리는 지점

컨트롤러가 값을 반환하면 **ReturnValueHandler**가 "이 반환값을 어떻게 다룰지" 결정한다. 여기서 응답 경로가 두 갈래로 갈리고, **갈림의 기준은 오직 `@ResponseBody`의 유무**다.

```
컨트롤러 메서드가 값을 반환했다
              │
              ▼
     ④-d ReturnValueHandler 가 담당 처리기를 고른다
              │
    ┌─────────┴──────────────────────┐
    │                                │
@ResponseBody 있음                @ResponseBody 없음
(@RestController 포함)            (전통 @Controller + 뷰)
    │                                │
    ▼                                ▼
RequestResponseBodyMethodProcessor   반환한 문자열 "order/detail" 을
    │                                논리 뷰 이름으로 해석해
    ▼                                ModelAndView 를 만든다
HttpMessageConverter(Jackson)가       │
객체를 JSON 문자열로 직렬화해            ▼
응답 본문에 직접 쓴다                  ⑥ ViewResolver 가 논리 이름을
    │                                실제 View 객체로 바꾼다
    ▼                                (order/detail.html 등)
"이 요청은 처리 완료" 표시를 남긴다        │
(mavContainer.requestHandled = true)   ▼
    │                                View.render() 가 HTML을 만들어
    ▼                                응답 본문에 쓴다
⑥ 뷰 렌더링 단계는 통째로 생략된다        │
    │                                ▼
    ▼                              HTML 응답
 JSON 응답
```

같은 컨트롤러 메서드에 `@ResponseBody`를 붙였다 뗐다 하면 응답이 어떻게 달라지는지를 코드로 보면 이렇다.

```java
// (A) @ResponseBody 없음 — 반환 문자열은 "뷰 이름"으로 해석된다
@Controller
public class OrderPageController {
    @GetMapping("/orders/{id}")
    public String detail(@PathVariable Long id, Model model) {
        model.addAttribute("order", orderService.find(id));
        return "order/detail";   // ⑥ ViewResolver → templates/order/detail.html 렌더링
    }
}

// (B) @ResponseBody 있음 — 같은 문자열이 "응답 본문 그 자체"가 된다
@Controller
public class OrderApiController {
    @GetMapping("/orders/{id}")
    @ResponseBody
    public String detail(@PathVariable Long id) {
        return "order/detail";   // ④-d에서 본문에 그대로 기록. 뷰 렌더링은 일어나지 않는다
    }                            // 응답 바디: order/detail  (Content-Type: text/plain)
}
```

**`@Controller`에서 JSON을 반환하려다 "뷰를 찾을 수 없다"는 에러가 나는 이유**가 정확히 이 갈림이다. `@ResponseBody`가 없으면 반환값은 응답 본문 후보가 아니라 뷰 결정에 쓰일 값으로 해석되고, 객체를 반환한 경우에는 뷰 이름이 없으니 요청 URL에서 뷰 이름을 추측해 찾다가 실패한다. `@RestController`는 이 실수를 구조적으로 막으려고 `@Controller`와 `@ResponseBody`를 미리 합쳐 놓은 것이다.

### 2-8. ⑤ HandlerExceptionResolver — 예외를 응답으로 바꾸는 자리

컨트롤러에서(또는 인터셉터의 `preHandle`, 바인딩 단계에서) 예외가 던져지면 `DispatcherServlet`이 그것을 잡아 등록된 리졸버들에게 넘긴다. 우리가 쓰는 `@ControllerAdvice` + `@ExceptionHandler`는 그중 `ExceptionHandlerExceptionResolver`가 실행해 주는 것이다.

**이 메커니즘은 DispatcherServlet 안에서만 동작한다.** ④-b의 바인딩 예외가 `@ControllerAdvice`에 잡히는 것은 그 예외가 DispatcherServlet 안쪽에서 났기 때문이고, ① Filter에서 터진 예외가 안 잡히는 것도 같은 이유다. 예외가 어디까지 올라가는지를 파이프라인 위에 그려 설명하는 것은 `06-filter-vs-interceptor.md`의 2-3절이 맡는다.

### 2-9. ⑥ 뷰 렌더링과 ⑦ afterCompletion

뷰 이름을 반환하는 전통 MVC라면 `ViewResolver`가 논리 뷰 이름을 실제 `View` 객체로 바꿔 렌더링한다. `@ResponseBody` 경로라면 2-7에서 본 대로 이 단계 자체가 생략된다.

마지막으로 `Interceptor.afterCompletion`이 실행된다. **예외가 났든 안 났든 항상 호출된다**는 점이 `postHandle`과의 결정적 차이이고, 그래서 자원 정리나 MDC 해제처럼 "반드시 해야 하는 뒷정리"의 자리다. 정리 로직을 `postHandle`에 두면 예외 경로에서 조용히 누수된다.

## 3. 실무 사례 — 스택트레이스로 단계를 특정한다

출제 의도가 정확히 이 지점을 겨냥한다. 실제 스택트레이스 세 개를 놓고, **어떤 프레임이 보이고 어떤 프레임이 안 보이는지**로 단계를 좁히는 법을 보자. (Spring Boot 3.x · Java 21 기준. 줄 번호는 버전마다 다르므로 클래스 이름만 보면 된다.)

### 3-1. 경우 A — ① Filter에서 죽었다

```
java.lang.IllegalStateException: token store unavailable
  at com.acme.web.AuthTokenFilter.doFilterInternal(AuthTokenFilter.java:41)      ← 내 코드
  at org.springframework.web.filter.OncePerRequestFilter.doFilter(OncePerRequestFilter.java:116)
  at org.apache.catalina.core.ApplicationFilterChain.internalDoFilter(ApplicationFilterChain.java:174)
  at org.apache.catalina.core.StandardWrapperValve.invoke(StandardWrapperValve.java:149)
  at org.apache.catalina.connector.CoyoteAdapter.service(CoyoteAdapter.java:344)
  at org.apache.tomcat.util.net.NioEndpoint$SocketProcessor.doRun(NioEndpoint.java:1740)
  at java.base/java.lang.Thread.run(Thread.java:1583)
```

결정적 단서는 **`DispatcherServlet` 프레임이 하나도 없다**는 것이다. `ApplicationFilterChain`(톰캣의 필터 체인)에서 곧장 톰캣의 소켓 처리 프레임으로 내려간다. 요청이 스프링 MVC에 도달조차 못 했다는 뜻이므로, 컨트롤러도 인터셉터도 `@ControllerAdvice`도 볼 필요가 없다.

### 3-2. 경우 B — ④-b 바인딩에서 죽었다

```
org.springframework.web.bind.MethodArgumentNotValidException: Validation failed for argument [0]
  in public com.acme.order.OrderResponse com.acme.order.OrderController.create(com.acme.order.OrderRequest):
  [Field error in object 'orderRequest' on field 'amount': rejected value [null]; ... ]
  at o.s.web.servlet.mvc.method.annotation.RequestResponseBodyMethodProcessor.resolveArgument(...:145)
  at o.s.web.method.support.HandlerMethodArgumentResolverComposite.resolveArgument(...:122)
  at o.s.web.method.support.InvocableHandlerMethod.getMethodArgumentValues(...:216)   ← 여기서 끊겼다
  at o.s.web.method.support.InvocableHandlerMethod.invokeForRequest(...:170)
  at o.s.web.servlet.mvc.method.annotation.ServletInvocableHandlerMethod.invokeAndHandle(...:118)
  at o.s.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter.invokeHandlerMethod(...:884)
  at org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1088)
  ... (아래로 필터 체인과 톰캣 프레임)
```

여기서 놓치기 쉬운 함정이 하나 있다. **`com.acme.order.OrderController.create`라는 글자가 보이지만, 그건 예외 메시지 안의 텍스트일 뿐 `at`으로 시작하는 프레임이 아니다.** 스택 프레임 목록 어디에도 내 컨트롤러는 없다. 메시지만 훑고 "컨트롤러에서 났구나" 하고 컨트롤러를 열면 헛수고다.

진짜 단서는 **`getMethodArgumentValues`에서 멈췄다**는 것이다. 2-6에서 본 대로 이 메서드가 `doInvoke`보다 먼저이므로, **컨트롤러 메서드는 호출된 적이 없다.** 볼 곳은 요청 스펙과 DTO의 검증 애너테이션이지 서비스 로직이 아니다.

### 3-3. 경우 C — ④-c 컨트롤러 안에서 죽었다

```
java.lang.NullPointerException: Cannot invoke "com.acme.coupon.Coupon.rate()" because "coupon" is null
  at com.acme.order.OrderService.calculate(OrderService.java:88)                 ← 내 코드
  at com.acme.order.OrderController.create(OrderController.java:34)              ← 내 코드
  at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)
  at java.base/java.lang.reflect.Method.invoke(Method.java:580)
  at o.s.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:255) ← 호출됨
  at o.s.web.method.support.InvocableHandlerMethod.invokeForRequest(...:171)
  at o.s.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter.invokeHandlerMethod(...:884)
  at org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1088)
```

`doInvoke`와 `Method.invoke`가 보인다는 것은 **리플렉션으로 컨트롤러 메서드를 실제로 호출했다**는 증거다. 그 위로 내 패키지 프레임이 쌓여 있으므로, 여기서부터가 온전히 내 비즈니스 로직의 문제다.

### 3-4. 세 경우를 가르는 판별 절차

```
① 스택에 DispatcherServlet.doDispatch 프레임이 있는가?
     없다  → ① Filter 단계. 요청이 스프링에 들어오지도 못했다.        (경우 A)
     있다  ↓

② InvocableHandlerMethod.doInvoke / Method.invoke 프레임이 있는가?
     없다  → 아직 컨트롤러를 부르지 않았다.
             getMethodArgumentValues 에서 끊겼다면 ④-b 바인딩 단계.  (경우 B)
     있다  ↓

③ 최상단에 내 패키지(com.acme...) 프레임이 쌓여 있는가?
     있다  → ④-c 이후. 여기서부터가 비즈니스 로직이다.               (경우 C)
```

### 3-5. 증상만 보고 단계를 좁히는 표

스택트레이스를 얻기 전, 증상만으로도 상당히 좁힐 수 있다.

| 증상 | 의심 단계 | 흔한 원인 |
|---|---|---|
| 응답은 왔는데 애플리케이션 로그에 요청 흔적이 없다 | ① Filter | Security 인증 실패, CORS preflight 차단 |
| 404인데 컨트롤러 코드는 멀쩡하다 | ③ HandlerMapping | URL 오타, 컴포넌트 스캔 누락, `@Controller` 미부착 |
| 400 + 바인딩 계열 예외, 컨트롤러 로그 없음 | ④-b ArgumentResolver | 필수 필드 누락, JSON 타입 불일치 |
| 500 + 내 패키지 스택트레이스 | ④-c 컨트롤러 이후 | 비즈니스 로직 |
| 에러 응답 포맷만 팀 표준과 다르다 | ⑤ 바깥 | 필터 계층에서 만들어진 응답 (`06` 참고) |

이 표의 값어치는 **뒤져야 할 코드 범위가 한 단계로 줄어든다**는 데 있다. "POST /orders가 400인데 서비스 로그가 없다"에서, 흐름을 모르는 사람은 실행된 적도 없는 `OrderService`부터 뒤지고, 아는 사람은 "로그가 없다 = 컨트롤러 도달 전"이라는 한 줄 추론으로 바인딩 단계를 먼저 본다.

### 3-6. 같은 지식이 공통 관심사의 배치를 결정한다

파이프라인의 각 단계는 **그 시점에 무엇을 알고 있느냐**가 다르다. 그래서 "이 공통 처리를 어디에 둘 것인가"의 답도 파이프라인이 정해 준다.

```java
// before: 어떤 컨트롤러가 처리하는지 알아야 하는 감사 로깅을 필터에 뒀다
public class AuditFilter implements Filter {
    public void doFilter(...) {
        // 문제: 필터는 ③ HandlerMapping보다 앞이다. "어느 핸들러가 처리할지"가
        //       아직 정해지지 않은 시점이라 핸들러 정보에 접근할 방법이 없다.
    }
}

// after: 핸들러 정보가 필요하면 ③ 이후인 Interceptor가 맞는 자리다
public class AuditInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        HandlerMethod method = (HandlerMethod) handler;  // 어느 메서드가 처리하는지 안다
        // 덕분에 @AuditLog 같은 커스텀 애너테이션이 붙은 핸들러만 골라 처리할 수 있다
        return true;
    }
}
```

반대 방향의 실수도 있다. 인증 실패한 요청까지 포함해 **모든** 요청을 세거나 기록해야 한다면 Interceptor는 너무 안쪽이다. 이 배치 판단의 전체 기준은 `06-filter-vs-interceptor.md`에서 다룬다.

## 4. 꼬리질문 대비 포인트

### "`HandlerMapping`이 있는데 `HandlerAdapter`는 왜 또 필요한가요?"

역할이 다르다. Mapping은 "누가(which)", Adapter는 "어떻게(how)"에 답한다.

핸들러의 형태가 하나로 고정돼 있지 않다는 것이 이유다. `@RequestMapping` 메서드, 함수형 라우팅 핸들러, 정적 리소스 핸들러, 레거시 `Controller` 인터페이스는 실행 절차가 전부 다르다. 실행 방법을 `DispatcherServlet`이 직접 알면 핸들러 형태가 늘 때마다 `DispatcherServlet`을 수정해야 하므로 개방-폐쇄 원칙이 깨진다.

어댑터로 분리했기 때문에 **새 형태는 어댑터 하나를 추가해 등록하는 것으로 끝난다.** "프레임워크가 OCP를 지키는 대표적 설계"라고 짚으면 가산점이다. `supports(handler)`로 담당 어댑터를 고르는 구조까지 말하면 더 좋다.

### "`@Controller`와 `@RestController`의 차이는 이 흐름에서 어디에 해당하나요?"

`@RestController` = `@Controller` + `@ResponseBody`이고, **두 조각이 파이프라인의 서로 다른 단계에 작용한다.**

`@Controller` 쪽은 ③ HandlerMapping에 작용한다. `RequestMappingHandlerMapping`이 핸들러 후보를 고르는 조건이 "타입에 `@Controller` 또는 `@RequestMapping`이 있는가"이기 때문이다.

`@ResponseBody` 쪽은 ④-d ReturnValueHandler에 작용한다. 반환값을 뷰 이름으로 해석하는 대신 `HttpMessageConverter`로 직렬화해 응답 본문에 쓰고, ⑥ 뷰 렌더링을 건너뛰게 만든다.

`@Controller`에서 JSON을 응답하려다 "뷰를 찾을 수 없음"이 나는 이유가 후자다. 애너테이션 자체의 구조는 `04-stereotype-annotations.md`에서 다룬다.

### "`@RequestBody`의 JSON은 정확히 어느 시점에 객체로 바뀌나요?"

컨트롤러 메서드를 호출하기 **직전**, ④-b 단계다. `RequestResponseBodyMethodProcessor`라는 ArgumentResolver가 `HttpMessageConverter`(Jackson)를 호출해 요청 본문을 역직렬화한다.

그래서 JSON 문법 오류(`HttpMessageNotReadableException`)나 `@Valid` 실패(`MethodArgumentNotValidException`)는 **컨트롤러 코드가 한 줄도 실행되기 전에** 터진다. `invokeForRequest`가 `getMethodArgumentValues`를 먼저 부르고 그다음에 `doInvoke`를 부르기 때문이다.

이 예외들의 스택트레이스에 내 컨트롤러 프레임이 없는 이유가 이것이고, 컨트롤러 첫 줄의 로그가 안 찍히는 이유도 같다. 3-2의 스택트레이스를 예로 들면 설명이 확실해진다.

### "Filter와 Interceptor의 차이는? 각각 언제 쓰나요?"

이 파이프라인에서의 위치 차이가 전부다. **Filter는 ① — DispatcherServlet 바깥이라 어떤 핸들러가 처리할지 모르지만, 요청/응답 객체 자체를 교체할 수 있고 모든 요청을 덮는다. Interceptor는 ③ 이후 — `HandlerMethod`를 알고 있어 핸들러별 선별 처리가 가능하지만, 스프링에 들어온 요청만 볼 수 있다.**

여기서 파생되는 실무 결론이 셋 있다. 예외가 `@ControllerAdvice`에 잡히는지가 갈리고, 요청 본문 로깅은 Filter에서만 안전하게 되며, trace id를 Interceptor에 두면 인증 실패 요청이 관측 사각지대가 된다.

각각의 근거와 배치 결정 기준은 `06-filter-vs-interceptor.md`에서 전부 다루므로, 면접에서는 위 두 문장으로 답하고 필요하면 근거를 이어가면 된다.

### "이 구조의 한계나 트레이드오프는 없나요?" (시니어 변별 포인트)

세 가지를 말할 수 있다.

**요청당 스레드 하나(thread-per-request) 모델이다.** 서블릿 스택 위에 있어 기본적으로 블로킹이고, 요청 하나가 외부 API 응답을 기다리는 동안 그 스레드는 아무 일도 못 하면서 점유된다. 외부 호출이 잦고 응답이 느린 트래픽에서는 스레드 풀이 먼저 고갈된다. 이 지점이 WebFlux(이벤트 루프 기반)나 가상 스레드를 검토하는 이유다. 다만 "대부분의 사내 API는 MVC로 충분하고, 팀의 디버깅 역량과 라이브러리 생태계 호환성까지 포함해 선택한다"는 판단 기준을 붙이는 편이 좋다.

**흐름이 프레임워크 뒤로 숨는다.** 편리함의 대가로, 파이프라인을 모르면 "내 코드가 실행되기 전에 벌어진 일"을 전혀 추적할 수 없다. 3절의 스택트레이스 판별이 그 비용을 상쇄하는 지식이고, 필터 순서·인터셉터 등록·커스텀 ArgumentResolver 같은 확장 지점을 아는 것도 같은 맥락이다.

**DispatcherServlet 바깥은 별개의 세계다.** 예외 처리와 로깅 정책을 `@ControllerAdvice` 안에만 세우면 필터 단계에서 만들어진 응답이 그 정책 밖으로 새어 나간다. 에러 포맷과 관측의 일관성은 필터 계층까지 포함해서 설계해야 한다.

---

## 한 줄 요약

Spring MVC는 모든 요청을 DispatcherServlet 하나로 모아 **HandlerMapping(누가) → HandlerAdapter(어떻게: 인터셉터·바인딩·실행·반환값 처리) → ExceptionResolver 또는 뷰 렌더링**이라는 교체 가능한 전략 객체들에게 위임하는 프론트 컨트롤러 파이프라인이며, 탐색과 실행이 왜 둘로 갈라져 있는지와 바인딩이 컨트롤러 진입 전에 끝난다는 두 사실을 쥐고 있으면 스택트레이스에 어떤 프레임이 있고 없는지만으로 요청이 죽은 단계를 즉시 특정할 수 있다.
