# final 키워드의 세 가지 얼굴 — 변경 가능 지점을 의도적으로 줄이는 어휘

> 핵심 관전 포인트: **final은 붙는 위치마다 금지 대상이 다르다 —
> 클래스에 붙으면 상속 금지, 메서드에 붙으면 재정의(override) 금지,
> 변수에 붙으면 재할당 금지. 셋의 공통 정신은 "여기는 바뀌지 않는다"를
> 컴파일러에게 선언해 변경 가능 지점을 줄이는 것이다.
> 단, 변수의 final은 참조의 고정이지 객체의 불변이 아니다 —
> `final List`의 내용물은 여전히 바뀔 수 있다.**

---

## 0. 질문 + 의도

**질문**: "`final` 키워드가 클래스/메서드/변수에 붙었을 때 각각 어떤
의미인가요?"

**출제 의도**: 사소해 보이지만, "변경 가능 지점을 의도적으로 줄이는
습관"이 있는지를 드러낸다. 코드 리뷰에서 동료의 가변 상태를 지적할 수
있는 최소 어휘. 문법 암기를 넘어 "final 참조 ≠ 불변 객체" 구분과
불변이 주는 실익(스레드 안전, 추론 용이)까지 말할 수 있는지를 본다.

## 1. 위치별 의미 — 무엇이 금지되는가

| 붙는 위치 | 금지되는 것 | 대표 예 |
|---|---|---|
| 클래스 | 상속 (`extends` 불가) | `String`, `Integer`, record |
| 메서드 | 자식의 재정의 (override) | 템플릿 메서드의 흐름 고정 |
| 변수 (필드/지역/파라미터) | 재할당 (딱 한 번만 대입) | 불변 필드, 상수 |

### 클래스의 final — "이 타입의 동작은 내가 보장한다"

상속을 막으면 **이 클래스의 불변식(invariant)을 자식이 깨뜨릴 수 없다**.
`String`이 final인 이유가 대표적이다 — 누군가 String을 상속해 내용을
바꿀 수 있는 가짜 String을 만들 수 있다면, String pool 캐싱도,
HashMap 키로서의 안전성도, 보안 검사(파일 경로 검증 후 사용)도 전부
무너진다. "String은 불변"이라는 보장은 클래스가 final이어야 완성된다.

### 메서드의 final — "흐름의 이 부분은 고정한다"

상속은 허용하되, 특정 메서드만 재정의를 막는다. 템플릿 메서드 패턴에서
전체 흐름을 고정하고 구멍만 열어줄 때 쓴다.

```java
public abstract class AbstractPaymentGateway {
    // 흐름(로깅 → 호출 → 검증)은 자식이 못 바꾼다
    public final PayResult pay(PayRequest request) {
        log(request);
        PgResponse response = callPgApi(request);  // 이 구멍만 자식 몫
        validate(response);
        return toResult(response);
    }
    protected abstract PgResponse callPgApi(PayRequest request);
}
```

### 변수의 final — "이 이름은 딱 한 번만 대입된다"

필드·지역변수·파라미터 어디든, 선언 후(또는 생성자에서) 정확히 한 번
대입되면 그 뒤로는 재할당이 컴파일 에러다.

```java
private final OrderRepository orderRepository;  // 생성자에서 1회 대입

public OrderService(OrderRepository orderRepository) {
    this.orderRepository = orderRepository;     // 이후 어디서도 교체 불가
}
```

## 2. 가장 중요한 구분 — final 참조 ≠ 불변 객체

final 변수가 고정하는 것은 **참조(어느 객체를 가리키는가)**이지,
그 객체의 **내용물**이 아니다.

```java
// final인데도 내용은 바뀐다 — 리뷰에서 가장 흔한 착각
private final List<OrderItem> items = new ArrayList<>();

items = new ArrayList<>();   // ❌ 컴파일 에러 (재할당 금지 — final이 막는 건 이것뿐)
items.add(newItem);          // ✅ 통과 — 객체 내부 상태 변경은 final과 무관
items.clear();               // ✅ 통과 — 전부 비워도 final은 침묵한다
```

진짜 불변을 원하면 final에 **불변 컬렉션/방어적 복사**를 더해야 한다.

```java
// Before: final만 믿고 내부 리스트를 그대로 노출
public final class Order {
    private final List<OrderItem> items;
    public Order(List<OrderItem> items) { this.items = items; }     // 외부 리스트 공유
    public List<OrderItem> getItems() { return items; }             // 내부 참조 노출
}
// 호출부: order.getItems().clear();  → 주문 내용물이 밖에서 증발

// After: 경계에서 복사, 밖으로는 불변 뷰
public final class Order {
    private final List<OrderItem> items;
    public Order(List<OrderItem> items) {
        this.items = List.copyOf(items);                  // 들어올 때 복사 + 불변화
    }
    public List<OrderItem> getItems() { return items; }   // List.copyOf 결과라 수정 시도 시 예외
}
```

즉 **불변 객체 = final 필드 + 필드가 가리키는 객체도 불변(또는 노출 안 함)
+ 클래스 final(자식이 가변성을 추가 못 하게)** — 셋이 세트다.
String이 정확히 이 조합이다.

### 실무에서 final 필드가 주는 실익

- **생성자 주입 + final** (Spring 관용구): 의존성 누락이 컴파일 에러로
  잡히고, 빈이 완성된 뒤 의존성이 교체될 가능성이 원천 차단된다.
  `@Autowired` 필드 주입은 final이 불가능하다는 점 자체가 필드 주입을
  피할 이유 중 하나다.
- **읽는 사람의 추론 비용 감소**: final 필드는 "생성 시점 값이 곧 평생
  값"이므로, 이 필드가 중간에 바뀌는지 추적하며 읽을 필요가 없다.
  코드 리뷰에서 "이 필드 final 가능한데 안 붙어 있네요 → 어딘가에서
  재할당한다는 뜻인가요?"가 가변 상태를 찾아내는 질문이 된다.
- **스레드 안전의 절반**: 상태가 안 바뀌는 객체는 동기화 없이 공유해도
  안전하다. 동시성 버그의 상당수는 "공유 + 가변"의 조합에서 나오는데,
  final은 그중 "가변"을 줄이는 도구다.

## 3. 실무 버그 — final 메서드와 Spring 프록시

Spring의 `@Transactional`, `@Cacheable`은 대부분 CGLIB 프록시로
동작한다 — **대상 클래스를 상속한 자식 클래스**를 런타임에 만들어
메서드를 재정의하고, 원본 호출 앞뒤에 트랜잭션 코드를 끼워 넣는 방식이다.
그런데 final은 정확히 그 재정의를 금지한다.

```java
@Service
public class SettlementService {

    @Transactional
    public final void settle(Long orderId) {   // 💥 final → 프록시가 재정의 불가
        ...                                    //    트랜잭션 없이 그냥 실행된다
    }
}
```

- **final 클래스**는 프록시 생성 자체가 실패해서 그나마 기동 시점에 드러난다
- **final 메서드**는 프록시가 그 메서드만 조용히 건너뛴다 — 예외도
  로그도 없이(버전에 따라 경고 로그 정도) **트랜잭션이 적용되지 않은 채**
  동작한다. 평소엔 멀쩡하다가 중간에 예외가 터진 날 롤백이 안 돼
  데이터가 반쪽만 커밋되는, 전형적인 "증상이 한참 뒤에 엉뚱한 곳에서
  나타나는" 버그다

교훈: final을 "붙일 수 있으면 무조건" 붙이는 게 아니라, **프록시 기반
프레임워크가 상속으로 개입하는 지점(Spring 빈의 public 메서드)에서는
final이 프레임워크 기능을 침묵 속에 꺼버릴 수 있음**을 알아야 한다.
같은 이유로 Kotlin(클래스가 기본 final)은 Spring 플러그인이 `@Service`
등이 붙은 클래스를 자동으로 open 처리한다.

## 4. 꼬리질문 대비 포인트

### "`final List` 필드면 그 리스트는 불변인가요?"

아니다. final은 참조 재할당만 막고, 리스트 내용물의 add/remove/clear는
전부 허용된다 (§2). 진짜 불변은 `List.copyOf`/`Collections.unmodifiableList`
같은 불변 컬렉션이나 방어적 복사를 더해야 하고, 외부에서 받은 컬렉션은
생성자에서 복사해 들어와야 원본을 쥔 외부 코드의 수정으로부터도 안전하다.

### "람다나 익명 클래스에서 지역변수는 왜 final(effectively final)이어야 하나요?"

지역변수는 스택에 살고 메서드가 끝나면 사라지는데, 람다는 그보다 오래
살아남아 나중에(다른 스레드에서도) 실행될 수 있다. 그래서 Java는
지역변수를 람다 안으로 **값 복사**해서 캡처한다. 복사본이므로 원본이
바뀌면 둘이 어긋난다 — 이 불일치를 언어 차원에서 금지하려고 "캡처되는
지역변수는 사실상 final이어야 한다"는 규칙을 둔 것이다. `effectively
final`은 final 키워드가 없어도 재할당이 한 번도 없는 변수를 컴파일러가
final로 취급해주는 것(Java 8+)이다.

### "final 필드가 멀티스레드 환경에서 주는 특별한 보장이 있나요?" (가산점 포인트)

있다. Java Memory Model은 final 필드에 한해 **생성자 완료 시점의 값이
(객체 참조가 올바르게 공개됐다면) 다른 스레드에게 온전히 보이는 것**을
보장한다(final field semantics). 일반 필드는 동기화 없이 공유하면 다른
스레드가 초기화 이전의 값(0/null)을 볼 수 있지만, final 필드는 그 재배치가
금지된다. "불변 객체는 동기화 없이 공유해도 안전하다"는 말의 JMM적
근거가 바로 이것이라, 불변 객체의 필드는 습관적으로 final로 선언하는
것이 좋다.

### "클래스에 final을 붙여 상속을 막는 설계는 언제 정당한가요?" (시니어 변별 포인트)

트레이드오프 판단이다. **막는 쪽의 근거**: 상속을 안전하게 허용하려면
자식이 재정의해도 깨지지 않도록 내부 자기 호출(self-use) 구조까지
설계·문서화해야 하는데, 그 비용을 치르지 않았다면 봉인이 정직하다
("상속을 위해 설계·문서화하지 않았으면 상속을 금지하라"). 불변 클래스는
자식이 가변성을 추가하는 순간 보장이 깨지므로 final이 필수다.
**여는 쪽의 근거**: §3의 프록시 문제처럼 프레임워크가 상속으로 개입하는
클래스는 final이면 안 되고, 상속이 유일한 확장 수단인 라이브러리 사용처도
있다. 정리하면 — 도메인 값 객체·불변 객체는 final 기본, 프레임워크가
프록시할 빈은 열어두고, 확장은 상속보다 인터페이스+합성으로 제공하는
것이 기본기다.

### "`static final` 상수는 그냥 final 필드와 무엇이 다른가요?" (가산점 포인트)

`static final`에 컴파일 타임 상수(문자열/기본형 리터럴)를 대입하면
컴파일러가 그 값을 **사용하는 쪽 바이트코드에 그대로 박아 넣는다**
(constant folding). 그래서 상수를 정의한 모듈만 새로 배포하고 사용하는
모듈을 재컴파일하지 않으면, 사용처는 **옛날 값**으로 계속 동작하는
황당한 불일치가 생길 수 있다. 여러 배포 단위가 공유하는 상수를 바꿀 때는
양쪽 재빌드가 필요하다는 것까지 알면 운영 감각을 보여준다.

---

## 한 줄 요약

final은 클래스에서 상속을, 메서드에서 재정의를, 변수에서 재할당을 막아
"바뀔 수 있는 지점"을 컴파일러 수준에서 줄이는 선언이다 — 단 변수의
final은 참조의 고정일 뿐 객체 불변이 아니며, 프록시 기반 프레임워크
앞에서는 final이 기능을 조용히 꺼버릴 수 있음까지 알아야 실무 어휘가 된다.
