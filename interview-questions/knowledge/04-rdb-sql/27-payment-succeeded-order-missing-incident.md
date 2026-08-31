# "결제됐는데 주문이 없다" 정합성 사고 — 원인을 좁히는 순서와 DB 관점의 재발 방지

> 핵심 관전 포인트: **이 증상의 뿌리는 하나다 — 돈의 원장(PG)과 주문의
> 원장(우리 DB)은 서로 다른 시스템이고, PG 승인은 우리 트랜잭션의 롤백으로
> 되돌아오지 않는다.** 그래서 원인 후보는 "PG에 진실이 생긴 뒤 우리 DB에
> 진실이 안 남는 경로" 여섯 가지로 열거된다 — **(a)** `@Transactional`
> 안에서 승인을 호출하고 그 뒤 예외로 롤백 **(b)** 승인 웹훅이 주문보다
> 먼저 도착해 매칭 실패 후 폐기 **(c)** 승인 응답 직후 타임아웃·크래시로
> INSERT 미실행 **(d)** 멱등키 레코드가 "결과" 대신 "봤다"만 저장해
> 재시도가 무시됨 **(e)** 배포·failover 순간 커밋 전 커넥션 단절
> **(f)** `@Async`·이벤트 후처리에서 주문을 만들다 유실. 좁히는 첫 질문은
> "**고객이 성공 화면을 봤는가**"와 "**우리 DB에 흔적이 하나라도
> 있는가**"다. 재발 방지는 한 겹이 아니라 다섯 겹 — **① 순서 설계(PENDING
> 선생성 → 트랜잭션 밖 승인 → 조건부 확정) ② 멱등(요청·PG·DB 유니크 세 층)
> ③ Outbox/Inbox(웹훅은 "받았다"는 사실만 먼저 확정) ④ 양방향 대사
> 배치(PG 원장 ↔ 주문 원장) ⑤ 알람(PENDING 체류 시간·불일치 건수)** —
> 이고, 각각 미완료 주문 정리 배치·키 저장소·테이블과 릴레이·PG 조회
> 비용과 의존·오탐이라는 값을 치른다. ①~③은 사고 **확률**을 줄이고
> ④⑤는 그래도 난 사고를 **대사 주기 안에 반드시 잡히는 유계(bounded)
> 불일치**로 바꾼다. 이 전부를 사람의 주의가 아니라 **ArchUnit(트랜잭션 안
> PG 호출 금지)·부분 실패 테스트·대사 배치 코드**로 고정한다.

---

## 0. 질문 + 의도

**질문**: ""결제는 성공했는데 주문 데이터가 없다"는 정합성 문제가
발생했습니다. 원인 후보와 재발 방지 설계를 설명해주세요."

**출제 의도**: rationale은 이렇게 적고 있다 — "**실제 장애 시나리오를
그대로 던져 원인 가설 수립(트랜잭션 경계, 웹훅 유실, 부분 실패)과 재발
방지 설계를 동시에 시키는 질문. 사고 대응의 전체 사이클을 수행할 수
있는지 본다.**" 즉 "Outbox 패턴을 아는가"를 묻는 자리가 아니다.
**① 증상을 받아든 순간 원인 후보를 여럿 세우고 단서로 좁혀 가는가
② 좁히는 동안에도 출혈(영향 범위·고객 피해)을 먼저 막는가 ③ 재발 방지를
"한 방"이 아니라 계층으로 설계하고 각 계층의 대가를 아는가 ④ 그 설계를
사람의 기억이 아니라 코드·배치·알람으로 고정하는가** — 이 넷이 채점
축이고, 넷을 순서대로 밟는 것이 곧 "사이클을 수행할 수 있다"는 증거다.

이 문서가 정면으로 겨냥하는 후보자의 습관 네 가지 (횡단 약점 노트 기준):

- **① 인과를 "메커니즘 사슬"로 서술하지 못하는 것.** §3은 원인 후보
  여섯 가지를 전부 **t1→t2→…의 타임라인**으로 쓴다. "트랜잭션 문제일 수
  있습니다"에서 멈추면 이 문항은 "하"다. "승인이 t3에 PG 원장에
  기록됐고, t5의 예외가 t6에 롤백을 일으켰는데 롤백은 t2·t4만 되돌리고
  t3은 못 되돌린다"까지 가야 한다.
- **② 트레이드오프를 한쪽만 말하는 것.** 고난이도는 트레이드오프 서술이
  곧 평가 대상이다. §5는 방어선 하나마다 "얻는 것"과 "**치르는 값**"을
  같은 호흡에 적는다. 값을 말하지 않은 방어선은 설계가 아니라 희망이다.
- **③ 안전망을 사람 기억에 맡기는 것.** §6은 규율이 아니라 장치다 —
  양방향 대사 배치를 코드로, "트랜잭션 안 PG 호출 금지"를 ArchUnit으로,
  부분 실패를 테스트로, 불일치 건수를 알람으로.
- **④ 목록 인출 실패.** "원인 후보 여섯 가지"(§3)와 "방어선 다섯
  겹"(§5)을 번호 붙은 목록으로 고정한다. 면접장에서 이 둘을 순서대로
  꺼낼 수 있어야 하고, §5-6의 **원인 ↔ 방어선 대응표**로 둘을 이어야 한다.

관련 문서와의 분업 — 이 문서는 **사고 → 원인 좁히기 → DB 관점의 재발
방지**에 지면을 쓴다. 롤백이 어떤 예외에서 일어나는가(프록시·unchecked
규칙)는 [07-transactional-default-behavior-rollback.md](../02-spring/07-transactional-default-behavior-rollback.md),
이벤트 리스너가 트랜잭션 phase에 어떻게 묶이고 커밋 뒤 실패에 롤백이
없다는 사실은 [16-spring-event-transactional-event-listener.md](../02-spring/16-spring-event-transactional-event-listener.md)
§4, 트랜잭션 경계를 어디에 긋는가와 Outbox의 내부(릴레이·멱등·순서)는
[22-transaction-boundary-and-domain-events.md](../03-jpa-orm/22-transaction-boundary-and-domain-events.md)
§7~§9, 트랜잭션 안 외부 호출이 DB에 끼치는 해악과 `[A]→[PG]→[B]` 쪼개기의
대가는 [16-long-transaction-harm-and-shortening.md](./16-long-transaction-harm-and-shortening.md)
§4~§5를 전제로 한다. **결제 상태 머신 자체**(상태 목록, 전이 규칙, 부분
취소·환불까지 포함한 전체 그림)는 10장 결제/정합성
([10-payment-consistency/](../10-payment-consistency/))에서 상세히 다루므로
여기서는 이 사고를 막는 데 필요한 만큼만 개요로 쓴다.

## 1. 무대 고정 — 두 개의 원장, 그리고 롤백이 못 건드리는 것

먼저 증상을 정확히 진술한다. "결제는 성공했는데 주문이 없다"는 **PG의
원장에는 승인 레코드가 있는데 우리 DB의 `orders`에는 대응하는 확정
주문이 없다**는 뜻이다. 돈은 빠져나갔고 물건은 안 나간다. 고객은 카드사
승인 문자와 함께 "주문 내역 없음"을 본다. CS가 가장 먼저 알게 되고,
개발팀은 대개 그 다음에 안다 — 이것 자체가 §5-5(알람)가 필요한 이유다.

이 사고를 낳는 전형적 코드를 하나로 고정한다. 문서 끝까지 이 무대를
쓴다.

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    @Transactional
    public OrderResponse placeOrder(PlaceOrderRequest req) {
        stockService.decrease(req.items());                       // ① 재고 차감 (UPDATE → 행 락)
        PgApproval approval = pgClient.approve(req.paymentKey(), req.amount());  // ② PG 승인 (외부 HTTP)
        Order order = orderRepository.save(Order.create(req, approval));         // ③ 주문 INSERT
        couponService.use(req.couponId());                        // ④ 쿠폰 사용 처리
        return OrderResponse.of(order);
    }
}
```

겉보기엔 "전부 한 트랜잭션이니 안전"하다. 여기서 두 가지를 못 박아야
이후의 모든 원인 후보가 보인다.

**첫째, PG는 우리 트랜잭션의 참여자가 아니다.** `@Transactional`이 긋는
경계 안에 있는 것은 **우리 DB 커넥션 하나**뿐이다. ②의 HTTP 요청이
PG에 도달해 승인이 처리되는 순간, 그 사실은 **PG의 DB에 커밋**된다.
그 뒤 우리 쪽에서 무엇이 롤백되든 PG의 커밋은 그대로다. 롤백은 "우리
DB의 ①③④를 없던 일로" 만들 수 있을 뿐, **②를 없던 일로 만드는 수단이
우리에겐 없다.** (XA/2PC로 묶으면 되지 않느냐는 반론은 §7 꼬리질문에서
다룬다 — 결론만 말하면 PG는 XA 리소스가 아니고, 설령 된다 해도 응답
유실 문제는 남는다.)

**둘째, 외부 호출의 결과는 성공·실패 둘이 아니라 셋이다 — 성공 / 실패 /
불명(不明).** 요청을 보냈는데 응답이 안 오면(타임아웃, 커넥션 끊김, 프로세스
사망) PG가 승인을 처리했는지 안 했는지 우리는 모른다. 이 세 번째 상태를
"실패"로 취급하는 코드가 이 사고의 절반을 만든다.

이 두 사실 위에서 증상을 세 갈래로 나눠 두면 원인 좁히기가 빨라진다:

- **(i) `orders`에 행이 아예 없다** — INSERT가 실행되지 않았거나 롤백됐다.
- **(ii) PENDING(또는 유사 중간 상태)으로 남아 있다** — 승인까진 갔는데
  확정 단계가 안 돌았다. 이미 §5-1 구조라면 이 갈래로 온다.
- **(iii) FAILED로 잘못 마킹돼 있다** — 승인을 실패로 오판했다(불명을
  실패로 취급).

"주문 데이터가 없다"는 말을 들으면 먼저 **(i)인지 (ii)(iii)인지**를 DB에서
확인한다. 이게 첫 SQL이다.

## 2. 사고 대응 사이클 여섯 단계 — 이 문서의 골격

rationale이 말하는 "전체 사이클"을 여섯 칸으로 고정한다. 면접에서는
이 순서를 먼저 말하고 각 칸을 채우는 것이 가장 안전한 답변 구조다.
**원인을 모르는 상태에서도 ②③은 진행할 수 있다는 점**이 중요하다 —
원인 규명이 끝날 때까지 고객 피해를 방치하는 것이 가장 나쁜 대응이다.

1. **탐지** — 어떻게 알았나(CS 문의인가, 대사 배치 알람인가). CS로
   알았다면 그 자체가 관측 공백이다. → §5-5, §6-4
2. **영향 범위 산정** — 언제부터, 몇 건, 얼마. SQL로 숫자를 만든다. 우리
   DB에 흔적이 없으면 PG 거래내역이 기준이 된다. → §4
3. **임시 조치** — 출혈 차단(원인이 진행 중이면 결제 진입 차단·기능
   플래그)과 고객 복구(주문 수동 생성 vs 취소·환불)를 분리해 결정한다.
   증거(로그, PG 콘솔 이력)를 먼저 보존한다. → §4
4. **근본 원인** — 원인 후보 여섯을 세우고 단서로 좁힌다. → §3
5. **재발 방지** — 방어선 다섯 겹 중 뚫린 겹과 없던 겹을 식별해 설계한다.
   각 겹의 대가를 명시한다. → §5, 코드는 §6
6. **회고** — 타임라인, 탐지까지 걸린 시간, 왜 방어선이 없었나, 액션
   아이템에 담당·기한, 재발 시 잡아낼 지표. → §6-5

면접에서 "원인 후보와 재발 방지"만 물었어도 ②③⑥을 짧게라도 붙이는
것이 "사이클을 수행할 수 있다"는 신호다.

## 3. 원인 후보 여섯 가지 — 각각을 타임라인으로

§1의 코드와 그 주변(웹훅 핸들러, 멱등 필터, 비동기 리스너, 인프라)에서
"PG에 진실이 생긴 뒤 우리 DB에 진실이 안 남는" 경로를 전부 적는다.
각 후보는 **사건의 순서**로 쓴다. 이 순서를 말할 수 있어야 "그 원인이
왜 이 증상을 만드는지"를 설명한 것이다.

### 3-1. (a) 트랜잭션 경계 오류 — 승인이 트랜잭션 안에 있고, 승인 뒤 예외로 롤백

```text
t1  BEGIN                         (@Transactional placeOrder 진입, 커넥션 1개 점유)
t2  UPDATE stock ...              → 재고 행 배타 락 획득 (커밋까지 유지)
t3  pgClient.approve()            → PG 서버가 승인을 처리하고 PG DB에 커밋  ← 되돌릴 수 없는 사건
t4  INSERT INTO orders ...        → 주문 행 기록 (아직 커밋 전)
t5  couponService.use()           → 쿠폰이 t1~t5 사이에 다른 요청에서 소진됨 → IllegalStateException
t6  프록시가 RuntimeException 감지 → ROLLBACK
    → t2, t4 가 전부 취소된다. t3 은 그대로다.
결과  PG = 승인 / orders = 없음 / 재고 = 원복 / 고객 화면 = 500 에러 + 카드 승인 문자
```

t5의 예외는 무엇이든 될 수 있다 — 쿠폰 검증, 배송지 검증, `order_no`
유니크 충돌(`DataIntegrityViolationException`), 다른 트랜잭션과의 데드락
희생, 재고 행 락 대기 시간 초과(`innodb_lock_wait_timeout`). 그리고 PG가
느린 날엔 **PG 응답 자체가 t5를 만든다**: PG가 8초 걸리면 그동안 재고
락과 커넥션을 쥔 채 대기하고, 트랜잭션 타임아웃이나 뒤이은 SQL의 락
대기 실패가 예외를 던져 롤백된다 — "PG가 느려지는 날에만 결제 유실이
늘어난다"는 패턴은 거의 이 사슬이다(DB 쪽 해악은
[16-long-transaction-harm-and-shortening.md](./16-long-transaction-harm-and-shortening.md)
§2 참고).

**단서**: 앱 에러 로그에 "승인 성공" 로그 직후 수백 ms 뒤 예외 스택.
`orders`에는 행이 없지만 **`AUTO_INCREMENT` 값은 롤백돼도 되돌아오지
않으므로 ID에 구멍이 남는다** — 사고 시각 부근의 ID 갭이 "INSERT까지는
갔다가 롤백됐다"는 DB 쪽 증거다.

한 가지 변형을 같이 알아 둔다. t5가 **checked 예외**였다면 기본 규칙상
롤백되지 않고 **커밋**된다 — 이때는 주문이 남으므로 이 증상이 아니라
"주문은 있는데 쿠폰 처리는 안 된" 반대 증상이 된다
([07-transactional-default-behavior-rollback.md](../02-spring/07-transactional-default-behavior-rollback.md)
§2). 예외 종류에 따라 증상이 갈린다는 사실 자체가 "롤백 규칙을 모르면
사고 유형을 못 맞춘다"는 뜻이다.

### 3-2. (b) 웹훅 유실·순서 역전 — 승인 웹훅이 주문보다 먼저 와서 매칭 실패 후 폐기

PG 연동은 보통 두 채널이 병행한다 — 우리가 부르는 **승인 API(동기)**와
PG가 우리를 부르는 **웹훅(비동기)**. 웹훅은 "승인이 일어났다"는 통지이고,
PG는 웹훅을 **매우 빠르게**, 그리고 **순서 보장 없이** 보낸다.

```text
t1  고객이 PG 결제창에서 인증 완료
t2  PG → 우리 서버  POST /webhooks/pg  {paymentKey, orderNo, status=DONE}     (t1 직후, 수십 ms)
t3  웹훅 핸들러: orderRepository.findByOrderNo(orderNo) → 없음 (아직 주문을 안 만들었다)
    → "매칭 실패" 로그 → 200 OK 응답                                        ← PG는 "전달 성공"으로 간주, 재전송 없음
t4  클라이언트 → 우리 서버  POST /orders/confirm  (결제창에서 돌아온 뒤 승인·주문 생성 요청)
    (A) 이 요청이 안 온다 — 고객이 브라우저를 닫음 / 네트워크 끊김 / 앱 백그라운드 전환
    (B) 이 요청이 왔지만 처리 중 실패 — (a)(c)(e) 중 하나로 이어짐
결과  PG = 승인 / orders = 없음 / 웹훅은 이미 버려져서 두 번째 기회도 없음
```

변형: 웹훅 핸들러가 5xx를 돌려주면 PG는 재시도하지만 **재시도 횟수와
간격은 PG가 정한다.** 그 창 안에 우리 배포가 겹치거나, 웹훅 엔드포인트가
새 버전에서 경로·인증 방식이 바뀌어 4xx를 돌려주면 PG는 재시도를 멈춘다.
**웹훅을 "받아서 곧바로 처리"하는 구조 자체가 (b)를 만든다** — 처리 실패와
수신 실패를 구분하지 못하기 때문이다.

**단서**: 웹훅 수신 로그에 "order not found" + 200 응답. PG 관리자 콘솔의
웹훅 전송 이력이 "성공"으로 찍혀 있음. 고객은 결제창 뒤 화면을 못 봤거나
에러를 봤다.

### 3-3. (c) 부분 실패 — 승인은 됐는데 응답 수신 후(또는 직전) 앱이 죽거나 타임아웃

```text
t1  pgClient.approve() 요청 전송
t2  PG: 승인 처리 완료 → PG DB 커밋 → 응답 전송 시작
t3  (i)  우리 쪽 read timeout(예: 3초) 만료 → SocketTimeoutException
         → 클라이언트 코드가 "실패"로 판단 → 주문 INSERT 안 함 / 예외로 롤백 / FAILED 마킹
    (ii) 응답은 받았지만 INSERT 전에 프로세스 사망 — OOMKilled, 배포 SIGTERM 후 강제 종료, 노드 축출
결과  PG = 승인 / orders = 없음 (또는 FAILED — 증상 (iii))
      로그 = 타임아웃 예외 한 줄, 또는 로그가 갑자기 끊기고 재시작 로그
```

핵심은 §1의 두 번째 사실이다 — **타임아웃은 실패가 아니라 "불명"이다.**
PG는 승인했는데 응답만 늦게 온 것일 수 있다. 이 상태를 실패로 단정하고
FAILED로 마킹하거나 아무 기록도 남기지 않으면, 나중에 PG 원장과 맞춰 볼
때만 드러난다.

**단서**: `SocketTimeoutException`/`ResourceAccessException` 로그와 PG
콘솔의 승인 시각이 거의 일치. 또는 로그 절단 + 컨테이너 재시작
이벤트(`OOMKilled`, 배포 롤아웃 시각).

### 3-4. (d) 멱등키 충돌 — 멱등 레코드가 "결과" 대신 "봤다"만 저장해 재시도가 무시됨

멱등키는 중복 결제를 막는 필수 장치인데, **잘못 설계하면 이 사고의 원인이
된다.** 전형적인 구현은 요청 진입 시 멱등 테이블에 키를 남기고 같은 키가
또 오면 튕겨내는 필터다.

```text
t1  클라이언트 → POST /orders  (Idempotency-Key: K)
    멱등 필터: idempotency 테이블에 K = IN_PROGRESS INSERT  (REQUIRES_NEW — 비즈니스 트랜잭션과 별개)
t2  비즈니스 로직: pgClient.approve() → 승인 성공
t3  주문 INSERT 중 예외 (배송지 검증 등 RuntimeException) → 비즈니스 트랜잭션 롤백
    → 그러나 K 레코드는 별도 트랜잭션이라 IN_PROGRESS 로 그대로 남는다
t4  클라이언트: 500 을 받고 같은 K 로 재시도 (정석대로 — 멱등키의 목적이 재시도니까)
t5  멱등 필터: "K 는 처리 중" → 409 Conflict. 비즈니스 로직에 진입조차 못 한다
결과  PG = 승인(t2) / orders = 없음 / 이후 모든 재시도 = 409. 로그에는 "duplicate idempotency key" 뿐
```

변형: t3에서 K를 `FAILED`로 마킹하고 그 실패 응답을 캐시해 두는 구현이면,
재시도는 캐시된 실패 응답을 그대로 받는다. 어느 쪽이든 원인은 같다 —
**멱등 레코드가 "이 키를 봤다"만 기억하고, 그 키로 실제 어떤 결과가
확정됐는지(PG 승인 여부)를 함께 저장·판단하지 않으며, 실패한 시도의
키를 다시 열어 주지 않는다.** 멱등 레코드와 비즈니스 결과가 원자적으로
묶이지 않은 것이 구조적 결함이다.

**단서**: 멱등 저장소에서 해당 키의 상태가 `IN_PROGRESS`/`FAILED`. 서버
로그에 409 또는 "duplicate key" 반복. 클라이언트 로그에 재시도 흔적.

### 3-5. (e) 배포·failover 순간 커넥션 단절 — 커밋 직전에 DB가 바뀌었다

```text
t1  pgClient.approve() 성공
t2  INSERT INTO orders ... 전송
t3  COMMIT 요청 전송
    이 순간 DB failover(마스터 교체) 또는 배포로 커넥션 종료
    (α) 커밋 전에 단절 → 트랜잭션 통째로 사라짐 → orders 없음
    (β) 커밋 요청은 갔는데 응답 전 단절 → DB는 커밋했을 수도, 아닐 수도
        → 드라이버는 CommunicationsException → 앱은 "실패"로 판단해 고객에게 에러
    (γ) 커밋됐지만 비동기 복제라 마지막 커밋이 승격된 리플리카에 없음 → 승격 후 그 주문은 존재하지 않는다
결과  특정 시각(배포·failover 창)에 불일치가 군집으로 발생
```

(β)는 (c)와 같은 "불명" 문제가 **DB 쪽에서** 일어난 것이다. (γ)는 인프라
설정의 문제라 애플리케이션 코드만 봐서는 영원히 원인을 못 찾는다 —
반동기 복제(semi-sync)가 아니면 failover는 마지막 몇 건을 잃을 수 있다는
사실을 알아야 한다. 이 후보는 "내 코드 밖에서 벌어지는 일"이라 후보
목록에서 가장 잘 빠진다(4장 마지막 고난이도 문항 "failover 중
애플리케이션 동작"과 같은 뿌리).

**단서**: 사고 건들의 시각이 배포 이벤트·failover 이벤트와 정확히 겹침.
`CommunicationsException`, `Connection is closed`, `The last packet
successfully received` 류 로그가 같은 시각에 묶여 있음.

### 3-6. (f) 비동기 후처리에서 주문 생성 — `@Async`·이벤트 리스너가 조용히 죽었다

"승인은 빨리 응답하고 주문 생성은 뒤에서" 하려고 주문 생성을 이벤트로
뺀 구조다. 결합도는 낮아졌지만 **주문이라는 진실을 메모리 위 이벤트에
맡긴 것**이다.

```text
t1  결제 승인 컨트롤러: pgClient.approve() 성공
    → publishEvent(PaymentApprovedEvent) → 고객에게 200 OK "결제 완료"
t2  @Async @EventListener onPaymentApproved → orderService.create()
t3  (i)   실행기 큐가 유계면 거부(RejectedExecutionException) — void 메서드라 호출자에게 전파 안 됨,
          AsyncUncaughtExceptionHandler 가 로그만 남기고 끝
    (ii)  큐가 무계면 메모리에 쌓여 있다가 재시작·배포 때 프로세스와 함께 소멸
    (iii) @TransactionalEventListener(AFTER_COMMIT) 로 선언했는데 발행 시점에 트랜잭션이 없어 리스너가 아예 호출되지 않음
    (iv)  리스너 안에서 예외 — 비동기라 재시도도, 롤백도, 호출자 통지도 없음
결과  고객은 성공 화면을 봤다 / PG = 승인 / orders = 없음
```

(iii)은 [16-spring-event-transactional-event-listener.md](../02-spring/16-spring-event-transactional-event-listener.md)
§5-3의 함정 그대로다. 그리고 이 후보만 **고객이 성공 화면을 본다** —
§3-7 좁히기의 첫 갈림길이 여기서 나온다.

**단서**: 응답 로그는 200인데 주문 없음. `AsyncUncaughtExceptionHandler`
로그, 실행기 거부 카운트, 재시작 시각과의 상관.

### 3-7. 좁히기 — 단서에서 후보로

여섯 후보를 한 번에 조사하지 않는다. **두 질문으로 절반을 자른다.**

**첫 질문: 고객이 성공 화면을 봤는가, 에러를 봤는가.** 성공을 봤다면
응답은 정상 반환됐다는 뜻이므로 **(f)**가 최우선이고, 응답 후 커밋
누락인 (e)(β)를 다음으로 본다. 에러를 봤다면 (a)(c)(d)(e)(α)이고,
결제창 뒤 화면 자체를 못 봤다면 (b)(A)다.

**둘째 질문: 우리 DB에 흔적이 하나라도 있는가.** `orders`뿐 아니라
`payment`, 멱등 테이블, outbox, 웹훅 로그 테이블까지 본다.

```sql
-- 흔적 탐색 — 주문번호·결제키·고객 ID 어느 것으로든
SELECT 'orders' AS src, id, status, created_at FROM orders            WHERE order_no = :orderNo
UNION ALL
SELECT 'payment',      id, status, created_at FROM payment           WHERE payment_key = :paymentKey
UNION ALL
SELECT 'idem',         id, status, created_at FROM idempotency_record WHERE idem_key = :idemKey;
```

- **아무것도 없다** → (a) 롤백, (c)(ii) 크래시, (e)(α)(γ). 이때 ID 갭과
  에러 로그 시각으로 (a)를 먼저 확인한다.
- **멱등 레코드만 `IN_PROGRESS`/`FAILED`** → (d).
- **PENDING 주문이 있다** → §5-1 구조에서 확정 단계가 안 돈 것: (c)(e),
  또는 웹훅 (b)로 확정하려 했는데 실패.
- **FAILED 주문이 있다** → 불명을 실패로 취급한 (c)(i).

그다음 **단발인가 군집인가**를 본다. 특정 시각에 몰려 있으면 (e)나 PG
장애·웹훅 장애 (b)이고, 산발적이면 코드 경로의 문제 (a)(c)(d)(f)다.

| 단서 | 가리키는 후보 |
|---|---|
| 승인 성공 로그 직후 예외 스택, `orders` ID 갭 | (a) |
| 웹훅 로그 "order not found" + 200, PG 콘솔 전송 성공 | (b) |
| `SocketTimeoutException` / 로그 절단 + 재시작 이벤트 | (c) |
| 멱등 레코드 `IN_PROGRESS`·`FAILED`, 409 반복 | (d) |
| 배포·failover 시각과 일치, `CommunicationsException` 군집 | (e) |
| 고객은 성공 화면, 응답 200, 비동기 예외 핸들러 로그 | (f) |

면접에서 "여섯 가지 다 조사하겠습니다"는 답이 아니다. **어떤 단서로 어떤
후보를 먼저 자르는지**가 사고 대응 경험의 증거다.

## 4. 영향 범위 산정과 임시 조치 — 원인을 몰라도 지금 할 수 있는 것

### 4-1. 영향 범위 — 숫자를 만드는 SQL

"몇 건, 얼마, 언제부터"가 없으면 임시 조치의 크기도, 회고의 심각도도
정할 수 없다. 여기서 §5-1 구조의 유무가 갈린다.

**우리 쪽에 결제 기록(`payment`)이 남는 구조라면** 우리 DB만으로 양방향
불일치를 셀 수 있다.

```sql
-- 방향 1: 결제는 승인인데 주문이 없거나 확정이 아닌 건 (돈은 받았는데 물건이 안 나감)
SELECT p.payment_key, p.order_no, p.amount, p.approved_at, o.status AS order_status
FROM payment p
LEFT JOIN orders o ON o.order_no = p.order_no
WHERE p.status = 'APPROVED'
  AND p.approved_at BETWEEN :from AND :to          -- 하한 = 배포 시각 / PG 장애 공지 시각 / 첫 CS 접수 시각 중 가장 이른 것
  AND (o.id IS NULL OR o.status <> 'CONFIRMED');

-- 방향 2: 주문은 확정인데 승인 결제가 없는 건 (돈은 안 받았는데 물건이 나감)
SELECT o.order_no, o.total_amount, o.confirmed_at
FROM orders o
LEFT JOIN payment p ON p.order_no = o.order_no AND p.status = 'APPROVED'
WHERE o.status = 'CONFIRMED'
  AND o.confirmed_at BETWEEN :from AND :to
  AND p.id IS NULL;

-- 방향 3 (가산점 포인트): 둘 다 있는데 금액이 다른 건 — 부분 취소·쿠폰 재계산 버그가 여기서 드러난다
SELECT o.order_no, o.total_amount, p.amount
FROM orders o JOIN payment p ON p.order_no = o.order_no
WHERE o.status = 'CONFIRMED' AND p.status = 'APPROVED'
  AND o.total_amount <> p.amount
  AND o.confirmed_at BETWEEN :from AND :to;
```

**§1의 원본 구조처럼 우리 쪽에 아무 흔적도 남지 않는다면** 우리 DB로는
영향 범위를 **셀 수 없다.** 이때 기준은 PG 원장이다 — PG 거래내역
API나 정산 파일을 받아 임시 테이블에 적재하고 우리 주문과 대조한다.

```sql
-- PG 거래내역을 pg_tx_snapshot(payment_key, order_no, amount, status, approved_at) 에 적재한 뒤
SELECT s.payment_key, s.order_no, s.amount, s.approved_at
FROM pg_tx_snapshot s
LEFT JOIN orders o ON o.order_no = s.order_no AND o.status = 'CONFIRMED'
WHERE s.status = 'DONE'
  AND o.id IS NULL;
```

"우리 DB에 기록이 없어서 PG 파일을 받아 대조해야 했다"는 경험 자체가
§5-1(PENDING 선생성)의 가장 강한 근거다 — **시도의 흔적이 우리 쪽에
남아야 영향 범위를 우리 손으로 잴 수 있다.**

주의: 이 쿼리들은 사고 대응 중 운영 DB에 날린다. `payment(status,
approved_at)`, `orders(status, confirmed_at)`, `orders(order_no)` 인덱스가
없으면 풀스캔이고, 사고 중에 긴 조회를 얹는 것은 2차 사고다. 대사
배치(§6-1)가 상시 도는 구조라면 이 인덱스는 이미 있어야 한다.

### 4-2. 임시 조치 — 출혈 차단과 고객 복구를 분리한다

**출혈 차단**: 원인이 **진행 중**인가부터 본다. 웹훅 장애·failover·PG
장애가 계속되고 있으면 결제 진입을 기능 플래그로 잠그거나 결제 수단을
전환한다. 산발적 코드 결함(a)(c)(d)이면 차단보다 빠른 핫픽스와 대사
빈도 상향이 낫다. 차단은 매출 손실이므로 "지금 분당 몇 건 새고
있는가"(§4-1 쿼리를 1분 창으로)와 저울질한다.

**고객 복구**: 방향 1(승인인데 주문 없음)의 각 건에 대해 **주문을 살릴
것인가, 결제를 취소할 것인가**를 정한다. 기준은 재고·배송 가능 여부와
고객 의사다 — 재고가 있고 고객이 원하면 주문을 복구(PG 승인 정보로
CONFIRMED 주문 생성), 아니면 PG 취소 API로 환불하고 안내한다. 방향
2(확정인데 결제 없음)는 배송 전이면 주문을 보류·취소, 배송 후면 추심
문제로 넘어가므로 **방향 2가 방향 1보다 먼저 막아야 하는 출혈**일 때가
많다.

**증거 보존**: 재시작·재배포 전에 앱 로그, `SHOW ENGINE INNODB STATUS`,
PG 콘솔의 웹훅·승인 이력, 배포·failover 타임라인을 캡처한다. 재시작은
원인 (e)(f)의 증거를 지운다.

## 5. 재발 방지 — 방어선 다섯 겹과 각각의 대가

한 방으로 막는 설계는 없다. 여섯 원인은 성격이 다르므로(코드 경계 /
외부 통지 / 불명 / 멱등 설계 / 인프라 / 비동기) 방어선도 계층이어야
한다. 다섯 겹을 순서대로 고정한다 — **① 순서 설계 ② 멱등 ③ Outbox/Inbox
④ 대사 배치 ⑤ 알람.** ①~③은 **사고가 나는 확률**을 줄이고, ④⑤는
**그래도 난 사고가 방치되는 시간**을 대사 주기로 제한한다. 방어선마다
"얻는 것"과 "**치르는 값**"을 같은 호흡에 적는다.

### 5-1. 방어선 ① — 순서 설계: PENDING 선생성 → 트랜잭션 밖 승인 → 조건부 확정

원칙은 두 줄이다. **되돌릴 수 없는 외부 사건(PG 승인) 전에 우리 쪽
원장에 "시도"를 먼저 남기고, 외부 사건은 트랜잭션 밖에서 일으키며,
그 결과를 조건부 UPDATE로 확정한다.** 그러면 어느 지점에서 죽어도 우리
DB에는 "PENDING 주문"이라는 흔적이 남고, 그 흔적을 보고 나중에 PG에
진실을 물을 수 있다.

```java
// after — 조율자는 트랜잭션을 열지 않는다
@Service
@RequiredArgsConstructor
public class OrderPlacementFacade {

    private final OrderTxService orderTx;   // 짧은 트랜잭션 두 개를 제공
    private final PgClient pgClient;

    public OrderResult place(PlaceOrderCommand cmd) {
        // [A] 트랜잭션 1 — 주문을 PENDING 으로 먼저 남긴다: order_no 채번, 금액 확정, idempotency_key UNIQUE
        Order pending = orderTx.createPending(cmd);

        // [PG] 트랜잭션 밖 — order_no 를 멱등키로 실어 승인 요청
        PgApproval approval;
        try {
            approval = pgClient.approve(pending.getOrderNo(), pending.getAmount());
        } catch (PgDeclinedException e) {            // 명확한 거절만 실패로
            orderTx.markFailed(pending.getId(), e.code());
            throw e;
        } catch (PgUnknownResultException e) {       // 타임아웃·커넥션 끊김 = 불명. 실패로 단정하지 않는다
            return OrderResult.processing(pending.getOrderNo());   // PENDING 그대로 → 대사 배치(§6-1)가 PG에 묻는다
        }

        // [B] 트랜잭션 2 — 조건부 확정 + 결제 기록 + Outbox
        orderTx.confirm(pending.getId(), approval);
        return OrderResult.confirmed(pending.getOrderNo());
    }
}

@Service
@RequiredArgsConstructor
public class OrderTxService {

    @Transactional
    public Order createPending(PlaceOrderCommand cmd) {
        return orderRepository.save(Order.pending(cmd));            // status = PENDING
    }

    @Transactional
    public void confirm(Long orderId, PgApproval approval) {
        // UPDATE orders SET status='CONFIRMED', confirmed_at=NOW() WHERE id=? AND status='PENDING'
        int updated = orderRepository.confirmIfPending(orderId);
        if (updated == 0) return;                                    // 이미 확정(웹훅·대사가 먼저 왔다) — 두 번 실행돼도 무해
        paymentRepository.save(Payment.approved(orderId, approval)); // payment_key UNIQUE — DB 레벨 최후 방어선
        outboxRepository.save(OutboxEvent.orderConfirmed(orderId));  // 후속(재고 확정·알림)은 Outbox 로
    }

    @Transactional
    public void markFailed(Long orderId, String reason) { ... }     // PENDING → FAILED 조건부
}
```

before와 after에서 달라진 것을 사건 순서로 다시 보면:

```text
before   BEGIN → 재고 → [PG 승인] → INSERT 주문 → 쿠폰 → COMMIT      ← 승인 뒤 어디서 죽어도 흔적 0
after    [A] INSERT PENDING → COMMIT  →  [PG 승인]  →  [B] UPDATE PENDING→CONFIRMED + payment + outbox → COMMIT
         어디서 죽어도 PENDING 이 남는다. 죽은 지점은 PENDING 의 나이와 PG 조회로 판별한다.
```

상태 머신은 이 사고를 막는 데 필요한 만큼만 — `PENDING → CONFIRMED /
FAILED / EXPIRED`. PENDING은 "PG에 물어보는 중"이라는 **정식 상태**이고,
모든 전이는 `WHERE status = 'PENDING'` 조건부 UPDATE라 두 경로(응답
경로·웹훅·대사)가 동시에 확정하려 해도 한 번만 성공한다. 전체 상태
머신(부분 취소·환불·정산 반영까지)은 10장 문서에서.

**얻는 것**: (a)를 구조적으로 제거(트랜잭션 안에 PG가 없다), (c)(e)의
결과가 "흔적 없음"에서 "PENDING 잔존"으로 바뀌어 대사가 가능해짐, 응답
경로·웹훅·대사 세 경로의 확정이 조건부 UPDATE로 멱등.

**치르는 값**:

- **미완료 주문 정리 배치가 필수다.** 결제창에서 이탈한 고객마다 PENDING
  행이 남는다. 일정 시간(PG 결제창 유효 시간 이상) 지난 PENDING을
  EXPIRED로 옮기는 배치가 필요한데, **만료 전에 반드시 PG 조회로 승인
  여부를 확인해야 한다** — 확인 없이 만료하면 "승인됐는데 EXPIRED"라는
  같은 사고를 배치가 만든다.
- **재고를 언제 잡을지 결정해야 한다.** PENDING에서 선점하면 이탈
  고객이 재고를 묶는다(TTL·해제 배치 필요). 확정 시 차감하면 승인 뒤
  품절이 날 수 있고 그때는 PG 취소(보상)를 호출해야 한다. 어느 쪽도
  공짜가 아니다 — 7장·10장의 재고 선점 문제와 이어진다.
- **쓰기 2회 + 응답 지연 소폭 증가**, 그리고 "처리 중" 응답을 클라이언트가
  다룰 수 있어야 한다(폴링 또는 완료 화면 지연).
- **원자성을 내준다.** [A] 커밋 뒤 [PG] 전에 죽으면 "승인 안 된 PENDING"이
  남는다 — 이건 새로 생긴 중간 상태이고 정리 배치가 갚는다
  ([16-long-transaction-harm-and-shortening.md](./16-long-transaction-harm-and-shortening.md)
  §4의 표와 같은 계산).

### 5-2. 방어선 ② — 멱등 세 층: 요청 / PG / DB 유니크

(d)를 막으려면 멱등을 "필터 하나"가 아니라 **세 층**으로 두고, 각 층이
"봤다"가 아니라 "**결과**"를 기억하게 한다.

- **요청 층 (클라이언트 → 우리)**: 멱등키를 `order_no`(또는 클라이언트가
  만든 키)로 받고, `orders.idempotency_key UNIQUE`로 저장한다. 같은 키가
  다시 오면 **거절하지 말고 그 키의 주문 상태를 보고 이어간다** —
  PENDING이면 PG 조회 후 확정 시도, CONFIRMED면 저장된 응답 반환, FAILED면
  새 시도 허용. 멱등 레코드를 비즈니스 트랜잭션([A])과 **같은
  트랜잭션**에 넣는 것이 (d)의 "별도 트랜잭션이라 남는다" 문제의 근본
  처방이고, `IN_PROGRESS`에는 반드시 만료 시간을 둔다.
- **PG 층 (우리 → PG)**: 승인 요청에 `order_no`를 멱등 기준으로 실어
  보낸다. 대부분의 PG는 같은 주문번호·같은 금액의 재요청에 **이전 승인
  결과를 그대로 돌려주거나** 중복 승인을 거절한다. 그래서 (c)의 "불명"
  뒤 재시도가 이중 결제가 되지 않는다.
- **DB 층 (최후 방어선)**: `payment.payment_key UNIQUE`,
  `orders.order_no UNIQUE`, 그리고 조건부 UPDATE. 위 두 층이 모두
  뚫려도 DB가 두 번째 INSERT를 거절한다. 4장 관점에서 가장 중요한
  층이다 — **애플리케이션 멱등은 버그가 날 수 있지만 유니크 제약은
  안 난다.**

```java
// before — "봤다"만 기억하는 멱등 필터
if (idemRepository.existsByKey(key)) throw new ConflictException();   // 결과가 뭐였는지 모른다
idemRepository.save(new IdemRecord(key, IN_PROGRESS));                // 비즈니스 트랜잭션과 별개

// after — 결과를 기억하고, 상태에 따라 이어간다
Optional<Order> existing = orderRepository.findByIdempotencyKey(key);
if (existing.isPresent()) {
    return switch (existing.get().getStatus()) {
        case CONFIRMED -> OrderResult.confirmed(existing.get().getOrderNo());        // 저장된 결과 반환
        case PENDING   -> resumeFromPending(existing.get());                         // PG 조회 → 확정/실패
        case FAILED, EXPIRED -> startNewAttempt(cmd);                                // 실패는 재시도를 막지 않는다
    };
}
```

**얻는 것**: 재시도가 안전해진다 — 재시도가 안전해야 (c)(e)의 "불명"
뒤에 클라이언트·대사 배치가 마음 놓고 다시 두드릴 수 있다. 멱등 없는
재시도는 이중 결제라는 반대 사고를 만든다.

**치르는 값**: 멱등 레코드 저장소와 TTL·정리 비용, 응답 캐시 크기,
그리고 **키 스코프 설계 실수의 파급** — 사용자 단위로 키를 잡으면
다른 주문의 요청이 "중복"으로 무시되고(또 다른 (d)), 너무 좁게 잡으면
중복을 못 막는다. 키 설계는 한 번 정하면 클라이언트까지 바꿔야 하는
계약이다.

### 5-3. 방어선 ③ — Outbox / Inbox: 진실은 테이블에 먼저, 처리는 그 뒤에

**Inbox(웹훅 수신 측)**가 (b)를 막는다. 웹훅 핸들러는 **처리하지 않는다.
받았다는 사실만 테이블에 남기고 200을 돌려준다.** 매칭·확정은 별도
처리기가 하고, 주문이 아직 없으면 지연 재시도한다.

```java
// before — 받자마자 처리, 실패하면 폐기
@PostMapping("/webhooks/pg")
public ResponseEntity<Void> onWebhook(@RequestBody PgWebhook w) {
    Order order = orderRepository.findByOrderNo(w.orderNo()).orElse(null);
    if (order == null) { log.warn("order not found"); return ResponseEntity.ok().build(); }  // ← (b) 의 t3
    orderTx.confirmByWebhook(order.getId(), w);
    return ResponseEntity.ok().build();
}

// after — 수신과 처리를 분리한다
@PostMapping("/webhooks/pg")
public ResponseEntity<Void> onWebhook(@RequestBody PgWebhook w, @RequestHeader("X-Signature") String sig) {
    signatureVerifier.verify(w, sig);               // 웹훅은 "통지"다 — 서명 검증 없이는 진실로 취급하지 않는다
    webhookInboxService.record(w);                  // INSERT (provider, event_id) UNIQUE — 중복 수신은 여기서 무해
    return ResponseEntity.ok().build();             // 처리 결과와 무관하게 "받았다"만 확정
}

@Scheduled(fixedDelay = 1_000)
public void processInbox() {
    for (WebhookInbox in : inboxRepository.findDue(100)) {              // next_attempt_at <= now
        Optional<Order> order = orderRepository.findByOrderNo(in.orderNo());
        if (order.isEmpty()) {                                          // 순서 역전 — 주문이 아직 없다
            in.scheduleRetry(backoff(in.attempts()));                   // 1s → 5s → 30s → 5m … 상한 초과 시 수동 큐 + 알람
            continue;
        }
        orderTx.confirmByWebhook(order.get().getId(), in);              // 조건부 UPDATE — 이미 확정이면 no-op
        in.markProcessed();
    }
}
```

**Outbox(발신 측)**는 [B] 확정 뒤 후속 처리(재고 확정, 알림, 정산 이벤트)의
유실을 막는다. 그리고 (f)에 대한 처방이 여기서 나온다 — **주문 생성은
비동기로 빼지 않는다. 비동기로 빼도 되는 것은 "주문이 확정됐다는
사실이 DB에 있고, 그 사실에서 파생되는 것"뿐이며, 그것도 메모리
이벤트가 아니라 Outbox를 거친다.** Outbox 내부(릴레이·멱등 소비·순서)는
[22-transaction-boundary-and-domain-events.md](../03-jpa-orm/22-transaction-boundary-and-domain-events.md)
§7에 있으니 여기서는 반복하지 않는다.

**얻는 것**: 웹훅 순서 역전·일시 실패가 사고가 아니라 "재시도 대기"가
된다. 후속 처리가 프로세스 사망에도 살아남는다. 두 테이블 자체가
§4-1의 영향 범위 산정에 쓸 수 있는 **흔적**이 된다.

**치르는 값**: 테이블 두 개와 처리기·릴레이라는 **운영 대상**이 는다 —
적체 모니터링, 청소 배치, 재시도 상한과 수동 큐 정책이 전부 필요하다.
처리가 비동기가 되므로 **지연**이 생기고, at-least-once라 **소비자
멱등이 필수**가 된다(②와 맞물린다). 작은 서비스에서는 이 운영 비용이
막는 사고보다 클 수 있다 — 그때는 ①②④만으로 시작하고 웹훅은 "PG
조회 트리거"로만 쓰는 축소판도 답이다.

### 5-4. 방어선 ④ — 양방향 대사 배치: 두 원장을 주기적으로 맞춘다

①②③이 전부 있어도 뚫린다 — 정리 배치의 버그, PG 쪽 장애, 우리가
생각 못 한 일곱 번째 경로. 그래서 **PG 원장과 주문 원장을 주기적으로
대조하는 배치**가 마지막 그물이다. 세 방향으로 돈다 — (1) 우리 쪽
오래된 PENDING → PG에 상태 조회 (2) PG 승인 목록 → 우리 쪽 확정 주문
존재 확인 (3) 우리 쪽 CONFIRMED → 승인 결제 존재 확인. 코드는 §6-1에
전부 적는다.

**얻는 것**: 어떤 경로로 새든 **대사 주기 안에 반드시 발견**된다. 불일치
지속 시간에 상한이 생기고, 그 상한은 배치 주기라는 **우리가 정하는
숫자**다. CS보다 먼저 안다.

**치르는 값**:

- **PG 조회 API 호출 비용과 rate limit.** PENDING이 1만 건 쌓인 날 1만 번
  조회하면 PG가 차단할 수 있다. 배치 크기·간격 조절이 필요하다.
- **PG 의존.** PG가 장애면 대사도 못 돈다. 이때는 "대사 중단"을 알람으로
  올리고 PG 복구 후 밀린 구간을 재실행하는 설계가 필요하다.
- **주기와 탐지 지연의 트레이드오프.** 1분마다 돌면 빨리 잡지만 DB·PG
  부하가 늘고, 하루 한 번이면 싸지만 하루치 CS를 먹는다. 방향 (1)은
  짧게(분 단위), 방향 (2)는 정산 파일 기준으로 길게(일 단위)가 보통이다.
- **오보정의 위험.** 자동 보정이 틀리면 대사 배치가 사고의 원인이 된다.
  자동/수동 경계를 코드로 고정해야 한다(§6-1).

### 5-5. 방어선 ⑤ — 알람: CS보다 먼저 아는 장치

관측 없이는 ④가 돌아도 아무도 안 본다. 지표는 §6-4에 적고 여기서는
원칙만 — **"결제 승인 수 vs 주문 확정 수"의 차이를 분 단위로 보고,
PENDING의 나이 분포와 대사 불일치 건수를 알람 대상으로 둔다.** 임계치는
"0건이어야 정상"인 지표(불일치 건수)와 "분포가 정상이어야 하는"
지표(PENDING 나이 p99)를 구분한다.

**치르는 값**: 오탐 — PG 결제창 체류 시간이 긴 상품군에서는 PENDING
나이 알람이 계속 울린다. 임계치를 결제창 유효 시간과 맞추고, 상품군별로
분리하는 조정 비용이 든다.

### 5-6. 원인 ↔ 방어선 대응표 — 왜 다섯 겹인가

| 원인 | 1차로 막는 방어선 | 그래도 뚫리면 |
|---|---|---|
| (a) 경계 오류 | ① 순서 설계 + ArchUnit(§6-2) | ④ 대사 |
| (b) 웹훅 역전·유실 | ③ Inbox + 지연 재시도 | ④ 대사 (PG 조회) |
| (c) 불명·크래시 | ① PENDING 흔적 + graceful shutdown | ④ 대사 |
| (d) 멱등 충돌 | ② 결과 저장·상태별 재개 | ④ 대사 |
| (e) failover | ① PENDING 흔적 + 반동기 복제 | ④ 대사 |
| (f) 비동기 유실 | 주문 생성은 동기 [A]로, 후속만 ③ Outbox | ④ 대사 |

표에서 보이듯 **④는 모든 행의 마지막 칸**이다. 그래서 "무엇부터
하겠습니까"라고 물으면 답은 ①이 아니라 **④(대사)와 ⑤(알람)**다 —
①②③은 각각 특정 원인을 막지만, ④⑤는 **원인을 모르는 사고까지** 잡기
때문이고, 지금 당장 사고가 나 있는 상황에서는 "다시 안 나게"보다 "나면
바로 알게"가 먼저다. 이것이 rationale의 "사고 대응 사이클"에서 재발
방지의 우선순위다.

## 6. 안전망을 코드로 고정 — "조심하자"가 아니라 "못 어기게"

### 6-1. 대사 배치 — 양방향 탐지 + 자동 보정 vs 수동 큐 기준

```java
@Component
@RequiredArgsConstructor
public class PaymentOrderReconciler {

    private static final Duration GRACE = Duration.ofMinutes(5);      // 정상 흐름([A]→[PG]→[B])이 끝나기에 충분한 시간
    private static final int BATCH = 200;                              // PG rate limit 과 DB 부하를 함께 고려한 크기
    private static final int CIRCUIT_BREAK = 500;                      // 이 이상이면 대사가 아니라 장애 — 멈추고 사람을 부른다

    // 방향 (1) — 우리 쪽 오래된 PENDING → PG 에 진실을 묻는다 (분 단위)
    @Scheduled(fixedDelay = 60_000)
    public void reconcilePendingOrders() {
        Instant threshold = clock.instant().minus(GRACE);
        long total = orderRepository.countPendingOlderThan(threshold);
        if (total > CIRCUIT_BREAK) { alert.critical("PENDING 폭증 — 대사 중단", total); return; }

        for (Order o : orderRepository.findPendingOlderThan(threshold, BATCH)) {   // 인덱스: orders(status, created_at)
            PgInquiry pg = pgClient.inquireByOrderNo(o.getOrderNo());
            switch (pg.status()) {
                case APPROVED -> {
                    if (pg.amount().compareTo(o.getAmount()) != 0) {                 // 금액 불일치 — 자동 보정 금지
                        manualQueue.push(o.getOrderNo(), pg, "AMOUNT_MISMATCH"); break;
                    }
                    orderTx.confirm(o.getId(), pg.toApproval());                      // 조건부 UPDATE — 멱등
                    metrics.counter("reconcile.auto_confirmed").increment();          // 0 이 아니면 어딘가 새고 있다는 뜻
                }
                case CANCELED, FAILED, NOT_FOUND -> orderTx.markFailed(o.getId(), "RECONCILED_" + pg.status());
                case IN_PROGRESS -> { /* 결제창 체류 중 — 다음 주기 */ }
            }
        }
    }

    // 방향 (2) — PG 원장 기준: 승인됐는데 우리 쪽에 확정 주문이 없는 건 (정산 API/파일, 일 단위)
    @Scheduled(cron = "0 30 4 * * *")
    public void reconcileAgainstPgLedger() {
        for (PgTransaction tx : pgClient.listApproved(yesterday())) {
            if (!orderRepository.existsConfirmedByPaymentKey(tx.paymentKey())) {
                manualQueue.push(tx.orderNo(), tx, "APPROVED_WITHOUT_ORDER");         // 우리 쪽 흔적 없음 → 자동 보정 불가
                alert.critical("결제 승인인데 주문 없음", tx);
            }
        }
    }

    // 방향 (3) — 주문은 확정인데 승인 결제가 없는 건 (돈 안 받고 물건 나가는 방향)
    @Scheduled(fixedDelay = 300_000)
    public void reconcileConfirmedWithoutPayment() {
        for (Order o : orderRepository.findConfirmedWithoutApprovedPayment(clock.instant().minus(GRACE), BATCH)) {
            PgInquiry pg = pgClient.inquireByOrderNo(o.getOrderNo());
            if (pg.status() == APPROVED) {
                paymentTx.recordMissing(o.getId(), pg);                              // 결제 기록만 빠진 것 → 자동 보정
            } else {
                manualQueue.push(o.getOrderNo(), pg, "CONFIRMED_WITHOUT_PAYMENT");   // 확정 취소는 배송·재고가 얽힘 → 사람
                alert.critical("주문 확정인데 승인 결제 없음", o.getOrderNo());
            }
        }
    }
}
```

방향 (3)의 쿼리는 §4-1 방향 2와 같은 anti-join이다:

```sql
SELECT o.*
FROM orders o
LEFT JOIN payment p ON p.order_id = o.id AND p.status = 'APPROVED'
WHERE o.status = 'CONFIRMED'
  AND o.confirmed_at < :threshold
  AND p.id IS NULL
ORDER BY o.confirmed_at
LIMIT 200;
```

**자동 보정을 허용하는 조건** — 코드에 박아 둘 다섯 가지:

1. PG가 진실을 **명확히** 답했다(`APPROVED`/`CANCELED`). `IN_PROGRESS`나
   조회 실패는 건드리지 않는다.
2. 주문번호·금액·통화가 **정확히 일치**한다.
3. 보정 동작이 **멱등**하다(조건부 UPDATE, 유니크 제약).
4. 보정 방향이 **고객이 원한 결과 쪽**이다 — PENDING→CONFIRMED는 자동,
   CONFIRMED→취소는 수동.
5. 건수가 **임계치 이하**다. 갑자기 수백 건이면 대사가 아니라 장애이므로
   멈추고 알람을 올린다 — 자동 보정이 장애를 조용히 덮어 원인 규명을
   늦추는 것을 막는다.

**수동 큐로 보내는 것**: 금액 불일치, 우리 쪽 흔적 없음(방향 2), 확정
취소 방향(방향 3의 미승인), 부분 취소·환불 진행 중, 임계치 초과. 수동
큐는 "담당자가 보는 화면"이 있어야 큐다 — 로그 한 줄은 큐가 아니다.

그리고 `reconcile.auto_confirmed` 카운터는 **0이 정상**이다. 자동 보정이
매일 몇 건씩 잡힌다면 대사가 잘 돌고 있다는 뜻이 아니라 **①②③ 어딘가가
새고 있다**는 뜻이고, 그 건들의 원인을 §3-7로 좁혀 앞 방어선을 고친다.
대사는 그물이지 처방이 아니다.

### 6-2. ArchUnit — 트랜잭션 안에서 PG를 부르지 못하게

(a)는 코드 리뷰어의 눈에 의존하면 반드시 재발한다. 컴파일 단계에서
막는다.

```java
@AnalyzeClasses(packages = "com.example")
class PaymentBoundaryRulesTest {

    @ArchTest
    static final ArchRule 트랜잭션_안에서_PG를_호출하지_않는다 =
        noMethods().that().areAnnotatedWith(Transactional.class)
            .or().areDeclaredInClassesThat().areAnnotatedWith(Transactional.class)
            .should().accessClassesThat().resideInAnyPackage("..infrastructure.pg..", "..client.pg..")
            .because("PG 승인은 롤백되지 않는다 — 트랜잭션 안에서 부르면 롤백 시 '결제됐는데 주문 없음'이 된다");

    @ArchTest
    static final ArchRule 주문_생성은_비동기_리스너에서_하지_않는다 =
        noMethods().that().areAnnotatedWith(Async.class)
            .should().accessClassesThat().haveSimpleNameEndingWith("OrderTxService")
            .because("주문이라는 진실을 메모리 위 이벤트에 맡기지 않는다 — 후속 처리만 Outbox 를 거쳐 비동기로");
}
```

한계를 같이 말한다 — `PgClient`가 인터페이스이고 구현체만 HTTP를 쓰면
"접근"으로 안 잡히므로 **패키지 규약**(`..infrastructure.pg..`)을 룰에
명시해야 하고, `TransactionTemplate` 블록 안의 호출은 애노테이션 기반
룰로는 못 잡는다. 그래서 룰은 "가장 흔한 위반을 막고 우회하려면 룰을
고쳐야 하니 논의가 강제된다"는 가치로 쓰고, 나머지는 §6-3의 테스트가
받친다. 일반적인 "트랜잭션 안 외부 I/O 금지" 룰 세트는
[16-long-transaction-harm-and-shortening.md](./16-long-transaction-harm-and-shortening.md)
§5-1에 있다.

### 6-3. 부분 실패를 테스트로 고정

"PG 승인 뒤 우리 쪽이 죽어도 흔적이 남고 대사가 복구한다"는 성질은
테스트가 지켜야 한다. 그렇지 않으면 다음 리팩터링에서 [A]와 [PG]가 다시
한 트랜잭션으로 합쳐진다.

```java
@SpringBootTest
class PaymentPartialFailureTest {

    @Test
    void PG_승인_후_확정_단계가_실패해도_PENDING이_남고_대사가_복구한다() {
        // given — PG 는 승인하고, 확정 트랜잭션은 첫 호출에 DB 장애를 흉내 낸다
        pgStub.willApprove(cmd.orderNo(), cmd.amount());
        orderTxFailure.failNextConfirmWith(new CannotCreateTransactionException("failover"));

        // when
        assertThatThrownBy(() -> facade.place(cmd)).isInstanceOf(CannotCreateTransactionException.class);

        // then — 흔적이 남아 있다 (before 구조였다면 여기서 행이 없다)
        Order o = orderRepository.findByOrderNo(cmd.orderNo()).orElseThrow();
        assertThat(o.getStatus()).isEqualTo(OrderStatus.PENDING);

        // and — 대사 배치가 PG 에 묻고 확정한다
        clock.advance(Duration.ofMinutes(6));
        reconciler.reconcilePendingOrders();
        assertThat(orderRepository.findByOrderNo(cmd.orderNo()).orElseThrow().getStatus()).isEqualTo(OrderStatus.CONFIRMED);
        assertThat(paymentRepository.findByPaymentKey(pgStub.lastPaymentKey())).isPresent();
    }

    @Test
    void 승인_웹훅이_주문보다_먼저_와도_버려지지_않고_나중에_매칭된다() {
        webhookEndpoint.receive(PgWebhook.done("ORD-1", "pk-1"));       // 주문이 아직 없다
        inboxProcessor.processInbox();                                    // 매칭 실패 → 재시도 예약, 폐기 아님
        assertThat(inboxRepository.findByEventId("evt-1").get().getStatus()).isEqualTo(PENDING_RETRY);

        orderTx.createPending(cmdFor("ORD-1"));                           // 이제 주문이 생겼다
        clock.advance(Duration.ofSeconds(5));
        inboxProcessor.processInbox();
        assertThat(orderRepository.findByOrderNo("ORD-1").get().getStatus()).isEqualTo(OrderStatus.CONFIRMED);
    }
}
```

두 번째 테스트가 (b)를, 첫 번째가 (c)(e)를 고정한다. (a)는 §6-2가,
(d)는 "같은 멱등키로 두 번 호출하면 두 번째가 PENDING에서 이어간다"는
테스트로 고정한다. **테스트 이름이 곧 사고 시나리오**여야 다음 사람이
왜 이 구조인지 안다.

### 6-4. 관측 지표와 알람 — 숫자로 본다

```sql
-- 오래된 PENDING 건수 — 0 이 아니어도 되지만 늘어나면 안 된다 (결제창 유효 시간을 임계치로)
SELECT COUNT(*) FROM orders
WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL 10 MINUTE;

-- 분 단위 승인 vs 확정 차이 — PG 승인 콜백/웹훅 수와 CONFIRMED 전이 수를 같은 창에서 비교
SELECT DATE_FORMAT(confirmed_at, '%Y-%m-%d %H:%i') AS minute, COUNT(*) AS confirmed
FROM orders WHERE confirmed_at >= NOW() - INTERVAL 30 MINUTE
GROUP BY minute;
```

알람 대상은 네 가지로 고정한다 — **① 대사 불일치 건수(방향 2·3) > 0
② `reconcile.auto_confirmed` 증가율(0이 정상) ③ PENDING 나이 p99 >
결제창 유효 시간 ④ Inbox 미처리 적체·재시도 상한 도달 건수.** 그리고
배포·failover 이벤트를 같은 대시보드에 마커로 올려 (e)의 상관을 한눈에
보게 한다. 인프라 쪽 처방도 한 줄 — `server.shutdown=graceful`과 종료
유예 시간을 두어 SIGTERM 시 진행 중인 [B]가 끝날 시간을 준다(c)(ii).

### 6-5. 회고 — 무엇을 남기나

회고 문서에 반드시 들어가야 하는 항목을 고정한다. **타임라인**(첫 발생 →
탐지 → 임시 조치 → 원인 확정 → 복구, 각 시각), **탐지까지 걸린
시간**(CS로 알았다면 그 시간이 곧 ⑤의 부재 비용), **영향**(건수·금액·고객
수, §4-1 쿼리 결과), **원인 사슬**(§3의 타임라인 형식 그대로), **왜
방어선이 없었나 / 있었는데 왜 뚫렸나**(§5-6 표에 대입), **액션
아이템**(담당·기한, "조심하자"류는 액션이 아님 — §6-1~6-4 중 무엇을
넣는지), **재발 시 잡아낼 지표**(§6-4 중 무엇이 울릴 것인가). 마지막
항목이 없는 회고는 "다음에도 CS로 알겠다"는 선언이다.

## 7. 꼬리질문 대비 포인트

### "그냥 XA/2PC로 PG까지 한 트랜잭션에 묶으면 되지 않나요?"

세 가지로 답한다. **① PG는 XA 리소스가 아니다** — 외부 HTTP API에 prepare/
commit 프로토콜을 걸 수 없다. **② 설령 된다 해도 "불명"은 남는다** —
2PC의 커밋 응답이 유실되면 코디네이터도 참여자 상태를 모르고, 그
복구가 곧 대사다. **③ 비용** — 2PC는 prepare 상태에서 락을 쥔 채 남의
응답을 기다리므로 §3-1의 "PG가 느린 날" 문제가 더 커진다. 그래서
외부 시스템과의 정합성은 원자성으로 푸는 것이 아니라 **"시도의 흔적 +
멱등 + 대사"로 최종적 일관성**을 만드는 것이 정석이다. 이 답이 있어야
"왜 Outbox·대사 같은 번거로운 걸 하느냐"에 대한 근거가 선다.

### "PENDING 주문을 먼저 만들면 재고는 언제 차감하나요? PENDING이 쌓이면요?"

두 선택지와 각각의 대가로 답한다. **PENDING에서 선점**하면 결제 중
품절이 없어 UX가 좋지만 이탈 고객이 재고를 묶으므로 **선점 TTL과 해제
배치**가 필요하고, 그 배치가 늦으면 "재고 있는데 품절 표시"가 된다.
**확정([B])에서 차감**하면 PENDING 부담은 없지만 승인 뒤 품절이 날 수
있어 **PG 취소(보상)** 경로와 고객 안내가 필요하다. 한정 수량·타임세일은
선점, 일반 상품은 확정 차감이 보통이고, 어느 쪽이든 **PENDING 정리
배치는 PG 조회 후 만료**해야 한다 — 확인 없이 만료하면 배치가 이
사고를 만든다. "PENDING이 쌓이면"에 대한 답은 "쌓이는 것 자체는
정상이고, **나이 분포**를 알람으로 본다"(§6-4)이다.

### "웹훅이 주문보다 먼저 왔습니다. 그냥 버리고 승인 API 응답으로만 처리하면 안 되나요?"

승인 API 응답 경로가 (c)(e)로 죽을 수 있기 때문에 **웹훅은 두 번째
기회**이고, 두 번째 기회를 버리는 것은 방어선 하나를 스스로 없애는
일이다. 그래서 Inbox에 "받았다"만 먼저 남기고 지연 재시도로 매칭한다.
단 반대 방향의 함정도 말한다 — **웹훅은 통지이지 진실이 아니다.**
서명 검증 없이 웹훅 본문만 믿고 확정하면 위조 요청으로 주문이 확정될
수 있으므로, 보수적인 설계는 웹훅을 "PG에 조회하라는 트리거"로만 쓰고
**확정의 근거는 항상 PG 조회 결과**로 삼는다. 그러면 웹훅 순서·중복·
위조가 전부 무해해진다.

### "대사 배치가 불일치를 찾았으면 자동으로 다 보정하면 되지, 왜 수동 큐를 두나요?" (시니어 변별 포인트)

자동 보정은 **틀렸을 때 되돌리기 어려운 방향**과 **원인을 덮어버리는
효과**라는 두 위험이 있다. 첫째, PENDING→CONFIRMED는 고객이 원한
결과라 자동이 안전하지만, CONFIRMED→취소는 배송·재고·쿠폰 복원이 얽혀
자동 취소가 새 사고를 만든다. 금액 불일치는 "어느 쪽이 맞는지"를
기계가 판단할 수 없다. 둘째, 자동 보정이 매일 조용히 수십 건을 고치고
있으면 **앞 방어선이 새고 있다는 신호가 사라진다** — 그래서
`auto_confirmed` 카운터를 "0이 정상"으로 알람에 걸고, 임계치를 넘으면
보정을 멈춘다(§6-1의 다섯 조건). 요약하면 "**진실이 명확하고, 멱등하고,
고객이 원한 방향이고, 건수가 정상 범위일 때만 자동 — 나머지는 사람**"이
기준이고, 이 기준을 **코드에** 박아야 담당자가 바뀌어도 유지된다.

### "PG 승인을 트랜잭션 밖으로 뺐더니 이번엔 '주문은 확정인데 결제 기록이 없다'가 생겼습니다." (가산점 포인트)

쪼갠 뒤에 생기는 **반대 방향 불일치**를 알고 있는지 묻는 질문이다.
[B] 안에서 `confirmIfPending` UPDATE와 `payment` INSERT가 같은
트랜잭션이면 둘 중 하나만 남을 수는 없다 — 그러므로 이 증상은 **[B]가
둘로 쪼개져 있거나**(확정은 응답 경로에서, 결제 기록은 웹훅 경로에서),
**웹훅 경로가 확정만 하고 결제 기록을 안 남기거나**, 예전 데이터
마이그레이션 잔재다. 처방은 **확정과 결제 기록을 한 트랜잭션에 두는
것**(이 둘은 순수 DB 작업이라 쪼갤 이유가 없다 — "블로킹 I/O가 없고
함께 되돌려야 하면 쪼개지 않는다"는
[16-long-transaction-harm-and-shortening.md](./16-long-transaction-harm-and-shortening.md)
§4-4의 기준)과, 그래도 새는 것을 잡는 **대사 방향 (3)**이다. 이 질문에
"양방향 대사가 그래서 필요하다"로 연결하면 §5-4를 이해한 것이다.

---

## 한 줄 요약

"결제됐는데 주문이 없다"는 **PG 원장과 우리 원장이 다른 시스템이고
롤백은 우리 쪽만 되돌린다**는 사실에서 나오는 사고이며, 원인은 **(a)
트랜잭션 안 승인 후 롤백 (b) 웹훅 순서 역전·폐기 (c) 불명을 실패로
취급 (d) 멱등 레코드가 결과 대신 "봤다"만 기억 (e) failover·배포 중 커밋
전 단절 (f) 비동기 후처리 유실** 여섯 경로로 열거해 **"고객이 성공 화면을
봤는가 / 우리 DB에 흔적이 있는가"**로 좁히고, 재발 방지는 **① PENDING
선생성 → 밖에서 승인 → 조건부 확정 ② 요청·PG·DB 유니크 세 층 멱등 ③
Inbox/Outbox ④ 양방향 대사 배치 ⑤ 알람** 다섯 겹으로 — 각각 정리
배치·키 저장소·릴레이 운영·PG 조회 비용과 의존·오탐이라는 값을 치르며
— 쌓되, 이 모든 것을 **ArchUnit·부분 실패 테스트·대사 코드·"0이 정상"인
카운터**로 못 어기게 고정해야 사고 대응 사이클이 사람의 기억이 아니라
시스템의 성질이 된다.
