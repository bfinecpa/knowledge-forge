# CORS와 Preflight — "CORS 에러 나요"에 원리로 답하기

> 핵심 관전 포인트: **CORS(Cross-Origin Resource Sharing, 교차 출처 자원 공유)는 브라우저의 동일 출처 정책(Same-Origin Policy)이 막아 놓은 교차 출처 접근을, 서버가 응답 헤더로 "이 출처는 허용한다"고 명시적으로 동의해 줄 때만 풀어주는 브라우저 시스템이다. 가장 먼저 바로잡아야 할 오해는 **CORS가 요청을 막는 것이 아니라 응답을 읽는 것을 막는다**는 점이다 — 그래서 "서버 로그에는 200인데 프론트에는 에러"가 나고, 그래서 **CORS는 서버의 보안 장치가 아니다**(curl과 서버 간 호출에는 아무 효력이 없다). preflight는 본 요청이 서버에 도달하기 전에 브라우저가 `OPTIONS`로 "이런 메서드·헤더의 요청을 보내도 되나요?"라고 미리 허락을 구하는 절차이며, CORS 이전 시대에 만들어진 서버들이 예상하지 못한 형태의 교차 출처 요청(PUT/DELETE, `application/json`, 커스텀 헤더)에 무방비로 노출되지 않도록 존재한다. 쿠키를 실어 보내려면 클라이언트의 `credentials: 'include'`와 서버의 `Access-Control-Allow-Credentials: true`가 짝이어야 하고 이때 `Access-Control-Allow-Origin: *`는 금지된다. 집행자는 언제나 브라우저이므로, CORS는 인증·인가의 대체재가 아니라 "필요한 출처에만, 필요한 만큼만" 여는 설정의 문제다.**

---

## 0. 질문 + 의도

**질문**: "CORS란 무엇이고 preflight 요청은 왜 필요한가요?"

**출제 의도**: 프론트엔드와 협업하는 백엔드가 가장 자주 받는 질문("CORS 에러 나요")에 원리로 답할 수 있는지 본다. 원리를 모르면 스택오버플로 복붙 설정(`*` 허용)으로 보안 구멍을 만든다 — 에러를 없애는 사람이 아니라, 왜 막혔는지 이해하고 필요한 만큼만 여는 사람인지를 가리는 질문이다.

## 1. 출발점 — 동일 출처 정책(SOP)이 먼저다

### 1-1. 순서를 뒤집지 않는다 — 막는 것은 SOP, 여는 것이 CORS

CORS를 이해하려면 순서가 중요하다. **원래 브라우저는 교차 출처 요청의 응답을 스크립트가 읽지 못하게 막아 놓았다.** 이 기본 차단을 **동일 출처 정책(Same-Origin Policy, SOP)**이라고 부른다. CORS는 이 차단을 "서버의 동의가 있을 때만" 풀어주는 예외 절차다.

즉 **CORS는 뭔가를 막는 기술이 아니라 열어주는 기술이다.** "CORS 때문에 막혔다"는 말은 정확히는 "SOP 때문에 막혔고 CORS 설정이 없어서 안 열렸다"는 뜻이다. 이 순서를 잡고 있으면 뒤의 모든 규칙이 "그래서 무엇을 열어줄지 서버가 어떻게 말하는가"로 정리된다.

### 1-2. 출처(origin)란 정확히 무엇인가

**출처(origin)는 스킴 + 호스트 + 포트의 조합**이다. 셋 중 하나라도 다르면 다른 출처다. 도메인만 보고 판단하면 틀린다.

| 기준 URL | 비교 대상 | 같은 출처인가 | 이유 |
|---|---|---|---|
| `https://app.example.com` | `https://app.example.com/orders/42` | 같음 | 경로는 출처의 구성 요소가 아니다 |
| `https://app.example.com` | `https://api.example.com` | 다름 | 호스트가 다르다 |
| `https://app.example.com` | `http://app.example.com` | 다름 | 스킴이 다르다 |
| `http://localhost:3000` | `http://localhost:8080` | 다름 | 포트가 다르다 |

로컬 개발에서 CORS를 처음 만나는 이유가 마지막 줄이다. 프론트는 3000번, 백엔드는 8080번에서 뜨므로 **같은 `localhost`인데도 브라우저에게는 남남**이다.

### 1-3. 왜 이런 정책이 있는가 — 브라우저에는 "자동으로 실리는 권한"이 있다

SOP가 없다면 무슨 일이 생기는지가 이 정책의 존재 이유다.

브라우저에는 사용자의 **쿠키(로그인 세션)**가 들어 있고, 이 쿠키는 목적지 도메인에 맞춰 **자동으로 첨부된다**(같은 장 `07-cookie-session-token-auth.md`의 자동 첨부 절). 즉 브라우저는 사용자 몰래도 인증된 요청을 만들어낼 수 있는 **권한을 상시 들고 다니는 도구**다. 이런 성질을 앰비언트 권한(ambient authority, 주변에 늘 깔려 있는 권한)이라고 부른다.

SOP가 없다면 사용자가 `evil.com`을 여는 순간 그 페이지의 스크립트가 `bank.com/api/accounts`를 호출하고, 브라우저가 자동으로 붙여준 세션 쿠키 덕분에 은행은 정상 요청으로 처리하며, **그 응답(내 계좌 정보)을 공격자 스크립트가 읽어 자기 서버로 보낼 수 있다.** 사용자는 은행 사이트를 열지도 않았는데 계좌가 통째로 유출된다.

그래서 SOP가 그은 선은 이것이다. **"요청은 나갈 수 있어도, 응답은 못 읽는다."**

이 선의 위치가 CORS 전체를 이해하는 열쇠다. 브라우저는 요청을 보내는 능력 자체를 막지 않는다(그러면 이미지·스크립트·폼 같은 웹의 기본 동작이 전부 깨진다). 대신 **읽기를 막는다.**

비유하면 아파트 경비실의 규칙이다. 다른 동(다른 출처)에서 온 사람이 우편함에 편지를 넣고 가는 것(요청)은 막지 않지만, **답장을 대신 받아 가는 것(응답 읽기)**은 수신 세대(서버)가 "그 사람에게 전달해도 됩니다"라고 명시한 경우에만 허용한다. 규칙을 집행하는 주체는 **각 세대가 아니라 경비실(브라우저)**이라는 점이 계속 따라붙는 핵심이다.

### 1-4. SOP가 모든 것을 막지는 않는다 — 이 예외가 CSRF를 낳는다

한 가지를 더 짚어야 다음 절이 자연스럽다. SOP는 **스크립트의 응답 읽기**를 막는 정책이지, 교차 출처 로드 전부를 막는 정책이 아니다. 웹은 원래 교차 출처로 자원을 가져다 쓰도록 설계됐고, 다음은 지금도 자유롭게 나간다.

```
<img src="https://other.com/a.png">      다른 출처 이미지 로드 — 허용(내용 읽기는 불가)
<script src="https://cdn.com/lib.js">    다른 출처 스크립트 실행 — 허용
<link rel="stylesheet" href="...">       다른 출처 CSS — 허용
<form action="https://bank.com/transfer" method="post">  교차 출처 폼 제출 — 허용
```

마지막 줄이 문제다. 폼 제출은 브라우저가 응답을 읽어 스크립트에 주는 것이 아니라 **화면을 이동시키는 동작**이므로 SOP의 대상이 아니다. 그런데 요청은 쿠키와 함께 실제로 서버에 도달하고 **이체는 실행된다.** 이것이 **CSRF(Cross-Site Request Forgery)**가 성립하는 자리다.

여기서 반드시 구분해야 할 것. **CORS와 CSRF 방어는 서로 다른 문제를 푼다.** CORS를 아무리 엄격하게 잠가도 폼 제출 기반 CSRF는 그대로 성립한다 — 공격자는 애초에 응답을 읽으려는 게 아니기 때문이다. CSRF는 `SameSite` 쿠키 속성과 CSRF 토큰으로 따로 막아야 한다.

## 2. CORS 동작 — 서버의 동의를 헤더로 주고받는다

### 2-1. 기본 흐름 — Origin을 보내고, 허용 헤더를 돌려받는다

프론트(`https://app.example.com`)가 API(`https://api.example.com`)를 호출하는 상황이다.

```http
# 브라우저가 요청에 출처를 자동으로 붙인다
GET /me HTTP/1.1
Host: api.example.com
Origin: https://app.example.com

# 서버가 동의를 표시하면 -> 브라우저가 응답을 스크립트에 넘겨준다
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Content-Type: application/json

{"userId":42,"name":"..."}
```

`Origin` 헤더는 **브라우저가 붙이며, 스크립트가 값을 바꿀 수 없다.** `fetch`의 헤더 옵션으로 `Origin`을 지정해도 무시된다(브라우저가 통제하는 금지된 헤더 목록에 들어 있다). 이 통제가 있어야 서버가 `Origin` 값을 판단 근거로 쓸 수 있다.

서버는 이 값을 보고 허용 대상이면 응답에 `Access-Control-Allow-Origin`을 실어 준다. 브라우저는 **응답을 받은 뒤** 이 헤더를 확인하고, 요청의 `Origin`과 맞으면 응답을 스크립트에 넘겨주고 아니면 넘겨주지 않는다.

### 2-2. 가장 중요한 오해 — CORS는 요청을 막지 않는다, 응답 읽기를 막는다

서버가 `Access-Control-Allow-Origin`을 내려주지 않으면 어떻게 되는가. 여기가 3년차가 가장 자주 잘못 알고 있는 지점이다.

**요청은 서버에 도달했고, 정상 처리됐고, 200이 돌아왔다.** 그런데 브라우저가 응답을 스크립트에 주지 않고 콘솔에 CORS 에러를 띄운다.

```
[실제로 일어나는 일]

  브라우저 --- GET /me (Origin: app.example.com) ---> 서버
                                                       |
                                        DB 조회, 로직 실행, 로그 200 기록
                                                       |
  브라우저 <--- 200 OK (Allow-Origin 헤더 없음) --------+
      |
      | 응답을 손에 쥐고 있지만, 허용 헤더가 없으므로
      | 스크립트에게 넘겨주지 않고 폐기한다
      v
  fetch()의 Promise가 reject -> 콘솔에 CORS 에러

  ★ 서버 입장에서는 아무 문제 없이 200을 준 요청이다.
    부수효과(주문 생성, 잔액 차감)가 있는 요청이었다면 그것도 이미 일어났다.
```

이 구조에서 두 가지 결론이 나온다.

**첫째, "CORS 에러 = 요청이 안 갔다"가 아니다.** 뒤에 볼 단순 요청은 이미 서버에서 실행됐을 수 있다. 그래서 CORS 에러가 났다고 "요청이 서버에 도달 안 했겠지"라고 판단하면 원인 분석이 어긋난다.

**둘째, CORS는 서버의 보안 장치가 아니다.** 집행자가 브라우저이므로, 브라우저가 아닌 클라이언트에게는 아무 효력이 없다.

```bash
# CORS를 아무리 엄격하게 잠가도 이 호출에는 아무 영향이 없다.
# curl은 SOP를 집행하지 않는다 — 응답이 그대로 출력된다.
$ curl -H 'Origin: https://evil.com' https://api.example.com/me
{"userId":42,"name":"..."}
```

서버 간 호출, 모바일 앱, 스크립트 도구, 공격자의 프록시 — 전부 마찬가지다. **CORS는 "브라우저에서 실행되는 남의 사이트 스크립트가 우리 응답을 읽어가는 것"만 막는다.** 인증·인가를 대체하지 못한다는 뜻이고, 이것을 아는지가 시니어 변별점이다.

에러 메시지를 읽는 감각도 하나 덧붙인다. CORS로 차단된 응답은 **상태 코드조차 스크립트에 전달되지 않는다.** `fetch`는 `TypeError: Failed to fetch`로 실패하고 `response.status`를 볼 수 없다. 그래서 프론트 개발자는 "500인지 403인지도 모르겠다"고 말하게 되고, 이때 원인은 개발자도구 네트워크 탭이나 **서버 로그**에서 확인해야 한다.

### 2-3. 단순 요청 — preflight 없이 바로 나가는 요청

브라우저는 교차 출처 요청을 두 부류로 나눈다. 하나는 그냥 보내는 것, 다른 하나는 미리 물어보고 보내는 것이다. 전자를 **단순 요청(simple request)**이라고 부른다.

기준은 세 가지가 **동시에** 성립할 때다.

**① 메서드가 `GET`, `HEAD`, `POST` 중 하나다.** `PUT`, `DELETE`, `PATCH`는 해당하지 않는다.

**② 요청 헤더가 안전 목록(CORS-safelisted) 안에 있는 것뿐이다.** `Accept`, `Accept-Language`, `Content-Language`, 그리고 아래 조건을 만족하는 `Content-Type` 정도다. 여기에 없는 헤더를 하나라도 직접 붙이면 단순 요청이 아니다 — `Authorization`, `X-Requested-With`, `X-Trace-Id` 같은 것이 전부 여기 걸린다.

**③ `Content-Type`이 다음 셋 중 하나다.**

```
application/x-www-form-urlencoded    (일반 HTML 폼)
multipart/form-data                  (파일 업로드 폼)
text/plain                           (평문)
```

왜 하필 이 조건인가. **"옛날 HTML 폼으로도 보낼 수 있던 요청"**이 기준이기 때문이다. `<form>` 태그는 CORS가 생기기 훨씬 전부터 교차 출처 제출이 가능했고 메서드는 GET/POST뿐, `enctype`은 위 세 가지뿐이었다. 즉 이런 요청은 **CORS가 없던 시절부터 서버가 이미 받아오던 형태**라 새로운 위협이 아니다. 그래서 preflight 없이 그대로 통과시킨다.

(부수적으로, `XMLHttpRequest`의 업로드 진행률 이벤트를 등록하면 단순 요청 조건에서 빠진다. 파일 업로드에 진행 바를 붙였더니 갑자기 preflight가 생기는 경우가 여기 해당한다.)

**여기서 3년차가 가장 자주 부딪히는 지점이 나온다.** 우리가 만드는 JSON API는 거의 전부 `Content-Type: application/json`이다. 그런데 `application/json`은 위 세 목록에 없다. 따라서 **JSON을 POST하는 순간 그것은 단순 요청이 아니고, preflight가 붙는다.**

```javascript
// 단순 요청 — preflight 없이 바로 나간다
fetch('https://api.example.com/search?q=hello');

// 단순 요청이 아니다 — Content-Type이 application/json이라서 preflight가 붙는다
fetch('https://api.example.com/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId: 7 })
});

// 이것도 preflight 대상 — GET이지만 Authorization은 안전 목록 밖 헤더다
fetch('https://api.example.com/me', {
  headers: { 'Authorization': 'Bearer ...' }
});
```

"우리 API는 GET인데 왜 preflight가 뜨죠?"라는 질문의 답도 대개 여기 있다. **메서드가 아니라 헤더 때문**인 경우가 많다.

### 2-4. Preflight — 본 요청 전에 허락을 구한다

#### 왜 필요한가

앞 절의 논리를 뒤집으면 preflight의 존재 이유가 나온다. CORS로 인해 브라우저가 **새롭게** 보낼 수 있게 된 요청들이 있다 — `PUT`/`DELETE`/`PATCH`, `Content-Type: application/json`, `Authorization` 같은 커스텀 헤더. 이런 요청은 옛날 폼으로는 만들 수 없었다.

문제는 세상의 서버들이 대부분 CORS라는 개념이 생기기 전에 만들어졌고, **"이런 요청이 브라우저에서 교차 출처로 올 리 없다"**는 전제로 설계돼 있다는 것이다. 만약 브라우저가 이런 요청을 그냥 보내버린다면, CORS를 모르는 낡은 서버는 `DELETE /orders/42`를 받아 **실제로 삭제한 다음** 응답을 돌려줄 것이다. 브라우저가 그 응답을 스크립트에 안 넘겨준들, 이미 삭제는 끝났다.

그래서 브라우저는 이런 요청을 보내기 전에 **`OPTIONS` 요청으로 먼저 물어보고, 서버가 CORS를 이해하고 명시적으로 허용한 경우에만 본 요청을 보낸다.** 허락이 없으면 부수효과가 있는 본 요청이 서버에 **도달조차 하지 않는다.** 이것이 preflight(사전 비행 점검)라는 이름의 의미이자 존재 이유다.

`OPTIONS`가 쓰이는 것도 이유가 있다. 원래 HTTP에서 `OPTIONS`는 "이 자원에 어떤 동작이 가능한지 묻는" 메서드이고, **부수효과가 없다.** 물어보는 행위 자체가 서버 상태를 바꾸면 안 되므로 자연스러운 선택이다.

#### 왕복의 실제 모습

```
브라우저                                                  서버
   |                                                       |
   |  ① OPTIONS /orders/42                                 |
   |     Origin: https://app.example.com                   |
   |     Access-Control-Request-Method: DELETE              |
   |     Access-Control-Request-Headers: authorization      |
   |  ------------------------------------------------->   |
   |     ("DELETE를, authorization 헤더를 달아 보내려는데 됩니까?")
   |                                                       |
   |  ② 204 No Content                                     |
   |     Access-Control-Allow-Origin: https://app.example.com
   |     Access-Control-Allow-Methods: GET, POST, DELETE    |
   |     Access-Control-Allow-Headers: Authorization, Content-Type
   |     Access-Control-Max-Age: 3600                       |
   |  <-------------------------------------------------   |
   |     ("됩니다. 그리고 이 답을 1시간 동안 재사용하세요.")   |
   |                                                       |
   |  --- 여기서 브라우저가 허가 여부를 판정한다 ---           |
   |      요청하려는 메서드가 Allow-Methods에 있는가?         |
   |      보내려는 헤더가 전부 Allow-Headers에 있는가?        |
   |      하나라도 아니면 본 요청은 나가지 않는다.            |
   |                                                       |
   |  ③ DELETE /orders/42                                  |
   |     Origin: https://app.example.com                    |
   |     Authorization: Bearer ...                          |
   |  ------------------------------------------------->   |
   |                                                       |
   |  ④ 200 OK                                             |
   |     Access-Control-Allow-Origin: https://app.example.com
   |  <-------------------------------------------------   |
   |     (본 응답에도 허용 헤더가 다시 필요하다 — ②의 허가는  |
   |      "보내도 된다"였을 뿐, "읽어도 된다"는 별개다)       |
```

마지막 주석이 실무에서 자주 놓치는 부분이다. **preflight를 통과했다고 본 응답을 읽을 수 있는 것이 아니다.** 본 응답에도 `Access-Control-Allow-Origin`이 있어야 한다. preflight만 처리하고 본 응답에 헤더를 안 붙이는 설정을 하면 "OPTIONS는 204인데 본 요청에서 또 CORS 에러"가 난다.

#### 응답 헤더 정리

지금까지 나온 헤더가 각각 무엇을 답하는지 한 번 모아 보면 이렇다.

| 헤더 | 답하는 질문 | 붙는 곳 |
|---|---|---|
| `Access-Control-Allow-Origin` | 어느 출처에게 응답을 읽게 할 것인가 | preflight 응답 + 본 응답 |
| `Access-Control-Allow-Methods` | 어떤 메서드를 허용하는가 | preflight 응답 |
| `Access-Control-Allow-Headers` | 어떤 요청 헤더를 달아도 되는가 | preflight 응답 |
| `Access-Control-Max-Age` | 이 허가를 몇 초 동안 재사용해도 되는가 | preflight 응답 |
| `Access-Control-Allow-Credentials` | 쿠키를 실은 요청도 허용하는가 | preflight 응답 + 본 응답 |
| `Access-Control-Expose-Headers` | 스크립트가 읽어도 되는 응답 헤더는 무엇인가 | 본 응답 |

마지막 `Access-Control-Expose-Headers`는 덜 알려졌지만 실무에서 부딪힌다. 교차 출처 응답에서 스크립트가 읽을 수 있는 응답 헤더는 기본적으로 극히 일부(`Content-Type` 등)로 제한된다. 그래서 페이징 총건수를 `X-Total-Count`로 내려주거나 생성된 자원 위치를 `Location`으로 주면, **프론트에서는 그 헤더가 없는 것처럼 보인다.** 서버가 명시적으로 노출해 줘야 읽힌다.

```http
Access-Control-Expose-Headers: X-Total-Count, Location
```

### 2-5. 자격증명(쿠키)을 실어 보낼 때 — 규칙이 한 단계 엄격해진다

교차 출처 요청에는 **기본적으로 쿠키가 실리지 않는다.** `07-cookie-session-token-auth.md`에서 본 자동 첨부는 동일 출처가 전제이고, 교차 출처에서는 스크립트가 명시적으로 요구해야 한다.

이것을 켜려면 **양쪽이 짝을 이뤄야** 한다. 한쪽만 해서는 동작하지 않는다.

```javascript
// 클라이언트: 이 요청에 쿠키를 실어 보내겠다고 선언한다
fetch('https://api.example.com/me', { credentials: 'include' });

// axios라면
axios.get('https://api.example.com/me', { withCredentials: true });
```

```http
# 서버: 자격증명이 실린 요청도 허용한다고 응답한다
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
```

여기에 **절대 규칙**이 하나 붙는다. **자격증명이 실린 요청에는 `Access-Control-Allow-Origin: *`를 쓸 수 없다.** 브라우저가 `*`와 `Allow-Credentials: true`의 조합을 보면 응답을 거부한다. 반드시 구체적인 출처 문자열이어야 한다.

이유는 `*`의 의미를 따져 보면 자명하다. `*`는 "누가 읽어가도 상관없는 공개 자원"이라는 선언인데, 여기에 "사용자의 로그인 쿠키를 실은 요청도 받겠다"를 더하면 **"아무 사이트나 방문자의 로그인 세션으로 우리 API를 호출하고 그 응답을 읽어가도 된다"**가 된다. 이것은 1-3절에서 SOP가 막으려던 바로 그 시나리오다. **SOP가 지켜주던 것을 우리 손으로 여는 셈**이므로 스펙이 조합 자체를 금지한다.

같은 이유로 자격증명 모드에서는 `Access-Control-Allow-Headers: *`와 `Access-Control-Allow-Methods: *`의 와일드카드도 와일드카드로 해석되지 않고 문자 그대로의 이름으로 취급된다. **자격증명을 켜는 순간 모든 허용 항목을 명시해야 한다**고 기억하면 된다.

그리고 쿠키 자체에도 조건이 붙는다. 교차 사이트로 나가는 쿠키이므로 **`SameSite=None; Secure`가 필요하다**(07번 문서 1-4절). 즉 "프론트와 API가 다른 도메인인데 쿠키 세션을 쓴다"는 결정은 다음 셋을 한 세트로 요구한다.

```
클라이언트   credentials: 'include'
서버 CORS    Access-Control-Allow-Credentials: true
             Access-Control-Allow-Origin: https://app.example.com  (구체 출처)
쿠키 속성    Set-Cookie: ...; Secure; SameSite=None
```

셋 중 하나만 빠져도 "쿠키가 안 실린다" 또는 "응답을 못 읽는다"로 나타난다. 그리고 `SameSite=None`은 CSRF 방어를 스스로 끄는 선택이므로 CSRF 토큰 같은 별도 장치가 함께 와야 한다는 점도 잊지 않는다.

## 3. 실무 설정 — `*` 복붙이 만드는 구멍

### 3-1. Spring에서 CORS를 켜는 세 가지 자리

Spring에는 CORS 설정 위치가 여러 곳이라 헷갈리기 쉽다. 무엇이 어디까지 담당하는지부터 정리한다.

**`@CrossOrigin` 애너테이션**은 컨트롤러나 메서드에 붙이는 국소 설정이다. 특정 엔드포인트 하나만 열 때는 편하지만, 설정이 코드 곳곳에 흩어져 **"우리 API가 지금 어느 출처에 열려 있는가"를 한눈에 볼 수 없게** 된다. 보안 설정은 한곳에 모으는 편이 낫다.

```java
@CrossOrigin(origins = "https://app.example.com")  // 이 컨트롤러에만 적용
@RestController
public class OrderController { ... }
```

**`WebMvcConfigurer#addCorsMappings`**는 애플리케이션 전역 설정이다. 경로 패턴 단위로 허용 규칙을 정의한다.

```java
// Before: "일단 되게" — 모든 출처 + 자격증명 허용
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")   // 아무 사이트나 우리 API 호출 가능
                .allowCredentials(true);      // 심지어 쿠키(로그인 세션)까지 실어서
        // 이 조합이 왜 위험한가:
        // 악성 사이트가 방문자의 로그인 세션으로 우리 API를 호출하고
        // 응답까지 읽어간다. SOP가 막아주던 것을 직접 연 셈이다.
        //
        // allowedOrigins("*") + allowCredentials(true)는 스펙 위반이라
        // Spring이 기동 시점에 예외를 던진다. 그래서 이를 우회하려고
        // allowedOriginPatterns("*")를 쓰는데, 이쪽은 요청의 Origin을
        // 그대로 되비추어(echo) 응답하므로 사실상 전 출처 허용이 된다.
        // 검증기를 통과할 뿐 위험은 그대로다.
    }
}

// After: 신뢰하는 출처만 명시적으로 허용
@Configuration
public class CorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")   // 열 필요가 있는 경로만
                .allowedOrigins("https://app.example.com")  // 문자열 완전 일치
                .allowedMethods("GET", "POST", "PUT", "DELETE")
                .allowedHeaders("Authorization", "Content-Type")
                .exposedHeaders("X-Total-Count")  // 프론트가 읽어야 하는 응답 헤더
                .allowCredentials(true)  // 허용 출처가 특정돼 있으므로 성립한다
                .maxAge(3600);           // preflight 결과 캐시로 왕복 절감
    }
}
```

핵심 원칙은 이렇게 정리한다. **`Access-Control-Allow-Origin: *`는 "누가 읽어가도 상관없는 공개 리소스"에만 쓴다** — 공개 폰트, 공개 시세 API, 로그인이 필요 없는 조회 API 같은 것들이다. 쿠키나 토큰이 실리는 API라면 반드시 허용 목록(allowlist) 방식이어야 한다.

**`Access-Control-Allow-Origin`은 값이 하나만 올 수 있다**는 점도 알아둔다. 출처를 여럿 허용하려면 콤마로 나열하는 것이 아니라, 서버가 요청의 `Origin`을 허용 목록과 대조해 **일치하면 그 값 하나를 되비추어** 응답한다. Spring은 이 처리를 대신해 준다. 다만 이 방식은 응답이 요청 헤더에 따라 달라진다는 뜻이므로, 앞단에 캐시(CDN, 프록시)가 있다면 **`Vary: Origin`**을 함께 내려야 A 출처용 응답이 B 출처에 재사용되는 사고를 막는다. Spring의 CORS 처리는 이 헤더를 붙여 주지만, 직접 필터를 구현했다면 빠뜨리기 쉽다.

### 3-2. Spring Security를 쓰면 위 설정이 안 먹는다 — 필터 체인 순서 문제

**전형적인 사고가 하나 있다.** `addCorsMappings`로 CORS를 잘 설정했는데도 프론트에서는 계속 CORS 에러가 나고, 개발자도구를 보면 `OPTIONS` 요청이 **401**로 떨어져 있다.

원인은 처리 순서다.

```
[요청이 지나가는 길]

  요청 -> [서블릿 필터 체인]                 -> [DispatcherServlet]
             |                                      |
             +-- Spring Security 필터들              +-- 핸들러 매핑
                 (인증·인가 검사)                        (여기서 addCorsMappings의
                                                          CORS 규칙이 적용된다)

  preflight OPTIONS 요청은 쿠키도 Authorization 헤더도 달고 오지 않는다.
  (브라우저가 그렇게 보내도록 정해져 있다 — 허락을 구하는 요청이므로)
       |
       v
  Security 필터가 "인증 정보 없음"으로 판단 -> 401 반환
       |
       v
  DispatcherServlet까지 가지 못하므로 CORS 설정은 실행조차 안 된다
       |
       v
  브라우저: 허가 응답을 못 받았으니 본 요청을 보내지 않는다 -> CORS 에러
```

**preflight `OPTIONS`에는 인증 정보가 실리지 않는다**는 사실이 이 사고의 뿌리다. 그러니 인증 필터가 그것까지 검사하면 반드시 막힌다.

해결은 **CORS 처리를 인증 앞단으로 옮기는 것**이다. Spring Security의 `cors()`를 켜면 `CorsFilter`가 인증 필터보다 앞에 배치되어 preflight를 가로채 바로 응답한다.

```java
// Before: Security가 preflight까지 인증 대상으로 삼는다
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .httpBasic(Customizer.withDefaults());
    // cors() 설정이 없다 -> CorsFilter가 체인에 없다
    // -> OPTIONS도 인증 검사를 받고 401 -> preflight 실패
    return http.build();
}

// After: CorsFilter가 인증 앞단에서 preflight를 처리한다
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http.cors(Customizer.withDefaults())   // CorsConfigurationSource 빈을 사용
        .csrf(csrf -> csrf.disable())      // 토큰 인증이라면(쿠키 세션이면 켜 둔다)
        .authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
}

@Bean
public CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOrigins(List.of("https://app.example.com"));
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
    config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
    config.setAllowCredentials(true);
    config.setMaxAge(3600L);

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", config);
    return source;
}
```

`http.cors()`를 켜면 Security는 위 `CorsConfigurationSource` 빈을 찾아 `CorsFilter`를 체인 앞쪽에 끼워 넣는다. 이 필터는 preflight를 알아보고 **인증 검사에 도달하기 전에** 허가 응답을 돌려준다.

여기서 자주 보이는 잘못된 처방도 짚어 둔다. `auth.requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()`로 OPTIONS를 통째로 열어 증상을 없애는 방법이다. 401은 사라지지만 **CORS 응답 헤더를 붙여주는 주체가 여전히 없으므로** 결국 preflight가 실패하거나, 운 좋게 동작해도 "CORS 설정이 어디에 있는지 알 수 없는" 구성이 남는다. **CORS는 CORS 처리기가 담당하게 하는 것**이 올바른 해법이다.

또 하나. 커스텀 JWT 인증 필터를 직접 만들어 체인에 넣었다면, 그 필터 안에서도 preflight를 건너뛰도록 해야 한다. Spring이 판정 유틸을 제공한다.

```java
// 커스텀 인증 필터: preflight는 인증 대상이 아니므로 그냥 흘려보낸다
@Override
protected boolean shouldNotFilter(HttpServletRequest request) {
    return CorsUtils.isPreFlightRequest(request);
}
```

### 3-3. Nginx·LB에서 헤더를 한 번 더 붙이면 브라우저가 거부한다

인프라 앞단에서 CORS를 처리하는 구성도 흔하다. 문제는 **애플리케이션도 붙이고 앞단도 붙이는 이중 설정**이다.

`Access-Control-Allow-Origin` 헤더가 응답에 **두 개** 실리면 브라우저는 값이 맞는지 따지지 않고 응답을 거부한다. 콘솔에는 "The 'Access-Control-Allow-Origin' header contains multiple values" 류의 메시지가 뜬다. 값이 둘 다 옳아도 마찬가지다 — 스펙상 이 헤더는 하나여야 하기 때문이다.

```nginx
# Before: 백엔드가 이미 CORS 헤더를 내려주는데 nginx가 한 번 더 붙인다
location /api/ {
    proxy_pass http://backend;
    add_header 'Access-Control-Allow-Origin' 'https://app.example.com' always;
    # 백엔드 응답에도 같은 헤더가 있으므로 최종 응답에 두 개가 실린다
    # -> 브라우저가 응답 자체를 거부한다
}

# After(방법 1): CORS는 애플리케이션 한 곳에서만 처리하고 프록시는 전달만 한다
location /api/ {
    proxy_pass http://backend;
    # 헤더를 추가하지 않는다. 책임 지점을 하나로 유지하는 것이 핵심이다.
}

# After(방법 2): 앞단에서 처리하기로 했다면, 백엔드 헤더를 제거하고 붙인다
location /api/ {
    proxy_pass http://backend;
    proxy_hide_header 'Access-Control-Allow-Origin';   # 백엔드 것을 걷어내고
    add_header 'Access-Control-Allow-Origin' 'https://app.example.com' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;
    add_header 'Vary' 'Origin' always;
}
```

`add_header`에 붙은 `always`도 이유가 있다. 이 지시어가 없으면 nginx는 성공 계열 응답에만 헤더를 붙이고 **4xx·5xx 응답에는 붙이지 않는다.** 그러면 서버가 500을 낼 때만 CORS 에러로 바뀌어, 프론트에서는 진짜 원인(500)이 보이지 않고 "가끔 CORS 에러가 난다"는 신고가 올라온다. `always`를 붙이면 오류 응답에도 헤더가 실려 프론트가 상태 코드를 읽을 수 있다.

`add_header`의 상속 규칙도 함정이다. nginx는 하위 블록에 `add_header`가 하나라도 있으면 **상위 블록의 `add_header`를 전부 무시한다.** `server` 레벨에 CORS 헤더를 정의해 놓고 특정 `location`에 캐시 헤더 하나를 추가했더니 그 경로에서만 CORS가 깨지는 일이 여기서 생긴다.

**원칙은 하나다. CORS 헤더를 붙이는 지점은 시스템 전체에서 한 곳이어야 한다.** 애플리케이션이든 게이트웨이든 정하고, 나머지는 손대지 않는다.

### 3-4. 환경별 허용 목록 관리 — 운영에 localhost가 남는 사고

개발(`http://localhost:3000`), 스테이징, 운영은 도메인이 다르므로 허용 목록을 환경설정으로 분리해야 한다.

```yaml
# application-prod.yml — 운영에는 운영 도메인만
cors:
  allowed-origins:
    - https://app.example.com
    - https://admin.example.com

# application-local.yml — 로컬에만 개발 서버 출처
cors:
  allowed-origins:
    - http://localhost:3000
```

```java
@Configuration
public class CorsConfig implements WebMvcConfigurer {

    // 하드코딩하지 않고 프로파일별 설정에서 주입받는다.
    // 코드에 localhost가 박혀 있으면 그것이 운영에도 그대로 배포된다.
    @Value("${cors.allowed-origins}")
    private List<String> allowedOrigins;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(allowedOrigins.toArray(String[]::new))
                .allowedMethods("GET", "POST", "PUT", "DELETE")
                .allowCredentials(true)
                .maxAge(3600);
    }
}
```

흔한 사고 두 가지를 알아 두면 좋다.

**① 운영 설정에 localhost가 남아 배포된다.** 이러면 공격자가 자기 PC에서 `localhost:3000`으로 페이지를 띄워 놓고 피해자를 유인해, **피해자의 운영 세션 쿠키로 운영 API를 호출하고 응답을 읽어갈 수 있다.** "로컬이니까 나만 쓰는 주소"라는 감각이 틀린 이유는, `localhost`가 **공격자의 로컬**이기도 하기 때문이다.

**② 서브도메인 와일드카드를 정규식으로 직접 구현하다 우회당한다.** `*.example.com`을 허용하려고 정규식을 손으로 짜면 경계 처리를 빠뜨리기 쉽다. 점을 이스케이프하지 않거나 끝 앵커를 빼면 `evil-example.com`이나 `example.com.evil.com` 같은 도메인이 통과한다. **출처 검증은 문자열 완전 일치 목록이 가장 안전하다.** 패턴이 꼭 필요하면 직접 짜지 말고 Spring의 `allowedOriginPatterns`처럼 검증된 구현을 쓴다.

### 3-5. 성능 — preflight 왕복을 줄이는 세 가지 방향

preflight는 본 요청 앞에 **왕복(RTT, round-trip time — 요청을 보내고 응답을 받기까지 걸리는 왕복 시간)을 하나 더** 얹는다. 국내 서버라면 수 밀리초지만 해외 리전이라면 수십에서 백여 밀리초가 요청마다 추가될 수 있다. 화면 하나가 API를 열 번 호출한다면 그만큼이 곱해진다.

**① `Access-Control-Max-Age`로 허가를 캐시한다.** 이 값을 주면 브라우저가 preflight 결과를 그 초 동안 기억하고, 같은 조건의 요청에는 다시 묻지 않는다. 첫 호출 한 번만 왕복이 늘고 이후는 사라진다.

주의할 점이 둘 있다. 첫째, **브라우저마다 상한이 있어 아무리 큰 값을 줘도 그 이상은 캐시되지 않는다.** 상한 값은 브라우저와 버전마다 다르므로 "하루로 설정했으니 하루 동안 안 물어본다"고 가정하면 안 된다. 둘째, **캐시는 요청 URL 단위**다. 엔드포인트가 100개면 각각 첫 호출 때 preflight가 발생한다. 즉 Max-Age는 반복 호출을 줄여 줄 뿐, **첫 진입 시의 왕복은 없애지 못한다.**

**② 요청을 단순 요청 조건 안에 유지한다.** 조건에 맞으면 preflight 자체가 생기지 않는다. 다만 이를 위해 JSON 대신 폼 인코딩을 쓴다거나 `Authorization` 헤더를 포기하는 식으로 **설계를 비틀 필요는 없다.** 얻는 것보다 잃는 것이 크다.

**③ 구조적으로 교차 출처 상황 자체를 없앤다.** 가장 확실한 해법이다. 같은 도메인 아래에서 리버스 프록시나 게이트웨이가 경로로 라우팅하면, 브라우저 입장에서는 동일 출처이므로 **CORS라는 개념이 아예 등장하지 않는다.**

```nginx
# app.example.com 한 도메인 아래로 프론트와 API를 모은다
server {
    server_name app.example.com;

    location /api/ {
        proxy_pass http://backend:8080/;   # 브라우저는 동일 출처로 인식한다
    }

    location / {
        proxy_pass http://frontend:3000/;
    }
}
```

이 구성은 preflight가 사라지는 것에 더해, `SameSite=None`이 필요 없어지고(같은 사이트가 되므로) CORS 설정 자체를 유지보수하지 않아도 된다는 이점이 따라온다. **CORS 문제를 푸는 가장 좋은 방법이 CORS를 만들지 않는 것**인 경우가 실제로 많다.

## 4. 꼬리질문 대비 포인트

### "서버 로그에는 200인데 프론트에서 CORS 에러가 납니다. 왜죠?"

**차단의 집행자가 서버가 아니라 브라우저이기 때문**이라고 먼저 말한다.

단순 요청은 서버까지 가서 정상 처리되고 200 응답까지 돌아온다. 브라우저는 그 응답을 손에 쥔 상태에서 `Access-Control-Allow-Origin`을 확인하고, 없거나 맞지 않으면 **스크립트에 전달하는 단계에서** 폐기한다. 서버는 자기 몫을 다 했으므로 로그에 이상이 없다.

그래서 **"CORS 에러 = 요청이 안 갔다"가 아니다.** 부수효과가 있는 요청이었다면 그 효과는 이미 일어났다. 디버깅 순서는 이렇게 답한다. 먼저 개발자도구 네트워크 탭에서 **`OPTIONS` 요청이 있는지** 본다. 있다면 preflight가 필요한 요청이고, 그것이 실패했다면 본 요청은 아예 나가지 않았다는 뜻이다(3-2절의 Security 401이 대표 원인). `OPTIONS`가 없는데 에러라면 단순 요청이 서버까지 갔다가 응답 헤더가 없어 막힌 것이므로, 본 응답에 허용 헤더를 붙이는 문제로 좁혀진다.

한 가지 더 얹으면 좋다. **서버가 500을 냈을 때도 CORS 에러로 보인다.** 오류 응답에는 CORS 헤더가 빠지는 구성이 많아(nginx의 `always` 누락, 예외 핸들러 우회 등) 브라우저가 상태 코드를 스크립트에 넘겨주지 않기 때문이다. "CORS 에러인데 알고 보니 500이었다"는 사례가 흔하므로 **오류 응답에도 CORS 헤더가 실리게 하는 것**이 디버깅 비용을 크게 줄인다.

### "CORS를 설정했으니 우리 API는 안전한 건가요?" (시니어 변별 포인트)

아니다. **CORS는 브라우저 안에서만 작동하는 규칙**이다.

curl, 서버 간 호출, 모바일 앱, 스크립트 도구, 공격자가 만든 프록시에는 아무 제약이 없다. `Origin` 헤더를 마음대로 위조할 수도 있다(브라우저만 위조를 막을 뿐, 브라우저가 아닌 도구는 무엇이든 보낼 수 있다). 따라서 **CORS는 인증·인가를 대체하지 못하고, "교차 출처 요청 자체"를 막는 수단도 아니다.** 인증 토큰 검증, 권한 검사, 입력 검증은 CORS와 무관하게 전부 있어야 한다.

CORS가 실제로 지키는 것은 하나로 좁혀 말할 수 있다. **"브라우저에서 실행되는 다른 사이트의 스크립트가, 방문자의 인증 상태를 빌려 우리 응답을 읽어가는 것"**을 막는다. 그 범위 밖은 지키지 않는다.

여기에 CSRF와의 구분을 덧붙이면 답이 완성된다(1-4절). CORS를 완벽하게 잠가도 **폼 제출 기반 CSRF는 그대로 성립한다** — 공격자는 응답을 읽으려는 게 아니라 부수효과만 노리기 때문이다. **CORS와 CSRF 방어는 서로 다른 문제를 푼다**는 구분이 시니어의 답변이다.

### "preflight 때문에 API가 느려진다는데, 줄이는 방법은?"

3-5절의 세 방향으로 답한다.

**① `Access-Control-Max-Age`로 preflight 결과를 브라우저에 캐시시킨다.** 같은 조건의 반복 요청에서 왕복이 사라진다. **② 요청을 단순 요청 조건 안에 유지할 수 있다면 preflight 자체가 생기지 않는다.** 다만 이를 위해 API 설계를 비틀 필요는 없다. **③ 구조적으로는 교차 출처 상황을 없앤다.** 같은 도메인 아래에서 리버스 프록시가 `/api`를 백엔드로 라우팅하면 브라우저 입장에서 동일 출처가 되어 CORS가 아예 등장하지 않는다.

(가산점 포인트) **preflight 캐시의 한계까지 말하면 좋다.** 캐시는 요청 URL 단위라 엔드포인트가 많으면 **첫 호출들에는 여전히 preflight가 발생하고**, 브라우저마다 Max-Age 상한이 있어 설정한 값이 그대로 적용된다는 보장도 없다. 그래서 "Max-Age를 크게 주면 해결된다"가 아니라 **"반복 호출은 캐시로, 첫 진입 비용은 구조로"**라고 나눠 답하는 편이 정확하다.

### "어떤 요청이 preflight 없이 나가나요? (단순 요청의 조건)"

세 조건이 동시에 성립할 때다(2-3절). **메서드가 `GET`/`HEAD`/`POST`**이고, **직접 붙인 헤더가 안전 목록(`Accept`, `Accept-Language`, `Content-Language`, `Content-Type`) 안에만 있고**, **`Content-Type`이 `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain` 중 하나**일 때다.

기준을 외우기보다 **왜 그 조건인지**로 답하는 편이 낫다. **"옛날 HTML 폼으로도 보낼 수 있던 요청"**이 단순 요청이다. 이런 요청은 CORS가 없던 시절부터 서버가 받아오던 형태라 새로운 위협이 아니므로 그냥 통과시킨다.

반대로 **`Content-Type: application/json`이거나 `Authorization` 헤더 하나만 붙어도 preflight 대상**이 된다. JSON API 호출 대부분에 preflight가 따라붙는 이유가 이것이고, "GET인데 왜 preflight가 뜨냐"는 질문의 답도 대개 **메서드가 아니라 헤더** 쪽에 있다.

### "CORS 허용 출처를 환경별로 관리하다 겪는 문제는?"

개발(`localhost:3000`), 스테이징, 운영의 도메인이 다르므로 허용 목록을 프로파일별 설정으로 분리해야 한다(3-4절). 코드에 출처를 하드코딩하면 그것이 그대로 전 환경에 배포된다.

흔한 사고는 둘이다. **① 운영 설정에 localhost가 남아 배포되는 것.** `localhost`는 "나만 쓰는 주소"가 아니라 **공격자의 로컬**이기도 하므로, 공격자가 자기 PC에서 페이지를 띄워 피해자의 운영 세션으로 운영 API를 호출하고 응답을 읽어갈 수 있다. **② 서브도메인 와일드카드를 정규식으로 직접 구현하다 우회당하는 것.** 점을 이스케이프하지 않거나 끝 앵커를 빠뜨리면 `evil-example.com` 같은 도메인까지 매칭된다.

원칙은 **출처 검증은 문자열 완전 일치 목록이 가장 안전하다**는 것이다. 패턴이 꼭 필요하면 직접 짜지 말고 검증된 구현을 쓰고, 배포 파이프라인에서 **운영 프로파일의 허용 목록을 점검하는 단계**를 두면 더 좋다.

---

## 한 줄 요약

CORS는 브라우저의 동일 출처 차단을 서버가 응답 헤더로 동의한 범위만큼 풀어주는 절차이고, 막는 것은 요청이 아니라 **응답 읽기**여서 "서버 로그 200 + 프론트 CORS 에러"가 정상적으로 발생하며, preflight는 CORS 이전 시대 서버들이 예상 못 한 형태의 요청(PUT/DELETE, `application/json`, 커스텀 헤더)이 도달하기 전에 브라우저가 `OPTIONS`로 미리 허락을 구하는 보호 장치다 — 쿠키를 실으려면 `credentials: 'include'`와 `Allow-Credentials: true`가 짝을 이뤄야 하고 그때 `*`는 금지되며, 집행자는 언제나 브라우저이므로 CORS는 인증·인가의 대체재가 아니라 "필요한 출처에만, 필요한 만큼만" 여는 설정의 문제다.
