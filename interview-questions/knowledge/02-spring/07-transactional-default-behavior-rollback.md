# @Transactional 기본 동작과 롤백 규칙 — "예외는 났는데 데이터는 반쯤 커밋된" 사고의 근원

> 핵심 관전 포인트: **`@Transactional`은 그 메서드를 특별하게 만드는 것이 아니라, 그 빈을 감싼 프록시가 호출을 먼저 받아 트랜잭션을 열고 닫는 구조다. 그래서 커밋과 롤백은 메서드 안이 아니라 프록시 경계에서 결정된다 — 정상 리턴하면 커밋, 예외가 프록시 밖까지 나오면 그때 롤백 여부를 판단한다. 기본 롤백 대상은 unchecked 예외(`RuntimeException`과 `Error`)뿐이고, checked 예외는 예외가 났는데도 커밋된다. 이것은 버그가 아니라 "checked 예외는 호출자가 복구를 예상하고 처리하는 예상된 결과이니 데이터를 살려둔다"는 EJB 시절부터의 설계 판단인데, 그 판단을 모르고 쓰면 "돈은 빠져나갔는데 입금은 안 된" 정합성 사고가 난다. 바꾸려면 `rollbackFor`를 붙이거나, 비즈니스 예외를 `RuntimeException` 기반으로 통일하거나, 스프링 6.2부터 제공되는 `@EnableTransactionManagement(rollbackOn = ALL_EXCEPTIONS)`로 전역 기본값 자체를 뒤집는다. 그리고 프록시 기반이라는 사실에서 두 가지 함정이 더 따라 나온다 — 자기 호출에는 아예 적용되지 않고, 안쪽 트랜잭션이 찍은 rollback-only 낙인은 바깥에서 `try-catch`로 예외를 삼켜도 지워지지 않아 커밋 시점에 `UnexpectedRollbackException`으로 터진다. 예외는 잡을 수 있어도 낙인은 잡을 수 없다.**

---

## 0. 질문 + 의도

**질문**: "`@Transactional`의 기본 동작을 설명해주세요. 어떤 예외에서 롤백되나요?"

**출제 의도**: checked exception에서 롤백 안 되는 기본값을 모르면 "예외는 났는데 데이터는 반쯤 커밋된" 정합성 사고를 낸다. 결제 도메인에서는 이 한 줄이 돈 사고다 — 프레임워크 기본값을 확인하고 쓰는 습관과 정합성 감각을 검증하는 질문이다.

이 문서는 **스프링 프록시 3부작의 트랜잭션 편**이다. 프록시가 어떻게 만들어지고 `final`·인터페이스 유무가 왜 함정이 되는지는 [10번 문서](10-aop-jdk-dynamic-proxy-vs-cglib.md)가, 자기 호출 함정의 진단과 해법은 [11번 문서](11-transactional-self-invocation.md)가 본론이다. 여기서는 그 프록시 위에서 **트랜잭션이 언제 열리고 무슨 기준으로 커밋·롤백되는가**만 파고든다. 버전에 의존하는 서술은 **스프링 프레임워크 6.x / 스프링 부트 3.x 기준**으로 쓴다.

## 1. 기본 동작 — 커밋·롤백은 프록시 경계에서 결정된다

### 1-1. 전제 지식 — `@Transactional`은 그 메서드를 바꾸지 않는다

가장 먼저 걷어내야 할 오해가 있다. `@Transactional`을 붙인다고 **그 메서드의 바이트코드에 트랜잭션 코드가 들어가는 것이 아니다.** 컴파일된 클래스 파일을 열어봐도 메서드 본문은 애너테이션을 붙이기 전과 똑같다.

실제로 일어나는 일은 이렇다. 스프링은 그 빈을 **프록시**로 감싸 컨테이너에 등록한다. 프록시는 원본 객체인 척하면서 호출을 먼저 받아 부가 작업을 한 뒤 원본에 넘기는 대리인 객체다. 다른 빈이 주입받는 것은 원본이 아니라 이 프록시이므로, 밖에서 들어오는 모든 호출은 프록시를 먼저 지나간다.

```text
[컨트롤러] ──호출──▶ [OrderService 프록시] ──위임──▶ [OrderService 원본]
                       트랜잭션 시작/커밋/롤백         순수 비즈니스 로직만
                       ↑ 여기에만 있다                 ↑ 트랜잭션 코드가 없다
```

프록시가 어떤 방식(JDK 동적 프록시 / CGLIB)으로 만들어지는지, 무엇이 그 생성을 방해하는지는 10번 문서의 주제다. 이 문서에서는 **"부가 기능은 프록시에만 있다"**는 사실 하나만 전제로 쓴다.

### 1-2. 프록시가 하는 일을 의사코드로 펼치면

```java
// 프록시 객체 안에서 개념적으로 벌어지는 일
public Order order(OrderRequest request) {
    // ① 여기서 트랜잭션이 열린다 — 커넥션을 잡고 autoCommit을 끈다.
    //    이 줄부터 ③ 또는 ④까지가 하나의 물리 트랜잭션 구간이다.
    TransactionStatus tx = txManager.getTransaction(definition);
    try {
        Order result = target.order(request);   // ② 원본 객체의 메서드를 실행한다
        txManager.commit(tx);                   // ③ 예외 없이 리턴했다 = 커밋
        return result;
    } catch (Throwable ex) {
        // ④ 예외가 여기까지 올라왔을 때 비로소 "롤백할 예외인가"를 판단한다.
        //    판단 기준이 2절의 롤백 규칙이다.
        if (rollbackOn(ex)) {
            txManager.rollback(tx);
        } else {
            txManager.commit(tx);   // 규칙에 안 걸리면 예외가 났어도 커밋한다
        }
        throw ex;                   // 예외 자체는 호출자에게 그대로 전달된다
    }
}
```

### 1-3. 이 구조에서 곧바로 따라 나오는 두 가지 함의

**① 판단 기준은 "예외가 프록시 경계 밖까지 나왔는가"다.** 메서드 안에서 `try-catch`로 잡아버리면 프록시는 예외를 본 적이 없으므로 ③번 경로로 가서 그냥 커밋한다. "예외가 났으니 롤백됐겠지"는 틀렸다 — **프록시가 못 본 예외는 없었던 예외다.**

**② 예외가 났다고 무조건 롤백이 아니다.** ④번 분기에서 보듯 어떤 예외인지에 따라 커밋될 수도 있다. 이 분기의 기본 규칙이 2절의 내용이고, 이 문서가 겨냥하는 사고의 진원지다.

### 1-4. 프록시 경계의 제약 ① — 자기 호출에는 적용되지 않는다

트랜잭션 코드가 프록시에만 있다는 사실에서, 같은 클래스 안에서 `this.method()`로 부르면 트랜잭션이 걸리지 않는다는 결론이 기계적으로 따라 나온다. `this`는 프록시가 아니라 원본이기 때문이다.

```java
@Service
public class OrderService {

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.processOne(request);   // 문제: this = 원본 객체, 프록시를 우회한다
        }
    }

    @Transactional
    public void processOne(OrderRequest request) { /* 트랜잭션 없이 실행된다 */ }
}
```

무서운 것은 **아무 신호도 없다는 점**이다. 컴파일도 되고 기동도 되고 실행도 되는데 트랜잭션만 없다. 이 함정의 발견 절차와 네 가지 해법, 각 해법이 치르는 대가는 [11번 문서](11-transactional-self-invocation.md)의 본론이다.

### 1-5. 프록시 경계의 제약 ② — 메서드 가시성 (버전에 따라 다르다)

"`@Transactional`은 public 메서드에서만 동작한다"는 설명이 널리 퍼져 있는데, **스프링 프레임워크 6.0부터는 정확하지 않다.** 이 부분은 프록시 방식과 버전을 나눠서 알아야 한다.

| 메서드 가시성 | 클래스 기반 프록시(CGLIB) | 인터페이스 기반 프록시(JDK) |
|---|---|---|
| `public` | 적용된다 | 적용된다 (인터페이스에 선언돼 있어야 함) |
| `protected` | **6.0부터 적용된다** | 적용 불가 (인터페이스에 선언 자체가 불가) |
| 패키지 프라이빗 | **6.0부터 적용된다** | 적용 불가 |
| `private` | 적용 불가 | 적용 불가 |

공식 문서의 서술은 이렇다 — "`@Transactional`은 보통 public 메서드에 쓴다. 6.0부터는 클래스 기반 프록시에 한해 `protected`와 패키지 프라이빗 메서드도 기본적으로 트랜잭션 대상이 된다. 인터페이스 기반 프록시의 트랜잭션 메서드는 언제나 public이면서 프록시 대상 인터페이스에 선언돼 있어야 한다."

**`private`이 어느 쪽으로도 안 되는 이유**는 10번 문서의 원리로 설명된다. CGLIB은 상속한 자식 클래스로 오버라이드해 가로채는데 `private` 메서드는 애초에 오버라이드 대상이 아니고, JDK 방식은 인터페이스를 통해 가로채는데 인터페이스에는 `private` 메서드를 선언할 수 없다. **가로챌 통로가 물리적으로 없다.**

5.3까지의 동작(가시성에 상관없이 public이 아니면 전부 무시)으로 되돌리고 싶다면 스프링이 안내하는 방법이 있다.

```java
// 프록시 방식에 상관없이 public이 아닌 메서드를 일관되게 무시하고 싶을 때
@Bean
TransactionAttributeSource transactionAttributeSource() {
    // 생성자 인자 true = publicMethodsOnly. 5.3까지의 기본 동작이다.
    return new AnnotationTransactionAttributeSource(true);
}
```

실무 권고는 그래도 **public에 붙이는 것을 기본으로 삼는 것**이다. 이유가 셋이다. 첫째, `protected`나 패키지 프라이빗 메서드를 **바깥에서 프록시를 통해 부를 수 있는 상황 자체가 드물다** — 대개 같은 클래스 안에서 부르게 되고, 그러면 1-4의 자기 호출 함정에 그대로 걸린다. 둘째, 프록시 방식이 JDK로 바뀌는 순간 동작이 달라진다. 셋째, 팀원 대부분은 여전히 "public만 된다"는 지식을 갖고 있어 코드가 오해를 부른다.

## 2. 롤백 규칙 — 왜 checked 예외는 커밋되는가

### 2-1. 전제 지식 — 자바 예외 계층부터 그린다

"unchecked 예외만 롤백된다"는 문장은 unchecked가 무엇인지 모르면 아무것도 알려주지 않는다. 계층부터 그리고 그 위에 롤백선을 얹자.

```text
                             Throwable
                                 │
             ┌───────────────────┴───────────────────┐
             │                                       │
           Error                                 Exception
   OutOfMemoryError                                  │
   StackOverflowError                ┌───────────────┴───────────────┐
   NoClassDefFoundError              │                               │
             │                 (checked 예외)               RuntimeException
             │                 IOException                  NullPointerException
             │                 SQLException                 IllegalArgumentException
             │                 InterruptedException         IllegalStateException
             │                 ParseException               직접 만든 XxxException
             │                       │                               │
 ════════════╪═══════════════════════╪═══════════════════════════════╪════════
      기본: 롤백 ✓             기본: 커밋 ✗ ★                   기본: 롤백 ✓
      └────────────────── unchecked ─────────────────┘
```

용어를 그 자리에서 정의하고 가자. **checked 예외는 컴파일러가 "처리하든지 `throws`로 선언하든지 둘 중 하나를 반드시 하라"고 강제하는 예외**다. 강제한다는 뜻에서 "검사받는(checked)" 예외다. **unchecked 예외는 그 강제가 없는 예외**이고, 자바에서는 `RuntimeException` 계열과 `Error` 계열이 여기 해당한다.

여기서 놓치기 쉬운 사실 하나 — **`Error`는 `Exception`의 형제이지 자식이 아니다.** `OutOfMemoryError`를 잡으려고 `catch (Exception e)`를 써봐야 잡히지 않는다. 그리고 `Error`도 기본 롤백 대상이다.

### 2-2. 기본 규칙

| 던져진 예외 | 기본 동작 |
|---|---|
| `RuntimeException`과 그 하위 | 롤백 |
| `Error`와 그 하위 | 롤백 |
| checked 예외 (`Exception` 하위 중 `RuntimeException`이 아닌 것) | **커밋** |

공식 문서의 표현은 한 줄이다 — "`RuntimeException`이나 `Error`는 롤백을 유발하고, checked `Exception`은 그렇지 않다."

표의 세 번째 줄이 이 질문의 전부다. **예외가 호출자에게까지 전파됐는데도 데이터는 커밋된다.** 예외 전파와 트랜잭션 롤백은 서로 다른 두 개의 흐름이고, 스프링은 그 둘을 일부러 분리해 두었다.

### 2-3. 왜 이렇게 설계됐나 — "기본값이 그렇다"로 끝내면 안 되는 이유

여기서 "스프링이 그렇게 정해놨습니다"로 답하면 절반짜리다. 이 규칙에는 **자바의 예외 설계 의도에서 곧장 따라 나오는 근거**가 있고, 그 근거를 알아야 규칙을 외우지 않고 이해하게 된다.

**자바가 예외를 두 종류로 나눈 기준부터 보자.** checked 예외는 "이 메서드는 이런 상황을 만날 수 있으니 호출자는 그에 대한 대응을 준비하라"고 **시그니처로 선언하는** 예외다. 컴파일러가 처리를 강제한다는 것은 곧 **"이 상황은 발생이 예상되며, 호출자가 복구할 수 있다고 설계자가 판단했다"**는 뜻이다. 파일이 없을 수 있다(`FileNotFoundException`), 네트워크가 끊길 수 있다(`IOException`) — 전부 "일어날 수 있다고 미리 알려주는" 상황이다.

반대로 unchecked 예외는 선언도 처리도 강제되지 않는다. 그 배경에는 **"이건 예상된 상황이 아니라 프로그램이 잘못된 것"**이라는 판단이 깔려 있다. `NullPointerException`, `IllegalStateException`은 호출자가 대비할 성질의 것이 아니라 고쳐야 할 결함이다. `Error`는 아예 애플리케이션이 손쓸 수 없는 시스템 장애다.

**이 구분을 트랜잭션에 그대로 옮기면 스프링의 규칙이 된다.**

| | 예외의 의미 | 트랜잭션의 해석 | 결정 |
|---|---|---|---|
| checked | "예상된 대안 결과. 호출자가 처리한다" | 정상 흐름의 한 갈래다 | 지금까지의 작업을 살린다 → 커밋 |
| unchecked | "예상 못 한 결함 또는 시스템 장애" | 무슨 상태인지 신뢰할 수 없다 | 통째로 되돌린다 → 롤백 |

즉 **"checked 예외 = 이것도 예상된 결과 중 하나이므로 여기까지 한 일은 유효하다"**는 것이 설계 의도다. 이 관례는 스프링이 만든 것이 아니라 EJB(Enterprise JavaBeans) 시절의 규약을 계승한 것이고, 스프링은 기존 코드와의 호환을 위해 그대로 물려받았다.

**그런데 이 전제가 현대 실무에서는 자주 어긋난다.** 요즘 자바 코드는 비즈니스 예외를 `RuntimeException` 기반으로 만드는 것이 다수파다(checked 예외가 시그니처를 오염시키고 람다와 잘 안 맞는다는 이유로). 그런 팀에서 누군가 `extends Exception`으로 예외를 하나 만드는 순간, 그 예외는 **의도와 무관하게 "예상된 결과"로 분류되어 커밋**된다. 사고는 여기서 난다.

정리하면 이렇다. **규칙 자체는 일관된 철학의 산물이지만, 그 철학의 전제(checked = 복구 가능한 예상 결과)가 오늘의 코딩 관행과 어긋나 있다.** 그래서 결론은 "기본값을 비판한다"가 아니라 **"기본값에 의존하지 말고 팀 차원에서 명시적으로 정한다"**가 된다.

### 2-4. 사고 나는 코드와 고친 코드

```java
// before: checked 예외라서 출금만 커밋된다
@Transactional
public void transfer(TransferRequest request) throws BalanceException {
    accountRepository.withdraw(request.from(), request.amount());   // ① 출금 — 이미 트랜잭션에 반영됨

    if (isOverDailyLimit(request)) {
        // BalanceException extends Exception (checked)
        // 프록시는 이 예외를 보고 "예상된 결과"로 판정해 커밋한다.
        throw new BalanceException("일 한도 초과");                  // ②
    }
    accountRepository.deposit(request.to(), request.amount());       // ③ 도달하지 못한다
}
// 결과: 예외는 컨트롤러까지 전파되는데 ①의 출금은 커밋된다.
// "돈은 빠져나갔는데 입금은 안 된" 상태 — 결제 도메인이면 그대로 돈 사고다.
```

```java
// after A: rollbackFor로 이 예외를 롤백 대상에 명시적으로 포함시킨다
@Transactional(rollbackFor = BalanceException.class)
public void transfer(TransferRequest request) throws BalanceException { /* ... */ }

// after B (실무에서 더 흔한 선택): 비즈니스 예외 계층을 RuntimeException 기반으로 통일한다
public class BalanceException extends RuntimeException { /* ... */ }
// 이렇게 두면 rollbackFor를 빠뜨릴 여지 자체가 없어진다.
// "롤백 여부를 예외의 상속 계층이라는 우연에 맡기지 않겠다"가 이 선택의 근거다.
```

실무에서는 B 쪽이 일반적이다. A는 **모든 `@Transactional`마다 빠짐없이 붙여야** 효과가 있는데, 사람이 하는 일이라 언젠가 한 곳이 빠지고 그 한 곳이 사고가 된다. B는 예외 계층을 한 번 정리하면 그 뒤로는 신경 쓸 일이 없다.

### 2-5. `rollbackFor = Exception.class`를 통째로 박는 것이 능사가 아닌 이유

팀 컨벤션으로 모든 `@Transactional`에 `rollbackFor = Exception.class`를 기본으로 박아두는 곳도 있다. 의도는 옳다 — 기본값의 함정을 없애겠다는 것이다. 다만 이 방법에는 짚어야 할 점이 셋 있다.

**① 규칙이 코드 전체에 흩어져 검증이 어렵다.** 애너테이션마다 반복해야 하고, 한 곳이라도 빠지면 **그 메서드만 조용히 기본값으로 되돌아간다.** 규칙을 흩뿌리는 방식은 누락을 구조적으로 막지 못한다.

**② 같은 목적이면 전역 스위치가 정답이다.** **스프링 프레임워크 6.2부터** 기본 롤백 동작 자체를 한 곳에서 뒤집을 수 있다.

```java
// 스프링 6.2+ — checked 예외까지 포함해 모든 예외를 롤백 대상으로 삼는다
@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)
```

개별 `@Transactional`의 `rollbackFor`/`noRollbackFor`는 이 전역 기본값을 덮어쓰되, 지정하지 않은 예외에 대해서는 선택한 기본값이 그대로 유지된다. 스프링 팀 자신도 **"EJB식 비즈니스 예외 커밋 동작에 의존하는 것이 아니라면 `ALL_EXCEPTIONS`로 바꾸는 편을 권한다"**고 문서에 적어두었다. 즉 애너테이션마다 `Exception.class`를 반복하는 컨벤션은 **6.2 이후로는 한 줄로 대체할 수 있는 구식 해법**이다.

**③ "모든 예외 = 롤백"이 정말 원하는 정책인지 확인해야 한다.** 트랜잭션 안에서 시도 이력이나 감사 로그를 남기고 예외를 던져 알리는 설계라면, 전면 롤백은 **그 기록까지 함께 지운다.** 이 경우 `noRollbackFor`를 다시 얹어야 하므로 규칙이 두 겹이 된다. 요구사항이 그런 자리는 애초에 별도 트랜잭션(`REQUIRES_NEW`)으로 분리하는 편이 낫다.

마지막으로 가장 중요한 오해 하나. **`rollbackFor`는 롤백 규칙만 바꿀 뿐, 이 문서의 나머지 두 함정을 하나도 해결하지 못한다.** 자기 호출은 여전히 트랜잭션 자체가 없고, 3절의 rollback-only 낙인은 롤백 규칙과 무관하게 찍힌다. "`rollbackFor = Exception.class`를 박아뒀으니 안전하다"는 잘못된 안심이다.

### 2-6. 규칙이 여럿 걸릴 때는 가장 가까운 것이 이긴다 (가산점 포인트)

`rollbackFor`와 `noRollbackFor`를 함께 쓰면 한 예외가 두 규칙에 동시에 걸릴 수 있다. 이때 판정 기준을 알아두면 좋다.

먼저 매칭 방식이다. 설정한 예외 타입이 `C`이고 실제로 던져진 예외가 `T`일 때, **`T`가 `C`와 같거나 `C`의 하위 타입이면 매치**로 본다. 그리고 여러 규칙이 매치되면 **상속 계층에서 가장 가까운 규칙이 이긴다.**

```java
// StockShortageException extends Exception 이라고 하자.
@Transactional(
    rollbackFor = Exception.class,                    // 매치되지만 거리가 멀다
    noRollbackFor = StockShortageException.class      // 정확히 일치 — 이쪽이 이긴다
)
public void order(OrderRequest request) throws Exception { /* ... */ }
// 결과: StockShortageException이 던져지면 커밋된다.
//       그 외의 checked 예외는 rollbackFor에 걸려 롤백된다.
```

이 규칙을 알면 "전역은 전면 롤백, 특정 비즈니스 예외만 예외 처리"라는 정책을 정확히 표현할 수 있다.

## 3. 실전 — rollback-only 낙인과 UnexpectedRollbackException

이 절이 이 문서에서 가장 시니어스러운 대목이다. **트랜잭션 전파와 롤백 규칙이 교차하는 지점**이라 이해도가 그대로 드러난다.

### 3-1. 상황 — "예외를 잡았으니 커밋되겠지"

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;
    private final StockService stockService;

    @Transactional
    public Order order(OrderRequest request) {
        Order order = orderRepository.save(createOrder(request));
        try {
            stockService.decrease(request.itemId(), request.quantity());
        } catch (RuntimeException e) {
            // 재고가 부족하면 예약 주문으로 전환한다 — 비즈니스적으로 완전히 합리적인 요구사항이다.
            order.markBackorder();
        }
        return order;   // 예외를 삼켰으니 정상 리턴 = 커밋을 기대한다
    }
}

@Service
public class StockService {

    @Transactional   // 전파 기본값 = REQUIRED
    public void decrease(Long itemId, int quantity) {
        // 재고가 모자라면 RuntimeException을 던진다
    }
}
```

전제를 하나 깔고 가자. **전파(propagation)**는 "이미 열려 있는 트랜잭션이 있을 때 이 메서드가 어떻게 행동할지"를 정하는 설정이고, 기본값 `REQUIRED`는 **"있으면 거기에 합류하고, 없으면 새로 연다"**는 뜻이다. 그러므로 위 코드에서 `order()`와 `decrease()`는 **같은 물리 트랜잭션 하나**를 공유한다. 커넥션도 하나, 커밋도 한 번뿐이다.

### 3-2. 무슨 일이 벌어지는지 한 단계씩

```text
시각  호출 스택에서 벌어지는 일                              공유 물리 트랜잭션의 상태
──────────────────────────────────────────────────────────────────────────────────
t0   컨트롤러 → [order() 프록시] 진입                        (아직 없음)
t1     프록시가 트랜잭션을 연다                              ACTIVE / rollbackOnly=false
t2     원본 order() 진입 → orderRepository.save()            ACTIVE (주문 INSERT 반영됨)
t3     order()가 stockService.decrease() 호출
t4       → [decrease() 프록시] 진입
t5         전파 REQUIRED: 열린 트랜잭션 발견 → 합류           ACTIVE (새로 열지 않는다)
t6         원본 decrease() 실행 중 RuntimeException 발생
t7       ← decrease() 프록시가 예외를 잡는다.
           자기는 트랜잭션을 연 주인이 아니라 합류한 입장이라
           직접 rollback()을 부를 수 없다. 대신 공유
           트랜잭션에 "커밋 금지" 낙인을 찍는다.          ★ rollbackOnly = TRUE
t8       프록시가 예외를 바깥으로 다시 던진다
t9   order()의 catch가 예외를 삼킨다                          rollbackOnly = TRUE (그대로)
t10  order()가 markBackorder() 후 정상 리턴                   rollbackOnly = TRUE (그대로)
t11  [order() 프록시]가 commit()을 시도한다
t12    커밋 직전 rollbackOnly 플래그를 확인 → TRUE
t13    → 커밋하지 않고 전체 롤백. t2의 주문 INSERT도 사라진다.
t14    → UnexpectedRollbackException 을 던진다
t15  컨트롤러는 정상 응답이 아니라 이 예외를 받는다 → 500
```

핵심은 **t7과 t9의 대비**다. t7에서 찍힌 것은 트랜잭션 객체의 **상태 플래그**이고, t9에서 삼킨 것은 **예외 객체**다. 서로 다른 두 가지이므로 후자를 잡는다고 전자가 지워지지 않는다.

한 문장으로 요약하면 이렇다. **예외는 잡을 수 있어도, 프록시가 이미 찍은 rollback-only 낙인은 잡을 수 없다.**

### 3-3. 왜 스프링은 그냥 커밋해주지 않는가

여기서 자연스럽게 따라오는 질문이 있다. 바깥에서 예외를 처리하겠다는데 스프링이 왜 굳이 막아서는가. 답이 셋이다.

**① 이미 절반이 무효인 트랜잭션이기 때문이다.** `decrease()`가 예외를 던지기 **전에** 수행한 쓰기(부분 차감, 재고 이력 INSERT 등)는 같은 물리 트랜잭션 안에 그대로 남아 있다. 이 상태로 커밋하면 **"실패했다고 선언된 작업이 반쯤 반영된 데이터"**가 확정된다. 정합성 관점에서 이것은 전체 롤백보다 훨씬 나쁘다.

**② 안쪽의 트랜잭션 선언을 호출자가 무효화할 수 없어야 하기 때문이다.** `decrease()`에 `@Transactional`을 붙인 것은 "이 작업은 실패하면 되돌려져야 한다"는 선언이다. 바깥이 예외를 삼켰다는 이유로 그 선언이 무시된다면, **같은 메서드의 트랜잭션 보장이 누가 호출하느냐에 따라 달라진다.** 선언적 트랜잭션의 의미가 무너진다.

**③ 조용한 롤백이 예외보다 위험하기 때문이다.** 플래그만 보고 말없이 롤백한 뒤 정상 응답을 돌려준다면, 호출자는 커밋됐다고 믿고 **후속 처리를 이어간다** — 주문 완료 알림을 보내고, 외부 시스템에 이벤트를 발행하고, 사용자에게 성공 화면을 띄운다. 그중 상당수는 되돌릴 수 없는 부수 효과다. 그래서 스프링은 `UnexpectedRollbackException`을 던져 **"당신이 기대한 커밋은 일어나지 않았다"고 호출자에게 반드시 알린다.**

운영 관점의 결론도 여기서 나온다. 로그에서 `UnexpectedRollbackException`을 보면 **"어딘가의 안쪽 트랜잭션이 rollback-only를 찍었고 바깥이 그걸 삼켰다"부터 의심하는 것**이 장애 추적의 정석이다.

### 3-4. 그럼 어떻게 설계해야 하나 — 네 가지 선택지와 그 대가

요구사항 자체("재고 실패 시 예약 주문으로 전환하고 주문은 커밋한다")는 정당하다. 그것을 어떻게 구현하느냐가 문제다.

#### ① `decrease()`를 `REQUIRES_NEW`로 — 트랜잭션을 물리적으로 분리한다

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void decrease(Long itemId, int quantity) { /* ... */ }
```

`REQUIRES_NEW`는 "열린 트랜잭션이 있어도 무시하고 **새 트랜잭션을 별도로 연다**"는 뜻이다. 별도의 물리 트랜잭션(별도 커넥션)이므로 실패해도 **자기 것만 롤백되고 바깥에는 낙인이 남지 않는다.** `order()`는 예외를 잡고 깨끗하게 커밋할 수 있다.

대가가 둘이다.

- **커넥션을 두 개 동시에 점유한다.** 바깥이 커넥션을 쥔 채 안쪽이 하나 더 요구하기 때문이다. 커넥션 풀 크기가 10인데 동시 요청 10건이 전부 바깥 커넥션만 잡고 두 번째를 기다리면, 아무도 진행하지 못하는 **풀 고갈성 교착**이 생긴다. `REQUIRES_NEW`를 쓸 때 풀 사이징을 다시 보는 것은 그래서다.
- **역방향 정합성 문제가 생긴다.** 두 트랜잭션이 독립이므로 `decrease()`가 커밋된 **뒤에** `order()`가 롤백되면 재고 차감만 남는다. `REQUIRES_NEW`는 "본 처리가 롤백돼도 이것만은 남아야 한다"(감사 로그, 실패 이력)가 요구사항일 때 어울리는 도구지 만능이 아니다.

#### ② `noRollbackFor` — 다는 위치를 틀리면 소용이 없다

```java
// 문제: order()에 걸어봐야 소용없다.
//       낙인을 찍는 주체는 decrease()의 프록시이고,
//       order()의 규칙으로는 이미 찍힌 낙인을 지울 수 없다.
//       → 여전히 UnexpectedRollbackException이 난다.
@Transactional(noRollbackFor = StockException.class)
public Order order(OrderRequest request) { /* ... */ }

// 고침: decrease()에 걸어야 한다. 프록시가 애초에 낙인을 찍지 않는다.
@Transactional(noRollbackFor = StockException.class)
public void decrease(Long itemId, int quantity) { /* ... */ }
```

**"낙인은 찍은 쪽에서만 막을 수 있다"**는 원리를 정확히 이해했는지가 이 선택지에서 드러난다.

다만 이쪽에도 함정이 있다. 같은 물리 트랜잭션이므로 `decrease()`가 예외를 던지기 **전에 수행한 쓰기**가 트랜잭션에 남은 채 `order()`와 함께 커밋된다. 3-3의 ①번 문제가 그대로 재현되는 것이다. **`decrease()`가 예외 전에 아무것도 쓰지 않는다는 보장이 있을 때만 안전하다.**

#### ③ `decrease()`의 `@Transactional`을 제거

낙인을 찍을 주체가 사라지므로 `UnexpectedRollbackException`은 나지 않는다. 하지만 ②와 똑같이 **부분 쓰기가 바깥 트랜잭션에 잔존하는 문제**는 그대로다. 게다가 `decrease()`를 다른 곳에서 단독으로 호출할 때 트랜잭션이 없어지는 부작용까지 생긴다.

#### ④ 예외를 프록시 경계 밖으로 내보내지 않는다 — 실패를 리턴값으로

```java
@Transactional
public StockResult decrease(Long itemId, int quantity) {
    try {
        // 차감 시도
        return StockResult.success();
    } catch (StockShortageException e) {
        // 예외가 이 메서드 밖으로 나가지 않으므로 프록시는 예외를 본 적이 없다.
        // 따라서 rollback-only 낙인이 아예 찍히지 않는다.
        return StockResult.shortage();
    }
}
```

`rollback-only` 낙인은 **"예외가 프록시를 통과할 때"** 찍힌다는 원리를 역이용한 것이다. **예상 가능한 비즈니스 실패는 예외가 아니라 리턴값으로 표현한다**는 설계 원칙과도 맞아떨어진다. 트랜잭션 메커니즘에 기대지 않으므로 전파 설정이 어떻든 동작이 명확하다는 것이 가장 큰 장점이다.

단, ②와 같은 부분 쓰기 이슈는 `decrease()` 내부에서 직접 정리(보상 로직)해야 한다.

#### 선택 기준

| 요구사항 | 맞는 선택 |
|---|---|
| 재고 실패는 예상된 분기다 | ④ 리턴값으로 표현 (가장 깔끔) |
| decrease()의 결과가 order()의 운명과 독립이어야 한다 | ① `REQUIRES_NEW` (커넥션 2개 점유를 감수) |
| 예외는 그대로 두되 낙인만 막고 싶다 | ② `decrease()`에 `noRollbackFor` (부분 쓰기 없음이 보장될 때) |

**요구사항을 먼저 확정하고 그에 맞는 도구를 고르는 것**이 시니어의 답변 방식이다. "`REQUIRES_NEW`를 쓰면 됩니다"로 시작하면 도구부터 고른 사람으로 보인다.

## 4. 꼬리질문 대비 포인트

### "`order()`(@Transactional)가 다른 빈의 `decrease()`(@Transactional, 전파 기본값)를 호출했고, `decrease()`의 RuntimeException을 `order()`가 try-catch로 잡아 정상 리턴했다 — 커밋되나요?"

**커밋되지 않는다.**

전파 기본값이 `REQUIRED`라 두 메서드는 **같은 물리 트랜잭션**을 공유한다. `decrease()`의 예외가 **`decrease()`의 프록시 경계**를 넘는 순간, 그 프록시는 자기가 트랜잭션의 주인이 아니므로 직접 롤백하지 못하고 공유 트랜잭션에 **rollback-only 낙인**을 찍는다.

`order()`가 예외를 삼켜도 낙인은 남는다. **삼킨 것은 예외 객체이고 낙인은 트랜잭션의 상태 플래그**라서 서로 다른 것이기 때문이다. 최종 커밋 시점에 이 플래그가 발견되어 전체가 롤백된다.

"예외를 잡았으니 커밋되겠지"는 **예외 전파와 트랜잭션 마킹을 혼동한 것**이다.

### "그럼 호출자(컨트롤러)는 뭘 받나요? 조용히 롤백되고 마는 건가요?"

**조용하지 않다. `UnexpectedRollbackException`을 받는다.**

`order()`의 프록시가 커밋을 시도하는 시점에 rollback-only 플래그를 발견하면 롤백을 수행하고 이 예외를 던진다. 개발자는 정상 응답을 기대했지만 클라이언트는 500을 받는다.

**스프링이 굳이 예외를 던지는 이유**까지 말하면 가산점이다. 조용히 롤백하고 정상 응답을 주면 호출자는 커밋됐다고 믿고 알림 발송·이벤트 발행 같은 **되돌릴 수 없는 후속 처리**를 이어간다. 그쪽이 훨씬 위험하므로, **커밋 실패는 반드시 호출자에게 알린다**는 것이 스프링의 설계다.

운영 관점을 덧붙이면 좋다. 로그에서 이 예외를 보면 "안쪽 트랜잭션이 rollback-only를 찍었고 누군가 그 예외를 삼켰다"부터 의심하는 것이 추적의 출발점이다.

### "재고 차감 실패 시 대체 로직을 태우고 `order()`는 정상 커밋되게 하려면 어떻게 설계하나요? 각 방법의 트레이드오프는?" (시니어 변별 포인트)

선택지가 넷이고, **요구사항을 먼저 확정한 뒤 도구를 고르는 순서**로 답한다. 상세는 3-4절이고, 요지만 정리하면 이렇다.

**① `decrease()`에 `REQUIRES_NEW`** — 별도 물리 트랜잭션이라 바깥에 낙인이 남지 않는다. 대가는 (a) 커넥션 2개 동시 점유로 인한 풀 고갈 위험, (b) 안쪽이 커밋된 뒤 바깥이 롤백되면 재고 차감만 남는 역방향 정합성 문제.

**② `decrease()`에 `noRollbackFor`** — 낙인을 찍는 주체에게 걸어야 효과가 있다(`order()`에 걸면 무의미). 대가는 `decrease()`가 예외 전에 쓴 데이터가 바깥과 함께 커밋된다는 것.

**③ `decrease()`의 `@Transactional` 제거** — 낙인 주체가 사라지지만 ②와 같은 부분 쓰기 문제가 그대로이고, 다른 호출 경로에서 트랜잭션이 없어지는 부작용이 추가된다.

**④ 실패를 예외가 아니라 리턴값으로 표현** — 예외가 프록시를 통과하지 않으므로 낙인이 아예 안 찍힌다. 예상 가능한 비즈니스 실패는 예외로 표현하지 않는다는 원칙과도 맞고, 전파 설정과 무관하게 동작이 명확하다. 부분 쓰기 정리는 내부에서 직접 해야 한다.

**"재고 실패가 예상된 분기라면 ④, `decrease()`의 결과가 `order()`의 운명과 독립이어야 한다면 ①"** — 이렇게 요구사항 기준으로 도구를 고르는 답변이 시니어 답변이다.

### "checked 예외는 왜 커밋이 기본인가요? 합리적인 설계라고 보시나요?" (시니어 변별 포인트)

**근거부터 말한다.** checked 예외는 컴파일러가 처리를 강제하는 예외이고, 강제한다는 것은 곧 **"이 상황은 발생이 예상되며 호출자가 복구할 수 있다"고 설계자가 선언한 것**이다. 그런 예외라면 지금까지 한 일도 유효한 결과로 볼 수 있다 — 그래서 커밋한다. 반대로 unchecked는 "예상 못 한 결함이거나 시스템 장애"라서 상태를 신뢰할 수 없으니 통째로 되돌린다. 이 구분은 EJB 시절의 규약을 스프링이 호환을 위해 계승한 것이다.

**타당성 평가까지 붙이면 답이 완성된다.** 철학 자체는 일관되지만 **전제가 오늘의 관행과 어긋나 있다.** 요즘 자바 실무는 비즈니스 예외를 `RuntimeException` 기반으로 만드는 쪽이 다수라서, checked 예외를 "복구 가능한 예상 결과"로 해석하는 전제가 잘 성립하지 않는다.

그래서 실무 결론은 셋 중 하나다 — (a) 예외 계층을 팀 차원에서 `RuntimeException` 기반으로 통일하거나, (b) `rollbackFor`를 명시하거나, (c) **스프링 6.2 이상이면 `@EnableTransactionManagement(rollbackOn = ALL_EXCEPTIONS)`로 전역 기본값 자체를 뒤집는다.** 스프링 팀도 EJB식 커밋 동작에 의존하지 않는다면 (c)를 권한다.

기본값의 유래와 현재의 한계를 함께 말하면 **암기가 아니라 판단으로 답하는 인상**을 준다.

### "같은 클래스 안의 `@Transactional` 메서드를 내부에서 호출하면 어떻게 되나요?"

**적용되지 않는다.** 트랜잭션 코드는 프록시에 있는데 `this.method()`는 프록시를 거치지 않고 원본을 직접 부르기 때문이다.

가장 위험한 지점은 **아무 신호가 없다는 것**이다. 컴파일 에러도 런타임 에러도 없이 조용히 트랜잭션 없이 실행된다. 예외가 나지 않는 정상 경로에서는 결과도 동일해서 테스트까지 통과한다.

해결은 해당 메서드를 **별도 빈으로 분리해 프록시를 다시 통과하게 만드는 것**이 정석이고, 자기 주입(self-injection)도 가능하지만 설계 신호를 가리는 방법이라 차선이다. AI가 생성한 서비스 코드를 리뷰할 때 반드시 확인하는 항목이기도 하다. 진단 절차와 각 해법의 대가는 [11번 문서](11-transactional-self-invocation.md)에서 상세히 다룬다.

### "`@Transactional`은 public 메서드에서만 동작하나요?" (가산점 포인트)

**스프링 6.0을 기준으로 답이 갈리므로, 버전을 나눠 말해야 정확하다.**

5.3까지는 프록시 방식에 관계없이 public이 아닌 메서드의 `@Transactional`이 **조용히 무시**됐다. 6.0부터는 **클래스 기반 프록시(CGLIB)에 한해 `protected`와 패키지 프라이빗 메서드도 기본적으로 트랜잭션 대상**이 된다. 인터페이스 기반 프록시(JDK)는 여전히 public이면서 프록시 대상 인터페이스에 선언된 메서드만 가능하다.

**`private`은 어느 쪽으로도 불가능하다.** CGLIB은 오버라이드로 가로채는데 `private`은 오버라이드 대상이 아니고, JDK 방식은 인터페이스로 가로채는데 인터페이스에는 `private` 메서드를 선언할 수 없다 — 가로챌 통로가 물리적으로 없다.

여기에 실무 판단을 얹으면 좋다. **6.0 이후에도 public을 기본으로 삼는 편이 낫다.** `protected`나 패키지 프라이빗 메서드를 바깥에서 프록시를 통해 부를 수 있는 상황 자체가 드물어(대개 같은 클래스 안에서 부르게 되고, 그러면 자기 호출 함정에 걸린다) 실익이 크지 않고, 프록시 방식이 바뀌면 동작이 달라지기 때문이다. 5.3까지의 동작으로 되돌리려면 `AnnotationTransactionAttributeSource(true)`를 빈으로 등록하면 된다.

---

## 한 줄 요약

`@Transactional`은 프록시가 메서드 경계에서 트랜잭션을 열고 **"프록시 밖으로 나온 예외"만 보고** 커밋·롤백을 판단하는 구조이고, 그 판단의 기본값이 "unchecked는 롤백, checked는 커밋"인 이유는 checked 예외를 **호출자가 복구를 예상하는 정상적 대안 결과**로 보는 자바·EJB의 설계 의도를 계승했기 때문이라서 — 이 전제가 요즘 관행과 어긋난 자리에서 "돈은 빠져나갔는데 입금은 안 된" 사고가 나고(대응은 예외 계층 통일 / `rollbackFor` / 6.2의 `rollbackOn = ALL_EXCEPTIONS`), 여기에 프록시 구조가 얹혀 자기 호출 미적용과 rollback-only 낙인에 의한 `UnexpectedRollbackException`까지 전부 **"프록시 경계에서 무슨 일이 일어났는가"** 하나로 설명된다.
