# liveness vs readiness — health에 DB 체크를 넣을 곳과 빼야 할 곳

> 핵심 관전 포인트: 두 probe는 이름만 비슷하지 **실패했을 때 K8s의 대응이 정반대**다. liveness 실패 → **컨테이너 재시작**, readiness 실패 → **Service(LB)에서 파드 제외(트래픽만
> 차단)**. 그래서 **재기동으로 고칠 수 있는 것만 liveness에**, **재기동으로 못 고치는 외부 의존성(DB·캐시·외부 API)은 readiness에만** 넣는다. DB 순단 시 트래픽만 빼고
> (readiness fail) 프로세스는 살려두면(liveness ok), 재기동 폭풍 없이 DB 회복과 함께 스스로 복귀한다.

## 0. 질문 + 의도

**질문**: "health 엔드포인트에 DB 체크를 넣어야 하나?"

**출제 의도**: liveness와 readiness의 목적 차이를 아는지, 그리고 외부 의존성 장애가 **재시작 폭풍(cascading restart)**으로 번지는 사고를 막을 줄 아는지 확인한다.

## 1. 두 probe는 실패 시 대응이 정반대다

| Probe | 던지는 질문 | 실패 시 K8s의 행동 |
|---|---|---|
| **liveness** | "이 프로세스 죽었어? 재기동해야 해?" | **컨테이너를 죽이고 재시작** |
| **readiness** | "지금 트래픽 받을 준비 됐어?" | **Service에서 이 파드를 제외**(트래픽만 차단, 프로세스는 그대로) |

DB 체크를 어디에 넣느냐가 여기서 갈린다.

## 2. DB 순단을 두 시나리오로 돌려보면

DB가 잠깐 끊긴 상황(failover, 네트워크 순단, 커넥션 풀 일시 고갈 — 보통 수 초~수십 초면 회복)을 가정한다.

**❌ liveness에 DB 체크를 넣었다면**

```
DB 순단 → liveness fail → K8s "얘 죽었네" → 컨테이너 재시작
```

- **재기동은 DB 문제를 전혀 해결 못 한다.** 프로세스는 멀쩡했는데 애먼 프로세스만 죽인 것. 재시작해도 DB는 여전히 끊겨 있으니 뜨자마자 또 fail → 또 재시작 → **CrashLoopBackOff 무한 재기동**.
- **장애 전파(cascading failure)**: DB 하나가 흔들리면 그 DB를 보는 **모든 파드가 동시에 재기동**. 힘든 DB에 재기동한 파드들이 커넥션을 한꺼번에 다시 맺으려 몰려들어(connection storm) 회복을 더 방해하고 서비스 전체가 같이 무너진다.

**✅ readiness에만 DB 체크를 넣었다면**

```
DB 순단 → readiness fail → 파드를 Service(LB)에서 제외 → 트래픽 안 감
         (프로세스는 살아서 DB 재연결 계속 시도)
DB 회복 → readiness ok  → 다시 Service에 편입 → 트래픽 재개
```

- 트래픽만 잠깐 빠지고 **프로세스는 살아 대기**하다가, DB 회복되면 **재기동 없이 스스로 복귀**한다.
- 재기동 비용(웜업, JIT 재컴파일, 커넥션 재수립, 로컬 캐시 소실)이 없어 회복이 빠르고 안정적이다.

## 3. 판단 기준은 딱 하나

> **"이걸 재기동하면 해결되나?" → Yes면 liveness, No(외부 의존성)면 readiness.**

- **liveness에 넣는 것**: 재기동이 답인 상태 — 데드락으로 응답 불능, 힙이 터져 회복 불가한 프로세스. 이런 건 죽여서 새로 띄우는 게 맞다.
- **liveness에서 빼야 할 것**: DB·캐시·외부 API 등 **재기동으로 못 고치는 남의 문제**. "나(프로세스)는 멀쩡한데 남(DB)이 아픈" 상황이라, 재기동이 아니라 "트래픽만 빼고 기다린다"(readiness fail)가 정답. DB는 명백히 No이므로 **readiness에만** 넣는다.

## 4. 흔한 오해 — "앱과 DB 사이에 LB가 있나?" (아니다)

readiness fail이 "트래픽을 뺀다"고 하면, DB 앞에 LB가 있는 것으로 오해하기 쉽다. **LB(K8s Service)는 앱과 DB 사이가 아니라, 클라이언트와 앱 파드 사이에 있다.**

```
[클라이언트]
     │
     ▼
[Service / LB]   ← readiness가 제어하는 지점 (파드를 넣고 뺌)
     │
 ┌───┼───┐
 ▼   ▼   ▼
[Pod][Pod][Pod] ← 앱 파드
 │   │   │
 └───┼───┘
     ▼
   [DB]          ← 앱이 직접 커넥션을 맺음. 이 구간엔 K8s LB 없음
```

동작 순서로 보면 **감지 구간과 차단 구간이 다르다**:

1. **DB 순단** — 앱↔DB 구간 문제
2. 앱이 자기 readiness 체크에서 DB 연결 확인 → 실패 → K8s에 "나 준비 안 됨" 보고
3. K8s가 그 파드를 **Service 엔드포인트 목록에서 제외**
4. 결과: **클라이언트→앱**(위쪽 화살표)의 트래픽이 그 파드로 안 감

즉 DB 문제를 **감지**하는 곳은 앱↔DB 구간이지만, 그 결과로 **차단**되는 건 클라이언트↔앱 구간이다. 여기서 "Service"는 K8s가 파드 앞에 자동으로 만들어주는 **내부 로드밸런서**이고, ready 상태인 파드에만 요청을 분배한다. readiness는 이 분배 대상 목록을 켜고 끄는 스위치다. DB 못 쓰는 파드는 요청받아야 에러만 내므로, **아예 손님(요청)을 안 보내는 게** 낫다는 것이 readiness의 취지다.

## 5. Spring Boot 설정

Spring Boot도 이 철학을 그대로 반영해 `livenessState`와 `readinessState`를 분리하고, **DB 같은 헬스 인디케이터는 readiness 그룹에만** 편입한다.

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true          # /health/liveness, /health/readiness 노출
      group:
        liveness:
          include: livenessState              # 외부 의존성 제외 — 프로세스 생존만
        readiness:
          include: readinessState, db         # DB 등 의존성 포함
```

K8s probe는 각각 다른 경로를 바라보게 매핑한다.

```yaml
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 9292 }
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 9292 }
```

## 6. 꼬리질문 대비 포인트

- **"readiness에도 DB를 안 넣으면?"** — DB 끊긴 파드에 계속 트래픽이 가서 사용자가 에러를 본다. 트래픽 차단 자동화를 못 하는 것.
- **"liveness에 아무 것도 안 넣으면 위험하지 않나?"** — liveness는 "재기동이 필요한 진짜 죽음"(데드락·힙 고갈)만 봐야 한다. 최소한으로, 외부 의존성 없이 가볍게 두는 게 맞다.
- **"startupProbe는?"** — 기동이 느린 앱에서 초기 웜업 동안 liveness가 조기 발동해 재기동되는 걸 막는 용도. 기동 완료 전까지 liveness/readiness를 유예한다.

## 한 줄 요약

liveness 실패는 **재시작**, readiness 실패는 **트래픽 차단**이므로, 판단 기준은 **"재기동하면 해결되나?"** 하나다. DB·캐시·외부 API는 재기동으로 못 고치므로 **readiness에만** 넣어 DB 순단 시 트래픽만 빼고(프로세스는 살려둠) 재시작 폭풍을 막는다. LB(K8s Service)는 클라이언트↔앱 사이에 있고, readiness는 그 Service의 트래픽 분배 목록을 켜고 끄는 스위치다. 상세 설정은 [actuator-endpoints-security.md](../02-spring/actuator-endpoints-security.md) 참고.
