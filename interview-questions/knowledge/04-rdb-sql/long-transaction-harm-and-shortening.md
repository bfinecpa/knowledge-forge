# 긴 트랜잭션의 해악과 짧게 유지하는 법 — "성능 저하"가 아니라 네 개의 사슬로 말하기

> 핵심 관전 포인트: **긴 트랜잭션의 해악은 "성능 저하" 하나가 아니라,
> 트랜잭션이 열려 있는 동안 붙들고 있는 네 가지 자원에서 각각 출발하는
> 네 개의 사슬이다.** ① **undo(과거 버전 보존 의무)** — 열린 스냅샷이
> purge를 막음 → history list 증가 → 버전 체인 순회·삭제 마크 행
> 건너뛰기 비용 → 이 트랜잭션과 무관한 조회까지 느려짐 ② **락** —
> 커밋까지 유지 → 대기 큐 → 대기자가 커넥션을 쥔 채 → 풀 고갈 → 톰캣
> 스레드 고갈 → DB와 무관한 API까지 전면 장애 ③ **변경량** — 커밋 순간
> binlog 한 덩어리 → 리플리카가 단일 트랜잭션으로 재실행 → 복제 지연
> 계단식 급증 ④ **커넥션** — 락이 하나도 없어도 외부 호출 3초 = 커넥션
> 3초 독점 → 풀 고갈. 짧게 만드는 기법은 다섯 — **외부 호출을 밖으로 /
> `TransactionTemplate`로 블록 단위 축소 / 읽기 분리 / `AFTER_COMMIT`·
> Outbox로 후처리 분리 / 청크 커밋.** 단 쪼개는 순간 원자성을 내주므로
> **상태 머신 + 보상 + 재시도·멱등**으로 값을 치르고, "조심하자"가 아니라
> **못 어기게** — ArchUnit, `innodb_lock_wait_timeout`,
> `information_schema.innodb_trx` 기반 알람으로 고정한다.

---

## 0. 질문 + 의도

**질문**: "긴 트랜잭션(long transaction)은 DB에 어떤 해악을 끼치나요?
애플리케이션에서 트랜잭션을 짧게 유지하는 방법은?"

**출제 의도**: rationale은 이렇게 적고 있다 — "undo 누적으로 인한 조회
성능 저하, 락 점유 시간, 복제 지연까지 — **'트랜잭션은 짧게'라는 격언의
실제 근거를 메커니즘으로 아는지.** 트랜잭션 범위 안에 파일 처리·외부
호출을 넣은 코드를 리뷰에서 잡는 눈이기도 하다(2장 고난이도와 같은
뿌리)." 즉 이 문항은 격언을 외웠는지가 아니라 **격언 뒤의 인과 사슬을
단계별로 말할 수 있는지**, 그리고 그 사슬을 알기에 **코드 리뷰에서
`@Transactional` 안의 `restTemplate.postForObject(...)`를 보는 순간
손이 멈추는지**를 본다.

이 문서가 정면으로 겨냥하는 후보자의 습관 네 가지 (4장 약점 노트 기준):

- **① 비용을 "성능 저하"로 뭉뚱그리는 것.** §2는 네 사슬을 도미노처럼
  한 칸씩 쓴다. 면접에서 "락 경합이 생겨서 느려집니다"에서 멈추면 이
  문항은 "중" 이하다. "락 → 대기 큐 → 커넥션 → 스레드 → 전면 장애"까지
  가야 한다.
- **② 트레이드오프를 한쪽만 말하는 것.** §4는 "쪼개면 좋다"가 아니라
  쪼개는 순간 **무엇을 잃고 그 값을 어떻게 치르는지**를 같은 호흡에
  적는다.
- **③ 안전망을 사람 기억에 맡기는 것.** §5는 규율이 아니라 장치다 —
  컴파일 단계(ArchUnit), DB 단계(타임아웃), 운영 단계(`innodb_trx` 알람).
- **④ 목록 인출 실패.** §3은 "짧게 만드는 기법 다섯 가지"를 번호 붙은
  목록으로 고정한다. 이 다섯을 순서대로 말할 수 있어야 한다.

관련 문서와의 분업 — 이 문서는 **DB 내부에서 무슨 일이 벌어지는가**에
집중한다. `@Transactional` 프록시의 동작·롤백 규칙은
[transactional-default-behavior-rollback.md](../02-spring/transactional-default-behavior-rollback.md),
트랜잭션 경계를 어디에 긋고 도메인 이벤트·Outbox로 어떻게 쪼개는가는
[transaction-boundary-and-domain-events.md](../03-jpa-orm/transaction-boundary-and-domain-events.md),
스냅샷과 격리 수준의 관계는
[transaction-isolation-levels.md](./transaction-isolation-levels.md),
MVCC의 부품(숨은 컬럼·undo 체인·Read View)은 [mvcc-innodb.md](./mvcc-innodb.md),
undo/redo의 기본 역할은 [transaction-acid.md](./transaction-acid.md)를
전제로 한다. 이 문서는 그 위에서 **네 사슬을 나란히 놓고, 애플리케이션
쪽 처방과 그 대가, 안전망**까지 한 벌로 묶는 것이 목적이다.

## 1. "길다"의 정의 — 시간이 아니라 "붙들고 있는 자원"으로

"긴 트랜잭션"은 벽시계로 몇 초 이상이라는 기준이 아니다. **트랜잭션이
BEGIN에서 COMMIT까지 살아 있는 동안 DB가 그 트랜잭션을 위해 붙들어야
하는 것**이 네 가지 있고, 그 넷 중 어느 하나라도 "다른 트랜잭션에
영향을 줄 만큼" 오래·많이 붙들면 긴 트랜잭션이다.

| 붙드는 자원 | 왜 붙드나 | 길이의 축 | 사슬 |
|---|---|---|---|
| undo 로그(과거 버전) | 롤백 + 다른 트랜잭션의 스냅샷 읽기를 위해 | 시간 | (a) |
| 행 락·갭 락·메타데이터 락 | 격리성 — 커밋 전까지 남이 못 건드리게 | 시간 | (b) |
| 변경 내역(binlog 캐시·redo) | 커밋 시 한꺼번에 확정·전파해야 하므로 | **변경량** | (c) |
| 커넥션 1개 | 한 트랜잭션의 모든 SQL은 같은 커넥션을 타야 하므로 | 시간 | (d) |

두 개의 축을 구분해 두면 답이 정확해진다:

- **시간 축** — 열려 있는 시간. 아무 SQL도 안 날리고 외부 API 응답을
  기다리기만 해도 (a)(b)(d)는 전부 진행 중이다. DB 입장에선 "실행 중인
  쿼리가 없는데 트랜잭션은 열려 있는" 상태 — PostgreSQL이
  `idle in transaction`이라는 이름을 따로 붙여둔 바로 그 상태다.
- **변경량 축** — 얼마나 많은 행을 바꿨는가. 1초 만에 끝나도 500만 행을
  UPDATE했다면 (c)와 (a)의 undo 부피, 그리고 롤백 비용 측면에서 긴
  트랜잭션이다.

면접에서 "긴 트랜잭션이란?"에 "오래 걸리는 트랜잭션"이라고만 하면
변경량 축을 놓친 것이다. **"오래 열려 있거나, 많이 바꾸거나"** 둘 다다.

## 2. 해악 네 사슬 — 도미노 한 칸씩

### 2-1. 사슬 (a) — undo 누적 → purge 지연 → 버전 체인 순회 → 무관한 조회까지 지연

MVCC를 두 줄로 복습한다. InnoDB는 UPDATE 시 행을 **제자리에서 덮어쓰고**,
덮어쓰기 전 값을 **undo 로그**에 보관한다. 각 행에는 숨은 컬럼으로
"마지막으로 이 행을 바꾼 트랜잭션 ID"와 "이전 버전이 있는 undo 위치를
가리키는 롤 포인터"가 붙어 있어서, 행 → 이전 버전 → 그 이전 버전으로
이어지는 **버전 체인**이 만들어진다. 스냅샷 읽기를 하는 트랜잭션은 최신
행이 자기 스냅샷보다 나중 것이면 롤 포인터를 따라 **자기가 봐야 할
버전이 나올 때까지 체인을 거슬러 내려간다.**

이제 도미노를 세운다.

```text
① 트랜잭션 T가 열리고 첫 SELECT에서 스냅샷(read view)이 만들어진다 (REPEATABLE READ)
   │
② 그 뒤 다른 트랜잭션들이 커밋한 변경의 "이전 버전"은 T가 아직 볼 수도 있으므로
   지울 수 없다 → purge 스레드가 T의 스냅샷 지점에서 멈춘다
   │      (관측: SHOW ENGINE INNODB STATUS 의 "History list length" 가 계속 오른다)
③ 자주 갱신되는 행(재고·잔액·카운터)의 버전 체인이 길어진다
   → 초당 100번 갱신되는 행이라면 T가 10분 열려 있는 동안 체인 6만 개
   │
④ 비용이 T와 무관한 트랜잭션에 전가된다
   - 그 행을 스냅샷으로 읽는 모든 트랜잭션이 체인을 순회한다 (T만이 아니다)
   - DELETE된 행은 "삭제 표시"만 된 채 purge를 기다리는데, purge가 밀리면
     인덱스 범위 스캔이 건너뛰어야 할 유령 레코드가 늘어난다 — 결과 10건을
     얻으려고 수천 건을 넘기는 스캔
   - undo 테이블스페이스가 부풀고, T가 커밋된 뒤에도 밀린 purge를 따라잡느라
     한동안 I/O가 치솟는다 (후유증은 커밋 후에도 남는다)
   │
⑤ T 자신도 느려진다 — T의 조회는 체인을 끝까지 내려가야 자기 버전을 만나므로
   "배치가 뒤로 갈수록 느려진다"의 원인 중 하나
```

여기서 반드시 붙여야 할 문장: **"이 사슬은 T가 SELECT만 해도 성립한다."**
락을 하나도 안 잡는 순수 조회 트랜잭션이라도 스냅샷을 쥐고 있는 한
purge를 막는다. "읽기만 하니까 괜찮다"는 판단이 틀리는 이유다.
(격리 수준을 READ COMMITTED로 낮추면 스냅샷이 문장 단위로 새로 만들어져
purge를 막는 기간이 문장 하나 길이로 줄어든다 — 통계·리포트성 긴 조회를
READ COMMITTED로 돌리는 근거가 이것이다. §6 첫 꼬리질문.)

**롤백 비용도 이 사슬에 속한다.** 변경량이 큰 트랜잭션을 롤백하면 undo를
거꾸로 전부 타야 하므로 롤백이 실행 시간에 비례하거나 그 이상 걸리고,
**롤백이 끝날 때까지 락은 그대로 유지**된다. 그래서 "느리니까 KILL"이
때로는 상황을 더 길게 만든다(§6 네 번째 꼬리질문).

(가산점 포인트) PostgreSQL은 구조가 다르지만 사슬은 같다 — 과거 버전을
undo가 아니라 **테이블 안의 dead tuple**로 두고 VACUUM이 치우는데, 긴
트랜잭션이 열려 있으면 VACUUM이 그 트랜잭션의 스냅샷보다 오래된
튜플만 치울 수 있어 테이블·인덱스가 부풀어 오른다(bloat). "엔진이 달라도
'누군가 아직 볼 수 있는 과거 버전은 못 지운다'는 원리는 같다"고 말하면
원리를 이해한 것으로 읽힌다.

이 사슬의 부품 수준 세부 — Read View의 판정 규칙, 세컨더리 인덱스가
MVCC 때문에 커버링을 잃는 경우, 격리 수준별 Read View 생성 시점 — 는
[mvcc-innodb.md](./mvcc-innodb.md) §2~§3에 있다. 이 문서에서는 (a)를
나머지 세 사슬과 **같은 높이**에서 본다.

### 2-2. 사슬 (b) — 락 점유 시간 → 대기 큐 → 커넥션 고갈 → 서비스 전면 영향

```text
① UPDATE / DELETE / SELECT ... FOR UPDATE 가 잡은 행 락(과 갭 락)은 커밋·롤백까지 절대 안 풀린다
   → 명시적 락이 없어도 UPDATE 문 자체가 배타 락을 잡는다
   │
② 같은 행(또는 같은 갭)을 원하는 트랜잭션은 락 대기 큐에 선다
   → innodb_lock_wait_timeout(기본 50초) 동안 기다린다
   │
③ 대기 중인 트랜잭션은 그동안 자기 커넥션을 쥔 채 아무 일도 못 한다
   → 대기자가 풀 크기(HikariCP 기본 10)만큼 쌓이는 순간 커넥션 풀 고갈
   → 이제 재고 행과 상관없는 요청도 "Connection is not available" (기본 30초 대기 후)
   │
④ 커넥션을 기다리는 요청은 톰캣 워커 스레드를 문 채 대기한다
   → 스레드풀 고갈 → 헬스체크·로그인·정적 응답까지 실패
   → LB가 인스턴스를 제외 → 나머지 인스턴스로 트래픽 쏠림 → 전면 장애
```

핵심 문장: **락은 "행 하나"에 걸렸는데 영향은 "서비스 전체"다.** 그리고
이 사슬은 자기 강화적이다 — 대기 때문에 다른 트랜잭션도 길어지고, 길어진
트랜잭션이 또 락을 오래 쥔다(컨보이). 락 보유 시간이 길수록 서로 다른
순서로 락을 잡는 두 트랜잭션이 겹칠 확률도 올라가 **데드락 빈도**도
함께 오른다.

특히 위험한 두 지점:

- **핫 로우** — 재고, 잔액, 일별 카운터처럼 모두가 갱신하는 행. 락 대기
  큐가 가장 빨리 자란다.
- **메타데이터 락(MDL)** — 이건 `SELECT`도 잡는다. 트랜잭션이 테이블을 한
  번이라도 읽으면 **트랜잭션이 끝날 때까지 그 테이블의 공유 MDL**을 쥔다.
  이 상태에서 누군가 `ALTER TABLE`을 날리면 ALTER는 배타 MDL을 기다리고,
  **그 뒤에 오는 모든 쿼리(단순 SELECT조차)가 ALTER 뒤에 줄을 선다.**
  "인덱스 하나 추가했는데 테이블 전체가 멈췄다"의 정체이며, 원인은
  ALTER가 아니라 그 앞에 있던 긴 트랜잭션이다. MDL 대기 상한은
  `innodb_lock_wait_timeout`이 아니라 **`lock_wait_timeout`**(기본값이
  사실상 무제한)이라는 별개의 변수다 — 이 둘을 구분하면 가산점. DDL 쪽에서
  이 사슬을 끊는 절차(짧은 `lock_wait_timeout` + 재시도, pt-osc/gh-ost)는
  [online-ddl-zero-downtime-schema-change.md](./online-ddl-zero-downtime-schema-change.md) §1-1·§4-1.

커넥션 고갈 이후의 감별 진단(오래 점유 vs 미반환 누수)은
[hikaricp-connection-pool-exhaustion.md](../02-spring/hikaricp-connection-pool-exhaustion.md)가
다룬다. 이 문서의 사슬 (b)와 (d)는 그 문서의 "원인 ②·③"이 DB 쪽에서
어떻게 시작되는지에 해당한다.

### 2-3. 사슬 (c) — 대형 트랜잭션 → binlog 한 덩어리 → 복제 지연 계단식 급증

이 사슬만은 **시간이 아니라 변경량**이 원인이다. 열어놓고 아무것도 안
하는 트랜잭션은 (c)와 무관하다.

```text
① MySQL binlog는 트랜잭션 단위로 기록된다
   → 진행 중인 변경은 세션별 binlog 캐시에 쌓이다가 (binlog_cache_size 를 넘으면 디스크 임시 파일로)
     COMMIT 순간 한 덩어리로 binlog 에 써진다
   → ROW 포맷이면 변경 행마다 before/after 이미지가 실리므로 크기가 변경 행 수에 비례
   │
② 리플리카는 binlog 를 트랜잭션 단위로 재실행한다
   → 500만 행 UPDATE 하나는 리플리카에서도 "하나의 트랜잭션"으로 돌아야 한다
   → 병렬 적용(멀티스레드 복제)도 트랜잭션 "사이"를 병렬화하지 "안"을 쪼개지 못한다
   │
③ 지연은 커밋 순간 급증한다
   → 마스터에서 10분 걸리는 동안 리플리카는 조용하다 (아직 binlog 에 없으니까)
   → 커밋되는 순간 10분어치가 도착하고, 리플리카가 그것을 다 적용할 때까지
     그 뒤에 온 작은 트랜잭션들이 전부 줄을 선다 → Seconds_Behind_Source 가 계단처럼 뛴다
   │
④ 리플리카를 읽는 모든 것이 옛 데이터를 본다
   → 읽기 라우팅을 탄 서비스: "방금 썼는데 목록에 없어요"
   → 리플리카 기반 통계·검색 인덱싱·CDC 가 통째로 밀린다
   → 반동기 복제라면 마스터의 커밋 응답 자체가 느려진다
```

큰 트랜잭션 하나가 만든 지연은 **그 트랜잭션이 끝나도 바로 안 풀린다** —
리플리카가 밀린 것을 다 따라잡을 때까지 지속되며, 그 사이 마스터 쓰기가
계속 들어오면 회복은 더 늦어진다. 지연이 왜 생기고 애플리케이션이 그것을
어떻게 감지·우회하는지는
[read-replica-routing-and-lag.md](../03-jpa-orm/read-replica-routing-and-lag.md)를
보라. 이 문서의 처방은 하나다 — **큰 변경을 청크로 나눠 커밋하면 binlog도
청크 단위로 흘러가고 리플리카도 청크 단위로 따라온다**(§3의 기법 ⑤).

### 2-4. 사슬 (d) — 커넥션 점유 → 풀 고갈 → 무관한 요청까지 대기

(b)와 헷갈리기 쉬운데 **원인이 다르다.** (b)는 락 때문에 남이 기다리는
것이고, (d)는 **락이 하나도 없어도** 트랜잭션이 커넥션을 놀리고 있는
것이다.

```text
① 스프링 @Transactional 은 시작 시점에 커넥션을 빌려 ThreadLocal 에 묶고 끝날 때까지 반납하지 않는다
   → 한 트랜잭션의 모든 SQL 이 같은 커넥션을 타야 하므로 구조적으로 당연
   │
② 트랜잭션 안에서 외부 API 3초를 기다리면 커넥션 하나가 3초 동안 아무 SQL 도 없이 점유된다
   → DB 쪽에서 보면 "쿼리 없는 열린 트랜잭션" — information_schema.innodb_trx 에
     trx_state='RUNNING' 인데 trx_query 가 NULL 인 행
   │
③ 리틀의 법칙: 동시 점유 커넥션 ≈ 초당 요청 수 × 평균 점유 시간
   → 초당 20건 × 3초 = 60개 필요. 풀이 10개면 즉시 고갈
   → 원래 10ms 짜리 트랜잭션이라면 20건 × 0.01초 = 0.2개면 충분했다 (300배 차이)
   │
④ 이후는 (b)의 ③④와 합류 — 풀 대기 → 스레드 대기 → 전면 장애
   → 그리고 이 트랜잭션은 스냅샷도 쥐고 있으므로 (a) 사슬도 동시에 진행 중이다
```

"커넥션이 모자라면 풀을 늘리면 되지 않나?"에 대한 답도 준비해 둔다 —
커넥션 하나는 DB 서버에서 스레드 하나와 메모리를 쓰고, 열린 트랜잭션
하나는 스냅샷 하나다. 풀을 60개로 늘리면 (d)는 가려지지만 DB 측 경합과
(a)의 스냅샷 수가 6배가 된다. 병목의 위치(외부 API 대기)를 안 고치고
숫자만 키운 것이다 — 커넥션을 늘리면 왜 처리량이 오히려 꺾이는지는
[connection-count-vs-throughput.md](./connection-count-vs-throughput.md)가
네 사슬로 따로 다룬다.

### 2-5. 네 사슬 한 장 정리

| 사슬 | 원인 축 | 첫 도미노 | 마지막 도미노 | 관측 지표 |
|---|---|---|---|---|
| (a) undo | 시간 (읽기만 해도) | 스냅샷이 purge 차단 | 무관한 조회 지연, 롤백 장기화 | History list length |
| (b) 락 | 시간 (쓰기·FOR UPDATE) | 락 대기 큐 | 풀·스레드 고갈 → 전면 장애 | 락 대기 시간, 데드락 수 |
| (c) 변경량 | 변경 행 수 | binlog 한 덩어리 | 복제 지연 계단식 급증 | Seconds_Behind_Source |
| (d) 커넥션 | 시간 (락 없어도) | 커넥션 놀림 | 풀 고갈 → 전면 장애 | 풀 대기 시간·pending 수 |

면접 답변의 첫 문장은 이 표를 세로로 읽는 것이다 — "**undo, 락, 변경량,
커넥션 — 네 자원 각각에서 사슬이 출발합니다.**" 그리고 하나씩 도미노를
세운다.

## 3. 애플리케이션에서 짧게 유지하는 기법 다섯 가지

원칙 한 줄: **트랜잭션 안에는 "DB 쓰기"와 "그 쓰기를 결정하는 데 꼭
필요한 최소한의 읽기"만 둔다.** 그 외 모든 것 — 외부 API, 파일, 메일,
무거운 계산, 사용자 대기 — 은 트랜잭션 앞이나 뒤로 보낸다. 아래 다섯
기법은 전부 이 원칙을 코드로 옮기는 서로 다른 손잡이다.

먼저 무대가 될 원본 코드. 결제 서비스에서 흔히 보는 형태이고, 리뷰에서
잡아야 하는 코드다.

```java
@Service
@RequiredArgsConstructor
public class OrderPaymentService {

    @Transactional
    public void pay(Long orderId, PaymentCommand cmd) {
        Order order = orderRepository.findById(orderId).orElseThrow();  // ① 첫 SELECT → 스냅샷 시작 (사슬 a 시작)
        order.markPaying();                       // ② 커밋 시 UPDATE → 행 락은 커밋까지 (사슬 b 시작)

        PgResult result = pgClient.approve(cmd);  // ③ 외부 PG 호출 2~10초 — 커넥션·락·스냅샷을 전부 쥔 채 (사슬 d)
        byte[] receipt = receiptRenderer.render(order, result);   // ④ CPU 작업
        s3Client.upload(receiptKey(order), receipt);              // ⑤ 또 외부 I/O

        order.complete(result.approvalNo());                      // ⑥
        paymentHistoryRepository.save(PaymentHistory.of(order, result));
        mailSender.sendReceipt(order);                            // ⑦ 또 외부 — 실패하면 결제까지 롤백?
    }
}
```

이 메서드의 트랜잭션 길이는 **PG 응답 시간 + S3 업로드 시간 + 메일 서버
응답 시간**이다. DB 작업 자체는 수 ms인데 트랜잭션은 수 초다. PG가
느려지는 날 주문 행 락과 커넥션이 수 초씩 잡히고, 초당 주문이 수십 건이면
풀은 몇 초 만에 고갈된다.

### 기법 ① — 외부 호출·파일·CPU 작업을 트랜잭션 밖으로

가장 효과가 크고 가장 기계적인 규칙이다. "이 줄이 DB에 SQL을 보내는가?"
아니면 밖으로. 구조는 항상 같다 — **[짧은 트랜잭션 A: 상태 선점] →
[트랜잭션 밖: 외부 I/O] → [짧은 트랜잭션 B: 결과 반영]**.

### 기법 ② — `TransactionTemplate`로 경계를 "메서드"에서 "블록"으로 줄인다

`@Transactional`은 선언형이라 편하지만 **경계가 항상 메서드 전체**다.
메서드 안에서 "여기부터 여기까지만"을 표현할 수 없어서, 외부 호출을
빼려면 메서드를 쪼개 별도 빈으로 옮겨야 한다(자기 호출은 프록시를 안
타므로). `TransactionTemplate`은 그 대신 **블록 단위로** 경계를 긋는다.

기법 ①과 ②를 합쳐 원본을 고치면:

```java
@Service
@RequiredArgsConstructor
public class OrderPaymentService {

    private final TransactionTemplate tx;   // PlatformTransactionManager 를 감싼 빈

    // ⚠️ 이 메서드에는 @Transactional 이 없다 — 있으면 아래 블록들이 전부 여기에 합류해 무의미해진다
    public void pay(Long orderId, PaymentCommand cmd) {

        // [A] 짧은 트랜잭션 — 상태 선점. READY → PAYING 만 허용해 이중 결제를 여기서 막는다
        String paymentKey = tx.execute(status -> {
            Order order = orderRepository.findById(orderId).orElseThrow();
            order.markPaying();                       // 상태가 READY 가 아니면 예외 → 이 블록만 롤백
            return order.getPaymentKey();             // 멱등 키 (주문 생성 시 발급)
        });                                           // ← 커밋: 락·커넥션·스냅샷 전부 반납. 수 ms

        // [밖] 외부 I/O — 커넥션 0개, 락 0개
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

트랜잭션 길이가 "PG + S3 + 메일"에서 **"UPDATE 한 번" 두 개**로 줄었다.
PG가 10초 걸려도 DB는 모른다.

`TransactionTemplate`의 함정 하나 — 기본 전파가 `REQUIRED`라서 **호출자가
이미 트랜잭션 안이면 블록들이 전부 거기에 합류**한다. 컨트롤러나
파사드에 `@Transactional`이 붙어 있으면 위 코드는 조용히 원본과 똑같이
긴 트랜잭션이 된다. 그래서 진입점에서 `TransactionSynchronizationManager
.isActualTransactionActive()`가 `false`임을 단정하는 테스트를 하나 두거나,
"컨트롤러·파사드 계층에는 `@Transactional`을 붙이지 않는다"를 ArchUnit
룰로 고정한다(§5-1).

### 기법 ③ — 읽기를 분리한다

쓰기 트랜잭션 안에서 무거운 조회를 하지 않는다. 이유는 사슬 (a) —
**첫 SELECT 순간부터 스냅샷이 잡히고 purge가 멈춘다.** "목록을 조회한 뒤
건별로 갱신"하는 코드를 하나의 `@Transactional`로 감싸면 조회 시작 시점의
스냅샷을 갱신이 끝날 때까지 쥔다.

```java
// Before: 집계 조회(30초) + 갱신을 한 트랜잭션에 — 30초 동안 스냅샷·커넥션 점유
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

두 가지를 덧붙이면 좋다. (1) 읽기 트랜잭션 자체도 길면 사슬 (a)를
일으키므로, 리포트성 긴 조회는 `@Transactional(readOnly = true,
isolation = Isolation.READ_COMMITTED)`로 **스냅샷을 문장 단위로 갱신**시켜
purge 차단 시간을 줄인다. (2) 읽기를 리플리카로 보내는 구조라면 이 분리가
곧 라우팅 조건이 된다 — [transactional-readonly-optimization.md](../02-spring/transactional-readonly-optimization.md).

### 기법 ④ — 후처리를 이벤트로 트랜잭션 뒤로 보낸다

메일·알림·영수증 생성·검색 인덱스 갱신처럼 **"본 처리가 성공했을 때만,
그리고 본 처리와 운명을 같이할 필요는 없는"** 작업은 커밋 뒤로 보낸다.
`@TransactionalEventListener(phase = AFTER_COMMIT)`이 첫 단계이고,
커밋 직후 서버가 죽어도 유실되지 않아야 하면 위 코드처럼 **Outbox
테이블에 같은 트랜잭션으로 INSERT**하고 릴레이가 처리한다. 이 기법의
설계·함정(`AFTER_COMMIT` 리스너 안의 DB 쓰기가 조용히 사라지는 문제 등)은
[transaction-boundary-and-domain-events.md](../03-jpa-orm/transaction-boundary-and-domain-events.md) §4~§7과
[spring-event-transactional-event-listener.md](../02-spring/spring-event-transactional-event-listener.md)가
전부 다루므로 여기서는 이름만 고정한다.

### 기법 ⑤ — 대량 변경은 청크로 나눠 커밋한다

사슬 (c)와 (a)의 변경량 축을 직접 자르는 기법이다. "500만 건 만료 처리"를
UPDATE 한 문장으로 날리면 binlog 한 덩어리, undo 한 덩어리, 롤백 한
덩어리다.

```java
// Before: UPDATE 한 문장이 500만 행 — 커밋 순간 리플리카가 500만 행을 한 트랜잭션으로 재실행
@Transactional
public void expireCoupons(LocalDate today) {
    couponRepository.expireAllBefore(today);
    // UPDATE coupon SET status='EXPIRED' WHERE expires_at < ? AND status='ACTIVE'
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
        // SELECT id FROM coupon WHERE id > ? AND expires_at < ? AND status='ACTIVE' ORDER BY id LIMIT ?
        if (ids.isEmpty()) return null;
        couponRepository.expireByIds(ids);
        // UPDATE coupon SET status='EXPIRED' WHERE id IN (...) AND status='ACTIVE'   ← 조건 자체가 멱등
        return ids.get(ids.size() - 1);
    }
}
```

청크마다 락이 풀리고, binlog가 5,000행 단위로 흘러 리플리카가 사이사이
따라오며, 300만 건째에서 실패해도 299만 건은 남는다. 조건에
`status='ACTIVE'`를 넣어 **재실행해도 결과가 같게** 만든 것에 주목 —
청크 커밋은 "중간 상태"를 만들기 때문에 재실행 가능성이 곧 세트다(§4).
Spring Batch의 `chunk(n)`은 이 구조에 **재시작 지점 기록**까지 붙인
것이고, JPA 영속성 컨텍스트 누적 문제까지 포함한 대량 처리 전반은
[bulk-insert-jdbc-batch.md](../03-jpa-orm/bulk-insert-jdbc-batch.md) §6을 보라.

(가산점 포인트) 청크 크기의 양면 — 작을수록 락·복제 지연은 줄지만 커밋
횟수(redo 플러시·왕복)가 늘어 총 소요 시간이 길어진다. "1,000~10,000
사이에서 시작해 복제 지연과 처리 시간을 보며 조정한다"처럼 **측정으로
정한다**고 말하면 된다.

### 다섯 가지를 한 줄씩 — 인출용

1. **밖으로** — 외부 API·파일·메일·CPU 작업은 트랜잭션 앞뒤로
2. **`TransactionTemplate`** — 경계를 메서드에서 블록으로
3. **읽기 분리** — 무거운 조회는 readOnly(필요 시 READ COMMITTED)로 따로
4. **이벤트로** — 후처리는 `AFTER_COMMIT` + Outbox
5. **청크 커밋** — 대량 변경은 PK 커서로 나눠 커밋

## 4. 쪼개면 잃는 것 — 원자성의 대가와 그 값을 치르는 법

여기까지만 말하면 "쪼개면 좋다"는 한쪽 답이다. **하나였던 트랜잭션을
[A] → [밖] → [B]로 나누는 순간, 예전에는 물리적으로 존재할 수 없던
"중간 상태"가 존재하게 된다.** 이것이 대가이고, 대가를 갚는 장치 없이
쪼개면 사고의 종류만 바꾼 것이다.

§3의 결제 코드에서 생길 수 있는 중간 상태를 전부 적어 본다:

| 실패 지점 | DB 상태 | 외부(PG) 상태 | 원래 코드였다면 |
|---|---|---|---|
| [A] 커밋 후 PG 호출 전에 서버 사망 | PAYING | 미승인 | 롤백으로 READY 복귀 |
| PG 승인 성공 후 응답 수신 전 타임아웃 | PAYING | **승인됨** | (원래 코드도 같은 문제) |
| PG 승인 후 [B] 커밋 전 서버 사망 | PAYING | 승인됨 | (원래 코드도 같은 문제) |
| 청크 300만 건째 실패 | 299만 건 EXPIRED | — | 전부 롤백, 0건 |

두 번째·세 번째 행은 사실 **원래 코드에도 있던 문제**다 — 외부 시스템은
어차피 DB 트랜잭션에 참여하지 않으므로, 한 트랜잭션에 넣었다고 PG 승인이
롤백되지는 않는다(메일과 마찬가지다). 쪼개기가 **새로 만든** 중간 상태는
첫 번째 행과 네 번째 행이고, 이 둘은 다음 세 장치로 갚는다.

### 4-1. 상태 머신 — 중간 상태를 숨기지 말고 이름 붙인다

`READY → PAYING → PAID / PAY_FAILED`. PAYING은 "PG에 물어보는 중"이라는
**정식 상태**다. 이렇게 두면 첫 번째 행의 사고는 "PAYING인데 N분이
지났고 PG 승인 기록이 없는 주문"이라는 **쿼리로 찾을 수 있는 상태**가
된다. 그리고 `markPaying()`이 READY에서만 성공하게 만들면 재시도·중복
요청이 같은 주문을 두 번 결제하는 것을 DB 상태 전이로 막는다.

### 4-2. 보상(compensation) + 보정 배치

롤백이 사라진 자리를 **되돌리는 동작을 직접 만드는 것**이 대신한다.
PG 승인 뒤 [B]가 실패하면 PG 취소를 호출하고, 그 취소도 실패할 수
있으므로 **오래된 PAYING을 주기적으로 PG에 조회해 대사(對査)하는
보정 배치**가 마지막 그물이다.

```java
@Scheduled(fixedDelay = 60_000)
public void reconcileStalePayments() {
    List<Order> stale = orderRepository.findPayingOlderThan(Duration.ofMinutes(5));
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

### 4-3. 재시도 + 멱등 — 재시도는 중복을 만들고, 멱등이 중복을 무해하게 만든다

[B]를 재실행하려면 [B]가 두 번 실행돼도 결과가 한 번과 같아야 한다 —
`complete()`가 이미 PAID면 무시, `PaymentHistory`에 `payment_key` 유니크
제약. PG 호출에는 멱등 키를 실어 "응답을 못 받아서 다시 보냈더니 두 번
결제"를 PG 쪽에서 막는다. 청크 커밋의 `WHERE ... AND status='ACTIVE'`도
같은 원리다 — **재실행이 가능해야 부분 완료가 사고가 아니라 진행 상태가
된다.**

### 4-4. 그래서, 언제 쪼개지 않는가

양면을 완성하려면 반대편도 말해야 한다. **순수 DB 작업만으로 이루어져
있고, 실패 시 함께 되돌려야 하며, 실행 시간이 원래 수 ms인 트랜잭션은
쪼개지 않는다.** 계좌이체의 출금 UPDATE와 입금 UPDATE를 "짧게 하자"고
두 트랜잭션으로 나누는 것은 짧아지는 것도 없이 원자성만 버리는 일이다.
판단 기준은 두 개다 — **① 트랜잭션 안에 블로킹 I/O(외부 호출·파일·
사용자 대기)가 있는가 ② 이 부분이 실패하면 본 처리도 되돌려야 하는가.**
①이 있으면 그것을 빼고, ②가 "아니오"면 이벤트로 넘긴다. 둘 다 아니면
그대로 둔다. ([transaction-boundary-and-domain-events.md](../03-jpa-orm/transaction-boundary-and-domain-events.md) §3의
기준과 같다.)

면접용 한 문장: "**쪼개기는 락·커넥션·복제 지연을 사는 대신 원자성을
파는 거래이고, 판 원자성은 상태 머신·보상·멱등으로 다시 사 와야 하므로,
블로킹 I/O가 없고 실패 시 함께 되돌려야 하는 작업은 쪼개지 않습니다.**"

## 5. 안전망 — "조심하자"가 아니라 "못 어기게"

긴 트랜잭션은 **평소에는 아무 문제가 없다.** PG가 200ms에 응답하는 날엔
원본 코드도 잘 돈다. 문제는 PG가 느려지는 날, 프로모션으로 트래픽이
3배인 날 한꺼번에 터진다. 그래서 리뷰어의 주의력이나 팀 위키의 규칙에
맡길 수 없다 — 세 층으로 장치를 둔다.

### 5-1. 코드 단계 — ArchUnit으로 컴파일 시점에 막는다

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
            .because("외부 I/O 응답 시간이 그대로 락 보유 시간·커넥션 점유 시간이 된다");

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

한계도 같이 말한다 — 인터페이스 뒤에 숨긴 클라이언트(`PgClient`
인터페이스의 구현체가 RestTemplate을 쓰는 경우)는 직접 접근이 아니라
못 잡는다. 그래서 규칙 1에 팀의 클라이언트 인터페이스 패키지
(`..infrastructure.client..`)를 명시적으로 추가한다. 완벽하진 않지만
**가장 흔한 위반을 막고, 우회하려면 룰을 고쳐야 하니 논의가 강제된다**는
것이 가치다.

### 5-2. DB·풀 단계 — 사슬을 중간에 끊는 타임아웃

각 타임아웃이 **어느 사슬의 어느 칸**을 끊는지 매핑해 두면 설정값의
의미가 분명해진다.

| 설정 | 끊는 지점 | 기본값이 위험한 이유 |
|---|---|---|
| `innodb_lock_wait_timeout` | 사슬 (b) ② 락 대기 큐의 길이 | 50초 — 50초면 풀이 몇 번이고 고갈된다. 온라인 트랜잭션은 수 초로 |
| HikariCP `connection-timeout` | 사슬 (b)(d) ③→④ 풀 대기가 스레드 대기로 번지는 것 | 30초 — 빨리 실패시켜 스레드를 돌려줘야 헬스체크가 산다 |
| `@Transactional(timeout = n)` | 애플리케이션 쪽 트랜잭션 수명 상한 | 없음 — 단, 동작 방식에 함정(§6 세 번째 꼬리질문) |
| `lock_wait_timeout` (MDL) | 사슬 (b) MDL 변형 — ALTER가 뒤의 쿼리를 막는 시간 | 사실상 무제한 — DDL 세션에서만 짧게 잡는다 |
| PostgreSQL `idle_in_transaction_session_timeout` | 사슬 (a)(d) — 쿼리 없이 열린 트랜잭션 자체 | 0(비활성) — 켜면 "열어놓고 잊은" 트랜잭션을 DB가 끊는다 |

`innodb_lock_wait_timeout`의 함정 하나 (가산점 포인트): 타임아웃이 나면
기본 설정에서는 **그 문장만 롤백되고 트랜잭션은 열린 채 남는다.** 앞서
잡은 락은 그대로다. 스프링은 예외를 받아 트랜잭션 전체를 롤백하므로
보통은 괜찮지만, 그 예외를 catch로 삼키면 "락을 쥔 채 계속 도는"
트랜잭션이 된다. DB 쪽에서 통째로 롤백시키려면
`innodb_rollback_on_timeout=ON`.

### 5-3. 운영 단계 — `information_schema.innodb_trx`로 긴 트랜잭션을 숫자로 본다

"트랜잭션이 길다"는 측정하지 않으면 감상이다. InnoDB는 현재 열린 모든
트랜잭션을 `information_schema.innodb_trx`에 노출한다.

```sql
-- 30초 넘게 열려 있는 트랜잭션: 누가(스레드), 언제부터, 무엇을(쿼리), 얼마나(잠근 행·바꾼 행)
SELECT trx_id,
       trx_state,                                            -- RUNNING / LOCK WAIT / ROLLING BACK
       trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       trx_rows_locked,                                      -- 사슬 (b): 잠근 행 수
       trx_rows_modified,                                    -- 사슬 (a)(c): 바꾼 행 수 = undo·binlog 부피, 롤백 비용
       trx_mysql_thread_id,                                  -- KILL 대상 id
       trx_query                                             -- NULL 이면 "쿼리 없이 열린" 트랜잭션 = 외부 호출 대기 중일 확률
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 30 SECOND
ORDER BY trx_started;
```

읽는 법 — `trx_query`가 **NULL인데 age가 크면** 애플리케이션이 트랜잭션을
열어놓고 DB 밖에서 무언가를 기다리는 중이다(사슬 d의 전형).
`trx_rows_modified`가 크면 KILL 시 롤백이 오래 걸린다는 뜻이다.
`trx_state = 'LOCK WAIT'`가 여럿이면 누가 막고 있는지
`sys.innodb_lock_waits`(누가 → 누구를 막는지, 얼마나 기다렸는지)로
쌍을 특정한다.

알람으로 승격할 지표 세 개:

- **긴 트랜잭션 개수** — 위 쿼리의 행 수가 0이 아니면 경고, N분 이상이면
  즉시 알림. 모니터링 잡이 주기적으로 조회해 게이지로 노출한다.
- **History list length** — `SHOW ENGINE INNODB STATUS`의 TRANSACTIONS
  섹션, 또는 `information_schema.innodb_metrics`의 `trx_rseg_history_len`.
  이 값이 계속 오르면 사슬 (a)가 진행 중이라는 뜻이고, 원인 트랜잭션은
  위 쿼리에서 가장 오래된 스냅샷을 가진 것이다.
- **복제 지연** — `SHOW REPLICA STATUS`의 `Seconds_Behind_Source`가
  계단처럼 뛰면 방금 큰 트랜잭션이 커밋된 것이다(사슬 c).

애플리케이션 쪽 짝 — 트랜잭션 소요 시간 Micrometer 타이머와 HikariCP
`hikaricp.connections.pending`·acquire 시간은
[transaction-boundary-and-domain-events.md](../03-jpa-orm/transaction-boundary-and-domain-events.md) §9-2에
있다. **DB 쪽 지표(`innodb_trx`)와 앱 쪽 지표(풀 대기)가 같은 시각에
같이 오르면 원인은 긴 트랜잭션**이라고 읽는다.

### 5-4. 테스트로 고정

- **트랜잭션 길이 회귀 테스트** — 결제 서비스의 `pay()`를 호출하면서
  `TransactionSynchronization`에 훅을 걸어 각 트랜잭션의 시작~종료 시간을
  기록하고, PG 클라이언트를 3초 지연 스텁으로 바꿔도 **트랜잭션 시간이
  100ms 미만**임을 단정한다. 외부 호출이 트랜잭션 안으로 다시 들어가면
  이 테스트가 즉시 깨진다.
- **Testcontainers** — 락 타임아웃, MDL, 데드락 감지는 H2와 MySQL이
  다르다. 사슬 (b)를 검증하려면 운영과 같은 엔진이어야 한다.

---

## 6. 꼬리질문 대비 포인트

### "SELECT만 하는 트랜잭션도 길면 해로운가요? 락도 안 잡는데요."

해롭다, 세 가지 이유로. **① 사슬 (a)** — 스냅샷 읽기는 락 대신 undo에
의존하는데, 그 스냅샷이 살아 있는 동안은 그보다 나중에 커밋된 변경의
이전 버전을 purge가 지우지 못한다. 그 사이 다른 트랜잭션들이 핫 로우를
읽을 때 버전 체인을 순회하고, 삭제 표시된 행이 인덱스에 남아 범위 스캔이
느려진다. **② 사슬 (d)** — 커넥션 하나를 그 시간 내내 점유한다.
**③ MDL** — SELECT도 테이블의 공유 메타데이터 락을 트랜잭션 끝까지 쥐므로,
그 사이 누군가 ALTER를 날리면 ALTER가 막히고 ALTER 뒤의 모든 쿼리가
막힌다. 처방은 리포트성 긴 조회를 **READ COMMITTED**로 돌려 스냅샷을
문장 단위로 갱신시키거나(purge 차단 기간이 문장 하나로 줄어든다),
아예 **리플리카**로 보내 마스터의 undo·MDL과 분리하는 것이다.

### "트랜잭션을 [A]→[PG]→[B]로 쪼갰는데 PG 승인 직후 서버가 죽었습니다. 주문은 PAYING인데 PG는 승인 상태예요. 어떻게 하시겠어요?"

먼저 이 상태가 **원래의 한 트랜잭션 구조에서도 똑같이 생겼을 상태**임을
짚는다 — PG 승인은 DB 롤백으로 취소되지 않으므로, 쪼개기가 만든 문제가
아니라 외부 시스템이 트랜잭션에 참여하지 않는 데서 오는 본질적 문제다.
처방은 세 겹 — **① 상태 머신**: PAYING을 정식 상태로 두어 "PAYING인데
5분 넘은 주문"을 쿼리로 찾을 수 있게 한다. **② 보정 배치**: 그 주문의
멱등 키로 PG에 상태를 조회해 승인이면 [B]를 재실행하고 아니면 실패
처리한다. **③ 멱등**: [B]는 두 번 실행돼도 안전해야 하고(`payment_key`
유니크, PAID면 무시), PG 요청에는 멱등 키가 실려 재시도가 이중 결제를
만들지 않아야 한다. "쪼개면 원자성을 잃는다"에서 멈추지 않고 **잃은
원자성을 어떤 장치로 되사 오는지**까지 말하는 것이 이 질문의 채점 기준이다.

### "`@Transactional(timeout = 3)`을 걸었는데 안에서 외부 API가 10초 걸려도 안 끊깁니다. 왜죠?"

스프링의 트랜잭션 타임아웃은 **별도 스레드가 트랜잭션을 강제로 끊는
방식이 아니다.** 시작 시점에 마감 시각을 기록해 두고, 이후 그 트랜잭션에서
**SQL을 실행하려 할 때** 남은 시간을 계산해 문장 타임아웃으로 붙이거나,
이미 지났으면 그 시점에 `TransactionTimedOutException`을 던진다. 외부 API를
기다리는 동안은 SQL이 없으니 아무 일도 일어나지 않고, 10초 뒤 돌아와
다음 쿼리를 날리는 순간에야 터진다 — **그 10초 동안 락·커넥션·스냅샷은
그대로 잡혀 있었다.** 그래서 `timeout`은 "느린 쿼리에 대한 상한"이지
"트랜잭션 안의 외부 호출에 대한 방어"가 아니다. 진짜 방어는 외부 호출을
트랜잭션 밖으로 빼는 것(기법 ①)과, 외부 클라이언트 자체의 연결·읽기
타임아웃이다.

### "긴 트랜잭션 알람이 울렸습니다. 해당 스레드를 KILL하면 되나요?" (시니어 변별 포인트)

바로 KILL하지 않는다. KILL은 **롤백**을 일으키고, 롤백은 undo를 거꾸로
전부 타야 해서 `trx_rows_modified`가 크면 실행 시간만큼 걸리며 **그동안
락은 계속 잡혀 있다** — 잘못하면 "10분 걸리던 것을 20분으로" 만든다.
판단 순서: **① 정체 파악** — `innodb_trx`에서 `trx_query`가 NULL이면
외부 대기 중인 애플리케이션 트랜잭션(앱 스레드 덤프로 무엇을 기다리는지
확인), 쿼리가 있으면 느린 SQL, `trx_state`가 `LOCK WAIT`면 이 트랜잭션도
피해자다. **② 피해 범위** — `sys.innodb_lock_waits`로 이 트랜잭션이 몇
개를 막고 있는지, 풀 대기가 늘고 있는지. **③ 비용 비교** —
`trx_rows_modified`가 작고(롤백이 싸고) 뒤에 대기자가 많으면 KILL, 반대로
변경량이 크고 곧 끝날 배치라면 기다리는 편이 총 피해가 적을 수 있다.
그리고 **④ 사후** — 알람이 울렸다는 것은 §5-1·§5-2 장치가 뚫렸다는 뜻이므로
그 경로를 룰에 추가한다. "KILL하면 됩니다"와 "먼저 롤백 비용과 대기자 수를
비교합니다"의 차이가 시니어 변별점이다.

### "트래픽이 거의 없는 테이블에 컬럼 하나 추가했는데 서비스 전체가 멈췄습니다. 긴 트랜잭션과 무슨 관계죠?" (가산점 포인트)

메타데이터 락 사슬이다. 어떤 긴 트랜잭션이 그 테이블을 **한 번이라도
읽은 적이 있으면** 트랜잭션 끝까지 공유 MDL을 쥔다. ALTER는 배타 MDL이
필요하므로 그 트랜잭션이 끝날 때까지 대기하고, MDL 큐는 공정(FIFO)이라
**ALTER 뒤에 도착한 모든 쿼리 — 단순 SELECT까지 — 가 ALTER 뒤에 줄을
선다.** 트래픽이 적은 테이블이어도 그 테이블을 조인하는 쿼리는 전부
멈추고, 그 쿼리들이 커넥션을 쥔 채 대기하니 사슬 (b)의 ③④로 이어진다.
처방: DDL을 실행하는 세션에서 `SET SESSION lock_wait_timeout = 5`로 MDL
대기 상한을 짧게 잡아 "못 잡으면 빨리 실패"하게 하고, 실행 전
`innodb_trx`로 긴 트랜잭션이 없는지 확인하며, 대형 테이블은
pt-online-schema-change·gh-ost 같은 도구로 짧은 MDL 구간만 남긴다.
`innodb_lock_wait_timeout`(행 락)과 `lock_wait_timeout`(MDL)이 서로 다른
변수라는 것까지 말하면 운영 경험이 드러난다.

---

## 한 줄 요약

긴 트랜잭션은 "느려진다"가 아니라 **undo(스냅샷이 purge를 막아 무관한
조회까지 지연) · 락(대기 큐 → 커넥션 → 스레드 → 전면 장애) · 변경량(binlog
한 덩어리 → 복제 지연 급증) · 커넥션(락 없이도 풀 고갈)** 네 자원에서
출발하는 네 사슬의 문제이고, 처방은 **외부 호출 밖으로 / `TransactionTemplate`
블록 축소 / 읽기 분리 / `AFTER_COMMIT`·Outbox / 청크 커밋** 다섯 가지인데,
쪼개는 순간 원자성을 내주므로 **상태 머신·보상·재시도+멱등**으로 되사 와야
하며, 이 모든 것은 사람의 주의가 아니라 **ArchUnit·타임아웃·`innodb_trx`
알람**으로 못 어기게 고정해야 비로소 "트랜잭션은 짧게"가 격언이 아니라
시스템의 성질이 된다.
