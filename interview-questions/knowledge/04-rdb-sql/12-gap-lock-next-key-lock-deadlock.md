# 갭 락과 넥스트 키 락 — PostgreSQL에는 없다. 팬텀은 스냅샷이 막고, 데드락은 다른 곳에서 난다

> 핵심 관전 포인트: **PostgreSQL에는 갭 락도 넥스트 키 락도 없다. PG의
> 행 락은 별도 락 메모리가 아니라 **튜플 헤더의 `xmax`에 적히는 표시**라서
> 존재하는 튜플만 잠글 수 있고, 없는 행·빈 구간은 잠글 대상 자체가 없다.
> 갭 락이 풀던 문제는 다른 도구가 푼다 — 팬텀은 REPEATABLE READ의 스냅샷
> (뒤에 커밋된 행이 아예 안 보인다)과 SERIALIZABLE의 SSI(의존성을 추적해
> `40001`로 abort → 재시도)가, "조회해서 없으면 INSERT" 경쟁은 UNIQUE 제약 +
> `INSERT ... ON CONFLICT`·advisory lock이 막는다. 그래서 PG의 핵심 함정은
> 데드락이 아니라 **"없는 행에 `FOR UPDATE`를 걸면 아무것도 안 잠기고 두
> 트랜잭션이 모두 INSERT에 성공해 조용히 중복이 생긴다"**는 것이다. PG의
> 데드락은 넷 — ① 같은 행들을 다른 순서로 ② 유니크 키 삽입 대기 교차
> ③ 부모 행 `FOR UPDATE` ↔ 자식 INSERT의 FK `KEY SHARE` 충돌 ④ UPSERT
> 배치의 행 순서 불일치. `deadlock_timeout`(1초) 뒤 한쪽이 `40P01`로 abort되고,
> 진단은 서버 로그의 "waits for ShareLock on transaction" + `pg_blocking_pids()`,
> 처방은 격리 수준이 아니라 **키 순서 정렬 · `FOR NO KEY UPDATE` · 배치
> `ORDER BY` · 없는 행은 제약에 맡기기**에 트랜잭션 밖의 제한된 재시도를
> 안전망으로 얹는 것이다.**

---

## 0. 질문 + 의도

**질문**: "갭 락(gap lock), 넥스트 키 락이란? 어떤 상황에서 데드락을 유발하나요?"

**PostgreSQL 기준 재해석**: "PostgreSQL에는 갭 락·넥스트 키 락이 없다.
그러면 갭 락이 막던 문제(팬텀, 존재하지 않는 행을 둘러싼 경쟁)를 PG는
무엇으로 막고, 그 대신 PG의 데드락은 어디서 나는가?"

관련 질문:
"대량 UPSERT(`INSERT ... ON DUPLICATE KEY UPDATE`)의 동작과 주의점은? (AUTO_INCREMENT 소모, 데드락)"
→ PG 기준: "`INSERT ... ON CONFLICT DO UPDATE` 대량 배치의 시퀀스 소모와 데드락"
"`SELECT ... FOR UPDATE`는 어떤 락을 잡나요? WHERE 조건이 인덱스를 못 타면 무슨 일이 벌어지나요?"

**출제 의도**: rationale은 이렇게 적는다 — "**'INSERT만 하는데 데드락'이라는,
원리를 모르면 이해 불가능한 운영 현상의 정체. 데드락 로그를 읽고 원인
트랜잭션 쌍을 특정하는 실무 능력과 직결된다.**" PG 사용자에게 이 문항은 한
겹 더 까다롭다 — 질문에 등장하는 개념이 자기 DB에 없으므로, **"없다"고
말한 뒤 "그러면 같은 문제를 무엇이 대신 푸는가"까지** 가야 답이 된다. 채점
지점은 셋이다. ① PG 행 락의 구조(튜플 헤더 `xmax`, 4종 모드, 없는 행은 못
잠금)를 사실로 아는가 ② 그 구조에서 "check-then-insert는 데드락이 아니라
중복으로 끝나고, 데드락은 행 순서·유니크 대기·FK KEY SHARE에서 난다"는
타임라인을 **스스로 그려내는가** ③ 서버 로그와 `pg_locks`로 원인 트랜잭션
쌍을 특정하고, 재발 방지를 **코드로 고정**하는가.

**이 문서가 특히 겨냥하는 지점** (3장·4장 면접 기록 기준):

- 3장에서 데드락은 **조건을 다 깔아줘도 힌트가 있어야 도달한** 축이었다.
  락 충돌은 알면 즉시 보이고 모르면 영원히 안 보이는 유형이라, 결론 대신
  **두 세션의 시간 순 표로 한 스텝씩** 그린다(§3).
- MySQL 경험을 그대로 옮긴 "없으면 INSERT" 코드가 PG에서는 **에러 없이
  중복**을 만든다 — 데드락보다 조용하고 위험한 함정을 정면으로 다룬다(§2-3).
- 4장 내내 비용을 "락 경합"으로 뭉뚱그리던 습관 — 락 대기 비용을
  **메커니즘 사슬**로 끝까지 잇고(§1-6), 처방마다 **얻는 것 / 내주는 것**을
  나란히 둔다(§6).
- 안전망을 코드로 고정하는 습관 부재 — 로그 읽기 절차 · 재현 테스트 ·
  재시도 정책을 전부 **코드와 절차**로 적는다(§4, §5).

## 1. 전제 — PostgreSQL의 행 락은 "튜플에 적힌 표시"라서 없는 행은 못 잠근다

### 1-1. 락이 어디에 있나 — 별도 락 메모리가 아니라 튜플 헤더 `xmax`

`SELECT ... FOR UPDATE`나 `UPDATE`가 행을 잠글 때 PG가 하는 일은 **그 튜플
헤더의 `xmax` 필드에 자기 트랜잭션 ID를 적고, infomask 비트로 "이건 삭제가
아니라 락"이라고 표시하는 것**이다(공유 계열 락을 여러 트랜잭션이 함께
잡으면 XID 대신 `multixact` ID가 적힌다). 락이 튜플 안에 있으므로 세
가지가 따라온다:

- **행 수 제한도 락 에스컬레이션도 없다.** 100만 행을 잠가도 락 테이블이
  넘치지 않는다(대신 100만 튜플에 쓰기가 일어나 WAL이 늘어난다).
- **잠긴 행을 만난 트랜잭션은 "그 행"이 아니라 "그 XID"를 기다린다.**
  `pg_stat_activity`에 `wait_event_type = Lock`, `wait_event = transactionid`로
  보이고, 데드락 로그에 "ShareLock on transaction N"으로 찍히는 이유다(§4).
- **존재하지 않는 튜플에는 적을 자리가 없다.** `WHERE user_id = 15`에
  해당하는 행이 없으면 `FOR UPDATE`는 0행을 반환하고 **아무것도 잠그지
  않는다.** 범위(`WHERE id > 10`)도 마찬가지 — 지금 있는 행들만 잠기고,
  앞으로 들어올 행은 막지 못한다.

이 마지막 문장이 이 문서 전체의 축이다. 갭 락은 "아직 없는 행을 미리
잠그는" 장치인데, PG에는 그 장치가 없다.

> **MySQL 대조**: InnoDB의 행 락은 인덱스 레코드 락이고, 레코드 사이의 빈
> 구간(갭)에도 걸린다. `uk(user_id, coupon_id)`에 user_id 5, 10, 20, 30이
> 있으면 인덱스 위에는 레코드 4개와 갭 5개 —
> `(-∞,5) [5] (5,10) [10] (10,20) [20] (20,30) [30] (30,+∞)` — 가 있고,
> REPEATABLE READ에서 `WHERE user_id = 15 FOR UPDATE`는 행이 없어도
> `(10, 20)` 갭을 잠근다. 갭 락끼리는 호환이고 INSERT가 잡는 인서트 인텐션
> 락만 갭 락에 막힌다 — "둘 다 잠그기 성공 → 둘 다 넣기 실패"가 MySQL의
> "INSERT만 하는데 데드락"이었다. PG에서는 이 문장이 아무것도 잠그지
> 않으므로 이 데드락은 **구조적으로 성립하지 않는다.** 대신 §2-3의 다른
> 사고가 난다.

### 1-2. 행 락 4종 — 암기 목록

| 모드 | 누가 잡나 | 뜻 |
|---|---|---|
| **FOR UPDATE** | `SELECT ... FOR UPDATE`, `DELETE`, 유니크 인덱스에 속한 컬럼을 바꾸는 `UPDATE` | "이 행을 지우거나 키를 바꿀 수 있다" — 가장 강함 |
| **FOR NO KEY UPDATE** | 키가 아닌 컬럼만 바꾸는 `UPDATE`(자동), 명시적 `SELECT ... FOR NO KEY UPDATE` | "값은 바꾸지만 키는 그대로" |
| **FOR SHARE** | `SELECT ... FOR SHARE` | 읽기 공유 — 모든 갱신을 막는다 |
| **FOR KEY SHARE** | **FK 검사**: 자식 행 INSERT/UPDATE 시 부모 행에 자동, 명시적 `SELECT ... FOR KEY SHARE` | "이 행의 키만 사라지지 않으면 된다" |

평범한 `UPDATE users SET balance = ... WHERE id = 1`은 키를 안 바꾸므로
**FOR NO KEY UPDATE**를 잡고, JPA `@Lock(PESSIMISTIC_WRITE)`가 만드는
`SELECT ... FOR UPDATE`는 가장 강한 모드다 — 이 차이가 §3-3의 데드락을 만든다.

### 1-3. 충돌표 — 이 표의 두 칸이 데드락 유형 ③을 설명한다

| 이미 잡힌 락 ↓ / 새 요청 → | KEY SHARE | SHARE | NO KEY UPDATE | UPDATE |
|---|---|---|---|---|
| KEY SHARE | 호환 | 호환 | 호환 | **대기** |
| SHARE | 호환 | 호환 | **대기** | **대기** |
| NO KEY UPDATE | 호환 | **대기** | **대기** | **대기** |
| UPDATE | **대기** | **대기** | **대기** | **대기** |

핵심은 첫 열이다: **`FOR UPDATE`는 `KEY SHARE`와 충돌하고, `FOR NO KEY
UPDATE`는 충돌하지 않는다.** FK 검사가 부모 행에 KEY SHARE를 요구하므로,
부모 행을 `FOR UPDATE`로 잠근 트랜잭션이 살아 있는 동안 **다른 트랜잭션의
자식 INSERT는 전부 대기**하고, `FOR NO KEY UPDATE`면 지나간다. 키를 안
바꾸는 갱신에 습관적으로 `FOR UPDATE`를 쓰는 것이 PG에서 락 범위를
불필요하게 넓히는 1순위 실수다.

### 1-4. 유니크 인덱스 삽입 — 락이 아니라 "상대 트랜잭션 종료 대기"

INSERT가 유니크 인덱스에 키를 넣을 때 **아직 커밋되지 않은 같은 키**가
있으면, PG는 그 키에 공유 락을 잡는 대신 **그 튜플을 넣은 트랜잭션(XID)이
끝날 때까지 기다린 뒤 다시 검사**한다. 상대가 커밋하면 `ERROR 23505
duplicate key value violates unique constraint`, 롤백하면 자기가 넣는다.
`ON CONFLICT`도 같은 대기 위에서 동작한다(커밋이면 `DO NOTHING`/`DO UPDATE`
경로, 롤백이면 삽입). "락"이 아니라 "대기"라는 점이 §3-2의 데드락 모양과
MySQL 대조를 가른다.

### 1-5. 격리 수준은 "무엇이 보이는가"를 바꾸지, 락 범위를 바꾸지 않는다

일반 SELECT는 어떤 격리 수준에서도 행 락을 잡지 않고(MVCC 스냅샷), 잠금
읽기(`FOR UPDATE` 계열, UPDATE/DELETE의 대상 탐색)만 `xmax`를 건드린다.
기본 격리 수준은 **READ COMMITTED**이고, RR·SERIALIZABLE로 올려도 잠기는
것은 **WHERE를 통과해 반환된 행뿐**이다. 격리 수준이 바꾸는 것은 스냅샷과
충돌 시 실패 방식(`40001`)이지 락 범위가 아니다 — MySQL의 "RR이면 갭 락,
RC면 레코드 락" 스위치가 PG에는 없고, 그래서 격리 수준은 PG의 데드락
처방이 아니다(§5-2).

### 1-6. 락 대기의 비용을 사슬로 말하기

"락 경합"에서 멈추지 말 것. 데드락이 나지 않아도 락 대기는 이렇게 비용을
만든다:

**`FOR UPDATE`가 필요 이상으로 넓은 행(또는 강한 모드)을 잡음 → 무관한
UPDATE·FK 자식 INSERT가 `transactionid` 대기 → 대기하는 트랜잭션의 수명이
잠금 트랜잭션 수명만큼 늘어남 → 그 시간 동안 커넥션을 쥔 채 놓지 못함(PG는
커넥션 = OS 프로세스라 더 비싸다) → 풀 활성 커넥션 ↑ → 풀 고갈 → 무관한
API까지 `getConnection` 대기 → 전 서비스 응답 시간 상승. 덤으로 오래 열린
트랜잭션들이 `backend_xmin`으로 VACUUM을 붙들어 죽은 튜플 회수를 막는다
(bloat).**

각 화살표 하나가 면접의 "왜요?"에 대한 답이다. 이 사슬은 통째로 입에 붙여 둔다.

## 2. MySQL이 갭 락으로 풀던 두 문제를 PostgreSQL은 무엇으로 푸나

갭 락의 존재 이유는 둘이다 — (a) 팬텀 방지(범위를 잠갔으면 그 범위에 새
행이 끼어들지 않게), (b) 그 부산물로 "없는 행을 잠가 상호 배제"하는 용도.
PG는 (a)를 락 없이 풀고, (b)는 **애초에 락으로 풀지 말라**고 요구한다.

### 2-1. 팬텀 — REPEATABLE READ의 스냅샷은 팬텀을 "막는" 게 아니라 "안 보이게" 한다

PG의 REPEATABLE READ는 스냅샷 격리다. 트랜잭션의 첫 문장에서 스냅샷을
고정하고 이후 모든 문장이 같은 스냅샷을 읽는다. 다른 트랜잭션이 범위 안에
행을 INSERT하고 커밋해도 **내 스냅샷에는 존재하지 않으므로** 두 번째
SELECT에도 안 나온다 — 팬텀을 락으로 막을 필요가 없고, 그래서 다른 세션의
INSERT를 막지도 않는다(동시성 비용 0). 대가는 하나 — 스냅샷 이후 다른
트랜잭션이 커밋한 행을 내가 UPDATE/DELETE하려 하면 `ERROR 40001 could not
serialize access due to concurrent update`로 실패한다 → 재시도
([격리 수준 문서](transaction-isolation-levels.md)).

```sql
-- 세션 A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM coupon_issue WHERE coupon_id = 7;   -- 4
--   세션 B: INSERT INTO coupon_issue (user_id, coupon_id) VALUES (15, 7); COMMIT;  ← 막히지 않는다
SELECT count(*) FROM coupon_issue WHERE coupon_id = 7;   -- 여전히 4 (팬텀 없음, 락 없음)
COMMIT;
```

### 2-2. 스냅샷이 못 막는 것 — "읽고 판단해서 쓰기"는 SERIALIZABLE(SSI)의 몫

스냅샷은 **읽기**를 보호할 뿐, "읽은 결과를 근거로 쓴 것"이 여전히 옳은지는
보장하지 않는다. 선착순 100명 쿠폰: 두 트랜잭션이 각자 스냅샷에서 99를
세고 각자 INSERT하면 101이 된다. 둘 다 팬텀은 안 봤지만 결과는 틀렸다
(write skew).

MySQL이라면 `count(*) ... FOR UPDATE`로 범위에 넥스트 키 락을 걸어 두 번째
트랜잭션을 세우겠지만, PG의 `FOR UPDATE`는 지금 있는 99행만 잠그고 100번째
INSERT는 막지 않는다. PG의 정식 답은 **SERIALIZABLE**이다. SSI는 락으로
세우지 않는다 — 각 트랜잭션이 읽은 범위를 **predicate lock**(`pg_locks`의
`SIReadLock`, 튜플·페이지·릴레이션 단위)으로 기록해 두고, 읽기/쓰기
의존성이 직렬화 불가능한 모양을 만들면 한쪽을 `40001`로 abort한다.
SIReadLock은 아무도 블로킹하지 않으므로 SSI 자체는 데드락을 만들지 않는다.
대가는 **`40001` 재시도 루프가 필수**라는 것(§5-4)과, 읽기 범위가 넓으면
오탐 abort가 늘 수 있다는 것.

```sql
-- ✅ 선착순 한도 검사는 SERIALIZABLE — 둘 중 하나가 40001로 죽고, 재시도에서 101번째를 거른다
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM coupon_issue WHERE coupon_id = 7;   -- 99 → 한도 미만
INSERT INTO coupon_issue (user_id, coupon_id) VALUES (15, 7);
COMMIT;   -- 다른 세션이 같은 범위를 읽고 썼다면 여기서(또는 앞 문장에서) 40001
```

같은 요구를 락으로 풀려면 **존재하는 행**(`coupons` 행)을 `FOR NO KEY UPDATE`로
잠가 "세고 → 넣기"를 직렬화하는 앵커 방식이 있다(§2-3 처방 ③).

### 2-3. "조회해서 없으면 INSERT" — PG의 핵심 함정은 데드락이 아니라 중복이다

쿠폰 발급: "이 사용자가 이미 받았는지 잠그고 확인한 뒤, 없으면 INSERT".
MySQL 경험자가 그대로 옮겨 오는 코드다.

```java
// ❌ 없는 행을 FOR UPDATE로 "잠근다"고 믿는 코드 — PG에서는 아무것도 잠기지 않는다
@Transactional
public void issue(long userId, long couponId) {
    var existing = repo.findForUpdate(userId, couponId);   // SELECT ... FOR UPDATE → 0행 → 락 없음
    if (existing.isPresent()) throw new AlreadyIssued();
    repo.save(new CouponIssue(userId, couponId));           // INSERT
}
```

사용자 15번이 발급 버튼을 두 번 눌러 요청 둘이 거의 동시에 들어온다.
`coupon_issue`에 아직 `UNIQUE (user_id, coupon_id)`가 없다고 하자.

| 시각 | 세션 A (user 15) | 세션 B (user 15, 더블 클릭) | 상태 |
|---|---|---|---|
| t1 | `SELECT ... WHERE user_id = 15 AND coupon_id = 7 FOR UPDATE` → 0행 | | 잠긴 것 없음 |
| t2 | | 같은 SELECT → 0행 | 잠긴 것 없음 — **A를 기다리지 않는다** |
| t3 | `INSERT (15, 7)` 성공 | | A의 새 튜플(미커밋) |
| t4 | | `INSERT (15, 7)` 성공 | B의 새 튜플(미커밋) — 서로 안 보임 |
| t5 | `COMMIT` | `COMMIT` | **중복 2건.** 에러도 데드락도 없다 |

유니크 제약이 있으면 t4에서 B가 A의 미커밋 튜플을 만나 **A의 종료를
기다리고**(§1-4), t5에 A가 커밋하는 순간 B는 `23505`로 실패한다. 즉
제약이 있으면 "중복"이 "유니크 위반 예외"로 바뀔 뿐, `FOR UPDATE`는 여전히
아무 역할이 없다. **PG에서 이 코드의 `FOR UPDATE`는 읽기 비용만 내는
장식이다.**

> **MySQL 대조 — 같은 코드, 다른 사고**: InnoDB RR에서는 t1에서 A가
> `(10, 20)` 갭 락을 잡고, t2에서 B도 같은 갭 락을 잡는 데 성공(갭 락끼리
> 호환)한 뒤, t3의 INSERT가 B의 갭 락에, t4의 INSERT가 A의 갭 락에 막혀
> 순환 — `ERROR 1213 Deadlock found`로 한쪽이 롤백된다. 결과는 "정합성은
> 지켜지고 데드락 예외가 난다". PG는 "예외 없이 중복이 들어간다"(제약이
> 없을 때). **PG 쪽이 더 조용하고 더 위험하다.** 유니크 제약 없는 테이블에서
> 이 패턴을 쓰고 있다면 지금 데이터를 세어 볼 일이다.

처방은 다섯이고 각각 대가가 있다(§6에서 양면 정리).

**처방 ① — 유니크 제약 + 단일 `INSERT ... ON CONFLICT`.** 사전 조회를
없애고 DB가 원자적으로 "있으면 무시/갱신, 없으면 삽입"한다. 충돌 대상
(arbiter)은 유니크 인덱스/제약이어야 한다. 동시에 들어온 두 INSERT 중
뒤쪽은 앞쪽의 커밋을 기다렸다가 `DO NOTHING` 경로로 빠지므로 예외조차
없다. `RETURNING`이 비어 있으면 "이미 발급됨".

```java
// ✅ 스프링 — 네이티브 SQL로 RETURNING을 읽는다 (JPA save()로는 ON CONFLICT를 못 만든다)
@Transactional
public IssueResult issue(long userId, long couponId) {
    var ids = jdbc.queryForList(
        "INSERT INTO coupon_issue (user_id, coupon_id) VALUES (?, ?) " +
        "ON CONFLICT (user_id, coupon_id) DO NOTHING RETURNING id", Long.class, userId, couponId);
    return ids.isEmpty() ? IssueResult.ALREADY_ISSUED : IssueResult.ISSUED;
}
```

**처방 ② — 유니크 제약 + 그냥 INSERT, `23505`를 "이미 발급됨"으로 번역.**
JPA `save()` 경로에서 `DataIntegrityViolationException`을 받는 방식. 예외가
나면 트랜잭션이 rollback-only가 되므로 경계를 나누는 처리가 필요하다
([복합 유니크 제약 문서 §3](../03-jpa-orm/14-unique-constraint-concurrent-insert.md)).

**처방 ③ — 존재하는 앵커 행을 `FOR NO KEY UPDATE`로 잠근다.** 사용자별
발급을 직렬화하고 싶고 발급 전에 복잡한 판단(한도, 자격)이 있으면, 없는
`coupon_issue` 행이 아니라 **항상 존재하는 `users` 행**(또는 `coupons` 행)을
잠근다. 두 번째 트랜잭션은 t2에서 **대기**하고 첫 번째가 끝나면 이어서
진행한다(직렬화, 데드락 아님). 모드는 **`FOR NO KEY UPDATE`** — `FOR UPDATE`면
그 사용자를 참조하는 모든 자식 INSERT(주문, 로그…)가 FK KEY SHARE 충돌로
같이 멈춘다(§1-3, §3-3).

```java
// ✅ 앵커 행 락 — 존재하는 부모 행에, 키를 안 바꾸는 모드로
@Transactional
public void issue(long userId, long couponId) {
    jdbc.queryForObject("SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE", Long.class, userId);
    if (repo.existsByUserIdAndCouponId(userId, couponId)) throw new AlreadyIssued();
    // ... 한도·자격 판단 (이 구간은 사용자 단위로 직렬화돼 있다) ...
    repo.save(new CouponIssue(userId, couponId));
}
```

**처방 ④ — advisory lock: 행이 없어도 잠글 수 있는 "이름 있는 락".**
잠글 행이 없거나 앵커가 마땅치 않을 때 PG가 주는 도구. 임의의 정수 키에
락을 잡고, `_xact_` 변형은 트랜잭션 끝에 자동 해제된다.

```sql
-- ✅ 트랜잭션 범위 advisory lock — (user_id, coupon_id) 조합을 키로
SELECT pg_advisory_xact_lock(hashtext('coupon_issue:' || $1 || ':' || $2));
SELECT 1 FROM coupon_issue WHERE user_id = $1 AND coupon_id = $2;   -- 이제 이 조회는 직렬화된다
INSERT INTO coupon_issue (user_id, coupon_id) VALUES ($1, $2);
COMMIT;   -- 락 해제
```

주의 셋: 해시 충돌은 무관한 요청끼리 불필요하게 직렬화될 뿐 정합성은 안
깨진다 / 세션 범위(`pg_advisory_lock`)는 PgBouncer transaction pooling에서
커넥션이 바뀌면 엉키므로 `_xact_` 변형만 쓴다 / advisory lock끼리도 순서가
다르면 §3-1과 같은 일반 데드락이 난다.

**처방 ⑤ — SERIALIZABLE.** §2-2. 조회-판단-삽입 전체를 SSI에 맡기고
`40001` 재시도.

`UPDATE ... WHERE key = ?` 후 affected rows가 0이면 INSERT하는 "UPSERT
흉내"도 같은 이유로 깨진다 — 0행 UPDATE는 아무것도 잠그지 않는다. 답은 처방
①의 `ON CONFLICT DO UPDATE`다([대량 UPSERT 문서](32-bulk-upsert-side-effects.md)).

## 3. PostgreSQL에서 데드락은 어디서 나는가 — 4유형, 두 세션 타임라인

갭이 없으니 남는 것은 **존재하는 행에 대한 락**과 **유니크 키 삽입
대기**뿐이다. 그 둘의 조합으로 나는 데드락이 넷이다. 예시 스키마:

```sql
CREATE TABLE users (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  balance numeric(12,2) NOT NULL
);
CREATE TABLE transfers (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_user  bigint NOT NULL REFERENCES users(id),
  to_user    bigint NOT NULL REFERENCES users(id),
  amount     numeric(12,2) NOT NULL
);
CREATE TABLE coupon_issue (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   bigint NOT NULL REFERENCES users(id),
  coupon_id bigint NOT NULL,
  UNIQUE (user_id, coupon_id)
);
```

### 3-0. PG의 데드락 감지 — 즉시가 아니라 `deadlock_timeout` 뒤에

PG는 락 대기에 들어갈 때 즉시 사이클을 찾지 않는다. **`deadlock_timeout`
(기본 1초)만큼 기다려도 못 얻었으면** 그 프로세스가 대기 그래프를 검사하고,
자기가 사이클 안에 있으면 **자기 트랜잭션을** `ERROR: deadlock detected`
(SQLSTATE `40P01`)로 abort한다. 희생자는 "수정 행이 적은 쪽"이 아니라
**대기를 먼저 시작해 타임아웃이 먼저 만료된 쪽**이고, 그래서 PG의 데드락은
항상 **최소 1초의 멈춤** 뒤에 드러난다. 살아남은 쪽은 락을 얻어 계속 진행한다.

### 3-1. 유형 ① — 같은 행들을 다른 순서로 잠근다 (가장 흔함)

송금: A는 1번 → 2번, B는 2번 → 1번. 각자 "출금 계좌 먼저, 입금 계좌
나중" 순서로 UPDATE한다.

| 시각 | 세션 A (1 → 2 송금) | 세션 B (2 → 1 송금) | 락 상태 |
|---|---|---|---|
| t1 | `UPDATE users SET balance = balance - 100 WHERE id = 1` | | users#1의 `xmax` = A (NO KEY UPDATE) |
| t2 | | `UPDATE users SET balance = balance - 50 WHERE id = 2` | users#2의 `xmax` = B |
| t3 | `UPDATE users SET balance = balance + 100 WHERE id = 2` → **대기** | | A → B의 XID 대기 (`wait_event = transactionid`) |
| t4 | | `UPDATE users SET balance = balance + 50 WHERE id = 1` → **대기** | B → A 대기 = 순환 |
| t5 (= t3 + 1s) | `deadlock_timeout` 만료 → 검사 → 사이클 → **A abort** `40P01` | 락 획득 → 진행 → `COMMIT` | |

3장에서 다룬 "재고 → 포인트 / 포인트 → 재고" 순서 역전과 같은 그림이다
([자바 데드락 문서 §4](../01-java-kotlin/24-deadlock-analysis-prevention.md),
[flush 순서 문서](../03-jpa-orm/15-flush-timing-and-sql-ordering.md)).
처방은 **잠금 순서 고정** — 갱신 전에 관련 행을 키 오름차순으로 먼저 잠근다.

```java
// ❌ 잠금 순서가 호출 인자 순서를 따른다 — (1,2)와 (2,1)이 교차한다
@Transactional
public void transfer(long from, long to, BigDecimal amount) {
    accountRepo.debit(from, amount);    // UPDATE ... WHERE id = from
    accountRepo.credit(to, amount);     // UPDATE ... WHERE id = to
}

// ✅ 관련 행을 키 순서로 먼저 잠근다 — 누가 먼저 오든 1번 → 2번 순서
@Transactional
public void transfer(long from, long to, BigDecimal amount) {
    jdbc.queryForList("SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR NO KEY UPDATE",
                      Long.class, from, to);                  // 정렬된 순서로 LockRows
    accountRepo.debit(from, amount);
    accountRepo.credit(to, amount);
}
```

`ORDER BY id FOR NO KEY UPDATE`는 계획상 `Sort` 위에 `LockRows`가 놓여
**정렬된 순서대로** 잠근다. JPA라면 `@Lock` JPQL에 `ORDER BY u.id`를 넣고 id
목록을 정렬해 넘긴다(단 `PESSIMISTIC_WRITE`는 `FOR UPDATE`를 만든다 — §3-3).
한 문장 `UPDATE ... WHERE id IN (1, 2)`도 안전하지 않다 — 잠금 순서는 스캔
순서를 따르고, 두 세션의 계획이 다르면 교차할 수 있다.

### 3-2. 유형 ② — 유니크 키 삽입 대기가 교차한다 ("INSERT만 하는데 데드락"의 PG 판)

트랜잭션에 INSERT밖에 없는데 데드락이 나는 경우는 PG에도 있다. 열쇠는
§1-4 — **미커밋 상태의 같은 유니크 키를 만나면 상대 트랜잭션 종료를
기다린다**는 것. 두 트랜잭션이 **같은 키 두 개를 서로 반대 순서로** 넣으면
순환이 된다. 재적재 배치 둘이 같은 파일을 다른 순서로 처리하거나, 멱등키
테이블에 재시도 요청이 겹칠 때 나온다.

| 시각 | 세션 A | 세션 B | 상태 |
|---|---|---|---|
| t1 | `INSERT INTO coupon_issue VALUES (15, 7)` 성공(미커밋) | | 유니크 인덱스에 (15,7) 미커밋 엔트리 |
| t2 | | `INSERT INTO coupon_issue VALUES (17, 7)` 성공(미커밋) | (17,7) 미커밋 엔트리 |
| t3 | | `INSERT ... VALUES (15, 7)` → 미커밋 중복 발견 → **A의 XID 대기** | B → A |
| t4 | `INSERT ... VALUES (17, 7)` → 미커밋 중복 발견 → **B의 XID 대기** | | A → B = 순환 |
| t5 (= t3 + 1s) | | 타임아웃 먼저 만료 → **B abort** `40P01` | B의 (17,7)이 사라짐 → A 진행 → (17,7) 삽입 → `COMMIT` |

주목할 점 — **각 세션의 두 번째 INSERT가 상대의 첫 INSERT와 같은 키**다.
즉 "같은 자원 둘을 다른 순서로"라는 유형 ①의 변형이고, 처방도 같다: 배치
안의 행을 **키 순서로 정렬**해 넣는다(§3-4). 한 문장 안에서 같은 키를 두 번
넣는 것과는 다른 문제다(그쪽은 `ON CONFLICT DO UPDATE command cannot affect
row a second time` 에러).

> **MySQL 대조 — PG에는 "없는" 데드락 하나**: InnoDB는 유니크 중복
> 검사에서 미커밋 행에 **공유(S) 락**을 잡고 기다린다. 그래서 A가 (15,7)을
> 넣고 B·C가 같은 키로 대기하다 A가 **롤백**하면 B와 C가 동시에 S 락을
> 얻고(S끼리 호환), 이어서 각자 삽입용 X 락을 요구하며 서로의 S 락에 막혀
> 데드락이 난다 — "재시도 폭풍"과 "지우고 다시 넣기 배치"에서 나던, RC로
> 낮춰도 남는 사고였다. PG는 중복 검사에서 락을 잡지 않고 XID를 기다릴
> 뿐이므로, A가 롤백하면 B와 C 중 먼저 깨어난 쪽이 넣고 나머지는 다시 그
> XID를 기다렸다가 `23505`를 받는다. **데드락이 아니라 직렬화**로 끝난다.

### 3-3. 유형 ③ — 부모 행 `FOR UPDATE` ↔ 자식 INSERT의 FK `KEY SHARE` (PG 고유)

유형 ①의 송금에 `transfers` 이력 INSERT가 붙고, 잔액 행을 JPA
`@Lock(PESSIMISTIC_WRITE)`(= `SELECT ... FOR UPDATE`)로 잠그는 흔한
구현이다. 이번에는 **두 세션이 users 행을 각자 하나씩만 잠그는데도**
데드락이 난다.

| 시각 | 세션 A (1 → 2 송금) | 세션 B (2 → 1 송금) | 락 상태 |
|---|---|---|---|
| t1 | `SELECT ... FROM users WHERE id = 1 FOR UPDATE` | | users#1: A의 FOR UPDATE |
| t2 | | `SELECT ... FROM users WHERE id = 2 FOR UPDATE` | users#2: B의 FOR UPDATE |
| t3 | `INSERT INTO transfers (from_user, to_user, amount) VALUES (1, 2, 100)` → FK 검사가 users#2에 `KEY SHARE` 요청 → **대기** | | KEY SHARE vs FOR UPDATE = 충돌 → A → B |
| t4 | | `INSERT INTO transfers VALUES (2, 1, 50)` → users#1에 `KEY SHARE` 요청 → **대기** | B → A = 순환 |
| t5 (= t3 + 1s) | **A abort** `40P01` | 진행 → `COMMIT` | |

이 데드락은 **락 순서를 통일해도 안 없어진다** — 각 세션은 행을 하나만
잠갔고 순서라는 게 없다. 원인은 순서가 아니라 **모드**다. 같은 코드에서
`FOR UPDATE`를 `FOR NO KEY UPDATE`로 바꾸면(또는 잠금 읽기 없이 `UPDATE
users SET balance = ...`로 바로 갱신하면 — 비키 UPDATE는 자동으로 NO KEY
UPDATE) t3·t4의 KEY SHARE가 충돌하지 않아 **대기 자체가 없다.**

```java
// ❌ 잔액만 바꾸면서 FOR UPDATE — 이 사용자를 참조하는 모든 자식 INSERT를 막는다
@Lock(LockModeType.PESSIMISTIC_WRITE)                       // PG에서는 SELECT ... FOR UPDATE
@Query("select u from User u where u.id = :id")
Optional<User> findForUpdate(@Param("id") Long id);

// ✅ 키를 안 바꾸는 갱신은 NO KEY UPDATE — FK KEY SHARE와 충돌하지 않는다
@Query(value = "SELECT * FROM users WHERE id = :id FOR NO KEY UPDATE", nativeQuery = true)
Optional<User> findForBalanceUpdate(@Param("id") Long id);

// ✅ 또는 잠금 읽기 자체를 없앤 원자적 UPDATE — 잔액 조건까지 한 문장 (락은 자동으로 NO KEY UPDATE)
@Modifying
@Query(value = "UPDATE users SET balance = balance - :amt WHERE id = :id AND balance >= :amt",
       nativeQuery = true)
int debit(@Param("id") Long id, @Param("amt") BigDecimal amt);   // 0이면 잔액 부족
```

원칙으로 굳히면 — **`FOR UPDATE`는 "이 행을 지우거나 키를 바꿀 것"일 때만.
값을 바꿀 뿐이면 `FOR NO KEY UPDATE`.** JPA의 `PESSIMISTIC_WRITE`가 항상
`FOR UPDATE`를 만든다는 사실이 PG에서 이 실수를 양산한다(가산점 포인트).
§2-3 처방 ③의 앵커 행 락이 `FOR NO KEY UPDATE`여야 하는 이유도 이것이다.

### 3-4. 유형 ④ — 대량 UPSERT 배치의 행 순서 불일치

`INSERT ... ON CONFLICT DO UPDATE`에 여러 행을 실어 보내는 배치는 **한 문장
안에서 행마다 순서대로** 삽입하거나(충돌 시) 기존 행을 잠가 갱신한다. 두
배치의 행 순서가 다르면 유형 ①·②가 **한 문장 안에서** 벌어진다.

| 시각 | 배치 A `VALUES (k1), (k2), (k3)` | 배치 B `VALUES (k3), (k2), (k1)` | 상태 |
|---|---|---|---|
| t1 | k1 행 잠금·갱신 | k3 행 잠금·갱신 | |
| t2 | k2 행 잠금·갱신 | k2 → **A 대기** | B → A |
| t3 | k3 → **B 대기** | | A → B = 순환 |
| t4 (= t2 + 1s) | | **B abort** `40P01` — **문장 전체(배치 전체)가 롤백** | A 진행 → `COMMIT` |

처방: 배치를 보내기 전에 **키 순서로 정렬**한다 — 앱에서 정렬하거나
`INSERT INTO t SELECT ... FROM staging ORDER BY key ON CONFLICT ...`. 청크를
작게 자르면 한 번에 쥐는 행 수와 재시도 비용이 줄고, 같은 키 공간을 두
배치가 동시에 만지지 않도록 **키 범위로 분할**하는 것이 근본 처방이다.
UPSERT의 다른 부작용은 [대량 UPSERT 문서](32-bulk-upsert-side-effects.md).

### 3-5. 네 유형을 한 장으로 (암기)

| 유형 | 자원 | 순환의 재료 | 1순위 처방 |
|---|---|---|---|
| ① 행 순서 역전 | 존재하는 행의 `xmax` | 같은 행 둘, 반대 순서 | 키 순서 고정 (`ORDER BY id FOR NO KEY UPDATE`) |
| ② 유니크 삽입 대기 교차 | 유니크 인덱스의 미커밋 엔트리 | 같은 키 둘, 반대 순서 | 배치 키 정렬, `ON CONFLICT` |
| ③ FK KEY SHARE 충돌 | 부모 행 `FOR UPDATE` vs 자식 INSERT | **순서가 아니라 모드** | `FOR NO KEY UPDATE` / 원자적 UPDATE |
| ④ UPSERT 배치 | ①+②가 한 문장 안에서 | 배치 간 행 순서 불일치 | `ORDER BY key`, 청크, 키 범위 분할 |

## 4. 진단 — 서버 로그, `pg_locks`, `pg_blocking_pids()`

애플리케이션 예외만으로는 "누구와" 데드락이 났는지 모른다 — 상대는
성공했고 로그도 남기지 않았다. 1차 자료는 **PostgreSQL 서버 로그**다.
클라이언트가 받는 에러에는 보안상 상대 프로세스의 쿼리가 빠지고(`HINT: See
server log for query details.`) 서버 로그에만 실린다.

### 4-1. 서버 로그의 데드락 기록(§3-1 유형 ①)과 읽는 순서

```text
2026-08-30 10:12:33.412 KST [4213] app@shop ERROR:  deadlock detected
2026-08-30 10:12:33.412 KST [4213] app@shop DETAIL:  Process 4213 waits for ShareLock on transaction 8812; blocked by process 4214.
        Process 4214 waits for ShareLock on transaction 8811; blocked by process 4213.
        Process 4213: UPDATE users SET balance = balance + 100 WHERE id = 2   ← ③ 4213이 대기 중이던 문장
        Process 4214: UPDATE users SET balance = balance + 50 WHERE id = 1    ← ③ 4214가 대기 중이던 문장
2026-08-30 10:12:33.412 KST [4213] app@shop HINT:  See server log for query details.
2026-08-30 10:12:33.412 KST [4213] app@shop CONTEXT:  while updating tuple (0,2) in relation "users"   ← ④ 어느 튜플에서 막혔나
2026-08-30 10:12:33.412 KST [4213] app@shop STATEMENT:  UPDATE users SET balance = balance + 100 WHERE id = 2
```

절차:

1. **행 찾기** — `deadlock detected`로 검색한다. `log_line_prefix`에
   `%p`(pid) · `%u@%d` · `%a`(application_name) · `%x`(XID)를 넣어 두고,
   **`application_name`을 서비스·배치 이름으로**(pgjdbc URL `ApplicationName=`)
   설정해 두었어야 어느 서비스의 어느 트랜잭션인지 바로 읽힌다.
2. **희생자 특정** — `ERROR`를 찍은 pid(위에서는 4213)가 `40P01`을 받은
   쪽이다. 애플리케이션 에러 로그의 시각·스레드와 맞춘다.
3. **대기 문장 해독** — `Process N: <문장>`은 각 프로세스가 **대기 중이던
   마지막 문장**이다. 여기서 초보가 가장 헷갈린다: **그 트랜잭션이 앞에서
   실행한 문장은 나오지 않는다.** 4213의 줄에는 `id = 2` UPDATE만 보이지만,
   4213이 `id = 1`을 먼저 잠갔다는 사실은 반대편 줄("4214 waits for
   transaction 8811; blocked by 4213")에서 **역산**한다 — "8811(4213의
   XID)이 4214가 원하는 행을 쥐고 있다 → 4213은 앞 문장에서 그 행을 건드렸다."
4. **"ShareLock on transaction" 해독** — PG의 행 락 대기는 "행"이 아니라
   **"상대 트랜잭션 ID에 대한 ShareLock 대기"**로 찍힌다. 튜플의 `xmax`에
   적힌 XID가 끝나기를 기다리는 것이기 때문이다(§1-1). 어느 행인지는
   `CONTEXT: while updating tuple (0,2) in relation "users"`(블록 0, 오프셋 2 =
   `ctid`)로 안다 — `SELECT * FROM users WHERE ctid = '(0,2)'`.
5. **패턴 분류** — 양쪽 CONTEXT가 같은 테이블의 다른 튜플이면 유형 ①,
   `while inserting index tuple`이면 유형 ②, 자식 INSERT 쪽 CONTEXT에
   `FOR KEY SHARE OF x`가 보이면 유형 ③, 양쪽 문장이 같은 `INSERT ... ON
   CONFLICT`면 유형 ④. 앞 문장까지 복원해야 하면 그 시간대에만
   `log_min_duration_statement = 0`을 켜서 `%x` 기준으로 이어 붙인다.

### 4-2. 로그 문자열 해독표

| 로그 문자열 | 뜻 |
|---|---|
| `waits for ShareLock on transaction N` | 행 락 대기 — `xmax`에 N이 적힌 튜플을 기다린다 (유형 ①②③④ 공통) |
| `waits for ExclusiveLock on tuple (b,o) of relation R` | 같은 행을 기다리는 대기 줄의 **두 번째 이후** 대기자 (첫 대기자만 튜플 락을 쥔다) |
| `CONTEXT: while updating tuple` / `while locking tuple` / `while deleting tuple` | UPDATE / `FOR ...` 계열 / DELETE 가 막혔다 |
| `CONTEXT: while inserting index tuple (b,o) in relation "uk_..."` | 유니크 인덱스 삽입 대기 (유형 ②) |
| `CONTEXT: while locking tuple ... in relation "users"` + `SQL statement "SELECT 1 FROM ONLY "public"."users" x WHERE ... FOR KEY SHARE OF x"` | FK 검사의 KEY SHARE 대기 (유형 ③) |
| `still waiting for ShareLock on transaction N after 1000.052 ms` | 데드락은 아니지만 `deadlock_timeout`을 넘긴 긴 대기 (`log_lock_waits`) |

로그에서 `FOR KEY SHARE`가 보이면 반사적으로 "누가 부모를 `FOR UPDATE`로
잡고 있나"를 찾는다.

### 4-3. 살아 있는 락 대기 보기 — 데드락 전에 잡는다

```sql
-- 지금 락에 막힌 세션과, 그것을 막고 있는 세션
SELECT a.pid, a.application_name, a.state,
       a.wait_event_type, a.wait_event,          -- 'Lock' / 'transactionid' 또는 'tuple'
       now() - a.xact_start AS xact_age,
       pg_blocking_pids(a.pid) AS blocked_by,   -- 이 pid를 막고 있는 pid 목록
       a.query
FROM pg_stat_activity a
WHERE a.wait_event_type = 'Lock';
-- blocked_by의 pid를 다시 pg_stat_activity에서 찾아 state가 'idle in transaction'이면
-- 앱이 트랜잭션을 열어 둔 채 딴 일을 하는 중이다
```

`pg_locks`에는 행 락 자체가 없다(튜플에 있으므로). 대기 중인 행 락만
`locktype = 'transactionid'`, `granted = false`로 보이고, 같은 행의 첫
대기자만 `locktype = 'tuple'` 항목을 하나 더 쥔다. 재현 테스트(§5-3)를 t3에서
멈춰 놓고 위 쿼리를 치면 "A가 B의 XID를 기다린다"를 눈으로 확인할 수 있다.

두 가지를 켜 둔다:

- **`log_lock_waits = on`** — 어떤 대기가 `deadlock_timeout`을 넘기면
  데드락이 아니어도 `LOG: process 4213 still waiting for ShareLock on
  transaction 8812 after 1000.052 ms` + `DETAIL: Process holding the lock:
  4214. Wait queue: 4213.`를 남긴다. **데드락으로 발전하기 전의 긴 락
  대기**를 잡는 상시 감시 장치이고 비용이 거의 없다.
- **`pg_stat_database.deadlocks`** — DB별 누적 데드락 수. 메트릭으로
  내보내 증가 추세에 알람을 건다 — "재시도로 조용히 덮이고 있는 데드락"은
  이 카운터만 안다.

### 4-4. 스프링에서 무엇으로 올라오나

| SQLSTATE | PG 메시지 | 스프링 예외 |
|---|---|---|
| `40P01` | deadlock detected | `DeadlockLoserDataAccessException` (JdbcTemplate) / Hibernate 경유 시 `CannotAcquireLockException` |
| `55P03` | canceling statement due to lock timeout (`lock_timeout`) / `NOWAIT` 실패 | `CannotAcquireLockException` |
| `40001` | could not serialize access (RR 갱신 충돌·SSI) | `CannotSerializeTransactionException` |
| `23505` | duplicate key value violates unique constraint | `DuplicateKeyException` (`DataIntegrityViolationException`의 자식) |

앞의 셋은 공통 부모 **`PessimisticLockingFailureException`** 아래에 있다 —
재시도 대상은 이 부모로 잡는다(§5-4). `23505`는 재시도가 아니라 **"이미
있음"으로 번역할 대상**이다(§2-3 처방 ②).

## 5. 예방과 안전망 — 코드로 고정한다

### 5-1. 설계 규칙 여섯

1. **없는 행을 잠그지 마라 — 제약에 맡겨라.** check-then-insert는
   `UNIQUE` + `INSERT ... ON CONFLICT`. 잠글 것이 정말 필요하면 존재하는
   앵커 행 또는 advisory lock(§2-3).
2. **여러 행을 잠글 땐 키 순서로 먼저 잠근다.** `SELECT id FROM t WHERE id
   IN (...) ORDER BY id FOR NO KEY UPDATE` 후 갱신. 배치도 `ORDER BY key`.
3. **`FOR UPDATE`는 삭제·키 변경 의도일 때만. 값 갱신은 `FOR NO KEY UPDATE`
   또는 잠금 읽기 없는 원자적 UPDATE.** JPA `PESSIMISTIC_WRITE`가 만드는
   `FOR UPDATE`를 의심한다(§3-3).
4. **잠금 읽기의 WHERE는 인덱스를 타게 한다.** PG는 못 타도 조건 미충족
   행을 잠그진 않지만, Seq Scan만큼 **락 보유 시간**이 늘고 스캔 중 갱신
   중인 후보 행마다 대기가 붙는다([FOR UPDATE 범위 문서](19-select-for-update-lock-scope.md)).
5. **트랜잭션을 짧게.** 행 락은 트랜잭션 끝까지 유지된다. 외부 API
   호출·파일 처리는 트랜잭션 밖으로
   ([롱 트랜잭션 문서](16-long-transaction-harm-and-shortening.md)).
6. **무한 대기를 금지한다.** `lock_timeout`(`ALTER ROLE app SET lock_timeout
   = '3s'` 또는 트랜잭션 첫 문장 `SET LOCAL lock_timeout`) — 데드락은 1초면
   풀리지만 **데드락이 아닌 긴 락 대기**는 안 풀린다. 스프링
   `@Transactional(timeout = n)`은 JDBC 쿼리 타임아웃이라 `lock_timeout`을
   대신하지 못한다. 작업 큐는 `FOR UPDATE SKIP LOCKED`, 즉시 실패는 `NOWAIT`.

### 5-2. 격리 수준은 PG에서 데드락 처방이 아니다

MySQL에서는 "RC로 낮추면 갭 락이 꺼져 없는 행 FOR UPDATE + INSERT 데드락이
사라진다"가 유효한 카드였다. PG에서는 **격리 수준이 락 범위를 바꾸지
않는다**(§1-5). 기본이 이미 RC이고, RR로 올려도 잠기는 행은 같다. 위로
올리는 것(SERIALIZABLE)은 데드락을 없애는 게 아니라 **"블로킹 대신
abort"로 실패 방식을 바꾸는 것**이다 — SIReadLock은 블로킹하지 않지만 행
락은 그대로라 유형 ①~④는 SERIALIZABLE에서도 난다. 즉 PG에서 격리 수준은
팬텀·write skew를 막는 **정합성 도구**지 데드락 도구가 아니고, 데드락은
§5-1의 순서·모드·설계로만 사라진다.

```java
// 격리 수준을 올리는 이유가 "데드락"이면 잘못 짚은 것 — 이유는 "조회-판단-쓰기의 정합성"이어야 한다
@Transactional(isolation = Isolation.SERIALIZABLE)   // 40001 재시도(§5-4)가 세트. 새 트랜잭션을 여는 쪽에서만 유효
public void issueWithLimit(long userId, long couponId) { ... }
```

### 5-3. 재현 테스트 — 두 스레드 `CountDownLatch`로 타임라인을 강제한다

데드락은 "동시에 돌리면 가끔" 나는 게 아니라 **§3-1의 t1 → t2 → t3 → t4
순서가 만들어지면 반드시** 난다. 그러니 테스트는 스레드를 동시에
출발시키는 게 아니라 **그 순서를 래치로 강제**해야 한다. 반드시 **실제
PostgreSQL(Testcontainers)** 이어야 한다 — H2는 락 모델이 달라 이
타임라인이 재현되지 않는다. 테스트 메서드에 `@Transactional`을 붙이지
않는다 — 테스트 스레드의 트랜잭션은 워커 스레드에 전파되지 않고, 시드
데이터가 롤백에 묶여 다른 커넥션에서 안 보인다. 두 스레드가 각자
`TransactionTemplate`으로 트랜잭션을 열고, 뒷정리는 `@BeforeEach`에서 직접
한다.

```java
@SpringBootTest
@Testcontainers
class RowOrderDeadlockTest {

    @Autowired TransactionTemplate tx;     // 각 스레드가 자기 트랜잭션을 연다
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void seed() {
        jdbc.update("TRUNCATE transfers, users RESTART IDENTITY CASCADE");
        jdbc.update("INSERT INTO users (balance) VALUES (1000), (1000)");   // id 1, 2
    }

    @Test
    void 같은_행_둘을_반대_순서로_갱신하면_데드락이_재현된다() throws Exception {
        var aLockedOne = new CountDownLatch(1);
        var bLockedTwo = new CountDownLatch(1);
        var pool = Executors.newFixedThreadPool(2);

        Future<?> a = pool.submit(() -> tx.executeWithoutResult(s -> {
            jdbc.update("UPDATE users SET balance = balance - 100 WHERE id = 1");   // t1
            aLockedOne.countDown();
            await(bLockedTwo);                                                       // B가 2번을 잠글 때까지
            jdbc.update("UPDATE users SET balance = balance + 100 WHERE id = 2");   // t3: 대기
        }));
        Future<?> b = pool.submit(() -> tx.executeWithoutResult(s -> {
            await(aLockedOne);
            jdbc.update("UPDATE users SET balance = balance - 50 WHERE id = 2");    // t2
            bLockedTwo.countDown();
            jdbc.update("UPDATE users SET balance = balance + 50 WHERE id = 1");    // t4: 순환 완성
        }));

        var failures = new ArrayList<Throwable>();
        for (var f : List.of(a, b)) {
            try { f.get(10, TimeUnit.SECONDS); } catch (ExecutionException e) { failures.add(e.getCause()); }
        }
        pool.shutdownNow();

        // deadlock_timeout(1s) 뒤 정확히 한 트랜잭션만 40P01 희생자, 나머지 하나는 커밋
        assertThat(failures).hasSize(1);
        assertThat(failures.get(0)).isInstanceOf(PessimisticLockingFailureException.class);
        // 살아남은 쪽만 반영: A가 이겼으면 900, B가 이겼으면 1050
        assertThat(jdbc.queryForObject("SELECT balance FROM users WHERE id = 1", BigDecimal.class))
            .isIn(new BigDecimal("900.00"), new BigDecimal("1050.00"));
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("latch timeout");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }
}
```

이 테스트는 `deadlock_timeout`(1초)만큼 반드시 걸린다 — 테스트 컨테이너는
superuser 세션이므로 컨테이너 설정에서 `deadlock_timeout`을 낮춰도 된다.

테스트의 쓰임은 둘이다. **먼저 빨간 불을 본다** — "우리 코드가 정말
데드락을 내는가"를 사실로 만든다. 그 다음 §3-1 처방(키 순서 잠금)을 적용한
뒤에는 **데드락 예외 0건, 두 송금 모두 반영**을 단언하는 회귀 테스트로
바꿔 남긴다(순서를 고정하면 B가 t2에서 대기하므로 래치 대신 "동시 출발"
패턴 — [복합 유니크 제약 문서 §8](../03-jpa-orm/14-unique-constraint-concurrent-insert.md)).
누군가 "잠금용 SELECT가 불필요해 보인다"며 지우면 이 테스트가 막는다.

**§2-3 함정용 테스트는 모양이 다르다.** 단언할 것이 데드락 예외가 아니라
**중복 행(또는 `23505`)**이다. 래치 순서는 A `FOR UPDATE`(0행) → B `FOR
UPDATE`(0행, **대기 없음** — 여기가 PG의 핵심) → A INSERT → B INSERT → 둘 다
커밋. 유니크 제약이 없으면 `count = 2`가 빨간 불이고, 처방 ①로 바꾼 뒤엔
`count = 1`과 예외 0건을 단언하는 회귀 테스트로 남긴다.

예외 타입은 단언하기 전에 **실제로 무엇이 올라오는지 먼저 확인**한다 —
`JdbcTemplate` 경로는 `DeadlockLoserDataAccessException`, JPA 경로는 Hibernate
예외 변환을 거쳐 `CannotAcquireLockException`일 수 있다. 공통 부모
`PessimisticLockingFailureException`으로 잡는 것이 안전하다.

### 5-4. 재시도 정책 — 트랜잭션 밖에서, 상한과 지터를 두고

데드락 희생자는 PG가 **트랜잭션 전체를 abort**했으므로 "처음부터 다시"가
안전하다 — 단, 다시 시작하는 위치가 **트랜잭션 경계 밖**이어야 한다.
트랜잭션 안에서 catch하고 다시 시도하면 PG 쪽 트랜잭션은 이미 aborted
상태라 이후 모든 문장이 `current transaction is aborted, commands ignored
until end of transaction block`으로 거부되고, 스프링 쪽도 rollback-only라
커밋 시점에 `UnexpectedRollbackException`을 만난다.

```java
// ❌ 트랜잭션 안에서 재시도 — PG 트랜잭션은 이미 aborted, 이후 문장은 전부 거부된다
@Transactional
public void transfer(long from, long to, BigDecimal amount) {
    for (int i = 0; i < 3; i++) {
        try { doTransfer(from, to, amount); return; }
        catch (PessimisticLockingFailureException e) { /* 재시도 */ }   // current transaction is aborted
    }
}

// ✅ 재시도는 바깥 빈에서, 트랜잭션은 안쪽 빈에서 — 경계를 구조로 분리한다 (@EnableRetry 필요)
@Service
public class TransferFacade {
    private final TransferService service;   // 이 안의 transfer()가 @Transactional

    @Retryable(
        retryFor = PessimisticLockingFailureException.class,   // 40P01 데드락 + 55P03 lock_timeout + 40001 직렬화 실패
        maxAttempts = 3,                                       // 상한 — 무한 재시도는 장애를 증폭한다
        backoff = @Backoff(delay = 50, multiplier = 2, random = true))   // 지터 — 같은 박자로 재충돌하지 않게
    public void transfer(long from, long to, BigDecimal amount) {
        service.transfer(from, to, amount);   // 매 시도마다 새 트랜잭션이 열린다
    }

    @Recover
    public void giveUp(PessimisticLockingFailureException e, long from, long to, BigDecimal amount) {
        throw new TemporarilyUnavailable("잠시 후 다시 시도해 주세요", e);   // 사용자에겐 재시도 가능 오류로
    }
}
```

세 가지 규칙을 코드에 그대로 박는다:

- **상한** — 데드락이 구조적이면(§3-1의 ❌ 코드가 그대로면) 재시도는 매번
  같은 자리에서 다시 죽는다. 상한 없는 재시도는 커넥션과 CPU만 태운다.
- **지터(random backoff)** — 두 요청이 같은 간격으로 재시도하면 같은
  박자로 다시 충돌한다. 자바 데드락 문서의 `randomBackoff()`와 같은 이유
  ([§5](../01-java-kotlin/24-deadlock-analysis-prevention.md)).
- **멱등성 확인** — 트랜잭션 안에서 롤백되지 않는 부수효과(외부 API 호출,
  메일 발송, 트랜잭션 밖 이벤트 발행)가 있었다면 재시도가 그것을 **두 번**
  실행한다. 재시도를 붙이기 전에 트랜잭션 안에 그런 게 없는지 먼저 확인한다.

재시도의 성격은 둘로 갈린다(가산점 포인트). **SERIALIZABLE의 `40001`은
재시도가 프로토콜의 일부**다 — 재시도 없이는 SSI를 쓴 게 아니다. 반면
**데드락 재시도는 진통제**다. `pg_stat_database.deadlocks`가 우상향이면
재시도가 덮고 있는 구조적 원인이 있다는 뜻이므로 §5-1로 돌아간다.

## 6. 트레이드오프 양면 조립 — 처방마다 "얻는 것 / 내주는 것"

한쪽 면만 말하는 습관을 깨기 위해 위 처방 각각을 두 면으로 나란히 둔다.
면접에서 처방을 하나 고르면 반드시 **오른쪽 열까지 한 호흡에** 말한다.

| 처방 | 얻는 것 | 내주는 것 |
|---|---|---|
| UNIQUE + `ON CONFLICT` 단일 문장 (§2-3 ①) | 잠금 문장 없음, 라운드트립 1회, `RETURNING`으로 예외 없이 판별 | 유니크 인덱스 필수, 충돌해도 시퀀스 소모, 영속성 컨텍스트 우회, `DO UPDATE`는 값이 같아도 새 튜플 버전 |
| UNIQUE + INSERT 시도, `23505` 번역 (②) | 모든 진입 경로를 DB가 방어, JPA `save()` 그대로 | 예외 기반 흐름, rollback-only 경계 처리 |
| 앵커 행 `FOR NO KEY UPDATE` (③) | 사용자 단위 직렬화, 발급 전 복잡한 판단 가능 | 앵커가 핫스팟, 앵커 존재 전제, `FOR UPDATE`로 쓰면 FK 자식 INSERT까지 차단 |
| advisory lock (④) | 행이 없어도 잠금, 임의 키 | 앱 규약 의존(한 경로라도 안 잡으면 무의미), PgBouncer는 `_xact_`만, 해시 충돌 시 불필요한 직렬화 |
| SERIALIZABLE (⑤) | 조회-판단-쓰기 전체의 정합성, 블로킹 없음 | `40001` 재시도 필수, 오탐 abort, 읽기 범위가 넓으면 abort율↑ |
| 키 순서 정렬 (§3-1, §3-4) | 유형 ①②④ 소멸 | 잠금용 SELECT 한 번 추가, 코드 규약 유지 부담 |
| `FOR NO KEY UPDATE` / 원자적 UPDATE (§3-3) | 유형 ③ 소멸, 자식 INSERT 동시성 유지 | JPA 표준 락 모드로는 못 만듦(네이티브), 삭제·키 변경 의도에는 부족 |
| `lock_timeout` | 긴 대기가 풀 고갈로 번지기 전에 실패 | 실패 처리 필요, 정상적으로 긴 배치엔 별도 값 |
| 재시도 (§5-4) | 일시적 충돌을 사용자 실패로 노출 안 함 | 처리량 저하, 멱등성 요구, 구조적 원인을 숨김 |

"갭 락이 없다"의 양면도 같은 방식으로 말한다. **얻는 것** — 잠금 읽기가
무관한 INSERT를 막지 않아 쓰기 동시성이 높고, 격리 수준과 무관하게 락
범위가 예측 가능하다. **내주는 것** — "없는 행을 잠가 상호 배제"라는 편한
관용구가 없어 제약·앵커·advisory lock·SSI 중 하나를 **의식적으로 골라야**
하고, 고르지 않으면 조용한 중복이 된다.

## 7. 꼬리질문 대비 포인트

### "PostgreSQL에는 갭 락이 없다면 팬텀 리드는 어떻게 막나요?"

두 층으로 답한다. **REPEATABLE READ**는 트랜잭션 시작 시점 스냅샷을
고정하므로 이후 커밋된 행이 아예 안 보인다 — 락으로 막는 게 아니라
스냅샷이 안 보여 주는 것이라 다른 세션의 INSERT를 막지 않는다(단 스냅샷
밖의 행을 갱신하려 하면 `40001`). 그런데 스냅샷은 읽기만 보호하고 "읽은
결과를 근거로 쓴 것"(선착순 한도 검사 → INSERT 같은 write skew)은 못
막는다. 그 층은 **SERIALIZABLE(SSI)** — 읽은 범위를 predicate lock으로
추적해 직렬화 불가능한 의존성이 생기면 한쪽을 `40001`로 abort한다. 블로킹이
없으니 데드락도 없고, 대신 재시도 루프가 필수다. MySQL RR의 넥스트 키 락이
하던 "범위 소유"는 PG에서 SSI 또는 존재하는 앵커 행 락으로 대체된다.

### "'조회해서 없으면 INSERT'를 `FOR UPDATE`로 짜면 PostgreSQL에서는 무슨 일이 벌어지나요?" (시니어 변별 포인트)

**아무것도 잠기지 않는다.** PG의 행 락은 튜플 헤더 `xmax`에 적는 표시라
없는 행에는 적을 자리가 없고, `FOR UPDATE`는 0행을 반환하며 끝난다. 두
요청이 둘 다 "없음"을 보고 둘 다 INSERT에 성공한다 — 유니크 제약이 없으면
**에러 없이 중복**, 있으면 두 번째가 첫 번째의 커밋을 기다렸다가 `23505`.
MySQL이라면 같은 코드가 갭 락 데드락으로 **시끄럽게 실패**했을 것을 PG는
**조용히 틀린다**는 것이 위험의 핵심이다. 처방은 잠금 읽기를 지우고
`UNIQUE` + `INSERT ... ON CONFLICT DO NOTHING RETURNING` 한 문장으로 끝내거나,
사전 판단이 꼭 필요하면 앵커 행 `FOR NO KEY UPDATE` 또는
`pg_advisory_xact_lock`. 이 코드를 리뷰에서 잡아낼 수 있으면 변별된다.

### "데드락 로그에 UPDATE 한 줄만 찍혀 있으면 원인을 어떻게 찾나요?"

서버 로그의 `Process N: <문장>`은 **대기 중이던 마지막 문장**일 뿐, 앞 문장은
나오지 않는다. 대신 반대편 줄이 흔적이다 — "Process 4214 waits for ShareLock
on transaction 8811; blocked by 4213"은 "4213의 트랜잭션이 4214가 원하는 행을
이미 잠갔다"는 뜻이므로 4213은 앞 문장에서 그 행을 건드렸다고 **역산**한다.
`CONTEXT: while updating tuple (0,2) in relation "users"`로 어느 튜플인지 알고,
`FOR KEY SHARE OF x`가 보이면 유형 ③, `while inserting index tuple`이면 유형
②로 분류한다. `application_name`과 `log_line_prefix`의 `%x`를 갖춰 두면
트랜잭션 단위로 문장을 이어 붙일 수 있고, 확신이 안 서면 §5-3처럼
재현하면서 `pg_blocking_pids()`로 t3 상태를 직접 본다. `log_lock_waits = on`이면
"데드락 직전의 긴 대기"가 미리 로그에 남는다.

### "`SELECT ... FOR UPDATE`의 WHERE가 인덱스를 못 타면 어떻게 되나요?"

PG는 Seq Scan으로 전 행을 읽지만 **락은 WHERE를 통과해 반환된 행에만**
건다 — 조건에 안 맞는 행도, 행 사이의 갭도 잠그지 않는다(MySQL RR이 스캔한
모든 레코드와 갭에 넥스트 키 락을 걸어 사실상 테이블 락이 되는 것과 다른
점). 그래도 위험은 셋이다. ① 스캔이 느린 만큼 **락 보유 시간이 길어지고**
커넥션을 쥔 채 오래 산다 → §1-6 사슬. ② 스캔 중 다른 트랜잭션이 갱신
중인 후보 행마다 그 XID를 **대기**하고, READ COMMITTED에서는 최신 버전으로
조건을 다시 평가한다. ③ 오래 열린 트랜잭션이 VACUUM을 막는다. 그래서 잠금
읽기는 배포 전 `EXPLAIN`으로 `Index Scan` + `LockRows`인지 확인하는 것이
규칙이어야 한다([FOR UPDATE 범위 문서](19-select-for-update-lock-scope.md)).

### "락 순서를 통일하면 데드락은 다 사라지나요?" (시니어 변별 포인트)

PG에서는 **대부분 그렇다 — 단 하나가 남는다.** 유형 ①②④는 모두 "같은
자원 둘을 반대 순서로"라는 순서 문제의 변형이라 키 순서 정렬로 사라진다.
그러나 유형 ③(부모 `FOR UPDATE` ↔ 자식 INSERT의 FK `KEY SHARE`)은 각
세션이 행을 하나씩만 잠갔는데도 나므로 순서가 아니라 **락 모드** 문제다 —
`FOR UPDATE`를 `FOR NO KEY UPDATE`(또는 원자적 UPDATE)로 바꿔야 사라진다.
그리고 §2-3의 check-then-insert는 데드락이 아니라 **중복**이라 순서와
무관하게 설계로 풀어야 한다. "데드락 = 락 순서 문제" 모델에 `FOR UPDATE` vs
`FOR NO KEY UPDATE`의 구분을 더할 수 있으면 PG를 써 본 사람으로 들린다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **"INSERT만 하는데 데드락"의 정체** — MySQL은 없는 행
`FOR UPDATE`가 갭 락을 남기고 INSERT의 인서트 인텐션 락이 서로의 갭 락에
막히는 것이지만, PG는 없는 행을 못 잠가 그 데드락이 없다 — 대신 조용한
중복이 된다. ② **유니크 중복 검사의 S 락 데드락** — MySQL은 미커밋 중복
키에 공유 락을 잡아 홀더가 롤백하면 대기자끼리 데드락이 나고 RC에서도
남지만, PG는 락 없이 XID 종료를 기다릴 뿐이라 직렬화로 끝난다. ③ **격리
수준과 락 범위** — MySQL은 RR 기본에 갭 락, RC로 낮추면 꺼지는 스위치가
있지만, PG는 RC 기본이고 어떤 격리 수준에서도 잠기는 것은 반환된 행뿐이다.
④ **`FOR UPDATE` vs `FOR NO KEY UPDATE`** — MySQL에는 이 구분이 없어 FK
검사의 부모 S 락이 X 락과 늘 충돌하지만, PG는 비키 갱신을 `FOR NO KEY
UPDATE`로 잡아 FK `KEY SHARE`와 공존시킨다 — PG 고유의 유형 ③과 그 처방이
여기서 나온다. ⑤ **감지와 진단** — MySQL은 즉시 감지해 수정 행이 적은 쪽을
롤백하고 `SHOW ENGINE INNODB STATUS`·`performance_schema.data_locks`로
읽지만, PG는 `deadlock_timeout`(1초) 뒤 검사한 쪽이 `40P01`로 abort되고
서버 로그의 "ShareLock on transaction" + `pg_blocking_pids()`·
`pg_stat_database.deadlocks`로 읽는다.

---

## 한 줄 요약

**PostgreSQL에는 갭 락·넥스트 키 락이 없다 — 행 락은 튜플 헤더 `xmax`에
적히는 표시라 존재하는 행만 잠글 수 있고, 팬텀은 REPEATABLE READ의
스냅샷이 안 보여 주며 "읽고 판단해서 쓰기"는 SERIALIZABLE의 SSI가 `40001`로
걸러낸다. 그래서 MySQL의 "없는 행 `FOR UPDATE` + INSERT" 갭 락 데드락은 PG에서
**조용한 중복**이 되고, 처방은 `UNIQUE` + `INSERT ... ON CONFLICT`·앵커 행
`FOR NO KEY UPDATE`·advisory lock이다. PG의 데드락은 ① 같은 행들을 다른
순서로 ② 유니크 키 삽입 대기 교차 ③ 부모 `FOR UPDATE` ↔ 자식 INSERT의 FK
`KEY SHARE` 충돌 ④ UPSERT 배치의 행 순서 불일치이며 `deadlock_timeout` 1초
뒤 한쪽이 `40P01`로 abort된다. 진단은 서버 로그의 "waits for ShareLock on
transaction"과 `CONTEXT`, `pg_blocking_pids()`·`log_lock_waits`이고, 처방은
격리 수준이 아니라 키 순서 정렬 · `FOR NO KEY UPDATE` · 배치 `ORDER BY` ·
짧은 트랜잭션에 트랜잭션 밖의 제한된 재시도와 래치 재현 테스트를 안전망으로
얹는 것이다.**
