# 무중단 스키마 변경(online DDL) — PostgreSQL에서 "컬럼 하나 추가"가 서비스를 세우는 사슬과, 잠금 수준으로 그 사슬을 끊는 방법

> 핵심 관전 포인트: **PostgreSQL에서 대용량 테이블의 DDL이 위험한 이유는 두 갈래다. ① 재작성 여부와 무관하게 거의 모든 `ALTER TABLE`은 테이블의 `ACCESS EXCLUSIVE` 잠금을 잡아야 하는데, 열려 있는 긴 트랜잭션 하나가 `ACCESS SHARE`(SELECT가 잡는 가장 약한 잠금)를 쥐고 있으면 ALTER가 대기하고, 대기 중인 `ACCESS EXCLUSIVE` 뒤로 들어오는 그 테이블의 모든 SELECT까지 줄을 서고, 커넥션 풀이 고갈되어 무관한 API까지 전면 장애가 된다 — `lock_timeout` 기본값이 0(무한 대기)이라 스스로 풀리지 않는다. ② 작업이 테이블 재작성(타입 변경, volatile DEFAULT, `VACUUM FULL`)이면 그 잠금을 수 시간 내내 쥔 채 디스크 2배·WAL 폭증·레플리카 지연이 따라온다. 그래서 답은 "작업별 잠금 수준과 재작성 여부를 먼저 판별 → 컬럼 추가는 카탈로그만 고치니 `SET lock_timeout = '3s'` + 재시도로, 인덱스는 `CREATE INDEX CONCURRENTLY`로, 제약은 `NOT VALID` → `VALIDATE CONSTRAINT`로, 타입 변경은 새 컬럼 + 백필 + 스왑(또는 논리 복제)으로 → 이 절차를 사람 기억이 아니라 마이그레이션 도구·린트·이벤트 트리거·체크리스트에 고정"이다. PostgreSQL은 MySQL의 pt-osc/gh-ost 자리를 DB 내장 기능 + 트랜잭션 DDL이 상당 부분 대신하지만, 어느 기능도 `ACCESS EXCLUSIVE` 대기열 문제 자체를 없애주지는 않는다.**

---

## 0. 질문 + 의도

**질문**: "대용량 테이블에 컬럼 추가/인덱스 추가를 무중단으로 하려면? (online DDL, pt-osc 등)"

**PostgreSQL 기준 재해석**: "PostgreSQL에서 `ALTER TABLE ADD COLUMN`과 `CREATE INDEX`가 각각 어떤 잠금을 얼마나 오래 잡는지, 그 잠금 대기열이 어떻게 서비스 장애로 번지는지 설명하고, `lock_timeout`·`CREATE INDEX CONCURRENTLY`·`NOT VALID`·`pg_repack` 같은 PG의 수단으로 읽기·쓰기를 막지 않는 절차를 설계하라." (pt-osc/gh-ost는 MySQL 도구다 — PG에서 그 자리를 무엇이 채우는지가 이 문항의 PG 버전이다.)

**출제 의도**: "컬럼 하나 추가"가 수억 건 테이블에서는 **서비스 중단 리스크**임을 아는지. 이 감각이 없는 사람은 운영 DB에 습관처럼 ALTER를 날려 사고를 낸다. 동시에 **스키마 변경 절차를 갖춘 팀에서 일해봤는지**도 드러난다 — 즉 "기능 이름을 아는가"가 아니라 ⑴ 왜 위험한지를 잠금 메커니즘으로 말할 수 있는가 ⑵ 선택지마다 무슨 대가를 치르는지 아는가 ⑶ 그 판단을 개인의 주의력이 아니라 팀의 절차로 고정해봤는가를 본다. PostgreSQL은 DDL의 위험이 "알고리즘 이름"이 아니라 **잠금 수준과 재작성 여부**로 갈리므로, 그 두 축으로 작업을 분류할 수 있는지가 핵심이다.

**이 문서의 뼈대는 세 줄이다.** 1절은 **왜 위험한가**를 잠금 메커니즘의 사슬로 풀고, 그 사슬 위에서 "이 작업이 어느 부류인가"를 판별하는 원리와 표를 세운다. 2절은 **그 사슬을 끊는 절차 네 가지**를 얻는 것과 지불하는 것의 양면으로 조립한다. 3절은 그 절차를 **사람의 기억이 아니라 팀의 실행 경로에 고정**하는 방법과, 그 전부가 왜 필요한지를 한 번에 보여주는 실무 사고를 다룬다.

> 역할 구분: [28-graceful-shutdown-zero-downtime-deploy.md](../02-spring/28-graceful-shutdown-zero-downtime-deploy.md)는 **앱 프로세스 교체**의 무중단(LB 제외 → 진행 중 요청 완료 → SIGTERM)을 다룬다. 이 문서는 **스키마 변경**의 무중단이다. 둘은 별개의 축이고 둘 다 있어야 "무중단 배포"가 성립한다 — 배포 파이프라인이 완벽해도 ALTER 한 줄이 서비스를 세우고, 스키마를 무중단으로 바꿔도 구버전 앱이 새 스키마에서 죽으면 롤링 배포 중 에러가 난다(3-4절).

---

## 1. 왜 ALTER 한 줄이 전면 장애가 되는가 — 잠금 사슬과 작업 판별

"ALTER는 위험하다"를 아는 것과 **어떤 단계를 거쳐 장애가 되는지**를 말할 수 있는 것은 다른 평가를 받는다. 뭉뚱그린 "락 걸려서 느려진다"를 세 개의 사슬로 쪼갠다. 면접에서는 사슬 A를 먼저, 그 다음 B·C를 말한다.

세 사슬의 관계를 미리 한 줄로 잡아 두면 길을 잃지 않는다. **사슬 A는 "잠금을 얻기까지"의 문제**이고 재작성 여부와 무관하게 모든 DDL에 붙는다. **사슬 B는 "잠금을 얻은 다음"의 문제**로 재작성 작업에만 붙는다. **사슬 C는 그 두 가지가 레플리카로 번지는 경로**다. 실무 사고의 대다수는 A에서 난다 — 그런데 사람들은 B만 걱정한다.

### 1-1. 먼저 등장인물 — 테이블 잠금 수준 여덟 단계 중 다섯 개

사슬을 말하려면 이름이 먼저 있어야 한다. 여기서 다루는 잠금은 **행 잠금이 아니라 테이블 잠금**이다.

**테이블 잠금 수준(lock mode)** 이란, PostgreSQL이 "이 테이블에 지금 무슨 작업이 진행 중인지"를 표시하기 위해 테이블 단위로 잡는 표식이고, 세기가 여덟 단계다. 이름이 "잠금"이라 "테이블을 통째로 잠근다"로 읽히지만 실제 뜻은 그게 아니다 — **어떤 잠금끼리 동시에 존재할 수 있는지(충돌표)를 정의하는 이름표**에 가깝다. 약한 잠금끼리는 얼마든지 공존하고, 강한 잠금은 거의 모든 것과 공존하지 못한다.

이 문서에 필요한 것은 다섯 개다.

| 잠금 수준 | 누가 잡나 | 무엇과 충돌하나 |
|---|---|---|
| `ACCESS SHARE` | 모든 `SELECT` | 오직 `ACCESS EXCLUSIVE`와만 충돌 (가장 약함) |
| `ROW EXCLUSIVE` | `INSERT` / `UPDATE` / `DELETE` | 서로는 공존. `SHARE` 이상과 충돌 |
| `SHARE UPDATE EXCLUSIVE` | `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT` | SELECT·DML과 **충돌하지 않는다** — "온라인 작업용 잠금" |
| `SHARE` | 일반 `CREATE INDEX` | 읽기는 허용, **쓰기는 차단** |
| `ACCESS EXCLUSIVE` | `ALTER TABLE` 대부분, `DROP`, `TRUNCATE`, `VACUUM FULL`, `CLUSTER` | **SELECT를 포함해 모든 것과 충돌** (가장 강함) |

이름의 규칙을 알면 외우기 쉽다. `ACCESS`가 붙은 것은 **읽기(SELECT)까지 대상에 넣는다**는 뜻이고, 안 붙은 것은 읽기는 건드리지 않는다는 뜻이다. `SHARE`는 "나와 같은 것끼리는 공존한다", `EXCLUSIVE`는 "나와 같은 것끼리도 공존 못 한다"는 뜻이다. 그래서 `ACCESS EXCLUSIVE`는 "읽기까지 포함해 아무것도 같이 못 있는" 최강 잠금이 된다.

여기에 세 가지 사실을 더 붙여야 사슬이 성립한다.

- **테이블 잠금은 문장이 아니라 트랜잭션이 끝날 때 풀린다.** `SELECT` 한 번 하고 커밋을 안 한 세션 — `pg_stat_activity`에서 `state = 'idle in transaction'`으로 보이는 그 세션 — 은 그 테이블의 `ACCESS SHARE`를 계속 쥔다. 쿼리가 이미 끝났어도 그렇다.
- **잠금 대기의 상한은 `lock_timeout`인데 기본값이 0, 즉 무제한이다.** 아무도 안 끊어 주면 영원히 기다린다.
- **대기열 규칙**: 새 잠금 요청은 **보유 중인 잠금**뿐 아니라 **앞서 대기 중인 요청**과 충돌해도 그 뒤에 줄을 선다. 이것이 사슬의 핵심 고리다. 왜 이런 규칙인가 하면, 그렇게 하지 않으면 약한 잠금들이 끊임없이 새치기해서 강한 잠금(DDL)이 영원히 순서를 못 받는 굶주림(starvation)이 생기기 때문이다. **DDL을 굶기지 않으려는 공정성 규칙이 서비스 전면 장애의 원인이 된다**는 것이 이 문서에서 가장 반직관적인 지점이다.

### 1-2. 사슬 A — ACCESS EXCLUSIVE 대기열 (재작성 여부와 무관, 가장 흔한 사고)

세션 세 개면 사슬 전체가 그려진다. **A는 긴 조회, B는 ALTER, C는 평범한 1ms짜리 API 조회**다.

```text
t=0      세션 A (정산 대시보드)  BEGIN; SELECT ... FROM orders ...   -- 15분짜리 리포팅
         → orders에 ACCESS SHARE 획득. 트랜잭션이 끝날 때까지 보유.

t=1s     세션 B (운영자)  ALTER TABLE orders ADD COLUMN coupon_code text;
         → ACCESS EXCLUSIVE 요청. A의 ACCESS SHARE와 충돌 → 대기.
           lock_timeout = 0 이므로 A가 끝날 때까지 무한 대기.
           (pg_stat_activity: wait_event_type = Lock, wait_event = relation)

t=1.2s   세션 C (주문 조회 API)  SELECT * FROM orders WHERE id = $1;
         → ACCESS SHARE 요청. 보유 중인 A와는 충돌하지 않는다.
           그런데 대기열 앞의 B(ACCESS EXCLUSIVE)와 충돌 → B 뒤에 줄을 선다.
           여기가 사슬의 심장이다. 1ms짜리 PK 조회가 멈춘다.

t=1.5s~  세션 D, E, F ...  orders를 읽거나 쓰는 모든 요청이 C 뒤에 줄을 선다.
         INSERT(ROW EXCLUSIVE)도 마찬가지. orders는 사실상 "잠긴 테이블".

t=30s    앱: 요청 스레드가 DB 응답을 기다리며 커넥션을 쥔 채 멈춘다.
         HikariCP 풀(기본 10개)이 orders 대기자로 가득 참 → 풀은 앱 전체가
         공유하므로 orders와 무관한 API(로그인, 상품 조회)까지
         connection-timeout(기본 30초) 후 실패 → 톰캣 워커 고갈 → 헬스체크 실패
         → LB 제외/재시작 — 재시작해도 DB 쪽 대기열은 그대로라 다시 막힘.

t=15m    A 커밋 → B가 잠금 획득, ADD COLUMN은 1ms에 끝남 → C, D, E ... 가 한꺼번에 풀림.
         테이블 하나의 잠금 대기가 서비스 전면 장애로 증폭됐다.
```

t=1.2초 시점의 잠금 상태만 따로 그리면 왜 C가 멈추는지가 한눈에 들어온다.

```text
orders 테이블의 잠금 상태 (t = 1.2초)

  보유 중 ── 세션 A : ACCESS SHARE        15분짜리 리포팅. 아직 커밋 안 함
             │
  대기열 ──┬─ 세션 B : ACCESS EXCLUSIVE   A와 충돌 → 대기 (무한)
           └─ 세션 C : ACCESS SHARE       A와는 충돌하지 않는데도,
                                          "대기열 앞의 B"와 충돌해 B 뒤에 선다
```

**A와 C는 서로 아무 문제가 없는 사이다.** SELECT 두 개는 언제나 공존한다. 그런데 그 사이에 B가 끼어들어 대기열에 서는 순간, C는 A가 아니라 **B 때문에** 멈춘다. 그리고 B는 A 때문에 멈춰 있다. 긴 조회 하나가 ALTER를 막고, ALTER가 그 뒤의 모든 SELECT를 막는 이 **2단 전달**이 사슬 A의 전부다.

여기서 반드시 짚을 것이 하나 더 있다. 이 사슬은 **ADD COLUMN이 카탈로그만 고치는 1ms짜리 작업이어도 똑같이 발생한다.** "PG 11부터는 DEFAULT 있는 컬럼 추가도 즉시 끝난다"는 말은 "잠금을 **얻은 뒤** 1ms"라는 뜻이지 "잠금을 안 잡는다"는 뜻이 아니다. 1ms짜리 ALTER가 긴 트랜잭션 뒤에서 10분을 대기하면 그 10분 동안 서비스는 죽어 있다.

그리고 이 문장에서 이 문서의 첫 번째 처방이 곧바로 도출된다. **위험한 것은 ALTER의 실행 시간이 아니라 ALTER의 대기 시간**이므로, 안전장치는 "ALTER를 빠르게 만드는 것"이 아니라 **"ALTER가 오래 기다리지 못하게 막는 것"**이어야 한다. `lock_timeout`을 몇 초로 걸어 두면 B는 3초 만에 스스로 실패하고, 실패하는 순간 대기열이 해소되어 C 이하가 즉시 풀린다. 실패는 아무에게도 피해를 주지 않는다 — 대기가 피해를 준다. 그래서 처방이 "짧은 `lock_timeout` + 재시도"인 것이고, 그 구체적 형태가 3-1절이다.

이미 벌어진 뒤의 복구는 사슬의 A 또는 B를 끊는 것이다. PostgreSQL은 **누가 누구를 막는지**를 함수 하나로 보여준다.

```sql
-- 누가 누구를 막고 있나 — 대기 중인 세션과 그 원인 pid
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age,
       pg_blocking_pids(pid) AS blocked_by,
       left(query, 60) AS query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0
   OR state = 'idle in transaction'
ORDER BY xact_start;
-- B(ALTER)   : blocked_by = {A}
-- C, D, E …  : blocked_by = {B}   ← A가 아니라 "대기 중인 B"가 막고 있다

SELECT pg_cancel_backend(<B의 pid>);      -- ALTER 취소 → 대기열 즉시 해소 (남의 트랜잭션 A를 끊는 것보다 안전)
SELECT pg_terminate_backend(<A의 pid>);   -- 원흉이 방치된 idle in transaction 세션이면 종료(롤백)
```

`blocked_by` 열을 읽는 순서가 진단의 핵심이다. C·D·E가 `{B}`를 가리키고 B만 `{A}`를 가리킨다면, **범인은 A 하나이고 B는 전달자**다. 그런데 복구에서 먼저 끊을 것은 A가 아니라 B다 — B(내가 친 ALTER)를 취소하는 것은 내 작업을 포기하는 것뿐이지만, A(남의 리포팅 트랜잭션)를 끊는 것은 남의 작업을 15분어치 날리는 일이기 때문이다.

### 1-3. 사슬 B — 테이블 재작성의 자원 비용

재작성이 필요한 작업(컬럼 타입 변경, volatile DEFAULT 컬럼 추가, `VACUUM FULL`, `CLUSTER`)이면, 잠금을 무사히 얻은 뒤에도 두 번째 사슬이 기다린다.

여기서 **재작성(rewrite)** 이란, 테이블의 물리 파일을 새로 하나 만들어 **모든 행을 거기에 다시 써 넣고** 옛 파일을 버리는 작업이다. 논리적으로는 같은 테이블이지만 디스크 위의 실체가 통째로 교체된다.

> ⑴ `ACCESS EXCLUSIVE`를 **작업이 끝날 때까지** 쥔다. PostgreSQL의 `ALTER TABLE`에는 "재작성하는 동안 DML을 허용"하는 모드가 없다 — 수 시간 동안 그 테이블의 **읽기·쓰기가 전부 차단**된다.
> ⑵ 새 파일(relfilenode)에 **전 행을 다시 쓰고**, **모든 인덱스를 다시 만든다**. 옛 파일과 새 파일이 동시에 존재하는 구간이 있으므로 디스크가 일시적으로 2배 필요하고, `maintenance_work_mem`·CPU·I/O를 크게 점유한다.
> ⑶ 재작성은 전부 **WAL로 기록**된다. WAL(Write-Ahead Log)은 "변경을 데이터 파일에 반영하기 전에 먼저 순차 기록해 두는 로그"이므로, 전 행 재작성은 곧 테이블 크기만큼의 WAL 생성이다 → WAL 디스크 급증, 아카이빙 지연, **레플리카 지연**(사슬 C).
> ⑷ DDL이 트랜잭션이라 도중 실패·취소는 깨끗이 롤백된다(장점) — 대신 그때까지 쓴 시간·I/O·WAL은 날아간다.

### 1-4. 사슬 C — 레플리카로 번지는 경로

프라이머리에서 무사히 끝난 DDL이 **읽기 레플리카**를 무너뜨리는 경로다. PostgreSQL의 스트리밍 복제는 SQL 문장을 다시 실행하는 것이 아니라 **WAL을 물리적으로 재생**한다 — "8192번 페이지의 이 위치에 이 바이트를 써라" 수준의 지시를 그대로 따라 하는 방식이다.

> ⑴ 재작성 DDL이 만든 대량 WAL을 레플리카가 재생하느라 **복제 지연**이 벌어진다(지연은 WAL 양에 비례). 그러면 레플리카 읽기에서 "방금 쓴 데이터가 안 보이는" 장애가 난다.
> ⑵ 프라이머리에서 잡은 **`ACCESS EXCLUSIVE` 잠금은 WAL에 기록되어 레플리카에서도 재생된다.** 레플리카에서 그 테이블을 읽던 쿼리가 있으면 재생이 막히고, `max_standby_streaming_delay`(기본 30초)가 지나면 **레플리카 쿼리가 취소**된다(`canceling statement due to conflict with recovery`). 프라이머리의 1ms짜리 ALTER가 레플리카의 15분짜리 리포트를 죽일 수 있다. `hot_standby_feedback`은 VACUUM 충돌용이라 잠금 충돌은 못 막는다.
> ⑶ 논리 복제(PUBLICATION/SUBSCRIPTION)라면 반대 문제가 생긴다 — **DDL은 복제되지 않으므로** 구독 쪽에 컬럼을 먼저 추가해 두지 않으면 적용이 멈춘다.

### 1-5. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

면접에서 "ALTER 하면 락 걸려서 느려진다"는 답의 **제목**일 뿐이다. 같은 내용을 이름 붙은 사슬로 바꿔 말하는 연습이 필요하다.

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "ALTER 하면 락 걸려서 느려진다" | **ACCESS EXCLUSIVE 대기열** | 긴 트랜잭션이 ACCESS SHARE 보유 → ALTER가 ACCESS EXCLUSIVE 대기(`lock_timeout` 0 = 무한) → 그 뒤로 오는 SELECT까지 대기열 → 커넥션 풀 고갈 → 무관한 API까지 전면 장애 |
| "테이블이 커서 오래 걸린다" | **재작성(rewrite) 비용** | 새 relfilenode에 전 행 재작성 + 인덱스 전부 재생성 → 그동안 ACCESS EXCLUSIVE 유지(읽기·쓰기 차단) → 디스크 2배 + WAL 폭증 |
| "레플리카가 밀린다" | **WAL 재생 충돌** | 재작성 WAL 양만큼 지연 + ACCESS EXCLUSIVE가 레플리카에서 재생되며 `max_standby_streaming_delay` 후 레플리카 쿼리 취소 |

> **MySQL 대조**: 같은 사고를 MySQL은 **메타데이터 락(MDL)** 대기열로 설명한다(`lock_wait_timeout` 기본 1년, `Waiting for table metadata lock`). 원리는 같고 이름과 기본값만 다르다. 사슬 C는 반대다 — MySQL 레플리카는 binlog로 받은 **ALTER 문장을 처음부터 재실행**하므로 지연이 곧 ALTER 소요 시간이고, PostgreSQL은 WAL 양에 비례한다.

### 1-6. 판별 원리 — "이 작업이 기존 행의 물리적 표현을 바꾸는가"

사슬을 알았으면 다음 질문은 "내가 지금 치려는 이 문장은 어느 부류인가"다. PostgreSQL에는 MySQL의 `ALGORITHM=INSTANT/INPLACE/COPY` 같은 이름표가 없다. 대신 작업마다 **① 어떤 잠금을 ② 얼마나 오래(카탈로그만 / 전체 스캔 / 전체 재작성) 잡는가** 두 축으로 갈린다.

판별의 원리는 한 문장이다 — **"이 작업이 이미 디스크에 저장된 행(튜플)의 바이트 배치를 바꿔야 하는가."** 바꿔야 하면 전 행을 다시 쓰는 수밖에 없고, 안 바꿔도 되면 테이블 정의만 고치고 끝난다.

여기서 **시스템 카탈로그**란 "테이블이 어떤 컬럼을 갖고 각 컬럼의 타입이 무엇인지"를 담아 두는 PostgreSQL 자신의 관리용 테이블들이다(`pg_class`, `pg_attribute` 등). 테이블의 **설계도**에 해당하고, 실제 데이터가 담긴 힙 파일과는 별개의 파일이다. 그래서 "카탈로그만 고친다"는 것은 곧 "설계도 몇 줄만 고치고 데이터 파일은 손도 안 댄다"는 뜻이며, 데이터가 1억 건이든 1건이든 같은 시간에 끝난다.

이 원리를 네 부류로 펼치면 이렇게 된다.

- **행을 안 건드리고 시스템 카탈로그만 고치면 되는가 → 순간 작업.** 컬럼 추가는 기존 튜플을 그대로 두고, 카탈로그에 "이 컬럼의 기본값은 X"라고 적어 둔다(`pg_attribute.attmissingval`, PG 11 이상). 그러면 그 컬럼이 물리적으로 없는 옛 튜플을 **읽을 때** 그 값을 채워 넣어 준다. 컬럼 삭제도 마찬가지로 `attisdropped` 표시만 하고, 실제 바이트는 그대로 남는다.
- **행은 그대로 두되 별도 구조를 새로 지으면 되는가 → 인덱스 빌드.** 인덱스는 테이블 밖의 독립된 파일이므로 힙 튜플을 고칠 필요가 없다. 일반 `CREATE INDEX`는 `SHARE`(쓰기 차단), `CONCURRENTLY`는 `SHARE UPDATE EXCLUSIVE`(읽기·쓰기 허용, 대신 2회 스캔)다.
- **행을 고치진 않지만 전 행을 읽어 검증해야 하는가 → 전체 스캔.** `SET NOT NULL`, `ADD CHECK`, `ADD FOREIGN KEY`가 여기다. 기존 데이터가 새 규칙을 이미 만족하는지 확인해야 하므로 전부 읽지만, 읽기만 하고 쓰지는 않는다. `NOT VALID` → `VALIDATE`로 나누면 이 스캔을 `SHARE UPDATE EXCLUSIVE`(온라인)로 내릴 수 있다.
- **모든 튜플을 다시 써야 하는가 → 재작성.** 새 relfilenode에 전 행을 복사하고 인덱스를 전부 재생성하며, 그동안 내내 `ACCESS EXCLUSIVE`다.

마지막 부류의 대표가 타입 변경이다. **왜 `int` → `bigint`는 재작성이고 `varchar(10)` → `varchar(20)`은 아닌가**를 설명할 수 있으면 이 원리를 이해한 것이다.

- `int`는 디스크에 **4바이트 고정**으로 저장되고 `bigint`는 **8바이트 고정**이다. 그 컬럼의 크기가 바뀌면 같은 튜플 안에서 **그 뒤에 오는 모든 컬럼의 위치(오프셋)가 전부 밀린다.** 즉 튜플 하나하나의 바이트 배치를 새로 짜야 하므로 전 행 재작성 외에 방법이 없다.
- `varchar(n)`은 길이가 몇이든 디스크에는 **"길이 헤더 + 실제 문자열"** 이라는 같은 가변 길이 표현(varlena)으로 저장된다. `n`은 저장 형식이 아니라 **입력 검증 규칙**일 뿐이고 카탈로그의 `atttypmod`에만 적혀 있다. 그래서 길이를 **늘리는** 것은 카탈로그 한 줄 수정이다. 같은 이유로 `varchar` → `text`도 재작성이 없다 — 저장 표현이 애초에 동일하다.
- 반대로 길이를 **줄이는** 것은 "기존 값이 새 제한을 넘지 않는가"를 확인해야 하고 PostgreSQL은 이때 재작성 경로를 탄다.

`ADD COLUMN`이 순간 작업이 된 것은 **버전에 의존하는 사실**이므로 반드시 버전을 붙여 말해야 한다.

| PostgreSQL 버전 | `ADD COLUMN c text` (DEFAULT 없음) | `ADD COLUMN c text DEFAULT 'x'` (상수) | `ADD COLUMN c uuid DEFAULT gen_random_uuid()` (volatile) |
|---|---|---|---|
| 10 이하 | 카탈로그만 (순간) | **전 행 재작성** | 전 행 재작성 |
| 11 이상 | 카탈로그만 (순간) | **카탈로그만** (`attmissingval`에 기본값 저장) | 전 행 재작성 |

11에서 갈린 이유가 곧 원리 그대로다. 상수 기본값은 **모든 행이 같은 값**이므로 "값 하나를 설계도에 적어 두고 읽을 때 꺼내 쓰면" 충분하지만, `gen_random_uuid()`처럼 **행마다 달라야 하는 값**은 한 곳에 적어 둘 수가 없어 결국 모든 행에 실제로 써 넣는 수밖에 없다.

여기서 파생되는 함정이 하나 더 있다. `DEFAULT now()`는 `now()`가 volatile이 아니라 stable 함수라 재작성을 하지 않는다 — 대신 **ALTER를 실행한 그 시점의 값 하나**가 카탈로그에 저장되어 모든 기존 행의 값이 된다. "생성 시각" 컬럼을 이렇게 추가하면 기존 행 전부가 같은 시각을 갖게 되므로, 의도가 "행마다 실제 생성 시각"이었다면 데이터가 조용히 틀린다.

### 1-7. 작업별 잠금 수준·재작성 여부 — 암기 표

원리 위에 표를 얹는다. 잠금 열의 "순간"은 "카탈로그 수정이 끝나는 밀리초 단위"라는 뜻이지 **"잠금을 안 잡는다"가 아니다** — 1-2절의 대기열은 언제나 적용된다.

| 작업 | 잠금 수준 | 테이블 재작성 / 스캔 | 안전한 절차 |
|---|---|---|---|
| `ADD COLUMN` (NULL 허용, 또는 **상수 DEFAULT**, PG 11+) | ACCESS EXCLUSIVE **순간** | 없음 (카탈로그만) | `lock_timeout` + 재시도 |
| `ADD COLUMN ... DEFAULT <volatile 함수>` (`gen_random_uuid()`, `clock_timestamp()`) | ACCESS EXCLUSIVE **내내** | **재작성** | NULL로 추가 → 배치 백필 → (필요 시) NOT NULL |
| `DROP COLUMN` | ACCESS EXCLUSIVE 순간 | 없음 (`attisdropped` 표시, 공간은 이후 갱신·재작성 때 회수) | Expand/Contract의 Contract 단계에서, `lock_timeout` |
| `RENAME COLUMN/TABLE`, `SET/DROP DEFAULT` | ACCESS EXCLUSIVE 순간 | 없음 | `lock_timeout` (앱 호환성은 3-4절) |
| `varchar(n)` 길이 늘리기, `varchar` → `text` | ACCESS EXCLUSIVE 순간 | 없음 | `lock_timeout` |
| `ALTER COLUMN TYPE` (`int`→`bigint`, `text`→`varchar(50)`, 길이 줄이기) | ACCESS EXCLUSIVE **내내** | **재작성 + 모든 인덱스 재생성** | 새 컬럼 + 트리거 + 배치 백필 + 스왑(2-3절), 또는 논리 복제 |
| `SET NOT NULL` | ACCESS EXCLUSIVE | **전체 스캔** (재작성 아님) | `CHECK (col IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` (PG 12+는 스캔 생략) |
| `CREATE INDEX` | SHARE (읽기 허용, **쓰기 차단**) | 1회 스캔 | 아래 줄로 대체 |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE (읽기·쓰기 허용) | **2회 스캔** | 트랜잭션 밖에서, `indisvalid` 확인, 실패 시 DROP 후 재시도 |
| `ADD PRIMARY KEY` / `ADD UNIQUE` | ACCESS EXCLUSIVE | 인덱스 빌드 + (NOT NULL) 스캔 | `CREATE UNIQUE INDEX CONCURRENTLY` → `ADD CONSTRAINT ... USING INDEX` |
| `ADD FOREIGN KEY` | SHARE ROW EXCLUSIVE (**양쪽 테이블**, 쓰기 차단) | 자식 전체 스캔 | `NOT VALID` → `VALIDATE CONSTRAINT`(SHARE UPDATE EXCLUSIVE) |
| `ADD CHECK` | ACCESS EXCLUSIVE | 전체 스캔 | `NOT VALID` → `VALIDATE CONSTRAINT` |
| `VACUUM FULL`, `CLUSTER` | ACCESS EXCLUSIVE **내내** | **재작성** | `pg_repack`(2-4절) |
| `DROP TABLE`, `TRUNCATE` | ACCESS EXCLUSIVE | — | 참조 종료 확인, `lock_timeout` |

암기용으로 압축하면 네 마디다. **"추가·삭제·이름은 카탈로그(순간), 인덱스는 CONCURRENTLY, 제약은 NOT VALID → VALIDATE, 타입은 새 컬럼."**

질문에 나온 두 작업을 이 표에 대보면 결론은 싱겁다 — 컬럼 추가는 카탈로그만 고치고, 인덱스 추가는 `CONCURRENTLY`면 온라인이다. **둘 다 네이티브로 DML을 막지 않는다.** 그런데도 이 문항이 중급 난이도인 이유는, 사슬 A(대기열)와 사슬 C(레플리카)가 **재작성 여부와 무관하게 그대로 남기** 때문이다. "가벼운 작업"과 "안전한 작업"은 다른 말이다.

### 1-8. PostgreSQL에는 `ALGORITHM=` 단언이 없다 — relfilenode로 확인한다

MySQL은 `ALGORITHM=INSTANT`라고 단언해 두면 그 방식으로 못 할 때 에러로 멈춰 준다. PostgreSQL에는 그런 문법이 없다 — 재작성이 필요하면 **아무 말 없이 재작성한다.** 그래서 "믿지 말고 확인한다"를 절차로 만들어야 한다.

확인 방법은 **relfilenode**다. relfilenode는 테이블의 실제 데이터가 담긴 물리 파일의 번호이고, 재작성은 정의상 "새 파일을 만들어 옮겨 쓰는 것"이므로 **번호가 바뀌면 재작성한 것, 그대로면 카탈로그만 고친 것**이다. 게다가 PostgreSQL은 DDL도 트랜잭션이라 스테이징에서 실험한 뒤 롤백으로 원상 복구할 수 있다.

```sql
-- 스테이징(운영 크기 스냅샷)에서: 재작성 여부를 relfilenode로 확인
BEGIN;
SELECT pg_relation_filenode('orders'::regclass);   -- 예: 16825
ALTER TABLE orders ALTER COLUMN amount TYPE bigint;
SELECT pg_relation_filenode('orders'::regclass);   -- 바뀌었다 = 전 행을 새 파일에 다시 썼다
ROLLBACK;                                          -- DDL도 롤백된다 (PostgreSQL의 트랜잭션 DDL)
-- ADD COLUMN coupon_code text 로 같은 실험을 하면 번호가 그대로다 = 카탈로그만 고친 것
```

여기에 문장을 섞지 않는 규칙, 그리고 PostgreSQL에서만 생기는 **트랜잭션 함정** 두 가지가 붙는다.

```sql
-- before ①: 한 문장에 순간 작업과 재작성 작업을 섞음 — 한 문장은 한 번의 잠금이다
ALTER TABLE orders ADD COLUMN coupon_code text, ALTER COLUMN amount TYPE bigint;
-- coupon_code 추가까지 amount 재작성이 끝날 때까지 ACCESS EXCLUSIVE 안에 갇힌다.

-- before ② (PostgreSQL 고유): 한 마이그레이션 파일 = 한 트랜잭션
--    ALTER TABLE orders ADD COLUMN coupon_code text;    -- 1ms, ACCESS EXCLUSIVE 획득
--    UPDATE orders SET coupon_code = ... ;               -- 40분짜리 백필
--    → DDL이 트랜잭션에 포함되므로 ACCESS EXCLUSIVE는 커밋될 때까지, 즉 40분 내내
--      유지된다. "ADD COLUMN은 순간"이라는 지식이 무용지물이 되는 지점.

-- after: 순간 작업은 자기 파일(트랜잭션)에 혼자, 백필은 마이그레이션 밖에서
--        배치 커밋으로(3-4절), 재작성 작업은 2-3절의 절차로(Flyway 결합은 3-3절)
```

before ②가 특히 배신감이 큰 지점이다. **"ADD COLUMN은 1ms"라는 사실이 참인데도, 그 문장을 40분짜리 UPDATE와 같은 트랜잭션에 넣는 순간 잠금은 40분이 된다.** 잠금은 문장이 끝날 때가 아니라 트랜잭션이 끝날 때 풀리기 때문이다(1-1절). 마이그레이션 도구는 기본적으로 파일 하나를 트랜잭션 하나로 실행하므로, 이 함정은 "실수"가 아니라 "기본 설정"으로 발생한다.

> **MySQL 대조**: MySQL 8은 `ALGORITHM = INSTANT | INPLACE | COPY, LOCK = NONE | SHARED | EXCLUSIVE`를 **단언**할 수 있고, 그 방식으로 불가능하면 `ERROR 1846`으로 멈춘다. INSTANT는 행에 버전을 매겨 재작성을 미루는 방식이라 테이블당 누적 횟수 상한이 있다. INPLACE는 재작성 중에도 DML을 허용한다(온라인 로그) — PostgreSQL의 `ALTER TABLE`에는 이 모드가 없어서 재작성은 곧 전면 차단이고, 그 대신 재작성을 **피하는** 절차(2절)가 발달했다.

---

## 2. 무중단 절차 4종 — 각각 무엇을 얻고 무엇을 지불하는가

편익만 말하고 멈추면 "기능 이름을 아는 사람", 대가까지 말하면 "써 본 사람"으로 갈린다. 네 절차 전부 **얻는 것**과 **지불하는 것**을 한 호흡에 붙여 말하는 연습을 한다.

### 2-1. 인덱스 — `CREATE INDEX CONCURRENTLY`

```sql
-- before: SHARE 잠금 — 인덱스를 다 지을 때까지 orders의 INSERT/UPDATE/DELETE 전부 차단
CREATE INDEX idx_orders_user_created ON orders (user_id, created_at);
-- 수억 건이면 수십 분 쓰기 정지 = 주문 API 전면 실패. 트랜잭션 안이면 커밋까지 유지.

-- after: SHARE UPDATE EXCLUSIVE — 읽기·쓰기 모두 허용
CREATE INDEX CONCURRENTLY idx_orders_user_created ON orders (user_id, created_at);
-- 반드시 트랜잭션 밖(autocommit)에서. BEGIN 안이면:
-- ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block (SQLSTATE 25001)
```

**동작 순서**를 알아야 대가를 이해할 수 있다.

```text
① 카탈로그에 인덱스를 INVALID 상태로 등록한다.
   이 시점부터의 모든 쓰기는 새 인덱스에도 반영된다 — "앞으로 들어올 것"을 먼저 막아 둔다.
        ↓
② 테이블을 1차 스캔해 그때까지의 행으로 인덱스를 짓는다.
        ↓
③ ①~② 사이에 커밋된 변경을 놓쳤을 수 있으므로 2차 스캔을 한다.
        ↓
④ 자기보다 오래된 스냅샷을 가진 트랜잭션이 전부 끝나기를 기다린 뒤 VALID로 표시한다.
   (그 트랜잭션들은 "이 인덱스가 없던 시절"의 세계를 보고 있으므로 끝나야 안전하다)
```

**얻는 것**: 쓰기를 한 순간도 막지 않는다. 그리고 `ACCESS EXCLUSIVE`를 잡지 않으므로 사슬 A의 "SELECT까지 줄 서는" 증폭 자체가 없다.

**지불하는 것**은 네 가지이고, 전부 위 4단계에서 그대로 나온다.

- **2회 스캔 + 대기**로 일반 빌드보다 훨씬 오래 걸리고 CPU·I/O를 더 쓴다. "온라인"은 "공짜"가 아니라 "총비용을 더 내는 대신 남을 안 막는다"는 거래다.
- ④의 대기는 **이 테이블을 건드리지 않는 롱 트랜잭션에도 걸린다.** 조건이 "이 테이블을 쓰는 트랜잭션"이 아니라 "오래된 스냅샷을 가진 트랜잭션"이기 때문이다. 다른 테이블의 리포트 하나가 인덱스 생성을 몇 시간 붙잡을 수 있다 — 실행 전 `pg_stat_activity` 점검이 여기서도 필요하다.
- **실패하면 `indisvalid = false`인 무효 인덱스가 남는다.** 유니크 위반, 사용자 취소, 커넥션 끊김 어느 쪽이든 그렇다. 이 무효 인덱스는 **조회에는 쓰이지 않는데 쓰기 비용은 그대로 든다** — 최악의 조합이라 반드시 지워야 한다. 그리고 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`는 무효 인덱스를 "이미 있음"으로 보고 **건너뛴다.** 그래서 재시도 스크립트는 `IF NOT EXISTS`만으로는 안 되고 `indisvalid` 확인 → DROP → 재생성 순서여야 한다(3-3절의 Java 예시).
- **트랜잭션 밖에서만 실행 가능**하므로 마이그레이션 도구 설정이 필요하다(3-3절). 그리고 같은 테이블의 **autovacuum과 서로 기다린다**(둘 다 `SHARE UPDATE EXCLUSIVE`이며, anti-wraparound 상황이 아니면 autovacuum이 양보한다).

```sql
-- 실패 흔적 확인 — 무효 인덱스 (진행 상황은 pg_stat_progress_create_index, PG 12+)
SELECT c.relname, i.indisvalid
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'orders'::regclass AND NOT i.indisvalid;
-- 정리(역시 트랜잭션 밖): DROP INDEX CONCURRENTLY … 또는 PG 12+ REINDEX INDEX CONCURRENTLY …
```

덧붙이면, 도구는 공짜가 아니므로 **테이블이 작거나 쓰기가 없는 시간대라면 일반 `CREATE INDEX`가 더 단순하고 빠르다.** `CONCURRENTLY`는 "쓰기를 막을 수 없을 때" 지불하는 값이지 무조건 옳은 기본값이 아니다.

### 2-2. 제약 — `NOT VALID`로 걸고 `VALIDATE CONSTRAINT`로 검증

제약 추가가 무거운 이유는 **기존 행 전부를 검증하는 스캔**이 잠금 안에서 일어나기 때문이다. 그런데 제약이 하는 일은 사실 두 가지다 — ⑴ **앞으로 들어올 행**을 검사하는 것과 ⑵ **이미 있는 행**이 규칙을 지키는지 확인하는 것. PostgreSQL은 이 둘을 분리하는 문법을 준다.

```sql
-- before: 검증 스캔 내내 잠금 — FK는 양쪽 테이블에 SHARE ROW EXCLUSIVE(쓰기 차단)
ALTER TABLE orders ADD CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users (id);

-- after 1단계: 제약을 "새 행에만 적용"으로 등록 — 스캔 없음, 잠금 순간
ALTER TABLE orders ADD CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;
-- 이 순간부터 INSERT/UPDATE는 검사받는다. 기존 행은 아직 미검증.

-- after 2단계: 기존 행 검증 — SHARE UPDATE EXCLUSIVE(읽기·쓰기 허용)로 전체 스캔
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;
-- 위반 행이 있으면 여기서 실패하고 제약은 NOT VALID로 남는다 → 데이터 정리 후 재실행
```

이름이 오해를 부르기 쉬우니 한 번 짚는다. `NOT VALID`는 "제약이 꺼져 있다"는 뜻이 **아니다.** 새로 들어오는 행은 첫 문장 직후부터 이미 검사받는다. `NOT VALID`가 뜻하는 것은 오직 "**기존 행에 대해서는 아직 확인하지 않았다**"이며, 그래서 무거운 전체 스캔을 별도의 문장으로 미룰 수 있는 것이다.

같은 패턴으로 **`SET NOT NULL`을 우회**한다. `SET NOT NULL` 자체에는 `NOT VALID` 옵션이 없지만, PostgreSQL 12 이상은 "이미 유효한 `CHECK (col IS NOT NULL)` 제약이 있으면 스캔을 생략"해 준다.

```sql
-- before: ACCESS EXCLUSIVE 안에서 전 행 스캔
ALTER TABLE orders ALTER COLUMN coupon_code SET NOT NULL;

-- after (PG 12+)
ALTER TABLE orders ADD CONSTRAINT orders_coupon_code_nn
    CHECK (coupon_code IS NOT NULL) NOT VALID;               -- ① 순간
ALTER TABLE orders VALIDATE CONSTRAINT orders_coupon_code_nn; -- ② 온라인 스캔(쓰기 허용)
ALTER TABLE orders ALTER COLUMN coupon_code SET NOT NULL;     -- ③ 유효한 CHECK를 믿고 스캔 생략 → 순간
ALTER TABLE orders DROP CONSTRAINT orders_coupon_code_nn;     -- ④ 정리(순간)
```

PK와 UNIQUE 추가는 "인덱스는 `CONCURRENTLY`로 먼저 짓고, 제약은 그 인덱스를 입양한다"는 패턴이다.

```sql
CREATE UNIQUE INDEX CONCURRENTLY orders_pkey_new ON orders (id);              -- 온라인
ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY USING INDEX orders_pkey_new;
-- 두 번째 문장은 ACCESS EXCLUSIVE지만 인덱스 빌드가 없어 순간.
-- (컬럼이 아직 NULL 허용이면 여기서 NOT NULL 스캔이 붙는다 → 위의 CHECK 우회를 먼저)
```

**얻는 것**: 긴 스캔이 쓰기를 막지 않는다. **지불하는 것**: 단계가 늘어 절차를 잊기 쉽고(그래서 린트로 잡는다, 3-2절), `NOT VALID` 상태를 방치하면 **플래너가 그 제약을 믿지 못한다.** PostgreSQL 플래너는 유효한 CHECK 제약을 실행 계획 최적화에 활용하는데(예: 파티션 가지치기), 미검증 제약은 그 용도로 쓸 수 없기 때문이다. FK를 걸지 말지의 논쟁 자체는 [34-fk-constraint-in-production-debate.md](34-fk-constraint-in-production-debate.md).

### 2-3. 타입 변경 — 컬럼을 바꾸지 말고 컬럼을 갈아 끼운다

`ALTER COLUMN TYPE`은 재작성 + 인덱스 전부 재생성 + 내내 `ACCESS EXCLUSIVE`다. 수억 건 PK라면 시간 단위 전면 차단이므로, 발상을 바꾼다 — **"컬럼을 바꾸지 말고 컬럼을 갈아 끼운다."** 새 컬럼을 옆에 만들어 두고 데이터를 옮긴 뒤 이름만 교환하는 것이다.

이 절차는 6단계이고, 각 단계가 **어떤 잠금을 얼마나 잡는지**를 붙여서 봐야 왜 무중단인지가 보인다.

```text
[1] Expand       ADD COLUMN id_new bigint             잠금: ACCESS EXCLUSIVE (순간 — 카탈로그만)
     │                                                앱: 구버전도 신버전도 영향 없음
     ↓
[2] 이중 쓰기     BEFORE INSERT OR UPDATE 트리거로     잠금: SHARE ROW EXCLUSIVE (순간)
     │           NEW.id_new := NEW.id                 이 시점 이후의 행은 양쪽이 항상 같다
     ↓                                                = "앞으로 들어올 것"을 먼저 막아 둔다
[3] 배치 백필     UPDATE ... WHERE id BETWEEN $1 AND $2  잠금: 갱신하는 행의 행 잠금뿐
     │           수천~수만 건씩, 배치마다 별도 커밋      비용: 테이블 크기만큼의 죽은 튜플 + WAL
     ↓                                                 = "이미 있던 것"을 뒤에서 따라잡는다
[4] 검증·인덱스   CHECK (id_new IS NOT NULL) NOT VALID  잠금: SHARE UPDATE EXCLUSIVE (온라인)
     │           → VALIDATE
     │           CREATE UNIQUE INDEX CONCURRENTLY
     ↓
[5] 스왑         RENAME 교차 + PK 재부착 (한 트랜잭션)  잠금: ACCESS EXCLUSIVE (순간)
     │                                                전부 카탈로그 작업이라 ms 단위
     ↓                                                실패하면 통째로 롤백 = 되돌아갈 곳이 있다
[6] Contract     트리거 제거 + DROP COLUMN id_old      잠금: ACCESS EXCLUSIVE (순간)
                 구버전 앱이 한 대도 없음을 확인한 뒤   보통 다음 릴리스에서
```

이 도식의 핵심은 **[2]와 [3]의 역할 분담**이다. 트리거가 "지금부터의 쓰기"를 책임지고, 백필이 "과거의 데이터"를 따라잡는다. 둘 중 하나만 있으면 데이터가 어긋나고, 둘이 만나는 순간 두 컬럼은 완전히 같아진다. `NOT VALID` → `VALIDATE`가 "새 행 먼저, 기존 행 나중"으로 쪼갠 것과 정확히 같은 발상이다.

각 단계의 실제 문장은 이렇다.

> ⑴ **Expand**: `ALTER TABLE orders ADD COLUMN id_new bigint;` (순간)
> ⑵ **이중 쓰기**: `BEFORE INSERT OR UPDATE` 트리거로 `NEW.id_new := NEW.id;` — 이 순간부터 새 행·갱신 행은 양쪽이 같다. (`CREATE TRIGGER`는 SHARE ROW EXCLUSIVE이므로 역시 `lock_timeout` 아래에서)
> ⑶ **배치 백필**: `UPDATE orders SET id_new = id WHERE id BETWEEN $1 AND $2`를 수천~수만 건 단위로, 각 배치를 별도 트랜잭션으로, 사이에 잠깐 쉬면서. **PostgreSQL 고유의 비용**이 여기 있다 — UPDATE는 기존 행을 고치는 것이 아니라 **새 튜플 버전을 만들고 옛 버전을 죽은 것으로 표시**하는 방식이라, 백필은 곧 테이블 크기만큼의 죽은 튜플과 WAL을 생산한다. `pg_stat_user_tables.n_dead_tup`으로 autovacuum이 따라오는지 감시하고, 끝나면 `VACUUM (ANALYZE) orders`.
> ⑷ **온라인 검증·인덱스**: `CHECK (id_new IS NOT NULL) NOT VALID` → `VALIDATE`; `CREATE UNIQUE INDEX CONCURRENTLY orders_id_new_key ON orders (id_new);`
> ⑸ **스왑** — 짧은 트랜잭션 하나, `lock_timeout` 아래에서:

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
-- 옛 PK를 참조하는 FK가 있으면 먼저 DROP (나중에 새 컬럼으로 NOT VALID → VALIDATE)
ALTER TABLE orders DROP CONSTRAINT orders_pkey;
ALTER TABLE orders RENAME COLUMN id TO id_old;
ALTER TABLE orders RENAME COLUMN id_new TO id;
ALTER TABLE orders ALTER COLUMN id SET NOT NULL;                 -- 유효한 CHECK 덕에 스캔 생략
ALTER TABLE orders ADD CONSTRAINT orders_pkey PRIMARY KEY USING INDEX orders_id_new_key;
ALTER SEQUENCE orders_id_seq AS bigint OWNED BY orders.id;      -- 시퀀스도 bigint로, 소유 컬럼 이전
ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
COMMIT;   -- 여기까지 전부 카탈로그 작업 = 순간. 실패하면 통째로 롤백.
-- (IDENTITY 컬럼이었다면 시퀀스 대신 ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH …))
```

> ⑹ **Contract**: 트리거 제거, 참조하던 FK를 새 컬럼으로 다시 `NOT VALID` → `VALIDATE`, 구버전 앱이 없음을 확인한 뒤 `DROP COLUMN id_old`(순간).

**얻는 것**: 전면 차단 없이 타입을 바꾼다. **지불하는 것**: 단계가 6개라 절차 자체가 무겁고, 백필 기간 내내 트리거가 모든 쓰기에 끼어들며(경미하지만 0은 아니다), 백필이 만드는 bloat·WAL·레플리카 지연을 감수해야 하고, FK·시퀀스·JPA 매핑을 함께 조율해야 한다. PK가 아닌 일반 컬럼이면 FK·시퀀스 단계가 빠져 훨씬 단순하다. 조율 범위가 너무 크면 2-4절의 논리 복제로 넘어간다.

### 2-4. 재작성이 불가피할 때 — `pg_repack` / 논리 복제

**`pg_repack`(확장)** 은 bloat 해소(`VACUUM FULL` 대체), 물리 재정렬(`CLUSTER` 대체), 인덱스 온라인 재생성을 담당한다. 동작은 MySQL의 pt-osc와 닮았다 — ① 원본에 트리거를 걸어 변경을 로그 테이블에 기록 ② 새 테이블에 전 행 복사 ③ 로그 따라잡기 ④ 시작과 끝에 **짧은 `ACCESS EXCLUSIVE`** 로 교체. 2-3절의 6단계와 발상이 완전히 같고, 그것을 도구가 대신 해 주는 것뿐이다.

대가는 넷이다 — 디스크 2배, **PK 또는 NOT NULL 유니크 인덱스 필수**(어느 행이 어느 행인지 짝지을 키가 있어야 하므로), 트리거 부하, 그리고 **기본 동작이 `--wait-timeout`(기본 60초) 뒤 충돌하는 쿼리를 취소·종료한다**는 것(`--no-kill-backend`로 끌 수 있다). 컬럼 타입 변경 같은 스키마 변경 자체는 못 한다. (bloat의 원인 자체는 [25-mass-delete-archiving-and-partitioning.md](25-mass-delete-archiving-and-partitioning.md).)

**논리 복제**는 테이블 단위로 새 테이블(같은 DB의 `orders_v2`)이나 새 클러스터로 데이터를 흘려보내고, 따라잡으면 짧은 창에 컷오버하는 방식이다. WAL을 물리적으로 재생하는 스트리밍 복제와 달리 **"어느 행이 어떻게 바뀌었다"는 논리 단위로 전달**하므로, 스키마가 다른 대상(`bigint` 컬럼, 파티션 테이블)으로도 복제된다. 그래서 **가장 큰 변경**(PK 타입, 파티셔닝 전환, 메이저 업그레이드)의 정석이다.

대가: `wal_level = logical` 설정, 복제 슬롯(구독이 밀리면 WAL이 쌓여 디스크가 위험해진다), UPDATE/DELETE에 `REPLICA IDENTITY`(보통 PK) 필요, **DDL과 시퀀스 값은 복제되지 않아** 컷오버 때 직접 맞춰야 함, 그리고 앱 쓰기 경로를 전환하는 창.

**(가산점 포인트)** 이름만 알아 두면 좋은 것들: `pg_squeeze`(논리 디코딩 기반 bloat 해소), `pgroll`(Expand/Contract를 뷰로 자동화하는 PostgreSQL 전용 마이그레이션 도구).

### 2-5. 한눈에 비교 — 그리고 넷의 공통 한계

| | 네이티브 온라인 기능 (`CONCURRENTLY`, `NOT VALID`, PG 11 DEFAULT) | 새 컬럼 + 트리거 + 백필 + 스왑 | `pg_repack` | 논리 복제 |
|---|---|---|---|---|
| 해결하는 것 | 인덱스·제약·컬럼 추가 | 타입 변경, 컬럼 재구성 | bloat, 물리 재정렬 | 무엇이든(테이블 통째 교체) |
| 원본 쓰기 부하 | 없음 | 트리거 1개(경미) | 트리거 + 로그 테이블 | WAL 디코딩(프라이머리 CPU) |
| 디스크 | 인덱스 크기 | 컬럼 하나 + 백필 bloat | 2배 | 2배(+ 슬롯 WAL) |
| ACCESS EXCLUSIVE 순간 | 시작(ADD COLUMN 등) | 스왑 트랜잭션 | 시작·끝 | 컷오버 RENAME |
| 전제 | 트랜잭션 밖(CONCURRENTLY) | PK, 단계 관리 | PK/UK, 확장 설치 | `wal_level=logical`, REPLICA IDENTITY |

선택 순서는 **"가벼운 것부터 배제"** 다. ① 카탈로그만 고치는 작업이면 `lock_timeout` + 재시도로 그냥 실행한다 → ② 인덱스·제약이면 `CONCURRENTLY` / `NOT VALID`를 쓴다 → ③ 타입 변경이면 새 컬럼 절차로 간다 → ④ 테이블을 통째로 바꿔야 하면 논리 복제, bloat 해소면 `pg_repack`.

**그리고 넷의 공통 한계가 하나 있다 — `ACCESS EXCLUSIVE` 순간은 어느 절차에도 남는다.** `ADD COLUMN`의 시작, 스왑 트랜잭션, `pg_repack`의 교체, 컷오버의 `RENAME`은 전부 짧지만 `ACCESS EXCLUSIVE`를 잡고, **짧아도 대기열은 생긴다.** 1-2절의 사슬 A는 잠금을 잡는 시간이 아니라 잠금을 **기다리는** 시간의 문제였기 때문이다. 그래서 어느 절차를 고르든 그 순간을 `lock_timeout` 아래에 두고 실패하면 재시도하도록 감싸야 한다. 그게 다음 절의 첫 번째 규칙이다.

> **MySQL 대조**: MySQL의 이 자리는 **pt-online-schema-change**(원본에 트리거 3개를 걸고 PK 청크로 복사한 뒤 `RENAME`으로 교체. 대가: 트리거가 모든 쓰기에 동기로 끼어듦, FK는 `rebuild_constraints`/`drop_swap` 중 선택)와 **gh-ost**(트리거 대신 ROW binlog를 읽어 비동기 적용, 일시정지·교체 연기 가능. 대가: FK 미지원, ROW binlog 필수)가 채운다. 두 도구가 필요한 가장 큰 이유는 MySQL 레플리카가 ALTER 문장을 재실행해 지연이 ALTER 시간만큼 벌어지기 때문인데, PostgreSQL은 그 사슬이 없고 대신 재작성 자체를 피하는 문법이 DB 안에 들어 있다.

---

## 3. 절차를 팀 규칙으로 고정하기 — 안전망과 실무 사례

1~2절의 지식은 **"그날 그 사람이 기억하고 있었는가"에 의존하면 무용지물**이다. 규칙은 사람의 주의력이 아니라 **실행 경로에** 심어야 한다. 이 절의 다섯 규칙은 전부 "잊어도 적용되는가"를 기준으로 골랐고, 마지막 3-6절이 그 필요성을 증명하는 실제 사고다.

### 3-1. 규칙 1 — `lock_timeout`을 짧게 두고, 실패하면 재시도

사슬 A의 "무한 대기"를 끊는 가장 값싼 안전망이다. ALTER가 잠금을 몇 초 안에 못 얻으면 **스스로 실패**하게 만든다. 다시 강조하면 — **실패는 아무에게도 피해를 주지 않는다. 대기가 피해를 준다.**

```sql
-- before: 기본값(0 = 무한 대기) 그대로 → 긴 트랜잭션 하나에 서비스 전체가 인질
ALTER TABLE orders ADD COLUMN coupon_code text;

-- after: 이 트랜잭션에서만 잠금 대기 상한 3초 → 못 얻으면 에러, 대기열도 즉시 해소
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN coupon_code text;
COMMIT;
-- ERROR: canceling statement due to lock timeout (SQLSTATE 55P03) 가 나면
-- → 원흉 트랜잭션을 찾거나(아래 쿼리) 잠시 후 재시도
```

`SET LOCAL`을 쓴 이유가 있다. `SET`은 세션 전체에 남지만 `SET LOCAL`은 **이 트랜잭션이 끝나면 자동으로 원래 값으로 돌아간다** — 마이그레이션용 설정이 같은 커넥션의 다음 작업에 새어 나가지 않게 하는 습관이다.

여기서 짚을 것 하나. `lock_timeout`만 걸고 끝내면 "실패했으니 사람이 다시 친다"가 되어 결국 사람 의존이다. 그래서 **재시도까지 스크립트에 넣는 것이 규칙 1의 완성**이다.

```bash
# 재시도 루프 — 운영 런북 스크립트에 고정 (사람이 F5를 누르지 않게)
# psql은 stdin의 문장을 autocommit으로 하나씩 실행하므로 CREATE INDEX CONCURRENTLY도 같은 틀로 돈다
for i in $(seq 1 30); do
  psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL' && break
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code text;
SQL
  echo "lock timeout — retry $i"; sleep 5
done
```

Flyway SQL 파일처럼 **한 트랜잭션 안에서** 돌아야 하는 자리에는 PL/pgSQL로 같은 루프를 만든다. 트랜잭션 DDL이라 가능한 PostgreSQL 고유의 형태다 — 실패한 ALTER는 서브트랜잭션으로 되감기고, 그때 잠금 요청도 함께 취소된다.

```sql
-- V43__orders_add_coupon_code.sql
DO $$
DECLARE
    attempt int := 0;
BEGIN
    LOOP
        BEGIN
            SET LOCAL lock_timeout = '3s';
            ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code text;
            EXIT;                                      -- 성공
        EXCEPTION WHEN lock_not_available THEN         -- 55P03
            attempt := attempt + 1;
            IF attempt >= 20 THEN
                RAISE;                                 -- 상한 초과 → 마이그레이션 실패(전체 롤백)
            END IF;
            RAISE NOTICE 'lock timeout on orders, retry %', attempt;
            PERFORM pg_sleep(5);
        END;
    END LOOP;
END $$;
-- 주의: 재시도 동안 이 트랜잭션은 열려 있다(스냅샷 보유) — 상한을 짧게 둔다.
```

실행 **전에** 긴 트랜잭션을 확인하고, 실행 **중** 막히면 누가 막는지 보는 쿼리도 런북에 같이 둔다(1-2절의 `pg_blocking_pids()` 쿼리와 함께).

```sql
-- 실행 전: 60초 넘게 열려 있는 트랜잭션 (사슬 A의 원흉 후보) — idle in transaction 포함
SELECT pid, usename, application_name, state,
       now() - xact_start AS xact_age, left(query, 80) AS last_query
FROM pg_stat_activity
WHERE xact_start < now() - interval '60 seconds'
  AND state <> 'idle'
ORDER BY xact_start;

-- 실행 중 막혔을 때: orders에 누가 어떤 잠금을 쥐고(granted) 누가 기다리나
SELECT l.pid, l.mode, l.granted, a.state,
       now() - a.xact_start AS xact_age, left(a.query, 60) AS query
FROM pg_locks l
JOIN pg_stat_activity a USING (pid)
WHERE l.relation = 'orders'::regclass
ORDER BY l.granted DESC, a.xact_start;
```

사람이 잊어도 적용되게 하는 마지막 겹은 **롤 기본값**이다. 마이그레이션 전용 롤에 박아 두면 어떤 도구로 접속하든 따라온다 — 스크립트를 안 쓰고 콘솔에서 쳐도 적용된다는 것이 이 방식의 가치다.

```sql
ALTER ROLE migrator SET lock_timeout = '5s';          -- 잠금 대기 상한
ALTER ROLE migrator SET statement_timeout = '30min';  -- 예상 밖의 재작성이 하루를 먹지 않게
-- 서버 설정: log_lock_waits = on  → deadlock_timeout(1s) 넘게 기다린 잠금이 로그에 남는다
-- 앱 롤: idle_in_transaction_session_timeout → 원흉 자체를 줄인다
--        (긴 트랜잭션의 나머지 해악은 16-long-transaction-harm-and-shortening.md)
```

### 3-2. 규칙 2 — 위험 DDL은 린트로 잡고, 재작성은 DB가 거부하게

1-8절의 "확인"을 개인 습관이 아니라 **CI가 검사**하게 한다. PostgreSQL에는 단언 문법이 없으므로 린트의 대상은 "위험 패턴 자체"가 된다.

```bash
# ci/lint-migrations.sh — 위험 패턴이 있으면 실패 (정규식 수준의 최소 안전망)
dir=src/main/resources/db/migration; fail=0
grep -rniE 'CREATE\s+(UNIQUE\s+)?INDEX\s' "$dir" | grep -viE 'CONCURRENTLY' && fail=1   # ① CONCURRENTLY 없는 인덱스
grep -rniE 'ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\s' "$dir" && fail=1              # ② 재작성: 타입 변경
grep -rniE 'ADD\s+(CONSTRAINT\s+\S+\s+)?(FOREIGN\s+KEY|CHECK)\b' "$dir" | grep -viE 'NOT\s+VALID' && fail=1  # ③ NOT VALID 없는 제약
grep -rniE 'SET\s+NOT\s+NULL' "$dir" && echo "warn: SET NOT NULL — CHECK NOT VALID → VALIDATE 선행 여부 확인"
[ "$fail" -eq 0 ] || { echo "unsafe DDL found — see docs/runbook/schema-change.md" >&2; exit 1; }
```

**(가산점 포인트)** `squawk` 같은 PostgreSQL 전용 마이그레이션 린터는 이 규칙들을 정규식이 아니라 파서 기반으로 검사한다(`require-concurrent-index-creation`, `adding-not-nullable-field`, `changing-column-type` 같은 규칙명).

린트는 저장소를 거치는 SQL만 본다. **콘솔에서 손으로 친 ALTER**까지 막으려면 DB 자신이 거부하게 해야 한다. PostgreSQL의 `table_rewrite` 이벤트 트리거는 `ALTER TABLE`이 재작성을 시작하기 **직전에** 발화하므로, 이미 잠금을 잡은 상태여도 재작성 본체가 시작되기 전에 멈출 수 있다.

```sql
-- 재작성을 DB가 거부하게 — table_rewrite 이벤트 트리거 (슈퍼유저)
CREATE OR REPLACE FUNCTION forbid_table_rewrite() RETURNS event_trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.allow_rewrite', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'table rewrite of % blocked — use the new-column procedure (runbook 2-3) or SET app.allow_rewrite = on to approve explicitly',
            pg_event_trigger_table_rewrite_oid()::regclass;
    END IF;
END $$;

CREATE EVENT TRIGGER no_rewrite ON table_rewrite EXECUTE FUNCTION forbid_table_rewrite();
-- 이제 ALTER COLUMN TYPE처럼 재작성이 필요한 ALTER TABLE은 시작 전에 에러로 멈춘다.
-- 승인된 창에서만 SET app.allow_rewrite = on 으로 통과. (VACUUM FULL/CLUSTER는 별개)
```

### 3-3. 규칙 3 — Flyway/Liquibase: 트랜잭션 DDL의 양날과 `CONCURRENTLY`의 예외

Spring 팀은 대개 Flyway나 Liquibase로 스키마를 버전 관리하고, 기본 설정은 **앱 기동 시 마이그레이션 실행**이다. PostgreSQL에서는 마이그레이션 파일 하나가 **트랜잭션 하나**로 실행된다 — 중간에 실패하면 통째로 롤백되고 "반쯤 적용된 상태"가 남지 않는다. MySQL에는 없는 큰 장점이다.

그런데 그 장점이 함정 셋을 만든다. ⑴ **잠금이 커밋까지 간다** — 1-8절의 "ALTER + 백필을 한 파일에" 함정이 이것이다. ⑵ **`CREATE INDEX CONCURRENTLY`는 트랜잭션 안에서 못 돈다** — 기본 실행 방식 그대로면 `25001`로 실패한다. ⑶ **앱 기동 → 긴 마이그레이션 → readiness 실패 → 컨테이너 kill** — PostgreSQL이 롤백해 주긴 하지만, 다음 기동에서 처음부터 다시 돌아 같은 자리에서 또 죽는 무한 반복이 된다.

규칙은 세 겹이다.

**⑴ 마이그레이션을 앱 기동에서 떼어 파이프라인 단계로 옮긴다.** 앱은 `spring.flyway.enabled=false`로 두고, CI/CD가 배포 직전에 `flyway migrate`를 별도 잡으로 실행한다. 앱은 `spring.jpa.hibernate.ddl-auto=validate`로 **"스키마가 기대와 다르면 기동 실패"** 만 담당한다(관련: [14-unique-constraint-concurrent-insert.md](../03-jpa-orm/14-unique-constraint-concurrent-insert.md)의 "선언은 있는데 실물이 없다"를 잡는 같은 안전망). Flyway가 여는 커넥션에는 3-1절의 타임아웃을 심는다 — `spring.flyway.init-sql=SET lock_timeout = '5s'` 또는 롤 기본값으로.

**⑵ 파일을 "잠금 성격"으로 나눈다.** 순간 DDL은 자기 파일에 혼자 둔다(3-1절의 DO 블록 재시도와 함께). 백필은 마이그레이션이 아니라 **배치 잡**으로 뺀다 — Flyway 트랜잭션 안에서는 배치마다 커밋하는 것이 애초에 불가능하기 때문이다. `CONCURRENTLY`가 필요한 파일은 **트랜잭션 밖으로 빼고 문장 하나만** 둔다 — Flyway는 Java 마이그레이션의 `canExecuteInTransaction()`을 `false`로(최근 버전은 스크립트별 설정으로도 가능), Liquibase는 `<changeSet runInTransaction="false">`. 다만 트랜잭션 밖이므로 실패하면 반쯤 적용될 수 있다 → **멱등하게** 써야 한다(무효 인덱스 정리 후 `IF NOT EXISTS`).

```java
// V44__orders_user_created_idx.java — CONCURRENTLY는 트랜잭션 밖에서, 멱등하게
public class V44__orders_user_created_idx extends BaseJavaMigration {
    // Flyway가 이 마이그레이션을 트랜잭션으로 감싸지 않게 한다.
    // CREATE INDEX CONCURRENTLY는 트랜잭션 블록 안에서 25001로 실패하기 때문이다.
    @Override public boolean canExecuteInTransaction() { return false; }

    @Override
    public void migrate(Context ctx) throws Exception {
        try (var st = ctx.getConnection().createStatement()) {
            st.execute("SET lock_timeout = '3s'");
            // 이전 실행이 중간에 죽었다면 indisvalid = false 인 무효 인덱스가 남아 있다.
            // IF NOT EXISTS는 그것도 "있음"으로 보고 건너뛰므로, 먼저 지워야 재시도가 성립한다.
            try (var rs = st.executeQuery("""
                    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                     WHERE c.relname = 'idx_orders_user_created' AND NOT i.indisvalid""")) {
                if (rs.next()) st.execute("DROP INDEX CONCURRENTLY idx_orders_user_created");
            }
            st.execute("""
                CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user_created
                    ON orders (user_id, created_at)""");
        }
    }
}
```

**⑶ 대형 테이블의 재작성 작업은 Flyway SQL로 쓰지 않는다.** 2-3절의 새 컬럼 절차나 논리 복제 런북으로 **배포와 분리해** 먼저 실행하고, Flyway에는 **"이미 적용됐는지 검증만 하는 게이트 마이그레이션"** 을 둔다 — 사람이 런북을 잊었으면 배포가 실패하도록. Java 마이그레이션이 `information_schema.columns`에서 `orders.id`의 `data_type`이 `bigint`인지 확인하고 아니면 예외를 던지는 식이다(`V43__orders_id_bigint.sql`에 `ALTER TABLE orders ALTER COLUMN id TYPE bigint`를 쓰는 대신 `V43__gate_orders_id_bigint.java`를 둔다). Liquibase라면 `preConditions onFail="HALT"` + `sqlCheck`로 같은 의도를 선언한다.

작은 DDL(순간 작업)은 Flyway SQL로 두되 3-1절의 재시도와 문장 분리를 지킨다. 안전한 것까지 런북으로 보내면 절차가 무거워져 결국 지켜지지 않는다 — 규칙은 **"지킬 수 있을 만큼만 무겁게"**.

### 3-4. 규칙 4 — Expand / Contract: 앱 배포 무중단과 맞물리는 지점

스키마를 무중단으로 바꿔도, **롤링 배포 중에는 구버전과 신버전 앱이 같은 DB를 동시에 본다.** 컬럼을 지우거나 이름을 바꾸는 순간 구버전 앱이 죽고, `ddl-auto=validate`를 켜 뒀다면 구버전 인스턴스가 재기동조차 못 한다. 그래서 파괴적 변경은 **한 릴리스에서 금지**하고 두 단계로 나눈다.

> **Expand(확장)**: 새 컬럼이나 테이블을 **추가만** 한다(카탈로그 작업, 순간). 신버전 앱은 양쪽에 쓰고 새 쪽을 읽는다. 구버전 앱은 새 컬럼의 존재를 몰라도 그대로 동작한다.
> **백필**: 마이그레이션 밖에서 **청크 UPDATE + 배치마다 커밋**으로, 저트래픽 시간대에. PostgreSQL에서는 백필이 곧 "테이블 크기만큼의 죽은 튜플"이므로 `n_dead_tup`과 autovacuum 진행을 보며 속도를 조절하고, 끝나면 `VACUUM (ANALYZE)`. 새 컬럼이 인덱스에 없고 페이지에 여유가 있으면 HOT 업데이트가 되어 인덱스 갱신은 피할 수 있다.
> **Contract(축소)**: 구버전 앱이 **한 대도 남지 않은 것을 확인한 뒤** 다음 릴리스에서 옛 컬럼을 지운다(`DROP COLUMN`은 카탈로그만 고치므로 순간이다. 단 그 컬럼에 의존하는 뷰가 있으면 거부되므로 먼저 확인한다).

순서를 한 줄로 압축하면 이렇다 — **호환되는 스키마 먼저 → 앱 배포(프로세스 교체의 무중단은 [28-graceful-shutdown-zero-downtime-deploy.md](../02-spring/28-graceful-shutdown-zero-downtime-deploy.md)) → 정리 DDL은 다음 릴리스.** 컬럼 이름 변경도 "새 컬럼 추가 → 양쪽 쓰기 → 읽기 전환 → 옛 컬럼 삭제" 네 단계로 푼다. 2-3절의 타입 변경 6단계가 사실 이 Expand/Contract를 한 컬럼에 적용한 것이다. `SELECT *`와 컬럼 위치 기반 매핑을 금지하는 코딩 규칙도 같은 축의 일부다 — 컬럼이 하나 늘거나 순서가 바뀌었을 때 조용히 깨지는 코드를 애초에 안 만드는 것이다.

### 3-5. 규칙 5 — PR 템플릿 체크리스트 (사람이 판단해야 하는 것만 남긴다)

위 규칙들이 기계가 잡는 부분이고, 나머지는 리뷰어가 **같은 질문을 매번 같은 순서로** 던지게 템플릿에 박는다.

```markdown
### 스키마 변경 체크리스트 (DDL이 포함된 PR은 필수)
- [ ] 대상 테이블 현재 행 수 / 크기:            (대형 테이블 목록 해당 여부: 예/아니오)
- [ ] 잠금 수준 / 재작성 여부 판별: 카탈로그만 · 인덱스 빌드 · 전체 스캔 · 재작성 — 근거(relfilenode 확인 여부):
- [ ] 문장·파일을 잠금 성격별로 분리했는가 (순간 DDL과 백필/재작성을 한 트랜잭션에 섞지 않음)
- [ ] 인덱스는 CONCURRENTLY + 트랜잭션 밖 + 무효 인덱스 정리 포함인가 / 제약은 NOT VALID → VALIDATE인가
- [ ] 재작성이면: 새 컬럼 절차 / 논리 복제 / pg_repack 중 선택과 이유 (PK 여부, FK, 레플리카 구성)
- [ ] 스테이징(운영 크기 스냅샷)에서 리허설 — 소요 시간:    임시 디스크:    WAL 증가량:
- [ ] 실행 창: 저트래픽 시간대       / 실행 전 pg_stat_activity 롱 트랜잭션 확인 / lock_timeout 설정 확인
- [ ] 레플리카: 지연 감시 임계치, max_standby_streaming_delay로 취소될 레플리카 쿼리가 있는가
- [ ] Expand/Contract: 이 변경이 구버전 앱과 호환되는가 — 파괴적 변경이면 어느 릴리스에서 Contract 하는가
- [ ] 롤백 방법 (ADD COLUMN → DROP COLUMN / 스왑 → 역스왑 / 옛 컬럼·테이블 보존 기간)
- [ ] 실행자·감시자·연락 채널
```

체크리스트의 역할은 **"생각나게 하기"** 다. 코드나 설정으로 고정할 수 있는 것은 체크리스트에 두지 않고 코드로 옮기는 것이 원칙 — 체크박스는 사람이 여전히 무시할 수 있기 때문이다.

### 3-6. 실무 사례 — "ADD COLUMN은 카탈로그만 고치니 1ms"라며 점심시간에 친 ALTER

상황은 이랬다. `orders`(수억 건)에 `coupon_code` 컬럼을 추가하는 PR이 승인됐다. 리뷰어는 "PostgreSQL 11 이상이고 상수 DEFAULT라 카탈로그만 고치니 1ms면 끝난다"고 했고, 담당자는 점심시간에 운영 DB 콘솔에서 `ALTER TABLE orders ADD COLUMN coupon_code text;`를 실행했다. 12분 뒤 전 API가 타임아웃으로 죽었다.

**여기서 중요한 것은 리뷰어의 판별이 틀리지 않았다는 점이다.** 그 ALTER는 정말로 카탈로그만 고치는 작업이었고, 실제 실행 시간도 밀리초 단위였다. 그런데도 서비스가 12분간 멈췄다 — 1-6절과 1-7절의 판별표는 **실행 시간**을 알려줄 뿐 **대기 시간**은 알려주지 않기 때문이다.

1-2절의 사슬 A가 그대로 재현됐다. 정산팀 대시보드가 **매 시 정각에 리포팅 트랜잭션**을 열어 `orders`를 15분간 읽고 있었다 — 타임라인의 세션 A다. ALTER는 `ACCESS EXCLUSIVE`를 못 얻고 대기했고 `lock_timeout`은 기본값 0(무한)이었다 — 세션 B다. 그 뒤로 `orders`를 읽는 모든 API 요청이 대기열에 섰고(`wait_event = relation`) — 세션 C 이하다. HikariCP 풀 10개가 30초 안에 바닥나 로그인·상품 조회까지 `connection-timeout`으로 실패했고, 헬스체크 실패로 인스턴스가 재시작을 반복했다.

담당자는 `pg_blocking_pids()`로 대기 사슬을 확인했다 — API 세션들이 `{ALTER의 pid}`를 가리키고 ALTER만 `{대시보드의 pid}`를 가리키는, 1-2절에서 본 그 모양이었다. 그래서 ALTER 세션을 `pg_cancel_backend()`로 취소했고 대기열은 즉시 풀렸다. ALTER 자체는 리포팅 트랜잭션이 끝난 직후 재실행해 **정확히 수 밀리초**에 끝났다.

이 사고에서 배운 규칙이 3절 전체다.

- "카탈로그만 고친다"는 판별은 **맞았지만**, 잠금 대기열은 재작성 여부와 무관하다(1-2절). 판별은 절반의 정보다.
- `SET lock_timeout = '3s'`가 있었으면 3초짜리 에러 한 줄로 끝났을 일이다(3-1절). 12분 장애와 3초 에러의 차이가 설정 한 줄이다.
- 실행 전 `pg_stat_activity` 확인이 런북에 있었으면 대시보드 트랜잭션을 미리 봤을 것이다(3-1절).
- 그리고 이 셋을 담당자의 기억이 아니라 **런북 스크립트·롤 기본값·Flyway `init-sql`에 고정**해야 다음 사람이 같은 사고를 안 낸다(3-3절). 이번 담당자는 이제 안 잊겠지만, 다음 담당자는 이 사고를 모른다.

한 문장으로 남길 교훈은 이것이다 — **"리뷰어가 카탈로그 작업임을 확인했다"는 사실은 사슬 A 앞에서 아무 보호가 되지 않았다.**

---

## 4. 꼬리질문 대비 포인트

### "PG 11부터는 DEFAULT 있는 컬럼 추가도 즉시 끝난다는데, 그냥 쳐도 되는 것 아닌가요?"

두 가지로 나눠 답한다. **첫째, 즉시 끝나도 `ACCESS EXCLUSIVE`는 잡는다.** 긴 트랜잭션이 `ACCESS SHARE`를 쥐고 있으면 1ms짜리 ALTER가 그 뒤에서 대기하고, 대기 중인 `ACCESS EXCLUSIVE` 뒤로 들어오는 모든 SELECT가 줄을 서며, 커넥션 풀이 고갈돼 무관한 API까지 죽는다 — 재작성이 아니라 잠금 대기열의 문제다. `lock_timeout` 기본값이 0(무한)이라 스스로 풀리지 않으므로 `SET lock_timeout` + 재시도 절차를 밟는다. **둘째, "즉시"의 조건을 확인해야 한다.** 상수 DEFAULT만 카탈로그(`attmissingval`)에 저장되고, `gen_random_uuid()`나 `clock_timestamp()` 같은 volatile 기본값은 행마다 값이 달라야 하므로 전 행 재작성이다. PostgreSQL에는 `ALGORITHM=INSTANT` 같은 단언 문법이 없어 조용히 재작성으로 넘어가므로, 스테이징에서 relfilenode 변화로 확인하거나 `table_rewrite` 이벤트 트리거로 거부하게 한다. "그냥 쳐도 된다"는 이 두 확인을 생략한 말이다.

### "`CREATE INDEX CONCURRENTLY`는 쓰기를 안 막는데, 그런데도 조심할 게 있나요?"

넷이다. ① **트랜잭션 안에서 못 돈다** — Flyway/Liquibase의 기본 실행이 트랜잭션이므로 설정(`canExecuteInTransaction()` / `runInTransaction="false"`) 없이 넣으면 `25001`로 실패한다. ② **테이블을 두 번 스캔하고, 마지막에 자기보다 오래된 스냅샷을 가진 트랜잭션이 전부 끝나길 기다린다** — 그 트랜잭션이 이 테이블을 건드리지 않아도 그렇다. 그래서 일반 빌드보다 훨씬 오래 걸리고, 실행 전 롱 트랜잭션 점검이 필요하다. ③ **실패하면 `indisvalid = false`인 무효 인덱스가 남는다** — 조회에는 안 쓰이면서 쓰기 비용은 그대로 들고, `IF NOT EXISTS`가 그걸 "있음"으로 보고 건너뛴다. 재시도 스크립트는 `indisvalid`를 확인해 `DROP INDEX CONCURRENTLY` 후 재생성해야 한다. ④ 유니크 인덱스면 빌드 도중 중복이 발견될 때 실패하고 역시 무효 인덱스가 남는다. 반대로 **테이블이 작거나 쓰기가 없는 시간대라면 일반 `CREATE INDEX`(SHARE 잠금)가 더 단순하고 빠르다** — 도구는 공짜가 아니다.

### "`int` PK를 `bigint`로 바꿔야 합니다. 무중단으로 어떻게 하나요?" (시니어 변별 포인트)

먼저 **`ALTER COLUMN TYPE`은 재작성 + 모든 인덱스 재생성 + 내내 `ACCESS EXCLUSIVE`** 라 수억 건 PK에서는 시간 단위 전면 차단이라고 선을 긋는다. 재작성이 불가피한 이유도 한 줄 붙이면 좋다 — `int` 4바이트가 `bigint` 8바이트가 되면 튜플 안 모든 후속 컬럼의 오프셋이 밀리므로 전 행을 다시 쓰는 수밖에 없다. 그 다음 "컬럼을 바꾸지 않고 갈아 끼우는" 6단계 — ⑴ `ADD COLUMN id_new bigint`(순간) ⑵ `BEFORE INSERT OR UPDATE` 트리거로 이중 쓰기 ⑶ PK 범위 청크로 배치 백필(배치마다 커밋, `n_dead_tup`·autovacuum 감시 — PostgreSQL에서는 백필이 곧 죽은 튜플 생산이다) ⑷ `CHECK (id_new IS NOT NULL) NOT VALID` → `VALIDATE`, `CREATE UNIQUE INDEX CONCURRENTLY` ⑸ 짧은 트랜잭션에서 스왑 — 옛 PK DROP, 컬럼 RENAME 교차, `SET NOT NULL`(유효한 CHECK로 스캔 생략), `ADD CONSTRAINT ... PRIMARY KEY USING INDEX`, 시퀀스 `AS bigint OWNED BY`, 전부 `lock_timeout` 아래에서 ⑹ Contract — 트리거 제거, 참조 FK를 `NOT VALID` → `VALIDATE`로 재연결, 구버전 앱 확인 후 `DROP COLUMN id_old`. 대가는 단계 수, 백필 기간의 트리거·bloat·WAL·레플리카 지연, FK·시퀀스·ORM 조율이다. **FK가 많고 조율이 너무 크면 논리 복제로 새 테이블에 통째로 이관**하는 쪽이 낫다는 분기까지 말하면 완결된다. 핵심은 "어느 단계가 `ACCESS EXCLUSIVE`를 잡고, 그것이 왜 순간인가"를 단계마다 붙일 수 있느냐다.

### "Flyway를 쓰는데, PostgreSQL에서 대형 테이블 DDL은 실제로 어떻게 흘러가나요?"

세 겹으로 답한다. ⑴ 마이그레이션 실행을 **앱 기동에서 떼어** 파이프라인 단계로 옮긴다 — 기동 중 긴 DDL은 readiness 실패, 컨테이너 kill, 재기동 반복을 부른다. PostgreSQL은 트랜잭션 DDL이라 반쯤 적용된 상태는 안 남지만, 그 대신 **잠금이 커밋까지 유지**되므로 ALTER와 백필을 한 파일에 두면 안 된다. 앱은 `ddl-auto=validate`로 검증만 하고, Flyway 커넥션에는 `init-sql`이나 롤 기본값으로 `lock_timeout`을 심는다. ⑵ `CREATE INDEX CONCURRENTLY`는 트랜잭션 밖에서만 돌므로 Java 마이그레이션의 `canExecuteInTransaction()`(Liquibase는 `runInTransaction="false"`)으로 빼고, 파일에 문장 하나만 두며 무효 인덱스 정리 후 `IF NOT EXISTS`로 멱등하게 쓴다. ⑶ 재작성이 필요한 변경은 Flyway SQL로 쓰지 않고 새 컬럼 절차나 논리 복제 런북으로 **배포 전에 별도 실행**하며, Flyway에는 `information_schema`로 **적용 여부를 확인만 하는 게이트 마이그레이션**을 둬서 잊으면 배포가 실패하게 한다. **"사람이 런북을 잊으면 어떻게 되나요"에 "배포가 실패합니다"라고 답할 수 있어야** 절차가 있는 팀이다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **분류 축** — MySQL은 `ALGORITHM=INSTANT/INPLACE/COPY`라는 이름표로 분류하고 `ALGORITHM=`을 **단언**해 안 되면 에러로 멈추게 할 수 있다. PostgreSQL은 이름표가 없고 **잠금 수준 × 재작성 여부**로 분류하며, 단언 문법이 없어 relfilenode 확인과 이벤트 트리거로 대신한다. ② **재작성 중 DML** — MySQL의 INPLACE는 재작성하면서도 DML을 허용(온라인 로그)하지만, PostgreSQL의 `ALTER TABLE` 재작성은 내내 `ACCESS EXCLUSIVE`다. 대신 PostgreSQL은 재작성을 **피하는** 문법(`CONCURRENTLY`, `NOT VALID`, PG 11 DEFAULT)이 DB 안에 들어 있다. ③ **잠금 대기열** — 현상은 같다(MDL 큐 대 `ACCESS EXCLUSIVE` 큐). 기본값이 다르다: `lock_wait_timeout` 1년 대 `lock_timeout` 0(무한). 그리고 PostgreSQL은 **DDL이 트랜잭션**이라 마이그레이션 실패가 깨끗이 롤백되지만, 그 때문에 잠금이 커밋까지 유지된다는 함정이 생긴다. ④ **도구 지형** — pt-osc(트리거)와 gh-ost(binlog)의 자리를 PostgreSQL에서는 네이티브 기능 + `pg_repack` + 논리 복제가 채운다. ⑤ **레플리카** — MySQL 레플리카는 ALTER 문장을 재실행해 지연이 곧 ALTER 시간이고(pt-osc/gh-ost가 존재하는 가장 큰 이유), PostgreSQL은 WAL 물리 재생이라 지연이 WAL 양에 비례하며 대신 `ACCESS EXCLUSIVE` 재생으로 레플리카 쿼리가 취소되는 고유 문제가 있다. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "차이를 잠금 모델에서 도출했다"로 들린다.

---

## 한 줄 요약

**PostgreSQL에서 대용량 테이블의 DDL은 재작성 여부와 무관한 `ACCESS EXCLUSIVE` 대기열(긴 트랜잭션의 `ACCESS SHARE` → ALTER 대기, `lock_timeout` 0 = 무한 → 뒤따르는 SELECT까지 대기 → 커넥션 풀 고갈 → 전면 장애)과, 재작성 작업의 자원 비용(내내 잠금·디스크 2배·WAL 폭증·레플리카 지연)이라는 두 사슬로 서비스를 세운다. 그래서 "이 작업이 기존 행의 바이트 배치를 바꾸는가"로 잠금 수준과 재작성 여부를 판별해 — 컬럼 추가·삭제·이름은 카탈로그만(순간, PG 11+), 인덱스는 `CREATE INDEX CONCURRENTLY`(트랜잭션 밖, 2회 스캔, 무효 인덱스 정리), 제약은 `NOT VALID` → `VALIDATE CONSTRAINT`, 타입 변경은 새 컬럼 + 트리거 + 배치 백필 + 스왑 또는 논리 복제, bloat은 `pg_repack` — 으로 처리하고, 어느 절차에도 남는 `ACCESS EXCLUSIVE` 순간을 `lock_timeout` + 재시도로 감싸며, 이 절차를 린트·`table_rewrite` 이벤트 트리거·마이그레이션의 배포 분리와 게이트·Expand/Contract로 사람의 기억이 아니라 팀의 실행 경로에 고정한다.**
