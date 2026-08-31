# 목록 API의 total count 비용 — "전체 몇 건 중 몇 페이지"는 목록 본체보다 비싼 요구다

> 핵심 관전 포인트: **목록 쿼리는 `LIMIT 20`에서 멈추지만 `COUNT(*)`는
> 조건에 맞는 행을 전부 만나야 끝난다 — 비용이 페이지 크기가 아니라 조건에
> 맞는 전체 행 수 N에 비례한다. InnoDB가 행 수를 메타데이터로 못 드는
> 이유는 MVCC다: 트랜잭션마다 보이는 행이 달라 "정답인 숫자"가 하나가
> 아니므로, 행마다 가시성을 판정하며 셀 수밖에 없다. 조건 컬럼이 인덱스에
> 다 없으면 그 N건마다 북마크 룩업(랜덤 I/O)까지 붙는다. 대안은 다섯 갈래
> — ① 커버링 인덱스로 세기 ② 근사치(옵티마이저 추정치·상한 카운트)
> ③ 카운트 캐싱·카운터 테이블 ④ 다음 페이지 존재 여부만 확인(`Slice`)
> ⑤ 무한 스크롤·커서·검색 엔진 — 각각 정확도·정합성·UX 중 하나를 내주는
> 거래다. Spring Data의 `Page`는 count 쿼리를 자동으로 붙이므로 기본은
> `Slice`, `Page`는 근거 필수라는 규약을 코드(ArchUnit)와 계측(count 분리
> 측정)으로 고정한다. 그 가격표를 기획에 보여주는 것까지가 백엔드의 일이다.**

---

## 0. 질문 + 의도

**질문**: "목록 API의 전체 건수(total count) 조회가 대용량에서 비싼 이유와
대안은? (근사치, 카운트 캐싱, 무한 스크롤 전환)"

**출제 의도**: COUNT는 조건에 맞는 전체를 세야 해서 목록 조회 본체보다
비싼 경우가 많다. "전체 몇 건 중 몇 페이지" UI가 기술적으로 얼마나 비싼
요구인지 알고 근사치·카운트 캐싱·무한 스크롤 같은 대안을 **기획과
협상해봤는지** — 요구사항의 비용을 알려주는 것까지가 백엔드의 일임을
아는지 본다. 즉 "COUNT는 느리다"는 현상 지식이 아니라, ⑴ 왜 느린지를
저장 엔진의 메커니즘으로 설명하고 ⑵ 대안마다 무엇을 내주는지를 양면으로
말하고 ⑶ 그 선택을 팀의 규약으로 고정할 수 있는지를 한 번에 본다.

> **역할 구분**: 같은 섹션의 깊은 페이지네이션 문서(`13-deep-pagination-offset-vs-cursor.md`)는 `LIMIT 100000, 20`의
> **offset 비용**(건너뛰기 위해 읽는 행)을 다룬다. 이 문서는 **count 비용**
> (세기 위해 읽는 행)이다. 목록 API가 느릴 때 이 둘은 따로 측정하고 따로
> 고친다(4-1절).
>
> **읽는 순서**: 1절은 비용을 "이름 → 사슬"로 말하는 훈련(4장 최우선 교정
> 대상), 3절은 대안 5가지를 **목록으로 인출하고 각 대안의 대가를 한
> 호흡에** 붙이는 훈련, 4절은 그 선택을 **기억이 아니라 코드·계측으로
> 고정**하는 안전망이다.

---

## 1. 왜 비싼가 — "세는 것"의 비용을 메커니즘 사슬로

이 절이 이 문서의 심장이다. "COUNT는 전체를 다 훑어서 느리다"는 한 문장은
맞지만 뭉뚱그린 말이다. 면접에서는 **왜 다 훑어야만 하는지**(멈출 수 없는
이유 + 메타데이터로 못 드는 이유)와 **훑을 때 무엇을 읽는지**(인덱스 페이지
vs 행 페이지)를 고리별로 짚어야 한다.

### 1-1. 목록 쿼리는 20건에서 멈추고, COUNT는 멈출 수 없다

```sql
-- 목록 본체: 인덱스 (seller_id, status, created_at)를 타고
-- 조건에 맞는 첫 20건을 읽는 순간 끝난다. 비용 ∝ 페이지 크기(20)
SELECT id, amount, created_at
  FROM orders
 WHERE seller_id = 42 AND status = 'PAID'
 ORDER BY created_at DESC
 LIMIT 20;

-- 총 건수: 조건에 맞는 행이 300만 건이면 300만 건을 전부 "만나야" 끝난다.
-- 비용 ∝ 조건에 맞는 전체 행 수(N)
SELECT COUNT(*)
  FROM orders
 WHERE seller_id = 42 AND status = 'PAID';
```

같은 화면의 두 쿼리인데 비용의 **차원이 다르다.** 목록은 페이지 크기(상수)에
비례하고, count는 조건에 맞는 전체 행 수 N에 비례한다. 위 예시에서 접근하는
행 수는 20 대 300만 — 15만 배다. 그래서 "목록 API가 느리다"고 할 때 실제로
느린 것은 목록이 아니라 그 옆에 붙은 count인 경우가 아주 흔하다. 게다가 이
count는 사용자가 2페이지, 3페이지로 넘어갈 때마다 **매번 다시** 실행된다.

### 1-2. InnoDB는 왜 행 수를 메타데이터로 못 들고 있나 — MVCC

"그냥 테이블에 행 수를 저장해 두고 INSERT/DELETE 때 ±1 하면 되지 않나?"
MyISAM은 실제로 그렇게 한다 — 테이블 단위 락이라 한 시점에 행 수가
하나뿐이므로 `SELECT COUNT(*) FROM t`가 메타데이터 조회 한 번으로 끝난다.

InnoDB가 그럴 수 없는 이유가 **MVCC**(다중 버전 동시성 제어)다. 읽기가 락을
잡지 않도록 행의 여러 버전을 동시에 보관하고, 각 트랜잭션은 자기 **리드
뷰**(시작 시점에 어떤 트랜잭션들이 진행 중이었는지 찍어 둔 스냅샷) 기준으로
"자기에게 보이는 버전"만 읽는다. 그 결과 —

- 트랜잭션 A가 INSERT하고 아직 커밋 전이면, 그 행은 A에게는 보이고 B에게는
  안 보인다. 같은 순간 A의 정답은 1,001건, B의 정답은 1,000건이다.
- 트랜잭션 C가 DELETE하고 커밋했어도, 그 전에 시작한 REPEATABLE READ
  트랜잭션 D에게는 그 행이 아직 보여야 한다. 물리적으로도 InnoDB는 행을
  바로 지우지 않고 **삭제 표시(delete-mark)**만 해 두었다가 나중에
  퍼지(purge)한다.

즉 **"이 테이블의 행 수"라는 단일 정답이 존재하지 않는다.** 정답은 "누가
언제 보느냐"에 따라 다르므로, 유일한 방법은 **실제로 행을 하나씩 만나서
그 행의 버전이 내 리드 뷰에 보이는지 판정하며 세는 것**이다. 행마다 숨은
컬럼 `DB_TRX_ID`(마지막으로 고친 트랜잭션 ID)를 리드 뷰와 비교하고, 안
보이는 버전이면 `DB_ROLL_PTR`을 따라 undo 로그의 옛 버전으로 거슬러
올라간다. 동시 갱신이 많거나 긴 트랜잭션이 undo를 쌓아 두면 이 판정
자체가 더 비싸진다 — 긴 트랜잭션의 해악이 count에까지 번지는 지점이다(리드 뷰·undo 체인의
상세는 `11-mvcc-innodb.md`).

(MySQL 8.0은 조건 없는 `COUNT(*)`를 **가장 작은 세컨더리 인덱스**를 골라
훑도록 최적화했다 — 페이지 수가 가장 적으니까. 하지만 여전히 "끝까지
훑는" 것이지 메타데이터 조회가 아니다. PostgreSQL도 같은 이유로 count를
메타데이터로 들지 않고, `pg_class.reltuples`는 통계 추정치일 뿐이다.)

### 1-3. 훑을 때 무엇을 읽나 — 커버링 인덱스 카운트 vs 테이블 스캔 카운트

"다 훑는다"가 확정이어도, **무엇을** 훑느냐에 따라 I/O가 몇십 배 차이 난다.
클러스터드 vs 세컨더리 문서(`03-clustered-vs-secondary-index.md`)와 커버링 인덱스
문서(`09-covering-index.md`)의 구조를 그대로 가져온다. 판매자 42의 주문이
500만 건이고 그중 PAID가 300만 건이라고 하자.

```sql
-- ❌ before: 인덱스가 (seller_id)뿐이라 status를 확인하려면 행을 열어야 한다
CREATE INDEX idx_orders_seller ON orders (seller_id);

SELECT COUNT(*) FROM orders WHERE seller_id = 42 AND status = 'PAID';
-- EXPLAIN: key = idx_orders_seller, Extra = Using where
-- 세컨더리 인덱스에서 판매자 42의 PK 500만 개를 얻고, PK마다 클러스터드
-- 인덱스를 다시 탐색(북마크 룩업)해 status를 읽어 PAID인지 가른다.
-- → 랜덤 I/O 500만 회. 행 하나가 500B라면 16KB 페이지에 30여 행뿐이라
--   버퍼 풀에 다 못 올라가고, 없는 페이지는 디스크에서 읽는다.

-- ✅ after: 조건 컬럼이 전부 인덱스 안에 있어 인덱스만 읽고 센다
CREATE INDEX idx_orders_seller_status_created
    ON orders (seller_id, status, created_at);

SELECT COUNT(*) FROM orders WHERE seller_id = 42 AND status = 'PAID';
-- EXPLAIN: key = idx_orders_seller_status_created, Extra = Using index
-- (seller_id=42, status='PAID') 구간의 리프 엔트리를 연결 리스트 따라
-- 순차로 읽으며 센다. 엔트리가 30B 안팎이면 페이지당 500개 안팎이라
-- 300만 건 ≈ 6천 페이지 순차 I/O. 북마크 룩업 0회.
```

사슬로 말하면 —

> 조건에 맞는 행이 N건이다 → COUNT는 N건을 전부 만나야 한다(`LIMIT`처럼
> 중간에 멈출 수 없다) → 행마다 MVCC 가시성 판정 → **조건 컬럼이 인덱스에
> 다 없으면** 행마다 북마크 룩업 = 랜덤 I/O N회, 행 페이지는 크고 성기어
> 버퍼 풀 적중률이 낮다 → 응답 시간 ∝ N × 랜덤 I/O 비용. **커버링이면**
> 인덱스 리프만 순차로 읽고, 엔트리가 작아 페이지당 밀도가 높아 같은 N에
> 페이지 수가 수십 분의 일이다 → 응답 시간 ∝ N × (훨씬 작은) 순차 I/O
> 비용. 그러나 **커버링도 N에 비례하는 건 그대로다** — 배수를 줄일 뿐
> 차원을 바꾸지는 못한다.

마지막 문장이 중요하다. 커버링 인덱스는 count를 "덜 비싸게" 만들지 "싸게"
만들지 않는다. 차원을 바꾸려면 3절의 나머지 대안이 필요하다.

### 1-4. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "count는 전체를 다 봐서 느리다" | **비용 차원의 차이** | 목록은 `LIMIT`에서 멈춰 페이지 크기에 비례, count는 멈출 수 없어 조건에 맞는 전체 행 수 N에 비례 → 페이지마다 재실행 |
| "InnoDB는 행 수를 저장 안 한다" | **MVCC 리드 뷰** | 트랜잭션마다 보이는 행이 다르다 → 단일 정답 없음 → 행마다 `DB_TRX_ID`를 리드 뷰와 비교(필요하면 undo 체인)하며 세야 한다 |
| "인덱스 타면 좀 빠르다" | **커버링 vs 북마크 룩업** | 조건 컬럼이 인덱스에 다 있으면 리프 순차 읽기(작고 촘촘한 페이지), 없으면 N회 랜덤 I/O(크고 성긴 행 페이지). 단, 둘 다 N에 비례 |

---

## 2. Spring Data JPA — count는 어디서 몰래 나가나

대용량에서 count가 비싸다는 걸 알아도, **내 코드가 count를 날리고 있다는
사실 자체를 모르는** 경우가 많다. `Page`가 그 주범이다.

### 2-1. `Page`는 count 쿼리를 자동으로 붙인다

```java
// 이 한 줄이 SQL 두 개다
Page<Order> page = orderRepository.findBySellerIdAndStatus(sellerId, PAID, pageable);
// ① SELECT ... FROM orders WHERE seller_id=? AND status=? ORDER BY ... LIMIT 20 OFFSET 0
// ② SELECT COUNT(o.id) FROM orders o WHERE seller_id=? AND status=?   ← 자동 파생
```

`Page`는 `getTotalElements()`·`getTotalPages()`를 채워야 하므로 Spring Data가
**count 쿼리를 파생해 한 번 더 실행**한다. 다만 무조건은 아니다 —
`PageableExecutionUtils.getPage`가 count를 **건너뛰는 두 경우**를 알아 두면
"왜 어떤 요청은 빠르고 어떤 요청은 느린가"가 설명된다:

- 첫 페이지인데 가져온 건수가 페이지 크기보다 적다 → 총 건수 = 가져온
  건수, count 생략.
- 첫 페이지가 아닌데 가져온 건수가 페이지 크기보다 적다(마지막 페이지) →
  총 건수 = offset + 가져온 건수, count 생략.

바꿔 말하면 **페이지가 꽉 차는 "대용량일 때만" count가 나간다.** 개발 DB의
데이터 몇십 건으로 테스트하면 count가 안 보이고, 운영에 올라가면 매 요청
count가 붙는 이유다.

### 2-2. 파생 count가 틀리거나 무거울 때 — `countQuery` 분리

`@Query`를 쓰면 Spring Data는 JPQL의 `select ... from` 부분을 `select count(...)`로
바꿔 count 쿼리를 파생한다. 이 파생이 문제를 일으키는 세 경우가 있다.

```java
// ❌ before: 목록용 JPQL을 그대로 count에 재사용
@Query("""
    select o from Order o
      join fetch o.seller s
      left join fetch o.coupon c
     where s.id = :sellerId and o.status = :status
    """)
Page<Order> findPage(Long sellerId, OrderStatus status, Pageable pageable);
// ① fetch join이 든 JPQL을 count로 바꾸면 Hibernate가 예외를 던진다
//    ("query specified join fetching, but the owner ... was not present in the select list")
//    — 그것도 count가 실제로 실행될 때만(2-1절) 터지므로 개발 DB에서는 안 보인다
// ② 예외가 안 나더라도, 세는 데 필요 없는 coupon 조인까지 count 쿼리에 끌려
//    들어가 조인 비용을 두 번 낸다
// ③ 네이티브 쿼리(nativeQuery = true)는 파생 자체가 불안정하다

// ✅ after: 세는 데 필요한 최소 조건만 남긴 countQuery를 따로 준다
@Query(value = """
    select o from Order o
      join fetch o.seller s
      left join fetch o.coupon c
     where s.id = :sellerId and o.status = :status
    """,
    countQuery = """
    select count(o) from Order o
     where o.seller.id = :sellerId and o.status = :status
    """)
Page<Order> findPage(Long sellerId, OrderStatus status, Pageable pageable);
// count는 조인 없이 orders 한 테이블 + 커버링 인덱스 (seller_id, status, ...)로 끝난다
```

`countQuery`를 분리하는 이유는 두 가지다 — **실패를 막기 위해**(fetch join),
그리고 **count가 1-3절의 커버링 경로를 타도록 만들기 위해.** 목록 쿼리는
표시할 컬럼이 많아 커버링이 안 되지만, count는 조건 컬럼만 있으면 되니
훨씬 가벼운 실행 계획을 줄 수 있다.

**(가산점 포인트)** Querydsl에서는 `fetchResults()`(목록 + count를 한 번에)가
같은 이유로 deprecated 됐다. 목록은 `fetch()`, count는 조인을 뺀 별도
`select(order.count())` 쿼리로 만들고, `PageableExecutionUtils.getPage(content,
pageable, countQuery::fetchOne)`처럼 **`LongSupplier`로 넘겨** 2-1절의
"건너뛰기" 최적화까지 그대로 누리는 것이 정석이다. count 쿼리가 **지연
실행**되어야 건너뛸 수 있다는 점이 핵심이다.

### 2-3. 총 건수가 필요 없다면 — `Slice`로 전환

```java
// ❌ before: 화면은 "더 보기" 버튼뿐인데 Page를 써서 매 요청 count가 붙는다
Page<Order> findBySellerIdAndStatus(Long sellerId, OrderStatus status, Pageable pageable);

// ✅ after: 반환 타입만 Slice로 — count 쿼리가 사라진다
Slice<Order> findBySellerIdAndStatus(Long sellerId, OrderStatus status, Pageable pageable);
// 실행되는 SQL: ... LIMIT 21 OFFSET 0   ← 페이지 크기 + 1건을 요청
// 21번째 행이 있으면 hasNext = true, 응답에는 20건만 담는다.
// 총 건수·총 페이지 수는 모른다. "다음 페이지가 있는가"만 안다.
```

`Slice`가 count 없이 `hasNext`를 아는 원리는 단순하다 — **한 건을 더 달라고
해서 그게 오면 다음이 있는 것.** 비용은 행 1건. 응답 모델도 따라 바뀐다:

```java
// ❌ before: 총 페이지 수를 응답에 실어 클라이언트가 페이지 번호를 그린다
record PageResponse<T>(List<T> content, int page, int totalPages, long totalElements) {}

// ✅ after: 다음 페이지 유무만 실어 "더 보기"/무한 스크롤을 그린다
record SliceResponse<T>(List<T> content, int page, boolean hasNext) {}
```

`List<Order> findBy...(Pageable)`도 가능하다 — count도 `hasNext`도 없이 딱
페이지 크기만큼만. "다음" 버튼조차 없는 위젯(최근 주문 5건 같은)에 맞다.

**(가산점 포인트)** 최근 Spring Data에는 `Window<T>`/`ScrollPosition` 기반
Scroll API가 있어 offset이 아닌 **키셋(커서)** 방식으로 다음 묶음을 가져올
수 있다. count 비용(이 문서)과 offset 비용(깊은 페이지네이션 문서)을 한
번에 없애는 방향이다.

### 2-4. `SQL_CALC_FOUND_ROWS`라는 함정 (가산점 포인트)

"목록과 count를 쿼리 한 번에" 하려던 MySQL의 옛 기능. `LIMIT`을 무시하고
결과 집합 전체를 끝까지 평가하게 만들어 **목록 쿼리까지 count 비용을 물게
한다.** 쿼리 두 개로 나누는 것보다 느린 경우가 많아 MySQL 8.0에서
deprecated 됐다. 왕복 횟수를 줄이려다 I/O를 늘리는 전형이다.

---

## 3. 대안 5가지 — 무엇을 내주고 무엇을 얻는가

1절의 결론은 "count 비용은 N에 비례하고, 커버링은 배수만 줄인다"였다.
차원을 바꾸려면 **정확도 · 정합성 · UX 중 하나를 내줘야** 한다. 다섯 대안을
목록으로 고정하고, 각각 얻는 것과 내주는 것을 **한 호흡에** 말한다. 한쪽만
말하면 답이 아니다.

### 3-1. 커버링 인덱스로 세기 — 정확도 유지, 배수만 절감

- **얻는 것**: 정확한 값. 북마크 룩업 제거, 페이지 밀도 상승으로 같은 N에
  I/O 수십 분의 일(1-3절).
- **내주는 것**: 인덱스 하나만큼의 쓰기 비용·저장 공간. 그리고 **N에
  비례하는 구조는 그대로** — 조건에 맞는 행이 수천만이면 여전히 초 단위다.
- **맞는 상황**: 조건에 맞는 N이 수십만 이하이고 정확한 값이 꼭 필요한
  화면. 다른 대안을 쓰더라도 **첫 번째로 깔아 두는 기초 공사**다.

### 3-2. 근사치 — 정확도를 내주고 상수 시간을 산다

두 가지 얼굴이 있다.

```sql
-- (a) 옵티마이저 추정치: 실행하지 않고 "몇 건쯤일지"만 묻는다. 비용 ≈ 0
EXPLAIN SELECT 1 FROM orders WHERE seller_id = 42 AND status = 'PAID';
-- → rows 컬럼이 추정치. 통계·인덱스 다이브 기반이라 수십 % 어긋날 수 있다.
-- 조건 없는 전체 건수는 information_schema.TABLES.TABLE_ROWS (역시 추정치)

-- (b) 상한 카운트: 상한까지만 정확히 세고, 넘으면 "1,000+"로 표시
SELECT COUNT(*) FROM (
    SELECT 1 FROM orders
     WHERE seller_id = 42 AND status = 'PAID'
     LIMIT 1001
) t;
-- 1,000건 이하면 정확한 값, 1,001이면 "1,000건 이상". 비용은 최대 1,001건으로 고정
```

- **얻는 것**: (a)는 N과 무관한 상수 시간. (b)는 **상한으로 고정된** 시간에,
  상한 이하에서는 정확한 값까지.
- **내주는 것**: (a)는 정확도 — "약 12,000건"이라는 표기와 **허용 오차를
  기획과 합의**해야 쓸 수 있다. (b)는 상한 너머의 정보 — "51페이지 이후"를
  숫자로 못 보여준다.
- **맞는 상황**: 검색 결과 건수처럼 숫자가 감(感)의 용도인 화면. Google이
  "약 1,230,000개"라고 쓰고, Elasticsearch조차 기본 설정으로 총 건수를
  1만 건까지만 정확히 세고 그 이상은 "1만 건 이상"으로 돌려주는
  (`track_total_hits`) 이유가 이것이다 — **검색 엔진도 정확한 총 건수를
  비싸게 본다.**

### 3-3. 카운트 캐싱 · 카운터 테이블 — 정합성을 내주고 읽기를 산다

```java
// (a) 결과 캐싱: 조건 조합을 키로 count 결과를 짧게 캐시
String key = "orders:count:" + sellerId + ":" + status;      // 필터 조합이 곧 키
Long total = cache.get(key,
        () -> orderRepository.countBySellerIdAndStatus(sellerId, status),
        Duration.ofMinutes(5));
```

```sql
-- (b) 카운터 테이블: 쓰기 시점에 미리 세어 둔다
UPDATE seller_order_stats SET paid_count = paid_count + 1 WHERE seller_id = 42;
-- 조회는 PK 한 건 읽기. 하지만 이 UPDATE가 주문 INSERT와 같은 트랜잭션에 있으면
-- 판매자 42의 모든 주문이 이 한 행의 락을 두고 줄을 선다 — 핫 로우
```

- **얻는 것**: 읽기가 상수 시간, N과 무관.
- **내주는 것**: **정합성과 무효화.** (a)는 TTL 동안 값이 낡고, 필터 조합
  (상태 × 기간 × 검색어)이 곱셈으로 늘어 **인기 조합만** 캐시할 수 있다.
  (b)는 쓰기 경로에 비용이 옮겨 간다 — 같은 트랜잭션에서 갱신하면 **핫 로우
  락 경합**(반정규화 문서의 대가와 같은 뿌리), 비동기(이벤트)로 빼면
  **최종적 일관성**과 유실·중복 처리, 그리고 어느 쪽이든 어긋남을 되돌릴
  **보정 배치**(주기적으로 실제 COUNT로 재계산)가 필요하다. 필터 조합마다
  카운터를 따로 둘 수도 없다 — 카운터 테이블은 **미리 정해진 축**(판매자별
  상태별 같은)에만 맞는다.
- **맞는 상황**: 정확한 숫자가 **업무 지표**로 쓰여 근사치가 안 되지만, 몇
  분의 지연은 허용되는 대시보드. 축이 고정된 집계.

### 3-4. 다음 페이지 존재 여부만 확인 — `Slice`

- **얻는 것**: count 쿼리 자체가 사라진다. 비용은 행 1건(2-3절). 코드
  변경은 반환 타입 한 줄.
- **내주는 것**: **"전체 N건 중 k페이지" UI.** 총 페이지 수·마지막 페이지로
  점프·페이지 번호 나열이 모두 불가능해진다. 이는 백엔드 혼자 결정할 수
  없고 **화면이 바뀐다** — 기획·프론트와의 합의가 선행돼야 한다.
- **맞는 상황**: 최신순으로 흘러가는 피드, "더 보기" 버튼, 모바일 목록.
  대부분의 사용자향 목록이 사실 여기 속한다 — 사용자가 57페이지로
  점프하는 일은 거의 없다.

### 3-5. 무한 스크롤 · 커서 · 검색 엔진 — UX와 아키텍처를 바꾼다

- **얻는 것**: 무한 스크롤 + 커서 기반이면 count 비용과 offset 비용을
  **둘 다** 없앤다. 복합 조건 검색·집계가 잦으면 Elasticsearch 같은 검색
  엔진이 역색인으로 필터·건수를 RDB보다 싸게 준다.
- **내주는 것**: 무한 스크롤은 **UX 자체의 변경**(뒤로 가기·특정 위치
  공유·총량 감각 상실)이라 기획 협상의 크기가 가장 크다. 커서는 정렬 키가
  유일해야 하고 API 스펙이 바뀐다(깊은 페이지네이션 문서). 검색 엔진은
  **운영 비용과 RDB↔엔진 동기화(지연·유실)**라는 새 시스템을 하나 들이는
  일이고, 그마저도 총 건수는 3-2절처럼 기본이 근사치다.
- **맞는 상황**: 트래픽이 크고 목록이 제품의 중심인 사용자향 서비스. 검색
  조건이 다차원이라 RDB 인덱스로 감당이 안 되는 경우.

### 3-6. 선택 프레임 — "총 건수가 무엇에 쓰이나요?"

다섯 대안 중 무엇을 고를지는 기술이 아니라 **요구의 정체**가 결정한다.
그래서 첫 질문은 늘 "총 건수가 어디에 쓰이나요?"다.

| 총 건수의 용도 | 정확도 요구 | 맞는 대안 |
|---|---|---|
| 페이지 번호 UI(1 2 3 … 57) | 낮음 — 사실 "다음"만 필요 | ④ `Slice` / ⑤ 무한 스크롤, 관리자 화면이면 ② 상한 카운트로 번호 10개까지만 |
| 검색 결과 건수 표시 | 낮음 — 감의 용도 | ② 근사치("약 N건", "1,000+") |
| 업무 지표(오늘 결제 건수) | 높음, 지연 허용 | ③ 카운터 테이블 + 보정 배치, 실시간성부터 되묻기 |
| 정산·감사 | 높음, 지연 불가 | ① 커버링 인덱스 + 조건 축소, 목록 API가 아니라 별도 집계 경로로 |

"요구사항의 비용을 알려주는 것까지가 백엔드의 일"이라는 말은 이 표를
들고 기획에 가는 것이다. "전체 몇 건 중 몇 페이지"는 화면 요소 하나지만
DB에는 **매 요청 N건 스캔**이라는 가격표가 붙어 있고, 그 가격표를 보여주면
대부분의 기획은 "다음 페이지 있음"으로 만족한다. 협상 없이 `Page`를 쓰는
것과 협상 없이 `Slice`로 바꿔 화면을 깨뜨리는 것은 **둘 다** 실패다.

---

## 4. 안전망 — 기억이 아니라 코드와 계측으로 고정

"count가 비싸다"를 알아도 6개월 뒤 새 목록 API를 만드는 동료(또는 나)는
습관대로 `Page`를 쓴다. 지식을 습관에 맡기지 않고 **코드가 막고 계측이
드러내게** 한다.

### 4-1. count 쿼리를 목록 응답에서 분리 측정한다

"목록 API가 800ms"라는 숫자는 진단이 아니다. 목록 쿼리와 count 쿼리가
각각 몇 ms인지 **따로** 봐야 offset 문제인지 count 문제인지 갈린다.

- **SQL 단위 로깅**: p6spy 또는 datasource-proxy를 붙이면 요청 하나에서
  나간 SQL이 **한 줄씩 실행 시간과 함께** 찍힌다. `LIMIT` 붙은 목록 쿼리
  12ms, `COUNT` 쿼리 780ms — 이렇게 보이는 순간 진단이 끝난다. 3장 N+1
  문서에서 쓴 것과 같은 도구다.
- **APM의 SQL 스팬**: Pinpoint·Datadog 류는 요청 트레이스 안에 SQL
  하나하나를 스팬으로 그려 준다. count 스팬이 목록 스팬보다 긴 화면이 곧
  증거다.
- **슬로 쿼리 로그**: `long_query_time`을 낮춰 두면 count 쿼리만 잡힌다 —
  목록 쿼리는 `LIMIT` 덕에 걸리지 않으므로, "느린 목록 API"에서 슬로
  로그에 count만 남는 것 자체가 신호다.
- **EXPLAIN은 count 쿼리에 따로**: 목록 쿼리 EXPLAIN은 `LIMIT` 때문에
  rows가 작게 나온다. count 쿼리를 따로 EXPLAIN 해서 `Extra`에
  `Using index`(커버링)가 있는지, `rows`가 얼마인지를 본다.

```java
// 코드 안에서 count만 따로 재고 싶을 때 — Micrometer Timer로 supplier를 감싼다
LongSupplier timedCount = () -> countTimer.record(() -> countQuery.fetchOne());
return PageableExecutionUtils.getPage(content, pageable, timedCount);
// 대시보드에 "목록 p95"와 "count p95"가 따로 그려진다
```

### 4-2. `Page` vs `Slice`를 코드 규약으로 — 기본은 `Slice`, `Page`는 근거를 남겨야

규약은 문서에 쓰면 잊히고 리뷰 체크리스트에 두면 놓친다. **테스트가
실패하게** 만든다.

```java
// 총 건수가 정말 필요한 메서드에만 붙이는 표식 — "왜 필요한지"를 값으로 강제
@Retention(RUNTIME) @Target(METHOD)
public @interface ExactTotalRequired {
    String reason();     // 예: "정산 화면 — 건수 불일치 시 감사 이슈"
}

// ArchUnit: 표식 없이 Page를 반환하는 리포지토리 메서드는 빌드가 깨진다
@ArchTest
static final ArchRule page_requires_justification =
    methods()
        .that().areDeclaredInClassesThat().resideInAPackage("..repository..")
        .and().areNotAnnotatedWith(ExactTotalRequired.class)
        .should().notHaveRawReturnType(Page.class)
        .because("Page는 매 요청 count 쿼리를 추가한다. 총 건수가 꼭 필요하면 "
               + "@ExactTotalRequired(reason=...)로 근거를 남기고, 아니면 Slice를 써라");
```

이 규칙 하나가 하는 일: ⑴ 새 목록 API의 **기본값을 `Slice`로** 밀어붙인다
⑵ `Page`를 쓰려면 이유를 코드에 적어야 하므로 **기획 협상(3-6절)이 먼저
일어나게** 만든다 ⑶ 6개월 뒤 "이 화면 왜 Page지?"의 답이 코드 옆에 있다.

같은 결의 안전망으로, 목록 API 통합 테스트에서 **나가는 쿼리 수를
단정**하는 방법도 있다 — `Slice`로 바꾼 API가 SQL 1개만 실행하는지
datasource-proxy의 쿼리 카운터로 `assertThat(count).isEqualTo(1)`. 누군가
`Page`로 되돌리면 2가 되어 테스트가 깨진다.

### 4-3. count를 별도 경로로 — 목록의 응답 시간을 count가 볼모 잡지 못하게

`Page`를 유지해야 하는 화면이라도 **목록과 count를 같은 응답에 묶지 않는**
선택이 있다.

```text
GET /orders?seller=42&status=PAID&page=0      → 목록만, 즉시 응답 (Slice)
GET /orders/count?seller=42&status=PAID       → 총 건수, 별도 타임아웃 + 실패 시 "1,000+" 폴백
```

프론트는 목록을 먼저 그리고 건수는 도착하면 채운다. count 엔드포인트에
짧은 타임아웃과 3-2절 상한 카운트 폴백, 3-3절 캐시를 얹으면 **count가
느려져도 목록은 느려지지 않는다.** 장애 격리의 축소판이다.

---

## 5. 실무 사례 — "관리자 주문 목록이 새벽엔 빠르고 낮엔 느려요"

관리자 주문 목록 API(`Page<Order>`, 상태 필터, 20건씩)가 낮 시간대에만
p95 2초를 넘겼다. 처음 의심은 "낮에 트래픽이 많아서" — 틀리진 않지만
진단이 아니다.

p6spy 로그를 요청 단위로 보니 목록 쿼리는 낮에도 15ms, **count 쿼리가
1.8초**였다. 원인은 두 겹이었다. ⑴ 인덱스가 `(created_at)`뿐이라 상태
필터 count가 **북마크 룩업 N회**로 돌고 있었고(1-3절 before) ⑵ 낮에는
주문 INSERT/UPDATE가 몰려 count가 만나는 행마다 **undo 체인을 타는 가시성
판정**이 늘었다(1-2절). 새벽엔 ⑵가 사라지고 버퍼 풀도 따뜻해서 "빨라
보였던" 것이다.

처방은 순서대로 갔다. 먼저 `(status, created_at)` 커버링 인덱스로 count를
`Using index`로 바꿔 배수를 줄였다(3-1). 그래도 N에 비례하는 건 그대로라,
기획과 "이 화면에서 총 페이지 수를 실제로 쓰는가"를 확인했고 — 운영자는
최신순으로 몇 페이지 넘기며 처리할 뿐 마지막 페이지로 점프하지 않았다.
**`Slice`로 전환하고 상단 건수는 상한 카운트 "1,000+"로**(3-4 + 3-2) 바꿔
count 비용을 없앴다. 마지막으로 4-2절의 ArchUnit 규칙을 넣어 다음 관리자
화면이 같은 길을 밟지 않게 했다.

이 사례에서 면접관이 듣고 싶은 것은 세 가지다 — **분리 측정으로 count를
특정**했는가, **배수 절감(인덱스)과 차원 변경(Slice)을 구분**했는가, 그리고
**화면 변경을 기획과 확인하고 규약으로 고정**했는가.

---

## 6. 꼬리질문 대비 포인트

### "MyISAM은 `COUNT(*)`가 즉시 나오는데 InnoDB는 왜 안 되나요?"

MyISAM은 테이블 단위 락이라 한 시점에 "행 수"가 하나뿐이고, 그 값을
메타데이터에 들고 있다가 바로 돌려준다. InnoDB는 MVCC라서 **트랜잭션마다
보이는 행이 다르다** — 커밋 전 INSERT는 그 트랜잭션에게만 보이고, 삭제
표시된 행은 먼저 시작한 트랜잭션에게 아직 보여야 한다. 단일 정답이 없으니
행마다 `DB_TRX_ID`를 리드 뷰와 비교해 세는 수밖에 없다. 덧붙이면 —
MySQL 8.0은 조건 없는 `COUNT(*)`를 가장 작은 세컨더리 인덱스로 훑도록
최적화했지만 여전히 스캔이고, PostgreSQL도 같은 이유로 `reltuples`
추정치만 가진다. "읽기가 락을 안 잡는 대가로 count를 세는 비용을 낸다"는
**트레이드오프 문장**으로 닫으면 좋다.

### "`COUNT(*)`, `COUNT(1)`, `COUNT(id)`는 성능이 다른가요?"

`COUNT(*)`와 `COUNT(1)`은 InnoDB에서 동일하게 처리된다 — "COUNT(1)이 더
빠르다"는 속설은 근거가 없다. `COUNT(col)`은 의미가 다르다: **col이 NULL이
아닌 행만** 센다. 그래서 col을 실제로 읽어야 하고, col이 옵티마이저가 고른
인덱스에 없으면 커버링 경로를 잃을 수 있다. 결론은 "행 수를 세려면
`COUNT(*)`, 특정 컬럼의 비-NULL 개수를 세려는 의도가 있을 때만
`COUNT(col)`" — 성능 이전에 **의미가 다른 함수**라고 말하는 게 정확하다.

### "카운터 테이블로 가면 어떤 새 문제가 생기고, 어떻게 다루나요?" (시니어 변별 포인트)

읽기 비용을 쓰기 경로로 **옮긴 것**이지 없앤 게 아니다. 세 가지가 새로
생긴다. ⑴ **핫 로우**: 같은 트랜잭션에서 `paid_count + 1`을 하면 그
판매자의 모든 주문이 한 행의 락을 두고 직렬화된다 — 반정규화 문서의
대가와 같은 뿌리. 완화는 카운터를 여러 슬롯으로 쪼개 합산하거나, 이벤트로
빼서 비동기 갱신. ⑵ **비동기로 빼면 정합성**: 최종적 일관성, 이벤트
유실·중복에 대한 멱등 처리, 그리고 실패 시 롤백되지 않는 카운터.
⑶ **축의 고정**: 카운터는 미리 정한 축(판매자별 상태별)에만 답하고, 새
필터 조합이 오면 답이 없다. 그래서 어느 방식이든 **보정 배치**(주기적으로
실제 `COUNT(*)`로 재계산해 덮어쓰기)를 안전망으로 깔고, "얼마나 어긋나도
되는가"를 기획과 숫자로 합의한다. 이 셋을 묻지 않고 "캐싱하면 됩니다"로
끝내는 답이 주니어 답이다.

### "`Slice`로 바꾸자고 하니 기획이 '페이지 번호는 꼭 있어야 한다'고 합니다. 어떻게 하나요?" (시니어 변별 포인트)

먼저 **가격표를 보여준다** — 이 화면의 count가 요청당 N건 스캔이고 p95의
몇 %를 차지하는지(4-1절의 분리 측정 결과). 그다음 요구를 쪼갠다: "페이지
번호"가 필요한 건지, "**마지막 페이지로 점프**"가 필요한 건지, "**총량의
감**"이 필요한 건지. 대개 답은 앞의 둘이 아니다. 그러면 **상한 카운트**로
"1 2 3 … 10 다음"까지만 번호를 그리고 그 뒤는 "다음"으로 잇는 절충이 있다
— 비용은 상한으로 고정되고 UI는 거의 그대로다. 정말 마지막 페이지 점프가
업무에 필요하다면(감사·정산) `Page`를 유지하되 **커버링 인덱스 + count
별도 엔드포인트 + 캐시**로 목록 응답에서 떼어낸다. 핵심은 "안 됩니다"도
"네 하겠습니다"도 아니고, **비용을 숫자로 보여주고 요구를 한 단계 쪼개
같이 고르는 것**이다. 그리고 합의 결과를 `@ExactTotalRequired(reason=…)`처럼
코드에 남긴다.

### "count 쿼리가 목록 응답의 몇 %인지 어떻게 확인하나요?"

요청 하나가 발생시킨 SQL을 **한 줄씩 실행 시간과 함께** 보는 도구가
필요하다 — p6spy·datasource-proxy 로그, 또는 APM의 SQL 스팬. 거기서
`LIMIT` 붙은 목록 쿼리와 `COUNT` 쿼리의 시간을 나란히 읽는다. 지속적으로
보려면 count supplier를 Micrometer `Timer`로 감싸 "목록 p95"와 "count
p95"를 따로 그린다. 슬로 쿼리 로그에 count만 남고 목록은 안 남는 것도 좋은
신호다. 그리고 EXPLAIN은 **count 쿼리에 따로** 걸어 `Extra: Using index`
여부와 `rows`를 본다 — 목록 쿼리의 EXPLAIN은 `LIMIT` 때문에 문제를 숨긴다.

---

## 한 줄 요약

**목록은 `LIMIT`에서 멈추지만 `COUNT`는 조건에 맞는 행을 전부 만나야 하고
(InnoDB는 MVCC 때문에 트랜잭션마다 보이는 행이 달라 행 수를 메타데이터로
들 수 없다), 조건 컬럼이 인덱스에 없으면 그 N건마다 랜덤 I/O가 붙는다 —
비용이 페이지 크기가 아니라 N에 비례하는 요구다. 커버링 인덱스는 배수만
줄이고, 차원을 바꾸려면 근사치(정확도) · 카운트 캐싱(정합성) ·
`Slice`/무한 스크롤(UX) 중 하나를 내줘야 한다. `Page`가 count를 자동으로
붙인다는 사실을 알고, 기본은 `Slice`·`Page`는 근거 필수라는 규약을
ArchUnit과 분리 측정으로 고정하며, 그 가격표를 기획에 보여주는 것까지가
백엔드의 일이다.**
