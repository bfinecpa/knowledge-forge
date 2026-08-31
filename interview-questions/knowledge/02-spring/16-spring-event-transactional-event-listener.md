# Spring Event와 @TransactionalEventListener — "커밋도 안 됐는데 알림부터 나간" 사고를 막는 도구

> 핵심 관전 포인트: **ApplicationEventPublisher로 발행한 이벤트는 기본이
> 동기·같은 스레드·같은 트랜잭션이다 — "이벤트니까 비동기겠지"는 오해.
> @EventListener는 발행 즉시 실행되지만, @TransactionalEventListener는
> 트랜잭션 phase(기본 AFTER_COMMIT)에 맞춰 실행을 지연시킨다.
> 외부 시스템(Redis, 메일, MQ)은 DB 트랜잭션에 참여하지 않으므로,
> 커밋 확정 전에 건드리면 롤백 시 "DB는 안 바뀌었는데 외부만 바뀐"
> 불일치가 생긴다 — AFTER_COMMIT은 이 거짓 알림/거짓 캐시를 막는 도구다.
> 단, 커밋 후 리스너가 실패하면 롤백이란 없다. 그 실패 경로를
> 어떻게 설계하는가(수용/재시도/보상/아웃박스)가 시니어 변별 지점이다.**

---

## 0. 질문 + 의도

**질문**: "Spring Event(`ApplicationEventPublisher`)를 활용해본 경험이 있나요?
`@TransactionalEventListener`는 언제 유용한가요?"
"DB 커밋 후에 이벤트를 발행해야 하는 요구사항을 어떻게 구현하나요?
(AFTER_COMMIT, Transactional Outbox)"

**출제 의도**: 결합도를 낮추면서 "커밋 후에만 알림 발송" 같은 정합성 요구를
지키는 실무 패턴을 아는지 본다. 이벤트를 써봤다는 사람에게 커밋 전/후 실행
시점을 물으면 진짜 이해도가 드러난다. 고난이도 버전에서는 "커밋됐는데 발행
실패" / "발행됐는데 롤백"의 양쪽 실패를 다 짚는지 — 분산 시스템 정합성의
축소판이라, 이 문제를 이해한 사람은 Kafka·MSA 정합성 문제 전반을 이해할
준비가 된 것이다.

## 1. Spring Event 기본 구조 — 발행과 구독, 그리고 "동기"라는 진실

이벤트는 "한 컴포넌트가 무슨 일이 일어났다고 외치면, 관심 있는
컴포넌트들이 각자 알아서 반응하는" 구조다. 발행자는 구독자가 누군지,
몇 명인지 몰라도 된다 — 결합도를 낮추는 것이 핵심 목적이다.

```java
// 발행: "주문이 완료됐다"고 외치기만 한다
@Service
@RequiredArgsConstructor
public class OrderService {
    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public Order complete(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.complete();
        eventPublisher.publishEvent(new OrderCompletedEvent(order.getId()));
        return order;
    }
}

// 구독: 알림/통계/캐시가 각자의 리스너로 반응 — 서로를 모른다
@Component
public class NotificationListener {
    @EventListener
    public void on(OrderCompletedEvent event) { /* 알림 발송 */ }
}

@Component
public class StatisticsListener {
    @EventListener
    public void on(OrderCompletedEvent event) { /* 통계 집계 */ }
}
```

이벤트가 없었다면 `OrderService`가 알림·통계·캐시 서비스를 전부
주입받아 순서대로 호출해야 한다. 이벤트를 쓰면 "주문 완료 후 할 일"이
늘어나도 `OrderService`는 한 줄도 안 바뀐다 — 리스너만 추가하면 된다.

### 가장 흔한 오해: "이벤트 = 비동기"

아니다. **기본은 동기, 같은 스레드, 같은 트랜잭션이다.**
`publishEvent()`를 호출하는 순간 그 자리에서 리스너들이 순차 실행되고,
전부 끝나야 다음 줄로 넘어간다. 사실상 "발행자가 리스너 메서드를
직접 호출하는 것"과 실행 흐름이 같다 — 다른 점은 발행자가 리스너의
존재를 컴파일 타임에 모른다는 것뿐이다.

이 사실에서 두 가지가 따라온다:

- 리스너가 던진 예외는 **발행자에게 그대로 전파**된다. 리스너의
  RuntimeException이 발행자의 트랜잭션을 롤백시킬 수 있다.
- 리스너 안의 DB 작업은 발행자와 **같은 트랜잭션**에서 실행된다.
  아직 커밋 전이라는 뜻이다.

## 2. @TransactionalEventListener — 실행 시점을 트랜잭션 phase에 묶는다

`@EventListener`가 "발행 즉시 실행"이라면, `@TransactionalEventListener`는
"발행은 해두되, 실행은 트랜잭션의 특정 단계까지 미룬다"이다.
발행 시점에 이벤트를 큐에 담아뒀다가, 트랜잭션이 해당 phase에
도달했을 때 실행한다.

phase는 4종이다:

| phase | 실행 시점 | 용도 |
|---|---|---|
| `BEFORE_COMMIT` | 커밋 직전 | 커밋 전 마지막 검증/플러시 (같은 트랜잭션 안) |
| `AFTER_COMMIT` | **커밋 성공 후 (기본값)** | 외부 시스템 반영 — 알림, 캐시, MQ 발행 |
| `AFTER_ROLLBACK` | 롤백 후 | 실패 알림, 실패 메트릭 |
| `AFTER_COMPLETION` | 커밋이든 롤백이든 완료 후 | 정리 작업 (락 해제 등) |

```java
@Component
public class NotificationListener {
    // phase 생략 시 AFTER_COMMIT — 커밋이 확정된 뒤에만 실행된다
    @TransactionalEventListener
    public void on(OrderCompletedEvent event) { /* 알림 발송 */ }
}
```

## 3. AFTER_COMMIT이 유용한 이유 — 외부 시스템은 트랜잭션에 참여하지 않는다

이 질문의 핵심이다. DB 트랜잭션의 롤백은 **DB 안의 변경만** 되돌린다.
Redis 쓰기, 메일 발송, 푸시, MQ 발행은 트랜잭션 밖의 세계라서
한번 나가면 롤백으로 되돌릴 수 없다.

그래서 커밋이 확정되기 **전에** 외부 시스템을 건드리면, 트랜잭션이
롤백됐을 때 "DB는 안 바뀌었는데 외부만 바뀐" 불일치가 생긴다.

### 사고 나는 코드 (before)

```java
@Service
public class OrderService {
    @Transactional
    public Order complete(Long orderId) {
        Order order = orderRepository.findById(orderId).orElseThrow();
        order.complete();
        eventPublisher.publishEvent(new OrderCompletedEvent(order.getId()));
        // @EventListener라면 이 시점(커밋 전!)에 알림이 이미 나감
        applyCoupon(order);   // 여기서 RuntimeException → 전체 롤백
        return order;
    }
}
// 결과: DB의 주문은 "완료 안 됨"으로 롤백됐는데,
// 고객은 "주문이 완료되었습니다" 푸시를 받았다 — 거짓 알림.
```

### 고친 코드 (after)

```java
@Component
public class NotificationListener {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderCompletedEvent event) {
        // 커밋이 확정된 뒤에만 실행 — 롤백됐다면 아예 실행되지 않는다
        pushService.send(event.orderId(), "주문이 완료되었습니다");
    }
}
```

롤백되면 리스너가 **실행 자체가 안 되므로** 거짓 알림·거짓 캐시가
원천 차단된다.

### 실전 예시 — 보안 설정 변경 후 Redis 토큰 차단

실제로 겪은 사례를 각색하면: 보안 설정(예: 특정 앱 접근 차단)이
변경되면, Redis에 살아 있는 해당 사용자들의 토큰을 차단(blocking)해야
하는 요구사항이 있었다.

- 설정 저장과 같은 트랜잭션 안에서(또는 BEFORE_COMMIT에서) 토큰을
  차단하면 — 이후 로직에서 예외가 나 설정 저장이 롤백됐을 때,
  **설정은 안 바뀌었는데 사용자 토큰만 차단된** 상태가 된다.
  사용자는 아무 이유 없이 강제 로그아웃당한다.
- `@TransactionalEventListener(phase = AFTER_COMMIT)`로 옮기면
  설정 변경이 DB에 확정된 경우에만 토큰이 차단된다. 롤백 시나리오에서
  Redis는 손도 대지 않는다.

"외부 시스템 반영은 커밋이라는 사실 확정 뒤에" — 이 한 문장이
AFTER_COMMIT의 존재 이유다.

## 4. 실패 경로 설계 — 커밋 뒤의 실패에는 롤백이 없다 (시니어 변별 핵심)

AFTER_COMMIT은 "롤백됐는데 외부만 바뀐" 문제를 막지만, 반대 방향의
문제를 새로 만든다. **커밋은 이미 확정됐는데 리스너가 실패하면?**
DB는 바뀌었는데 Redis 토큰 차단은 안 된 상태 — 이번엔 되돌릴
트랜잭션이 없다. 롤백이란 없다.

이 실패를 어떻게 다룰지는 요구사항의 심각도에 따라 스펙트럼으로 고른다:

**① 불일치를 유계(bounded)로 만들고 수용**

불일치가 "영원히"가 아니라 "최대 N분"이라면 수용 가능한 경우가 많다.
예: 토큰 TTL이 30분이면, 차단에 실패해도 최악의 불일치 지속 시간은
30분이다 — TTL이 곧 불일치의 상한이 된다. "우리 보안 스펙상 30분
지연은 허용되는가?"라는 **스펙 레벨 의사결정**으로 격상시켜 답을 얻는
접근. 기술로 다 막으려 하지 않고 비즈니스와 합의하는 것도 설계다.

**② 재시도 (retry)**

일시적 장애(Redis 순단 등)라면 재시도로 흡수한다. 단 무한 재시도는
금물 — 재시도 상한 + 최종 실패 시 알람/모니터링이 세트다.
재시도로도 안 되는 실패는 결국 ①이나 ③으로 넘어간다.

**③ 보상 트랜잭션 (compensating transaction)**

리스너 실패 시 **새 트랜잭션으로 원래 커밋의 역연산**을 수행해
DB를 되돌리는 것. 겉보기엔 깔끔하지만 허점이 있다:

- 원 커밋 ~ 보상 커밋 사이의 시간 동안 다른 요청이 이미 변경된
  상태를 **읽고 행동**했을 수 있다 — 그 행동은 되돌릴 수 없다.
- 보상 트랜잭션 자체가 실패하면? 실패 처리의 실패라는 무한 후퇴.

**④ 아웃박스 패턴 (outbox pattern) — 신뢰성이 필수라면**

"커밋됐으면 반드시 (언젠가는) 외부 반영도 된다"가 요구사항이라면,
이벤트를 메모리가 아니라 **DB에 남긴다**:

```java
@Transactional
public void changeSecuritySetting(SettingRequest request) {
    settingRepository.save(setting);
    outboxRepository.save(OutboxEvent.of("TOKEN_BLOCK", payload));
    // 설정 변경과 이벤트 레코드가 같은 트랜잭션 — 원자적으로 함께 커밋/롤백
}

// 별도 릴레이(스케줄러/CDC)가 outbox 테이블을 읽어 발행하고,
// 성공한 것만 처리 완료로 마킹 — 실패하면 다음 주기에 재시도
```

같은 트랜잭션이므로 "커밋됐는데 이벤트가 유실"도, "롤백됐는데
이벤트만 발행"도 불가능하다. 대가는 테이블·릴레이·중복 발행 대비
(멱등 소비자) 등 운영 복잡도다.

①→④로 갈수록 신뢰성이 올라가고 복잡도도 올라간다. "무조건 아웃박스"가
아니라 **요구사항이 감당할 불일치의 크기**로 도구를 고르는 답변이
시니어 답변이다.

## 5. 함정 3종 — 알고 쓰지 않으면 조용히 당한다

### 5-1. AFTER_COMMIT 리스너 안의 DB 쓰기 — 조용히 커밋 안 됨

```java
// ❌ before
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) {
    historyRepository.save(new OrderHistory(event.orderId()));
    // 예외도 없고 로그도 없는데, DB에 안 들어가 있다?!
}
```

AFTER_COMMIT 리스너는 **이미 커밋이 끝난 트랜잭션의 잔여
리소스(커넥션)에 편승**해서 실행된다. 트랜잭션 동기화는 아직 살아
있어서 save()가 에러 없이 돌지만, 그 트랜잭션은 이미 commit이 끝났으므로
**다시 커밋될 일이 없다** — 쓰기가 조용히 증발한다. 예외가 안 나서
더 위험한 함정이다.

```java
// ✅ after: 새 트랜잭션을 명시적으로 열어야 한다
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void on(OrderCompletedEvent event) {
    historyRepository.save(new OrderHistory(event.orderId()));
}
```

### 5-2. 여전히 동기 — 느린 리스너가 응답을 붙잡는다

`@TransactionalEventListener`도 실행 시점만 미뤄질 뿐 **여전히 요청
스레드에서 동기로** 돈다. 커밋 직후, 응답이 나가기 전에 실행되므로
리스너의 메일 발송이 3초 걸리면 사용자 응답도 3초 늦어진다.

```java
// 응답과 무관한 부수 작업이라면 @Async 조합
@Async
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void on(OrderCompletedEvent event) { mailService.send(...); }
```

단 @Async를 붙이는 순간 별도 스레드로 넘어가므로, 스레드풀 설정·예외
처리(AsyncUncaughtExceptionHandler)·SecurityContext/MDC 미전파 등
@Async 문서의 이슈 세트가 그대로 따라온다. "@Async 붙이면 끝"이 아니라
그 비용까지 언급하면 가산점.

### 5-3. 트랜잭션 밖에서 발행하면 실행 안 됨

`@TransactionalEventListener`는 "진행 중인 트랜잭션"에 실행을 거는
장치라서, **트랜잭션이 없는 곳에서 publishEvent() 하면 (기본 설정에서)
리스너가 아예 실행되지 않는다.** 에러도 없다 — 그냥 조용히 스킵된다.
발행 지점 메서드에서 @Transactional이 빠졌거나 self-invocation으로
프록시를 안 탔을 때 "이벤트가 왜 안 오지?"의 단골 원인이다.
트랜잭션 없이도 즉시 실행되게 하려면 `fallbackExecution = true`를
명시해야 한다.

---

## 6. 꼬리질문 대비 포인트

### "@EventListener와 @TransactionalEventListener의 차이는?"

실행 **시점**이 다르다. @EventListener는 publishEvent() 호출 즉시
그 자리에서 실행된다(발행자의 트랜잭션 안, 커밋 전). @TransactionalEventListener는
이벤트를 붙잡아 뒀다가 트랜잭션 phase에 맞춰 실행한다 — 기본값
AFTER_COMMIT이면 커밋이 확정된 뒤에만 실행되고, 롤백되면 실행 자체가
안 된다. "커밋이라는 사실이 확정된 뒤에만 해야 하는 일(외부 시스템
반영)"이 후자의 존재 이유다.

### "이벤트 발행-리스너는 기본이 비동기인가?"

아니다 — **동기, 같은 스레드**다. publishEvent()가 리턴하기 전에
리스너들이 전부 실행되고, 리스너의 예외는 발행자에게 전파되며,
리스너의 DB 작업은 발행자와 같은 트랜잭션에 합류한다. 비동기로
만들려면 @Async를 명시적으로 조합해야 한다. "이벤트니까 당연히
비동기"라고 답하면 바로 감점되는 지점.

### "AFTER_COMMIT 리스너에서 repository.save()가 조용히 안 먹는 이유는?"

리스너가 이미 커밋이 완료된 트랜잭션의 리소스에 편승해서 실행되기
때문이다. 트랜잭션 동기화가 아직 살아 있어 save()는 에러 없이 돌지만,
그 트랜잭션은 다시 커밋되지 않으므로 쓰기가 증발한다. 예외가 없어서
운영에서 한참 뒤에 발견되는 유형. 해결은 리스너 메서드에
`@Transactional(propagation = REQUIRES_NEW)`로 새 트랜잭션을 여는 것.

### "AFTER_COMMIT 리스너가 실패하면? 커밋은 이미 됐는데 — 정합성은 어떻게 지키나?"

롤백은 불가능하다는 사실부터 인정하고, 방어 스펙트럼으로 답한다:
① 불일치를 유계로 만들고 수용(예: 토큰 TTL 30분 = 불일치 상한,
스펙 레벨 의사결정) → ② 재시도 + 상한 + 실패 알람 → ③ 보상
트랜잭션(단, 원 커밋~보상 사이에 읽힌 상태와 보상 자체의 실패라는
허점) → ④ 신뢰성이 필수면 아웃박스 패턴(이벤트 레코드를 같은
트랜잭션에 저장, 별도 릴레이가 발행 — 원자성 확보, 대신 운영 복잡도).
요구사항의 심각도로 단계를 고른다고 답하면 시니어 답변이다.

### "Spring Event로 계속 갈지, Kafka 같은 MQ로 갈아탈지 — 기준은?"

Spring Event는 **한 프로세스 안**의 결합도 낮추기 도구다. 이벤트가
메모리에만 존재하므로 서버가 죽으면 유실되고, 다른 서비스(프로세스)에는
전달할 수 없다. 갈아타는 신호는: 소비자가 다른 프로세스/서비스일 때,
이벤트 유실이 허용되지 않을 때(내구성 — 브로커가 디스크에 저장),
소비 속도를 발행 속도와 분리해야 할 때(버퍼링), 재처리/리플레이가
필요할 때. 반대로 같은 프로세스 안의 부수 작업 분리가 목적이라면
MQ는 과투자다 — 아웃박스 + MQ 조합은 그 신뢰성이 실제 요구사항일
때 꺼내는 카드다.

---

## 한 줄 요약

Spring Event는 기본이 동기·같은 트랜잭션이라 결합도만 낮출 뿐 실행
흐름은 직접 호출과 같고, @TransactionalEventListener(AFTER_COMMIT)는
"트랜잭션에 참여하지 못하는 외부 시스템은 커밋 확정 후에만 건드린다"는
원칙을 코드로 강제해 거짓 알림·거짓 캐시를 막는다 — 대신 커밋 뒤의
리스너 실패에는 롤백이 없으므로, 수용(유계 불일치)→재시도→보상→아웃박스의
스펙트럼에서 요구사항에 맞는 방어선을 고르는 것까지가 설계다.
