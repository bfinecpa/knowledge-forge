# MVCC와 PostgreSQL 구현 — "읽기는 왜 락을 안 잡는가"를 튜플 헤더 xmin/xmax·힙 속 버전·스냅샷으로 답한다

> 핵심 관전 포인트: **MVCC(다중 버전 동시성 제어)는 "읽는 쪽이 락을 잡는
> 대신, 자기 시점에 맞는 과거 버전을 본다"는 격리(I) 구현 방식이다. 그래서
> 읽기는 쓰기를 막지 않고 쓰기는 읽기를 막지 않지만, 쓰기끼리는 여전히
> 락이다. PostgreSQL은 이를 세 부품으로 구현한다 — ① 튜플(행 버전)마다
> 헤더에 박힌 `xmin`(만든 트랜잭션 ID)·`xmax`(지우거나 갱신한 트랜잭션 ID)·
> `ctid`(다음 버전의 위치), ② **옛 버전을 별도 공간으로 빼지 않고 힙 페이지
> 안에 그대로 남기는** 저장 방식 — UPDATE는 덮어쓰기가 아니라 "새 튜플
> INSERT + 옛 튜플에 xmax 표시"다, ③ "어떤 트랜잭션까지 끝난 것으로
> 보는가"를 찍어 두는 **스냅샷**(하한선·상한선·진행 중 XID 목록) + 커밋 여부
> 장부 **`pg_xact`(CLOG)**. 스냅샷을 문장마다 찍으면 READ COMMITTED,
> 트랜잭션의 첫 문장에서 한 번만 찍으면 REPEATABLE READ — 격리 수준 차이는
> 이 생성 시점 하나다. 롤백은 `pg_xact`에 abort 한 줄 적는 O(1) 작업이고, 그
> 대신 **죽은 튜플을 치우는 일(VACUUM)이 뒤로 밀린다.** 비용은 트랜잭션
> 길이에 비례한다: 오래된 스냅샷 하나가 살아 있으면 VACUUM이 그 뒤의 죽은
> 튜플을 못 치우고 → 테이블·인덱스가 부풀고(bloat) → 무관한 트랜잭션의
> 조회까지 죽은 튜플을 읽고 버리느라 느려진다.**

---

## 0. 질문 + 의도

**질문**: "MVCC란 무엇인가요? InnoDB에서 어떻게 구현되어 있나요?"

**PostgreSQL 기준 재해석**: "MVCC란 무엇이고, PostgreSQL은 이를 어떻게
구현하나요? — 튜플 헤더의 xmin/xmax, 힙에 남는 옛 버전, 스냅샷, 그리고
VACUUM의 역할까지."

**출제 의도**: "읽기는 왜 락을 안 잡는가"를 이해해야 격리 수준, 락 경합,
bloat와 VACUUM(긴 트랜잭션의 해악) 같은 운영 이슈가 **전부 연결**된다. RDB
내부 이해의 허리에 해당하는 개념이다. 즉 이 질문은 MVCC 정의 암기가 아니라 —
[격리 수준 4단계](./transaction-isolation-levels.md)가 내부적으로 무엇이
다른 건지, [ACID의 I](./05-transaction-acid.md)가 무슨 장치로 구현되는지,
"트랜잭션은 짧게"라는 격언의 근거가 무엇인지, 그리고 **"VACUUM은 왜
필요한가"**를 **하나의 메커니즘으로 꿰어 말할 수 있는지**를 본다. 여기가
뚫리면 다음 문항(행 락·데드락, 긴 트랜잭션의 해악, 카운터 핫 로우)이 전부
이 문서의 응용 문제가 된다.

> 이 문서는 [05-transaction-acid.md](./05-transaction-acid.md)(I = 락 + MVCC,
> 롤백 = CLOG 표시)와 [transaction-isolation-levels.md](./transaction-isolation-levels.md)
> (RC/RR의 차이, PostgreSQL RR이 phantom을 안 보이게 하는 이유)를 전제로,
> 그 두 문서가 "MVCC"라는 단어로 뭉뚱그려 넘긴 내부를 연다.

---

## 1. 개념 — MVCC는 "락 대신 과거 버전을 보여주는" 격리 구현 방식

### 1-1. 락만으로 격리하면 무엇이 문제인가

격리성(I)의 요구는 "동시 트랜잭션이 서로의 중간 상태를 보지 않는다"다.
가장 단순한 구현은 **읽을 때도 락을 잡는 것**이다 — 내가 읽는 행은 남이 못
고치고(공유 락), 남이 고치는 중인 행은 내가 못 읽는다(배타 락에 막힘).
정확하긴 한데 비용이 치명적이다:

- 통계 쿼리 하나가 10만 행을 읽는 동안 그 10만 행에 대한 UPDATE가 전부
  대기한다 — **읽기가 쓰기를 막는다.**
- 주문 한 건을 갱신 중이면 그 주문을 보려는 조회가 전부 대기한다 —
  **쓰기가 읽기를 막는다.**

웹 서비스 트래픽은 읽기가 압도적이다. 읽기마다 락이면 동시성이 죽는다.

### 1-2. MVCC의 아이디어 — 행을 덮어쓰지 말고 버전을 남긴다

MVCC(Multi-Version Concurrency Control, 다중 버전 동시성 제어)는 발상을
바꾼다. **UPDATE를 하더라도 이전 값을 어딘가에 남겨 두면, 읽는 쪽은 락을
기다릴 필요 없이 "자기 시점에 맞는 버전"을 골라 읽으면 된다.** "어딘가"가
어디냐가 DB마다 다르다 — PostgreSQL은 **같은 테이블 페이지 안에**, MySQL의
InnoDB는 별도의 언두 로그에 남긴다 — 이 차이에서 운영 이슈의 모양이
갈라진다(3절).

비유하면 — 문서를 한 부만 두고 "편집 중이니 읽지 마세요" 팻말을 거는 대신
(락), 편집할 때마다 이전 판을 보관하고 읽는 사람에게는 "당신이 들어온 시각
기준 최신 판"을 건네는 것이다(MVCC). 편집자와 독자가 서로를 기다리지
않는다. PostgreSQL은 이전 판을 **같은 책상 위에 나란히 쌓아 두는** 쪽이라
책상이 어질러지고(bloat), 주기적으로 치우는 사람(VACUUM)이 필요하다.

이로부터 MVCC의 성질이 한 문장으로 정리된다 — **"읽기는 쓰기를 막지 않고,
쓰기는 읽기를 막지 않는다. 단, 쓰기끼리는 여전히 락이다."** 마지막 절이
중요하다. 같은 행을 두 트랜잭션이 동시에 UPDATE하는 충돌은 버전을 아무리
쌓아도 해결되지 않는다 — 누가 먼저 쓸지 정해야 하고 그건 락의 일이다.
MVCC는 격리성의 **읽기 절반**을 맡고, 나머지 쓰기 절반은 락이 맡는다.

### 1-3. ACID와 연결 — I의 두 축, 그리고 "옛 버전"의 겸직

[ACID 문서](./05-transaction-acid.md)에서 I(격리성)의 메커니즘을 "락 + MVCC"로
적었다. 이제 그 뜻이 정확해진다:

- **I = 락(쓰기-쓰기 충돌 직렬화) + MVCC(읽기-쓰기 비차단)**
- 그리고 MVCC가 "이전 버전"을 보관하는 장소가 PostgreSQL에서는 **힙 그
  자체**다.

여기서 힙에 남은 옛 버전이 **두 글자를 겸직**한다는 점을 짚어야 한다. ACID
문서에서 PostgreSQL의 A(원자성)는 "롤백 = `pg_xact`에 abort 표시 한 줄"이었다.
그게 가능한 이유가 옛 버전이 그대로 남아 있기 때문이다 — 롤백된 트랜잭션이
만든 새 튜플은 "abort된 XID가 만든 것"이라 아무에게도 안 보이고, 지우려던
옛 튜플은 "abort된 XID가 지우려던 것"이라 여전히 보인다. **되돌릴 것이
없다.** 같은 튜플 버전 하나가 **롤백 안전장치(A)**이자 **과거 버전
제공용(I)**이다. 이 겸직 때문에 PostgreSQL의 청구서는 "롤백이 오래 걸림"이
아니라(롤백은 항상 즉시다) **"안 보이게 된 튜플이 자리를 차지한 채 남아
있음"(bloat)** 하나로 모이고, 그걸 치우는 청소부가 VACUUM이다.

> MySQL 대조: InnoDB는 이 겸직을 별도의 **언두 로그**가 맡는다 — 롤백은
> 언두 역순 적용 비용, 긴 트랜잭션의 청구서는 "언두 팽창 + 버전 체인
> 순회"(2-2, 3-2).

---

## 2. PostgreSQL 구현 — 세 부품: 튜플 헤더 · 힙 속 버전 · 스냅샷(+ pg_xact)

### 2-1. 튜플 헤더의 시스템 컬럼 (암기 목록)

PostgreSQL은 사용자가 정의한 컬럼 앞에 튜플 헤더(23바이트, 정렬 후 24)를
붙인다. MVCC의 주역은 다음이다:

| 시스템 컬럼 | 크기 | 뜻 |
|---|---|---|
| `xmin` | 4바이트 | 이 튜플(버전)을 **INSERT한(만든) 트랜잭션의 ID** |
| `xmax` | 4바이트 | 이 튜플을 **DELETE하거나 UPDATE로 대체한 트랜잭션의 ID**. 0이면 살아 있음. 행 락(`FOR UPDATE`)도 여기에 기록된다 |
| `cmin`/`cmax` | 4바이트(공용) | 같은 트랜잭션 안에서 몇 번째 명령이 만들고/지웠는가 — "내 트랜잭션 안에서 이전 문장의 결과는 보이고 현재 문장의 결과는 안 보이게" |
| `ctid` | 6바이트 | 이 튜플의 물리 위치 `(블록 번호, 오프셋)` = TID. 헤더의 `t_ctid`는 UPDATE로 대체된 튜플에서 **다음 버전의 위치**를 가리킨다 → 버전 체인 |
| infomask(힌트 비트) | 2+2바이트 | `xmin`/`xmax`가 **커밋됐는지·abort됐는지** 한 번 확인한 결과를 캐시. `HEAP_XMAX_LOCK_ONLY`(락만 잡음), `HEAP_HOT_UPDATED`(HOT 체인) 등 |

앞의 넷은 그냥 SELECT할 수 있다:

```sql
SELECT xmin, xmax, ctid, id, stock FROM item WHERE id = 1;
--  xmin | xmax | ctid  | id | stock
--   120 |    0 | (7,4) |  1 |     7
-- xmax = 0 → 살아 있는 버전. ctid (7,4) → 7번 블록의 4번째 슬롯. "내게 보이는 버전"만
-- 나온다 — 죽은 옛 버전까지 보려면 pageinspect 확장(heap_page_items).
```

트랜잭션 ID(XID)는 **트랜잭션이 처음 쓰기를 할 때 32비트 카운터에서 단조
증가로 발급**된다(읽기만 하는 트랜잭션은 XID를 받지 않는다). 크기 비교가 곧
시간 순서 비교다 — 스냅샷 판정이 숫자 비교로 가능한 이유이자, 3-4절
wraparound 문제의 씨앗이다.

### 2-2. 힙 속 버전 체인 — UPDATE는 "새 튜플 INSERT + 옛 튜플에 xmax"

`UPDATE item SET stock = 7 WHERE id = 1`을 XID 120이 실행할 때 PostgreSQL이
하는 일을 순서대로 놓으면 버전 체인이 저절로 그려진다:

1. 옛 튜플 `(7,3)`의 `xmax`에 **120**을 적는다 — 값은 건드리지 않는다.
2. 새 값으로 **새 튜플을 만들어 빈 공간에 넣는다** — `xmin = 120, xmax = 0`.
   같은 페이지에 자리가 있으면 같은 페이지(HOT 가능성, 2-6), 없으면 Free
   Space Map이 알려 주는 다른 페이지.
3. 옛 튜플의 `t_ctid`를 새 튜플 위치 `(7,4)`로 바꾼다.

```text
힙 페이지 #7 (8KB) — id=1인 "한 행"의 버전 네 개가 같은 페이지에 나란히 있다
 ┌────────────────────────────────────────────────────────────────────────┐
 │ (7,1)  id=1 stock=10  xmin=90   xmax=101  t_ctid=(7,2)  ← 죽음(101 커밋) │
 │ (7,2)  id=1 stock=9   xmin=101  xmax=115  t_ctid=(7,3)  ← 죽음           │
 │ (7,3)  id=1 stock=8   xmin=115  xmax=120  t_ctid=(7,4)  ← 죽음           │
 │ (7,4)  id=1 stock=7   xmin=120  xmax=0    t_ctid=(7,4)  ← 현재 버전      │
 └────────────────────────────────────────────────────────────────────────┘
   ← 오래된               t_ctid를 따라 과거 → 최신 순으로 이어진다          최신 →

  * 언두 같은 별도 공간이 없다. 옛 버전은 테이블 페이지 안에 그대로 "자리 차지 중".
  * 어떤 스냅샷에도 안 보이게 된 (7,1)~(7,3)이 "죽은 튜플(dead tuple)" — VACUUM이 회수
```

**행 하나에 버전이 여러 개 존재하되, 전부 테이블(힙) 안에 있다.** 최신
하나만 테이블에 두고 나머지를 딴 데 매다는 구조가 아니다. DELETE는 더
단순하다 — `xmax`에 내 XID를 적는 것이 전부다. 행은 물리적으로 안 지워진다.
아직 그 행을 봐야 할 스냅샷이 있을 수 있기 때문이다.

**롤백은 어떻게 되나 (가산점 포인트)** — 아무것도 되돌리지 않는다. `pg_xact`
(CLOG — XID당 2비트로 "진행 중/커밋/abort"를 기록하는 장부)에 "120 = abort"
한 줄을 적으면 끝이다. 120이 만든 `(7,4)`는 "abort된 XID가 만든 튜플"이 되어
**누구에게도 안 보이고**(죽은 튜플), 120이 xmax를 적은 `(7,3)`은 **여전히
보인다.** INSERT의 롤백도 마찬가지 — 삽입된 튜플이 죽은 튜플로 남는다. 그래서
PostgreSQL에서는 **"대량 INSERT 후 롤백"도 bloat를 만든다.**

> MySQL 대조: InnoDB는 옛 값을 **언두 로그 레코드로 복사**하고 행을
> **제자리에서 덮어쓴** 뒤, 숨은 컬럼 `DB_ROLL_PTR`로 언두 레코드들을 **연결
> 리스트**로 잇는다. 테이블엔 최신 하나뿐이고 과거는 언두 세그먼트에 매달린다.
> 롤백은 그 사슬을 역순 적용하고, INSERT용 언두는 커밋 즉시 폐기돼 롤백된
> INSERT가 흔적을 남기지 않는다 — PostgreSQL과 정반대다.

### 2-3. 스냅샷 (암기 목록) — "내 눈에 끝난 것으로 보이는 트랜잭션의 경계"

버전들이 "재료"라면, 스냅샷은 "어느 버전을 고를지 정하는 기준"이다. 문장
(또는 트랜잭션)을 시작하는 순간 PostgreSQL은 **그 시점에 어떤 트랜잭션이
아직 안 끝났는지**를 찍어 둔다. 구성 요소는 셋이다:

| 구성 요소 | 뜻 |
|---|---|
| **`xmin` (하한선)** | 스냅샷 시점에 **진행 중이던 가장 작은 XID**. 이보다 작은 XID는 전부 끝났다(커밋이든 abort든) |
| **`xmax` (상한선)** | 스냅샷 시점에 **아직 발급되지 않은 다음 XID**. 이 이상은 내 스냅샷 이후 시작 → **무조건 안 보임** |
| **`xip` (진행 중 목록)** | 하한선과 상한선 사이에서 **스냅샷 시점에 진행 중이던 XID들** |

```sql
SELECT pg_current_snapshot();     -- PG 13+ (이전 이름 txid_current_snapshot)
--  1001:1010:1001,1003,1007
--  하한선 1001, 상한선 1010, 진행 중 = {1001, 1003, 1007}
--  → 1001·1003·1007: 안 보임 / 1002·1004~1006·1008·1009: 끝남 / 1010 이상: 안 보임
```

> **용어 함정** — 스냅샷의 `xmin`/`xmax`와 튜플 헤더의 `xmin`/`xmax`는
> **이름만 같고 다른 것**이다. 튜플의 것은 "이 버전을 만든/지운 XID",
> 스냅샷의 것은 "보이는 경계". 헷갈리면 스냅샷 쪽은 "하한선·상한선·진행 중
> 목록"으로 부른다.

"끝났다"가 커밋과 abort를 구분하지 않는다는 점에 주의한다. PostgreSQL은
abort된 트랜잭션의 튜플도 힙에 남기므로, 끝난 XID에 대해서는 **`pg_xact`에서
커밋인지 abort인지** 한 번 더 확인해야 한다. 매번 뒤지면 느리니 **처음
확인한 백엔드가 결과를 튜플의 힌트 비트에 적어 둔다**(`HEAP_XMIN_COMMITTED`
등). (가산점 포인트) 이 힌트 비트 쓰기가 **페이지를 더럽힌다** — 대량 적재
직후 첫 SELECT가 뜻밖의 쓰기 I/O를 내는, "SELECT가 디스크 쓰기를 만드는"
PostgreSQL 특유의 현상이다.

**튜플 하나가 내 스냅샷에 보이는가**의 판정은 xmin과 xmax를 각각 묻는 두
단계다 (순서대로 적용):

```text
[1단계] xmin — 이 버전을 만든 트랜잭션이 내 기준으로 "커밋 완료"인가?
  ① xmin == 내 XID                 → 통과 (내가 만든 건 나에게 보인다 — 이전 명령의 것이면)
  ② xmin ≥ 상한선 또는 xip에 있음    → 안 보임 (내 스냅샷 시점에 진행 중 — 그 후 커밋됐어도 무관)
  ③ 그 외 (스냅샷 기준 끝남)         → pg_xact 확인: abort → 안 보임(영원히) / 커밋 → 통과

[2단계] xmax — 이 버전을 지운 트랜잭션이 내 기준으로 "커밋 완료"인가?
  ④ xmax == 0 (또는 락만 잡은 표시)   → 보임
  ⑤ xmax == 내 XID                 → 안 보임 (내가 지웠다)
  ⑥ xmax 진행 중 (②와 같은 기준)     → 보임 (내 기준으로는 아직 안 지워졌다)
  ⑦ xmax 끝남                      → pg_xact 확인: 커밋 → 안 보임 / abort → 보임
```

한 문장으로 — **"xmin은 커밋되어 보여야 하고, xmax는 커밋되어 보이면 안
된다."** ②와 ⑥이 핵심이다 — 스냅샷 이후에 커밋된 변경은 커밋됐더라도
나에게는 없는 일이다. 이 규칙 덕분에 **"내가 스냅샷을 찍은 순간 커밋되어
있던 세상"**이 정확히 재구성된다.

### 2-4. 한 행을 읽는 절차 — 체인 순회가 아니라 "버전마다 각자 판정"

일반 SELECT(Seq Scan)가 페이지를 훑을 때:

```text
페이지의 모든 튜플에 대해 각각 2-3의 판정을 돌린다 → 보이면 결과에 포함, 안 보이면 건너뜀
  (7,1) stock=10 xmin=90  xmax=101 → xmax 101 커밋 → 안 보임, 건너뜀
  (7,2) stock=9  xmin=101 xmax=115 → 안 보임, 건너뜀
  (7,3) stock=8  xmin=115 xmax=120 → 안 보임, 건너뜀
  (7,4) stock=7  xmin=120 xmax=0   → xmin 120 커밋, xmax 0 → 보임 ★
```

**락은 어디에도 없다.** 남이 지금 그 행을 UPDATE 중이어도(옛 튜플에 xmax를
적고 새 튜플을 만드는 중이어도) 나는 "xmax가 진행 중이니 옛 버전이
보인다"(⑥)로 판정하고 지나간다. 이것이 "읽기가 락을 안 잡는" 정확한 이유다.

InnoDB와 결정적으로 다른 점 — **과거로 거슬러 올라가는 체인 순회가 없다.**
모든 버전이 힙에 나란히 있으니 각 튜플을 독립적으로 판정하면 된다. 대신
**비용의 씨앗이 다른 곳에 있다** — 죽은 튜플 `(7,1)`~`(7,3)`도 페이지 안에
있으므로 **읽고 판정하고 버려야 한다.** 한 행에 죽은 버전이 100개면 살아
있는 한 건을 찾기 위해 101개를 판정하고, 페이지가 죽은 튜플로 차면 같은 행
수를 읽는 데 페이지가 몇 배로 필요하다. 3절의 사슬이 여기서 출발한다.

**인덱스는 어떤가 (가산점 포인트)** — 인덱스 엔트리에는 xmin/xmax가 **없다.**
"키 → TID"만 알므로 Index Scan은 TID를 얻은 뒤 **힙으로 가서** 판정한다.
그리고 비-HOT UPDATE는 새 버전마다 인덱스 엔트리를 더 만들므로 **한 행의
모든 버전이 인덱스에 다 들어 있다** — VACUUM이 치울 때까지 인덱스도 부푼다.
3-3절 Index Only Scan이 visibility map을 봐야 하는 이유다.

### 2-5. 격리 수준별 스냅샷 시점 (암기) — 차이는 "언제 찍느냐" 하나

| 격리 수준 | 스냅샷 | 결과 |
|---|---|---|
| READ UNCOMMITTED | **문법만 있고 READ COMMITTED로 동작** | dirty read 자체가 불가능 — 커밋 안 된 버전을 보여줄 경로가 구조상 없다 |
| **READ COMMITTED (기본)** | **문장마다 새 스냅샷** | 매 SELECT가 그 순간 커밋된 최신을 봄 → non-repeatable read·phantom 허용 |
| **REPEATABLE READ** | **트랜잭션의 첫 문장에서 한 번 찍고 끝까지 재사용** | 같은 스냅샷을 계속 봄 → non-repeatable read·**phantom 둘 다 안 보임**(스냅샷 격리). 동시 갱신 충돌 시 `40001` |
| SERIALIZABLE | RR과 같은 트랜잭션 스냅샷 + **SSI**(읽기/쓰기 의존성 추적) | 읽기가 락을 잡아 남을 막지 않는다. 직렬화 불가능한 패턴이 보이면 `40001`로 abort → **재시도 필수** |

**RC와 RR의 내부 차이는 코드 몇 줄 — "스냅샷을 문장마다 새로 찍느냐,
트랜잭션당 한 번 찍느냐"다.** 격리 수준 문서에서 "RR은 첫 읽기 시점의
스냅샷을 유지한다"고 한 문장의 실체가 이것이다. 그리고 PostgreSQL의 RR은
스냅샷 하나로 phantom까지 안 보이게 한다 — 스냅샷 이후 INSERT된 행은 xmin이
상한선 이상이라 그냥 안 보이기 때문이다(InnoDB처럼 갭 락이 필요 없는 이유).

주의할 디테일 두 가지 (가산점 포인트):

- RR의 스냅샷은 `BEGIN` 시점이 아니라 **첫 문장(SELECT 등)을 실행하는
  순간** 만들어진다. `BEGIN` 후 한참 있다가 첫 SELECT를 하면 스냅샷은 그
  SELECT 시점이다. 여러 세션이 같은 스냅샷을 공유해야 하면
  `pg_export_snapshot()` / `SET TRANSACTION SNAPSHOT`(병렬 `pg_dump`가 쓰는
  장치)이 있다.
- **스냅샷 읽기 vs 갱신의 "최신 버전 추적"**: 스냅샷을 그대로 쓰는 건 **일반
  SELECT뿐**이다. `UPDATE`·`DELETE`·`SELECT ... FOR UPDATE`는 스냅샷으로 후보
  행을 찾은 뒤 **그 행의 최신 버전을 따라간다.** 최신 버전을 다른 트랜잭션이
  갱신 중이면 **끝날 때까지 대기**하고(행 락 = xmax), 끝나면 — RC에서는 새
  버전에 WHERE를 **다시 평가해서**(EvalPlanQual) 통과하면 그 위에 적용하고,
  RR에서는 "내 스냅샷 이후 바뀐 행"이므로 `ERROR 40001 could not serialize
  access due to concurrent update`로 포기한다.

이 디테일에서 자연스럽게 나오는 실무 함정 하나 — RC에서 내 SELECT는 그
문장 시점의 값을 보는데 내 UPDATE는 최신 행에 적용된다. "SELECT로 재고 10개
확인 → `UPDATE SET stock = 9`"는 그 사이 남이 재고를 3으로 줄였어도 9로
덮어쓴다(갱신 유실). 꼬리질문 4에서 다룬다.

### 2-6. HOT(Heap-Only Tuple) — 인덱스를 안 건드리는 UPDATE (가산점 포인트)

"비-HOT UPDATE는 모든 인덱스에 새 엔트리"라면, 인덱스가 5개인 테이블에서
인덱스와 무관한 컬럼(`last_seen_at`)을 갱신할 때마다 인덱스 5개를 고쳐야
하나? 그걸 피하는 최적화가 HOT이다. 조건 둘 — ① **인덱스에 들어간 컬럼이
하나도 안 바뀌고** ② 새 버전이 **옛 버전과 같은 페이지에** 들어갈 자리가
있을 때 → 인덱스는 건드리지 않고, 인덱스 엔트리가 가리키는 옛 튜플에서
`t_ctid`를 따라 최신 버전에 도달한다(PostgreSQL에 남은 유일한 "체인 순회").
죽은 HOT 튜플은 VACUUM을 기다리지 않고 **그 페이지를 다음에 건드리는
백엔드가 즉석에서 정리**(page pruning)한다 — 인덱스를 안 고쳐도 되니 가능하다.

```sql
-- ❌ 자주 바뀌는 컬럼을 인덱스에 넣으면 그 컬럼의 UPDATE가 전부 HOT에서 탈락한다
CREATE INDEX idx_users_last_seen ON users (last_seen_at);
-- 로그인마다 last_seen_at UPDATE → 이 인덱스뿐 아니라 users의 "모든" 인덱스에 새 엔트리

-- ✅ HOT 여지를 남긴다 — 자주 바뀌는 컬럼은 인덱스 밖에 두고, 페이지에 빈자리를 예약
ALTER TABLE users SET (fillfactor = 85);   -- 페이지의 15%를 UPDATE용으로 비워 둠 (기본 100)
-- 효과 확인: n_tup_hot_upd / n_tup_upd 비율이 올라가야 한다
SELECT n_tup_upd, n_tup_hot_upd FROM pg_stat_user_tables WHERE relname = 'users';
```

[복합 인덱스 문서 §4](./08-composite-index-column-order.md)의 "자주 바뀌는
컬럼을 인덱스에 넣는 대가"가 정확히 이 HOT 탈락이다.

---

## 3. 비용 — "긴 트랜잭션 → VACUUM 정지 → 죽은 튜플 누적(bloat) → 조회 저하" 사슬

이 절이 이 문서가 가장 겨냥하는 지점이다. "긴 트랜잭션은 안 좋다"가 아니라
**어떤 부품이 어떤 순서로 막혀서 누구의 무엇이 느려지는지**를 이름 붙여
말해야 한다.

### 3-1. VACUUM은 무엇을 하는가

VACUUM은 PostgreSQL의 청소부다(autovacuum 워커가 백그라운드에서 자동 실행).
하는 일 — ① 어떤 스냅샷에도 더 이상 안 보이는 **죽은 튜플을 회수**해 페이지
안 공간을 재사용 가능하게 만든다(Free Space Map 갱신). 파일 크기는 **줄이지
않는다** — 파일 끝의 완전히 빈 페이지만 OS에 돌려준다. ② 그 죽은 튜플을
가리키던 **인덱스 엔트리를 제거**한다(인덱스 전체를 훑어야 해서 비싸다).
③ **visibility map**(페이지의 모든 튜플이 모두에게 보이는가)을 갱신한다 →
Index Only Scan이 힙을 건너뛰는 근거(3-3). ④ 오래된 xmin을 **freeze**해 XID
wraparound를 막는다(3-4). ⑤ `pg_class.reltuples` 통계를 갱신한다.

"더 이상 안 보인다"의 판정 기준은 단순하다 — **현재 살아 있는 가장 오래된
스냅샷(또는 진행 중인 가장 오래된 XID)**보다 뒤에 죽은 튜플은 못 치운다. 이
경계를 **xmin horizon**이라 부르고, 각 세션이 잡고 있는 값이
`pg_stat_activity.backend_xmin`(스냅샷)·`backend_xid`(진행 중 XID)다. 바꿔
말하면 **가장 오래된 스냅샷 하나가 VACUUM의 진도를 결정한다.** 죽었지만 아직
못 치운 튜플의 수가 `pg_stat_user_tables.n_dead_tup` — MVCC 건강의 대표 지표다.

autovacuum이 테이블 하나를 돌리는 임계는 `autovacuum_vacuum_threshold`(50) +
`autovacuum_vacuum_scale_factor`(0.2) × 행 수. 1억 행 테이블이면 **2천만 행이
죽어야** 시작한다는 뜻이라, 큰 테이블은 테이블 단위로 낮춘다:
`ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01)`. 그리고
`VACUUM FULL`은 이름만 같고 다른 물건이다 — 테이블을 **새 파일로 통째
재작성**해 파일 크기까지 줄이지만 `ACCESS EXCLUSIVE` 락(읽기까지 차단)과
원본 크기만큼의 디스크 여유가 필요하다. 운영 중에는 `pg_repack`(확장)으로
대체한다. 일상의 VACUUM은 읽기·쓰기를 막지 않는 약한 락만 잡고 동시에 돈다.

> MySQL 대조: InnoDB의 청소부는 **purge 스레드**(어떤 Read View도 필요로
> 하지 않는 update undo 폐기 + delete-mark 행·인덱스 엔트리 물리 제거),
> 밀린 양의 지표는 `SHOW ENGINE INNODB STATUS`의 **History list length**.
> "가장 오래된 스냅샷이 청소 진도를 정한다"는 원리는 둘이 같다.

### 3-2. 사슬 — 이름 붙여서 순서대로

```text
① 트랜잭션 하나가 오래 열려 있다
   (RR이면 첫 문장의 스냅샷을 커밋까지 보유 = backend_xmin 고정.
    RC라도 한 줄이라도 썼으면 배정받은 XID 자체가 horizon = backend_xid)
      ↓
② VACUUM이 그 horizon 이후에 죽은 튜플을 하나도 치우지 못한다
   — "가장 오래된 스냅샷이 볼 수도 있는 버전"이라서. 이 트랜잭션이 그 테이블을
     안 보더라도 무관하다. horizon은 테이블 단위가 아니라 DB 전체다.
      ↓
③ n_dead_tup이 계속 증가 — 테이블 파일이 커진다(bloat). 죽은 버전의 인덱스
   엔트리도 못 치우니 인덱스도 함께 부푼다
      ↓
④ 자주 갱신되는 행(핫 로우)의 페이지가 죽은 버전으로 가득 찬다
   — 같은 페이지에 자리가 없으니 HOT도 깨져 새 버전이 다른 페이지로 튀고,
     그때마다 모든 인덱스에 새 엔트리
      ↓
⑤ 그 테이블을 읽는 "다른 모든" 트랜잭션이 죽은 튜플을 읽고·판정하고·버린다
   — 같은 행 수를 얻는 데 페이지를 몇 배로 읽고(I/O), 튜플마다 가시성 판정(CPU).
     범인이 아닌 짧은 조회들까지 느려진다. shared_buffers가 죽은 튜플로 오염돼
     정작 살아 있는 데이터의 적중률이 떨어진다.
      ↓
⑥ visibility map이 낡아 Index Only Scan이 힙 페치로 퇴화한다 (3-3)
   — 커버링 인덱스로 설계한 조회가 조용히 느려진다. reltuples 통계도 왜곡돼
     플래너가 엉뚱한 계획을 고르기 시작한다
      ↓
⑦ 마침내 긴 트랜잭션이 끝나면 밀린 autovacuum이 한꺼번에 돌아 I/O 스파이크.
   그래도 파일 크기는 안 줄어든다 — 부푼 채로 남는다(pg_repack/VACUUM FULL 전까지).
   그 사이 age(datfrozenxid)도 계속 자라 wraparound 경보에 가까워진다 (3-4)
```

이 사슬의 각 단계를 이름으로 부를 수 있어야 한다 — **스냅샷(horizon) 보유 →
VACUUM 정지 → n_dead_tup 증가·bloat → 핫 로우 페이지 포화·HOT 붕괴 → 죽은
튜플 스캔 비용(무관 트랜잭션 전파) → visibility map 노후·통계 왜곡 → 종료 시
VACUUM 폭주, bloat 잔존.** "조회가 느려진다"에서 멈추면 결과만 말한 것이고,
"왜 무관한 조회까지"에 답하려면 ②와 ⑤가 있어야 한다.

핵심 통찰을 한 문장으로 — **MVCC의 청구서는 트랜잭션이 "무엇을 했는가"가
아니라 "얼마나 오래 열려 있었는가"에 비례하고, 그 청구서를 받는 건 그
트랜잭션이 아니라 남들이다.** 그리고 PostgreSQL에서는 트랜잭션이 끝난
뒤에도 **bloat라는 형태로 청구서가 남는다.**

> MySQL 대조: InnoDB의 같은 사슬은 "Read View 보유 → purge 정지 → History
> list length 증가 → 버전 체인 길이 증가 → 조회마다 **체인 순회**(언두 페이지
> I/O, 버퍼 풀 오염) → 종료 시 purge 폭주"다. 비용의 자리가 "체인 순회" vs
> "죽은 튜플 스캔·bloat"로 다르다.

### 3-3. 인덱스와 MVCC — Index Only Scan이 조용히 무력화되는 순간 (가산점 포인트)

인덱스 엔트리에는 xmin/xmax가 없다(2-4). 그럼 인덱스만 읽어서 끝내는 커버링
조회([09 문서](./09-covering-index.md))는 버전 판정을 어떻게 하나?
PostgreSQL은 **visibility map(VM)** — 페이지당 1비트 "이 페이지의 모든
튜플은 모든 트랜잭션에 보인다(all-visible)" — 를 둔다. VACUUM이 페이지를
정리하며 이 비트를 켠다. Index Only Scan은 TID의 페이지 번호로 VM을 보고,
비트가 켜져 있으면 힙을 안 간다. **그런데 그 페이지에 누군가
INSERT/UPDATE/DELETE를 하면 비트가 꺼지고**, 다음 VACUUM 전까지 그 페이지의
튜플은 **힙으로 내려가 헤더를 확인**해야 한다 — 계획에 `Heap Fetches: N`으로
찍힌다.

```text
 Index Only Scan using idx_orders_user_created on orders
   Index Cond: (user_id = 100)
   Heap Fetches: 0          ← VM이 신선 — 진짜 커버링
   ...
   Heap Fetches: 18342      ← VM이 낡음 — 이름만 Index Only, 사실상 Index Scan + 랜덤 힙 접근
```

커버링 인덱스로 설계했는데 갱신이 잦은 테이블에서, 특히 긴 트랜잭션이
VACUUM을 막고 있는 동안, 힙 페치(랜덤 I/O)가 되살아나는 것이다. "커버링
인덱스인데 왜 느리지"의 숨은 원인 하나가 MVCC이고, 처방은 인덱스가 아니라
**VACUUM**이다. (InnoDB는 세컨더리 인덱스 페이지의 `PAGE_MAX_TRX_ID`로 같은
판정을 하고, 최근 수정된 페이지면 클러스터드 인덱스로 내려간다 — 현상은
같고 장치가 다르다.)

### 3-4. XID wraparound — 청소를 너무 오래 미루면 DB가 멈춘다 (가산점 포인트)

XID는 32비트라 약 43억에서 한 바퀴 돈다. PostgreSQL은 이를 원형으로 해석해
"내 XID 기준 과거 약 21억 개"까지만 과거로 인정한다. 즉 **21억 트랜잭션이
지나면 옛날 튜플의 xmin이 "미래"로 뒤집혀 안 보이게 된다** — 데이터가
사라진 것처럼 보이는 재앙이다. 이를 막으려고 VACUUM은 충분히 오래된 튜플의
xmin을 **frozen**("영원히 과거") 표시로 바꾼다. `age(datfrozenxid)`가
`autovacuum_freeze_max_age`(기본 2억)에 닿으면 **취소되지 않는
anti-wraparound VACUUM**이 강제로 돌고, 그것마저 막혀 한계에 가까워지면
새 XID 발급을 거부한다(쓰기 불가). 긴 트랜잭션은 여기서도 범인이다 —
horizon보다 새로운 튜플은 freeze할 수 없어 진도가 거기서 못 나아간다 —
"며칠 열린 트랜잭션 하나 때문에 새벽에 anti-wraparound VACUUM이 대형
테이블에서 돌았다"가 전형적 사고다.

### 3-5. 실무에서 사슬 ①을 만드는 전형적인 코드

가장 흔한 범인은 **트랜잭션 안의 외부 호출**이다. 락 점유·커넥션 풀 고갈
관점의 피해는 [ACID 문서의 "긴 트랜잭션" 꼬리질문](./05-transaction-acid.md)에서
다뤘고, 여기서는 **MVCC 관점**의 피해를 붙인다 — 이 코드가 도는 동안 DB
전체의 VACUUM horizon이 이 트랜잭션에 묶인다.

```java
// ❌ before: 트랜잭션 안에서 외부 결제사 API 호출
@Transactional
public void settle(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.markCapturing();
    orderRepository.saveAndFlush(order);
    // ↑ 여기서 UPDATE가 나가며 이 트랜잭션에 XID가 배정된다.
    //   이 순간부터 커밋까지 이 XID가 DB 전체의 VACUUM horizon이 된다
    //   (격리 수준이 RR이면 첫 findById의 스냅샷부터 이미 묶여 있다)

    CaptureResult result = paymentGateway.capture(order);
    // ↑ 외부 HTTP. 평소 300ms, 결제사 장애 시 30초 타임아웃 × 재시도.
    //   그동안 이 트랜잭션은 "가장 오래된 진행 중 트랜잭션"이 되어
    //   DB의 모든 테이블에서 죽은 튜플 회수를 막는다. 행 락과 커넥션도 점유.

    order.markPaid(result);
}   // 커밋 → 그제야 horizon 전진 → 밀린 autovacuum 폭주
```

```java
// ✅ after: 읽기 트랜잭션 / 외부 호출 / 쓰기 트랜잭션을 분리
public void settle(Long orderId) {
    OrderSnapshot snapshot = orderTxService.loadForSettlement(orderId);
    // ↑ 짧은 @Transactional(readOnly = true) — 수 ms 안에 스냅샷 생성·해제.
    //   읽기 전용이라 XID도 배정받지 않는다

    CaptureResult result = paymentGateway.capture(snapshot);
    // ↑ 트랜잭션 밖. 30초가 걸려도 DB는 아무것도 붙들지 않는다.

    orderTxService.markPaid(orderId, result);
    // ↑ 별도의 짧은 @Transactional — 상태 검증(이미 처리됐는지) 후 갱신
}
// orderTxService는 별도 빈이어야 @Transactional 프록시가 적용된다(자기 호출 함정)
```

한 가지 정확히 해 두면 (가산점 포인트) — RC에서 **읽기만 하고 노는
트랜잭션**은 문장이 끝나면 스냅샷을 놓아(열린 커서가 없다면) VACUUM은 막지
않는다(`backend_xmin`이 빈다 — 커넥션과 락은 붙든다). 그러나 **한 줄이라도
썼으면** XID가 horizon이 되고, **RR이면 읽기만 해도** 첫 문장의 스냅샷이
커밋까지 horizon을 잡는다. "RC가 기본값이니 괜찮다"는 방심이 위 before의
"상태를 바꿔 두고 외부 호출" 패턴에서 깨진다.

두 번째 범인은 **사람이 연 콘솔 트랜잭션**이다 — 수동 커밋 모드의 DB
클라이언트에서 `UPDATE` 한 번 날리고 창을 켜 둔 채 퇴근하면, 그 세션이
밤새 `idle in transaction` 상태로 "가장 오래된 XID"가 된다. 덤으로 그
테이블에 잡은 락이 새벽 배포의 `ALTER TABLE`(ACCESS EXCLUSIVE)을 막고, 그
뒤로 오는 모든 SELECT까지 줄 세운다([14 문서](./14-online-ddl-zero-downtime-schema-change.md)).
코드 리뷰로는 절대 못 잡는 유형이라 4-2절의 DB 쪽 안전망이 필요하다.

---

## 4. 트레이드오프 양면 조립 + 안전망 고정

### 4-1. MVCC의 양면 — 한 호흡으로

"MVCC는 읽기 성능이 좋다"까지만 말하면 절반이다. 얻는 것과 내는 것을 같은
문장에 넣는다.

| 축 | 얻는 것 | 내는 것 |
|---|---|---|
| 읽기 | 락 없이 일관된 스냅샷 — 읽기와 쓰기가 서로 안 막힘 | 튜플마다 가시성 판정 + **죽은 튜플까지 읽고 버림**(CPU·I/O), 첫 조회의 힌트 비트 쓰기 |
| 쓰기 | 읽기에 막히지 않음. 롤백이 O(1) | UPDATE = 새 튜플 + 옛 튜플 잔존(쓰기 증폭). 비-HOT이면 **모든 인덱스**에 새 엔트리. 쓰기끼리는 여전히 락 |
| 저장 공간 | 별도 언두 공간 불필요 | 테이블·인덱스 bloat, VACUUM 백그라운드 부하, wraparound 관리 의무 |
| 정합성 | 긴 리포트도 일관된 결과를 봄. RR이 스냅샷만으로 phantom까지 차단 | 스냅샷은 "과거"다 — 판단(check-then-act)에 쓰면 갱신 유실 위험 |

조립한 문장: **"MVCC는 읽기 락을 없애 읽기-쓰기 비차단을 얻는 대신,
PostgreSQL에서는 그 대가를 힙에 남는 죽은 튜플·인덱스 bloat·VACUUM 부하로
치른다. 그 청구서는 트랜잭션 길이에 비례해 커지고, 범인이 아닌
트랜잭션들에게 배달되며, 트랜잭션이 끝난 뒤에도 부푼 파일로 남는다."** 이
문장이 그대로 "그래서 트랜잭션은 짧게"의 근거가 된다.

한 겹 더 (시니어 변별): 이 트레이드오프는 **읽기 위주 OLTP 워크로드에
최적화된 선택**이다. 같은 행을 초고빈도로 갱신하는 워크로드(조회수 카운터,
재고)에서는 PostgreSQL이 InnoDB보다 **더 불리하다** — UPDATE마다 새 튜플이
생기니 한 행이 초당 수천 번 바뀌면 페이지가 순식간에 죽은 버전으로 차고,
HOT이 깨지고, autovacuum이 못 따라간다. 여기에 쓰기끼리 락 직렬화까지
겹친다. 그런 구간은 원자적 UPDATE·Redis 버퍼링·배치 반영·카운터 행 분할로
설계를 바꾸는 것이 답이지 격리 수준을 만지는 게 아니다
([23 문서](./23-high-frequency-counter-hot-row.md)).

### 4-2. 안전망 — 기억이 아니라 시스템이 잡게 한다

"트랜잭션을 짧게 유지하자"는 규칙을 사람의 기억에 맡기면 반드시 뚫린다.
DB 쪽과 애플리케이션 쪽에 **각각** 고정한다.

**DB 쪽 — 지금 누가 VACUUM을 막고 있는지 즉시 찾는 쿼리**

```sql
-- ① 열려 있는 트랜잭션, 오래된 순. state가 'idle in transaction'인데 xact_age가 크면
--    "쿼리는 안 돌고 트랜잭션만 열어 둔" 전형적 범인 (외부 호출 대기, 콘솔 방치)
SELECT pid, state, now() - xact_start AS xact_age,
       backend_xid,      -- 값이 있으면 무언가를 썼다 → horizon을 잡는 중
       backend_xmin,     -- 값이 있으면 스냅샷을 쥐고 있다 → horizon을 잡는 중
       left(query, 80) AS last_query
  FROM pg_stat_activity
 WHERE xact_start IS NOT NULL
 ORDER BY xact_start LIMIT 10;

-- ② horizon이 얼마나 뒤처져 있나 — 그 뒤로 쌓인 XID 수. 급증 = 어딘가 긴 트랜잭션
SELECT max(age(backend_xmin)) AS oldest_snapshot_age,
       max(age(backend_xid))  AS oldest_xid_age
  FROM pg_stat_activity;

-- ③ 테이블별 죽은 튜플 — n_dead_tup은 큰데 last_autovacuum이 안 움직이면 ①이 막고 있다
SELECT relname, n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd, last_autovacuum
  FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;

-- ④ wraparound 여유 — 2억(autovacuum_freeze_max_age)에 가까워지면 강제 VACUUM이 온다
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;

SELECT pg_terminate_backend(<pid>);   -- 범인 세션 종료 (쿼리만 취소하려면 pg_cancel_backend)
```

- **②와 ③을 모니터링 지표로 수집해 임계치 알림**을 건다. 평소 대비 급증이
  곧 "어딘가에 긴 트랜잭션이 생겼다"는 신호이며, 조회가 느려지기 **전에**
  잡을 수 있는 선행 지표다(진행 중인 VACUUM은 `pg_stat_progress_vacuum`,
  bloat 실측은 `pgstattuple` 확장).
- 사람이 새벽에 깨서 죽이는 구조는 안전망이 아니다. **서버 설정으로
  고정한다** — `ALTER ROLE app_user SET idle_in_transaction_session_timeout =
  '30s'`(트랜잭션을 연 채 노는 세션을 서버가 끊는다. 역할별로 걸면 배치
  계정만 느슨하게 둘 수 있다), `statement_timeout`(실행 중인 롱 쿼리도
  스냅샷을 쥔다), 트랜잭션 전체 길이 상한은 PG 17부터 `transaction_timeout`.
- **VACUUM horizon을 잡는 건 세션만이 아니다** (가산점 포인트): 사용되지
  않는 **복제 슬롯**(`pg_replication_slots.xmin`), 방치된 **prepared
  transaction**(`pg_prepared_xacts`), `hot_standby_feedback = on`인
  **레플리카의 긴 쿼리**도 프라이머리의 VACUUM을 막는다. ①에 아무도 없는데
  `n_dead_tup`이 안 줄면 이 셋을 본다.
- 이미 생긴 bloat는 `pg_repack`/`VACUUM FULL`/`REINDEX CONCURRENTLY`로(3-1)
  — 단 사후 정리이지 사슬 ①을 막는 게 아니다.

**애플리케이션 쪽 — 긴 트랜잭션을 만들 수 없게**

```java
// 1) 트랜잭션 시간 상한을 코드에 박는다
@Transactional(timeout = 3)   // 초 단위. 초과 시 다음 JDBC 호출/커밋 시점에 예외
public void markPaid(Long orderId, CaptureResult result) { ... }
// 주의: 외부 HTTP 대기 중에는 아무것도 확인되지 않는다 — 결국 호출 자체를
//       밖으로 빼는 게 근본. timeout은 "빼먹은 곳"을 드러내는 2차 안전망이다.

// 2) 구조로 금지 — @Transactional 클래스가 외부 클라이언트를 의존하지 못하게 (ArchUnit)
@ArchTest
static final ArchRule transactional_services_do_not_call_external_clients =
    noClasses()
        .that().areAnnotatedWith(Transactional.class)
        .should().dependOnClassesThat().resideInAnyPackage("..client..", "..external..")
        .because("트랜잭션 안의 외부 호출은 커넥션 점유와 VACUUM 정지를 동시에 일으킨다");
```

```yaml
# 3) 커넥션 장기 점유를 로그로 노출 (HikariCP) — 긴 트랜잭션은 반드시 긴 커넥션 점유를 동반한다
spring:
  datasource:
    hikari:
      leak-detection-threshold: 5000   # ms. 초과 점유 시 스택 트레이스 경고
```

이 세 겹은 역할이 다르다 — ArchUnit은 **만들지 못하게**(빌드 실패),
timeout은 **만들어졌으면 끊게**, leak detection은 **어디서 만들어졌는지
스택으로 알려주게**. 그리고 서버 쪽 `idle_in_transaction_session_timeout`이
애플리케이션 밖(콘솔·배치·다른 팀 서비스)까지 덮는 최후의 그물이다.

---

## 5. 꼬리질문 대비 포인트

### "MVCC가 있는데 왜 락이 여전히 필요한가요?"

MVCC가 없애는 건 **읽기-쓰기 사이의 대기**뿐이다. 두 트랜잭션이 같은 행을
동시에 UPDATE하는 **쓰기-쓰기 충돌**은 버전을 아무리 쌓아도 "누구 것이
최종인가"를 정할 수 없어 직렬화해야 한다 — PostgreSQL은 이 행 락을 별도 락
테이블이 아니라 **튜플 헤더의 xmax에 자기 XID를 적는 것**으로 구현하고, 뒤에
온 트랜잭션은 그 XID의 종료를 기다린다(`pg_locks`의 `transactionid` 대기).
또 `UPDATE`·`DELETE`·`SELECT ... FOR UPDATE`는 스냅샷이 아니라 **최신 버전을
따라가 락을 잡는다** — 스냅샷을 근거로 갱신하면 갱신 유실이 나기 때문이다.
마지막으로 **"아직 없는 행"의 경쟁**(중복 가입, 이중 예약)은 MVCC가 못 막는
일인데, PostgreSQL에는 InnoDB의 갭 락도 없다 — UNIQUE 제약 + `ON CONFLICT`,
advisory lock, 또는 SERIALIZABLE(SSI)로 막는다
([12 문서](./12-gap-lock-next-key-lock-deadlock.md)). 정리하면 — 읽기 절반은
MVCC, 쓰기 절반은 xmax 락, 존재하지 않는 행은 제약·SSI.

### "READ COMMITTED와 REPEATABLE READ의 차이를 PostgreSQL 내부 동작으로 설명해 보세요."

튜플 헤더도 힙 속 버전도 가시성 판정 규칙도 똑같다. 차이는 **스냅샷을 언제
찍느냐** 하나다. RC는 **문장마다 새 스냅샷**을 찍어 매 SELECT가 그 순간
커밋된 최신을 보고, RR은 **트랜잭션의 첫 문장에서 한 번 찍어 끝까지
재사용**한다. 그래서 RC에서는 두 SELECT 사이에 남이 커밋하면 값이 바뀌고,
RR에서는 안 바뀌고 새로 INSERT된 행도 안 보인다(phantom 없음). 갱신 쪽도
갈린다 — 동시 갱신된 행을 만나면 RC는 최신 버전에 WHERE를 재평가해 계속
가고, RR은 `40001`로 포기하니 애플리케이션 재시도가 필요하다. 운영 관점으로
한 줄 더 — RC는 문장이 끝나면 스냅샷을 놓으므로 **읽기만 하는 긴 트랜잭션이
VACUUM을 막는 정도가 훨씬 약하다**(3-5). 배치·통계성 긴 조회를 굳이 RR로
올리지 않는 근거다.

### "긴 트랜잭션 하나가 왜 그것과 무관한 다른 조회까지 느리게 만드나요? 어떻게 확인하죠?"

3-2의 사슬을 이름 붙여 답한다 — 긴 트랜잭션이 스냅샷(`backend_xmin`) 또는
진행 중 XID(`backend_xid`)를 보유 → VACUUM이 그 horizon 이후의 죽은 튜플을
못 치움 — **horizon은 테이블 단위가 아니라 DB 전체**라 무관한 테이블도
영향권 → `n_dead_tup`·bloat 증가 → 그 테이블을 읽는 모든 트랜잭션이 **죽은
튜플을 읽고 판정하고 버리느라** I/O·CPU를 더 씀 → visibility map이 낡아
Index Only Scan이 힙 페치로 퇴화. 확인은 `pg_stat_activity`에서 **`idle in
transaction`인데 `xact_start`가 오래된** 세션(`backend_xid`/`backend_xmin`이
차 있으면 확정)과 `max(age(backend_xmin))`·`n_dead_tup`의 급증. 재발 방지는
지표 알림 + `idle_in_transaction_session_timeout` + 코드 쪽 ArchUnit·timeout.

### "READ COMMITTED에서 SELECT로 재고 10개를 확인하고 UPDATE로 9를 썼는데 재고가 꼬였습니다. REPEATABLE READ로 올리면 해결되나요?" (시니어 변별 포인트)

**스냅샷 읽기와 갱신이 다른 세상을 보기 때문**이다. 일반 SELECT는 그 문장
시점의 스냅샷(10)을 보여 주지만, UPDATE는 **최신 버전**에 적용된다. 그 사이
다른 트랜잭션들이 재고를 3까지 줄여 커밋했어도 내 `SET stock = 9`는 최신
행을 9로 덮어쓴다 — 갱신 유실이다. RR로 올리면 — PostgreSQL의 RR은 "내
스냅샷 이후 남이 바꾼 행"을 갱신하려는 순간 `40001`을 던지므로 **조용히
덮어쓰는 일은 막힌다.** 하지만 해결이 아니라 **예외로 바뀐 것**이다 —
재시도 루프가 없으면 사용자에게 에러가 가고, 재시도해도 "SELECT 후 계산해서
UPDATE" 구조 자체는 경쟁마다 실패한다. 그리고 RR도 서로 다른 행을 읽고 쓰는
write skew는 못 막는다([격리 수준 문서](./transaction-isolation-levels.md)).
고치는 법은 "판단의 근거가 되는 읽기를 없애거나 잠그는 것"이다: ① 가장 싼
건 읽기 자체를 없애는 **원자적 UPDATE** — `UPDATE item SET stock = stock - 1
WHERE id = $1 AND stock >= 1 RETURNING stock`, 영향 행 0이면 재고 부족. ②
차감 전후로 검증 로직이 필요하면 `SELECT ... FOR UPDATE`로 **최신을 읽으면서
잠근다** — 잔액·재고처럼 키가 아닌 컬럼만 바꿀 거면 `FOR NO KEY UPDATE`가 FK
삽입과 충돌하지 않는다([19 문서](./19-select-for-update-lock-scope.md)). ③
충돌이 드물면 버전 컬럼 기반 낙관적 락(`@Version`) + 재시도. 핵심 문장은 —
**"MVCC의 스냅샷은 보고용이고, 결정용 읽기는 잠금 읽기여야 한다."**

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

| | PostgreSQL | MySQL(InnoDB) |
|---|---|---|
| 옛 버전의 위치 | **힙 페이지 안**, 새 버전과 나란히 | **언두 로그**(별도 세그먼트), 테이블엔 최신 하나 |
| UPDATE | 새 튜플 INSERT + 옛 튜플 xmax (in-place 아님) | 제자리 덮어쓰기 + 옛 값을 언두로 복사 |
| 버전 메타데이터 | 튜플 헤더 `xmin`/`xmax`/`ctid` | 숨은 컬럼 `DB_TRX_ID`/`DB_ROLL_PTR` |
| 과거 버전 찾기 | 각 튜플을 독립 판정(체인 순회 없음) | 롤 포인터 따라 **언두 체인 순회** |
| 롤백 | `pg_xact`에 abort 표시 — O(1) | 언두를 역순 적용 — 변경량에 비례 |
| 청소부 / 지표 | **VACUUM**(autovacuum) / `n_dead_tup`, `age(backend_xmin)` | **purge 스레드** / History list length |
| 긴 트랜잭션의 청구서 | bloat(끝나도 안 줄어듦)·VM 노후·wraparound | 언두 팽창·체인 순회(purge가 따라잡으면 회복) |
| 인덱스 | 비-HOT UPDATE마다 **모든 인덱스**에 새 엔트리 | 바뀐 컬럼의 인덱스만 delete-mark + 새 엔트리 |
| 기본 격리 / phantom | RC / RR은 **스냅샷만으로** phantom 차단 | RR / 갭 락·넥스트 키 락으로 차단 |
| SERIALIZABLE | SSI — 락 없이 추적, `40001` abort | 모든 SELECT가 공유 락 |

말로 짚을 때는 표의 첫 줄에서 출발한다 — **옛 버전이 어디 있나**가 나머지
전부를 결정한다. 힙 안이라 bloat·VACUUM·모든 인덱스 갱신·롤백된 INSERT의
잔존이 따라오고(PostgreSQL), 언두라 history list·purge·체인 순회·역적용
롤백이 따라온다(InnoDB). phantom은 PostgreSQL RR이 스냅샷만으로 막아 갭 락이
없고, 그 대신 "없는 행"의 경쟁은 UNIQUE·`ON CONFLICT`·SSI로 막는다. 공통점은
**긴 트랜잭션이 정리 작업(VACUUM / purge)을 막아 남들을 느리게 한다**는 것 —
어느 DB든 "트랜잭션은 짧게"의 근거는 같다. 이 비교를 할 수 있으면 MVCC를
특정 DB의 기능이 아니라 설계 선택으로 이해하고 있다는 신호가 된다.

---

## 한 줄 요약

**MVCC는 "읽는 쪽이 락 대신 자기 시점의 과거 버전을 보는" 격리(I) 구현으로,
PostgreSQL은 튜플 헤더의 `xmin`·`xmax`·`ctid`, 옛 버전을 힙 페이지 안에
그대로 남기는 저장 방식(UPDATE = 새 튜플 + 옛 튜플에 xmax, 롤백 = `pg_xact`에
abort 표시), 그리고 "어떤 트랜잭션까지 끝난 것으로 보는가"를 찍은 스냅샷
(하한선·상한선·진행 중 목록)으로 구현한다 — 스냅샷을 문장마다 찍으면 RC,
트랜잭션당 한 번이면 RR이고, 갱신은 스냅샷이 아닌 최신 버전을 따라간다.
읽기-쓰기 비차단의 대가는 죽은 튜플·인덱스 bloat·VACUUM 부하이며, 이
청구서는 트랜잭션 길이에 비례해 커져 "긴 트랜잭션 → horizon 고정 → VACUUM
정지 → n_dead_tup 증가 → 무관한 조회까지 죽은 튜플을 읽고 버림 → Index Only
Scan 퇴화"라는 사슬로 남들에게 배달된다. 그래서 `n_dead_tup`과
`age(backend_xmin)`을 지표로 걸고 `idle_in_transaction_session_timeout`을
서버에 박으며, 외부 호출을 트랜잭션 밖으로 빼는 규칙을 ArchUnit·timeout·leak
detection으로 고정한다.**
