# 스테레오타입 애너테이션 — @Component·@Service·@Repository·@Controller, 장식과 기능의 구분

> 핵심 관전 포인트: **네 가지 모두 `@Component`를 메타 애너테이션으로 품고 있어서 "컴포넌트 스캔에 걸려 빈으로 등록된다"는 결과는 완전히 같다. 차이는 그 애너테이션에 실제 동작이 붙어 있느냐다. `@Service`는 지금 기준으로 부가 동작이 없는 계층 표시, 즉 장식이다. `@Repository`는 영속성 기술마다 제각각인 예외를 스프링의 기술 중립적 `DataAccessException` 계층으로 번역하는 프록시가 붙는 실제 기능이고, 그 덕에 서비스 계층이 Hibernate나 MyBatis의 예외 클래스를 import하지 않아도 된다. `@Controller`는 `RequestMappingHandlerMapping`이 핸들러 후보를 고르는 조건 그 자체라서, 빼먹으면 빈 등록은 되는데 `@GetMapping`이 URL에 걸리지 않아 404가 난다. 넷을 "계층 구분용"이라고 뭉뚱그리지 않고 어느 것이 장식이고 어느 것이 기능인지 짚는 것이 이 질문의 답이다.**

---

## 0. 질문 + 의도

**질문**: "`@Component`, `@Service`, `@Repository`, `@Controller`의 차이는?"

**출제 의도**: 사소해 보이지만 `@Repository`의 예외 변환처럼 애너테이션이 실제 동작을 바꾸는 지점을 아는지 확인한다. "장식"과 "기능"을 구분하는 정밀함의 표본 — 넷을 "계층 구분용"이라고 뭉뚱그리는 답과, 어느 것에 어떤 실제 메커니즘이 붙는지 짚는 답의 격차가 크다.

## 1. 공통점 — 넷 다 `@Component`의 특수화다

### 1-1. 전제 지식 — 컴포넌트 스캔은 정확히 무엇을 하는가

스프링 컨테이너는 우리가 만든 클래스를 저절로 알지 못한다. 누군가 "이 클래스로 객체를 하나 만들어 컨테이너에 보관하라"고 알려줘야 하고, 그 알림을 자동화한 장치가 **컴포넌트 스캔**이다.

동작은 단순하다. `@ComponentScan`(스프링 부트에서는 `@SpringBootApplication`이 이것을 품고 있다)이 가리키는 패키지 아래의 클래스 파일을 전부 훑어서, 조건에 맞는 것을 빈 후보로 뽑는다. 이 훑는 일을 하는 부품이 `ClassPathBeanDefinitionScanner`다.

여기서 중요한 것은 **후보를 고르는 기본 조건이 딱 하나**라는 사실이다. 스캐너는 기본 필터로 "`@Component`가 붙어 있는가"만 본다.

그러면 즉시 의문이 생긴다. 조건이 `@Component`뿐인데, `@Service`만 붙인 클래스는 왜 빈으로 등록되는가? 답이 메타 애너테이션이다.

### 1-2. 메타 애너테이션 — 애너테이션에 붙은 애너테이션

**메타 애너테이션은 애너테이션의 정의 자체에 붙어 있는 애너테이션이다.** 자바에서 애너테이션도 결국 하나의 타입 선언이므로, 클래스에 애너테이션을 붙이듯 애너테이션 선언부에도 다른 애너테이션을 붙일 수 있다. "메타"라는 이름은 "그것 자체를 한 층 위에서 설명한다"는 뜻이다 — 메타데이터가 데이터에 대한 데이터인 것과 같은 용법이다.

`@Service`의 실제 정의를 열어보면 이렇게 생겼다.

```java
// @Service의 정의 — 자기 몸에 @Component를 달고 있다
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Component          // 이 한 줄 때문에 @Service만 붙여도 컴포넌트 스캔에 걸린다
public @interface Service {
    // @AliasFor: 여기에 준 이름을 @Component의 value로 그대로 넘겨준다.
    // 덕분에 @Service("orderService") 처럼 빈 이름을 직접 줄 수 있다.
    @AliasFor(annotation = Component.class)
    String value() default "";
}
```

그리고 스프링의 스캐너는 클래스에 `@Component`가 **직접** 붙었는지만 확인하지 않는다. 클래스에 붙어 있는 애너테이션을 하나씩 열어서 **그 정의 안에 `@Component`가 있는지까지 뒤진다.** 그 안에서 또 다른 애너테이션을 만나면 한 단계 더 들어간다.

```
OrderService 클래스
  └─ @Service                 ← 스캐너가 클래스에서 발견한 애너테이션
       └─ @Component          ← 정의를 열어보니 여기 있다  ✓ 후보 확정

OrderApi 클래스
  └─ @RestController
       └─ @Controller
            └─ @Component     ← 두 단계 아래에 있어도 찾아낸다  ✓ 후보 확정

PriceCalculator 클래스
  └─ @Getter                  ← 열어봐도 @Component가 없다   ✗ 후보 아님
```

비유하자면 넷은 전부 같은 **사원증**이다. 사원증이 있어야 건물에 들어올 수 있고(= 빈으로 등록되고), 그 자격 자체는 넷이 똑같다. 다만 사원증에 찍힌 **부서 표시**가 다르고, 뒤에서 보겠지만 일부 부서 표시는 출입 가능 구역까지 바꾼다.

### 1-3. 그래서 진짜 질문은 "그럼에도 무엇이 달라지는가"

빈 등록이라는 결과가 같다면, 면접에서 확인하려는 것은 그다음이다. 넷 중 어떤 것은 **읽는 사람에게 의미를 전달할 뿐**이고, 어떤 것은 **프레임워크가 그 애너테이션을 근거로 실제 코드를 더 붙이거나 다른 판단을 내린다.** 이 경계를 "장식과 기능"이라 부르고, 이 문서의 나머지는 전부 그 경계를 그리는 이야기다.

## 2. 차이 — 어떤 애너테이션에 실제 동작이 붙는가

먼저 결론을 표로 놓고, 각 항목을 아래에서 풀어 설명한다.

| 애너테이션 | 성격 | 붙는 실제 동작 |
|---|---|---|
| `@Component` | 범용 | 빈 등록 (기준점) |
| `@Service` | 장식 | 없음 — 계층 의미 표시뿐 |
| `@Repository` | 기능 | 영속성 예외 → `DataAccessException` 변환 프록시 |
| `@Controller` | 기능 | 요청 매핑 핸들러 후보로 인식되는 조건 |

### 2-1. `@Component` — 범용 스테레오타입

어느 계층에도 딱 들어맞지 않는 빈에 쓰는 기본형이다. 유틸성 컴포넌트, 설정 홀더, 이벤트 리스너, 커스텀 부품 같은 것들이 여기 해당한다.

나머지 셋은 전부 이것의 특수화이므로, "무엇을 붙일지 모르겠으면 `@Component`"가 안전한 기본값이다. 계층이 분명해진 뒤에 더 구체적인 것으로 바꾸면 된다.

### 2-2. `@Service` — 지금은 순수한 역할 표시

**`@Service`는 현재 스프링 안에서 `@Component`와 기능 차이가 없다.** 이 애너테이션을 근거로 프레임워크가 무언가를 더 해주는 코드는 없다. 그런데도 붙이는 이유가 셋 있다.

첫째, **코드를 읽는 사람에게 계층을 선언한다.** `@Service`가 붙어 있으면 "여기가 비즈니스 로직 계층"이라는 사실이 클래스 선언 한 줄로 전달된다. 패키지 구조나 클래스 이름 규칙은 팀마다 다르지만 스테레오타입은 스프링을 쓰는 모든 팀이 공유하는 공통 어휘다.

둘째, **AOP 포인트컷의 표적이 된다.** "서비스 계층 메서드 전체에 실행 시간 로깅을 걸고 싶다" 같은 요구는 `@within(org.springframework.stereotype.Service)`라는 포인트컷 한 줄로 끝난다. 여기서 `@within`은 "이 애너테이션이 붙은 타입 안의 메서드"라는 뜻이다. 패키지 이름으로 포인트컷을 쓰면 패키지를 리팩터링할 때 조용히 깨지지만, 애너테이션 기준은 클래스가 어디로 옮겨가도 따라간다.

셋째, **스프링이 남겨둔 자리다.** 공식 문서는 `@Service`에 대해 "향후 의미가 추가될 수 있다"고 명시해 왔다. 지금 붙여두면 그 변화의 혜택을 자동으로 받는다.

### 2-3. `@Repository` — 예외 변환이라는 실제 기능

여기가 이 질문의 결정타다. 단계를 나눠서 보자.

#### 2-3-1. 전제 — 번역이 없으면 어떤 예외가 올라오는가

`member` 테이블의 `email` 컬럼에 유니크 제약이 걸려 있고, 이미 있는 이메일로 저장을 시도했다고 하자. PostgreSQL은 SQLSTATE `23505`(unique_violation) 오류를 낸다. **똑같은 이 상황에서, 데이터 접근 기술이 무엇이냐에 따라 자바 쪽으로 올라오는 예외 클래스가 완전히 달라진다.**

```
[JPA / Hibernate로 저장할 때]
  PostgreSQL 23505
    → org.postgresql.util.PSQLException
      → org.hibernate.exception.ConstraintViolationException
        → jakarta.persistence.PersistenceException   ← 서비스가 만나는 것

[MyBatis로 저장할 때]
  PostgreSQL 23505
    → org.postgresql.util.PSQLException
      → org.apache.ibatis.exceptions.PersistenceException  ← 서비스가 만나는 것
        (이름은 같아 보여도 위의 jakarta.persistence 것과 전혀 다른 클래스다)
```

번역 장치가 없다면 서비스 계층 코드는 이렇게 된다.

```java
// before: 예외 변환이 없을 때 — 서비스가 특정 기술의 예외 클래스를 import한다
import org.hibernate.exception.ConstraintViolationException;   // 문제의 시작

@Service
public class MemberService {
    @Transactional
    public void register(SignUpRequest req) {
        try {
            memberRepository.save(req.toMember());
        } catch (ConstraintViolationException e) {
            // 문제 1: 비즈니스 로직 클래스가 Hibernate에 직접 의존한다.
            //         MyBatis나 JDBC로 갈아타면 이 catch는 아무것도 못 잡는
            //         죽은 코드가 되고, 예외는 그대로 튀어 500이 나간다.
            // 문제 2: "유니크 위반"인지 "NOT NULL 위반"인지 구분하려면
            //         e.getSQLException().getSQLState() 를 꺼내 벤더별
            //         코드값을 문자열로 비교해야 한다 — DB를 바꾸면 또 깨진다.
            throw new AlreadyRegisteredException(req.email());
        }
    }
}
```

이 코드의 진짜 문제는 catch가 지저분하다는 것이 아니다. **비즈니스 규칙을 담아야 할 계층이 "지금 우리가 Hibernate를 쓴다"는 인프라 사실에 묶여버렸다**는 것이다. 기술 교체가 서비스 코드 수정으로 번지는 구조이고, 계층 분리를 해놓은 의미가 없어진다.

#### 2-3-2. 스프링의 답 — `DataAccessException`이라는 공용 어휘

스프링은 이 문제를 **기술 중립적인 예외 계층을 하나 정의하고, 모든 기술의 예외를 그리로 번역한다**는 방식으로 푼다. 그 계층의 최상위가 `DataAccessException`이다.

```
DataAccessException                        ← 전부 unchecked(RuntimeException)
├─ NonTransientDataAccessException         ← 그대로 재시도해도 또 실패한다
│   ├─ DataIntegrityViolationException     ← 제약 위반 (UNIQUE, NOT NULL, FK …)
│   │   └─ DuplicateKeyException           ←   그중 "키 중복"으로 특정된 경우
│   ├─ BadSqlGrammarException              ← SQL 문법·컬럼명 오류
│   └─ DataRetrievalFailureException
│       └─ IncorrectResultSizeDataAccessException
│           └─ EmptyResultDataAccessException
└─ TransientDataAccessException            ← 상황이 바뀌면 재시도가 성공할 수 있다
    ├─ QueryTimeoutException
    └─ ConcurrencyFailureException
        ├─ OptimisticLockingFailureException
        └─ PessimisticLockingFailureException
            └─ CannotAcquireLockException
```

이 계층에서 두 가지를 읽어야 한다.

하나는 **분류 기준이 "어느 기술이 던졌는가"가 아니라 "무슨 일이 일어났는가"**라는 점이다. 상위 계층은 "제약 위반이 났다", "락을 못 잡았다", "타임아웃이다"라는 의미로 예외를 다루게 되고, 그것이 JPA에서 왔는지 JDBC에서 왔는지는 알 필요가 없어진다.

다른 하나는 **재시도 가능 여부가 타입에 새겨져 있다**는 점이다. `Transient`는 "일시적"이라는 뜻으로, 락 경합이나 타임아웃처럼 잠시 뒤 다시 하면 성공할 수 있는 실패다. `NonTransient`는 그렇지 않은 실패다. 재시도 정책을 짤 때 예외 클래스 목록을 일일이 나열하지 않고 `TransientDataAccessException` 하나로 잡을 수 있는 것이 이 설계의 값이다.

`DataAccessException`이 **체크 예외가 아니라 런타임 예외**라는 점도 의도된 설계다. JDBC 시절에는 `SQLException`이 체크 예외라 모든 중간 계층이 `throws SQLException`을 달거나 의미 없는 try-catch로 감싸야 했다. 처리할 수 없는 예외를 억지로 선언하게 만드는 대신, 잡을 수 있는 곳에서만 잡게 한 것이다.

#### 2-3-3. after — 같은 코드가 기술을 바꿔도 살아남는다

```java
// after: @Repository가 예외를 번역해 주면 서비스는 의미만 다룬다
import org.springframework.dao.DataIntegrityViolationException;  // 스프링 공용 타입

@Service
public class MemberService {
    @Transactional
    public void register(SignUpRequest req) {
        try {
            memberRepository.save(req.toMember());
        } catch (DataIntegrityViolationException e) {
            // JPA로 짜든 MyBatis로 짜든, PostgreSQL이든 다른 DB든
            // "제약을 위반했다"는 같은 타입으로 도착한다.
            // 데이터 접근 기술을 통째로 갈아치워도 이 catch는 그대로 유효하다.
            throw new AlreadyRegisteredException(req.email());
        }
    }
}
```

여기서 잡는 타입을 **`DataIntegrityViolationException`으로 둔 데에는 이유가 있다.** 흔히 `DuplicateKeyException`으로 잡는 예제가 돌아다니는데, 두 경로에서 실제로 나오는 타입이 다르다.

| 경로 | 유니크 위반 시 실제로 도착하는 타입 |
|---|---|
| JPA / Hibernate (`HibernateJpaDialect`가 번역) | `DataIntegrityViolationException` |
| JDBC · MyBatis (SQLSTATE `23505`를 보고 번역) | `DuplicateKeyException` |

`DuplicateKeyException`은 `DataIntegrityViolationException`의 하위 타입이므로, **상위 타입으로 잡으면 두 경로가 모두 걸린다.** 반대로 `DuplicateKeyException`으로만 잡아 두면 JPA 경로에서 조용히 안 잡히고 500이 나간다. 이 문서의 이전 판이 JPA 예제에 `DuplicateKeyException`을 쓰고 있었는데, 그건 정확하지 않다.

#### 2-3-4. 어떻게 동작하는가 — `@Repository`에 프록시가 씌워진다

번역은 마법이 아니라 프록시로 구현돼 있다. **프록시는 원본 객체인 척하면서 호출을 먼저 받아 부가 작업을 한 뒤 원본에 넘기는 대리인 객체다.**

담당 부품은 `PersistenceExceptionTranslationPostProcessor`이고, 이름 그대로 **빈 후처리기(BeanPostProcessor)** — 컨테이너가 빈을 만든 직후에 끼어들어 그 빈을 손볼 기회를 갖는 확장점이다. 빈 후처리기 자체는 `02-bean-lifecycle-singleton-scope.md`에서 다루는 주제이고, `@Transactional`이나 `@Cacheable`도 같은 자리에서 프록시를 얻는다.

```
컨테이너가 MemberRepositoryImpl 인스턴스를 생성
        │
        ▼
PersistenceExceptionTranslationPostProcessor 가 끼어든다
  "이 빈의 클래스에 @Repository 가 붙어 있나?"
        │
        ├─ 아니오 → 원본 그대로 컨테이너에 등록
        │
        └─ 예 → 프록시로 감싸서 등록
                 ┌──────────────────────────────────────┐
                 │ 프록시                                │
                 │   try { 원본 메서드 호출 }             │
                 │   catch (RuntimeException ex) {       │
                 │     PersistenceExceptionTranslator    │
                 │       .translateExceptionIfPossible() │
                 │     → DataAccessException 로 바꿔 던짐 │
                 │   }                                   │
                 └──────────────────────────────────────┘
```

실제 번역을 수행하는 것은 `PersistenceExceptionTranslator` 인터페이스의 구현들이고, 컨테이너에 등록된 것을 찾아 쓴다. JPA를 쓰면 `LocalContainerEntityManagerFactoryBean`이 그 역할을 하고, MyBatis를 쓰면 `SqlSessionFactoryBean`이 등록한 번역기가 한다. **기술마다 번역기가 하나씩 꽂히는 구조**라서, 새 기술이 들어와도 번역기만 추가하면 상위 계층 코드는 그대로다.

스프링 부트를 쓰면 이 후처리기는 `PersistenceExceptionTranslationAutoConfiguration`이 알아서 등록한다. 직접 `@Bean`으로 선언할 일은 없다. (Spring Boot 3.x 기준)

#### 2-3-5. 그런데 요즘 코드에서는 왜 이 기능이 티가 안 나는가

여기까지 읽고 실무 코드를 보면 이상한 점이 생긴다. **`JpaRepository`를 상속한 인터페이스에는 보통 `@Repository`를 안 붙이는데도 `DataIntegrityViolationException`이 잘 올라온다.** 이유가 두 가지 있고, 둘 다 알아야 이 애너테이션의 현재 위치를 정확히 말할 수 있다.

첫째, **스프링 데이터가 만드는 리포지토리 프록시에는 예외 번역기가 기본으로 들어간다.** `JpaRepository`를 상속한 인터페이스는 우리가 구현체를 만들지 않는다. 스프링 데이터의 리포지토리 팩토리가 런타임에 프록시를 만들어 빈으로 등록하는데, 그 프록시를 조립할 때 `PersistenceExceptionTranslationInterceptor`를 기본으로 끼워 넣는다. **`@Repository`가 붙어 있어서가 아니라, 스프링 데이터 리포지토리이기 때문에** 번역이 되는 것이다.

여기서 흔한 오해를 하나 정정해 둘 필요가 있다. "기본 구현체인 `SimpleJpaRepository`에 `@Repository`가 붙어 있어서 번역된다"는 설명이 널리 퍼져 있는데, 인과가 맞지 않는다. `SimpleJpaRepository`에 그 애너테이션이 달려 있는 것은 사실이지만, 이 클래스는 컴포넌트 스캔으로 등록되는 빈이 아니라 리포지토리 팩토리가 직접 인스턴스화하는 내부 구현체다. 즉 `PersistenceExceptionTranslationPostProcessor`의 시야에 들어오지 않는다. 실제로 일하는 것은 위에서 말한 프록시 인터셉터다.

둘째, **커밋 시점에 터지는 위반은 트랜잭션 매니저가 번역한다.** JPA는 쓰기 지연을 하기 때문에 유니크 위반이 `save()` 호출이 아니라 트랜잭션 커밋 직전의 flush에서 드러나는 경우가 많다. 이때 예외는 리포지토리 메서드가 아니라 `JpaTransactionManager`의 커밋 처리에서 튀어나오는데, 여기에도 번역 코드가 들어 있다. 리포지토리에 프록시가 없어도 이 경로에서는 번역된 예외를 받는다.

그래서 **`@Repository`를 직접 붙여야 의미가 생기는 자리는 좁다.** `EntityManager`나 `SqlSession`을 직접 주입받아 쓰는 **커스텀 리포지토리 클래스**를 만들 때다. 이건 우리가 만든 평범한 빈이므로, `@Repository`가 없으면 후처리기가 프록시를 씌우지 않고 Hibernate 예외가 그대로 서비스까지 올라간다.

```java
// 커스텀 리포지토리 — 여기서는 @Repository가 실제로 일한다
@Repository   // 빼면 PersistenceExceptionTranslationPostProcessor의 대상에서 제외되어
public class MemberQueryRepository {   // Hibernate 예외가 날것으로 서비스까지 올라간다
    private final EntityManager em;
    ...
}
```

정리하면 이렇다. **기능은 분명히 존재하지만, 스프링 데이터가 그 일을 대신 해주는 영역이 넓어져서 평소에는 존재감이 없다.** 면접에서 "요즘은 안 붙여도 되던데요"라고만 답하면 절반이고, "스프링 데이터 프록시가 대신 번역해 주기 때문이며, `EntityManager`를 직접 쓰는 커스텀 구현에서는 여전히 필요하다"까지 말하면 완성이다.

### 2-4. `@Controller` — 요청 매핑이 켜지는 스위치

`@Repository`가 "붙이면 기능이 추가되는" 쪽이라면, `@Controller`는 **"없으면 아예 동작하지 않는"** 쪽이다. 성격이 더 강하다.

Spring MVC에서 URL과 컨트롤러 메서드를 연결하는 부품은 `RequestMappingHandlerMapping`이다. 이 부품은 애플리케이션의 모든 빈을 뒤져서 `@GetMapping`이 붙은 메서드를 찾는 방식으로 동작하지 **않는다.** 먼저 "이 빈이 핸들러를 가진 클래스인가"를 판정하고, 통과한 것만 안쪽 메서드를 들여다본다.

그 판정 코드는 이렇게 생겼다.

```java
// RequestMappingHandlerMapping — 핸들러 후보를 고르는 실제 조건
@Override
protected boolean isHandler(Class<?> beanType) {
    return (AnnotatedElementUtils.hasAnnotation(beanType, Controller.class) ||
            AnnotatedElementUtils.hasAnnotation(beanType, RequestMapping.class));
}
```

조건은 두 개뿐이다 — **타입에 `@Controller`가 있거나, 타입에 `@RequestMapping`이 있거나.** 그 외의 빈은 안을 열어보지도 않는다. `@Component`만 붙은 빈에 `@GetMapping`을 백 개 달아도 읽히지 않는 이유가 이것이다.

여기서 `hasAnnotation`이 1-2에서 본 **메타 애너테이션까지 따라 들어가는 탐색**이라는 점도 중요하다. `@RestController`가 조건에 명시돼 있지 않은데도 통과하는 것은, 그 정의 안에 `@Controller`가 들어 있기 때문이다.

```java
// before: @Component만 붙임 — 빈으로는 등록되지만 URL에 걸리지 않는다
@Component
public class OrderApi {
    @GetMapping("/orders/{id}")   // isHandler가 false → 이 메서드는 스캔조차 안 된다
    public OrderResponse get(@PathVariable Long id) { ... }
}
// 증상: 애플리케이션은 정상 기동하고 빈 목록에도 orderApi가 보이는데
//       GET /orders/1 은 404. 컨트롤러 코드에 브레이크포인트를 걸어도 안 걸린다.

// after: @RestController(= @Controller + @ResponseBody)라야 후보가 된다
@RestController
public class OrderApi {
    @GetMapping("/orders/{id}")   // 정상 매핑
    public OrderResponse get(@PathVariable Long id) { ... }
}
```

이 증상이 특히 고약한 이유는 **아무 에러도 나지 않기 때문**이다. 빈 등록은 성공했으므로 기동 로그에 경고 한 줄 뜨지 않는다. 실제로 등록된 매핑 목록을 확인하려면 Actuator의 `/actuator/mappings`를 보거나, `org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping` 로거를 낮춰서 기동 시 찍히는 매핑 목록을 확인한다.

`@RestController`의 정의도 같은 메타 애너테이션 이야기다.

```java
// @RestController의 정의 — 두 개를 합성한 것일 뿐이다
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Controller       // ① 핸들러 후보 판정을 통과시킨다
@ResponseBody     // ② 반환값을 뷰 이름이 아니라 응답 본문으로 처리하게 한다
public @interface RestController {
    @AliasFor(annotation = Controller.class)
    String value() default "";
}
```

두 애너테이션이 각각 파이프라인의 **다른 단계**에 작용한다는 점을 구분해서 말할 수 있으면 좋다. `@Controller`는 요청이 들어올 때 핸들러를 찾는 단계(HandlerMapping)에 작용하고, `@ResponseBody`는 컨트롤러가 값을 반환한 뒤 응답을 만드는 단계(ReturnValueHandler·메시지 컨버터)에 작용한다. 각 단계가 무엇인지는 `05-spring-mvc-request-flow.md`에서 다룬다.

## 3. 실무에서 이 구분이 드러나는 순간

### 3-1. 사례 1 — 데이터 접근 기술을 갈아탈 때 서비스 코드가 깨지는가

MyBatis로 만든 서비스를 JPA로 옮기는 작업을 한다고 하자. 리포지토리 구현을 새로 쓰는 것은 예정된 일이지만, **서비스 계층까지 손대야 한다면 그건 계층 분리가 실패했다는 뜻이다.**

```
[예외 변환이 없는 코드베이스]
  MyBatis 제거
    → 서비스의 catch (org.apache.ibatis...PersistenceException) 가 죽은 코드가 됨
    → 컴파일은 통과 (클래스가 사라지면 컴파일 에러, 남아 있으면 조용히 무력화)
    → "중복 가입 안내" 기능이 500 에러로 바뀐 것을 QA가 발견
    → 손대야 할 파일: 리포지토리 + 그 예외를 잡던 모든 서비스

[예외 변환이 있는 코드베이스]
  MyBatis 제거
    → 서비스는 DataIntegrityViolationException 을 잡고 있으므로 그대로 유효
    → 손대야 할 파일: 리포지토리뿐
```

`@Repository`(정확히는 그것이 대표하는 스프링의 예외 변환 체계)가 지키는 것은 바로 이 경계다. 이 원리를 모르면 벤더별 SQL 에러 코드를 문자열로 비교하는 코드를 짜게 되고, 그 코드는 DB를 바꾸는 순간 또 깨진다.

### 3-2. 사례 2 — "빈 등록은 됐는데 404"

컨트롤러에 `@Component`를 붙였거나, 클래스를 새로 만들면서 `@RestController`를 빼먹은 경우다. 앞서 본 대로 에러가 나지 않으므로 원인을 찾기까지 오래 걸린다.

**"빈 등록"과 "핸들러 등록"이 별개의 단계**라는 것을 아는 사람은 이 증상에서 곧바로 애너테이션을 의심한다. 반대로 이 구분이 없으면 URL 오타나 컨텍스트 패스, 시큐리티 설정 같은 엉뚱한 곳을 먼저 뒤진다.

### 3-3. 사례 3 — 계층 규칙을 도구로 강제할 때

"서비스 계층 메서드의 실행 시간을 전부 기록하라", "컨트롤러는 리포지토리를 직접 참조하지 못하게 하라" 같은 요구는 스테레오타입을 표적으로 삼으면 깔끔하게 구현된다. AOP 포인트컷은 `@within(...Service)`로, 아키텍처 검증은 ArchUnit 같은 도구의 규칙으로 쓴다.

여기서 얻는 이점은 **패키지 구조 변경에 흔들리지 않는다**는 것이다. 패키지 이름으로 규칙을 쓰면 디렉터리 한 번 옮길 때마다 규칙이 조용히 무력화되지만, 애너테이션 기준은 클래스를 따라다닌다.

## 4. 꼬리질문 대비 포인트

### "`@Service`를 `@Component`로 바꾸면 동작이 달라지나요?"

기능적으로는 달라지지 않는다. `@Service`에는 현재 부가 동작이 없다.

다만 잃는 것이 셋이다. 계층 의도가 코드에서 사라지고, 스테레오타입을 표적으로 삼는 AOP 포인트컷과 아키텍처 검증 규칙의 대상에서 빠지며, 향후 스프링이 `@Service`에 의미를 추가하면 그 혜택을 못 받는다.

"동작은 같지만 의도 표현과 도구의 표적이라는 가치가 있다"고 답하면 정확하다. 반대로 `@Repository`나 `@Controller`를 `@Component`로 바꾸는 것은 **동작이 실제로 달라진다** — 이 비대칭을 짚으면 질문의 핵심을 이해했다는 신호가 된다.

### "`@Repository`의 예외 변환은 어떤 원리로 동작하나요?"

빈 후처리기인 `PersistenceExceptionTranslationPostProcessor`가 `@Repository`가 붙은 빈을 찾아 AOP 프록시로 감싼다. 프록시는 원본 메서드에서 튀어나온 런타임 예외를 가로채, 컨테이너에 등록된 `PersistenceExceptionTranslator` 구현(JPA면 `LocalContainerEntityManagerFactoryBean`, MyBatis면 MyBatis-Spring이 등록한 번역기)에게 넘겨 대응하는 `DataAccessException` 하위 타입으로 바꿔 다시 던진다.

**프록시 기반이라는 점**이 이 답의 핵심이다. `@Transactional`, `@Cacheable`과 완전히 같은 메커니즘 위에 있고, 따라서 같은 한계도 공유한다 — 스프링 빈이 아닌 객체에는 적용되지 않고, 같은 클래스 안에서의 자기 호출은 프록시를 거치지 않으므로 번역도 일어나지 않는다.

(가산점 포인트) `JdbcTemplate`은 프록시와 무관하게 **자체적으로** `SQLException`을 `DataAccessException`으로 번역한다. 내부에 `SQLExceptionTranslator`를 들고 있기 때문이다. 즉 `JdbcTemplate`만 쓰는 리포지토리에서는 `@Repository`가 예외 변환 측면에서 하는 일이 없다.

### "Spring Data JPA 리포지토리 인터페이스에도 `@Repository`를 붙여야 하나요?"

붙일 필요 없다. 붙여도 해롭지는 않지만 하는 일이 없다.

이유는 2-3-5에서 본 그대로다. `JpaRepository`를 상속한 인터페이스의 실제 구현은 스프링 데이터가 런타임에 만드는 프록시이고, 그 프록시에는 예외 번역 인터셉터가 기본으로 들어간다. `@Repository` 애너테이션이 그 조립에 영향을 주지 않는다.

반대로 `EntityManager`나 `SqlSession`을 직접 쓰는 커스텀 리포지토리 클래스에는 붙여야 번역을 받는다. **"스프링 데이터가 만들어 주는 것에는 불필요, 내가 직접 만든 것에는 필요"**가 판단 기준이다.

### "`@Component`를 붙인 클래스의 `@GetMapping`이 동작하지 않는 이유는?"

빈 등록(컴포넌트 스캔)과 핸들러 등록(`RequestMappingHandlerMapping`의 스캔)이 별개 단계이기 때문이다.

핸들러 스캔은 모든 빈을 뒤지지 않는다. `isHandler(Class<?>)`가 **타입에 `@Controller` 또는 `@RequestMapping`이 있는지**만 보고 후보를 추리며, `@Component` 빈은 여기서 탈락한다. 탈락한 빈은 안쪽 메서드를 아예 읽지 않으므로 `@GetMapping`은 없는 것과 같아진다.

증상이 "예외 없는 404"라서 원인을 찾기 어렵다는 점, 확인 수단이 `/actuator/mappings`라는 점까지 붙이면 실무 감각이 드러난다.

### "커스텀 스테레오타입을 만든다면? 이런 계층 컨벤션의 트레이드오프는?" (시니어 변별 포인트)

메타 애너테이션 합성으로 만들 수 있다. 원리는 `@RestController`가 만들어진 방식과 똑같다.

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Service          // @Service를 메타로 둔다 — 컴포넌트 스캔도, 기존 포인트컷도 그대로 유효
public @interface DomainService { }
```

얻는 것은 두 가지다. 도메인 용어를 아키텍처에 새길 수 있고(팀이 쓰는 말과 코드의 말이 같아진다), 포인트컷과 아키텍처 규칙의 표적을 더 좁게 잡을 수 있다. "모든 `@Service`"가 아니라 "도메인 서비스만"을 겨냥할 수 있게 된다.

트레이드오프는 셋이다. 팀원에게 학습 비용이 생기고, 애너테이션이 늘수록 "무엇이 기능이고 무엇이 장식인지" 경계가 흐려지며, IDE와 정적 분석 도구가 표준 스테레오타입만큼 인식해 주지 않을 수 있다.

**"표준 4종으로 충분하면 추가하지 않고, 계층 규칙을 도구로 강제할 필요가 실제로 생겼을 때만 도입한다"**는 기준을 붙이면 균형 잡힌 답이 된다. 애너테이션은 늘리기는 쉽고 걷어내기는 어렵다는 점도 함께 말할 만하다.

---

## 한 줄 요약

넷 다 `@Component`를 메타 애너테이션으로 품고 있어 빈 등록이라는 결과는 같지만, `@Repository`에는 기술별 영속성 예외를 `DataAccessException` 계층으로 번역하는 프록시가, `@Controller`에는 `RequestMappingHandlerMapping`이 핸들러 후보를 고르는 판정 조건이 실제로 붙어 있고, `@Service`는 계층 의도를 선언하는 장식이다 — **어느 것이 장식이고 어느 것이 기능인지 구분해서 아는 것**이 이 질문의 답이다.
