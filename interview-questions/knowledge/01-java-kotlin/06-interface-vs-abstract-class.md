# 인터페이스 vs 추상 클래스 — 확장 지점을 어디에, 어떻게 설계하는가

> 핵심 관전 포인트: **인터페이스는 "무엇을 할 수 있는가"라는 계약(capability),
> 추상 클래스는 "공통 구현과 상태를 물려주는" 부분 완성품이다.
> Java 8 default 메서드 이후 기능 차이는 줄었지만 결정적 차이는 남는다 —
> 추상 클래스만 인스턴스 필드(상태)와 생성자를 가질 수 있고,
> 인터페이스만 다중 구현이 된다. 실무 기본값은 인터페이스로 계약을 정의하고,
> 구현체들 사이에 중복 코드·공유 상태가 생기면 그때 추상 클래스(골격 구현)를
> 계약 아래에 끼워 넣는 것이다.**

---

## 0. 질문 + 의도

**질문**: "인터페이스와 추상 클래스의 차이, 각각 언제 사용하나요?"

**출제 의도**: 실제로는 "확장 지점을 어떻게 설계하는가"의 질문.
외부 연동(PG사가 3곳)처럼 구현이 여럿인 지점에서 추상화 경계를 어디에
둘지 결정해본 사람인지를 본다. 문법 차이 암기가 아니라, 새 구현체가
추가될 때 기존 코드를 안 건드리는 구조를 만들 수 있는지가 관건이다.

## 1. 문법 차이 — 결정적인 것만 추리면

| 구분 | 인터페이스 | 추상 클래스 |
|---|---|---|
| 인스턴스 필드(상태) | ❌ (`static final` 상수만) | ✅ |
| 생성자 | ❌ | ✅ (초기화 로직 강제 가능) |
| 다중 상속/구현 | ✅ 여러 개 구현 가능 | ❌ 단일 상속 |
| 구현 메서드 | `default`/`static` (Java 8+) | 일반 메서드 자유롭게 |
| 접근 제어 | 사실상 public 중심 | `protected` 등 세밀한 제어 |

표보다 중요한 건 **왜 이렇게 갈리는가**다.

- 인터페이스가 상태를 못 갖는 건 다중 구현 때문이다. 두 부모가 같은
  이름의 필드를 갖고 있으면 어느 쪽 상태를 물려받을지 결정할 수 없다
  (다이아몬드 문제). Java가 클래스 다중 상속을 금지한 이유가 바로 이것이고,
  인터페이스는 **상태가 없으니** 여러 개를 구현해도 안전하다.
- Java 8의 `default` 메서드는 "구현"이 아니라 **동작만** 실어 나른다.
  상태가 없으므로 충돌해도 컴파일러가 "어느 쪽인지 명시하라"고 강제하는
  것으로 해결된다.

```java
// default 메서드 충돌 — 컴파일러가 재정의를 강제한다
interface A { default String name() { return "A"; } }
interface B { default String name() { return "B"; } }

class C implements A, B {
    @Override
    public String name() { return A.super.name(); }  // 명시적으로 선택
}
```

### 관계의 의미도 다르다

- 인터페이스: **can-do** — "이 타입은 이걸 할 수 있다"
  (`Comparable`, `Closeable`, `PaymentGateway`)
- 추상 클래스: **is-a** — "이 타입은 저 계열의 일종이다"
  (`AbstractList`를 상속하면 List 계열의 골격을 물려받는 것)

## 2. 언제 무엇을 쓰나 — 확장 지점 설계 관점

### 2-1. 기본값은 인터페이스 (계약 먼저)

구현이 여럿이거나 여럿이 될 지점 — 외부 연동, 알림 채널, 저장소 —
에서는 인터페이스로 계약을 끊는다.

```java
// Before: 분기 산탄 — PG사가 늘 때마다 이 메서드(그리고 취소, 조회...)를 수정
public PayResult pay(Order order, String pgType) {
    if ("TOSS".equals(pgType)) {
        // 토스 API 호출...
    } else if ("KAKAO".equals(pgType)) {
        // 카카오 API 호출...
    } else if ("NICE".equals(pgType)) {
        // 나이스 API 호출...
    }
    ...
}
```

```java
// After: 계약(인터페이스) + 구현체 — 새 PG사 추가 = 클래스 하나 추가로 끝
public interface PaymentGateway {
    PayResult pay(PayRequest request);
    CancelResult cancel(String transactionId);
    boolean supports(PgType type);   // 어떤 PG 요청을 감당하는지 스스로 선언
}

@Component class TossGateway implements PaymentGateway { ... }
@Component class KakaoGateway implements PaymentGateway { ... }

// 호출부는 구현을 모른다 — Spring이 List로 전부 주입
@Service
public class PaymentService {
    private final List<PaymentGateway> gateways;

    public PayResult pay(Order order, PgType type) {
        return gateways.stream()
                .filter(g -> g.supports(type))
                .findFirst()
                .orElseThrow(() -> new UnsupportedPgException(type))
                .pay(PayRequest.from(order));
    }
}
```

효과: 새 PG사 추가 시 **기존 코드 수정 없이 클래스 추가만** 하면 된다
(OCP). 테스트에서도 인터페이스만 있으면 가짜 구현(fake)을 꽂기 쉽다.

### 2-2. 추상 클래스는 "구현체들 사이의 중복"이 보일 때

위 구조를 운영하다 보면 구현체마다 같은 코드가 반복된다 —
타임아웃 처리, 공통 로깅, 응답 검증. 이때 계약(인터페이스)은 그대로 두고
**계약과 구현체 사이에** 추상 클래스를 끼운다.

```java
// 골격 구현(skeletal implementation): 공통 흐름은 부모가, 다른 부분만 자식이
public abstract class AbstractPaymentGateway implements PaymentGateway {

    private final PgApiLogger logger;          // 공유 상태 — 인터페이스는 못 갖는다

    protected AbstractPaymentGateway(PgApiLogger logger) {  // 생성자로 초기화 강제
        this.logger = logger;
    }

    @Override
    public final PayResult pay(PayRequest request) {   // 흐름 고정 (템플릿 메서드)
        logger.request(request);
        PgResponse response = callPgApi(request);      // PG사마다 다른 부분만 위임
        validate(response);                            // 공통 검증
        logger.response(response);
        return toResult(response);
    }

    protected abstract PgResponse callPgApi(PayRequest request);  // 자식이 채울 구멍
}

class TossGateway extends AbstractPaymentGateway {
    @Override
    protected PgResponse callPgApi(PayRequest request) { /* 토스 API만 */ }
}
```

이게 JDK가 쓰는 패턴 그대로다: `List`(인터페이스) ←
`AbstractList`(골격 구현) ← `ArrayList`(구체 클래스).
**계약은 인터페이스로, 코드 재사용은 추상 클래스로 — 둘은 경쟁 관계가
아니라 층이 다르다.** (가산점 포인트)

### 2-3. 선택 기준 요약

- 구현이 여럿 / 여럿이 될 확장 지점 → **인터페이스** (기본값)
- 서로 관련 깊은 구현체들이 상태·흐름을 공유 → 인터페이스 아래
  **추상 클래스(골격 구현)** 추가
- 추상 클래스 "단독" 사용은 계약을 외부에 노출할 필요가 없고
  상속 계층 내부 전용일 때 정도로 제한 — 단일 상속 슬롯을 소비하므로
  비용이 크다

## 3. 실무 함정 — 인터페이스에 메서드 추가하기

운영 중인 인터페이스에 추상 메서드를 추가하면 **모든 구현체가 컴파일
에러**가 난다. 구현체가 다른 팀/다른 저장소에 있으면 그대로 하위 호환
파괴다. Java 8이 `default` 메서드를 만든 실제 이유가 이것이다 —
Stream 도입 때 `Collection`에 `stream()`을 추가해야 했는데, 세상의 모든
Collection 구현체를 깨뜨릴 수 없었다.

```java
public interface PaymentGateway {
    PayResult pay(PayRequest request);

    // 새 기능: 기본 동작을 제공하면 기존 구현체는 재컴파일 없이 그대로 동작
    default boolean supportsPartialCancel() {
        return false;   // 보수적 기본값 — 지원하는 구현체만 재정의
    }
}
```

단, default 메서드는 구현체 입장에서 "몰래 생긴 동작"이므로 기본값은
보수적으로(기능 끔, 예외 아님) 잡는 게 안전하다.

## 4. 꼬리질문 대비 포인트

### "Java 8부터 인터페이스도 default 메서드로 구현을 가질 수 있는데, 이제 추상 클래스는 필요 없는 것 아닌가요?"

아니다. 남는 차이가 셋 있다. ① **인스턴스 필드** — default 메서드는
상태를 가질 수 없어서, 공유 상태(캐시, 로거, 설정값)가 필요한 공통
로직은 추상 클래스만 가능하다. ② **생성자** — 자식에게 초기화를 강제하고
불변 필드를 세팅할 수 있다. ③ **접근 제어와 final** — `protected` 헬퍼,
`final` 메서드로 템플릿 흐름을 고정하는 건 추상 클래스의 영역이다.
default 메서드의 진짜 용도는 "구현 재사용"이 아니라 **기존 구현체를
깨지 않고 인터페이스를 진화시키는 것**이다.

### "왜 클래스 다중 상속은 안 되는데 인터페이스는 여러 개 구현할 수 있나요?"

다이아몬드 문제의 핵심은 **상태(필드) 충돌**이다. 두 부모 클래스가 각자
필드를 갖고 있으면 자식 인스턴스에 그 필드가 몇 벌 있어야 하는지, 어느
초기화(생성자)를 따라야 하는지 답이 없다. 인터페이스는 상태가 없으니
충돌할 것이 "메서드 동작"뿐이고, 그건 컴파일러가 재정의를 강제하는
것으로 기계적으로 해결된다 (§1의 `A.super.name()` 예시).

### "구현체가 하나뿐인데도 인터페이스를 미리 만들어야 하나요?" (시니어 변별 포인트)

기계적으로 만들면 안 된다 — 트레이드오프 판단이 필요하다.
**인터페이스가 값을 하는 조건**은 (a) 구현이 늘어날 근거가 실제로 있거나
(PG사 추가 예정, 저장소 교체 가능성), (b) 아키텍처 경계에서 의존 방향을
뒤집어야 하거나(도메인이 인프라 구현을 모르게 — DIP), (c) 테스트에서
느린/외부 의존을 가짜로 바꿔야 할 때다. 이 셋에 해당 없이 서비스마다
1:1 인터페이스를 찍어내는 건 파일 수와 탐색 비용만 늘리는 관례적
낭비다. "지금은 클래스로 두고, 두 번째 구현이 생기는 순간 인터페이스를
추출한다(IDE 리팩토링으로 안전하게 가능)"도 유효한 전략이라고 말할 수
있으면 설계 감각을 보여준다.

### "템플릿 메서드 패턴과 전략 패턴의 차이는 무엇인가요?"

둘 다 "다른 부분만 갈아 끼우기"인데 메커니즘이 다르다. 템플릿 메서드는
**상속** — 추상 클래스가 흐름을 고정하고(final) 구멍(abstract 메서드)만
자식이 채운다. 전략은 **합성** — 인터페이스 구현체를 필드/파라미터로
주입받아 갈아 끼운다. 전략이 더 유연하다(런타임 교체 가능, 단일 상속
슬롯 안 씀, 테스트 쉬움). 실무에서는 §2-2처럼 둘을 겹쳐 쓰는 경우가
많다 — 바깥 계약은 전략(인터페이스 주입), 구현체 내부 중복 제거는
템플릿 메서드.

### "인터페이스에 default 메서드를 추가하면 이미 배포된 구현체에는 무슨 일이 생기나요?" (가산점 포인트)

재컴파일 없이도 링크가 유지된다 — 구현체가 재정의하지 않았으면 호출 시
인터페이스의 default 구현이 실행된다. 추상 메서드 추가는 반대로 바이너리
호환은 되지만(링크는 됨) 해당 메서드를 호출하는 순간
`AbstractMethodError`가 터질 수 있고, 소스 호환은 즉시 깨진다.
그래서 라이브러리/공통 모듈의 인터페이스 진화는 default 메서드 +
보수적 기본값이 정석이다.

---

## 한 줄 요약

인터페이스는 다중 구현이 가능한 상태 없는 계약, 추상 클래스는 상태와
생성자를 가진 부분 구현이다 — 확장 지점은 인터페이스로 끊고, 구현체들의
중복은 그 아래 골격 구현(추상 클래스)으로 걷어내는 것이 실무의 기본형이다.
