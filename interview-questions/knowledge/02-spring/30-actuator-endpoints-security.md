# Actuator 운영 활용 엔드포인트와 외부 노출 보안 — 관측 도구가 공격 표면이 되지 않게

> 핵심 관전 포인트: 운영에서 실제로 쓰는 것은 **health**(LB 헬스체크·K8s probe), **metrics/prometheus**(풀·스레드 지표 수집), **loggers**(재기동 없이 로그 레벨
> 변경), **threaddump/heapdump**(고갈·릭 진단)다. 반대로 노출 사고의 단골은 **env·configprops의 시크릿, heapdump의 메모리 통째 유출** — 그래서 부트 기본값이
> health만 노출이고, 운영에서는 **최소 노출 + 관리 포트 분리(내부망 제한) + 인증**의 3중 방어를 깐다.

## 0. 질문 + 의도

**질문**: "Actuator에서 운영에 실제로 활용하는 엔드포인트는? 외부 노출 시 보안 주의점은?"

**출제 의도**: 헬스체크·메트릭·스레드덤프를 운영의 표준 도구로 쓰고 있는지, 동시에 `/heapdump`·`/env` 무방비 노출이 곧 정보 유출 사고임을 아는지 확인한다. 편의 기능의 보안 면적을 함께 보는
습관이 있는지를 본다.

## 1. 운영에서 실제로 쓰는 엔드포인트

| 엔드포인트                                       | 운영 용도                                                                                                                                                                                                                                                                                                |
|---------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/actuator/health`                          | LB 헬스체크, K8s liveness/readiness probe의 대상. 무중단 배포에서 "트래픽 차단 신호"의 근거 ([28-graceful-shutdown-zero-downtime-deploy.md](28-graceful-shutdown-zero-downtime-deploy.md))                                                                                                                                         |
| `/actuator/metrics`, `/actuator/prometheus` | Prometheus가 주기 수집하는 지표의 원천 — `hikaricp.connections.active/pending`, `tomcat.threads.busy`, JVM 힙/GC. 풀 산정 검증과 고갈 진단의 데이터가 여기서 나온다 ([25-thread-pool-connection-pool-sizing.md](25-thread-pool-connection-pool-sizing.md), [26-hikaricp-connection-pool-exhaustion.md](26-hikaricp-connection-pool-exhaustion.md)) |
| `/actuator/loggers`                         | **재기동 없이** 런타임에 특정 패키지 로그 레벨 변경. 장애 조사 중 `DEBUG`로 올려 원인 로그를 확보하고 끝나면 되돌리는 용도 — 재현이 어려운 운영 이슈에서 진가                                                                                                                                                                                                    |
| `/actuator/threaddump`                      | 스레드 덤프 — 커넥션 잡은 스레드의 블록 지점, 풀 대기 스레드 확인                                                                                                                                                                                                                                                              |
| `/actuator/heapdump`                        | 힙 덤프 다운로드 — 메모리 릭 분석(MAT 등). **단, 아래 보안 문단의 최우선 경계 대상**                                                                                                                                                                                                                                              |
| `/actuator/info`                            | 배포 버전·git 커밋 노출 — "지금 떠 있는 게 어느 버전인가" 확인                                                                                                                                                                                                                                                             |

`loggers` 사용 예:

```bash
# security 패키지만 DEBUG로 — 재기동 없이 즉시 반영
curl -X POST http://localhost:9292/actuator/loggers/com.daou.security \
  -H 'Content-Type: application/json' -d '{"configuredLevel": "DEBUG"}'
```

## 2. 왜 보안 사고의 단골인가

- **`/actuator/env`, `/actuator/configprops`** — 환경변수·설정 전체가 나온다. DB 비밀번호, API 키가 환경변수로 주입되는 구조라면 여기 다 있다. 부트가
  `password`, `secret`, `key` 등 이름 패턴은 기본 마스킹(sanitize)하지만 **이름 규약을 벗어난 키(`db-auth`, `token-value` 등)는 그대로 노출** — 마스킹은
  안전망이지 방어선이 아니다.
- **`/actuator/heapdump`** — 힙 안에는 마스킹이라는 개념이 없다. 커넥션 풀이 쥔 **DB 비밀번호 평문, 세션 토큰, 처리 중이던 개인정보**가 통째로 담긴 수백 MB 파일이 GET 한 번에
  내려간다. 외부에 열린 actuator를 스캐너가 찾아 heapdump를 털어가는 것이 실제 침해 사고의 전형적 시나리오다.
- **`/actuator/shutdown`** — 원격 프로세스 종료. 기본 비활성이며, 활성화할 이유가 없다(배포·오케스트레이터가 SIGTERM으로 할 일).

## 3. 방어 3중선

1. **최소 노출** — `management.endpoints.web.exposure.include`에 필요한 것만 명시. 부트 기본값이 **health 하나만**인 것 자체가 "나머지는 위험하니 의식적으로
   열라"는 설계 의도다. `include: "*"`를 복붙하는 순간 env·heapdump까지 열린다.
2. **관리 포트 분리 + 망 제한** — `management.server.port`로 서비스 포트(8080)와 관리 포트(9292)를 분리하고, 관리 포트는 방화벽/보안그룹에서 **내부망(모니터링 서버·운영자
   대역)만 허용**. 외부 LB에는 서비스 포트만 물린다. 이러면 앱 취약점과 무관하게 네트워크 계층에서 차단된다.
3. **인증** — 관리 포트에도 Spring Security로 인증을 건다(모니터링 수집 계정 등). health probe 경로만 permitAll. 망 제한이 뚫려도(내부자·SSRF) 한 겹 더 남는다.

```yaml
management:
  server:
    port: 9292              # 관리 포트 분리 — 방화벽으로 내부망만 허용
  endpoints:
    web:
      exposure:
        include: health, info, prometheus, loggers   # 최소 노출 (heapdump·env 제외)
  endpoint:
    health:
      probes:
        enabled: true       # /health/liveness, /health/readiness 그룹 분리
      show-details: when-authorized
```

health group 분리: liveness(프로세스 생존)와 readiness(트래픽 수용 가능 — DB 등 의존성 포함)를 나눠야, DB 순단에 liveness까지 실패해 **재시작 폭풍**이 나는 사고를
막는다.

## 4. 꼬리질문 대비 포인트

- **"env 마스킹이 있는데 왜 위험한가?"** — sanitize는 키 이름 패턴 기반이라 규약 밖 이름은 통과. heapdump에는 마스킹 자체가 없음. "기본 마스킹 = 방어선"이라는 답이 함정.
- **"SSRF와의 결합은?"** — 내부망 제한만 믿으면, 외부 노출 앱의 SSRF 취약점을 경유해 `http://localhost:9292/actuator/env`로 우회 접근 가능 — 인증 겹이 필요한 이유.
  상세: [14-ssrf-server-side-request-forgery.md](../16-security/14-ssrf-server-side-request-forgery.md)
- **"health에 DB 체크를 넣어야 하나?"** — readiness에는 넣고 liveness에는 빼는 것이 정석. DB 순단 시 트래픽만 빼고(readiness fail) 프로세스는 살려둔다(liveness
  ok). 이유(재기동 폭풍 방지)와 K8s LB
  구조: [liveness-readiness-probe-db-check.md](../15-container-infra/liveness-readiness-probe-db-check.md)
- **"loggers를 운영에서 실제로 어떻게 쓰나?"** — 장애 조사 중 특정 패키지만 DEBUG 상승 → 로그 확보 → 원복. 재기동(=증상 소멸) 없이 관찰한다는 점이 핵심 가치.

## 5. 자주 헷갈리는 지점 (개념 명확화)

- **"풀·스레드 지표"의 "풀"은 무엇?** — 주로 **커넥션 풀**(HikariCP DB 커넥션: `hikaricp.connections.active`=사용 중, `hikaricp.connections.pending`=커넥션 기다리는 요청)을 가리킨다. "스레드"는 톰캣/JVM 스레드(`tomcat.threads.busy`, `jvm.threads.live`). 톰캣 스레드도 풀 구조지만, 관용적으로 "풀 지표"라고 하면 DB 커넥션 풀을 먼저 뜻한다. 장애 시 **"커넥션 풀 고갈인가, 스레드 풀 고갈인가"**를 이 두 지표로 구분하는 게 실전 포인트.
- **loggers는 로그 "수집"이 아니다** — 로그를 모으는 건 Loki/ELK 같은 별도 시스템의 일이고, `loggers`는 **떠 있는 서버의 로그 레벨 설정을 재기동 없이 바꾸는** 관리 기능이다. 원래라면 `application.yml` 고치고 재배포/재기동해야 할 것을, HTTP 호출 한 번으로 `INFO`→`DEBUG`로 올려 원인 로그를 확보하고 끝나면 원복한다(그 사이 재현 상황이 사라지지 않는 게 핵심 가치).
- **threaddump/heapdump는 actuator가 직접 떠서 HTTP로 내려준다** — 원래는 서버에 SSH로 붙어 `jstack <pid>`(스레드 덤프), `jmap -dump:...`(힙 덤프)를 실행해야 하는데, actuator가 이를 HTTP 엔드포인트로 제공한다. `GET /actuator/threaddump`는 그 순간 모든 스레드 상태를 JSON으로(고갈·데드락 진단), `GET /actuator/heapdump`는 힙 전체를 hprof 파일로 다운로드(릭 진단, MAT 분석). heapdump가 노출 사고 단골인 이유가 여기 있다 — 힙에는 그 시점 메모리의 **모든 것(세션 토큰·평문 비밀번호·개인정보)**이 담겨, GET 한 번에 통째로 유출된다.

## 한 줄 요약

Actuator는 health(probe)·prometheus(지표)·loggers(무재기동 레벨 변경)·threaddump/heapdump(진단)로 운영을 떠받치는 도구지만,
env·configprops·heapdump는 시크릿 유출 사고의 단골이므로 **최소 노출 + 관리 포트 분리(내부망) + 인증**의 3중 방어로 잠그고, 기본 노출이 health뿐인 설계 의도를 존중한다.
