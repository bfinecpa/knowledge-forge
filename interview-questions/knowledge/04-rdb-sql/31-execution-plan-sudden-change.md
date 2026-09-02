# 실행 계획의 갑작스러운 변경 — 플래너는 "통계를 입력받는 함수"다, 입력이 바뀌면 출력이 바뀐다

> 핵심 관전 포인트: **PostgreSQL 플래너는 쿼리를 "계산"하는 계산기가 아니라,
> 통계·확장 통계·파라미터 값·비용 상수를 입력으로 받아 후보 계획들의 비용을
> 비교하는 함수다. 코드도 쿼리도 안 바꿨는데 계획이 바뀌었다면 셋 중 하나다 —
> ① 입력이 바뀜(autoanalyze, 통계 노후, n_distinct 오추정, 분포 변화, **파라미터
> 값을 안 보기로 한 제네릭 계획 전환**), ② 후보가 바뀜(인덱스 추가·삭제·INVALID),
> ③ 함수가 바뀜(GUC 변경, 메이저 업그레이드 — **`pg_upgrade`는 통계를 안 옮긴다**).
> PG에는 **index dive도, 힌트 문법도, INVISIBLE 인덱스도 없다.** 그래서 통계가
> 유일한 진실이고 대응 순서가 강제로 고정된다 — **`ANALYZE` → statistics target
> 상향 → `CREATE STATISTICS` → 비용 파라미터 국소 교정 → 부분·복합 인덱스로
> 후보 단일화 → 최후에 `pg_hint_plan`.** 진단도 사다리다: 느려진 시각 특정 →
> `pg_stat_statements`의 "건당 읽은 블록" 비교 → `auto_explain` 로그의 계획 diff
> → `last_autoanalyze`·`pg_stats` 확인 → 분포 확인. **확장을 깔아야 계획을
> 고정할 수 있다는 사실 자체가 "그건 최후 수단"이라는 설계 메시지다.**

---

## 0. 질문 + 의도

**질문**: "잘 돌던 쿼리의 실행 계획이 어느 날 갑자기 바뀌어 느려졌습니다.
가능한 원인과 대응은?"

관련 질문:
"배포도 없었는데 어제부터 DB CPU만 올랐습니다. '변경이 없다'는 전제를 어떻게
검증하고, 원인 후보를 어떻게 좁혀가나요?" (같은 장 중급 문항 — [별도 문서](./22-db-cpu-spike-without-deployment.md).
그쪽은 "변경 없음"이라는 전제를 의심하며 **원인 전체를 넓게** 훑고, 이 문서는
그중 가장 흔한 한 갈래인 **"실행 계획이 바뀌었다"를 깊게** 판다.)

**출제 의도**: rationale의 표현 그대로 — "'코드도 쿼리도 안 바꿨는데 느려졌다'의
단골 원인(통계 정보 갱신, 데이터 분포 변화). **DB를 정적인 계산기가 아니라
상태에 따라 판단이 바뀌는 시스템으로 이해하는지** — 힌트로 고정하는 것의
트레이드오프까지 가면 상급이다." 즉 이 문항이 재는 것은 두 층이다. 아래층은
**모델**이다 — "같은 SQL을 넣으면 같은 계획이 나온다"는 계산기 모델을 버리고,
"플래너는 통계라는 입력으로 비용을 계산하는 함수라서 입력이 바뀌면 출력이
바뀐다"는 모델을 갖고 있는가. 이 모델이 있어야 원인 후보가 목록으로 인출되고
진단 순서가 논리적으로 나온다. 위층은 **판단**이다 — 계획을 고정하는 수단이
"문제 해결"이 아니라 "플래너의 판단 기능을 끄는 것"임을 알고 그 대가와 기한을
붙여 쓰는가. **PG에서는 이 위층이 특히 선명하다** — "고정한다"는 선택지 자체가
확장 설치라는 문턱 뒤에 있어, 대응이 자연히 "입력을 바로잡는다"에서 출발한다.

이 문서는 모의면접 **전** 학습용이고, 후보자의 횡단 약점 네 가지를 겨냥한다 —
① 인과를 "메커니즘 사슬"로 서술하기(§1·§2), ② 대응책의 대가를 한 호흡에 양면
으로(§4-2·§4-3), ③ 안전망을 코드·설정·잡으로 고정하기(§5), ④ "원인 후보 N종"과
"대응 사다리"를 목록으로 인출하기(§3·§4). `EXPLAIN` 노드 읽는 법과
측정→가설→검증→고정 사이클은
[실행 계획 읽기와 느린 쿼리 개선 프로세스](10-explain-and-slow-query-process.md)에,
"왜 플래너가 인덱스를 일부러 버리는가"의 비용 모델은
[인덱스를 걸었는데도 풀스캔](02-index-not-used-full-scan.md) §4에 있다. 이 문서는
그 위에 **"어제까지 옳던 판단이 오늘 왜 바뀌는가"** 만 얹는다.

---

## 1. 모델 — 플래너는 함수다: 계획 = f(후보 집합, 입력)

먼저 머릿속 모델을 교체한다. 계산기는 `2 + 3`을 넣으면 언제나 `5`다. 플래너는
그렇지 않다.

```text
                 ┌────────────────────────────────────────────────┐
  후보 집합 ───▶ │                                                │
  (쓸 수 있는    │   각 후보의 "예상 비용"을 계산해 가장 싼 것을 고른다   │ ───▶ 실행 계획
   인덱스·스캔   │                                                │
   방식·조인     │   비용 = g(입력)                                 │
   순서·병렬)    └────────────────────────────────────────────────┘
                                   ▲
       입력 ───────────────────────┘
       ① 영속 통계     : pg_class(reltuples, relpages, relallvisible)
                        pg_stats(n_distinct, most_common_vals/freqs, histogram_bounds,
                                 correlation, null_frac) — ANALYZE가 채운다
       ② 확장 통계     : CREATE STATISTICS (ndistinct / dependencies / mcv)
                        ← 만들지 않으면 플래너는 "컬럼들이 서로 독립"이라고 가정한다
       ③ 쿼리에 들어온 값 : 커스텀 계획이면 실제 값으로 선택도 계산,
                        제네릭 계획이면 값을 안 보고 "평균 선택도"로 계산
       ④ 비용 상수·스위치 : seq_page_cost 1.0, random_page_cost 4.0, cpu_tuple_cost,
                        effective_cache_size, work_mem, enable_*, jit, 병렬 설정
```

이 그림에서 **"출력(계획)이 바뀌었다"는 문장은 자동으로 세 가지 질문으로
쪼개진다.** 입력이 바뀌었나? 후보 집합이 바뀌었나? 함수 자체(비용 상수·DB
버전)가 바뀌었나? §3의 원인 10종은 전부 이 세 칸 중 하나에 들어간다. 목록을
외우는 게 아니라 이 세 칸에서 **꺼내는** 것이다.

> **내비게이션 비유**
> 같은 집에서 같은 회사로 가는데 어느 날 내비가 다른 길을 안내한다. 지도(쿼리)는
> 그대로다. 바뀐 것은 교통정보(통계)다. 교통정보가 갱신되면 안내가 바뀌는 건
> 정상이고, 대개 더 나은 길이다. 문제는 교통정보가 **낡았거나**(통계가 현실과
> 어긋남), **표본이 적어 엉뚱하게 잡혔거나**(샘플링 오차), **"목적지를 안 물어보고
> 평균적인 통근자 기준으로" 짜였을 때**(제네릭 계획)다. "내비가 미쳤다"가 아니라
> "내비가 무슨 정보를 보고 그렇게 판단했나"를 묻는 것이 진단의 시작이다.

### 1-1. 입력 ① 영속 통계 — 무엇이고, 어디에 쓰이나

`ANALYZE`(수동 또는 autovacuum의 autoanalyze)가 테이블을 무작위 샘플링해 통계를
`pg_statistic`에 저장하고, `pg_stats` 뷰가 사람이 읽을 형태로 노출한다. 크기
정보는 `pg_class`에 있다.

```sql
-- 크기 + "전부 가시"로 표시된 페이지 수(Index Only Scan 비용의 입력)
SELECT relname, reltuples::bigint, relpages, relallvisible
FROM pg_class WHERE relname = 'orders';

-- 언제 통계를 떴나 + 그 뒤로 몇 행이 바뀌었나(autoanalyze 임계 추적의 핵심)
SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze
FROM pg_stat_user_tables WHERE relname = 'orders';

-- 컬럼 단위 분포
SELECT attname, null_frac, n_distinct, correlation, most_common_vals, most_common_freqs
FROM pg_stats WHERE tablename = 'orders' AND attname IN ('user_id', 'status');
```

각 칸이 어디에 쓰이는지가 핵심이다.

- **`reltuples` / `relpages`** — "전부 읽으면 얼마"(Seq Scan 비용)의 밑변.
- **`n_distinct`** — 등호 조건의 선택도. MCV에 없는 값이면 플래너는
  `1 / n_distinct`(정확히는 MCV 빈도를 뺀 나머지를 균등 분배)로 "몇 행이
  걸릴까"를 추정한다. **§2 사고가 정확히 이 칸에서 난다.** 음수면 행 수 대비
  비율이라는 뜻이다(`-0.5` = 행 수의 절반이 서로 다른 값).
- **MCV(`most_common_vals`/`most_common_freqs`)** — 자주 나오는 값과 그 비율.
  `status = 'PAID'`처럼 편중된 값은 여기 실려 있어야 정확히 추정되고, 목록
  크기는 statistics target에 비례한다. **`histogram_bounds`**는 MCV에 없는
  값들의 범위 분포로, `created_at >= ?` 같은 범위 조건의 선택도를 준다.
- **`correlation`** — 컬럼 값 순서와 힙의 물리 순서의 상관계수(-1~1). 1에
  가까우면 인덱스 스캔의 힙 접근이 사실상 순차라 랜덤 I/O 가정이 완화된다.
- **`relallvisible`** — visibility map에서 "전부 가시"인 페이지 수.
  **Index Only Scan의 비용 추정에 직접 들어간다**(§3의 원인 ⑩).

> **MySQL 대조**: InnoDB는 인덱스별 `n_diff_pfx`(접두사별 서로 다른 값 수)를
> `mysql.innodb_index_stats`에 두고 `rows_per_key = n_rows / n_diff`를 만든다.
> PG는 인덱스가 아니라 **컬럼 단위 분포**(MCV + 히스토그램)를 갖고 선택도를
> 직접 계산한다는 점이 다르다. 그래서 PG는 "이 값은 흔하고 저 값은 희귀하다"를
> MCV로 구분할 수 있는 반면(MySQL 8의 히스토그램에 해당하는 기능이 기본 통계에
> 포함돼 있다), 인덱스 접두사 조합별 카디널리티는 따로 갖지 않는다 —
> 그 자리를 메우는 것이 `CREATE STATISTICS`다(§1-2).

### 1-2. 입력 ② 확장 통계 — "컬럼들이 서로 독립"이라는 기본 가정

기본 통계는 **컬럼 하나씩만** 안다. 그래서 조건이 여럿이면 플래너는
**선택도를 곱한다.** `city = '서울'`(20%) AND `zipcode = '06236'`(0.1%)이면
추정은 0.20 × 0.001 = 0.02%, 1,000만 건이면 2,000행. 그런데 06236은 애초에
서울에만 있으므로 실제는 0.1% = 10,000행 — 5배 과소 추정이다.

과소 추정은 Nested Loop·Index Scan 쪽으로 계획을 밀고, 실제 행이 그보다 훨씬
많으면 그 계획이 자릿수로 느려진다. 이 곱셈 가정을 깨는 도구가 확장 통계다.

```sql
CREATE STATISTICS stat_orders_city_zip (dependencies, ndistinct, mcv)
  ON city, zipcode FROM orders;
ANALYZE orders;                              -- 만들고 나서 ANALYZE를 해야 채워진다
```

**중요한 함정 — 확장 통계는 "만들지 않으면 없다".** 즉 상관관계가 강한 컬럼
조합은 기본적으로 **항상 오추정 상태**이고, 데이터가 자라 그 오차의 절대량이
임계를 넘는 날 계획이 뒤집힌다. "어제까지 괜찮았는데"의 흔한 정체다.

### 1-3. 입력 ③ 쿼리에 들어온 값 — 커스텀 계획 vs 제네릭 계획 (PG의 단골 사고)

**PostgreSQL은 리터럴이 박힌 SQL이면 매번 그 값으로 계획을 세운다.** 문제는
**준비문(prepared statement)** 이다.

```text
[클라이언트] pgjdbc는 같은 문장을 5회 실행하면 서버 준비문으로 전환한다
                              ↓
[서버]      처음 다섯 번은 "커스텀 계획"(들어온 실제 값으로 계획)을 세우고 비용 평균을 기록,
            그 뒤 "제네릭 계획"(값을 모른 채 평균 선택도로 계획)을 만들어 비용을 비교
                              ↓
            제네릭이 커스텀 평균보다 비싸지 않으면 → 이후로는 제네릭 계획을 재사용
            (계획 수립 비용을 아끼려는 정상 최적화다)
```

이 전환이 **편중된 컬럼**에서 사고가 된다. `status`가 PAID 97% / PENDING 2% /
FAILED 1%일 때, 관리자 화면은 `status = 'FAILED'`만 조회한다.

- **커스텀 계획**: `'FAILED'`는 MCV에서 1%로 확인되므로 인덱스 스캔. 8ms.
- **제네릭 계획**: 값이 `$1`이라 무엇이 올지 모른다 → 플래너는 컬럼의 **평균
  선택도**를 쓴다 → "대략 3분의 1이 걸린다"고 가정 → Seq Scan. 3초.

**증상의 지문이 독특하다 — 애플리케이션을 재시작하면 잠깐 빨라졌다가 다시
느려진다.** 커넥션이 새로 나면 준비문 캐시가 비어 다시 커스텀 계획부터
시작하기 때문이다. HikariCP `maxLifetime`으로 커넥션이 주기적으로 교체되는
환경이면 **몇 십 분 주기로 빨라졌다 느려졌다** 하는 모양으로도 온다.

```sql
-- ⑴ 파라미터를 채우지 않고 제네릭 계획을 그대로 본다 (PG 16+)
EXPLAIN (GENERIC_PLAN)
SELECT * FROM orders WHERE status = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 50;

-- ⑵ 손으로 재현한다 — 여섯 번째 EXECUTE에서 계획이 바뀌는 것을 눈으로 본다
PREPARE p(text) AS SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 50;
EXPLAIN EXECUTE p('FAILED');   -- 1~5회는 커스텀 계획, 6회째에 제네릭인지 확인

-- ⑶ 통제: 이 세션/롤/DB에서는 항상 값으로 계획하게 한다
SET plan_cache_mode = force_custom_plan;
ALTER ROLE app_user SET plan_cache_mode = force_custom_plan;
```

> **MySQL 대조**: MySQL은 실행할 때마다 실제 값으로 다시 최적화하므로 이
> 제네릭 계획 함정이 **없다.** 대신 "같은 SQL이 값에 따라 다른 계획을 갖는 것이
> 정상"이라는 다른 얼굴로 온다 — 주문 8건인 사용자와 40만 건인 대형 가맹점은
> 같은 SQL, 다른 최적 계획이다. 즉 스큐(편중)라는 뿌리는 같고 증상만 다르다:
> MySQL은 "특정 값에서만 느리다", PG는 "여섯 번째 실행부터 모든 값에서 느리다".

### 1-4. 입력 ④ 비용 상수와 스위치 — 함수의 계수

플래너의 산술에 들어가는 계수들은 GUC(설정 파라미터)다.

- `seq_page_cost`(1.0) / `random_page_cost`(4.0) — **랜덤 대 순차의 비율**이
  인덱스 스캔과 Seq Scan의 손익분기를 정한다. 회전 디스크 시절의 4.0을 SSD에서
  그대로 두면 플래너가 인덱스를 과소평가한다(1.1 근처로 낮추는 것이 통례).
- `effective_cache_size` — "이 정도는 캐시에 있겠지"의 짐작값. 크게 잡을수록
  반복 인덱스 접근을 싸게 본다. `cpu_tuple_cost` 계열은 행·연산자당 CPU 비용.
- `work_mem`(+ `hash_mem_multiplier`) — 해시·정렬이 메모리에 들어가는지. 이 값이
  바뀌면 Hash Join ↔ Merge Join, quicksort ↔ external merge가 갈린다.
- `enable_seqscan` 류 스위치 — **운영 설정이 아니라 가설 검증 도구다**(§2-5).
- `jit`와 그 비용 임계 — 짧고 자주 도는 쿼리에 JIT가 붙으면 컴파일 시간이 실행
  시간을 압도할 수 있다. 병렬 설정(`max_parallel_workers_per_gather` 등)은
  테이블이 임계 크기를 넘으면 Parallel Seq Scan을 후보에 **추가**한다.

**(가산점 포인트) GUC는 계층적이다.** 전역(postgresql.conf) → DB
(`ALTER DATABASE`) → 롤(`ALTER ROLE`) → 세션(`SET`) → 트랜잭션(`SET LOCAL`)
순으로 좁혀 덮어쓸 수 있다 — **"전역을 바꾸지 않고 이 앱 롤에서만" 비용
파라미터를 교정**할 수 있고, §4-2 카드 4가 이 성질 위에 서 있다.

**(가산점 포인트) PG 플래너는 "지금 캐시에 뭐가 올라와 있는지"를 보지 않는다.**
`effective_cache_size`는 정적인 짐작값일 뿐이다. 그래서 **"재시작 직후 계획이
달라졌다"는 PG에서는 성립하지 않는다** — 재시작 후 느린 것은 같은 계획이 캐시
미스로 디스크를 읽는 것이고 `BUFFERS`의 `shared read`가 그것을 증명한다.

> **MySQL 대조**: MySQL 8의 비용 모델은 "이 인덱스가 버퍼 풀에 얼마나 올라와
> 있나" 추정치를 참고하므로 재시작·failover 직후와 예열 뒤의 **계획 자체가**
> 다를 수 있다. PG에는 그 입력이 없어 위의 구분이 더 깔끔하게 떨어진다.

### 1-5. PG에는 index dive가 없다 — 이 문서 전체의 전제

MySQL은 `WHERE user_id = 42`처럼 **상수 조건**이 걸리면 통계를 믿지 않고 그
인덱스의 해당 범위에 실제로 들어가 대략 몇 행인지 세어본다(index dive) — 그래서
단일 등호·범위 조건은 통계가 낡아도 비교적 정확하다. **PostgreSQL은 그러지
않는다.** 상수 조건이든 파라미터든 선택도는 **오직 `pg_stats`의 MCV·히스토그램·
n_distinct에서** 계산되고, 실측하러 인덱스에 들어가는 단계가 없다. 이 한 문장
에서 PG 운영의 결론 세 개가 곧바로 나온다.

1. **통계가 낡으면 가장 단순한 등호 조건도 틀린다.** 대량 적재 직후가 특히
   위험하다 — MySQL이었다면 dive가 새 데이터를 즉시 보지만, PG는 `ANALYZE`가
   돌기 전까지 옛 세계를 믿는다.
2. **그래서 `ANALYZE`가 1순위 대응이다.** 어떤 원인이든 통계 갱신을 먼저 해서
   "입력이 낡은 건 아니다"를 배제하고 시작한다.
3. **분포가 급변해도 통계가 안 돌면 계획은 안 바뀐다.** 분포 변화가 계획을
   바꾸려면 **반드시 그 사이에 ANALYZE가 있었다** — 진단에서
   `last_autoanalyze` 시각이 결정적 단서가 되는 이유다.

### 1-6. 이 모델이 주는 첫 번째 결론

> **"실행 계획이 바뀌었다"는 결과이지 원인이 아니다.** 진단은 "어느 입력이,
> 언제, 왜 바뀌었나"를 찾는 일이고, 대응은 "그 입력을 바로잡을 것인가(ANALYZE·
> statistics target·확장 통계), 값을 다시 보게 할 것인가(`plan_cache_mode`),
> 후보를 줄여 흔들릴 여지를 없앨 것인가(인덱스 설계), 함수를 우회할 것인가
> (`pg_hint_plan`)"의 선택이다. 이 문장을 첫 답변으로 말하면 "정적인 계산기가
> 아니라 상태에 따라 판단이 바뀌는 시스템"이라는 이해가 첫머리에서 드러난다.

---

## 2. 사슬 — 사고 두 개를 숫자로: 통계가 무너진 밤, 여섯 번째 실행

후보자의 최대 약점은 "통계가 바뀌어서 느려졌다"에서 멈추는 것이다. 그 사이의
칸을 채운다. 아래 숫자는 메커니즘을 보이기 위한 예시값이다. **상황:** `orders`
1,000만 건, 인덱스는 `orders_pkey(id)`와 `idx_orders_user(user_id)`, 사용자
100만 명에 1인당 평균 주문 10건. 주문 목록 API의 쿼리:

```sql
SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 20;
```

플래너 앞에 놓인 **후보는 둘**이다.

```text
계획 A: idx_orders_user로 이 사용자의 TID를 모아 힙을 읽고 → id로 Sort → 20건
        비용 ∝ 이 사용자의 예상 행 수 (인덱스 + 힙 랜덤 접근 N번 + N건 정렬)

계획 B: orders_pkey를 뒤에서부터 훑으며(id DESC 순서 그대로) user_id로 거른다
        → 20건 모이면 Limit이 중단시킨다
        비용 ∝ 20 × (전체 행 수 / 이 사용자의 "예상" 행 수)  ← 촘촘할수록 싸다
        여기서 "예상 행 수"의 입력이 pg_stats.n_distinct(user_id)다 (§1-1)
```

**평소(베이스라인).** `n_distinct(user_id)` 추정 100만 → 선택도 1/100만 →
예상 행 수 **10**. 계획 A는 힙 랜덤 접근 10번, 계획 B는 20 × (1,000만 / 10) =
2,000만 행, 즉 테이블 전체. A가 압도적으로 싸다. p95 20ms.

```text
 Limit  (cost=39.24..39.29 rows=20 width=124) (actual time=0.412..0.415 rows=8 loops=1)
   ->  Sort  (cost=39.24..39.27 rows=10 width=124) (actual rows=8 loops=1)
         Sort Key: id DESC
         Sort Method: quicksort  Memory: 26kB
         ->  Index Scan using idx_orders_user on orders o
               (cost=0.43..39.03 rows=10 width=124) (actual rows=8 loops=1)
               Index Cond: (user_id = 42)
               Buffers: shared hit=11
 Execution Time: 0.44 ms
```

### 2-1. 사고 ① — 새벽 배치 한 번이 n_distinct를 무너뜨리는 여섯 칸

1. 새벽 2시, 대형 가맹점 20곳의 이관 배치가 `orders`에 **200만 건을 INSERT**했다.
   `n_mod_since_analyze`가 200만이 되어 autoanalyze 임계
   (`autovacuum_analyze_threshold` 50 + `autovacuum_analyze_scale_factor` 0.1 ×
   1,000만 ≈ 100만)를 넘겼다.
2. autovacuum 워커가 **ANALYZE를 실행**했다. `last_autoanalyze` = 02:14. 누가
   시킨 것도, 배치가 부른 것도 아니다 — 임계를 넘긴 순간 다음 순회에서 돌았다.
3. ANALYZE는 테이블 전체가 아니라 **`300 × default_statistics_target` 행**을
   무작위 샘플링한다(기본 target 100 → 3만 행). 그런데 방금 들어온 200만 건은
   가맹점 20곳의 것이라, 3만 행 샘플의 상당 부분이 **그 20개 `user_id` 값**에
   쏠렸다. PG의 `n_distinct` 추정은 샘플에서 본 서로 다른 값의 개수를 전체
   행 수로 외삽하는 방식이라 값이 뭉쳐 있으면 **심하게 과소 추정**된다 —
   `n_distinct`가 100만에서 **1,000으로 붕괴**했다(예시값. 편차 폭은 3만 행이
   어디를 맞히느냐에 달렸다 — 그래서 ANALYZE할 때마다 다른 값이 나온다).
4. 플래너 입력이 바뀌었다: 선택도 1/1,000 → 예상 행 수 = 1,200만 / 1,000 =
   **12,000**. "사용자 한 명당 주문 12,000건"으로 믿게 됐다.
5. 비용이 역전됐다. 계획 A: 인덱스 12,000 엔트리 + **힙 랜덤 접근 12,000회**
   (`random_page_cost` 4.0이 곱해진다) + 12,000건 정렬. 계획 B: 20 ×
   (1,200만 / 12,000) = **20,000행만 PK 역순으로 훑으면 20건이 모인다** —
   그것도 인덱스 순서라 `correlation`이 높은 순차 접근으로 계산된다.
6. **계획이 B로 전환됐다.** 그리고 현실은 통계와 달랐다 — 일반 사용자의
   주문은 8건이다.

```text
 Limit  (cost=0.43..812.60 rows=20 width=124) (actual time=3947.1..3947.1 rows=8 loops=1)
   ->  Index Scan Backward using orders_pkey on orders o
         (cost=0.43..487561.02 rows=12000 width=124) (actual rows=8 loops=1)
         Filter: (user_id = 42)
         Rows Removed by Filter: 11999992      ← 8건을 찾으려고 1,200만 행을 훑었다
         Buffers: shared hit=98213 read=163402
 Execution Time: 3947.24 ms
```

p95 20ms → 4초, DB CPU 급등. 배포는 없었다. **실제로 바뀐 것은 데이터 200만 건,
ANALYZE 1회, 계획 1회**다. **계획 변경의 지문 두 개가 여기 그대로 있다** —
⑴ `rows=12000`(추정)과 `rows=8`(실제)의 자릿수 차이(입력이 틀렸다는 증거),
⑵ `Rows Removed by Filter: 11999992`(반환 8건 대비 훑은 1,200만 행). 이 "훑은
양 대비 반환량"의 붕괴가 §4-1 2단계에서 `pg_stat_statements`의 **건당 읽은
블록 수**로 나타난다.

### 2-2. 사고 ② — 여섯 번째 실행부터 느려진다: 제네릭 계획 전환

같은 시스템의 관리자 화면. 쿼리는 다르다.

```sql
SELECT * FROM orders
WHERE status = $1 AND created_at >= $2
ORDER BY created_at DESC LIMIT 50;
-- 인덱스: idx_orders_status_created (status, created_at)
-- 분포: PAID 97% / PENDING 2% / FAILED 1%
-- 이 화면은 항상 status = 'FAILED'만 조회한다
```

1. 애플리케이션이 이 쿼리를 같은 커넥션에서 다섯 번 실행했다. **pgjdbc가 서버
   준비문으로 전환**한다(같은 문장 5회가 기본 임계).
2. 서버는 처음 다섯 번을 **커스텀 계획**으로 세운다. `$1 = 'FAILED'`는 MCV
   목록에 1%로 실려 있으므로 인덱스 스캔. 8ms.

   ```text
    Limit  (cost=0.43..84.21 rows=50 width=124)
      ->  Index Scan using idx_orders_status_created on orders
            Index Cond: ((status = 'FAILED'::text) AND (created_at >= '2026-08-01'))
   ```

3. 커스텀 계획 다섯 번의 평균 비용이 기록된 뒤, 서버가 **제네릭 계획**을 한 번
   만들어 비교한다. 제네릭 계획은 `$1`이 무엇인지 모르므로 `status` 컬럼의
   **평균 선택도**를 쓴다 — "대략 3분의 1이 걸린다"고 가정한다.
4. "1,200만 행의 3분의 1을 인덱스로 뽑아 힙을 랜덤 접근하느니 순차로 읽는 게
   싸다"는 계산이 나오고, 제네릭이 커스텀 평균보다 비싸지 않다고 판정되면
   **이후 실행은 전부 제네릭 계획**이다.

   ```text
    Limit  (cost=21430.11..21430.24 rows=50 width=124)
      ->  Sort   (Sort Key: created_at DESC)
            ->  Seq Scan on orders
                  Filter: ((status = $1) AND (created_at >= $2))
   ```

5. 여섯 번째 실행부터 3초. **화면은 항상 FAILED(1%)만 보는데, 플래너는 33%를
   가정한 계획으로 돌고 있다.**
6. 담당자가 앱을 재시작한다 → 준비문 캐시가 비어 다시 커스텀 계획 →
   **빨라진다** → 몇 분 뒤 다시 느려진다. "재시작하면 낫는다"가 진단을 오히려
   방해한다(사람들은 메모리·커넥션 누수를 의심한다).

**결정적 지문 세 개.** ⑴ 재시작·커넥션 교체 뒤 회복했다 재발한다. ⑵ 리터럴을
박아 psql에서 직접 실행하면 **빠르다** — "DB에서 돌리면 빠른데 앱에서만 느리다"는
전형적 보고가 이것이다. ⑶ 편중 컬럼(`status`, `type`, 테넌트 ID)이 파라미터
자리에 있다.

### 2-3. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

```text
❌ "통계가 갱신돼서 플래너가 다른 인덱스를 타게 됐고, 그래서 느려졌습니다."
   → 왜 갱신됐는지, 갱신되면 무엇이 바뀌는지, 그게 왜 다른 계획으로 이어지는지, 왜 그게 느린지가 전부 비어 있다.

✅ (사고 ①) "대량 적재로 n_mod_since_analyze가 임계(기본 10%)를 넘어 autoanalyze가 돌았고
    → 3만 행 샘플이 20개 가맹점 값에 편중돼 n_distinct(user_id)가 100만에서 1,000으로 떨어졌고
    → 플래너는 '사용자 한 명당 주문 12,000건'이라고 믿게 됐고
    → 그러면 'PK를 역순으로 2만 행만 훑어도 LIMIT 20이 채워진다'는 계획이 더 싸게 계산돼 전환됐고
    → 실제로는 주문이 8건뿐이라 Rows Removed by Filter가 1,200만이 됐습니다."

✅ (사고 ②) "pgjdbc가 같은 문장 5회 뒤 서버 준비문으로 전환했고
    → 서버가 커스텀 계획 다섯 번의 평균 비용과 제네릭 계획 비용을 비교해 제네릭으로 고정했고
    → 제네릭 계획은 $1을 모르므로 status의 평균 선택도(약 1/3)를 가정해 Seq Scan을 골랐고
    → 실제 조회 값은 1%짜리 FAILED라 인덱스가 정답이었습니다. 여섯 번째 실행부터
      느려지고, 앱을 재시작하면 준비문 캐시가 비어 잠시 회복됩니다."
```

### 2-4. 이 두 사례가 가르치는 네 가지

첫째, **ANALYZE 자체는 정상 동작이다.** 문제는 "재계산"이 아니라 "재계산할
때마다 샘플이 다른 답을 낸다"는 **샘플링 오차**다. 그래서 대응이 "autoanalyze를
끄자"가 아니라 "샘플을 늘리거나(statistics target) 후보를 줄이자"로 간다(§4-3).

둘째, **플래너는 "평균 사용자"를 가정한다.** 평균 12,000건이라는 가정은 대형
가맹점에게는 맞고 일반 사용자에게는 틀린다. 편중된 컬럼에서는 "플래너가 옳은
값"과 "틀린 값"이 동시에 존재하고, 제네릭 계획은 **그 평균 하나로 모든 값을
처리하겠다는 결정**이다.

셋째, **후보가 둘이었기 때문에 뒤집힐 수 있었다.** `(user_id, id)` 복합 인덱스가
있었다면 후보 하나가 WHERE와 ORDER BY를 동시에 만족해 계획 B가 이길 수 있는
통계값이 존재하지 않는다. 사고 ②도 **부분 인덱스**가 있으면 제네릭 계획조차 그
인덱스를 고를 만큼 비용 차이가 벌어진다. **흔들릴 여지를 없애는 것이 근본
대응**이다(§4-3의 1·2번).

넷째, **PG에는 "지금 데이터를 실측하는 안전장치"가 없다**(§1-5). 대신 통계를
정밀하게 만드는 손잡이(statistics target, 확장 통계, n_distinct 고정)가 열려
있다 — **그 손잡이를 쓰는 것이 PG 운영자의 일이다.**

### 2-5. 두 후보의 비용을 나란히 보는 법 (가산점 포인트)

`EXPLAIN`은 "고른 것"만 보여준다. "무엇과 비교해서 골랐는지"를 PG에서 보는
정석은 **후보를 하나씩 막아 각 계획의 총비용을 뽑아 비교하는 것**이다.

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42 ORDER BY id DESC LIMIT 20;
--  Limit  (cost=0.43..812.60 rows=20 ...)   ← 지금 고른 계획 B의 총비용 812.60

BEGIN;                                 -- SET LOCAL이라 이 트랜잭션에서만
SET LOCAL enable_indexscan = off;      -- Index Scan Backward를 막아 A를 보게 한다
SET LOCAL enable_indexonlyscan = off;
EXPLAIN SELECT * FROM orders WHERE user_id = 42 ORDER BY id DESC LIMIT 20;
--  Limit -> Sort -> Bitmap Heap Scan ...  (cost=... .. 1893.44)   ← A의 비용
ROLLBACK;
```

"B가 812, A가 1,893으로 두 배 남짓"이면 이 쿼리는 **다음 ANALYZE에서 또 뒤집힐
후보**다. 반대로 실제 실행 시간은 A가 압도적으로 빠른데 비용은 B가 싸다면
**비용 모델의 입력이 틀렸다는 확진**이다. 베이스라인에 이 비용도 남겨두면(§5-1)
"왜 뒤집혔나"가 아니라 "뒤집힐 뻔했다"를 미리 안다. 주의: `enable_*`를 끄는 것은
비용에 큰 상수를 더하는 것이지 금지가 아니고, **가설 검증 도구이지 운영 설정이
아니다.**

> **MySQL 대조**: MySQL은 `optimizer_trace`가 후보별 `cost`·`chosen`을 JSON으로
> 한 번에 준다. PG에는 내장 트레이스가 없어 위처럼 **후보를 하나씩 막아 재는
> 방식**이 표준이다. 대신 PG는 노드별 실제 읽은 블록까지 주므로 "왜 골랐나"는
> 약하고 "고른 게 실제로 어땠나"는 강하다.

---

## 3. 원인 후보 10종 — 세 칸에서 꺼내는 암기 목록

§1의 세 질문(입력이 바뀌었나 / 후보가 바뀌었나 / 함수가 바뀌었나)에 걸어서
외운다. 표는 인출용이고 설명은 아래 본문에 있다.

| # | 원인 | 바뀐 칸 | 전형적 트리거 | 첫 확인 지점 |
|---|---|---|---|---|
| ① | autoanalyze로 통계 갱신 | 입력(통계) | 변경 행이 임계(기본 10%) 초과 | `last_autoanalyze` |
| ② | 통계가 낡음 | 입력(통계) | 대량 적재 직후, 임계 미달인 큰 테이블 | `n_mod_since_analyze` |
| ③ | `n_distinct` 오추정 | 입력(통계) | 값이 뭉쳐 저장되는 컬럼, 배치 이관분 | `pg_stats.n_distinct` vs `COUNT(DISTINCT)` |
| ④ | **제네릭 계획 전환** | 입력(값을 안 봄) | 준비문 6번째 실행부터, 재시작하면 회복 | `EXPLAIN (GENERIC_PLAN)` |
| ⑤ | 데이터 분포 변화 | 입력(통계) | FAILED 급증, MCV 목록 진입/이탈 | `most_common_vals`, 값별 건수 추이 |
| ⑥ | 컬럼 상관관계 미반영 | 입력(통계 모델) | AND 조건 여럿 → 선택도 곱셈 붕괴 | 추정 vs 실제 rows, `pg_statistic_ext` |
| ⑦ | 인덱스 추가·삭제·INVALID | 후보 집합 | 남이 만든 유사 인덱스, CIC 실패 잔존 | `pg_index.indisvalid`, `idx_scan` |
| ⑧ | GUC 변경 / 메이저 업그레이드 | 함수 | `work_mem`·`random_page_cost`·`jit`, **`pg_upgrade` 후 ANALYZE 누락** | `pg_settings` diff, `version()` |
| ⑨ | 테이블 크기 임계 통과 | 입력(크기) | 자연 증가로 Seq Scan·병렬 선호 | `pg_class.relpages` 추이 |
| ⑩ | visibility map 노후 (가산점) | 입력(가시성) | 롱 트랜잭션 → Index Only Scan 퇴화 | `relallvisible`, `Heap Fetches` |

### 3-1. ①② autoanalyze가 돌았거나, 반대로 안 돌았거나

변경 행 수(`n_mod_since_analyze`)가 `autovacuum_analyze_threshold`(기본 50) +
`autovacuum_analyze_scale_factor`(기본 0.1) × 추정 행 수를 넘으면 autovacuum
워커가 다음 순회에서 ANALYZE를 돌린다. 배치가 끝난 시각과 일치하지도 않고 기본
설정으로는 로그에도 안 남아서 **"배포도 배치도 끝난 지 한참인데 갑자기"**라는
인상을 준다(①). 반대편도 같은 임계에서 나온다 — 임계가 **비율**이라 1억 건
테이블은 1,000만 행이 바뀌어야 돈다. 그 사이 적재된 새 데이터는 **통계에 아예
존재하지 않고**, 플래너는 `created_at >= '어제'`를 히스토그램 밖 값으로 보고
"거의 안 걸린다"고 추정한다 → 과도한 Nested Loop·인덱스 스캔(②). **PG에는
index dive가 없으므로**(§1-5) 이 오차를 실행 시점에 바로잡을 장치가 없다.

```sql
SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze,
       (SELECT reltuples::bigint FROM pg_class c WHERE c.oid = relid) AS reltuples
FROM pg_stat_user_tables WHERE relname = 'orders';
-- last_autoanalyze가 느려진 시각 직전 → ① / n_mod_since_analyze가 크고 last_analyze가 오래됨 → ②
```

**(가산점 포인트)** `log_autovacuum_min_duration`을 켜 두면 autovacuum·
autoanalyze 실행이 서버 로그에 남는다 — 사후에 "그 시각에 정말 돌았나"를 확인할
유일한 기록이라 운영 기본값으로 켜 두는 게 낫다.

### 3-2. ③ n_distinct 오추정 — "돌았다"가 아니라 "다르게 나왔다"가 문제

3만 행 샘플은 1,000만 건 테이블의 0.3%다. 값이 **뭉쳐서 저장되는 컬럼**일수록
어느 행을 맞히느냐에 따라 `n_distinct` 추정이 크게 흔들린다. 증상은 **"아무것도
안 했는데 며칠에 한 번씩 계획이 왔다 갔다 한다"** 이다.

```sql
SELECT attname, n_distinct, null_frac, correlation
FROM pg_stats WHERE tablename = 'orders' AND attname = 'user_id';
--  n_distinct가 양수면 그 값 자체, 음수면 행 수 대비 비율(-0.1 = 행 수의 10%)
SELECT COUNT(DISTINCT user_id) FROM orders;   -- 레플리카에서. 자릿수가 다르면 ③ 확정
```

**PG의 손잡이 둘**: `ALTER COLUMN user_id SET STATISTICS 1000`(이 컬럼만 샘플·
MCV 크기를 키운다), 그리고 값 개수가 안정적이라면 `SET (n_distinct = -0.1)`로
**추정치를 아예 고정**(§4-3에서 대가와 함께).

### 3-3. ④ 제네릭 계획 전환 — PG에서 가장 자주 만나는 "갑자기"

§2-2의 사슬 그대로이고, 이 원인만 진단 진입점이 다르다 — **통계는 멀쩡하고
`last_autoanalyze`도 조용한데 계획만 바뀐다.** 판별은 §2-2의 지문 세 개, 확진은
`EXPLAIN (GENERIC_PLAN)`(PG 16+)이나 `PREPARE` + 여섯 번의 `EXPLAIN EXECUTE`.
**(가산점 포인트)** `track_planning = on`을 켜면 `plans`가 수집된다(PG 13+) —
`calls`는 느는데 `plans`가 거의 안 늘면 계획을 재사용 중이라는 간접 신호다.

### 3-4. ⑤ 데이터 분포 변화 — 플래너가 "옳게" 바꾼 경우일 수 있다

`status = 'FAILED'`가 1%일 때는 인덱스가 정답이고 40%일 때는 Seq Scan이 정답이다.
외부 결제사 장애로 실패 주문이 쏟아지고 그 뒤 ANALYZE가 돌면 `most_common_freqs`
가 갱신되고 플래너는 Seq Scan으로 바꾼다. 이때 계획 전환은 **오판이 아니라
정확한 판단**이고, 느려진 것은 **"실패 주문 전부를 읽어야 하는 쿼리"가 된 요구
자체** 때문이다. 구분법은 추정 `rows`와 `actual rows`의 거리 — 가까우면 플래너가
옳고, 대응은 쿼리·요구의 변경(기간 조건, 아카이빙, **부분 인덱스**, 파티셔닝)이다.
손익분기 자체는 [인덱스를 걸었는데도 풀스캔](02-index-not-used-full-scan.md)
§4-3에 있다.

PG 특유의 미묘함 하나: **MCV 목록은 크기가 유한하다.** 어떤 값이 MCV에
들어오거나 밀려 빠지는 순간, 그 값의 선택도 계산이 "정확한 빈도"에서 "나머지
균등 분배"로 **불연속하게** 바뀐다. "어제까지 잘 되던 특정 값만 갑자기"의 정체가
이것인 경우가 있고, 처방은 statistics target 상향(= MCV 목록 확대)이다.

### 3-5. ⑥ 컬럼 상관관계 — 확장 통계를 안 만들었으면 항상 틀리고 있다

§1-2 그대로 — 조건이 둘 이상 AND로 걸리는 쿼리에서 추정 rows가 실제보다
자릿수로 작으면 이 칸을 의심한다. `CREATE STATISTICS`는 만든 뒤 `ANALYZE`를 해야
채워지고, **테이블 하나 안의 컬럼들에만** 적용된다(조인 양쪽의 상관은 못 잡는다).

### 3-6. ⑦ 인덱스 추가·삭제·INVALID — 후보 집합이 바뀜

옆 팀이 리포트 쿼리를 위해 `idx_orders_created_status`를 추가했더니 내 쿼리의
플래너가 그쪽을 고르기 시작하는 경우. 인덱스는 **추가만으로 다른 쿼리의 계획을
바꿀 수 있다.** 반대로 "안 쓰는 것 같아서" 지운 인덱스가 특정 값에서만 쓰이던
것이라 그 값이 들어올 때 무너지기도 한다. **PG 고유의 함정 하나**:
`CREATE INDEX CONCURRENTLY`가 실패하면 **`INVALID` 상태의 인덱스가 남는다** —
쓰기 비용은 다 내면서 플래너의 후보에는 안 들어간다. "인덱스가 분명히 있는데
안 탄다"의 단골이다.

```sql
SELECT i.indexrelid::regclass AS index_name, pg_get_indexdef(i.indexrelid) AS def,
       i.indisvalid, s.idx_scan
FROM pg_index i JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
WHERE i.indrelid = 'orders'::regclass ORDER BY s.idx_scan;
-- indisvalid = false → CIC 실패 잔존(DROP 후 재시도) / idx_scan = 0 → 미사용 후보
```

**인덱스 bloat**도 이 칸이다. 인덱스가 부풀면 `relpages`가 커져 인덱스 스캔
비용이 올라가고 어느 지점에서 Seq Scan에 진다 — 처방은 `REINDEX CONCURRENTLY`.

### 3-7. ⑧ GUC 변경과 메이저 업그레이드 — 함수가 바뀜

`work_mem`, `random_page_cost`, `effective_cache_size`, `jit`, 병렬 설정,
`default_statistics_target`. 누군가 "다른 문제를 고치려고" 만진 파라미터의 영향이
내 쿼리에 왔다. `pg_settings`의 정기 스냅샷 diff로 잡는다 —
`WHERE source NOT IN ('default','override')`가 "기본값에서 벗어난 것들"을 준다.

**메이저 업그레이드는 두 겹으로 위험하다.** ⑴ 플래너 자체가 바뀐다 — 새 노드
(`Memoize`, `Incremental Sort`, skip scan 등)가 후보에 추가되고 비용 계산이
개선된다. 대개는 좋아지지만 개별 쿼리는 나빠질 수 있다. ⑵ **더 흔하고 더
치명적인 쪽: `pg_upgrade`는 옵티마이저 통계를 새 클러스터로 옮기지 않는다.**
업그레이드 직후의 DB는 **통계가 텅 빈 상태**라 플래너가 기본 추정치로 계획을
세운다 — 모든 쿼리의 계획이 동시에 이상해지고, 그 정체는 "새 버전이 나쁘다"가
아니라 "통계가 없다"이다. 그래서 절차의 마지막 줄은 반드시 통계 재수집이고,
서비스를 빨리 열어야 하면 정밀도를 단계적으로 올리는 방식을 쓴다.

```bash
vacuumdb --all --analyze-in-stages   # 낮은 정밀도로 전체를 빠르게 훑고 점점 정밀하게 반복
# (--analyze 로 한 번에 돌리면 정확하지만 그동안 통계가 계속 비어 있다)
```

### 3-8. ⑨⑩ 아무 사건 없이 넘어가는 두 임계 (⑩은 가산점)

**⑨ 테이블 크기.** 테이블이 커지면 어느 지점에서 인덱스 스캔의 힙 랜덤 접근
비용이 Seq Scan을 넘어서고, 또 어느 크기를 넘으면 **Parallel Seq Scan이 후보에
추가**된다. 이 전환은 배치도 배포도 없이 **데이터가 자란 것만으로** 일어난다 —
`pg_class.relpages` 추이를 베이스라인에 남겨 두면 "그날 임계를 넘었다"가 보인다.

**⑩ visibility map 노후.** Index Only Scan의 비용 추정에는
`relallvisible / relpages` 비율이 들어간다. 롱 트랜잭션이 `backend_xmin`으로
VACUUM을 막거나 autovacuum이 밀리면 "전부 가시" 페이지 비율이 떨어지고 → 예상
힙 접근이 늘어 비용이 올라가고 → **다른 계획으로 전환**된다. 전환되지 않더라도
`Heap Fetches`가 폭증해 같은 계획이 느려진다. 이 갈래는
[롱 트랜잭션의 해악](16-long-transaction-harm-and-shortening.md)과
[커버링 인덱스](09-covering-index.md)로 이어진다.

### 3-9. 계획은 안 바뀌었는데 그렇게 보이는 것들 — 이 문서 밖

락 대기(`wait_event_type = 'Lock'`), 캐시 냉각(같은 계획인데 `shared read` 급증),
bloat로 같은 계획이 더 많은 블록을 읽는 것, `work_mem` 초과 스필
(`external merge Disk`, `Batches > 1`), N+1 호출 수 증가. 이것들은 **같은 계획,
다른 실행 비용**이다. 진단 2단계(§4-1)에서 **계획 텍스트가 동일**하다면 계획
변경이 아니므로 이 문서를 덮고
["변경 없음 검증" 문서](./22-db-cpu-spike-without-deployment.md)로 돌아간다.

---

## 4. 대응 사다리 — 진단 → 즉시 완화 → 근본 대응

순서가 있는 이유: 진단 없이 완화하면 무엇을 되돌려야 할지 모르고, 완화 없이
근본 대응만 하면 장애 시간이 길어지고, 근본 대응 없이 완화만 하면 다음 ANALYZE에
또 뒤집힌다. **PostgreSQL에서는 이 순서가 강제된다** — 힌트 문법이 없어 "일단
고정하고 나중에 본다"는 지름길이 막혀 있기 때문이다.

```text
① ANALYZE                     — 입력이 낡은 건 아닌지 먼저 배제 (가장 싸고 되돌릴 것도 없다)
② statistics target 상향       — 입력의 "정밀도"를 올린다 (컬럼 단위)
③ CREATE STATISTICS           — 입력의 "모델"을 고친다 (컬럼 간 독립 가정을 깬다)
④ 비용 파라미터 국소 교정      — 함수의 계수를 하드웨어 현실에 맞춘다 (롤/세션 범위로)
⑤ 부분 인덱스 · 복합 인덱스    — 후보를 하나로 만들어 흔들릴 여지 자체를 없앤다
⑥ pg_hint_plan               — 응급. 확장 설치가 전제라는 사실 자체가 "최후"라는 뜻이다
   (원인 ④ 제네릭 계획이면 ①보다 먼저 plan_cache_mode = force_custom_plan)
```

### 4-1. 진단 5단계 — 순서 고정

**1단계. 느려진 시각을 특정한다.** APM에서 p95가 꺾인 분 단위 시각,
`log_min_duration_statement` 로그에 그 쿼리가 **처음 등장한** 시각,
`pg_stat_statements` 스냅샷의 구간 diff. 그 시각 위에 배포·배치·
`last_autoanalyze`·GUC 변경·인덱스 DDL·**애플리케이션 재시작**의 타임라인을
겹친다. "갑자기"는 대개 이 겹치기에서 이미 반쯤 풀린다.

**2단계. "계획이 바뀐 게 맞는지"부터 확정한다.** 계획 변경의 지문은 **건당 읽은
블록은 뛰는데 건당 반환 행은 그대로**라는 것이다 — 같은 결과를 내기 위해 훨씬
많이 읽고 있다는 뜻이다.

```sql
-- pg_stat_statements는 누적이므로 "구간"을 보려면 스냅샷 diff가 필요하다(§5-2)
SELECT left(query, 80) AS q, calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round((shared_blks_hit + shared_blks_read)::numeric / NULLIF(calls, 0), 1) AS blocks_per_call,
       round(rows::numeric / NULLIF(calls, 0), 1) AS rows_per_call,
       temp_blks_written
FROM pg_stat_statements WHERE query LIKE '%FROM orders%'
ORDER BY total_exec_time DESC LIMIT 10;
```

`blocks_per_call`이 자릿수로 뛰었는데 `rows_per_call`은 그대로면 계획 변경(또는
원인 ⑤의 분포 급변)이고, `blocks_per_call`도 그대로인데 느려졌으면 §3-9이다.

> **MySQL 대조**: MySQL은 digest 테이블의 `SUM_ROWS_EXAMINED`로 "훑은 행 수"를
> 직접 볼 수 있다. PG의 `pg_stat_statements`에는 그 칸이 없고 `rows`는 **반환
> 행 수**다. 그래서 PG에서 "얼마나 헛일했나"의 대용치는 **읽은 블록 수**이고,
> 정확한 훑은 행 수는 개별 쿼리를 `EXPLAIN (ANALYZE)`로 재현해
> `Rows Removed by Filter`에서 읽는다.

**3단계. 계획을 현재 vs 과거로 diff한다.** PG에서 가장 확실한 방법은
**`auto_explain` 로그**다 — 과거의 실제 계획이 텍스트로 남아 있으므로 "어제
02:00의 계획"과 "오늘 09:00의 계획"을 그대로 비교할 수 있다.

```conf
# postgresql.conf — 상시로 켜 두는 것을 권한다 (§5-3)
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = '500ms'
auto_explain.log_analyze = on       # 실측치까지 (오버헤드 있음 — 임계를 넉넉히)
auto_explain.log_buffers = on
```

로그가 없으면 지금 계획을 뜨고 베이스라인(§5-1)과 비교한다. **`EXPLAIN`에 넣는
값은 실제로 느린 값**이어야 한다(`pg_stat_statements`는 파라미터를 `$1`로
정규화하므로 실제 값은 로그에서 얻는다). 그리고 **원인 ④가 의심되면
`EXPLAIN (GENERIC_PLAN)`도 같이 뜬다** — psql에서 리터럴로 뜬 계획은 커스텀
계획이라 앱이 실제로 쓰는 계획과 다를 수 있다.

**4단계. 통계를 확인한다.** `pg_stat_user_tables`의
`last_analyze`/`last_autoanalyze`/`n_mod_since_analyze`가 1단계의 시각과 어떻게
겹치는지 보고(→ ①②), `pg_stats`의 `n_distinct`를 레플리카의 실제
`COUNT(DISTINCT ...)`와 대조하고(→ ③), 문제의 값이 `most_common_vals`에
있는지 없어서 균등 분배로 추정되는지 확인한다(→ ⑤).

**5단계. 후보와 함수를 확인한다.** 인덱스 목록·`indisvalid` diff(§3-6),
`pg_settings` diff·`version()`(§3-7), `relpages`·`relallvisible` 추이(§3-8).
여기까지 오면 원인은 표의 10종 중 하나로 특정된다.

```text
증상 → 원인 빠른 매핑
- last_autoanalyze가 느려진 시각 직전 + n_distinct가 실제와 자릿수 차이  → ① + ③
- 앱 재시작하면 회복 / psql에선 빠름 / 편중 컬럼이 파라미터             → ④ (제네릭 계획)
- last_analyze는 오래됐고 n_mod_since_analyze가 큼                      → ② (통계 노후)
- 추정≈실측인데 느림, 값별 건수가 급변                                  → ⑤ (플래너가 옳다)
- AND 조건 여럿, 추정 rows가 실제보다 자릿수로 작음                      → ⑥ (확장 통계 부재)
- 인덱스 목록 diff에 새 항목 / indisvalid = false                       → ⑦
- pg_settings diff / 업그레이드 직후 통계 텅 빔                         → ⑧
- 아무 사건 없이 서서히, relpages 임계 통과, Parallel Seq Scan 등장      → ⑨
- Heap Fetches 폭증, relallvisible 하락, 롱 트랜잭션 존재                → ⑩
```

### 4-2. 즉시 완화 — 카드 5장, 각각 대가와 함께

장애 중이라면 근본 대응(DDL·배포)을 기다릴 수 없다. 카드는 **원인에 맞춰** 뽑고
대가를 같이 말한다(약점 ②).

**카드 1. `ANALYZE` — 원인 ①②③⑤⑧일 때, 가장 싼 첫 수.**

```sql
ANALYZE orders;                       -- 테이블 전체
ANALYZE orders (user_id, status);     -- 컬럼을 지정하면 더 빠르다
```

얻는 것: 코드 변경·배포 없이 통계를 지금 데이터에 맞춘다. **PG의 `ANALYZE`는
`SHARE UPDATE EXCLUSIVE` 잠금이라 읽기·쓰기를 막지 않는다** — 같은 테이블의
VACUUM/ANALYZE, `CREATE INDEX CONCURRENTLY`, 일부 `ALTER TABLE`과만 충돌한다.
내는 것 셋 — ⑴ **샘플 I/O**, ⑵ **계획 캐시 무효화**로 잠깐 계획 수립 비용이
몰린다, ⑶ 원인이 ③이라면 **이번엔 좋은 샘플이 잡혀도 다음 autoanalyze에 또
흔들린다** — 같은 테이블에서 ANALYZE를 두 번째 하고 있다면 카드 3으로 가야
한다는 신호다.

> **MySQL 대조**: `ANALYZE TABLE`은 테이블 정의 캐시를 비우므로 그 테이블을 오래
> 잡고 있는 쿼리가 있으면 **뒤이어 들어오는 쿼리들이 줄을 서는 flush 대기**가
> 생기고, 기본적으로 binlog에 기록돼 레플리카에서도 같이 돈다. PG에는 이 두
> 위험이 없다 — 잠금이 약하고, 물리 복제에서는 통계 자체가 WAL로 복제되므로
> 레플리카에서 따로 돌릴 필요도 없다(standby는 읽기 전용이라 돌릴 수도 없다).

**카드 2. `plan_cache_mode = force_custom_plan` — 원인 ④일 때, PG 고유의 원복 카드.**

```sql
-- 범위를 좁혀 적용한다 (GUC 계층 — §1-4)
ALTER ROLE app_user SET plan_cache_mode = force_custom_plan;   -- 이 앱 롤만. 새 커넥션부터 적용
ALTER DATABASE shop SET plan_cache_mode = force_custom_plan;   -- 더 넓게
SET plan_cache_mode = force_custom_plan;                       -- 지금 세션만(검증용)
```

얻는 것: 값을 다시 보게 만들어 **즉시 원상 복구**된다. 코드 배포도 DDL도 없다.
내는 것 셋 — ⑴ **매 실행 계획 수립 비용**(준비문의 존재 이유였던 계획 재사용을
포기하는 것이라, 짧고 초당 수천 번 도는 쿼리에서는 계획 수립 CPU가 무시 못 할
비용이 된다), ⑵ **범위가 쿼리 단위가 아니다** — 롤/DB에 걸면 그 롤의 모든
준비문이 영향을 받으므로, 근본 대응(부분 인덱스로 두 계획의 비용 차이 벌리기)이
서면 되돌리는 것이 맞다, ⑶ **원인을 덮는다** — 진짜 문제는 "편중 컬럼의 평균
선택도가 무의미하다"는 것이고 그건 인덱스 설계로 푸는 편이 낫다.

애플리케이션 쪽 대안도 같이 안다 — pgjdbc의 `prepareThreshold`로 서버 준비문
전환 시점을 늦추거나 아예 쓰지 않게 할 수 있다(대가는 같은 방향이다).

**카드 3. statistics target 상향 + 재수집 — 원인 ③⑤일 때.**

```sql
ALTER TABLE orders ALTER COLUMN user_id SET STATISTICS 1000;  -- 메타데이터 변경이라 즉시
ANALYZE orders (user_id);                                     -- 새 설정으로 바로 재수집
```

얻는 것: 샘플과 MCV·히스토그램 크기가 늘어 추정의 흔들림 폭이 줄고, 원인 ⑤(MCV
목록 진입/이탈)도 완화된다. 내는 것: ANALYZE가 그만큼 더 읽고 **계획 수립 시간이
늘어난다**(MCV 목록을 훑는 비용). 전역 `default_statistics_target`을 올리는
것보다 **문제 컬럼만 올리는 쪽**이 거의 항상 옳다.

**카드 4. 비용 파라미터·스위치의 국소 교정 — 원인 ⑧일 때.**

```sql
ALTER DATABASE shop SET random_page_cost = 1.1;   -- SSD인데 기본 4.0으로 남아 인덱스를 과소평가할 때
ALTER ROLE batch_user SET work_mem = '64MB';      -- 배치 롤에서만 정렬·해시 메모리를 키운다
BEGIN; SET LOCAL jit = off; SELECT ...; COMMIT;   -- 짧은 쿼리에 JIT가 붙어 느려진 경우, 그 트랜잭션만
```

얻는 것: **PG의 GUC 계층 덕분에 전역을 건드리지 않고 영향 범위를 좁힐 수 있다**
— MySQL 대비 PG의 실질적 강점이다. 내는 것: ⑴ 그래도 "쿼리 하나"보다는 넓다,
⑵ 비용 상수는 **모든 쿼리의 계획에 영향**을 주므로 하나를 고치면서 다른 쿼리를
나쁘게 만들 수 있다 — 바꾼 뒤 베이스라인 잡(§5-1)을 돌려 diff를 확인하는 것이
절차여야 한다, ⑶ `enable_seqscan = off` 류는 **여기 들어오면 안 된다**(§2-5의
가설 검증 도구이지 운영 설정이 아니다).

**카드 5. `pg_hint_plan` — 최후의 지혈대.**

PG에는 힌트 문법이 **없다.** 계획을 강제하려면 `pg_hint_plan` 확장을 설치해야
하고, 이 문턱 자체가 설계 메시지다 — "여기까지 왔다면 먼저 통계를 의심하라".

```sql
-- ❌ 이유도 기한도 없이 물리 인덱스 이름을 박는다 — 3년 뒤 아무도 못 지운다
/*+ IndexScan(o idx_orders_user) */ SELECT * FROM orders o WHERE o.user_id = $1 ...;

-- ✅ 이유·이슈·만료일을 함께 — "왜 플래너를 못 믿었는지"를 남긴다
/*+ IndexScan(o idx_orders_user) */
-- PLAN-PIN: 2026-08-31 autoanalyze 후 n_distinct 붕괴로 PK 역순 스캔 전환(ISSUE-1234).
--           복합 인덱스 (user_id, id) 배포 후 제거. 만료 2026-09-14
SELECT * FROM orders o WHERE o.user_id = $1 ORDER BY o.id DESC LIMIT 20;

-- 더 나은 선택: 계획을 고정하는 대신 "추정치만 고쳐 주는" 힌트
/*+ Rows(o #10) */ SELECT * FROM orders o WHERE o.user_id = $1 ORDER BY o.id DESC LIMIT 20;
```

얻는 것: 즉시, 확실히, 그 쿼리만. 내는 것 다섯 가지 — ⑴ **확장 의존**: 설치·
유지가 필요하고 관리형 서비스에 따라 지원 여부가 갈린다. ⑵ **데이터가 바뀌어도
계획이 못 따라간다**: 오늘 옳은 인덱스가 내년에는 틀린 인덱스가 되는데 힌트는
그 판단 기능을 꺼버린 것이다. ⑶ **코드에 물리 정보가 결합된다**: 인덱스 이름
변경·삭제가 애플리케이션 변경이 된다. ⑷ **업그레이드의 혜택에서 그 쿼리만
제외된다.** ⑸ **원인을 덮는다**: 통계·인덱스 설계의 진짜 문제는 남아 다른
쿼리에서 재발한다. 그래서 힌트는 **이슈 번호와 만료일이 붙은 지혈대**이고,
만료를 사람이 기억하지 않도록 §5-5의 린트가 지킨다. rationale이 말한 "힌트로
고정하는 것의 트레이드오프까지 가면 상급"이 정확히 이 다섯 줄이다.

**한 가지 더 — PG에는 인덱스를 "후보에서만 빼는" 스위치가 없다.** 원인 ⑦의
가설 검증은 `BEGIN; DROP INDEX ...; EXPLAIN ...; ROLLBACK;`으로 한다 — PG는
**DDL이 트랜잭션에 포함**되므로 "지웠다 되돌리는" 검증이 가능하다(가산점
포인트). 단 `DROP INDEX`는 `ACCESS EXCLUSIVE` 잠금이라 **트래픽이 있는 운영에서
이 몇 초가 대기열을 만들어 사고가 된다** — `SET LOCAL lock_timeout = '2s'`를 같이
걸고 가능하면 스냅샷 복제본에서 한다.

> **MySQL 대조**: MySQL 8은 `ALTER INDEX ... INVISIBLE`로 **메타데이터만 바꿔
> 즉시·가역적으로** 인덱스를 후보에서 뺄 수 있어 "지우기 전 일주일은 INVISIBLE로
> 둔다"는 안전 규칙이 성립한다. PG에는 이 기능이 없어 인덱스 삭제가 **비가역적
> 결정**이 되고(되돌리려면 `CREATE INDEX CONCURRENTLY` 2회 스캔), 그래서
> `idx_scan`을 오래 관찰해 근거를 쌓는 일이 더 중요해진다.

### 4-3. 근본 대응 — 흔들릴 여지를 없앤다

**1. 복합 인덱스로 후보를 하나로 만든다 — 최우선.** §2의 쿼리에 `(user_id, id)`를
두면 "이 사용자의 행을 id 순서로 읽는다"는 후보 하나가 WHERE·ORDER BY·LIMIT을
전부 만족하고 정렬이 사라진다. 계획 B가 이길 수 있는 통계값이 존재하지 않으므로
**통계가 어떻게 흔들려도 계획이 안 흔들린다.**

```sql
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id, id);
-- PG는 B-tree를 역방향으로 읽으므로 (user_id, id DESC)로 만들 필요가 없다
-- → Index Scan Backward using idx_orders_user_id 로 찍히고 Sort 노드가 사라진다
```

순서 원칙(등호 → 범위 → 정렬 → 커버링)은
[복합 인덱스 컬럼 순서](08-composite-index-column-order.md) §2, `INCLUDE` 확장은
[커버링 인덱스](09-covering-index.md). 내는 것: 인덱스 하나만큼의 쓰기·공간 비용
(PG에서는 인덱스 컬럼이 바뀌는 UPDATE가 **HOT에서 탈락해 모든 인덱스에 새 엔트리를
꽂는다**는 추가 대가), 대형 테이블 DDL의 절차 비용
([무중단 DDL](14-online-ddl-zero-downtime-schema-change.md)), 기존
`idx_orders_user`가 접두사로 중복되므로 관찰 후 정리.

**2. 부분 인덱스 — 원인 ④⑤의 근본 처방이자 PG의 무기.**

```sql
-- 관리자 화면이 보는 것은 전체의 1%뿐이다. 그 1%만 담는 인덱스를 만든다
CREATE INDEX CONCURRENTLY idx_orders_failed_created
  ON orders (created_at DESC) WHERE status = 'FAILED';
```

얻는 것: 인덱스가 전체의 1% 크기라 **압도적으로 싸므로, 제네릭 계획이 평균
선택도로 계산하더라도 이 인덱스를 고를 여지가 커진다**(사고 ②의 근본 해결).
내는 것: **쿼리의 WHERE가 인덱스의 WHERE를 포함해야만** 플래너가 쓴다 —
`status = $1`처럼 파라미터로 오면 `$1 = 'FAILED'`임을 증명할 수 없어 **못 쓴다.**
그래서 대개 "그 화면만 리터럴을 박은 전용 쿼리로 분리"와 짝이다.

**3. 확장 통계 — 원인 ⑥.** §1-2의 `CREATE STATISTICS`. 얻는 것: 컬럼 독립
가정을 깨서 AND 조건의 추정이 현실에 붙는다. 내는 것: **직접 만들어야 하고 어느
조합이 상관관계가 있는지는 사람이 판단해야 한다**(추정 vs 실제 rows가 자릿수로
벌어지는 쿼리에서 역산한다), ANALYZE·계획 수립 비용이 늘고, 테이블 하나 안의
컬럼에만 적용되어 조인 양쪽의 상관은 못 잡는다.

**4. 통계 정밀도 정책을 테이블에 박는다 — 원인 ①②③.**

```sql
-- 큰 테이블은 비율 임계가 너무 멀다 → 이 테이블만 임계를 낮춘다
ALTER TABLE orders SET (autovacuum_analyze_scale_factor = 0.02,
                        autovacuum_analyze_threshold    = 5000);

-- 편중 컬럼은 정밀도를 올린다
ALTER TABLE orders ALTER COLUMN user_id SET STATISTICS 1000;

-- 값 개수가 실제로 안정적인 컬럼은 추정치를 고정해 흔들림을 원천 차단한다
ALTER TABLE orders ALTER COLUMN user_id SET (n_distinct = -0.1);
ANALYZE orders;
```

얻는 것: 사고 ①의 원인(샘플 편중으로 인한 추정 붕괴)이 구조적으로 줄어든다.
내는 것: ⑴ 임계를 낮추면 **autoanalyze가 더 자주 돌아** 그 자체가 I/O 부하다,
⑵ `n_distinct` 고정은 **가장 위험한 손잡이**로, 데이터 성격이 바뀌어도 플래너는
영구히 그 값을 믿으므로 이유와 재검토 시점을 마이그레이션 파일에 남기고 §5-1의
베이스라인 잡이 감시하게 한다.

**5. 대량 적재·업그레이드 절차에 ANALYZE를 코드로 박는다 — 원인 ②⑧.** 배치의
마지막 Step(§5-4), `pg_upgrade` 직후의 `vacuumdb --all --analyze-in-stages`
(§3-7). "잊지 말자"가 아니라 **잡 정의와 런북 스크립트에 들어가야 한다.**

**6. 스큐 파라미터의 경로 분리 — 원인 ⑤.** 대형 가맹점만 다른 쿼리(키셋 커서,
기간 조건 강제, 별도 집계 테이블)를 타게 한다. 내는 것: 코드 경로가 둘이 되고
"누가 대형인가"의 기준을 유지해야 한다.

| 대응 | 얻는 것 | 내는 것 | 언제 |
|---|---|---|---|
| `ANALYZE` | 즉시, 무해, 배포 없음 | 다음 autoanalyze에 또 흔들릴 수 있음 | 무조건 첫 수 |
| `force_custom_plan` | 제네릭 계획 즉시 원복 | 매 실행 계획 수립 비용, 범위가 롤/DB 단위 | 원인 ④ |
| statistics target 상향 | 추정 안정, MCV 확대 | ANALYZE I/O, 계획 수립 시간 | 같은 테이블 ANALYZE 2회째 |
| `CREATE STATISTICS` | 컬럼 독립 가정 해소 | 사람이 조합 선정, 테이블 내부만 | AND 조건 추정이 자릿수로 틀릴 때 |
| 비용 파라미터 국소 교정 | 하드웨어 현실 반영 | 그 롤/DB의 모든 계획에 영향 | SSD인데 기본값 그대로일 때 |
| 복합·부분 인덱스 | 통계와 무관하게 안정 | 쓰기·HOT 탈락·DDL 절차 | 거의 항상 1순위 근본 대응 |
| `n_distinct` 고정 | 흔들림 원천 차단 | 데이터 성격 변화에 영구히 눈감음 | 값 개수가 확실히 안정적일 때만 |
| `pg_hint_plan` | 즉시·확실·쿼리 단위 | 확장 의존·추종 불가·결합·원인 은폐 | 지혈대, 만료일 필수 |

---

## 5. 고정 — 안전망을 사람의 기억 밖으로

후보자는 3장에서 "사람의 기억에 의존하지 않는 방법"을 물었는데도 TODO 주석으로
답하는 등 안전망을 코드로 고정하는 습관의 부재가 반복됐다. 이 주제는 특히
그렇다 — **계획 변경은 배포 없이 일어나므로 배포 파이프라인이 못 잡는다.** 잡는
것은 정기 잡과 알람뿐이다. 다섯 종을 층으로 둔다.

### 5-1. EXPLAIN 베이스라인 잡 — 운영 통계로, 정기적으로, diff

[실행 계획 읽기](10-explain-and-slow-query-process.md) §4-4의 "EXPLAIN 단정
테스트"는 CI에서 **시드 데이터**로 돌아 **코드 변경**이 만드는 회귀를 잡는데,
이 문서의 원인은 데이터·통계가 만드는 회귀라 그것으로는 안 잡힌다. 한 층이 더
필요하다 — **운영 레플리카에서, 운영 통계로, 매일 뜨는 베이스라인.**

```bash
# explain-baseline.sh — 핵심 쿼리 계획을 운영 레플리카에서 뜨고 커밋된 베이스라인과 비교
BASE=db/explain-baseline; WORK=$(mktemp -d); changed=0
for q in db/critical-queries/*.sql; do    # 파일 1개 = 쿼리 1개. 파라미터는 대표값·최악값 두 벌
  name=$(basename "$q" .sql)
  psql -X -A -t -h "$REPLICA_HOST" -d shop -c "EXPLAIN (FORMAT JSON, SETTINGS) $(cat "$q")" \
    | jq -S '[.. | objects | select(has("Node Type"))
              | {node: ."Node Type", rel: ."Relation Name",
                 idx: ."Index Name", cond: ."Index Cond"}]' > "$WORK/$name.json"
  diff "$BASE/$name.json" "$WORK/$name.json" || { echo "PLAN CHANGED: $name"; changed=1; }
done
exit $changed        # 0이 아니면 알람 채널로. 승인된 변경이면 베이스라인 JSON을 PR로 갱신
```

노드 종류·인덱스 이름·`Index Cond`는 엄격 비교하고, `Total Cost`와 `Plan Rows`는
따로 기록해 "3배 이상 변동"을 경고로 둔다(ANALYZE만으로도 조금씩 움직이므로
엄격 비교하면 소음이 된다). `SETTINGS`를 켜면 **기본값에서 벗어난 GUC가 계획과
함께 기록**되므로 원인 ⑧의 증거가 베이스라인 안에 남는다.

**이 잡이 하는 일은 "느려지기 전에" 계획 전환을 알리는 것**이다 — 새벽 2시
autoanalyze 뒤 6시 잡이 diff를 내면 출근 전에 안다. **PostgreSQL에는 Oracle의
SQL Plan Baseline이나 SQL Server Query Store 같은 계획 고정·회귀 감지 기능이
없으므로**, 이 "우리가 기록한 베이스라인"이 그 역할을 대신한다. 원인 ④까지
잡으려면 파라미터 쿼리는 `EXPLAIN (GENERIC_PLAN)` 판도 같이 떠서 비교한다.

### 5-2. pg_stat_statements 스냅샷과 비율 알람 — "건당 블록"의 급변을 기계가 본다

```sql
-- ops.pgss_snapshot(snapshot_at, queryid, query, calls, total_exec_time, rows,
--                   shared_blks_hit, shared_blks_read)  PK(snapshot_at, queryid)
-- 매시 적재 (pg_cron 또는 외부 크론)
INSERT INTO ops.pgss_snapshot
SELECT now(), queryid, left(query, 500), calls, total_exec_time, rows,
       shared_blks_hit, shared_blks_read
FROM pg_stat_statements WHERE queryid IS NOT NULL;

-- 직전 구간 대비 "건당 읽은 블록"과 "건당 반환 행"을 나란히 — 앞만 뛰면 계획 변경
SELECT c.queryid, left(c.query, 80) AS q,
       (c.shared_blks_hit + c.shared_blks_read - p.shared_blks_hit - p.shared_blks_read)
         / NULLIF(c.calls - p.calls, 0)                 AS blocks_per_call_now,
       (c.rows - p.rows) / NULLIF(c.calls - p.calls, 0) AS rows_per_call_now
FROM ops.pgss_snapshot c
JOIN ops.pgss_snapshot p
  ON p.queryid = c.queryid AND p.snapshot_at = c.snapshot_at - interval '1 hour'
WHERE c.snapshot_at = (SELECT max(snapshot_at) FROM ops.pgss_snapshot)
  AND c.calls > p.calls
ORDER BY 3 DESC;
-- (7일 중앙값 대비 5배 같은 임계는 같은 테이블에서 윈도우 집계로 붙인다)
```

postgres_exporter + Prometheus로 만들면 알람 규칙이 YAML 파일이 된다. 어느
쪽이든 **"건당 읽은 블록이 갑자기 100배인데 반환 행은 그대로"라는 알람이 계획
변경의 가장 이른 신호**다. 주의 — `pg_stat_statements`는 누적이고
`pg_stat_statements.max`를 넘으면 오래된 항목이 밀려나므로, 스냅샷 테이블이
사실상의 시계열 원본이 된다.

### 5-3. auto_explain 상시 + "신규 느린 쿼리 등장" 알람

계획이 뒤집힌 쿼리는 어제까지 느린 쿼리 로그에 없다가 오늘 처음 나타난다.
`log_min_duration_statement` 임계와 "분당 건수" 알람에 더해,
**`auto_explain`을 상시로 켜 두는 것**이 이 문서의 핵심 장치다 — 사고가 났을 때
"그때의 계획"이 로그에 남아 있어야 §4-1의 3단계가 성립한다. pgBadger 같은 도구로
일일 리포트를 만들고 **어제 리포트에 없던 정규화 쿼리**를 따로 표시한다. 총량
알람은 묻히지만 "신규 등장"은 안 묻힌다. `log_analyze = on`은 계측 오버헤드를
얹으므로 `log_min_duration`을 넉넉히 잡고 `sample_rate`로 표본만 남긴다.

### 5-4. 배치의 마지막 단계를 `ANALYZE`로 코드화

§2-1의 사고는 "배치가 끝나고 autovacuum이 알아서" 통계를 뜬 데서 났다. 대량 적재
배치가 **스스로 통계를 갱신하고 끝나면** ANALYZE 시각이 배치 시각으로 고정되고,
샘플 오차가 있더라도 배치 직후 베이스라인 잡(§5-1)이 그것을 본다.

```java
// ❌ before: 런북 "이관 배치 뒤에는 DBA에게 ANALYZE 요청" — 통계는 autovacuum에 맡겨진다.
//    언제, 어떤 샘플로 될지 아무도 모르고, 런북은 아무도 안 읽는다.

// ✅ after: 적재 Step 뒤에 통계 갱신 Step을 잡 정의에 박는다 —
//    "잡은 성공했는데 통계는 낡은" 상태가 존재하지 않게
@Bean
public Job merchantMigrationJob(JobRepository repo, Step loadOrdersStep, Step analyzeOrdersStep) {
    return new JobBuilder("merchantMigrationJob", repo)
            .start(loadOrdersStep)
            .next(analyzeOrdersStep)      // 마지막 단계 = 통계 갱신. 실패하면 잡 실패로 보인다
            .build();
}

@Bean
public Step analyzeOrdersStep(JobRepository repo, PlatformTransactionManager tm, JdbcTemplate jdbc) {
    // ANALYZE는 SHARE UPDATE EXCLUSIVE라 읽기·쓰기를 막지 않는다.
    // 물리 복제 레플리카는 통계도 WAL로 복제되므로 여기서만 돌리면 된다.
    // 대량 삭제가 섞였다면 VACUUM (ANALYZE)로 죽은 튜플 회수까지 함께.
    return new StepBuilder("analyzeOrdersStep", repo)
            .tasklet((c, ctx) -> { jdbc.execute("ANALYZE orders"); return RepeatStatus.FINISHED; }, tm)
            .build();
}
```

적용 기준을 규칙으로 적어둔다: **"한 번에 테이블 행 수의 수 % 이상을 넣거나
지우는 잡은 마지막 Step이 ANALYZE다."** PR 템플릿의 체크 항목이 된다. 같은
규칙의 짝이 **업그레이드 런북**이다 — `pg_upgrade` 절차서의 마지막 줄은
`vacuumdb --all --analyze-in-stages`이고, 이 줄이 빠진 절차서는 반려한다.

### 5-5. 계획 고정 레지스트리 린트 — 지혈대의 만료를 기계가 본다

§4-2 카드 5의 "만료일"은 사람이 기억하면 안 지켜진다. PG의 감시 대상은 둘이다 —
`pg_hint_plan` 힌트 주석과, 코드에서 세션 GUC를 덮어쓰는 자리.

```bash
# ci/lint-plan-pins.sh — 계획 고정 자리에 PLAN-PIN(이슈·만료일)이 없거나 만료됐으면 실패
status=0
while IFS=: read -r file line _; do
  ctx=$(sed -n "$((line > 3 ? line - 3 : 1)),$((line + 3))p" "$file")
  expiry=$(grep -oE "PLAN-PIN:.*만료 [0-9]{4}-[0-9]{2}-[0-9]{2}" <<< "$ctx" | grep -oE "[0-9-]{10}$" || true)
  if [ -z "$expiry" ]; then echo "$file:$line PLAN-PIN(이슈·만료일)이 없다"; status=1
  elif [[ "$expiry" < "$(date +%F)" ]]; then echo "$file:$line PLAN-PIN 만료($expiry)"; status=1; fi
done < <(grep -rnE "/\*\+ *(IndexScan|SeqScan|NestLoop|HashJoin|MergeJoin|Rows|Set)|SET (LOCAL )?(enable_[a-z]+|plan_cache_mode|random_page_cost|jit) *=" src/ db/ || true)
exit $status
```

한 층 더 — **`SET (n_distinct = ...)`이나 `ALTER ROLE ... SET ...`은 코드가 아니라
DB에 남는 고정**이라 grep으로 안 잡힌다. 마이그레이션 파일로만 적용하도록 규약을
정하고, §5-1의 베이스라인 잡이 `pg_settings`·`reloptions` 스냅샷을 함께 떠서
"코드에 없는 고정"을 diff로 드러내게 한다.

이 다섯 층이 있으면 사고는 이렇게 흘러간다 — 새벽 2시 배치가 끝나며 스스로
ANALYZE(5-4) → 6시 베이스라인 잡이 `Index Scan → Index Scan Backward` diff를
알림(5-1) → 담당자가 `ANALYZE`·`plan_cache_mode`로 즉시 완화(4-2) → 복합 인덱스를
`CREATE INDEX CONCURRENTLY`로 배포(4-3) → 2주 뒤 린트가 만료를 알려 임시 고정
제거(5-5). 사용자는 느려진 것을 모른다.

---

## 6. 꼬리질문 대비 포인트

### "계획을 고정해 버리면 끝 아닌가요? 왜 최후 수단이라고 하죠?" (시니어 변별 포인트)

**PostgreSQL에는 애초에 힌트 문법이 없다 — 그 사실 자체가 답의 절반이다.**
계획을 강제하려면 `pg_hint_plan` 확장을 설치해야 하고, 그건 "여기까지 왔다면
먼저 통계를 의심하라"는 설계 메시지다. 원리로 말하면 **힌트는 문제를 푸는 게
아니라 플래너의 판단 기능을 끄는 것**이다. 플래너가 오늘 틀렸다고 내년에도
틀리리라는 보장이 없는데, 힌트는 "오늘의 정답"을 영구 고정한다. 대가를 한
호흡에 — ⑴ 확장 설치·유지라는 운영 부담, ⑵ 분포가 바뀌어도 계획이 못 따라간다,
⑶ 인덱스 이름이라는 물리 정보가 코드에 결합된다, ⑷ 업그레이드로 플래너가
좋아져도 그 쿼리만 과거에 묶인다, ⑸ 증상을 덮어 진짜 원인이 다른 쿼리에서
재발한다. 그래서 순서는 **`ANALYZE` → statistics target·`CREATE STATISTICS` →
비용 파라미터 국소 교정 → 복합·부분 인덱스로 후보 단일화 → 그래도 안 되면
`pg_hint_plan`** 이고, 쓴다면 **이슈 번호·이유·만료일을 붙이고 린트가 만료를
잡게** 한다. 한 단계 더 나은 답은 계획을 통째로 고정하는 대신
**`/*+ Rows(...) */`처럼 추정치만 고쳐 주는 힌트** — 플래너의 판단은 살려 두고
틀린 입력만 바로잡는 것이라 대가가 작다. "장애 중이라면 먼저 고정하고 나중에
정리하겠다"도 맞는 답이다 — 단, "나중"을 기계가 기억하게 하는 장치까지 말해야
상급이다.

### "플래너가 '틀린' 게 아니라 '맞게' 바꾼 경우는 어떻게 구분하나요?"

**`EXPLAIN (ANALYZE, BUFFERS)`로 추정과 실측의 거리를 잰다.** 새 계획의 추정
`rows`와 `actual rows`가 가까우면 플래너는 지금 데이터를 정확히 보고 있고 계획
전환은 옳다 — `status = 'FAILED'`가 1%에서 40%가 된 뒤의 Seq Scan은 정답이다.
이때 느린 것은 계획 탓이 아니라 **"실패 주문 전부를 읽는 쿼리"가 된 요구** 탓
이므로, 대응은 쿼리·요구의 변경(기간 조건 강제, 아카이빙, 부분 인덱스,
파티셔닝)이다. 반대로 추정과 실측이 자릿수로 어긋나면 입력이 틀린 것이고, 그때는
`ANALYZE` → statistics target → `CREATE STATISTICS` 순서다. **PG에서 함께 봐야
할 칸이 둘 더 있다** — `Rows Removed by Filter`(헛일의 크기)와 `Buffers`(실제
I/O). "플래너가 이상하다"는 말은 이 측정 전에는 할 수 없다.

### "autovacuum의 ANALYZE를 꺼버리면 안정적이지 않나요?"

**안정은 얻지만 낡음의 책임을 전부 떠안는다.** `autovacuum_enabled = false`로
두면 계획은 내가 ANALYZE할 때만 바뀌지만 대가가 셋이다. ⑴ 데이터가 10배로 자라도
통계는 그대로라 "낡은 통계로 인한 오판"이 영구화된다. ⑵ **PG에서는 특히 위험
한데, autovacuum을 끄면 ANALYZE만이 아니라 VACUUM까지 멈춘다** — bloat가 늘고
visibility map이 낡아 Index Only Scan이 퇴화하며, 최악의 경우 XID wraparound
위험까지 간다. ⑶ 예약 ANALYZE 잡이 실패하면 아무도 모른다. 그래서 PG의 올바른
선택은 "끈다"가 아니라 **임계를 테이블 단위로 조정**
(`autovacuum_analyze_scale_factor = 0.02`)이다. "재계산이 문제"가 아니라
"재계산의 표본과 시점이 문제"이므로, 표본은 statistics target으로 키우고 시점은
임계와 배치 끝 ANALYZE로 당긴다.

### "같은 쿼리인데 앱에서만 느리고 psql에선 빠릅니다. 재시작하면 잠깐 낫고요."

**PostgreSQL 준비문의 제네릭 계획 전환이다 — PG 면접에서 이 답을 아는지가
갈림길이다.** 사슬로 말한다: pgjdbc가 같은 문장 5회 뒤 서버 준비문으로 전환하고,
서버는 커스텀 계획 다섯 번의 평균 비용과 제네릭 계획 비용을 비교해 제네릭이
비싸지 않으면 그쪽으로 고정한다. 제네릭 계획은 `$1`을 모르므로 컬럼의 **평균
선택도**를 쓰는데, `status`처럼 편중된 컬럼에서는 그 평균이 실제 쿼리가 쓰는
값(1%짜리 FAILED)과 전혀 다르다 → Seq Scan을 고른다. psql에서 리터럴로 실행하면
커스텀 계획이라 빠르고, 앱을 재시작하면 준비문 캐시가 비어 잠깐 회복됐다가 여섯
번째 실행부터 다시 느려진다. 확진은 **`EXPLAIN (GENERIC_PLAN)`(PG 16+)** 또는
`PREPARE` 후 여섯 번의 `EXPLAIN EXECUTE`. 즉시 완화는 `force_custom_plan`을 롤
단위로(대가: 매 실행 계획 수립 비용), 근본 대응은 **부분 인덱스로 두 계획의 비용
차이를 벌려 제네릭 계획조차 인덱스를 고르게 만드는 것**이다. **(가산점 포인트)**
`track_planning`을 켜면 `calls`는 느는데 `plans`가 안 느는 것으로 계획 재사용을
간접 확인할 수 있다.

### "메이저 업그레이드 전후로 실행 계획 변경을 어떻게 미리 잡나요?" (시니어 변별 포인트)

**두 가지를 분리해서 말해야 한다 — "플래너가 바뀌는 것"과 "통계가 사라지는 것".**
후자가 훨씬 흔하고 치명적이다: **`pg_upgrade`는 옵티마이저 통계를 새 클러스터로
옮기지 않는다.** 업그레이드 직후의 DB는 통계가 빈 상태라 모든 쿼리의 계획이
동시에 이상해지고, 사람들은 "새 버전이 나쁘다"고 오진한다. 그래서 절차의 마지막
줄은 반드시 `vacuumdb --all --analyze-in-stages`다. 전자(플래너 변경)의 절차는
⑴ `pg_stat_statements` 상위 N개와 핵심 쿼리 목록을 뽑고, ⑵ 운영 스냅샷
스테이징을 새 버전으로 올린 뒤 **`ANALYZE`로 통계를 맞추고**(빼면 비교가
무의미하다), ⑶ 두 버전의 계획을 §5-1의 스크립트로 diff하고, ⑷ 바뀐 것은 실측해
좋아진 것과 나빠진 것을 나눈다. 나빠진 쿼리는 미리 인덱스를 손보거나 롤 단위
GUC를 브리지로 둔다. 한 호흡으로 — "업그레이드의 이득을 받되, 통계 재수집을
절차에 못 박고, 계획 diff로 손해 볼 쿼리를 미리 특정해 리스크를 좁힌다."

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **index dive의 유무** — MySQL은 상수 조건이면 인덱스 범위에
실제로 들어가 행 수를 세므로 통계가 낡아도 단순 조건은 비교적 정확하지만, PG는
**오직 `pg_stats`만** 본다. 그래서 PG에서는 "대량 적재 직후 ANALYZE"가 선택이
아니라 절차이고, 진단의 첫 수도 `ANALYZE`로 고정된다. ② **제네릭 계획** —
PG는 준비문 5회 뒤 값을 안 보는 계획으로 고정될 수 있어 "여섯 번째부터 느려진다"
가 생기지만, MySQL은 매 실행 재최적화라 이 함정이 없다. 대신 MySQL은 특정
값에서만 느린 형태로 온다 — 뿌리는 같은 스큐다. ③ **계획을 고정하는 수단** —
MySQL은 `FORCE INDEX`·옵티마이저 힌트·`SET_VAR`가 문법에 있고 `INVISIBLE`로
인덱스를 즉시·가역적으로 후보에서 뺄 수 있지만, PG는 힌트가 확장이고 INVISIBLE이
없어 인덱스 삭제가 비가역 결정이 된다. 대신 PG는 **GUC를 전역/DB/롤/세션/
트랜잭션 계층으로 좁혀 덮을 수 있다.** ④ **후보 비교를 보는 법** — MySQL은
`optimizer_trace`가 후보별 비용을 주지만, PG는 `enable_*`를 하나씩 꺼서 재는
수동 방식이다(대신 PG는 노드별 실제 블록을 준다). ⑤ **통계 수집의 단위** —
MySQL은 인덱스별 카디널리티를 20페이지 샘플로 뜨고 히스토그램은 수동 갱신이지만,
PG는 컬럼별 MCV·히스토그램·correlation을 기본 통계로 갖고 autoanalyze가 갱신하며
컬럼 간 상관은 `CREATE STATISTICS`로 따로 만든다. 이 다섯을 짚으면 "한쪽만
써봤다"가 아니라 "차이를 원리로 이해했다"로 들린다.

---

## 한 줄 요약

**PostgreSQL 플래너는 통계·확장 통계·파라미터 값·비용 상수를 입력받아 후보
계획의 비용을 비교하는 함수라서, 코드도 쿼리도 안 바꿨는데 계획이 바뀌었다면
입력이 바뀌었거나(autoanalyze·통계 노후·n_distinct 오추정·분포 변화·**제네릭
계획 전환**), 후보가 바뀌었거나(인덱스 추가·삭제·INVALID), 함수가 바뀐 것
(GUC·메이저 업그레이드 — **`pg_upgrade`는 통계를 안 옮긴다**)이다. PG에는 index
dive도, 힌트 문법도, INVISIBLE 인덱스도 없으므로 통계가 유일한 진실이고 대응
순서가 강제로 고정된다 — `ANALYZE` → statistics target → `CREATE STATISTICS` →
비용 파라미터 국소 교정 → 부분·복합 인덱스로 후보 단일화 → 최후에
`pg_hint_plan`(원인이 제네릭 계획이면 그 앞에 `force_custom_plan`). 진단은
느려진 시각 → 건당 읽은 블록 비교 → `auto_explain` 로그의 계획 diff →
`last_autoanalyze`·`pg_stats` 확인 순서이며, 배포 없이 일어나는 변경이므로
EXPLAIN 베이스라인 잡·pg_stat_statements 스냅샷 알람·배치 끝 ANALYZE·업그레이드
런북의 `vacuumdb --analyze-in-stages`를 기계에 맡겨야 사용자보다 먼저 안다.**
