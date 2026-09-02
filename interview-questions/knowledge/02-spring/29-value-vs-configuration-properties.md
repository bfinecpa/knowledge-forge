# @Value vs @ConfigurationProperties — 설정 주입 두 방식의 차이와 선택 기준

> 핵심 관전 포인트: **`@Value`는 프로퍼티 **한 개**를 문자열 키로 찍어 필드에 꽂는 도구이고, `@ConfigurationProperties`는 **프리픽스로 묶인 설정 그룹을 통째로 타입 세이프 객체에 붓는** 도구다. 후자의 실무적 결정타는 `@Validated` + Bean Validation으로 잘못된 설정(오타·누락·범위 위반)을 **기동 시점 실패(fail-fast)**로 잡아낸다는 것 — `Binding to target ... failed: Property: payment.retryCount / Value: "0" / Reason: must be greater than or equal to 1`처럼 **어느 프로퍼티가 어느 파일 몇 번째 줄에서 왜 틀렸는지**를 찍고 앱이 뜨지 않는다. `@Value`는 기본값(`${x:3000}`)이 붙은 키가 누락되면 조용히 그 기본값으로 흘러가 한참 뒤 런타임 오동작으로 발각된다. 여기에 relaxed binding(`max-retry-count` / `maxRetryCount` / `MAX_RETRY_COUNT`를 같은 프로퍼티로 인식 → 환경변수로 운영 설정을 덮어쓸 수 있다), 생성자 바인딩 기반 불변 설정(부트 3에서는 생성자가 하나면 `@ConstructorBinding`도 생략 가능, record가 가장 깔끔), 스프링 없이 `new`로 만들어 쓰는 테스트 용이성까지가 후자 쪽 이점이다. 반대로 `@Value`만 할 수 있는 것은 SpEL(`#{...}`)인데, **설정 로직이 문자열 안에 숨어 IDE·컴파일러의 사정권 밖으로 나간다는 대가**를 안다는 것까지 말해야 균형이 잡힌다. 결론: 묶인 설정이 2개 이상이면 `@ConfigurationProperties`, SpEL이 꼭 필요한 단발 값만 `@Value`.**

---

## 0. 질문 + 의도

**질문**: "`@Value`와 `@ConfigurationProperties`의 차이와 선택 기준은?"

**출제 의도**: 설정 오타가 런타임에 조용히 기본값으로 도는 사고를 타입 안전 바인딩·검증으로 막는지 본다. 설정도 코드처럼 검증 대상으로 보는 규율의 표본이 되는 질문이다.

(이 문서의 버전 의존 서술은 **스프링 부트 3.x** 기준이며, 2.x와 달라지는 지점은 그때마다 표시한다.)

## 1. 둘은 무엇이고, 왜 선택지가 이 둘로 갈리는가

### 1-1. 전제 — yml의 값이 자바 객체에 도달하는 경로

두 애너테이션을 비교하기 전에, 그 밑에 깔린 구조를 한 문단으로 정리하고 가자.

스프링은 기동할 때 여러 출처(커맨드라인 인자, 환경변수, `application.yml`, 기본값 등)에서 프로퍼티를 읽어 **`Environment`라는 하나의 커다란 키-값 사전**을 만든다. 이 사전 안에서 값은 전부 **문자열**이다. `timeout: 3000`이라고 썼어도 사전에는 `"3000"`이라는 글자로 들어간다.

그러면 `int timeout = 3000`을 얻으려면 두 가지 일이 필요하다. **① 어느 키를 볼지 정하기**, **② 문자열을 원하는 타입으로 바꾸기**. `@Value`와 `@ConfigurationProperties`는 이 두 가지를 처리하는 서로 다른 방식이고, 둘의 모든 차이는 여기서 갈라져 나온다.

```
          [여러 출처]                    [Environment]              [내 자바 객체]
 커맨드라인 인자 ─┐
 환경변수       ─┤                 payment.api-url = "https://..."      ???
 application.yml ─┼──► 층층이 쌓아 합침 ►  payment.timeout   = "3s"     ◄─── 여기를 잇는 것이
 기본값        ─┘                 payment.retry-count = "3"           @Value / @ConfigurationProperties
```

`Environment`가 어떻게 층층이 쌓이고 무엇이 무엇을 덮는지는 [09-application-yml-profile.md](09-application-yml-profile.md)의 우선순위 표에 있다. 이 문서는 그 사전에서 **값을 꺼내 객체로 만드는 마지막 한 걸음**을 다룬다.

### 1-2. `@Value` — 값 하나를 문자열 키로 찍어 가져온다

`@Value`는 필드나 파라미터에 붙여 "이 자리에 이 키의 값을 넣어라"라고 지시하는 애너테이션이다. 키는 `${...}` 안에 **문자열로** 적는다.

```java
@Component
public class PaymentClient {

    // "payment.api-url 이라는 키의 값을 이 필드에 넣어라"
    @Value("${payment.api-url}")
    private String apiUrl;

    // 콜론 뒤는 기본값이다. 키가 없으면 3000이 들어간다.
    @Value("${payment.timeout-ms:3000}")
    private int timeoutMs;
}
```

동작 방식은 단순하다. 빈을 만든 뒤 `${...}` 안의 키로 `Environment`를 조회하고, 얻은 문자열을 필드 타입으로 변환해 리플렉션으로 꽂는다. **키 하나에 필드 하나**가 원칙이고, 그 관계를 잇는 것은 오직 문자열이다.

이름이 `@Value`인 이유도 여기 있다 — 다루는 단위가 **값(value) 하나**다.

### 1-3. `@ConfigurationProperties` — 프리픽스 아래를 통째로 객체에 붓는다

`@ConfigurationProperties`는 접근이 정반대다. 키를 하나씩 지목하지 않고, **접두어(prefix)를 하나 정한 다음 그 아래의 모든 키를 클래스의 필드 이름과 짝지어 한꺼번에 채운다.**

```yaml
# application.yml
payment:
  api-url: https://pg.example.com
  timeout: 3s
  retry-count: 3
```

```java
@ConfigurationProperties(prefix = "payment")   // "payment." 아래를 이 클래스에 붓는다
public class PaymentProperties {
    private String apiUrl;        // ← payment.api-url
    private Duration timeout;     // ← payment.timeout
    private int retryCount;       // ← payment.retry-count
    // getter/setter 생략
}
```

여기서 `api-url`이라는 yml 키가 `apiUrl`이라는 자바 필드와 어떻게 짝지어지는지가 궁금할 텐데, 그것이 2-3에서 다룰 **relaxed binding**이다.

이 방식을 **바인딩(binding)**이라고 부른다. 원래 웹 요청 파라미터를 객체에 채워 넣는 것을 가리키던 말인데, 설정에서도 같은 일 — **바깥에서 온 이름-값 쌍들을 객체의 필드에 묶어 채우는 일** — 이라 같은 단어를 쓴다.

이름이 `@ConfigurationProperties`인 이유도 분명하다 — 다루는 단위가 **설정 프로퍼티들(복수)의 묶음**이다.

### 1-4. 한눈에 비교

| | `@Value` | `@ConfigurationProperties` |
|---|---|---|
| 단위 | 프로퍼티 1개씩 필드에 주입 | 프리픽스 하위 전체를 객체로 바인딩 |
| 표현식 | `${...}` 플레이스홀더 + **SpEL**(`#{...}`) 지원 | `${...}`만 지원, SpEL 불가 |
| 키 매칭 | 키를 정확히 일치시켜야 함 | **relaxed binding** (2-3) |
| 타입 | 단순 변환만 | 중첩 객체, `List`/`Map`, `Duration`("10s")·`DataSize`("10MB") 변환 |
| 검증 | 불가 (개별 값에 대한 존재 여부뿐) | `@Validated` + Bean Validation으로 **기동 시점 검증** |
| 불변성 | 필드 주입이라 `final` 불가 | 생성자 바인딩으로 **불변 객체** 가능 |
| IDE 지원 | 없음 | configuration-processor로 자동완성 메타데이터 생성 |
| 테스트 | 스프링 컨텍스트가 있어야 값이 채워짐 | `new`로 직접 만들어 쓸 수 있음 |

표는 여기까지다. **표만 보면 "무엇이 다른가"는 알겠지만 "그래서 왜 문제가 되는가"는 안 보인다.** 2절이 그 자리다 — 각 차이가 실제로 어떤 사고로 이어지는지 하나씩 붙인다.

## 2. 차이 하나하나가 어떤 사고로 이어지는가

### 2-1. 사고 ① — 기본값이 붙은 키의 누락이 침묵한다

`@Value`의 동작을 정확히 알아야 이 사고가 보인다. **키가 없을 때의 행동이 기본값 유무에 따라 완전히 다르다.**

| 선언 | 키가 없으면 |
|---|---|
| `@Value("${payment.api-url}")` | 기동 실패 — `Could not resolve placeholder 'payment.api-url'` |
| `@Value("${payment.timeout-ms:3000}")` | **조용히 3000** — 아무 로그도 없다 |

기본값을 붙이는 건 보통 좋은 습관처럼 느껴진다. "값이 없어도 합리적인 값으로 돌게 하자"는 의도니까. 그런데 **그 순간 그 키는 오타를 검출할 수 없는 키가 된다.**

```java
// before: @Value 산탄총 — 오타·누락이 조용히 기본값으로 흘러간다
@Component
public class PaymentClient {

    @Value("${payment.api-url}")
    private String apiUrl;

    // 운영 yml에는 payment.timeout-ms 가 아니라 payment.timeoutMs 로 적혀 있었다.
    // 키가 안 맞으니 기본값 3000이 들어간다. 로그도 경고도 없다.
    @Value("${payment.timeout-ms:3000}")
    private int timeoutMs;

    // 운영 yml에서 이 키를 통째로 빠뜨렸다. 기본값 0이 들어간다.
    // "재시도 0회"는 문법적으로 완벽히 유효한 값이라 아무도 이상하게 여기지 않는다.
    @Value("${payment.retry-count:0}")
    private int retryCount;
}
```

이 코드가 실제로 어떻게 터지는지 시간 순으로 보면 이렇다.

```
t0   운영 배포. 앱이 정상 기동한다. 헬스체크 통과.
t1   평시 트래픽에서는 PG 응답이 200ms 안에 오므로 timeout 3000ms로도 멀쩡히 동작한다.
t2   PG사 쪽 지연 발생. 응답이 4초로 늘어난다.
     의도했던 timeout은 10000ms였는데 실제로는 3000ms라 전부 타임아웃.
t3   재시도로 흡수됐어야 하는데 retryCount가 0이다. 재시도가 한 번도 안 일어난다.
t4   결제 실패율 급등. 알림이 터진다.
t5   "왜 설정대로 안 돌지?" — yml에는 timeout-ms: 10000, retry-count: 3 이 분명히 적혀 있다.
     실제 주입값을 찍어 보고서야 오타를 발견한다.
```

**핵심은 t0에서 t4까지의 거리다.** 설정 오타는 배포 시점에 이미 존재했지만, 발각된 것은 장애가 난 뒤다. 그리고 하필이면 **장애 대응이 가장 급한 순간에** "설정이 안 먹는다"는 두 번째 문제를 추가로 풀어야 한다.

`@ConfigurationProperties`로 바꾸면 이 거리가 0이 된다.

```java
// after: 그룹 바인딩 + 검증 — 잘못된 설정이면 앱이 아예 뜨지 않는다
@Validated                                       // ① 이게 있어야 아래 제약이 실제로 검사된다
@ConfigurationProperties(prefix = "payment")
public record PaymentProperties(
        @NotBlank String apiUrl,                 // ② 비어 있으면 안 된다
        @NotNull Duration timeout,               // ③ yml에 timeout: 3s 로 적는다
        @Min(1) @Max(5) int retryCount           // ④ "값이 있음"이 아니라 "값이 유효함"을 본다
) {}
```

`payment.timeout`을 오타 냈다면 `timeout`이 `null`이 되고, `@NotNull` 위반으로 **기동이 실패한다.** 배포 파이프라인이 그 자리에서 빨간불이 되므로 운영에 나가지 못한다.

이것은 [09-application-yml-profile.md](09-application-yml-profile.md)에서 본 것과 정확히 같은 사상이다 — **"안전하지 않으면 조용히 도는 대신 아예 뜨지 않게 한다."** 프로파일 누락을 기동 실패로 바꾼 것과, 설정 오타를 기동 실패로 바꾸는 것은 같은 종류의 설계 결정이다.

주의: `@Validated`를 클래스(레코드)에 붙여야 검증이 켜지고, `jakarta.validation` 구현체가 클래스패스에 있어야 한다. 실무에서는 `spring-boot-starter-validation`을 추가하면 된다. 이게 없으면 제약 애너테이션은 **아무 일도 하지 않는다** — 붙였다고 안심하지 말고 일부러 틀린 값을 넣어 기동이 죽는지 한 번 확인하는 것이 좋다. 중첩 객체는 그 필드에 `@Valid`를 추가로 붙여야 안쪽까지 검사한다.

### 2-2. 사고 ② — "값이 있음"과 "값이 유효함"은 다르다, 그리고 실패 메시지가 다르다

2-1의 표에서 본 것처럼 `@Value`도 **기본값 없는 키가 빠지면** 기동에 실패하기는 한다. 그래서 "`@Value`도 fail-fast 되는 것 아니냐"는 반문이 나온다. 두 실패를 나란히 놓고 보면 차이가 분명해진다.

**`@Value`가 실패할 때의 메시지:**

```
***************************
APPLICATION FAILED TO START
***************************

Description:

Failed to bind properties under '' to java.lang.String:

... (실제로는 대개 아래 예외가 원인으로 찍힌다)
java.lang.IllegalArgumentException: Could not resolve placeholder 'payment.api-url'
in value "${payment.api-url}"
```

알려주는 것은 **"이 키가 없다"** 하나뿐이다. 값이 존재하기만 하면 그 값이 말이 되는지는 전혀 보지 않는다. `retry-count: -5`도, `retry-count: 9999`도 통과한다.

**`@ConfigurationProperties` + `@Validated`가 실패할 때의 메시지:**

```
***************************
APPLICATION FAILED TO START
***************************

Description:

Binding to target com.example.payment.PaymentProperties failed:

    Property: payment.retryCount
    Value: "0"
    Origin: class path resource [application.yml] - 12:20
    Reason: must be greater than or equal to 1

Action:

Update your application's configuration
```

이 네 줄이 각각 무엇을 알려주는지 짚어 보면 값어치가 드러난다.

| 줄 | 알려주는 것 | 없으면 뭘 해야 하나 |
|---|---|---|
| `Property: payment.retryCount` | **어느 프로퍼티**가 문제인지 | 전체 설정을 눈으로 훑어야 한다 |
| `Value: "0"` | 실제로 바인딩된 값이 무엇인지 | 로그를 찍어 확인해야 한다 |
| `Origin: ... application.yml - 12:20` | **어느 파일 몇 번째 줄 몇 번째 칸**에서 온 값인지 | 어느 프로파일 파일이 이겼는지 추적해야 한다 |
| `Reason: must be greater than or equal to 1` | 어떤 규칙을 어겼는지 | 코드를 읽어 의도를 역추적해야 한다 |

특히 `Origin`이 실무에서 크다. 설정값은 여러 층에서 덮어써지므로(커맨드라인 > 환경변수 > 프로파일 yml > 기본 yml) **"내가 고친 파일이 실제로 이긴 파일이 맞나"**가 늘 의심스러운데, `Origin`이 그 답을 직접 준다. `Origin`이 `application-prod.yml`이 아니라 `application.yml`을 가리키고 있다면 프로파일 파일에 그 키가 아예 없다는 뜻이다.

`Reason`에 찍히는 문구는 Bean Validation 제약의 기본 메시지다. `@Min(1)` → `must be greater than or equal to 1`, `@NotBlank` → `must not be blank`, `@NotNull` → `must not be null`. `@Min(value = 1, message = "재시도는 1회 이상이어야 합니다")`처럼 직접 지정하면 그 문구가 그대로 찍히므로, 팀에서 자주 실수하는 설정에는 한국어 안내를 넣어 두는 것도 좋다.

정리하면 이렇다. **`@Value`가 잡는 것은 "값의 부재"뿐이고, `@ConfigurationProperties` + `@Validated`가 잡는 것은 "값의 부적절함"이다.** 그리고 실무의 설정 사고는 대부분 후자다 — 값이 없어서 나는 사고보다, 값이 있는데 틀려서 나는 사고가 훨씬 많고 훨씬 늦게 발견된다.

### 2-3. 사고 ③ — 키 표기가 안 맞아 값이 안 들어간다: relaxed binding

**relaxed binding**은 "느슨한 바인딩"이라는 뜻으로, **같은 프로퍼티를 여러 표기법으로 써도 전부 같은 것으로 인식해 주는 규칙**이다. 이름에 "느슨한"이 붙은 이유는, 키를 글자 그대로 대조하는 엄격한 방식과 대비되기 때문이다.

`@ConfigurationProperties`의 `int retryCount` 필드는 아래 표기를 **전부 같은 프로퍼티로 받아들인다.**

| 표기 | 이름 | 주로 쓰는 자리 |
|---|---|---|
| `retry-count` | 케밥 케이스 | yml·properties 파일 (권장 표기) |
| `retryCount` | 카멜 케이스 | 자바 필드명 그대로 쓴 경우 |
| `retry_count` | 스네이크 케이스 | 다른 시스템에서 옮겨온 설정 |
| `RETRY_COUNT` | 대문자 스네이크 | **환경변수** |

마지막 줄이 이 규칙의 실무적 핵심이다. **셸 환경변수 이름에는 점(`.`)이나 하이픈(`-`)을 쓸 수 없다.** `payment.retry-count=3`이라는 환경변수는 만들 수가 없다. 그래서 스프링은 프로퍼티 이름을 환경변수 형태로 변환한 후보들도 함께 조회한다 — 점과 하이픈을 밑줄로 바꾸고 대문자로 올린 `PAYMENT_RETRY_COUNT`(그리고 하이픈을 아예 제거한 `PAYMENT_RETRYCOUNT`)가 그 후보다.

```bash
# yml을 고치지 않고 이 값 하나만 환경변수로 덮는다
export PAYMENT_RETRY_COUNT=5
java -jar app.jar
```

이것이 왜 중요한가. [09-application-yml-profile.md](09-application-yml-profile.md)의 우선순위 표에서 **환경변수는 yml보다 강했다.** 즉 relaxed binding 덕분에 **jar 안의 yml을 손대지 않고, 재빌드 없이, 컨테이너의 환경변수 하나로 운영 설정을 덮어쓸 수 있다.** k8s Deployment의 `env:` 항목이 그대로 스프링 설정 오버라이드가 되는 것이 이 규칙 위에 서 있다.

```
[k8s Deployment]                 [스프링]
env:
  - name: PAYMENT_RETRY_COUNT  ──►  payment.retry-count  ──►  PaymentProperties.retryCount
    value: "5"                      (환경변수 층이 yml 층을 덮는다)
```

`@Value`는 어떤가. **`@Value`에는 relaxed binding이 없다.** `${...}` 안에 적은 문자열로 사전을 조회할 뿐이다.

```java
@Value("${payment.retryCount}")   // yml에는 retry-count 로 적혀 있다
private int retryCount;           // → Could not resolve placeholder. 기동 실패.
```

다만 여기서 흔한 오해 하나를 정확히 정리하고 넘어가야 한다. **"그럼 `@Value`는 환경변수로 못 덮나?" — 덮을 수 있다.** relaxed binding과는 다른 경로다. 환경변수를 담는 프로퍼티 소스 자체가 조회할 때 이름을 한 번 정규화해 주기 때문이다 — 점과 하이픈을 밑줄로 바꾸고 대문자로 올려 다시 찾아본다. 그래서 `@Value("${payment.retry-count}")`는 환경변수 `PAYMENT_RETRY_COUNT`로 덮인다.

**`@Value`에 없는 것은 "yml 키 표기 사이의 유연함"이다.** yml에 `retry-count`로 적어 놓고 `@Value("${payment.retryCount}")`로 읽으려 하면 못 찾는다. 그리고 이 실수는 위험한 방향으로 조용하다 — 기본값을 붙여 뒀다면(2-1) 기동조차 실패하지 않는다.

### 2-4. 사고 ④ — 산탄총처럼 흩어진 설정은 회수할 수 없다

`@Value`는 붙이는 자리가 자유롭다. 아무 빈의 아무 필드에나 붙일 수 있다. 편해 보이지만, 프로젝트가 커지면 이 자유가 문제가 된다.

```java
// 같은 payment 설정이 세 클래스에 흩어져 있다
@Component class PaymentClient   { @Value("${payment.api-url}")      String url; }
@Component class PaymentRetrier  { @Value("${payment.retry-count:0}") int retry; }
@Component class PaymentMetrics  { @Value("${payment.api-url}")      String url; }  // 중복
```

`payment.api-url`을 `payment.gateway.url`로 이름을 바꿔야 한다고 하자. 무엇을 해야 하나. **문자열 전체 검색이 유일한 수단이다.** 컴파일러는 도와주지 않는다 — `@Value` 안의 문자열은 컴파일러 입장에서 그냥 문자열 상수이므로, 하나를 빠뜨려도 빌드가 성공한다. 빠뜨린 그 하나는 기동 시점(기본값이 없다면)이나 런타임(기본값이 있다면)에야 드러난다.

이것을 **산탄총 수술(shotgun surgery)**이라고 부른다. 하나의 변경을 위해 여러 곳을 흩어 고쳐야 하는 상태를 가리키는 말이다.

`@ConfigurationProperties`는 이 문제를 구조로 없앤다. **설정 키 문자열이 등장하는 곳은 프로퍼티 클래스 하나뿐**이고, 나머지 코드는 전부 타입으로 참조한다.

```java
// after: 설정이 타입으로 흐른다 — 문자열 키는 PaymentProperties 안에만 있다
@Component
public class PaymentClient {

    private final PaymentProperties props;

    public PaymentClient(PaymentProperties props) { this.props = props; }

    public void call() {
        // props.apiUrl() 은 컴파일러가 아는 이름이다.
        // 필드 이름을 바꾸면 이 줄에서 컴파일 에러가 난다 — 빠뜨릴 수가 없다.
        restClient.get().uri(props.apiUrl()).retrieve();
    }
}
```

부수적으로 얻는 것이 하나 더 있다. **`spring-boot-configuration-processor` 의존성을 추가하면**, 컴파일 시점에 프로퍼티 클래스를 읽어 메타데이터 파일(`META-INF/spring-configuration-metadata.json`)을 생성한다. 그러면 IDE가 `application.yml`에서 `payment.` 까지만 쳐도 **자동완성과 타입 힌트, 자바독 설명까지** 보여준다. 오타를 애초에 안 내게 만드는 예방책이다.

### 2-5. 사고 ⑤ — 설정 객체가 가변이면 언젠가 누가 바꾼다

`@Value` 필드 주입은 **`final`을 쓸 수 없다.** 객체를 먼저 만들고 나중에 리플렉션으로 값을 꽂는 순서라서, `final` 필드에는 넣을 자리가 없기 때문이다. `@ConfigurationProperties`의 setter 기반 바인딩도 마찬가지로 setter가 있어야 하므로 가변이다.

가변이라는 것은 곧 **기동 후에 누군가 값을 바꿀 수 있다**는 뜻이다.

```java
// 이런 코드가 리뷰를 통과해 버린다
@Service
public class BatchService {
    private final PaymentProperties props;

    public void runBulk() {
        props.setTimeout(Duration.ofMinutes(5));  // "배치니까 타임아웃 늘리자"
        // ... 그리고 되돌리지 않는다.
        // 같은 빈을 공유하는 온라인 결제 경로의 타임아웃도 5분이 된다.
    }
}
```

`@ConfigurationProperties` 빈은 싱글턴이다. 한 곳에서 바꾸면 **그 빈을 주입받은 모든 곳의 값이 함께 바뀐다.** 게다가 이 변경은 스레드 안전하지도 않아, 어떤 요청은 3초 타임아웃을 보고 어떤 요청은 5분을 보는 상태가 된다.

생성자 바인딩으로 만들면 이 사고 유형이 **구조적으로 불가능**해진다. setter가 없으니 바꿀 방법이 없다.

## 3. 그래서 어떻게 쓰나 — 바인딩·등록·SpEL·선택 기준

### 3-1. 생성자 바인딩과 record — 요즘의 표준형

**생성자 바인딩(constructor binding)**은 setter로 하나씩 채우는 대신 **생성자 파라미터로 한 번에 채우는** 바인딩 방식이다. 객체가 완성되는 순간 이미 모든 값이 들어가 있으므로 필드를 `final`로 둘 수 있고, 곧 불변 객체가 된다.

**버전에 따라 문법이 다르므로 정확히 짚는다.**

| 부트 버전 | 필요한 선언 | 비고 |
|---|---|---|
| 2.2 ~ 2.x | 클래스 또는 생성자에 `@ConstructorBinding` 필수 | 패키지: `...context.properties.ConstructorBinding` |
| 3.0 ~ | **생성자가 하나면 생략 가능**. 생성자가 여럿일 때만 그중 하나에 붙인다 | 패키지 이동: `...context.properties.bind.ConstructorBinding`, 그리고 **생성자에만** 붙일 수 있다 |

부트 3에서 record를 쓰면 생성자가 자동으로 하나뿐이므로 애너테이션이 아예 필요 없다. 이것이 요즘 가장 깔끔한 형태다.

```java
// after: 부트 3.x — record + 검증. 애너테이션 두 개로 끝난다.
@Validated
@ConfigurationProperties(prefix = "payment")
public record PaymentProperties(
        @NotBlank String apiUrl,
        @NotNull Duration timeout,
        @Min(1) @Max(5) int retryCount,
        Retry retry                       // 중첩 설정도 record로 받을 수 있다
) {
    // 중첩 타입: yml의 payment.retry.* 아래가 여기로 들어온다
    public record Retry(@NotNull Duration backoff, boolean jitter) {}
}
```

```yaml
payment:
  api-url: https://pg.example.com
  timeout: 3s              # Duration으로 변환된다 (3초)
  retry-count: 3
  retry:
    backoff: 500ms
    jitter: true
```

`timeout: 3s`가 `Duration`이 되는 것은 부트의 `ApplicationConversionService`가 `Duration`·`DataSize` 전용 컨버터를 제공하기 때문이다. `s`, `ms`, `m`, `h` 접미어를 알아듣고, 단위 없이 숫자만 쓰고 싶으면 필드에 `@DurationUnit(ChronoUnit.SECONDS)`로 기본 단위를 지정할 수 있다. `DataSize`도 같은 방식으로 `10MB`를 파싱한다.

**함정 하나.** 생성자 바인딩은 **`@EnableConfigurationProperties`나 `@ConfigurationPropertiesScan`으로 등록한 경우에만** 동작한다. 프로퍼티 클래스에 `@Component`를 붙여 컴포넌트 스캔으로 올리면 스프링의 일반 빈 생성 경로를 타므로 setter 기반 JavaBean 바인딩만 적용되고, record처럼 setter가 없는 타입은 값이 채워지지 않는다.

### 3-2. 등록 방법 두 가지

```java
// 방법 1: 패키지 스캔 — 메인 클래스에 한 번만 붙이면 @ConfigurationProperties 붙은 클래스를 전부 찾는다
@SpringBootApplication
@ConfigurationPropertiesScan
public class MyApplication { ... }
```

```java
// 방법 2: 명시 등록 — 필요한 것만 하나씩 올린다
@Configuration
@EnableConfigurationProperties(PaymentProperties.class)
public class PaymentConfig { ... }
```

라이브러리나 자동 구성 모듈을 만들 때는 방법 2를 쓴다. 컴포넌트 스캔 범위에 의존하지 않고 "이 설정 클래스가 필요하다"를 코드로 명시하기 때문이다. 애플리케이션 코드에서는 방법 1이 편하다.

### 3-3. `@Value`만 할 수 있는 것 — SpEL, 그리고 그 대가

`@Value`가 여전히 살아남는 이유는 하나다. **SpEL(Spring Expression Language)** — 문자열 안에 작은 표현식을 써서 값을 계산할 수 있는 문법이다. `${...}`가 "사전에서 값을 꺼내라"라면, `#{...}`는 "이 식을 평가해라"다.

```java
// SpEL의 실제 용도 세 가지
public class TimeConfig {

    // ① JVM 시스템 프로퍼티 읽기 — Environment의 프로퍼티 키로는 안 잡히는 값
    @Value("#{systemProperties['user.timezone']}")
    private String jvmTimezone;

    // ② 다른 빈의 값 참조 — 설정 파일에 없는, 런타임에 계산되는 값
    @Value("#{schedulerConfig.poolSize * 2}")
    private int workerCount;

    // ③ 문자열을 리스트로 쪼개기 (프로퍼티 값 + 표현식 조합)
    @Value("#{'${payment.allowed-methods}'.split(',')}")
    private List<String> allowedMethods;
}
```

여기까지가 장점이다. 그런데 **이 유연함이 왜 오히려 위험한지**를 함께 말할 수 있어야 균형이 잡힌다.

**첫째, 설정 로직이 문자열 안에 숨는다.** `#{schedulerConfig.poolSize * 2}`는 명백히 **로직**이다 — "워커 수는 풀 크기의 두 배"라는 정책이 문자열 안에 들어가 있다. 자바 코드로 썼다면 메서드 하나에 이름이 붙고 테스트가 붙었을 규칙이, 애너테이션 인자 안에 갇힌다.

**둘째, 컴파일러와 IDE의 사정권 밖이다.** `schedulerConfig`라는 빈 이름을 바꾸거나 `poolSize` 게터를 `getCorePoolSize()`로 리팩터링해도 **컴파일은 성공한다.** IDE의 "이름 바꾸기(rename)" 리팩터링도 이 문자열은 건드리지 않는다. 깨진 사실은 기동할 때 `SpelEvaluationException`으로 처음 드러난다.

**셋째, 표현식이 커지면 아무도 못 읽는다.** 위 ③번만 해도 `#{'${...}'.split(',')}`처럼 따옴표와 두 종류의 괄호가 섞여 있다. 여기에 조건식이나 `?:`가 붙기 시작하면 리뷰가 불가능해진다.

그래서 실무 기준은 이렇게 잡는다.

```java
// before: 설정 로직을 SpEL 문자열에 넣는다 — 리팩터링에 취약하고 테스트할 수 없다
@Value("#{'${payment.allowed-methods}'.split(',')}")
private List<String> allowedMethods;

// after: 리스트 바인딩은 @ConfigurationProperties가 기본 제공한다.
//        yml에 payment.allowed-methods: CARD,BANK 라고 쓰면 List<String>으로 들어온다.
@ConfigurationProperties(prefix = "payment")
public record PaymentProperties(List<String> allowedMethods) {}
```

**SpEL은 "설정 파일로는 표현할 수 없는 런타임 값"에만 쓴다.** 값을 쪼개거나 계산하는 정도의 일은 대부분 `@ConfigurationProperties`의 타입 변환이 이미 해준다.

### 3-4. 선택 기준

- **묶인 설정이 2개 이상** → 고민 없이 `@ConfigurationProperties`. 검증·불변·테스트 용이성·자동완성이 전부 따라온다.
- **SpEL이 꼭 필요한 단발 값** (`#{systemProperties[...]}`, 다른 빈의 값 참조) → `@Value`.
- **애매하면 `@ConfigurationProperties`.** 설정은 늘어나기 마련이고, 흩어진 `@Value`를 나중에 회수하는 비용이 처음부터 클래스 하나 만드는 비용보다 훨씬 크다(2-4).

한 가지 더 덧붙이면 좋다. **`@Value`를 쓰더라도 기본값(`:default`)은 함부로 붙이지 않는다.** 기본값은 "이 값이 없어도 이 앱은 올바르게 동작한다"는 선언인데, 대부분의 설정은 그렇지 않다. 없으면 기동이 실패하도록 두는 편이 2-1의 사고를 막는다.

## 4. 꼬리질문 대비 포인트

### "`@Value`도 키 오타면 기동에 실패하지 않나요?"

**절반만 맞다.** 기본값(`:default`)이 없는 키는 `Could not resolve placeholder`로 기동에 실패한다. 하지만 **기본값이 붙은 키는 누락되거나 오타가 나도 조용히 그 기본값으로 흘러간다** — 로그도 경고도 없다.

그리고 더 중요한 차이가 있다. `@Value`가 검사하는 것은 **"값이 있는가"뿐이고, "값이 유효한가"는 보지 않는다.** `retry-count: -5`도, `timeout: 0`도 통과한다. `@Min(1)` 같은 제약으로 유효성까지 기동 시점에 잡는 것은 `@ConfigurationProperties` + `@Validated`만 할 수 있다.

실무의 설정 사고는 대부분 후자 쪽이다 — 값이 없어서 나는 사고보다, 값이 있는데 틀려서 나는 사고가 훨씬 늦게 발견된다.

### "record로 만들면 값을 못 바꾸는데, 운영 중에 설정을 바꿔야 하면요?"

**못 바꾸는 것이 목적이다.** 싱글턴 설정 빈을 아무나 바꿀 수 있으면 한 곳의 변경이 전체에 새는 사고가 난다(2-5).

런타임 동적 갱신이 정말 필요하다면 그건 **별도 장치의 영역**이다. Spring Cloud Config Server + `@RefreshScope` 조합이 대표적으로, 설정 서버의 값이 바뀌면 해당 빈을 **새로 만들어 교체한다.** 값을 수정하는 게 아니라 객체를 통째로 갈아 끼우는 방식이므로 불변성과 충돌하지 않는다.

여기서 트레이드오프를 함께 말하면 좋다. 동적 갱신은 "설정 서버가 죽으면 전 서비스가 영향을 받는" 새 결합을 만든다([09-application-yml-profile.md](09-application-yml-profile.md)의 마지막 꼬리질문과 같은 논점이다). 서비스 몇 개 규모에서는 **재배포로 설정을 바꾸는 편이 단순하고 안전하다.**

### "`Duration`은 어떻게 `3s`를 파싱하나요?"

부트의 `ApplicationConversionService`가 `Duration`·`DataSize` 등에 대한 전용 컨버터를 등록해 두기 때문이다. `3s`, `500ms`, `10m`, `2h` 같은 접미어를 알아듣는다.

단위 없이 숫자만 쓰고 싶으면 필드에 `@DurationUnit(ChronoUnit.SECONDS)`을 붙여 기본 단위를 지정한다. `DataSize`도 같은 구조로 `@DataSizeUnit`이 있고 `10MB` 같은 표기를 파싱한다.

여기서 한 걸음 더 들어가면 변별이 된다. **이 변환은 그 자체로 검증 역할을 한다.** `timeout: 3초`처럼 파싱할 수 없는 값을 쓰면 바인딩 단계에서 실패해 앱이 뜨지 않는다. `@Value("${payment.timeout-ms}") int`로 받았다면 밀리초 단위라는 사실이 **필드 이름에만 적혀 있어** yml에 `10`(10ms를 의도했는지 10초를 의도했는지 모를 값)을 써도 아무도 못 잡는다. 타입이 단위를 강제하는 것이 `Duration`의 진짜 값어치다.

### "`@ConfigurationProperties` 빈을 다른 빈에서 어떻게 쓰나요?"

일반 빈처럼 **생성자 주입**으로 받으면 된다. `@Autowired`도 필요 없다(생성자가 하나면 생략 가능).

```java
@Service
public class PaymentService {
    private final PaymentProperties props;
    public PaymentService(PaymentProperties props) { this.props = props; }
}
```

이 방식의 효과는 "편하다"에 그치지 않는다. **설정이 문자열 키가 아니라 타입으로 흐르므로**, 어떤 설정이 어디서 쓰이는지를 IDE의 "사용처 찾기"로 정확히 알 수 있고, 이름을 바꾸면 컴파일러가 모든 사용처를 짚어 준다(2-4).

테스트도 쉬워진다. 스프링 컨텍스트 없이 그냥 만들면 된다.

```java
// 스프링을 띄우지 않는 순수 단위 테스트
var props = new PaymentProperties("https://stub", Duration.ofSeconds(3), 3, null);
var service = new PaymentService(props);
```

`@Value` 필드 주입은 이게 안 된다. `new PaymentClient()`로 만들면 `@Value` 필드가 전부 `null`·`0`이라, 값을 넣으려면 리플렉션(`ReflectionTestUtils.setField`)을 쓰거나 스프링 컨텍스트를 통째로 띄워야 한다. **테스트가 무거워지는 원인이 사실은 설정 주입 방식에 있는 경우가 흔하다.**

### "그럼 `@Value`는 이제 안 쓰는 게 맞나요?" (시니어 변별 포인트)

"안 쓴다"고 단정하면 오히려 감점이다. **경계를 그어 답하는 것**이 이 질문의 의도다.

**`@Value`가 여전히 옳은 자리**는 셋이다. ① SpEL이 필요한 값(다른 빈 참조, 시스템 프로퍼티), ② 프로퍼티 클래스를 만들 만큼 묶이지 않은 진짜 단발 값 하나, ③ 라이브러리 코드에서 프로퍼티 클래스를 노출하고 싶지 않을 때.

**`@ConfigurationProperties`로 가야 하는 자리**는 그 외 전부다. 특히 **운영에 영향을 주는 값**(타임아웃, 재시도, 풀 크기, 외부 연동 주소)은 예외 없이 이쪽이어야 한다. 이유는 2절 전체다 — 이 값들이야말로 틀렸을 때 늦게, 그리고 장애 중에 발견되는 값들이다.

한 걸음 더 나아가면 이렇게 정리할 수 있다. **이 질문의 본질은 애너테이션 선택이 아니라 "설정을 코드와 같은 급으로 취급하는가"다.** 코드에는 타입이 있고, 컴파일러가 검사하고, 테스트가 있고, 리팩터링이 안전하다. `@ConfigurationProperties`는 설정에 그 넷을 전부 붙여 주는 장치이고, `@Value` 산탄총은 설정을 "문자열 키로 아무 데서나 꺼내 쓰는 전역 변수" 상태로 두는 것이다.

**설정 오타는 코드 버그와 똑같은 무게의 사고**인데, 코드 버그는 컴파일러와 테스트가 잡아 주고 설정 오타는 아무도 안 잡아 준다면 — 그 비대칭을 메우는 것이 `@Validated` + 기동 시점 실패다.

---

## 한 줄 요약

`@Value`는 문자열 키로 값 하나를 찍어 오는 도구라 SpEL이 필요한 단발 값에만 쓰고, 그 외에는 `@ConfigurationProperties`로 프리픽스 그룹을 **불변·타입 세이프 객체**(부트 3에서는 record 하나로 충분)에 바인딩한 뒤 `@Validated`로 잘못된 설정을 **`Property` · `Value` · `Origin` · `Reason`이 찍히는 기동 시점 실패**로 드러내는 것이 정석이다 — relaxed binding 덕에 환경변수로 운영 값을 덮어쓰는 길까지 열리므로, 묶인 설정이 2개 이상이면 고민 없이 후자다.
