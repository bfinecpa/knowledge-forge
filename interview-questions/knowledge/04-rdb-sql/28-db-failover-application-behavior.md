# DB failover 중 애플리케이션 동작 — 승격은 40초 만에 끝났는데 앱은 왜 30분 동안 장애인가

> 핵심 관전 포인트: **failover는 DB 쪽에서 끝나는 이벤트가 아니라
> 애플리케이션까지 이어지는 사슬이다. 다운 감지(Patroni 리더 키 TTL / 관리형
> DB 헬스체크) → 스탠바이 승격(`pg_promote()` — 받아둔 WAL을 끝까지 재생하고
> **타임라인이 분기**한다. 비동기 복제라면 아직 안 넘어간 WAL은 새 타임라인에
> 없다 = RPO) → 엔드포인트 전환(DNS TTL / HAProxy / PgBouncer 재설정) → 앱
> JVM의 DNS 캐시 만료, 여기까지가 "인프라 복구"다. 진짜 문제는 그 뒤에 있다 —
> 앱의 커넥션 풀은 여전히 구 인스턴스를 향한 소켓을 쥐고 있다. RST나 `57P01`을
> 받은 커넥션은 HikariCP가 알아서 갈아끼우지만, 조용히 죽은 반개방(half-open)
> 소켓은 pgjdbc `socketTimeout`(기본 0 = 무한, 단위는 **초**)이 없으면
> `read()`에서 영원히 대기하고, 승격 안 된 스탠바이에 붙은 커넥션은 쓰기마다
> **`ERROR 25006 cannot execute INSERT in a read-only transaction`**을 내는데
> HikariCP는 그걸 끊을 사유로 보지 않는다. 커넥션이 하나씩 좀비가 되면 풀이
> 마르고 → 톰캣 스레드가 마르고 → 헬스체크까지 죽는다. 게다가 PostgreSQL은
> **커넥션 하나가 OS 프로세스 하나**라, 재연결 폭풍이 곧 `53300 too many
> clients already`와 새 프라이머리의 CPU 압박으로 직결된다 — 그래서 PG에서는
> PgBouncer/RDS Proxy 앞단이 선택이 아니라 기본기다. 대비는 설정과 코드로
> 고정한다: pgjdbc 다중 호스트 URL + `targetServerType=primary`,
> `socketTimeout`과 서버 쪽 `statement_timeout`, HikariCP 4개 설정, JVM
> `networkaddress.cache.ttl`, `25006`을 evict 사유로 등록
> (`SQLExceptionOverride`), 멱등키가 있을 때만 쓰기 재시도, 서킷 브레이커,
> readiness에만 DB 체크, 정기 failover 훈련. 그리고 모든 안전망에는 대가가
> 있다 — 짧은 타임아웃은 긴 정상 쿼리를 죽이고(오탐·플래핑), 자동 재시도는
> 커밋 여부가 불명한 쓰기를 중복시키며, 읽기 전용 저하 모드는 쓰기 기능과
> 코드 복잡도를 맞바꾸고, 동기 복제는 쓰기 지연과 가용성 결합을 치른다 —
> **PostgreSQL의 동기 복제에는 MySQL 반동기 같은 "타임아웃 후 자동 비동기
> 강등"이 없어서** 이 결합이 더 날카롭다.**

---

## 0. 질문 + 의도

**질문**: "DB 장애로 failover가 일어나는 동안 애플리케이션은 어떻게 동작해야
하나요?"

**PostgreSQL 기준 재해석**: "스트리밍 복제 스탠바이가 프라이머리로 승격되는
동안, pgjdbc + HikariCP로 붙어 있는 애플리케이션은 무엇을 잃고 무엇을
스스로 회복해야 하나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**인프라가 복구를 해줘도
애플리케이션이 커넥션을 못 갈아타면 장애는 계속된다. '내 코드 밖에서 벌어지는
일'까지 책임 범위로 보는 시야를 확인한다.**"

두 문장이 각각 채점 지점이다.

- **"커넥션을 못 갈아타면"** — DB 팀은 "승격 완료, 40초 걸렸습니다"라고
  보고하는데 앱은 30분째 5xx를 뱉는 상황이 실제로 흔하다. 이 간극이 **어디서,
  왜** 생기는지를 TCP 소켓·DNS 캐시·커넥션 풀·스레드 풀의 사슬로 설명할 수
  있는지 본다.
- **"내 코드 밖에서 벌어지는 일까지 책임 범위로"** — Patroni의 리더 키 TTL,
  DNS TTL, 커널의 TCP 동작, pgjdbc 기본값은 전부 "내가 짠 코드"가 아니다.
  그런데 그것들의 기본값이 내 서비스의 복구 시간을 결정한다. "인프라 문제라
  우리 소관이 아니다"가 성립하지 않는 영역임을 아는지, 그래서 **설정과 코드로
  안전망을 고정해 뒀는지**를 본다.

> 이 문서는 사전 학습용이다(면접 전 선행 학습). 이 후보자의 횡단 약점 네 가지를
> 이 문항 안에서 정면으로 겨냥한다.
>
> - **약점 ① 메커니즘 사슬** — §1이 전부 사슬이다. "DB가 죽으면 앱도 에러
>   난다"가 아니라 *다운 → 감지 → 승격(타임라인 분기) → 엔드포인트 전환 → JVM
>   캐시 → 죽은 소켓 → 무한 대기 → 풀 고갈 → 스레드 고갈 → 헬스체크 실패*를
>   한 호흡으로 말하는 연습.
> - **약점 ② 트레이드오프 양면** — 고난이도는 트레이드오프 서술이 곧 평가
>   대상이다. §4는 안전망 하나하나의 대가만 모아놓은 절이다.
> - **약점 ③ 안전망을 코드로 고정** — §3의 12항은 전부 yml·URL·자바 코드다.
>   "타임아웃을 잘 잡아야 한다"가 아니라 "`socketTimeout=10`, **단위는 초**,
>   MySQL 값 10000을 그대로 옮기면 2.8시간"까지 말한다.
> - **약점 ④ 목록 인출** — §2 "증상 10종(공통 8 + PG 고유 2)", §3
>   "체크리스트 12항"을 번호 붙은 목록으로 외운다.
>
> 이웃 문서와의 경계: 풀 고갈의 **진단 방법론**은
> [`../02-spring/26-hikaricp-connection-pool-exhaustion.md`](../02-spring/26-hikaricp-connection-pool-exhaustion.md),
> 커넥션 수와 처리량의 관계(**PG의 프로세스 모델**)는
> [`./15-connection-count-vs-throughput.md`](./15-connection-count-vs-throughput.md),
> LB 제외가 **비동기로 전파되는 이유**(헬스체크 주기·목록 전파·프록시 갱신)는
> [`../02-spring/28-graceful-shutdown-zero-downtime-deploy.md`](../02-spring/28-graceful-shutdown-zero-downtime-deploy.md) §3,
> 복제 지연과 **스탠바이 제외가 프라이머리로 부하를 옮기는 문제**는
> [`../03-jpa-orm/23-read-replica-routing-and-lag.md`](../03-jpa-orm/23-read-replica-routing-and-lag.md) §4·§7,
> DB 체크를 **liveness에 넣으면 안 되는 이유**는
> [`../15-container-infra/liveness-readiness-probe-db-check.md`](../15-container-infra/liveness-readiness-probe-db-check.md)에
> 있다. 여기서는 **failover라는 하나의 사건이 앱 프로세스 안에서 어떻게
> 전개되는가**에 집중한다.

## 1. 큰 그림 — failover는 "DB 이벤트"가 아니라 앱까지 이어지는 사슬이다

> 약점 ①(메커니즘 사슬) 겨냥. 이 절의 그림 하나를 통째로 머리에 넣는다. 면접에서
> "failover 중 앱은 어떻게 되나요"를 받으면 이 그림을 위에서 아래로 읽는 것이
> 답변이다.

### 1-1. 타임라인 — 인프라 쪽 4단계

```text
t=0        프라이머리 다운
           (인스턴스 장애·커널 패닉·네트워크 단절, 또는 계획된 switchover)
   │
   ▼  ① 감지        Patroni: DCS의 리더 키 TTL 만료 / 관리형 DB: 헬스체크 간격 × 실패 임계
   │               (1회 실패로 판정하면 긴 체크포인트·GC 멈춤·I/O 스파이크도 failover를 유발 → 일부러 몇 번 확인한다)
   ▼  ② 승격        스탠바이가 받아둔 WAL을 끝까지 재생 → pg_ctl promote / pg_promote()
   │               → 타임라인 ID가 1 증가하고 WAL 히스토리가 그 지점에서 갈라진다
   │               (비동기 복제라면 "프라이머리가 커밋 응답을 보냈지만 아직 안 넘어간 WAL"은
   │                새 타임라인에 아예 존재하지 않는다 = RPO)
   ▼  ③ 전환        엔드포인트가 새 프라이머리를 가리키게 한다
   │               (RDS: DNS CNAME 갱신 / Patroni: HAProxy가 REST `/primary` 체크로 백엔드 교체
   │                / PgBouncer: 설정 RELOAD·RECONNECT)
   ▼  ④ JVM 캐시    DNS 경로라면 앱 프로세스 안의 InetAddress 캐시가 만료돼야 새 IP로 풀린다
   │               (networkaddress.cache.ttl — DNS TTL과 별개의 두 번째 캐시)
   ═══════════════ 여기까지가 "인프라 복구 완료" ═══════════════
   │
   ▼  ⑤ 앱          기존 풀 커넥션은 여전히 구 인스턴스를 향한 소켓을 들고 있다  → §1-2
```

각 단계에서 **시간이 어디에 쓰이는지**, 그리고 **무엇을 잃을 수 있는지**를
말할 수 있어야 한다.

**① 감지 — 왜 즉시가 아닌가.** 감시자는 통보를 받는 게 아니라 주기적으로
찔러보고 판단한다. 한 번 응답이 없다고 바로 죽었다고 판정하면 긴 GC 멈춤,
큰 체크포인트가 만든 I/O 스파이크, 순간적인 네트워크 지연이 전부 failover를
유발한다. 그래서 "N초 간격으로 M번 연속 실패"를 기다린다.

- **Patroni**(가장 흔한 셀프 호스팅 구성)는 프라이머리가 DCS(etcd·Consul·
  ZooKeeper)의 **리더 키를 주기적으로 갱신**하는 방식이다. 기본 설정 기준
  `ttl` 30초 / `loop_wait` 10초 — 프라이머리가 리더 키를 갱신하지 못한 채
  TTL이 만료되면 스탠바이들이 승격을 경쟁한다. 즉 **감지 시간의 하한이 TTL**
  이다. 스플릿 브레인은 "리더 키를 못 잡으면 스스로 강등"과 watchdog(노드
  재시작)으로 막는다.
- **RDS PostgreSQL Multi-AZ / Aurora PostgreSQL**은 이 판단을 관리형 서비스가
  하고 결과만 이벤트로 알려준다. 우리가 조절할 수 있는 건 거의 없고, 대신
  **우리 앱이 그 이벤트를 얼마나 빨리 따라가는가**만 우리 몫이다.

이 대기가 곧 복구 시간(RTO)의 첫 조각이고, 짧게 잡을수록 오탐이 늘어난다(§4-1).

**② 승격 — 무엇을 잃는가.** PostgreSQL의 스트리밍 복제는 **기본이 비동기**다.
프라이머리는 로컬 WAL을 fsync하고 커밋을 클라이언트에 응답한 뒤, 그 WAL을
스탠바이로 보낸다. 다운 직전 몇 초간의 커밋은 클라이언트가 "성공"을 받았지만
스탠바이에는 아직 없다. 스탠바이가 승격되면 **타임라인 ID가 1 증가하면서 WAL
히스토리가 그 지점에서 갈라지고**, 넘어오지 못한 트랜잭션은 새 역사에 아예
존재하지 않게 된다. 이것이 RPO(복구 시점 목표)가 0이 아닌 이유이고, PG에서는
그 유실이 "타임라인 분기"라는 물리적 실체로 남는다.

- 승격 컨트롤러가 "가장 앞선 스탠바이를 고르는 것"이나 "따라잡을 때까지
  기다리는 것"은 **RTO를 늘려 RPO를 줄이는 선택**이다. Patroni는 설정한
  바이트 이상 뒤처진 후보를 승격 대상에서 제외하는 식으로 이 균형을 잡는다.
- 유실을 아예 없애려면 동기 복제(`synchronous_standby_names` +
  `synchronous_commit`)로 가야 하는데, 그 대가는 §4-4다.
- 구 프라이머리는 **새 타임라인과 갈라진 WAL을 들고 있어서** 그냥 다시 붙일 수
  없다. `pg_rewind`(사전에 `wal_log_hints = on` 또는 데이터 체크섬 필요)로
  분기점까지 되감거나, 아예 베이스 백업으로 다시 만들어 스탠바이로 재구성한다.
  **이 사실이 §1-2의 세 번째 부류(살아 있는데 read-only인 커넥션)를 만든다.**
- Aurora PostgreSQL처럼 **공유 스토리지** 구조는 이 항목이 다르게 동작한다
  (WAL을 스토리지 계층이 들고 있어 승격 시 재생할 것이 적다). 하지만
  "승격 순간까지 클라이언트가 성공을 받은 것이 전부 남는가"라는 질문은 어느
  구조에서든 확인해야 한다.

**②′ 승격 직후는 느리다 — PostgreSQL 고유의 함정.** 새 프라이머리는 방금
전까지 스탠바이였다. `shared_buffers`도 OS 페이지 캐시도 프라이머리의 작업
셋으로 채워져 있지 않다. 그래서 **승격 직후 몇 분간은 같은 쿼리가 디스크를
훨씬 많이 읽는다.** 여기에 앱의 재연결 폭풍이 겹치면 "DB는 살아났는데 전부
느리다"가 되고, 짧게 잡아 둔 `socketTimeout`이 정상 쿼리를 죽이기 시작한다
(§4-1의 오탐이 failover 직후에 집중되는 이유). 대비는 서킷 브레이커의 **느린
호출 임계**(§3-7)로 폭주를 막고, 필요하면 `pg_prewarm`으로 핵심 테이블·인덱스를
미리 캐시에 올리는 것이다.

**③ 전환 — 앱은 새 프라이머리를 어떻게 찾는가.** 여기가 구성별로 가장 크게
갈린다.

| 구성 | 전환 방식 | 앱이 기다리는 것 |
|---|---|---|
| RDS PostgreSQL Multi-AZ | 엔드포인트 CNAME이 새 인스턴스를 가리키도록 갱신 | DNS TTL + **JVM DNS 캐시**(④) |
| Aurora PostgreSQL | writer / reader 엔드포인트 각각 갱신 | 같음. 단 writer 엔드포인트가 승격을 빨리 따라간다 |
| Patroni + HAProxy | HAProxy가 각 노드의 Patroni REST `/primary`(200이면 리더)를 헬스체크로 삼아 백엔드 교체 | HAProxy 헬스체크 주기 |
| Patroni + PgBouncer | PgBouncer 설정의 `host=`를 바꾸고 `RELOAD`/`RECONNECT` | 운영 자동화의 반응 시간 |
| **pgjdbc 다중 호스트 URL** | 앱이 후보 호스트를 직접 확인 | `hostRecheckSeconds`(§3-4) — **DNS를 아예 안 기다린다** |

DNS는 밀어내기(push)가 아니라 캐시 만료(pull) 모델이라, TTL이 끝날 때까지
모든 리졸버가 구 IP를 돌려준다. 그래서 관리형 DB는 엔드포인트 TTL을 수 초로
짧게 잡아둔다. 프록시(PgBouncer·HAProxy·RDS Proxy)를 앞에 두는 구성은 이
단계를 앱에서 숨긴다 — 대신 프록시가 새 병목·새 장애점이 된다(§4-5).

**④ JVM 캐시 — DNS가 두 번 걸리는 이유.** 자바는 한 번 풀어낸 호스트명 → IP
결과를 프로세스 안에 따로 캐시한다(`InetAddress` 캐시). 리졸버 TTL이 5초로
만료돼도 JVM이 자기 캐시를 안 비우면 새 커넥션은 계속 구 IP로 간다. 그리고
**한 가지가 더 있다: DNS는 새 커넥션을 맺을 때만 관여한다.** 이미 맺어진
소켓은 다시 DNS를 묻지 않는다. "TTL이 5초인데 왜 30분 동안 에러가 났나"의
답이 여기서 갈린다 — 30분은 DNS의 문제가 아니라 §1-2의 문제다.

### 1-2. 앱 쪽에서 이어지는 사슬 — 커넥션 세 부류

인프라가 복구된 시점에 앱의 풀 안에는 세 부류의 커넥션이 섞여 있다. 각 부류가
**기본 설정에서** 어떻게 되는지가 이 문항의 핵심이다.

```text
                    풀 안의 커넥션 (예: 20개)
   ┌─────────────────────┬────────────────────────┬──────────────────────────┐
   │ (a) 끊겼다고 통보받음 │ (b) 반개방(half-open)   │ (c) 살아 있는데 read-only │
   │  구 인스턴스가 소켓을 │  상대가 소리 없이 사라짐 │  승격 안 된 스탠바이에    │
   │  닫아줌 / 종료 통보   │  (전원 차단·네트워크 단절)│  붙어 있음               │
   ├─────────────────────┼────────────────────────┼──────────────────────────┤
   │ 다음 사용 시 즉시     │ read()에서 응답을       │ SELECT는 멀쩡히 된다      │
   │ 08006/08003, 또는    │ 기다림. socketTimeout이 │ INSERT/UPDATE만 에러      │
   │ 57P01(관리자 종료)   │ 없으면 영원히           │ (SQLState 25006)         │
   │ → HikariCP가 evict   │ → 스레드 1개 소멸       │ → HikariCP는 evict 안 함  │
   │ → 새 커넥션 생성     │ → 풀에서 반환도 안 됨    │ → 풀로 멀쩡히 반환됨      │
   │ → (라우팅이 갱신됐다면)│                        │ → 다음 요청이 또 잡는다    │
   │   새 프라이머리로     │                        │                          │
   │ ✅ 자가 치유          │ ❌ 조용한 누수          │ ❌ 좀비                   │
   └─────────────────────┴────────────────────────┴──────────────────────────┘
```

**(a)는 좋은 죽음이다.** 상대가 FIN/RST를 보내줬거나 PostgreSQL이 종료 메시지를
보내줬으므로, 드라이버는 다음 I/O에서 예외를 던진다. PG에서 이 부류의 얼굴은 셋이다.

- `08006 connection_failure` — "An I/O error occurred while sending to the backend"
- `08003 connection_does_not_exist` — "This connection has been closed"
- `57P01 admin_shutdown` — **"terminating connection due to administrator command"**.
  Patroni가 구 프라이머리를 강등하려고 `pg_ctl restart`를 걸거나, 관리형 DB가
  인스턴스를 재기동할 때 클라이언트가 받는 바로 그 에러다. 스탠바이가 아직
  hot standby로 열리지 않았으면 접속 시도는 `57P03 cannot_connect_now`
  ("the database system is starting up")로 거부된다.

HikariCP는 **SQLState가 "08"로 시작하는 예외를 연결 계열 오류로 보고 그 커넥션을
풀에서 버린다.** 여기에 더해 몇 개의 상태를 "치명적"으로 따로 들고 있는데,
PostgreSQL의 `57P01`·`57P02`(crash_shutdown)·`57P03`이 그 목록에 들어 있다
(쓰는 버전의 소스에서 한 번 확인해 두면 좋다). 그래서 이 부류는 설정을 안
건드려도 스스로 낫는다. 많은 사람이 "failover 테스트 해봤는데 잠깐 에러 나고
곧 정상이었다"고 기억하는 건 테스트 방식(`patronictl switchover` 같은 계획된
전환)이 (a)만 만들었기 때문이다.

**(b)는 나쁜 죽음이다.** 상대 호스트가 전원이 나가거나, 네트워크가 끊기거나,
보안 그룹이 바뀌면 **아무 패킷도 오지 않는다.** 커널 입장에서 소켓은 여전히
ESTABLISHED다. 이 커넥션으로 쿼리를 보낸 스레드는 응답을 기다리는 `read()`에
들어가고, 상한이 없으면 나오지 않는다(§1-3). 그 스레드는 커넥션을 반환하지
못하므로 풀에서 `active` 하나가 영구히 잠식된다. 요청이 올 때마다 이런
커넥션이 하나씩 걸리면 **풀은 20개가 다 `active`인데 DB는 한가한** 상태가
된다 — 고갈 진단 문서의 "누수" 시그니처와 겉모습이 같다.

**(c)는 가장 교활하다.** PostgreSQL에서 이 부류가 생기는 경로는 넷이다.

1. **DNS/엔드포인트 갱신 창** — failover 직후 새로 만든 커넥션이 JVM DNS 캐시
   때문에 구 IP(이제 스탠바이로 재구성된 인스턴스)로 간다.
2. **`hostRecheckSeconds` 캐시** — 다중 호스트 URL을 쓰더라도 "이 호스트는
   프라이머리"라는 판정이 캐시돼 있는 동안에는 그쪽으로 붙는다.
3. **HAProxy/PgBouncer의 라우팅이 아직 안 바뀐 창.**
4. **펜싱(fencing)** — HA 도구가 구 프라이머리를 재시작 대신
   `ALTER SYSTEM SET default_transaction_read_only = on` + `pg_reload_conf()`로
   묶어 두는 구성. 이 경우 **기존 커넥션이 끊기지도 않은 채** 쓰기만 막힌다.

**`isValid()`는 통과한다 — 살아 있으니까.** SELECT도 된다. 쓰기만
`ERROR: cannot execute INSERT in a read-only transaction`(SQLState **25006**,
`read_only_sql_transaction`)으로 실패한다. 이 SQLState는 "08"도, HikariCP의
치명적 상태 목록도 아니므로 커넥션은 멀쩡한 것으로 풀에 돌아가고, 다음 요청이
또 잡는다. 이 커넥션은 **`maxLifetime`(기본 30분)이 다 될 때까지 산다.**
"승격은 40초, 앱 장애는 30분"의 30분이 정확히 이 숫자다(§5).

> **PostgreSQL 고유의 2차 피해 — `25P02`.** 25006이 트랜잭션 **중간에** 터지면
> 그 트랜잭션은 abort 상태가 되고, 같은 트랜잭션 안의 **이후 모든 문장이**
> `25P02 in_failed_sql_transaction`("current transaction is aborted, commands
> ignored until end of transaction block")로 실패한다. 그래서 로그에는 진짜
> 원인(25006) 한 줄 뒤로 25P02가 수십 줄 쌓이고, 원인이 그 밑에 묻힌다.
> 진단할 때 **로그를 시간 역순이 아니라 트랜잭션의 첫 에러부터** 읽어야 하는
> 이유이고, 예외를 삼키고 계속 진행하는 코드가 이 상황에서 특히 위험한
> 이유다(롤백만이 유일한 출구다).

> **MySQL 대조:** InnoDB 쪽에서는 `SET GLOBAL read_only = ON`으로 **재시작 없이
> 제자리 강등**이 가능해서, 기존 커넥션이 끊기지 않은 채 그대로 좀비가 된다
> (에러는 벤더 코드 1290 `--read-only option` / 1836). PostgreSQL은 프라이머리를
> 스탠바이로 되돌리려면 **재시작이 필요**하므로 대부분의 (c)는 "기존 커넥션이
> 변한 것"이 아니라 **"새 커넥션이 엉뚱한 호스트로 간 것"**이다. 그래서 PG의
> 처방은 in-place 감지보다 **접속 시점 검증**(`targetServerType=primary`,
> `pg_is_in_recovery()`)에 무게가 실린다.

**세 부류 어디에도 안 잡히는 네 번째 손실 — 세션 상태.** (a)로 커넥션이 정상
교체돼도 **새 커넥션은 옛 세션의 상태를 하나도 물려받지 않는다.** PostgreSQL은
세션에 담기는 것이 많아서 이 손실이 MySQL보다 넓다.

- `SET`으로 잡아둔 파라미터(`search_path`, `statement_timeout`, `TimeZone`,
  `work_mem`) — `connection-init-sql`이나 URL `options`로 **커넥션마다 다시
  걸리게** 해 두지 않았으면 조용히 기본값으로 돌아간다.
- **세션 레벨 advisory lock**(`pg_advisory_lock`) — 커넥션이 끊기는 순간
  **조용히 풀린다.** advisory lock은 WAL에 남지 않아 새 프라이머리로 복제되지도
  않는다. "배치는 advisory lock으로 한 번만 돈다"에 의존했다면 failover가
  그 보장을 깨뜨린다(§5 곁가지, §6 꼬리질문).
- `LISTEN` 알림 구독(끊긴 동안의 `NOTIFY`는 다시 받을 수 없다), 임시 테이블,
  서버 준비문(pgjdbc는 같은 문장을 `prepareThreshold`회 — 기본 5회 — 실행하면
  서버 준비문으로 전환한다) — 새 커넥션에서는 처음부터 다시.
- **`PREPARE TRANSACTION`(2PC)을 쓴다면** 승격 후 `pg_prepared_xacts`를 반드시
  확인한다. 고아 prepared transaction은 락을 쥔 채 VACUUM까지 막는다.

세 부류가 만드는 뒷사슬은 하나로 합쳐진다:

```text
(b)로 스레드가 하나씩 갇힘 + (c)로 쓰기가 계속 실패
   → 풀 active = max, pending 누적
   → 새 요청은 connectionTimeout(기본 30초) 동안 풀 앞에서 대기 — 그동안 톰캣 스레드를 쥔 채
   → 톰캣 스레드 풀 고갈 → DB와 무관한 API·헬스체크 엔드포인트까지 응답 불능
   → LB가 인스턴스를 제외 / (liveness에 DB 체크를 넣었다면) 파드 재시작
   → 재시작된 파드들이 동시에 풀을 채우며 새 프라이머리로 몰려감(connection storm)
   → ★ PostgreSQL은 커넥션 1개 = 백엔드 프로세스 1개(fork) ★
     → max_connections(기본 100) 초과 시 53300 "sorry, too many clients already"
     → 초과하지 않아도 수백 프로세스의 메모리·컨텍스트 스위치·스냅샷 계산 비용이
       ②′의 콜드 캐시와 겹쳐 새 프라이머리를 더 느리게 만든다
   → 복구가 더 늦어짐
```

**"DB가 죽어서 앱이 죽었다"가 아니다. DB는 40초 만에 승격됐고, 앱은 자기가
쥔 소켓과 자기 설정의 기본값 때문에 계속 죽어 있었다.** 이 문장이 rationale의
"커넥션을 못 갈아타면 장애는 계속된다"의 메커니즘 버전이다.

### 1-3. 왜 반개방 소켓은 조용히 스레드를 먹나 — TCP 메커니즘

TCP는 "연결이 살아 있다"를 상대의 명시적 통보(FIN/RST)로만 안다. 상대가
통보 없이 사라지면 내 쪽 소켓은 아무 일 없다는 듯 ESTABLISHED로 남는다.
이 상태를 반개방(half-open)이라 부른다. 여기서 앱 스레드가 빠져나올 수 있는
경로는 셋뿐인데, 기본값에서는 셋 다 사실상 닫혀 있다.

- **재전송 포기** — 내가 보낸 데이터에 ACK가 안 오면 커널이 재전송을 반복하다
  포기하고 에러를 올린다. 리눅스 기본(`tcp_retries2`)으로 십수 분 단위다.
  그리고 이건 **아직 ACK 못 받은 데이터가 있을 때만** 작동한다. 쿼리를 보내고
  ACK까지 받은 뒤 서버가 죽었다면 재전송할 게 없으므로 이 경로는 아예 없다.
- **TCP keepalive** — 유휴 소켓에 주기적으로 탐침을 보낸다. pgjdbc는
  `tcpKeepAlive`가 **기본 꺼짐**이고, 켜더라도 간격은 커널 값을 따르므로
  리눅스 기본은 **2시간**(`tcp_keepalive_time = 7200`) 유휴 후 시작이다.
  (서버 쪽에도 대칭으로 `tcp_keepalives_idle` 등이 있고, 복제 링크에는
  `wal_sender_timeout`/`wal_receiver_timeout`이 따로 있다 — 기본 60초. 즉
  **복제는 60초면 상대의 죽음을 알아채는데 앱은 2시간을 모른다.**)
- **애플리케이션 타임아웃** — `socketTimeout`. 드라이버가 `read()`에
  `SO_TIMEOUT`을 걸어 그 시간 안에 응답이 없으면 예외를 던진다. **이것만이 앱이
  직접 쥔 시계다.** pgjdbc의 기본값은 **0 = 무한**이고, 단위는 **초**다.

스레드 덤프에서 이 부류는 소켓 읽기 프레임(구형 JDK는
`SocketInputStream.socketRead0`, 신형은 `NioSocketImpl.park` 계열)에서 멈춰
있고, 상태는 RUNNABLE로 보이는 경우가 많아 "일하고 있는 것처럼" 읽힌다. 그
위 프레임에 pgjdbc의 결과 읽기(`PGStream.receiveChar`,
`QueryExecutorImpl.processResults`)와
`HikariProxyPreparedStatement.executeQuery`가 있으면 확정이다.

**한 가지 더 — 쿼리 타임아웃은 이 상황의 대체재가 아니다.** 이유가
PostgreSQL에서는 특히 분명하다. PG 프로토콜의 쿼리 취소는 **같은 커넥션으로
보내는 것이 아니라, 서버에 새 커넥션을 열어 (백엔드 pid + secret key)로 된
CancelRequest를 보내는** 방식이다. 서버가 죽었으면 그 새 커넥션도 안 맺힌다.
그래서 `@Transactional(timeout = n)`이나 `Statement.setQueryTimeout()`은
반개방 상황에서 스레드를 못 꺼내주고, 오히려 취소 시도가 pgjdbc의
`cancelSignalTimeout`(기본 10초)만큼 **더 매달린다.** 서버가 재는 시계인
`statement_timeout`도 같은 이유로 무력하다 — 서버가 없으면 재는 사람이 없다.

반개방 소켓에서 스레드를 꺼내주는 건 `socketTimeout`뿐이다. 그렇다고
`statement_timeout`이 필요 없다는 뜻은 아니다 — **방향이 반대다.**
`socketTimeout`으로 클라이언트가 소켓을 닫아도 **서버 쪽 백엔드 프로세스는
쿼리를 계속 돌린다**(PG는 결과를 보내려는 순간에야 클라이언트가 사라진 걸
알아챈다). 커넥션이 곧 프로세스이므로 그 좀비 백엔드는 CPU와 메모리를 그대로
먹는다. 그래서 **둘 다** 건다: `statement_timeout`(서버가 자기 자원을 회수)
< `socketTimeout`(클라이언트가 자기 스레드를 회수) — 정상 상황에서는 서버가
먼저 끊어 에러를 돌려주고, 서버가 사라진 경우에만 `socketTimeout`이 발동한다.

### 1-4. 왜 DNS가 두 겹인가

```text
앱 코드: new Socket("shop.cluster-xxxx.ap-northeast-2.rds.amazonaws.com", 5432)
   │
   ▼ ① JVM InetAddress 캐시   ← networkaddress.cache.ttl (보안 속성)
   │    있으면 여기서 끝. 리졸버에 묻지도 않는다
   ▼ ② OS 리졸버 / 사내 DNS 캐시  ← 레코드 TTL
   ▼ ③ 권한 DNS (관리형 DB가 갱신하는 곳)
```

JVM 캐시의 기본값은 환경에 따라 다르다 — 보안 관리자가 설치돼 있으면
**영구**, 없으면 구현별 기본(OpenJDK 계열은 30초). 컨테이너 베이스 이미지나
런타임 옵션에 따라 예상과 다를 수 있으므로 **명시적으로 짧게 고정**한다(§3-3).

그리고 다시 강조하면 — 이 두 겹은 **새 커넥션**에만 관여한다. 풀에 이미 있는
커넥션은 DNS와 무관하게 구 IP에 붙어 있다. DNS를 고쳐도 §1-2 (b)(c)는 그대로다.
PostgreSQL 쪽에는 이 두 겹을 **건너뛰는 길**이 하나 더 있다는 것이 차이다 —
pgjdbc의 다중 호스트 URL(§3-4)은 후보 호스트를 앱이 직접 확인하므로 DNS 갱신을
기다리지 않는다(단, 거기 적은 것이 호스트명이면 그 호스트명은 여전히 DNS로
풀린다).

## 2. failover 중 앱이 겪는 증상 10종 (공통 8 + PostgreSQL 고유 2)

> 약점 ④(목록 인출) 겨냥. 번호와 한 줄 원인을 세트로 외운다. 면접에서
> "어떤 증상이 나타나나요"는 이 목록을 순서대로 읊는 자리다.

1. **`An I/O error occurred while sending to the backend` / `This connection
   has been closed` / `terminating connection due to administrator command`**
   — §1-2 (a). SQLState 08006 / 08003 / 57P01. 닫힌 소켓을 쓴 순간 난다.
   일시적이고 스스로 낫는다. 이것만 보이면 운이 좋은 failover다.
2. **응답 없이 멈춤(hang)** — §1-2 (b). 에러도 없고 로그도 없다. 스레드 덤프에
   소켓 읽기에서 멈춘 스레드가 쌓인다. `socketTimeout`이 없다는 증거.
3. **`Connection is not available, request timed out after 30000ms`** —
   풀 고갈. 2번의 결과다. 이 스레드들은 피해자이고 용의자는 2번 스레드들이다.
4. **DB와 무관한 API·헬스체크까지 5xx** — 3번의 30초 대기가 톰캣 스레드를
   다 먹었다. 이 시점부터 "DB 장애"가 "서비스 전면 장애"로 승격된다.
5. **읽기는 되는데 쓰기만 간헐적으로 실패** — §1-2 (c).
   `cannot execute INSERT in a read-only transaction`(25006). "간헐적"인 이유는
   풀의 일부 커넥션만 스탠바이에 붙어 있어서, 그 커넥션을 잡은 요청만
   실패하기 때문이다. 인프라는 이미 복구 완료라고 말하는 시점에 나타나서
   진단을 가장 혼란스럽게 만든다. 그리고 **로그는 25006 한 줄 뒤로 25P02가
   도배**돼 원인이 묻힌다.
6. **커밋 여부 불명** — 클라이언트는 COMMIT을 보내고 타임아웃/에러를 받았는데
   서버는 커밋을 끝냈을 수 있다. 재시도하면 중복, 안 하면 유실. 드라이버가
   이를 구분해 알려주는 경우 SQLState 08007("트랜잭션 결과 불명")로 온다.
7. **승격 직전 커밋의 유실** — §1-1 ②. 사용자는 "주문 완료" 화면을 봤는데
   새 프라이머리에 그 주문이 없다(그 WAL이 새 타임라인에 없다). "결제됐는데
   주문이 없다" 유형 사고의 인프라 쪽 원인 중 하나. 앱 로그에는 성공으로 남아
   있어 사후 대조로만 발견된다.
8. **재연결 폭풍과 기동 실패** — 파드들이 동시에 재시작/풀 재생성하며 새
   프라이머리로 몰린다. PG는 커넥션마다 프로세스를 fork하므로 비용이 바로
   드러난다: `53300 sorry, too many clients already`. 게다가 HikariCP는 기본적으로
   기동 시 첫 커넥션을 못 만들면 애플리케이션 기동 자체를 실패시키므로
   (`initializationFailTimeout` 기본 양수), failover가 끝나기 전에 재시작된
   파드는 뜨지도 못한 채 CrashLoop에 들어갈 수 있다.
9. **(PG 고유) 승격 직후 전반적 지연** — §1-1 ②′. 새 프라이머리의
   `shared_buffers`가 비어 있어 같은 쿼리가 디스크를 훨씬 많이 읽는다. 에러가
   아니라 **p99 상승**으로 나타나고, 짧은 `socketTimeout`이 여기서 정상 쿼리를
   죽이기 시작한다.
10. **(PG 고유) 세션 상태의 조용한 소실** — §1-2 네 번째 손실. `SET`으로
    걸어둔 `statement_timeout`이 사라지고, **세션 advisory lock이 풀려 "한 번만
    실행" 보장이 깨지며**, `LISTEN` 구독이 끊긴다. 에러 로그가 한 줄도 안
    남는다는 점에서 가장 늦게 발견된다.

1·3·4는 "죽는 동안"의 증상이고, **5·6·7·9·10은 "복구된 뒤"의 증상**이다. 인프라
팀과 앱 팀이 서로 "우리 쪽은 정상"이라고 말하는 순간은 늘 후자 때문에 온다.

## 3. 앱 측 대비 체크리스트 12항 — 설정과 코드로 고정한다

> 약점 ③(안전망을 코드로 고정) 겨냥. 항목마다 "어디에 무엇을 적는가"까지
> 내려간다. "타임아웃을 잘 잡는다"는 답이 아니다.

| # | 항목 | 어디에 | 막는 증상 |
|---|---|---|---|
| 1 | pgjdbc 타임아웃 + 서버 `statement_timeout` | JDBC URL / `data-source-properties` | 2 (반개방 무한 대기), 서버 좀비 백엔드 |
| 2 | HikariCP 4개 설정 | `spring.datasource.hikari.*` | 3, 4, 5의 수명 |
| 3 | JVM DNS 캐시 TTL | `Security.setProperty` / `java.security` | 5 (구 IP로 새 커넥션) |
| 4 | 다중 호스트 + `targetServerType=primary` | JDBC URL | 5 (애초에 스탠바이에 안 붙는다), 전환 대기 단축 |
| 5 | `25006` → evict, standby 접속 차단 | `SQLExceptionOverride` / `connection-init-sql` | 5 (좀비 커넥션) |
| 6 | 멱등 조건부 재시도 | 재시도 정책 코드 + 멱등키 UNIQUE | 6 (중복/유실) |
| 7 | 서킷 브레이커 (느린 호출 임계 포함) | Resilience4j 설정 | 4 (스레드 풀 전이), 9 (콜드 캐시 폭주) |
| 8 | 헬스체크 배치 | readiness에만 DB | 8 (재시작 폭풍) |
| 9 | 저하 모드 정의 | 기능 플래그 + 읽기용 별도 DataSource | 4를 "부분 장애"로 축소 |
| 10 | 커넥션 폭풍 차단 | PgBouncer / RDS Proxy 앞단 | 8 (53300), 9의 악화 |
| 11 | 관측·알람 | 풀 메트릭, SQLState별 카운터, `pg_is_in_recovery()` | 5를 30분 뒤가 아니라 30초 뒤에 알게 |
| 12 | failover 훈련 | 정기 절차 + 측정 | 1~11이 실제로 작동하는지 검증 |

### 3-1. pgjdbc 타임아웃 — 기본값은 무한이고, 단위는 초다

```yaml
# ❌ before — 타임아웃이 하나도 없다.
#    pgjdbc: socketTimeout=0 → 응답을 영원히 기다린다. tcpKeepAlive도 기본 꺼짐.
spring:
  datasource:
    url: jdbc:postgresql://shop.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:5432/shop
```

```yaml
# ✅ after — 클라이언트 시계 넷 + 서버 시계 둘
spring:
  datasource:
    url: jdbc:postgresql://shop.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:5432/shop
    hikari:
      data-source-properties:
        connectTimeout: 3          # 초. TCP 연결 수립 상한. 죽은 IP로 SYN을 보내고 무한정 기다리지 않는다
        loginTimeout: 5            # 초. 인증까지 포함한 접속 전체 상한 (연결은 됐는데 startup에서 매달리는 경우)
        socketTimeout: 10          # 초. read() 하나의 상한 — 반개방 소켓에서 스레드를 꺼내는 유일한 시계 (§1-3)
        cancelSignalTimeout: 2     # 초. 취소 요청 전용 커넥션의 상한. 이게 길면 타임아웃이 대기를 더 늘린다
        tcpKeepAlive: true         # 켠다. 다만 간격은 커널 값이라 이것만으로는 부족하다
        # 서버 쪽 시계를 커넥션마다 심는다. 여기(Properties)에서는 URL 인코딩이 필요 없다
        options: "-c statement_timeout=9000 -c idle_in_transaction_session_timeout=30000 -c lock_timeout=3000"
```

**단위 함정이 이 문서에서 가장 흔한 실수다.** MySQL Connector/J의
`socketTimeout=10000`(밀리초, 10초)을 pgjdbc URL에 그대로 옮기면
**10000초 = 약 2.8시간**이 된다. 무한 대기를 고쳤다고 믿는 채로 사실상 아무것도
안 고친 상태가 된다. 반대로 `statement_timeout`은 **밀리초**다(`9000` = 9초).
한 파일 안에 초 단위와 밀리초 단위가 섞이므로 주석으로 단위를 박아 둔다.

**왜 `statement_timeout`(9초)이 `socketTimeout`(10초)보다 짧은가.** §1-3의
결론이다 — 정상 상황(서버는 살아 있는데 쿼리가 오래 걸림)에서는 **서버가 먼저
끊어 `57014 query_canceled` 에러를 돌려주는 편이 낫다.** 그러면 서버 쪽
백엔드 프로세스도 같이 회수되고, 앱은 "타임아웃"이 아니라 "취소됨"이라는 명확한
에러를 받는다. `socketTimeout`은 **서버가 사라져서 아무도 시계를 못 재는
경우**에만 발동하는 최후 수단으로 남겨 둔다.

- `socketTimeout`은 **이 DataSource로 나가는 가장 긴 정상 쿼리보다 길어야**
  한다. 10초로 잡았는데 월말 정산 쿼리가 40초라면 매달 말 배치가 죽는다.
  그래서 배치·통계용 DataSource는 분리해 다른 타임아웃을 준다(§4-1).
- URL 쿼리스트링으로 넘길 수도 있지만, `options`처럼 공백이 들어가는 값은
  **URL 인코딩**이 필요하다(`-c%20statement_timeout%3D9000`) — 그 실수를 피하려면
  위처럼 `data-source-properties`에 두는 편이 안전하다.
- `idle_in_transaction_session_timeout`을 같이 거는 이유 — failover 중에 열린
  채 방치된 트랜잭션은 락을 쥐고 VACUUM을 막는다
  ([`./16-long-transaction-harm-and-shortening.md`](./16-long-transaction-harm-and-shortening.md)).

> **MySQL 대조:** Connector/J는 `connectTimeout`·`socketTimeout` 둘 다 **기본
> 0(무한)**이고 단위는 밀리초다. 서버 쪽 대응은 `max_execution_time`(SELECT 전용,
> 밀리초). PG의 `statement_timeout`은 SELECT만이 아니라 모든 문장에 걸린다는
> 점이 다르다.

### 3-2. HikariCP — 기본값 넷을 바꾼다

```yaml
# ❌ before — 풀 크기만 정하고 나머지는 기본값. 각 기본값이 failover에서 무슨 뜻인지 주석으로 적어보면:
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      # connection-timeout: 30000   → 풀이 비면 30초 대기. 그동안 톰캣 스레드를 쥔다 (증상 3→4 전이)
      # validation-timeout: 5000    → 대여 전 isValid() 검사에 최대 5초
      # max-lifetime: 1800000       → 30분. 스탠바이에 붙은 커넥션(§1-2 c)의 최대 수명 = "앱 장애 30분"의 30분
      # keepalive-time: 0           → 꺼짐. 유휴 커넥션이 반개방이 돼도 다음 대여 때까지 모른다
```

```yaml
# ✅ after
spring:
  datasource:
    hikari:
      maximum-pool-size: 20             # PG는 커넥션=프로세스다. 크게 잡을수록 손해 (→ 15번 문서)
      connection-timeout: 3000          # 풀 대기 3초. 못 받으면 빨리 실패 → 톰캣 스레드를 돌려준다
      validation-timeout: 1000          # 대여 직전 isValid() 상한. connection-timeout보다 반드시 짧게
      max-lifetime: 300000              # 5분. 어떤 이유로든 잘못 붙은 커넥션은 5분 안에 자연 교체된다
      keepalive-time: 60000             # 1분마다 유휴 커넥션에 ping → 반개방을 사용 전에 발견해 조용히 교체
      exception-override-class-name: com.example.infra.db.StandbyConnectionEvictor   # §3-5
      # initialization-fail-timeout: -1 # (선택) 기동 시 DB에 못 붙어도 앱은 뜬다. failover 중 재시작돼도 CrashLoop로 안 감.
                                        #        대신 readiness가 트래픽을 막아줘야 한다 (§3-8)
```

넷의 역할 분담을 한 문장으로 — **`keepaliveTime`은 유휴 중 순찰,
`validationTimeout`은 유휴에서 대여로 넘어가는 관문, `socketTimeout`(§3-1)은
사용 중의 상한, `maxLifetime`은 모든 것이 실패했을 때의 최종 교체 주기**다.

- HikariCP는 커넥션이 일정 시간(짧은 우회 창) 이상 놀다가 대여될 때만
  `isValid()`로 검사한다. 즉 검사는 **사용 중에 죽은 커넥션**을 못 잡고
  (그건 `socketTimeout`의 몫), **살아 있지만 read-only인 커넥션**도 못 잡는다 —
  pgjdbc의 `isValid()`는 "이 소켓으로 왕복이 되는가"만 볼 뿐이다. 그래서 §3-5가
  따로 필요하다. (`connection-test-query`를 `SELECT pg_is_in_recovery()`로 바꿔도
  소용없다 — HikariCP는 테스트 쿼리의 **예외 발생 여부만** 보고 결과값은 안 본다.)
- `maxLifetime`은 **DB 쪽 커넥션 수명 상한보다 짧아야** 한다. PG에서는
  `idle_session_timeout`(PG 14+)이나 PgBouncer의 `server_lifetime`(기본 3600초)이
  그 상한이다. 그리고 줄이면 재연결 비용이 늘어나는데, PostgreSQL에서 그 비용은
  **백엔드 프로세스 fork**까지 포함하므로 스레드 모델보다 비싸다(§4-6). 5분은
  "장애 시 자연 치유 상한"과 "평시 재연결 비용" 사이의 타협값이지 정답이 아니다.

### 3-3. JVM DNS 캐시 — 시스템 속성이 아니라 보안 속성이다

```java
// ❌ before — 아무 것도 안 함. 기본값이 환경마다 다르고(30초 또는 영구), 아무도 확인한 적이 없다.

// ✅ after — 어떤 네트워크 호출보다 먼저, 진입점에서 고정
public static void main(String[] args) {
    java.security.Security.setProperty("networkaddress.cache.ttl", "5");           // 성공 캐시 5초
    java.security.Security.setProperty("networkaddress.cache.negative.ttl", "3");  // 실패(NXDOMAIN 등) 캐시 3초
    SpringApplication.run(ShopApplication.class, args);
}
```

- 이 값은 **보안 속성(security property)** 이라 `-Dnetworkaddress.cache.ttl=5`
  로 넘기면 **조용히 무시된다.** 코드에서 `Security.setProperty`로 넣거나,
  `$JAVA_HOME/conf/security/java.security` 파일을 이미지 빌드 시 덮어쓰거나,
  구형 호환 시스템 속성 `-Dsun.net.inetaddr.ttl=5`를 쓴다. 셋 중 하나를
  **Dockerfile이나 진입점에 박아** 배포 파이프라인이 보장하게 한다.
- 이걸 해도 §1-2의 기존 커넥션 문제는 남는다(DNS는 "새 커넥션이 어디로 가나"만
  정한다). 그리고 **다중 호스트 URL(§3-4)로 갔더라도 이 항목을 빼지 않는다** —
  거기 적은 것이 호스트명이면 여전히 이 두 겹을 통과한다.

### 3-4. 드라이버가 failover를 아는가 — PostgreSQL의 정석

DNS 전환을 기다리는 대신 드라이버가 후보 호스트를 직접 확인하게 하면 §1-1의
③④ 단계를 건너뛸 수 있다. **PostgreSQL에서는 이게 별도 도구 없이 pgjdbc에
내장돼 있다.**

```text
jdbc:postgresql://db-a.internal:5432,db-b.internal:5432,db-c.internal:5432/shop
    ?targetServerType=primary        # 접속 직후 그 서버가 읽기 전용인지 물어(pg_is_in_recovery /
                                     #   show transaction_read_only) 프라이머리인 호스트만 채택한다.
                                     #   아니면 다음 호스트로 넘어간다 → 스탠바이에 붙는 사고(§1-2 c)를 원천 차단
    &hostRecheckSeconds=2            # 호스트 상태 캐시 시간. 기본값은 이보다 길다(10초대) → 짧게 낮춰 둔다
    &loadBalanceHosts=false          # 기본값. URL에 적은 순서대로 시도한다(부하 분산이 아니라 페일오버 용도)
    &connectTimeout=3&socketTimeout=10&loginTimeout=5
```

읽기 전용 트래픽은 **같은 문법으로 반대 방향** DataSource를 하나 더 만든다 —
`targetServerType=preferSecondary`(스탠바이 우선, 없으면 프라이머리)로 두면
스탠바이가 다 죽어도 읽기는 계속된다. 이 두 DataSource 분리가 §3-9 저하 모드의
전제다.

**반드시 같이 말해야 하는 한계 셋.** ① **`targetServerType`은 접속 시점에만
검사한다** — 이미 맺어진 커넥션이 나중에 강등돼도 다시 확인하지 않는다. PG에서는
강등에 재시작이 따르는 게 보통이라 그 커넥션은 (a)로 끊기지만,
`default_transaction_read_only` 펜싱 구성(§1-2 (c)-4)에서는 안 끊긴다 → §3-5가
여전히 필요하다. ② **`hostRecheckSeconds` 동안은 낡은 판정을 믿는다** — 그 창
안에 만들어진 커넥션은 구 프라이머리로 갈 수 있다. ③ **호스트 목록이 정적이다**
— 노드를 추가/교체하면 URL을 고쳐 배포해야 하므로, 노드가 자주 바뀌면 HAProxy나
PgBouncer 앞단(§3-10)이 낫다.

**AWS Advanced JDBC Wrapper (가산점 포인트)** — Aurora PostgreSQL처럼 클러스터가
자기 토폴로지(누가 writer인가)를 SQL로 노출하는 경우, 래퍼 드라이버가 그 정보를
직접 조회해 **DNS 갱신을 기다리지 않고** 새 writer에 붙는다.

```text
jdbc:aws-wrapper:postgresql://shop-cluster.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:5432/shop?wrapperPlugins=failover
```

중요한 건 이 래퍼가 **재시도를 대신 해주지 않는다**는 점이다. failover가
성공하면 SQLState **08S02**(연결이 바뀌었다 — 세션 상태를 다시 세팅하고 트랜잭션을
재실행하라), 트랜잭션 도중이었다면 **08007**(커밋됐는지 알 수 없다)을 던진다.
즉 드라이버는 "여기까지 해줬으니 이제 네가 판단하라"고 예외로 알려줄 뿐이고,
그 판단이 §3-6이다. 어떤 도구를 써도 **"커밋됐는지 모르는 상태"는 드라이버가
없애줄 수 없다** — 그건 프로토콜 수준의 한계다. 그리고 08S02가 알려주는 "세션
상태를 다시 세팅하라"가 §1-2의 네 번째 손실 그 자체다.

> **MySQL 대조:** Connector/J의 다중 호스트 URL은 `failOverReadOnly`가 **기본
> `true`** — 두 번째 호스트로 넘어간 커넥션은 읽기 전용이 된다. 원래 "프라이머리가
> 죽으면 리플리카에서 읽기라도 계속하라"는 용도이기 때문이다. pgjdbc의
> `targetServerType`은 반대로 **"쓰기 가능한 호스트만 골라라"를 명시적으로
> 지시**하는 쪽이라, 잘못된 호스트에 붙는 사고를 접속 시점에 막는다. 그리고
> Connector/J의 `autoReconnect=true`는 MySQL 문서가 권장하지 않는 옵션이다 —
> 트랜잭션 상태를 모른 채 재접속해 §2-6의 불명 상태를 조용히 삼킨다. pgjdbc에는
> 그런 옵션 자체가 없다는 점이 오히려 안전하다.

### 3-5. 스탠바이에 붙은 커넥션을 풀에서 쫓아낸다 — `25006`

```java
// ❌ before — 아무 것도 안 함.
//    HikariCP 기본 판정: SQLState가 "08"로 시작하거나 치명적 상태 목록(PG의 57P01/57P02/57P03 포함)이면 evict.
//    25006은 둘 다 아니다 → 커넥션은 멀쩡히 풀로 돌아가 다음 요청을 또 실패시킨다.
```

```java
// ✅ after — "살아 있지만 쓰기가 안 되는" 커넥션을 evict 사유로 등록
package com.example.infra.db;

import com.zaxxer.hikari.SQLExceptionOverride;
import java.sql.SQLException;

public class StandbyConnectionEvictor implements SQLExceptionOverride {

    // (주의) 이 인터페이스의 중첩 enum 이름이 Override라 @Override 애노테이션과 이름이 겹친다.
    //        애노테이션을 생략하거나 @java.lang.Override로 쓴다.
    public Override adjudicate(SQLException e) {
        // ★ PostgreSQL에는 MySQL의 1290 같은 벤더 숫자 코드가 없다 — getErrorCode()는 항상 0이다.
        //    판정은 반드시 SQLState 문자열로 한다.
        String state = e.getSQLState() == null ? "" : e.getSQLState();

        if ("25006".equals(state)) {          // read_only_sql_transaction
            return Override.MUST_EVICT;       // 스탠바이/펜싱된 서버에 붙었다 → 이 커넥션은 못 쓴다
        }
        // 25P02(in_failed_sql_transaction)는 일부러 넣지 않는다.
        //   그건 "이 트랜잭션이 이미 실패했다"는 뜻일 뿐이고, 제약 위반 같은 평범한 앱 버그에서도 난다.
        //   커넥션 자체는 ROLLBACK 후 멀쩡하다 — 여기서 evict하면 정상 상황에서 풀을 갈아엎게 된다.
        // 08xxx(연결 실패)와 57P01/57P02/57P03(관리자 종료·크래시·기동 중)은
        //   HikariCP 기본 판정이 이미 evict한다. 우리가 메울 구멍은 25006 하나다.
        return Override.CONTINUE_EVICT;       // 나머지는 기본 판정에 맡긴다
    }
}
```

등록은 §3-2의 `exception-override-class-name`이다. 이 인터페이스는 비교적
최근 HikariCP에 들어온 것이니 사용 중인 버전에 있는지 확인한다. 없거나
더 거칠어도 되면 두 번째 방법:

```java
// 대안 — read-only 에러를 감지한 지점에서 풀 전체를 소프트 리셋
// 유휴 커넥션은 즉시 폐기, 사용 중인 것은 반환되는 순간 폐기. 새 커넥션은 (라우팅이 갱신됐다면) 새 프라이머리로 붙는다.
hikariDataSource.getHikariPoolMXBean().softEvictConnections();

// 또는 문제의 커넥션 하나만
hikariDataSource.evictConnection(connection);
```

정밀도와 부작용의 차이 — `SQLExceptionOverride`는 **그 커넥션만** 버리고,
`softEvictConnections()`는 **20개를 한 번에** 버려 재연결 파도를 만든다
(PostgreSQL에서는 그 파도가 곧 프로세스 20개 동시 fork다). 대신 후자는
"스탠바이에 붙은 커넥션이 몇 개인지 모른다"는 불확실성을 한 방에 없앤다 —
failover 직후 한 번이고 앞단에 PgBouncer가 있다면 오히려 깔끔하다.

**(가산점 포인트) 애초에 스탠바이 커넥션을 풀에 못 들어오게 막는 법.**
`targetServerType`을 못 쓰는 구성(단일 엔드포인트, 프록시 뒤)이라면
HikariCP의 `connection-init-sql`로 접속 시점에 검사할 수 있다. 이 SQL이
예외를 던지면 그 커넥션은 풀에 등록되지 않는다.

```yaml
spring:
  datasource:
    hikari:
      connection-init-sql: >-
        DO $$ BEGIN IF pg_is_in_recovery() THEN
          RAISE EXCEPTION 'connected to a standby'; END IF; END $$
```

대가도 같이 말한다 — failover 중에는 **모든 커넥션 생성이 실패**하므로 풀이
비어 있는 채로 `connectionTimeout`까지 대기하다 실패한다. 즉 이 설정은 "틀린
곳에 쓰기"를 "빠른 실패"로 바꾸는 것이고, 그 빠른 실패를 받아줄 서킷
브레이커(§3-7)와 저하 모드(§3-9)가 함께 있어야 한다.

이 항목이 왜 결정적인지를 한 줄로 — **§3-1~3-4는 전부 "죽은 커넥션"이나 "새
커넥션의 목적지"를 다루고, 이것만이 "이미 풀에 들어와 살아 있는 틀린 커넥션"을
다룬다.** 앞의 넷을 완벽히 해도 이게 없으면 §5의 30분은 그대로 온다.

### 3-6. 재시도 — "무조건"에서 "멱등 조건부"로

> 약점 ②·③ 동시 겨냥. 재시도는 안전망이면서 동시에 사고 원인이다. 어떤
> 조건에서 재시도하는지를 **코드로** 말한다.

```java
// ❌ before — "DB 에러면 3번" 한 줄. 무엇을 재시도하는지 모른다.
@Retryable(maxAttempts = 3)                 // 예외 종류 불문
@Transactional
public Order placeOrder(PlaceOrderCommand cmd) {
    return orderRepository.save(Order.from(cmd));
}
// 1차: INSERT → COMMIT 전송 → 서버는 커밋 완료 → 응답이 돌아오기 직전 프라이머리 다운 → 클라이언트는 타임아웃
// 2차: 새 프라이머리에 (복제됐다면) 이미 주문이 있음 → 같은 주문이 한 건 더 들어간다
// 그리고 20개 파드 × 3회 재시도가 동시에 새 프라이머리를 두드린다 (retry storm = 프로세스 fork 폭풍)
```

```java
// ✅ after ① — 쓰기에 멱등키를 심는다. 이것이 없으면 뒤의 어떤 재시도 정책도 안전하지 않다.
//    PostgreSQL에서는 ON CONFLICT로 "이미 있으면 그것을 돌려준다"를 한 문장에 담을 수 있다.
@Transactional
public Order placeOrder(PlaceOrderCommand cmd) {
    // orders.idempotency_key 에 UNIQUE 제약(=중재자가 될 인덱스)이 있어야 ON CONFLICT를 쓸 수 있다
    return jdbcTemplate.queryForObject("""
        INSERT INTO orders (idempotency_key, user_id, amount, status, created_at)
        VALUES (?, ?, ?, 'PAID', now())        -- JDBC 자리표시자는 ?다. psql에서 직접 쓸 때만 $1, $2
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id, idempotency_key, user_id, amount, status
        """, orderRowMapper, cmd.idempotencyKey(), cmd.userId(), cmd.amount());
    // 주의: DO NOTHING이면 충돌 시 RETURNING이 0행이다 → 호출부가 그때 SELECT로 기존 행을 읽는다.
    //      (한 문장으로 끝내고 싶으면 DO UPDATE SET id = orders.id 같은 no-op 갱신을 쓰지만,
    //       PG의 UPDATE는 값이 같아도 새 튜플 버전을 만들어 bloat·WAL을 낳으므로 권하지 않는다)
}
```

```java
// ✅ after ② — 예외를 분류해 "재시도 / 대조 / 실패"를 가른다. 판정 기준은 전부 SQLState다.
public enum RetryDecision { RETRY, RECONCILE, FAIL }

public final class DbRetryPolicy {

    /** @param idempotent 이 작업을 두 번 실행해도 결과가 같은가 (읽기, 또는 멱등키가 있는 쓰기) */
    public static RetryDecision classify(Throwable t, boolean idempotent) {
        SQLException sql = unwrapSqlException(t);
        if (sql == null) return RetryDecision.FAIL;

        String state = sql.getSQLState() == null ? "" : sql.getSQLState();

        // ① 커밋 여부 불명 — 표준 08007(transaction_resolution_unknown). 여기가 "대조"가 필요한 자리다.
        if ("08007".equals(state)) {
            return idempotent ? RetryDecision.RETRY : RetryDecision.RECONCILE;
        }
        // ② 연결 계열(08xxx) / 소켓 타임아웃 — "요청이 서버에 닿았는지"부터 모른다
        if (state.startsWith("08") || sql instanceof java.sql.SQLTimeoutException) {
            return idempotent ? RetryDecision.RETRY : RetryDecision.RECONCILE;
        }
        // ③ 서버가 내려가는/올라오는 중 — 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now.
        //    57P01은 in-flight 문장의 커밋 여부를 알 수 없으므로 ②와 같은 취급.
        if (state.startsWith("57P")) {
            return idempotent ? RetryDecision.RETRY : RetryDecision.RECONCILE;
        }
        // ④ 스탠바이/펜싱된 서버에 붙었다(25006) — 문장 자체가 거부돼 부분 적용이 없다.
        //    커넥션은 §3-5가 버리므로 다른 커넥션으로 재시도해도 안전하다.
        //    (트랜잭션 중간이었다면 이미 25P02로 오염됐으니 롤백이 선행돼야 한다)
        // ⑤ 접속 포화(53300) — 백오프 후 재시도. 서킷이 열려 있으면 시도 자체를 접는다.
        // ⑥ 직렬화 실패(40001)·데드락(40P01) — failover와 무관하지만 재시도가 정답인 다른 부류.
        if ("25006".equals(state) || "53300".equals(state)
                || "40001".equals(state) || "40P01".equals(state)) {
            return RetryDecision.RETRY;
        }
        // 제약 위반·문법 오류·권한 등 나머지 — 다시 해도 같은 결과
        return RetryDecision.FAIL;
    }
}
```

```java
// ✅ after ③ — 정책을 적용하는 쪽. 멱등키 충돌은 "이미 됐다"로 해석한다.
public Order placeOrderResilient(PlaceOrderCommand cmd) {
    int attempt = 0;
    while (true) {
        attempt++;
        try {
            return placeOrder(cmd);
        } catch (DataIntegrityViolationException dup) {
            // 멱등키 UNIQUE 충돌 = 앞선 시도가 실제로는 커밋돼 있었다 → 그 결과를 돌려준다 (중복 생성이 아니다)
            return orderRepository.findByIdempotencyKey(cmd.idempotencyKey()).orElseThrow();
        } catch (DataAccessException e) {
            RetryDecision d = DbRetryPolicy.classify(e, /* idempotent */ true);   // 멱등키가 있으므로 true
            if (d == RetryDecision.RETRY && attempt < 3) {
                backoffWithJitter(attempt);      // 지수 백오프 + 지터: 20개 파드가 같은 순간에 다시 몰리지 않게
                continue;
            }
            if (d == RetryDecision.RECONCILE) {
                reconciliationQueue.enqueue(cmd);  // 사람/보정 배치가 "실제로 커밋됐나"를 대조. 재시도로 뭉개지 않는다
            }
            throw e;
        }
    }
}
```

세 조각의 역할 — ①이 없으면 ②의 `idempotent=true`가 거짓말이 되고, ②가 없으면
③은 before와 같다. 면접에서 "재시도 하겠다"고 말했으면 반드시 **"무엇이 멱등을
보장하는가"** 가 따라와야 한다
([`../03-jpa-orm/14-unique-constraint-concurrent-insert.md`](../03-jpa-orm/14-unique-constraint-concurrent-insert.md)의
"DB가 마지막 심판"과 같은 뿌리이고, PG에서는 그 심판을 `ON CONFLICT`로 쿼리 한
문장 안에 넣을 수 있다).

> **MySQL 대조:** 같은 자리에서 MySQL은 `INSERT ... ON DUPLICATE KEY UPDATE`나
> `INSERT IGNORE`를 쓰고, 예외 분류는 **SQLState가 아니라 벤더 숫자 코드**
> (1290/1836/1213…)로 하는 코드가 많다. pgjdbc는 `getErrorCode()`가 0이므로
> 그 코드를 그대로 옮기면 **모든 분기가 조용히 FAIL로 떨어진다** — 마이그레이션
> 때 실제로 자주 나는 사고다.

### 3-7. 서킷 브레이커 — 실패를 빨리 해서 스레드 풀을 지킨다

```yaml
resilience4j:
  circuitbreaker:
    instances:
      primaryDb:
        slidingWindowType: COUNT_BASED
        slidingWindowSize: 50
        failureRateThreshold: 50            # 최근 50건 중 50% 실패면 OPEN
        slowCallDurationThreshold: 2s        # 2초 넘는 호출은 "느린 호출"
        slowCallRateThreshold: 80            # 느린 호출 80% 이상이면 OPEN — 타임아웃 전에 먼저 반응
                                             #   ★ 승격 직후 콜드 캐시(§1-1 ②′)에 반응하는 것이 이 항목이다
        waitDurationInOpenState: 10s         # 10초 뒤 HALF_OPEN으로 탐침
        permittedNumberOfCallsInHalfOpenState: 5
        recordExceptions:
          - org.springframework.dao.DataAccessResourceFailureException   # 연결 실패(08xxx·57P0x 번역)
          - org.springframework.dao.QueryTimeoutException                # socketTimeout / statement_timeout 번역
          - org.springframework.dao.TransientDataAccessResourceException
        ignoreExceptions:
          - org.springframework.dao.DataIntegrityViolationException      # 제약 위반은 DB 장애가 아니다
          - org.springframework.dao.CannotSerializeTransactionException  # 40001은 재시도할 일이지 서킷 열 일이 아니다
```

```java
@CircuitBreaker(name = "primaryDb", fallbackMethod = "placeOrderUnavailable")
public Order placeOrderResilient(PlaceOrderCommand cmd) { ... }

private Order placeOrderUnavailable(PlaceOrderCommand cmd, CallNotPermittedException e) {
    // 마이크로초 만에 실패. 톰캣 스레드는 즉시 반환된다. 클라이언트에는 503 + Retry-After.
    throw new ServiceTemporarilyUnavailableException("주문 처리가 잠시 지연되고 있습니다", Duration.ofSeconds(10));
}
```

왜 필요한가를 사슬로 — 서킷이 없으면 failover 중 **모든 요청이**
`connectionTimeout`(3초) 또는 `socketTimeout`(10초)을 꽉 채운 뒤 실패한다.
초당 200요청이면 10초 동안 2,000개 스레드가 필요하다. 톰캣은 200개다. 서킷이
OPEN이면 요청은 즉시 실패하고, 스레드는 즉시 돌아오고, 헬스체크와 DB 무관
기능은 계속 응답한다. **PostgreSQL에서는 이득이 하나 더 있다** — 재연결 폭풍
대신 HALF_OPEN의 탐침 5개만 오면, 이제 막 승격돼 캐시가 비어 있는 서버가
프로세스 수백 개를 동시에 fork하지 않아도 된다. **서킷 브레이커는 "우리를
지키는 장치"이자 "복구 중인 DB를 지키는 장치"** 다.

주의 — 서킷 인스턴스는 **DataSource 단위**로 나눈다. 쓰기용(`targetServerType=
primary`) 서킷이 열렸다고 읽기용(`preferSecondary`) 조회까지 막으면 살릴 수
있는 읽기를 죽인다. 이 분리가 §3-9의 전제이기도 하다.

### 3-8. 헬스체크 배치 — liveness에 DB를 넣지 않는다

failover 중 DB 체크가 liveness에 있으면 §2-8이 확정된다: 프로세스는 멀쩡한데
DB가 아프다고 재시작 → 뜨자마자 또 실패 → CrashLoop → 재시작할 때마다 새
프라이머리로 커넥션 폭풍(= 프로세스 fork 폭풍). **readiness에만** 넣어 "트래픽만
빼고 프로세스는 살아서 재연결을 시도"하게 한다.

PostgreSQL에서 한 가지 덧붙일 것 — readiness의 DB 체크를 `SELECT 1`이 아니라
**"쓰기가 가능한가"**로 만들 수 있다.

```java
@Component
class WritablePrimaryHealthIndicator implements HealthIndicator {
    @Override public Health health() {
        // 한 번의 왕복으로 "쓰기가 되는가 + 지금 어느 서버에 붙었는가"를 같이 받는다
        Map<String, Object> r = jdbcTemplate.queryForMap(
            "SELECT pg_is_in_recovery() AS standby, inet_server_addr()::text AS server");
        return Boolean.TRUE.equals(r.get("standby"))
            ? Health.down().withDetails(r).build()
            : Health.up().withDetails(r).build();
    }
}
```

다만 대가를 같이 본다 — **이걸 readiness에 그대로 걸면 failover 중 모든 파드가
동시에 NotReady가 되어 읽기 트래픽까지 끊긴다.** 그래서 실무에서는 이 지표를
readiness가 아니라 **저하 모드 전환 신호(§3-9)와 알람(§3-11)**으로 쓰고,
readiness에는 "이 프로세스가 요청을 받을 수 있는가"만 남기는 구성이 안전한
경우가 많다. 판단 기준과 설정은
[`../15-container-infra/liveness-readiness-probe-db-check.md`](../15-container-infra/liveness-readiness-probe-db-check.md)
§3·§5.

### 3-9. 저하 모드(degraded mode) — "전부 아니면 전무"를 피한다

failover 중 선택지가 "정상 아니면 5xx"뿐이면 §2-4는 피할 수 없다. 미리
정의해두는 것들:

- **쓰기 차단, 읽기 유지** — 기능 플래그 `writes.enabled=false`를 서킷 OPEN
  이벤트나 운영자가 켠다. 쓰기 엔드포인트는 503과 안내 문구, 조회는 §3-4의
  `targetServerType=preferSecondary` DataSource로 **스탠바이에서 계속 서빙**.
  상품 목록은 보이고 주문 버튼만 잠기는 상태.
  > 단 "읽기는 무료"가 아니다 — 스탠바이 읽기에는 PG 고유의 대가가 붙는다(§4-3).
- **지연 가능한 쓰기는 큐로** — 조회수·로그·알림처럼 "나중에 반영돼도 되는"
  쓰기는 메시지 큐/아웃박스에 쌓았다가 복구 후 흘려보낸다. 주문·결제처럼
  즉시 확정이 필요한 쓰기는 이 방식이 안 된다 — 사용자에게 "완료"를 말할 수
  없기 때문이다.
- **캐시 응답에 시각 표시** — "3분 전 기준" 같은 표기와 함께 마지막 성공
  응답을 돌려준다.

무엇을 어느 모드로 내릴지는 장애 중에 정할 수 없다. 평시에 도메인별로
정해두고(§3-12 훈련에서 검증), 이 결정의 대가는 §4-3에서 다룬다.

### 3-10. 커넥션 폭풍 차단 — PostgreSQL에서는 앞단 풀러가 기본기다

이 항목이 PostgreSQL 문서에서만 체크리스트에 오르는 이유는 하나다 —
**PG의 커넥션은 스레드가 아니라 OS 프로세스**이기 때문이다. 파드 20개 × 풀
20개 = 400 커넥션이면 DB에 백엔드 프로세스 400개가 뜬다. `max_connections`
기본값은 100이고, 초과하면 `53300 sorry, too many clients already`다
(운영자용으로 `superuser_reserved_connections` 기본 3개가 남겨져 있어, 그
덕에 장애 중에도 `psql`로 들어갈 수는 있다).

```text
❌ 앱 파드 20개 → 각자 HikariCP 20 → PostgreSQL 백엔드 프로세스 400개
   failover 후 전 파드가 동시에 풀 재생성 → fork 400회 + 콜드 캐시 → 승격된 서버가 무릎을 꿇는다

✅ 앱 파드 20개 → 각자 HikariCP 20 → PgBouncer(transaction pooling) → PostgreSQL 백엔드 40개
   앱 쪽 커넥션 400개는 PgBouncer가 받아내고, 실제 DB 프로세스는 default_pool_size만큼만 유지
```

- **PgBouncer는 앱과 같은 노드(사이드카)나 DB 앞단에 둔다.** failover 시
  운영 자동화가 `host=`를 새 프라이머리로 바꾸고 `RELOAD`, 필요하면 `RECONNECT`
  (반환되는 서버 커넥션부터 새로 맺게 한다)나 `PAUSE`/`RESUME`으로 전환 창을
  통제한다. **RDS Proxy**는 같은 일을 관리형으로 해준다.
- **대가는 §4-5에서 자세히** — transaction pooling은 세션 상태(`SET`, 세션
  advisory lock, `LISTEN`, 임시 테이블)를 보장하지 못한다.
- **주의: PgBouncer의 `server_check_query`(기본 `select 1`)도 §1-2 (c)를 못
  잡는다** — HikariCP `isValid()`와 정확히 같은 한계다(스탠바이에서도 성공).
  즉 프록시를 뒀다고 §3-5가 필요 없어지지 않는다.

> **MySQL 대조:** MySQL은 커넥션이 스레드이고 thread cache가 있어 커넥션 수백
> 개를 그럭저럭 버틴다. 그래서 "앱 풀 = DB 커넥션"으로 두는 구성이 흔하고,
> ProxySQL·RDS Proxy는 있으면 좋은 선택지에 가깝다. PostgreSQL에서는 규모가
> 조금만 커져도 **필수에 가까워진다**는 것이 설계 판단의 실질적 차이다
> ([`./15-connection-count-vs-throughput.md`](./15-connection-count-vs-throughput.md)).

### 3-11. 관측 — 30분 뒤가 아니라 30초 뒤에 알게

- **풀 메트릭** — `hikaricp.connections.pending`(대기 수), `.acquire`(대여
  대기 시간), `.timeout`(대여 실패 수), `.active`. failover 중 `active=max,
  pending↑, timeout↑`이 기본 파형이고, **DB가 복구됐다는데 `active`가 안
  내려오면** §1-2 (b)다.
- **에러 분류 카운터** — 예외를 **SQLState**로 나눠 센다(PG에는 벤더 코드가
  없어 이게 유일한 축이다): `08*`, `25006`, `25P02`(25006의 그림자), `53300`,
  `57P01/02/03`, `40001/40P01`. **`25006`이 failover 완료 알림 뒤에도 0이 안
  되면** §1-2 (c)다 — 이 카운터 하나가 §5의 30분을 30초로 만든다.
- **톰캣 스레드 사용률** — `tomcat.threads.busy`가 `max`에 붙으면 §2-4
  진입. 풀 메트릭보다 이게 먼저 알람이 되면 순서가 잘못된 것이다.
- **DB 쪽 지표** — 프라이머리에서 `pg_stat_replication`(`sync_state`,
  `write_lag`/`flush_lag`/`replay_lag`), 스탠바이에서
  `pg_last_xact_replay_timestamp()`, 커넥션 압박은
  `pg_stat_database.numbackends` vs `max_connections`, 승격 직후의 느림(§2-9)은
  `pg_stat_database`의 `blks_hit`/`blks_read` 비율.
- **합성 쓰기 체크** — 1분마다 하트비트 테이블에 한 건. **읽기가 아니라
  쓰기**여야 (c)를 잡는다. 어느 서버에 붙었는지까지 같이 남긴다.

```sql
-- 앱이 주기적으로 실행하는 합성 쓰기: "쓰기가 되는가 + 지금 어디에 붙어 있는가"를 한 번에
INSERT INTO app_heartbeat (app_instance, beat_at, server_addr, in_recovery)
VALUES ($1, now(), inet_server_addr(), pg_is_in_recovery())
ON CONFLICT (app_instance)
DO UPDATE SET beat_at      = EXCLUDED.beat_at,
              server_addr  = EXCLUDED.server_addr,
              in_recovery  = EXCLUDED.in_recovery
RETURNING beat_at;
```

이 쿼리가 마지막으로 성공한 시각이 **"앱 기준 failover 완료 시각"**이고,
인프라의 완료 알림과 이 시각의 차이가 §3-12에서 측정하는 숫자다.

### 3-12. failover 훈련 — 설정은 실행해봐야 설정이다

위 열한 항목은 전부 "failover가 났을 때만" 검증된다. 그래서 정기적으로 일부러
낸다.

```bash
# 관리형(RDS/Aurora PostgreSQL)
aws rds failover-db-cluster --db-cluster-identifier shop-cluster

# Patroni — 두 가지를 구분해서 해봐야 한다
patronictl -c /etc/patroni.yml switchover --master pg-1 --candidate pg-2   # 계획된 전환: (a)만 만든다
patronictl -c /etc/patroni.yml failover   --candidate pg-2                 # 리더를 잃은 상황

# 진짜 (b)를 만드는 유일한 방법: 프로세스 종료가 아니라 "말없이 사라지게" 하기
sudo iptables -A INPUT -p tcp --dport 5432 -j DROP     # 또는 인스턴스 강제 정지
```

마지막 줄이 훈련의 핵심이다 — **정상 종료 시나리오만 돌리면 §1-2 (a)만
재현되고, 정작 무서운 (b)(반개방)와 (c)(스탠바이 좀비)는 한 번도 검증되지
않는다.** "failover 테스트 해봤는데 괜찮았어요"의 대부분이 이 함정이다.

```text
같은 시각부터 측정하는 것
 ① 인프라 완료 시각: 클러스터 이벤트 / patronictl list의 Leader 전환
 ② 앱 완료 시각:     마지막 파드의 합성 쓰기(§3-11)가 다시 성공한 시각
 ③ 그 사이 5xx 건수·최대 지속 시간, 재시작된 파드 수(0이어야 한다),
    25006 카운터가 0으로 돌아온 시각, 53300이 한 번이라도 났는지
```

②−①이 이 문서 전체가 줄이려는 숫자다. 이 숫자를 **드라이버·풀·JVM 설정을
바꿀 때마다** 다시 잰다 — 설정 변경 PR에 "failover 훈련 결과: 앱 RTO 45초 →
12초"가 붙으면 그 팀은 이 문항을 이미 통과한 팀이다. 리허설 없이 처음 겪는
failover는 훈련이 아니라 사고다(rationale의 "백업과 복구의 거리"와 같은 논리).

## 4. 트레이드오프 — 모든 안전망에는 대가가 있다

> 약점 ②(양면 조립) 정면 겨냥. 고난이도에서는 "이렇게 하면 됩니다"가 아니라
> "이렇게 하면 이걸 얻고 저걸 잃습니다"가 답이다. 각 항목을 **얻는 것 → 잃는 것
> → 그래서 어디에 선을 긋나** 세 박자로 말한다.

| 안전망 | 얻는 것 | 잃는 것 |
|---|---|---|
| 짧은 타임아웃·짧은 리더 키 TTL | 빠른 감지, 짧은 RTO | 오탐(긴 정상 쿼리·GC 멈춤·승격 직후 콜드 캐시를 장애로), 플래핑 |
| 자동 재시도 | 순단 흡수, 사용자 무인지 | 비멱등 쓰기 중복, 재시도 폭풍(= PG에서는 프로세스 fork 폭풍) |
| 읽기 전용 저하 모드 | 부분 장애로 축소 | 쓰기 기능 상실, 모든 쓰기 경로의 모드 분기, 스탠바이 읽기의 복구 충돌 |
| 동기 복제(`synchronous_commit`) | RPO 0에 근접 | 쓰기 지연, **동기 스탠바이가 없으면 커밋이 무한 대기**(PG에는 자동 강등이 없다) |
| 프록시(PgBouncer·RDS Proxy) | 앱에 failover 투명, 커넥션 폭풍 흡수 | 추가 홉 지연, 프록시 자체 병목·장애점, **세션 상태 보장 상실** |
| 짧은 maxLifetime·keepalive | 좀비 조기 회수 | 재연결 비용(PG는 프로세스 fork), 주기적 재연결 파도 |

### 4-1. 빠른 감지의 대가 — 오탐과 플래핑

`socketTimeout`을 3초로 잡으면 반개방 스레드는 3초 만에 풀려난다. 그런데
월말 정산 쿼리도 3초에 죽는다. Patroni의 `ttl`을 10초로 줄이면 다운을 10초
만에 알지만, **큰 체크포인트가 만든 I/O 스파이크나 몇 초짜리 GC 멈춤이
failover를 유발한다.** failover 자체가 수십 초의 쓰기 불가를 만들므로 —
**오탐 한 번이 진짜 장애 한 번과 비용이 같다.** 감지가 예민할수록 플래핑도 는다.
PostgreSQL에서 특히 조심할 것은 **승격 직후가 오탐이 몰리는 구간**이라는 점이다
(§1-1 ②′) — 캐시가 빈 새 프라이머리에서 평소 200ms 쿼리가 3초를 넘기면, 짧게
잡아둔 `socketTimeout`이 "복구된 서버"를 다시 죽은 것으로 판정한다.

선을 긋는 법: **타임아웃은 워크로드별로 분리**한다. 온라인 트랜잭션용
DataSource는 `socketTimeout=10`(초), 배치·통계용은 별도 DataSource에 `600`.
리더 키 TTL·헬스체크 임계는 "우리 시스템이 감수할 수 있는 최대 정상 멈춤보다
조금 길게"가 출발점이고, 그 값은 실측(GC 로그·p99·체크포인트 통계)에서 온다.

### 4-2. 자동 재시도의 대가 — 중복과 폭풍

재시도는 순단을 사용자 모르게 넘긴다. 대신 두 가지를 잃는다. 첫째, **커밋
여부가 불명한 쓰기를 재시도하면 중복이다.** 타임아웃 하나에는 세 가지 결과가
숨어 있다 — 서버에 안 닿았음 / 닿아서 커밋됐고 WAL도 넘어갔음 / 커밋됐지만
그 WAL이 새 타임라인에 없음. 클라이언트는 셋을 구분할 수 없다. 재시도하면 두 번째
경우에 중복, 안 하면 첫·세 번째 경우에 유실이다. 이 삼거리를 없애는 유일한
방법이 멱등키(§3-6 ①)이고, 멱등키가 없다면 **재시도가 아니라 대조**가 맞다.

둘째, **재시도 폭풍**. 20개 파드 × 200 TPS × 3회가 같은 순간 새 프라이머리를
두드리면 겨우 승격된 DB가 다시 넘어진다. PostgreSQL에서는 단가가 더 비싸다 —
**새 커넥션 하나가 프로세스 fork 하나**이고, 그 프로세스들이 아직 캐시가 빈
서버에서 동시에 디스크를 때린다. 지수 백오프 + 지터 + 서킷 브레이커 + 앞단
풀러(§3-10) 없는 재시도는 장애 증폭기다.

선을 긋는 법: **읽기는 자유롭게, 쓰기는 멱등키가 있을 때만, 불명(08007·
57P01·타임아웃)은 멱등 아니면 대조 큐로.** 재시도 총량에도 예산을 둔다.

### 4-3. 읽기 전용 저하 모드의 대가

전면 장애를 "주문만 안 되는 상태"로 줄이는 건 큰 이득이다. 대가는 넷이다.
**① 쓰기 기능 상실 자체** — 그 시간 동안의 주문은 없다. 비즈니스가 "차라리
느리더라도 받아라"를 원할 수 있고, 그건 기술이 정할 일이 아니다. **② 코드
복잡도** — 모든 쓰기 경로가 모드를 확인해야 하고, "읽기처럼 보이지만 쓰는"
경로(로그인 시 마지막 접속 시각 갱신, 조회수 증가)가 모드를 뚫고 나가 25006을
만든다. 저하 모드는 만든 날이 아니라 훈련한 날(§3-12)에 완성된다. **③ 전환
판단의 오탐** — 서킷이 순간 스파이크에 열리면 멀쩡한 DB를 두고 쓰기를 막는다.

**④ (PostgreSQL 고유) 읽기를 스탠바이로 몰면 스탠바이가 원래 하던 일이
밀린다.** 긴 조회가 WAL 재생과 충돌해 취소되거나(`max_standby_streaming_delay`),
취소를 피하려고 `hot_standby_feedback`을 켜면 **프라이머리의 VACUUM이 지연돼
bloat**가 프라이머리로 되돌아온다
([`../03-jpa-orm/23-read-replica-routing-and-lag.md`](../03-jpa-orm/23-read-replica-routing-and-lag.md)).
저하 모드가 "읽기는 무료"라는 전제 위에 서 있지 않은지 확인해야 한다.

### 4-4. 동기 복제(RPO 0)의 대가 — PostgreSQL에서 특히 날카롭다

§1-1 ②의 유실을 없애려면 커밋 응답 전에 스탠바이 도달을 기다리면 된다.
PostgreSQL의 손잡이는 둘이다.

```sql
-- 어떤 스탠바이를 동기 후보로 볼 것인가
ALTER SYSTEM SET synchronous_standby_names = 'ANY 1 (pg2, pg3)';  -- 둘 중 아무나 하나만 응답하면 커밋
-- FIRST 1 (pg2, pg3) 이면 pg2 우선 — pg2가 아프면 pg3로 넘어간다

-- 어디까지 기다릴 것인가 (세션/트랜잭션 단위로도 바꿀 수 있다)
SET synchronous_commit = 'remote_write';  -- 스탠바이 OS까지 (fsync는 안 기다림)
SET synchronous_commit = 'on';            -- 기본. 스탠바이가 WAL을 fsync할 때까지
SET synchronous_commit = 'remote_apply';  -- 스탠바이에서 "읽으면 보이는" 상태까지 (읽기 일관성까지 산다)
```

대가는 **모든 쓰기 지연에 네트워크 왕복이 더해지는 것**과, 더 중요하게,
**가용성 결합**이다. 그리고 여기서 PostgreSQL과 MySQL의 결정적 차이가 나온다.

> **MySQL 대조:** MySQL 반동기 복제는 대기 시간에 상한을 두고
> (`rpl_semi_sync_master_timeout`) 초과하면 **비동기로 자동 강등**한다 — 즉
> "반동기를 켰으니 RPO 0"이 아니라 "평시엔 RPO≈0, 리플리카가 아플 땐 비동기"다.
> **PostgreSQL의 동기 복제에는 그런 타임아웃이 없다.** 동기 후보가 하나도
> 응답하지 않으면 커밋은 **무한정 기다린다.** 스탠바이 한 대짜리 구성에서
> 그 스탠바이가 죽으면 **프라이머리의 모든 쓰기가 멈춘다** — 가용성을 높이려고
> 붙인 스탠바이가 가용성을 0으로 만드는 구조다.

그래서 PG에서 동기 복제를 쓴다면 반드시 같이 오는 설계가 있다. ① **후보를 둘
이상 두고 `ANY 1`로** 잡아 한 대가 죽어도 커밋이 진행되게 한다 — 스탠바이를 두
대 이상 유지할 각오가 곧 동기 복제의 입장료다. ② Patroni의 `synchronous_mode`에
맡겨 동기 후보 목록을 자동 관리하게 한다(후보가 하나도 없을 때 비동기로 내릴지
`synchronous_mode_strict`로 쓰기를 막을지가 곧 CAP 선택이다). ③ **커밋 대기를
취소해도 커밋은 취소되지 않는다** — 대기 중 취소하거나 서버가 재시작되면 그
트랜잭션은 **로컬에는 이미 커밋된 상태**로 남는다. 즉 동기 복제조차
§2-6("커밋 여부 불명")을 없애지 못한다. ④ `remote_write`는 스탠바이 **OS
버퍼까지**만 보장하므로 스탠바이 호스트가 통째로 죽으면 그 WAL도 사라진다.

RPO 0이 진짜 요구라면 그 비용을 쓰기 지연으로 낼지, 공유 스토리지 구조
(Aurora)로 낼지, 아니면 애플리케이션 수준의 대조(§3-6 RECONCILE)로 낼지 —
셋 중 하나는 반드시 내야 한다.

### 4-5. 프록시(PgBouncer·RDS Proxy)의 대가

프록시가 DB 앞에 서면 앱은 프록시와만 커넥션을 맺고, failover는 프록시가
흡수한다 — 앱 쪽 커넥션은 끊기지 않고 진행 중 쿼리만 실패한다. §1-2 (b)(c)가
대부분 사라지고, **PostgreSQL에서 가장 큰 이득인 커넥션 멀티플렉싱**(§3-10)으로
파드 수 × 풀 크기가 그대로 프로세스 수가 되는 문제도 사라진다.

대가는 넷이다.

1. **홉 하나의 지연**, 그리고 **프록시 자체가 새로운 병목이자 장애점**이 된다
   (프록시의 failover는 누가 하나 — 그래서 앱 노드마다 사이드카로 띄우거나
   VIP/로드밸런서 뒤에 이중화한다).
2. **세션 상태 보장 상실 — PostgreSQL에서 가장 아픈 항목.** transaction pooling은
   트랜잭션이 끝나면 백엔드 커넥션을 회수해 다른 클라이언트에 준다. 그래서
   `SET`으로 걸어둔 파라미터, **세션 advisory lock**, `LISTEN` 구독, 임시
   테이블이 **다음 트랜잭션에 남아 있지 않는다.** 세션 단위 잠금이나 알림에
   의존하는 코드는 프록시를 뒤에 깔면 조용히 깨진다(§6 꼬리질문). 서버 준비문은
   PgBouncer 1.21+에서 지원되고, 그 전 버전이면 pgjdbc `prepareThreshold=0`으로
   꺼야 했다 — 그만큼 계획 재사용을 포기하는 것이다.
3. **세션 고정(pinning)** — RDS Proxy는 세션 상태를 바꾸는 동작을 감지하면 그
   세션을 특정 백엔드에 고정해 멀티플렉싱 효과가 사라진다. "프록시를 뒀는데
   커넥션이 안 줄어든다"의 단골 원인이다.
4. **프록시의 헬스체크도 (c)를 못 잡는다** — PgBouncer의 `server_check_query`
   기본값은 `select 1`이고 스탠바이에서도 성공한다. 프록시를 뒀다고
   §3-1·§3-5·§3-6이 필요 없어지지 않는다.

### 4-6. 짧은 `maxLifetime`·`keepaliveTime`의 대가

`maxLifetime` 5분은 좀비의 최대 수명을 30분에서 5분으로 줄인다. 대신 커넥션
하나당 5분마다 재연결 비용이 든다 — 그리고 **PostgreSQL에서 그 비용은 TCP +
TLS 핸드셰이크에 그치지 않고 백엔드 프로세스 fork + 초기화까지 포함**한다.
풀 20개 × 파드 20개 = 400개 커넥션이 5분 주기로 다시 맺어지면 DB 쪽
`numbackends`와 CPU에 주기적인 톱니가 보인다(HikariCP가 만료 시각에 작은 편차를
줘 동시 만료는 피한다).

선은 "장애 시 허용 가능한 자연 치유 상한"에서 긋는다 — §3-4(접속 시점 검증)와
§3-5(25006 evict)가 제대로 있으면 `maxLifetime`은 최종 보루일 뿐이므로 더 길어도
되고, 둘 다 없다면 `maxLifetime`이 곧 장애 시간이므로 짧아야 한다. 앞단에
PgBouncer가 있으면 앱→프록시 커넥션은 싸므로 짧게 잡아도 부담이 적다.

## 5. 실무 사례 — "승격은 40초 만에 끝났는데 쓰기가 30분 동안 간헐 실패"

**상황.** 새벽에 RDS PostgreSQL(Multi-AZ) 프라이머리 인스턴스가 장애로
failover. 인프라 알림은 "40초 만에 완료". 그런데 그 뒤 30분 동안 주문 API의
약 30%가 실패하고, 나머지 70%는 정상. 조회 API는 100% 정상. 앱 로그는
`current transaction is aborted, commands ignored until end of transaction
block`(25P02)으로 도배돼 있었다. 인프라 팀: "클러스터 정상, 새 writer 쓰기
가능 확인." 앱 팀: "코드 안 바꿨는데요."

**메커니즘 사슬.**

```text
failover 개시
 → 구 프라이머리 인스턴스 재기동 → 앱의 기존 커넥션 전부 끊김 (§1-2 a: 08006 / 57P01)
   → HikariCP evict → 풀 재생성 시작
 → 재생성 시점: 엔드포인트 DNS는 이미 새 프라이머리 IP로 갱신됐지만
   JVM InetAddress 캐시(이 이미지에서는 기본 30초)에는 구 IP가 남아 있음 (§1-4)
 → 그 30초 안에 만들어진 커넥션 20개 중 ~6개가 구 IP로 접속
 → 구 인스턴스는 이미 스탠바이로 재구성돼 recovery 상태. 접속은 성공, isValid()도 통과 (§1-2 c)
   (URL이 단일 엔드포인트라 targetServerType=primary 검증이 없었다 — §3-4 부재)
 → 이 6개로 나간 INSERT/UPDATE만 25006 실패. SELECT는 성공 → "30% 간헐, 쓰기만"
 → 트랜잭션 중간에 터진 25006이 그 트랜잭션을 오염 → 뒤따르는 문장이 전부 25P02
   → 로그에 25P02가 수십 배로 쌓여 진짜 원인 한 줄이 묻힘 (진단이 20분 지연된 실제 이유)
 → 25006의 SQLState는 "08"도 57P0x도 아님 → HikariCP evict 안 함 → 풀로 반환 → 다음 요청이 또 잡음
 → maxLifetime 기본 30분 도달 → 6개가 차례로 폐기·재생성 → 이번엔 DNS가 갱신돼 새 프라이머리로 → 자연 회복
```

"30분"은 아무도 설정한 적 없는 숫자다 — HikariCP `maxLifetime` 기본값
1,800,000ms가 그대로 장애 시간이 됐다. "30%"도 설정한 적 없다 — JVM DNS
캐시 30초 창 안에 몇 개가 만들어졌느냐가 정한 우연이다.

**곁가지로 드러난 것 하나.** 같은 시간대에 "야간 정산 배치가 두 번 돌았다"는
제보가 있었다. 배치는 `pg_advisory_lock`(세션 레벨)으로 단일 실행을 보장하고
있었는데, failover로 그 커넥션이 끊기면서 **락이 조용히 풀렸다**(§1-2 네 번째
손실). 재기동된 배치가 락을 새로 얻어 같은 구간을 다시 처리했다. 에러 로그는
한 줄도 없었다.

**재발 방지 — 코드로 고정한 것.**

1. **다중 호스트 URL + `targetServerType=primary&hostRecheckSeconds=2`**로 전환
   (§3-4). 스탠바이에는 애초에 붙지 않는다 — 이 한 줄이 이 사고의 근본 차단이다.
2. `Security.setProperty("networkaddress.cache.ttl", "5")` 진입점 고정 +
   Dockerfile에 `java.security` 덮어쓰기 (§3-3).
3. `StandbyConnectionEvictor` 등록 — `25006`을 MUST_EVICT로 (§3-5).
   **이것만 있었어도 30분이 "첫 실패 1회"로 끝났다.**
4. `max-lifetime: 300000` — 최종 보루를 30분에서 5분으로 (§3-2).
5. SQLState별 에러 카운터와 "`25006` > 0이 60초 지속" 알람, 합성 쓰기 체크
   (§3-11). `25P02`는 **원인이 아니라 그림자**이므로 알람에서 빼고 대시보드에서
   `25006`과 나란히 본다.
6. 배치의 단일 실행 보장을 세션 advisory lock에서 **DB 행 기반 리스(lease)**
   (`owner` + `expires_at` 컬럼)로 교체 — 커넥션이 끊겨도 리스는 만료 시각까지
   남고 복제도 된다.
7. 분기마다 스테이징 강제 failover, 앱 RTO(합성 쓰기 기준) 측정을 릴리스
   체크리스트에 추가 (§3-12). **정상 종료가 아니라 `iptables DROP`으로** 반개방
   시나리오까지 포함. 첫 훈련 결과 앱 RTO 31분 → 1·3번 적용 후 18초.

**회고에서 나온 문장.** "인프라가 40초 만에 복구했다는 말은 맞았다. 앱이
30분 동안 복구하지 않았다는 말도 맞았다. 두 팀 다 자기 경계 안만 봤고, 사슬의
가운데 — 소켓·DNS 캐시·풀의 evict 판정 — 는 누구의 경계도 아니었다." 이
"누구의 경계도 아닌 구간"을 자기 책임으로 끌어오는 것이 rationale의 "내 코드
밖에서 벌어지는 일까지 책임 범위로 보는 시야"다.

## 6. 꼬리질문 대비 포인트

### "failover가 끝났다는 알림을 받았는데 앱은 아직 에러입니다. 무엇부터 봅니까?"

**증상의 모양으로 §1-2의 세 부류 중 어느 것인지 먼저 가른다.** PostgreSQL에서는
판별 도구가 명확하다 — 벤더 코드가 없으니 **SQLState 한 축**으로 갈리고,
"내가 지금 어디에 붙어 있나"는 `inet_server_addr()`과 `pg_is_in_recovery()`가
한 번에 답한다.

- **읽기·쓰기 모두 실패 + 풀 `active`가 max에 붙어 안 내려옴 + DB는 한가**
  → (b) 반개방. 스레드 덤프에서 소켓 읽기(`PGStream`/`QueryExecutorImpl` 프레임)에
  멈춘 스레드를 확인. 즉효는 `softEvictConnections()`, 근본은 `socketTimeout`.
- **쓰기만, 그것도 일부만 실패 + `25006`(그 뒤로 `25P02` 무더기)** → (c) 스탠바이
  좀비. **앱 커넥션에서 그대로** `SELECT inet_server_addr(), pg_is_in_recovery()`
  를 날려 앱이 붙은 서버를 확인한다(psql로 따로 붙어 보면 정상으로 보이는 것이
  진단을 헤매게 하는 지점이다). 근본은 §3-4 + `SQLExceptionOverride`.
- **`08006`/`57P01`이 계속** → 라우팅이 아직 구 IP를 주고 있거나(`dig`는 새 IP인데
  앱은 구 IP로 SYN을 보내면 JVM 캐시 의심), 새 프라이머리가 포화라 접속이 거부되는
  중(`53300`). 후자는 `SELECT count(*) FROM pg_stat_activity` vs
  `SHOW max_connections`로 즉시 확인된다.
- **에러는 없는데 전부 느림** → §2-9. 승격 직후 콜드 캐시. `pg_stat_database`의
  `blks_read`가 평소보다 자릿수로 크면 확진.

"재시작해보겠습니다"는 마지막 답이다 — 재시작은 (b)(c)를 지우지만 원인도
같이 지워서 다음 failover에 그대로 재발한다. **재시작 전에 스레드 덤프와
`pg_stat_activity` 스냅샷을 남기는 것**이 시니어의 순서다.

### "`socketTimeout`을 몇 초로 잡을 건가요? 배치 쿼리는 그보다 긴데요."

**하나의 값으로 답하지 않는다. DataSource를 워크로드별로 나눈다.** 온라인
트랜잭션용은 "p99 쿼리 시간 × 여유 배수"(예: p99 300ms → 5~10초), 배치·통계용은
별도 DataSource(별도 HikariCP 풀)에 그 배치의 최장 실행 시간보다 긴 값. 같은
풀에 섞으면 §4-1의 오탐과 §1-3의 무한 대기 중 하나를 반드시 고른다. 덤으로 배치
풀 분리는 배치가 온라인 풀을 고갈시키는 것도 막는다
([`../02-spring/25-thread-pool-connection-pool-sizing.md`](../02-spring/25-thread-pool-connection-pool-sizing.md)).

PostgreSQL에서 세 가지를 덧붙이면 답이 완성된다. ① **단위가 초다** — MySQL
설정을 옮겨온 `socketTimeout=10000`은 10초가 아니라 2.8시간이다. ② **서버 쪽
`statement_timeout`을 조금 더 짧게 같이 건다** — 서버가 먼저 끊어야 서버의
백엔드 프로세스까지 회수되고, `socketTimeout`은 "서버가 사라진 경우"의 최후
수단으로 남는다(§1-3). ③ `socketTimeout`은 "쿼리 하나의 응답"이 아니라 "소켓
에서 **한 번의 read()**"의 상한이다 — 결과가 스트리밍으로 계속 오는 대량 조회는
각 패킷 사이 간격이 10초를 안 넘으면 전체가 10분이어도 안 끊긴다(그래서 커서
기반 대량 조회에는 `statement_timeout` 쪽이 실질적 상한이 된다).

### "타임아웃으로 실패한 결제 INSERT를 재시도해도 되나요?" (시니어 변별 포인트)

**"멱등키가 있으면 예, 없으면 재시도가 아니라 대조."** 이유를 세 갈래로 —
타임아웃 하나에는 (1) 서버에 안 닿았음 (2) 커밋됐고 그 WAL이 스탠바이로
넘어갔음 (3) 커밋됐지만 그 WAL이 승격된 새 타임라인에 없음, 세 결과가 숨어
있고 클라이언트는 구분 못 한다. 멱등키가 UNIQUE로 박혀 있으면 (2)에서 재시도는
제약 위반으로 튕기고 그 충돌을 "이미 됐음"으로 읽으면 되며 — PostgreSQL이면
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING`으로 그 판정을
쿼리 한 문장에 넣을 수 있다 — (1)(3)에서는 정상 삽입된다. 세 경우 모두 안전.

멱등키가 없으면 (2)에서 이중 결제다. 그때는 재시도 대신 **결제 ID로
`SELECT`해 실제 상태를 대조**하고, 대조도 안 되면(새 프라이머리에 없음 = (1)
또는 (3)) 사용자에게 "확인 중"을 보여주고 보정 큐로 넘긴다. 여기서 한 발 더 —
**(3)은 앱 로그에 "성공"으로 남아 있다.** 로그와 DB를 대조하는 배치가 없으면
사용자가 신고할 때까지 모른다. "결제됐는데 주문이 없다" 문항
([`./27-payment-succeeded-order-missing-incident.md`](./27-payment-succeeded-order-missing-incident.md))이
이 지점에서 이 문항과 만난다. 그리고 **동기 복제로 바꿔도 이 삼거리는 안
없어진다** — 커밋 대기를 취소해도 로컬 커밋은 남기 때문이다(§4-4).

### "세션 advisory lock으로 배치 단일 실행을 보장하고 있습니다. failover 중에는 어떻게 되나요?" (가산점 포인트 · PostgreSQL 고유)

**조용히 풀린다. 그리고 에러 로그가 한 줄도 안 남는다.** advisory lock은
**세션(커넥션)에 매달린 메모리 상의 락**이고 WAL에 기록되지 않는다. 그래서
① 커넥션이 끊기는 순간 해제되고, ② 새 프라이머리로 **복제되지도 않는다.**
failover가 나면 "락을 쥐고 있다고 믿는 배치"와 "락이 비었다고 보는 새 배치"가
동시에 존재할 수 있다.

같은 이유로 failover에서 조용히 사라지는 세션 자원이 더 있다 — `SET`으로
걸어둔 `statement_timeout`·`search_path`, `LISTEN` 구독(끊긴 동안의 `NOTIFY`는
재전송되지 않는다), 임시 테이블, 서버 준비문. **PgBouncer transaction pooling을
쓰면 failover가 아니어도 이 문제가 상시화된다**(트랜잭션마다 백엔드가 바뀌므로).

처방은 셋이다. ① **`pg_advisory_xact_lock`으로 범위를 트랜잭션으로 좁힌다** —
어차피 트랜잭션이 끝나면 풀릴 락이면 세션 락일 이유가 없고, 프록시 뒤에서도
안전하다. ② 배치 단일 실행처럼 **커넥션보다 오래 살아야 하는 잠금은 DB 행에
리스(lease)로 기록**한다 — `owner`와 `expires_at` 컬럼을 두고 만료 시각까지만
유효하게 하면, 커넥션이 끊겨도 잠금 상태가 DB에 남아 있고 복제도 된다.
③ 어느 쪽이든 **작업 자체를 멱등으로** 만들어 두 번 돌아도 결과가 같게 한다 —
잠금은 성능 최적화이지 정확성의 마지막 방어선이 아니다.

### "PgBouncer나 RDS Proxy를 두면 이 문제가 다 해결되나요?" (가산점 포인트)

**절반은. 그리고 PostgreSQL에서는 그 절반이 MySQL보다 크다.** 프록시는
§1-2 (b)(c)를 앱 대신 처리하고, 무엇보다 **커넥션 멀티플렉싱으로 "파드 수 × 풀
크기 = 백엔드 프로세스 수"라는 PG 특유의 폭발을 끊는다**(§3-10). 재연결
폭풍(§2-8)도 흡수한다.

**해결 안 되는 것 넷**: ① 커밋 여부 불명 — 프록시 뒤에서 죽은 트랜잭션의 결과는
프록시도 모른다(멱등키는 그대로). ② 앱→프록시 소켓의 반개방(`socketTimeout`은
그대로). ③ **세션 상태 보장 상실** — transaction pooling에서는 `SET`·세션
advisory lock·`LISTEN`·임시 테이블이 트랜잭션을 넘어 살아남지 않는다. 프록시가
"해결 못 하는 것"이 아니라 **새로 만드는 제약**이다. ④ 프록시 자체의 가용성과
세션 고정, 그리고 기본 헬스체크(`select 1`)가 스탠바이를 못 걸러낸다는 것(§4-5).
정리하면 **"프록시는 사슬의 DB 쪽 절반과 PG의 프로세스 모델 비용을 없애주지만,
앱 쪽 절반은 그대로 우리 몫이고 세션 상태라는 새 숙제를 준다."**

### "복제를 동기로 바꾸면 데이터 유실은 없어지나요?" (가산점 포인트)

**"유실 확률을 줄이는 대신 쓰기 지연과 가용성 결합을 산다. 그리고 PostgreSQL의
동기 복제에는 MySQL 반동기 같은 자동 강등이 없어서 그 결합이 더 날카롭다."**
동기 스탠바이가 하나도 응답하지 않으면 **커밋이 무한정 기다린다** — 스탠바이
한 대짜리 구성에서 그 스탠바이가 죽으면 프라이머리의 모든 쓰기가 멈춘다.
그래서 실무의 답은 "동기 켰습니다"가 아니라 **"`ANY 1 (s1, s2)`로 후보를 둘
이상 두고, Patroni `synchronous_mode`에 목록 관리를 맡기고, 후보가 하나도
없을 때 쓰기를 멈출지(strict) 비동기로 내릴지를 미리 정해 뒀습니다"**다.

덧붙일 둘 — ① `synchronous_commit`은 이분법이 아니라 단계이고(`remote_write` /
`on` / `remote_apply`) **트랜잭션 단위로 바꿀 수 있으므로**, 결제만 `on`,
로그성 쓰기는 `local` 같은 혼용이 정석이다. ② **커밋 대기를 취소해도 로컬
커밋은 남는다** — 동기 복제도 §2-6을 없애지 못하므로 멱등키와 대조는 그대로
필요하다.

마지막에 선택지를 셋으로 정리한다 — 쓰기 지연으로 내거나(동기 복제), 스토리지
구조로 내거나(Aurora 같은 공유 스토리지), 애플리케이션 대조로 내거나(멱등키 +
보정). "RPO 0이 정말 요구사항인가"를 비즈니스에 되묻는 것까지가 답이다.

### "failover 훈련은 어떻게 하나요?"

**강제 전환 명령과, 그 전후로 재는 숫자 셋(§3-12).** 핵심은 **시나리오를 셋으로
나누는 것**이다 — 계획된 전환(`patronictl switchover` / `aws rds
failover-db-cluster`), 리더 상실(`patronictl failover`), 그리고 **`iptables`로
5432를 DROP하거나 인스턴스를 강제 정지해 "말없이 사라지게" 하는 것.** 앞의 둘만
돌리면 §1-2 (a)만 재현되고, 정작 무서운 (b) 반개방과 (c) 스탠바이 좀비는 한
번도 검증되지 않는다. 재는 숫자는 앱 RTO(합성 쓰기 기준), 5xx 건수·지속 시간,
재시작 파드 수(0이 목표)와 `25006`·`53300` 카운터다. 훈련이 잡아내는 전형적
결함: `-D`로 넘겨서 무시된 DNS TTL, 밀리초로 적어 2.8시간이 된 `socketTimeout`,
배치 풀에 온라인용 타임아웃, liveness에 남아 있던 DB 체크, 저하 모드를 뚫고
나가는 "읽기처럼 보이는 쓰기", 세션 advisory lock에 기대던 배치.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **좀비 커넥션이 생기는 경로** — MySQL은 `SET GLOBAL
read_only = ON`으로 **재시작 없이 제자리 강등**이 되므로 기존 커넥션이 살아남은
채 좀비가 되지만, PostgreSQL은 프라이머리를 스탠바이로 되돌리려면 재시작이
필요해 대부분 커넥션이 끊긴다 — PG의 (c)는 "기존 커넥션이 변한 것"이 아니라
**"새 커넥션이 엉뚱한 호스트로 간 것"**이다. 그래서 처방도 접속 시점 검증
(`targetServerType=primary`, `pg_is_in_recovery()`) 쪽으로 무게가 옮겨간다.
② **에러 분류 축** — MySQL은 벤더 숫자 코드(1290/1836)로 가르지만 pgjdbc는
`getErrorCode()`가 **항상 0**이라 SQLState(`25006`, `57P01`, `53300`)로만
가른다. 이 한 줄을 모르고 코드를 옮기면 모든 분기가 조용히 실패한다.
③ **동기 복제의 실패 모드** — MySQL 반동기는 타임아웃 후 **비동기로 자동
강등**하지만, PostgreSQL은 동기 후보가 없으면 **커밋이 무한 대기**한다. "동기
복제를 켠다"는 결정의 무게가 다르다. ④ **커넥션 모델** — MySQL은 스레드라
재연결 폭풍을 그럭저럭 버티지만, PG는 커넥션 하나가 프로세스 하나라 폭풍이 곧
`53300`과 CPU 압박이다 → **PgBouncer/RDS Proxy 앞단이 선택이 아니라 기본기**가
된다. ⑤ **드라이버가 주는 무기** — MySQL 쪽은 multi-host URL의
`failOverReadOnly`(기본 true, "읽기라도 계속")와 권장되지 않는 `autoReconnect`,
그리고 MHA·Orchestrator·ProxySQL 같은 외부 도구가 축이지만, PostgreSQL은
pgjdbc에 `targetServerType`이 내장돼 있어 **"쓰기 가능한 호스트만 고른다"를
URL 한 줄로 선언**할 수 있다. 대신 그 판정이 접속 시점에만 일어난다는 한계도
같이 말해야 한다. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "차이를 구조에서
이해했다"로 들린다.

---

## 한 줄 요약

failover는 **다운 감지(리더 키 TTL·헬스체크) → 스탠바이 승격(`pg_promote()`,
타임라인 분기 — 안 넘어간 WAL은 새 역사에 없다 = RPO) → 엔드포인트 전환 →
JVM DNS 캐시**까지가 인프라의 일이고, 그 뒤 앱의 풀에 남은 **반개방 소켓**
(pgjdbc `socketTimeout` 기본 0 = 무한, 단위는 초 → 무한 대기 → 풀 고갈 →
스레드 고갈)과 **승격 안 된 스탠바이에 붙은 좀비 커넥션**(`isValid()` 통과,
SQLState `25006`은 HikariCP가 evict 안 함, `maxLifetime` 30분까지 생존, 뒤로는
`25P02`가 원인을 덮는다), 그리고 **조용히 사라진 세션 상태**(`SET`·advisory
lock·`LISTEN`·준비문)가 "인프라는 복구됐는데 앱은 계속 장애"를 만든다 —
대비는 pgjdbc 다중 호스트 + `targetServerType=primary`·`socketTimeout`/
`statement_timeout`·HikariCP `connectionTimeout`/`maxLifetime`/`keepaliveTime`·
JVM `networkaddress.cache.ttl`·`SQLExceptionOverride`로 `25006` evict·멱등키
(`ON CONFLICT`) 조건부 재시도·서킷 브레이커·readiness 전용 DB 체크·커넥션이
곧 프로세스인 PG를 위한 PgBouncer 앞단·정기 failover 훈련(정상 종료가 아니라
패킷 DROP으로)으로 **코드에 고정**하되, 짧은 타임아웃은 오탐(특히 승격 직후
콜드 캐시)을, 자동 재시도는 커밋 불명 쓰기의 중복을, 저하 모드는 쓰기 기능과
복잡도를, 동기 복제는 지연과 **자동 강등이 없는 무한 대기**를, 프록시는 세션
상태를 **대가로 치른다는 양면**까지 한 호흡에 말하는 것이 이 문항의 답이다.
