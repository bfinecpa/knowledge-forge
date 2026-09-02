# Actuator 운영 활용 엔드포인트와 외부 노출 보안 — 관측 도구가 공격 표면이 되지 않게

> 핵심 관전 포인트: **Actuator는 앱이 자기 내부 상태를 HTTP로 알려주는 스프링 부트의 관측·관리 창구다. 운영에서 실제로 손이 가는 것은 넷이다 — `health`(LB 헬스체크와 k8s probe의 판정 근거), `metrics`/`prometheus`(커넥션 풀·톰캣 스레드·JVM 지표의 원천), `loggers`(재기동 없이 로그 레벨을 바꾸는 유일한 수단), `threaddump`/`heapdump`(SSH 없이 뜨는 진단 덤프). 문제는 같은 창구가 공격자에게도 열린다는 것이다. `/env`가 열리면 설정의 키 이름과 프로퍼티 소스 구조가 통째로 드러나고, `/heapdump`는 GET 한 번에 그 순간 메모리 전체 — 세션 토큰, 복호화된 시크릿, 처리 중이던 개인정보 — 를 수백 MB 파일로 내려준다. 부트 3.x는 기본 노출이 `health` 하나뿐이고 `/env`·`/configprops`의 값은 전부 마스킹되므로 기본값 자체는 안전한데, 사고는 개발 편의로 켜 둔 `exposure.include=*`가 운영에 그대로 나가면서 난다. 그래서 방어는 3중이다 — 필요한 것만 여는 최소 노출, `management.server.port`로 관리 포트를 분리해 방화벽으로 내부망만 허용, 그리고 인증. 여기에 세 가지 함정이 붙는다: 포트를 분리하면 관리 포트가 별도 자식 컨텍스트에서 뜨므로 메인 컨텍스트의 시큐리티 필터 체인이 자동으로 적용되지 않고, 내가 `SecurityFilterChain`을 하나라도 정의하는 순간 actuator를 보호하던 부트의 기본 보안 자동 설정이 물러나며, `loggers`는 POST로 상태를 바꾸는 쓰기 가능 엔드포인트라 읽기 전용 엔드포인트와 위험도가 다르다.**

---

## 0. 질문 + 의도

**질문**: "Actuator에서 운영에 실제로 활용하는 엔드포인트는? 외부 노출 시 보안 주의점은?"

**출제 의도**: 헬스체크·메트릭·스레드덤프를 운영의 표준 도구로 쓰고 있는지, 동시에 `/heapdump`·`/env` 무방비 노출이 곧 정보 유출 사고임을 아는지 확인한다. 편의 기능의 보안 면적을 함께 보는 습관이 있는지를 본다.

## 1. 운영에서 실제로 쓰는 엔드포인트

### 1-0. Actuator가 무엇인지부터

**Actuator(액추에이터)는 "구동 장치"라는 뜻으로, 앱이 자기 내부 상태를 밖에서 들여다보고 일부는 조작까지 할 수 있게 열어주는 스프링 부트의 부가 모듈**이다. 의존성 하나(`spring-boot-starter-actuator`)를 넣으면 `/actuator/**` 경로에 미리 만들어진 관리용 HTTP 엔드포인트들이 붙는다.

여기서 두 가지를 구분해야 뒤의 보안 이야기가 정확해진다.

- **활성화(enabled)** — 그 엔드포인트가 존재하는가. 대부분 기본 활성이고, `shutdown` 하나만 기본 비활성이다.
- **노출(exposure)** — 존재하는 엔드포인트를 HTTP(또는 JMX)로 밖에 내보이는가. 부트 3.x 기준 **HTTP와 JMX 양쪽 모두 기본값은 `health` 하나뿐**이다.

즉 "기능은 다 켜져 있는데 창구만 하나 열려 있다"가 기본 상태다. 이 구분을 모르면 "왜 `/actuator/env`가 404가 나지"에서 헤매고, 반대로 `include: "*"`가 왜 위험한지도 체감하지 못한다.

아래 표는 운영에서 실제로 손이 가는 것만 추린 것이다. 각각이 왜 필요한지는 표 아래에서 이어 설명한다.

| 엔드포인트 | 한 줄 용도 |
|---|---|
| `/actuator/health` | 살아 있는가, 트래픽 받을 준비가 됐는가 |
| `/actuator/metrics`, `/actuator/prometheus` | 풀·스레드·JVM 지표를 숫자로 |
| `/actuator/loggers` | 재기동 없이 로그 레벨 변경 (읽기 + 쓰기) |
| `/actuator/threaddump` | 지금 스레드들이 어디에 묶여 있는가 |
| `/actuator/heapdump` | 힙 전체를 파일로 (메모리 릭 분석) |
| `/actuator/startup` | 기동 단계별 소요 시간 |
| `/actuator/info` | 지금 떠 있는 게 어느 버전인가 |

### 1-1. `health` — 트래픽 라우팅의 판정 근거

`/actuator/health`는 LB의 헬스체크와 쿠버네티스 probe가 찔러보는 대상이다. 여기서 나오는 UP/DOWN 하나로 **이 인스턴스에 트래픽을 보낼지 말지가 결정된다.**

그래서 이 엔드포인트는 "모니터링용"이 아니라 **라우팅 제어 장치**로 이해해야 한다. 무중단 배포에서 "트래픽 차단 신호"를 보내는 세 가지 방법 중 하나가 바로 이 응답을 DOWN으로 바꾸는 것이다([28-graceful-shutdown-zero-downtime-deploy.md](28-graceful-shutdown-zero-downtime-deploy.md) 참고).

부트는 이 하나의 엔드포인트를 목적별로 쪼갤 수 있게 **health group** 기능을 제공한다. `/actuator/health/liveness`(프로세스가 살아 있는가)와 `/actuator/health/readiness`(지금 트래픽을 받을 수 있는가)가 그것이다. 둘의 역할 차이와 "DB 체크를 어디에 넣을 것인가"는 이 문서의 주제를 벗어나므로 별도 문서를 참고한다: [liveness-readiness-probe-db-check.md](../15-container-infra/liveness-readiness-probe-db-check.md).

### 1-2. `metrics` / `prometheus` — 판단의 근거가 되는 숫자

`/actuator/prometheus`는 Prometheus가 주기적으로 긁어가는 지표 노출 창구다. 실제로 장애 때 보는 것은 이런 값들이다.

- `hikaricp.connections.active` — 지금 사용 중인 DB 커넥션 수
- `hikaricp.connections.pending` — 커넥션을 못 얻어 **기다리고 있는 요청 수**
- `tomcat.threads.busy` — 요청을 처리 중인 톰캣 스레드 수
- `jvm.memory.used`, `jvm.gc.pause` — 힙 사용량과 GC 정지 시간

이 숫자들이 없으면 풀 크기 산정이 감으로 떨어지고, 고갈 장애가 났을 때 "무엇이 고갈됐는지"조차 특정할 수 없다. 풀 산정 근거는 [25-thread-pool-connection-pool-sizing.md](25-thread-pool-connection-pool-sizing.md), 고갈 진단은 [26-hikaricp-connection-pool-exhaustion.md](26-hikaricp-connection-pool-exhaustion.md)에 있다.

### 1-3. `loggers` — 재기동 없이 로그 레벨을 바꾸는 유일한 수단

**여기가 이 문서에서 가장 중요한 하나다. 읽기 전용이 아니라 쓰기 가능한 엔드포인트이기 때문이다.**

먼저 이게 왜 필요한지부터. 운영에서 원인 모를 오류가 간헐적으로 난다. 로그를 `DEBUG`로 올려 보고 싶다. 그런데 로그 레벨은 `application.yml`에 있으니, 바꾸려면 설정을 고치고 다시 배포하거나 재기동해야 한다. **그리고 재기동하는 순간 재현 상황이 사라진다** — 채워져 있던 커넥션 풀도, 쌓여 있던 큐도, 문제를 만들던 특정 요청 패턴도 전부 초기화된다.

`/actuator/loggers`는 이 딜레마를 푼다. HTTP 호출 한 번으로 **떠 있는 프로세스의 로그 레벨을 즉시 바꾼다.**

```bash
# 현재 레벨 조회 (GET)
curl http://localhost:9292/actuator/loggers/com.daou.security

# security 패키지만 DEBUG로 — 재기동 없이 즉시 반영 (POST)
curl -X POST http://localhost:9292/actuator/loggers/com.daou.security \
  -H 'Content-Type: application/json' -d '{"configuredLevel": "DEBUG"}'

# 조사가 끝나면 원복. configuredLevel을 null로 보내면 설정 파일 값으로 돌아간다.
curl -X POST http://localhost:9292/actuator/loggers/com.daou.security \
  -H 'Content-Type: application/json' -d '{"configuredLevel": null}'
```

POST라는 점을 반드시 짚어야 한다. **이 엔드포인트는 앱의 상태를 실제로 바꾼다.** 그래서 노출됐을 때의 위험이 읽기 전용 엔드포인트와 성격이 다르다. 공격자 관점에서 보면 이렇다.

- 루트 로거를 `TRACE`로 올려버리면 디스크가 순식간에 차고 I/O가 포화된다. 인증 없이 호출 가능한 **서비스 거부 수단**이다.
- 보안·인증 관련 패키지를 `DEBUG`로 올리면, 이후 로그에 토큰이나 요청 파라미터 같은 민감 정보가 평문으로 찍히기 시작한다. 로그 수집 시스템에 그대로 흘러간다.

### 1-4. `threaddump` / `heapdump` — SSH 없이 뜨는 진단 덤프

원래 이 둘은 서버에 직접 붙어서 JDK 도구로 뜨는 것이다. `jstack <pid>`(스레드 덤프), `jmap -dump:...`(힙 덤프). Actuator는 같은 일을 HTTP로 대신해 준다.

- **`GET /actuator/threaddump`** — 그 순간 모든 스레드의 상태와 스택을 JSON으로 반환한다. 커넥션 풀 고갈이나 데드락 진단의 1차 자료다. 어느 스레드가 무엇을 기다리고 있는지가 그대로 보인다.
- **`GET /actuator/heapdump`** — 힙 전체를 hprof 파일로 다운로드한다. 메모리 릭을 MAT 같은 분석 도구로 파헤칠 때 쓴다.

편리한 만큼 **`heapdump`가 노출 사고의 최우선 경계 대상**인데, 이유는 2절에서 자세히 본다.

한 가지 경계를 짚어두면 좋다. **이 둘은 앱이 이미 떠 있어야 쓸 수 있다.** 기동이 안 끝나 웹 서버가 아직 안 뜬 상태에서는 HTTP 엔드포인트 자체가 없으므로, 그때는 JDK 도구로 직접 떠야 한다. 기동 지연 진단에서 이 구분이 중요하다: [32-slow-application-startup-diagnosis.md](32-slow-application-startup-diagnosis.md).

### 1-5. `startup`과 `info`

`/actuator/startup`은 기동 단계별 소요 시간을 JSON으로 준다. 어느 빈이 몇 ms를 먹었는지 정렬해 볼 수 있어 기동 지연 진단의 정밀 도구다. 다만 `BufferingApplicationStartup`을 코드에서 미리 설정해 둬야 동작한다. 상세는 [32-slow-application-startup-diagnosis.md](32-slow-application-startup-diagnosis.md).

`/actuator/info`는 빌드 버전과 git 커밋 해시를 보여준다. "지금 떠 있는 게 정말 방금 배포한 그 버전인가"를 확인하는 용도다. 부트 3.x부터는 이것도 기본 노출에서 빠졌으므로 쓰려면 명시적으로 열어야 한다.

## 2. 왜 보안 사고의 단골인가 — 공격자 시점으로 본다

### 2-1. 기본값은 안전한데 왜 사고가 나는가

먼저 사실관계를 정확히 하자. **부트 3.x의 기본 노출은 `health` 하나뿐이다.** 공식 문서가 "기본적으로 HTTP와 JMX 양쪽에서 health 엔드포인트만 노출된다"고 명시한다. (부트 2.x에서는 `info`도 함께 열려 있었다.)

그러면 왜 사고가 나는가. 개발자가 열기 때문이다. 전형적인 경로는 이렇다.

```
① 로컬 개발 중 /actuator/beans 를 보고 싶다
② 검색 → "management.endpoints.web.exposure.include: '*' 를 넣으세요"
③ application.yml(공통 설정)에 넣고 문제 해결
④ 그 yml이 그대로 운영에 배포됨
⑤ /actuator/env, /actuator/heapdump 가 인터넷에 열림
```

**핵심은 ③이다.** 개발 편의 설정을 프로파일별 파일이 아니라 공통 `application.yml`에 넣는 순간, 그것은 운영 설정이 된다. 프로파일로 환경을 가르는 규율이 여기서 값을 한다([09-application-yml-profile.md](09-application-yml-profile.md)).

그리고 인터넷에는 `/actuator/env`, `/actuator/heapdump` 경로를 통째로 훑는 스캐너가 상시 돌고 있다. "우리 앱 주소를 아무도 모르니 괜찮다"는 성립하지 않는다.

### 2-2. `/env`와 `/configprops` — 버전에 따라 위험도가 다르다

이 두 엔드포인트는 앱이 읽어들인 **모든 설정값**을 보여준다. `/env`는 환경변수·시스템 프로퍼티·yml을 포함한 전체 프로퍼티 소스를, `/configprops`는 `@ConfigurationProperties`로 바인딩된 설정 객체들을 덤프한다.

**여기서 부트 2.x와 3.x의 동작이 완전히 다르므로 반드시 구분해서 말해야 한다.**

| | 부트 2.x | 부트 3.0 이상 |
|---|---|---|
| 값 마스킹 방식 | **키 이름 패턴 기반** — `password`, `secret`, `key`, `token`, `credentials` 등이 이름에 들어가면 `******`로 가림 | **전부 마스킹** — 값은 기본적으로 모두 `******` |
| 제어 프로퍼티 | `management.endpoint.env.keys-to-sanitize`(패턴 목록) | `management.endpoint.env.show-values` / `...configprops.show-values`, 기본 `never` |
| 커스텀 이름 키 | `db-auth`, `token-value` 같은 규약 밖 이름은 **그대로 노출** | 마스킹됨 |

부트 3.0의 변경은 릴리스 노트에 명시돼 있다. `env`, `configprops`, `quartz` 세 엔드포인트의 `show-values` 프로퍼티가 도입됐고 **기본값이 `never`(항상 전부 마스킹)** 이며, `always` 또는 `when-authorized`로 바꿔야 값이 보인다.

그래서 위험의 성격이 이렇게 갈린다.

**부트 2.x에서의 위험 — 마스킹 규칙을 빠져나가는 키.** 마스킹은 키 이름을 보고 판단하는 안전망이지 방어선이 아니다. `spring.datasource.password`는 가려지지만, 사내 관례로 `payment.gateway.merchant-auth-string` 같은 이름을 붙인 시크릿은 **평문 그대로 나온다.** 이름 규약을 지켰는지에 보안이 걸려 있는 구조 자체가 불안정하다.

**부트 3.x에서의 위험 — 값이 아니라 구조가 샌다.** 값이 전부 가려져도 `/env`는 **프로퍼티 이름과 프로퍼티 소스 목록을 그대로 보여준다.** 공격자는 이것만으로도 많은 것을 얻는다.

```
"systemEnvironment": {
  "PAYMENT_PG_ENDPOINT": { "value": "******" },     ← 값은 가려짐
  "INTERNAL_ADMIN_API_HOST": { "value": "******" }, ← 하지만 이런 게 있다는 사실은 노출
  "AWS_SECRET_ACCESS_KEY": { "value": "******" }
}
```

내부 관리 API가 존재한다는 사실, 어떤 외부 결제사를 쓰는지, AWS 자격증명을 환경변수로 주입한다는 사실, 어떤 프로파일이 활성인지가 전부 드러난다. 이것은 **정찰(reconnaissance) 정보**이고, 다음 단계 공격의 표적을 정하는 재료가 된다.

**그리고 가장 위험한 조합은 마이그레이션이다.** 부트 2.x에서 3.x로 올릴 때 "`/env`에서 값이 안 보인다"는 불편을 해결하려고 `show-values: always`를 넣는 경우가 실제로 있다. 그 순간 3.x의 안전한 기본값을 버리고 2.x보다 더 위험한 상태(패턴 마스킹조차 없이 전부 평문)가 된다. **`when-authorized`가 최소한의 타협이고, 운영에서는 애초에 `/env`를 노출하지 않는 것이 정답이다.**

### 2-3. `/heapdump` — GET 한 번에 메모리 전체

`/env`가 조심스럽게 가려진 설정이라면, `/heapdump`는 **아예 가릴 개념이 없다.**

힙 덤프는 그 순간 JVM 힙에 있던 **모든 객체를 있는 그대로** 담은 바이너리 파일이다. 마스킹이라는 단계가 존재하지 않는다. 그 안에 무엇이 들어 있는지 나열해 보면 심각성이 분명해진다.

- **커넥션 풀이 쥐고 있는 DB 접속 정보** — HikariCP의 `DataSource` 객체 안에 URL·사용자명·비밀번호가 String으로 살아 있다.
- **복호화된 시크릿** — 볼트나 KMS에서 받아 메모리에 올려 둔 API 키는 당연히 평문이다. 암호화해서 저장했다는 사실은 여기서 아무 도움이 안 된다.
- **세션과 토큰** — 세션 저장소에 있는 모든 세션, 처리 중이던 요청의 JWT와 `Authorization` 헤더 값.
- **처리 중이던 개인정보** — 그 순간 메모리에 떠 있던 주문·회원·결제 객체 전부.
- **소스 수준의 구조** — 클래스 이름, 필드 이름, 패키지 구조가 그대로 보인다.

공격 시나리오는 이렇게 단순하다.

```
① 스캐너가 https://api.example.com/actuator 를 훑는다
② 응답에 heapdump 링크가 있다 (include: "*" 때문)
③ curl -O https://api.example.com/actuator/heapdump      ← 인증 없이 300MB 다운로드
④ MAT이나 문자열 검색으로 열어 "password", "Bearer ", "-----BEGIN" 검색
⑤ DB 접속 정보와 유효한 세션 토큰 확보 → 정상적인 인증 흐름을 통째로 우회
```

**주목할 점은 ⑤다.** 이 공격에는 애플리케이션 취약점이 하나도 필요 없다. SQL 인젝션도, 권한 검사 누락도 없다. 그냥 **열려 있는 진단 도구를 정상적으로 호출**했을 뿐이다. 그래서 코드 리뷰나 정적 분석으로는 잡히지 않고, 설정 점검으로만 잡힌다.

부수적으로 가용성 문제도 있다. 힙 덤프를 뜨는 동안 JVM은 사실상 멈추고(stop-the-world), 수백 MB~수 GB를 디스크에 쓴다. 이걸 반복 호출하는 것만으로 서비스가 마비된다.

### 2-4. 상태를 바꾸는 엔드포인트 — `loggers`와 `shutdown`

지금까지는 "정보가 새는" 위험이었다. 성격이 다른 위험이 하나 더 있다. **일부 엔드포인트는 읽기가 아니라 쓰기다.**

- **`/actuator/loggers`** — 앞서 본 대로 POST로 로그 레벨을 바꾼다. 기본 활성이고, 노출만 하면 인증 없이 호출 가능하다. 디스크 포화를 통한 서비스 거부와 민감 정보의 로그 유입, 두 가지 공격 경로가 열린다.
- **`/actuator/shutdown`** — 애플리케이션을 종료시킨다. **다행히 이것 하나만은 기본 비활성**이다(`management.endpoint.shutdown.enabled=false`). 부트가 유일하게 기본 비활성으로 둔 엔드포인트라는 사실 자체가 위험도를 말해준다. 켤 이유도 없다 — 프로세스 종료는 배포 스크립트나 오케스트레이터가 SIGTERM으로 할 일이다.

정리하면 노출 위험도는 3단계로 나뉜다.

```
[3단계] 상태 변경 가능       loggers(POST), shutdown(켰다면)
[2단계] 정보 대량 유출       heapdump, threaddump, env, configprops
[1단계] 구조 정보 노출       beans, mappings, conditions, info
```

## 3. 3중 방어 — 그리고 각각의 함정

방어는 서로 다른 계층에서 세 겹으로 건다. 한 겹이 뚫려도 다음 겹이 남게 하는 것이 목적이다.

### 3-1. 첫 번째 겹: 최소 노출

**필요한 것만 이름으로 열거한다.** 와일드카드는 쓰지 않는다.

```yaml
# before: 개발 편의로 넣었다가 그대로 운영에 나간 설정
management:
  endpoints:
    web:
      exposure:
        include: "*"      # env, heapdump, loggers, beans 전부 열린다

# after: 필요한 것만 이름으로
management:
  endpoints:
    web:
      exposure:
        # health: LB/probe용, prometheus: 지표 수집용, info: 배포 버전 확인용
        include: health, info, prometheus
```

`heapdump`와 `env`를 아예 빼는 것이 기본이다. 필요할 때만 임시로 열고 조사가 끝나면 닫는다.

굳이 `"*"`를 써야 한다면 `exclude`를 반드시 짝으로 붙인다. 다만 **`exclude`는 `include`보다 우선한다**는 규칙에 의존하는 방식이라, 새 부트 버전에서 위험한 엔드포인트가 추가되면 그대로 열린다는 약점이 있다. 화이트리스트(`include` 열거)가 블랙리스트(`exclude`)보다 안전한 이유가 이것이다.

### 3-2. 두 번째 겹: 관리 포트 분리 + 망 제한

**`management.server.port`를 지정하면 actuator만 다른 포트에서 서비스된다.**

```yaml
management:
  server:
    port: 9292        # 서비스는 8080, 관리는 9292
```

이게 왜 강력한 방어인가. **서비스 포트와 관리 포트가 분리되면 네트워크 계층에서 갈라 막을 수 있기 때문이다.**

```
                      인터넷
                        │
                   [외부 LB/인그레스]
                        │  8080만 연결
                        ▼
   ┌────────────────────────────────────────┐
   │  애플리케이션 인스턴스                    │
   │    :8080  서비스 API      ← 외부 개방    │
   │    :9292  actuator        ← 내부망만    │
   └────────────────────────────────────────┘
                        ▲
                        │  9292는 보안그룹/방화벽에서
                        │  모니터링 서버·운영자 대역만 허용
              [Prometheus, 운영자 VPN]
```

이 방식의 장점은 **앱에 취약점이 있든 없든 무관하게 막힌다**는 것이다. 시큐리티 설정을 실수로 잘못 걸어도 패킷 자체가 도달하지 못한다. 애플리케이션 계층 방어와 성격이 다른 독립된 겹이다.

**함정 ①: 관리 포트는 별도 자식 컨텍스트에서 뜬다.** `management.server.port`가 메인 포트와 다르면, 부트는 관리 엔드포인트를 위해 **별도의 웹 서버와 별도의 자식 애플리케이션 컨텍스트**를 만든다. 그런데 메인 컨텍스트에 등록한 서블릿 필터는 이 자식 컨텍스트에 자동으로 등록되지 않는다. **스프링 시큐리티의 필터 체인도 서블릿 필터이므로 마찬가지다.**

즉 `SecurityFilterChain`을 아무리 잘 짜 놔도 **관리 포트로 들어온 요청에는 적용되지 않을 수 있다.** 이것은 스프링 부트에 오래 알려진 제약이고, 개선 요청 이슈가 지금도 열려 있다. 그래서 포트를 분리했다면 반드시 다음 두 가지를 해야 한다.

1. **실제로 인증이 걸리는지 직접 확인한다.** 설정을 믿지 말고 확인한다.
   ```bash
   # 인증 없이 호출했을 때 401/403이 나와야 정상이다.
   # 200이 나온다면 시큐리티가 관리 포트에 적용되지 않은 것이다.
   curl -i http://localhost:9292/actuator/env
   ```
2. **네트워크 계층 차단을 1차 방어로 삼는다.** 앞의 그림대로 9292를 내부망으로 한정한다. 애플리케이션 보안이 자식 컨텍스트 문제로 새더라도 방화벽이 막는다.

관리 컨텍스트에 필터를 직접 등록하고 싶다면 `@ManagementContextConfiguration`으로 관리 컨텍스트 전용 설정을 만드는 방법이 있지만, 손이 많이 가고 버전에 민감하다. **포트를 분리하지 않고 같은 포트에서 시큐리티로 막는 쪽이 오히려 단순할 때가 많다** — 어느 쪽이 낫다기보다, 두 방식의 방어 지점이 다르다는 것을 알고 고르는 것이 중요하다.

### 3-3. 세 번째 겹: 인증

망 제한이 뚫리는 경로가 실제로 있다. **SSRF**(Server-Side Request Forgery, 서버가 공격자가 지정한 주소로 대신 요청을 보내게 만드는 취약점)가 대표적이다. 외부에 열린 앱에 SSRF 구멍이 있으면, 공격자는 그 앱을 발판 삼아 `http://localhost:9292/actuator/heapdump`를 호출시킬 수 있다. **요청이 내부에서 나가므로 방화벽은 아무것도 막지 못한다.** 상세: [14-ssrf-server-side-request-forgery.md](../16-security/14-ssrf-server-side-request-forgery.md).

그래서 인증 한 겹이 더 필요하다.

```java
@Bean
@Order(1)   // 서비스 API용 체인보다 먼저 평가되게 한다
SecurityFilterChain actuatorSecurity(HttpSecurity http) throws Exception {
    // EndpointRequest는 actuator 경로를 문자열이 아니라 타입으로 매칭한다.
    // "/actuator/**" 로 직접 쓰면 management.endpoints.web.base-path를
    // 바꿨을 때 매칭이 조용히 깨진다.
    http.securityMatcher(EndpointRequest.toAnyEndpoint())
        .authorizeHttpRequests(auth -> auth
            // health와 info는 LB·probe가 인증 없이 찔러야 하므로 열어둔다.
            .requestMatchers(EndpointRequest.to(HealthEndpoint.class, InfoEndpoint.class))
                .permitAll()
            // 나머지는 전부 ACTUATOR 권한 보유자만. 모니터링 수집 계정에 부여한다.
            .anyRequest().hasRole("ACTUATOR"))
        // 브라우저 로그인 폼이 아니라 도구가 호출하므로 HTTP Basic이 적합하다.
        .httpBasic(Customizer.withDefaults())
        // actuator 호출은 세션을 쓰지 않으므로 CSRF 대상이 아니다.
        .csrf(csrf -> csrf.disable());
    return http.build();
}
```

**함정 ②: 내 `SecurityFilterChain`을 정의하는 순간 부트의 기본 보호가 사라진다.** 스프링 시큐리티가 클래스패스에 있으면 부트는 `ManagementWebSecurityAutoConfiguration`으로 actuator를 자동 보호한다 — health만 열고 나머지는 인증을 요구하는 체인을 만들어 준다. 그런데 이 자동 설정에는 `@ConditionalOnDefaultWebSecurity` 조건이 붙어 있어, **사용자가 `SecurityFilterChain` 빈을 하나라도 정의하면 물러난다.**

실무의 앱은 거의 전부 자기 시큐리티 설정을 갖고 있다. 즉 **"시큐리티를 붙였으니 actuator는 알아서 보호된다"는 믿음은 대부분의 실제 앱에서 틀렸다.** 물러난 자리를 내 체인이 어떻게 처리하느냐가 전부인데, `permitAll()`을 넓게 걸어놨다면 그대로 열린다.

```java
// 문제: /api/** 만 인증을 걸고 나머지를 permitAll 했다.
//       actuator 경로는 "나머지"에 해당해 그대로 열린다.
http.authorizeHttpRequests(auth -> auth
        .requestMatchers("/api/**").authenticated()
        .anyRequest().permitAll());

// 고침: actuator 전용 체인을 @Order(1)로 앞세워 별도로 판정한다.
//       위의 actuatorSecurity 빈이 그 역할을 한다.
```

### 3-4. `health`의 상세 정보 노출 수준

방어 3중선과 별개로, `health` 하나만 열어 둔 상태에서도 새는 것이 있다. `management.endpoint.health.show-details` 설정이다.

기본값은 **`never`** 로, 응답은 이렇게 최소한이다.

```json
{ "status": "UP" }
```

`always`로 바꾸면 등록된 모든 health indicator의 상세가 붙는다.

```json
{
  "status": "UP",
  "components": {
    "db": { "status": "UP",
            "details": { "database": "PostgreSQL", "validationQuery": "isValid()" } },
    "redis": { "status": "UP", "details": { "version": "7.2.4" } },
    "diskSpace": { "status": "UP",
                   "details": { "total": 250790436864, "free": 12073938944,
                                "path": "/app/." } }
  }
}
```

값 하나하나가 정찰 정보다. **DB 종류와 버전**(알려진 취약점 조회의 출발점), **Redis 버전**, **서버의 디스크 경로와 남은 용량**이 인증 없이 드러난다. 디스크 여유가 거의 없다는 사실은 서비스 거부 공격의 표적 선정에 그대로 쓰인다.

**그리고 LB 헬스체크와 k8s probe는 이 상세가 전혀 필요 없다.** 그들이 보는 것은 HTTP 상태 코드(200이냐 503이냐)뿐이다. 상세를 켜서 얻는 편의는 사람이 브라우저로 볼 때뿐인데, 그 편의를 위해 공개 정보를 늘리는 것은 거래가 맞지 않는다.

절충안이 `when-authorized`다. 인증된 요청에만 상세를 붙여준다.

```yaml
management:
  endpoint:
    health:
      show-details: when-authorized     # 기본값은 never
      show-components: when-authorized  # 컴포넌트 이름 목록도 같은 기준으로
```

### 3-5. 자주 헷갈리는 지점

**"풀·스레드 지표"에서 "풀"은 무엇인가.** 관용적으로 "풀 지표"라고 하면 **DB 커넥션 풀**을 먼저 뜻한다(`hikaricp.connections.active`는 사용 중인 커넥션 수, `hikaricp.connections.pending`은 커넥션을 못 얻어 기다리는 요청 수). "스레드"는 톰캣과 JVM 스레드다(`tomcat.threads.busy`, `jvm.threads.live`). 톰캣 스레드도 구조적으로는 풀이지만 부르는 이름이 다르다. 장애 때 **"커넥션 풀 고갈인가, 스레드 풀 고갈인가"** 를 이 두 계열의 지표로 갈라내는 것이 실전 포인트다.

**`loggers`는 로그 "수집"이 아니다.** 로그를 모아 검색하게 해주는 것은 Loki나 ELK 같은 별도 시스템의 일이다. `/actuator/loggers`는 **떠 있는 프로세스의 로그 레벨 설정을 바꾸는** 관리 기능이다. 즉 "무엇을 찍을지"를 정하는 쪽이고, 수집은 "찍힌 것을 어디로 보낼지"의 문제다.

**`threaddump`/`heapdump`는 actuator가 그 자리에서 떠서 내려주는 것이다.** 어딘가에 저장돼 있던 파일을 서빙하는 게 아니라, 요청을 받은 순간 JVM에서 새로 뜬다. 그래서 호출할 때마다 내용이 다르고, heapdump는 호출 자체가 무거운 작업이다.

**"기본 비활성"과 "기본 미노출"은 다르다.** `shutdown`은 기능 자체가 꺼져 있어(`enabled=false`) 노출을 열어도 동작하지 않는다. `env`나 `heapdump`는 기능은 켜져 있고 창구만 닫혀 있어서, `exposure.include`에 이름을 넣는 순간 즉시 동작한다. **한 줄 설정으로 위험이 열리는 쪽은 후자다.**

## 4. 꼬리질문 대비 포인트

### "`/env`에 마스킹이 있는데 왜 위험한가요?"

**부트 버전을 먼저 갈라서 답해야 정확하다.** "마스킹되니 괜찮다"로 끝내면 함정에 그대로 빠진다.

- **부트 2.x** — 마스킹은 `password`, `secret`, `key` 같은 **키 이름 패턴**을 보고 판단한다. 사내 관례로 붙인 `merchant-auth-string` 같은 규약 밖 이름은 그대로 노출된다. 이름을 잘 지었는지에 보안이 걸려 있는 구조다.
- **부트 3.x** — `show-values`가 도입돼 기본값 `never`, 즉 값은 전부 마스킹된다. 여기까지는 안전하다.
- **그래도 남는 것** — 값이 가려져도 **프로퍼티 이름과 프로퍼티 소스 구조는 그대로 보인다.** 내부 관리 API의 존재, 어떤 외부 서비스를 쓰는지, 자격증명을 어떤 방식으로 주입하는지가 드러난다. 정찰 정보로는 충분하다.
- **가장 위험한 것** — 3.x로 올린 뒤 "값이 안 보인다"는 이유로 `show-values: always`를 넣는 경우다. 2.x의 패턴 마스킹조차 없는, 전부 평문 상태가 된다.

그리고 결정타를 덧붙인다. **`/heapdump`에는 마스킹이라는 개념 자체가 없다.** `/env`를 아무리 잘 가려도 `/heapdump`가 열려 있으면 힙 안의 같은 값이 평문으로 나간다. **마스킹은 안전망이지 방어선이 아니다** — 방어선은 노출 자체를 막는 것이다.

### "관리 포트를 분리하고 방화벽으로 막았는데도 인증이 필요한가요?" (시니어 변별 포인트)

**필요하다. 망 제한이 뚫리는 경로가 실재하기 때문이다.**

가장 현실적인 경로가 SSRF다. 외부에 열린 앱에 "URL을 받아 대신 호출해 주는" 기능이 있고 대상 검증이 허술하면, 공격자는 그 기능에 `http://localhost:9292/actuator/heapdump`를 넣는다. **요청이 서버 내부에서 출발하므로 방화벽 규칙은 전혀 적용되지 않는다.** 이미지 URL 미리보기, 웹훅 등록, 외부 문서 가져오기 같은 흔한 기능이 전부 후보다.

경로가 하나 더 있다. **내부망은 생각보다 넓다.** 같은 VPC의 다른 서비스, 침해당한 사내 PC, 잘못 설정된 VPN이 전부 "내부"다. 내부망 신뢰를 전제로 인증을 생략하는 것은 제로 트러스트 원칙과 정면으로 어긋난다.

여기서 3-2의 함정을 이어 말하면 깊이가 드러난다. **포트를 분리하면 관리 포트가 별도 자식 컨텍스트에서 뜨기 때문에, 메인 컨텍스트의 시큐리티 필터 체인이 자동으로 적용되지 않는다.** 즉 "포트도 분리했고 시큐리티도 걸었으니 두 겹"이라고 믿었는데 실제로는 방화벽 한 겹뿐인 상태가 될 수 있다. 그래서 **설정을 넣은 뒤 인증 없이 curl로 찔러 401이 나오는지 반드시 확인**해야 한다.

### "스프링 시큐리티를 쓰고 있으면 actuator는 자동으로 보호되지 않나요?"

**대부분의 실제 앱에서는 보호되지 않는다.** 이 질문은 정확히 그 착각을 노린 것이다.

부트에는 `ManagementWebSecurityAutoConfiguration`이 있어서 actuator를 자동 보호해 준다 — health만 열고 나머지는 인증을 요구하는 체인을 만든다. 그런데 여기에는 `@ConditionalOnDefaultWebSecurity` 조건이 붙어 있고, 이 조건은 **사용자가 `SecurityFilterChain` 빈을 정의하지 않았을 때만** 성립한다.

실무의 앱은 거의 전부 자기 시큐리티 설정을 갖고 있다. 그 순간 자동 보호는 물러나고, actuator 경로는 **내 체인의 규칙을 그대로 따른다.** `.anyRequest().permitAll()`이 걸려 있으면 그대로 열린다.

그래서 처방은 actuator 전용 체인을 별도로 두고 `@Order`로 앞세우는 것이다. 경로 매칭은 `"/actuator/**"` 문자열 대신 `EndpointRequest.toAnyEndpoint()`를 쓴다 — `management.endpoints.web.base-path`를 바꾸면 문자열 매칭은 조용히 깨지지만 `EndpointRequest`는 따라오기 때문이다.

### "`/actuator/loggers`가 왜 특별히 위험한가요?"

**읽기 전용이 아니라 쓰기 가능한 엔드포인트이기 때문이다.** 지금까지 이야기한 `env`, `heapdump`는 "정보가 샌다"는 위험이었지만, `loggers`는 **공격자가 앱의 동작을 바꿀 수 있다.**

구체적으로 두 가지 공격이 가능하다.

1. **서비스 거부.** 루트 로거를 `TRACE`로 POST하면 초당 수만 줄이 쏟아진다. 디스크가 차고, I/O가 포화되고, 로그 수집 파이프라인까지 함께 무너진다. 인증 없이 요청 한 번으로 된다.
2. **민감 정보를 로그로 유도.** 인증·보안 관련 패키지를 `DEBUG`로 올리면 이후 로그에 토큰과 요청 파라미터가 평문으로 찍힌다. 로그 조회 권한만 있는 낮은 권한의 내부자에게도 그것이 흘러간다.

그래서 노출 위험도를 나눌 때 **상태를 바꾸는 엔드포인트를 정보 유출 엔드포인트보다 위에 둬야** 한다. 같은 계열로 `/actuator/shutdown`이 있는데, 이것 하나만 부트가 기본 비활성으로 두고 있다는 사실 자체가 설계 의도를 말해준다.

### "`health`에 DB 체크를 넣어야 하나요?"

**readiness에는 넣고 liveness에는 빼는 것이 정석이다.**

이유는 두 probe의 실패 시 대응이 정반대이기 때문이다. liveness 실패는 **컨테이너 재시작**을 부르고, readiness 실패는 **트래픽만 차단**한다. DB가 잠깐 끊겼을 때 앱을 재시작해봐야 DB는 여전히 안 붙는다 — 재기동으로 고칠 수 없는 문제에 재기동을 처방하면 전 파드가 동시에 재시작하는 **재시작 폭풍**이 난다.

DB 순단 시 원하는 동작은 트래픽만 빼고(readiness fail) 프로세스는 살려두는 것(liveness ok)이다. 그러면 DB가 회복될 때 파드가 스스로 돌아온다. 상세와 K8s 구조: [liveness-readiness-probe-db-check.md](../15-container-infra/liveness-readiness-probe-db-check.md).

여기에 이 문서의 관점 하나를 덧붙이면 좋다. **health group을 나눠 쓰더라도 `show-details`는 별개의 축이다.** liveness/readiness를 잘 갈라 놨어도 `show-details: always`면 두 응답 모두에 DB 종류·버전과 디스크 경로가 붙어 나간다. probe는 상태 코드만 보므로 상세는 불필요하다.

### "`loggers`를 운영에서 실제로 어떻게 쓰나요?"

**"재기동하면 증상이 사라진다"는 문제를 푸는 도구**라고 답하는 것이 핵심이다.

절차는 이렇다. 간헐적 오류가 관측된다 → 원인 패키지를 좁힌다 → 그 패키지만 `DEBUG`로 POST한다 → 재현될 때까지 로그를 확보한다 → `configuredLevel: null`로 원복한다.

**가치의 핵심은 "재기동 없이"에 있다.** 재기동하면 커넥션 풀도, 캐시도, 문제를 만들던 상태도 전부 초기화된다. 즉 관찰하려던 대상 자체가 사라진다. 로그 레벨을 바꾸려고 재배포한다는 것은 **증상을 없앤 뒤 증상을 조사하겠다는 말**이 된다.

주의점도 함께 말하면 완성된다. 범위를 좁게 잡을 것(루트 로거를 올리면 디스크가 찬다), 원복을 잊지 말 것, 그리고 이 강력한 기능이 곧 위험이므로 **인증 뒤에 두고 호출을 감사 로그로 남길 것.**

---

## 한 줄 요약

Actuator는 health(라우팅 판정)·prometheus(지표)·loggers(무재기동 레벨 변경)·threaddump/heapdump(진단)로 운영을 떠받치는 창구지만 같은 창구가 공격자에게도 열려서 — `/env`는 부트 3.x에서 값이 전부 마스킹돼도 설정의 이름과 구조를 흘리고 `/heapdump`는 GET 한 번에 메모리 전체를 내주며 `/loggers`는 POST로 앱 동작까지 바꾸므로 — 부트 3.x의 기본값이 `health` 하나뿐이라는 설계 의도를 존중해 최소 노출로 열고, 관리 포트를 분리해 내부망만 허용하고, 그 위에 인증을 한 겹 더 얹되, 포트를 분리하면 시큐리티 필터 체인이 자동 적용되지 않고 내 `SecurityFilterChain`을 정의하면 부트의 기본 보호가 물러난다는 두 함정을 알고 실제로 401이 나오는지 확인하는 것까지가 완성이다.
