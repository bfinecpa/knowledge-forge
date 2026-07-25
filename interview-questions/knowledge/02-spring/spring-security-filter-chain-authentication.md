# Spring Security 필터 체인 — 인증은 언제 처리되고, 커스텀 필터는 어디에 끼우는가

> 핵심 관전 포인트: Spring Security는 서블릿 필터 체인에 **`DelegatingFilterProxy` → `FilterChainProxy`(order -100)** 로 끼어든 **순서 있는 필터 목록**이다. **인증은 체인 중간의 인증 필터들**(UsernamePasswordAuthenticationFilter 등)이 처리해 결과를 **SecurityContextHolder(ThreadLocal)** 에 담고, **인가는 맨 끝의 AuthorizationFilter**가 그 컨텍스트를 읽어 판정한다. 커스텀 토큰(JWT) 필터는 `addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class)` — **인가 필터가 판정하기 전에 SecurityContext를 채워야 하기 때문**에 인증 단계 자리에 끼운다.

## 0. 질문 + 의도

**질문**: "Spring Security 필터 체인에서 인증은 어느 시점에 처리되나요?
커스텀 인증 필터는 어디에 끼우나요?"

**출제 의도**: "401이 어디서 나왔는가"를 추적하려면 인증이 컨트롤러 훨씬
앞의 필터에서 일어남을 알아야 한다. 인증/인가 실무의 디버깅 기초 체력을
확인하는 질문으로, 커스텀 필터의 위치 선정 근거(인가 필터가 판정하기 전에
SecurityContext를 채워야 함)까지 말하는지로 이해의 깊이를 잰다.

## 1. 전체 구조 — 서블릿 필터 체인에 어떻게 끼어드나

```
서블릿 컨테이너 필터 체인
└─ DelegatingFilterProxy (order = -100, SecurityProperties.DEFAULT_FILTER_ORDER)
   └─ FilterChainProxy (빈 이름: springSecurityFilterChain)
      ├─ SecurityFilterChain #1 (securityMatcher: /api/**)   ← 요청당 매칭되는 첫 체인 하나만 실행
      ├─ SecurityFilterChain #2 (securityMatcher: /admin/**)
      └─ SecurityFilterChain #3 (anyRequest)
```

- `DelegatingFilterProxy`: 서블릿 컨테이너에 등록되는 껍데기 — 실제 일은 스프링 빈(`springSecurityFilterChain`)에 위임. 서블릿 필터는 스프링 빈이 아니라서 이 다리가 필요하다.
- `FilterChainProxy`: `SecurityFilterChain` 목록을 들고, **요청 URL에 매칭되는 첫 번째 체인 하나만** 태운다 → API용/관리자용 인증 방식을 체인 단위로 분리 가능.
- trace/MDC 필터를 Security보다 앞에 두려면 order < -100 (`02-spring` [Q6] 참고).

## 2. 체인 내부 필터 순서 — 인증은 중간, 인가는 맨 끝

| 순서 | 필터 | 역할 |
|---|---|---|
| 1 | `SecurityContextHolderFilter` | 세션 등 저장소에서 기존 SecurityContext **복원** |
| 2 | `CsrfFilter` | CSRF 토큰 검증 |
| 3 | `LogoutFilter` | /logout 매칭 시 로그아웃 처리 후 체인 종료 |
| 4 | **인증 필터들** — `UsernamePasswordAuthenticationFilter`(폼), `BasicAuthenticationFilter`, OAuth2 계열, (커스텀 JWT 필터가 끼는 자리) | credential 검증 → SecurityContext **채움** |
| 5 | `AnonymousAuthenticationFilter` | 여기까지 미인증이면 익명 Authentication 부여 |
| 6 | `ExceptionTranslationFilter` | 아래에서 올라온 예외를 401/403 응답으로 **변환** |
| 7 | `AuthorizationFilter` (맨 끝, 구 FilterSecurityInterceptor) | SecurityContext를 읽어 **인가 판정** → 통과 시 DispatcherServlet으로 |

핵심 시점 구분: **인증(4번, 중간) → 인가(7번, 맨 끝)**. 인가 필터는 "SecurityContext에 뭐가 들어 있는가"만 본다 — 그래서 인증 필터는 반드시 그보다 앞이어야 한다.

## 3. 인증 필터의 공통 동작 5단계

```
① 요청에서 credential 추출 (폼 파라미터 / Authorization 헤더 / 토큰)
② 미인증 Authentication 객체 생성 (예: UsernamePasswordAuthenticationToken.unauthenticated(...))
③ AuthenticationManager(구현체 ProviderManager)에 위임
   → 등록된 AuthenticationProvider들을 순회, supports() 맞는 것이 authenticate()
     (예: DaoAuthenticationProvider = UserDetailsService 조회 + PasswordEncoder 대조)
④ 성공: 인증된 Authentication을 SecurityContextHolder(ThreadLocal)에 저장
⑤ 실패: AuthenticationException → 401 (EntryPoint/failureHandler)
```

- `SecurityContextHolder`는 **ThreadLocal** — 트랜잭션 커넥션 바인딩(`transaction-synchronization-connection-binding.md`)과 같은 메커니즘, 같은 함정: **@Async 새 스레드에는 전파되지 않는다**(대책: `DelegatingSecurityContextAsyncTaskExecutor` 또는 TaskDecorator 복사 — 읽기용 컨텍스트라 커넥션과 달리 복사가 안전).

## 4. 커스텀 토큰(JWT) 필터 — 구현과 위치

```java
public class JwtAuthenticationFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String token = resolveBearerToken(req);                       // ① 추출
        if (token != null && jwtProvider.validate(token)) {           // ② 검증 (서명·만료)
            Authentication auth = jwtProvider.toAuthentication(token);
            SecurityContextHolder.getContext().setAuthentication(auth); // ③ 컨텍스트 채움
        }
        chain.doFilter(req, res);  // 실패해도 통과 — 최종 판정은 AuthorizationFilter의 몫
    }
}
```

```java
http.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
    .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
```

- **왜 이 위치인가**: 맨 끝 `AuthorizationFilter`가 판정하기 **전에** SecurityContext가 채워져 있어야 하고, "인증 단계"의 관례적 자리가 UsernamePasswordAuthenticationFilter 슬롯이기 때문. (그 폼 로그인 필터를 안 쓰더라도 위치 앵커로 유효)
- 필터 안에서 401을 직접 쓰지 않고 통과시키는 이유: permitAll 경로도 이 필터를 타기 때문 — 거부는 인가 단계와 `ExceptionTranslationFilter`에 맡긴다.

## 5. ExceptionTranslationFilter — 401과 403의 갈림길

`AuthorizationFilter`가 던진 `AccessDeniedException`을 받아서:
- 현재 사용자가 **익명(미인증)** → "인증부터 하라" = `AuthenticationEntryPoint` → **401**(또는 로그인 리다이렉트)
- **인증됐지만 권한 부족** → `AccessDeniedHandler` → **403**

401/403이 갈리는 지점이 여기다 — 커스텀 에러 응답 표준화도 EntryPoint/Handler 교체로 한다.

## 6. 꼬리질문 대비 포인트

- **"permitAll이면 필터를 안 타나?"** — 탄다. permitAll은 AuthorizationFilter의 **판정 결과**일 뿐, 체인은 전부 통과한다. 체인 자체를 우회하는 건 `WebSecurityCustomizer.ignoring()` — 단 보안 헤더·컨텍스트 복원까지 다 빠지므로 정적 리소스 외 비권장.
- **"세션 방식과 토큰 방식의 복원 차이는?"** — 세션: 로그인 시 1회 인증 후 `SecurityContextHolderFilter`가 매 요청 세션에서 컨텍스트 **복원**. 토큰(STATELESS): 저장소가 없으니 **매 요청 커스텀 필터가 재인증**해 컨텍스트를 새로 채움.
- **"AuthenticationManager와 Provider의 관계는?"** — ProviderManager가 Provider 목록을 순회하는 컴포지트. 토큰·폼·LDAP 등 인증 수단마다 Provider를 추가하는 확장 구조.
- **"@Async 안에서 SecurityContextHolder.getContext()가 비는 이유는?"** — ThreadLocal 미전파. 3번 참고.

## 한 줄 요약

Spring Security는 order -100의 FilterChainProxy가 태우는 순서 있는 필터 목록으로, 체인 중간의 인증 필터가 SecurityContextHolder(ThreadLocal)를 채우면 맨 끝의 AuthorizationFilter가 그걸 읽어 인가를 판정한다 — 그래서 커스텀 JWT 필터는 `addFilterBefore(..., UsernamePasswordAuthenticationFilter.class)`로 인가보다 앞에 끼우고, 401/403 변환은 ExceptionTranslationFilter가 맡는다.
