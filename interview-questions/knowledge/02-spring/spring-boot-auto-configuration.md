# Spring Boot Auto Configuration — "알아서 해주는 마법"의 실체는 조건부 빈 등록

> 핵심 관전 포인트: **`@SpringBootApplication` 안의 `@EnableAutoConfiguration`이
> 시작점이다. 부트는 클래스패스의 각 jar에 들어 있는
> `META-INF/spring/...AutoConfiguration.imports` 파일에서 자동 구성 후보
> 클래스 목록을 읽고, 후보마다 `@ConditionalOnClass`(클래스패스에 있나),
> `@ConditionalOnMissingBean`(사용자가 직접 등록 안 했나) 같은 **조건을
> 평가해 통과한 것만** 빈으로 등록한다. 그래서 의존성만 추가하면
> DataSource가 "알아서" 생기고, 내가 같은 타입 빈을 직접 등록하면
> 자동 구성이 물러난다(사용자 빈 우선). 마법이 아니라
> **"조건 붙은 @Configuration의 대량 자동 import"**다.**

---

## 0. 질문 + 의도

**질문**: "Spring Boot의 Auto Configuration은 어떻게 동작하나요?"

**출제 의도**: "스프링부트가 알아서 해줬는데 왜 안 되지"라는 상황 — 빈 충돌,
의존성 추가만으로 바뀐 동작 — 에서 원인을 추적하려면 자동 설정의 조건부
로딩을 이해해야 한다. 마법을 마법으로 두는 사람은 이 유형의 문제에서 항상
막히므로, 프레임워크의 동작을 원리로 이해하는지를 확인하는 질문이다.

## 1. 시작점 — @SpringBootApplication을 펼쳐 보면

```java
@SpringBootApplication
// = 아래 세 개를 합친 것
// @SpringBootConfiguration    → 이 클래스 자체가 설정 클래스
// @ComponentScan              → 내 패키지 하위의 @Component들을 스캔
// @EnableAutoConfiguration    → ★ 자동 구성의 시작점
public class MyApplication { ... }
```

역할 분담이 핵심이다:

- `@ComponentScan`은 **내가 짠 코드**(내 패키지의 `@Service`, `@Repository`)를
  빈으로 등록한다.
- `@EnableAutoConfiguration`은 **내가 안 짠 코드** — 라이브러리 쪽에서
  미리 만들어 둔 설정 클래스들 — 을 조건에 맞춰 등록한다.

비유하면, 컴포넌트 스캔은 "내 집 안 물건 정리"이고, 자동 구성은
"이사 올 때 가전(의존성)을 들여놓으면 설치 기사(부트)가 조건 보고
알아서 연결해 주는 것"이다.

## 2. 여기서 "설정"이란 — yml이 아니라 빈 조립 코드

자동 "설정(configuration)"이라는 말에서 설정값 파일(application.yml)을
떠올리기 쉽지만, 여기서 설정은 **빈을 만들어 컨테이너에 등록하는
자바 코드** — 즉 `@Configuration` 클래스와 그 안의 `@Bean` 메서드 —
를 말한다. 부트 이전에는 이런 코드를 전부 개발자가 직접 썼다.

```java
// 부트 없던 시절 — 개발자가 직접 쓰던 "설정"
@Configuration
public class MyDbConfig {
    @Bean
    public DataSource dataSource() {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:mysql://...");
        ds.setUsername("...");
        return ds;
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource ds) {
        return new JdbcTemplate(ds);
    }
}
```

자동 구성은 **이런 조립 코드를 라이브러리 쪽에서 미리 작성해 두고,
조건에 맞으면 부트가 대신 실행해 주는 것**이다. 그래서 내 프로젝트에
위 코드가 없어도 `JdbcTemplate`을 주입받아 쓸 수 있다. yml의 프로퍼티
값(`spring.datasource.url` 등)은 이 조립 코드가 **읽어 가는 입력값**이지
설정 그 자체가 아니다.

**대표적으로 무엇이 자동 구성되나:**

| 의존성을 추가하면 | 자동으로 생기는 빈 |
|---|---|
| `spring-boot-starter-web` | 내장 톰캣, `DispatcherServlet`, JSON 변환기(`MappingJackson2HttpMessageConverter`) |
| `spring-boot-starter-data-jpa` | `DataSource`(HikariCP 커넥션 풀), `EntityManagerFactory`, `TransactionManager` |
| `spring-boot-starter-security` | 시큐리티 필터 체인 (의존성만 넣어도 모든 요청에 인증이 걸리는 이유) |
| jackson (web에 포함) | `ObjectMapper` |
| `spring-boot-starter-data-redis` | `RedisConnectionFactory`, `RedisTemplate` |

공통 패턴: **"의존성(jar)을 추가했다 = 그걸 쓰겠다는 의사표시"로 간주**하고,
그 라이브러리를 쓰는 데 필요한 기반 빈들을 프로퍼티 값을 반영해 만들어
준다. 즉 자동 구성의 대상은 **애플리케이션 컨텍스트 안의 빈 조립**이다.

## 3. 후보 목록은 어디서 오나 — imports 파일 (버전 차이 주의)

`@EnableAutoConfiguration`이 import하는 `AutoConfigurationImportSelector`가
클래스패스의 모든 jar에서 다음 파일을 읽는다.

```
# Spring Boot 3.x — 각 자동구성 jar 안에 존재
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports

# 파일 내용: 자동 구성 클래스의 FQCN이 한 줄에 하나씩
org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration
...
```

- **부트 2.x까지는** `META-INF/spring.factories` 파일의
  `EnableAutoConfiguration=...` 키로 같은 목록을 관리했다.
  2.7에서 imports 방식이 도입되고 3.0에서 spring.factories 방식이
  제거됐다 — 버전 차이를 언급하면 가산점 포인트.
- 중요한 건 **이 시점에는 "후보 목록"일 뿐**이라는 것. 수백 개의
  자동 구성 클래스가 전부 로드되는 게 아니라, 다음 단계의
  조건 평가를 통과한 것만 실제 설정으로 쓰인다.

## 4. 조건 평가 — @Conditional 계열이 문지기

각 자동 구성 클래스에는 "이 조건일 때만 활성화"라는 문지기 애너테이션이
붙어 있다. 대표 3종:

- `@ConditionalOnClass` — 클래스패스에 특정 클래스가 있을 때만.
  ("HikariCP jar가 있어야 커넥션 풀 설정을 하지")
- `@ConditionalOnMissingBean` — **사용자가 같은 타입 빈을 직접 등록하지
  않았을 때만.** (사용자 빈 우선의 핵심 장치)
- `@ConditionalOnProperty` — 특정 프로퍼티가 켜져 있을 때만.

실제 자동 구성 클래스의 구조를 단순화하면 이렇다.

```java
@AutoConfiguration
@ConditionalOnClass(DataSource.class)        // ① jdbc 의존성이 있어야
public class DataSourceAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(DataSource.class)  // ② 사용자가 직접 안 만들었을 때만
    public DataSource dataSource(DataSourceProperties props) {
        return props.initializeDataSourceBuilder().build();
    }
}
```

이 두 조건의 합작이 부트의 사용 경험 전체를 설명한다:

- `spring-boot-starter-data-jpa`를 추가하면 → ①이 참이 되어
  DataSource/EntityManagerFactory가 "알아서" 생긴다.
- 내가 `@Bean DataSource`를 직접 등록하면 → ②가 거짓이 되어
  부트의 기본 DataSource는 **조용히 물러난다(back-off)**.
  덮어쓰기 경쟁이 아니라 "사용자가 정의하면 나는 빠진다"는 설계다.

```java
// 사용자 설정이 항상 이긴다
@Configuration
public class MyDataSourceConfig {
    @Bean
    public DataSource dataSource() {
        // 내가 등록하는 순간 DataSourceAutoConfiguration의
        // 기본 DataSource는 조건 불충족으로 생성 자체가 안 됨
        return new HikariDataSource(myCustomConfig());
    }
}
```

같은 원리로 `ObjectMapper`, `RestTemplateBuilder`, `TaskExecutor` 등도
"의존성 추가 → 기본 빈 제공, 직접 정의 → 기본 빈 후퇴"로 동작한다.

## 5. 실무 — "자동 구성이 안 먹을 때" 추적하는 법

출제 의도가 정확히 여기다. "부트가 알아서 해줬는데 왜 안 되지?" 상황에서
마법을 마법으로 두는 사람은 막히고, 조건 평가를 이해하는 사람은 추적한다.

**안 먹는 원인은 보통 셋 중 하나:**

1. **조건 불충족** — 필요한 클래스가 클래스패스에 없거나(의존성 누락),
   `@ConditionalOnProperty` 조건 프로퍼티가 꺼져 있음
2. **빈 충돌 / back-off** — 어딘가(내 코드, 사내 공통 라이브러리)에서
   같은 타입 빈을 등록해서 자동 구성이 물러난 경우.
   특히 **공통 라이브러리가 몰래 등록한 빈** 때문에 기본 동작이 바뀌는
   케이스가 실무에서 자주 나온다.
3. **명시적 exclude** — 누군가 `exclude` 설정으로 꺼 둔 경우

**추적 도구 — ConditionEvaluationReport:**

```bash
# --debug로 기동하면 조건 평가 리포트가 로그로 출력됨
java -jar app.jar --debug
```

```
============================
CONDITIONS EVALUATION REPORT
============================
Positive matches:     ← 조건을 통과해 적용된 자동 구성
   DataSourceAutoConfiguration matched:
      - @ConditionalOnClass found required class 'javax.sql.DataSource'

Negative matches:     ← 탈락한 자동 구성과 "탈락 사유"
   RabbitAutoConfiguration:
      Did not match:
         - @ConditionalOnClass did not find required class
           'com.rabbitmq.client.Channel'
```

Negative matches의 탈락 사유를 읽으면 "왜 이 빈이 안 생겼는지"가
그대로 나온다. 운영 중인 앱이라면 actuator의 `conditions` 엔드포인트
(`/actuator/conditions`)로 같은 리포트를 조회할 수 있다.

**특정 자동 구성을 의도적으로 끄는 법:**

```java
// 방법 1: 애너테이션 속성
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
```

```yaml
# 방법 2: 프로퍼티 (코드 수정 없이 환경별로 제어 가능)
spring:
  autoconfigure:
    exclude: org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
```

## 6. 꼬리질문 대비 포인트

### "내가 DataSource 빈을 직접 등록하면 부트의 자동 구성 DataSource는 어떻게 되나?"

생성 자체가 안 된다. 자동 구성의 DataSource `@Bean` 메서드에
`@ConditionalOnMissingBean`이 붙어 있어서, 컨테이너에 이미 사용자
정의 DataSource가 있으면 조건 불충족으로 그 메서드가 실행되지 않는다.
"두 개 생겼다가 하나가 이기는" 게 아니라 **애초에 하나만 만들어진다.**
이를 위해 자동 구성은 **사용자 설정이 모두 처리된 뒤에 평가되도록**
순서가 보장된다(그래야 "사용자 빈이 이미 있는지"를 확인할 수 있으므로).

### "@ConditionalOnClass는 클래스가 없어도 왜 자동 구성 클래스 로딩이 안 터지나?"

이 질문이 어려운 이유는 **"애초에 왜 터질 수 있는데?"라는 전제**가
생략되어 있어서다. 전제부터 채우면:

**전제 — 원래는 터져야 정상인 상황이다.** JVM은 클래스를 로딩할 때
그 클래스가 참조하는 다른 클래스가 클래스패스에 없으면
`NoClassDefFoundError`를 던진다. 그런데 자동 구성 클래스는 이런 모양이다.

```java
@AutoConfiguration
@ConditionalOnClass(RabbitTemplate.class)   // ← RabbitMQ 클래스를 참조!
public class RabbitAutoConfiguration {
    @Bean
    public RabbitTemplate rabbitTemplate() { ... }  // ← 여기도 참조!
}
```

이 `RabbitAutoConfiguration.class` 파일은 내가 RabbitMQ를 안 써도
부트 jar 안에 **항상 들어 있다**. 부트는 기동 시 이 클래스를 후보로
읽어 조건을 평가해야 하는데, 내 프로젝트에 RabbitMQ jar가 없으니
상식적으로는 로딩하는 순간 `RabbitTemplate`을 못 찾아 터져야 한다.
**"클래스가 있는지 확인하려고 클래스를 로딩하면, 그 로딩 자체가
터진다"는 닭-달걀 문제**인 것이다.

**답 — 클래스를 JVM에 로딩하지 않고, .class 파일을 텍스트 읽듯 읽는다.**
스프링은 ASM이라는 바이트코드 리더로 `.class` 파일의 바이트를 직접
읽어서 "이 클래스에 `@ConditionalOnClass`가 붙어 있고, 조건 값이
문자열로 `...RabbitTemplate`이구나"라는 **메타데이터만** 뽑아낸다.
바이트코드 안에서 애너테이션 속성은 그냥 문자열이라서, 그 문자열이
가리키는 클래스가 실존하는지와 무관하게 읽을 수 있다.

비유하면 **택배 상자를 열지 않고 겉에 붙은 송장만 읽는 것**이다.
상자를 열면(= 클래스 로딩) 내용물이 깨져 있어 사고가 나지만,
송장(= 애너테이션 메타데이터)만 읽고 "이건 우리 집 물건 아니네" 하고
반송하면 안전하다.

```
1. imports 파일에서 후보 이름(문자열)만 수집     ← 로딩 없음
2. ASM으로 .class 파일 읽어 조건 애너테이션 추출  ← 로딩 없음
3. "RabbitTemplate이 클래스패스에 있나?" 확인    ← 없음 → 탈락
4. 탈락한 클래스는 끝까지 JVM에 로딩되지 않음     ← 그래서 안 터짐
5. 조건 통과한 클래스만 진짜 로딩 → @Bean 실행
```

즉 답의 핵심은 **조건 평가가 클래스 로딩보다 먼저, 로딩 없이
일어난다는 순서**에 있다.
(가산점 포인트: 그래서 자동 구성 클래스를 직접 만들 때도 조건부
클래스 참조는 `@Bean` 메서드 안쪽에 두는 것이 안전하다 — 클래스
로딩 단계가 아니라 메서드 실행 시점까지 참조 해석이 미뤄지기 때문.)

### "자동 구성 클래스끼리 순서는 어떻게 정해지나?"

`@AutoConfigureBefore` / `@AutoConfigureAfter` / `@AutoConfigureOrder`로
자동 구성 **클래스 간의 상대 순서**를 선언한다. 예를 들어 JPA 자동
구성은 DataSource 자동 구성 이후에 평가되어야 한다(DataSource 빈
존재 여부를 조건으로 보기 때문). 주의할 점: 이 애너테이션들은
**자동 구성 클래스에만 적용**되고, 일반 사용자 `@Configuration`의
순서 제어 수단이 아니다. 그리고 사용자 설정 전체는 항상 자동 구성보다
먼저 처리된다.

### "직접 스타터/자동 구성 모듈을 만들려면?"

사내 공통 라이브러리를 만들 때 그대로 쓰는 레시피다.

1. `@AutoConfiguration` 클래스를 작성하고 `@ConditionalOnClass`,
   `@ConditionalOnMissingBean` 등 조건을 건다 —
   **사용자가 재정의하면 물러나도록** 설계하는 게 관례.
2. `META-INF/spring/...AutoConfiguration.imports` 파일에 그 클래스의
   FQCN을 등록한다 (컴포넌트 스캔 대상 패키지에 두는 게 아니다 —
   스캔에 걸리면 조건 평가 체계 밖에서 무조건 등록돼 버린다).
3. 설정값은 `@ConfigurationProperties`로 노출해 yml로 제어 가능하게 한다.
4. 관례상 자동 구성 모듈(`xxx-spring-boot-autoconfigure`)과 의존성 묶음
   모듈(`xxx-spring-boot-starter`)을 분리한다.

### "자동 구성의 단점이나 비용은?" (시니어 변별 포인트)

- **암묵성**: 어떤 빈이 왜 생겼는지 코드만 봐서는 안 보인다. 팀원이
  의존성 하나 추가했을 뿐인데 시큐리티 필터 체인이나 기본 동작이
  통째로 바뀌는 식의 "원거리 부수효과"가 생긴다. 그래서 의존성 추가는
  설정 변경과 같은 무게로 리뷰해야 한다.
- **기동 비용**: 후보 전체에 대한 조건 평가가 기동 시간에 더해진다.
- **암묵적 기본값 리스크**: 커넥션 풀 크기, 타임아웃 같은 기본값을
  "부트가 알아서"에 맡기고 운영에 나가면 트래픽 상황에서 기본값이
  병목이 된다. **"기본값에 의존하되, 운영 크리티컬한 값은 명시적으로
  고정한다"**는 원칙과, 문제 발생 시 `--debug`/actuator `conditions`로
  추적한다는 답까지 이어지면 균형 잡힌 인상을 준다.

---

## 한 줄 요약

Auto Configuration은 마법이 아니라 **"imports 파일로 모은 후보 설정
클래스들을 @Conditional 조건 평가로 걸러 등록하는 메커니즘"**이며,
`@ConditionalOnMissingBean` 덕분에 사용자 빈이 항상 우선하고,
안 먹을 때는 `--debug`의 ConditionEvaluationReport에서
탈락 사유를 읽는 것이 추적의 정석이다.
