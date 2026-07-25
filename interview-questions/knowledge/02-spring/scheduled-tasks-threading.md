# @Scheduled 실행 스레드와 지연 전파 — 기본은 스레드 "1개"를 전원이 나눠 쓴다

> 핵심 관전 포인트: Spring Boot의 `@Scheduled`는 기본적으로 **풀 크기 1짜리 `ThreadPoolTaskScheduler`**(`scheduling-1` 스레드)에서 실행된다. 애플리케이션의 **모든 @Scheduled 작업이 이 한 스레드를 공유**하므로, 한 작업이 지연·블록되면 **무관해 보이는 다른 스케줄 작업까지 전부 밀린다.** 대책은 풀 확장 / @Async로 트리거·실행 분리 / 작업군별 스케줄러 분리 — 단, 실행을 병렬화하는 순간 **같은 작업의 중복 실행**과 **다중 인스턴스 동시 실행**이라는 파생 문제를 함께 막아야 한다(fixedDelay vs fixedRate 의미, ShedLock).

## 0. 질문 + 의도

**질문**: "`@Scheduled` 작업들은 기본적으로 어떤 스레드에서 실행되나요? 한 작업의 지연이 다른 작업에 미치는 영향과 대책은?"

**출제 의도**: 기본이 단일 스레드 풀이라 느린 작업 하나가 다른 모든 스케줄을 밀리게 하는데, 증상(특정 작업이 제때 안 돎)에서 원인(스레드 공유)으로 가는 연결이 어렵다. "프레임워크 기본값을 확인하고 쓰는" 습관의 표본으로서 묻는다.

## 1. 기본 동작 — 단일 스레드 공유가 만드는 연쇄 지연

- 부트가 자동 구성하는 스케줄러: `ThreadPoolTaskScheduler`, **pool size 1**, 스레드 이름 `scheduling-1`.
- 장애 시나리오: 새벽 3시 정산 배치가 외부 API 지연으로 40분간 블록 → 같은 스레드에서 돌아야 할 **5분마다의 토큰 정리, 10분마다의 통계 집계가 40분간 전부 실행되지 않음.** 코드상 아무 관련이 없는 작업들이 스레드 하나를 공유한다는 이유만으로 서로를 막는다.
- 이 구조를 모르면 "통계 배치가 안 돌았다"는 장애의 원인을 통계 코드에서만 찾게 된다 — 진범은 옆 작업.

## 2. 진단 — 스레드 이름과 스레드 덤프

- 스케줄 작업 로그의 스레드 이름이 전부 `scheduling-1`이면 단일 스레드 공유 상태라는 자백이다.
- 작업이 안 돌 때: 스레드 덤프(jstack)에서 `scheduling-1`이 **어느 스택에서 블록**돼 있는지 확인 — 외부 API 대기인지, DB 락인지 즉시 드러난다 (`slow-application-startup-diagnosis.md`의 침묵 구간 진단과 같은 도구).

## 3. 대책 3가지

```yaml
# ① 풀 확장 — 작업들이 서로를 막지 않게
spring:
  task:
    scheduling:
      pool:
        size: 5
```

```java
// ② @Async 조합 — 스케줄러 스레드는 '트리거'만, 실행은 별도 풀에서
@Async("batchExecutor")
@Scheduled(fixedDelay = 300_000)
public void cleanUpTokens() { ... }   // async-annotation.md 의 실행 풀 설정·예외 처리 함정 참고
```

```java
// ③ 작업군별 스케줄러 분리 — 중요 작업을 무거운 작업군과 격리
@Configuration
public class SchedulerConfig implements SchedulingConfigurer {
    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(3);
        scheduler.setThreadNamePrefix("critical-sched-");
        scheduler.initialize();
        registrar.setTaskScheduler(scheduler);
    }
}
```

- ③을 더 밀면: 무거운 배치는 아예 **배치 전용 인스턴스**(또는 Spring Batch)로 분리해 API 서버의 스케줄러와 물리적으로 격리.

## 4. 파생 문제 — 병렬화하면 "같은 작업의 중복 실행"이 등장한다

| 속성 | 간격의 기준 | 이전 회차가 오래 걸리면 |
|---|---|---|
| `fixedDelay` | 이전 실행 **종료** 후 N ms | 다음 회차가 그만큼 늦춰짐 — **절대 겹치지 않음** |
| `fixedRate` | 이전 실행 **시작** 기준 N ms | 다음 회차가 밀려서 대기하다 **연달아** 실행됨 |

- 주의할 정밀 포인트: 순수 스케줄러에서는 `fixedRate`라도 **같은 작업이 동시에 2개 실행되지는 않는다**(JDK `scheduleAtFixedRate` 계약 — 늦게라도 순차 실행). 풀을 늘려도 마찬가지다.
- **중복 실행이 실제로 생기는 순간은 ② @Async를 조합했을 때** — 스케줄러는 정시에 트리거만 하고 실행은 다른 스레드가 하므로, 작업 시간이 주기보다 길면 이전 회차가 끝나기 전에 다음 회차가 시작된다. 멱등하지 않은 배치(정산, 발송)라면 사고. 가드: `fixedDelay` 유지, `AtomicBoolean` 실행 중 플래그, 또는 락.

## 5. 다중 인스턴스 — 서버가 2대면 배치도 2번 돈다

- `@Scheduled`는 인스턴스마다 각자 실행된다. 스케일 아웃한 순간 정산 배치가 N번 실행되는 사고.
- 대책: **ShedLock** 같은 분산 락(DB/Redis에 락 레코드, `@SchedulerLock(name=..., lockAtMostFor=...)`) — 한 인스턴스만 실행하고 나머지는 스킵. 또는 스케줄 작업을 배치 전용 인스턴스 1대로 분리.
- `lockAtMostFor`는 실행 인스턴스가 죽었을 때 락이 영원히 안 풀리는 것을 막는 안전핀 — 작업 최장 소요 시간보다 길게.

## 6. 예외가 나면 다음 회차는 도는가

- Spring이 작업을 에러 핸들러로 감싸므로 **예외는 로깅되고 다음 회차는 계속 실행된다** (raw JDK `scheduleAtFixedRate`에서 예외가 이후 실행 전체를 죽이는 것과 다른 점 — Spring의 래핑 덕분).
- 다만 "로그만 남고 조용히 실패가 반복"되는 게 기본값이라는 뜻이기도 하다 — 실패 알림이 필요하면 `TaskScheduler`에 커스텀 `ErrorHandler`를 설정하거나 작업 내부에서 실패를 메트릭/알림으로 승격.

## 꼬리질문 대비 포인트

- **"풀을 5로 늘리면 중복 실행 걱정은?"** — 순수 스케줄러는 같은 작업을 겹쳐 실행하지 않는다(JDK 계약). 겹침은 @Async 조합 시의 문제.
- **"fixedDelay 5분 작업이 6분 걸리면?"** — 종료 기준이므로 실행 간격이 11분꼴이 될 뿐 겹치지 않는다. 주기 보장이 중요하면 fixedRate + 멱등성/락.
- **"서버 2대인데 배치가 두 번 돌았다"** — ShedLock 분산 락 또는 배치 인스턴스 분리. cron 표기 시간대(`zone` 속성)도 함께 점검.
- **"@Scheduled 메서드에 @Transactional 붙이면?"** — 스케줄러 스레드에서 프록시를 거쳐 정상 적용된다(자기 호출 아님). 단 긴 트랜잭션이면 커넥션 점유 시간 문제는 그대로(`hikaricp-connection-pool-exhaustion.md`).

## 한 줄 요약

`@Scheduled`의 기본값은 "스레드 1개를 전 작업이 공유"라서 한 작업의 블록이 무관한 작업 전체를 밀리게 한다 — 풀 확장·@Async 분리·스케줄러 분리로 격리하되, 병렬화가 만드는 같은 작업 중복 실행(fixedDelay vs fixedRate + @Async 함정)과 다중 인스턴스 동시 실행(ShedLock)까지 막아야 완성이다.
