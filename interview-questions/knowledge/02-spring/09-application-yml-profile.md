# application.yml Profile 활용 — 환경 분리는 "운영이 로컬 DB에 붙는" 사고를 막는 기본 방어선

> 핵심 관전 포인트: **프로파일은 하나의 빌드 산출물을 로컬·개발·스테이징·운영에서 각기 다른 설정으로 띄우기 위한 스프링의 환경 분리 장치다. 관례는 `application.yml`에 환경 무관 공통 설정만 두고, DB 접속 정보처럼 환경마다 달라지는 값은 전부 `application-{profile}.yml`로 분리한 뒤 배포 환경에서 `SPRING_PROFILES_ACTIVE` 환경변수로 활성화하는 것이다. 다만 인과를 정확히 말해야 한다 — **프로파일을 썼기 때문에 안전해지는 것이 아니다.** 안전을 만드는 것은 "기동에 반드시 필요한 설정(DataSource URL)을 공통 yml에서 비워 두는 **설계 결정**"이고, 프로파일은 그 비워 둔 자리를 환경별로 채워 넣는 **수단**일 뿐이다. 이 설계를 택하는 순간 프로파일 지정을 깜빡하면 `Failed to configure a DataSource ... (no profiles are currently active)`로 기동 자체가 죽으므로 — 조용히 엉뚱한 DB에 붙는 대신 시끄럽게 죽는(fail-fast) — 환경 오연결 사고가 구조적으로 불가능해진다. 여기에 활성화 경로의 우선순위(커맨드라인 인자 > 시스템 프로퍼티 > 환경변수 > yml), 부트 2.4의 문법 변경(`spring.profiles` → `spring.config.activate.on-profile`), 그리고 yml에 남는 것이 시크릿만이 아니라 **토폴로지**라는 한계까지 이어 말할 수 있으면 완성이다.**

---

## 0. 질문 + 의도

**질문**: "`application.yml`의 profile은 어떻게 활용하나요?"

**출제 의도**: 로컬/스테이징/운영의 설정 분리는 "운영 DB에 로컬 설정으로 붙는" 류의 사고를 막는 기본 방어선이다. 환경 분리를 대충 하는 사람은 언젠가 반드시 사고를 낸다는 관점에서, 환경 구성의 기본기를 확인한다.

## 1. 개념 — 왜 프로파일이 필요한가

### 1-1. 같은 코드인데 환경마다 달라져야 하는 값이 있다

- **로컬**: 내 PC의 DB, 상세 로그, 목(mock) 외부 연동
- **개발/스테이징**: 개발용 DB, 테스트 계정, 검증용 외부 시스템
- **운영**: 운영 DB, 최소 로그, 실 결제·알림 연동

문제는 이 차이를 **어디에 담느냐**다. 선택지는 크게 셋이고, 프로파일이 왜 답인지는 나머지 둘이 왜 안 되는지를 보면 드러난다.

**선택지 ① 코드 분기.** `if (env.equals("prod")) { ... }`처럼 자바 코드 안에서 갈라 쓰는 방식이다. 환경 정보가 코드에 박히므로 새 환경(예: 성능 테스트용 `perf`)이 생길 때마다 코드를 고치고 다시 배포해야 한다. 무엇보다 운영 분기는 **운영에 나가기 전까지 한 번도 실행되지 않는** 코드다 — 테스트되지 않은 코드가 가장 중요한 환경에서 처음 돈다.

**선택지 ② 빌드 시점 치환.** 빌드할 때 설정 파일을 환경별로 갈아 끼워 jar를 따로 만드는 방식이다. 이러면 **환경마다 다른 바이너리**가 나온다. 스테이징에서 검증한 jar와 운영에 올라간 jar가 서로 다른 파일이므로, "스테이징에서는 됐는데 운영에서 안 된다"가 발생했을 때 원인이 코드인지 빌드인지 구분할 방법이 없다.

**선택지 ③ 프로파일.** 빌드 산출물은 **하나**로 두고, 기동 시점에 "지금은 어느 환경"이라는 스위치만 바꾼다. jar는 어디서나 같은 파일이므로 스테이징에서 검증한 것이 그대로 운영에 올라간다. 12-factor의 "설정은 코드가 아니라 환경에 둔다"는 원칙을 스프링이 구현한 것이라고 보면 된다.

비유하면 프로파일은 **멀티탭의 라벨**이다. 기계(코드)는 하나인데, 어느 콘센트(환경)에 꽂느냐에 따라 연결되는 전원(DB, 외부 시스템)이 달라진다.

### 1-2. 프로파일이 하는 일을 정확히 좁히면

프로파일이라는 말을 처음 만나면 "환경별 설정을 알아서 관리해 주는 기능"처럼 크게 들리는데, 실제로 하는 일은 훨씬 작고 단순하다. **활성 프로파일 이름의 목록을 들고 있으면서, 그 이름에 해당하는 설정 파일과 빈만 골라 적용하는 것**이 전부다.

정확히 두 가지 일을 한다.

```
활성 프로파일 = ["prod"]  라고 정해지면

 ① 설정 파일 선택 : application-prod.yml 을 추가로 읽어 application.yml 위에 덮는다
 ② 빈 선택       : @Profile("prod") 가 붙은 빈만 컨테이너에 등록한다
```

이 둘 말고는 아무것도 하지 않는다. **검증도, 강제도 하지 않는다.** "운영인데 프로파일이 없네?"라고 경고해 주지 않고, "prod에 DB 설정이 빠졌네?"라고 알려주지도 않는다. 3절에서 다룰 사고가 가능한 이유가 바로 이것이니, 여기서 기대치를 정확히 잡고 가자.

## 2. 파일 구조와 활성화 — 어디에 쓰고, 어떻게 켜고, 무엇이 이기나

### 2-1. 파일 분리 방식 (가장 일반적)

```
src/main/resources/
├── application.yml          # 공통: 환경과 무관한 설정만
├── application-local.yml    # 로컬 개발자 PC
├── application-dev.yml      # 개발 서버
├── application-stg.yml      # 스테이징
└── application-prod.yml     # 운영
```

파일명 규칙은 `application-{프로파일 이름}.yml`이다. 활성 프로파일이 `prod`면 부트가 `application-prod.yml`을 찾아 읽는다.

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
    url: jdbc:postgresql://localhost:5432/order
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
    url: jdbc:postgresql://prod-db.internal:5432/order
    username: ${DB_USERNAME}   # 실제 값은 환경변수/시크릿 저장소에서 주입
    password: ${DB_PASSWORD}

logging:
  level:
    root: warn
```

### 2-2. 멀티 도큐먼트 방식 — 그리고 부트 2.4의 문법 변경

파일을 나누는 대신 한 파일 안에서 `---`로 문서를 나눠 구분할 수도 있다. YAML에서 `---`는 "여기부터 새 문서"라는 표준 구분자다.

```yaml
# application.yml 하나에서 프로파일별 블록 분리
spring:
  application:
    name: order-service

---
spring:
  config:
    activate:
      on-profile: local      # 이 블록은 local 프로파일일 때만 적용된다
  datasource:
    url: jdbc:postgresql://localhost:5432/order

---
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    url: jdbc:postgresql://prod-db.internal:5432/order
```

**여기서 버전을 반드시 짚어야 한다. 이 문서의 서술은 스프링 부트 2.4 이상 기준이다.**

| 부트 버전 | 문서 활성화 조건 키 | 옛 키(`spring.profiles`)를 쓰면 |
|---|---|---|
| ~ 2.3 | `spring.profiles: local` | 정상 동작 |
| 2.4 ~ | `spring.config.activate.on-profile: local` | **기동 시 예외로 죽는다** |

2.4 이상에서 옛 문법을 그대로 두면 어떻게 되는지가 중요하다. **조용히 무시되는 것이 아니라, 명시적인 예외로 기동이 실패한다.** 부트는 설정 데이터를 처리하면서 `spring.profiles` 키를 발견하면 `InvalidConfigDataPropertyException`을 던지고, 메시지에 대체 키까지 알려준다.

```
Property 'spring.profiles' imported from location 'class path resource [application.yml]'
is invalid and should be replaced with 'spring.config.activate.on-profile'
[origin: class path resource [application.yml] - 8:3]
```

`origin`에 파일명과 줄·칸 번호까지 찍히므로 고칠 자리가 바로 나온다. 부트를 2.3에서 2.4 이상으로 올릴 때 만나는 대표적인 기동 실패이고, **조용한 오동작이 아니라 시끄러운 실패로 처리한 것 자체가 부트의 의도**다 — 프로파일 조건이 조용히 무시되면 3절에서 볼 오연결 사고와 똑같은 결과가 나기 때문이다.

설정 양이 적을 때는 한 파일이 편하지만, 환경이 늘고 설정이 커지면 파일 분리가 가독성과 코드 리뷰의 diff 확인에 유리하다.

### 2-3. 프로파일을 켜는 네 가지 경로와 그 우선순위

"어느 프로파일을 활성화할 것인가"를 지정하는 경로가 여럿이라 헷갈린다. 정리하면 이렇다.

```bash
# 1. 커맨드라인 인자 — 가장 강하다
java -jar app.jar --spring.profiles.active=prod

# 2. JVM 시스템 프로퍼티 (-D)
java -Dspring.profiles.active=prod -jar app.jar

# 3. 환경변수 — 배포 환경의 사실상 표준 관례
#    (k8s Deployment env, systemd unit, Docker -e 등에서 지정)
export SPRING_PROFILES_ACTIVE=prod

# 4. yml 안에 지정 — 로컬 기본값 용도 정도로만
#    application.yml:  spring.profiles.active: local
```

`SPRING_PROFILES_ACTIVE`처럼 대문자 스네이크 표기가 되는 이유는, 스프링이 환경변수 이름을 프로퍼티 이름으로 바꿀 때 **밑줄을 점으로 바꾸고 소문자로 내리기** 때문이다. `SPRING_PROFILES_ACTIVE` → `spring.profiles.active`가 된다. 환경변수 이름에는 점을 못 쓰는 셸의 제약을 우회하는 장치다.

우선순위는 아래 2-4의 일반 규칙을 그대로 따른다. 실무에서 이 순서가 실제로 문제가 되는 순간은 **"환경변수로 `prod`를 줬는데 yml의 `spring.profiles.active: local`이 이기는 것 아닌가?"** 하는 걱정인데, 그럴 일은 없다. 환경변수가 yml보다 강하다.

테스트에는 별도의 경로가 하나 더 있다.

```java
// 테스트 전용 — 이 테스트 컨텍스트의 활성 프로파일을 직접 지정한다
@SpringBootTest
@ActiveProfiles("test")
class OrderServiceTest { ... }
```

`@ActiveProfiles`는 프로퍼티를 통하지 않고 **테스트 컨텍스트의 Environment에 활성 프로파일을 직접 심는다.** 부트는 이렇게 프로그래밍 방식으로 지정된 프로파일을 프로퍼티로 바인딩된 값보다 우선하므로, `application.yml`에 `spring.profiles.active: local`이 들어 있어도 테스트는 `test` 프로파일로 뜬다.

### 2-4. 그래서 같은 키가 겹치면 누가 이기나 — 외부화 설정 우선순위

프로파일 활성화만이 아니라 **모든 설정값**에 적용되는 규칙이다. 스프링 부트는 여러 곳에서 프로퍼티를 읽어 층층이 쌓고, 위층이 아래층을 덮는다.

| 우선순위 | 출처 | 실무에서 쓰는 자리 |
|---|---|---|
| 1 (가장 강함) | 커맨드라인 인자 `--key=value` | 긴급 임시 조치, 로컬 실행 |
| 2 | `SPRING_APPLICATION_JSON` 환경변수 | JSON 한 덩어리로 주입 |
| 3 | JVM 시스템 프로퍼티 `-Dkey=value` | 컨테이너 이전 시대의 관례 |
| 4 | **OS 환경변수** | **k8s·Docker 배포의 표준** |
| 5 | 설정 데이터 (`application*.yml`) | 프로파일별 값의 본진 |
| 6 | `@PropertySource` | 레거시 설정 파일 흡수 |
| 7 (가장 약함) | `SpringApplication.setDefaultProperties` | 라이브러리 기본값 |

5층(설정 데이터) 안에서 또 한 번 층이 나뉜다. **뒤에 있는 것이 앞의 것을 덮는다.**

```
약함 ─────────────────────────────────────────────────────► 강함

 jar 안             jar 안                jar 밖              jar 밖
 application.yml → application-prod.yml → application.yml → application-prod.yml
 (공통 기본값)      (프로파일별 덮어쓰기)   (배포 환경이 얹음)   (배포 환경의 프로파일별)
```

이 구조에서 실무적으로 두 가지 결론이 나온다.

**첫째, "공통은 기본 파일에, 환경별 차이는 프로파일 파일에서 덮어쓴다"가 성립한다.** `application.yml`에 `server.port: 8080`을 두고 `application-prod.yml`에 `server.port: 80`을 두면 운영에서는 80이 이긴다.

**둘째, jar 밖의 파일이 jar 안의 파일을 이긴다.** 부트는 클래스패스뿐 아니라 실행 디렉토리(`./`, `./config/`)에서도 같은 이름의 파일을 찾는다. 그래서 **재빌드 없이 jar 옆에 `application-prod.yml`을 놓아 값을 덮을 수 있다.** 긴급 상황의 탈출구이자, 동시에 "이 서버만 설정이 다른데 아무도 모르는" 사고의 원인이기도 하다. 이 방식을 쓴다면 반드시 형상 관리 대상으로 잡아야 한다.

### 2-5. 빈 자체를 환경별로 갈아 끼우기 — @Profile

지금까지는 **값**을 바꾸는 이야기였다. 그런데 환경에 따라 바뀌어야 하는 것이 값이 아니라 **동작 자체**인 경우가 있다. 로컬에서 실제 결제를 긁거나 실제 문자를 보내면 안 되는 상황이 대표적이다.

이럴 때는 값이 아니라 **빈 구현체 자체**를 환경별로 바꾼다. `@Profile` 애너테이션이 그 장치다.

```java
// before: 값으로 풀려다 실패하는 형태 — 분기가 코드에 남는다
@Component
public class PaymentGateway {

    @Value("${payment.mock-enabled:false}")
    private boolean mockEnabled;

    public PaymentResult pay(Order order) {
        // 운영 코드 안에 "가짜로 처리하는 경로"가 영구히 살아 있다.
        // 프로퍼티 하나만 잘못 켜지면 운영에서 결제가 통과된 척한다.
        if (mockEnabled) {
            return PaymentResult.success("MOCK-" + order.id());
        }
        return pgClient.charge(order);
    }
}
```

```java
// after: 구현체를 통째로 갈아 끼운다 — 운영 바이너리에는 목 경로가 "등록조차" 되지 않는다
public interface PaymentGateway {
    PaymentResult pay(Order order);
}

@Component
@Profile({"local", "dev"})       // 이 두 프로파일일 때만 컨테이너에 등록된다
public class MockPaymentGateway implements PaymentGateway {
    @Override
    public PaymentResult pay(Order order) {
        // 실제 PG를 부르지 않고 성공 응답을 흉내 낸다.
        return PaymentResult.success("MOCK-" + order.id());
    }
}

@Component
@Profile("prod")
public class PgPaymentGateway implements PaymentGateway {
    private final PgClient pgClient;
    public PgPaymentGateway(PgClient pgClient) { this.pgClient = pgClient; }

    @Override
    public PaymentResult pay(Order order) {
        return pgClient.charge(order);
    }
}
```

핵심은 **주입받는 쪽 코드에 분기가 하나도 없다**는 것이다. `PaymentGateway`를 생성자 주입으로 받아 쓰는 서비스는 자기가 목을 쓰는지 실물을 쓰는지 모른다. 활성 프로파일에 해당하는 빈만 컨테이너에 등록되므로, 실행 중에 결정할 것이 아무것도 남지 않는다.

`@Profile("!prod")`처럼 부정 조건도 쓸 수 있고, `@Profile({"local", "dev"})`처럼 여러 개를 나열하면 OR로 동작한다.

주의점이 하나 있다. **어느 프로파일에도 해당하지 않으면 빈이 하나도 등록되지 않아, 주입받는 쪽에서 `NoSuchBeanDefinitionException`으로 기동이 실패한다.** 위 예에서 `stg` 프로파일로 띄우면 `PaymentGateway` 구현이 없어 죽는다. 언뜻 불편해 보이지만 이것도 3절과 같은 종류의 fail-fast다 — "빈이 없다"가 기동 시점에 드러나는 편이, 운영에서 결제 호출이 아무 일도 안 하는 것보다 훨씬 낫다.

### 2-6. 프로파일 그룹 — spring.profiles.group (가산점 포인트)

프로파일이 "환경"만이 아니라 "기능 스위치"로도 늘어나면 개수가 빠르게 불어난다. 부트 2.4부터는 여러 프로파일을 이름 하나로 묶을 수 있다.

```yaml
spring:
  profiles:
    group:
      prod: "prod-db, prod-mq, monitoring"   # prod 하나 켜면 세 개가 같이 켜진다
```

배포 스크립트는 `SPRING_PROFILES_ACTIVE=prod` 하나만 지정하면 되고, 세부 프로파일 구성은 설정 파일 안에서 관리된다. **"운영자가 여러 개를 정확히 나열해야 하는" 휴먼 에러 지점을 없애는 장치**다. `prod,prod-db,prod-mq` 중 하나만 빠뜨려도 사고가 나는 구조를, 애초에 빠뜨릴 것이 없는 구조로 바꾼다.

## 3. 실무 사고 시나리오 — 프로파일 지정을 깜빡하면

출제 의도가 정확히 여기다. 환경 분리를 "그냥 파일 나누기"로만 아는 사람과, **사고를 구조적으로 막는 방어선**으로 이해하는 사람이 갈린다.

### 3-1. 무슨 일이 벌어지나

프로파일을 지정하지 않고 기동하면 스프링 부트는 **`default` 프로파일**로 뜬다. 에러도 경고도 없다. 이때 읽히는 것은 기본 `application.yml`뿐이고 `application-{profile}.yml`은 아무것도 적용되지 않는다.

문제는 흔한 안티패턴 구성에서 터진다.

```yaml
# before: 안티패턴 — 기본 application.yml에 로컬 접속 정보가 들어 있다
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/order   # "로컬 기본값이니 편하겠지"
    username: local_user
    password: local_pw
```

이 구성에서 운영 장비 담당자가 `SPRING_PROFILES_ACTIVE=prod` 지정을 깜빡하면 이런 순서로 흘러간다.

```
t0  배포 스크립트 실행. 프로파일 미지정.
t1  부트가 default 프로파일로 기동. application.yml 만 읽는다.
t2  DataSource 생성 성공 (URL이 있으니까!) → 앱이 에러 없이 정상 기동
t3  헬스체크 통과 → 로드밸런서가 트래픽을 붙인다
t4  운영 트래픽이 localhost(또는 기본값이 가리키는 어딘가)의 DB에 읽고 쓴다
    ...
tN  며칠 뒤 "데이터가 이상하다"는 신고가 들어온다   ← 여기서야 발견
```

가장 나쁜 지점은 **t2에서 정상 기동한다**는 것이다. 겉으로는 아무 문제가 없으니 헬스체크도 통과하고 모니터링도 초록불이다. 이것을 **조용한 오연결**이라고 부른다. 운영 장비에 우연히 DB가 떠 있거나, 기본값이 개발 DB를 가리키고 있으면 운영 트래픽이 엉뚱한 DB에 쓰는 최악의 시나리오가 된다.

### 3-2. 인과를 바로잡자 — 안전을 만드는 것은 프로파일이 아니다

여기서 가장 흔한 오해를 정면으로 짚어야 한다. **"프로파일을 쓰면 이런 사고가 안 난다"는 말은 틀렸다.** 위 안티패턴도 프로파일을 쓰고 있다. `application-prod.yml`도 있고 `application-local.yml`도 있다. 그런데 사고가 났다.

원인과 수단을 분리해 보면 이렇다.

```
 [원인 = 설계 결정]  기동에 반드시 필요한 설정을 공통 yml에서 비워 둔다
        │              (DataSource URL을 application.yml 에 두지 않는다)
        │
        ▼
 [효과]  프로파일이 없으면 그 값을 채울 곳이 없다 → 기동 실패 → 사고가 즉시 드러난다
        ▲
        │
 [수단 = 프로파일]  비워 둔 자리를 환경별로 채워 넣는 메커니즘
```

프로파일은 **값을 채우는 수단**일 뿐이고, 안전을 만드는 것은 **"공통 자리를 의도적으로 비워 두겠다"는 설계 결정**이다. 같은 프로파일 기능을 쓰더라도 공통 yml에 URL을 남겨 두면 방어선은 존재하지 않는다.

이 구분이 중요한 이유는 실무의 판단이 여기서 갈리기 때문이다. "로컬에서 프로파일 안 주고도 뜨면 편하잖아"라는 말은 대단히 합리적으로 들린다. 그 편의를 위해 공통 yml에 로컬 DB 정보를 남기는 순간, **편의의 대가로 방어선을 통째로 지불한 것**이다. 이 거래를 인식하고 거절하는 것이 이 질문의 핵심이다.

### 3-3. 그래서 이렇게 고친다 — fail-fast 설계

핵심 아이디어는 한 문장이다. **"실수했을 때 조용히 잘못 도는 것"보다 "시끄럽게 죽는 것"이 안전하다.**

```yaml
# after: 기본 application.yml — 환경 무관 공통 설정만, DB 정보 없음
spring:
  application:
    name: order-service
  jpa:
    open-in-view: false
# datasource 항목 자체가 없다.
# 이 "없음"이 방어선이다 — 프로파일 없이 뜨면 채울 값이 없어 기동이 죽는다.
```

```yaml
# application-local.yml — 로컬 접속 정보는 여기로 이동
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/order
    username: local_user
    password: local_pw
```

이제 같은 실수를 하면 앱은 기동 도중 죽고, 이런 메시지를 남긴다.

```
***************************
APPLICATION FAILED TO START
***************************

Description:

Failed to configure a DataSource: 'url' attribute is not specified and
no embedded datasource could be configured.

Reason: Failed to determine a suitable driver class

Action:

Consider the following:
	If you want an embedded database (H2, HSQL or Derby), please put it on the classpath.
	If you have database settings to be loaded from a particular profile you may need to
	activate it (no profiles are currently active).
```

이 메시지를 한 줄씩 읽어 보면 부트가 **정확히 이 상황을 예상하고 만들어 둔 안내**라는 것을 알 수 있다.

- `'url' attribute is not specified` — 무엇이 없는지.
- `If you have database settings to be loaded from a particular profile you may need to activate it` — **"프로파일에서 읽어야 할 DB 설정이 있다면 프로파일을 활성화해야 할 수 있다"**고 원인을 직접 지목한다.
- `(no profiles are currently active)` — 그리고 지금 활성 프로파일이 하나도 없다는 사실까지 괄호로 붙여 준다. 프로파일이 있었다면 `(the profiles prod are currently active)`처럼 이름이 찍힌다.

배포 담당자는 이 세 줄을 읽고 그 자리에서 "아, 프로파일을 안 줬구나"를 알아챈다. **데이터는 단 한 건도 잘못 흐르지 않는다.**

같은 실수(프로파일 누락)가 **"며칠 뒤 발견되는 데이터 사고"에서 "배포 순간 발견되는 기동 실패"로 격하**된 것이다. 이것이 **안전한 기본값(secure by default)** 사상이다 — 시스템의 기본 상태가 "위험하게 동작"이 아니라 "동작 거부"가 되도록 설계한다.

로컬 개발 편의는 IDE Run Configuration에 `local` 프로파일을 박아 두면 되므로 잃는 것이 없다. 원하면 방어선을 하나 더 둘 수도 있다 — 기동 시 활성 프로파일을 검사해 기대 목록(local/dev/stg/prod) 밖이면 직접 예외를 던지는 검증 코드를 추가하는 식이다(가산점 포인트).

```java
// 방어선 추가: 알 수 없는 프로파일이거나 프로파일이 없으면 기동을 거부한다
@Component
public class ProfileGuard implements InitializingBean {

    private static final Set<String> ALLOWED = Set.of("local", "dev", "stg", "prod");
    private final Environment env;

    public ProfileGuard(Environment env) { this.env = env; }

    @Override
    public void afterPropertiesSet() {
        // DataSource가 없어야만 죽는 3-3의 방어선은 "DB를 쓰는 앱"에서만 통한다.
        // 이 가드는 DB를 안 쓰는 앱에도 같은 fail-fast를 적용하기 위한 것이다.
        List<String> active = List.of(env.getActiveProfiles());
        if (active.stream().noneMatch(ALLOWED::contains)) {
            throw new IllegalStateException(
                    "환경 프로파일이 지정되지 않았습니다. 활성 프로파일=" + active);
        }
    }
}
```

### 3-4. 시크릿은 프로파일 파일에도 넣지 않는다

운영 DB 비밀번호 같은 시크릿은 `application-prod.yml`에도 평문으로 넣으면 안 된다. 이유가 둘이다.

**첫째, yml은 git에 커밋되므로 저장소 접근 권한이 곧 운영 DB 접근 권한이 된다.** 신입이 온보딩하려고 클론하는 순간 운영 DB 비밀번호를 받아 가는 구조다.

**둘째, 히스토리에 한 번 들어간 비밀번호는 파일을 지워도 남는다.** `git rm` 후 커밋해도 과거 커밋에는 그대로 있고, 이미 클론한 사람들의 로컬에도 남는다. 사실상 회수가 불가능하다.

관례는 **자리표시자 + 외부 주입**이다.

```yaml
# application-prod.yml — 구조만 정의, 실제 값은 바깥에서
spring:
  datasource:
    password: ${DB_PASSWORD}   # 환경변수, k8s Secret, Vault 등에서 주입
```

`${DB_PASSWORD}`는 2-4의 우선순위 표에서 4층(OS 환경변수)에 있는 값을 끌어다 쓴다. 즉 이 문법은 새로운 기능이 아니라 이미 있는 우선순위 체계를 명시적으로 참조하는 것뿐이다.

주입 수단은 환경 성숙도에 따라 단계가 있다.

| 단계 | 수단 | 얻는 것 | 남는 한계 |
|---|---|---|---|
| 1 | OS 환경변수 | 저장소에서 시크릿 제거 | 배포 스크립트·프로세스 환경에 평문으로 남음 |
| 2 | Kubernetes Secret | 배포 매니페스트와 분리, RBAC 적용 | 기본값이 base64 인코딩일 뿐 암호화가 아님 |
| 3 | Vault / AWS Secrets Manager | 암호화 저장, **감사 로그**, **자동 로테이션** | 별도 인프라와 장애점이 늘어남 |
| 4 | Spring Cloud Config + 시크릿 저장소 | 설정과 시크릿을 서비스 전체에 중앙 관리 | 설정 서버가 죽으면 전 서비스 기동 실패 |

3단계의 값어치는 "암호화"보다 **감사 로그와 자동 로테이션**에 있다는 점을 짚으면 좋다. 누가 언제 이 비밀번호를 읽어 갔는지 기록이 남고, 주기적으로 자동 교체되므로 유출됐더라도 유효 기간이 짧다. 환경변수는 이 둘을 제공하지 못한다.

### 3-5. 시크릿을 빼도 남는 것 — 토폴로지 노출

**토폴로지**는 원래 "도형·배치의 구조"를 뜻하는 말인데, 인프라 문맥에서는 **구성원들이 어떻게 배치되고 서로 연결되어 있는지의 지도**를 가리킨다. 서버·서비스가 몇 개이고 이름이 무엇인지, 어떤 호스트·포트로 접속하는지, 누가 누구를 호출하는지, DB가 마스터·레플리카로 나뉘어 있는지, 캐시가 클러스터인지 단일인지, 내부망 IP 대역이 어떻게 잡혀 있는지 — 한마디로 **비밀번호가 아니라 "우리 시스템의 지도"**다.

앞 절의 자리표시자 처리로 비밀번호는 저장소에서 사라진다. 하지만 **주소와 구성 형태는 yml에 그대로 남아 git에 커밋된다.** 아래는 시크릿을 전부 외부화한 뒤의 운영 프로파일인데, 평문 비밀번호가 하나도 없다.

```yaml
# application-prod.yml — 시크릿은 전부 외부 주입으로 뺀 상태
spring:
  datasource:
    url: jdbc:postgresql://prod-db-master.internal.corp:5432/iam   # ← 남는다
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
  data:
    redis:
      cluster:
        nodes: 10.20.30.11:6379,10.20.30.12:6379,10.20.30.13:6379   # ← 남는다
  rabbitmq:
    addresses: rabbit-1.internal.corp:5672,rabbit-2.internal.corp:5672
  kafka:
    bootstrap-servers: kafka-1.internal.corp:9092,kafka-2.internal.corp:9092
external:
  auth-service: https://internal-auth.corp.local/api/v2
  payment-service: https://internal-pay.corp.local/api/v1
```

이 파일만 읽고도 이만큼 알 수 있다.

- 운영 DB의 내부 호스트명이 `prod-db-master...`다. `master`가 붙었으니 **레플리카가 따로 있고**, 이름 규칙상 `prod-db-replica...`를 추측할 수 있다.
- Redis가 **3노드 클러스터**이고 사설망 **`10.20.30.0/24` 대역**을 쓴다 → 그 대역의 나머지 IP도 스캔 대상이 된다.
- RabbitMQ 브로커가 2대, Kafka 브로커도 2대다. 비동기 처리 경로가 두 갈래로 나뉘어 있다는 뜻이다.
- 인증과 결제가 **별도 서비스로 분리**되어 있고 각각 v2/v1 API다.
- 계정명 규칙이 `iam_prod`이니 `iam_stg`, `iam_dev`도 있을 것이다.

왜 위험한가. 침투의 첫 단계는 **정찰(reconnaissance)**이다 — 방화벽 뒤의 내부 구조를 모르면 어디를 노려야 할지부터 막막한데, 이 파일이 그 지도를 공짜로 준다. 나중에 어떤 경로로든 내부망에 발 하나를 들여놓았을 때(예: 취약한 웹 서버 한 대), "결제 DB는 여기, 인증은 여기"를 이미 알고 있으면 **횡적 이동(lateral movement)이 훨씬 빨라진다.**

게다가 코드 저장소는 유출 경로가 넓다 — 퇴사자의 로컬 clone, 실수로 public으로 전환된 리포, 협력사와 공유한 저장소, CI 로그, 그리고 과거 커밋의 옛 주소까지 영구 보존하는 git 히스토리.

결정적인 비대칭이 여기 있다. **시크릿은 유출되면 교체(rotate)하면 되지만, 내부 호스트명과 네트워크 대역은 바꾸는 비용이 훨씬 크다.** DNS 레코드, 방화벽 규칙, 다른 서비스의 설정이 전부 얽혀 있기 때문이다. 그래서 "시크릿보다 오히려 지우기 어려운 정보"라고 말한다.

대안은 주소마저 자리표시자로 만들어, 저장소에는 **"무엇이 필요한가"만 남기고 "어디에 있는가"는 배포 환경이 알게** 하는 것이다.

```yaml
# before: 시크릿은 빠졌지만 내부 주소·구조가 그대로 노출된다
spring:
  datasource:
    url: jdbc:postgresql://prod-db-master.internal.corp:5432/iam
  rabbitmq:
    addresses: rabbit-1.internal.corp:5672,rabbit-2.internal.corp:5672
# after: 주소도 자리표시자 — 실제 값은 ConfigMap/Config Server가 준다
spring:
  datasource:
    url: ${DB_URL}
  rabbitmq:
    addresses: ${RABBIT_ADDRESSES}
```

단, 이것이 "그래서 항상 외부화하라"는 결론은 아니다. 외부화는 "설정 저장소가 죽으면 전 서비스가 기동 실패"라는 새 단일 장애점을 만들기 때문에, 서비스 몇 개 규모에서는 프로파일 yml + 시크릿만 외부화가 오히려 단순하고 안전하다. 토폴로지 노출은 **규모가 커질 때 외부화 쪽으로 저울을 기울게 만드는 무게 하나**로 이해하는 편이 정확하다(4절 마지막 꼬리질문과 이어진다).

## 4. 꼬리질문 대비 포인트

### "운영 장비에 배포하는데 담당자가 프로파일 지정을 깜빡했다. 부트는 어떤 설정으로 뜨나? 이 사고를 구조적으로 막으려면?"

프로파일 미지정 시 `default` 프로파일로 뜨고, 기본 `application.yml`만 적용된다. 기본 yml에 로컬 DB 접속 정보가 들어 있는 구성이라면 운영 장비가 **에러 없이 기동해** 로컬·개발 설정의 DB에 붙는 조용한 오연결 사고가 난다.

구조적 방어는 **기본 yml에서 환경 의존 설정을 전부 제거**하는 것이다. DB 접속 정보가 프로파일 yml에만 있으면, 프로파일 누락 시 DataSource 구성이 실패해 기동 자체가 죽는다. 실수가 데이터 사고가 아니라 즉시 눈에 보이는 기동 실패로 드러나는 fail-fast 구조다.

여기서 인과를 정확히 말하면 한 단계 더 올라간다. **프로파일을 썼기 때문에 안전한 것이 아니라, 필수 설정을 공통 자리에 두지 않기로 한 설계 결정 때문에 안전한 것이다.** 프로파일은 비워 둔 자리를 채우는 수단이고, 방어선은 "비워 둔다"는 결정 쪽에 있다.

### "기본 yml에서 무엇을 빼고 어디로 옮기면 원천 차단되나?"

기준은 딱 하나, **"환경마다 값이 달라지는가"**다.

| 성격 | 예 | 둘 자리 |
|---|---|---|
| 환경 의존 | DB URL·계정, 외부 API 엔드포인트와 키, 브로커 주소, 로그 레벨 | `application-{profile}.yml` |
| 환경 무관 | 애플리케이션 이름, JPA 정책(`open-in-view`), 직렬화 포맷, 잭슨 설정 | 기본 `application.yml` |

특히 `DataSource`처럼 **"없으면 기동이 실패하는" 필수 설정을 프로파일 쪽에 두는 것이 핵심**이다. 그것이 프로파일 누락을 기동 실패로 바꿔 주는 트리거이기 때문이다. 반대로 말하면, DB를 안 쓰는 서비스에는 이 트리거가 없으므로 3-3의 `ProfileGuard` 같은 명시적 검증을 따로 둬야 한다.

### "프로파일을 2개 이상 동시에 활성화하면? 충돌하는 키는?"

`--spring.profiles.active=prod,monitoring`처럼 쉼표로 여러 개를 켤 수 있고, 각 프로파일의 yml이 모두 적용된다. 같은 키가 겹치면 **나중에 처리된(목록에서 뒤에 선언된) 프로파일 값이 이긴다.**

이 "순서 의존 오버라이드"는 암묵적이라 사고 원인이 되기 쉽다. `prod,monitoring`과 `monitoring,prod`가 다른 결과를 내는데, 배포 스크립트에서 순서가 바뀌는 것을 아무도 리뷰하지 않는다.

실무 대응은 두 가지다. 여러 프로파일이 **같은 키를 정의하지 않도록 역할을 나누고**(환경 프로파일 1개 + 기능 스위치 프로파일들), 조합이 필요하면 `spring.profiles.group`으로 **묶어서 이름 하나로 켠다**(2-6). 그러면 순서는 설정 파일 안에 고정되고, 배포 스크립트에서 실수할 여지가 사라진다.

### "부트 2.4에서 spring.profiles가 spring.config.activate.on-profile로 바뀐 배경은?"

2.4 이전의 `spring.profiles` 키는 역할이 두 개 섞여 있었다. 멀티 도큐먼트에서 **"이 블록은 어느 프로파일용인가"라는 조건 지정**과, `spring.profiles.active`/`include`의 **프로파일 활성화**가 같은 접두어를 공유했다.

특히 프로파일 문서 안에서 또 다른 프로파일을 활성화하는 것이 가능해, 설정 적용 순서가 직관과 어긋나는 케이스가 생겼다. "A 프로파일 블록이 B를 켜고, B 블록이 다시 C를 켜는" 식의 연쇄가 성립하면 최종 설정이 무엇인지 읽어서 알기 어렵다.

2.4의 설정 처리 개편에서 **"이 문서가 언제 적용되는가"라는 조건은 `spring.config.activate.on-profile`로 분리**하고, 프로파일 문서 내부에서 `spring.profiles.active`로 추가 활성화하는 것은 금지(예외 발생)했다. 대신 프로파일 조합 요구는 `spring.profiles.group`이라는 명시적 수단으로 흡수했다. 요컨대 **"조건"과 "활성화"의 책임 분리**다.

한 가지 정확히 알아 둘 것은, 2.4 이상에서 옛 키 `spring.profiles`를 그대로 쓰면 **조용히 무시되는 게 아니라 `InvalidConfigDataPropertyException`으로 기동이 실패**한다는 점이다(2-2). 부트가 굳이 예외로 처리한 이유는, 프로파일 조건이 조용히 무시되면 결국 "모든 블록이 적용되는" 상태가 되어 이 문서 전체가 경계하는 오연결 사고로 이어지기 때문이다.

### "시크릿을 전부 환경변수로 뺐는데도 yml을 저장소에 두는 게 문제라는 건 무슨 뜻인가?"

남는 것이 **토폴로지**, 즉 내부 주소와 구성 형태이기 때문이다. 비밀번호는 사라져도 `prod-db-master.internal.corp`, Redis 클러스터 노드의 사설 IP 대역, RabbitMQ·Kafka 브로커 대수, 인증·결제 서비스의 내부 URL과 API 버전은 yml에 그대로 남는다.

이것만으로 공격자는 **정찰(reconnaissance)**을 끝낼 수 있고, 내부망에 발 하나를 들여놓은 뒤의 **횡적 이동(lateral movement)**이 크게 빨라진다. 저장소는 퇴사자의 로컬 clone, public 전환 실수, 협력사 공유, git 히스토리로 유출 경로가 넓다.

핵심은 비대칭이다. **시크릿은 교체(rotate)하면 되지만 내부 호스트명과 네트워크 대역은 바꾸는 비용이 훨씬 크다.** 해소하려면 주소까지 자리표시자로 두고 실제 값은 k8s ConfigMap이나 설정 서버에서 주입한다 — 다만 그건 새 단일 장애점을 만드는 트레이드오프다.

### "환경이 늘어날 때 프로파일 yml 방식의 한계는? 설정을 아예 코드 저장소 밖으로 빼는 선택은 언제 하나?" (시니어 변별 포인트)

프로파일 yml 방식의 한계는 세 가지다.

**(1) 설정 변경 = 재빌드·재배포.** yml이 jar 안에 들어가므로 운영 설정 하나 바꾸려 해도 배포 파이프라인을 한 바퀴 돌려야 한다. 장애 중에 커넥션 풀 크기를 올리고 싶어도 빌드부터 기다려야 한다는 뜻이다.

**(2) 저장소 노출.** 운영 인프라의 내부 주소와 구조가 코드 저장소에 드러난다. 시크릿을 외부화해도 토폴로지 — 호스트명, 네트워크 대역, 서비스 구성도 — 는 남는다(3-5).

**(3) 다건 서비스 일관성.** 마이크로서비스가 늘면 공통 설정 변경을 서비스 수만큼 반복해야 한다. 로그 포맷 하나 바꾸는 데 서른 개 저장소에 PR을 올리는 상황이 된다.

그래서 규모가 커지면 Spring Cloud Config, k8s ConfigMap/Secret, 외부 설정 저장소로 설정을 코드 밖으로 뺀다.

다만 여기서 균형을 잡는 것이 변별 포인트다. **외부화는 "설정 저장소 장애가 전 서비스 기동 실패로 번지는" 새 결합을 만든다.** 서비스 몇 개 수준에서는 프로파일 yml + 시크릿만 외부화가 오히려 단순하고 안전하다. 규모에 따른 트레이드오프 판단이라는 점을 말하면 좋다.

어느 쪽을 택하든 **"기본 상태가 안전한가(fail-fast)"라는 원칙은 동일하게 적용**된다. 설정 서버를 쓰더라도 "설정을 못 받으면 이전 값으로 그냥 뜬다"가 아니라 "못 받으면 뜨지 않는다"가 기본이어야 한다.

---

## 한 줄 요약

프로파일은 하나의 빌드를 환경별 설정으로 갈아 끼우는 스위치이고, 공통은 `application.yml`·환경 의존 설정은 `application-{profile}.yml`로 나누되 — 안전을 실제로 만드는 것은 프로파일 자체가 아니라 **"기동에 필수인 DataSource URL을 공통 yml에서 비워 두는 설계 결정"**이며, 그 결정 덕분에 프로파일 누락이라는 흔한 휴먼 에러가 "운영이 로컬 DB에 붙는 조용한 사고"가 아니라 "`(no profiles are currently active)`라고 찍히는 배포 즉시의 기동 실패"로 격하되는, 안전한 기본값 설계가 완성된다.
