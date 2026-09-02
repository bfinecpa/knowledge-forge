# `LIKE '%kw%'`와 검색 전환 기준 — 인덱스는 "왼쪽부터 정렬된 사전"이라 중간 일치는 시작점이 없다

> 핵심 관전 포인트: **B-tree 인덱스는 문자열을 첫 글자부터 정렬해 둔 사전이다. `LIKE '나무%'`는 "나무"로 시작하는 첫 장을 펼쳐 연속 구간 하나만 읽으면 되지만, `LIKE '%나무%'`는 첫 글자를 모르니 트리를 내려갈 시작점을 찍을 수 없다 — 사전에서 "…나무"로 끝나는 단어를 찾으려면 첫 장부터 끝 장까지 넘겨야 하는 것과 같다. 그래서 PostgreSQL 계획은 `Seq Scan` + `Filter` + `Sort`이고, 비용은 행 수에 선형이다: 힙 페이지 전부 순차 읽기 + 행마다 패턴 매칭(CPU) + 정렬, 이게 QPS만큼 곱해져 커넥션(= 백엔드 프로세스) 점유 시간이 늘고 풀이 마르면 검색과 무관한 기능까지 번진다. 대응은 네 층위 — ① B-tree 안에서 버티기(접두 일치로 요구 협상 — 단 PG는 collation이 `C`가 아니면 접두 LIKE조차 인덱스를 안 타므로 `text_pattern_ops`가 필수 / 역방향·정규화 표현식 인덱스 / 자체 n-gram 토큰 테이블 / 선행 필터로 스캔 폭 축소) ② `pg_trgm` + GIN — 3글자 조각(트라이그램)의 역색인으로 "포함 검색"을 "조각들의 등호 조회"로 바꿔 `LIKE '%kw%'` 문법 그대로 인덱스를 태운다. 대가: 3글자 미만 검색어에 무력, 색인 크기, 쓰기 비용(pending list), 관련도 순위 없음 ③ `tsvector` + GIN 전문 검색 — 단어 단위 검색·가중치·`ts_rank` 랭킹. 대가: 한국어 형태소 분석기 미내장(`simple` 파서는 공백 분리라 조사·붙여쓰기에서 깨진다) ④ 검색 엔진(Elasticsearch) — 형태소·오타·동의어·관련도·패싯·부하 격리가 필요할 때. 진짜 대가는 인프라가 아니라 색인이 DB 밖에 따로 사는 데서 오는 데이터 동기화와 최종 일관성, 그리고 장애 도메인 추가다. 전환 판단은 감이 아니라 데이터량 · QPS · 일치 유형 · 정확도 요구 · 필터/정렬 결합 · 신선도 · 격리 체크리스트로 하고, "무엇이 넘으면 다음 층위로 간다"를 팀 문서(ADR)에 숫자로 박아 둔다.**

---

## 0. 질문 + 의도

**질문**: "`LIKE '%keyword%'` 검색이 인덱스를 못 타는 이유는? 풀텍스트 인덱스와 검색 엔진(Elasticsearch) 전환은 어떤 기준으로 판단하나요?"

관련 질문: "인덱스를 걸었는데도 풀스캔이 발생하는 경우는 어떤 경우인가요?" (원인 ③으로 LIKE가 등장 — [풀스캔 원인 6종](02-index-not-used-full-scan.md) 3-3절) / "Elasticsearch를 검색에 사용할 때 RDB와의 동기화는 어떻게 하나요? 색인 지연은 어떻게 다루나요?" (12장 NoSQL — `questions/12-nosql.md`)

**출제 의도**: rationale의 표현 그대로 — "중간 일치 검색이 **인덱스 구조상 불가능함**을 알고, **풀텍스트 인덱스로 버틸 수 있는 규모**와 **검색 엔진 도입(운영 비용, 동기화 문제 — 12장)의 문턱**을 판단하는지 — **'검색 기능 추가해주세요'라는 흔한 요구의 숨은 비용을 산정하는 능력**이다." 즉 "LIKE는 인덱스 못 탐"이라는 사실 확인이 아니라, 기획자가 툭 던진 한 줄 요구를 받았을 때 **네 층위(B-tree 우회 / `pg_trgm` / `tsvector` 전문 검색 / 검색 엔진)의 비용과 한계를 양쪽 다 놓고 어디서 멈출지 결정하는 판단 과정**을 말할 수 있는지 본다. PostgreSQL에서 "풀텍스트 인덱스"는 하나가 아니라 둘이다 — 부분 문자열을 찾는 `pg_trgm`과 단어 단위로 찾는 `tsvector` — 그래서 "어느 것으로 얼마나 버티는가"까지가 답이다.

`LIKE '%kw%'`가 풀스캔 원인 중 하나라는 사실은 이미 [풀스캔 원인 6종](02-index-not-used-full-scan.md)에 있으니 여기서는 반복하지 않고, **왜 시작점이 없는가라는 원리**와 **어느 층위에서 멈출지를 정하는 판단**에 지면을 쓴다.

---

## 1. 원리 — 왜 "시작점"이 없는가

### 1-1. 인덱스는 사전이다: 첫 글자부터 정렬돼 있다

[인덱스와 B-tree](01-index-and-bplus-tree.md)에서 정리했듯 B-tree의 리프는 **인덱스 컬럼 값 기준으로 정렬된 (키, TID) 엔트리의 연결 리스트**다. 여기서 TID는 그 값이 든 **힙(테이블 본체) 행의 물리 주소**다.

문자열 컬럼이면 그 정렬 기준은 **첫 글자, 같으면 둘째 글자, 그다음 셋째 글자** — 사전과 정확히 같다. 이 한 문장이 이 문서 전체의 뿌리다. 정렬된 목록 위에 실제 제목을 얹어 보면 왜 그런지가 눈으로 보인다.

```text
idx_webtoons_title 의 리프 — title 값이 첫 글자부터 정렬돼 한 줄로 이어져 있다
(엔트리마다 그 제목이 든 힙 행의 주소 TID 가 함께 들어 있다)

 … │ 나 혼자만 레벨업 │ 나무 위의 집 │ 나무늘보 일기 │ 나쁜 남자 │ … │ 사과나무 아래 │ … │ 헬로 나무 │ …
                       └───────── '나무' 로 시작하는 연속 구간 ─────────┘
                       ↑
                       여기가 시작점(seek 지점)


[질문 A]  LIKE '나무%'   — "나무로 시작하는 제목"
   루트에서 '나무'를 따라 내려가면 위 화살표 자리에 정확히 도착한다.
   거기서 '나무'로 시작하지 않는 값이 나올 때까지 오른쪽으로만 훑으면 끝.
   읽는 양 = 그 연속 구간 하나.

[질문 B]  LIKE '%나무%'  — "나무가 어디든 들어 있는 제목"
   '나무'가 들어간 제목은 '나…'에도, '사…'에도, '헬…'에도 흩어져 있다.
        나무 위의 집 / 사과나무 아래 / 헬로 나무   ← 첫 글자가 전부 다르다
   정렬 기준이 첫 글자인데 첫 글자를 모르니, 루트에서 어느 쪽으로 내려갈지 정할 수 없다.
   = 시작점을 찍을 수 없다 = 리프를 처음부터 끝까지 다 훑는 수밖에 없다.
```

핵심은 "인덱스가 검색을 못 한다"가 아니라 **"정렬 기준과 검색 조건이 어긋난다"**는 것이다. B-tree가 빠른 이유는 오직 하나 — 값이 정렬돼 있어서 **볼 필요 없는 구간을 통째로 건너뛸 수 있기** 때문이다. 첫 글자를 모르면 건너뛸 근거가 사라지고, 정렬은 아무 도움이 안 된다.

> **사전 비유** — "나무로 시작하는 단어"는 ㄴ 항목을 펴고 '나무' 페이지로 바로 간다. 그런데 **"…나무로 끝나는 단어"**(사과나무, 소나무, 참나무)는? 사전은 끝 글자로 정렬돼 있지 않으니 **첫 장부터 끝 장까지 한 단어씩 확인**하는 수밖에 없다. 국어사전에 "역순 사전"(단어를 뒤집어 정렬한 사전)이 따로 존재하는 이유가 바로 이것이고, 2-2의 "역방향 표현식 인덱스" 우회는 그 역순 사전을 DB에 만드는 것이다.

### 1-2. 정확히 말하면 "인덱스를 못 쓴다"가 아니라 "인덱스로 **탐색(seek)** 을 못 한다"

면접에서 한 단계 정밀하게 말할 지점이다. 용어를 먼저 갈라 두자.

- **탐색(seek)** — 정렬을 이용해 **시작점으로 곧장 내려간 뒤 필요한 구간만** 읽는 것. B-tree의 존재 이유.
- **훑기(scan)** — 처음부터 끝까지 **전부** 읽으며 하나씩 조건에 맞는지 확인하는 것.

`LIKE '%kw%'`도 **인덱스를 읽을 수는 있다**. 조회 컬럼이 인덱스 안에 다 있으면(커버링) 플래너는 힙 대신 **인덱스 전체를 순서대로 훑는** 쪽을 고를 수 있다 — 인덱스가 힙보다 작으면 훑는 양이 줄기 때문이다. PostgreSQL에는 "인덱스 풀스캔"이라는 별도 노드가 없고, **`Index Cond` 없이 `Filter`만 붙은 `Index Only Scan`**이 그 모습이다.

```sql
-- (title, id) 인덱스가 있고 SELECT 컬럼이 id, title 뿐이면
SELECT id, title FROM webtoons WHERE title LIKE '%나무%';
```

```text
 Index Only Scan using idx_webtoons_title_id on webtoons  (actual rows=312 loops=1)
   Filter: (title ~~ '%나무%'::text)      ← Index Cond가 없다 = 시작점 없이 인덱스 전체를 순서대로 훑었다
   Rows Removed by Filter: 499688         ← 50만 엔트리를 읽고 거의 다 버림
   Heap Fetches: 0                        ← visibility map 덕에 힙은 안 갔다 (09 문서)
   Buffers: shared hit=2731               ← 인덱스 페이지 전부
```

플래너가 이 계획을 고르는 조건은 "인덱스 페이지 수 < 힙 페이지 수"이고 힙 방문 없이 끝날 만큼 visibility map이 신선할 때다([커버링 인덱스](09-covering-index.md)).

즉 **"타냐 못 타냐"가 아니라 "seek이냐 scan이냐"** 가 본질이고, `%kw%`는 seek이 구조적으로 불가능하다. 커버링으로 얻는 건 **상수배 개선**이지 **선형을 로그로 바꾸는 개선이 아니다**. 데이터가 10배 되면 여전히 10배 느려진다.

> **MySQL 대조**: 같은 상황이 MySQL에서는 `type: index`, `Extra: Using where; Using index`로 찍힌다. 표기만 다르고 뜻은 같다 — "인덱스를 읽긴 했으나 시작점은 못 찍었다".

### 1-3. 비용 사슬 — 풀스캔은 데이터 증가에 **선형**이다

"느려진다", "부하가 온다"에서 멈추면 절반이다. 단계마다 이름을 붙여 사슬로 말해야 "왜 지금은 안 느린데 나중에 장애가 되는가"까지 설명할 수 있다.

```text
LIKE '%kw%' 한 번의 비용 (행 수 N) — 계획: Limit ← Sort ← Seq Scan(Filter)
  ① 힙 페이지 전부 읽기               — 순차 I/O. 페이지 수 ∝ N.
     (shared_buffers·OS 페이지 캐시에 다 올라가 있으면 메모리 스캔, 넘치면 디스크)
  ② 행마다 문자열 패턴 매칭            — CPU. (평균 문자열 길이) × N.
     계획에는 Filter: (title ~~ '%나무%') + Rows Removed by Filter ≈ N 으로 찍힌다
  ③ 통과한 행을 정렬                   — Sort 노드. 인덱스 정렬 순서를 못 쓴다
     (시작점 없이 훑었으니 결과가 view_count 순일 리 없다)
  ④ LIMIT 20이어도 ①~③은 끝까지       — 상위 20개를 알려면 전부 봐야 한다
     (Sort Method: top-N heapsort 로 메모리는 아끼지만 입력은 N 그대로)
  ──────────────────────────────────────────────────────────────
  한 건당 응답 시간 ∝ N
  × QPS  ⇒  동시에 점유되는 커넥션 수 ∝ N × QPS       (리틀의 법칙)
  ⇒ PG의 커넥션은 프로세스 하나 — 풀 고갈 → 검색과 무관한 결제·조회수 갱신·
    에피소드 조회가 커넥션 대기 ⇒ 장애 반경이 "검색 느림"에서 "서비스 전체 지연"으로
  부수 효과 1: 테이블이 크면 Parallel Seq Scan — 워커 프로세스가 나눠 훑어 응답은
    줄지만 CPU 총소모는 같고, 검색 QPS × 워커 수만큼 CPU를 뺏는다(격리 문제 악화)
  부수 효과 2: 캐시 오염 — PG는 shared_buffers의 1/4보다 큰 테이블의 순차 스캔을
    작은 링 버퍼(256KB)로 읽어 shared_buffers의 뜨거운 페이지를 지키지만, OS 페이지
    캐시는 그대로 밀려나고 I/O·CPU 소모 자체는 하나도 줄지 않는다
```

```text
EXPLAIN (ANALYZE, BUFFERS) — 50만 건 테이블에서의 실제 모습
 Limit  (actual rows=20 loops=1)
   ->  Sort  (actual rows=20 loops=1)
         Sort Key: view_count DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Seq Scan on webtoons  (actual rows=312 loops=1)
               Filter: (title ~~ '%나무%'::text)
               Rows Removed by Filter: 499688      ← 50만 행을 읽고 거의 다 버렸다
               Buffers: shared hit=9821            ← 테이블 페이지 전부
```

**"지금은 빠른데요?"의 함정**: 작품 테이블이 5천 건이면 페이지 수십 장, 전부 캐시 안이라 `%kw%`도 수 ms다. 문제는 이 비용이 **N에 선형**이라 **조용히 자란다**는 것이다.

5천 건에서 5ms면, 100배인 50만 건에서 500ms, 1만 배인 5천만 건(댓글·에피소드 규모)에서 50초다. 그리고 그 사이 어느 날 — 배포도 없이 — 임계를 넘는다. 이게 4장 뒤쪽 ["배포 없었는데 DB CPU가 올랐다"](22-db-cpu-spike-without-deployment.md) 문항의 전형적 정답 중 하나(**데이터 증가 자체가 변경**)다.

검색 기능의 진짜 비용은 **오늘의 응답 시간이 아니라 기울기**로 산정해야 한다. 커넥션 점유 → 풀 고갈 사슬의 자세한 메커니즘은 [커넥션 수와 처리량](15-connection-count-vs-throughput.md)에 있다.

### 1-4. 그럼 `LIKE 'kw%'`는 왜 타는가 — 그리고 PostgreSQL에서 그마저 안 타는 네 경우

접두 일치는 플래너가 **범위 조건**으로 바꿔 처리한다: `title LIKE '나무%'` ≡ `title >= '나무' AND title < '나묵'` ('나묵'은 '나무'의 마지막 글자를 하나 올린 값 — 플래너가 계산한다). 시작점과 끝점이 있으니 seek 후 연속 구간 하나다.

그런데 이 변환이 성립하려면 **인덱스의 정렬 순서에서 "같은 접두사를 가진 문자열이 연속 구간을 이룬다"**가 보장돼야 한다. PostgreSQL의 함정이 정확히 여기 있다.

**① collation — PG 고유이자 가장 먼저 만나는 함정.** collation(콜레이션)은 **문자열을 어떤 순서로 정렬할지 정하는 규칙**이다. DB 기본 collation이 `en_US.UTF-8`·`ko_KR.UTF-8` 같은 로케일 collation이면(대부분의 관리형 PG가 그렇다. `SHOW lc_collate`로 확인) 정렬이 바이트 순이 아니라 로케일 규칙(공백·기호·대소문자를 뒤 단계에서 비교하는 등)을 따른다.

그 순서에서는 접두사 연속성이 보장되지 않으므로 플래너는 **변환을 아예 하지 않는다** — 일반 B-tree는 접두 LIKE에도 `Seq Scan`이다. 해결은 `text_pattern_ops` 연산자 클래스(바이트 단위 비교 인덱스, **쿼리 수정 없음**) 또는 컬럼/DB 자체를 `COLLATE "C"`로. 대가: `text_pattern_ops` 인덱스는 `<`·`>`·`ORDER BY title` 같은 일반 비교에는 못 쓰인다(등호는 된다) → 둘 다 필요하면 인덱스 둘.

```sql
-- before: 기본 collation 컬럼의 일반 B-tree — 접두 LIKE인데도 안 탄다
CREATE INDEX idx_webtoons_title ON webtoons (title);
EXPLAIN SELECT id, title FROM webtoons WHERE title LIKE '나무%';
--  Seq Scan on webtoons
--    Filter: (title ~~ '나무%'::text)

-- after: text_pattern_ops — 바이트 순 비교 → 접두 LIKE를 범위 조건으로 변환한다
CREATE INDEX idx_webtoons_title_pattern ON webtoons (title text_pattern_ops);
--  Index Scan using idx_webtoons_title_pattern on webtoons
--    Index Cond: ((title ~>=~ '나무'::text) AND (title ~<~ '나묵'::text))   ← 범위로 바뀐 접두 조건
--    Filter: (title ~~ '나무%'::text)                                         ← 원래 LIKE는 재확인용으로 남는다
```

> **MySQL 대조**: MySQL은 일반 인덱스로 접두 LIKE가 바로 `type: range`다. MySQL에서 옮겨온 팀이 "인덱스 걸었는데 LIKE가 안 탄다"로 처음 부딪히는 것이 대개 이 collation 함정이다.

나머지 셋은 [풀스캔 원인 6종](02-index-not-used-full-scan.md)에서 도출되는 것들이다.

```sql
-- ② 컬럼에 함수 / ILIKE: 대소문자 무시하려고 씌운 lower()는 원본 값이 정렬된 인덱스와 무관하고,
--    ILIKE는 text_pattern_ops 인덱스로도 B-tree 탐색이 불가능하다
-- before
SELECT * FROM webtoons WHERE lower(title) LIKE 'solo%';
SELECT * FROM webtoons WHERE title ILIKE 'solo%';
-- after: PG의 정석은 표현식 인덱스 — "함수를 WHERE가 아니라 인덱스 쪽에 미리 적용"한다 (2-2 우회 ③)
CREATE INDEX idx_webtoons_title_lower ON webtoons (lower(title) text_pattern_ops);
SELECT * FROM webtoons WHERE lower(title) LIKE lower('Solo') || '%';

-- ③ 낮은 선택도: '가%'가 전체 30%면 플래너가 Seq Scan을 고른다 — 옳은 판단이다.
--    인덱스로 300만 행의 TID를 얻어 힙을 랜덤 접근하느니 순차로 훑는 게 싸다
SELECT * FROM webtoons WHERE title LIKE '가%';

-- ④ 코드는 접두처럼 보이는데 실행은 중간 일치: 사용자 입력에 %가 섞여 들어옴
--    keyword = "%나무" → 'title LIKE ?' 바인딩 값이 '%나무%'가 된다
String kw = request.getKeyword();               // "%나무"
query.setParameter("kw", kw + "%");             // → '%나무%'  ← 접두 일치가 깨짐
// 대응: %, _, \ 를 이스케이프하거나 제거하고 바인딩한다 (LIKE 와일드카드 인젝션 방지)
```

**준비문과 제네릭 계획 (가산점 포인트)**: 접두 LIKE의 범위 변환은 **패턴 상수를 계획 시점에 알아야** 상한('나묵')을 만들 수 있다. pgjdbc가 반복 실행 문장을 서버 준비문으로 바꾸고 서버가 제네릭 계획으로 넘어가면 패턴이 `$1`이라 변환이 불가능하다 — 다행히 플래너가 제네릭(Seq Scan) 비용이 커스텀 계획보다 훨씬 크다고 보고 대개 커스텀을 유지하지만, 잘 타던 접두 검색이 어느 날 Seq Scan으로 급변했다면 이 축을 의심하고 `plan_cache_mode = force_custom_plan`으로 고정한다([실행 계획 급변](31-execution-plan-sudden-change.md)).

---

## 2. 네 층위의 해법 — B-tree 우회부터 검색 엔진까지

### 2-1. 층위를 나누는 축 — "무엇을 색인의 단위로 삼는가"

네 층위를 그냥 "약한 것부터 센 것" 순서로 외우면 왜 그 순서인지가 안 남는다. 층위를 가르는 축은 하나다 — **인덱스에 무엇을 키로 넣는가.**

```text
층위 ①  키 = 값 전체 (그대로)                     … B-tree
        "나무 위의 집" 이라는 값 하나가 키 하나.
        정렬로 구간을 건너뛴다 → 접두 일치만 seek 가능. 중간 일치는 원리상 불가.
              ↓ 값을 쪼개서 넣으면?
층위 ②  키 = 3글자 조각 (트라이그램)               … pg_trgm + GIN
        "사과나무" → '사과나', '과나무' … 조각마다 그 조각을 가진 행 목록.
        검색어도 같은 방식으로 쪼개 조각을 등호로 찾는다 → 중간 일치가 seek 이 된다.
              ↓ 조각이 아니라 의미 단위로 쪼개면?
층위 ③  키 = 단어(lexeme)                          … tsvector + GIN
        문장을 단어로 자르고 어간·불용어를 정리해 넣는다.
        불리언 질의·가중치·관련도 순위가 생긴다. 대신 "단어를 어떻게 자르나"가 언어 문제가 된다.
              ↓ 단어 자르기·오타·동의어·랭킹을 제대로 하려면?
층위 ④  키 = 전용 검색 엔진이 정하는 모든 것         … Elasticsearch
        형태소 분석·동의어·오타 허용·부스팅·패싯. 대신 색인이 DB 밖에 따로 산다.
```

층위가 올라갈수록 **"검색이 잘 되는 정도"가 아니라 "값을 얼마나 잘게, 얼마나 똑똑하게 쪼개는가"** 가 올라간다. 그리고 쪼갤수록 색인이 커지고, 쪼개는 규칙이 원본과 따로 관리돼야 하며, ④에서는 아예 다른 시스템으로 나간다. **비용은 정확히 이 "따로 관리해야 하는 정도"에 비례한다** — 이것이 3장 체크리스트의 뿌리다.

### 2-2. 층위 ① — B-tree 안에서 버티는 우회 5가지

"pg_trgm이나 ES로 가야죠"로 바로 점프하면 **중간 선택지가 없는 사람**으로 보인다. 도구를 바꾸기 전에 B-tree 안에서 할 수 있는 다섯 가지를 **번호로** 꺼내고, 각각 "어떤 요구까지 커버하고 무엇을 못 하는지"를 붙인다. 기억 고리: **협상 · 역순 · 정규화 · 토큰 · 선행필터**.

| # | 우회 | 커버하는 요구 | 대가 / 한계 |
|---|---|---|---|
| ① | **요구를 접두 일치로 협상** (+ `text_pattern_ops`) | 자동완성, "작품명이 ~로 시작" | UX 변경을 기획과 합의해야 함. 그 인덱스는 `ORDER BY title`엔 못 씀 |
| ② | **역방향 표현식 인덱스** `reverse(title)` | 접미 일치(`%나무`) | 인덱스 하나 추가, 쿼리가 같은 식을 써야 함, 중간 일치는 여전히 불가 |
| ③ | **정규화 표현식 인덱스 / 생성 컬럼** | 공백·대소문자·특수문자 무시한 접두 일치 | 정규화 규칙을 한 곳에 고정해야 함 |
| ④ | **자체 n-gram 토큰 테이블** | 중간 일치(2글자 검색어 포함) | 쓰기 시 토큰 재생성, 저장량 수 배 — PG에선 `pg_trgm`이 대신하므로 2글자가 핵심일 때만 |
| ⑤ | **선행 필터로 스캔 폭 축소** | 필터 조건이 붙는 중간 일치 | 필터가 좁을 때만 의미, 전역 검색엔 무력 |

#### 우회 ① 요구를 접두 일치로 바꾼다 — 가장 싼 해법은 요구를 바꾸는 것

"작품 검색"이라는 요구의 실제 UX가 **검색창에 타이핑하면 후보가 뜨는 자동완성**이라면, 그건 접두 일치로 충분한 경우가 많다. 기획자에게 "중간 글자로도 찾아야 하나요?"를 **먼저 묻는 것**이 백엔드의 일이다. rationale이 말하는 "요구의 숨은 비용을 산정"의 첫 단계가 바로 **요구를 되묻기**다.

```sql
-- 자동완성: 접두 일치 + 인기순 — text_pattern_ops 인덱스로 seek 후 상위 N만
SELECT id, title FROM webtoons
WHERE title LIKE '나무%'
ORDER BY view_count DESC
LIMIT 10;
--  Limit
--    ->  Sort  Sort Key: view_count DESC  Sort Method: top-N heapsort  Memory: 25kB
--          ->  Index Scan using idx_webtoons_title_pattern on webtoons  (actual rows=38)
--                Index Cond: ((title ~>=~ '나무'::text) AND (title ~<~ '나묵'::text))
--                Filter: (title ~~ '나무%'::text)
-- 구간이 좁으면(38행) Sort 비용도 작다. 구간이 넓은 한 글자 접두('가%')는 최소 2글자부터 검색하도록 UX에서 막는다.
```

#### 우회 ② 역방향 표현식 인덱스 — 역순 사전을 만든다

접미 일치(`%나무`: "…나무"로 끝나는 작품)가 진짜 요구라면 **뒤집은 값에 인덱스를 건다**. 뒤집으면 접미가 접두가 되기 때문이다.

PostgreSQL은 **표현식 인덱스**가 있어 컬럼을 추가하지 않고 "식" 자체에 인덱스를 걸 수 있다 — 즉 "이 컬럼을 정렬해 두겠다"가 아니라 "이 컬럼에 이 함수를 적용한 결과를 정렬해 두겠다"고 선언하는 것이다. 애플리케이션 코드도, 테이블 구조도 바꾸지 않는다.

```sql
-- 역순 사전 — 컬럼 추가 없이 식에 인덱스
CREATE INDEX idx_webtoons_title_rev ON webtoons (reverse(title) text_pattern_ops);

-- "…나무"로 끝나는 작품 = 뒤집으면 "무나…"로 시작하는 작품 → 접두 일치
SELECT id, title FROM webtoons
WHERE reverse(title) LIKE reverse('나무') || '%';
-- reverse('나무') || '%' 는 계획 시점에 '무나%' 상수로 접히므로 범위 변환이 된다
```

한계는 명확하다 — **접두와 접미는 되지만 중간은 여전히 안 된다.** 플래너가 인덱스를 매칭하려면 쿼리가 인덱스 정의와 **글자 하나까지 같은 식**(`reverse(title)`)을 써야 하므로 JPQL로는 못 쓰고 네이티브 쿼리가 된다. 쓰기마다 식을 한 번 더 계산하고 인덱스도 하나 더 유지한다(쓰기 비용). SELECT로 뒤집은 값 자체를 봐야 한다면 생성 컬럼(`GENERATED ALWAYS AS (reverse(title)) STORED`)에 인덱스를 거는 것도 같은 효과다. 접미 검색 요구 자체가 드물어서 실무 빈도는 낮지만, "구조적 한계를 구조로 우회한다"는 사고를 보여주기엔 좋은 예다.

#### 우회 ③ 정규화 표현식 인덱스 — 함수를 WHERE가 아니라 인덱스 쪽에 미리 적용한다

"나 혼자만 레벨업"을 "나혼자만"으로 쳐도 나와야 한다, 영문 대소문자는 무시해야 한다 같은 요구는 **검색 시점에 컬럼에 함수를 씌우면**(1-4 ②) 인덱스가 죽는다. 인덱스는 원본 값을 정렬해 둔 것인데, 검색은 가공한 값을 찾으니 정렬이 쓸모없어지기 때문이다.

대신 **정규화한 식에 인덱스를 걸고, 조회도 같은 식으로 한다** — 원인 ①(컬럼에 함수)의 정석 해법을 검색에 적용한 것이다.

```sql
-- 공백 제거 + 소문자화한 식에 인덱스
CREATE INDEX idx_webtoons_title_norm
  ON webtoons (lower(replace(title, ' ', '')) text_pattern_ops);

-- 검색어도 SQL 안에서 같은 식으로 정규화 → 규칙이 DB 한 곳에만 존재한다
SELECT id, title FROM webtoons
WHERE lower(replace(title, ' ', '')) LIKE lower(replace($1, ' ', '')) || '%';
```

ORM에서 이 식을 쓰기 불편하거나 정규화된 값을 화면에도 써야 하면 **생성 컬럼**(PG 12+)으로 실체화하고 거기에 인덱스를 건다.

```sql
ALTER TABLE webtoons
  ADD COLUMN title_norm text GENERATED ALWAYS AS (lower(replace(title, ' ', ''))) STORED;
CREATE INDEX idx_webtoons_title_norm ON webtoons (title_norm text_pattern_ops);
```

**대가**: 앱에서 검색어를 전처리하는 순간 정규화 규칙이 DB(식)와 애플리케이션(검색어 전처리) **두 곳에 존재**한다. 한쪽만 바꾸면 조용히 검색이 안 된다 — 위 예처럼 검색어도 SQL 식으로 정규화해 규칙을 DB 한 곳에 두거나, 통합 테스트에 "정규화 규칙 일치"를 박아 둔다(3-3).

#### 우회 ④ 자체 n-gram 토큰 테이블 — 역색인을 손으로 만든다

중간 일치가 꼭 필요한데 확장을 설치할 수 없는 환경이거나, **2글자 검색어가 핵심**이라면(2-3의 `pg_trgm`은 3글자 조각이라 2글자 검색어에 무력하다), **제목을 2글자 조각(bigram)으로 쪼개 별도 테이블에 저장**하고 검색어도 같은 방식으로 쪼개 **등호 조회의 교집합**으로 찾는다.

이것이 2-3의 `pg_trgm` GIN이 내부에서 하는 일의 축소판이라 원리 이해에도 좋다 — 손으로 한 번 만들어 보면 확장이 무엇을 대신해 주는지가 분명해진다.

```sql
-- 토큰 테이블: token 기준 정렬(PK) → 등호 조회는 seek
CREATE TABLE webtoon_title_tokens (
  token      text   NOT NULL,      -- 2글자 조각
  webtoon_id bigint NOT NULL REFERENCES webtoons (id),
  PRIMARY KEY (token, webtoon_id)
);
-- "사과나무 아래"(id=7) 저장 시 → ('사과',7) ('과나',7) ('나무',7) ('무아',7)* ('아래',7)
--   * 공백 처리 규칙은 정규화 식과 마찬가지로 한 곳에 고정

-- 검색어 "과나무" → 토큰 '과나', '나무' 를 모두 가진 작품
SELECT webtoon_id
FROM webtoon_title_tokens
WHERE token IN ('과나', '나무')            -- 두 개의 짧은 등호 구간 (seek)
GROUP BY webtoon_id
HAVING count(DISTINCT token) = 2;          -- 집계 후 필터 = HAVING (07-where-vs-having.md)
```

**대가를 양면으로 말한다.** 얻는 것: 중간 일치가 seek이 되고, 어떤 RDB에서도 되며, 2글자도 된다.

치르는 것 셋. ⑴ 제목 한 번 바꾸면 토큰 행을 지우고 다시 넣어야 한다 — 이걸 **같은 트랜잭션에서** 하지 않으면 검색 결과와 실제 제목이 어긋난다(반정규화의 갱신 정합성 문제와 같은 뿌리. PG라면 트리거로 묶는 것이 정석). ⑵ 저장량은 제목 길이만큼 행이 생겨 **수 배**다. ⑶ bigram 교집합은 **순서를 보장하지 않는다** — '과나'와 '나무'를 둘 다 가졌지만 "나무과나"인 제목도 매치되므로, 후보 id로 원본 행을 읽어 `LIKE '%과나무%'`로 **2차 검증**해야 한다(후보가 이미 좁으니 이 LIKE는 싸다).

2-3에서 보겠지만 `pg_trgm`은 **이 2차 검증까지 `Recheck Cond`로 자동 수행**한다 — 이 정도 손이 가기 시작하면 "확장이 이걸 대신 해 준다"로 넘어갈 시점이다.

#### 우회 ⑤ 선행 필터로 스캔 폭을 줄인다 — LIKE를 액세스 조건이 아니라 필터 조건으로 격하

검색이 항상 **다른 좁은 조건과 함께** 온다면(장르 페이지 안에서 검색, 특정 작가의 작품 중 검색), 그 조건을 선두로 한 복합 인덱스로 **구간을 먼저 좁히고** 그 안에서 LIKE는 필터로만 쓴다. [복합 인덱스 컬럼 순서](08-composite-index-column-order.md)의 "뒤 컬럼은 탐색용이 아니라 제거용" 원칙 그대로다.

```sql
CREATE INDEX idx_webtoons_author_title ON webtoons (author_id, title);

-- author_id 등호로 seek → 그 작가의 작품 수십 건 안에서만 LIKE 평가
SELECT id, title FROM webtoons
WHERE author_id = 1024 AND title LIKE '%나무%';
--  Index Scan using idx_webtoons_author_title on webtoons  (actual rows=3)
--    Index Cond: (author_id = 1024)               ← 구간을 좁힌 조건
--    Filter: (title ~~ '%나무%'::text)             ← 좁힌 구간 안에서 제거용
--    Rows Removed by Filter: 41
```

한계: **전역 검색에는 무력하다.** `genre = 'ROMANCE'`처럼 전체의 30%를 남기는 필터는 스캔 폭을 별로 줄이지 못한다. "필터가 충분히 좁을 때만"이라는 조건을 반드시 붙여 말한다.

### 2-3. 층위 ② — `pg_trgm` + GIN: 포함 검색을 "조각들의 등호 조회"로 바꾼다

이 문서의 전환점이다. 여기서 문제의 **모양 자체가 바뀐다.**

#### 먼저 GIN — 값 하나가 키를 여럿 갖는 경우를 위한 인덱스

B-tree는 **"행 하나 = 키 하나"**를 전제한다. `title`이 "사과나무 아래"인 행은 그 문자열 하나를 키로 갖고, 그 키로 정렬된다. 그래서 정렬 기준과 검색 조건이 어긋나면(1-1) 손쓸 방법이 없다.

**역색인(inverted index)** 은 전제를 뒤집는다 — **"행 하나가 키를 여러 개 가질 수 있다"**고 보고, **키마다 그 키를 가진 행들의 목록**을 매단다. 책 뒤 찾아보기 페이지에서 "나무 …… 12, 87, 203쪽"을 보고 바로 그 쪽으로 가는 것과 같다. "색인 → 본문"이 아니라 "본문의 조각 → 그 조각이 나오는 위치"라 **거꾸로 된 색인**이라는 이름이 붙었다.

PostgreSQL에서 이 구조를 구현한 인덱스 종류가 **GIN**(Generalized Inverted iNdex, 일반화된 역색인)이다. "일반화"라는 말이 붙은 이유는 **"값을 어떻게 여러 키로 쪼갤 것인가"를 GIN 자신이 정하지 않기 때문**이다. 쪼개는 방법은 연산자 클래스가 가르쳐 준다 — 배열이면 원소로, `jsonb`면 키·값으로, 그리고 문자열이면 `pg_trgm`이 "3글자씩"을 가르쳐 준다.

여기서 결정적인 변화가 일어난다. 값을 **미리 조각으로 쪼개** 저장해 두면, 검색어가 값의 **어느 위치에 있든** 조각 하나를 등호로 찾으면 된다. **"중간 일치"라는 문제 자체가 "조각들의 등호 조회"로 바뀌어 사라진다.**

#### 어떻게 쪼개나 — 트라이그램(3글자 조각)

`pg_trgm`은 문자열을 **3글자씩 한 칸씩 밀며** 잘라 낸다. 이 3글자 조각을 **트라이그램(trigram)** 이라 부른다. 자르기 전에 단어 앞에 공백 2개, 뒤에 공백 1개를 붙이는데, 이 패딩 덕분에 **"단어의 시작"과 "단어의 끝"이라는 정보까지 조각에 담긴다.**

```text
'search' 를 자르는 과정
  1) 패딩:  "  search "        앞에 공백 2개, 뒤에 공백 1개 → 길이 9
  2) 길이 3짜리 창을 한 칸씩 밀며 잘라 낸다 → 조각 수 = 9 - 3 + 1 = 7개

     자리 1~3 : '  s'     ← 앞 공백 2개가 붙어 "단어가 s 로 시작한다"는 뜻을 담는다
     자리 2~4 : ' se'
     자리 3~5 : 'sea'
     자리 4~6 : 'ear'
     자리 5~7 : 'arc'
     자리 6~8 : 'rch'
     자리 7~9 : 'ch '     ← 뒤 공백이 붙어 "단어가 ch 로 끝난다"는 뜻을 담는다

  SELECT show_trgm('search'); 를 실행하면 이 7개가 배열로 나온다
```

한글도 똑같다. 글자 단위로 자를 뿐 언어를 모른다.

```text
문서                              GIN (pg_trgm) — 트라이그램 → 그 조각이 든 행의 TID 목록
 1: 나무 위의 집                   "  나"  → [1, 2]
 2: 나무늘보 일기                  " 나무" → [1, 2]
 7: 사과나무 아래                  "나무 " → [1, 7]
                                   "무늘보" → [2]
                                   "사과나" → [7]
                                   "과나무" → [7]

('사과나무'를 자르면 "  사", " 사과", "사과나", "과나무", "나무 " 다섯 조각)

검색: title LIKE '%사과나무%'
  1) 검색어에서 조각을 뽑는다 → '사과나', '과나무' (양쪽이 %라 패딩 조각은 못 쓴다)
  2) 두 조각의 행 목록을 GIN 에서 등호로 찾아 교집합 → [7]
  3) 후보 [7] 의 원본을 읽어 정말 '사과나무'를 포함하는지 다시 확인 (Recheck)
```

핵심은 **"어떻게 자르느냐"가 검색 품질의 전부**라는 점이고, 트라이그램은 의미와 무관하게 글자 3개씩 겹쳐 자른다 — 그래서 언어를 몰라도 되고, 대신 아래의 한계가 생긴다.

#### 사용법 — 쿼리는 LIKE 그대로, 인덱스만 붙인다

```sql
-- 확장 + GIN 인덱스 (운영 테이블이면 CONCURRENTLY — 14 문서)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_webtoons_title_trgm  ON webtoons USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY idx_webtoons_author_trgm ON webtoons USING gin (author_name gin_trgm_ops);

-- 쿼리는 그대로 — LIKE / ILIKE / 정규식(~, ~*) 전부 이 인덱스를 탄다. 애플리케이션 코드 수정 없음
SELECT id, title FROM webtoons WHERE title LIKE '%사과나무%';
```

```text
 Bitmap Heap Scan on webtoons  (actual rows=4 loops=1)
   Recheck Cond: (title ~~ '%사과나무%'::text)   ← 조각 교집합 후보를 원문으로 2차 검증 (우회 ④의 "나무과나" 문제를 자동 처리)
   Rows Removed by Index Recheck: 1
   Heap Blocks: exact=5
   ->  Bitmap Index Scan on idx_webtoons_title_trgm  (actual rows=5 loops=1)
         Index Cond: (title ~~ '%사과나무%'::text)  ← 패턴에서 뽑은 '사과나','과나무'를 가진 행의 TID 비트맵
```

GIN은 **항상 비트맵 스캔**으로만 읽힌다(TID 목록을 모아 정렬한 뒤 힙을 순차 접근). `LIKE '%사과나무%'`가 N에 선형이었다면 이건 **조각 '사과나'·'과나무'의 행 목록 길이에 비례**한다 — 전체 N이 아니라 **해당 조각이 든 행 수**다. 선형이 사라진 자리가 여기다.

같은 인덱스로 **유사도 검색**도 된다 — 정확히 포함하지 않아도 공유하는 트라이그램 비율로 "비슷한" 값을 찾는다.

```sql
-- 유사도: % 연산자 (임계값 pg_trgm.similarity_threshold, 기본 0.3). 오타를 일부 흡수한다
SELECT id, title, similarity(title, '사과나무') AS sim
FROM webtoons
WHERE title % '사과나무'
ORDER BY sim DESC
LIMIT 20;

-- "가장 비슷한 N개"를 인덱스로 바로 뽑으려면 GiST + <-> (KNN 정렬). GIN은 정렬을 못 돕는다
CREATE INDEX idx_webtoons_title_trgm_gist ON webtoons USING gist (title gist_trgm_ops);
SELECT id, title FROM webtoons ORDER BY title <-> '사과나무' LIMIT 20;
```

GIN은 조회가 빠르고 GiST는 구축·갱신이 가볍고 `<->` 정렬을 인덱스로 처리한다 — "포함 여부"만 필요하면 GIN, "비슷한 순서로 N개"가 필요하면 GiST다.

#### 한국어와 트라이그램 — 되는 것과 막히는 것

트라이그램은 **부분 문자열 일치**라 한국어에서 오히려 편한 점이 있다. "나무를"·"나무가"·"나무에서"에 '나무'가 그대로 들어 있으니 **조사 문제가 자연히 사라지고**, "나혼자만레벨업"처럼 띄어쓰기 없는 제목도 '레벨업'으로 찾는다. 대소문자는 기본으로 무시한다(`ILIKE`도 같은 인덱스).

막히는 곳도 같은 호흡으로 말한다.

- **3글자 미만 검색어에 무력하다 — 한국어에서 가장 아픈 한계.** `LIKE '%나무%'`는 패턴에서 뽑을 트라이그램이 하나도 없다(양쪽이 와일드카드라 공백 패딩도 못 붙이고, 2글자로는 3글자 조각이 안 나온다). GIN은 좁힐 조각이 없으니 **전 인덱스를 훑어 후보를 다 돌려주고 전부 recheck**한다 — Seq Scan과 다를 게 없다. 한국어 검색어의 상당수가 2글자라는 것이 문제다. 대응: 3글자 미만은 접두 인덱스 경로(자동완성)로 보내기 / UX에서 최소 글자 수 / 우회 ④의 수제 bigram 테이블 / 2글자 조각을 쓰는 `pg_bigm` 확장(CJK용으로 만들어진 것 — 이름만 알아 둔다).
- **의미를 모른다** — '과나' 같은 무의미 조각도 전부 색인한다 → **색인 크기가 텍스트 길이에 비례해 크게 불어난다**(단어 단위 색인 대비 수 배).
- **관련도 순위가 없다** — LIKE 결과는 "포함 여부"뿐이라 순서는 `view_count` 같은 다른 컬럼으로 정한다. `similarity()`로 정렬하면 후보 전체에 값을 계산한 뒤 `Sort`다(GiST `<->`는 "가장 비슷한 N개"만 인덱스로). "인기 작품을 위로", "최근 작품에 가중치" 같은 **부스팅을 조합할 수단이 없다.**
- **형태소 분석이 없다** — "달리기"와 "달렸다"를 같은 단어로 묶지 못한다. 동의어("웹툰"과 "만화"), 초성 검색(ㄴㅁ)은 아예 영역 밖이다. 오타("나무우")는 `%` 유사도로 일부 흡수되지만, 공유 조각 비율이라 짧은 단어에선 거의 무력하다.

> **MySQL 대조**: InnoDB FULLTEXT의 ngram 파서는 `ngram_token_size` 기본 2 — 2글자 검색어가 되는 대신 색인이 더 크고 `MATCH ... AGAINST` 전용 문법을 써야 한다. PG 트라이그램은 3글자라 **한국어 2글자 검색어에서 뚜렷이 불리**하고, 대신 LIKE 문법 그대로 인덱스가 붙는다.

#### `pg_trgm`의 대가 — 쓰기 · 크기 · 결합 · 범위

"pg_trgm 걸면 됩니다"로 끝내면 한쪽 면만 본 것이다. 얻는 것(중간 일치가 조각 조회로)과 **치르는 것 네 가지**를 한 호흡에 붙인다.

1. **쓰기 비용** — 행 하나 INSERT/UPDATE에 트라이그램 수만큼 GIN 항목이 생긴다. PG의 GIN은 이를 곧바로 트리에 꽂지 않고 **pending list**(대기 목록)에 쌓았다가(`fastupdate`, 기본 on) 한도(`gin_pending_list_limit`, 기본 4MB)를 넘거나 (auto)VACUUM이 돌 때 본 트리에 병합한다 — 조각이 많으니 매번 트리에 꽂으면 쓰기가 너무 느려지기 때문에 둔 완충 장치다. 그 사이 **검색은 pending list까지 훑어야 하므로** 갱신 폭주 뒤 검색이 느려졌다가 VACUUM 후 회복하는 톱니 패턴이 생긴다(`gin_clean_pending_list()`로 수동 병합 가능). 반영 시점은 일반 인덱스와 같아 **같은 트랜잭션에서 방금 넣은 행도 바로 검색된다.** 그리고 `title` 갱신은 인덱스 컬럼 변경이라 HOT에서 탈락 → **그 테이블의 모든 인덱스**에 새 엔트리를 꽂는다([08 문서 §2-5](08-composite-index-column-order.md)). (가산점 포인트)
2. **크기** — 제목 20자면 트라이그램도 20개 남짓 생긴다. 작가명·줄거리까지 넣으면 **원본 컬럼보다 인덱스가 커지는 경우가 흔하다** → `pg_size_pretty(pg_relation_size('idx_webtoons_title_trgm'))`로 실측하고, `shared_buffers` 경쟁을 감안한다.
3. **필터·정렬과의 결합** — 필터는 PG가 잘 결합한다: `BitmapAnd`로 GIN 후보와 B-tree 후보의 교집합을 인덱스 단계에서 만든다. 문제는 **정렬**이다. `ORDER BY view_count DESC LIMIT 20`은 후보 전부를 `Sort`에 넣어야 하므로 흔한 단어의 후보가 수십만이면 여기서 다시 느려진다.

   ```sql
   -- 검색 + 장르 필터 + 인기순
   SELECT id, title FROM webtoons
   WHERE title LIKE '%레벨업%' AND genre = 'ROMANCE'
   ORDER BY view_count DESC LIMIT 20;
   ```
   ```text
    Limit
      ->  Sort  Sort Key: view_count DESC  Sort Method: top-N heapsort
            ->  Bitmap Heap Scan on webtoons  (actual rows=48213)   ← '레벨업' 후보 전부가 정렬 입력
                  Recheck Cond: ((title ~~ '%레벨업%'::text) AND (genre = 'ROMANCE'::text))
                  ->  BitmapAnd                                      ← 두 인덱스의 후보 비트맵을 교집합
                        ->  Bitmap Index Scan on idx_webtoons_title_trgm
                              Index Cond: (title ~~ '%레벨업%'::text)
                        ->  Bitmap Index Scan on idx_webtoons_genre
                              Index Cond: (genre = 'ROMANCE'::text)
   -- 후보('레벨업' 포함)가 많을수록 Sort 비용이 커진다 — 이게 2-5 "전환 신호 ②"다
   ```

4. **조인 결과에는 못 건다** — 인덱스는 **테이블 하나**의 것이다. 같은 테이블의 여러 컬럼은 컬럼별 인덱스 + `OR`(`BitmapOr`)로 되지만, "작품명 + 작가명 + 태그(별도 테이블) + 줄거리"를 한 번에 검색하려면 검색용 반정규화 컬럼(트리거로 유지)이나 materialized view(`REFRESH MATERIALIZED VIEW CONCURRENTLY` — 신선도 지연)를 만들어 거기에 걸어야 하고, 그 순간 갱신 정합성 문제가 따라온다.

#### `pg_trgm`으로 "버틸 수 있는" 조건 — 어디까지인가

수치는 하드웨어·데이터 형태에 따라 달라 **팀이 실측해야** 하지만, 정성적 경계는 분명하다.

| 조건 | `pg_trgm`으로 버팀 | 다음 층위 신호 |
|---|---|---|
| 대상 | 단일 테이블, 짧은 필드(제목·이름) | 긴 본문·여러 테이블·태그 결합 |
| 검색어 | 3글자 이상 포함 여부 | 2글자가 주력 / 형태소·오타·동의어·초성 품질 |
| 결합 | 필터는 `BitmapAnd`로 가능, 정렬 후보가 작음 | 후보가 커져 `Sort`가 지배, 패싯(장르별 건수) 동시 |
| 규모 | 실측 p99가 목표 안 | 인덱스 크기·pending list가 VACUUM을 앞지름 |
| 신선도 | 커밋 즉시 반영이 필요 | 수 초 지연 허용 가능 |
| 격리 | 검색 트래픽이 OLTP에 묻힘 | 검색 스파이크가 OLTP를 밀어냄 |

웹툰 플랫폼의 **작품명·작가명 검색**은 왼쪽 열에 대체로 들어간다 — 짧은 필드, 단일 테이블, 수만~수십만 건. 그래서 **첫 선택은 `pg_trgm` GIN**이고, 오른쪽 열 조건이 **하나라도 필수 요구로 들어오는 순간**이 전환점이다. 다음이 `tsvector`인지 검색 엔진인지는 2-4가 가른다.

### 2-4. 층위 ③ — `tsvector` + GIN 전문 검색: 글자 조각에서 "단어"로

#### `pg_trgm`과 무엇이 다른가 — 자르는 단위가 다르다

같은 GIN 위에 올라가지만 **쪼개는 단위가 글자 조각이 아니라 단어**다. 이 차이 하나가 나머지 전부를 결정한다.

| | `pg_trgm` | `tsvector` |
|---|---|---|
| 쪼개는 단위 | **3글자 조각** — 의미와 무관하게 기계적으로 자른다 | **단어(lexeme)** — 파서가 공백·구두점으로 자른 뒤 사전이 정규화한다 |
| 정규화 | 소문자화 정도 | **어간 추출**(running → run) + **불용어 제거**(the, is …) |
| 잘 하는 일 | 부분 문자열·오타·조사 붙은 말 — "어디든 들어 있으면 찾는다" | 단어 검색과 **랭킹** — "이 단어가 이 문서에 얼마나 중요한가" |
| 못 하는 일 | 관련도 순위, 불리언 질의, 동의어 | 단어 중간의 부분 문자열, 형태소 없는 언어(한국어) |
| 색인 크기 | 크다 (조각 수만큼) | 작다 (단어 수만큼) |

용어 둘을 그 자리에서 정의한다. **어간 추출(stemming)** 은 "달리는"·"달렸다"·"달린" 같은 변형을 공통의 뿌리 하나로 바꾸는 처리다 — 그래야 어떤 형태로 검색해도 같은 단어로 걸린다. **불용어(stop word)** 는 "the", "은", "는"처럼 거의 모든 문서에 나와 변별력이 없는 단어이고, 색인에서 빼면 크기와 검색 품질이 동시에 좋아진다.

정리하면 이렇다 — **`pg_trgm`은 "이 글자들이 들어 있나"를 묻고, `tsvector`는 "이 단어를 다루는 문서인가, 그리고 얼마나 그런가"를 묻는다.**

#### 사용법 — 문서를 단어 목록(`tsvector`)으로, 질의를 `tsquery`로

문서를 파서가 단어로 자르고, 사전(configuration)이 정규화한 뒤, 단어별 위치·가중치를 담은 `tsvector`로 저장한다. 질의는 `tsquery`(AND/OR/NOT/구문/접두)로 쓰고 `@@` 연산자로 매치한다.

```sql
-- 검색 벡터를 생성 컬럼으로 실체화(PG 12+) — 컬럼별 가중치(A > B > C)를 준다
ALTER TABLE webtoons
  ADD COLUMN search_vec tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(author_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(synopsis, '')), 'C')
  ) STORED;
CREATE INDEX CONCURRENTLY idx_webtoons_search_vec ON webtoons USING gin (search_vec);

-- 검색어 문법: websearch_to_tsquery 는 "사과나무 -완결" 같은 검색창 문법을 tsquery로 바꾼다
SELECT id, title, ts_rank(search_vec, q) AS rank
FROM webtoons, websearch_to_tsquery('simple', '사과나무 -완결') AS q
WHERE search_vec @@ q
ORDER BY rank DESC
LIMIT 20;
-- 접두 매치는 to_tsquery('simple', '레벨:*'), 하이라이트는 ts_headline(...)
```

```text
 Limit
   ->  Sort  Sort Key: (ts_rank(search_vec, q)) DESC  Sort Method: top-N heapsort
         ->  Bitmap Heap Scan on webtoons
               Recheck Cond: (search_vec @@ q)
               ->  Bitmap Index Scan on idx_webtoons_search_vec
                     Index Cond: (search_vec @@ q)
```

`pg_trgm`에 없던 것이 여기서 생긴다 — **불리언 질의**(`-완결`, 구문 검색), **컬럼 가중치**, **`ts_rank` 관련도 점수**, 그리고 단어 단위라 **인덱스가 트라이그램보다 훨씬 작다.**

다만 `ts_rank`는 인덱스가 계산해 주지 않는다 — 후보 전부에 점수를 매긴 뒤 `Sort`이므로, 흔한 단어의 후보가 크면 2-3 대가 ③과 같은 정렬 비용이 남는다(검색 엔진이 이 지점에서 앞선다).

#### 한국어 문제 — `simple` 파서는 공백으로 자르고, 형태소 분석기는 내장돼 있지 않다

PostgreSQL의 기본 텍스트 검색 파서는 **공백·구두점으로 단어를 자른다.** `simple` 설정은 거기에 소문자화만 하고 어간 추출·불용어 제거를 하지 않는다(`english` 같은 설정은 어간 추출을 한다). 영어처럼 띄어쓰기가 단어 경계인 언어를 전제한 것이라 한국어에서 두 가지가 깨진다.

1. **조사·어미가 붙는다** — "나무를", "나무가", "나무에서"가 전부 **다른 단어**로 색인된다. "나무"로 검색하면 하나도 안 걸린다.
2. **띄어쓰기가 없는 제목** — "나혼자만레벨업"은 단어 하나다. "레벨업"으로 못 찾는다(`'나혼자':*` 접두만 된다).

이걸 푸는 것이 **형태소 분석기**(문장을 의미 단위로 쪼개고 조사·어미를 떼는 도구)인데, PostgreSQL에는 **한국어 분석기가 내장돼 있지 않다.** 외부 확장을 직접 빌드해 붙이는 길이 있지만 관리형 PG(RDS/Aurora 등)에서는 대개 설치할 수 없다.

그래서 실무 판단은 이렇게 갈린다.

- **짧은 필드(제목·이름)의 한국어 검색은 `pg_trgm`에 머문다** — 부분 문자열 일치가 조사·붙여쓰기 문제를 우회해 주기 때문이다.
- **`tsvector`가 맞는 자리**는 (a) 줄거리·댓글처럼 **긴 본문**에서 단어 단위로 찾을 때(트라이그램 색인은 너무 커진다), (b) 여러 컬럼에 **가중치**를 주고 `ts_rank`로 **순위**를 매겨야 할 때, (c) `-완결` 같은 **불리언 질의**가 필요할 때 — 조사 문제는 검색어 쪽에서 접두 매치(`'나무':*`)로 일부 흡수한다.
- 둘을 **같이 쓰는 것**도 정상이다 — 제목은 `pg_trgm`, 줄거리는 `tsvector`.

형태소·동의어·오타·초성이 **필수 요구**로 들어오면 PG 안에서는 답이 없다 — 2-5 검색 엔진 신호 ①이다.

#### 세 도구 한눈에 — `pg_trgm` / `tsvector` / (MySQL 대조) InnoDB FULLTEXT ngram

| | `pg_trgm` GIN | `tsvector` GIN | MySQL FULLTEXT ngram (대조) |
|---|---|---|---|
| 일치 단위 | 3글자 조각 (부분 문자열) | 단어(lexeme) | 2글자 조각(기본) |
| 쿼리 문법 | `LIKE`/`ILIKE`/정규식 그대로 | `@@ tsquery` (전용) | `MATCH ... AGAINST` (전용) |
| 한국어 조사·붙여쓰기 | 자연히 우회 | 깨짐 (형태소 미내장) | ngram이면 우회 |
| 2글자 검색어 | 무력 | 단어면 가능 | 가능 |
| 순위·가중치 | 없음 (`similarity`만) | `ts_rank` + `setweight` | TF-IDF 계열 점수 |
| 색인 크기 | 큼 | 작음 | 큼 |
| 반영 시점 | 즉시 (pending list) | 즉시 (pending list) | 커밋 시 토큰화 |
| 필터 결합 | `BitmapAnd` | `BitmapAnd` | 인덱스 하나 → 필터 |

### 2-5. 층위 ④ — 검색 엔진(Elasticsearch)으로 전환을 미는 신호 5가지

"규모가 커지면 ES"는 판단 기준이 아니다. 아래 다섯 중 어느 것이 요구로 들어왔는지를 **번호로** 짚는다. 기억 고리: **품질 · 결합 · 범위 · 규모 · 격리**.

1. **검색 품질 요구** — 형태소 분석(한국어 `nori` 분석기: "달렸다" → "달리다"), 동의어, 오타 허용(fuzziness), 초성 검색(커스텀 분석기), 자동완성(`edge_ngram`), 관련도 튜닝(BM25 + 인기·최신 부스팅). PG는 `pg_trgm` 유사도로 오타 일부, `tsquery` 접두로 자동완성 일부까지는 되지만 **형태소·동의어·부스팅 조합은 안 된다.** **가장 흔한 전환 사유.**
2. **필터·정렬·집계의 결합** — "나무 검색 결과를 로맨스만, 인기순으로, 장르별 건수(패싯)와 함께" — 역색인 + 컬럼 저장 + 집계가 한 엔진의 본업이다. PG는 필터까지는 `BitmapAnd`로 버티지만 정렬은 후보 전체 `Sort`, 패싯은 매번 `GROUP BY` 집계 = 후보 전체 스캔이다(2-3 대가 ③).
3. **검색 범위가 여러 소스** — 작품명·작가명·태그·줄거리·에피소드 제목을 한 검색창에서. PG는 조인 위에 인덱스를 못 걸어 반정규화 컬럼이나 materialized view가 필요하다. 검색 엔진은 애초에 **검색용으로 반정규화한 문서**를 받는 구조라 자연스럽다.
4. **규모** — 실측에서 `pg_trgm`/`tsvector` p99가 목표를 넘고, 후보 집합 크기 때문에 `Sort`가 지배적이거나 GIN 인덱스 크기·pending list가 VACUUM을 앞지를 때. 신호 ①~③ 없이 규모만으로 가는 경우는 생각보다 드물다 — 규모만 문제면 2-3의 왼쪽 열 안에서 인덱스·캐시·레플리카로 더 버틸 수 있다.
5. **부하 격리** — 검색 트래픽(이벤트·푸시 직후 스파이크, 크롤러)이 결제·조회수 갱신과 **같은 DB의 `shared_buffers`·CPU·백엔드 프로세스를 잠식**한다. 검색을 별도 시스템으로 떼어내면 검색이 죽어도 결제는 산다 — 4장 ["통계 조회의 분리"](21-dashboard-stats-oltp-olap-separation.md) 문항과 같은 논리(기능은 다른데 자원은 공유).

### 2-6. 층위 ④의 진짜 비용 — 인프라가 아니라 **데이터 동기화**다

신호 다섯을 말했으면 대가 다섯을 **같은 호흡에** 붙인다. "ES 쓰면 다 해결"은 운영을 안 해 본 사람의 말이다.

그리고 그 다섯 중 무게중심은 ①(클러스터 운영)이 아니라 **②(동기화)** 다. 이유가 구조적이다 — 층위 ①②③에서는 색인이 **같은 트랜잭션 안에서** DB가 알아서 갱신해 줬다. 행을 넣으면 인덱스도 같이 들어가고, 롤백하면 같이 사라진다. 층위 ④에서 처음으로 **색인이 DB 밖에 따로 살게 된다.** 그 순간 "언제 반영되나", "빠지면 어떻게 아나", "다시 만들려면 뭘 해야 하나"가 전부 **우리가 직접 만들어야 하는 절차**로 바뀐다. 이것이 "검색 기능 추가해주세요" 한 줄의 숨은 비용이고, 3장 체크리스트가 존재하는 이유다.

1. **운영할 시스템이 하나 는다** — 클러스터(노드·샤드·레플리카 설계), JVM 힙과 GC, 디스크 워터마크, 버전 업그레이드, 모니터링·알람, 그리고 **담당자**. 매니지드 서비스(Elastic Cloud, OpenSearch Service)로 일부를 돈으로 바꿀 수 있지만 매핑 설계·재색인·용량 계획은 남는다.
2. **데이터 동기화와 최종 일관성** — PG에 커밋된 것이 ES에 **언제** 반영되는가. 이 항목 하나가 나머지 넷을 합친 것보다 오래 팀을 괴롭힌다.
   - **이중 쓰기 금지**: 애플리케이션이 PG와 ES에 각각 쓰면 한쪽만 성공하는 순간 영구 불일치. PG 트랜잭션은 ES를 롤백해 주지 않는다.
   - 정석은 **PG 커밋을 사실의 원천으로 두고 그 변경을 흘려보내는 것** — 같은 트랜잭션에 Outbox 행을 넣고 별도 프로세스가 색인하거나([결제 성공·주문 누락 사고](27-payment-succeeded-order-missing-incident.md)의 outbox 패턴), **WAL 논리 디코딩**을 CDC(Debezium의 `pgoutput` 플러그인, `wal_level = logical`)로 읽어 색인한다. 논리 디코딩은 **복제 슬롯**을 쓰므로 소비자가 멈추면 WAL이 디스크에 쌓인다 — 슬롯 지연 감시가 필수다.
   - 그 결과 **작품 등록 직후 몇 초간 검색에 안 나온다**(파이프라인 지연 + ES의 refresh 주기). 기획에 "검색 반영은 최대 N초 지연"을 **명시적으로 합의**해야 하고, 등록 화면에서 "검색 반영 중" 같은 UX가 필요할 수 있다.
   - **삭제·비공개**도 지연된다 — 검색엔 나오는데 클릭하면 404. 검색 결과 id로 PG 상태를 한 번 더 확인(후처리 필터)하거나 지연을 UX로 흡수한다.
   - 매핑 변경·분석기 교체 때는 **전량 재색인**(새 인덱스에 다시 넣고 alias 스왑)이 필요하다. 이 절차가 없으면 분석기 하나 못 바꾼다.

   > **MySQL 대조**: 같은 CDC를 MySQL은 binlog로 한다. PG는 WAL 하나가 복구·복제·CDC를 겸하므로 `wal_level`을 `logical`로 올리는 것과 복제 슬롯 관리가 추가 운영 항목이다.

3. **장애 도메인이 추가된다** — ES 클러스터가 red가 되면 검색이 죽는다. "검색은 비핵심이니 비활성화" / "PG `pg_trgm` 축소 검색 폴백" / "인기 작품 목록으로 대체" 중 무엇으로 degrade할지 **미리** 정해 두고 회로 차단기로 연결해야 한다. 폴백이 없으면 격리(신호 ⑤)로 얻은 것을 도로 잃는다.
4. **사실의 원천이 둘로 보인다** — ES는 **파생 데이터**다. "언제든 PG에서 전량 재구축할 수 있다"가 성립해야 하고, 그 재구축 스크립트가 **주기적으로 돌아가는지**가 팀의 성숙도다. 이 주제는 12장(`questions/12-nosql.md`, "RDB·Redis·ES 공존 시 source of truth")에서 다시 나온다.
5. **트랜잭션과 정합성 모델이 다르다** — ES 검색 결과는 PG 격리 수준의 보호를 받지 않는다. 검색 결과로 뭔가를 **결정**(결제·권한)하면 안 되고, 검색은 "후보를 찾는" 용도로 제한하고 최종 판단은 PG에서 한다는 경계를 코드에 둔다.

### 2-7. 구조 한 장, 그리고 중간 선택지

```text
[작품 등록/수정 트랜잭션]
   │ 같은 트랜잭션
   ├───→ webtoons 테이블            ← source of truth (PostgreSQL)
   └───→ outbox 테이블 ──(폴링 or WAL 논리 디코딩 CDC)──→ 인덱서 ──→ Elasticsearch  ← 파생 데이터, 재구축 가능
                                                                    ↑
[검색 API] ── 질의(형태소·오타·필터·정렬·패싯) ─────────────────────────┘
        └── 결과 id 목록 → (필요 시) PG에서 삭제·비공개 상태 재확인 → 응답
[ES 장애] ── 회로 차단 ──→ 폴백(pg_trgm 축소 검색 / 인기 목록 / 검색 비활성)
```

층위 ③과 ④ 사이가 절벽처럼 느껴진다면, 그 사이를 메우는 선택지도 있다 **(가산점 포인트)**.

- **매니지드 검색 서비스**: 운영 대가 ①의 일부를 비용으로 전환. 동기화·폴백 대가는 그대로다.
- **경량 검색 엔진**(Meilisearch, Typesense 등): 단일 노드로 오타·자동완성·패싯이 되고 운영이 가볍다. 규모·집계 요구가 작을 때 ES와 `pg_trgm` 사이의 선택지가 된다.
- **hot standby 레플리카로 검색 라우팅**: 격리(신호 ⑤)만 문제라면 검색 쿼리를 스트리밍 복제 레플리카로 보내는 것으로 OLTP 보호는 된다 — GIN 인덱스는 물리 복제로 그대로 따라간다. 대신 긴 검색 쿼리가 레플리카에서 취소되거나 `hot_standby_feedback`으로 프라이머리 bloat를 유발하는 문제는 [통계 조회의 분리](21-dashboard-stats-oltp-olap-separation.md)에서 다룬다. 품질(신호 ①)은 못 푼다.
- **PG 안의 BM25 검색 확장**(ParadeDB `pg_search` 등 — 이름만): 운영 시스템을 안 늘리고 랭킹 품질을 올리는 길이지만, 확장 설치가 가능한 환경이어야 하고 형태소 분석은 여전히 별개 문제다.

---

## 3. 판단과 실무 — "검색 기능 추가해주세요"의 숨은 비용을 산정한다

판단 기준을 "그때그때 감으로"가 아니라 **팀 문서와 도구에 고정**한다. 사람의 기억에 의존하지 않는 형태여야 한다.

### 3-1. 요구를 받으면 먼저 채우는 8칸

| # | 질문 | 답이 가리키는 층위 |
|---|---|---|
| 1 | **데이터량** — 지금 몇 건, 1년 뒤 몇 건? (기울기) | 선형 비용이 언제 임계를 넘는가 |
| 2 | **QPS** — 평시/피크, 전체 트래픽 대비 비중 | 커넥션(프로세스) 점유 = N × QPS |
| 3 | **일치 유형** — 접두 / 접미 / 중간 / 단어 / 형태소 / 오타 / 초성 | 접두면 ①(`text_pattern_ops`), 중간이면 ②(`pg_trgm`), 단어·랭킹이면 ③(`tsvector`), 형태소·오타면 ④ |
| 4 | **검색어 길이** — 2글자 검색어가 주력인가 | 주력이면 ②가 약해진다 → 접두 경로 분리 / bigram / ④ |
| 5 | **품질 요구** — 관련도 순위, 동의어, 인기 반영 | 순위만이면 ③, 동의어·부스팅이면 ④ |
| 6 | **결합 조건** — 필터(장르·연재상태·성인) / 정렬(인기·최신) / 집계(패싯) | 필터는 ②③ 가능, 정렬 후보 큼·패싯 동시면 ④ 신호 |
| 7 | **대상 범위·신선도** — 필드 몇 개, 테이블 몇 개 / 등록 후 몇 초 안에 검색돼야 하나 | 여러 테이블이면 ④ 신호. 즉시면 ①②③, 수 초 허용이면 ④ 가능 |
| 8 | **격리·가용성** — 검색 부하가 OLTP를 밀어내면 안 되나, 검색 장애 시 폴백은 | 격리 필수면 ④(또는 레플리카 라우팅) |

7번과 8번이 특히 중요하다. 이 둘이 **2-6에서 본 "색인이 DB 밖에 사는 비용"을 사전에 값으로 매기는 칸**이기 때문이다. "등록하면 바로 검색돼야 한다"는 요구 하나로 층위 ④가 탈락할 수 있고, 반대로 "검색이 죽어도 결제는 살아야 한다"는 요구 하나로 층위 ④가 강제될 수 있다.

### 3-2. 결정 트리 4단계

```text
1) 접두 일치로 협상 가능한가? (자동완성 UX면 대부분 가능)
   → YES: B-tree + text_pattern_ops + LIKE 'kw%' (+ 정규화 표현식 인덱스). 끝.
   → NO ↓
2) 단일 테이블 · 짧은 필드 · 3글자 이상 포함 여부 · 정렬 후보 작음 · 실측 p99 OK?
   → YES: pg_trgm GIN. 2글자 검색어는 접두 경로로 분리. ADR에 "다음 층위로 가는 트리거"를 숫자로.
   → NO ↓
3) 긴 본문 · 단어 단위 · 가중치와 ts_rank 순위 · 불리언 질의가 필요하고, 형태소는 없어도 되는가?
   → YES: tsvector 생성 컬럼 + GIN (제목은 pg_trgm과 병행 가능).
   → NO ↓
4) 형태소/오타/동의어/부스팅/패싯/다중 소스/격리 중 하나라도 필수
   → 검색 엔진. 매니지드·경량 엔진부터 검토. 동기화 방식·지연 합의·폴백을 설계 문서에.
```

### 3-3. 안전망을 고정하는 방법 — 문서 · 코드 · 알람

- **ADR(설계 결정 기록)에 전환 트리거를 숫자로** — "현재 `pg_trgm` GIN. 검색 p99 > 300ms가 1주 지속 / 요구에 형태소·오타 추가 / 검색 대상 테이블 2개 이상 → ES 검토 착수". 숫자는 팀이 정하되, **정하지 않은 채로 두지 않는 것**이 핵심이다. 그래야 "언제 갈지"를 두고 매번 감정 싸움을 안 한다.
- **코드 리뷰 규칙 + 자동 검출** — "선행 `%` LIKE는 검색 전용 포트(`SearchPort`) 밖에서 금지"(포트 안의 것만 `pg_trgm` 인덱스가 받쳐 준다). 사람 눈만 믿지 말고 통합 테스트에서 DataSource 프록시(p6spy 등)로 실행 SQL을 잡아 포트 밖에서 `LIKE '%` 패턴이 나오면 테스트를 실패시킨다.
- **풀스캔 감시 알람** — `pg_stat_user_tables.seq_scan`·`seq_tup_read`가 `webtoons`에서 검색 QPS만큼 늘면 검색이 Seq Scan으로 돌고 있다는 뜻이다. `pg_stat_statements`에서 호출당 `shared_blks_hit + shared_blks_read`가 큰 쿼리를 상시 대시보드에, `auto_explain`으로 `Filter: (title ~~ '%...%')`가 붙은 `Seq Scan` 계획을 로그로 잡는다. `pg_stat_user_indexes.idx_scan`으로 trgm 인덱스가 실제로 쓰이는지도 본다. 데이터가 자라 임계를 넘는 날을 **배포 없이도** 잡아낸다.
- **GIN 건강 감시** — `pg_relation_size`로 인덱스 크기 추이, `pgstattuple` 확장의 `pgstatginindex()`로 pending list 크기, 해당 테이블의 autovacuum 주기. 갱신 폭주 후 검색이 느려지는 톱니를 원인째로 잡는다.
- **부하 테스트 시나리오에 "검색 × 데이터 N배"** — 현재 데이터로만 테스트하면 선형 비용은 절대 안 잡힌다. 1년 뒤 예상 건수를 채운 환경에서 검색 QPS를 건다.
- **정규화 규칙·토큰 규칙 일치 테스트** — 표현식 인덱스의 식과 앱 전처리, 토큰 테이블과 원본이 어긋나지 않는지 검증하는 테스트를 CI에 둔다.
- **ES 도입 시 재구축 스크립트를 정기 실행** — "언제든 PG에서 다시 만들 수 있다"를 말이 아니라 주기 작업으로 증명한다. 2-6 대가 ④를 절차로 바꾸는 유일한 방법이다.

### 3-4. 실무 사례 단계 1 — `LIKE '%kw%'`로 시작, 조용히 자라는 비용

```java
// before — 출시 초기, 작품 3천 건. 잘 돌아간다. 문제는 이 코드가 "N에 선형인 비용"을 심는다는 것
@Query("SELECT w FROM Webtoon w WHERE w.title LIKE %:keyword% OR w.authorName LIKE %:keyword% " +
       "ORDER BY w.viewCount DESC")
List<Webtoon> search(@Param("keyword") String keyword, Pageable pageable);
// EXPLAIN: Sort ← Seq Scan on webtoons
//          Filter: ((title ~~ '%나무%') OR (author_name ~~ '%나무%'))  Rows Removed by Filter: 2988
```

이 코드가 위험한 진짜 이유는 두 가지다. 첫째, 이 패턴을 본 동료가 **댓글·에피소드 테이블에도 복사**한다 — 거기는 N이 수천만이다. 둘째, `OR`로 두 컬럼을 묶어 선행 필터(2-2 우회 ⑤)조차 못 붙는다.

검색 QPS가 오르던 어느 이벤트 날, 배포도 없이 커넥션 풀이 마르고 **결제 API까지 타임아웃**이 났다 — 1-3의 사슬 그대로다.

### 3-5. 실무 사례 단계 2 — `pg_trgm` GIN + 자동완성은 `text_pattern_ops` 접두 인덱스

```sql
-- 마이그레이션 (운영 중이므로 CONCURRENTLY — Flyway/Liquibase에선 트랜잭션 밖에서 실행)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_webtoons_title_pattern ON webtoons (title text_pattern_ops);
CREATE INDEX CONCURRENTLY idx_webtoons_title_trgm    ON webtoons USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY idx_webtoons_author_trgm   ON webtoons USING gin (author_name gin_trgm_ops);
```

```java
// after — 검색 요구를 둘로 쪼갠다: 자동완성(접두, 2글자 포함) / 결과 검색(중간 일치, 3글자 이상)
public interface WebtoonSearchRepository extends JpaRepository<Webtoon, Long> {

    // 자동완성: 접두 일치 → text_pattern_ops 인덱스 seek. 2글자 미만·와일드카드 문자는 컨트롤러에서 거른다
    @Query("SELECT w FROM Webtoon w WHERE w.title LIKE :prefix% ORDER BY w.viewCount DESC")
    List<Webtoon> autocomplete(@Param("prefix") String prefix, Pageable pageable);

    // 결과 검색: pg_trgm GIN — LIKE 문법 그대로, 두 인덱스는 BitmapOr로 결합. 3글자 미만은 자동완성 경로로 보낸다
    @Query(value = """
        SELECT * FROM webtoons
        WHERE (title ILIKE '%' || :keyword || '%' OR author_name ILIKE '%' || :keyword || '%')
          AND status = 'ONGOING'
        ORDER BY view_count DESC
        LIMIT :size
        """, nativeQuery = true)
    List<Webtoon> searchTrgm(@Param("keyword") String keyword, @Param("size") int size);
    // :keyword 의 %, _, \ 는 서비스 계층에서 이스케이프한다 (1-4 ④)
}
```

ADR에 적은 전환 트리거: "① 검색 p99 > 300ms 지속 ② 태그·줄거리 검색 요구 ③ 오타·초성 요구 ④ 장르 패싯 요구". 이 시점의 검색은 **단일 테이블·짧은 필드·수만 건**이라 2-3의 "버틸 수 있는 조건" 왼쪽 열 안이다.

### 3-6. 실무 사례 단계 3 — "태그로도, 줄거리로도, 오타 나도 찾게": 검색 엔진

요구가 ②③④를 한꺼번에 밟았다. 이제 PG 안에서는 답이 없다 — 여러 테이블(태그), 형태소·오타(품질), 패싯(집계). 검색을 **포트 뒤로 격리**하고 ES 어댑터를 붙인다.

```java
// 검색을 포트로 격리 — 구현(pg_trgm / ES)을 바꿔도 호출부는 모른다. 폴백도 여기서
public interface WebtoonSearchPort {
    SearchResult search(SearchQuery query);   // 키워드 + 필터 + 정렬 + 패싯 요청
}

@Component
class ElasticsearchWebtoonSearchAdapter implements WebtoonSearchPort {
    private final ElasticsearchClient es;
    private final WebtoonSearchPort fallback;   // pg_trgm 축소 검색 어댑터
    private final CircuitBreaker breaker;

    @Override
    public SearchResult search(SearchQuery q) {
        // nori + edge_ngram + fuzziness + 장르 패싯은 es.search 안에서. 차단기가 열리면 즉시 폴백으로
        return Try.ofSupplier(breaker.decorateSupplier(() -> es.search(q)))
                  .recover(ex -> fallback.search(q.withoutFacets()))   // ES 장애 시 degrade (패싯 없이)
                  .get();
    }
}
```

```text
색인 파이프라인: webtoons/tags/authors 변경 → outbox(같은 트랜잭션) → 인덱서 → ES 문서(작품명·작가명·태그·줄거리 반정규화)
                (또는 WAL 논리 디코딩 CDC — 복제 슬롯 지연 알람 필수)
합의한 지연: "등록 후 최대 10초 내 검색 반영" (기획 문서에 명시)
후처리: 검색 결과 id로 PG status 재확인 → 비공개·삭제 작품 제거
재구축: 매주 새벽 전량 재색인 → alias 스왑 (분석기 변경 리허설 겸용)
```

**대가로 실제 치른 것**: 검색 담당 1명 상시, 클러스터 비용, 등록 직후 "검색에 안 나와요" 문의 → UX 안내 추가, 분석기 교체 때 전량 재색인 2시간. 목록을 보면 알 수 있듯 **대부분이 인프라 비용이 아니라 2-6 ②의 동기화에서 파생된 것**이다. 이 목록을 **전환 전에** 산정해 보고했기 때문에 "왜 이렇게 오래 걸리냐"가 아니라 "예상 범위"로 받아들여졌다 — rationale이 말하는 **숨은 비용 산정**의 실제 모습이다.

---

## 4. 꼬리질문 대비 포인트

### "`LIKE '나무%'`는 인덱스를 탄다고 했는데, 항상 타나요?"

아니다. 넷을 짚는데 PostgreSQL에서는 첫째가 제일 흔하다. ① **collation이 `C`가 아니면 일반 B-tree로는 안 탄다** — 로케일 정렬에서는 접두사 연속성이 보장되지 않아 플래너가 범위 변환을 포기한다. `text_pattern_ops` 연산자 클래스로 인덱스를 만들거나 컬럼을 `COLLATE "C"`로 둔다. 계획에서 `Index Cond: ((title ~>=~ '나무') AND (title ~<~ '나묵'))`이 보이면 변환이 된 것이다. ② **컬럼에 함수를 씌우거나 `ILIKE`를 쓰면** 못 탄다 — 대소문자 무시는 `lower(title)` **표현식 인덱스**로 함수를 인덱스 쪽에 미리 적용한다. ③ **선택도가 낮으면** 플래너가 일부러 안 탄다 — `LIKE '가%'`가 전체의 30%면 랜덤 힙 접근보다 순차 스캔이 싸다(옳은 판단이다). 그래서 자동완성은 최소 2글자부터 받는다. ④ **사용자 입력에 `%`·`_`가 섞이면** 코드는 접두처럼 보여도 실행은 중간 일치가 된다 — 와일드카드를 이스케이프하거나 제거한 뒤 바인딩한다. 가산점은 준비문 — 범위 변환은 패턴 상수가 계획 시점에 있어야 하므로 제네릭 계획에서는 못 하고, 급변하면 `plan_cache_mode`를 의심한다.

### "PostgreSQL로 한국어 검색이 제대로 되나요? `pg_trgm`과 `tsvector` 중 무엇을 쓰나요?"

둘의 일치 단위가 다르다. `pg_trgm`은 **3글자 조각의 부분 문자열 일치**라 "나무를"·"나혼자만레벨업"처럼 조사가 붙거나 띄어쓰기가 없어도 찾고 LIKE 문법 그대로 인덱스가 붙는다 — 짧은 필드(제목·이름)의 한국어 검색은 여기서 오래 버틴다. 막히는 지점은 **2글자 검색어**(패턴에서 뽑을 조각이 없어 전체 recheck로 퇴화 → 접두 경로 분리, bigram 테이블, `pg_bigm`), **큰 색인**, **관련도 순위 없음**, **형태소·동의어·초성 불가**다. `tsvector`는 **단어 단위**라 인덱스가 작고 가중치·`ts_rank`·불리언 질의가 되지만, 기본 파서가 공백으로 자르고 **한국어 형태소 분석기가 내장돼 있지 않아**(관리형 PG에선 설치도 어렵다) 조사·붙여쓰기에서 깨진다 — 긴 본문(줄거리·댓글)이나 순위가 필요할 때 쓰고 제목은 `pg_trgm`과 병행한다. 형태소·오타·동의어·부스팅이 필수 요구로 들어오면 PG 안에는 답이 없고 검색 엔진 신호다.

### "ES를 도입하면 PG와의 데이터 불일치는 어떻게 다루나요?" (시니어 변별 포인트)

먼저 **불일치는 없앨 수 없고 관리하는 것**이라고 전제한다. 원칙 넷: ① **이중 쓰기 금지** — PG 트랜잭션은 ES를 롤백해 주지 않으니 앱이 두 곳에 직접 쓰면 영구 불일치가 생긴다. ② **PG 커밋을 원천으로, 변경을 흘려보낸다** — 같은 트랜잭션의 Outbox 행 또는 WAL 논리 디코딩 CDC(Debezium `pgoutput`)를 인덱서가 소비. 실패해도 재시도로 따라잡는다(최종 일관성). 논리 디코딩은 복제 슬롯이 WAL을 붙잡으므로 소비자 지연을 감시한다. ③ **지연을 기획과 합의**한다 — "등록 후 최대 N초", 등록 화면 UX, 삭제·비공개 작품이 검색에 남는 창은 검색 결과 id로 PG 상태를 재확인하는 후처리로 막는다. ④ **전량 재구축 절차를 정기 실행**한다 — 매핑 변경·분석기 교체·유실 복구 모두 이 절차 하나로 수렴하고, "언제든 PG에서 다시 만들 수 있다"를 주기 작업으로 증명한다. 이 넷 중 ①②가 없으면 언젠가 "검색엔 있는데 DB엔 없는 작품"을 손으로 지우게 된다. 12장 "source of truth" 문항과 같은 뿌리다.

### "ES 클러스터가 죽으면 검색은 어떻게 하나요? 그럼 격리한 의미가 있나요?" (시니어 변별 포인트)

격리로 얻은 건 **"검색이 죽어도 결제는 산다"**이지 "검색이 안 죽는다"가 아니다. 그래서 검색 경로에 **degrade 계층**을 미리 설계한다: 회로 차단기로 ES 호출을 끊고 → (a) PG `pg_trgm` 축소 검색(패싯·오타 없이 키워드만) (b) 인기 작품 목록으로 대체 (c) 검색 UI 비활성 + 안내, 중 서비스 성격에 맞는 것으로 떨어진다. 폴백 (a)를 유지하려면 **GIN 인덱스를 ES 도입 후에도 지우지 않는다**는 결정이 따라오고, 그 쓰기 비용(pending list·HOT 탈락)은 폴백의 가격이다. 이 "장애 도메인 추가 → 폴백 설계 → 폴백 유지 비용"까지가 전환 대가의 한 묶음이고, ES 자체의 가용성은 레플리카 샤드·다중 AZ·매니지드로 올린다.

### "`LIKE '%나무%'`인데 계획에 `Index Only Scan`이 나옵니다. 인덱스를 탄 건가요?" (가산점 포인트)

**인덱스 풀스캔**이다 — 탐색(seek)이 아니라 힙 대신 인덱스 사본을 처음부터 끝까지 훑은 것. 판별은 `Index Cond`의 유무다: 없고 `Filter`만 있으면 시작점을 못 찍은 것이고, `Rows Removed by Filter`가 테이블 행 수에 육박한다. 조회 컬럼이 인덱스에 다 들어 있어(커버링) 플래너가 "더 작은 쪽을 훑자"고 고른 결과이고, `Heap Fetches`가 작으려면 visibility map이 신선해야 한다. 힙 풀스캔보다 읽는 페이지가 적으니 빠르긴 하지만 **비용은 여전히 N에 선형**이고, 데이터가 10배면 10배 느려진다. 이 구분을 못 하면 "인덱스 탔는데 왜 느리죠"에서 멈춘다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **접두 LIKE** — MySQL은 일반 인덱스로 바로 `type: range`지만 PG는 collation이 `C`가 아니면 안 타서 `text_pattern_ops`가 필요하다. ② **중간 일치 도구** — MySQL은 FULLTEXT + ngram 파서와 `MATCH ... AGAINST` 전용 문법(코드 변경)이고, PG는 `pg_trgm`으로 `LIKE '%kw%'` 문법 그대로 인덱스가 붙는다(코드 무변경). 대신 ngram은 기본 2글자, 트라이그램은 3글자라 **한국어 2글자 검색어는 MySQL이 유리**하다. ③ **반영 시점** — InnoDB FULLTEXT는 커밋 시 토큰화라 같은 트랜잭션에서 안 보이고 삭제는 `OPTIMIZE TABLE`로 정리하지만, PG GIN은 일반 인덱스처럼 즉시 보이는 대신 pending list와 VACUUM이 따라온다. ④ **필터 결합** — MySQL은 테이블당 인덱스 하나라 FULLTEXT 후보에 나머지는 필터·filesort지만, PG는 `BitmapAnd`/`BitmapOr`로 인덱스 여럿을 결합하고 정렬만 남는다. ⑤ **계획 읽기** — MySQL의 `type: index`/`type: fulltext`가 PG에서는 "`Index Cond` 없는 `Index Only Scan`"과 "`Bitmap Index Scan` + `Recheck Cond`"다. 이 다섯을 짚으면 "LIKE는 안 탄다" 암기가 아니라 "저장 구조에서 도출"로 들린다.

---

## 한 줄 요약

**B-tree 인덱스는 첫 글자부터 정렬된 사전이라 `LIKE '%kw%'`는 트리를 내려갈 시작점을 찍을 수 없어(seek 불가) `Seq Scan` + `Filter`로 전부 훑고, 그 비용은 행 수에 선형이라 QPS와 곱해져 커넥션 풀을 말리며 조용히 자란다. 층위를 가르는 축은 "인덱스에 무엇을 키로 넣는가"다 — ① 값 전체를 그대로 넣는 B-tree 안에서 버티기(요구 협상, PG는 `text_pattern_ops` 필수 / 역순·정규화 표현식 인덱스 / 자체 토큰 테이블 / 선행 필터) → ② 3글자 조각으로 쪼개 역색인에 넣어 포함 검색을 조각들의 등호 조회로 바꾸는 `pg_trgm` GIN(대가: 2글자 무력·크기·pending list·순위 없음) → ③ 단어로 쪼개 어간·불용어를 정리하고 `ts_rank` 순위까지 주는 `tsvector` GIN(대가: 한국어 형태소 미내장) → ④ 형태소·오타·패싯·다중 소스·격리가 필수일 때 검색 엔진. ④의 진짜 대가는 클러스터 운영이 아니라 색인이 DB 밖에 따로 살면서 생기는 동기화 지연·유실·재색인 절차이고, 그것이 "검색 기능 추가해주세요"의 숨은 비용이다. 전환은 데이터량·QPS·일치 유형·검색어 길이·품질·결합·범위/신선도·격리 8칸을 채워 판단하고, 그 트리거를 ADR에 숫자로 박아 둔다.**
