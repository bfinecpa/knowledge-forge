# @Value vs @ConfigurationProperties — 설정 주입 두 방식의 차이와 선택 기준

> 핵심 관전 포인트: `@Value`는 **단일 값**을 플레이스홀더(`${...}`)나 SpEL(`#{...}`)로 주입하는 도구이고, `@ConfigurationProperties`는 **프리픽스로 묶인 설정 그룹을 타입 세이프 객체로 바인딩**하는 도구다. 후자의 실무적 결정타는 `@Validated` + Bean Validation으로 잘못된 설정(오타·누락·범위 위반)을 **기동 시점 실패(fail-fast)**로 조기 검출할 수 있다는 것 — 설정 사고가 런타임 NPE로 늦게 터지는 대신 배포 순간 시끄럽게 드러난다. 묶인 설정이 2개 이상이면 `@ConfigurationProperties`, SpEL이 필요한 단발 값만 `@Value`.

## 0. 질문 + 의도

**질문**: "`@Value`와 `@ConfigurationProperties`의 차이와 선택 기준은?"

**출제 의도**: 설정 오타가 런타임에 조용히 기본값으로 도는 사고를 타입 안전
바인딩·검증으로 막는지 본다. 설정도 코드처럼 검증 대상으로 보는 규율의
표본이 되는 질문이다.

## 1. 기본 구분

| | `@Value` | `@ConfigurationProperties` |
|---|---|---|
| 단위 | 프로퍼티 1개씩 필드에 주입 | 프리픽스 하위 전체를 객체로 바인딩 |
| 표현식 | `${...}` 플레이스홀더 + **SpEL**(`#{...}`) 지원 | SpEL 불가 |
| 바인딩 방식 | 키를 정확히 일치시켜야 함 | **relaxed binding**(케밥↔카멜↔대문자 스네이크 자동 매핑) |
| 타입 | 단순 변환만 | 중첩 객체, List/Map, `Duration`("10s")·`DataSize`("10MB") 변환 |
| 검증 | 불가(개별 값뿐) | `@Validated` + Bean Validation으로 **기동 시점 검증** |
| IDE 지원 | 없음 | configuration-processor로 자동완성 메타데이터 생성 |

## 2. 결정타 — 잘못된 설정을 기동 시점에 잡는다 (fail-fast)

```java
// ❌ before: @Value 산탄총 — 오타·누락이 조용히 null/기본값으로 흘러가
//    첫 사용 시점(런타임)에야 NPE·오동작으로 발각
@Component
class PaymentClient {
    @Value("${payment.api-url}") private String apiUrl;      // 키 오타면? → 기동 실패는 하지만
    @Value("${payment.timeout-ms:3000}") private int timeout; // 기본값 있는 키는 누락돼도 침묵
    @Value("${payment.retry-count:0}") private int retryCount; // 0이 유효한 값처럼 흘러감
}
```

```java
// ✅ after: 그룹 바인딩 + 검증 + 불변(record 생성자 바인딩)
@Validated
@ConfigurationProperties(prefix = "payment")
public record PaymentProperties(
        @NotBlank String apiUrl,
        @NotNull Duration timeout,        // yml: timeout: 3s
        @Min(1) @Max(5) int retryCount
) {}
```

- 검증 위반·바인딩 실패 시 **애플리케이션이 기동 자체를 실패**한다 — 프로파일 누락을 기동 실패로 드러내는 [09-application-yml-profile.md](09-application-yml-profile.md)의 fail-fast 원칙과 같은 맥락. "안전하지 않으면 아예 뜨지 않게"가 설정 설계의 방어선.
- `@Validated`를 클래스에 붙여야 검증이 활성화되고, 중첩 객체는 필드에 `@Valid`를 추가.

## 3. 그 외 이점

- **불변 객체**: 생성자 바인딩(record 포함)으로 setter 없는 불변 설정 — 기동 후 누구도 값을 못 바꾼다.
- **relaxed binding**: yml의 `retry-count`가 자바의 `retryCount`로 자동 매핑 — 환경변수 `PAYMENT_RETRY_COUNT`도 같은 키로 인식.
- **IDE 메타데이터**: `spring-boot-configuration-processor` 의존성을 추가하면 yml 자동완성·설명 제공.
- **테스트 용이**: `new PaymentProperties("https://...", Duration.ofSeconds(3), 3)`처럼 스프링 없이 직접 생성해 단위 테스트 가능.

## 4. 등록 방법

```java
@ConfigurationPropertiesScan          // 방법 1: 패키지 스캔 (메인 클래스에)
// 또는
@EnableConfigurationProperties(PaymentProperties.class)  // 방법 2: 명시 등록
```

- 생성자 바인딩은 이 두 방법으로 등록해야 동작한다(`@Component`로 올리면 setter 기반 JavaBean 바인딩만).

## 5. 선택 기준

- **묶인 설정 2개 이상** → 무조건 `@ConfigurationProperties`. 검증·불변·테스트·자동완성이 전부 따라온다.
- **SpEL이 필요한 단발 값**(`#{systemProperties['user.timezone']}`, 다른 빈의 값 참조) → `@Value`.
- 애매하면 `@ConfigurationProperties` — 설정은 늘어나기 마련이고, `@Value` 산탄총은 나중에 회수 비용이 크다.

## 꼬리질문 대비 포인트

- **"@Value 키 오타면 기동 실패하지 않나?"** — 기본값(`:default`) 없는 키는 기동 실패하지만, **기본값이 있는 키는 누락이 침묵**한다. 검증(@Min 등)으로 "값이 있음"과 "값이 유효함"을 구분해 잡는 것은 `@ConfigurationProperties`만 가능.
- **"record면 값 변경은?"** — 못 바꾼다(불변이 목적). 런타임 동적 갱신이 필요하면 Spring Cloud Config + `@RefreshScope` 같은 별도 장치의 영역.
- **"Duration은 어떻게 '3s'를 파싱하나?"** — 부트의 ApplicationConversionService가 `Duration`/`DataSize` 등 전용 컨버터 제공. `@DurationUnit`으로 단위 없는 숫자의 기본 단위 지정 가능.
- **"@ConfigurationProperties 빈을 다른 빈에서 어떻게 쓰나?"** — 일반 빈처럼 생성자 주입. 설정이 타입으로 흐르므로 문자열 키가 코드 여기저기 흩어지지 않는다.

## 한 줄 요약

`@Value`는 SpEL이 필요한 단발 값용, `@ConfigurationProperties`는 프리픽스 그룹을 불변·타입 세이프 객체로 바인딩하고 `@Validated`로 잘못된 설정을 **기동 시점 실패**로 드러내는 정석 — 묶인 설정 2개 이상이면 고민 없이 후자다.
