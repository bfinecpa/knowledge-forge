# application.yml Profile 활용 — 환경 분리는 "운영이 로컬 DB에 붙는" 사고를 막는 기본 방어선

> 핵심 관전 포인트: **프로파일은 하나의 코드(빌드 산출물)를
> 로컬/개발/스테이징/운영 등 여러 환경에서 각기 다른 설정으로 띄우기 위한
> 스프링의 환경 분리 장치다. 관례는 `application.yml`에 환경 무관 공통
> 설정만 두고, DB 접속 정보처럼 환경마다 달라지는 값은 전부
> `application-{profile}.yml`로 분리한 뒤, 배포 환경에서
> `SPRING_PROFILES_ACTIVE` 환경변수로 활성화하는 것이다. 이렇게 구성하면
> 프로파일 지정을 깜빡해도 DataSource 설정이 없어 기동 자체가 실패하므로
> — 조용히 엉뚱한 DB에 붙는 대신 시끄럽게 죽는(fail-fast) —
> 환경 오연결 사고가 구조적으로 불가능해진다.**

---

## 0. 질문 + 의도

**질문**: "`application.yml`의 profile은 어떻게 활용하나요?"

**출제 의도**: 로컬/스테이징/운영의 설정 분리는 "운영 DB에 로컬 설정으로
붙는" 류의 사고를 막는 기본 방어선이다. 환경 분리를 대충 하는 사람은
언젠가 반드시 사고를 낸다는 관점에서, 환경 구성의 기본기를 확인한다.

## 1. 개념 — 왜 프로파일이 필요한가

같은 애플리케이션이라도 환경마다 달라져야 하는 값이 있다.

- **로컬**: 내 PC의 DB, 상세 로그, 목(mock) 외부 연동
- **개발/스테이징**: 개발용 DB, 테스트 계정, 검증용 외부 시스템
- **운영**: 운영 DB, 최소 로그, 실 결제/알림 연동

이걸 코드 분기(`if (env == "prod")`)나 빌드 시점 치환으로 풀면
"환경마다 다른 바이너리"가 되어 검증한 것과 배포한 것이 달라진다.
프로파일은 **빌드 산출물은 하나로 두고, 기동 시점에 "지금은 어느 환경"
이라는 스위치만 바꾸는** 방식이다. 12-factor의 "설정은 코드가 아니라
환경에 둔다"는 원칙을 스프링이 구현한 것이라고 보면 된다.

비유하면 프로파일은 **멀티탭의 라벨**이다. 기계(코드)는 하나인데,
어느 콘센트(환경)에 꽂느냐에 따라 연결되는 전원(DB, 외부 시스템)이
달라진다.

## 2. 파일 구조와 활성화 방법

### 파일 분리 방식 (가장 일반적)

```
src/main/resources/
├── application.yml          # 공통: 환경과 무관한 설정만
├── application-local.yml    # 로컬 개발자 PC
├── application-dev.yml      # 개발 서버
├── application-stg.yml      # 스테이징
└── application-prod.yml     # 운영
```

```yaml
# application.yml — 환경 무관 공통 설정만
spring:
  application:
    name: order-service
  jpa:
    open-in-view: false      # 어느 환경이든 동일해야 하는 정책성 설정

server:
  port: 8080
```

```yaml
# application-local.yml — 로컬에서만 쓰는 값
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/order
    username: local_user
    password: local_pw       # 로컬 한정이므로 파일에 있어도 무방

logging:
  level:
    org.hibernate.SQL: debug
```

```yaml
# application-prod.yml — 운영 값 (시크릿은 자리표시자로)
spring:
  datasource:
    url: jdbc:mysql://prod-db.internal:3306/order
    username: ${DB_USERNAME}   # 실제 값은 환경변수/시크릿 저장소에서 주입
    password: ${DB_PASSWORD}

logging:
  level:
    root: warn
```

### 멀티 도큐먼트 방식 (파일 하나에 `---`로 구분)

파일을 나누는 대신 한 파일 안에서 구분할 수도 있다.

```yaml
# application.yml 하나에서 프로파일별 블록 분리
spring:
  application:
    name: order-service

---
spring:
  config:
    activate:
      on-profile: local      # 이 블록은 local 프로파일일 때만 적용
  datasource:
    url: jdbc:mysql://localhost:3306/order

---
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    url: jdbc:mysql://prod-db.internal:3306/order
```

설정 양이 적을 때는 편하지만, 환경이 늘고 설정이 커지면 파일 분리가
가독성과 diff 리뷰에 유리하다.

### 활성화 방법

```bash
# 1. 커맨드라인 인자 (우선순위 가장 높음)
java -jar app.jar --spring.profiles.active=prod

# 2. 환경변수 — 배포 환경의 사실상 표준 관례
#    (k8s Deployment env, systemd unit, Docker -e 등에서 지정)
export SPRING_PROFILES_ACTIVE=prod

# 3. yml 안에 지정 (로컬 기본값 용도 정도로만)
# spring.profiles.active: local

# 4. IDE Run Configuration의 Active profiles 항목 (로컬 개발용)
```

**우선순위 원칙**: 커맨드라인 인자 > 환경변수 > yml 파일. 그리고 같은
키가 겹치면 **프로파일 yml이 기본 `application.yml`을 오버라이드**한다.
즉 "공통은 기본 파일에, 환경별 차이는 프로파일 파일에서 덮어쓴다"는
레이어 구조다.

### 빈 자체를 환경별로 분기 — @Profile

설정값이 아니라 **빈 구현체 자체**를 환경별로 바꿔야 할 때는
`@Profile` 애너테이션을 쓴다.

```java
// 로컬/개발에서는 실제 메일을 쏘면 안 됨
@Component
@Profile({"local", "dev"})
public class ConsoleMailSender implements MailSender {
    // 메일 내용을 로그로만 출력
}

@Component
@Profile("prod")
public class SmtpMailSender implements MailSender {
    // 실제 SMTP 발송
}
```

활성 프로파일에 해당하는 빈만 컨테이너에 등록되므로, 코드에
`if (env)` 분기 없이 환경별 구현이 갈린다. `@Profile("!prod")`처럼
부정 조건도 가능하다.

### 프로파일 그룹 — spring.profiles.group (가산점 포인트)

프로파일이 "환경"과 "기능 스위치"로 늘어나면 묶어서 관리할 수 있다.

```yaml
spring:
  profiles:
    group:
      prod: "prod-db, prod-mq, monitoring"   # prod 하나 켜면 세 개가 같이 켜짐
```

배포 스크립트는 `prod` 하나만 지정하면 되고, 세부 프로파일 구성은
설정 파일 안에서 관리된다. 프로파일이 많아질 때 "운영자가 여러 개를
정확히 나열해야 하는" 휴먼 에러 지점을 줄이는 장치다.

## 3. 실무 사고 시나리오 — 프로파일 지정을 깜빡하면

출제 의도가 정확히 여기다. 환경 분리를 "그냥 파일 나누기"로만 아는
사람과, **사고를 구조적으로 막는 방어선**으로 이해하는 사람이 갈린다.

### 무슨 일이 벌어지나

프로파일을 지정하지 않고 기동하면 스프링 부트는 **`default`
프로파일**로 뜬다. 이때 읽히는 것은 기본 `application.yml`뿐이다
(`application-{profile}.yml`은 아무것도 적용되지 않는다).

문제는 흔한 안티패턴 구성에서 터진다.

```yaml
# [before] 안티패턴 — 기본 application.yml에 로컬 접속 정보가 들어 있음
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/order   # "로컬 기본값이니 편하겠지"
    username: local_user
    password: local_pw
```

이 구성에서 운영 장비 담당자가 `SPRING_PROFILES_ACTIVE=prod` 지정을
깜빡하면:

1. 앱은 **에러 없이 멀쩡히 뜬다** — 기본 yml의 설정으로.
2. 운영 장비가 localhost(또는 기본값에 적힌 어딘가의) DB에 붙는다.
   운영 장비에 우연히 DB가 떠 있거나, 기본값이 개발 DB를 가리키고
   있으면 **운영 트래픽이 엉뚱한 DB에 읽고 쓰는** 최악의 시나리오다.
3. 겉보기엔 정상 기동이라 헬스체크도 통과하고, 데이터가 이상하다는
   신고가 들어올 때까지 아무도 모른다 — **조용한 오연결**.

### 구조적으로 막는 법 — fail-fast 설계

핵심 아이디어: **"실수했을 때 조용히 잘못 도는 것"보다 "시끄럽게
죽는 것"이 안전하다.** 그러려면 기본 yml에서 환경 의존 설정을
전부 걷어내면 된다.

```yaml
# [after] 기본 application.yml — 환경 무관 공통 설정만, DB 정보 없음
spring:
  application:
    name: order-service
  jpa:
    open-in-view: false
# datasource 없음! → 프로파일 없이 뜨면 DataSource 구성 실패로 기동 자체가 죽는다
```

```yaml
# application-local.yml — 로컬 접속 정보는 여기로 이동
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/order
    username: local_user
    password: local_pw
```

이제 같은 실수를 하면:

1. 기본 yml에는 DataSource URL이 없으므로 부트의 DataSource 자동
   구성이 실패한다.
2. 앱이 **기동 시점에 즉시 죽고**, "Failed to configure a
   DataSource" 류의 명확한 에러가 남는다.
3. 배포 담당자는 그 자리에서 "아, 프로파일을 안 줬구나"를 알아채고
   고친다. 데이터는 단 한 건도 잘못 흐르지 않는다.

같은 실수(프로파일 누락)가 **"며칠 뒤 발견되는 데이터 사고"에서
"배포 순간 발견되는 기동 실패"로 격하**된 것이다. 이것이 안전한
기본값(secure by default) 사상이다 — 시스템의 기본 상태가 "위험하게
동작"이 아니라 "동작 거부"가 되도록 설계한다.

로컬 개발 편의는 IDE Run Configuration에 `local` 프로파일을 박아
두면 되므로 잃는 것이 없다. 원하면 방어선을 하나 더 둘 수도 있다:
기동 시 활성 프로파일을 검사해 기대 목록(local/dev/stg/prod) 밖이면
직접 예외를 던지는 검증 코드를 추가하는 식이다(가산점 포인트).

### 시크릿은 프로파일 파일에도 넣지 않는다

운영 DB 비밀번호 같은 시크릿은 `application-prod.yml`에도 평문으로
넣으면 안 된다. yml은 git에 커밋되므로 저장소 접근 권한 = 운영 DB
접근 권한이 되어 버리고, 히스토리에 한 번 들어간 비밀번호는 파일을
지워도 남는다. 관례는 **자리표시자 + 외부 주입**이다.

```yaml
# application-prod.yml — 구조만 정의, 실제 값은 바깥에서
spring:
  datasource:
    password: ${DB_PASSWORD}   # 환경변수, k8s Secret, Vault 등에서 주입
```

주입 수단은 환경 성숙도에 따라 환경변수 → Kubernetes Secret →
Vault/AWS Secrets Manager 같은 전용 시크릿 저장소(감사 로그, 자동
로테이션 지원) 순으로 올라간다.

### 시크릿을 빼도 남는 것 — 토폴로지(topology) 노출

**토폴로지**는 원래 "도형·배치의 구조"를 뜻하는 말인데, 인프라 문맥에서는
**구성원들이 어떻게 배치되고 서로 연결되어 있는지의 지도**를 가리킨다.
서버·서비스가 몇 개이고 이름이 무엇인지, 어떤 호스트/포트로 접속하는지,
누가 누구를 호출하는지, DB가 마스터/레플리카로 나뉘어 있는지, 캐시가
클러스터인지 단일인지, 내부망 IP 대역이 어떻게 잡혀 있는지 — 한마디로
**비밀번호가 아니라 "우리 시스템의 지도"** 다.

앞 절의 자리표시자 처리로 비밀번호는 저장소에서 사라진다. 하지만
**주소와 구성 형태는 yml에 그대로 남아 git에 커밋된다.** 아래는 시크릿을
전부 외부화한 뒤의 운영 프로파일인데, 평문 비밀번호가 하나도 없다.

```yaml
# application-prod.yml — 시크릿은 전부 외부 주입으로 뺀 상태
spring:
  datasource:
    url: jdbc:mysql://prod-db-master.internal.corp:3306/iam   # ← 남는다
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
  data:
    redis:
      cluster:
        nodes: 10.20.30.11:6379,10.20.30.12:6379,10.20.30.13:6379   # ← 남는다
  kafka:
    bootstrap-servers: kafka-1.internal.corp:9092,kafka-2.internal.corp:9092
external:
  auth-service: https://internal-auth.corp.local/api/v2
  payment-service: https://internal-pay.corp.local/api/v1
```

이 파일만 읽고도 이만큼 알 수 있다.

- 운영 DB의 내부 호스트명이 `prod-db-master...`다. `master`가 붙었으니
  **레플리카가 따로 있고**, 이름 규칙상 `prod-db-slave...`를 추측할 수 있다.
- Redis가 **3노드 클러스터**이고 사설망 **`10.20.30.0/24` 대역**을 쓴다 →
  그 대역의 나머지 IP도 스캔 대상이 된다.
- Kafka를 쓰고 있고 브로커가 최소 2대다.
- 인증과 결제가 **별도 서비스로 분리**되어 있고 각각 v2/v1 API다.
- 계정명 규칙이 `iam_prod`이니 `iam_stg`, `iam_dev`도 있을 것이다.

왜 위험한가. 침투의 첫 단계는 **정찰(reconnaissance)** 이다 — 방화벽 뒤의
내부 구조를 모르면 어디를 노려야 할지부터 막막한데, 이 파일이 그 지도를
공짜로 준다. 나중에 어떤 경로로든 내부망에 발 하나를 들여놓았을 때(예:
취약한 웹 서버 한 대), "결제 DB는 여기, 인증은 여기"를 이미 알고 있으면
**횡적 이동(lateral movement)이 훨씬 빨라진다.**

게다가 코드 저장소는 유출 경로가 넓다 — 퇴사자의 로컬 clone, 실수로
public으로 전환된 리포, 협력사와 공유한 저장소, CI 로그, 그리고 과거
커밋의 옛 주소까지 영구 보존하는 git 히스토리. 결정적으로 **시크릿은
유출되면 교체(rotate)하면 되지만, 내부 호스트명과 네트워크 대역은 바꾸는
비용이 훨씬 크다.** 그래서 "시크릿보다 오히려 지우기 어려운 정보"라고
말한다.

대안은 주소마저 자리표시자로 만들어, 저장소에는 **"무엇이 필요한가"만
남기고 "어디에 있는가"는 배포 환경이 알게** 하는 것이다.

```yaml
# Before: 시크릿은 빠졌지만 내부 주소·구조가 그대로 노출된다
spring:
  datasource:
    url: jdbc:mysql://prod-db-master.internal.corp:3306/iam
  kafka:
    bootstrap-servers: kafka-1.internal.corp:9092,kafka-2.internal.corp:9092
# After: 주소도 자리표시자 — 실제 값은 ConfigMap/Config Server가 준다
spring:
  datasource:
    url: ${DB_URL}
  kafka:
    bootstrap-servers: ${KAFKA_BROKERS}
```

단, 이것이 "그래서 항상 외부화하라"는 결론은 아니다. 외부화는 "설정
저장소가 죽으면 전 서비스가 기동 실패"라는 새 단일 장애점을 만들기
때문에, 서비스 몇 개 규모에서는 프로파일 yml + 시크릿만 외부화가 오히려
단순하고 안전하다. 토폴로지 노출은 **규모가 커질 때 외부화 쪽으로 저울을
기울게 만드는 무게 하나**로 이해하는 편이 정확하다(4장 마지막 꼬리질문과
이어진다).

## 4. 꼬리질문 대비 포인트

### "운영 장비에 배포하는데 담당자가 프로파일 지정을 깜빡했다. 부트는 어떤 설정으로 뜨나? 이 사고를 구조적으로 막으려면?"

프로파일 미지정 시 `default` 프로파일로 뜨고, 기본 `application.yml`만
적용된다. 기본 yml에 로컬 DB 접속 정보가 들어 있는 구성이라면 운영
장비가 에러 없이 기동해 로컬/개발 설정의 DB에 붙는 조용한 오연결
사고가 난다. 구조적 방어는 **기본 yml에서 환경 의존 설정을 전부
제거**하는 것: DB 접속 정보가 프로파일 yml에만 있으면, 프로파일 누락
시 DataSource 구성이 실패해 기동 자체가 죽는다. 실수가 데이터 사고가
아니라 즉시 눈에 보이는 기동 실패로 드러나는 fail-fast 구조다.

### "기본 yml에서 무엇을 빼고 어디로 옮기면 원천 차단되나?"

기준은 "환경마다 값이 달라지는가"다. DB URL/계정, 외부 API 엔드포인트와
키, 메시지 브로커 주소, 로그 레벨처럼 **환경 의존적인 것은 전부
`application-{profile}.yml`로**, 애플리케이션 이름, JPA 정책
(open-in-view 등), 직렬화 포맷처럼 **어느 환경이든 동일해야 하는 것만
기본 `application.yml`에** 남긴다. 특히 DataSource처럼 "없으면 기동이
실패하는" 필수 설정을 프로파일 쪽에 두는 것이 핵심이다 — 그것이
프로파일 누락을 기동 실패로 바꿔 주는 트리거이기 때문이다.

### "프로파일을 2개 이상 동시에 활성화하면? 충돌하는 키는?"

`--spring.profiles.active=prod,monitoring`처럼 쉼표로 여러 개를 켤 수
있고, 각 프로파일의 yml이 모두 적용된다. 같은 키가 겹치면 **나중에
처리된(목록에서 뒤에 선언된) 프로파일 값이 이긴다.** 이 "순서 의존
오버라이드"는 암묵적이라 사고 원인이 되기 쉬우므로, 실무에서는 여러
프로파일이 같은 키를 정의하지 않게 역할을 나누고(환경 프로파일 1개 +
기능 스위치 프로파일들), 조합이 필요하면 `spring.profiles.group`으로
명시적으로 묶는 편이 안전하다.

### "부트 2.4에서 spring.profiles가 spring.config.activate.on-profile로 바뀐 배경은?"

2.4 이전의 `spring.profiles` 키는 멀티 도큐먼트에서 "이 블록은 어느
프로파일용인가"라는 조건 지정과, `spring.profiles.active`/`include`의
프로파일 활성화가 같은 접두어에 섞여 있어 역할이 모호했다. 특히
프로파일 문서 안에서 다른 프로파일을 활성화하는 게 가능해, 설정 적용
순서가 직관과 어긋나는 케이스가 생겼다. 2.4의 설정 처리 개편에서
**"이 문서가 언제 적용되는가"라는 조건은
`spring.config.activate.on-profile`로 분리**하고, 프로파일 문서
내부에서 `spring.profiles.active`로 추가 활성화하는 것은 금지(예외
발생)했다. 대신 프로파일 조합 요구는 `spring.profiles.group`이라는
명시적 수단으로 흡수했다. 요컨대 "조건"과 "활성화"의 책임 분리다.

### "시크릿을 전부 환경변수로 뺐는데도 yml을 저장소에 두는 게 문제라는 건 무슨 뜻인가?"

남는 것이 **토폴로지**, 즉 내부 주소와 구성 형태이기 때문이다. 비밀번호는
사라져도 `prod-db-master.internal.corp`, Redis 클러스터 노드의 사설 IP
대역, Kafka 브로커 대수, 인증/결제 서비스의 내부 URL과 API 버전은 yml에
그대로 남는다. 이것만으로 공격자는 **정찰(reconnaissance)** 을 끝낼 수
있고, 내부망에 발 하나를 들여놓은 뒤의 **횡적 이동(lateral movement)** 이
크게 빨라진다. 저장소는 퇴사자의 로컬 clone·public 전환 실수·협력사 공유·
git 히스토리로 유출 경로가 넓은데, **시크릿은 교체(rotate)하면 되지만
내부 호스트명과 네트워크 대역은 바꾸는 비용이 훨씬 크다**는 점이 핵심이다.
해소하려면 주소까지 자리표시자로 두고 실제 값은 k8s ConfigMap이나 설정
서버에서 주입한다 — 다만 그건 새 단일 장애점을 만드는 트레이드오프다.

### "환경이 늘어날 때 프로파일 yml 방식의 한계는? 설정을 아예 코드 저장소 밖으로 빼는 선택은 언제 하나?" (시니어 변별 포인트)

프로파일 yml 방식의 한계는 세 가지다. (1) **설정 변경 = 재빌드/재배포**
— yml이 jar 안에 들어가므로 운영 설정 하나 바꾸려 해도 배포가 필요하다.
(2) **저장소 노출** — 운영 인프라의 내부 주소·구조가 코드 저장소에
드러난다(시크릿은 외부화해도 토폴로지 — 호스트명·네트워크 대역·서비스
구성도 — 는 남는다). (3) **다건 서비스
일관성** — 마이크로서비스가 늘면 공통 설정 변경을 서비스 수만큼
반복해야 한다. 그래서 규모가 커지면 Spring Cloud Config, k8s
ConfigMap/Secret, 외부 설정 저장소로 설정을 코드 밖으로 뺀다. 다만
외부화는 "설정 저장소 장애가 전 서비스 기동 실패로 번지는" 새 결합을
만들므로, 서비스 몇 개 수준에서는 프로파일 yml + 시크릿만 외부화가
오히려 단순하고 안전하다 — 규모에 따른 트레이드오프 판단이라는 점을
말하면 좋다. 어느 쪽이든 **"기본 상태가 안전한가(fail-fast)"라는
원칙은 동일하게 적용**된다.

---

## 한 줄 요약

프로파일은 하나의 빌드를 환경별 설정으로 갈아 끼우는 스위치이며,
공통은 `application.yml`·환경 의존 설정은 `application-{profile}.yml`로
나누고 시크릿은 외부 주입으로 빼는 순간 — 프로파일 누락이라는 흔한
휴먼 에러가 "운영이 로컬 DB에 붙는 조용한 사고"가 아니라 "배포 즉시
드러나는 기동 실패"로 격하되는, 안전한 기본값 설계가 완성된다.
