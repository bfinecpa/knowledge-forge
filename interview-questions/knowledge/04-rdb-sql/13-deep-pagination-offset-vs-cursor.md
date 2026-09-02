# 깊은 페이지네이션 — `OFFSET`은 "건너뛰기"가 아니라 "읽고 버리기"다

> 핵심 관전 포인트: **`LIMIT 20 OFFSET 100000`이 느린 이유는 DB가 10만
> 건을 건너뛰는 게 아니라 100,020건을 전부 만들어 올린 뒤 `Limit` 노드가
> 앞의 10만 건을 세며 버리기 때문이다. B-tree에는 "앞에서 N번째"라는
> 좌표가 없어 세며 걷는 수밖에 없고, PostgreSQL은 테이블이 힙이라 정렬
> 인덱스가 PK든 아니든 버릴 행에도 **인덱스 → TID → 힙 페치**를 100,020번
> 지불한다 — MVCC 가시성 확인 때문에 "버릴 행인지"조차 힙을 봐야 안다 —
> 비용이 페이지 번호에 선형으로 비례한다. 해결책은 네 가지를 한 번에
> 꺼낸다: ① 커서(키셋) 기반 — `WHERE (created_at, id) < ($1, $2)` 행
> 비교로 시작점을 인덱스 탐색 한 번으로 바꿔 offset 자체를 없앤다
> (PostgreSQL은 행 비교를 B-tree 범위 탐색으로 실행한다) ② 지연
> 조인(deferred join) — `(created_at, id)` Index Only Scan으로 id 20개만
> 먼저 뽑아 힙 페치를 20회로 줄인다 ③ offset 상한을 API 레벨에서
> 강제한다(안전망) ④ 복잡한 검색은 검색 엔진에 위임한다. 그리고 커서의
> 대가 — 임의 페이지 점프 불가, 정렬 키 유일성·불변성, API 스펙 변경 — 를
> 한 호흡에 같이 말해야 완결된 답이다.**

---

## 0. 질문 + 의도

**질문**: "`LIMIT 100000, 20` 같은 깊은 페이지네이션이 느린 이유와
해결책(no-offset, 커서 기반)은?"

**PostgreSQL 기준 재해석**: "`LIMIT 20 OFFSET 100000` 같은 깊은
페이지네이션이 느린 이유와 해결책(no-offset, 커서 기반)은?" — `LIMIT
offset, count`는 MySQL 문법이고 PostgreSQL은 `LIMIT count OFFSET offset`
이다. 문법만 다를 뿐 offset의 비용 구조는 같다.

**출제 의도**: rationale은 이 문항을 이렇게 설명한다 — "관리자 페이지나
크롤러가 유발하는 고전적 부하 패턴. **offset의 비용 구조를 알아야 커서
기반으로 재설계할 수 있고, 이는 API 스펙 변경까지 수반하므로 미리 아는
것의 가치가 크다.**" 채점 지점은 셋이다. ⑴ "느리다"를 메커니즘으로
설명하는가(왜 skip이 아니라 read-and-discard인가 — PostgreSQL이면
실행 계획의 `Limit` 노드와 그 아래 스캔 노드의 `actual rows` 차이로
증명할 수 있는가) ⑵ 해결책을 목록으로 꺼내고 각각의 대가를 붙이는가
⑶ 커서 전환이 DB 쿼리 하나가 아니라 API 스펙·클라이언트·UI까지 바꾸는
조직적 결정임을 내다보는가.

**이 문서가 특히 겨냥하는 네 지점** (4장 기본 구간에서 반복된 패턴):

- **비용을 이름 붙은 사슬로** — "offset이 크면 DB가 많이 읽어서 느리다"에서
  멈추지 않고, `Limit` 노드의 카운터 → 스캔 노드의 힙 페치 × 100,020 →
  가시성 확인 → `shared_buffers` 미스 → 랜덤 I/O까지 고리를 하나씩
  말한다(§1).
- **트레이드오프를 양면으로** — 커서 기반은 "빠르다"로 끝내지 않는다.
  잃는 것(임의 페이지 점프, 정렬 유연성, total count, API 호환)을 같은
  호흡에 붙인다(§2-1, §5).
- **안전망을 코드로 고정** — "깊은 페이지는 막아야 한다"는 말이 아니라,
  사람이 기억하지 않아도 작동하는 인터셉터 한 장으로 상한을 강제한다(§2-3).
- **목록 인출** — 해결책은 항상 네 개를 세트로 꺼낸다(§2 서두).

**옆 문항과의 경계**: [컬렉션 fetch join + 페이징](../03-jpa-orm/08-fetch-join-pagination-in-memory.md)은
Hibernate가 `limit`을 SQL에서 **빼 버리고** 힙에서 자르는 JPA 계층 문제다.
이 문항은 `LIMIT`/`OFFSET`이 SQL에 **정상적으로 붙었는데도** DB가 offset만큼
읽고 버리는 DB 계층 문제다. 둘 다 "페이징이 느리다"로 보고되지만 원인
계층이 다르다.

---

## 1. 왜 느린가 — offset은 skip이 아니라 read-and-discard다

### 1-1. B-tree에는 "앞에서 10만 번째"라는 좌표가 없다 — 세는 것은 `Limit` 노드다

인덱스는 "값이 X인 곳"으로 가는 데는 트리 높이만큼(로그 시간)이면 되지만,
"앞에서 N번째"로 가는 길은 **없다.** 노드가 자기 아래 서브트리에 행이
몇 건 있는지를 세어 두지 않기 때문이다. 게다가 MVCC 때문에 스냅샷마다
보이는 행 집합이 다르므로 — 같은 순간에도 내 트랜잭션에는 보이고 옆
트랜잭션에는 안 보이는 행이 있다 — "N번째"라는 값은 애초에 저장해 둘
수도 없다. 그러니 10만 번째로 가려면 **처음부터 세며 걷는 수밖에 없다.**

세는 주체가 누구인지도 중요하다. PostgreSQL 실행기는 계획 트리를 위에서
아래로 "다음 튜플 줘"라고 당기는(pull) 파이프라인이고, `OFFSET`과 `LIMIT`은
그 트리 맨 위의 **`Limit` 노드**가 처리한다. 아래 스캔 노드는 조건에 맞는
행을 한 건씩 위로 올리고, `Limit` 노드가 카운터를 세며 offset에 못 미친
행은 버린다. 스캔 노드 입장에서는 그 행이 "결국 버려질 행"인지 알 길이
없으므로 **행을 온전히 만들어서 올린다.** 이 한 문장이 아래 모든 비용의
출발점이다.

```text
 ┌ Limit 노드 (offset = 100,000, count = 20) ─────────────────┐   ← 여기서 센다
 │  튜플 1        → 카운터 1        < 100,000 → 버림            │
 │  튜플 2        → 카운터 2        < 100,000 → 버림            │
 │  ...                                                        │
 │  튜플 100,000  → 카운터 100,000             → 버림            │
 │  튜플 100,001  → 결과 [1]                                    │
 │  ...                                                        │
 │  튜플 100,020  → 결과 [20]  → 클라이언트로, 스캔 중단          │
 └───────────────────────────▲─────────────────────────────────┘
                             │ "다음 튜플 줘" × 100,020 (pull)
 ┌ Index Scan Backward using idx_posts_created_at ─────────────┐
 │  인덱스 엔트리 → TID → 힙 페이지 읽기 → 가시성 확인 → 온전한 행 │
 └─────────────────────────────────────────────────────────────┘
```

읽은 행 100,020건, 반환한 행 20건. **일의 양은 offset + limit에 비례**하고
결과의 크기와는 무관하다 — 1페이지(20건 읽기)와 5,001페이지(100,020건
읽기)의 비용 차이가 5,001배다. 이게 "깊은 페이지네이션"의 정의다.

**PostgreSQL에서 한 겹 더 —** 스캔 노드가 힙을 읽는 이유는 컬럼 조립
때문만이 아니다. PostgreSQL의 인덱스 엔트리에는 **버전 정보가 없어**
죽은 튜플의 엔트리도 VACUUM 전까지 남아 있으므로, 어떤 엔트리가 **내
스냅샷에 보이는 행인지는 힙의 튜플 헤더(`xmin`/`xmax`)를 봐야만
안다**([MVCC](11-mvcc-postgresql.md)). "카운터에 넣을지 말지"를 정하는
것 자체가 힙 페치를 요구한다 — 버릴 행조차 공짜로 버릴 수 없는 구조다.

### 1-2. 사슬 — 정렬 인덱스를 타면: 힙 페치 × 100,020

PostgreSQL에는 [클러스터드 인덱스가 없다](03-clustered-vs-secondary-index.md).
테이블은 힙(heap)이고 PK를 포함한 **모든 인덱스가 리프에 TID(힙 페이지
번호 + 슬롯)를 담아 힙을 가리키는** 구조다. 그래서 정렬 기준이 PK든
`created_at`이든 `score`든 사슬의 모양은 하나다.

```sql
-- idx_posts_created_at (created_at) 존재. posts 에는 title, body 등 컬럼이 많다.
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 100000;
```

> ① 플래너가 정렬(`Sort`)을 피하려고 `idx_posts_created_at`을 **역방향으로
> 읽는** 계획(`Index Scan Backward`)을 고른다 — PostgreSQL은 B-tree를
> 거꾸로 읽을 수 있어 DESC 인덱스가 따로 필요 없다
> → ② 리프 끝에서 엔트리 하나를 읽는다 — 리프에는 **(created_at, TID)만**
> 있다
> → ③ TID가 가리키는 **힙 페이지를 읽어** 가시성을 확인하고, `SELECT *`라
> 나머지 컬럼을 그 튜플에서 가져온다(**힙 페치**) — 이 페이지들이 인덱스
> 순서와 무관하게 흩어져 있으면 **랜덤 I/O**
> → ④ 온전한 행을 `Limit` 노드로 올린다 → `Limit`: "아직 100,000 미만" →
> **버린다**
> → ⑤ ②~④를 **100,000번 반복** — 버릴 행에도 ③의 힙 페치를 전부 지불한다
> → ⑥ 100,001번째부터 20건만 결과에 담아 반환하고 스캔을 멈춘다.

합계: 인덱스 엔트리 100,020건 + **힙 페치 100,020회** + 그중
`shared_buffers`(그리고 OS 페이지 캐시)에 없는 페이지만큼의 디스크 읽기.
결과는 20건. [랜덤 I/O가 왜 순차 I/O보다 비싼가](02-index-not-used-full-scan.md)의
비용 모델이 그대로 곱해진다.

**실행 계획으로 증명하기 (수치는 예시)** — 이 문항의 "느린 이유"는
`EXPLAIN (ANALYZE, BUFFERS)` 한 장으로 닫힌다.

```text
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 100000;

 Limit  (cost=4183.20..4184.04 rows=20 width=412)
        (actual time=318.6..318.7 rows=20 loops=1)          ← 반환은 20건
   Buffers: shared hit=71204 read=29311                      ← 읽은 페이지는 10만 장
   ->  Index Scan Backward using idx_posts_created_at on posts
         (actual time=0.05..311.9 rows=100020 loops=1)      ← 실제로 100,020건 올렸다
 Execution Time: 318.8 ms
```

읽는 법 — `Limit`의 `actual rows=20` 아래 스캔 노드의 **`actual
rows=100020`**이 "버릴 행도 전부 올렸다"는 증거이고, `Buffers`는 반환
행이 아니라 **읽은 행 수 규모**로 잡힌다(`shared read`가 크면 캐시에도
없어 디스크까지 갔다는 뜻). `Limit`의 시작 비용이 0이 아닌 것도 플래너가
offset만큼 먼저 걷는 비용을 셈에 넣고 있다는 표시다.

면접에서 말하는 문장으로 압축하면 — **"PostgreSQL은 힙 테이블이라 어떤
인덱스로 정렬하든 리프에는 TID뿐이고, 버릴 10만 건에 대해서도 가시성
확인과 컬럼 조립을 위해 힙을 10만 번 찍고 나서 버립니다."**

#### "PK 순이면 덜 나쁘다"의 PostgreSQL 판 — 클러스터링이 아니라 상관관계

PostgreSQL의 PK는 유니크 B-tree일 뿐이라 **PK 순에도 힙 페치는 그대로
붙는다.** 그래도 PK 순(또는 삽입 순인 `created_at` 순)이 `score` 순보다
덜 나쁜 것은 사실인데, 이유는 클러스터링이 아니라 **힙의 물리 순서와
인덱스 순서가 얼마나 일치하는가**(`pg_stats.correlation`, 1에 가까울수록
일치)다. 상관관계가 높으면 연속된 엔트리가 같은 힙 페이지를 가리켜 힙
페치가 사실상 순차 읽기가 되고, `score`처럼 힙 위치와 무관한 컬럼이면
엔트리마다 다른 페이지 → 랜덤 I/O 100,020회에 가까워진다. 플래너도 이
값을 인덱스 스캔 비용에 반영한다. 어느 쪽이든 **읽는 양 자체는 여전히
offset에 선형**이다.

**플래너가 다른 길을 고르기도 한다** — 상관관계가 낮고 offset이 크면
"흩어진 힙 페치 10만 번보다 테이블을 통째로 읽고 정렬하는 게 싸다"고
판단해 `Seq Scan` + `Sort`로 간다. 이때 `Sort`는 `top-N heapsort`인데
**N은 20이 아니라 offset + limit = 100,020**이라, 그 양이 `work_mem`을
넘으면 `external merge Disk:`로 내려간다. 어느 길이든 **비용이 offset
또는 테이블 크기에 비례**하고, 결과 20건과는 무관하다.

### 1-3. 사슬 — 정렬 컬럼에 인덱스가 없을 때: `Seq Scan` + `Sort`

풀스캔 → 조건에 맞는 전체를 정렬(`Sort`, N = 100,020인 top-N heapsort,
`work_mem` 초과 시 디스크 임시 파일) → 앞 10만 건 버림. 이건 offset이
없어도 이미 비싼 쿼리이고, offset은 그 위에 얹힌다. 이 경우의 1차 처방은
페이지네이션 기법이 아니라 **정렬 컬럼 인덱스**다 — 그다음에야 §2가 의미
있다.

### 1-4. 커버링(Index Only Scan)이어도 남는 비용

필요한 컬럼이 전부 인덱스에 있으면 플래너는 `Index Only Scan`으로 힙
페치를 생략하려 한다. 그래도 ① **엔트리 100,020건을 순회하는 비용**과
② **가시성 확인**은 남는다 — 힙 대신 visibility map을 보고 "전부 가시"인
페이지만 건너뛰므로, VACUUM이 못 따라온 테이블이면 `Heap Fetches: N`이
커지며 결국 힙을 찍는다([커버링 인덱스](09-covering-index.md)). 커버링은
offset 비용의 **상수를 줄이지 차수를 바꾸지 못한다** — §2-2 지연 조인의
한계이기도 하다.

### 1-5. 덤으로 따라오는 비용 — 페이지 번호 UI의 `count(*)`

"전체 3,204페이지 중 5,001페이지"를 그리려면 매 요청마다 조건에 맞는
전체 건수를 세야 한다. PostgreSQL의 `count(*)`는 MVCC 때문에 미리 들고
있을 수 없어 가시성 확인을 위해 전부 훑는 쿼리이고, 목록 본체보다 비싼
경우가 많다 — [total count의 비용과 대안](17-total-count-cost-and-alternatives.md)의
주제이므로 여기서는 "offset 페이지네이션은 보통 count와 세트로 와서 비용이
두 배로 든다"는 사실만 고정한다.

### 1-6. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "offset이 크면 느리다" | **read-and-discard** | B-tree에 N번째 좌표 없음 → `Limit` 노드가 세며 버림 → 일의 양 = offset + limit → 페이지 번호에 선형 |
| "DB가 많이 읽는다" | **힙 페치 × offset** | 모든 인덱스 리프엔 TID뿐 → 버릴 행마다 힙 페이지를 읽어 가시성 확인 + 컬럼 조립 → 상관관계 낮으면 랜덤 I/O 100,020회 |
| "메모리에 부담" | **`shared_buffers` 미스** | 깊은 페이지 = 오래된 데이터 = 캐시에 없음 → `Buffers: shared read`↑ → 디스크 랜덤 I/O로 전락 |

`EXPLAIN (ANALYZE, BUFFERS)`에서는 `Limit` 아래 노드의 `actual rows`가
offset + limit 규모로 찍히고(20이 아니라 10만 단위), 인덱스를 못 탔으면
`Sort` 노드에 `top-N heapsort` 또는 `external merge`가 붙는다. "느린
이유"를 실행 계획으로 증명하는 습관까지 붙이면 답이 닫힌다.

> **MySQL 대조**: MySQL은 `LIMIT`/`OFFSET`을 InnoDB 위의 **SQL 서버
> 계층**이 세고 엔진은 행을 조립해 올린다 — "버릴 행도 온전히 만든다"는
> 구조는 같다. 다른 점은 정렬 인덱스 종류로 사슬이 갈린다는 것: PK
> (클러스터드) 순이면 리프에 행이 있어 **북마크 룩업 없이 순차 읽기**,
> 세컨더리 순이면 PK로 클러스터드를 다시 찾는 **북마크 룩업 × 100,020**.
> PostgreSQL은 힙 구조라 항상 힙 페치이고 상관관계가 무게를 정한다. 계획
> 표기는 `EXPLAIN`의 `rows`가 10만 단위, 정렬을 못 피하면 `Extra: Using
> filesort`.

---

## 2. 해결책 4가지 — 목록으로 먼저, 각각의 대가와 함께

면접에서는 이 네 개를 **세트로** 꺼낸다. 하나만 말하면 "그 방법을 못 쓰는
상황에서는요?"가 바로 따라온다.

1. **커서(키셋, no-offset) 기반** — offset 자체를 없앤다. 근본 해결.
2. **지연 조인(deferred join)** — offset은 유지하되, 버릴 행의 힙 페치를
   없앤다. 완화책이지만 API 변경이 없다.
3. **offset 상한** — 깊은 페이지 요청을 아예 거절한다. 안전망.
4. **검색 엔진/전용 저장소 위임** — 다중 필터 + 자유 정렬 + 깊은 탐색이
   동시에 필요하면 RDB의 일이 아니다. 구조 변경.

실무 조합은 보통 **③은 항상 + ①이나 ② 중 하나**다. ③ 없이 ①만 하면
구 API가 남아 있는 동안 계속 두들겨 맞는다.

### 2-1. 커서(키셋) 기반 — "몇 번째부터"를 "이 값 다음부터"로

> **용어 충돌 주의**: PostgreSQL의 `DECLARE ... CURSOR`(서버 커서)와는
> 다른 것이다. 서버 커서는 트랜잭션 안에서만 살며 커넥션과 트랜잭션을
> 점유하므로 요청 사이에 상태를 못 드는 HTTP 페이지네이션에는 맞지 않는다
> — [롱 트랜잭션의 해악](16-long-transaction-harm-and-shortening.md)을 API가
> 스스로 만드는 꼴이고 PgBouncer 트랜잭션 풀링 뒤에서는 유지되지도 않는다.
> 키셋 커서는 **"마지막으로 본 값"이라는 데이터**를 클라이언트가 들고 오는
> 무상태 방식이다.

원리는 하나다. B-tree는 "N번째"는 못 찾지만 **"값이 X보다 작은 첫
지점"은 로그 시간에 찾는다.** 그러니 "지난 페이지의 마지막 값"을
클라이언트가 들고 왔다가 `WHERE`로 넘기면, 시작점 탐색이 O(offset)에서
트리 높이 한 번으로 바뀐다. 읽는 양은 페이지가 아무리 깊어도 항상
limit + 1건이다.

```sql
-- ❌ before: 5,001페이지 — 100,020건 읽고 100,000건 버림
SELECT * FROM posts
ORDER BY id DESC
LIMIT 20 OFFSET 100000;

-- ✅ after: "마지막으로 본 id 다음부터 20건" — 인덱스 탐색 1회 + 20건 읽기
SELECT * FROM posts
WHERE id < $1                     -- 지난 페이지 마지막 행의 id
ORDER BY id DESC
LIMIT 20;
```

#### 복합 정렬 키 — `created_at` 하나로는 안 되는 이유와 행 비교

실제 목록은 `created_at DESC`처럼 **유일하지 않은** 컬럼으로 정렬한다.
같은 초에 글이 세 개 올라올 수 있다. 이때 커서를 `created_at < $1`로
쓰면 **같은 시각의 나머지 글이 건너뛰어지고**(누락), `<=`로 쓰면 **이미 본
글이 다시 온다**(중복). 정렬 키가 행을 유일하게 식별하지 못하면 "그
다음"이 정의되지 않는다는 뜻이다.

처방은 **유일한 컬럼을 tie-breaker로 붙여 정렬 순서를 전순서(total order)로
만드는 것** — `(created_at, id)`. 커서도 두 값을 함께 들고, 조건은 **행
비교(row comparison)** 다. PostgreSQL은 이 형태를 SQL 표준 의미 그대로
지원하고 **B-tree 범위 탐색으로 실행한다** — 이 문항의 PostgreSQL 가산점
포인트다.

```sql
-- 인덱스: 반드시 (created_at, id) 복합으로 만든다.
--   PostgreSQL의 인덱스 리프에는 TID만 있어서 (created_at) 단독 인덱스 안에서
--   같은 시각의 엔트리는 id 순이 아니다 — 명시하지 않으면 tie-breaker 정렬이 인덱스에 없다.
CREATE INDEX idx_posts_created_at_id ON posts (created_at, id);

-- ✅ 행 비교 — PostgreSQL의 정석. 인덱스 범위 조건 하나로 잡힌다
SELECT * FROM posts
WHERE (created_at, id) < ($1, $2)          -- (마지막 created_at, 마지막 id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

```text
EXPLAIN (ANALYZE, BUFFERS)  -- 수치는 예시
 Limit  (actual time=0.06..0.14 rows=20 loops=1)
   Buffers: shared hit=24                                        ← 5,001페이지든 1페이지든 이 수준
   ->  Index Scan Backward using idx_posts_created_at_id on posts
         Index Cond: (ROW(created_at, id) < ROW('2026-08-30 12:34:56+09'::timestamptz, '102034'::bigint))
         (actual rows=20 loops=1)                                 ← 읽은 것도 20건
```

`Index Cond`에 `ROW(...) < ROW(...)`가 찍히면 성공이다 — 플래너가 행 비교를
"이 지점보다 작은 첫 엔트리로 점프 → 거기서 역방향으로 20개"라는 **범위
조건 하나**로 번역했다는 뜻이다. `Limit` 아래 `actual rows`가 20이고
`Buffers`가 수십 장에서 멈춘 것이 §1-2 계획과 대비되는 증거다.

읽는 방법: "created_at이 더 이르거나, **같은 시각이면** id가 더 작은 것"
— 정렬 순서(둘 다 DESC)와 부등호 방향(`<`)이 반드시 일치해야 한다. ASC
정렬이면 `>`로 뒤집는다. 세 가지를 더 맞춘다.

- **인덱스 방향**: PostgreSQL은 B-tree를 역방향으로 읽으므로 `(created_at,
  id)` 하나로 `ASC, ASC`도 `DESC, DESC`도 처리된다(`Index Scan` /
  `Index Scan Backward`). 방향이 **섞이면**(`created_at DESC, id ASC`) 행
  비교 한 줄로 표현이 안 되고 인덱스도 `(created_at DESC, id ASC)`처럼
  컬럼별 방향을 줘야 한다 — 굳이 섞을 이유가 없으면 통일한다.
- **NULL**: 정렬 키는 **NOT NULL**이어야 한다. NULL과의 비교는 UNKNOWN이라
  그 행이 커서 조건에서 **조용히 빠진다.** PostgreSQL 기본은 `ASC`가
  `NULLS LAST`, `DESC`가 `NULLS FIRST`라 nullable 컬럼을 굳이 쓰면 인덱스와
  `ORDER BY` 양쪽의 `NULLS` 옵션을 맞추고 NULL 구간을 따로 처리해야 한다.
- **등호 필터가 앞에 있으면 인덱스도 그 순서**: `WHERE board_id = $1`로
  걸러지는 목록이면 인덱스는 `(board_id, created_at, id)`, 조건은 `board_id
  = $1 AND (created_at, id) < ($2, $3)` — 등호 구간 안에서 행 비교 범위
  하나로 잡힌다([복합 인덱스 순서](08-composite-index-column-order.md)).

> **MySQL 대조**: MySQL도 `(a, b) < (x, y)` 문법은 받지만 **인덱스 범위로
> 최적화하지 못해** 풀어 쓴 `created_at < ? OR (created_at = ? AND id < ?)`
> 를 쓴다. 반대로 PostgreSQL에서 이 OR 형태를 그대로 쓰면 플래너가 "결국
> `created_at <= ?` 범위 하나"임을 스스로 추론하지 못해 `BitmapOr` + `Sort`
> 로 커서 이전 행을 다 읽거나 역방향 스캔 + `Filter`로 이미 본 행을 다
> 지나가기 쉽다. JPQL처럼 행 비교를 못 쓰는 자리라면 **`created_at <= $1`
> 상한을 중복으로 덧붙여** 범위를 준다(§4-3). 또 하나 — MySQL 세컨더리
> 인덱스는 리프에 PK를 품어 `(created_at)` 단독으로도 사실상 `(created_at,
> PK)` 순이지만, PostgreSQL은 리프가 TID라 **복합 인덱스를 반드시 명시**한다.

**(가산점 포인트)** 목록 API가 몇 컬럼만 돌려준다면 `(created_at, id)
INCLUDE (title)`로 비키 컬럼을 리프에 얹어 커서 쿼리를 `Index Only Scan`
으로 만들 수 있다 — 20건의 힙 페치마저 사라진다. 대가는 인덱스 크기와
`title` 갱신의 HOT 탈락([커버링 인덱스](09-covering-index.md)).

#### 커서는 불투명(opaque) 문자열로 넘긴다

클라이언트에 `created_at`과 `id`를 따로 노출하면 클라이언트가 값을 조작해
호출하기 시작하고, 나중에 정렬 키를 바꿀 수 없게 된다. **두 값을 하나로
직렬화해 Base64 같은 불투명 토큰**으로 주고받는다 — "이 문자열을 다음
요청에 그대로 돌려주세요"가 계약이 된다.

```json
{
  "items": [ ... 20건 ... ],
  "nextCursor": "MjAyNi0wOC0zMFQwMzozNDo1Nlp8MTAyMDM0",
  "hasNext": true
}
```

#### 커서 기반의 대가 — 얻는 것과 잃는 것을 한 호흡에

| 얻는 것 | 지불하는 것 |
|---|---|
| 깊이와 무관한 상수 비용 | **임의 페이지 점프 불가** — "3,204페이지로" 못 간다 |
| 스크롤 중 삽입·삭제에도 중복/누락 없음 | **정렬 키 유일성 필요** — tie-breaker와 복합 인덱스 설계 |
| count 쿼리 불필요(Slice) | **total count 미제공** — 페이지 번호 UI 불가 |
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
  손실이 아니라 §1-5의 count 비용까지 함께 던져 버리는 이득이지만, 기획과
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
뒤 결과 리스트를 다시 뒤집어 돌려준다(`WHERE (created_at, id) > ($1, $2)
ORDER BY created_at ASC, id ASC LIMIT 20` → reverse). 같은 `(created_at,
id)` 인덱스를 정방향 `Index Scan`으로 읽을 뿐이라 인덱스를 더 만들 필요가
없다. 양방향이 필요하면 `prevCursor`도 함께 내려준다.

### 2-2. 지연 조인(deferred join) — offset은 두고 "버릴 행의 힙 페치"만 없앤다

페이지 번호 UI를 당장 못 버리거나 API를 바꿀 수 없을 때의 처방이다.
발상: 어차피 버릴 100,000건에 대해 **힙을 찍어 행 전체를 조립하는 게
낭비**이니, 먼저 **인덱스만 훑어 id 20개를 고르고**, 그 20개에 대해서만
본 테이블을 읽는다.

```sql
-- ❌ before: Index Scan Backward → 힙 페치 100,020회 → 100,000건 버림
SELECT * FROM posts
ORDER BY created_at DESC
LIMIT 20 OFFSET 100000;

-- ✅ after: 서브쿼리는 (created_at, id) 인덱스만으로 끝난다(Index Only Scan).
--           힙 페치는 바깥 조인의 20회뿐.
SELECT p.*
FROM posts p
JOIN (
    SELECT id
    FROM posts
    ORDER BY created_at DESC
    LIMIT 20 OFFSET 100000        -- offset 은 그대로. 하지만 인덱스 리프만 역순으로 읽는다
) AS page USING (id)
ORDER BY p.created_at DESC;       -- 조인 결과의 순서는 보장되지 않으므로 바깥에서 다시 정렬(20건)
```

```text
 Nested Loop  (actual rows=20)                       -- 바깥 Sort(20건)는 생략
   ->  Limit  (actual rows=20)
         ->  Index Only Scan Backward using idx_posts_created_at_id on posts
               Heap Fetches: 0                       ← VM이 신선하면 힙을 안 본다
               (actual rows=100020)                  ← 세며 버리는 건 여전히 10만
   ->  Index Scan using posts_pkey on posts p         ← 살아남은 20건만 힙 페치
         Index Cond: (id = posts.id)  (actual rows=1 loops=20)
```

왜 빨라지는지도 사슬로 — 서브쿼리의 `SELECT id ... ORDER BY created_at`은
필요한 컬럼(created_at, id)이 전부 `(created_at, id)` 인덱스 안에 있어
**힙 페치 없이 인덱스 리프만 역순으로 읽는다**(`Index Only Scan`,
[커버링 인덱스](09-covering-index.md)). 100,020개 엔트리를 세며 버리는 건
같지만, 엔트리는 행보다 훨씬 작아 페이지 수가 적고 리프를 이어 읽는 순차
I/O다. 흩어진 힙 페치 100,020회가 **20회로** 줄어든다.

대가 — **여전히 O(offset)이다.** 인덱스 스캔이 싸다는 것이지 공짜는
아니라서, 페이지가 수만 단위로 깊어지면 다시 느려진다. 그리고 PostgreSQL
고유의 조건이 붙는다 — `Index Only Scan`이 힙을 건너뛰는 것은 **visibility
map이 신선할 때**뿐이라, VACUUM이 밀린 테이블이면 `Heap Fetches`가 튀어
before와 비슷해진다(§1-4). 장점은 **API도 UI도 바꾸지 않고 오늘 밤 배포할
수 있다**는 것. 그래서 지연 조인은 "커서로 가는 마이그레이션 기간의
다리"로 쓰이는 경우가 많다.

> **MySQL 대조**: 지연 조인은 MySQL 쪽에서 유명해진 기법이다 — 세컨더리
> 리프에 PK가 있어 `(created_at)` 단독 인덱스로도 서브쿼리가 커버링(`Using
> index`)이 되고, 북마크 룩업을 바깥 PK 조인의 20회로 줄인다. PostgreSQL은
> 복합 인덱스를 명시해야 커버링이 성립하고, 성립해도 VM 상태에 좌우된다.

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

**(가산점 포인트)** DB 쪽 2차 안전망 — **`statement_timeout`**(목록 API용
롤에 `ALTER ROLE app_reader SET statement_timeout = '3s'`, 또는 `SET
LOCAL`)으로 "어떤 경로로든 새어 들어온 깊은 페이지 쿼리"가 커넥션을 오래
물지 못하게 한다. 3차는 관측 — **`auto_explain`** 로그에서 깊은 페이지
쿼리는 `Limit` 아래 노드의 `actual rows`가 10만 단위인 **한눈에 보이는
서명**을 갖고, `pg_stat_statements`에서는(상수가 `$1`로 정규화돼 offset
값은 안 보이지만) **`rows` 대비 `shared_blks_hit + read`가 비정상적으로 큰
쿼리**로 잡힌다. 애플리케이션 상한(1차) + DB 타임아웃(2차) + 관측(3차)이
한 세트다.

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

월요일 오전, 주문 목록 API의 p99가 튀고 DB CPU가 치솟는다.
`log_min_duration_statement` 로그에는 같은 쿼리가 offset만 바꿔가며
반복되고, `pg_stat_statements`에서는 이 쿼리가 `total_exec_time` 상위에
있다 — `calls`는 적은데 호출당 `shared_blks_hit`가 수만 블록이다.

```sql
SELECT * FROM orders WHERE status = 'DONE' ORDER BY created_at DESC LIMIT 20 OFFSET 99980;
SELECT * FROM orders WHERE status = 'DONE' ORDER BY created_at DESC LIMIT 20 OFFSET 100000;
SELECT * FROM orders WHERE status = 'DONE' ORDER BY created_at DESC LIMIT 20 OFFSET 100020;
```

호출자를 추적하면 둘 중 하나다. ⑴ 관리자 화면의 **"마지막 페이지 »"
버튼** — 운영팀이 가장 오래된 주문을 보려고 누른다 ⑵ 외부 **크롤러나
내부 배치**가 `page=1, 2, 3, ...`으로 전수 순회 중이다. 둘 다 사람이 목록을
읽는 속도가 아니라 **기계 속도로 깊은 페이지를 연타**한다.

`EXPLAIN (ANALYZE, BUFFERS)`를 뜨면 `Limit` 아래 노드의 `actual rows`가
10만 단위다. `(status, created_at)` 인덱스를 탔다면 `Index Scan Backward`
+ 힙 페치 10만 회, 못 탔다면 `Seq Scan` + `Sort`(`top-N heapsort` 또는
`external merge`)가 붙어 있다. §1-2 사슬 그대로다.

### 3-2. 처방의 순서 — 즉시 / 단기 / 중기

- **즉시(오늘)**: §2-3 offset 상한 인터셉터 배포. 크롤러는 400을 받고
  멈추거나 커서 API로 옮겨온다. 장애를 먼저 끊는다. 롤에
  `statement_timeout`이 없었다면 함께 건다.
- **단기(이번 주)**: 페이지 번호 UI를 유지해야 하는 관리자 화면은 §2-2
  지연 조인으로 쿼리만 교체. "마지막 페이지" 버튼은 **정렬을 뒤집은 1페이지**
  (`ORDER BY created_at ASC, id ASC LIMIT 20` 후 reverse — 같은 인덱스를
  정방향으로 읽을 뿐이다)로 바꾸면 offset 없이 같은 결과를 준다 — 기획이
  원한 건 "가장 오래된 20건"이지 "5,001페이지"가 아니었다.
- **중기(다음 스프린트)**: 외부 공개 목록 API에 커서 기반 v2를 추가하고,
  v1에는 상한을 유지한 채 폐기 일정을 공지한다. 전수 순회가 필요한 내부
  배치는 커서 루프로 재작성한다.

### 3-3. 배치의 전수 순회 — 같은 함정, 다른 옷

"모든 주문을 순회하며 정산 파일을 만드는" 배치가 `PageRequest.of(page++,
1000)`으로 돌면, 뒤로 갈수록 한 페이지가 느려져 **실행 시간이 페이지 수의
제곱에 비례**해 늘어난다(매 페이지가 offset만큼 읽으므로). 처방은
동일하게 키셋이다 — 마지막 id를 들고 `WHERE id > $1 ORDER BY id LIMIT
1000`을 반복한다.

**(가산점 포인트)** Spring Batch의 `JpaPagingItemReader`는 내부적으로
offset 페이징(`setFirstResult`)이라 같은 문제를 안고 있고,
`JdbcPagingItemReader`는 `sortKeys`를 기준으로 "마지막 키 다음부터"를
조회하는 키셋 방식이다. 리더 선택이 곧 이 문항의 적용이다. 배치처럼 **한
트랜잭션 안에서 한 번에 끝까지 읽는** 경우라면 HTTP와 달리 서버 커서도
정당하다 — pgjdbc는 `autocommit = false` + `fetchSize > 0`이면 서버
커서로 나눠 받는다(`JdbcCursorItemReader`). 대신 §2-1의 점유 비용을 낸다.

### 3-4. 속도만이 아니다 — offset은 스크롤 중에 결과가 밀린다

사용자가 1페이지를 보는 동안 새 글이 하나 올라오면, 2페이지 요청
`LIMIT 20 OFFSET 20`은 한 칸 밀린 창을 잘라 **1페이지의 마지막 글이 2페이지
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

// 나가는 SQL 2개 (PostgreSQL 방언 — Hibernate 버전에 따라 offset ? rows fetch first ? rows only 형태)
// select ... from post where board_id=? order by created_at desc limit 20 offset 100000
// select count(*) from post where board_id=?
```

문제 두 개가 겹쳐 있다 — offset 100000(§1-2 사슬)과 매 요청 count(§1-5).

### 4-2. 흔한 오해 — "`Slice`로 바꾸면 해결"

`Slice`는 **count 쿼리만 없앤다.** `Slice<Post> findByBoardId(..., PageRequest.of(5000,
20))`은 여전히 `limit 21 offset 100000`을 날린다(다음 페이지 유무를 알려고
size + 1건을 읽을 뿐). no-offset은 반환 타입이 아니라 **`WHERE` 조건**에서
온다 — `Slice`는 그 결과를 담는 그릇일 뿐이다.

### 4-3. after — 커서 조건 + `Slice`

Spring Data JPA `@Query`로 커서 조건을 직접 쓰는 형태. JPQL에는 행 비교
문법이 없으므로 풀어 쓴 OR 형태를 쓰되, **PostgreSQL 플래너에게 범위를
주기 위해 `p.createdAt <= :c` 상한을 중복으로 덧붙인다**(§2-1 MySQL 대조
참고). 인덱스는 `(board_id, created_at, id)`.

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
             and p.createdAt <= :cursorCreatedAt
             and (p.createdAt < :cursorCreatedAt
                  or (p.createdAt = :cursorCreatedAt and p.id < :cursorId))
           order by p.createdAt desc, p.id desc
           """)
    Slice<Post> findSliceAfter(Long boardId, Instant cursorCreatedAt, Long cursorId,
                               Pageable pageable);
    // createdAt 컬럼이 timestamptz 면 Instant/OffsetDateTime, timestamp 면 LocalDateTime 으로 매핑한다
    // (30 문서 timestamp vs timestamptz). 커서 값의 타입이 컬럼과 다르면 캐스트가 붙어 인덱스를 놓칠 수 있다.
}

// 호출 — page 는 항상 0. "어디서부터"는 커서가 정한다.
Slice<Post> slice = (cursor == null)
        ? postRepository.findFirstSlice(boardId, PageRequest.of(0, 20))
        : postRepository.findSliceAfter(boardId, cursor.createdAt(), cursor.id(),
                                        PageRequest.of(0, 20));
// 나가는 SQL 1개, offset 0
// select ... where board_id=? and created_at<=? and (created_at<? or (created_at=? and id<?))
//            order by created_at desc, id desc limit 21
```

행 비교 `(created_at, id) < (?, ?)`를 그대로 쓰고 싶으면 `nativeQuery =
true`로 SQL을 직접 쓴다 — 계획에 `Index Cond: (ROW(...) < ROW(...))`가
찍히는 가장 깔끔한 형태다. 어느 쪽이든 **배포 전에 `EXPLAIN (ANALYZE,
BUFFERS)`로 `Limit` 아래 `actual rows`가 21에서 멈추는지 확인**한다.

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
        return post.createdAt.loe(c.createdAt())              // 플래너용 범위 상한 (중복 조건)
                .and(post.createdAt.lt(c.createdAt())
                     .or(post.createdAt.eq(c.createdAt()).and(post.id.lt(c.id()))));
    }
}

// 커서 값 객체 — 클라이언트에는 불투명 토큰으로만 노출
public record PostCursor(Instant createdAt, Long id) {

    public String encode() {
        String raw = createdAt + "|" + id;                    // ISO-8601 UTC 문자열 | id
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(UTF_8));
    }

    public static PostCursor decode(String token) {
        String[] parts = new String(Base64.getUrlDecoder().decode(token), UTF_8).split("\\|");
        return new PostCursor(Instant.parse(parts[0]), Long.parseLong(parts[1]));
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

Spring Data JPA 3.1부터는 커서 조건을 직접 쓰지 않아도 되는 `Window` /
`ScrollPosition.keyset()`이 있다.

```java
public interface PostRepository extends JpaRepository<Post, Long> {
    Window<Post> findFirst20ByBoardIdOrderByCreatedAtDescIdDesc(Long boardId, ScrollPosition position);
}

Window<Post> first = repo.findFirst20ByBoardIdOrderByCreatedAtDescIdDesc(boardId, ScrollPosition.keyset());
Window<Post> next  = repo.findFirst20ByBoardIdOrderByCreatedAtDescIdDesc(
                             boardId, first.positionAt(first.size() - 1));
// 정렬 컬럼(createdAt, id)의 값을 위치로 삼아 "그 다음부터" 조건을 자동 생성한다
```

정렬에 유일 컬럼(id)이 들어 있어야 한다는 전제는 동일하다 — 프레임워크가
커서 조건을 대신 써 줄 뿐, **정렬 키 유일성이라는 대가는 사라지지 않는다.**
생성된 SQL이 PostgreSQL에서 인덱스 범위 하나로 잡히는지는 `EXPLAIN`으로
한 번 확인하고 간다.

---

## 5. 꼬리질문 대비 포인트

### "정렬이 PK 순이면 `LIMIT 20 OFFSET 100000`도 괜찮은 거 아닌가요?"

"덜 나쁠 수 있다"이지 "괜찮다"가 아니다 — 그리고 PostgreSQL에서는 "덜
나쁜" 이유가 InnoDB와 다르다. PK는 클러스터드가 아니라 유니크 B-tree라
**PK 순에도 힙 페치가 100,020번 붙는다.** 덜 나쁜 것은 `id`가 삽입 순이라
힙의 물리 순서와 상관관계(`pg_stats.correlation`)가 높아 힙 페치가 순차
읽기에 가까워지기 때문일 뿐이다. `Limit` 노드가 100,000건을 세며 버리는
read-and-discard는 그대로이고, 깊은 페이지의 오래된 데이터는
**`shared_buffers`에 없을 확률이 높아 디스크 읽기**가 된다. 랜덤 I/O 항이
줄었을 뿐 **비용은 여전히 offset에 선형**이다. 그리고 실제 목록의 정렬은
대부분 PK가 아니다.

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
개가 있고 커서가 그중 첫 번째에서 끊겼다면 — `created_at < $1`은 나머지
두 개를 **건너뛰고**(누락), `created_at <= $1`은 이미 본 첫 번째를 **다시
준다**(중복). 처방은 유일 컬럼 `id`를 tie-breaker로 붙여 `(created_at, id)`를
전순서로 만들고, 조건을 행 비교 `(created_at, id) < ($1, $2)`로, 인덱스도
`(created_at, id)`로 두는 것. **(가산점 포인트)** PostgreSQL에서는 이 복합
인덱스가 **선택이 아니라 필수**다 — 리프에 있는 것은 PK가 아니라 TID라
`(created_at)` 단독 인덱스 안에서 같은 시각의 엔트리는 id 순이 아니다.
그리고 행 비교가 `Index Cond`로 잡히려면 컬럼 순서·방향이 인덱스와
일치해야 하므로, 인덱스 정의가 곧 커서 조건의 설계도다.

### "지연 조인은 여전히 offset 100000인데 왜 빨라지나요? 한계는요?"

사슬로 — before는 인덱스 엔트리마다 **TID로 힙을 읽어 가시성을 확인하고
행을 조립한 뒤 버린다 × 100,000.** after의 서브쿼리는 `SELECT id`라 필요한
값이 전부 `(created_at, id)` 리프에 있어 **`Index Only Scan`으로 힙을
건너뛰고 리프만 역순으로 세며 걷고**, 살아남은 id 20개만 PK 인덱스로 힙을
읽는다. 흩어진 힙 페치 100,020회 → 20회. 한계는 둘 — ① 인덱스 스캔 자체가
**여전히 O(offset)** 이라 offset이 수십만·수백만이면 다시 느려진다, ②
**`Index Only Scan`의 힙 생략은 visibility map이 신선할 때뿐**이라 VACUUM이
밀리면 `Heap Fetches`가 튀어 이득이 줄어든다. 그래서 지연 조인은 "페이지
번호 UI를 유지하면서 상한 안쪽을 빠르게" 또는 "커서로 가는 동안의
다리"로 쓴다.

### "무한 스크롤 중에 새 글이 올라오면 offset과 커서는 어떻게 다르게 동작하나요?" (가산점 포인트)

offset은 "앞에서 N번째"를 매번 다시 세므로, 1페이지를 본 뒤 새 글이 하나
들어오면 2페이지 `LIMIT 20 OFFSET 20`의 창이 한 칸 밀려 **1페이지 마지막 글이
2페이지 첫머리에 다시 나온다.** 삭제가 일어나면 반대로 한 건이
**건너뛰어진다.** 커서는 "이 값 다음"을 조회하므로 삽입·삭제와 무관하게
이어진다. 즉 커서 기반은 성능만이 아니라 **사용자가 보는 결과의 정합성**
문제이기도 하다 — 피드에서 "아까 본 글이 또 나온다"는 CS의 상당수가
offset 페이지네이션이다. 단, 커서도 **정렬 키가 갱신되는 컬럼**(`updated_at`)
이면 행이 위치를 옮겨 다니므로 같은 문제가 재발한다 — 커서의 정렬 키는
불변이어야 한다는 조건이 여기서 나온다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **문법** — MySQL `LIMIT 100000, 20`, PostgreSQL `LIMIT 20
OFFSET 100000`. 비용 구조는 같다. ② **PK 순의 특권** — InnoDB는 클러스터드라
PK 순이면 북마크 룩업이 없지만, PostgreSQL은 힙 구조라 PK 순에도 힙 페치가
붙고 대신 `correlation`이 무게를 정한다. ③ **행 비교** — PostgreSQL은
`(created_at, id) < ($1, $2)`를 B-tree 범위 하나로 실행하지만(`Index Cond:
ROW(...)`), MySQL은 인덱스 최적화를 못 해 OR로 풀어 쓴다(PostgreSQL에서 OR
형태를 쓰면 상한을 중복으로 줘야 한다). ④ **복합 인덱스** — MySQL
세컨더리는 리프에 PK를 품어 `(created_at)`만으로 사실상 `(created_at, PK)`
순이지만, PostgreSQL은 리프가 TID라 `(created_at, id)`를 반드시 명시한다;
지연 조인의 커버링도 같은 이유로 복합 인덱스가 필요하고 VM에 좌우된다.
⑤ **도구** — `Using filesort`·`MAX_EXECUTION_TIME`·슬로 쿼리 로그가
PostgreSQL에서는 `Sort`(`top-N heapsort`, N = offset + limit)·
`statement_timeout`·`auto_explain`/`pg_stat_statements`에 대응한다. 이
다섯을 짚으면 "한쪽만 써봤다"가 아니라 "저장 구조에서 도출했다"로 들린다.

---

## 한 줄 요약

**`OFFSET`은 건너뛰기가 아니라 읽고 버리기다 — B-tree에 "N번째" 좌표가
없어 `Limit` 노드가 100,020건을 세며 버리고, PostgreSQL은 힙 테이블이라
정렬 인덱스가 PK든 아니든 버릴 행에도 가시성 확인을 위한 힙 페치를
100,020번 지불해 비용이 페이지 번호에 선형이다(계획에서 `Limit` 아래 노드의
`actual rows`가 그 증거). 해결책은 네 개를 세트로 — 커서(키셋)로 offset을
없애거나(행 비교 `(created_at, id) < ($1, $2)`를 PostgreSQL은 인덱스 범위
하나로 실행한다), 지연 조인으로 버릴 행의 힙 페치를 없애거나(Index Only
Scan, VM 상태에 좌우), API 레벨 상한으로 깊은 페이지를 거절하거나, 검색
엔진에 위임한다. 커서를 고를 때는 임의 페이지 점프·total count·정렬
유연성·API 호환을 내주는 거래임을 같은 호흡에 말한다.**
