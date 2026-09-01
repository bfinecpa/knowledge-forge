# CORS와 Preflight — "CORS 에러 나요"에 원리로 답하기

> 핵심 관전 포인트: **CORS(Cross-Origin Resource Sharing)는 브라우저의
> 동일 출처 정책(Same-Origin Policy)이 막아 놓은 교차 출처 요청을,
> 서버가 응답 헤더로 "이 출처는 허용한다"고 명시적으로 동의해 줄 때만
> 풀어주는 브라우저 시스템이다. preflight는 본 요청이 서버에 도달하기
> 전에 브라우저가 OPTIONS 요청으로 "이런 메서드·헤더의 요청을 보내도
> 되나요?"라고 미리 허락을 구하는 절차다 — CORS라는 개념이 없던 시절에
> 만들어진 서버들이, 브라우저가 갑자기 보낼 수 있게 된 새로운 형태의
> 교차 출처 요청(PUT/DELETE, 커스텀 헤더 등)에 무방비로 노출되지 않도록
> 보호하기 위해 존재한다. 그리고 이 모든 것은 **브라우저가** 집행하는
> 규칙이다 — 서버 간 호출이나 curl에는 CORS가 아예 없다.**

---

## 0. 질문 + 의도

**질문**: "CORS란 무엇이고 preflight 요청은 왜 필요한가요?"

**출제 의도**: 프론트엔드와 협업하는 백엔드가 가장 자주 받는 질문
("CORS 에러 나요")에 원리로 답할 수 있는지 본다. 원리를 모르면
스택오버플로 복붙 설정(`*` 허용)으로 보안 구멍을 만든다 — 에러를
없애는 사람이 아니라, 왜 막혔는지 이해하고 필요한 만큼만 여는
사람인지를 가리는 질문이다.

## 1. 출발점 — 동일 출처 정책(SOP)이 먼저다

CORS를 이해하려면 순서가 중요하다. **원래 브라우저는 교차 출처
요청의 응답을 스크립트가 읽지 못하게 막는다**(동일 출처 정책).
CORS는 이 기본 차단을 "서버 동의 하에" 풀어주는 예외 절차다.
즉 CORS는 뭔가를 막는 기술이 아니라 **열어주는 기술**이다.

- **출처(origin)** = 스킴 + 호스트 + 포트의 조합. 셋 중 하나라도
  다르면 다른 출처다.
  - `https://app.example.com` 과 `https://api.example.com` → 다른 출처
    (호스트가 다름)
  - `http://localhost:3000` 과 `http://localhost:8080` → 다른 출처
    (포트가 다름)

왜 이런 정책이 있나? 브라우저에는 사용자의 **쿠키(로그인 세션)**가
실려 있다. SOP가 없다면 악성 사이트의 스크립트가 사용자의 브라우저를
빌려 `bank.com`에 요청을 보내고 **그 응답(내 계좌 정보)을 읽어갈 수
있다.** SOP는 "요청은 갈 수 있어도 응답은 못 읽는다"는 방어선이다.

- 비유: 아파트(브라우저) 경비실의 규칙이다. 다른 동(다른 출처)에서 온
  택배 기사는, 수신 세대(서버)가 "그 사람 들여보내세요"라고 명시한
  경우에만 통과시킨다. 규칙을 집행하는 주체는 **각 세대가 아니라
  경비실(브라우저)**이다.

## 2. CORS 동작 — 서버의 동의를 헤더로 주고받는다

프론트(`https://app.example.com`)가 API(`https://api.example.com`)를
호출하는 흐름:

```http
# 브라우저가 요청에 출처를 자동으로 붙인다 (스크립트가 위조 불가)
GET /me HTTP/1.1
Host: api.example.com
Origin: https://app.example.com

# 서버가 동의를 표시하면 → 브라우저가 응답을 스크립트에 넘겨준다
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
```

서버가 `Access-Control-Allow-Origin`을 내려주지 않으면? **요청은
서버에서 정상 처리되고 200이 왔는데도**, 브라우저가 응답을 스크립트에
주지 않고 콘솔에 CORS 에러를 띄운다. "서버 로그엔 200인데 프론트는
CORS 에러"라는 흔한 혼란의 정체가 이것이다 — 차단의 주체가
서버가 아니라 브라우저이기 때문이다.

## 3. Preflight — 본 요청 전에 허락을 구하는 이유

### 왜 필요한가 — "CORS 이전 시대 서버 보호"

CORS가 생기기 전에도 브라우저는 교차 출처로 요청을 보낼 수 있었다 —
`<form>` 제출, `<img>` 태그 등이 그렇다. 그래서 그 시절부터 가능했던
형태의 요청(GET, 일반 폼 POST)은 **단순 요청(simple request)**으로
분류되어 지금도 preflight 없이 바로 나간다. 서버들은 원래부터 이런
요청을 받아왔으므로 새로운 위협이 아니다.

문제는 CORS로 인해 브라우저가 **새롭게** 보낼 수 있게 된 요청들이다 —
`PUT`/`DELETE`/`PATCH`, `Content-Type: application/json`,
`Authorization` 같은 커스텀 헤더. CORS 개념 없이 만들어진 기존
서버들은 "이런 요청은 브라우저에서 교차 출처로 올 리 없다"는 전제로
설계되어 있다. 그래서 브라우저는 이런 요청을 보내기 전에 **OPTIONS
요청으로 먼저 물어보고, 서버가 CORS를 이해하고 명시적으로 허용한
경우에만 본 요청을 보낸다.** 허락이 없으면 부수효과가 있는 본 요청
(DELETE 등)이 서버에 **도달조차 하지 않는다** — 이것이 preflight의
존재 이유다.

### Preflight 왕복의 실제 모습

```http
# 1) 브라우저가 본 요청 대신 먼저 보내는 사전 질의
OPTIONS /orders/42 HTTP/1.1
Origin: https://app.example.com
Access-Control-Request-Method: DELETE        # 이 메서드를 보내려는데
Access-Control-Request-Headers: authorization # 이 헤더를 실으려는데, 됩니까?

# 2) 서버의 허가 응답 (본문 없음, 보통 204)
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET, POST, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 3600   # 이 허가를 1시간 캐시 → 매번 안 물어봄

# 3) 허가가 떨어진 뒤에야 본 요청이 나간다
DELETE /orders/42 HTTP/1.1
Origin: https://app.example.com
Authorization: Bearer ...
```

실무에서 자주 밟는 함정: preflight는 브라우저가 보내는 **인증 없는
OPTIONS 요청**이다. 인증 필터가 OPTIONS까지 가로채 401을 주면
preflight가 실패해 본 요청이 영영 못 나간다 — OPTIONS는 인증 앞단에서
CORS 처리로 응답하게 구성해야 한다.

## 4. 실무 설정 — `*` 복붙이 만드는 구멍

에러를 급하게 없애려는 복붙 설정과 올바른 설정의 대비 (Spring 예시):

```java
// Before: "일단 되게" — 모든 출처 + 자격증명 허용 시도
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")   // 아무 사이트나 내 API 호출 가능
                .allowCredentials(true);      // 심지어 쿠키(로그인 세션)까지 실어서
        // → 악성 사이트가 방문자의 로그인 세션으로 내 API를 호출하고
        //   응답까지 읽어갈 수 있다. SOP가 막아주던 것을 내 손으로 연 셈.
        //   (스펙상 Allow-Origin: * 와 credentials는 조합 불가라서,
        //    이를 우회하려고 Origin을 그대로 반사(echo)하는 설정은 더 위험)
    }
}

// After: 신뢰하는 출처만 명시적 허용
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins("https://app.example.com") // 우리 프론트만
                .allowedMethods("GET", "POST", "PUT", "DELETE")
                .allowedHeaders("Authorization", "Content-Type")
                .allowCredentials(true)   // 허용 출처가 특정돼 있으니 안전
                .maxAge(3600);            // preflight 결과 캐시로 왕복 절감
    }
}
```

핵심 원칙: **`Access-Control-Allow-Origin: *`는 "누가 읽어가도 상관없는
공개 리소스"에만** 쓴다(공개 폰트, 공개 API). 쿠키·토큰이 실리는
API라면 반드시 출처 허용 목록(allowlist) 방식이어야 한다.

## 5. 꼬리질문 대비 포인트

### "서버 로그에는 200인데 프론트에서 CORS 에러가 납니다. 왜죠?"

CORS 차단의 집행자는 서버가 아니라 브라우저이기 때문이다. 단순 요청은
서버까지 가서 정상 처리되고, 응답이 브라우저에 도착한 뒤 허용 헤더가
없어서 **스크립트에 전달되는 단계에서** 차단된다. 즉 "CORS 에러 =
요청이 안 감"이 아니다 — 단순 요청은 이미 서버에서 실행됐을 수 있다.
(preflight가 필요한 요청이라면 반대로 본 요청이 아예 안 온 것이므로,
어떤 유형의 요청이었는지부터 확인한다.)

### "CORS를 설정했으니 우리 API는 안전한 건가요?" (시니어 변별 포인트)

아니다 — CORS는 **브라우저 안에서만 작동하는 규칙**이다. curl,
서버 간 호출, 모바일 앱, 공격자의 스크립트가 아닌 도구에는 아무런
제약이 없다. 따라서 CORS는 인증·인가를 대체하지 못하고, "교차 출처
요청 자체"를 막는 수단도 아니다. 또한 CORS를 올바르게 잠갔어도
CSRF(단순 요청·폼 제출은 preflight 없이 나간다는 점을 악용)는 별개로
방어해야 한다 — CORS와 CSRF 방어는 서로 다른 문제를 푼다는 구분이
시니어의 답변이다.

### "preflight 때문에 API가 느려진다는데, 줄이는 방법은?"

preflight는 본 요청마다 왕복(RTT)을 하나 추가할 수 있다. 대응은
세 방향: ① `Access-Control-Max-Age`로 preflight 결과를 브라우저에
캐시시켜 반복 왕복을 없앤다. ② 요청을 단순 요청 조건 안에 유지할 수
있으면 preflight 자체가 안 생긴다 (다만 이를 위해 설계를 비틀 필요는
없다). ③ 구조적으로는 교차 출처 상황 자체를 없앤다 — 같은 도메인
아래에서 리버스 프록시/게이트웨이가 `/api`를 백엔드로 라우팅하면
브라우저 입장에서 동일 출처가 되어 CORS가 아예 등장하지 않는다.
(가산점 포인트: preflight 캐시는 URL 단위라 첫 호출들엔 여전히
발생한다는 한계까지 언급)

### "어떤 요청이 preflight 없이 나가나요? (단순 요청의 조건)"

메서드가 GET/HEAD/POST이고, 헤더가 브라우저 기본 + 안전 목록
(`Accept`, `Accept-Language`, `Content-Language`, 그리고
`Content-Type`이 `application/x-www-form-urlencoded` ·
`multipart/form-data` · `text/plain` 중 하나)뿐일 때다. 실무 감각으로는
"옛날 HTML 폼으로도 보낼 수 있던 요청"이 단순 요청이다. 반대로
`Content-Type: application/json`이나 `Authorization` 헤더 하나만
붙어도 preflight 대상이 된다 — JSON API 호출 대부분에 preflight가
따라붙는 이유다.

### "CORS 허용 출처를 환경별로 관리하다 겪는 문제는?"

개발(localhost:3000), 스테이징, 운영 도메인이 달라 허용 목록을
환경설정으로 분리해야 한다. 흔한 사고 두 가지 — ① 운영 설정에
localhost가 남아 배포되는 것 (공격자가 로컬에서 운영 API를 세션과
함께 호출 가능), ② 서브도메인 와일드카드 패턴을 정규식으로 직접
구현하다 `evil-example.com`처럼 패턴을 우회하는 도메인까지 매칭되는
것. 출처 검증은 문자열 완전 일치 목록이 가장 안전하다.

---

## 한 줄 요약

CORS는 브라우저의 동일 출처 차단을 서버가 응답 헤더로 동의한 범위만큼
풀어주는 절차이고, preflight는 CORS 이전 시대 서버들이 예상 못 한
형태의 요청(PUT/DELETE, 커스텀 헤더)이 도달하기 전에 브라우저가
OPTIONS로 미리 허락을 구하는 보호 장치다 — 집행자는 언제나
브라우저이므로, CORS는 보안의 대체재가 아니라 "필요한 출처에만,
필요한 만큼만" 여는 설정의 문제다.
