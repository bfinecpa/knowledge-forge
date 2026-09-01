# PUT vs PATCH — 전체 교체와 부분 수정, 그리고 "안 보낸 필드가 null로 덮이는" 사고

> 핵심 관전 포인트: **PUT은 "보낸 표현으로 자원 전체를 교체(replace)"하는
> 메서드고, PATCH는 "보낸 내용만 부분 수정(partial update)"하는
> 메서드다. PUT은 같은 요청을 몇 번 보내도 결과가 같아 멱등하지만,
> PATCH는 정의상 멱등이 보장되지 않는다. 이 구분이 흐려지면 실무에서
> "클라이언트가 안 보낸 필드가 null로 덮여 데이터가 유실되는" 사고가
> API 계약 수준에서 발생한다 — 부분 수정을 PUT으로 받거나, PATCH에서
> '필드 없음'과 'null'을 구분하지 못하는 구현이 그 범인이다.**

---

## 0. 질문 + 의도

**질문**: "PUT과 PATCH의 차이는?"

**출제 의도**: 전체 교체와 부분 수정의 구분이 흐리면 "안 보낸 필드가
null로 덮이는" 데이터 유실이 API 계약 수준에서 발생한다. HTTP 메서드의
시맨틱(의미 약속)을 지키는 규율이 있는지 보는 표본 검사다 — 이 구분을
아는 사람은 다른 계약(상태 코드, 멱등성)도 지킬 확률이 높다.

## 1. 시맨틱 차이 — 교체(replace) vs 수정(modify)

두 메서드의 차이는 "몇 개 필드를 보내느냐"가 아니라 **서버가 요청
바디를 무엇으로 해석하겠다고 약속하느냐**다.

- **PUT `/users/42`**: "이 바디가 42번 사용자의 **완전한 최신 상태**다.
  기존 걸 버리고 이걸로 갈아끼워라." — 바디에 없는 필드는
  **"없애라"는 뜻**이 된다.
- **PATCH `/users/42`**: "이 바디에 **적힌 것만** 바꿔라." —
  바디에 없는 필드는 **"건드리지 마라"는 뜻**이 된다.

비유하면 PUT은 **문서 전체를 새 파일로 덮어쓰기**, PATCH는
**문서에 수정 지시서(변경분)만 전달하기**다.

```http
# 사용자 자원: {"name": "김철수", "email": "kim@ex.com", "phone": "010-1111-2222"}

# PUT — 전체 교체: phone을 안 보냈으므로 phone은 "제거하라"는 의미
PUT /users/42
{"name": "김철수", "email": "new@ex.com"}
# 결과: {"name": "김철수", "email": "new@ex.com", "phone": null}

# PATCH — 부분 수정: 보낸 email만 바뀌고 나머지는 유지
PATCH /users/42
{"email": "new@ex.com"}
# 결과: {"name": "김철수", "email": "new@ex.com", "phone": "010-1111-2222"}
```

### 멱등성 차이

- **PUT은 멱등(idempotent)**: 같은 요청을 1번 보내나 10번 보내나
  자원은 같은 최종 상태다. 네트워크 오류로 응답을 못 받은 클라이언트가
  **안심하고 재시도할 수 있다.**
- **PATCH는 멱등이 보장되지 않는다**: "email을 X로 바꿔라"처럼
  값을 지정하는 PATCH는 사실상 멱등이지만, "포인트를 +100 해라"처럼
  **연산을 담은 PATCH**는 재시도할 때마다 결과가 달라진다.
  스펙이 멱등을 약속하지 않으므로, 중간 장비나 클라이언트 라이브러리도
  PATCH를 자동 재시도 대상으로 취급하지 않는다.

## 2. 실무 사고 시나리오 — "안 보낸 필드가 null로 덮였어요"

가장 흔한 사고는 **부분 수정 화면을 PUT(또는 PUT처럼 동작하는
구현)으로 처리**할 때 난다.

시나리오: 회원 정보에 `name`, `email`, `marketingAgreed`(마케팅 수신
동의)가 있다. 앱의 "이메일 변경" 화면은 email만 보낸다.

```java
// Before: 부분 수정 요청을 전체 교체처럼 처리 — 데이터 유실
@PutMapping("/users/{id}")
public void update(@PathVariable Long id, @RequestBody UserUpdateRequest req) {
    User user = userRepository.findById(id).orElseThrow();
    // 요청에 없던 필드가 DTO에서 null로 역직렬화되고, 그대로 덮어쓴다
    user.setName(req.getName());                     // null로 덮임!
    user.setMarketingAgreed(req.getMarketingAgreed()); // null/false로 덮임!
    user.setEmail(req.getEmail());
}
```

이메일만 바꿨는데 **이름이 사라지고 마케팅 동의가 풀린다.**
이런 버그는 컴파일 에러도, 예외도 없이 조용히 데이터를 갉아먹다가
"동의했는데 왜 해제됐냐"는 CS로 발견된다. 원인은 코드가 아니라
**계약 위반** — 클라이언트는 부분 수정(PATCH 시맨틱)을 기대했는데
서버는 전체 교체(PUT 시맨틱)로 처리한 것이다.

```java
// After: 부분 수정은 PATCH로 받고, "보낸 필드만" 반영
@PatchMapping("/users/{id}")
public void patch(@PathVariable Long id, @RequestBody UserPatchRequest req) {
    User user = userRepository.findById(id).orElseThrow();
    if (req.getName() != null) user.setName(req.getName());
    if (req.getEmail() != null) user.setEmail(req.getEmail());
    if (req.getMarketingAgreed() != null) {
        user.setMarketingAgreed(req.getMarketingAgreed());
    }
}
```

반대 방향의 규율도 필요하다 — **PUT을 제공한다면 클라이언트는 항상
전체 표현을 보내야 하고, 서버는 빠진 필드를 "유지"가 아니라
"제거/초기화"로 처리해야 PUT이다.** 빠진 필드를 적당히 유지해주는
"친절한 PUT"은 당장은 편해 보여도, 클라이언트마다 해석이 갈라져
계약이 무너진다.

## 3. PATCH 구현의 함정 — "안 보냄"과 "null로 지워라"의 구분

위 After 코드에도 남은 구멍이 있다. `if (req.getX() != null)` 방식은
**"필드를 안 보냈다"와 "필드를 null로 지워달라"를 구분하지 못한다.**
JSON에서는 세 가지가 다 다른 의미다:

```json
{"phone": "010-9999-8888"}   // phone을 이 값으로 변경
{"phone": null}              // phone을 지워달라 (null로 설정)
{}                           // phone은 건드리지 마라
```

그런데 Java 객체로 역직렬화하면 뒤의 두 경우 모두 `phone == null`이
되어 구분이 사라진다. 해결 방법:

- **`JsonNullable`/`Optional` 래퍼 필드**: "값이 실려 왔는지"와
  "실려 온 값이 null인지"를 분리해 담는다.
  (예: OpenAPI Generator의 `JsonNullable<String>`)
- **JSON Merge Patch (RFC 7386)**: "null = 제거, 없음 = 유지"를
  표준으로 정의한 포맷. 바디를 DTO가 아닌 트리(맵)로 받아
  키 존재 여부를 직접 검사한다.
- **JSON Patch (RFC 6902)**: `[{"op": "replace", "path": "/email",
  "value": "..."}]`처럼 연산 목록으로 표현. 표현력이 가장 크지만
  클라이언트 작성 비용도 크다.

실무에서는 "nullable 필드가 있는 PATCH는 이 구분 문제를 반드시
설계 단계에서 짚고, 팀 컨벤션(예: Merge Patch 시맨틱)을 API 문서에
명시한다"까지 말하면 계약을 다루는 태도가 드러난다. (가산점 포인트)

## 4. 꼬리질문 대비 포인트

### "PUT은 멱등한데 POST는 왜 멱등하지 않나요?"

POST `/orders`는 "컬렉션에 새 자원을 추가하라"는 요청이라 호출할
때마다 새 자원이 생긴다(주문 2건). PUT `/orders/42`는 "42번 자원을
이 상태로 만들어라"라서 몇 번을 반복해도 최종 상태가 같다. 이 차이는
실무에서 **재시도 정책**으로 직결된다 — 타임아웃 시 PUT은 그냥
재시도해도 되지만, POST 재시도는 중복 생성이 되므로 멱등성 키 같은
별도 장치가 필요하다.

### "값을 지정하는 PATCH는 사실상 멱등인데, 왜 '멱등이 아니다'라고 하나요?"

멱등성은 개별 요청의 우연한 성질이 아니라 **메서드 단위의 계약**이다.
HTTP 스펙이 PATCH에 멱등을 약속하지 않았기 때문에, 프록시·클라이언트
라이브러리·재시도 미들웨어는 "PATCH는 재시도하면 위험할 수 있다"를
전제로 동작한다. 내 PATCH가 우연히 멱등이더라도 그건 스펙이 아니라
구현 사정이므로, 계약으로 보장하고 싶다면 PUT을 쓰거나 멱등성 키를
도입해야 한다.

### "PUT으로 자원 생성도 가능한가요?"

가능하다 — 단, **클라이언트가 URI(식별자)를 결정할 수 있을 때**다.
`PUT /users/42/profile-image`처럼 위치가 정해진 자원은 "없으면 생성
(201), 있으면 교체(200/204)"하는 upsert 시맨틱으로 쓸 수 있다.
반면 서버가 ID를 발급하는 일반적인 생성(`/orders`의 새 주문)은
클라이언트가 URI를 모르므로 POST를 쓴다.

### "그럼 수정 API는 무조건 PATCH로 만드는 게 좋은가요?" (시니어 변별 포인트)

트레이드오프가 있다.

- **PUT의 강점**: 시맨틱이 단순하고(보낸 게 곧 최종 상태) 멱등이라
  재시도가 안전하다. "설정 저장"처럼 클라이언트가 항상 전체 상태를
  들고 있는 화면에는 PUT이 오히려 깔끔하다.
- **PATCH의 강점**: 부분 수정 화면이 여러 개일 때 각 화면이 자기
  필드만 보내면 되고, 동시에 다른 필드를 수정하는 요청과 **서로
  덮어쓰지 않는다** (PUT 둘이 교차하면 한쪽 수정이 통째로 증발한다 —
  lost update).
- 나의 기준: **클라이언트가 전체 표현을 신뢰성 있게 갖고 있는가?**
  갖고 있으면 PUT, 화면이 쪼개져 있거나 필드가 많으면 PATCH.
  그리고 어느 쪽이든 동시 수정이 문제라면 메서드 선택이 아니라
  ETag/If-Match 같은 낙관적 동시성 제어로 풀어야 한다.

### "@PatchMapping만 붙이면 부분 수정이 되는 건가요?"

안 된다 — **애너테이션은 라우팅만 담당하고, 부분 수정 시맨틱은 전적으로
구현 책임**이다. `@PatchMapping` 안에서 DTO 전체를 엔티티에 덮어쓰면
그건 이름만 PATCH인 PUT이고(3장의 null 덮어쓰기 사고 재현), 반대로
`@PutMapping`에서 null 필드를 스킵하면 이름만 PUT인 PATCH다.
메서드 이름과 실제 동작이 어긋난 API가 계약 사고의 진원지다.

---

## 한 줄 요약

PUT은 "바디가 곧 자원의 완전한 최종 상태"인 전체 교체(멱등),
PATCH는 "보낸 것만 바꾸는" 부분 수정(멱등 비보장)이다 — 이 시맨틱이
흐려지는 순간 "안 보낸 필드가 null로 덮이는" 데이터 유실이 계약
수준에서 발생하므로, 메서드의 약속과 구현의 실제 동작을 일치시키는
규율이 핵심이다.
