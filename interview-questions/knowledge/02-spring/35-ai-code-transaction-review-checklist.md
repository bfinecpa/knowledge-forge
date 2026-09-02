# AI 생성 코드의 트랜잭션 리뷰 체크리스트 — 결함은 문법이 아니라 경계에 숨는다

> 핵심 관전 포인트: **AI가 생성한 서비스 코드의 트랜잭션 결함은 컴파일·테스트·단건 실행이라는 세 관문을 전부 통과하고 런타임에도 침묵하므로, 리뷰가 감이 아니라 절차여야 한다. 내 체크리스트는 넷이고 각각 코드에서 **눈으로 찾는 대상이 정해져 있다** — ① **경계 위치**: `@Transactional` 없이 리포지토리 쓰기를 두 번 이상 하는 메서드(부분 커밋), 반대로 `@Transactional` 안의 HTTP 클라이언트·메시지 발행·`Thread.sleep`·대량 반복문(커넥션 점유 → 풀 고갈), ② **자기 호출**: 같은 클래스 안에서 호출되는 `@Transactional` 메서드(프록시를 우회해 조용히 트랜잭션 없이 실행), ③ **예외 삼킴**: 재던지기 없는 `catch`(반쯤 커밋)와 rollback-only 낙인 충돌(`UnexpectedRollbackException`), 그리고 `throws` 선언된 checked 예외(기본 롤백 대상이 아니다), ④ **readOnly**: 조회 누락은 성능 낭비지만 쓰기 메서드 오적용은 **변경이 에러 없이 사라지는** 사고다. 그리고 이 넷은 전부 테스트로 못 잡는데 — 단위 테스트는 프록시를 안 거치고, 통합 테스트는 정상 경로만 돌며, 결정적으로 `@Transactional`을 붙인 롤백 테스트는 **커밋 경계 자체를 관찰 불가능하게 만들어** 네 결함을 모두 가려버린다. 자동화할 수 있는 것(가시성 규칙, 계층 금지, 트랜잭션 안 외부 호출 탐지)은 CI에 박고, 사람은 "이 경계가 비즈니스적으로 맞는가"에 집중한다.**

---

## 0. 질문 + 의도

**질문**: "AI가 생성한 서비스 코드를 트랜잭션 관점에서 리뷰할 때의 체크리스트는? (경계 위치, 자기 호출, 예외 삼킴, readOnly 여부)"

**출제 의도**: AI 산출물 검증 능력의 스프링 판. AI가 짠 서비스 코드의 결함은 문법이 아니라 트랜잭션 경계(자기 호출로 미적용, 경계 안 외부 호출, 삼켜진 예외로 인한 롤백 누락)에 숨는다. 검증 항목을 체크리스트로 언어화해둔 사람인지 — 리뷰가 감이 아니라 절차인지 확인한다.

## 1. 이 문서의 성격 — 원리가 아니라 절차를 준다

### 1-1. 앞의 트랜잭션 문서들을 리뷰어의 눈으로 다시 꿰는 자리

이 장의 다른 문서들은 **원리를 설명한다.** `07-transactional-default-behavior-rollback.md`는 프록시 경계에서 커밋·롤백이 결정되는 구조를, `11-transactional-self-invocation.md`는 `this`가 프록시가 아닌 이유를, `13-transactional-readonly-optimization.md`는 readOnly가 꺼 주는 기계장치를, `22-external-api-call-inside-transaction.md`는 커넥션 점유가 장애로 번지는 경로를 다룬다.

**이 문서는 절차를 준다.** 원리를 이미 안다고 전제하고, **"남의 코드를 열었을 때 무엇부터 어떤 순서로 눈을 두는가"**만 다룬다. 그래서 각 항목은 "경계 위치를 본다" 같은 추상적 지시가 아니라 **검색 가능한 형태**여야 한다 — "`@Transactional` 메서드 본문에서 `restClient`/`webClient`/`restTemplate` 호출, 외부 SDK 호출, `Thread.sleep`, 큰 반복문을 찾는다"처럼.

리뷰 체크리스트의 품질은 **"그 항목을 읽고 바로 코드에서 뭘 찾아야 할지 아는가"**로 판가름난다. 이 기준으로 4항목을 다시 쓴 것이 2절이다.

### 1-2. 왜 트랜잭션이 최우선 관문인가 — 세 관문을 전부 통과한다

AI 생성 코드의 특징은 "그럴듯함"이다. 네이밍이 깔끔하고, 계층 분리가 교과서적이고, 예외 처리도 친절하게 감싸져 있다. 문법 오류나 명백한 로직 버그는 컴파일러와 테스트가 잡아준다.

문제는 트랜잭션 결함이 **그 어떤 자동 관문에도 걸리지 않는다**는 점이다.

| 관문 | 왜 못 잡는가 |
|---|---|
| 컴파일러 | 자기 호출이든 readOnly 오적용이든 **문법상 완벽하다.** 애너테이션은 타입 검사 대상이 아니다 |
| 테스트 | 1-3에서 항목별로 자세히 — 특히 `@Transactional` 롤백 테스트가 결함을 **덮어버린다** |
| 런타임 | 자기 호출은 에러 없이 트랜잭션 없이 돌고, 삼켜진 예외는 반쯤 커밋된 데이터만 남기고, readOnly 오적용은 변경을 조용히 버린다 |

증상이 나타나는 시점이 **몇 주 뒤 "데이터가 이상해요"라는 CS 티켓**이라는 것이 이 결함군의 공통 성질이다. 그때는 이미 잘못된 데이터가 쌓인 뒤라 코드 수정 외에 **데이터 보정 작업**까지 따라붙는다. 리뷰 단계의 5분이 나중의 며칠을 대신한다.

### 1-3. 테스트가 왜 못 잡는가 — 항목별로 짚는다

"테스트가 못 잡는다"는 말을 뭉뚱그리면 안 된다. 테스트 종류마다 못 잡는 이유가 다르고, 그 이유를 알아야 **어떤 테스트를 어떻게 써야 잡히는지**가 나온다.

**단위 테스트: 프록시를 안 거친다.** `@Transactional`은 그 메서드를 특별하게 만드는 것이 아니라, **스프링이 그 빈을 감싸 만든 프록시가 호출을 먼저 받아** 트랜잭션을 열고 닫는 구조다(원리는 07번 문서). 그런데 단위 테스트는 `new OrderService(mockRepository)`로 원본 객체를 직접 만든다. **프록시가 아예 없다.** 그러니 `@Transactional`은 주석과 다를 바 없는 문자열이고, 자기 호출과 외부 호출이 코드상 구분되지 않는다. **자기 호출 결함은 단위 테스트에서 원리적으로 관찰 불가능하다.**

**통합 테스트: 단일 스레드로 정상 경로만 돈다.** 스프링 컨텍스트를 띄우는 통합 테스트는 프록시를 거치지만, 대개 요청 하나를 성공 경로로 태워 결과를 확인한다. 예외 삼킴은 **예외가 나야** 드러나고, 커넥션풀 고갈은 **동시 요청이 몰려야** 드러난다. 둘 다 그 테스트에 없는 조건이다.

**그리고 가장 중요한 것 — `@Transactional`을 붙인 테스트는 결함을 덮어버린다.**

스프링 테스트에서 `@Transactional`을 붙이면 테스트 메서드마다 트랜잭션을 열고 **끝날 때 롤백**해 DB를 원상 복구한다. 편해서 거의 관성적으로 붙이는데, 이 편리함의 대가가 정확히 이 문서의 4항목이다.

```text
[프로덕션]                              [@Transactional 테스트]
요청 스레드                              테스트 메서드
  │                                        │ 테스트가 물리 트랜잭션을 먼저 연다  ★
  ├─ 서비스 @Transactional                 ├─ 서비스 @Transactional
  │    → 여기서 물리 트랜잭션 시작          │    → 새로 열지 않고 테스트 것에 "합류"만 한다
  │    → 메서드 끝에서 실제 COMMIT          │    → 메서드 끝에 실제 COMMIT 이 없다
  ▼                                        ▼
DB에 남는 것으로 결과가 확정된다          테스트 끝 → 전부 ROLLBACK, 아무것도 안 남는다
```

★ 표시한 한 줄이 모든 것을 바꾼다. **테스트가 물리 트랜잭션을 먼저 열어버리면, 서비스의 트랜잭션 선언은 "새로 여는 것"이 아니라 "합류하는 것"이 된다.** 커밋 경계에서 벌어지는 일이 전부 테스트 트랜잭션 뒤로 숨는다. 항목별로 어떻게 가려지는지 보자.

**① 경계 위치가 가려진다.** `@Transactional`이 없어 `save()`마다 따로 커밋되는 결함은 **커밋 경계에 관한 사실**이다. 그런데 테스트 트랜잭션 안에서는 리포지토리의 `save()`도 그 트랜잭션에 합류하므로 따로 커밋되지 않는다. 결정적으로 **트랜잭션 안에서는 커밋 여부와 무관하게 모든 쓰기가 보인다.** 그러니 "중간에 실패했을 때 앞의 쓰기가 DB에 남는가"라는 질문 자체를 테스트가 관찰할 수 없다. 프로덕션에서는 남고 테스트에서는 안 남는데, 테스트 안에서 보이는 값은 양쪽이 같다.

**② 자기 호출이 가려진다.** 이쪽이 가장 고약하다. `this.settleOne(id)`는 프록시를 우회하므로 프로덕션에서는 **트랜잭션 없이** 실행된다. 그런데 테스트가 이미 트랜잭션을 열어놨으므로, 테스트 안에서 `settleOne`은 **트랜잭션 안에서 실행된다.** `TransactionSynchronizationManager.isActualTransactionActive()`를 찍어봐도 `true`가 나온다. **결함이 존재하지 않는 것처럼 보인다.**

**③ 예외 삼킴이 가려진다.** `UnexpectedRollbackException`은 **바깥 물리 트랜잭션이 커밋을 시도하는 순간** 터진다(07번 문서 3절). `@Transactional` 테스트에서 바깥 물리 트랜잭션은 테스트의 것이고, 그것은 커밋되지 않고 롤백된다. **커밋 시도가 없으니 예외도 영원히 안 난다.** "반쯤 커밋" 역시 커밋 경계 사실이라 같은 이유로 관찰 불가다.

**④ readOnly 오적용이 가려진다.** 여기엔 이유가 둘이나 겹친다. 첫째, `readOnly` 여부는 **트랜잭션을 시작한 바깥이 정하고 합류하는 안쪽 선언은 무시된다**(13번 문서 3-3). 테스트 트랜잭션이 읽기·쓰기이므로 서비스의 `readOnly = true`는 그냥 무시되고, 플러시 모드가 MANUAL이 되지 않아 **변경 감지가 정상 동작한다.** 둘째, 설령 플러시가 안 됐더라도 검증 코드가 같은 영속성 컨텍스트에서 엔티티를 읽으므로 **메모리상 바뀐 값이 그대로 보인다.** 두 겹으로 가려져 있어 이 결함은 롤백 테스트로 잡을 방법이 없다.

**그래서 어떻게 하는가.** 커밋 경계를 확인해야 하는 테스트는 `@Transactional`을 붙이지 않는다. DB 정리는 롤백에 맡기지 말고 명시적으로 한다.

```java
// before: 편하지만 4항목을 전부 가려버리는 테스트
@SpringBootTest
@Transactional                       // 테스트가 물리 트랜잭션을 먼저 연다 = 커밋 경계가 사라진다
class OrderServiceTest { ... }
```

```java
// after: 실제로 커밋시키고, 정리는 명시적으로 한다
@SpringBootTest                      // @Transactional 을 붙이지 않는다
class OrderServiceTest {

    @Autowired OrderService orderService;
    @Autowired JdbcTemplate jdbc;

    @AfterEach
    void cleanUp() {
        // 롤백이 안 해 주므로 직접 지운다. FK 순서를 신경 쓰기 싫으면 CASCADE 로 한 번에.
        jdbc.execute("TRUNCATE orders, deliveries, point_ledger RESTART IDENTITY CASCADE");
    }

    @Test
    void 포인트가_모자라면_주문도_남지_않아야_한다() {
        assertThatThrownBy(() -> orderService.placeOrder(포인트부족요청()))
                .isInstanceOf(NotEnoughPointException.class);

        // 이 단언은 "실제로 커밋된 것이 무엇인가"를 묻는다.
        // @Transactional 이 빠져 있어 주문만 따로 커밋됐다면 여기서 1이 나와 테스트가 깨진다.
        assertThat(countRows("orders")).isZero();
    }
}
```

경계를 더 정밀하게 다뤄야 하면 `TestTransaction`(`flagForCommit()`, `end()`, `start()`)으로 테스트 안에서 커밋 시점을 직접 만들거나, 클래스에 `@Transactional`을 두되 특정 테스트만 `@Commit`으로 뒤집는 방법도 있다.

정리하면 이렇다. **`@Transactional` 테스트는 "데이터가 어떻게 보이는가"를 검증할 때는 유용하지만, "무엇이 커밋되는가"를 검증할 때는 쓸 수 없다.** 그리고 이 문서의 4항목은 전부 후자에 속한다.

### 1-4. AI 코드에서 반복적으로 나타나는 네 가지 형태

무엇을 찾아야 하는지 알려면 **어떤 모양으로 나오는지**를 먼저 알아야 한다. 학습 데이터에 있는 예제 코드가 대체로 단건 성공 경로 중심이라, 예제에서는 문제가 안 되던 패턴이 그대로 재생산된다.

**① 서비스 메서드 하나에 전부 넣기.** 결제 호출, 주문 저장, 재고 차감, 알림 발송이 한 메서드 안에 순서대로 늘어서고 그 위에 `@Transactional`이 하나 붙는다. 읽기에 자연스럽고 "유스케이스 = 메서드 하나"라는 원칙에도 맞아 보이는데, 그 안에 외부 호출이 섞여 있으면 경계가 통째로 잘못된 것이다. → 체크 ①

**② `try-catch`로 감싸 로그만 찍고 계속 진행하기.** AI는 "친절한" 코드를 좋아한다. 위험해 보이는 구간마다 `try-catch`를 두고 `log.error`를 남기고 넘어간다. 프록시는 예외를 본 적이 없으니 정상 커밋으로 처리한다. → 체크 ③

**③ 조회 메서드를 복붙해 쓰기 메서드 만들기.** `getUser`를 복사해 `updateUser`를 만들면서 `@Transactional(readOnly = true)`가 딸려 온다. → 체크 ④

**④ 같은 클래스 안에서 헬퍼 메서드 호출하기.** "루프를 도는 public 메서드 + 건별 처리 `@Transactional` 메서드"를 한 클래스에 넣는 패턴이 특히 흔하다. 겉보기엔 오히려 잘 설계된 것처럼 보여서 더 위험하다. → 체크 ②

## 2. 체크리스트 4항목 — 코드에서 무엇을 눈으로 찾는가

각 항목을 **찾는 대상 → AI가 실제로 만드는 결함 코드 → 고침 → 테스트가 못 잡는 이유** 순서로 정리한다.

### 체크 ① 경계 위치 — 트랜잭션이 "없거나" "너무 넓거나"

두 방향을 다 본다. 하나의 유스케이스에 속한 쓰기 여러 건이 **한 경계로 묶여 있는가**, 그리고 그 경계 안에 **DB 작업이 아닌 것이 섞여 있지 않은가**.

**찾는 대상 (A: 경계가 없다)**

- 서비스 클래스의 public 메서드 중 **리포지토리 쓰기 호출(`save`/`saveAll`/`delete`/`@Modifying` 쿼리)이 두 번 이상**인데 `@Transactional`이 없는 것
- 엔티티의 상태 변경 메서드(`order.markPaid()` 같은 것)를 호출하면서 `@Transactional`이 없는 것 — 이쪽은 증상이 더 나쁘다(아래에서 설명)

**찾는 대상 (B: 경계가 너무 넓다)**

`@Transactional` 메서드 본문에서 이 문자열들을 찾는다. 눈으로 훑기보다 기계로 후보를 좁히는 편이 빠르다.

```bash
# @Transactional 이 있는 파일만 골라, 그 안의 "DB 작업이 아닌 것" 후보를 뽑는다
rg -l '@Transactional' --type java src/main/java \
  | xargs rg -n 'restTemplate\.|restClient\.|webClient\.|Feign|kafkaTemplate\.|rabbitTemplate\.|s3Client\.|mailSender\.|Thread\.sleep|Files\.'
```

여기에 걸린 줄이 정말 `@Transactional` 메서드 **안쪽**인지는 사람이 확인한다. 기계는 후보를 좁히는 데까지만 쓴다.

**결함 A — 경계가 없어서 쓰기가 쪼개진다.**

AI는 서비스 메서드에 `@Transactional`을 빠뜨리는 경우가 흔한데, 이때 코드는 죽지 않는다. Spring Data JPA의 `SimpleJpaRepository`가 클래스 레벨에 `@Transactional(readOnly = true)`를, `save`/`delete`에 `@Transactional`을 달고 있어서 **`save()` 자체가 트랜잭션을 각자 연다.** 즉 "트랜잭션이 없는" 게 아니라 **"쓰기마다 따로따로 커밋되는"** 상태가 된다.

```java
// before: AI 생성 코드 — 애너테이션이 없어 각 save() 가 독립 트랜잭션이다
public Order placeOrder(OrderRequest request) {
    Order order = orderRepository.save(createOrder(request));   // ① 여기서 이미 커밋 확정
    pointService.deduct(request.userId(), request.usedPoint()); // ② 잔액 부족으로 예외
    deliveryRepository.save(createDelivery(order));             // ③ 도달하지 못한다
    return order;
    // 남는 것: 주문은 있는데 포인트는 안 깎였고 배송 정보도 없다.
    // 롤백할 대상이 없다 — ①은 이미 커밋된 별개의 트랜잭션이기 때문이다.
}
```

```java
// after: 유스케이스 단위로 하나의 경계
@Transactional
public Order placeOrder(OrderRequest request) {
    Order order = orderRepository.save(createOrder(request));
    pointService.deduct(request.userId(), request.usedPoint());  // REQUIRED 로 이 트랜잭션에 합류
    deliveryRepository.save(createDelivery(order));
    return order;   // 셋 다 커밋되거나, 셋 다 롤백되거나
}
```

**같은 결함의 더 조용한 형태가 하나 더 있다.** 쓰기가 `save()` 호출이 아니라 **엔티티 필드 변경(변경 감지)**일 때다.

```java
// before: @Transactional 없이 엔티티를 수정한다 — SQL 이 아예 안 나간다
public void markPaid(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.markPaid();     // 자바 객체의 필드만 바뀐다
    // UPDATE 가 나가지 않는다. 예외도 로그도 없다.
}
```

왜 아무 일도 안 일어나는가. 스프링 부트는 OSIV(`spring.jpa.open-in-view`)가 기본 켜짐이라 **영속성 컨텍스트는 요청이 끝날 때까지 열려 있다.** 그래서 `findById`도 되고 반환된 엔티티도 영속 상태다. 그런데 **변경 감지가 SQL로 나가는 시점은 트랜잭션 커밋 순간**이다. 트랜잭션이 없으면 그 시점 자체가 오지 않으므로 UPDATE는 영영 만들어지지 않는다.

**결함 A가 `save()` 누락이면 "부분 커밋"이 남지만, 변경 감지 누락이면 "아무것도 안 남는다".** 후자가 더 늦게 발견된다 — 어긋난 데이터조차 없어서 대사 배치도 못 잡는다. 자세한 인과는 `11-transactional-self-invocation.md`의 2-1절에 있다.

**결함 B — 경계가 넓어서 커넥션을 문 채 딴짓한다.**

```java
// before: AI 생성 코드 — 결제 API 호출이 트랜잭션 안에 있다
@Transactional
public Order placeOrder(OrderRequest request) {
    PaymentResult result = paymentClient.pay(request);   // 외부 호출. 수 초가 걸릴 수 있다
    Order order = orderRepository.save(createOrder(request, result));
    notificationClient.sendKakao(order);                 // 이것도 외부 호출
    return order;
}
```

트랜잭션이 열려 있는 동안 DB 커넥션은 반납되지 않는다. **외부사 응답이 3초 늦어지면 커넥션 점유도 3초 늘어난다.** 커넥션풀은 보통 10~20개로 작기 때문에, 초당 수십 건이 들어오면 순식간에 바닥난다. 그다음은 톰캣 스레드가 커넥션을 기다리며 말라붙고, 헬스체크마저 커넥션을 못 얻어 실패하면서 **외부사 장애가 우리 전 서비스 장애로 번진다.** 이 연쇄를 Little's law로 초 단위까지 계산한 것이 `22-external-api-call-inside-transaction.md`의 2절이다.

```java
// after: DB 쓰기만 경계 안에, 외부 호출은 경계 밖으로
public Order placeOrder(OrderRequest request) {
    PaymentResult result = paymentClient.pay(request);        // 트랜잭션 밖. 선행 조건이므로 앞으로 뺀다
    Order order = orderTxService.saveOrder(request, result);  // 짧은 트랜잭션 (별도 빈 — 체크 ② 참고)
    // 알림은 커밋 이후에만 나가야 한다. 롤백됐는데 "주문 완료" 알림이 가면 안 되기 때문이다.
    eventPublisher.publishEvent(new OrderPlaced(order.getId()));  // AFTER_COMMIT 리스너가 받는다
    return order;
}
```

**쪼개기만 하면 끝이 아니다.** 결제는 승인됐는데 주문 저장이 실패하면 "돈은 나갔는데 주문이 없는" 상태가 남는다. 리뷰에서 여기까지 확인해야 한다 — **중간 상태(`PENDING`)와 복구 경로가 함께 설계돼 있는가.** 이 부분이 22번 문서 3-6절의 "after에도 남는 구멍"이다.

**곁가지 신호 하나**: 컨트롤러에 `@Transactional`이 붙어 있으면 같은 유형의 경계 오류다. 응답 직렬화와 뷰 렌더링까지 경계 안에 들어와 커넥션 점유 시간이 불필요하게 늘어난다.

**테스트가 못 잡는 이유**: 결함 A는 커밋 경계 사실이라 롤백 테스트로 관찰 불가하고(1-3의 ①), 결함 B는 **동시 요청이 몰려야** 풀 고갈이 드러나는데 통합 테스트는 대개 단일 스레드다. 정상 경로에서는 A도 B도 결과가 똑같이 나온다.

### 체크 ② 자기 호출 — 프록시를 우회하는 경로가 있는가

`@Transactional`은 빈을 감싼 프록시가 호출을 가로채는 방식이라, **같은 클래스 안에서 그 메서드를 부르면 프록시를 거치지 않고 원본이 직접 실행된다.** 트랜잭션 없이, 에러도 경고도 없이 돈다. `this`가 왜 프록시가 아닌지는 `11-transactional-self-invocation.md`의 1절이 한 단계씩 따라간다.

**찾는 대상**

1. 한 클래스 안에서 `@Transactional`(또는 `@Async`, `@Cacheable`, `@Retryable` — 전부 같은 프록시 원리다)이 붙은 메서드 이름을 **전부 수집**한다.
2. **같은 파일 안에서** 그 이름이 호출되는 곳이 있는지 역추적한다. `this.settleOne(id)`뿐 아니라 `this.`가 생략된 `settleOne(id)`도 같은 결함이다 — 오히려 이쪽이 더 흔하다.
3. `public`이 아닌 메서드에 붙은 `@Transactional`도 함께 본다. 스프링 AOP의 기본 프록시 방식에서는 무시된다.

`this.`가 생략된 형태 때문에 단순 grep으로는 놓치는 것이 많다. **이 항목이 정적 분석 도구가 필요한 대표 사례다**(3-2 참고).

```bash
# 1차 후보 — this. 를 명시한 호출만이라도 먼저 뽑는다
rg -n 'this\.\w+\(' --type java src/main/java
# 가시성 위반은 grep 으로도 확실히 잡힌다
rg -n -U -P '@Transactional[^\n]*\n\s*(private|protected)\s' --type java src/main/java
```

**AI가 만드는 결함 코드**

```java
// before: AI 생성 코드 — 겉보기엔 오히려 잘 설계된 것 같지만 settleOne 의 트랜잭션이 전부 무시된다
@Service
@RequiredArgsConstructor
public class SettlementService {

    private final SettlementRepository settlementRepository;

    public void settleAll(List<Long> ids) {
        for (Long id : ids) {
            settleOne(id);          // this. 가 생략됐을 뿐 자기 호출이다. 프록시를 거치지 않는다.
        }
    }

    @Transactional
    public void settleOne(Long id) {
        Settlement s = settlementRepository.findById(id).orElseThrow();
        s.confirm();                            // 변경 감지 — 커밋이 없으니 UPDATE 가 안 나간다
        settlementRepository.save(s.toHistory());
    }
}
```

증상이 둘로 갈린다는 점이 중요하다. `save()` 호출은 리포지토리 자체 트랜잭션으로 **커밋은 된다**(그래서 "아예 안 도는" 것처럼 보이지도 않는다). 반면 `s.confirm()` 같은 **변경 감지는 통째로 사라진다.** "이력은 쌓이는데 원본 상태가 안 바뀐다"는 기묘한 증상이 이 조합에서 나온다.

```java
// after: 건별 처리를 별도 빈으로 분리한다 — 호출이 프록시를 통과하게 만드는 것이 핵심
@Service
@RequiredArgsConstructor
public class SettlementService {

    private final SettlementProcessor processor;   // 다른 빈 = 주입된 참조는 프록시다

    public void settleAll(List<Long> ids) {
        for (Long id : ids) {
            processor.settleOne(id);   // 프록시를 거친다 → 건별로 트랜잭션이 열리고 닫힌다
        }
    }
}
```

빈 분리가 정석인 이유는 책임 분리 관점에서도 자연스럽기 때문이다 — **반복 오케스트레이션과 건별 처리는 원래 다른 일이다.** 자기 자신을 주입받는 self-injection이나 `AopContext.currentProxy()`도 동작은 하지만 설계 냄새가 있어 임시방편으로 본다(선택지별 대가는 11번 문서 3절).

**테스트가 못 잡는 이유**: 단위 테스트에는 프록시가 없어 자기 호출과 외부 호출이 **코드상 구분되지 않는다.** 통합 테스트에 `@Transactional`을 붙이면 테스트 트랜잭션이 이미 열려 있어 `settleOne`이 트랜잭션 안에서 도는 것처럼 보인다. **결함이 존재하지 않는 것처럼 관찰된다는 점에서 이 항목이 가장 위험하다.**

### 체크 ③ 예외 삼킴 — catch가 롤백을 무산시키는가

프록시의 롤백 판단은 **예외가 메서드 밖(프록시 경계)까지 나왔는지**로 이루어진다. 안에서 잡아버리면 프록시는 예외를 본 적이 없으므로 그때까지의 쓰기를 **정상 커밋**한다.

**찾는 대상**

1. `@Transactional` 메서드 본문의 **모든 `catch` 블록**. 각각에 대해 "이 catch 이후에도 커밋되는 게 맞는가"를 자문한다. 답이 "아니오"인데 재던지기(rethrow)가 없으면 결함이다.
2. **`throws`로 checked 예외를 선언한 `@Transactional` 메서드.** 기본 롤백 대상은 unchecked 예외뿐이라 checked 예외는 던져져도 커밋된다.
3. `catch (Exception e)`처럼 **범위가 넓은 catch**. 의도한 것 말고도 다 잡힌다.

```bash
# @Transactional 이 있는 파일의 모든 catch 블록을 뒤 4줄까지 함께 본다
rg -l '@Transactional' --type java src/main/java | xargs rg -n -A4 'catch\s*\('
# @Transactional 선언 바로 아래 메서드가 throws 를 달고 있는 조합 (rollbackFor 확인 대상)
rg -n -U -P '@Transactional(?![^\n]*rollbackFor)[^\n]*\n\s*(public|protected)[^\n]*\bthrows\b' --type java
```

**AI가 만드는 결함 코드**

```java
// before: AI 생성 코드 — 예외를 먹어서 "실패했는데 반쯤 커밋"이 된다
@Transactional
public void transfer(TransferRequest request) {
    accountRepository.withdraw(request.from(), request.amount());   // ① 출금
    try {
        accountRepository.deposit(request.to(), request.amount());  // ② 실패
    } catch (Exception e) {
        log.error("입금 실패", e);   // 예외가 프록시 밖으로 안 나간다 = 프록시는 정상 리턴으로 인식
    }
    // 남는 것: ①만 커밋. 돈이 빠져나가고 입금은 안 된 상태가 "정상 처리"로 기록된다.
}
```

```java
// after: 롤백돼야 할 실패는 예외를 경계 밖으로 내보낸다
@Transactional
public void transfer(TransferRequest request) {
    accountRepository.withdraw(request.from(), request.amount());
    accountRepository.deposit(request.to(), request.amount());
    // 로깅이나 변환이 필요하면 잡되 반드시 다시 던진다 — throw e 또는 도메인 예외로 감싸 던진다
}
```

**함께 보는 변종 ① — 내부 트랜잭션의 예외를 잡은 경우.**

잡은 예외가 **다른 빈의 `@Transactional`(전파 기본값 `REQUIRED`) 메서드**에서 나온 것이라면 상황이 다르다. 그쪽 프록시가 롤백을 시도했지만 물리 트랜잭션은 바깥 것이므로 취소할 수 없고, 대신 **공유 트랜잭션에 rollback-only 낙인을 찍어 둔다.** 겉의 `catch`는 예외를 지울 수 있어도 이 낙인은 지울 수 없다. 그래서 바깥이 정상 리턴해 커밋을 시도하는 순간 `UnexpectedRollbackException`이 터진다.

**"예외를 잡고 대체 로직을 태우는" AI 코드가 정확히 이 지점에서 500을 만든다.** 단계별로 무슨 일이 벌어지는지와 네 가지 설계 선택지는 07번 문서 3절에 있다.

**함께 보는 변종 ② — checked 예외 + `rollbackFor` 누락.**

기본 롤백 대상은 `RuntimeException`과 `Error`뿐이다. AI가 `throws SomeException`(checked)을 선언하고 `rollbackFor` 없이 던지게 짰다면 **예외는 났는데 커밋되는** 조합이 된다.

여기서 리뷰 절차가 스프링 버전에 따라 갈린다. **스프링 프레임워크 6.2부터 전역 스위치가 생겼다.**

```java
// 스프링 6.2+ — checked 예외까지 롤백 대상으로 삼도록 기본값 자체를 뒤집는다
@Configuration
@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)
public class TransactionConfig { }
```

`RollbackOn` 열거형은 `RUNTIME_EXCEPTIONS`(기본)와 `ALL_EXCEPTIONS` 둘뿐이고, 스프링 팀도 "EJB식 비즈니스 예외 커밋 동작에 의존하는 것이 아니라면 `ALL_EXCEPTIONS`를 권한다"고 문서에 적어 두었다.

**이게 리뷰 절차를 바꾼다.** 프로젝트가 6.2 이상이고 이 스위치가 켜져 있다면, 애너테이션마다 `rollbackFor`를 확인하는 작업은 **불필요해진다.** 대신 리뷰어가 확인할 것이 하나로 줄어든다 — **"우리 프로젝트에 이 전역 설정이 있는가"를 한 번 확인하고, 그 답에 따라 이 하위 체크를 켜거나 끈다.** 개별 코드 리뷰 항목이 프로젝트 설정 확인 한 번으로 대체되는 구조라 실무적으로 값이 크다. 6.2 미만이거나 스위치가 꺼져 있다면 기존대로 **`throws`가 보이면 반사적으로 `rollbackFor`를 확인**한다.

**테스트가 못 잡는 이유**: 예외 삼킴은 **예외가 나야** 드러나는데 통합 테스트는 대개 정상 경로만 돈다. 실패 경로 테스트를 짰더라도 `@Transactional` 테스트라면 바깥 물리 트랜잭션이 커밋을 시도하지 않으므로 `UnexpectedRollbackException`이 **원리적으로 발생할 수 없고**, "반쯤 커밋"도 롤백에 묻혀 보이지 않는다.

### 체크 ④ readOnly — 누락보다 오적용이 무섭다

방향이 둘인데 심각도가 완전히 다르다.

**찾는 대상**

1. **`readOnly = true`가 붙었는데 메서드 이름이나 본문이 쓰기인 것.** 이건 무조건 결함이다.
2. **클래스 레벨 `@Transactional(readOnly = true)`를 쓰는 클래스** — 그 안의 쓰기 메서드가 애너테이션을 오버라이드했는지 하나씩 확인한다. 실사고는 "실수로 붙였다"보다 이쪽이 압도적으로 많다.
3. **조회 메서드에 readOnly가 없는 것** — 성능 코멘트 대상. 결함은 아니다.

```bash
# readOnly=true 바로 아래 메서드 이름에 쓰기 동사가 들어 있으면 즉시 결함 후보
rg -n -U -P '@Transactional\(\s*readOnly\s*=\s*true\s*\)\s*\n\s*(public|protected)[^\n(]*\b(save|update|delete|remove|create|register|change|cancel|apply|issue|approve)\w*\s*\(' --type java
# 클래스 레벨 readOnly 를 쓰는 클래스 목록 — 여기 걸린 파일은 전체를 눈으로 훑는다
rg -n -B1 '^@Transactional\(readOnly = true\)' --type java src/main/java
```

**조회 메서드에 readOnly 누락 — 성능 결함.** `readOnly = true`가 없으면 하이버네이트가 조회한 엔티티마다 스냅샷(더티 체킹용 원본 복사본)을 떠 들고 있어 대량 조회에서 메모리가 사실상 두 배로 들고, 커밋 시 변경 비교 비용도 낭비된다. 리더/리플리카 분리 환경이라면 리플리카로 라우팅될 기회도 잃는다. **틀린 건 아니지만 비용을 흘리는 코드**라 리뷰 코멘트는 남기되 머지를 막지는 않는다.

**쓰기 메서드에 readOnly 오적용 — 이쪽이 진짜 사고다.**

```java
// before: AI 생성 코드 — 조회 메서드를 복붙해 만들며 readOnly 가 딸려 왔다
@Transactional(readOnly = true)
public void updateNickname(Long userId, String nickname) {
    User user = userRepository.findById(userId).orElseThrow();
    user.changeNickname(nickname);
    // 예외 없음. 응답도 200 OK. 그런데 UPDATE 는 영영 나가지 않는다.
}
```

```java
// after: 쓰기 메서드는 readOnly 없이
@Transactional
public void updateNickname(Long userId, String nickname) {
    User user = userRepository.findById(userId).orElseThrow();
    user.changeNickname(nickname);   // 커밋 시 변경 감지 → UPDATE
}
```

**readOnly는 쓰기를 "막아 주는" 안전장치가 아니다.** 플러시 모드가 MANUAL이 되고 읽기 전용으로 로드된 엔티티는 스냅샷조차 만들어지지 않아, 변경이 **에러 없이 조용히 저장되지 않을 뿐**이다. 막힌 것이 아니라 **보내지 않은 것**이고, 이 차이가 결과를 갈라놓는다 — 막혔다면 스택 트레이스가 남아 5분이면 고치지만, 안 보냈으면 며칠 뒤 CS 티켓으로 돌아온다.

한 겹 더 고약한 형태는 **조회 메서드가 쓰기 메서드를 호출하는 경우**다. 읽기 전용 여부는 트랜잭션을 시작한 바깥이 정하고 합류하는 안쪽 선언은 무시되므로, 안쪽에 `@Transactional`(쓰기)이 제대로 붙어 있어도 INSERT가 나가지 않는다. 단계별 동작과 침묵을 깨는 예외 경로들은 13번 문서 3절에 있다.

**테스트가 못 잡는 이유**: 1-3의 ④에서 본 대로 **두 겹으로 가려진다.** 테스트 트랜잭션이 읽기·쓰기면 서비스의 `readOnly = true`는 합류하며 무시되어 플러시가 정상 동작하고, 설령 아니더라도 검증 코드가 같은 영속성 컨텍스트에서 읽으므로 메모리상 바뀐 값이 그대로 보인다. **이 항목은 롤백 테스트로 잡을 방법이 아예 없다.**

## 3. 체크리스트를 절차로 만들기

### 3-1. 4항목 요약

| # | 항목 | 코드에서 찾는 것 | 안 잡으면 생기는 일 |
|---|---|---|---|
| ① | 경계 위치 | `@Transactional` 없는 다중 쓰기 / 경계 안 `restClient`·`kafkaTemplate`·`Thread.sleep`·대량 반복 | 부분 커밋 또는 UPDATE 증발 / 커넥션풀 고갈 → 전면 장애 |
| ② | 자기 호출 | 같은 클래스 안에서 호출되는 `@Transactional` 메서드, `private`/`protected` 선언 | 조용히 트랜잭션 없이 실행 — 변경 감지가 통째로 사라진다 |
| ③ | 예외 삼킴 | 재던지기 없는 `catch`, `throws` + `rollbackFor` 누락 | 반쯤 커밋 / `UnexpectedRollbackException` 500 |
| ④ | readOnly | 쓰기 메서드의 `readOnly = true`, 클래스 레벨 상속 | 변경이 에러 없이 유실 / (누락 시) 성능 낭비 |

네 항목의 공통점은 **증상이 즉시 나타나지 않는다**는 것이다. 그래서 "돌려보고 이상 없으면 머지"가 통하지 않는다.

### 3-2. 자동화되는 것과 사람이 봐야 하는 것을 가른다

이 구분이 있어야 체크리스트가 실행 가능해진다. **구조는 도구가, 의미는 사람이** 맡는다.

**자동화되는 것 — CI에 박는다**

`@Transactional`의 가시성과 계층 규칙은 ArchUnit(코드 구조를 테스트로 단언하는 라이브러리)으로 강제할 수 있다.

```java
@AnalyzeClasses(packages = "com.example.order")
class TransactionArchTest {

    // private/protected 에 붙은 @Transactional 은 프록시 방식에서 무시된다 — 문법상 합법이라 컴파일러가 못 잡는다
    @ArchTest
    static final ArchRule 트랜잭션은_public_에만 = methods()
            .that().areAnnotatedWith(Transactional.class)
            .should().bePublic();

    // 컨트롤러에 경계가 잡히면 응답 직렬화까지 커넥션을 문 채로 진행된다
    @ArchTest
    static final ArchRule 컨트롤러에는_트랜잭션_금지 = noMethods()
            .that().areDeclaredInClassesThat().areAnnotatedWith(RestController.class)
            .should().beAnnotatedWith(Transactional.class);
}
```

**경계 안 외부 호출은 런타임 탐지가 가장 확실하다.** 정적 분석으로는 "이 호출이 트랜잭션 경계 안인가"를 판단하기 어렵지만, 실행 중이라면 그냥 물어보면 된다.

```java
// 테스트 프로파일에서만 등록한다. 트랜잭션이 열린 채 HTTP 호출이 나가면 그 자리에서 테스트를 깨뜨린다.
@Bean
@Profile("test")
ClientHttpRequestInterceptor forbidHttpInsideTransaction() {
    return (request, body, execution) -> {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("트랜잭션 경계 안에서 외부 호출: " + request.getURI());
        }
        return execution.execute(request, body);
    };
}
```

이 방식의 값은 **리뷰어가 놓쳐도 CI가 잡는다**는 데 있다. 같은 원리로 `TransactionSynchronizationManager.isActualTransactionActive()`를 통합 테스트에서 직접 단언하면 **"이 경로에 트랜잭션이 실제로 걸리는가"**를 검증할 수 있다. 단 이 테스트에는 `@Transactional`을 붙이면 안 된다 — 붙이면 언제나 `true`가 나온다(1-3의 ②).

**자기 호출은 정적 분석으로 어느 정도 잡힌다.** 한 클래스 안의 호출 대상이 `@Transactional`을 달고 있으면 위반으로 보는 커스텀 ArchUnit 규칙을 쓰거나, IDE의 스프링 인스펙션을 켠다. 다만 **완전하지는 않다** — 람다나 리플렉션을 거치는 호출, 상속 계층을 통한 호출은 놓친다. 그래서 이 항목은 "도구로 후보를 좁히고 사람이 확인"이 현실적인 운영이다.

**readOnly 오적용**은 네이밍 규칙 기반으로 후보를 뽑을 수 있다(체크 ④의 ripgrep). 이름이 규칙적인 팀이라면 적중률이 높고, 그렇지 않다면 후보만 나오는 수준이다.

**사람이 봐야 하는 것 — 도구가 결정할 수 없다**

- **"이 두 쓰기가 하나의 유스케이스로 원자적이어야 하는가."** 주문 저장과 재고 차감이 함께 성공해야 하는지, 아니면 재고는 나중에 맞춰도 되는지는 **도메인 요구사항**이다. 코드만 봐서는 알 수 없다.
- **"이 catch 이후에 커밋되는 것이 비즈니스적으로 맞는가."** 알림 발송 실패는 삼켜도 되지만 입금 실패는 안 된다. 둘은 코드 모양이 같다.
- **"경계를 쪼갠 뒤 중간 상태와 복구 경로가 있는가."** 외부 호출을 밖으로 뺀 코드가 `PENDING` 상태와 정리 배치를 갖췄는지는 설계 검토의 영역이다.
- **"실패했을 때 어떤 상태가 남기를 기대하는가."** 이 질문의 답이 곧 경계 설계다.

그래서 실무 결론은 역할 분담이다. **구조 규칙은 CI로 강제하고, 사람 리뷰는 의미 판단에 집중한다.** AI 코드 리뷰에 또 다른 AI를 붙이더라도 이 분담 원칙은 그대로다 — 도메인 요구를 모르는 도구는 경계의 옳고 그름을 판정할 수 없다.

### 3-3. 발견했을 때 어떻게 지적하는가 — 지적이 아니라 설계 확인

절차만큼 중요한 것이 **전달 방식**이다. 트랜잭션 경계는 코드 스타일이 아니라 **도메인 결정**이기 때문이다.

```text
[나쁜 코멘트]  "여기 @Transactional 빠졌어요."
                → 리뷰어가 도메인을 모르는 채 내린 지시다. 이 메서드에 외부 호출이 섞여 있다면
                  붙이는 순간 오히려 체크 ①의 결함 B 를 만든다. 그리고 작성자는 근거를 모른 채
                  붙일 뿐이라 다음에도 같은 코드를 쓴다.

[좋은 코멘트]  "이 메서드는 주문 저장과 재고 차감을 하는데 둘이 원자적이어야 하나요?
                아니라면 재고 차감이 실패했을 때 주문만 남는 상태가 정상인가요?
                정상이라면 그 주문은 어떤 상태값으로 남고 누가 정리하나요?"
                → 의도를 묻는 형태다. 답이 무엇이든 설계가 한 번 확인되고,
                  작성자가 스스로 판단 근거를 세우게 된다.
```

**AI가 생성한 코드일 때 이 방식이 특히 중요하다.** 작성자 본인이 그 코드의 근거를 모르는 경우가 많기 때문이다. "왜 이렇게 하셨나요"는 답이 없는 질문이 되기 쉽고("AI가 그렇게 줬어요"), **"무엇을 기대하시나요"**는 작성자가 답할 수 있는 질문이다. 대화가 성립한다.

항목별로 물을 것을 정해 두면 리뷰가 빨라진다.

| 항목 | 지적 대신 던지는 질문 |
|---|---|
| ① 경계 위치 | "이 쓰기들이 함께 성공해야 하나요? 실패하면 어떤 상태가 남기를 기대하나요?" |
| ① 경계 넓음 | "이 결제 호출이 느려지면 커넥션을 그동안 잡고 있게 되는데, 경계 밖으로 뺄 수 있을까요? 뺐을 때 결제만 되고 주문이 실패하는 경우는 어떻게 정리하나요?" |
| ② 자기 호출 | "이 경로에서 `settleOne`의 트랜잭션이 실제로 걸리는지 확인해 보셨나요? 같은 클래스 호출이라 프록시를 안 거칩니다." |
| ③ 예외 삼킴 | "이 입금 실패를 로그만 남기고 넘어가면 출금은 커밋됩니다. 그게 의도한 동작인가요?" |
| ④ readOnly | "이 메서드는 닉네임을 바꾸는데 readOnly가 붙어 있습니다. UPDATE가 실제로 나가는지 확인해 주실 수 있을까요?" |

②와 ④는 **"확인해 보셨나요"** 형태가 특히 잘 듣는다. 확인하는 순간 본인이 결함을 발견하게 되고, 그 경험이 다음 리뷰를 줄인다.

그리고 코멘트에는 **근거를 함께 적는다.** "커넥션은 트랜잭션이 열려 있는 동안 반납되지 않으므로 외부사 지연이 그대로 풀 고갈로 이어진다" 한 줄을 붙이면 "왜"가 전달되어, 같은 사람이 다음에 스스로 판단한다.

### 3-4. 여유가 되면 보는 확장 체크 (가산점 포인트)

필수 4항목을 다 본 뒤, 같은 원리의 파생 항목들을 추가로 훑는다.

- **`REQUIRES_NEW` 남용** — 커넥션을 2개 동시에 점유하므로 풀 크기가 작으면 자기들끼리 교착한다. 풀 크기 계산까지는 `12-transaction-propagation-required-vs-requires-new.md` 3-5·3-6절.
- **`@Async`와 `@Transactional`을 한 메서드에 조합** — 별도 스레드라 호출자의 트랜잭션이 전파되지 않고, 호출자가 커밋하기 **전에** 비동기 쪽이 먼저 돌아 방금 저장한 데이터를 못 찾는 타이밍 문제까지 생긴다(`15-async-annotation.md` 3-2).
- **"커밋 후에만 해야 할 일"이 경계 안에 있는지** — 알림·이벤트 발행은 `@TransactionalEventListener(AFTER_COMMIT)`로 미룬다. 다만 그것만으로는 "커밋됐는데 발행 실패"를 못 막으므로, 유실되면 안 되는 이벤트는 아웃박스가 필요하다(`23-transactional-outbox-pattern.md`).
- **루프 안 건별 저장으로 트랜잭션이 과도하게 길어지는지** — 커넥션 점유 시간이 건수에 비례해 늘어난다.
- **`@Transactional(timeout = ...)` 부재** — 경계가 넓은 코드가 남아 있다면 타임아웃이라도 걸어 무한 점유를 막는다.

## 4. 꼬리질문 대비 포인트

### "왜 하필 트랜잭션 결함이 AI 생성 코드에 유독 흔한가요?"

두 가지 이유다.

**첫째, 트랜잭션의 정합성은 코드 텍스트가 아니라 런타임 구조에 있다.** 프록시를 거치는가, 커넥션이 어느 스레드에 묶여 있는가, 전파가 어떻게 되는가 — 전부 실행 시점의 사실이고 텍스트만으로는 드러나지 않는다. 생성 모델은 그럴듯한 텍스트 패턴을 만드는 데 강하지만, 텍스트에 없는 사실은 애초에 학습 대상이 아니다.

**둘째, 학습 데이터의 예제 코드가 단건 성공 경로 중심이다.** 블로그와 튜토리얼의 예제는 짧고, 트랜잭션이 하나이고, 예외가 안 나고, 동시 요청이 없다. 그 맥락에서는 자기 호출도 예외 삼킴도 readOnly 복붙도 **문제가 되지 않는다.** 문제가 안 되는 맥락에서 만들어진 패턴이 문제가 되는 맥락으로 그대로 옮겨오는 것이다.

그래서 **사람 리뷰의 역할이 "문법 검사"에서 "런타임 구조 검증"으로 이동한다.** 이 문장이 이 질문의 결론이다.

### "이 체크리스트를 자동화할 수 있나요? 한계는요?" (시니어 변별 포인트)

**구조는 상당 부분 자동화된다.** ArchUnit으로 "`@Transactional`은 public에만", "컨트롤러 계층 금지" 같은 규칙을 CI에 박을 수 있고, 자기 호출은 정적 분석으로 후보를 좁힐 수 있다. 경계 안 외부 호출은 정적 분석보다 **런타임 탐지가 확실하다** — 테스트 프로파일의 `ClientHttpRequestInterceptor`에서 `TransactionSynchronizationManager.isActualTransactionActive()`가 참이면 예외를 던져 테스트를 깨뜨리면 된다.

**한계는 의미 판단이다.** "이 두 쓰기가 하나의 유스케이스로 묶여야 하는가"(경계 위치), "이 catch 이후에 커밋되는 것이 비즈니스적으로 맞는가"(예외 삼킴)는 **도메인 요구사항을 알아야** 판단할 수 있어 도구가 결정해 줄 수 없다.

그래서 실무 결론은 역할 분담이다 — **구조 규칙은 CI로 강제하고, 사람 리뷰는 의미 판단에 집중한다.** AI 코드 리뷰에 또 다른 AI를 붙이더라도 이 분담 원칙은 같다.

### "테스트를 잘 짜면 되는 것 아닌가요? 왜 굳이 리뷰인가요?" (시니어 변별 포인트)

**테스트로 잡히는 것과 아닌 것을 갈라서 답해야 한다.** 이 질문이 이 문서의 핵심을 정면으로 찌른다.

**단위 테스트는 프록시를 안 거친다.** `new OrderService(mock)`으로 만든 객체에는 프록시가 없으므로 `@Transactional`이 아무 일도 하지 않고, 자기 호출과 외부 호출이 코드상 구분되지 않는다. **자기 호출 결함은 단위 테스트에서 원리적으로 관찰 불가능하다.**

**통합 테스트는 대개 단일 스레드로 정상 경로만 돈다.** 예외 삼킴은 예외가 나야, 커넥션풀 고갈은 동시 요청이 몰려야 드러난다.

**그리고 결정적으로, `@Transactional`을 붙인 롤백 테스트는 오히려 결함을 덮는다.** 테스트가 물리 트랜잭션을 먼저 열어버리므로 서비스의 트랜잭션 선언은 "새로 여는 것"이 아니라 "합류하는 것"이 되고, **커밋 경계에서 일어나는 일이 전부 테스트 트랜잭션 뒤로 숨는다.** 자기 호출은 트랜잭션 안에서 도는 것처럼 보이고, `UnexpectedRollbackException`은 커밋 시도가 없어 발생조차 하지 않으며, `readOnly = true`는 바깥 트랜잭션에 합류하며 무시되어 정상 동작하는 것처럼 보인다.

**즉 4항목은 전부 "무엇이 커밋되는가"에 관한 사실인데, 롤백 테스트는 커밋을 관찰할 수 없다.**

대응은 **테스트를 버리는 것이 아니라 목적에 맞게 쓰는 것**이다. 커밋 경계를 검증해야 하는 테스트는 `@Transactional`을 떼고 실제로 커밋시킨 뒤 `TRUNCATE`나 `@Sql`로 명시적으로 정리한다. 그리고 그렇게 짠 테스트조차 **결함이 있다는 걸 이미 알고 있어야 짤 수 있다** — 그래서 리뷰가 먼저다.

### "자기 호출을 발견했습니다. 수정 방법의 선택지와 권장은요?"

정석은 **`@Transactional` 메서드를 별도 빈으로 분리**해 호출이 항상 프록시를 통과하게 만드는 것이다. 책임 분리 관점에서도 자연스러운 경우가 많다 — 루프 오케스트레이션과 건별 처리는 원래 다른 일이다.

자기 자신을 주입받는 **self-injection**도 동작은 하지만 순환 구조라는 설계 냄새가 있어 임시방편으로 본다. **`AopContext.currentProxy()`**는 `@EnableAspectJAutoProxy(exposeProxy = true)`가 필요하고 코드에 AOP 인프라가 노출돼 마지막 수단이다.

**`TransactionTemplate`으로 프로그래밍 방식 경계를 잡는 선택지**도 있다. 프록시에 의존하지 않아 자기 호출 문제 자체가 없고 경계가 코드에 명시적으로 드러난다 — 짧은 구간에 정밀한 경계가 필요할 때 유효하다. 선택지별 대가는 `11-transactional-self-invocation.md` 3절에 정리돼 있다.

### "쓰기 메서드에 readOnly=true가 붙으면 항상 조용히 유실되나요?"

**경로에 따라 다르고, 그래서 더 위험하다.**

JPA 변경 감지에 의존하는 수정은 플러시 생략으로 **에러 없이 조용히 유실된다.** 가장 흔하고 가장 늦게 발견되는 경로다.

반면 SQL이 어떤 경로로든 DB에 도달하면 그때는 거부되어 예외가 난다. `IDENTITY` 채번은 `persist()` 시점에 즉시 INSERT를 내보내야 하고, `@Modifying` 벌크 연산은 영속성 컨텍스트를 거치지 않고 곧장 나가며, 명시적 `flush()` 호출도 쌓인 INSERT를 내보낸다. PostgreSQL처럼 읽기 전용 트랜잭션을 강제하는 DB라면 거기서 오류가 난다.

정확한 답은 이것이다. **"기본은 조용한 무시다. 다만 SQL이 어떤 경로로든 DB에 도달하면 그때는 DB가 거부해 예외가 난다."** 어느 쪽이든 **개발자가 의도한 저장은 일어나지 않는다**는 결론은 같고, 리뷰에서 잡아야 할 결함이라는 것도 같다.

### "경계 안 외부 API 호출을 발견했습니다. 어떻게 고치라고 코멘트를 남기겠나요?"

원칙은 **"트랜잭션은 DB 쓰기만, 짧게"**다.

외부 호출이 쓰기의 **선행 조건**(결제 승인 후 주문 저장)이면 호출을 경계 밖 앞으로 빼고 결과만 트랜잭션에 넘긴다. 외부 호출이 **후속 통지**(주문 저장 후 알림)라면 커밋 전에 실행되면 안 되므로 `@TransactionalEventListener(phase = AFTER_COMMIT)`로 커밋 이후로 미룬다.

핵심 근거는 **커넥션 점유 시간**이다. 트랜잭션이 열려 있는 동안 커넥션은 반납되지 않으므로 외부사 지연이 그대로 풀 고갈로 이어진다 — 이 연쇄를 코멘트에 함께 적어야 "왜"가 전달된다.

**여기서 한 걸음 더 나가면 시니어 답변이 된다.** 쪼개는 것만으로는 끝나지 않는다. "결제는 승인됐는데 주문 저장이 실패하면?"에 답이 있어야 한다 — 중간 상태(`PENDING`)를 두고, 결과 불명(타임아웃)일 때 조회 API로 확인하는 복구 배치를 붙이고, 커밋됐는데 발행이 실패하는 구간에는 아웃박스를 둔다. 그래서 리뷰 코멘트는 **"밖으로 빼세요"가 아니라 "빼면 어떤 중간 상태가 생기고 누가 정리하나요"**여야 한다.

### "체크리스트가 4개면 충분한가요? 더 볼 것은요?" (가산점 포인트)

필수 4항목은 **"조용히 틀리는 것"** 기준으로 고른 것이다. 그 밖에 같은 원리의 확장 항목이 있다.

`REQUIRES_NEW` 남용(커넥션 2개 동시 점유 → 풀 자기 교착), `@Async`와 `@Transactional`의 한 메서드 조합(전파 안 됨 + 커밋 전 실행 타이밍), "커밋 후에만 해야 할 일"이 경계 안에 있는지(`AFTER_COMMIT`으로 분리, 유실되면 안 되면 아웃박스), 루프 안 건별 저장으로 경계가 길어지는지, `timeout` 부재.

다만 **항목을 늘리는 것이 목적이 아니다.** 체크리스트의 값은 "빠짐없이 보게 하는 것"에 있으므로, **매번 실제로 다 볼 수 있는 개수**를 유지하는 편이 낫다. 4개는 5분 안에 훑을 수 있는 크기이고, 그래서 매 PR마다 실행된다. 20개짜리 체크리스트는 한 번도 끝까지 실행되지 않는다.

---

## 한 줄 요약

AI 생성 코드의 트랜잭션 결함은 컴파일·테스트·단건 실행을 전부 통과하고 런타임에도 침묵하며 — 특히 `@Transactional`을 붙인 롤백 테스트는 커밋 경계 자체를 관찰 불가능하게 만들어 네 결함을 모두 덮어버리므로 — "경계 위치(다중 쓰기에 애너테이션이 없거나, 경계 안에 외부 호출이 있거나) → 자기 호출(같은 클래스 안에서 불리는 `@Transactional`) → 예외 삼킴(재던지기 없는 `catch`와 checked 예외) → readOnly(쓰기 메서드 오적용)"를 **코드에서 찾을 문자열이 정해진 절차**로 만들어 눈으로 확인하고, 구조 규칙은 ArchUnit과 런타임 탐지로 CI에 박되 "이 경계가 비즈니스적으로 맞는가"는 사람이 의도를 묻는 형태로 확인하는 것이 유일한 방어선이다.
