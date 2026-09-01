# Outbox + CDC — DB 트랜잭션 로그를 이벤트 소스로: Kafka 발행 보장의 완성

> 핵심 관전 포인트: **DB와 Kafka는 한 트랜잭션으로 묶을 수 없으므로(이중 쓰기 문제), 이벤트를 비즈니스 변경과 같은 트랜잭션으로 outbox 테이블에 기록하고 별도 경로로 발행한다. CDC는 그 발행 경로를 DB의 트랜잭션 로그 구독으로 구현한 것 — PostgreSQL이라면 WAL(Write-Ahead Log)을 논리적 디코딩으로 행 단위 변경으로 풀어내고, Debezium 커넥터가 복제 슬롯을 통해 그 스트림을 받아 outbox INSERT를 Kafka로 흘린다. 커밋이 WAL에 남는 순간 발행이 예약된 것과 같아서 유실이 없고, 폴링과 달리 DB 부하·지연이 거의 없다. 보장은 전 구간 at-least-once — 커넥터 재시작 시 중복 발행이 가능하므로 멱등 컨슈머가 세트이고, 순서는 논리적 디코딩이 커밋 순서대로 내보내는 성질 + aggregate ID 파티션 키로 지킨다. 운영의 급소는 복제 슬롯이다 — 슬롯은 아직 안 읽은 WAL을 서버가 지우지 못하게 붙잡으므로, 커넥터가 오래 죽어 있으면 데이터가 사라지는 게 아니라 디스크가 차서 DB 전체가 멈춘다.**

---

## 0. 질문 + 의도

**질문**: "Kafka로 이벤트를 발행하는 서비스에서 \"DB 커밋은 됐는데 발행이 실패\"하는 문제를 어떻게 해결하나요? (Transactional Outbox + CDC)"

**출제 의도**: DB와 메시지 브로커라는 두 시스템에 걸친 원자성 문제의 표준 해법을 아는지 본다. 이 패턴의 필요성을 스스로 설명할 수 있으면 분산 정합성의 핵심을 이해한 것이다.

> 이중 쓰기 문제의 구조, AFTER_COMMIT의 한계, outbox 테이블·폴링 릴레이의 Spring 구현은 `02-spring/23-transactional-outbox-pattern.md`에 정리되어 있다. 이 문서는 **Kafka 관점 — CDC 연계, 발행 보장 체인, 순서와 중복** — 에 집중한다.

## 1. 문제 요약 — 커밋과 발행 사이엔 항상 틈이 있다

### 1-1. 이중 쓰기 문제

가장 흔한 코드부터 보자.

```java
// before: 커밋 후 발행 — 이 두 줄 사이 어디서든 죽을 수 있다
@Transactional
public void completeOrder(Long id) { ... }   // ① DB 커밋

kafkaTemplate.send("order-completed", event); // ② 발행 — ①과 ② 사이
                                              //    크래시/브로커 장애 → 이벤트 증발
```

순서를 어떻게 바꿔도 안 풀린다.

- **커밋 → 발행**: ① 다음 ② 직전에 프로세스가 죽거나 Kafka가 장애면, DB에는 완료된 주문이 있는데 이벤트는 세상에 없다. **유실**이다.
- **발행 → 커밋**: 이벤트는 나갔는데 뒤이은 커밋이 롤백되면, 일어나지 않은 일에 대한 이벤트가 떠돌게 된다. 컨슈머는 존재하지 않는 주문을 정산한다. **거짓 이벤트**다.

원인은 순서가 아니라 구조다. **DB와 Kafka는 서로 다른 시스템이고, 두 시스템에 대한 쓰기를 하나의 원자적 단위로 묶어 줄 공통의 트랜잭션이 없다.** 이것을 **이중 쓰기(dual write) 문제**라고 부른다.

그렇다면 방향은 하나다. **원자성의 단위를 DB 하나로 모아야** 한다. Kafka로 나갈 메시지 자체를 DB에 쓰는 것으로 바꾸면, 두 시스템에 대한 쓰기가 한 시스템에 대한 두 쓰기가 되고 로컬 트랜잭션이 그것을 묶어 준다.

### 1-2. Outbox — 보낼 편지함을 DB 안에 둔다

**아웃박스(outbox)는 말 그대로 "보낼 편지함"이다.** 이벤트를 Kafka로 바로 쏘는 대신, 비즈니스 변경과 **같은 로컬 트랜잭션**으로 같은 DB의 outbox 테이블에 INSERT해 둔다.

```sql
CREATE TABLE outbox (
    id             bigserial    PRIMARY KEY,   -- 이 값이 곧 이벤트 고유 ID가 된다
    aggregate_type varchar(50)  NOT NULL,      -- 예: 'ORDER' — 목적지 토픽 라우팅에 쓴다
    aggregate_id   varchar(50)  NOT NULL,      -- 예: 주문 ID — 메시지 키(파티션 키)가 된다
    event_type     varchar(50)  NOT NULL,      -- 예: 'OrderCompleted'
    payload        jsonb        NOT NULL,      -- 이벤트 본문. jsonb라 컬럼 추가 없이 스키마가 진화한다
    created_at     timestamptz  NOT NULL DEFAULT now()
);
```

```java
// after: 발행을 "예약"으로 바꿔 한 트랜잭션 안에 넣는다
@Transactional
public void completeOrder(Long id) {
    Order order = orderRepository.findById(id).orElseThrow();
    order.complete();                     // ① 비즈니스 변경

    outboxRepository.save(Outbox.of(      // ② 발행 예약 — 같은 DB, 같은 트랜잭션
            "ORDER", id.toString(), "OrderCompleted", toPayload(order)));
    // ①과 ②는 함께 커밋되거나 함께 롤백된다.
    // "주문은 완료됐는데 이벤트는 없는" 상태가 구조적으로 불가능해졌다.
}
```

여기까지가 Outbox이고, 남은 문제는 하나다. **"outbox에 쌓인 레코드를 누가, 어떻게 Kafka로 옮기느냐."** 이 옮기는 역할을 **릴레이(relay)**라고 부르고, 구현 방식이 두 가지다.

- **폴링(polling)**: 스케줄러가 짧은 주기로 `SELECT ... WHERE published_at IS NULL ... FOR UPDATE SKIP LOCKED`를 돌려 미발행 행을 집어 발행하고 발행 완료를 마킹한다. 스케줄러와 DB만 있으면 되어 도입이 쉽다.
- **CDC(Change Data Capture)**: DB가 이미 쓰고 있는 트랜잭션 로그를 구독해 INSERT를 실시간으로 감지한다.

이 문서의 본론은 후자다.

## 2. CDC — 폴링 대신 DB의 트랜잭션 로그를 구독한다

### 2-1. CDC란 무엇인가

**CDC(Change Data Capture, 변경 데이터 캡처)**는 DB에 SELECT를 날려 "뭐 바뀐 거 있어?"를 물어보는 대신, **DB가 자기 내구성을 위해 이미 쓰고 있는 트랜잭션 로그를 읽어 변경을 감지**하는 방식이다.

대표 구현이 **Debezium**이고, Kafka Connect의 소스 커넥터로 동작한다. PostgreSQL을 쓰면 Debezium PostgreSQL 커넥터를 쓴다.

```text
[App] --같은 TX--> [PostgreSQL: 주문 UPDATE + outbox INSERT] --커밋--> [WAL에 기록]
                                                                          |
                                                            논리적 디코딩 |
                                                                          v
                                    [Debezium 커넥터] <--- 복제 슬롯으로 구독
                                           |
                                           v  (outbox 레코드를 도메인 이벤트로 변환)
                                    [Kafka: order-events 토픽] --> [컨슈머]
```

이 그림의 가운데 두 단계 — **WAL, 논리적 디코딩, 복제 슬롯** — 가 PostgreSQL CDC의 전부이므로 하나씩 정의하고 간다.

### 2-2. WAL이란 — 그리고 왜 그대로는 못 읽는가

PostgreSQL은 테이블 데이터 파일을 곧바로 고치지 않는다. **"무엇을 어떻게 바꿀 것인지"를 먼저 로그 파일에 순차로 기록하고, 실제 데이터 페이지는 그 뒤에 바꾼다.** 이 로그가 **WAL(Write-Ahead Log, 미리 쓰는 로그)**이다. 이름 그대로 데이터 변경보다 로그를 "먼저(ahead) 쓴다(write)".

왜 이렇게 하는가. **크래시 복구** 때문이다. 서버가 갑자기 죽어도 WAL만 다시 재생하면 커밋된 변경을 전부 복원할 수 있다. 커밋이란 사실상 "이 트랜잭션의 WAL 기록이 디스크에 안전하게 내려갔다"는 뜻이다. 그리고 스탠바이 서버로의 **복제(replication)**도 이 WAL을 그대로 흘려보내 구현된다.

여기까지 보면 "그럼 WAL을 읽으면 되겠네"인데, 그대로는 안 된다. **WAL에 담긴 것은 물리적 변경 기록**이기 때문이다. "테이블 orders의 몇 번째 파일 블록의 몇 번째 바이트부터를 이런 값으로 바꿔라" 같은 형태다.

크래시 복구와 물리 복제에는 이걸로 충분하다 — 어차피 똑같은 구조의 파일에 그대로 덮어쓰면 되니까. 하지만 CDC가 원하는 것은 **"orders 테이블의 id=8471 행이 status를 PAID에서 SHIPPED로 바꿨다"**라는 행 단위의 의미다. 물리적 블록 기록만 봐서는 어떤 테이블의 어떤 행이 어떻게 바뀌었는지 알 수 없다.

### 2-3. 논리적 디코딩 — 물리적 로그를 행 단위 변경으로 풀어 준다

그 간극을 메우는 PostgreSQL의 기능이 **논리적 디코딩(logical decoding)**이다.

**WAL의 물리적 기록을 읽어 시스템 카탈로그와 대조해 가며 행 단위 변경(INSERT / UPDATE / DELETE)으로 풀어 주는(decode) 기능**이다. "물리적으로 기록된 것을 논리적 의미로 디코딩한다"는 뜻에서 붙은 이름이다. 이 기능이 있어서 비로소 CDC 도구가 WAL을 읽을 수 있게 된다.

켜는 방법은 설정 한 줄이다.

```conf
# postgresql.conf — 서버 재시작이 필요하다
wal_level = logical        # 기본값은 replica
```

`wal_level`을 `logical`로 올리면 PostgreSQL이 **WAL에 논리적 디코딩에 필요한 추가 정보를 더 실어 쓴다.** 즉 공짜가 아니라 **WAL 볼륨이 늘어나는 대가**가 있다. 뒤에서 볼 디스크 문제와도 직결되므로 기억해 둔다.

디코딩 결과를 어떤 형식으로 내보낼지는 **출력 플러그인(output plugin)**이 정한다. PostgreSQL 10부터 `pgoutput`이 서버에 기본 내장돼 있고, Debezium PostgreSQL 커넥터도 이걸 기본으로 쓴다. 예전에는 `wal2json` 같은 확장을 서버에 따로 설치해야 했는데, 지금은 그럴 필요가 없다.

논리적 디코딩의 성질 중 이 문서에서 두 번 이상 값을 하는 것이 하나 있다. **커밋된 트랜잭션만, 커밋 순서대로 내보낸다.** 진행 중인 트랜잭션의 변경은 커밋될 때까지 모아 뒀다가 커밋 시점에 한꺼번에 흘리고, 롤백된 트랜잭션의 변경은 **아예 나오지 않는다.** 즉 1-1의 "거짓 이벤트" 문제가 CDC 경로에서는 구조적으로 발생할 수 없다.

### 2-4. 복제 슬롯 — 어디까지 읽었는지를 서버가 기억한다

논리적 디코딩을 쓰려면 **복제 슬롯(replication slot)**이 반드시 있어야 한다.

**복제 슬롯은 "이 구독자가 WAL을 어디까지 읽고 확인했는지"를 PostgreSQL 서버 쪽에 남겨 두는 표식**이다. 슬롯 하나가 구독자 하나에 대응하고, 구독자가 접속을 끊었다가 다시 붙으면 슬롯에 적힌 위치부터 이어서 받는다. Debezium이 재시작해도 처음부터 다시 읽지 않는 것이 이 덕분이다.

그런데 **여기서 이 문서 전체에서 가장 중요한 성질이 나온다.**

> **슬롯이 존재하는 한, PostgreSQL은 그 슬롯이 아직 확인하지 않은 WAL을 절대 지우지 않는다.**

원래 PostgreSQL은 체크포인트가 끝나면 더 이상 필요 없어진 WAL 파일을 재활용하거나 삭제한다. 그런데 슬롯이 "나는 아직 여기까지밖에 못 읽었다"고 잡고 있으면, 그 지점 이후의 WAL은 전부 보존 대상이 된다.

이 성질을 어떻게 읽느냐가 시니어와 주니어를 가른다. **이건 유실 방지 보장의 근거이자 동시에 가장 큰 운영 위험의 근원이다.**

- **좋은 면**: 커넥터가 죽어 있는 동안에도 그 사이의 WAL이 보존되므로, 복구되면 반드시 이어서 읽을 수 있다. "커밋됐는데 발행 안 됨"이 구조적으로 사라진다.
- **위험한 면**: 커넥터가 오래 죽어 있으면 WAL이 무한정 쌓인다. **데이터가 사라지는 게 아니라 디스크가 찬다.** 이 이야기는 4절 꼬리질문에서 본격적으로 다룬다.

슬롯 상태는 `pg_replication_slots` 뷰로 본다. 운영에서 반드시 감시해야 할 뷰다.

```sql
SELECT slot_name,
       active,        -- false면 커넥터가 지금 붙어 있지 않다는 뜻
       wal_status,    -- reserved / extended / unreserved / lost
       pg_size_pretty(
           pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
       ) AS unconsumed_wal   -- 슬롯이 아직 소비하지 못하고 붙잡고 있는 WAL의 양
  FROM pg_replication_slots;
```

`confirmed_flush_lsn`은 "구독자가 여기까지 확실히 받았다고 확인해 준 지점"이고, `pg_current_wal_lsn()`은 "서버가 지금 WAL을 쓰고 있는 지점"이다. **둘의 차이가 곧 슬롯 지연(lag)**이고, 이 값이 계속 커지면 곧 디스크가 찬다는 신호다.

### 2-5. Debezium PostgreSQL 커넥터 설정

이제 조각을 맞춘다. pgoutput을 쓰려면 **퍼블리케이션(publication)** — 어떤 테이블의 변경을 논리 복제 스트림에 실을지 정하는 정의 — 이 필요하다.

```sql
-- outbox 테이블의 변경만 스트림에 싣는다
CREATE PUBLICATION outbox_pub FOR TABLE outbox;
```

```properties
connector.class=io.debezium.connector.postgresql.PostgresConnector
plugin.name=pgoutput                     # PostgreSQL 10+ 내장 출력 플러그인
slot.name=outbox_slot                    # 커넥터 전용 복제 슬롯 이름
publication.name=outbox_pub
table.include.list=public.outbox         # outbox 테이블만 캡처한다
skipped.operations=u,d                   # outbox는 INSERT만 의미가 있다. UPDATE/DELETE는 무시
heartbeat.interval.ms=10000              # 슬롯 위치를 주기적으로 전진시킨다 (3-4에서 설명)

transforms=outbox
transforms.outbox.type=io.debezium.transforms.outbox.EventRouter
```

한 가지 짚어 둘 점. `skipped.operations`로 DELETE를 무시하므로 outbox 테이블의 `REPLICA IDENTITY`(DELETE·UPDATE 시 어떤 옛 값을 WAL에 실을지 정하는 설정)를 건드릴 필요가 없다. 기본값인 기본 키 기준으로 충분하다.

### 2-6. Outbox Event Router — 테이블 변경을 "이벤트"로 바꾸는 조각

Debezium이 기본으로 내보내는 것은 "outbox 테이블의 행이 이렇게 바뀌었다"는 **테이블 변경 메시지**다. `before`/`after`/`source`/`op` 같은 CDC 고유의 봉투에 싸여 나온다. 그대로 쓰면 컨슈머가 CDC 내부 포맷에 결합된다.

Debezium의 **outbox event router**를 걸면 이 봉투를 벗겨 준다. Kafka Connect에서 메시지를 중간에 변형하는 장치를 **SMT(Single Message Transform)**라고 부르는데, 그중 하나다.

- outbox 행의 `payload` 컬럼만 꺼내 이벤트 본문으로 만들고,
- `aggregate_type`으로 목적지 토픽을 라우팅하고 (예: ORDER → `order-events`),
- `aggregate_id`를 **메시지 키**로 실어 파티션 키가 되게 한다.

결과적으로 컨슈머는 CDC의 존재를 모른 채 평범한 도메인 이벤트를 받는다. **"인프라 선택이 소비자 계약에 새어나가지 않게 한다"**는 점을 언급하면 좋다. 나중에 CDC에서 폴링으로 되돌리거나 그 반대로 바꿔도 컨슈머 코드는 그대로다. (가산점 포인트)

### 2-7. CDC의 성질과 대가

DB 입장에서 Debezium은 **복제 클라이언트 하나가 더 붙은 것**과 같다. 스탠바이 서버가 WAL을 받아 자기 데이터를 갱신하듯, Debezium은 WAL을 받아 Kafka로 흘린다. 이 관점이 서면 CDC의 성질이 자연스럽게 따라온다.

- **유실 없음**: 커밋이 WAL에 기록되는 것 자체가 PostgreSQL 내구성의 일부다. WAL에 남았고 슬롯이 그 지점을 붙잡고 있는 이상, 커넥터는 (지금이든 재시작 후든) 반드시 읽는다 — "커밋됐는데 발행 안 됨"이 구조적으로 사라진다.
- **DB 부하·지연 최소**: 폴링처럼 주기적 SELECT가 없다. WAL 읽기는 순차 접근이라 부담이 적고, 커밋에서 발행까지의 지연이 폴링 주기가 아니라 로그 전파 속도(보통 밀리초 단위)로 줄어든다.
- **애플리케이션 코드에서 릴레이가 사라짐**: 스케줄러, `FOR UPDATE SKIP LOCKED`, 발행 마킹 코드가 전부 인프라(커넥터)로 이동한다.

대가는 운영 부담이다. Kafka Connect 클러스터와 Debezium 커넥터라는 새 구성요소의 배포·모니터링·장애 대응이 생기고, 여기에 PostgreSQL 쪽의 `wal_level` 변경과 복제 슬롯 감시라는 DB 운영 책임까지 추가된다.

이벤트가 적고 몇 초 지연이 허용되면 폴링으로 시작하고, 규모가 커지면 CDC로 진화시키는 경로가 일반적이다.

## 3. 발행 보장 체인과 운영

### 3-1. 어디까지가 보장이고 어디부터가 내 몫인가

"Outbox + CDC를 쓰면 끝"이 아니다. 메시지가 지나는 구간마다 보장 수단이 다르다는 것을 체인으로 설명할 수 있어야 한다.

| 구간 | 유실 방지 수단 | 중복 발생 지점 |
|---|---|---|
| 앱 → DB(outbox) | 로컬 트랜잭션 원자성 | 없음 (롤백되면 이벤트도 없음) |
| DB → Debezium | WAL 내구성 + 복제 슬롯이 미확인 WAL을 보존 | **커넥터 재시작 시 재발행** |
| Debezium → Kafka | Connect 내부 프로듀서 acks=all | ack 유실 시 재전송 |
| Kafka → 컨슈머 | 처리 후 오프셋 커밋 | 커밋 전 리밸런싱/장애 시 재처리 |

두 번째 줄을 정확히 이해해야 한다. Debezium은 "WAL의 어디까지 읽어 Kafka에 넘겼는지"를 LSN(Log Sequence Number, WAL 안의 위치를 가리키는 좌표)으로 저장하는데, **Kafka로의 발행과 이 오프셋 저장이 원자적이지 않다.** 발행은 했는데 오프셋 저장 전에 커넥터가 죽으면, 재시작 후 같은 구간을 다시 읽어 **같은 이벤트가 한 번 더 발행**된다.

즉 전 구간의 보장은 **at-least-once(최소 한 번)**다. 그래서 결론은 언제나 같다.

```java
// 컨슈머: outbox 이벤트 ID 기반 멱등 처리 — CDC를 써도 이건 생략 불가
@KafkaListener(topics = "order-events")
@Transactional
public void consume(OutboxMessage msg) {
    if (!processedEventRepository.tryInsert(msg.eventId())) return; // 중복 스킵
    settlementService.settle(msg.payload());
    // 처리 이력 INSERT와 비즈니스 처리를 같은 TX로 -> 소비 측 원자성
}
```

여기서 `msg.eventId()`가 무엇인지가 깔끔하다. **outbox 테이블의 `id`(bigserial PK)가 그대로 이벤트 고유 ID**가 된다. 발행 경로와 멱등 키 체계가 한 번에 정리되는 조합이다(`11-idempotent-consumer-implementation.md`).

**생산 측(Outbox + CDC)은 유실 방지, 소비 측(멱등 컨슈머)은 중복 제거** — 이 역할 분담까지 말해야 완결된 답변이다. 한쪽만으로는 절대 완성되지 않는다.

### 3-2. 순서 — 커밋 순서가 그대로 파티션 순서가 된다

폴링 릴레이를 멀티 인스턴스로 띄우면 같은 aggregate의 이벤트를 서로 다른 인스턴스가 집어 발행 순서가 흔들릴 수 있었다. `SKIP LOCKED`로 서로 다른 행을 집게 만들어도, 먼저 집은 쪽이 늦게 발행하면 순서가 뒤집힌다.

CDC는 이 문제가 구조적으로 없다. 이유가 세 겹이다.

**(1) 논리적 디코딩은 커밋 순서대로 내보낸다.** 2-3에서 본 성질이다. 여러 트랜잭션이 동시에 진행돼도 스트림에는 커밋된 순서대로 한 줄로 늘어선다.

**(2) 하나의 복제 슬롯은 하나의 연결만 소비할 수 있다.** 그래서 Debezium PostgreSQL 커넥터는 태스크를 하나만 쓴다 — 병렬로 나눠 읽는 일이 애초에 불가능하다. 순차 읽기가 강제된다.

**(3) outbox router가 `aggregate_id`를 메시지 키로 실어 준다.** Kafka는 같은 키의 메시지를 같은 파티션에 보내므로, 같은 주문의 이벤트는 같은 파티션에 쌓인다. 그리고 Kafka는 파티션 안에서 순서를 보장한다.

```
DB 커밋 순서
   -> (논리적 디코딩) 커밋 순서 그대로의 단일 스트림
   -> (커넥터 태스크 1개) 순차 발행
   -> (aggregate_id 메시지 키) 같은 주문은 같은 파티션
   -> (Kafka 파티션 내 순서 보장) 컨슈머가 커밋 순서대로 받는다
```

이 사슬을 끝까지 이어 설명할 수 있으면 좋다. 어느 한 고리라도 빠지면 순서가 깨진다 — 예를 들어 메시지 키를 안 실으면 라운드로빈으로 파티션이 흩어져 마지막 고리가 끊긴다.

### 3-3. outbox 테이블 정리 — INSERT 직후 DELETE해도 되지만, VACUUM을 생각해야 한다

폴링 방식은 발행 여부를 `published_at` 같은 컬럼으로 마킹하고 발행 완료된 행을 주기적으로 지워야 했다. 릴레이가 테이블을 읽어야 하니 행이 남아 있어야 하기 때문이다.

CDC는 다르다. **커넥터는 테이블이 아니라 WAL에서 읽으므로, 테이블에 행이 남아 있을 필요가 없다.**

```java
@Transactional
public void completeOrder(Long id) {
    order.complete();
    Outbox row = outboxRepository.save(Outbox.of("ORDER", ...));
    outboxRepository.delete(row);   // 같은 트랜잭션에서 바로 지운다
    // INSERT 기록은 이미 WAL에 남았으므로 이벤트는 정상 발행된다.
    // 커넥터는 skipped.operations=d 설정으로 DELETE를 무시한다.
}
```

INSERT와 DELETE를 같은 트랜잭션에서 해도 **INSERT의 WAL 기록은 이미 쓰였기 때문에** 이벤트는 정상적으로 발행된다. 테이블은 논리적으로 항상 비어 있게 되어, 폴링 방식의 고질병인 outbox 테이블 비대화가 사라진다. (가산점 포인트)

**다만 PostgreSQL에서는 여기에 한 가지를 더 얹어야 한다.** PostgreSQL은 MVCC(다중 버전 동시성 제어)로 동작하기 때문에, **DELETE는 행을 즉시 지우지 않는다.** "이 행 버전은 죽었다"고 표시할 뿐이고, 실제 공간 회수는 **VACUUM**(보통 백그라운드의 autovacuum)이 나중에 돌면서 한다.

그래서 실제로 벌어지는 일은 이렇다.

```
논리적으로:  SELECT count(*) FROM outbox;  ->  0

물리적으로:  테이블 파일에는 죽은 튜플(dead tuple)이 계속 쌓인다.
             인덱스에도 그 튜플들을 가리키는 항목이 남는다.
             autovacuum이 따라잡지 못하면 -> 테이블·인덱스 비대화(bloat)
```

초당 수백 건의 INSERT + DELETE가 일어나는 outbox 테이블은 autovacuum의 기본 설정으로는 따라잡기 버거울 수 있다. 대응은 둘이다.

- **테이블 단위로 autovacuum을 공격적으로 조정한다.** `ALTER TABLE outbox SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 100);` 같은 식으로, 이 테이블만 훨씬 자주 청소하게 만든다.
- **즉시 DELETE 대신 짧은 보존 + 파티션 드롭.** `created_at` 기준 레인지 파티셔닝을 걸고 며칠 지난 파티션을 통째로 `DROP TABLE`한다. 파티션 드롭은 파일이 통째로 사라지므로 죽은 튜플도 VACUUM 부담도 없다. 이 선택은 4절 꼬리질문에서 볼 최악 시나리오 대비와도 맞물린다.

**"CDC를 쓰면 outbox를 비워도 된다"는 것과 "그래도 PostgreSQL에서는 죽은 튜플이 남는다"는 것을 함께 말할 수 있으면 DB 운영까지 아는 사람으로 읽힌다.**

### 3-4. 챙겨야 할 운영 포인트

**커넥터 생존 모니터링.** 커넥터가 죽으면 발행이 조용히 멈춘다 — 애플리케이션 로그에는 아무 에러도 안 나오는 장애다. Kafka Connect의 태스크 상태(`RUNNING` / `FAILED`)와, 2-4에서 본 슬롯 지연에 알람을 건다. 특히 `pg_replication_slots.active`가 `false`인 상태가 지속되면 그것만으로도 즉시 알람 대상이다.

**슬롯 지연 감시가 최우선 지표다.** 이유는 두 가지다. 첫째, 지연이 커진다는 것은 발행이 밀리고 있다는 뜻이다. 둘째이자 더 중요한 이유는, 그 지연이 곧 **DB 서버 디스크를 갉아먹고 있다**는 뜻이기 때문이다(4절 꼬리질문).

**낮은 트래픽 테이블의 함정 — 하트비트.** 슬롯의 `confirmed_flush_lsn`은 커넥터가 자기가 관심 있는 변경을 받아 처리했을 때 전진한다. 그런데 outbox 테이블에는 하루 종일 아무 변경이 없고 **다른 테이블에만 대량 쓰기가 일어나는** 상황을 생각해 보자. 커넥터에게 넘길 것이 없으니 슬롯 위치는 그대로인데, WAL은 다른 테이블 때문에 계속 쌓인다. **아무 문제가 없어 보이는데 디스크만 차는 상황**이다. Debezium의 `heartbeat.interval.ms`를 켜면 커넥터가 주기적으로 하트비트를 주고받으며 슬롯 위치를 전진시켜 이 함정을 막는다.

**스키마 변경 주의.** outbox 테이블의 컬럼 구조는 커넥터 설정(event router가 읽는 컬럼 이름)과 결합돼 있다. 이벤트 본문 자체는 `payload` jsonb 안에서 버전 필드를 두고 진화시키고, 테이블 DDL은 커넥터 영향 검토 후 진행한다.

## 4. 꼬리질문 대비 포인트

### "폴링 릴레이 대신 CDC를 선택하는 기준은?"

트레이드오프 축은 셋이다 — **지연, DB 부하, 운영 복잡도.**

폴링은 스케줄러와 DB만으로 끝나 도입이 쉽지만, 발행이 폴링 주기만큼 지연되고 주기적 SELECT가 DB를 계속 때린다. 이벤트가 없어도 조회는 계속 돌아간다.

CDC는 지연이 밀리초급이고 DB 부하가 거의 없지만, Kafka Connect + Debezium이라는 인프라 운영이 새로 생긴다. PostgreSQL이라면 여기에 `wal_level=logical`로 인한 WAL 볼륨 증가와 복제 슬롯 감시 책임까지 얹힌다.

이벤트 빈도가 낮고 몇 초 지연이 허용되면 폴링, 이벤트가 많고 지연 요구가 빡빡하며 커넥터를 운영할 역량(모니터링 체계 포함)이 있으면 CDC다. **"우리 팀이 그 인프라를 감시하고 복구할 수 있는가"까지 판단 기준에 넣는 것**이 실무적인 답이다. 감시하지 못할 CDC는 폴링보다 위험하다 — 조용히 멈추고, 멈춘 채로 DB 디스크를 채우기 때문이다.

### "Debezium이 재시작하면 이벤트가 중복 발행되지 않나요?"

된다 — 그리고 그게 정상 동작이다.

커넥터는 Kafka로의 발행과 자신의 LSN 오프셋 저장을 원자적으로 할 수 없으므로, 발행 후 오프셋 저장 전에 죽으면 재시작 시 같은 구간을 다시 읽어 재발행한다. **Outbox + CDC의 보장은 exactly-once가 아니라 at-least-once**이고, 중복 제거는 소비 측 몫이다.

구체적으로는 outbox 행의 PK를 이벤트 고유 ID로 삼아, 컨슈머가 처리 이력 테이블에 유니크 제약으로 `ON CONFLICT DO NOTHING` INSERT를 시도하고 0행이면 스킵하는 멱등 컨슈머를 세트로 구현한다.

한 가지 덧붙이면 좋다. **CDC가 exactly-once를 못 만든다는 것은 결함이 아니라 분산 시스템의 일반적 한계**다. 두 시스템에 걸친 "발행"과 "발행 기록"을 원자적으로 묶을 방법이 없다는 점에서, 이건 1-1의 이중 쓰기 문제가 한 층 위에서 다시 나타난 것이다.

### "이벤트 순서는 어떻게 보장되나요? 폴링 릴레이와 차이는?"

논리적 디코딩이 **커밋된 트랜잭션만 커밋 순서대로** 단일 스트림으로 내보내고, 복제 슬롯 하나는 연결 하나만 소비할 수 있어 커넥터 태스크가 하나로 강제되므로, 발행 순서가 커밋 순서와 일치한다. 여기에 outbox router가 `aggregate_id`를 메시지 키로 실으면 같은 aggregate의 이벤트가 같은 파티션에 순서대로 쌓인다.

폴링 릴레이는 멀티 인스턴스일 때 같은 aggregate의 이벤트를 다른 인스턴스가 나눠 집으면 발행 순서가 흔들릴 수 있어, `FOR UPDATE SKIP LOCKED`나 단일 릴레이 같은 추가 장치가 필요했다. **CDC는 이 문제를 설정이 아니라 구조로 없앤다.**

### "커넥터가 며칠 죽어 있으면 어떻게 되나요? WAL이 계속 쌓이는 건 아닌가요?" (시니어 변별 포인트)

**여기가 PostgreSQL CDC 운영의 급소다.** 그리고 MySQL을 쓰던 사람이 가장 크게 헷갈리는 지점이기도 하다 — **문제의 방향이 정반대**이기 때문이다.

**MySQL이라면 "데이터가 사라지는" 문제다.** binlog는 보존 기간이 지나면 서버가 알아서 지운다. 커넥터가 보존 기간보다 오래 죽어 있으면 읽을 로그가 없어져 그 구간의 이벤트는 CDC 경로로 복구 불가다.

**PostgreSQL은 정반대로 "지워지지 않아서" 문제가 된다.** 2-4에서 본 성질 때문이다 — **복제 슬롯이 아직 안 읽은 WAL을 붙잡고 있으면 PostgreSQL은 그것을 절대 지우지 않는다.** 커넥터가 죽어 있는 동안 데이터는 안전하게 보존되지만, 그 대가로 WAL이 무한정 쌓인다.

그리고 WAL은 `pg_wal` 디렉터리, 즉 **DB 서버의 데이터 디스크**에 쌓인다.

```
커넥터 다운
   -> 슬롯의 confirmed_flush_lsn이 멈춘다
   -> 그 지점 이후의 WAL이 삭제 대상에서 제외된다
   -> pg_wal 디렉터리가 계속 커진다
   -> 디스크가 가득 찬다
   -> PostgreSQL은 WAL을 더 쓸 수 없으면 쓰기를 중단한다
   -> ★ DB 전체가 멈춘다
```

**이벤트 파이프라인 하나가 죽었을 뿐인데 서비스 전체 장애가 된다.** 이 인과를 말할 수 있느냐가 이 질문의 핵심이다.

여기에 한 가지를 더 얹으면 이해가 완성된다. **WAL은 데이터베이스 클러스터 전체가 공유한다.** outbox 테이블에 트래픽이 하나도 없어도, 다른 테이블의 쓰기가 WAL을 채운다. 즉 **슬롯이 붙잡는 양은 outbox 트래픽이 아니라 DB 전체 쓰기량에 비례한다.** 하루에 50GB의 WAL을 만드는 DB에서 커넥터가 3일 죽어 있으면 150GB가 붙잡히는 식이다.

**대응은 세 단계다.**

**(1) 예방 — 슬롯 지연 감시가 최우선이다.** `pg_replication_slots`에서 `active`와 미소비량을 주기적으로 확인하고 알람을 건다.

```sql
SELECT slot_name, active, wal_status,
       pg_size_pretty(
           pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
       ) AS unconsumed_wal
  FROM pg_replication_slots;
```

`active = false`가 지속되면 커넥터가 안 붙어 있다는 뜻이고, 미소비량이 우상향하면 디스크가 차고 있다는 뜻이다. 여기에 더해 3-4의 하트비트 설정으로 "트래픽이 없어서 슬롯이 안 움직이는" 함정도 함께 막는다.

**(2) 상한 — `max_slot_wal_keep_size`로 안전장치를 건다.** PostgreSQL 13부터 있는 설정으로, **슬롯이 붙잡을 수 있는 WAL 양의 상한**이다. 기본값은 `-1`(무제한)이라 아무것도 안 걸려 있다.

```conf
max_slot_wal_keep_size = 100GB
```

이 값을 넘어서면 PostgreSQL은 슬롯을 지키는 대신 **WAL을 지우고 그 슬롯을 무효화(invalidate)**한다. `pg_replication_slots.wal_status`가 `lost`로 바뀌고, 그 슬롯은 더 이상 쓸 수 없다.

**(3) 트레이드오프를 정확히 말한다.** 상한을 걸지 않으면 커넥터 장애가 DB 전면 장애로 번지고, 상한을 걸면 그 한도를 넘긴 순간 슬롯이 죽어 그 구간 이벤트의 연속성이 끊긴다. **"DB 전체를 지킬 것인가, 이벤트 스트림의 연속성을 지킬 것인가"의 맞바꿈**이다.

대부분의 팀은 **상한을 거는 쪽**을 택한다. DB가 멈추면 이벤트고 뭐고 없기 때문이다. 대신 상한을 감시 알람 임계값보다 넉넉히 잡아, 상한에 닿기 한참 전에 사람이 개입할 시간을 확보한다.

**슬롯이 무효화됐다면 복구 경로는 이렇다.** 커넥터를 새 슬롯으로 다시 시작하면 Debezium은 **초기 스냅샷**을 다시 뜬다 — 대상 테이블의 현재 내용 전체를 읽어 이벤트로 내보내는 동작이다. 그런데 **outbox 테이블을 3-3의 "INSERT 직후 DELETE" 전략으로 운영했다면 테이블이 비어 있으므로 스냅샷으로 복구할 것이 없다.** 그 구간의 이벤트는 원본 도메인 테이블(orders 등)을 기준으로 재구성하는 별도 배치를 짜야 한다.

이런 최악 시나리오까지 고려해 **"즉시 DELETE 대신 며칠치 보존 후 파티션 드롭"**을 선택하는 팀도 있다. 죽은 튜플 관리 부담을 지는 대신, 슬롯이 죽어도 outbox 테이블 자체가 복구용 원장 역할을 해 주기 때문이다.

**보장의 전제 조건이 무엇이고, 그 전제가 깨졌을 때 무슨 일이 벌어지며, 어느 쪽 손실을 택할 것인지까지 말하는 것이 시니어 답변이다.**

### "그냥 Kafka 트랜잭션(transactional producer)으로 DB 커밋과 묶으면 안 되나요?"

Kafka 트랜잭션은 **"여러 파티션·토픽에 걸친 발행 + 컨슈머 오프셋 커밋"을 원자적으로 묶는 기능**, 즉 **Kafka 세계 안의 원자성**이다.

외부 DB의 트랜잭션과는 묶이지 않으므로 이중 쓰기 문제를 못 푼다. "Kafka 트랜잭션을 커밋했는데 DB 커밋이 롤백되는" 조합은 여전히 가능하다.

DB와 브로커를 아우르는 분산 트랜잭션(2PC, 2단계 커밋)이 이론적 대안이지만, Kafka는 XA(분산 트랜잭션 표준 인터페이스)를 지원하지 않고, 지원한다 해도 참여자가 잠금을 쥔 채 코디네이터를 기다리는 블로킹 구조라 가용성·성능 비용이 크다.

그래서 실무 표준은 **원자성을 로컬 트랜잭션 하나로 모으는 Outbox**다. "두 시스템을 묶을 방법을 찾는" 대신 **"묶어야 할 두 시스템을 하나로 만드는"** 발상의 전환이 이 패턴의 본질이다.

---

## 한 줄 요약

커밋과 발행 사이의 틈은 코드로 못 막는다 — 이벤트를 같은 트랜잭션으로 outbox에 남기고, Debezium이 PostgreSQL의 WAL을 논리적 디코딩으로 풀어 복제 슬롯을 통해 읽어 Kafka로 흘리면 "WAL에 남은 커밋은 반드시 발행된다"가 성립하며, 남는 중복(at-least-once)은 outbox PK를 키로 한 멱등 컨슈머로, 순서는 논리적 디코딩의 커밋 순서 + aggregate ID 파티션 키로 지킨다 — 다만 그 보장을 떠받치는 복제 슬롯이 곧 최대 위험이므로, 슬롯 지연을 감시하고 `max_slot_wal_keep_size`로 상한을 걸어 "커넥터 장애가 DB 디스크를 채워 서비스 전체를 멈추는" 최악을 막는 것까지가 운영의 완성이다.
