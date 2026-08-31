# AI 생성 코드의 트랜잭션 리뷰 체크리스트 — 결함은 문법이 아니라 경계에 숨는다

> 핵심 관전 포인트: **AI가 생성한 서비스 코드는 컴파일되고, 단위 테스트도
> 통과하고, 단건 요청에서는 잘 돈다 — 트랜잭션 결함은 그 세 관문을 전부
> 통과하기 때문에 리뷰에서 눈으로 잡는 수밖에 없다. 내 체크리스트는 4개다:
> ① 경계 위치 — @Transactional이 없어서 쓰기 여러 건이 쪼개지거나,
> 반대로 경계가 넓어서 외부 호출까지 커넥션을 문 채 품고 있지 않은가,
> ② 자기 호출 — this.메서드() 경로로 들어가 프록시를 우회해 조용히
> 트랜잭션 없이 돌지 않는가, ③ 예외 삼킴 — try-catch가 예외를 먹어
> 롤백이 무산되거나(반쯤 커밋), 내부 트랜잭션의 rollback-only 마킹과
> 충돌해 UnexpectedRollbackException이 나지 않는가 + checked 예외의
> rollbackFor 누락, ④ readOnly — 조회에 누락됐거나, 더 위험하게는
> 복붙 패턴으로 쓰기 메서드에 붙어 변경이 조용히 유실되지 않는가.
> 넷 다 "런타임에 침묵하는" 결함이라 절차화된 리뷰만이 방어선이다.**

---

## 0. 질문 + 의도

**질문**: "AI가 생성한 서비스 코드를 트랜잭션 관점에서 리뷰할 때의
체크리스트는? (경계 위치, 자기 호출, 예외 삼킴, readOnly 여부)"

**출제 의도**: AI 산출물 검증 능력의 스프링 판. AI가 짠 서비스 코드의
결함은 문법이 아니라 트랜잭션 경계(자기 호출로 미적용, 경계 안 외부 호출,
삼켜진 예외로 인한 롤백 누락)에 숨는다. 검증 항목을 체크리스트로
언어화해둔 사람인지 — 리뷰가 감이 아니라 절차인지 확인한다.

## 1. 왜 트랜잭션이 AI 코드 리뷰의 최우선 관문인가

AI 생성 코드의 특징은 "그럴듯함"이다. 네이밍이 깔끔하고, 계층 분리가
교과서적이고, 예외 처리도 친절하게 감싸져 있다. 문법 오류나 명백한
로직 버그는 컴파일러와 테스트가 잡아준다. 문제는 트랜잭션 결함이
**그 어떤 자동 관문에도 걸리지 않는다**는 점이다:

- **컴파일러가 못 잡는다** — `@Transactional`이 자기 호출로 무시되든,
  readOnly가 쓰기 메서드에 붙어 있든 문법상 완벽하다.
- **단위 테스트가 못 잡는다** — 리포지토리를 목(mock)으로 대체한
  테스트에는 트랜잭션 자체가 없고, H2 통합 테스트도 단건 성공 경로만
  타면 경계가 틀려도 결과가 같다.
- **런타임도 침묵한다** — 자기 호출은 에러 없이 트랜잭션 없이 돌고,
  삼켜진 예외는 반쯤 커밋된 데이터만 남기고, readOnly 오적용은 변경을
  조용히 버린다. 증상은 몇 주 뒤 "데이터가 이상해요"라는 리포트로 온다.

그래서 트랜잭션 관점 리뷰는 "감 좋은 시니어가 훑어보기"가 아니라
**항목이 정해진 절차**여야 한다. 아래 4개가 그 절차다.

## 2. 체크리스트 4항목 — 무엇을, 왜, 어떻게 보는가

### 체크 ① 경계 위치 — 트랜잭션이 "없거나" "너무 넓거나"

두 방향을 다 본다. 하나의 유스케이스에 속한 쓰기 여러 건이 **한 경계로
묶여 있는가**, 그리고 그 경계 안에 **DB 작업이 아닌 것이 섞여 있지 않은가**.

**결함 A — 경계가 없어서 쓰기가 쪼개진다.** AI는 서비스 메서드에
`@Transactional`을 빠뜨리는 경우가 흔한데, 이때 코드는 죽지 않는다.
Spring Data JPA의 `save()` 자체가 트랜잭션을 각자 열기 때문이다 —
즉 "트랜잭션이 없는" 게 아니라 "쓰기마다 따로따로 커밋되는" 상태가 된다.

```java
// ❌ AI 생성 코드: 애너테이션 없음 — 각 save()가 독립 트랜잭션
public Order placeOrder(OrderRequest request) {
    Order order = orderRepository.save(createOrder(request)); // ① 커밋됨
    pointService.deduct(request.userId(), request.usedPoint()); // ② 여기서 예외 나면
    deliveryRepository.save(createDelivery(order));             // ③ 도달 못 함
    return order;
    // 결과: 주문은 저장됐는데 포인트 차감·배송 생성은 없음 — 부분 커밋 사고
}
```

```java
// ✅ 수정: 유스케이스 단위로 하나의 경계
@Transactional
public Order placeOrder(OrderRequest request) {
    Order order = orderRepository.save(createOrder(request));
    pointService.deduct(request.userId(), request.usedPoint());
    deliveryRepository.save(createDelivery(order));
    return order;   // 셋 다 커밋되거나, 셋 다 롤백되거나
}
```

**결함 B — 경계가 넓어서 커넥션을 문 채 딴짓한다.** 반대로 AI가
"전부 하나의 메서드에 + @Transactional"로 짜면, 외부 API 호출·메일
발송·파일 업로드가 경계 안에 들어온다. 트랜잭션이 열려 있는 동안 DB
커넥션은 반납되지 않으므로, 외부사 응답이 3초 늦어지면 커넥션 점유도
3초 늘어난다 — 트래픽이 몰리면 커넥션풀 고갈로 **외부사 장애가 우리 전
서비스 장애로 번진다.**

```java
// ❌ AI 생성 코드: 결제 API 호출이 트랜잭션 안 — 커넥션을 문 채 대기
@Transactional
public Order placeOrder(OrderRequest request) {
    PaymentResult result = paymentClient.pay(request);  // 외부 호출 (수 초 가능)
    Order order = orderRepository.save(createOrder(request, result));
    notificationClient.sendKakao(order);                 // 이것도 외부 호출
    return order;
}
```

```java
// ✅ 수정: DB 쓰기만 경계 안에, 외부 호출은 경계 밖으로
public Order placeOrder(OrderRequest request) {
    PaymentResult result = paymentClient.pay(request);   // 트랜잭션 밖
    Order order = orderTxService.saveOrder(request, result); // 짧은 트랜잭션
    // 알림은 커밋 이후에만 — @TransactionalEventListener(AFTER_COMMIT) 등
    return order;
}
```

리뷰 요령: 메서드 안의 각 줄을 "DB 작업 / 아닌 것"으로 색칠해보고,
아닌 것이 `@Transactional` 안에 있으면 경계를 의심한다. 컨트롤러에
`@Transactional`이 붙어 있는 것도 같은 유형의 신호다(직렬화·응답 쓰기까지
경계에 들어옴).

### 체크 ② 자기 호출 — `this.` 경로로 프록시를 우회하는가

`@Transactional`은 빈을 감싼 프록시가 메서드 호출을 가로채는 방식이라,
같은 클래스 안에서 `this.method()`로 부르면 프록시를 안 거치고 원본이
직접 실행된다 — **트랜잭션 없이, 에러도 경고도 없이.** AI는 "루프 도는
public 메서드 + 건별 처리 @Transactional 메서드"를 한 클래스에 넣는
패턴을 아주 흔하게 생성한다. 겉보기엔 오히려 잘 설계된 것처럼 보여서
더 위험하다.

```java
// ❌ AI 생성 코드: 그럴듯해 보이지만 processOne의 트랜잭션은 전부 무시됨
@Service
public class SettlementService {
    public void settleAll(List<Long> ids) {
        for (Long id : ids) {
            this.settleOne(id);        // this = 원본 객체, 프록시 우회
        }
    }

    @Transactional
    public void settleOne(Long id) { /* 정산 쓰기 여러 건 */ }
}
```

```java
// ✅ 수정: 건별 처리를 별도 빈으로 분리 — 호출이 프록시를 통과하게
@Service
public class SettlementService {
    private final SettlementProcessor processor;  // 다른 빈

    public void settleAll(List<Long> ids) {
        for (Long id : ids) {
            processor.settleOne(id);   // 프록시를 거침 → 트랜잭션 적용
        }
    }
}
```

리뷰 요령: 클래스 안에서 `@Transactional`(또는 `@Async`, `@Cacheable` —
전부 같은 프록시 원리다)이 붙은 메서드를 찾고, 그 메서드가 **같은 클래스
내부에서 호출되는 곳이 있는지** 역추적한다. 있다면 그 경로는 애너테이션이
전부 무효다. `public`이 아닌 메서드에 붙은 `@Transactional`도 같은 이유로
무효이니 함께 본다.

### 체크 ③ 예외 삼킴 — catch가 롤백을 무산시키는가

AI는 "친절한" 코드를 좋아한다. 모든 위험 구간을 try-catch로 감싸고
`log.error`를 찍고 계속 진행한다. 그런데 프록시의 롤백 판단은 **예외가
메서드 밖(프록시 경계)까지 나왔는지**로 이루어진다. 안에서 잡아버리면
프록시는 예외를 본 적이 없으니 그때까지의 쓰기를 **정상 커밋**한다.

```java
// ❌ AI 생성 코드: 예외를 먹어서 "실패했는데 반쯤 커밋"
@Transactional
public void transfer(TransferRequest request) {
    accountRepository.withdraw(request.from(), request.amount()); // ① 출금
    try {
        accountRepository.deposit(request.to(), request.amount()); // ② 실패
    } catch (Exception e) {
        log.error("입금 실패", e);   // 예외를 삼킴 → 프록시는 정상 리턴으로 인식
    }
    // 결과: ①만 커밋. 돈이 빠져나가고 입금은 안 된 상태가 "정상 처리"로 남음
}
```

```java
// ✅ 수정: 롤백돼야 할 실패는 예외를 경계 밖으로 내보낸다
@Transactional
public void transfer(TransferRequest request) {
    accountRepository.withdraw(request.from(), request.amount());
    accountRepository.deposit(request.to(), request.amount());
    // 로깅·복구가 필요하면 catch 후 반드시 다시 던진다 (throw e / 도메인 예외로 변환)
}
```

이 항목에서 함께 보는 변종이 둘 더 있다:

- **내부 트랜잭션 예외를 잡은 경우** — 잡은 예외가 다른 빈의
  `@Transactional`(전파 기본값 REQUIRED) 메서드에서 나온 것이라면, 그쪽
  프록시가 이미 공유 트랜잭션에 rollback-only 마킹을 찍었다. 겉의 catch로
  는 마킹을 지울 수 없어 커밋 시점에 `UnexpectedRollbackException`이
  터진다. "잡고 대체 로직을 태우는" AI 코드는 이 지점에서 500을 만든다.
  (상세 동작은 `07-transactional-default-behavior-rollback.md` 참고)
- **checked 예외 + rollbackFor 누락** — 기본 롤백 대상은 unchecked
  예외뿐이다. AI가 `throws SomeException`(checked)을 선언하고
  `rollbackFor` 없이 던지게 짰다면, 예외는 났는데 커밋되는 조합이다.
  `throws` 선언이 보이면 반사적으로 `rollbackFor`를 확인한다.

리뷰 요령: `@Transactional` 메서드 안의 모든 catch 블록에 대해
"이 catch 이후에도 커밋되는 게 맞는가?"를 자문한다. 답이 "아니오"인데
재던지기(rethrow)가 없으면 결함이다.

### 체크 ④ readOnly 여부 — 누락보다 오적용이 무섭다

방향이 둘이다.

**조회 메서드에 readOnly 누락** — 성능 결함. `readOnly = true`가 없으면
하이버네이트가 조회한 엔티티 전부의 스냅샷(더티 체킹용 원본 복사본)을
들고 있어 대량 조회에서 메모리가 사실상 2배로 들고, 커밋 시 flush 비용도
낭비된다. 리더/리플리카 분리 환경이라면 리플리카로 라우팅될 기회도
잃는다. 틀린 건 아니지만 비용을 흘리는 코드다.

**쓰기 메서드에 readOnly 오적용** — 이쪽이 진짜 사고다. AI가 기존 조회
메서드를 복붙해 수정 메서드를 만들면서 `readOnly = true`를 같이 끌고
오는 패턴이 있다. readOnly는 쓰기를 "막아주는" 안전장치가 아니다 —
플러시 모드가 MANUAL이 되어 더티 체킹 변경분이 **에러 없이 조용히
저장되지 않을 뿐**이다.

```java
// ❌ AI 생성 코드: 조회 메서드를 복붙해 만들며 readOnly가 딸려 옴
@Transactional(readOnly = true)
public void updateNickname(Long userId, String nickname) {
    User user = userRepository.findById(userId).orElseThrow();
    user.changeNickname(nickname);
    // 예외 없음, 응답도 정상. 하지만 flush 생략으로 UPDATE는 영영 안 나감
}
```

```java
// ✅ 수정: 쓰기 메서드는 readOnly 없이
@Transactional
public void updateNickname(Long userId, String nickname) {
    User user = userRepository.findById(userId).orElseThrow();
    user.changeNickname(nickname);   // 커밋 시 더티 체킹 → UPDATE
}
```

리뷰 요령: 메서드 이름·본문이 쓰기(save/update/delete/상태 변경)를
포함하는데 `readOnly = true`가 붙어 있으면 무조건 결함. 반대로 순수
조회인데 readOnly가 없으면 성능 코멘트를 남긴다.
(readOnly의 계층별 실효는 `13-transactional-readonly-optimization.md` 참고)

## 3. 체크리스트 요약 — 리뷰를 절차로 만들기

| # | 항목 | 찾는 결함 | 안 잡으면 생기는 일 |
|---|---|---|---|
| ① | 경계 위치 | 애너테이션 누락 / 경계 안 외부 호출 | 부분 커밋 / 커넥션풀 고갈 |
| ② | 자기 호출 | `this.` 경로의 @Transactional 호출 | 조용히 트랜잭션 없이 실행 |
| ③ | 예외 삼킴 | 재던지기 없는 catch, rollbackFor 누락 | 반쯤 커밋 / UnexpectedRollbackException |
| ④ | readOnly | 조회 누락 / 쓰기 오적용 | 성능 낭비 / 변경 조용히 유실 |

네 항목의 공통점은 전부 **증상이 즉시 안 나타난다**는 것 — 그래서
"돌려보고 이상 없으면 머지"가 통하지 않고, 리뷰 단계의 절차적 확인이
유일한 방어선이다.

여기까지가 필수 4항목이고, 여유가 되면 같은 원리의 확장 체크를 더 본다
(가산점 포인트): `REQUIRES_NEW` 남용(커넥션 2개 동시 점유 → 풀 고갈·교착),
`@Async`와 `@Transactional`을 한 메서드에 조합(별도 스레드라 호출자의
트랜잭션이 전파되지 않음), 알림 발송 등 "커밋 후에만 해야 할 일"이 경계
안에 있는지(AFTER_COMMIT으로 분리), 루프 안 건별 저장으로 트랜잭션이
과도하게 길어지는지.

## 4. 꼬리질문 대비 포인트

### "왜 하필 트랜잭션 결함이 AI 생성 코드에 유독 흔한가?"

두 가지 이유다. 첫째, 트랜잭션의 정합성은 **코드 텍스트가 아니라 런타임
구조(프록시, 커넥션 바인딩, 전파)에 있다.** AI는 그럴듯한 텍스트 패턴을
생성하는 데는 강하지만, "이 호출이 프록시를 거치는가" 같은 실행 시점
사실은 텍스트만으로 드러나지 않는다. 둘째, 학습 데이터에 있는 예제
코드들 자체가 단건 성공 경로 중심이라, 루프+건별 트랜잭션(자기 호출),
친절한 try-catch(예외 삼킴), 복붙 애너테이션(readOnly 오적용) 같은
"예제에서는 문제 안 되던 패턴"이 그대로 재생산된다. 그래서 사람 리뷰의
역할이 "문법 검사"에서 "런타임 구조 검증"으로 이동한다.

### "이 체크리스트를 사람 눈에만 맡기지 않고 자동화할 수 있나? 한계는?" (시니어 변별 포인트)

구조적 결함은 상당 부분 자동화할 수 있다. ArchUnit 같은 아키텍처 테스트로
"@Transactional은 public 메서드에만", "컨트롤러 계층에는 금지" 같은 규칙을
CI에 박을 수 있고, 자기 호출은 정적 분석(IntelliJ 인스펙션이 기본 제공)으로
잡힌다. 통합 테스트에서
`TransactionSynchronizationManager.isActualTransactionActive()`로 "이
경로에 트랜잭션이 실제로 걸리는지"를 단언하는 방법도 있고, 로컬에서는
트랜잭션 인터셉터 로그 레벨을 올려 어떤 메서드에서 트랜잭션이
시작/커밋되는지 눈으로 확인할 수 있다.

한계는 **의미 판단**이다. "이 두 쓰기가 하나의 유스케이스로 묶여야
하는가"(경계 위치), "이 catch 이후에 커밋되는 게 비즈니스적으로
맞는가"(예외 삼킴)는 도메인 요구사항을 알아야 판단할 수 있어 도구가
결정해줄 수 없다. 그래서 실무 결론은 역할 분담이다 — 구조 규칙은
CI로 강제하고, 사람 리뷰는 의미 판단(경계·예외 정책)에 집중한다.
AI 코드 리뷰에 또 다른 AI를 쓰더라도 이 분담 원칙은 같다.

### "자기 호출을 발견했다. 수정 방법의 선택지와 권장은?"

정석은 `@Transactional` 메서드를 **별도 빈으로 분리**해 호출이 항상
프록시를 통과하게 만드는 것이다. 책임 분리 관점에서도 자연스러운 경우가
많다(루프 오케스트레이션 vs 건별 처리). 자기 자신을 주입받는
self-injection도 동작은 하지만 순환 구조라는 설계 냄새가 있어 임시방편으로
본다. 애너테이션 대신 `TransactionTemplate`으로 프로그래밍 방식 경계를
잡는 방법도 있는데, 프록시에 의존하지 않아 자기 호출 문제 자체가 없고
경계가 코드에 명시적으로 드러나는 장점이 있다 — 짧은 구간에 정밀한
경계가 필요할 때 유효한 선택지다.

### "쓰기 메서드에 readOnly=true가 붙으면 항상 조용히 유실되나? 예외가 나는 경우는 없나?"

경로에 따라 다르다 — 그래서 더 위험하다. JPA 더티 체킹에 의존하는
변경은 flush 생략으로 **에러 없이 조용히 유실**된다(가장 흔하고 가장
늦게 발견되는 경로). 반면 `Connection.setReadOnly(true)` 힌트를 DB가
강제하는 구성(예: 읽기 전용 세션으로 여는 드라이버/DB 조합)이나 리플리카로
라우팅되는 구성에서는 쓰기 SQL이 DB 단에서 거부되어 예외가 난다.
즉 "환경에 따라 조용한 유실일 수도, 명시적 에러일 수도 있다"가 정확한
답이고, 어느 쪽이든 리뷰에서 잡아야 할 결함이라는 결론은 같다.

### "경계 안 외부 API 호출을 발견했다. 어떻게 고치라고 리뷰 코멘트를 남기겠나?"

원칙은 "트랜잭션은 DB 쓰기만, 짧게". 외부 호출이 쓰기의 **선행
조건**(결제 승인 후 주문 저장)이면 호출을 경계 밖 앞으로 빼고 결과만
트랜잭션에 넘긴다. 외부 호출이 **후속 통지**(주문 저장 후 알림)라면
커밋 전에 실행되면 안 되므로 `@TransactionalEventListener(phase =
AFTER_COMMIT)`로 커밋 이후로 미룬다 — 이때 "커밋됐는데 발행
실패" 가능성까지 짚으면(재시도, Outbox 패턴) 가산점 포인트다. 핵심
근거는 커넥션 점유 시간이다: 트랜잭션이 열려 있는 동안 커넥션은
반납되지 않으므로, 외부사 지연이 곧 커넥션풀 고갈로 이어지는 연쇄를
코멘트에 함께 적어야 "왜"가 전달된다.

---

## 한 줄 요약

AI 생성 코드의 트랜잭션 결함은 컴파일·테스트·단건 실행을 모두 통과하고
런타임에 침묵하므로, "경계 위치 → 자기 호출 → 예외 삼킴 → readOnly"
4항목을 절차화된 체크리스트로 눈으로 확인하는 것 — 구조 규칙은 도구로
강제하고 의미 판단은 사람이 맡는 것 — 이 유일한 방어선이다.
