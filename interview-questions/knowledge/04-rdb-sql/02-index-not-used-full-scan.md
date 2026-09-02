# 인덱스를 걸었는데도 풀스캔 — 원인 6종을 한 문장에서 도출하고, "못 탄다"와 "안 탄다"를 30초에 가른다

> 핵심 관전 포인트: **원인 목록을 외우는 게 아니라 "인덱스는 원본 값을 정렬해 둔 별도의 사본"이라는 한 문장에서 전부 도출한다. 이 문장에는 ① 저장된 것은 가공되지 않은 원본 값이고 ② 정렬은 왼쪽부터, 쿼리와 같은 비교 규칙으로이며 ③ 이득을 보려면 작고 연속된 한 구간으로 좁혀져야 한다는 세 전제가 들어 있다. 답변은 반드시 두 부류로 갈라 말한다 — 구조상 못 타는 경우(can't)(① 컬럼에 함수·연산 ② 타입 불일치 ③ 선행 와일드카드 `LIKE '%kw%'` — PostgreSQL에서는 접두 `LIKE`도 collation 함정이 있다 ④ 복합 인덱스 선두 컬럼 미사용 ⑤ `OR`·부정 조건)와, 탈 수 있는데 플래너가 계산 끝에 안 타는 경우(won't)(⑥ 낮은 선택도 + 통계·비용 파라미터·제네릭 계획). 후자의 근거는 PostgreSQL의 저장 구조다 — 테이블은 힙이고 모든 인덱스는 리프에 행의 물리 주소(TID)만 들고 있어 조회가 "인덱스 탐색 → 힙 페치" 2단계인데, 두 번째가 흩어진 페이지를 찌르는 랜덤 I/O(`random_page_cost` 4.0 vs `seq_page_cost` 1.0)라서 대상이 일정 비율을 넘으면 `Seq Scan`이 더 싸다. 두 부류를 가르는 도구는 `SET LOCAL enable_seqscan = off` — 계획이 인덱스로 바뀌면 "안 탄" 것, 그대로면 "못 타는" 것. 진단은 `EXPLAIN (ANALYZE, BUFFERS)`의 스캔 노드 이름 · `Index Cond` vs `Filter` · 추정 rows vs 실제 rows · `Buffers`로 한다.**

---

## 0. 질문 + 의도

**질문**: "인덱스를 걸었는데도 풀스캔이 발생하는 경우는 어떤 경우인가요?"

관련 질문:
"인덱스는 어떻게 동작하나요? B+Tree 구조를 설명해주세요."
"`LIKE '%keyword%'` 검색이 인덱스를 못 타는 이유는?"

**출제 의도**: rationale의 표현 그대로 — "함수 적용, 타입 불일치, 낮은 선택도 등 원인이 다양한데, **이 목록이 머리에 있는 사람은 슬로 쿼리를 5분 만에 고치고 없는 사람은 '인덱스 있는데 왜 느리지'에서 멈춘다.**" 즉 이 문항은 이해도 확인이 아니라 **인출(retrieval) 테스트**다. 장애 상황에서 목록이 즉시 튀어나오는지, 그리고 그 목록을 암기가 아니라 **구조에서 도출**하는지를 본다. 앞 문항([인덱스와 B+Tree](01-index-and-bplus-tree.md))이 "구조를 아는가"라면, 이 문항은 "그 구조로 **현상을 설명할 수 있는가**"이다. PostgreSQL 용어로 "풀스캔"은 실행 계획의 **`Seq Scan`** 노드다.

---

## 1. 판별 틀 — 모든 항목은 한 문장에서 나오고, 두 부류로 갈린다

### 1-1. 붙잡을 문장은 하나다

암기 목록은 긴장하면 두 개쯤에서 끊긴다. 대신 **문장 하나를 붙잡고 거기서 찢어내는 방식**으로 가면 여섯 개가 순서대로 나온다. 이 문서 전체가 아래 한 줄의 각주라고 봐도 된다.

> **인덱스란, 인덱스 컬럼의 값과 그 행의 위치(TID)를 함께 담아 그 값 기준으로 정렬해 둔 별도의 사본이다.**

여기서 "별도의 사본"이 중요하다. 인덱스는 테이블을 들여다보는 렌즈가 아니라 **따로 만들어 둔 파일**이고, 그 파일에는 **인덱스를 만들 때 정한 그 값**만 들어 있다. 조회가 빠른 이유는 딱 하나 — 찾는 값이 **이미 그 사본 안에 정렬된 채로 존재해서** 시작점을 찍고 그 구간만 훑으면 되기 때문이다. 그러니 인덱스를 못 타는 상황은 전부 "찾는 값이 그 사본 안에 그 모양으로 있지 않다" 또는 "있긴 한데 훑을 구간이 사실상 전체다"로 환원된다.

PostgreSQL에서 "행의 위치"는 **TID**(`(블록 번호, 블록 안 오프셋)`, 6바이트)다. 테이블은 정렬되지 않은 **힙(heap)** 이고, PK 인덱스든 일반 인덱스든 **모든 인덱스가 리프에 (키 값, TID)를 담고 힙을 가리키는 세컨더리 인덱스**다. 이 사실 하나가 2-7 이후의 비용 모델을 결정한다.

### 1-2. 그 문장에 숨은 전제 셋

한 문장을 뜯으면 전제가 셋 나온다. 원인 여섯 개는 이 셋 중 하나가 깨진 것이다.

| 전제 | 내용 | 깨지면 나오는 원인 |
|---|---|---|
| **① 원본 값 그대로** | 인덱스에 저장된 건 컬럼의 **가공되지 않은 값**이다. 소문자로 바꾼 값도, 날짜만 잘라낸 값도, 다른 타입으로 바꾼 값도 거기 없다 | ①번(함수·연산), ②번(타입 불일치) |
| **② 정렬은 왼쪽부터, 쿼리와 같은 비교 규칙으로** | 문자열은 첫 글자부터, 복합 인덱스는 첫 컬럼부터 정렬된다. 그리고 "어떤 규칙으로 정렬했는가"(collation, 연산자 클래스)가 쿼리의 비교 규칙과 같아야 그 정렬이 쓸모 있다 | ③번(선행 와일드카드·collation), ④번(선두 컬럼 미사용), 2-6(연산자 클래스·부분 인덱스) |
| **③ 이득은 "작고 연속된 한 구간"에서만** | 정렬돼 있으니 **시작점 하나, 끝점 하나**를 찍고 그 사이만 훑는 게 인덱스의 이득이다. 구간이 여러 개로 갈라지거나, 구간이 전체의 상당 부분이면 이득이 사라진다 | ⑤번(`OR`·부정 조건), ⑥번(낮은 선택도) |

### 1-3. 다섯 가지를 한 문장으로 되짚어 본다

**여기가 이 문서의 축이다.** 되짚지 않으면 결국 목록 암기가 된다. 원인 하나씩을 "그 문장의 어느 부분이 깨졌는가"로 소리 내어 말해 보자.

```text
"인덱스란 [원본 값]을 [왼쪽부터 같은 규칙으로 정렬]해 둔 [별도의 사본]이다"

① 함수·연산     date(created_at) = ?
   → 사본에는 created_at 의 [원본 타임스탬프]가 들어 있다.
     date() 를 적용한 값은 사본 어디에도 없다.
     "사본에 없는 값으로는 사본을 못 뒤진다."

② 타입 불일치   (user_id)::numeric = 100.0
   → ①의 변형이다. 캐스트도 함수다.
     사본에는 bigint 원본이 있는데 조건은 numeric 으로 바꾼 값을 찾는다.
     "캐스트가 컬럼 쪽에 붙는 순간 ①과 같은 꼴이 된다."

③ 선행 와일드카드  title LIKE '%결제%'
   → 사본은 [첫 글자부터] 정렬돼 있다. 첫 글자를 모르면 시작점을 못 찍는다.
     접두 LIKE 'kim%' 도, DB collation 이 C 가 아니면
     [같은 비교 규칙]이 아니라서 "kim 으로 시작하는 것들"이 연속 구간이 아니다.
     "정렬 기준을 안 쓰는(또는 다른 기준의) 조건은 정렬의 덕을 못 본다."

④ 선두 컬럼 미사용  (user_id, created_at) 인덱스에 WHERE created_at > ?
   → 복합 인덱스도 [왼쪽부터] 정렬이다. user_id 로 먼저 정렬됐으므로
     created_at 값은 사본 전체에 흩어져 있다.
     "왼쪽이 비면 정렬이 아직 시작도 안 한 것과 같다."

⑤ OR / 부정 조건   email = ? OR phone = ?  /  status <> 'DONE'
   → 사본이 정렬돼 있어도 이득은 [한 구간]을 훑을 때만 난다.
     OR 은 서로 다른 축의 구간 둘을 요구하고,
     <> 는 한 점을 뺀 좌우 전부(=사실상 전체)를 요구한다.
     "구간이 갈라지거나 전체가 되면 정렬의 이득이 사라진다."
```

**⑥번만 성질이 다르다.** ①~⑤는 문장의 전제가 깨져 **인덱스로 시작점을 찍을 방법 자체가 없는** 것이고, ⑥번은 시작점을 찍을 수 있는데도 **훑을 구간이 너무 커서 플래너가 계산 끝에 버린** 것이다. 이 차이가 다음 절의 부류 A / 부류 B다.

참고로 이 추론 방식은 실제 면접 꼬리질문에서도 통했다 — `lower(email) = 'a@b.com'`이 인덱스를 못 타는 이유를 "인덱스에 `lower` 처리된 값이 저장돼 있지 않기 때문"이라고 답한 것이 정확히 전제 ①이다. **이 추론 방식이 맞다. 여기에 전제 ②·③만 얹으면 여섯 개가 다 나온다.**

### 1-4. 체크리스트 — 이 표 하나로 인출한다

면접장에서든 장애 대응 중이든, 이 표를 머릿속에 펼치는 것이 목표다. **부류를 나눠 말하는 것 자체가 변별점**이므로 표의 마지막 칸이 가장 중요하다.

| # | 원인 | 깨지는 전제 | 못 타는 예 → 고친 예 | 부류 |
|---|---|---|---|---|
| ① | 컬럼에 **함수·연산** 적용 | ① 원본 값 | `WHERE date(created_at) = '2026-08-11'`<br>→ `WHERE created_at >= '2026-08-11' AND created_at < '2026-08-12'` (또는 표현식 인덱스) | **A. 구조상 못 탐** |
| ② | **타입 불일치** — 컬럼 쪽이 캐스트된다 | ① 원본 값 | `WHERE user_id = 100.0` (`bigint` vs `numeric`)<br>→ `WHERE user_id = 100` / 파라미터 타입 교정 | **A. 구조상 못 탐** |
| ③ | **선행 와일드카드**, 그리고 비-C collation의 접두 `LIKE` | ② 왼쪽부터 정렬 | `WHERE title LIKE '%결제%'` → `pg_trgm` GIN 인덱스<br>`WHERE name LIKE 'kim%'`가 안 탐 → `text_pattern_ops` 인덱스 | **A. 구조상 못 탐** |
| ④ | 복합 인덱스 **선두 컬럼 미사용** | ② 왼쪽부터 정렬 | `(user_id, created_at)` 인덱스에 `WHERE created_at > ?`<br>→ 선두 조건 추가 or 인덱스 재설계 | **A. 구조상 못 탐** |
| ⑤ | **`OR` / 부정 조건**(`<>`, `NOT IN`) | ③ 작고 연속된 구간 | `WHERE email = ? OR phone = ?`<br>→ 양쪽 인덱스(`BitmapOr`) 또는 `UNION ALL` 분해 | **A. 구조상 못 탐**(구간이 갈라짐) |
| ⑥ | **낮은 선택도**(+ 통계·비용 파라미터·제네릭 계획) | ③ 작고 연속된 구간 | `WHERE status = 'ACTIVE'` (전체의 90%)<br>→ 복합 인덱스 / 부분 인덱스 / 쿼리 재설계 | **B. 탈 수 있는데 안 탐** |

### 1-5. 부류 A와 부류 B는 성질이 완전히 다르다

두 부류는 "인덱스를 안 쓴다"는 증상만 같을 뿐, **원인도 처방도 담당자도 다르다.** 이 표를 세워 놓고 답하면 목록을 외운 사람과 이해한 사람이 갈린다.

| | **부류 A — 못 타는 것 (can't)** | **부류 B — 안 타는 것 (won't)** |
|---|---|---|
| 정체 | 인덱스로 **시작점을 찍을 방법이 구조상 없다** | 시작점은 찍을 수 있는데 **써봤자 손해라고 플래너가 계산했다** |
| 누구의 문제인가 | **쿼리 또는 인덱스 정의**의 형태 | **데이터 분포**(그리고 그것을 보는 통계·비용 모델) |
| 플래너의 심경 | 쓰고 싶어도 후보에 인덱스가 없다 | 후보에 있는데 비용을 재 보고 버렸다 |
| `enable_seqscan = off`를 주면 | 벌점을 줘도 갈 데가 없어 **여전히 `Seq Scan`** | **`Index Scan`/`Bitmap Heap Scan`으로 바뀐다** |
| 처방 | 쿼리를 고치거나(맨몸 컬럼, 범위 조건, 타입 교정), 인덱스를 다시 만든다(표현식·`text_pattern_ops`·컬럼 순서) | 복합·부분·커버링 인덱스로 **설계를 바꾸거나**, 통계·비용 파라미터로 **플래너의 판단을 옳게** 만든다 |
| 흔한 오진 | — | **플래너가 옳았는데 억지로 인덱스를 태워 더 느려진다** |

**30초 판별법 (PostgreSQL 고유, 암기)**

```sql
BEGIN;
SET LOCAL enable_seqscan = off;   -- "Seq Scan에 큰 벌점" — 인덱스 경로가 하나라도 있으면 그쪽으로 간다
EXPLAIN (ANALYZE, BUFFERS) SELECT ... ;
ROLLBACK;                          -- 이 트랜잭션 안에서만 유효
```

계획이 `Index Scan`/`Bitmap Heap Scan`으로 **바뀌면** 탈 수는 있었던 것 — 플래너가 비용 계산 끝에 버린 **부류 B**다(두 계획의 `cost`와 `Execution Time`을 나란히 놓으면 플래너가 옳았는지까지 나온다). 여전히 **`Seq Scan`**이면 벌점을 줘도 갈 데가 없는 **부류 A**다.

이 스위치는 Seq Scan을 금지하는 게 아니라 **비용에 아주 큰 값을 더하는** 것이라 판별이 가능하다. **가설 검증용이지 운영 설정이 아니다.**

> 이 구분을 못 하면 **부류 B에 인덱스를 강제로 태우는 잘못된 처방**으로 간다 — 플래너가 옳았던 상황에서 강제하면 오히려 느려진다.
>
> **MySQL 대조**: MySQL은 `USE INDEX`/`FORCE INDEX` 힌트가 문법에 있어 "일단 강제하고 본다"가 흔하다. PostgreSQL에는 힌트 문법이 없어(`pg_hint_plan`은 확장) **통계와 비용 파라미터를 고쳐 플래너의 판단 자체를 옳게 만드는** 것이 정석이다(4절).

---

## 2. 원인 — 못 타는 다섯 가지(A)와, 안 타는 이유(B)

### 2-1. 부류 A ① — 컬럼에 함수·연산을 씌웠다

가장 흔하고, 가장 알아채기 쉬운 형태다. 인덱스에는 `created_at`의 **원본 타임스탬프**가 정렬돼 있지, `date(created_at)`의 결과인 날짜가 정렬돼 있지 않다. "모든 행에 함수를 적용해봐야 그 값을 알 수 있다" = **모든 행을 읽어야 한다** = 풀스캔.

```sql
-- 못 탄다: created_at에 date() 함수가 씌워져 인덱스의 원본 값과 형태가 다르다
SELECT * FROM orders WHERE date(created_at) = '2026-08-11';
--  Seq Scan on orders
--    Filter: (date(created_at) = '2026-08-11'::date)
--    Rows Removed by Filter: 968760        ← 100만 행을 다 읽고 97%를 버렸다

-- 탄다: 컬럼은 맨몸으로 두고, 조건을 "구간"으로 바꾼다
SELECT * FROM orders
WHERE created_at >= '2026-08-11'
  AND created_at <  '2026-08-12';
--  Index Scan using idx_orders_created_at on orders
--    Index Cond: ((created_at >= '2026-08-11 ...') AND (created_at < '2026-08-12 ...'))
```

산술 연산도 똑같다. **핵심 규칙은 "컬럼을 부등호 한쪽에 맨몸으로 남겨라"** 이다.

```sql
-- 못 탄다: 컬럼이 곱셈에 참여했다
SELECT * FROM products WHERE price * 1.1 > 11000;
-- 탄다: 연산을 상수 쪽으로 옮겼다 (값은 동일)
SELECT * FROM products WHERE price > 10000;
-- 이건 괜찮다: 연산이 "상수 쪽"에서만 일어난다
--   now()는 트랜잭션 시작 시각으로 고정된 값이라 한 번만 계산돼 상수처럼 쓰인다
SELECT * FROM orders WHERE created_at >= now() - interval '1 day';
```

**(가산점 포인트)** 도저히 함수를 뗄 수 없는 요구사항이라면 PostgreSQL의 강점인 **표현식 인덱스**가 정공법이다. "가공된 값이 인덱스에 없다"가 원인이니, **가공된 값 자체를 정렬해 둔 인덱스를 만들면** 된다.

```sql
-- 대소문자 무시 검색이 진짜 요구사항일 때 — 컬럼이 아니라 "표현식"에 인덱스를 건다
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- 쿼리의 표현식이 인덱스 정의와 글자 그대로 같아야 매칭된다
SELECT * FROM users WHERE lower(email) = 'a@b.com';
--  Index Scan using idx_users_email_lower on users
--    Index Cond: (lower(email) = 'a@b.com'::text)
-- (대안: GENERATED ALWAYS AS (lower(email)) STORED 생성 컬럼 + 인덱스, 또는 citext 확장)
```

덤으로 `ANALYZE`가 표현식 인덱스의 **표현식 통계도 수집**해 행 수 추정까지 좋아진다(3-3). 함정 하나 — `timestamptz` 컬럼에 `date(created_at)` 표현식 인덱스는 **만들 수 없다**(결과가 세션 `TimeZone`에 따라 달라지는 함수는 인덱스 표현식에 못 쓴다). 날짜 조건은 위의 범위 조건이 정석이다.

### 2-2. 부류 A ② — 타입이 안 맞았다 (PostgreSQL은 대개 에러로 막지만, 조용히 컬럼을 캐스트하는 경우가 있다)

PostgreSQL에는 **문자열과 숫자 사이의 암묵 캐스트가 없다.** 그래서 이 유형의 가장 고전적인 실수는 풀스캔이 아니라 에러로 나타난다.

```sql
-- phone은 varchar(20), 인덱스 있음
-- 실패: 따옴표를 빠뜨려 숫자 리터럴과 비교했다
SELECT * FROM users WHERE phone = 01012345678;
--  ERROR:  operator does not exist: character varying = integer

-- 더 나쁜 대응: HINT대로 "컬럼 쪽에" 캐스트 = 컬럼에 함수 (2-1과 동일). 선행 0도 사라진다
SELECT * FROM users WHERE phone::bigint = 01012345678;

-- 탄다: 컬럼 타입에 맞춰 리터럴 쪽을 문자열로
SELECT * FROM users WHERE phone = '01012345678';
```

좋은 소식은 **풀스캔 사고가 컴파일 에러처럼 개발 단계에서 드러난다**는 것. 나쁜 소식은 **조용히 컬럼이 캐스트되는 조합**이 남아 있다는 것 — 같은 숫자 계열 안에서 교차 타입 연산자가 없는 경우로, 대표가 `bigint` 컬럼 vs `numeric` 값(`100.0` 리터럴, JDBC의 `BigDecimal`·`Double` 파라미터)이다.

```sql
-- user_id bigint, PK 인덱스 있음
-- 조용히 못 탄다: PostgreSQL이 컬럼을 numeric으로 올려서 비교한다
SELECT * FROM orders WHERE user_id = 100.0;
--  Seq Scan on orders
--    Filter: ((user_id)::numeric = 100.0)    ← 캐스트가 "컬럼 쪽"에 붙어 있다 = 2-1과 같은 꼴

-- 탄다 (정수끼리는 교차 타입 연산자가 있어 smallint/int/bigint 혼용은 괜찮다)
SELECT * FROM orders WHERE user_id = 100;
--  Index Scan using orders_pkey on orders
--    Index Cond: (user_id = 100)
```

**왜 하필 컬럼 쪽이 변환되는가**가 이 항목의 핵심이고, 면접에서 파고드는 지점이다. PostgreSQL의 타입 해석은 **정보를 잃지 않는 방향으로만 암묵 캐스트를 허용**한다 — `bigint → numeric`은 무손실이라 되고, `numeric → bigint`는 소수부를 잃으니 안 된다. 그러니 `bigint = numeric`을 만나면 "컬럼을 numeric으로 올린다"는 선택지밖에 없고, 그 순간 인덱스의 원본 값과 형태가 달라진다.

문자열과 숫자 사이는 어느 방향도 안전하지 않으니(`'01012345678'`과 `'1012345678'`은 문자열로는 다르지만 숫자로는 같다 — 결과 집합이 바뀌는 비가역 변환) 아예 비교를 거부한다. **DB는 성능보다 정확성을 우선한다**는 원칙은 같고, PostgreSQL은 그 원칙을 "에러"라는 더 이른 시점에 적용한다.

**(가산점 포인트)** 실무에서 터지는 자리 둘.

⑴ **JPA/pgjdbc** — 엔티티 필드 타입이 컬럼과 다를 때. `String` 필드와 `bigint` 컬럼이면 파라미터가 `varchar`로 가서 **에러**, `BigDecimal`·`Double` 필드와 `bigint` 컬럼이면 **조용한 풀스캔**이다. `stringtype=unspecified` 접속 옵션으로 에러는 피할 수 있지만 근본은 **필드 타입 = 컬럼 타입**이다.

⑵ **JOIN** — `a.user_id bigint = b.user_id varchar`는 에러로 막히고, 개발자가 `b.user_id::bigint`로 넘어가는 순간 **캐스트가 붙은 쪽 테이블의 인덱스를 통째로 포기**한 것이라 조인 안쪽이 `Seq Scan`이 되거나 플래너가 대량 해시 조인으로 도망간다. 그래서 **"같은 의미의 컬럼은 모든 테이블에서 같은 타입·같은 collation"**이 스키마 설계의 기본 규율이다.

> **MySQL 대조**: MySQL은 `phone = 01012345678`을 에러 없이 받아 **컬럼 전체를 숫자로 변환하며 조용히 풀스캔**하고, 선행 0이 사라져 결과까지 틀릴 수 있다. "PostgreSQL은 타입에 엄격해서 불편하다"가 아니라 "풀스캔 사고를 컴파일 타임으로 끌어올렸다"로 설명하면 원리를 이해한 답이 된다.

### 2-3. 부류 A ③ — 선행 와일드카드, 그리고 PostgreSQL에서는 접두 `LIKE`도 함정이다

전제 ②가 깨지는 경우다. 인덱스는 **첫 글자부터** 정렬돼 있으므로, 첫 글자를 모르면 트리를 내려갈 시작점을 찍을 수 없다. 사전에서 "가운데에 '결제'가 들어간 단어"를 찾으라면 처음부터 끝까지 넘기는 수밖에 없는 것과 똑같다.

```sql
-- 못 탄다: 시작점을 특정할 수 없다
SELECT * FROM posts WHERE title LIKE '%결제%';
--  Seq Scan on posts
--    Filter: (title ~~ '%결제%'::text)      ← ~~ 가 LIKE 연산자다

-- 요구사항이 진짜 "포함 검색"이면 B-tree가 아니라 트라이그램 GIN 인덱스
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_posts_title_trgm ON posts USING gin (title gin_trgm_ops);
--  Bitmap Heap Scan on posts  /  Recheck Cond: (title ~~ '%결제%'::text)
```

B-tree로는 **튜닝이 아니라 구조적 한계**다. `pg_trgm`(3글자 조각 단위 인덱스)은 `%kw%`·`ILIKE`·정규식까지 태우지만 3글자 미만 검색어·인덱스 크기·갱신 비용의 한계가 있고, 그 너머는 전문 검색(`tsvector`)이나 검색 엔진이다 — [LIKE와 검색 전환](20-like-wildcard-fulltext-search-engine.md).

**PostgreSQL 고유 함정 — 접두 `LIKE 'kim%'`도 기본 인덱스를 못 탈 수 있다.** DB의 collation이 `C`가 아니면(대부분의 설치가 `en_US.UTF-8`·`ko_KR.UTF-8` 같은 언어 collation이다) 기본 B-tree는 접두 LIKE에 쓰이지 않는다.

```sql
-- name text, 기본 B-tree 인덱스 있음, DB collation = en_US.UTF-8
-- 접두 LIKE인데도 못 탄다
SELECT * FROM users WHERE name LIKE 'kim%';
--  Seq Scan on users  /  Filter: (name ~~ 'kim%'::text)

-- 패턴 매칭용 연산자 클래스로 인덱스를 만든다
CREATE INDEX idx_users_name_pattern ON users (name text_pattern_ops);
--  Index Scan using idx_users_name_pattern on users
--    Index Cond: ((name ~>=~ 'kim'::text) AND (name ~<~ 'kin'::text))   ← 구간으로 바뀌었다
--    Filter: (name ~~ 'kim%'::text)
```

이유는 전제 ②의 "쿼리와 같은 비교 규칙" 쪽이다. 언어 collation의 정렬은 바이트 순서와 다르다(대소문자·악센트·공백을 언어 규칙으로 섞어 정렬). 그 정렬에서 "kim으로 시작하는 문자열들"이 **연속 구간이라는 보장이 없으므로** 플래너가 `LIKE 'kim%'`를 `>= 'kim' AND < 'kin'` 범위로 바꾸지 못한다. `text_pattern_ops`는 바이트 단위로 정렬한 인덱스라 접두 구간이 성립한다.

대신 이 인덱스는 `<`/`>`/`ORDER BY name`에는 쓰이지 않으므로(2-6) 둘 다 필요하면 인덱스가 둘이거나 컬럼을 `COLLATE "C"`로 만든다. `ILIKE`는 어느 B-tree로도 안 된다 — `lower(name)` 표현식 인덱스(역시 `text_pattern_ops`) + `lower(name) LIKE 'kim%'`, 또는 `pg_trgm`.

> **MySQL 대조**: MySQL은 접두 `LIKE 'kim%'`가 기본 인덱스를 그냥 탄다 — collation 함정이 없다. MySQL에서 PostgreSQL로 옮긴 팀이 **가장 자주 밟는 지뢰**가 이것이다. `%kw%`는 MySQL도 B-tree로 못 타고 FULLTEXT ngram 파서를 쓴다.

### 2-4. 부류 A ④ — 복합 인덱스의 선두 컬럼을 안 썼다 (leftmost prefix 위반)

`(user_id, created_at)` 인덱스는 "`user_id`로 먼저 정렬하고, 같으면 `created_at`으로 정렬한" **하나의 트리**다. 전화번호부가 "성 → 이름" 순으로 정렬돼 있으면 성만으로도 찾을 수 있지만, **이름만으로는 못 찾는다** — 같은 이름이 책 전체에 흩어져 있기 때문이다.

```sql
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);

-- 못 탄다: 선두 컬럼 user_id 조건이 없다
SELECT * FROM orders WHERE created_at >= '2026-08-01';
--  Seq Scan on orders  /  Filter: (created_at >= ...)

-- 탄다: 선두 컬럼부터 붙었다
SELECT * FROM orders WHERE user_id = 100 AND created_at >= '2026-08-01';
--  Index Cond: ((user_id = 100) AND (created_at >= ...))

-- 대안: 전역 최근순 조회가 진짜 요구사항이라면 인덱스를 새로 만든다
CREATE INDEX idx_orders_created ON orders (created_at);
```

PostgreSQL 뉘앙스 — PostgreSQL의 B-tree는 선두 컬럼 조건이 없어도 "인덱스 전체를 훑으며 뒤 컬럼 조건을 검사하는" 식으로 쓸 수는 있다. 하지만 구간을 못 좁히니 거의 언제나 `Seq Scan`이 더 싸서 플래너가 버린다 — "못 탄다"가 아니라 "타 봐야 손해"라 결론은 같다(선두 고유값이 한 자릿수일 때의 skip scan은 PostgreSQL 18의 예외적 최적화다).

주의할 변형이 하나 더 있다. **선두 컬럼에 범위 조건이 오면 그 뒤 컬럼은 정렬이 깨져 구간을 못 좁힌다.**

```sql
-- user_id 범위까지만 구간을 좁히고, created_at은 인덱스 안에서 걸러내는 용도로만 쓰인다
SELECT * FROM orders WHERE user_id > 100 AND created_at = '2026-08-11';
--  Index Cond: ((user_id > 100) AND (created_at = ...))   ← 둘 다 Index Cond로 찍혀 겉으로는 구분이 안 된다
```

컬럼 순서 규칙과 "계획 텍스트로는 강등이 안 보이는" 문제는 [복합 인덱스 컬럼 순서](08-composite-index-column-order.md)에서 파고든다. 여기서는 **"선두 컬럼이 빠지면 인덱스가 아예 없는 것과 같다"** 만 확실히 붙잡으면 된다.

### 2-5. 부류 A ⑤ — `OR`로 묶인 조건, 그리고 부정 조건

전제 ③의 "**연속된 한 구간**"이 깨지는 경우다.

**`OR`**: 서로 다른 컬럼을 `OR`로 묶으면 인덱스 **하나로는** 시작점·끝점을 찍을 수 없다. 여기서 PostgreSQL은 한 걸음 더 간다 — **양쪽 컬럼에 각각 인덱스가 있으면** 두 인덱스를 따로 타서 TID 비트맵을 만들고 합친다.

```sql
SELECT * FROM users WHERE email = 'a@b.com' OR phone = '01012345678';

-- email·phone 양쪽에 인덱스가 있을 때 — 플래너가 알아서 둘을 합친다
--  Bitmap Heap Scan on users
--    Recheck Cond: ((email = 'a@b.com') OR (phone = '01012345678'))
--    ->  BitmapOr
--          ->  Bitmap Index Scan on idx_users_email   Index Cond: (email = 'a@b.com')
--          ->  Bitmap Index Scan on idx_users_phone   Index Cond: (phone = '01012345678')

-- 한쪽(phone)에 인덱스가 없으면 — 그쪽은 어차피 전체를 봐야 하므로
--   나머지 한쪽의 인덱스도 무의미해져 전체가 Seq Scan으로 간다
```

그래서 PostgreSQL에서 `UNION ALL` 분해(`... WHERE email = ? UNION ALL ... WHERE phone = ? AND email <> ?` — 두 조건을 모두 만족하는 행의 중복 방지)는 "OR 보이면 반사적으로"가 아니라 **계획에 `BitmapOr`가 안 잡힐 때** 쓰는 도구다 — 한쪽에 인덱스를 못 거는 사정이 있을 때, 조인 조건 안의 `OR`(`ON a.id = b.x OR a.id = b.y`)처럼 비트맵이 안 먹는 자리, 갈래마다 다른 `ORDER BY ... LIMIT`이 필요할 때.

**같은 컬럼**에 대한 `OR`는 `IN`으로 바꾸면 한 인덱스 스캔 안의 여러 짧은 구간으로 처리된다(`Index Cond: (status = ANY ('{READY,RUNNING}'))`).

**부정 조건**(`<>`, `!=`, `NOT IN`, `NOT LIKE`): "이 값이 **아닌** 것"은 정렬된 축 위에서 **한 점을 빼고 나머지 전부**를 뜻한다. 구간이 좌우로 갈라지고, 그 합이 사실상 전체다. 그래서 인덱스로 좁히는 의미가 없다.

```sql
-- 못 탄다: status가 DONE이 아닌 것 = 사실상 전 구간
SELECT * FROM jobs WHERE status <> 'DONE';
--  Seq Scan on jobs  /  Filter: (status <> 'DONE'::text)

-- "아닌 것"을 "인 것들의 열거"로 뒤집는다 → 짧은 구간 몇 개로 분해된다
SELECT * FROM jobs WHERE status IN ('READY', 'RUNNING', 'FAILED');

-- PostgreSQL의 정석: "DONE이 아닌 소수"만 담는 부분 인덱스
--   작업 큐처럼 대부분이 DONE이고 살아 있는 행이 소수인 테이블에 딱 맞는다
CREATE INDEX idx_jobs_open ON jobs (created_at) WHERE status <> 'DONE';
--  쿼리 WHERE에 status <> 'DONE'이 그대로 있어야 후보가 된다 (2-6)
```

> 엄밀히 말하면 부정 조건은 "**못 탄다**"기보다 "**타봐야 이득이 없다**"에 가깝고, 그래서 실제로는 ⑥번(부류 B)의 논리로 귀결된다. 면접에서 이 뉘앙스까지 붙이면 목록을 외운 게 아니라 이해했다는 신호가 된다.

**`IS NULL`은 다르다.** PostgreSQL의 B-tree는 NULL도 저장하고 한쪽 끝에 모아 두므로 `WHERE deleted_at IS NULL`은 `Index Cond`로 **탐색 가능**하다. `IS NOT NULL`은 사실상 전 구간이라 부정 조건과 같은 논리인데, NULL이 대부분인 컬럼이라면 "NOT NULL인 소수"만 담는 부분 인덱스가 답이다.

> **MySQL 대조**: MySQL에도 `OR`에서 인덱스 여럿을 합치는 index_merge(union) 최적화가 있지만 자주 포기해 **"OR 보이면 `UNION`으로 분해"가 관행**이 됐다. PostgreSQL은 `BitmapOr`가 기본 동작이라 순서가 반대다 — **분해하기 전에 계획부터 본다.**

### 2-6. PostgreSQL 고유 변형 셋 — 인덱스가 "있긴 한데" 이 쿼리에겐 없는 것과 같다

여기가 이 장의 기준 어휘가 걸린 자리다. 전제 ②의 "쿼리와 같은 비교 규칙"이 깨진 경우로, 쿼리는 멀쩡해 보이고 `\d orders`에 인덱스도 보이는데 안 탄다. `enable_seqscan = off`로도 `Seq Scan`이 그대로라 **부류 A**다. PostgreSQL에서만 나오는 형태가 정확히 셋이다.

**⑴ 부분 인덱스의 조건 불일치.** 부분 인덱스는 테이블의 **일부 행만** 담는 인덱스다(`CREATE INDEX ... WHERE status = 'FAILED'`). 담긴 행이 일부뿐이니, 플래너는 **"쿼리가 찾는 행이 전부 이 인덱스 안에 있다"를 증명할 수 있을 때만** 후보에 올린다. 증명이란 "쿼리의 WHERE가 인덱스의 WHERE를 함의한다"는 뜻이다.

- `WHERE status = 'FAILED' AND created_at > ?` — 탄다. 쿼리 조건이 인덱스 조건을 포함한다.
- `WHERE status IN ('FAILED','CANCELED')` — 못 탄다. CANCELED 행은 인덱스에 없다.
- `WHERE status = $1` — 못 탄다. **값을 모르니 증명 자체가 불가능**하다(제네릭 계획, 2-10).

그래서 부분 인덱스의 조건은 쿼리에 **리터럴로 박히는 고정 조건**에만 쓴다. "값이 파라미터로 들어오면 부분 인덱스는 후보에서 빠진다"는 것이 실무에서 가장 자주 밟는 지점이다.

**⑵ `INVALID` 인덱스.** `CREATE INDEX CONCURRENTLY`(쓰기를 막지 않고 인덱스를 만드는 방식)가 도중에 실패하면(타임아웃, 유니크 위반, 취소) 인덱스가 **`INVALID` 상태로 남는다.** 이 상태의 인덱스는 **플래너가 조회에 안 쓰면서 INSERT/UPDATE 때는 갱신은 된다** — 조회 이득 0에 쓰기 비용만 그대로인 최악의 조합이다. 배포 스크립트가 조용히 실패하면 아무도 모르게 이 상태가 된다.

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- 나오면 DROP INDEX 후 CREATE INDEX CONCURRENTLY 재시도
```

**⑶ 연산자 클래스·collation 불일치.** 인덱스는 "어떤 연산자에 답할 수 있는가"가 **연산자 클래스(operator class)** 로 정해진다. 연산자 클래스란 "이 인덱스가 값을 어떤 규칙으로 비교·정렬하는가"를 묶어 둔 정의다. 규칙이 다르면 정렬 순서가 달라지므로, 그 정렬로는 다른 규칙의 조건에 답할 수 없다.

- `text_pattern_ops` B-tree는 바이트 순 정렬이라 `LIKE 'kw%'`와 `=`에는 답하지만 `<`·`>`·`ORDER BY`(언어 collation 순)에는 안 쓰인다 — 2-3에서 본 그 인덱스다.
- `jsonb_path_ops` GIN은 "경로+값 해시"만 담아 `@>`에만 답하고 `?`(키 존재)에는 못 답한다.
- `COLLATE "C"`로 만든 인덱스는 기본 collation 비교에 안 쓰인다(그 반대도 마찬가지).

**쿼리가 실제로 쓰는 연산자 목록**을 놓고 인덱스를 고르는 것이 규율이다. 셋 다 증상이 같다 — "인덱스는 분명히 있는데 계획에 안 나온다."

### 2-7. 부류 B로 넘어간다 — PostgreSQL 인덱스 조회는 2단계다

여기가 이 문항의 진짜 깊이다. 조건식은 완벽하고 인덱스도 멀쩡하며 `enable_seqscan = off`를 주면 인덱스를 타는데, 기본 계획은 `Seq Scan`이다. **왜 원하는 행만 골라 읽는 게, 전체를 다 읽는 것보다 비쌀 수 있는가?**

답은 PostgreSQL의 저장 구조에 있다. PostgreSQL 테이블은 **힙**이다 — 행이 8KB 페이지에 들어온 순서와 빈자리 사정에 따라 놓이고, 어떤 순서도 보장하지 않는다. 그리고 모든 인덱스의 리프에는 **(키 값, TID)** 만 있다. 그래서 조회가 두 단계로 나뉜다.

```text
[1단계] B-tree 탐색
  status = 'ACTIVE' 인 리프 구간을 찾아 옆으로 훑으며 TID를 수집한다.
  → 리프는 오른쪽 링크로 이어져 있으므로 이 단계는 대체로 순차적이고 싸다.
  결과: [(8231,3), (4,17), (99120,1), (577,9), (31,22), ...]   ← 블록 번호가 뒤죽박죽

[2단계] TID 하나하나로 힙 페이지를 열어 행을 읽는다 — 힙 페치(heap fetch)
  블록 8231 → 페이지 열기 → 3번 튜플 / 블록 4 → 17번 튜플 / 블록 99120 → 1번 튜플 ...
  → 흩어진 페이지를 하나씩 찌른다 = 랜덤 I/O.
    (이 행이 내 스냅샷에 보이는 버전인지 — MVCC 가시성 확인 — 도 여기서 일어난다)
```

**핵심은 2단계가 "행 하나당 페이지 접근 한 번"이라는 것**이다. 대상이 30만 행이면 페이지를 30만 번 연다. 게다가 그 30만 번이 `shared_buffers`·OS 페이지 캐시에 없으면 디스크의 서로 멀리 떨어진 곳을 찌른다.

> **도서관 비유**
> 1단계는 색인 카드를 훑어 청구기호를 적는 것. 2단계는 그 청구기호를 들고 서가 사이를 뛰어다니며 책을 한 권씩 뽑는 것. 찾을 책이 10권이면 색인이 압도적으로 이득이다. 그런데 **장서의 30%를 뽑아야 한다면?** 서가 사이를 30만 번 왕복하느니 **1번 서가부터 순서대로 쓸어 담는 게** 훨씬 빠르다. 이게 풀스캔이다.

### 2-8. 랜덤 I/O vs 순차 I/O — 페이지 읽기 횟수로 세어 본다

"비싸다/싸다"를 말로만 하면 안 남는다. **페이지 개수로 세면 남는다.** 아래 표의 `orders`로 계산해 보자.

```text
orders 100만 행, 행 폭 약 68바이트 → 힙 페이지 하나에 약 120행
  힙 전체 = 1,000,000 ÷ 120 ≈ 8,334 페이지        (EXPLAIN 의 Buffers: shared hit=8334 가 이 값이다)

status 인덱스의 리프 엔트리 = 헤더 8B + 값 8B + 라인 포인터 4B = 20B
  → 페이지(유효 8,152B)당 약 400개, fillfactor 90 을 보면 약 360개
```

**(가) `status = 'ACTIVE'` — 90만 행(전체의 90%)**

```text
[인덱스 경로]  1단계 리프 훑기 : 900,000 ÷ 360 ≈ 2,500 페이지  (순차, 쌈)
               2단계 힙 페치   : 900,000 번                     (랜덤, 비쌈)
               ────────────────────────────────────────────────
               합계 약 902,500 번의 페이지 접근

[Seq Scan]     8,334 페이지를 처음부터 끝까지 순차로 한 번씩

               902,500 ÷ 8,334 ≈ 108배
```

힙 페이지는 8,334장뿐인데 힙 페치는 90만 번이다. **같은 페이지를 평균 108번씩 다시 여는 셈이다** — 페이지 하나에 120행이 들어 있으니, 그 120행이 인덱스 순서에서는 서로 멀리 떨어져 있어 한 번에 처리되지 못하고 따로따로 방문된다. 게다가 그 접근 하나하나가 랜덤이라 플래너의 비용표에서는 순차의 4배(`random_page_cost` 4.0 대 `seq_page_cost` 1.0)로 계산된다. **"적게 읽지만 비싸게 읽기"가 "많이 읽지만 싸게 읽기"에 진다.**

**(나) `status = 'FAILED'` — 1만 행(전체의 1%)**

```text
[인덱스 경로]  1단계 리프 훑기 : 10,000 ÷ 360 ≈ 30 페이지
               2단계 힙 페치   : Bitmap 으로 TID 를 블록 순 정렬 → 실제로 여는 페이지 2,412장
               ────────────────────────────────────────────────
               합계 약 2,442 페이지

[Seq Scan]     8,334 페이지

               2,442 vs 8,334  →  인덱스가 3.4배 유리
```

같은 인덱스인데 **값이 바뀌자 승패가 뒤집힌다.** 이것이 "플래너는 비용을 계산한다"의 가장 좋은 실증이다.

**풀스캔이 싼 이유는 단순히 "인덱스를 안 뒤져서"가 아니다.** 네 가지가 겹친다.

- **순차 I/O**: 페이지를 물리적으로 이어진 순서대로 읽는다. 회전 디스크에서 순차와 랜덤의 차이는 크고, SSD에서도 여전히 차이가 난다.
- **미리 읽기(read-ahead)**: PostgreSQL은 자체 미리 읽기 없이 **OS 페이지 캐시의 read-ahead**에 기댄다(`shared_buffers` + OS 캐시의 이중 캐시). 순차 스캔은 이 혜택을 그대로 받고, 랜덤 접근에는 걸리지 않는다.
- **행 하나당 오버헤드가 없다**: 페이지를 열면 그 안의 행을 전부 쓴다. 힙 페치는 **한 행 쓰자고 페이지 하나를 여는** 일이 반복될 수 있다((가)에서 본 108배가 그것이다).
- **병렬**: 큰 테이블은 `Parallel Seq Scan`으로 워커 여럿이 나눠 읽는다. `Gather`가 보이면 "인덱스가 없어서"가 아니라 **대량 스캔의 정상 선택**일 수 있다.

**PostgreSQL 고유의 완충 장치 — `Bitmap Heap Scan`.** PostgreSQL은 "인덱스 아니면 풀스캔"의 2지선다가 아니다. 1단계에서 TID를 전부 모아 **블록 번호 순으로 정렬**한 뒤 힙 페이지를 **한 장씩 한 번만** 방문하는 중간 단계가 있다 — 청구기호를 서가 순서로 정렬해 놓고 한 바퀴만 도는 것이다. (나)에서 힙 페치 1만 번이 페이지 2,412장으로 접힌 게 이 효과다.

| 대상 비율 | 플래너의 선택 | 힙 접근 패턴 |
|---|---|---|
| 아주 적음 | `Index Scan` | 인덱스 순서대로 힙을 찌른다(랜덤) |
| 중간 | `Bitmap Index Scan` → `Bitmap Heap Scan` | TID를 블록 순으로 정렬해 한 페이지 한 번씩(순차에 가까움). `Recheck Cond`가 붙고, 비트맵이 `work_mem`을 넘치면 페이지 단위(`lossy`)로 기억해 페이지 안 모든 행을 재검사 |
| 많음 | `Seq Scan` (큰 테이블이면 `Gather` 아래 `Parallel Seq Scan`) | 처음부터 끝까지 순차 |

**오해 주의**: `Bitmap Heap Scan`은 **인덱스를 쓴 계획**이다. "Heap Scan"이라는 글자만 보고 풀스캔으로 오독하는 일이 잦다.

**그래서 손익분기가 생긴다.** 대상 행이 전체의 일정 비율을 넘는 순간 인덱스가 진다. 흔히 인용되는 어림값이 **전체의 20~30% 안팎**인데, PostgreSQL에서는 경계가 위 표처럼 세 단계로 나뉘고 `Index Scan`의 임계는 `random_page_cost`·`correlation`·캐시 가정·행 폭에 따라 한 자릿수 %까지 내려가며 그 위를 `Bitmap Heap Scan`이 채운다. **경험적 기준**이지 고정 상수가 아니다. 면접에서는 **정확한 수치보다 "손익분기가 존재한다는 사실과 그 이유"**가 훨씬 중요하다.

비용 파라미터도 같이 말할 수 있어야 한다. `random_page_cost = 4.0`은 "랜덤 페이지 한 장을 순차 네 장 값으로 친다"는 뜻이고, 이 비율이 손익분기를 정한다. 캐시 적중률이 높거나 SSD인 환경에서 4.0을 그대로 두면 플래너가 **인덱스 스캔을 실제보다 비싸게 봐서 `Seq Scan`으로 기운다** — 1.1 근처로 낮추는 것이 SSD 환경의 관행이다. `effective_cache_size`는 "캐시가 이만큼 있다"고 플래너에게 알려주는 값으로(메모리를 잡는 설정이 아니다), 클수록 인덱스 스캔의 반복 페이지 접근이 싸다고 추정한다.

**(가산점 포인트) 물리 순서 상관관계.** PostgreSQL은 힙 순서를 보장하지 않는 대신 "인덱스 순서와 힙의 물리 순서가 얼마나 비슷한가"를 **통계로 안다** — `pg_stats.correlation`(−1 ~ 1). 추가 순으로 쌓이는 컬럼(`created_at`, 시퀀스 `id`)은 1에 가깝고, 인덱스 순으로 읽어도 힙이 사실상 순차라 플래너가 `Index Scan` 비용을 낮게 계산한다. 그래서 **같은 30%라도 `created_at` 범위는 인덱스를 타고 `status`는 안 타는** 일이 생긴다.

### 2-9. 그래서 `status`, `is_deleted` 같은 컬럼은 인덱스가 무시된다

용어를 갈라 놓자. **선택도(selectivity)** 는 그 조건이 전체 행을 몇 %로 좁히는가이고, **카디널리티(cardinality)** 는 그 컬럼에 서로 다른 값이 몇 개나 있는가다. 값 종류가 몇 개 안 되면(카디널리티가 낮으면) 어떤 값으로 조회해도 결과가 전체의 상당 비율이 된다(선택도가 낮다).

```sql
-- orders 100만 건, status는 'ACTIVE' 90만 / 'DONE' 9만 / 'FAILED' 1만
CREATE INDEX idx_orders_status ON orders (status);

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE status = 'ACTIVE';
--  Seq Scan on orders  (cost=0.00..20834.00 rows=900000 width=72) (actual rows=900000 loops=1)
--    Filter: (status = 'ACTIVE'::text)
--    Rows Removed by Filter: 100000
--    Buffers: shared hit=8334
--  → 인덱스가 있는데도 안 쓴다. 힙 페치 90만 번 vs 8334 페이지 순차 1회. 플래너가 옳다(2-8 가).

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE status = 'FAILED';
--  Bitmap Heap Scan on orders  (rows=10000 width=72) (actual rows=10000 loops=1)
--    Recheck Cond: (status = 'FAILED'::text)
--    Heap Blocks: exact=2412
--    ->  Bitmap Index Scan on idx_orders_status  (actual rows=10000 loops=1)
--          Index Cond: (status = 'FAILED'::text)
--  → 같은 인덱스인데 이번엔 탄다. 대상 1%, 페이지 2412장만 만지면 된다(2-8 나).
```

**같은 컬럼, 같은 인덱스인데 값에 따라 계획이 달라진다**는 이 사실이 "플래너는 비용을 계산한다"의 가장 좋은 실증이다. 후보자가 답한 "풀스캔이 비용이 싼 경우"라는 방향은 옳았고, 여기에 **왜 싼지**의 근거가 바로 2-8의 랜덤/순차 비용 모델이다.

값마다 다른 판단이 가능한 것은 `pg_stats`의 **최빈값 목록(`most_common_vals` / `most_common_freqs`)** 덕분이다 — `{ACTIVE,DONE,FAILED} / {0.90,0.09,0.01}`을 들고 있으니 값별로 행 수를 다르게 추정한다.

처방은 세 가지다.

```sql
-- ① 복합 인덱스 + LIMIT: 대상이 90만이어도 "최근 20개" 화면이면 구간 끝에서 20개만 읽고 끝난다
CREATE INDEX idx_orders_status_created ON orders (status, created_at);
SELECT * FROM orders WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 20;
--  Limit → Index Scan Backward using idx_orders_status_created  (actual rows=20)

-- ② 부분 인덱스 — PostgreSQL의 정석: 희귀한 값만 인덱싱한다
--    인덱스가 1만 엔트리로 작아지고, 쓰기 비용도 FAILED 행에만 붙는다
CREATE INDEX idx_orders_failed ON orders (created_at) WHERE status = 'FAILED';

-- ③ 커버링 — INCLUDE로 비키 컬럼을 리프에 얹어 힙 페치(2단계) 자체를 없앤다
CREATE INDEX idx_orders_status_cover ON orders (status, created_at) INCLUDE (amount);
SELECT status, created_at, amount FROM orders WHERE status = 'ACTIVE';
--  Index Only Scan using idx_orders_status_cover on orders
--    Heap Fetches: 0     ← 0에 가까워야 진짜 커버링. 크면 VACUUM이 밀려 visibility map이 낡은 것
--  힙 페치가 사라지면 손익분기 자체가 움직인다 — 좁은 인덱스를 훑는 게 넓은 테이블을 훑는 것보다 싸진다.
```

③이 왜 판을 뒤집는지는 2-8의 계산으로 바로 보인다 — (가)에서 902,500번의 페이지 접근 중 900,000번이 힙 페치였다. 그게 0이 되면 인덱스 경로 비용이 2,500 페이지로 줄어 8,334보다 싸진다.

### 2-10. 선택도 말고도 플래너가 "안 타는" 이유 넷 (PostgreSQL 고유)

`enable_seqscan = off`로 나온 인덱스 계획이 **실측으로 더 빠른데도** 기본 계획이 `Seq Scan`이라면 플래너가 틀린 것이다. 원인은 대개 이 넷 중 하나다.

| 원인 | 왜 틀리나 | 계획에서의 단서 | 처방 |
|---|---|---|---|
| **통계가 낡음** | 대량 적재·삭제 직후. autovacuum의 ANALYZE는 변경이 테이블의 10%를 넘어야 돌아서(`autovacuum_analyze_scale_factor` 0.1) 큰 테이블에서 둔하다 | `rows=추정`과 `actual rows`가 자릿수로 다르다 | `ANALYZE` (3-3) |
| **`random_page_cost` 미조정** | SSD·캐시 환경에서 4.0은 랜덤 I/O 과대평가 | 추정은 맞는데 인덱스 계획이 실측으로 훨씬 빠르다 | 1.1 근처로, `effective_cache_size` 점검 |
| **테이블이 작음** | 페이지 몇 장이면 트리를 내려가는 것보다 그냥 읽는 게 싸다. 개발 DB의 "인덱스 안 타요" 대부분 | `pg_class.relpages`가 한 자릿수~수십 | 정상. 실전 규모 데이터로 다시 본다 |
| **제네릭 계획** | 같은 준비문을 5회 실행하면 서버가 파라미터 값을 모르는 "평균 계획"으로 갈아탈 수 있다(pgjdbc도 5회 뒤 서버 준비문 사용). `status = $1`을 평균 선택도로 보고 `Seq Scan`을 고정하면 `FAILED` 조회도 풀스캔. 부분 인덱스가 후보에서 빠지는 것(2-6 ⑴)도 같은 이유 | **앱에서만 느리고 psql에서 리터럴로 치면 빠르다** | `plan_cache_mode = force_custom_plan`, 부분 인덱스 조건은 리터럴로. [실행 계획 급변](31-execution-plan-sudden-change.md) |

### 2-11. 이 절이 떠받치는 다음 주제들

랜덤 I/O vs 순차 I/O, 그리고 힙 페치는 **뒤에 나오는 여러 문항의 공통 토대**다. 여기서 확실히 잡아두면 나머지가 파생으로 풀린다.

- **힙과 TID, 클러스터드 인덱스의 부재** — PostgreSQL에는 "테이블 = PK 인덱스"인 클러스터드 구조가 없고 모든 인덱스가 힙을 가리킨다. 힙 페치가 항상 따라붙는 대신 UPDATE는 인덱스 갱신을 건너뛸 수 있다(HOT). [클러스터드 vs 세컨더리](03-clustered-vs-secondary-index.md).
- **커버링 인덱스** — 힙 페치(2단계)를 **아예 제거**하는 기법. PostgreSQL에서는 `Index Only Scan`이고 효과가 visibility map(VACUUM 상태)에 좌우된다. [커버링 인덱스](09-covering-index.md).
- **깊은 페이지네이션** — `LIMIT 20 OFFSET 100000`이 느린 이유가 정확히 "버릴 10만 건에 대해서도 힙 페치를 다 수행한다"이다. [OFFSET vs 커서](13-deep-pagination-offset-vs-cursor.md).
- **`SELECT ... FOR UPDATE`가 인덱스를 못 탈 때** — PostgreSQL은 조건에 안 맞는 행을 잠그지는 않지만, `Seq Scan`으로 트랜잭션이 길어지는 만큼 락 보유 시간이 늘고 VACUUM을 막는다. "인덱스를 못 탄다"가 **동시성·운영 문제**가 되는 경로. [FOR UPDATE 락 범위](19-select-for-update-lock-scope.md).

구조 쪽 배경은 [인덱스와 B+Tree](01-index-and-bplus-tree.md)에 정리돼 있다.

---

## 3. 진단 — `EXPLAIN (ANALYZE, BUFFERS)`에서 무엇을 보는가

"인덱스 있는데 왜 느리지"에서 멈추지 않으려면 **볼 것이 정해져 있어야** 한다. PostgreSQL에서는 네 가지다.

### 3-1. 실제 출력에서 한 줄씩 짚어 본다

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE date(created_at) = '2026-08-11' AND status = 'ACTIVE';

 Seq Scan on orders  (cost=0.00..23334.00 rows=4500 width=72)
                     (actual time=0.041..389.226 rows=31240 loops=1)
   Filter: ((date(created_at) = '2026-08-11'::date) AND (status = 'ACTIVE'::text))
   Rows Removed by Filter: 968760
   Buffers: shared hit=2210 read=6124
 Planning Time: 0.184 ms
 Execution Time: 391.702 ms
```

한 줄씩 읽는 법이다.

- **`Seq Scan on orders`** — 스캔 노드 이름. 이게 접근 방식이다. 풀스캔이라는 뜻이니 여기서 판별(1-5)로 간다. 단 `Bitmap Heap Scan`은 인덱스를 쓴 것이고, `Parallel Seq Scan`은 대량 스캔의 정상 선택일 수 있다.
- **`rows=4500`(추정) vs `actual ... rows=31240`(실제)** — 플래너의 예상과 현실. **7배 차이다.** 원인은 `date(created_at)`이 표현식이라 통계가 아예 없어서 기본 선택도로 찍은 값이기 때문이다(3-3). 추정이 이렇게 틀리면 이 노드 하나가 아니라 이 쿼리 전체의 계획(조인 순서·방식)이 틀어진다.
- **`Filter:` 에 조건이 전부 있다** — 조건을 **인덱스에서 걸렀는가(`Index Cond`), 힙에서 걸렀는가(`Filter`)** 를 가르는 자리다. 여기서는 둘 다 `Filter`라 인덱스가 구간을 전혀 못 좁혔다는 뜻이다.
- **`Rows Removed by Filter: 968760`** — 그 낭비의 계산서. 100만 행을 읽어 96만 8천 행을 버렸다. **읽은 행 대비 반환 행의 비율**이 이 숫자로 보인다.
- **`Buffers: shared hit=2210 read=6124`** — 실제로 만진 8KB 페이지 수. `hit`은 `shared_buffers`에서 찾은 것, `read`는 커널에 요청한 것(디스크까지 갔다는 보장은 아니다 — OS 페이지 캐시 적중일 수 있다). 합 8,334가 2-8에서 계산한 힙 전체 페이지 수와 정확히 같다 — **테이블을 통째로 읽었다는 물증**이다.
- **`Execution Time` vs `Planning Time`** — 실행이 압도적이면 데이터 접근 문제, 계획 시간이 유난히 길면 파티션·인덱스 후보가 너무 많은 쪽을 의심한다.

표로 정리하면 이렇다.

| 볼 것 | 무엇을 보나 | 나쁜 신호 |
|---|---|---|
| **스캔 노드 이름** | 접근 방식 | `Seq Scan`(풀스캔). 단 `Bitmap Heap Scan`은 인덱스를 쓴 것이고, `Parallel Seq Scan`은 대량 스캔의 정상 선택일 수 있다 |
| **`Index Cond` vs `Filter`** | 조건이 인덱스에서 걸러졌나, 힙에서 걸러졌나 | 조건이 전부 `Filter`에만 있다 = 인덱스가 구간을 못 좁혔다. `Rows Removed by Filter`가 그 낭비의 계산서 |
| **`rows=추정` vs `actual rows`** | 플래너의 예상과 현실 | 자릿수가 다르면 통계 문제(3-3). 위 예시의 4500 vs 31240은 표현식 `date(created_at)`에 통계가 없어 기본 선택도로 찍은 값 |
| **`Buffers`** | 실제로 만진 페이지 수 | `shared read`가 크면 디스크 I/O, `hit + read` 합이 결과 행 수에 비해 자릿수로 크면 과다 스캔 |

좋은 신호도 함께 외워두면 대비가 된다 — `Index Scan`에 **모든 조건이 `Index Cond`로** 걸려 있거나, `Index Only Scan` + **`Heap Fetches: 0`**(커버링이 성립해 힙 페치가 사라졌다는 뜻)이 최고의 신호다.

### 3-2. 판단 흐름

```text
1) 스캔 노드가 Seq Scan 인가?
   ├─ 예 → BEGIN; SET LOCAL enable_seqscan = off; EXPLAIN ...; ROLLBACK; 로 판별
   │        ├─ 여전히 Seq Scan → 부류 A (형태). Filter 절을 읽는다:
   │        │     함수·연산이 컬럼을 감쌌나 (date(col), lower(col))         → 원인 ①
   │        │     캐스트가 컬럼 쪽에 붙었나 ((col)::numeric)                  → 원인 ②
   │        │     col ~~ '%...' 인가 / 접두인데 collation 이 C 가 아닌가       → 원인 ③
   │        │     복합 인덱스인데 선두 컬럼 조건이 없나                        → 원인 ④
   │        │     OR / <> / NOT IN 이 있나                                    → 원인 ⑤
   │        │     부분 인덱스 조건 불일치 / indisvalid = false / 연산자 클래스  → 2-6
   │        └─ Index Scan / Bitmap 으로 바뀜 → 부류 B (비용). 두 계획의 cost 와 실측을 비교하고:
   │              대상 비율을 잰다 (아래 count 쿼리)                          → 원인 ⑥ (플래너가 옳다)
   │              rows 추정과 actual 이 자릿수로 다르다                        → 통계 (ANALYZE, 3-3)
   │              추정은 맞는데 인덱스 계획이 실측으로 훨씬 빠르다             → random_page_cost
   │              relpages 가 몇 장 안 된다                                    → 작은 테이블 (정상)
   │              앱에서만 느리고 psql 에서는 빠르다                           → 제네릭 계획 (2-10)
   └─ 아니오 → 인덱스는 탔다. 그런데도 느리다면
            ├─ Rows Removed by Filter 가 크다          → 인덱스가 못 좁히고 힙에서 걸렀다 (복합·부분 인덱스)
            ├─ Bitmap Heap Scan 에 lossy / Heap Blocks 가 크다 → 대상이 많다 (선택도, work_mem)
            ├─ Index Only Scan 인데 Heap Fetches 가 크다 → visibility map 이 낡았다 (VACUUM)
            ├─ Sort 노드에 external merge Disk           → 정렬이 인덱스 순서와 안 맞는다
            ├─ Limit 아래 actual rows 가 LIMIT 보다 훨씬 크다 → OFFSET (키셋 페이지네이션)
            └─ Nested Loop 안쪽의 loops 가 크다          → 조인 문제 (06 문서)
```

원인 ⑥이 의심되면 **실제로 몇 %인지 세어보는 것**이 가장 확실한 확인법이다.

```sql
SELECT count(*) FILTER (WHERE status = 'ACTIVE') * 100.0 / count(*) AS pct FROM orders;
-- 수십 %라면 플래너가 인덱스를 버린 판단이 옳을 가능성이 높다.
-- 세지 않고 빠르게: SELECT most_common_vals, most_common_freqs FROM pg_stats
--                   WHERE tablename = 'orders' AND attname = 'status';
```

### 3-3. `rows`는 **추정값**이다 — 통계가 낡으면 오판한다

플래너는 실제 데이터를 세어보고 판단하는 게 아니라, `ANALYZE`가 표본에서 수집해 둔 **통계(`pg_stats` — `n_distinct`, 최빈값 목록, 히스토그램, `correlation`)** 를 보고 추정한다.

갱신은 autovacuum이 자동으로 하지만 임계가 "테이블의 10% 변경"이라, 대량 적재나 대량 삭제 직후에는 통계가 현실과 크게 어긋나서 **"멀쩡한 쿼리가 어느 날 갑자기 느려지는"** 현상이 생긴다. 3-1에서 본 "추정 4,500 대 실제 31,240" 같은 괴리가 그 신호다.

```sql
ANALYZE orders;                                  -- 계획이 이상하면 통계부터 갱신 (쓰기를 막지 않는 가벼운 작업)

SELECT last_autoanalyze, n_live_tup, n_dead_tup  -- 언제 마지막으로 갱신됐나
FROM pg_stat_user_tables WHERE relname = 'orders';

ALTER TABLE orders SET (autovacuum_analyze_scale_factor = 0.02);  -- 큰 테이블은 임계를 10% → 2%로
-- 배치 적재 뒤에는 명시적으로 ANALYZE를 한 줄 넣는다
```

표본이 모자라 편중 분포를 못 잡으면 `ALTER TABLE ... ALTER COLUMN status SET STATISTICS 1000`(기본 `default_statistics_target` 100), 컬럼 간 상관관계로 추정이 곱셈으로 무너지면 `CREATE STATISTICS`. 그리고 **표현식 조건(`date(created_at) = ?`)에는 통계가 아예 없다** — 3-1에서 4,500으로 찍힌 이유다. 표현식 인덱스를 만들면 `ANALYZE`가 그 통계도 수집한다(2-1).

**(가산점 포인트)** `EXPLAIN ANALYZE`는 쿼리를 실제로 실행해 **추정이 아닌 실측 행 수와 소요 시간**을 보여준다. 추정 `rows`와 실측이 크게 벌어지면 그게 곧 "통계가 틀렸다"는 증거다. 실제로 실행되므로 운영 DB의 무거운 쿼리에는 주의하고, `UPDATE`/`DELETE`는 반드시 `BEGIN; ... ROLLBACK;`으로 감싼다.

### 3-4. 사후가 아니라 상시로 잡는다

`pg_stat_user_tables`의 `seq_scan`·`seq_tup_read`가 계속 느는 큰 테이블(누군가 인덱스를 못 타고 있다), `pg_stat_user_indexes.idx_scan = 0`인 인덱스(아무도 안 쓴다 — 2-6의 `INVALID`·연산자 클래스 불일치도 여기서 드러난다), `pg_stat_statements`의 `shared_blks_read` 상위 쿼리, `auto_explain`으로 느린 쿼리의 **실제 계획 + Buffers** 자동 기록. 프로세스 전체는 [EXPLAIN 읽기와 개선 프로세스](10-explain-and-slow-query-process.md)에서.

> **MySQL 대조 (표기법)**: MySQL `EXPLAIN`은 표 한 줄 — `type`(`ALL`/`index`/`range`/`ref`), `key`(`NULL`이면 미사용), `rows`, `Extra`(`Using index`/`Using filesort`/`Using temporary`). 대응은 `type: ALL`이 `Seq Scan`, `key: NULL`이 `Index Cond` 없음, `Using index`가 `Index Only Scan`(단 PostgreSQL은 `Heap Fetches`를 같이 봐야), `Using filesort`가 `Sort` 노드, `Using index condition`(ICP)은 PostgreSQL에서 따로 표기 없이 `Index Cond`에 포함. 결정적 차이는 PostgreSQL은 노드마다 **추정 rows·실제 rows·Buffers가 같이 찍혀 "왜"까지 한 화면에서 읽힌다**는 것.

---

## 4. 꼬리질문 대비 포인트

### "타입 불일치에서 왜 하필 컬럼 쪽이 변환되나요? 리터럴을 컬럼 타입으로 바꾸면 인덱스를 살릴 수 있잖아요?"

**결과 집합이 달라질 수 있는 방향으로는 DB가 알아서 바꿔 주지 않기 때문이다.** PostgreSQL의 암묵 캐스트는 **정보를 잃지 않는 방향**에만 있다 — `bigint → numeric`은 되고 `numeric → bigint`는 안 된다. 그래서 `bigint 컬럼 = numeric 값`을 만나면 "컬럼을 numeric으로 올린다"는 선택지밖에 없고, 그 순간 인덱스의 원본 값과 형태가 달라져 원인 ①과 같은 상황이 된다.

문자열과 숫자 사이는 어느 방향도 안전하지 않아(`'01012345678'`과 `'1012345678'`은 문자열로는 다르지만 숫자로는 같다 — 비가역 변환) PostgreSQL은 아예 비교를 거부하고 에러를 낸다. **DB는 성능보다 정확성을 우선한다**는 원칙이고, 그 에러 HINT를 보고 **컬럼 쪽에** 캐스트를 붙이는 게 최악의 대응이다. 살리는 방향은 항상 **값(리터럴·파라미터) 쪽을 컬럼 타입에 맞추는 것**이고, 그러려면 애플리케이션의 필드 타입이 컬럼 타입과 같아야 한다.

### "`OR`를 `UNION ALL`로 바꾸면 항상 빨라지나요?" (시니어 변별 포인트)

**아니다. PostgreSQL에서는 먼저 계획부터 본다 — 이미 `BitmapOr`로 두 인덱스를 합쳐 처리하고 있을 가능성이 높다.** 그 위에서 세 가지를 확인한다.

⑴ **의미가 바뀔 수 있다** — 두 조건을 모두 만족하는 행은 `UNION ALL`에서 두 번 나온다. `UNION`으로 바꾸면 중복은 제거되지만 정렬·해시 비용이 붙는다.

⑵ **양쪽 다 인덱스를 탈 수 있어야 이득이다** — 한쪽에 인덱스가 없으면 분해해봐야 그 갈래가 풀스캔이라 총비용이 오히려 늘 수 있다.

⑶ **같은 컬럼의 `OR`라면 분해가 아니라 `IN`이 정답**이다.

분해가 실제로 이기는 자리는 **조인 조건 안의 `OR`**(비트맵이 안 먹어 조인 방식이 무너진다)나 갈래마다 다른 `ORDER BY ... LIMIT`이 필요한 경우다. **재작성 전후를 `EXPLAIN (ANALYZE, BUFFERS)`로 비교해 근거를 만든 다음에 바꾼다.** "`OR` 보면 무조건 `UNION`"은 튜닝이 아니라 미신이다.

### "`<>`나 `NOT IN`은 정말 무조건 인덱스를 못 타나요?"

"**못 탄다**"보다 "**타봐야 이득이 없는 게 보통이다**"가 정확한 표현이다. 부정 조건은 정렬 축 위에서 한 점을 뺀 나머지 전부를 가리키므로 결과가 대개 전체의 대부분이 되고, 그러면 2-8의 논리대로 풀스캔이 이긴다. **예외는 셋이다.**

⑴ 값이 극단적으로 편중돼 "아닌 것"이 오히려 소수인 경우 — 99%가 `'DONE'`인 작업 큐의 `status <> 'DONE'`은 1%만 고른다. 플래너는 `pg_stats`의 최빈값 목록으로 이걸 알고 있어 인덱스를 고를 수 있다.

⑵ **커버링(`Index Only Scan`)**인 경우 — 힙 페치가 없으니 인덱스 전체를 훑어도 좁은 인덱스를 읽는 편이 넓은 테이블을 읽는 것보다 싸다.

⑶ 그리고 PostgreSQL의 정답 — **부정 조건 그대로를 부분 인덱스로** 만드는 것(`CREATE INDEX ... WHERE status <> 'DONE'`). 인덱스가 "아닌 것"만 담으니 구간 문제 자체가 사라진다.

즉 부정 조건 항목은 ⑤번(구조) 얼굴을 하고 있지만 속은 ⑥번(비용)이다.

### "인덱스는 제대로 탔는데(`Index Scan`이 찍혔는데)도 느립니다. 어디를 봐야 하나요?" (시니어 변별 포인트)

`Index Scan`이 찍혔다고 끝이 아니다. 확인 순서는 이렇다.

⑴ **`Rows Removed by Filter`가 큰가** — 인덱스가 구간을 제대로 못 좁혀 힙에서 행을 가져온 뒤에야 버리고 있다. 버릴 행에도 힙 페치를 이미 지불한 상태. 복합 인덱스로 조건을 `Index Cond`로 끌어올리거나 부분 인덱스를 검토한다.

⑵ **`Buffers`의 `hit + read`가 결과 행 수에 비해 자릿수로 큰가** — 좁히긴 했는데 힙 페치가 대량 발생하는 케이스. `SELECT *`를 필요한 컬럼만으로 줄이고 `INCLUDE` 커버링을 검토한다. 이 하나로 몇 배가 빨라지는 일이 흔하다.

⑶ **`Index Only Scan`인데 `Heap Fetches`가 큰가** — 커버링은 성립했는데 visibility map이 낡아 힙을 다시 보고 있다. VACUUM이 밀린 것이고 대개 롱 트랜잭션이 원인이다.

⑷ **`Sort` 노드에 `external merge Disk:`** — 정렬을 인덱스가 처리하지 못해 디스크 정렬이 붙었다. 정렬 컬럼을 인덱스 뒤쪽에 넣거나 `work_mem`을 본다.

⑸ **`Limit` 아래 스캔의 `actual rows`가 LIMIT보다 훨씬 큰가** — 깊은 `OFFSET`. 버릴 행에도 힙 페치를 전부 수행하므로 키셋 방식으로 재설계한다.

⑹ **`Nested Loop` 안쪽의 `loops`가 큰가** — 이 스캔이 조인 안쪽에서 수만 번 반복되고 있다. 인덱스 문제가 아니라 조인 문제다.

⑺ **락 대기인가** — 계획은 멀쩡한데 느리다면 `pg_stat_activity`의 `wait_event_type = 'Lock'`을 본다. 성능이 아니라 동시성 문제일 수 있다.

### "플래너가 틀렸다고 확신할 때 인덱스를 강제로 태워도 되나요?" (시니어 변별 포인트)

**PostgreSQL에는 `FORCE INDEX`가 없다 — 그리고 그게 정석을 강제한다.** 순서는 이렇다.

⑴ `ANALYZE`로 **통계를 갱신**한다 — "플래너가 이상해요" 사례의 상당수가 낡은 통계 탓이고, 힌트 없이 해결된다.

⑵ `EXPLAIN (ANALYZE, BUFFERS)`로 **추정 `rows`와 실측을 비교**해 정말 오판인지 근거를 만든다. 추정이 틀렸으면 `SET STATISTICS`로 표본을 키우거나 `CREATE STATISTICS`로 컬럼 상관관계를 알려준다.

⑶ 추정은 맞는데 선택이 틀렸으면 **비용 파라미터**를 본다 — SSD인데 `random_page_cost = 4.0`이면 그것부터. 쿼리 하나가 아니라 서버 전체의 판단을 고치는 일이라 효과가 넓다.

⑷ 그래도 안 되면 **인덱스 설계 자체를 고친다** — 복합 인덱스로 선택도를 올리거나, 부분 인덱스로 대상을 줄이거나, `INCLUDE`로 커버링을 만들면 플래너가 알아서 고른다. 앱에서만 느리면 제네릭 계획을 의심하고 `plan_cache_mode`를 본다.

⑸ 최후 수단이 `pg_hint_plan` 확장이나 `enable_seqscan = off`를 코드에 박는 것인데, **힌트는 코드에 박히는 부채**다. 지금은 옳아도 **데이터 분포가 바뀌거나 DB를 업그레이드하면 그 힌트가 틀린 선택을 고정**시키고, 플래너는 개선되었는데 우리 쿼리만 과거에 묶인다. 쓴다면 **주석으로 "왜 강제했는지, 언제 재검토할지"를 남기는 것**까지가 세트다.

### "그럼 풀스캔은 언제나 나쁜 건가요?" (가산점 포인트)

아니다. **테이블이 작으면(페이지 몇 장 수준) 풀스캔이 정답**이다. 인덱스를 타면 트리 탐색 오버헤드만 추가된다. 배치·집계처럼 **어차피 대부분의 행을 읽어야 하는 작업**도 풀스캔이 맞고, PostgreSQL은 그런 작업을 `Parallel Seq Scan`으로 워커 여럿이 나눠 읽어 더 빠르게 끝낸다 — `Gather`가 보인다고 인덱스부터 찾는 건 방향이 틀렸다.

판단 기준은 "풀스캔이냐 아니냐"가 아니라 **"읽는 행 수가 결과 건수에 비해 합리적인가"** 이다. 100건을 반환하려고 100만 행을 읽었다면 문제고(`Rows Removed by Filter: 999900`), 90만 건을 반환하려고 100만 행을 읽었다면 정상이다. 이 관점을 가지면 `rows`와 `Buffers`를 "무조건 작아야 하는 숫자"가 아니라 **결과 건수와의 비율**로 읽게 된다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **타입 불일치의 증상** — MySQL은 `phone = 01012345678`을 조용히 받아 컬럼을 숫자로 바꾸며 풀스캔하고 선행 0까지 잃지만, PostgreSQL은 `operator does not exist` 에러로 개발 단계에서 막는다. 대신 PostgreSQL은 `bigint` vs `numeric` 같은 조용한 케이스와 "에러를 컬럼 캐스트로 덮는" 2차 실수를 조심한다.

② **접두 LIKE** — MySQL은 `LIKE 'kim%'`가 그냥 인덱스를 타지만, PostgreSQL은 collation이 `C`가 아니면 `text_pattern_ops` 인덱스가 따로 필요하다. 반대로 `%kw%`는 PostgreSQL이 `pg_trgm`으로 B-tree 밖에서 해결한다.

③ **`OR`** — MySQL은 index_merge를 자주 포기해 `UNION` 분해가 관행이지만, PostgreSQL은 `BitmapOr`가 기본 동작이라 분해 전에 계획부터 본다.

④ **2단계 조회의 구조** — MySQL의 InnoDB는 세컨더리 인덱스 리프에 PK가 있어 "세컨더리 → PK → 클러스터드 인덱스 재탐색"이고, PostgreSQL은 "인덱스 → TID → 힙 페이지"다. 그리고 PostgreSQL에는 TID를 정렬해 랜덤을 순차로 바꾸는 `Bitmap Heap Scan`이라는 중간 단계가 있어 손익분기가 세 단계로 나뉜다.

⑤ **처방의 방향** — MySQL은 `FORCE INDEX` 힌트가 문법에 있어 강제가 흔하지만, PostgreSQL은 힌트가 없어 통계(`ANALYZE`, `CREATE STATISTICS`)·비용 파라미터(`random_page_cost`)·인덱스 설계(부분 인덱스, `INCLUDE`)로 **플래너의 판단을 옳게 만드는 것**이 정석이고, `enable_seqscan = off`는 진단용 스위치일 뿐이다.

이 다섯을 짚어 말하면 "한쪽만 써봤다"가 아니라 "차이를 저장 구조에서 이해했다"로 들린다.

---

## 한 줄 요약

**"인덱스는 원본 값과 TID를 왼쪽부터 정렬해 둔 사본"이라는 한 문장에서 여섯 가지 원인이 전부 도출된다 — 원본을 가공하면(함수·타입 불일치의 컬럼 캐스트) 못 찾고, 왼쪽을 비우거나 비교 규칙이 다르면(선행 와일드카드·비-C collation의 접두 LIKE·선두 컬럼 미사용) 시작점을 못 찍고, 구간이 갈라지거나(`OR`·부정 조건) 너무 크면(낮은 선택도) 이득이 없다. 앞의 다섯은 구조상 못 타는 것이고 마지막 하나는 힙 페치의 랜덤 I/O(`random_page_cost` 4.0) 때문에 플래너가 일부러 안 타는 것이며 — 100만 행에서 90%를 고르면 인덱스 경로는 리프 2,500장 + 힙 페치 90만 번이라 순차 8,334장을 읽는 Seq Scan에 108배로 진다 — `SET LOCAL enable_seqscan = off`로 계획이 바뀌는지가 그 둘을 30초에 가른다. PostgreSQL은 그 사이에 `Bitmap Heap Scan`을 두고, 힌트 대신 통계·비용 파라미터·부분 인덱스로 플래너의 판단을 고친다 — 이 둘을 갈라 말하는 것이 곧 변별점이다.**
