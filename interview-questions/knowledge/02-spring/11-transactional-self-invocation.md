# @Transactional 자기 호출 미적용 — 조용히 트랜잭션 없이 도는 코드, 그리고 4가지 해법

> 핵심 관전 포인트: **트랜잭션 시작/커밋 코드는 원본 객체가 아니라
> 프록시에 있다. 그런데 같은 클래스 안에서 `this.method()`로 부르면
> 호출이 프록시를 거치지 않고 원본으로 직행하므로 @Transactional이
> 적용되지 않는다. 최악은 에러가 안 난다는 것 — 트랜잭션 없이 조용히
> 실행되다가 부분 커밋 사고로 발견된다. 해결의 정석은 트랜잭션
> 메서드를 별도 빈으로 분리해 호출이 프록시라는 문을 다시 통과하게
> 만드는 것이고, 자기 주입·TransactionTemplate은 차선책이다.**

---

## 0. 질문 + 의도

**질문**: "같은 클래스 내부 메서드 호출 시 `@Transactional`이 적용되지
않는 이유는? 해결 방법은?"

**출제 의도**: AOP 프록시 원리(앞 질문)의 실전 검증. 이 함정은 런타임에
조용히 트랜잭션 없이 실행되므로 코드 리뷰에서 눈으로 잡아야 하고,
AI가 생성한 서비스 코드에도 흔히 들어 있다. 원리를 "설명"하는 것을
넘어 사고를 "예방·수습"할 수 있는 사람인지 본다.

## 1. 왜 안 걸리나 — this는 프록시가 아니다

원리 자체는 [AOP 문서](10-aop-jdk-dynamic-proxy-vs-cglib.md)에서
상세히 다뤘으므로 여기서는 요점만 짚는다. 메모리에는 객체가 **두 개**
있다 — 부가 기능(트랜잭션 시작/커밋/롤백)을 가진 **프록시**와, 순수
비즈니스 로직만 가진 **원본(target)**. 다른 빈이 주입받는 것은
프록시이므로 밖에서 들어오는 호출은 트랜잭션이 걸리지만, 원본 안에서
실행되는 `this.method()`의 `this`는 원본 자신이라 프록시가 호출
경로에서 완전히 빠진다.

```java
@Service
public class OrderService {

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.processOne(request);   // ❌ this = 원본, 프록시 우회
        }
    }

    @Transactional
    public void processOne(OrderRequest request) {
        // 트랜잭션 없이 실행된다. 컴파일도 기동도 실행도 멀쩡하다.
    }
}
```

비유하면 — 회사 대표번호(프록시)로 걸려온 전화는 안내원이 기록을
남기지만, 담당자가 옆자리 동료에게 직접 말을 걸면 대표번호를 안
거쳤으니 기록이 남지 않는 것과 같다.

## 2. 증상 — 에러가 아니라 침묵이라서 악질이다

이 함정의 위험도는 "동작이 틀린다"가 아니라 **"틀렸다는 신호가
없다"**에서 나온다.

- 예외도 경고 로그도 없다. 메서드는 정상 실행되고 리턴값도 정상이다.
- 트랜잭션이 없으므로 JPA/JDBC 쿼리는 **문장 단위로 즉시 커밋**된다
  (auto-commit). 중간에 예외가 나면 앞의 쿼리만 반영된
  **부분 커밋(반쯤 저장된 데이터)** 상태로 남는다.
- 평소에는 테스트가 다 통과한다 — 예외가 안 나면 결과가 트랜잭션
  유무와 동일하기 때문이다. **실패 경로에서만, 운영에서만 드러난다.**

그래서 발견 수단이 두 가지로 좁혀진다: (1) 코드 리뷰에서 눈으로 잡기
— 같은 클래스 안에서 `@Transactional` 메서드를 부르는 내부 호출 패턴,
(2) 런타임 확인 — 의심 지점에서
`TransactionSynchronizationManager.isActualTransactionActive()`를
찍어보거나, `org.springframework.transaction.interceptor` 로거를
TRACE로 올려 트랜잭션 시작/커밋 로그가 실제로 찍히는지 본다.

AI가 생성한 서비스 코드에 이 패턴이 흔한 이유도 같다 — 문법상
완벽하게 자연스러운 코드라서, "동작하는 코드"만 검증하는 리뷰로는
통과된다. (가산점 포인트: AI 코드 리뷰 체크리스트에 "자기 호출 +
@Transactional 조합"을 명시적 항목으로 둔다고 말하면 좋다.)

## 3. 해결 방법 — 정석 하나와 차선책들

### 3-1. 별도 빈으로 분리 (정석)

트랜잭션 단위가 클래스 경계와 어긋났다는 신호로 받아들이고, 트랜잭션
메서드를 다른 빈으로 옮긴다. 호출이 **프록시라는 문을 다시 통과**하게
되므로 구조적으로 해결된다.

```java
// before — 자기 호출로 트랜잭션 미적용
@Service
public class OrderService {

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.processOne(request);          // ❌
        }
    }

    @Transactional
    public void processOne(OrderRequest request) { ... }
}

// after — 별도 빈으로 분리, 프록시를 통해 호출
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderProcessor orderProcessor;   // 주입받는 건 프록시

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            orderProcessor.processOne(request);    // ✅ 프록시 경유
        }
    }
}

@Service
public class OrderProcessor {

    @Transactional
    public void processOne(OrderRequest request) { ... }
}
```

부수 효과도 좋은 쪽이다 — "건별 처리"라는 책임이 분리되면서 단위
테스트 대상이 명확해지고, 건별 트랜잭션이라는 의도가 클래스 구조에
드러난다. 대부분의 자기 호출 문제는 이 방법으로 푸는 것이 실무 관례다.

### 3-2. 자기 주입 (self-injection)

자기 자신의 프록시를 주입받아 `this` 대신 프록시로 호출하는 방법.
분리할 만한 응집된 책임이 안 보일 때 임시로 쓸 수 있지만, "자기가
자기를 주입받는" 구조 자체가 설계 냄새라서 리뷰에서 지적받기 쉽다.

```java
@Service
public class OrderService {

    // 순환 참조를 피하려고 지연 주입 — 이 어색함 자체가 냄새다
    @Autowired @Lazy
    private OrderService self;

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            self.processOne(request);   // ✅ 프록시 경유 (this가 아님)
        }
    }

    @Transactional
    public void processOne(OrderRequest request) { ... }
}
```

`ObjectProvider<OrderService>`로 받아 호출 시점에 꺼내는 변형도 있다.
어느 쪽이든 "프록시를 거치게 한다"는 본질은 3-1과 같고, 클래스 분리를
안 했다는 점만 다르다.

### 3-3. TransactionTemplate (프로그래밍 방식)

애너테이션(선언적 방식)을 포기하고 트랜잭션 경계를 코드로 직접 긋는다.
프록시에 의존하지 않으므로 자기 호출 문제가 원천적으로 없다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final TransactionTemplate transactionTemplate;

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            transactionTemplate.executeWithoutResult(status -> {
                processOne(request);   // ✅ 트랜잭션 경계가 코드에 명시됨
            });
        }
    }

    private void processOne(OrderRequest request) { ... }
}
```

트랜잭션 경계가 눈에 보인다는 장점이 있어서, "반복문 안에서 건별
트랜잭션" 같은 세밀한 제어가 필요한 지점에는 오히려 이쪽이 명확하다.
대신 보일러플레이트가 늘고 선언적 스타일과 섞이면 일관성이 깨진다.

### 3-4. AopContext.currentProxy() (마지막 수단)

`@EnableAspectJAutoProxy(exposeProxy = true)` 설정 후 현재 스레드에
노출된 프록시를 꺼내 호출하는 방법.

```java
((OrderService) AopContext.currentProxy()).processOne(request);
```

비즈니스 코드가 "내가 프록시로 감싸져 있다"는 인프라 사실을 알게
되므로 침투성이 가장 나쁘다. 레거시에서 클래스 분리가 당장 불가능할
때의 응급 처치로만 언급하고, 권장하지 않는다고 답하는 게 좋다.

(가산점 포인트: AspectJ 위빙으로 전환하면 프록시 자체가 없어져 자기
호출 제약이 사라진다는 것까지 알면 좋지만, 빌드 파이프라인 복잡도
때문에 "이 문제 하나를 풀자고 도입하는 건 과잉"이라는 판단까지
붙여야 한다.)

## 4. 꼬리질문 대비 포인트

### "왜 CGLIB은 상속인데 this.method() 호출이 프록시 걸로 안 가나?"

스프링의 CGLIB 프록시는 `super` 호출 방식이 아니라 **별도 원본
인스턴스에 위임**하는 구조이기 때문. 상속은 "같은 타입인 척"하기 위한
수단일 뿐이고, 프록시가 원본에 위임한 순간부터 실행 주체는 원본이라
`this`에 프록시가 개입할 여지가 없다. — 상세는
[AOP 문서](10-aop-jdk-dynamic-proxy-vs-cglib.md) §5.

### "별도 빈 분리와 자기 주입 중 무엇을 택하겠나? 기준은?" (시니어 변별 포인트)

기본은 빈 분리. 자기 호출이 필요해졌다는 것 자체가 "한 클래스에
트랜잭션 단위가 다른 두 책임이 들어 있다"는 신호인 경우가 많아서,
분리가 문제와 설계를 동시에 고친다. 자기 주입은 프록시 문제만 가리고
설계 신호는 무시하는 방법이라, 분리할 응집 단위가 정말 안 나오는
경우의 차선으로만 쓴다. "반복문 안 건별 트랜잭션"처럼 경계 제어가
목적이면 TransactionTemplate이 의도를 가장 잘 드러낸다 — 상황별로
도구를 고르는 기준을 말하는 것이 포인트다.

### "processAll에도 @Transactional이 붙어 있었다면 어떻게 되나?"

바깥 메서드가 프록시를 통해 호출됐다면 트랜잭션은 존재한다. 내부의
`this.processOne()`은 여전히 프록시를 안 거치므로 **processOne의
@Transactional 속성(REQUIRES_NEW, readOnly 등)은 전부 무시**되고,
그냥 바깥 트랜잭션 안에서 평범한 메서드로 실행된다. "트랜잭션이 아예
없는 것"과 "속성이 무시된 채 바깥에 합류하는 것"을 구분해서 답하면
정확하다. 건별 커밋을 의도하고 REQUIRES_NEW를 붙였는데 전체가 한
트랜잭션으로 묶이는 사고가 이 유형이다. — 전파 옵션 자체는
[전파 문서](12-transaction-propagation-required-vs-requires-new.md) 참고.

### "이 함정은 @Transactional만의 문제인가?"

아니다. 프록시 기반 부가 기능 전부가 같은 구조다 — `@Cacheable`은
자기 호출 시 캐시를 안 타고 매번 원본을 실행하며, `@Async`는 비동기가
아니라 동기로 실행된다. "자기 호출 미적용"을 개별 애너테이션의 버그가
아니라 **프록시 방식의 공통 제약**으로 묶어 설명하면 원리를 이해하고
있다는 신호가 된다.

### "트랜잭션이 실제로 적용됐는지 런타임에 어떻게 확인하나?"

의심 지점에서 `TransactionSynchronizationManager.isActualTransactionActive()`
값을 확인하는 것이 가장 직접적이다. 또는
`org.springframework.transaction.interceptor` 로거를 TRACE로 올리면
"Getting transaction for [...]" / "Completing transaction for [...]"
로그로 어떤 메서드에 트랜잭션이 열렸는지 보인다. "붙였으니 되겠지"가
아니라 적용 여부를 검증하는 수단을 갖고 있는지를 보는 질문이다.

---

## 한 줄 요약

트랜잭션 코드는 프록시에 있는데 `this.method()`는 프록시를 우회해
원본을 직접 부르므로 @Transactional이 조용히 무시된다 — 에러 없이
auto-commit으로 돌다가 부분 커밋 사고로 발견되는 함정이라 코드
리뷰에서 잡아야 하고, 해결은 트랜잭션 메서드를 별도 빈으로 분리해
호출이 프록시를 다시 통과하게 만드는 것이 정석이다.
