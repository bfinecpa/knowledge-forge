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

이 질문이 어려운 이유는 **"애초에 뭐가 문제인데?"라는 전제**가 통째로
생략되어 있어서다. 전제를 세 계단으로 나눠 채워야 질문이 보인다.

#### 전제 ① — 자동 구성 클래스는 안 써도 **항상** 클래스패스에 있다

`build.gradle`에 `spring-boot-starter-web` 하나만 넣어도, 실제로 받아지는
jar 안은 이렇다.

```
spring-boot-autoconfigure-3.x.jar
 └─ org/springframework/boot/autoconfigure/
     ├─ web/     ServletWebServerFactoryAutoConfiguration.class
     ├─ jdbc/    DataSourceAutoConfiguration.class
     ├─ amqp/    RabbitAutoConfiguration.class      ← RabbitMQ 안 썼는데도 있음
     ├─ kafka/   KafkaAutoConfiguration.class       ← 있음
     └─ ... 150개 남짓
```

부트는 기술별로 jar를 쪼개지 않았다. **모든 기술의 자동 구성 클래스를
하나의 거대한 jar에 전부 담아** 두고, 어떤 스타터를 쓰든 이 jar가
통째로 딸려온다.

> ❌ "RabbitMQ 스타터를 넣어야 `RabbitAutoConfiguration`이 생긴다"
> ✅ "`RabbitAutoConfiguration`은 **처음부터 항상 있다.** 안 쓰면 조건에서 탈락할 뿐"

#### 전제 ② — 그래서 "설명서는 있는데 부품이 없는" 비대칭이 생긴다

| 클래스 | 어느 jar에? | web만 쓰는 내 프로젝트에 |
|---|---|---|
| `RabbitAutoConfiguration` (**설정하는** 쪽) | `spring-boot-autoconfigure.jar` | ✅ **있다** |
| `RabbitTemplate` (**설정당하는** 쪽) | `spring-rabbit.jar` | ❌ **없다** |

그리고 `RabbitAutoConfiguration`은 imports 후보 목록에 이름이 올라와
있으므로, 부트는 **얘한테도 반드시 조건을 물어봐야 한다.** 건너뛸 수
없다 — 건너뛰려면 먼저 "얘는 아니구나"를 알아야 하는데, 그걸 알려면
물어봐야 하니까.

#### 전제 ③ — 그런데 그 조건 자체가 모순으로 생겼다

```java
@AutoConfiguration
@ConditionalOnClass(RabbitTemplate.class)   // ← 없을지도 모르는 클래스를 실명으로 지목
public class RabbitAutoConfiguration {
    @Bean
    public RabbitTemplate rabbitTemplate(ConnectionFactory cf) { ... }  // ← 여기도
}
```

`RabbitTemplate.class`는 자바의 **클래스 리터럴**이다. "`RabbitTemplate`이
있는지 확인하겠다"고 말하면서, 그 문장 안에서 `RabbitTemplate`을 직접
데려오라고 요구하고 있다.

**비유:** 김철수 씨가 집에 있는지 확인하려고 **김철수 씨한테 전화를 건다.**
없으면 안 받을 텐데, 안 받는다는 걸 알려면 전화를 걸어야 한다.

```
조건을 평가하려면 → @ConditionalOnClass의 값을 읽어야 하고
그 값을 읽으려면  → RabbitTemplate을 데려와야 하는데
RabbitTemplate은  → 없다 (그걸 확인하려던 참이었다)
```

**이 닭-달걀이 질문의 정체다.** 풀어 쓰면 "없는 클래스를 실명으로
지목하는 애너테이션을, 부트는 어떻게 사고 없이 읽어내느냐?"

#### 정확히 어디서 터지는가 — 로딩이 아니라 **리플렉션**이다

여기서 흔한 오해 하나를 짚어야 한다. "클래스를 로딩하면 참조 클래스가
없어서 터진다"는 설명은 **사실이 아니다.** JVM의 심볼 해석(resolution)은
**게을러서(lazy)**, 로딩만으로는 상수 풀의 참조를 해석하지 않는다.

```java
Class<?> c = Class.forName("...RabbitAutoConfiguration");  // ① 안 터진다
System.out.println(c.getName());                           //    잘 출력됨
```

터지는 건 **로딩한 클래스를 리플렉션으로 들여다볼 때**다. 그리고 조건을
평가하려면 반드시 들여다봐야 한다.

```java
ConditionalOnClass ann = c.getAnnotation(ConditionalOnClass.class);  // ② OK
Class<?>[] required = ann.value();                          // ③ 💥 여기서 터진다
```

**③이 왜 터지나:** `value()`의 반환 타입이 `Class[]`다. 즉 나에게 값을
돌려주려면 `RabbitTemplate`의 **`Class` 객체를 실제로 만들어서** 배열에
담아 줘야 한다. jar가 없으니 실패하고, JDK는 `TypeNotPresentException`을
던진다. 같은 이유로 `c.getDeclaredMethods()`도 터진다 — `Method` 객체를
만들려면 반환 타입 `RabbitTemplate`을 해석해야 하기 때문이다.

#### 답 — 자바 코드로 읽지 않고, **파일**로 읽는다

전화를 걸지 않고 **문패를 본다.** `RabbitAutoConfiguration.class`는 결국
디스크의 파일이고, 그 안에서 애너테이션은 이렇게 저장돼 있다.

```
RuntimeVisibleAnnotations:
  ConditionalOnClass(
    value = [ "Lorg/springframework/amqp/rabbit/core/RabbitTemplate;" ]
                            ↑ 이건 그냥 글자다. 클래스가 아니다.
  )
```

종이에 적힌 "김철수"라는 글씨를 읽는 데 김철수 씨가 실존할 필요는 없다.
그래서 스프링은 **ASM**이라는 바이트코드 리더로 `.class` 파일의 바이트를
직접 읽어 이름 문자열만 뽑아낸다.

| | **리플렉션** (자바 코드로 읽기) | **ASM** (파일로 읽기) |
|---|---|---|
| 읽는 대상 | JVM에 올라간 `Class` 객체 | 디스크의 `.class` 파일 바이트 |
| 조건 값의 타입 | `Class[]` → **실물 객체가 필요** | `String[]` → **이름이면 충분** |
| 없는 클래스면 | 💥 실물을 못 만들어 터짐 | 😌 글자만 읽고 끝 |

```java
// ❌ 리플렉션 — 터진다
Class<?>[] v = clazz.getAnnotation(ConditionalOnClass.class).value();
//   → Class 객체를 돌려주려면 RabbitTemplate을 실제로 로딩해야 함 → 💥

// ✅ ASM (MetadataReader) — 안 터진다
String[] v = (String[]) asmMetadata
        .getAnnotationAttributes(ConditionalOnClass.class.getName()).get("value");
//   → ["org.springframework.amqp.rabbit.core.RabbitTemplate"]  그냥 문자열
```

**`Class[]` → `String[]`. 이 반환 타입 하나 바뀐 게 해결의 핵심이다.**

이제 문자열을 손에 쥐었으니, **내가 통제하는 방식으로** 존재를 확인한다.

```java
// Spring의 ClassUtils.isPresent()
try {
    Class.forName(className, false, classLoader);  // false = 초기화하지 마라
    return true;
} catch (Throwable ex) {
    return false;   // ← 없는 게 정상 시나리오다. 예외를 예상하고 삼킨다.
}
```

여기서도 결국 로딩을 시도하지만, **내가 원하는 시점에 try-catch로 감싼 채**
부른다. 애너테이션 리플렉션에는 이 통제권이 없다.

#### 전체 흐름

```
1. imports 파일에서 후보 이름 150개 수집          ← 전부 문자열. 로딩 없음
2. ASM으로 .class 파일 파싱 → 조건 값을 문자열로 추출  ← 로딩 없음
3. ClassUtils.isPresent("...RabbitTemplate") → false  ← try-catch로 통제된 로딩
4. RabbitAutoConfiguration 탈락. JVM에 흔적조차 안 남음
5. 조건 통과한 20~30개만 진짜 로딩 → 리플렉션 → @Bean 실행
```

즉 답의 핵심은 **조건 평가가 클래스 로딩보다 먼저, 로딩 없이 일어난다는
순서**에 있다. 부수 효과도 크다 — 후보 150개 중 탈락할 120여 개가 JVM에
아예 안 올라가므로 기동 속도와 메타스페이스를 아낀다.

#### 곁가지 — "그럼 스프링은 그 소스를 어떻게 컴파일했나?"

`@ConditionalOnClass(RabbitTemplate.class)`라는 **소스**를 컴파일하려면
컴파일 시점에는 `RabbitTemplate`이 반드시 있어야 한다. 스프링 팀은
`spring-boot-autoconfigure`를 빌드할 때 RabbitMQ·Kafka·Redis를 전부
`optional` 의존성으로 걸어 놓고 컴파일한다. `optional`은 **"컴파일엔
필요하지만 이 jar를 쓰는 사람에게 전파하지는 마라"**는 뜻이다.

- **스프링 팀의 빌드 시점**: `RabbitTemplate` 있음 → 컴파일 성공
- **내 프로젝트의 실행 시점**: `RabbitTemplate` 없음 → 그래서 ASM이 필요

이 두 시점의 간극이 문제의 근원이고, ASM이 그 간극을 메운다.

(가산점 포인트: 그래서 자동 구성 모듈을 직접 만들 때, 없을 수 있는
타입이 `@Bean` 메서드의 **시그니처**(반환 타입·파라미터)에 등장하면
위험하다 — 바깥 클래스가 조건을 통과하는 순간 리플렉션 대상이 되어
`NoClassDefFoundError`가 난다. 부트가 실제로 쓰는 관례는 그런 `@Bean`을
**자체 `@ConditionalOnClass`를 단 중첩 static 설정 클래스로 격리**하는
것이다. 중첩 클래스의 조건도 ASM으로 먼저 평가되므로 안전하게 통째로
건너뛴다.)

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
