# 대용량 유니크 채번 설계 — "주문번호"와 "PK"는 다른 물건이고, PostgreSQL의 시퀀스는 AUTO_INCREMENT가 아니다

> 핵심 관전 포인트: **채번 질문의 정답은 방식 이름이 아니라 요구사항을
> 쪼개는 순서다. 먼저 "내부 PK(조인·인덱스의 축)"와 "외부 주문번호(고객·
> CS·정산이 부르는 업무 식별자)"를 분리한다 — 두 식별자에 걸리는 요구가
> 다르기 때문이다. 내부 PK는 ① 작고(8바이트) ② 단조 증가해야 하는데,
> **PostgreSQL에서 이 두 원칙의 근거는 클러스터드 인덱스가 아니다.**
> 테이블은 힙이라 랜덤 PK에 무관하고, 아픈 곳은 **PK B-tree의 삽입
> 위치 · 자식 테이블의 FK 인덱스 · `full_page_writes`로 부푸는 WAL**이다.
> 후보는 `bigint GENERATED ALWAYS AS IDENTITY`(시퀀스) 또는 Snowflake.
> **PG의 시퀀스는 AUTO_INCREMENT와 결정적으로 다르다 — 테이블과 독립된
> 객체이고 트랜잭션 밖에서 동작해 `nextval()`을 INSERT 전에 미리 부를 수
> 있다.** 그래서 "Auto Increment 한계" 넷 중 하나(INSERT 전 ID 미확보)는
> PG에서 애초에 성립하지 않고 JPA 쓰기 지연 배치도 살아난다. 대신
> 비트랜잭션성의 대가로 **빈 번호가 정상**이고, `CACHE`가 세션별 블록을
> 선점해 발급 순서와 값의 대소가 어긋나며, 다중 노드 충돌은 그대로
> 남는다. UUID는 네이티브 `uuid` 16바이트 — v4는 힙이 아니라 PK B-tree를
> 앓고, v7은 그 사슬을 끊지만 16바이트라는 계수는 남는다. 외부
> 주문번호는 채번 테이블(+블록 할당, `UPDATE ... RETURNING`, 별도 짧은
> 트랜잭션)로 업무 의미를 담되 유니크 제약을 최후 방어선으로 둔다.
> 그리고 각 방식이 내는 대가 — 시퀀스의 단일 노드 의존과 연속 번호 노출,
> 채번 테이블의 핫 로우 직렬화·죽은 튜플·재기동 시 구멍, Snowflake의
> 시계 역행·워커 ID 배포, UUID v7의 크기와 생성 시각 노출 — 를 얻는 것과
> 같은 호흡에 붙여야 고난이도 답이 된다.**

---

## 0. 질문 + 의도

**질문**: "유니크 채번(주문번호 등)을 대용량 트래픽에서 어떻게
설계하나요? (Auto Increment 한계, Snowflake, 채번 테이블, UUID v7 비교)"

**PostgreSQL 기준 재해석**: "PG의 시퀀스(`GENERATED ALWAYS AS IDENTITY`)는
어디까지 되고 어디서 막히는가 — 비트랜잭션성·`CACHE`·다중 노드 충돌을
포함해 — 그리고 Snowflake·채번 테이블·`uuid`(v4/v7)와 어떻게 조합하는가?"

**출제 의도**: rationale은 이 문항을 이렇게 설명한다 — "Auto Increment의
한계(샤딩, 노출 위험)에서 출발해 Snowflake/UUID v7의 트레이드오프(정렬성,
인덱스 지역성)까지 — **작은 주제 하나에 분산 시스템 지식이 압축돼 있어
깊이 측정에 효율적이다.**" 채점 지점은 셋이다. ⑴ 각 방식이 "왜" 빠르고
"왜" 막히는지를 저장 구조(PG의 힙 + B-tree + WAL)와 분산 시스템(시계·조율)
두 층의 메커니즘으로 설명하는가 ⑵ 4방식을 같은 축으로 비교하고 각각의
대가를 붙이는가 ⑶ "주문번호"라는 단어에 숨은 두 요구(내부 식별 vs 외부
노출)를 분리해 설계로 착지시키는가.

**이 문서가 특히 겨냥하는 네 지점** (4장 기본 구간에서 반복된 패턴):

- **비용을 이름 붙은 사슬로** — "UUID는 인덱스에 안 좋다"에서 멈추지
  않는다. 무작위 키가 왜 랜덤 I/O와 WAL 증폭이 되고 단조 증가 키가 왜
  순차 I/O가 되는지, 채번 테이블이 왜 핫 로우가 되며 PG에서는 왜 죽은
  튜플까지 얹히는지, 시퀀스가 왜 단일 노드에 묶이는지를 고리 하나씩
  말한다(§1, §2).
- **트레이드오프를 양면으로** — 고난이도는 트레이드오프 서술이 곧 평가
  대상이다. 4방식 각각에 "얻는 것 / 내는 것"을 한 쌍으로 붙인다(§2 각 절
  말미의 대차대조표).
- **안전망을 코드로 고정** — 시계 역행 감지, 워커 ID 충돌 방지, 유니크
  제약 + 충돌 재시도, 시퀀스 소진 감시, 블록 할당의 구멍 허용 정책
  명문화, 동시성 채번 테스트 — "조심하면 된다"가 아니라 사람이 기억하지
  않아도 작동하는 코드로 둔다(§4).
- **목록 인출** — 4방식 비교표(축: 정렬성·분산성·크기·노출·의존성)와
  선택 기준 6가지를 세트로 꺼낸다(§3). 결론은 항상 "PK와 주문번호
  분리"로 착지한다(§4).

**옆 문항과의 경계**:
[클러스터드 vs 세컨더리 인덱스](./03-clustered-vs-secondary-index.md)는
PG의 힙 구조에서 PK 설계 2원칙(작게·단조 증가)을 **다시 도출**하고,
페이지 분할·shared_buffers 적재율·워킹셋·WAL 증폭의 사슬과 "곱셈 계수가
FK 인덱스로 자리를 옮겼다"는 계산을 다뤘다 — 이 문서는 그 원칙을
전제로 "그러면 어떤 채번 방식이 그 원칙을 만족하며 분산 환경까지
확장되는가"를 다룬다.
[대량 INSERT와 JDBC batch](../03-jpa-orm/21-bulk-insert-jdbc-batch.md)는
`IDENTITY` 전략이 쓰기 지연을 무력화하는 메커니즘과 `allocationSize`를
다뤘다 — 이 문서는 그 문서가 "정당한 경우"로 남겨 둔 **분산 ID가 실제
요구사항인 상황**의 설계이고, PG에서는 그 무력화를 **시퀀스 전략으로
피할 수 있다**는 점을 §2-1에서 짚는다. 두 문서의 내용은 링크로 갈음하고
반복하지 않는다.

---

## 1. 먼저 요구를 쪼갠다 — "유니크 채번"에 숨은 여섯 가지 성질

"주문번호를 어떻게 채번하나요"라는 질문에 방식 이름부터 대면 감점이다.
"유니크"는 최소 조건일 뿐이고, 실제 설계는 아래 여섯 성질 중 **무엇을
어디까지 요구하느냐**로 갈린다.

1. **유일성** — 전역에서 절대 겹치지 않는가. 겹치면 어디서 걸러지는가.
2. **정렬성(시간 순)** — 나중에 만든 ID가 더 큰가. **PG에서 이 성질이
   걸리는 곳은 테이블(힙)이 아니라 PK B-tree의 삽입 위치**와 "최근
   주문순" 정렬이다.
3. **분산 생성 가능성** — DB 한 대에 물어보지 않고 여러 인스턴스·여러
   리전·클라이언트에서 만들 수 있는가. 그리고 **INSERT 전에 ID를 알 수
   있는가** — PG에서는 이 둘이 갈라진다(§2-1).
4. **노출 안전성** — 외부에 보여도 다음 번호·총량·증가율·생성 시각이
   새지 않는가.
5. **크기** — 8바이트인가 16바이트인가 36바이트 문자열인가. InnoDB에서는
   PK가 모든 세컨더리 인덱스 리프에 복제되는 곱셈 계수였지만, **PG의
   인덱스 리프에는 PK가 아니라 TID(6바이트)가 들어간다.** 계수가 사라진
   게 아니라 **자식 테이블의 FK 컬럼과 FK 인덱스**로 자리를 옮겼다
   ([03 문서 §2-1](./03-clustered-vs-secondary-index.md)).
6. **업무 의미(가독성)** — 날짜·채널 코드·체크 디짓을 담아 사람이 읽고
   불러줄 수 있어야 하는가.

이 여섯을 놓고 보면 **한 컬럼으로 전부 만족시키는 방식은 없다**는 게
바로 보인다. 정렬성·크기는 내부 PK가 원하는 성질이고, 노출 안전성·업무
의미는 외부 식별자가 원하는 성질이다. 그래서 결론은 정해져 있다 —
**내부 PK와 외부 주문번호를 분리하고, 각자에게 맞는 채번을 붙인다.**
이 결론을 먼저 말하고, 4방식은 "각 자리에 어떤 후보가 어울리는가"를
따지는 재료로 쓴다.

### 1-1. 등장인물의 이름을 먼저 고정한다 — 순차 I/O, 워킹셋, 그리고 WAL

이 문서 전체를 관통하는 비용 모델이라 여기서 한 번 못 박는다. 앞의 넷은
DB 공통이고, **다섯째는 PostgreSQL 고유 항목**이다.

- **순차 I/O**: 디스크(또는 SSD 블록)의 **이웃한 페이지를 이어서** 읽고
  쓰는 접근. 한 번 움직여 큰 덩어리를 처리하므로 페이지당 비용이 작다.
- **랜덤 I/O**: **흩어진 위치를 하나씩** 찾아가 읽고 쓰는 접근. 페이지
  한 장마다 위치 이동 비용을 따로 낸다. 플래너의 비용 모델에서도 이
  차이가 `random_page_cost` 4.0 대 `seq_page_cost` 1.0으로 박혀 있다.
- **shared_buffers**: PG가 디스크 페이지를 담아두는 고정 크기 메모리
  캐시(기본 128MB). 뒤에 OS 페이지 캐시가 한 겹 더 있는 이중 캐시다.
  여기 있으면 `Buffers: shared hit`, 없으면 `shared read` = 디스크 I/O.
- **워킹셋**: 어떤 부하를 처리하는 동안 실제로 손대는 페이지들의 집합.
  캐시가 **공급**이라면 워킹셋은 **수요**이고, 워킹셋이 캐시를 넘는
  순간 성능이 선형이 아니라 **계단식으로** 무너진다.
- **WAL과 `full_page_writes`(PG 고유)**: 모든 페이지 변경은 먼저 WAL에
  기록되는데, **체크포인트 이후 어떤 페이지를 처음 건드릴 때는 변경분이
  아니라 8KB 페이지 전체 이미지(FPI)** 가 실린다. 같은 페이지를 계속
  건드리면 FPI는 한 번, **매번 다른 페이지를 건드리면 매번 FPI**다.
  채번 방식이 WAL 볼륨을 좌우하는 통로가 바로 이것이다.

이제 질문은 이렇게 바뀐다 — **"이 채번 방식이 만드는 INSERT의 워킹셋은
몇 페이지이고, 그 INSERT는 WAL에 페이지 이미지를 몇 번 싣는가."**

---

## 2. 4방식의 메커니즘과 대차대조표

### 2-1. 시퀀스 / `IDENTITY` — DB 한 대의 카운터, 단 테이블 밖에 있는 객체

**메커니즘.** PG의 자동 증가는 컬럼의 속성이 아니라 **독립된 시퀀스
객체**다. 표준 문법인 `GENERATED ALWAYS AS IDENTITY`를 쓰면 컬럼에 딸린
시퀀스가 자동으로 만들어지고 소유권까지 묶인다.

```sql
-- ✅ 신규 설계의 기본형 (PG 10+ 표준 문법)
CREATE TABLE orders (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 구식: serial / bigserial — "bigint + 시퀀스 + DEFAULT nextval()"의 축약.
--   소유권·권한·DDL에서 잔손질이 필요해 신규 설계에서는 IDENTITY를 쓴다.

-- 앱이 값을 미리 받아 명시적으로 넣어야 한다면(§아래 '반전') 독립 시퀀스로 둔다
CREATE SEQUENCE orders_id_seq AS bigint;
ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
```

> **함정 하나 — `ALWAYS`와 `BY DEFAULT`.** `GENERATED ALWAYS`는 앱이
> `id`를 직접 넣는 INSERT를 **거부한다**(`OVERRIDING SYSTEM VALUE`를
> 붙여야 통과). 데이터 이관이나 JPA 시퀀스 전략처럼 앱이 값을 들고
> 들어오는 구조라면 `GENERATED BY DEFAULT AS IDENTITY`이거나 독립
> 시퀀스여야 한다. 이걸 모르고 `ALWAYS`로 만들면 이관 스크립트가
> 통째로 막힌다.

**왜 순차 I/O가 되는가 — 사슬로.**

> 새 PK가 항상 최댓값이다 → PK B-tree에서 삽입 위치는 **항상 맨 오른쪽
> 리프 한 장**이다 → 그 페이지는 방금 만졌으니 shared_buffers에 반드시
> 있다(캐시 미스 0) → 페이지가 fillfactor(B-tree 기본 90)까지 차면
> 반으로 가르는 게 아니라 **오른쪽에 새 페이지를 이어 붙인다**(끝 삽입
> 최적화 — 중간 삽입만 반반 분할이다) → 같은 리프를 수백 번 건드리는
> 동안 **FPI는 체크포인트당 한 번**이라 WAL 볼륨이 얌전하다 → 힙 쪽은
> 애초에 PK와 무관하게 FSM이 가리키는 끝 페이지 한두 장이다 → 결과적으로
> INSERT의 워킹셋은 "맨 끝 리프 몇 장 + 루트에서 거기까지의 브랜치 경로"
> 뿐이라, **shared_buffers가 테이블보다 훨씬 작아도 INSERT 처리량이
> 유지**된다.

접수창구 비유 — 서류를 늘 서류철 **맨 뒤에 끼우니** 서류철을 열어볼
필요도, 중간을 벌릴 필요도, 통째로 복사기에 올릴 필요도 없다.

#### 반전 — PG에서는 "INSERT 전에 ID를 알 수 없다"가 성립하지 않는다

여기가 이 문항을 MySQL 기준으로 외운 사람과 갈리는 지점이다. 시퀀스는
테이블 밖의 독립 객체이므로 **INSERT와 무관하게 `nextval()`을 먼저 부를
수 있다.**

```sql
SELECT nextval('orders_id_seq');   -- 1042  ← 아직 어떤 행도 만들지 않았다
-- 이 값을 이벤트 발행·멱등 키·로그 상관관계에 먼저 쓰고, INSERT는 나중에
INSERT INTO orders (id, ...) VALUES (1042, ...);
```

그 결과가 JPA에서 그대로 이득이 된다. `GenerationType.IDENTITY`는 키를
받으려고 `persist()` 시점에 INSERT를 즉시 날려 **쓰기 지연 배치를
무력화**하지만, PG에서는 `GenerationType.SEQUENCE` +
`allocationSize`(pooled 최적화)로 **채번을 미리 받아 두고 INSERT를 뒤로
미룰 수 있다** — 배치가 산다(메커니즘 상세는
[bulk-insert 문서 §4-1](../03-jpa-orm/21-bulk-insert-jdbc-batch.md)).

```java
// ✅ PG에서 배치를 살리는 매핑 — 시퀀스에서 50개씩 받아 메모리에서 나눠 쓴다
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "orders_seq")
@SequenceGenerator(name = "orders_seq", sequenceName = "orders_id_seq",
                   allocationSize = 50)
private Long id;
```

```sql
-- 짝이 되는 DDL — INCREMENT BY 가 allocationSize 와 같아야 한다
CREATE SEQUENCE orders_id_seq AS bigint INCREMENT BY 50;
```

> **여기서 가장 흔한 사고 (가산점 포인트).** `allocationSize = 50`인데
> DDL을 `INCREMENT BY 1`로 만들어 두면, 하이버네이트는 "받은 값이 50개
> 블록의 끝"이라고 가정하고 값을 나눠 주므로 **인스턴스 두 대가 같은
> 번호를 발급한다.** 하이버네이트 6에는 이 불일치를 기동 시 알려주는
> 설정(`hibernate.id.sequence.increment_size_mismatch_strategy`)이 있지만
> 기본 동작은 버전마다 다르니 **DDL과 `allocationSize`를 같은 PR에서
> 함께 바꾸는 규칙**으로 고정하는 편이 안전하다.

#### 비트랜잭션성 — 빈 번호는 버그가 아니라 성질이다

`nextval()`은 **트랜잭션 밖에서** 동작한다. 롤백해도 소모된 값은 돌아오지
않고, 두 세션이 동시에 불러도 서로 기다리지 않는다(그래서 빠르다).

```sql
BEGIN;
SELECT nextval('orders_id_seq');   -- 101
ROLLBACK;
SELECT nextval('orders_id_seq');   -- 102  ← 101은 영원히 비어 있다
```

빈 번호가 생기는 경로는 넷이다. ⑴ 롤백·에러 ⑵ `INSERT ... ON CONFLICT
DO NOTHING`처럼 **행이 안 들어가도 DEFAULT의 `nextval()`은 먼저
평가**되어 소모(대량 UPSERT의 단골 —
[32 문서](./32-bulk-upsert-side-effects.md)) ⑶ `CACHE` 선점분이 세션
종료로 폐기 ⑷ 크래시 — PG는 성능을 위해 시퀀스 값을 **일정 개수 단위로
미리 WAL에 기록**해 두므로, 크래시 후 재시작하면 번호가 앞으로 건너뛸 수
있다. **즉 시퀀스로는 gapless(빈 번호 없음)를 보장할 수 없다.**

#### `CACHE` — 성능을 사면 전역 순서를 내준다

```sql
ALTER SEQUENCE orders_id_seq CACHE 20;
-- 세션 A: nextval → 1   (A가 1~20을 선점해 자기 메모리에 들고 있다)
-- 세션 B: nextval → 21  (B는 21~40을 선점)
-- A: 2, 3, 4 …          B: 22, 23 …
--   → 시간상 나중인 B의 22가 A의 5보다 크다. 발급 순서 ≠ 값의 대소.
--   → A가 4까지 쓰고 종료하면 5~20은 버려진다(구멍).
```

`CACHE`는 **DB가 대신 해 주는 블록 할당(hi/lo)**이다. 시퀀스 객체 방문
횟수를 1/N로 줄여 경합과 WAL 기록을 줄이지만, 그 대가로 **세션 간 발급
순서가 교차**하고 구멍이 커진다. 채번 테이블에서 우리가 직접 짜야 했던
트레이드오프(§2-2)가 PG에는 **설정 한 줄로 내장돼 있다** — 기본값은 1이라
안전 쪽에 서 있고, 초당 삽입이 아주 많을 때만 올린다.

#### 어디서 막히는가 — 단일 노드 의존의 사슬

> 시퀀스는 **그 데이터베이스 안의 객체**다 → 값을 받으려면 그 인스턴스에
> 질의해야 한다 → ⑴ DB를 샤딩하면 샤드마다 시퀀스가 따로 돌아 **같은
> 값이 여러 샤드에서 나온다** ⑵ 다중 마스터는 `INCREMENT BY n` +
> `START WITH k`로 노드별 잔여류를 갈라 쓸 수 있지만(아래) 노드 수를
> 미리 박아야 하고 늘리기 어렵다 ⑶ 쓰기 처리량의 상한이 "그 한 대"의
> 상한이다 ⑷ 클라이언트·오프라인 기기에서 미리 만들 수 없다.

```sql
-- 노드 2대를 짝수/홀수로 가르기 (MySQL auto_increment_increment/offset의 PG 판)
-- 노드 1:  CREATE SEQUENCE orders_id_seq INCREMENT BY 2 START WITH 1;
-- 노드 2:  CREATE SEQUENCE orders_id_seq INCREMENT BY 2 START WITH 2;
-- 대가: 노드 수가 스키마에 박힌다. 3대로 늘리려면 전 노드 시퀀스를 재설계.
```

**(가산점 포인트) 복제·이관에서 시퀀스가 사라지는 사고.** 스트리밍(물리)
복제는 바이트 단위 복제라 시퀀스 상태까지 그대로 따라오지만, **논리
복제는 시퀀스를 복제하지 않는다.** 논리 복제로 새 클러스터에 이관하고
전환할 때 `setval()`로 시퀀스를 앞당겨 놓지 않으면, 새 프라이머리가
1번부터 다시 발급해 **PK 중복 폭탄**이 터진다. 전환 체크리스트에 "모든
시퀀스 `setval` 확인"을 넣는 것이 정석이다.

**노출 위험.** 값이 연속이라 외부에 보이면 ⑴ 하루 주문량·증가율이
그대로 새고 ⑵ `/orders/10231` 다음은 `10232`라고 누구나 추측할 수
있어 권한 검사가 한 곳이라도 빠지면 남의 주문이 열린다(IDOR). 이건
시퀀스의 결함이 아니라 **내부 PK를 외부에 그대로 노출한 설계의
결함**이다 — 그래서 분리가 결론이다.

**타입 고갈도 노출 못지않은 실무 사고다.** `serial`(int, 최대
21억)로 만든 PK는 UPSERT가 충돌할 때마다도 값을 소모하므로 행 수보다
훨씬 빨리 마른다. 마르는 순간 모든 INSERT가
`ERROR: nextval: reached maximum value of sequence` 로 죽고, `int` →
`bigint` 타입 변경은 테이블 재작성 + `ACCESS EXCLUSIVE` 잠금이다
([14 문서](./14-online-ddl-zero-downtime-schema-change.md)). 신규 PK는
무조건 `bigint`, 그리고 §4-5의 소진 감시 쿼리를 대시보드에 건다.

> **MySQL 대조.** AUTO_INCREMENT는 **테이블의 속성**이라 값을 미리 받을
> 수 없고(그래서 "INSERT 전 ID 미확보"가 진짜 한계다), 카운터가 메모리에
> 있어 8.0 이전에는 재기동 시 `MAX(id)+1`로 재계산돼 **지웠던 끝 번호가
> 재사용**되는 함정이 있었다(8.0부터 영속). 동시 삽입 시에는
> `innodb_autoinc_lock_mode` 설정에 따라 짧은 뮤텍스 또는 테이블 수준
> AUTO-INC 락을 잡는다. PG는 시퀀스가 별도 객체라 이 락 모드 논의 자체가
> 없고, 대신 **비트랜잭션성·`CACHE`·`setval`** 이라는 다른 어휘를 쓴다.

**대차대조표.**

- 얻는 것: 8바이트, 완전한 단조 증가(순차 I/O, FPI 최소), 외부 의존성 0,
  구현 0, **INSERT 전 채번 가능(JPA 배치 유지)**, 여러 앱 인스턴스가
  같은 시퀀스를 공유해도 문제없음.
- 내는 것: 단일 DB 의존(샤딩·다중 리전·클라이언트 생성 불가), 빈 번호
  (gapless 불가), `CACHE`를 올리면 세션 간 순서 교차, 연속 번호 노출
  위험, 논리 복제·이관 시 `setval` 누락 사고, 타입을 `int`로 고르면 고갈.

**언제 정답인가.** DB가 한 대(+레플리카)이고 ID를 외부에 직접 노출하지
않는다면 **여전히 첫 번째 정답**이다. "요즘은 다 Snowflake 쓰지
않나요"에 흔들리지 않는 것이 시니어다 — 인프라를 늘리지 않고 되는 일을
늘려서 하지 않는다. 게다가 PG에서는 시퀀스가 "INSERT 전 채번"까지
해 주므로, MySQL에서라면 Snowflake로 넘어갈 이유 하나가 여기서 사라진다.

### 2-2. 채번 테이블(+블록 할당) — 핫 로우를 어떻게 식히는가

**메커니즘.** `id_sequences(seq_name, next_val)` 같은 테이블에 이름별
카운터 행을 두고, 채번할 때마다 그 행을 `UPDATE ... SET next_val =
next_val + 1`로 밀어 값을 받는다. 날짜별로 행을 따로 두면
`20260901-000123` 처럼 **매일 1번부터 다시 시작하는 업무 번호**를 만들 수
있다.

> **PG에서 이 방식의 존재 이유는 "분산"이 아니다.** MySQL에서는 채번
> 테이블이 "여러 앱 인스턴스가 INSERT 전에 ID를 받는" 유일한 길이었지만,
> PG에서는 시퀀스가 이미 그 일을 한다(§2-1). 그래서 PG에서 채번 테이블이
> 남는 자리는 딱 하나 — **시퀀스가 못 하는 포맷 요구**다. 날짜별 리셋,
> 채널별 접두어, 체크 디짓처럼 "값 자체에 업무 의미를 담아야 하는" 외부
> 식별자. 이 경계를 먼저 말하고 들어가야 "옛날 패턴을 습관으로 쓴다"로
> 들리지 않는다.

**왜 병목이 되는가 — 핫 로우 사슬.** 이 사슬을 "성능 저하"나 "락 경합"
한 단어로 뭉뚱그리지 않는다.

> 모든 요청이 **같은 한 행**을 UPDATE한다 → PG는 그 행의 튜플 헤더
> `xmax`에 자기 트랜잭션 ID를 적어 배타 락을 표시한다 → 이 락은 문장이
> 끝나도 풀리지 않고 **트랜잭션이 커밋될 때까지** 유지된다 → 채번을 주문
> 트랜잭션 안에서 했다면, 주문 저장·재고 차감·외부 결제 호출이 끝날 때까지
> 다음 주문은 채번 행 앞에서 **줄을 선다**(대기자는 `pg_stat_activity`에서
> `wait_event_type = 'Lock'`, `wait_event = 'transactionid'`로 보인다) →
> 채번 처리량의 상한 = 1 / (주문 트랜잭션 한 건의 길이) → 대기 중인
> 요청은 각자 **커넥션을 쥔 채** 기다리는데 **PG의 커넥션은 스레드가
> 아니라 OS 프로세스**라 이 점유가 더 비싸다 → 커넥션 풀이 마르고 채번과
> 무관한 API까지 지연이 번진다 → 락 대기와 데드락(채번 행 + 다른 행을
> 서로 반대 순서로 잡을 때)이 섞여 터진다.

**PG에는 고리가 하나 더 붙는다 — 죽은 튜플.** PG의 UPDATE는 제자리
갱신이 아니라 **새 튜플 버전을 만들고 옛 버전을 죽은 튜플로 남기는**
것이다. 초당 수천 번 갱신되는 채번 행은 그 페이지에 죽은 튜플을 계속
쌓고, autovacuum이 추격에 실패하면 페이지가 부풀어 한 행 읽는 데 여러
페이지를 훑게 된다. 다행히 채번 테이블은 **HOT(Heap-Only Tuple) 업데이트
조건을 만족한다** — 바뀌는 `next_val`은 어떤 인덱스에도 들어 있지 않으므로
(인덱스는 `seq_name` PK뿐) 같은 페이지에 여유만 있으면 인덱스를 하나도
건드리지 않는다. 그래서 처방이 하나 더 생긴다: **`fillfactor`를 낮춰
새 버전이 들어갈 자리를 미리 비워 둔다.**

```sql
CREATE TABLE id_sequences (
    seq_name text   PRIMARY KEY,
    next_val bigint NOT NULL
) WITH (fillfactor = 70);      -- 같은 페이지 안에 새 버전 자리를 남긴다 → HOT 유지

-- 확인: HOT 비율이 떨어지면 인덱스까지 갱신되고 있다는 뜻
SELECT relname, n_tup_upd, n_tup_hot_upd, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'id_sequences';
```

같은 사슬이 조회수 카운터에서 어떻게 나타나는지는
[초고빈도 카운터와 핫 로우](./23-high-frequency-counter-hot-row.md)가 다룬다 —
채번 테이블은 "정확해야 하는 숫자"라서 그 문서의 처방(근사·비동기 집계)을
쓸 수 없고, 대신 아래 두 처방으로 락 보유 시간과 방문 횟수를 줄인다.

**처방 두 가지 — 둘 다 해야 한다.**

⑴ **채번 트랜잭션을 분리해 짧게 잡는다.** 채번은 `REQUIRES_NEW`로 별도
트랜잭션에서 UPDATE 한 문장만 실행하고 즉시 커밋한다. 락 보유 시간이
"주문 처리 전체"에서 "UPDATE 한 문장 + 커밋"으로 줄어든다. PG에서는
`SELECT ... FOR UPDATE` 없이 **`UPDATE ... RETURNING` 한 문장**으로 값을
받아온다 — 조회와 갱신 사이의 경쟁 구간 자체가 사라진다 (가산점 포인트).

⑵ **블록 할당(hi/lo).** 한 번 다녀올 때 1이 아니라 N개(예: 500)를
선점하고, 나머지는 인스턴스 메모리에서 나눠 준다. 채번 행 방문 횟수가
1/N이 되고, 핫 로우의 경합도 그만큼 준다. JPA의 `@TableGenerator` +
`allocationSize`가 이 방식이고, **PG 시퀀스의 `CACHE`도 원리가 같다**
(§2-1) — 다른 점은 블록 크기와 구멍 정책을 우리가 통제한다는 것뿐이다.

```java
// ❌ before: 주문 트랜잭션 안에서 채번 행을 잡는다 — 락이 주문 처리 끝까지 산다
@Transactional
public Order place(PlaceOrderCommand cmd) {
    long seq = jdbc.queryForObject(
        "SELECT next_val FROM id_sequences WHERE seq_name = 'order' FOR UPDATE",
        Long.class);
    jdbc.update("UPDATE id_sequences SET next_val = ? WHERE seq_name = 'order'", seq + 1);
    // ↓ 재고 차감·결제 승인(외부 HTTP)·주문 저장이 끝나 커밋될 때까지
    //   다른 모든 주문이 id_sequences 행 앞에서 대기한다 → 커넥션 풀 고갈로 번진다
    inventory.reserve(cmd);
    payment.approve(cmd);
    return orderRepository.save(Order.of(cmd, seq));
}

// ✅ after: 블록 할당 + 별도 짧은 트랜잭션 — 락 보유 = UPSERT 한 문장
@Component
public class SequenceBlockAllocator {

    // 행이 없으면 만들고, 있으면 블록만큼 밀어서, 시작값을 한 문장으로 돌려받는다
    private static final String ALLOCATE = """
        INSERT INTO id_sequences (seq_name, next_val) VALUES (?, ?)
        ON CONFLICT (seq_name)
        DO UPDATE SET next_val = id_sequences.next_val + EXCLUDED.next_val
        RETURNING next_val - ? AS block_start
        """;

    @Transactional(propagation = Propagation.REQUIRES_NEW)   // 바깥과 분리, 즉시 커밋
    public long allocate(String name, int blockSize) {
        return jdbc.queryForObject(ALLOCATE, Long.class, name, blockSize, blockSize);
        // 최초 삽입이면 next_val = blockSize → 블록 [0, blockSize)
        // 충돌이면   next_val = 기존 + blockSize → 블록 [기존, 기존 + blockSize)
    }
}
```

`ON CONFLICT`가 "행이 없으면 만들고 있으면 민다"를 **한 문장·한 왕복**으로
끝내는 것이 PG판의 핵심이다. MySQL 예제에서 `INSERT IGNORE` → 재귀 호출로
풀던 자리가 통째로 사라졌다.

**블록 할당이 새로 지불하는 대가 — 반드시 같은 호흡에.**

- **재기동하면 구멍이 난다.** 인스턴스가 500개를 선점하고 120개 쓴 뒤
  재배포되면 380개는 버려진다. 인스턴스가 10대면 배포 한 번에 최대
  수천 개가 빈다. **"주문번호는 연속이 아니다"를 정책으로 명문화**해야
  한다 — 회계·CS·정산 담당자가 "번호가 비었는데 주문이 유실된 것 아니냐"고
  묻는 순간이 반드시 온다. 연속성이 진짜 규제 요건(예: 일부 국가의 세금
  계산서 일련번호)이라면 이 방식은 쓸 수 없고 건별 채번 + 짧은 트랜잭션으로
  돌아가 처리량을 포기해야 한다. 이 선택을 ADR 한 장으로 남긴다.
- **인스턴스 간 순서가 섞인다.** A가 [0,500), B가 [500,1000)을 들고
  있으면 시간상 나중인 A의 3번이 B의 501번보다 작다. "번호 순 = 시간
  순"이 아니다. 시간 순 정렬은 `created_at`으로 한다. (시퀀스 `CACHE`가
  내는 대가와 정확히 같은 성질이다.)
- **채번 테이블이 가용성 결합점이다.** 그 행이 잠기거나 그 DB가 죽으면
  채번이 멈춘다. 블록이 클수록 방문이 드물어 버티는 시간이 길어진다 —
  블록 크기는 "재기동 시 버릴 수 있는 양"과 "DB 장애 시 버틸 시간"의
  거래다.

> **MySQL 대조.** MySQL에는 `RETURNING`이 없어(최근 MariaDB 계열 제외)
> `UPDATE id_sequences SET next_val = LAST_INSERT_ID(next_val + ?)` 뒤에
> `SELECT LAST_INSERT_ID()`를 붙이는 관용구로 같은 일을 한다. 세션 변수를
> 경유하는 트릭이라 커넥션 풀·프록시에서 세션이 바뀌면 깨질 수 있는데,
> PG의 `RETURNING`은 문장 자체가 값을 돌려주므로 그 위험이 없다.

**대차대조표.**

- 얻는 것: 업무 의미(날짜별 리셋·채널·접두어·체크 디짓) 자유, INSERT 전
  ID 확보, DB 외 인프라 0, 포맷을 원하는 대로.
- 내는 것: 핫 로우(분리 트랜잭션 + 블록 + `fillfactor`로 완화), 죽은
  튜플·autovacuum 부담, 재기동 시 구멍, 인스턴스 간 순서 교차, 채번
  테이블 가용성 의존, 연속 노출 시 추측 위험은 그대로. **그리고 PG에서는
  "분산 생성"이 더 이상 이 방식만의 장점이 아니다.**

### 2-3. Snowflake — 시계와 워커 ID로 조율 없이 만든다

**메커니즘.** 64비트 정수 하나를 세 조각으로 나눈다.

```text
| 1비트 | 41비트 타임스탬프(ms, 서비스 에포크 기준) | 10비트 워커 ID | 12비트 시퀀스 |
  부호     약 69년                                    1024대            ms당 4096개
```

각 서버가 **자기 시계 + 자기 워커 ID + 같은 ms 안의 카운터**로 로컬에서
만들므로 DB 왕복도, 서버 간 합의도 없다. 상위 비트가 시간이라 **거의
단조 증가**하고, `bigint` 한 칸에 들어간다.

**왜 PG의 PK로도 좋은가.** 시간이 상위 비트이므로 새 ID는 거의 항상 PK
B-tree의 오른쪽 끝 근처에 꽂힌다. 워커가 여럿이라 같은 ms 안에서는 워커
ID 순으로 살짝 섞이지만, 그 섞임은 **맨 끝 페이지 몇 장 안**에서 일어난다
— 워킹셋도, 체크포인트당 FPI 수도 시퀀스와 거의 같다. 크기도 8바이트라
자식 테이블 FK 컬럼·FK 인덱스에 얹히는 계수가 `IDENTITY`와 동일하다.
즉 **분산 생성을 얻으면서 순차 I/O와 WAL 효율을 거의 포기하지 않는다.**
이것이 Snowflake가 대용량에서 표준 답이 된 이유다.

**어디서 위험한가 — 두 가지 의존.**

⑴ **시계 의존.** 유일성이 "같은 워커에서 시간은 뒤로 가지 않는다"에
걸려 있다. NTP가 시계를 뒤로 맞추거나, VM 마이그레이션·절전 복귀로
시계가 튀면 **이미 발급한 ms로 되돌아가 같은 ID를 다시 만들 수 있다.**
따라서 발급기는 마지막 발급 시각을 기억하고 **역행을 감지해야** 한다 —
작은 역행(수 ms)은 기다리고, 큰 역행은 발급을 거부한다(§4-2 코드).

⑵ **워커 ID 배포.** 두 서버가 같은 워커 ID를 들면 같은 ms에 같은 ID가
나온다. 오토스케일링·컨테이너 환경에서 "설정 파일에 1, 2, 3 적어두기"는
배포 한 번에 무너진다. 워커 ID는 **중앙에서 유일하게 임대**해야 한다 —
DB 테이블에 기동 시 INSERT해 받은 값(§4-3), K8s StatefulSet의 순번,
ZooKeeper 순차 노드, Redis `SETNX` 임대 + 하트비트 등. 어느 것이든
"프로세스가 죽으면 회수, 살아 있으면 갱신"이 있어야 재사용 충돌이 없다.

**그 밖의 대가.**

- **생성 시각이 값에 드러난다.** 상위 41비트를 풀면 ms 단위 생성 시각이
  나온다. 시퀀스 비트로 "그 ms에 몇 건"도 어느 정도 읽힌다. 총량 추측은
  연속 번호보다 훨씬 어렵지만 "언제 만들었는지도 숨겨라"는 요건이면
  부적합하다.
- **전역 순서는 ms 단위 근사다.** 워커 간 시계가 몇 ms 어긋나면 나중에
  만든 ID가 더 작을 수 있다. "ID 순 = 정확한 시간 순"으로 커서 페이지네이션을
  짜면 경계에서 건너뛰기가 생긴다([13 문서](./13-deep-pagination-offset-vs-cursor.md)).
- **에포크를 한 번 정하면 바꿀 수 없다.** 41비트는 에포크로부터 약 69년이다.
- **JSON 직렬화 함정.** 64비트 정수는 JavaScript `Number`의 안전 범위(2^53)를
  넘는다. API 응답에서는 **문자열로** 내보내야 끝자리가 뭉개지지 않는다
  (가산점 포인트).
- **업무 의미는 없다.** 사람이 읽거나 불러줄 수 없다.

**대차대조표.**

- 얻는 것: 8바이트, 거의 단조 증가(순차 I/O·FPI 효율 유지), 조율 없는
  분산 생성, INSERT 전 ID 확보, 초당 워커당 수백만 개, DB 왕복 0.
- 내는 것: 시계 역행 감지 의무, 워커 ID 임대 인프라, 생성 시각 노출,
  ms 단위 근사 순서, 에포크 고정, 문자열 직렬화, 업무 의미 없음.

### 2-4. UUID — PG는 네이티브 16바이트, v4가 아픈 곳은 힙이 아니라 PK B-tree다

**먼저 저장 타입.** PG에는 `uuid` 타입이 있다 — **16바이트 고정, 비교는
바이트 비교**다. 문자열로 저장하면 `varchar(36)`은 36바이트에 더해 비교가
**collation 규칙을 타서** 정수 비교보다 훨씬 비싸다. UUID를 쓰기로 했다면
타입 선택은 논쟁거리가 아니라 전제다.

```sql
-- ❌ 36바이트 + collation 비교. 인덱스도 힙도 2배 이상으로 부푼다
id varchar(36) PRIMARY KEY
-- ✅ 16바이트 네이티브
id uuid PRIMARY KEY DEFAULT gen_random_uuid()   -- gen_random_uuid()는 v4 (PG 13+ 내장)
```

**v4가 왜 문제인가 — 이 문서에서 가장 중요한 사슬.** UUID v4는 128비트
중 대부분이 난수다. PG에서 이 값을 PK로 쓰면 **힙은 멀쩡한데 PK B-tree가
앓는다.**

> **힙은 무관하다.** 새 행은 FSM이 가리키는 빈 공간(대개 파일 끝)에
> 들어간다 — PK가 `bigint`든 `uuid`든 힙 쪽 워킹셋은 끝 페이지 한두 장으로
> 같다. "PG는 클러스터드가 아니라서 UUID에 강하다"는 여기까지만 맞다.
> **문제는 삽입 위치를 값이 결정하는 구조가 하나 남아 있다는 것 — PK
> B-tree, 그리고 그 값을 받는 자식 테이블의 FK 인덱스들이다.**
>
> 새 PK가 무작위다 → 삽입 지점이 **트리 전역에 흩어진다** → 대상 리프가
> shared_buffers에 있을 확률은 (캐시 크기 / 인덱스 크기)에 불과하다 →
> 인덱스가 캐시보다 커지는 순간부터 **INSERT 한 건마다 대상 페이지를
> 디스크에서 먼저 읽어 와야 쓸 수 있다**(쓰기가 랜덤 읽기 I/O를 유발) →
> 대상 페이지가 가득 차 있으면 끝 삽입처럼 이어 붙이는 게 아니라 **반반
> 페이지 분할**(쪼개고, 새 페이지를 파일 끝에 붙이고, 부모에 분리 키
> 추가) → 반쯤 빈 페이지가 전역에 쌓여 **인덱스 bloat** → 같은 엔트리
> 수에 페이지가 더 필요해 적재율이 더 떨어지는 악순환 → 새 페이지가 파일
> 끝에 붙으니 **논리 순서와 물리 순서가 어긋나** 범위 스캔이 순차에서
> 랜덤으로 전락 → 결정적으로 **WAL 증폭**: 매 INSERT가 체크포인트 이후
> 처음 건드리는 리프일 확률이 높아 `full_page_writes`로 **INSERT 한 건에
> 8KB 페이지 이미지 하나씩** WAL에 실린다(단조 증가라면 같은 리프를 수백
> 번 건드리는 동안 FPI는 한 번) → WAL 볼륨↑ → 체크포인트 I/O↑ → 복제
> 지연↑ → 아카이브 비용↑.

이 사슬을 "인덱스가 깨진다", "정렬이 안 돼서 느리다"로 줄이면 기본
문항에서 했던 뭉뚱그리기의 반복이다. 고리를 다 말해야 한다 — **무작위
위치 → 캐시 미스 → 페이지 분할 → 적재율 저하 → 랜덤 I/O → WAL FPI 증폭.**
관찰은 `EXPLAIN (ANALYZE, WAL)`의 `WAL: fpi=`와 `pg_stat_wal`(PG 14+)의
`wal_fpi`로 한다.

**크기 계수는 어디에 남는가.** InnoDB처럼 "세컨더리 인덱스 개수만큼
곱해지는" 일은 PG에 없다 — 인덱스 리프에는 PK가 아니라 TID(6바이트)가
들어가기 때문이다. 대신 계수가 **자식 테이블의 FK 컬럼과 FK 인덱스**로
옮겨간다. 엔트리 크기로 계산하면 그대로 드러난다
([03 문서 §2-1](./03-clustered-vs-secondary-index.md)):

| `order_items.order_id` FK 인덱스 | `bigint` | `uuid` |
|---|---|---|
| 엔트리 하나 (라인 포인터 4B + 인덱스 튜플 헤더 8B + 키) | 20B | 28B |
| 8KB 페이지당 엔트리 수 (fillfactor 90) | ≈ 366개 | ≈ 262개 |

같은 shared_buffers에 담기는 **행의 수가 28% 줄어든다.** 자식 테이블이
셋이면 이 일이 세 벌 일어나고, 힙의 FK 컬럼 자체도 8B → 16B로 늘어난다.
"2배"가 아니라 "1.4배 안팎"인 이유는 헤더와 라인 포인터가 차이를
희석하기 때문인데, 방향은 바뀌지 않는다. (PG 13부터 B-tree는 중복 키를
posting list로 묶는 dedup을 하지만 **유니크한 무작위 키에는 도움이 안
된다.**)

**v7은 무엇을 고쳤는가.** RFC 9562의 UUID v7은 앞 48비트를 Unix ms
타임스탬프로, 나머지를 버전·변형 비트와 난수로 채운다.

```text
| 48비트 unix_ts_ms | 4비트 ver(7) | 12비트 rand_a | 2비트 var | 62비트 rand_b |
```

상위 비트가 시간이므로 삽입 위치가 Snowflake처럼 **오른쪽 끝 근처로
모인다.** 페이지 분할·캐시 오염·WAL FPI 증폭 사슬이 한꺼번에 끊긴다.
게다가 난수 비트가 넉넉해 **같은 ms에 시계가 역행해도 충돌 확률이 사실상
0**이고, 워커 ID 배포도 필요 없다 — Snowflake가 짊어진 두 의존이 모두
사라진다. 표준이라 언어·DB 어디서나 통하고, 클라이언트나 오프라인
기기에서 미리 만들 수도 있다.

```sql
-- PG 18부터는 서버 내장 함수가 있다
id uuid PRIMARY KEY DEFAULT uuidv7()
-- 그 이전 버전이면 애플리케이션에서 생성하거나 확장을 쓴다.
-- (DB 기본값으로 두면 INSERT 전 ID 확보라는 장점을 스스로 버리게 되므로,
--  분산 채번이 목적이라면 애초에 앱에서 만들어 넣는 편이 일관된다.)
```

**무엇이 남는가.**

- **16바이트다.** `bigint`의 두 배이고, 위 표대로 자식 FK 컬럼·FK
  인덱스와 PK 인덱스 자체에서 적재율로 청구된다. **정렬성은 회복했지만
  원칙 ① "작게"는 여전히 어긴다.**
- **문자열로 저장하면 최악이다.** `varchar(36)`은 v4와 다를 바 없는 크기
  문제를 그대로 되살린다 — `uuid` 타입이 전제다.
- **생성 시각이 드러난다.** Snowflake와 같다.
- **가독성·업무 의미 0.** 주문번호로 고객에게 불러줄 수 없다.
- **Java 표준 `UUID.randomUUID()`는 v4다.** v7은 별도 라이브러리나 직접
  구현이 필요하다. 하이버네이트 6.x 계열은 `@UuidGenerator`로 시간 정렬
  스타일을 지원하지만, 사용 중인 버전에서 지원 여부를 반드시 확인하고
  쓴다.

**대차대조표.**

- 얻는 것: 조율·시계 역행·워커 ID 걱정 없는 완전 무의존 분산 생성,
  거의 단조 증가(순차 I/O·WAL 효율 회복), 표준, 클라이언트 생성 가능,
  총량 추측 불가, PG 네이티브 타입·드라이버 매핑(`java.util.UUID` 그대로).
- 내는 것: 16바이트 계수(PK 인덱스 + 자식 FK 컬럼·인덱스의 적재율 저하),
  생성 시각 노출, 가독성 0, 저장 타입을 잘못 고르면(문자열) v4와 다를 바
  없는 크기, JDK 표준 미지원.

> **MySQL 대조.** InnoDB에서는 이 모든 일이 **테이블 그 자체**(클러스터드
> 리프 = 행 전체)에서 벌어지므로 랜덤 PK의 피해 규모가 "PK 인덱스 크기"가
> 아니라 "테이블 크기"다 — 훨씬 치명적이다. 게다가 UUID 전용 타입이 없어
> `BINARY(16)` + `UUID_TO_BIN()`/`BIN_TO_UUID()`로 손수 변환해야 하고,
> `UUID_TO_BIN(uuid, 1)`의 스왑 플래그는 시간 필드가 뒤에 있는 v1을 앞으로
> 돌리는 용도라 **v7에 걸면 오히려 정렬성이 깨진다.** PG는 `uuid` 타입과
> 드라이버 매핑이 그 수공업을 없앤다. 정리하면 — **"UUID PK가 나쁘다"의
> 강도는 엔진마다 다르다. PG는 덜 아프지만 안 아픈 게 아니다.**

### 2-5. 단조 증가에도 대가는 있다 (가산점 포인트)

트레이드오프를 양면으로 말하려면 "정렬성이 무조건 좋다"에서도 한 걸음
물러설 줄 알아야 한다. 모든 INSERT가 **맨 오른쪽 리프 한 장**에 몰리면
그 페이지의 버퍼 잠금을 두고 백엔드들이 경합한다 — `pg_stat_activity`에서
`wait_event_type = 'LWLock'`으로 관측되는 종류의 대기다. 초당 수만 건
이상의 단일 테이블 삽입에서는 이 "마지막 페이지 핫스팟"이 병목으로
나타나기도 한다. 완화책은 **해시 파티셔닝으로 끝 페이지를 여러 개로
나누거나** 샤딩하는 것이지 랜덤 키로 돌아가는 것이 아니다 — 랜덤 키는
락 경합 대신 디스크 I/O와 WAL 볼륨을 지불하는데, 그쪽이 수천 배 비싸다.

---

## 3. 비교표와 선택 기준 — 목록으로 인출한다

### 3-1. 4방식 비교표 (PostgreSQL 기준)

| 축 | 시퀀스 / IDENTITY | 채번 테이블(+블록) | Snowflake | UUID v7 |
|---|---|---|---|---|
| 정렬성(시간 순) | 완전 단조 (`CACHE`>1이면 세션 간 교차) | 블록 단위(인스턴스 간 교차) | ms 단위 근사 단조 | ms 단위 근사 단조 |
| 분산 생성 | △ DB 한 대 안에서는 인스턴스 무제한 | △ DB 왕복 필요, 핫 로우 | ○ 로컬 생성, 조율 0 | ○ 로컬 생성, 조율 0 |
| INSERT 전 ID 확보 | **○ `nextval()`** | ○ | ○ | ○ |
| 크기 | 8B | 8B(정수) 또는 포맷 문자열 | 8B | 16B(`uuid` 타입) |
| 노출 위험 | 연속 → 총량·다음 값 추측 | 연속 → 동일 | 생성 시각·ms당 건수 노출 | 생성 시각 노출 |
| 의존성 | DB 노드 1대 | 채번 행의 락·가용성 | 시계 규율 + 워커 ID 임대 | 시계(역행은 난수가 완충) |
| 업무 의미 부여 | ✗ | ○ 날짜·채널·체크 디짓 자유 | ✗ | ✗ |
| PG 고유 대가 | 빈 번호(비트랜잭션), 논리 복제 시 `setval` 누락 | 죽은 튜플·autovacuum, HOT 유지용 `fillfactor` | — | PK B-tree 적재율·FK 인덱스 계수 |
| 대표 대가 | 샤딩 불가 | 핫 로우, 재기동 시 구멍 | 시계 역행, 워커 ID 충돌 | 크기 2배, JDK 미지원 |

표를 외우는 게 아니라 **축 여섯 개(정렬성·분산성·크기·노출·의존성·업무
의미)를 먼저 말하고 각 칸을 채우는 순서**를 몸에 붙인다. 면접에서
"UUID v7과 Snowflake 중 뭐가 낫나요"가 오면 표의 열 두 개를 나란히
읽으면 된다 — 같은 정렬성·같은 분산성, 크기 8 vs 16, 의존성은 Snowflake가
무겁고 UUID v7이 가볍다. **의존성을 살 여유(워커 ID 레지스트리, NTP
규율)가 있으면 Snowflake, 없으면 UUID v7이 크기를 내고 단순함을 산다.**

그리고 PG에서는 **1열의 "INSERT 전 ID 확보 ○"** 가 표 전체의 결론을
바꾼다는 점을 짚는다 — MySQL 기준 비교표에서 시퀀스 계열이 탈락하던
사유 하나가 여기서는 없다.

### 3-2. 선택 기준 6가지

1. **생성 지점이 하나인가 여럿인가.** DB 한 대(+레플리카)면
   `bigint IDENTITY`로 충분하다 — 앱 인스턴스가 몇 대든 시퀀스 하나를
   같이 쓴다. 샤딩·다중 리전·클라이언트 생성이 요구되면 Snowflake /
   UUID v7로 간다. **PG에서 채번 테이블은 "분산"의 답이 아니라 "포맷"의
   답이다.**
2. **INSERT 전에 ID가 필요한가.** 이벤트를 먼저 발행하거나, 멱등 키로
   쓰거나, JPA 쓰기 지연 배치를 살려야 하는 경우 — MySQL이면 여기서
   AUTO_INCREMENT가 탈락하지만 **PG는 시퀀스 전략으로 그대로 통과**한다.
3. **외부에 노출되는가, 노출되면 무엇이 새는가.** 총량·증가율이 문제면
   연속 번호가 탈락, 생성 시각까지 숨겨야 하면 시간 정렬 ID도 탈락 →
   내부 PK와 별개의 무작위 외부 식별자가 필요하다.
4. **업무 의미(날짜·채널·체크 디짓) 요구가 있는가.** 있으면 어차피 PK와
   분리해야 하고, 외부 식별자 쪽은 채번 테이블 + 포맷 조립이 답이다.
5. **저장 구조를 정확히 반영했는가.** "PG는 힙이라 UUID를 써도 된다"는
   **반쪽 명제**다. 힙은 무관하지만 PK B-tree의 무작위 삽입, 자식 FK
   인덱스의 크기 계수, `full_page_writes`로 부푸는 WAL은 그대로다(§2-4).
   허용 범위가 InnoDB보다 넓어진 것이지 비용이 사라진 것이 아니다.
6. **팀이 감당할 의존성은 어디까지인가.** Snowflake는 워커 ID 임대와
   시계 규율이라는 **상시 운영 의무**를 사고, 채번 테이블은 DB 가용성에
   묶이며, UUID v7은 의존성 대신 16바이트를 낸다. "인프라를 늘리지 않고
   되는 일을 늘려서 하지 않는다"가 기본값이다.

---

## 4. 결론 설계 — 내부 PK와 외부 주문번호를 분리하고 안전망을 코드로 고정한다

### 4-1. 스키마와 JPA 매핑 — before / after

```java
// ❌ before: UUID v4 문자열 하나가 PK이자 주문번호
@Entity
@Table(name = "orders")
public class Order {
    @Id
    @Column(length = 36)
    private String id = UUID.randomUUID().toString();   // v4 난수, varchar(36)
    // ① 36바이트 키 + collation 비교 — uuid 타입(16B, 바이트 비교)을 두고 최악을 골랐다
    // ② 삽입 위치 무작위 → PK B-tree 캐시 미스 → 페이지 분할 → 적재율↓
    //    → INSERT마다 랜덤 읽기 + full_page_writes로 WAL에 8KB 이미지 한 장씩
    // ③ 자식 테이블 FK 컬럼·FK 인덱스가 전부 이 크기를 받는다(적재율 -28%)
    // ④ 이 값을 그대로 고객·CS에 노출 → 불러줄 수도, 날짜를 읽을 수도 없다
    // ⑤ id가 이미 채워진 채 save() → Spring Data는 "새 엔티티 아님"으로 보고
    //    merge → SELECT 한 번 더 나간다 (persist가 아니라 select + insert)
    ...
}
```

```java
// ✅ after: 내부 PK(bigint, 시간 순) + 외부 주문번호(업무 포맷, 유니크) 분리
@Entity
@Table(name = "orders",
       uniqueConstraints = @UniqueConstraint(name = "uk_orders_order_no",
                                             columnNames = "order_no"))
public class Order {

    // 분산이 요구사항이면 Snowflake, 단일 DB면 아래 시퀀스 전략으로 바꾸면 된다.
    // PG에서는 어느 쪽이든 INSERT 전에 값이 손에 들어와 JDBC 배치가 살아 있다.
    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "orders_seq")
    @SequenceGenerator(name = "orders_seq", sequenceName = "orders_id_seq",
                       allocationSize = 50)          // DDL의 INCREMENT BY 와 일치해야 한다
    private Long id;                                 // 8바이트, 조인·FK·인덱스의 축

    @Column(name = "order_no", nullable = false, updatable = false, length = 20)
    private String orderNo;        // 외부 식별자: 20260901-A-004821-7 (날짜-채널-일련-체크디짓)
                                   // 고객·CS·정산이 부르는 번호. 유니크 제약이 최후 방어선

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;     // timestamptz ↔ Instant/OffsetDateTime.
                                   // 시간 순 정렬·커서는 이 컬럼으로 — ID 순서를 시간 순으로 믿지 않는다

    protected Order() {}

    public static Order place(String orderNo, ...) { ... }
}
```

```sql
-- 인덱스 리프에는 PK가 아니라 TID가 들어가므로 PK 크기가 인덱스 개수만큼
-- 곱해지지는 않는다. 대신 자식 테이블의 FK 컬럼·FK 인덱스가 8바이트를 받는다.
CREATE SEQUENCE orders_id_seq AS bigint INCREMENT BY 50;

CREATE TABLE orders (
    id          bigint      PRIMARY KEY DEFAULT nextval('orders_id_seq'),
    order_no    varchar(20) NOT NULL,
    customer_id bigint      NOT NULL,
    status      varchar(20) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uk_orders_order_no UNIQUE (order_no)
);
CREATE INDEX ix_orders_customer_created ON orders (customer_id, created_at DESC);

-- 자식 테이블: FK 컬럼에 인덱스를 "직접" 만든다.
-- PG는 FK 인덱스를 자동 생성하지 않으므로, 없으면 부모 DELETE/키 UPDATE마다
-- 자식 전체 스캔이다. PK를 작게 유지해야 하는 진짜 이유도 여기에 있다.
CREATE TABLE order_items (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES orders(id),
    ...
);
CREATE INDEX ix_order_items_order_id ON order_items (order_id);
```

**이 구조가 한 번에 해결하는 것.** PK B-tree의 삽입 비용과 WAL 볼륨은
8바이트 단조 증가 PK가 감당한다(끝 페이지 append, FPI 최소). 노출·가독성·
업무 의미는 `order_no`가 감당한다. 두 요구가 한 컬럼에서 싸우던 것이
애초의 문제였다. 외부 API·URL·이메일·영수증에는 `order_no`만 나가고,
`id`는 서비스 밖으로 나가지 않는다.

### 4-2. 안전망 ① — Snowflake 발급기: 시계 역행 감지와 시퀀스 고갈 대기

```java
public final class Snowflake {
    private static final long EPOCH = 1_735_689_600_000L;  // 2025-01-01T00:00:00Z — 한 번 정하면 못 바꾼다
    private static final long WORKER_BITS = 10, SEQ_BITS = 12;
    private static final long MAX_WORKER = (1L << WORKER_BITS) - 1;
    private static final long SEQ_MASK   = (1L << SEQ_BITS) - 1;
    private static final long TOLERABLE_BACKWARD_MS = 5;    // 이 이하 역행은 기다리고, 초과는 거부

    private final long workerId;
    private long lastTs = -1L;
    private long seq = 0L;

    public Snowflake(long workerId) {
        if (workerId < 0 || workerId > MAX_WORKER) throw new IllegalArgumentException("workerId out of range");
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long now = System.currentTimeMillis();

        if (now < lastTs) {                                   // ── 시계 역행 감지 ──
            long backward = lastTs - now;
            if (backward > TOLERABLE_BACKWARD_MS) {
                // 큰 역행: 같은 ms를 다시 쓰면 중복이므로 발급을 거부한다. 알람 대상.
                throw new ClockMovedBackwardsException(backward);
            }
            now = spinUntil(lastTs);                          // 작은 역행: 마지막 발급 시각까지 기다린다
        }

        if (now == lastTs) {
            seq = (seq + 1) & SEQ_MASK;
            if (seq == 0) now = spinUntil(lastTs + 1);        // 같은 ms에 4096개 소진 → 다음 ms까지 대기
        } else {
            seq = 0L;
        }
        lastTs = now;

        return ((now - EPOCH) << (WORKER_BITS + SEQ_BITS)) | (workerId << SEQ_BITS) | seq;
    }

    private static long spinUntil(long targetTs) {
        long now;
        do { now = System.currentTimeMillis(); } while (now < targetTs);
        return now;
    }
}
```

`ClockMovedBackwardsException`은 삼키지 않는다 — 주문 API는 실패로
응답하고 알람이 울려야 한다. "조용히 새 ID를 만들어 내는" 발급기는 중복
ID를 만들어 내는 발급기다. 운영 쪽 짝은 **NTP를 step이 아니라 slew로**
맞추도록 설정하는 것이다(시계를 한 번에 되돌리지 않고 천천히 늦춰
맞춘다).

### 4-3. 안전망 ② — 워커 ID 임대: 설정 파일이 아니라 등록 테이블

```sql
-- 기동 시 자기 자신을 등록하고, 살아 있는 동안 하트비트를 갱신한다.
CREATE TABLE id_workers (
    worker_id    smallint    PRIMARY KEY,        -- 0 ~ 1023
    owner        text        NOT NULL,           -- 호스트명/파드명
    heartbeat_at timestamptz NOT NULL DEFAULT now()
);
```

```java
@Component
public class WorkerIdLease {

    // ① 하트비트가 끊긴 슬롯(죽은 프로세스)을 빼앗는다.
    //    SKIP LOCKED 로 다른 기동 중인 인스턴스와 부딪히지 않고 지나간다.
    private static final String STEAL_STALE = """
        UPDATE id_workers SET owner = ?, heartbeat_at = now()
        WHERE worker_id = (
            SELECT worker_id FROM id_workers
            WHERE heartbeat_at < now() - interval '5 minutes'
            ORDER BY heartbeat_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING worker_id
        """;

    // ② 빈 슬롯을 하나 집어 등록한다. 경쟁자가 먼저 가져갔으면 ON CONFLICT 로
    //    조용히 비켜서고(반환 행 없음) 호출부가 다시 시도한다.
    private static final String CLAIM_FREE = """
        INSERT INTO id_workers (worker_id, owner, heartbeat_at)
        SELECT g, ?, now()
        FROM generate_series(0, 1023) AS g
        WHERE NOT EXISTS (SELECT 1 FROM id_workers w WHERE w.worker_id = g)
        ORDER BY g
        LIMIT 1
        ON CONFLICT (worker_id) DO NOTHING
        RETURNING worker_id
        """;

    @Transactional
    public int acquire(String owner) {
        for (int attempt = 0; attempt < 10; attempt++) {
            Integer stolen = queryForNullableInt(STEAL_STALE, owner);
            if (stolen != null) return stolen;
            Integer claimed = queryForNullableInt(CLAIM_FREE, owner);
            if (claimed != null) return claimed;
        }
        throw new IllegalStateException("no free worker id");   // 1024대 초과 — 기동 실패가 정답
    }

    @Scheduled(fixedDelay = 30_000)
    public void heartbeat() {
        jdbc.update("UPDATE id_workers SET heartbeat_at = now() WHERE worker_id = ?", myWorkerId);
    }
}
```

핵심은 세 줄이다 — **PK 충돌을 "이미 누가 가져갔다"의 신호로 쓴다**(DB의
유니크 보장을 조율 도구로 쓰는 것), **하트비트가 끊긴 슬롯만 회수**한다,
그리고 **`SKIP LOCKED`로 동시 기동이 서로 기다리지 않게** 한다. 하트비트
주기보다 만료 기준을 충분히 길게 잡아 "잠깐 GC로 멈춘 살아 있는
프로세스"의 번호를 빼앗지 않게 한다. 슬롯이 아니라 프로세스 단위의 짧은
상호배제만 필요하다면 PG에는 `pg_advisory_lock` 계열도 있다 —
세션이 끊기면 자동 해제되므로 하트비트 없이도 "살아 있는 동안만 점유"가
성립한다(가산점 포인트). ZooKeeper·etcd·Redis 임대도 같은 구조를 다른
저장소로 구현한 것이다.

### 4-4. 안전망 ③ — 주문번호 생성기: 블록 할당 + 유니크 제약 + 새 트랜잭션에서 재시도

```java
@Component
public class OrderNoGenerator {
    private static final int BLOCK = 500;
    private final SequenceBlockAllocator allocator;   // §2-2의 REQUIRES_NEW 할당기
    private final Clock clock;

    private LocalDate blockDate;                      // 현재 블록의 날짜
    private long next, limit;                         // 현재 블록 [next, limit)

    public synchronized String next(Channel channel) {
        LocalDate today = LocalDate.now(clock);
        if (!today.equals(blockDate) || next >= limit) {          // 날짜가 바뀌었거나 블록 소진
            long start = allocator.allocate("order:" + today, BLOCK);
            blockDate = today; next = start; limit = start + BLOCK;
        }
        long serial = next++;
        String body = today.format(DateTimeFormatter.BASIC_ISO_DATE) + "-" + channel.code() + "-"
                    + String.format("%06d", serial);
        return body + "-" + luhnCheckDigit(body);                 // 체크 디짓: CS 오타 입력을 걸러 준다
    }
}
```

```java
@Service
public class PlaceOrderService {
    private static final int MAX_ATTEMPTS = 3;

    // 트랜잭션은 여기 밖에서 시작하지 않는다 — 충돌 시 "새 트랜잭션"으로 재시도해야 하기 때문
    public Order place(PlaceOrderCommand cmd) {
        for (int attempt = 1; ; attempt++) {
            try {
                return tx.execute(status -> {                        // TransactionTemplate: 시도마다 새 트랜잭션
                    String orderNo = orderNoGenerator.next(cmd.channel());
                    return orderRepository.save(Order.place(orderNo, cmd));
                });
            } catch (DuplicateKeyException dup) {                    // uk_orders_order_no 위반(SQLSTATE 23505)
                if (attempt >= MAX_ATTEMPTS) throw dup;
                log.warn("order_no collision, retrying attempt={}", attempt + 1);
            }
        }
    }
}
```

세 가지가 코드로 고정된다.

- **유니크 제약이 최후 방어선이다.** 블록 할당기에 버그가 있어도, 두
  인스턴스가 어떤 경로로든 같은 번호를 만들어도, **DB가 거절한다**
  (`ERROR 23505 duplicate key value violates unique constraint`). 채번
  로직의 정확성을 믿는 것과 별개로 이 제약은 반드시 있어야 한다.
- **재시도는 반드시 새 트랜잭션에서 — PG에서는 선택이 아니라 강제다.**
  MySQL이라면 문장 하나가 실패해도 같은 트랜잭션을 이어 쓸 수 있지만,
  **PG는 트랜잭션 안에서 에러가 나는 순간 그 트랜잭션 전체가 실패
  상태로 들어가** 이후 모든 문장이
  `ERROR 25P02 current transaction is aborted, commands ignored until end
  of transaction block`으로 거부된다. 같은 트랜잭션 안에서 재시도하려면
  `SAVEPOINT`(스프링의 `Propagation.NESTED`)로 감싸야 하고, 그게
  아니라면 재시도 루프는 트랜잭션 **밖**에 있어야 한다. 이 차이를 모르고
  루프를 `@Transactional` 안에 두면 재시도가 전부 25P02로 죽는다
  (가산점 포인트).
- **구멍 허용은 정책이다.** 블록 할당을 택한 순간 "주문번호는 연속이
  아니다"가 시스템의 성질이 된다. 이 사실을 코드 주석이 아니라 ADR과
  운영 문서에 적고, CS·회계에 사전에 알린다.

> **한 걸음 더 (가산점 포인트).** 재시도 자체를 없애고 싶다면 PG에서는
> `INSERT ... ON CONFLICT (order_no) DO NOTHING RETURNING id`로 바꿔
> **예외 없이** 충돌을 판정할 수 있다(반환 행이 없으면 이미 있는 번호).
> 예외를 던지지 않으니 트랜잭션이 실패 상태로 가지도 않는다. 다만 이건
> "충돌해도 괜찮다"는 의미가 되므로, 주문번호처럼 반드시 새 번호를 받아야
> 하는 경우에는 재시도가 맞고, 멱등 키처럼 "이미 있으면 그걸 쓰면 되는"
> 경우에 적합하다([27 문서](./27-payment-succeeded-order-missing-incident.md)).

**날짜별 연속 일련번호의 함정 (가산점 포인트).** `20260901-A-004821`은
사람이 읽기 좋지만 **하루 주문량이 그대로 보인다** — 연속 번호 노출
문제로 되돌아온 셈이다. 규모 추측까지 막아야 한다면 ⑴ 일련 부분을
Feistel 네트워크 같은 **전단사 치환**으로 섞어 유일성을 유지한 채 무작위처럼
보이게 하거나 ⑵ 일련 대신 난수 6~8자리를 쓰고 유니크 충돌 시 재시도한다
(충돌 확률 관리 필요). 어느 쪽이든 "누가 이 번호를 보고 무엇을 알아낼 수
있는가"를 요건에서 먼저 확정한다.

### 4-5. 안전망 ④ — 동시성 채번 테스트와 시퀀스 소진 감시

"유니크할 것"은 코드 리뷰로 확인되지 않는다. 스레드 수십 개가 동시에
뽑아도 겹치지 않는다는 사실을 테스트로 고정한다.

```java
@Test
void concurrentGenerationProducesNoDuplicates() throws Exception {
    int threads = 32, perThread = 2_000;
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    CountDownLatch start = new CountDownLatch(1);
    Set<Long> ids = ConcurrentHashMap.newKeySet();

    for (int t = 0; t < threads; t++) {
        pool.submit(() -> { start.await(); for (int i = 0; i < perThread; i++) ids.add(snowflake.nextId()); return null; });
    }
    start.countDown();                                   // 32개 스레드를 같은 순간에 출발시킨다
    pool.shutdown(); pool.awaitTermination(30, TimeUnit.SECONDS);

    assertThat(ids).hasSize(threads * perThread);        // 하나라도 겹치면 크기가 줄어든다
}
```

같은 형태로 `OrderNoGenerator`도 검증하고, Testcontainers로 실제
PostgreSQL을 띄워 **유니크 제약이 엔티티 어노테이션이 아니라 DDL에**
걸려 있는지 카탈로그로 확인하는 테스트를 하나 더 둔다 — 유니크 제약이
없는 운영 DB는 최후 방어선이 없는 시스템이다.

```sql
-- 테스트에서 단정할 것: 이 이름의 유니크 제약이 실제로 존재하는가
SELECT conname FROM pg_constraint
WHERE conrelid = 'orders'::regclass AND contype = 'u';
--   uk_orders_order_no
```

그리고 **시퀀스 소진은 알람으로 미리 잡는다.** 고갈되는 날 모든 INSERT가
멈추고, 그때는 타입 변경(테이블 재작성 + `ACCESS EXCLUSIVE`)밖에 남지
않기 때문이다.

```sql
-- 대시보드/배치에 걸어 둘 쿼리: 소진률 상위 시퀀스
SELECT schemaname, sequencename, last_value, max_value,
       round(last_value::numeric * 100 / max_value, 2) AS pct_used
FROM pg_sequences
WHERE last_value IS NOT NULL
ORDER BY pct_used DESC
LIMIT 20;
--   int(serial)로 만든 시퀀스가 상위에 올라오면 그 자체가 리팩터링 신호다
```

---

## 5. 꼬리질문 대비 포인트

### "UUID v4를 PK로 쓰면 PostgreSQL에서 왜 INSERT가 느려지나요? PG는 힙이라 괜찮다던데요?"

**절반만 맞다.** 힙은 정말 무관하다 — 새 행은 FSM이 가리키는 빈 공간
(대개 파일 끝)에 들어가므로 PK가 뭐든 힙 워킹셋은 끝 페이지 한두 장이다.
InnoDB에서 UUID PK가 **테이블 자체**를 흩뜨리던 피해는 PG에 없다. 그런데
**삽입 위치를 값이 결정하는 구조가 하나 남아 있다 — PK B-tree, 그리고 그
값을 받는 자식 FK 인덱스들.** 여기서 사슬이 그대로 돈다: 무작위 삽입 지점
→ 대상 리프가 shared_buffers에 없을 확률↑ → **INSERT마다 디스크 랜덤
읽기**(쓰기가 읽기를 부른다) → 가득 찬 페이지는 반반 **분할** → 인덱스
bloat·적재율 저하 → 논리/물리 순서 어긋나 범위 스캔 랜덤화 → 그리고 PG
고유 항목으로 **`full_page_writes` FPI 증폭**(체크포인트 이후 처음
건드리는 페이지마다 8KB 이미지가 WAL에) → WAL 볼륨·체크포인트 I/O·복제
지연. v7은 시간을 상위 비트에 두어 삽입 위치를 오른쪽 끝으로 모으므로
**이 사슬 전체가 끊긴다.** 남는 것은 크기다 — `uuid` 16바이트는 자식
테이블 FK 컬럼·FK 인덱스에서 페이지당 엔트리 366 → 262로 청구된다.
"완전히 해결"이 아니라 "두 문제 중 치명적인 하나를 해결"이 정확한
답이고, `varchar(36)`으로 저장하면 v7이어도 크기 문제는 v4와 같다.

### "시퀀스 번호가 군데군데 비어 있습니다. 데이터가 유실된 건가요?" (가산점 포인트)

**아니다 — 정상이다.** `nextval()`은 트랜잭션 밖에서 동작하도록 설계돼
있다(그래서 두 세션이 서로 기다리지 않는다). 롤백해도 소모된 값은 돌아오지
않는다. 구멍이 생기는 경로는 넷 — ⑴ 롤백·에러 ⑵ `INSERT ... ON CONFLICT
DO NOTHING`처럼 행이 안 들어가도 컬럼 DEFAULT의 `nextval()`은 먼저
평가되어 소모 ⑶ `CACHE`로 선점한 값이 세션 종료로 폐기 ⑷ 크래시 후
재시작 시 미리 WAL에 기록해 둔 지점까지 건너뜀. 그러니 **번호 연속성으로
유실을 판단하면 안 되고**, 유실 판단은 별도 대사(reconciliation)로 한다.
연속성이 진짜 요건(세금 계산서 일련번호 등)이라면 시퀀스로는 불가능하고
**채번 테이블을 트랜잭션 안에서 UPDATE**해야 하는데, 그건 §2-2의 핫 로우
직렬화를 그대로 받아들인다는 뜻이다 — **gapless와 처리량은 맞바꾸는
관계**라고 말하면 요구를 비용으로 번역할 줄 아는 것으로 들린다.

### "채번 테이블이 왜 트래픽에서 병목이 되나요? PostgreSQL이라 더한 점이 있나요?"

핫 로우 사슬 — 모든 요청이 **같은 행**을 UPDATE → 튜플 헤더 `xmax`에
기록되는 배타 락 → 락은 **트랜잭션 커밋까지** 유지 → 채번을 주문 트랜잭션
안에서 하면 주문 처리 전체 길이만큼 다음 요청이 대기(`pg_stat_activity`의
`wait_event = 'transactionid'`) → 처리량 상한 = 1/트랜잭션 길이 →
대기자가 커넥션(=OS 프로세스)을 쥔 채 서므로 **풀 고갈**로 다른 API까지
번진다. **PG에서 한 겹 더 있는 것**은 UPDATE가 제자리 갱신이 아니라 새
튜플 버전을 만든다는 점이다 — 죽은 튜플이 그 페이지에 쌓이고 autovacuum이
추격해야 한다. 다행히 `next_val`은 인덱스에 없으므로 HOT 업데이트가
가능하니 `fillfactor`를 낮춰(예: 70) 같은 페이지에 새 버전 자리를 비워
두고, `n_tup_hot_upd` 비율로 확인한다. 처방은 그 위에 둘 —
`REQUIRES_NEW`로 채번 트랜잭션을 `UPDATE ... RETURNING` 한 문장으로 짧게
분리하고, 블록 할당으로 방문 횟수를 1/N로 줄인다. 블록 할당 후 남는 것은
⑴ 재기동 시 구멍 ⑵ 인스턴스 간 순서 교차 ⑶ 채번 테이블 가용성 의존이다.
**덧붙일 한마디** — PG에서는 이 블록 할당을 시퀀스의 `CACHE`가 이미
제공하므로, 채번 테이블을 직접 쓰는 이유는 "분산"이 아니라 "날짜별 리셋
같은 업무 포맷"이어야 한다.

### "주문번호에 날짜와 채널 코드를 넣어 달라는 요구가 왔습니다. PK를 바꾸시겠어요?" (시니어 변별 포인트)

바꾸지 않는다. 이 요구는 **"외부 식별자에 업무 의미를 담아 달라"**는
요구이지 "내부 식별자를 바꿔 달라"는 요구가 아니다. PK는 조인·FK·인덱스의
축이라 **작고 단조 증가하는 정수**여야 하고, 날짜·채널이 들어간 문자열은
그 두 원칙을 다 어긴다 — 크기는 자식 테이블 FK 컬럼·FK 인덱스로 번지고,
채널별로 삽입 위치가 갈라져 PK B-tree 끝 페이지 append가 깨진다. 그래서
PK는 그대로 두고 `order_no` 컬럼을 유니크 제약과 함께 추가한다(§4-1).
이어서 되물어야 할 것 — "일련번호가 연속이면 하루 주문량이 노출되는데
괜찮은가"(§4-4 함정), "채널 코드가 바뀌면 기존 번호는 어떻게 하는가"
(번호는 불변, 채널 매핑은 별도 테이블), "체크 디짓을 넣어 CS 오입력을
막을까". 요구를 한 단계 쪼개 어느 성질이 진짜 필요한지 되묻고, **PK와
업무 식별자를 겸용하던 것이 애초의 문제**였다고 짚는 것이 시니어의 답이다.

### "우리 서비스는 DB 한 대로 충분한데, 그래도 Snowflake를 미리 도입해야 할까요?" (시니어 변별 포인트)

아니다 — **의존성 비용을 먼저 말한다.** Snowflake는 워커 ID 임대
인프라(레지스트리·하트비트·회수)와 시계 규율(NTP slew, 역행 감지·알람)이라는
**상시 운영 의무**를 산다. DB 한 대인 지금은 `bigint IDENTITY`가 순차
I/O, 8바이트, 의존성 0을 공짜로 준다. **게다가 PG에서는 "INSERT 전에 ID를
못 받는다"는 이유로 넘어갈 필요도 없다** — `nextval()`을 미리 부르면
되고, JPA도 시퀀스 전략 + `allocationSize`로 배치가 살아 있다. 다만
**미리 해 둘 것은 하나** — 내부 PK를 외부에 노출하지 않도록 `order_no`를
지금부터 분리해 두는 것. 그러면 나중에 샤딩이나 다중 리전이 실제 요구가
됐을 때 **바뀌는 것은 `@GeneratedValue` 전략 한 줄과 마이그레이션**이고,
외부 계약(주문번호 포맷)은 그대로다. 넘어가는 신호도 정해 둔다 —
⑴ 샤딩/다중 마스터 결정 ⑵ 클라이언트·오프라인 생성 요구 ⑶ 단일 노드 쓰기
처리량 한계 관측. **(가산점 포인트)** 넘어갈 때는 기존 시퀀스 값과
Snowflake 값이 같은 `bigint` 컬럼에서 겹치지 않는지(에포크가 충분히 뒤라
Snowflake 값이 기존 최댓값보다 크다는 것) 확인하고, 시퀀스를 계속 쓸
경로가 남는다면 `setval`로 앞당겨 두는 마이그레이션 체크까지 말하면 끝이다.

### "Snowflake에서 서버 시계가 뒤로 가면 무슨 일이 생기고, 어떻게 막나요?"

유일성이 "같은 워커에서 시간은 단조"라는 가정에 걸려 있으므로, 시계가
이미 발급한 ms로 되돌아가면 **같은 (시각, 워커, 시퀀스) 조합이 다시
나올 수 있다.** 발급기는 마지막 발급 시각을 들고 있다가 **역행을 감지**해야
한다 — 수 ms 이내면 그 시각까지 기다리고, 그 이상이면 예외로 발급을
거부하고 알람을 울린다(§4-2 코드). 예외를 삼키고 계속 발급하는 것이
최악이다. 운영 쪽에서는 NTP를 step(한 번에 되돌림)이 아니라 slew(천천히
보정)로 설정하고, VM 마이그레이션·절전 복귀 뒤 시계 점프를 모니터링한다.
**(가산점 포인트)** UUID v7은 같은 상황에서 난수 비트가 완충하므로 역행
감지 코드가 필요 없다 — Snowflake의 시계 의존을 16바이트로 산 것이라고
연결하면 트레이드오프 서술이 완성된다.

### "Snowflake ID로 정렬하면 정확한 시간 순이 되나요? 커서 페이지네이션 키로 써도 되나요?" (가산점 포인트)

**워커 안에서는 단조, 워커 간에는 ms 단위 근사**다. 두 서버의 시계가
몇 ms 어긋나면 나중에 만든 ID가 더 작을 수 있고, 같은 ms 안의 순서는
워커 ID 순이지 실제 발생 순이 아니다. 따라서 "최근 주문순" 목록의 정렬
키로는 `created_at`(+ 타이브레이커로 `id`)을 쓰고, ID는 **유일성과
인덱스 지역성**을 위한 것이라고 역할을 나눈다. UUID v7도 같은 성질이고,
**PG 시퀀스도 `CACHE`를 1보다 크게 잡으면 세션별 블록 선점 때문에 같은
현상이 생긴다** — "시간 정렬 ID"라는 말은 "인덱스 삽입 위치가 모인다"는
뜻이지 "정확한 발생 순서를 보장한다"는 뜻이 아니다. 키셋 페이지네이션은
`(created_at, id)` 행 비교로 짜는 것이 안전하다
([13 문서](./13-deep-pagination-offset-vs-cursor.md)).

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **자동 증가의 정체** — MySQL의 AUTO_INCREMENT는 테이블
속성이라 값을 미리 받을 수 없어 "INSERT 전 ID 미확보"가 진짜 한계지만,
PG의 시퀀스는 독립 객체라 `nextval()`을 먼저 부를 수 있다. 그래서 JPA
배치를 살리려고 외부 채번으로 넘어갈 이유가 PG에서는 하나 줄어든다.
② **UUID PK의 피해 규모** — InnoDB는 클러스터드라 랜덤 PK가 **테이블
자체**를 흩뜨리고 세컨더리 리프마다 PK가 복제되지만, PG는 힙이라 테이블은
무관하고 대신 PK B-tree·자식 FK 인덱스·`full_page_writes` WAL 증폭이
청구서다. ③ **채번 테이블의 관용구** — MySQL은
`LAST_INSERT_ID(next_val + n)` 세션 변수 트릭, PG는
`UPDATE ... RETURNING` / `INSERT ... ON CONFLICT ... RETURNING` 한 문장.
④ **UUID 저장** — MySQL은 `BINARY(16)` + `UUID_TO_BIN`/`BIN_TO_UUID`
수공업(그리고 v7에 스왑 플래그를 걸면 정렬성이 깨지는 함정), PG는 `uuid`
네이티브 타입. ⑤ **충돌 후 재시도** — MySQL은 문장 하나가 실패해도 같은
트랜잭션을 이어 쓸 수 있지만 PG는 트랜잭션 전체가 실패 상태(25P02)가 되어
`SAVEPOINT` 없이는 이어 쓸 수 없다. 이 다섯을 짚으면 "한쪽만 써봤다"가
아니라 "차이를 저장 구조에서 이해했다"로 들린다.

---

## 한 줄 요약

**채번 설계의 답은 방식 이름이 아니라 분리다 — 내부 PK는 작고(8바이트)
단조 증가해야 하는데, PostgreSQL에서 그 근거는 클러스터드 인덱스가 아니라
PK B-tree의 삽입 위치 · 자식 FK 인덱스의 적재율 · `full_page_writes`로
부푸는 WAL이다. 단일 DB면 `bigint GENERATED ALWAYS AS IDENTITY`가
첫 정답이고, PG의 시퀀스는 테이블과 독립된 객체라 `nextval()`을 INSERT
전에 미리 부를 수 있어 AUTO_INCREMENT의 한계 하나가 애초에 없다 — 대신
비트랜잭션성 때문에 **빈 번호는 정상**이고 `CACHE`는 세션 간 순서를
교차시키며 다중 노드 충돌은 남는다. 분산이 실제 요구면 Snowflake(시계
역행 감지 + 워커 ID 임대를 코드로) 또는 UUID v7이고, v4는 힙이 아니라
PK B-tree에서 무작위 삽입 → 캐시 미스 → 페이지 분할 → 적재율 저하 →
랜덤 I/O → WAL FPI 증폭의 사슬로 실격, v7은 그 사슬을 끊되 16바이트를
낸다. 외부 주문번호는 채번 테이블(+블록 할당, `UPDATE ... RETURNING`,
별도 짧은 트랜잭션, `fillfactor`로 HOT 유지, 구멍 허용 정책 명문화)로
업무 의미를 담고, 유니크 제약을 최후 방어선으로 두되 재시도는 반드시
새 트랜잭션에서 한다. 4방식은 정렬성·분산성·크기·노출·의존성·업무 의미
여섯 축으로 비교하고, 각 방식의 얻는 것과 내는 것을 같은 호흡에 붙인다.**
