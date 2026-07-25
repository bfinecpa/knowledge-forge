# 애플리케이션 시작 시간이 갑자기 길어졌을 때 — 추적과 개선

> 핵심 관전 포인트: 진단 순서는 ① **부트 로그의 타임스탬프 간격**으로 어느 단계가 벌어졌는지 특정 → ② 로그가 **침묵하는 구간**은 로그로는 답이 안 나오므로 기동 중 프로세스에 **스레드 덤프(jstack)**를 떠서 main 스레드가 어디에 블록돼 있는지 확인(DB 커넥션 대기·DNS·외부 API가 단골) → ③ 재발 방지를 위해 **BufferingApplicationStartup + Actuator `startup` 엔드포인트**로 빈 단위 초기화 타임라인을 계측. 개선은 무거운 초기화의 지연(@Lazy)·비동기화와 예열의 `ApplicationReadyEvent` 이후 이동 — 단 전역 lazy는 fail-fast와 긴장 관계라는 트레이드오프까지 말해야 완성.

## 0. 질문 + 의도

**질문**: "애플리케이션 시작 시간이 갑자기 길어졌습니다. 어떻게 추적하고 개선하나요?"

**출제 의도**: 시작이 느리면 스케일 아웃 반응과 배포 속도가 함께 느려진다. 빈 초기화 비용을 측정하고 지연(lazy)하는 방법을 아는지 — 잘 안 보는 지표에서 운영 품질을 찾는 시야를 본다.

## 1. 진단 순서 — 데이터를 단계적으로 뜬다

### ① 부트 로그: 타임스탬프 간격 분석

로그를 "읽는" 게 아니라 **어느 두 줄 사이가 벌어졌는지**를 본다. 벌어진 지점의 앞줄이 어떤 단계였는지로 범인 계열을 특정한다.

```
10:00:01.123  ... HikariPool-1 - Starting...
10:00:01.456  ... HikariPool-1 - Start completed.        # 정상: 수백 ms
10:00:01.500  ... Initializing JPA EntityManagerFactory
10:01:02.789  ... Initialized JPA EntityManagerFactory   # ← 61초! 여기가 범인 구간
```

### ② 로그 침묵 구간: 기동 중 스레드 덤프

로그가 1분간 아무것도 안 찍는다면 그 1분은 로그를 백 번 봐도 답이 없다. **기동 중인 프로세스에 `jstack <pid>`** — main 스레드의 스택을 보면 무엇을 기다리는지 즉시 드러난다.

```
"main" #1 ... RUNNABLE
   at java.net.SocketInputStream.socketRead0(Native Method)   # ← 소켓 응답 대기
   at com.mysql.cj.protocol.a.NativeProtocol...               # ← DB에 붙는 중
   at com.zaxxer.hikari.pool.HikariPool.checkFailFast(...)
```

- `socketRead`/`connect` + DB 드라이버 스택 → DB 연결·응답 지연
- `InetAddress.getByName` → DNS 조회 지연 (역방향 조회 포함)
- HTTP 클라이언트 스택 → `@PostConstruct`류의 외부 API 호출 대기
- 특정 빈 생성자/`afterPropertiesSet` → 그 빈의 초기화 로직

장애 중 커넥션 점유 스레드를 찾을 때와 같은 도구다 — `hikaricp-connection-pool-exhaustion.md`의 스레드 덤프 활용(피해자 vs 용의자 구분)과 같은 방법론.

### ③ 체계적 계측: BufferingApplicationStartup + `/actuator/startup`

일회성 진단을 넘어 **빈 단위 초기화 시간 타임라인**을 남기려면:

```java
public static void main(String[] args) {
    SpringApplication app = new SpringApplication(MyApplication.class);
    app.setApplicationStartup(new BufferingApplicationStartup(2048)); // 스텝 버퍼
    app.run(args);
}
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, startup   # startup 노출 (보안 주의는 actuator 문서 참조)
```

`POST /actuator/startup` 이 `spring.beans.instantiate` 스텝별 소요 시간을 반환 — 어떤 빈이 몇 ms 먹었는지 정렬해서 보면 된다. 노출 시 보안은 `actuator-endpoints-security.md` 기준을 따른다.

## 2. 흔한 범인

| 계열 | 구체 사례 | 단서 |
|---|---|---|
| 외부 시스템 대기 | DB 커넥션 풀 init 지연, DNS 역방향 조회, 외부 설정 서버 | 스레드 덤프의 socket/connect 스택 |
| `@PostConstruct` 무거운 작업 | 캐시 예열, 원격 API 호출, 대량 조회 | 특정 빈 초기화 구간에서 침묵 |
| JPA/Hibernate 초기화 | 엔티티 수 증가, `ddl-auto: validate`의 스키마 대조 | "Initializing JPA EntityManagerFactory" 구간 팽창 |
| DB 마이그레이션 | flyway/liquibase가 대형 스크립트 실행 | flyway 로그 직후 침묵 |
| 스캔·구성 증가 | 클래스패스 스캔 범위 확대, 의존성 추가로 auto-configuration 후보 증가 | 의존성 추가 시점과 일치, 스텝 계측으로 확인 |

"갑자기" 길어졌다면 **그 사이에 바뀐 것**(의존성 추가, 엔티티 추가, 마이그레이션 누적, 인프라 변경)과 교차 검증하는 것이 지름길이다.

## 3. 개선

- **무거운 초기화 지연**: 해당 빈에 `@Lazy` — 첫 사용 시점으로 미룬다.
- **예열은 기동 후로**: `@PostConstruct`의 캐시 예열·원격 호출을 `ApplicationReadyEvent` 리스너(+`@Async`)로 이동 — 서버는 먼저 뜨고 예열은 뒤에서.
- **원인 자체 제거**: DNS 설정 교정, 마이그레이션 베이스라인 정리, `ddl-auto` 전략 조정.
- **전역 `spring.main.lazy-initialization: true`의 트레이드오프**: 기동은 빨라지지만 ① 첫 요청이 초기화 비용을 뒤집어쓰고 ② 잘못된 빈 구성이 기동 시점이 아니라 **첫 사용 시점에야 터진다** — `application-yml-profile.md`의 fail-fast 원칙(잘못된 구성은 시끄러운 기동 실패로 드러나야 한다)과 정면으로 긴장 관계. 운영 서비스에서는 전역 lazy보다 문제 빈만 선별 지연이 정석.

## 4. AI 활용의 관점

"AI에게 분석시킨다"는 답 자체는 현대적 워크플로로 유효하다. 단, AI는 **준 데이터만큼만** 진단한다 — 침묵 구간은 로그를 아무리 줘도 답이 없다. "타임스탬프 로그 + 기동 중 스레드 덤프 + startup 타임라인을 떠서 주며 묻는다"라고 말할 수 있어야 한다. **무엇을 떠서 줄지 아는 것**이 곧 진단 역량이고, 면접이 확인하는 것도 그것이다.

## 5. 꼬리질문 대비 포인트

- **"스레드 덤프에서 main이 RUNNABLE인데도 안 나가요"** — RUNNABLE이라도 native socket read는 커널에서 대기 중일 수 있다(스택 내용으로 판단). 몇 초 간격으로 2~3회 떠서 스택이 같은 곳에 머무는지 확인.
- **"운영에서만 느리고 로컬은 빠릅니다"** — 환경 차이 계열: DNS/방화벽(연결 타임아웃까지 대기), 외부 설정 서버, DB 원격 지연, 프로파일별 빈 구성 차이.
- **"K8s에서 기동이 느려지면 무슨 일이?"** — liveness/startup probe 타임아웃에 걸려 무한 재시작 루프 가능. `startupProbe`로 기동 시간을 벌어주는 구성과 연결(graceful-shutdown 문서의 probe 논의 참조).
- **"CDS·AOT·CRaC 같은 기동 최적화는?"** — Spring Boot 3의 AOT/네이티브 이미지, CDS 아카이브는 '항상 느린 기동'의 개선책. 단 이 질문의 본령은 "갑자기 길어진" 회귀의 원인 추적이 먼저다.

## 한 줄 요약

기동 지연 추적은 "로그 타임스탬프 간격으로 구간 특정 → 침묵 구간은 기동 중 스레드 덤프로 main의 블록 지점 확인 → BufferingApplicationStartup으로 빈 단위 계측"의 순서고, 개선은 무거운 초기화의 @Lazy 지연과 예열의 ApplicationReadyEvent 이후 이동 — 전역 lazy는 fail-fast를 희생하는 트레이드오프임을 함께 말해야 한다.
