# 실행 계획 읽기와 느린 쿼리 개선 프로세스 — 견적서를 읽고, 청구서로 검증하고, 사이클을 팀 자산으로 고정한다

> 핵심 관전 포인트: **`EXPLAIN`은 옵티마이저가 통계를 보고 쓴 "견적서"(추정)이고,
> `EXPLAIN ANALYZE`는 실제로 실행해 받은 "청구서"(실측)다. 견적서는 정해진
> 순서로 읽는다 — ① 행 순서(위가 드라이빙) → ② `type` 등급(경계선은
> `range`|`index`: 왼쪽은 인덱스로 "좁힌" 것, 오른쪽은 "전부 읽은" 것) →
> ③ `key`·`key_len`(어느 인덱스를 **몇 번째 컬럼까지** 썼나) → ④ `rows`×`filtered`
> (얼마나 읽어서 얼마나 남기나) → ⑤ `Extra`(`filesort`·`temporary`·`join buffer`가
> 3대 위험 신호, `Using index`가 최고의 신호). 느린 쿼리 개선은
> "인덱스 추가해봄 → 빨라짐"이 아니라 **측정(무엇이 얼마나 느린지 숫자로) →
> 가설(비용이 어디서 새는지 랜덤 I/O 사슬로) → 검증(실측 + 부작용까지 양면으로)
> → 고정(slow log 임계치·쿼리 수 단정 테스트·배포 전 EXPLAIN 체크를 설정과
> 코드로)**의 사이클이며, 마지막 "고정"까지 가야 한 사이클이 끝난 것이다.**

---

## 0. 질문 + 의도

**질문**: "실행 계획(EXPLAIN)을 어떻게 읽나요? 느린 쿼리를 발견했을 때의
개선 프로세스를 설명해주세요."

관련 질문:
"잘 돌던 쿼리의 실행 계획이 어느 날 갑자기 바뀌어 느려졌습니다. 가능한 원인과 대응은?"
"ORDER BY가 인덱스를 타는 조건은? filesort는 언제 발생하고 왜 문제가 되나요?"

**출제 의도**: rationale의 표현 그대로 — "느린 쿼리 개선을 **'인덱스 추가해봄 →
빨라짐'이 아니라 측정→가설→검증의 사이클**로 수행하는지. 프로세스를 묻는 이유는
**이 능력이 쿼리를 넘어 모든 성능 문제에 이식되기 때문**이다." 즉 이 문항은
두 겹이다. 겉은 "EXPLAIN 컬럼을 아는가"(인출 테스트)이고, 속은 "성능 문제를
**재현 가능한 절차**로 다루는가"(태도 테스트)다. 인덱스 하나 추가해서 빨라진
경험은 누구나 있다. 면접관이 가르고 싶은 것은 그 경험을 **왜 빨라졌는지 숫자로
설명하고, 다음에 같은 문제가 재발하지 않도록 무엇을 남겼는가**까지 말하는
사람이다. 전제가 되는 EXPLAIN 네 칸(`type`·`key`·`rows`·`Extra`)의 기초와
판단 흐름은 [인덱스를 걸었는데도 풀스캔](02-index-not-used-full-scan.md) §5에,
비용 모델(북마크 룩업·랜덤 vs 순차 I/O)은 같은 문서 §4에 있다. 이 문서는 그
위에 **나머지 컬럼, 추정 vs 실측, 그리고 프로세스**를 얹는다.

---

## 1. EXPLAIN은 "견적서"다 — 실행하지 않고, 통계로 추정한다

옵티마이저는 쿼리를 받으면 **실제 데이터를 세어보지 않는다.** DB가 주기적으로
모아둔 통계(테이블 행 수, 컬럼별 서로 다른 값의 개수, 인덱스 크기)를 보고
"이 인덱스를 타면 대략 몇 행을 읽겠구나"를 **추정**하고, 후보 계획들의 추정
비용을 비교해 가장 싼 것을 고른다. `EXPLAIN`은 그 선택 결과를 보여주는 것이다.

> **공사 견적서 비유**
> 견적서에는 "벽지 30롤, 인건비 2일"처럼 **예상** 수량이 적혀 있다. 실제로
> 공사를 해보면 벽지가 45롤 들 수도 있다. `EXPLAIN`의 `rows`는 이 "30롤"이고,
> `EXPLAIN ANALYZE`(§3)의 actual rows가 "45롤"이다. 견적과 청구서가 크게
> 다르면 견적을 낸 근거(통계)가 틀린 것이다.

그래서 EXPLAIN을 읽을 때 붙잡아야 할 첫 전제는 **"여기 적힌 숫자는 전부
추정이고, 추정은 통계가 낡으면 틀린다"** 이다. 이 전제를 놓치면 "EXPLAIN은
멀쩡한데 왜 느리지"에서 멈춘다.

MySQL의 `EXPLAIN` 출력은 **테이블 접근 하나당 한 행**이다. 조인이 세 테이블이면
세 행이 나오고, **위에서 아래 순서가 곧 실행 순서**(같은 `id`라면 맨 위가
드라이빙 테이블)다. 서브쿼리나 파생 테이블은 `id`가 달라지고 `select_type`에
종류가 찍힌다.

```sql
EXPLAIN
SELECT o.id, o.amount, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.user_id = 100 AND o.status = 'ACTIVE'
ORDER BY o.created_at DESC
LIMIT 20;

-- id | select_type | table | type   | possible_keys   | key            | key_len | ref   | rows  | filtered | Extra
-- 1  | SIMPLE      | o     | ref    | idx_orders_user | idx_orders_user| 8       | const | 48000 | 10.00    | Using where; Using filesort
-- 1  | SIMPLE      | u     | eq_ref | PRIMARY         | PRIMARY        | 8       | o.user_id | 1 | 100.00   | NULL
```

이 두 줄을 §2의 순서대로 읽으면 "무엇이 비싼지"가 나온다. 그 전에 각 칸이
무엇인지부터 **목록으로 고정**한다.

---

## 2. 암기 카드 — 칸별로 무엇을 보나

긴장하면 목록은 두 개에서 끊긴다. 그래서 이 절은 **읽는 순서 그대로 외우는
카드**로 만든다. 순서가 곧 진단 순서다.

```text
① 행 순서      : 위 → 아래 = 실행 순서. 맨 위가 드라이빙 테이블
② type         : 접근 방식 등급. 경계선은  range | index
③ key, key_len : 어느 인덱스를, 몇 번째 컬럼까지 썼나
④ rows × filtered : 몇 행 읽어서(rows) 몇 %가 살아남나(filtered)
⑤ Extra        : 위험 신호 3 (filesort / temporary / join buffer)
                  좋은 신호 3 (Using index / index condition / MRR)
```

### 2-1. `type` — 접근 방식 등급, 좋은 것부터 나쁜 것까지

MySQL 문서의 공식 순서(좋음 → 나쁨)는 다음과 같다.

```text
system > const > eq_ref > ref > fulltext > ref_or_null > index_merge
       > unique_subquery > index_subquery > range > index > ALL
```

전부 외울 필요는 없다. **실무에서 매일 보는 일곱 개**를 뜻과 함께 고정한다.

| 등급 | 뜻 | 언제 나오나 |
|---|---|---|
| `const` | 최대 1행. 옵티마이저가 상수로 치환 | PK 또는 UNIQUE 인덱스에 등호 (`WHERE id = 1`) |
| `eq_ref` | 조인에서 안쪽 테이블을 **PK/UNIQUE로 정확히 1행** 찾음 | 드라이빙 행당 안쪽 1행 (`u.id = o.user_id`) |
| `ref` | 비유니크 인덱스 등호 → **여러 행 가능** | `WHERE user_id = 100` (일반 인덱스) |
| `range` | 인덱스로 **연속 구간**을 읽음 | `BETWEEN`, `<`, `>`, `IN (...)`, `LIKE 'abc%'` |
| `index_merge` | 인덱스 여러 개를 각각 타고 결과를 합침 | 서로 다른 컬럼의 `OR` |
| `index` | **인덱스 풀스캔** — 리프를 처음부터 끝까지 | 조건은 못 좁히는데 필요한 컬럼이 인덱스에 다 있을 때(커버링) 또는 인덱스 순 정렬만 필요할 때 |
| `ALL` | **테이블 풀스캔** | 쓸 인덱스가 없거나, 있어도 옵티마이저가 버림 |

**경계선은 `range`와 `index` 사이다.** `const`·`eq_ref`·`ref`·`range`는 인덱스로
읽을 범위를 **좁힌** 것이고, `index`와 `ALL`은 **전부 읽은** 것이다. `index`는
이름에 "인덱스"가 들어 있어 착시를 일으키는데, **읽는 폭이 테이블보다 좁을
뿐 전수 조사**라는 점에서 `ALL`과 같은 부류다. "인덱스는 탔는데요"라는 말이
`type: index`를 가리키고 있다면 그건 탄 게 아니다.

### 2-2. `key` · `key_len` · `possible_keys` — 어느 인덱스를 어디까지 썼나

- `possible_keys`: 후보로 검토된 인덱스들. 여기 있다고 쓴 게 아니다.
- `key`: **실제로 선택된** 인덱스. `NULL`이면 아무것도 안 썼다.
- `key_len`: 선택된 인덱스에서 **몇 바이트까지** 사용했는가.

`key_len`이 중요한 이유는 **복합 인덱스에서 몇 번째 컬럼까지 조건에 쓰였는지를
알려주는 유일한 칸**이기 때문이다. `key`에 `(user_id, status, created_at)`
인덱스 이름이 찍혀 있어도, `key_len`이 첫 컬럼 크기만큼이면 나머지 두 컬럼은
인덱스로 좁히는 데 쓰이지 않았다는 뜻이다.

계산 규칙(InnoDB, utf8mb4 기준)만 알면 읽을 수 있다.

| 타입 | 바이트 |
|---|---|
| `INT` | 4 |
| `BIGINT` | 8 |
| `VARCHAR(n)` | n × 4(문자당 최대 바이트) + 2(길이 저장) |
| `NULL` 허용 컬럼 | 위 값에 **+1** |

```sql
CREATE INDEX idx_orders_user_status_created
  ON orders (user_id, status, created_at);
-- user_id BIGINT NOT NULL(8), status VARCHAR(20) NOT NULL(20×4+2 = 82), created_at DATETIME

EXPLAIN SELECT * FROM orders WHERE user_id = 100;
-- key: idx_orders_user_status_created, key_len: 8      ← user_id 한 컬럼만 사용

EXPLAIN SELECT * FROM orders WHERE user_id = 100 AND status = 'ACTIVE';
-- key: idx_orders_user_status_created, key_len: 90     ← 8 + 82: status까지 사용

EXPLAIN SELECT * FROM orders WHERE user_id = 100 AND created_at > '2026-08-01';
-- key: idx_orders_user_status_created, key_len: 8      ← 가운데 status가 빠져
--   created_at은 인덱스 탐색에 못 쓰임 (leftmost prefix). "인덱스 탔다"고 안심하면 안 되는 경우
```

**`key_len`은 "인덱스를 탔는가"가 아니라 "인덱스를 얼마나 깊이 탔는가"에
답한다.** 복합 인덱스를 설계해 놓고 실제로는 선두 컬럼 하나만 쓰이고 있는
경우를 잡아내는 칸이다.

### 2-3. `rows` × `filtered` — 얼마나 읽어서 얼마나 남기나

- `rows`: 이 단계에서 **읽을 것으로 추정한** 행 수 (스토리지 엔진에서 가져올 양).
- `filtered`: 읽은 행 중 **인덱스로 못 거른 나머지 WHERE 조건**을 통과해 살아남을
  비율(%)의 추정.

`rows × filtered%`가 **다음 단계로 넘어가는 행 수**다. 앞의 예시에서
`rows: 48000, filtered: 10.00`은 "인덱스로 4만 8천 행을 가져와서, 그중 10%인
4,800행만 `status = 'ACTIVE'`를 통과한다"는 뜻이다. **읽은 것의 90%를 버린다** —
이것이 이 쿼리의 비용이 새는 지점이다.

조인이라면 각 행의 `rows`를 **곱한** 것이 총 검사량의 어림이다. 드라이빙에서
4만 8천 행이 넘어가고 안쪽이 `eq_ref`로 행당 1건이면 안쪽 탐색이 4만 8천 번
일어난다 — [JOIN 종류와 실행 방식](06-join-types-and-execution.md)의 NL 비용
공식("바깥 루프 횟수 × 안쪽 탐색 비용") 그대로다.

위험 신호는 두 조합이다.

- **`rows`가 테이블 전체 행 수에 가깝다** → 사실상 풀스캔.
- **`rows`는 큰데 `filtered`가 낮다** → 인덱스가 조건을 절반만 덮는다. 많이
  읽고 대부분 버린다. 인덱스에 컬럼을 추가하면 `rows` 자체가 줄어든다.

### 2-4. `Extra` — 위험 신호 3 + 좋은 신호 3

| 신호 | 뜻 | 판정 |
|---|---|---|
| `Using filesort` | 정렬을 인덱스 순서로 해결 못 해 **별도 정렬 작업**을 붙임 (이름과 달리 메모리에서 하기도 하고, sort buffer를 넘치면 디스크 임시 파일) | **위험** — `LIMIT 20`이어도 대상 **전부** 읽고 정렬한 뒤 20건 |
| `Using temporary` | `GROUP BY`·`DISTINCT`·`UNION` 처리에 **임시 테이블**을 만듦 | **위험** — 메모리 한도를 넘으면 디스크 임시 테이블 |
| `Using join buffer (Block Nested Loop)` / `(hash join)` | 안쪽 테이블의 **조인 키에 쓸 인덱스가 없어** 버퍼에 담아 뭉텅이로 비교 | **위험** — "조인이 느려요"의 단골 |
| `Using index` | 필요한 컬럼이 전부 인덱스에 있어 **테이블에 안 감**(커버링) | **최고의 신호** — 북마크 룩업 0회 |
| `Using index condition` | 인덱스 컬럼으로 거를 수 있는 조건을 **스토리지 엔진 층에서 먼저** 적용(Index Condition Pushdown) — 테이블 접근 전에 버림 | 좋음 |
| `Using MRR` | 세컨더리 인덱스에서 모은 PK를 **PK 순으로 정렬한 뒤** 테이블을 읽음(Multi-Range Read) — 흩어진 랜덤 I/O를 순차에 가깝게 바꿈 | 좋음 |

그 밖에 자주 보이는 것들: `Using where`는 "스토리지 엔진에서 받은 행을 서버
층에서 한 번 더 거른다"는 뜻으로 **그 자체는 흔하지만 `rows` 크고 `filtered`
낮은 것과 함께 있으면 위험 신호**다. `Select tables optimized away`는
`MIN`/`MAX`/`COUNT(*)`를 인덱스 메타데이터만으로 끝냈다는 좋은 신호.
`Range checked for each record`는 드라이빙 행마다 인덱스 사용 여부를 다시
판단하는 것으로 위험 신호다. `Impossible WHERE`는 조건이 모순이라 아예 안
읽는다는 뜻(`WHERE 1 = 0` 등).

**(가산점 포인트)** `Using MRR`은 후보자의 횡단 약점인 **랜덤 vs 순차 I/O**가
옵티마이저 기능으로 구현된 사례다. 세컨더리 인덱스에서 얻은 PK 목록은 뒤죽박죽
순서라 그대로 테이블을 읽으면 페이지를 여기저기 찌른다(랜덤). MRR은 그
PK들을 버퍼에 모아 **정렬한 뒤** 읽어서 인접 페이지를 연달아 읽게 만든다(순차에
가깝게). "DB가 랜덤 I/O를 얼마나 싫어하면 이런 기능까지 만들었겠는가"로
기억하면 비용 모델이 같이 굳는다.

### 2-5. `select_type` — 한 번만 훑어두면 되는 칸

`SIMPLE`(서브쿼리·UNION 없음) / `PRIMARY`(가장 바깥) / `SUBQUERY` /
`DERIVED`(FROM 절의 서브쿼리 = 파생 테이블) / `UNION`. 이 중 경계할 것은
**`DEPENDENT SUBQUERY`** 하나다 — 바깥 행의 값에 의존하는 서브쿼리라 **바깥
행마다 재실행**된다. 바깥이 10만 행이면 서브쿼리가 10만 번 돈다. 조인으로
풀어 쓰는 것이 처방이다.

---

## 3. 추정 vs 실측 — `EXPLAIN`과 `EXPLAIN ANALYZE`

MySQL 8.0.18부터 지원하는 `EXPLAIN ANALYZE`는 **쿼리를 실제로 실행**하고,
계획의 각 단계마다 **실측값**을 붙여 트리 형태로 보여준다. 이 하나로
"견적서 vs 청구서"를 한 화면에서 비교할 수 있다.

```sql
EXPLAIN ANALYZE
SELECT o.id, o.amount, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.user_id = 100 AND o.status = 'ACTIVE'
ORDER BY o.created_at DESC
LIMIT 20;

-- -> Limit: 20 row(s)  (actual time=312.4..312.5 rows=20 loops=1)
--     -> Sort: o.created_at DESC, limit input to 20 row(s) per chunk  (actual time=312.4..312.4 rows=20 loops=1)
--         -> Nested loop inner join  (cost=21456 rows=4800) (actual time=0.09..305.1 rows=4720 loops=1)
--             -> Filter: (o.status = 'ACTIVE')  (cost=16800 rows=4800) (actual time=0.06..289.7 rows=4720 loops=1)
--                 -> Index lookup on o using idx_orders_user (user_id=100)  (cost=16800 rows=48000) (actual time=0.05..271.3 rows=47215 loops=1)
--             -> Single-row index lookup on u using PRIMARY (id=o.user_id)  (cost=0.25 rows=1) (actual time=0.003..0.003 rows=1 loops=4720)
```

읽는 법은 세 가지다.

**① 괄호 두 개를 나란히 본다.** `(cost=… rows=48000)`이 추정, `(actual time=…
rows=47215 loops=1)`이 실측. 여기서는 추정 4만 8천 vs 실측 4만 7천으로 거의
맞다. **이 두 `rows`가 자릿수 단위로 어긋나면 통계가 틀린 것**이고, 그때는
튜닝이 아니라 `ANALYZE TABLE`이 먼저다.

**② `actual time`은 `first..last` 밀리초이고, `loops`만큼 반복된 평균이다.**
`Single-row index lookup on u … (actual time=0.003..0.003 rows=1 loops=4720)`은
"한 번에 0.003ms, 이걸 4,720번 했다"는 뜻이다. 총비용은 `0.003 × 4720 ≈ 14ms`.
**안쪽 테이블의 시간은 반드시 `loops`를 곱해서 읽어야 한다** — 이걸 놓치면
"조인은 0.003ms밖에 안 걸리는데?"라는 오독이 나온다.

**③ 시간이 어디서 튀는지 아래에서 위로 올라간다.** 위 예시에서 `Index lookup
on o`가 0.05ms에 시작해 271ms에 끝났다 — 4만 7천 행을 인덱스로 찾고 **각 행을
테이블에서 다시 읽는(북마크 룩업)** 데 대부분의 시간이 갔고, 그 4만 7천 행
중 4,720행만 `status` 필터를 통과했다. **비용의 90%가 "결국 버릴 행을 랜덤
I/O로 읽는 데" 쓰였다.** 이것이 §4-2에서 세울 가설의 근거다.

두 도구의 차이를 한 표로 고정한다.

| | `EXPLAIN` | `EXPLAIN ANALYZE` |
|---|---|---|
| 실행 여부 | **안 함** | **실제 실행** |
| 숫자의 성격 | 통계 기반 **추정** | **실측** (time, rows, loops) |
| 운영 DB에서 | 안전 (계획만 봄) | 주의 — 무거운 SELECT는 그대로 부하가 되고, 데이터를 바꾸는 문은 **실제로 바뀐다** |
| 쓰는 순간 | 배포 전 검토, 첫 진단 | 추정과 현실의 괴리 확인, 개선 전후 비교 |

**(가산점 포인트)** MySQL 8에는 이 밖에도 `EXPLAIN FORMAT=TREE`(실행 안 하고
트리 형태로 — 해시 조인 사용 여부가 보임), `EXPLAIN FORMAT=JSON`(단계별
추정 비용 수치 포함), 그리고 **`EXPLAIN FOR CONNECTION <스레드 id>`**가 있다.
마지막 것은 **지금 돌고 있는 쿼리의 실행 계획**을 보는 명령으로, 장애 상황에서
`SHOW PROCESSLIST`로 오래 걸리는 스레드를 찾은 뒤 그 계획을 즉시 확인할 때
쓴다. PostgreSQL은 `EXPLAIN (ANALYZE, BUFFERS)`로 각 단계의 버퍼 캐시
적중(`shared hit`)과 디스크 읽기(`read`)를 분리해 보여줘, **"느린 이유가 랜덤
디스크 I/O인가, CPU인가"를 숫자로 가른다.**

---

## 4. 개선 프로세스 — 측정 → 가설 → 검증 → 고정

"인덱스 추가해봄 → 빨라짐"이 왜 프로세스가 아닌지부터 분명히 한다.

```text
❌ 흔한 흐름
   느리다는 제보 → 쿼리를 눈으로 봄 → WHERE 컬럼에 인덱스 추가 → 빨라진 것 같음 → 끝
   문제: 무엇이 얼마나 느렸는지 숫자가 없다 / 왜 빨라졌는지 모른다 /
         다른 쿼리가 느려졌는지 모른다 / 3개월 뒤 같은 패턴이 재발해도 아무도 모른다

✅ 사이클
   ① 측정: 무엇이, 얼마나, 몇 번, 언제 느린가 — 숫자와 재현 조건
   ② 가설: EXPLAIN에서 비용이 새는 지점을 "메커니즘 사슬"로 특정하고, 예상 효과를 숫자로
   ③ 검증: EXPLAIN ANALYZE로 전후 실측 + 부작용(쓰기 비용·다른 쿼리·DDL 리스크)까지 양면으로
   ④ 고정: 재발을 사람이 아니라 설정·테스트·파이프라인이 잡도록 남긴다  ← 여기까지가 한 사이클
```

### 4-1. 측정 — "느리다"를 네 개의 숫자로

입력은 사람의 제보가 아니라 **로그와 지표**여야 한다.

- **slow query log**: `long_query_time`을 넘긴 쿼리를 기록. 실행 시간, 락 대기
  시간, 검사한 행 수(`Rows_examined`), 반환한 행 수(`Rows_sent`)가 남는다.
  `Rows_examined`가 `Rows_sent`의 수천 배면 그것만으로 "많이 읽고 대부분
  버린다"는 진단이 선다.
- **`performance_schema.events_statements_summary_by_digest`**: 파라미터를
  정규화한 쿼리 패턴별로 **실행 횟수, 총 소요 시간, 총 검사 행 수**를 누적.
  `sys.statement_analysis`, `sys.statements_with_full_table_scans` 뷰가 이걸
  보기 좋게 감싼다.
- **APM**(Pinpoint, Datadog 등): 어느 API 엔드포인트에서 어느 쿼리가 몇 번
  호출되는지. **N+1은 쿼리 하나는 빠른데 요청당 수백 번 호출되는 문제**라
  slow log에는 안 잡히고 여기서만 보인다.

우선순위를 정하는 기준은 **"가장 느린 쿼리"가 아니라 "가장 비싼 쿼리"**다.

```sql
-- 총 비용 = 평균 시간 × 호출 횟수 순으로 정렬
SELECT DIGEST_TEXT,
       COUNT_STAR                          AS calls,
       SUM_TIMER_WAIT / 1e12               AS total_sec,
       SUM_TIMER_WAIT / COUNT_STAR / 1e9   AS avg_ms,
       SUM_ROWS_EXAMINED / COUNT_STAR      AS avg_rows_examined,
       SUM_ROWS_SENT / COUNT_STAR          AS avg_rows_sent
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;
-- 1초짜리 하루 1회(총 1초)보다 50ms짜리 하루 10만 회(총 5,000초)가 병목이다
```

측정 단계에서 함께 적어둘 것이 **재현 조건**이다 — 어떤 파라미터에서 느린가
(같은 쿼리도 `user_id`에 따라 대상 행 수가 100배 차이 날 수 있다), 어느
시간대인가(배치와 겹치는가), **실행이 느린 건가 락을 기다린 건가**(slow log의
`Lock_time`, `SHOW PROCESSLIST`의 State가 `Waiting for …`이면 실행 계획
문제가 아니라 동시성 문제다).

그리고 측정은 **운영 규모 데이터에서** 해야 한다. 로컬 100건짜리 테이블에서는
어떤 쿼리든 빠르고, 심지어 **실행 계획 자체가 다르다** — 옵티마이저는 작은
테이블에서 인덱스 대신 풀스캔을 고르는 게 정상이라, 로컬 EXPLAIN에 `ALL`이
떠도 운영에선 `ref`일 수 있고 그 반대도 있다.

### 4-2. 가설 — 비용이 "어디서 새는지"를 사슬로 말한다

EXPLAIN을 §2 순서대로 읽으면서, **"느리다"를 메커니즘 사슬로 번역**하는
단계다. 후보자가 4장에서 5회 연속 멈춘 지점이 정확히 여기다 — "성능 저하",
"메모리 부하", "왔다갔다"에서 끝나지 않고 **이름 붙은 단계**로 끝까지 잇는다.

| EXPLAIN에서 본 것 | 뭉뚱그린 말 | 사슬로 말하기 |
|---|---|---|
| `type: ref, rows: 48000, filtered: 10, Extra: Using where; Using filesort`, `SELECT *` | "인덱스는 타는데 느려요" | 인덱스로 PK 4만 8천 개 수집(순차, 쌈) → **각 PK로 클러스터드 인덱스 재탐색 4만 8천 번(랜덤 I/O, 비쌈)** → 그중 90%를 `status` 필터에서 버림 → 남은 4,800건을 sort buffer에서 정렬 → 20건 반환. **비용 = 버릴 행에 쓴 랜덤 I/O + 정렬** |
| 안쪽 테이블 `key: NULL, Extra: Using join buffer` | "조인이 느려요" | 드라이빙 행 수만큼 안쪽을 **통순회** → 버퍼에 뭉텅이로 담아 비교하지만 결국 안쪽 전체 × 뭉텅이 수만큼 읽음 → 조인 키 인덱스 하나로 "행당 트리 탐색 1회"로 바뀜 |
| `Extra: Using filesort` + `LIMIT 20` | "정렬이 느려요" | 정렬 컬럼이 인덱스 순서와 안 맞음 → **대상 전부**를 읽어 sort buffer에 적재 → 넘치면 디스크 임시 파일에 청크 저장 후 병합 → 그제야 앞 20건. 인덱스 순서와 맞추면 **리프 앞 20건 읽고 끝** |
| `type: ALL, rows: 1000000` | "풀스캔이라 느려요" | 순차 I/O라 **행당은 싸지만** 총량이 100만 → 읽은 페이지가 버퍼 풀을 채우며 **다른 쿼리의 캐시를 밀어냄(버퍼 풀 오염)** → 이 쿼리만이 아니라 옆 쿼리까지 디스크로 떨어짐 |
| `select_type: DEPENDENT SUBQUERY` | "서브쿼리가 느려요" | 바깥 행마다 서브쿼리 재실행 → 바깥 10만 행이면 10만 번 → 조인 또는 파생 테이블로 한 번만 실행되게 |

가설에는 반드시 **예상 효과를 숫자로** 붙인다. "인덱스 추가하면 빨라질 것
같다"가 아니라 **"`(user_id, status, created_at)` 인덱스를 만들면 `rows`가
4만 8천에서 20 근처로 줄고 `filesort`가 사라진다"** — 이렇게 써 두어야 검증
단계에서 맞았는지 틀렸는지를 판정할 수 있다. 숫자 없는 가설은 검증이 불가능하다.

### 4-3. 검증 — 실측으로 확인하고, 부작용까지 한 호흡에

가설대로 고친 뒤 **같은 파라미터, 운영 규모 데이터**에서 `EXPLAIN ANALYZE`를
전후로 비교한다.

```sql
-- before
-- -> Index lookup on o using idx_orders_user (user_id=100)  (actual time=0.05..271.3 rows=47215 loops=1)
-- -> Sort ... (actual time=312.4..312.4 rows=20 loops=1)

CREATE INDEX idx_orders_user_status_created
  ON orders (user_id, status, created_at);
--   등호(user_id) → 등호(status) → 정렬(created_at) 순: 두 등호로 좁힌 구간이
--   created_at 순으로 이미 정렬돼 있으므로 LIMIT 20이 리프 앞 20건에서 끝난다

-- after
-- -> Limit: 20 row(s)  (actual time=0.31..0.34 rows=20 loops=1)
--     -> Index lookup on o using idx_orders_user_status_created (user_id=100, status='ACTIVE') (reverse)
--          (actual time=0.05..0.19 rows=20 loops=1)     ← rows 47215 → 20, Sort 노드 자체가 사라짐
```

여기서 멈추면 반쪽이다. 후보자가 3회 반복한 약점 — **이득만 말하고 대가를
안 붙이는 것** — 을 이 단계에서 교정한다. 인덱스 추가의 대가는 정해져 있다.

> **한 호흡 템플릿**: "이 인덱스는 **[이득]** 이 쿼리의 `rows`를 4만 8천에서 20으로
> 줄이고 `filesort`를 없애며 랜덤 I/O 4만 8천 번을 20번으로 만든다. **[대가]**
> 대신 `orders`에 INSERT/UPDATE가 일어날 때마다 B+Tree 하나를 더 갱신하고,
> 인덱스 크기만큼 디스크와 버퍼 풀을 더 쓰며, `user_id`를 선두로 쓰는 다른
> 쿼리들의 계획이 바뀔 수 있고, 수억 건 테이블이면 인덱스 생성 DDL 자체가
> 운영 리스크다. **[판단]** 그래서 기존 `(user_id)` 단독 인덱스는 새 인덱스의
> 선두 컬럼에 흡수되므로 삭제해 쓰기 대가를 상쇄하고, DDL은 온라인 방식으로
> 트래픽이 적은 시간에 건다."

검증 체크리스트는 네 줄이다.

1. **대상 쿼리의 실측이 가설대로 개선됐는가** — `actual rows`, `actual time`.
2. **같은 테이블을 쓰는 상위 쿼리들의 EXPLAIN이 나빠지지 않았는가** — 새 인덱스가
   생기면 옵티마이저의 선택지가 늘고, 선택도 낮은 컬럼이 선두인 인덱스는
   옵티마이저를 **오히려 잘못된 길로 유인**할 수 있다. §4-1의 digest 상위
   목록에서 같은 테이블 쿼리를 골라 다시 EXPLAIN한다.
3. **쓰기 처리량**이 허용 범위인가 — 쓰기 비중이 높은 테이블이면 인덱스 하나가
   INSERT p95를 눈에 띄게 올린다.
4. **DDL 실행 방식** — `ALTER TABLE … ADD INDEX …, ALGORITHM=INPLACE, LOCK=NONE`
   으로 온라인 생성이 가능한지, 불가능하면 pt-online-schema-change / gh-ost 같은
   도구가 필요한지. (무중단 DDL은 별도 문항이라 여기선 "확인 항목"으로만.)

### 4-4. 고정 — 사람의 기억이 아니라 설정·테스트·파이프라인에

여기가 이 문서에서 가장 힘을 주는 절이다. 후보자는 3장에서 **"사람의 기억에
의존하지 않는 방법"을 명시해 물었는데도 TODO 주석으로 답한** 것을 포함해
안전망을 코드로 고정하는 습관의 부재가 7회 반복됐다. 성능 개선은 **한 번
고치는 것보다 재발을 잡는 구조를 남기는 것**이 더 가치 있다 — 같은 팀의
다른 개발자가 석 달 뒤 같은 패턴의 쿼리를 또 쓸 것이기 때문이다.

고정은 세 층으로 한다: **설정**(측정이 자동으로 계속되게) / **테스트**(회귀가
CI에서 터지게) / **파이프라인·템플릿**(절차가 사람 기억 밖에 있게).

#### 층 1 — 설정: slow query log 임계치와 알람을 코드로

```ini
# ❌ before: "느리면 누가 보겠지" — long_query_time 기본값(10초)이면 9초짜리 쿼리는 영영 안 잡힌다

# ✅ after: my.cnf 또는 RDS 파라미터 그룹(Terraform으로 형상 관리)
[mysqld]
slow_query_log                = ON
long_query_time               = 0.5    # API p95 목표에서 역산한 값. 0.5초 넘는 쿼리는 전부 기록
log_queries_not_using_indexes = ON     # 시간과 무관하게 풀스캔 쿼리 기록 (소음이 크면 log_throttle_queries_not_using_indexes로 제한)
```

로그는 쌓이기만 하면 아무도 안 본다. **pt-query-digest 일일 리포트**를 채널로
보내거나, 로그 수집기(CloudWatch, Datadog)에서 **"분당 slow log 건수" 알람**을
건다. 알람 임계치 자체도 IaC 파일에 들어간다. 이렇게 하면 §4-1의 "측정"이
사람이 마음먹을 때가 아니라 **항상** 돌아간다.

#### 층 2 — 테스트: 쿼리 수 단정과 EXPLAIN 단정을 CI에

**쿼리 수 단정 테스트**는 N+1 회귀를 잡는 가장 싼 안전망이다. datasource-proxy
(또는 p6spy)를 테스트 프로파일에 붙이면 실행된 쿼리 수를 셀 수 있다.

```java
// ❌ before: fetch join으로 N+1을 고친 뒤 남긴 것이 주석뿐
// TODO: 이 메서드는 N+1 주의. 연관 로딩 바꿀 때 쿼리 수 확인할 것
public Page<OrderSummary> getOrders(Long userId, Pageable pageable) { ... }
```

```java
// ✅ after: 쿼리 수를 테스트가 단정한다 — 누군가 fetch join을 지우면 CI가 빨간불
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

**EXPLAIN 단정 테스트**는 한 단계 더 나간다. Testcontainers로 띄운 MySQL에
**운영과 비슷한 규모**의 데이터를 적재하고(작은 테이블에선 옵티마이저가
풀스캔을 고르는 게 정상이므로 규모가 중요하다), 핵심 쿼리의 실행 계획을
단정한다.

```java
@Test
void 주문_목록_쿼리는_풀스캔하지_않고_정렬도_인덱스로_처리한다() {
    // given: 마이그레이션 적용 + 대량 시드 데이터 (예: orders 50만 건)
    String sql = """
        EXPLAIN SELECT o.id, o.amount FROM orders o
        WHERE o.user_id = ? AND o.status = 'ACTIVE'
        ORDER BY o.created_at DESC LIMIT 20
        """;

    List<Map<String, Object>> plan = jdbcTemplate.queryForList(sql, 100L);

    for (Map<String, Object> row : plan) {
        assertThat(row.get("type")).as("테이블 %s 풀스캔", row.get("table"))
            .isNotIn("ALL", "index");
        assertThat(String.valueOf(row.get("Extra")))
            .doesNotContain("Using filesort")
            .doesNotContain("Using temporary");
    }
}
```

이 테스트는 **"인덱스를 지우거나 컬럼 순서를 바꾸면 빌드가 깨진다"**는 뜻이다.
석 달 뒤 누군가 "안 쓰는 것 같은데"라며 인덱스를 정리해도, 리뷰어가 못
잡아도, CI가 잡는다.

#### 층 3 — 파이프라인·템플릿: 절차를 사람 밖으로

- **인덱스 DDL은 반드시 마이그레이션 파일로** (Flyway `V12__add_idx_orders_user_status_created.sql`).
  운영 콘솔에서 손으로 만든 인덱스는 스테이징에 없고, 다음 사람은 그 존재를
  모른다. 스키마가 코드에 있어야 EXPLAIN 단정 테스트도 같은 스키마에서 돈다.
- **PR 템플릿에 체크 항목**을 박는다. 리뷰어의 기억이 아니라 파일이 묻게 한다.

  ```markdown
  ## DB 변경 체크 (해당 없으면 N/A)
  - [ ] 새로 추가/변경한 쿼리의 EXPLAIN 결과를 첨부했다 (운영 규모 데이터 기준)
  - [ ] 인덱스 추가/삭제는 마이그레이션 파일로 했고, 온라인 DDL 가능 여부를 확인했다
  - [ ] 같은 테이블을 쓰는 기존 상위 쿼리의 계획 변화를 확인했다
  ```
- **힌트(`FORCE INDEX` 등)를 썼다면** 주석에 "왜, 어떤 측정 근거로, 언제
  재검토"를 남기고 티켓을 건다. 힌트는 지금의 데이터 분포를 코드에 박제하는
  것이라 **만료일이 있는 부채**다.
- **(가산점 포인트)** 만든 인덱스가 실제로 쓰이는지를 주기적으로 확인하는
  것도 고정 대상이다. `sys.schema_unused_indexes`(마지막 재시작 이후 한 번도
  안 쓰인 인덱스)를 월 1회 리포트로 받으면, 쓰기 비용만 내는 죽은 인덱스가
  쌓이는 것을 막는다.

세 층을 다 갖추면 사이클은 이렇게 닫힌다 — **설정이 측정하고, 테스트가
회귀를 잡고, 템플릿이 절차를 강제한다.** 그리고 다음 느린 쿼리는 사용자
항의가 아니라 slow log 알람으로 도착한다.

---

## 5. 실무 사례 — 한 사이클을 처음부터 끝까지

"주문 목록 API가 느리다"는 제보를 사이클로 처리한 기록이다. 숫자는 예시다.

**측정.** APM에서 `GET /orders` p95가 2.4초. digest 상위 1위는
`SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 20`
— 평균 1.8초, 하루 12만 회, `avg_rows_examined` 4만 7천 / `avg_rows_sent` 20.
**2,350배를 읽어서 버린다.** slow log의 `Lock_time`은 0에 가까워 락 문제는 아니다.
느린 파라미터는 주문이 많은 헤비 유저들 — `user_id`별 편차가 크다.

**가설.** EXPLAIN: `type: ref, key: idx_orders_user, key_len: 8, rows: 48000,
filtered: 10.00, Extra: Using where; Using filesort`. 사슬로 번역하면 —
`user_id` 인덱스로 4만 8천 개 PK를 모아 → 4만 8천 번 북마크 룩업(랜덤 I/O)
→ `status` 필터로 90% 폐기 → 4,800건 정렬 → 20건. **비용의 대부분이 "버릴
행의 랜덤 I/O"와 "정렬"이다.** 처방 가설: `(user_id, status, created_at)`
복합 인덱스. 예상 효과: `rows` 4만 8천 → 20, `filesort` 제거, `key_len` 8 → 90.

**검증.** 스테이징(운영 마스킹 덤프)에서 `EXPLAIN ANALYZE` 전후: 312ms → 0.3ms.
같은 테이블 digest 상위 5개 재확인 — 3개는 새 인덱스로 자연 이동(`user_id`
선두 동일), 2개는 무관. 기존 `idx_orders_user`는 새 인덱스에 흡수되므로 삭제
→ 인덱스 수 유지, 쓰기 비용 증가분 상쇄. `orders` 3억 건이라 DDL은
`ALGORITHM=INPLACE, LOCK=NONE` 확인 후 새벽 배포. **대가**: 인덱스 크기
약 12GB 증가(status·created_at 추가분), 배포 중 복제 지연 모니터링 필요.

**고정.** Flyway 마이그레이션 2건(생성·삭제) / EXPLAIN 단정 테스트 1건 추가 /
`long_query_time`을 1초에서 0.5초로 내리고 알람 연결 / PR 템플릿에 DB 체크
항목 추가. **다음 주 같은 팀원이 `orders`에 `WHERE user_id = ? AND
payment_method = ?` 쿼리를 올렸을 때, PR 템플릿이 EXPLAIN을 요구했고
`filtered: 5.00`이 리뷰에서 잡혔다.** 이것이 고정의 효과다.

---

## 6. 꼬리질문 대비 포인트

### "`rows` 추정이 실제와 크게 다르면 무엇을 의심하고, 어떻게 확인·수정하나요?"

**통계 정보가 현실과 어긋난 것**을 첫째로 의심한다. 옵티마이저는 통계로
추정하고(§1), 통계는 샘플링으로 만들어지며, 대량 적재·삭제 직후나 데이터
분포가 편중된 컬럼에서 잘 틀린다. 확인은 `EXPLAIN ANALYZE`의 추정 `rows`와
`actual rows` 비교 — 자릿수가 다르면 확정이다. 수정은 ⑴ `ANALYZE TABLE`로
통계 재수집, ⑵ 그래도 틀리면 샘플링 페이지 수(`innodb_stats_persistent_sample_pages`)
를 늘려 정밀도를 올리고, ⑶ **값 분포가 편중된 컬럼**(90%가 `ACTIVE`인 `status`
같은)이라면 MySQL 8의 **히스토그램**(`ANALYZE TABLE … UPDATE HISTOGRAM ON status`)
을 만든다 — 기본 통계는 "서로 다른 값 몇 개"만 알지 "어느 값이 몇 %인지"는
모르는데, 히스토그램이 그 분포를 알려준다. 이 세 단계를 다 밟은 뒤에야 힌트를
검토한다. "코드도 쿼리도 안 바꿨는데 느려졌다"(+α 문항)의 정체가 대개 이것이다.

### "EXPLAIN 결과는 좋은데(`ref`, `rows` 작음) 운영에서 느립니다. 어디를 보나요?"

**EXPLAIN은 "쿼리 하나의 계획"이지 "요청 하나의 비용"이 아니다**라는 전제에서
출발한다. 순서대로 — ⑴ **EXPLAIN에 넣은 파라미터가 느린 그 파라미터인가**:
`user_id = 1`(주문 3건)과 `user_id = 100`(4만 건)은 같은 쿼리, 다른 비용이다.
slow log에서 실제 느렸던 값을 가져와 다시 본다. ⑵ **실행이 아니라 대기인가**:
`Lock_time`, `SHOW PROCESSLIST`의 State. 계획이 완벽해도 앞 트랜잭션의 락을
기다리면 느리다. ⑶ **호출 횟수**: 3ms짜리 쿼리가 요청당 500번 돌면 1.5초다 —
N+1은 EXPLAIN에 절대 안 보이고 APM이나 쿼리 수 단정 테스트에만 보인다.
⑷ **버퍼 풀 미스**: 계획은 같아도 페이지가 메모리에 있느냐 디스크에 있느냐로
100배 차이 난다. 새벽 첫 호출, 배치 직후(버퍼 풀 오염)가 전형이다.
⑸ **결과셋 크기와 네트워크**: `SELECT *`로 TEXT 컬럼 수천 건을 끌어오면 DB는
빠른데 전송이 느리다. `EXPLAIN ANALYZE`가 이 중 ⑴과 ⑷를 실측으로 갈라준다.

### "인덱스를 추가하면 다른 쿼리가 느려질 수도 있나요? 그걸 어떻게 미리 아나요?" (시니어 변별 포인트)

**있다. 세 경로다.** ⑴ **쓰기 경로**: 모든 INSERT/UPDATE/DELETE가 B+Tree
하나를 더 갱신하므로 쓰기 p95가 오른다 — 쓰기 비중이 높은 테이블일수록 체감이
크다. ⑵ **옵티마이저 오유인**: 선택지가 늘면 옵티마이저가 **새 인덱스를 잘못
고를 수 있다.** 특히 선두 컬럼의 선택도가 낮은 인덱스는 "일단 이걸 타볼까"로
유인해 북마크 룩업 폭탄을 만든다. ⑶ **버퍼 풀 경쟁**: 인덱스도 메모리에
올라오므로, 큰 인덱스 하나가 다른 테이블의 핫 페이지를 밀어낸다. 미리 아는
방법은 §4-3 체크리스트 2번 — **같은 테이블을 쓰는 digest 상위 쿼리를 골라
새 인덱스 생성 후 EXPLAIN을 다시 뜬다.** 그리고 이 재확인을 사람이 기억하지
않도록 PR 템플릿에 항목으로 박고, 핵심 쿼리는 EXPLAIN 단정 테스트로 고정한다.
트레이드오프를 한 호흡에 말하면 — "이 인덱스는 조회 쿼리 A의 랜덤 I/O를
없애는 대신 쓰기 비용·메모리·옵티마이저 선택지라는 세 대가를 내고, 그 대가가
허용 범위인지는 digest 재확인과 쓰기 p95로 검증한다."

### "`EXPLAIN ANALYZE`를 운영 DB에서 그냥 돌려도 되나요?"

**조건부다.** 실제로 실행하므로 ⑴ 무거운 SELECT는 그 자체가 부하고 버퍼 풀을
오염시킨다, ⑵ UPDATE/DELETE에 붙이면 **데이터가 실제로 바뀐다.** 그래서 원칙은
**읽기 복제본이나 운영 규모 스테이징에서** 돌리는 것이고, 운영 프라이머리에서
꼭 해야 한다면 SELECT만, 트래픽 낮은 시간에, 필요하면 `LIMIT`으로 범위를 줄여서.
변경문은 트랜잭션을 열고 `ROLLBACK`하거나 SELECT로 바꿔서 본다. 대신 **일반
`EXPLAIN`은 실행하지 않으므로 운영에서 언제든 안전**하다 — 첫 진단은 EXPLAIN,
괴리 확인은 EXPLAIN ANALYZE, 이 분업을 말하면 된다.

### "이 프로세스를 팀에 정착시키려면 무엇부터 코드로 고정하나요? 우선순위와 이유를 말해주세요." (시니어 변별 포인트)

**비용 대비 효과 순으로 네 단계다.** ⑴ **slow query log 임계치 + digest
대시보드** — 측정이 없으면 나머지 전부가 시작을 못 한다. 설정 몇 줄이라
비용이 가장 싸고, 이것만으로 "어디가 비싼지"가 매일 보인다. ⑵ **쿼리 수 단정
테스트** — 실무에서 가장 흔한 성능 회귀는 인덱스 누락이 아니라 N+1이고,
N+1은 slow log에 안 잡힌다. datasource-proxy 하나 붙이고 핵심 조회 메서드에
단정 3~4개면 된다. ⑶ **인덱스 DDL의 마이그레이션 강제 + PR 템플릿** — 도구가
아니라 규칙이지만 파일로 박으면 리뷰어 기억에서 독립한다. ⑷ **EXPLAIN 단정
테스트** — 운영 규모 시드 데이터가 필요해 비용이 가장 크므로 마지막이고,
장애를 겪은 핵심 쿼리부터 하나씩 늘린다. 이 순서를 뒤집어 ⑷부터 하면 시드
데이터 관리에 지쳐 중단되고, ⑴을 빼면 무엇을 테스트할지조차 모른다.
**"측정 → 가장 흔한 회귀 → 절차의 파일화 → 정밀 회귀 방지"** 순이다.

---

## 한 줄 요약

**`EXPLAIN`은 통계로 쓴 견적서, `EXPLAIN ANALYZE`는 실행해 받은 청구서다 —
견적서는 행 순서 → `type`(경계선 `range`|`index`) → `key`·`key_len`(몇 번째
컬럼까지) → `rows`×`filtered`(읽어서 남기는 비율) → `Extra`(`filesort`·
`temporary`·`join buffer` 위험, `Using index` 최고) 순으로 읽고, 두 문서의
`rows`가 어긋나면 튜닝이 아니라 통계 갱신이 먼저다. 느린 쿼리 개선은
측정(가장 비싼 쿼리를 숫자로) → 가설(비용이 새는 지점을 랜덤 I/O 사슬로,
예상 효과를 숫자로) → 검증(실측 + 쓰기 비용·다른 쿼리·DDL 리스크까지 한
호흡에) → 고정(slow log 임계치·쿼리 수 단정·EXPLAIN 단정·PR 템플릿을 설정과
코드로)의 사이클이며, 고정까지 가야 다음 느린 쿼리가 사용자 항의가 아니라
알람으로 도착한다.**
