# RDB의 JSON 컬럼 — "귀찮아서 jsonb"와 "비정형이라 jsonb"를 가르는 규율

> 핵심 관전 포인트: **JSON 컬럼(PostgreSQL에서는 `jsonb`)은 "행마다 모양이
> 다른 데이터를 DDL 없이 담는 자유"를 사는 대신, RDB가 컬럼에 제공하던 네
> 가지 — ① 인덱스(값의 정렬된 사본) ② 타입·제약(DB가 지키는 불변식) ③
> 좁은 갱신(바뀐 만큼만 쓰기) ④ 통계(플래너가 행 수를 맞출 근거) — 를
> 반납하는 거래다. PostgreSQL은 ①을 **표현식 인덱스·GIN**으로 상당 부분
> 되찾게 해 주지만 "미리 정한 키"만 빠르고, ③은 MVCC 위에서 오히려 더
> 비싸다 — 키 하나를 바꿔도 문서 전체가 **새 튜플 버전**으로 다시 쓰이고
> (TOAST 청크까지) WAL·죽은 튜플로 번진다. 그래서 판별은 취향이 아니라 네
> 질문이다: ⑴ 그 안의 값이 WHERE·JOIN·GROUP BY·ORDER BY의 대상인가 ⑵
> 스키마가 행마다 진짜 다른가(모든 행이 같은 키를 가지면 컬럼을 JSON에
> 숨긴 것) ⑶ 쓰기 후 부분 수정이 잦은가 ⑷ DB가 지켜야 할 불변식인가.
> 하나라도 "예"면 컬럼(또는 별도 테이블), 넷 다 "아니오"인 데이터 — 외부
> 원문 보존, 희소(sparse) 속성, 통째로 읽고 쓰는 문서 — 가 jsonb의 자리다.
> 쓰기로 했다면 안전망을 함께 든다: 조회 조건이 된 키는 **표현식 인덱스**
> (또는 STORED 생성 컬럼)로 승격, **`CHECK` + jsonb 연산자**(또는 DTO)로
> 스키마 검증, 버전 필드로 세대 관리.**

> 표기: 이 문서에서 "PG사"·"결제 PG"는 결제 게이트웨이(Payment Gateway)를
> 뜻한다. PostgreSQL은 줄이지 않고 항상 풀어 쓴다.

---

## 0. 질문 + 의도

**질문**: "RDB의 JSON 컬럼은 언제 쓰고 언제 피하나요? 인덱싱과 스키마 진화
관점의 트레이드오프는?"

**출제 의도**: 스키마 유연성의 편의와 **그 대가(인덱싱 제약, 타입 안전
상실, 조회 최적화 어려움)** 를 아는지. "정규화가 귀찮아서 JSON"과 "진짜
비정형 속성이라 JSON"을 구분하는 **설계 규율의 표본**이다. 즉 jsonb 연산자
문법이 아니라 — 편익과 대가를 양면으로 조립하고, 그 대가가 "왜" 생기는지를
저장 구조(힙 튜플·TOAST·MVCC)의 메커니즘으로 말하며, 쓰기로 했을 때 어떤
안전망을 함께 설계하는지를 본다. PostgreSQL은 `jsonb`·GIN·표현식 인덱스·
jsonpath까지 도구가 유난히 풍부해서 "되니까 쓴다"의 유혹이 크다 — **도구가
있다는 것과 써야 한다는 것은 다르다**는 판단이 이 문항의 핵심이다.
반정규화 문항([정규화 vs 반정규화](./04-normalization-vs-denormalization.md))과
같은 뿌리 — "중복을 두는 결정"이 아니라 "구조를 포기하는 결정"의 버전이다.

---

## 1. 개념 — jsonb 컬럼은 무엇을 반납하고 무엇을 사는가

### 1-0. 전제 — `json`과 `jsonb`, 두 타입 중 이 문서는 jsonb 기준

PostgreSQL에는 JSON 타입이 둘이다.

| | `json` | `jsonb` |
|---|---|---|
| 저장 | 입력 **텍스트 그대로** (공백·키 순서·중복 키 보존) | 파싱된 **바이너리** (공백 제거, 키 정렬, 중복 키는 마지막 값만) |
| 읽기 | 접근할 때마다 **다시 파싱** | 파싱 없이 키 탐색 |
| 연산자·인덱스 | `->`, `->>` 정도. GIN 불가 | `@>`, `?`, `?&`, jsonpath 등 전부. GIN·표현식 인덱스 가능 |
| 자리 | "바이트 그대로 보존"이 요구인 원문 증거 | 그 외 전부 |

기본 선택은 **jsonb**다. `json`은 2-3 (b)처럼 "받은 그대로"가 의미인
경우에만 쓴다 — jsonb는 저장하는 순간 정규화하므로 원문 바이트가 보존되지
않는다는 것을 알고 골라야 한다. 아래 본문의 "JSON 컬럼"은 jsonb를 뜻한다.

### 1-1. 컬럼이 공짜로 주던 네 가지

비유부터. 정식 컬럼은 **서류 양식의 인쇄된 칸**이다. 칸이 정해져 있으니
접수처는 그 칸 기준으로 **색인**(인덱스)을 만들 수 있고, 칸의 **형식**
(숫자만, 빈칸 금지, 다른 서류의 번호와 대조)을 접수 시점에 검사하며, 칸
하나만 **고쳐 쓸** 수 있고, 칸마다 "이 값이 대략 몇 건"이라는 **장부**
(통계)를 갖는다. JSON 컬럼은 양식 비고란에 **붙여 둔 메모지**다. 무엇이든
적을 수 있지만 — 접수처는 메모지 안의 내용으로 색인을 만들지 않고, 내용을
검사하지도 않으며, 한 글자를 고치려면 메모지를 새로 써서 다시 붙여야 하고,
메모지 안에 무엇이 몇 건 적혀 있는지 세지 않는다.

이 네 가지 — **인덱스, 타입·제약, 좁은 갱신, 통계** — 가 JSON 컬럼이
반납하는 것이고, 각각이 아래의 비용 사슬이 된다. 면접에서 "인덱스가 잘 안
된다", "타입이 없다"라고 결과만 말하는 것과, **왜 그런지를 사슬로** 말하는
것이 이 질문의 첫 변별점이다.

### 1-2. 사슬 ① 조건 검색 — 값이 정렬된 사본에 없어서 Seq Scan

[인덱스가 있는데 풀스캔](./02-index-not-used-full-scan.md) 문서의 한 문장을
다시 가져온다 — **인덱스란 인덱스 컬럼의 값과 그 행의 위치(TID)를 함께
담아 그 값 기준으로 정렬해 둔 별도의 사본**이다. 탐색이 빠른 이유는 오직
"찾는 값이 이미 정렬된 사본 안에 있어서"다.

JSON 컬럼의 내부 키는 플래너 입장에서 **컬럼이 아니다.** DB가 아는 것은
"이 행의 `attrs` 자리에 jsonb 값 하나가 있다"까지이고, 그 문서 안의
`genre`라는 키는 스키마에 존재하지 않는다. 그러니 사슬은 이렇게 간다.

> **⑴ 정렬 사본에 값이 없다**: B-tree는 컬럼 값을 담는데, `attrs->>'genre'`
> 는 컬럼이 아니라서 어떤 인덱스의 정렬 기준에도 들어 있지 않다. (jsonb
> 컬럼 자체에 B-tree를 걸 수는 있지만 그것은 **문서 전체**의 동등 비교용
> 정렬이라 내부 키 조건에는 아무 쓸모가 없다.)
>
> **⑵ 탐색 불가 → 전 행 읽기**: 정렬 기준이 없으니 B-tree를 타고 내려갈
> 수 없고, 유일한 방법은 모든 행을 처음부터 끝까지 읽는 **Seq Scan**이다
> (테이블이 크면 `Gather` 아래 `Parallel Seq Scan`으로 나오지만, 전 페이지를
> 읽는다는 사실은 같다).
>
> **⑶ 행마다 파싱 CPU**: 읽기만 하는 게 아니다. 행마다 jsonb를 열어 `genre`
> 키를 찾아 값을 텍스트로 꺼내 비교해야 한다. 일반 컬럼 Seq Scan은 값을
> 바로 비교하지만, jsonb Seq Scan은 **I/O + 키 탐색·변환** 이중 비용이다.
> 계획에는 `Filter:`와 `Rows Removed by Filter`로 찍힌다.
>
> **⑷ 큰 문서일수록 읽을 페이지도 많다**: 문서가 행을 뚱뚱하게 만들어
> 페이지(8KB)당 행 수가 줄고, 약 2KB를 넘는 값은 **TOAST**로 압축돼 별도
> 테이블에 청크로 밀려난다. `genre` 하나 보려고 청크를 모아 압축을 풀어
> 문서 전체(다른 키 수십 개 포함)를 끌어온다.
>
> **⑸ (PostgreSQL 고유) 통계가 없다**: `pg_stats`에는 `attrs` 컬럼 전체
> 값의 통계만 있고 내부 키의 분포는 없다. 그래서 표현식 조건의 선택도는
> 데이터를 보고 낸 값이 아니라 **상수**다 — 추정 rows가 실제와 자릿수로
> 어긋나고, 이 쿼리가 조인의 한 축이면 조인 순서·방식까지 틀어진다.

구조적으로는 "컬럼에 함수를 씌운 조건"(위 문서의 3-1)과 같은 부류다 —
`attrs->>'genre'`는 연산자(함수) 적용의 극단형이고, 가공 전 원본 값만
정렬해 둔 사본이 가공 후 값을 알 리 없다.

```sql
-- ❌ before: JSON 내부 키로 조건 검색 (에피소드 300만 건)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title
  FROM episodes
 WHERE format_attrs->>'genre' = '스릴러';

 Seq Scan on episodes  (cost=0.00..105604.00 rows=15000 width=40)
                       (actual time=0.412..1874.903 rows=9120 loops=1)
   Filter: ((format_attrs ->> 'genre'::text) = '스릴러'::text)
   Rows Removed by Filter: 2990880
   Buffers: shared hit=2112 read=58392
 Planning Time: 0.09 ms
 Execution Time: 1876.1 ms
-- 인덱스가 "안 쓰인" 게 아니라 애초에 후보조차 없다: 300만 행 전부 읽고(⑵)
-- 행마다 jsonb를 열어 비교했다(⑶ — Rows Removed by Filter 299만).
-- rows=15000 은 데이터를 보고 낸 추정이 아니라 상수 선택도(0.5%)다(⑸) —
-- 실제 비율이 0.3%든 30%든 똑같이 15000으로 찍힌다.
```

우회(표현식 인덱스·GIN)는 3장에서 다루지만, 원리는 하나로 요약된다 —
**값을 정렬 사본 안에 "존재하게" 만들어야 한다.**

### 1-3. 사슬 ② 부분 갱신 — 키 하나 고쳐도 문서 전체가 새 튜플로 다시 쓰인다

PostgreSQL에서는 어떤 컬럼이든 UPDATE가 제자리 덮어쓰기가 아니라 **새 튜플
버전 삽입 + 옛 버전에 `xmax` 표시**다([MVCC](./11-mvcc-postgresql.md)).
그러면 "컬럼이든 jsonb든 어차피 새 튜플인데 뭐가 다른가"가 정당한 반문이고,
답은 **쓰는 양**과 **인덱스**다.

> **컬럼 갱신**: `view_count`(8바이트)를 바꾸면 새 튜플은 행 폭(수십~수백
> 바이트)만큼이다. 바뀌지 않은 jsonb 값이 TOAST에 나가 있었다면 새 튜플은
> 그 **TOAST 포인터만 복사**하고 청크는 손대지 않는다. 인덱스된 컬럼이
> 아니면 **HOT 업데이트**로 인덱스 갱신도 생략된다.
>
> **jsonb 내부 키 갱신**: `jsonb_set(attrs, '{view_count}', ...)`은 ⑴ 저장된
> 문서 전체를 읽어(TOAST면 청크를 모아 압축 해제) → ⑵ 메모리에서 값을 바꾼
> **새 문서 전체**를 만들고 → ⑶ 그것을 새 튜플에 담아 힙에 쓰며(크면 다시
> 압축해 **새 TOAST 청크 세트**로) → ⑷ 그 전부가 **WAL**에 실리고 → ⑸ 옛
> 튜플과 옛 청크는 **죽은 튜플**로 남아 VACUUM이 치울 때까지 공간을 차지한다.
> 여기에 `attrs`에 GIN·표현식 인덱스가 걸려 있으면 "인덱스된 컬럼이
> 바뀐" 것이라 HOT이 깨져 **테이블의 모든 인덱스**에 새 엔트리가 들어가고,
> GIN은 pending list까지 쌓는다.

문서가 100KB면 숫자 하나 바꾸려고 100KB를 다시 쓰고, 100KB가 WAL로
레플리카까지 흘러가고, 100KB짜리 죽은 튜플이 bloat로 남는다. 그동안 잡고
있는 **행 락 보유 시간**도 늘어난다. 이 사슬에서 바로 도출되는 금지 사항이
하나 있다 — **JSON 안에 카운터를 넣지 마라.** 가장 잦은 쓰기를 가장 비싼
방식으로 하는 최악의 조합이다.

```sql
-- ❌ before: JSON 안의 조회수 — 조회 1건마다 문서 전체가 새 튜플로 재기록
UPDATE episodes
   SET format_attrs = jsonb_set(format_attrs, '{view_count}',
                                to_jsonb((format_attrs->>'view_count')::bigint + 1))
 WHERE id = $1;
-- 읽기→새 문서 생성→새 튜플(+새 TOAST 청크)→WAL→죽은 튜플. 문서에 썸네일
-- URL 목록, 태그, 번역 상태 같은 다른 키가 클수록 조회수 +1의 비용이 커진다.

-- ✅ after: 카운터는 컬럼 — 좁은 새 튜플, TOAST 무관, HOT 가능
UPDATE episodes SET view_count = view_count + 1 WHERE id = $1;
-- (물론 초고빈도 카운터는 컬럼이어도 핫 로우 문제가 남는다 —
--  그건 [핫 로우 문서](./23-high-frequency-counter-hot-row.md)의 사슬.
--  JSON은 거기에 "문서 전체 재기록"을 얹을 뿐이다.)
```

이 비용은 관찰할 수 있다 — `pg_stat_user_tables`의 `n_tup_upd` 대비
`n_tup_hot_upd`가 낮고 `n_dead_tup`이 빠르게 쌓이면 이 사슬이 돌고 있는
것이고, `pg_column_size(attrs)`로 문서 크기를, `pg_table_size(t) -
pg_relation_size(t)`의 차이로 TOAST 몫을 대략 본다.

### 1-4. 사슬 ③ 타입·제약 상실 — 불변식이 DB에서 애플리케이션 관례로 내려간다

`price numeric(12,2) NOT NULL`, `FOREIGN KEY (product_id)`, `UNIQUE (sku)` —
정식 컬럼의 제약은 **DB가 지킨다.** 어떤 코드 경로로 들어오든, 운영자가
psql에서 직접 넣든 뚫리지 않는다. jsonb 컬럼에는 이 검사가 하나도 없다.
DB가 보장하는 것은 "문법적으로 올바른 JSON인가"뿐이다.

```sql
-- 세 행 모두 "유효한 JSON"이라 INSERT가 전부 성공한다
INSERT INTO products (attrs) VALUES ('{"price": 1000}');      -- 숫자
INSERT INTO products (attrs) VALUES ('{"price": "1000"}');    -- 문자열
INSERT INTO products (attrs) VALUES ('{"prcie": 1000}');      -- 오타 키

-- 그리고 조회는 조용히 틀리거나, 시끄럽게 죽는다
SELECT count(*) FROM products WHERE (attrs->>'price')::numeric > 500;
-- 숫자 1000 → 텍스트 '1000' → 캐스트 OK → 포함
-- 문자열 "1000" → 텍스트 '1000' → 캐스트 OK → 포함 (타입이 달라도 조용히 섞인다)
-- 오타 행 → 키 없음 → NULL → 제외 → 아무 에러 없이 2건
-- 그리고 누군가 '{"price": "1,000"}' 을 넣는 순간, 이 쿼리는 그 한 행 때문에
-- ERROR: invalid input syntax for type numeric 로 통째로 실패한다.

SELECT jsonb_typeof(attrs->'price'), count(*) FROM products GROUP BY 1;
-- number | string | (NULL) — 섞여 있다는 사실은 이렇게 사후에야 드러난다.
```

[정규화 문서 2-3](./04-normalization-vs-denormalization.md)의 결론을 그대로
가져온다 — **불변식이 DB 제약이 아니라 애플리케이션 관례에 살면, 그 관례를
모르는 새 코드 경로·DB 직접 수정에 뚫린다.** 반정규화 컬럼은 불변식
"하나"를 관례로 내려보냈지만, jsonb 컬럼은 **그 안의 모든 필드에 대해
그것을 기본값으로 만든다.** 여기에 두 가지가 더 얹힌다.

- **참조 무결성 부재**: `{"author_id": 42}`가 삭제된 작가를 가리켜도 DB는
  모른다. FK가 막던 고아(orphan) 참조가 검출 수단 없이 쌓인다.
- **NULL의 세 얼굴**: SQL `NULL`(컬럼 자체가 비었다), JSON `null`(키는 있고
  값이 null), 키 부재(키 자체가 없다)가 서로 다른 의미로 공존한다.
  PostgreSQL 연산자는 이 셋을 다르게 본다 — `attrs->>'k'`는 JSON null과 키
  부재를 **둘 다 SQL NULL로** 뭉개고, `attrs->'k'`는 JSON null을 jsonb
  `'null'`로, 키 부재를 SQL NULL로 구분하며, `attrs ? 'k'`는 값과 무관하게
  키 존재만 본다. 쿼리와 코드가 이 셋을 구분하지 않으면 집계가 어긋난다.

### 1-5. 그럼에도 사는 것 — 정확히 네 가지

대가를 다 말했으니 편익도 정확히 말해야 양면이 조립된다. JSON 컬럼이
사는 것은 정확히 다음 넷이다.

1. **희소(sparse) 속성**: 행마다 키 집합이 진짜 다를 때, NULL투성이 컬럼
   수십 개나 EAV(속성 테이블) 없이 담는다.
2. **DDL 없는 필드 추가**: 수억 건 테이블에 `ALTER TABLE ... ADD COLUMN`을
   내는 리스크([무중단 DDL](./14-online-ddl-zero-downtime-schema-change.md))를
   피한다 — 단, 이 자유의 청구서는 3-4에서 온다.
3. **외부 원문의 무손실 보존**: 스키마의 주인이 우리가 아닌 데이터(결제 PG
   응답, 웹훅 페이로드)를 그대로 둔다. "바이트 그대로"가 요구면 `json`
   (또는 `text`)이다 — jsonb는 키 순서·공백·중복 키를 정규화한다(1-0).
4. **문서 단위 접근**: 항상 통째로 읽고 통째로 쓰는 1:N 부속 데이터를
   조인 없이 한 번에 가져온다.

**얻는 것이 이 넷 중 하나가 아니면 JSON을 쓸 이유가 없다.** "테이블
하나 더 만들기 귀찮아서"는 이 목록에 없다.

---

## 2. 판별 체크리스트 — "귀찮아서"와 "비정형이라"를 가르는 네 질문

### 2-1. 네 질문

| 질문 | "예"라면 | 근거 사슬 |
|---|---|---|
| ⑴ 그 안의 값이 WHERE·JOIN·GROUP BY·ORDER BY 에 등장하는가? | 컬럼 | 사슬 ① — 조건 검색·집계는 정렬 사본과 통계가 필요 |
| ⑵ 모든 행이 (거의) 같은 키 집합을 갖는가? | 컬럼 | 스키마가 균일하면 JSON은 컬럼을 문서 안에 숨긴 것 |
| ⑶ 쓰기 후 부분 수정이 잦은가? (카운터·상태·수정 가능한 항목) | 컬럼 | 사슬 ② — 문서 전체가 새 튜플로 재기록 |
| ⑷ 다른 테이블을 참조하거나 UNIQUE·NOT NULL·타입 보장이 필요한가? | 컬럼 / 별도 테이블 | 사슬 ③ — DB가 지켜야 할 불변식 |

**하나라도 "예"면 컬럼(또는 별도 테이블)이다.** 넷 다 "아니오"인 데이터만
JSON 후보다. 이 표가 곧 "정규화가 귀찮아서 JSON"의 정체이기도 하다 —
⑴~⑷에 "예"인 데이터인데 테이블을 만들기 싫어서 JSON에 넣은 것. 그것은
반정규화(대가를 알고 관리하는 의도적 중복)도 아니고, **정규화 실패의 새
포장**이다.

⑵에 실무적 판정법 하나 — 테이블에 있는 문서 1,000개의 키 집합을 뽑아
본다. PostgreSQL이면 한 줄이다:

```sql
SELECT k, count(*) FROM (SELECT jsonb_object_keys(attrs) AS k
                           FROM products TABLESAMPLE SYSTEM (1)) s
 GROUP BY k ORDER BY 2 DESC;
-- 거의 모든 행에 나오는 키가 있으면 그 키들은 컬럼이었어야 한다.
-- 키 집합이 진짜로 제각각이면 희소 속성이 맞다.
```

### 2-2. 목록으로 인출한다 — JSON이 맞는 경우 5 / 피해야 할 경우 5

면접에서 "경우에 따라 다르다"로 끝내지 말고 목록을 그대로 꺼낸다.

**JSON이 맞는 경우**

1. **외부 시스템 원문 보존** — 결제 PG 응답, 웹훅 페이로드, 외부 API 응답.
   스키마의 주인이 우리가 아니고, write-once이며, 감사·분쟁 대응용이다.
2. **행마다 키가 다른 희소 속성** — 상품 카테고리별 규격, 콘텐츠 형식별
   메타데이터. 컬럼으로 펼치면 NULL이 대부분인 컬럼 수십 개가 된다.
3. **통째로 읽고 통째로 쓰는 문서** — 사용자 설정(preferences), 에디터
   레이아웃 상태. 항상 전체를 로드하고 전체를 저장하며, 조건 검색이 없다.
4. **감사·이력 스냅샷** — "그 시점에 이 객체가 어떤 모양이었나"를 통째로
   남기는 변경 이력. 조회는 PK나 시각 컬럼으로 하고 문서는 그냥 보여 준다.
5. **아직 형태가 굳지 않은 실험 속성** — 단, "굳는 순간 승격한다"는 출구
   규칙(3-4)이 함께 있을 때만.

**JSON을 피해야 할 경우**

1. **조회 조건·정렬·집계 대상** — `WHERE`·`ORDER BY`·`GROUP BY`에 오르는
   값. 사슬 ①. 특히 **조인의 축**이 되는 값은 통계 부재(⑸)로 계획까지
   망친다.
2. **다른 테이블과의 관계** — 주문의 상품 목록, 글의 태그처럼 반대 방향
   조회("이 상품이 포함된 주문", "이 태그의 글")가 필요한 1:N. 별도
   테이블이다.
3. **모든 행이 같은 키를 갖는 균일 데이터** — 그냥 컬럼이다.
4. **잦은 부분 갱신, 특히 큰 문서의** — 카운터, 상태값, 재고. 사슬 ②.
   문서가 클수록(TOAST) 한 번의 갱신이 비싸진다.
5. **DB가 지켜야 할 불변식이 있는 값** — 금액, 식별자, 필수값, 유일값.
   사슬 ③.

### 2-3. 도메인에 대 보기 — 세 사례와 반례 하나

**(a) 웹툰 에피소드 메타데이터 — 공통은 컬럼, 형식별 희소 속성만 JSON**

```sql
-- ❌ before: "메타데이터는 다 JSON에" — 조회 조건까지 문서 안에
CREATE TABLE episodes (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meta  jsonb   -- {"title":..., "no":12, "published_at":..., "is_free":true,
                  --  "genre":"로맨스", "cut_count":48, "bgm_track":"..."}
);
-- 목록 화면: WHERE (meta->>'is_free')::boolean ORDER BY meta->>'published_at'
-- → 사슬 ① 그대로(Seq Scan + Sort). 회차 번호 UNIQUE도, 공개일 NOT NULL도 못 건다.

-- ✅ after: 모든 에피소드가 갖는 것 + 조회 조건은 컬럼, 형식별 속성만 JSON
CREATE TABLE episodes (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    series_id     bigint      NOT NULL REFERENCES series(id), -- "시리즈의 에피소드 목록" 조회
    episode_no    int         NOT NULL,                       -- UNIQUE(series_id, episode_no)
    title         text        NOT NULL,
    published_at  timestamptz NOT NULL,                       -- 정렬·범위 조건
    is_free       boolean     NOT NULL,                       -- 필터 조건
    view_count    bigint      NOT NULL DEFAULT 0,             -- 잦은 갱신 → 사슬 ②
    format_attrs  jsonb       NOT NULL DEFAULT '{}',          -- 형식별 희소 속성만:
    --   컷툰: {"cut_count":48, "swipe_hint":true}
    --   효과툰: {"bgm_track":"...", "vibration_points":[...]}
    --   일반: {}
    UNIQUE (series_id, episode_no)
);
CREATE INDEX idx_episodes_series_published ON episodes (series_id, published_at DESC);
```

판별 흐름을 소리 내어 말하면 — "제목·회차·공개일·무료여부는 모든 행에
있고(⑵ 예) 목록의 필터·정렬 조건이라(⑴ 예) 컬럼. 조회수는 잦은 갱신(⑶
예) 컬럼. 컷 수·BGM 트랙은 형식마다 있거나 없고(⑵ 아니오), 조회 조건이
아니며(⑴ 아니오), 등록 후 거의 안 바뀌고(⑶ 아니오), 참조·유일 제약이
없다(⑷ 아니오) — JSON."

**(b) 결제 PG 원문 응답 — 원문은 JSON으로 보존, 조회 키는 컬럼으로 추출**

```sql
-- ❌ before: 응답 통째로만 저장 — 나중에 "승인번호로 찾아 주세요"가 오면 Seq Scan
CREATE TABLE payment_approvals (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gateway_response jsonb NOT NULL
);

-- ✅ after: 이중 저장 — 원문(무손실·write-once) + 조회용 컬럼(추출·인덱스)
CREATE TABLE payment_approvals (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id         bigint        NOT NULL REFERENCES orders(id), -- 주문→결제 조회
    gateway_name     text          NOT NULL,
    gateway_tid      text          NOT NULL,   -- PG사 거래 ID: 대사·환불 조회 키
    approval_no      text,                     -- 승인번호: CS 검색 키
    approved_amount  numeric(12,2) NOT NULL,   -- 금액: 정산 집계·정합성 검증
    status           text          NOT NULL,   -- 상태: 필터 + 갱신 대상
    gateway_response json          NOT NULL,   -- 원문 바이트 그대로. 절대 수정하지 않는다
    UNIQUE (gateway_name, gateway_tid)
);
CREATE INDEX idx_payment_approvals_approval_no ON payment_approvals (approval_no);
```

핵심은 **"원문 보존"과 "조회"를 같은 컬럼에 시키지 않는 것**이다. 원문은
PG사가 스키마의 주인이고 필드가 언제 늘어날지 모르며 분쟁 시 "그때 PG사가
정확히 뭐라고 응답했나"의 증거라 JSON이 맞다 — 그리고 "정확히"가 요구라서
여기만은 정규화하는 `jsonb`가 아니라 **원문 텍스트를 보존하는 `json`**이다
(조회하지 않을 컬럼이니 `json`의 "읽을 때마다 파싱" 비용은 문제가 안 된다).
그러나 우리가 조회·집계·정합성 검증에 쓰는 값(거래 ID, 승인번호, 금액,
상태)은 우리 도메인의 컬럼이다. 저장 시 한 번 추출해 두 곳에 쓴다 — 이것은
중복이지만, 원문은 write-once라 어긋날 갱신 경로가 없어
[정규화 문서의 "스냅샷"](./04-normalization-vs-denormalization.md)과 같은
성격(동기화 대상이 아닌 중복)이다.

**(c) 사용자 설정 — 통째로 읽고 쓰는 문서, 단 "집계 대상"은 빼낸다**

```sql
CREATE TABLE user_preferences (
    user_id          bigint      PRIMARY KEY REFERENCES users(id),
    marketing_opt_in boolean     NOT NULL,  -- 법적 근거·발송 대상 추출(WHERE) → 컬럼
    schema_version   int         NOT NULL,  -- 3-4의 세대 관리
    prefs            jsonb       NOT NULL,  -- {"theme":"dark","reader":{"direction":"vertical",
    updated_at       timestamptz NOT NULL   --  "auto_scroll_speed":3}, "notif":{...}}
);
```

테마·뷰어 방향·자동 스크롤 속도는 클라이언트 버전마다 키가 늘고, 항상
설정 화면에서 통째로 읽어 통째로 저장하며, 조건 검색이 없다 — JSON이
맞다(통째로 다시 쓰는 문서라 사슬 ②의 "전체 재기록"이 어차피 일어날 일이고,
문서도 작아 TOAST에 안 나간다). 그러나 "마케팅 수신 동의자에게 발송"은
`WHERE` 조건이고 법적 기록이라(⑴·⑷ 예) 컬럼으로 빼낸다. 그리고 "다크 모드
사용자 비율"을 대시보드에 띄우자는 요구가 오면? 집계 대상이 됐으니(⑴ 예)
승격하거나, 설정 변경 이벤트를 따로 적재해 거기서 센다 — jsonb Seq Scan
집계를 운영 DB에 매일 돌리는 선택지는 없다.

**(d) 반례 — 주문의 상품 목록을 JSON 배열로**

```sql
-- ❌ orders.items jsonb = [{"product_id":7,"qty":2,"price":1000}, ...]
-- 필요한 조회를 대 보면 전부 "예"다:
--   "상품 7이 포함된 주문"      → WHERE 대상 (⑴)  — GIN @> 로 되긴 하지만…
--   "상품별 판매량 집계"        → GROUP BY 대상 (⑴) — jsonb_array_elements 전개 후 집계, 매번 전 행
--   "product_id 유효성"         → FK (⑷)          — jsonb 안의 값에는 FK를 못 건다
--   "부분 취소 시 qty 감소"     → 부분 갱신 (⑶)    — 배열 원소 하나 고치려고 문서 전체 재기록
--   모든 주문이 같은 키 구조     → 균일 (⑵)
-- ✅ order_items 테이블. 이건 비정형이 아니라 1:N이다.
```

이 반례가 "정규화가 귀찮아서 JSON"의 전형이다. 주문 항목은 형태가
불규칙해서가 아니라 **테이블을 하나 더 만들기 싫어서** JSON에 들어간다.
PostgreSQL에서는 "GIN 걸면 되잖아요"가 따라붙는데 — 되는 것은 ⑴의 검색
하나뿐이고, FK·부분 갱신·집계는 그대로 남는다. 도구가 있다는 것과 써야
한다는 것은 다르다.

---

## 3. 인덱싱 우회와 스키마 진화 — 그리고 함께 들어야 할 안전망

### 3-1. 표현식 인덱스 — 값을 정렬 사본 안에 "존재하게" 만든다

사슬 ①의 원인이 "값이 정렬 사본에 없다"였으니, 우회는 그 값을 **사본에
넣는 것**이다. PostgreSQL의 1순위 도구는 **표현식 인덱스**(expression
index)다 — "이 식의 결과값으로 정렬한 B-tree"를 만들라고 등록하면, 인덱스
리프에 식의 결과가 **물질화**되어 정렬된다. 테이블 행은 한 바이트도 안
바뀐다.

```sql
-- ✅ 표현식 인덱스로 승격 — 테이블 재작성 없음, CONCURRENTLY 면 쓰기도 안 막음
CREATE INDEX CONCURRENTLY idx_episodes_genre
    ON episodes ((format_attrs->>'genre'));
ANALYZE episodes;

-- 이제 같은 식을 쓴 조건은 인덱스를 탄다
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title FROM episodes WHERE format_attrs->>'genre' = '스릴러';

 Bitmap Heap Scan on episodes  (cost=178.63..24211.40 rows=9030 width=40)
                               (actual time=2.310..41.877 rows=9120 loops=1)
   Recheck Cond: ((format_attrs ->> 'genre'::text) = '스릴러'::text)
   Heap Blocks: exact=8714
   Buffers: shared hit=8746
   ->  Bitmap Index Scan on idx_episodes_genre  (cost=0.00..176.37 rows=9030 width=0)
                                                (actual time=1.402..1.403 rows=9120 loops=1)
         Index Cond: ((format_attrs ->> 'genre'::text) = '스릴러'::text)
         Buffers: shared hit=32
 Planning Time: 0.21 ms
 Execution Time: 42.6 ms
-- 읽은 블록 60,504 → 8,746. 그리고 rows=9030 — 추정이 실제(9120)에 붙었다(아래 ②).
```

세 가지를 함께 말하면 원리를 이해했다는 신호다.

- **① 식 일치 조건**: 플래너는 쿼리의 식이 인덱스 정의의 식과 **같은 형태**
  (연산자, 캐스트, 결과 타입까지)일 때만 인덱스를 매칭한다.
  `((attrs->>'price')::numeric)`로 만든 인덱스는 `attrs->>'price' = '1000'`
  (text 비교)에는 쓰이지 않고, `(attrs->>'price')::numeric = 1000`에만 쓰인다.
  이 식을 리포지토리 상수나 뷰로 한 곳에 고정해 두는 것이 실무 규율이다.
- **② 통계까지 따라온다 (가산점 포인트)**: 표현식 인덱스가 있으면 `ANALYZE`가
  **그 식의 결과에 대한 통계**(n_distinct, most_common_vals)를 함께 수집한다.
  사슬 ①의 ⑸(상수 선택도)가 이 순간 풀린다 — 위 계획에서 rows=15000이
  rows=9030으로 바뀐 이유다. 최근 버전은 인덱스 없이도 `CREATE STATISTICS ...
  ON ((attrs->>'genre')) FROM episodes`로 표현식 통계만 따로 만들 수 있다.
- **③ 타입 고정 — 그리고 인덱스가 데이터 품질 검사기가 된다**:
  `((attrs->>'price')::numeric)` 인덱스는 생성 시 **모든 행에 대해 식을
  계산**하므로, 한 행이라도 `"1,000"`이 들어 있으면 `CREATE INDEX` 자체가
  실패한다. 사슬 ③이 인덱스 시점에 터지는 것이다 — 우회는 사슬 ①만 풀지
  ③은 풀지 않는다는 것을 이보다 잘 보여 주는 장면이 없다.

두 가지 변형이 더 있다.

- **부분 인덱스와의 결합**: `... ON episodes ((format_attrs->>'genre'))
  WHERE format_attrs ? 'genre'` — 키가 없는 행을 인덱스에서 빼 크기를 줄인다.
  희소 속성일수록 효과가 크다. 쿼리에도 같은 `WHERE` 조건이 있어야 매칭된다.
- **생성 컬럼(STORED) + 일반 인덱스**: `ALTER TABLE episodes ADD COLUMN genre
  text GENERATED ALWAYS AS (format_attrs->>'genre') STORED` — 정식 컬럼 이름으로
  조회하고, 일반 인덱스·통계·`NOT NULL`·`CHECK`가 다 붙는다. 대신 **행에도
  값이 저장**되고, 기존 테이블에 추가하면 **테이블 재작성**(ACCESS EXCLUSIVE
  잠금, [무중단 DDL](./14-online-ddl-zero-downtime-schema-change.md))이다.
  큰 테이블에는 표현식 인덱스가 먼저이고, 생성 컬럼은 "이 키는 이제 사실상
  컬럼"이라고 선언할 때의 도구다.

> MySQL 대조: MySQL은 JSON 컬럼 자체에도, JSON 식에도 인덱스를 직접 걸지
> 못해 **생성 컬럼(`GENERATED ALWAYS AS (...) VIRTUAL`) + 인덱스**가 정석이다.
> VIRTUAL은 행에 값을 저장하지 않고 인덱스에만 물질화되며 추가가 메타데이터
> 변경만이라 싸다 — PostgreSQL에서 그 자리를 맡는 것이 표현식 인덱스다.

### 3-2. GIN — 키를 미리 정하지 않고 문서 안을 역색인한다 (가산점 포인트)

`tags: ["로맨스", "학원", "완결"]`처럼 **배열 원소가 조건**이 되는 경우는
표현식 B-tree로 안 된다 — 행 하나에 값이 여러 개라서 "정렬 사본의 한 자리"
에 넣을 수 없다. 이때의 도구가 **GIN**(Generalized Inverted Index)이다.
B-tree가 "행 → 값"의 정렬이라면 GIN은 "값(키/원소) → 그 값을 가진 행들의
목록"이라는 **역색인**이다. jsonb 컬럼 전체에 걸면 문서 안의 **모든 키와
값**이 색인되므로, 어떤 키를 조회할지 **미리 정하지 않고도** 포함 검색이
된다.

```sql
CREATE INDEX CONCURRENTLY idx_episodes_attrs_gin
    ON episodes USING gin (format_attrs);              -- 연산자 클래스 기본 jsonb_ops

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM episodes WHERE format_attrs @> '{"tags": ["완결"]}';

 Bitmap Heap Scan on episodes  (cost=412.08..38620.55 rows=3000 width=8)
                               (actual time=18.204..210.331 rows=51238 loops=1)
   Recheck Cond: (format_attrs @> '{"tags": ["완결"]}'::jsonb)
   Heap Blocks: exact=30112
   ->  Bitmap Index Scan on idx_episodes_attrs_gin  (cost=0.00..411.33 rows=3000 width=0)
                                                    (actual time=12.871..12.872 rows=51238 loops=1)
         Index Cond: (format_attrs @> '{"tags": ["완결"]}'::jsonb)
-- GIN 은 항상 Bitmap 스캔으로 나온다(TID 를 모아 힙을 순차 접근). Recheck 는 정상.
-- rows=3000 은 또 상수 선택도 — GIN 은 통계를 만들어 주지 않는다.
```

말해야 할 것은 연산자 클래스 둘과 대가다.

- **`jsonb_ops`(기본)**: 모든 키와 값을 각각 색인. `@>`(포함), `?`(키 존재),
  `?|`/`?&`(키 중 하나/전부 존재), jsonpath `@?`/`@@`를 탄다.
- **`jsonb_path_ops`**: "경로+값"의 해시만 색인. **더 작고 빠르지만** `@>`
  (와 jsonpath 포함 검색)만 되고 `?`는 못 쓴다. 포함 검색만 필요하면 이쪽.
- **범위 축소**: 문서 전체가 아니라 `USING gin ((format_attrs->'tags'))`처럼
  서브 문서에만 걸어 인덱스를 줄일 수 있다.
- **대가**: 인덱스가 크다("모든 키/값"의 값이다). 쓰기 비용이 높다 — 한 행
  INSERT/UPDATE가 키 수만큼의 엔트리를 만들고, 기본 설정(`fastupdate`)에서는
  **pending list**에 모아 두었다가 VACUUM이나 임계에서 병합하므로 그 사이
  읽기는 pending list까지 훑는다. `<`·`>`·`BETWEEN`·`ORDER BY`에는 쓸 수
  없다(역색인에는 순서가 없다). 그리고 `attrs`에 GIN이 있는 순간 그 컬럼의
  갱신은 전부 비-HOT이 된다(사슬 ②).

> MySQL 대조: 배열 원소 색인은 **멀티밸류 인덱스** —
> `CREATE INDEX ... ((CAST(attrs->'$.tags' AS CHAR(30) ARRAY)))`로 만들고
> `MEMBER OF`, `JSON_CONTAINS`, `JSON_OVERLAPS`가 탄다. 단 "미리 정한 배열
> 하나"만 색인한다는 점에서 표현식 인덱스의 배열판이지, 키를 안 정하는
> GIN 같은 도구는 없다.

### 3-3. 우회의 한계 — 결국 "미리 정한 키"만 빠르다

우회를 말한 다음 반드시 한계를 붙인다. 표현식 인덱스도 생성 컬럼도 **어떤
키를 색인할지 미리 정해야** 한다. 그런데 "미리 정해진, 모든 행이 갖는,
조회 조건인 키"는 — 2-1의 표로 돌아가면 — **정의상 컬럼이었어야 하는
것**이다. 그래서 우회의 정직한 적용 범위는 이렇다.

> 문서의 **대부분이 진짜 비정형**이고, 그중 **한두 키만** 조회 조건이
> 됐을 때 — 문서를 깨지 않고 그 키만 꺼내 색인하는 도구.

조회 키가 하나둘 늘어 표현식 인덱스가 다섯 개가 됐다면, 그것은 우회가
아니라 "컬럼이어야 했던 것을 뒤늦게 컬럼으로 만들고 있는 것"이다. 그
시점엔 JSON에서 빼내 정식 컬럼으로 승격하는 게 맞다. GIN처럼 키를 안
정하는 방식은 그 자유만큼 인덱스 크기·쓰기 비용·비-HOT을 내고, 범위·정렬
조건에는 무력하며, 통계는 여전히 없다. 공짜 우회는 없다.

### 3-4. 스키마 진화 — "자유"가 아니라 "책임의 이전"

1-5의 편익 ②(DDL 없는 필드 추가)의 청구서가 여기서 온다. 컬럼과 JSON의
스키마 변경을 나란히 놓으면 차이가 보인다.

| | 정식 컬럼 (PostgreSQL) | JSON 필드 |
|---|---|---|
| 필드 추가 | `ADD COLUMN ... DEFAULT` 1회 — 상수 기본값이면 카탈로그만 고쳐 즉시 끝, 모든 행이 그 순간 같은 형태 | 새 쓰기부터 키 존재. **옛 행은 키가 없는 채로 영구 공존** |
| 필드 이름 변경 | `RENAME COLUMN` 1회 (카탈로그) | 전 행 UPDATE(`(doc - 'old') \|\| jsonb_build_object('new', doc->'old')` — 각각 문서 전체 재기록, 사슬 ②) 또는 **영원한 이중 읽기** |
| 타입 변경 | `ALTER COLUMN ... TYPE ... USING (...)` — DB가 변환·검증, 한 행이라도 실패하면 DDL 전체가 롤백 | 아무도 검증하지 않음. 옛 타입·새 타입 행이 섞임 |
| 비용의 위치 | **DDL 시점에 한 번**(잠금·재작성 — 무중단 DDL이 어려운 이유) | **모든 읽기 코드에, 영원히** |

즉 JSON은 스키마 변경 비용을 없앤 것이 아니라 **"DB의 DDL 한 번"에서
"애플리케이션의 모든 읽기 경로, 무기한"으로 옮긴 것**이다. 배포마다 형태가
다른 세대(generation)의 행이 쌓이고, 읽는 코드는 모든 세대를 이해해야
한다. 이 책임을 감당하는 안전망이 세 가지다.

```sql
-- ❌ before: 검증도 버전도 없는 jsonb — 무엇이 들어 있는지 아무도 보장 못 함
CREATE TABLE user_preferences (
    user_id bigint PRIMARY KEY,
    prefs   jsonb  NOT NULL
);

-- ✅ after: 안전망 ①버전 필드 ②DB 층 스키마 검증 (CHECK + jsonb 연산자)
CREATE TABLE user_preferences (
    user_id        bigint PRIMARY KEY,
    schema_version int    NOT NULL DEFAULT 2,
    prefs          jsonb  NOT NULL,
    CONSTRAINT chk_prefs_shape CHECK (
        jsonb_typeof(prefs) = 'object'
        AND prefs ?& array['theme', 'reader']                          -- 필수 키
        AND prefs->>'theme' IN ('light', 'dark', 'system')             -- enum
        AND jsonb_typeof(prefs->'reader') = 'object'
        AND prefs->'reader'->>'direction' IN ('vertical', 'horizontal')
        AND (
            NOT (prefs->'reader' ? 'auto_scroll_speed')                -- 선택 키: 없거나
            OR (jsonb_typeof(prefs->'reader'->'auto_scroll_speed') = 'number'
                AND (prefs->'reader'->>'auto_scroll_speed')::numeric BETWEEN 1 AND 5)
        )
    )
);
-- 이제 {"theme": 3}도, {"reader": {}}도, psql 에서 직접 넣어도 INSERT 가 실패한다.
-- 불변식이 애플리케이션 관례에서 다시 DB 제약으로 올라왔다(사슬 ③의 부분 회복).

-- 이미 큰 테이블에 붙일 때: 전체 검증으로 잠그지 말고 두 단계로
ALTER TABLE user_preferences ADD CONSTRAINT chk_prefs_shape CHECK (...) NOT VALID;  -- 새 쓰기부터 검사
-- (위반 행을 배치로 정리한 뒤)
ALTER TABLE user_preferences VALIDATE CONSTRAINT chk_prefs_shape;                    -- 쓰기 안 막고 검증
```

```java
// ✅ after: 안전망 ③ 애플리케이션 층 — 버전별 역직렬화 + 업캐스팅
public UserPreferences read(long userId) {
    var row = repo.findById(userId);
    return switch (row.schemaVersion()) {
        case 1 -> upcastV1(mapper.readValue(row.prefs(), PrefsV1.class)); // 옛 세대 → 현재 모델
        case 2 -> mapper.readValue(row.prefs(), PrefsV2.class);
        default -> throw new UnsupportedSchemaVersionException(row.schemaVersion());
    };
}
// 쓰기는 항상 최신 세대로: 읽어서 업캐스팅한 뒤 저장하면 그 행은 v2가 된다
// (읽기 시 점진 마이그레이션). 남은 v1은 야간 배치로 훑어 올린다.
// DTO에는 Bean Validation(@NotNull, @Min)을 붙여 DB 층 검증과 이중으로 건다.
// 매핑: Hibernate 6 은 @JdbcTypeCode(SqlTypes.JSON) 으로 jsonb 컬럼에 바로 매핑되고,
//       pgjdbc 로 문자열을 직접 넣을 땐 SQL 쪽에서 $1::jsonb 로 캐스트한다.
```

세 안전망을 한 호흡에 말한다.

- **① 버전 필드(`schema_version`)**: 각 문서가 어느 세대인지 자기 표시.
  읽기 코드가 세대별로 분기(업캐스팅)하고, 쓰기는 항상 최신 세대로,
  남은 옛 세대는 배치로 점진 마이그레이션. "지금 v1이 몇 건 남았나"를
  `WHERE schema_version = 1`로 셀 수 있다는 것 자체가 가치다.
- **② 스키마 검증 — DB 층 우선**: PostgreSQL에는 JSON Schema 문서를 통째로
  검사하는 함수가 **내장돼 있지 않다**(`pg_jsonschema` 같은 확장은 있다).
  대신 `CHECK` 안에 `jsonb_typeof`·`?&`·`->>` + `IN`을 조합하면 필수 키·
  enum·타입·범위를 DB가 지킨다. DB 층에 두는 이유는 사슬 ③과 같다 —
  **psql 직접 수정과 새 코드 경로까지 막는 것은 DB 제약뿐**이다. 스키마가
  너무 자주 바뀌어 CHECK가 못 따라가면 최소한 애플리케이션 DTO + Bean
  Validation으로 쓰기 경로를 단일화한다. 둘 중 하나는 반드시.
- **③ 승격 규율**: 팀 규칙으로 문서화한다 — "JSON 안의 키가 조회 조건·
  집계·정렬 대상이 되는 순간 컬럼(또는 표현식 인덱스, 또는 별도 테이블)으로
  승격한다." 출구 규칙이 없는 JSON은 "임시"라는 이름으로 영구화된다.

---

## 4. 꼬리질문 대비 포인트

### "jsonb 안의 값으로 WHERE를 걸면 왜 느린가요? 어떻게 우회하나요?"

사슬로 답한다 — B-tree는 **컬럼 값을 정렬해 둔 사본**인데 jsonb 내부 키는
컬럼이 아니라 **어떤 사본에도 값이 없다** → 탐색 불가 → **Seq Scan** →
행마다 **jsonb 키 탐색 후 비교**(I/O + CPU 이중 비용, `Rows Removed by
Filter`) → 큰 문서일수록 TOAST 청크까지 → 게다가 **내부 키 통계가 없어**
추정 rows가 상수라 조인 계획까지 틀어진다. 우회의 원리는 "값을 사본에
존재하게 만들기" — **표현식 인덱스** `((attrs->>'genre'))`를 걸면 인덱스에
값이 물질화되고 `ANALYZE`가 그 식의 통계까지 만들어 준다(`CONCURRENTLY`면
테이블 재작성도 쓰기 차단도 없다). 배열 원소·임의 키 포함 검색이면 **GIN**
(`jsonb_ops`/`jsonb_path_ops`, `@>`). 그리고 한계를 붙인다 — 우회는 미리
정한 키만 빠르게 하므로, 조회 키가 늘면 그건 컬럼이어야 했던 것이다.

### "jsonb 안의 키 하나만 바꾸는 UPDATE는 싸지 않나요? PostgreSQL은 어차피 새 튜플이잖아요."

좋은 반문이고, 답은 **"새 튜플인 건 같지만 쓰는 양과 인덱스가 다르다"**다.
컬럼 하나를 바꾼 새 튜플은 행 폭만큼이고 안 바뀐 TOAST 값은 **포인터만
복사**되며 인덱스된 컬럼이 아니면 HOT이다. jsonb 내부 키 하나를 바꾸면
`jsonb_set`이 **새 문서 전체**를 만들고 → 새 튜플 + **새 TOAST 청크
전부** → 그 전부가 **WAL**(레플리카로도) → 옛 문서 전체가 **죽은 튜플**로
VACUUM 대기 — 재기록량이 문서 크기에 비례한다. 여기에 GIN·표현식 인덱스가
있으면 비-HOT이라 **모든 인덱스**에 새 엔트리다. 그래서 **jsonb 안에
카운터·상태 같은 잦은 부분 갱신 대상을 두지 않는다** — 가장 잦은 쓰기를
가장 비싼 방식으로 하는 조합이다. 통째로 읽고 통째로 쓰는 작은 문서(사용자
설정)는 어차피 전체 재기록이라 이 비용이 문제가 안 된다 — 그래서 jsonb에
맞는 것이다. 관찰은 `n_tup_hot_upd` 비율과 `n_dead_tup`.

### "1년 뒤 jsonb 안의 필드 이름을 바꿔야 합니다. 컬럼이면 RENAME 한 번인데, JSON은 뭐가 다른가요?"

컬럼은 카탈로그 한 번으로 **모든 행이 즉시 같은 형태**가 되지만, JSON은
DDL이 없는 대신 **옛 형태의 행이 영구 공존**한다. 이름 변경은 (a) 전 행
UPDATE — `SET doc = (doc - 'old') || jsonb_build_object('new', doc->'old')
WHERE doc ? 'old'`를 PK 범위로 배치 실행하는데, 행마다 문서 전체 재기록이라
대용량이면 그 자체가 WAL·bloat·VACUUM 부하 작업이거나, (b) 읽기 코드가 옛
이름·새 이름을 영원히 둘 다 이해하는 이중 읽기다. 즉 JSON은 스키마 변경
비용을 없앤 게 아니라 **DB의 DDL 한 번 → 애플리케이션의 모든 읽기 경로,
무기한**으로 옮긴 것이다. 감당하는 장치는 **`schema_version` 필드**(세대
표시 → 읽기 시 업캐스팅 → 쓰기는 최신 세대로 → 잔여분 배치 마이그레이션)와
**스키마 검증**(`CHECK` + jsonb 연산자, 기존 테이블엔 `NOT VALID` →
`VALIDATE`)이다. 버전 필드가 없으면 "지금 어떤 세대가 몇 건 남았는지"조차
셀 수 없다.

### "주니어가 '상품 속성은 카테고리마다 달라서 attrs jsonb에 다 넣겠다'는 PR을 올렸습니다. 어떤 질문을 던지시겠어요?"

체크리스트를 질문으로 바꾼다. ⑴ "이 속성들 중 **검색 필터·정렬·집계**에
쓰이는 게 있나요?" — 가격·브랜드·색상처럼 필터가 되는 것은 컬럼(또는
표현식 인덱스). ⑵ "**모든 상품이 갖는** 키가 있나요?" — 있으면 그건 컬럼.
⑶ "등록 후 **자주 바뀌는** 값이 있나요?" — 재고·판매 상태는 컬럼. ⑷ "다른
테이블을 **참조**하거나 **유일·필수**여야 하는 값이 있나요?" — 브랜드
ID·SKU는 컬럼/FK. 넷을 통과한 진짜 희소 속성(의류의 소재·세탁법, 가전의
소비전력)만 jsonb. 그리고 두 가지를 더 요구한다 — **검증**(어떤 키·타입이
허용되는지 `CHECK` 또는 DTO)과 **승격 규칙**("필터가 되는 순간 컬럼으로").
"GIN 걸면 검색은 되는데요"가 오면 — 검색 하나는 되지만 FK·부분 갱신·통계·
정렬은 그대로라고 짚는다. 이 질문 세트가 곧 "귀찮아서"와 "비정형이라"를
가르는 리뷰 기준이다.

### "결제 PG 원문 응답을 jsonb로만 저장했는데, CS팀에서 '승인번호로 검색'을 요구합니다. 어떻게 하시겠어요? 그리고 처음부터 어떻게 설계했어야 하나요?" (시니어 변별 포인트)

**지금**: 승인번호는 조회 키가 됐으니(⑴ 예) 승격한다. 가장 싼 경로는
**표현식 인덱스** — `CREATE INDEX CONCURRENTLY ... ON payment_approvals
((gateway_response->>'approvalNo'))`. 기존 행을 다시 쓰지 않고, 테이블
재작성도 없으며, `CONCURRENTLY`라 쓰기도 막지 않는다(트랜잭션 밖에서
실행해야 하고 실패하면 INVALID 인덱스를 지우고 재시도). 단 PG사마다 응답
필드명이 다르면 `COALESCE(resp->>'approvalNo', resp->>'approval_no')` 식이
되어 매칭이 깨지기 쉬우므로, 그 경우엔 nullable 정식 컬럼을 추가하고(카탈로그
변경만) 배치로 채운 뒤 일반 인덱스를 건다.

**처음부터**: **이중 저장**이 정답이었다 — 원문 `gateway_response`는
write-once 무손실 보존(스키마의 주인이 PG사, 분쟁 시 증거)으로 JSON이 맞고,
"받은 그대로"가 요구이므로 정규화하는 `jsonb`가 아니라 **`json`**(또는
`text`)으로. **우리가 조회·집계·정합성 검증에 쓰는 값**(거래 ID, 승인번호,
금액, 상태)은 저장 시점에 추출해 정식 컬럼으로 둔다. 트레이드오프 양면으로
말하면 — 대가는 "같은 값이 두 곳에 있는 중복"이지만, 원문은 갱신 경로가
없어 어긋날 수 없는 **스냅샷 성격의 중복**이라 동기화 장치가 필요 없다.
편익은 조회 키가 인덱스를 타고, 금액에 `numeric NOT NULL`, 거래 ID에
`UNIQUE`를 걸어 **불변식을 DB로 되돌린다**는 것. "JSON이냐 컬럼이냐"의
이분법이 아니라 **"원문 보존과 조회는 다른 요구이고, 다른 컬럼(다른
타입)이 맡는다"** 까지 가면 이 질문에서 변별된다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

판별 규율(네 질문·안전망)은 같고, 도구와 비용 구조 다섯 지점이 다르다.
① **타입과 문법** — MySQL은 `JSON` 타입 하나(바이너리)이고 경로를
`->>'$.genre'`처럼 JSON path 문자열로 쓴다. PostgreSQL은 `json`/`jsonb`
둘이고 `->>'genre'`·`#>>'{a,b}'`·`@>`·`?` 연산자에 jsonpath가 따로 있다.
② **인덱스 도구** — MySQL은 JSON 컬럼·식에 직접 인덱스를 못 걸어 VIRTUAL
생성 컬럼 + 인덱스(메타데이터 변경만이라 추가가 싸다)가 정석이고, 배열은
멀티밸류 인덱스. PostgreSQL은 표현식 인덱스(+ 표현식 통계)와, 키를 미리
정하지 않는 GIN이 있다 — 대신 STORED 생성 컬럼 추가는 테이블 재작성이다.
③ **부분 갱신** — MySQL 8.0은 `JSON_SET`/`JSON_REPLACE`/`JSON_REMOVE`가
크기가 늘지 않는 등 조건을 만족하면 **제자리 부분 갱신**을 하고 binlog도
부분 갱신 로그를 남길 수 있다(조건이 까다로워 설계 가정으로는 못 삼지만).
PostgreSQL은 MVCC라 예외 없이 **문서 전체가 새 튜플**이고 TOAST 청크까지
다시 쓴다 — 사슬 ②가 더 무겁다. ④ **스키마 검증** — MySQL은
`JSON_SCHEMA_VALID`로 JSON Schema를 `CHECK`에 바로 넣지만, PostgreSQL은
내장 함수가 없어 `CHECK` + jsonb 연산자 조합 또는 확장이다. ⑤ **통계** —
둘 다 내부 키 통계가 없어 추정이 상수인 것은 같지만, PostgreSQL은 표현식
인덱스가 그 식의 통계를 만들어 준다는 출구가 있다. 이 다섯을 짚으면
"jsonb 문법을 안다"가 아니라 "저장 구조에서 비용을 도출한다"로 들린다.

---

## 한 줄 요약

**jsonb 컬럼은 행마다 다른 데이터를 DDL 없이 담는 자유를 사는 대신
인덱스(정렬 사본에 값이 없어 Seq Scan + 키 탐색)·타입/제약(불변식이 앱
관례로 강등)·좁은 갱신(키 하나 바꿔도 문서 전체가 새 튜플 + TOAST + WAL +
죽은 튜플)·통계(내부 키 추정은 상수)를 반납하는 거래이므로, "조회·집계
대상인가 / 모든 행이 같은 키인가 / 부분 갱신이 잦은가 / DB가 지킬
불변식인가"에 하나라도 "예"면 컬럼이고, 넷 다 "아니오"인 외부 원문(바이트
보존이면 `json`)·희소 속성·통째로 읽고 쓰는 문서만 jsonb에 두되 — 조회
조건이 된 키는 표현식 인덱스(`CONCURRENTLY`, 통계까지 따라온다)나 GIN으로
승격하고, `CHECK` + jsonb 연산자(또는 DTO)로 검증하며, 버전 필드로 세대를
관리하는 안전망을 함께 든다. PostgreSQL은 도구가 풍부해서 "되니까 쓴다"의
유혹이 크다 — 되는 것과 써야 하는 것은 다르다.**
