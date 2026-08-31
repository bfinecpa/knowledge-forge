# ORDER BY와 filesort — 정렬은 인덱스 순서를 "빌리거나", 전부 읽어 "다시 줄 세우거나" 둘 중 하나다

> 핵심 관전 포인트: **`ORDER BY`가 공짜가 되는 경우는 하나뿐이다 — 옵티마이저가
> 고른 인덱스의 **리프 순서가 곧 정렬 순서**일 때. 그 조건은 여섯 개를 세트로
> 꺼낸다: ① WHERE 등호 컬럼 + ORDER BY 컬럼이 인덱스 선두부터 **빈칸 없이
> 연속**(접) ② **범위 조건(`IN` 포함) 뒤 컬럼으로는 정렬 불가**, 범위 컬럼
> 자체로는 가능(범) ③ 방향이 **전부 같거나 전부 반대**(역방향 스캔), 혼합은
> MySQL 8 내림차순 인덱스로만(방) ④ WHERE와 ORDER BY가 **한 인덱스** 안에서(한)
> ⑤ 컬럼 **원형 그대로** — 함수·연산·`RAND()` 없음(원) ⑥ 조인이면 **드라이빙
> 테이블 컬럼만**(드). 하나라도 깨지면 `filesort` — 이름과 달리 메모리에서도
> 하지만 본질은 **"WHERE에 맞는 N건을 전부 읽어 sort buffer에 적재 →
> `sort_buffer_size`를 넘치면 임시 파일에 청크로 쓰고 다시 읽어 병합 → 그제야
> `LIMIT 20` 적용"**이라 비용이 결과 20건이 아니라 **매칭 행 수 N에 비례**한다.
> 인덱스 순서를 타면 구간 끝에서 20건 읽고 멈춘다. 그래서 인덱스를 WHERE만 보고
> 걸면 반쪽이고 **"등·범·정·커"의 정(정렬) 자리까지 채워야** 완성이며, 정렬
> 축이 여럿인 화면은 "축마다 인덱스"가 아니라 **N × 빈도 × 정렬 컬럼의
> 변동성**으로 인덱스/허용/사전집계를 갈라 결정하고, 그 결정을 `EXPLAIN` 단정
> 테스트와 `Sort_merge_passes`·`Sort_rows` 알람으로 고정한다.**

---

## 0. 질문 + 의도

**질문**: "ORDER BY가 인덱스를 타는 조건은? filesort는 언제 발생하고 왜 문제가
되나요?"

**출제 의도**: rationale의 표현 그대로 — "목록 조회의 기본형(WHERE+ORDER
BY+LIMIT)에서 **정렬이 인덱스를 못 타면 매 요청이 정렬 작업이 된다.** WHERE
조건만 보고 인덱스를 설계하는 **반쪽 습관**을 가리는 질문." 즉 이 문항은 "인덱스가
있는가"가 아니라 **"인덱스가 정렬까지 책임지는가"**를 묻는다. 목록 API는 거의
예외 없이 `WHERE … ORDER BY … LIMIT 20` 꼴이고, 여기서 정렬이 새면 **결과는 20건인데
비용은 조건에 맞는 전체 행 수**가 된다 — 데이터가 늘수록 첫 페이지부터 느려지는
가장 흔한 목록 장애의 정체다. 면접관은 ⑴ 인덱스가 정렬을 대신하는 조건을 목록으로
꺼내는지 ⑵ `filesort`의 비용을 "느리다"가 아니라 메커니즘으로 말하는지 ⑶ 정렬용
컬럼을 인덱스에 넣는 대가와, 정렬 축이 여러 개인 화면에서의 판단까지 가는지를
본다.

**이 문서가 특히 겨냥하는 네 지점** (4장 전 구간에서 반복된 패턴):

- **비용을 이름 붙은 사슬로** — "filesort라 느리다"에서 멈추지 않고, 매칭 N건
  전부 읽기 → sort buffer 적재 → 스필 → 머지 → 그 뒤에야 LIMIT — 고리를 하나씩
  잇고, 인덱스 경로의 "20건 읽고 중단"과 나란히 놓는다(§2).
- **트레이드오프를 양면으로** — 정렬 컬럼을 인덱스에 넣으면 무엇을 내주는지(폭·쓰기
  증폭), 정렬 기준이 다섯 개인 화면에서 "인덱스 5개 vs filesort 허용 vs 사전
  집계"를 어떤 기준으로 가르는지(§3).
- **안전망을 코드로 고정** — 목록 API의 `EXPLAIN` 단정 테스트(허용한 filesort는
  목록으로 선언), 슬로 로그의 `Sort_merge_passes`·`Sort_rows` 알람, 정렬
  파라미터 화이트리스트(§5).
- **목록 인출** — "인덱스를 타는 조건 6"과 "filesort가 나는 패턴 7"을 세트로,
  `Extra` 세 조합(`Using filesort` / `Using temporary; Using filesort` /
  `Using index; Using filesort`)의 해석을 즉시 꺼낼 수 있게(§1, §2-4).

**옆 문서와의 경계**: [복합 인덱스 컬럼 순서](08-composite-index-column-order.md)가
"등·범·정·커" 네 자리를 세우고 순서 오류의 5고리 사슬을 다뤘다면, 이 문서는 그중
**"정"의 자리 하나만** 깊게 판다. `LIMIT`의 offset이 커서 생기는 비용은
[깊은 페이지네이션](13-deep-pagination-offset-vs-cursor.md), `EXPLAIN`을 읽는 순서와
개선 사이클은 [실행 계획 읽기](10-explain-and-slow-query-process.md), `Using index`의
의미는 [커버링 인덱스](09-covering-index.md)에 있다. 여기서는 그것들을 전제로
**정렬 축**만 본다.

---

## 1. 원리 — 정렬을 공짜로 얻는 조건은 "리프 순서 = 정렬 순서" 하나뿐이다

### 1-1. 한 문장 원리

B+Tree 인덱스의 리프는 **키 순서로 정렬된 연결 리스트**다([B+Tree](01-index-and-bplus-tree.md)).
그러니 옵티마이저가 어떤 인덱스의 연속 구간을 읽고 있는데 **그 구간의 순서가
`ORDER BY`가 원하는 순서와 같다면**, 정렬은 이미 돼 있는 셈이라 아무 일도 안 해도
된다. 이것이 유일한 공짜 경로다. 반대로 읽는 순서와 원하는 순서가 다르면, DB는
읽은 것을 **어딘가에 모아 다시 줄 세우는** 수밖에 없다 — 그게 `filesort`다.

```text
웹툰 목록: WHERE genre = 'ROMANCE' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20

인덱스 (genre, status, updated_at)의 리프
 ┌ ACTION ────────────┐┌ ROMANCE ─────────────────────────────────────────────┐┌ THRILLER ─┐
 │ ACTIVE  │ ENDED    ││ ACTIVE ····························· │ ENDED ······ ││ ...       │
 │ 07-01.. │ 06-02..  ││ 05-01 05-03 ... 08-29 08-30 08-31 ▲   │ 04-11 ...    ││           │
 └────────────────────┘└──────────────────────────────┬─────────────────────┘└───────────┘
                                                      └ 여기서 왼쪽으로 20칸 읽고 끝
   genre = ROMANCE, status = ACTIVE 로 "칸" 하나에 점프 → 그 칸 안은 이미 updated_at 순
   → 오른쪽 끝(최신)에서 거꾸로 20 엔트리 읽고 중단. 정렬 작업 0.
```

전화번호부 비유를 이어 쓰면 — "김 씨 중 서울 거주자를 **이름순**으로 20명"은
전화번호부가 (성, 지역, 이름) 순으로 묶여 있을 때만 페이지를 펴서 그대로 읽는다.
(성, 이름, 지역) 순이면 김 씨 이름순으로 넘기며 서울인 사람만 골라야 하고,
(성, 지역, 전화번호) 순이면 서울 김 씨를 **다 뽑아 놓고 이름순으로 다시 늘어놓아야**
한다. 마지막이 filesort다.

### 1-2. ORDER BY가 인덱스를 타는 조건 6 — "접·범·방·한·원·드" (암기)

| # | 조건 | 한 줄 이유 |
|---|---|---|
| ① 접 | WHERE **등호(상수)** 컬럼들 + ORDER BY 컬럼들이 인덱스 **선두부터 빈칸 없이 연속** | 앞 컬럼 값이 하나로 고정돼야 그 안에서 뒤 컬럼 순서가 살아 있다 |
| ② 범 | **범위 조건(`>`, `BETWEEN`, `LIKE 'x%'`, 그리고 `IN`) 뒤 컬럼으로는 정렬 불가.** 범위 컬럼 **자체**로 정렬은 가능 | 범위 안의 각 값마다 뒤 컬럼이 따로 정렬돼 있어 전체는 순서가 아니다 |
| ③ 방 | 방향이 **전부 같거나 전부 반대**. 혼합(`a ASC, b DESC`)은 MySQL 8.0 **내림차순 인덱스**를 그 방향으로 정의했을 때만 | 인덱스는 통째로 앞→뒤 또는 뒤→앞(`Backward index scan`)으로만 읽는다 |
| ④ 한 | WHERE에 쓴 인덱스와 ORDER BY에 쓸 인덱스가 **같은 하나**여야 한다 | 두 인덱스를 합쳐서 정렬 순서를 만들 수 없다 |
| ⑤ 원 | 정렬 컬럼이 **원형 그대로** — 함수·연산·형변환·`RAND()`·`FIELD()` 없음 | 리프는 컬럼 값 순서지 `LOWER(값)` 순서가 아니다 (8.0 함수 기반 인덱스는 예외) |
| ⑥ 드 | 조인이면 ORDER BY 컬럼이 **전부 드라이빙(첫 번째) 테이블** 것 | 드리븐 테이블 컬럼은 조인 결과가 다 나온 뒤에야 순서를 알 수 있다 |

여섯 개 위에 전제 하나가 더 있다 — **옵티마이저가 그 인덱스를 실제로 골라야
한다.** 조건을 다 만족하는 인덱스가 있어도 비용 계산상 다른 인덱스 + filesort가
싸다고 판단하면 그쪽으로 간다(§6 마지막 꼬리질문의 함정은 그 반대 경우다).

각 조건을 웹툰 스키마 한 줄씩으로 고정한다. 인덱스는 전부
`(genre, status, updated_at)`이라고 두고 읽는다.

```sql
-- ① 접: 등호 두 개 + 정렬 컬럼이 선두부터 연속 → 인덱스 순서 그대로
WHERE genre = ? AND status = ?            ORDER BY updated_at DESC      -- ✅ 정렬 0
WHERE genre = ?                           ORDER BY updated_at DESC      -- ❌ 가운데 status 빈칸 → filesort
WHERE genre = ?                           ORDER BY status, updated_at   -- ✅ 빈칸을 ORDER BY가 채우면 연속

-- ② 범: 범위 컬럼 "자체"로 정렬은 되고, 범위 "뒤" 컬럼으로는 안 된다
WHERE genre = ? AND status = ? AND updated_at >= ?  ORDER BY updated_at DESC   -- ✅ 범위 = 정렬 컬럼
WHERE genre = ? AND status IN ('ACTIVE','HIATUS')   ORDER BY updated_at DESC   -- ❌ IN은 구간이 갈라진다 → 병합 필요 → filesort
WHERE genre = ? AND status >= 'A'                   ORDER BY updated_at DESC   -- ❌ 범위 뒤 컬럼

-- ③ 방: 전부 반전은 되고(역방향 스캔), 혼합은 내림차순 인덱스가 있어야 한다
WHERE genre = ? AND status = ?  ORDER BY updated_at DESC          -- ✅ Backward index scan
WHERE genre = ?                 ORDER BY status DESC, updated_at DESC  -- ✅ 둘 다 반전 → 역방향
WHERE genre = ?                 ORDER BY status ASC,  updated_at DESC  -- ❌ 혼합 → filesort
--   → MySQL 8.0: CREATE INDEX ... (genre, status ASC, updated_at DESC) 로 만들면 ✅

-- ④ 한: WHERE는 (genre)로, ORDER BY는 (updated_at)로 — 인덱스가 둘로 갈리면 하나만 쓴다
--   인덱스가 (genre) 와 (updated_at) 따로 있을 때:
WHERE genre = ?                 ORDER BY updated_at DESC    -- ❌ (genre) + filesort, 또는 (updated_at) 역순 풀스캔 + 필터

-- ⑤ 원: 컬럼에 손대면 순서가 깨진다
ORDER BY LOWER(title)           -- ❌   ORDER BY updated_at + 0   -- ❌   ORDER BY RAND()   -- ❌ (항상 전체 정렬)
ORDER BY FIELD(status, 'ACTIVE', 'HIATUS', 'ENDED')   -- ❌ 사용자 정의 순서는 인덱스에 없다

-- ⑥ 드: 조인 시 정렬 컬럼이 드리븐 테이블 것이면 조인 결과를 모아 정렬한다
SELECT w.*, a.name FROM webtoon w JOIN author a ON a.id = w.author_id
WHERE w.genre = ? ORDER BY w.updated_at DESC   -- ✅ 드라이빙(w) 컬럼
WHERE w.genre = ? ORDER BY a.name              -- ❌ Using temporary; Using filesort
```

**(가산점 포인트)** InnoDB 세컨더리 인덱스는 리프에 PK를 품으므로
`(genre, status, updated_at)`은 물리적으로 `(genre, status, updated_at, id)` 순이다.
그래서 커서 페이지네이션의 tie-breaker인 `ORDER BY updated_at DESC, id DESC`도
같은 인덱스로 처리될 수 있다 — 다만 옵티마이저가 이를 이용하는지는 `EXPLAIN`으로
확인하고, 확실히 하려면 인덱스에 `id`를 명시한다
([깊은 페이지네이션 §2-1](13-deep-pagination-offset-vs-cursor.md)과 같은 조언).

### 1-3. filesort가 나는 대표 패턴 7 (암기) — 조건 6의 거울상

위 조건이 하나씩 깨지는 모양을 패턴으로 외워 두면, 슬로 로그에서 `Using filesort`를
봤을 때 **쿼리를 보자마자 어느 패턴인지 지목**할 수 있다.

1. **정렬 컬럼에 인덱스가 아예 없다** — 풀스캔 또는 WHERE용 인덱스 + filesort.
2. **WHERE 인덱스와 ORDER BY 인덱스가 딴 것이다** — `(genre)`와 `(updated_at)`이
   따로. 옵티마이저는 둘 중 하나를 고르고 나머지 일을 filesort나 필터로 떠넘긴다.
   **"WHERE만 보고 만든 인덱스"의 전형**이 여기다.
3. **접두사 중간에 빈칸** — `(genre, status, updated_at)`에 `WHERE genre = ? ORDER BY
   updated_at`. 인덱스는 탔는데(`type: ref`) 정렬은 남는다.
4. **범위/IN 뒤 정렬** — `WHERE genre = ? AND updated_at >= ? ORDER BY rating`,
   `WHERE genre IN (…) ORDER BY updated_at`. 다중 선택 필터 기능이 추가될 때
   **조용히 재발**하는 패턴(§4-2).
5. **방향 혼합** — `ORDER BY updated_at DESC, title ASC`를 내림차순 인덱스 없이.
6. **함수·표현식 정렬** — `LOWER()`, 계산식, `RAND()`, `FIELD()`, 형변환.
7. **조인 드리븐 컬럼 / GROUP BY와 다른 컬럼 / DISTINCT·UNION 뒤 정렬** — 중간
   결과를 임시 테이블에 모아야 하므로 `Using temporary; Using filesort`.

### 1-4. "등·범·정·커"에서 "정"의 자리 — WHERE만 보는 반쪽 습관

[복합 인덱스 컬럼 순서](08-composite-index-column-order.md) §2의 네 자리 중 **"정"**이
이 문서의 자리다. 습관적으로 WHERE 컬럼만 보고 인덱스를 걸면 "등"까지만 채우고
멈춘 것이다.

```sql
-- 화면: 장르 탭 → 연재 중 작품을 최신 업데이트순으로 20개 (홈 트래픽의 대부분이 이 쿼리)
SELECT id, title, thumbnail_url, updated_at
FROM webtoon
WHERE genre = 'ROMANCE' AND status = 'ACTIVE'
ORDER BY updated_at DESC
LIMIT 20;

-- ❌ before: WHERE만 보고 건 인덱스 — "등"까지만 채웠다
CREATE INDEX idx_webtoon_genre_status ON webtoon (genre, status);
-- EXPLAIN
--   type: ref   key: idx_webtoon_genre_status   rows: 80000(예시)
--   Extra: Using where; Using filesort     ← 로맨스·연재중 8만 건을 전부 모아 정렬한 뒤 20건
-- EXPLAIN ANALYZE
--   -> Limit: 20 row(s)                                     (actual time=96.3..96.3 rows=20)
--       -> Sort: webtoon.updated_at DESC, limit input to 20 row(s) per chunk
--                                                            (actual time=96.3..96.3 rows=20)
--           -> Index lookup on webtoon using idx_webtoon_genre_status (genre='ROMANCE', status='ACTIVE')
--                                                            (actual time=0.07..81.9 rows=80000)
--   ※ Sort 노드가 있고, 그 아래 노드의 rows가 8만 — "정렬에 들어간 입력"이 8만 건이라는 뜻

-- ✅ after: "정"의 자리를 채운다 — 등호 두 개 뒤에 정렬 컬럼
DROP INDEX idx_webtoon_genre_status ON webtoon;                  -- 접두사가 같으니 교체(중복 방지)
CREATE INDEX idx_webtoon_genre_status_updated ON webtoon (genre, status, updated_at);
-- EXPLAIN
--   type: ref   key: idx_webtoon_genre_status_updated
--   Extra: Using where; Backward index scan  ← filesort 없음. DESC라 뒤에서 앞으로 읽는다
-- EXPLAIN ANALYZE
--   -> Limit: 20 row(s)                                     (actual time=0.05..0.09 rows=20)
--       -> Index lookup on webtoon using idx_webtoon_genre_status_updated
--            (genre='ROMANCE', status='ACTIVE') (reverse)   (actual time=0.04..0.08 rows=20)
--   ※ Sort 노드 자체가 사라졌고 rows=20 — 20건 읽고 멈췄다
```

**"정"을 "등"보다 앞에 두면 어떻게 되나 (함정)** — 정렬만 급해서
`(genre, updated_at, status)`로 만들면 `genre` 구간이 `updated_at` 순이라 정렬은
인덱스가 해결한다. 하지만 `status`는 등호인데도 범위(정렬) 컬럼 뒤에 있어 **탐색
조건에서 필터로 강등**된다 — 리프를 최신순으로 걸으며 `ACTIVE`가 아닌 엔트리를
버리면서 20건을 채운다. ACTIVE가 60%면 33건쯤 읽고 끝나 티가 안 나지만, 같은
인덱스로 `status = 'SUSPENDED'`(1%)를 조회하면 20건을 채우려고 **2,000건을 걷는다.**
비용이 필터 선택도에 따라 널뛰는 구조다. 등호 → 정렬 순서를 지키면 어느 값이든
20건이다. "등·범·정·커"의 **순서**가 중요한 이유가 정렬 축에서 이렇게 드러난다.

---

## 2. filesort는 왜 비싼가 — "느리다"가 아니라 사슬로

### 2-1. filesort의 실체 — 이름은 파일, 본질은 "서버 계층의 별도 정렬 단계"

- **누가**: 스토리지 엔진(InnoDB)이 아니라 그 위층 **SQL 서버 계층**이 한다. 엔진은
  조건에 맞는 행을 한 건씩 올려 보낼 뿐이고, 서버가 그것을 모아 정렬한다.
  `LIMIT`/`OFFSET`을 서버 계층이 세는 것과 같은 층이다.
- **이름**: 옛날엔 정렬 결과를 반드시 파일에 썼기에 붙은 이름이다. 지금은 **메모리
  안에서 끝나도 똑같이 `Using filesort`**라고 찍힌다 — 그래서 "filesort = 디스크
  정렬"로 외우면 틀리고, "**인덱스 순서를 못 빌려서 별도 정렬 단계를 붙였다**"로
  외워야 맞다.
- **어디에**: 세션마다 정렬용 메모리 `sort_buffer_size`를 잡는다. 정렬할 데이터가
  이 크기를 넘으면 그때 디스크 임시 파일로 간다.
- **무엇을 정렬하나 — 모드 둘** (가산점 포인트):
  - **rowid 모드(two-pass)**: `<정렬 키, 행 위치(PK)>`만 버퍼에 넣어 정렬하고, 상위
    N건의 PK로 **테이블을 다시 찾아** 나머지 컬럼을 채운다. 엔트리가 작아 버퍼에
    많이 들어가지만 재조회(랜덤 I/O)가 붙는다.
  - **addon fields 모드(single-pass)**: `<정렬 키, SELECT에 필요한 컬럼 전부>`를
    넣는다. 재조회는 없지만 엔트리가 넓어 **버퍼가 더 빨리 넘친다.** MySQL 8.0은
    대체로 이 모드를 쓰고, 긴 TEXT/BLOB 컬럼이 끼면 rowid 모드로 떨어진다. 그래서
    `SELECT *`로 `summary TEXT`까지 끌어오는 목록 쿼리는 **정렬 비용까지 키운다** —
    SELECT 컬럼을 줄이는 것이 정렬 최적화이기도 하다.

### 2-2. 비용 사슬 — filesort 경로 6고리 vs 인덱스 경로 3고리 (암기)

여기가 "성능 저하"·"메모리 부하"에서 멈추던 지점이다. 고리마다 이름을 붙여 끝까지
잇는다.

```text
■ filesort 경로 — 비용 ∝ N (WHERE에 맞는 행 수)
 ① 접근  : WHERE로 걸러지는 N건을 전부 읽는다
           (WHERE용 세컨더리 인덱스면 N회 북마크 룩업 = 랜덤 I/O, 풀스캔이면 순차 I/O로 테이블 전체)
 ② 적재  : 행마다 <정렬 키 + 필요 컬럼(또는 rowid)>를 만들어 sort buffer에 쌓는다
           (CPU, 세션 메모리)
 ③ 스필  : sort_buffer_size를 넘기면 버퍼를 정렬해 임시 파일에 "청크"로 쓴다
           (순차 쓰기지만 디스크. tmpdir을 모든 세션이 공유)
 ④ 머지  : 청크들을 다시 읽어 병합한다 — 디스크를 "쓰고 또 읽으니" I/O 2배
           (Sort_merge_passes가 이 횟수를 센다)
 ⑤ 자르기: 정렬이 끝난 뒤에야 LIMIT 20을 적용한다 — ①~④의 비용은 20과 무관
 ⑥ 재조회: (rowid 모드면) 살아남은 20건의 PK로 테이블을 다시 찾는다

■ 인덱스 경로 — 비용 ∝ LIMIT
 ① 점프  : (genre, status) 등호로 리프의 연속 구간 시작점(또는 끝점)을 찍는다
 ② 걷기  : 구간은 이미 updated_at 순 — 끝에서 앞으로 20 엔트리를 읽는다
           (SELECT 컬럼이 인덱스에 없으면 북마크 룩업 20회)
 ③ 중단  : 20건을 채우면 즉시 끝. 나머지 79,980건은 만지지도 않는다
```

면접에서 말하는 문장으로 압축하면 — **"filesort는 조건에 맞는 8만 건을 전부
읽어 정렬 버퍼에 넣고, 버퍼가 넘치면 디스크 임시 파일에 썼다 다시 읽어 병합한
다음에야 20건을 자릅니다. 비용이 LIMIT이 아니라 매칭 행 수에 비례하죠. 인덱스
순서를 타면 구간 끝에서 20건 읽고 멈춥니다."**

### 2-3. "왜 문제인가" — 세 겹으로, 그리고 "언제는 문제가 아닌가"

**⑴ 비례 대상이 틀렸다.** 결과는 20건인데 일은 N건이다. 그래서 ⓐ 데이터가 10배
되면 **첫 페이지부터** 10배 느려진다(깊은 페이지가 아니라 1페이지가) ⓑ 개발 DB
(N=50)에서는 절대 안 보이고 운영(N=8만)에서 터진다 ⓒ 같은 쿼리도 파라미터에 따라
N이 100배 다르다(로맨스 8만 vs 스릴러 800) — **p50은 멀쩡한데 p99가 널뛰는** 목록
API의 흔한 정체.

**⑵ 자원이 공유 자원이다.** sort buffer는 **세션마다** 잡는다 — 동시 요청 200개가
같은 쿼리를 치면 버퍼 200개다. 스필된 임시 파일은 **`tmpdir` 디스크를 모든 세션이
공유**하므로 한 쿼리의 정렬이 옆 쿼리의 임시 테이블·다른 정렬과 I/O를 다투고,
극단에서는 임시 영역이 차서 무관한 쿼리까지 실패한다. CPU도 N log N 비교만큼 쓴다.
"이 쿼리가 느리다"에서 끝나지 않고 **옆 쿼리를 느리게 만드는** 이유다.

**⑶ 응답이 "다 읽은 뒤"에 시작된다.** 인덱스 경로는 첫 행을 바로 흘려보낼 수
있지만, filesort는 마지막 행까지 읽고 정렬을 마쳐야 첫 행이 나간다. 첫 행까지의
시간 = 전체 정렬 시간이고, 그동안 **커넥션을 물고 있다** → 목록 API 하나가 커넥션
풀을 잠식하는 사슬([커넥션 수와 처리량](15-connection-count-vs-throughput.md))로
이어진다. `SELECT … FOR UPDATE`에 붙은 정렬이라면 N건의 락을 정렬이 끝날 때까지
쥐고 있는 셈이다([FOR UPDATE의 락 범위](19-select-for-update-lock-scope.md)).

**언제는 문제가 아닌가** — 위 세 겹은 전부 **N이 클 때** 성립한다. N이 수백 건이고
메모리 안에서 끝나며 호출 빈도가 낮으면 filesort는 밀리초 아래다. 즉 **문제는
filesort라는 단어가 아니라 "정렬 입력 N의 크기 × 빈도"**이고, 이 판단이 §3의
트레이드오프로 이어진다. `Using filesort`를 보자마자 인덱스를 추가하는 것도 반쪽
습관이다.

### 2-4. EXPLAIN에서 읽기 — `Extra` 세 조합과 `Sort` 노드

| `Extra` | 뜻 | 위험도·처방 방향 |
|---|---|---|
| `Using filesort` | 서버 계층 정렬 단계가 붙었다. 읽은 행을 sort buffer로 | N에 비례. 인덱스에 "정" 자리 채우기, 또는 N이 작으면 허용 |
| `Using temporary; Using filesort` | 정렬 **전에** 중간 결과를 **임시 테이블로 물질화**해야 한다 — 조인 드리븐 컬럼 정렬, GROUP BY와 다른 ORDER BY, DISTINCT | **두 단계 비용.** 임시 테이블도 메모리 한도를 넘으면 디스크(`Created_tmp_disk_tables`). 쿼리 구조를 바꿔야 한다 |
| `Using index; Using filesort` | 커버링이라 **테이블 접근은 0**(읽기는 싸다)인데 인덱스 순서가 정렬과 안 맞아 **정렬은 남았다** | 읽기 최적·정렬 미해결. 대개 "접두사 빈칸"이나 "컬럼 순서" 문제 — 순서를 바꾸면 둘 다 해결되는 신호 |
| `Backward index scan` | 인덱스를 뒤에서 앞으로 읽어 DESC를 처리했다 | **좋은 신호.** 정렬을 인덱스가 해결했다는 뜻 |
| (아무것도 없음 / `Using where`만) | 정렬이 인덱스 순서로 해결됐다 | 좋음 |

`Using index; Using filesort`의 예를 하나 고정한다.

```sql
-- 인덱스 (status, genre, updated_at). 쿼리는 genre 없이:
EXPLAIN SELECT id, updated_at FROM webtoon
WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20;
-- type: ref  key: idx_webtoon_status_genre_updated
-- Extra: Using where; Using index; Using filesort
--   읽기: 필요한 컬럼(status, updated_at, id)이 전부 인덱스에 있어 테이블엔 안 간다 → 싸다
--   정렬: status 구간 안은 genre별로 따로 updated_at 순이라 전체 순서가 아니다 → 모아서 정렬
--   해석: "ACTIVE 전체(수십만)를 인덱스 리프에서 순차로 읽어(싸다) 전부 정렬한다(비싸다)"
--   처방: 이 쿼리가 뜨겁다면 (status, updated_at) 인덱스, 아니면 허용 — N을 보고 정한다
```

`EXPLAIN ANALYZE`에서는 **`Sort:` 노드의 존재**와 **그 바로 아래 노드의 `rows`**
두 가지만 보면 된다. 아래 노드의 rows가 정렬 입력 N이다. `limit input to 20 row(s)
per chunk`는 §6 첫 꼬리질문의 우선순위 큐 최적화가 적용됐다는 표시다.
`EXPLAIN FORMAT=JSON`에서는 `ordering_operation.using_filesort` 불리언 하나로
떨어지므로 테스트 단정에 쓰기 좋다(§5-1).

**(가산점 포인트)** 옵티마이저 트레이스(`SET optimizer_trace='enabled=on'`)의
`filesort_summary`에는 정렬한 행 수, 스필된 임시 파일 수, 사용한 sort buffer 크기,
`sort_mode`(`<fixed_sort_key, rowid>` vs `<fixed_sort_key, packed_additional_fields>`)가
실측으로 남는다. "이 filesort가 메모리에서 끝났는지, 몇 번 디스크에 갔는지"를
쿼리 하나 단위로 확인하는 가장 정확한 창이다.

---

## 3. 트레이드오프 — 정렬 컬럼을 인덱스에 넣는 대가, 그리고 "정렬 5개" 판단

### 3-1. 대가부터 — 정렬 컬럼 하나가 인덱스에 들어가면

| 얻는 것 | 내주는 것 |
|---|---|
| 정렬 단계 제거, 비용이 N → LIMIT | **인덱스 폭↑** → 페이지당 엔트리↓ → 버퍼 풀 적재율↓ |
| 첫 행 즉시 반환, 커넥션 점유↓ | **쓰기 증폭** — 정렬 컬럼 값이 바뀔 때마다 엔트리가 **옛 자리에서 지워지고 새 자리에 꽂힌다**(삭제+삽입) |
| 커서 페이지네이션의 전제 확보 | 정렬 축마다 인덱스면 **인덱스 수↑** → DML당 갱신 트리 수↑, 옵티마이저 후보 혼선↑ |

두 번째 줄이 핵심이다. 세컨더리 인덱스는 값 순서로 놓이므로 **정렬 컬럼이 자주
바뀔수록 인덱스가 자주 움직인다.** 웹툰 도메인에서 후보 컬럼들의 변동성을 나란히
놓으면 판단이 저절로 갈린다.

- `created_at` — **불변.** 인덱스에 넣어도 삽입 때 한 번 꽂히고 끝.
- `updated_at` — 회차가 올라올 때마다(작품당 주 1~2회). 엔트리가 구간 끝으로 이동
  하지만 빈도가 낮아 감당 가능.
- `rating_avg` — 평점이 들어올 때마다 소수점이 바뀐다. 인기작이면 분 단위.
- `view_count` — **조회할 때마다.** 이 컬럼에 인덱스를 걸면 **모든 페이지뷰가
  인덱스 엔트리 이동**이 된다 — [초고빈도 카운터 갱신](23-high-frequency-counter-hot-row.md)의
  문제가 인덱스까지 번지는 최악의 조합.

### 3-2. 정렬 기준이 5개인 화면 — "축마다 인덱스"가 답이 아닌 이유

장르 탭에 정렬 옵션이 **최신순 / 신작순 / 인기순 / 별점순 / 제목순** 다섯 개다.
"ORDER BY가 인덱스를 타야 하니 `(genre, status, X)`를 다섯 개 만들자"는 §3-1의
대가를 다섯 배로 지불하겠다는 뜻이고, 그중 `view_count` 인덱스는 서비스를 세운다.
판단 기준은 셋을 곱한다 — **N(WHERE 후 매칭 행 수) × 요청 비중 × 정렬 컬럼의
변동성**, 여기에 커버링 필요 여부를 얹는다.

| 정렬 | 컬럼 | 요청 비중(예) | 변동성 | 판단 |
|---|---|---|---|---|
| 최신순 | `updated_at` | 70% | 낮음(회차 업로드) | **인덱스** — 기본 정렬, 트래픽 대부분 |
| 신작순 | `created_at` | 5% | 없음 | N이 크면 **인덱스**(불변이라 쓰기 대가 0에 가깝다), 작으면 허용 |
| 인기순 | `view_count` | 15% | **매 조회** | 라이브 컬럼 인덱스 **금지** → **사전 집계**(배치가 주기적으로 채우는 랭킹 테이블 또는 Redis Sorted Set) |
| 별점순 | `rating_avg` | 5% | 중간 | 집계 컬럼을 일 배치로 갱신한다면 인덱스 가능, 아니면 **filesort 허용** |
| 제목순 | `title` | 5% | 없음 | N 수만·저빈도면 **filesort 허용**(문자열 정렬 키는 콜레이션 가중치라 엔트리가 넓지만 빈도가 낮다) |

읽는 법 — ⑴ **기본 정렬은 무조건 인덱스**(요청 비중이 압도적이라 N × 빈도가 가장
크다) ⑵ **변동성 큰 컬럼은 라이브 값에 인덱스를 걸지 않고** 사전 집계 산출물에
건다 — 정렬 대상을 "실시간 카운터"에서 "10분 전 스냅숏"으로 바꾸는 것은 기획과
합의할 요구사항 변경이지만, 대부분의 랭킹은 그래도 된다 ⑶ **저빈도 + N 감당 가능
+ 불변 컬럼은 filesort를 허용하고 그 사실을 목록에 적는다** — "허용"은 방치가
아니라 **선언**이다(§5-1의 테스트가 그 목록을 읽는다) ⑷ 이 표는 한 번 정하고
끝이 아니라 `Sort_rows`·p99로 **재검토**한다(§5-2).

```sql
-- ❌ before: 정렬 옵션 수만큼 인덱스 — view_count 인덱스가 페이지뷰마다 움직인다
CREATE INDEX idx_w_gs_updated ON webtoon (genre, status, updated_at);
CREATE INDEX idx_w_gs_created ON webtoon (genre, status, created_at);
CREATE INDEX idx_w_gs_views   ON webtoon (genre, status, view_count);   -- 매 조회 = 엔트리 이동
CREATE INDEX idx_w_gs_rating  ON webtoon (genre, status, rating_avg);
CREATE INDEX idx_w_gs_title   ON webtoon (genre, status, title);

-- ✅ after: 기본 정렬 + 불변 컬럼만 인덱스, 라이브 카운터는 스냅숏 테이블로, 나머지는 허용
CREATE INDEX idx_w_gs_updated ON webtoon (genre, status, updated_at);
CREATE INDEX idx_w_gs_created ON webtoon (genre, status, created_at);
-- 인기순: 배치가 10분마다 채우는 랭킹 스냅숏 (읽기 전용이라 인덱스가 움직이지 않는다)
CREATE TABLE webtoon_rank_snapshot (
    genre       VARCHAR(20) NOT NULL,
    rank_no     INT         NOT NULL,
    webtoon_id  BIGINT      NOT NULL,
    PRIMARY KEY (genre, rank_no)                -- WHERE genre = ? ORDER BY rank_no LIMIT 20 → PK 순서 그대로
);
-- 별점순·제목순: filesort 허용. N(장르×ACTIVE)이 수만 이하이고 요청 비중 합 10% 미만 — §5-1 목록에 등록
```

**(가산점 포인트)** 정렬 축이 다섯 개를 넘고 필터 조합까지 자유로운 화면(관리자
그리드, 통합 검색)이라면 RDB 인덱스로 덮으려는 시도 자체를 멈추고 검색 엔진에
위임한다 — [깊은 페이지네이션 §2-4](13-deep-pagination-offset-vs-cursor.md)와 같은
결론이다. "정렬 축 수 × 필터 조합 수"만큼 인덱스를 만들 수는 없다.

---

## 4. 실무 사례 — 장르 목록 첫 페이지가 느리다, 그리고 "다중 장르 필터" 배포 후 조용한 회귀

### 4-1. 증상 → EXPLAIN → 사슬 → 처방

홈 진입 트래픽이 몰리는 저녁 시간대에 `GET /webtoons?genre=ROMANCE` p99가 튄다.
깊은 페이지가 아니다 — **1페이지**다. 슬로 로그(`log_slow_extra` 켜짐)에 같은 쿼리가
반복되고, 한 줄에 `Rows_examined: 80213 Rows_sent: 20 Sort_rows: 80213
Sort_merge_passes: 3`이 찍혀 있다. `Sort_merge_passes`가 0이 아니다 — **sort buffer를
넘겨 디스크 임시 파일로 갔다**는 뜻이다.

`EXPLAIN`: `type: ref, key: idx_webtoon_genre_status, Extra: Using where; Using
filesort`. 사슬로 번역하면 — `(genre, status)` 인덱스로 로맨스·연재중 8만 건의 PK를
모아 → 8만 번 북마크 룩업(`SELECT *`라 addon 모드로 넓은 행을 통째로) → 8만 건을
sort buffer에 적재 → 넘쳐서 청크 파일 쓰기 → 3회 병합 → 그제야 `LIMIT 20`. **비용의
전부가 "버릴 79,980건을 읽고 정렬하는 데"** 쓰였고, 동시 요청 수만큼 버퍼와
`tmpdir` I/O가 겹치면서 p99가 뛰었다. 참고로 이 쿼리는 로맨스에서만 느리다 —
스릴러(N=800)는 같은 계획으로도 밀리초라 slow log에 안 잡힌다.

처방 가설: `(genre, status, updated_at)`으로 교체하면 Sort 노드가 사라지고 정렬 입력
8만 → 읽는 행 20. 검증: 스테이징 `EXPLAIN ANALYZE` 96ms → 0.1ms, `Sort_rows` 0.
대가: 인덱스 폭에 `updated_at`만큼 추가, 회차 업로드 때마다 엔트리 이동 1회(작품당
주 1~2회라 무시 가능), 기존 `(genre, status)`는 접두사가 같으니 삭제해 인덱스 수
유지. 고정: §5의 세 가지.

### 4-2. 회귀 — "장르 여러 개 선택" 기능이 `IN`을 가져왔다

한 달 뒤 기획이 "장르 다중 선택"을 넣었다. 리포지토리의 `genre = ?`가 `genre IN
(?, ?)`으로 바뀌었고, 리뷰는 통과했다 — 인덱스는 그대로니까.

```sql
-- 배포 후 쿼리
SELECT id, title, thumbnail_url, updated_at
FROM webtoon
WHERE genre IN ('ROMANCE', 'DRAMA') AND status = 'ACTIVE'
ORDER BY updated_at DESC
LIMIT 20;
-- EXPLAIN
--   type: range   key: idx_webtoon_genre_status_updated
--   Extra: Using where; Using filesort          ← 돌아왔다
--   이유: IN은 구간이 값 수만큼 갈라진다(§1-2 ②). ROMANCE·ACTIVE 칸도 updated_at 순,
--         DRAMA·ACTIVE 칸도 updated_at 순 — 하지만 "두 칸을 합친 순서"는 없다.
--         옵티마이저는 두 구간의 행(8만 + 5만)을 전부 모아 다시 정렬한다.
```

"인덱스가 있는데 filesort"의 전형이고, §5-1의 단정 테스트가 있었다면 CI에서
빨간불이 켜졌을 회귀다. 처방은 셋 중 하나를 **N과 빈도로** 고른다.

```sql
-- ✅ 처방 A: 구간마다 인덱스로 20건씩 뽑고, 그 합(장르 수 × 20)만 정렬한다
SELECT * FROM (
    (SELECT id, title, thumbnail_url, updated_at FROM webtoon
      WHERE genre = 'ROMANCE' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20)
    UNION ALL
    (SELECT id, title, thumbnail_url, updated_at FROM webtoon
      WHERE genre = 'DRAMA'   AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20)
) AS candidates
ORDER BY updated_at DESC
LIMIT 20;
-- 안쪽 두 SELECT: 각각 Backward index scan으로 20건 — 정렬 0
-- 바깥 정렬: 입력 40건 — 메모리에서 마이크로초. "filesort가 남았지만 N이 40"이라 문제가 아니다(§2-3)
-- 대가: 선택 장르 수만큼 서브쿼리가 늘어난다 → 선택 개수 상한(예: 5개)을 API에서 강제

-- ✅ 처방 B: 선택 장르가 많거나(10개+) 이 화면 빈도가 낮다면 filesort를 허용하고 목록에 등록
--    — 단, 커서 페이지네이션(다음 페이지)은 정렬 키 순서를 인덱스가 보장할 때만 안전하므로
--      이 화면은 offset 상한 + 지연 조인으로 간다
-- ✅ 처방 C: 이런 조합 필터가 계속 늘어날 화면이면 검색 엔진(§3-2 가산점)
```

이 사례의 교훈은 두 줄이다 — **⑴ ORDER BY의 인덱스 사용은 WHERE의 모양이 조금만
바뀌어도 깨진다**(`=` → `IN`, 컬럼 하나 추가, 방향 하나 변경) ⑵ 그래서 "지금 안
타는가"보다 **"깨졌을 때 누가 알아채는가"**가 설계의 일부다.

---

## 5. 안전망 — 정렬 결정을 사람의 기억이 아니라 테스트·지표·타입에 박는다

### 5-1. `EXPLAIN` 단정 테스트 — 허용한 filesort는 "목록으로 선언"하고, 목록 밖은 실패

[실행 계획 읽기 §4-4](10-explain-and-slow-query-process.md)의 EXPLAIN 단정 테스트를
정렬 축에 맞게 한 단계 구체화한다. 핵심은 §3-2의 판단 결과(어느 정렬은 인덱스,
어느 정렬은 허용)를 **코드 한 곳에 두고, 런타임 화이트리스트와 테스트가 같은
곳을 읽게** 하는 것이다.

```java
// 정렬 축의 단일 출처 — API 화이트리스트(§5-3)와 실행 계획 테스트가 같은 enum을 본다
public enum WebtoonSort {
    LATEST ("updated_at", true),    // 인덱스 (genre, status, updated_at)
    NEWEST ("created_at", true),    // 인덱스 (genre, status, created_at)
    RATING ("rating_avg", false),   // filesort 허용 — §3-2 판단: 저빈도, N 수만 이하
    TITLE  ("title",      false);   // filesort 허용 — 동일

    final String column;
    final boolean indexed;          // true면 실행 계획에 filesort가 있어선 안 된다

    WebtoonSort(String column, boolean indexed) { this.column = column; this.indexed = indexed; }
}
```

```java
@SpringBootTest
class WebtoonListPlanTest {

    @Autowired JdbcTemplate jdbcTemplate;
    @Autowired ObjectMapper objectMapper;

    @BeforeAll
    static void seed(@Autowired JdbcTemplate jdbc) {
        seedWebtoons(jdbc, 300_000);            // 운영 규모. 작은 테이블에선 옵티마이저가 다른 계획을 고른다
        jdbc.execute("ANALYZE TABLE webtoon");
    }

    @ParameterizedTest
    @EnumSource(WebtoonSort.class)
    void 장르목록_정렬축별_실행계획은_선언과_일치한다(WebtoonSort sort) throws Exception {
        String plan = jdbcTemplate.queryForObject(
            "EXPLAIN FORMAT=JSON SELECT id, title, thumbnail_url FROM webtoon "
          + "WHERE genre = 'ROMANCE' AND status = 'ACTIVE' "
          + "ORDER BY " + sort.column + " DESC LIMIT 20",
            String.class);

        JsonNode queryBlock = objectMapper.readTree(plan).at("/query_block");
        // 정렬이 인덱스로 해결되면 ordering_operation.using_filesort = false,
        // 정렬 자체가 필요 없으면 노드가 없다 → 둘 다 "filesort 없음"으로 읽는다
        boolean usingFilesort = queryBlock.path("ordering_operation")
                                          .path("using_filesort").asBoolean(false);

        if (sort.indexed) {
            assertThat(usingFilesort)
                .as("%s 정렬은 인덱스로 처리돼야 한다 — 인덱스 삭제/순서 변경/IN 도입을 의심", sort)
                .isFalse();
        } else {
            // 허용한 filesort는 "정렬 입력 N"에 상한을 건다 — N이 자라면 결정을 재검토하라는 신호
            long sortInputRows = queryBlock.at("/ordering_operation/table/rows_examined_per_scan").asLong();
            assertThat(sortInputRows)
                .as("%s 은 filesort 허용이지만 정렬 입력이 %d건 — §3-2 판단을 다시 하라", sort, sortInputRows)
                .isLessThan(50_000);
        }
    }
}
```

이 테스트가 잡는 것 — ⑴ 누군가 "안 쓰는 것 같아서" 인덱스를 지웠을 때 ⑵ 컬럼
순서를 바꿨을 때 ⑶ §4-2처럼 리포지토리가 `=`를 `IN`으로 바꿨을 때 ⑷ 허용한
filesort의 N이 자라 "허용"의 전제가 무너졌을 때. 넷 다 리뷰어의 눈이 아니라
CI가 잡는다. 대가는 [복합 인덱스 §5](08-composite-index-column-order.md)의 주의와
같다 — 운영 규모 시드가 필요해 무거우니 **목록 API의 뜨거운 쿼리 몇 개**에만 건다.

### 5-2. 슬로 로그 + 정렬 지표 알람 — `Sort_merge_passes`는 0이어야 정상이다

```ini
# ✅ my.cnf / RDS 파라미터 그룹 (IaC로 관리)
[mysqld]
slow_query_log  = ON
long_query_time = 0.5
log_slow_extra  = ON     # MySQL 8.0: 슬로 로그 한 줄에 Sort_rows, Sort_merge_passes,
                         # Created_tmp_disk_tables 등이 함께 남는다 — "왜 느렸는지"가 로그에 있다
```

지표는 두 층으로 본다.

**전역 상태 변수 — 대시보드 + 알람.** `SHOW GLOBAL STATUS LIKE 'Sort%'`의
`Sort_merge_passes`(디스크 병합 횟수), `Sort_rows`(정렬한 행 수), `Sort_scan`·
`Sort_range`(정렬 횟수). mysqld_exporter라면 `mysql_global_status_sort_merge_passes`
같은 이름으로 나온다. **`Sort_merge_passes`의 증가율은 정상 상태에서 0에 가깝다** —
지속적으로 오르면 어떤 쿼리가 sort buffer를 넘겨 디스크 정렬을 하고 있다는 뜻이고,
`Sort_rows / (Sort_scan + Sort_range)`(정렬 1회당 평균 행 수)가 LIMIT 대비 수백
배면 §2 사슬이 어딘가에서 돌고 있다.

**쿼리 단위 — 주간 리포트.** 어느 쿼리인지는 digest 뷰가 알려준다.

```sql
SELECT DIGEST_TEXT,
       COUNT_STAR                       AS calls,
       SUM_SORT_ROWS / COUNT_STAR       AS avg_sort_rows,     -- 요청당 정렬 입력 N. LIMIT 20인데 8만이면 §2 사슬
       SUM_SORT_MERGE_PASSES            AS merge_passes,      -- 0이 아니면 디스크 스필이 있었다
       SUM_ROWS_SENT / COUNT_STAR       AS avg_rows_sent
FROM performance_schema.events_statements_summary_by_digest
WHERE SUM_SORT_ROWS > 0
ORDER BY SUM_SORT_ROWS DESC
LIMIT 10;
-- 상위에 오른 쿼리 = "정렬 비용이 가장 많이 새는 쿼리". §3-2 표의 재검토 입력이 된다
```

**`sort_buffer_size`를 전역으로 키우는 것은 처방이 아니다** — 세션마다 잡는
메모리라 동시 정렬 수만큼 곱해지고, 무엇보다 N을 줄이지 않는다. 대량 정렬이
정당한 배치 세션에서만 `SET SESSION sort_buffer_size = …`로 올린다(§6 네 번째
꼬리질문).

### 5-3. 정렬 파라미터 화이트리스트 — 클라이언트가 보낸 컬럼명이 `ORDER BY`에 그대로 들어가지 않게

```java
// ❌ before: ?sort=view_count,desc 가 Pageable을 거쳐 그대로 ORDER BY로 —
//    인덱스 없는 컬럼이면 매 요청 filesort, 없는 컬럼이면 500, 민감 컬럼이면 정보 노출
@GetMapping("/webtoons")
public Slice<WebtoonCard> list(@RequestParam String genre, Pageable pageable) {
    return repository.findByGenreAndStatus(genre, ACTIVE, pageable);
}

// ✅ after: 정렬 축은 enum으로 닫는다 — 목록 밖 값은 400. 어느 축이 인덱스인지 코드가 안다(§5-1의 enum)
@GetMapping("/webtoons")
public Slice<WebtoonCard> list(@RequestParam String genre,
                               @RequestParam(defaultValue = "LATEST") WebtoonSort sort,
                               @RequestParam(defaultValue = "0") int page) {
    Pageable pageable = BoundedPageRequest.of(page, 20, Sort.by(DESC, sort.property()));
    return repository.findByGenreAndStatus(genre, ACTIVE, pageable);
}
```

`Pageable`의 `Sort`를 그대로 받는 API는 **정렬 축을 클라이언트가 정하는 API**이고,
그 순간 §3-2의 판단이 무의미해진다. 열거형 하나로 닫으면 새 정렬 축을 추가하는
사람이 `indexed` 값을 채워야 하므로 **"이 정렬은 인덱스인가 filesort 허용인가"를
결정하지 않고는 기능을 추가할 수 없는** 구조가 된다 — 이것이 안전망의 목적이다.

---

## 6. 꼬리질문 대비 포인트

### "`LIMIT 20`인데 왜 8만 건을 다 정렬하나요? 상위 20건만 추리면 안 됩니까?"

MySQL은 실제로 그렇게 한다 — **우선순위 큐(힙) 최적화**. `LIMIT`이 있고 상위 N건이
sort buffer에 들어가면 전체를 정렬하는 대신 크기 20짜리 힙을 유지하며 행마다 "현재
20위 안에 드는가"만 비교한다. `EXPLAIN ANALYZE`의 `limit input to 20 row(s) per chunk`가
그 표시다. 이것으로 **메모리와 디스크 스필은 사라진다.** 그러나 사슬의 ①은 그대로다 —
**8만 건을 전부 읽어(북마크 룩업 포함) 힙과 비교**해야 20위를 확정할 수 있다. 즉
정렬 비용은 N log 20으로 줄지만 **읽기 비용은 여전히 N에 비례**하고, 실제 목록
쿼리에서 비싼 쪽은 대개 읽기다. 인덱스 경로는 읽기 자체가 20이다. "LIMIT이 있으니
괜찮다"는 스필만 피한 것이지 사슬을 끊은 게 아니다.

### "정렬 옵션이 다섯 개인 화면입니다. 인덱스를 다섯 개 만들겠습니까?" (시니어 변별 포인트)

아니다 — 기준을 먼저 세운다. **N(WHERE 후 매칭 행 수) × 요청 비중 × 정렬 컬럼의
변동성.** ⑴ 요청 대부분을 받는 기본 정렬(`updated_at`)은 인덱스 ⑵ 불변 컬럼
(`created_at`)은 쓰기 대가가 거의 없으니 N이 크면 인덱스 ⑶ 조회마다 바뀌는
컬럼(`view_count`)은 **라이브 값에 절대 인덱스를 걸지 않는다** — 페이지뷰마다
인덱스 엔트리가 이동한다. 배치가 채우는 랭킹 스냅숏 테이블이나 Redis Sorted Set에서
읽고, "10분 지연"을 기획과 합의한다 ⑷ 저빈도·N 감당 가능한 축(`title`,
`rating_avg`)은 **filesort를 허용하고 그 결정을 enum과 테스트에 선언**한다.
양면을 붙이면 — 인덱스 다섯은 정렬 비용을 없애는 대신 DML마다 트리 다섯을 갱신하고
버퍼 풀을 다섯 배 나눠 쓰며, 허용은 쓰기 대가가 0인 대신 N이 자라면 p99가 되돌아
오므로 `Sort_rows`로 감시한다. 축이 그 이상 늘고 필터 조합까지 자유로우면 RDB
인덱스가 아니라 검색 엔진의 일이다.

### "`Using filesort`와 `Using temporary; Using filesort`는 어떻게 다르고, 어느 쪽이 더 위험한가요?"

`Using filesort`는 **읽은 행을 sort buffer로 보내 정렬하는 한 단계**다.
`Using temporary; Using filesort`는 정렬 **전에 중간 결과를 임시 테이블로 한 번
물질화**해야 한다는 뜻 — 조인에서 드리븐 테이블 컬럼으로 정렬할 때(조인이 끝나야
순서를 알 수 있다), `GROUP BY` 컬럼과 다른 컬럼으로 `ORDER BY` 할 때(그룹핑 결과를
만든 뒤 정렬), `DISTINCT`·`UNION` 뒤 정렬할 때 나온다. **두 단계 비용**이고, 임시
테이블도 메모리 한도를 넘으면 디스크로 가서(`Created_tmp_disk_tables`) 스필이 두
군데서 일어날 수 있으니 후자가 더 위험하다. 처방도 다르다 — 전자는 인덱스에 "정"
자리를 채우는 문제지만, 후자는 **쿼리 구조**의 문제다: 정렬 컬럼을 드라이빙
테이블 쪽으로 옮기거나(조인 순서 조정), 그룹핑을 서브쿼리로 먼저 끝내고 바깥에서
정렬하거나, 집계 결과를 사전 계산 테이블로 뺀다.

### "`sort_buffer_size`를 키우면 해결되는 것 아닌가요?"

**증상 하나(스필)만 가리고 원인(N)은 그대로 둔다.** 사슬에서 키운 버퍼가 없애는
것은 ③ 스필과 ④ 머지뿐이고, ① N건 읽기와 ② 적재, ⑤ "정렬 뒤에야 LIMIT"은 그대로다.
게다가 이 버퍼는 **세션마다** 잡히므로 전역으로 키우면 동시 정렬 수 × 크기의
메모리가 예약된다 — 목록 API가 동시에 200개 돌면 200배다. 그래서 원칙은 ⑴ N을
줄이는 것(인덱스의 "정" 자리, 또는 §4-2의 구간별 LIMIT) ⑵ 대량 정렬이 정당한
배치·리포트 세션에만 `SET SESSION sort_buffer_size`로 올리는 것 ⑶ 전역값은
`Sort_merge_passes` 증가율을 보고 보수적으로. 한 호흡에 말하면 — "버퍼를 키우면
디스크 스필은 줄지만 읽기 비용과 세션 메모리 예약이라는 대가는 그대로라, 정렬
입력 N을 줄이는 게 먼저다."

### "정렬 컬럼에 인덱스를 걸었더니 특정 장르에서 오히려 느려졌습니다. 왜죠?" (가산점 포인트)

**WHERE만 보는 반쪽의 거울상 — ORDER BY만 보는 반쪽**이다. `(genre)`와
`(updated_at)`이 따로 있으면 옵티마이저는 `ORDER BY updated_at DESC LIMIT 20`을 보고
"`(updated_at)`을 역방향으로 걸으며 `genre = ?`를 필터하다가 20건 차면 멈추자"를
고를 수 있다 — filesort는 사라지고, 로맨스처럼 흔한 장르는 수십 건만 걸어도 20건이
차서 빠르다. 그러나 **희귀 장르(전체의 0.1%)**면 20건을 채우려고 인덱스의 거의
전부를 걷는다. 비용이 필터 선택도에 따라 1,000배 널뛰고, 옵티마이저는 통계로 이걸
정확히 예측하지 못한다. 처방은 **WHERE 등호와 ORDER BY를 한 인덱스로 묶는 것**
(`(genre, status, updated_at)`) — 그러면 어느 장르든 구간 끝에서 20건이다. 임시로는
MySQL 8.0 `optimizer_switch`의 `prefer_ordering_index=off`로 이 선택을 억제할 수
있지만, 그건 증상 억제이고 인덱스 설계가 답이다. 교훈은 하나 — **정렬 인덱스는
WHERE의 등호 컬럼 뒤에 붙어야 정렬 인덱스**이지, 정렬 컬럼 단독 인덱스는 또 다른
반쪽이다.

---

## 한 줄 요약

**`ORDER BY`가 공짜인 경우는 옵티마이저가 고른 인덱스의 리프 순서가 곧 정렬
순서일 때뿐이다 — 조건은 "접·범·방·한·원·드": 등호 컬럼 + 정렬 컬럼이 선두부터
연속, 범위(`IN` 포함) 뒤 컬럼으로는 정렬 불가, 방향은 전부 같거나 전부 반대, 한
인덱스 안에서, 컬럼 원형 그대로, 조인은 드라이빙 테이블 컬럼만. 하나라도 깨지면
filesort — 매칭 N건을 전부 읽어 sort buffer에 적재하고, 넘치면 임시 파일에 썼다
다시 읽어 병합한 뒤에야 LIMIT을 적용하므로 비용이 결과가 아니라 N에 비례하고,
인덱스 순서를 타면 20건 읽고 멈춘다. 그래서 인덱스는 "등·범·정·커"의 정 자리까지
채워야 완성이고, 정렬 축이 여럿이면 N × 빈도 × 컬럼 변동성으로 인덱스/허용/사전
집계를 가른 뒤 그 결정을 `EXPLAIN` 단정 테스트·`Sort_merge_passes` 알람·정렬 축
enum에 박아 둔다.**
