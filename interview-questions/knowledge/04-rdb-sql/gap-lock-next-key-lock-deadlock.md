# 갭 락과 넥스트 키 락 — "INSERT만 하는데 데드락"의 정체

> 핵심 관전 포인트: **InnoDB의 행 락은 "행"이 아니라 "인덱스 레코드"에
> 걸리고, 레코드 사이의 빈 구간(갭)에도 걸린다. 갭 락은 그 구간으로의
> INSERT를 막는 것이 유일한 목적이라 갭 락끼리는 충돌하지 않지만, INSERT가
> 잡는 인서트 인텐션 락은 남의 갭 락에 막힌다. 그래서 두 트랜잭션이 같은
> 갭을 각자 잠그는 데 둘 다 성공한 뒤 각자 그 갭에 INSERT하면 서로의 갭 락에
> 막혀 순환 대기 — 이것이 "INSERT만 하는데 데드락"의 정체다. 갭 락은
> REPEATABLE READ의 잠금 읽기(`FOR UPDATE`/`UPDATE`/`DELETE`)에서 생기고,
> READ COMMITTED에서는 유니크 중복 검사·외래 키 검사 때만 남는다. 진단은
> `SHOW ENGINE INNODB STATUS`의 `LATEST DETECTED DEADLOCK`에서 두 트랜잭션의
> HOLDS/WAITING 락 모드를 교차 대조하는 것이고, 처방은 락 순서나 격리 수준이
> 아니라 "없는 행을 잠그지 않는 설계(앵커 행 락 · 유니크 제약+INSERT · 단일
> UPSERT)"에 트랜잭션 밖의 제한된 재시도와 재현 테스트를 안전망으로 얹는 것이다.**

---

## 0. 질문 + 의도

**질문**: "갭 락(gap lock), 넥스트 키 락이란? 어떤 상황에서 데드락을 유발하나요?"

관련 질문:
"대량 UPSERT(`INSERT ... ON DUPLICATE KEY UPDATE`)의 동작과 주의점은? (AUTO_INCREMENT 소모, 데드락)"
"`SELECT ... FOR UPDATE`는 어떤 락을 잡나요? WHERE 조건이 인덱스를 못 타면 무슨 일이 벌어지나요?"

**출제 의도**: rationale은 이렇게 적는다 — "**'INSERT만 하는데 데드락'이라는,
원리를 모르면 이해 불가능한 운영 현상의 정체. 데드락 로그를 읽고 원인
트랜잭션 쌍을 특정하는 실무 능력과 직결된다.**" 채점 지점은 셋이다.
① 락 4종(record / gap / next-key / insert intention)의 정의와 **호환 규칙**을
사실로 아는가 ② 그 규칙에서 "둘 다 잠그기 성공 → 둘 다 넣기 실패"라는
데드락 타임라인을 **스스로 그려내는가** ③ 데드락 로그를 읽어 원인 트랜잭션
쌍과 락 모드를 특정하고, 재발 방지를 **코드로 고정**하는가.

**이 문서가 특히 겨냥하는 지점** (3장·4장 면접 기록 기준):

- 3장에서 데드락은 **"반대 순서로 락을 잡는다"는 조건을 다 깔아줘도 힌트가
  있어야 도달한** 축이었다. 락 충돌은 알면 즉시 보이고 모르면 영원히 안
  보이는 유형이라, 이 문서는 데드락을 결론으로 말하지 않고 **한 스텝씩
  타임라인으로** 그린다(§3).
- 4장 내내 비용을 "락 경합", "성능 저하"처럼 이름 하나로 뭉뚱그린 뒤 멈추는
  패턴이 반복됐다. 여기서는 갭 락의 비용을 **메커니즘 사슬**로 끝까지 잇는다(§2-3).
- 트레이드오프를 한쪽 면만 말하는 습관 — 각 처방마다 **얻는 것 / 내주는 것**을
  나란히 붙여 둔다(§6).
- 안전망을 코드로 고정하는 습관 부재 — 재현 테스트 · 로그 읽기 절차 ·
  재시도 정책을 전부 **코드와 절차**로 적는다(§4, §5).

## 1. 락 4종 — 암기 목록

InnoDB의 "행 락"은 정확히는 **인덱스 레코드 락**이다. 락은 테이블의 행이
아니라 인덱스(클러스터드 인덱스 = 테이블 자체, 그리고 세컨더리 인덱스) 위에
정렬된 레코드와, 레코드 **사이**에 걸린다. 이 문장을 받아들이면 나머지가
전부 따라온다.

예로 `uk_user_coupon (user_id, coupon_id)` 유니크 인덱스에 `coupon_id = 7`인
레코드가 `user_id` 5, 10, 20, 30으로 4건 있다고 하자. 인덱스 위에는
레코드 4개와 **갭 5개**가 있다:

```text
(-∞, 5)  [5]  (5, 10)  [10]  (10, 20)  [20]  (20, 30)  [30]  (30, +∞)
  갭     레코드   갭    레코드    갭     레코드    갭    레코드   갭(supremum 앞)
```

### 1-1. 레코드 락 (record lock)

인덱스 레코드 **하나**에 거는 락. `[10]`만 잠근다. 공유(S)/배타(X)가 있고,
X끼리 · X와 S는 충돌한다. `SELECT ... WHERE user_id = 10 AND coupon_id = 7
FOR UPDATE`처럼 **유니크 인덱스 + 등호 + 행이 존재**할 때 잡는 락은 정확히
이것뿐이다 — 이 경우 갭은 잠그지 않는다.

### 1-2. 갭 락 (gap lock)

레코드 **사이의 빈 구간**에 거는 락. `(10, 20)`을 잠그면 user_id 11~19의
INSERT가 막힌다. 첫 레코드 앞 `(-∞, 5)`와 마지막 레코드 뒤 `(30, +∞)`
(내부적으로는 supremum 의사 레코드 앞의 갭)도 갭이다.

세 가지 성질을 반드시 같이 외운다:

- **목적이 하나뿐이다 — 그 구간으로의 INSERT 차단**(phantom 방지). 기존
  레코드를 읽거나 갱신하는 것은 갭 락이 막지 않는다.
- **갭 락끼리는 충돌하지 않는다.** 여러 트랜잭션이 같은 갭에 동시에 갭 락을
  잡을 수 있다. S 갭 락과 X 갭 락의 구분도 사실상 의미가 없다 — 둘 다
  "여기 아무도 넣지 마"라는 같은 주장이기 때문이다.
- **데드락의 씨앗은 이 두 성질의 조합이다.** "둘 다 잠그기 성공"이 가능하다는 것.

### 1-3. 넥스트 키 락 (next-key lock)

**레코드 락 + 그 레코드 바로 앞 갭의 갭 락.** `[20]`의 넥스트 키 락은
`(10, 20]`이다. REPEATABLE READ에서 잠금 읽기가 인덱스를 **스캔**할 때
지나가는 레코드마다 기본으로 잡는 락이 이것이다. `WHERE user_id > 10 FOR
UPDATE`면 `(10, 20]`, `(20, 30]`, `(30, +∞)`를 전부 잠근다 — 10보다 큰
값은 **존재하는 것도, 아직 없는 것도** 전부 막힌다. 이것이 InnoDB RR이
phantom을 막는 방식이다([격리 수준 문서 §3](transaction-isolation-levels.md)).

### 1-4. 인서트 인텐션 락 (insert intention lock)

INSERT가 행을 실제로 넣기 **직전**에 갭에 거는 특수한 갭 락. "나 이 갭에
넣을 거야"라는 의사 표시다.

- 같은 갭에 여러 트랜잭션이 **서로 다른 위치**로 INSERT하면 인서트 인텐션
  락끼리는 충돌하지 않는다(4와 7 사이에 5와 6을 넣는 두 트랜잭션은 서로
  기다리지 않는다). 그래서 갭 락 없이 INSERT만 몰리는 테이블은 잘 막히지 않는다.
- 그러나 **다른 트랜잭션이 잡은 갭 락 / 넥스트 키 락과는 충돌한다.** 갭 락의
  유일한 목적이 INSERT 차단이니 당연하다.
- 방향이 비대칭이다: 갭 락은 인서트 인텐션을 막지만, 이미 잡힌 인서트 인텐션
  락이 남의 갭 락 요청을 막지는 않는다.

### 1-5. 호환 규칙 — 이 표 하나로 데드락이 설명된다

| 이미 잡힌 락 ↓ / 새 요청 → | 갭 락 | 인서트 인텐션 | 레코드 X |
|---|---|---|---|
| 갭 락 | 호환 | **대기** | 호환 (갭은 레코드가 아님) |
| 인서트 인텐션 | 호환 | 호환 (다른 위치면) | — |
| 레코드 X | — | — | **대기** |

핵심 한 칸은 "갭 락 보유 중 → 인서트 인텐션 요청 → 대기"다. 나머지 칸은
거의 다 호환이라, 갭 락 데드락은 항상 **"갭을 잠근 채 그 갭에 넣으려는 두
트랜잭션"** 사이에서 난다.

## 2. 어떤 문장이 갭 락을 만드는가 — RR vs RC 암기 목록

갭 락은 **잠금 읽기(locking read)** 에서만 생긴다. 일반 SELECT는 MVCC
스냅샷을 읽으므로 어떤 락도 잡지 않는다. 잠금 읽기란 `SELECT ... FOR UPDATE`
/ `FOR SHARE`, 그리고 `UPDATE` / `DELETE`가 대상 행을 찾는 과정이다.
(INSERT의 유니크 중복 검사도 별도 경로로 락을 잡는데, §3-2에서 다룬다.)

### 2-1. REPEATABLE READ (InnoDB 기본) — 조건별로 잡히는 락

- **유니크 인덱스 + 등호 + 행이 존재**: 레코드 락만. 갭 없음.
  (`WHERE id = 10 FOR UPDATE`)
- **유니크 인덱스 + 등호 + 행이 없음**: 그 값이 들어갈 자리의 **갭 락**.
  (`WHERE id = 15 FOR UPDATE` → `(10, 20)`) ← **데드락 1순위 패턴의 출발점**
- **비유니크 인덱스 + 등호**: 일치하는 레코드마다 넥스트 키 락 + 마지막 일치
  레코드 다음 갭까지. 같은 값을 하나 더 넣는 INSERT를 막아야 하기 때문이다.
- **범위 조건 (`>`, `BETWEEN`, `LIKE 'ab%'`)**: 스캔한 레코드마다 넥스트 키
  락. 범위 끝 뒤의 갭까지.
- **복합 유니크 인덱스에서 일부 컬럼만 조건**: 유니크로 취급되지 않아 넥스트
  키 락. (`uk(user_id, coupon_id)`에 `WHERE user_id = 10 FOR UPDATE`)
- **WHERE가 인덱스를 못 탐**: 클러스터드 인덱스를 전 행 스캔하면서 **모든
  레코드 + 모든 갭에 넥스트 키 락** = 사실상 테이블 전체 잠금. 다른 세션의
  INSERT가 전부 막힌다.
- **`UPDATE` / `DELETE`도 같은 규칙**: `UPDATE ... WHERE id = 15`에서 행이
  없으면 갭 락만 남기고 끝난다. "UPDATE 했는데 0건이라 INSERT" 패턴이
  데드락을 내는 이유다.

### 2-2. READ COMMITTED — 갭 락이 꺼진다

- 검색·스캔에서 **갭 락과 넥스트 키 락을 잡지 않는다.** 레코드 락만.
- `UPDATE` / `DELETE`가 스캔 중 WHERE에 안 맞는 행의 락은 **즉시 해제**한다
  (RR은 트랜잭션 끝까지 유지).
- **예외 두 가지 — RC에서도 남는 갭 락**: **유니크 중복 검사**(INSERT/UPDATE가
  유니크 키 충돌을 확인할 때)와 **외래 키 검사**. 그래서 "RC로 낮추면 갭 락
  데드락이 다 사라진다"는 반만 맞다(§3-2 패턴은 RC에서도 난다).
- 대가: phantom read 허용. 같은 트랜잭션에서 잠금 읽기를 두 번 하면 사이에
  커밋된 행이 나타난다. 그리고 바이너리 로그를 쓰는 서버라면 **ROW 포맷**이어야
  한다 — STATEMENT 기반 복제는 RC에서 정합성이 깨질 수 있어 InnoDB가 거부한다.

### 2-3. 갭 락의 비용을 사슬로 말하기

"갭 락 때문에 느려진다"에서 멈추지 말 것. 데드락이 나지 않아도 갭 락은
이렇게 비용을 만든다:

**잠금 읽기가 범위·비유니크·인덱스 미사용 조건 → 넥스트 키 락이 레코드뿐
아니라 갭까지 덮음 → 그 값과 무관한(범위 안에 우연히 들어가는) INSERT까지
대기 → 대기하는 쓰기 트랜잭션의 수명이 잠금 트랜잭션 수명만큼 늘어남 → 그
시간 동안 커넥션을 쥔 채 놓지 못함 → 커넥션 풀 활성 커넥션 수 ↑ → 풀 고갈 →
무관한 API까지 `getConnection` 대기 → 전 서비스 응답 시간 상승.**

각 화살표 하나가 면접의 "왜요?"에 대한 답이다. 마지막 두 마디(커넥션 풀 →
전 서비스)는 4장 Q4에서 힌트를 받고서야 나온 대목이라, 이 사슬은 통째로
입에 붙여 둔다.

## 3. "INSERT만 하는데 데드락" — 타임라인으로 그리기

애플리케이션 로그에는 INSERT 문장에서 `Deadlock found when trying to get lock`
이 찍힌다. 코드를 보면 INSERT 한 줄이다. 그래서 "INSERT는 새 행을 만드는
건데 무슨 락 충돌이야?"가 첫 반응이 된다. 두 가지 경로가 있고, 둘 다
**INSERT 이전에 갭(또는 레코드) 락이 이미 잡혀 있었다**는 공통점이 있다.

### 3-1. 패턴 A — "없으면 넣기"를 FOR UPDATE로 짠 경우 (갭 락 + 인서트 인텐션)

쿠폰 발급: "이 사용자가 이미 받았는지 잠그고 확인한 뒤, 없으면 INSERT".
인덱스 `uk_user_coupon(user_id, coupon_id)`, coupon_id = 7에 대해 user_id
5, 10, 20, 30이 발급된 상태.

```java
// ❌ 없는 행을 FOR UPDATE로 잠그는 코드 — RR에서 갭 락을 만든다
@Transactional
public void issue(long userId, long couponId) {
    var existing = repo.findForUpdate(userId, couponId);   // SELECT ... FOR UPDATE → 행 없음 → 갭 락
    if (existing.isPresent()) throw new AlreadyIssued();
    repo.save(new CouponIssue(userId, couponId));           // INSERT → 인서트 인텐션 락
}
```

사용자 15번과 17번이 거의 동시에 요청한다. 둘 다 `(10, 20)` 갭에 들어가는
값이다.

```text
시간 →  Tx A (user 15)                        Tx B (user 17)                        (10,20) 갭의 락 상태
t1      SELECT ... WHERE user_id=15 ... FOR UPDATE
        → 행 없음 → 갭 락 (10,20) 획득                                               A: 갭 락
t2                                            SELECT ... WHERE user_id=17 ... FOR UPDATE
                                              → 행 없음 → 갭 락 (10,20) 획득          A: 갭 락 / B: 갭 락
                                              ★ 갭 락끼리 호환 → 여기서 안 막힌다
t3      INSERT (15, 7)
        → 인서트 인텐션 요청 → B의 갭 락과 충돌
        → 대기                                                                       A → B 대기
t4                                            INSERT (17, 7)
                                              → 인서트 인텐션 요청 → A의 갭 락과 충돌
                                              → 대기                                 B → A 대기 = 순환
t5      InnoDB가 대기 그래프의 사이클을 즉시 감지 → 수정 행이 적은 쪽을 희생자로 롤백
        희생자: ERROR 1213 (40001) Deadlock found when trying to get lock; try restarting transaction
        생존자: INSERT 진행 → COMMIT
```

두 가지가 직관을 배신한다. 첫째, **두 트랜잭션은 서로 다른 값(15와 17)을
넣는다.** 값이 겹치지 않는데도 데드락이 난다 — 같은 **갭**을 잠갔기 때문이다.
둘째, **t2에서 B의 잠금이 성공한다.** 레코드 락이었다면 B는 t2에서 A를
기다리고, A가 끝나면 이어서 진행해 데드락이 아니라 직렬화가 됐을 것이다.
갭 락은 호환이라 둘 다 "잠갔다고 믿는" 상태가 만들어지고, 그 믿음이
INSERT에서 깨진다.

이 타임라인이 성립하는 조건을 목록으로:

- 격리 수준 RR (갭 락이 켜져 있음)
- 잠금 읽기(`FOR UPDATE` / `UPDATE` / `DELETE`)가 **존재하지 않는 값**이나
  **범위**를 조건으로 함 → 갭 락
- 같은 트랜잭션이 이어서 그 갭에 INSERT
- 이 트랜잭션이 동시에 둘 이상

`UPDATE ... WHERE key = ?` 후 affected rows가 0이면 INSERT하는 "UPSERT
흉내" 코드도 정확히 같은 타임라인이다 — UPDATE가 행을 못 찾으면 갭 락만
남기고 끝나기 때문이다.

### 3-2. 패턴 B — 정말로 INSERT 문장만 있는 경우 (유니크 중복 검사의 공유 락)

이번엔 트랜잭션 안에 INSERT 말고 아무것도 없다. 그런데도 데드락이 난다.
열쇠는 **유니크 인덱스의 중복 검사가 락을 잡는다**는 사실이다.

INSERT는 유니크 키 중복을 확인해야 하는데, 다른 트랜잭션이 **아직 커밋하지
않은** 같은 키의 행이 있으면 그 행의 운명(커밋될지 롤백될지)이 정해질 때까지
중복 여부를 확정할 수 없다. 그래서 InnoDB는 그 레코드에 **공유(S) 락을
요청하고 기다린다.** 이 S 락이 갭을 포함한 넥스트 키 성격이라는 점, 그리고
**S 락은 여러 트랜잭션이 동시에 얻을 수 있다**는 점이 데드락을 만든다.

```text
시간 →  Tx A                  Tx B                          Tx C                          레코드 (10,7)의 락
t1      INSERT (10, 7) 성공
        (X 레코드 락, 미커밋)                                                              A: X
t2                            INSERT (10, 7)
                              → 중복 검사: (10,7)에 S 요청
                              → A의 X와 충돌 → 대기                                        A: X / B: S 대기
t3                                                          INSERT (10, 7)
                                                            → S 요청 → 대기                A: X / B, C: S 대기
t4      ROLLBACK
        (A의 행이 사라짐)                                                                  B: S 획득 / C: S 획득
                                                                                           ★ S끼리 호환
t5                            중복 없음 → 실제 삽입을 위해
                              X(인서트 인텐션) 필요
                              → C의 S와 충돌 → 대기                                        B → C 대기
t6                                                          같은 이유로 B의 S에 막힘        C → B 대기 = 순환
t7      InnoDB가 B 또는 C 하나를 롤백. 나머지 하나가 삽입 성공.
```

A가 t4에서 COMMIT했다면 B와 C는 그냥 `Duplicate entry` 에러를 받고 끝난다 —
데드락은 **A가 사라질 때(ROLLBACK, 또는 A가 그 행을 DELETE하고 COMMIT)**
만 난다. 운영에서 이 패턴이 나오는 얼굴은 두 가지다:

- **재시도 폭풍**: 첫 시도가 다른 이유로 롤백되는 사이, 같은 키로 재시도
  요청이 여럿 몰려 S 락 대기 줄을 만든 경우.
- **"지우고 다시 넣기" 배치**: `DELETE ... WHERE key = ?` 후 같은 키를
  `INSERT`하는 재적재 배치가 동시에 둘 돌 때. 첫 배치의 DELETE가 X 락을 쥔
  동안 두 번째 배치의 INSERT들이 S 락 대기 줄에 서고, 첫 배치가 COMMIT하는
  순간 t4 상황이 된다.

이 패턴은 **RC에서도 그대로 발생한다** — 중복 검사의 갭 락은 RC가 끄지 않는
예외 항목이기 때문이다(§2-2).

### 3-3. 3장의 데드락(락 순서 역전)과 무엇이 다른가

3장에서 다룬 데드락은 "A는 재고 → 포인트, B는 포인트 → 재고 순서로 **존재하는
행**을 잠근다"는 순서 역전이었고, 처방은 락 순서 고정이었다([flush 순서
문서](../03-jpa-orm/flush-timing-and-sql-ordering.md), [자바 데드락 문서
§4](../01-java-kotlin/deadlock-analysis-prevention.md)). 갭 락 데드락은
다르다 — **두 트랜잭션이 같은 자원(같은 갭)을 같은 순서로 잠갔는데도** 난다.
순서를 맞춰도 못 막는다는 뜻이고, 처방은 순서가 아니라 **"없는 행을 잠그지
않는 것"**(§5-1)이다. "락 순서를 통일하면 되지 않나요?"가 꼬리로 오면 이
차이를 말한다.

## 4. 데드락 로그 읽기 — `SHOW ENGINE INNODB STATUS` 절차

애플리케이션 예외만으로는 "누구와" 데드락이 났는지 모른다. 상대 트랜잭션은
성공했고 로그도 남기지 않았기 때문이다. 상대를 특정하는 1차 자료가 InnoDB
상태 출력의 `LATEST DETECTED DEADLOCK` 섹션이다.

### 4-1. 실제 출력(§3-1 패턴 A)과 읽는 순서

```text
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-08-30 10:12:33 0x7f3c...
*** (1) TRANSACTION:
TRANSACTION 4213, ACTIVE 2 sec inserting
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136, 2 row lock(s), undo log entries 0
MySQL thread id 41, OS thread handle ..., query id 9931 10.0.1.12 app update
INSERT INTO coupon_issue (user_id, coupon_id) VALUES (15, 7)          ← ③ 대기 중이던 마지막 문장

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 61 page no 5 n bits 80 index uk_user_coupon of table `shop`.`coupon_issue`
trx id 4213 lock_mode X locks gap before rec                          ← ④ 갭 락을 "쥐고" 있다

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 61 page no 5 n bits 80 index uk_user_coupon of table `shop`.`coupon_issue`
trx id 4213 lock_mode X locks gap before rec insert intention waiting  ← ⑤ 인서트 인텐션을 "기다린다"

*** (2) TRANSACTION:
TRANSACTION 4214, ACTIVE 1 sec inserting
...
INSERT INTO coupon_issue (user_id, coupon_id) VALUES (17, 7)

*** (2) HOLDS THE LOCK(S):
... index uk_user_coupon ... trx id 4214 lock_mode X locks gap before rec

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
... index uk_user_coupon ... trx id 4214 lock_mode X locks gap before rec insert intention waiting

*** WE ROLL BACK TRANSACTION (2)                                       ← ⑥ 희생자
```

절차:

1. **섹션 찾기** — 출력이 길다. `LATEST DETECTED DEADLOCK`으로 검색한다.
   **마지막 1건만** 남는다. 데드락이 잦다면 `innodb_print_all_deadlocks = ON`으로
   모든 건을 에러 로그에 남긴다.
2. **두 트랜잭션의 정체** — `MySQL thread id`, 접속 IP·계정, `ACTIVE n sec`
   (얼마나 오래된 트랜잭션인지), `undo log entries`(수정한 행 수). 계정·IP로
   어느 서비스/배치인지 특정한다.
3. **마지막 문장** — 각 트랜잭션이 **대기 중이던** 문장이다. 여기서 초보가
   가장 헷갈린다: **로그에는 그 트랜잭션이 앞에서 실행한 문장들이 나오지
   않는다.** INSERT만 보이지만 INSERT가 갭 락을 잡은 게 아니다. "앞에 뭔가
   있었다"는 사실은 다음 단계의 HOLDS에서 읽는다.
4. **HOLDS THE LOCK(S) 해독** — 인덱스 이름(`uk_user_coupon`)과 락 모드.
   `locks gap before rec`가 있으면 **이 트랜잭션은 INSERT 이전에 갭 락을 잡는
   문장(FOR UPDATE / UPDATE / DELETE)을 실행했다**는 뜻이다. 이제 코드에서 그
   트랜잭션 경계 안의 잠금 읽기를 찾으러 간다.
5. **WAITING 해독 + 교차 대조** — (1)이 기다리는 락과 (2)가 쥔 락이 같은
   인덱스·같은 페이지·같은 갭인지, 반대 방향도 성립하는지 확인한다. 성립하면
   순환 확정.
6. **희생자와 예외 매핑** — `WE ROLL BACK TRANSACTION (2)`가 1213을 받은
   쪽이다. 애플리케이션 에러 로그의 시각·스레드와 맞춰 본다.

### 4-2. 락 모드 문자열 해독표

| 로그 문자열 | 락 종류 |
|---|---|
| `lock_mode X` (뒤에 아무것도 없음) | 넥스트 키 락 (레코드 + 앞 갭) |
| `lock_mode X locks rec but not gap` | 레코드 락만 |
| `lock_mode X locks gap before rec` | 갭 락만 |
| `lock_mode X locks gap before rec insert intention` | 인서트 인텐션 락 |
| `lock mode S ...` (공유 락은 밑줄 없이 찍힌다) | 공유 락 — INSERT 트랜잭션에서 보이면 **유니크 중복 검사**(§3-2) 신호 |

두 트랜잭션 모두 "HOLDS에 `gap before rec`, WAITING에 `insert intention`"이면
§3-1 패턴, "HOLDS에 `lock mode S`, WAITING에 X"이면 §3-2 패턴이다. 이 두
서명을 외워 두면 로그를 열고 10초 안에 패턴을 분류할 수 있다.

### 4-3. 살아 있는 락 보기 (가산점 포인트)

데드락은 감지 즉시 풀리므로 사후 로그밖에 없지만, **락 대기가 길어지는
상황**은 실시간으로 볼 수 있다: `performance_schema.data_locks`(락 목록,
`LOCK_MODE`에 `X,GAP` / `X,REC_NOT_GAP` / `X,INSERT_INTENTION` 같은 값)와
`data_lock_waits`(누가 누구를 기다리는지). 구버전은
`information_schema.INNODB_LOCKS` / `INNODB_LOCK_WAITS`. 재현 테스트(§5-3)를
돌리다 멈춰 놓고 이 테이블을 조회하면 §3-1의 t2 상태(같은 갭에 갭 락 두 개)를
눈으로 확인할 수 있다.

데드락 발생 횟수는 `information_schema.INNODB_METRICS`의 `lock_deadlocks`
카운터로 센다. 이 값을 메트릭으로 내보내 알람을 걸어 두면 "재시도로 조용히
덮이고 있는 데드락"의 증가 추세를 잡을 수 있다.

## 5. 예방과 안전망 — 코드로 고정한다

### 5-1. 설계로 없애기 — "없는 행을 잠그지 마라"

패턴 A의 근본 원인은 **존재하지 않는 행을 잠그려 한 것**이다. 없는 행을
잠그면 InnoDB는 갭을 잠글 수밖에 없고, 갭 락은 호환이라 상호 배제가 안 된다.
처방은 세 갈래고 각각 대가가 있다(§6에서 양면 정리).

**처방 ① — 존재하는 앵커 행을 잠근다.** 사용자별 발급을 직렬화하고 싶다면
없는 `coupon_issue` 행이 아니라 **항상 존재하는 `users` 행**을 잠근다. 유니크
인덱스 + 등호 + 존재하는 행 → 레코드 락만 → 갭 없음 → 두 번째 트랜잭션은
t2에서 **대기**하고, 첫 번째가 끝나면 이어서 진행한다(직렬화, 데드락 아님).

```java
// ✅ 앵커 행(존재하는 부모 행)에 레코드 락 → 갭 락이 생기지 않는다
@Transactional
public void issue(long userId, long couponId) {
    userRepo.lockById(userId);                              // SELECT id FROM users WHERE id = ? FOR UPDATE
    if (repo.existsByUserIdAndCouponId(userId, couponId)) throw new AlreadyIssued();
    repo.save(new CouponIssue(userId, couponId));
}
```

**처방 ② — 잠그지 말고 유니크 제약에 맡긴 뒤 INSERT를 시도한다.** 사전 확인
없이 INSERT하고 `DataIntegrityViolationException`을 "이미 발급됨"으로
번역한다. 갭 락을 잡는 문장이 없으니 패턴 A는 사라진다. 이 방식의 트랜잭션
처리(rollback-only, `REQUIRES_NEW`)는 [복합 유니크 제약 문서
§3](../03-jpa-orm/unique-constraint-concurrent-insert.md)에 정리돼 있다.

**처방 ③ — 단일 UPSERT 문장.** `INSERT ... ON DUPLICATE KEY UPDATE`는 중복이
나면 공유 락이 아니라 **배타 락**을 잡으므로 §3-2의 "S 락 둘 → X 승격 경쟁"
구조 자체가 생기지 않는다(가산점 포인트). 대신 갱신에도 AUTO_INCREMENT를
소모하는 등 별도 주의점이 있고, 이는 같은 섹션의 "대량 UPSERT" 문항에서 다룬다.

패턴 B("지우고 다시 넣기" 배치)의 처방은 **DELETE + INSERT를 UPDATE로
바꾸거나**, 재적재 배치가 같은 키 범위에 동시에 둘 돌지 않도록 **키 범위로
분할**하는 것이다.

이 밖의 상시 규칙:

- **잠금 읽기의 WHERE는 반드시 인덱스를 타게** — 못 타면 전 테이블 넥스트 키
  락(§2-1 마지막 항목). `EXPLAIN`으로 확인.
- **트랜잭션을 짧게** — 갭 락은 트랜잭션 끝까지 유지된다. 외부 호출·파일
  처리를 트랜잭션 안에 두면 갭 락 점유 시간이 그만큼 늘어난다.
- 여러 행을 잠글 때 **PK 순서 고정**은 여전히 필요하다(3장 처방) — 갭 락
  데드락과 별개로 순서 역전 데드락이 겹칠 수 있다.

### 5-2. 격리 수준으로 끄기 — 트랜잭션 단위로

```java
// 이 로직에서만 갭 락을 끈다 — DB 전역 설정을 바꾸지 않는다
@Transactional(isolation = Isolation.READ_COMMITTED)
public void issue(long userId, long couponId) { ... }
```

패턴 A는 사라진다. 그러나 (a) 패턴 B는 그대로 남고, (b) 그 트랜잭션 안에서
"범위를 잠갔으니 phantom이 없다"고 가정한 로직이 있었다면 깨지며, (c) 격리
수준 지정은 트랜잭션을 **새로 여는** 쪽에서만 유효하다(기존 트랜잭션에
합류하면 무시 — [격리 수준 문서 §5](transaction-isolation-levels.md)).
도구로는 유효하지만 1순위 처방이 아닌 이유가 §6에 있다.

### 5-3. 재현 테스트 — 두 스레드 `CountDownLatch`로 타임라인을 강제한다

데드락은 "동시에 돌리면 가끔" 나는 게 아니라 **§3-1의 t1 → t2 → t3 → t4 순서가
만들어지면 반드시** 난다. 그러니 테스트는 스레드를 동시에 출발시키는 게
아니라 **그 순서를 래치로 강제**해야 한다. 그리고 반드시 **실제
MySQL(Testcontainers)** 이어야 한다 — H2에는 갭 락이 없어 이 테스트가 통과해
버린다. 테스트 메서드에 `@Transactional`을 붙이지 않는다 — 테스트 스레드의
트랜잭션은 워커 스레드에 전파되지 않아 의미가 없고, 시드 데이터가 롤백에
묶여 다른 커넥션에서 보이지 않게 된다. 두 스레드가 각자 `TransactionTemplate`으로
트랜잭션을 열고, 뒷정리는 `@BeforeEach`에서 직접 한다.

```java
@SpringBootTest
@Testcontainers
class GapLockDeadlockTest {

    @Autowired TransactionTemplate tx;     // 각 스레드가 자기 트랜잭션을 연다
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void seed() {   // 인덱스 위에 5, 10, 20, 30 → (10, 20) 갭이 생긴다
        jdbc.update("DELETE FROM coupon_issue");
        for (long u : List.of(5L, 10L, 20L, 30L))
            jdbc.update("INSERT INTO coupon_issue (user_id, coupon_id) VALUES (?, 7)", u);
    }

    @Test
    void 없는_행을_FOR_UPDATE로_잠그고_INSERT하면_데드락이_재현된다() throws Exception {
        var aLockedGap = new CountDownLatch(1);
        var bLockedGap = new CountDownLatch(1);
        var pool = Executors.newFixedThreadPool(2);

        Future<?> a = pool.submit(() -> tx.executeWithoutResult(s -> {
            jdbc.queryForList("SELECT id FROM coupon_issue WHERE user_id = 15 AND coupon_id = 7 FOR UPDATE");
            aLockedGap.countDown();                     // t1: A가 (10,20) 갭 락 획득
            await(bLockedGap);                          // B도 같은 갭을 잠글 때까지 기다린다
            jdbc.update("INSERT INTO coupon_issue (user_id, coupon_id) VALUES (15, 7)");   // t3
        }));
        Future<?> b = pool.submit(() -> tx.executeWithoutResult(s -> {
            await(aLockedGap);
            jdbc.queryForList("SELECT id FROM coupon_issue WHERE user_id = 17 AND coupon_id = 7 FOR UPDATE");
            bLockedGap.countDown();                     // t2: 갭 락끼리 호환 → 여기서 막히지 않는다
            jdbc.update("INSERT INTO coupon_issue (user_id, coupon_id) VALUES (17, 7)");   // t4 → 순환 완성
        }));

        var failures = new ArrayList<Throwable>();
        for (var f : List.of(a, b)) {
            try { f.get(10, TimeUnit.SECONDS); } catch (ExecutionException e) { failures.add(e.getCause()); }
        }
        pool.shutdownNow();

        // 정확히 한 트랜잭션만 데드락 희생자가 되고, 나머지 하나는 성공한다
        assertThat(failures).hasSize(1);
        assertThat(failures.get(0)).isInstanceOf(PessimisticLockingFailureException.class);
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM coupon_issue WHERE user_id IN (15, 17)", Integer.class))
            .isEqualTo(1);
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

이 테스트의 쓰임은 둘이다. **먼저 빨간 불을 본다** — "우리 코드가 정말 갭 락
데드락을 내는가"를 추측이 아니라 사실로 만든다. 그 다음 §5-1 처방을 적용한
뒤에는 **같은 시나리오에서 데드락 예외 0건, 두 행 모두 삽입**을 단언하는
테스트로 바꿔 회귀 방지 장치로 남긴다(앵커 행 락으로 바꾸면 B가 t2에서
대기하므로 래치 대신 [복합 유니크 제약 문서
§8](../03-jpa-orm/unique-constraint-concurrent-insert.md)의 "동시 출발"
패턴을 쓴다). 나중에 누군가 "확인 후 INSERT가 더 읽기 쉽다"며 `FOR UPDATE`로
되돌리면 이 테스트가 막는다. 3장에서 일곱 번 지적된 "안전망을 코드로 고정"이
정확히 이것이다.

한 가지 더 — 예외 타입을 단언하기 전에 **실제로 어떤 타입이 올라오는지 이
테스트로 먼저 확인**한다. `JdbcTemplate` 경로에서는 MySQL 1213이
`DeadlockLoserDataAccessException`으로, JPA 경로에서는 Hibernate 예외 변환을
한 번 더 거쳐 `CannotAcquireLockException`으로 올라올 수 있다. 둘의 공통 부모
`PessimisticLockingFailureException`으로 잡는 것이 안전하다.

### 5-4. 재시도 정책 — 트랜잭션 밖에서, 상한과 지터를 두고

데드락 희생자는 InnoDB가 **트랜잭션 전체를 롤백**했으므로 "처음부터 다시"가
안전하다 — 단, 다시 시작하는 위치가 **트랜잭션 경계 밖**이어야 한다. 트랜잭션
안에서 catch하고 다시 시도하면 이미 rollback-only로 표시된 트랜잭션 위에서
작업하는 셈이라 커밋 시점에 `UnexpectedRollbackException`을 만난다([복합
유니크 제약 문서 §3](../03-jpa-orm/unique-constraint-concurrent-insert.md)).

```java
// ❌ 트랜잭션 안에서 재시도 — 이미 롤백된 트랜잭션 위에서 돌고 있다
@Transactional
public void issue(long userId, long couponId) {
    for (int i = 0; i < 3; i++) {
        try { doIssue(userId, couponId); return; }
        catch (PessimisticLockingFailureException e) { /* 재시도 */ }   // 커밋 시점에 UnexpectedRollbackException
    }
}

// ✅ 재시도는 바깥 빈에서, 트랜잭션은 안쪽 빈에서 — 경계를 구조로 분리한다 (@EnableRetry 필요)
@Service
public class CouponIssueFacade {
    private final CouponIssueService service;   // 이 안의 issue()가 @Transactional

    @Retryable(
        retryFor = PessimisticLockingFailureException.class,   // 데드락(1213) + 락 대기 타임아웃(1205). 구버전은 value =
        maxAttempts = 3,                                       // 상한 — 무한 재시도는 장애를 증폭한다
        backoff = @Backoff(delay = 50, multiplier = 2, random = true))   // 지터 — 같은 박자로 재충돌하지 않게
    public void issue(long userId, long couponId) {
        service.issue(userId, couponId);   // 매 시도마다 새 트랜잭션이 열린다
    }

    @Recover
    public void giveUp(PessimisticLockingFailureException e, long userId, long couponId) {
        throw new TemporarilyUnavailable("잠시 후 다시 시도해 주세요", e);   // 사용자에겐 재시도 가능 오류로
    }
}
```

세 가지 규칙을 코드에 그대로 박는다:

- **상한** — 데드락이 구조적이면(§3-1 코드가 그대로면) 재시도는 매번 같은
  자리에서 다시 죽는다. 상한 없는 재시도는 커넥션과 CPU만 태운다.
- **지터(random backoff)** — 두 요청이 같은 간격으로 재시도하면 같은 박자로
  다시 충돌한다. 자바 데드락 문서의 `randomBackoff()`와 같은 이유([§5](../01-java-kotlin/deadlock-analysis-prevention.md)).
- **멱등성 확인** — 트랜잭션 안에서 롤백되지 않는 부수효과(외부 API 호출,
  메일 발송, 트랜잭션 밖 이벤트 발행)가 있었다면 재시도가 그것을 **두 번**
  실행한다. 재시도를 붙이기 전에 트랜잭션 안에 그런 게 없는지 먼저 확인한다.

그리고 재시도는 **진통제**다. `lock_deadlocks` 카운터가 우상향이면 재시도가
덮고 있는 구조적 원인이 있다는 뜻이므로 §5-1로 돌아간다.

## 6. 트레이드오프 양면 조립 — 처방마다 "얻는 것 / 내주는 것"

한쪽 면만 말하는 습관을 깨기 위해 위 처방 각각을 두 면으로 나란히 둔다.
면접에서 처방을 하나 고르면 반드시 **오른쪽 열까지 한 호흡에** 말한다.

| 처방 | 얻는 것 | 내주는 것 |
|---|---|---|
| 앵커 행 락 (§5-1 ①) | 갭 락 소멸, 사용자 단위 직렬화로 의도가 명확 | 부모 행이 핫스팟(그 사용자의 모든 발급이 직렬화), 앵커가 반드시 존재해야 함 |
| 유니크 제약 + INSERT 시도 (§5-1 ②) | 락 문장 자체가 없음, 모든 진입 경로를 DB가 방어 | 예외 기반 흐름, rollback-only 처리 필요, 친절한 메시지는 별도 UX 처리 |
| 단일 UPSERT 문장 (§5-1 ③) | 라운드트립 1회, S 락 승격 경쟁 없음 | AUTO_INCREMENT 소모, 영속성 컨텍스트 우회, 벤더 종속 구문 |
| RC로 낮추기 (§5-2) | 검색·스캔 갭 락 전부 소멸, 쓰기 동시성 상승 | phantom 허용, 중복 검사 갭 락은 남음, ROW 바이너리 로그 필요, 합류 트랜잭션엔 미적용 |
| 재시도 (§5-4) | 일시적 데드락을 사용자 실패로 노출하지 않음 | 처리량 저하, 멱등성 요구, 구조적 원인을 숨김 |

갭 락 자체의 양면도 같은 방식으로 말한다. **얻는 것**은 RR에서 잠금 읽기가
phantom 없이 "범위 전체를 소유"할 수 있다는 보장(범위 재고 예약, 순번 채번
같은 로직에 필요). **내주는 것**은 §2-3의 사슬 — 무관한 INSERT 대기, 데드락
가능성, 트랜잭션 장기화. "갭 락은 나쁘다"가 아니라 "이 보장이 필요 없는
곳에서 비용만 내고 있지 않은가"가 판단 기준이다.

## 7. 꼬리질문 대비 포인트

### "갭 락끼리 충돌하지 않는다면서 왜 데드락이 나죠?"

갭 락의 유일한 목적이 "이 구간에 INSERT 금지"라서, 두 트랜잭션이 같은 갭을
잠그는 건 같은 주장을 두 번 하는 것이라 충돌할 이유가 없다. 충돌은 **INSERT가
잡는 인서트 인텐션 락이 남의 갭 락을 만날 때**만 일어난다. 그래서 순서가
"둘 다 잠그기 성공(호환) → 둘 다 넣기 시도 → 각자 상대의 갭 락에 막힘(순환)"이
된다. 레코드 락이었다면 두 번째 트랜잭션이 잠그는 단계에서 이미 대기해
직렬화됐을 것이다 — 갭 락이 호환이라는 성질이 "잠갔다고 믿는 두 트랜잭션"을
만들고, 그 믿음이 INSERT에서 깨진다.

### "READ COMMITTED로 낮추면 해결되나요?" (시니어 변별 포인트)

패턴에 따라 다르다. 검색·스캔의 갭 락은 RC에서 꺼지므로 **패턴 A(없는 행
FOR UPDATE + INSERT)** 는 사라진다. 그러나 **유니크 중복 검사와 외래 키 검사의
갭 락은 RC에서도 남으므로 패턴 B(INSERT만의 S 락 데드락)** 는 그대로 난다.
그리고 대가가 있다 — phantom을 허용하므로 "범위를 잠갔다"는 가정 위의 로직이
깨지고, 바이너리 로그는 ROW 포맷이어야 하며, 트랜잭션 단위 지정은 새
트랜잭션을 여는 쪽에서만 유효하다. 그래서 순서는 "먼저 §4 로그로 패턴 분류 →
패턴 A이고 그 트랜잭션에 phantom 방지 의존이 없다면 트랜잭션 단위 RC는 유효한
카드 → 그래도 1순위는 없는 행을 잠그지 않는 설계"다.

### "데드락 로그에 INSERT 한 줄만 찍혀 있으면 원인을 어떻게 찾나요?"

로그의 SQL은 **대기 중이던 마지막 문장**일 뿐, 그 트랜잭션이 앞에서 실행한
문장은 나오지 않는다. 대신 `HOLDS THE LOCK(S)`의 락 모드가 앞 문장의 흔적이다:
`locks gap before rec`가 있으면 INSERT 이전에 갭 락을 잡는 잠금 읽기(FOR
UPDATE / UPDATE / DELETE)가 있었다는 뜻이고, `lock mode S`면 유니크 중복 검사
경로다. 여기서 인덱스 이름을 얻어, 코드의 해당 트랜잭션 경계 안에서 그
인덱스를 조건으로 쓰는 잠금 문장을 찾는다. 확신이 안 서면 §5-3처럼 재현하면서
`performance_schema.data_locks`로 t2 상태를 직접 본다. 마지막 1건만 남으므로
`innodb_print_all_deadlocks`를 켜 두는 것이 운영 습관이다.

### "`SELECT ... FOR UPDATE`의 WHERE가 인덱스를 못 타면 어떻게 되나요?"

InnoDB는 클러스터드 인덱스를 처음부터 끝까지 스캔하며 지나가는 **모든
레코드와 모든 갭에 넥스트 키 락**을 잡는다. 사실상 테이블 락이다. RR에서는
조건에 안 맞는 행의 락도 트랜잭션 끝까지 풀리지 않는다(RC는 안 맞는 행의 락을
즉시 해제하지만 스캔 자체는 한다). 결과는 §2-3 사슬의 최악 버전 — 그
테이블로의 모든 INSERT·UPDATE가 이 트랜잭션이 끝날 때까지 대기 → 커넥션 풀
고갈. 잠금 읽기는 배포 전 `EXPLAIN`으로 인덱스 사용을 확인하는 것이
규칙이어야 한다.

### "락 순서를 통일하면 되지 않나요?" (시니어 변별 포인트)

3장에서 다룬 순서 역전 데드락(A: 재고 → 포인트, B: 포인트 → 재고)에는 맞는
처방이다. 그러나 갭 락 데드락은 **두 트랜잭션이 같은 자원(같은 갭)을 같은
순서로 잠갔는데도** 난다 — 갭 락이 호환이라 첫 단계에서 상호 배제가 성립하지
않기 때문이다. 순서로는 못 막고, 잠금 대상을 **갭이 아닌 존재하는 레코드**로
바꾸거나(앵커 행), 잠금 문장 자체를 없애야(유니크 제약 + INSERT / 단일 UPSERT)
한다. 이 차이를 말할 수 있으면 "데드락 = 락 순서 문제"라는 한 가지 모델만
가진 사람과 구분된다.

---

## 한 줄 요약

InnoDB의 락은 인덱스 레코드와 그 사이의 갭에 걸리고, 갭 락은 INSERT 차단이
유일한 목적이라 갭 락끼리는 호환되지만 INSERT의 인서트 인텐션 락은 남의 갭
락에 막힌다 — 그래서 RR에서 없는 행(또는 범위)을 FOR UPDATE/UPDATE로 잠근 두
트랜잭션이 각자 그 갭에 INSERT하면 "둘 다 잠그기 성공, 둘 다 넣기 실패"의
순환이 생기고(유니크 중복 검사의 공유 락 경로는 RC에서도 남는다), 진단은
`LATEST DETECTED DEADLOCK`의 HOLDS/WAITING 락 모드 서명(`gap before rec` +
`insert intention`)을 교차 대조하는 것이며, 처방은 격리 수준 조정이나 락
순서가 아니라 "없는 행을 잠그지 않는 설계(앵커 행 락 · 유니크 제약+INSERT ·
단일 UPSERT)"에 트랜잭션 밖의 상한·지터 있는 재시도와 Testcontainers 위의
래치 재현 테스트를 안전망으로 얹는 것이다.
