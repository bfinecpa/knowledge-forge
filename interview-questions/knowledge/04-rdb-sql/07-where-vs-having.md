# WHERE vs HAVING — 같은 "5000"인데 숫자가 갈리는 이유를 말로 재현한다

> 핵심 관전 포인트: **논리적 실행 순서로 고정한다 — FROM → WHERE →
> GROUP BY → HAVING → SELECT → ORDER BY. WHERE는 집계에 들어갈 재료를
> 거르고, HAVING은 집계가 끝난 결과를 거른다. 그래서 같은 테이블에
> 같은 "5000" 조건을 걸어도 위치에 따라 답이 7000 vs 5000으로 갈린다 —
> WHERE로 옮기면 평균의 분모(재료)가 바뀌고, HAVING으로 옮기면 재료는
> 그대로인 채 완성된 평균이 문턱을 넘는지만 본다. 이 차이를 데이터 없이
> 말로 재현하는 것이 이 문서의 훈련 목표이고, 성능 축까지 얹으면 완성이다
> — 같은 조건이면 WHERE(집계 전에 행을 줄이고 인덱스를 탄다). PostgreSQL
> 계획에는 이 위치가 그대로 찍힌다: WHERE는 스캔 노드의 `Index Cond`/
> `Filter`, HAVING은 집계 노드의 `Filter`. 플래너가 집계 없는 HAVING
> 조건을 알아서 WHERE로 내려 주긴 하지만, 그것에 기대는 것과 의도를
> 자리로 표현하는 것은 다르다.**

---

## 0. 질문 + 의도

**질문**: "`WHERE`절과 `HAVING`절의 차이는?"

**출제 의도**: 집계 전/후 필터의 구분이 안 되면 통계 쿼리에서 **틀린
숫자**를 만들고, 틀린 숫자는 **틀린 비즈니스 판단**으로 이어진다. 문법
암기("HAVING은 GROUP BY 뒤에 쓴다")가 아니라, 조건의 위치가 결과
숫자를 바꾼다는 사실을 구체 데이터로 추적할 수 있는지 — 그리고 그것을
**데이터 없이도 말로 설명**할 수 있는지를 본다. PostgreSQL은 이 순서를
표준대로 엄격히 지키는 쪽이라(WHERE·HAVING에서 SELECT 별칭 불가, GROUP
BY에 없는 컬럼은 에러) 순서를 몸으로 아는지가 에러 메시지에서 바로
드러난다.

---

## 1. 개념 — 실행 순서 위에 올려놓으면 두 절은 헷갈릴 수 없다

정의는 한 줄이면 된다. **WHERE는 개별 행에 대한 조건, HAVING은 그룹
(집계 결과)에 대한 조건.** 이게 왜 그럴 수밖에 없는지는 SQL의 **논리적
실행 순서** 위에 두 절을 올려놓으면 자동으로 나온다:

```
FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY
        ↑                   ↑
   집계 "전" 행 필터    집계 "후" 그룹 필터
```

- **WHERE 시점에는 아직 그룹이 없다.** 테이블에서 막 읽어온 행들만
  있다. 그래서 WHERE는 행 단위 조건만 걸 수 있고, `avg(salary)` 같은
  집계 함수를 쓰면 에러다(PostgreSQL: `ERROR: aggregate functions are
  not allowed in WHERE`) — 평균을 낼 "그룹"이 아직 만들어지지 않았기
  때문이다.
- **HAVING 시점에는 이미 그룹핑과 집계가 끝났다.** 남은 것은 "부서별
  평균" 같은 집계 결과 행들이고, HAVING은 그중 어떤 그룹을 결과에
  남길지를 거른다.

비유로 고정하면 — 요리 과정에서 **WHERE는 재료 손질(상한 재료를 조리
전에 버린다)**이고 **HAVING은 완성된 요리 검수(맛없는 요리를 상에서
내린다)**다. 같은 "버린다"여도 재료를 버리면 요리의 맛 자체가 바뀌고,
완성품을 버리면 상에 오르는 접시 수만 바뀐다.

---

## 2. 동작 — 미니 데이터로 숫자를 추적하고, 그 추적을 "말"로 압축한다

개발팀에 직원이 둘 있다: **A = 3000, B = 7000.** (평균 5000)

**요구 ①: "연봉 5000 이상인 직원만 대상으로, 부서별 평균 연봉"**

```sql
-- 집계에 들어갈 재료를 먼저 거른다 → WHERE
SELECT dept, avg(salary)
FROM employee
WHERE salary >= 5000     -- A(3000) 탈락, B(7000)만 재료로
GROUP BY dept;
-- 개발팀 평균 = 7000
```

**요구 ②: "부서별 평균 연봉이 5000 이상인 부서"**

```sql
-- 집계를 끝낸 뒤 그 결과를 거른다 → HAVING
SELECT dept, avg(salary)
FROM employee
GROUP BY dept
HAVING avg(salary) >= 5000;   -- 평균 5000 ≥ 5000 → 개발팀 통과
-- 개발팀 평균 = 5000
```

같은 테이블, 같은 숫자 "5000"인데 결과가 **7000 vs 5000**이다. 이것이
rationale이 말하는 "집계 전/후 구분 실패 → 틀린 숫자 → 틀린 비즈니스
판단"의 실체다 — 경영진이 "개발팀 평균 연봉"이라고 받아든 숫자가
어느 쪽이냐에 따라 연봉 정책 판단이 갈린다.

### 2-1. 언어화 템플릿 — "바꿔 쓰면 어떻게 되나"를 데이터 없이 말하기

숫자 추적은 되는데 말로 설명하려면 뭉개진다면, 문장 틀을 하나 고정해
두는 것이 답이다. **"조건이 집계 [전/후]로 이동한다 → [재료(분모)가
바뀐다 / 재료는 그대로고 문턱 검사만 한다] → 숫자가 [X → Y]로 바뀐다"**
— 이 세 칸을 채우는 연습이다.

- **①을 HAVING으로 잘못 쓰면**: "조건이 집계 **후**로 밀린다 → A도
  재료에 **들어가서** 평균의 분모가 바뀐다(7000 → 5000) → '저연봉을
  뺀 평균'이라는 요구 자체가 증발하고, 답은 7000이 아니라 5000이
  나온다."
- **②를 WHERE로 잘못 쓰면**: "조건이 집계 **전**으로 당겨진다 → 평균을
  검사하는 게 아니라 **재료를 미리 잘라낸다** → A(3000)가 빠진 채 평균
  7000이 나오고, '팀 전체 평균이 기준을 넘는가'라는 원래 질문과는 다른
  숫자를 보고하게 된다. 극단적으로 전원이 5000 미만인 부서는 재료가
  전부 사라져 **결과에서 부서 자체가 증발**한다."

핵심 어휘는 두 개다 — WHERE 이동은 "**분모가 바뀐다**", HAVING 이동은
"**분모는 그대로, 검사 시점만 바뀐다**". 이 두 마디만 잡고 있으면
어떤 변형 질문이 와도 문장이 무너지지 않는다.

### 2-2. 세 번째 자리 — 집계 함수 안의 `FILTER (WHERE ...)`

요구 ①과 ②를 한 화면에 같이 내야 한다면? 조건을 WHERE에 걸면 ②의
분모가 깨지고, HAVING에 걸면 ①의 분모가 안 좁혀진다. 조건을 둘 자리가
하나 더 있다 — **집계 함수 안**이다.

```sql
SELECT dept,
       avg(salary)                                AS avg_all,   -- 분모: 부서 전원
       avg(salary) FILTER (WHERE salary >= 5000)  AS avg_high,  -- 분모: 5000 이상만
       count(*)    FILTER (WHERE salary >= 5000)  AS n_high
FROM employee
GROUP BY dept
HAVING avg(salary) >= 5000;    -- 그룹 필터는 여전히 HAVING
-- 개발팀: avg_all = 5000, avg_high = 7000, n_high = 1
```

`FILTER`는 "이 집계 함수 하나의 재료만 거른다"는 뜻이라, **같은 그룹
안에서 분모가 다른 집계를 나란히** 만들 수 있다. 실행 순서로 보면
WHERE(행)와 HAVING(그룹) 사이, 집계 단계 안쪽에 끼어드는 세 번째
필터다. 표준 SQL 문법이고 PostgreSQL이 지원한다. 같은 일을
`avg(CASE WHEN salary >= 5000 THEN salary END)`로도 쓸 수 있지만(CASE가
NULL을 돌려주면 avg가 무시한다), FILTER 쪽이 "이 집계의 분모를 바꾼다"는
의도가 문장에 그대로 드러난다.

---

## 3. 실무 사례 — 같은 조건이라면 WHERE에: 성능은 "언제 거르느냐"의 문제

집계 함수가 안 들어간 조건은 WHERE와 HAVING 어디에 둬도 **결과가 같을
수 있다.** 그러나 논리적 비용은 다르다.

```sql
-- ❌ before: 논리적으로는 전 부서를 다 그룹핑한 뒤에 버리는 쿼리
SELECT dept, avg(salary)
FROM employee
GROUP BY dept
HAVING dept = '개발팀';
-- 실행 순서대로라면 영업팀·인사팀·… 모든 부서의 평균을 전부 계산하고,
-- 다 만든 결과에서 개발팀 한 줄만 남기고 나머지를 버린다.

-- ✅ after: 집계에 들어갈 행을 먼저 줄인다
SELECT dept, avg(salary)
FROM employee
WHERE dept = '개발팀'    -- dept 인덱스를 탈 수 있다
GROUP BY dept;
-- 개발팀 행만 읽어서 그 행들만 그룹핑한다.
```

이유는 실행 순서에서 그대로 나온다 — **HAVING은 그룹핑·집계가 전부
끝난 뒤에야 실행되므로, HAVING에만 조건을 두면 버릴 그룹까지 만드는
비용을 이미 치른 뒤다.** 반면 WHERE는 집계 **전에** 행을 줄이므로
그룹핑할 데이터 자체가 작아지고, 행 단위 조건이라 **인덱스를 탈 수
있다**(HAVING이 다루는 집계 결과는 쿼리 실행 중에 만들어지는 값이라
인덱스가 있을 수 없다).

### 3-1. 계획에서 확인 — 조건이 어느 노드의 `Filter`에 붙었나

PostgreSQL은 이 위치를 실행 계획에 그대로 보여 준다. **WHERE 조건은
스캔 노드**에 `Index Cond` 또는 `Filter`로, **HAVING 조건은 집계 노드**
(`HashAggregate`/`GroupAggregate`)에 `Filter`로 찍힌다.

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT dept, avg(salary) FROM employee GROUP BY dept HAVING avg(salary) >= 5000;

 HashAggregate  (actual rows=3 loops=1)
   Group Key: dept
   Filter: (avg(salary) >= '5000'::numeric)   ← HAVING: 그룹을 다 만든 뒤 거른다
   Rows Removed by Filter: 5                  ← 만들었다가 버린 그룹 수
   ->  Seq Scan on employee  (actual rows=1000 loops=1)   ← 전 행이 재료로 들어간다
         Buffers: shared hit=12
```

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT dept, avg(salary) FROM employee WHERE dept = '개발팀' GROUP BY dept;

 GroupAggregate  (actual rows=1 loops=1)
   Group Key: dept
   ->  Index Scan using idx_employee_dept on employee  (actual rows=120 loops=1)
         Index Cond: (dept = '개발팀'::text)   ← WHERE: 재료 단계에서 잘라냈다
         Buffers: shared hit=4
```

읽는 법은 하나다 — 집계 노드에 `Filter`가 있고 `Rows Removed by Filter`가
크면 "버릴 그룹을 만드는 비용을 치렀다"는 뜻이고, 스캔 노드에
`Index Cond`/`Filter`가 있으면 재료 단계에서 잘라낸 것이다. 그런데 위의
❌ 쿼리(`HAVING dept = '개발팀'`)를 실제로 `EXPLAIN` 해 보면 **✅와
똑같은 계획이 나온다.** 다음 절의 이유 때문이다.

### 3-2. (가산점 포인트) PG 플래너는 집계 없는 HAVING 조건을 WHERE로 내려보낸다

PostgreSQL 플래너는 HAVING 절의 조건 중 **집계 함수도, volatile 함수
(`random()` 같은)도 들어 있지 않은 것**을 WHERE로 옮겨서 계획을 세운다.
그래서 `HAVING dept = '개발팀'`은 실제로는 스캔 단계에서 `Index Cond`로
처리되고, 논리적 실행 순서와 물리적 실행이 갈린다 — 결과가 같다는 것이
증명되는 조건이니 플래너가 더 싼 순서로 바꿔 실행하는 것이다. 판별은
계획으로: 조건이 `HashAggregate`의 `Filter`가 아니라 `Seq Scan`/`Index
Scan` 쪽에 붙어 있으면 내려간 것이다.

그렇다면 WHERE에 쓸 이유가 없어지는가? 아니다. ① 플래너가 내려 줄 수
있는 조건은 "집계·volatile 함수가 없는 것"뿐이고, 그 판단은 내가 아니라
플래너가 한다 — 조건에 집계가 섞이는 순간 아무도 못 내린다. ② 그에
기대는 것과 의도를 코드로 표현하는 것은 다르다 — "행 조건은 WHERE, 그룹
조건은 HAVING"으로 자리를 지키면 성능 이전에 **쿼리를 읽는 사람에게
의도가 전달**된다. 최적화가 지워 주는 것은 비용 차이지 의미 차이가
아니다.

정리하면 판단 기준은 하나다: **조건식 안에 집계 함수(또는 집계 결과)가
있는가?** 있으면 HAVING밖에 못 쓰고, 없으면 WHERE에 두는 것이 원칙이다.

---

## 4. 꼬리질문 대비 포인트

### "①과 ②의 조건을 서로 바꿔 쓰면 결과가 어떻게 되는지, 데이터 없이 말로만 설명해보세요."

2-1의 템플릿 그대로 — "조건이 집계 전/후로 이동한다 → 분모가 바뀌거나
/ 분모는 그대로 검사 시점만 바뀐다 → 숫자가 달라진다." ①을 HAVING으로
밀면 걸러냈어야 할 저연봉 행이 평균의 분모에 들어가 숫자가 내려가고
(7000 → 5000), ②를 WHERE로 당기면 평균 검사 대신 재료를 미리 잘라
숫자가 올라가며(5000 → 7000) 전원이 기준 미달인 부서는 결과에서
통째로 증발한다. **"의미가 서로 바뀐다"가 아니라 "각각 다른 틀린
숫자가 나온다"**까지 말해야 완성이다.

### "WHERE 절에 `avg(salary) >= 5000`을 쓰면 왜 에러인가요?"

**WHERE가 실행되는 시점에는 그룹이 아직 없기 때문이다.** WHERE는 행을
하나씩 보며 남길지 버릴지 정하는 단계인데, `avg(salary)`는 "여러 행을
묶은 그룹"이 있어야 계산되는 값이다. 아직 존재하지 않는 것에 대한
질문이라 문법 이전에 논리적으로 성립하지 않고, 그래서 표준이 금지한다
— PostgreSQL은 `ERROR: aggregate functions are not allowed in WHERE`로
거절한다. 거꾸로 이 사실이 HAVING의 존재 이유다 — 집계 결과를 거를 절이
따로 필요해서 HAVING이 있는 것이다.

### "집계 함수가 없는 조건은 WHERE와 HAVING 어디 둬도 결과가 같은데, 그래도 WHERE에 둬야 하는 이유는?" (시니어 변별 포인트)

결과가 같은 경우는 주로 **GROUP BY 컬럼 자체에 대한 조건**일 때다
(그룹핑 전에 행을 버리나 그룹핑 후에 그 그룹을 버리나 남는 그룹이
같다). 그래도 WHERE에 둬야 하는 이유는 두 겹 — ① **비용**: 논리적으로
WHERE는 집계 전에 행을 줄여 그룹핑 대상 자체를 작게 만들고 인덱스를 탈
수 있지만, HAVING은 버릴 그룹까지 전부 만든 뒤에 거른다. PostgreSQL
플래너는 집계 없는 HAVING 조건을 WHERE로 내려 주므로 이 예에서는 실제
계획이 같아지는데(조건이 `HashAggregate`의 `Filter`가 아니라 스캔 노드의
`Index Cond`에 붙은 것으로 확인), 그것은 "내려 줄 수 있는 조건"에 한정된
플래너의 판단이지 내가 보장한 것이 아니다. ② **의미**: 행 조건은 WHERE,
그룹 조건은 HAVING이라는 자리 약속이 지켜져야 읽는 사람이 쿼리의 의도를
오해하지 않는다. 여기에 "내려갔는지는 계획의 `Filter` 위치로 확인한다"
까지 얹으면 실행 계획을 의식하는 사람의 언어가 된다.

### "HAVING에서 SELECT의 별칭(alias)이나 집계식을 쓸 수 있나요?"

집계식(`avg(salary) >= 5000`)은 당연히 가능 — 그러라고 있는 절이다.
별칭은 **PostgreSQL에서는 불가**다: **논리 순서상 SELECT가 HAVING보다
뒤**라서 표준 SQL이 허용하지 않고, PG는 표준대로 `SELECT avg(salary) AS
avg_sal ... HAVING avg_sal >= 5000`을 `ERROR: column "avg_sal" does not
exist`로 거절한다. WHERE도 마찬가지 — SELECT보다 한참 앞 단계라 별칭이
아직 태어나지도 않았다. PG에서 SELECT 별칭이 통하는 자리는 **ORDER BY**
(표준)와 **GROUP BY**(PG 확장 — 입력 컬럼명과 겹치면 입력 컬럼이 우선)
뿐이다. 별칭으로 거르고 싶으면 집계식을 다시 쓰거나, 서브쿼리·CTE로 한
번 감싸서 그 바깥 WHERE에서 일반 컬럼으로 참조한다.

> MySQL 대조: MySQL은 확장으로 HAVING에서 SELECT 별칭을 허용한다(WHERE는
> MySQL도 불가). 그래서 MySQL에서 돌던 `HAVING avg_sal >= 5000`이 PG로
> 옮기면 에러가 나는 것이 이식 때 가장 먼저 마주치는 차이다.

### "GROUP BY 없이 HAVING만 쓸 수 있나요?"

**가능하다(PostgreSQL도 허용) — 이때는 테이블 전체가 하나의 암묵적
그룹이 된다.**
`SELECT avg(salary) FROM employee HAVING avg(salary) >= 5000`은 전체
평균이 5000 이상이면 한 행, 아니면 빈 결과를 돌려준다. "전사 평균이
기준을 넘을 때만 리포트 행을 만든다" 같은 조건부 집계에 쓸 수 있지만
드문 형태라, 실무에서 마주치면 의도된 것인지(GROUP BY 누락 실수가
아닌지) 먼저 의심하는 게 맞다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

네 지점이다. ① **HAVING의 SELECT 별칭** — MySQL은 `HAVING avg_sal >= 5000`
을 허용하지만 PG는 `column "avg_sal" does not exist` 에러다. PG에서 별칭이
통하는 자리는 ORDER BY와 GROUP BY뿐이다. ② **GROUP BY에 없는 컬럼을
SELECT** — PG는 항상 에러(`must appear in the GROUP BY clause or be used in
an aggregate function`; 예외는 PK로 그룹핑했을 때의 함수 종속 인정)지만,
MySQL은 `ONLY_FULL_GROUP_BY`가 꺼져 있으면 그룹 안의 아무 값이나 조용히
돌려준다 — "틀린 숫자"가 에러 없이 나가는 경로다. ③ **집계 안 조건** —
PG는 `FILTER (WHERE ...)`, MySQL은 없어서 `SUM(CASE WHEN ...)`/
`COUNT(IF(...))`로 쓴다. ④ **계획에서 위치 확인** — PG는 HAVING이 집계
노드의 `Filter`로, WHERE가 스캔 노드의 `Filter`/`Index Cond`로 찍혀 눈에
보이지만, MySQL의 표 형식 EXPLAIN에는 `Using temporary` 정도만 남아
HAVING의 위치가 안 보이고, 트리 형식은 `EXPLAIN ANALYZE`(8.0.18+)에서야
읽을 수 있다.

---

## 한 줄 요약

**FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY의 실행 순서
위에서, WHERE는 집계에 들어갈 재료(행)를 거르고 HAVING은 집계가 끝난
결과(그룹)를 거른다 — 같은 조건이라도 위치가 바뀌면 분모가 바뀌어
다른 숫자가 나오고(7000 vs 5000), 틀린 숫자는 틀린 비즈니스 판단이
된다. 집계 함수 안의 `FILTER (WHERE ...)`는 그룹 안에서 분모만 따로
바꾸는 세 번째 자리다. 집계 함수가 없는 조건은 WHERE에 — 집계 전에
행을 줄이고 인덱스를 탈 수 있으며, HAVING은 버릴 그룹까지 다 만든
뒤에야 거르기 때문이다. PostgreSQL 계획에서는 WHERE가 스캔 노드의
`Index Cond`/`Filter`로, HAVING이 집계 노드의 `Filter`로 찍혀 위치가
눈에 보이고, 플래너가 집계 없는 HAVING 조건을 WHERE로 내려 주더라도
그것은 비용 차이를 지울 뿐 의도 표현을 대신하지 않는다.**
