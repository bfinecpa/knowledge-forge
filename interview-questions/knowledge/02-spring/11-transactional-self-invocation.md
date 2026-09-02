# @Transactional 자기 호출 미적용 — 조용히 트랜잭션 없이 도는 코드, 그리고 4가지 해법

> 핵심 관전 포인트: **트랜잭션을 열고 닫는 코드는 원본 객체가 아니라 그 앞에 세워진 프록시에 있다. 그런데 같은 클래스 안에서 `this.method()`로 부르면 호출이 프록시를 거치지 않고 원본으로 직행하므로 `@Transactional`이 아예 적용되지 않는다. 이 함정이 위험한 이유는 동작이 틀리기 때문이 아니라 틀렸다는 신호가 하나도 없기 때문이다 — 컴파일도 기동도 실행도 멀쩡하고, 예외가 나지 않는 정상 경로에서는 결과까지 같아서 테스트도 통과한다. 트랜잭션이 없으면 Spring Data JPA 리포지토리 호출이 건건이 자기 트랜잭션을 열고 즉시 커밋하므로 실패 시 앞부분만 남은 부분 커밋이 되고, 엔티티 변경 감지는 flush될 트랜잭션이 없어 UPDATE가 아예 나가지 않는다. 그래서 배포 직후가 아니라 몇 주 뒤 정산 불일치로 발견된다. 확인은 추측이 아니라 절차로 한다 — 주입받은 참조에 `AopUtils.isAopProxy()`, 의심 지점에 `TransactionSynchronizationManager.isActualTransactionActive()`와 `getCurrentTransactionName()`, 그리고 `org.springframework.transaction.interceptor` 로거를 TRACE로 올려 어느 메서드에 트랜잭션이 실제로 열렸는지 눈으로 본다. 해법은 넷이고 각각 대가가 다르다 — 별도 빈 분리(클래스가 늘지만 유일하게 구조적 해결), 자기 주입(순환 참조를 만들고 `@Lazy`가 필요하며 설계 신호를 가린다), `TransactionTemplate`(선언적 트랜잭션의 이점을 포기한다), `AopContext.currentProxy()`(`exposeProxy=true` 전역 설정이 필요하고 코드가 스프링에 묶인다). 정석이 빈 분리인 이유는 프록시 때문이 아니다 — 트랜잭션 경계는 곧 설계 경계이고, 자기 호출로 트랜잭션을 나누고 싶다는 욕구 자체가 "이 메서드는 다른 책임이다"라는 신호이기 때문이다.**

---

## 0. 질문 + 의도

**질문**: "같은 클래스 내부 메서드 호출 시 `@Transactional`이 적용되지 않는 이유는? 해결 방법은?"

**출제 의도**: AOP 프록시 원리(앞 질문)의 실전 검증. 이 함정은 런타임에 조용히 트랜잭션 없이 실행되므로 코드 리뷰에서 눈으로 잡아야 하고, AI가 생성한 서비스 코드에도 흔히 들어 있다. 원리를 "설명"하는 것을 넘어 사고를 "예방·수습"할 수 있는 사람인지 본다.

이 문서는 **스프링 프록시 3부작의 함정 편**이다. 프록시가 어떻게 만들어지는지(JDK 동적 프록시 vs CGLIB, `final` 함정)는 [10번 문서](10-aop-jdk-dynamic-proxy-vs-cglib.md)가, `@Transactional`의 기본 동작과 롤백 규칙은 [07번 문서](07-transactional-default-behavior-rollback.md)가 본론이다. 여기서는 **자기 호출 함정 하나만** 끝까지 파고든다 — 증상을 어떻게 알아채고, 네 가지 해법이 각각 무엇을 대가로 치르는지. 버전에 의존하는 서술은 **스프링 프레임워크 6.x / 스프링 부트 3.x 기준**으로 쓴다.

## 1. 왜 안 걸리나 — `this`는 프록시가 아니다

### 1-1. 전제 — 메모리에 객체가 두 개 있다

원리 자체는 10번 문서에서 상세히 다뤘으므로 여기서는 결론만 짚고 간다.

`@Transactional`이 붙은 빈에 대해 스프링은 **원본 객체(target)**와 **그것을 감싼 프록시 객체** 두 개를 만들고, 컨테이너에 등록해 다른 빈에 주입하는 것은 **프록시 쪽**이다. 트랜잭션 시작·커밋·롤백 코드는 **프록시에만** 있고 원본에는 한 줄도 없다.

```text
[프록시 객체]  ──target 필드로 참조──▶  [원본 객체]
 processAll()  트랜잭션 코드 있음           processAll()  순수 로직만
 processOne()  트랜잭션 코드 있음           processOne()  순수 로직만
```

그러므로 부가 기능이 실행되는 조건은 **"이 메서드에 애너테이션이 붙어 있는가"가 아니라 "이 호출이 프록시 객체를 통과했는가"**다.

### 1-2. 호출 경로를 한 단계씩 따라가면

```java
@Service
public class OrderService {

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.processOne(request);   // 문제: this = 원본 객체, 프록시를 우회한다
        }
    }

    @Transactional
    public void processOne(OrderRequest request) {
        // 트랜잭션 없이 실행된다. 컴파일도 기동도 실행도 멀쩡하다.
    }
}
```

```text
① 컨트롤러가 orderService.processAll() 호출
   → 주입받은 참조는 프록시이므로 [프록시의 processAll()]이 실행된다.

② processAll()에는 @Transactional이 없으므로 프록시는 부가 작업 없이 위임한다.
   → [원본의 processAll()]로 흐름이 넘어간다. ★ 이 순간부터 실행 주체는 원본이다.

③ 원본의 processAll() 안에서 this.processOne() 실행.
   → 여기서 this는 원본 객체 자신이다. 프록시를 가리키는 참조가 아니다.

④ [원본의 processOne()]이 직접 실행된다.
   → 프록시의 processOne()도 트랜잭션 코드를 갖고 대기 중이지만,
     그쪽으로 호출이 들어오지 않았으므로 아무 일도 하지 않는다.
```

②번이 결정적이다. **프록시가 원본에 위임하는 순간 프록시는 호출 스택에서 빠져나간다.** 그 뒤로 원본 안에서 벌어지는 모든 내부 호출은 프록시와 무관하다.

비유하면 이렇다. 회사 대표번호(프록시)로 걸려온 전화는 안내원이 통화 기록을 남기고 담당자에게 연결한다. 그런데 담당자가 옆자리 동료에게 **직접 말을 걸면** 대표번호를 거치지 않았으니 기록이 남지 않는다. 안내원이 모든 직원의 전화를 받을 수 있다는 사실과는 무관하다 — **그 경로로 들어오지 않은 대화는 잡을 수 없다.**

### 1-3. "CGLIB은 상속인데, 오버라이드된 프록시 메서드가 불려야 하지 않나요?"

날카로운 반문이고, 실제로 면접에서 자주 나온다. 자바의 동적 디스패치 규칙대로라면 자식이 오버라이드한 메서드가 불려야 맞기 때문이다.

답은 **스프링의 CGLIB 프록시가 `super` 호출 방식으로 동작하지 않는다**는 것이다. 상속은 "같은 타입인 척"하기 위한 수단일 뿐이고, 실제 동작은 **별도 인스턴스에 대한 위임**이다.

```java
// 상속이니까 이렇게 동작할 것 같지만 — 이 방식이라면 자기 호출도 걸린다
public void processAll(List<OrderRequest> requests) {
    부가기능();
    super.processAll(requests);   // 문제: 스프링은 이 방식이 아니다
}

// 실제로는 별도의 원본 인스턴스에 위임한다
public void processAll(List<OrderRequest> requests) {
    부가기능();
    target.processAll(requests);  // 고침: 완전히 다른 객체의 메서드를 부른다
}
```

`super` 호출이었다면 실행 주체가 프록시 인스턴스 **하나뿐**이라 `this`가 곧 프록시가 되어 자기 호출도 걸렸을 것이다. 하지만 스프링은 프록시와 원본을 **별개의 두 인스턴스**로 두고 위임하므로, 원본 안으로 흐름이 넘어간 순간 `this`는 순수한 원본이고 동적 디스패치가 개입할 여지가 없다.

이 사실의 방증이 하나 있다. 디버거로 프록시 객체의 필드를 열어보면 **전부 `null`인 경우가 있다.** 의존성 주입은 원본 객체에 일어나고 프록시는 껍데기이기 때문이다. 프록시와 원본이 정말로 서로 다른 두 객체라는 직접적인 증거다.

## 2. 증상 — 에러가 아니라 침묵이라서 악질이다

### 2-1. 트랜잭션이 없으면 실제로 무슨 일이 벌어지나

"트랜잭션이 안 걸린다"는 문장은 추상적이다. 구체적으로 무엇이 달라지는지 알아야 증상을 알아볼 수 있다.

**① Spring Data JPA 리포지토리 호출은 건건이 커밋된다.** `SimpleJpaRepository`의 메서드에는 `@Transactional`이 걸려 있다. 바깥에 트랜잭션이 없으면 **리포지토리 호출 하나마다 자기 트랜잭션을 열고 즉시 커밋**한다. 그래서 반복문 중간에 예외가 나면 그 전까지 저장된 것만 남는 **부분 커밋** 상태가 된다.

**② 엔티티 변경 감지가 아예 동작하지 않는다.** 이쪽이 더 무섭다. 스프링 부트의 OSIV(open-session-in-view) 기본값 때문에 영속성 컨텍스트는 요청이 끝날 때까지 열려 있지만, **변경 감지에 의한 flush는 트랜잭션 커밋 시점에 일어난다.** 트랜잭션이 없으면 flush 시점 자체가 오지 않으므로, `order.markPaid()` 같은 엔티티 수정은 **UPDATE 문이 아예 나가지 않고 조용히 사라진다.** 예외도, 경고도, 로그도 없다.

**③ `JdbcTemplate`은 문장 단위로 커밋된다.** 커넥션의 autoCommit이 켜진 상태(HikariCP 기본값)로 실행되기 때문이다. 역시 부분 커밋이 된다.

**④ `@Transactional`의 속성이 전부 무시된다.** `readOnly`, `propagation`, `isolation`, `timeout`, `rollbackFor` — 전부 프록시가 읽어서 적용하는 값이므로 프록시를 안 거치면 존재하지 않는 것과 같다. **`REQUIRES_NEW`를 붙여 건별 커밋을 의도했는데 트랜잭션 자체가 없는** 상황이 여기서 나온다.

**⑤ 그런데 정상 경로에서는 결과가 똑같다.** 예외가 나지 않으면 "건건이 커밋"이든 "한 번에 커밋"이든 최종 데이터는 같다. **그래서 테스트가 통과한다.** 이 함정이 리뷰를 뚫고 배포되는 이유가 이것이다.

### 2-2. 발견되기까지 — 어느 팀에나 있을 법한 타임라인

침묵이 왜 악질인지는 시간축으로 봐야 실감이 난다. 주문 처리 배치에 이 버그가 들어간 경우를 따라가 보자.

```text
D+0  10:00  배포. processAll() 안에서 this.processOne()을 부르는 코드.
            리뷰어 2명 통과 — 문법적으로 완벽하게 자연스러운 코드다.
D+0  10:05  스모크 테스트 정상. 실패 경로를 밟지 않았으므로 결과가 동일하다.
D+0  10:30  대시보드 이상 없음. 에러가 안 나므로 에러율 알람이 울릴 리 없다.
──────────── 여기까지가 "성공한 배포"로 기록된다 ────────────
D+3         재고 부족으로 processOne()이 중간에 실패하는 케이스가 하루 2~3건 발생.
            포인트는 차감됐는데 이용권은 안 나간 주문이 조용히 쌓이기 시작한다.
            건수가 적어 어떤 지표에도 잡히지 않는다.
D+9         CS 문의 12건 누적. "결제했는데 콘텐츠가 안 열려요."
            개별 건으로 처리되어 수동 보정만 하고 원인 조사로 이어지지 않는다.
D+11        월 정산 배치가 차감 원장 합계와 이용권 발급 건수의 불일치 37건을 리포트.
            비로소 "개별 CS가 아니라 시스템 문제"라는 인식이 생긴다.
D+11        조사 착수. 애플리케이션 로그에 예외가 없어 단서가 없다.
            트랜잭션 로거를 TRACE로 올려 재현 → "Getting transaction for
            [...processAll]"은 찍히는데 "[...processOne]"이 없다 → 자기 호출 확정.
D+12        빈 분리 배포 + 37건 수동 보정 + 보정 이력 감사 대응.
```

**배포에서 발견까지 11일, 그 사이 데이터 오염 37건.** 같은 코드가 예외를 던졌다면 배포 30분 만에 롤백됐을 것이다. 10번 문서의 `final` 메서드 함정과 정확히 같은 구조다 — **장애의 악질성은 에러의 크기가 아니라 발견되기까지의 침묵으로 결정된다.**

AI가 생성한 서비스 코드에 이 패턴이 흔한 이유도 같은 맥락이다. 문법과 가독성 기준으로는 흠잡을 데 없는 코드라서, **"동작하는 코드"만 검증하는 리뷰로는 통과한다.** (가산점 포인트: AI 코드 리뷰 체크리스트에 "자기 호출 + `@Transactional` 조합"을 명시적 항목으로 둔다고 말하면 좋다. 관련 문서는 [35번](35-ai-code-transaction-review-checklist.md)이다.)

### 2-3. 내 코드에 이 버그가 있는지 확인하는 절차

"조심하겠습니다"는 답이 아니다. **확인 수단을 갖고 있는지**가 이 질문의 진짜 관전 포인트다. 정적 확인과 동적 확인을 나눠서 갖춰 둔다.

#### 정적 확인 — 코드에서 패턴을 찾는다

같은 클래스 안에서 `@Transactional`이 붙은 메서드를 부르는 호출을 찾는다. `this.`를 생략해도 자기 호출이라는 점이 함정이다 — `processOne(request)`처럼 수신자 없이 쓰면 눈에 잘 안 띈다.

```bash
# @Transactional이 붙은 메서드 이름을 뽑아두고, 같은 파일 안에서
# 그 이름이 수신자 없이 호출되는 자리를 찾는다.
grep -rn -B2 "@Transactional" --include=*.java src/main/java | grep "public\|protected"
```

팀 차원에서는 ArchUnit 같은 아키텍처 테스트나 정적 분석 규칙으로 고정해두는 편이 낫다. 사람 눈은 이 패턴을 놓친다.

#### 동적 확인 ① — 주입받은 참조가 프록시가 맞는지

프록시 자체가 만들어지지 않은 경우(10번 문서의 `final` 클래스 함정 등)를 걸러낸다.

```java
@Autowired OrderService orderService;

@Test
void 프록시가_적용됐는지_확인() {
    // 주입받은 참조에 대해 검사해야 의미가 있다.
    assertThat(AopUtils.isAopProxy(orderService)).isTrue();
    assertThat(AopUtils.isCglibProxy(orderService)).isTrue();   // 부트 기본값은 CGLIB
}
```

주의할 점이 하나 있다. **원본 메서드 안에서 `AopUtils.isAopProxy(this)`를 찍으면 언제나 `false`가 나온다.** 1-2절에서 봤듯 그 자리의 `this`는 원본이기 때문이다. 이것은 버그 탐지가 아니라 **"`this`는 프록시가 아니다"라는 사실의 실증**으로 쓸 수 있다 — 신입 교육 때 한 번 찍어보게 하면 설명이 필요 없어진다.

#### 동적 확인 ② — 그 지점에 트랜잭션이 실제로 열려 있는지

가장 직접적인 방법이다.

```java
@Transactional
public void processOne(OrderRequest request) {
    // 지금 이 실행이 트랜잭션 안인지 물어본다. 자기 호출로 들어왔다면 false다.
    log.info("tx active = {}", TransactionSynchronizationManager.isActualTransactionActive());

    // 한 걸음 더 — "어느 메서드가 이 트랜잭션을 열었는가"를 알려준다.
    // 선언적 트랜잭션이면 "com.example.OrderService.processOne" 형태로 나온다.
    // 여기에 processAll이 찍힌다면 processOne의 @Transactional은 무시된 것이다.
    log.info("tx name = {}", TransactionSynchronizationManager.getCurrentTransactionName());
}
```

`getCurrentTransactionName()`이 유용한 이유는 **"트랜잭션이 있다/없다"가 아니라 "누가 열었는가"까지 알려주기 때문**이다. 바깥에도 `@Transactional`이 있는 경우(4절 꼬리질문)에는 `isActualTransactionActive()`가 `true`로 나와서 문제를 놓치는데, 이름을 보면 곧바로 드러난다.

#### 동적 확인 ③ — 트랜잭션 로그를 켠다

코드를 건드리지 않고 확인하는 방법이다. 운영 이슈를 재현할 때 쓴다.

```yaml
logging:
  level:
    org.springframework.transaction.interceptor: TRACE
```

이렇게 하면 트랜잭션이 열리고 닫힐 때마다 로그가 남는다.

```text
TRACE ... Getting transaction for [com.example.OrderService.processAll]
TRACE ... Completing transaction for [com.example.OrderService.processAll]
```

**기대한 메서드 이름이 목록에 없으면 그 메서드의 `@Transactional`은 적용되지 않은 것이다.** 위 타임라인 D+11에서 원인을 확정한 수단이 바로 이것이다.

#### 회귀 방지 — 테스트로 고정한다

한 번 고쳤으면 다시 안 깨지게 못 박아 둔다. 트랜잭션이 걸렸는지를 검증하는 가장 확실한 방법은 **실패 경로에서 롤백되는지 보는 것**이다.

```java
@Test
void 중간에_실패하면_그_건은_통째로_롤백된다() {
    // 두 번째 저장에서 예외가 나도록 준비한 뒤,
    assertThatThrownBy(() -> orderService.processOne(실패하는_요청))
        .isInstanceOf(OrderException.class);

    // 앞부분 저장도 남아 있지 않아야 한다. 트랜잭션이 없으면 이 단언이 깨진다.
    assertThat(orderRepository.count()).isZero();
}
```

**정상 경로 테스트로는 이 버그가 절대 잡히지 않는다**(2-1의 ⑤). 실패 경로 테스트가 유일한 자동 방어선이다.

## 3. 해결 방법 네 가지와 각각의 대가

네 방법 모두 "프록시를 다시 통과하게 하거나, 프록시에 의존하지 않게 한다"는 같은 목표를 갖는다. 차이는 **무엇을 대가로 치르느냐**다.

### 3-1. 별도 빈으로 분리 (정석)

트랜잭션 메서드를 다른 빈으로 옮긴다. 호출이 **프록시라는 문을 다시 통과**하게 되므로 구조적으로 해결된다.

```java
// before — 자기 호출로 트랜잭션 미적용
@Service
public class OrderService {

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            this.processOne(request);          // 문제: 프록시 우회
        }
    }

    @Transactional
    public void processOne(OrderRequest request) { /* ... */ }
}
```

```java
// after — 별도 빈으로 분리, 프록시를 통해 호출
@Service
@RequiredArgsConstructor
public class OrderService {

    // 주입받는 것은 원본이 아니라 프록시다. 여기가 이 해법의 전부다.
    private final OrderProcessor orderProcessor;

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            orderProcessor.processOne(request);   // 고침: 프록시를 경유한다
        }
    }
}

@Service
@RequiredArgsConstructor
public class OrderProcessor {

    @Transactional
    public void processOne(OrderRequest request) { /* 건별로 커밋된다 */ }
}
```

**대가**: 클래스 파일이 하나 늘고, 두 클래스 사이에 의존성과 필드를 나눠 배치해야 한다. 나누는 기준을 잘못 잡으면 `OrderProcessor`처럼 **아무 의미 없는 이름의 빈**이 생겨 오히려 응집도가 떨어진다.

**그런데 이 대가는 대체로 이득으로 돌아온다.** "여러 건을 순회하며 오케스트레이션하는 책임"과 "한 건을 원자적으로 처리하는 책임"은 원래 다른 책임이다. 분리하면 단위 테스트 대상이 명확해지고, **건별 트랜잭션이라는 의도가 클래스 구조에 드러난다.** 이 관점은 3-5절에서 결론으로 다시 다룬다.

### 3-2. 자기 주입 (self-injection)

자기 자신의 프록시를 주입받아 `this` 대신 그것으로 호출한다.

```java
@Service
public class OrderService {

    // @Lazy가 필요한 이유: 자기가 자기를 주입받는 순환 구조라
    // 실제 해석을 첫 사용 시점까지 미뤄야 안전하다.
    @Autowired @Lazy
    private OrderService self;

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            self.processOne(request);   // 고침: self는 프록시다 (this가 아니다)
        }
    }

    @Transactional
    public void processOne(OrderRequest request) { /* ... */ }
}
```

**대가 세 가지.**

**① 순환 참조를 만든다.** 생성자 주입 형태의 자기 주입은 "자기를 만들려면 자기가 필요한" 진짜 순환이라 `BeanCurrentlyInCreationException`으로 확실히 실패한다. 필드·세터 주입은 동작하지만, **스프링 부트 2.6부터 순환 참조가 기본적으로 금지**(`spring.main.allow-circular-references=false`)로 바뀌어 빈 구성에 따라 기동 단계에서 막힐 수 있다. `@Lazy`나 `ObjectProvider<OrderService>`를 끼워 해석을 늦추는 관용구가 굳은 것도 이 때문이다. **필요한 우회 장치가 있다는 것 자체가 구조가 자연스럽지 않다는 신호다.**

**② 설계 신호를 가린다.** 3-5절에서 볼 내용인데, 자기 호출이 필요해졌다는 것은 대개 "한 클래스에 트랜잭션 단위가 다른 두 책임이 들어 있다"는 신호다. 자기 주입은 **프록시 문제만 가리고 그 신호는 무시한다.**

**③ 읽는 사람이 이유를 알 수 없다.** `self.processOne()`은 `this.processOne()`과 동작이 다른데 코드만 봐서는 왜 다른지 알 수 없다. 프록시 구조를 아는 사람에게만 읽히는 코드가 된다.

**쓸 자리**: 분리할 만한 응집된 책임이 정말 안 보일 때, 그리고 그 이유를 주석으로 남길 때의 차선책이다.

### 3-3. `TransactionTemplate` (프로그래밍 방식)

애너테이션(선언적 방식)을 포기하고 트랜잭션 경계를 코드로 직접 긋는다. 프록시에 의존하지 않으므로 자기 호출 문제가 **원천적으로 존재하지 않는다.**

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final TransactionTemplate transactionTemplate;

    public void processAll(List<OrderRequest> requests) {
        for (OrderRequest request : requests) {
            // 이 람다의 시작과 끝이 곧 트랜잭션 경계다. 프록시가 개입하지 않는다.
            transactionTemplate.executeWithoutResult(status -> processOne(request));
        }
    }

    // 더 이상 @Transactional이 필요 없고, private이어도 된다.
    private void processOne(OrderRequest request) { /* ... */ }
}
```

**대가 세 가지.**

**① 선언적 트랜잭션의 이점을 포기한다.** 선언적 방식의 값은 "비즈니스 코드에 인프라 코드가 섞이지 않는다"는 것이었다(10번 문서 1-1절). `TransactionTemplate`은 그 이점을 되돌린다 — 트랜잭션 관리 코드가 다시 서비스 안으로 들어온다.

**② 트랜잭션 속성을 바꾸려면 인스턴스가 늘어난다.** `TransactionTemplate`은 스레드 안전하지만 **속성(격리 수준, timeout, 전파, readOnly)이 인스턴스에 고정된다.** 읽기 전용과 쓰기, 서로 다른 timeout이 필요하면 템플릿 빈을 여러 개 만들어 주입받아야 한다.

**③ 롤백 제어 방식이 달라진다.** 람다 안에서 unchecked 예외를 던지면 롤백되지만, checked 예외는 `Consumer` 시그니처상 던질 수 없다. 예외를 잡아 처리하면서 롤백은 시키려면 `status.setRollbackOnly()`를 **직접 호출해야** 한다 — 잊기 쉬운 지점이다.

**쓸 자리**: "반복문 안에서 건별 트랜잭션"처럼 **경계를 세밀하게 제어하는 것이 목적 그 자체일 때**는 오히려 이쪽이 의도를 가장 정확히 드러낸다. 트랜잭션이 어디서 시작해 어디서 끝나는지가 코드에 그대로 보이기 때문이다.

### 3-4. `AopContext.currentProxy()` (마지막 수단)

현재 스레드에 노출된 프록시를 꺼내 호출한다.

```java
// 전제 설정 — 이게 없으면 아래 호출이 IllegalStateException으로 죽는다
@EnableAspectJAutoProxy(exposeProxy = true)
```

```java
public void processAll(List<OrderRequest> requests) {
    OrderService proxy = (OrderService) AopContext.currentProxy();
    for (OrderRequest request : requests) {
        proxy.processOne(request);
    }
}
```

**대가 세 가지.**

**① 전역 설정을 켜야 한다.** `exposeProxy = true`는 이 클래스만이 아니라 **애플리케이션의 모든 프록시 호출**에 적용된다. 프록시를 통과할 때마다 `ThreadLocal`에 프록시를 넣고 빼는 작업이 추가되므로, **메서드 하나를 구제하려고 전체에 비용을 얹는** 구조다.

**② 코드가 스프링 AOP에 묶인다.** 비즈니스 로직이 "나는 프록시로 감싸져 있다"는 인프라 사실을 알게 된다. 침투성이 네 방법 중 가장 나쁘고, 순수 단위 테스트에서는 `AopContext`가 비어 있어 그대로 실패한다.

**③ 실패가 런타임에만 드러난다.** `exposeProxy` 설정을 누군가 지우면 컴파일은 통과하고 **실행 시점에 `IllegalStateException`**이 난다. 캐스팅 대상 타입도 컴파일러가 검증해주지 않는다.

**쓸 자리**: 레거시라 클래스 분리가 당장 불가능한 경우의 응급 처치. 면접에서는 **"방법은 알지만 권장하지 않는다"**고 답하는 것이 정답이다.

(가산점 포인트: AspectJ 위빙으로 전환하면 프록시 자체가 사라져 자기 호출 제약이 없어진다. 다만 전용 컴파일러나 로드 타임 위빙 에이전트가 필요해 **빌드·실행 파이프라인 복잡도가 크게 올라가므로, 이 문제 하나를 풀자고 도입하는 것은 명백한 과잉**이라는 판단까지 붙여야 한다.)

### 3-5. 정리 — 그리고 왜 빈 분리가 정석인가

| 해법 | 프록시 경유 | 주된 대가 | 어울리는 자리 |
|---|---|---|---|
| 별도 빈 분리 | ○ | 클래스가 늘고 책임을 나눠야 함 | 기본값. 대부분의 경우 |
| 자기 주입 | ○ | 순환 참조·`@Lazy` 필요, 설계 신호 은폐 | 분리할 응집 단위가 정말 없을 때 |
| `TransactionTemplate` | 불필요 | 선언적 방식 포기, 속성별 인스턴스 필요 | 경계 제어가 목적 그 자체일 때 |
| `AopContext` | ○ | 전역 `exposeProxy` 설정, 스프링 결합 | 레거시 응급 처치 |

여기서 한 걸음 더 나가면 이 질문의 진짜 답이 나온다. **빈 분리가 정석인 이유는 "프록시를 다시 통과하니까"가 아니다.**

`@Transactional`은 "여기부터 여기까지가 전부 성공하거나 전부 없던 일이 된다"는 **원자성 단위의 선언**이다. 그리고 원자성 단위는 아무렇게나 정해지는 것이 아니라 **"이 작업은 하나의 의미 있는 행위인가"**라는 도메인 판단에서 나온다. 즉 **트랜잭션 경계는 곧 설계 경계**다.

그렇다면 "한 클래스 안에서 자기 호출로 트랜잭션을 나누고 싶다"는 욕구가 발생했다는 것은 무슨 뜻인가. **그 클래스 안에 서로 다른 원자성 단위를 갖는 두 개의 작업이 들어 있다**는 뜻이다. 위 예시라면 "여러 건을 순회하며 지휘하는 책임"과 "한 건을 원자적으로 처리하는 책임" — 트랜잭션 경계가 다르니 책임도 다르다.

**즉 자기 호출 문제는 프록시가 만들어낸 인위적 제약이 아니라, 이미 존재하던 설계 문제를 프록시가 드러낸 것에 가깝다.** 빈 분리는 문제와 설계를 동시에 고치는 유일한 해법이고, 나머지 셋은 프록시 문제만 우회하며 설계 신호는 그대로 남겨둔다.

이 관점을 말할 수 있으면 "함정을 아는 사람"이 아니라 "경계를 설계하는 사람"으로 보인다.

## 4. 꼬리질문 대비 포인트

### "왜 CGLIB은 상속인데 `this.method()` 호출이 프록시 쪽으로 안 가나요?"

**스프링의 CGLIB 프록시가 `super` 호출 방식이 아니라 별도 원본 인스턴스에 위임하는 구조이기 때문이다.**

상속은 "같은 타입인 척"하기 위한 수단일 뿐이다. 만약 프록시가 `super.method()`를 부르는 구조였다면 실행 주체가 프록시 인스턴스 하나뿐이라 `this`가 곧 프록시가 되고 자기 호출도 걸렸을 것이다. 하지만 스프링은 프록시와 원본을 **메모리에 따로 존재하는 두 인스턴스**로 두고, 프록시가 원본에 위임한 순간부터 실행 주체가 원본이 되므로 동적 디스패치가 개입할 여지가 없다.

방증을 하나 붙이면 좋다 — 디버거로 프록시 객체의 필드를 보면 전부 `null`인 경우가 있다. 의존성 주입은 원본에 일어나기 때문이고, 이것 자체가 두 객체가 별개라는 증거다. 원리 상세는 [10번 문서](10-aop-jdk-dynamic-proxy-vs-cglib.md)에 있다.

### "별도 빈 분리와 자기 주입 중 무엇을 택하겠나요? 기준은?" (시니어 변별 포인트)

**기본은 빈 분리이고, 근거를 프록시가 아니라 설계에서 가져와야 한다.**

`@Transactional`이 긋는 것은 원자성 단위의 경계이고, 원자성 단위는 도메인 판단에서 나온다. 즉 **트랜잭션 경계는 곧 설계 경계**다. 그러므로 "자기 호출로 트랜잭션을 나누고 싶다"는 욕구가 생겼다는 것은 **한 클래스에 트랜잭션 단위가 다른 두 책임이 들어 있다는 신호**다. 빈 분리는 프록시 문제와 설계 문제를 동시에 고친다.

자기 주입은 **프록시 문제만 가리고 설계 신호는 무시하는 방법**이고, 대가도 실재한다 — 생성자 주입으로는 순환 참조라 아예 실패하고, 필드 주입은 부트 2.6 이후 순환 참조 기본 금지 때문에 `@Lazy` 같은 우회가 필요하다. **우회 장치가 필요하다는 것 자체가 구조가 부자연스럽다는 신호**로 읽는 것이 맞다.

다만 "무조건 분리"로 답하면 도구를 모르는 것처럼 보인다. **"반복문 안 건별 트랜잭션"처럼 경계 제어 자체가 목적이면 `TransactionTemplate`이 의도를 가장 잘 드러낸다**는 예외까지 말하면, 상황별로 도구를 고르는 기준을 가진 사람으로 보인다.

### "`processAll`에도 `@Transactional`이 붙어 있었다면 어떻게 되나요?"

**"트랜잭션이 아예 없는 것"과 "속성이 무시된 채 바깥에 합류하는 것"을 구분해서 답해야 정확하다.**

`processAll()`이 프록시를 통해 호출됐다면 트랜잭션은 **존재한다.** 내부의 `this.processOne()`은 여전히 프록시를 안 거치므로, `processOne()`의 `@Transactional` **속성만 전부 무시**되고 그냥 바깥 트랜잭션 안에서 평범한 메서드로 실행된다.

이 상황이 특히 위험한 이유가 있다. **건별 커밋을 의도해 `processOne()`에 `REQUIRES_NEW`를 붙였는데 전체가 한 트랜잭션으로 묶이는** 사고가 이 유형이다. 1,000건을 처리하는 배치라면 999번째에서 실패했을 때 앞의 998건이 전부 함께 롤백된다.

진단할 때도 함정이 하나 더 있다. `isActualTransactionActive()`는 이 경우 `true`를 돌려주므로 문제를 놓친다. **`getCurrentTransactionName()`을 봐야** 트랜잭션을 연 것이 `processAll`이라는 사실이 드러난다(2-3절). 전파 옵션 자체는 [12번 문서](12-transaction-propagation-required-vs-requires-new.md)에서 다룬다.

### "이 함정은 `@Transactional`만의 문제인가요?"

**아니다. 프록시 기반 부가 기능 전부가 같은 구조다.** 개별 애너테이션의 버그가 아니라 **프록시 방식의 공통 제약**으로 묶어 설명하면 원리를 이해하고 있다는 신호가 된다.

- **`@Async`**: 자기 호출 시 별도 스레드로 넘어가지 않고 **호출한 스레드에서 동기로 실행**된다. `Future`를 받아 쓰고 있었다면 결과는 정상이고 응답 시간만 느려지므로, 성능 문제로만 보여 원인을 찾기 어렵다. 상세는 [15번 문서](15-async-annotation.md).
- **`@Cacheable`**: 자기 호출 시 캐시를 조회하지도 저장하지도 않고 **매번 원본 메서드를 실행**한다. 결과값은 언제나 정확하므로 기능 테스트는 전부 통과하고, **캐시 적중률이 0%인 채로 DB 부하만 늘어난다.** 상세는 [20번 문서](20-spring-cache-cacheable.md).
- **`@PreAuthorize` 등 메서드 보안**: 자기 호출 시 권한 검사가 건너뛰어진다. 이쪽은 성격이 정합성이 아니라 **보안 취약점**이다.

세 사례를 관통하는 공통점을 말하면 답이 완성된다. **전부 예외 없이 조용히 실패하고, 증상이 각기 다른 팀(정합성/성능/보안)의 문제로 보여 원인이 하나라는 사실이 잘 드러나지 않는다.**

### "트랜잭션이 실제로 적용됐는지 런타임에 어떻게 확인하나요?"

**수단을 갖고 있는지를 보는 질문이므로, 절차로 답한다.**

**① 그 지점에 트랜잭션이 있는가**: `TransactionSynchronizationManager.isActualTransactionActive()`가 가장 직접적이다.

**② 누가 그 트랜잭션을 열었는가**: `TransactionSynchronizationManager.getCurrentTransactionName()`이 `com.example.OrderService.processOne` 형태로 알려준다. 바깥에도 `@Transactional`이 있는 경우 ①만으로는 문제를 놓치므로 이쪽이 결정적이다.

**③ 코드를 안 건드리고 보려면**: `org.springframework.transaction.interceptor` 로거를 TRACE로 올린다. `Getting transaction for [...]` / `Completing transaction for [...]` 로그로 **어느 메서드에 트랜잭션이 열렸는지가 그대로 찍힌다.** 기대한 메서드 이름이 없으면 적용되지 않은 것이다.

**④ 프록시 자체가 만들어졌는가**: 주입받은 참조에 `AopUtils.isAopProxy()`를 건다. `final` 클래스 때문에 프록시 생성이 실패한 경우까지 걸러낸다. 단, 원본 메서드 안에서 `AopUtils.isAopProxy(this)`는 언제나 `false`라는 점에 주의한다 — 그 자리의 `this`는 원본이기 때문이고, 이건 버그가 아니라 이 문서의 주제 그 자체다.

**⑤ 회귀 방지**: 실패 경로에서 롤백되는지를 검증하는 테스트로 못 박는다. 정상 경로 테스트로는 이 버그가 절대 안 잡힌다.

"붙였으니 되겠지"가 아니라 **적용 여부를 검증하는 절차를 갖고 있는가**를 보는 질문이라는 점을 의식하고 답하면 좋다.

---

## 한 줄 요약

트랜잭션 코드는 프록시에만 있는데 `this.method()`는 프록시를 우회해 원본을 직접 부르므로 `@Transactional`이 **에러 없이 조용히** 무시되고 — 리포지토리 호출이 건건이 커밋되거나 변경 감지 UPDATE가 아예 나가지 않아 몇 주 뒤 정산 불일치로 발견되는 유형이라 `isActualTransactionActive()`·`getCurrentTransactionName()`·트랜잭션 TRACE 로그로 **적용 여부를 검증하는 절차**를 갖춰야 하고, 해법 넷 중 별도 빈 분리가 정석인 이유는 프록시를 다시 통과해서가 아니라 **트랜잭션 경계가 곧 설계 경계이며 자기 호출로 트랜잭션을 나누고 싶다는 욕구 자체가 "이 메서드는 다른 책임이다"라는 신호**이기 때문이다.
