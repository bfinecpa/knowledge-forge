# Spring MVC 요청 처리 흐름 — DispatcherServlet이 지휘하는 프론트 컨트롤러 파이프라인

> 핵심 관전 포인트: **모든 HTTP 요청은 단 하나의 프론트 컨트롤러인
> DispatcherServlet으로 모이고, 그 앞뒤로 정해진 파이프라인을 통과한다.
> 순서는 `Filter(서블릿 컨테이너) → DispatcherServlet → HandlerMapping(핸들러
> 탐색) → HandlerAdapter(인터셉터 preHandle → 인자 바인딩 → 컨트롤러 실행 →
> 반환값 처리) → 예외면 ExceptionResolver → View 렌더링 또는 메시지 컨버터
> 직렬화 → 응답`. 이 순서를 알고 있으면 스택트레이스만 보고 요청이
> "어느 단계에서 죽었는지"를 즉시 특정할 수 있어서, 인증·바인딩·비즈니스
> 로직 중 어디를 봐야 할지 디버깅 방향이 바로 잡힌다.**

---

## 0. 질문 + 의도

**질문**: "Spring MVC의 요청 처리 흐름(DispatcherServlet → HandlerMapping →
...)을 설명해주세요."

**출제 의도**: 필터에서 죽었는지, 인터셉터에서 죽었는지, 컨트롤러 전
바인딩에서 죽었는지 — 에러 로그의 스택트레이스를 보고 "어느 단계"인지
즉시 아는 사람과 모르는 사람의 디버깅 속도 차이가 크다. 파이프라인의
순서를 아는 것이 곧 디버깅 방향을 잡는 능력임을 확인하는 질문이다.

## 1. 큰 그림 — 왜 "프론트 컨트롤러" 구조인가

Spring MVC 이전의 서블릿 방식은 URL마다 서블릿을 하나씩 만들었다.
그러면 인코딩 설정, 인증 체크, 뷰 포워딩 같은 **공통 작업이 모든 서블릿에
중복**된다.

```java
// Before: URL마다 서블릿 — 공통 로직이 전부 중복
public class OrderServlet extends HttpServlet {
    protected void doPost(HttpServletRequest req, HttpServletResponse res) {
        req.setCharacterEncoding("UTF-8");        // 중복 1: 인코딩
        if (!isAuthenticated(req)) { ... }        // 중복 2: 인증
        String itemId = req.getParameter("itemId"); // 중복 3: 수동 파라미터 파싱
        // ... 비즈니스 로직 ...
        req.getRequestDispatcher("/order.jsp").forward(req, res); // 중복 4: 뷰 이동
    }
}
```

DispatcherServlet은 이 문제를 **프론트 컨트롤러 패턴**으로 푼다.
모든 요청이 관문 하나(DispatcherServlet)를 지나가게 하고, 공통 처리는
관문이 담당하며, 관문이 "이 요청은 누가 처리할지"를 찾아 위임한다.

- 비유: 대형 병원의 **원무과 접수 창구**. 환자(요청)는 무조건 접수
  창구로 오고, 창구가 증상을 보고 어느 진료과(컨트롤러)로 보낼지 정한다.
  진료과 의사는 진료(비즈니스 로직)만 하면 된다.

```java
// After: 개발자는 핸들러 메서드만 작성 — 공통 처리는 프레임워크가
@RestController
public class OrderController {
    @PostMapping("/orders")                        // 매핑: HandlerMapping이 찾아줌
    public OrderResponse create(@RequestBody OrderRequest request) {
        // 파라미터 바인딩·직렬화·예외 변환 전부 DispatcherServlet 파이프라인이 처리
        return orderService.create(request);
    }
}
```

## 2. 단계별 흐름 — 요청이 지나가는 순서 그대로

```flow
# 요청 하나가 지나가는 7단계. 점선으로 나뉜 두 영역이 이 그림의 핵심이다 — **①은 스프링 바깥**이라 `@ControllerAdvice`가 닿지 않는다.
== 서블릿 컨테이너 · Spring MVC 바깥
① Filter 체인 | 인코딩 · CORS · Spring Security 인증(FilterChainProxy)
== Spring MVC · DispatcherServlet 관할
② DispatcherServlet | 지휘자 — 직접 일하지 않고 전략 객체에 위임한다
③ HandlerMapping | "이 URL·메서드는 누가 처리하지?" — 핸들러와 적용될 인터셉터 목록을 함께 반환
④ HandlerAdapter | "어떻게 실행하지?" — 핸들러 종류별 실행법을 아는 어댑터가 대행
  - Interceptor.preHandle | false를 반환하면 컨트롤러는 실행되지 않는다
  - ArgumentResolver | @RequestParam·@PathVariable 바인딩, @RequestBody JSON 역직렬화(Jackson), @Valid 검증
  - 컨트롤러 메서드 실행 | 내가 쓴 코드가 처음 실행되는 지점
  - ReturnValueHandler | @ResponseBody면 메시지 컨버터로 직렬화, 뷰 이름이면 ModelAndView
  - Interceptor.postHandle | 예외가 나면 건너뛴다
? ⑤ HandlerExceptionResolver | 예외 발생 시에만 — @ControllerAdvice + @ExceptionHandler가 여기서 실행된다
⑥ ViewResolver → View 렌더링 | @RestController면 ④-d에서 본문이 이미 완성돼 생략된다
⑦ Interceptor.afterCompletion | 예외가 나도 항상 실행 — 자원 정리·MDC 해제 자리
```

### ① Filter — 스프링 진입 전, 서블릿 컨테이너의 영역

- Tomcat 같은 서블릿 컨테이너가 관리하며 **DispatcherServlet보다 먼저**
  실행된다. Spring Security의 인증/인가도 사실은 필터 체인
  (`FilterChainProxy`)에서 동작한다.
- **디버깅 단서**: 컨트롤러에 브레이크포인트를 걸었는데 아예 안 걸리고
  401/403이 떨어진다면, 요청은 필터 단계에서 이미 끝난 것이다.

### ② DispatcherServlet — 지휘자

직접 일하지 않고 **각 단계의 전략 객체에게 위임하는 지휘자**다.
"핸들러 찾기", "실행하기", "예외 처리", "뷰 렌더링"을 각각
HandlerMapping, HandlerAdapter, ExceptionResolver, ViewResolver라는
교체 가능한 부품에 맡긴다. Spring MVC의 확장성은 이 위임 구조에서 나온다.

### ③ HandlerMapping — "누가 처리할지" 찾기

요청 URL·HTTP 메서드·헤더 등을 보고 실행할 핸들러(컨트롤러 메서드)를
찾는다. `@RequestMapping` 기반 매핑을 처리하는 것이
`RequestMappingHandlerMapping`이다. 이때 해당 핸들러에 적용될
**인터셉터 목록도 함께 묶어서** 반환한다.

- **디버깅 단서**: 404가 났는데 컨트롤러 코드는 멀쩡해 보인다면
  이 단계 — 매핑 자체가 안 된 것이다(URL 오타, 컴포넌트 스캔 누락,
  `@RestController` 미부착 등).

### ④ HandlerAdapter — "어떻게 실행할지" 대행

핸들러의 형태는 다양하다(`@RequestMapping` 메서드, 함수형 핸들러,
옛날식 `Controller` 인터페이스...). DispatcherServlet이 이걸 전부
알 필요 없도록, **핸들러 종류별 실행법을 아는 어댑터**가 실행을 맡는다.
어댑터 패턴 그대로다 — 콘센트 규격(실행 방식)이 다른 기기들을
멀티어댑터가 하나의 인터페이스로 꽂아주는 것.

이 안에서 실무적으로 중요한 두 부품이 동작한다:

- **ArgumentResolver**: `@RequestParam`, `@PathVariable`, `@RequestBody`
  같은 애너테이션을 보고 HTTP 요청을 자바 객체로 변환한다.
  `@RequestBody`의 JSON 역직렬화는 여기서 **HttpMessageConverter**
  (Jackson)를 호출해 수행된다. `@Valid` 검증도 바인딩 직후 이 단계에서.
- **ReturnValueHandler**: 컨트롤러 반환값을 해석한다. `@ResponseBody`면
  메시지 컨버터로 직렬화해 응답 본문에 쓰고, 뷰 이름이면
  ModelAndView로 만들어 뷰 렌더링 단계로 넘긴다.

- **디버깅 단서**: `HttpMessageNotReadableException`,
  `MethodArgumentNotValidException`, `MethodArgumentTypeMismatchException`이
  보이면 **컨트롤러 본문은 실행조차 안 된 것**이다. 비즈니스 로직이 아니라
  요청 스펙/바인딩(④-b)을 봐야 한다.

### ⑤ HandlerExceptionResolver — 예외를 응답으로 변환

컨트롤러(또는 그 이후)에서 예외가 던져지면 DispatcherServlet이 잡아서
등록된 리졸버들에게 처리를 위임한다. 우리가 쓰는
`@ControllerAdvice` + `@ExceptionHandler`는
`ExceptionHandlerExceptionResolver`가 실행해주는 것이다.

- **주의(가산점 포인트)**: 이 메커니즘은 DispatcherServlet 안에서만
  동작한다. **필터에서 터진 예외는 `@ControllerAdvice`가 못 잡는다** —
  그래서 Spring Security는 예외 응답을 필터 체인 안에서 따로 처리
  (`AuthenticationEntryPoint`, `AccessDeniedHandler`)하고, 이걸 모르면
  "인증 실패 응답만 에러 포맷이 다른" 현상의 원인을 못 찾는다.

### ⑥ ViewResolver / 메시지 컨버터 — 응답 만들기

뷰 이름을 반환하는 전통 MVC라면 ViewResolver가 논리 뷰 이름
(`"order/detail"`)을 실제 View 객체(JSP, Thymeleaf 템플릿)로 바꿔
렌더링한다. REST API(`@RestController`)라면 이 단계 대신 ④-d에서
이미 메시지 컨버터가 응답 본문을 완성했으므로 뷰 렌더링은 생략된다.

## 3. 실무 사례 — "어느 단계에서 죽었는가"가 디버깅 속도를 가른다

장애 상황에서 이 흐름을 아는 사람과 모르는 사람의 차이:

```text
증상: POST /orders 가 400을 반환. 서비스 로그에는 아무것도 없음.

흐름을 모르는 사람: OrderService부터 뒤진다 (실행된 적도 없는 코드)
흐름을 아는 사람:   "서비스 로그가 없다 = 컨트롤러 도달 전" → 바인딩 단계 의심
                  → 로그에서 MethodArgumentNotValidException 확인
                  → 클라이언트가 필수 필드를 빼고 보낸 것. 5분 컷.
```

단계별 증상 → 원인 매핑 (면접에서 하나만 예로 들어도 좋다):

```flow compact
# 같은 파이프라인을 **"어디서 죽었나"** 관점으로 다시 본 것. 증상만 보고 단계를 특정할 수 있으면 뒤져야 할 코드가 1/7로 줄어든다.
① Filter 체인
  ! 응답은 왔는데 access 로그에 컨트롤러 흔적이 없다 → Security 인증 실패·CORS preflight 차단
③ HandlerMapping
  ! 404인데 코드는 멀쩡하다 → URL 오타·컴포넌트 스캔 누락·@RestController 미부착
④-b ArgumentResolver
  ! 400 + MethodArgumentNotValidException / HttpMessageNotReadableException → 컨트롤러 본문은 실행조차 안 됐다
④-c 컨트롤러 메서드
  ! 500 + 우리 패키지 스택트레이스 → 여기서부터가 비즈니스 로직
? ⑤ ExceptionResolver 바깥
  ! 에러 응답 포맷만 공통 포맷과 다르다 → 필터 단계에서 만들어진 응답이라 @ControllerAdvice가 못 잡는다
```

또 하나의 흔한 함정 — **공통 관심사를 어느 단계에 두는가**:

```java
// Before: 인증 사용자 기반 감사 로깅을 필터에 구현
public class AuditFilter implements Filter {
    public void doFilter(...) {
        // 문제: 어떤 핸들러(컨트롤러 메서드)가 처리할지는
        // HandlerMapping 이후에야 알 수 있음 → 핸들러 정보 접근 불가
    }
}

// After: 핸들러 정보가 필요하면 Interceptor 단계가 맞다
public class AuditInterceptor implements HandlerInterceptor {
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res,
                             Object handler) {
        HandlerMethod method = (HandlerMethod) handler;  // 어떤 메서드가 처리하는지 앎
        // @AuditLog 같은 커스텀 애너테이션 기반 처리 가능
        return true;
    }
}
```

파이프라인의 각 단계가 "무엇을 알고 있는 시점인지"를 이해해야
필터/인터셉터/AOP 중 올바른 자리를 고를 수 있다.

## 4. 꼬리질문 대비 포인트

### "Filter와 Interceptor의 차이는? 각각 언제 쓰나요?"

- **Filter**: 서블릿 컨테이너 소속, DispatcherServlet **바깥**.
  `ServletRequest` 수준에서 동작하고 스프링 MVC 문맥(어떤 핸들러가
  처리하는지)을 모른다. 요청/응답 자체의 가공(인코딩, 요청 본문 래핑),
  인증처럼 "스프링에 들어오기 전에 끝내야 하는 일"에 적합.
- **Interceptor**: 스프링 MVC 소속, HandlerMapping **이후**에 동작.
  핸들러 정보(`HandlerMethod`)에 접근할 수 있어 컨트롤러 애너테이션
  기반 처리, 인가·감사 로깅에 적합.
- 예외 처리 경로도 다르다: 인터셉터에서 던진 예외는
  `@ControllerAdvice`가 잡지만 **필터의 예외는 못 잡는다**.
  "로깅/트레이싱을 인터셉터에만 두면 필터에서 차단된 요청(인증 실패)은
  관측 사각지대가 된다"까지 말하면 가산점.

### "@Controller와 @RestController의 차이는 이 흐름에서 어디에 해당하나요?"

`@RestController` = `@Controller` + `@ResponseBody`.
차이가 발현되는 지점은 **반환값 처리(ReturnValueHandler) 단계**다.
`@Controller`의 String 반환은 "뷰 이름"으로 해석되어
ViewResolver → 뷰 렌더링으로 가고, `@ResponseBody`가 있으면
HttpMessageConverter가 반환값을 직렬화해 응답 본문에 직접 쓰고
뷰 렌더링을 건너뛴다. `@Controller`에서 JSON 응답하려다
"뷰를 찾을 수 없음" 에러가 나는 이유가 이것이다.

### "HandlerMapping이 있는데 HandlerAdapter는 왜 또 필요한가요?"

역할이 다르다 — Mapping은 "**누가**(which)", Adapter는 "**어떻게**(how)".
핸들러의 형태가 하나로 고정돼 있지 않기 때문이다(`@RequestMapping`
메서드, 함수형 엔드포인트, 레거시 `Controller` 인터페이스 등).
DispatcherServlet이 모든 실행 방식을 알면 새 핸들러 형태가 생길 때마다
DispatcherServlet을 수정해야 한다(OCP 위반). 어댑터로 분리했기 때문에
새 형태는 어댑터 하나 추가로 끝난다. **프레임워크가 OCP를 지키는
대표적 설계**라고 짚으면 가산점.

### "@RequestBody의 JSON은 정확히 어느 시점에 객체로 바뀌나요?"

HandlerAdapter가 컨트롤러 메서드를 호출하기 **직전**,
ArgumentResolver(`RequestResponseBodyMethodProcessor`)가
HttpMessageConverter(Jackson)를 호출해 요청 본문을 역직렬화한다.
그래서 JSON 문법 오류(`HttpMessageNotReadableException`)나
`@Valid` 실패(`MethodArgumentNotValidException`)는 컨트롤러 코드가
한 줄도 실행되기 전에 터진다 — 이 예외들의 스택트레이스에 내 컨트롤러가
안 보이는 이유다.

### "이 구조의 한계나 트레이드오프는 없나요?" (시니어 변별 포인트)

- **요청당 스레드 1개(thread-per-request) 모델**: 서블릿 스택 위에 있어
  기본적으로 블로킹이다. 외부 API 대기가 긴 I/O 집약 트래픽에서는
  스레드 풀이 고갈될 수 있고, 이 지점이 WebFlux(이벤트 루프 기반) 또는
  가상 스레드를 검토하는 이유다. 다만 "대부분의 사내 API는 MVC로
  충분하고, 팀의 디버깅 역량·생태계 호환성까지 포함해 선택한다"고
  판단 기준을 붙이는 게 좋다.
- **흐름이 프레임워크 뒤에 숨는다**: 편리한 대신, 파이프라인 각 단계를
  모르면 "내 코드가 실행되기 전에 벌어지는 일"을 전혀 추적할 수 없다.
  필터 순서, 인터셉터 등록, 커스텀 ArgumentResolver 같은 확장 지점을
  아는 것이 곧 이 추상화의 비용을 상쇄하는 지식이다.
- **DispatcherServlet 바깥은 별도 세계**: 예외 처리·로깅 정책을
  MVC 안(@ControllerAdvice)에만 세우면 필터 단계 응답이 정책에서
  벗어난다. 관측/에러 포맷의 일관성은 필터 계층까지 포함해 설계해야 한다.

---

## 한 줄 요약

Spring MVC는 모든 요청을 DispatcherServlet 하나로 모아
**HandlerMapping(누가) → HandlerAdapter(어떻게: 인터셉터·바인딩·실행·반환
처리) → ExceptionResolver/뷰 렌더링**의 전략 객체들에게 위임하는
프론트 컨트롤러 파이프라인이며, 이 단계 순서를 알면 스택트레이스만 보고
요청이 어디서 죽었는지 즉시 특정할 수 있다.
