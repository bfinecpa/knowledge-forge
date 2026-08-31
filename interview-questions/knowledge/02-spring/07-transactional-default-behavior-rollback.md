# @Transactional 기본 동작과 롤백 규칙 — "예외는 났는데 데이터는 반쯤 커밋된" 사고의 근원

> 핵심 관전 포인트: **@Transactional은 프록시(가짜 대리인 객체)가 메서드
> 호출을 가로채서, 실행 전에 트랜잭션을 시작하고 정상 리턴하면 커밋,
> 예외가 프록시까지 튀어나오면 롤백 여부를 판단하는 구조다.
> 기본 롤백 대상은 unchecked 예외(RuntimeException, Error)뿐이고,
> checked 예외는 그대로 커밋된다 — 이 기본값을 모르면 "예외는 났는데
> 데이터는 반쯤 커밋된" 정합성 사고를 낸다. checked 예외도 롤백하려면
> `rollbackFor`를 명시해야 하고, 프록시 기반이라 자기 호출(self-invocation)에는
> 적용되지 않으며 public 메서드에서만 동작한다.**

---

## 0. 질문 + 의도

**질문**: "`@Transactional`의 기본 동작을 설명해주세요. 어떤 예외에서
롤백되나요?"

**출제 의도**: checked exception에서 롤백 안 되는 기본값을 모르면 "예외는
났는데 데이터는 반쯤 커밋된" 정합성 사고를 낸다. 결제 도메인에서는 이
한 줄이 돈 사고다 — 프레임워크 기본값을 확인하고 쓰는 습관과 정합성
감각을 검증하는 질문이다.

## 1. 동작 원리 — 프록시가 메서드를 감싼다

`@Transactional`을 붙였다고 그 메서드 자체가 특별해지는 게 아니다.
스프링은 그 빈을 감싸는 **프록시 객체**(대리인)를 만들어 컨테이너에 등록하고,
다른 빈이 주입받는 것은 원본이 아니라 이 프록시다.

프록시가 하는 일을 의사코드로 풀면 이렇다:

```java
// 프록시가 하는 일 (개념적으로)
public Order order(OrderRequest request) {
    TransactionStatus tx = txManager.getTransaction(definition);  // ① 트랜잭션 시작
    try {
        Order result = target.order(request);   // ② 진짜 객체의 메서드 실행
        txManager.commit(tx);                   // ③ 정상 리턴 → 커밋
        return result;
    } catch (Throwable ex) {
        if (rollbackOn(ex)) {                   // ④ 예외 → 롤백 규칙 판단
            txManager.rollback(tx);
        } else {
            txManager.commit(tx);               //    규칙에 안 걸리면 커밋!
        }
        throw ex;
    }
}
```

중요한 함의 두 가지:

- 커밋/롤백 판단은 **예외가 프록시 경계(메서드 밖)까지 나왔는지**로
  이루어진다. 메서드 안에서 try-catch로 잡아버리면 프록시는 예외를
  본 적이 없으므로 정상 커밋한다.
- ④에서 보듯 **예외가 났다고 무조건 롤백이 아니다.** 어떤 예외냐에 따라
  커밋될 수도 있다 — 이것이 다음 절의 기본 롤백 규칙이다.

## 2. 기본 롤백 규칙 — unchecked만 롤백, checked는 커밋

| 예외 종류 | 기본 동작 |
|---|---|
| `RuntimeException`과 그 하위 | 롤백 |
| `Error`와 그 하위 | 롤백 |
| checked 예외 (`Exception` 하위, Runtime 제외) | **커밋** |

왜 이렇게 설계됐나 — EJB 시절부터 내려온 관례로, checked 예외는
"호출자가 선언을 보고 복구를 계획할 수 있는 비즈니스 상황"(잔액 부족,
재고 없음 등)으로 간주해 데이터를 살려두고, unchecked 예외는
"복구 불가능한 프로그래밍 오류/시스템 장애"로 간주해 되돌린다는 철학이다.
철학의 타당성과 별개로, **기본값이 이렇다는 사실 자체를 모르는 것**이
실무 사고의 원인이 된다.

### 사고 나는 코드 (before)

```java
@Transactional
public void transfer(TransferRequest request) throws BalanceException {
    accountRepository.withdraw(request.from(), request.amount());  // ① 출금 성공

    if (isOverDailyLimit(request)) {
        throw new BalanceException("일 한도 초과");  // ② checked 예외!
    }
    accountRepository.deposit(request.to(), request.amount());     // ③ 도달 못 함
}
// 결과: 예외는 클라이언트까지 전파됐는데, ①의 출금은 커밋됨.
// "돈은 빠져나갔는데 입금은 안 된" 정합성 사고 — 결제 도메인이면 돈 사고.
```

### 고친 코드 (after)

```java
// 방법 A: rollbackFor로 checked 예외도 롤백 대상에 포함
@Transactional(rollbackFor = BalanceException.class)
public void transfer(TransferRequest request) throws BalanceException { ... }

// 방법 B (더 흔한 실무 관례): 비즈니스 예외를 RuntimeException 기반으로 설계
public class BalanceException extends RuntimeException { ... }
```

실무에서는 방법 B — 비즈니스 예외 계층을 `RuntimeException` 기반으로
통일하는 쪽이 일반적이다. `rollbackFor` 누락 실수 자체를 원천 차단하기
때문이다. 팀 컨벤션으로 `@Transactional(rollbackFor = Exception.class)`를
기본으로 박는 곳도 있다 (가산점 포인트: 이 컨벤션의 근거 —
"롤백 여부를 예외의 상속 계층이라는 우연에 맡기지 않겠다" — 까지
설명하면 좋다).

## 3. 프록시 기반이라 생기는 제약

### 3-1. 자기 호출(self-invocation)에는 적용 안 됨

```java
@Service
public class OrderService {

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.processOne(request);   // ❌ this = 원본 객체, 프록시를 안 거침
        }
    }

    @Transactional
    public void processOne(OrderRequest request) { ... }
    // → 트랜잭션 없이 조용히 실행된다. 예외도, 경고도 없다.
}
```

트랜잭션 시작 코드는 프록시에 있는데, `this.processOne()`은 프록시를
거치지 않고 원본 객체의 메서드를 직접 부르기 때문이다. 해결은
메서드를 다른 빈으로 분리해 프록시를 통해 호출되게 하는 것이 정석.
런타임에 아무 에러 없이 그냥 트랜잭션이 없는 채로 돌기 때문에
코드 리뷰에서 눈으로 잡아야 하는 함정이고, AI가 생성한 서비스 코드에도
흔히 들어 있다.

### 3-2. public 메서드에서만 동작

CGLIB 프록시는 메서드를 오버라이드해서 가로채는 방식이라
private 메서드는 애초에 가로챌 수 없다. 기본 설정에서는
public 메서드에만 적용된다고 답하면 된다.

---

## 4. 실전 시나리오 — rollback-only 마킹과 UnexpectedRollbackException

꼬리질문에서 실제로 파고든 시나리오. 트랜잭션 전파와 롤백 규칙이
교차하는 지점이라 이해도가 가장 잘 드러난다.

### 상황

```java
@Service
public class OrderService {
    @Transactional
    public Order order(OrderRequest request) {
        Order order = orderRepository.save(createOrder(request));
        try {
            stockService.decrease(request.itemId(), request.quantity());
        } catch (RuntimeException e) {
            order.markBackorder();   // 재고 실패 → 예약 주문으로 전환하고
        }
        return order;                // 정상 리턴 — "커밋되겠지"라고 기대
    }
}

@Service
public class StockService {
    @Transactional   // 전파 기본값 = REQUIRED
    public void decrease(Long itemId, int quantity) {
        // ... 재고 부족 시 RuntimeException
    }
}
```

### 무슨 일이 벌어지나

전파 기본값 `REQUIRED`는 "이미 열린 트랜잭션이 있으면 거기에 **합류**"라서
`order()`와 `decrease()`는 **같은 물리 트랜잭션 하나**를 공유한다.

1. `decrease()`에서 RuntimeException 발생
2. `decrease()`의 프록시가 예외를 감지 → 자기가 트랜잭션의 주인이
   아니므로(합류한 입장) 직접 롤백하지 못하고, 공유 트랜잭션에
   **rollback-only 마킹**을 찍는다 ("이 트랜잭션은 커밋하면 안 됨" 낙인)
3. `order()`가 예외를 catch로 삼키고 정상 리턴 — 하지만 마킹은
   예외를 잡는다고 지워지지 않는다
4. `order()`의 프록시가 커밋을 시도 → rollback-only 마킹 발견 →
   **전체 롤백**하고 `UnexpectedRollbackException`을 던진다

### 결과

- **커밋되지 않는다.** 주문 저장, markBackorder 전부 롤백.
- 조용한 롤백도 아니다. 개발자는 정상 응답을 기대했지만 컨트롤러에는
  `UnexpectedRollbackException`이 도착하고, 클라이언트는 500을 받는다.
  "try-catch로 잡았는데 왜 예외가?"라며 한참 헤매는 고전적 함정 —
  로그에서 이 예외를 보면 "내부 트랜잭션이 rollback-only를 찍었다"부터
  의심하는 것이 장애 추적의 정석이다.

핵심 문장: **예외는 잡을 수 있어도, 프록시가 이미 찍은 rollback-only
마킹은 잡을 수 없다.**

---

## 5. 꼬리질문 대비 포인트

### "order()(@Transactional)가 다른 빈의 decrease()(@Transactional, 전파 기본값)를 호출했고, decrease()의 RuntimeException을 order()가 try-catch로 잡아 정상 리턴했다 — 커밋되나?"

커밋되지 않는다. 전파 기본값이 `REQUIRED`라 두 메서드는 같은 물리
트랜잭션을 공유하는데, `decrease()`의 예외가 **decrease()의 프록시 경계**를
넘는 순간 그 프록시가 공유 트랜잭션에 rollback-only 마킹을 찍는다.
`order()`가 예외를 삼켜도 마킹은 남아 있고, 최종 커밋 시점에 이 마킹이
발견되어 전체가 롤백된다. "예외를 잡았으니 커밋되겠지"는 예외 전파와
트랜잭션 마킹을 혼동한 것이다.

### "그럼 호출자(컨트롤러)는 뭘 받나? 조용히 롤백되고 마는 건가?"

조용하지 않다. `order()`의 프록시가 커밋을 시도하는 시점에 rollback-only
마킹을 발견하면 **`UnexpectedRollbackException`**을 던진다. 개발자는
정상 응답을 기대하고 예외를 삼켰지만 클라이언트는 500을 받는다.
스프링이 이 예외를 던지는 이유는 "커밋됐다고 믿고 후속 처리(알림 발송 등)를
하는 것"이 조용한 롤백보다 더 위험하기 때문 — 커밋 실패를 호출자에게
반드시 알리겠다는 설계다 (가산점 포인트).

### "재고 차감 실패 시 대체 로직을 태우고 order()는 정상 커밋되게 하려면 어떻게 설계하나? 각 방법의 트레이드오프는?" (시니어 변별 포인트)

선택지별 동작과 함정을 비교해서 답한다.

**① 정석: `decrease()`에 `propagation = REQUIRES_NEW`**

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void decrease(Long itemId, int quantity) { ... }
```

별도의 물리 트랜잭션(별도 커넥션)으로 실행되므로, 실패하면 자기 것만
롤백되고 바깥 트랜잭션에는 마킹이 남지 않는다. `order()`는 예외를 잡고
깨끗하게 커밋할 수 있다. 트레이드오프:

- 바깥 트랜잭션이 커넥션을 쥔 채 안쪽이 커넥션을 하나 더 요구 —
  **커넥션 2개 동시 점유**. 동시 요청이 몰리면 서로 두 번째 커넥션을
  기다리는 풀 고갈/교착 상태가 날 수 있다.
- 두 트랜잭션이 독립이라, `decrease()`가 커밋된 **뒤에** `order()`가
  롤백되면 재고 차감만 남는 역방향 정합성 문제가 생긴다. "본 처리는
  롤백돼도 이건 남아야 한다"(감사 로그 등)가 요구사항일 때 어울리는
  도구지, 만능이 아니다.

**② `noRollbackFor` — 위치를 틀리면 소용없다**

```java
// ❌ order()에 걸면: 마킹을 찍는 주체는 decrease()의 프록시.
//    order()의 규칙으로는 이미 찍힌 마킹을 지울 수 없다.
//    → 여전히 UnexpectedRollbackException
@Transactional(noRollbackFor = StockException.class)
public Order order(OrderRequest request) { ... }

// ✅ decrease()에 걸어야 함: 프록시가 애초에 마킹을 안 찍는다
@Transactional(noRollbackFor = StockException.class)
public void decrease(Long itemId, int quantity) { ... }
```

단, 함정이 있다. 같은 물리 트랜잭션이므로 `decrease()`가 예외를 던지기
**전에 수행한 쓰기**(부분 차감, 이력 insert 등)가 트랜잭션에 남은 채로
`order()`와 함께 커밋된다. "실패했는데 반쯤 쓰인" 정합성 사고 —
decrease()가 예외 전에 아무것도 안 쓴다는 보장이 있을 때만 안전하다.

**③ `decrease()`의 @Transactional 제거** — 마킹 주체가 사라지니
UnexpectedRollbackException은 안 나지만, ②와 동일하게 부분 쓰기가
바깥 트랜잭션에 잔존하는 함정이 그대로다.

**④ 가장 깔끔한 대안: 예외를 프록시 경계 밖으로 내보내지 않기**

```java
@Transactional
public StockResult decrease(Long itemId, int quantity) {
    try {
        // 차감 시도
        return StockResult.success();
    } catch (StockShortageException e) {
        return StockResult.shortage();   // 실패를 리턴값으로 표현
    }
}
```

rollback-only 마킹은 "예외가 프록시를 통과할 때" 찍힌다는 원리를
역이용해, 예상 가능한 비즈니스 실패는 예외가 아니라 **리턴값**으로
표현하는 것. 트랜잭션 메커니즘에 의존하지 않아 전파 설정과 무관하게
동작이 명확하다. 단 ②와 같은 부분 쓰기 이슈는 decrease() 내부에서
직접 정리(보상 로직)해야 한다.

요구사항이 "재고 실패는 예상된 분기"라면 ④가 가장 깔끔하고,
"decrease()의 결과가 order()의 운명과 독립이어야 한다"면 ①이 맞다 —
라고 요구사항 기준으로 도구를 고르는 답변이 시니어 답변이다.

### "checked 예외는 왜 커밋이 기본인가? 합리적인 설계라고 보나?"

checked 예외는 "호출자가 복구를 계획하는 비즈니스 상황", unchecked는
"복구 불가능한 시스템 오류"라는 EJB 시절의 관례를 계승한 것이다.
다만 현대 자바 실무에서는 비즈니스 예외도 RuntimeException 기반으로
만드는 경우가 많아 이 구분의 실효성이 약해졌고, 그래서 "기본값에
의존하지 말고 rollbackFor를 명시하거나 예외 계층을 팀 차원에서
통일하라"가 실무 결론이다. 기본값의 유래와 현재의 한계를 같이 말하면
암기가 아니라 판단으로 답하는 인상을 준다.

### "같은 클래스 안의 @Transactional 메서드를 내부에서 호출하면?"

적용되지 않는다. 트랜잭션 코드는 프록시에 있는데 `this.method()`는
프록시를 거치지 않고 원본을 직접 부르기 때문이다. 컴파일 에러도
런타임 에러도 없이 **조용히 트랜잭션 없이 실행**되는 게 위험 포인트.
해결은 해당 메서드를 별도 빈으로 분리하는 것이 정석이고, 자기 자신을
주입받는 방식(self-injection)도 가능은 하지만 설계 냄새로 본다.
AI가 생성한 서비스 코드를 리뷰할 때 반드시 확인하는 항목이기도 하다.

---

## 한 줄 요약

@Transactional은 프록시가 메서드 경계에서 트랜잭션을 시작하고
"프록시 밖으로 나온 unchecked 예외"만 기본 롤백 대상으로 삼는 구조라서 —
checked 예외의 조용한 커밋, 자기 호출 미적용, 내부 트랜잭션의
rollback-only 마킹까지 전부 "프록시 경계에서 무슨 일이 일어나는가"
하나로 설명되고, 이 원리를 아는 사람만 UnexpectedRollbackException 같은
장애 앞에서 코드를 헤매지 않는다.
