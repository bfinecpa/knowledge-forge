# 동시성 갱신 4가지 접근 비교 — 낙관적 락 / 비관적 락 / 원자적 UPDATE / 분산 락, "임계 구간에 무엇을 넣을 것인가"

> 핵심 관전 포인트: 이 질문은 **정답이 없는 문제이고, 그래서 트레이드오프를 정리해 말하는 능력 자체가 채점 대상**이다. 흔한 답은 "충돌이 드물면 낙관적, 잦으면 비관적"인데 그건 정의를 바꿔 말한 것에 가깝다. **더 정확한 축은 "임계 구간(critical section)에 무엇이 들어가는가"** 다. 읽고·계산하고·쓰는 과정이 **SQL 한 문장으로 압축되면 원자적 UPDATE가 기본값**이고, 여러 필드를 읽어 애플리케이션에서 계산해야 하는데 충돌이 드물면 **낙관적 락**, 계산이 복잡하고 충돌이 잦아 재시도 비용이 크면 **비관적 락**(대가는 커넥션 점유·데드락), **임계 구간에 DB 밖 자원이 끼어 있으면**(외부 결제 호출, 여러 DB에 걸친 갱신, 멀티 인스턴스 스케줄러) **분산 락**이다. 그리고 반드시 붙여야 할 두 문장이 있다. ① **Redis 분산 락은 정합성 보증 장치가 아니라 부하 최적화 장치다** — TTL 만료·노드 장애·GC 정지로 언제든 두 스레드가 동시에 임계 구간에 들어갈 수 있으므로 **정합성의 최종 보증은 항상 DB**(`where qty >= 1` + `CHECK (qty >= 0)`)여야 한다. ② **이건 사지선다가 아니다** — 실무의 답은 대개 **분산 락으로 대기를 밀어내고, 원자적 UPDATE로 갱신하고, CHECK 제약으로 바닥을 막는** 층 쌓기다.

---

## 0. 질문 + 의도

**질문**: "재고 차감/포인트 차감 같은 동시성 갱신 문제를 ① 낙관적 락(`@Version`) ② 비관적 락(`select ... for update`) ③ 원자적 UPDATE(`update ... set qty = qty - 1 where id = ? and qty >= 1`) ④ 분산 락(Redis) 각각으로 풀 때의 트레이드오프를 비교하고, 어떤 상황에서 무엇을 고를지 말해주세요."

**출제 의도**: rationale은 이렇게 적고 있다 — "**정답이 없는 문제에서 트레이드오프(충돌률, 처리량, 데드락 위험, 인프라 의존)를 정리해 말하는 능력 자체를 평가한다.** 실무의 기술 선택 회의를 15분으로 압축한 질문이며, 결제 도메인 채용에서는 사실상 필수 검증 항목." 즉 이 문항에서 요구되는 것은 네 가지 기법의 정의 암기가 아니다. **① 네 방식을 하나의 축으로 꿰어 비교할 수 있는가 ② 자기가 고른 것의 대가까지 같은 호흡에 말할 수 있는가 ③ 그 대가를 감당할 수 있는 이유를 근거로 댈 수 있는가** — 세 가지가 전부다.

**함정 세 개**:

- **"무엇이 가장 좋은가"로 답하는 것.** 이 질문에 "분산 락이 제일 낫습니다"라고 답하면, 기법을 아는 사람이 아니라 **선택 회의를 해본 적 없는 사람**으로 읽힌다. 네 가지는 서열이 아니라 **서로 다른 자원을 소모하는 서로 다른 도구**다.
- **"충돌 빈도" 하나로 선택 기준을 잡는 것.** 방향은 맞지만 절반이다. 충돌이 아무리 드물어도 임계 구간에 외부 PG 호출이 들어 있으면 낙관적 락 재시도는 **결제를 두 번 때리는 코드**가 된다. 축을 하나 더 세워야 한다.
- **가장 좋아 보이는 선택지의 대가를 안 붙이는 것.** 자기가 고른 것에는 대가를 말하면서, **면접관이 "그거 좋네요"라고 인정해준 것에 대해서는 양면 서술이 멈추는** 패턴이 흔하다. 특히 원자적 UPDATE는 "임계 구간이 가장 짧다"는 칭찬을 듣는 순간 포기하는 것을 말해야 하는 자리다(§2).

---

## 1. 하나의 무대, 네 가지 풀이 — 같은 다섯 칸으로 대칭 비교

비교를 말로만 하면 흐려진다. **똑같은 재고 차감을 네 번 구현해놓고, 매번 같은 다섯 칸을 채우는 방식**으로 간다.

> **다섯 칸**: ① 코드 ② 나가는 SQL ③ 락이 잡히는 구간(어디서 어디까지) ④ 충돌 시 무슨 일이 벌어지는가 ⑤ 얻는 것 / 포기하는 것

무대는 이것 하나로 고정한다.

```java
@Entity
public class Stock {
    @Id @GeneratedValue
    private Long id;

    private Long productId;
    private int qty;          // 남은 수량

    @Version
    private Long version;     // ①번 방식에서만 의미가 있다

    public void decrease(int amount) {
        if (this.qty < amount) throw new OutOfStockException();
        this.qty -= amount;
    }
}
```

```sql
-- 무슨 방식을 쓰든 이 제약은 항상 깔고 간다 (§4-3에서 이유를 설명한다)
ALTER TABLE stock ADD CONSTRAINT ck_stock_qty CHECK (qty >= 0);
```

> **낙관적 락과 비관적 락의 기본 메커니즘**(`@Version`이 만드는 SQL, 영향 행 수 0의 의미, `PESSIMISTIC_WRITE`의 락 모드 3종, 락 타임아웃, 데드락 회피)은
> [낙관적 락과 비관적 락](optimistic-vs-pessimistic-lock.md)에서 이미 다뤘다. **이 문서의 주제는 그 메커니즘이 아니라 네 방식의 비교와 선택 기준**이므로, 여기서는 비교에 필요한 만큼만 짚고 넘어간다.

### 1-1. 방식 ① 낙관적 락 (`@Version`)

**① 코드**

```java
@Service
@RequiredArgsConstructor
public class StockService {

    private final StockRepository stockRepository;

    @Transactional
    public void decrease(Long stockId, int amount) {
        Stock stock = stockRepository.findById(stockId).orElseThrow();
        stock.decrease(amount);          // 자바에서 읽고 → 검증하고 → 계산한다
    }   // ← 커밋 시점 flush 에서 UPDATE 가 나가고, 충돌이면 여기서 예외
}
```

**② 나가는 SQL**

```sql
select s.id, s.product_id, s.qty, s.version from stock s where s.id = ?;

update stock
   set qty = ?,          -- 자바가 계산한 결과값 (예: 99)
       version = ?       -- 읽은 버전 + 1
 where id = ?
   and version = ?;      -- 읽은 버전
--     ↑ 영향 행 수 0 이면 "그 사이 누가 바꿨다" = 충돌
```

**③ 락이 잡히는 구간**

```
BEGIN
 ├─ SELECT            ──▶ DB    ← 아무것도 잠그지 않는다
 ├─ 자바에서 검증·계산                     ← 여전히 안 잠겨 있다
 ├─ UPDATE ... WHERE version = ?  ──▶ DB  ← 이 행 락은 여기서 잡혀 커밋까지 ┐ 락 구간
 └─ COMMIT                                                                ┘ = UPDATE~COMMIT
```

**락이 없는 구간이 대부분이다.** 정확히는 UPDATE 문이 나가는 순간 행 락이 잡히고 커밋에서 풀리지만, **읽고 계산하는 동안은 아무도 막지 않는다.** 그래서 "낙관적 락은 락이 아니다"라고 말한다 — 막는(prevention) 게 아니라 **감지(detection)** 다.

**④ 충돌 시 무슨 일이 벌어지는가**

100개 재고에 동시 100건이 들어왔다고 하자.

```
1라운드: 100건이 전부 version=0 을 읽고 → 자바 계산 → UPDATE
         → 1건만 영향 행 수 1, 나머지 99건은 0 → 예외
2라운드: 99건이 SELECT 부터 다시. 비즈니스 로직 전체 재실행
         → 1건 성공, 98건 실패
...
```

**성공 1건당 낭비되는 작업량이 대기 중인 요청 수에 비례**한다(재시도 폭풍). 그리고 이 재시도 비용은 UPDATE 한 번이 아니라 **비즈니스 로직 전체의 재실행**이다. 로직에 외부 API 호출이 섞여 있으면 그 API를 N배 때린다.

**⑤ 얻는 것 / 포기하는 것**

- **얻는 것**: 평시 비용이 **0**이다. 추가 쿼리도, 대기도, 커넥션 점유도 없고 `WHERE`절에 조건 하나가 붙을 뿐이다. **여러 필드를 읽어 자바에서 계산하는 복잡한 도메인 로직을 엔티티 안에 그대로 둘 수 있다** — 이게 네 방식 중 유일하게 낙관적 락만 온전히 주는 것이다.
- **포기하는 것**: 충돌이 잦아지면 **자원 낭비가 충돌 수에 비례해 폭증**한다. 그리고 **재시도가 세트로 따라오는데, 그 재시도 코드가 실무에서 가장 자주 틀린다**(§3). 또 실패를 사용자 경험으로 노출해야 한다("다시 시도해 주세요").

### 1-2. 방식 ② 비관적 락 (`select ... for update`)

**① 코드**

```java
public interface StockRepository extends JpaRepository<Stock, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    @Query("select s from Stock s where s.id = :id")
    Optional<Stock> findByIdForUpdate(@Param("id") Long id);
}

@Transactional
public void decrease(Long stockId, int amount) {
    Stock stock = stockRepository.findByIdForUpdate(stockId).orElseThrow();
    stock.decrease(amount);
}
```

**② 나가는 SQL**

```sql
select s.id, s.product_id, s.qty, s.version
  from stock s
 where s.id = ?
   for update;          -- ← 이 순간부터 이 행은 내 것이다

update stock set qty = ? where id = ?;
```

**③ 락이 잡히는 구간**

```
BEGIN
 ├─ SELECT ... FOR UPDATE ──▶ DB   ← 여기서 락 획득                 ┐
 │                        ◀──  값                                   │
 ├─ 자바에서 검증·계산                                                │ 락 보유 구간
 ├─ UPDATE                ──▶ DB                                    │ = 왕복 2~3회 + JVM 시간
 │                        ◀──                                       │
 └─ COMMIT                ──▶ DB   ← 여기서 락 해제                 ┘
```

**결정적 차이는 락 보유 구간 안에 애플리케이션 왕복이 통째로 들어간다는 것**이다. 왕복 하나가 같은 데이터센터에서도 수십 마이크로초~1밀리초 수준이고, 그 사이 GC 일시 정지나 스레드 스케줄링 지연이 끼면 더 길어진다. 결과는 **밀리초 단위 임계 구간**이다.

**④ 충돌 시 무슨 일이 벌어지는가**

99건은 **재실행하지 않고 그냥 기다린다.** 재시도 폭풍이 사라진다는 점에서는 낙관적 락보다 낫다. 문제는 **기다리는 동안 무엇을 붙잡고 있느냐**다.

```
비관적 락으로 대기하는 요청 1건이 붙잡은 것
   = 애플리케이션 스레드 + DB 커넥션 + 열린 트랜잭션
     (FOR UPDATE 를 보낸 채 응답을 기다리므로 커넥션이 풀로 반납될 수 없다)
```

커넥션 풀이 20개인데 락을 기다리는 요청이 21개면, **21번째부터는 락과 무관한 다른 모든 API까지 커넥션을 못 얻는다.** 재고 API 하나의 경합이 로그인·조회까지 마비시킨다. 이것이 **비관적 락의 진짜 대가이자 장애 격리가 깨지는 지점**이다. (여기서 "가상 스레드를 쓰면 되지 않나"는 답이 되지 않는다 — 병목은 스레드가 아니라 커넥션 풀이다. [상세](optimistic-vs-pessimistic-lock.md))

여기에 **데드락**이 하나 더 붙는다. 여러 행을 서로 다른 순서로 잠그면 순환 대기가 생긴다. 처방은 **시스템 전체가 합의한 하나의 순서(예: id 오름차순)로 잠그기**다.

**⑤ 얻는 것 / 포기하는 것**

- **얻는 것**: 재실행이 없다. **복잡한 계산과 여러 테이블 갱신을 락 안에서 안전하게 수행**할 수 있고, 실패를 사용자에게 노출하지 않는다.
- **포기하는 것**: **락 대기 시간 동안의 DB 커넥션**. 그리고 **데드락 위험**과 **락 타임아웃 설계 부담**. "비관적 락으로 하겠습니다"를 락 타임아웃·락 순서 규칙 없이 말하면 그건 **커넥션 고갈을 예약한 답변**이다.

### 1-3. 방식 ③ 원자적 UPDATE

**① 코드**

```java
public interface StockRepository extends JpaRepository<Stock, Long> {

    @Modifying          // ← "조회가 아니라 변경 쿼리다" 라는 표시. 없으면 실행 시 예외
    @Query("update Stock s set s.qty = s.qty - :amount " +
           "where s.id = :id and s.qty >= :amount")
    int decrease(@Param("id") Long id, @Param("amount") int amount);
}

@Transactional
public void decrease(Long stockId, int amount) {
    int affected = stockRepository.decrease(stockId, amount);
    if (affected == 0) {
        throw new OutOfStockException();   // ← 재시도가 아니라 최종 결론이다
    }
}
```

**② 나가는 SQL**

```sql
update stock
   set qty = qty - ?     -- ← 읽기·검증·계산·쓰기가 전부 이 한 문장 안에 있다
 where id = ?
   and qty >= ?;
```

읽은 값(`qty`)을 자바로 가져오지 않는다. **`qty - 1`이라는 계산이 DB 엔진 안에서 일어난다.** 그래서 "읽고 계산하고 쓴다"는 세 단계를 **한 문장으로 압축했다**고 말한다.

**③ 락이 잡히는 구간**

```
BEGIN
 ├─ UPDATE ... WHERE qty >= ?  ──▶ DB   ← 락 획득 + 조건 판단 + 갱신을 DB 안에서 한 번에  ┐ 락 보유 구간
 │                            ◀──  영향 행 수                                            │ = 왕복 1회
 └─ COMMIT                    ──▶ DB   ← 락 해제                                        ┘
```

비관적 락과 비교하면 **락 보유 구간에서 "값 전송 + 자바 계산 + UPDATE 전송"이 통째로 빠진다.** 이것이 후보자가 정확히 짚은 지점이다 — **락 구간에 애플리케이션 왕복이 포함되느냐가 ②와 ③을 가르는 결정적 차이**다.

다만 정직하게 덧붙일 것이 있다. **행 락은 문장이 끝날 때가 아니라 커밋할 때 풀린다.** 그러니 "한 문장이면 락이 마이크로초만 걸린다"는 정확하지 않다. 줄어드는 것은 **락 보유 구간에 들어 있던 왕복 횟수와 애플리케이션 처리 시간**이고, 그 효과가 온전히 나려면 **이 트랜잭션이 UPDATE 하나만 하고 즉시 커밋**해야 한다. 같은 트랜잭션에서 뒤에 외부 API를 호출하면 락은 그 시간만큼 그대로 잡혀 있다.

**④ 충돌 시 무슨 일이 벌어지는가**

**충돌이라는 개념 자체가 없다.** DB가 행 단위로 UPDATE를 직렬화하므로 100건이 순서대로 처리되고, `qty`가 0이 된 뒤에 도착한 요청은 `where qty >= 1`에 걸리지 않아 **영향 행 수 0**을 받는다.

여기서 낙관적 락의 0과 의미가 다르다는 것이 중요하다.

```
낙관적 락의 영향 행 수 0 = "누가 먼저 갔다. 다시 해봐라"      → 재시도 대상
원자적 UPDATE의 영향 행 수 0 = "재고가 없다"                  → 최종 결론, 즉시 품절 응답
```

**재시도 폭풍이 발생할 여지가 구조적으로 사라진다.** 이게 이 방식이 고경합에서 강한 이유다.

**⑤ 얻는 것 / 포기하는 것**

- **얻는 것**: 네 방식 중 **임계 구간이 가장 짧다.** 재시도가 없다. 코드가 짧다. 그리고 `where qty >= ?` 조건 덕분에 **어떤 상위 방어선이 뚫려도 재고가 음수가 되지 않는다** — DB를 최후 보루로 세울 때 쓰는 것이 바로 이 방식이다.
- **포기하는 것**: **§2 전체가 이 칸의 내용이다.** 짧게 말하면 ① 영속성 컨텍스트를 우회한다 ② 도메인 로직이 엔티티가 아니라 SQL로 새어 나간다 ③ 조건이 복잡해지면 표현력이 급락한다.

### 1-4. 방식 ④ 분산 락 (Redis)

**① 코드**

```java
@Service
@RequiredArgsConstructor
public class StockFacade {          // ← 락만 담당. @Transactional 을 붙이지 않는다 (§4-2)

    private final RedissonClient redisson;
    private final StockService stockService;

    public void decrease(Long stockId, int amount) {
        RLock lock = redisson.getLock("lock:stock:" + stockId);
        boolean acquired = false;
        try {
            // waitTime: 락을 못 잡으면 3초까지만 기다린다
            // leaseTime: 잡은 뒤 5초가 지나면 강제로 놓는다(장애 시 영구 점유 방지)
            acquired = lock.tryLock(3, 5, TimeUnit.SECONDS);
            if (!acquired) throw new LockAcquisitionException("잠시 후 다시 시도해 주세요");

            stockService.decrease(stockId, amount);   // ← 여기서 비로소 트랜잭션이 열린다
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        } finally {
            if (acquired && lock.isHeldByCurrentThread()) lock.unlock();
        }
    }
}
```

**② 나가는 SQL(과 Redis 명령)**

```
[Redis]  SET lock:stock:1 <소유자토큰> NX PX 5000     ← 원자적으로 "없을 때만" 설정
[DB]     BEGIN
[DB]     update stock set qty = qty - 1 where id = ? and qty >= 1
[DB]     COMMIT
[Redis]  (Lua 스크립트) 소유자 확인 후 DEL              ← 남의 락을 지우지 않기 위해
```

**해제는 반드시 "내가 잡은 락인지 확인 → 삭제"가 원자적으로** 이뤄져야 한다. 그냥 `DEL`을 하면 **TTL이 만료돼 이미 남이 잡은 락을 내가 지워버리는** 사고가 난다. Redisson은 이걸 Lua 스크립트로 처리해준다.

**③ 락이 잡히는 구간**

```
① Redis 락 획득  ─────────────────────────────────┐
②   BEGIN                                          │ 분산 락 보유 구간
③   UPDATE ──▶ DB   ← DB 행 락은 여기서만          │ (DB 커넥션은 ②~④ 동안만 점유)
④   COMMIT                                         │
⑤ Redis 락 해제  ─────────────────────────────────┘

락을 기다리는 나머지 99건이 붙잡고 있는 것 = 애플리케이션 스레드뿐
                                            (DB 커넥션은 아직 안 빌렸다)
```

**이 그림이 분산 락의 존재 이유를 한 장으로 설명한다.** 대기 줄이 커넥션 풀 **밖에** 서 있다.

**④ 충돌 시 무슨 일이 벌어지는가**

99건은 애플리케이션 스레드를 쥔 채 Redis에서 순서를 기다린다(Redisson은 pub/sub으로 깨우므로 폴링 부하도 낮다). `waitTime`을 넘기면 락 획득 실패로 즉시 실패 응답을 준다 — **대기 상한을 커넥션과 무관하게 정할 수 있다**는 것이 실무적으로 크다.

그리고 **뚫린다.** GC 정지·네트워크 지연으로 `leaseTime`을 넘기면 락이 만료되어 다른 요청이 같은 락을 잡고, **두 스레드가 동시에 임계 구간에 들어간다.** Redis 노드 장애나 페일오버 중 복제 지연이 있어도 마찬가지다. 이것이 §4-3의 주제다.

**⑤ 얻는 것 / 포기하는 것**

- **얻는 것**: **대기 비용을 커넥션 풀 밖으로 밀어낸다.** 그리고 **임계 구간에 DB 밖 자원이 끼어 있어도 조정할 수 있다** — 이것이 다른 세 방식이 원리적으로 못 하는 유일한 일이다(외부 PG 호출, 여러 DB에 걸친 갱신, 여러 인스턴스가 도는 스케줄러).
- **포기하는 것**: **인프라 의존이 하나 늘어난다**(Redis가 죽으면 이 기능이 죽거나, 락 없이 도는 모드로 떨어진다). **왕복이 2회 더 붙어 정상 경로 지연이 늘어난다.** 그리고 결정적으로 — **정합성을 보장하지 못한다.** 분산 락은 안전장치가 아니라 **부하 조절 장치**다.

### 1-5. 다섯 칸을 한 장으로

| | ① 낙관적 락 | ② 비관적 락 | ③ 원자적 UPDATE | ④ 분산 락 |
|---|---|---|---|---|
| **락 구간** | UPDATE~커밋 (읽기·계산은 무락) | **SELECT FOR UPDATE ~ 커밋** (왕복 포함) | UPDATE~커밋 (**왕복 1회**) | Redis 획득~해제 (DB 밖) |
| **충돌 시** | 로직 전체 재실행 | 대기 (재실행 없음) | 대기 없음, 영향 행 수 0 = 품절 | Redis에서 순서 대기 |
| **붙잡는 자원** | 애플리케이션 스레드 | 스레드 + **DB 커넥션 + 열린 트랜잭션** | 스레드 + 커넥션(짧게) | **스레드만** (대기 중에는) |
| **고경합 실패 모습** | 재시도 폭풍 | **커넥션 풀 고갈 → 전체 장애** | 처리량 한계(직렬화) | Redis 부하 + 락 만료로 뚫림 |
| **도메인 로직 위치** | **엔티티 안** | **엔티티 안** | **SQL 안(누수)** | 엔티티 안 |
| **정합성 최종 보증** | version 조건 | 행 락 | `where qty >= ?` + CHECK | **없음 — DB에 위임해야 함** |

후보자가 본질문에서 낸 "**무슨 자원을 소모하는가**"라는 축(세 번째 행)은 이 표에서 가장 밀도 높은 한 줄이다. 여기에 **첫 번째 행(락 구간)과 다섯 번째 행(도메인 로직 위치)** 을 얹으면 비교가 완성된다.

---

## 2. 원자적 UPDATE가 포기하는 것 — 가장 좋아 보이는 선택지의 대가

임계 구간이 가장 짧고, 재시도가 없고, 코드도 짧다. 그렇다면 **왜 모든 재고·포인트 갱신을 이것으로만 처리하지 않는가?** 대가가 세 가지 있다.

### 2-1. 영속성 컨텍스트를 우회한다 = 벌크 연산과 똑같은 1차 캐시 불일치

**`@Modifying` UPDATE는 [벌크 연산](bulk-operation-persistence-context.md)과 정확히 같은 성질의 쿼리다.** 변경 감지(dirty checking)를 거치지 않고 **영속성 컨텍스트를 건너뛰어 DB로 바로 나간다.** 그러면 이런 일이 벌어진다.

```java
// ❌ BEFORE — DB 는 바뀌었는데 조회는 옛날 값
@Transactional
public void order(Long stockId) {
    Stock stock = stockRepository.findById(stockId).orElseThrow();  // qty = 100, 1차 캐시에 적재
    stockRepository.decrease(stockId, 1);                           // DB: qty = 99

    Stock again = stockRepository.findById(stockId).orElseThrow();
    log.info("남은 수량 = {}", again.getQty());
    // → 99 가 아니라 100 이 찍힌다.
    //   findById 는 1차 캐시에 이미 있는 엔티티를 그대로 돌려주기 때문이다(SELECT 자체가 안 나간다).

    if (again.getQty() == 0) notifySoldOut();   // 이 판단은 옛날 값 기준이다
}
```

비유하면 이렇다. **영속성 컨텍스트는 "내가 아까 복사해 둔 서류철"이고, 벌크/원자적 UPDATE는 그 서류철을 안 거치고 원본 장부를 직접 고치는 것**이다. 원본은 바뀌었는데 내 손의 사본은 옛날 그대로다.

**처방 세 가지 — 그런데 첫 번째가 함정이다.**

```java
// ⚠️ 처방 1: clearAutomatically — 쓰지만 부작용이 크다
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Stock s set s.qty = s.qty - :amount where s.id = :id and s.qty >= :amount")
int decrease(@Param("id") Long id, @Param("amount") int amount);
```

- `flushAutomatically = true` → **실행 전에** 영속성 컨텍스트의 변경분을 DB로 밀어낸다(안 그러면 아직 반영 안 된 변경 위에 UPDATE가 얹힌다).
- `clearAutomatically = true` → **실행 후에** 영속성 컨텍스트를 **통째로 비운다.**

**부작용은 "통째로"에 있다.** 같은 트랜잭션에서 수정 중이던 **다른 엔티티들까지 준영속(detached) 상태가 되어 변경분이 조용히 사라진다.**

```java
// ❌ clearAutomatically 의 부작용
@Transactional
public void placeOrder(Long stockId, Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.setStatus(PAID);              // ← 이 변경은

    stockRepository.decrease(stockId, 1);   // ← clearAutomatically 가 컨텍스트를 비우면서

    // → order 는 준영속이 되어 변경 감지 대상에서 빠진다.
    //   커밋해도 order.status 는 UPDATE 되지 않는다. 예외도 안 난다. 조용히 사라진다.
}
```

```java
// ✅ 처방 2 (권장): 벌크성 쿼리를 트랜잭션의 마지막에 두거나, 별도 트랜잭션으로 분리한다
@Transactional
public void placeOrder(Long stockId, Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.setStatus(PAID);
    // ... 다른 엔티티 조작은 전부 여기까지 끝낸다

    int affected = stockRepository.decrease(stockId, 1);   // ← 마지막. 이후 재조회하지 않는다
    if (affected == 0) throw new OutOfStockException();
}
```

```java
// ✅ 처방 3: 갱신 후 값이 꼭 필요하면 "다시 읽지 말고" DB 가 돌려준 것을 쓴다
//    (PostgreSQL 은 UPDATE ... RETURNING qty 로 한 번에 받을 수 있다.
//     MySQL 이라면 굳이 재조회하지 말고 "성공/실패"만 가지고 응답을 설계한다.)
```

**핵심 규칙**: *원자적 UPDATE를 쓴 트랜잭션에서는 그 엔티티를 다시 읽지 않는다.* 다시 읽어야 하는 설계라면 애초에 이 방식이 안 맞는 것이다.

### 2-2. 도메인 로직이 엔티티가 아니라 SQL로 새어 나간다

이게 장기적으로 더 아프다. 처음엔 `qty - 1`로 시작한다. 그런데 요구사항은 자란다.

```java
// 처음: 깔끔하다
@Query("update Stock s set s.qty = s.qty - :amount where s.id = :id and s.qty >= :amount")

// 6개월 뒤: 등급별 차감량 + 프로모션 배수 + 최소 보유 수량 정책이 붙는다
@Query("update Stock s set s.qty = s.qty - " +
       "  (case when :grade = 'VIP' then :amount " +
       "        when :promo = true then :amount * 2 " +
       "        else :amount end) " +
       " where s.id = :id " +
       "   and s.qty - (case when :grade = 'VIP' then :amount " +
       "                     when :promo = true then :amount * 2 " +
       "                     else :amount end) >= :reserved")
int decrease(...);
// ← 도메인 규칙이 문자열 안으로 들어갔다
```

여기서 잃는 것이 구체적으로 셋이다.

- **단위 테스트가 불가능해진다.** `case when` 안의 규칙은 **DB를 띄워야만** 검증할 수 있다. 엔티티 메서드였다면 `new Stock(...).decrease(VIP, 2)` 한 줄로 끝났다.
- **재사용이 안 된다.** 같은 차감 정책이 주문 취소, 관리자 수동 조정, 배치 정산에도 필요하면 **쿼리를 복붙**하게 된다. 그리고 셋 중 하나만 고치는 사고가 난다.
- **규칙이 어디 있는지 아무도 모른다.** 도메인 규칙을 찾으려면 엔티티가 아니라 리포지토리 인터페이스의 문자열을 뒤져야 한다.

```java
// ✅ 대비 — 규칙은 엔티티에, DB 에는 "최소한의 원자성 조건"만 남긴다
public class Stock {
    public int calcDecreaseAmount(Grade grade, boolean promo, int base) {
        // 정책은 여기 산다. 테스트도 여기서 끝난다.
        if (grade == VIP) return base;
        return promo ? base * 2 : base;
    }
}

// 계산은 자바에서, 원자성만 DB 에서
int amount = stock.calcDecreaseAmount(grade, promo, base);   // 순수 계산 (락 불필요)
int affected = stockRepository.decrease(stockId, amount);    // 원자적 갱신
```

**규칙은 이렇게 정리된다** — *계산을 SQL로 옮기는 게 아니라, 계산 결과를 파라미터로 넘기고 SQL에는 `where qty >= :amount`라는 원자성 조건만 남긴다.* 이렇게 하면 두 세계의 좋은 점을 다 가져간다. 다만 계산에 **그 행의 현재 값이 필요한 순간**(예: "남은 수량이 10 이하면 2배 차감") 이 분리는 깨진다. 그때가 낙관적/비관적 락으로 넘어갈 신호다.

### 2-3. 여러 필드·복잡한 조건이 되면 표현력이 급락한다

원자적 UPDATE가 잘 맞는 모양은 **"단일 행의 숫자 필드 하나를, 그 필드에 대한 단순 조건으로 증감"** 이다. 여기서 한 발짝만 벗어나도 급격히 나빠진다.

- **여러 필드를 함께 갱신**해야 할 때(재고 차감 + 예약 수량 증가 + 최종 판매일 갱신) — 한 문장에 다 넣을 수는 있지만 읽을 수 없는 쿼리가 된다.
- **다른 테이블의 상태에 조건이 걸릴 때**(상품이 판매중이고, 이벤트 기간이고, 회원이 구매 자격이 있을 때만) — 서브쿼리로 밀어 넣으면 성능도 가독성도 무너진다.
- **차감 결과에 따라 분기해야 할 때**(0이 되면 품절 이벤트 발행) — 영향 행 수만으로는 "0이 됐는지"를 알 수 없다.
- **`@Version`을 안 올린다.** 같은 엔티티를 낙관적 락으로도 보호하고 있다면, 이 UPDATE는 **버전을 올리지 않아 다른 트랜잭션이 이 변경을 감지하지 못한다.** 올리려면 SQL에 `s.version = s.version + 1`을 직접 써야 한다.

**한 문장으로**: *원자적 UPDATE는 "읽고 계산하고 쓴다"가 정말로 한 문장으로 압축될 때만 최고의 선택이다. 압축이 안 되는 걸 억지로 압축하면, 압축한 것은 SQL이 아니라 도메인 모델이다.*

---

## 3. 재시도 코드의 두 함정 — 낙관적 락을 고른 순간 따라오는 숙제

낙관적 락은 "실패할 수 있다"를 전제로 하는 구조다. 그래서 재시도가 세트로 따라오는데, **여기가 실무에서 가장 많이 틀리는 코드**다. 함정이 **두 겹**이라는 게 핵심이다. 하나만 알고 고치면 여전히 안 된다.

### 3-1. 완전히 잘못된 형태

```java
// ❌ BEFORE — 절대 성공하지 않는 재시도
@Service
@RequiredArgsConstructor
public class StockService {

    private final StockRepository stockRepository;

    @Transactional                                   // ← 트랜잭션이 루프 바깥을 감싸고 있다
    public void decrease(Long stockId, int amount) {
        for (int i = 0; i < 5; i++) {
            try {
                Stock stock = stockRepository.findById(stockId).orElseThrow();
                stock.decrease(amount);
                stockRepository.saveAndFlush(stock);  // 여기서 UPDATE + 충돌 감지
                return;
            } catch (ObjectOptimisticLockingFailureException e) {
                // 재시도!  ... 인 줄 알았다
            }
        }
        throw new StockConflictException();
    }
}
```

**함정 ① — `rollback-only` 마킹.**

트랜잭션 도중 이런 예외가 나면 하이버네이트 세션은 이미 일관성을 잃은 상태로 간주되고, **트랜잭션에는 "롤백만 가능(rollback-only)" 표시가 찍힌다.** 예외를 `catch`로 삼켜도 그 표시는 지워지지 않는다. 그래서 루프가 운 좋게 성공한 것처럼 보여도 **메서드를 빠져나와 커밋하는 순간 `UnexpectedRollbackException`이 터진다.** *예외를 잡았다고 없던 일이 되지 않는다.*

**함정 ② — 1차 캐시에 남은 옛 version. (이쪽이 덜 알려져 있다)**

`rollback-only`를 피하려고 트랜잭션을 루프 **밖으로** 빼도, **영속성 컨텍스트가 같으면 여전히 안 된다.**

```java
// ❌ 여전히 실패 — 트랜잭션은 뺐지만 영속성 컨텍스트를 새로 열지 않았다
for (int i = 0; i < 5; i++) {
    try {
        stockService.decreaseInSameContext(stockId, amount);
        return;
    } catch (ObjectOptimisticLockingFailureException e) { /* 재시도 */ }
}
```

`findById(stockId)`는 **영속성 컨텍스트(1차 캐시)에 이미 그 엔티티가 있으면 DB로 SELECT를 보내지 않고 그대로 돌려준다.** 그래서 두 번째 시도에서도 손에 쥐는 것은 `version = 3`짜리 **옛날 객체**다. 또 `WHERE version = 3`을 날리고, 또 영향 행 수 0을 받는다.

```
1회차: 캐시에 없음 → DB SELECT (version=3) → UPDATE WHERE version=3 → 0건 → 실패
2회차: 캐시에 있음 → SELECT 안 나감 (version=3 그대로) → UPDATE WHERE version=3 → 0건 → 실패
3회차: 똑같음 → 실패
...
5회차까지 전부 동일한 실패. 재시도 횟수만 낭비했다.
```

**"다시 조회해서 재실행한다"는 직관은 옳다. 다만 그 '다시 조회'가 성립하려면 영속성 컨텍스트가 새것이어야 한다**는 조건이 붙는다. 즉 **재시도의 매 회차는 새 트랜잭션 + 새 영속성 컨텍스트**여야 한다.

### 3-2. 올바른 형태

```java
// ✅ AFTER — 재시도 책임과 트랜잭션 책임을 다른 빈으로 분리
@Service
@RequiredArgsConstructor
public class StockRetryFacade {                  // ← 재시도만 담당. @Transactional 없음!

    private final StockService stockService;

    @Retryable(
        retryFor = ObjectOptimisticLockingFailureException.class,
        maxAttempts = 5,
        backoff = @Backoff(delay = 50, multiplier = 2.0, maxDelay = 500, random = true)
    )                                            // 지수 백오프 + 지터(random)로 재충돌을 흩는다
    public void decrease(Long stockId, int amount) {
        stockService.decrease(stockId, amount);   // 호출할 때마다 새 트랜잭션이 열린다
    }

    @Recover
    public void recover(ObjectOptimisticLockingFailureException e, Long stockId, int amount) {
        throw new StockConflictException("잠시 후 다시 시도해 주세요", e);   // 포기 경로를 반드시 둔다
    }
}

@Service
@RequiredArgsConstructor
public class StockService {

    private final StockRepository stockRepository;

    @Transactional                                // ← 트랜잭션만 담당
    public void decrease(Long stockId, int amount) {
        Stock stock = stockRepository.findById(stockId).orElseThrow();
        stock.decrease(amount);
    }   // ← 커밋. 충돌이면 여기서 예외 → 롤백 → 영속성 컨텍스트도 함께 폐기된다
}
```

**왜 이게 되는가.** `stockService.decrease(...)`가 예외로 끝나면 트랜잭션이 롤백되고 **영속성 컨텍스트가 통째로 버려진다.** 다음 호출은 완전히 새 트랜잭션 + 새 영속성 컨텍스트이므로, `findById`가 **정말로 DB에서 최신 version을 다시 읽는다.** 두 함정이 **동시에** 풀린다.

**세 줄 규칙**:

> ① **재시도는 트랜잭션보다 바깥에 있어야 한다** — 낙관적 락 예외는 커밋 시점에 터지므로, 트랜잭션 안쪽의 재시도는 예외를 잡을 기회조차 없다.
> ② **매 회차가 새 영속성 컨텍스트여야 한다** — 아니면 1차 캐시가 옛 version을 계속 돌려준다.
> ③ **빈을 나눠 그 순서를 코드에 드러낸다** — `@Retryable`과 `@Transactional`을 같은 메서드에 붙이면 프록시 순서라는 **눈에 안 보이는 규칙**에 정확성을 맡기게 된다. 게다가 같은 클래스 안에서 `this.decrease()`로 부르면 프록시를 안 거쳐 **둘 다 아예 동작하지 않는다.**

**트랜잭션 경계를 밖으로 뺄 수 없는 상황이라면** `REQUIRES_NEW`로 매 회차를 독립 트랜잭션으로 열어도 같은 효과를 낼 수 있다. 단 부모 트랜잭션이 커넥션을 쥔 채 자식이 또 한 개를 빌리므로 **커넥션을 2개씩 쓴다**는 점을 계산에 넣어야 한다.

### 3-3. 그리고 — 재시도가 정당하지 않은 경우

재시도는 **부수 효과가 없는 로직**에만 안전하다.

```java
// ❌ 이 로직에 낙관적 락 + 재시도를 걸면, 결제가 5번 일어날 수 있다
@Transactional
public void purchase(Long stockId, Long userId) {
    Stock stock = stockRepository.findById(stockId).orElseThrow();
    paymentGateway.charge(userId, 10_000);     // ← 외부 PG 호출. 되돌릴 수 없다
    stock.decrease(1);
}   // ← 여기서 충돌 → 재시도 → charge 가 또 호출된다
```

**재시도 비용 = 비즈니스 로직 전체의 재실행 비용**이고, 로직에 되돌릴 수 없는 외부 호출이 있으면 **낙관적 락 자체가 부적절한 선택**이 된다. 이 경우의 해법은 세 갈래다 — ① 외부 호출을 트랜잭션 밖으로 빼고 멱등키로 보호하거나 ② 재고 확보를 먼저 하고 결제를 나중에 하거나 ③ **임계 구간에 DB 밖 자원(PG)이 들어 있으므로 분산 락으로 넘어간다**(§4-1의 첫 분기가 바로 이것이다).

---

## 4. 선택 기준 — "충돌 빈도"가 아니라 "임계 구간에 무엇이 들어가는가"

### 4-1. 판단 플로우

충돌 빈도는 **마지막 분기**다. 그 앞에 두 개가 더 있다.

```
Q1. 임계 구간에 DB 밖 자원이 들어 있는가?
    (외부 PG·메일 발송 같은 되돌릴 수 없는 호출 / 여러 DB·서비스에 걸친 갱신 /
     여러 인스턴스가 동시에 도는 스케줄러·배치)
    ├─ 예  → ④ 분산 락
    │        (다른 세 가지는 원리적으로 이걸 못 한다. 락의 범위가 DB 한 대이기 때문)
    └─ 아니오 ↓

Q2. "읽고 → 검증하고 → 계산하고 → 쓴다"가 SQL 한 문장으로 압축되는가?
    (단일 행의 숫자 필드를, 그 필드에 대한 단순 조건으로 증감하는 모양인가)
    ├─ 예  → ③ 원자적 UPDATE   ← 압축된다면 이게 기본값이다
    │        단, §2 의 대가를 안다는 전제 하에
    └─ 아니오 ↓  (여러 필드를 읽어 자바에서 계산해야 한다)

Q3. 같은 행에 충돌이 잦은가?  (= 행 하나당 초당 몇 건이 오는가)
    ├─ 예  → ② 비관적 락   (재시도 비용 > 대기 비용. 대가는 커넥션 점유 + 데드락)
    └─ 아니오 → ① 낙관적 락  (평시 비용 0. 대가는 재시도 코드와 실패 노출)
```

**왜 순서가 이런가.** Q1은 **다른 선택지가 원리적으로 불가능한지**를 묻는다(가능/불가능). Q2는 **임계 구간을 자릿수 단위로 줄일 수 있는지**를 묻는다(구조). Q3만이 **양적 판단**이다. 판단은 항상 **가능성 → 구조 → 양**의 순서로 좁혀야 하고, "충돌 빈도"부터 시작하면 Q1·Q2를 건너뛴 채 양적 근거만 대게 된다.

**Q3의 "잦다"를 감으로 말하지 않는 법**: 필요한 숫자는 세 개다 — **대상 행의 개수, 초당 쓰기 요청 수, 트랜잭션 하나가 그 행을 붙잡는 시간.** 회원 10만 명의 포인트 차감은 요청이 10만 개 행에 흩어지므로 충돌 확률이 사실상 0이다. 반대로 **한정판 상품 1개 행에 초당 500건**이면 충돌은 예외가 아니라 기본값이다. **"행 하나당 초당 몇 건인가"** 로 환산하는 습관이 핵심이다.

### 4-2. 분산 락의 실질 이점은 "DB 부하 감소"가 아니라 "커넥션 풀 밖으로 대기를 밀어내는 것"

여기가 이 문항에서 가장 정교한 논점이다. 흔한 반론은 이렇다.

> "분산 락을 걸어도 `UPDATE`는 그대로 DB로 나가지 않나요? 그런데 왜 'DB에 영향을 주지 않는다'고 합니까?"

**반론이 절반 맞다.** 나가는 쿼리 수는 줄지 않는다. 줄어드는 것은 **쿼리 수가 아니라 커넥션 점유 시간**이다. 정확한 표현은 이것이다.

> **분산 락의 이점은 "DB 부하가 준다"가 아니라, 락을 트랜잭션 밖에서 잡음으로써 대기 비용을 DB 커넥션 풀 밖으로 밀어내는 것이다.**

임계 구간이 아무리 짧아도 요청이 순간에 몰리면 커넥션을 물고 있을 수밖에 없고, 커넥션은 **서비스 전체가 공유하는 자원**이라 재고 API 하나의 경합이 로그인·조회까지 마비시킨다. 분산 락은 그 대기 줄을 **커넥션을 빌리기 전 단계**로 옮긴다. 이게 "다른 API를 지킨다"의 정확한 의미다.

**그런데 이 이점은 조건부다. 락을 트랜잭션 안에서 잡으면 통째로 사라진다.**

```java
// ❌ BEFORE — 분산 락의 이점이 0이 되는 코드
@Transactional                                        // ① 트랜잭션 시작 = 여기서 커넥션을 빌린다
public void decrease(Long stockId, int amount) {
    RLock lock = redisson.getLock("lock:stock:" + stockId);
    lock.tryLock(3, 5, TimeUnit.SECONDS);             // ② 락 대기 ← 커넥션을 쥔 채로 기다린다!
    try {
        Stock stock = stockRepository.findById(stockId).orElseThrow();
        stock.decrease(amount);
    } finally {
        lock.unlock();                                 // ③ 락 해제
    }
}                                                      // ④ 커밋
```

```
커넥션 점유 구간:  ①─────────────────────────────────────④
                      ↑ 락 대기 시간이 통째로 이 안에 들어 있다

→ 99건이 각각 커넥션을 하나씩 쥔 채 Redis 를 기다린다.
→ 커넥션 풀은 비관적 락을 쓸 때와 똑같이 고갈된다.
→ Redis 왕복 2회만 더 붙었다. 순수한 손해다.
```

또 하나 치명적인 순서 문제가 있다. **`unlock()`이 커밋보다 먼저 일어난다.** 락을 놓은 시점에 내 UPDATE는 아직 커밋되지 않았으므로, 다음 요청이 락을 잡고 들어와 **커밋 전의 옛 값을 읽는다.** 락을 걸었는데도 lost update가 난다.

```java
// ✅ AFTER — 락 획득 → 트랜잭션 시작 → 커밋 → 락 해제
@Service
@RequiredArgsConstructor
public class StockFacade {                            // @Transactional 없음

    private final RedissonClient redisson;
    private final StockService stockService;          // 이쪽에만 @Transactional 이 있다

    public void decrease(Long stockId, int amount) {
        RLock lock = redisson.getLock("lock:stock:" + stockId);
        boolean acquired = false;
        try {
            acquired = lock.tryLock(3, 5, TimeUnit.SECONDS);   // ① 락 대기 — 커넥션은 아직 안 빌렸다
            if (!acquired) throw new LockAcquisitionException();

            stockService.decrease(stockId, amount);             // ② 트랜잭션 시작~커밋이 여기 안에서 끝난다
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        } finally {
            if (acquired && lock.isHeldByCurrentThread()) lock.unlock();   // ③ 커밋 후 해제
        }
    }
}
```

```
커넥션 점유 구간:            ②──②
락 보유 구간:      ①──────────────③
                   ↑ 대기 줄은 여기(커넥션 밖)에 선다

순서 규칙: 락 획득 → 트랜잭션 시작 → 커밋 → 락 해제
          (반드시 커밋이 락 해제보다 먼저여야 한다)
```

**이 순서 하나가 분산 락 도입의 성패를 가른다.** 면접에서 "분산 락을 쓰겠다"고 말할 때 **이 순서를 같이 말하지 못하면, 도구는 알지만 왜 쓰는지는 모르는 것**으로 읽힌다.

### 4-3. Redis 분산 락은 정합성 보증 장치가 아니라 부하 최적화 장치다

**분산 락은 뚫린다.** 이건 구현 버그가 아니라 **원리적 한계**다.

```
경로 1) leaseTime(TTL) 만료
  스레드 A 가 락을 잡음 (TTL 5초)
   → A 가 GC 로 6초 정지, 혹은 DB 응답이 6초 지연
   → 5초에 Redis 가 락을 만료시킴
   → 스레드 B 가 같은 락을 획득
   → A 가 깨어나 아무것도 모른 채 UPDATE 를 실행
   → A 와 B 가 동시에 임계 구간 안에 있다

경로 2) Redis 노드 장애 / 페일오버
  마스터가 SET NX 를 받고 복제 전에 죽음 → 승격된 레플리카에는 그 락이 없음
  → 다른 요청이 같은 락을 획득

경로 3) 락을 아예 안 거치는 경로
  운영자가 콘솔에서 수동 UPDATE / 배치 잡 / 다른 팀의 마이크로서비스
  → 락은 "모두가 지키기로 한 약속"일 뿐이고, 약속을 모르는 참가자를 막지 못한다
```

이것이 이른바 **Redlock 논쟁의 핵심**이다. 요지는 "Redis 락이 쓸모없다"가 아니라, **"프로세스 정지와 시계 오차가 존재하는 이상 타임아웃 기반 락은 상호 배제를 보장할 수 없으므로, 정확성이 걸린 곳에는 쓰지 말라"** 는 것이다.

그래서 결론이 이렇게 정리된다.

> **분산 락은 "대부분의 요청이 줄을 서게 해서 경합을 줄이는" 최적화 장치다.
> 정합성의 최종 보증은 항상 DB가 해야 한다.**

**두 겹의 최후 방어선**을 반드시 같이 건다.

```sql
-- 1) 조건부 UPDATE — 애초에 음수가 될 UPDATE 를 성립시키지 않는다
update stock set qty = qty - ? where id = ? and qty >= ?;
--                                            ^^^^^^^^^^ 락이 뚫려도 이 조건은 DB 가 원자적으로 판정한다

-- 2) CHECK 제약 — 위 조건을 빠뜨린 코드 경로(수동 SQL, 배치, 신규 기능)까지 막는다
ALTER TABLE stock ADD CONSTRAINT ck_stock_qty CHECK (qty >= 0);
```

**두 개를 다 거는 이유**가 중요하다. `where qty >= ?`는 **그 쿼리를 쓴 코드만** 지킨다. `CHECK` 제약은 **어떤 경로로 들어오든** 지킨다. 락이 뚫려도, 조건을 빠뜨린 새 코드가 배포돼도, 운영자가 콘솔에서 실수해도 **재고는 음수가 되지 않는다.** 이것이 "DB를 최후 보루로 삼는다"의 구체적 형태다.

**(가산점 포인트) fencing token.** 락 만료로 인한 "유령 작업자" 문제를 원리적으로 막는 방법이 있다. 락 서비스가 락을 줄 때마다 **단조 증가하는 번호(fencing token)** 를 함께 발급하고, 실제 저장소가 **자기가 본 것보다 작은 번호의 쓰기를 거부**하게 하는 것이다.

```sql
-- 뒤늦게 깨어난 A(token=33)의 쓰기가 이미 B(token=34)가 지나간 뒤라면 조용히 0건이 된다
update stock
   set qty = qty - ?, fence_token = ?     -- 34
 where id = ? and qty >= ? and fence_token < ?;   -- 34
```

즉 **"락으로 막는 대신, 늦게 도착한 쓰기를 저장소가 스스로 거부하게 만드는 것"** 이다. 이 개념을 알고 있으면 "분산 락은 뚫린다"에서 멈추지 않고 **"그래서 어떻게 하느냐"** 까지 답할 수 있다.

### 4-4. 이건 사지선다가 아니다 — 실무의 답은 층을 쌓는 것

질문이 "각각으로 풀 때"라서 **네 개 중 하나를 고르는 문제로 오해하기 쉬운데, 실무의 답은 대개 조합**이다. 각 층이 막는 것이 다르기 때문이다.

```
[1층] 진입 제어 — 분산 락 (또는 Redis 카운터)
      막는 것: DB 커넥션이 대기로 고갈되는 것
      못 막는 것: 정합성 (뚫린다)

[2층] 원자적 갱신 — update ... where qty >= ?
      막는 것: 락이 뚫렸을 때의 초과 차감
      못 막는 것: 이 쿼리를 안 쓰는 코드 경로

[3층] DB 제약 — CHECK (qty >= 0), 유니크 제약
      막는 것: 모든 경로. 마지막 방어선
      못 막는 것: 없음 (대신 예외로 터진다 — 사용자 경험은 위층이 책임진다)
```

**각 층은 위층이 실패했을 때를 가정하고 설계된다.** 면접에서 "저는 분산 락을 쓰겠습니다"라고 단일 선택으로 답하는 것과, **"1층은 분산 락으로 대기를 커넥션 밖에 세우고, 2층은 원자적 UPDATE로 갱신하고, 3층은 CHECK 제약으로 바닥을 막습니다. 1층이 뚫려도 2층이, 2층을 안 거쳐도 3층이 잡습니다"** 라고 답하는 것은 완전히 다른 인상을 준다.

반대로 **과한 층 쌓기도 문제**다. 충돌이 하루 몇 건인 관리자 화면에 Redis 분산 락을 도입하면 **인프라 의존과 실패 모드만 늘어난다.** 층은 **필요한 만큼만** 쌓는다 — 판단은 §4-1의 플로우로 돌아간다.

### 4-5. 트래픽이 극단적이면 네 가지 모두 답이 아닐 수 있다

선착순 1,000명 이벤트에 초당 5만 요청이 들어온다고 하자. 네 방식 중 무엇을 써도 **결국 DB의 그 행 하나에 요청이 직렬화**된다. 초당 처리량은 대략 `1 / 임계 구간 길이`로 정해지므로, 임계 구간이 0.5ms면 초당 2,000건이 상한이다. **5만 건은 애초에 DB 앞에 세울 물량이 아니다.**

이때는 **질문을 바꾼다** — "어떤 락을 쓸까"가 아니라 **"DB를 때리지 않고 수량을 선점할 수 있나"** 로.

```java
// Redis 를 "락"이 아니라 "카운터"로 쓴다
Long remaining = redisTemplate.opsForValue().decrement("event:stock:1");
if (remaining == null || remaining < 0) {
    redisTemplate.opsForValue().increment("event:stock:1");   // 되돌리고
    return SOLD_OUT;                                          // 즉시 품절 응답
}
// 여기까지 온 요청만 "당첨". 확정은 큐에 넣어 비동기로 처리한다
eventPublisher.publish(new StockReservedEvent(userId, productId, remaining));
```

- **`DECR`는 Redis 단일 스레드에서 원자적으로 실행**되므로 락 없이도 정확히 센다. 락이 아니라 **카운터**로 쓰는 것이 핵심이다.
- **당첨자 1,000명만** DB로 흘러간다. 나머지 49,000건은 Redis에서 끝난다. **DB에 도달하는 트래픽 자체를 1/50로 줄인 것**이지, 락을 더 빠르게 만든 게 아니다.
- **최종 확정은 여전히 DB 제약이 지킨다.** Redis 카운터도 장애로 어긋날 수 있으므로, 비동기 확정 단계에서 `update ... where qty >= 1` + `CHECK` 제약을 그대로 통과시킨다.

**포기하는 것**도 분명하다 — **응답이 "당첨됐습니다(처리 중)"라는 잠정 상태**가 되므로 UX와 후속 알림 설계가 필요하고, **Redis와 DB 사이에 정합성 보정 로직**(미확정 건 재처리, 실패 시 카운터 복구)이 생긴다. 이 복잡도를 감당할 만큼 트래픽이 극단적일 때만 정당한 선택이다.

---

## 5. 검증 — 네 방식을 같은 테스트로 실제로 비교하기

**"이 방식이 동시성에 안전합니다"를 말로 하면 아무 보장이 안 된다.** 동시성 버그는 평소에 안 나고 트래픽이 몰릴 때만 나기 때문이다. 네 방식을 비교했다면, **비교 결과를 테스트로 고정**하는 데까지 가야 한다.

```java
@SpringBootTest
class StockConcurrencyComparisonTest {

    @Autowired StockRetryFacade optimistic;      // ① 낙관적 락 + 재시도
    @Autowired StockPessimisticService pessimistic;  // ②
    @Autowired StockAtomicService atomic;         // ③
    @Autowired StockFacade distributed;           // ④
    @Autowired StockRepository stockRepository;
    @Autowired TransactionTemplate txTemplate;    // ⚠️ 테스트에 @Transactional 을 붙이지 않는다

    Long stockId;

    @BeforeEach
    void setUp() {
        // 픽스처는 "커밋되는" 트랜잭션으로 만들어야 다른 스레드에서 보인다
        stockId = txTemplate.execute(s -> stockRepository.save(new Stock(1L, 100)).getId());
    }

    @ParameterizedTest
    @MethodSource("approaches")
    void 어떤_방식이든_재고는_정확히_0이_되고_음수가_되지_않는다(
            String name, Consumer<Long> decrease) throws Exception {

        int threads = 100;
        ExecutorService pool = Executors.newFixedThreadPool(32);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch start = new CountDownLatch(1);      // ← 동시 출발 신호
        CountDownLatch done  = new CountDownLatch(threads);

        AtomicInteger success = new AtomicInteger();
        AtomicInteger failure = new AtomicInteger();

        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                ready.countDown();
                try {
                    start.await();                 // 전원이 여기서 대기하다가 한꺼번에 출발
                    decrease.accept(stockId);
                    success.incrementAndGet();
                } catch (OutOfStockException | StockConflictException
                         | LockAcquisitionException e) {
                    failure.incrementAndGet();     // 실패는 버그가 아니라 관측 대상이다
                } catch (Exception e) {
                    throw new RuntimeException(e);
                } finally {
                    done.countDown();
                }
            });
        }

        ready.await();
        long t0 = System.nanoTime();
        start.countDown();                          // 동시 출발!
        assertThat(done.await(60, TimeUnit.SECONDS)).isTrue();
        long elapsedMs = (System.nanoTime() - t0) / 1_000_000;
        pool.shutdown();

        // ⚠️ 테스트 스레드의 1차 캐시가 아니라 DB 의 최종 상태를 읽는다
        int finalQty = txTemplate.execute(s ->
                stockRepository.findById(stockId).orElseThrow().getQty());

        assertThat(finalQty).isEqualTo(100 - success.get());   // 초과 차감이 없다
        assertThat(finalQty).isNotNegative();                  // 음수가 되지 않는다
        assertThat(success.get() + failure.get()).isEqualTo(threads);  // 사라진 요청이 없다
        log.info("[{}] 성공={} 실패={} 소요={}ms", name, success.get(), failure.get(), elapsedMs);
    }
}
```

**이 테스트가 실제로 답하는 질문 네 개**:

- **① 초과 차감이 있는가** — `@Version`을 떼고 돌리면 최종 재고가 0보다 훨씬 크게 남는다. 그게 lost update의 모습이고, **테스트를 한 번 실패시켜 보는 것까지가 세트**다.
- **② 조용히 사라진 요청이 있는가** — `성공 + 실패 = 전체`가 깨지면 어딘가에서 예외가 삼켜지고 있다.
- **③ 각 방식의 실제 소요 시간은 어떻게 다른가** — 말로 한 트레이드오프를 숫자로 확인한다. 원자적 UPDATE와 비관적 락의 차이가 실제로 몇 배인지 보고 나면, 면접에서도 근거를 갖고 말할 수 있다.
- **④ 재시도 방식은 몇 번 만에 끝났는가** — 이건 단정이 아니라 **메트릭으로 노출**할 대상이다.

**함정 세 가지**:

- **테스트 클래스에 `@Transactional`을 붙이면 재현이 안 된다.** 픽스처가 커밋되지 않아 다른 스레드에서 안 보이고, 마지막 검증도 테스트 스레드의 1차 캐시에서 옛 값을 읽는다(**DB는 0인데 테스트는 100을 본다**). `TransactionTemplate`으로 커밋되는 픽스처를 만들고 `@AfterEach`에서 지운다.
- **H2로 검증하면 안 된다.** `for update`의 동작, 데드락 감지, 락 타임아웃, `CHECK` 제약 지원은 **DB 벤더마다 다르다.** 동시성 테스트만큼은 **Testcontainers로 운영과 같은 엔진**을 띄운다. *H2에서 통과한 동시성 테스트는 보장의 근거가 되지 못한다.*
- **커넥션 풀 크기를 의식한다.** 스레드 100개가 전부 `FOR UPDATE`를 하면 풀 크기만큼만 진입한다. 테스트가 이유 없이 느리다면 그건 버그가 아니라 **§1-2에서 설명한 커넥션 고갈을 테스트가 그대로 재현한 것**이다. 그 시간을 임계값으로 고정해두면 성능 회귀 테스트가 된다.

**운영에서는 메트릭으로 이어 붙인다.** 어떤 방식을 골랐든 **① 재시도 횟수 ② 충돌률(실패/전체) ③ 락 획득 대기 시간 ④ 락 획득 실패율**을 Micrometer 카운터/타이머로 노출한다. "충돌이 드물다"는 전제로 낙관적 락을 골랐다면, **그 전제가 계속 참인지 감시하는 장치**가 있어야 선택이 완성된다. 전제가 깨졌을 때(충돌률이 임계치를 넘었을 때) 알림이 오는 것이 **선택을 재검토할 신호**다. **(가산점 포인트)**

---

## 6. 꼬리질문 대비 포인트

### "네 가지 중 하나만 고르라면 무엇을 고르시겠습니까?"

**"상황을 하나 정해주시면 고르겠습니다"가 정직한 첫 반응이지만, 그것만으로 끝내면 회피로 들린다.** 기본값을 밝히고, 그 기본값이 깨지는 조건을 같이 말하는 게 좋다.

> "**기본값은 원자적 UPDATE입니다.** 재고 차감처럼 '읽고 검증하고 계산하고 쓴다'가 SQL 한 문장으로 압축되는 모양이면, 임계 구간이 가장 짧고 재시도가 아예 필요 없기 때문입니다. **대신 포기하는 것은 영속성 컨텍스트와의 일관성, 그리고 도메인 로직이 SQL로 새어 나갈 위험**입니다. 그 대가를 감당할 수 있는 이유는 이 쿼리를 쓴 트랜잭션에서 그 엔티티를 다시 읽지 않는다는 규칙 하나로 관리되고, 차감 정책은 엔티티에 두고 계산 결과만 파라미터로 넘기면 누수도 막을 수 있기 때문입니다. **다만 정책이 그 행의 현재 값에 의존하기 시작하면 그 분리가 깨지므로, 그때 낙관적/비관적 락으로 넘어갑니다.**"

여기서 중요한 건 **"고른다 → 얻는 것 → 포기하는 것 → 감당할 수 있는 이유 → 이 선택이 깨지는 신호"** 를 한 호흡에 넣는 것이다. 이 문항은 지식이 아니라 **이 구조**를 보는 자리다.

### "원자적 UPDATE가 임계 구간도 가장 짧고 재시도도 없다면, 왜 모든 재고·포인트 갱신을 그걸로만 처리하지 않나요?"

**세 가지를 포기하기 때문이다.**

① **영속성 컨텍스트를 우회한다.** [벌크 연산](bulk-operation-persistence-context.md)과 같은 성질이라 변경 감지를 거치지 않고 바로 DB로 나가고, **같은 트랜잭션에서 그 엔티티를 다시 읽으면 1차 캐시의 옛 값이 나온다.** `@Modifying(clearAutomatically = true)`로 해결할 수 있어 보이지만, **컨텍스트를 통째로 비우기 때문에 같은 트랜잭션에서 수정 중이던 다른 엔티티의 변경분까지 조용히 사라진다.** 실무적 처방은 **벌크성 쿼리를 트랜잭션 마지막에 두거나 별도 트랜잭션으로 분리하는 것**이다.

② **도메인 로직이 엔티티가 아니라 SQL로 새어 나간다.** 등급별 차감량이나 프로모션 배수 같은 규칙이 쿼리 문자열의 `case when`으로 들어가기 시작하면 **단위 테스트가 불가능해지고, 재사용이 안 되고, 규칙이 어디 있는지 아무도 모르게 된다.** 처방은 **계산은 엔티티에서, SQL에는 `where qty >= :amount`라는 원자성 조건만** 남기는 것이다.

③ **표현력이 급락한다.** 여러 필드를 함께 갱신하거나, 다른 테이블 상태에 조건이 걸리거나, 차감 결과에 따라 분기해야 하면 한 문장에 담을 수 없다. 그리고 **`@Version`을 올리지 않아** 같은 엔티티를 낙관적 락으로도 보호 중이라면 그 변경이 감지되지 않는다.

### "분산 락을 걸었는데 재고가 음수가 됐습니다. 어떻게 된 거죠?" (시니어 변별 포인트)

**분산 락은 뚫린다. 그게 정상이다** — 라는 인식에서 출발해야 한다. **Redis 분산 락은 정합성 보증 장치가 아니라 부하 최적화 장치**이기 때문이다.

뚫리는 경로는 셋이다. **① TTL 만료** — 락을 잡은 스레드가 GC 정지나 DB 지연으로 `leaseTime`을 넘기면 Redis가 락을 만료시키고 다른 요청이 같은 락을 잡는다. 원래 스레드는 그 사실을 모른 채 UPDATE를 실행한다. **② 노드 장애·페일오버** — 마스터가 `SET NX`를 받고 복제 전에 죽으면 승격된 레플리카에는 그 락이 없다. **③ 락을 안 거치는 경로** — 배치, 운영자 수동 SQL, 다른 팀 서비스. 락은 "모두가 지키기로 한 약속"일 뿐이라 **약속을 모르는 참가자를 막지 못한다.** 여기에 **락 획득을 트랜잭션 안에서 해서 `unlock()`이 커밋보다 먼저 일어난 경우**도 흔한 원인이다(§4-2).

**그래서 정합성의 최종 보증은 항상 DB여야 한다.** 두 겹으로 건다 — `update ... where qty >= ?`(그 쿼리를 쓴 코드를 지킨다)와 `CHECK (qty >= 0)`(**어떤 경로로 들어오든 지킨다**). 이 둘이 있으면 락이 몇 번 뚫려도 재고는 음수가 되지 않고, 뚫린 요청은 **영향 행 수 0 = 품절**로 안전하게 실패한다.

**(가산점)** 원리적으로 막고 싶다면 **fencing token** — 락 발급 시 단조 증가 번호를 함께 주고, 저장소가 `and fence_token < ?` 조건으로 **늦게 도착한 쓰기를 스스로 거부**하게 만드는 방식이다.

### "낙관적 락 재시도를 `@Transactional` 메서드 안에서 `for` 루프로 감쌌습니다. 문제가 있나요?" (시니어 변별 포인트)

**두 가지 문제가 겹쳐 있고, 하나만 고치면 여전히 안 된다.**

**첫째, `rollback-only` 마킹.** 트랜잭션 도중 낙관적 락 예외가 나면 트랜잭션에 "롤백만 가능" 표시가 찍힌다. `catch`로 삼켜도 표시는 지워지지 않아, **루프가 성공한 것처럼 보여도 커밋 시점에 `UnexpectedRollbackException`이 터진다.** *예외를 잡았다고 없던 일이 되지 않는다.* 게다가 §1-1에서 본 것처럼 **낙관적 락 예외는 원래 커밋 시점에 터지므로**, `saveAndFlush()`로 앞당기지 않으면 애초에 잡을 기회조차 없다.

**둘째, 1차 캐시에 남은 옛 version.** `rollback-only`를 피하려고 트랜잭션을 루프 밖으로 빼도, **영속성 컨텍스트가 같으면 `findById`가 DB로 SELECT를 보내지 않고 캐시의 옛 엔티티를 그대로 돌려준다.** 그래서 두 번째 시도에서도 `version = 3`으로 UPDATE를 날리고, 다섯 번을 돌아도 **똑같은 실패를 반복한다.**

**올바른 형태는 새 트랜잭션 + 새 영속성 컨텍스트다.** 재시도 담당 빈(`@Retryable`, `@Transactional` 없음)과 트랜잭션 담당 빈(`@Transactional`)을 **분리**하면, 실패 시 트랜잭션이 롤백되면서 영속성 컨텍스트가 통째로 폐기되고 다음 호출이 **정말로 DB에서 최신 version을 읽는다.** 두 문제가 동시에 풀린다. 여기에 **지수 백오프 + 지터**(실패한 요청들이 정확히 같은 시각에 깨어나 또 부딪히는 thundering herd 방지)와 **재시도 상한 + `@Recover` 포기 경로**를 붙인다. `REQUIRES_NEW`로도 같은 효과를 낼 수 있지만 **커넥션을 2개씩 쓴다**는 점을 계산에 넣어야 한다.

### "분산 락을 걸어도 UPDATE는 그대로 DB로 나갑니다. 그런데 'DB 부하가 준다'는 게 정확히 무슨 뜻인가요?" (시니어 변별 포인트)

**반론이 절반 맞다 — 쿼리 수는 줄지 않는다. 줄어드는 것은 커넥션 점유 시간이다.** 정확한 표현은 **"락을 트랜잭션 밖에서 잡음으로써 대기 비용을 DB 커넥션 풀 밖으로 밀어내는 것"** 이다.

임계 구간이 아무리 짧아도 순간에 요청이 몰리면 커넥션을 물고 있을 수밖에 없고, **커넥션은 서비스 전체가 공유하는 자원**이라 재고 API 하나의 경합이 로그인·조회까지 마비시킨다. 분산 락은 대기 줄을 **커넥션을 빌리기 전 단계**로 옮겨 그 전파를 끊는다. 부수적으로 **대기 상한(`waitTime`)을 커넥션과 무관하게 정할 수 있다**는 이점도 생긴다.

**그리고 이 이점은 조건부다.** 락을 `@Transactional` 안에서 잡으면 **대기 시간이 커넥션 점유 구간 안으로 들어와** 비관적 락과 똑같이 풀이 고갈되고, Redis 왕복 2회만 더 붙은 순수한 손해가 된다. 게다가 `unlock()`이 커밋보다 먼저 일어나 **다음 요청이 커밋 전 값을 읽는 lost update**까지 생긴다. **순서는 반드시 락 획득 → 트랜잭션 시작 → 커밋 → 락 해제**여야 한다.

### "선착순 1,000명 이벤트에 초당 5만 요청이 예상됩니다. 네 가지 중 무엇을 쓰시겠습니까?" (가산점 포인트)

**"네 가지 중에는 답이 없습니다"가 출발점이다.** 무엇을 쓰든 DB의 그 행 하나에 요청이 직렬화되고, 처리량 상한은 대략 `1 / 임계 구간 길이`다. 임계 구간이 0.5ms면 초당 2,000건이 한계이므로 **5만 건은 애초에 DB 앞에 세울 물량이 아니다.**

그래서 질문을 바꾼다 — **"어떤 락을 쓸까"가 아니라 "DB를 때리지 않고 수량을 선점할 수 있나"** 로. **Redis `DECR`로 수량을 선점**하고(단일 스레드에서 원자적으로 실행되므로 락 없이도 정확히 센다), **음수가 나오면 `INCR`로 되돌리고 즉시 품절 응답**을 준다. 여기까지 온 1,000건만 큐에 실려 DB로 흘러가고, 나머지 49,000건은 Redis에서 끝난다. **락을 빠르게 만든 게 아니라 DB에 도달하는 트래픽 자체를 1/50로 줄인 것**이다. **여기서 Redis는 락이 아니라 카운터로 쓰인다**는 점이 핵심이고, 최종 확정은 여전히 `where qty >= 1` + `CHECK` 제약이 지킨다.

**포기하는 것도 같이 말해야 한다** — 응답이 "처리 중"이라는 **잠정 상태**가 되어 UX와 알림 설계가 필요해지고, **Redis와 DB 사이 정합성 보정 로직**(미확정 건 재처리, 실패 시 카운터 복구)이 생긴다. **이 복잡도를 감당할 만큼 트래픽이 극단적일 때만** 정당하다. 평상시 재고 차감에 이 구조를 쓰면 과한 설계다.

### "이 네 가지는 서로 배타적인가요?"

**아니다. 실무의 답은 대개 층을 쌓는 것이다.** 각 층이 막는 것이 다르기 때문이다.

**1층 진입 제어(분산 락 또는 Redis 카운터)** 는 커넥션 풀이 대기로 고갈되는 것을 막지만 정합성은 못 지킨다. **2층 원자적 갱신(`where qty >= ?`)** 은 1층이 뚫렸을 때의 초과 차감을 막지만 그 쿼리를 안 쓰는 경로는 못 막는다. **3층 DB 제약(`CHECK`, 유니크)** 은 모든 경로를 막는 마지막 방어선이다. **각 층은 위층이 실패했다고 가정하고 설계된다.**

여기에 하나 더 붙이면 좋다 — **과한 층 쌓기도 나쁜 설계다.** 충돌이 하루 몇 건인 관리자 화면에 분산 락을 도입하면 인프라 의존과 실패 모드만 늘어난다. **층은 §4-1의 판단 플로우가 요구하는 만큼만 쌓는다.**

---

## 한 줄 요약

**선택의 기준은 "충돌 빈도"가 아니라 "임계 구간에 무엇이 들어가는가"다** — **임계 구간에 DB 밖 자원(외부 PG·여러 DB·멀티 인스턴스)이 있으면 분산 락**, 없다면 **읽고·계산하고·쓰는 과정이 SQL 한 문장으로 압축되는지**를 묻고 **압축되면 원자적 UPDATE가 기본값**, 압축이 안 되면 **충돌이 잦을 때 비관적 락(대가는 커넥션 점유·데드락), 드물 때 낙관적 락**(대가는 로직 전체 재실행과 재시도 코드)이다. 네 방식은 **무슨 자원을 소모하는가**로 갈린다 — 낙관적 락은 스레드와 재실행 비용, 비관적 락은 **커넥션과 열린 트랜잭션**, 원자적 UPDATE는 **영속성 컨텍스트 일관성과 도메인 모델**, 분산 락은 **인프라 의존과 정합성 보증 자체**를 내준다. 그래서 **Redis 분산 락은 안전장치가 아니라 부하 최적화 장치**이며 그 이점도 **락을 트랜잭션 밖에서 잡을 때만**(락 획득 → 트랜잭션 → 커밋 → 락 해제) 성립한다. **정합성의 최종 보증은 언제나 DB** — `where qty >= ?`와 `CHECK (qty >= 0)`을 함께 걸어 어떤 경로로 뚫려도 음수가 되지 않게 만든다. 그리고 이건 **사지선다가 아니라 층 쌓기**이며, 그 층이 실제로 작동하는지는 **`CountDownLatch`로 동시 출발시킨 테스트를 실제 DB(Testcontainers)에서 돌려보기 전까지 주장일 뿐이다.**
