# Graceful Shutdown과 무중단 배포 — 배포할 때마다 에러가 소량 나는 이유

> 핵심 관전 포인트: 배포 시 에러의 실패 모드는 두 가지다 — (a) 구버전 프로세스가 죽으면서 **진행 중이던 요청이 끊기는 것**, (b) LB가 아직 트래픽을 보내는데 앱이 새 요청을 거부하는 **순서 레이스**. (a)는 앱의 `server.shutdown=graceful`이 막고, (b)는 인프라가 **트래픽 차단 → 전파 대기 → SIGTERM** 순서를 보장해야 막는다. 역할 분담: **앱 graceful = 이미 들어온 요청 보호, 인프라 = 새 요청 차단, 배포 절차 = 둘의 순서 보장.** 한쪽만 하면 배포 때마다 에러가 "소량" 계속 난다.

## 0. 질문 + 의도

**질문**: "배포 중 무중단(graceful shutdown)을 위해 Spring Boot에서 어떤 설정과 인프라 구성이 필요한가요?"

**출제 의도**: 배포할 때마다 에러가 소량 발생하는데 아무도 신경 안 쓰는 팀이 많다. 이를 문제로 인식하고 인프라(LB 제외)와 앱(진행 중 요청 완료)의 협업으로 풀어본 사람인지 — 운영 품질에 대한 기준선을 본다.

## 1. 문제 정의 — 두 가지 실패 모드를 구분하라

배포 스크립트가 구버전 프로세스를 내리는 순간:

| 실패 모드 | 증상 | 책임 주체 |
|---|---|---|
| (a) **진행 중 요청 끊김** | 처리하다 만 요청이 커넥션 리셋/502 — 트랜잭션은 롤백되지만 클라이언트는 실패 응답 | 앱 (`server.shutdown=graceful`) |
| (b) **순서 레이스** | 앱은 이미 종료 절차에 들어갔는데 LB가 계속 새 요청을 보냄 → connection refused/502 | 인프라 + 배포 절차 |

많은 팀이 (a)만 고치고 "graceful 켰는데 왜 아직도 에러가 나지?"에서 멈춘다 — 남은 건 전부 (b)다.

## 2. 앱 쪽: `server.shutdown=graceful`

```yaml
server:
  shutdown: graceful          # 기본값은 immediate
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s   # 기본 30초
```

SIGTERM 수신 시 동작 순서:

1. **신규 요청 수용 중단** — 톰캣이 새 커넥션/요청을 더 받지 않는다.
2. **진행 중(in-flight) 요청 완료 대기** — 처리 중이던 요청은 응답까지 마저 처리.
3. **타임아웃 초과 시 강제 진행** — `timeout-per-shutdown-phase`(기본 30s)를 넘기면 남은 요청을 포기하고 종료 단계를 계속한다. 무한정 기다리지 않는다.

주의: 이 설정은 **이미 들어온 요청**만 보호한다. 1번 단계 때문에 "새 요청 거부"는 오히려 즉시 시작되므로, LB가 계속 트래픽을 보내고 있으면 (b) 레이스가 그대로 터진다.

## 3. 핵심 원리 — LB 제외는 비동기로 전파된다

LB에서 인스턴스를 빼는 것은 API 호출 한 번으로 끝나지 않는다. 헬스체크 주기, 엔드포인트 목록 전파, 프록시 갱신까지 **수 초의 전파 지연**이 있다. 그래서 순서 보장 패턴은 항상 3단계다:

```
① 트래픽 차단 신호 (LB 디레지스터 / readiness DOWN / 엔드포인트 제거)
② 전파 대기 (LB가 실제로 안 보낼 때까지 — sleep 또는 draining 대기)
③ SIGTERM (이제 graceful shutdown이 in-flight만 처리하면 됨)
```

②를 생략하면 ①과 ③ 사이에 도착한 요청이 전부 에러가 된다 — "graceful 켰는데도 배포 에러"의 정체.

## 4. Kubernetes — preStop sleep이 필요한 이유

함정: 파드 종료 시 **"엔드포인트 목록에서 제거"와 "컨테이너에 SIGTERM 전송"이 동시에, 서로 비동기로** 진행된다. kube-proxy/인그레스가 엔드포인트 갱신을 반영하기 전에 SIGTERM이 먼저 도착할 수 있다.

```yaml
spec:
  terminationGracePeriodSeconds: 60   # > preStop(15s) + graceful timeout(30s)
  containers:
    - name: app
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 15"]   # ② 전파 대기를 sleep으로 확보
      readinessProbe:
        httpGet: { path: /actuator/health/readiness, port: 8080 }
```

- **preStop sleep 10~15초** = SIGTERM을 늦춰서 엔드포인트 제거가 전파될 시간을 버는 것. 이 sleep 동안 앱은 정상 서빙 중이므로 새 요청을 받아도 안전하다.
- **terminationGracePeriodSeconds**는 preStop + graceful timeout의 합보다 커야 한다. 넘기면 SIGKILL이 날아와 graceful이고 뭐고 없다.
- readiness probe는 롤링 업데이트에서 **신버전이 준비된 뒤에만** 트래픽을 받게 하는 반대 방향 보호막.

## 5. VM + LB — 배포 스크립트가 순서를 책임진다

```bash
# ① LB에서 제외 (디레지스터 API 또는 헬스체크 엔드포인트를 DOWN으로 전환)
aws elbv2 deregister-targets --targets Id=$INSTANCE
# ② connection draining / deregistration delay 대기 (LB가 in-flight를 흘려보내는 시간)
sleep $DRAIN_SECONDS
# ③ 이제 SIGTERM
kill -TERM $PID   # graceful shutdown이 잔여 요청 마무리
```

헬스체크 DOWN 전환 방식(예: actuator readiness를 내리는 관리 엔드포인트 호출)을 쓰면 LB API 권한 없이도 ①을 수행할 수 있다 — 단 헬스체크 실패 판정 횟수 × 주기만큼 ②를 길게 잡아야 한다.

## 6. 놓치기 쉬운 것

- **SIGKILL(kill -9)은 graceful 무효** — 훅 자체가 실행되지 않는다. 배포 스크립트가 TERM 후 대기 없이 곧바로 -9를 쏘는지 점검.
- **백그라운드 작업도 shutdown phase에 물린다** — `@Scheduled`/`@Async` 실행 중 작업, 커넥션풀 정리(HikariCP close)도 컨텍스트 종료 단계에서 순서대로 내려간다. 오래 걸리는 배치성 작업이 있으면 timeout 안에 못 끝나 강제 종료될 수 있다.
- **롤링 배포는 신구 버전이 동시에 살아 있는 시간을 만든다** — DB 스키마·이벤트 포맷이 양쪽 버전과 호환(하위호환)돼야 무중단이 완성된다. 프로세스 종료만 곱게 해서는 부족하다.

## 7. 꼬리질문 대비 포인트

- **"graceful 켰는데도 배포 때 에러가 난다. 왜?"** — (b) 레이스. LB 제외 전파가 끝나기 전에 SIGTERM이 도착. 해법 = preStop sleep / 디레지스터 후 대기.
- **"진행 중 요청이 5분짜리면?"** — timeout-per-shutdown-phase 초과 시 끊긴다. 장시간 작업은 요청-응답이 아니라 비동기 작업(큐 + 워커)으로 분리하는 게 설계 정답.
- **"k8s에서 preStop sleep 없이 readiness만 내리면 안 되나?"** — 종료 시퀀스에서는 readiness 실패 반영도 결국 엔드포인트 전파를 기다려야 하므로 같은 문제. sleep이 가장 단순·확실한 전파 대기 수단.
- **"무한정 기다리면 안 되나?"** — 좀비 배포가 된다(롤링이 안 끝남). 상한을 두고, 초과분은 끊는 대신 장시간 작업 자체를 없애는 방향으로.

## 한 줄 요약

무중단 배포 = 앱의 `server.shutdown=graceful`(들어온 요청은 끝까지, 기본 30s 상한) + 인프라의 **트래픽 차단 → 전파 대기 → SIGTERM** 순서 보장(k8s는 preStop sleep, VM은 디레지스터 후 draining 대기) — 앱은 이미 들어온 요청을 보호하고, 인프라는 새 요청을 차단하며, 배포 절차가 그 둘의 순서를 보장한다.
