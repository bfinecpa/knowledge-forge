# Spring Security 필터 체인 — 인증은 언제 처리되고, 커스텀 필터는 어디에 끼우는가

> 핵심 관전 포인트: **인증은 "누구인가"를 정하는 일이고 인가는 "이 사람이 이걸 해도 되는가"를 정하는 일이다. 스프링 시큐리티는 이 둘을 서블릿 필터 체인의 서로 다른 자리에 놓는다 — 인증 필터는 체인 중간에서 `SecurityContextHolder`를 채우고, 인가는 체인 맨 끝의 `AuthorizationFilter`가 그 컨텍스트를 읽어 판정한다. 그래서 커스텀 JWT 필터의 위치 제약은 단 하나다: **`AuthorizationFilter`보다 앞**. `addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)`의 기준점은 관례일 뿐 근거가 아니다. 바깥 구조는 `DelegatingFilterProxy`(order -100) → `FilterChainProxy` → `SecurityFilterChain` 목록의 3층이고, `FilterChainProxy`는 **요청에 매칭되는 첫 체인 하나만** 태운다 — 체인 순서를 잘못 놓아 `/api/**`가 `/api/admin/**`를 가리면 관리자 규칙이 통째로 무시된다. 401과 403은 `ExceptionTranslationFilter`가 가른다: 미인증이면 `AuthenticationEntryPoint`로 401(누군지 모르니 로그인하라), 인증됐는데 권한이 없으면 `AccessDeniedHandler`로 403(누군지는 알지만 안 된다). 그리고 `SecurityContextHolder`는 `ThreadLocal`이라 `@Async`가 만든 새 스레드에서는 비어 있다.**

---

## 0. 질문 + 의도

**질문**: "Spring Security 필터 체인에서 인증은 어느 시점에 처리되나요? 커스텀 인증 필터는 어디에 끼우나요?"

**출제 의도**: "401이 어디서 나왔는가"를 추적하려면 인증이 컨트롤러 훨씬 앞의 필터에서 일어남을 알아야 한다. 인증/인가 실무의 디버깅 기초 체력을 확인하는 질문으로, 커스텀 필터의 위치 선정 근거(인가 필터가 판정하기 전에 SecurityContext를 채워야 함)까지 말하는지로 이해의 깊이를 잰다.

## 1. 전제 — 인증과 인가는 다른 질문이고, 그래서 자리도 다르다

### 1-1. 두 단어를 먼저 갈라놓는다

필터 순서를 외우기 전에 이 구분이 먼저다. 이 전제 없이 필터 이름만 나열하면 "왜 하필 그 순서인가"에 답할 수 없다.

**인증(authentication)은 "당신은 누구인가"를 확정하는 일이다.** 아이디와 비밀번호가 맞는지, 제시한 토큰의 서명이 유효한지를 확인해 요청의 주인을 특정한다. 결과물은 "이 요청은 회원 번호 42번, 권한은 `ROLE_USER`"라는 **신원 정보 한 덩어리**다.

**인가(authorization)는 "그 사람이 이 일을 해도 되는가"를 판정하는 일이다.** 이미 확정된 신원을 놓고, 지금 요청한 자원과 동작에 대해 허용/거부를 결정한다. 결과물은 **통과 또는 거부라는 판정**이다.

비유하자면 인증은 **건물 정문에서 신분증을 확인해 방문증을 발급하는 절차**이고, 인가는 **각 층 출입구에서 그 방문증을 대보고 문을 열어줄지 결정하는 절차**다. 방문증 발급이 먼저고 문 열기가 나중이라는 순서는 뒤집을 수 없다. 아직 누구인지도 모르는 사람에게 "당신은 5층에 들어가도 됩니다"라고 판정할 방법이 없기 때문이다.

**이 순서가 그대로 필터 체인의 순서가 된다.** 스프링 시큐리티에서 인증 필터는 체인 중간에 있고, 인가 판정은 체인 맨 끝에 있다. 그 사이에 방문증을 보관하는 자리(`SecurityContextHolder`)가 있다.

```text
[정문] 신분증 확인 → 방문증 발급        =  인증 필터 → SecurityContextHolder 저장
   │
   │  (방문증을 목에 걸고 이동)          =  SecurityContext가 채워진 채 체인이 계속 흐른다
   ▼
[층 출입구] 방문증 확인 → 통과/거부      =  AuthorizationFilter 가 판정
   │
   ▼
[사무실] 실제 용무                       =  DispatcherServlet → 컨트롤러
```

### 1-2. 왜 컨트롤러가 아니라 필터에서 하는가

인증·인가를 컨트롤러 안에서 하지 않는 이유는 셋이다.

**차단은 최대한 바깥에서 끝나야 한다.** 권한 없는 요청을 애플리케이션 안쪽까지 들여보낸 뒤 막는 것보다, 들어오기 전에 돌려보내는 편이 공격 표면이 작고 낭비하는 자원도 적다.

**보호 대상이 컨트롤러만이 아니다.** 정적 리소스, 액추에이터 엔드포인트, 매핑되지 않은 경로까지 **서블릿 컨테이너로 들어오는 모든 요청**을 덮어야 한다. `DispatcherServlet` 안쪽의 확장점(인터셉터)으로는 그 범위를 커버할 수 없다.

**서블릿 필터는 스프링 MVC에 묶이지 않는 표준이다.** 필터는 서블릿 스펙의 부품이라 스프링 MVC가 아닌 환경에도 같은 보안 계층을 얹을 수 있다.

필터와 인터셉터의 소속 차이, 그리고 그 차이에서 파생되는 성질 전반은 `06-filter-vs-interceptor.md`가 본론이다. 여기서는 "시큐리티가 필터인 이유"만 짚고, 그다음 질문 — **그래서 그 필터들이 실제로 어떻게 조립돼 있고, 내 필터는 어디에 끼우는가** — 에 지면을 쓴다.

## 2. 바깥 세 층 — 요청이 어느 체인으로 들어가는가

### 2-1. 계층 도식

스프링 시큐리티는 필터 하나가 아니라 **세 층으로 포개진 구조**다. 각 층이 왜 필요한지를 층마다 밝히면서 내려간다.

```text
서블릿 컨테이너(톰캣)의 필터 체인
│
├─ (order < -100 인 우리 필터: trace id/MDC 등)
│
├─ DelegatingFilterProxy   ── order = -100 (SecurityProperties.DEFAULT_FILTER_ORDER)
│  │                          컨테이너에 등록되는 껍데기. 실제 일은 스프링 빈에 넘긴다
│  │
│  └─ FilterChainProxy     ── 빈 이름: springSecurityFilterChain
│     │                       SecurityFilterChain 목록을 들고, 요청에 맞는 하나를 고른다
│     │
│     ├─ SecurityFilterChain #1  securityMatcher("/api/admin/**")  ← 매칭되면 여기서 끝
│     ├─ SecurityFilterChain #2  securityMatcher("/api/**")
│     └─ SecurityFilterChain #3  (securityMatcher 없음 = 모든 요청)
│            └─ 각 체인 안에 순서 있는 필터 목록이 들어 있다 (3절)
│
└─ (order > -100 인 우리 필터)
   └─ DispatcherServlet → 컨트롤러
```

### 2-2. `DelegatingFilterProxy` — 컨테이너와 스프링 컨텍스트 사이의 다리

**왜 이 껍데기가 필요한가.** 서블릿 필터는 서블릿 컨테이너가 만들고 관리하는 부품이다. 톰캣은 스프링이라는 것이 존재하는지도 모르고, 당연히 스프링 빈 컨테이너에서 무언가를 꺼내오는 방법도 모른다. 그런데 시큐리티의 필터들은 `UserDetailsService`, `PasswordEncoder`, 우리가 만든 `JwtProvider` 같은 스프링 빈을 주입받아야 일할 수 있다. **컨테이너가 만드는 물건은 스프링 빈을 못 쓰고, 스프링 빈은 컨테이너에 등록될 방법이 없다** — 이 간극을 메우는 것이 `DelegatingFilterProxy`다.

**`DelegatingFilterProxy`는 컨테이너에 등록되는 진짜 서블릿 필터이지만, 자기 안에서는 아무 일도 하지 않고 스프링 컨텍스트에서 지정된 이름의 빈을 찾아 호출을 그대로 넘기는 대리인이다.** 이름 그대로 "위임하는(delegating) 프록시"다. 기본으로 찾는 빈 이름이 `springSecurityFilterChain`이고, 그 빈의 실체가 다음 층의 `FilterChainProxy`다.

한 가지 더 얻는 것이 있다. 이 프록시는 **첫 요청이 들어올 때 위임 대상 빈을 조회한다.** 그래서 스프링 컨텍스트가 서블릿 컨테이너보다 늦게 초기화되는 상황에서도 문제가 없다.

**order = -100의 의미.** 스프링 부트는 이 프록시를 order `-100`으로 등록한다. 상수 정의를 그대로 따라가면 이렇다.

```java
// org.springframework.boot.autoconfigure.security.SecurityProperties (Spring Boot 3.5 기준)
public static final int DEFAULT_FILTER_ORDER = OrderedFilter.REQUEST_WRAPPER_FILTER_MAX_ORDER - 100;

// org.springframework.boot.web.servlet.filter.OrderedFilter
int REQUEST_WRAPPER_FILTER_MAX_ORDER = 0;
// 따라서 DEFAULT_FILTER_ORDER = 0 - 100 = -100
```

숫자가 작을수록 앞이다. 그러므로 **시큐리티보다 앞에서 돌아야 하는 필터는 order를 -100보다 작게** 줘야 한다. 대표적인 것이 trace id를 MDC에 심는 필터다 — 시큐리티가 401로 요청을 끊어버리는 경우까지 로그에 trace id가 찍히려면 시큐리티보다 앞에 있어야 한다. 이 판단의 배경은 `06-filter-vs-interceptor.md`의 trace id 사각지대 사례에 있다. 설정은 `application.yml`의 `spring.security.filter.order`로 바꿀 수도 있다.

### 2-3. `FilterChainProxy` — 여러 체인 중 하나를 고르는 물건

**왜 또 한 겹이 필요한가.** 필터 목록이 딱 하나뿐이라면 이 층은 필요 없다. 문제는 한 애플리케이션 안에서 **경로마다 인증 방식이 다른 것이 정상**이라는 점이다. `/api/**`는 JWT 토큰, `/admin/**`는 폼 로그인 + 세션, `/actuator/**`는 HTTP Basic, `/docs/**`는 인증 없음 — 이런 요구가 흔하다.

이걸 필터 목록 하나로 처리하려면 모든 필터가 자기 안에서 "이 경로는 내가 처리할 경로인가"를 매번 판단해야 하고, 설정이 순식간에 뒤엉킨다. 그래서 스프링 시큐리티는 **"경로 조건 + 그 경로에 적용할 필터 목록"을 한 묶음으로 만들고, 그 묶음을 여러 개 둔다.** 그 묶음이 `SecurityFilterChain`이고, 묶음 목록을 들고 요청마다 하나를 고르는 것이 `FilterChainProxy`다.

`FilterChainProxy`가 하는 일은 이 세 가지다.

```text
① 요청을 HttpFirewall 로 검사한다
   경로에 인코딩된 슬래시, 세미콜론, 널 바이트 같은 우회 시도를 걸러낸다.
   (경로 매칭을 속여 인가를 통과하는 고전적 공격을 막는 자리)
② SecurityFilterChain 목록을 위에서부터 훑어 matches(request) 가 참인 첫 하나를 고른다
③ 고른 체인의 필터들을 순서대로 실행한다 (VirtualFilterChain)
   체인의 필터가 다 끝나면 원래의 컨테이너 필터 체인으로 되돌려 보낸다
```

②의 "첫 하나"가 이 절의 핵심이고, 다음 절이 그 이야기다.

### 2-4. 요청당 매칭되는 첫 체인 하나만 실행된다 — 가장 자주 나는 사고

**이건 성능 최적화가 아니라 의미론이다.** 체인 두 개가 겹쳐서 매칭돼도 둘 다 실행되지 않는다. 위에서부터 훑다가 처음 걸린 하나만 실행하고 끝난다. 그래서 **뒤 체인의 규칙은 앞 체인에 가려 통째로 사라질 수 있다.** 이게 실무에서 가장 자주 사고가 나는 지점이다.

```java
// 문제: 순서를 잘못 놓아 관리자 규칙이 통째로 무시된다
@Bean
@Order(1)
SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**")               // /api/admin/orders 도 여기에 매칭된다
        .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);
    return http.build();
}

@Bean
@Order(2)
SecurityFilterChain adminChain(HttpSecurity http) throws Exception {
    // /api/admin/** 는 위 체인에서 이미 끝났으므로 이 체인은 영원히 실행되지 않는다.
    // hasRole("ADMIN") 규칙이 존재하지 않는 것과 같다 — 일반 사용자 토큰으로 관리자 API가 열린다.
    http.securityMatcher("/api/admin/**")
        .authorizeHttpRequests(auth -> auth.anyRequest().hasRole("ADMIN"));
    return http.build();
}
```

```java
// 고침: 좁은 경로를 먼저, 넓은 경로를 나중에
@Bean
@Order(1)
SecurityFilterChain adminChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/admin/**")         // 더 구체적인 조건이 먼저 걸려야 한다
        .authorizeHttpRequests(auth -> auth.anyRequest().hasRole("ADMIN"))
        .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);
    return http.build();
}

@Bean
@Order(2)
SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**")
        .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);
    return http.build();
}
```

여기서 두 가지 규칙이 따라 나온다.

**규칙 ①: 체인 순서는 "좁은 것부터 넓은 것으로" 놓는다.** `@Order`가 붙지 않은 `SecurityFilterChain` 빈은 `Ordered.LOWEST_PRECEDENCE`로 취급돼 맨 뒤로 가지만, 여러 개가 순서 없이 섞이면 등록 순서에 의존하게 되므로 **체인이 둘 이상이면 전부 `@Order`를 명시**하는 편이 안전하다.

**규칙 ②: `securityMatcher`가 없는 체인은 반드시 마지막이다.** `securityMatcher`를 지정하지 않은 체인은 모든 요청에 매칭되므로, 앞에 놓이면 뒤의 모든 체인을 삼킨다.

이 실수 중 **가장 거친 형태**는 최근 버전에서 기동 시점에 막아준다. 스프링 시큐리티 6.5 기준으로 `WebSecurityFilterChainValidator`가 체인 목록을 검사해, 모든 요청에 매칭되는 체인 뒤에 다른 체인이 있으면 `UnreachableFilterChainException`(`IllegalArgumentException`의 하위 타입)을 던지며 애플리케이션이 뜨지 않는다. 메시지도 친절하다 — "A filter chain that matches any request ... has already been configured, which means that this filter chain ... will never get invoked."

**그러나 위 예시의 `/api/**` vs `/api/admin/**` 겹침은 이 검증에 걸리지 않는다.** 둘 다 "모든 요청" 매처가 아니기 때문이다. 즉 **부분적으로 겹치는 경로는 여전히 조용히 가려진다** — 그래서 사람이 봐야 하고, 2-6의 로그로 확인해야 한다.

### 2-5. 스프링 시큐리티 6의 설정 방식 — `WebSecurityConfigurerAdapter`는 없다

옛 자료를 보고 `WebSecurityConfigurerAdapter`를 상속하려다 클래스를 못 찾아 막히는 사람이 많다. 무엇이 언제 바뀌었는지 버전과 함께 정리해 둔다.

| 시기 | 변화 |
|---|---|
| 스프링 시큐리티 5.7 | `WebSecurityConfigurerAdapter` deprecated. `SecurityFilterChain` 빈 등록 방식 권장 |
| 스프링 시큐리티 6.0 | `WebSecurityConfigurerAdapter` **삭제**. 상속할 클래스 자체가 없다 |
| 스프링 시큐리티 6.1 | 비람다 DSL(`.and()`, 인자 없는 `authorizeHttpRequests()` 등)이 `@Deprecated(since = "6.1", forRemoval = true)` |
| 스프링 시큐리티 7.0 | 위 비람다 DSL 제거 예정 |

`@Deprecated(since = "6.1", forRemoval = true)`는 실제 소스에 그렇게 적혀 있다(6.5.11 확인). 즉 **6.1 이후로 람다 DSL은 취향이 아니라 사실상 필수**다.

바뀐 지점을 before/after로 보면 이렇다.

```java
// before: 스프링 시큐리티 5.6 이하 방식 — 6.0부터는 컴파일조차 되지 않는다
@Configuration
public class SecurityConfig extends WebSecurityConfigurerAdapter {
    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http.csrf().disable()                       // .and() 로 이어붙이는 비람다 DSL
            .authorizeRequests()
                .antMatchers("/api/public/**").permitAll()
                .anyRequest().authenticated();
    }
}
```

```java
// after: 스프링 시큐리티 6.x 방식 — 설정 클래스를 상속하지 않고 빈을 등록한다
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, JwtAuthenticationFilter jwtFilter) throws Exception {
        return http
            // 토큰 인증이라 세션이 없다 = 브라우저가 자동으로 실어 보내는 인증 수단이 없다
            // = CSRF 공격의 전제가 성립하지 않는다. 이 근거 없이 끄면 안 된다.
            .csrf(csrf -> csrf.disable())
            // STATELESS: 세션을 만들지도, 세션에서 컨텍스트를 복원하지도 않는다 (3-3 참고)
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // antMatchers -> requestMatchers 로 이름이 바뀌었다 (6.0)
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/public/**").permitAll()
                .anyRequest().authenticated())
            .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)
            .build();
    }
}
```

이름이 바뀐 것 중 헷갈리기 쉬운 짝이 하나 있다. **`securityMatcher`는 "이 체인이 어떤 요청을 맡는가"이고, `requestMatchers`는 "그 체인 안에서 어떤 경로에 어떤 권한을 요구하는가"다.** 5.x에서는 둘 다 `HttpSecurity.requestMatchers()`와 `authorizeRequests().antMatchers()`라는 비슷한 이름이었는데, 6.0에서 역할에 맞게 갈라졌다.

### 2-6. 실무 팁 — 체인 목록과 필터 순서를 눈으로 확인한다

체인이 어떻게 구성됐는지는 추측하지 말고 로그로 확인한다. 스프링 시큐리티 6.5 소스 기준으로 로그 레벨별로 무엇이 찍히는지가 명확하다.

```yaml
logging:
  level:
    org.springframework.security: DEBUG   # 기동 시 체인별 필터 목록
    # org.springframework.security.web.FilterChainProxy: TRACE  # 요청별 체인 선택과 필터 호출
```

**DEBUG — 기동 시 1회.** `DefaultSecurityFilterChain`이 생성될 때 체인마다 한 줄씩 찍는다. 실제 필터 순서를 눈으로 확인할 수 있는 가장 빠른 방법이다.

```text
Will secure Mvc [pattern='/api/admin/**'] with filters: DisableEncodeUrlFilter,
  WebAsyncManagerIntegrationFilter, SecurityContextHolderFilter, HeaderWriterFilter,
  LogoutFilter, JwtAuthenticationFilter, UsernamePasswordAuthenticationFilter, ...,
  AnonymousAuthenticationFilter, ExceptionTranslationFilter, AuthorizationFilter
```

여기서 **내 커스텀 필터가 정말 의도한 자리에 들어갔는지**를 확인한다. 위 예시라면 `JwtAuthenticationFilter`가 `UsernamePasswordAuthenticationFilter` 바로 앞, `AuthorizationFilter`보다 한참 앞에 있다는 것이 눈으로 확인된다.

**TRACE — 요청마다.** 어느 체인이 선택됐는지(`Trying to match request against ... (1/3)`)와 필터가 하나씩 호출되는 과정(`Invoking JwtAuthenticationFilter (6/13)`)이 찍힌다. 2-4의 "체인이 가려지는" 사고를 잡을 때 결정적이다 — 관리자 요청인데 `(2/3)`이 아니라 `(1/3)` 체인이 선택되고 있으면 그게 답이다. 다만 요청마다 수십 줄이 나오므로 로컬 재현 때만 켠다.

시큐리티가 아예 관여하지 않는 경로(`WebSecurityCustomizer.ignoring()`으로 뺀 경로)는 TRACE에서 `No security for GET /favicon.ico`로 찍힌다. "필터가 왜 안 타지"의 답이 여기 있는 경우가 있다.

`@EnableWebSecurity(debug = true)`도 같은 목적의 도구인데, 요청 상세까지 로그에 남기므로 **운영에서는 절대 켜지 않는다.**

## 3. 체인 안 — 인증은 중간, 인가는 맨 끝, 예외는 그 사이에서 갈린다

### 3-1. 필터 순서표

한 `SecurityFilterChain` 안의 필터 순서는 `FilterOrderRegistration`이라는 클래스에 하드코딩돼 있다. 우리가 `HttpSecurity`에 무엇을 설정하든 실제 배치 순서는 이 표가 결정한다. 자주 보는 것만 추리면 이렇다(스프링 시큐리티 6.5 기준, 실제 등록 순서 그대로).

| 순서 | 필터 | 하는 일 |
|---|---|---|
| 1 | `DisableEncodeUrlFilter` | URL에 세션 ID를 붙이는 옛 방식을 차단 |
| 2 | `WebAsyncManagerIntegrationFilter` | 비동기 요청 처리 스레드로 `SecurityContext`를 이어준다 |
| 3 | `SecurityContextHolderFilter` | 저장소에서 기존 `SecurityContext`를 **복원**(3-3) |
| 4 | `HeaderWriterFilter` | 보안 응답 헤더(`X-Frame-Options` 등) 삽입 |
| 5 | `CorsFilter` | CORS preflight 처리 |
| 6 | `CsrfFilter` | CSRF 토큰 검증 |
| 7 | `LogoutFilter` | `/logout` 매칭 시 처리하고 체인 종료 |
| 8 | **인증 필터 구간** | `X509` → 사전 인증 → OAuth2/SAML → **`UsernamePasswordAuthenticationFilter`** → `DigestAuthenticationFilter` → `BearerTokenAuthenticationFilter` → `BasicAuthenticationFilter` (**커스텀 JWT 필터가 끼는 구간**) |
| 9 | `RememberMeAuthenticationFilter` | 자동 로그인 쿠키로 인증 시도 |
| 10 | `AnonymousAuthenticationFilter` | 여기까지 미인증이면 **익명 `Authentication`을 채워 넣는다** |
| 11 | `SessionManagementFilter` | 세션 고정 공격 방어, 동시 세션 제어 |
| 12 | `ExceptionTranslationFilter` | 아래에서 올라온 보안 예외를 401/403 **응답으로 변환**(3-6) |
| 13 | `AuthorizationFilter` | `SecurityContext`를 읽어 **인가 판정**. 통과하면 `DispatcherServlet`으로 |

읽어야 할 것은 개별 이름이 아니라 **구간의 배치**다.

```text
 복원        인증 시도             익명 채움    예외 변환      인가 판정
   │            │                     │           │             │
   ▼            ▼                     ▼           ▼             ▼
[3] ─────▶ [8] ──────────▶ [9] ─▶ [10] ─────▶ [12] ──────▶ [13] ──▶ DispatcherServlet
                                                  ▲              │
                                                  └──────────────┘
                                        AccessDeniedException 이 올라온다
```

- **인증은 8번 구간(중간)**에서 `SecurityContext`를 채우고,
- **인가는 13번(맨 끝)**에서 그 컨텍스트를 읽어 판정하며,
- **12번은 13번을 감싸고 있어서** 13번이 던진 예외를 받아 401/403으로 바꾼다.

`AuthorizationFilter`는 "`SecurityContext`에 무엇이 들어 있는가"만 본다. 어떻게 채워졌는지, 누가 채웠는지는 관심이 없다. **그래서 인증 필터는 반드시 그보다 앞이어야 한다** — 이 한 문장이 4절 전체의 근거다.

`AuthorizationFilter`는 구버전의 `FilterSecurityInterceptor`를 대체한 것이다(6.0부터 기본). 옛 자료에 `FilterSecurityInterceptor`가 나오면 지금의 `AuthorizationFilter`로 읽으면 된다.

### 3-2. 인증 필터의 공통 5단계

인증 필터는 종류가 많지만 하는 일의 뼈대는 같다.

```text
① 요청에서 credential(신원 증명 자료)을 꺼낸다
   폼 파라미터(username/password) / Authorization 헤더 / 쿠키 / 커스텀 헤더
        │
        ▼
② 아직 검증 안 된 Authentication 객체를 만든다
   UsernamePasswordAuthenticationToken.unauthenticated(id, pw)
   — "이 사람이 이렇게 주장한다"를 담은 요청서일 뿐, 아직 사실이 아니다
        │
        ▼
③ AuthenticationManager 에 검증을 위임한다
   구현체는 ProviderManager — 등록된 AuthenticationProvider 들을 순회하며
   supports(토큰 타입) 가 참인 것에게 authenticate() 를 시킨다
     예) DaoAuthenticationProvider = UserDetailsService 로 사용자 조회
                                     + PasswordEncoder 로 비밀번호 대조
        │
        ├─ 성공 ──▶ ④ 검증된 Authentication 을 SecurityContext 에 담아
        │             SecurityContextHolder 에 세팅한다 (+ 필요하면 저장소에 save)
        │
        └─ 실패 ──▶ ⑤ AuthenticationException 을 던진다
                      (필터가 직접 잡아 failureHandler 로 응답하거나,
                       그냥 두면 ExceptionTranslationFilter 가 받는다)
```

여기서 **`AuthenticationManager`와 `AuthenticationProvider`가 왜 둘로 갈라져 있는지**를 짚어둘 만하다. 한 애플리케이션이 폼 로그인, LDAP, OAuth2, 자체 토큰을 동시에 지원하는 것이 흔하다. 인증 수단마다 검증 로직이 완전히 다르므로, `ProviderManager`는 **판단하지 않고 목록을 순회하기만 하는 컴포지트**로 두고, 실제 검증은 수단별 `AuthenticationProvider`가 맡는다. 새 인증 수단을 추가하는 일이 "Provider 하나를 등록하는 일"로 끝나는 구조다.

**모든 인증 필터가 모든 요청에서 일하는 것은 아니다.** `UsernamePasswordAuthenticationFilter`는 `AbstractAuthenticationProcessingFilter`를 상속하는데, 이 부모는 요청이 지정된 경로·메서드(`POST /login`)에 매칭될 때만 인증을 시도하고 아니면 그냥 통과시킨다. 반면 `BasicAuthenticationFilter`나 우리가 만들 JWT 필터는 **매 요청마다** 헤더를 보고 인증을 시도한다. 이 차이가 3-3의 "세션 방식 vs 토큰 방식"으로 이어진다.

### 3-3. `SecurityContextHolder` — ThreadLocal이라는 사실이 만드는 것들

**`SecurityContextHolder`는 현재 요청의 인증 정보를 담아두는 보관함이고, 기본 구현은 `ThreadLocal`이다.** `ThreadLocal`은 스레드마다 별도의 저장 칸을 갖는 변수로, 같은 객체를 참조해도 스레드가 다르면 다른 값을 본다. 덕분에 컨트롤러든 서비스든 리포지토리든 **인증 정보를 메서드 인자로 넘기지 않고도** 어디서나 꺼내 쓸 수 있다.

```java
Authentication auth = SecurityContextHolder.getContext().getAuthentication();
```

컨트롤러에서는 이 줄을 직접 쓰는 대신 `@AuthenticationPrincipal`로 파라미터에 주입받는 것이 정석이다. 그 애너테이션이 실제로 무슨 부품(`AuthenticationPrincipalArgumentResolver`)으로 동작하는지, 그리고 `SecurityContextHolder`의 값을 우리 도메인 객체로 바꿔 넣어야 할 때 어떻게 하는지는 `33-custom-argument-resolver-auth-user.md`가 다룬다.

이 편의에는 세 가지 대가가 따라온다.

**① 스레드가 바뀌면 사라진다.** `@Async`가 만든 새 스레드, 직접 만든 `ExecutorService`, `CompletableFuture.supplyAsync()`의 기본 풀에서는 `getAuthentication()`이 `null`이다. 그 스레드에는 아무도 컨텍스트를 심어준 적이 없기 때문이다. 그래서 `@Async` 메서드 안의 `@PreAuthorize`는 권한 없음으로 실패한다.

```java
// 문제: 비동기 메서드 안에서 인증 정보가 비어 있다
@Async
public void sendReceipt(Long orderId) {
    // NullPointerException — 이 스레드의 ThreadLocal 저장소는 비어 있다
    String email = SecurityContextHolder.getContext().getAuthentication().getName();
}
```

```java
// 고침 ①: 시큐리티가 제공하는 래퍼로 실행기를 감싼다 — 캡처·복원·정리가 검증돼 있다
@Bean
AsyncTaskExecutor mailExecutor(ThreadPoolTaskExecutor delegate) {
    return new DelegatingSecurityContextAsyncTaskExecutor(delegate);
}

// 고침 ②: 애초에 필요한 값만 인자로 넘긴다 — 가장 단순하고 대체로 옳은 답이다
@Async
public void sendReceipt(Long orderId, String email) { ... }
```

전파가 왜 필요한지, `TaskDecorator`로 직접 캡처·복원할 때 **끝나고 반드시 지워야 하는 이유**(풀 스레드는 재사용되므로 A의 인증 정보로 B의 작업이 도는 사고가 난다)까지는 `15-async-annotation.md`의 3-2절이 다룬다.

**② 저장소에서 꺼내오는 일은 별도의 필터가 한다.** `ThreadLocal`은 요청이 끝나면 비워진다. 그러면 다음 요청에서는 어떻게 인증 상태가 이어지는가 — 3번 `SecurityContextHolderFilter`가 `SecurityContextRepository`(세션 기반이면 `HttpSessionSecurityContextRepository`)에서 컨텍스트를 꺼내 `SecurityContextHolder`에 심는다. **인증 필터가 "새로 인증하는" 자리라면, 이 필터는 "이미 인증된 것을 되살리는" 자리다.**

```text
[세션 방식]
  로그인 요청 1회      : UsernamePasswordAuthenticationFilter 가 인증 → 세션에 저장
  이후 모든 요청       : SecurityContextHolderFilter 가 세션에서 복원 (재인증 없음)

[토큰(STATELESS) 방식]
  로그인 요청 1회      : 토큰 발급 (인증 상태를 서버에 저장하지 않는다)
  이후 모든 요청       : 커스텀 JWT 필터가 매번 토큰을 검증해 컨텍스트를 새로 채운다
                        SecurityContextHolderFilter 는 복원할 저장소가 없어 아무 일도 안 한다
```

**③ 스프링 시큐리티 6의 저장 정책이 5.x와 다르다.** 6.0부터 기본 필터가 `SecurityContextPersistenceFilter`에서 `SecurityContextHolderFilter`로 바뀌었는데, 결정적 차이는 **자동 저장을 하지 않는다**는 것이다. 5.x의 옛 필터는 요청이 끝날 때 컨텍스트를 저장소에 알아서 써 줬지만, 새 필터는 **읽기만 하고 저장은 인증 필터가 명시적으로 하도록** 바꿨다. 공식 소스의 주석도 "`saveContext`가 명시적으로 호출돼야 한다"고 못 박고 있다.

이게 실무에 미치는 영향은 분명하다. **커스텀 필터에서 `SecurityContextHolder`에 인증을 심어 놓기만 하고 세션에 남기를 기대하면, 다음 요청에서 인증이 사라진다.** 세션에 남겨야 한다면 직접 저장해야 한다.

```java
// 세션 기반인데 커스텀 필터로 인증을 심는 경우 — 6.x에서는 저장까지 직접 해야 한다
SecurityContext context = SecurityContextHolder.createEmptyContext();
context.setAuthentication(authentication);
SecurityContextHolder.setContext(context);
// 이 줄이 없으면 이번 요청에서만 인증된 상태이고, 다음 요청은 다시 익명이다
securityContextRepository.saveContext(context, request, response);
```

`SecurityContextHolder.getContext().setAuthentication(...)`으로 기존 컨텍스트를 고쳐 쓰는 대신 **`createEmptyContext()`로 새 컨텍스트를 만들어 통째로 갈아끼우는 것**이 공식 권장 방식이다. 시큐리티 내부 필터들도 전부 이렇게 한다. 공유되던 컨텍스트 객체를 여러 스레드가 동시에 고치는 상황을 원천적으로 없애기 위해서다.

STATELESS 설정에서는 세션 대신 **요청 속성**에 컨텍스트를 담는 `RequestAttributeSecurityContextRepository`가 쓰인다. 요청 하나의 수명 동안만 유지되지만, 그 덕분에 같은 요청 안에서 일어나는 `ERROR` 디스패치(3-6 끝 참고)에서도 인증이 유지된다.

### 3-4. 커스텀 JWT 필터 — 구현과 위치 선정의 유일한 근거

```java
// OncePerRequestFilter 를 쓰는 이유: 하나의 요청이 FORWARD/INCLUDE/ERROR 디스패치로
// 컨테이너를 여러 번 돌 수 있는데, 그때마다 토큰 파싱을 반복하지 않기 위해서다.
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtProvider jwtProvider;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String token = resolveBearerToken(req);                 // ① Authorization 헤더에서 추출
        if (token != null) {
            try {
                Authentication auth = jwtProvider.toAuthentication(token);  // ② 서명·만료 검증 후 변환
                // ③ 새 컨텍스트를 만들어 통째로 세팅한다 (3-3의 권장 방식)
                SecurityContext context = SecurityContextHolder.createEmptyContext();
                context.setAuthentication(auth);
                SecurityContextHolder.setContext(context);
                // STATELESS 라 저장소에 save 하지 않는다 — 매 요청 토큰으로 다시 채우기 때문
            } catch (JwtException e) {
                // 여기서 예외를 그냥 던지면 ExceptionTranslationFilter 를 지나칠 수 없다(3-5).
                // 컨텍스트를 비워둔 채 통과시키면 AuthorizationFilter 가 거부하고
                // ExceptionTranslationFilter 가 규격에 맞는 401 을 만들어 준다.
                SecurityContextHolder.clearContext();
            }
        }
        // 토큰이 없어도, 검증에 실패해도 일단 통과시킨다.
        // permitAll 경로도 이 필터를 타기 때문에 여기서 401 을 쓰면 공개 API 까지 막힌다.
        chain.doFilter(req, res);
    }
}
```

```java
http.addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
```

**"왜 `UsernamePasswordAuthenticationFilter` 앞인가"에 대한 정확한 답은 "거기여야 해서"가 아니다.** 제약은 하나뿐이다.

> **인가 필터(`AuthorizationFilter`)가 판정하기 전에 `SecurityContext`가 채워져 있어야 한다.**

`AuthorizationFilter`는 표의 13번, 즉 맨 끝이다. 그러므로 **그보다 앞이기만 하면 어디든 동작한다.** `addFilterBefore(jwtFilter, AuthorizationFilter.class)`도, `addFilterAfter(jwtFilter, LogoutFilter.class)`도 인증 자체는 정상적으로 걸린다.

그런데도 관례적으로 `UsernamePasswordAuthenticationFilter`를 기준점으로 쓰는 이유는 이렇다.

**그 자리가 "인증 필터 구간"의 대표 좌표이기 때문이다.** 표의 8번 구간이 인증을 시도하는 필터들이 모여 있는 자리이고, 그중 가장 널리 알려진 이름이 폼 로그인 필터다. **폼 로그인을 전혀 쓰지 않아도 위치 앵커로는 유효하다** — `addFilterBefore`는 대상 필터가 체인에 실제로 존재하는지가 아니라 `FilterOrderRegistration`에 등록된 **순서 값**만 참조하기 때문이다.

여기서 실수 하나를 미리 막아둘 만하다. `addFilterBefore`/`addFilterAfter`의 기준 클래스는 그 등록표에 있는 필터여야 한다. 우리가 만든 다른 커스텀 필터를 기준점으로 넘기면 기동 시점에 `The Filter class ... does not have a registered order`로 터진다. **커스텀 필터 두 개의 상대 순서를 잡으려면, 둘 다 서로 다른 표준 필터를 기준으로 삼아 간접적으로 배치**해야 한다.

### 3-5. 커스텀 필터가 예외를 던지면 어디로 가는가 (실무 함정)

3-4 코드에서 `catch (JwtException e)`를 두고 예외를 밖으로 안 던진 이유가 여기 있다. **직관과 반대라서 실제로 자주 틀린다.**

`ExceptionTranslationFilter`는 표의 12번이고, 하는 일은 `chain.doFilter()`를 `try`로 감싸는 것이다. 즉 **자기보다 뒤에 오는 것들에서 올라온 예외만 잡는다.** 그런데 커스텀 JWT 필터는 8번 구간, 즉 **12번보다 앞**에 있다.

```text
... ─▶ [8] JwtAuthenticationFilter ─▶ ... ─▶ [12] ExceptionTranslationFilter ─▶ [13] AuthorizationFilter
         │                                        │  try {                            │
         │  여기서 던진 예외는                     │      chain.doFilter(...)  ────────┘
         │  아래로 내려가지 않고 위로 올라간다      │  } catch (AuthenticationException
         │                                        │         | AccessDeniedException e) { ... }
         ▼                                        │
   FilterChainProxy 를 뚫고 톰캣까지 전파          └─ 12번의 try 안에 있는 것은 13번뿐이다
         │
         ▼
   톰캣이 /error 로 ERROR 디스패치
         │
         ▼
   부트 기본 JSON 또는 Whitelabel HTML  ← 우리 팀 표준 에러 포맷이 아니다
```

**결과가 "401 JSON"이 아니라 "500 Whitelabel"이 된다.** 프런트엔드 입장에서는 JSON을 기대하고 파싱하다가 `Unexpected token '<'`로 터지는 그 증상이다. 필터 계층의 예외가 `@ControllerAdvice`에 도달하지 못하는 것과 같은 원리이고, 그 인과는 `06-filter-vs-interceptor.md`의 2-3절에 정면으로 설명돼 있다.

그래서 커스텀 인증 필터에서 토큰이 잘못됐을 때 취할 수 있는 길은 둘이다.

**길 ①(권장): 컨텍스트를 비워둔 채 통과시킨다.** 그러면 `AuthorizationFilter`가 "인증 안 된 요청"으로 판정해 `AccessDeniedException`을 던지고, 그것이 12번의 `try`에 잡혀 규격에 맞는 401이 나간다. 3-4 코드가 이 길이다. **판정 책임을 한곳(인가 단계)에 모으는 설계**라는 점에서도 낫다.

**길 ②: 필터 안에서 `AuthenticationEntryPoint`를 직접 호출한다.** "토큰 만료"와 "토큰 위조"를 다른 에러 코드로 구분해 응답해야 하는 등, 실패 사유를 응답에 실어야 할 때 쓴다.

```java
// 길 ②: 실패 사유를 구분해야 할 때 — 엔트리포인트를 주입받아 직접 호출한다
} catch (ExpiredJwtException e) {
    SecurityContextHolder.clearContext();
    // commence() 가 응답을 직접 쓴다. 응답이 이미 커밋됐으므로 chain.doFilter 를 부르면 안 된다.
    authenticationEntryPoint.commence(req, res, new CredentialsExpiredException("토큰 만료", e));
    return;
}
```

어느 길이든 **응답 포맷은 `AuthenticationEntryPoint`/`AccessDeniedHandler` 한 쌍이 결정한다.** 그 둘이 `@ControllerAdvice`가 만드는 에러 응답과 같은 JSON 스키마를 내도록 공통 생성기(`ErrorResponseWriter`) 하나를 공유시키는 방법은 `19-global-exception-handling-error-response.md`의 3-3절에 코드까지 나와 있다. 그걸 안 하면 "인증 에러만 `traceId`가 없는" 응답이 만들어진다.

### 3-6. `ExceptionTranslationFilter` — 401과 403의 갈림길

이 절이 이 문서의 실무 핵심이다. **"왜 401이 나왔지"의 답은 거의 항상 여기 있다.**

먼저 두 상태 코드의 의미부터 정확히 갈라놓는다. 이름이 헷갈리게 붙어 있어서(401의 공식 명칭이 `Unauthorized`다) 반대로 아는 사람이 많다.

| 코드 | 이름 | 뜻 | 클라이언트가 할 일 |
|---|---|---|---|
| **401** | Unauthorized | **누군지 모른다.** 인증 자체가 안 됐거나 실패했다 | 로그인해서 자격 증명을 갖고 다시 오라 |
| **403** | Forbidden | **누군지는 안다. 그런데 안 된다.** 인증은 됐고 권한이 부족하다 | 다시 시도해도 소용없다. 권한을 받아야 한다 |

**핵심은 "재시도가 의미 있는가"다.** 401은 "자격 증명을 갖춰 오면 될 수도 있다"는 뜻이라 클라이언트가 로그인 화면으로 보내는 것이 옳고, 403은 "이 사람으로는 아무리 다시 와도 안 된다"는 뜻이라 로그인 화면으로 보내면 무한 루프가 된다. 프런트엔드의 응답 인터셉터가 이 둘을 다르게 처리해야 하는 이유가 여기 있다.

이 갈림을 실제로 수행하는 코드가 `ExceptionTranslationFilter`다. 6.5 소스의 판정 로직을 그대로 옮기면 이렇다.

```text
chain.doFilter() 를 try 로 감싸고 있다가 예외를 받는다
        │
        ├─ AuthenticationException 이면
        │     → 무조건 AuthenticationEntryPoint.commence()   ── 401 (또는 로그인 리다이렉트)
        │
        └─ AccessDeniedException 이면
              현재 SecurityContext 의 Authentication 을 꺼내
              AuthenticationTrustResolver 에게 물어본다
                 │
                 ├─ 익명(anonymous) 이거나 remember-me 냐?
                 │     → 예: "제대로 인증한 적이 없는 사람" 이므로
                 │            InsufficientAuthenticationException 으로 바꿔
                 │            AuthenticationEntryPoint.commence()  ── 401
                 │
                 └─ 아니오: 정식으로 인증된 사용자인데 권한이 부족한 것
                            → AccessDeniedHandler.handle()          ── 403
```

여기서 **10번 `AnonymousAuthenticationFilter`가 왜 존재하는지**가 풀린다. 그 필터는 인증되지 않은 요청에도 `AnonymousAuthenticationToken`이라는 "익명 신분증"을 채워 넣는다. 덕분에 뒤쪽 코드는 `authentication`이 `null`인 경우를 따로 분기할 필요가 없어지고, `ExceptionTranslationFilter`는 **"익명인가 아닌가"라는 한 가지 질문만으로 401과 403을 가를 수 있다.** `null` 체크 대신 널 오브젝트를 쓰는 전형적인 설계다.

remember-me도 익명과 같이 401 쪽으로 보내는 것이 흥미로운 지점이다. 자동 로그인 쿠키로 들어온 사용자는 "본인이 방금 비밀번호를 입력한 사람"이 아니므로, 민감한 자원 앞에서는 **다시 제대로 인증하라고 요구하는 것**이 맞다는 판단이다.

`sendStartAuthentication()`이 하는 일도 짚어둘 만하다. 엔트리포인트를 부르기 전에 **`SecurityContextHolder`를 비우고**, `RequestCache`에 **원래 가려던 요청을 저장**한다. 전자는 더 이상 유효하지 않다고 판단된 인증 정보를 남겨두지 않기 위해서고, 후자는 폼 로그인에서 **로그인 후 원래 페이지로 되돌려 보내기** 위해서다.

```java
// 401/403 응답의 포맷을 우리 표준으로 바꾸는 자리 — 이 두 개가 전부다
http.exceptionHandling(ex -> ex
        .authenticationEntryPoint(authenticationEntryPoint)   // 401 을 만드는 자리
        .accessDeniedHandler(accessDeniedHandler));           // 403 을 만드는 자리
```

**주의할 점 하나.** 3-2 끝에서 본 대로 `AbstractAuthenticationProcessingFilter`(폼 로그인 계열)는 자기 안에서 `AuthenticationException`을 직접 잡아 `failureHandler`로 처리한다. 그래서 **폼 로그인 실패는 `AuthenticationEntryPoint`를 거치지 않는다.** "엔트리포인트를 갈아끼웠는데 로그인 실패 응답만 안 바뀐다"는 혼란의 원인이 이것이다. 그쪽은 `failureHandler`를 따로 지정해야 한다.

**주의할 점 둘.** 스프링 시큐리티 6의 `AuthorizationFilter`는 기본값이 `observeOncePerRequest = false`라, **`ERROR`·`FORWARD` 디스패치에서도 인가 판정을 다시 수행한다**(5.x는 요청당 1회였다). 그래서 예외 발생 후 톰캣이 `/error`로 재진입할 때 그 `/error` 요청 자체가 인가에 걸려 **원래 에러 대신 403이 나가는** 일이 생긴다. 401을 기대했는데 403이 나오는 사례의 상당수가 이 경로다. 대응은 디스패치 타입으로 허용해 주는 것이다.

```java
.authorizeHttpRequests(auth -> auth
    // ERROR 디스패치는 이미 한 번 판정을 거친 요청의 뒷정리다. 여기서 다시 막지 않는다.
    .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
    .anyRequest().authenticated())
```

## 4. 꼬리질문 대비 포인트

### "인증은 정확히 어느 시점에 처리되나요?"

**컨트롤러보다 훨씬 앞, 서블릿 필터 체인의 중간**이다. 순서를 그대로 말하면 된다 — `DelegatingFilterProxy`(order -100)가 컨테이너에서 요청을 받아 `FilterChainProxy`에 넘기고, `FilterChainProxy`가 요청에 매칭되는 `SecurityFilterChain` 하나를 골라 그 안의 필터들을 순서대로 태운다. 그 목록의 중간쯤에 있는 인증 필터가 credential을 검증해 `SecurityContextHolder`를 채우고, 맨 끝의 `AuthorizationFilter`가 그것을 읽어 인가를 판정한 뒤에야 `DispatcherServlet`으로 넘어간다.

그래서 **401은 컨트롤러가 실행되기 전에 이미 결정된다.** 컨트롤러에 브레이크포인트를 걸어도 안 걸리는 이유가 이것이고, 401을 추적할 자리는 컨트롤러가 아니라 `ExceptionTranslationFilter`와 그 앞의 인증 필터다.

### "커스텀 JWT 필터를 왜 하필 `UsernamePasswordAuthenticationFilter` 앞에 두나요?" (시니어 변별 포인트)

**그 자리여야만 하는 것은 아니라는 점부터 말하는 것이 정답이다.** 진짜 제약은 하나뿐이다 — **맨 끝의 `AuthorizationFilter`가 판정하기 전에 `SecurityContext`가 채워져 있어야 한다.** 그보다 앞이기만 하면 위치는 자유롭다.

`UsernamePasswordAuthenticationFilter`를 기준점으로 쓰는 것은 **그 자리가 "인증 필터들이 모여 있는 구간"의 대표 좌표라서 읽는 사람에게 의도가 즉시 전달되기 때문**이다. 폼 로그인을 안 써서 그 필터가 체인에 없더라도 앵커로는 유효하다 — `addFilterBefore`는 `FilterOrderRegistration`에 등록된 순서 값만 참조한다.

여기에 **"기준 클래스는 그 등록표에 있는 표준 필터여야 하고, 커스텀 필터를 기준점으로 넘기면 `does not have a registered order`로 기동이 실패한다"**까지 붙이면 실제로 손으로 짜 본 사람이라는 신호가 된다.

### "체인이 여러 개면 어떻게 선택되나요? 잘못 놓으면 무슨 일이 생기나요?" (시니어 변별 포인트)

`FilterChainProxy`가 목록을 **위에서부터 훑어 매칭되는 첫 하나만** 실행한다. 둘 다 실행되는 일은 없다.

그래서 **넓은 경로 체인을 앞에 두면 뒤의 좁은 경로 체인이 통째로 무시된다.** `/api/**` 체인이 `@Order(1)`, `/api/admin/**` 체인이 `@Order(2)`라면 `/api/admin/orders` 요청은 첫 체인에서 끝나고, 관리자 체인의 `hasRole("ADMIN")`은 존재하지 않는 규칙이 된다 — **일반 사용자 토큰으로 관리자 API가 열리는** 보안 사고다.

규칙은 둘이다. **좁은 매처를 앞에, 넓은 매처를 뒤에.** 그리고 **`securityMatcher`가 없는 체인(= 모든 요청 매칭)은 반드시 마지막에.**

여기에 두 가지를 더 얹으면 답이 완성된다. 첫째, 스프링 시큐리티 6.5의 `WebSecurityFilterChainValidator`는 **"모든 요청" 체인이 다른 체인보다 앞에 있는 경우**만 기동 시점에 `UnreachableFilterChainException`으로 막아준다 — 위 예시처럼 부분적으로 겹치는 경로는 **여전히 조용히 가려진다.** 둘째, 그래서 `logging.level.org.springframework.security=DEBUG`의 기동 로그(`Will secure ... with filters: ...`)로 체인 구성을 눈으로 확인하고, 의심되면 `FilterChainProxy`를 TRACE로 올려 `Trying to match request against ... (1/3)`에서 실제로 몇 번 체인이 선택되는지 본다.

### "401과 403은 어디서 갈리나요?"

`ExceptionTranslationFilter`다. 판정 규칙은 정확히 이렇다.

- `AuthenticationException`이 올라오면 → 무조건 `AuthenticationEntryPoint` → **401**
- `AccessDeniedException`이 올라오면 → 현재 `Authentication`이 **익명이거나 remember-me면** `AuthenticationEntryPoint` → **401**, **정식 인증된 사용자면** `AccessDeniedHandler` → **403**

의미로 옮기면 **"누군지 모르면 401, 누군지는 아는데 안 되면 403"**이다. 401은 "자격 증명을 갖춰 오면 될 수도 있다"이고 403은 "다시 와도 소용없다"이므로, 프런트엔드가 401만 로그인 화면으로 보내야 한다.

여기서 `AnonymousAuthenticationFilter`의 존재 이유를 함께 말하면 좋다. 미인증 요청에도 익명 토큰을 채워 넣기 때문에, 뒤쪽 코드가 `null` 분기 없이 **"익명인가 아닌가"** 한 가지 질문만으로 401/403을 가를 수 있다.

**가산점 포인트**: 스프링 시큐리티 6의 `AuthorizationFilter`는 `ERROR` 디스패치에서도 인가를 다시 수행하므로, `/error` 재진입이 인가에 걸려 **원래 401 대신 403이 나가는** 함정이 있다. `dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()`로 뚫어준다.

### "permitAll이면 필터를 안 타나요?"

**탄다.** `permitAll`은 맨 끝 `AuthorizationFilter`가 내리는 **판정 결과**일 뿐, 그 앞의 필터들은 전부 실행된다. 그래서 공개 API 요청도 커스텀 JWT 필터를 통과하고, 그 필터가 토큰이 없다는 이유로 401을 직접 써버리면 **공개 API까지 막힌다.** 3-4의 필터가 실패해도 그냥 통과시키는 이유가 이것이다.

체인 자체를 건너뛰려면 `WebSecurityCustomizer.ignoring()`을 쓴다. 다만 이건 시큐리티가 **아예 관여하지 않는** 상태라 보안 응답 헤더 삽입과 `SecurityContext` 복원까지 전부 빠진다. **정적 리소스 외에는 권장되지 않고**, 대신 체인 안에서 `permitAll`로 여는 편이 안전하다. TRACE 로그에서 `No security for GET /...`로 찍히는 경로가 이쪽이다.

### "세션 방식과 토큰 방식은 인증 복원이 어떻게 다른가요?"

**세션 방식**은 로그인 요청 1회만 진짜 인증을 하고, 결과를 `SecurityContextRepository`(기본은 세션)에 저장한다. 이후 모든 요청은 `SecurityContextHolderFilter`가 세션에서 컨텍스트를 **복원**할 뿐 재인증하지 않는다.

**토큰(STATELESS) 방식**은 서버가 인증 상태를 저장하지 않으므로 복원할 것이 없다. **매 요청마다 커스텀 필터가 토큰을 검증해 컨텍스트를 새로 채운다.**

**가산점 포인트**: 스프링 시큐리티 6에서 저장 정책이 바뀌었다는 사실을 얹으면 좋다. 6.0부터 기본 필터가 `SecurityContextHolderFilter`로 바뀌면서 **요청 끝의 자동 저장이 사라졌다** — 저장은 인증 필터가 `securityContextRepository.saveContext(...)`를 명시적으로 호출해서 한다. 그래서 세션 기반인데 커스텀 필터로 인증을 심는 경우, `SecurityContextHolder`에 세팅만 하고 저장을 빠뜨리면 **다음 요청에서 인증이 사라진다.** 5.x에서 6.x로 올린 프로젝트에서 실제로 겪는 회귀다.

### "`@Async` 안에서 `SecurityContextHolder.getContext()`가 비는 이유는요?"

`SecurityContextHolder`의 기본 전략이 `ThreadLocal`이기 때문이다. `ThreadLocal`은 스레드마다 별도의 저장 칸이고, 스레드 풀에 넘어가는 것은 실행할 코드뿐이라 **호출자 스레드의 저장소는 넘어가지 않는다.** 새 스레드는 언제나 빈손으로 시작한다.

같은 원인에서 트랜잭션 미전파와 MDC trace id 유실도 함께 나온다 — 셋 다 `ThreadLocal`에 있기 때문이다(`15-async-annotation.md` 3-2).

대응은 **필요한 값만 인자로 넘기는 것이 가장 단순하고 대체로 옳고**, 컨텍스트 자체가 필요하면 `DelegatingSecurityContextAsyncTaskExecutor`로 실행기를 감싸거나 `TaskDecorator`로 직접 캡처·복원한다. 직접 짤 때는 **작업이 끝나면 반드시 지워야 한다** — 풀 스레드는 재사용되므로, 안 지우면 앞 사용자의 인증 정보로 다음 작업이 도는 보안 사고가 된다.

### "커스텀 필터에서 던진 예외가 왜 우리 팀 에러 포맷으로 안 나오나요?" (시니어 변별 포인트)

**`ExceptionTranslationFilter`는 자기보다 뒤에서 올라온 예외만 잡기 때문이다.** 그 필터는 `chain.doFilter()`를 `try`로 감싸는 구조인데, 커스텀 인증 필터는 그보다 **앞**에 있다. 그러니 그 예외는 `try` 블록 안에 들어온 적이 없다.

결과적으로 예외는 `FilterChainProxy`를 뚫고 톰캣까지 올라가고, 톰캣이 `/error`로 ERROR 디스패치를 걸어 부트 기본 JSON이나 Whitelabel HTML이 나간다. 프런트가 JSON을 파싱하다 `Unexpected token '<'`로 터지는 그 증상이다.

대응은 둘이다. **① 필터에서 컨텍스트를 비운 채 통과시켜 판정을 `AuthorizationFilter`에 맡긴다**(권장 — 판정 책임이 한곳에 모인다). **② 실패 사유를 응답에 구분해 실어야 하면 필터가 `AuthenticationEntryPoint.commence()`를 직접 호출한다.**

어느 쪽이든 응답 포맷은 `AuthenticationEntryPoint`/`AccessDeniedHandler`가 결정하므로, 그 둘이 `@ControllerAdvice`와 **같은 JSON 생성기를 공유하게** 만들어야 포맷이 하나로 유지된다(`19-global-exception-handling-error-response.md` 3-3).

### "`AuthenticationManager`와 `AuthenticationProvider`의 관계는요?"

`AuthenticationManager`는 "이 인증 요청을 검증해 달라"는 단일 진입점 인터페이스이고, 기본 구현체 `ProviderManager`는 **스스로 검증하지 않고 등록된 `AuthenticationProvider` 목록을 순회하는 컴포지트**다. 각 Provider의 `supports(토큰 타입)`를 물어보고, 참인 것에게 `authenticate()`를 시킨다.

이렇게 갈라놓은 이유는 **한 애플리케이션이 인증 수단을 여럿 지원하는 것이 정상**이기 때문이다. 폼 로그인은 `DaoAuthenticationProvider`(`UserDetailsService` 조회 + `PasswordEncoder` 대조), LDAP은 `LdapAuthenticationProvider`, 자체 토큰은 우리가 만든 Provider가 맡는다. **새 인증 수단 추가가 "Provider 하나 등록"으로 끝나는 확장 구조**라는 점이 핵심이다.

---

## 한 줄 요약

스프링 시큐리티는 "누구인가"(인증)와 "이걸 해도 되는가"(인가)를 서블릿 필터 체인의 서로 다른 자리에 놓은 구조여서 — `DelegatingFilterProxy`(order -100)가 컨테이너와 스프링 사이의 다리를 놓고, `FilterChainProxy`가 요청에 매칭되는 **첫 체인 하나만** 태우며(그래서 넓은 경로 체인을 앞에 두면 뒤 체인이 통째로 무시된다), 그 체인 안에서 중간의 인증 필터가 `SecurityContextHolder`(ThreadLocal이라 `@Async`에는 전파되지 않는다)를 채우면 맨 끝의 `AuthorizationFilter`가 그걸 읽어 판정하고 `ExceptionTranslationFilter`가 미인증이면 401·권한 부족이면 403으로 번역한다 — 커스텀 JWT 필터의 위치 제약은 "인가 필터보다 앞" 하나뿐이고 `UsernamePasswordAuthenticationFilter`는 그 구간을 가리키는 관례적 좌표일 뿐이다.
