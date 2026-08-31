# 실행 계획의 갑작스러운 변경 — 옵티마이저는 "통계를 입력받는 함수"다, 입력이 바뀌면 출력이 바뀐다

> 핵심 관전 포인트: **옵티마이저는 쿼리를 "계산"하는 계산기가 아니라, 통계·
> 샘플·파라미터 값·비용 상수를 입력으로 받아 후보 계획들의 비용을 비교하는
> 함수다. 코드도 쿼리도 안 바꿨는데 계획이 바뀌었다면 셋 중 하나다 — ① 입력이
> 바뀜(통계 자동 재계산, 샘플링 오차, 데이터 분포 변화, 들어오는 파라미터 값),
> ② 후보가 바뀜(인덱스 추가·삭제), ③ 함수가 바뀜(DB 업그레이드, 파라미터 변경).
> 대응은 사다리다 — 진단(느려진 시각 특정 → 그 시각 전후 digest의 "건당
> examined 행" 비교 → EXPLAIN 현재 vs 베이스라인 diff → 통계 `last_update` 확인
> → 데이터 분포 확인) → 즉시 완화(`ANALYZE TABLE`, 기한 붙인 힌트, `INVISIBLE`)
> → 근본 대응(복합 인덱스로 후보를 하나로, 히스토그램, 샘플 페이지 상향) →
> 고정(EXPLAIN 베이스라인 잡, digest 스냅샷 알람, 배치 마지막 단계 `ANALYZE`).
> 힌트는 "옵티마이저가 오늘 맞았다"를 영구 고정하는 것이라, 데이터가 바뀌어도
> 계획이 못 따라오고 코드에 물리 정보가 결합되는 대가를 낸다 — 이슈와 만료일을
> 붙인 지혈대로만 쓴다.**

---

## 0. 질문 + 의도

**질문**: "잘 돌던 쿼리의 실행 계획이 어느 날 갑자기 바뀌어 느려졌습니다.
가능한 원인과 대응은?"

관련 질문:
"배포도 없었는데 어제부터 DB CPU만 올랐습니다. '변경이 없다'는 전제를 어떻게
검증하고, 원인 후보를 어떻게 좁혀가나요?" (같은 장 중급 문항 — [별도 문서](./db-cpu-spike-without-deployment.md).
그쪽은 "변경 없음"이라는 전제를 의심하며 **원인 전체를 넓게** 훑고, 이 문서는
그중 가장 흔한 한 갈래인 **"실행 계획이 바뀌었다"를 깊게** 판다.)

**출제 의도**: rationale의 표현 그대로 — "'코드도 쿼리도 안 바꿨는데 느려졌다'의
단골 원인(통계 정보 갱신, 데이터 분포 변화). **DB를 정적인 계산기가 아니라
상태에 따라 판단이 바뀌는 시스템으로 이해하는지** — 힌트로 고정하는 것의
트레이드오프까지 가면 상급이다." 즉 이 문항이 재는 것은 두 층이다. 아래층은
**모델**이다 — "같은 SQL을 넣으면 같은 계획이 나온다"는 계산기 모델을 버리고,
"옵티마이저는 통계라는 입력으로 비용을 계산하는 함수라서 입력이 바뀌면 출력이
바뀐다"는 모델을 갖고 있는가. 이 모델이 있어야 원인 후보가 목록으로 인출되고
진단 순서가 논리적으로 나온다. 위층은 **판단**이다 — 계획을 고정하는 힌트가
"문제 해결"이 아니라 "옵티마이저의 판단 기능을 끄는 것"임을 알고, 그 대가와
기한을 붙여 쓰는가.

이 문서는 모의면접 **전** 학습용이다. 후보자의 횡단 약점 네 가지를 각 지점에서
명시적으로 겨냥한다 — ① 인과를 "메커니즘 사슬"로 서술하기(§1·§2), ② 대응책
각각의 대가를 한 호흡에 양면으로(§4-2·§4-3), ③ 안전망을 사람의 기억이 아니라
코드·설정·잡으로 고정하기(§5), ④ "원인 후보 N종"과 "대응 사다리"를 목록으로
인출하기(§3·§4). EXPLAIN 칸 읽는 법과 측정→가설→검증→고정 사이클은
[실행 계획 읽기와 느린 쿼리 개선 프로세스](explain-and-slow-query-process.md)에,
"왜 옵티마이저가 인덱스를 일부러 버리는가"의 비용 모델(랜덤 vs 순차 I/O)은
[인덱스를 걸었는데도 풀스캔](index-not-used-full-scan.md) §4에 있다. 이 문서는
그 위에 **"어제까지 옳던 판단이 오늘 왜 바뀌는가"** 만 얹는다.

---

## 1. 모델 — 옵티마이저는 함수다: 계획 = f(후보 집합, 입력)

먼저 머릿속 모델을 교체한다. 계산기는 `2 + 3`을 넣으면 언제나 `5`다. 옵티마이저는
그렇지 않다.

```text
                 ┌────────────────────────────────────────────────┐
  후보 집합 ───▶ │                                                │
  (쓸 수 있는    │   각 후보의 "예상 비용"을 계산해 가장 싼 것을 고른다   │ ───▶ 실행 계획
   인덱스·조인   │                                                │
   순서·접근법)  │   비용 = g(입력)                                 │
                 └────────────────────────────────────────────────┘
                                   ▲
       입력 ───────────────────────┘
       ① 영속 통계        : 테이블 행 수, 인덱스별 "서로 다른 값의 수"(카디널리티)
       ② 최적화 시점 샘플  : 상수 조건의 인덱스 범위에 실제로 들어가 세어본 값(index dive)
       ③ 쿼리에 들어온 값  : 파라미터 — MySQL은 실행할 때마다 다시 최적화한다
       ④ 비용 상수·스위치  : 페이지 읽기 비용, 행 평가 비용, optimizer_switch, 메모리 한도
```

이 그림에서 **"출력(계획)이 바뀌었다"는 문장은 자동으로 세 가지 질문으로
쪼개진다.** 입력이 바뀌었나? 후보 집합이 바뀌었나? 함수 자체(DB 버전·상수)가
바뀌었나? §3의 원인 8종은 전부 이 세 칸 중 하나에 들어간다. 목록을 외우는 게
아니라 이 세 칸에서 **꺼내는** 것이다.

> **내비게이션 비유**
> 같은 집에서 같은 회사로 가는데 어느 날 내비가 다른 길을 안내한다. 지도(쿼리)는
> 그대로다. 바뀐 것은 교통정보(통계)다. 교통정보가 갱신되면 안내가 바뀌는 건
> 정상이고, 대개 더 나은 길이다. 문제는 교통정보가 **낡았거나**(통계가 현실과
> 어긋남), **표본이 적어 엉뚱하게 잡혔거나**(샘플링 오차), **평균 차량 기준이라
> 내 차(파라미터 값)에는 안 맞을 때**다. "내비가 미쳤다"가 아니라 "내비가 무슨
> 정보를 보고 그렇게 판단했나"를 묻는 것이 진단의 시작이다.

### 1-1. 입력 ① 영속 통계 — 무엇이고, 어디에 쓰이나

InnoDB는 테이블마다 통계를 디스크에 저장한다(영속 통계, `innodb_stats_persistent`
기본 ON). 저장소는 두 시스템 테이블이다.

```sql
-- 테이블 단위: 행 수 추정, 클러스터드 인덱스 크기(페이지), 나머지 인덱스 크기 합, 마지막 갱신 시각
SELECT table_name, n_rows, clustered_index_size, sum_of_other_index_sizes, last_update
FROM mysql.innodb_table_stats
WHERE database_name = 'shop' AND table_name = 'orders';

-- 인덱스 단위: 컬럼 접두사별 "서로 다른 값의 수"(n_diff_pfx01, n_diff_pfx02, ...), 리프 페이지 수, 샘플 크기
SELECT index_name, stat_name, stat_value, sample_size, last_update
FROM mysql.innodb_index_stats
WHERE database_name = 'shop' AND table_name = 'orders' AND index_name = 'idx_user';
-- idx_user(user_id)의 n_diff_pfx01 = user_id의 서로 다른 값 수 (추정)
-- n_diff_pfx02 = (user_id, id)의 서로 다른 값 수 — 세컨더리 인덱스는 PK를 품으므로 접두사가 하나 더 있다
```

`SHOW INDEX FROM orders`의 `Cardinality` 칸이 바로 이 `n_diff_pfx` 값이다. 옵티마이저는
여기서 **키 하나당 평균 행 수**를 만든다 — `rows_per_key = n_rows / n_diff`. 이
숫자가 쓰이는 곳이 핵심이다.

- **풀스캔 비용**: `n_rows`와 클러스터드 인덱스 페이지 수로 "전부 읽으면 얼마"를 계산한다.
- **`ref` 접근의 예상 행 수**: 조인에서 두 번째 테이블을 앞 테이블의 값으로
  찾을 때(값이 상수가 아니라 행마다 달라지므로 실측할 수 없다), `rows_per_key`가
  그대로 예상 행 수다. **조인 순서 결정의 핵심 입력**이다.
- **ORDER BY … LIMIT 휴리스틱**: "정렬 순서의 인덱스를 훑으면서 WHERE로 거르면
  몇 행 만에 LIMIT이 채워질까"를 계산할 때 WHERE 키의 `rows_per_key`를 쓴다(§2의
  사고가 정확히 이 지점에서 난다).
- **IN 리스트가 길 때**: 리스트 항목이 `eq_range_index_dive_limit`(기본 200)을 넘으면
  항목별 실측(dive)을 포기하고 통계로 추정한다.

### 1-2. 입력 ② 최적화 시점 샘플(index dive) — 통계와 다른 입력이다

`WHERE user_id = 42`처럼 **상수 조건**이 인덱스 컬럼에 걸리면 옵티마이저는 통계를
믿지 않고 **그 인덱스의 해당 범위에 실제로 들어가 대략 몇 행인지 세어본다.** 이것이
index dive다. 그래서 단일 테이블의 단순 등호·범위 조건은 통계가 낡아도 비교적
정확하다.

대신 dive는 **"지금 데이터"와 "지금 파라미터 값"에 즉시 반응**한다. `status =
'FAILED'`가 어제는 1%였는데 오늘 외부사 장애로 40%가 되면, dive가 그것을 바로
보고 계획을 바꾼다 — 통계 갱신과 무관하게. 이것이 §3의 원인 ③(분포 변화)과
④(파라미터 값)가 "통계 갱신 시각과 안 맞는데도 계획이 바뀌는" 이유다.

### 1-3. 입력 ③ 쿼리에 들어온 값 — MySQL은 매 실행 다시 최적화한다

MySQL은 실행할 때마다 실제 파라미터 값으로 다시 최적화한다. 한 번 세운 계획을
캐시해 재사용하는 방식이 아니다. 따라서 **같은 SQL이 값에 따라 다른 계획을
갖는 것은 정상 동작**이고, "갑자기 느려졌다"가 실은 "느린 값이 들어오기
시작했다"인 경우가 있다(주문 8건인 사용자와 40만 건인 대형 가맹점은 같은 SQL,
다른 최적 계획).

### 1-4. 입력 ④ 비용 상수와 스위치 — 함수의 계수

페이지를 디스크에서 읽는 비용, 메모리에서 읽는 비용, 행 하나를 평가하는 비용
같은 계수는 `mysql.server_cost`·`mysql.engine_cost`에 있고, 어떤 최적화 기법을
쓸지는 `optimizer_switch`가 정한다. DB 업그레이드는 이 계수와 스위치의 기본값을
바꾸고, 새 최적화 기법을 후보에 추가한다. 즉 **업그레이드는 함수 자체가 바뀌는
것**이라 입력이 그대로여도 출력이 달라질 수 있다.

**(가산점 포인트)** MySQL 8의 비용 모델은 스토리지 엔진이 알려주는 "이 인덱스가
버퍼 풀에 얼마나 올라와 있나" 추정치도 참고한다. 그래서 재시작·failover 직후처럼
버퍼 풀이 비어 있을 때와 예열된 뒤의 비용 계산이 다를 수 있다 — "재시작하고 나서
계획이 달라졌다"는 보고가 나오는 배경이다.

### 1-5. 이 모델이 주는 첫 번째 결론

> **"실행 계획이 바뀌었다"는 결과이지 원인이 아니다.** 진단은 "어느 입력이,
> 언제, 왜 바뀌었나"를 찾는 일이고, 대응은 "그 입력을 바로잡을 것인가(통계·
> 히스토그램), 후보를 줄여 흔들릴 여지를 없앨 것인가(인덱스 설계), 함수를
> 우회할 것인가(힌트)"의 선택이다. 이 문장을 첫 답변으로 말하면 면접관이
> 확인하려는 "정적인 계산기가 아니라 상태에 따라 판단이 바뀌는 시스템"이라는
> 이해가 첫머리에서 드러난다.

---

## 2. 사슬 — 새벽 배치 한 번이 계획을 뒤집는 과정, 숫자로

후보자의 최대 약점은 "통계가 바뀌어서 느려졌다"에서 멈추는 것이다. 그 사이의
**일곱 칸**을 채운다. 아래 숫자는 메커니즘을 보이기 위한 예시값이다.

**상황.** `orders` 1,000만 건. 인덱스는 `PRIMARY(id)`와 `idx_user(user_id)`. 사용자
100만 명, 1인당 평균 주문 10건. 주문 목록 API의 쿼리:

```sql
SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20;
```

옵티마이저 앞에 놓인 **후보는 둘**이다.

```text
계획 A: idx_user로 이 사용자의 행을 전부 찾는다(ref) → id로 정렬(filesort) → 20건
        비용 ∝ 이 사용자의 행 수 (랜덤 룩업 N번 + N건 정렬)

계획 B: PRIMARY를 뒤에서부터 훑으며(id DESC 순서 그대로) user_id로 거른다 → 20건 모이면 중단
        비용 ∝ 20 × (전체 행 수 / 이 사용자의 "예상" 행 수)   ← 이 사용자의 행이 얼마나 촘촘한지에 반비례
        여기서 "예상 행 수"의 입력이 idx_user 통계의 rows_per_key다 (§1-1)
```

**평소(베이스라인).** `n_diff(user_id)` 추정 100만 → `rows_per_key` = 1,000만 / 100만
= **10**. 계획 A는 랜덤 룩업 10번, 계획 B는 20 × (1,000만 / 10) = 2,000만 행, 즉
테이블 전체. A가 압도적으로 싸다. p95 20ms.

```text
id  select_type  table  type  key       key_len  rows  filtered  Extra
1   SIMPLE       o      ref   idx_user  8        10    100.00    Using filesort
```

**사고 당일의 일곱 칸.**

1. 새벽 2시, 대형 가맹점 20곳의 이관 배치가 `orders`에 **200만 건을 INSERT**했다
   (변경 행 비율 20% — 자동 재계산 임계 10%를 넘겼다).
2. `innodb_stats_auto_recalc`(기본 ON)에 따라 **InnoDB 백그라운드 스레드가 `orders`의
   통계를 재계산**했다. `mysql.innodb_table_stats.last_update` = 02:14. 배치가 끝난
   직후도, 누가 시킨 것도 아니다 — 임계를 넘긴 순간 비동기로 돌았다.
3. 재계산은 인덱스당 **20페이지만 샘플링**한다(`innodb_stats_persistent_sample_pages`
   기본 20). 그런데 방금 들어온 200만 건은 가맹점 20곳의 것이라, `idx_user` 리프
   페이지 기준으로 **한 페이지에 `user_id` 값이 하나뿐인 페이지**가 대량으로 생겼다.
   20개 샘플 중 상당수가 그런 페이지를 맞혔고, 페이지당 서로 다른 값 수를
   전체 리프 페이지 수로 외삽하는 방식이라 **`n_diff(user_id)` 추정이 100만에서
   800으로 붕괴**했다(예시값. 편차 폭은 20페이지가 어디를 맞히느냐에 달렸다 —
   그래서 재계산할 때마다 다른 값이 나온다).
4. 옵티마이저 입력이 바뀌었다: `rows_per_key` = 1,200만 / 800 = **15,000**. "사용자
   한 명당 주문 15,000건"으로 믿게 됐다.
5. 비용이 역전됐다. 계획 A: 랜덤 룩업 15,000번 + 15,000건 정렬. 계획 B: 20 ×
   (1,200만 / 15,000) = **16,000행을 PK 순서대로 훑으면 20건이 모인다** — 순차
   16,000이 랜덤 15,000 + 정렬보다 싸다고 계산됐다.
6. **계획이 B로 전환됐다.** `key`가 `idx_user`에서 `PRIMARY`로, `type`이 `ref`에서
   `index`로 바뀌었다.

   ```text
   id  select_type  table  type   key      key_len  rows   filtered  Extra
   1   SIMPLE       o      index  PRIMARY  8        16000  0.01      Using where; Backward index scan
   ```

7. 현실은 통계와 달랐다. 일반 사용자의 주문은 8건이다. 계획 B는 8건을 찾으려고
   **PK 1,200만 행을 거의 끝까지 훑는다.** `Rows_examined` 1,200만 / `Rows_sent` 8.
   p95 20ms → 4초, DB CPU 급등. 배포는 없었다. **실제로 바뀐 것은 데이터 200만 건,
   통계 1회, 계획 1회**다.

### 2-1. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

```text
❌ "통계가 갱신돼서 옵티마이저가 다른 인덱스를 타게 됐고, 그래서 느려졌습니다."
   → 왜 갱신됐는지, 갱신되면 무엇이 바뀌는지, 그게 왜 다른 인덱스로 이어지는지, 왜 그게 느린지가 전부 비어 있다.

✅ "대량 적재로 변경 행 비율이 임계(10%)를 넘어 백그라운드 통계 재계산이 돌았고
    → 20페이지 샘플이 편중돼 user_id 카디널리티 추정이 100만에서 수백으로 떨어졌고
    → 옵티마이저는 '키당 행 수'가 1만 배로 늘었다고 믿게 됐고
    → 그러면 'PK를 역순으로 조금만 훑어도 LIMIT이 채워진다'는 계획의 비용이
      'idx_user 룩업 + 정렬' 계획보다 싸게 계산돼 계획이 전환됐고
    → 실제로는 주문이 몇 건뿐인 사용자에게 PK 전체 스캔이 돼 examined/sent 비율이 100만 배로 뛰었습니다."
```

### 2-2. 이 사례가 가르치는 세 가지

첫째, **통계 재계산 자체는 정상 동작이다.** 문제는 "재계산"이 아니라 "재계산할
때마다 샘플이 다른 답을 낸다"는 **샘플링 오차**다. 그래서 대응이 "자동 재계산을
끄자"가 아니라 "샘플을 늘리거나 후보를 줄이자"로 간다(§4-3).

둘째, **옵티마이저는 "평균 사용자"를 가정한다.** `rows_per_key`는 평균이다. 평균
15,000건이라는 가정은 대형 가맹점에게는 맞고 일반 사용자에게는 틀린다. 분포가
편중(스큐)된 컬럼에서는 "옵티마이저가 옳은 값"과 "틀린 값"이 동시에 존재한다.

셋째, **후보가 둘이었기 때문에 뒤집힐 수 있었다.** `(user_id, id)` 복합 인덱스가
있었다면 "이 사용자의 행을 id 순서로 바로 읽는" 후보 하나가 WHERE와 ORDER BY를
동시에 만족해 정렬도 없고, 계획 B가 이길 수 있는 통계값이 존재하지 않는다.
**흔들릴 여지를 없애는 것이 근본 대응**이다(§4-3의 1번).

### 2-3. 두 후보의 비용을 나란히 보는 법 (가산점 포인트)

EXPLAIN은 "고른 것"만 보여준다. "무엇과 비교해서 골랐는지"는 옵티마이저
트레이스에 있다.

```sql
SET optimizer_trace = 'enabled=on';
EXPLAIN SELECT * FROM orders WHERE user_id = 42 ORDER BY id DESC LIMIT 20;
SELECT TRACE FROM information_schema.OPTIMIZER_TRACE;
SET optimizer_trace = 'enabled=off';
-- JSON 안의 considered_execution_plans / best_access_path / considered_access_paths 에
-- 후보마다 "cost"와 "chosen": true/false 가 나란히 찍힌다.
-- EXPLAIN FORMAT=JSON 의 cost_info.query_cost 도 "고른 계획의 총비용"을 준다.
```

"A가 15,300, B가 16,000으로 아슬아슬했다"가 보이면, 이 쿼리는 **다음 통계
재계산에서 또 뒤집힐 후보**라는 뜻이다. 베이스라인에 이 비용을 함께 남겨두면
(§5-1) "왜 뒤집혔나"가 아니라 "뒤집힐 뻔했다"를 미리 안다.

---

## 3. 원인 후보 8종 — 세 칸에서 꺼내는 암기 목록

§1의 세 질문(입력이 바뀌었나 / 후보가 바뀌었나 / 함수가 바뀌었나)에 걸어서
외운다. 표는 인출용이고 설명은 아래 본문에 있다.

| # | 원인 | 바뀐 칸 | 전형적 트리거 | 첫 확인 지점 |
|---|---|---|---|---|
| ① | 통계 자동 재계산 | 입력(통계) | 대량 적재·삭제 뒤 변경 행 비율 > 10% | `innodb_table_stats.last_update` |
| ② | 샘플링 오차 | 입력(통계) | ①이 돌 때마다 카디널리티가 달리 나옴 | `innodb_index_stats.n_diff` vs 실제 `COUNT(DISTINCT)` |
| ③ | 데이터 분포 변화 | 입력(샘플·통계) | 특정 값 급증(장애로 FAILED 40%, 대형 고객 유입) | `GROUP BY 값 COUNT(*)` 추이 |
| ④ | 파라미터 값 | 입력(값) | 스큐 값이 들어오기 시작, IN 리스트 길이 증가 | slow log의 실제 값으로 EXPLAIN |
| ⑤ | 인덱스 추가·삭제 | 후보 집합 | 남이 만든 유사 인덱스가 경쟁, 인덱스 정리 작업 | `information_schema.STATISTICS` diff, `sys.schema_redundant_indexes` |
| ⑥ | DB 업그레이드·패치 | 함수 | 마이너 자동 업그레이드(유지보수 창) | `SELECT VERSION()`, 인스턴스 이벤트 로그 |
| ⑦ | 파라미터 변경 | 함수(계수) | `optimizer_switch`, 메모리 한도, dive 한도 | 파라미터 그룹 변경 이력, `global_variables` 스냅샷 diff |
| ⑧ | 버퍼 풀 상태 (가산점) | 입력(적재 추정) | 재시작·failover 직후 | 인스턴스 재시작 시각과 대조 |

### 3-1. ① 통계 자동 재계산 — "누가 시킨 적 없는" 변경

테이블의 변경 행 비율이 마지막 재계산 이후 **10%를 넘으면** InnoDB가 백그라운드에서
비동기로 통계를 다시 뜬다. 배치가 끝난 시각과 정확히 일치하지도 않고(몇 초에서
그 이상 지연될 수 있다), 로그에 남지도 않는다. 그래서 "배포도 배치도 끝난 지
한참인데 갑자기"라는 인상을 준다. 확인은 `last_update`와 느려진 시각의 대조다.

### 3-2. ② 샘플링 오차 — 재계산이 "돌았다"가 아니라 "다르게 나왔다"가 문제

20페이지 샘플은 1,000만 건 테이블에서 리프 페이지의 0.1%도 안 된다. 값이 **뭉쳐서
저장되는 컬럼**(같은 사용자의 주문이 연속 INSERT, 같은 날짜의 데이터, 배치 이관분)
일수록 어느 페이지를 맞히느냐에 따라 추정이 크게 흔들린다. 증상은 **"아무것도
안 했는데 며칠에 한 번씩 계획이 왔다 갔다 한다"** 이다 — 통계가 흔들린다는 뜻이다.

```sql
-- 추정과 실제의 거리 재기 (COUNT(DISTINCT)는 레플리카에서)
SELECT stat_value AS estimated_n_diff, sample_size, last_update
FROM mysql.innodb_index_stats
WHERE database_name = 'shop' AND table_name = 'orders'
  AND index_name = 'idx_user' AND stat_name = 'n_diff_pfx01';
SELECT COUNT(DISTINCT user_id) AS actual_n_diff FROM orders;
-- 자릿수가 다르면 ② 확정. 며칠치 스냅샷(§5)이 있으면 "흔들리는 폭"까지 보인다.
```

### 3-3. ③ 데이터 분포 변화 — 옵티마이저가 "옳게" 바꾼 경우일 수 있다

`status = 'FAILED'`가 1%일 때는 인덱스가 정답이고 40%일 때는 풀스캔이 정답이다.
외부 PG사 장애로 실패 주문이 쏟아지면 dive가 그것을 보고 풀스캔으로 바꾼다.
이때 계획 전환은 **오판이 아니라 정확한 판단**이고, 느려진 것은 계획 탓이 아니라
**"실패 주문 전부를 읽어야 하는 쿼리"가 된 요구 자체** 때문이다. 구분법은
`EXPLAIN ANALYZE`의 추정 `rows`와 실측 — 둘이 가까우면 옵티마이저가 옳고, 대응은
힌트가 아니라 쿼리·요구(기간 조건 추가, 아카이빙, 인덱스 재설계)를 바꾸는 것이다.
"역전"의 손익분기 자체는 [인덱스를 걸었는데도 풀스캔](index-not-used-full-scan.md)
§4-3에 있다.

### 3-4. ④ 파라미터 값 — 같은 SQL, 다른 최적 계획

§1-3대로 MySQL은 값마다 다시 최적화한다. "갑자기"의 정체가 **대형 가맹점 계정이
그 API를 쓰기 시작한 날**인 경우다. 두 가지 특수형을 같이 외운다.

- **IN 리스트 길이**: 항목이 `eq_range_index_dive_limit`(기본 200)을 넘으면
  항목별 dive를 포기하고 통계 추정으로 바뀌고, 범위 조건 분석에 필요한 메모리가
  `range_optimizer_max_mem_size`(기본 8MB)를 넘으면 **범위 최적화 자체를 포기하고
  풀스캔**한다(경고 "Range optimization was not done for this query"). 프론트가
  선택 항목 수 제한을 풀었거나 배치가 청크 크기를 키운 날 터진다.
- **(가산점 포인트) PostgreSQL의 generic plan**: PG는 프리페어드 문을 다섯 번
  실행한 뒤 "값과 무관한 일반 계획"이 평균 비용보다 나쁘지 않으면 그쪽으로 고정한다.
  "여섯 번째 실행부터 느려진다"는 고전이 이것이고, `plan_cache_mode`로 제어한다.
  MySQL에는 이 함정이 없는 대신 "값마다 계획이 다르다"는 다른 얼굴로 온다.

### 3-5. ⑤ 인덱스 추가·삭제 — 후보 집합이 바뀜

옆 팀이 리포트 쿼리를 위해 `idx_created_status(created_at, status)`를 추가했더니
내 쿼리의 옵티마이저가 그쪽을 "일단 타볼까"로 고르는 경우. 인덱스는 **추가만으로
다른 쿼리의 계획을 바꿀 수 있다**([실행 계획 읽기](explain-and-slow-query-process.md)
꼬리질문 3의 "옵티마이저 오유인"). 반대로 "안 쓰는 것 같아서" 지운 인덱스가
사실 특정 파라미터 값에서만 쓰이던 것이라, 그 값이 들어올 때 무너지는 경우도 있다.

```sql
-- 인덱스 목록의 어제-오늘 diff (베이스라인 스냅샷과 비교)
SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, IS_VISIBLE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = 'shop' AND TABLE_NAME = 'orders'
GROUP BY INDEX_NAME, IS_VISIBLE;
-- 중복·경쟁 인덱스 찾기
SELECT * FROM sys.schema_redundant_indexes WHERE table_name = 'orders';
```

### 3-6. ⑥ DB 업그레이드·패치 — 함수가 바뀜

관리형 DB의 **마이너 버전 자동 업그레이드**는 유지보수 창에 조용히 적용된다.
마이너라도 비용 계수, `optimizer_switch` 기본값, 새 최적화(예: 해시 조인 도입,
정렬 인덱스 선호 규칙)가 바뀔 수 있고, 그러면 같은 통계·같은 SQL에서 다른 계획이
나온다. 확인은 `SELECT VERSION()`과 인스턴스 이벤트 로그의 시각 대조다. 업그레이드
전에 잡는 방법은 꼬리질문 5에.

### 3-7. ⑦ 파라미터 변경 — 함수의 계수가 바뀜

`optimizer_switch`, `sort_buffer_size`·`join_buffer_size`·`tmp_table_size` 같은 메모리
한도, `eq_range_index_dive_limit`, `innodb_stats_persistent_sample_pages`. 누군가
"다른 문제를 고치려고" 파라미터 그룹을 만졌고 그 영향이 내 쿼리에 왔다. 파라미터
그룹 변경 이력과 `performance_schema.global_variables`의 정기 스냅샷 diff로 잡는다.

### 3-8. 계획은 안 바뀌었는데 그렇게 보이는 것들 — 이 문서 밖

락 대기, 배치 직후 버퍼 풀 오염(같은 계획인데 디스크에서 읽음), 정렬·임시
테이블의 디스크 spill(데이터가 커져 메모리 한도를 넘음), N+1 호출 수 증가. 이것들은
**같은 계획, 다른 실행 비용**이다. 진단 2단계(§4-1)의 "건당 examined 행"이 안
뛰었다면 계획 변경이 아니므로 이 문서를 덮고 ["변경 없음 검증" 문서](./db-cpu-spike-without-deployment.md)의 넓은 탐색으로
돌아간다.

---

## 4. 대응 사다리 — 진단 → 즉시 완화 → 근본 대응

순서가 있는 이유: 진단 없이 완화하면 무엇을 되돌려야 할지 모르고, 완화 없이
근본 대응만 하면 장애 시간이 길어지고, 근본 대응 없이 완화만 하면 다음 재계산에
또 뒤집힌다.

### 4-1. 진단 5단계 — 순서 고정

**1단계. 느려진 시각을 특정한다.** APM에서 해당 엔드포인트 p95가 꺾인 분 단위
시각, slow log에 그 쿼리가 **처음 등장한** 시각, digest 테이블의 `LAST_SEEN`·
`FIRST_SEEN`. 그 시각 위에 배포·배치·유지보수 창·파라미터 변경·인덱스 DDL의
타임라인을 겹친다. "갑자기"는 대개 이 겹치기에서 이미 반쯤 풀린다.

**2단계. 그 시각 전후의 digest를 비교해 "계획이 바뀐 게 맞는지"부터 확정한다.**
계획 변경의 지문은 **건당 examined 행은 뛰는데 건당 sent 행은 그대로**라는 것이다
— 같은 결과를 내기 위해 훨씬 많이 읽고 있다는 뜻이다.

```sql
SELECT LEFT(DIGEST_TEXT, 80)                          AS q,
       COUNT_STAR                                     AS calls,
       ROUND(SUM_TIMER_WAIT / 1e12 / COUNT_STAR, 4)   AS avg_sec,       -- TIMER는 피코초
       ROUND(SUM_ROWS_EXAMINED / COUNT_STAR)          AS examined_per_call,
       ROUND(SUM_ROWS_SENT / COUNT_STAR)              AS sent_per_call,
       SUM_NO_GOOD_INDEX_USED, SUM_SORT_ROWS, SUM_CREATED_TMP_DISK_TABLES,
       FIRST_SEEN, LAST_SEEN
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME = 'shop' AND DIGEST_TEXT LIKE '%FROM `orders`%'
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 10;
```

이 테이블은 **서버 기동 이후 누적**이라 "어제 대비"를 보려면 스냅샷이 있어야
한다(§5-2). 스냅샷이 없으면 slow log의 `Rows_examined`/`Rows_sent` 칸을 시각별로
본다. examined/sent 비율이 자릿수 단위로 뛰었으면 계획 변경(또는 원인 ③의 분포
급변)이고, 안 뛰었으면 §3-8이다.

**3단계. EXPLAIN 현재 vs 베이스라인을 diff한다.** 베이스라인(§5-1)이 있으면
`key`·`type`·`used_key_parts`·`rows`의 diff가 바로 나온다. 없으면 코드 리뷰 때
PR에 붙였던 EXPLAIN, 또는 스테이징(단, 통계가 다르므로 "평소 계획"의 참고용)을
쓴다. **EXPLAIN에 넣는 값은 slow log에 찍힌 실제 느린 값**이어야 한다 — digest
테이블의 `QUERY_SAMPLE_TEXT`가 샘플을 준다. 두 계획의 비용을 나란히 보고 싶으면
§2-3의 트레이스.

**4단계. 통계 갱신 시각과 값을 확인한다.**

```sql
SELECT last_update, n_rows FROM mysql.innodb_table_stats
WHERE database_name = 'shop' AND table_name = 'orders';
-- last_update가 1단계의 시각 직전이면 원인 ①. 이어서 ②인지 본다:
SELECT index_name, stat_name, stat_value, sample_size
FROM mysql.innodb_index_stats
WHERE database_name = 'shop' AND table_name = 'orders' AND stat_name LIKE 'n_diff%';
-- 레플리카에서 실제 COUNT(DISTINCT ...)와 대조 → 자릿수가 다르면 ②
```

**5단계. 데이터 분포와 "후보·함수" 변경을 확인한다.** 값별 건수(`GROUP BY status`),
파라미터 값별 건수(그 대형 가맹점의 주문 수), 히스토그램 유무
(`information_schema.COLUMN_STATISTICS`), 인덱스 목록 diff(§3-5), 버전(§3-6),
파라미터 diff(§3-7). 5단계까지 오면 원인은 표의 8종 중 하나로 특정된다.

```text
증상 → 원인 빠른 매핑
- last_update가 느려진 시각 직전 + n_diff가 실제와 자릿수 차이      → ① + ②
- last_update는 오래됐는데 EXPLAIN ANALYZE 추정≈실측, 값별 건수가 급변  → ③ (옵티마이저가 옳다)
- 특정 값에서만 느림, 그 값의 건수가 큼 / IN 리스트가 길어짐          → ④
- 인덱스 목록 diff에 새 항목, 새 계획의 key가 그것                   → ⑤
- VERSION()이 바뀜 / 파라미터 그룹 변경 이력                         → ⑥ / ⑦
- 인스턴스 재시작 직후, 시간이 지나며 스스로 회복                     → ⑧
```

### 4-2. 즉시 완화 — 카드 4장, 각각 대가와 함께

장애 중이라면 근본 대응(DDL·배포)을 기다릴 수 없다. 카드는 **원인에 맞춰** 뽑고,
뽑을 때 대가를 같이 말한다(약점 ②).

**카드 1. `ANALYZE TABLE` — 원인 ①②(통계가 낡았거나 흔들림)일 때, 가장 싼 첫 수.**

```sql
ANALYZE TABLE orders;      -- 수 초. 영속 통계를 즉시 다시 뜬다
```

얻는 것: 코드 변경·배포 없이 통계를 지금 데이터에 맞춘다. 내는 것 두 가지 —
⑴ **flush 대기**: ANALYZE는 테이블 정의 캐시를 비우므로, 그 테이블을 오래 잡고
있는 쿼리·트랜잭션이 있으면 **뒤이어 들어오는 쿼리들이 그것이 끝날 때까지
줄을 선다.** ANALYZE 자체는 금방 끝나서 원인을 못 알아채기 쉽다. 실행 전
`SHOW PROCESSLIST`로 장기 실행 쿼리를 확인하고, 세션의 `lock_wait_timeout`을 짧게
잡는다. ⑵ **복제 전파**: 기본으로 바이너리 로그에 기록돼 레플리카도 같이 돈다.
레플리카에서 동시에 flush 대기가 나는 게 싫으면 `ANALYZE NO_WRITE_TO_BINLOG TABLE`
— 대신 레플리카 통계는 자동 재계산에 맡기는 셈이다. 그리고 원인이 ②(샘플링
오차)라면 **이번엔 좋은 샘플이 잡혀도 다음 재계산에 또 흔들린다** — 같은 테이블에서
ANALYZE를 두 번째 하고 있다면 카드가 아니라 §4-3의 3번으로 가야 한다는 신호다.

**카드 2. 힌트 — "지혈대". 원인이 무엇이든 그 쿼리 하나를 당장 살려야 할 때.**

```sql
-- ❌ 흔한 모습: 이유도 기한도 없이 물리 인덱스 이름이 코드에 박힌다. 3년 뒤 아무도 못 지운다
SELECT * FROM orders FORCE INDEX (idx_user)
WHERE user_id = ? ORDER BY id DESC LIMIT 20;

-- ✅ 옵티마이저 힌트 + 이유·이슈·만료일. 인덱스가 사라지면 FORCE INDEX는 에러로 쿼리가 죽지만
--    옵티마이저 힌트는 경고만 내고 쿼리는 산다
SELECT /*+ INDEX(o idx_user) */ *
       -- PLAN-PIN: 2026-08-31 통계 재계산 후 PK 역순 스캔으로 전환(ISSUE-1234).
       --           복합 인덱스 (user_id, id) 배포 후 제거. 만료 2026-09-14
FROM orders o
WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 20;

-- 특정 최적화 규칙만 이 문장에서 끄는 방법 (ORDER BY … LIMIT 정렬 인덱스 선호 규칙이 문제일 때)
SELECT /*+ SET_VAR(optimizer_switch = 'prefer_ordering_index=off') */ *
FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 20;
```

얻는 것: 즉시, 확실히, 그 쿼리만. 내는 것 네 가지 — ⑴ **데이터가 바뀌어도 계획이
못 따라간다**: 오늘 옳은 인덱스가 분포가 바뀐 내년에는 틀린 인덱스가 되는데, 힌트는
그 판단 기능을 꺼버린 것이다. ⑵ **코드에 물리 정보가 결합된다**: 인덱스 이름
변경·삭제가 애플리케이션 변경이 된다(`FORCE INDEX`는 없는 인덱스를 지정하면 그
자리에서 에러다). ⑶ **업그레이드의 혜택에서 그 쿼리만 제외된다**: 옵티마이저가
좋아져도 우리 쿼리는 과거에 묶인다. ⑷ **원인을 덮는다**: 힌트로 증상이 사라지면
통계·인덱스 설계의 진짜 문제는 남고, 같은 원인이 다른 쿼리에서 재발한다. 그래서
힌트는 **이슈 번호와 만료일이 붙은 지혈대**이고, 만료를 사람이 기억하지 않도록
§5-5의 린트가 지킨다. rationale이 말한 "힌트로 고정하는 것의 트레이드오프까지
가면 상급"이 정확히 이 네 줄이다.

**카드 3. `INVISIBLE` — 원인 ⑤(새 인덱스가 경쟁)일 때.**

```sql
ALTER TABLE orders ALTER INDEX idx_created_status INVISIBLE;   -- 메타데이터만 변경, 즉시, 가역
-- 정말 그 인덱스 탓인지 내 세션에서만 다시 켜서 확인
SET SESSION optimizer_switch = 'use_invisible_indexes=on';
```

얻는 것: DROP 없이 옵티마이저의 후보에서만 빼므로, 잘못 판단했으면 한 줄로 되돌린다.
내는 것: 인덱스 유지(쓰기·저장) 비용은 그대로 든다 — 그러니 결정이 나면 DROP까지
간다. 이 카드는 거꾸로 **"인덱스를 지우기 전 일주일은 INVISIBLE로 둔다"** 는
안전 규칙으로도 쓴다(원인 ⑤의 반대편 예방).

**카드 4. 원복 — 원인 ⑥⑦일 때.** 파라미터 그룹을 이전 값으로 되돌리거나, 업그레이드로
바뀐 `optimizer_switch` 항목을 이전 기본값으로 명시한다. 얻는 것: 원인이 확실하면
가장 정확한 완화. 내는 것: 업그레이드 롤백은 대개 불가능하므로 스위치 원복은
"전역"이 되고, 그 스위치 덕을 보던 다른 쿼리가 있으면 그쪽이 느려진다 — 전역 대신
카드 2의 `SET_VAR`로 문장 단위로 좁히는 게 먼저다.

### 4-3. 근본 대응 — 흔들릴 여지를 없앤다

**1. 복합 인덱스로 후보를 하나로 만든다 — 최우선.** §2의 쿼리에 `(user_id, id)`를
두면 "이 사용자의 행을 id 순서로 읽는다"는 후보 하나가 WHERE·ORDER BY·LIMIT을
전부 만족하고 정렬이 사라진다. 계획 B가 이길 수 있는 통계값이 존재하지 않으므로
**통계가 어떻게 흔들려도 계획이 안 흔들린다.** 순서 원칙(등호 → 범위 → 정렬 →
커버링)은 [복합 인덱스 컬럼 순서](composite-index-column-order.md) §2, 읽기를
인덱스 안에서 끝내는 확장은 [커버링 인덱스](covering-index.md). 내는 것: 인덱스
하나만큼의 쓰기·메모리 비용, 대형 테이블 DDL의 절차 비용([무중단 DDL](online-ddl-zero-downtime-schema-change.md)),
그리고 기존 `idx_user`가 새 인덱스의 접두사라 중복이 되므로 INVISIBLE → DROP의
정리 절차.

**2. 히스토그램 — 원인 ③(편중 분포)이 인덱스 없는 컬럼이나 조인 순서에 걸릴 때.**

```sql
ANALYZE TABLE orders UPDATE HISTOGRAM ON status WITH 16 BUCKETS;
SELECT COLUMN_NAME, JSON_PRETTY(HISTOGRAM)
FROM information_schema.COLUMN_STATISTICS WHERE TABLE_NAME = 'orders';
```

기본 통계는 "서로 다른 값이 몇 개"만 알고 "어느 값이 몇 %"는 모른다. 히스토그램은
그 분포를 알려줘 `filtered` 추정과 조인 순서를 바로잡는다. 내는 것: **자동으로
갱신되지 않는다** — 통계가 낡는 문제를 한 층 위에서 다시 만드는 셈이라 갱신을
잡으로 고정해야 한다(뒤에 자동 재계산에 편승하는 옵션이 추가됐지만 기본은
수동이다). 그리고 인덱스가 있는 컬럼의 상수 조건은 어차피 dive가 더 정확해서
히스토그램이 쓰이지 않는다 — 만능이 아니다.

**3. 샘플 페이지 상향과 재계산 정책 — 원인 ②(샘플링 오차)가 반복될 때.**

```sql
ALTER TABLE orders STATS_SAMPLE_PAGES = 256;   -- 이 테이블만. 메타데이터 변경이라 즉시
ANALYZE TABLE orders;                          -- 새 설정으로 바로 재수집
```

얻는 것: 추정의 흔들림 폭이 준다. 내는 것: ANALYZE와 자동 재계산이 그만큼 페이지를
더 읽는다(초대형 테이블이면 재계산이 부하가 된다). 대안으로 `STATS_AUTO_RECALC = 0`
+ 예약 ANALYZE(트래픽 낮은 시각)도 있다 — 얻는 것은 "재계산 시각을 내가 정한다",
내는 것은 "그 사이 통계가 낡아도 아무도 안 고쳐준다"는 책임. 매일 TRUNCATE 후
재적재하는 테이블처럼 행 수가 요동치는 곳에 어울리고, 일반 테이블에는 과하다.

**4. 스큐 파라미터의 경로 분리 — 원인 ④.** 대형 가맹점만 다른 쿼리(커서 기반,
기간 조건 강제, 별도 집계 테이블)를 타게 한다. 얻는 것: 평균 가정의 함정에서 그
값만 꺼낸다. 내는 것: 코드 경로가 둘이 되고 "누가 대형인가"의 기준을 유지해야 한다.

**5. 업그레이드 리허설 — 원인 ⑥.** 꼬리질문 5.

| 대응 | 얻는 것 | 내는 것 | 언제 |
|---|---|---|---|
| 복합 인덱스로 후보 단일화 | 통계와 무관하게 안정 | 쓰기·DDL 절차·인덱스 정리 | 거의 항상 1순위 |
| 히스토그램 | 편중 분포 반영 | 수동 갱신, 인덱스 컬럼엔 무효 | 비인덱스 조건·조인 순서 오판 |
| 샘플 페이지 상향 | 추정 안정 | 재계산 I/O | 같은 테이블 ANALYZE 2회째 |
| 자동 재계산 OFF + 예약 | 시각 통제 | 낡음의 책임 | 행 수 요동 테이블 |
| 힌트 | 즉시·확실 | 추종 불가·결합·업그레이드 제외·원인 은폐 | 지혈대, 만료일 필수 |

---

## 5. 고정 — 안전망을 사람의 기억 밖으로

후보자는 3장에서 "사람의 기억에 의존하지 않는 방법"을 명시해 물었는데도 TODO
주석으로 답한 것을 포함해 안전망을 코드로 고정하는 습관의 부재가 반복됐다. 이
주제는 특히 그렇다 — **계획 변경은 배포 없이 일어나므로 배포 파이프라인이 못
잡는다.** 잡는 것은 정기 잡과 알람뿐이다. 다섯 종을 층으로 둔다.

### 5-1. EXPLAIN 베이스라인 잡 — 운영 통계로, 정기적으로, diff

[실행 계획 읽기](explain-and-slow-query-process.md) §4-4의 "EXPLAIN 단정 테스트"는
CI에서 **시드 데이터**로 돌아 **코드 변경**이 만드는 회귀를 잡는다. 이 문서의 원인은
데이터·통계가 만드는 회귀라 그것으로는 안 잡힌다. 그래서 한 층이 더 필요하다 —
**운영 레플리카에서, 운영 통계로, 매일 뜨는 베이스라인.**

```bash
#!/usr/bin/env bash
# explain-baseline.sh — 핵심 쿼리의 실행 계획을 운영 레플리카에서 뜨고 git에 커밋된 베이스라인과 비교
set -euo pipefail
BASE=db/explain-baseline                       # 커밋된 JSON (쿼리당 1개)
WORK=$(mktemp -d)
changed=0
for q in db/critical-queries/*.sql; do         # 파일 1개 = 쿼리 1개. 파라미터는 "대표값"과 "최악값" 두 벌
  name=$(basename "$q" .sql)
  mysql -h "$REPLICA_HOST" -N -e "EXPLAIN FORMAT=JSON $(cat "$q")" \
    | jq -S '[.. | objects | select(has("table")) | .table
              | {table: .table_name, type: .access_type, key: .key, parts: .used_key_parts}]' \
    > "$WORK/$name.json"
  if ! diff -q "$BASE/$name.json" "$WORK/$name.json" > /dev/null; then
    echo "PLAN CHANGED: $name"; diff "$BASE/$name.json" "$WORK/$name.json" || true
    changed=1
  fi
done
exit $changed        # 0이 아니면 알람 채널로. 승인된 변경이면 베이스라인 JSON을 PR로 갱신
```

`key`·`type`·`used_key_parts`는 엄격 비교하고, `rows_examined_per_scan`과
`query_cost`는 따로 기록해 "3배 이상 변동"을 경고로 둔다(통계 재계산만으로도
조금씩 움직이므로 엄격 비교하면 소음이 된다). **이 잡이 하는 일은 "느려지기
전에" 계획 전환을 알리는 것**이다 — 새벽 2시 통계 재계산 뒤 6시 잡이 diff를 내면
출근 전에 안다. MySQL에는 Oracle의 SQL Plan Baseline이나 SQL Server Query Store의
계획 고정 기능이 없으므로, 이 "우리가 기록한 베이스라인"이 그 역할을 대신한다.

### 5-2. digest 스냅샷과 비율 알람 — "건당 examined"의 급변을 기계가 본다

```sql
CREATE TABLE ops.digest_snapshot (
  snapshot_at        DATETIME     NOT NULL,
  digest             VARCHAR(64)  NOT NULL,
  digest_text        LONGTEXT,
  count_star         BIGINT, sum_timer_wait BIGINT,
  sum_rows_examined  BIGINT, sum_rows_sent  BIGINT,
  PRIMARY KEY (snapshot_at, digest)
);

-- 매시 (이벤트 스케줄러 또는 외부 크론)
INSERT INTO ops.digest_snapshot
SELECT NOW(), DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT
FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST IS NOT NULL;

-- 최근 1시간 구간의 "건당 examined"가 7일 중앙값의 5배를 넘는 digest → 알람
SELECT cur.digest, LEFT(cur.digest_text, 80) AS q,
       (cur.sum_rows_examined - prev.sum_rows_examined) / NULLIF(cur.count_star - prev.count_star, 0) AS examined_per_call_now
FROM ops.digest_snapshot cur
JOIN ops.digest_snapshot prev
  ON prev.digest = cur.digest AND prev.snapshot_at = cur.snapshot_at - INTERVAL 1 HOUR
WHERE cur.snapshot_at = (SELECT MAX(snapshot_at) FROM ops.digest_snapshot)
  AND cur.count_star > prev.count_star;
-- (7일 중앙값과의 비교는 같은 테이블에서 윈도우 집계로 붙인다)
```

mysqld_exporter의 perf_schema 수집기 + Prometheus로 같은 것을 만들면 알람 규칙이
YAML 파일이 된다. 어느 쪽이든 **"이 digest의 건당 examined 행이 갑자기 100배"라는
알람은 계획 변경의 가장 이른 신호**이고, 사람이 slow log를 열어보기 전에 온다.

### 5-3. 슬로 로그의 "신규 digest 등장" 알람

계획이 뒤집힌 쿼리는 어제까지 slow log에 없다가 오늘 처음 나타난다. `long_query_time`
임계와 "분당 건수" 알람([실행 계획 읽기](explain-and-slow-query-process.md) §4-4
층 1)에 더해, **pt-query-digest 일일 리포트에서 어제 리포트에 없던 digest**를
따로 표시한다. 총량 알람은 다른 쿼리들 사이에 묻히지만 "신규 등장"은 안 묻힌다.

### 5-4. 배치의 마지막 단계를 `ANALYZE TABLE`로 코드화

§2의 사고는 "배치가 끝나고 백그라운드가 알아서" 재계산한 데서 났다. 대량 적재
배치가 **스스로 통계를 갱신하고 끝나면** 재계산 시각이 배치 시각으로 고정되고,
샘플 오차가 있더라도 배치 직후 베이스라인 잡(§5-1)이 그것을 본다.

```java
// ❌ before: 런북 "이관 배치 뒤에는 DBA에게 ANALYZE 요청" — 새벽 배치가 끝난 뒤 통계는
//    백그라운드 재계산에 맡겨진다. 언제, 어떤 샘플로 될지 아무도 모르고, 런북은 아무도 안 읽는다.

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
    return new StepBuilder("analyzeOrdersStep", repo)
            .tasklet((contribution, ctx) -> {
                // ANALYZE는 암묵적 커밋을 유발하므로 이 Step에는 다른 쓰기를 섞지 않는다.
                // 복제 전파 여부는 판단: 전파하면 레플리카도 동시에 flush 대기 위험,
                // 안 하면 레플리카는 자동 재계산에 의존 — 여기서는 전파하지 않는다.
                jdbc.execute("ANALYZE NO_WRITE_TO_BINLOG TABLE orders");
                return RepeatStatus.FINISHED;
            }, tm)
            .build();
}
```

적용 기준을 규칙으로 적어둔다: **"한 번에 테이블 행 수의 수 % 이상을 넣거나
지우는 잡은 마지막 Step이 ANALYZE다."** 이것은 PR 템플릿의 체크 항목이 된다.

### 5-5. 힌트 레지스트리 린트 — 지혈대의 만료를 기계가 본다

카드 2의 "만료일"은 사람이 기억하면 안 지켜진다.

```bash
# ci/lint-plan-pins.sh — 힌트가 있는 줄 근처에 PLAN-PIN(이슈·만료일)이 없으면 실패, 만료됐으면 실패
status=0
while IFS=: read -r file line _; do
  ctx=$(sed -n "$((line > 3 ? line - 3 : 1)),$((line + 3))p" "$file")
  expiry=$(grep -oE "PLAN-PIN:.*만료 ([0-9]{4}-[0-9]{2}-[0-9]{2})" <<< "$ctx" | grep -oE "[0-9]{4}-[0-9]{2}-[0-9]{2}$" || true)
  if [ -z "$expiry" ]; then
    echo "$file:$line 힌트에 PLAN-PIN(이슈·만료일)이 없다"; status=1
  elif [[ "$expiry" < "$(date +%F)" ]]; then
    echo "$file:$line PLAN-PIN 만료($expiry) — 근본 대응 배포 후 제거하거나 재검토해 기한을 연장"; status=1
  fi
done < <(grep -rnE "FORCE INDEX|USE INDEX|IGNORE INDEX|/\*\+ *(INDEX|NO_INDEX|JOIN_ORDER|SET_VAR)" src/ || true)
exit $status
```

이 다섯 층이 있으면 이 문서의 사고는 이렇게 흘러간다 — 새벽 2시 배치가 끝나며
스스로 ANALYZE(5-4) → 6시 베이스라인 잡이 `key: idx_user → PRIMARY` diff를 알림(5-1)
→ 출근한 담당자가 힌트를 PLAN-PIN과 함께 배포(4-2 카드 2) → 복합 인덱스 DDL을
온라인으로 진행(4-3) → 2주 뒤 린트가 만료를 알려 힌트 제거(5-5). 사용자는 느려진
것을 모른다.

---

## 6. 꼬리질문 대비 포인트

### "힌트로 고정하면 끝 아닌가요? 왜 최후 수단이라고 하죠?" (시니어 변별 포인트)

**힌트는 문제를 푸는 게 아니라 옵티마이저의 판단 기능을 끄는 것이다.** 옵티마이저가
오늘 틀렸다고 해서 내년에도 틀리리라는 보장이 없고, 힌트는 "오늘의 정답"을 영구
고정한다. 대가 네 가지를 한 호흡에 — ⑴ 분포가 바뀌어도 계획이 못 따라간다,
⑵ 인덱스 이름이라는 물리 정보가 코드에 결합돼 인덱스 변경이 애플리케이션 변경이
되고 `FORCE INDEX`는 인덱스가 사라지면 그 자리에서 에러다, ⑶ 업그레이드로
옵티마이저가 좋아져도 그 쿼리만 과거에 묶인다, ⑷ 증상을 덮어 통계·인덱스 설계의
진짜 원인이 다른 쿼리에서 재발한다. 그래서 순서는 통계 갱신(입력 교정) → 인덱스
설계로 후보 단일화(흔들릴 여지 제거) → 그래도 안 되면 힌트, 이고 힌트를 쓴다면
**이슈 번호·이유·만료일을 붙이고 린트가 만료를 잡게** 한다. "장애 중이라면 힌트를
먼저 넣고 나중에 정리하겠다"는 답도 맞다 — 단, "나중"을 기계가 기억하게 하는
장치까지 말해야 상급이다.

### "옵티마이저가 '틀린' 게 아니라 '맞게' 바꾼 경우는 어떻게 구분하나요?"

**`EXPLAIN ANALYZE`로 추정과 실측의 거리를 잰다.** 새 계획의 추정 `rows`와 actual
rows가 가까우면 옵티마이저는 지금 데이터를 정확히 보고 있고, 계획 전환은 옳다 —
예를 들어 `status = 'FAILED'`가 1%에서 40%가 된 뒤의 풀스캔은 정답이다. 이때 느린
것은 계획 탓이 아니라 **"실패 주문 전부를 읽는 쿼리"가 된 요구** 탓이므로 대응은
힌트가 아니라 쿼리·요구의 변경(기간 조건 강제, 아카이빙, 상태별 파티션이나 별도
집계)이다. 반대로 추정과 실측이 자릿수 단위로 어긋나면 입력(통계·샘플)이 틀린
것이고, 그때는 `ANALYZE TABLE`·샘플 페이지·히스토그램이 순서다. "옵티마이저가
이상하다"는 말은 이 측정을 하기 전에는 할 수 없다.

### "통계 자동 재계산을 꺼버리면 안정적이지 않나요?"

**안정은 얻지만 낡음의 책임을 전부 떠안는다.** `STATS_AUTO_RECALC = 0`으로 두면
계획은 내가 ANALYZE할 때만 바뀐다 — 재계산 시각을 통제할 수 있고 샘플 오차로
며칠에 한 번 흔들리는 일도 없다. 대가는 데이터가 10배로 자라도 통계는 그대로라는
것이고, 그러면 "낡은 통계로 인한 오판"이 이번엔 영구화된다. 그래서 끌 때는 반드시
예약 ANALYZE 잡과 짝이어야 하고, 어울리는 곳은 매일 TRUNCATE 후 재적재하는
테이블처럼 행 수가 요동쳐 자동 재계산이 오히려 해로운 곳이다. 일반 테이블에는
끄는 것보다 **샘플 페이지를 올려 재계산의 품질을 높이는 쪽**이 맞다 — "재계산이
문제"가 아니라 "재계산의 표본이 문제"이기 때문이다.

### "같은 쿼리인데 특정 파라미터에서만 느립니다. 계획이 '바뀐' 건가요?"

**MySQL은 실행마다 실제 값으로 다시 최적화하므로 값마다 계획이 다른 것은 바뀐
게 아니라 원래 그렇다.** 주문 8건인 사용자와 40만 건인 대형 가맹점은 같은 SQL이지만
최적 계획이 다르고, 옵티마이저는 각각에 맞게 고른다 — 문제는 통계의 "평균"이 어느
한쪽에는 틀리다는 점과, 그 값에서만 나쁜 계획(정렬 인덱스 선호 규칙 등)이 튀어나오는
점이다. 대응은 ⑴ WHERE·ORDER BY를 동시에 만족하는 복합 인덱스로 값과 무관하게
후보를 하나로 만들고, ⑵ 그래도 대형 값이 무거우면 그 경로를 분리(커서 기반, 기간
강제)한다. **(가산점 포인트)** PostgreSQL은 반대 방향의 함정이 있다 — 프리페어드
문을 다섯 번 실행한 뒤 값과 무관한 generic plan으로 고정할 수 있어 "여섯 번째부터
느려진다"가 나오고, `plan_cache_mode`로 제어한다. 어느 DB든 "값에 따라 최적 계획이
다르다"는 스큐의 문제는 인덱스 설계로 푸는 것이 정석이다.

### "DB 업그레이드 전에 실행 계획 변경을 어떻게 미리 잡나요?" (시니어 변별 포인트)

**"업그레이드는 함수가 바뀌는 것"이므로 같은 입력으로 새 함수를 미리 돌려본다.**
절차는 ⑴ digest 상위 N개(시간 합 기준)와 핵심 쿼리 목록을 뽑고, ⑵ 운영 스냅샷으로
만든 스테이징을 새 버전으로 올린 뒤 `ANALYZE`로 통계를 맞추고, ⑶ 두 버전의
`EXPLAIN FORMAT=JSON`을 §5-1의 스크립트로 diff해 `key`·`type`이 바뀐 쿼리를 추리고,
⑷ 바뀐 것은 `EXPLAIN ANALYZE`로 실측해 좋아진 것과 나빠진 것을 나눈다. 나빠진
쿼리는 업그레이드 전에 인덱스를 손보거나, 임시로 `SET_VAR` 힌트나 이전
`optimizer_switch` 값을 브리지로 두고 업그레이드 뒤 하나씩 푼다. 관리형 DB라면
마이너 자동 업그레이드를 끄고 유지보수 창을 내가 정하는 것이 이 절차의 전제다.
한 호흡으로 — "업그레이드의 이득(새 최적화·보안 패치)을 받되, 상위 digest의 계획
diff로 손해 볼 쿼리를 미리 특정하고, 그 쿼리에만 국소 브리지를 걸어 리스크를
문장 단위로 좁힌다."

---

## 한 줄 요약

**옵티마이저는 통계·샘플·파라미터 값·비용 상수를 입력받아 후보 계획의 비용을
비교하는 함수라서, 코드도 쿼리도 안 바꿨는데 계획이 바뀌었다면 입력이 바뀌었거나
(통계 자동 재계산·샘플링 오차·분포 변화·들어오는 값), 후보가 바뀌었거나(인덱스
추가·삭제), 함수가 바뀐 것(업그레이드·파라미터)이다. 진단은 느려진 시각 → digest의
건당 examined 행 비교 → EXPLAIN 베이스라인 diff → 통계 `last_update` → 분포 확인의
순서로, 완화는 `ANALYZE TABLE`·만료일 붙인 힌트·`INVISIBLE`로, 근본 대응은 복합
인덱스로 후보를 하나로 만들어 흔들릴 여지를 없애는 것이며, 배포 없이 일어나는
변경이므로 EXPLAIN 베이스라인 잡·digest 스냅샷 알람·배치 끝 `ANALYZE`를 기계에
맡겨야 다음번엔 사용자보다 먼저 안다.**
