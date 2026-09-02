# `SELECT ... FOR UPDATE`의 락 범위 — PostgreSQL은 "스캔한 행"이 아니라 "WHERE를 통과해 반환된 행"만 잠근다

> 핵심 관전 포인트: **PostgreSQL에서 `SELECT ... FOR UPDATE`는 ① 테이블에 ROW SHARE 락(DDL 계열과만 충돌), ② WHERE를 통과해 반환된 행에만 행 락 — 실행 계획에서 스캔 노드 위에 `LockRows` 노드가 서고, 락은 별도 락 테이블이 아니라 튜플 헤더 `xmax`에 기록된다, ③ 갭 락·넥스트 키 락은 없다, ④ 인덱스 엔트리는 잠그지 않는다(힙 튜플 하나가 정본). 그래서 WHERE가 인덱스를 못 타면 MySQL과 정반대 방향의 일이 벌어진다 — 스캔한 행이 전부 잠기는 게 아니라 Seq Scan으로 느려질 뿐, 조건 미충족 행은 하나도 안 잠긴다. 대신 위험은 다른 데 있다: 잠근 채 스캔이 끝날 때까지 락 보유 기간이 늘어 같은 행을 노리는 트랜잭션이 그 구간에 직렬화되고(커넥션 고갈은 이 경로로 온다), 스캔 순서가 세션마다 달라져 락 획득 순서가 어긋나면 데드락 확률이 오르며, READ COMMITTED의 재평가(EvalPlanQual)로 후보 행마다 대기·순서 어긋남이 생기고, 조인이면 모든 테이블의 행이 잠기며, `FOR UPDATE`는 네 모드 중 최강이라 FK 검사의 `KEY SHARE`와 충돌해 자식 INSERT를 막고(잔액 갱신 같은 비키 갱신은 `FOR NO KEY UPDATE`), 존재하지 않는 행은 못 잠근다. 처방은 폭(등호 조건) → 기간(인덱스, 락 안 왕복 제거) → 강도(`NO KEY UPDATE`) → 대기 정책(`lock_timeout` / `NOWAIT` / `SKIP LOCKED`) 순이고, 리뷰에서 `EXPLAIN (ANALYZE, BUFFERS)`의 `LockRows` 행 수와 `Buffers`를 증빙으로 요구한다.**

---

## 0. 질문 + 의도

**질문**: "`SELECT ... FOR UPDATE`는 어떤 락을 잡나요? WHERE 조건이 인덱스를 못 타면 무슨 일이 벌어지나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "조건이 인덱스를 못 타면 스캔한 행 전부에 락이 걸려 **'한 건 잠그려다 테이블을 세우는' 사고**가 난다. 락을 '무엇을 잠그는가'가 아니라 **'어떻게 찾은 행을 잠그는가'**로 이해하는지 — 실행 계획과 락이 결합되는 한 단계 깊은 이해를 확인한다." 이 문장의 전제는 InnoDB다. **PostgreSQL로 답하면 결론이 뒤집힌다** — 스캔한 행이 아니라 반환된 행만 잠기므로 "테이블을 세우는" 사고는 그 모양으로는 나지 않는다. 그래서 PG 사용자의 채점 지점은 ① 잡히는 락의 **종류와 기록 위치**(ROW SHARE + 튜플 `xmax`, 행 락 4종 모드)를 목록으로 꺼낼 수 있는가 ② `LockRows`가 Filter **뒤에** 선다는 실행 구조에서 "반환 행 = 잠긴 행"을 도출하는가 ③ "그럼 인덱스 없어도 괜찮다"로 끝내지 않고 **기간·재평가·조인·FK KEY SHARE·부재 행**이라는 PG 고유 위험 다섯을 이름 붙여 말하는가 ④ 그것을 **리뷰·설정·모니터링·테스트**로 미리 막는 안전망을 갖고 있는가다. 면접관이 MySQL을 전제로 물었다면 "PG는 반대 방향이고, MySQL이라면 이렇다"를 함께 말하는 것이 가장 높은 답이다(§4 경험 대조).

**이 문서가 선행 문서와 나누는 경계**: 비관적 락 vs 낙관적 락의 선택 기준과 "대기 중 붙잡히는 건 스레드가 아니라 커넥션"이라는 대가는 [낙관적 락 vs 비관적 락](../03-jpa-orm/10-optimistic-vs-pessimistic-lock.md)과 [동시성 갱신 4가지 비교](../03-jpa-orm/20-concurrency-update-four-approaches.md)에서 이미 다뤘다. 여기서는 **DB 안에서 락이 몇 개의 행에, 어떤 모양과 강도로 걸리는가** — 락의 **폭과 강도**에 집중한다. 갭 락이 없는 PG가 팬텀·"없는 행" 경쟁을 무엇으로 막는지, 행 락 4종이 만드는 데드락 유형은 [갭 락 없는 PG의 동시성과 데드락](12-gap-lock-next-key-lock-deadlock.md)에 맡기고 링크만 건다.

---

## 1. 무엇을 잠그는가 — 락 목록을 통째로 인출한다

### 1-1. 전제 — 왜 행을 잠그나, 그리고 `FOR UPDATE`는 정확히 무슨 문장인가

먼저 이 문장이 존재하는 이유부터. 두 요청이 같은 행을 **읽고 → 계산하고 → 쓰는** 순서로 처리하면, 한쪽의 갱신이 통째로 사라질 수 있다. 쿠폰 잔여 수량이 1인데 A와 B가 동시에 "1이네" 하고 읽어 둘 다 0으로 쓰면, 쿠폰은 두 번 쓰였는데 수량은 한 번만 줄어든다. 이렇게 **나중 쓰기가 앞 쓰기를 덮어써서 갱신이 없어지는 현상**을 lost update(갱신 유실)라 부른다.

막는 방법은 크게 둘이다. **낙관적 락**은 일단 읽고 계산한 뒤 쓸 때 "내가 읽은 그 버전이 아직 그대로인가"를 확인하고, 아니면 실패시켜 재시도하게 한다. **비관적 락**은 반대로 **읽는 순간 그 행에 미리 표시를 남겨** 다른 트랜잭션이 손대지 못하게 한다. `SELECT ... FOR UPDATE`는 후자의 문장이다.

용어를 하나 고정하자. 이렇게 **읽으면서 동시에 그 행에 락을 남기는 SELECT**를 **잠금 읽기(locking read)** 라고 부른다. 일반 SELECT는 MVCC 스냅샷을 읽을 뿐 아무것도 잠그지 않는다는 점과 짝을 이룬다([MVCC](11-mvcc-postgresql.md)).

> **회의실 비유** — 일반 SELECT는 복도에서 회의실 안을 들여다보는 것이다. 누가 있든 없든 내가 본 순간의 모습을 기억할 뿐 아무 흔적도 남기지 않는다. `FOR UPDATE`는 들여다본 뒤 **문에 "사용 예정" 팻말을 거는 것**이다. 팻말을 본 사람은 내가 뗄 때까지 기다린다. 그리고 팻말은 회의가 끝날 때(= 트랜잭션이 커밋될 때) 떼어진다. 이 문서의 질문은 결국 하나다 — **팻말이 정확히 어느 문에, 몇 개나 걸리는가.**

여기서부터가 이 문서의 본론이다. 팻말이 걸리는 자리를 PostgreSQL은 **네 칸의 목록**으로 말할 수 있다.

### 1-2. 기본형 — PK 등호 조회: 네 칸 목록

```sql
-- orders(PK id), READ COMMITTED(PostgreSQL 기본)
SELECT * FROM orders WHERE id = 42 FOR UPDATE;
```

이 한 문장이 잡는 락을 **네 칸 목록**으로 말한다.

```text
① 테이블 수준: ROW SHARE 락
   "이 테이블의 어떤 행을 잠글 예정"이라는 예고. 다른 트랜잭션의 UPDATE/INSERT(ROW EXCLUSIVE)·
   다른 FOR UPDATE(ROW SHARE)와는 충돌하지 않는다. 충돌 상대는 EXCLUSIVE·ACCESS EXCLUSIVE —
   ALTER TABLE, DROP, TRUNCATE, VACUUM FULL, LOCK TABLE ... IN EXCLUSIVE MODE.
   (커밋까지 유지되므로 "열린 트랜잭션이 DDL을 막는다"는 효과가 있고, 거꾸로 ACCESS EXCLUSIVE
    요청이 내 뒤에 줄 서면 그 뒤에 오는 모든 SELECT까지 막힌다 → 14·16 문서)

② 행 락: id=42 힙 튜플 하나에 FOR UPDATE 모드 락
   → 기록 위치는 별도 락 테이블이 아니라 그 튜플의 헤더 xmax (1-3)
   → 다른 트랜잭션의 UPDATE / DELETE / FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE 전부 대기
   → 일반 SELECT(스냅샷 읽기)는 막히지 않는다

③ 갭 락 / 넥스트 키 락: 없음 — PostgreSQL에는 개념 자체가 없다
   → 어떤 조건이든 "아직 없는 행"·"범위"는 잠기지 않는다 (id=43 INSERT는 언제나 자유)

④ 인덱스 엔트리 락: 없음 — orders_pkey의 (42, TID) 엔트리는 건드리지 않는다
   → 행 락은 오직 힙 튜플에만. 어떤 인덱스로 찾았든 잠기는 것은 그 튜플 하나 (1-4)
```

`FOR UPDATE`를 안전하게 쓰는 기본형이 왜 "PK 등호"인지가 이 목록에서 드러난다 — 다만 이유가 MySQL과 다르다. **③④는 조건과 무관하게 항상 빈다.** PK 등호가 좋은 이유는 "잠기는 폭이 1로 줄어서"가 아니라 **"잠글 행을 찾는 데 페이지 4장이면 끝나서"**(기간)다. 이 차이가 §2 전체의 축이다.

### 1-3. 락은 어디에 기록되나 — 락 테이블이 아니라 튜플 헤더 `xmax`

PostgreSQL의 행 락은 공유 메모리의 락 구조체가 아니라 **잠근 튜플 자체의 헤더**에 남는다. 락을 잡으면 그 튜플의 `xmax`에 내 트랜잭션 ID를 쓰고, infomask에 "이건 삭제가 아니라 락"이라는 비트와 모드 비트를 세운다.

용어 둘을 그 자리에서 정의한다. **`xmax`** 는 원래 "이 튜플 버전을 지운(또는 새 버전으로 밀어낸) 트랜잭션 ID"를 담는 헤더 필드다 — 이름 그대로 이 버전이 보이는 트랜잭션 범위의 **최댓값**을 뜻한다([MVCC](11-mvcc-postgresql.md)). 락은 이 필드를 재활용해 "지운 게 아니라 잠갔을 뿐"이라는 비트와 함께 쓴다. **infomask**는 그 튜플의 상태를 나타내는 비트 묶음이고, "락이다 / 삭제다", "어떤 모드다"가 여기 들어간다.

공유 계열(`FOR SHARE` / `FOR KEY SHARE`)이거나 여러 트랜잭션이 함께 잠근 경우엔 `xmax` 자리에 MultiXactId를 넣고 구성원 목록은 별도 multixact 영역에 둔다 — 필드 하나에 트랜잭션 ID를 여럿 담을 수 없으니 "여럿을 가리키는 하나의 번호"를 대신 넣는 것이다.

이 설계에서 네 가지가 따라 나온다.

- **락 개수 제한·에스컬레이션이 없다.** 100만 행을 잠가도 락 메모리는 0이다. "행 락이 너무 많아 테이블 락으로 승격"되는 일은 없다.
- **락도 쓰기다.** `xmax`를 쓰면 페이지가 더러워지고 WAL이 나간다. 많은 행을 잠그면 그만큼 페이지 더티 + WAL. (단 새 튜플 버전은 만들지 않는다 — `UPDATE`와 달리 bloat는 생기지 않는다.)
- **`pg_locks`에 행 락이 안 보인다.** 거기 보이는 것은 테이블 락(ROW SHARE)과 **대기 중인 요청**뿐이다. "지금 몇 행이 잠겼나"를 `pg_locks`로 셀 수 없다 — 잠긴 행 목록은 `pgrowlocks` 확장으로 본다(§3-11).
- **대기의 모양**: 잠긴 튜플을 만난 트랜잭션은 `xmax`의 트랜잭션이 끝나기를 기다린다 = 그 XID에 대한 락 요청. `pg_stat_activity`에는 `wait_event_type = Lock`, `wait_event = transactionid`로 보인다. 같은 행에 대기자가 둘 이상이면 순서 보장을 위해 임시 `tuple` 락을 쓰므로 **첫 대기자만 `transactionid`, 나머지는 `tuple`**로 보인다 — 장애 화면에서 이 분포가 "한 행에 줄이 섰다"의 증거다.

> **MySQL 대조**: InnoDB의 행 락은 메모리의 락 구조체(lock struct)에 인덱스 레코드 단위로 쌓이고 `INNODB_TRX.trx_rows_locked`로 개수를 셀 수 있다. PG는 개수를 세는 대신 튜플에 표시만 하므로 관측 도구가 완전히 다르다(§3-11).

### 1-4. 왜 인덱스 엔트리는 안 잠그나 — 힙 튜플 하나가 정본

PostgreSQL의 테이블은 힙이고, **모든 인덱스는 리프에 (키, TID)만 들고 힙을 가리키는 세컨더리**다([힙과 인덱스](03-clustered-vs-secondary-index.md)). 행의 실체는 힙 튜플 하나뿐이고, 어떤 경로로 오든 — PK 인덱스든, 다른 인덱스든, Seq Scan이든 — 그 행을 갱신하려면 **마지막에 반드시 그 힙 튜플에 손을 대야 한다.** 거기서 `xmax`를 본다. 그래서 잠글 곳은 한 군데면 충분하다.

```text
Tx A: SELECT * FROM orders WHERE customer_id = 7 FOR UPDATE;
      → idx_customer 로 찾았지만, 잠근 것은 매치된 힙 튜플들(예: id=42)의 xmax

Tx B: UPDATE orders SET status = 'CANCELLED' WHERE id = 42;
      → B 는 PK 로 접근 — idx_customer 는 건드리지도 않는다
      → 그래도 id=42 힙 튜플을 갱신하려는 순간 xmax 에 A 가 있다 → 대기
      → 경로가 달라도 막힌다. 인덱스에 락이 없어도 뚫리지 않는 이유
```

> **도서관 비유** — PostgreSQL은 색인 카드(인덱스)에는 아무것도 붙이지 않고 **책(힙 튜플)에만** "대출 중" 스티커를 붙인다. 서가 번호를 알고 직접 오든 색인을 뒤져 오든, 책을 집어 드는 순간 스티커를 보게 되므로 한 장이면 된다.

**(가산점 포인트)** 이 규칙은 **커버링 인덱스여도 적용된다.** 조회 컬럼이 전부 인덱스 안에 있어 평소엔 `Index Only Scan`으로 힙을 안 가는 쿼리라도, `FOR UPDATE`가 붙으면 `LockRows`가 잠그기 위해 **힙 튜플을 가져와야** 하므로 힙 방문이 살아난다 — 락은 힙에만 있기 때문이다. 대가도 같은 자리에서 나온다: 인덱스에 락도 버전도 없으므로 **"이 키 값의 행이 아직 없다"는 상태를 잠글 방법이 없다** — 갭 락 부재의 근원이다(§2-4 ⑤).

> **MySQL 대조**: InnoDB는 락이 인덱스 레코드에 붙고 행의 실체가 클러스터드 리프에 있어서, 세컨더리로 찾으면 **세컨더리 레코드 + 대응 클러스터드 레코드 두 곳**을 잠근다(커버링이어도 `FOR UPDATE`면 클러스터드까지). PG는 힙 튜플 한 곳이다.

### 1-5. 행 락은 4종이다 — 이름의 뜻부터 읽고 충돌 행렬로 묶는다

MySQL의 행 락이 S(공유)/X(배타) 둘이라면 PostgreSQL은 **네 단계**다. 이걸 모르면 PG에서 가장 흔한 "한 건만 잠갔는데 왜 다른 테이블 INSERT가 멈추죠"를 설명할 수 없다.

네 이름은 무작위가 아니라 **두 개의 축을 조합한 것**이다. 축을 먼저 보면 넷이 따로 놀지 않는다.

```text
축 ①  SHARE 냐 UPDATE 냐  =  "나는 이 행을 읽기만 할 건가, 바꿀 건가"
        SHARE  : 남이 못 바꾸게만 막는다. 나 말고 다른 SHARE 는 같이 잡아도 된다 (공유)
        UPDATE : 내가 바꿀 것이다. 다른 누구와도 같이 못 잡는다 (배타)

축 ②  KEY 가 붙었나 안 붙었나  =  "이 행의 키 컬럼(PK·유니크)까지 걸린 이야기인가"
        KEY 붙음  : 키만 신경 쓴다. 이 행의 키가 사라지거나 바뀌지 않기만 하면 된다
        KEY 안 붙음 / NO KEY : 키는 안 건드린다. 잔액·상태·수량 같은 비키 컬럼만 바꾼다

조합
  FOR KEY SHARE      = 키만, 공유로  → "이 행이 이 키로 계속 존재하기만 하면 된다"  (FK 검사가 쓰는 것)
  FOR SHARE          = 전체를, 공유로 → "내가 읽는 동안 아무도 못 바꾸게"
  FOR NO KEY UPDATE  = 비키만, 배타로 → "내가 잔액을 바꿀 것이다. 키는 안 건드린다"
  FOR UPDATE         = 전체를, 배타로 → "내가 지우거나 키를 바꿀 수도 있다"  ← 4종 중 최강
```

이제 충돌 행렬이다. **가로줄이 "지금 내가 요청하는 락", 세로 칸이 "이미 그 행에 걸려 있는 락"**이고, 칸의 값은 그 조합에서 내가 어떻게 되는가다.

| 요청(행) \ 이미 걸린 락(열) | `FOR KEY SHARE` | `FOR SHARE` | `FOR NO KEY UPDATE` | `FOR UPDATE` |
|---|---|---|---|---|
| `FOR KEY SHARE` | 통과 | 통과 | 통과 | **충돌(대기)** |
| `FOR SHARE` | 통과 | 통과 | **충돌(대기)** | **충돌(대기)** |
| `FOR NO KEY UPDATE` | 통과 | **충돌(대기)** | **충돌(대기)** | **충돌(대기)** |
| `FOR UPDATE` | **충돌(대기)** | **충돌(대기)** | **충돌(대기)** | **충돌(대기)** |

표를 읽는 법은 대각선이다. **오른쪽 아래로 갈수록 세고, 왼쪽 위로 갈수록 약하다.** `FOR UPDATE` 줄은 전부 충돌이고(가장 세니까 아무와도 못 겹친다), `FOR KEY SHARE` 줄은 `FOR UPDATE` 하나와만 충돌한다(가장 약하니까 "행을 지우거나 키를 바꾸는" 락하고만 부딪힌다).

다음은 **누가 어떤 모드를 자동으로 잡는지**다. 사람이 `SELECT ... FOR ...`로 명시하는 것보다 DB가 알아서 잡는 쪽이 사고의 원인이 되는 경우가 많다.

- `DELETE`, 그리고 **키 컬럼**(유니크 인덱스에 걸린 컬럼 = FK가 참조할 수 있는 컬럼)을 바꾸는 `UPDATE` → `FOR UPDATE`
- 그 외의 `UPDATE`(잔액·상태·수량 같은 비키 컬럼만) → `FOR NO KEY UPDATE`
- **FK 검사** — 자식 행 INSERT/UPDATE가 "부모 행이 존재하는가"를 확인할 때 부모 행에 → `FOR KEY SHARE`
- `SELECT ... FOR SHARE` → 명시적 공유 락

FK 검사가 `FOR KEY SHARE`인 이유가 축 ②의 정의 그대로다 — 자식이 부모에게 바라는 것은 오직 **"내가 참조하는 그 키로 부모가 계속 존재할 것"** 하나이고, 부모의 잔액이 어떻게 바뀌든 상관이 없다. 그래서 가장 약한 락이면 충분하다.

표를 세로로 읽으면 함의가 나온다. **`FOR KEY SHARE`와 충돌하는 것은 `FOR UPDATE` 하나뿐이다.** 즉:

```sql
-- 세션 A: 잔액 갱신 전에 계좌를 잠근다
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;

-- 세션 B: 이 계좌의 거래내역을 남긴다 (transactions.account_id → accounts.id FK)
INSERT INTO transactions (account_id, amount) VALUES (1, 500);
--  → FK 검사가 accounts id=1 에 FOR KEY SHARE 요청 → A 의 FOR UPDATE 와 충돌 → 대기
--  pg_stat_activity: wait_event_type = Lock, wait_event = transactionid

-- 세션 A 가 이렇게 잠갔다면:
SELECT * FROM accounts WHERE id = 1 FOR NO KEY UPDATE;
--  → KEY SHARE 와 충돌하지 않는다 → B 는 즉시 통과
--  (잔액은 키가 아니다. 키를 안 바꿀 거면 키를 잠글 이유가 없다)
```

여기서 역설 하나 — 평범한 `UPDATE accounts SET balance = balance - 500 WHERE id = 1`은 비키 갱신이라 `FOR NO KEY UPDATE`만 잡고, 자식 INSERT를 막지 않는다. 그런데 "안전하게 하겠다"고 `SELECT ... FOR UPDATE`를 앞에 붙이는 순간 **`UPDATE` 단독보다 더 센 락**을 잡아 자식 INSERT를 막는다.

그래서 PostgreSQL에서 업무 락의 기본형은 `FOR UPDATE`가 아니라 **`FOR NO KEY UPDATE`**여야 하고, `FOR UPDATE`는 "이 행을 삭제하거나 키를 바꿀 것"일 때만 쓴다. 이 구분이 만드는 데드락(자식 INSERT 후 부모 `FOR UPDATE`가 교차)은 [12 문서](12-gap-lock-next-key-lock-deadlock.md), FK가 부모에 거는 비용은 [34 문서](34-fk-constraint-in-production-debate.md).

### 1-6. 락은 SELECT가 끝나도 안 풀린다 — 커밋까지

행 락은 **트랜잭션이 커밋/롤백될 때 한꺼번에 풀린다.** `FOR UPDATE` 문장이 결과를 돌려준 순간이 아니다.

따라서 **락 보유 기간 = 그 SELECT 이후 트랜잭션이 끝날 때까지의 시간 전부**이고, 그 안에 자바 계산, 왕복 몇 번, 외부 API 호출이 들어가면 그만큼 남들이 기다린다.

그리고 PG에서는 한 겹이 더 있다 — 락을 쥔 채 열려 있는 트랜잭션은 `backend_xmin`으로 VACUUM을 붙잡아 무관한 테이블의 bloat까지 만든다([긴 트랜잭션의 해악](16-long-transaction-harm-and-shortening.md)). [낙관적 락 vs 비관적 락 §4](../03-jpa-orm/10-optimistic-vs-pessimistic-lock.md)가 다룬 "얼마나 오래 잠그느냐"가 이 축이다. 이 문서의 **폭(몇 개를) × 강도(어떤 모드로)** 와 저 문서의 **기간(얼마나 오래)** 을 곱한 것이 락 비용의 총량이다.

---

## 2. 인덱스를 못 타면 — MySQL과 정반대 방향의 사슬

### 2-1. 원리 한 문장: `LockRows`는 Filter **뒤에** 선다

PostgreSQL의 실행 구조를 한 줄로 요약하면 — **스캔 노드가 힙(또는 인덱스)을 읽으며 WHERE(`Filter` / `Index Cond`)를 그 자리에서 판정하고, 통과한 행만 위 노드로 올려보낸다.** 잠금 읽기는 그 위에 `LockRows`라는 별도 노드가 서서, **올라온 행만** 잠근다. 조건에 안 맞아 스캔 노드에서 버려진 행은 `LockRows`에 도달하지 않으므로 잠길 기회 자체가 없다.

```text
EXPLAIN SELECT * FROM orders WHERE order_no = 'A-1003' FOR UPDATE;   -- order_no 에 인덱스 없음

 LockRows                                   ← 여기 도달한 행만 xmax 에 기록
   ->  Seq Scan on orders
         Filter: (order_no = 'A-1003'::text) ← 여기서 걸러진 행은 위로 안 올라간다
```

이걸 눈으로 보면:

```text
Seq Scan 이 힙을 처음부터 끝까지 읽는다:
 id=1  'A-1001'  읽음 → Filter 불일치 → 버림 (락 없음)
 id=2  'A-1002'  읽음 → 불일치 → 버림 (락 없음)
 id=3  'A-1003'  읽음 → 일치 → LockRows 로 → xmax 에 내 XID 기록 → 반환
 id=4  'A-1004'  읽음 → 불일치 → 버림          ← "더 있을지 모르니" 끝까지 읽는다 (읽기는 한다!)
 ...
 id=N            읽음 → 버림
 (테이블 끝 — 가상 레코드도 갭도 없다. 새 INSERT 는 자유)

결과: 반환 1행 / 잠긴 튜플 1개 / 읽은 페이지 = 테이블 전체
```

**반환된 행 수와 잠긴 행 수가 같은 숫자다.** `LockRows` 노드의 `actual rows`가 곧 잠긴 행 수다. (예외 셋 — `OFFSET`으로 건너뛴 행은 잠긴다, 조인이면 `OF`로 한정하지 않는 한 모든 테이블의 행이 잠긴다, 커서는 fetch하거나 지나친 행까지 잠긴다.)

"한 건만 조회하는 쿼리인데요"는 PG에서 정말 한 건만 잠근다. 문제는 **그 한 건을 찾기까지 걸린 시간**과, **찾는 동안 만난 후보 행에서의 대기**다.

> **MySQL 대조**: InnoDB는 스토리지 엔진이 레코드를 읽어 올리는 **그 시점에** 락을 걸고 WHERE 판정은 그 뒤에 SQL 계층이 한다. 그래서 "스캔한 모든 레코드"가 잠기고(+RR이면 갭), 반환 행 ≠ 잠긴 레코드다. PG는 Filter가 스캔 노드 안에서 끝나고 `LockRows`가 그 위에 있어 반환 행 = 잠긴 행이다.

### 2-2. 두 방향을 나란히 놓는다 — 어느 쪽이 어느 DB인가

이 문서에서 헷갈리면 답이 반대로 나가는 지점이다. **"인덱스를 못 타면 나빠진다"는 결론은 같은데, 나빠지는 항목이 두 DB에서 서로 다르다.** 어느 쪽이 어느 DB인지를 표로 못 박는다.

| 항목 | MySQL / InnoDB | PostgreSQL |
|---|---|---|
| 락을 거는 시점 | 스토리지 엔진이 레코드를 읽어 올리는 **그 순간** (WHERE 판정보다 먼저) | 스캔 노드가 WHERE를 통과시킨 **뒤**, 위에 선 `LockRows` 노드에서 |
| 인덱스를 못 탈 때 나빠지는 것 | 락의 **폭** — 스캔한 모든 레코드(RR이면 앞 갭까지)가 잠긴다 | 폭은 그대로다(반환 행 수). 나빠지는 것은 **스캔 비용 = 락 보유 기간**, 그리고 **락 획득 순서** |
| 조건에 안 맞는 무관한 행 | 같이 잠긴다 | 안 잠긴다 |
| 그 사이 새 INSERT | 갭 락에 막힌다 | 자유롭게 들어온다 |
| 사고에 붙일 이름 | **폭 사고** — "한 건 잠그려다 테이블을 세운다" | **기간 사고** — "한 건 잠그는 데 400ms를 쓰고, 그동안 남이 그 한 건 앞에 줄 선다" |
| 그래서 인덱스를 거는 이유 | 잠기는 행 수를 줄이려고 | 잠그는 데 걸리는 시간을 줄이려고 |

**"PG는 폭이 안 늘어난다"를 "PG는 괜찮다"로 옮겨 적으면 오답이다.** PG에서 인덱스 부재가 만드는 사고는 두 갈래로 실제로 존재하고, 둘 다 인과가 분명하다.

**갈래 ⑴ 지연 → 직렬화 구간 확대.** Seq Scan은 문장 자체를 수백 ms~수 초로 늘린다. 그런데 락은 **잠글 행을 찾은 그 시점부터** 걸리고 **커밋까지** 유지되므로, 스캔이 길수록 그 행을 쥐고 있는 시간이 길어진다. 같은 행을 노리는 요청이 N개면 그 요청들은 "각자 풀스캔 + 로직 + 커밋" 시간만큼씩 줄줄이 직렬화된다. 대기자는 스레드가 아니라 **커넥션**을 붙잡으므로 여기서 풀 고갈로 이어진다(§2-5 사슬).

**갈래 ⑵ 스캔 순서 가변 → 락 획득 순서 어긋남 → 데드락.** 이쪽이 PG 고유이고, 잘 알려져 있지 않다.

```text
데드락은 "서로 상대가 쥔 것을 기다리는 순환"이다. 순환이 생기려면
락 획득 순서가 세션마다 달라야 한다. 그 순서를 정하는 것이 실행 계획이다.

[인덱스를 탈 때]  Index Scan → 항상 인덱스 키 순서로 행이 올라온다
  세션 A: id 10 잠금 → id 20 잠금
  세션 B: id 10 대기 → (A 커밋 후) id 10 잠금 → id 20 잠금
  두 세션의 획득 순서가 같다 → 순환이 생길 수 없다 → 데드락 없음

[Seq Scan 일 때]  힙 블록 순서로 올라오는데, 그 시작 지점이 세션마다 다를 수 있다
  PostgreSQL 은 synchronize_seqscans = on(기본)이라, 이미 돌고 있는 순차 스캔이 있으면
  새 스캔은 그 지점에 합류해서 읽다가 테이블 끝에서 앞으로 되돌아온다(wrap around).
  → 캐시 적중률을 높이려는 최적화인데, 부작용으로 ORDER BY 없는 쿼리의 행 순서가 세션마다 달라진다

  세션 A: 블록 0 부터 시작 → id 10 잠금 → id 20 을 기다림
  세션 B: 블록 500 부터 시작 → id 20 잠금 → id 10 을 기다림
                                    ↓
                        서로를 기다림 = 순환 = ERROR 40P01 deadlock detected
                        (deadlock_timeout 기본 1초 뒤 검출, 한쪽이 강제 롤백된다)
```

즉 PG에서 인덱스 부재는 **폭을 늘리는 대신 "느려짐 + 데드락 확률 상승"으로 값을 받아 간다.** 처방은 둘 다 같은 방향이다.

- **인덱스를 걸어 실행 계획을 `Index Scan`으로 고정한다** — 기간이 줄고 획득 순서도 함께 고정된다. 한 번에 둘을 산다.
- 여러 행을 잠가야 한다면 **잠금 순서를 쿼리로 명시한다.** `ORDER BY id`를 붙이면 계획이 `LockRows → Sort → Seq Scan`이 되어 **정렬된 순서로 잠그므로** 세션 간 획득 순서가 같아진다(`LockRows`가 `Sort` **위에** 서기 때문에 가능한 처방이다). 다만 Sort 입력은 여전히 전체 스캔이므로 기간 문제는 인덱스로 따로 풀어야 한다.

> **MySQL 대조**: InnoDB에서도 스캔 순서가 데드락을 만들지만, 거기서는 그전에 **폭**이 먼저 터진다 — 인덱스가 없으면 스캔한 레코드 전부가 X 락이라 사실상 테이블이 선다. PG는 폭이 안 늘어난 대신 이 순서 문제가 전면에 남는다.

### 2-3. 같은 쿼리, 두 실행 계획 — `LockRows` 행 수는 같고 `Buffers`·시간이 다르다

```sql
-- EXPLAIN ANALYZE 는 실제로 실행되고 실제로 잠근다 → 반드시 트랜잭션으로 감싸고 ROLLBACK
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM coupon WHERE code = 'SUMMER-2026' FOR UPDATE;
ROLLBACK;
```

```text
-- before — coupon.code 에 인덱스가 없다 (약 120만 행, 힙 14,741 페이지)
 LockRows  (cost=0.00..29784.02 rows=1 width=62) (actual time=209.930..418.206 rows=1 loops=1)
   Buffers: shared hit=14741
   ->  Seq Scan on coupon  (cost=0.00..29784.01 rows=1 width=62) (actual time=209.913..418.188 rows=1 loops=1)
         Filter: (code = 'SUMMER-2026'::text)
         Rows Removed by Filter: 1203440        ← 읽고 버린 행. 잠기지 않았다
         Buffers: shared hit=14741              ← 테이블 전체 페이지
 Planning Time: 0.09 ms
 Execution Time: 418.23 ms
```

```sql
-- after — 유니크 인덱스를 걸었다 (운영 중이면 CONCURRENTLY, 14 문서)
CREATE UNIQUE INDEX CONCURRENTLY ux_coupon_code ON coupon (code);
```

```text
 LockRows  (cost=0.43..8.46 rows=1 width=62) (actual time=0.038..0.039 rows=1 loops=1)
   Buffers: shared hit=4
   ->  Index Scan using ux_coupon_code on coupon  (cost=0.43..8.45 rows=1 width=62) (actual time=0.029..0.030 rows=1 loops=1)
         Index Cond: (code = 'SUMMER-2026'::text)
         Buffers: shared hit=4                  ← 루트→리프 3페이지 + 힙 1페이지
 Execution Time: 0.06 ms
```

읽는 법 — `LockRows`의 `actual rows`는 **두 계획 모두 1**이다. 잠기는 폭은 같다. 달라진 것은 `Buffers`(14741 vs 4)와 시간(418ms vs 0.06ms), 즉 **락을 잡기까지, 그리고 잡은 채 문장이 끝날 때까지의 기간**이다.

before의 `actual time=209.913..418.188`을 뜯어보면 더 뼈아프다. `actual time`의 앞 숫자는 **그 노드가 첫 행을 내놓기까지 걸린 시간**, 뒷 숫자는 **그 노드가 다 끝난 시각**이다. 첫 행(잠글 행)을 210ms에 찾아 잠갔지만 "더 있을지 모르니" 418ms까지 계속 읽었다는 뜻이다. **락은 210ms 시점부터, 문장은 418ms에 끝, 커밋은 그 뒤.** 이 계획 한 장이 "폭은 같고 기간이 다르다"의 증빙이고, PR에 붙일 것도 이것이다(§3-9).

`cost` 숫자도 직접 맞춰 보면 구조가 보인다. Seq Scan 비용 = 페이지 수 × `seq_page_cost`(1.0) + 행 수 × `cpu_tuple_cost`(0.01) + 행 수 × `cpu_operator_cost`(0.0025) = 14,741 + 12,034.41 + 3,008.60 = **29,784.01**. 그 위 `LockRows`는 **출력 행 1개**에 대해서만 `cpu_tuple_cost` 0.01을 더하므로 29,784.02다. 플래너의 비용 모델 자체가 "잠그는 건 반환된 행뿐"이라고 말하고 있는 셈이다.

### 2-4. 그래도 위험한 다섯 가지 — "잠그지 않는다"가 "안전하다"는 아니다

"PG는 조건 미충족 행을 안 잠근다"에서 멈추면 절반이다. 면접관이 다음에 묻는 것은 "그럼 뭐가 문제인데요?"다. 이름 붙여 다섯을 꺼낸다.

**① 기간 — 스캔 시간만큼 락을 쥐고, 같은 행 경쟁이 그 구간에 직렬화된다.** 풀스캔은 (a) 문장을 수백 ms~수 초로 늘려 트랜잭션·커넥션 점유를 키우고, (b) 잠글 행을 스캔 중간에 찾았다면 그 시점부터 잠근 채 나머지를 읽는다.

같은 쿠폰 코드를 노리는 요청 N개가 동시에 오면 — 각자 풀스캔(CPU/IO 포화) → 첫 번째가 잠그고 나머지는 그 행에서 대기 → 첫 번째 커밋 → 두 번째가 잠그고 **남은 페이지를 마저 읽고** 로직을 돌린 뒤 커밋 → … **직렬화 구간이 "0.1ms"가 아니라 "수백 ms + 로직"**이 된다. 대기자마다 커넥션을 쥐므로 풀 고갈로 간다.

즉 커넥션 고갈 사슬은 PG에서도 도달 가능하지만, **경로가 "테이블 전체 락"이 아니라 "같은 행 위의 긴 직렬화 + 스캔 자원 소모"**다. 다른 쿠폰을 만지는 트랜잭션은 안 막힌다 — 이것이 결정적 차이다. 덤으로, 그 긴 트랜잭션은 `backend_xmin`으로 VACUUM을 붙잡는다(16 문서). 그리고 여러 행을 잠그는 쿼리라면 §2-2 갈래 ⑵의 데드락 확률 상승이 여기에 겹친다.

**② READ COMMITTED의 재평가(EvalPlanQual) — 후보 행마다 대기, 반환은 최신 버전.** `FOR UPDATE`는 문장 시작 시점 스냅샷으로 후보를 찾는다. 후보 행이 다른 **진행 중** 트랜잭션에 의해 갱신·삭제·잠금 중이면 그 트랜잭션이 끝날 때까지 대기하고, 커밋됐으면 **최신 버전을 다시 가져와 WHERE를 재평가**한다 — 여전히 맞으면 그 최신 버전을 잠그고 반환, 아니면 건너뛴다.

용어를 풀면 EvalPlanQual은 "Evaluate Plan Qualification", 즉 **계획의 조건식을 (최신 버전으로) 다시 평가한다**는 뜻이다. 왜 필요한지가 중요하다 — 스냅샷 시점 값으로 잠그면 이미 남이 바꿔 놓은 값을 근거로 쓰기를 하게 되므로, RC에서는 "기다렸다가 최신 값으로 다시 판단"을 택한 것이다.

함의는 넷이다. (a) 반환 행이 스냅샷 시점 값이 아니라 **최신 커밋 값**일 수 있다(같은 트랜잭션의 앞선 일반 SELECT와 값이 다를 수 있다 — RC의 성질). (b) 풀스캔 중 만나는 **후보 행마다** 대기가 생길 수 있고, 조건이 넓을수록(`status = 'PENDING'`) 대기 지점이 많다. 반대로 스냅샷에서는 조건에 안 맞았지만 동시 트랜잭션이 맞게 바꾼 행은 보지도 않고 지나간다. (c) **`ORDER BY` + `FOR UPDATE`**: 정렬은 스냅샷 값으로 먼저 끝나고 락은 그 뒤에 잡히므로, 대기 중 정렬 컬럼이 바뀌면 반환 순서가 실제 값 기준으로는 어긋날 수 있다(공식 문서의 경고). 정렬 컬럼이 동시 갱신되는 테이블에서 순서가 정합성에 중요하면 `SELECT * FROM (SELECT ... FOR UPDATE) s ORDER BY ...`로 잠근 뒤 정렬한다 — 단 서브쿼리가 반환하는 행을 **전부** 잠그므로 `LIMIT`과 함께 쓰면 폭이 커진다. (d) **`LIMIT`**: 락은 LIMIT을 채우면 멈춘다(좋다). 다만 재평가에서 탈락한 행은 건너뛰고 다음 후보를 끌어오므로 "스냅샷 기준 상위 n"과 "실제로 잠긴 n"이 다를 수 있고, **`OFFSET`으로 건너뛴 행은 잠긴다.**

**③ 조인 — `OF`로 한정하지 않으면 모든 테이블의 행이 잠긴다.**

```sql
-- before: orders 만 잠그려 했는데 users 행까지 FOR UPDATE
--         → 그 사용자의 모든 요청이 이 트랜잭션 뒤에 선다
SELECT o.*, u.tier FROM orders o JOIN users u ON u.id = o.user_id
 WHERE o.id = 42 FOR UPDATE;

-- after: 잠글 테이블을 지정
SELECT o.*, u.tier FROM orders o JOIN users u ON u.id = o.user_id
 WHERE o.id = 42 FOR UPDATE OF o;
```

외부 조인의 NULL 쪽은 잠글 수 없어 에러이고, GROUP BY·DISTINCT·집계·UNION과는 함께 쓸 수 없다(반환 행이 특정 테이블 행에 대응하지 않으므로). JPA에서 fetch join 쿼리에 `@Lock`을 걸면 방언·버전에 따라 `FOR UPDATE`가 전체에 붙을 수 있으니 **생성 SQL에 `OF` 별칭이 붙는지** 확인한다.

**④ 강도 — `FOR UPDATE`는 FK 검사의 `KEY SHARE`와 충돌한다.** §1-5 그대로다. 부모 행(계좌·쿠폰·상품)을 `FOR UPDATE`로 쥐고 있는 동안, 그 부모를 참조하는 자식 테이블(거래내역·사용이력·주문항목)의 INSERT가 전부 대기한다. "한 건만 잠갔는데 다른 테이블이 멈춘다"의 정체. 키를 안 바꾸면 `FOR NO KEY UPDATE`.

**⑤ 존재하지 않는 행은 못 잠근다.** `SELECT ... WHERE code = 'NEW' FOR UPDATE`가 0행이면 잠긴 것도 0개다. 두 트랜잭션이 동시에 "없네" → 둘 다 INSERT → 유니크 제약이 없으면 중복이다. 갭 락이 없는 대가이며, check-then-insert는 `UNIQUE` + `INSERT ... ON CONFLICT`, `pg_advisory_xact_lock(hashtext(code))`, 또는 SERIALIZABLE로 막는다([12 문서](12-gap-lock-next-key-lock-deadlock.md)).

### 2-5. 사슬 8단계 — PG에서 끊기는 곳과 이어지는 곳

비용을 "느려진다"로 뭉뚱그리지 않는다. 단계마다 **이름**과 **관측 증거**를 붙이되, MySQL 사슬과 어디서 갈라지는지를 같이 말한다.

```text
① 인덱스 부재 (또는 함수·타입·부분 인덱스 조건 불일치로 못 탐)
   증거: EXPLAIN → LockRows 아래 Seq Scan, Rows Removed by Filter ≈ 전체 행, Buffers ≈ 테이블 페이지 수
        ↓
② 전 페이지 읽기 — 그러나 잠기는 건 WHERE 통과 행뿐 (LockRows actual rows = 반환 행)
   증거: pgrowlocks('coupon') 의 행 수 = 1. 무관한 행 UPDATE·새 INSERT 는 그대로 통과
   여기가 MySQL 과 갈라지는 지점이다
        ↓
③ 기간 사고 — 잠글 행을 찾은 시점부터 스캔 끝 + 커밋까지 락 보유. 문장 자체가 수백 ms~수 초
   증거: pg_stat_activity 에서 그 pid 가 active 로 오래, backend_xmin 이 잡혀 VACUUM 지연
        ↓
④ 같은 행을 노리는 트랜잭션들이 그 긴 구간에서 직렬화 — 각자 또 풀스캔을 돌린 뒤 그 행에서 대기
   증거: wait_event = transactionid 1명 + tuple 여러 명, pg_blocking_pids 가 같은 pid 를 가리킴
        CPU·IO 는 풀스캔 N 개로 포화 → 무관한 쿼리까지 느려짐 (락이 아니라 자원으로 전파)
        곁가지: 여러 행을 잠그는 쿼리라면 스캔 시작 지점이 세션마다 달라 40P01 데드락까지 (2-2 갈래 ⑵)
        ↓
⑤ 대기자는 커넥션을 쥔 채 멈춘다 (lock_timeout 기본 0 = 무한 대기)
   증거: HikariCP active ≈ maximumPoolSize, idle = 0, pending 증가
        ↓
⑥ 커넥션 풀 고갈 → 이 테이블과 무관한 API(로그인·조회)까지 커넥션을 못 얻는다
   증거: connectionTimeout(기본 30초) 후 "SQLTransientConnectionException: Connection is not available"
        무관한 엔드포인트의 p99 가 동시에 튄다
        ↓
⑦ 전면 장애 + 호송 효과(convoy)
   원인 트랜잭션이 커밋해도 다음 대기자가 또 같은 쿼리(또 남은 페이지 읽기) → 대기열이 줄지 않는다
        ↓
⑧ 회복: pg_terminate_backend(범인 pid) → CREATE INDEX CONCURRENTLY / 쿼리 수정 배포. 재발 방지는 §3-9~3-12
```

> **MySQL 대조**: InnoDB는 ②에서 갈라진다 — 스캔한 전 레코드에 X 락(RR이면 갭까지) → ③ **사실상 테이블 배타 락** → ④ 이 테이블에 쓰는 트랜잭션 **전원** 대기(`innodb_lock_wait_timeout` 기본 50초). 무관한 행도, 새 INSERT도 막힌다. PG는 ②에서 무관한 행이 살아남고, ④가 "같은 행 경쟁 + 자원"으로 좁아진 대신 ⑥까지 가는 길은 남아 있다.

면접에서 한 호흡으로 말할 버전:

> **인덱스 부재 → Seq Scan(전 페이지 읽기) → 그래도 잠기는 건 WHERE 통과 행뿐(갭 없음, 무관한 행은 자유) → 대신 락 보유 기간이 스캔 시간만큼 늘고, 같은 행을 노리는 요청이 그 긴 구간에서 직렬화 → 대기마다 커넥션 점유 → 풀 고갈 → 무관 API 전파.** 폭 사고가 아니라 **기간 사고**다. 처방은 같은 인덱스지만, 이유가 "잠기는 행을 줄이려고"가 아니라 "잠그는 데 걸리는 시간을 줄이려고"다.

### 2-6. 실무 변형 — PG에서 "폭 사고"는 인덱스가 아니라 **조건이 넓을 때** 난다

[풀스캔 원인 6종](02-index-not-used-full-scan.md)이 `FOR UPDATE`에 붙으면 기간 사고가 되고, 조건 자체가 넓으면 폭 사고가 된다. 둘을 구분해서 본다.

```sql
-- (a) 타입 불일치 — PG 는 대개 조용히 풀스캔하지 않고 에러를 낸다
SELECT * FROM coupon WHERE code = 20260801 FOR UPDATE;
-- ERROR:  operator does not exist: text = integer        ← 리뷰 전에 드러난다
-- 단 bigint 컬럼 = numeric 파라미터 같은 조합은 컬럼 쪽이 캐스트돼 인덱스를 잃는다 (02 문서) → 기간 사고

-- (b) 컬럼에 함수 → 인덱스 무효 → Seq Scan → 기간 사고
-- before
SELECT * FROM reservation WHERE date(starts_at) = current_date FOR UPDATE;
-- after: 범위 조건으로 바꾸거나
SELECT * FROM reservation
 WHERE starts_at >= current_date AND starts_at < current_date + 1 FOR UPDATE;
-- after: 표현식 인덱스를 만든다
CREATE INDEX idx_reservation_starts_date ON reservation ((date(starts_at)));

-- (c) 조건이 넓다 — PG 의 진짜 "폭 사고"
SELECT * FROM job WHERE status = 'PENDING' FOR UPDATE;
-- → 인덱스를 타든 안 타든 PENDING 행 전부를 잠근다 (갭은 없다). 폭 = 매치 행 수.
--    PENDING 이 10만 건이면 10만 튜플의 xmax 를 쓴다 → 페이지 더티 + WAL,
--    그리고 그 10만 행을 만지는 트랜잭션 전원 대기. "한 건"이 아니었던 것뿐이다

-- (d) ORDER BY ... LIMIT — PG 는 LIMIT 을 채우면 락을 멈춘다
SELECT * FROM job WHERE status = 'PENDING' ORDER BY created_at LIMIT 10 FOR UPDATE;
--  계획이 Limit → LockRows → Sort → Seq Scan 순이라 정렬 뒤 상위 10건만 잠근다 (폭 = 10)
--  덤: 정렬된 순서로 잠그므로 세션 간 락 획득 순서가 같아져 데드락 순환이 생기지 않는다 (2-2 갈래 ⑵)
--  단 ① Sort 가 남으면 PENDING 전부를 읽고 정렬하는 비용은 그대로 → 기간 사고.
--        (status, created_at) 인덱스 또는 부분 인덱스 ON job (created_at) WHERE status = 'PENDING' 으로 Sort 제거
--     ② OFFSET 으로 건너뛴 행은 잠긴다 — 페이지네이션과 FOR UPDATE 를 섞지 않는다
--     ③ RC 재평가로 순서·구성이 어긋날 수 있다 (2-4 ②)
```

(c)가 PG 사용자가 진짜 조심할 곳이다. MySQL 경험자가 "인덱스 있으니 괜찮다"고 넘기는 자리에서, PG는 "인덱스는 기간을 줄일 뿐 폭은 조건이 정한다"로 되묻는다. (d)는 반대로 MySQL에서 배치 워커의 `LIMIT n FOR UPDATE`가 큐 테이블 전체를 잠그던 사고가 PG에서는 나지 않는 사례다 — `LockRows`가 `Limit` 아래 있기 때문.

> **MySQL 대조**: (d)에서 InnoDB는 `ORDER BY`를 인덱스로 못 풀면 filesort — 조건에 맞는 행을 **전부 읽어 잠근 뒤** 정렬하고 10건을 자른다. `LIMIT`이 잠기는 레코드 수를 줄여주지 않는다.

### 2-7. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "인덱스 없으면 테이블이 잠긴다" | **Filter 뒤의 LockRows** | PG는 WHERE 통과 행만 잠근다 — 폭은 실행 계획이 아니라 조건이 정한다. 테이블 락은 안 생긴다 |
| "그럼 인덱스 없어도 괜찮네" | **폭 대신 기간, 그리고 순서** | Seq Scan 시간만큼 락 보유·트랜잭션·커넥션 점유가 늘고, 같은 행 경쟁이 그 구간에서 직렬화된다. 여러 행을 잠그면 스캔 시작 지점 차이로 데드락까지 |
| "한 건만 잠그는데 왜 다른 테이블 INSERT가 멈추죠" | **FK KEY SHARE 충돌** | `FOR UPDATE`는 KEY SHARE와 충돌 → 자식 INSERT 대기. 키를 안 바꾸면 `FOR NO KEY UPDATE` |
| "없는 행을 FOR UPDATE로 잠갔다" | **갭 락 부재** | 0행 반환 = 0개 잠금. check-then-insert는 UNIQUE/ON CONFLICT/advisory lock |
| "락이 몇 개 걸렸는지 pg_locks로 세자" | **xmax에 기록** | 행 락은 pg_locks에 없다. 보이는 건 대기자(transactionid/tuple). 잠긴 행은 pgrowlocks |

---

## 3. 트레이드오프와 안전망 — `NOWAIT` / `SKIP LOCKED` / `lock_timeout`, 그리고 사람의 기억에 맡기지 않기

### 3-1. `FOR UPDATE`가 지불하는 것 — 폭 · 기간 · 자원, 그리고 PG의 네 번째 축 "강도"

락 비용을 축으로 나누면 누가 무엇을 결정하는지가 분명해진다.

- **폭(몇 개의 행을)** — PostgreSQL에서는 **WHERE 조건**(과 `OF`, `OFFSET`, 조인 범위)이 정한다. 실행 계획은 폭을 바꾸지 못한다. 조건이 좁으면 1, 넓으면 매치 행 전부.
- **기간(얼마나 오래)** — **트랜잭션 경계 + 스캔 시간**이 정한다. 실행 계획이 정하는 것은 이쪽이다. 인덱스 부재는 폭 사고가 아니라 기간 사고다. 락 구간 안의 왕복·계산·외부 호출은 그대로 남의 대기 시간이 된다([낙관적 락 vs 비관적 락 §4](../03-jpa-orm/10-optimistic-vs-pessimistic-lock.md)).
- **자원(기다리는 동안 무엇을 붙잡나)** — **커넥션 풀 크기**가 상한을 정한다. 대기자는 스레드가 아니라 커넥션을 붙잡는다([낙관적 락 vs 비관적 락 §3-2](../03-jpa-orm/10-optimistic-vs-pessimistic-lock.md)).
- **강도(어떤 모드로)** — PG 고유 축. `FOR UPDATE`는 4종 중 최강이라 FK의 `KEY SHARE`까지 막는다. 대부분의 업무 락은 `FOR NO KEY UPDATE`로 충분하다.

비관적 락을 "간단하고 확실하다"고 고를 때 치르는 값은 이 넷의 **곱**이다. 폭이 1이고 강도가 맞으면 기간과 자원만 관리하면 되지만, 조건이 넓어 폭이 수만이 되거나 `FOR UPDATE`가 자식 테이블까지 세우는 순간 나머지가 아무리 잘 관리돼도 사고다.

그래서 **선택의 첫 관문은 "충돌이 잦은가"가 아니라 "잠글 행을 좁게·빨리·필요한 강도로 특정할 수 있는가"** 다.

### 3-2. 선택 기준 — 03장의 판단 플로우 앞에 Q0 네 개를 붙인다

[동시성 갱신 4가지 비교 §4-1](../03-jpa-orm/20-concurrency-update-four-approaches.md)의 플로우(DB 밖 자원? → SQL 한 문장으로 압축? → 충돌 빈도?)는 그대로 유효하다. 여기에 DB 락 관점의 **Q0**을 앞에 둔다.

```text
Q0-a. 잠글 행을 등호 조건으로 좁게 특정할 수 있는가?                        (폭)
      └ 아니오(status='PENDING' 같은 넓은 조건) → 매치 행 전부가 잠긴다.
        SKIP LOCKED + LIMIT 로 몫을 나누거나(3-5), 비관적 락을 후보에서 뺀다
Q0-b. 그 조건이 인덱스로 즉시 찾아지는가?                                    (기간 + 락 획득 순서)
      └ 아니오 → 인덱스를 만들거나 "조회 → PK 로 잠금" 2 단계로 바꾼다(3-8 C)
Q0-c. 이 트랜잭션이 키 컬럼(PK·유니크)을 바꾸거나 행을 지우는가?              (강도)
      └ 아니오(잔액·상태·수량) → FOR NO KEY UPDATE. 자식 테이블 INSERT 를 막지 않는다
Q0-d. 잠그려는 행이 아직 없을 수 있는가?                                     (갭 없음)
      └ 예 → FOR UPDATE 는 무력. UNIQUE + ON CONFLICT / advisory lock / SERIALIZABLE (12 문서)
```

세 방식과의 비교를 폭·강도 관점으로만 짧게:

- **원자적 UPDATE** — `UPDATE ... WHERE id = $1 AND qty >= $2`. 폭 규칙은 **동일**하다(매치 행만). 강도는 자동으로 맞는다 — 비키 갱신이면 `FOR NO KEY UPDATE`라 `SELECT FOR UPDATE`보다 오히려 약하다. 이기는 것은 **기간**(왕복 1회)이다. 인덱스가 없으면 역시 스캔 시간만큼 기간이 는다.
- **낙관적 락** — 읽기가 일반 SELECT라 **읽는 동안 아무것도 잠그지 않는다.** 인덱스가 없어도 느릴 뿐 남을 세우지 않는다. 대신 충돌 시 재시도 비용을 진다.
- **비관적 락** — 폭·기간·자원·강도 넷 다 진다. 대신 재시도가 없고 복잡한 로직을 락 안에서 안전하게 수행한다.

### 3-3. 잠긴 행을 만났을 때: 기본값은 "무한 대기"다 — `lock_timeout`

락을 요청했는데 이미 남이 쥐고 있으면 PostgreSQL의 기본 동작은 **끝없이 기다리는 것**이다(`lock_timeout = 0`). 이 기본값이 §2-5 사슬의 ⑤⑥을 가능하게 만드는 조건이므로, 대기 정책을 고르는 이야기는 여기서 시작해야 한다.

세 가지 선택지가 있고, 셋은 서로 대체재가 아니라 **다른 질문에 대한 답**이다.

| 도구 | 잠긴 행을 만나면 | 답하는 질문 |
|---|---|---|
| `lock_timeout` | 정해진 시간만 기다리고 초과하면 에러(55P03) | "얼마나 기다려 줄 것인가" — 대기 자체는 정상, 무한만 막는다 |
| `NOWAIT` | 기다리지 않고 즉시 에러(55P03) | "기다릴 가치가 있는가" — 없으면 바로 실패 응답 |
| `SKIP LOCKED` | 그 행을 건너뛰고 다음 행을 집는다 | "꼭 그 행이어야 하는가" — 아니면 다른 행으로 |

먼저 `lock_timeout`이다. **모든 락 대기에 거는 기본 상한**이므로, 나머지 둘을 쓰든 안 쓰든 이것은 항상 걸어 둔다.

```sql
-- 롤 단위로 걸어 두는 것이 가장 확실하다 (PgBouncer transaction pooling 환경에서도 안전)
ALTER ROLE app_user SET lock_timeout = '3s';

-- 특정 트랜잭션에서만 다르게 하려면 SET LOCAL (그 트랜잭션이 끝나면 되돌아간다)
BEGIN;
SET LOCAL lock_timeout = '500ms';
SELECT * FROM seat WHERE id = 1042 FOR NO KEY UPDATE;
```

- **용도**: **대기는 정상적인 동작**이지만 무한 대기는 아니라는 곳 — 즉 대부분의 업무 로직. 3초 안에 앞 트랜잭션이 끝나면 성공하고, 안 끝나면 실패로 알려 준다.
- **얻는 것**: 대기자가 커넥션을 붙잡는 시간에 상한이 생긴다. 사슬 ⑤⑥을 시간으로 끊는 유일한 장치다.
- **대가**: ① 초과 시 `ERROR 55P03 canceling statement due to lock timeout`이고, PG에서는 문장 하나가 실패하면 **트랜잭션 전체가 abort 상태**가 되므로 반드시 ROLLBACK해야 한다(MySQL처럼 "그 문장만 실패하고 계속"이 안 된다). ② **락 획득 시도마다 따로 적용된다** — 누적 상한이 아니다. 한 트랜잭션에서 락을 다섯 번 잡으면 최악의 경우 3초 × 5다. 트랜잭션 전체 상한은 `@Transactional(timeout = n)`이나 `statement_timeout`으로 따로 건다(§3-10).
- **JPA**: `jakarta.persistence.lock.timeout`에 **양수**를 주는 힌트는 PostgreSQL에서 SQL로 번역되지 않는다(PG에는 `FOR UPDATE WAIT n` 구문이 없다). 그래서 실질적인 대기 상한은 언제나 이 `lock_timeout` 설정이다.

### 3-4. `NOWAIT` — "기다리느니 실패"

```sql
SELECT * FROM seat WHERE id = 1042 FOR UPDATE NOWAIT;
-- 이미 잠겨 있으면 대기하지 않고 즉시 에러
-- ERROR:  could not obtain lock on row in relation "seat"        (SQLSTATE 55P03)
```

- **용도**: 사용자 대면 선점(좌석·쿠폰·예약 버튼)처럼 **"기다리는 것"이 "실패 응답"보다 나쁜 경우.** 100ms 기다려서 성공할 확률이 낮고, 그 사이 커넥션을 붙잡는 비용이 크며, 사용자는 "다시 시도" 버튼을 누르면 된다. `lock_timeout`과의 차이는 정도가 아니라 태도다 — `lock_timeout`은 "기다리되 상한을 둔다", `NOWAIT`은 "아예 안 기다린다".
- **얻는 것**: 대기열이 아예 생기지 않는다 → **대기자 쪽 커넥션 보호에 가장 강력**하다. §2-5 사슬의 ④⑤⑥을 대기자 입장에서 끊는다.
- **대가**: ① 실패를 애플리케이션이 반드시 처리해야 한다 — 트랜잭션이 abort 상태가 되므로 ROLLBACK 후 재시도든 실패 응답이든 명시적으로 정해야 한다 ② 클라이언트가 자동 재시도하면 **재시도 폭풍**으로 모양만 바뀐다 ③ **잠근 쪽의 기간 사고는 고치지 못한다** — 풀스캔 `FOR UPDATE`가 그 행을 400ms씩 쥐고 있으면 `NOWAIT` 쿼리는 전부 즉시 실패할 뿐이다. 피해자를 빨리 죽이는 것이지 가해자를 고치는 게 아니다.
- **JPA**: `jakarta.persistence.lock.timeout = 0` 힌트를 Hibernate의 PostgreSQL 방언이 `FOR UPDATE NOWAIT`로 번역한다. 55P03은 스프링 예외 변환에서 `CannotAcquireLockException`으로 매핑된다. **생성 SQL을 로그로 확인하고 쓴다** — 버전·방언마다 지원이 다르다.

```java
// 좌석 선점: 이미 남이 잡고 있으면 기다리지 않고 즉시 409로 응답한다
public interface SeatRepository extends JpaRepository<Seat, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "0"))  // 0 = NOWAIT
    @Query("select s from Seat s where s.id = :id")
    Optional<Seat> findByIdNoWait(@Param("id") Long id);
}

@Transactional
public void hold(Long seatId, Long userId) {
    try {
        Seat seat = seatRepository.findByIdNoWait(seatId).orElseThrow();
        seat.holdBy(userId);
    } catch (CannotAcquireLockException e) {          // 55P03 이 여기로 변환된다
        throw new SeatAlreadyBeingHeldException(seatId);   // 컨트롤러에서 409 + "다시 시도" 안내
    }
}
```

### 3-5. `SKIP LOCKED` — "잠긴 건 남의 것, 다음 것"

셋 중 **실무에서 가장 값어치가 큰 도구**다. 앞의 둘이 "대기 시간을 어떻게 할까"에 답한다면, `SKIP LOCKED`는 질문 자체를 바꾼다 — **"굳이 그 행이어야 하나?"** 아니라면 잠긴 행은 건너뛰고 다음 것을 집으면 된다.

이 한 줄이 열어 주는 것이 **작업 큐 패턴**이다. 워커 여러 개가 같은 테이블을 보면서도 서로 다른 행을 집어 가므로, **테이블 하나가 그대로 큐가 된다.** 별도 메시지 브로커 없이 "DB에 쌓고 워커가 꺼내 처리"를 안전하게 구현하는 PostgreSQL의 표준 해법이다.

```sql
-- 워커 N 개가 동시에 도는 작업 큐 — 이 한 문장이 패턴의 전부다
SELECT id, payload
  FROM job
 WHERE status = 'PENDING'
 ORDER BY id                        -- 대체로 오래된 것부터. 순서는 최선 노력이다(아래 대가 ②)
 LIMIT 10
   FOR NO KEY UPDATE SKIP LOCKED;   -- 다른 트랜잭션이 잠근 행은 건너뛰고, 안 잠긴 10건만 잠가서 가져온다
                                    -- status 만 바꾸므로 NO KEY UPDATE — job_log(job_id FK) INSERT 를 막지 않는다

-- PG 고유의 짝: 부분 인덱스 — PENDING 행만 담아 작고, id 순으로 바로 읽어 10건에서 멈춘다
CREATE INDEX job_pending_id_idx ON job (id) WHERE status = 'PENDING';
-- 계획: Limit → LockRows → Index Scan using job_pending_id_idx   (Sort 없음, Seq Scan 없음)
```

워커 셋이 동시에 이 문장을 치면 이렇게 나뉜다.

```text
job 테이블 (PENDING 상태의 행들)
  id: 101 102 103 104 105 106 107 108 ...

워커 A 가 먼저 진입 → 101~110 을 잠그고 가져감
워커 B 가 곧이어 진입 → 101~110 은 잠겨 있다 → 건너뜀 → 111~120 을 잠그고 가져감
워커 C 진입          → 101~120 건너뜀 → 121~130

SKIP LOCKED 가 없다면?
  워커 B 는 101 에서 대기 → A 가 커밋 → 101 의 status 가 PROCESSING 으로 바뀜
  → RC 재평가에서 조건 불일치로 탈락 → 다음 후보로 → 결국 진도는 나가지만
    "전원이 맨 앞 행에서 줄 서는" 구간이 매번 생긴다 = 워커를 늘려도 처리량이 안 는다
```

워커 쪽 코드는 **잠근 뒤 상태만 바꾸고 곧바로 커밋**하는 것이 핵심이다. 실제 처리는 락 밖에서 한다.

```java
// before — 워커 5개가 전부 같은 10건에서 줄을 선다. 인덱스도 없어 매번 Seq Scan + Sort,
//          FOR UPDATE 라 job_log INSERT 까지 막고, 처리까지 락 안에서 한다
@Lock(LockModeType.PESSIMISTIC_WRITE)
List<Job> findTop10ByStatusOrderByCreatedAt(JobStatus status);

// after — 잠긴 건 건너뛰고, 부분 인덱스로 10건에서 스캔을 멈추고, 상태만 바꾸고 바로 커밋
@Query(value = """
        SELECT * FROM job
         WHERE status = 'PENDING'
         ORDER BY id
         LIMIT :n
           FOR NO KEY UPDATE SKIP LOCKED
        """, nativeQuery = true)
List<Job> claimPending(@Param("n") int n);       // 부분 인덱스 ON job (id) WHERE status = 'PENDING' 필수

@Transactional
public List<Long> claim(int n) {
    List<Job> jobs = jobRepository.claimPending(n);
    jobs.forEach(j -> j.markProcessing(workerId));   // dirty checking → UPDATE (비키 갱신, NO KEY UPDATE)
    return jobs.stream().map(Job::getId).toList();   // 커밋 → 락 해제. 실제 처리는 이 트랜잭션 밖에서
}

// 호출부: 짧은 트랜잭션으로 "내 몫"만 확정하고, 처리는 락 밖에서
public void runOnce() {
    for (Long jobId : jobService.claim(10)) {        // 트랜잭션 ①: 선점 (수 ms)
        jobProcessor.process(jobId);                 // 트랜잭션 밖: 외부 호출·긴 계산도 여기서
    }
}
```

- **용도**: **여러 워커가 같은 테이블에서 서로 다른 행을 나눠 가져가야 할 때.** 작업 큐, 아웃박스 릴레이, 배치 분산 처리.
- **얻는 것**: 워커들이 같은 행에서 줄 서지 않는다 → 워커 수를 늘린 만큼 처리량이 는다.
- **대가**: ① **결과가 비결정적**이다 — 같은 쿼리를 두 번 쳐도 다른 행이 온다. "몇 건 남았나", "이 행이 존재하나" 같은 **정합성 판단에 쓰면 안 된다.** 오직 "내 몫 가져오기" 전용 ② 순서·공정성은 최선 노력이다 — 잠긴 행을 건너뛰므로 `ORDER BY`는 "대체로 그 순서"일 뿐 ③ 가져온 행은 커밋까지 잠긴다 → 위 코드처럼 **바로 커밋**해야 한다. 처리를 락 안에서 하면 §1-6의 기간 문제가 그대로 온다 ④ **스캔 비용을 없애 주지 않는다** — 인덱스가 없어 `Sort`가 남으면 PENDING 전부를 읽고 정렬한 뒤에야 안 잠긴 10건을 고른다. 폭은 10이지만 기간은 풀스캔이다. 부분 인덱스가 있어야 10건에서 스캔이 멈춘다 ⑤ 워커가 죽어 트랜잭션이 롤백되면 그 행은 다시 PENDING으로 돌아온다(좋은 성질이지만, `markProcessing` 커밋 후에 죽으면 PROCESSING에 남아 고아가 되므로 **오래된 PROCESSING을 회수하는 청소 배치**가 짝으로 필요하다).
- **JPA**: 가장 확실한 방법은 위처럼 네이티브 쿼리에 직접 쓰는 것. Hibernate는 `jakarta.persistence.lock.timeout = -2`(`LockOptions.SKIP_LOCKED`)를 PostgreSQL 방언에서 `SKIP LOCKED`로 번역하지만, `NO KEY UPDATE`는 JPA 표준에 없으므로 어차피 네이티브다. **생성 SQL 확인이 전제**다.

### 3-6. 한 장으로 정리

| 도구 | 잠긴 행을 만나면 | 어울리는 상황 | 지불하는 것 |
|---|---|---|---|
| `FOR UPDATE` | 대기 (`lock_timeout`까지) | 행 삭제·키 변경 전 잠금 | 최강 모드 — FK 자식 INSERT까지 막음, 대기열 |
| `FOR NO KEY UPDATE` | 대기 | 잔액·상태·수량 등 비키 갱신 전 잠금(**업무 락의 기본형**) | 다른 갱신은 막되 FK 검사만 통과 — 이름이 낯설어 리뷰어 학습 필요, JPA 표준 매핑 없음 |
| `lock_timeout` | n초 후 실패(55P03) | **모든** 락 대기의 기본 상한 | 실패 처리, 트랜잭션 abort, 획득 시도마다 따로 적용 |
| `... NOWAIT` | 즉시 실패(55P03) | 사용자 대면 선점 | 실패 처리·재시도 설계, 트랜잭션 abort, 가해자는 못 고침 |
| `... SKIP LOCKED` | 건너뜀 | 워커 간 작업 분배(작업 큐) | 결과 비결정성, 정합성 판단 불가, 고아 행 청소 배치 |
| 원자적 UPDATE | 대기 | 읽기-계산-쓰기가 한 문장으로 압축될 때 | 폭 규칙 동일, 영속성 컨텍스트 우회 (03장) |
| 낙관적 락 | (읽을 때 안 잠금) | 충돌이 드물 때 | 재시도 코드, 실패 노출 (03장) |

표는 비교용이고, 선택의 문장은 이것이다 — **폭을 먼저 좁히고(등호 조건), 기간을 줄이고(인덱스 + 락 안 왕복·외부 호출 제거), 강도를 맞추고(키 안 바꾸면 `NO KEY UPDATE`), 마지막에 대기 정책(`lock_timeout` / `NOWAIT` / `SKIP LOCKED`)을 고른다.**

### 3-7. 애플리케이션 쪽 락은 03장, 여기는 DB 쪽

경계를 한 번 더 그어 둔다. JPA의 `LockModeType`이 무엇을 뜻하는지, 낙관적 락의 `@Version`을 어떻게 붙이는지, 재시도를 어디에 두는지 같은 **애플리케이션 쪽 설계**는 [낙관적 락 vs 비관적 락](../03-jpa-orm/10-optimistic-vs-pessimistic-lock.md)과 [동시성 갱신 4가지 비교](../03-jpa-orm/20-concurrency-update-four-approaches.md)가 본론이다.

여기서 다루는 것은 그 위임의 **결과로 DB에 나가는 SQL이 무엇을 얼마나 잠그는가**다. 그래서 아래 before/after의 관심사도 "어떤 어노테이션을 쓸까"가 아니라 **"생성된 SQL의 폭·기간·강도가 의도와 같은가"** 하나다.

### 3-8. JPA before / after

```java
// before
public interface CouponRepository extends JpaRepository<Coupon, Long> {

    // 나가는 SQL: select ... from coupon c where c.code=? for update
    // 문제 1: coupon.code 에 인덱스가 없다 → Seq Scan 120만 행 → 잠기는 건 1행이지만 문장이 400ms.
    //         같은 쿠폰을 노리는 요청들이 그 구간에서 직렬화되고 각자 커넥션을 쥔다 (기간 사고)
    // 문제 2: FOR UPDATE(최강 모드) → 이 쿠폰을 참조하는 coupon_redemption(coupon_id FK) INSERT 가 전부 대기.
    //         바꾸는 건 redeemed 플래그뿐인데 키까지 잠갔다 (강도 사고)
    // 문제 3: 파생 쿼리라 SQL 이 코드에 안 보인다 → 리뷰어가 "findByCode 니까 한 건이겠지" 하고 지나간다
    // 문제 4: 락 대기 상한이 없다 → lock_timeout 기본 0(무한). 앞 트랜잭션이 끝날 때까지 커넥션을 쥔다
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<Coupon> findByCode(String code);
}

@Transactional
public void redeem(String code, Long userId) {
    Coupon coupon = couponRepository.findByCode(code).orElseThrow();   // 여기서 400ms 동안 쥔다
    coupon.redeem(userId);
}
```

```java
// after (A) — 유니크 인덱스 + 명시적 SQL + 맞는 강도
// 마이그레이션(Flyway): CREATE UNIQUE INDEX CONCURRENTLY ux_coupon_code ON coupon (code);
//   CONCURRENTLY 는 트랜잭션 블록 안에서 못 돌므로 이 스크립트만 비트랜잭션으로 설정한다 (14 문서)

public interface CouponRepository extends JpaRepository<Coupon, Long> {

    // Index Scan using ux_coupon_code → LockRows rows=1, Buffers 4 → 락까지 0.1ms
    // NO KEY UPDATE: redeemed 만 바꾸므로 키를 잠글 이유가 없다 → coupon_redemption INSERT 를 막지 않는다
    // JPA 표준에는 NO KEY UPDATE 가 없어 네이티브로 쓴다 — SQL 이 코드에 보이는 것 자체가 리뷰 가능성이다
    @Query(value = "SELECT * FROM coupon WHERE code = :code FOR NO KEY UPDATE", nativeQuery = true)
    Optional<Coupon> findByCodeForUpdate(@Param("code") String code);
}
```

```java
// after (B) — 표준 JPA 만 써야 할 때: 명시적 JPQL + @Lock. 나가는 SQL 은 FOR UPDATE(최강)이므로
//     이 테이블을 FK 로 참조하는 자식 INSERT 가 동시에 없을 때만 고른다
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("select c from Coupon c where c.code = :code")
Optional<Coupon> findByCodeForUpdate(@Param("code") String code);
// 대기 상한을 힌트로 주고 싶다면 값의 의미를 알고 쓴다:
//   0  → FOR UPDATE NOWAIT      (즉시 실패)
//   -2 → FOR UPDATE SKIP LOCKED (건너뛰기)
//   양수 → PostgreSQL 에서는 SQL 로 번역되지 않는다 (WAIT n 구문이 없다)
// → 일반적인 "n초만 기다린다"는 3-3 의 lock_timeout 설정으로 건다
```

```java
// after (C) — "락은 항상 PK 로만 건다" 규칙으로 기간과 락 획득 순서를 코드 구조에 고정
@Transactional
public void redeem(String code, Long userId) {
    // 1) 락 없는 스냅샷 읽기로 PK 만 얻는다 — 인덱스가 없어도 느릴 뿐, 남을 세우지 않는다(MVCC)
    //    엔티티가 아니라 id 프로젝션이어야 한다: 엔티티를 먼저 로드해 두면 2)의 em.find 는
    //    이미 관리 중인 엔티티에 락 문장만 보내고 상태를 새로 읽지 않는다 → 3)의 재검증이 헛돈다
    Long couponId = couponRepository.findIdByCode(code).orElseThrow();

    // 2) PK 로 잠근다 — select ... where id=? for update. Index Scan 으로 계획이 "고정"된다
    Coupon coupon = em.find(Coupon.class, couponId, LockModeType.PESSIMISTIC_WRITE);

    // 3) 잠근 뒤 조건을 다시 검증한다 — READ COMMITTED 라 1)의 스냅샷과 2)의 최신 버전이 다를 수 있다
    if (coupon.isRedeemed()) throw new AlreadyRedeemedException(code);
    coupon.redeem(userId);
}
```

(C)의 가치는 **누가 나중에 인덱스를 지우거나 조건을 바꿔도 락 문장의 실행 계획이 PK 조회로 유지된다**는 데 있다. PG에서 폭은 원래 1이었으므로 (C)가 지키는 것은 폭이 아니라 **기간**이고, 여러 행을 잠그는 로직이라면 PK 순서로 잠그게 되므로 §2-2 갈래 ⑵의 데드락도 함께 막는다. 대가는 왕복 1회 추가와 3)의 재검증 습관, 그리고 여전히 `FOR UPDATE`라는 강도(자식 INSERT가 있으면 (A)로).

### 3-9. 코드 리뷰 체크리스트 — `FOR UPDATE` / `@Lock(PESSIMISTIC_WRITE)`가 보이면

```text
[ ] 1. WHERE 조건이 잠글 행을 좁게 특정하는가? (폭 = 매치 행 수.
       status='PENDING' 같은 넓은 조건이면 몇 행이 잠기는지 계산해 봤는가)
[ ] 2. 그 조건에 인덱스가 있고, PR 에 EXPLAIN (ANALYZE, BUFFERS) 가 첨부돼 있는가?
       LockRows 아래가 Index Scan, LockRows actual rows 가 의도한 수, Buffers 가 한두 자릿수.
       파생 쿼리·@Lock 이면 먼저 생성 SQL 을 확보한다 (p6spy / hibernate show_sql)
       — "SQL 이 안 보이는 락"은 리뷰가 불가능한 락이다. EXPLAIN ANALYZE 는 실제로 잠그므로 BEGIN…ROLLBACK 안에서
[ ] 3. 강도가 맞는가? 키(PK·유니크)를 안 바꾸고 안 지우면 FOR NO KEY UPDATE.
       이 테이블을 FK 로 참조하는 자식 테이블의 INSERT 경로를 확인했는가?
[ ] 4. 조인이 있으면 OF 로 잠글 테이블을 한정했는가? OFFSET 이 없는가?
[ ] 5. 락 보유 구간(FOR UPDATE ~ 커밋)에 외부 호출·긴 계산·불필요한 왕복이 없는가? (기간)
[ ] 6. 여러 행을 잠근다면 락 획득 순서가 고정돼 있는가? (인덱스 스캔 또는 ORDER BY — 2-2 갈래 ⑵)
[ ] 7. lock_timeout 이 걸려 있고, 55P03 실패 시 동작이 정해져 있는가? (대기 n초 / NOWAIT / SKIP LOCKED, 예외 매핑)
[ ] 8. "없을 수도 있는 행"을 FOR UPDATE 로 잠그려 하지 않는가? (갭 락 없음 → UNIQUE/ON CONFLICT/advisory)
[ ] 9. 락 회귀 테스트가 있는가? (3-12)
```

2번이 핵심이다. `FOR UPDATE`가 붙은 쿼리는 **EXPLAIN 없이 머지하지 않는다**를 팀 규칙으로 두면([EXPLAIN 읽는 법](10-explain-and-slow-query-process.md)), 기간 사고의 절대다수(인덱스 없음·함수·캐스트)가 리뷰 단계에서 걸린다. 3번은 PG 팀만 갖는 항목이다 — MySQL 경험자가 합류하면 이 줄부터 설명한다.

### 3-10. 락 대기 타임아웃 — 세 층으로 상한을 건다

3-3에서 `lock_timeout` 하나를 봤다. 운영에서는 그것만으로 부족하다 — 기본값으로 두면 §2-5 사슬의 ④⑤⑥이 **무한 + 30초** 동안 진행된다. 상한을 세 층에 걸고, **아래층이 위층보다 짧게** 맞춘다.

```text
① 대기자 상한   lock_timeout   기본 0(무한) → 3~5초
                ALTER ROLE app_user SET lock_timeout = '3s';     -- 롤 단위: PgBouncer transaction pooling 에서도 안전
                (또는 HikariCP connectionInitSql = "SET lock_timeout = '3s'", 트랜잭션 안에서는 SET LOCAL)
                초과 시 ERROR 55P03 "canceling statement due to lock timeout"
                 → 그 문장만이 아니라 트랜잭션이 abort 상태가 된다 → 애플리케이션은 ROLLBACK 후 재시도/실패 응답
                주의: 락 획득 시도마다 따로 적용된다(누적 아님). 테이블 락·행 락·트랜잭션 ID 대기 전부에 적용

② 보유자 상한   statement_timeout                    — 문장 하나(풀스캔 FOR UPDATE 자체)의 상한
                idle_in_transaction_session_timeout  — 락을 쥔 채 앱에서 놀고 있는 트랜잭션을 강제 종료
                @Transactional(timeout = 5)          — 트랜잭션 전체 시간(기간)의 상한.
                                                       lock_timeout 이 누적 상한이 아니므로 이 층이 필요하다

③ 커넥션 풀     HikariCP connectionTimeout  기본 30초
                여기까지 오면 이미 무관한 API 로 전파된 뒤다. 마지막 방어선이지 대책이 아니다
```

순서를 지키는 이유 — ①이 ③보다 길면, 락을 기다리는 요청이 아직 안 끝났는데 그 뒤에서 커넥션을 기다리던 요청이 먼저 실패한다. **피해가 가해보다 먼저 터지면 원인 추적이 어려워진다.**

### 3-11. 잠긴 행과 대기열 확인법 — 네 개의 창

"몇 개나 잠겼나, 누가 막고 있나"를 추측하지 않는다.

```sql
-- ① 누가 기다리고 누가 막고 있나 — 장애 중 가장 먼저 여는 창
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start  AS xact_age,
       now() - query_start AS query_age,
       pg_blocking_pids(pid) AS blocked_by,
       left(query, 80) AS query
  FROM pg_stat_activity
 WHERE cardinality(pg_blocking_pids(pid)) > 0 OR wait_event_type = 'Lock'
 ORDER BY xact_start;
-- wait_event = transactionid : 잠긴 행의 xmax 트랜잭션이 끝나길 대기 (행 락 대기의 실제 모습)
-- wait_event = tuple         : 같은 행 대기열의 2번째 이후 (첫 대기자만 transactionid)
-- wait_event = relation      : 테이블 락 대기 — DDL 이 끼어든 경우 (14 문서)
-- blocked_by 에 같은 pid 가 수십 번 나오면 그 pid 가 범인. 그 pid 의 state 가 'idle in transaction' 이면
-- "락 쥔 채 앱에서 놀고 있는" 트랜잭션 — 쿼리가 아니라 트랜잭션 경계가 원인

-- ② 락 요청 목록 — 행 락 자체는 여기 없다(튜플 헤더에 있으므로). 보이는 건 대기 중 요청과 테이블 락
SELECT locktype, relation::regclass, mode, granted, pid, transactionid
  FROM pg_locks
 WHERE NOT granted;
--  transactionid | (null) | ShareLock | f | 91234 | 421874     ← 행 락 대기의 pg_locks 표현

-- ③ 어떤 행이 어떤 모드로 잠겨 있나 — pgrowlocks 확장(contrib). 테이블을 스캔하므로 진단용으로만
CREATE EXTENSION IF NOT EXISTS pgrowlocks;
SELECT locked_row, locker, multi, modes, pids FROM pgrowlocks('coupon');
--  (0,3) | 421874 | f | {"For Update"} | {88}
-- 여기 행 수가 "의도한 폭"과 다르면 조건이 넓다는 뜻. modes 에 "For Update" 가 보이면 강도를 의심
```

```text
-- ④ 서버 로그: log_lock_waits = on (deadlock_timeout=1s 이상 기다리면 기록. 상시 켜 둔다)
LOG:  process 91234 still waiting for ShareLock on transaction 421874 after 1000.312 ms
DETAIL:  Process holding the lock: 88. Wait queue: 91234, 91250, 91277.
CONTEXT:  while locking tuple (0,3) in relation "coupon"          ← 어느 튜플에서 막혔는지까지
STATEMENT:  SELECT * FROM coupon WHERE code = $1 FOR UPDATE
```

**알림**은 `pg_stat_activity`를 주기 샘플링해 `wait_event_type = 'Lock'`인 세션 수와 `max(now() - xact_start)`로 건다(RDS Performance Insights의 `Lock:transactionid` 대기 이벤트가 이것이다).

즉시 조치는 `SELECT pg_terminate_backend(88)` — 세션 종료 → 롤백 → 락 해제 → 대기열이 풀린다. `pg_cancel_backend`는 실행 중인 문장만 취소하므로 범인이 `idle in transaction`이면 효과가 없다.

### 3-12. 테스트로 고정 — 폭·강도·계획 회귀 테스트

"이 락은 좁고, 약하고, 빠르다"를 테스트로 박아 두면, 누가 인덱스를 지우거나 `FOR UPDATE`로 되돌리는 순간 CI가 잡는다.

두 커넥션을 직접 쓴다 — `@Transactional` 테스트 안에서는 두 트랜잭션이 재현되지 않는다([낙관적 락 vs 비관적 락 §3](../03-jpa-orm/10-optimistic-vs-pessimistic-lock.md)). 그리고 **H2가 아니라 Testcontainers로 운영과 같은 PostgreSQL**을 띄운다. 락 모양은 엔진마다 다르다.

```java
@Test
void redeem_lock_is_narrow_weak_and_indexed() throws Exception {
    try (Connection holder = dataSource.getConnection();
         Connection other  = dataSource.getConnection()) {

        holder.setAutoCommit(false);
        try (var ps = holder.prepareStatement(          // 리포지토리와 같은 문장 (상수로 공유)
                "SELECT * FROM coupon WHERE code = ? FOR NO KEY UPDATE")) {
            ps.setString(1, "SUMMER-2026");
            ps.executeQuery();                              // 락을 쥔 채 커밋하지 않는다
        }

        other.setAutoCommit(false);
        other.createStatement().execute("SET lock_timeout = '1s'");   // 막히면 1초 뒤 55P03 → 테스트 실패

        // ① 폭: 다른 쿠폰 행은 막히면 안 된다 — 조건이 넓어졌거나 테이블 락으로 바뀌었는지 감시
        assertDoesNotThrow(() -> other.createStatement()
                .executeUpdate("UPDATE coupon SET redeemed = redeemed WHERE code = 'WINTER-2026'"));

        // ② 강도: 잠긴 쿠폰을 참조하는 자식 INSERT 가 막히면 안 된다 — 누가 FOR UPDATE 로 되돌리면 여기서 실패한다
        assertDoesNotThrow(() -> other.createStatement()
                .executeUpdate("INSERT INTO coupon_redemption (coupon_id, user_id) "
                             + "SELECT id, 999 FROM coupon WHERE code = 'SUMMER-2026'"));

        // ③ 기간: 락 문장이 인덱스를 타는지 — 인덱스가 사라지면 Seq Scan 으로 바뀐다 (EXPLAIN 은 잠그지 않는다)
        try (var rs = holder.createStatement().executeQuery(
                "EXPLAIN (FORMAT JSON) SELECT * FROM coupon WHERE code = 'SUMMER-2026' FOR NO KEY UPDATE")) {
            rs.next();
            assertThat(rs.getString(1)).contains("\"Index Scan\"").doesNotContain("\"Seq Scan\"");
        }

        other.rollback();
        holder.rollback();
    }
}
```

> **주의** — ③은 데이터 양과 통계에 좌우된다. 행이 몇 개뿐인 테스트 DB에서는 플래너가 유니크 인덱스가 있어도 Seq Scan을 고르는 게 정상이라 거짓 실패한다. 실전 규모 시드 + `ANALYZE`가 필요하고([08 문서 §3-4](08-composite-index-column-order.md)의 같은 주의), 그래서 이 단정은 락 사고가 곧 장애인 쿼리 몇 개에만 건다. ①②는 데이터 양과 무관하게 항상 유효하다.

---

## 4. 꼬리질문 대비 포인트

### "PostgreSQL은 기본이 READ COMMITTED인데, REPEATABLE READ로 올리면 `FOR UPDATE` 동작이 달라지나요?"

**잠기는 폭·모드·갭 없음은 그대로고, 동시 갱신을 만났을 때의 처리만 달라진다.** RC에서는 후보 행이 동시 트랜잭션에 의해 갱신 중이면 기다렸다가 **최신 버전을 재평가해 잠그고 진행**한다(§2-4 ②) — 문장이 "성공"으로 끝난다. RR에서는 트랜잭션 스냅샷이 고정돼 있어, 잠그려는 행이 내 스냅샷 이후 다른 트랜잭션에 의해 갱신·삭제됐으면 재평가 대신 `ERROR 40001 could not serialize access due to concurrent update`로 **트랜잭션 전체가 실패**한다 → 애플리케이션 재시도가 필수다. 즉 격리 수준을 올린다고 락 사고가 줄지 않는다 — "기다렸다 최신 값으로 진행"이 "실패로 알려줌"으로 바뀔 뿐이다. 그래서 MySQL식 "RC로 낮추면 완화된다"는 처방은 PG에 없다 — 애초에 RC가 기본이고 락 폭은 격리 수준과 무관하다([격리 수준 문서](transaction-isolation-levels.md)).

### "인덱스로 찾았는데 인덱스 엔트리는 안 잠근다면, PK로 직접 오는 UPDATE는 어떻게 막히나요?"

**모든 경로가 힙 튜플에서 끝나기 때문이다.** 인덱스는 리프에 TID만 들고 있는 경로일 뿐 정본이 아니고, 갱신은 힙에서 일어난다(새 버전 삽입 + 옛 버전 `xmax`). 그러니 어떤 인덱스로 오든 힙 튜플을 집는 순간 `xmax`에 남의 락이 보인다. 커버링 인덱스로 평소엔 힙을 안 가는 쿼리도 `FOR UPDATE`면 `LockRows`가 힙 튜플을 가져와 잠근다. 대가는 §1-4에서 말한 그대로 — 인덱스에 락도 버전도 없으니 "이 키의 행이 아직 없다"는 상태를 잠글 수 없고(갭 락 부재), 유일한 예외가 유니크 인덱스 삽입 시 동일 키 대기다(12 문서).

### "락이 걸려 있는 동안 다른 트랜잭션의 일반 SELECT는 왜 안 막히나요? 그 값을 믿어도 되나요?"

일반 SELECT는 잠금 읽기가 아니라 **MVCC 스냅샷 읽기**([MVCC](11-mvcc-postgresql.md))라 락 큐에 서지 않는다 — `xmax`에 "락 전용" 비트가 서 있으면 가시성 판정에 영향이 없다. 그래서 풀스캔 `FOR UPDATE` 장애의 증상이 "조회는 되는데 저장이 안 된다"로 나타난다. 그 값을 **믿어도 되는 용도와 안 되는 용도**가 갈린다 — 화면 표시, 통계, 목록에는 충분하다. 그러나 **"읽은 값을 근거로 쓰기를 결정"하는 로직**(재고 확인 후 차감, 쿠폰 상태 확인 후 사용)에는 안 된다. 읽는 순간 이미 남이 잠그고 바꾸는 중일 수 있고, RC라 같은 트랜잭션 안의 다음 문장은 다른 스냅샷을 본다. 결정에 쓰이는 읽기는 `FOR NO KEY UPDATE` / `FOR UPDATE`이거나, 읽기-결정-쓰기를 한 문장으로 압축한 원자적 UPDATE여야 한다.

### "잔액 갱신 로직에 `FOR UPDATE`를 썼더니 거래내역 INSERT가 멈춥니다. 왜죠?" (시니어 변별 포인트)

**FK 검사가 부모 행에 `FOR KEY SHARE`를 요구하는데, `FOR UPDATE`가 4종 중 유일하게 그것과 충돌하기 때문이다.** 계좌를 `FOR UPDATE`로 쥔 동안 그 계좌를 참조하는 `transactions` INSERT는 전부 `transactionid` 대기에 걸린다. 판단 기준은 하나 — **"이 트랜잭션이 부모의 키를 바꾸거나 행을 지우는가?"** 잔액은 키가 아니므로 `FOR NO KEY UPDATE`가 정확한 도구이고, 그러면 자식 INSERT는 통과한다. 한 발 더: 자식 INSERT(부모에 KEY SHARE) 뒤에 부모 `FOR UPDATE`를 잡는 트랜잭션 둘이 교차하면 `40P01 deadlock detected`다 — `NO KEY UPDATE`면 충돌 자체가 없어 데드락도 사라진다([12 문서](12-gap-lock-next-key-lock-deadlock.md)). JPA 표준에는 이 모드가 없어 네이티브 쿼리로 쓴다. "InnoDB에는 이 구분이 없다 — 부모 X 락은 항상 자식 INSERT의 S 락 요청을 막는다"까지 말하면 PG를 원리로 쓴다는 인상을 준다.

### "`SELECT FOR UPDATE` 대신 `UPDATE ... WHERE code = $1`로 바로 치면 이 문제가 없어지나요?" (시니어 변별 포인트)

**폭은 원래 문제가 아니었고, 기간과 강도에서 이긴다.** `UPDATE`도 매치 행만 잠근다 — 규칙은 같다. 인덱스가 없으면 `UPDATE`도 Seq Scan이라 기간 사고는 그대로다. 이기는 것은 ① **기간**(왕복 1회로 락 구간이 끝난다)과 ② **강도** — 비키 갱신 `UPDATE`는 `FOR NO KEY UPDATE`만 잡아 자식 INSERT를 막지 않는다. "`SELECT FOR UPDATE` + `UPDATE`" 조합이 `UPDATE` 단독보다 **더 센 락**을 잡는 역설이 여기 있다. 대신 `UPDATE`는 새 튜플 버전을 만들고(비-HOT이면 모든 인덱스 갱신, bloat), `FOR UPDATE`는 `xmax` 표시만 한다. 그리고 `UPDATE ... WHERE status = 'PENDING'` 같은 배치 갱신은 매치 행 전부를 잠그고 스캔 시간만큼 쥐므로, 인덱스와 청크 분할 없이 날리면 같은 사고다. **폭은 문장의 종류가 아니라 조건이, 기간은 실행 계획이 정한다.**

### "운영 중 '락 대기' 알림이 왔습니다. 어디부터 보나요?" (가산점 포인트)

순서를 정해 둔다. ① `pg_stat_activity` + `pg_blocking_pids()`로 **범인 pid, 그 state, `xact_age`** 를 본다 — 대기자 수십에 범인 하나면 같은 행 경쟁, 범인이 `idle in transaction`이면 쿼리가 아니라 트랜잭션 경계 문제. ② 범인의 `query`를 `EXPLAIN` — `LockRows` 아래가 `Seq Scan`이면 기간(인덱스), 조건이 넓으면 폭, 대기자가 다른 테이블의 INSERT면 강도(`FOR UPDATE` vs FK). `wait_event`가 `relation`이면 DDL이 끼어든 것(14 문서). ③ 즉시 조치는 `pg_terminate_backend(범인)` — 대기열이 풀린다(`idle in transaction`엔 cancel이 안 통한다). ④ 근본 조치는 `CREATE INDEX CONCURRENTLY` / `NO KEY UPDATE` / 조건 축소 배포. ⑤ 재발 방지는 롤 단위 `lock_timeout`, `idle_in_transaction_session_timeout`, `log_lock_waits`, §3-9 체크리스트와 §3-12 테스트. 이 다섯을 이름으로 말할 수 있으면 장애를 겪어 본 사람으로 읽힌다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **락의 위치와 폭** — InnoDB는 스캔한 **인덱스 레코드**에(RR이면 앞 갭까지), PG는 WHERE 통과 후 **힙 튜플**에만. 그래서 인덱스 부재 시 MySQL은 사실상 테이블 락(폭 사고), PG는 느린 스캔 + 매치 행만(기간 사고)이다 — 질문의 답 방향이 정반대다. ② **갭 락·넥스트 키 락 부재** — PG는 "없는 행"·범위를 못 잠근다(check-then-insert는 UNIQUE/ON CONFLICT/advisory/SERIALIZABLE). 반대로 MySQL RR에서 `LIMIT n FOR UPDATE`가 filesort로 큐 전체를 잠그던 사고는 PG에서 `Limit` 아래 `LockRows`가 n건에서 멈춰 나지 않는다. ③ **락 모드** — InnoDB는 S/X(+갭·insert intention), PG는 4단계에 FK가 `KEY SHARE`를 잡아 `FOR UPDATE` vs `FOR NO KEY UPDATE`의 선택이 PG에만 있다. InnoDB는 부모 `UPDATE`든 `FOR UPDATE`든 X 락이라 자식 INSERT를 막는 걸 피할 수단이 없다. ④ **락 저장과 관측** — InnoDB는 메모리 락 구조체(`trx_rows_locked`, `data_locks`로 셀 수 있고 행 수만큼 메모리), PG는 튜플 헤더 `xmax`(개수 제한·에스컬레이션 없음, 대신 락도 페이지 더티 + WAL, `pg_locks`엔 안 보여 `pgrowlocks`). 세컨더리 → 클러스터드 연쇄 잠금도 PG엔 없다. ⑤ **기본 격리와 타임아웃 뒤 상태** — MySQL은 RR 기본(+갭), `innodb_lock_wait_timeout` 50초 뒤 그 문장만 실패하고 트랜잭션은 계속. PG는 RC 기본(EvalPlanQual 재평가), `lock_timeout` 기본 무한, 초과 시 55P03과 함께 **트랜잭션이 abort 상태**라 반드시 ROLLBACK. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "차이를 저장 구조에서 도출했다"로 들린다.

---

## 한 줄 요약

**PostgreSQL의 `SELECT ... FOR UPDATE`는 테이블에 ROW SHARE, 그리고 WHERE를 통과해 반환된 힙 튜플에만 행 락(튜플 헤더 `xmax`에 기록, 갭 락·인덱스 엔트리 락 없음)을 건다 — 반환 행 = 잠긴 행. 그래서 인덱스를 못 타도 테이블이 잠기지는 않지만, 잠근 채 스캔이 끝날 때까지의 기간이 늘어 같은 행 경쟁이 그 구간에 직렬화되고(커넥션 고갈은 이 경로로 온다), 스캔 시작 지점이 세션마다 달라 락 획득 순서가 어긋나면 데드락까지 나며, READ COMMITTED의 재평가로 후보 행마다 대기가 생기고, 조건이 넓으면 매치 행 전부가, 조인이면 모든 테이블이 잠기며, `FOR UPDATE`는 FK의 `KEY SHARE`와 충돌해 자식 INSERT까지 막고, 없는 행은 못 잠근다. 처방은 폭(등호 조건) → 기간(인덱스, 락 안 왕복 제거) → 강도(키 안 바꾸면 `FOR NO KEY UPDATE`) → 대기 정책(무한 대기를 막는 `lock_timeout`, 기다리지 않는 `NOWAIT`, 남의 것은 건너뛰고 작업 큐를 만드는 `SKIP LOCKED`) 순이고, 그것을 EXPLAIN의 `LockRows`·`Buffers` 증빙, 롤 단위 `lock_timeout`, `pg_stat_activity` + `pg_blocking_pids` · `log_lock_waits` 관측, 폭·강도·계획 회귀 테스트로 사람의 기억 밖에 고정한다.**
