# 트랜잭션 격리 수준 4가지와 이상 현상 — PostgreSQL에서 "같은 걸 두 번 읽었는데 값이 다른" 문제의 지도

> 핵심 관전 포인트: **격리 수준은 "동시에 도는 다른 트랜잭션의 변경이 나에게 얼마나 보이는가"를 4단계로 정한 SQL 표준이고, 각 단계는 허용하는 이상 현상(dirty read / non-repeatable read / phantom read)으로 정의된다. 세 현상의 구분 — 커밋 안 된 걸 읽음 / 같은 행의 값이 바뀜(UPDATE) / 행 개수가 바뀜(INSERT·DELETE) — 이 1차 변별 포인트다. PostgreSQL은 이 표준을 **MVCC 스냅샷으로 구현한 3단계**로 제공한다 — 기본 **READ COMMITTED**(문장마다 새 스냅샷), **REPEATABLE READ**(트랜잭션 스냅샷 고정 = 스냅샷 격리라 phantom까지 안 보이지만, 갱신 충돌은 `40001`로 실패시키고 **write skew는 못 막음**), **SERIALIZABLE**(SSI — 락으로 막지 않고 의존성을 추적해 `40001`로 abort → **재시도 루프 필수**). READ UNCOMMITTED는 문법만 있고 RC로 동작한다. 여기에 "쓰기 충돌 같은 국소 문제를 격리 수준 올리기로 풀면 안 되는 이유"까지 가면 시니어 답변이다.**

---

## 0. 질문 + 의도

**질문**: "트랜잭션 격리 수준 4가지와 각각에서 발생 가능한 문제(dirty read, non-repeatable read, phantom read)를 설명해주세요."

**출제 의도**: 격리 수준은 "정합성 버그가 재현 안 되는 이유"의 단골 원인이다. non-repeatable read를 모르면 "같은 트랜잭션에서 두 번 읽었는데 값이 달라요" 라는 버그 리포트 앞에서 코드만 백날 들여다본다 — PostgreSQL 기본이 READ COMMITTED라 이 현상은 **기본 설정에서 정상 동작**이다. 동시성 버그를 "스냅샷을 언제 찍는가" 관점에서 진단할 수 있는지, `40001` 직렬화 실패를 "DB 장애"가 아니라 "재시도하라는 신호"로 읽을 수 있는지 확인하는 질문이다.

이 문서는 질문지에 번호로 실려 있는 문항은 아니지만, 4장의 다른 문항들이 **전제로 삼는 기반 문서**다. MVCC의 부품(`xmin`/`xmax`·스냅샷·VACUUM)은 [11-mvcc-postgresql.md](11-mvcc-postgresql.md)가, 팬텀을 락으로 막는 방식과 그 부재는 [12-gap-lock-next-key-lock-deadlock.md](12-gap-lock-next-key-lock-deadlock.md)가, 긴 스냅샷이 만드는 운영 비용은 [16-long-transaction-harm-and-shortening.md](16-long-transaction-harm-and-shortening.md)가 다룬다. 이 문서는 그 사이에서 **"수준을 올리면 무엇이 사라지고 무엇을 대신 치르는가"** 의 지도 역할을 한다.

세 절의 구성은 이렇다. **§1은 "격리 수준이 무엇을 정하는 규칙인가"** — 눈금의 의미와 세 이상 현상을 두 트랜잭션의 타임라인으로. **§2는 "교과서와 PostgreSQL의 실체가 어디서 갈리는가"** — 이 문항의 변별 포인트가 전부 여기 있다. **§3은 "그래서 스프링 코드에 무엇을 쓰는가"** — `@Transactional(isolation = ...)`의 함정과 `40001` 재시도.

---

## 1. 개념 — 격리 수준이 정하는 것과, 세 가지 이상 현상

### 1-1. 격리 수준은 "남의 중간 상태가 나에게 얼마나 보이는가"의 눈금이다

ACID의 I(Isolation, 격리성)는 "동시에 실행되는 트랜잭션들이 서로 없는 것처럼 보이게 한다"는 성질이다. 이 성질을 완벽하게 지키는 방법은 사실 이미 알려져 있다 — **전부 한 줄로 세워 순서대로 실행하면 된다.** 그러면 서로의 중간 상태를 볼 일이 아예 없다. 문제는 그렇게 하면 동시성이 죽는다는 것이다. 수십 개의 요청이 동시에 들어와도 한 번에 하나씩만 처리하는 DB가 된다.

그래서 SQL 표준은 **"완벽한 격리에서 얼마나 양보할 것인가"를 4단계로 정의**했다. 이것이 격리 수준이다. 정의하는 방식이 독특한데, "이 수준은 이렇게 동작한다"가 아니라 **"이 수준에서는 이런 이상 현상까지는 일어날 수 있다"** 로 규정한다. 구현 방법은 DB에 맡기고 **관찰 가능한 결과만 규정**한 것이다 — §2에서 PostgreSQL이 표준과 다르게 동작하는 이유가 여기서 나온다.

한 줄로 정리하면 이렇다. **격리 수준이란 "동시에 도는 다른 트랜잭션의 아직 끝나지 않은 작업이 내 눈에 얼마나 보이는가"의 눈금이고, 눈금을 올릴수록 이상 현상은 줄지만 동시성 비용이 오른다.**

| 수준 | 남의 중간 상태가 보이는 정도 | 그 대가로 내가 치르는 비용 |
|---|---|---|
| READ UNCOMMITTED | 아직 커밋도 안 된 값까지 보인다 | 거의 없다 (그래서 표준이 허용해 둔 것) |
| READ COMMITTED | 커밋된 것만 보이되, **문장마다 최신 상태**로 갱신된다 | 문장마다 스냅샷을 새로 계산 |
| REPEATABLE READ | **내 트랜잭션이 본 시점의 세상**이 끝까지 고정된다 | 그 시점의 옛 버전을 계속 보존해야 한다(bloat) + 갱신 충돌 시 실패 |
| SERIALIZABLE | 순차 실행한 것과 구별할 수 없다 | 의존성 추적 메모리 + 오탐을 포함한 실패·재시도 |

"동시성 비용"이라는 말이 추상적으로 들리면 마지막 열을 보면 된다. **수준을 올려서 사는 것은 "일관성"이고, 그 값으로 내는 것은 "옛 버전 보존 비용"과 "실패 확률"이다.** 이 교환 관계를 첫 문장으로 말할 수 있으면 나머지는 세부 사항이다.

### 1-2. 표준의 4단계 × 이상 현상 매트릭스 — 이 표가 답변의 뼈대

| 격리 수준 | Dirty Read | Non-Repeatable Read | Phantom Read |
|---|---|---|---|
| READ UNCOMMITTED | 발생 가능 | 발생 가능 | 발생 가능 |
| READ COMMITTED | 방지 | 발생 가능 | 발생 가능 |
| REPEATABLE READ | 방지 | 방지 | 발생 가능 |
| SERIALIZABLE | 방지 | 방지 | 방지 |

표가 계단 모양인 데는 이유가 있다. 세 현상은 **막기가 점점 어려운 순서**로 나열돼 있다 — 커밋 안 된 값을 안 보여주는 것이 가장 쉽고, 이미 읽은 행이 안 바뀌게 하는 것이 그다음이고, **아직 존재하지도 않는 행이 나타나지 않게 하는 것**이 가장 어렵다(1-6에서 왜 그런지 설명한다). 그래서 표준은 "여기까지는 막고 그다음부터는 허용"이라는 선을 네 군데 그은 것이다.

아래 세 절은 각 현상을 **두 트랜잭션 × 시간축**의 타임라인으로 본다. 세 현상 모두 "트랜잭션 A가 읽는 중에 트랜잭션 B가 끼어드는" 같은 구조이고, 차이는 **B가 무엇을 했고 A에게 무엇이 다르게 보이는가**뿐이다. 그래서 타임라인으로 보면 셋을 헷갈릴 일이 없어진다.

### 1-3. 이상 현상 ① Dirty Read — 커밋 안 된 데이터를 읽음

```text
시간 →
Tx A                              Tx B
                                  UPDATE 잔액 = 0 (아직 커밋 안 함)
SELECT 잔액 → 0 을 읽음  ← 더티 리드
                                  ROLLBACK (없던 일이 됨)
A는 "세상에 존재한 적 없는 값"을 근거로 로직을 진행
```

B가 롤백하면 잔액 0은 **한 번도 확정된 적 없는 값**인데, A는 그걸 읽고 "잔액 부족" 판정을 내려버릴 수 있다. 다른 두 현상은 적어도 "어느 시점엔가는 진짜였던 값"을 읽는 데 비해, 더티 리드만은 **거짓을 읽는다.** 가장 위험한 현상이라 표준도 READ UNCOMMITTED에서만 허용한다.

**PostgreSQL에서는 원천적으로 불가능하다.** B가 만든 새 튜플 버전의 `xmin`(그 버전을 만든 트랜잭션 ID)은 아직 커밋되지 않은 B의 트랜잭션 ID라, A의 스냅샷이 "이 트랜잭션은 아직 안 끝났다"고 판정해 걸러낸다([11-mvcc-postgresql.md](11-mvcc-postgresql.md)). 즉 PG는 더티 리드를 "금지"하는 게 아니라 **구조적으로 만들 수가 없다.** 그래서 READ UNCOMMITTED를 요청해도 조용히 READ COMMITTED로 돈다(2-1).

### 1-4. 이상 현상 ② Non-Repeatable Read — 같은 행을 두 번 읽었는데 값이 다름 (UPDATE)

```text
시간 →
Tx A (READ COMMITTED)             Tx B
SELECT 잔액 WHERE id=1 → 10,000   ← 문장 1의 스냅샷
                                  UPDATE 잔액 = 5,000 WHERE id=1
                                  COMMIT
SELECT 잔액 WHERE id=1 → 5,000    ← 문장 2의 새 스냅샷: B의 커밋이 보인다
```

읽은 값 자체는 둘 다 "커밋된 정상 값"이다. 어느 쪽도 거짓이 아니다. 문제는 **한 트랜잭션 안에서 같은 행을 다시 읽었을 때 결과가 달라진다**는 것 — "잔액을 확인하고, 그 값을 전제로 계산하고, 다시 확인해서 검증한다"는 식의 로직이 중간에 무너진다. 이름이 non-repeatable(반복 불가능)인 이유가 이것이다: **같은 읽기를 반복했을 때 같은 답이 나오지 않는다.**

PostgreSQL 기본인 READ COMMITTED는 **문장(statement)마다 스냅샷을 새로 찍으므로** 이 현상이 그대로 일어난다 — 버그가 아니라 사양이다. REPEATABLE READ는 첫 문장의 스냅샷을 끝까지 재사용하므로 두 번째 SELECT도 10,000을 돌려준다. 이름이 곧 보장 내용인 셈이다.

### 1-5. 이상 현상 ③ Phantom Read — 같은 조건으로 두 번 조회했는데 행 개수가 다름 (INSERT/DELETE)

```text
시간 →
Tx A (READ COMMITTED)             Tx B
SELECT * WHERE 급여 > 500 → 3건
                                  INSERT 급여=600 인 직원 추가
                                  COMMIT
SELECT * WHERE 급여 > 500 → 4건  ← 유령(phantom) 행이 나타났다
```

없던 행이 유령처럼 나타난다고 해서 phantom(유령)이라는 이름이 붙었다. A가 처음 조회했을 때 그 행은 **세상에 존재하지도 않았으므로**, A는 그 행에 대해 아무것도 할 수 없었다 — 잠글 수도, 기억할 수도 없었다. 이 "손댈 대상 자체가 없었다"는 점이 다음 절의 핵심이다.

### 1-6. 두 축으로 가르기 — non-repeatable read와 phantom read는 무엇이 다른가

면접에서 실제로 갈리는 지점이 여기다. 두 현상을 **두 개의 축**으로 나누면 헷갈리지 않는다.

| | Non-Repeatable Read | Phantom Read |
|---|---|---|
| **무엇이 바뀌는가** | 이미 읽었던 **기존 행의 값** | 같은 **조건(범위)에 걸리는 행의 개수** |
| **원인이 되는 연산** | **UPDATE** | **INSERT / DELETE** |
| 내 눈에 보이는 증상 | "아까 10,000이었는데 지금 5,000" | "아까 3건이었는데 지금 4건" |
| 막으려면 무엇을 잠가야 하나 | **그 행** — 대상이 존재한다 | **아직 없는 행** — 잠글 대상이 없다 |

**왜 굳이 따로 구분하나 — 락으로 막으려 하면 난이도가 완전히 다르기 때문이다.** 기존 행의 변경은 그 **행에 락**을 걸면 막힌다. 대상이 눈앞에 있으니 잠그면 그만이다. 그런데 "아직 존재하지 않는 행의 INSERT"는 잠글 대상이 없다. 존재하지 않는 것에는 락을 걸 수 없다. 그래서 표준은 REPEATABLE READ까지도 phantom을 허용하는 선을 그었다 — 그 시절의 구현 기술로는 막는 비용이 너무 컸던 것이다.

**PostgreSQL은 이 문제를 락이 아니라 스냅샷으로 우회한다.** REPEATABLE READ에서는 B의 INSERT가 커밋돼도 그 커밋이 A의 스냅샷보다 나중이라 **A의 눈에 애초에 보이지 않는다.** 잠글 필요 없이 "안 보이게" 하면 되는 것이다. 그래서 PG의 REPEATABLE READ는 표준보다 강하다(2-1).

대신 PG에는 **존재하지 않는 행이나 범위를 잠그는 수단 자체가 없다** — MySQL의 갭 락에 해당하는 장치가 없다는 뜻이다. "조회해서 없으면 INSERT" 경쟁은 격리 수준이 아니라 UNIQUE 제약 + `ON CONFLICT`, advisory lock, 또는 SERIALIZABLE의 몫이다([12-gap-lock-next-key-lock-deadlock.md](12-gap-lock-next-key-lock-deadlock.md)).

> MySQL 대조: InnoDB는 반대로 **락으로** 푼다 — 잠금 읽기(`FOR UPDATE`, UPDATE/DELETE)가 조건 범위에 갭 락·넥스트 키 락을 걸어 INSERT를 차단한다. phantom 방지의 대가가 PG는 스냅샷 유지 비용, MySQL은 락 대기·데드락이다.

### 1-7. (가산점 포인트) 네 번째 현상 — Write Skew: 각자 다른 행을 고쳤는데 규칙이 깨진다

표준의 세 현상만으로는 설명되지 않는 현상이 하나 더 있다. 이름은 **write skew(쓰기 왜곡)** 이고, PostgreSQL 매뉴얼은 이것을 포함한 범주를 **직렬화 이상(serialization anomaly)** 이라고 부른다 — "순차 실행이었다면 절대 나올 수 없는 결과"라는 뜻이다.

규칙: **"당직 의사는 항상 1명 이상."** 현재 Alice, Bob 둘 다 당직 중이다.

```text
시간 →
Tx A (Alice, REPEATABLE READ)              Tx B (Bob, REPEATABLE READ)
SELECT count(*) WHERE on_call → 2
  ("나 빠져도 1명 남네")
                                           SELECT count(*) WHERE on_call → 2
                                             ("나 빠져도 1명 남네")
UPDATE doctors SET on_call = false
 WHERE name = 'Alice'
                                           UPDATE doctors SET on_call = false
                                            WHERE name = 'Bob'
COMMIT                                     COMMIT
결과: 당직 0명. 두 트랜잭션 모두 각자의 스냅샷 안에서는 완벽하게 옳았다.
```

이 현상이 왜 세 현상 어디에도 안 들어가는지 하나씩 확인해 보면 구조가 보인다. **non-repeatable read가 아니다** — A가 읽은 값(count=2)은 A의 트랜잭션이 끝날 때까지 한 번도 변하지 않았다. **phantom read도 아니다** — A의 눈에 행이 나타나거나 사라지지도 않았다. **REPEATABLE READ의 갱신 충돌 감지에도 안 걸린다**(2-4) — 두 트랜잭션이 **서로 다른 행**을 갱신했기 때문이다. A는 Alice 행을, B는 Bob 행을 고쳤으니 충돌할 행이 없다.

그런데 순차 실행이었다면 두 번째 트랜잭션은 count=1을 보고 멈췄어야 한다. **읽은 것과 쓴 것이 서로 엇갈렸기 때문에**(A는 Bob을 읽고 Alice를 썼고, B는 Alice를 읽고 Bob을 썼다) 순차 실행으로는 설명되지 않는 결과가 나온 것이다. 이것을 DB 차원에서 막는 것은 **SERIALIZABLE뿐**이다(2-5).

격리 수준을 안 올린다면 처방은 하나다 — 두 트랜잭션이 **같은 행**을 두고 경쟁하게 만들어야 한다. 병동 행에 `FOR UPDATE`를 걸거나, `pg_advisory_xact_lock(병동ID)`으로 논리적인 자물쇠를 하나 만들어 그 앞에 줄을 세운다. **"충돌 지점이 없으면 만들어 준다"** 가 이 처방의 요지다.

---

## 2. 동작 — 교과서와 PostgreSQL의 실체 (시니어 변별 포인트)

### 2-1. PostgreSQL이 실제로 구현한 모습 — 사실상 3단계

이 절이 이 문항의 변별 포인트다. **표준의 정의**와 **특정 DB의 구현**을 분리해 말할 수 있는지가 갈린다. PostgreSQL 매뉴얼은 1-2의 표에 열 하나를 더 붙인다 — 표준 셋으로는 설명이 안 되는 네 번째 현상, **직렬화 이상**(1-7)이다.

| 요청한 수준 | 실제 동작 | Dirty | Non-Repeatable | Phantom | 직렬화 이상 |
|---|---|---|---|---|---|
| READ UNCOMMITTED | **READ COMMITTED로 동작** | 불가 | 가능 | 가능 | 가능 |
| READ COMMITTED (**기본**) | 문장마다 새 스냅샷 | 불가 | 가능 | 가능 | 가능 |
| REPEATABLE READ | 트랜잭션 스냅샷 고정 | 불가 | 불가 | **불가**(표준보다 강함) | 가능 |
| SERIALIZABLE | SSI — 의존성 추적 후 abort | 불가 | 불가 | 불가 | 불가 |

교과서와 다른 지점이 셋이고, 각각에 근거가 있다.

**① READ UNCOMMITTED를 요청해도 READ COMMITTED로 동작한다 — dirty read가 아예 없다.** 근거는 1-3에서 봤다. PG의 읽기는 스냅샷 판정을 거치는데, 커밋되지 않은 트랜잭션이 만든 튜플 버전은 그 판정을 통과할 방법이 없다. 즉 "더티 리드를 허용하는 코드 경로"가 존재하지 않는다. 문법은 받아 주되 실제로는 한 단계 위로 올려 실행하는 것이고, 이는 표준이 허용하는 동작이다 — 표준은 "그 수준에서 이 현상까지 **일어날 수 있다**"고 정할 뿐 "반드시 일어나야 한다"고 정하지 않기 때문이다.

**② REPEATABLE READ가 표준과 달리 팬텀까지 막는다 — 그래서 write skew만 남는다.** 근거는 1-6에서 봤다. PG는 팬텀을 락으로 막는 대신 **트랜잭션 스냅샷을 고정**해 "나중에 커밋된 INSERT는 애초에 안 보이게" 한다. 스냅샷을 고정하면 값 변화(non-repeatable)와 행 수 변화(phantom)가 **같은 원리로 한꺼번에** 사라진다 — 둘 다 "내 스냅샷 이후의 커밋"이기 때문이다. 학계에서 이 수준을 부르는 이름이 따로 있는데 **스냅샷 격리(Snapshot Isolation)** 다. 그리고 스냅샷 격리에 남는 유일한 구멍이 write skew이므로, **PG의 REPEATABLE READ에 남는 이상 현상은 write skew 하나뿐**이라고 말할 수 있다.

**③ SERIALIZABLE은 사전 차단이 아니라 사후 감지다 — 그래서 `40001` 재시도가 필수다.** 교과서의 SERIALIZABLE은 "읽는 것마다 공유 락을 걸어 아무도 못 바꾸게" 하는 방식, 즉 **사전 차단**이다. PG는 반대로 일단 다 진행시킨 뒤 "이 조합은 순차 실행으로 설명이 안 된다"고 판정되면 한쪽을 죽인다. 자세한 동작은 2-5에 있고, 여기서 기억할 것은 하나다 — **SERIALIZABLE을 켜면 트랜잭션이 실패할 수 있고, 실패를 다루는 코드가 없으면 그 설정은 켠 게 아니라 망가뜨린 것이다.**

세 수준의 차이를 한 문장으로 압축하면 **"스냅샷을 언제 찍고, 충돌을 어떻게 처리하는가"** 다. RC는 문장마다 찍고 충돌 시 최신 행을 다시 읽는다. RR은 첫 문장에서 한 번 찍고 충돌 시 실패시킨다. SERIALIZABLE은 RR 스냅샷 위에서 읽기/쓰기 의존성까지 추적해 "순차 실행과 다를 가능성"까지 실패시킨다.

### 2-2. 실무 기본값 — 내가 쓰는 DB의 기본값을 아는가

| DB | 기본 격리 수준 |
|---|---|
| **PostgreSQL** | **READ COMMITTED** |
| Oracle | READ COMMITTED |
| SQL Server | READ COMMITTED |
| MySQL (InnoDB) | REPEATABLE READ (예외) |

"우리 서비스 DB의 기본 격리 수준이 뭔지 아는가"는 실무 감각을 보는 단골 확인 질문이다. PostgreSQL이라면 `SHOW transaction_isolation;`(지금 이 트랜잭션의 수준), `SHOW default_transaction_isolation;`(세션 기본값)으로 확인한다. 이 두 명령이 다른 값을 돌려줄 수 있다는 것 자체가 3-1의 함정으로 이어진다.

### 2-3. READ COMMITTED — 문장마다 새 스냅샷, 갱신은 최신 버전을 다시 읽는다

SELECT는 **문장 시작 시점**의 스냅샷을 쓴다. 문장 하나가 아무리 오래 돌아도 그 안에서는 일관되고, 다음 문장은 새 스냅샷이다. "일관성의 단위가 트랜잭션이 아니라 문장"이라고 기억하면 정확하다.

쓰기에는 규칙이 하나 더 있다. UPDATE/DELETE/`FOR UPDATE`가 찾은 행을 **다른 트랜잭션이 갱신 중**이면 그 트랜잭션이 끝날 때까지 기다렸다가, 커밋됐으면 **최신 버전으로 WHERE 조건을 다시 평가해** 여전히 맞으면 그 최신 버전에 적용한다. 여기서 "다시 평가한다"가 중요하다 — 내 스냅샷에는 옛 버전이 보였지만, 쓰기만큼은 최신 버전을 대상으로 한다.

```sql
-- 원자적 UPDATE: RC에서도 유실되지 않는다 (stock = 10, A·B 동시 실행)
UPDATE item SET stock = stock - 1 WHERE id = 1;
-- B는 A의 커밋을 기다렸다가 최신 버전(9)을 읽어 8로 만든다. 결과 8.

-- 읽고-계산하고-쓰기: RC에서 갱신 유실(lost update)
-- A: SELECT stock → 10             B: SELECT stock → 10
-- A: UPDATE ... SET stock = 9      B: (대기 후) UPDATE ... SET stock = 9
-- 결과 9. 차감 한 건이 사라졌다. WHERE id = 1은 여전히 참이라 재평가도 못 잡는다.
```

두 번째 경우를 **갱신 유실(lost update)** 이라 부른다. B가 계산에 쓴 값(10)은 이미 낡았는데, WHERE 조건이 `id = 1`이라 재평가를 해도 여전히 참이므로 DB는 이상을 눈치채지 못한다. **DB는 "내가 계산의 근거로 삼은 값이 무엇이었는지"를 모르기 때문**이다 — 그 정보는 애플리케이션 메모리에만 있다.

그래서 RC의 보장 범위를 한 줄로 정리하면 이렇다. **RC는 문장 안의 정합성만 보장하고, 문장 사이에 애플리케이션이 들고 있는 값은 모른다.** 2-7의 "한 문장으로 넣어라"가 RC 기본에서 제일 싼 처방인 이유다.

### 2-4. REPEATABLE READ — 스냅샷 격리, 그리고 스냅샷은 BEGIN이 아니라 첫 문장에서 찍힌다

RR은 트랜잭션의 **첫 번째 문장** 시점에 스냅샷을 찍고 끝까지 재사용한다. 교과서보다 강한 이유는 "락을 더 잡아서"가 아니라 **"세상을 한 시점에 고정해서"** 다(2-1의 ②).

**여기서 실무에서 가장 자주 틀리는 지점이 스냅샷을 찍는 시점이다.** `BEGIN`이 아니라 **첫 문장을 실행하는 순간**이다. `BEGIN`이나 `SET TRANSACTION` 같은 트랜잭션 제어 명령만으로는 스냅샷이 잡히지 않는다.

```text
시간 →
  BEGIN ISOLATION LEVEL REPEATABLE READ;
  │
  │   ← 이 구간에서 다른 트랜잭션이 커밋한 것은 내게 "보인다"
  │      (아직 스냅샷을 안 찍었으므로)
  │      애플리케이션이 여기서 외부 API를 3초 기다렸다면, 그 3초 동안의
  │      남의 커밋은 전부 내 스냅샷에 포함된다
  ▼
  SELECT ... ;   ← 여기서 스냅샷이 찍힌다. 이 시점의 세상이 끝까지 고정
  │
  │   ← 이 이후 남이 커밋한 것은 내게 절대 보이지 않는다
  ▼
  COMMIT;
```

왜 이 차이가 실무에서 문제가 되는가. 정산 배치가 "BEGIN 시점의 데이터를 본다"고 믿고 코드를 짜면, `BEGIN`과 첫 SELECT 사이에 낀 준비 작업(설정 조회, 외부 호출, 파일 읽기) 시간만큼 **기준 시점이 뒤로 밀린다.** 반대로 "여러 SELECT가 같은 시점을 봐야 한다"는 요건이라면, 첫 SELECT를 언제 던지는지가 곧 기준 시각을 정하는 행위이므로 그것을 의도적으로 통제해야 한다.

**쓰기에는 "먼저 커밋한 쪽이 이긴다(first-committer-wins)"는 규칙이 붙는다.** 내 스냅샷 이후에 남이 갱신·커밋한 행을 내가 UPDATE/DELETE/`FOR UPDATE`하려 하면, RC처럼 최신 버전을 다시 읽는 게 아니라 **트랜잭션을 실패시킨다.**

```text
ERROR:  could not serialize access due to concurrent update
SQLSTATE 40001 (serialization_failure)
```

이 규칙 덕분에 2-3의 read-modify-write를 RR로 돌리면 B의 UPDATE가 이 에러로 죽는다 — **갱신 유실이 "조용히 발생"에서 "명시적 실패"로 바뀐다.** 얻는 것은 "틀린 결과 대신 에러"이고, 내는 것은 **애플리케이션이 재시도를 책임져야 한다**는 것이다(§3).

RR의 한계 둘도 함께 외운다. **① write skew는 못 잡는다** — 서로 **다른 행**을 갱신하면 충돌할 행이 없으므로 first-committer-wins가 발동하지 않는다(1-7). 스냅샷 격리의 유명한 구멍이다. **② 스냅샷을 오래 붙들면 그 사이 생긴 죽은 튜플을 VACUUM이 못 치운다** — 내가 아직 옛 버전을 볼 권리가 있으므로 아무도 지울 수 없다(`pg_stat_activity.backend_xmin`이 그 기준선을 잡고 있다). 리포트성 롱 트랜잭션을 RR로 돌릴 때의 비용은 락이 아니라 **bloat**다([16-long-transaction-harm-and-shortening.md](16-long-transaction-harm-and-shortening.md)).

> MySQL 대조: InnoDB RR은 UPDATE를 **최신 버전에 조용히 적용**하고 `40001` 같은 실패가 없다 — 그래서 일반 SELECT(스냅샷)와 잠금 읽기(최신)를 섞으면 phantom처럼 보이는 결과가 난다. PG RR은 그 순간을 에러로 드러낸다.

### 2-5. SERIALIZABLE — SSI는 사전 차단이 아니라 사후 감지다

교과서의 SERIALIZABLE은 "읽는 것마다 공유 락"이라 읽기끼리도 서로를 기다리고 처리량이 붕괴한다. PostgreSQL은 대신 **SSI(Serializable Snapshot Isolation, 직렬화 스냅샷 격리)** 를 쓴다.

동작을 한 문단으로 풀면 이렇다. RR과 **똑같은 스냅샷 위에서** 트랜잭션을 그냥 진행시키되, 각 트랜잭션이 **무엇을 읽었는지**를 기록해 둔다. 이 기록의 이름이 **predicate lock**(술어 락)이고 `pg_locks`에는 `SIReadLock`으로 보인다 — 이름에 lock이 붙었지만 **아무도 막지 않는 표식**이다. 그리고 "A가 읽은 것을 B가 고치고, B가 읽은 것을 A가 고쳤다" 같은 읽기/쓰기 의존성이 **순차 실행으로 설명 불가능한 모양**을 이루는 순간, 그중 한쪽을 실패시킨다.

```text
ERROR:  could not serialize access due to read/write dependencies among transactions
SQLSTATE 40001 (serialization_failure)
```

1-7의 당직 예시가 정확히 이렇게 잡힌다 — A는 Bob 행을 읽고 Alice 행을 썼고 B는 그 반대이므로, 의존성이 고리를 이룬다.

알아 둘 성질 넷.

- **① 블로킹이 없다.** 기다리게 하는 대신 죽인다. 그래서 운영의 핵심은 데드락 대응이 아니라 **재시도**이고, 재시도 루프 없는 SERIALIZABLE은 "가끔 실패하는 DB"일 뿐이다.
- **② 관련 트랜잭션 전부가 SERIALIZABLE이어야** 보장된다. 한쪽만 올려 두면 SSI가 볼 수 없는 상대가 생겨 이상 현상이 그대로 통과한다.
- **③ 오탐이 있다.** predicate lock이 메모리 한도(`max_pred_locks_per_transaction`)를 넘으면 튜플 → 페이지 → 테이블 단위로 뭉뚱그려져(락 승격), 실제로는 충돌이 아닌데도 abort될 수 있다. **"실패했다 = 정말 충돌했다"가 아니라는 것**이 재시도가 필수인 또 하나의 이유다.
- **④ 비용은 읽기 락 방식보다 훨씬 싸다.** 가산점으로, 순수 조회는 `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE`로 열면 안전한 스냅샷이 확보될 때까지 잠깐 기다린 뒤 **실패 가능성 0으로** 돈다(긴 리포트에 적합).

> MySQL 대조: InnoDB SERIALIZABLE은 모든 일반 SELECT를 `FOR SHARE`로 바꿔 읽기끼리도 기다리고 데드락이 급증한다. MySQL에서 "사실상 금기"인 수준이 PG에서는 "재시도만 갖추면 쓸 수 있는 도구"다.

### 2-6. 수준을 지정하고 확인하는 법

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;   -- 첫 문장 전에 지정 (스냅샷을 찍은 뒤엔 에러)
-- 또는 BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SHOW transaction_isolation;              -- 현재 트랜잭션의 수준
COMMIT;
ALTER ROLE report_user SET default_transaction_isolation = 'repeatable read';  -- 롤 기본값
```

첫 줄의 주석이 2-4와 이어진다. 스냅샷을 이미 찍은 뒤에는 수준을 바꿀 수 없다 — 이미 어떤 시점의 세상을 보기 시작했는데 그 규칙을 도중에 바꿀 수는 없기 때문이다. 이 제약이 3-2의 "기존 트랜잭션에 합류하면 격리 수준 지정이 안 먹는다"와 정확히 같은 이유다.

### 2-7. 격리 수준으로 풀 문제 vs 락으로 풀 문제

격리 수준을 올리는 비용을 PG 기준으로 적으면 — **RR**: 롱 스냅샷의 bloat와 갱신 충돌 `40001` 재시도. **SERIALIZABLE**: predicate lock 메모리, 오탐을 포함한 `40001` 재시도, 처리량 하락. 그래서 **"격리 수준은 읽기 일관성의 기본기, 쓰기 충돌은 락 또는 한 문장으로"** 가 실무 구분선이다.

전형적인 오답 시나리오가 재고 차감 동시성 문제다.

```sql
-- 오답: "SERIALIZABLE로 올리면 되지 않나?" → 재고와 무관한 트랜잭션까지
--       의존성 추적 대상이 되고, 피크 때 40001 재시도가 폭증한다
-- 정답 방향: 문제가 되는 그 행만 다룬다

-- 방법 A: 원자적 UPDATE (읽기-계산-쓰기를 한 문장으로) — 가장 싸다
UPDATE item SET stock = stock - 1
 WHERE id = $1 AND stock >= 1
RETURNING stock;
-- 반환 행이 없으면 재고 부족. RC에서도 유실 없음(2-3).

-- 방법 B: 비관적 락 (그 행만 잠그고 읽은 뒤 검증·부가 로직)
SELECT stock FROM item WHERE id = $1 FOR NO KEY UPDATE;
UPDATE item SET stock = stock - 1 WHERE id = $1;
-- FOR UPDATE가 아니라 FOR NO KEY UPDATE인 이유: 키를 안 바꾸는 갱신이라
-- 이 행을 참조하는 자식 INSERT(FK의 KEY SHARE)를 막지 않는다 (가산점)

-- 방법 C: 낙관적 락 (버전 컬럼, 충돌 시 재시도) — JPA @Version이 만드는 문장
UPDATE item SET stock = 9, version = version + 1
 WHERE id = $1 AND version = 5;
-- 갱신 0건이면 누가 먼저 바꾼 것 → 다시 읽고 재시도
```

원리를 한 문장으로 하면 이렇다. 격리 수준은 "트랜잭션 전체가 세상을 얼마나 일관되게 보는가"라는 **광역 설정**이고, 재고 차감은 "이 행 하나의 갱신 충돌"이라는 **국소 문제**다. 국소 문제를 광역 설정으로 풀면 무관한 트랜잭션까지 비용을 치른다 — 이 구분을 말할 수 있으면 시니어 답변이 된다.

반대로 **SERIALIZABLE이 맞는 자리**도 있다. 1-7처럼 불변식이 **여러 행에 걸쳐** 있어서 "어느 행을 잠가야 하는지" 자체가 애매하고, 트랜잭션이 짧고, 재시도가 가능한 곳이다. **잠글 대상이 분명하면 락, 애매하면 SERIALIZABLE** 이 판별 기준이다.

### 2-8. 세 수준의 선택 기준 (암기)

| 상황 | 수준 | 이유 |
|---|---|---|
| 일반 OLTP 대부분 | READ COMMITTED (기본) | 문장 단위 일관성 + 원자적 UPDATE/행 락으로 충분 |
| 여러 문장이 **같은 시점**을 봐야 하는 조회(리포트·정산 검증 — `pg_dump`도 이 수준) | REPEATABLE READ | 스냅샷 고정. 오래 붙들면 bloat |
| 불변식이 여러 행에 걸치고 락으로 표현이 어려움 | SERIALIZABLE + 재시도 | write skew까지 DB가 잡아 줌 |

---

## 3. 실무 — 스프링 `@Transactional(isolation = ...)` 과 `40001` 재시도

### 3-1. 지정하는 법과, 기본값이 DB마다 다르다는 함정

```java
@Transactional(isolation = Isolation.REPEATABLE_READ, readOnly = true)
public SettlementReport summarize(LocalDate day) { ... }
```

- 선택지: `Isolation.DEFAULT` / `READ_UNCOMMITTED` / `READ_COMMITTED` / `REPEATABLE_READ` / `SERIALIZABLE`
- **기본값은 `Isolation.DEFAULT`** — 스프링이 어떤 수준을 정한다는 뜻이 아니라 **DB의 기본 격리 수준을 그대로 따른다**는 뜻이다. 그래서 같은 코드가 PostgreSQL 위에서는 READ COMMITTED로, MySQL 위에서는 REPEATABLE READ로 돈다. "스프링 기본이 뭐냐"에 "READ_COMMITTED"라고 박아 답하면 틀린다. 그리고 `READ_UNCOMMITTED`를 지정해도 PG에서는 RC로 동작한다(2-1의 ①).
- 동작 방식: 트랜잭션을 시작할 때 스프링이 `Connection.setTransactionIsolation(...)`을 호출하면 pgjdbc가 격리 수준 설정 SQL(`SET ... TRANSACTION ISOLATION LEVEL ...`)을 보내고, 트랜잭션이 끝나면 스프링이 커넥션의 원래 값으로 되돌린다. HikariCP 풀에서 커넥션을 돌려쓰기 때문에 이 원복이 필요하고, 그래서 **트랜잭션 단위로 지정하는 이 방식이 정석**이다.
- 풀 전체 기본값(HikariCP `transactionIsolation`)이나 롤 기본값(`default_transaction_isolation`)을 바꾸는 것은 전체 서비스에 영향을 주는 **별개의 결정**이다. 특정 로직 하나 때문에 전역 설정을 건드리면, 그 사실을 모르는 다른 코드가 조용히 다른 수준으로 돌게 된다.

### 3-2. 조용히 무시되는 경우 vs 예외가 나는 경우

`@Transactional(isolation = ...)`을 붙였는데 안 먹는 상황은 딱 하나이고, 나머지는 조용히 넘어가지 않고 **예외로 드러난다.** 이 둘을 갈라 말할 수 있어야 한다.

**조용히 무시되는 경우 — 기존 트랜잭션에 합류할 때, 이 하나뿐이다.**

전파 속성이 `REQUIRED`(기본값)인 메서드가 **이미 열려 있는 트랜잭션 안에서** 호출되면, 새 트랜잭션을 시작하지 않고 기존 트랜잭션에 참여한다. 격리 수준은 **트랜잭션을 새로 시작하는 쪽이 정하는 것**이라(PG에서도 첫 문장 이후엔 바꿀 수 없다 — 2-6), 이미 시작된 트랜잭션의 수준은 바꿀 방법이 없다. 그래서 스프링은 기본 설정에서 이 지정을 **조용히 무시한다.**

```java
@Transactional                                    // 여기서 트랜잭션이 열린다 (DB 기본 = RC)
public void process() {
    reportService.summarize(day);                 // 아래 메서드로 진입
}

@Transactional(isolation = Isolation.REPEATABLE_READ)   // 합류이므로 이 지정은 무시된다 — RC로 돈다
public SettlementReport summarize(LocalDate day) { ... }
```

이 침묵을 깨는 스위치가 있다. 트랜잭션 매니저의 `validateExistingTransaction`을 `true`로 켜면, 요구한 격리 수준이 기존 트랜잭션과 다를 때 **`IllegalTransactionStateException`을 던진다.** 격리 수준이 중요한 코드가 있다면 이 스위치를 켜 두는 것이 "믿었는데 안 먹었다"를 막는 방법이다. 아니면 애초에 합류하지 않도록 `REQUIRES_NEW`로 새 트랜잭션을 열면 지정이 그대로 적용된다(대신 커넥션을 하나 더 쓰고, 바깥 트랜잭션과 원자성이 끊긴다).

**예외가 나는 경우 — 트랜잭션 매니저가 격리 수준을 적용할 수단이 없을 때.**

이때 나오는 것이 `InvalidIsolationLevelException`이다. 조용히 넘어가지 않고 시작 시점에 터지므로 원인을 찾기는 오히려 쉽다. 대표적인 두 경우를 알아 두면 된다.

- **JTA 환경**(`JtaTransactionManager`) — JTA 명세 자체에는 격리 수준을 지정하는 표준 API가 없어서, 스프링은 기본적으로 커스텀 격리 수준을 **거부**한다. 벤더별 방법으로 적용할 수 있게 하려면 `allowCustomIsolationLevels`를 켜야 한다.
- **전용 dialect가 없는 JPA 환경**(`JpaTransactionManager` + 기본 `JpaDialect`) — JPA 표준 API로는 JDBC 커넥션의 격리 수준을 건드릴 수 없기 때문이다. Hibernate처럼 전용 dialect가 있으면 내부 JDBC 커넥션에 적용해 주므로 정상 동작한다.

정리하면 이렇다.

| 상황 | 결과 |
|---|---|
| 새 트랜잭션 시작 + `DataSourceTransactionManager`/Hibernate | 지정한 수준이 그대로 적용된다 |
| **기존 트랜잭션에 합류**(`REQUIRED`로 join) | **조용히 무시** — `validateExistingTransaction=true`면 `IllegalTransactionStateException` |
| JTA 기본 설정 | `InvalidIsolationLevelException` — `allowCustomIsolationLevels`로 허용 가능 |
| 전용 dialect 없는 JPA | `InvalidIsolationLevelException` |
| PG에 `READ_UNCOMMITTED` 지정 | 예외 없이 받아들여지되 **RC로 동작**한다 (스프링이 아니라 DB의 결정) |

### 3-3. `40001`은 예외가 아니라 "다시 하라"는 신호 — 재시도는 트랜잭션 밖에서

RR·SERIALIZABLE을 쓰는 순간 `40001`은 장애가 아니라 **정상 운영의 일부**다. 동시성이 있는 한 반드시 발생하고, 발생했다는 것은 DB가 "이대로 두면 결과가 틀어진다"를 잡아냈다는 뜻이다.

스프링의 예외 번역은 전통적으로 PostgreSQL SQLSTATE `40001`을 `CannotSerializeTransactionException`으로, 데드락 `40P01`을 `DeadlockLoserDataAccessException`으로 바꾸며, 둘 다 `PessimisticLockingFailureException` → `ConcurrencyFailureException` → `TransientDataAccessException`(재시도하면 성공할 수 있는 일시적 실패) 계열이다. 다만 예외 번역기 구현은 스프링 버전과 JPA 경로에 따라 달라질 수 있으므로, **재시도 판정은 예외 타입보다 원인 체인의 SQLSTATE로 하는 편이 가장 견고하다.**

재시도의 위치가 이 절의 핵심이다. **재시도 단위는 항상 트랜잭션 전체**이고, 재시도 코드는 **트랜잭션 경계 바깥**에 있어야 한다.

```java
// 잘못된 위치: 트랜잭션 안에서 잡고 그 자리에서 재시도 — PG에서는 통하지 않는다.
//    에러가 난 트랜잭션은 이미 abort 상태라 이후 문장이 전부
//    "current transaction is aborted, commands ignored until end of
//     transaction block" (25P02) 로 거부된다.
```

PostgreSQL은 문장 하나가 실패하면 **트랜잭션 전체를 실패 상태로 만든다.** 그 상태에서는 COMMIT도 ROLLBACK 취급이고 다른 문장은 전부 거부되므로, "여기서 한 번 더 해보기"가 원리적으로 불가능하다. 반드시 트랜잭션을 끝내고 **처음부터 새 트랜잭션으로** 다시 시작해야 한다.

### 3-4. 재시도 코드 — 그대로 가져다 쓸 수 있는 두 가지 형태

**형태 ① spring-retry 애너테이션** — 재시도할 메서드를 트랜잭션 바깥에 하나 더 두는 방식이다.

```java
@Service
public class TransferFacade {                    // 트랜잭션이 없는 바깥 층

    private final TransferService transferService;   // 이 안이 @Transactional(SERIALIZABLE)

    public TransferFacade(TransferService transferService) {
        this.transferService = transferService;
    }

    // retryFor: 40001(직렬화 실패)과 40P01(데드락) 둘 다 "다시 하면 될 수도 있는" 실패다
    // backoff: 즉시 재시도하면 같은 상대와 또 부딪히므로 지연을 두고 지수적으로 늘린다
    @Retryable(retryFor = { CannotSerializeTransactionException.class,
                            DeadlockLoserDataAccessException.class },
               maxAttempts = 3,
               backoff = @Backoff(delay = 50, multiplier = 2, random = true))  // random: 지터
    public void transfer(long fromId, long toId, long amount) {
        transferService.transfer(fromId, toId, amount);   // 매 시도가 새 트랜잭션
    }

    // 상한까지 실패하면 여기로 온다 — 조용히 삼키지 말고 도메인 실패로 올린다
    @Recover
    public void recover(TransientDataAccessException e, long fromId, long toId, long amount) {
        throw new TransferBusyException("동시 요청이 많아 처리하지 못했습니다", e);
    }
}
// 주의 1: 같은 빈 안에서 자기 메서드를 호출하면 프록시를 안 타므로 재시도가 걸리지 않는다.
//         재시도 메서드와 트랜잭션 메서드는 반드시 다른 빈에 둔다.
// 주의 2: 재시도 대상은 멱등해야 한다. 외부 API 호출·이벤트 발행·메일 전송은
//         트랜잭션 밖 그리고 재시도 밖(커밋 후)으로 빼 둔다.
```

**형태 ② 라이브러리 없이 직접 루프** — spring-retry를 쓸 수 없거나, 재시도 조건을 SQLSTATE로 직접 판정하고 싶을 때. `TransactionTemplate`이 매 시도마다 새 트랜잭션을 연다.

```java
@Component
public class SerializableRetryExecutor {

    private static final String SERIALIZATION_FAILURE = "40001";
    private static final String DEADLOCK_DETECTED     = "40P01";

    private final TransactionTemplate txTemplate;

    public SerializableRetryExecutor(PlatformTransactionManager tm) {
        this.txTemplate = new TransactionTemplate(tm);
        this.txTemplate.setIsolationLevel(TransactionDefinition.ISOLATION_SERIALIZABLE);
    }

    public <T> T execute(TransactionCallback<T> work, int maxAttempts) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return txTemplate.execute(work);      // 매 시도가 BEGIN~COMMIT 한 벌
            } catch (RuntimeException e) {
                if (!isRetryable(e)) throw e;         // 재시도해도 소용없는 실패는 즉시 올린다
                last = e;
                sleepWithJitter(attempt);             // 같은 상대와 또 부딪히지 않도록 흩뜨린다
            }
        }
        throw last;                                   // 상한 소진 — 호출자가 판단하게 넘긴다
    }

    // 예외 타입은 스프링 버전·JPA 경로에 따라 달라질 수 있으므로 SQLSTATE로 판정한다
    private boolean isRetryable(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException sqlEx) {
                String state = sqlEx.getSQLState();
                if (SERIALIZATION_FAILURE.equals(state) || DEADLOCK_DETECTED.equals(state)) {
                    return true;
                }
            }
        }
        return false;
    }

    private void sleepWithJitter(int attempt) {
        long base = 50L << (attempt - 1);                              // 50, 100, 200 ms
        long delay = base / 2 + ThreadLocalRandom.current().nextLong(base / 2 + 1);
        try {
            Thread.sleep(delay);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();                        // 인터럽트 상태를 삼키지 않는다
            throw new IllegalStateException(ie);
        }
    }
}
```

운영에서 한 가지 더. **`40001` 발생 건수와 재시도 성공률을 지표로 남긴다.** 재시도가 늘어난다는 것은 충돌 지점이 뜨거워졌다는 뜻이고, 재시도가 재시도를 부르는 구간에 들어가면 격리 수준을 낮추고 국소 락으로 바꾸라는 신호다(2-7). 실패만 세지 말고 **"몇 번째 시도에서 성공했는가"** 를 함께 남겨야 이 판단이 가능하다.

---

## 4. 꼬리질문 대비 포인트

### "같은 트랜잭션에서 같은 행을 두 번 읽었는데 값이 달라요"라는 버그 리포트 — 무슨 현상이고 어떻게 확인하나?

전형적인 **non-repeatable read**이고, PostgreSQL 기본인 READ COMMITTED에서는 **정상 동작**이다. 확인 순서: ① 실제 격리 수준 — `SHOW transaction_isolation;`, 롤/DB 기본값이 덮어씌워져 있는지 `SHOW default_transaction_isolation;`. ② 두 읽기가 **정말 같은 트랜잭션 안**인지 — 트랜잭션이 없거나(프록시 자기 호출, `@Transactional` 누락) 끊겨서 각 SELECT가 auto-commit으로 따로 돈 것일 수 있다. 운영 중이면 `pg_stat_activity.xact_start`가 두 문장 사이에 바뀌는지로 확인한다. ③ 해결은 요구사항에 따라 — 그 로직만 `REPEATABLE_READ`로 올리거나(재시도 준비), 첫 읽기 결과를 변수로 들고 가거나, 갱신 충돌이 본질이면 `FOR NO KEY UPDATE`로 잠그고 읽는다.

### "PostgreSQL REPEATABLE READ에서 phantom read가 정말 발생하지 않나?"

발생하지 않는다 — 첫 문장 시점의 스냅샷을 끝까지 쓰므로 다른 트랜잭션의 INSERT/DELETE 커밋이 보이지 않고, 잠금 읽기를 섞어도 "안 보이던 행이 갑자기 보이는" 일은 없다(대신 내 스냅샷 이후 남이 갱신한 행을 건드리면 `40001`).

단 둘을 덧붙여야 정확하다. ① **"안 보인다"와 "없다"는 다르다** — `FOR UPDATE`로 행이 없음을 확인하고 INSERT하는 패턴은 남이 같은 키를 이미 커밋했어도 내 스냅샷에 안 보일 뿐이라 UNIQUE 위반으로 터진다. 존재하지 않는 행은 PG에서 잠글 수 없으므로 이 경쟁은 UNIQUE + `ON CONFLICT`나 advisory lock으로 푼다. ② 서로 다른 행을 고치는 write skew는 phantom과 별개 현상이고 RR로는 못 막는다. **"표준 정의상 허용 / PG 스냅샷 구현상 불가 / 대신 40001과 write skew"** 의 3단 구조로 답한다.

### "재고 차감 동시성 문제를 SERIALIZABLE로 풀면 안 되나?"

기술적으로는 막을 수 있지만 정석이 아니다. 재고와 무관한 조회·갱신까지 predicate lock 비용과 `40001` 재시도 확률을 떠안고, 피크 때 재시도가 재시도를 부르는 악순환이 생긴다. 재고 차감은 "특정 행의 갱신 충돌"이라는 국소 문제이므로 국소 도구로 푼다 — 원자적 UPDATE(`... AND stock >= 1 RETURNING stock`)가 가장 싸고 RC 기본에서 그대로 안전하며, 검증/부가 로직이 필요하면 `FOR NO KEY UPDATE`, 충돌이 드물면 `@Version` 낙관적 락 + 재시도. **"격리 수준은 광역 설정, 쓰기 충돌은 국소 락 또는 한 문장"** 이 답의 뼈대다.

### "REPEATABLE READ면 충분해 보이는데, SERIALIZABLE이 꼭 필요한 경우는?" (시니어 변별 포인트)

**불변식이 여러 행에 걸쳐 있을 때**다. RR의 충돌 감지는 "같은 행을 두 트랜잭션이 갱신"할 때만 작동하므로, 당직 의사(1-7)나 "계좌 두 개의 합이 0 이상"처럼 **각자 다른 행을 쓰면서 공통 조건을 읽는** 패턴은 그대로 통과시킨다.

선택지는 셋이다. ① 경쟁을 같은 행으로 모은다(부모 행 `FOR UPDATE`, `pg_advisory_xact_lock`) — 잠글 대상이 분명할 때 가장 예측 가능하다. ② 제약으로 박는다(합계 컬럼 + CHECK, 겹침 금지는 `EXCLUDE`) — 표현 가능할 때 가장 싸다. ③ SERIALIZABLE + 재시도 — 불변식이 복잡하거나 잠글 행이 애매할 때. 트레이드오프는 **"①·②는 사람이 충돌 지점을 다 알아야 하고, ③은 몰라도 되지만 재시도 인프라와 짧은 트랜잭션이 전제"** 다.

### "격리 수준을 실무에서 바꾸거나 확인해본 경험이 있나?"

경험 스토리의 뼈대는 셋이다. ① 운영 DB 기본값을 실제로 확인한 경험(`SHOW default_transaction_isolation`) — "PostgreSQL이라 READ COMMITTED가 기본이었고, 여러 문장에 걸친 조회는 같은 시점을 본다는 보장이 없다는 걸 전제로 코드를 봤다"만 말해도 실무 감각이 전달된다. ② 정산·리포트처럼 여러 SELECT가 같은 시점을 봐야 하는 로직을 `REPEATABLE_READ + readOnly`로 올리되, 배치가 길어지자 `backend_xmin`이 VACUUM을 막아 `n_dead_tup`이 쌓이는 걸 보고 청크로 쪼갠 판단 — **"바꿨다"보다 "왜 그 수준이면 충분했다/부족했다를 판단했다"** 가 핵심이다. ③ `40001` 로그를 집계해 재시도 성공률과 충돌 지점을 본 경험이 있다면 SERIALIZABLE의 비용을 체감으로 안다는 강한 신호다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **기본값** — MySQL은 REPEATABLE READ, PG는 READ COMMITTED. 같은 스프링 코드의 `Isolation.DEFAULT`가 다른 수준으로 돈다. ② **phantom을 막는 방식** — InnoDB RR은 잠금 읽기에 갭 락·넥스트 키 락을 걸어 범위 INSERT를 차단하고, PG RR은 스냅샷으로 안 보이게 할 뿐 범위를 잠그지 못한다. 그래서 "없으면 INSERT" 경쟁의 해법이 MySQL은 `FOR UPDATE`(갭 락), PG는 UNIQUE + `ON CONFLICT`/advisory lock으로 갈린다. ③ **갱신 충돌의 처리** — InnoDB RR은 남이 갱신한 행에 내 UPDATE를 조용히 최신 버전에 적용하지만, PG RR은 `40001`로 실패시킨다(first-committer-wins). PG에서 RR을 쓰는 순간 재시도가 필수인 이유다. ④ **SERIALIZABLE의 실체** — InnoDB는 모든 SELECT에 공유 락(읽기끼리 대기, 데드락 급증), PG는 SSI(블로킹 없이 abort). ⑤ **롱 스냅샷의 비용** — InnoDB는 언두 로그 누적·퍼지 지연, PG는 VACUUM이 못 치우는 bloat와 `backend_xmin`. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "차이를 원리로 이해했다"로 들린다.

---

## 한 줄 요약

**격리 수준은 "동시에 도는 트랜잭션의 중간 상태가 내게 얼마나 보이는가"의 눈금이고, 올릴수록 이상 현상은 줄지만 옛 버전 보존 비용과 실패 확률이 오른다. 4단계는 dirty read(커밋 안 된 값) / non-repeatable read(같은 행의 값 변경, UPDATE) / phantom read(같은 조건의 행 개수 변경, INSERT·DELETE)를 어디까지 허용하느냐의 표준 매트릭스인데, PostgreSQL은 이를 MVCC 스냅샷으로 구현한 3단계로 제공한다 — 기본 READ COMMITTED는 문장마다 스냅샷을 새로 찍고, REPEATABLE READ는 **첫 문장 시점**(BEGIN이 아니다)의 스냅샷을 고정해 phantom까지 막되 갱신 충돌은 `40001`로 실패시키며 write skew는 못 막고, SERIALIZABLE은 SSI로 읽기/쓰기 의존성을 추적해 사전 차단이 아니라 **사후 감지**로 abort하므로 재시도 루프가 필수다. 스프링 `@Transactional`의 기본값은 DB 기본값 위임(`Isolation.DEFAULT`)이라 PG에서는 RC로 돌고, 지정이 조용히 무시되는 경우는 **기존 트랜잭션에 합류할 때 하나뿐**이며(그 외에는 `InvalidIsolationLevelException`으로 드러난다), 재고 차감 같은 국소 쓰기 충돌은 격리 수준 올리기가 아니라 원자적 UPDATE·`FOR NO KEY UPDATE`·낙관적 락으로 푸는 것이 정석이다.**
