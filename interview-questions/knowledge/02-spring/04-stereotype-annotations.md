# 스테레오타입 애너테이션 — @Component·@Service·@Repository·@Controller, 장식과 기능의 구분

> 핵심 관전 포인트: **네 가지 모두 `@Component`의 특수화(specialization)라서
> "컴포넌트 스캔으로 빈 등록된다"는 점은 완전히 동일하다. 차이는 애너테이션이
> 실제 동작을 바꾸는지 여부다 — `@Service`는 현재 부가 기능이 없는 계층 역할
> 표시(장식)이고, `@Repository`는 영속성 기술별 예외를 스프링의
> `DataAccessException` 계층으로 변환하는 실제 기능이 붙으며,
> `@Controller`는 Spring MVC가 요청 매핑 핸들러 후보로 인식하는 조건이라
> 없으면 `@GetMapping`이 아예 동작하지 않는다. "장식"과 "기능"을 구분해서
> 답하는 것이 이 질문의 핵심이다.**

---

## 0. 질문 + 의도

**질문**: "`@Component`, `@Service`, `@Repository`, `@Controller`의 차이는?"

**출제 의도**: 사소해 보이지만 `@Repository`의 예외 변환처럼 애너테이션이
실제 동작을 바꾸는 지점을 아는지 확인한다. "장식"과 "기능"을 구분하는
정밀함의 표본 — 넷을 "계층 구분용"이라고 뭉뚱그리는 답과, 어느 것에 어떤
실제 메커니즘이 붙는지 짚는 답의 격차가 크다.

## 1. 공통점 — 전부 @Component의 특수화

`@Service`, `@Repository`, `@Controller`의 소스를 열어보면 **자기 자신에
`@Component`가 붙어 있다**(메타 애너테이션).

```java
// @Service의 실제 정의 — @Component를 품고 있다
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Component          // ← 이것 때문에 컴포넌트 스캔에 걸린다
public @interface Service {
    @AliasFor(annotation = Component.class)
    String value() default "";
}
```

컴포넌트 스캔은 클래스에 `@Component`가 **직접 붙었는지뿐 아니라
메타 애너테이션으로 붙었는지까지** 확인하므로, 넷 중 무엇을 붙이든
"빈으로 등록된다"는 결과는 같다.

- 비유: 넷 다 같은 **사원증**(빈 등록 자격)이다. 다만 사원증에 찍힌
  **부서 표시**가 다르고, 일부 부서 표시는 출입 가능 구역(실제 기능)까지
  바꾼다.

그래서 이 질문의 진짜 답은 "그럼에도 불구하고 무엇이 달라지는가"다.

## 2. 차이 — 애너테이션별로 실제로 붙는 것

짧은 비교:

| 애너테이션 | 성격 | 붙는 실제 동작 |
|---|---|---|
| `@Component` | 범용 | 빈 등록 (기준점) |
| `@Service` | 장식 | 없음 — 계층 의미 표시뿐 |
| `@Repository` | 기능 | **영속성 예외 → DataAccessException 변환** |
| `@Controller` | 기능 | **요청 매핑 핸들러 후보로 인식** |

### @Component — 범용 스테레오타입

어느 계층에도 속하지 않는 빈(유틸성 컴포넌트, 설정 홀더, 커스텀 부품 등)에
쓰는 기본형. 나머지 셋의 부모 격이다.

### @Service — 현재는 순수한 "역할 표시"

**지금 기준으로 `@Component`와 기능 차이가 없다.** 그래도 붙이는 이유:

1. **코드를 읽는 사람에게 계층을 선언** — "여기가 비즈니스 로직 계층"
   이라는 아키텍처 문서 역할.
2. **AOP 포인트컷의 표적** — `@within(org.springframework.stereotype.Service)`
   처럼 "서비스 계층 전체에 로깅/모니터링"을 걸 때 선별 기준이 된다.
3. 스프링 공식 문서도 "향후 의미가 추가될 수 있다"고 남겨둔 자리다.

### @Repository — 예외 변환이라는 실제 기능

`@Repository`가 붙은 빈은 `PersistenceExceptionTranslationPostProcessor`가
**프록시로 감싸서**, 메서드에서 튀어나오는 영속성 기술 고유 예외(JPA의
`PersistenceException`, Hibernate 예외 등)를 스프링의 **기술 중립적
`DataAccessException` 계층**으로 변환해 다시 던진다.

```java
// Before: 변환이 없다면 — 서비스 계층이 특정 기술/벤더 예외에 오염된다
try {
    memberRepository.save(member);
} catch (org.hibernate.exception.ConstraintViolationException e) {
    // 문제 1: 서비스가 Hibernate에 직접 의존 (구현 기술 교체 시 전부 수정)
    // 문제 2: DB 벤더마다 에러 코드가 달라 분기 코드가 벤더 종속
}

// After: @Repository의 예외 변환 — 기술 중립적 예외로 잡는다
try {
    memberRepository.save(member);
} catch (DuplicateKeyException e) {
    // DataAccessException의 하위 타입. JPA든 JDBC든, MySQL이든 PostgreSQL이든
    // "키 중복"이라는 의미로 통일된 예외를 받는다
    throw new AlreadyRegisteredException(member.getEmail());
}
```

이 변환 덕분에 상위 계층은 **"무슨 일이 났는가"(중복 키, 무결성 위반,
일시적 장애)로 예외를 다루고**, "어느 기술이 어떤 형태로 던졌는가"에서
해방된다. `DataAccessException`이 unchecked(런타임) 예외라는 점도 중요하다
— 계층마다 `throws SQLException`을 강제로 전파하던 시절의 문제를 없앤
설계다.

(가산점 포인트) 단, `JdbcTemplate`은 프록시와 무관하게 **자체적으로**
`SQLException`을 `DataAccessException`으로 변환한다. `@Repository` 기반
프록시 변환이 실질적으로 일하는 곳은 JPA/Hibernate처럼 자기 고유 런타임
예외를 던지는 기술을 직접 쓰는 커스텀 리포지토리 구현이다.

### @Controller — 요청 매핑이 동작하기 위한 조건

Spring MVC의 `RequestMappingHandlerMapping`은 **`@Controller`가 붙은 빈을
핸들러 후보로 스캔**해서 그 안의 `@RequestMapping`/`@GetMapping` 메서드를
URL에 등록한다. 즉 `@Controller`는 장식이 아니라 **요청 매핑이 켜지는
스위치**다.

```java
// Before: @Component만 붙임 — 빈으로는 등록되지만
@Component
public class OrderApi {
    @GetMapping("/orders/{id}")   // 핸들러로 스캔되지 않아 404
    public OrderResponse get(@PathVariable Long id) { ... }
}

// After: @Controller(@RestController)라야 핸들러 후보가 된다
@RestController                    // = @Controller + @ResponseBody
public class OrderApi {
    @GetMapping("/orders/{id}")   // 정상 매핑
    public OrderResponse get(@PathVariable Long id) { ... }
}
```

`@RestController`는 `@Controller` + `@ResponseBody`의 합성 애너테이션으로,
반환값을 뷰 이름이 아니라 응답 본문(JSON 직렬화)으로 처리하게 한다.

## 3. 실무에서 이 구분이 드러나는 순간

- **"저장 실패 시 중복 가입 안내"** 같은 요구사항: 서비스 계층에서
  `DuplicateKeyException`/`DataIntegrityViolationException`을 잡아 도메인
  예외로 바꾸는 코드가 가능한 것은 `@Repository`(와 스프링의 예외 변환
  체계) 덕분이다. 이 원리를 모르면 벤더별 SQL 에러 코드를 파싱하는
  코드를 짜게 된다.
- **"빈 등록은 됐는데 404"**: 컨트롤러에 `@Component`를 붙였거나,
  `@Controller`를 빼먹은 경우. "빈 등록"과 "핸들러 등록"이 별개 단계임을
  아는 사람은 이 증상에서 바로 애너테이션을 의심한다.
- **계층별 공통 처리**: "서비스 계층 메서드 실행 시간 로깅" 같은 요구를
  스테레오타입 기준 포인트컷으로 구현하면, 패키지 구조가 바뀌어도
  포인트컷이 깨지지 않는다.

## 4. 꼬리질문 대비 포인트

### "@Service를 @Component로 바꾸면 동작이 달라지나요?"

기능적으로는 달라지지 않는다 — `@Service`는 현재 부가 동작이 없다.
하지만 (1) 계층 의도가 코드에서 사라지고, (2) 스테레오타입 기준
AOP 포인트컷·아키텍처 검증 규칙(예: ArchUnit으로 "@Service는 @Repository만
의존" 강제)의 표적에서 빠지며, (3) 향후 스프링이 `@Service`에 의미를
추가할 때 혜택을 못 받는다. "동작은 같지만 의도 표현과 도구의 표적이라는
가치가 있다"고 답하면 정확하다.

### "@Repository의 예외 변환은 어떤 원리로 동작하나요?"

`PersistenceExceptionTranslationPostProcessor`(빈 후처리기)가 `@Repository`
붙은 빈을 찾아 **AOP 프록시로 감싼다.** 프록시는 메서드 실행 중 튀어나온
영속성 예외를 등록된 `PersistenceExceptionTranslator`(JPA/Hibernate 등
기술별 구현)에게 넘겨 대응하는 `DataAccessException` 하위 타입으로 변환해
다시 던진다. **프록시 기반이라는 점**이 중요하다 — `@Transactional`,
`@Cacheable`과 같은 원리 위에 있고, 따라서 스프링 빈이 아닌 객체에는
적용되지 않는다.

### "Spring Data JPA 리포지토리 인터페이스에도 @Repository를 붙여야 하나요?"

붙일 필요 없다. `JpaRepository`를 상속한 인터페이스의 실제 구현은
스프링 데이터가 만들어주는 프록시이고, 그 내부 기본 구현체
(`SimpleJpaRepository`)에 이미 `@Repository`가 붙어 있어 **예외 변환이
기본 적용**된다. 인터페이스에 또 붙이는 것은 관례적 장식일 뿐이다.
반대로 `EntityManager`를 직접 쓰는 커스텀 리포지토리 클래스를 만들 때는
`@Repository`를 붙여야 변환을 받는다.

### "@Component를 붙인 클래스의 @GetMapping이 동작하지 않는 이유는?"

빈 등록(컴포넌트 스캔)과 핸들러 등록(`RequestMappingHandlerMapping`의
스캔)은 **별개 단계**이기 때문이다. 핸들러 스캔은 애플리케이션의 모든 빈을
뒤지는 게 아니라 `@Controller`(또는 타입 레벨 `@RequestMapping`)가 붙은
빈만 후보로 본다. `@Component` 빈은 이 후보 판별에서 탈락하므로 그 안의
매핑 애너테이션은 읽히지 않는다.

### "커스텀 스테레오타입을 만든다면? 이런 계층 컨벤션의 트레이드오프는?" (시니어 변별 포인트)

메타 애너테이션 합성으로 만들 수 있다:

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Service                       // @Service를 메타로 — 스캔·포인트컷 모두 유지
public @interface DomainService { }
```

도메인 용어를 아키텍처에 새기고(유비쿼터스 언어), 포인트컷·ArchUnit 규칙의
표적을 더 정밀하게 만들 수 있다. 트레이드오프: (1) 팀원에게 학습 비용이
생기고, (2) 애너테이션이 늘수록 "무엇이 기능이고 무엇이 장식인지" 경계가
흐려지며, (3) IDE·정적 분석 도구가 표준 스테레오타입만큼 지원하지 않을 수
있다. "표준 4종으로 충분하면 추가하지 않고, 계층 규칙을 도구로 강제할
필요가 생겼을 때만 도입한다"는 기준을 붙이면 균형 잡힌 답이 된다.

---

## 한 줄 요약

넷 다 `@Component`의 특수화라 빈 등록은 동일하지만, `@Repository`에는
영속성 예외를 `DataAccessException`으로 변환하는 프록시 기능이,
`@Controller`에는 요청 매핑 핸들러 후보로 인식되는 조건이 실제로 붙어
있고, `@Service`는 계층 의도를 선언하는 장식이다 — **"장식"과 "기능"을
구분해서 아는 것**이 이 질문의 답이다.
