# Bean Validation(@Valid)과 도메인 검증의 역할 분담 — "이 검증은 누구의 책임인가"를 계층 설계로 답하기

> 핵심 관전 포인트: **분담 기준은 "검증에 무엇이 필요한가"다. 요청 값
> 자체만 보고 판정할 수 있는 형식 검증(null/공백, 길이, 형식, 범위)은
> 컨트롤러 진입 시점에 Bean Validation(`@Valid`)으로 걸러 400으로
> 끝내고, 다른 데이터(DB 상태)나 도메인 규칙이 필요한 비즈니스 검증
> (재고 있는가, 이 상태에서 취소 가능한가)은 도메인/애플리케이션
> 계층이 맡는다. 계층 간 "중복"은 목적이 다르면 중복이 아니다 — DTO는
> "요청이 올바른 형태인가"에, 도메인은 "이 객체가 항상 유효한 상태인가
> (불변식)"에 답한다. 진짜 중복(같은 형식 규칙이 여러 DTO에 복붙)은
> 커스텀 제약 애너테이션과 값 객체(VO)로 한곳에 봉인해 정리한다.**

---

## 0. 질문 + 의도

**질문**: "Bean Validation(`@Valid`)과 도메인 검증의 역할 분담은 어떻게
하나요? 같은 검증이 계층마다 중복되는 문제는 어떻게 정리하나요?"

**출제 의도**: 형식 검증(컨트롤러)과 비즈니스 규칙 검증(도메인)의
경계가 없으면 검증이 중복되거나, 더 나쁘게는 "저쪽에서 하겠지"로
누락된다. "이 검증은 누구의 책임인가"를 계층 설계로 답할 수 있는지 —
검증을 애너테이션 장식이 아니라 설계 요소로 다루는지 본다.

## 1. Bean Validation이 하는 일 — 요청의 "형태"를 문 앞에서 거른다

Bean Validation은 자바 표준 검증 스펙(구현체는 Hibernate Validator)이고,
스프링 MVC는 컨트롤러 파라미터에 `@Valid`(또는 `@Validated`)가 붙으면
바인딩 직후 자동으로 검증을 실행한다.

```java
public record SignUpRequest(
        @NotBlank @Email String email,
        @NotBlank @Size(min = 8, max = 64) String password,
        @NotNull @Past LocalDate birthDate
) {}

@PostMapping("/members")
public MemberResponse signUp(@RequestBody @Valid SignUpRequest request) {
    return memberService.signUp(request.toCommand());
}
```

- 검증 실패 시 컨트롤러 본문에 들어가기 전에
  `MethodArgumentNotValidException`이 던져지고, 보통
  `@ControllerAdvice`에서 받아 **400 Bad Request + 필드별 에러 목록**으로
  표준화한다.
- 여기서 거르는 것은 전부 **요청 값 자체만 보고 판정 가능한 것**이다:
  null/공백, 길이, 숫자 범위, 날짜 형식, 정규식 패턴. DB를 볼 필요도,
  다른 객체를 볼 필요도 없다.
- 중첩 객체는 필드에 `@Valid`를 붙여야 안으로 파고든다 — 빼먹으면
  겉만 검증되고 속은 통과하는 흔한 함정이다.

```java
public record OrderRequest(
        @NotNull Long itemId,
        @Valid @NotNull ShippingInfo shipping  // @Valid 없으면 내부 미검증!
) {}
```

## 2. 역할 분담 기준 — "이 검증에 무엇이 필요한가"

계층마다 "어떤 검증을 놓느냐"를 감으로 정하면 팀마다 사람마다
달라진다. 판별 질문 하나로 기계적으로 나눌 수 있다:

> **이 검증을 하는 데 요청 값 이외의 정보(DB 상태, 다른 도메인 객체,
> 현재 시각 기준 규칙)가 필요한가?**

| 검증 | 필요한 정보 | 담당 계층 | 실패 시 |
|---|---|---|---|
| 이메일 형식, 비밀번호 길이 | 요청 값뿐 | 컨트롤러 DTO (`@Valid`) | 400 + 필드 에러 |
| 이메일 중복 여부 | DB 조회 | 애플리케이션/도메인 서비스 | 409 등 비즈니스 에러 |
| 주문 취소 가능 여부 (배송 전인가) | 주문의 현재 상태 | 도메인 객체 | 비즈니스 예외 |
| 잔액 ≥ 출금액 | 계좌 상태 | 도메인 객체 | 비즈니스 예외 |

- **컨트롤러(DTO) 계층**: "요청이 말이 되는 형태인가." 여기서 걸러지면
  비즈니스 로직은 시작도 안 한다. 잘못된 요청을 가장 싼 지점에서
  돌려보내는 것이 목적이다.
- **도메인 계층**: "이 상태 변화가 비즈니스 규칙상 허용되는가." 그리고
  더 근본적으로 — **불변식(invariant)**, 즉 "이 객체는 존재하는 한
  항상 유효한 상태여야 한다"를 스스로 지킨다.

### 도메인 불변식 — 검증을 "받는" 게 아니라 "스스로 지키는" 것

```java
// before — 도메인이 무방비: 검증을 전부 바깥(컨트롤러)에 의존
@Entity
public class Money {
    private long amount;
    public void setAmount(long amount) { this.amount = amount; }
    // 누가 -1000을 넣어도 막을 수 없다.
    // 컨트롤러를 거치지 않는 경로(배치, 내부 API, 테스트)에서는
    // "저쪽에서 검증하겠지"가 그대로 구멍이 된다.
}
```

```java
// after — 생성 시점에 불변식을 강제: 유효하지 않은 객체는 존재할 수 없다
public class Money {
    private final long amount;

    public Money(long amount) {
        if (amount < 0) {
            throw new IllegalArgumentException("금액은 음수일 수 없다: " + amount);
        }
        this.amount = amount;
    }
}
// 어떤 경로로 들어오든(웹, 배치, 메시지 컨슈머, 테스트)
// Money가 존재한다 = 금액이 유효하다. 검증 누락이 구조적으로 불가능.
```

컨트롤러의 `@Valid`는 **웹이라는 하나의 입구**만 지킨다. 도메인
불변식은 **모든 경로**를 지킨다 — 그래서 도메인 검증은 컨트롤러
검증이 있어도 생략하면 안 되는 **최후의 방어선**이다.

## 3. "중복" 문제 정리 — 목적이 다르면 중복이 아니고, 진짜 중복은 한곳에 봉인한다

### 3-1. 먼저 구분: 겉보기 중복 vs 진짜 중복

DTO에서 `@Size(min = 8)`를 검증했는데 도메인 생성자에서도 길이를
확인한다 — 이건 중복인가? **목적이 다르다.** DTO 검증은 "사용자에게
친절한 400 응답"이 목적이고(필드별 메시지, i18n), 도메인 검증은 "유효하지
않은 객체의 존재 자체를 차단"이 목적이다(개발자 실수 방어, 웹 외 경로
방어). 도메인 쪽은 사용자 응답용 메시지를 다듬을 필요 없이
`IllegalArgumentException`으로 단순하게 던지면 된다 — 정상 운영에서는
DTO 검증이 먼저 걸러주므로 도메인 예외는 "버그 감지기"로 동작한다.
이 이중 방어는 비용이 거의 없고 이득이 커서 **의도된 중복**으로
받아들이는 것이 일반적인 결론이다.

문제가 되는 진짜 중복은 두 가지다:

1. **같은 형식 규칙이 여러 DTO에 복붙**: 전화번호 정규식이 가입/수정/
   관리자 등록 DTO에 각각 박혀 있고, 정책이 바뀌면 하나를 빼먹는다.
2. **같은 비즈니스 검증이 서비스 여기저기에 복붙**: "취소 가능 상태
   인가"를 여러 서비스 메서드가 각자 if문으로 검사한다.

### 3-2. 형식 규칙의 중복 → 커스텀 제약 애너테이션으로 한곳에

```java
// before — 정규식이 DTO마다 복붙
public record SignUpRequest(
        @Pattern(regexp = "^01[0-9]-\\d{3,4}-\\d{4}$") String phone, ...) {}
public record UpdateProfileRequest(
        @Pattern(regexp = "^01[0-9]-\\d{3,4}-\\d{4}$") String phone, ...) {}
// 규칙이 바뀌면 grep으로 전부 찾아 고쳐야 하고, 하나 놓치면 그게 구멍
```

```java
// after — 제약을 애너테이션 하나로 정의해 재사용
@Documented
@Constraint(validatedBy = {})
@Target({ElementType.FIELD, ElementType.PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
@Pattern(regexp = "^01[0-9]-\\d{3,4}-\\d{4}$")
@ReportAsSingleViolation
public @interface PhoneNumber {
    String message() default "휴대전화 형식이 올바르지 않습니다";
    Class<?>[] groups() default {};
    Class<? extends Payload>[] payload() default {};
}

public record SignUpRequest(@PhoneNumber String phone, ...) {}
public record UpdateProfileRequest(@PhoneNumber String phone, ...) {}
// 규칙 변경이 한 파일 수정으로 끝난다
```

### 3-3. 비즈니스 검증의 중복 → 값 객체와 도메인 메서드로 봉인

형식+의미가 있는 값은 원시 타입(String)으로 돌리지 말고 **값 객체
(Value Object)**로 만들어 검증을 타입에 봉인한다.

```java
// before — String email이 계층을 떠돌고, 각자 알아서 검증
public void changeEmail(Long memberId, String email) {
    if (email == null || !email.contains("@")) { ... }  // 여기서도
    ...
}
```

```java
// after — Email 타입이 존재한다 = 유효하다
public record Email(String value) {
    public Email {
        if (value == null || !EMAIL_PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException("이메일 형식 오류: " + value);
        }
    }
}
public void changeEmail(Long memberId, Email email) { ... }
// 시그니처가 Email을 받는 순간, 이 메서드 안에서 형식 검증은
// "할 필요가 없는" 게 아니라 "할 수 없는"(이미 보장된) 것이 된다
```

상태 전이 규칙도 마찬가지 — 여러 서비스가 각자 if문으로 검사하지
말고 도메인 메서드 안으로 옮긴다:

```java
// after — 검증과 상태 변경을 한 메서드에
public class Order {
    public void cancel() {
        if (status != OrderStatus.BEFORE_SHIPPING) {
            throw new OrderCancelNotAllowedException(id, status);
        }
        this.status = OrderStatus.CANCELED;
    }
}
// 취소하려면 cancel()을 부를 수밖에 없고, cancel()은 검증을 건너뛸 수
// 없다 — "검증을 잊을 수 없는 구조"가 중복 제거의 종착점이다
```

정리하면: **중복 정리는 "검증을 지우는" 방향이 아니라 "검증을 한곳에
모으고 나머지는 그 타입/메서드를 믿게 만드는" 방향**이다. 검증을
지워서 정리하면 언젠가 그 빈틈으로 잘못된 데이터가 들어온다.

### 3-4. 에러 응답의 표준화 — 계층별 실패를 한 형식으로

역할 분담의 마무리는 예외 매핑이다. `@ControllerAdvice`에서:

- `MethodArgumentNotValidException`(DTO 검증 실패) → 400 + 필드별 에러 목록
- 도메인/비즈니스 예외(잔액 부족, 취소 불가 등) → 상황에 맞는 상태
  코드(409, 422, 400 등) + 에러 코드 체계
- 도메인 불변식 위반(`IllegalArgumentException` 등 "정상 흐름에서는
  나올 수 없는" 예외) → 500으로 취급하고 알림 — 이건 사용자 잘못이
  아니라 **앞 계층 검증이 뚫렸다는 버그 신호**이기 때문이다.

이 구분(400은 사용자 입력 문제, 500은 우리 버그)까지 말하면 검증
계층 설계가 관측/운영과 연결된다. (가산점 포인트)

## 4. 실무 함정 모음

- **중첩 객체 `@Valid` 누락**: 리스트/내부 객체 필드에 `@Valid`를 안
  붙이면 그 안은 검증되지 않는다. `List<@Valid OrderLine>` 같은 컨테이너
  요소 검증도 지원되므로 컬렉션 내부까지 챙긴다.
- **`@Valid` vs `@Validated`**: `@Valid`는 표준(JSR) 애너테이션으로
  중첩 전파에 쓰고, `@Validated`는 스프링 것으로 **검증 그룹 지정**과
  **컨트롤러 밖(서비스 등) 메서드 파라미터 검증**(클래스에 붙여 AOP
  프록시로 동작)에 쓴다. 후자는 프록시 기반이라 자기 호출에는 적용되지
  않는다 — `@Transactional` 자기 호출 함정과 같은 원리다.
- **`@RequestParam`/`@PathVariable` 검증**: DTO가 아닌 단일 파라미터에
  제약을 붙이려면 컨트롤러 클래스에 `@Validated`가 필요하고, 실패 시
  예외 타입이 DTO 검증과 달라서(`ConstraintViolationException` 계열)
  `@ControllerAdvice` 매핑을 따로 챙겨야 응답 형식이 통일된다.
- **AI 생성 코드의 검증 배치**: AI가 만든 코드는 검증을 서비스 메서드
  첫머리 if문 뭉치로 몰아넣거나, 반대로 DTO 애너테이션만 붙이고 도메인을
  무방비로 두는 패턴이 흔하다. 리뷰 체크리스트: ① 형식 검증이 DTO에
  있는가 ② 도메인 객체가 불변식을 스스로 지키는가 ③ DB가 필요한 검증이
  Validator 안에 숨어 있지 않은가.

---

## 5. 꼬리질문 대비 포인트

### "이메일 중복 검사처럼 DB 조회가 필요한 검증은 어느 계층에서 하나? 커스텀 Validator에서 Repository를 주입받아 하면 안 되나?"

애플리케이션/도메인 계층이 정답이다. 기술적으로는
`ConstraintValidator`가 스프링 빈이라 Repository 주입이 가능하지만
권하지 않는다 — ① 검증 시점이 바인딩 직후라 트랜잭션 경계 밖이거나
본 로직과 다른 트랜잭션에서 조회하게 되고, ② "중복 없음" 판정 직후
다른 요청이 끼어들면 어차피 깨지는 **시점 문제(TOCTOU)**가 있어 DB
유니크 제약이라는 최종 방어가 반드시 필요하며, ③ 형식 검증기에 DB
의존이 생기면 DTO 단위 테스트가 무거워진다. 정석은 "사전 중복 검사는
서비스에서 UX용으로, 최종 보장은 유니크 제약 + 제약 위반 예외
(`DataIntegrityViolationException`) 처리로"의 이중 구조다.

### "DTO에서 검증했는데 도메인에서 또 검증하는 건 낭비 아닌가?" (시니어 변별 포인트)

목적이 달라서 낭비가 아니다. DTO 검증은 웹 입구에서 사용자에게 친절한
400을 주기 위한 것이고, 도메인 검증(불변식)은 웹을 거치지 않는 모든
경로 — 배치, 메시지 컨슈머, 다른 서비스 메서드, 테스트 — 에서
유효하지 않은 객체가 만들어지는 것 자체를 막기 위한 것이다. 도메인
방어를 지우고 DTO만 믿으면 "컨트롤러를 거칠 때만 안전한" 시스템이
된다. 다만 비용을 줄이는 방향은 있다: 도메인 쪽은 메시지 국제화 같은
응답 품질을 신경 쓰지 않고 예외만 던지면 되고, 값 객체를 쓰면 검증
코드 자체는 한곳에만 존재한다. "중복처럼 보이는 이중 방어는 유지하되,
검증 로직의 소스는 하나로"가 균형 잡힌 답이다.

### "@Valid와 @Validated의 차이는?"

`@Valid`는 Bean Validation 표준 애너테이션으로, 컨트롤러 파라미터
검증 트리거와 중첩 객체로의 검증 전파에 쓴다. `@Validated`는 스프링
전용으로 두 가지가 추가된다 — ① 검증 그룹(groups) 지정 가능(같은
DTO를 등록/수정에서 다른 규칙으로 검증), ② 클래스에 붙이면 컨트롤러
밖 스프링 빈(서비스 등)의 메서드 파라미터/반환값 검증이 AOP 프록시로
동작. 단 프록시 기반이므로 자기 호출에는 적용되지 않고, 실패 예외도
`MethodArgumentNotValidException`이 아니라
`ConstraintViolationException`이라 전역 예외 처리에서 둘 다 매핑해야
응답이 통일된다.

### "검증 실패 응답은 어떻게 표준화하나?"

`@ControllerAdvice` + `@ExceptionHandler`로 세 종류를 한 형식(에러
코드, 메시지, 필드별 상세 목록)으로 수렴시킨다. ①
`MethodArgumentNotValidException` → 400, `BindingResult`의
`FieldError`들을 "필드명 + 사유" 목록으로 변환. ②
`ConstraintViolationException`(`@Validated` 파라미터 검증) → 같은 400
형식으로 변환. ③ 비즈니스 예외 → 도메인별 에러 코드와 4xx 매핑.
포인트는 클라이언트 입장에서 "어느 계층에서 실패했는지"가 아니라
"무엇을 고쳐 보내야 하는지"가 보이는 일관된 스키마를 유지하는 것,
그리고 도메인 불변식 위반은 400이 아니라 500 + 알림으로 분리해 "앞단
검증이 뚫린 버그"로 취급하는 것이다.

### "값 객체로 검증을 옮기면 구체적으로 뭐가 좋아지나?"

① 검증 로직이 타입 하나에 봉인되어 중복이 사라진다 — 규칙 변경이 한
파일 수정으로 끝난다. ② 시그니처가 문서가 된다 — `String email`은
"검증됐는지 알 수 없는 문자열"이지만 `Email`은 존재 자체가 유효성
증명이라, 받는 쪽에서 재검증할 필요가 없어진다(원시 타입 집착
primitive obsession 해소). ③ 같은 타입의 값이 여러 개일 때 순서 실수
(`transfer(from, to)`에 계좌번호 문자열 두 개를 바꿔 넣는 류)를
컴파일러가 잡는다. 비용은 클래스 수 증가와 ORM 매핑(JPA
`@Embeddable`/`AttributeConverter`) 손질 정도인데, 핵심 도메인 값부터
선별 적용하면 이득이 비용을 크게 앞선다.

---

## 한 줄 요약

요청 값만 보고 판정 가능한 형식 검증은 컨트롤러의 `@Valid`가 400으로
걸러내고, DB 상태나 도메인 규칙이 필요한 검증과 "객체는 항상 유효해야
한다"는 불변식은 도메인이 스스로 지키게 하되 — 목적이 다른 이중
방어는 중복이 아니라 설계이고, 진짜 중복(복붙된 규칙)은 커스텀 제약
애너테이션과 값 객체로 한곳에 봉인해 "검증을 잊을 수 없는 구조"로
만드는 것이 정리의 방향이다.
