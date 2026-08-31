# DB failover 중 애플리케이션 동작 — 인프라는 40초 만에 복구됐는데 앱은 왜 30분 동안 장애인가

> 핵심 관전 포인트: **failover는 DB 쪽에서 끝나는 이벤트가 아니라
> 애플리케이션까지 이어지는 사슬이다. 다운 감지(헬스체크 간격 × 실패 임계)
> → 리플리카 승격(복제 지연분은 유실 가능 = RPO) → 엔드포인트 DNS 전환(TTL)
> → 앱 JVM의 DNS 캐시 만료, 여기까지가 "인프라 복구"다. 진짜 문제는 그 뒤에
> 있다 — 앱의 커넥션 풀은 여전히 죽은 프라이머리를 향한 소켓을 쥐고 있다.
> RST를 받은 커넥션은 다음 사용에서 에러가 나 풀이 알아서 갈아끼우지만,
> 조용히 죽은 반개방(half-open) 소켓은 `socketTimeout`이 없으면 `read()`에서
> 무한 대기하고, 구 프라이머리가 리플리카로 살아나면 쓰기마다 read-only
> 에러가 나는데 HikariCP는 그걸 끊을 사유로 보지 않는다. 커넥션이 하나씩
> 좀비가 되면 풀이 마르고 → 풀을 기다리는 톰캣 스레드가 마르고 → 헬스체크까지
> 죽는다. 이것이 "인프라는 복구됐는데 앱은 계속 장애"의 정체다. 대비는
> 설정과 코드로 고정한다: JDBC `socketTimeout`/`connectTimeout`, HikariCP
> `connectionTimeout`·`validationTimeout`·`maxLifetime`·`keepaliveTime`, JVM
> `networkaddress.cache.ttl`, read-only 에러를 evict 사유로 등록
> (`SQLExceptionOverride`), 멱등키가 있을 때만 쓰기를 재시도, 서킷 브레이커로
> 빠른 실패, readiness에만 DB 체크, 그리고 정기 failover 훈련. 그리고 모든
> 안전망에는 대가가 있다 — 짧은 타임아웃은 긴 정상 쿼리를 죽이고(오탐·플래핑),
> 자동 재시도는 커밋 여부가 불명한 쓰기를 중복시키며, 읽기 전용 저하 모드는
> 쓰기 기능과 코드 복잡도를 맞바꾸고, 동기 복제(RPO 0)는 쓰기 지연과 가용성
> 결합을 치른다.**

---

## 0. 질문 + 의도

**질문**: "DB 장애로 failover가 일어나는 동안 애플리케이션은 어떻게 동작해야
하나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**인프라가 복구를 해줘도
애플리케이션이 커넥션을 못 갈아타면 장애는 계속된다. '내 코드 밖에서 벌어지는
일'까지 책임 범위로 보는 시야를 확인한다.**"

두 문장이 각각 채점 지점이다.

- **"커넥션을 못 갈아타면"** — DB 팀은 "failover 완료, 40초 걸렸습니다"라고
  보고하는데 앱은 30분째 5xx를 뱉는 상황이 실제로 흔하다. 이 간극이 **어디서,
  왜** 생기는지를 TCP 소켓·DNS 캐시·커넥션 풀·스레드 풀의 사슬로 설명할 수
  있는지 본다.
- **"내 코드 밖에서 벌어지는 일까지 책임 범위로"** — 헬스체크 간격, DNS TTL,
  커널의 TCP 동작, 드라이버 기본값은 전부 "내가 짠 코드"가 아니다. 그런데
  그것들의 기본값이 내 서비스의 복구 시간을 결정한다. "인프라 문제라 우리
  소관이 아니다"가 성립하지 않는 영역임을 아는지, 그래서 **설정과 코드로
  안전망을 고정해 뒀는지**를 본다.

> 이 문서는 사전 학습용이다(면접 전 선행 학습). 이 후보자의 횡단 약점 네 가지를
> 이 문항 안에서 정면으로 겨냥한다.
>
> - **약점 ① 메커니즘 사슬** — §1이 전부 사슬이다. "DB가 죽으면 앱도 에러
>   난다"가 아니라 *다운 → 감지 → 승격 → DNS → JVM 캐시 → 죽은 소켓 → 무한 대기
>   → 풀 고갈 → 스레드 고갈 → 헬스체크 실패*를 한 호흡으로 말하는 연습.
> - **약점 ② 트레이드오프 양면** — 고난이도는 트레이드오프 서술이 곧 평가
>   대상이다. §4는 안전망 하나하나의 대가만 모아놓은 절이다.
> - **약점 ③ 안전망을 코드로 고정** — §3의 11항은 전부 yml·URL·자바 코드다.
>   "타임아웃을 잘 잡아야 한다"가 아니라 "`socketTimeout=10000`, 단위는
>   밀리초"까지 말한다.
> - **약점 ④ 목록 인출** — §2 "증상 8종", §3 "체크리스트 11항"을 번호 붙은
>   목록으로 외운다.
>
> 이웃 문서와의 경계: 풀 고갈의 **진단 방법론**은
> [`../02-spring/hikaricp-connection-pool-exhaustion.md`](../02-spring/hikaricp-connection-pool-exhaustion.md),
> LB 제외가 **비동기로 전파되는 이유**(헬스체크 주기·목록 전파·프록시 갱신)는
> [`../02-spring/graceful-shutdown-zero-downtime-deploy.md`](../02-spring/graceful-shutdown-zero-downtime-deploy.md) §3,
> 복제 지연과 **리플리카 제외가 마스터로 부하를 옮기는 문제**는
> [`../03-jpa-orm/read-replica-routing-and-lag.md`](../03-jpa-orm/read-replica-routing-and-lag.md) §4·§7,
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
           (인스턴스 장애·커널 패닉·네트워크 단절, 또는 계획된 failover)
   │
   ▼  ① 감지        헬스체크 간격 × 실패 임계 횟수만큼 걸린다
   │               (1회 실패로 판정하면 GC 멈춤·순간 지연도 failover를 유발 → 일부러 몇 번 확인한다)
   ▼  ② 승격        리플리카가 받아둔 로그를 끝까지 적용 → 쓰기 가능 상태로 전환
   │               (비동기 복제라면 "프라이머리에는 커밋됐지만 아직 안 넘어온 트랜잭션"은 사라진다 = RPO)
   ▼  ③ 전환        엔드포인트(DNS CNAME)가 새 프라이머리 IP를 가리키도록 갱신
   │               (TTL이 만료될 때까지 리졸버는 구 IP를 계속 돌려준다)
   ▼  ④ JVM 캐시    앱 프로세스 안의 InetAddress 캐시가 만료돼야 새 IP로 풀린다
   │               (networkaddress.cache.ttl — DNS TTL과 별개의 두 번째 캐시)
   ═══════════════ 여기까지가 "인프라 복구 완료" ═══════════════
   │
   ▼  ⑤ 앱          기존 풀 커넥션은 여전히 구 IP를 향한 소켓을 들고 있다  → §1-2
```

각 단계에서 **시간이 어디에 쓰이는지**, 그리고 **무엇을 잃을 수 있는지**를
말할 수 있어야 한다.

**① 감지 — 왜 즉시가 아닌가.** 감시자는 통보를 받는 게 아니라 주기적으로
찔러보고 판단한다. 한 번 응답이 없다고 바로 죽었다고 판정하면 긴 GC 멈춤,
순간적인 네트워크 지연, 디스크 I/O 스파이크가 전부 failover를 유발한다. 그래서
"N초 간격으로 M번 연속 실패"를 기다린다. 이 대기가 곧 복구 시간(RTO)의 첫
조각이고, 짧게 잡을수록 오탐이 늘어난다(§4-1).

**② 승격 — 무엇을 잃는가.** 비동기 복제에서는 프라이머리가 커밋을 클라이언트에
응답한 뒤에 로그를 리플리카로 보낸다. 다운 직전 몇 초간의 커밋은 클라이언트는
"성공"을 받았지만 리플리카에는 아직 없다. 리플리카가 승격되면 그 트랜잭션들은
**새 프라이머리의 역사에서 사라진다.** 이것이 RPO(복구 시점 목표)가 0이 아닌
이유다. 승격 컨트롤러가 "가장 최신 리플리카를 고르는 것"이나 "따라잡을 때까지
기다리는 것"은 **RTO를 늘려 RPO를 줄이는 선택**이다. 구 프라이머리가 나중에
살아나면 그쪽에만 있는 트랜잭션 때문에 두 역사가 갈라지므로, 관리형 서비스는
구 프라이머리를 **리플리카로 재구성**해 새 프라이머리에 붙인다 — 이 사실이
§1-2의 세 번째 부류(살아 있는데 read-only인 커넥션)를 만든다. 공유 스토리지
구조(Aurora 계열)는 이 항목이 다르게 동작하지만, "승격 순간까지 클라이언트가
성공을 받은 것이 전부 남는가"라는 질문은 어느 구조에서든 확인해야 한다.

**③ 전환 — 왜 DNS인가, 왜 지연되는가.** 관리형 DB는 대개 "클러스터
엔드포인트"라는 DNS 이름을 주고, failover 시 그 CNAME이 가리키는 IP를 바꾼다.
DNS는 밀어내기(push)가 아니라 캐시 만료(pull) 모델이라, TTL이 끝날 때까지
모든 리졸버가 구 IP를 돌려준다. 그래서 관리형 DB는 엔드포인트 TTL을 수 초로
짧게 잡아둔다. VIP를 옮기거나 프록시(RDS Proxy·ProxySQL·PgBouncer·HAProxy)를
앞에 두는 구성은 이 단계를 앱에서 숨긴다 — 대신 프록시가 새 병목·새 장애점이
된다(§4-5).

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
   ┌────────────────────┬───────────────────────┬─────────────────────────┐
   │ (a) RST를 받은 것   │ (b) 반개방(half-open)  │ (c) 살아 있는데 read-only │
   │  구 인스턴스가       │  상대가 소리 없이 사라짐 │  구 프라이머리가 리플리카로 │
   │  소켓을 닫아줌       │  (전원 차단·네트워크 단절)│  살아났고 그쪽에 붙어 있음  │
   ├────────────────────┼───────────────────────┼─────────────────────────┤
   │ 다음 사용 시 즉시    │ read()에서 응답을       │ SELECT는 멀쩡히 된다      │
   │ SQLState 08xxx 에러 │ 기다림. socketTimeout이 │ INSERT/UPDATE만 에러      │
   │ → HikariCP가 evict  │ 없으면 영원히          │ (MySQL 1290, PG 25006)   │
   │ → 새 커넥션 생성    │ → 스레드 1개 소멸       │ → HikariCP는 evict 안 함  │
   │ → (DNS가 갱신됐다면)│ → 풀에서 반환도 안 됨   │ → 풀로 멀쩡히 반환됨      │
   │   새 프라이머리로    │                        │ → 다음 요청이 또 잡는다    │
   │ ✅ 자가 치유         │ ❌ 조용한 누수          │ ❌ 좀비                  │
   └────────────────────┴───────────────────────┴─────────────────────────┘
```

**(a)는 좋은 죽음이다.** 상대가 FIN/RST를 보내줬으므로 커널이 소켓을 에러
상태로 만들고, 드라이버는 다음 I/O에서 `Communications link failure`(MySQL,
SQLState 08S01) 같은 예외를 던진다. HikariCP는 **SQLState가 "08"로 시작하는
예외(연결 계열 오류)를 받으면 그 커넥션을 풀에서 버린다.** 그래서 이 부류는
설정을 안 건드려도 스스로 낫는다. 많은 사람이 "failover 테스트 해봤는데 잠깐
에러 나고 곧 정상이었다"고 기억하는 건 테스트 방식(정상 종료·재시작)이 (a)만
만들었기 때문이다.

**(b)는 나쁜 죽음이다.** 상대 호스트가 전원이 나가거나, 네트워크가 끊기거나,
보안 그룹이 바뀌면 **아무 패킷도 오지 않는다.** 커널 입장에서 소켓은 여전히
ESTABLISHED다. 이 커넥션으로 쿼리를 보낸 스레드는 응답을 기다리는 `read()`에
들어가고, 상한이 없으면 나오지 않는다(§1-3). 그 스레드는 커넥션을 반환하지
못하므로 풀에서 `active` 하나가 영구히 잠식된다. 요청이 올 때마다 이런
커넥션이 하나씩 걸리면 **풀은 20개가 다 `active`인데 DB는 한가한** 상태가
된다 — 고갈 진단 문서의 "누수" 시그니처와 겉모습이 같다.

**(c)는 가장 교활하다.** 구 프라이머리가 리플리카로 재구성돼 같은 IP로 살아
있거나, JVM DNS 캐시 때문에 failover 직후 새로 만든 커넥션이 구 IP(이제
리플리카)에 붙은 경우다. **`isValid()`는 통과한다 — 살아 있으니까.** SELECT도
된다. 쓰기만 `The MySQL server is running with the --read-only option`(1290) 또는
`cannot execute INSERT in a read-only transaction`(PostgreSQL 25006)으로
실패한다. 이 에러의 SQLState는 "08"이 아니므로 HikariCP는 커넥션을 멀쩡한
것으로 보고 풀에 돌려놓고, 다음 요청이 또 잡는다. 이 커넥션은 **`maxLifetime`
(기본 30분)이 다 될 때까지 산다.** "failover는 40초, 앱 장애는 30분"의 30분이
정확히 이 숫자다(§5).

세 부류가 만드는 뒷사슬은 하나로 합쳐진다:

```text
(b)로 스레드가 하나씩 갇힘 + (c)로 쓰기가 계속 실패
   → 풀 active = max, pending 누적
   → 새 요청은 connectionTimeout(기본 30초) 동안 풀 앞에서 대기 — 그동안 톰캣 스레드를 쥔 채
   → 톰캣 스레드 풀 고갈 → DB와 무관한 API·헬스체크 엔드포인트까지 응답 불능
   → LB가 인스턴스를 제외 / (liveness에 DB 체크를 넣었다면) 파드 재시작
   → 재시작된 파드들이 동시에 풀을 채우며 새 프라이머리로 몰려감(connection storm)
   → 새 프라이머리의 max_connections·CPU를 압박 → 복구가 더 늦어짐
```

**"DB가 죽어서 앱이 죽었다"가 아니다. DB는 40초 만에 살아났고, 앱은 자기가
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
- **TCP keepalive** — 유휴 소켓에 주기적으로 탐침을 보낸다. 리눅스 기본은
  **2시간**(`tcp_keepalive_time=7200`) 유휴 후 시작이다. 드라이버 옵션으로
  켜도 커널 값을 안 줄이면 2시간이다.
- **애플리케이션 타임아웃** — `socketTimeout`. 드라이버가 `read()`에
  `SO_TIMEOUT`을 걸어 그 시간 안에 응답이 없으면 예외를 던진다. **이것만이 앱이
  직접 쥔 시계다.** MySQL Connector/J와 pgjdbc 모두 기본값이 0 = 무한이다.

스레드 덤프에서 이 부류는 소켓 읽기 프레임(구형 JDK는
`SocketInputStream.socketRead0`, 신형은 `NioSocketImpl.park` 계열)에서 멈춰
있고, 상태는 RUNNABLE로 보이는 경우가 많아 "일하고 있는 것처럼" 읽힌다. 그
위 프레임에 드라이버의 결과 읽기(`readPacket`, `receiveResponse` 류)와
`HikariProxyPreparedStatement.executeQuery`가 있으면 확정이다.

한 가지 더 — **`@Transactional(timeout = n)`이나 `Statement.setQueryTimeout`은
이 상황의 대체재가 아니다.** 쿼리 타임아웃은 대개 별도 스레드가 **서버에 취소
요청을 보내는** 방식으로 구현된다. 서버가 죽었으면 취소 요청도 갈 곳이 없다.
반개방 소켓에서 스레드를 꺼내주는 건 `socketTimeout`뿐이다.

### 1-4. 왜 DNS가 두 겹인가

```text
앱 코드: new Socket("shop-cluster.cluster-xxxx.rds.amazonaws.com", 3306)
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

## 2. failover 중 앱이 겪는 증상 8종

> 약점 ④(목록 인출) 겨냥. 번호와 한 줄 원인을 세트로 외운다. 면접에서
> "어떤 증상이 나타나나요"는 이 목록을 순서대로 읊는 자리다.

1. **`Communications link failure` / `Connection reset` / `Broken pipe`** —
   §1-2 (a). 닫힌 소켓을 쓴 순간 난다. 일시적이고 스스로 낫는다. 이것만
   보이면 운이 좋은 failover다.
2. **응답 없이 멈춤(hang)** — §1-2 (b). 에러도 없고 로그도 없다. 스레드 덤프에
   소켓 읽기에서 멈춘 스레드가 쌓인다. `socketTimeout`이 없다는 증거.
3. **`Connection is not available, request timed out after 30000ms`** —
   풀 고갈. 2번의 결과다. 이 스레드들은 피해자이고 용의자는 2번 스레드들이다.
4. **DB와 무관한 API·헬스체크까지 5xx** — 3번의 30초 대기가 톰캣 스레드를
   다 먹었다. 이 시점부터 "DB 장애"가 "서비스 전면 장애"로 승격된다.
5. **읽기는 되는데 쓰기만 간헐적으로 실패** — §1-2 (c). `--read-only
   option`(MySQL 1290) / `read-only transaction`(PG 25006). "간헐적"인 이유는
   풀의 일부 커넥션만 구 프라이머리에 붙어 있어서, 그 커넥션을 잡은 요청만
   실패하기 때문이다. 인프라는 이미 복구 완료라고 말하는 시점에 나타나서
   진단을 가장 혼란스럽게 만든다.
6. **커밋 여부 불명** — 클라이언트는 COMMIT을 보내고 타임아웃/에러를 받았는데
   서버는 커밋을 끝냈을 수 있다. 재시도하면 중복, 안 하면 유실. 드라이버가
   이를 구분해 알려주는 경우 SQLState 08007("트랜잭션 결과 불명")로 온다.
7. **승격 직전 커밋의 유실** — §1-1 ②. 사용자는 "주문 완료" 화면을 봤는데
   새 프라이머리에 그 주문이 없다. "결제됐는데 주문이 없다" 유형 사고의
   인프라 쪽 원인 중 하나. 앱 로그에는 성공으로 남아 있어 사후 대조로만 발견된다.
8. **재연결 폭풍과 기동 실패** — 파드들이 동시에 재시작/풀 재생성하며 새
   프라이머리로 몰린다(`Too many connections`). HikariCP는 기본적으로 기동 시
   첫 커넥션을 못 만들면 애플리케이션 기동 자체를 실패시키므로
   (`initializationFailTimeout` 기본 양수), failover가 끝나기 전에 재시작된
   파드는 뜨지도 못한 채 CrashLoop에 들어갈 수 있다.

1·3·4는 "죽는 동안"의 증상이고, **5·6·7은 "복구된 뒤"의 증상**이다. 인프라
팀과 앱 팀이 서로 "우리 쪽은 정상"이라고 말하는 순간은 늘 후자 때문에 온다.

## 3. 앱 측 대비 체크리스트 11항 — 설정과 코드로 고정한다

> 약점 ③(안전망을 코드로 고정) 겨냥. 항목마다 "어디에 무엇을 적는가"까지
> 내려간다. "타임아웃을 잘 잡는다"는 답이 아니다.

| # | 항목 | 어디에 | 막는 증상 |
|---|---|---|---|
| 1 | JDBC 소켓 타임아웃 | JDBC URL / `data-source-properties` | 2 (반개방 무한 대기) |
| 2 | HikariCP 4개 설정 | `spring.datasource.hikari.*` | 3, 4, 5의 수명 |
| 3 | JVM DNS 캐시 TTL | `Security.setProperty` / `java.security` | 5 (구 IP로 새 커넥션) |
| 4 | 드라이버의 failover 인지 | multi-host URL / AWS JDBC Wrapper | 전환 대기 시간 단축 |
| 5 | read-only 에러 → evict | `SQLExceptionOverride` | 5 (좀비 커넥션) |
| 6 | 멱등 조건부 재시도 | 재시도 정책 코드 + 멱등키 UNIQUE | 6 (중복/유실) |
| 7 | 서킷 브레이커 | Resilience4j 설정 | 4 (스레드 풀 전이) |
| 8 | 헬스체크 배치 | readiness에만 DB | 8 (재시작 폭풍) |
| 9 | 저하 모드 정의 | 기능 플래그 + 쓰기 차단 응답 | 4를 "부분 장애"로 축소 |
| 10 | 관측·알람 | 풀 메트릭, SQLState별 카운터 | 5를 사람이 30분 뒤가 아니라 30초 뒤에 알게 |
| 11 | failover 훈련 | 정기 절차 + 측정 | 1~10이 실제로 작동하는지 검증 |

### 3-1. JDBC 타임아웃 — 드라이버 기본값은 "무한"이다

```yaml
# ❌ before — 타임아웃이 하나도 없다.
#    MySQL Connector/J: connectTimeout=0, socketTimeout=0 → 둘 다 무한 대기
spring:
  datasource:
    url: jdbc:mysql://shop-cluster.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:3306/shop
```

```yaml
# ✅ after — 연결 수립과 응답 대기에 각각 상한을 건다 (MySQL: 밀리초)
spring:
  datasource:
    url: jdbc:mysql://shop-cluster.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:3306/shop?connectTimeout=3000&socketTimeout=10000
    #   connectTimeout=3000  — TCP 연결 수립 3초. 죽은 IP로 SYN을 보내고 무한정 기다리지 않는다
    #   socketTimeout=10000  — 쿼리 하나의 응답 대기 10초. 반개방 소켓에서 스레드를 꺼내주는 유일한 시계 (§1-3)
```

```yaml
# ✅ PostgreSQL(pgjdbc)은 단위가 "초"다 — MySQL 값을 그대로 옮기면 10000초(약 2.8시간)가 된다
spring:
  datasource:
    url: jdbc:postgresql://shop.internal:5432/shop?connectTimeout=3&socketTimeout=10&tcpKeepAlive=true
```

- `socketTimeout`은 **이 DataSource로 나가는 가장 긴 정상 쿼리보다 길어야**
  한다. 10초로 잡았는데 월말 정산 쿼리가 40초라면 매달 말 배치가 죽는다.
  그래서 배치·통계용 DataSource는 분리해 다른 타임아웃을 준다(§4-1).
- URL 대신 `spring.datasource.hikari.data-source-properties.socketTimeout: 10000`
  으로 드라이버 속성을 넘겨도 같다. 어느 쪽이든 **코드 리뷰에서 보이는 곳**에
  둔다.

### 3-2. HikariCP — 기본값 넷을 바꾼다

```yaml
# ❌ before — 풀 크기만 정하고 나머지는 기본값. 각 기본값이 failover에서 무슨 뜻인지 주석으로 적어보면:
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      # connection-timeout: 30000   → 풀이 비면 30초 대기. 그동안 톰캣 스레드를 쥔다 (증상 3→4 전이)
      # validation-timeout: 5000    → 대여 전 isValid() 검사에 최대 5초
      # max-lifetime: 1800000       → 30분. 잘못 붙은 커넥션(§1-2 c)의 최대 수명 = "앱 장애 30분"의 30분
      # keepalive-time: 0           → 꺼짐. 유휴 커넥션이 반개방이 돼도 다음 대여 때까지 모른다
```

```yaml
# ✅ after
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      connection-timeout: 3000          # 풀 대기 3초. 못 받으면 빨리 실패 → 톰캣 스레드를 돌려준다
      validation-timeout: 1000          # 대여 직전 isValid() 상한. connection-timeout보다 반드시 짧게
      max-lifetime: 300000              # 5분. 어떤 이유로든 잘못 붙은 커넥션은 5분 안에 자연 교체된다. DB의 wait_timeout보다는 짧게
      keepalive-time: 60000             # 1분마다 유휴 커넥션에 ping → 반개방을 사용 전에 발견해 조용히 교체
      exception-override-class-name: com.example.infra.db.ReadOnlyPrimaryEvictor   # §3-5
      # initialization-fail-timeout: -1 # (선택) 기동 시 DB에 못 붙어도 앱은 뜬다. failover 중 재시작돼도 CrashLoop로 안 감.
                                        #        대신 readiness가 트래픽을 막아줘야 한다 (§3-8)
```

넷의 역할 분담을 한 문장으로 — **`keepaliveTime`은 유휴 중 순찰,
`validationTimeout`은 유휴에서 대여로 넘어가는 관문, `socketTimeout`(§3-1)은
사용 중의 상한, `maxLifetime`은 모든 것이 실패했을 때의 최종 교체 주기**다.

- HikariCP는 커넥션이 일정 시간(짧은 우회 창) 이상 놀다가 대여될 때만
  `isValid()`로 검사한다. 즉 검사는 **사용 중에 죽은 커넥션**을 못 잡고
  (그건 `socketTimeout`의 몫), **살아 있지만 read-only인 커넥션**도 못 잡는다
  (`isValid()`는 "응답하나"만 본다). 그래서 §3-5가 따로 필요하다.
- `maxLifetime`을 줄이면 재연결 비용(TLS 핸드셰이크 포함)이 늘고, HikariCP가
  만료 시각에 작은 무작위 편차를 주긴 하지만 그래도 주기적 재연결 파도가
  생긴다(§4-6). 5분은 "장애 시 자연 치유 상한"과 "평시 재연결 비용" 사이의
  타협값이지 정답이 아니다.

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
- 이걸 해도 §1-2의 기존 커넥션 문제는 남는다. DNS TTL은 "새 커넥션이 어디로
  가나"만 정한다.

### 3-4. 드라이버가 failover를 아는가 — DNS를 기다리지 않는 길

DNS 전환을 기다리는 대신 드라이버가 후보 호스트를 직접 확인하게 하면 ③④
단계를 건너뛸 수 있다.

```text
# PostgreSQL — 후보 호스트를 나열하고 "쓰기 가능한 쪽"에만 붙으라고 지시
jdbc:postgresql://db-a.internal:5432,db-b.internal:5432/shop
    ?targetServerType=primary        # 접속 후 읽기 전용 여부를 확인해 프라이머리만 선택
    &hostRecheckSeconds=5            # 호스트 상태 캐시 5초 → failover 후 5초면 새 프라이머리를 찾는다
    &connectTimeout=3&socketTimeout=10
```

```text
# MySQL Connector/J — multi-host failover URL
jdbc:mysql://db-a.internal:3306,db-b.internal:3306/shop
    ?failOverReadOnly=true           # 기본값 true: 두 번째 호스트로 넘어간 커넥션은 읽기 전용이 된다
    &connectTimeout=3000&socketTimeout=10000
```

`failOverReadOnly`의 기본이 `true`인 이유를 말할 수 있으면 좋다 — 이 기능은
원래 "프라이머리가 죽으면 리플리카에서 **읽기라도** 계속하라"는 용도다. 두 번째
호스트가 실제로 승격된 프라이머리라면 `false`로 바꿔야 쓰기가 되지만, 그러면
네트워크 분단으로 프라이머리가 살아 있는데 리플리카로 넘어간 경우 **리플리카에
쓰기를 시도**하게 된다(리플리카가 `read_only`면 1290으로 막히긴 한다). 즉
"자동으로 다른 호스트에 쓴다"는 편의는 "엉뚱한 곳에 쓸 위험"과 맞바꾼다.
`autoReconnect=true`는 MySQL 문서가 권장하지 않는 옵션이다 — 트랜잭션 상태를
모른 채 재접속해 §2-6의 불명 상태를 조용히 삼킨다.

**AWS Advanced JDBC Wrapper(가산점 포인트)** — Aurora처럼 클러스터가 자기
토폴로지(누가 writer인가)를 SQL로 노출하는 경우, 래퍼 드라이버가 그 정보를
직접 조회해 **DNS 갱신을 기다리지 않고** 새 writer에 붙는다.

```text
jdbc:aws-wrapper:postgresql://shop-cluster.cluster-xxxx.ap-northeast-2.rds.amazonaws.com:5432/shop?wrapperPlugins=failover
```

중요한 건 이 래퍼가 **재시도를 대신 해주지 않는다**는 점이다. failover가
성공하면 SQLState **08S02**(연결이 바뀌었다 — 세션 상태를 다시 세팅하고 트랜잭션을
재실행하라), 트랜잭션 도중이었다면 **08007**(커밋됐는지 알 수 없다)을 던진다.
즉 드라이버는 "여기까지 해줬으니 이제 네가 판단하라"고 예외로 알려줄 뿐이고,
그 판단이 §3-6이다. 어떤 도구를 써도 **"커밋됐는지 모르는 상태"는 드라이버가
없애줄 수 없다** — 그건 프로토콜 수준의 한계다.

### 3-5. read-only 프라이머리 감지 → 풀에서 쫓아낸다

```java
// ❌ before — 아무 것도 안 함.
//    HikariCP 기본 판정: 예외의 SQLState가 "08"로 시작(통신 실패)하면 evict, 그 외는 유지.
//    MySQL 1290(HY000)·PG 25006은 "그 외"다 → 커넥션은 멀쩡히 풀로 돌아가 다음 요청을 또 실패시킨다.
```

```java
// ✅ after — "살아 있지만 쓰기가 안 되는" 커넥션을 evict 사유로 등록
package com.example.infra.db;

import com.zaxxer.hikari.SQLExceptionOverride;
import java.sql.SQLException;

public class ReadOnlyPrimaryEvictor implements SQLExceptionOverride {

    // (주의) 이 인터페이스의 중첩 enum 이름이 Override라 @Override 애노테이션과 이름이 겹친다.
    //        애노테이션을 생략하거나 @java.lang.Override로 쓴다.
    public Override adjudicate(SQLException e) {
        int code = e.getErrorCode();
        String state = e.getSQLState() == null ? "" : e.getSQLState();

        if (code == 1290 || code == 1836) {          // MySQL: --read-only 옵션 / read-only 모드
            return Override.MUST_EVICT;
        }
        if ("25006".equals(state)) {                 // PostgreSQL: read_only_sql_transaction
            return Override.MUST_EVICT;
        }
        return Override.CONTINUE_EVICT;              // 나머지는 HikariCP 기본 판정("08" 접두)에 맡긴다
    }
}
```

등록은 §3-2의 `exception-override-class-name`이다. 이 인터페이스는 비교적
최근 HikariCP에 들어온 것이니 사용 중인 버전에 있는지 확인한다. 없거나
더 거칠어도 되면 두 번째 방법:

```java
// 대안 — read-only 에러를 감지한 지점에서 풀 전체를 소프트 리셋
// 유휴 커넥션은 즉시 폐기, 사용 중인 것은 반환되는 순간 폐기. 새 커넥션은 (DNS가 갱신됐다면) 새 프라이머리로 붙는다.
hikariDataSource.getHikariPoolMXBean().softEvictConnections();

// 또는 문제의 커넥션 하나만
hikariDataSource.evictConnection(connection);
```

정밀도와 부작용의 차이 — `SQLExceptionOverride`는 **그 커넥션만** 버리고,
`softEvictConnections()`는 **20개를 한 번에** 버려 재연결 파도를 만든다. 대신
후자는 "구 프라이머리에 붙은 커넥션이 몇 개인지 모른다"는 불확실성을 한 방에
없앤다. failover 직후 한 번이라면 후자가 오히려 깔끔한 경우가 많다.

이 항목이 왜 결정적인지를 한 줄로 — **§3-1~3-4는 전부 "죽은 커넥션"을 다루고,
이것만이 "살아 있지만 틀린 커넥션"을 다룬다.** 앞의 넷을 완벽히 해도 이게
없으면 §5의 30분은 그대로 온다(maxLifetime을 5분으로 줄였다면 5분).

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
// 그리고 20개 파드 × 3회 재시도가 동시에 새 프라이머리를 두드린다 (retry storm)
```

```java
// ✅ after ① — 쓰기에 멱등키를 심는다. 이것이 없으면 뒤의 어떤 재시도 정책도 안전하지 않다.
@Transactional
public Order placeOrder(PlaceOrderCommand cmd) {
    // orders.idempotency_key UNIQUE — 클라이언트가 요청마다 만든 키
    return orderRepository.save(Order.from(cmd, cmd.idempotencyKey()));
}
```

```java
// ✅ after ② — 예외를 분류해 "재시도 / 대조 / 실패"를 가른다
public enum RetryDecision { RETRY, RECONCILE, FAIL }

public final class DbRetryPolicy {

    /** @param idempotent 이 작업을 두 번 실행해도 결과가 같은가 (읽기, 또는 멱등키가 있는 쓰기) */
    public static RetryDecision classify(Throwable t, boolean idempotent) {
        SQLException sql = unwrapSqlException(t);
        if (sql == null) return RetryDecision.FAIL;

        String state = sql.getSQLState() == null ? "" : sql.getSQLState();

        // 커밋 여부 불명 (표준 08007, AWS 래퍼의 TransactionStateUnknownSQLException 등)
        if ("08007".equals(state)) {
            return idempotent ? RetryDecision.RETRY : RetryDecision.RECONCILE;
        }
        // 연결 계열 실패(08xxx) / 소켓 타임아웃 — "요청이 서버에 닿았는지"부터 모른다
        if (state.startsWith("08") || sql instanceof java.sql.SQLTimeoutException) {
            return idempotent ? RetryDecision.RETRY : RetryDecision.RECONCILE;
        }
        // read-only 프라이머리 — 커넥션은 §3-5가 버린다. 요청은 다른 커넥션으로 재시도해도 된다 (실행 자체가 거부됐으므로 부분 적용 없음)
        if (sql.getErrorCode() == 1290 || sql.getErrorCode() == 1836 || "25006".equals(state)) {
            return RetryDecision.RETRY;
        }
        // 제약 위반·문법 오류·데드락 외 나머지 — 다시 해도 같은 결과
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

세 조각의 역할 — ①이 없으면 ②의 `idempotent=true`가 거짓말이 되고,
②가 없으면 ③은 before와 같다. 면접에서 "재시도 하겠다"고 말했으면 반드시
**"무엇이 멱등을 보장하는가"** 가 따라와야 한다. 멱등키를 UNIQUE 제약으로
고정하는 패턴은 [`../03-jpa-orm/unique-constraint-concurrent-insert.md`](../03-jpa-orm/unique-constraint-concurrent-insert.md)의
"DB가 마지막 심판"과 같은 뿌리다.

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
        waitDurationInOpenState: 10s         # 10초 뒤 HALF_OPEN으로 탐침
        permittedNumberOfCallsInHalfOpenState: 5
        recordExceptions:
          - org.springframework.dao.DataAccessResourceFailureException   # 연결 실패(08xxx 번역)
          - org.springframework.dao.QueryTimeoutException                # socketTimeout 번역
          - org.springframework.dao.TransientDataAccessResourceException
        ignoreExceptions:
          - org.springframework.dao.DataIntegrityViolationException      # 제약 위반은 DB 장애가 아니다
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
기능은 계속 응답한다. 새 프라이머리 쪽에서 봐도 좋다 — 재연결 폭풍 대신
HALF_OPEN의 탐침 5개만 온다. **서킷 브레이커는 "우리를 지키는 장치"이자
"복구 중인 DB를 지키는 장치"** 다.

주의 — 서킷 인스턴스는 **DataSource 단위**로 나눈다. writer 서킷이 열렸다고
리플리카 조회까지 막으면 살릴 수 있는 읽기를 죽인다.

### 3-8. 헬스체크 배치 — liveness에 DB를 넣지 않는다

failover 중 DB 체크가 liveness에 있으면 §2-8이 확정된다: 프로세스는 멀쩡한데
DB가 아프다고 재시작 → 뜨자마자 또 실패 → CrashLoop → 재시작할 때마다 새
프라이머리로 커넥션 폭풍. **readiness에만** 넣어 "트래픽만 빼고 프로세스는
살아서 재연결을 시도"하게 한다. 판단 기준과 설정은
[`../15-container-infra/liveness-readiness-probe-db-check.md`](../15-container-infra/liveness-readiness-probe-db-check.md)
§3·§5.

### 3-9. 저하 모드(degraded mode) — "전부 아니면 전무"를 피한다

failover 중 선택지가 "정상 아니면 5xx"뿐이면 §2-4는 피할 수 없다. 미리
정의해두는 것들:

- **쓰기 차단, 읽기 유지** — 기능 플래그 `writes.enabled=false`를 서킷 OPEN
  이벤트나 운영자가 켠다. 쓰기 엔드포인트는 503과 안내 문구, 조회는
  리플리카·캐시로 계속 서빙. 상품 목록은 보이고 주문 버튼만 잠기는 상태.
- **지연 가능한 쓰기는 큐로** — 조회수·로그·알림처럼 "나중에 반영돼도 되는"
  쓰기는 메시지 큐/아웃박스에 쌓았다가 복구 후 흘려보낸다. 주문·결제처럼
  즉시 확정이 필요한 쓰기는 이 방식이 안 된다 — 사용자에게 "완료"를 말할 수
  없기 때문이다.
- **캐시 응답에 시각 표시** — "3분 전 기준" 같은 표기와 함께 마지막 성공
  응답을 돌려준다.

무엇을 어느 모드로 내릴지는 장애 중에 정할 수 없다. 평시에 도메인별로
정해두고(§3-11 훈련에서 검증), 이 결정의 대가는 §4-3에서 다룬다.

### 3-10. 관측 — 30분 뒤가 아니라 30초 뒤에 알게

- **풀 메트릭** — `hikaricp.connections.pending`(대기 수), `.acquire`(대여
  대기 시간), `.timeout`(대여 실패 수), `.active`. failover 중 `active=max,
  pending↑, timeout↑`이 기본 파형이고, **DB가 복구됐다는데 `active`가 안
  내려오면** §1-2 (b)다.
- **에러 분류 카운터** — 예외를 SQLState 앞 두 자리(08=연결, 25=트랜잭션
  상태, 40=직렬화/데드락)와 벤더 코드(1290/1836)로 나눠 센다. **1290이
  failover 완료 알림 뒤에도 0이 안 되면** §1-2 (c)다 — 이 카운터 하나가 §5의
  30분을 30초로 만든다.
- **톰캣 스레드 사용률** — `tomcat.threads.busy`가 `max`에 붙으면 §2-4
  진입. 풀 메트릭보다 이게 먼저 알람이 되면 순서가 잘못된 것이다.
- **합성 쓰기 체크** — 1분마다 하트비트 테이블에 `UPDATE` 한 건. **읽기가 아니라
  쓰기**여야 (c)를 잡는다. 이 값이 "앱 기준 failover 완료 시각"이고, 인프라의
  완료 알림과 이 시각의 차이가 §3-11에서 측정하는 숫자다.

### 3-11. failover 훈련 — 설정은 실행해봐야 설정이다

위 열 항목은 전부 "failover가 났을 때만" 검증된다. 그래서 정기적으로 일부러
낸다.

```bash
# 스테이징(가능하면 트래픽이 낮은 시간대의 운영)에서 강제 failover
aws rds failover-db-cluster --db-cluster-identifier shop-cluster

# 같은 시각부터 측정하는 것
#  ① 인프라 완료 시각: 클러스터 이벤트의 failover 완료
#  ② 앱 완료 시각:     마지막 파드의 합성 쓰기(§3-10)가 다시 성공한 시각
#  ③ 그 사이 5xx 건수·최대 지속 시간, 재시작된 파드 수(0이어야 한다), 1290/25006 카운터가 0으로 돌아온 시각
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
| 짧은 타임아웃·헬스체크 | 빠른 감지, 짧은 RTO | 오탐(긴 정상 쿼리·GC 멈춤을 장애로), 플래핑 |
| 자동 재시도 | 순단 흡수, 사용자 무인지 | 비멱등 쓰기 중복, 재시도 폭풍 |
| 읽기 전용 저하 모드 | 부분 장애로 축소 | 쓰기 기능 상실, 모든 쓰기 경로의 모드 분기, 전환 판단 오탐 |
| 동기/반동기 복제 | RPO 0에 근접 | 쓰기 지연, 리플리카 장애가 마스터 쓰기를 멈춤 |
| 프록시(RDS Proxy 등) | 앱에 failover 투명 | 추가 홉 지연, 프록시 자체 병목·장애점, 세션 고정 |
| 짧은 maxLifetime·keepalive | 좀비 조기 회수 | 재연결 비용, 주기적 재연결 파도 |

### 4-1. 빠른 감지의 대가 — 오탐과 플래핑

`socketTimeout`을 3초로 잡으면 반개방 스레드는 3초 만에 풀려난다. 그런데
월말 정산 쿼리도 3초에 죽는다. 헬스체크를 1초 간격 1회 실패로 잡으면 다운을
1초 만에 알지만, 2초짜리 GC 멈춤이 failover를 유발하고 — failover 자체가
수십 초의 쓰기 불가를 만들므로 — **오탐 한 번이 진짜 장애 한 번과 비용이
같다.** 감지가 예민할수록 "죽었다 → 살았다 → 죽었다"를 반복하는 플래핑도
는다.

선을 긋는 법: **타임아웃은 워크로드별로 분리**한다. 온라인 트랜잭션용
DataSource는 `socketTimeout=10s`, 배치·통계용은 별도 DataSource에 `600s`.
같은 풀에서 둘을 섞으면 어느 한쪽을 반드시 희생한다. 헬스체크 임계는 "우리
서비스가 감수할 수 있는 최대 정상 멈춤(GC·I/O 스파이크)보다 조금 길게"가
출발점이고, 그 값은 실측(GC 로그·p99)에서 온다.

### 4-2. 자동 재시도의 대가 — 중복과 폭풍

재시도는 순단을 사용자 모르게 넘긴다. 대신 두 가지를 잃는다. 첫째, **커밋
여부가 불명한 쓰기를 재시도하면 중복이다.** 타임아웃 하나에는 세 가지 결과가
숨어 있다 — 서버에 안 닿았음 / 닿아서 커밋됐고 복제도 됐음 / 커밋됐지만
승격 과정에서 사라졌음. 클라이언트는 셋을 구분할 수 없다. 재시도하면 두 번째
경우에 중복, 안 하면 첫·세 번째 경우에 유실이다. 이 삼거리를 없애는 유일한
방법이 멱등키(§3-6 ①)이고, 멱등키가 없다면 **재시도가 아니라 대조**가 맞다.
둘째, **재시도 폭풍**. 20개 파드 × 200 TPS × 3회가 같은 순간 새 프라이머리를
두드리면 겨우 승격된 DB가 다시 넘어진다. 지수 백오프 + 지터 + 서킷 브레이커가
없는 재시도는 장애 증폭기다.

선을 긋는 법: **읽기는 자유롭게, 쓰기는 멱등키가 있을 때만, 불명(08007·
타임아웃)은 멱등 아니면 대조 큐로.** 그리고 재시도 총량에 예산을 둔다(서킷
OPEN이면 재시도도 안 한다).

### 4-3. 읽기 전용 저하 모드의 대가

전면 장애를 "주문만 안 되는 상태"로 줄이는 건 큰 이득이다. 대가는 셋이다.
**① 쓰기 기능 상실 자체** — 그 시간 동안의 주문은 없다. 비즈니스가 "차라리
느리더라도 받아라"를 원할 수 있고, 그건 기술이 정할 일이 아니다. **② 코드
복잡도** — 모든 쓰기 경로가 모드를 확인해야 하고, "읽기처럼 보이지만 쓰는"
경로(로그인 시 마지막 접속 시각 갱신, 조회수 증가)가 모드를 뚫고 나가 에러를
만든다. 저하 모드는 만든 날이 아니라 훈련한 날(§3-11)에 완성된다. **③ 전환
판단의 오탐** — 서킷이 순간 스파이크에 열리면 멀쩡한 DB를 두고 쓰기를 막는다.
저하 모드로 들어가는 조건은 failover 감지만큼 보수적이어야 하고, 나오는 조건은
자동보다 사람 확인이 안전한 경우가 많다.

### 4-4. 동기/반동기 복제(RPO 0)의 대가

§1-1 ②의 유실을 없애려면 커밋 응답 전에 리플리카 도달을 기다리면 된다. 대가는
**모든 쓰기 지연에 네트워크 왕복이 더해지는 것**과, 더 중요하게, **가용성
결합**이다 — 리플리카가 느리거나 죽으면 마스터의 쓰기가 멈춘다. 리플리카를
추가한 이유가 가용성이었는데 결합이 가용성을 깎는다. MySQL 반동기 복제는 그래서
대기 시간에 상한을 두고 초과하면 비동기로 **자동 강등**한다 — 즉 "반동기를
켰으니 RPO 0"이 아니라 "평시엔 RPO≈0, 리플리카가 아플 땐 비동기"다. 그리고
반동기가 보장하는 건 "받았다"이지 "적용했다"가 아니라서 읽기 일관성 문제는
그대로 남는다([`../03-jpa-orm/read-replica-routing-and-lag.md`](../03-jpa-orm/read-replica-routing-and-lag.md)
꼬리질문 "반동기 복제를 쓰면 lag이 없어지지 않나요"). RPO 0이 진짜 요구라면
그 비용을 쓰기 지연으로 낼지, 공유 스토리지 구조로 낼지, 아니면 애플리케이션
수준의 대조(§3-6 RECONCILE)로 낼지 — 셋 중 하나는 반드시 내야 한다.

### 4-5. 프록시(RDS Proxy·ProxySQL·PgBouncer)의 대가

프록시가 DB 앞에 서면 앱은 프록시와만 커넥션을 맺고, failover는 프록시가
흡수한다 — 앱 쪽 커넥션은 끊기지 않고 진행 중 쿼리만 실패한다. §1-2 (b)(c)가
대부분 사라지고, 커넥션 멀티플렉싱으로 파드 수 × 풀 크기가 DB에 그대로
닿는 문제(§2-8)도 완화된다. 대가는 **홉 하나의 지연**, **프록시 자체가 새로운
병목이자 장애점**이 된다는 것(프록시의 failover는 누가 하나), 그리고
**세션 고정(pinning)** — 세션 변수·임시 테이블·프리페어드 스테이트먼트를 쓰면
프록시가 그 세션을 특정 백엔드 커넥션에 고정해 멀티플렉싱 효과가 사라진다.
프록시를 뒀다고 §3-1·§3-6이 필요 없어지는 것도 아니다 — 프록시까지의
소켓도 반개방이 될 수 있고, 프록시 뒤에서 실패한 쓰기의 커밋 여부는 여전히
불명이다.

### 4-6. 짧은 `maxLifetime`·`keepaliveTime`의 대가

`maxLifetime` 5분은 좀비의 최대 수명을 30분에서 5분으로 줄인다. 대신 커넥션
하나당 5분마다 재연결 비용(TCP + 인증 + TLS 핸드셰이크)이 들고, 풀 20개 ×
파드 20개 = 400개 커넥션이 5분 주기로 다시 맺어진다. HikariCP가 만료 시각에
작은 편차를 줘 동시 만료는 피하지만 DB 쪽 접속 로그와 CPU에는 주기적 파도가
보인다. `keepaliveTime` 1분은 유휴 커넥션에만 ping을 보내므로 비용이 작지만
0은 아니다. 선은 "장애 시 허용 가능한 자연 치유 상한"에서 긋는다 — §3-5가
제대로 있으면 `maxLifetime`은 최종 보루일 뿐이므로 더 길어도 되고, §3-5가
없다면 `maxLifetime`이 곧 장애 시간이므로 짧아야 한다.

## 5. 실무 사례 — "failover는 40초 만에 끝났는데 쓰기가 30분 동안 간헐 실패"

**상황.** 새벽에 관리형 DB의 writer 인스턴스가 장애로 failover. 인프라 알림은
"40초 만에 완료". 그런데 그 뒤 30분 동안 주문 API의 약 30%가 `--read-only
option` 에러로 실패하고, 나머지 70%는 정상. 조회 API는 100% 정상. 인프라 팀:
"클러스터 정상, 새 writer 쓰기 가능 확인." 앱 팀: "코드 안 바꿨는데요."

**메커니즘 사슬.**

```text
failover 개시
 → 구 writer 인스턴스 재기동 → 앱의 기존 커넥션 전부 RST (§1-2 a) → HikariCP evict → 풀 재생성 시작
 → 재생성 시점: 엔드포인트 DNS는 이미 새 writer IP로 갱신됐지만
   JVM InetAddress 캐시(이 이미지에서는 기본 30초)에는 구 IP가 남아 있음 (§1-4)
 → 그 30초 안에 만들어진 커넥션 20개 중 ~6개가 구 IP로 접속
 → 구 인스턴스는 이미 리플리카로 재구성돼 read_only=ON. 접속은 성공, isValid()도 통과 (§1-2 c)
 → 이 6개로 나간 INSERT/UPDATE만 1290 실패. SELECT는 성공 → "30% 간헐, 쓰기만"
 → 1290의 SQLState는 HY000 → HikariCP evict 안 함 → 풀로 반환 → 다음 요청이 또 잡음
 → maxLifetime 기본 30분 도달 → 6개가 차례로 폐기·재생성 → 이번엔 DNS가 갱신돼 새 writer로 → 자연 회복
```

"30분"은 아무도 설정한 적 없는 숫자다 — HikariCP `maxLifetime` 기본값
1,800,000ms가 그대로 장애 시간이 됐다. "30%"도 설정한 적 없다 — JVM DNS
캐시 30초 창 안에 몇 개가 만들어졌느냐가 정한 우연이다.

**재발 방지 — 코드로 고정한 것.**

1. `Security.setProperty("networkaddress.cache.ttl", "5")` 진입점 고정 +
   Dockerfile에 `java.security` 덮어쓰기 (§3-3).
2. `ReadOnlyPrimaryEvictor` 등록 — 1290/1836/25006을 MUST_EVICT로 (§3-5).
   이것만 있었어도 30분이 "첫 실패 1회"로 끝났다.
3. `max-lifetime: 300000` — 최종 보루를 30분에서 5분으로 (§3-2).
4. SQLState/벤더 코드별 에러 카운터와 "1290 > 0이 60초 지속" 알람 (§3-10).
5. 분기마다 스테이징 강제 failover, 앱 RTO(합성 쓰기 기준) 측정을 릴리스
   체크리스트에 추가 (§3-11). 첫 훈련 결과 앱 RTO 31분 → 2번 적용 후 18초.

**회고에서 나온 문장.** "인프라가 40초 만에 복구했다는 말은 맞았다. 앱이
30분 동안 복구하지 않았다는 말도 맞았다. 두 팀 다 자기 경계 안만 봤고, 사슬의
가운데 — 소켓·DNS 캐시·풀의 evict 판정 — 는 누구의 경계도 아니었다." 이
"누구의 경계도 아닌 구간"을 자기 책임으로 끌어오는 것이 rationale의 "내 코드
밖에서 벌어지는 일까지 책임 범위로 보는 시야"다.

## 6. 꼬리질문 대비 포인트

### "failover가 끝났다는 알림을 받았는데 앱은 아직 에러입니다. 무엇부터 봅니까?"

**증상의 모양으로 §1-2의 세 부류 중 어느 것인지 먼저 가른다.**

- **읽기·쓰기 모두 실패 + 풀 `active`가 max에 붙어 안 내려옴 + DB는 한가**
  → (b) 반개방. 스레드 덤프에서 소켓 읽기에 멈춘 스레드를 확인. 즉효는
  `softEvictConnections()` 또는 재시작, 근본은 `socketTimeout`.
- **쓰기만, 그것도 일부만 실패 + 에러가 1290/25006** → (c) read-only 좀비.
  `SHOW VARIABLES LIKE 'read_only'`를 **앱이 붙은 그 IP**에서 확인. 즉효는
  `softEvictConnections()`, 근본은 `SQLExceptionOverride` + DNS TTL.
- **`Communications link failure`가 계속** → DNS가 아직 구 IP를 주고 있거나
  (JVM 캐시 영구 설정 의심: `dig`는 새 IP인데 앱은 구 IP로 SYN을 보냄) 새
  프라이머리가 `max_connections`에 막혀 접속 거부 중(재연결 폭풍).

"재시작해보겠습니다"는 마지막 답이다 — 재시작은 (b)(c)를 지우지만 원인도
같이 지워서 다음 failover에 그대로 재발한다. **재시작 전에 스레드 덤프와
`SHOW PROCESSLIST`를 남기는 것**이 시니어의 순서다.

### "`socketTimeout`을 몇 초로 잡을 건가요? 배치 쿼리는 그보다 긴데요."

**하나의 값으로 답하지 않는다. DataSource를 워크로드별로 나눈다.** 온라인
트랜잭션용은 "p99 쿼리 시간 × 여유 배수"(예: p99 300ms → 5~10초), 배치·통계용은
별도 DataSource(별도 HikariCP 풀)에 그 배치의 최장 실행 시간보다 긴 값. 같은
풀에 섞으면 §4-1의 오탐과 §1-3의 무한 대기 중 하나를 반드시 고른다. 덤으로 배치
풀 분리는 배치가 온라인 풀을 고갈시키는 것도 막는다
([`../02-spring/thread-pool-connection-pool-sizing.md`](../02-spring/thread-pool-connection-pool-sizing.md)).
그리고 `socketTimeout`은 "쿼리 하나의 응답"이 아니라 "소켓에서 **한 번의
read()**"의 상한임을 안다 — 결과가 스트리밍으로 계속 오는 대량 조회는 각
패킷 사이 간격이 10초를 안 넘으면 전체가 10분이어도 안 끊긴다.

### "타임아웃으로 실패한 결제 INSERT를 재시도해도 되나요?" (시니어 변별 포인트)

**"멱등키가 있으면 예, 없으면 재시도가 아니라 대조."** 이유를 세 갈래로 —
타임아웃 하나에는 (1) 서버에 안 닿았음 (2) 커밋됐고 복제됐음 (3) 커밋됐지만
승격에서 유실됨, 세 결과가 숨어 있고 클라이언트는 구분 못 한다. 멱등키가
UNIQUE로 박혀 있으면 (2)에서 재시도는 제약 위반으로 튕기고 그 충돌을 "이미
됐음"으로 읽으면 되며, (1)(3)에서는 정상 삽입된다 — 세 경우 모두 안전.
멱등키가 없으면 (2)에서 이중 결제다. 그때는 재시도 대신 **결제 ID로
`SELECT`해 실제 상태를 대조**하고, 대조도 안 되면(새 프라이머리에 없음 = (1)
또는 (3)) 사용자에게 "확인 중"을 보여주고 보정 큐로 넘긴다. 여기서 한 발 더 —
**(3)은 앱 로그에 "성공"으로 남아 있다.** 로그와 DB를 대조하는 배치가 없으면
사용자가 신고할 때까지 모른다. "결제됐는데 주문이 없다" 문항
([`./payment-succeeded-order-missing-incident.md`](./payment-succeeded-order-missing-incident.md))이
이 지점에서 이 문항과 만난다.

### "RDS Proxy 같은 프록시를 두면 이 문제가 다 해결되나요?" (가산점 포인트)

**절반은.** 프록시는 §1-2 (b)(c) — 앱이 죽은/틀린 백엔드 소켓을 쥐는 문제 —
를 앱 대신 처리하고, 재연결 폭풍(§2-8)도 프록시가 흡수한다. 그래서 failover
중 앱이 보는 것은 "진행 중 쿼리 몇 개의 실패"로 줄어든다. **해결 안 되는 것**:
① 커밋 여부 불명(§4-2) — 프록시 뒤에서 죽은 트랜잭션의 결과는 프록시도 모른다.
멱등키는 그대로 필요하다. ② 앱→프록시 소켓의 반개방 — `socketTimeout`은 그대로
필요하다. ③ 프록시 자체의 가용성과 세션 고정(§4-5). 정리하면 **"프록시는
사슬의 DB 쪽 절반을 짧게 만들고, 앱 쪽 절반(타임아웃·멱등·서킷)은 그대로
우리 몫"** 이다.

### "복제를 동기로 바꾸면 데이터 유실은 없어지나요?" (가산점 포인트)

**"유실 확률을 줄이는 대신 쓰기 지연과 가용성 결합을 산다. 그리고 반동기는
타임아웃 시 비동기로 강등되므로 무조건 0도 아니다."** §4-4를 그대로 말하되
마지막에 선택지를 셋으로 정리한다 — 쓰기 지연으로 내거나(동기 복제), 스토리지
구조로 내거나(공유 스토리지), 애플리케이션 대조로 내거나(멱등키 + 보정). "RPO
0이 정말 요구사항인가"를 비즈니스에 되묻는 것까지가 답이다 — 대부분의
도메인은 "수 초의 유실을 사후 대조로 복구"가 "모든 쓰기가 느려짐"보다 싸다.

### "failover 훈련은 어떻게 하나요?"

**강제 failover 명령 한 줄과, 그 전후로 재는 숫자 셋.** (1) 인프라 완료
시각 vs 앱 완료 시각(합성 쓰기 기준)의 차이 = 앱 RTO, (2) 그 사이 5xx 건수와
최대 지속 시간, (3) 재시작된 파드 수(0이 목표)와 1290/25006 카운터가 0으로
돌아온 시각. 스테이징에서 시작해 트래픽 낮은 시간대의 운영으로 넓히고,
**드라이버·풀·JVM 설정을 바꿀 때마다** 다시 잰다. 훈련이 잡아내는 전형적
결함: `-D`로 넘겨서 무시된 DNS TTL, 배치 풀에 온라인용 타임아웃, liveness에
남아 있던 DB 체크, 저하 모드를 뚫고 나가는 "읽기처럼 보이는 쓰기".

---

## 한 줄 요약

failover는 **다운 감지 → 승격(복제 지연분 유실 = RPO) → DNS 전환(TTL) → JVM
DNS 캐시**까지가 인프라의 일이고, 그 뒤 앱의 풀에 남은 **반개방 소켓
(`socketTimeout` 없으면 무한 대기 → 풀 고갈 → 스레드 고갈)** 과 **살아 있지만
read-only인 좀비 커넥션(`isValid()` 통과, HikariCP는 evict 안 함, `maxLifetime`
30분까지 생존)** 이 "인프라는 복구됐는데 앱은 계속 장애"를 만든다 — 대비는
JDBC `socketTimeout`·HikariCP `connectionTimeout`/`maxLifetime`/`keepaliveTime`·
JVM `networkaddress.cache.ttl`·`SQLExceptionOverride`로 read-only evict·멱등키
조건부 재시도·서킷 브레이커·readiness 전용 DB 체크·정기 failover 훈련으로
**코드에 고정**하되, 짧은 타임아웃은 오탐을, 자동 재시도는 커밋 불명 쓰기의
중복을, 저하 모드는 쓰기 기능과 복잡도를, 동기 복제는 지연과 가용성 결합을
**대가로 치른다는 양면**까지 한 호흡에 말하는 것이 이 문항의 답이다.
