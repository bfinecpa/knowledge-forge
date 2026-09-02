# 애플리케이션 시작 시간이 갑자기 길어졌을 때 — 추적과 개선

> 핵심 관전 포인트: **기동 시간은 "느리면 불편한 것"이 아니라 운영 지표다 — 롤링 배포 소요 시간, 장애 시 재시작 복구 시간, 오토스케일링이 부하에 반응하는 시간이 전부 기동 시간에 비례해 늘어난다. 진단은 도구가 세 층이고 정밀도 순으로 쓴다. ① 부트 로그의 타임스탬프 간격으로 어느 구간이 벌어졌는지 좁힌다 — 공짜고 이미 남아 있으니 항상 먼저 본다. ② `BufferingApplicationStartup`을 켜고 `/actuator/startup`으로 빈 단위 소요 시간을 JSON으로 받는다 — 부트 2.4가 정식 도구로 넣은 기동 프로파일러이고, "어느 빈이 몇 초 먹었는지"를 추측이 아니라 숫자로 특정한다. 단 앱이 결국 뜨긴 해야 쓸 수 있다. ③ 로그가 통째로 침묵하고 앱이 아예 안 뜨는 구간은 기동 중인 프로세스에 스레드 덤프를 떠서 main 스레드가 무엇을 기다리는지 본다 — 컨테이너라면 `kubectl exec`로 `jcmd`, JDK 도구가 없는 슬림 이미지라면 `kill -3`으로 stdout에 뽑아 `kubectl logs`로 회수한다. 범인은 대개 외부 대기(DB 커넥션 확보, DNS, 설정 서버)이거나 스캔·검증 비용(컴포넌트 스캔 범위, JPA 엔티티 메타데이터 대조)이다. 개선에서 반드시 트레이드오프를 말해야 하는 것이 전역 `spring.main.lazy-initialization=true`다 — 기동은 빨라지지만 비용이 첫 요청으로 옮겨가고, 기동 시점에 죽었어야 할 설정 오류가 런타임으로 밀린다. fail-fast를 돈으로 치르는 선택이므로 운영에서는 문제 빈만 선별 지연이 정석이다.**

---

## 0. 질문 + 의도

**질문**: "애플리케이션 시작 시간이 갑자기 길어졌습니다. 어떻게 추적하고 개선하나요?"

**출제 의도**: 시작이 느리면 스케일 아웃 반응과 배포 속도가 함께 느려진다. 빈 초기화 비용을 측정하고 지연(lazy)하는 방법을 아는지 — 잘 안 보는 지표에서 운영 품질을 찾는 시야를 본다.

## 1. 기동 시간이 왜 운영 지표인가, 그리고 진단의 세 층

### 1-1. 전제 — 기동 시간은 세 곳에서 곱해져서 돌아온다

"기동이 30초에서 90초가 됐다"를 "60초 손해"로 읽으면 안 된다. 기동 시간은 운영의 여러 지점에서 **곱해져서** 나타난다. 세 가지만 계산해 보면 체감이 달라진다.

**(1) 롤링 배포 소요 시간.** 쿠버네티스 롤링 업데이트는 새 파드가 readiness를 통과해야 다음 파드를 교체한다. 파드 10개를 `maxSurge: 1, maxUnavailable: 0`으로 하나씩 교체한다면 이렇게 된다.

```
기동 30초일 때 : 10개 × 30초 = 300초 =  5분
기동 90초일 때 : 10개 × 90초 = 900초 = 15분
```

**롤백도 같은 시간이 든다.** 장애 대응 중 "롤백하면 되죠"라고 말했는데 롤백이 15분 걸린다면, 그 15분은 그대로 장애 시간이다. 기동 시간은 곧 **장애를 되돌리는 속도의 상한**이다.

**(2) 장애 시 복구 시간.** 파드가 OOM으로 죽었다고 하자. 서비스가 정상으로 돌아오기까지는 이렇게 걸린다.

```
재스케줄(수 초) + 이미지 pull(캐시되면 0) + 기동 시간 + readiness 첫 통과까지의 주기
```

이 중 사람이 줄일 수 있는 가장 큰 항목이 기동 시간이다. 그리고 **동시에 여러 파드가 죽었다면 전부 이 시간만큼 트래픽을 못 받는다.**

**(3) 오토스케일링 반응 속도.** HPA(Horizontal Pod Autoscaler)는 부하가 오르는 것을 보고 파드를 늘리는데, 새 파드가 실제로 트래픽을 받기까지가 기동 시간이다. 기동이 90초라면 **트래픽이 급증한 뒤 최소 90초 동안은 기존 파드가 초과 부하를 그대로 뒤집어쓴다.** 그 90초 안에 기존 파드가 먼저 무너지면 스케일아웃은 아무 의미가 없다.

**(4) 그리고 임계점이 하나 더 있다.** 쿠버네티스의 `startupProbe`는 "기동에 이만큼까지는 기다려준다"는 예산을 정한다.

```
예산 = failureThreshold × periodSeconds
     = 30 × 10초 = 300초

기동  90초 → 통과
기동 320초 → ★ 예산 초과 → 컨테이너 재시작 → 또 320초 → 또 재시작 ...
             무한 재시작 루프. 서비스가 영영 안 뜬다.
```

기동 시간이 조용히 늘어나다가 이 선을 넘는 순간, 증상은 "조금 느림"이 아니라 **"배포가 아예 안 됨"** 으로 급변한다. 그래서 기동 시간은 평소에 추세를 봐야 하는 지표다.

### 1-2. 진단의 세 층 — 정밀도 순으로 올라간다

기동 지연 진단에는 성격이 다른 세 가지 도구가 있고, 각각 쓸 수 있는 조건과 정밀도가 다르다.

| 층 | 도구 | 정밀도 | 쓸 수 있는 조건 |
|---|---|---|---|
| ① | 부트 로그 타임스탬프 | 구간 단위(수 초~수십 초) | 항상. 이미 남아 있다 |
| ② | `BufferingApplicationStartup` + `/actuator/startup` | 빈 단위(ms) | 코드 수정 후 재배포 필요, 앱이 결국 떠야 함 |
| ③ | 기동 중 스레드 덤프 | 스택 한 줄 단위 | 프로세스에 접근 가능해야 함. **앱이 안 떠도 된다** |

순서는 이렇게 잡는다.

```
로그를 본다 (①)
   │
   ├─ 벌어진 구간이 특정된다 → ②로 정밀 계측 → 범인 빈 확정
   │
   └─ 로그가 통째로 침묵한다 → ③ 스레드 덤프
                               (앱이 아예 안 뜨는 경우도 여기)
```

**②를 ③보다 앞에 두는 이유가 있다.** 스레드 덤프는 "지금 이 순간 무엇을 기다리는가"의 스냅샷이라 침묵 구간에 강하지만, 순간 포착이라 짧은 비용이 여러 개 쌓인 경우(빈 300개가 각각 200ms씩)는 잡지 못한다. `/actuator/startup`은 **전 기동 구간의 모든 단계를 빠짐없이 계측**하므로 그런 경우까지 잡는다. 앱이 결국 뜨기만 한다면 ②가 훨씬 정확한 답을 준다.

### 1-3. ① 부트 로그 — "읽는" 게 아니라 "간격을 보는" 것이다

기동 로그를 볼 때 흔한 실수는 에러 메시지를 찾는 것이다. 기동 지연에는 에러가 없다. 봐야 하는 것은 **어느 두 줄 사이가 벌어졌는가**다.

```
10:00:01.123  ... HikariPool-1 - Starting...
10:00:01.456  ... HikariPool-1 - Start completed.        # 정상: 333ms
10:00:01.500  ... Initializing JPA EntityManagerFactory
10:01:02.789  ... Initialized JPA EntityManagerFactory   # ← 61.3초. 여기가 범인 구간
10:01:02.900  ... Tomcat started on port 8080
10:01:03.010  ... Started ShopApplication in 62.4 seconds (process running for 63.1)
```

마지막 줄의 두 숫자도 정보를 준다. 앞의 `62.4 seconds`는 **스프링 컨텍스트가 준비되기까지**, 괄호 안의 `process running for 63.1`은 **JVM 프로세스가 뜬 뒤 흐른 총 시간**이다. 둘의 차이가 크다면(예: 20초 vs 45초) 스프링이 아니라 **JVM 자체의 기동**(클래스 로딩, 자바 에이전트, JAR 압축 해제)이 범인이다. 이 구분을 놓치면 스프링 설정만 붙들고 헤매게 된다.

**범인 계열별 로그 시그니처를 알아두면 구간 하나만 보고도 방향을 잡는다.**

**(a) DB 커넥션 확보 대기** — 풀 시작 로그 뒤가 길게 비거나, 예외로 끝난다.
```
10:00:01.100 ... HikariPool-1 - Starting...
                                                    ← 30초 침묵
10:00:31.240 ... HikariPool-1 - Exception during pool initialization.
                 java.net.SocketTimeoutException: connect timed out
```

**(b) DNS 조회 지연** — 별도의 로그가 아예 없다. DNS는 커넥션을 여는 과정 안에서 일어나므로 (a)와 똑같이 보인다. **로그로는 (a)와 (b)를 구분할 수 없다.** 이것이 스레드 덤프가 필요한 대표적 경우다.

**(c) 외부 설정 서버 대기** — Spring Cloud Config를 쓰면 기동 맨 앞에서 설정을 받아오는데, 여기서 막히면 스프링 배너가 찍히기도 전에 멈춘다.
```
10:00:00.900 ... Fetching config from server at : http://config-server:8888
                                                    ← 침묵
10:00:31.200 ... Could not locate PropertySource, failFast=false, ignoring
```
시크릿 매니저(AWS Secrets Manager, Vault) 호출도 성격이 같다. 로그가 없다면 더 나쁘다.

**(d) 컴포넌트 스캔 과다** — "Starting" 직후부터 첫 인프라 로그까지의 구간이 부푼다.
```
10:00:00.500 ... Starting ShopApplication using Java 21
                                                    ← 이 구간이 8초 (정상은 1초 미만)
10:00:08.700 ... Bootstrapping Spring Data JPA repositories in DEFAULT mode.
```

**(e) JPA 엔티티 스캔과 스키마 검증** — EntityManagerFactory 초기화 구간이 부푼다. `ddl-auto: validate`면 여기에 테이블마다 JDBC 메타데이터 조회가 붙는다.
```
10:00:01.500 ... Initializing JPA EntityManagerFactory
10:00:01.800 ... HHH000412: Hibernate ORM core version 6.6.x
                                                    ← 60초
10:01:02.789 ... Initialized JPA EntityManagerFactory
```

**(f) DB 마이그레이션** — Flyway/Liquibase 로그 사이가 벌어진다. 이건 원인이 명확히 찍혀서 오히려 진단이 쉽다.
```
10:00:02.100 ... Migrating schema "public" to version 214 - add index on orders
10:03:41.550 ... Successfully applied 1 migration (execution time 03:39.450s)
```

**(g) 엔트로피 부족** — 컨테이너에서 종종 나오는 특이 케이스다. 톰캣이 세션 ID 생성용 난수 생성기를 초기화할 때 OS의 엔트로피 풀이 비어 있으면 그대로 블록된다.
```
10:00:05.100 ... Creation of SecureRandom instance for session ID generation
                 using [SHA1PRNG] took [5,013] milliseconds.
```
이 줄은 **문제를 스스로 신고하는 드문 로그**다. 보이면 바로 잡을 수 있다.

### 1-4. ② `BufferingApplicationStartup`과 `/actuator/startup` — 빈 단위로 특정한다

로그로 구간을 좁혔다면 그다음은 **그 구간 안에서 정확히 어느 빈이 시간을 먹었는지**다. 여기에 부트 2.4가 도입한 정식 도구가 있다.

먼저 개념부터. **`ApplicationStartup`은 스프링 컨테이너가 기동하면서 밟는 각 단계(빈 하나를 만든다, 설정 하나를 처리한다)에 시작·종료 시각을 찍게 해주는 계측 인터페이스**다. 기본 구현은 아무것도 기록하지 않는다(오버헤드 0). **`BufferingApplicationStartup`은 그 단계 기록을 메모리 버퍼에 쌓아두는 구현체**이고, 쌓인 것을 `/actuator/startup` 엔드포인트로 꺼내 본다.

로그와 결정적으로 다른 점이 이것이다. **로그는 개발자가 로그 문장을 넣어둔 지점에서만 시간을 알 수 있다.** 남의 라이브러리 빈이 5초를 먹었다면 로그에 아무것도 안 남는다. `ApplicationStartup`은 **컨테이너가 밟는 모든 단계에 자동으로 시간을 찍으므로** 로그가 없는 곳도 보인다.

```java
public static void main(String[] args) {
    SpringApplication app = new SpringApplication(ShopApplication.class);
    // 2048 = 버퍼가 담을 최대 스텝 수. 빈이 많은 앱은 넘칠 수 있으니
    // 응답의 스텝 수가 이 값에 딱 붙으면 늘려서 다시 뜬다.
    app.setApplicationStartup(new BufferingApplicationStartup(2048));
    app.run(args);
}
```

```yaml
management:
  endpoints:
    web:
      exposure:
        # startup을 노출한다. 기동 정보는 내부 구조를 드러내므로
        # 상시 노출하지 말고 진단 기간에만 열거나 관리 포트 뒤에 둔다.
        # 노출 기준은 30-actuator-endpoints-security.md 를 따른다.
        include: health, startup
```

호출 방법이 두 가지이고, **차이를 아는 것이 실무에서 중요하다.**

```bash
# GET: 지금까지 버퍼에 쌓인 것의 스냅샷. 버퍼를 비우지 않으므로 몇 번이든 다시 볼 수 있다.
curl -s http://localhost:8080/actuator/startup

# POST: 버퍼에서 꺼내오면서 비운다. 두 번째 호출부터는 내용이 비어 있다.
curl -s -X POST http://localhost:8080/actuator/startup
```

처음에 POST로 호출했다가 "다시 보려니 비어 있다"로 당황하는 것이 흔한 실수다. **조사 중에는 GET을 쓴다.**

응답은 이런 모양이다.

```json
{
  "springBootVersion": "3.4.1",
  "timeline": {
    "startTime": "2026-09-02T01:10:22.123Z",
    "events": [
      {
        "startupStep": {
          "name": "spring.beans.instantiate",
          "id": 122,
          "parentId": 12,
          "tags": [ { "key": "beanName", "value": "entityManagerFactory" } ]
        },
        "startTime": "2026-09-02T01:10:23.001Z",
        "endTime":   "2026-09-02T01:11:24.512Z",
        "duration":  "PT1M1.511S"
      }
    ]
  }
}
```

`duration`이 ISO-8601 문자열(`PT1M1.511S` = 1분 1.511초)이라 눈으로 정렬하기 어렵다. 초 단위로 바꿔 정렬하면 범인이 바로 나온다.

```bash
curl -s http://localhost:8080/actuator/startup \
  | jq -r '.timeline.events[]
           | [ (.duration | ltrimstr("PT") | rtrimstr("S") | tonumber? // 0),
               .startupStep.name,
               ([.startupStep.tags[]? | select(.key=="beanName") | .value] | join(",")) ]
           | @tsv' \
  | sort -rn | head -20
```

주요 스텝 이름만 알아두면 결과를 읽기 쉽다.

- `spring.beans.instantiate` — 빈 하나를 만드는 데 걸린 시간. `beanName` 태그로 어느 빈인지 나온다.
- `spring.context.config-classes.parse` — `@Configuration` 클래스 파싱
- `spring.context.component-classes.scan` — 컴포넌트 스캔
- `spring.boot.application.starting` / `.ready` — 전체 구간의 시작과 끝

**이 도구의 한계도 정확히 알아야 한다.**

- **미리 켜 둬야 한다.** 코드에 `setApplicationStartup`을 넣고 재배포해야 하므로, "지금 느린 그 프로세스"에는 소급 적용할 수 없다.
- **앱이 결국 떠야 한다.** `/actuator/startup`은 HTTP 엔드포인트다. 기동이 끝나지 않으면 웹 서버 자체가 안 떠서 호출할 수 없다. **기동이 아예 안 끝나는 경우는 다음 절의 스레드 덤프 영역이다.**
- **메모리를 쓴다.** 버퍼가 스텝 객체를 들고 있으므로, 진단이 끝나면 빼는 것이 기본이다. 상시 켜 두겠다면 필터로 관심 스텝만 남긴다.
  ```java
  // 빈 생성 스텝만 남겨 버퍼 사용량을 줄인다.
  var startup = new BufferingApplicationStartup(2048);
  startup.addFilter(step -> step.getName().startsWith("spring.beans"));
  app.setApplicationStartup(startup);
  ```

### 1-5. ③ 기동 중 스레드 덤프 — 로그가 침묵하는 구간의 유일한 답

로그가 1분 동안 아무것도 안 찍는다면 그 1분은 로그를 백 번 봐도 답이 없다. **아직 살아서 무언가를 기다리고 있는 프로세스에 직접 물어보는 수밖에 없다.** 그것이 스레드 덤프다.

**스레드 덤프는 그 순간 JVM 안의 모든 스레드가 각각 어느 코드 줄에 있는지를 통째로 찍어낸 스냅샷**이다. 기동 중이라면 `main` 스레드 하나만 보면 된다 — 기동은 main이 순차적으로 진행하기 때문이다.

```
"main" #1 prio=5 os_prio=31 tid=0x... nid=0x2503 runnable [0x000070000...]
   java.lang.Thread.State: RUNNABLE
     at java.base/sun.nio.ch.Net.poll(Native Method)          # ← 소켓 응답 대기
     at java.base/sun.nio.ch.NioSocketImpl.park(...)
     at org.postgresql.core.PGStream.receiveChar(...)         # ← DB 응답을 기다리는 중
     at org.postgresql.jdbc.PgConnection.<init>(...)
     at com.zaxxer.hikari.pool.HikariPool.checkFailFast(...)  # ← 첫 커넥션 확보 단계
     at org.springframework.boot...DataSourceInitializer...
```

**스택만 보면 범인 계열이 즉시 갈린다.**

| 스택에 보이는 것 | 범인 |
|---|---|
| 소켓 read/connect + JDBC 드라이버 | DB 연결 또는 응답 지연 |
| `InetAddress.getByName`, `Inet6AddressImpl.lookupAllHostAddr` | DNS 조회 지연 |
| HTTP 클라이언트 스택(`HttpClient`, `RestTemplate`) | `@PostConstruct` 등에서 외부 API 호출 대기 |
| `SecureRandom`, `NativePRNG` | 엔트로피 부족 |
| 특정 빈의 생성자나 `afterPropertiesSet` | 그 빈의 초기화 로직 자체 |
| `ClassLoader.loadClass`가 계속 다른 클래스로 바뀜 | 스캔·클래스 로딩 자체가 비용 |

**핵심 요령: 한 번만 뜨면 안 된다.** 3~5초 간격으로 2~3회 떠서 비교한다. 스택이 계속 같은 자리에 있으면 그곳에서 **막혀 있는 것**이고, 스택이 매번 바뀌면 막힌 게 아니라 **할 일이 많은 것**(스캔·클래스 로딩)이다. 이 둘은 처방이 완전히 다르다.

**어떻게 뜨는가 — 환경별로 정리한다.**

**(1) 로컬이나 VM에서 직접.** JDK 8 이상이면 `jcmd`가 표준이다.

```bash
# ① 대상 PID 찾기 (셋 중 아무거나)
jcmd -l | grep -i shop        # JVM만 나열해 준다
jps -l
pgrep -f 'java.*shop'

# ② 3초 간격 3회 떠서 파일로 남긴다
for i in 1 2 3; do
    jcmd $PID Thread.print > "/tmp/td-$i.txt"
    sleep 3
done

# jstack도 같은 일을 한다. -l 은 보유 중인 락 정보까지 붙여준다.
jstack -l $PID > /tmp/td-lock.txt
```

**(2) 쿠버네티스 컨테이너 안.** `kubectl exec`로 같은 컨테이너 안에서 실행한다. **같은 컨테이너여야 한다** — JVM에 attach하려면 프로세스 네임스페이스를 공유해야 하기 때문이다.

```bash
# 컨테이너의 java 프로세스는 보통 PID 1이다
kubectl exec -it shop-7d9f-abcde -- jcmd 1 Thread.print

# PID가 1이 아닌 경우(entrypoint 스크립트가 감싼 구조 등)
kubectl exec -it shop-7d9f-abcde -- sh -c 'jcmd $(pgrep -f java | head -1) Thread.print'

# 파일로 받아두려면 리다이렉트한다
kubectl exec shop-7d9f-abcde -- jcmd 1 Thread.print > td-1.txt
```

**(3) 이미지에 JDK 도구가 없을 때.** 여기가 실무에서 진짜 막히는 지점이다. 이미지 크기를 줄이려고 JRE 베이스(`eclipse-temurin:21-jre`)를 쓰면 `jcmd`도 `jstack`도 없다. distroless 이미지라면 셸조차 없다. **해법이 네 가지 있고, 급할 때 쓸 수 있는 순서로 놓으면 이렇다.**

**(3-a) `kill -3` — 도구도 셸 한 줄이면 되고, 가장 먼저 시도할 것.** JVM은 SIGQUIT(3번 시그널)을 받으면 스레드 덤프를 **표준 출력에 찍는다.** 이건 JVM 내장 기능이라 외부 도구가 전혀 필요 없다.

```bash
kubectl exec shop-7d9f-abcde -- kill -3 1

# 덤프는 컨테이너 stdout으로 나가므로 로그로 회수한다
kubectl logs shop-7d9f-abcde --tail=500
```

프로세스를 죽이는 게 아니라는 점을 확인해 두자. SIGQUIT는 이름과 달리 JVM에서는 "덤프 찍어라"로 해석되며, 앱은 그대로 돈다.

**(3-b) JDK 베이스 이미지로 바꾼다.** 진단이 잦은 서비스라면 아예 `eclipse-temurin:21-jdk`로 올린다. 이미지가 수십 MB 커지는 대신 `jcmd`, `jstack`, `jmap`, `jfr`을 전부 쓸 수 있다. **"운영 이미지에 진단 도구를 넣을 것인가"는 크기와 진단 가능성 사이의 설계 판단**이고, 대부분의 팀에서는 진단 가능성 쪽이 이긴다.

**(3-c) `jattach`를 밀어 넣는다.** JVM attach 기능만 담은 의존성 없는 단일 정적 바이너리다. 이미지를 안 바꾸고 그때그때 복사해 쓸 수 있다.

```bash
kubectl cp ./jattach shop-7d9f-abcde:/tmp/jattach
kubectl exec shop-7d9f-abcde -- /tmp/jattach 1 threaddump
```

**(3-d) 임시 디버그 컨테이너를 붙인다.** 셸이 아예 없는 distroless라면 이 방법뿐이다. `--target`으로 대상 컨테이너를 지정해야 **프로세스 네임스페이스를 공유**해서 attach가 된다.

```bash
kubectl debug -it shop-7d9f-abcde \
  --image=eclipse-temurin:21-jdk --target=app -- jcmd 1 Thread.print
```

**(4) 왜 `/actuator/threaddump`를 안 쓰는가.** actuator에도 스레드 덤프 엔드포인트가 있다([30-actuator-endpoints-security.md](30-actuator-endpoints-security.md)). 하지만 그것은 **HTTP 엔드포인트**다. 지금 진단하려는 상황은 **기동이 안 끝나 웹 서버가 아직 안 뜬 상태**이므로 호출할 대상 자체가 없다. 기동 지연 진단에서 actuator가 아니라 OS/JVM 레벨 도구를 쓰는 이유가 이것이다.

같은 도구를 장애 중 커넥션 점유 스레드를 찾을 때도 쓴다 — [26-hikaricp-connection-pool-exhaustion.md](26-hikaricp-connection-pool-exhaustion.md)의 "피해자 vs 용의자" 구분과 방법론이 같다.

### 1-6. AI에게 분석을 맡길 때 — 무엇을 떠서 줄 것인가

"AI에게 로그를 주고 분석시킨다"는 답 자체는 현대적 워크플로로 유효하다. 다만 여기에 반드시 붙어야 하는 단서가 있다.

**AI는 준 데이터만큼만 진단한다.** 침묵 구간은 로그를 아무리 많이 줘도 답이 없다 — 데이터 자체에 그 구간의 정보가 없기 때문이다. 로그만 던지고 "왜 느리냐"고 물으면 AI는 일반적인 체크리스트를 되돌려줄 뿐이다.

그래서 답은 이렇게 구성한다. **"타임스탬프가 살아 있는 전체 기동 로그 + `/actuator/startup` JSON + 침묵 구간에 3회 뜬 스레드 덤프를 붙여서 묻는다."** 세 자료가 서로를 보완하기 때문이다 — 로그는 구간을, startup은 빈 단위 비용을, 스레드 덤프는 막힌 지점을 알려준다.

**무엇을 떠서 줄지 아는 것이 곧 진단 역량이고, 면접이 확인하려는 것도 그것이다.** 도구를 쓸 줄 아느냐가 아니라, 답이 어느 데이터에 있는지를 아느냐다.

## 2. 흔한 범인 — 원인 → 확인법 → 처방

### 2-1. 컴포넌트 스캔 범위 과다

**원인.** `@SpringBootApplication`은 그 클래스가 있는 패키지와 하위 전체를 스캔한다. 그런데 메인 클래스를 `com` 같은 최상위 패키지에 두거나, `@ComponentScan(basePackages = "com")`처럼 넓게 지정하면 **클래스패스에 있는 라이브러리 패키지까지 전부 스캔 대상**이 된다. 의존성 하나 추가한 것이 스캔 대상 수만 클래스 증가로 이어지는 구조다.

여기서 자주 놓치는 것이 있다. 부트는 스캔 속도를 위해 `META-INF/spring.components` 인덱스를 쓸 수 있지만(`spring-context-indexer`), **인덱스가 없으면 클래스 파일을 하나씩 열어 애노테이션을 읽는다.** 대상이 수만 개면 그 자체가 수 초다.

**확인법.**
- 로그에서 "Starting ..." 부터 첫 인프라 초기화 로그 사이의 간격을 본다. 정상은 1초 미만이다.
- `/actuator/startup`에서 `spring.context.component-classes.scan`과 `spring.context.config-classes.parse` 스텝의 소요 시간을 본다.
- 스레드 덤프의 `main` 스택에 `ClassPathScanningCandidateComponentProvider`나 `ClassLoader.loadClass`가 계속 다른 클래스로 바뀌며 나타난다.
- `--debug` 옵션으로 띄우면 auto-configuration 평가 리포트가 출력된다. `/actuator/conditions`로도 같은 정보를 본다.

**처방.**
```java
// before: 최상위 패키지에 메인 클래스 — com 아래 전부(라이브러리 포함)를 스캔한다
package com;

@SpringBootApplication
public class ShopApplication { }

// after: 우리 코드의 루트 패키지에 둔다. 스캔 범위가 우리 코드로 한정된다.
package com.daou.shop;

@SpringBootApplication
public class ShopApplication { }

// 여러 루트를 스캔해야 한다면 필요한 것만 명시한다.
// "com" 같은 넓은 값을 넣지 않는 것이 요점이다.
@SpringBootApplication(scanBasePackages = { "com.daou.shop", "com.daou.common.audit" })
public class ShopApplication { }
```

쓰지 않는 auto-configuration을 끄는 것도 같은 계열의 처방이다.
```java
@SpringBootApplication(exclude = { SecurityAutoConfiguration.class })
```

### 2-2. DB 커넥션 확보 대기

**원인.** HikariCP는 기동 시 **커넥션을 하나 만들어 연결이 되는지 확인한다**(`checkFailFast`). 이 한 개를 못 얻으면 기동이 그 자리에서 막힌다. 연결이 안 되는 상황(방화벽에 막힘, DNS 실패, DB 과부하)에서는 `connection-timeout`(기본 30초)만큼 기다린 뒤에야 다음으로 넘어간다.

**여기서 통념 하나를 정정해 둘 필요가 있다.** "풀 크기(`minimumIdle`)만큼 커넥션을 미리 만드느라 느리다"는 말이 흔한데, **HikariCP는 기동 시 동기적으로 하나만 만든다.** 나머지는 하우스키퍼 스레드가 백그라운드에서 `minimumIdle`까지 채운다. 그래서 기동을 붙잡는 것은 "개수"가 아니라 **"첫 한 개를 얻는 데 걸리는 시간"** 이다. 반면 Tomcat JDBC Pool이나 Commons DBCP2는 `initialSize`만큼을 기동 시 실제로 만들므로, 그쪽 풀을 쓴다면 개수도 비용이 된다. **어느 풀을 쓰는지에 따라 답이 다르다.**

**확인법.** `HikariPool-1 - Starting...` 뒤의 간격을 본다. 스레드 덤프에서 `HikariPool.checkFailFast`와 드라이버의 소켓 스택이 함께 보이면 확정이다.

**처방.**
```yaml
spring:
  datasource:
    hikari:
      # 첫 커넥션을 못 얻을 때 기다리는 시간. 기본 30초는 기동 관점에서 길다.
      # 어차피 못 붙을 상황이라면 빨리 실패해서 재시작 사이클을 돌리는 편이 낫다.
      connection-timeout: 5000
      # 음수로 두면 기동 시 커넥션 검증 자체를 건너뛴다. 기동은 빨라지지만
      # DB가 죽은 채로 앱이 UP으로 뜨게 되므로 fail-fast를 버리는 선택이다.
      # 켜기 전에 readiness probe가 DB를 확인하는지부터 확인할 것.
      initialization-fail-timeout: 1
```
근본 처방은 네트워크 경로 자체다. 보안그룹·방화벽 규칙, DB 엔드포인트 주소, VPC 피어링을 먼저 확인한다. 설정으로 타임아웃을 줄이는 것은 **증상을 빨리 드러내는 것**이지 원인을 없애는 것이 아니다.

### 2-3. DNS 조회 지연

**원인.** 호스트 이름을 IP로 바꾸는 과정이 느리거나 실패한다. 컨테이너 환경에서 특히 잦은데, 쿠버네티스의 `ndots` 기본값(5) 때문에 **점이 5개 미만인 호스트 이름은 검색 도메인을 차례로 붙여 여러 번 조회**하기 때문이다. `db.internal`을 찾으려고 `db.internal.default.svc.cluster.local`, `db.internal.svc.cluster.local`, `db.internal.cluster.local`을 먼저 시도한 뒤에야 원래 이름을 조회한다. DNS 서버가 느리면 이 헛발질이 곱해진다.

역방향 조회(IP에서 이름 찾기)가 붙으면 더 나빠진다. 일부 드라이버와 로깅 설정이 이걸 한다.

**확인법.** 로그로는 안 보인다. **스레드 덤프에서 `InetAddress.getByName`이나 `Inet6AddressImpl.lookupAllHostAddr`이 보이면 확정**이다. 이것이 "로그로는 DB 지연과 DNS 지연을 구분할 수 없다"는 앞 절의 말이 실제로 쓰이는 지점이다.

**처방.** 조회 횟수를 줄이거나 캐시를 늘린다.
```yaml
# 파드 스펙: 완전한 이름(끝의 점 포함)을 쓰거나 ndots를 낮춘다
dnsConfig:
  options:
    - name: ndots
      value: "2"
```
```
# JVM: 성공한 조회 결과의 캐시 시간(초). -1은 영구 캐시.
-Dsun.net.inetaddr.ttl=60
```
연결 대상이 고정 IP라면 아예 IP로 지정하는 것도 유효한 선택이다. 다만 IP가 바뀌는 환경이라면 그게 더 큰 문제를 만든다.

### 2-4. JPA 엔티티 스캔과 스키마 검증

**원인.** 두 가지가 겹친다. 첫째, 엔티티 수가 늘면 Hibernate가 메타데이터를 만드는 시간이 선형으로 늘어난다. 둘째, `ddl-auto: validate`는 **엔티티마다 실제 DB에 테이블·컬럼 구조를 조회해 대조**한다. 테이블 300개면 JDBC 메타데이터 조회가 그만큼 돈다. DB가 원격이면 왕복 지연까지 곱해진다.

**확인법.** `Initializing JPA EntityManagerFactory`와 `Initialized JPA EntityManagerFactory` 사이의 간격이 곧 이 비용이다. `/actuator/startup`에서는 `entityManagerFactory` 빈의 `spring.beans.instantiate` 스텝으로 잡힌다.

**처방.** 여기서 조심할 것이 있다. **`ddl-auto: validate`를 끄는 것은 안전망을 버리는 일**이다. 엔티티와 스키마가 어긋난 채로 앱이 뜨고, 그 불일치는 해당 쿼리가 처음 실행되는 런타임에야 터진다.

그래서 순서는 이렇다.
1. **먼저 실제로 얼마나 걸리는지 잰다.** 대개 수백 ms~수 초다. 이 정도라면 안전망 값어치가 더 크므로 그냥 둔다.
2. 정말 문제가 될 만큼 크다면(테이블 수백 개 + 원격 DB), **검증을 기동이 아니라 CI로 옮긴다.** 배포 파이프라인에서 스키마 검증 테스트를 돌리면 안전망은 유지하면서 기동에서는 뺄 수 있다.
3. Hibernate 메타데이터 자체가 무겁다면 사용하지 않는 엔티티를 정리한다.

**"느리니까 끈다"가 아니라 "안전망을 다른 곳으로 옮긴다"가 답의 형태여야 한다.**

### 2-5. 외부 설정 서버와 시크릿 매니저

**원인.** Spring Cloud Config, Vault, AWS Secrets Manager 등은 **기동의 맨 앞**(설정을 읽는 단계)에서 호출된다. 여기가 막히면 스프링 배너조차 안 나오고 침묵한다. 그리고 이런 클라이언트의 기본 타임아웃과 재시도 설정이 관대한 경우가 많아, 한 번 못 붙으면 수십 초를 그냥 기다린다.

**확인법.** 로그의 맨 앞 구간이 비어 있다. `Fetching config from server at :` 같은 줄이 있다면 그 뒤를 본다. 스레드 덤프에서는 HTTP 클라이언트 스택이 나온다.

**처방.**
```yaml
spring:
  cloud:
    config:
      # 붙지 않으면 빨리 포기하게 만든다
      request-connect-timeout: 3000
      request-read-timeout: 5000
      retry:
        max-attempts: 3
        initial-interval: 1000
      # fail-fast: true 면 설정 서버에 못 붙었을 때 기동을 실패시킨다.
      # 잘못된 설정으로 뜨는 것보다 안 뜨는 게 나은 경우에 켠다.
      fail-fast: true
```
`fail-fast: true`가 여기서는 **기동을 더 느리게 만드는 게 아니라 빨리 죽게 만드는** 설정이라는 점에 주의한다. 애매하게 기본값으로 떠서 나중에 엉뚱한 DB에 붙는 것보다 낫다는 판단이다([09-application-yml-profile.md](09-application-yml-profile.md)의 논지와 같다).

### 2-6. `@PostConstruct`의 무거운 작업

**원인.** 빈 초기화 콜백에서 캐시를 예열하거나, 외부 API를 부르거나, 대량 조회를 한다. 이 작업들은 **기동을 붙잡고 있을 이유가 없는데도** 기동 경로에 들어와 있다.

**확인법.** `/actuator/startup`에서 특정 빈의 `spring.beans.instantiate` 스텝이 튄다. 스레드 덤프에는 그 빈의 클래스 이름이 스택에 직접 보인다.

**처방.** 3-2에서 다룬다 — 기동 경로에서 빼내 `ApplicationReadyEvent` 이후로 옮긴다.

### 2-7. DB 마이그레이션 누적

**원인.** Flyway/Liquibase가 기동 시 마이그레이션을 적용한다. 대형 테이블에 인덱스를 추가하는 스크립트 하나가 몇 분을 먹을 수 있다.

**확인법.** 마이그레이션 로그에 각 스크립트의 실행 시간이 찍히므로 진단은 쉽다.

**처방.** 오래 걸리는 DDL은 애플리케이션 기동에서 분리해 배포 파이프라인의 별도 단계로 돌린다. 특히 **롤링 배포 중이라면 파드 여러 개가 동시에 마이그레이션을 시도**하게 되므로(락으로 직렬화되며 뒤의 파드는 그만큼 더 기다린다) 분리가 더 중요해진다. PostgreSQL이라면 `CREATE INDEX CONCURRENTLY`로 테이블 락 없이 인덱스를 만드는 선택지도 있다.

### 2-8. "갑자기"라는 단어를 놓치지 않는다

마지막이 가장 실용적이다. 질문은 "느리다"가 아니라 **"갑자기 길어졌다"** 이다. 이건 **회귀(regression)** 이고, 회귀에는 항상 원인이 된 변경이 있다.

그래서 위의 어느 계열을 파기 전에 **그 사이에 바뀐 것부터 목록으로 만든다.**

- 의존성 추가·업그레이드 (스캔 대상 증가, auto-configuration 후보 증가)
- 엔티티·테이블 추가 (2-4)
- 마이그레이션 스크립트 추가 (2-7)
- 인프라 변경 — DNS 설정, 보안그룹, DB 위치, 노드 타입(CPU 성능이 곧 클래스 로딩 속도다)
- 설정 변경 — 프로파일, 커넥션 풀 값, 외부 설정 서버 도입

`Started ... in N seconds` 값을 배포마다 지표로 수집해 두면 **어느 배포에서 튀었는지가 그래프로 바로 보인다.** 이게 있으면 진단이 몇 시간에서 몇 분으로 줄어든다. 없다면 이번 기회에 만드는 것이 재발 방지의 본체다.

## 3. 개선 — 그리고 각각이 무엇을 대가로 치르는가

### 3-1. 무거운 초기화를 첫 사용 시점으로 미룬다

특정 빈 하나가 오래 걸리고 그 빈이 모든 요청에 필요한 게 아니라면, `@Lazy`로 첫 사용 시점까지 생성을 미룬다.

```java
// before: 컨테이너 기동 시 무조건 만들어진다. 관리자만 쓰는 기능인데도.
@Component
public class ReportTemplateCache {
    @PostConstruct
    void warmUp() { /* 템플릿 2만 건 로딩 — 8초 */ }
}

// after: 이 빈을 실제로 주입받아 쓰는 순간 만들어진다.
// 관리자 리포트 화면을 처음 여는 사람만 8초를 부담한다.
@Component
@Lazy
public class ReportTemplateCache { ... }
```

**대가**: 첫 사용자가 그 비용을 부담한다. 그리고 그 빈의 초기화가 실패한다면 **기동이 아니라 그 첫 요청에서 터진다.** 관리자 기능처럼 사용자가 한정되고 지연을 감수할 수 있는 경로에는 적합하지만, 결제처럼 모든 사용자가 지나는 경로에는 부적합하다.

### 3-2. 예열은 기동이 아니라 기동 직후로 옮긴다

`@PostConstruct`에 있는 캐시 예열이나 원격 호출은 대개 **"기동 전에 끝나야 하는 일"이 아니라 "빨리 하면 좋은 일"** 이다. 그렇다면 기동 경로에서 빼내면 된다.

```java
// before: 기동을 20초 붙잡는다
@Component
public class PriceCacheWarmer {
    @PostConstruct
    void warmUp() { priceCache.loadAll(); }   // 20초
}

// after: 서버가 먼저 뜨고, 예열은 뒤에서 별도 스레드로 돈다
@Component
public class PriceCacheWarmer {
    // ApplicationReadyEvent = 컨텍스트가 완전히 준비되고 웹 서버까지 뜬 뒤 발행되는 이벤트.
    // 이 시점이면 이미 요청을 받을 수 있는 상태다.
    @Async
    @EventListener(ApplicationReadyEvent.class)
    void warmUp() { priceCache.loadAll(); }
}
```

`@Async`를 붙인 이유가 중요하다. **`@EventListener`는 기본이 동기 호출**이라, 이것만 붙이면 이벤트를 발행한 스레드가 20초를 기다린다. 기동 로그의 `Started ...` 줄은 먼저 찍히지만 실질적인 준비 완료는 여전히 20초 뒤다. `@Async`로 별도 스레드에 넘겨야 진짜로 분리된다([15-async-annotation.md](15-async-annotation.md)).

**대가**: 서버가 트래픽을 받기 시작한 시점에 캐시가 아직 비어 있다. 예열 중에 들어온 요청은 캐시 미스를 겪는다. 이걸 감당할 수 없다면 **readiness probe가 예열 완료를 확인하도록** 만든다 — 그러면 예열이 끝날 때까지 LB가 트래픽을 안 보낸다. 기동 시간 자체는 그대로지만, **적어도 "준비 안 된 서버가 트래픽을 받는" 사고는 막는다.**

### 3-3. 원인 자체를 제거한다

가장 좋은 처방은 2절의 각 항목에서 본 대로 원인을 없애는 것이다. 스캔 범위를 좁히고, DNS 설정을 고치고, 마이그레이션을 분리하고, 안 쓰는 의존성을 뺀다. **지연이나 비동기화는 비용을 옮기는 것이고, 원인 제거만이 비용을 없앤다.**

### 3-4. 전역 지연 초기화 — 무엇을 대가로 치르는가

`spring.main.lazy-initialization: true`는 **모든 빈을 첫 사용 시점까지 안 만드는** 설정이다. 기동 시간이 극적으로 줄어드는 경우가 많아 검색하면 가장 먼저 나오는 답이기도 하다.

```yaml
spring:
  main:
    lazy-initialization: true
```

**대가가 둘인데, 두 번째가 훨씬 무겁다.**

**(1) 비용이 첫 요청으로 옮겨간다.** 없어진 게 아니라 옮겨간 것이다. 기동 후 처음 들어오는 요청들이 자기가 지나는 경로의 빈을 그때그때 만들면서 느려진다. 오토스케일링으로 새 파드를 띄운 상황이라면 **부하가 몰리는 바로 그 순간에 첫 요청들이 느려진다** — 가장 나쁜 타이밍이다.

**(2) fail-fast를 포기한다. 이것이 핵심이다.**

`fail-fast`는 **"잘못된 것은 최대한 이르고 시끄럽게 실패해야 한다"** 는 원칙이다. 스프링의 기본 동작이 정확히 이렇게 설계돼 있다 — 잘못된 설정, 없는 빈, 타입이 안 맞는 주입은 **기동 시점에 예외를 던지고 앱이 아예 안 뜬다.** 배포가 실패하고 롤백된다. 사용자는 아무 영향도 받지 않는다.

전역 lazy를 켜면 이 구조가 무너진다. 빈을 안 만들었으니 그 빈의 문제도 발견되지 않는다. **기동은 성공하고, 앱은 정상인 척 뜨고, 그 경로를 처음 지나는 사용자 요청에서 500이 난다.**

```
[기본 동작 — fail-fast]
  배포 → 기동 중 예외 → 앱이 안 뜸 → 배포 실패, 롤백
  → 사용자 영향 0. 개발자가 즉시 알아챈다.

[전역 lazy]
  배포 → 기동 성공 → 헬스체크 통과 → 트래픽 유입
  → 그 경로를 처음 지나는 요청에서 500
  → ★ 사용자가 먼저 발견한다 ★
```

이 긴장은 이 저장소의 다른 문서와 정면으로 맞물린다. [29-value-vs-configuration-properties.md](29-value-vs-configuration-properties.md)는 `@ConfigurationProperties` + `@Validated`로 **설정 오류를 기동 시점 실패로 끌어올리는 것**을 이 방식의 결정적 이점으로 든다. [09-application-yml-profile.md](09-application-yml-profile.md)는 프로파일 미지정 시 조용히 엉뚱한 DB에 붙는 대신 **시끄럽게 죽게** 만드는 설계를 권한다. 전역 lazy는 그 두 문서가 애써 만든 것을 반대 방향으로 되돌린다.

**그래서 결론은 이렇다. 전역 lazy는 로컬 개발과 테스트에서는 훌륭한 도구다**(테스트 하나 돌리려고 전 컨텍스트를 만들 필요가 없다). **운영에서는 문제 빈만 골라 `@Lazy`를 붙이는 선별 지연이 정석**이다. 굳이 전역으로 켜야 한다면 최소한 예외를 둔다.

```java
// 특정 빈은 전역 lazy에서 제외해 기동 시점에 만들어지게 한다.
// 스케줄러 등록, 이벤트 리스너, 기동 시 검증되어야 하는 설정 빈이 대상이다.
@Bean
static LazyInitializationExcludeFilter eagerScheduler() {
    return LazyInitializationExcludeFilter.forBeanTypes(SettlementScheduler.class);
}
```

`@Scheduled` 메서드를 가진 빈이나 `@EventListener` 빈은 **생성되어야 등록된다**는 점에 특히 주의한다. 아무도 주입받지 않는 빈이면 영영 안 만들어지고, 스케줄이 조용히 안 도는 사고가 난다.

### 3-5. JVM·플랫폼 레벨의 기동 최적화

여기까지가 "갑자기 느려진 것"을 되돌리는 처방이라면, "원래부터 느린 기동"을 줄이는 별개의 도구들이 있다.

- **CDS(Class Data Sharing)** — 클래스 로딩 결과를 미리 만든 아카이브에서 읽어 클래스 로딩 시간을 줄인다. 스프링 부트 3.3부터 이걸 쉽게 쓰도록 지원이 들어갔다. 코드 변경이 거의 없어 도입 부담이 가장 작다.
- **AOT(Ahead-of-Time) 처리와 GraalVM 네이티브 이미지** — 스프링 부트 3.0부터의 기능이다. 빈 정의 분석 같은 런타임 작업을 빌드 시점으로 옮긴다. 네이티브 이미지는 기동이 수십 ms 수준까지 내려가지만 빌드 시간과 리플렉션 제약이라는 대가가 크다.
- **CRaC(Coordinated Restore at Checkpoint)** — 기동이 끝난 JVM 상태를 스냅샷으로 떠 두고 거기서 복원한다. 스프링 부트 3.2부터 지원한다. 인프라 요구사항이 까다롭다.

**다만 이 질문에 이걸로 답하면 초점이 어긋난다.** 질문은 "갑자기 길어졌다"이고, 이 도구들은 "원래 느린 것"의 처방이다. **회귀의 원인을 찾는 것이 먼저이고, 이건 그다음이다.** 순서를 뒤집으면 원인을 안 고친 채 최적화로 덮는 셈이 된다.

## 4. 꼬리질문 대비 포인트

### "스레드 덤프에서 `main`이 RUNNABLE인데도 안 넘어갑니다"

**`RUNNABLE`이 "CPU를 쓰며 열심히 일하는 중"을 뜻하지 않는다**는 것을 아는지 보는 질문이다.

JVM의 스레드 상태는 자바 레벨의 개념이라, **네이티브 소켓 read처럼 커널에서 대기하는 상황도 `RUNNABLE`로 보인다.** JVM 입장에서는 "OS에 일을 맡겼고 자바 코드로 치면 실행 중"이기 때문이다. `BLOCKED`나 `WAITING`은 자바 모니터 락이나 `Object.wait()`에 걸렸을 때만 나온다.

그래서 **상태 이름이 아니라 스택 내용으로 판단한다.** `sun.nio.ch.Net.poll`, `SocketInputStream.socketRead0` 같은 네이티브 메서드가 최상단에 있으면 그건 대기다.

확인 방법도 함께 말하면 좋다. **3~5초 간격으로 2~3회 떠서 비교한다.** 스택이 같은 자리에 고정돼 있으면 막힌 것이고, 매번 다른 클래스로 바뀌면 막힌 게 아니라 할 일이 많은 것이다. **이 둘은 처방이 완전히 다르다** — 전자는 상대 시스템 문제, 후자는 우리 코드의 양 문제다.

### "운영에서만 느리고 로컬은 빠릅니다"

**환경 차이로 방향을 잡는다.** 코드는 같으므로 코드를 파는 것은 낭비다.

- **네트워크 경로.** 로컬은 DB가 같은 머신이지만 운영은 원격이다. 왕복 지연이 수십 배 차이 나고, 그것이 커넥션 확보와 스키마 검증에서 곱해진다.
- **DNS.** 로컬은 `localhost`나 hosts 파일이라 조회가 없다. 컨테이너 환경의 `ndots` 헛발질(2-3)은 로컬에서 절대 재현되지 않는다.
- **방화벽·보안그룹.** 막힌 포트로의 연결은 거부(즉시 실패)가 아니라 **드롭**(타임아웃까지 대기)되는 경우가 많다. 이게 "아무 로그 없이 30초 침묵"의 대표적 원인이다.
- **외부 의존.** 설정 서버, 시크릿 매니저는 로컬에서 대개 목이나 로컬 파일로 대체된다.
- **CPU 자원.** 컨테이너에 CPU limit이 걸려 있으면 클래스 로딩과 JIT 컴파일이 그만큼 느려진다. 특히 **기동은 CPU를 많이 쓰는 구간**이라 limit의 영향이 크다.
- **프로파일별 빈 구성.** `prod` 프로파일에서만 활성화되는 빈이 있다.

확인 순서는 **스레드 덤프를 운영 환경에서 직접 뜨는 것**이다. 로컬에서 재현하려 애쓰는 것보다 빠르다.

### "쿠버네티스에서 기동이 느려지면 무슨 일이 생기나요?"

**단순히 "배포가 느려진다"가 아니라 임계점이 있다는 것을 말해야 한다.**

`livenessProbe`는 "이 컨테이너 죽었나"를 묻고 실패하면 **재시작**한다. 기동이 이 probe의 예산을 넘기면 **아직 뜨는 중인 앱을 k8s가 죽이고, 다시 뜨는 중에 또 죽이는 무한 루프**에 빠진다. 서비스가 영영 안 뜬다.

해법이 `startupProbe`다. **기동 전용 probe로, 이게 통과하기 전까지는 liveness와 readiness를 아예 평가하지 않는다.** 즉 "기동에는 넉넉히, 기동 후에는 빡빡하게"를 분리해서 줄 수 있다.

```yaml
startupProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  failureThreshold: 30      # 예산 = 10 × 30 = 300초. 기동에는 이만큼 준다.
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3       # 기동 후에는 30초만 못 견뎌도 재시작. 반응이 빨라진다.
```

startupProbe가 없다면 liveness의 `failureThreshold`를 기동 시간에 맞춰 크게 잡아야 하는데, 그러면 **기동 후 진짜 행이 걸렸을 때의 감지도 그만큼 느려진다.** startupProbe는 이 트레이드오프를 없앤다.

probe 종류별 역할 차이는 [liveness-readiness-probe-db-check.md](../15-container-infra/liveness-readiness-probe-db-check.md), 종료 쪽 논의는 [28-graceful-shutdown-zero-downtime-deploy.md](28-graceful-shutdown-zero-downtime-deploy.md)에 있다.

### "전역 `lazy-initialization`을 켜면 되지 않나요?" (시니어 변별 포인트)

**"기동이 빨라지는 대신 무엇을 잃는가"를 말할 수 있는지가 갈림길이다.** 잃는 것이 둘인데, 두 번째가 결정적이다.

첫째, **비용이 사라지는 게 아니라 첫 요청으로 옮겨간다.** 특히 오토스케일링으로 새 파드가 뜬 상황이라면 부하가 몰리는 바로 그 순간에 첫 요청들이 느려진다.

둘째, **fail-fast를 포기한다.** 스프링은 잘못된 빈 구성이나 설정을 기동 시점에 예외로 터뜨려 앱이 아예 안 뜨게 만든다. 배포가 실패하고 롤백되며 **사용자 영향은 0**이다. 전역 lazy를 켜면 빈을 안 만들었으니 문제도 발견되지 않고, 기동은 성공하고, **그 경로를 처음 지나는 사용자 요청에서 500이 난다.** 발견자가 개발자에서 사용자로 바뀐다.

이 대목에서 저장소의 다른 논의와 연결하면 이해의 깊이가 드러난다. `@ConfigurationProperties` + `@Validated`로 설정 오류를 기동 시점 실패로 끌어올리는 것([29-value-vs-configuration-properties.md](29-value-vs-configuration-properties.md)), 프로파일 미지정 시 조용히 뜨는 대신 죽게 만드는 것([09-application-yml-profile.md](09-application-yml-profile.md)) — 전역 lazy는 그렇게 만들어 둔 안전망을 반대 방향으로 되돌린다.

**결론은 "로컬·테스트에서는 켜고, 운영에서는 문제 빈만 선별 지연"이다.** 그리고 `@Scheduled`·`@EventListener`처럼 **생성되어야 등록되는 빈**은 `LazyInitializationExcludeFilter`로 예외를 둬야 조용히 안 도는 사고를 막는다.

### "CDS·AOT·네이티브 이미지 같은 기동 최적화는 어떤가요?"

**질문의 본령을 놓치지 않는 것이 답의 핵심이다.**

이 도구들은 유효하다. CDS는 클래스 로딩 결과를 아카이브에서 읽어 로딩 시간을 줄이고(부트 3.3부터 지원), AOT와 GraalVM 네이티브 이미지는 런타임 작업을 빌드 시점으로 옮기며(부트 3.0부터), CRaC은 기동이 끝난 상태의 스냅샷에서 복원한다(부트 3.2부터).

**그런데 이 질문은 "갑자기 길어졌다"이고, 이 도구들은 "원래 느린 것"의 처방이다.** 원인이 되는 변경(의존성 추가, 엔티티 증가, 인프라 변경)을 안 찾은 채 최적화로 덮으면, 원인은 계속 자라고 최적화가 벌어준 시간을 다시 잡아먹는다.

그래서 답의 순서는 **"먼저 회귀의 원인을 찾아 되돌리고, 그 뒤에도 기동이 서비스 요구(배포 속도, 스케일아웃 반응)에 못 미치면 그때 이 도구들을 검토한다"** 가 된다. 도구를 아는 것보다 **언제 쓰는 도구인지를 아는 것**이 변별점이다.

### "기동 시간을 어떻게 지속적으로 관리하나요?" (시니어 변별 포인트)

**한 번 고치는 것과 다시 안 나게 하는 것은 다른 일이라는 인식을 보이는 질문이다.**

기동 시간은 **조금씩 누적되어 나빠진다.** 의존성 하나, 엔티티 몇 개, 마이그레이션 한 줄이 각각은 0.5초씩이라 아무도 알아채지 못한다. 그러다 어느 날 startupProbe 예산을 넘겨 배포가 안 된다. 즉 이건 사건이 아니라 **추세**이고, 추세는 재보지 않으면 안 보인다.

세 가지를 건다.

1. **지표로 수집한다.** `Started ... in N seconds` 값을 배포마다 기록한다. 부트가 발행하는 `ApplicationStartedEvent`/`ApplicationReadyEvent`에서 값을 뽑아 메트릭으로 내보내면 대시보드에서 추세가 보인다. **어느 배포에서 튀었는지가 그래프로 나오면 진단이 몇 시간에서 몇 분으로 줄어든다.**
2. **임계선을 알림으로 건다.** startupProbe 예산의 절반 같은 선을 넘으면 알린다. 여유가 절반 남았을 때 대응하는 것과 배포가 실패하고 나서 대응하는 것은 난이도가 다르다.
3. **평소에 계측을 켜 둔다.** `BufferingApplicationStartup`을 필터와 함께 상시 켜 두면(1-4), 문제가 생겼을 때 **재배포 없이 그 자리에서** `/actuator/startup`을 찍을 수 있다. 재현을 기다리지 않아도 된다는 것이 이 준비의 값어치다.

---

## 한 줄 요약

기동 시간은 롤링 배포·장애 복구·오토스케일링 반응 속도에 그대로 곱해지는 운영 지표이므로, 진단은 로그 타임스탬프 간격으로 구간을 좁히고(항상 먼저) → `BufferingApplicationStartup` + `/actuator/startup`으로 빈 단위 소요 시간을 특정하고(가장 정밀하되 앱이 결국 떠야 함) → 로그가 침묵하고 앱이 아예 안 뜨는 구간은 `jcmd`나 `kill -3`으로 기동 중 스레드 덤프를 떠 `main`이 무엇을 기다리는지 보는 순서로 하며, 개선은 원인 제거 → 예열의 `ApplicationReadyEvent` 이후 이동 → 선별 `@Lazy` 순이고, 전역 `lazy-initialization`은 비용을 첫 요청으로 옮기고 fail-fast까지 포기하는 선택이라는 트레이드오프를 함께 말해야 답이 완성된다.
