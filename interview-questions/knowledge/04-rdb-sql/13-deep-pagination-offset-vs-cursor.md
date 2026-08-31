# 깊은 페이지네이션 — `OFFSET`은 "건너뛰기"가 아니라 "읽고 버리기"다

> 핵심 관전 포인트: **`LIMIT 100000, 20`이 느린 이유는 DB가 10만 건을
> 건너뛰는 게 아니라 100,020건을 전부 읽어 조립한 뒤 앞의 10만 건을
> 버리기 때문이다. B+Tree에는 "앞에서 N번째"라는 좌표가 없어 세며 걷는
> 것 말고는 방법이 없고, 정렬 기준이 세컨더리 인덱스면 버릴 행에
> 대해서도 PK로 클러스터드 인덱스를 다시 찾는 북마크 룩업(랜덤 I/O)을
> 100,020번 지불한다 — 비용이 페이지 번호에 선형으로 비례한다. 해결책은
> 네 가지를 한 번에 꺼낸다: ① 커서(키셋) 기반 — `WHERE (created_at, id) <
> (마지막 값)`으로 시작점을 인덱스 탐색으로 바꿔 offset 자체를 없앤다
> ② 지연 조인(deferred join) — 커버링 인덱스로 PK 20개만 먼저 뽑아 북마크
> 룩업을 20회로 줄인다 ③ offset 상한을 API 레벨에서 강제한다(안전망)
> ④ 복잡한 검색은 검색 엔진에 위임한다. 그리고 커서의 대가 — 임의 페이지
> 점프 불가, 정렬 키 유일성 필요, API 스펙 변경 — 를 한 호흡에 같이
> 말해야 완결된 답이다.**

---

## 0. 질문 + 의도

**질문**: "`LIMIT 100000, 20` 같은 깊은 페이지네이션이 느린 이유와
해결책(no-offset, 커서 기반)은?"

**출제 의도**: rationale은 이 문항을 이렇게 설명한다 — "관리자 페이지나
크롤러가 유발하는 고전적 부하 패턴. **offset의 비용 구조를 알아야 커서
기반으로 재설계할 수 있고, 이는 API 스펙 변경까지 수반하므로 미리 아는
것의 가치가 크다.**" 채점 지점은 셋이다. ⑴ "느리다"를 메커니즘으로
설명하는가(왜 skip이 아니라 read-and-discard인가) ⑵ 해결책을 목록으로
꺼내고 각각의 대가를 붙이는가 ⑶ 커서 전환이 DB 쿼리 하나가 아니라 API
스펙·클라이언트·UI까지 바꾸는 조직적 결정임을 내다보는가.

**이 문서가 특히 겨냥하는 네 지점** (4장 기본 구간에서 반복된 패턴):

- **비용을 이름 붙은 사슬로** — "offset이 크면 DB가 많이 읽어서 느리다"에서
  멈추지 않고, 서버 계층의 카운터 → 스토리지 엔진의 행 조립 → 북마크
  룩업 × 100,020 → 버퍼 풀 미스 → 랜덤 I/O까지 고리를 하나씩 말한다(§1).
- **트레이드오프를 양면으로** — 커서 기반은 "빠르다"로 끝내지 않는다.
  잃는 것(임의 페이지 점프, 정렬 유연성, total count, API 호환)을 같은
  호흡에 붙인다(§2-1, §5).
- **안전망을 코드로 고정** — "깊은 페이지는 막아야 한다"는 말이 아니라,
  사람이 기억하지 않아도 작동하는 인터셉터 한 장으로 상한을 강제한다(§2-3).
- **목록 인출** — 해결책은 항상 네 개를 세트로 꺼낸다(§2 서두).

**옆 문항과의 경계**: [컬렉션 fetch join + 페이징](../03-jpa-orm/08-fetch-join-pagination-in-memory.md)은
Hibernate가 `limit`을 SQL에서 **빼 버리고** 힙에서 자르는 JPA 계층 문제다.
이 문항은 `limit`/`offset`이 SQL에 **정상적으로 붙었는데도** DB가 offset만큼
읽고 버리는 DB 계층 문제다. 둘 다 "페이징이 느리다"로 보고되지만 원인
계층이 다르다.

---

## 1. 왜 느린가 — offset은 skip이 아니라 read-and-discard다

### 1-1. B+Tree에는 "앞에서 10만 번째"라는 좌표가 없다

인덱스는 "값이 X인 곳"으로 가는 데는 트리 높이만큼(로그 시간)이면 되지만,
"앞에서 N번째"로 가는 길은 **없다.** 노드가 자기 아래 서브트리에 행이
몇 건 있는지를 세어 두지 않기 때문이다. 게다가 MVCC 때문에 트랜잭션마다
보이는 행 집합이 다르므로 "N번째"라는 값은 애초에 저장해 둘 수도 없다.
그러니 10만 번째로 가려면 **처음부터 세며 걷는 수밖에 없다.**

세는 주체가 누구인지도 중요하다. `LIMIT`/`OFFSET`은 스토리지 엔진(InnoDB)이
아니라 그 위층의 **SQL 서버 계층**이 처리한다. 엔진은 조건에 맞는 행을
한 건씩 위로 올리고, 서버 계층이 카운터를 세며 offset에 못 미친 행은
버린다. 엔진 입장에서는 그 행이 "결국 버려질 행"인지 알 길이 없으므로
**행을 온전히 조립해서 올린다.** 이 한 문장이 아래 모든 비용의 출발점이다.

```text
스토리지 엔진(InnoDB)            SQL 서버 계층
  행 1 조립 ──────────────▶  카운터 1      < 100,000 → 버림
  행 2 조립 ──────────────▶  카운터 2      < 100,000 → 버림
  ...                          ...
  행 100,000 조립 ────────▶  카운터 100,000           → 버림
  행 100,001 조립 ────────▶  결과 버퍼 [1]
  ...
  행 100,020 조립 ────────▶  결과 버퍼 [20]  → 클라이언트로
```

읽은 행 100,020건, 반환한 행 20건. **일의 양은 offset + limit에 비례**하고
결과의 크기와는 무관하다 — 1페이지(20건 읽기)와 5,001페이지(100,020건
읽기)의 비용 차이가 5,001배다. 이게 "깊은 페이지네이션"의 정의다.

### 1-2. 사슬 A — 정렬 키가 PK(클러스터드 인덱스)일 때: 순차지만 선형

```sql
SELECT * FROM posts ORDER BY id DESC LIMIT 100000, 20;
```

> ① 클러스터드 인덱스 리프의 맨 끝에서 출발(DESC) → ② 리프 연결
> 리스트를 따라 행을 한 건씩 서버 계층으로 올림(리프에 행 전체가 있으니
> 추가 탐색은 없다) → ③ 서버 계층이 100,000건을 세며 버림 → ④ 그다음
> 20건만 결과로.

가장 덜 나쁜 경우다 — 랜덤 I/O가 없고 리프를 이어 읽는 **순차 I/O**다.
그러나 100,020건은 리프 페이지 수백~수천 장이고, 오래된 데이터의
페이지일수록 버퍼 풀에 없을 확률이 높다 → 캐시 미스 → 디스크 읽기. 순차라
싸다는 것이지, **읽는 양 자체는 여전히 offset에 선형**이다.

### 1-3. 사슬 B — 정렬 키가 세컨더리 인덱스일 때: 북마크 룩업 100,020번

이 케이스가 이 문항의 심장이다. 목록 화면은 대부분 PK가 아니라
`created_at`, `updated_at`, `score` 같은 컬럼으로 정렬한다.

```sql
-- idx_created_at (created_at) 존재. posts 에는 title, body 등 컬럼이 많다.
SELECT * FROM posts ORDER BY created_at DESC LIMIT 100000, 20;
```

> ① 옵티마이저가 정렬 작업(filesort)을 피하려고 `idx_created_at`을 고른다
> → ② InnoDB가 인덱스 리프의 끝에서 엔트리 하나를 읽는다 — 리프에는
> **(created_at, PK)만** 있다([세컨더리 인덱스 구조](03-clustered-vs-secondary-index.md))
> → ③ `SELECT *`라 나머지 컬럼이 필요하다 → 얻은 PK로 **클러스터드
> 인덱스를 루트부터 다시 탐색**해 행 전체를 조립한다(**북마크 룩업**) —
> 대상 페이지는 트리 어딘가에 흩어져 있으므로 **랜덤 I/O**
> → ④ 조립된 행을 서버 계층으로 올린다 → 서버 계층: "아직 100,000
> 미만" → **버린다**
> → ⑤ ②~④를 **100,000번 반복** — 버릴 행에도 ③의 랜덤 I/O를 전부 지불한다
> → ⑥ 100,001번째부터 20건만 결과 버퍼에 담아 반환.

합계: 인덱스 엔트리 100,020건 + **북마크 룩업 100,020회** + 그중 버퍼 풀에
없는 페이지만큼의 디스크 랜덤 읽기. 결과는 20건. [랜덤 I/O가 왜 순차
I/O보다 비싼가](02-index-not-used-full-scan.md)의 비용 모델이 그대로 곱해진다.

면접에서 말하는 문장으로 압축하면 — **"세컨더리 인덱스로 정렬하면 리프에
PK밖에 없어서, 버릴 10만 건에 대해서도 PK로 테이블을 다시 찾는 랜덤
I/O를 10만 번 하고 나서 버립니다."**

**옵티마이저가 다른 길을 고르기도 한다** — "10만 번 랜덤 룩업보다
테이블을 통째로 순차로 읽고 정렬하는 게 싸다"고 판단하면 풀스캔 +
filesort로 간다. 그래도 정렬된 결과에서 앞 10만 건을 버리는 건
마찬가지다. 어느 길이든 **비용이 offset 또는 테이블 크기에 비례**하고,
결과 20건과는 무관하다.

### 1-4. 사슬 C — 정렬 컬럼에 인덱스가 없을 때

풀스캔 → 조건에 맞는 전체를 정렬(filesort, 정렬 버퍼를 넘치면 디스크
임시 파일) → 앞 10만 건 버림. 이건 offset이 없어도 이미 비싼 쿼리이고,
offset은 그 위에 얹힌다. 이 경우의 1차 처방은 페이지네이션 기법이
아니라 **정렬 컬럼 인덱스**다 — 그다음에야 §2가 의미 있다.

### 1-5. 덤으로 따라오는 비용 — 페이지 번호 UI의 `COUNT(*)`

"전체 3,204페이지 중 5,001페이지"를 그리려면 매 요청마다 조건에 맞는
전체 건수를 세야 한다. 이 COUNT는 목록 본체보다 비싼 경우가 많다 —
별도 문항(total count의 비용)의 주제이므로 여기서는 "offset 페이지네이션은
보통 COUNT와 세트로 와서 비용이 두 배로 든다"는 사실만 고정한다.

### 1-6. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "offset이 크면 느리다" | **read-and-discard** | B+Tree에 N번째 좌표 없음 → 서버 계층이 세며 버림 → 일의 양 = offset + limit → 페이지 번호에 선형 |
| "DB가 많이 읽는다" | **북마크 룩업 × offset** | 세컨더리 인덱스 리프엔 PK만 → 버릴 행마다 클러스터드 재탐색 → 랜덤 I/O 100,020회 |
| "메모리에 부담" | **버퍼 풀 미스** | 깊은 페이지 = 오래된 데이터 = 버퍼 풀에 없음 → 캐시 미스 → 디스크 랜덤 I/O로 전락 |

`EXPLAIN`에서는 `rows`가 offset + limit 규모로 잡히고(20이 아니라 10만
단위), 인덱스를 못 탔으면 `Extra`에 `Using filesort`가 붙는다. "느린
이유"를 실행 계획으로 증명하는 습관까지 붙이면 답이 닫힌다.

---

## 2. 해결책 4가지 — 목록으로 먼저, 각각의 대가와 함께

면접에서는 이 네 개를 **세트로** 꺼낸다. 하나만 말하면 "그 방법을 못 쓰는
상황에서는요?"가 바로 따라온다.

1. **커서(키셋, no-offset) 기반** — offset 자체를 없앤다. 근본 해결.
2. **지연 조인(deferred join)** — offset은 유지하되, 버릴 행의 북마크
   룩업을 없앤다. 완화책이지만 API 변경이 없다.
3. **offset 상한** — 깊은 페이지 요청을 아예 거절한다. 안전망.
4. **검색 엔진/전용 저장소 위임** — 다중 필터 + 자유 정렬 + 깊은 탐색이
   동시에 필요하면 RDB의 일이 아니다. 구조 변경.

실무 조합은 보통 **③은 항상 + ①이나 ② 중 하나**다. ③ 없이 ①만 하면
구 API가 남아 있는 동안 계속 두들겨 맞는다.

### 2-1. 커서(키셋) 기반 — "몇 번째부터"를 "이 값 다음부터"로

원리는 하나다. B+Tree는 "N번째"는 못 찾지만 **"값이 X보다 작은 첫
지점"은 로그 시간에 찾는다.** 그러니 "지난 페이지의 마지막 값"을
클라이언트가 들고 왔다가 `WHERE`로 넘기면, 시작점 탐색이 O(offset)에서
트리 높이 한 번으로 바뀐다. 읽는 양은 페이지가 아무리 깊어도 항상
limit + 1건이다.

```sql
-- ❌ before: 5,001페이지 — 100,020건 읽고 100,000건 버림
SELECT * FROM posts
ORDER BY id DESC
LIMIT 100000, 20;

-- ✅ after: "마지막으로 본 id 다음부터 20건" — 인덱스 탐색 1회 + 20건 순차 읽기
SELECT * FROM posts
WHERE id < :last_seen_id          -- 지난 페이지 마지막 행의 id
ORDER BY id DESC
LIMIT 20;
```

#### 복합 정렬 키 — `created_at` 하나로는 안 되는 이유와 튜플 비교

실제 목록은 `created_at DESC`처럼 **유일하지 않은** 컬럼으로 정렬한다.
같은 초에 글이 세 개 올라올 수 있다. 이때 커서를 `created_at < :last`로
쓰면 **같은 시각의 나머지 글이 건너뛰어지고**(누락), `<=`로 쓰면 **이미 본
글이 다시 온다**(중복). 정렬 키가 행을 유일하게 식별하지 못하면 "그
다음"이 정의되지 않는다는 뜻이다.

처방은 **유일한 컬럼을 tie-breaker로 붙여 정렬 순서를 전순서(total order)로
만드는 것** — `(created_at, id)`. 커서도 두 값을 함께 들고, 조건은 튜플
비교다.

```sql
-- 정렬 키 (created_at DESC, id DESC) 에 맞춘 커서 조건
-- 인덱스: (created_at, id)  ← InnoDB 세컨더리 인덱스는 리프에 PK를 품으므로
--         (created_at) 만 있어도 사실상 이 순서로 정렬돼 있지만, 명시하는 편이
--         실행 계획 예측이 쉽다.

-- 형태 1: 풀어 쓴 조건 — 어느 DB/버전에서든 인덱스 범위 스캔으로 잘 잡힌다
SELECT * FROM posts
WHERE  created_at <  :last_created_at
   OR (created_at =  :last_created_at AND id < :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- 형태 2: 행 생성자(row constructor) 비교 — 같은 의미를 한 줄로
SELECT * FROM posts
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- PostgreSQL 은 이 형태를 인덱스로 잘 태운다. MySQL 은 문법은 지원하지만
-- 인덱스 범위 최적화 여부가 버전·조건에 따라 달라 EXPLAIN 으로 확인하고,
-- 확실하지 않으면 형태 1 로 쓴다.
```

읽는 방법: "created_at이 더 이르거나, **같은 시각이면** id가 더 작은 것"
— 정렬 순서(둘 다 DESC)와 부등호 방향(둘 다 `<`)이 반드시 일치해야 한다.
ASC 정렬이면 `>`로 뒤집는다. 정렬 방향이 섞이면(`created_at DESC, id ASC`)
조건도 `... AND id > :last_id`로 그 컬럼만 뒤집는다.

#### 커서는 불투명(opaque) 문자열로 넘긴다

클라이언트에 `created_at`과 `id`를 따로 노출하면 클라이언트가 값을 조작해
호출하기 시작하고, 나중에 정렬 키를 바꿀 수 없게 된다. **두 값을 하나로
직렬화해 Base64 같은 불투명 토큰**으로 주고받는다 — "이 문자열을 다음
요청에 그대로 돌려주세요"가 계약이 된다.

```json
{
  "items": [ ... 20건 ... ],
  "nextCursor": "MjAyNi0wOC0zMFQxMjozNDo1NnwxMDIwMzQ",
  "hasNext": true
}
```

#### 커서 기반의 대가 — 얻는 것과 잃는 것을 한 호흡에

| 얻는 것 | 지불하는 것 |
|---|---|
| 깊이와 무관한 상수 비용 | **임의 페이지 점프 불가** — "3,204페이지로" 못 간다 |
| 스크롤 중 삽입·삭제에도 중복/누락 없음 | **정렬 키 유일성 필요** — tie-breaker와 복합 인덱스 설계 |
| COUNT 쿼리 불필요(Slice) | **total count 미제공** — 페이지 번호 UI 불가 |
|  | **정렬 축마다 커서 설계** — 동적 정렬(컬럼 헤더 클릭)과 상성이 나쁨 |
|  | **API 스펙 변경** — 클라이언트 전부 수정, 구·신 API 병행 기간 |

각 대가를 풀어 쓰면:

- **임의 페이지 점프 불가**: 커서는 "직전 페이지의 끝"만 안다. 페이지
  번호를 눌러 아무 데나 가는 UI는 성립하지 않는다. 그래서 커서는 **무한
  스크롤·"더 보기"·타임라인**과 짝이고, 페이지 번호 UI를 기획이 고수하면
  ②+③으로 가야 한다.
- **정렬 키 유일성**: 위에서 본 대로 tie-breaker가 필수이고, 정렬 키는
  **불변**이어야 한다. `updated_at DESC` 정렬에 커서를 쓰면 스크롤 도중
  갱신된 행이 위로 튀어 올라 위치가 바뀌고, 중복/누락이 다시 생긴다.
- **total count 미제공**: "전체 12,345건" 표시가 사라진다. 대개 이건
  손실이 아니라 §1-5의 COUNT 비용까지 함께 던져 버리는 이득이지만, 기획과
  합의가 필요한 **요구사항 변경**이다.
- **정렬 축마다 커서**: 정렬 기준이 바뀌면 커서의 구성 값도, 인덱스도
  바뀐다. 관리자 그리드처럼 컬럼마다 정렬을 바꾸는 화면에는 커서가 맞지
  않는다 — 그건 ④(검색 엔진)의 영역이다.
- **API 스펙 변경**: `page`/`size`가 `cursor`/`size`로 바뀌고 응답 구조도
  바뀐다. 모바일 앱처럼 구버전이 오래 남는 클라이언트가 있으면 **구 API에는
  ③ 상한을 걸고, 신 API를 병행 운영하다 폐기**하는 마이그레이션 계획이
  필요하다. rationale이 "미리 아는 것의 가치가 크다"고 한 이유가 바로
  이 비용이다 — 처음부터 커서로 설계했으면 안 냈을 값이다.

**(가산점 포인트)** "이전 페이지"는 조건과 정렬을 반대로 뒤집어 조회한
뒤 결과 리스트를 다시 뒤집어 돌려준다(`WHERE (created_at, id) > 커서
ORDER BY created_at ASC, id ASC LIMIT 20` → reverse). 양방향이 필요하면
`prevCursor`도 함께 내려준다.

### 2-2. 지연 조인(deferred join) — offset은 두고 "버릴 행의 룩업"만 없앤다

페이지 번호 UI를 당장 못 버리거나 API를 바꿀 수 없을 때의 처방이다.
발상: 어차피 버릴 100,000건에 대해 **행 전체를 조립하는 게 낭비**이니,
먼저 **인덱스만 훑어 PK 20개를 고르고**, 그 20개에 대해서만 본 테이블을
읽는다.

```sql
-- ❌ before: 세컨더리 인덱스 → 북마크 룩업 100,020회 → 100,000건 버림
SELECT * FROM posts
ORDER BY created_at DESC
LIMIT 100000, 20;

-- ✅ after: 서브쿼리는 (created_at, id) 인덱스만으로 끝난다(커버링).
--           북마크 룩업은 바깥 조인의 20회뿐.
SELECT p.*
FROM posts p
JOIN (
    SELECT id
    FROM posts
    ORDER BY created_at DESC
    LIMIT 100000, 20            -- offset 은 그대로. 하지만 인덱스 리프만 순차로 읽는다
) AS page ON page.id = p.id
ORDER BY p.created_at DESC;     -- 조인 결과의 순서는 보장되지 않으므로 바깥에서 다시 정렬
```

왜 빨라지는지도 사슬로 — 서브쿼리의 `SELECT id ... ORDER BY created_at`은
필요한 컬럼(id, created_at)이 전부 인덱스 안에 있어 **북마크 룩업 없이
인덱스 리프만 순차로 읽는다**([커버링 인덱스](09-covering-index.md)). 100,020개 엔트리를 세며
버리는 건 같지만, 엔트리는 행보다 훨씬 작아 페이지 수가 적고 순차
I/O다. 랜덤 I/O 100,020회가 **20회로** 줄어든다.

대가 — **여전히 O(offset)이다.** 인덱스 스캔이 싸다는 것이지 공짜는
아니라서, 페이지가 수만 단위로 깊어지면 다시 느려진다. 장점은 **API도
UI도 바꾸지 않고 오늘 밤 배포할 수 있다**는 것. 그래서 지연 조인은
"커서로 가는 마이그레이션 기간의 다리"로 쓰이는 경우가 많다.

### 2-3. offset 상한 — API 레벨에서 강제하는 안전망

"5,001페이지를 누가 보겠어"는 사실이지만, **사람은 안 봐도 크롤러와
관리자 화면의 '마지막 페이지' 버튼은 본다.** 상한은 업계 관행이다 —
구글 검색도 일정 페이지 이상은 결과를 넘겨주지 않고, Elasticsearch는
`from + size`가 `index.max_result_window`(기본 10,000)를 넘으면 요청 자체를
거절한다. RDB 위의 API도 같은 선을 그어야 한다.

핵심은 **어디에 두느냐**다. 컨트롤러마다 `if (page > 500) throw`를 쓰면
다음 사람이 새 목록 API를 만들 때 빠뜨린다. 사람의 기억에 의존하지 않는
위치 — 모든 목록 요청이 지나가는 한 곳 — 에 둔다.

```java
// ❌ before: 컨트롤러마다 기억해서 넣어야 하는 검사 — 새 API 가 생기면 빠진다
@GetMapping("/posts")
public Page<PostDto> list(@RequestParam int page, @RequestParam int size) {
    if (page * size > 10_000) {           // 이 API 에는 있지만 옆 API 에는 없다
        throw new IllegalArgumentException("too deep");
    }
    ...
}

// ✅ after: 인터셉터 한 장 — page/size 를 받는 모든 목록 API 앞에서 자동으로 거절
@Component
public class DeepOffsetGuardInterceptor implements HandlerInterceptor {

    static final long MAX_OFFSET = 10_000;   // 팀 합의값. 넘는 요청은 커서 API 로 보낸다
    static final int  MAX_SIZE   = 100;

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
        int page = parseOrDefault(req.getParameter("page"), 0);
        int size = parseOrDefault(req.getParameter("size"), 20);
        if (size > MAX_SIZE || (long) page * size > MAX_OFFSET) {
            // → @ControllerAdvice 에서 400 으로 변환.
            //   메시지에 "cursor 파라미터를 사용하세요" 를 담아 대체 경로를 안내한다.
            throw new DeepPaginationException(page, size, MAX_OFFSET, MAX_SIZE);
        }
        return true;
    }

    private static int parseOrDefault(String raw, int def) {
        try { return raw == null ? def : Integer.parseInt(raw); }
        catch (NumberFormatException e) { return def; }   // 파싱 실패는 바인딩 단계가 400 으로 처리
    }
}

@Configuration
public class WebConfig implements WebMvcConfigurer {
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new DeepOffsetGuardInterceptor())
                .addPathPatterns("/api/**");          // 목록 API 가 있는 경로 전체
    }
}
```

```yaml
# 페이지 크기 상한은 Spring Data 가 이미 제공한다 (기본값 2000 은 너무 크다).
# 단, 이건 size 만 막는다 — page 깊이는 위 인터셉터가 막는다.
spring:
  data:
    web:
      pageable:
        max-page-size: 100
```

HTTP를 거치지 않는 내부 호출(배치, 이벤트 핸들러)이 `PageRequest.of(5000,
20)`을 만들 수 있으므로, 서비스 계층에도 같은 선을 하나 더 긋는다.

```java
// 리포지토리로 들어가는 Pageable 은 이 팩토리만 통과하게 한다
public final class BoundedPageRequest {
    private static final long MAX_OFFSET = 10_000;

    public static Pageable of(int page, int size, Sort sort) {
        Pageable p = PageRequest.of(page, size, sort);
        if (p.getOffset() > MAX_OFFSET) {
            throw new DeepPaginationException(
                "offset %d > %d. 전수 순회는 커서 기반 리더를 사용하세요"
                    .formatted(p.getOffset(), MAX_OFFSET));
        }
        return p;
    }
}
```

이 인터셉터/팩토리는 "막는다"가 전부가 아니다. 거절 응답에 **대체 경로
(커서 API)를 안내**해서, 깊은 페이지가 필요한 호출자가 스스로 옳은 길로
가게 만든다. 상한 없이 커서 API만 추가하면 아무도 옮겨오지 않는다.

**(가산점 포인트)** DB 쪽 2차 안전망 — MySQL의 `MAX_EXECUTION_TIME` 옵티마이저
힌트나 세션 타임아웃으로 "어떤 경로로든 새어 들어온 깊은 페이지 쿼리"가
커넥션을 오래 물고 있지 못하게 하고, 슬로 쿼리 로그에서 `LIMIT` offset이
큰 패턴을 알람으로 잡는다. 애플리케이션 상한(1차) + DB 타임아웃(2차) +
관측(3차)이 한 세트다.

### 2-4. 검색 엔진/전용 저장소 위임

조건이 다음 세 가지를 동시에 요구하면 RDB 페이지네이션 기법으로는
한계가 있다 — **다중 필터 조합 + 사용자가 고르는 정렬 축 + 깊은 탐색.**
관리자 검색 그리드, 상품 검색이 전형이다. 이럴 때는 Elasticsearch 같은
검색 엔진에 색인하고 `search_after`(키셋의 검색 엔진판)로 넘긴다. 검색
엔진조차 깊은 `from + size`는 기본적으로 거절한다는 사실이 **"offset은
어디서나 비싸다"** 의 증거다.

대가 — **색인 동기화 지연**(RDB 쓰기와 검색 결과 사이의 최종 일관성),
**운영 컴포넌트 추가**(클러스터, 매핑 관리, 재색인), **이중 저장**. 목록
하나 빠르게 하려고 도입할 도구는 아니고, 검색 요구사항이 이미 그 방향을
가리킬 때 선택한다.

---

## 3. 실무 사례 — 관리자 페이지의 "마지막 페이지" 버튼과 크롤러

### 3-1. 증상에서 원인까지

월요일 오전, 주문 목록 API의 p99가 튀고 DB CPU가 치솟는다. 슬로 쿼리
로그에는 같은 쿼리가 offset만 바꿔가며 반복된다.

```sql
SELECT * FROM orders WHERE status = 'DONE' ORDER BY created_at DESC LIMIT 99980, 20;
SELECT * FROM orders WHERE status = 'DONE' ORDER BY created_at DESC LIMIT 100000, 20;
SELECT * FROM orders WHERE status = 'DONE' ORDER BY created_at DESC LIMIT 100020, 20;
```

호출자를 추적하면 둘 중 하나다. ⑴ 관리자 화면의 **"마지막 페이지 »"
버튼** — 운영팀이 가장 오래된 주문을 보려고 누른다 ⑵ 외부 **크롤러나
내부 배치**가 `page=1, 2, 3, ...`으로 전수 순회 중이다. 둘 다 사람이 목록을
읽는 속도가 아니라 **기계 속도로 깊은 페이지를 연타**한다.

`EXPLAIN`을 보면 `rows`가 10만 단위이고, `created_at` 인덱스를 탔다면
`type=index`에 북마크 룩업이, 못 탔다면 `Using filesort`가 붙어 있다. §1-3
사슬 그대로다.

### 3-2. 처방의 순서 — 즉시 / 단기 / 중기

- **즉시(오늘)**: §2-3 offset 상한 인터셉터 배포. 크롤러는 400을 받고
  멈추거나 커서 API로 옮겨온다. 장애를 먼저 끊는다.
- **단기(이번 주)**: 페이지 번호 UI를 유지해야 하는 관리자 화면은 §2-2
  지연 조인으로 쿼리만 교체. "마지막 페이지" 버튼은 **정렬을 뒤집은 1페이지**
  (`ORDER BY created_at ASC LIMIT 20` 후 reverse)로 바꾸면 offset 없이 같은
  결과를 준다 — 기획이 원한 건 "가장 오래된 20건"이지 "5,001페이지"가
  아니었다.
- **중기(다음 스프린트)**: 외부 공개 목록 API에 커서 기반 v2를 추가하고,
  v1에는 상한을 유지한 채 폐기 일정을 공지한다. 전수 순회가 필요한 내부
  배치는 커서 루프로 재작성한다.

### 3-3. 배치의 전수 순회 — 같은 함정, 다른 옷

"모든 주문을 순회하며 정산 파일을 만드는" 배치가 `PageRequest.of(page++,
1000)`으로 돌면, 뒤로 갈수록 한 페이지가 느려져 **실행 시간이 페이지 수의
제곱에 비례**해 늘어난다(매 페이지가 offset만큼 읽으므로). 처방은
동일하게 키셋이다 — 마지막 id를 들고 `WHERE id > :lastId ORDER BY id LIMIT
1000`을 반복한다.

**(가산점 포인트)** Spring Batch의 `JpaPagingItemReader`는 내부적으로
offset 페이징(`setFirstResult`)이라 같은 문제를 안고 있고,
`JdbcPagingItemReader`는 `sortKeys`를 기준으로 "마지막 키 다음부터"를
조회하는 키셋 방식이다. 리더 선택이 곧 이 문항의 적용이다.

### 3-4. 속도만이 아니다 — offset은 스크롤 중에 결과가 밀린다

사용자가 1페이지를 보는 동안 새 글이 하나 올라오면, 2페이지 요청
`LIMIT 20, 20`은 한 칸 밀린 창을 잘라 **1페이지의 마지막 글이 2페이지
첫머리에 다시 나온다.** 삭제가 일어나면 반대로 한 건이 건너뛰어진다.
커서는 "이 값 다음"을 조회하므로 삽입·삭제와 무관하게 안정적이다.
**커서 기반은 성능 최적화이면서 동시에 정합성 개선**이라는 점을 덧붙이면
답의 격이 올라간다.

---

## 4. Spring Data / Querydsl — before / after

### 4-1. before — `Page` + `PageRequest.of(5000, 20)`

```java
public interface PostRepository extends JpaRepository<Post, Long> {
    Page<Post> findByBoardId(Long boardId, Pageable pageable);
}

// 호출
Page<Post> page = postRepository.findByBoardId(
        boardId, PageRequest.of(5000, 20, Sort.by(DESC, "createdAt")));

// 나가는 SQL 2개
// select ... from post where board_id=? order by created_at desc limit 20 offset 100000
// select count(*) from post where board_id=?
```

문제 두 개가 겹쳐 있다 — offset 100000(§1-3 사슬)과 매 요청 COUNT(§1-5).

### 4-2. 흔한 오해 — "`Slice`로 바꾸면 해결"

`Slice`는 **COUNT 쿼리만 없앤다.** `Slice<Post> findByBoardId(..., PageRequest.of(5000,
20))`은 여전히 `limit 21 offset 100000`을 날린다(다음 페이지 유무를 알려고
size + 1건을 읽을 뿐). no-offset은 반환 타입이 아니라 **`WHERE` 조건**에서
온다 — `Slice`는 그 결과를 담는 그릇일 뿐이다.

### 4-3. after — 커서 조건 + `Slice`

Spring Data JPA `@Query`로 튜플 조건을 직접 쓰는 형태.

```java
public interface PostRepository extends JpaRepository<Post, Long> {

    // 첫 페이지 — 커서 없음
    @Query("""
           select p from Post p
           where p.board.id = :boardId
           order by p.createdAt desc, p.id desc
           """)
    Slice<Post> findFirstSlice(Long boardId, Pageable pageable);

    // 다음 페이지 — (createdAt, id) 커서 이후
    @Query("""
           select p from Post p
           where p.board.id = :boardId
             and (p.createdAt < :cursorCreatedAt
                  or (p.createdAt = :cursorCreatedAt and p.id < :cursorId))
           order by p.createdAt desc, p.id desc
           """)
    Slice<Post> findSliceAfter(Long boardId, LocalDateTime cursorCreatedAt, Long cursorId,
                               Pageable pageable);
}

// 호출 — page 는 항상 0. "어디서부터"는 커서가 정한다.
Slice<Post> slice = (cursor == null)
        ? postRepository.findFirstSlice(boardId, PageRequest.of(0, 20))
        : postRepository.findSliceAfter(boardId, cursor.createdAt(), cursor.id(),
                                        PageRequest.of(0, 20));
// 나가는 SQL 1개, offset 0
// select ... where board_id=? and (created_at<? or (created_at=? and id<?))
//            order by created_at desc, id desc limit 21
```

Querydsl로 쓰면 첫 페이지/다음 페이지를 한 메서드로 합칠 수 있다 —
Querydsl은 `where()`에 들어온 `null` 조건을 무시하므로 커서가 없을 때
조건이 자연스럽게 사라진다.

```java
@Repository
@RequiredArgsConstructor
public class PostQueryRepository {
    private final JPAQueryFactory queryFactory;

    public Slice<Post> findSlice(Long boardId, PostCursor cursor, int size) {
        List<Post> rows = queryFactory
                .selectFrom(post)
                .where(post.board.id.eq(boardId),
                       afterCursor(cursor))                  // 첫 페이지면 null → 무시
                .orderBy(post.createdAt.desc(), post.id.desc())
                .limit(size + 1L)                             // 다음 페이지 유무 판정용 +1
                .fetch();

        boolean hasNext = rows.size() > size;
        if (hasNext) rows.remove(size);
        return new SliceImpl<>(rows, PageRequest.of(0, size), hasNext);
    }

    // 정렬 (createdAt DESC, id DESC) 와 부등호 방향을 반드시 맞춘다
    private BooleanExpression afterCursor(PostCursor c) {
        if (c == null) return null;
        return post.createdAt.lt(c.createdAt())
                .or(post.createdAt.eq(c.createdAt()).and(post.id.lt(c.id())));
    }
}

// 커서 값 객체 — 클라이언트에는 불투명 토큰으로만 노출
public record PostCursor(LocalDateTime createdAt, Long id) {

    public String encode() {
        String raw = createdAt + "|" + id;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(UTF_8));
    }

    public static PostCursor decode(String token) {
        String[] parts = new String(Base64.getUrlDecoder().decode(token), UTF_8).split("\\|");
        return new PostCursor(LocalDateTime.parse(parts[0]), Long.parseLong(parts[1]));
    }

    public static PostCursor from(Post last) {
        return new PostCursor(last.getCreatedAt(), last.getId());
    }
}

// 응답 조립 — 마지막 행에서 다음 커서를 만든다
public PostListResponse list(Long boardId, String cursorToken, int size) {
    PostCursor cursor = cursorToken == null ? null : PostCursor.decode(cursorToken);
    Slice<Post> slice = postQueryRepository.findSlice(boardId, cursor, size);
    String next = slice.hasNext()
            ? PostCursor.from(slice.getContent().get(slice.getNumberOfElements() - 1)).encode()
            : null;
    return new PostListResponse(toDtos(slice.getContent()), next, slice.hasNext());
}
```

동적 정렬(컬럼 헤더 클릭)을 지원하려는 순간 `afterCursor`가 정렬 축마다
분기해야 하고 커서 구성 값도 바뀐다 — §2-1에서 말한 "정렬 축마다 커서
설계"의 대가가 코드에서 이렇게 드러난다. 동적 조건 조립 일반론은
[Querydsl 동적 쿼리](../03-jpa-orm/13-querydsl-dynamic-query-composition.md)에서
다룬다(§6-3에 페이지 상한 가드도 있다).

### 4-4. (가산점 포인트) Spring Data JPA 3.1의 키셋 스크롤 API

Spring Data JPA 3.1부터는 튜플 조건을 직접 쓰지 않아도 되는 `Window` /
`ScrollPosition.keyset()`이 있다.

```java
public interface PostRepository extends JpaRepository<Post, Long> {
    Window<Post> findFirst20ByBoardIdOrderByCreatedAtDescIdDesc(Long boardId, ScrollPosition position);
}

Window<Post> first = repo.findFirst20ByBoardIdOrderByCreatedAtDescIdDesc(boardId, ScrollPosition.keyset());
Window<Post> next  = repo.findFirst20ByBoardIdOrderByCreatedAtDescIdDesc(
                             boardId, first.positionAt(first.size() - 1));
// 정렬 컬럼(createdAt, id)의 값을 위치로 삼아 (createdAt, id) < (?, ?) 조건을 자동 생성한다
```

정렬에 유일 컬럼(id)이 들어 있어야 한다는 전제는 동일하다 — 프레임워크가
튜플 조건을 대신 써 줄 뿐, **정렬 키 유일성이라는 대가는 사라지지 않는다.**

---

## 5. 꼬리질문 대비 포인트

### "정렬이 PK 순이면 `LIMIT 100000, 20`도 괜찮은 거 아닌가요?"

"덜 나쁘다"이지 "괜찮다"가 아니다. 사슬로 답한다 — PK 순이면 클러스터드
리프에 행 전체가 있어 **북마크 룩업(랜덤 I/O)은 없다.** 그러나 서버 계층이
100,000건을 세며 버리는 read-and-discard는 그대로이고, 100,020건은 리프
페이지 수백~수천 장이며, 깊은 페이지의 오래된 데이터는 **버퍼 풀에 없을
확률이 높아 디스크 순차 읽기**가 된다. 랜덤 I/O 항이 사라졌을 뿐 **비용은
여전히 offset에 선형**이다. 그리고 실제 목록의 정렬은 대부분 PK가 아니다.

### "커서 기반으로 바꾸면 무엇을 잃습니까? 그럼 offset을 그대로 두는 게 맞는 경우는요?" (시니어 변별 포인트)

잃는 것을 먼저 목록으로 — ⑴ **임의 페이지 점프**(페이지 번호 UI 불가)
⑵ **total count**(전체 건수 표시 불가) ⑶ **정렬 유연성**(정렬 축마다 커서와
인덱스를 따로 설계, 정렬 키는 유일하고 불변이어야 함) ⑷ **API 호환성**(스펙
변경, 구·신 병행 운영, 클라이언트 전부 수정). 얻는 것은 깊이와 무관한
상수 비용과 스크롤 중 중복/누락 없음.

그래서 offset을 두는 게 맞는 경우가 분명히 있다 — **사용자가 실제로 앞
몇 페이지만 보는 화면 + 페이지 번호 UI가 요구사항인 경우.** 이때는 커서로
갈아엎지 않고 **offset 상한(§2-3) + 지연 조인(§2-2)** 으로 충분하다. 도구를
고르는 기준은 "커서가 더 빠르다"가 아니라 **"이 화면의 접근 패턴이 순차
탐색인가 임의 접근인가"** 다. 순차(피드, 타임라인, 무한 스크롤)면 커서,
임의(관리자 그리드, 검색 결과 페이지 번호)면 offset + 상한 + 지연 조인,
임의 접근인데 깊이까지 필요하면 검색 엔진.

### "정렬 키가 `created_at` 하나면 커서로 왜 안 됩니까? 같은 시각에 여러 건이면 어떻게 되나요?"

정렬 키가 유일하지 않으면 "그 다음"이 정의되지 않는다. 같은 초에 글 세
개가 있고 커서가 그중 첫 번째에서 끊겼다면 — `created_at < :last`는 나머지
두 개를 **건너뛰고**(누락), `created_at <= :last`는 이미 본 첫 번째를 **다시
준다**(중복). 처방은 유일 컬럼 `id`를 tie-breaker로 붙여 `(created_at, id)`를
전순서로 만들고, 조건을 `created_at < :c OR (created_at = :c AND id < :i)`로,
인덱스도 `(created_at, id)`로 두는 것. **(가산점 포인트)** InnoDB 세컨더리
인덱스는 리프에 PK를 품으므로 `(created_at)` 인덱스만 있어도 물리적으로는
이미 `(created_at, id)` 순으로 정렬돼 있다 — 그래도 복합 인덱스를 명시하는
편이 실행 계획이 예측 가능하고, 다른 DB로 옮겨도 동작이 같다.

### "지연 조인은 여전히 offset 100000인데 왜 빨라지나요? 한계는요?"

사슬로 — before는 세컨더리 인덱스 엔트리마다 **PK로 클러스터드 인덱스를
재탐색해 행 전체를 조립(북마크 룩업, 랜덤 I/O)한 뒤 버린다 × 100,000.**
after의 서브쿼리는 `SELECT id`라 필요한 값이 전부 인덱스 리프에 있어
(**커버링**) 북마크 룩업 없이 **인덱스 리프만 순차로 세며 걷고**, 살아남은
PK 20개에 대해서만 본 테이블을 읽는다. 랜덤 I/O 100,020회 → 20회. 한계는
인덱스 스캔 자체가 **여전히 O(offset)** 이라는 것 — 엔트리가 행보다 작아
페이지 수가 적을 뿐이라 offset이 수십만·수백만으로 가면 다시 느려진다.
그래서 지연 조인은 "페이지 번호 UI를 유지하면서 상한 안쪽을 빠르게" 또는
"커서로 가는 동안의 다리"로 쓴다.

### "무한 스크롤 중에 새 글이 올라오면 offset과 커서는 어떻게 다르게 동작하나요?" (가산점 포인트)

offset은 "앞에서 N번째"를 매번 다시 세므로, 1페이지를 본 뒤 새 글이 하나
들어오면 2페이지 `LIMIT 20, 20`의 창이 한 칸 밀려 **1페이지 마지막 글이
2페이지 첫머리에 다시 나온다.** 삭제가 일어나면 반대로 한 건이
**건너뛰어진다.** 커서는 "이 값 다음"을 조회하므로 삽입·삭제와 무관하게
이어진다. 즉 커서 기반은 성능만이 아니라 **사용자가 보는 결과의 정합성**
문제이기도 하다 — 피드에서 "아까 본 글이 또 나온다"는 CS의 상당수가
offset 페이지네이션이다. 단, 커서도 **정렬 키가 갱신되는 컬럼**(`updated_at`)
이면 행이 위치를 옮겨 다니므로 같은 문제가 재발한다 — 커서의 정렬 키는
불변이어야 한다는 조건이 여기서 나온다.

---

## 한 줄 요약

**`OFFSET`은 건너뛰기가 아니라 읽고 버리기다 — B+Tree에 "N번째" 좌표가
없어 서버 계층이 100,020건을 세며 버리고, 세컨더리 인덱스 정렬이면 버릴
행에도 북마크 룩업(랜덤 I/O)을 100,020번 지불해 비용이 페이지 번호에
선형이다. 해결책은 네 개를 세트로 — 커서(키셋)로 offset을 없애거나, 지연
조인으로 버릴 행의 룩업을 없애거나, API 레벨 상한으로 깊은 페이지를
거절하거나, 검색 엔진에 위임한다. 커서를 고를 때는 임의 페이지 점프·total
count·정렬 유연성·API 호환을 내주는 거래임을 같은 호흡에 말한다.**
