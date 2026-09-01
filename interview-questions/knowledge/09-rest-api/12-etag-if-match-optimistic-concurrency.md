# ETag / If-Match 낙관적 동시성 — lost update를 HTTP 계약으로 막는다

> 핵심 관전 포인트: **두 관리자가 같은 화면을 열어 편집하면, 나중에 저장한
> 쪽이 먼저 저장한 쪽의 변경을 조용히 덮어쓴다(lost update). DB의 낙관적
> 락(`@Version`)이 트랜잭션 안에서 하는 일을 HTTP 계층으로 끌어올린 것이
> 조건부 요청이다 — GET 응답에 리소스의 버전 지문인 `ETag`를 실어주고,
> 클라이언트는 수정 요청(PUT/PATCH)에 `If-Match: <그 ETag>`를 붙인다.
> 서버는 현재 버전과 대조해 다르면 요청을 실행하지 않고 `412 Precondition
> Failed`를 반환한다. 상태 코드 구분이 변별 지점이다: 412는 "네가 건
> 전제조건(If-Match)이 거짓"이라는 조건부 요청 메커니즘의 응답이고, 409는
> 전제조건 헤더 없이 리소스의 현재 상태와 충돌했다는 일반 충돌 응답이다.
> If-Match를 안 보낸 요청은 `428 Precondition Required`로 거부해 낙관적
> 동시성을 선택이 아닌 계약으로 강제할 수 있다.**

---

## 0. 질문 + 의도

**질문**: "낙관적 동시성 제어를 API 레벨에서 어떻게 표현하나요?
(ETag, If-Match, 409 vs 412)"

**출제 의도**: 두 관리자가 같은 데이터를 편집하는 lost update를 API
계약으로 막는 설계. DB 락 지식을 HTTP 계층으로 번역할 수 있는지 —
계층을 넘나드는 응용력을 본다.

(DB 계층의 낙관적 락 자체 — `@Version`의 UPDATE SQL, 예외 타입, 재시도
전략 — 는 `03-jpa-orm/10-optimistic-vs-pessimistic-lock.md` 참고.
이 문서는 그것을 **HTTP 계약으로 표현하는 층** — 헤더 흐름과 상태 코드
선택 — 에 집중한다.)

## 1. 문제의 형태 — API에는 트랜잭션이 없다

DB 안에서라면 read-modify-write를 한 트랜잭션으로 묶거나 락을 걸 수
있다. 하지만 API 소비자의 편집 흐름은 이렇다:

```text
관리자 A: GET /products/42  (10:00, 화면에 띄움)
관리자 B: GET /products/42  (10:01, 같은 화면)
관리자 B: PUT /products/42  (10:05, 가격 수정 저장) → 200
관리자 A: PUT /products/42  (10:07, 재고 수정 저장) → 200
          └ B의 가격 수정이 A가 10:00에 본 낡은 값으로 되돌아감 — lost update
```

GET과 PUT 사이에 **몇 분짜리 "사람의 생각 시간"**이 끼어 있다. 이 구간을
DB 락으로 잡아둘 수는 없다(트랜잭션을 몇 분 열어두거나, 편집 중 이탈한
사용자의 락을 회수하는 문제가 생긴다). 그래서 낙관적 방식 — **잠그지
않고, 저장 시점에 "내가 본 버전 그대로인가"를 검사** — 이 필요한데,
문제는 이 검사를 표현할 어휘가 API 계약에 있어야 한다는 것이다. HTTP는
이 어휘를 표준으로 갖고 있다: **ETag와 조건부 요청(precondition) 헤더**.

비유: 문서 결재판에 **판 버전 스티커**가 붙어 있다고 생각하면 된다.
결재판을 복사해 간 사람(GET + ETag)이 수정본을 제출할 때 "v3 기준으로
고쳤습니다"(If-Match)라고 명시하면, 접수 담당자는 원본이 이미 v4가
됐을 경우 접수를 거부한다(412) — 담당자가 두 수정본을 말없이 겹쳐
붙이는(덮어쓰는) 사고가 원천 차단된다.

## 2. 헤더 흐름 — ETag를 주고, If-Match로 돌려받는다

### 2-1. 전체 왕복

```http
GET /products/42 HTTP/1.1

HTTP/1.1 200 OK
ETag: "7"                          ← 리소스의 현재 버전 지문

{ "id": 42, "price": 50000, "stock": 10 }
```

```http
PUT /products/42 HTTP/1.1
If-Match: "7"                      ← "내가 본 버전이 7일 때만 실행하라"

{ "id": 42, "price": 50000, "stock": 8 }
```

- 버전이 그대로면: 실행 후 `200 OK` + **새 ETag**(`"8"`)를 응답에 실어
  준다 — 클라이언트가 연속 편집을 이어갈 수 있게.
- 그 사이 누가 고쳤으면: **요청을 실행하지 않고** `412 Precondition
  Failed`. 서버 상태는 그대로다.

```http
HTTP/1.1 412 Precondition Failed

{ "code": "CONCURRENT_MODIFICATION",
  "message": "리소스가 다른 사용자에 의해 수정되었습니다. 다시 조회 후 수정해주세요." }
```

### 2-2. 서버 구현 스케치 — ETag의 원천은 결국 버전 컬럼

```java
// Before: If-Match 없이 그대로 덮어쓰기 — last write wins
@PutMapping("/products/{id}")
public ProductResponse update(@PathVariable Long id,
                              @RequestBody ProductRequest req) {
    return productService.update(id, req);  // 늦게 온 쪽이 조용히 이긴다
}

// After: ETag 발급 + If-Match 검증
@GetMapping("/products/{id}")
public ResponseEntity<ProductResponse> get(@PathVariable Long id) {
    Product p = productService.find(id);
    return ResponseEntity.ok()
            .eTag(String.valueOf(p.getVersion()))   // @Version 값을 ETag로
            .body(ProductResponse.of(p));
}

@PutMapping("/products/{id}")
public ResponseEntity<ProductResponse> update(
        @PathVariable Long id,
        @RequestHeader(value = "If-Match", required = false) String ifMatch,
        @RequestBody ProductRequest req) {

    if (ifMatch == null) {
        // 전제조건 없이 온 수정 요청 — 낙관적 동시성을 "강제"하려면 거부
        return ResponseEntity.status(428).build();  // Precondition Required
    }
    Product updated = productService.update(id, req, parseVersion(ifMatch));
    // 서비스 내부: 조회한 엔티티 version과 If-Match 값 비교 →
    //   다르면 PreconditionFailedException → @ControllerAdvice에서 412
    //   같으면 UPDATE (@Version이 최후의 안전망으로 한 번 더 검증)
    return ResponseEntity.ok()
            .eTag(String.valueOf(updated.getVersion()))
            .body(ProductResponse.of(updated));
}
```

여기서 계층 번역의 그림이 완성된다 (가산점 포인트):

- **JPA `@Version`**: DB 커밋 순간의 최후 방어선 — `UPDATE ... WHERE
  version = ?`의 영향 행 수로 충돌 감지.
- **ETag / If-Match**: 그 버전 검사를 **GET과 PUT 사이의 사람 시간**까지
  확장한 것. 검사 재료(version)는 같고, 검사가 일어나는 경계가 DB
  트랜잭션에서 HTTP 왕복으로 넓어졌다.
- 실무에서는 둘을 겹쳐 쓴다 — API 레벨 If-Match가 대부분을 거르고,
  같은 서버 안의 동시 요청 레이스는 `@Version`이 최종적으로 잡는다.
  `OptimisticLockingFailureException`을 `@ControllerAdvice`에서 412(또는
  팀 규약에 따라 409)로 번역하는 매핑까지 말하면 완성형이다.

### 2-3. ETag 값은 무엇으로 만드나

- **버전 번호** (권장): `@Version` 컬럼 값 그대로. 단조 증가, 비교 명확,
  생성 비용 0. 대부분의 낙관적 동시성 용도에 최선.
- **내용 해시**: 표현(바디)을 해시. 버전 컬럼이 없는 리소스나 파생/집계
  표현에 유용하지만 매 응답마다 해시 비용이 든다.
- **수정 시각**: 같은 초(또는 같은 밀리초)에 두 번 수정되면 구분을 못
  하는 정밀도 함정이 있다 — `Last-Modified`/`If-Unmodified-Since`가
  초 단위라 동시성 제어용으로는 ETag보다 약한 이유와 같다.

ETag에는 강한(strong) 것과 약한(`W/"..."`) 것이 있다는 것도 알아두자 —
약한 ETag는 "의미상 같음"만 보장해서 바이트 단위 일치가 필요한 용도
(Range 요청 이어받기 등)에 못 쓰고, **If-Match 비교에서도 강한 ETag를
쓰는 것이 안전하다**. 버전 번호 기반이면 자연히 강한 ETag다.

## 3. 상태 코드 선택 — 409 vs 412, 그리고 428

이 질문의 괄호가 굳이 "409 vs 412"를 짚는 이유: 두 코드 모두 "충돌"처럼
보이지만 **메커니즘이 다르다**.

- **412 Precondition Failed**: 클라이언트가 조건부 헤더(`If-Match`,
  `If-Unmodified-Since` 등)로 건 **전제조건이 거짓으로 평가**되어, 서버가
  요청을 실행하지 않았다. 즉 412는 조건부 요청 메커니즘 전용 응답이다.
  ETag/If-Match로 낙관적 동시성을 구현했다면 충돌의 정답은 412다.
- **409 Conflict**: 전제조건 헤더와 무관하게, 요청이 **리소스의 현재
  상태와 충돌**해서 수행할 수 없다. 예: 이미 배송 시작된 주문의 취소
  요청, 유니크한 이름의 중복 생성, "CANCELLED 상태에서는 수정 불가" 같은
  상태 기계 위반. 또, 버전을 헤더가 아니라 **요청 바디의 필드**(예:
  `"version": 7`)로 받는 설계라면 조건부 요청 메커니즘을 쓰는 게 아니므로
  충돌 시 409를 쓰는 것이 자연스럽다 — 실무 API 중 이 방식도 많다.
- **428 Precondition Required**: 이 리소스의 수정에는 전제조건이
  **필수**인데 클라이언트가 If-Match 없이 요청했다. 이 코드가 있어야
  낙관적 동시성이 "보내는 클라이언트만 보호받는 옵션"이 아니라 **모든
  소비자에게 강제되는 계약**이 된다 — If-Match 없는 PUT을 그냥 통과시키면
  가장 방어적인 클라이언트만 손해 보는 구조가 되기 때문이다.

한 줄 기준: **"클라이언트가 헤더로 건 전제가 깨졌다 → 412, 전제 헤더
없이 상태가 안 맞는다 → 409, 전제를 걸어야 하는데 안 걸었다 → 428."**

같은 헤더 가족의 다른 용도와 혼동하지 않기:

| 헤더 조합 | 용도 | 실패 시 |
|---|---|---|
| `If-Match` + PUT/PATCH/DELETE | 낙관적 동시성 (lost update 방지) | 412 |
| `If-None-Match` + GET | 캐시 재검증 ("바뀐 것 없으면 바디 생략") | 304 Not Modified |

같은 ETag를 재료로 쓰지만, If-Match는 **쓰기 안전**, If-None-Match는
**읽기 절약**이다. "ETag = 캐시용"으로만 알고 있으면 이 질문에서 바로
드러난다.

## 4. 꼬리질문 대비 포인트

### "412를 받은 클라이언트는 그다음에 뭘 해야 하나요?"

412는 "네 사본이 낡았다"는 신호이므로 클라이언트의 복구 절차는: ① 다시
GET해서 최신 표현 + 새 ETag를 받는다 → ② 자신의 변경을 최신본 위에
다시 적용할 수 있는지 판단한다 → ③ 새 If-Match로 재요청한다. 여기서
②는 기술이 아니라 **UX/제품 결정**이다 — 필드가 안 겹치면 자동 병합해
재시도할 수도 있고, 겹치면 "다른 사용자가 수정했습니다. 변경 내용을
확인하세요"라며 diff를 보여줘야 할 수도 있다. "412는 자동 재시도로
뭉개면 안 되는 에러"(그냥 재-GET 후 무조건 재전송하면 결국 last write
wins로 되돌아간다)라는 지적까지 하면 좋다.

### "PATCH는 부분 수정인데도 If-Match가 필요한가요?"

필요하다. PATCH가 바꾸는 필드가 작아도 클라이언트가 **무엇을 어떻게
바꿀지 결정한 근거는 낡은 사본**일 수 있다 — 예: "재고가 10인 걸 보고
8로 고치는" PATCH는 그 사이 재고가 3이 됐다면 잘못된 결정이다. 오히려
PATCH는 "겹치는 필드만 아니면 안전하다"는 착시 때문에 If-Match를
생략하기 쉬워서 더 위험하다. 다만 "조회 없이도 항상 유효한 연산"(예:
`+1` 증가 같은 상대적 연산)으로 설계된 엔드포인트라면 전제조건 없이도
안전할 수 있다 — 전제조건의 필요 여부는 메서드가 아니라 **연산이 낡은
읽기에 의존하는가**로 판단한다.

### "ETag 없이 요청 바디에 version 필드를 넣는 방식과 뭐가 다른가요?"

기능적으로는 같은 낙관적 검사다. 차이는 계약의 위치와 표준성 —
헤더(ETag/If-Match) 방식은 HTTP 표준 시맨틱이라 중간 계층(캐시,
게이트웨이, 표준 클라이언트 라이브러리)이 이해하고, 412/428 같은 표준
코드와 자연스럽게 짝이 되며, 리소스 표현(바디)에 동시성 제어라는 별도
관심사를 섞지 않는다. 바디 version 방식은 구현이 직관적이고 폼 데이터에
실어 보내기 쉬운 대신, 충돌 응답 코드가 팀 규약(주로 409)으로 정해지고
DELETE처럼 바디가 어색한 메서드에 적용하기 애매하다. "어느 쪽이든 팀
전체가 한 방식으로 일관되게, 문서에 명시하는 것"이 정답의 마무리다.

### "GET마다 ETag를 만들려면 비용이 들지 않나요? 컬렉션 응답은요?"

단건 리소스가 버전 컬럼 기반이면 비용은 사실상 0이다(이미 조회한
엔티티의 필드 하나). 해시 기반이면 응답 직렬화 결과에 해시 비용이
붙는데, 동시성 제어 목적이라면 해시 대신 버전 컬럼을 두는 쪽으로 푸는
게 낫다. 컬렉션(목록) 응답은 편집 대상이 아니므로 If-Match용 ETag가
필요 없고, 캐시 재검증용이라면 별개 판단이다 — "ETag를 어디에 왜
붙이는가"를 용도(쓰기 보호 vs 캐시)별로 구분해 답하는 것이 포인트다.

### "이 방식 대신 비관적으로 '편집 잠금'을 거는 설계와는 어떻게 고르나요?" (시니어 변별 포인트)

충돌의 빈도와 작업의 크기로 고른다. 낙관적(ETag/If-Match)은 충돌이
드물 때 최선 — 평소 비용이 0이고, 드문 충돌만 412로 처리한다. 하지만
**30분짜리 긴 편집**(대형 문서, 복잡한 설정 화면)에서 충돌이 잦다면,
사용자가 30분 작업을 날리고 412를 받는 경험은 재앙이다. 이때는 API
레벨의 비관적 접근 — 편집 시작 시 잠금 리소스를 획득(예: `POST
/documents/42/lock`)하고 TTL로 유령 잠금을 회수하는 설계 — 이나, 아예
충돌 자체를 병합으로 흡수하는 실시간 협업 편집 쪽으로 문제를 옮긴다.
"기본은 낙관적, 편집 세션이 길고 충돌 비용이 크면 잠금 리소스 도입"이라는
선택 기준과, 잠금 도입 시 따라오는 비용(TTL·강제 해제·소유권 UX)까지
말하면 계층 번역 능력에 더해 트레이드오프 감각을 보여줄 수 있다.

---

## 한 줄 요약

낙관적 동시성의 API 표현은 "GET에 ETag(버전 지문)를 실어주고, 수정
요청의 If-Match로 돌려받아, 다르면 실행 없이 412"라는 표준 왕복이다 —
전제 헤더가 깨지면 412, 헤더 없는 상태 충돌은 409, 전제를 강제하려면
428로 코드를 구분하고, ETag의 원천을 DB `@Version`과 잇는 계층 번역까지
말할 수 있어야 lost update를 계약으로 막는 설계가 완성된다.
