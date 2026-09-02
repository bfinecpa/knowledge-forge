# Spring Boot Auto Configuration — "알아서 해주는 마법"의 실체는 조건부 빈 등록

> 핵심 관전 포인트: **여기서 자동화되는 "설정"은 `application.yml`이 아니라 **빈을 만들어 컨테이너에 등록하는 자바 코드**(`@Configuration` + `@Bean`)다. `@SpringBootApplication` 안의 `@EnableAutoConfiguration`이 시작점이고, 부트는 클래스패스의 각 jar에 들어 있는 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 파일에서 자동 구성 후보 클래스 목록을 읽은 뒤, 후보마다 `@ConditionalOnClass`(클래스패스에 있나) · `@ConditionalOnMissingBean`(사용자가 직접 등록 안 했나) 같은 **조건을 평가해 통과한 것만** 빈 정의로 등록한다. 이 조건 평가는 런타임이 아니라 **빈 정의를 등록하는 단계**에서 일어나고, 자동 구성은 `DeferredImportSelector`라서 **사용자 설정이 전부 처리된 뒤에 맨 마지막으로** 평가된다 — 내가 만든 `DataSource` 빈이 부트의 기본 `DataSource`를 이기는 메커니즘은 이 "순서"가 전부다. 그래서 의존성만 추가하면 `DataSource`가 알아서 생기고, 내가 같은 타입 빈을 직접 등록하면 자동 구성이 조용히 물러난다. 마법이 아니라 **"조건 붙은 @Configuration의 대량 자동 import"**이며, 안 먹을 때는 `--debug`의 `CONDITIONS EVALUATION REPORT`에서 탈락 사유를 읽는 것이 추적의 정석이다.**

---

## 0. 질문 + 의도

**질문**: "Spring Boot의 Auto Configuration은 어떻게 동작하나요?"

**출제 의도**: "스프링부트가 알아서 해줬는데 왜 안 되지"라는 상황 — 빈 충돌, 의존성 추가만으로 바뀐 동작 — 에서 원인을 추적하려면 자동 설정의 조건부 로딩을 이해해야 한다. 마법을 마법으로 두는 사람은 이 유형의 문제에서 항상 막히므로, 프레임워크의 동작을 원리로 이해하는지를 확인하는 질문이다.

## 1. 먼저 오해부터 걷어내자 — 여기서 "설정"은 yml이 아니다

### 1-1. 자동 구성은 "yml을 안 써도 되게 해주는 기능"이 아니다

"자동 설정(auto configuration)"이라는 이름 때문에 가장 흔하게 생기는 오해가 이것이다. `application.yml`을 채우는 일을 부트가 대신해 준다는 오해다. 이 오해를 안고 문서를 읽으면 뒤에 나오는 조건 평가나 back-off가 전부 엉뚱하게 들리므로, 여기서부터 바로잡고 시작한다.

스프링 세계에서 **설정(configuration)이라는 단어는 두 가지 완전히 다른 것을 가리킨다.** 이 둘을 구분하는 것이 이 질문 전체의 출발점이다.

| 부르는 말 | 실체 | 파일 예 | 자동 구성의 대상인가 |
|---|---|---|---|
| 설정값(properties) | 문자열·숫자 같은 **값** | `application.yml`, 환경변수 | 아니다. 내가 직접 쓴다 |
| 설정 클래스(configuration) | 빈을 만들어 등록하는 **자바 코드** | `@Configuration` + `@Bean` | **이것이 자동화된다** |

자동 구성이 대신 써주는 것은 **아래쪽, 즉 빈 조립 코드**다. 값이 아니다. `spring.datasource.url`은 여전히 내가 yml에 적어야 하고, 부트는 그 값을 읽어다가 `HikariDataSource`를 만들어 컨테이너에 넣는 **코드**를 대신 실행해 준다.

이 한 문장으로 정리된다. **자동 구성은 "무엇을 만들지"를 자동화하고, yml은 "어떤 값으로 만들지"를 내가 지정하는 자리다.**

### 1-2. 부트 이전에는 이 조립 코드를 사람이 직접 썼다

왜 이런 게 필요했는지는 부트 이전 코드를 보면 바로 납득된다. 아래는 스프링 부트가 없던 시절 개발자가 프로젝트마다 손으로 쓰던 "설정 클래스"다.

```java
// before: 부트 없던 시절 — 개발자가 프로젝트마다 직접 쓰던 조립 코드
@Configuration
public class MyDbConfig {

    @Bean
    public DataSource dataSource() {
        // 커넥션 풀 구현체를 고르고, 접속 정보를 넣고, 빈으로 만들어 등록하는
        // 이 세 줄이 "설정 클래스"가 하는 일 전부다.
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl("jdbc:postgresql://localhost:5432/order");
        ds.setUsername("order_app");
        return ds;
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource ds) {
        // DataSource 빈이 있어야만 만들 수 있다 — 조립에는 순서와 의존이 있다.
        return new JdbcTemplate(ds);
    }
}
```

이 코드는 프로젝트가 백 개면 백 번 똑같이 쓰인다. 값(URL, 계정)만 다르고 조립 절차는 늘 같기 때문이다. 자동 구성은 **바로 이 반복되는 조립 절차를 라이브러리 쪽에 미리 작성해 두고, 조건에 맞으면 부트가 대신 실행하는 것**이다.

```java
// after: 부트를 쓰면 위 클래스가 통째로 사라진다.
// 내 프로젝트에 남는 것은 "값"뿐이다.
//
// application.yml
//   spring.datasource.url: jdbc:postgresql://localhost:5432/order
//   spring.datasource.username: order_app
//
// 그리고 이렇게 바로 주입받아 쓴다.
@Service
public class OrderQuery {
    private final JdbcTemplate jdbc;   // 내가 만든 적 없는 빈인데 주입된다
    public OrderQuery(JdbcTemplate jdbc) { this.jdbc = jdbc; }
}
```

부트가 실행해 주는 그 조립 코드는 `DataSourceProperties`라는 객체를 통해 yml의 `spring.datasource.*` 값을 읽어 간다. **yml은 조립 코드가 읽어 가는 입력값이지, 자동화의 대상이 아니다.**

### 1-3. 대표적으로 무엇이 자동 구성되나

| 의존성을 추가하면 | 자동으로 생기는 빈 |
|---|---|
| `spring-boot-starter-web` | 내장 톰캣, `DispatcherServlet`, JSON 변환기(`MappingJackson2HttpMessageConverter`) |
| `spring-boot-starter-data-jpa` | `DataSource`(HikariCP 커넥션 풀), `EntityManagerFactory`, `TransactionManager` |
| `spring-boot-starter-security` | 시큐리티 필터 체인 (의존성만 넣어도 모든 요청에 인증이 걸리는 이유) |
| jackson (web에 포함) | `ObjectMapper` |
| `spring-boot-starter-data-redis` | `RedisConnectionFactory`, `RedisTemplate` |
| `spring-boot-starter-amqp` | `ConnectionFactory`, `RabbitTemplate`, `RabbitAdmin` |

공통 패턴이 보인다. **"의존성(jar)을 추가했다 = 그걸 쓰겠다는 의사표시"로 간주**하고, 그 라이브러리를 쓰는 데 필요한 기반 빈들을 프로퍼티 값을 반영해 만들어 준다.

특히 세 번째 줄, 시큐리티가 이 성질을 가장 극적으로 보여준다. `build.gradle`에 한 줄 추가했을 뿐인데 모든 엔드포인트가 로그인 화면으로 리다이렉트된다. 코드 어디에도 그런 지시는 없다. **의존성 추가가 곧 설정 변경**이라는 사실을 몸으로 알려주는 사례다.

### 1-4. 비유 — 이사 온 집의 가전 설치 기사

컴포넌트 스캔과 자동 구성의 역할 분담을 비유로 잡아 두면 뒤가 쉽다.

`@ComponentScan`은 **내 집 안 물건 정리**다. 내가 사 온 물건(`@Service`, `@Repository`)을 제자리에 놓는 일이라 대상이 전부 내 것이다.

자동 구성은 **가전 설치 기사**다. 내가 세탁기(의존성)를 들여놓으면 기사가 와서 수도와 배수를 연결해 준다. 단, 기사는 조건을 본다 — 세탁기가 실제로 배달돼 있는지(`@ConditionalOnClass`), 내가 이미 직접 배관을 연결해 뒀는지(`@ConditionalOnMissingBean`)를 확인하고, 이미 해뒀으면 손대지 않고 물러난다.

## 2. 동작 원리 — 후보 수집 → 조건 평가 → 빈 정의 등록

### 2-1. 시작점 — @SpringBootApplication을 펼쳐 보면

```java
@SpringBootApplication
// = 아래 세 개를 합친 것
// @SpringBootConfiguration    → 이 클래스 자체가 설정 클래스
// @ComponentScan              → 내 패키지 하위의 @Component들을 스캔
// @EnableAutoConfiguration    → ★ 자동 구성의 시작점
public class MyApplication { ... }
```

역할 분담이 핵심이다. `@ComponentScan`은 **내가 짠 코드**를 빈으로 등록하고, `@EnableAutoConfiguration`은 **내가 안 짠 코드** — 라이브러리 쪽에서 미리 만들어 둔 설정 클래스들 — 을 조건에 맞춰 등록한다.

`@EnableAutoConfiguration`이 실제로 하는 일은 `AutoConfigurationImportSelector`라는 클래스를 import하는 것 하나뿐이다. 이 클래스가 아래 2-2부터의 전 과정을 수행한다.

### 2-2. 후보 목록은 어디서 오나 — imports 파일

`AutoConfigurationImportSelector`는 클래스패스의 **모든 jar**를 뒤져 다음 경로의 파일을 전부 읽어 합친다.

```
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports

# 파일 내용: 자동 구성 클래스의 FQCN(패키지까지 포함한 전체 이름)이 한 줄에 하나씩
org.springframework.boot.autoconfigure.admin.SpringApplicationAdminJmxAutoConfiguration
org.springframework.boot.autoconfigure.amqp.RabbitAutoConfiguration
org.springframework.boot.autoconfigure.aop.AopAutoConfiguration
org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
...
```

파일명이 저렇게 긴 이유는 규칙이 `META-INF/spring/{애너테이션 FQCN}.imports`이기 때문이다. `@AutoConfiguration` 애너테이션의 전체 이름이 `org.springframework.boot.autoconfigure.AutoConfiguration`이라 그대로 파일명이 됐다.

**버전 차이를 정확히 짚어 두자.** 이 문서의 서술은 **스프링 부트 3.x 기준**이다.

| 부트 버전 | 후보 목록을 담는 파일 | 비고 |
|---|---|---|
| ~ 2.6 | `META-INF/spring.factories`의 `EnableAutoConfiguration=` 키 | imports 방식 없음 |
| 2.7 | 위 둘 다 동작 | imports 방식 도입, `spring.factories` 방식은 폐기 예정(deprecated) |
| 3.0 ~ | `META-INF/spring/...AutoConfiguration.imports`만 | `spring.factories`의 자동 구성 항목은 **제거됨** |

부트 2.x 시절 사내 라이브러리를 3.x로 올릴 때 "자동 구성이 통째로 안 먹는" 사고의 1순위 원인이 이것이다. `spring.factories`만 들어 있는 라이브러리는 3.x에서 **에러 없이 조용히 무시된다** — 부트가 그 파일의 자동 구성 키를 더는 읽지 않기 때문이다.

여기서 반드시 붙잡아야 할 것은 **이 단계의 결과물은 "후보 목록"일 뿐**이라는 점이다. 실측해 보면 `spring-boot-autoconfigure` 3.5.15의 imports 파일에는 **156줄**이 들어 있다. 이 156개가 전부 적용되는 것이 아니라, 다음 단계의 조건 평가를 통과한 것만 실제 설정으로 쓰인다. 웹 + JPA 정도의 평범한 애플리케이션이라면 통과하는 것은 대개 20~30개 수준이다.

### 2-3. 조건 평가 — @Conditional 계열이 문지기

각 자동 구성 클래스에는 "이 조건일 때만 활성화"라는 **문지기 애너테이션**이 붙어 있다. 클럽 입구에서 신분증을 확인하고 통과 여부를 판정하는 사람처럼, 후보 하나하나에 질문을 던져 통과·탈락을 가른다.

대표 3종을 그 자리에서 정의하면 이렇다.

- `@ConditionalOnClass` — 지정한 클래스가 **클래스패스에 있을 때만** 통과. "HikariCP jar가 있어야 커넥션 풀 설정을 하지"라는 판정이다.
- `@ConditionalOnMissingBean` — 같은 타입 빈이 **아직 등록돼 있지 않을 때만** 통과. 사용자 빈 우선의 핵심 장치다.
- `@ConditionalOnProperty` — 지정한 프로퍼티가 특정 값일 때만 통과. yml로 자동 구성을 켜고 끄는 스위치다.

실제 `DataSourceAutoConfiguration`의 구조를 단순화하면 이렇다.

```java
@AutoConfiguration
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })   // ① jdbc 관련 클래스가 있어야
public class DataSourceAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnMissingBean({ DataSource.class, XADataSource.class }) // ② 사용자가 직접 안 만들었을 때만
    protected static class PooledDataSourceConfiguration {

        @Bean
        public DataSource dataSource(DataSourceProperties props) {
            // props가 yml의 spring.datasource.* 값을 들고 온다 — 1-2에서 말한 "입력값"이 여기로 들어온다.
            return props.initializeDataSourceBuilder().build();
        }
    }
}
```

이 두 조건의 합작이 부트의 사용 경험 전체를 설명한다.

- `spring-boot-starter-data-jpa`를 추가하면 → ①이 참이 되어 `DataSource`·`EntityManagerFactory`가 "알아서" 생긴다.
- 내가 `@Bean DataSource`를 직접 등록하면 → ②가 거짓이 되어 부트의 기본 `DataSource`는 **조용히 물러난다(back-off)**.

```java
// 사용자 설정이 항상 이긴다
@Configuration
public class MyDataSourceConfig {

    @Bean
    public DataSource dataSource() {
        // 이 빈 정의가 등록되는 순간, 자동 구성의 @ConditionalOnMissingBean이
        // "이미 있다"고 판정해 부트의 기본 DataSource는 생성 자체가 안 된다.
        // 두 개 생겼다가 하나가 이기는 게 아니라 애초에 하나만 만들어진다.
        return new HikariDataSource(myCustomConfig());
    }
}
```

같은 원리로 `ObjectMapper`, `RestTemplateBuilder`, `TaskExecutor`, `RabbitTemplate` 등도 전부 "의존성 추가 → 기본 빈 제공, 직접 정의 → 기본 빈 후퇴"로 동작한다.

### 2-4. 조건은 언제 평가되나 — 런타임이 아니라 "빈 정의 등록" 단계다

여기가 이 질문에서 가장 자주 흐려지는 지점이다. 결론부터 말하면 **조건 평가는 애플리케이션이 요청을 받는 런타임에 일어나는 일이 아니고, 심지어 빈 인스턴스가 하나도 만들어지기 전에 끝난다.**

전제 지식을 먼저 깔자. 스프링 컨테이너의 기동은 크게 두 단계다.

```
[1단계] 빈 정의(BeanDefinition) 등록
        "MyService 라는 이름의 빈을, 이 클래스로, 이 생성자 인자로 만들 것이다"
        라는 설계도만 맵에 쌓는 단계. 아직 new 는 한 번도 안 했다.

[2단계] 빈 인스턴스화
        쌓인 설계도를 보고 실제 객체를 만들고 의존성을 주입하는 단계.
```

`@Conditional` 계열은 전부 **1단계에서** 평가된다. `ConfigurationClassPostProcessor`가 설정 클래스를 파싱하면서, 조건을 통과한 클래스의 `@Bean` 메서드만 설계도로 등록하고 탈락한 것은 아예 등록하지 않는다.

이 사실에서 두 가지 중요한 결과가 따라 나온다.

**첫째, `@ConditionalOnMissingBean`이 보는 것은 "이미 생성된 빈"이 아니라 "지금까지 등록된 빈 정의"다.** 아직 아무 객체도 만들어지지 않은 시점이니 당연하다. 스프링 부트의 `@ConditionalOnMissingBean` 자바독도 이 점을 명시한다 — "이 조건은 애플리케이션 컨텍스트가 **여태까지 처리한** 빈 정의에 대해서만 판정할 수 있으며, 따라서 자동 구성 클래스에만 쓰기를 강력히 권장한다."

**둘째, 그래서 이 조건은 순서에 극도로 민감하다.** "여태까지 처리한" 것만 볼 수 있다는 말은, **내 빈 정의가 자동 구성보다 먼저 등록돼 있어야만** 자동 구성이 물러난다는 뜻이다. 순서가 반대면 자동 구성이 먼저 `DataSource`를 등록해 버리고, 나중에 내 빈이 같은 이름으로 들어가려다 충돌하거나 덮어쓰기 정책에 따라 예상 밖 결과가 난다.

그러면 그 순서는 누가 보장하는가. 이것이 다음 절이다.

### 2-5. 순서가 메커니즘의 전부다 — 자동 구성은 맨 마지막에 처리된다

`AutoConfigurationImportSelector`의 선언을 보면 답이 나온다.

```java
public class AutoConfigurationImportSelector implements DeferredImportSelector, ... { }
```

`DeferredImportSelector`는 이름 그대로 **"미뤄진(deferred) import 선택기"**다. 스프링의 설정 클래스 파서는 일반 import를 전부 처리한 뒤, 맨 마지막에 이 종류의 선택기를 실행한다. 자동 구성이 이 인터페이스를 구현했다는 것은 곧 **"내 설정을 다 처리한 다음에 오라"고 스스로 줄 맨 뒤에 선 것**이다.

전체 순서를 도식으로 보면 이렇다.

```
[ConfigurationClassPostProcessor 가 도는 순서 — 전부 "빈 정의를 등록하는" 1단계다]

 ①  @SpringBootApplication 클래스 자신을 설정 클래스로 파싱
      │
 ②  @ComponentScan → 내 패키지의 @Service, @Repository, @Configuration 을 발견
      │
 ③  발견한 내 @Configuration 안의 @Bean 메서드를 빈 정의로 등록
      │        ← 내가 만든 DataSource 빈 정의가 여기서 맵에 들어간다
      │
 ══════════ 여기까지가 "사용자 설정". 이제서야 미뤄 둔 것을 꺼낸다 ══════════
      │
 ④  DeferredImportSelector 실행 = AutoConfigurationImportSelector = 자동 구성
      │
      ├─ imports 파일에서 후보 156개 수집
      ├─ exclude 목록에 있는 것 제거
      ├─ 후보마다 조건 평가
      │    @ConditionalOnMissingBean(DataSource.class)
      │      → ③에서 등록된 빈 정의를 조회 → "이미 있다" → 탈락
      │
      └─ 통과한 20~30개만 빈 정의로 등록
```

**이 그림 하나가 "내가 만든 DataSource 빈이 자동 구성을 이기는" 메커니즘의 전부다.** 우선순위 점수를 비교하거나 나중 것이 앞 것을 덮어쓰는 방식이 아니다. 그저 **내 것이 먼저 등록되고, 자동 구성이 나중에 와서 "이미 있네" 하고 스스로 빠지는 것**이다.

이 순서를 이해하면 부수적인 사실들도 자동으로 설명된다.

- 왜 `@ConditionalOnMissingBean`을 **내** `@Configuration`에 붙이면 안 되는가 → 내 설정끼리는 처리 순서가 보장되지 않아서, 조건을 평가하는 시점에 상대 빈이 아직 등록 전일 수 있다. 결과가 실행할 때마다 달라질 수 있다는 뜻이다.
- 왜 자동 구성끼리는 `@AutoConfigureAfter`로 순서를 선언해야 하는가 → 자동 구성 A가 자동 구성 B의 빈 유무를 조건으로 본다면, A가 B보다 나중에 평가되도록 명시해야 판정이 성립한다.

## 3. 실무 — 자동 구성이 안 먹을 때 추적하는 법

출제 의도가 정확히 여기다. "부트가 알아서 해줬는데 왜 안 되지?" 상황에서 마법을 마법으로 두는 사람은 막히고, 조건 평가를 이해하는 사람은 추적한다.

### 3-1. 안 먹는 원인은 보통 셋 중 하나

**(1) 조건 불충족.** 필요한 클래스가 클래스패스에 없거나(의존성 누락), `@ConditionalOnProperty`가 보는 프로퍼티가 꺼져 있는 경우다. 2-2에서 본 imports 파일 누락(부트 2.x용 사내 라이브러리를 3.x에 쓰는 경우)도 사실상 이 부류다.

**(2) 빈 충돌 / back-off.** 어딘가에서 같은 타입 빈을 이미 등록해 자동 구성이 물러난 경우다. 특히 **사내 공통 라이브러리가 몰래 등록한 빈** 때문에 기본 동작이 바뀌는 케이스가 실무에서 자주 나온다. 내 코드에는 흔적이 없으니 코드만 읽어서는 절대 안 보인다.

**(3) 명시적 exclude.** 누군가 `exclude` 설정으로 꺼 둔 경우다. 테스트 슬라이스 애너테이션이나 상속받은 부모 설정 클래스에 숨어 있을 수 있다.

셋을 구분하는 방법이 다행히 하나로 통일돼 있다. **부트가 후보 하나하나의 판정 결과와 사유를 전부 기록해 두기 때문**이다.

### 3-2. `--debug` — CONDITIONS EVALUATION REPORT 읽는 법

```bash
# --debug 로 기동하면 조건 평가 리포트가 로그로 출력된다.
# (로그 레벨 debug 전체를 켜는 게 아니라, 부트의 진단 로그를 켜는 스위치다)
java -jar app.jar --debug
```

출력은 네 덩어리로 나뉜다. **각 덩어리가 3-1의 원인 (1)(2)(3)에 그대로 대응한다.**

```
============================
CONDITIONS EVALUATION REPORT
============================


Positive matches:
-----------------

   DataSourceAutoConfiguration matched:
      - @ConditionalOnClass found required classes 'javax.sql.DataSource',
        'org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType' (OnClassCondition)


Negative matches:
-----------------

   RabbitAutoConfiguration:
      Did not match:
         - @ConditionalOnClass did not find required class
           'com.rabbitmq.client.Channel' (OnClassCondition)

   DataSourceAutoConfiguration.PooledDataSourceConfiguration:
      Did not match:
         - @ConditionalOnMissingBean (types: javax.sql.DataSource,javax.sql.XADataSource;
           SearchStrategy: all) found beans of type 'javax.sql.DataSource'
           dataSource (OnBeanCondition)
      Matched:
         - @ConditionalOnClass found required class 'javax.sql.DataSource' (OnClassCondition)


Exclusions:
-----------

    org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration


Unconditional classes:
----------------------

    org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration
```

읽는 법을 한 줄씩 짚자.

**`Positive matches`** — 조건을 전부 통과해 **적용된** 자동 구성이다. 기대한 자동 구성이 여기에 있다면 문제는 자동 구성이 아니라 다른 데 있다.

**`Negative matches`** — 탈락한 자동 구성과 **탈락 사유**다. 이 문서에서 가장 값어치 있는 부분이 여기다. 각 항목은 `Did not match`(탈락시킨 조건)와 `Matched`(통과는 했던 조건)로 나뉘어 나온다. **`Did not match` 밑의 줄을 읽으면 "왜 이 빈이 안 생겼는지"가 그대로 나온다.**

- `did not find required class 'com.rabbitmq.client.Channel'` → 원인 (1) 조건 불충족. RabbitMQ 의존성이 없다는 뜻이다. RabbitMQ를 쓰려던 참이라면 `spring-boot-starter-amqp`를 안 넣은 것이다.
- `found beans of type 'javax.sql.DataSource' dataSource` → 원인 (2) back-off. **끝에 붙은 `dataSource`가 범인의 빈 이름이다.** 이 이름으로 코드베이스와 의존 라이브러리를 검색하면 누가 등록했는지 나온다. 사내 라이브러리가 몰래 등록한 빈을 찾아내는 실질적인 단서가 이 한 단어다.
- 괄호 안의 `(OnClassCondition)`, `(OnBeanCondition)`은 그 판정을 내린 조건 구현 클래스다. 어떤 종류의 조건에서 걸렸는지 분류할 때 쓴다.

**`Exclusions`** — 원인 (3)이다. 누군가 명시적으로 제외한 자동 구성이 여기 나열된다. 내가 exclude한 기억이 없는데 뭔가 올라와 있다면 부모 설정 클래스나 테스트 애너테이션을 의심한다.

**`Unconditional classes`** — 조건이 하나도 안 붙어 무조건 적용되는 자동 구성이다. 진단에 쓸 일은 드물다.

### 3-3. 운영 중인 앱은 `/actuator/conditions`

`--debug`는 재기동이 필요하다. 이미 떠 있는 앱을 건드리지 않고 같은 리포트를 보려면 액추에이터의 `conditions` 엔드포인트를 쓴다. `ConditionEvaluationReport`는 기동 때 만들어져 컨텍스트에 남아 있으므로, 이 엔드포인트는 그 결과를 JSON으로 다시 꺼내 주는 것뿐이다.

```yaml
# 기본적으로 web으로 노출되지 않으므로 명시적으로 열어야 한다
management:
  endpoints:
    web:
      exposure:
        include: health, conditions
```

```json
// GET /actuator/conditions — 로그와 같은 정보를 구조화된 형태로 준다
{
  "contexts": {
    "order-service": {
      "positiveMatches": {
        "DataSourceAutoConfiguration": [
          { "condition": "OnClassCondition", "message": "@ConditionalOnClass found required classes ..." }
        ]
      },
      "negativeMatches": {
        "RabbitAutoConfiguration": {
          "notMatched": [
            { "condition": "OnClassCondition",
              "message": "@ConditionalOnClass did not find required class 'com.rabbitmq.client.Channel'" }
          ],
          "matched": []
        }
      },
      "unconditionalClasses": [ "..." ]
    }
  }
}
```

로그와 달리 **키로 검색·필터링이 되므로**, 후보가 150개가 넘어 눈으로 훑기 어려울 때 `jq`로 특정 자동 구성만 뽑아 보는 식으로 쓴다. 다만 이 엔드포인트는 내부 클래스 구성을 그대로 드러내므로 **외부에 열어 두면 안 된다** — 액추에이터 포트를 분리하거나 인증 뒤에 둔다.

### 3-4. 반대로, 자동 구성을 일부러 끄는 법

추적의 반대편에는 "필요 없는 자동 구성을 끄는" 작업이 있다. 방법은 두 가지다.

```java
// 방법 1: 애너테이션 속성 — 컴파일 타임에 타입으로 지정하므로 오타가 잡힌다
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
public class MyApplication { ... }
```

```yaml
# 방법 2: 프로퍼티 — 코드 수정 없이 환경별로 제어할 수 있다.
#         값이 FQCN 문자열이라 오타가 나면 기동 시 "존재하지 않는 클래스" 에러로 알려준다.
spring:
  autoconfigure:
    exclude: org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
```

문제는 **언제 이게 필요하냐**인데, 실무에서 마주치는 상황은 대체로 아래 네 가지다.

**(1) 테스트에서 DB 없이 컨텍스트를 띄우고 싶을 때.** 가장 흔하다. 순수한 도메인 서비스 단위 테스트인데 `spring-boot-starter-data-jpa`가 클래스패스에 있다는 이유만으로 `DataSourceAutoConfiguration`이 켜지고, 접속 정보가 없으니 "Failed to configure a DataSource"로 컨텍스트 로딩이 실패한다. 이때 `exclude`로 DataSource 자동 구성만 빼면 DB 없이 뜬다.

```java
// before: DB를 전혀 안 쓰는 테스트인데 DataSource가 없어서 컨텍스트 로딩이 실패한다
@SpringBootTest
class OrderPolicyTest { ... }

// after: DB 계층 자동 구성만 걷어내고 띄운다
@SpringBootTest(properties =
        "spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration")
class OrderPolicyTest { ... }
```

다만 이런 상황이 잦다면 `exclude`를 반복하기보다 `@DataJpaTest`·`@WebMvcTest` 같은 **테스트 슬라이스**를 쓰는 편이 낫다. 슬라이스는 "필요한 자동 구성만 켠다"는 반대 방향의 접근이라 유지보수가 쉽다.

**(2) 커넥션 풀이나 클라이언트를 완전히 직접 조립해야 할 때.** 부트의 기본 조립으로는 표현이 안 되는 요구(멀티 데이터소스, 라우팅 데이터소스 등)가 있으면 자동 구성을 끄고 전부 손으로 쓴다.

**(3) 의존성을 뺄 수 없는데 기능은 꺼야 할 때.** 다른 모듈이 끌고 오는 전이 의존성이라 build 파일에서 제거할 수 없는 경우다. 클래스패스에는 있으니 `@ConditionalOnClass`는 통과해 버리므로, exclude로 명시적으로 끈다.

**(4) 시큐리티 자동 구성을 걷어낼 때.** 게이트웨이가 인증을 전담하는 내부 서비스인데 `spring-boot-starter-security`가 전이 의존성으로 딸려 와 모든 요청이 401이 되는 경우다. 다만 이 경우 exclude보다는 `SecurityFilterChain` 빈을 직접 정의해 "허용" 정책을 명시하는 쪽이 안전하다 — 자동 구성을 끄면 **나중에 인증이 필요해졌을 때 아무도 그 사실을 모르는** 상태가 되기 때문이다.

## 4. 꼬리질문 대비 포인트

### "내가 DataSource 빈을 직접 등록하면 부트의 자동 구성 DataSource는 어떻게 되나?"

**생성 자체가 안 된다.** 자동 구성의 `DataSource` 쪽에 `@ConditionalOnMissingBean`이 붙어 있어서, 컨테이너에 이미 사용자 정의 `DataSource` 빈 정의가 있으면 조건 불충족으로 그 `@Bean` 메서드가 빈 정의로도 등록되지 않는다. "두 개 생겼다가 하나가 이기는" 게 아니라 **애초에 하나만 만들어진다.**

여기서 한 걸음 더 들어가면 변별이 된다. **이것이 성립하는 이유는 순서 때문이다.** 자동 구성은 `DeferredImportSelector`라서 사용자 설정이 전부 처리된 뒤에 마지막으로 평가된다(2-5). 그래서 조건을 평가하는 시점에는 내 빈 정의가 이미 등록돼 있고, 자동 구성은 그것을 보고 물러날 수 있다. 순서가 반대였다면 이 메커니즘은 아예 성립하지 않는다.

### "@ConditionalOnClass는 클래스가 없어도 왜 자동 구성 클래스 로딩이 안 터지나?"

이 질문이 어려운 이유는 **"애초에 뭐가 문제인데?"라는 전제**가 통째로 생략되어 있어서다. 전제를 세 계단으로 나눠 채워야 질문이 보인다.

#### 전제 ① — 자동 구성 클래스는 안 써도 항상 클래스패스에 있다

`build.gradle`에 `spring-boot-starter-web` 하나만 넣어도, 실제로 받아지는 jar 안은 이렇다.

```
spring-boot-autoconfigure-3.x.jar
 └─ org/springframework/boot/autoconfigure/
     ├─ web/     ServletWebServerFactoryAutoConfiguration.class
     ├─ jdbc/    DataSourceAutoConfiguration.class
     ├─ amqp/    RabbitAutoConfiguration.class      ← RabbitMQ 안 썼는데도 있음
     ├─ kafka/   KafkaAutoConfiguration.class       ← 있음
     └─ ... 156개
```

부트는 기술별로 jar를 쪼개지 않았다. **모든 기술의 자동 구성 클래스를 하나의 거대한 jar에 전부 담아** 두고, 어떤 스타터를 쓰든 이 jar가 통째로 딸려온다.

> 오해: "RabbitMQ 스타터를 넣어야 `RabbitAutoConfiguration`이 생긴다"
> 사실: "`RabbitAutoConfiguration`은 **처음부터 항상 있다.** 안 쓰면 조건에서 탈락할 뿐"

#### 전제 ② — 그래서 "설명서는 있는데 부품이 없는" 비대칭이 생긴다

| 클래스 | 어느 jar에? | web만 쓰는 내 프로젝트에 |
|---|---|---|
| `RabbitAutoConfiguration` (**설정하는** 쪽) | `spring-boot-autoconfigure.jar` | ✓ 있다 |
| `RabbitTemplate` (**설정당하는** 쪽) | `spring-rabbit.jar` | ✗ 없다 |

그리고 `RabbitAutoConfiguration`은 imports 후보 목록에 이름이 올라와 있으므로, 부트는 **얘한테도 반드시 조건을 물어봐야 한다.** 건너뛸 수 없다 — 건너뛰려면 먼저 "얘는 아니구나"를 알아야 하는데, 그걸 알려면 물어봐야 하니까.

#### 전제 ③ — 그런데 그 조건 자체가 모순으로 생겼다

```java
@AutoConfiguration
@ConditionalOnClass(RabbitTemplate.class)   // ← 없을지도 모르는 클래스를 실명으로 지목
public class RabbitAutoConfiguration {
    @Bean
    public RabbitTemplate rabbitTemplate(ConnectionFactory cf) { ... }  // ← 여기도
}
```

`RabbitTemplate.class`는 자바의 **클래스 리터럴**이다. "`RabbitTemplate`이 있는지 확인하겠다"고 말하면서, 그 문장 안에서 `RabbitTemplate`을 직접 데려오라고 요구하고 있다.

**비유:** 김철수 씨가 집에 있는지 확인하려고 **김철수 씨한테 전화를 건다.** 없으면 안 받을 텐데, 안 받는다는 걸 알려면 전화를 걸어야 한다.

```
조건을 평가하려면 → @ConditionalOnClass의 값을 읽어야 하고
그 값을 읽으려면  → RabbitTemplate을 데려와야 하는데
RabbitTemplate은  → 없다 (그걸 확인하려던 참이었다)
```

**이 닭-달걀이 질문의 정체다.** 풀어 쓰면 "없는 클래스를 실명으로 지목하는 애너테이션을, 부트는 어떻게 사고 없이 읽어내느냐?"

#### 정확히 어디서 터지는가 — 로딩이 아니라 리플렉션이다

여기서 흔한 오해 하나를 짚어야 한다. "클래스를 로딩하면 참조 클래스가 없어서 터진다"는 설명은 **사실이 아니다.** JVM의 심볼 해석(resolution)은 **게을러서(lazy)**, 로딩만으로는 상수 풀의 참조를 해석하지 않는다.

```java
Class<?> c = Class.forName("...RabbitAutoConfiguration");  // ① 안 터진다
System.out.println(c.getName());                           //    잘 출력됨
```

터지는 건 **로딩한 클래스를 리플렉션으로 들여다볼 때**다. 그리고 조건을 평가하려면 반드시 들여다봐야 한다.

```java
ConditionalOnClass ann = c.getAnnotation(ConditionalOnClass.class);  // ② OK
Class<?>[] required = ann.value();                          // ③ 여기서 터진다
```

**③이 왜 터지나:** `value()`의 반환 타입이 `Class[]`다. 즉 나에게 값을 돌려주려면 `RabbitTemplate`의 **`Class` 객체를 실제로 만들어서** 배열에 담아 줘야 한다. jar가 없으니 실패하고, JDK는 `TypeNotPresentException`을 던진다. 같은 이유로 `c.getDeclaredMethods()`도 터진다 — `Method` 객체를 만들려면 반환 타입 `RabbitTemplate`을 해석해야 하기 때문이다.

#### 답 — 자바 코드로 읽지 않고, 파일로 읽는다

전화를 걸지 않고 **문패를 본다.** `RabbitAutoConfiguration.class`는 결국 디스크의 파일이고, 그 안에서 애너테이션은 이렇게 저장돼 있다.

```
RuntimeVisibleAnnotations:
  ConditionalOnClass(
    value = [ "Lorg/springframework/amqp/rabbit/core/RabbitTemplate;" ]
                            ↑ 이건 그냥 글자다. 클래스가 아니다.
  )
```

종이에 적힌 "김철수"라는 글씨를 읽는 데 김철수 씨가 실존할 필요는 없다. 그래서 스프링은 **ASM**이라는 바이트코드 리더로 `.class` 파일의 바이트를 직접 읽어 이름 문자열만 뽑아낸다.

| | **리플렉션** (자바 코드로 읽기) | **ASM** (파일로 읽기) |
|---|---|---|
| 읽는 대상 | JVM에 올라간 `Class` 객체 | 디스크의 `.class` 파일 바이트 |
| 조건 값의 타입 | `Class[]` → **실물 객체가 필요** | `String[]` → **이름이면 충분** |
| 없는 클래스면 | 실물을 못 만들어 터짐 | 글자만 읽고 무사히 끝 |

```java
// before: 리플렉션 — 터진다
Class<?>[] v = clazz.getAnnotation(ConditionalOnClass.class).value();
//   → Class 객체를 돌려주려면 RabbitTemplate을 실제로 로딩해야 한다 → TypeNotPresentException

// after: ASM(MetadataReader) — 안 터진다
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

여기서도 결국 로딩을 시도하지만, **내가 원하는 시점에 try-catch로 감싼 채** 부른다. 애너테이션 리플렉션에는 이 통제권이 없다.

#### 전체 흐름

```
1. imports 파일에서 후보 이름 156개 수집             ← 전부 문자열. 로딩 없음
2. ASM으로 .class 파일 파싱 → 조건 값을 문자열로 추출   ← 로딩 없음
3. ClassUtils.isPresent("...RabbitTemplate") → false  ← try-catch로 통제된 로딩
4. RabbitAutoConfiguration 탈락. JVM에 흔적조차 안 남음
5. 조건 통과한 20~30개만 진짜 로딩 → 리플렉션 → @Bean 실행
```

즉 답의 핵심은 **조건 평가가 클래스 로딩보다 먼저, 로딩 없이 일어난다는 순서**에 있다. 부수 효과도 크다 — 후보 156개 중 탈락할 120여 개가 JVM에 아예 안 올라가므로 기동 속도와 메타스페이스를 아낀다.

#### 곁가지 — "그럼 스프링은 그 소스를 어떻게 컴파일했나?"

`@ConditionalOnClass(RabbitTemplate.class)`라는 **소스**를 컴파일하려면 컴파일 시점에는 `RabbitTemplate`이 반드시 있어야 한다. 스프링 팀은 `spring-boot-autoconfigure`를 빌드할 때 RabbitMQ·Kafka·Redis를 전부 `optional` 의존성으로 걸어 놓고 컴파일한다. `optional`은 **"컴파일엔 필요하지만 이 jar를 쓰는 사람에게 전파하지는 마라"**는 뜻이다.

- **스프링 팀의 빌드 시점**: `RabbitTemplate` 있음 → 컴파일 성공
- **내 프로젝트의 실행 시점**: `RabbitTemplate` 없음 → 그래서 ASM이 필요

이 두 시점의 간극이 문제의 근원이고, ASM이 그 간극을 메운다.

(가산점 포인트: 그래서 자동 구성 모듈을 직접 만들 때, 없을 수 있는 타입이 `@Bean` 메서드의 **시그니처**(반환 타입·파라미터)에 등장하면 위험하다 — 바깥 클래스가 조건을 통과하는 순간 리플렉션 대상이 되어 `NoClassDefFoundError`가 난다. 부트가 실제로 쓰는 관례는 그런 `@Bean`을 **자체 `@ConditionalOnClass`를 단 중첩 static 설정 클래스로 격리**하는 것이다. 중첩 클래스의 조건도 ASM으로 먼저 평가되므로 안전하게 통째로 건너뛴다. 2-3에서 본 `DataSourceAutoConfiguration.PooledDataSourceConfiguration`이 바로 그 관례를 따른 구조다.)

### "자동 구성 클래스끼리 순서는 어떻게 정해지나?"

`@AutoConfigureBefore` / `@AutoConfigureAfter` / `@AutoConfigureOrder`로 자동 구성 **클래스 간의 상대 순서**를 선언한다.

왜 필요한지는 2-4에서 본 원리로 설명된다. `@ConditionalOnMissingBean`은 "여태까지 등록된 빈 정의"만 볼 수 있으므로, **A가 B의 빈 유무를 조건으로 본다면 A는 반드시 B보다 나중에 평가돼야 한다.** 예를 들어 JPA 자동 구성은 `DataSource` 빈의 존재를 조건으로 보므로 `DataSourceAutoConfiguration` 이후에 평가되어야 한다.

주의할 점 둘을 덧붙이면 좋다. 이 애너테이션들은 **자동 구성 클래스에만 적용**되고 일반 사용자 `@Configuration`의 순서 제어 수단이 아니다. 그리고 사용자 설정 전체는 언제나 자동 구성보다 먼저 처리되므로(2-5), 사용자 설정과 자동 구성 사이의 순서를 이 애너테이션으로 조정할 일은 없다.

### "직접 스타터/자동 구성 모듈을 만들려면?"

사내 공통 라이브러리를 만들 때 그대로 쓰는 레시피다.

1. `@AutoConfiguration` 클래스를 작성하고 `@ConditionalOnClass`, `@ConditionalOnMissingBean` 등 조건을 건다 — **사용자가 재정의하면 물러나도록** 설계하는 게 관례다.
2. `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 파일에 그 클래스의 FQCN을 등록한다. **컴포넌트 스캔 대상 패키지에 두는 것이 아니다** — 스캔에 걸리면 조건 평가 체계 밖에서 무조건 등록돼 버리고, 무엇보다 사용자 설정과 같은 타이밍에 처리되어 2-5의 순서 보장이 깨진다.
3. 설정값은 `@ConfigurationProperties`로 노출해 yml로 제어 가능하게 한다.
4. 관례상 자동 구성 모듈(`xxx-spring-boot-autoconfigure`)과 의존성 묶음 모듈(`xxx-spring-boot-starter`)을 분리한다.

부트 2.x용 사내 라이브러리를 3.x로 올린다면 2번이 함정이다. `spring.factories`의 `EnableAutoConfiguration` 키는 3.0에서 제거됐으므로, imports 파일로 옮기지 않으면 **에러 하나 없이 조용히 아무 일도 일어나지 않는다**(2-2 표).

### "자동 구성의 단점이나 비용은?" (시니어 변별 포인트)

**암묵성이 첫 번째 비용이다.** 어떤 빈이 왜 생겼는지 코드만 봐서는 안 보인다. 팀원이 의존성 하나 추가했을 뿐인데 시큐리티 필터 체인이나 기본 동작이 통째로 바뀌는 식의 "원거리 부수효과"가 생긴다. 그래서 **의존성 추가는 설정 변경과 같은 무게로 리뷰해야 한다**는 원칙을 함께 말하면 좋다.

**기동 비용이 두 번째다.** 후보 156개 전체에 대한 조건 평가가 기동 시간에 더해진다. 다만 ASM으로 파일만 읽고 대부분을 탈락시키므로(위 꼬리질문), 실제 비용은 "150개 클래스를 로딩하는 것"보다 훨씬 작다는 점까지 짚으면 정확하다.

**암묵적 기본값 리스크가 세 번째이자 가장 위험하다.** 커넥션 풀 크기, 타임아웃 같은 기본값을 "부트가 알아서"에 맡기고 운영에 나가면, 평시에는 멀쩡하다가 트래픽이 오르는 순간 기본값이 병목이 된다. HikariCP의 기본 풀 크기 10이 대표적이다 — 로컬과 스테이징에서는 절대 드러나지 않는다.

여기서 결론을 균형 있게 내는 것이 변별 포인트다. **"기본값에 의존하되, 운영 크리티컬한 값은 명시적으로 고정한다"** — 자동 구성을 끄자는 것도, 전부 맡기자는 것도 아니다. 그리고 문제가 생기면 `--debug`나 `/actuator/conditions`로 조건 평가 결과를 읽어 추적한다는 대응까지 이어지면 원리와 운영이 모두 잡힌 인상을 준다.

---

## 한 줄 요약

Auto Configuration이 자동화하는 것은 yml이 아니라 **빈 조립 코드**이며, 실체는 "imports 파일로 모은 후보 156개를 `@Conditional` 조건 평가로 걸러 빈 정의로 등록하는 메커니즘"이다 — 이 평가가 런타임이 아니라 빈 정의 등록 단계에서, 그것도 `DeferredImportSelector` 덕분에 **사용자 설정이 전부 끝난 뒤 맨 마지막에** 일어나기 때문에 `@ConditionalOnMissingBean`이 내 빈을 보고 물러날 수 있고, 안 먹을 때는 `--debug`의 `CONDITIONS EVALUATION REPORT`에서 `Did not match` 사유를 읽는 것이 추적의 정석이다.
