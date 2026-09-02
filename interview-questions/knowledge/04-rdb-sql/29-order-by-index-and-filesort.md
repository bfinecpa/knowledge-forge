# ORDER BY와 Sort 노드 — 정렬은 인덱스 순서를 "빌리거나", 전부 읽어 "다시 줄 세우거나" 둘 중 하나다

> 핵심 관전 포인트: **`ORDER BY`가 공짜가 되는 경우는 하나뿐이다 — 플래너가 고른 인덱스의 **리프 순서가 곧 정렬 순서**일 때. 그 조건은 여섯 개를 세트로 꺼낸다: ① WHERE 등호 컬럼 + ORDER BY 컬럼이 인덱스 선두부터 **빈칸 없이 연속**(접) ② **범위 조건(`IN` 포함) 뒤 컬럼으로는 정렬 불가**, 범위 컬럼 자체로는 가능(범) ③ 방향이 **전부 같거나 전부 반대**(PostgreSQL은 B-tree를 거꾸로도 읽는다 — `Index Scan Backward`), 혼합은 인덱스 정의에 방향을 명시했을 때만, 그리고 **NULLS FIRST/LAST까지 일치**해야(방) ④ WHERE와 ORDER BY가 **한 인덱스** 안에서(한) ⑤ 컬럼 **원형 그대로** — 함수·연산·`random()` 없음, 표현식 인덱스는 예외(원) ⑥ 조인이면 **드라이빙(outer, 첫 자식) 테이블 컬럼만**(드). 하나라도 깨지면 계획에 **`Sort` 노드**가 붙는다 — 본질은 **"WHERE에 맞는 N건을 전부 읽어 `work_mem` 안에서 정렬 → 넘치면 임시 파일에 청크로 쓰고 다시 읽어 병합(`Sort Method: external merge Disk`) → 그제야 `LIMIT 20` 적용"**이라 비용이 결과 20건이 아니라 **매칭 행 수 N에 비례**한다. 인덱스 순서를 타면 구간 끝에서 20건 읽고 멈춘다. 그래서 인덱스를 WHERE만 보고 걸면 반쪽이고 **"등·범·정·커"의 정(정렬) 자리까지 채워야** 완성이며, 정렬 축이 여럿인 화면은 "축마다 인덱스"가 아니라 **N × 빈도 × 정렬 컬럼의 변동성**(PostgreSQL에서는 그 컬럼의 UPDATE가 HOT에서 탈락해 **모든 인덱스**를 건드린다)으로 인덱스/허용/사전집계를 갈라 결정하고, 그 결정을 `EXPLAIN` 단정 테스트와 `temp_blks_written`·`log_temp_files` 알람으로 고정한다.**

---

## 0. 질문 + 의도

**질문**: "ORDER BY가 인덱스를 타는 조건은? filesort는 언제 발생하고 왜 문제가 되나요?"

**PostgreSQL 기준 재해석**: "ORDER BY가 인덱스 순서를 빌려 `Sort` 노드 없이 처리되는 조건은? 실행 계획에 `Sort` 노드가 붙는 것은 언제이고, 그것이 왜 문제인가요?" — `filesort`는 MySQL 서버 계층의 정렬 단계 이름이고, PostgreSQL의 대응물은 실행 계획의 **`Sort` 노드**(그리고 `Sort Method`가 알려주는 quicksort / top-N heapsort / external merge)다.

**용어 정리를 먼저 하고 넘어간다 — 이 문서의 파일명에 있는 `filesort`는 MySQL 용어다.** MySQL에서 `filesort`는 스토리지 엔진(InnoDB) 위층인 SQL 서버 계층이 "인덱스 순서를 못 빌렸으니 내가 직접 줄을 세우겠다"며 도는 별도 정렬 단계의 이름이고, 실행 계획의 `Extra` 칸에 `Using filesort`로 찍힌다. 이름에 "file"이 들어가지만 **메모리에서 끝나도 그렇게 찍히는** 이름 함정이 있다. **PostgreSQL에서 그 자리에 대응하는 것은 실행 계획의 `Sort` 노드**이고, 그 정렬이 메모리에서 끝났는지 디스크로 갔는지는 `EXPLAIN ANALYZE`가 붙여 주는 `Sort Method` 한 줄(`quicksort` / `top-N heapsort` / `external merge`)이 따로 알려준다. 파일명은 다른 문서들이 이 경로를 참조하고 있어 그대로 두지만, **본문은 전부 PostgreSQL 기준**이다 — 앞으로 "filesort"라는 단어는 MySQL을 대조할 때만, 반드시 "MySQL"이라는 표시와 함께 나온다.

**출제 의도**: rationale의 표현 그대로 — "목록 조회의 기본형(WHERE+ORDER BY+LIMIT)에서 **정렬이 인덱스를 못 타면 매 요청이 정렬 작업이 된다.** WHERE 조건만 보고 인덱스를 설계하는 **반쪽 습관**을 가리는 질문." 즉 이 문항은 "인덱스가 있는가"가 아니라 **"인덱스가 정렬까지 책임지는가"**를 묻는다. 목록 API는 거의 예외 없이 `WHERE … ORDER BY … LIMIT 20` 꼴이고, 여기서 정렬이 새면 **결과는 20건인데 비용은 조건에 맞는 전체 행 수**가 된다 — 데이터가 늘수록 첫 페이지부터 느려지는 가장 흔한 목록 장애의 정체다. 면접관은 ⑴ 인덱스가 정렬을 대신하는 조건을 목록으로 꺼내는지 ⑵ `Sort` 노드의 비용을 "느리다"가 아니라 메커니즘으로 말하는지 ⑶ 정렬용 컬럼을 인덱스에 넣는 대가와, 정렬 축이 여러 개인 화면에서의 판단까지 가는지를 본다.

**이 문서가 특히 겨냥하는 네 지점** (4장 전 구간에서 반복된 패턴):

- **비용을 이름 붙은 사슬로** — "Sort가 있어서 느리다"에서 멈추지 않고, 매칭 N건 전부 읽기(힙 페치 포함) → `work_mem` 적재 → 스필 → 머지 → 그 뒤에야 LIMIT — 고리를 하나씩 잇고, 인덱스 경로의 "20건 읽고 중단"과 나란히 놓는다(2-2).
- **트레이드오프를 양면으로** — 정렬 컬럼을 인덱스에 넣으면 무엇을 내주는지(폭·HOT 탈락에 의한 쓰기 증폭), 정렬 기준이 다섯 개인 화면에서 "인덱스 5개 vs Sort 허용 vs 사전 집계"를 어떤 기준으로 가르는지(2-5, 2-6).
- **안전망을 코드로 고정** — 목록 API의 `EXPLAIN (FORMAT JSON)` 단정 테스트(허용한 Sort는 목록으로 선언), `auto_explain`·`log_temp_files`·`pg_stat_statements`의 임시 파일 지표 알람, 정렬 파라미터 화이트리스트(3-3 ~ 3-5).
- **목록 인출** — "인덱스를 타는 조건 6"과 "Sort가 나는 패턴 7"을 세트로, 계획에서 만나는 다섯 모양과 `Sort Method` 세 값의 해석을 즉시 꺼낼 수 있게(1-3, 1-4, 2-4).

**옆 문서와의 경계**: [복합 인덱스 컬럼 순서](08-composite-index-column-order.md)가 "등·범·정·커" 네 자리를 세우고 순서 오류의 사슬을 다뤘다면, 이 문서는 그중 **"정"의 자리 하나만** 깊게 판다. `OFFSET`이 커서 생기는 비용은 [깊은 페이지네이션](13-deep-pagination-offset-vs-cursor.md), `EXPLAIN`을 읽는 순서와 개선 사이클은 [실행 계획 읽기](10-explain-and-slow-query-process.md), `Index Only Scan`의 의미는 [커버링 인덱스](09-covering-index.md)에 있다. 여기서는 그것들을 전제로 **정렬 축**만 본다.

---

## 1. 원리 — 정렬을 공짜로 얻는 조건은 "리프 순서 = 정렬 순서" 하나뿐이다

### 1-1. 전제 — B+Tree의 리프는 "키 순서로 이어진 하나의 줄"이다

이 문서의 결론은 전부 한 가지 사실 위에 서 있는데, 그 사실이 보통 설명 없이 놓인다. 먼저 그것부터 깔고 간다.

PostgreSQL의 기본 인덱스인 **B-tree(정확히는 B+Tree 계열)는 값을 정렬해서 보관한다.** 트리의 위층(내부 노드)은 "어느 자식으로 내려가야 하는가"만 가리키는 이정표이고, **실제 데이터 항목은 전부 맨 아래층인 리프(leaf) 페이지에만** 있다. 그리고 그 리프 페이지들은 **왼쪽에서 오른쪽으로 형제 링크(sibling pointer)로 이어져 있다** — 페이지 안에서도 키 순서, 페이지와 페이지 사이도 키 순서다([B-tree 구조](01-index-and-bplus-tree.md)).

여기서 나오는 결론이 이 문서의 전부다.

```text
인덱스 (updated_at) 의 리프 — 트리를 옆에서 자른 그림

        [내부 노드: 05-01 | 08-01 | 08-20 ]      ← 이정표. "어느 리프로 갈까"만 안다
          ╱            │            ╲
   ┌───────────┐  ┌───────────┐  ┌───────────┐
   │05-01 05-03│→ │08-01 08-04│→ │08-20 08-29│→ ...   ← 리프. 데이터는 여기만 있고
   │05-07 ...  │  │08-11 ...  │  │08-30 08-31│         페이지끼리 →로 이어져 있다
   └───────────┘  └───────────┘  └───────────┘
        ↑                                    ↑
   여기서 오른쪽으로 쭉 읽으면           여기서 왼쪽으로 쭉 읽으면
   updated_at 오름차순이 그냥 나온다      내림차순이 그냥 나온다
   (Index Scan)                          (Index Scan Backward)
```

**"인덱스를 순서대로 훑으면 정렬이 공짜로 따라온다"**는 말은 이 그림 한 장이다. 정렬을 하는 게 아니라, **이미 정렬된 것을 순서대로 읽을 뿐**이다. 비유하면 사전이다 — 사전에서 "ㄱ으로 시작하는 단어를 가나다순으로 20개"를 뽑는 데 드는 일은 페이지를 펴서 읽는 것뿐이고, 아무도 단어를 다시 줄 세우지 않는다.

그리고 반대 방향도 공짜다. 리프가 양방향으로 이어져 있으므로 **끝에서 앞으로 읽으면 내림차순**이다. PostgreSQL 실행 계획에서 이것이 `Index Scan Backward`라는 이름으로 나온다 — 계획에 이 이름이 보이면 "DESC 정렬을 인덱스가 해결했다"는 좋은 신호다.

> 왜 정렬이 "공짜"라는 표현을 쓰는가. 정렬(sort)은 원래 **N개를 서로 비교해 순서를 정하는 작업**이고, 최선의 비교 정렬 알고리즘도 대략 `N × log₂N`번의 비교가 필요하다. N이 8만이면 130만 번이다(2-2에서 계산한다). 리프를 순서대로 읽으면 이 비교가 **0번**이다. 그래서 "공짜"다.

### 1-2. 한 문장 원리 — "리프 순서 = 정렬 순서"

앞의 전제를 쿼리에 붙이면 원리가 나온다.

**플래너가 어떤 인덱스의 연속 구간을 읽고 있는데, 그 구간이 흘러나오는 순서가 `ORDER BY`가 원하는 순서와 같다면, 정렬은 이미 돼 있는 셈이라 아무 일도 안 해도 된다.** 이것이 유일한 공짜 경로다. 반대로 읽는 순서와 원하는 순서가 다르면, DB는 읽은 것을 **어딘가에 모아 다시 줄 세우는** 수밖에 없다 — 그게 계획의 `Sort` 노드다.

```text
웹툰 목록: WHERE genre = 'ROMANCE' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20

인덱스 (genre, status, updated_at)의 리프
 ┌ ACTION ────────────┐┌ ROMANCE ─────────────────────────────────────────────┐┌ THRILLER ─┐
 │ ACTIVE  │ ENDED    ││ ACTIVE ····························· │ ENDED ······ ││ ...       │
 │ 07-01.. │ 06-02..  ││ 05-01 05-03 ... 08-29 08-30 08-31 ▲   │ 04-11 ...    ││           │
 └────────────────────┘└──────────────────────────────┬─────────────────────┘└───────────┘
                                                      └ 여기서 왼쪽으로 20칸 읽고 끝
   genre = ROMANCE, status = ACTIVE 로 "칸" 하나에 점프 → 그 칸 안은 이미 updated_at 순
   → 오른쪽 끝(최신)에서 거꾸로 20 엔트리 읽고 중단(Index Scan Backward). 정렬 작업 0.
```

전화번호부 비유를 이어 쓰면 — "김 씨 중 서울 거주자를 **이름순**으로 20명"은 전화번호부가 (성, 지역, 이름) 순으로 묶여 있을 때만 페이지를 펴서 그대로 읽는다. (성, 이름, 지역) 순이면 김 씨를 이름순으로 넘기며 서울인 사람만 골라야 하고, (성, 지역, 전화번호) 순이면 서울 김 씨를 **다 뽑아 놓고 이름순으로 다시 늘어놓아야** 한다. 마지막이 `Sort` 노드다.

> PostgreSQL 한 겹 더: 리프에서 읽은 엔트리는 **TID(힙 위치)로 힙을 찾아가야** 비로소 행이 된다(모든 인덱스가 세컨더리인 힙 테이블 — [클러스터드/세컨더리](03-clustered-vs-secondary-index.md)). 그래서 "N건을 읽는다"는 PostgreSQL에서 "N번 힙을 찌른다"이고, 인덱스 경로의 "20건 읽고 중단"은 힙 방문도 20회로 끝낸다는 뜻이다. 커버링(`Index Only Scan`)이면 그 20회마저 사라진다.

### 1-3. ORDER BY가 인덱스를 타는 조건 6 — "접·범·방·한·원·드"

여섯 조건을 여섯 글자로 줄여 외운다. 다만 **암기 장치는 인출을 돕는 손잡이일 뿐이고, 각 글자가 무엇의 줄임이며 왜 필요한지를 모르면 손잡이만 남는다.** 먼저 글자를 풀어 두고, 이어서 조건마다 한 소절씩 이유를 붙인다.

| 글자 | 무엇의 줄임인가 | 조건 한 줄 |
|---|---|---|
| **접** | **접**두사 연속 | WHERE **등호(상수)** 컬럼들 + ORDER BY 컬럼들이 인덱스 **선두부터 빈칸 없이 연속** |
| **범** | **범**위 조건 뒤 | **범위 조건(`>`, `BETWEEN`, `LIKE 'x%'`, 그리고 `IN`) 뒤 컬럼으로는 정렬 불가.** 범위 컬럼 **자체**로 정렬은 가능 |
| **방** | 읽는 **방**향 | 방향이 **전부 같거나 전부 반대**(`Index Scan Backward`). 혼합(`a ASC, b DESC`)은 인덱스를 그 방향으로 정의했을 때만. **NULLS FIRST/LAST도 일치**해야 |
| **한** | **한** 인덱스 | WHERE에 쓴 인덱스와 ORDER BY에 쓸 인덱스가 **같은 하나**여야 한다 |
| **원** | 컬럼 **원**형 | 정렬 컬럼이 **원형 그대로** — 함수·연산·형변환·`random()` 없음 (**표현식 인덱스**는 예외) |
| **드** | **드**라이빙 테이블 | 조인이면 ORDER BY 컬럼이 **전부 드라이빙(outer, 계획 트리의 첫 자식) 테이블** 것이고, 조인 방식이 순서를 보존해야 |

#### ① 접 — 앞 컬럼 값이 하나로 고정돼야 그 안에서 뒤 컬럼 순서가 살아 있다

복합 인덱스 `(A, B, C)`는 "A로 정렬하고, **A가 같은 것끼리만** B로, **A와 B가 둘 다 같은 것끼리만** C로" 정렬된 하나의 트리다. 그러니 `C`로 정렬된 구간을 얻으려면 그 앞의 `A`와 `B`가 **하나의 값으로 못 박혀** 있어야 한다. 못 박는 조건이 등호(`=`)다.

빈칸이 하나라도 있으면 깨진다. `(genre, status, updated_at)` 인덱스에 `WHERE genre = 'ROMANCE' ORDER BY updated_at`을 주면, `genre = 'ROMANCE'` 구간 안에서 `updated_at`은 **status별로 따로 정렬**돼 있다 — ACTIVE 칸의 시간축, ENDED 칸의 시간축, HIATUS 칸의 시간축이 각각 따로 논다. 전체를 하나로 보면 순서가 아니다.

반대로 그 빈칸을 `ORDER BY`가 채워 주면 살아난다 — `WHERE genre = 'ROMANCE' ORDER BY status, updated_at`은 인덱스 리프 순서 그대로다. **"WHERE 등호 컬럼 + ORDER BY 컬럼"을 이어 붙인 것이 인덱스 선두부터 연속이면 된다**가 정확한 서술이고, 둘 중 어느 쪽이 그 자리를 채우는지는 상관없다.

#### ② 범 — 범위 조건은 앞 컬럼을 "여러 값에 걸쳐 열어 놓는다"

여기가 여섯 중 가장 자주 틀리는 자리이고, [복합 인덱스 컬럼 순서](08-composite-index-column-order.md)의 핵심과 **완전히 같은 원리**다. 문장으로 읽으면 "범위 뒤는 안 된다"인데, 왜 안 되는지는 리프를 실제 행 목록으로 펼쳐 놓고 구간에 밑줄을 그으면 눈으로 보인다.

`(genre, status, updated_at)` 인덱스의 리프를 ROMANCE 구간만 펼쳐 본다. 왼쪽 컬럼부터 차례로 정렬되므로 이렇게 늘어선다(status는 문자열이라 ACTIVE < ENDED < HIATUS 순).

```text
인덱스 (genre, status, updated_at)의 리프 — ROMANCE 구간만

  #   genre     status    updated_at   가리키는 힙 주소(TID)
 ---  --------  --------  -----------  --------------------
   1  ROMANCE   ACTIVE    08-01        (12,3)
   2  ROMANCE   ACTIVE    08-14        (98,1)
   3  ROMANCE   ACTIVE    08-30        (41,7)
   4  ROMANCE   ENDED     08-05        (12,9)
   5  ROMANCE   ENDED     08-22        (77,2)
   6  ROMANCE   HIATUS    08-03        ( 5,4)
   7  ROMANCE   HIATUS    08-27        (63,1)

 읽는 법:
   - status 는 ROMANCE 구간 안에서 오름차순이다 (ACTIVE,ACTIVE,ACTIVE,ENDED,ENDED,HIATUS,HIATUS)
   - updated_at 은 "genre 와 status 가 둘 다 같은 구간 안에서만" 오름차순이다
     (1~3행: 08-01,08-14,08-30 / 4~5행: 08-05,08-22 / 6~7행: 08-03,08-27)
```

이 목록 위에 조건을 하나씩 대 본다.

```text
[된다] WHERE genre='ROMANCE' AND status='ACTIVE'  ORDER BY updated_at
   1  ROMANCE  ACTIVE   08-01   ┐
   2  ROMANCE  ACTIVE   08-14   ├─ 등호 두 개가 앞 두 칸을 하나로 못 박았다.
   3  ROMANCE  ACTIVE   08-30   ┘  그 안의 updated_at 칸을 세로로 읽으면 08-01, 08-14, 08-30 — 오름차순.
   4  ROMANCE  ENDED    08-05      → 시작점(1행) 찍고 아래로 읽으면 그게 곧 정렬 결과다. Sort 없음.
   5  ROMANCE  ENDED    08-22
   6  ROMANCE  HIATUS   08-03
   7  ROMANCE  HIATUS   08-27


[안 된다] WHERE genre='ROMANCE' AND status >= 'A'  ORDER BY updated_at     ← 범위 조건
   1  ROMANCE  ACTIVE   08-01   ┐
   2  ROMANCE  ACTIVE   08-14   │
   3  ROMANCE  ACTIVE   08-30   │  status >= 'A' 는 ACTIVE·ENDED·HIATUS 를 전부 연다.
   4  ROMANCE  ENDED    08-05   ├─ 구간은 연속(1~7행)이라 스캔은 된다. 그런데
   5  ROMANCE  ENDED    08-22   │  updated_at 칸을 세로로 읽으면:
   6  ROMANCE  HIATUS   08-03   │    08-01, 08-14, 08-30, 08-05, 08-22, 08-03, 08-27
   7  ROMANCE  HIATUS   08-27   ┘  → 오름차순이 아니다. status 칸막이가 시간축을 세 토막으로
                                    잘라 각각 따로 정렬했기 때문이다. → 7건을 다 읽고 Sort.


[안 된다] WHERE genre='ROMANCE' AND status IN ('ACTIVE','HIATUS')  ORDER BY updated_at   ← IN 도 범위다
   1  ROMANCE  ACTIVE   08-01   ┐ 조각 1 — 이 안에서는 08-01, 08-14, 08-30 오름차순
   2  ROMANCE  ACTIVE   08-14   │
   3  ROMANCE  ACTIVE   08-30   ┘
   4  ROMANCE  ENDED    08-05     (제외)
   5  ROMANCE  ENDED    08-22     (제외)
   6  ROMANCE  HIATUS   08-03   ┐ 조각 2 — 이 안에서는 08-03, 08-27 오름차순
   7  ROMANCE  HIATUS   08-27   ┘
                                 → 조각 안은 각각 정렬돼 있지만 "두 조각을 합친 순서"는 없다.
                                   08-01 다음이 08-03(조각 2)인지 08-14(조각 1)인지는
                                   두 조각을 동시에 보며 비교해야만 알 수 있다. → Sort.


[된다] WHERE genre='ROMANCE' AND status='ACTIVE' AND updated_at >= '08-10'  ORDER BY updated_at
   1  ROMANCE  ACTIVE   08-01      (제외)
   2  ROMANCE  ACTIVE   08-14   ┐─ 범위 컬럼 "자체"로 정렬하는 것은 된다.
   3  ROMANCE  ACTIVE   08-30   ┘  범위가 잡아낸 구간(2~3행)이 이미 updated_at 순이기 때문이다.
```

세 번째 예가 이 문서의 실무 사례 3-2에서 그대로 터지는 회귀다. **`IN`은 "값 목록"이라 등호처럼 보이지만, 인덱스 리프에서는 값마다 구간이 갈라지므로 범위와 같은 취급**이라는 것을 여기서 못 박아 둔다.

정리하면 규칙은 한 줄이다.

> **앞 컬럼의 값이 하나로 고정돼야, 그 안에서 뒤 컬럼의 정렬이 살아 있다. 범위 조건은 앞 컬럼을 여러 값에 걸쳐 열어 놓으므로, 그 뒤 컬럼의 정렬은 값마다 따로 논다.**

#### ③ 방 — 인덱스는 앞→뒤 아니면 뒤→앞, 두 방향뿐이다

리프는 한 줄로 이어진 목록이다. 그러니 읽는 방법은 **처음부터 끝까지**(`Index Scan`)이거나 **끝에서 처음까지**(`Index Scan Backward`), 둘뿐이다. `ORDER BY updated_at DESC`는 두 번째로 처리된다 — 그래서 "전부 ASC"와 "전부 DESC"는 둘 다 공짜다.

문제는 **혼합**이다. `ORDER BY status ASC, updated_at DESC`는 "status는 앞에서 뒤로, updated_at은 뒤에서 앞으로" 읽으라는 뜻인데, 한 줄짜리 목록을 그렇게 읽을 방법이 없다. 해법은 **인덱스를 만들 때 방향을 박아 넣는 것**이다 — `CREATE INDEX … ON webtoon (genre, status ASC, updated_at DESC)`로 만들면 리프가 애초에 그 순서로 늘어서므로 앞에서 뒤로 읽기만 하면 된다.

**NULL의 위치도 순서의 일부다.** PostgreSQL의 기본은 `ASC NULLS LAST`(오름차순일 때 NULL이 맨 뒤)이고, 그 인덱스를 거꾸로 읽으면 자동으로 `DESC NULLS FIRST`가 된다. 그래서 `ORDER BY updated_at DESC NULLS LAST`를 기본 인덱스로 처리하려 하면 **NULL이 있어야 할 자리가 반대**라 순서를 못 빌린다. 해결은 둘 — 인덱스를 `(… updated_at DESC NULLS LAST)`로 만들거나, **컬럼을 `NOT NULL`로 만들어 NULL 위치 문제 자체를 없애는 것**이다. 후자가 대개 더 좋은 답이다.

#### ④ 한 — 인덱스를 둘 합치면 순서가 사라진다

`(genre)` 인덱스와 `(updated_at)` 인덱스가 따로 있고 쿼리가 `WHERE genre = $1 ORDER BY updated_at DESC`라면, 플래너는 둘 중 **하나만** 고르고 나머지 일을 다른 노드로 떠넘긴다.

- `(genre)`를 고르면 → 로맨스 8만 건을 모아 놓고 `Sort`.
- `(updated_at)`을 고르면 → 최신순으로 걸으면서 `Filter: genre = $1`로 버려 가며 20건을 채운다. `Sort`는 없지만 **몇 건을 걸어야 20건이 차는지는 그 장르의 비율에 달렸다** — 이것이 4장 마지막 꼬리질문의 함정이다.

두 인덱스를 **동시에** 쓰는 길도 있긴 하다. PostgreSQL은 `BitmapAnd`/`BitmapOr`로 두 인덱스의 TID 집합을 합칠 수 있는데, **합치는 순간 순서가 사라진다.** TID 비트맵은 "어느 힙 페이지의 어느 슬롯이 필요한가"를 물리 위치 순으로 모아 놓은 것이지 인덱스 키 순서가 아니기 때문이다. 그러니 "인덱스가 둘 다 쓰였으니 정렬도 되겠지"는 성립하지 않는다.

#### ⑤ 원 — 리프에는 `값`이 들어 있지 `f(값)`이 들어 있지 않다

인덱스 리프에 저장된 것은 컬럼 값 그 자체다. `ORDER BY lower(title)`은 "`lower(title)` 순서"를 요구하는데 리프는 `title` 순서로 정렬돼 있다 — `Apple`과 `apple`과 `Banana`가 `title` 순서와 `lower(title)` 순서에서 다르게 놓일 수 있으므로, 리프 순서를 그대로 쓸 수 없다.

같은 이유로 `updated_at + interval '1 day'`, `CAST(id AS text)`, `array_position(ARRAY['ACTIVE','HIATUS','ENDED'], status)`(사용자 정의 순서) 전부 안 된다. `random()`은 아예 매 행마다 값이 달라지므로 **항상 전체 정렬**이다.

예외는 **표현식 인덱스(expression index)** — `CREATE INDEX … ON webtoon (genre, status, lower(title))`처럼 **인덱스를 만들 때 같은 식으로 만들어 두면** 리프에 `lower(title)` 값이 들어가므로 순서를 빌릴 수 있다. 단 쿼리의 식과 인덱스의 식이 **글자 그대로 일치**해야 플래너가 알아본다.

#### ⑥ 드 — 조인 결과의 순서를 만드는 것은 드라이빙 테이블뿐이다

조인은 두 테이블을 합치는 작업이고, 합친 결과가 어떤 순서로 나오는지는 **조인 방식**이 정한다. PostgreSQL의 조인 방식 셋을 순서 관점에서만 보면([JOIN 실행 방식](06-join-types-and-execution.md)):

| 조인 방식 | 결과의 순서 | 정렬을 빌릴 수 있나 |
|---|---|---|
| `Nested Loop` | **드라이빙(outer) 테이블의 순서 그대로** — outer 한 행마다 inner를 찾아 붙이므로 outer 순서가 유지된다 | outer 컬럼으로 정렬하면 **가능** |
| `Merge Join` | **조인 키 순서** — 양쪽을 조인 키로 정렬해 지퍼처럼 맞물리므로 결과도 조인 키 순 | `ORDER BY`가 조인 키와 같으면 **덤으로 해결** |
| `Hash Join` | **보장 없음** — inner로 해시 테이블을 만들고 outer를 흘려보내는데, 플래너는 이 출력에 순서가 있다고 보지 않는다 | **불가** |

그래서 "outer 테이블 컬럼으로 정렬했는데 `Sort`가 붙었다"면, 조건 ⑥의 앞쪽(어느 테이블 컬럼인가)이 아니라 뒤쪽(조인 방식)이 원인일 수 있다 — 플래너가 `Hash Join`을 골랐기 때문이다. 그리고 **inner 테이블 컬럼으로 정렬하는 것은 어느 방식으로도 안 된다** — inner 쪽 행은 조인이 끝나야 어떤 것들이 결과에 남는지 알 수 있으므로, 순서를 미리 정할 방법이 없다.

#### 여섯 조건 위의 전제 하나 — 플래너가 그 인덱스를 `Index Scan`으로 골라야 한다

조건을 다 만족하는 인덱스가 있어도 **플래너가 그것을 안 고르면 소용없다.** 비용 계산상 다른 인덱스 + `Sort`가 싸다고 판단하면 그쪽으로 간다.

PostgreSQL 고유의 함정 하나가 여기 붙는다. 매칭 행이 많으면 플래너는 같은 인덱스라도 **`Bitmap Heap Scan`**을 고른다 — 인덱스에서 TID를 전부 모아 **힙의 물리 순서로 재배열**한 뒤 힙을 순차로 읽는 방식이다. 랜덤 I/O를 순차 I/O로 바꾸는 좋은 최적화지만, **재배열하는 순간 인덱스 키 순서를 버린다.** 그러면 인덱스가 정렬 순서를 갖고 있어도 위에 `Sort`가 붙는다. `LIMIT`이 있으면 플래너가 "앞 20건만 있으면 된다"를 알고 `Index Scan`을 유지하는 편이지만, `LIMIT` 없는 대량 목록은 이 경로로 빠지기 쉽다.

#### 조건 6을 웹툰 스키마 한 줄씩으로

인덱스는 전부 `(genre, status, updated_at)`이라고 두고 읽는다. `O`는 Sort 없음, `X`는 계획에 `Sort`가 붙는다는 뜻이다.

```sql
-- ① 접: 등호 두 개 + 정렬 컬럼이 선두부터 연속 → 인덱스 순서 그대로
WHERE genre = $1 AND status = $2          ORDER BY updated_at DESC      -- O  Sort 없음
WHERE genre = $1                          ORDER BY updated_at DESC      -- X  가운데 status 빈칸 → Sort
WHERE genre = $1                          ORDER BY status, updated_at   -- O  빈칸을 ORDER BY가 채우면 연속

-- ② 범: 범위 컬럼 "자체"로 정렬은 되고, 범위 "뒤" 컬럼으로는 안 된다
WHERE genre = $1 AND status = $2 AND updated_at >= $3  ORDER BY updated_at DESC   -- O  범위 = 정렬 컬럼
WHERE genre = $1 AND status IN ('ACTIVE','HIATUS')     ORDER BY updated_at DESC   -- X  IN은 구간이 갈라진다
WHERE genre = $1 AND status >= 'A'                     ORDER BY updated_at DESC   -- X  범위 뒤 컬럼

-- ③ 방: 전부 반전은 되고(Index Scan Backward), 혼합은 방향을 준 인덱스가 있어야 한다
WHERE genre = $1 AND status = $2  ORDER BY updated_at DESC               -- O  Index Scan Backward
WHERE genre = $1                  ORDER BY status DESC, updated_at DESC  -- O  둘 다 반전 → 역방향
WHERE genre = $1                  ORDER BY status ASC,  updated_at DESC  -- X  혼합 → Sort
--   → CREATE INDEX ... ON webtoon (genre, status ASC, updated_at DESC) 로 만들면 O
WHERE genre = $1 AND status = $2  ORDER BY updated_at DESC NULLS LAST    -- X  기본 인덱스(ASC NULLS LAST)를
--   거꾸로 읽으면 DESC NULLS FIRST다. NULLS LAST를 원하면 인덱스도 (… updated_at DESC NULLS LAST)로,
--   또는 컬럼을 NOT NULL로 만들어 NULL 위치 문제 자체를 없앤다

-- ④ 한: WHERE는 (genre)로, ORDER BY는 (updated_at)로 — 인덱스가 둘로 갈리면 하나만 쓴다
--   인덱스가 (genre) 와 (updated_at) 따로 있을 때:
WHERE genre = $1                  ORDER BY updated_at DESC    -- X  (genre) + Sort, 또는 (updated_at) 역순 걷기 + Filter

-- ⑤ 원: 컬럼에 손대면 순서가 깨진다 — 단 같은 식으로 만든 표현식 인덱스가 있으면 산다
ORDER BY lower(title)           -- X  단, CREATE INDEX ... ON webtoon (genre, status, lower(title)) 가 있으면 O
ORDER BY updated_at + interval '0'   -- X     ORDER BY random()   -- X (항상 전체 정렬)
ORDER BY array_position(ARRAY['ACTIVE','HIATUS','ENDED'], status)   -- X  사용자 정의 순서는 인덱스에 없다

-- ⑥ 드: 조인 시 정렬 컬럼이 inner 테이블 것이면 조인 결과를 모아 정렬한다
SELECT w.*, a.name FROM webtoon w JOIN author a ON a.id = w.author_id
WHERE w.genre = $1 ORDER BY w.updated_at DESC   -- O  드라이빙(w) 컬럼 — 단 Nested Loop일 때
WHERE w.genre = $1 ORDER BY a.name              -- X  조인 위에 Sort
```

**(가산점 포인트) 커서 페이지네이션의 tie-breaker `id`는 인덱스에 명시해야 한다.** tie-breaker란 정렬 키 값이 같은 행들 사이의 순서를 확정하려고 뒤에 덧붙이는 컬럼이다 — `updated_at`이 같은 두 행의 앞뒤가 요청마다 뒤바뀌면 커서 페이지네이션에서 행이 중복되거나 건너뛰어지므로, 보통 `ORDER BY updated_at DESC, id DESC`처럼 PK를 붙인다.

여기서 PostgreSQL 고유의 사정이 하나 있다. **PostgreSQL 인덱스 리프는 키 뒤에 TID(힙 위치)를 달지 PK를 달지 않는다.** 그래서 `(genre, status, updated_at)`은 물리적으로도 딱 그 세 컬럼 순서고, `id`는 인덱스에 없는 컬럼이다 — 조건 ①(접)이 깨진다.

다만 PostgreSQL은 이 상황을 **`Incremental Sort`(PG 13+)**로 값싸게 처리한다. 입력이 `updated_at`까지는 이미 정렬돼 있으니(계획에 `Presorted Key: updated_at`으로 찍힌다), 같은 `updated_at` 값을 가진 **작은 묶음 안에서만** `id`로 정렬하고, `LIMIT 20`이 차면 멈춘다. 그래도 확실히 하려면 인덱스에 `id`를 명시한다(`(genre, status, updated_at, id)` — [깊은 페이지네이션 §2-1](13-deep-pagination-offset-vs-cursor.md)과 같은 조언).

> MySQL 대조: InnoDB 세컨더리 인덱스는 리프에 PK를 품으므로 `(genre, status, updated_at)`이 물리적으로 `(genre, status, updated_at, id)` 순이라 tie-breaker가 공짜다. PostgreSQL은 공짜가 아닌 대신 `Incremental Sort`가 그 틈을 메운다 — MySQL에는 접두 정렬을 재사용하는 이 노드가 없다.

### 1-4. Sort 노드가 나는 대표 패턴 7 — 조건 6의 거울상

조건 6은 "언제 되는가"이고, 이 일곱은 "언제 안 되는가"다. 같은 내용을 뒤집은 것이지만 **실무에서 만나는 것은 항상 이쪽 얼굴**이라 따로 외워 둘 값어치가 있다. `auto_explain` 로그에서 `Sort`를 봤을 때 **쿼리를 보자마자 어느 패턴인지 지목**하는 것이 목표다.

1. **정렬 컬럼에 인덱스가 아예 없다** — `Seq Scan` 또는 WHERE용 인덱스 + `Sort`.
2. **WHERE 인덱스와 ORDER BY 인덱스가 딴 것이다**(조건 ④ 위반) — `(genre)`와 `(updated_at)`이 따로. 플래너는 둘 중 하나를 고르고 나머지 일을 `Sort`나 `Filter`로 떠넘긴다. **"WHERE만 보고 만든 인덱스"의 전형**이 여기다.
3. **접두사 중간에 빈칸**(조건 ① 위반) — `(genre, status, updated_at)`에 `WHERE genre = $1 ORDER BY updated_at`. 인덱스는 탔는데(`Index Scan` + `Index Cond`) 정렬은 남는다.
4. **범위/IN 뒤 정렬**(조건 ② 위반) — `WHERE genre = $1 AND updated_at >= $2 ORDER BY rating`, `WHERE genre IN (…) ORDER BY updated_at`. 다중 선택 필터 기능이 추가될 때 **조용히 재발**하는 패턴(3-2).
5. **방향·NULLS 불일치**(조건 ③ 위반) — `ORDER BY updated_at DESC, title ASC`를 방향 지정 인덱스 없이, 또는 `DESC NULLS LAST`를 기본 인덱스로.
6. **함수·표현식 정렬**(조건 ⑤ 위반) — `lower()`, 계산식, `random()`, `array_position()`, 형변환(표현식 인덱스가 없을 때).
7. **조인 inner 컬럼 / GROUP BY와 다른 컬럼 / DISTINCT·UNION 뒤 정렬**(조건 ⑥ 위반과 그 친척) — 중간 결과가 다 만들어져야 순서를 알 수 있으므로 `Sort`가 `Hash Join`·`HashAggregate`·`Append` **위에** 붙는다(2-4).

### 1-5. "등·범·정·커"에서 "정"의 자리 — WHERE만 보는 반쪽 습관

[복합 인덱스 컬럼 순서](08-composite-index-column-order.md) 2-1의 네 자리(**등**호 → **범**위 → **정**렬 → **커**버링) 중 **"정"**이 이 문서의 자리다. 습관적으로 WHERE 컬럼만 보고 인덱스를 걸면 "등"까지만 채우고 멈춘 것이다.

```sql
-- 화면: 장르 탭 → 연재 중 작품을 최신 업데이트순으로 20개 (홈 트래픽의 대부분이 이 쿼리)
SELECT id, title, thumbnail_url, updated_at
FROM webtoon
WHERE genre = 'ROMANCE' AND status = 'ACTIVE'
ORDER BY updated_at DESC
LIMIT 20;

-- before — WHERE만 보고 건 인덱스. "등"까지만 채웠다
CREATE INDEX idx_webtoon_genre_status ON webtoon (genre, status);
-- EXPLAIN (ANALYZE, BUFFERS)
--  Limit  (actual time=96.3..96.3 rows=20 loops=1)
--    ->  Sort  (actual time=96.3..96.3 rows=20 loops=1)
--          Sort Key: updated_at DESC
--          Sort Method: top-N heapsort  Memory: 27kB      ← LIMIT 덕에 메모리는 작다. 그러나
--          ->  Bitmap Heap Scan on webtoon (actual time=0.9..81.9 rows=80000 loops=1)
--                Recheck Cond: ((genre = 'ROMANCE') AND (status = 'ACTIVE'))
--                Buffers: shared hit=61234                 ← 8만 건을 힙에서 전부 읽은 흔적
--                ->  Bitmap Index Scan on idx_webtoon_genre_status (actual rows=80000 loops=1)
--   ※ Sort 노드가 있고, 그 아래 노드의 rows가 8만 — "정렬에 들어간 입력"이 8만 건이라는 뜻.
--      매칭이 많으니 플래너는 Bitmap Heap Scan을 골랐다(어차피 정렬하므로 순서를 잃어도 손해가 없다).

-- after — "정"의 자리를 채운다. 등호 두 개 뒤에 정렬 컬럼
DROP INDEX idx_webtoon_genre_status;                              -- 접두사가 같으니 교체(중복 방지)
CREATE INDEX idx_webtoon_genre_status_updated ON webtoon (genre, status, updated_at);
-- EXPLAIN (ANALYZE, BUFFERS)
--  Limit  (actual time=0.05..0.09 rows=20 loops=1)
--    ->  Index Scan Backward using idx_webtoon_genre_status_updated on webtoon
--          Index Cond: ((genre = 'ROMANCE') AND (status = 'ACTIVE'))
--          (actual time=0.04..0.08 rows=20 loops=1)
--          Buffers: shared hit=24                          ← 인덱스 몇 페이지 + 힙 20페이지
--   ※ Sort 노드 자체가 사라졌고 rows=20 — 20건 읽고 멈췄다. DESC는 Backward로 처리됐다
```

**"정"을 "등"보다 앞에 두면 어떻게 되나 (함정)** — 정렬만 급해서 `(genre, updated_at, status)`로 만들면 `genre` 구간이 `updated_at` 순이라 정렬은 인덱스가 해결한다. 하지만 `status`는 등호인데도 정렬 컬럼 뒤에 있어 **구간을 좁히는 액세스 조건에서 인덱스 내 검사로 강등**된다 — 리프를 최신순으로 걸으며 `ACTIVE`가 아닌 엔트리를 버리면서 20건을 채운다.

이 강등의 대가는 **데이터 분포에 따라 널뛴다.** ACTIVE가 60%면 평균 33건쯤(20 ÷ 0.6) 읽고 끝나 티가 안 나지만, 같은 인덱스로 `status = 'SUSPENDED'`(1%)를 조회하면 20건을 채우려고 **평균 2,000건을 걷는다**(20 ÷ 0.01). 60배 차이가 코드 한 줄 없이 필터 값 하나로 생긴다. 등호 → 정렬 순서를 지키면 어느 값이든 정확히 20건이다.

그리고 [08 문서 2-2](08-composite-index-column-order.md)의 경고 그대로 — 강등된 `status`도 계획에는 멀쩡히 `Index Cond`로 찍히므로 **계획 텍스트로는 구분이 안 되고 `Buffers`로 판별**한다. "등·범·정·커"의 **순서**가 중요한 이유가 정렬 축에서 이렇게 드러난다.

---

## 2. 동작 · 설계 · 판별 — Sort 노드는 왜 비싼가, 그리고 정렬 컬럼을 인덱스에 넣을 것인가

### 2-1. Sort 노드의 실체 — 계획에 끼어든 "별도 정렬 단계"

- **누가**: 플래너가 "인덱스 순서를 못 빌린다"고 판단하면 계획에 **`Sort` 노드**를 끼워 넣고, 실행기(executor)가 그 노드에서 정렬한다. 아래 노드(`Index Scan`, `Bitmap Heap Scan`, `Seq Scan`, 조인…)는 조건에 맞는 행을 한 건씩 올려 보낼 뿐이고, `Sort`가 그것을 **마지막 한 건까지 다 받은 뒤에야** 첫 행을 위로 내보낸다. `Limit`은 그 위에 따로 붙는 노드다 — 즉 "정렬이 끝나야 자른다"가 계획 모양에 그대로 보인다.
- **이름**: PostgreSQL에는 이름 함정이 없다 — `Sort` 노드가 **있느냐 없느냐**를 본다(MySQL은 메모리에서 끝나도 `Using filesort`라 찍힌다). 대신 **어디서 정렬했는지는 `EXPLAIN ANALYZE`의 `Sort Method`**가 알려준다. 세 값의 뜻과 선택 조건은 2-4에서 실제 출력 세 벌로 나란히 본다. 그래서 "Sort = 디스크 정렬"로 외우면 틀리고, "**인덱스 순서를 못 빌려서 별도 정렬 단계를 붙였다 — 디스크로 갔는지는 `Sort Method`를 본다**"로 외워야 맞다.
- **어디에**: 정렬 노드 **하나당** `work_mem`(기본 4MB)까지 메모리를 쓴다 — [JOIN 문서 §2-3](06-join-types-and-execution.md)의 용어 정리 그대로 **쿼리당이 아니라 노드당**이고, 해시와 달리 정렬에는 `hash_mem_multiplier` 배수가 붙지 않는다. 이 크기를 넘으면 데이터 디렉토리의 임시 파일(`base/pgsql_tmp`, 또는 `temp_tablespaces`)로 간다. `BUFFERS` 옵션을 켜면 그 노드에 `temp read=N written=N`이 찍힌다.
- **무엇을 정렬하나**: `Sort`는 정렬 키만이 아니라 **위 노드가 필요로 하는 컬럼을 튜플째** 정렬 입력에 싣는다. 그래서 `SELECT *`로 `summary` 같은 넓은 컬럼까지 끌어오는 목록 쿼리는 튜플이 넓어져 **같은 N에서도 `work_mem`을 더 빨리 넘긴다** — SELECT 컬럼을 줄이는 것이 정렬 최적화이기도 하다.
- **두 가지 변종** (가산점 포인트):
  - **bounded sort(= `top-N heapsort`)**: 위에 `LIMIT n`이 있으면 플래너가 그 n을 `Sort`에 "상한"으로 넘겨 크기 n짜리 힙만 유지한다. 메모리·스필은 거의 사라지지만 **입력 N을 전부 읽고 비교하는 비용은 그대로**다(4장 첫 꼬리질문).
  - **`Incremental Sort`(PG 13+)**: 입력이 정렬 키의 **접두사**로는 이미 정렬돼 있을 때(`Presorted Key: updated_at`), 접두사 값이 같은 묶음 안에서만 나머지 키로 정렬한다. 묶음 단위로 결과를 흘려보내므로 메모리가 작고 **`LIMIT`과 만나면 앞 묶음 몇 개만 처리하고 멈춘다.** 계획에는 `Full-sort Groups` / `Pre-sorted Groups` 통계가 함께 찍힌다.

> MySQL 대조: 같은 자리가 `filesort`다 — 스토리지 엔진(InnoDB) 위층인 SQL 서버 계층이 세션별 `sort_buffer_size` 안에서 정렬하고, 메모리에서 끝나도 `Using filesort`라고 찍혀 앞서 말한 이름 함정이 있다. 정렬 튜플 구성도 두 모드(`<정렬 키, rowid>`로 정렬 후 재조회 vs `<정렬 키, 필요 컬럼 전부>`)로 나뉘고, `LIMIT` 병용 시 우선순위 큐 최적화가 PostgreSQL의 `top-N heapsort`에 해당한다. `Incremental Sort`에 해당하는 노드는 MySQL에 없다.

### 2-2. 비용 사슬 — Sort 경로 6고리 vs 인덱스 경로 3고리

여기가 "성능 저하"·"메모리 부하"에서 멈추던 지점이다. 고리마다 이름을 붙이고, **각 고리가 어떤 자원을 쓰는지**를 열로 세워 두 경로를 나란히 놓는다.

```text
■ Sort 경로 — 비용 ∝ N (WHERE에 맞는 행 수)
 ① 접근  : WHERE로 걸러지는 N건을 전부 읽는다
           (Index Scan이면 N회 힙 페치 = 랜덤 I/O, Bitmap Heap Scan이면 TID 정렬 후 힙 순차 읽기,
            Seq Scan이면 테이블 전체)
 ② 적재  : 행마다 <정렬 키 + 위 노드가 쓸 컬럼>을 튜플로 만들어 work_mem에 쌓는다
 ③ 스필  : work_mem을 넘기면 지금까지의 것을 정렬해 임시 파일에 "런(run)"으로 쓴다
           (런 = 그 자체로는 정렬돼 있는 한 덩어리. 순차 쓰기지만 디스크)
 ④ 머지  : 런들을 다시 읽어 병합한다 — 디스크를 "쓰고 또 읽으니" I/O 2배
           (Sort Method: external merge  Disk: NkB)
 ⑤ 자르기: 정렬이 끝난 뒤에야 위의 Limit 노드가 20건을 받는다 — ①~④의 비용은 20과 무관
 ⑥ 대기  : Sort는 마지막 입력을 삼킬 때까지 첫 행을 못 내보낸다(blocking) —
           그동안 커넥션(=프로세스)·스냅샷·락을 쥐고 있다

■ 인덱스 경로 — 비용 ∝ LIMIT
 ① 점프  : (genre, status) 등호로 리프의 연속 구간 시작점(또는 끝점)을 찍는다
 ② 걷기  : 구간은 이미 updated_at 순 — 끝에서 앞으로(Index Scan Backward) 20 엔트리를 읽는다
           (SELECT 컬럼이 인덱스에 없으면 힙 페치 20회, Index Only Scan이면 0회)
 ③ 중단  : 20건을 채우면 즉시 끝. 나머지 79,980건은 만지지도 않는다
```

같은 것을 자원 열을 붙여 표로 보면 어디가 비싼지가 한눈에 잡힌다. 아래 숫자는 이 문서의 예제 규모 — 매칭 **N = 8만 건**, 정렬 튜플 폭 **200바이트**, `work_mem` **4MB**, `LIMIT 20` — 을 그대로 넣어 계산한 값이다.

| 고리 | 무슨 일 | CPU (비교 횟수) | 메모리 | 디스크 임시 파일 | 응답 지연에 주는 영향 |
|---|---|---|---|---|---|
| **Sort ① 접근** | N건을 힙에서 읽는다 | — | shared_buffers 오염 | — | 힙 페이지 약 6만 장 읽기(3-1에서 계산) |
| **Sort ② 적재** | 튜플로 만들어 쌓는다 | — | 8만 × 200B = **15.3MB** 필요 | — | — |
| **Sort ③ 스필** | 4MB씩 정렬해 런으로 쓴다 | 런 내부 정렬분 | 4MB로 고정 | **쓰기 15.3MB**, 런 4개 | 디스크 쓰기 대기 |
| **Sort ④ 머지** | 런 4개를 병합 | 전체 합계 **약 130만 회** | 4MB | **읽기 15.3MB** (누적 I/O 30.5MB) | 디스크 읽기 대기 |
| **Sort ⑤ 자르기** | Limit이 20건 취함 | — | — | — | 여기까지 와야 첫 행 |
| **Sort ⑥ 대기** | 첫 행까지의 시간 = 전체 정렬 시간 | — | — | — | **커넥션·스냅샷·락 점유가 이만큼 길어진다** |
| **인덱스 ① 점프** | 트리 하강 | 트리 높이만큼(**약 3~4회**) | 인덱스 페이지 3~4장 | — | 마이크로초 |
| **인덱스 ② 걷기** | 20 엔트리 + 힙 20회 | **0회** (이미 정렬돼 있다) | 힙 페이지 최대 20장 | — | 밀리초 미만 |
| **인덱스 ③ 중단** | 즉시 종료 | — | — | — | 첫 행이 바로 나간다 |

**`N log N`을 실제 N으로 계산해 본다.** 비교 정렬의 비교 횟수는 대략 `N × log₂N`이다.

```text
전체 정렬(quicksort, LIMIT 없음):
   log₂(80,000) = 16.29
   80,000 × 16.29 = 1,303,017 회 비교

LIMIT 20이 붙어 top-N heapsort로 바뀌면:
   ⑴ 모든 행이 "현재 20위 힙의 꼴찌"와 1회 비교      → 80,000 회
   ⑵ 그 비교를 통과해 힙을 갱신하는 경우만 힙 재정렬
      갱신 기대 횟수 = 20 × ln(80,000 / 20) = 20 × 8.29 = 166 회
      갱신 1회당 log₂(20) = 4.32 회 비교          → 166 × 4.32 = 717 회
   합계 ≈ 80,717 회

   → LIMIT이 비교 횟수를 130만 → 8만으로, 약 16배 줄인다.
     그런데 ⑴의 8만 회는 "8만 건을 전부 읽어야" 나오는 숫자다. 읽기는 안 줄었다.

인덱스 경로:
   비교 0회. 리프가 이미 그 순서다. 트리 하강에서 3~4회 비교할 뿐이다.
```

**임시 파일 쪽도 계산해 둔다.** 정렬 입력 8만 건 × 200바이트 = 15.3MB인데 `work_mem`은 4MB다. 그러니 `ceil(15.3 / 4) = 4`개의 런으로 나뉘어 디스크에 쓰이고, 병합하며 다시 읽는다 — **임시 파일 I/O 총량은 쓰기 15.3MB + 읽기 15.3MB = 30.5MB**다. `EXPLAIN (ANALYZE, BUFFERS)`에 `temp written=1953 read=1953`(8KB 블록 기준) 정도로 찍히는 값이 이것이다.

면접에서 말하는 문장으로 압축하면 — **"Sort 노드는 조건에 맞는 8만 건을 전부 읽어 work_mem에 넣고, 4MB를 넘으니 런 네 개로 임시 파일에 썼다 다시 읽어 병합한 다음에야 Limit이 20건을 자릅니다. 비교만 130만 번이고 임시 파일 I/O가 30MB인데, 비용이 LIMIT이 아니라 매칭 행 수에 비례하기 때문입니다. 인덱스 순서를 타면 비교 0번으로 구간 끝에서 20건 읽고 멈춥니다."**

### 2-3. "왜 문제인가" — 세 겹으로, 그리고 "언제는 문제가 아닌가"

**⑴ 비례 대상이 틀렸다.** 결과는 20건인데 일은 N건이다. 그래서 ⓐ 데이터가 10배 되면 **첫 페이지부터** 10배 느려진다(깊은 페이지가 아니라 1페이지가) ⓑ 개발 DB(N=50)에서는 절대 안 보이고 운영(N=8만)에서 터진다 ⓒ 같은 쿼리도 파라미터에 따라 N이 100배 다르다(로맨스 8만 vs 스릴러 800) — **p50은 멀쩡한데 p99가 널뛰는** 목록 API의 흔한 정체.

**⑵ 자원이 공유 자원이다.** `work_mem`은 **백엔드마다, 정렬 노드마다** 잡는다 — 동시 요청 200개가 같은 쿼리를 치면 200 × (계획 안의 Sort 노드 수) 몫이다. 그래서 `work_mem`을 전역으로 키우는 것이 위험하다(4장 네 번째 꼬리질문).

그리고 스필된 임시 파일은 **데이터 디렉토리(또는 `temp_tablespaces`)를 모든 백엔드가 공유**하므로 한 쿼리의 정렬이 옆 쿼리의 해시 조인 스필·다른 정렬과 I/O를 다투고, 극단에서는 디스크가 차서 무관한 쿼리까지 실패한다(`temp_file_limit`으로 세션당 상한을 둘 수 있다). CPU도 앞에서 센 130만 번의 비교만큼 쓴다. "이 쿼리가 느리다"에서 끝나지 않고 **옆 쿼리를 느리게 만드는** 이유다.

**⑶ 응답이 "다 읽은 뒤"에 시작된다.** 인덱스 경로는 첫 행을 바로 흘려보낼 수 있지만, `Sort`는 마지막 행까지 읽고 정렬을 마쳐야 첫 행이 나간다. 첫 행까지의 시간 = 전체 정렬 시간이고, 그동안 **커넥션 — PostgreSQL에서는 OS 프로세스 하나 — 을 물고 있다** → 목록 API 하나가 커넥션 풀을 잠식하는 사슬([커넥션 수와 처리량](15-connection-count-vs-throughput.md))로 이어진다. 그 트랜잭션의 스냅샷도 그만큼 오래 살아 VACUUM이 치울 수 있는 죽은 튜플의 경계를 뒤로 민다. `SELECT … FOR UPDATE`에 붙은 정렬이라면 N건의 행 락을 정렬이 끝날 때까지 쥐고 있는 셈이다([FOR UPDATE의 락 범위](19-select-for-update-lock-scope.md)).

**언제는 문제가 아닌가** — 위 세 겹은 전부 **N이 클 때** 성립한다. N이 수백 건이고 `quicksort Memory: 50kB`로 끝나며 호출 빈도가 낮으면 `Sort`는 밀리초 아래다. 즉 **문제는 `Sort`라는 노드 이름이 아니라 "정렬 입력 N의 크기 × 빈도"**이고, 이 판단이 2-5·2-6의 트레이드오프로 이어진다. 계획에 `Sort`가 보이자마자 인덱스를 추가하는 것도 반쪽 습관이다.

### 2-4. EXPLAIN에서 읽기 — 계획 모양 다섯 가지와 `Sort Method` 세 값

MySQL이 `Extra` 컬럼의 문구 조합으로 알려주던 것을 PostgreSQL은 **트리의 모양**과 **`Sort` 노드에 붙는 두 줄**(`Sort Key`, `Sort Method`)로 알려준다. 먼저 모양.

| 계획 모양 | 뜻 | 위험도·처방 방향 |
|---|---|---|
| `Sort`가 스캔 노드 **바로 위** | 별도 정렬 단계가 붙었다. 읽은 행을 work_mem으로 | N에 비례. 인덱스에 "정" 자리 채우기, 또는 N이 작으면 허용 |
| `Sort`가 **`Hash Join` / `HashAggregate` / `Append`(UNION) 위** | 조인·집계·합집합이 **다 끝나야** 정렬을 시작할 수 있다 — inner 컬럼 정렬, GROUP BY와 다른 ORDER BY, DISTINCT | **두 단계 비용.** 아래 노드도 `Batches > 1`로 스필할 수 있어 스필이 두 군데. 쿼리 구조를 바꿔야 한다 |
| `Sort` 아래가 **`Index Only Scan`** | 커버링이라 **힙 접근은 0**(`Heap Fetches: 0`이면)인데 인덱스 순서가 정렬과 안 맞아 **정렬은 남았다** | 읽기 최적·정렬 미해결. 대개 "접두사 빈칸"이나 "컬럼 순서" 문제 — 순서를 바꾸면 둘 다 해결되는 신호 |
| **`Incremental Sort`** (`Presorted Key: …`) | 접두사까지는 인덱스 순서를 빌렸고 나머지 키만 묶음 안에서 정렬 | 대체로 **양호.** tie-breaker 컬럼이 인덱스에 없을 때의 정상 모양. `LIMIT`이 있으면 조기 종료 |
| **`Index Scan Backward`**, 그리고 `Sort` 없음 | 인덱스를 뒤에서 앞으로 읽어 DESC를 처리했다 | **좋은 신호.** 정렬을 인덱스가 해결했다는 뜻 |

#### `Sort Method` 세 값 — 언제 어느 것이 선택되는가

`Sort Method`는 `EXPLAIN ANALYZE`(실제로 실행하는 모드)에서만 나온다. 값이 세 개뿐이고, **어느 것이 나오는지는 실행기가 두 가지 질문에 어떻게 답하느냐로 결정된다** — "위에 `LIMIT`이 있는가"와 "정렬 입력이 `work_mem`에 들어가는가".

```text
                        위에 LIMIT n 이 있는가?
                          ┌─────────┴─────────┐
                        예                    아니오
                          │                     │
              크기 n짜리 힙만 유지        입력 전체를 메모리에 적재
                          │                     │
                 top-N heapsort        work_mem 안에 들어가는가?
                 Memory: NkB            ┌───────┴────────┐
                                       예               아니오
                                        │                 │
                                    quicksort      런으로 쪼개 디스크에
                                    Memory: NkB    쓰고 다시 읽어 병합
                                                          │
                                                   external merge
                                                   Disk: NkB
```

| `Sort Method` | 언제 선택되나 | 어디를 쓰나 | 무엇을 걱정하나 |
|---|---|---|---|
| `quicksort  Memory: NkB` | `LIMIT` 없이, 정렬 입력 전체가 `work_mem`에 들어갈 때 | 메모리만 | **`Memory: NkB`가 `work_mem`에 가까우면 위험 신호** — 데이터가 조금만 늘면 `external merge`로 떨어진다 |
| `top-N heapsort  Memory: NkB` | 위에 `LIMIT n`이 있고 플래너가 그 n을 `Sort`에 상한으로 넘겼을 때 | 힙 n개분 메모리 — `LIMIT 20`이면 수십 kB 고정 | 메모리는 안심. **그러나 아래 노드 `rows`가 정렬 입력이고, 그만큼 읽었다** |
| `external merge  Disk: NkB` | `LIMIT`이 없고(또는 n이 커서) 입력이 `work_mem`을 넘겼을 때 | 메모리 `work_mem` + **디스크 임시 파일** | `Disk: NkB`가 곧 런의 총 크기. **정상 상태의 목록 API에 있어선 안 되는 값** |

같은 테이블·같은 정렬 키로 세 값을 각각 만들어 실제 출력을 나란히 놓는다. 어디를 보고 구분하는지가 눈에 익어야 한다.

```sql
-- [1] quicksort — LIMIT 없이, 입력이 work_mem 안에 들어간 경우
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, updated_at FROM webtoon WHERE genre = 'THRILLER' AND status = 'ACTIVE'
ORDER BY rating_avg DESC;
--  Sort  (actual time=1.842..1.901 rows=800 loops=1)
--        Sort Key: rating_avg DESC
--        Sort Method: quicksort  Memory: 63kB          ← 메모리에서 끝. 63kB는 work_mem 4MB의 1.5%
--        Buffers: shared hit=214                       ← temp 줄이 아예 없다 = 디스크를 안 썼다
--        ->  Bitmap Heap Scan on webtoon (actual rows=800 loops=1)
--   판별: Memory 표기 + temp 줄 없음. 정렬 입력이 800건이라 문제 자체가 없다.


-- [2] top-N heapsort — 같은 정렬에 LIMIT 20을 붙였을 뿐인데 방식이 바뀐다
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, updated_at FROM webtoon WHERE genre = 'ROMANCE' AND status = 'ACTIVE'
ORDER BY rating_avg DESC LIMIT 20;
--  Limit  (actual time=96.284..96.291 rows=20 loops=1)
--    ->  Sort  (actual time=96.283..96.288 rows=20 loops=1)
--          Sort Key: rating_avg DESC
--          Sort Method: top-N heapsort  Memory: 27kB   ← LIMIT 20이 Sort에 상한으로 전달됐다
--          Buffers: shared hit=61234                   ← 그런데 힙은 6만 장을 읽었다
--          ->  Bitmap Heap Scan on webtoon (actual rows=80000 loops=1)   ← 정렬 입력 8만 건
--   판별: Sort 노드의 rows=20 인데 아래 노드 rows=80000. 이 두 숫자의 차이가 낭비의 전부다.
--         Memory가 27kB로 작다고 안심하면 안 되는 이유가 여기 있다.


-- [3] external merge — LIMIT을 떼고 같은 8만 건을 전부 정렬한다 (CSV 내보내기 같은 경로)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, thumbnail_url, updated_at FROM webtoon
WHERE genre = 'ROMANCE' AND status = 'ACTIVE' ORDER BY rating_avg DESC;
--  Sort  (actual time=412.7..455.3 rows=80000 loops=1)
--        Sort Key: rating_avg DESC
--        Sort Method: external merge  Disk: 15296kB    ← 15.3MB. 2-2에서 계산한 그 값이다
--        Buffers: shared hit=61234, temp read=1953 written=1953   ← 8KB × 1953 = 15.3MB, 쓰고 또 읽었다
--        ->  Bitmap Heap Scan on webtoon (actual rows=80000 loops=1)
--   판별: Disk 표기 + temp read/written 이 0이 아니다. 같은 순간 서버 로그에도
--         log_temp_files = 0 이면 "temporary file: ... size 15663104" 한 줄이 찍힌다.
```

**세 출력의 판별 포인트를 한 줄씩으로 정리하면** — `Memory`인가 `Disk`인가로 메모리/디스크가 갈리고, `top-N`이라는 접두어가 붙었는가로 LIMIT 최적화 여부가 갈리며, **어느 경우든 진짜 비용은 `Sort` 바로 아래 노드의 `actual rows`**다. 이 세 번째가 가장 자주 놓친다.

특히 [2]는 **"`LIMIT 20`인데 왜 8만 건을 다 정렬하나요"**라는 꼬리질문의 답이 그대로 담긴 출력이다(4장 첫 질문). PostgreSQL은 실제로 8만 건을 "정렬"하지는 않는다 — 크기 20짜리 힙만 유지하니 비교는 130만이 아니라 8만 회다. 그러나 **그 20위를 확정하려면 8만 건을 전부 읽어 봐야 하고**(21번째 행이 1위일 수도 있으니), 그 읽기가 `Buffers: shared hit=61234`다. **`top-N heapsort`는 정렬 비용을 깎지 읽기 비용은 못 깎는다** — 이것이 이 값의 정확한 의미다.

`Index Only Scan` 위의 `Sort` 예도 하나 고정한다. PostgreSQL에서는 `id`가 인덱스에 자동으로 들어오지 않으므로 `INCLUDE`로 실어야 커버링이 된다.

```sql
-- 인덱스 (status, genre, updated_at) INCLUDE (id). 쿼리는 genre 없이:
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, updated_at FROM webtoon
WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20;
--  Limit
--    ->  Sort  (actual rows=20 loops=1)
--          Sort Key: updated_at DESC
--          Sort Method: top-N heapsort  Memory: 26kB
--          ->  Index Only Scan using idx_webtoon_status_genre_updated on webtoon
--                Index Cond: (status = 'ACTIVE')
--                Heap Fetches: 0                        (actual rows=450000 loops=1)
--                Buffers: shared hit=2113
--   읽기: 필요한 컬럼(status, updated_at, id)이 전부 인덱스에 있고 visibility map이 신선해 힙엔 안 갔다 → 싸다
--   정렬: status 구간 안은 genre별로 따로 updated_at 순이라 전체 순서가 아니다(조건 ① 위반) → 모아서 정렬
--   해석: "ACTIVE 전체(45만)를 인덱스 리프에서 순차로 읽어(싸다) 전부 힙에 넣고 비교한다(비싸다)"
--   처방: 이 쿼리가 뜨겁다면 (status, updated_at) 인덱스, 아니면 허용 — N을 보고 정한다
```

`EXPLAIN (ANALYZE, BUFFERS)`에서는 **`Sort` 노드의 존재**, **그 바로 아래 노드의 `actual rows`**(= 정렬 입력 N), **`Sort Method`** 세 가지만 보면 된다. `EXPLAIN (FORMAT JSON)`에서는 `"Node Type": "Sort"`(또는 `"Incremental Sort"`) 노드의 유무로 떨어지므로 테스트 단정에 쓰기 좋다(3-3).

**(가산점 포인트)** 운영에서 "이 정렬이 메모리에서 끝났는지, 몇 번 디스크에 갔는지"를 쿼리 단위로 남기는 창은 둘이다. ① **`auto_explain`**을 `log_analyze = on`, `log_buffers = on`으로 켜면 느린 쿼리의 실제 계획에 `Sort Method`와 `temp read/written`이 그대로 로그에 남는다. ② **`log_temp_files = 0`**으로 두면 임시 파일이 생길 때마다 "파일 크기 + 그 쿼리문"이 한 줄씩 찍힌다 — 스필한 정렬(과 해시)을 빠짐없이 잡는 가장 싼 감시다. 집계는 `pg_stat_statements`의 `temp_blks_written`, 전역은 `pg_stat_database.temp_files / temp_bytes`(3-4).

### 2-5. 대가부터 — 정렬 컬럼 하나가 인덱스에 들어가면

여기서부터는 "그래서 인덱스를 걸 것인가"의 판단이다. 얻는 것만 보면 언제나 걸어야 하므로, 내주는 것부터 센다.

| 얻는 것 | 내주는 것 |
|---|---|
| 정렬 단계 제거, 비용이 N → LIMIT | **인덱스 폭↑** → 페이지당 엔트리↓ → shared_buffers 적재율↓ |
| 첫 행 즉시 반환, 커넥션(프로세스) 점유↓ | **쓰기 증폭** — 정렬 컬럼 값이 바뀌는 UPDATE는 **HOT에서 탈락**한다: 새 튜플 버전 + 그 인덱스만이 아니라 **테이블의 모든 인덱스**에 새 엔트리, 옛 엔트리는 VACUUM 전까지 인덱스 bloat |
| 커서 페이지네이션의 전제 확보 | 정렬 축마다 인덱스면 **인덱스 수↑** → DML당 갱신 트리 수↑, 플래너 후보 혼선↑ |

두 번째 줄이 핵심인데, 용어를 풀지 않으면 무게가 전달되지 않는다. **HOT(Heap-Only Tuple)**부터 정의한다.

PostgreSQL의 UPDATE는 행을 제자리에서 고치지 않는다. **옛 튜플은 그대로 두고 새 튜플 버전을 삽입**한 뒤, 옛 것에 "이 XID 이후로는 무효"라는 표시를 남긴다(MVCC — [MVCC 문서](11-mvcc-postgresql.md)). 그러면 원칙적으로 **모든 인덱스**가 새 튜플의 위치를 가리키도록 새 엔트리를 꽂아야 한다. 인덱스가 5개면 UPDATE 한 번에 트리 5개를 건드린다.

여기에 PostgreSQL이 둔 예외가 HOT이다. **바뀐 컬럼이 어떤 인덱스에도 들어 있지 않고, 새 튜플이 같은 힙 페이지 안에 들어갈 자리가 있으면** — 인덱스를 하나도 안 건드리고 페이지 안에서 옛 튜플 → 새 튜플로 이어지는 사슬만 만든다. 인덱스는 여전히 옛 튜플을 가리키고, 읽을 때 사슬을 따라간다. "Heap-Only", 즉 **힙에서만 끝나는 업데이트**라는 이름이 여기서 나온다.

그래서 결론이 이렇게 된다 — **정렬 컬럼을 인덱스에 넣는 순간, 그 컬럼을 바꾸는 모든 UPDATE가 HOT 조건("어떤 인덱스에도 없다")을 잃고 탈락한다.** 그리고 탈락하면 그 인덱스 하나가 아니라 **그 테이블의 인덱스 전부**에 새 엔트리를 꽂는다. 인덱스 하나를 추가한 대가가 인덱스 하나분이 아닌 것이다.

웹툰 도메인에서 후보 컬럼들의 **변동성**(그 컬럼 값이 얼마나 자주 바뀌는가)을 나란히 놓으면 판단이 저절로 갈린다.

- `created_at` — **불변.** 인덱스에 넣어도 삽입 때 한 번 꽂히고 끝. HOT과 무관하다. 쓰기 대가가 사실상 0이다.
- `updated_at` — 회차가 올라올 때마다(작품당 주 1~2회). 그때마다 HOT 탈락 → 인덱스 전부 갱신이지만 빈도가 낮아 감당 가능.
- `rating_avg` — 평점이 들어올 때마다 소수점이 바뀐다. 인기작이면 분 단위 — 분 단위로 HOT 탈락.
- `view_count` — **조회할 때마다.** 이 컬럼은 인덱스가 없어도 이미 [초고빈도 카운터 갱신](23-high-frequency-counter-hot-row.md)의 문제(행 락 직렬화, 죽은 튜플 폭증, VACUUM 추격 실패)를 안고 있는데, 여기에 인덱스를 걸면 **모든 페이지뷰가 모든 인덱스 갱신**이 된다 — 최악의 조합이다.

감시 지표까지 붙여 둔다. `pg_stat_user_tables`의 `n_tup_upd`(전체 UPDATE 수) 대비 `n_tup_hot_upd`(그중 HOT으로 끝난 수)의 비율을 보면 된다. **이 비율이 높을수록 건강하고, 인덱스에 변동 컬럼을 넣는 순간 곤두박질친다.**

### 2-6. 정렬 기준이 5개인 화면 — "축마다 인덱스"가 답이 아닌 이유

장르 탭에 정렬 옵션이 **최신순 / 신작순 / 인기순 / 별점순 / 제목순** 다섯 개다. 이 화면이 이 문서의 시니어 변별 지점이다 — "ORDER BY가 인덱스를 타야 한다"를 배운 직후 가장 자연스러운 답이 **"그럼 `(genre, status, X)`를 다섯 개 만들자"**이고, 그것이 오답이기 때문이다.

왜 오답인지를 세 단계로 세운다.

#### ⑴ 인덱스 5개의 쓰기 비용 — 곱셈으로 온다

2-5의 결론을 그대로 적용한다. 인덱스가 5개면 **HOT에서 탈락한 UPDATE 한 번이 트리 5개를 건드린다.** 그런데 인덱스를 5개 만든다는 것은 그 안에 `rating_avg`와 `view_count` 같은 **변동 컬럼을 넣는다는 뜻**이고, 그러면 그 컬럼을 바꾸는 모든 UPDATE가 HOT에서 탈락한다. 두 효과가 곱해진다.

```text
인덱스 5개 중 view_count 인덱스가 있을 때, 페이지뷰 1회에 무슨 일이 일어나나

  UPDATE webtoon SET view_count = view_count + 1 WHERE id = 42
    ↓
  view_count 가 idx_w_gs_views 에 들어 있다 → HOT 조건 탈락
    ↓
  새 튜플 버전 삽입 + 인덱스 5개 전부에 새 엔트리 5개
    ↓
  옛 엔트리 5개는 VACUUM 전까지 남는다 (인덱스 bloat)
    ↓
  페이지 여유가 마르면 새 튜플이 다른 페이지로 → 페이지 분열, 죽은 튜플 누적
    ↓
  autovacuum 이 이 속도를 못 따라가면 인덱스가 부풀고 읽기까지 느려진다

  ※ 페이지뷰가 초당 1,000회면 초당 인덱스 엔트리 5,000개가 새로 꽂힌다.
    "정렬 옵션 하나"의 대가가 이것이다.
```

#### ⑵ 실제로 쓰이는 정렬은 상위 1~2개다 — 사용 분포를 먼저 본다

여기가 순서상 두 번째로 오는 게 중요하다. 비용을 알고 나면 **"그 비용을 지불할 만큼 쓰이는가"**를 묻게 되기 때문이다.

정렬 옵션이 다섯이라고 트래픽이 5분의 1씩 나뉘지 않는다. **기본값으로 지정된 정렬이 압도적**이고(대부분의 사용자는 정렬을 바꾸지 않는다), 나머지는 꼬리에 붙는다. 이 분포는 추측이 아니라 **로그로 확인할 수 있는 사실**이다 — API 접근 로그의 `sort` 파라미터 분포, 또는 `pg_stat_statements`에서 정렬 키별로 갈라진 쿼리의 `calls`를 세면 된다.

웹툰 목록의 실제 분포는 대개 이렇게 나온다.

| 정렬 | 컬럼 | 요청 비중(측정값 예) | 변동성 | N (장르×ACTIVE) |
|---|---|---|---|---|
| 최신순 | `updated_at` | 70% | 낮음(회차 업로드 시) | 8만 |
| 인기순 | `view_count` | 15% | **매 조회** | 8만 |
| 신작순 | `created_at` | 5% | 없음(불변) | 8만 |
| 별점순 | `rating_avg` | 5% | 중간(평점 입력 시) | 8만 |
| 제목순 | `title` | 5% | 없음 | 8만 |

**요청 비중 70%짜리 하나와 5%짜리 셋을 같은 무게로 다루는 것이 오답의 정체다.** 판단 공식은 셋을 곱한 값이다 — **N(WHERE 후 매칭 행 수) × 요청 비중 × 정렬 컬럼의 변동성.** 앞의 둘은 "인덱스를 걸어서 얻는 이득", 마지막 하나는 "인덱스를 걸어서 내는 비용"이다.

#### ⑶ 나머지는 Sort를 허용하되, 결과 집합을 작게 만드는 쪽으로 간다

"인덱스를 안 건다"가 곧 "방치한다"는 아니다. 2-3에서 못 박은 대로 **문제는 `Sort`라는 노드가 아니라 정렬 입력 N**이므로, 인덱스로 정렬을 없앨 수 없다면 **N을 줄이는 쪽**으로 간다. 방법은 둘이다.

- **필터 인덱스로 N을 줄인다.** `(genre, status)` 인덱스는 정렬은 못 해줘도 **정렬 입력을 전체 120만에서 8만으로 줄여 준다.** 여기에 필터 축이 하나 더 붙는 화면(예: "완결작만")이라면 그 컬럼까지 넣어 N을 더 깎는다. 정렬을 포기한 축에서 비용을 지배하는 것은 N이므로, 정렬 인덱스보다 **필터 인덱스가 먼저**다.
- **정렬 대상 자체를 작게 만든다.** 변동성이 큰 축(`view_count`)은 라이브 컬럼을 정렬하는 대신 **배치가 주기적으로 채우는 랭킹 스냅숏 테이블**에서 읽는다. 스냅숏은 이미 순위가 매겨져 있으므로 정렬이 아예 없고, 읽기 전용이라 인덱스가 움직이지 않는다.

세 단계를 표로 닫는다.

| 정렬 축 | 결정 | 얻는 것 | 내주는 것 |
|---|---|---|---|
| **최신순** `updated_at` (70%) | **인덱스** `(genre, status, updated_at)` | 트래픽 70%에서 정렬 0, 비용 N→20 | 인덱스 1개분 폭·공간, 회차 업로드 때 HOT 탈락 1회(작품당 주 1~2회 — 무시 가능) |
| **인기순** `view_count` (15%) | **사전 집계** — 10분마다 갱신되는 랭킹 스냅숏 | 정렬 0, 라이브 컬럼에 인덱스 없음 → 페이지뷰가 HOT을 유지 | **10분 지연**(기획과 합의할 요구사항 변경), 스냅숏 테이블·배치 운영 비용 |
| **신작순** `created_at` (5%) | **인덱스** (조건부) | 정렬 0. 불변 컬럼이라 **쓰기 대가가 사실상 0** | 인덱스 1개분 폭·공간뿐. N이 크면 걸 값어치가 있다 |
| **별점순** `rating_avg` (5%) | **Sort 허용** (집계를 일 배치로 돌린다면 인덱스도 가능) | 쓰기 대가 0. 라이브 평점 갱신이 HOT을 유지 | N이 자라면 p99가 되돌아온다 → 3-3의 테스트가 N 상한을 감시 |
| **제목순** `title` (5%) | **Sort 허용** | 쓰기 대가 0 | 문자열 비교는 collation 규칙을 타서 CPU가 더 든다 — 다만 빈도가 낮아 총량이 작다 |

**읽는 법** — ⑴ **기본 정렬은 무조건 인덱스**(요청 비중이 압도적이라 N × 빈도가 가장 크다) ⑵ **변동성 큰 컬럼은 라이브 값에 인덱스를 걸지 않고** 사전 집계 산출물에 건다 ⑶ **저빈도 + N 감당 가능 + 불변 컬럼은 Sort를 허용하고 그 사실을 목록에 적는다** — "허용"은 방치가 아니라 **선언**이다(3-3의 테스트가 그 목록을 읽는다) ⑷ 이 표는 한 번 정하고 끝이 아니라 `pg_stat_statements`·p99로 **재검토**한다(3-4).

```sql
-- before — 정렬 옵션 수만큼 인덱스. view_count 인덱스가 페이지뷰마다 모든 인덱스를 움직인다
CREATE INDEX idx_w_gs_updated ON webtoon (genre, status, updated_at);
CREATE INDEX idx_w_gs_created ON webtoon (genre, status, created_at);
CREATE INDEX idx_w_gs_views   ON webtoon (genre, status, view_count);   -- 매 조회 = HOT 탈락 = 인덱스 5개 갱신
CREATE INDEX idx_w_gs_rating  ON webtoon (genre, status, rating_avg);
CREATE INDEX idx_w_gs_title   ON webtoon (genre, status, title);

-- after — 기본 정렬 + 불변 컬럼만 인덱스, 라이브 카운터는 스냅숏 테이블로, 나머지는 허용
CREATE INDEX idx_w_gs_updated ON webtoon (genre, status, updated_at);
CREATE INDEX idx_w_gs_created ON webtoon (genre, status, created_at);
-- 인기순: 배치가 10분마다 채우는 랭킹 스냅숏 (읽기 전용이라 인덱스가 움직이지 않는다)
CREATE TABLE webtoon_rank_snapshot (
    genre       varchar(20) NOT NULL,
    rank_no     int         NOT NULL,
    webtoon_id  bigint      NOT NULL,
    PRIMARY KEY (genre, rank_no) INCLUDE (webtoon_id)
    -- WHERE genre = $1 ORDER BY rank_no LIMIT 20 → PK 인덱스 순서 그대로,
    -- INCLUDE 덕에 Index Only Scan (PG는 PK도 그냥 B-tree라 힙 방문을 없애려면 명시해야 한다)
);
-- 별점순·제목순: Sort 허용. N(장르×ACTIVE)이 수만 이하이고 요청 비중 합 10% 미만 — 3-3 목록에 등록
```

> 스냅숏 갱신의 PostgreSQL 각주: 10분마다 `TRUNCATE` + `INSERT … SELECT`를 한 트랜잭션으로 하면 읽는 쪽은 커밋 전까지 옛 스냅숏을 본다(`TRUNCATE`도 트랜잭션 안에 들어간다). 같은 일을 **materialized view + `REFRESH MATERIALIZED VIEW CONCURRENTLY`**(유니크 인덱스 필요)로 해도 된다 — PostgreSQL 고유 도구라 언급하면 가산점이다.

**(가산점 포인트)** 정렬 축이 다섯 개를 넘고 필터 조합까지 자유로운 화면(관리자 그리드, 통합 검색)이라면 RDB 인덱스로 덮으려는 시도 자체를 멈추고 검색 엔진에 위임한다 — [깊은 페이지네이션 §2-4](13-deep-pagination-offset-vs-cursor.md)와 같은 결론이다. "정렬 축 수 × 필터 조합 수"만큼 인덱스를 만들 수는 없다.

---

## 3. 실무 사례 · 안전망 — 첫 페이지가 느리다, 조용한 회귀, 그리고 결정을 코드에 박기

### 3-1. 증상 → EXPLAIN → 사슬 → 처방

홈 진입 트래픽이 몰리는 저녁 시간대에 `GET /webtoons?genre=ROMANCE` p99가 튄다. 깊은 페이지가 아니다 — **1페이지**다. `log_min_duration_statement = 500ms`에 같은 쿼리가 반복해서 걸리고, `auto_explain`(`log_analyze`, `log_buffers`)이 남긴 계획은 이렇다.

```text
 Limit  (actual time=412.7..412.7 rows=20 loops=1)
   ->  Sort  (actual time=412.7..412.7 rows=20 loops=1)
         Sort Key: updated_at DESC
         Sort Method: top-N heapsort  Memory: 28kB       ← 스필은 없다. 정렬 메모리는 문제가 아니다
         ->  Bitmap Heap Scan on webtoon (actual time=6.1..388.2 rows=80213 loops=1)
               Recheck Cond: ((genre = 'ROMANCE') AND (status = 'ACTIVE'))
               Buffers: shared hit=31877 read=29402      ← 힙 페이지 6만 장, 절반은 디스크에서
               ->  Bitmap Index Scan on idx_webtoon_genre_status (actual rows=80213 loops=1)
```

**"8만 행을 읽는데 왜 페이지가 6만 장인가"를 계산으로 확인해 둔다.** 이 숫자가 이해되지 않으면 사슬의 ①이 왜 비싼지가 와닿지 않는다.

```text
전제: webtoon 총 120만 행, SELECT * 라 행이 넓다(title·thumbnail_url·summary 포함, 약 600B)

  페이지당 행 수 = (8192 - 24) ÷ (600 + 4)  ≈  13 행        (24B 페이지 헤더, 4B 라인 포인터)
  테이블 페이지 수 = 1,200,000 ÷ 13         ≈  92,000 장  (약 720MB)
  매칭 비율 = 80,213 ÷ 1,200,000            ≈  6.7 %

  → 페이지 하나에 들어 있는 매칭 행의 기대값 = 13 × 0.067 ≈ 0.87 건
  → 매칭 행이 하나라도 있는 페이지의 비율 = 1 - (1 - 0.067)^13 = 1 - 0.41 = 59 %
  → 읽어야 하는 힙 페이지 = 92,000 × 0.59 ≈ 54,000 장 (+ 인덱스 페이지) ≈ 계획의 61,279

핵심: 매칭 행 8만 건이 "한 군데 뭉쳐" 있는 게 아니라 테이블 전체에 한 페이지당 한 건꼴로
      흩어져 있다. 그래서 8만 건을 모으려면 사실상 테이블의 60%를 읽어야 한다.
      LIMIT 20 이 붙어 있어도 이 읽기는 피할 수 없다 — 20위를 확정하려면 다 봐야 하니까.
```

사슬로 번역하면 — `(genre, status)` 인덱스로 로맨스·연재중 8만 건의 TID를 모아 → 힙 페이지 6만 장을 읽어 8만 행을 만들고(`SELECT *`라 넓은 행을 통째로) → 8만 건을 `Sort`에 흘려 넣어 크기 20짜리 힙과 비교 → 그제야 `LIMIT 20`. `LIMIT` 덕에 스필은 없지만 **비용의 전부가 "버릴 79,993건을 읽는 데"** 쓰였고, 저녁에 동시 요청이 겹치자 이 6만 장이 shared_buffers를 밀어내 `read`가 늘면서 p99가 뛰었다 — [08 문서 2-2](08-composite-index-column-order.md)의 사슬 중 캐시 오염이 그대로다.

참고로 이 쿼리는 로맨스에서만 느리다 — 스릴러(N=800)는 같은 계획으로도 밀리초라 로그에 안 잡힌다. **"같은 쿼리, 다른 파라미터"가 p50과 p99를 갈라 놓는 전형**이다. (같은 쿼리를 `LIMIT` 없이 CSV 내보내기에도 썼다면 거기서는 2-4의 [3]번 출력처럼 `Sort Method: external merge Disk`와 `log_temp_files` 한 줄이 함께 찍혔을 것이다.)

처방 가설: `(genre, status, updated_at)`으로 교체하면 `Sort` 노드가 사라지고 정렬 입력 8만 → 읽는 행 20. 검증: 스테이징 `EXPLAIN (ANALYZE, BUFFERS)` 412ms → 0.1ms, `Buffers: shared hit=24`, `pg_stat_statements`의 호출당 `shared_blks_hit + read` 6만 → 24. 대가: 인덱스 폭에 `updated_at`만큼 추가, 회차 업로드 때마다 HOT 탈락 1회(작품당 주 1~2회라 무시 가능), 기존 `(genre, status)`는 접두사가 같으니 삭제해 인덱스 수 유지. 운영 적용은 `CREATE INDEX CONCURRENTLY` → 확인 → `DROP INDEX CONCURRENTLY` 순서로([온라인 DDL](14-online-ddl-zero-downtime-schema-change.md)). 고정: 3-3 ~ 3-5의 세 가지.

### 3-2. 회귀 — "장르 여러 개 선택" 기능이 `IN`을 가져왔다

한 달 뒤 기획이 "장르 다중 선택"을 넣었다. 리포지토리의 `genre = $1`이 `genre IN ($1, $2)`로 바뀌었고, 리뷰는 통과했다 — 인덱스는 그대로니까.

```sql
-- 배포 후 쿼리
SELECT id, title, thumbnail_url, updated_at
FROM webtoon
WHERE genre IN ('ROMANCE', 'DRAMA') AND status = 'ACTIVE'
ORDER BY updated_at DESC
LIMIT 20;
-- EXPLAIN (ANALYZE, BUFFERS)
--  Limit
--    ->  Sort                                                  ← 돌아왔다
--          Sort Key: updated_at DESC
--          Sort Method: top-N heapsort  Memory: 28kB
--          ->  Bitmap Heap Scan on webtoon (actual rows=130000 loops=1)
--                Recheck Cond: ((genre = ANY ('{ROMANCE,DRAMA}'::text[])) AND (status = 'ACTIVE'))
--                ->  Bitmap Index Scan on idx_webtoon_genre_status_updated
```

#### `col IN (a, b, c)`가 계획에서 어떤 모양이 되는가

`IN`이 왜 정렬을 깨뜨리는지는 1-3 ②에서 리프 목록으로 봤다. 여기서는 그것이 **실행 계획 차원에서 어떤 모양이 되는지**를 그려 둔다. 이 그림이 있어야 처방이 왜 그 모양인지가 이해된다.

```text
WHERE genre IN ('ROMANCE','DRAMA') AND status = 'ACTIVE' ORDER BY updated_at DESC

⑴ 인덱스 (genre, status, updated_at) 에서 값마다 구간이 따로 있다
   (선두 컬럼 genre 가 다르면 리프에서 완전히 떨어진 자리다)

   ┌ DRAMA·ACTIVE 구간 ─────────────┐        ┌ ROMANCE·ACTIVE 구간 ──────────────┐
   │ 04-02 ... 08-27 08-28 08-29    │  ...   │ 05-01 ... 08-29 08-30 08-31       │
   └────────────────────────────────┘        └───────────────────────────────────┘
      5만 건, 이 안은 updated_at 순              8만 건, 이 안은 updated_at 순

⑵ PostgreSQL은 각 값마다 별도의 탐색(primitive scan)을 돌려 결과를 합친다
   계획에는 `genre = ANY ('{ROMANCE,DRAMA}'::text[])` 한 줄로만 보이지만,
   내부적으로는 "DRAMA 구간 찾기" + "ROMANCE 구간 찾기" 두 번이다.

        DRAMA 구간의 TID들 ─┐
                            ├─→ 합침 (Bitmap 또는 순차 이어붙이기)
      ROMANCE 구간의 TID들 ─┘

⑶ 합친 결과에는 "전체 순서"가 없다
   ROMANCE 08-31 다음에 와야 하는 것이 ROMANCE 08-30 인지 DRAMA 08-29 인지는
   두 구간의 머리를 "동시에 보며 비교"해야만 알 수 있다.
   그런데 ⑵는 한 구간을 다 훑고 다음 구간으로 넘어가므로 그 비교를 하지 않는다.
   게다가 Bitmap 으로 합치면 TID 를 힙의 물리 순서로 재배열하므로 순서는 완전히 사라진다.

        ↓
     Sort (입력 13만 건)
        ↓
     Limit 20
```

한 줄로 압축하면 — **`IN`은 등호처럼 생겼지만 인덱스 리프에서는 구간이 값 수만큼 갈라지고, 갈라진 구간들을 합치는 단계에서 순서가 사라진다.** (PostgreSQL 17이 배열 조건 스캔을 개선해 여러 값을 한 번의 인덱스 하강으로 훑도록 바꿨지만, 그것은 스캔 효율의 개선이지 **"갈라진 구간을 합친 순서"를 만들어 주는 것이 아니다** — 기본기는 그대로다.)

#### PostgreSQL이 순서를 지켜 주는 경우 — `Merge Append`

그런데 PostgreSQL에는 "정렬된 입력 여러 개를 순서를 지키며 합치는" 노드가 있다. **`Merge Append`**다.

```text
Merge Append 가 하는 일 — 지퍼처럼 머리만 비교해 하나씩 뽑는다

   가지 1 (ROMANCE, updated_at DESC):  08-31 → 08-30 → 08-29 → ...
   가지 2 (DRAMA,   updated_at DESC):  08-29 → 08-28 → 08-27 → ...

   1회: 두 가지의 머리 08-31 vs 08-29 → 08-31 출력
   2회: 08-30 vs 08-29                → 08-30 출력
   3회: 08-29 vs 08-29                → 08-29 출력
   ...
   20회를 채우면 즉시 멈춘다.  → 읽은 엔트리 약 20~40개. Sort 노드 없음.

   비용: 매 출력마다 "가지 수 - 1"번 비교. 가지가 2개면 1번, 5개면 4번.
        전체 입력 13만 건은 건드리지도 않는다.
```

`Merge Append`가 서려면 **⑴ 각 가지가 이미 같은 정렬 키·같은 방향(NULLS 위치 포함)으로 정렬된 출력을 내야 하고 ⑵ 플래너가 그 사실을 pathkey로 알고 있어야** 한다. PostgreSQL이 이 노드를 고르는 경우는 실질적으로 둘이다.

- **`UNION ALL`로 가지를 명시적으로 나눴을 때** — 각 가지가 `Index Scan Backward`로 정렬된 출력을 내고, 바깥 `ORDER BY`가 그 키와 일치하면 `Append` 대신 `Merge Append`가 선다. 아래 처방 A가 이 경로다.
- **선언적 파티셔닝 테이블을 조회할 때** — 파티션마다 같은 인덱스가 있고 `ORDER BY`가 그 인덱스 순서와 맞으면, 파티션들의 `Append`가 `Merge Append`가 된다. 파티션 테이블에서 `ORDER BY … LIMIT`이 빠른 이유가 이것이다.

**반대로 `col IN (…)` 한 줄에는 자동으로 붙지 않는다.** 하나의 `Index Scan` 노드 안에서 여러 구간을 훑는 형태라 "가지"라는 구조 자체가 계획에 없기 때문이다. 그래서 순서를 지키고 싶으면 **가지를 사람이 만들어 줘야 한다** — 그것이 처방 A다.

#### 처방 셋 — N과 빈도로 고른다

```sql
-- 처방 A — 구간마다 인덱스로 20건씩 뽑고, 그 합(장르 수 × 20)만 병합한다
SELECT * FROM (
    (SELECT id, title, thumbnail_url, updated_at FROM webtoon
      WHERE genre = 'ROMANCE' AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20)
    UNION ALL
    (SELECT id, title, thumbnail_url, updated_at FROM webtoon
      WHERE genre = 'DRAMA'   AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20)
) AS candidates
ORDER BY updated_at DESC
LIMIT 20;
-- 안쪽 두 SELECT: 각각 Index Scan Backward로 20건 — 정렬 0
-- 바깥: 입력 40건이라 Sort가 남아도 마이크로초다. "Sort가 있지만 N이 40"이라 문제가 아니다(2-3)
--   (가산점: 각 가지가 이미 updated_at DESC 순이므로 플래너가 바깥 Sort 대신
--    Merge Append 를 고를 수 있다 — 그러면 정렬 자체가 사라진다)
-- 왜 안쪽에 LIMIT 20이 필요한가: 최종 20건에 드는 행은 어느 가지에서 오든
--   그 가지 안에서는 상위 20위 안이다. 그러니 가지마다 20건만 있으면 정답이 보장된다.
-- 대가: 선택 장르 수만큼 서브쿼리가 늘어난다 → 선택 개수 상한(예: 5개)을 API에서 강제

-- 처방 B — 선택 장르가 많거나(10개+) 이 화면 빈도가 낮다면 Sort를 허용하고 목록에 등록
--    단, 커서 페이지네이션(다음 페이지)은 정렬 키 순서를 인덱스가 보장할 때만 안전하므로
--    이 화면은 OFFSET 상한 + INCLUDE 커버링으로 힙 페치를 줄여서 간다

-- 처방 C — 이런 조합 필터가 계속 늘어날 화면이면 검색 엔진(2-6 가산점)
```

이 사례의 교훈은 두 줄이다 — **⑴ ORDER BY의 인덱스 사용은 WHERE의 모양이 조금만 바뀌어도 깨진다**(`=` → `IN`, 컬럼 하나 추가, 방향·NULLS 하나 변경) ⑵ 그래서 "지금 안 타는가"보다 **"깨졌을 때 누가 알아채는가"**가 설계의 일부다. 3-3의 단정 테스트가 있었다면 이 회귀는 CI에서 빨간불이 켜졌다.

### 3-3. `EXPLAIN` 단정 테스트 — 허용한 Sort는 "목록으로 선언"하고, 목록 밖은 실패

[실행 계획 읽기 §3-4](10-explain-and-slow-query-process.md)의 EXPLAIN 단정 테스트를 정렬 축에 맞게 한 단계 구체화한다. 핵심은 2-6의 판단 결과(어느 정렬은 인덱스, 어느 정렬은 허용)를 **코드 한 곳에 두고, 런타임 화이트리스트와 테스트가 같은 곳을 읽게** 하는 것이다.

```java
// 정렬 축의 단일 출처 — API 화이트리스트(3-5)와 실행 계획 테스트가 같은 enum을 본다
public enum WebtoonSort {
    LATEST ("updated_at", true),    // 인덱스 (genre, status, updated_at)
    NEWEST ("created_at", true),    // 인덱스 (genre, status, created_at)
    RATING ("rating_avg", false),   // Sort 허용 — 2-6 판단: 저빈도, N 수만 이하
    TITLE  ("title",      false);   // Sort 허용 — 동일

    final String column;
    final boolean indexed;          // true면 실행 계획에 Sort 노드가 있어선 안 된다

    WebtoonSort(String column, boolean indexed) { this.column = column; this.indexed = indexed; }
}
```

```java
@SpringBootTest
class WebtoonListPlanTest {

    @Autowired JdbcTemplate jdbcTemplate;
    @Autowired ObjectMapper objectMapper;

    @BeforeAll
    static void seed(@Autowired JdbcTemplate jdbc) {
        seedWebtoons(jdbc, 300_000);            // 운영 규모. 작은 테이블에선 플래너가 다른 계획을 고른다
        jdbc.execute("ANALYZE webtoon");        // 통계가 없으면 계획이 실전과 다르다
    }

    @ParameterizedTest
    @EnumSource(WebtoonSort.class)
    void 장르목록_정렬축별_실행계획은_선언과_일치한다(WebtoonSort sort) throws Exception {
        // ANALYZE 없이 계획만 — 실행하지 않으므로 빠르고, Plan Rows(추정)로 정렬 입력을 읽는다
        String plan = jdbcTemplate.queryForObject(
            "EXPLAIN (FORMAT JSON) SELECT id, title, thumbnail_url FROM webtoon "
          + "WHERE genre = 'ROMANCE' AND status = 'ACTIVE' "
          + "ORDER BY " + sort.column + " DESC LIMIT 20",
            String.class);

        JsonNode root = objectMapper.readTree(plan).at("/0/Plan");
        // 트리를 내려가며 "Sort" 또는 "Incremental Sort" 노드를 찾는다.
        // 정렬이 인덱스로 해결되면 노드 자체가 없다 → "Sort 없음"
        Optional<JsonNode> sortNode = findNode(root,
            n -> n.path("Node Type").asText().endsWith("Sort"));

        if (sort.indexed) {
            assertThat(sortNode)
                .as("%s 정렬은 인덱스로 처리돼야 한다 — 인덱스 삭제/순서 변경/IN 도입을 의심", sort)
                .isEmpty();
        } else {
            // 허용한 Sort는 "정렬 입력 N"에 상한을 건다 — N이 자라면 결정을 재검토하라는 신호
            long sortInputRows = sortNode.orElseThrow().at("/Plans/0/Plan Rows").asLong();
            assertThat(sortInputRows)
                .as("%s 은 Sort 허용이지만 정렬 입력이 %d건 — 2-6 판단을 다시 하라", sort, sortInputRows)
                .isLessThan(50_000);
        }
    }

    private static Optional<JsonNode> findNode(JsonNode node, Predicate<JsonNode> pred) {
        if (pred.test(node)) return Optional.of(node);
        for (JsonNode child : node.path("Plans")) {
            Optional<JsonNode> found = findNode(child, pred);
            if (found.isPresent()) return found;
        }
        return Optional.empty();
    }
}
```

이 테스트가 잡는 것 — ⑴ 누군가 "안 쓰는 것 같아서" 인덱스를 지웠을 때 ⑵ 컬럼 순서를 바꿨을 때 ⑶ 3-2처럼 리포지토리가 `=`를 `IN`으로 바꿨을 때 ⑷ 허용한 Sort의 N이 자라 "허용"의 전제가 무너졌을 때. 넷 다 리뷰어의 눈이 아니라 CI가 잡는다.

대가는 [복합 인덱스 §3-4](08-composite-index-column-order.md)의 주의와 같다 — 운영 규모 시드 + `ANALYZE`가 필요해 무거우니 **목록 API의 뜨거운 쿼리 몇 개**에만 건다. (Testcontainers로 PostgreSQL을 띄우는 구성은 3장 문서들 참고.)

### 3-4. 로그 + 임시 파일 지표 알람 — `temp_bytes`는 0에 가까워야 정상이다

```ini
# postgresql.conf / RDS 파라미터 그룹 (IaC로 관리)
shared_preload_libraries = 'pg_stat_statements,auto_explain'
log_min_duration_statement = 500ms            # 느린 문장을 로그에
auto_explain.log_min_duration = 500ms         # 그 문장의 실제 계획도 같이
auto_explain.log_analyze = on                 # actual rows — Sort 아래 노드 rows = 정렬 입력 N
auto_explain.log_buffers = on                 # shared hit/read, temp read/written
log_temp_files = 0                            # 임시 파일이 생길 때마다 "크기 + 쿼리" 한 줄 — 스필을 빠짐없이
# temp_file_limit = '5GB'                     # 세션당 임시 파일 상한 (폭주 방어, 선택)
```

> `auto_explain.log_analyze = on`은 모든 문장에 계측을 붙이므로 오버헤드가 있다 — 부담되면 `auto_explain.log_timing = off`(행 수만 세고 시간은 안 잰다)나 `auto_explain.sample_rate`로 표본만 남긴다.

지표는 두 층으로 본다.

**전역 — 대시보드 + 알람.** `pg_stat_database`의 `temp_files`(임시 파일 개수), `temp_bytes`(그 크기). postgres_exporter라면 `pg_stat_database_temp_bytes` 같은 이름으로 나온다. **`temp_bytes`의 증가율은 정상 상태에서 0에 가깝다** — 지속적으로 오르면 어떤 쿼리가 `work_mem`을 넘겨 디스크 정렬(또는 해시 스필)을 하고 있다는 뜻이다.

정렬 입력 N 자체를 세는 전역 카운터는 PostgreSQL에 없다. 그래서 "N이 큰 정렬"은 아래 쿼리 단위 지표의 **읽은 블록 대비 반환 행**으로 잡는다 — 3-1의 계획이 정확히 "블록 6만, 반환 20"이었다는 것을 떠올리면 왜 이 비율이 신호인지가 보인다.

**쿼리 단위 — 주간 리포트.** 어느 쿼리인지는 `pg_stat_statements`가 알려준다.

```sql
SELECT queryid,
       left(query, 80)                                   AS query_head,
       calls,
       temp_blks_written,                                -- 0이 아니면 디스크 스필이 있었다 (정렬·해시)
       (shared_blks_hit + shared_blks_read) / calls      AS blks_per_call,   -- 호출당 읽은 블록
       rows / calls                                      AS rows_per_call    -- 호출당 반환 행
FROM pg_stat_statements
WHERE temp_blks_written > 0
   OR (shared_blks_hit + shared_blks_read) / GREATEST(calls, 1) > 1000
ORDER BY temp_blks_written DESC, blks_per_call DESC
LIMIT 10;
-- 읽는 법: rows_per_call 이 20인데 blks_per_call 이 6만이면 2장의 사슬 그대로다 —
--   "결과 20건을 위해 블록 6만 장". 정확한 정렬 입력 N은 그 queryid의 auto_explain 로그에서
--   Sort 아래 노드의 actual rows로 확인한다. 2-6 표의 재검토 입력이 된다
```

**`work_mem`을 전역으로 키우는 것은 처방이 아니다** — 백엔드마다·정렬 노드마다 잡는 메모리라 동시 정렬 수 × 노드 수만큼 곱해지고, 무엇보다 N을 줄이지 않는다. 대량 정렬이 정당한 배치·리포트 트랜잭션에서만 `SET LOCAL work_mem = '256MB'`로 올린다(4장 네 번째 꼬리질문).

### 3-5. 정렬 파라미터 화이트리스트 — 클라이언트가 보낸 컬럼명이 `ORDER BY`에 그대로 들어가지 않게

```java
// before — ?sort=view_count,desc 가 Pageable을 거쳐 그대로 ORDER BY로 간다
//   인덱스 없는 컬럼이면 매 요청 Sort, 없는 컬럼이면 500, 민감 컬럼이면 정보 노출
@GetMapping("/webtoons")
public Slice<WebtoonCard> list(@RequestParam String genre, Pageable pageable) {
    return repository.findByGenreAndStatus(genre, ACTIVE, pageable);
}

// after — 정렬 축은 enum으로 닫는다. 목록 밖 값은 400.
//   어느 축이 인덱스인지 코드가 안다(3-3의 enum과 같은 것을 쓴다)
@GetMapping("/webtoons")
public Slice<WebtoonCard> list(@RequestParam String genre,
                               @RequestParam(defaultValue = "LATEST") WebtoonSort sort,
                               @RequestParam(defaultValue = "0") int page) {
    Pageable pageable = BoundedPageRequest.of(page, 20, Sort.by(DESC, sort.property()));
    return repository.findByGenreAndStatus(genre, ACTIVE, pageable);
}
```

`Pageable`의 `Sort`를 그대로 받는 API는 **정렬 축을 클라이언트가 정하는 API**이고, 그 순간 2-6의 판단이 무의미해진다. 열거형 하나로 닫으면 새 정렬 축을 추가하는 사람이 `indexed` 값을 채워야 하므로 **"이 정렬은 인덱스인가 Sort 허용인가"를 결정하지 않고는 기능을 추가할 수 없는** 구조가 된다 — 이것이 안전망의 목적이다.

---

## 4. 꼬리질문 대비 포인트

### "`LIMIT 20`인데 왜 8만 건을 다 정렬하나요? 상위 20건만 추리면 안 됩니까?"

PostgreSQL은 실제로 그렇게 한다 — **bounded sort**. `Sort` 위에 `Limit`이 있으면 플래너가 그 20을 `Sort`의 상한으로 넘기고, 실행기는 전체를 정렬하는 대신 크기 20짜리 힙을 유지하며 행마다 "현재 20위 안에 드는가"만 비교한다. `EXPLAIN ANALYZE`의 `Sort Method: top-N heapsort  Memory: 28kB`가 그 표시다(2-4의 [2]번 출력).

**정렬 비용은 실제로 줄어든다.** 2-2에서 계산한 대로 전체 정렬이면 `80,000 × log₂80,000 = 130만` 회 비교인데, top-20 힙이면 `80,000 + 166 × log₂20 ≈ 8만` 회로 약 16배 줄고 메모리와 디스크 스필도 사라진다.

**그러나 사슬의 ①은 그대로다** — **8만 건을 전부 읽어(힙 페치 또는 Bitmap Heap Scan으로 힙 페이지 6만 장) 힙과 비교**해야 20위를 확정할 수 있다. 21번째로 읽은 행이 1위일 수도 있으니 건너뛸 방법이 없다. 즉 정렬 비교는 16분의 1이 됐지만 **읽기 비용은 여전히 N에 비례**하고, 실제 목록 쿼리에서 비싼 쪽은 대개 읽기다(3-1의 계획이 정확히 이 모양이었다 — `Memory: 28kB`인데 `Buffers` 6만 장). 인덱스 경로는 읽기 자체가 20이다.

"LIMIT이 있으니 괜찮다"는 스필만 피한 것이지 사슬을 끊은 게 아니다. 덧붙이면 — 진짜로 일찍 멈추는 정렬은 **`Incremental Sort` + `LIMIT`**뿐인데, 그것도 입력이 접두사까지는 인덱스 순서를 빌리고 있을 때만 가능하다.

### "정렬 옵션이 다섯 개인 화면입니다. 인덱스를 다섯 개 만들겠습니까?" (시니어 변별 포인트)

아니다 — 기준을 먼저 세운다. **N(WHERE 후 매칭 행 수) × 요청 비중 × 정렬 컬럼의 변동성.** ⑴ 요청 대부분을 받는 기본 정렬(`updated_at`, 비중 70%)은 인덱스 ⑵ 불변 컬럼(`created_at`)은 쓰기 대가가 거의 없으니 N이 크면 인덱스 ⑶ 조회마다 바뀌는 컬럼(`view_count`)은 **라이브 값에 절대 인덱스를 걸지 않는다** — PostgreSQL에서는 그 컬럼의 UPDATE가 HOT에서 탈락해 페이지뷰마다 **테이블의 모든 인덱스**에 새 엔트리를 꽂고 죽은 엔트리를 남긴다. 배치가 채우는 랭킹 스냅숏 테이블(또는 materialized view, Redis Sorted Set)에서 읽고, "10분 지연"을 기획과 합의한다 ⑷ 저빈도·N 감당 가능한 축(`title`, `rating_avg`)은 **Sort를 허용하고 그 결정을 enum과 테스트에 선언**한다.

양면을 붙이면 — 인덱스 다섯은 정렬 비용을 없애는 대신 DML마다 트리 다섯을 갱신하고 shared_buffers를 다섯 배 나눠 쓰며, 허용은 쓰기 대가가 0인 대신 N이 자라면 p99가 되돌아오므로 `pg_stat_statements`의 호출당 블록 수와 `auto_explain`의 정렬 입력으로 감시한다. 축이 그 이상 늘고 필터 조합까지 자유로우면 RDB 인덱스가 아니라 검색 엔진의 일이다.

### "`Sort`가 스캔 바로 위에 있는 것과 조인·집계 위에 있는 것은 어떻게 다르고, 어느 쪽이 더 위험한가요?"

스캔 위의 `Sort`는 **읽은 행을 work_mem으로 보내 정렬하는 한 단계**다. 조인·집계 위의 `Sort`는 **그 아래 작업이 다 끝나야 정렬을 시작할 수 있다**는 뜻이다 — 조인에서 inner 테이블 컬럼으로 정렬할 때(`Hash Join`은 순서를 보장하지 않으니 조인이 끝나야 순서를 알 수 있다), `GROUP BY` 컬럼과 다른 컬럼으로 `ORDER BY` 할 때(`HashAggregate` 결과를 만든 뒤 정렬), `DISTINCT`·`UNION` 뒤 정렬할 때(`Append` 위) 나온다.

**두 단계 비용**이고, 아래 노드도 `Batches > 1`로 스필할 수 있어 `temp written`이 **두 노드에서** 잡힐 수 있으니 후자가 더 위험하다. 처방도 다르다 — 전자는 인덱스에 "정" 자리를 채우는 문제지만, 후자는 **쿼리 구조**의 문제다: 정렬 컬럼을 outer 테이블 쪽으로 옮기고 안쪽 조인 키 인덱스로 `Nested Loop`을 유도하거나, `ORDER BY`를 조인 키와 맞춰 `Merge Join`이 정렬을 덤으로 주게 하거나, 그룹핑을 서브쿼리로 먼저 끝내고 바깥에서 정렬하거나, 집계 결과를 사전 계산 테이블·materialized view로 뺀다.

**(가산점 포인트)** `GROUP BY` 컬럼이 `ORDER BY` 컬럼과 같고 그 순서의 인덱스가 있으면 PostgreSQL은 `HashAggregate` 대신 **`GroupAggregate`**(정렬된 입력을 그대로 묶는 집계)를 골라 `Sort` 없이 끝낼 수 있다 — 집계 쿼리에서도 "인덱스 순서를 빌린다"는 같은 원리가 통한다.

### "`work_mem`을 키우면 해결되는 것 아닌가요?"

**증상 하나(스필)만 가리고 원인(N)은 그대로 둔다.** 2-2의 사슬에서 키운 `work_mem`이 없애는 것은 ③ 스필과 ④ 머지뿐이고, ① N건 읽기와 ② 적재, ⑤ "정렬 뒤에야 LIMIT", ⑥ 첫 행까지의 대기는 그대로다. 예제 규모로 말하면 임시 파일 I/O 30MB는 사라져도 힙 페이지 6만 장 읽기는 그대로다.

게다가 `work_mem`은 **백엔드마다, 계획의 정렬·해시 노드마다** 잡히므로 전역으로 키우면 동시 세션 수 × 노드 수 × 크기의 메모리가 예약된다 — 목록 API가 동시에 200개 돌고 계획에 정렬이 둘이면 400배이고, 프로세스 모델이라 OOM killer가 서버 전체를 세운다.

그래서 원칙은 ⑴ N을 줄이는 것(인덱스의 "정" 자리, 또는 3-2의 구간별 LIMIT) ⑵ 대량 정렬이 정당한 배치·리포트 트랜잭션에만 `SET LOCAL work_mem`으로 올리는 것 ⑶ 전역값은 `pg_stat_database.temp_bytes` 증가율을 보고 보수적으로. 한 호흡에 말하면 — "work_mem을 키우면 디스크 스필은 줄지만 읽기 비용과 세션당·노드당 메모리 예약이라는 대가는 그대로라, 정렬 입력 N을 줄이는 게 먼저다."

### "정렬 컬럼에 인덱스를 걸었더니 특정 장르에서 오히려 느려졌습니다. 왜죠?" (가산점 포인트)

**WHERE만 보는 반쪽의 거울상 — ORDER BY만 보는 반쪽**이고, PostgreSQL 플래너의 고전적 함정이다.

`(genre)`와 `(updated_at)`이 따로 있으면 플래너는 `ORDER BY updated_at DESC LIMIT 20`을 보고 "`(updated_at)`을 `Index Scan Backward`로 걸으며 `Filter: genre = $1`을 적용하다가 20건 차면 멈추자"를 고를 수 있다 — `Sort`는 사라지고, 로맨스처럼 흔한 장르(6.7%)는 평균 `20 ÷ 0.067 ≈ 300`건만 걸어도 20건이 차서 빠르다. 그러나 **희귀 장르(전체의 0.1%)**면 20건을 채우려고 평균 `20 ÷ 0.001 = 20,000`건을 걷고, 그 장르의 최신 작품이 오래전 것이면 인덱스 거의 전부를 걷는다 — 계획의 `Rows Removed by Filter`가 그 계산서다.

플래너가 이렇게 판단하는 이유는 **"필터 값이 정렬 순서 위에 균등하게 흩어져 있다"고 가정**하기 때문이고, 컬럼 간 순서 상관은 통계에 없어 `ANALYZE`나 `CREATE STATISTICS`로도 못 고친다. 처방은 **WHERE 등호와 ORDER BY를 한 인덱스로 묶는 것**(`(genre, status, updated_at)`) — 그러면 어느 장르든 구간 끝에서 정확히 20건이다. 응급으로 `ORDER BY updated_at + interval '0'`처럼 표현식으로 만들어 그 인덱스를 못 쓰게 하는 트릭이 있지만, 그건 증상 억제이고 인덱스 설계가 답이다.

교훈은 하나 — **정렬 인덱스는 WHERE의 등호 컬럼 뒤에 붙어야 정렬 인덱스**이지, 정렬 컬럼 단독 인덱스는 또 다른 반쪽이다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **이름과 단위** — MySQL은 메모리에서 끝나도 `Using filesort`라 찍혀 이름 함정이 있고 정렬 버퍼가 **세션당** `sort_buffer_size`인데, PostgreSQL은 `Sort` 노드의 유무로 보고 어디서 했는지는 `Sort Method`(quicksort / top-N heapsort / external merge)가 말하며 메모리는 **정렬 노드당** `work_mem`이다. 지표도 `Sort_merge_passes`·`Sort_rows` 대신 `temp_blks_written`·`log_temp_files`·`auto_explain`이다. ② **방향** — MySQL은 8.0에서야 내림차순 인덱스가 생겨 혼합 방향이 가능해졌지만, PostgreSQL은 오래전부터 컬럼별 `ASC/DESC/NULLS FIRST/LAST`를 지정할 수 있고 어느 인덱스든 `Index Scan Backward`로 거꾸로 읽는다. 대신 **NULLS 방향 불일치**라는 PostgreSQL 고유 함정이 있다. ③ **tie-breaker** — InnoDB 세컨더리 리프는 PK를 품어 `ORDER BY updated_at, id`가 공짜지만, PostgreSQL 리프는 TID라 `id`를 인덱스에 명시해야 하고 그 틈은 `Incremental Sort`가 메운다(MySQL에는 없는 노드). ④ **정렬 컬럼을 인덱스에 넣는 쓰기 대가** — InnoDB는 그 인덱스에서 삭제+삽입으로 끝나지만, PostgreSQL은 HOT 탈락으로 **모든 인덱스**에 새 엔트리가 꽂힌다. ⑤ **정렬 컬럼 단독 인덱스의 함정** — 양쪽 다 있지만 MySQL은 `prefer_ordering_index` 스위치로 임시 억제가 가능하고 PostgreSQL에는 그런 스위치가 없어 인덱스 설계로만 푼다. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "차이를 저장 구조에서 이해했다"로 들린다.

---

## 한 줄 요약

**`ORDER BY`가 공짜인 경우는 플래너가 고른 인덱스의 리프 순서가 곧 정렬 순서일 때뿐이다 — B-tree 리프가 키 순서로 이어져 있으니 순서대로 훑으면 비교 0회로 정렬이 따라오고, 거꾸로 훑으면 `Index Scan Backward`로 DESC가 된다. 조건은 "접·범·방·한·원·드": 등호 컬럼 + 정렬 컬럼이 선두부터 연속(접), 범위(`IN` 포함) 뒤 컬럼으로는 정렬 불가(범), 방향은 전부 같거나 전부 반대이고 NULLS 위치까지 일치(방), 한 인덱스 안에서(한), 컬럼 원형 그대로(원, 표현식 인덱스는 예외), 조인은 드라이빙 테이블 컬럼만(드). 하나라도 깨지면 계획에 `Sort` 노드 — 매칭 N건을 전부 읽어 work_mem에 적재하고, 넘치면 임시 파일에 썼다 다시 읽어 병합(`external merge Disk`)한 뒤에야 `Limit`이 자르므로 비용이 결과가 아니라 N에 비례한다(N=8만이면 비교 130만 회·임시 파일 I/O 30MB, `top-N heapsort`면 비교는 8만 회로 줄지만 힙 페이지 6만 장 읽기는 그대로). 인덱스 순서를 타면 20건 읽고 멈춘다. 그래서 인덱스는 "등·범·정·커"의 정 자리까지 채워야 완성이고, 정렬 축이 여럿이면 N × 요청 비중 × 컬럼 변동성(HOT 탈락 = 모든 인덱스 갱신)으로 인덱스/허용/사전 집계를 가른 뒤 그 결정을 `EXPLAIN (FORMAT JSON)` 단정 테스트·`temp_bytes`/`log_temp_files` 알람·정렬 축 enum에 박아 둔다.**
