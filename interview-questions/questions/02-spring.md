# 2. Spring / Spring Boot

## 기본 ⭐

- IoC와 DI란 무엇이고, 왜 사용하나요?
- Bean의 생명주기와 기본 스코프(singleton)를 설명해주세요. 싱글턴 빈에 상태를 두면 왜 위험한가요?
- 생성자 주입을 권장하는 이유는 무엇인가요? (필드 주입 대비)
- `@Component`, `@Service`, `@Repository`, `@Controller`의 차이는?
- Spring MVC의 요청 처리 흐름(DispatcherServlet → HandlerMapping → ...)을 설명해주세요.
- Filter와 Interceptor의 차이, 각각 어떤 용도에 적합한가요?
- `@Transactional`의 기본 동작을 설명해주세요. 어떤 예외에서 롤백되나요?
- Spring Boot의 Auto Configuration은 어떻게 동작하나요?
- `application.yml`의 profile은 어떻게 활용하나요?

## 중급 ⭐⭐

- AOP의 동작 원리(JDK Dynamic Proxy vs CGLIB)를 설명해주세요.
- 같은 클래스 내부 메서드 호출 시 `@Transactional`이 적용되지 않는 이유는? 해결 방법은?
- `@Transactional`의 전파(propagation) 옵션 중 `REQUIRED`와 `REQUIRES_NEW`의 차이와 실무 활용 사례는?
- `@Transactional(readOnly = true)`는 실제로 어떤 최적화를 해주나요?
- 트랜잭션 격리 수준 4가지와 각각에서 발생 가능한 문제(dirty read, non-repeatable read, phantom read)를 설명해주세요.
- `@Async`의 동작 원리와 주의점(스레드풀 설정, 예외 처리, 프록시)은?
- Spring Event(`ApplicationEventPublisher`)를 활용해본 경험이 있나요? `@TransactionalEventListener`는 언제 유용한가요?
- Bean 순환 참조가 발생하는 원인과 해결 방법은?
- `RestTemplate`, `WebClient`, `RestClient`의 차이와 선택 기준은?
- 예외를 전역으로 처리하는 방법(`@ControllerAdvice`)과 에러 응답 표준화를 어떻게 설계하나요?
- Spring Cache 추상화(`@Cacheable`)의 동작 원리와 함정은? (자기 호출 미적용, 캐시 키 설계, null 캐싱, TTL은 어디서 설정하나)
- Bean Validation(`@Valid`)과 도메인 검증의 역할 분담은 어떻게 하나요? 같은 검증이 계층마다 중복되는 문제는 어떻게 정리하나요?

## 고난이도 ⭐⭐⭐

- 트랜잭션 안에서 외부 API를 호출하면 어떤 문제가 생기나요? 어떻게 설계를 바꾸겠습니까?
- DB 커밋 후에 이벤트를 발행해야 하는 요구사항을 어떻게 구현하나요? (AFTER_COMMIT, Transactional Outbox)
- Spring의 트랜잭션 동기화(TransactionSynchronizationManager)와 커넥션 바인딩 원리를 설명해주세요.
- 톰캣 스레드풀(max-threads), DB 커넥션풀(HikariCP) 크기는 어떤 기준으로 산정하나요?
- HikariCP에서 커넥션 고갈(connection pool exhaustion)이 발생했습니다. 원인 후보와 진단 방법은?
- Spring WebFlux와 MVC의 스레딩 모델 차이를 설명해주세요. WebFlux 도입이 오히려 독이 되는 경우는?
- 배포 중 무중단(graceful shutdown)을 위해 Spring Boot에서 어떤 설정과 인프라 구성이 필요한가요?

## 알면 좋은 +α

- `@Value`와 `@ConfigurationProperties`의 차이와 선택 기준은?
- Actuator에서 운영에 실제로 활용하는 엔드포인트는? 외부 노출 시 보안 주의점은?
- Spring Security 필터 체인에서 인증은 어느 시점에 처리되나요? 커스텀 인증 필터는 어디에 끼우나요?
- 애플리케이션 시작 시간이 갑자기 길어졌습니다. 어떻게 추적하고 개선하나요?
- 컨트롤러마다 반복되는 인증 사용자 조회/검증 코드를 어떻게 제거하나요? (커스텀 ArgumentResolver, 인터셉터)
- `@Scheduled` 작업들은 기본적으로 어떤 스레드에서 실행되나요? 한 작업의 지연이 다른 작업에 미치는 영향과 대책은?
- AI가 생성한 서비스 코드를 트랜잭션 관점에서 리뷰할 때의 체크리스트는? (경계 위치, 자기 호출, 예외 삼킴, readOnly 여부)
