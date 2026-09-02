# 실행 계획 읽기와 느린 쿼리 개선 프로세스 — 견적서(cost·rows)를 읽고, 청구서(actual·Buffers)로 검증하고, 사이클을 팀 자산으로 고정한다

> 핵심 관전 포인트: **`EXPLAIN`은 플래너가 통계를 보고 쓴 "견적서"(추정)이고, `EXPLAIN (ANALYZE, BUFFERS)`는 실제로 실행해 받은 "청구서"(실측)다. PostgreSQL의 계획은 표가 아니라 트리이고, 실행은 들여쓰기가 깊은 안쪽에서 시작해 바깥으로 올라오며, 노드마다 견적(`cost= rows= width=`)과 청구서(`actual time= rows= loops=`)가 나란히 찍힌다. 읽는 순서는 ① 모양(안쪽·아래부터 실행, 조인 노드의 첫 자식이 outer) → ② 노드 이름(`Seq Scan`은 전부 읽은 것, `Index`·`Bitmap` 계열은 좁힌 것 — 단 `Index Cond` 없는 `Index Scan`은 전수 조사) → ③ 추정 `rows` vs 실제 `rows`(자릿수가 다르면 튜닝이 아니라 통계가 먼저 — 1순위 진단) → ④ `Buffers: shared hit/read`(느린 이유가 I/O인지 CPU인지를 가른다) → ⑤ 경고등(`Rows Removed by Filter`·`external merge`·`Batches > 1`·`Heap Fetches`·안쪽 `loops`)이다. 느린 쿼리 개선은 "인덱스 추가해봄 → 빨라짐"이 아니라 측정(`pg_stat_statements`로 가장 비싼 쿼리를 숫자로) → 가설(비용이 새는 지점을 힙 랜덤 I/O 사슬로) → 검증(같은 파라미터의 실측 + 부작용까지 양면으로) → 고정(`auto_explain`·쿼리 수 단정 테스트·`pg_stat_statements` 기준선을 설정과 코드로)의 사이클이며, 마지막 "고정"까지 가야 한 사이클이 끝난 것이다.**

---

## 0. 질문 + 의도

**질문**: "실행 계획(EXPLAIN)을 어떻게 읽나요? 느린 쿼리를 발견했을 때의 개선 프로세스를 설명해주세요."

관련 질문:

- "잘 돌던 쿼리의 실행 계획이 어느 날 갑자기 바뀌어 느려졌습니다. 가능한 원인과 대응은?"
- "ORDER BY가 인덱스를 타는 조건은? filesort는 언제 발생하고 왜 문제가 되나요?"

**PostgreSQL 기준 재해석**: "ORDER BY가 인덱스를 타는 조건은? 계획에 `Sort` 노드가 남는 건 언제이고, `Sort Method: external merge`는 왜 문제인가요?"

**출제 의도**: rationale의 표현 그대로 — "느린 쿼리 개선을 **'인덱스 추가해봄 → 빨라짐'이 아니라 측정→가설→검증의 사이클**로 수행하는지. 프로세스를 묻는 이유는 **이 능력이 쿼리를 넘어 모든 성능 문제에 이식되기 때문**이다." 즉 이 문항은 두 겹이다. 겉은 "PostgreSQL 계획 트리의 노드와 숫자를 읽을 줄 아는가"(인출 테스트)이고, 속은 "성능 문제를 **재현 가능한 절차**로 다루는가"(태도 테스트)다. 인덱스 하나 추가해서 빨라진 경험은 누구나 있다. 면접관이 가르고 싶은 것은 그 경험을 **왜 빨라졌는지 `Buffers` 숫자로 설명하고, 다음에 같은 문제가 재발하지 않도록 무엇을 남겼는가**까지 말하는 사람이다. 전제가 되는 "인덱스를 못 타는가 vs 안 타는가"의 판단 흐름과 비용 모델(힙 페치·랜덤 vs 순차 I/O)은 [인덱스를 걸었는데도 풀스캔](02-index-not-used-full-scan.md)에, 조인 노드 읽는 법은 [JOIN 종류와 실행 방식](06-join-types-and-execution.md)에 있다. 이 문서는 그 위에 **트리 전체를 읽는 순서, 추정 vs 실측, 그리고 프로세스**를 얹는다.

이 문서는 04장에서 **진단 도구를 다루는 자리**다. 다른 문서들이 "계획을 보면 `Rows Removed by Filter`가 크다", "`Heap Fetches`가 늘었다"라고 말할 때 그 어휘가 무슨 뜻인지는 전부 여기서 정의한다. 그래서 1절은 처음 계획을 보는 사람이 **어디서부터 눈을 두어야 하는지**부터 시작한다.

---

## 1. 개념 — `EXPLAIN`은 "견적서"다: 계획 트리를 어디서부터 읽나

### 1-1. 플래너는 데이터를 세지 않는다 — 통계로 추정한다

**플래너(planner)** 는 PostgreSQL에서 "이 SQL을 어떤 순서로, 어떤 방법으로 실행할지"를 정하는 부품이다. 이름 그대로 계획을 세우는 자리이고, 실행은 그다음 단계인 익스큐터(executor)가 한다.

플래너가 계획을 세울 때 **실제 데이터를 세어보지는 않는다.** 100만 행짜리 테이블에서 "`status = 'ACTIVE'`인 행이 몇 개냐"를 매번 세면 그 자체가 쿼리 한 번 값이기 때문이다. 대신 미리 모아 둔 **통계**를 본다.

그 통계를 모으는 명령이 `ANALYZE`다. 테이블에서 표본을 뽑아 분포를 요약해 시스템 카탈로그 `pg_statistic`에 저장하고(사람이 읽는 뷰가 `pg_stats`), autovacuum이 백그라운드에서 주기적으로 이 일을 대신 돌려 준다. 통계에 들어 있는 것은 대략 이런 항목들이다.

| 통계 항목 | 어디에 | 무엇을 알려주나 |
|---|---|---|
| `reltuples` / `relpages` | `pg_class` | 테이블의 대략적인 행 수 / 페이지(8KB 블록) 수 |
| `n_distinct` | `pg_stats` | 컬럼의 고유값 개수 — "이 컬럼으로 좁히면 몇 분의 1로 줄어드나" |
| `most_common_vals` / `most_common_freqs` (MCV) | `pg_stats` | 최빈값 목록과 그 비율 — "`status`의 90%가 `ACTIVE`" 같은 편중을 잡는다 |
| `histogram_bounds` | `pg_stats` | 값의 분포를 구간으로 나눈 경계 — 범위 조건(`created_at > …`)의 선택도 추정 |
| `correlation` | `pg_stats` | 컬럼 값 순서와 물리적 저장 순서의 상관 — 1에 가까우면 인덱스 순서로 읽어도 힙이 순차에 가깝다 |

플래너는 이 통계로 "이 인덱스를 타면 대략 몇 행을 읽겠구나"를 **추정**하고, 가능한 계획 후보들의 추정 비용을 비교해 가장 싼 것을 고른다. `EXPLAIN`은 그렇게 고른 결과를 보여 준다.

> **공사 견적서 비유**
> 견적서에는 "벽지 30롤, 인건비 2일"처럼 **예상** 수량이 적혀 있다. 실제로 공사를 해보면 벽지가 45롤 들 수도 있다. `EXPLAIN`의 `rows=`는 이 "30롤"이고, `EXPLAIN ANALYZE`(2절)의 `actual rows=`가 "45롤"이다. 견적과 청구서가 크게 다르면 견적을 낸 근거(통계)가 틀린 것이다.

그래서 `EXPLAIN`을 읽을 때 붙잡아야 할 첫 전제는 **"여기 적힌 숫자는 전부 추정이고, 추정은 통계가 낡으면 틀린다"** 이다. 이 전제를 놓치면 "EXPLAIN은 멀쩡한데 왜 느리지"에서 멈춘다.

옵션도 여기서 한 번에 고정해 둔다. 이 문서에서 계속 쓰는 조합은 `EXPLAIN (ANALYZE, BUFFERS)` 하나다.

| 옵션 | 하는 일 | 언제 켜나 |
|---|---|---|
| (없음) | 계획과 추정만. **실행하지 않는다** | 첫 진단, 운영에서 언제든 |
| `ANALYZE` | **실제 실행** 후 노드마다 `actual time/rows/loops` | 추정 vs 실측 비교 |
| `BUFFERS` | 노드마다 읽은 페이지 수(`shared hit/read`, `temp`) | ANALYZE와 항상 같이 (최신 버전에서는 ANALYZE 시 기본으로 켜지도록 바뀌었지만 습관적으로 명시한다) |
| `VERBOSE` | 노드별 출력 컬럼(`Output:`), 스키마 한정 이름 | 컬럼 하나 때문에 `Index Only Scan`이 안 되는지 볼 때 |
| `SETTINGS` | 기본값과 다른 플래너 설정을 함께 출력 | "내 세션만 `work_mem`이 달랐나" 확인 |
| `WAL` | 생성한 WAL 양 | DML 비용 볼 때 |
| `FORMAT JSON` | 트리를 JSON으로 | 테스트 단정, 시각화 도구 |

> **주의** — 명령 이름 `ANALYZE`는 두 가지로 쓰인다. 단독 명령 `ANALYZE orders;`는 **통계를 수집**하는 명령이고, `EXPLAIN (ANALYZE) SELECT …`의 `ANALYZE`는 **쿼리를 실제로 실행해 실측을 붙이라**는 옵션이다. 이름만 같고 하는 일이 다르다.

### 1-2. 계획은 표가 아니라 트리다 — 안쪽부터 실행돼 바깥으로 올라온다

처음 `EXPLAIN` 출력을 보면 화살표와 들여쓰기가 뒤엉킨 덩어리로 보인다. 여기에는 규칙이 셋뿐이다.

1. **한 줄이 노드 하나다.** 노드는 "스캔 하나, 조인 하나, 정렬 하나" 같은 **작업 단위**이고, 노드마다 자기 이름(`Seq Scan`, `Sort`, `Nested Loop`…)이 있다.
2. **들여쓰기가 깊을수록 자식이다.** `->` 로 시작하며 한 단계 더 들어간 줄들이 바로 위 노드의 자식이다. 자식이 만든 행을 부모가 받아 처리한다.
3. **실행은 가장 안쪽(들여쓰기가 깊은 쪽)에서 시작해 바깥으로 올라온다.** 맨 위 줄이 마지막에 끝나는 노드다. 그리고 조인 노드의 **첫 번째 자식이 outer(드라이빙, 바깥 루프)**, 두 번째가 inner다.

세 번째가 핵심이다. 출력은 위에서 아래로 인쇄되지만 **실행 순서는 아래에서 위로** 간다. 그래서 "무엇이 먼저 일어났나"를 알려면 눈을 맨 아래·맨 안쪽에 두고 올라와야 한다.

실제 출력 한 벌에 실행 순서와 각 숫자의 뜻을 주석으로 달아 보면 이렇다.

```sql
EXPLAIN
SELECT o.id, o.amount, p.name
FROM orders o
JOIN products p ON p.id = o.product_id
WHERE o.user_id = 100 AND o.status = 'ACTIVE'
ORDER BY o.created_at DESC
LIMIT 20;
-- (orders에는 user_id 단독 인덱스 idx_orders_user만 있다고 하자)
```

```text
 Limit  (cost=64273.36..64273.41 rows=20 width=52)                     <- [5] 마지막: 앞 20건만 남기고 멈춘다
   ->  Sort  (cost=64273.36..64285.36 rows=4800 width=52)              <- [4] 받은 4,800행을 created_at 역순으로 정렬
         Sort Key: o.created_at DESC
         ->  Nested Loop  (cost=0.99..64145.62 rows=4800 width=52)     <- [3] 두 자식을 조인해 4,800행을 위로 올린다
               ->  Index Scan using idx_orders_user on orders o        <- [1] 가장 안쪽 = 가장 먼저 실행 (조인의 첫 자식 = outer)
                     (cost=0.56..61893.40 rows=4800 width=32)
                     Index Cond: (user_id = 100)
                     Filter: (status = 'ACTIVE'::text)
               ->  Index Scan using products_pkey on products p        <- [2] inner: outer가 뱉은 행마다 한 번씩 실행
                     (cost=0.43..0.47 rows=1 width=28)
                     Index Cond: (id = o.product_id)

 실행 순서를 트리로 다시 그리면:

        Limit  [5]
          |
        Sort  [4]
          |
     Nested Loop  [3]
        /        \
   orders        products
  Index Scan     Index Scan
     [1]            [2]  (outer 행 수만큼 반복)
   = outer        = inner
```

읽으면 이런 이야기가 된다 — "`orders`에서 `user_id = 100`인 행을 인덱스로 찾아 꺼내고([1]), 꺼낸 행마다 `products`를 PK로 한 건씩 찾아 붙이고([2], [3]), 그 결과를 `created_at` 역순으로 정렬한 뒤([4]), 앞 20건만 반환한다([5])."

### 1-3. 노드 한 줄 해부 — `cost`·`rows`·`width`가 각각 무엇인가

노드 줄의 괄호 안 숫자를 하나씩 뜯는다. `ANALYZE`를 켜면 괄호가 두 개가 되고, 두 번째가 실측이다.

```text
 Index Scan using idx_orders_user on orders o
        (cost=0.56..61893.40 rows=4800 width=32)          <- 견적서 (EXPLAIN이 늘 주는 것)
        (actual time=0.071..283.917 rows=4720 loops=1)    <- 청구서 (ANALYZE를 켰을 때만)
   Index Cond: (user_id = 100)
   Filter: (status = 'ACTIVE'::text)
   Rows Removed by Filter: 42495                          <- ANALYZE일 때만
   Buffers: shared hit=5412 read=41856                    <- BUFFERS일 때만
```

**`cost=시작..전체`** — 점 두 개로 이어진 두 숫자다. 앞이 **시작 비용**(첫 행을 내보내기 전까지 드는 비용), 뒤가 **전체 비용**(끝까지 드는 비용)이다.

이 둘을 나눠 놓은 이유는 `LIMIT` 때문이다. `Sort`는 입력을 전부 읽어야 첫 행이 나오므로 시작 비용이 크고, `Index Scan`은 시작 비용이 거의 0이다. "앞 20건만 필요한" 쿼리에서는 **시작 비용이 작은 계획이 이긴다** — 20건을 받자마자 멈출 수 있기 때문이다. 위 예시의 `Limit`이 `cost=64273.36..64273.41`로 시작과 전체가 거의 같은 것은, 아래 `Sort`가 이미 다 끝난 뒤에야 첫 행이 나오기 때문이다.

단위는 밀리초가 아니다. **`seq_page_cost = 1.0`(순차로 읽은 페이지 한 장)을 1로 잡은 상대값**이다. 그래서 `cost=64273`은 "대략 순차 페이지 6만 4천 장어치 일"이라는 뜻이지 64초라는 뜻이 아니다. 같이 보는 파라미터가 `random_page_cost`(기본 4.0)로 "랜덤하게 흩어진 페이지 한 장은 순차 네 장 값"이라는 선언이다 — 회전 디스크 시절의 값이라 SSD면 1.1 근처로 낮춰야 플래너가 인덱스를 제값에 평가한다.

**`rows=`** — 이 노드가 **내보낼 것으로 추정한** 행 수다. 헷갈리기 쉬운 지점 하나 — 이 수는 노드의 조건(`Index Cond`·`Filter`)을 **모두 적용한 뒤**의 수다. "인덱스에서 몇 개를 꺼냈나"가 아니라 "이 노드가 부모에게 몇 개를 올려보내나"다.

**`width=`** — 그 행 하나의 평균 바이트다. `width=32`면 이 노드를 통과하는 행이 평균 32바이트라는 뜻이고, `SELECT *`로 큰 `text`·`jsonb` 컬럼을 끌고 다니면 여기가 커진다. 정렬·해시가 메모리에 들어가느냐를 가르는 숫자라 `Sort` 노드 아래에서 특히 의미가 있다(`rows × width`가 대략의 메모리 요구량).

**`actual time=첫행..마지막행`** — 밀리초 단위 실측이다. 앞이 첫 행이 나온 시각, 뒤가 마지막 행이 나온 시각이며, 둘 다 **이 노드가 시작된 뒤로 경과한 시간**이다.

**`actual rows=`** — 실제로 내보낸 행 수. **`loops=`** — 이 노드가 몇 번 반복 실행됐나. **여기에 큰 함정이 있다 — `actual time`과 `actual rows`는 loops당 평균값이다.** 총량을 보려면 `× loops`를 해야 한다(2-2에서 다시 짚는다).

**`Index Cond` vs `Filter`** — `Index Cond`는 인덱스 안에서 걸러진 조건, `Filter`는 힙(테이블 본체)에서 행을 가져온 **뒤에** 검사한 조건이다. 그래서 `Filter`에 걸려 버려진 행은 **이미 힙 랜덤 I/O 비용을 지불한 뒤에** 버려진 행이다. 그 수가 **`Rows Removed by Filter`** 이고, "많이 읽고 대부분 버린다"의 계산서다.

**`Buffers: shared hit= read=`** — `hit`은 `shared_buffers`(PostgreSQL의 공유 캐시)에서 찾은 페이지 수, `read`는 그 밖에서 읽어 온 수다. 주의할 점 — PostgreSQL은 `shared_buffers`와 OS 페이지 캐시의 **이중 캐시** 구조라 `read`가 곧 디스크 접근은 아니다(`track_io_timing = on`이면 `I/O Timings:`로 진짜 I/O 시간이 붙는다). **`temp read/written`** 은 정렬·해시가 디스크로 넘친 양이다. 그리고 **노드의 Buffers는 자식 수치를 포함한 누적값**이라, 어느 노드에서 갑자기 커지는지를 아래에서 위로 올라가며 본다. Buffers를 왜 시간보다 먼저 보는지는 2-4에서 따로 다룬다.

트리 맨 아래에는 **`Planning Time`** 과 **`Execution Time`**(ANALYZE일 때만)이 따로 찍힌다. 짧은 쿼리가 수백 번 도는데 Planning Time이 실행보다 크면 준비문(prepared statement)으로 계획을 재사용할 후보다. 큰 쿼리에는 **`JIT:`** 블록(`Functions`, `Timing: … Emission …`)이 붙을 수 있다 — 추정 비용이 `jit_above_cost`를 넘으면 표현식을 기계어로 컴파일하는데, 추정이 틀려 짧은 쿼리에 붙으면 컴파일 시간이 실행보다 길어지는 역효과가 난다(그때는 `jit = off`).

### 1-4. 읽는 순서 암기 카드 — 다섯 단계

긴장하면 목록은 두 개에서 끊긴다. 그래서 이 절은 **읽는 순서 그대로 외우는 카드**로 만든다. 순서가 곧 진단 순서다.

```text
① 모양      : 안쪽(깊은 들여쓰기)·아래부터 실행. 조인 노드의 첫 자식 = outer(드라이빙)
② 노드 이름  : 스캔 방식(Seq / Index / Index Only / Bitmap) — "전부 읽었나, 좁혔나"
③ rows      : 추정 rows  vs  actual rows — 자릿수가 다르면 통계 문제. 1순위 진단
④ Buffers   : shared hit / read — 어느 노드가 페이지를 얼마나 읽었나 (자식 포함 누적)
⑤ 경고등     : Rows Removed by Filter / Sort Method: external / Batches > 1
              / Heap Fetches / 안쪽 노드의 loops
```

③이 1순위인 이유는 2-3에서 계획 두 벌로 보여 준다 — **추정이 틀리면 그 위의 모든 결정이 함께 틀리기** 때문이다.

### 1-5. 스캔 노드 사전 — "전부 읽었나, 좁혔나"

②에서 보는 노드 이름들을 사전으로 고정한다. 스캔 노드는 트리의 가장 안쪽에 있는, 테이블에서 행을 처음 꺼내는 노드다.

| 노드 | 하는 일 | 같이 보는 것 |
|---|---|---|
| `Seq Scan` | 힙을 처음부터 끝까지 **순차로** 읽는다 | `Filter` + `Rows Removed by Filter`가 크면 "많이 읽고 대부분 버림" |
| `Index Scan` | B-tree에서 시작점을 찾아 인덱스 순서로 읽고, 엔트리마다 **TID로 힙을 찾아간다**(랜덤 I/O) | `Index Cond`(인덱스에서 거른 조건)·`Filter`(힙에서 거른 조건). **`Index Cond`가 없으면 인덱스 전체 순회** — 정렬 순서만 빌린 전수 조사 |
| `Index Only Scan` | 인덱스만 읽고 힙에 안 간다(커버링). 단 **visibility map**이 "전부 가시"라고 보증하는 페이지만 생략 | `Heap Fetches: N` — 크면 커버링이 무력화된 상태(VACUUM 부족, 갱신 잦은 테이블) |
| `Bitmap Index Scan` → `Bitmap Heap Scan` | 인덱스에서 TID를 모아 **블록 번호순으로 정렬한 비트맵**을 만든 뒤 힙을 순차에 가깝게 읽는다. 여러 인덱스를 `BitmapOr`/`BitmapAnd`로 합칠 수 있다 | `Recheck Cond`, `Heap Blocks: exact= lossy=` — `lossy`가 있으면 `work_mem` 부족으로 비트맵이 페이지 단위로 뭉개져 힙에서 재검사(`Rows Removed by Index Recheck`) |
| `Parallel Seq Scan` + `Gather` | 워커 여럿이 힙을 나눠 읽고 리더가 모은다 | `Workers Planned/Launched`. 대량 스캔의 **정상 선택**일 수 있다 — "인덱스가 없어서"라고 단정하지 않는다 |

여기서 **TID**(tuple identifier)는 "행 하나의 물리적 주소"다. `(블록 번호, 블록 안 몇 번째 슬롯)` 쌍이고, 인덱스 엔트리에는 키 값과 이 TID만 들어 있다. 그래서 인덱스만으로 답이 안 나오면 TID를 들고 힙 페이지를 찾아가야 하는데, TID들이 힙 여기저기에 흩어져 있으므로 이 접근이 **랜덤 I/O**가 된다.

**경계선은 "좁혔나, 전부 읽었나"다.** `Seq Scan`과 `Index Cond` 없는 `Index Scan`은 전부 읽은 것이고, 나머지는 좁힌 것이다. 다만 PostgreSQL에서 진짜 경계선은 노드 이름이 아니라 **읽은 행 대비 남긴 행**(`Rows Removed by Filter`)과 **읽은 페이지 수**(`Buffers`)다. `Index Scan`인데 `Rows Removed by Filter`가 `actual rows`의 열 배면, 이름만 인덱스지 비용은 풀스캔에 가깝다. "인덱스는 탔는데요"라는 말은 이 두 숫자를 보기 전까지 아무것도 보장하지 않는다.

**(가산점 포인트)** `Bitmap Heap Scan`은 **랜덤 vs 순차 I/O**라는 비용 모델이 스캔 방식으로 구현된 사례다. 인덱스에서 얻은 TID 목록은 힙 위치가 뒤죽박죽이라 그대로 읽으면 페이지를 여기저기 찌른다(랜덤). 비트맵은 그 TID를 **블록 번호순으로 정렬한 뒤** 읽어 인접 페이지를 연달아 읽게 만들고(순차에 가깝게), 그래서 플래너는 "좁혀지긴 하는데 수천~수만 행"인 중간 선택도에서 `Index Scan` 대신 이걸 고른다. "DB가 랜덤 I/O를 얼마나 싫어하면 스캔 방식 하나를 따로 만들었겠는가"로 기억하면 비용 모델이 같이 굳는다. 그리고 이것도 인덱스를 쓴 계획이다 — 이름에 `Index Scan`이 없다고 풀스캔으로 오해하지 않는다.

### 1-6. `Index Cond` vs `Filter` — 그리고 PostgreSQL에는 "몇 번째 컬럼까지 썼나"가 없다

1-3에서 정의한 둘을 한 겹 더 판다. 낭비의 층이 다르기 때문이다.

- `Index Cond`: 인덱스 컬럼에 대한 조건. **구간을 좁히는 조건(액세스 조건)과, 구간은 못 좁히고 인덱스 안에서 걸러내기만 하는 조건이 여기 함께 찍힌다.**
- `Filter`: 인덱스에 없는 컬럼의 조건. 힙에서 행을 읽은 **뒤에** 검사한다 — 버릴 행에 힙 랜덤 I/O를 이미 지불한 상태.

여기서 PostgreSQL 고유의 함정이 나온다. 복합 인덱스 `(user_id, status, created_at)`에서 가운데 `status` 조건이 빠지면 `created_at`은 구간을 못 좁히고 인덱스 안에서 하나씩 걸러지는데, **계획 텍스트는 완전히 좁힌 경우와 똑같이 보인다.**

```sql
CREATE INDEX idx_orders_user_status_created ON orders (user_id, status, created_at);

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE user_id = 100 AND created_at > '2026-08-01';
--  Index Scan using idx_orders_user_status_created on orders
--    Index Cond: ((user_id = 100) AND (created_at > '2026-08-01 00:00:00+09'::timestamp with time zone))
--    (actual rows=2104 loops=1)
--    Buffers: shared hit=2318        <- user 100의 엔트리 전부(4만 7천)를 훑은 흔적
-- created_at이 Index Cond에 찍혀 있지만 구간을 좁히진 못했다(leftmost prefix).
-- "인덱스 탔다"고 안심하면 안 되는 경우 — 판별은 계획 텍스트가 아니라 Buffers다.
-- (user_id, created_at) 인덱스였다면 같은 결과에 Buffers: shared hit=61 수준.
```

즉 **"인덱스를 얼마나 깊이 탔는가"는 PostgreSQL에서 ① 인덱스 정의의 컬럼 순서와 조건의 등호/범위를 대조하고 ② `BUFFERS`의 읽은 페이지 수로** 판별한다([복합 인덱스 컬럼 순서](08-composite-index-column-order.md)). `Rows Removed by Filter`는 "인덱스에 없는 컬럼 때문에 힙까지 읽고 버린 양"이고, Buffers의 과다는 "인덱스 안에서 훑고 버린 양"이다 — 둘은 낭비의 층이 다르다.

### 1-7. 그 밖의 노드 사전 — 조인·정렬·집계·기타

스캔이 아닌 노드들, 즉 자식이 올려 준 행을 받아 가공하는 노드들이다.

| 노드 | 뜻 | 경고등 |
|---|---|---|
| `Nested Loop` / `Hash Join` + `Hash` / `Merge Join` | 조인 3방식 ([06 문서](06-join-types-and-execution.md)) | inner의 `loops`(바깥 행 수만큼 반복), inner가 `Seq Scan`이면 조인 키 인덱스 부재. `Hash`의 `Batches > 1` = 디스크 스필. `Merge` 아래 `Sort`가 붙었는지 |
| `Sort` | 정렬 | `Sort Method: quicksort Memory:`(메모리) / `top-N heapsort`(LIMIT 병용 — 메모리는 N건 몫이지만 **입력은 전부 읽는다**) / `external merge Disk:`(`work_mem` 초과 → 디스크) |
| `Incremental Sort` (PG 13+) | 앞 컬럼이 이미 정렬돼 있을 때 뒤 컬럼만 그룹별로 정렬 | `Presorted Key` |
| `HashAggregate` / `GroupAggregate` | `GROUP BY`·`DISTINCT`. 해시로 모으거나, 정렬된 입력을 순서대로 묶거나 | `Batches > 1`, `Disk Usage:`, `temp read/written` = 스필 |
| `Limit` | 자식에게서 N행만 받고 **멈춘다** | 자식의 `actual rows`가 N보다 훨씬 크면 LIMIT을 못 살린 것(아래에 `Sort`가 있을 때 전형) |
| `Materialize` / `Memoize` (PG 14+) | 안쪽 결과를 메모리에 받아 두고 반복 스캔 / NL 안쪽 탐색 결과를 조인 키별로 캐시 | `Memoize`의 `Hits/Misses/Evictions` — Hits가 크면 공짜로 빨라진 상태 |
| `Gather` / `Gather Merge` | 병렬 워커 결과 수집(Merge는 정렬 유지) | `Workers Launched`가 `Planned`보다 적으면 워커 풀 부족 |
| `CTE Scan` / `Subquery Scan` | `WITH … AS MATERIALIZED` 결과 스캔(PG 12+는 한 번만 쓰는 단순 CTE를 인라인) / FROM 절 서브쿼리 | `Subquery Scan`이 남아 있으면 인라인이 막힌 이유(집계·LIMIT 등)를 본다 |
| `SubPlan` / `hashed SubPlan` | WHERE 절의 서브쿼리. **상관 서브쿼리는 바깥 행마다 재실행** | `SubPlan 1` 아래 노드의 `loops` = 바깥 행 수. 바깥이 10만 행이면 10만 번 — 조인으로 푼다. `hashed`는 한 번 실행해 해시로 들고 있는 것이라 안전 |

### 1-8. 경고등 표 — 위험 신호와 좋은 신호

⑤에서 눈이 멈춰야 할 문자열들이다. 이 표는 그대로 진단 체크리스트로 쓴다.

| 신호 | 뜻 | 판정 |
|---|---|---|
| `Rows Removed by Filter: 42495` (actual rows=4720) | 힙까지 읽고 **90%를 버렸다** — 인덱스가 조건을 절반만 덮는다 | **위험** — 인덱스에 컬럼을 넣으면 읽는 양 자체가 준다 |
| `Sort Method: external merge  Disk: 21544kB` | `work_mem`을 넘겨 디스크 정렬 | **위험** — 정렬을 인덱스로 없애거나, 세션 `work_mem` |
| `Batches: 8` (`Hash`·`HashAggregate`) | 해시가 메모리를 넘쳐 디스크로 쪼개짐 | **위험** — 빌드 사이드를 줄이거나 `work_mem` |
| `Heap Fetches: 38211` (`Index Only Scan`) | visibility map이 낡아 힙을 방문 | **위험** — VACUUM 상태 확인 |
| inner `Seq Scan` + `loops=4720` | 안쪽 테이블을 4,720번 통순회 | **위험** — 조인 키 인덱스 |
| 추정 `rows=1000` vs `actual rows=500000` | 통계가 현실과 어긋남 | **위험, 그리고 1순위** — 튜닝 전에 통계 교정 (2-3) |
| `Index Only Scan` + `Heap Fetches: 0` | 힙 방문 0회 | **최고의 신호** |
| `Index Scan Backward` + `Limit`, `Sort` 없음 | 정렬을 인덱스 순서로 해결, 앞 N건만 읽고 종료 | 좋음 |
| `Memoize  Hits: 4719 Misses: 1` | 반복 탐색을 캐시로 흡수 | 좋음 |

> **MySQL 대조** — MySQL의 `EXPLAIN`은 트리가 아니라 **테이블 접근 하나당 한 행인 표**다: 위에서 아래가 실행 순서(맨 위가 드라이빙), `type`(접근 등급 — `const > eq_ref > ref > range > index > ALL`, 경계선은 `range`와 `index` 사이), `key`/`key_len`(어느 인덱스를 **몇 바이트까지** 썼나 — 복합 인덱스의 깊이를 알려주는 유일한 칸), `rows × filtered`(읽어서 남기는 비율), `Extra`(위험 3: `Using filesort`·`Using temporary`·`Using join buffer`, 좋은 3: `Using index`·`Using index condition`·`Using MRR`). PostgreSQL 대응은 — `type: ALL`은 `Seq Scan`, `type: index`는 `Index Cond` 없는 `Index Scan`, `key_len`은 대응물이 없고(Buffers로 판별), `filtered`는 `Rows Removed by Filter`, `Using filesort`는 `Sort` 노드, `Using temporary`는 `HashAggregate`/`Materialize`, `Using index`는 `Index Only Scan`, `Using index condition`(ICP)은 `Index Cond`의 인덱스 내 검사(PostgreSQL은 기본 동작이라 이름이 없다), `Using MRR`은 `Bitmap Heap Scan`, `DEPENDENT SUBQUERY`는 `SubPlan`(loops 큰 것)에 해당한다.

---

## 2. 동작 — 추정과 실측을 나란히 놓는다: `EXPLAIN` vs `EXPLAIN (ANALYZE, BUFFERS)`

### 2-1. `ANALYZE`는 진짜로 실행한다 — 그래서 UPDATE/DELETE에 쓰면 데이터가 바뀐다

1절의 견적서는 실행하지 않고 받는다. `ANALYZE` 옵션을 붙이면 **쿼리를 실제로 실행**하고, 트리의 각 노드에 실측값을 나란히 붙여 준다. `BUFFERS`까지 켜면 노드마다 읽은 페이지 수가 붙는다. 이 하나로 "견적서 vs 청구서"를 한 화면에서 비교할 수 있다.

"실제로 실행한다"는 말은 비유가 아니다. **데이터를 바꾸는 문에 붙이면 데이터가 진짜로 바뀐다.**

```sql
-- EXPLAIN: 실행하지 않는다. 운영 DB에서도 안전하다.
EXPLAIN UPDATE orders SET status = 'CANCELED' WHERE user_id = 100;
-- 계획만 출력된다. orders의 데이터는 하나도 바뀌지 않았다.

-- EXPLAIN (ANALYZE): 실측을 붙이려고 "실제로 실행"한다 = UPDATE가 진짜 일어난다.
EXPLAIN (ANALYZE) UPDATE orders SET status = 'CANCELED' WHERE user_id = 100;
-- 계획도 나오고, 주문 4,720건의 status도 진짜로 바뀐다. 되돌릴 방법이 없다.

-- 그래서 변경문은 반드시 트랜잭션으로 감싸고 롤백한다.
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) UPDATE orders SET status = 'CANCELED' WHERE user_id = 100;
ROLLBACK;   -- 계획과 실측은 이미 손에 들어왔고, 데이터 변경만 취소된다
```

`BEGIN … ROLLBACK`으로 감싸는 것이 표준 습관이지만, 롤백이 **모든 것**을 되돌리지는 않는다는 점까지 알고 써야 한다.

- **행 락은 ROLLBACK 시점까지 유지된다.** UPDATE가 건드린 4,720행은 그동안 다른 트랜잭션의 갱신을 막는다. 운영 프라이머리에서 대량 UPDATE를 이렇게 재보면 그 자체가 장애가 될 수 있다.
- **시퀀스 값은 소모된다.** `nextval()`은 롤백해도 되돌아가지 않는다(동시성을 위해 의도된 동작이다). INSERT를 재보면 ID에 구멍이 생긴다.
- **트리거가 실제로 발화한다.** 트리거가 DB 안에서만 일한다면 함께 롤백되지만, 외부로 나가는 부수효과(다른 시스템 호출 등)는 되돌아오지 않는다.
- **WAL이 실제로 쌓인다.** 롤백해도 이미 기록된 WAL은 남으므로 복제 지연과 디스크를 건드린다.

그래서 원칙은 **읽기 레플리카나 운영 규모 스테이징에서 돌리는 것**이고, 운영 프라이머리에서 꼭 해야 한다면 SELECT만, 트래픽 낮은 시간에, `statement_timeout`을 걸고 한다.

### 2-2. 실측 계획 한 벌 — 세 가지 방법으로 읽는다

1-2에서 본 그 쿼리에 `ANALYZE, BUFFERS`를 붙인 결과다.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, o.amount, p.name
FROM orders o
JOIN products p ON p.id = o.product_id
WHERE o.user_id = 100 AND o.status = 'ACTIVE'
ORDER BY o.created_at DESC
LIMIT 20;
```

```text
 Limit  (cost=64273.36..64273.41 rows=20 width=52) (actual time=291.404..291.411 rows=20 loops=1)
   Buffers: shared hit=24292 read=41856
   ->  Sort  (cost=64273.36..64285.36 rows=4800 width=52) (actual time=291.402..291.406 rows=20 loops=1)
         Sort Key: o.created_at DESC
         Sort Method: top-N heapsort  Memory: 28kB
         Buffers: shared hit=24292 read=41856
         ->  Nested Loop  (cost=0.99..64145.62 rows=4800 width=52) (actual time=0.093..289.517 rows=4720 loops=1)
               Buffers: shared hit=24292 read=41856
               ->  Index Scan using idx_orders_user on orders o  (cost=0.56..61893.40 rows=4800 width=32) (actual time=0.071..283.917 rows=4720 loops=1)
                     Index Cond: (user_id = 100)
                     Filter: (status = 'ACTIVE'::text)
                     Rows Removed by Filter: 42495
                     Buffers: shared hit=5412 read=41856
               ->  Index Scan using products_pkey on products p  (cost=0.43..0.47 rows=1 width=28) (actual time=0.003..0.003 rows=1 loops=4720)
                     Index Cond: (id = o.product_id)
                     Buffers: shared hit=18880
 Planning Time: 0.412 ms
 Execution Time: 291.487 ms
```

**① 괄호 두 개를 나란히 본다.** `(cost=… rows=4800)`이 추정, `(actual time=… rows=4720 loops=1)`이 실측이다. 여기서는 추정 4,800 대 실측 4,720으로 거의 맞다. **이 두 `rows`가 자릿수 단위로 어긋나면 통계가 틀린 것**이고, 그때는 튜닝이 아니라 `ANALYZE orders`가 먼저다(2-3).

주의할 것 하나 — 1-3에서 짚었듯 노드의 `rows`는 조건을 다 적용한 뒤의 수다. "인덱스에서 몇 개를 꺼냈나"를 알려면 `actual rows + Rows Removed by Filter`로 되짚어야 한다. 여기서는 4,720 + 42,495 = **47,215건**을 힙에서 읽고 그중 4,720건만 남긴 것이다.

**② `actual time`은 `첫 행..마지막 행` 밀리초이고, `loops`만큼 반복된 평균이다.** `Index Scan using products_pkey … (actual time=0.003..0.003 rows=1 loops=4720)`은 "한 번에 0.003ms, 이걸 4,720번 했다"는 뜻이다. 총비용은 `0.003 × 4720 ≈ 14ms`이고, 읽은 페이지도 `Buffers: shared hit=18880`으로 이미 누적돼 있다(한 번에 4페이지씩 4,720번).

**안쪽 노드의 시간과 행 수는 반드시 `loops`를 곱해서 읽어야 한다** — 이걸 놓치면 "조인은 0.003ms밖에 안 걸리는데?"라는 오독이 나온다. 병렬 계획의 `Parallel Seq Scan`도 같은 규칙이다 — `loops`가 리더 + 워커 수이고 `rows`는 프로세스당 평균이다.

**③ 시간과 Buffers가 어디서 튀는지 아래에서 위로 올라간다.** 위 예시에서 `Index Scan … on orders o`가 0.071ms에 시작해 283.917ms에 끝났고, 이 노드 혼자 `shared hit=5412 read=41856` — 페이지 4만 7천 장을 읽었다.

무슨 일이 있었는지를 사슬로 풀면 이렇다. 인덱스에서 `user_id = 100`인 엔트리 4만 7천 개를 찾고(여기까지는 인덱스 리프를 순차로 훑는 것이라 싸다), **엔트리마다 TID로 힙 페이지를 찌르고**(랜덤 I/O — 여기가 비싸다), 그렇게 읽어 온 4만 7천 행 중 4,720행만 `status` 필터를 통과했다. **비용의 90%가 "결국 버릴 행을 힙에서 랜덤 I/O로 읽는 데" 쓰였다.**

그 위 `Sort`는 `top-N heapsort Memory: 28kB`로 메모리는 20건 몫만 썼지만, 입력 4,720행을 **다 받은 뒤에야** 첫 행을 내보냈다(`actual time=291.402..`). `LIMIT 20`이 있어도 정렬은 전체 입력을 봐야 하기 때문이다. 이것이 3-2에서 세울 가설의 근거다.

### 2-3. 추정과 실측이 어긋나는 것이 1순위 신호 — 계획 두 벌로 보기

암기 카드 ③이 왜 1순위인지를 실제 계획 두 벌로 본다. **추정이 틀리면 그 위의 모든 결정이 함께 틀리기** 때문이다.

상황은 이렇다. 어제 새벽 배치가 8월치 주문 55만 건을 `orders`(총 500만 건)에 적재했다. 그런데 autovacuum의 analyze 임계(기본은 행의 10% 변경)에 걸리지 않아 **통계는 적재 이전 상태 그대로**다. 통계상 `created_at >= '2026-08-01'`인 행은 1,000건 남짓으로 보인다.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT u.name, o.id, o.amount
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.created_at >= '2026-08-01' AND o.status = 'ACTIVE';
```

```text
[before — 통계가 낡은 상태의 계획]

 Nested Loop  (cost=0.99..9424.55 rows=1000 width=48) (actual time=0.061..41288.402 rows=500000 loops=1)
   Buffers: shared hit=1503244 read=48122
   ->  Index Scan using idx_orders_created on orders o  (cost=0.43..1404.55 rows=1000 width=24) (actual time=0.028..1284.117 rows=500000 loops=1)
         Index Cond: (created_at >= '2026-08-01 00:00:00+09'::timestamp with time zone)
         Filter: (status = 'ACTIVE'::text)
         Rows Removed by Filter: 51230
         Buffers: shared hit=53122 read=48122
   ->  Index Scan using users_pkey on users u  (cost=0.56..8.01 rows=1 width=32) (actual time=0.078..0.078 rows=1 loops=500000)
         Index Cond: (id = o.user_id)
         Buffers: shared hit=1450122
 Planning Time: 0.331 ms
 Execution Time: 41402.118 ms
```

읽는 순서대로 짚는다.

**③에서 즉시 걸린다.** 맨 위 `Nested Loop`가 `rows=1000` 추정인데 `actual rows=500000`이다. **500배**다. 자릿수가 다르면 그다음은 볼 것도 없이 통계 문제다.

**그리고 그 오추정이 조인 방식 선택을 통째로 틀리게 만들었다.** 플래너의 계산은 이랬다.

```text
플래너가 비교한 두 후보 (추정 1,000행 기준)

  Nested Loop : orders 인덱스 스캔        1,404.55
              + 1,000행 × inner 탐색 8.01    8,010.00
              + 행당 처리 비용                  10.00   =     9,424.55   <- 이겼다
  Hash Join   : users 해시 빌드           2,435.00
              + orders 순차 스캔        177,122.00
              + 조인 처리 비용             6,229.19   =   185,786.19

실제(50만 행)로 다시 계산하면 순위가 뒤집힌다

  Nested Loop : 1,404.55 + 500,000행 × 8.01        ≈ 4,006,405   <- 21배 비싸다
  Hash Join   : 테이블을 한 번씩만 읽으므로 그대로     185,786
```

Nested Loop는 **바깥 행 하나마다 안쪽을 한 번씩 탐색**하는 방식이라, 바깥 행이 1,000개일 때는 최고의 선택이고 50만 개가 되면 최악의 선택이 된다. 실측이 그대로 보여 준다 — inner `Index Scan using users_pkey`가 `loops=500000`, 한 번에 0.078ms이므로 총 `0.078 × 500,000 = 39,000ms`. **41초짜리 쿼리의 39초가 이 반복이다.**

Buffers도 같은 말을 한다. inner 노드 혼자 `shared hit=1450122` — 같은 users 페이지들을 50만 번 되짚느라 **145만 페이지 읽기**를 기록했다. 캐시에 다 있어서(`hit`) 디스크는 안 갔지만, 페이지를 찾고 락을 잡고 튜플을 꺼내는 CPU 비용은 그대로 나갔다.

이제 통계만 고친다. **인덱스도, 쿼리도 건드리지 않는다.**

```sql
ANALYZE orders;   -- 표본을 다시 뽑아 pg_statistic을 갱신. 수 초면 끝난다.
```

```text
[after — ANALYZE 후, 같은 쿼리]

 Hash Join  (cost=2435.00..185786.19 rows=498320 width=48) (actual time=42.109..2184.663 rows=500000 loops=1)
   Hash Cond: (o.user_id = u.id)
   Buffers: shared hit=54935 read=48122
   ->  Seq Scan on orders o  (cost=0.00..177122.00 rows=498320 width=24) (actual time=0.021..1189.442 rows=500000 loops=1)
         Filter: ((created_at >= '2026-08-01 00:00:00+09'::timestamp with time zone) AND (status = 'ACTIVE'::text))
         Rows Removed by Filter: 4500000
         Buffers: shared hit=54000 read=48122
   ->  Hash  (cost=2135.00..2135.00 rows=120000 width=32) (actual time=41.802..41.803 rows=120000 loops=1)
         Buckets: 131072  Batches: 1  Memory Usage: 8266kB
         Buffers: shared hit=935
         ->  Seq Scan on users u  (cost=0.00..2135.00 rows=120000 width=32) (actual time=0.011..13.402 rows=120000 loops=1)
               Buffers: shared hit=935
 Planning Time: 0.402 ms
 Execution Time: 2298.117 ms
```

**41.4초에서 2.3초로, 18배.** 바뀐 것은 통계뿐이다.

두 계획을 나란히 놓고 보면 무엇이 어떻게 연쇄했는지가 보인다.

| | before (통계 낡음) | after (`ANALYZE` 후) |
|---|---|---|
| 추정 rows / 실제 rows | 1,000 / 500,000 (**500배 어긋남**) | 498,320 / 500,000 (거의 일치) |
| 조인 방식 | `Nested Loop` — inner를 50만 번 반복 | `Hash Join` — 양쪽을 한 번씩만 읽는다 |
| inner의 `loops` | 500,000 | (해시 조인에는 반복이 없다) |
| Buffers 합계 | 1,551,366 | 103,057 |
| Execution Time | 41,402ms | 2,298ms |

**연쇄의 방향이 중요하다.** 잘못된 것은 "조인 방식"이 아니라 "행 수 추정"이었고, 조인 방식은 그 추정을 성실하게 따른 결과다. 그래서 여기서 `SET enable_nestloop = off` 같은 것으로 조인 방식만 눌러도 근본 원인은 그대로 남는다 — 같은 오추정 위에서 다른 쿼리의 조인 순서, 인덱스 선택, 정렬 방식이 계속 틀린다.

**추정이 어긋나는 원인은 크게 셋이다.**

1. **통계가 낡았다.** 위 사례처럼 대량 적재·삭제 직후, 또는 큰 테이블이라 autovacuum의 analyze 임계(행의 10%)에 좀처럼 안 닿는 경우다. 처방은 `ANALYZE 테이블`, 그리고 테이블 단위로 임계 낮추기.
2. **표본이 부족하다.** 기본 `default_statistics_target`은 100이라 히스토그램 구간과 MCV 목록이 각각 100개다. 값이 아주 다양하거나 희귀 값이 중요한 컬럼은 `ALTER TABLE … ALTER COLUMN status SET STATISTICS 1000`으로 표본을 키운다.
3. **컬럼 사이의 상관관계를 못 잡았다.** 플래너는 조건들을 **독립으로 가정해 선택도를 곱한다.** `city = '서울' AND zipcode = '06236'`처럼 한쪽이 다른 쪽을 사실상 결정하는 경우, 실제로는 거의 같은 집합인데 추정은 두 비율을 곱해 심하게 과소추정한다. 처방이 확장 통계 `CREATE STATISTICS … (dependencies, ndistinct, mcv) ON city, zipcode FROM addresses`다.

**"추정이 틀렸다"를 확인하는 것 자체가 `EXPLAIN`만으로는 불가능하다**는 점도 짚어 둔다. 추정만 있는 견적서에는 비교 대상이 없기 때문이다. `rows` 두 개를 나란히 보려면 반드시 `ANALYZE`를 켜야 한다 — 이것이 실무에서 `EXPLAIN (ANALYZE, BUFFERS)`가 사실상 기본 조합인 이유다.

### 2-4. `BUFFERS`가 왜 중요한가 — "느린 이유가 I/O인가 CPU인가"

`Execution Time`이 있는데 왜 `Buffers`를 굳이 보는가. 두 가지 이유가 있다.

**첫째, 시간은 캐시 상태에 따라 매번 달라져서 판단이 흔들린다.** 같은 쿼리, 같은 계획을 두 번 돌린 결과다.

```text
[1회차 — 캐시가 비어 있는 상태]
 ->  Bitmap Heap Scan on orders o  (actual time=12.402..3801.118 rows=47215 loops=1)
       Buffers: shared hit=12 read=48110
       I/O Timings: shared read=3612.441
 Execution Time: 3842.907 ms

[2회차 — 방금 읽어서 shared_buffers에 다 올라온 상태]
 ->  Bitmap Heap Scan on orders o  (actual time=8.117..271.884 rows=47215 loops=1)
       Buffers: shared hit=48122 read=0
       I/O Timings: (없음 — 디스크를 안 갔다)
 Execution Time: 289.331 ms
```

시간은 3,842ms에서 289ms로 **13배** 달라졌지만, **읽은 페이지 수는 48,122장으로 똑같다.** 계획이 같으면 읽는 페이지 수는 거의 변하지 않기 때문이다. 그래서 개선 전후를 비교할 때 **기준으로 삼아야 할 숫자는 시간이 아니라 Buffers다.** "빨라진 것 같다"를 "읽는 페이지가 66,148장에서 103장으로 줄었다"로 바꿔 말할 수 있어야 한다.

**둘째, `hit`과 `read`의 구성비가 병목의 성격을 알려준다.**

| 관찰 | 해석 | 다음 행동 |
|---|---|---|
| `read`가 크고 `I/O Timings`가 실행 시간의 대부분 | **I/O 병목** — 실제로 디스크(또는 OS 캐시 밖)에서 읽어 오느라 느리다 | 읽는 페이지 수 자체를 줄인다: 인덱스로 좁히기, 커버링, 파티션 프루닝 |
| `hit`이 압도적으로 크고 시간도 오래 걸림 | **CPU 병목** — 페이지는 다 캐시에 있는데 읽고 판정하고 버리는 일 자체가 많다 | 2-3의 inner `loops=500000`이 전형. 반복 횟수·비교 횟수를 줄이는 계획으로 바꾼다 |
| `hit`도 `read`도 작은데 느림 | **읽기 밖의 병목** | 정렬·해시 스필(`temp` 확인), 락 대기(3-1의 `wait_event_type`), 함수 호출, 네트워크 전송량 |
| `temp read/written`이 큼 | `work_mem`을 넘겨 임시 파일로 넘쳤다 | `Sort Method: external merge`나 `Batches > 1`이 함께 찍혀 있을 것 |

`track_io_timing = on`을 켜 두면 `I/O Timings: shared read=…`가 붙어 "그 `read` 중 진짜 디스크에서 온 것이 몇 밀리초였나"까지 갈린다. PostgreSQL은 `shared_buffers`와 OS 페이지 캐시의 **이중 캐시**라 `read`가 곧 디스크는 아니기 때문에, I/O 병목을 단정하려면 이 값이 필요하다.

한 줄로 정리하면 — **시간은 "얼마나 걸렸나"이고 Buffers는 "얼마나 일했나"다.** 환경이 달라져도 변하지 않는 쪽은 후자이므로, 가설을 세우고 검증하는 기준선은 Buffers로 잡는다.

### 2-5. 두 도구를 한 표로 고정

| | `EXPLAIN` | `EXPLAIN (ANALYZE, BUFFERS)` |
|---|---|---|
| 실행 여부 | **안 함** | **실제 실행** |
| 숫자의 성격 | 통계 기반 **추정** (`cost`, `rows`, `width`) | **실측** (`actual time/rows/loops`, `Buffers`, `Rows Removed`, `Sort Method`, `Heap Fetches`) |
| 운영 DB에서 | 안전 (계획만 봄) | 주의 — 무거운 SELECT는 그대로 부하가 되고, 데이터를 바꾸는 문은 **실제로 바뀐다** (2-1) |
| 쓰는 순간 | 배포 전 검토, 첫 진단 | 추정과 현실의 괴리 확인, 개선 전후 비교 |

첫 진단은 `EXPLAIN`, 괴리 확인과 전후 비교는 `EXPLAIN (ANALYZE, BUFFERS)` — 이 분업이 답의 뼈대다.

### 2-6. 그 밖의 도구들 (가산점 포인트)

`EXPLAIN (FORMAT JSON)`은 같은 트리를 JSON으로 주므로 **테스트 단정**(3-4)과 시각화(explain.depesz.com, explain.dalibo.com — 어느 노드가 시간·Buffers를 먹었는지 색으로 보여 준다)에 쓴다. `VERBOSE`의 `Output:`은 "컬럼 하나 때문에 `Index Only Scan`이 안 되는" 원인을 찾게 한다.

준비문의 계획은 `PREPARE q(bigint) AS …; EXPLAIN (ANALYZE) EXECUTE q(100);`으로 본다(최근 버전에는 제네릭 계획만 보는 `GENERIC_PLAN` 옵션도 있다).

그리고 **PostgreSQL에는 "지금 돌고 있는 쿼리의 계획"을 보는 내장 명령이 없다.** 장애 중에는 `pg_stat_activity`의 `query`를 같은 파라미터로 다시 `EXPLAIN`하거나 `auto_explain` 로그(3-4)를 본다. 그것이 `auto_explain`을 **미리** 켜 두어야 하는 이유다 — 사고가 난 뒤에 켜면 그 사고의 계획은 영영 알 수 없다.

---

## 3. 실무 — 측정 → 가설 → 검증 → 고정, 그리고 한 사이클

"인덱스 추가해봄 → 빨라짐"이 왜 프로세스가 아닌지부터 분명히 한다.

```text
[흔한 흐름 — 이것은 프로세스가 아니다]
   느리다는 제보 → 쿼리를 눈으로 봄 → WHERE 컬럼에 인덱스 추가 → 빨라진 것 같음 → 끝
   문제: 무엇이 얼마나 느렸는지 숫자가 없다 / 왜 빨라졌는지 모른다 /
         다른 쿼리가 느려졌는지 모른다 / 3개월 뒤 같은 패턴이 재발해도 아무도 모른다

[사이클 — 이것이 프로세스다]
   ① 측정: 무엇이, 얼마나, 몇 번, 언제 느린가 — 숫자와 재현 조건
   ② 가설: 계획 트리에서 비용이 새는 지점을 "메커니즘 사슬"로 특정하고, 예상 효과를 숫자로
   ③ 검증: EXPLAIN (ANALYZE, BUFFERS)로 전후 실측 + 부작용(쓰기 비용·다른 쿼리·DDL 리스크)까지 양면으로
   ④ 고정: 재발을 사람이 아니라 설정·테스트·파이프라인이 잡도록 남긴다  <- 여기까지가 한 사이클
```

### 3-1. 측정 — "느리다"를 네 개의 숫자로

입력은 사람의 제보가 아니라 **로그와 지표**여야 한다. PostgreSQL이 주는 네 가지 창구가 있다.

- **`log_min_duration_statement`**: 이 값(ms)을 넘긴 문장을 서버 로그에 남긴다. 기본값 `-1`은 "아무것도 안 남김"이다. **파라미터가 실제 값으로 찍히므로** "느렸던 그 파라미터"를 여기서 가져온다.
- **`auto_explain`**: 같은 임계를 넘긴 문장의 **실제 실행 계획**을 로그에 남기는 확장(`shared_preload_libraries`에 등록). `log_analyze`·`log_buffers`를 켜면 청구서까지 남는다 — "그때 그 계획"을 사후에 알 수 있는 유일한 길이다.
- **`pg_stat_statements`**: 파라미터를 정규화한 쿼리 패턴별로 **호출 횟수, 총·평균 실행 시간, 반환 행 수, 읽은 페이지 수**를 누적하는 확장. "어느 쿼리가 비싼가"의 대시보드다.
- **APM**(Pinpoint, Datadog 등): 어느 API에서 어느 쿼리가 몇 번 호출되는지를 본다. **N+1은 쿼리 하나는 빠른데 요청당 수백 번 호출되는 문제**라 느린 쿼리 로그에는 안 잡히고 여기서(또는 `pg_stat_statements`의 `calls` 폭증으로)만 보인다.

우선순위를 정하는 기준은 **"가장 느린 쿼리"가 아니라 "가장 비싼 쿼리"**다.

```sql
-- 총 비용 = 평균 시간 × 호출 횟수 순으로 정렬
SELECT queryid,
       left(query, 80)                                   AS query,
       calls,
       round((total_exec_time / 1000)::numeric, 1)       AS total_sec,
       round(mean_exec_time::numeric, 2)                 AS mean_ms,
       rows / calls                                      AS avg_rows,
       (shared_blks_hit + shared_blks_read) / calls      AS blks_per_call
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
-- 1초짜리 하루 1회(총 1초)보다 50ms짜리 하루 10만 회(총 5,000초)가 병목이다.
-- blks_per_call(호출당 읽은 페이지)이 avg_rows(호출당 반환 행)의 수천 배면
-- 그것만으로 "많이 읽고 대부분 버린다"는 진단이 선다.
```

측정 단계에서 함께 적어 둘 것이 **재현 조건**이다. 이게 없으면 다음 단계에서 "내 로컬에선 빠른데요"로 끝난다.

- **어떤 파라미터에서 느린가** — 같은 쿼리도 `user_id`에 따라 대상 행 수가 100배 차이 난다. `pg_stat_statements`의 `query`는 파라미터가 `$1`로 지워져 있으니 실제 값은 `log_min_duration_statement` 로그에서 가져온다.
- **어느 시간대인가** — 배치·autovacuum·리포트와 겹치는가.
- **실행이 느린 건가, 기다린 건가** — 계획이 완벽해도 앞 트랜잭션의 락을 기다리면 느리다. `pg_stat_activity`의 `wait_event_type`이 `Lock`이면 실행 계획 문제가 아니라 동시성 문제이므로, `EXPLAIN`을 아무리 봐도 답이 안 나온다.

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start        AS xact_age,
       pg_blocking_pids(pid)     AS blocked_by,
       left(query, 60)           AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND pid <> pg_backend_pid()
ORDER BY xact_start;
-- wait_event_type = 'Lock' + blocked_by가 차 있으면 락 문제(범인은 그 pid).
-- 'IO'면 디스크, NULL이면 CPU에서 실행 중 → 계획 문제 쪽.
```

**(가산점 포인트) 재현 조건의 PostgreSQL 고유 함정 — 제네릭 계획.** psql에서 리터럴 값으로 뜬 `EXPLAIN`은 그 값의 통계로 세운 **커스텀 계획**이다. 그런데 애플리케이션은 pgjdbc가 같은 문장을 5회 실행한 뒤 서버 준비문으로 바꾸고, 서버는 커스텀 계획 5회 뒤 **제네릭 계획**(파라미터 값을 모른 채 평균 선택도로 세운 계획)이 더 싸다고 판단하면 그쪽으로 전환한다. 편중 데이터에서는 "psql에선 빠른데 앱에선 느리다"의 정체가 이것이다. 확인은 `PREPARE` 후 `EXPLAIN EXECUTE`를 6회 이상 반복하거나 `auto_explain` 로그를 보는 것이고, 통제는 `plan_cache_mode = force_custom_plan`이다([실행 계획 급변](31-execution-plan-sudden-change.md)).

그리고 측정은 **운영 규모 데이터에서, `ANALYZE`를 돌린 뒤** 해야 한다. 로컬 100건짜리 테이블에서는 어떤 쿼리든 빠르고, 심지어 **실행 계획 자체가 다르다** — 플래너는 작은 테이블에서 인덱스 대신 `Seq Scan`을 고르는 게 정상이라(페이지 몇 장이면 다 읽히는데 인덱스를 거칠 이유가 없다), 로컬 `EXPLAIN`에 `Seq Scan`이 떠도 운영에선 `Index Scan`일 수 있고 그 반대도 있다.

### 3-2. 가설 — 비용이 "어디서 새는지"를 사슬로 말한다

계획을 1-4의 순서대로 읽으면서, **"느리다"를 메커니즘 사슬로 번역**하는 단계다. "성능 저하", "메모리 부하", "왔다갔다" 같은 뭉뚱그린 말에서 끝내지 않고 **이름 붙은 단계**로 끝까지 잇는다.

| 계획에서 본 것 | 뭉뚱그린 말 | 사슬로 말하기 |
|---|---|---|
| `Index Scan` + `Filter: (status = …)` + `Rows Removed by Filter: 42495` + `Buffers: read=41856`, 위에 `Sort` | "인덱스는 타는데 느려요" | 인덱스로 TID 4만 7천 개 수집(순차, 쌈) → **TID마다 힙 페이지 랜덤 접근 4만 7천 번(비쌈)** → 그중 90%를 `status` 필터에서 버림 → 남은 4,720건을 정렬 → 20건 반환. **비용 = 버릴 행에 쓴 힙 랜덤 I/O + 정렬** |
| inner가 `Seq Scan` + `loops=4720`, 또는 `Hash Join` + `Batches: 8` | "조인이 느려요" | 조인 키 인덱스가 없어 NL이면 안쪽을 4,720번 **통순회**, 플래너가 해시로 갈아탔으면 안쪽 전체를 해시로 만들다 `work_mem`을 넘쳐 **디스크 스필** → 조인 키 인덱스 하나로 "행당 트리 탐색 1회"로 바뀜 |
| `Sort` + `Sort Method: external merge Disk:` + `LIMIT 20` | "정렬이 느려요" | 정렬 컬럼이 인덱스 순서와 안 맞음 → **대상 전부**를 읽어 정렬 → `work_mem`을 넘겨 디스크 임시 파일에 청크 저장 후 병합 → 그제야 앞 20건. 인덱스 순서와 맞추면 **`Index Scan Backward`로 리프 앞 20건 읽고 끝**(`Sort` 노드 자체가 사라짐) |
| `Seq Scan` + `rows=1000000` + `Buffers: read=…` 대량 | "풀스캔이라 느려요" | 순차 I/O라 **페이지당은 싸지만** 총량이 100만 → 읽은 페이지가 `shared_buffers`를 채우며 **다른 쿼리의 캐시를 밀어냄(캐시 오염)** → 이 쿼리만이 아니라 옆 쿼리까지 `read`로 떨어짐 |
| `Index Only Scan` + `Heap Fetches: 38211` | "커버링인데 안 빨라요" | visibility map이 "전부 가시"로 표시 못 한 페이지가 많음(갱신이 잦거나 VACUUM이 밀림) → 인덱스만 읽으려다 힙을 3만 8천 번 방문 → `VACUUM`으로 VM을 갱신하거나 autovacuum 임계를 낮춤 ([커버링 인덱스](09-covering-index.md)) |
| `SubPlan 1` 아래 노드 `loops=100000` | "서브쿼리가 느려요" | 상관 서브쿼리가 바깥 행마다 재실행 → 바깥 10만 행이면 10만 번 → 조인 또는 `EXISTS`(세미 조인)로 한 번만 실행되게 |
| 추정 `rows=1000` vs `actual rows=500000` | "계획이 이상해요" | 통계가 낡았거나 상관 컬럼을 독립으로 가정해 곱함 → 잘못된 추정 위에 세운 조인 순서·방식이 전부 틀어짐 → `ANALYZE`, `SET STATISTICS`, `CREATE STATISTICS` (2-3) |

가설에는 반드시 **예상 효과를 숫자로** 붙인다. "인덱스 추가하면 빨라질 것 같다"가 아니라 **"`(user_id, status, created_at)` 인덱스를 만들면 `Rows Removed by Filter`가 0이 되고, `Sort` 노드가 사라지며, `Buffers`가 4만 7천 페이지에서 수십 페이지로 준다"** — 이렇게 써 두어야 검증 단계에서 맞았는지 틀렸는지를 판정할 수 있다. 숫자 없는 가설은 검증이 불가능하다.

### 3-3. 검증 — 실측으로 확인하고, 부작용까지 한 호흡에

가설대로 고친 뒤 **같은 파라미터, 운영 규모 데이터**에서 `EXPLAIN (ANALYZE, BUFFERS)`를 전후로 비교한다.

```sql
-- before (2-2의 계획): Sort(top-N heapsort) 아래 Index Scan using idx_orders_user
--    Filter: (status = 'ACTIVE'::text)   Rows Removed by Filter: 42495
--    Buffers: shared hit=24292 read=41856   Execution Time: 291.487 ms

CREATE INDEX CONCURRENTLY idx_orders_user_status_created
  ON orders (user_id, status, created_at);
--   등호(user_id) → 등호(status) → 정렬(created_at) 순: 두 등호로 좁힌 구간이
--   created_at 순으로 이미 정렬돼 있으므로 역방향으로 20건만 읽으면 끝난다.
--   CONCURRENTLY: 쓰기를 막지 않고 만든다 (트랜잭션 블록 안에서는 불가 — 3-4 층 3)
```

```text
[after]
 Limit  (cost=0.99..36.17 rows=20 width=52) (actual time=0.062..0.171 rows=20 loops=1)
   Buffers: shared hit=103
   ->  Nested Loop  (cost=0.99..8443.19 rows=4800 width=52) (actual time=0.061..0.166 rows=20 loops=1)
         ->  Index Scan Backward using idx_orders_user_status_created on orders o
               (cost=0.56..6187.06 rows=4800 width=32) (actual time=0.041..0.083 rows=20 loops=1)
               Index Cond: ((user_id = 100) AND (status = 'ACTIVE'::text))
               Buffers: shared hit=23
         ->  Index Scan using products_pkey on products p  (actual time=0.003..0.004 rows=1 loops=20)
               Index Cond: (id = o.product_id)
               Buffers: shared hit=80
 Execution Time: 0.209 ms

 Sort 노드가 사라졌고, Rows Removed by Filter 줄이 없어졌고, Buffers 66,148 -> 103.
 Index Scan Backward의 추정 rows=4800인데 actual rows=20인 것은 오추정이 아니라
 Limit이 20건 받고 멈춘 "조기 종료"다 — cost의 시작 비용이 작은 계획이 이긴 이유(1-3).
```

여기서 멈추면 반쪽이다. **이득만 말하고 대가를 안 붙이는 것**이 가장 흔한 감점 지점이다. 인덱스 추가의 대가는 정해져 있고, PostgreSQL에서는 한 겹 더 무겁다.

여기서 **HOT 업데이트**라는 전제를 하나 보충해야 한다. PostgreSQL의 UPDATE는 행을 제자리에서 고치는 게 아니라 새 버전을 만드는 방식인데, **바뀐 컬럼이 어떤 인덱스에도 들어 있지 않으면** 인덱스를 하나도 건드리지 않고 힙 안에서만 처리한다(Heap-Only Tuple, 줄여서 HOT). 반대로 **인덱스에 들어간 컬럼을 바꾸면 HOT에서 탈락**해 그 인덱스만이 아니라 **그 테이블의 모든 인덱스**에 새 엔트리를 꽂아야 한다([MVCC와 PostgreSQL 구현](11-mvcc-postgresql.md)).

> **한 호흡 템플릿**: "이 인덱스는 **[이득]** 이 쿼리의 힙 랜덤 I/O 4만 7천 번을 20번으로 만들고 `Sort`를 없앤다(Buffers 66,148에서 103으로). **[대가]** 대신 `orders`에 INSERT가 일어날 때마다 B-tree 하나를 더 갱신하고, **`status`가 인덱스에 들어갔으므로 status를 바꾸는 UPDATE가 HOT 업데이트에서 탈락해 이 인덱스만이 아니라 테이블의 모든 인덱스에 새 엔트리를 꽂게 되며**, 인덱스 크기만큼 디스크와 `shared_buffers`를 더 쓰고, `user_id`를 선두로 쓰는 다른 쿼리들의 계획이 바뀔 수 있고, 수억 건 테이블이면 인덱스 생성 자체가 테이블 2회 스캔짜리 운영 작업이다. **[판단]** 그래서 기존 `(user_id)` 단독 인덱스는 새 인덱스의 선두 컬럼에 흡수되므로 삭제해 쓰기 대가를 상쇄하고, 생성은 `CREATE INDEX CONCURRENTLY`로 트래픽이 적은 시간에 하며, 배포 후 `n_tup_hot_upd` 비율이 얼마나 떨어지는지 확인한다."

검증 체크리스트는 네 줄이다.

1. **대상 쿼리의 실측이 가설대로 개선됐는가** — `actual rows`, `actual time`, 그리고 **`Buffers`**. 2-4에서 봤듯 시간은 캐시 상태에 따라 흔들리지만 읽은 페이지 수는 같은 계획이면 같으므로, 전후 비교의 기준 숫자는 Buffers다.
2. **같은 테이블을 쓰는 상위 쿼리들의 계획이 나빠지지 않았는가** — 새 인덱스가 생기면 플래너의 선택지가 늘고, 선택도 낮은 컬럼이 선두인 인덱스는 플래너를 **오히려 잘못된 길로 유인**할 수 있다. 3-1의 `pg_stat_statements` 상위 목록에서 같은 테이블 쿼리를 골라 다시 `EXPLAIN`한다.
3. **쓰기 처리량**이 허용 범위인가 — 쓰기 비중이 높은 테이블이면 인덱스 하나가 INSERT p95를 눈에 띄게 올리고, 인덱스에 들어간 컬럼을 갱신하는 UPDATE는 HOT 탈락으로 모든 인덱스를 건드린다. `pg_stat_user_tables`의 `n_tup_upd` 대비 `n_tup_hot_upd` 비율을 전후로 본다.
4. **DDL 실행 방식** — `CREATE INDEX CONCURRENTLY`로 쓰기를 막지 않고 만들되, 실패하면 `INVALID` 인덱스가 남으므로(`pg_index.indisvalid`) 확인 후 DROP하고 재시도한다. 일반 `CREATE INDEX`는 테이블에 쓰기 잠금을 건다. (무중단 DDL은 [별도 문항](14-online-ddl-zero-downtime-schema-change.md)이라 여기선 "확인 항목"으로만 둔다.)

### 3-4. 고정 — 사람의 기억이 아니라 설정·테스트·파이프라인에

여기가 이 문서에서 가장 힘을 주는 절이다. 성능 개선은 **한 번 고치는 것보다 재발을 잡는 구조를 남기는 것**이 더 가치 있다 — 같은 팀의 다른 개발자가 석 달 뒤 같은 패턴의 쿼리를 또 쓸 것이고, 그때 이 사이클을 기억하고 있을 사람은 아무도 없기 때문이다.

"TODO 주석을 남겼습니다"는 고정이 아니다. 주석은 읽는 사람이 있을 때만 작동하고, 빌드를 깨지도 알람을 울리지도 않는다. 고정은 **세 층**으로 한다: **설정**(측정이 자동으로 계속되게) / **테스트**(회귀가 CI에서 터지게) / **파이프라인·템플릿**(절차가 사람 기억 밖에 있게).

#### 층 1 — 설정: 느린 쿼리 임계치·계획 로그·통계 뷰를 코드로

```ini
# before: log_min_duration_statement = -1 (기본값) — 9초짜리 쿼리도 영영 로그에 안 남는다

# after: postgresql.conf 또는 RDS 파라미터 그룹 (Terraform으로 형상 관리)
shared_preload_libraries = 'pg_stat_statements,auto_explain'   # 재시작 필요. 이후 CREATE EXTENSION pg_stat_statements
log_min_duration_statement = 500      # ms. API p95 목표에서 역산한 값. 500ms 넘는 문장은 전부 기록
auto_explain.log_min_duration = 500   # 같은 임계로 "실제 실행 계획"까지 로그에
auto_explain.log_analyze = on         # actual 수치 포함 — 모든 문장에 계측이 붙으므로 부하를 재고 켠다 (sample_rate로 표본화 가능)
auto_explain.log_buffers = on         # Buffers까지. 노드별 시간 계측이 부담이면 log_timing = off
track_io_timing = on                  # Buffers 옆에 실제 I/O 시간(I/O Timings)을 붙인다 — 2-4의 I/O vs CPU 판별
log_lock_waits = on                   # deadlock_timeout(1s) 넘는 락 대기를 로그에 — "느린 게 아니라 기다린 것" 판별
```

`auto_explain`이 이 목록에서 특히 중요한 이유는 2-6에서 짚은 대로다 — **PostgreSQL에는 지나간 쿼리의 계획을 사후에 조회하는 방법이 없다.** 사고가 난 다음에 켜면 그 사고의 계획은 영원히 알 수 없고, "다시 재현되기를 기다린다"는 대응밖에 남지 않는다.

로그는 쌓이기만 하면 아무도 안 본다. **`pg_stat_statements` 상위 10개를 일일 리포트**로 채널에 보내거나, 로그 수집기(CloudWatch, Datadog)에서 **"분당 느린 쿼리 로그 건수" 알람**을 건다. 알람 임계치 자체도 IaC 파일에 들어간다. 이렇게 하면 3-1의 "측정"이 사람이 마음먹을 때가 아니라 **항상** 돌아간다.

여기에 하나 더 붙일 것이 **개선한 쿼리의 기준선(baseline)** 이다. 개선 직후의 숫자를 어딘가에 적어 두지 않으면, 석 달 뒤 "느려진 것 같다"는 말에 비교할 대상이 없다.

```sql
-- 개선 직후, 그 쿼리의 기준선을 숫자로 남긴다 (PR 본문·위키·대시보드 주석에 붙인다)
SELECT queryid,
       calls,
       round(mean_exec_time::numeric, 2)              AS mean_ms,
       (shared_blks_hit + shared_blks_read) / calls   AS blks_per_call
FROM pg_stat_statements
WHERE queryid = 4029571332094836421;
--  queryid  | calls  | mean_ms | blks_per_call
--  40295... | 121043 |    0.31 |           103
-- 이 세 숫자가 다음 비교의 기준이다. 통계는 pg_stat_reset() 이후 누적이므로
-- "언제부터의 누적인가"(stats_reset)도 함께 적어 둔다.
--
-- 그리고 mean_ms보다 blks_per_call을 먼저 본다 — mean_ms가 오르는 건 캐시나
-- 서버 부하로도 일어나지만, blks_per_call이 103에서 6만으로 튀면 그건
-- "데이터가 늘어서"가 아니라 "계획이 바뀌어서"라는 뜻이다 (2-4).
```

#### 층 2 — 테스트: 쿼리 수 단정과 EXPLAIN 단정을 CI에

**쿼리 수 단정 테스트**는 N+1 회귀를 잡는 가장 싼 안전망이다. N+1은 쿼리 하나하나가 빨라서 느린 쿼리 로그에 절대 안 잡히므로, 로그 설정으로는 막을 수 없는 부류다. datasource-proxy(또는 p6spy)를 테스트 프로파일에 붙이면 실행된 쿼리 수를 셀 수 있다.

```java
// before: fetch join으로 N+1을 고친 뒤 남긴 것이 주석뿐
// TODO: 이 메서드는 N+1 주의. 연관 로딩 바꿀 때 쿼리 수 확인할 것
public Page<OrderSummary> getOrders(Long userId, Pageable pageable) { ... }
```

```java
// after: 쿼리 수를 테스트가 단정한다 — 누군가 fetch join을 지우면 CI가 빨간불
@SpringBootTest
class OrderQueryCountTest {

    @Autowired OrderService orderService;

    @BeforeEach
    void resetCounter() {
        QueryCountHolder.clear();                       // datasource-proxy 카운터 초기화
    }

    @Test
    void 주문_목록_조회는_쿼리_2번으로_끝난다() {
        orderService.getOrders(100L, PageRequest.of(0, 20));

        QueryCount count = QueryCountHolder.getGrandTotal();
        assertThat(count.getSelect())
            .as("목록 1회 + count 1회. N+1이 재발하면 22회가 되어 실패한다")
            .isEqualTo(2);
    }
}
```

**EXPLAIN 단정 테스트**는 한 단계 더 나간다. Testcontainers로 띄운 PostgreSQL에 **운영과 비슷한 규모**의 데이터를 적재하고 `ANALYZE`한 뒤(3-1에서 짚었듯 작은 테이블에선 플래너가 `Seq Scan`을 고르는 게 정상이므로 규모와 통계가 결정적이다), 핵심 쿼리의 실행 계획을 `FORMAT JSON`으로 받아 단정한다.

```java
@Test
void 주문_목록_쿼리는_orders를_풀스캔하지_않고_정렬도_인덱스로_처리한다() throws Exception {
    // given: 마이그레이션 적용 + 대량 시드 데이터 (예: orders 50만 건) + 통계 갱신
    seedOrders(500_000);
    jdbcTemplate.execute("ANALYZE orders");

    String json = jdbcTemplate.queryForObject("""
        EXPLAIN (FORMAT JSON)
        SELECT o.id, o.amount FROM orders o
        WHERE o.user_id = ? AND o.status = 'ACTIVE'
        ORDER BY o.created_at DESC LIMIT 20
        """, String.class, 100L);
    List<JsonNode> nodes = flatten(objectMapper.readTree(json).at("/0/Plan"));  // "Plans" 배열을 재귀로 펼친다

    assertThat(nodes)
        .as("orders 풀스캔 금지")
        .noneMatch(n -> n.path("Node Type").asText().equals("Seq Scan")
                     && n.path("Relation Name").asText().equals("orders"));
    assertThat(nodes)
        .as("정렬은 인덱스로 — Sort 노드가 있으면 인덱스가 빠졌거나 컬럼 순서가 바뀐 것")
        .noneMatch(n -> n.path("Node Type").asText().equals("Sort"));
    assertThat(nodes)
        .extracting(n -> n.path("Index Name").asText())
        .contains("idx_orders_user_status_created");
}
```

이 테스트는 **"인덱스를 지우거나 컬럼 순서를 바꾸면 빌드가 깨진다"**는 뜻이다. 석 달 뒤 누군가 "안 쓰는 것 같은데"라며 인덱스를 정리해도, 리뷰어가 못 잡아도, CI가 잡는다.

#### 층 3 — 파이프라인·템플릿: 절차를 사람 밖으로

- **인덱스 DDL은 반드시 마이그레이션 파일로** 만든다(Flyway `V12__add_idx_orders_user_status_created.sql`). 운영 콘솔에서 손으로 만든 인덱스는 스테이징에 없고, 다음 사람은 그 존재를 모른다. 단 **`CREATE INDEX CONCURRENTLY`는 트랜잭션 블록 안에서 실행할 수 없으므로** 마이그레이션 도구가 그 스크립트를 트랜잭션으로 감싸지 않게 설정한다(Flyway `executeInTransaction=false`, Liquibase `runInTransaction="false"`).
- **PR 템플릿에 체크 항목**을 박는다. 리뷰어의 기억이 아니라 파일이 묻게 한다.

  ```markdown
  ## DB 변경 체크 (해당 없으면 N/A)
  - [ ] 새로 추가/변경한 쿼리의 EXPLAIN (ANALYZE, BUFFERS) 결과를 첨부했다 (운영 규모 데이터·ANALYZE 후 기준)
  - [ ] 인덱스 추가/삭제는 마이그레이션 파일로 했고, CONCURRENTLY + 트랜잭션 밖 실행을 확인했다
  - [ ] 같은 테이블을 쓰는 기존 상위 쿼리(pg_stat_statements)의 계획 변화를 확인했다
  ```
- **플래너를 강제했다면** 주석에 "왜, 어떤 측정 근거로, 언제 재검토"를 남기고 티켓을 건다. PostgreSQL에는 힌트 문법이 없어서 강제 수단은 확장 `pg_hint_plan`이나 세션의 `enable_*` 스위치뿐인데, 어느 쪽이든 지금의 데이터 분포를 코드에 박제하는 것이라 **만료일이 있는 부채**다. `SET LOCAL enable_seqscan = off`는 가설 검증 도구지 운영 설정이 아니다.
- **(가산점 포인트)** 만든 인덱스가 실제로 쓰이는지를 주기적으로 확인하는 것도 고정 대상이다. 쓰기 비용만 내는 죽은 인덱스가 쌓이는 것을 막는다.

  ```sql
  SELECT s.indexrelname, s.idx_scan,
         pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0 AND NOT i.indisunique      -- 유니크는 제약 역할이라 제외
  ORDER BY pg_relation_size(s.indexrelid) DESC;
  -- 통계 리셋(pg_stat_reset) 이후 기준. 레플리카에서만 쓰이는 인덱스는
  -- 프라이머리 카운트가 0일 수 있으니 양쪽에서 확인.
  ```

세 층을 다 갖추면 사이클은 이렇게 닫힌다 — **설정이 측정하고, 테스트가 회귀를 잡고, 템플릿이 절차를 강제한다.** 그리고 다음 느린 쿼리는 사용자 항의가 아니라 느린 쿼리 로그 알람으로 도착한다.

### 3-5. 한 사이클을 처음부터 끝까지 — 주문 목록 API

"주문 목록 API가 느리다"는 제보를 사이클로 처리한 기록이다. 숫자는 예시다.

**측정.** APM에서 `GET /orders` p95가 2.4초였다. `pg_stat_statements` 총 시간 1위는 `SELECT … FROM orders o JOIN products p … WHERE o.user_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT 20` — `mean_exec_time` 1.8초, 하루 12만 회, `blks_per_call` 약 6만 6천, `avg_rows` 20. **페이지 3,300장을 읽어 행 하나를 돌려주는 셈이다**(66,000 ÷ 20). `pg_stat_activity`의 `wait_event_type`은 비어 있고 `log_lock_waits` 로그도 없어 락 문제는 아니다. 느린 파라미터는 `log_min_duration_statement` 로그에서 확인했다 — 주문이 많은 헤비 유저들로 `user_id`별 편차가 크다.

**가설.** 그 파라미터로 `EXPLAIN (ANALYZE, BUFFERS)`를 떴다(2-2의 계획): `Index Scan using idx_orders_user`, `Filter: (status = 'ACTIVE')`, `Rows Removed by Filter: 42495`, 이 노드 `Buffers: shared hit=5412 read=41856`, 위에 `Sort (top-N heapsort)`. 추정 4,800 대 실측 4,720으로 통계는 멀쩡하니 통계 교정 건은 아니다. 사슬로 번역하면 — `user_id` 인덱스로 TID 4만 7천 개를 모아 → 4만 7천 번 힙 랜덤 접근 → `status` 필터로 90% 폐기 → 4,720건 정렬 → 20건 반환. **비용의 대부분이 "버릴 행의 힙 랜덤 I/O"와 "정렬"이다.** 처방 가설은 `(user_id, status, created_at)` 복합 인덱스, 예상 효과는 `Rows Removed by Filter` 0, `Sort` 노드 제거(`Index Scan Backward` + `Limit`), Buffers 6만 6천에서 수십으로.

**검증.** 스테이징(운영 마스킹 덤프 + `ANALYZE`)에서 전후를 실측했다: 291ms에서 0.2ms, Buffers 66,148에서 103. `pg_stat_statements` 상위 5개를 재확인 — 3개는 새 인덱스로 자연 이동(`user_id` 선두가 같다), 2개는 무관했다. 기존 `idx_orders_user`는 새 인덱스에 흡수되므로 삭제해 인덱스 개수를 유지하고 쓰기 비용 증가분을 상쇄했다. `orders`가 3억 건이라 `CREATE INDEX CONCURRENTLY`로 새벽에 생성했다(테이블 2회 스캔 동안 I/O와 레플리카 지연을 모니터링). **대가**는 인덱스 크기 약 12GB 증가(status·created_at 추가분)와 **status를 바꾸는 UPDATE의 HOT 탈락** — 배포 후 `n_tup_hot_upd / n_tup_upd`가 71%에서 58%로 내려간 것을 확인하고 허용 범위로 기록했다.

**고정.** Flyway 마이그레이션 2건(생성·삭제, 트랜잭션 밖 실행) / EXPLAIN 단정 테스트 1건 추가 / `log_min_duration_statement`를 1000에서 500으로 내리고 `auto_explain` 활성화 + 알람 연결 / 개선된 쿼리의 `queryid`·`mean_ms`·`blks_per_call`을 기준선으로 PR에 기록 / PR 템플릿에 DB 체크 항목 추가.

**다음 주 같은 팀원이 `orders`에 `WHERE user_id = $1 AND payment_method = $2` 쿼리를 올렸을 때, PR 템플릿이 EXPLAIN을 요구했고 `Rows Removed by Filter: 44100`이 리뷰에서 잡혔다.** 이것이 고정의 효과다.

---

## 4. 꼬리질문 대비 포인트

### "`rows` 추정이 실제와 크게 다르면 무엇을 의심하고, 어떻게 확인·수정하나요?"

**통계 정보가 현실과 어긋난 것**을 첫째로 의심한다. 플래너는 통계로 추정하고(1-1), 통계는 `ANALYZE`의 표본으로 만들어지며, 대량 적재·삭제 직후나 컬럼 간 상관관계가 강한 조건에서 잘 틀린다. 확인은 `EXPLAIN ANALYZE`의 추정 `rows`와 `actual rows` 비교 — 자릿수가 다르면 확정이다(2-3). 수정은 순서대로 ⑴ **`ANALYZE 테이블`** 로 즉시 재수집하고, autovacuum의 analyze 임계(기본은 행의 10% 변경)가 큰 테이블에서 너무 둔하면 테이블 단위로 낮춘다. ⑵ 그래도 틀리면 **표본을 키운다** — `ALTER TABLE … ALTER COLUMN status SET STATISTICS 1000`(기본 `default_statistics_target` 100). PostgreSQL은 최빈값 목록(MCV)과 히스토그램을 **기본으로** 들고 있어 "90%가 `ACTIVE`인 `status`" 같은 편중은 대체로 잡아내지만, 표본이 모자라면 희귀 값이 MCV에서 빠진다. ⑶ **컬럼 간 상관관계**면 `CREATE STATISTICS … (dependencies, ndistinct, mcv) ON city, zipcode FROM addresses` — 플래너는 조건들을 독립으로 가정해 선택도를 **곱하므로**, "서울 AND 06236"처럼 한쪽이 다른 쪽을 결정하는 조건은 심하게 과소추정된다. ⑷ 추정이 아니라 **파라미터를 모르는 것**일 수도 있다 — 제네릭 계획(3-1)이면 `plan_cache_mode`. 이 넷을 다 밟은 뒤에야 `pg_hint_plan`을 검토한다. "코드도 쿼리도 안 바꿨는데 느려졌다"(관련 질문)의 정체가 대개 이 중 하나다.

### "EXPLAIN 결과는 좋은데(`Index Scan`, `rows` 작음) 운영에서 느립니다. 어디를 보나요?"

**EXPLAIN은 "쿼리 하나의 계획"이지 "요청 하나의 비용"이 아니다**라는 전제에서 출발한다. 순서대로 — ⑴ **EXPLAIN에 넣은 파라미터가 느린 그 파라미터인가**: `user_id = 1`(주문 3건)과 `user_id = 100`(4만 건)은 같은 쿼리, 다른 비용이다. `log_min_duration_statement` 로그에서 실제 느렸던 값을 가져와 다시 보고, **앱은 준비문의 제네릭 계획을 타고 있을 수 있다**는 PostgreSQL 고유 함정(3-1)도 배제한다. ⑵ **실행이 아니라 대기인가**: `pg_stat_activity.wait_event_type = 'Lock'`, `pg_blocking_pids()`. 계획이 완벽해도 앞 트랜잭션의 락을 기다리면 느리다. ⑶ **호출 횟수**: 3ms짜리 쿼리가 요청당 500번 돌면 1.5초다 — N+1은 EXPLAIN에 절대 안 보이고 APM·`calls`·쿼리 수 단정 테스트에만 보인다. ⑷ **캐시 미스**: 계획은 같아도 `Buffers`가 `shared hit`이냐 `read`냐로 열 배 넘게 차이 난다(2-4의 3,842ms 대 289ms). 새벽 첫 호출, 배치 직후(캐시 오염)가 전형이고, `I/O Timings`로 진짜 디스크였는지 가른다. ⑸ **같은 계획인데 읽는 페이지가 늘었다**: 죽은 튜플이 쌓여(bloat) 같은 행을 얻는 데 페이지를 더 읽거나, VACUUM이 밀려 `Index Only Scan`의 `Heap Fetches`가 늘어난 경우 — `n_dead_tup`, `last_autovacuum`, 그리고 VACUUM을 막는 롱 트랜잭션([16 문서](16-long-transaction-harm-and-shortening.md))을 본다. ⑹ **결과셋 크기와 네트워크**: `SELECT *`로 큰 `text`·`jsonb`(TOAST) 컬럼 수천 건을 끌어오면 DB는 빠른데 전송이 느리다. `EXPLAIN (ANALYZE, BUFFERS)`가 이 중 ⑴·⑷·⑸를 실측으로 갈라준다.

### "인덱스를 추가하면 다른 쿼리가 느려질 수도 있나요? 그걸 어떻게 미리 아나요?" (시니어 변별 포인트)

**있다. 네 경로다.** ⑴ **쓰기 경로**: 모든 INSERT가 B-tree 하나를 더 갱신하고, PostgreSQL에서는 한 겹 더 — **인덱스에 들어간 컬럼을 바꾸는 UPDATE는 HOT 업데이트에서 탈락**해 그 인덱스만이 아니라 **테이블의 모든 인덱스**에 새 엔트리를 꽂는다(3-3). 자주 바뀌는 컬럼(`status`, `updated_at`)을 인덱스에 넣는 순간 쓰기 증폭이 테이블 전체로 번진다. ⑵ **플래너 오유인**: 선택지가 늘면 플래너가 **새 인덱스를 잘못 고를 수 있다** — 특히 선두 컬럼의 선택도가 낮은 인덱스는 "일단 이걸 타볼까"로 유인해 힙 랜덤 접근 폭탄을 만든다. ⑶ **`shared_buffers` 경쟁**: 큰 인덱스 하나가 다른 테이블의 핫 페이지를 밀어낸다. ⑷ **VACUUM 비용**: 인덱스도 VACUUM 대상이라 autovacuum 한 사이클이 길어진다. 미리 아는 방법은 3-3 체크리스트 2·3번 — **같은 테이블을 쓰는 `pg_stat_statements` 상위 쿼리를 새 인덱스 생성 후 다시 EXPLAIN하고, `n_tup_hot_upd` 비율을 전후로 본다.** 진짜로 만들기 전에 "만들면 플래너가 쓸까"만 보고 싶다면 가상 인덱스 확장(HypoPG)이 있다. 이 재확인은 PR 템플릿에 항목으로 박고 핵심 쿼리는 EXPLAIN 단정 테스트로 고정한다. 한 호흡으로 — "이 인덱스는 조회 쿼리 A의 힙 랜덤 I/O를 없애는 대신 쓰기 비용(HOT 탈락 포함)·메모리·플래너 선택지라는 대가를 내고, 그 대가가 허용 범위인지는 상위 쿼리 재확인과 HOT 비율·쓰기 p95로 검증한다."

### "`EXPLAIN ANALYZE`를 운영 DB에서 그냥 돌려도 되나요?"

**조건부다.** 실제로 실행하므로 ⑴ 무거운 SELECT는 그 자체가 부하고 `shared_buffers`를 오염시킨다, ⑵ UPDATE/DELETE에 붙이면 **데이터가 실제로 바뀐다.** 그래서 원칙은 **읽기 레플리카나 운영 규모 스테이징에서** 돌리는 것이고, 운영 프라이머리에서 꼭 해야 한다면 SELECT만, 트래픽 낮은 시간에, `statement_timeout`을 걸고 한다. 변경문은 **`BEGIN; EXPLAIN (ANALYZE) UPDATE …; ROLLBACK;`** 으로 감싼다 — 다만 롤백이 전부를 되돌리지는 않는다는 것까지 말해야 완결된다(2-1): 롤백 자체는 O(1)이지만 그동안 잡은 **행 락은 ROLLBACK 시점까지 유지**되고, **시퀀스 값은 소모**되며, **트리거는 실제로 발화**하고, **WAL은 이미 쌓인다.** 노드별 시간 계측이 수치를 부풀리면 `TIMING off`로 rows·Buffers만 본다. 대신 **일반 `EXPLAIN`은 실행하지 않으므로 운영에서 언제든 안전**하다 — 첫 진단은 EXPLAIN, 괴리 확인은 EXPLAIN ANALYZE, 이 분업을 말하면 된다.

### "이 프로세스를 팀에 정착시키려면 무엇부터 코드로 고정하나요? 우선순위와 이유를 말해주세요." (시니어 변별 포인트)

**비용 대비 효과 순으로 네 단계다.** ⑴ **`pg_stat_statements` + `log_min_duration_statement` + `auto_explain`** — 측정이 없으면 나머지 전부가 시작을 못 한다. 설정 몇 줄이라 가장 싸고, 이것만으로 "어디가 비싼지"와 "그때 계획이 무엇이었는지"가 매일 보인다. 특히 `auto_explain`은 **미리 켜 두지 않으면 지나간 사고의 계획을 되살릴 방법이 없다**는 점에서 다른 것들과 급이 다르다. ⑵ **쿼리 수 단정 테스트** — 가장 흔한 성능 회귀는 인덱스 누락이 아니라 N+1이고, N+1은 쿼리 하나하나가 빨라서 느린 쿼리 로그에 안 잡힌다. datasource-proxy 하나 붙이고 핵심 조회 메서드에 단정 3~4개면 된다. ⑶ **인덱스 DDL의 마이그레이션 강제(CONCURRENTLY, 트랜잭션 밖) + PR 템플릿** — 규칙이지만 파일로 박으면 리뷰어 기억에서 독립한다. ⑷ **EXPLAIN 단정 테스트** — 운영 규모 시드와 `ANALYZE`가 필요해 비용이 가장 크므로 마지막이고, 장애를 겪은 핵심 쿼리부터 하나씩 늘린다. 뒤집어 ⑷부터 하면 시드 관리에 지쳐 중단되고, ⑴을 빼면 무엇을 테스트할지조차 모른다. **"측정 → 가장 흔한 회귀 → 절차의 파일화 → 정밀 회귀 방지"** 순이다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **출력의 형태** — MySQL은 테이블당 한 행인 표(`type`·`key`·`rows`·`Extra`)라 "칸을 순서대로 읽는" 기술이고, PostgreSQL은 노드 트리라 "안쪽부터 올라오며 추정과 실측을 나란히 읽는" 기술이다. 실측 쪽인 `EXPLAIN ANALYZE`도 MySQL은 8.0.18에서야 추가됐고 `BUFFERS`에 해당하는 노드별 페이지 수는 없다. ② **복합 인덱스를 얼마나 깊이 탔나** — MySQL은 `key_len`과 `Extra: Using index condition`으로 텍스트에 드러나지만, PostgreSQL은 강등된 조건도 `Index Cond`에 찍혀 **Buffers로 판별**해야 한다(1-6). ③ **측정 도구** — MySQL의 slow query log(`long_query_time`, `Rows_examined`)와 `performance_schema`의 digest 테이블·`sys` 뷰 대신 PostgreSQL에서는 `log_min_duration_statement`·`pg_stat_statements`·`auto_explain`을 쓴다. 실행 중 쿼리의 계획을 보는 MySQL의 `EXPLAIN FOR CONNECTION`은 PostgreSQL에 대응물이 없어 `auto_explain`을 미리 켜 둔다. ④ **통계 교정과 강제 수단** — MySQL은 `ANALYZE TABLE`에 히스토그램을 따로 만들어야 하고 `FORCE INDEX`·옵티마이저 힌트가 문법으로 있지만, PostgreSQL은 MCV·히스토그램이 기본이고 상관관계는 `CREATE STATISTICS`로 잡으며, 힌트 문법이 없어 통계 교정이 곧 튜닝이다(강제는 확장 `pg_hint_plan`). 대신 **준비문의 제네릭 계획 전환**이라는 PostgreSQL 고유 함정이 있다. ⑤ **랜덤 I/O의 정체와 완화** — MySQL의 InnoDB는 세컨더리 인덱스에서 PK를 얻어 클러스터드 인덱스를 재탐색하고 `Using MRR`이 그 PK를 정렬해 완화하지만, PostgreSQL은 힙 테이블이라 모든 인덱스가 TID로 힙을 찌르고 `Bitmap Heap Scan`이 TID를 블록순으로 정렬해 완화한다 — 그래서 PostgreSQL에는 커버링의 `Index Only Scan`과 visibility map, 그리고 HOT 탈락이라는 쓰기 대가가 따라온다. 이 다섯을 짚어 말하면 "한쪽만 써봤다"가 아니라 "차이를 원리로 이해했다"로 들린다.

---

## 한 줄 요약

**`EXPLAIN`은 통계로 쓴 견적서, `EXPLAIN (ANALYZE, BUFFERS)`는 실제로 실행해 받은 청구서다 — PostgreSQL의 계획 트리는 안쪽(들여쓰기가 깊은 쪽)부터 실행돼 바깥으로 올라오며, 모양(첫 자식이 outer) → 노드 이름(`Seq Scan`과 `Index Cond` 없는 `Index Scan`은 전수, 나머지는 좁힌 것) → 추정 `rows` vs 실제 `rows`(자릿수가 다르면 튜닝이 아니라 통계 교정이 먼저 — 오추정 하나가 상위 노드의 조인 방식 선택을 통째로 틀리게 만든다) → `Buffers`(`shared hit`/`read`로 I/O 병목인지 CPU 병목인지를 가르고, 캐시 상태에 흔들리는 시간 대신 전후 비교의 기준선이 된다) → 경고등(`Rows Removed by Filter`·`external merge`·`Batches > 1`·`Heap Fetches`·안쪽 `loops`) 순으로 읽는다. `ANALYZE`는 진짜로 실행하므로 변경문에 쓰면 데이터가 실제로 바뀐다 — `BEGIN … ROLLBACK`으로 감싸되 행 락·시퀀스·트리거·WAL은 되돌아오지 않는다는 것까지 안다. 느린 쿼리 개선은 측정(`pg_stat_statements`로 가장 비싼 쿼리를 숫자로, 락 대기와 제네릭 계획을 배제하고) → 가설(비용이 새는 지점을 힙 랜덤 I/O 사슬로, 예상 효과를 숫자로) → 검증(같은 파라미터의 실측 + 쓰기 비용·HOT 탈락·다른 쿼리·DDL 리스크까지 한 호흡에) → 고정(`auto_explain`·쿼리 수 단정·EXPLAIN 단정·`pg_stat_statements` 기준선·PR 템플릿을 설정과 코드로)의 사이클이며, 고정까지 가야 다음 느린 쿼리가 사용자 항의가 아니라 알람으로 도착한다.**
