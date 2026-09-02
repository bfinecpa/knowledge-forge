# 커버링 인덱스 — 힙 페치를 0으로 만드는 대신 인덱스 폭·쓰기·취약성을 치르고, 그 0은 visibility map이 지킨다

> 핵심 관전 포인트: **PostgreSQL의 인덱스 조회는 언제나 2단계다 — ① 인덱스를 훑어 "조건에 맞는 행들의 힙 주소(TID)" 목록을 얻고 ② 그 TID를 들고 테이블 본체(힙)의 페이지를 행마다 한 장씩 읽는다. 이 ②를 힙 페치라 부르고, 커버링 인덱스란 쿼리가 필요로 하는 모든 컬럼(SELECT 목록 · WHERE · ORDER BY · 조인 키)이 인덱스 안에 들어 있어서 ②가 통째로 사라진 상태다 — 계획에는 `Index Only Scan`으로 찍힌다. 빠른 이유는 "테이블에 안 가서"가 아니라, 힙 페치가 행 1건마다 힙에 흩어진 8KB 페이지를 한 장씩 찌르는 랜덤 I/O인데 커버링은 그것을 좁은 리프 페이지 몇 장을 이어 읽는 것으로 바꾸기 때문이다. 단 PostgreSQL에는 조건이 하나 더 있다 — 인덱스는 그 행이 지금 내게 보이는 버전인지를 모르므로, visibility map에 "전부 가시"로 표시된 페이지만 힙 방문을 생략한다. `Heap Fetches: N`이 크면 커버링인데 안 빠른 상태이고, 그 N을 0으로 되돌리는 것은 VACUUM이다. 효과가 큰 조건은 "대상 행이 많고 · 필요한 컬럼이 좁고 · 자주 불리는" 쿼리(목록·랭킹·`count(*)`·페이징)이고, 대가는 인덱스 폭 증가(캐시 적재율 저하) · 실은 컬럼이 UPDATE될 때 HOT 탈락으로 모든 인덱스에 번지는 쓰기 증폭 · SELECT에 컬럼 하나만 추가해도 조용히 깨지는 취약성이다.**

---

## 0. 질문 + 의도

**질문**: "커버링 인덱스란? 어떤 상황에서 효과가 큰가요?"

**출제 의도**: 랭킹·목록 조회 같은 고빈도 쿼리를 힙 접근 없이 처리하는 핵심 기법. 아는 사람은 같은 하드웨어에서 몇 배의 처리량을 뽑는다. 즉 "인덱스만 읽고 끝난다"는 정의의 암기가 아니라, **왜 몇 배인지를 I/O 비용 모델(랜덤 vs 순차, 페이지 수)로 설명**할 수 있는지, 그리고 그 몇 배를 위해 **무엇을 지불하는지**(인덱스 폭·쓰기·취약성)를 함께 말해 "언제 쓰고 언제 쓰지 않는지"를 스스로 판단하는지를 본다. PostgreSQL에서는 한 겹 더 — **"커버링을 만들었는데 왜 안 빠르죠?"**에 visibility map과 VACUUM으로 답할 수 있는가.

> 이 문서는 [인덱스와 B-tree](01-index-and-bplus-tree.md) §4(리프에 무엇이 드는가), [힙 테이블과 인덱스 구조](03-clustered-vs-secondary-index.md) §1(인덱스 → TID → 힙 페치의 구조), [인덱스가 있는데 풀스캔](02-index-not-used-full-scan.md) §4(랜덤 vs 순차 I/O 손익분기)를 전제로 한 단계 더 들어간다. 세 문서의 공통 축 — **"PostgreSQL의 인덱스 조회는 2단계이고, 2단계(힙 페치)는 랜덤 I/O다"** — 가 흔들리면 이 문서도 같이 흔들리니 먼저 그 한 줄을 고정하고 읽는다. 아래 1-1이 그 한 줄을 이 문서 안에서 다시 세우므로, 세 문서를 아직 안 읽었어도 여기부터 읽으면 된다.

---

## 1. 개념 — "인덱스만 읽고 끝난다"가 어느 단계를 없애는가

### 1-1. 전제 — 인덱스 조회는 2단계이고, 커버링은 2단계를 없앤다

이 문서의 제목이 던지는 질문("어느 단계를 없애는가")에 답하려면 **없앨 그 단계**를 먼저 알아야 한다. 용어 셋을 여기서 정의하고 시작한다.

- **힙(heap)**: PostgreSQL의 테이블 본체. "쌓아 둔 더미"라는 이름 그대로, 행이 **정렬 없이** 8KB 페이지에 들어온 순서대로 쌓인다. 정렬이 없다는 것이 이 문서 내내 비용의 원인이 된다.
- **TID(tuple identifier)**: 힙 안에서 행 하나의 주소. **(블록 번호 4바이트, 페이지 안 슬롯 번호 2바이트) = 6바이트**다. 시스템 컬럼 `ctid`로 눈으로 볼 수 있다(`SELECT ctid, id FROM orders LIMIT 3;` → `(0,1)`, `(1042,7)` 같은 값).
- **힙 페치(heap fetch)**: 인덱스에서 얻은 TID를 들고 **그 블록의 힙 페이지를 실제로 읽어 오는 일.** 없애려는 단계가 바로 이것이다.

이제 "인덱스로 조회한다"가 실제로 무엇을 하는지 그림으로 본다.

```text
SELECT id, created_at, amount FROM orders WHERE user_id = 7

┌─ 1단계: 인덱스 훑기 ─────────────────────────────────────────────────────────┐
│  인덱스 idx_orders_user_created (user_id, created_at)                        │
│                                                                              │
│        [루트 페이지]                                                         │
│             │      user_id = 7의 시작점을 찾아 따라 내려간다 (2~3 페이지)    │
│        [내부 페이지]                                                         │
│             │                                                                │
│        [리프 페이지] │(7,08-01,TID=(8231,4))│(7,08-02,TID=(4,17))│(7,08-03,TID=(99120,2))│…│
│             └─ 리프끼리 형제 링크로 이어져 있어 옆으로 계속 이어 읽으면 된다 │
│                                                                              │
│  이 단계가 내놓는 것: "인덱스에 실린 컬럼 값들 + 각 행의 TID" 목록           │
│  비용: 리프 페이지 몇 장을 이어 읽는 순차 읽기. 싸다.                        │
└──────────────────────────────────────────────────────────────────────────────┘
                              │
                              │  amount는 인덱스에 없다 → 값을 가지러 힙으로 내려간다
                              ▼
┌─ 2단계: 힙 페치 ─────────────────────────────────────────────────────────────┐
│  힙(테이블 본체) — 행이 정렬 없이 쌓여 있다                                  │
│                                                                              │
│    …[블록 4]……[블록 577]………[블록 8231]…………[블록 99120]…                     │
│        ▲           ▲              ▲                ▲                         │
│        └───────────┴──────────────┴────────────────┘                         │
│    1단계에서 나란히 이웃이던 네 행이 힙에서는 서로 아주 멀다                 │
│    (힙은 삽입·갱신 순서로 쌓일 뿐 정렬이 없고, UPDATE마다 새 버전이 다른 자리에 생긴다)│
│                                                                              │
│  비용: 행 1건마다 8KB 페이지 1장을 따로 요청 = 랜덤 I/O 1회 × 대상 행 수     │
└──────────────────────────────────────────────────────────────────────────────┘

커버링 인덱스 = 필요한 컬럼이 전부 1단계 안에서 나와서 2단계가 통째로 없는 상태.
                계획에는 Index Scan이 아니라 Index Only Scan으로 찍힌다.
                단 PostgreSQL에는 조건이 하나 더 붙는다 — 2-3의 visibility map.
```

한 문장으로 — **커버링 인덱스는 2단계를 없앤다.** 이것이 이 문서의 전부이고, 나머지는 "그게 왜 그렇게 큰 차이인가"(1-3)와 "PostgreSQL에서는 왜 그것만으로 부족한가"(2-3)의 확장이다.

### 1-2. 정의 — 세 군데의 컬럼이 전부 인덱스 안에 있어야 한다

쿼리가 쓰는 컬럼이 **리프 엔트리 안에서 전부 해결되면** DB는 TID를 들고 힙으로 내려갈 이유가 없다. 이 상태의 인덱스를 그 쿼리에 대한 **커버링 인덱스**라 부른다. "덮는다(cover)"는 이름은 **인덱스가 그 쿼리의 요구를 남김없이 덮는다**는 뜻이다.

그래서 커버링은 **인덱스의 종류가 아니라 인덱스와 쿼리의 관계**다 — 같은 인덱스가 어떤 쿼리에는 커버링이고 다른 쿼리에는 아니다. 이 한 줄이 뒤에 나올 "취약성"(3-4)의 뿌리이므로 지금 새겨 둔다.

체크할 곳은 세 군데다.

- **SELECT 목록**의 컬럼
- **WHERE**(조인이면 ON 조건까지)의 컬럼
- **ORDER BY / GROUP BY**의 컬럼

그리고 PostgreSQL에서는 **PK도 예외가 아니다.** 리프에 있는 것은 PK 값이 아니라 TID이므로, `(user_id)` 인덱스로 `SELECT id FROM orders WHERE user_id = $1`을 실행하면 `id`를 가져오려고 힙에 간다. PK를 커버하려면 **인덱스 정의에 명시**해야 하고, 그때 쓰는 문법이 **`INCLUDE`**(PostgreSQL 11+) — 탐색·정렬에는 쓰지 않고 **리프에만 싣는** 컬럼 선언이다(2-5).

> **MySQL 대조**: MySQL의 InnoDB는 세컨더리 인덱스 리프에 `(인덱스 컬럼들, PK)`를 담으므로 **PK 컬럼은 정의에 안 써도 공짜로 커버**된다. MySQL에서 PostgreSQL로 넘어온 사람이 가장 먼저 밟는 함정이 "PK는 당연히 커버되겠지"다.

### 1-3. 비용 사슬 — "왔다갔다"를 I/O 단위로 분해한다

이 절이 이 문서의 심장이다. "테이블까지 안 가서 빠르다", "왔다갔다 안 해서 빠르다"는 결론만 말한 것이지 비용을 말한 게 아니다. 면접에서는 **어느 고리가 끊겼는지**를 이름을 붙여 말해야 한다.

먼저 커버링이 **아닐 때** 무슨 일이 벌어지는지를 사슬로 놓는다.

> ⑴ 필요한 컬럼이 인덱스 밖에 있다 → ⑵ 리프에서 얻은 TID로 **힙 페이지를 행마다 한 장씩 읽는다**(블록 번호로 직행하므로 트리 재탐색은 없지만, 페이지 1장 = 요청 1건인 점은 그대로) → ⑶ 인덱스는 `(user_id, created_at)` 순으로 정렬돼 있지만 힙은 **정렬이 없다** — 삽입·갱신 순서대로 빈자리에 쌓일 뿐이라, 인덱스에서 이웃한 두 엔트리의 행은 힙에서 **서로 먼 페이지**에 있다(`pg_stats.correlation`이 이 상관관계를 수치로 들고 있고 플래너가 힙 페치 비용에 반영한다) → ⑷ 그러므로 힙 페치 1건 = 흩어진 페이지 1장을 따로 요청 = **랜덤 I/O 1회** → ⑸ 대상이 N행이면 랜덤 I/O N회이고, 그 N장은 힙 전역에 퍼져 있어 **캐시(`shared_buffers` + OS 페이지 캐시) 워킹셋이 테이블 전체**가 된다 → ⑹ 캐시에 없는 페이지 비율만큼 **디스크 랜덤 읽기**가 발생하고, 처리량은 초당 처리 가능한 랜덤 I/O 수에 묶인다.

(PostgreSQL의 완화책 — 대상이 많으면 `Bitmap Heap Scan`이 **TID를 블록 순으로 정렬해** 힙을 앞에서부터 읽지만, "랜덤을 순차에 가깝게" 만들 뿐 **읽어야 할 힙 페이지 수는 줄지 않는다.** ⑴이 살아 있는 한 힙 페이지는 다 읽어야 한다.)

그리고 **랜덤 I/O가 순차 I/O보다 왜 비싼지**를 세 축으로 고정한다. 이 축이 비어 있으면 위 사슬의 ⑷~⑹이 전부 "그냥 느리다"로 뭉개진다.

- **요청 단위**: 랜덤은 8KB 페이지 1장마다 I/O 요청 1건이다. 순차는 이어진 페이지를 읽으므로 OS 페이지 캐시의 **미리 읽기(readahead)**가 다음 페이지들을 알아서 올려둔다. 흩어진 힙 페이지 접근에는 작동하지 않는다.
- **매체**: HDD는 요청마다 헤드 이동 + 회전 대기가 붙어 차이가 수십 배다. SSD는 그 기계적 대기는 없지만 **요청 1건당 고정 오버헤드**(커널·드라이버·컨트롤러 경로)와 미리 읽기 불가는 그대로라, 차이가 **줄어들 뿐 사라지지 않는다.** "SSD니까 랜덤도 괜찮다"는 절반만 맞다(그래서 SSD에서는 `random_page_cost`를 기본 4.0에서 낮추되 1.0으로 만들지는 않는다).
- **캐시**: 순차는 좁은 범위의 페이지만 만지므로 캐시 히트율이 높고, 랜덤은 워킹셋이 넓어 미스율이 높다. 즉 랜덤 I/O는 **디스크 비용이자 캐시 비용**이다.

이제 커버링이 하는 일은 한 문장이다 — **사슬의 ⑴을 끊는다.** 필요한 컬럼이 전부 인덱스 안에 있으니 ⑵의 힙 페치가 없고, 따라서 ⑶~⑹이 통째로 사라진다. 남는 것은 리프를 형제 링크 따라 **옆으로 이어 읽는 것**뿐인데, 엔트리가 좁아 8KB 페이지 1장에 수백 건이 들어간다. **N행을 읽는 데 힙 페이지 N장(랜덤)이 아니라 리프 N/수백 장** — 이 비율이 "몇 배"의 출처다.

### 1-4. 숫자 감각 — 세 사례

자릿수 감각용이지 정확한 상수가 아니다.

| 쿼리 | 커버링이 아닐 때 | 커버링일 때(visibility map 신선) |
|---|---|---|
| 내 주문 목록 `LIMIT 20` | 리프 1장 + **힙 랜덤 페치 20회** | 리프 1장 |
| 랭킹 TOP 100 | 리프 1~2장 + **힙 랜덤 페치 100회** | 리프 1~2장 |
| `count(*) WHERE status = 'ACTIVE'` (90만 행) | 힙 페치 90만 회 → 플래너가 포기하고 **테이블 100만 행 Seq Scan** | 좁은 인덱스 리프 수천 장 **`Index Only Scan`** |

세 번째 줄이 중요하다. 대상이 많아 인덱스가 버려지던 쿼리(풀스캔 문서 §4의 손익분기)도, **커버링이면 인덱스 전체 스캔(`Index Only Scan`, Index Cond 없이)이 테이블 Seq Scan보다 싸다** — 인덱스가 테이블보다 훨씬 좁기 때문이다. 커버링은 "힙 페치를 없앤다"에서 끝나지 않고 **손익분기 자체를 옮긴다.** 단 괄호의 전제 "visibility map 신선"이 깨지면 세 번째 줄은 도로 "힙 페치 90만 회"로 돌아간다(2-3).

> **MySQL 대조**: InnoDB의 2단계는 힙 페치가 아니라 **PK로 클러스터드 B+Tree를 행마다 재탐색**하는 북마크 룩업이다(루트·브랜치는 캐시, 리프는 행마다 다른 페이지). 페이지 16KB, 캐시는 버퍼 풀 하나, 순차 접근 감지 시 InnoDB 자체 read-ahead. 랜덤 vs 순차의 세 축은 양쪽에 똑같이 적용된다.

### 1-5. 말하기 훈련 — 뭉뚱그린 표현을 이름 붙은 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "테이블까지 안 가서 빠르다" | **힙 페치 제거(Index Only Scan)** | 필요한 컬럼이 인덱스 안 → TID로 힙 방문 0회 → 행마다 흩어진 페이지를 찌르던 랜덤 I/O N회가 → 좁은 리프 N/수백 장 읽기로. 단 visibility map이 "전부 가시"인 페이지만 |
| "왔다갔다 해서 느리다" | **랜덤 I/O + 워킹셋 확대** | 인덱스 정렬 순서 ≠ 힙 순서(무정렬) → 이웃 엔트리의 행이 먼 페이지 → 요청 1건당 페이지 1장 → 미리 읽기 무용 → 워킹셋 = 테이블 전체 → 캐시 미스 → 디스크 랜덤 읽기 |

---

## 2. 동작 — 어떤 상황에서 효과가 크고, EXPLAIN에서 어떻게 확인하나

### 2-1. 효과 공식과 암기 목록 5종

효과의 크기는 공식 하나로 어림된다.

> **효과 ≈ (절감되는 힙 페치 횟수) × (힙 페치 1회의 랜덤 I/O 비용) × (호출 빈도) × (visibility map 전부-가시 비율) − (인덱스 폭 증가로 늘어난 비용)**

앞의 네 항이 크고 마지막 항이 작을수록 효과가 크다. **암기 목록 — 효과 큰 상황 5종**:

1. **대상 행이 많다** — 범위 조회, 낮은 선택도 조건. 힙 페치 횟수 N 자체가 크다. 극단에서는 인덱스 전체 스캔이 Seq Scan을 이긴다(1-4).
2. **필요한 컬럼이 좁다** — 목록 카드·랭킹 행처럼 2~4개의 짧은 컬럼만 쓴다. `jsonb`·`text`가 많은 **넓은 테이블에서 좁은 컬럼만** 뽑을수록 상대 이득이 커진다.
3. **호출 빈도가 높다** — 메인 목록 API, 랭킹 보드, 홈 화면. 출제 의도의 "같은 하드웨어에서 몇 배"는 여기서 실현된다.
4. **세기만 한다** — `count(*)` / `EXISTS` / `sum(amount)` 같은 집계, 또는 조인에서 **조인 키와 필터 컬럼만 필요한 안쪽(inner) 테이블**. [JOIN 문서](06-join-types-and-execution.md) §2-1의 "안쪽이 `Index Only Scan`이면 Nested Loop가 다시 유리해진다"가 이 항목이다.
5. **정렬·페이징을 인덱스에서 끝낸다** — `ORDER BY … LIMIT`, 키셋 페이지네이션([페이지네이션 문서](13-deep-pagination-offset-vs-cursor.md)). 정렬 컬럼까지 인덱스 키에 있어야 커버링과 `Sort` 노드 제거가 동시에 성립한다.

반대로 **효과가 작거나 없는 상황**도 같은 공식에서 나온다 — PK 단건 조회(힙 페치가 1회뿐이라 절감분도 1회), `SELECT *`나 큰 `text`/`jsonb` 포함(커버 자체가 불가), 대상 행이 1~2건, 쓰기가 지배적인 테이블(마지막 항이 앞을 잡아먹는다), 그리고 PostgreSQL 고유로 — **갱신이 잦아 visibility map이 늘 낡아 있는 테이블**(그 비율 항이 앞의 셋을 깎는다).

### 2-2. before / after — 목록 조회 한 건으로

```sql
-- orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint, status text,
--         created_at timestamptz, amount numeric(12,2), memo text, …)
-- 화면: "내 주문 목록" — 카드에 id, created_at, amount 세 컬럼만 표시

-- before: 탐색용 인덱스 + SELECT *
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
--  Limit  (actual rows=20 loops=1)
--    ->  Index Scan Backward using idx_orders_user_created on orders     ← "Only"가 없다
--          Index Cond: (user_id = 7)
--          Buffers: shared hit=23        ← 인덱스 3장 + 20행 각각의 힙 페이지 20장
-- 정렬은 인덱스가 해결했지만(Sort 노드 없음), 행마다 TID로 힙 페이지를 한 장씩 찔렀다.

-- after: 화면이 쓰는 id, amount를 INCLUDE로 리프에만 "실어" 커버링으로 만든다.
--    id(PK)도 공짜가 아니다 — 리프에는 PK가 아니라 TID가 있으므로 명시한다.
--    접두사가 같은 기존 인덱스는 추가가 아니라 교체(중복 인덱스 방지). 운영 중이면 CONCURRENTLY.
CREATE INDEX CONCURRENTLY idx_orders_user_created_cover
    ON orders (user_id, created_at) INCLUDE (id, amount);
DROP INDEX CONCURRENTLY idx_orders_user_created;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, amount FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
--  Limit  (actual rows=20 loops=1)
--    ->  Index Only Scan Backward using idx_orders_user_created_cover on orders
--          Index Cond: (user_id = 7)
--          Heap Fetches: 0               ← 힙 방문 0회. 이 페이지들의 VM 비트가 서 있다는 뜻이기도 하다
--          Buffers: shared hit=3         ← 인덱스 페이지만
```

버퍼가 23에서 3으로 줄었고, 줄어든 20이 정확히 **1-1 그림의 2단계**다.

`amount`는 조건에도 정렬에도 안 쓰인다. **뒤쪽·`INCLUDE` 컬럼은 탐색에는 기여하지 않아도 리프에 실려 있기만 하면 커버링에 기여한다** — 이걸 "실어 나르는(payload) 컬럼"이라고 생각하면 설계할 때 헷갈리지 않는다. 앞쪽은 **찾기 위한** 컬럼(등호 → 범위/정렬 순 — [복합 인덱스 문서 §2-1](08-composite-index-column-order.md)의 "등·범·정·커"), 뒤쪽은 **나르기 위한** 컬럼이고, PostgreSQL은 그 경계를 `INCLUDE`라는 문법으로 명시하게 해 준다.

### 2-3. PostgreSQL만의 두 번째 조건 — visibility map이 없으면 힙을 다시 읽는다

여기가 이 문서에서 가장 실무적인 대목이다. **다른 DB에는 없는 조건이 PostgreSQL에만 하나 더 붙는다.**

전제부터. PostgreSQL은 MVCC(다중 버전 동시성 제어)를 **힙 안에서** 구현한다 — UPDATE는 제자리 수정이 아니라 옛 튜플에 "죽었다"고 표시하고 새 버전을 삽입하는 일이고, "이 버전이 지금 이 트랜잭션에 보이는가"를 판정할 정보(`xmin`/`xmax`)는 **힙 튜플의 헤더에만** 있다([MVCC 문서](11-mvcc-postgresql.md)).

그래서 인덱스 리프 엔트리는 **값은 알아도 가시성은 모른다.** 리프에는 `(컬럼 값들, TID)`뿐이고 `xmin`/`xmax`가 없다. 심지어 이미 죽은 옛 버전을 가리키는 엔트리도 VACUUM이 치우기 전까지 그대로 남아 있다. 즉 인덱스만 읽고 답하면 **이미 삭제된 행을 결과에 섞어 내보낼 수 있다.**

그렇다고 행마다 힙에 물으면 커버링이 무의미해진다. 그래서 PostgreSQL은 **페이지 단위 요약본**을 하나 둔다.

> **visibility map(VM)** — 힙 페이지마다 1비트. **"이 페이지 안의 모든 튜플이 모든 트랜잭션에게 보인다"**면 1이다. 이 비트가 1인 페이지의 행은 가시성을 물을 필요가 없으므로 `Index Only Scan`이 힙을 건너뛴다. 0이면 그 행의 힙 튜플을 읽어 확인한다 — **그 횟수가 계획에 찍히는 `Heap Fetches`다.**

그리고 결정적인 두 문장.

> **VM 비트는 VACUUM만 세운다. 그리고 그 페이지에 어떤 변경이든 생기면 즉시 꺼진다.**

그래서 **VACUUM이 안 돌면 커버링 인덱스를 만들어도 `Index Only Scan`이 힙을 다시 읽는다.** 계획 이름은 그대로인데 속도만 커버링 이전으로 돌아간다. 직접 재현해 보면 이렇다.

```sql
-- 상황 A: VACUUM 직후 — VM 비트가 서 있다
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, amount FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
--  Limit  (actual rows=20 loops=1)
--    ->  Index Only Scan Backward using idx_orders_user_created_cover on orders
--          Index Cond: (user_id = 7)
--          Heap Fetches: 0               ← 힙 방문 0회
--          Buffers: shared hit=3         ← 인덱스 페이지 3장이 전부

-- 인덱스와 아무 상관 없는 컬럼을 갱신한다
UPDATE orders SET memo = 'gift' WHERE user_id = 7;
-- memo는 어떤 인덱스에도 없으니 HOT 업데이트(인덱스는 안 건드린다)지만,
-- 힙 페이지의 내용이 바뀐 것은 사실이므로 그 페이지들의 VM 비트가 꺼진다.

-- 상황 B: VM 비트가 꺼진 뒤 — 같은 쿼리, 같은 인덱스, 같은 계획 이름
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, amount FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
--  Limit  (actual rows=20 loops=1)
--    ->  Index Only Scan Backward using idx_orders_user_created_cover on orders
--          Index Cond: (user_id = 7)     ← 노드 이름은 여전히 "Index Only Scan"이다
--          Heap Fetches: 20              ← 그런데 힙을 20장 읽었다
--          Buffers: shared hit=23        ← 커버링을 만들기 전과 똑같은 비용

VACUUM orders;                            -- 죽은 튜플 회수 + visibility map 갱신
-- 다시 실행 → Heap Fetches: 0, Buffers: shared hit=3 으로 복귀
```

세 줄로 요약하면 — **`Index Only Scan`이라는 계획 이름은 "컬럼이 전부 인덱스에 있다"까지만 보장한다. 힙을 실제로 건너뛰었는지는 `Heap Fetches`만이 말해 준다. 그 값을 0으로 되돌리는 것은 인덱스 설계가 아니라 VACUUM이다.**

그래서 `EXPLAIN`은 반드시 `(ANALYZE, BUFFERS)`로 돌린다. `ANALYZE` 없이는 `Heap Fetches`가 아예 출력되지 않고(실행해 봐야 아는 값이라), `BUFFERS` 없이는 그 20이 실제 페이지 비용으로 얼마인지가 안 보인다.

`Heap Fetches`가 큰 원인은 셋이고 대응이 각각 다르다. ① **autovacuum이 밀림** — 대량 갱신 직후에 흔하다. `pg_stat_user_tables`의 `n_dead_tup`이 크고 `last_autovacuum`이 오래됐으면 이 경우다. 수동 `VACUUM` 후, 그 테이블만 `autovacuum_vacuum_scale_factor`를 낮춘다. ② **롱 트랜잭션** — 오래 열린 트랜잭션이 `pg_stat_activity.backend_xmin`을 잡고 있으면 VACUUM이 돌아도 그보다 나중의 죽은 튜플을 못 치우고 VM도 못 세운다. 이건 VACUUM 튜닝으로 안 풀리고 **트랜잭션을 끊어야** 풀린다([롱 트랜잭션 문서](16-long-transaction-harm-and-shortening.md)). ③ **INSERT만 쌓이는 테이블** — 죽은 튜플이 없어 옛 버전 PostgreSQL에서는 autovacuum이 아예 안 돌았다. PostgreSQL 13부터는 INSERT 양으로도 기동한다(`autovacuum_vacuum_insert_threshold`).

빠른 확진 한 줄은 `pg_class`의 **`relallvisible / relpages`** — VM 비트가 선 페이지의 비율이다. 이 비율이 낮으면 플래너도 `Index Only Scan`의 이득을 낮게 잡아 아예 다른 계획을 고르기 시작하므로, "어느 날부터 커버링 인덱스를 안 탄다"의 원인이기도 하다([실행 계획 급변 문서](31-execution-plan-sudden-change.md)).

### 2-4. 계획 읽기 3종 — `Index Only Scan`은 `Heap Fetches`와 함께 읽는다

PostgreSQL에서는 **스캔 노드 이름 + `Heap Fetches` + `Index Cond`/`Filter`**를 함께 읽는다. **암기 목록 — 계획 3종**:

| 계획 | 뜻 | 힙 방문 |
|---|---|---|
| `Index Only Scan` + `Heap Fetches: 0` | **커버링 완성** — 인덱스만 읽고 끝 | **0회** |
| `Index Only Scan` + `Heap Fetches: N` | 컬럼은 다 인덱스에 있으나 **가시성 확인**을 위해 힙에 감 — 값이 아니라 "보이는가"를 물으러 | **N회**(VM이 낡은 페이지의 행 수만큼) |
| `Index Scan` + `Index Cond` (+ `Filter`) | 컬럼을 힙에서 가져와야 함. `Index Cond`의 비접두 키 조건은 **인덱스 엔트리 단계에서 걸러져** 탈락 행의 힙 방문을 막고, `Filter`는 **힙에서 가져온 뒤** 검사 | 통과한 행 전부(`Rows Removed by Filter`는 힙까지 갔다가 버린 계산서) |

두 번째 줄이 2-3에서 다룬 PostgreSQL 고유의 함정이다.

세 번째 줄은 커버링을 못 만들었을 때의 차선과 최악의 구분이다 — 한 문장으로 **`Index Only Scan`은 힙 접근이 없다(VM이 허락하는 한), `Index Cond`의 비접두 키는 인덱스 엔트리에서 미리 걸러 힙 접근 횟수를 줄인다, `Filter`는 힙 접근 뒤에 버린다**(`Rows Removed by Filter`가 그 낭비의 계산서 — [복합 인덱스 문서 §1-4](08-composite-index-column-order.md)).

그리고 `Index Only Scan`이라도 `Index Cond`가 없으면 **인덱스 전체 스캔**이다 — "좁힌 뒤 커버링"과는 다르니 `actual rows`·`Buffers`와 함께 판단한다.

> **MySQL 대조**: 같은 세 층이 `Extra` 칸에 이름으로 찍힌다 — `Using index`(커버링, 룩업 0회) / `Using index condition`(**ICP**: 인덱스 컬럼 조건을 룩업 전에 인덱스 엔트리에서 평가해 탈락 행의 룩업을 건너뜀 = PostgreSQL의 `Index Cond` 비접두 키 검사) / `Using where`(룩업 후 필터 = PostgreSQL의 `Filter`). 인덱스 전체 스캔은 `type: index`. MySQL에는 `Heap Fetches`에 해당하는 것이 **없다** — InnoDB는 언두 로그 기반 MVCC라 세컨더리 리프에서 가시성을 판정할 수 있어 `Using index`면 정말 인덱스만 읽는다. 이것이 이 문항에서 두 DB의 답이 가장 크게 갈리는 지점이다.

### 2-5. `INCLUDE` vs 키 컬럼 — DDL 두 벌로 대비한다 (가산점 포인트)

같은 컬럼을 인덱스에 넣는 방법이 둘이다. 무엇이 다른지 DDL을 나란히 놓고 본다.

```sql
-- (가) 키 컬럼으로 붙인다
CREATE INDEX idx_a ON orders (user_id, created_at, id, amount);
--   1) id, amount가 정렬 기준에 참여한다
--      → 내부(비리프) 페이지에도 실려 트리가 뚱뚱해지고, 비교 비용도 늘어난다
--   2) 유니크 인덱스였다면 유일성 판정에까지 참여한다 → 제약의 의미가 바뀐다
--   3) 비교 연산자(연산자 클래스)가 정의된 타입만 넣을 수 있다
--   4) 그 대신 (user_id, created_at, id)까지가 접두사이므로
--      키셋 페이지네이션의 타이브레이커로 id를 쓸 수 있다

-- (나) INCLUDE로 붙인다 (PostgreSQL 11+)
CREATE INDEX idx_b ON orders (user_id, created_at) INCLUDE (id, amount);
--   1) id, amount는 리프에만 실린다 → 내부 페이지는 2컬럼 그대로, 트리의 폭·높이 유지
--   2) 정렬·유일성 판정에 참여하지 않는다 → 유니크 인덱스에도 그대로 덧붙일 수 있다
--   3) 비교 연산자가 없는 타입도 실을 수 있다
--   4) 그 대신 탐색·정렬에는 절대 못 쓴다 (Index Cond에 등장하지 않는다)
```

선택 기준은 한 줄이다 — **그 컬럼으로 찾거나(WHERE) · 정렬하거나(ORDER BY) · 키셋 비교에 쓰면 키 컬럼, 결과에 싣기만 하면 `INCLUDE`.** 키셋 페이지네이션의 타이브레이커로 `id`를 쓸 계획이면 `(user_id, created_at, id) INCLUDE (amount)`처럼 `id`만 키로 올린다.

한 가지 함정이 있다. **`INCLUDE` 컬럼도 HOT 판정에서는 인덱스 컬럼으로 친다.** `INCLUDE` 컬럼이 바뀌는 UPDATE는 HOT에서 탈락한다(3-3) — "나르기용이니 갱신 비용은 없겠지"는 틀렸다.

그리고 `Index Only Scan`은 인덱스가 **원래 값을 돌려줄 수 있어야** 성립하므로 B-tree는 되고 GIN·BRIN은 불가하다(둘 다 원본 값이 아니라 요약본을 들고 있다) — 커버링 설계는 사실상 B-tree 이야기다.

> **MySQL 대조**: `INCLUDE`가 없다. 나르기용 컬럼도 키 컬럼으로 붙여야 하므로 내부 노드가 넓어지고 키 길이 상한(3-5)·비교 비용을 함께 짊어진다. SQL Server에는 PostgreSQL과 같은 `INCLUDE`가 있다.

---

## 3. 대가와 안전망 — 폭 · 쓰기 · 취약 · 상한, 그리고 네 겹의 그물

### 3-1. 대가 넷을 한 줄씩 — 왜 그런지까지

편익만 말하면 반쪽 답이다. 커버링 인덱스는 **읽기의 랜덤 I/O**를 **인덱스 폭 + 쓰기 비용 + 유지보수 취약성**으로 바꾸는 거래이고, 면접관은 후자를 말하는지 반드시 본다. **암기 목록 — 대가 4종**은 "폭·쓰기·취약·상한"이다.

| 대가 | 한 줄 이유 |
|---|---|
| **폭** | 나르기용 컬럼을 실으면 리프 엔트리가 커지고, 그만큼 8KB 페이지에 들어가는 엔트리 수가 줄어 **같은 행 수를 읽는 데 페이지가 더 필요**해진다. 커버링으로 번 이득을 스스로 조금 갉아먹고, 캐시에서 남의 페이지까지 밀어낸다 |
| **쓰기** | 실은 컬럼이 UPDATE되면 그 UPDATE가 **HOT에서 탈락**하고, PostgreSQL은 새 튜플이 새 TID를 받으므로 **그 테이블의 모든 인덱스**에 새 엔트리를 꽂는다. 인덱스 하나 몫이 아니라 전부 몫이다 |
| **취약** | 커버링은 인덱스의 성질이 아니라 **인덱스와 쿼리의 관계**라서(1-2), 인덱스를 안 건드려도 **쿼리 쪽이 바뀌면 깨진다.** SELECT 목록에 컬럼 하나만 늘어도 끝이고, 에러도 경고도 없다 |
| **상한** | B-tree 엔트리는 **페이지의 약 1/3**을 넘을 수 없다. 큰 `text`/`jsonb`는 애초에 실을 수 없고, 실으려 하면 INSERT 시점에 에러가 난다 |

### 3-2. 폭 — 넓어진 인덱스는 커버링의 이득 일부를 스스로 갉아먹는다

> 나르기용 컬럼을 붙인다 → 리프 엔트리가 커진다 → 8KB 페이지당 엔트리 수↓ → 같은 행 수를 담는 리프 페이지 수↑ → 같은 범위를 읽는 데 페이지가 더 필요하고 → **`shared_buffers`·OS 캐시 적재율↓** → 이 인덱스가 다른 인덱스·힙 페이지를 밀어낸다.

[힙 테이블과 인덱스 구조 문서](03-clustered-vs-secondary-index.md)의 "엔트리 폭 → 페이지당 엔트리 수 → 캐시 적재율" 사슬과 같다. 그래서 원칙은 **필요한 컬럼만, 짧은 타입만**이다. `text` 제목이나 `numeric` 여러 개를 "혹시 쓸지 모르니" 싣는 순간 1-3의 "N/수백 장"이 "N/수십 장"으로 줄어들고 이득이 반감된다. `INCLUDE`가 내부 노드는 지켜 주지만 **리프의 폭은 그대로 늘어난다.**

### 3-3. 쓰기 — 실은 컬럼이 UPDATE되는 순간 그 테이블의 모든 인덱스가 움직인다

인덱스에 없던 컬럼은 UPDATE해도 인덱스가 움직이지 않았다. 커버링을 위해 그 컬럼을 실은 순간부터는 다르다 — 그리고 PostgreSQL에서는 그 대가가 **그 인덱스 하나에 머물지 않는다.**

용어부터. **HOT(Heap-Only Tuple) 업데이트** = 바뀐 컬럼이 어떤 인덱스에도 안 들어 있고 새 버전을 같은 힙 페이지에 놓을 자리가 있을 때, 인덱스를 하나도 안 건드리고 힙 페이지 안에서만 끝내는 UPDATE다. "힙에만 사는 튜플"이라는 이름 그대로, 인덱스는 이 새 버전의 존재를 모른 채 옛 엔트리로 계속 도달한다.

> 실은 컬럼이 UPDATE된다 → PostgreSQL의 UPDATE는 제자리 수정이 아니라 **새 튜플 버전 삽입**이다 → 바뀐 컬럼이 **어떤 인덱스에라도** 들어 있으면(`INCLUDE` 컬럼 포함) **HOT에서 탈락**한다 → 새 튜플은 새 TID를 받으므로 그 TID를 가리키는 엔트리를 **그 테이블의 모든 인덱스**에 하나씩 꽂는다(쓰기 증폭 — [복합 인덱스 문서 §3-2](08-composite-index-column-order.md)의 "상태 5번 × 인덱스 5개 = 인덱스 쓰기 25번") → 옛 엔트리는 죽은 버전을 가리킨 채 VACUUM 전까지 남는다(인덱스 bloat) → 그리고 그 힙 페이지의 **VM 비트가 꺼져** 정작 커버링 읽기의 `Heap Fetches`가 늘어난다(2-3).

즉 자주 바뀌는 컬럼을 싣는 것은 **쓰기 증폭과 읽기 커버링 약화를 동시에** 사는 일이다.

```sql
-- before: "화면에 다 보이니까" 자주 바뀌는 컬럼까지 실었다
CREATE INDEX idx_orders_user_cover
    ON orders (user_id, created_at) INCLUDE (id, amount, status, updated_at);
-- status는 주문 상태 전이마다, updated_at은 모든 UPDATE마다 바뀐다
-- → 그때마다 HOT 탈락 → 이 테이블의 모든 인덱스에 새 엔트리 + bloat + VM 해제
-- → 읽기에서 번 랜덤 I/O를 쓰기로 도로 지불

-- after: 생성 후 거의 안 바뀌는 컬럼만 싣고, 자주 바뀌는 컬럼은 화면 요구를 재협상하거나
--    (목록엔 상태를 안 보여주고 상세에서 본다) 별도 조회로 뺀다
CREATE INDEX idx_orders_user_cover
    ON orders (user_id, created_at) INCLUDE (id, amount);
```

판단 기준을 한 줄로 — **"이 컬럼은 행이 만들어진 뒤 몇 번 바뀌는가?"** 거의 안 바뀌면 싣고, 자주 바뀌면 싣지 않는다. 실측은 `pg_stat_user_tables`의 `n_tup_upd` 대비 `n_tup_hot_upd` — 인덱스를 추가한 뒤 HOT 비율이 떨어졌다면 그 컬럼이 범인이다.

> **MySQL 대조**: InnoDB는 바뀐 컬럼이 들어 있는 **그 세컨더리 인덱스만** 옛 엔트리 삭제 표시 + 새 엔트리 삽입으로 갱신한다(행은 제자리 갱신 + 언두 로그). 같은 대가가 MySQL에서는 인덱스 하나 몫, PostgreSQL에서는 **테이블의 인덱스 전부 몫**이다.

### 3-4. 취약 — SELECT에 컬럼 하나 추가하면 에러 없이 조용히 깨진다

가장 실무적인 대가다. 커버링은 **인덱스와 쿼리의 관계**라서(1-2), 쿼리 쪽이 바뀌면 인덱스는 그대로여도 관계가 깨진다. 말로만 하면 와닿지 않으니 계획으로 본다. 인덱스는 2-2의 `(user_id, created_at) INCLUDE (id, amount)` 그대로이고, 바뀐 것은 SELECT 목록 하나뿐이다.

```sql
-- 변경 전: 카드에 id, created_at, amount 세 컬럼만 그린다
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, amount
FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
--  Limit  (actual rows=20 loops=1)
--    ->  Index Only Scan Backward using idx_orders_user_created_cover on orders
--          Index Cond: (user_id = 7)
--          Heap Fetches: 0
--          Buffers: shared hit=3

-- 변경 후: 기획이 카드에 상태 뱃지를 넣어 달라고 해서 status 하나를 추가했다
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, amount, status
FROM orders WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
--  Limit  (actual rows=20 loops=1)
--    ->  Index Scan Backward using idx_orders_user_created_cover on orders
--          Index Cond: (user_id = 7)
--          Buffers: shared hit=23
```

세 곳이 바뀌었는데 셋 다 눈에 잘 안 띈다.

| | 변경 전 | 변경 후 | 알아채기 |
|---|---|---|---|
| 노드 이름 | `Index Only Scan Backward` | `Index Scan Backward` | **"Only" 두 글자가 사라진 것**이 유일한 이름 단서다 |
| `Heap Fetches` | `0` | **줄 자체가 없음** | 이 줄은 `Index Only Scan`에만 출력된다. "0이 아니라 사라진" 것이라 값 비교로는 못 잡는다 |
| `Buffers` | `shared hit=3` | `shared hit=23` | 인덱스 3 + 힙 20. 여기가 유일하게 숫자로 잡히는 지점이다 |

그리고 **에러도 경고도 없고, 쿼리 결과는 완전히 정확하다.** 목록 20건이면 힙 페치 20회라 사람이 체감하지도 못한다. 문제는 같은 인덱스를 커버링으로 믿고 있던 **다른 쿼리들**이다 — 랭킹 TOP 1,000이면 힙 페치 1,000회, 집계 쿼리면 수만 회가 부활한다. p99 지연 그래프만 조용히 올라가고, 원인이 6개월 전 DTO에 필드 하나 추가한 커밋이라는 사실은 아무도 연결하지 못한다.

JPA는 이 취약성을 구조적으로 안고 있다 — 엔티티를 조회하면 **모든 컬럼을 SELECT**하므로 엔티티 조회는 절대 커버링이 되지 않는다. 커버링을 쓰려면 DTO 프로젝션이 필수이고, 그래서 3-7 이하의 안전망이 필요하다.

### 3-5. 상한과 중복 — 엔트리 크기 제한, 접두사 인덱스의 부재, 기존 인덱스와의 교체

- **엔트리 크기 상한**: B-tree 인덱스 엔트리는 **페이지의 약 1/3**(8KB 페이지에서 약 2,700바이트)을 넘을 수 없다 — 트리가 성립하려면 내부 페이지 하나에 최소 몇 개의 키가 들어가야 하기 때문이다. 긴 `text`를 키나 `INCLUDE`에 넣으면 그 행을 INSERT하는 순간 "index row size … exceeds … maximum" 에러가 난다. 큰 `text`/`jsonb`가 필요한 화면은 커버링 대상이 아니다.
- **접두사 인덱스가 없다**: MySQL의 `title(30)` 같은 문법이 PostgreSQL에는 없다. 흉내는 표현식 인덱스 `(left(title, 30))`인데, `title` 전체를 들고 있지 않으므로 `title`을 SELECT하는 쿼리를 **커버할 수 없다.**
- **중복 인덱스**: `(user_id, created_at)`가 있는데 `(user_id, created_at) INCLUDE (id, amount)`를 **추가**하면 접두사가 같은 중복이다. 교체가 맞지만, 교체 전에 기존 인덱스를 쓰던 다른 쿼리를 `pg_stat_user_indexes.idx_scan`으로 확인한다([복합 인덱스 문서 §3-5](08-composite-index-column-order.md)). 교체는 `CREATE INDEX CONCURRENTLY` → `DROP INDEX CONCURRENTLY`로 잠금 없이 — 단 CONCURRENTLY의 제약(트랜잭션 블록 불가, 실패 시 `INVALID` 잔존)은 [온라인 DDL 문서](14-online-ddl-zero-downtime-schema-change.md).

> **MySQL 대조**: InnoDB 키 상한은 DYNAMIC 행 포맷 기준 3072바이트, `TEXT`/`BLOB`은 접두사 인덱스로만 가능하고 접두사 인덱스는 커버 불가. 온라인 인덱스 생성은 `ALGORITHM=INPLACE` 또는 pt-osc/gh-ost.

### 3-6. 한 호흡 템플릿 — 편익과 대가를 한 문장에

면접에서 편익과 대가를 **한 문장 안에** 넣는 연습용 문장이다. 이 문장이 입에서 그대로 나오면 "편익만 서술"이라는 약점은 이 문항에서 재발하지 않는다.

> "커버링 인덱스는 **읽기에서 힙 페치 N회, 즉 랜덤 I/O N회를 0으로 만들어** 몇 배의 처리량을 얻는 대신 — PostgreSQL에선 그 0이 **visibility map이 신선할 때만** 성립하고 — **폭**(엔트리 비대 → 캐시 적재율↓)·**쓰기**(실은 컬럼 UPDATE마다 HOT 탈락으로 모든 인덱스 갱신)·**취약성**(SELECT에 컬럼 하나 추가로 조용히 무효)을 치릅니다. 그래서 '많이 읽고, 좁게 쓰고, 자주 불리는' 쿼리에, 거의 안 바뀌는 컬럼만 `INCLUDE`로 실어 제한적으로 씁니다."

### 3-7. 안전망 ⑴ — 코드: DTO 프로젝션으로 SELECT 목록을 타입에 고정한다

3-4의 "조용히 깨짐"은 PR 설명이나 위키, 담당자의 기억으로는 막을 수 없다. 컬럼을 추가하는 사람은 6개월 뒤의 다른 사람이고, 그 사람은 이 인덱스의 존재를 모른다. 그래서 네 겹으로 고정한다. **암기 목록 — 안전망 4종: 프로젝션 · 실행 계획 테스트 · 마이그레이션 주석 · 호출당 블록 수 알림.**

```java
// before: 엔티티 조회 — 모든 컬럼을 SELECT하므로 어떤 인덱스로도 커버 불가
List<Order> findByUserIdOrderByCreatedAtDesc(Long userId, Pageable pageable);
// → SELECT o.id, o.user_id, o.status, o.created_at, o.amount, o.memo, … FROM orders o …

// after: 닫힌 인터페이스 프로젝션 — 여기 선언한 getter만 SELECT 된다.
//        즉 이 타입이 SELECT 목록의 계약이 되고, 컬럼 추가는 반드시 이 파일의 diff로 드러난다.
public interface OrderCard {
    Long getId();
    OffsetDateTime getCreatedAt();   // timestamptz ↔ OffsetDateTime (pgjdbc 매핑)
    BigDecimal getAmount();
}
List<OrderCard> findByUserIdOrderByCreatedAtDesc(Long userId, Pageable pageable);
// → SELECT o.id, o.created_at, o.amount FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT ?
//   idx_orders_user_created_cover (user_id, created_at) INCLUDE (id, amount) 에 정확히 덮인다
```

(`@Query("select new …OrderCard(o.id, o.createdAt, o.amount) …")`의 클래스 기반 DTO나 QueryDSL `Projections.constructor`도 같은 효과다.) 핵심은 **프로젝션 타입이 곧 SELECT 목록의 계약**이라는 것 — 컬럼을 추가하려면 이 타입을 고쳐야 하고, 그 diff가 리뷰에 드러난다.

### 3-8. 안전망 ⑵ — 테스트: 실행 계획을 단정하는 통합 테스트

프로젝션을 고쳐도 사람이 "이거 커버링 깨지는데?"를 떠올려야 한다면 아직 기억 의존이다. 실행 계획 자체를 테스트가 단정하게 한다.

```java
@Test  // Testcontainers PostgreSQL 위에서 실행
void 주문목록_조회는_Index_Only_Scan을_탄다() throws Exception {
    // 행이 수백 건뿐이면 플래너가 Seq Scan을 고르는 게 정상이라 거짓 실패한다 → 실전 규모 시드
    seedOrders(200_000);
    // 통계(플래너 판단용) + visibility map(Heap Fetches 0의 전제)을 한 번에 갱신한다
    jdbcTemplate.execute("VACUUM ANALYZE orders");

    // JPA가 실제로 내보내는 SQL(p6spy 로그에서 확보)을 그대로 EXPLAIN 한다
    String plan = jdbcTemplate.queryForObject(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
      + "SELECT o.id, o.created_at, o.amount FROM orders o "
      + "WHERE o.user_id = 7 ORDER BY o.created_at DESC LIMIT 20", String.class);
    JsonNode scan = objectMapper.readTree(plan).at("/0/Plan/Plans/0");   // Limit 아래 첫 자식

    assertThat(scan.at("/Node Type").asText()).isEqualTo("Index Only Scan");   // 깨지면 "Index Scan"
    assertThat(scan.at("/Index Name").asText()).isEqualTo("idx_orders_user_created_cover");
    assertThat(scan.at("/Heap Fetches").asInt()).isZero();                     // VACUUM 직후이므로 0이어야 정상
}
```

주의 세 가지. ⑴ 단정은 `Node Type`·`Index Name`처럼 **구조적으로 결정되는 값**에 한정한다 — 비용·추정 행 수는 통계에 따라 흔들리고, `Heap Fetches`는 직전에 VACUUM을 돌렸을 때만 단정할 수 있다. ⑵ EXPLAIN 대상 SQL은 **JPA가 실제로 내보낸 문장**이어야 한다(p6spy·datasource-proxy 로그로 확보). ⑶ **`VACUUM`은 트랜잭션 블록 안에서 실행할 수 없다** — 테스트 메서드에 `@Transactional`을 걸면 실패한다. 무거우니 **커버링이 곧 SLA인 쿼리 몇 개**에만 건다.

### 3-9. 안전망 ⑶ — 설정: 마이그레이션 파일에 인덱스의 존재 이유를 박는다

인덱스 정의는 Flyway/Liquibase 마이그레이션이라는 **코드**로 관리되므로, "이 인덱스가 누구를 위해 존재하는지"를 그 파일 안에 남길 수 있다.

```sql
-- V37__orders_user_created_cover.sql
-- [COVERING] OrderCard 프로젝션(id, created_at, amount) 전용 커버링 인덱스.
--   키 2컬럼 = 탐색·정렬용, INCLUDE = 나르기용(id는 PK지만 PG 리프엔 TID뿐이라 명시).
--   OrderCard에 컬럼을 추가하면 커버링이 깨진다 → OrderCoveringIndexTest가 실패한다.
--   자주 바뀌는 컬럼(status, updated_at)은 HOT 탈락을 피하려고 의도적으로 제외(3-3).
--   CONCURRENTLY는 트랜잭션 밖에서만 가능 → 이 파일은 비트랜잭션 마이그레이션으로 표시.
CREATE INDEX CONCURRENTLY idx_orders_user_created_cover
    ON orders (user_id, created_at) INCLUDE (id, amount);
```

이름 규약도 설정의 일부다 — `_cover` 접미사를 붙여 두면 리뷰어가 이름만 보고 "나르기용 컬럼이 실린 인덱스"임을 알고, `\d orders`나 `pg_indexes` 조회에서도 "왜 amount가 INCLUDE에 있지? 지워도 되나?"라는 오판을 막는다.

### 3-10. 안전망 ⑷ — 운영: 호출당 블록 수 알림, 마지막 그물

앞의 세 겹을 다 뚫고 배포된 뒤에도 에러는 나지 않는다. 그래서 관측이 마지막 그물이다.

**`pg_stat_statements`**에서 해당 쿼리(`queryid`)의 **호출당 읽은 블록 수 `(shared_blks_hit + shared_blks_read) / calls`**가 기준선 대비 튀면 알림이 오게 둔다 — 3-4의 표에서 본 대로 커버링이 깨지면 반환 행 수는 그대로여도 힙 블록이 행 수만큼 추가되어 자릿수가 바뀐다. 다만 이 지표는 **커버링이 깨졌을 때와 VM이 낡았을 때 똑같이 오르므로**, `n_dead_tup`·`last_autovacuum`을 같이 봐서 둘을 가른다.

**`auto_explain`**(`log_min_duration`, `log_analyze`, `log_buffers`)을 켜 두면 느려진 쿼리의 계획이 로그에 남아 `Index Only Scan` → `Index Scan` 전환이나 `Heap Fetches` 폭증을 확진할 수 있다 — 앞의 두 원인을 구분해 주는 것이 이 로그다.

반대 방향도 본다 — `pg_stat_user_indexes`에서 `_cover` 인덱스의 `idx_scan`이 0에 머물면 쿼리 쪽이 바뀌어 더는 안 쓰이는 것이니 정리 대상이다.

### 3-11. 암기 카드 — 네 개의 목록을 한 장에

면접 직전에 이 카드만 훑는다. 목록이 인출되지 않으면 사슬도 트레이드오프도 꺼낼 수 없다.

- **효과 큰 상황 5종**: ① 대상 행이 많다 ② 필요한 컬럼이 좁다 ③ 자주 불린다 ④ 세기만 한다(`count(*)`/EXISTS/집계/조인 안쪽) ⑤ 정렬·페이징을 인덱스에서 끝낸다(키셋) → 기억 열쇠 **"많이 · 좁게 · 자주 · 세기 · 정렬"** — 다섯 모두 **"visibility map이 신선한 테이블"** 전제
- **계획 3종**: `Index Only Scan` + `Heap Fetches: 0`(완성) / `Index Only Scan` + `Heap Fetches: N`(가시성 확인 — VACUUM) / `Index Scan` + `Index Cond`·`Filter`(힙 방문) — `Index Cond` 없는 `Index Only Scan`은 인덱스 **전체 스캔**
- **대가 4종**: **폭**(캐시 적재율↓) · **쓰기**(실은 컬럼 UPDATE마다 HOT 탈락 → 모든 인덱스 갱신 + VM 해제) · **취약**(SELECT 컬럼 추가로 조용히 무효) · **상한**(엔트리 크기 페이지 1/3, 접두사 인덱스 없음, 중복 교체는 CONCURRENTLY)
- **안전망 4종**: DTO **프로젝션** · EXPLAIN **단정 테스트**(`Node Type`, `Index Name`) · 마이그레이션 **주석 + `_cover` 규약** · **`pg_stat_statements` 호출당 블록 수 알림 + `auto_explain`**
- **비용 사슬 한 줄**: 컬럼이 인덱스 밖 → TID로 힙 페이지 행마다 → 인덱스 순서 ≠ 힙 순서 → 페이지 1장당 요청 1건 = 랜덤 I/O → 워킹셋 = 테이블 전체 → 캐시 미스 → 디스크 랜덤 읽기. 커버링은 첫 고리를 끊는다 — 단 **가시성은 visibility map에게 물어야** 완전히 끊긴다.

---

## 4. 꼬리질문 대비 포인트

### "커버링 인덱스가 왜 빠른지, '테이블에 안 가서' 말고 I/O 단위로 설명해보세요."

PostgreSQL의 인덱스 조회는 2단계다. 1단계는 리프를 형제 링크로 훑는 읽기라 싸고, 2단계는 리프에서 얻은 TID로 힙 페이지를 **행마다 한 장씩** 읽는 것이다. 인덱스는 자기 컬럼 순으로 정렬돼 있지만 힙은 정렬이 없어 **인덱스에서 이웃한 행이 힙에서는 먼 페이지**에 있고, 그래서 2단계는 **페이지 1장당 요청 1건인 랜덤 I/O**다 — 미리 읽기가 안 걸리고, 워킹셋이 테이블 전체로 퍼져 캐시 미스도 늘어난다. 커버링은 필요한 컬럼이 전부 인덱스에 있어 **2단계 자체가 없다.** 대상 N행에 대해 "랜덤 페이지 N장"이 "좁은 리프 N/수백 장"으로 바뀌는 것이 몇 배의 정체다. 두 마디를 붙이면 비용 모델을 이해했다는 신호가 된다 — ① **SSD에서도** 요청당 고정 오버헤드 때문에 차이는 줄어들 뿐 사라지지 않는다, ② PostgreSQL에서는 이 0이 **visibility map이 "전부 가시"인 페이지에 한해** 성립한다(`Heap Fetches`).

### "`Index Only Scan`이 떴는데도 안 빠릅니다. 뭘 보나요?"

**`EXPLAIN (ANALYZE, BUFFERS)`의 `Heap Fetches`**부터 본다. 계획 이름은 "컬럼이 다 인덱스에 있다"까지만 보장하고, 힙을 건너뛸지는 실행 시점에 페이지마다 visibility map을 보고 정한다. `Heap Fetches`가 `actual rows`에 가깝고 `Buffers`가 커버링 이전과 비슷하면, 커버링은 성립했지만 **VM이 낡아** 사실상 `Index Scan`으로 동작한 것이다. 원인은 순서대로 — ① autovacuum이 밀림(대량 갱신 직후, `n_dead_tup`↑·`last_autovacuum` 오래됨 → `VACUUM` 수동 실행, 그 테이블만 `autovacuum_vacuum_scale_factor`를 낮춤) ② **롱 트랜잭션**이 `pg_stat_activity.backend_xmin`을 잡고 있어 VACUUM이 돌아도 죽은 튜플을 못 치우고 VM을 못 세움([롱 트랜잭션 문서](16-long-transaction-harm-and-shortening.md) — 트랜잭션을 끊어야 해결) ③ INSERT만 쌓이는 테이블이라 죽은 튜플이 없어 autovacuum이 안 돎(PostgreSQL 13부터는 INSERT 양으로도 기동). 빠른 확진은 `pg_class`의 `relallvisible / relpages`(VM 비트가 선 페이지 비율) — 이 비율이 낮으면 플래너도 `Index Only Scan`의 이득을 낮게 잡아 다른 계획을 고르기 시작하니, "어느 날부터 커버링 인덱스를 안 탄다"의 원인이기도 하다([실행 계획 급변 문서](31-execution-plan-sudden-change.md)).

### "JPA 엔티티 조회는 `SELECT *`인데, 그러면 커버링 인덱스를 못 쓰나요?"

엔티티 조회로는 못 쓴다 — 모든 컬럼을 SELECT하므로 어떤 인덱스로도 덮이지 않는다. 방법은 둘이다. ⑴ **DTO 프로젝션**(인터페이스 프로젝션, `select new`, QueryDSL `Projections`)으로 SELECT 목록을 필요한 컬럼만으로 고정한다. ⑵ 행 전체가 정말 필요하면 **지연 조인(deferred join)** — 커버링 인덱스로 **PK만 먼저** 뽑고, 살아남은 PK로만 행을 가져온다. 단 PostgreSQL에서는 **PK가 인덱스에 자동으로 들어 있지 않으므로** 서브쿼리가 `Index Only Scan`이 되려면 `id`를 키나 `INCLUDE`에 실어 둬야 한다.

```sql
-- 인덱스: (user_id, created_at) INCLUDE (id)   ← id를 싣지 않으면 서브쿼리부터 힙에 간다
SELECT o.*
FROM orders o
JOIN (SELECT id FROM orders                       -- Index Only Scan: 인덱스만으로 id를 뽑는다
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20 OFFSET 100000) t ON o.id = t.id;   -- 버리는 10만 건에는 힙 페치가 없고,
                                                  -- 살아남은 20건만 orders_pkey로 힙 페치
```

JPA에서는 "PK 목록 조회 → `findAllById`" 2단계로 같은 효과를 낸다. 다만 OFFSET이 버리는 10만 엔트리를 **읽기는 읽는다**는 한계는 그대로라, 깊은 페이지에서는 **키셋 페이지네이션** — `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 20`을 `(user_id, created_at, id)` 인덱스로 — 이 정석이다. PostgreSQL은 이 행 비교를 B-tree 범위 탐색으로 실행한다([페이지네이션 문서](13-deep-pagination-offset-vs-cursor.md)).

### "커버링 인덱스는 항상 이득인가요? 만들지 말아야 할 때는 언제죠?" (시니어 변별 포인트)

아니다. 이득은 `절감 힙 페치 횟수 × 랜덤 I/O 비용 × 호출 빈도 × VM 신선도 − 인덱스 폭 비용`이므로, 앞이 작거나 뒤가 크면 손해다. 만들지 말아야 할 때는 — ⑴ **실을 컬럼이 자주 UPDATE될 때**: HOT 탈락으로 **테이블의 모든 인덱스**에 새 엔트리 + bloat + VM 해제 — 읽기 이득까지 같이 깎인다. ⑵ **컬럼이 넓거나 많을 때**: 엔트리 비대 → 캐시 적재율↓로 다른 인덱스까지 밀어내고, 큰 `text`/`jsonb`는 엔트리 크기 상한에 걸려 애초에 불가. ⑶ **호출이 드물거나 대상이 1~2건일 때**: 절감분이 없다. ⑷ **갱신 폭풍 테이블이라 VM이 늘 낡아 있을 때**: `Index Only Scan`이 떠도 `Heap Fetches`가 행 수만큼 나온다 — autovacuum 튜닝이나 갱신 패턴 분리(자주 바뀌는 컬럼을 별도 테이블로)가 선행돼야 한다. ⑸ **쿼리 모양이 자주 바뀌는 화면일 때**: 컬럼 추가로 조용히 깨지는 취약성을 감당할 안전망(프로젝션 고정 + EXPLAIN 테스트)이 없다면 만들지 않는 게 낫다. 즉 답은 "많이·좁게·자주 읽히고, 거의 안 바뀌는 컬럼만 싣고, VM이 유지되는 테이블에서, 깨짐을 테스트가 잡아주는 조건에서만 만든다"이고, 그 근거를 **`EXPLAIN (ANALYZE, BUFFERS)` 전후 비교와 실제 지연 측정**으로 남기는 것까지가 세트다.

### "`SELECT count(*) FROM orders`가 PK가 아니라 엉뚱한 작은 인덱스를 타던데, 왜 그런가요?" (가산점 포인트)

`count(*)`는 어떤 컬럼 값도 필요 없어 **모든 B-tree 인덱스가 그 쿼리에 대해 커버링**이다. 그러면 남는 기준은 "어느 트리가 가장 좁아서 페이지 수가 적은가"뿐이고, 플래너는 조건 없는 `count(*)`를 **가장 작은 인덱스**의 `Index Only Scan`(대량이면 `Parallel Index Only Scan`)으로 처리한다 — PK 인덱스가 가장 좁다는 보장은 없다(단일 `boolean` 인덱스가 더 작다). 이 현상을 설명할 수 있으면 "커버링 = 필요한 컬럼이 인덱스 안"이라는 정의를 극한(필요한 컬럼이 0개)까지 밀어 이해했다는 뜻이다. 단 PostgreSQL에는 조건이 하나 더 붙는다 — 플래너는 `pg_class.relallvisible`로 힙 페치 비율을 추정하므로, **VM이 낡은 테이블에서는 같은 `count(*)`가 Seq Scan으로 간다**(인덱스 전체 + 힙 전체를 읽느니 힙만 읽는 게 싸다). "어제는 인덱스로 세더니 오늘은 풀스캔"이 대량 갱신 뒤에 나타나고 `VACUUM` 후 돌아오는 이유다. MVCC 때문에 카운트를 미리 들고 있을 수 없다는 근본 한계와 대안은 [전체 건수 문서](17-total-count-cost-and-alternatives.md)에서 잇는다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **PK 공짜 커버링** — InnoDB 세컨더리 리프에는 PK가 들어 있어 PK 컬럼은 자동 커버되지만, PostgreSQL 리프에는 TID뿐이라 PK도 `INCLUDE`로 명시해야 한다(지연 조인이 MySQL에서 "공짜"인 이유). ② **커버링 판정의 두 번째 조건** — MySQL `Using index`는 그 자체로 룩업 0회지만, PostgreSQL `Index Only Scan`은 visibility map이 신선한 페이지만 힙을 건너뛴다(`Heap Fetches`). MySQL은 언두 로그 기반 MVCC라 세컨더리 리프에서 가시성을 판정할 수 있어 이 조건이 없다. ③ **문법** — MySQL은 나르기용 컬럼도 키에 붙여야 하지만 PostgreSQL은 `INCLUDE`로 리프에만 싣는다. ④ **ICP** — MySQL은 `Using index condition`이라는 이름표가 따로 있고, PostgreSQL은 같은 동작이 `Index Cond` 비접두 키 검사로 기본 내장돼 이름이 없다. ⑤ **자주 바뀌는 컬럼의 대가** — InnoDB는 그 인덱스만 삭제+삽입, PostgreSQL은 HOT 탈락으로 **모든 인덱스**에 새 엔트리 + VM 해제. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "저장 구조에서 도출했다"로 들린다.

---

## 한 줄 요약

**PostgreSQL의 인덱스 조회는 ① 인덱스를 훑어 TID 목록을 얻고 ② 그 TID로 힙 페이지를 행마다 읽는 2단계인데, 커버링 인덱스는 쿼리가 쓰는 모든 컬럼이 인덱스 안에 있어 ②(힙 페치 — 행마다 힙에 흩어진 페이지를 찌르는 랜덤 I/O)가 0회가 된 상태(`Index Only Scan`)이고, 그 랜덤 N장이 좁은 리프 N/수백 장으로 바뀌는 것이 "몇 배"의 정체다. 단 PostgreSQL에서는 인덱스가 가시성을 모르므로 그 0은 visibility map이 "전부 가시"로 표시한 페이지에서만 성립한다 — `Heap Fetches`가 크면 인덱스 설계가 아니라 VACUUM 문제다. 효과는 "많이·좁게·자주·세기·정렬" 쿼리에서 크고, 대가는 폭·쓰기(실은 컬럼 UPDATE마다 HOT 탈락 → 모든 인덱스 갱신)·취약·상한이며, PK도 공짜가 아니니 `INCLUDE`로 명시한다. 깨짐은 프로젝션 · EXPLAIN 단정 테스트 · 마이그레이션 주석 · `pg_stat_statements` 호출당 블록 수 알림이 잡게 한다.**
