# JOIN 종류와 실행 방식 — 이미 아는 자바 코드에 PostgreSQL 이름표를 붙인다

> 핵심 관전 포인트: **조인 실행 방식 3종은 새로 배울 게 아니라 이미 아는 코드의 DB 이름이다. 이중 for 루프 = Nested Loop(단 DB는 안쪽 루프를 통순회하지 않고 조인 키 인덱스로 탐색) / 한쪽을 Map에 넣고 다른 쪽을 순회 = Hash Join(빌드는 항상 작은 쪽 — 프로브 비용은 방향과 무관하게 동일하고, 차이는 해시 테이블의 메모리 점유뿐) / 양쪽 정렬 후 두 포인터 병합 = Merge Join. **PostgreSQL은 이 셋을 모두 갖추고 비용으로 고른다**(MySQL의 "NL이 기본" 세계와 결정적으로 다르다). 그래서 튜닝의 축이 "방식을 강제한다"가 아니라 **추정 행 수를 맞추고(통계) · 안쪽 조인 키에 인덱스를 주고 · work_mem을 확인한다**로 바뀐다. 종류 쪽의 핵심은 LEFT JOIN의 매칭 실패 쪽이 NULL로 채워진다는 것 — LEFT 자리에 INNER를 쓰면 에러가 아니라 행이 조용히 사라지는 버그가 되고, 다행히 PostgreSQL에서는 그 사고가 EXPLAIN에 흔적을 남긴다(3-2).**

---

## 0. 질문 + 의도

**질문**: "JOIN의 종류(INNER, LEFT, ...)와 실행 방식(Nested Loop, Hash, Merge)을 설명해주세요."

**출제 의도**: LEFT JOIN을 써야 할 곳에 INNER를 써서 데이터가 **조용히 누락**되는 버그는 리뷰에서 잡아야 한다. 실행 방식은 "조인이 왜 느린가"를 **실행 계획에서 읽는 기초**. 즉 두 축을 본다 — ① 종류: 문법 나열이 아니라 "잘못 고르면 어떤 버그가 나는가"를 아는지, ② 실행 방식: `EXPLAIN (ANALYZE, BUFFERS)`에서 조인 비용을 추론할 밑천이 있는지. 방식 이름을 모르더라도 "자바로 짠다면 이렇게…"라고 원리에서 출발하면 절반은 온 것이고, 이름까지 붙이면 완성이다. PostgreSQL은 실행 계획에 방식 이름이 **노드 이름으로 그대로 찍히므로**(`Nested Loop`, `Hash Join`, `Merge Join`) 이 셋을 아는 것이 곧 계획을 읽는 능력이 된다.

---

## 1. 개념 — JOIN 종류: "매칭 실패한 행을 버리나, NULL로 채워 남기나"

### 1-1. 다섯 종류를 가르는 질문은 하나뿐이다

조인 종류를 가르는 질문은 하나다 — **조인 조건에 매칭되지 않은 행을 어떻게 할 것인가.**

| 종류 | 매칭 실패한 행은 | 결과 |
|---|---|---|
| **INNER JOIN** | 양쪽 모두 버린다 | 양쪽에 다 있는 행만 |
| **LEFT JOIN** | 왼쪽은 남기고, 오른쪽 컬럼을 **NULL로 채운다** | 왼쪽 전부 + 매칭된 오른쪽 |
| **RIGHT JOIN** | 오른쪽은 남기고, 왼쪽 컬럼을 NULL로 채운다 | LEFT의 거울상 |
| **FULL OUTER JOIN** | 양쪽 다 남기고 반대편을 NULL로 채운다 | 양쪽 전부 (**PostgreSQL은 기본 지원** — MySQL은 미지원이라 LEFT ∪ RIGHT UNION으로 흉내) |
| **CROSS JOIN** | 조건 없음 — 모든 조합 | 왼쪽 × 오른쪽 (카테시안 곱) |

비유로 고정하면 — 참석자 명단(왼쪽)과 식사 신청 명단(오른쪽)을 합칠 때, **INNER는 "식사 신청한 참석자만" 남기는 것**이고 **LEFT는 "참석자 전원을 남기되, 식사 신청 안 한 사람은 메뉴 칸을 빈칸(NULL)으로"** 두는 것이다. "참석자 전원 명단 뽑아줘"라는 요구에 INNER를 쓰면, 식사 신청 안 한 사람이 **명단에서 사라진다** — 그런데 아무도 에러를 못 본다.

### 1-2. 시험대는 두 가지 — "NULL 채움"과 "조용한 행 누락"

**① "NULL로 채운다"까지 말해야 LEFT JOIN을 아는 것이다.** "왼쪽은 다 나온다"에서 멈추면 절반이다 — 매칭 안 된 행의 **오른쪽 컬럼들이 NULL로 채워져 나온다**는 사실이 3절의 버그(WHERE에서 NULL이 걸러지는 함정)와 IS NULL 안티조인 패턴("쿠폰 안 쓴 주문만 찾기")의 토대다.

왜 그것이 토대인지는 SQL의 NULL 규칙 하나로 이어진다. **NULL은 "값이 없음"이지 "0"이나 "빈 문자열"이 아니고, 그래서 어떤 비교 연산자에 넣어도 참이 되지 않는다.** `NULL >= '2026-08-01'`의 결과는 거짓(FALSE)조차 아닌 **UNKNOWN**이고, WHERE 절은 UNKNOWN인 행을 남기지 않는다. LEFT JOIN이 애써 살려 둔 행이 그 뒤 WHERE 한 줄에 전멸하는 사고(3-2절)가 여기서 나온다.

**② LEFT와 INNER를 잘못 고르면 에러가 아니라 "조용한 행 누락"이다.** 컴파일 에러도, 런타임 예외도 없다. 쿼리는 멀쩡히 돌고 결과만 슬그머니 줄어든다. 그래서 이 실수는 테스트보다 **리뷰에서** 잡아야 하는 부류다 — 3절에서 before/after로 본다.

---

## 2. 동작 — 실행 방식 3종: 자바 코드 ↔ PostgreSQL 노드 이름 1:1 매핑

`List<Order> orders`(10만 건) × `List<User> users`(1만 건)를 `order.userId = user.id`로 조인한다고 하자. **세 방식 모두 이미 짜본 코드다** — PostgreSQL이 실행 계획에 찍는 이름만 붙이면 된다.

### 2-1. 대응표 — 의사코드와 노드 이름을 나란히 놓고 외운다

이 표 하나가 이 문서의 절반이다. 왼쪽 칸(자바)은 이미 아는 것이고, 가운데 칸(노드 이름)이 `EXPLAIN` 출력에 그대로 찍히는 문자열이며, 오른쪽 칸이 비용의 모양이다.

| 자바로 쓰면 | EXPLAIN에 찍히는 노드 이름 | 비용의 모양 | 필요한 것 |
|---|---|---|---|
| `for (a : A) { b = idx.seek(a.key); }` — 바깥을 돌며 안쪽을 인덱스로 찾는다 | **`Nested Loop`** | 바깥 스캔 + **바깥 행 수 × 안쪽 1건 탐색** | 안쪽 조인 키 **인덱스** |
| `for (b : B) map.put(b.key, b);` 후 `for (a : A) map.get(a.key);` — 작은 쪽으로 Map을 만들고 큰 쪽으로 조회 | **`Hash Join`** (+ 빌드 쪽에 `Hash` 노드) | 양쪽 **각 한 번씩** 스캔 + 해시 CPU | **메모리**(`work_mem`), **등호(=) 조건** |
| `A.sort(key); B.sort(key);` 후 두 포인터로 앞으로만 전진 | **`Merge Join`** (정렬이 필요하면 아래에 `Sort` 노드) | **정렬 비용** + 병합 1회 | 정렬된 입력(인덱스) 또는 정렬 예산 |

> 용어 주의: 교과서의 "Sort-merge 조인"이 PostgreSQL 계획에서는 **`Merge Join`**으로 찍힌다. 정렬이 필요하면 그 아래에 별도 `Sort` 노드가 붙고, 인덱스 순서로 읽어 정렬이 이미 돼 있으면 `Sort` 없이 `Index Scan`이 바로 붙는다 — 즉 "정렬이 공짜인가"를 계획 모양으로 눈으로 확인할 수 있다.

세 줄로 요약하면 이렇다. **Nested Loop는 "바깥 한 행마다 안쪽을 찍어 본다"**, **Hash Join은 "한쪽을 통째로 색인해 두고 다른 쪽을 한 번 훑는다"**, **Merge Join은 "둘 다 줄 세워 놓고 지퍼처럼 맞춘다"**. 이 세 문장에서 각각의 강점과 약점이 그대로 따라 나온다 — 아래 세 절이 그 도출 과정이다.

### 2-2. Nested Loop — 이중 루프, 단 안쪽은 인덱스로 찾아간다

```java
// before: 소박한 NL — 안쪽을 매번 통순회: 10만 × 1만 = 10억 번 비교
for (Order order : orders) {              // 바깥 = outer(드라이빙)
    for (User user : users) {             // 안쪽 = 전체 순회
        if (order.getUserId().equals(user.getId())) {
            // 매칭
        }
    }
}
```

```java
// after: DB의 실제 NL — 안쪽 루프가 "인덱스 탐색 한 번"으로 대체된다
for (Order order : orders) {
    // users.id 인덱스(B+Tree)를 타고 바로 찾아간다 — 통순회 없음
    User user = userIndex.seek(order.getUserId());
    if (user != null) {
        // 매칭
    }
}
```

DB의 NL은 소박한 이중 루프가 아니다 — **안쪽 테이블은 조인 키 인덱스로 탐색**하므로, 바깥 행 하나당 안쪽 비용이 "전체 순회"가 아니라 "트리 탐색 한 번"이다. PostgreSQL 계획에서 이 그림은 이렇게 보인다:

```text
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, o.amount, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.created_at >= '2026-08-01';

 Nested Loop  (cost=0.72..1042.15 rows=210 width=44)
              (actual time=0.031..1.842 rows=203 loops=1)
   Buffers: shared hit=821
   ->  Index Scan using idx_orders_created_at on orders o        ← outer(드라이빙)
         (cost=0.43..210.55 rows=210 width=12)
         (actual time=0.018..0.244 rows=203 loops=1)
         Index Cond: (created_at >= '2026-08-01 00:00:00'::timestamp)
         Buffers: shared hit=209
   ->  Index Scan using users_pkey on users u                    ← inner
         (cost=0.29..3.95 rows=1 width=40)
         (actual time=0.006..0.007 rows=1 loops=203)
         Index Cond: (id = o.user_id)
         Buffers: shared hit=612
 Planning Time: 0.211 ms
 Execution Time: 1.905 ms
```

**읽는 법 세 가지.** ① 조인 노드의 **첫 번째(위) 자식이 outer=드라이빙**, 두 번째가 inner다. ② inner의 `loops=203` = 바깥 행 수만큼 반복했다는 뜻이고, 이 숫자가 NL 비용의 첫 번째 항이다. ③ inner에 `Index Cond`로 조인 키가 걸려 있으면 인덱스 탐색이 성립한 것 — 여기가 `Seq Scan`이면 위의 소박한 이중 루프가 실제로 벌어지고 있다는 신호다.

**비용 숫자가 어떻게 나온 것인지도 한 번은 따라가 볼 만하다.** 조인 노드의 총비용 `1042.15`는 바깥 스캔 `210.55`에, 바깥 **추정** 행 수 210에 안쪽 1회 비용 `3.95`를 곱한 `829.50`을 더하고, 결과 행을 내보내는 CPU 비용(210 × 0.01 = 2.10)을 얹은 값이다 — `210.55 + 829.50 + 2.10 = 1042.15`. **"바깥 행 수 × 안쪽 1회"**라는 NL의 비용 공식이 계획 출력 안에 숫자로 그대로 들어 있다는 것을 확인하는 셈이다.

> 함정 하나: inner 노드의 `actual rows`는 **loops당 평균**이다. 실제 총 행 수는 `rows × loops`(위 예시는 1 × 203 = 203). 이걸 모르면 "안쪽이 1행밖에 안 읽었는데 왜 느리지?"에서 멈춘다.

여기서 튜닝의 기본 문법이 그대로 도출된다:

> **"드라이빙(outer) 테이블은 작게, 안쪽(inner) 테이블의 조인 키에는 인덱스."**

- 바깥 루프 횟수 = 드라이빙 테이블 행 수 → **작은 쪽(조건으로 먼저 줄어드는 쪽)이 바깥**이어야 한다. 플래너가 조인 순서를 정하는 기준이 이것이다.
- 안쪽 조인 키에 인덱스가 없으면? PostgreSQL은 대개 NL을 포기하고 **Hash Join으로 갈아탄다**(MySQL이 예전에 이 자리에서 조인 버퍼로 버티던 것과 다르다). 그래서 "인덱스 없는 조인"이 PostgreSQL에서는 O(N×M) 참사보다는 **예상 못 한 대량 해시 조인 + 디스크 스필**로 나타난다.

**PostgreSQL 특유의 두 가지 (가산점 포인트)**

1. **힙 페치가 따라붙는다.** PostgreSQL은 힙 기반(비클러스터드) 테이블이라 모든 인덱스가 "인덱스 → TID → 힙" 구조다. 그래서 NL 안쪽 비용은 "인덱스 탐색 + 힙 랜덤 접근"이고, 반복 횟수가 커지면 랜덤 I/O가 비싸져 플래너가 순차 읽기 기반의 Hash Join을 고른다. 커버링 인덱스로 `Index Only Scan`이 되면 이 힙 접근이 사라져 NL이 다시 유리해진다.
2. **`Memoize` 노드(PG 14+).** 바깥 행에 같은 조인 키가 반복되면 안쪽 탐색 결과를 캐시한다 — 자바로 치면 `computeIfAbsent`를 씌운 것. 계획에 `Memoize (Hits: 1832 Misses: 210 Evictions: 0)`처럼 찍히고, Hits가 크면 NL이 "중복 키만큼 공짜로" 빨라진 상태다. (그 전 버전에서 같은 자리에 쓰이던 것이 `Materialize`인데, 이쪽은 안쪽 결과 전체를 메모리에 받아 두고 반복 스캔하는 노드다.)

### 2-3. Hash Join — 작은 쪽으로 build, 큰 쪽으로 probe

```java
// 1단계 build: "작은 쪽"(users 1만)으로 해시 테이블을 만든다
Map<Long, User> built = new HashMap<>();
for (User user : users) {
    built.put(user.getId(), user);
}

// 2단계 probe: "큰 쪽"(orders 10만)을 한 번 순회하며 탐색
for (Order order : orders) {
    User user = built.get(order.getUserId());   // O(1) 탐색
    if (user != null) {
        // 매칭
    }
}
```

양쪽을 **각 한 번씩만** 순회하고 끝난다. 인덱스가 필요 없다 — 그래서 **인덱스 없는 대량 조인**(배치, 통계, 임시 테이블 조인)에서 강하다. 대가는 **메모리**(해시 테이블만큼)이고, 제약은 **등호(=) 조인 전용**이라는 것 — 해시는 "같은 값 찾기"만 할 수 있지 `>` 같은 범위 비교는 못 한다.

PostgreSQL 계획에서는 **`Hash` 노드가 붙은 쪽이 빌드 사이드**다:

```text
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id, o.amount, u.name
FROM orders o
JOIN users u ON u.id = o.user_id;

 Hash Join  (cost=280.00..3165.73 rows=99873 width=44)
            (actual time=3.114..48.221 rows=99873 loops=1)
   Hash Cond: (o.user_id = u.id)
   Buffers: shared hit=692
   ->  Seq Scan on orders o                                      ← probe(큰 쪽)
         (cost=0.00..1637.00 rows=100000 width=12)
         (actual time=0.008..8.112 rows=100000 loops=1)
         Buffers: shared hit=637
   ->  Hash                                                      ← build(작은 쪽)
         (cost=155.00..155.00 rows=10000 width=40)
         (actual time=3.081..3.082 rows=10000 loops=1)
         Buckets: 16384  Batches: 1  Memory Usage: 1088kB
         Buffers: shared hit=55
         ->  Seq Scan on users u
               (cost=0.00..155.00 rows=10000 width=40)
               (actual time=0.006..1.104 rows=10000 loops=1)
               Buffers: shared hit=55
```

**여기서 반드시 볼 줄 (실무 직결):** `Batches: 1`이면 해시 테이블이 메모리 안에서 끝났다는 뜻이고, `Batches: 8`처럼 1보다 크면 **디스크로 스필**했다는 뜻이다. 처방은 두 갈래 — ① 빌드 사이드를 더 작게 만든다(선행 필터, 필요한 컬럼만), ② 해시용 작업 메모리를 늘린다.

> **용어 ① 디스크 스필(spill)** — "메모리에서 하려던 작업이 한도를 넘겨 중간 결과를 디스크(임시 파일)로 흘려보내는 것". 해시 조인에서 벌어지는 순서는 이렇다: ⓐ 빌드 사이드로 해시 테이블을 메모리에 만들려 한다 → ⓑ 한도를 넘으면 포기하지 않고 **양쪽을 조인 키 해시값으로 N개 파티션(batch)으로 쪼개** 임시 파일에 쓴다 → ⓒ "batch 1의 빌드 쪽 + batch 1의 프로브 쪽"만 메모리에 올려 조인, batch 2, … 각 batch는 작아서 들어가므로 **결과는 정확히 같다** → ⓓ 대가는 **디스크 쓰기 + 읽기가 한 번씩 추가**된다는 것. 메모리에서 끝났으면 없었을 I/O라 수 배~수십 배 느려진다. 자바로 치면 `HashMap`이 힙에 안 들어가서 키 해시값으로 100개 파일로 나눠 쓰고 파일 단위로 조인하는 것. 정렬도 같은 일이 벌어지고 이름만 다르다(`Sort Method: external merge` = 외부 병합 정렬).
>
> **용어 ② `work_mem`** — "쿼리 실행 중 임시 작업 **하나**가 디스크로 내려가기 전까지 쓸 수 있는 메모리 상한"인 PostgreSQL 설정값(기본 4MB). 여기서 "작업"은 계획의 노드다 — `Sort`, 해시 조인의 `Hash`, `HashAggregate`, `Materialize`. 함정 셋: ⓐ **쿼리당이 아니라 노드당**이라 정렬 3개 + 해시 조인 2개면 최대 `5 × work_mem`이고 병렬 워커 수만큼 또 곱해진다(그래서 전역으로 크게 올리면 `max_connections × 노드 수`만큼 부풀어 OOM 위험 — 전역은 보수적으로 두고 무거운 배치·리포트만 세션에서 올린다), ⓑ **`shared_buffers`와 다르다** — 그쪽은 테이블·인덱스 페이지를 담는 공유 캐시, `work_mem`은 세션이 혼자 쓰는 작업 공간(VACUUM·인덱스 생성용은 또 별도로 `maintenance_work_mem`), ⓒ **해시에는 배수가 붙는다** — `hash_mem_multiplier`(PG 15부터 기본 2.0)가 곱해져 해시 테이블의 실효 한도는 `work_mem × 2`이고, 정렬에는 이 배수가 붙지 않는다.

- PostgreSQL의 작업 메모리는 **`work_mem`이며 쿼리당이 아니라 노드당**이다. 해시 조인·정렬 노드가 여러 개면 그만큼 곱해져 쓰인다.
- 해시 계열은 여기에 **`hash_mem_multiplier`가 곱해진다**(PG 13에서 도입, PG 15부터 기본값 2.0 → 실효 한도 = `work_mem × 2`).
- 세션 단위로 `SET LOCAL work_mem = '64MB'` 후 재실행해 `Batches`가 1로 떨어지는지 보는 것이 정석 확인법이다. 전역으로 크게 올리면 동시 세션 수 × 노드 수만큼 메모리를 먹으니 조심.
- 병렬 계획에서는 `Parallel Hash` / `Parallel Hash Join`(PG 11+)으로 찍힌다 — 워커들이 **공유 해시 테이블 하나**를 함께 만든다.

**빌드 사이드는 항상 작은 쪽이다 — "큰 쪽을 해시로 만들수록 이득"은 오개념이다.** 논증은 이렇다:

1. **프로브 비용은 방향과 무관하게 같다.** 어느 쪽을 build하든 결국 "한쪽 전체를 넣고, 다른 쪽 전체를 순회하며 get" — **양쪽 다 정확히 한 번씩** 훑는 총량은 동일하다. 10만을 넣고 1만으로 찾으나, 1만을 넣고 10만으로 찾으나 순회 총량은 11만으로 같다.
2. **다른 것은 해시 테이블의 크기뿐이다.** 10만 건짜리 Map과 1만 건짜리 Map — 결과는 같은데 메모리 점유만 10배 차이 난다. 큰 쪽을 build하면 **얻는 것 없이 메모리만 더 쓴다.**
3. 그리고 해시 테이블이 작업 메모리를 넘치면 위의 **스필**이 일어나 급격히 느려진다 — 작은 쪽을 build할수록 **스필 위험 자체가 줄어든다.**

즉 "메모리 한계 내에서 가능한 큰 쪽"이 아니라, **애초에 이득이 전무하니 무조건 작은 쪽**이다. 자바에서도 같은 이유로 작은 리스트를 Map으로 만드는 게 정석이다.

> PostgreSQL은 이 원칙을 outer join에서도 관철한다. `a LEFT JOIN b`인데 a가 작으면, PostgreSQL은 a를 해시로 만들고 b로 probe하는 **`Hash Right Join`**으로 뒤집어 실행한다(의미는 그대로, 빌드 사이드만 바꾼 것). 계획에서 `Right`를 보고 "내가 RIGHT JOIN을 안 썼는데?" 하고 당황하지 않으면 된다.

### 2-4. Merge Join — 양쪽 정렬 후 지퍼처럼 병합

```java
// 1단계: 양쪽을 조인 키로 정렬
orders.sort(comparing(Order::getUserId));
users.sort(comparing(User::getId));

// 2단계: 두 포인터로 지퍼 병합 — 각자 앞으로만 전진
int i = 0, j = 0;
while (i < orders.size() && j < users.size()) {
    long orderKey = orders.get(i).getUserId();
    long userKey  = users.get(j).getId();
    if (orderKey == userKey)      { /* 매칭 */ i++; }
    else if (orderKey < userKey)  i++;
    else                          j++;
}
```

병합 단계는 양쪽을 한 번씩만 훑는다(합병 정렬의 merge와 같은 그림). 비용의 대부분은 **정렬**이므로, **입력이 이미 조인 키 순서로 정렬돼 있으면** 정렬이 공짜가 되어 강해진다. PostgreSQL 계획으로 보면 차이가 그대로 드러난다:

```text
-- 정렬이 공짜인 경우: 인덱스 순서로 읽어 Sort 노드가 없다
 Merge Join
   Merge Cond: (o.user_id = u.id)
   ->  Index Scan using idx_orders_user_id on orders o
   ->  Index Scan using users_pkey on users u

-- 정렬 비용을 내는 경우: 아래에 Sort 노드가 붙는다
 Merge Join
   Merge Cond: (o.user_id = u.id)
   ->  Sort   Sort Key: o.user_id
              Sort Method: external merge  Disk: 21544kB   ← 디스크 정렬
         ->  Seq Scan on orders o
   ->  Index Scan using users_pkey on users u
```

`Sort Method: quicksort  Memory: 1234kB`면 메모리에서 끝난 정렬이고, `external merge  Disk: ...`면 `work_mem`을 넘겨 디스크로 내려간 정렬이다 — Hash Join의 `Batches > 1`과 같은 종류의 경고등이다. 해시와 달리 **범위 조건 조인도 소화**할 수 있고(부등호 조인, FULL OUTER 등), `ORDER BY`가 조인 키와 같으면 결과 정렬까지 덤으로 얻는다.

### 2-5. 언제 무엇이 선택되나 — 결론이 아니라 비용으로 따진다

"NL은 소량 조회에 유리하다" 같은 결론만 외우면 판단이 안 선다. 세 방식의 비용을 같은 축에 올려놓으면 선택 기준이 계산에서 나온다. 기호부터 정한다 — **N** = 바깥(드라이빙) 테이블의 조건 적용 후 행 수, **S** = 안쪽 테이블을 통째로 한 번 훑는 비용, **c** = 안쪽에서 인덱스로 한 건 찾아오는 비용.

```text
Nested Loop  =  바깥 스캔  +  N × c            ← 바깥 행마다 안쪽을 한 번씩 찍는다
Hash Join    =  바깥 스캔  +  S  +  해시 CPU    ← 안쪽을 딱 한 번 훑어 색인해 둔다
Merge Join   =  바깥 스캔  +  S  +  정렬 비용   ← 정렬돼 있으면 정렬 항이 0
```

여기서 **NL과 Hash의 손익분기는 `N × c` vs `S`** 라는 한 줄로 압축된다. 즉 **바깥 행 수가 몇 건이냐**가 방식을 가른다 — 안쪽을 통째로 한 번 훑는 값보다 "한 건씩 N번 찍는" 값이 싸면 NL, 비싸지면 Hash다.

숫자를 넣어 보면 감이 잡힌다. 위 예시보다 안쪽이 훨씬 큰 경우로 잡아, **안쪽 테이블이 1000만 행이고 행당 100바이트**라면 약 1GB이고 8KB 페이지에 80행씩 들어가니 **약 12만 5천 페이지**다. PostgreSQL의 기본 비용 단위(`seq_page_cost = 1.0`, `cpu_tuple_cost = 0.01`)로 계산하면 통째 스캔 비용은 `125,000 × 1.0 + 10,000,000 × 0.01 = 225,000`이다. 반면 인덱스로 한 건 찾아오는 비용 c는 계획에 흔히 `cost=0.43..8.45`로 찍히는 값, 즉 **4~9 단위**다.

- c = 9로 잡으면 손익분기 N = 225,000 / 9 ≈ **2만 5천 행**
- c = 5로 잡으면 손익분기 N = 225,000 / 5 = **4만 5천 행**

어느 쪽으로 잡아도 결론은 같다 — **바깥이 수백~수천 건이면 NL이 압도적으로 싸고, 수만 건을 넘어가면 Hash가 이긴다.** 그래서 "OLTP의 단건·소량 조회 조인은 거의 항상 NL, 배치·리포트의 대량 조인은 거의 항상 Hash"라는 실무 경험칙이 나오는 것이고, 이 경험칙은 외운 것이 아니라 위 부등식에서 도출된 것이다.

Merge Join의 자리는 조금 다르다. Hash와 마찬가지로 양쪽을 한 번씩만 훑지만 **정렬 비용을 추가로 내야 하므로**, 정렬 항이 0이 되는 상황 — 양쪽 다 조인 키 인덱스 순서로 읽을 수 있거나, `ORDER BY`가 조인 키와 같아 어차피 정렬해야 하는 경우 — 에서만 Hash를 이긴다. 그리고 **해시가 아예 못 하는 일**(부등호 조인, FULL OUTER JOIN)에서는 비교 대상 없이 Merge가 유일한 선택지가 된다.

정리하면 판별표는 이렇게 된다.

| 상황 | 선택 | 그 이유 |
|---|---|---|
| 바깥이 조건으로 크게 줄었고(수백~수천) 안쪽 조인 키에 인덱스가 있다 | **Nested Loop** | `N × c`가 `S`보다 훨씬 작다. 게다가 첫 행이 즉시 나와 페이지네이션·`LIMIT`에 유리 |
| 양쪽 다 크고 조인 조건이 등호다 | **Hash Join** | 인덱스 없이 각 한 번씩만 훑으면 끝난다. 대가는 메모리 |
| 양쪽이 이미 조인 키로 정렬돼 있다 / `ORDER BY`가 조인 키와 같다 | **Merge Join** | 정렬 항이 0이거나 어차피 내야 할 비용이라 Hash보다 싸진다 |
| 조인 조건이 부등호다 / FULL OUTER JOIN이다 | **Merge Join**(또는 NL) | 해시는 "같은 값 찾기"만 가능해 애초에 후보가 아니다 |
| 안쪽 조인 키에 인덱스가 없다 | **Hash Join** | NL의 c가 "안쪽 통순회"로 폭발한다 → 플래너가 알아서 갈아탄다 |

**그리고 이 표 전체가 "N을 얼마로 추정했는가"에 얹혀 있다.** 통계가 낡아 N을 210으로 추정했는데 실제가 20만이면, 플래너는 위 첫 줄을 보고 NL을 고르고 20만 번의 랜덤 접근을 하게 된다. 그래서 조인 튜닝의 1차 처방이 방식 강제가 아니라 **통계 갱신**인 것이다(2-6절).

### 2-6. PostgreSQL은 셋을 모두 "비용으로" 고른다 — MySQL과의 결정적 차이

| | PostgreSQL | MySQL(8.0) |
|---|---|---|
| Nested Loop | 있음 (+ `Memoize` 캐시, PG 14+) | 있음 — **전통적 기본** |
| Hash Join | 있음 (병렬 해시 조인 포함) | 8.0.18에서 뒤늦게 추가 |
| Merge Join | **있음** | **없음** |
| FULL OUTER JOIN | **지원** | 미지원 (LEFT ∪ RIGHT UNION) |
| 튜닝의 축 | 통계·`work_mem`·인덱스 → **플래너의 선택을 옳게 만들기** | 인덱스·조인 순서 → **NL 최적화** |

**그래서 PostgreSQL 조인 튜닝은 "NL 튜닝"이 아니라 "플래너에게 사실을 알려주는 일"이다.** ① `ANALYZE`(autovacuum의 analyze)로 통계가 최신인가, ② 안쪽 조인 키 인덱스가 있는가, ③ `work_mem`이 스필을 안 낼 만큼인가. 여기에 조인 순서 관련해서 **`join_collapse_limit`(기본 8)**을 알아 두면 좋다 — 조인 테이블이 이 수를 넘으면 PostgreSQL은 조인 순서 탐색을 접거나(FROM 순서를 그대로 쓰거나) `geqo`(유전 알고리즘, 기본 임계값 12)로 근사한다. "테이블 12개 조인인데 계획이 이상하다"의 배경이 이것이다.

진단용 스위치도 있다 — `SET LOCAL enable_nestloop = off;`처럼 특정 방식을 껐다 켜서 "다른 방식이면 얼마나 빠른가"를 재보는 것. **가설 검증 도구이지 운영 설정이 아니다** — 계획이 나쁜 진짜 원인(대개 추정 행 수 오류)을 찾는 데 쓰고, 코드나 서버 설정으로 굳히지 않는다.

---

## 3. 실무 사례 — "조용한 행 누락": 에러 없이 데이터가 사라지는 두 함정

### 3-1. LEFT 자리에 INNER — 쿠폰 안 쓴 주문이 목록에서 사라진다

요구사항: **"주문 목록을 보여주되, 쿠폰을 썼다면 쿠폰 코드도 같이."**

```sql
-- before: INNER JOIN — 쿼리는 멀쩡히 돌지만
SELECT o.id, o.amount, c.coupon_code
FROM orders o
JOIN coupon_use c ON c.order_id = o.id;   -- JOIN = INNER JOIN

-- 쿠폰을 안 쓴 주문은 coupon_use에 행이 없다
-- → 매칭 실패 → INNER는 그 행을 버린다
-- → "쿠폰 미사용 주문"이 주문 목록에서 통째로 사라진다.
-- 에러도 경고도 없다. 사용자 항의("내 주문 어디 갔죠")로 발견된다.
```

```sql
-- after: LEFT JOIN — 주문은 전부, 쿠폰 없으면 NULL
SELECT o.id, o.amount, c.coupon_code
FROM orders o
LEFT JOIN coupon_use c ON c.order_id = o.id;

-- 쿠폰 미사용 주문도 나온다. coupon_code 칸만 NULL.
```

리뷰 체크 습관으로 만들면 — **"이 조인의 오른쪽은 왼쪽 모든 행에 반드시 존재하는가?"** 존재가 보장되지 않는(선택적인) 관계 — 쿠폰, 리뷰, 프로필 사진, 배송 추적 — 에 INNER가 보이면 행 누락을 의심한다. 반대로 반드시 존재하는 관계(주문→주문자)면 INNER가 맞고, 습관적 LEFT는 의도를 흐린다.

> PostgreSQL 한 줄 덧붙임: 습관적 LEFT가 무해하다고만 볼 수도 없다. PostgreSQL 플래너는 **"오른쪽 컬럼을 아무도 안 쓰고, 조인 키가 유니크해서 행이 늘지 않는"** LEFT JOIN은 아예 제거해 버린다(join removal — 계획에서 그 테이블이 사라진다). 즉 조건이 맞으면 공짜지만, 조건이 안 맞으면 그대로 비용이다.

### 3-2. (가산점 포인트) LEFT JOIN 뒤 WHERE에 오른쪽 조건 — LEFT가 조용히 INNER로 강등된다

한 단계 더 교묘한 함정. LEFT JOIN을 제대로 썼는데도 INNER처럼 동작하는 경우다.

```sql
-- before: LEFT JOIN인데 결과는 INNER JOIN과 동일
SELECT o.id, o.amount, c.coupon_code
FROM orders o
LEFT JOIN coupon_use c ON c.order_id = o.id
WHERE c.used_at >= '2026-08-01';
```

왜 그렇게 되는지를 말로만 들으면 잘 안 붙는다. **행 세 개짜리 미니 데이터로 단계를 밟아 보면 눈으로 보인다.**

**원본 데이터** — 주문 3건, 그중 2번 주문은 쿠폰 미사용이고 3번 주문은 7월에 쿠폰을 썼다.

| orders.id | orders.amount |
|---|---|
| 1 | 10000 |
| 2 | 20000 |
| 3 | 30000 |

| coupon_use.order_id | coupon_code | used_at |
|---|---|---|
| 1 | SUMMER10 | 2026-08-05 |
| 3 | JULY5 | 2026-07-20 |

**1단계 — `LEFT JOIN ... ON c.order_id = o.id`를 적용한 직후.** 매칭 실패한 2번은 버려지지 않고 **오른쪽 컬럼이 전부 NULL로 채워져** 살아남는다. 여기까지는 의도대로다.

| o.id | o.amount | c.coupon_code | c.used_at |
|---|---|---|---|
| 1 | 10000 | SUMMER10 | 2026-08-05 |
| 2 | 20000 | **NULL** | **NULL** |
| 3 | 30000 | JULY5 | 2026-07-20 |

**2단계 — 이 결과에 `WHERE c.used_at >= '2026-08-01'`을 적용한다.** WHERE는 조인이 다 끝난 위 표를 대상으로 한 행씩 판정한다.

| o.id | 판정식 | 결과 | 남는가 |
|---|---|---|---|
| 1 | `'2026-08-05' >= '2026-08-01'` | TRUE | 남는다 |
| 2 | `NULL >= '2026-08-01'` | **UNKNOWN** | **탈락** |
| 3 | `'2026-07-20' >= '2026-08-01'` | FALSE | 탈락 |

2번이 탈락하는 이유가 핵심이다. **LEFT JOIN이 NULL로 채워 살려 둔 바로 그 컬럼을 WHERE가 비교 대상으로 삼는 순간, 그 행은 반드시 탈락한다.** NULL은 어떤 값과 비교해도 참이 될 수 없기 때문이다(1-2절의 UNKNOWN 규칙). 결국 "매칭 실패한 행을 살린다"는 LEFT JOIN의 효과가 다음 줄에서 정확히 취소되고, **결과는 INNER JOIN과 한 행도 다르지 않게 된다** — 이것이 "LEFT JOIN의 INNER 강등"이다.

**처방은 조건을 `ON` 절로 옮기는 것이다.**

```sql
-- after: 오른쪽 테이블 조건은 ON으로 올린다
SELECT o.id, o.amount, c.coupon_code
FROM orders o
LEFT JOIN coupon_use c ON c.order_id = o.id
                      AND c.used_at >= '2026-08-01';
```

이렇게 하면 `used_at` 조건이 **"매칭 여부를 판정하는 기준"**이 된다. 3번 주문은 `coupon_use`에 행이 있지만 7월이라 조건을 통과하지 못하므로 **"매칭 실패"로 처리되고, 따라서 NULL로 채워져 살아남는다.** 두 배치의 결과를 나란히 놓으면 차이가 분명하다.

| 주문 | 1단계(조인 직후) | 조건을 **WHERE**에 두면 | 조건을 **ON**에 두면 |
|---|---|---|---|
| 1 — 8/5에 쿠폰 사용 | SUMMER10 | 남는다 (SUMMER10) | 남는다 (SUMMER10) |
| 2 — 쿠폰 미사용 | NULL | **사라진다** | 남는다 (NULL) |
| 3 — 7/20에 쿠폰 사용 | JULY5 | **사라진다** | 남는다 (NULL) |
| **결과 행 수** | 3행 | **1행** | **3행** |

같은 조건 한 줄을 어디에 두느냐로 결과가 **1행과 3행**으로 갈린다. 그리고 3번 주문의 처리를 보면 두 쿼리가 답하는 질문 자체가 다르다는 것도 드러난다 — WHERE 버전은 "8월 이후 쿠폰을 쓴 주문만 보여줘"이고, ON 버전은 "주문은 전부 보여주되 8월 이후 쿠폰만 표시해 줘"다.

원리를 한 문장으로 — **ON은 "무엇을 매칭할지"를 정하고(실패해도 LEFT면 NULL로 살린다), WHERE는 "완성된 결과에서 무엇을 남길지"를 정한다(NULL은 여기서 죽는다).** 그래서 LEFT JOIN에서 오른쪽 테이블 필터는 ON에, 왼쪽 테이블 필터는 WHERE에 두는 것이 원칙이다.

**PostgreSQL에서는 이 사고가 EXPLAIN에 흔적을 남긴다 (실무 팁).** 플래너는 "오른쪽에 strict 조건이 붙었으니 이 outer join은 inner join과 같다"고 판단해 **조인을 실제로 축약한다**(outer join reduction). 그래서 계획에 `Hash Left Join`이 아니라 그냥 **`Hash Join`**이 찍힌다.

```text
-- before의 계획: 내가 쓴 건 LEFT인데 Left가 사라졌다
 Hash Join                        ← Left가 없다 = INNER로 축약됨
   Hash Cond: (c.order_id = o.id)

-- after의 계획
 Hash Left Join                   ← LEFT가 살아 있다
   Hash Cond: (c.order_id = o.id)
```

리뷰나 디버깅에서 **"LEFT JOIN을 썼는데 계획에 `Left`가 없다 → 조건 배치가 잘못됐다"**는 30초 체크가 된다. 반대로 의도적인 예외도 계획에 드러난다 — `WHERE c.order_id IS NULL`(쿠폰 안 쓴 주문만 찾는 안티조인 패턴)은 축약이 아니라 **`Hash Anti Join`**으로 찍히고, 같은 의도를 `NOT EXISTS`로 쓰면 동일한 `Hash Anti Join` 계획이 나온다. 즉 "IS NULL 안티조인"은 우연히 되는 트릭이 아니라 플래너가 알아보는 정식 패턴이다.

---

## 4. 꼬리질문 대비 포인트

### "DB는 해시 테이블을 어느 쪽으로 만드나요? 메모리가 허용하면 큰 쪽으로 만드는 게 이득 아닌가요?"

**항상 작은 쪽이다. 큰 쪽을 build해서 얻는 이득은 없다.** 어느 방향이든 한쪽 전체를 넣고 다른 쪽 전체를 순회하므로 **프로브 비용(순회 총량)은 동일**하다 — 10만을 넣고 1만으로 찾으나 그 반대나 합계는 같다. 달라지는 것은 해시 테이블의 크기뿐이고, 큰 쪽을 build하면 같은 결과에 메모리만 몇 배로 쓴다. 게다가 해시 테이블이 작업 메모리(`work_mem × hash_mem_multiplier`)를 넘치면 디스크 스필로 급격히 느려지므로, 작은 쪽 build는 **스필 위험을 줄이는 선택**이기도 하다. PostgreSQL 계획에서는 `Hash` 노드가 붙은 쪽이 빌드 사이드이므로 **플래너가 정말 작은 쪽을 골랐는지 눈으로 확인**할 수 있고, 거기서 `Batches`가 1인지까지 보면 스필 여부까지 한 번에 읽힌다.

### "PostgreSQL에서 조인 쿼리가 느립니다. 실행 계획에서 먼저 볼 세 가지는?"

① **어떤 방식을 골랐나** (`Nested Loop` / `Hash Join` / `Merge Join`) — 방식 자체를 탓하기 전에, ② **추정과 실제가 얼마나 벌어졌나**: `rows=210` vs `actual rows=200000`처럼 자릿수가 다르면 **잘못된 선택의 원인은 통계**다(→ `ANALYZE`, 상관 컬럼이면 `CREATE STATISTICS`). ③ **메모리 경고등**: Hash Join의 `Batches > 1`, `Sort Method: external merge Disk:` — 스필이면 `work_mem`이나 빌드 사이드 크기를 손댄다. 방식별로 덧붙이면 — NL이면 inner의 `loops`와 `Index Cond` 유무(안쪽이 `Seq Scan`이면 인덱스부터), Hash면 `Hash` 노드가 작은 쪽인지, Merge면 `Sort`가 붙었는지(붙었으면 인덱스로 없앨 수 있는지). `BUFFERS`까지 켜서 `shared read`가 큰 노드를 찾으면 실제 I/O가 어디서 나는지도 잡힌다.

### "LEFT JOIN을 걸었는데 결과가 INNER JOIN과 똑같습니다. 코드는 안 바꿨다는데 뭘 의심하나요?"

**WHERE 절에 오른쪽 테이블 조건이 있는지**부터 본다. LEFT JOIN이 살려둔 매칭 실패 행은 오른쪽 컬럼이 전부 NULL인데, WHERE의 `c.컬럼 = 값`이나 `c.컬럼 >= 값` 비교에서 NULL은 참이 될 수 없어 전부 걸러진다 — LEFT가 조용히 INNER로 변하는 전형적 패턴이다. 처방은 오른쪽 테이블 조건을 ON으로 올리는 것. **PostgreSQL이면 EXPLAIN으로 30초에 확진한다** — 계획에 `Hash Left Join`이 아니라 `Hash Join`이 찍혀 있으면 플래너가 이미 inner join으로 축약했다는 증거다. 단 `c.컬럼 IS NULL`만은 예외로, 매칭 실패 행만 골라내는 의도적 안티조인 패턴이고 계획에도 `Anti Join`으로 찍힌다.

### "세 방식은 각각 언제 이기고, 플래너는 무엇을 보고 고르나요?" (시니어 변별 포인트)

플래너의 입력은 **① 양쪽의 (조건 적용 후) 예상 행 수, ② 조인 키 인덱스·정렬 순서 유무, ③ 조인 조건이 등호인가, ④ work_mem** 이다. 비용으로 말하면 NL은 `바깥 행 수 N × 안쪽 1건 탐색 c`, Hash와 Merge는 `안쪽 통째 스캔 S`(+ Merge는 정렬)이므로 **손익분기는 `N × c` vs `S`** 한 줄로 압축된다 — 안쪽이 1000만 행쯤이면 손익분기 N이 수만 건 근처라, 바깥이 수백~수천이면 **NL**(첫 행이 빨리 나오므로 OLTP 소량 조회의 기본값), 양쪽 다 크고 등호면 **Hash**(인덱스 없이 양쪽 한 번씩, 대신 메모리), 이미 정렬돼 있거나 정렬이 어차피 필요하거나 범위·FULL 조인이면 **Merge**다. 핵심은 **이 판단이 전부 "예상 행 수"에 얹혀 있다**는 것 — 통계가 낡거나 컬럼 간 상관을 못 잡으면(`WHERE city='서울' AND zipcode='06236'` 같은 경우) 추정이 무너지고 방식 선택도 같이 틀어진다. 그래서 "조인 방식이 이상하다"의 1차 처방은 방식 강제가 아니라 **`ANALYZE` / 확장 통계(`CREATE STATISTICS`) / `default_statistics_target` 상향**이다. `enable_nestloop = off` 같은 스위치는 **가설 검증용**이라고 선을 그어 말하면 시니어의 언어가 된다.

### "PostgreSQL은 FULL OUTER JOIN을 지원하는데, 제약이나 주의점이 있나요?"

**지원한다 — 단 조인 조건이 merge/hash 가능해야 한다.** FULL OUTER는 양쪽의 미매칭을 다 추적해야 해서 Nested Loop로는 구현할 수 없고 `Merge Full Join` 또는 `Hash Full Join`으로만 실행된다. 그래서 등호나 merge 가능한 조건이 아니면 실행 자체가 거부된다 — "FULL JOIN is only supported with merge-joinable or hash-joinable join conditions" 에러가 그것이다. 덧붙일 두 가지: ① MySQL에는 FULL OUTER가 없어 **LEFT ∪ RIGHT를 UNION**(UNION ALL이 아니라 — 중복 제거가 필요하므로)으로 흉내 내야 하므로, MySQL 경험자와 대화할 때 이 차이를 알고 있으면 좋다. ② 실무에서 FULL OUTER가 필요한 상황 자체가 드물고(대개 두 집합의 대사·검증 작업), 자주 필요하다면 모델링을 의심해 볼 신호다.

### "MySQL로 물어보면 답이 달라지는 부분은 어디인가요?" (경험 대조)

세 지점이다. ① **기본 방식**: MySQL은 전통적으로 NL 계열이 기본이고 해시 조인이 8.0.18에서 뒤늦게 추가됐으며 **Merge Join은 아예 없다**. 그래서 MySQL 조인 튜닝은 곧 NL 튜닝("드라이빙 작게 + 안쪽 인덱스")에 수렴하는데, PostgreSQL은 세 방식을 비용으로 고르므로 **"플래너가 옳게 고르도록 통계·메모리·인덱스를 갖추는 일"**이 된다. ② **인덱스 안쪽 비용**: InnoDB는 클러스터드 인덱스라 PK 조인의 안쪽 접근이 곧 데이터 접근이지만, PostgreSQL은 힙 기반이라 인덱스 탐색 뒤에 힙 페치가 붙는다(커버링 인덱스로 `Index Only Scan`을 노리는 이유). ③ **FULL OUTER JOIN**: PostgreSQL은 지원, MySQL은 UNION으로 우회. 이 세 개를 짚어 말하면 "한쪽만 써봤다"가 아니라 "차이를 원리로 이해했다"로 들린다.

---

## 한 줄 요약

**조인 실행 방식은 이미 아는 코드의 DB 이름이다 — 이중 루프 = `Nested Loop`(안쪽은 인덱스 탐색, inner의 `loops`와 `Index Cond`를 본다), Map 빌드+탐색 = `Hash Join`(빌드는 항상 작은 쪽 — `Hash` 노드가 붙은 쪽이고 `Batches > 1`이면 스필, 등호 전용), 정렬 후 병합 = `Merge Join`(`Sort` 노드가 없으면 정렬이 공짜). 선택 기준은 결론이 아니라 비용이다 — `바깥 행 수 N × 안쪽 1건 탐색 c` 대 `안쪽 통째 스캔 S`의 대소가 NL과 Hash를 가르고, 정렬 항이 0이 될 때 Merge가 낀다. PostgreSQL은 셋을 모두 비용으로 고르므로 튜닝은 방식 강제가 아니라 통계·인덱스·work_mem을 갖춰 플래너의 선택을 옳게 만드는 일이다. 종류의 핵심은 LEFT JOIN의 매칭 실패 쪽 NULL 채움이며, LEFT 자리에 INNER를 쓰거나 LEFT 뒤 WHERE에 오른쪽 조건을 두면 에러 없이 행이 조용히 사라진다 — PostgreSQL에서는 계획에 `Left`가 사라진 것으로 확진할 수 있다.**
