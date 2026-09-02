# 긴 트랜잭션의 해악과 짧게 유지하는 법 — "성능 저하"가 아니라 네 개의 사슬로 말하기

> 핵심 관전 포인트: **"길다"는 벽시계 시간이 아니라 그 트랜잭션이 붙들고 있는 자원으로 정의된다 — 10초가 걸려도 아무것도 안 붙들고 있으면 남에게 해가 없고, 0.5초여도 핫 로우의 배타 락을 쥔 채 외부 API를 기다리면 서비스를 세운다. 붙드는 자원은 넷이고 해악은 그 넷에서 각각 출발하는 네 개의 사슬이다. ① **스냅샷·XID(xmin 지평선)** — "아직 볼 수 있는 옛 버전"의 하한선을 고정 → VACUUM이 그 뒤의 죽은 튜플을 못 치움 → 테이블·인덱스 **bloat** → 통계 왜곡·Index Only Scan 퇴화 → 무관한 조회까지 느려지고, 끝까지 가면 **XID wraparound**로 쓰기가 멈춤. ② **락** — 행 락은 커밋까지, 테이블 `ACCESS SHARE`는 SELECT만 해도 커밋까지 → 대기 큐 → 대기자가 커넥션을 쥔 채 → 풀 고갈 → 톰캣 스레드 고갈 → DB와 무관한 API까지 전면 장애. DDL이 끼면 `ACCESS EXCLUSIVE` 대기열이 뒤의 SELECT까지 세운다. ③ **변경량** — 커밋 순간 죽은 튜플·WAL 한 덩어리 → autovacuum 폭주, 논리 복제·CDC는 커밋 시점에 통째로 전송 → 지연 계단식 급증. ④ **커넥션(= 백엔드 프로세스)** — 락이 하나도 없어도 외부 호출 3초 = 커넥션 3초 독점 → 풀 고갈. 짧게 만드는 기법은 다섯이고 각각 **어떤 자원을 언제 놓아주는가**로 외운다 — **외부 호출을 밖으로 / `TransactionTemplate`로 블록 단위 축소 / 읽기 분리 / `AFTER_COMMIT`·Outbox로 후처리 분리 / 청크 커밋.** 단 쪼개는 순간 원자성을 내주므로 **상태 머신 + 보상 + 재시도·멱등**으로 값을 치르고, "조심하자"가 아니라 **못 어기게** — ArchUnit, `idle_in_transaction_session_timeout`·`lock_timeout`·`statement_timeout`, `pg_stat_activity` 기반 알람으로 고정한다.**

---

## 0. 질문 + 의도

**질문**: "긴 트랜잭션(long transaction)은 DB에 어떤 해악을 끼치나요? 애플리케이션에서 트랜잭션을 짧게 유지하는 방법은?"

**출제 의도**: rationale은 이렇게 적고 있다 — "undo 누적으로 인한 조회 성능 저하, 락 점유 시간, 복제 지연까지 — **'트랜잭션은 짧게'라는 격언의 실제 근거를 메커니즘으로 아는지.** 트랜잭션 범위 안에 파일 처리·외부 호출을 넣은 코드를 리뷰에서 잡는 눈이기도 하다(2장 고난이도와 같은 뿌리)."

rationale의 "undo 누적"은 MySQL 용어다. PostgreSQL로 옮기면 그 자리에 오는 것은 **VACUUM이 치우지 못해 쌓이는 죽은 튜플(bloat)**이고, 이름은 달라도 "누군가 아직 볼 수 있는 옛 버전은 지울 수 없다"는 원리는 같다. 즉 이 문항은 격언을 외웠는지가 아니라 **격언 뒤의 인과 사슬을 단계별로 말할 수 있는지**, 그리고 그 사슬을 알기에 **코드 리뷰에서 `@Transactional` 안의 `restTemplate.postForObject(...)`를 보는 순간 손이 멈추는지**를 본다.

이 문서가 정면으로 겨냥하는 후보자의 습관 네 가지 (4장 약점 노트 기준):

- **① 비용을 "성능 저하"로 뭉뚱그리는 것.** 1-3절부터 1-6절까지는 네 사슬을 도미노처럼 한 칸씩 쓴다. 면접에서 "락 경합이 생겨서 느려집니다"에서 멈추면 이 문항은 "중" 이하다. "락 → 대기 큐 → 커넥션 → 스레드 → 전면 장애"까지, "스냅샷 → VACUUM 정지 → bloat → 무관한 조회 지연"까지 가야 한다.
- **② 트레이드오프를 한쪽만 말하는 것.** 2-8절부터 2-10절까지는 "쪼개면 좋다"가 아니라 쪼개는 순간 **무엇을 잃고 그 값을 어떻게 치르는지**를 같은 호흡에 적는다.
- **③ 안전망을 사람 기억에 맡기는 것.** 3절은 규율이 아니라 장치다 — 컴파일 단계(ArchUnit), DB 단계(타임아웃 세 개), 운영 단계(`pg_stat_activity` 알람).
- **④ 목록 인출 실패.** 2절은 "짧게 만드는 기법 다섯 가지"를 번호 붙은 목록으로 고정한다. 이 다섯을 순서대로 말할 수 있어야 한다.

관련 문서와의 분업 — 이 문서는 **DB 내부에서 무슨 일이 벌어지는가**에 집중한다. `@Transactional` 프록시의 동작·롤백 규칙은 [07-transactional-default-behavior-rollback.md](../02-spring/07-transactional-default-behavior-rollback.md), 트랜잭션 경계를 어디에 긋고 도메인 이벤트·Outbox로 어떻게 쪼개는가는 [22-transaction-boundary-and-domain-events.md](../03-jpa-orm/22-transaction-boundary-and-domain-events.md), 스냅샷과 격리 수준의 관계는 [transaction-isolation-levels.md](./transaction-isolation-levels.md), MVCC의 부품(`xmin`/`xmax`/`ctid`·스냅샷·VACUUM)은 [11-mvcc-postgresql.md](./11-mvcc-postgresql.md), WAL과 롤백의 기본 역할은 [05-transaction-acid.md](./05-transaction-acid.md)를 전제로 한다. 이 문서는 그 위에서 **네 사슬을 나란히 놓고, 애플리케이션 쪽 처방과 그 대가, 안전망**까지 한 벌로 묶는 것이 목적이다.

---

## 1. 개념 — "길다"는 시간이 아니라 "붙들고 있는 자원"이다

### 1-1. 첫 통찰 — 10초짜리가 무해하고 0.5초짜리가 서비스를 세운다

"긴 트랜잭션"이라는 말을 들으면 대부분 벽시계를 떠올린다. 몇 초 이상이면 긴 트랜잭션인가? 그 기준으로는 다음 두 경우를 설명할 수 없다.

| 상황 | 벽시계 시간 | 그동안 붙들고 있는 것 | 남에게 주는 피해 |
|---|---|---|---|
| 배치가 커넥션도 트랜잭션도 열지 않은 채 파일 10초 파싱 | 10초 | 없음 (트랜잭션 자체가 없다) | 없음 |
| 통계 조회가 READ COMMITTED로 `SELECT count(*)` 한 문장 8초 | 8초 | 커넥션 1개 + 그 문장이 뜬 스냅샷 | 커넥션 하나 + 8초짜리 VACUUM 방해 |
| 결제 API가 `UPDATE orders SET status='PAYING'` 직후 PG 응답 0.5초 대기 | 0.5초 | 커넥션 1개 + 그 주문 행의 배타 락 + XID(지평선) | 같은 주문 요청 전부 대기, 그 사이 지평선 고정 |
| 재고 차감 후 외부 API 대기가 초당 50건씩 동시에 0.5초 | 각 0.5초 | 커넥션 50개 + 핫 로우 락 | **풀 고갈 → 전면 장애** |

세 번째와 네 번째 줄이 요점이다. **0.5초는 짧은 시간이지만, 그 0.5초 동안 모두가 원하는 행의 배타 락을 쥐고 있으면 뒤에 오는 요청은 전부 그 0.5초를 더한 시간만큼 밀린다.** 초당 50건이 같은 행을 노리면 대기 큐가 자라고, 대기자는 커넥션을 쥔 채 기다리므로 풀이 마른다. 반대로 첫 줄의 10초는 트랜잭션이 아예 없으니 DB에는 존재하지 않는 시간이다.

그래서 정의를 바꿔야 한다. **긴 트랜잭션이란 "오래 걸리는 트랜잭션"이 아니라 "다른 트랜잭션에 영향을 줄 만큼 오래·많이 자원을 붙들고 있는 트랜잭션"이다.** 면접에서 이 문장을 첫 문장으로 놓으면 다음 질문이 자연스럽게 "무슨 자원을 붙드는데요?"가 되고, 그 답이 이 문서 전체의 뼈대다.

### 1-2. 붙드는 자원 네 가지 — 그리고 길이의 두 축

트랜잭션이 BEGIN에서 COMMIT까지 살아 있는 동안 PostgreSQL이 그 트랜잭션을 위해 붙들어야 하는 것이 넷 있다. 넷 각각이 하나의 사슬로 이어진다.

| 붙드는 자원 | 무엇인가 | 왜 붙드나 | 언제 놓아주나 | 길이의 축 | 사슬 |
|---|---|---|---|---|---|
| 스냅샷·XID(xmin 지평선) | "이 트랜잭션이 볼 수 있는 버전"의 기준선 | 이 트랜잭션이 아직 볼 수 있는 옛 버전을 아무도 못 지우게 | 커밋·롤백 시점 (READ COMMITTED의 읽기 전용 스냅샷은 문장 끝) | 시간 | (a) |
| 행 락(튜플 헤더 `xmax`)·테이블 락(`ACCESS SHARE` 포함) | "이 행/테이블은 내가 쓰는 중" 표시 | 격리성 — 커밋 전까지 남이 못 건드리게 | 커밋·롤백 시점 (중간 해제 불가) | 시간 | (b) |
| 변경 내역(죽은 튜플·WAL·논리 디코딩 버퍼) | 아직 확정·전파되지 않은 변경 더미 | 커밋 시 한꺼번에 확정·전파해야 하므로 | 커밋 시점에 한꺼번에 | **변경량** | (c) |
| 커넥션 1개 = 백엔드 프로세스 1개 | DB 서버의 OS 프로세스 하나 | 한 트랜잭션의 모든 SQL은 같은 커넥션을 타야 하므로 | 커밋·롤백 후 풀 반납 | 시간 | (d) |

"언제 놓아주나" 칸이 전부 **커밋·롤백**이라는 점에 주목한다. 트랜잭션 중간에 "이 락만 먼저 풀어 주세요"는 없다. 그래서 자원을 놓아주는 유일한 방법이 **트랜잭션을 끝내는 것**이고, 2절의 다섯 기법이 전부 "어디서 끊어 커밋할 것인가"의 변주인 이유가 여기 있다.

길이에는 축이 두 개다. 이 둘을 구분해 두면 답이 정확해진다.

- **시간 축** — 열려 있는 시간. 아무 SQL도 안 날리고 외부 API 응답을 기다리기만 해도 (a)(b)(d)는 전부 진행 중이다. DB 입장에선 "실행 중인 쿼리가 없는데 트랜잭션은 열려 있는" 상태 — PostgreSQL이 `pg_stat_activity.state`에 **`idle in transaction`**이라는 이름을 따로 붙여둔 바로 그 상태다.
- **변경량 축** — 얼마나 많은 행을 바꿨는가. 1초 만에 끝나도 500만 행을 UPDATE했다면 (c)의 WAL·죽은 튜플 부피, 그리고 그 뒤 VACUUM이 치워야 할 양 측면에서 긴 트랜잭션이다.

면접에서 "긴 트랜잭션이란?"에 "오래 걸리는 트랜잭션"이라고만 하면 변경량 축을 놓친 것이다. **"오래 열려 있거나, 많이 바꾸거나"** 둘 다다.

### 1-3. 사슬 (a) — xmin 지평선 고정 → VACUUM 정지 → bloat → 무관한 조회까지 지연 → wraparound

네 사슬 중 이것이 **PostgreSQL 고유이면서 가장 먼저 말해야 하는 사슬**이다. 락도 안 잡고 아무것도 안 하면서 그냥 열려만 있는 세션 하나가 테이블 전체를 부풀릴 수 있다는 것이 이 사슬의 결론인데, 이게 왜 가능한지가 직관에 안 맞기 때문이다.

**전제부터 세 줄로.** PostgreSQL은 UPDATE 시 행을 제자리에서 덮어쓰지 않고 **새 버전 튜플을 힙 페이지에 하나 더 쓰고**, 옛 튜플의 헤더에 "이 XID가 나를 지웠다"(`xmax`)를 표시한다. DELETE는 `xmax` 표시만 한다. 즉 옛 버전은 별도 공간이 아니라 **테이블 안에 그대로 남아 있고**, 아무도 볼 수 없게 된 순간부터 "죽은 튜플(dead tuple)"이 되어 **VACUUM**(보통 autovacuum)이 회수한다.

**여기서 "아무도 볼 수 없게 됐다"를 누가 판정하는가가 핵심이다.** 그 기준선의 이름이 **xmin 지평선(xmin horizon)**이다 — 지금 살아 있는 모든 트랜잭션이 붙들고 있는 스냅샷의 `xmin`과 각자의 XID 가운데 **가장 오래된 값**. 지평선보다 나중에 죽은 튜플은 VACUUM이 건드릴 수 없다.

**왜 건드릴 수 없는지를 원리로 말하면 이렇다.** 지평선을 붙들고 있는 그 트랜잭션은 자기가 스냅샷을 뜬 시점의 세상을 볼 **권리**가 있다. 그 시점 이후에 누군가 UPDATE를 커밋했더라도, 그 트랜잭션에게는 여전히 **옛 버전이 정답**이다. 그러니 옛 버전을 지우면 그 트랜잭션이 다음에 그 행을 읽을 때 보여줄 것이 없어진다 — 격리성이 깨진다. VACUUM은 이 가능성을 배제할 수 없으므로 **"지평선보다 나중에 죽은 튜플은 전부 살려 둔다"**는 안전한 쪽을 택한다. 여기서 트랜잭션이 실제로 그 행을 읽을 생각이 있는지, 심지어 SQL을 하나라도 더 보낼 생각이 있는지는 **아무 상관이 없다.** 열려 있다는 사실만으로 권리는 유지되고, 권리가 유지되는 한 청소는 멈춘다. **아무것도 안 하고 `idle in transaction`으로 열려만 있는 세션 하나가 전체 테이블을 부풀리는 이유가 정확히 이것이다.**

이제 도미노를 세운다.

```text
① 트랜잭션 T가 열리고 스냅샷을 잡는다 (REPEATABLE READ면 첫 문장에서 끝까지 고정,
   READ COMMITTED여도 UPDATE 한 줄을 치는 순간 XID가 배정돼 커밋까지 지평선에 박힌다)
   │
② 그 뒤 다른 트랜잭션들이 커밋한 UPDATE/DELETE의 옛 버전은 T가 아직 볼 수도 있으므로
   VACUUM이 지울 수 없다 → 지평선이 T에서 멈춘다
   │      (관측: pg_stat_activity 의 backend_xmin / backend_xid 가 가장 오래된 세션,
   │            VACUUM (VERBOSE) 의 "dead but not yet removable" 숫자가 계속 오른다)
③ 자주 갱신되는 행(재고·잔액·카운터)의 옛 버전이 힙에 쌓인다
   → 초당 100번 갱신되는 행이라면 T가 10분 열려 있는 동안 죽은 버전 6만 개
   → 같은 페이지 안에 못 들어가면 새 페이지로 번지고(HOT 탈락), 그때마다 모든 인덱스에도
     새 엔트리 → 테이블 bloat + 인덱스 bloat
   │
④ 비용이 T와 무관한 트랜잭션에 전가된다
   - 그 행을 읽는 모든 쿼리가 인덱스에서 6만 개 TID를 만나 힙을 찔러 "죽었나"를 하나씩 확인한다
     (모두에게 죽은 뒤에야 스캔이 dead 표시를 남겨 건너뛰는데, 지평선이 막히면 그 표시도 못 남긴다)
   - 죽은 튜플이 섞인 페이지는 visibility map 이 꺼진 채라 Index Only Scan 이 힙을 다시 방문한다
     (Heap Fetches 급증 — 커버링 인덱스 무력화). 부푼 relpages 로 플래너의 비용 계산도 흔들린다
   - T가 커밋된 뒤에도 밀린 죽은 튜플을 autovacuum 이 따라잡느라 I/O 가 치솟고, VACUUM 은 파일
     끝의 빈 페이지만 OS 에 돌려주므로 한 번 부푼 크기는 pg_repack 없이는 줄지 않는다
   │
⑤ T 자신도 느려진다 — T의 조회도 같은 죽은 튜플 더미를 헤치며 자기 버전을 찾으므로
   "배치가 뒤로 갈수록 느려진다"의 원인 중 하나
   │
⑥ 끝까지 가면 wraparound — XID 는 32비트 순환 카운터라 VACUUM 이 오래된 튜플을 주기적으로
   "동결(freeze)"해야 하는데, 동결 기준선도 같은 지평선에 묶인다. T 가 잡고 있는 동안 relfrozenxid 가
   전진하지 못하고 age(datfrozenxid) 만 자란다 → autovacuum_freeze_max_age(기본 2억)를 넘으면 취소
   불가능한 anti-wraparound VACUUM 이 돌고(그래도 T 뒤는 못 치운다), 한계에 다가가면 경고 끝에 쓰기를 거부한다
```

**범인을 30초 안에 특정하는 쿼리.** 이 사슬은 눈에 보이지 않으므로, 의심되면 바로 이것부터 친다. 상세 진단과 알람 설계는 3-3절에 있고, 여기서는 "지평선을 누가 붙들고 있나" 한 줄만 본다.

```sql
-- idle in transaction 으로 열려만 있는 세션이 지평선을 얼마나 오래 붙들고 있나
SELECT pid,
       state,                                -- 'idle in transaction' 이면 DB 밖에서 뭔가를 기다리는 중
       now() - xact_start AS xact_age,       -- 트랜잭션이 열린 지 얼마나 됐나
       backend_xmin,                         -- 이 세션이 붙들고 있는 스냅샷의 xmin (= 지평선 후보)
       left(query, 60) AS last_query         -- 멈추기 직전에 실행한 문장 = 코드의 어느 줄인지 단서
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND state <> 'idle'                        -- 'idle' 은 트랜잭션이 없는 유휴 커넥션 — 무해하다
  AND xact_start < now() - interval '1 minute'
ORDER BY xact_start;
```

**방어 설정 한 줄.** 애플리케이션이 트랜잭션을 열어놓고 잊는 사고는 코드 리뷰로 다 못 막는다. DB 쪽에서 끊는다 — `idle_in_transaction_session_timeout`은 **문장 사이의 공백 시간**을 벽시계로 재서 한계를 넘으면 그 세션을 종료한다. 기본값이 0(무제한)이므로 켜지 않으면 아무것도 안 끊는다. 온라인 서비스 역할에는 30초 안팎이 흔한 출발점이다(자세한 설정 위치와 다른 타임아웃과의 분담은 3-2절).

```sql
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '30s';
```

여기서 반드시 붙여야 할 문장: **"이 사슬은 T가 SELECT만 해도 성립한다."** 락을 하나도 안 잡는 순수 조회 트랜잭션이라도 스냅샷을 쥐고 있는 한 지평선을 붙든다. PostgreSQL 기준으로 정확히는 조건이 둘 — ⓐ **스냅샷을 쥔 상태**(REPEATABLE READ 이상은 첫 문장부터 끝까지, 기본값 READ COMMITTED는 문장이 실행되는 동안과 열어 둔 커서), ⓑ **XID를 배정받은 상태**(무언가 쓴 뒤 커밋·롤백까지). "READ COMMITTED로 읽기만 하고 문장 사이에 놀고 있는" 트랜잭션은 안 붙들지만, 현업에서 흔한 형태 — UPDATE 한 줄 뒤에 외부 API를 기다리는 — 는 ⓑ라 꼼짝없이 붙든다. 리포트를 REPEATABLE READ로 돌리면 30분 내내 ⓐ다(4절 첫 꼬리질문).

(가산점 포인트) **지평선을 붙드는 것은 세션만이 아니다.** "긴 트랜잭션이 없는데 VACUUM이 안 치운다"의 범인 셋 — ① 구독자가 죽은 **논리 복제 슬롯**(`pg_replication_slots.xmin`/`catalog_xmin`) ② 커밋도 롤백도 안 된 **고아 2PC**(`pg_prepared_xacts`) ③ **레플리카의 긴 쿼리**: `hot_standby_feedback = on`이면 스탠바이의 스냅샷이 프라이머리로 전달돼(`pg_stat_replication.backend_xmin`) 프라이머리 VACUUM을 막는다 — 사슬 (a)가 복제선을 타고 넘어오는 것이다.

**롤백은 이 사슬의 비용이 아니다 — PostgreSQL에서는.** 롤백은 `pg_xact`(CLOG)에 "이 XID는 abort"라고 표시만 하는 O(1) 작업이라 500만 행을 바꾸다 롤백해도 즉시 끝나고 락도 즉시 풀린다. 대신 그 500만 개 새 튜플은 죽은 튜플로 남아 VACUUM의 몫이 되고 이미 쓴 WAL은 되돌릴 수 없다 — **비용이 사라진 게 아니라 "롤백하는 세션"에서 "나중의 VACUUM"으로 옮겨졌을 뿐**이다. 그래도 "느리니까 KILL"이 상황을 더 길게 만드는 함정은 PostgreSQL에는 없다(4절 네 번째 꼬리질문).

> **MySQL 대조**: MySQL의 InnoDB는 행을 제자리에서 덮어쓰고 옛 값을 **undo 로그**에 두며, 스냅샷 읽기는 롤 포인터를 따라 **버전 체인**을 거슬러 내려간다. 긴 트랜잭션은 **purge 스레드**를 멈춰 `History list length`를 키우고, 비용은 "체인 순회 + 삭제 마크 레코드 건너뛰기"로 나타난다. 롤백은 undo를 거꾸로 전부 타므로 **변경량에 비례해 오래 걸리고 그동안 락을 쥔다** — PostgreSQL과 가장 크게 갈리는 지점이다. 엔진이 달라도 "누군가 아직 볼 수 있는 옛 버전은 못 지운다"는 원리는 같다.

이 사슬의 부품 수준 세부 — 튜플 헤더와 스냅샷의 가시성 판정, HOT 업데이트와 `fillfactor`, VACUUM이 visibility map을 갱신하는 방식 — 는 [11-mvcc-postgresql.md](./11-mvcc-postgresql.md)에 있다. 이 문서에서는 (a)를 나머지 세 사슬과 **같은 높이**에서 본다.

### 1-4. 사슬 (b) — 락 점유 시간 → 대기 큐 → 커넥션 고갈 → 서비스 전면 영향

```text
① UPDATE / DELETE / SELECT ... FOR UPDATE 가 잡은 행 락은 커밋·롤백까지 절대 안 풀린다
   → 명시적 락이 없어도 UPDATE 문 자체가 행 락(튜플 헤더 xmax)을 잡는다
   → 락이 별도 메모리가 아니라 튜플에 기록되므로 "락 에스컬레이션"은 없다 — 대신 상한도 없다
   │
② 같은 행을 원하는 트랜잭션은 대기한다 (wait_event_type = 'Lock', wait_event = 'transactionid')
   → lock_timeout 기본값 0 = 무한 대기. 아무도 안 정해 주면 영원히 기다린다
   │
③ 대기 중인 트랜잭션은 그동안 자기 커넥션을 쥔 채 아무 일도 못 한다
   → 대기자가 풀 크기(HikariCP 기본 10)만큼 쌓이는 순간 커넥션 풀 고갈
   → 이제 재고 행과 상관없는 요청도 "Connection is not available" (기본 30초 대기 후)
   │
④ 커넥션을 기다리는 요청은 톰캣 워커 스레드를 문 채 대기한다
   → 스레드풀 고갈 → 헬스체크·로그인·정적 응답까지 실패
   → LB가 인스턴스를 제외 → 나머지 인스턴스로 트래픽 쏠림 → 전면 장애
```

핵심 문장: **락은 "행 하나"에 걸렸는데 영향은 "서비스 전체"다.** 그리고 이 사슬은 자기 강화적이다 — 대기 때문에 다른 트랜잭션도 길어지고, 길어진 트랜잭션이 또 락을 오래 쥔다(컨보이).

락 보유 시간이 길수록 서로 다른 순서로 락을 잡는 두 트랜잭션이 겹칠 확률도 올라가 **데드락 빈도**도 함께 오른다. PostgreSQL은 `deadlock_timeout`(기본 1초)만큼 기다려도 안 풀리면 대기 그래프를 검사해 순환을 찾고 한쪽을 `40P01`로 abort한다 — 감지는 되지만 그 1초 동안 둘 다 커넥션을 쥐고 있다.

특히 위험한 두 지점:

- **핫 로우** — 재고, 잔액, 일별 카운터처럼 모두가 갱신하는 행. 락 대기 큐가 가장 빨리 자라고, 사슬 (a)의 죽은 버전도 가장 빨리 쌓이는 곳이다.
- **테이블 락 — `SELECT`도 잡는다.** 트랜잭션이 테이블을 한 번이라도 읽으면 **끝날 때까지 그 테이블에 `ACCESS SHARE` 락**을 쥔다. 평소엔 아무와도 충돌하지 않지만 딱 하나, `ALTER TABLE`이 요구하는 **`ACCESS EXCLUSIVE`**와 충돌한다. 그래서 ALTER는 그 긴 트랜잭션 뒤에 줄을 서고 — 여기가 함정 — **PostgreSQL의 락 대기열은 새치기를 허용하지 않으므로 ALTER 뒤에 도착한 모든 쿼리(단순 SELECT조차)가 ALTER 뒤에 줄을 선다.** "인덱스 하나 추가했는데 테이블 전체가 멈췄다"의 정체이며, 원인은 ALTER가 아니라 그 앞의 긴 트랜잭션이다.

PostgreSQL은 행 락이든 테이블 락이든 대기 상한이 **`lock_timeout` 하나**다. DDL 세션에서 짧게 잡고 재시도하는 절차(`CREATE INDEX CONCURRENTLY`, `NOT VALID` → `VALIDATE` 포함)는 [14-online-ddl-zero-downtime-schema-change.md](./14-online-ddl-zero-downtime-schema-change.md)가 다룬다.

**autovacuum도 이 대기열의 피해자**다 — 일반 autovacuum은 누군가의 락 요청을 막고 있으면 스스로 물러나고(로그의 "canceling autovacuum task"), anti-wraparound VACUUM만은 물러나지 않는다. 긴 트랜잭션 + 잦은 DDL 환경에서 "VACUUM이 돌긴 도는데 끝을 못 낸다"가 여기서 나온다.

> **MySQL 대조**: 같은 사슬이 MySQL에서는 **메타데이터 락(MDL)**이라는 이름으로 존재한다. 다른 점은 타임아웃이 둘로 갈려 있다는 것 — 행 락은 `innodb_lock_wait_timeout`(기본 50초), MDL은 `lock_wait_timeout`(사실상 무제한). PostgreSQL은 `lock_timeout` 하나(기본 0 = 무한)로 둘 다 다스린다. "MySQL은 기본이 50초라 그나마 끊기는데, PostgreSQL은 기본이 무한 대기라 반드시 직접 정해야 한다"가 실무 차이다.

커넥션 고갈 이후의 감별 진단(오래 점유 vs 미반환 누수)은 [26-hikaricp-connection-pool-exhaustion.md](../02-spring/26-hikaricp-connection-pool-exhaustion.md)가 다룬다. 이 문서의 사슬 (b)와 (d)는 그 문서의 "원인 ②·③"이 DB 쪽에서 어떻게 시작되는지에 해당한다.

### 1-5. 사슬 (c) — 대형 트랜잭션 → 죽은 튜플·WAL 한 덩어리 → VACUUM 폭주·복제 지연

이 사슬만은 **시간이 아니라 변경량**이 원인이다. 열어놓고 아무것도 안 하는 트랜잭션은 (c)와 무관하다.

```text
① 500만 행 UPDATE 한 문장 = 새 튜플 500만 + 죽은 튜플 500만이 한 트랜잭션 안에서 생긴다
   → 테이블이 순간 두 배, 인덱스된 컬럼이 바뀌었다면 모든 인덱스에도 500만 엔트리, WAL 도 그만큼
     (체크포인트 직후라면 full_page_writes 로 페이지 전체가 실려 더 커진다)
   │
② 커밋 순간 500만 죽은 튜플이 "치워도 되는 것"으로 한꺼번에 바뀐다
   → autovacuum 이 임계(기본 dead 20%)를 훌쩍 넘긴 테이블을 발견하고 테이블 전체 + 모든 인덱스를
     훑는 대량 VACUUM 을 시작 → 커밋 뒤 한동안 I/O 가 치솟고, 그 사이 Index Only Scan 은
     visibility map 이 꺼진 채라 힙을 다시 방문한다
   │
③ 복제 — 물리(스트리밍)와 논리가 다르게 아프다
   - 물리 복제: WAL 은 커밋을 기다리지 않고 생성되는 대로 흘러가므로 "커밋 순간 계단"은 덜하다.
     대신 스탠바이의 재생은 단일 프로세스라 WAL 폭주를 못 따라가면 replay_lag 이 벌어지고,
     스탠바이의 긴 SELECT 는 재생과 충돌해 취소되거나(max_standby_streaming_delay)
     hot_standby_feedback 으로 프라이머리 VACUUM 을 되려 막는다 — 사슬 (a)로 되돌아간다
   - 논리 복제 / CDC(Debezium 등): 트랜잭션 단위로 모았다가 COMMIT 순간 한 덩어리로 보낸다
     → 커밋되는 순간 구독자에 10분어치가 도착하고 그 뒤 작은 트랜잭션들이 전부 줄을 선다
     → 지연이 계단처럼 뛴다. 모으는 동안 logical_decoding_work_mem 을 넘으면 프라이머리 디스크로
     스필한다 (PostgreSQL 14부터 진행 중 트랜잭션을 미리 흘려보내는 구독 옵션 streaming 이 있지만 기본은 커밋 시점 전송)
   │
④ 레플리카·구독자를 읽는 모든 것이 옛 데이터를 본다
   → 읽기 라우팅을 탄 서비스: "방금 썼는데 목록에 없어요" / 논리 복제 기반 검색 인덱싱·통계·이벤트 발행이 밀린다
   → 동기 복제(synchronous_commit = remote_apply)라면 스탠바이 적용 지연이 프라이머리 커밋 응답 지연으로 되돌아온다
```

큰 트랜잭션 하나가 만든 지연은 **그 트랜잭션이 끝나도 바로 안 풀린다** — 구독자가 밀린 것을 따라잡고 autovacuum이 죽은 튜플을 치울 때까지 지속된다. 지연을 애플리케이션이 어떻게 감지·우회하는지는 [23-read-replica-routing-and-lag.md](../03-jpa-orm/23-read-replica-routing-and-lag.md)를 보라.

이 문서의 처방은 하나다 — **큰 변경을 청크로 나눠 커밋하면 죽은 튜플이 청크 단위로 "치워도 되는 상태"가 되어 autovacuum이 사이사이 따라오고, 논리 복제도 청크 단위로 흘러간다**(2-6절의 기법 ⑤).

> **MySQL 대조**: MySQL의 binlog는 세션별 캐시에 쌓이다가 **COMMIT 순간 한 덩어리**로 기록되고, 리플리카는 그것을 **하나의 트랜잭션으로 재실행**한다(멀티스레드 복제도 트랜잭션 "안"은 못 쪼갠다) → `Seconds_Behind_Source`가 계단처럼 뛴다. PostgreSQL의 **논리 복제**가 정확히 이 양상이고 **물리 복제**는 WAL이 실시간으로 흐르는 만큼 다르다 — "PostgreSQL 레플리카는 괜찮다"가 아니라 "어떤 복제냐에 따라 다르다"고 답한다.

### 1-6. 사슬 (d) — 커넥션 점유 → 풀 고갈 → 무관한 요청까지 대기

(b)와 헷갈리기 쉬운데 **원인이 다르다.** (b)는 락 때문에 남이 기다리는 것이고, (d)는 **락이 하나도 없어도** 트랜잭션이 커넥션을 놀리고 있는 것이다.

```text
① 스프링 @Transactional 은 시작 시점에 커넥션을 빌려 ThreadLocal 에 묶고 끝날 때까지 반납하지 않는다
   → 한 트랜잭션의 모든 SQL 이 같은 커넥션을 타야 하므로 구조적으로 당연
   → PgBouncer 의 transaction pooling 도 마찬가지 — 트랜잭션이 끝나야 서버 커넥션을 남에게 돌린다
   │
② 트랜잭션 안에서 외부 API 3초를 기다리면 커넥션 하나가 3초 동안 아무 SQL 도 없이 점유된다
   → DB 쪽에서 보면 "쿼리 없는 열린 트랜잭션" — pg_stat_activity 에
     state = 'idle in transaction' 이고 query 칸에는 "마지막으로 실행한 문장"이 남아 있는 행
     (이 마지막 문장이 코드의 어느 줄에서 멈춰 있는지를 알려주는 단서다)
   │
③ 리틀의 법칙: 동시 점유 커넥션 ≈ 초당 요청 수 × 평균 점유 시간
   → 초당 20건 × 3초 = 60개 필요. 풀이 10개면 즉시 고갈
   → 원래 10ms 짜리 트랜잭션이라면 20건 × 0.01초 = 0.2개면 충분했다 (300배 차이)
   │
④ 이후는 (b)의 ③④와 합류 — 풀 대기 → 스레드 대기 → 전면 장애
   → 그리고 이 트랜잭션은 (UPDATE 를 이미 쳤다면) XID 도 쥐고 있으므로 (a) 사슬도 동시에 진행 중이다
```

"커넥션이 모자라면 풀을 늘리면 되지 않나?"에 대한 답도 준비해 둔다 — PostgreSQL의 커넥션 하나는 DB 서버에서 **OS 프로세스 하나**와 수 MB의 메모리, 열린 트랜잭션 하나는 스냅샷 하나다. 풀을 60개로 늘리면 (d)는 가려지지만 프로세스 60개가 스냅샷을 계산하며 경합하고 (a)의 지평선 후보가 6배가 된다. 병목(외부 API 대기)을 안 고치고 숫자만 키운 것이다 — 커넥션을 늘리면 왜 처리량이 오히려 꺾이는지(프로세스 모델, PgBouncer가 사실상 필수인 이유)는 [15-connection-count-vs-throughput.md](./15-connection-count-vs-throughput.md)가 따로 다룬다.

### 1-7. 네 사슬 한 장 정리

| 사슬 | 원인 축 | 첫 도미노 | 마지막 도미노 | 관측 지표 |
|---|---|---|---|---|
| (a) 스냅샷·XID | 시간 (읽기만 해도 — RR은 항상, RC는 문장 중·쓰기 후) | 지평선 고정 → VACUUM 정지 | bloat·Index Only Scan 퇴화·통계 왜곡, 끝은 wraparound | 최고령 `backend_xmin`/`backend_xid`, `n_dead_tup`, `age(datfrozenxid)` |
| (b) 락 | 시간 (쓰기·FOR UPDATE, 테이블 락은 SELECT도) | 락 대기 큐 | 풀·스레드 고갈 → 전면 장애, DDL 대기열 | `wait_event_type = 'Lock'` 세션 수, `log_lock_waits`, 데드락 수 |
| (c) 변경량 | 변경 행 수 | 죽은 튜플·WAL 한 덩어리 | autovacuum 폭주, 논리 복제 지연 급증 | `pg_stat_replication.replay_lag`, 슬롯 지연, WAL 생성량 |
| (d) 커넥션 | 시간 (락 없어도) | 프로세스 놀림(`idle in transaction`) | 풀 고갈 → 전면 장애 | `state` 분포, 풀 pending 수 |

면접 답변의 첫 문장은 이 표를 세로로 읽는 것이다 — "**스냅샷, 락, 변경량, 커넥션 — 네 자원 각각에서 사슬이 출발합니다.**" 그리고 하나씩 도미노를 세운다.

---

## 2. 처방과 대가 — 짧게 만드는 다섯 기법, 그리고 원자성이라는 값

원칙 한 줄: **트랜잭션 안에는 "DB 쓰기"와 "그 쓰기를 결정하는 데 꼭 필요한 최소한의 읽기"만 둔다.** 그 외 모든 것 — 외부 API, 파일, 메일, 무거운 계산, 사용자 대기 — 은 트랜잭션 앞이나 뒤로 보낸다. 아래 다섯 기법은 전부 이 원칙을 코드로 옮기는 서로 다른 손잡이이고, 1-2절의 표를 다시 보면 전부 **"어떤 자원을 언제 놓아주는가"**를 앞당기는 일이다.

### 2-1. 무대 — 리뷰에서 손이 멈춰야 하는 코드

먼저 무대가 될 원본 코드. 결제 서비스에서 흔히 보는 형태이고, 리뷰에서 잡아야 하는 코드다.

```java
@Service
@RequiredArgsConstructor
public class OrderPaymentService {

    @Transactional
    public void pay(Long orderId, PaymentCommand cmd) {
        Order order = orderRepository.findById(orderId).orElseThrow();  // ① 첫 SELECT → 스냅샷 + 테이블 ACCESS SHARE 락 (사슬 a·b 시작)
        order.markPaying();                       // ② flush 시 UPDATE → XID 배정 + 행 락(xmax)은 커밋까지 (a 지평선 고정, b)

        PgResult result = pgClient.approve(cmd);  // ③ 외부 PG 호출 2~10초 — 커넥션·락·지평선을 전부 쥔 채 (사슬 d)
        byte[] receipt = receiptRenderer.render(order, result);   // ④ CPU 작업
        s3Client.upload(receiptKey(order), receipt);              // ⑤ 또 외부 I/O

        order.complete(result.approvalNo());                      // ⑥
        paymentHistoryRepository.save(PaymentHistory.of(order, result));
        mailSender.sendReceipt(order);                            // ⑦ 또 외부 — 실패하면 결제까지 롤백?
    }
}
```

이 메서드의 트랜잭션 길이는 **PG 응답 시간 + S3 업로드 시간 + 메일 서버 응답 시간**이다. DB 작업 자체는 수 ms인데 트랜잭션은 수 초다. PG가 느려지는 날 주문 행 락과 커넥션이 수 초씩 잡히고, 초당 주문이 수십 건이면 풀은 몇 초 만에 고갈된다. (여기서 "PG"는 결제 게이트웨이다 — 이 문서에서 데이터베이스는 항상 "PostgreSQL"로 풀어 쓴다.)

### 2-2. 기법 ① — 외부 호출·파일·CPU 작업을 트랜잭션 밖으로

가장 효과가 크고 가장 기계적인 규칙이다. "이 줄이 DB에 SQL을 보내는가?" 아니면 밖으로. 구조는 항상 같다 — **[짧은 트랜잭션 A: 상태 선점] → [트랜잭션 밖: 외부 I/O] → [짧은 트랜잭션 B: 결과 반영]**.

놓아주는 자원으로 말하면 — **외부 I/O가 시작되기 전에 커밋해 커넥션·행 락·지평선을 한꺼번에 반납한다.** 사슬 (a)(b)(d) 셋을 동시에 끊는 유일한 기법이라 다섯 중 첫 번째다.

### 2-3. 기법 ② — `TransactionTemplate`로 경계를 "메서드"에서 "블록"으로 줄인다

`@Transactional`은 선언형이라 편하지만 **경계가 항상 메서드 전체**다. 메서드 안에서 "여기부터 여기까지만"을 표현할 수 없어서, 외부 호출을 빼려면 메서드를 쪼개 별도 빈으로 옮겨야 한다(자기 호출은 프록시를 안 타므로). `TransactionTemplate`은 그 대신 **블록 단위로** 경계를 긋는다.

기법 ①과 ②를 합쳐 원본을 고치면:

```java
@Service
@RequiredArgsConstructor
public class OrderPaymentService {

    private final TransactionTemplate tx;   // PlatformTransactionManager 를 감싼 빈

    // 주의: 이 메서드에는 @Transactional 이 없다 — 있으면 아래 블록들이 전부 여기에 합류해 무의미해진다
    public void pay(Long orderId, PaymentCommand cmd) {

        // [A] 짧은 트랜잭션 — 상태 선점. READY → PAYING 만 허용해 이중 결제를 여기서 막는다
        String paymentKey = tx.execute(status -> {
            Order order = orderRepository.findById(orderId).orElseThrow();
            order.markPaying();                       // 상태가 READY 가 아니면 예외 → 이 블록만 롤백
            return order.getPaymentKey();             // 멱등 키 (주문 생성 시 발급)
        });                                           // ← 커밋: 락·커넥션·지평선 전부 반납. 수 ms

        // [밖] 외부 I/O — 커넥션 0개, 락 0개, 지평선 0개
        PgResult result;
        try {
            result = pgClient.approve(cmd.withIdempotencyKey(paymentKey));
        } catch (PgException e) {
            tx.executeWithoutResult(s ->
                orderRepository.findById(orderId).orElseThrow().markPayFailed(e.code()));
            throw e;
        }

        // [B] 짧은 트랜잭션 — 결과 반영 + 후처리는 "예약"만 (기법 ④)
        tx.executeWithoutResult(status -> {
            Order order = orderRepository.findById(orderId).orElseThrow();
            order.complete(result.approvalNo());
            paymentHistoryRepository.save(PaymentHistory.of(order, result));
            outboxRepository.save(OutboxMessage.of("PaymentCompleted", order.getId()));
        });                                           // ← 커밋. 영수증 생성·S3·메일은 릴레이가 별도 트랜잭션으로
    }
}
```

트랜잭션 길이가 "PG + S3 + 메일"에서 **"UPDATE 한 번" 두 개**로 줄었다. PG가 10초 걸려도 PostgreSQL은 모른다.

`TransactionTemplate`의 함정 하나 — 기본 전파가 `REQUIRED`라서 **호출자가 이미 트랜잭션 안이면 블록들이 전부 거기에 합류**한다. 컨트롤러나 파사드에 `@Transactional`이 붙어 있으면 위 코드는 조용히 원본과 똑같이 긴 트랜잭션이 된다. 그래서 진입점에서 `TransactionSynchronizationManager.isActualTransactionActive()`가 `false`임을 단정하는 테스트를 하나 두거나, "컨트롤러·파사드 계층에는 `@Transactional`을 붙이지 않는다"를 ArchUnit 룰로 고정한다(3-1절).

### 2-4. 기법 ③ — 읽기를 분리한다

쓰기 트랜잭션 안에서 무거운 조회를 하지 않는다. 이유는 사슬 (a) — **쓰기로 XID를 배정받은 트랜잭션은 그 순간부터 지평선에 박히고, 그 뒤의 30초짜리 조회는 30초 동안 지평선을 끌고 간다.** "목록을 조회한 뒤 건별로 갱신"하는 코드를 하나의 `@Transactional`로 감싸면 조회 시작 시점부터 갱신이 끝날 때까지 커넥션과(쓰기 이후엔) 지평선을 쥔다.

```java
// Before: 집계 조회(30초) + 갱신을 한 트랜잭션에 — 30초 동안 커넥션 점유, 쓰기 이후엔 지평선까지
@Transactional
public void closeDailySettlement(LocalDate day) {
    SettlementSummary summary = settlementQuery.aggregate(day);   // 무거운 GROUP BY 30초
    settlementRepository.save(Settlement.close(day, summary));    // 실제 쓰기는 1ms
}

// After: 읽기는 readOnly 트랜잭션(또는 무트랜잭션)으로 따로, 쓰기만 짧게
public void closeDailySettlement(LocalDate day) {
    SettlementSummary summary = settlementQuery.aggregate(day);   // @Transactional(readOnly = true) 인 별도 빈
    settlementCommand.close(day, summary);                        // @Transactional 인 별도 빈 — 1ms
}
```

세 가지를 덧붙이면 좋다.

**(1) 읽기 트랜잭션 자체도 길면 사슬 (a)를 일으킨다.** PostgreSQL의 기본 격리는 READ COMMITTED라 문장이 끝나면 스냅샷을 놓지만 30초짜리 문장 하나는 30초 동안 붙들고, "일관된 스냅샷"이 필요하다며 `REPEATABLE_READ`로 올리면 트랜잭션 전체가 붙든다. 처방은 문장을 쪼개거나(기간별 집계), **레플리카**로 보내는 것이다(그때의 주의점은 4절 첫 꼬리질문).

**(2) `readOnly = true`는 힌트가 아니다.** pgjdbc는 기본 설정(`readOnlyMode=transaction`)에서 이것을 `BEGIN READ ONLY`로 보내고 PostgreSQL이 그 안의 쓰기를 거부하므로 "읽기 빈에서 실수로 쓰는" 사고를 DB가 막는다. 리플리카 라우팅 구조라면 이 분리가 곧 라우팅 조건이다 — [13-transactional-readonly-optimization.md](../02-spring/13-transactional-readonly-optimization.md).

**(3) OSIV(`spring.jpa.open-in-view`)가 켜져 있으면** 컨트롤러·뷰의 지연 로딩이 트랜잭션 밖에서 커넥션을 새로 빌리는 조회로 번진다 — 끄고, 응답에 필요한 데이터는 서비스 안에서 가져온다.

### 2-5. 기법 ④ — 후처리를 이벤트로 트랜잭션 뒤로 보낸다

메일·알림·영수증 생성·검색 인덱스 갱신처럼 **"본 처리가 성공했을 때만, 그리고 본 처리와 운명을 같이할 필요는 없는"** 작업은 커밋 뒤로 보낸다. `@TransactionalEventListener(phase = AFTER_COMMIT)`이 첫 단계이고, 커밋 직후 서버가 죽어도 유실되지 않아야 하면 위 코드처럼 **Outbox 테이블에 같은 트랜잭션으로 INSERT**하고 릴레이가 처리한다.

이 기법의 설계·함정(`AFTER_COMMIT` 리스너 안의 DB 쓰기가 조용히 사라지는 문제 등)은 [22-transaction-boundary-and-domain-events.md](../03-jpa-orm/22-transaction-boundary-and-domain-events.md) §4~§7과 [16-spring-event-transactional-event-listener.md](../02-spring/16-spring-event-transactional-event-listener.md)가 전부 다루므로 여기서는 이름만 고정한다.

### 2-6. 기법 ⑤ — 대량 변경은 청크로 나눠 커밋한다

사슬 (c)와 (a)의 변경량 축을 직접 자르는 기법이다. "500만 건 만료 처리"를 UPDATE 한 문장으로 날리면 죽은 튜플 500만 개가 한 트랜잭션 끝에서 한꺼번에 쏟아지고, 그동안 500만 행의 락과 XID 하나가 지평선을 붙들며, 논리 복제에는 커밋 순간 한 덩어리로 도착한다.

```java
// Before: UPDATE 한 문장이 500만 행 — 한 트랜잭션에 새 튜플 500만 + 죽은 튜플 500만,
//         커밋 순간 논리 복제 구독자가 500만 행을 한 트랜잭션으로 받는다
@Transactional
public void expireCoupons(LocalDate today) {
    couponRepository.expireAllBefore(today);
    // UPDATE coupon SET status = 'EXPIRED' WHERE expires_at < $1 AND status = 'ACTIVE'
}

// After: PK 커서로 5,000건씩 끊어 청크마다 커밋 (청크 워커는 별도 빈 — 자기 호출 금지)
public void expireCoupons(LocalDate today) {
    Long cursor = 0L;
    while (cursor != null) {
        cursor = chunkWorker.expireChunk(today, cursor, 5_000);
    }
}

@Component
public class CouponExpireChunkWorker {

    @Transactional                                          // ← 경계가 청크 하나
    public Long expireChunk(LocalDate today, Long afterId, int size) {
        List<Long> ids = couponRepository.findExpirableIds(today, afterId, size);
        // SELECT id FROM coupon WHERE id > $1 AND expires_at < $2 AND status = 'ACTIVE' ORDER BY id LIMIT $3
        if (ids.isEmpty()) return null;
        couponRepository.expireByIds(ids);
        // UPDATE coupon SET status = 'EXPIRED' WHERE id = ANY($1) AND status = 'ACTIVE'   ← 조건 자체가 멱등
        return ids.get(ids.size() - 1);
    }
}
```

청크마다 락과 XID가 풀려 지평선이 전진하고, 죽은 튜플이 5,000개 단위로 "치워도 되는 상태"가 되어 autovacuum이 사이사이 따라오며, 논리 복제도 5,000행 단위로 흘러가고, 300만 건째에서 실패해도 299만 건은 남는다.

조건에 `status = 'ACTIVE'`를 넣어 **재실행해도 결과가 같게** 만든 것에 주목 — 청크 커밋은 "중간 상태"를 만들기 때문에 재실행 가능성이 곧 세트다(2-9절). Spring Batch의 `chunk(n)`은 이 구조에 **재시작 지점 기록**까지 붙인 것이고, JPA 영속성 컨텍스트 누적 문제까지 포함한 대량 처리 전반은 [21-bulk-insert-jdbc-batch.md](../03-jpa-orm/21-bulk-insert-jdbc-batch.md) §6을 보라.

(가산점 포인트) PostgreSQL이면 SELECT + UPDATE를 **한 문장**으로 합치고, 워커를 여럿 띄워도 서로 안 부딪히게 만들 수 있다:

```sql
-- 청크 하나 = 문장 하나. FOR UPDATE SKIP LOCKED 로 다른 워커가 잡은 행은 건너뛴다
WITH batch AS (
    SELECT id FROM coupon
    WHERE expires_at < $1 AND status = 'ACTIVE'
    ORDER BY id LIMIT 5000
    FOR UPDATE SKIP LOCKED
)
UPDATE coupon c SET status = 'EXPIRED'
FROM batch WHERE c.id = batch.id
RETURNING c.id;                    -- 0행이면 끝. 부분 인덱스 (expires_at) WHERE status = 'ACTIVE' 가 있으면 매 청크가 싸다
```

(가산점 포인트) 청크 크기의 양면 — 작을수록 락·지평선·복제 지연은 줄지만 커밋 횟수(WAL fsync·왕복)가 늘어 총 소요 시간이 길어진다. 그리고 **청크 커밋은 죽은 튜플의 총량을 줄이지 않는다** — 500만 개는 어차피 생긴다. 줄이는 것은 "치울 수 있게 되는 시점"과 "한 번에 쏟아지는 양"이므로 청크 사이에 autovacuum이 따라올 여유(짧은 sleep, 배치 끝의 `VACUUM (ANALYZE) coupon`)까지 설계에 넣고, "1,000~10,000에서 시작해 복제 지연·`n_dead_tup`·처리 시간을 보며 조정한다"처럼 **측정으로 정한다**고 말한다.

### 2-7. 다섯 기법을 "어떤 자원을 언제 놓아주는가"로 — 인출용

기법을 이름으로만 외우면 면접에서 순서가 흐트러진다. 1-2절의 자원 표와 짝지어 외우면 각 기법이 **왜 효과가 있는지**가 같이 나온다.

| 기법 | 놓아주는 자원 | 언제 놓아주게 되나 | 끊는 사슬 |
|---|---|---|---|
| ① 외부 호출·파일·CPU를 밖으로 | 커넥션 + 행 락 + 지평선 (전부) | 외부 I/O가 시작되기 **전에** 커밋해서 | (a)(b)(d) |
| ② `TransactionTemplate` 블록 축소 | 커넥션 + 행 락 + 지평선 (전부) | 메서드 끝이 아니라 **블록 끝에서** | (a)(b)(d) |
| ③ 읽기 분리 | 커넥션 + (쓰기 뒤라면) 지평선 | 무거운 조회를 쓰기 트랜잭션 **밖으로** 빼서 — 문장 단위로 끊거나 레플리카로 | (a)(d) |
| ④ `AFTER_COMMIT`·Outbox | 커넥션 + 행 락 | 후처리가 시작되기 **전에** 본 트랜잭션을 커밋해서 | (b)(d) |
| ⑤ 청크 커밋 | 행 락 + XID + 죽은 튜플의 "치워도 됨" 시점 | **청크마다** | (a)(b)(c) |

한 줄씩 압축한 인출용 목록:

1. **밖으로** — 외부 API·파일·메일·CPU 작업은 트랜잭션 앞뒤로
2. **`TransactionTemplate`** — 경계를 메서드에서 블록으로
3. **읽기 분리** — 무거운 조회는 readOnly로 따로(문장을 쪼개거나 레플리카로)
4. **이벤트로** — 후처리는 `AFTER_COMMIT` + Outbox
5. **청크 커밋** — 대량 변경은 PK 커서로 나눠 커밋, VACUUM이 따라올 틈과 함께

### 2-8. 대가 — 쪼개는 순간 "중간 상태"가 생긴다

여기까지만 말하면 "쪼개면 좋다"는 한쪽 답이다. **하나였던 트랜잭션을 [A] → [밖] → [B]로 나누는 순간, 예전에는 물리적으로 존재할 수 없던 "중간 상태"가 존재하게 된다.** 이것이 대가이고, 대가를 갚는 장치 없이 쪼개면 사고의 종류만 바꾼 것이다.

2-3절의 결제 코드에서 생길 수 있는 중간 상태를 전부 적어 본다:

| 실패 지점 | DB 상태 | 외부(PG) 상태 | 원래 코드였다면 |
|---|---|---|---|
| [A] 커밋 후 PG 호출 전에 서버 사망 | PAYING | 미승인 | 롤백으로 READY 복귀 |
| PG 승인 성공 후 응답 수신 전 타임아웃 | PAYING | **승인됨** | (원래 코드도 같은 문제) |
| PG 승인 후 [B] 커밋 전 서버 사망 | PAYING | 승인됨 | (원래 코드도 같은 문제) |
| 청크 300만 건째 실패 | 299만 건 EXPIRED | — | 전부 롤백, 0건 |

두 번째·세 번째 행은 사실 **원래 코드에도 있던 문제**다 — 외부 시스템은 어차피 DB 트랜잭션에 참여하지 않으므로, 한 트랜잭션에 넣었다고 PG 승인이 롤백되지는 않는다(메일과 마찬가지다). 쪼개기가 **새로 만든** 중간 상태는 첫 번째 행과 네 번째 행이고, 이 둘은 다음 세 장치로 갚는다.

### 2-9. 대가를 갚는 세 장치 — 상태 머신 · 보상 · 재시도+멱등

**① 상태 머신 — 중간 상태를 숨기지 말고 이름 붙인다.** `READY → PAYING → PAID / PAY_FAILED`에서 PAYING은 "PG에 물어보는 중"이라는 **정식 상태**다. 이렇게 두면 2-8절 첫 번째 행의 사고는 "PAYING인데 N분이 지났고 PG 승인 기록이 없는 주문"이라는 **쿼리로 찾을 수 있는 상태**가 된다. 그리고 `markPaying()`이 READY에서만 성공하게 만들면 재시도·중복 요청이 같은 주문을 두 번 결제하는 것을 DB 상태 전이로 막는다(PostgreSQL이라면 `UPDATE ... WHERE status = 'READY' RETURNING id`로 "선점 성공 여부"를 한 문장에 받는 것이 관용구다).

**② 보상(compensation) + 보정 배치 — 롤백이 사라진 자리를 대신한다.** 되돌리는 동작을 직접 만드는 것이 보상이다. PG 승인 뒤 [B]가 실패하면 PG 취소를 호출하고, 그 취소도 실패할 수 있으므로 **오래된 PAYING을 주기적으로 PG에 조회해 대사(對査)하는 보정 배치**가 마지막 그물이다.

```java
@Scheduled(fixedDelay = 60_000)
public void reconcileStalePayments() {
    List<Order> stale = orderRepository.findPayingOlderThan(Duration.ofMinutes(5));
    // SELECT ... FROM orders WHERE status = 'PAYING' AND updated_at < now() - interval '5 minutes'
    for (Order o : stale) {
        PgStatus pg = pgClient.inquire(o.getPaymentKey());     // 멱등 키로 PG 쪽 진실을 묻는다
        switch (pg) {
            case APPROVED -> paymentCommand.complete(o.getId(), pg.approvalNo());   // [B] 재실행
            case NOT_FOUND, CANCELED -> paymentCommand.fail(o.getId(), "reconciled");
            case PENDING -> { /* 다음 주기 */ }
        }
    }
}
```

**③ 재시도 + 멱등 — 재시도는 중복을 만들고, 멱등이 중복을 무해하게 만든다.** [B]를 재실행하려면 [B]가 두 번 실행돼도 결과가 한 번과 같아야 한다. 코드로 옮기면 세 겹이다.

```java
// (1) 도메인 쪽 멱등 — 이미 PAID면 두 번째 호출은 아무 일도 하지 않는다
public void complete(String approvalNo) {
    if (this.status == PAID) return;          // 재실행이 상태를 덮어쓰지 않게
    if (this.status != PAYING) throw new IllegalStateException("PAYING이 아닌 주문: " + status);
    this.status = PAID;
    this.approvalNo = approvalNo;
}
```

```sql
-- (2) 저장 쪽 멱등 — payment_key 유니크 제약이 "두 번째 INSERT"를 DB가 무해하게 만든다
ALTER TABLE payment_history ADD CONSTRAINT uq_payment_key UNIQUE (payment_key);

INSERT INTO payment_history (payment_key, order_id, approval_no, amount)
VALUES ($1, $2, $3, $4)
ON CONFLICT (payment_key) DO NOTHING;    -- 재실행이면 0행 — 예외도 중복 행도 없다
```

세 번째 겹은 **외부 호출의 멱등**이다. PG 요청에 멱등 키를 실어 "응답을 못 받아서 다시 보냈더니 두 번 결제"를 PG 쪽에서 막는다. 2-6절 청크 커밋의 `WHERE ... AND status = 'ACTIVE'`도 같은 원리다 — **재실행이 가능해야 부분 완료가 사고가 아니라 진행 상태가 된다.**

### 2-10. 그래서, 언제 쪼개지 않는가

양면을 완성하려면 반대편도 말해야 한다. **순수 DB 작업만으로 이루어져 있고, 실패 시 함께 되돌려야 하며, 실행 시간이 원래 수 ms인 트랜잭션은 쪼개지 않는다.** 계좌이체의 출금 UPDATE와 입금 UPDATE를 "짧게 하자"고 두 트랜잭션으로 나누는 것은 짧아지는 것도 없이 원자성만 버리는 일이다.

판단 기준은 두 개다 — **① 트랜잭션 안에 블로킹 I/O(외부 호출·파일·사용자 대기)가 있는가 ② 이 부분이 실패하면 본 처리도 되돌려야 하는가.** ①이 있으면 그것을 빼고, ②가 "아니오"면 이벤트로 넘긴다. 둘 다 아니면 그대로 둔다. ([22-transaction-boundary-and-domain-events.md](../03-jpa-orm/22-transaction-boundary-and-domain-events.md) §3의 기준과 같다.)

면접용 한 문장: "**쪼개기는 락·커넥션·bloat·복제 지연을 사는 대신 원자성을 파는 거래이고, 판 원자성은 상태 머신·보상·멱등으로 다시 사 와야 하므로, 블로킹 I/O가 없고 실패 시 함께 되돌려야 하는 작업은 쪼개지 않습니다.**"

---

## 3. 안전망 — "조심하자"가 아니라 "못 어기게"

긴 트랜잭션은 **평소에는 아무 문제가 없다.** PG가 200ms에 응답하는 날엔 2-1절의 원본 코드도 잘 돈다. 문제는 PG가 느려지는 날, 프로모션으로 트래픽이 3배인 날 한꺼번에 터진다. 그래서 리뷰어의 주의력이나 팀 위키의 규칙에 맡길 수 없다 — 세 층으로 장치를 둔다.

### 3-1. 코드 단계 — ArchUnit으로 컴파일 시점에 막는다

```java
@AnalyzeClasses(packages = "com.example")
class TransactionLengthRulesTest {

    // 규칙 1: @Transactional 메서드(또는 그런 클래스의 메서드)는 네트워크·파일 계층에 접근하지 않는다
    @ArchTest
    static final ArchRule 트랜잭션_안에서_외부_IO를_하지_않는다 =
        noMethods().that().areAnnotatedWith(Transactional.class)
            .or().areDeclaredInClassesThat().areAnnotatedWith(Transactional.class)
            .should().accessClassesThat().resideInAnyPackage(
                "org.springframework.web.client..",     // RestTemplate, RestClient
                "org.springframework.web.reactive.function.client..",  // WebClient
                "java.net.http..",                       // HttpClient
                "java.nio.file..", "java.io..",          // 파일
                "software.amazon.awssdk..",              // S3 등
                "org.springframework.mail..")            // 메일
            .because("외부 I/O 응답 시간이 그대로 락 보유 시간·커넥션 점유 시간·VACUUM 정지 시간이 된다");

    // 규칙 2: 클래스 레벨 @Transactional 금지 — 모든 public 메서드가 트랜잭션이 되어 경계가 조용히 넓어진다
    @ArchTest
    static final ArchRule 클래스_레벨_Transactional을_쓰지_않는다 =
        noClasses().should().beAnnotatedWith(Transactional.class);

    // 규칙 3: 진입 계층(컨트롤러·파사드)에는 @Transactional 을 두지 않는다 — TransactionTemplate 블록이 합류해 버린다
    @ArchTest
    static final ArchRule 컨트롤러와_파사드는_트랜잭션을_열지_않는다 =
        noMethods().that().areDeclaredInClassesThat().resideInAnyPackage("..controller..", "..facade..")
            .should().beAnnotatedWith(Transactional.class);
}
```

한계도 같이 말한다 — 인터페이스 뒤에 숨긴 클라이언트(`PgClient` 인터페이스의 구현체가 RestTemplate을 쓰는 경우)는 직접 접근이 아니라 못 잡는다. 그래서 규칙 1에 팀의 클라이언트 인터페이스 패키지(`..infrastructure.client..`)를 명시적으로 추가한다. 완벽하진 않지만 **가장 흔한 위반을 막고, 우회하려면 룰을 고쳐야 하니 논의가 강제된다**는 것이 가치다.

### 3-2. DB·풀 단계 — 사슬을 중간에 끊는 타임아웃

각 타임아웃이 **어느 사슬의 어느 칸**을 끊는지 매핑해 두면 설정값의 의미가 분명해진다. PostgreSQL의 세 타임아웃은 전부 **기본값 0 = 꺼짐**이다 — 아무것도 안 하면 무한 대기·무한 실행·무한 idle이 기본이라는 뜻이고, 이것이 MySQL과의 첫 번째 운영 차이다.

| 설정 | 끊는 지점 | 기본값이 위험한 이유 |
|---|---|---|
| PostgreSQL `lock_timeout` | 사슬 (b) ② 락 대기 큐의 길이 — 행 락과 테이블 락(DDL) 모두 | 0 = 무한 대기. 온라인 트랜잭션은 수 초, DDL 세션은 더 짧게(4절 다섯 번째 꼬리질문) |
| PostgreSQL `statement_timeout` | 문장 하나의 실행 시간 — 사슬 (a)의 "30초짜리 조회" | 0 = 무한. 온라인은 수 초, 배치는 세션에서 따로 올린다 |
| PostgreSQL `idle_in_transaction_session_timeout` | 사슬 (a)(d) — 쿼리 없이 열린 트랜잭션 자체 | 0 = 무한. 켜면 "열어놓고 잊은" 트랜잭션을 DB가 세션째 끊는다 |
| HikariCP `connection-timeout` | 사슬 (b)(d) ③→④ 풀 대기가 스레드 대기로 번지는 것 | 30초 — 빨리 실패시켜 스레드를 돌려줘야 헬스체크가 산다 |
| `@Transactional(timeout = n)` | 애플리케이션 쪽 트랜잭션 수명 상한 | 없음 — 단, 동작 방식에 함정(4절 세 번째 꼬리질문) |

세 가지를 붙인다.

**어디에 설정하나.** 전역값보다 **역할 단위**가 낫다 — `ALTER ROLE app_user SET idle_in_transaction_session_timeout = '30s'`(같은 식으로 `lock_timeout = '3s'`, `statement_timeout = '10s'`), 배치 계정은 다른 값으로. HikariCP `connectionInitSql`로 `SET`을 보낼 수도 있지만 앞에 PgBouncer(transaction pooling)가 있으면 세션 상태를 믿을 수 없으므로 역할 설정이 안전하다.

**타임아웃이 터지면 트랜잭션은 어떻게 되나 (가산점 포인트).** PostgreSQL에서는 `lock_timeout`(`55P03`)이든 `statement_timeout`(`57014`)이든 에러가 나는 순간 **트랜잭션 전체가 실패 상태**가 되고, ROLLBACK을 보낼 때까지 그 커넥션의 모든 문장은 `25P02 current transaction is aborted, commands ignored until end of transaction block`으로 거부된다. 스프링은 예외를 받아 롤백하므로 보통은 깨끗이 끝나지만, 그 예외를 `catch`로 삼키고 다음 SQL을 치면 "이유 모를 25P02 폭풍"이 된다 — **에러가 났으면 그 트랜잭션은 끝난 것이다.**

**한 겹 더.** PostgreSQL 17부터는 문장이 아니라 **트랜잭션 전체의 수명**을 벽시계로 끊는 `transaction_timeout`도 있다 — 4절 세 번째 꼬리질문의 구멍을 DB 쪽에서 막는 설정이다. 운영 버전이 지원하는지 확인하고 쓴다.

> **MySQL 대조**: MySQL의 `innodb_lock_wait_timeout`(기본 50초)은 기본 설정에서 **그 문장만 롤백하고 트랜잭션은 열린 채 남긴다**(앞서 잡은 락은 그대로, 통째로 롤백은 `innodb_rollback_on_timeout=ON`). PostgreSQL은 항상 트랜잭션 전체가 실패 상태가 된다. 방향은 반대지만 결론은 같다 — "예외를 삼키지 말고 롤백하라".

### 3-3. 운영 단계 — `pg_stat_activity`로 긴 트랜잭션을 숫자로 본다

"트랜잭션이 길다"는 측정하지 않으면 감상이다. PostgreSQL은 현재 모든 백엔드의 상태를 `pg_stat_activity`에 노출한다 — 트랜잭션 시작 시각, 상태, 무엇을 기다리는지, 그리고 **지평선을 얼마나 붙들고 있는지**까지. 1-3절의 축약본에 진단용 컬럼을 다 붙인 형태가 아래다.

```sql
-- 30초 넘게 열려 있는 트랜잭션: 누가, 언제부터, 지금 뭘 하나, 마지막 문장, 지평선을 얼마나 붙드나
SELECT pid,
       application_name,
       state,                                                 -- active / idle in transaction / idle in transaction (aborted)
       now() - xact_start                    AS xact_age,     -- 트랜잭션이 열린 지
       now() - state_change                  AS state_age,    -- 이 상태로 머문 지
       wait_event_type, wait_event,                           -- 'Lock' / 'transactionid' 면 사슬 (b)의 피해자
       backend_xid,                                           -- 쓰기를 했으면 배정된 XID (이 순간부터 지평선에 박힘)
       backend_xmin,                                          -- 쥐고 있는 스냅샷의 xmin
       greatest(age(backend_xid), age(backend_xmin)) AS horizon_hold,   -- 지평선을 몇 XID 뒤로 붙들고 있나
       left(query, 80)                       AS last_query    -- idle in transaction 이면 "멈추기 직전에 친 문장"
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND xact_start < now() - interval '30 seconds'
ORDER BY xact_start;
```

읽는 법 — `state = 'idle in transaction'`인데 `xact_age`가 크면 애플리케이션이 트랜잭션을 열어놓고 DB 밖에서 무언가를 기다리는 중이다(사슬 d의 전형). 이때 `last_query`는 MySQL과 달리 NULL이 아니라 **멈추기 직전에 실행한 문장**이라 "코드의 어느 줄 다음에서 멈췄나"를 바로 가리킨다. `backend_xid`가 있으면 쓰기를 한 트랜잭션이니 사슬 (a)가 확실히 진행 중이고, `horizon_hold`가 큰 순으로 정렬하면 **VACUUM을 막는 범인**이 맨 위에 온다. `wait_event_type = 'Lock'`이면 이 트랜잭션도 피해자다 — 누가 막는지는 `pg_blocking_pids(pid)`로 즉시 특정한다. 사슬 (a)의 결과 쪽은 `pg_stat_user_tables`에서 `n_dead_tup`·`n_live_tup`·`last_autovacuum`을 죽은 튜플 많은 순으로 본다.

알람으로 승격할 지표 네 개:

- **긴 트랜잭션 최대 나이** — 위 쿼리의 `max(xact_age)`(`idle in transaction`은 따로). postgres_exporter의 `pg_stat_activity_max_tx_duration`이 이것이다. 0이 아니면 경고, N분 이상이면 즉시 알림.
- **지평선 정체** — `max(greatest(age(backend_xid), age(backend_xmin)))`, 세션이 아닌 범인까지 잡으려면 `pg_replication_slots`의 `age(xmin)`·`age(catalog_xmin)`과 `pg_prepared_xacts` 행 수. 계속 오르면 사슬 (a)가 진행 중이다. wraparound는 `max(age(datfrozenxid))`(`pg_database`)가 `autovacuum_freeze_max_age`에 다가가는지를 본다.
- **죽은 튜플 비율** — 핵심 테이블의 `n_dead_tup / (n_live_tup + n_dead_tup)`과 `last_autovacuum`의 낡음. autovacuum이 돌았는데도 비율이 안 떨어지면 "돌긴 도는데 못 치우는" 상태 = 지평선 정체다.
- **복제 지연** — 물리는 `pg_stat_replication.replay_lag`, 논리는 `pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)`(`pg_replication_slots`). 계단처럼 뛰면 방금 큰 트랜잭션이 커밋된 것이다(사슬 c).

애플리케이션 쪽 짝 — 트랜잭션 소요 시간 Micrometer 타이머와 HikariCP `hikaricp.connections.pending`·acquire 시간은 [22-transaction-boundary-and-domain-events.md](../03-jpa-orm/22-transaction-boundary-and-domain-events.md) §9-2에 있다. **DB 쪽 지표(`pg_stat_activity`의 긴 트랜잭션·지평선 정체)와 앱 쪽 지표(풀 대기)가 같은 시각에 같이 오르면 원인은 긴 트랜잭션**이라고 읽는다.

### 3-4. 테스트로 고정

- **트랜잭션 길이 회귀 테스트** — 결제 서비스의 `pay()`를 호출하면서 `TransactionSynchronization`에 훅을 걸어 각 트랜잭션의 시작~종료 시간을 기록하고, PG 클라이언트를 3초 지연 스텁으로 바꿔도 **트랜잭션 시간이 100ms 미만**임을 단정한다. 외부 호출이 트랜잭션 안으로 다시 들어가면 이 테스트가 즉시 깨진다.
- **Testcontainers** — 락 대기, `ACCESS EXCLUSIVE` 대기열, 에러 후 `25P02`, 데드락 감지는 H2와 PostgreSQL이 다르다. 사슬 (b)를 검증하려면 운영과 같은 엔진이어야 한다.

---

## 4. 꼬리질문 대비 포인트

### "SELECT만 하는 트랜잭션도 길면 해로운가요? 락도 안 잡는데요."

해롭다, 세 가지 이유로 — 단 PostgreSQL에서는 "어떤 SELECT냐"를 한 겹 더 구분해 말해야 정확하다. **① 사슬 (a)** — 스냅샷을 쥐고 있는 동안은 그보다 나중에 죽은 튜플을 VACUUM이 치우지 못한다. REPEATABLE READ 이상이면 첫 문장부터 끝까지, 기본값 READ COMMITTED면 **문장이 실행되는 동안**만 쥔다 — 그러나 30초짜리 GROUP BY 하나는 30초를 쥐고, 앞서 UPDATE 한 줄이라도 쳤다면 XID가 배정돼 문장 사이에도 지평선에 박힌다. 그 사이 핫 로우의 죽은 버전이 쌓여 그 행을 읽는 모든 쿼리가 힙을 반복해서 찌르고, visibility map이 꺼져 Index Only Scan이 힙 페치로 퇴화한다. **② 사슬 (d)** — 커넥션(=프로세스) 하나를 그 시간 내내 점유한다. **③ 테이블 락** — SELECT도 읽은 테이블에 `ACCESS SHARE`를 트랜잭션 끝까지 쥐므로, 그 사이 ALTER가 오면 ALTER가 막히고 그 뒤의 모든 쿼리가 막힌다. 처방은 **격리 수준을 올리지 말고**(REPEATABLE READ로 "일관성"을 사면 30분 내내 지평선을 산다) 문장 단위로 쪼개거나, **레플리카**로 보내 프라이머리의 지평선·락과 분리하는 것 — 단 `hot_standby_feedback = on`이면 그 긴 조회가 복제선을 타고 프라이머리 VACUUM을 막으니, 리포트용 레플리카는 feedback을 끄고 취소(`max_standby_streaming_delay`)를 감수하는 쪽이 정석이다.

### "트랜잭션을 [A]→[PG]→[B]로 쪼갰는데 PG 승인 직후 서버가 죽었습니다. 주문은 PAYING인데 PG는 승인 상태예요. 어떻게 하시겠어요?"

먼저 이 상태가 **원래의 한 트랜잭션 구조에서도 똑같이 생겼을 상태**임을 짚는다 — PG 승인은 DB 롤백으로 취소되지 않으므로, 쪼개기가 만든 문제가 아니라 외부 시스템이 트랜잭션에 참여하지 않는 데서 오는 본질적 문제다. 처방은 세 겹 — **① 상태 머신**: PAYING을 정식 상태로 두어 "PAYING인데 5분 넘은 주문"을 쿼리로 찾을 수 있게 한다. **② 보정 배치**: 그 주문의 멱등 키로 PG에 상태를 조회해 승인이면 [B]를 재실행하고 아니면 실패 처리한다. **③ 멱등**: [B]는 두 번 실행돼도 안전해야 하고(`payment_key` 유니크 + `ON CONFLICT DO NOTHING`, PAID면 무시), PG 요청에는 멱등 키가 실려 재시도가 이중 결제를 만들지 않아야 한다. "쪼개면 원자성을 잃는다"에서 멈추지 않고 **잃은 원자성을 어떤 장치로 되사 오는지**까지 말하는 것이 이 질문의 채점 기준이다.

### "`@Transactional(timeout = 3)`을 걸었는데 안에서 외부 API가 10초 걸려도 안 끊깁니다. 왜죠?"

스프링의 트랜잭션 타임아웃은 **별도 스레드가 트랜잭션을 강제로 끊는 방식이 아니다.** 시작 시점에 마감 시각을 기록해 두고, 이후 그 트랜잭션에서 **SQL을 실행하려 할 때** 남은 시간을 계산해 문장 타임아웃으로 붙이거나, 이미 지났으면 그 시점에 `TransactionTimedOutException`을 던진다. 외부 API를 기다리는 동안은 SQL이 없으니 아무 일도 일어나지 않고, 10초 뒤 돌아와 다음 쿼리를 날리는 순간에야 터진다 — **그 10초 동안 락·커넥션·지평선은 그대로 잡혀 있었다.** 그래서 `timeout`은 "느린 쿼리에 대한 상한"이지 "트랜잭션 안의 외부 호출에 대한 방어"가 아니다. 진짜 방어는 외부 호출을 트랜잭션 밖으로 빼는 것(기법 ①)과, 외부 클라이언트 자체의 연결·읽기 타임아웃이다. DB 쪽에서 이 구멍을 막아 주는 것은 PostgreSQL의 `idle_in_transaction_session_timeout`(문장 사이의 공백을 벽시계로 재서 세션째 끊는다)이고, PostgreSQL 17의 `transaction_timeout`은 트랜잭션 전체 수명을 끊는다 — 앱이 놓쳐도 DB가 끊는 마지막 그물이다.

### "긴 트랜잭션 알람이 울렸습니다. 해당 세션을 끊으면 되나요?" (시니어 변별 포인트)

바로 끊지 않는다 — 다만 이유가 MySQL과 다르다. PostgreSQL의 롤백은 `pg_xact`에 abort 표시만 하는 **O(1)**이라 "KILL했더니 롤백이 실행 시간만큼 걸리며 락을 쥔다"는 함정은 없고, 끊는 순간 락과 지평선은 즉시 풀린다. 그래도 순서가 있다. **① 정체 파악** — `state`가 `idle in transaction`이면 외부 대기 중인 애플리케이션 트랜잭션(`query`의 마지막 문장으로 코드 위치를 짚고 앱 스레드 덤프 확인), `active`면 느린 SQL, `wait_event_type = 'Lock'`이면 이 트랜잭션도 피해자다 — `pg_blocking_pids()`로 진짜 가해자를 찾는다. **② 피해 범위** — 이 pid에 막힌 세션 수, `horizon_hold` 크기, 풀 대기 추이. **③ 어떻게 끊나** — `active`면 먼저 `pg_cancel_backend(pid)`(문장만 취소, 커넥션은 살려 앱이 예외를 받고 스스로 롤백하게), `idle in transaction`은 취소할 문장이 없으니 `pg_terminate_backend(pid)`(세션 종료 — 앱은 다음 SQL에서 끊김 예외를 받고 HikariCP가 그 커넥션을 폐기한다). **④ 비용 비교** — 롤백은 싸지만 **그 트랜잭션이 만든 죽은 튜플은 그대로 VACUUM 몫**이고, 곧 끝날 대량 배치라면 "처음부터 다시" 비용과 지금 대기자들의 피해를 저울질한다. **⑤ 사후** — 알람이 울렸다는 것은 3-1·3-2절 장치가 뚫렸다는 뜻이므로 그 경로를 룰에 추가하고 `idle_in_transaction_session_timeout`이 왜 안 끊었는지(설정 누락? 배치 계정?)를 확인한다. "끊으면 됩니다"와 "가해자인지 피해자인지 가르고, cancel과 terminate를 구분하고, 죽은 튜플 후유증을 계산합니다"의 차이가 시니어 변별점이다.

### "트래픽이 거의 없는 테이블에 컬럼 하나 추가했는데 서비스 전체가 멈췄습니다. 긴 트랜잭션과 무슨 관계죠?" (가산점 포인트)

`ACCESS EXCLUSIVE` 대기열 사슬이다. 어떤 긴 트랜잭션이 그 테이블을 **한 번이라도 읽은 적이 있으면** 트랜잭션 끝까지 `ACCESS SHARE`를 쥔다. `ALTER TABLE ... ADD COLUMN`은 `ACCESS EXCLUSIVE`가 필요하므로 그 트랜잭션이 끝날 때까지 대기하고, PostgreSQL의 락 대기열은 새치기를 허용하지 않으므로 **ALTER 뒤에 도착한 모든 쿼리 — 단순 SELECT까지 — 가 ALTER 뒤에 줄을 선다.** 트래픽이 적은 테이블이어도 그 테이블을 조인하는 쿼리는 전부 멈추고, 그 쿼리들이 커넥션을 쥔 채 대기하니 사슬 (b)의 ③④로 이어진다. 함정은 **ADD COLUMN 자체는 PostgreSQL 11부터 상수 DEFAULT여도 카탈로그만 고치는 순간 작업**이라는 것 — 느린 건 ALTER가 아니라 **락을 얻기까지의 대기**다. 처방: DDL 세션에서 `SET lock_timeout = '2s'`로 "못 잡으면 빨리 실패"하게 하고 잠시 후 재시도하는 루프로 돌리며, 실행 전 `pg_stat_activity`로 그 테이블을 쥔 긴 트랜잭션이 없는지 확인하고, 인덱스는 `CREATE INDEX CONCURRENTLY`로 `ACCESS EXCLUSIVE` 자체를 피한다. "행 락 타임아웃과 DDL 대기 타임아웃이 PostgreSQL에선 `lock_timeout` 하나"까지 말하면 운영 경험이 드러난다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **옛 버전이 사는 곳 → 해악의 이름**: MySQL의 InnoDB는 undo 로그에 두고 purge가 치우므로 "History list length 증가·버전 체인 순회", PostgreSQL은 힙 안에 두고 VACUUM이 치우므로 "bloat·visibility map 퇴화·wraparound" — 원리는 같고 계산서의 이름만 다르다. ② **롤백 비용**: InnoDB는 undo를 되감아 변경량에 비례하고 그동안 락을 쥔다("KILL이 상황을 늘린다"). PostgreSQL은 O(1)이라 그 함정은 없지만 죽은 튜플 청소가 VACUUM으로 이월된다. ③ **락 타임아웃**: MySQL은 행 락 50초 + MDL 무제한의 두 변수, PostgreSQL은 `lock_timeout` 하나에 기본 0(무한) — 반드시 직접 정해야 한다. 타임아웃 후 MySQL은 문장만 롤백하고 트랜잭션을 살려 두지만 PostgreSQL은 트랜잭션 전체가 실패 상태(`25P02`)다. ④ **복제 지연의 모양**: MySQL binlog는 커밋 순간 한 덩어리 → 계단식 지연. PostgreSQL은 물리 복제면 WAL이 실시간으로 흘러 계단이 덜하고, **논리 복제·CDC**만 MySQL과 같은 양상이다. ⑤ **관측 창구**: MySQL은 `information_schema.innodb_trx`(`trx_query`가 NULL이면 외부 대기), PostgreSQL은 `pg_stat_activity`(`idle in transaction` + 마지막 문장 + `backend_xmin`으로 지평선 정체까지 한 뷰에서). 이 다섯을 짚으면 "저장 구조의 차이에서 운영 차이를 도출한다"로 들린다.

---

## 한 줄 요약

긴 트랜잭션은 벽시계 시간이 아니라 **붙들고 있는 자원**으로 정의되며, 해악은 "느려진다"가 아니라 **스냅샷·XID(지평선을 고정해 VACUUM을 멈춰 bloat·Index Only Scan 퇴화·wraparound로) · 락(대기 큐 → 커넥션 → 스레드 → 전면 장애, DDL이 끼면 `ACCESS EXCLUSIVE` 대기열) · 변경량(죽은 튜플·WAL 한 덩어리 → autovacuum 폭주·논리 복제 지연 급증) · 커넥션(락 없이도 프로세스 하나 독점 → 풀 고갈)** 네 자원에서 출발하는 네 사슬의 문제이고, 처방은 **외부 호출 밖으로 / `TransactionTemplate` 블록 축소 / 읽기 분리 / `AFTER_COMMIT`·Outbox / 청크 커밋** 다섯 가지인데 각각이 어떤 자원을 언제 놓아주는지로 외워야 인출이 되며, 쪼개는 순간 원자성을 내주므로 **상태 머신·보상·재시도+멱등**으로 되사 와야 하고, 이 모든 것은 사람의 주의가 아니라 **ArchUnit·`lock_timeout`·`statement_timeout`·`idle_in_transaction_session_timeout`·`pg_stat_activity` 알람**으로 못 어기게 고정해야 비로소 "트랜잭션은 짧게"가 격언이 아니라 시스템의 성질이 된다.
