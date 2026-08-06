# 낙관적 락(`@Version`)과 비관적 락 — 잠그지 않고 사후에 감지하는 것 vs 먼저 잠그는 것

> 핵심 관전 포인트: 첫 문장에서 오해부터 부순다 — **낙관적 락은 락이 아니다. 아무것도 잠그지 않고, 충돌을 사후에 감지할 뿐이다.** 흔한 오해가 "업데이트 직전에 다시 조회해서 값이 같은지 확인한 뒤 갱신한다"(check-then-act)인데, **별도 SELECT는 존재하지 않는다.** 하이버네이트가 날리는 것은 `UPDATE ... SET (필드들), version = ? WHERE id = ? AND version = ?` **한 문장**이고, 확인이 `WHERE`절 안에 들어가 있기 때문에 확인과 갱신 사이에 틈이 없다. 충돌 판정 근거는 값 비교가 아니라 **영향받은 행 수(affected rows)가 0인지**이고, 0이면 `OptimisticLockException`(Spring 계층에서는 `ObjectOptimisticLockingFailureException`)이 난다. **비관적 락(`PESSIMISTIC_WRITE` = `SELECT ... FOR UPDATE`)은 반대로 조회 시점부터 DB가 실제로 행을 잠근다.** 선택 기준은 **충돌 빈도 × 재시도 비용**이지만, 여기에 두 가지를 더 붙여야 답이 완성된다. ① **재시도는 반드시 새 트랜잭션에서** 해야 한다 — 같은 트랜잭션에서 재시도하면 1차 캐시에 옛 버전 엔티티가 남아 영원히 실패한다. ② **비관적 락의 숨은 대가는 스레드가 아니라 DB 커넥션이다** — 락 대기 시간 내내 커넥션을 점유하므로 가상 스레드로도 풀 고갈은 해결되지 않는다. 그리고 마지막 축 하나: **"기다리느냐 마느냐"가 아니라 "얼마나 오래 기다리게 하느냐"** 다. 같은 로우를 치는 이상 직렬화는 피할 수 없지만, 락 보유 구간에서 네트워크 왕복과 자바 계산을 걷어내면 임계 구간의 자릿수가 달라진다.

---

## 0. 질문 + 의도

**질문**: "JPA의 낙관적 락(`@Version`)과 비관적 락의 차이, 각각 언제 사용하나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "동시 수정 시나리오(같은 회차를 두 관리자가
편집)에서 **충돌 빈도와 재시도 비용을 따져 선택하는 판단력.** '락이 필요하다'까지는 다
알지만 '**어떤 락인지**'의 근거를 대는 사람은 적다." 즉 채점 지점은 두 락의 정의 암기가
아니라 ① 각각이 **DB 레벨에서 실제로 무슨 SQL을 만드는가**를 아는가 ② 그 차이가
**어떤 부작용(재시도 폭풍 / 커넥션 점유)으로 이어지는가**를 연결할 수 있는가
③ 우리 서비스의 트래픽 특성에 맞춰 **근거를 대며 고를 수 있는가**다.

**함정 두 개**:
- **"낙관적 락"이라는 이름에 속아 "가벼운 락"으로 이해하는 것.** 낙관적 락은 가벼운
  락이 아니라 **락이 아예 아니다.** 이 차이를 놓치면 "확인과 갱신 사이에 틈이 있으니
  결국 안전하지 않다 → 비관적 락밖에 없다"는 오결론까지 자동으로 따라온다.
- **"충돌이 드물면 낙관적, 잦으면 비관적"에서 멈추는 것.** 방향은 맞지만 이건 정의를
  바꿔 말한 것에 가깝다. 면접관이 원하는 건 **"드물다"를 무엇으로 판단하고,
  틀렸을 때 각각 어떤 모습으로 무너지는가**다.

---

## 1. 첫 번째 못 — 낙관적 락은 락이 아니다

### 1-1. 가장 흔한 오해: check-then-act 모델

많은 사람이 `@Version`의 동작을 이렇게 상상한다.

```
① SELECT version FROM product WHERE id = 1     → version = 3 을 읽음
② (애플리케이션에서 로직 수행)
③ SELECT version FROM product WHERE id = 1     → "아직도 3인가?" 다시 확인
④ 같으면 UPDATE 실행
```

이 모델은 **"확인하고(check) 나서 행동한다(act)"** 는 뜻으로 check-then-act 패턴이라
부른다. 그리고 이 모델이 맞다면 **정말로 안전하지 않다.** ③과 ④ 사이에 다른
트랜잭션이 끼어들어 version을 4로 올려버리면, 우리는 "3이었다"는 낡은 확인 결과를
근거로 덮어쓰게 된다. 확인과 행동이 **두 문장**이면 그 사이는 언제나 뚫린다.

> **핵심**: 이 오해에서 출발하면 "낙관적 락은 근본적으로 구멍이 있고, 틈을 없애려면
> 비관적 락뿐"이라는 결론에 논리적으로 도달한다. **결론이 틀린 게 아니라 전제가
> 틀린 것**이다. 실제 `@Version`은 애초에 ①③④ 같은 여러 문장을 쓰지 않는다.

### 1-2. 실제로 하이버네이트가 날리는 SQL

`@Version` 필드가 있는 엔티티를 수정하면 하이버네이트는 **UPDATE 한 문장**만 날린다.
확인이 별도 SELECT가 아니라 **그 UPDATE의 `WHERE`절 안에** 들어간다.

```java
@Entity
public class Product {
    @Id @GeneratedValue
    private Long id;

    private String name;
    private int stock;

    @Version                    // ← 이 한 줄이 전부다
    private Long version;
}
```

```java
@Transactional
public void rename(Long id, String newName) {
    Product p = productRepository.findById(id).orElseThrow();  // version = 3 을 읽음
    p.setName(newName);                                        // 변경 감지(dirty checking)
}   // ← 커밋 시점에 flush → 아래 UPDATE 가 나간다
```

**실제 SQL 로그 (`spring.jpa.show-sql=true` + 바인딩 파라미터 로그)**

```sql
-- ❌ 사람들이 있을 거라고 생각하는 "재확인 SELECT" — 이런 건 나가지 않는다.
-- select version from product where id=?      ← 존재하지 않음

-- ✅ 실제로 나가는 것은 이 한 줄뿐이다.
update
    product
set
    name=?,
    stock=?,
    version=?          -- 바인딩 값 = 읽어온 버전 + 1  (즉 4)
where
    id=?
    and version=?      -- 바인딩 값 = 읽어온 버전      (즉 3)
```

**`@Version`이 없을 때와 비교하면 차이가 선명하다.**

```sql
-- ❌ BEFORE — @Version 없는 엔티티
update product set name=?, stock=? where id=?
--                                    ↑ id 만 본다. 남이 뭘 바꿨든 그냥 덮어쓴다(lost update)

-- ✅ AFTER — @Version 붙인 엔티티
update product set name=?, stock=?, version=? where id=? and version=?
--                                                        ↑ "내가 읽었을 때 그대로일 때만 써라"
```

여기서 반드시 짚어야 할 사실이 하나 더 있다. 로그에는 `version = version + 1`이 아니라
`version=?` 로 찍힌다. **하이버네이트는 새 버전 값을 메모리에서 계산해(읽은 값 + 1)
파라미터로 바인딩한다.** 개념적으로는 `version + 1`이 맞지만, 실제 SQL 문자열을 물으면
`version=?`라고 답하는 편이 정확하다. **(가산점 포인트)**

### 1-3. 충돌은 무엇으로 감지하는가 — 값 비교가 아니라 "영향 행 수"

이 부분이 이 문항의 채점 포인트다. 하이버네이트는 UPDATE 결과로 돌아온
**영향받은 행 수(affected rows)** 만 본다.

```
UPDATE ... WHERE id = 1 AND version = 3

  → 영향 행 수 1  : 아무도 안 건드렸다. 정상. version 은 이제 4.
  → 영향 행 수 0  : WHERE 조건에 걸리는 행이 없다
                    = 누군가 이미 version 을 4 이상으로 올렸다
                    = 충돌!  → OptimisticLockException
```

즉 **"충돌이 났다"를 알아내는 방법은 데이터를 다시 읽어서 비교하는 게 아니라,
DB가 돌려준 숫자가 0인지 보는 것**이다. 이 감지는 **UPDATE가 이미 실패한 뒤**에
일어난다. 그래서 이 표현이 성립한다.

> **낙관적 락은 잠그지 않는다. "충돌하지 않을 것"에 베팅하고, 틀렸을 때 예외를 받는다.**
> 막는(prevention) 장치가 아니라 **감지(detection) 장치**다.

비유하면 이렇다. 비관적 락은 **회의실 문을 잠그고 들어가는 것**이고, 낙관적 락은
**문을 잠그지 않되 나올 때 "내가 들어올 때 두고 간 종이가 그대로인가"를 확인하는 것**이다.
후자는 아무도 안 들어올 거라는 데 베팅하는 대신, **평소에는 잠그는 비용이 0원**이다.
이게 낙관적 락의 진짜 장점이다 — 충돌이 없을 때 추가 쿼리도, 대기도, 커넥션 점유도 없다.
`WHERE`절에 조건 하나가 붙을 뿐이다.

### 1-4. 예외 타입 — JPA / 하이버네이트 / Spring 세 층

같은 사건인데 계층마다 이름이 다르다. 면접에서 헷갈리기 쉬운 지점이라 정리해둔다.

| 계층 | 타입 | 언제 보게 되나 |
|---|---|---|
| JPA 표준 | `jakarta.persistence.OptimisticLockException` | 순수 JPA(`EntityManager`) 사용 시 |
| 하이버네이트 | `org.hibernate.StaleObjectStateException` | 하이버네이트가 내부에서 던지는 원본 |
| Spring | `org.springframework.orm.ObjectOptimisticLockingFailureException` | **Spring Data JPA 사용 시 실무에서 보는 것** |

Spring은 예외 변환(exception translation)을 거쳐 벤더별 예외를 자기 계층의
`DataAccessException` 계열로 바꾼다. 그래서 **Spring Data JPA를 쓰는 코드에서 잡아야 할
것은 `ObjectOptimisticLockingFailureException`**(또는 그 부모인
`OptimisticLockingFailureException`)이다. `catch (OptimisticLockException e)`만 걸어두면
안 잡히는 경우가 생긴다.

그리고 **예외가 터지는 위치**가 실무에서 훨씬 중요하다.

```java
@Transactional
public void rename(Long id, String newName) {
    Product p = productRepository.findById(id).orElseThrow();
    p.setName(newName);
    // ← 여기서는 아무 일도 안 일어난다. UPDATE 는 아직 안 나갔다.
}   // ← 커밋 직전 flush 에서 UPDATE 가 나가고, 여기서 예외가 터진다
    //   즉 예외는 "메서드 본문 밖", 트랜잭션 경계에서 발생한다
```

변경 감지는 flush 시점에 UPDATE를 만들고, flush는 보통 **커밋 직전**이다. 따라서
**메서드 안에서 `try-catch`로 감싸도 이 예외는 안 잡힌다.** 이 사실이 다음 장(재시도)의
전제가 된다. 예외를 메서드 안에서 보고 싶다면 `saveAndFlush()`나 `entityManager.flush()`로
flush를 앞당겨야 한다.

### 1-5. `@Version` 실전 주의점 4가지

**① 엔티티가 실제로 바뀌어야 검사된다.**
변경된 필드가 없으면 UPDATE 자체가 안 나가고, UPDATE가 없으면 버전 검사도 없다.
"읽기만 하고 다른 엔티티를 바꾼" 경우 그 읽은 엔티티는 보호되지 않는다.

```java
// ❌ Order 만 바꾸는데 Product 의 재고 조건을 근거로 삼는 경우
Product p = productRepository.findById(id).orElseThrow();  // stock = 5 확인
if (p.getStock() >= 1) {
    orderRepository.save(new Order(...));   // Order 만 INSERT
}   // ← Product 는 안 바뀌었으니 UPDATE 도 없고, version 검사도 없다.
    //   그 사이 다른 트랜잭션이 stock 을 0으로 만들어도 우리는 모른다.

// ✅ 읽기만 한 엔티티에도 버전 검사를 강제하려면 명시적 락 모드를 건다
Product p = entityManager.find(Product.class, id,
        LockModeType.OPTIMISTIC);                   // 커밋 시 version 확인
// 또는 "이 엔티티를 건드렸다"고 버전을 강제로 올리려면
        LockModeType.OPTIMISTIC_FORCE_INCREMENT;    // version 을 +1 해서 UPDATE
```

`OPTIMISTIC_FORCE_INCREMENT`는 **애그리거트 루트 보호**에 쓴다. 자식(`OrderItem`)만
바뀌었는데 부모(`Order`)의 버전을 올려서 "이 주문 전체가 변경됐다"고 표시하는 식이다.

**② 벌크 연산은 버전을 올리지 않는다.**
`@Modifying` JPQL이나 네이티브 UPDATE는 영속성 컨텍스트와 `@Version`을 모두 우회한다.
버전을 올려야 한다면 SQL에 직접 써야 한다.

```java
// ❌ version 이 그대로 → 다른 트랜잭션의 낙관적 락이 이 변경을 감지 못 한다
@Modifying
@Query("update Product p set p.stock = p.stock - 1 where p.id = :id")
int decrease(@Param("id") Long id);

// ✅ 벌크에서도 버전을 직접 올린다
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Product p set p.stock = p.stock - 1, p.version = p.version + 1 " +
       "where p.id = :id and p.stock >= 1")
int decrease(@Param("id") Long id);
```

(벌크 연산 후 1차 캐시가 어긋나는 문제는 별도 문항이다 —
[벌크 연산과 영속성 컨텍스트](bulk-operation-persistence-context.md),
[영속성 컨텍스트와 변경 감지](persistence-context-dirty-checking.md) 참고.)

**③ 버전 필드 타입.** JPA 스펙이 보장하는 것은 정수 계열(`int`/`Integer`/`short`/
`Short`/`long`/`Long`)과 `java.sql.Timestamp`다. **타임스탬프는 피하는 게 좋다** —
시계 정밀도가 낮으면 서로 다른 두 수정이 같은 값이 되어 충돌을 놓칠 수 있다.
숫자를 쓰면 그런 여지가 없다.

**④ 준영속 엔티티에도 버전이 실린다.** 화면에서 받은 DTO에 version을 담아
`merge()`하면 **화면을 연 시점 기준의 충돌 검사**가 된다. 이게 "두 관리자가 같은 화면을
동시에 편집" 시나리오를 푸는 정석이다(§5-2). 다만 `merge()`는 전 필드를 덮어쓰므로
PATCH 용도로는 쓸 수 없다 —
[merge vs 변경 감지](merge-vs-dirty-checking.md) 참고.

---

## 2. 재시도의 함정 — 같은 트랜잭션에서 재시도하면 영원히 실패한다

낙관적 락은 "실패할 수 있다"를 전제로 하는 구조다. 그러니 **재시도가 세트로 따라온다.**
그런데 여기가 실무에서 가장 많이 틀리는 지점이다.

### 2-1. 왜 같은 트랜잭션 안에서는 안 되는가

```java
// ❌ BEFORE — 절대 성공하지 않는 재시도
@Transactional
public void decrease(Long id) {
    for (int i = 0; i < 3; i++) {
        try {
            Product p = productRepository.findById(id).orElseThrow();
            p.setStock(p.getStock() - 1);
            productRepository.flush();      // 여기서 UPDATE + 충돌 감지
            return;
        } catch (ObjectOptimisticLockingFailureException e) {
            // 다시 시도 → 그런데 findById 가 DB 를 다시 읽지 않는다
        }
    }
}
```

**실패하는 이유가 두 겹이다.**

**첫째, 1차 캐시.** 같은 트랜잭션 = 같은 영속성 컨텍스트다. `findById(id)`는 **이미
영속성 컨텍스트에 있는 엔티티를 그대로 돌려준다.** DB로 SELECT를 다시 보내지 않는다.
그래서 두 번째 시도에서도 `version = 3`짜리 옛날 객체를 손에 쥐고, 또 `WHERE version = 3`을
날리고, 또 영향 행 수 0을 받는다. **무한히 같은 실패를 반복한다.**

**둘째, 롤백 표시(rollback-only).** 트랜잭션 중에 이런 예외가 발생하면 하이버네이트
세션은 이미 일관성을 잃은 상태로 간주된다. 예외를 잡아서 삼켜도 트랜잭션에는
**"롤백만 가능" 표시**가 찍혀 있어, 결국 커밋 시점에 실패한다. **예외를 잡았다고
없던 일이 되지 않는다.**

### 2-2. 올바른 형태 — 재시도의 매 회차가 새 트랜잭션이어야 한다

```java
// ✅ AFTER — 재시도 책임과 트랜잭션 책임을 다른 빈으로 분리
@Service
@RequiredArgsConstructor
public class StockFacade {                       // ← 재시도만 담당. @Transactional 없음!

    private final StockService stockService;

    @Retryable(
        retryFor = ObjectOptimisticLockingFailureException.class,
        maxAttempts = 5,
        backoff = @Backoff(delay = 50, multiplier = 2.0, maxDelay = 500, random = true)
    )
    public void decrease(Long id) {
        stockService.decrease(id);               // 호출할 때마다 새 트랜잭션이 열린다
    }

    @Recover
    public void recover(ObjectOptimisticLockingFailureException e, Long id) {
        throw new StockConflictException("잠시 후 다시 시도해 주세요", e);
    }
}

@Service
@RequiredArgsConstructor
public class StockService {

    private final ProductRepository productRepository;

    @Transactional                                // ← 트랜잭션만 담당
    public void decrease(Long id) {
        Product p = productRepository.findById(id).orElseThrow();
        if (p.getStock() < 1) throw new OutOfStockException();
        p.setStock(p.getStock() - 1);
    }   // ← 커밋. 충돌이면 여기서 예외 → 트랜잭션 롤백 → 영속성 컨텍스트도 함께 폐기
}
```

**왜 이게 되는가.** `stockService.decrease(id)`가 예외로 끝나면 트랜잭션이 롤백되고
**영속성 컨텍스트가 통째로 버려진다.** 다음 호출은 완전히 새 트랜잭션 + 새 영속성
컨텍스트이므로, `findById`가 **정말로 DB에서 최신 version을 다시 읽는다.**
"다시 조회해서 재실행"이라는 직관 자체는 옳지만, **그 '다시 조회'가 성립하려면 영속성
컨텍스트가 새것이어야 한다**는 조건이 붙는다.

### 2-3. 왜 굳이 빈을 분리했나 — 프록시(AOP) 순서 문제

`@Retryable`과 `@Transactional`을 **같은 메서드에** 붙이면 순서가 어긋날 위험이 있다.

```
[올바른 순서]  요청 → 재시도 프록시 → 트랜잭션 프록시 → 메서드
                       └── 커밋 실패까지 감싼다 ✅  매 회차가 새 트랜잭션

[잘못된 순서]  요청 → 트랜잭션 프록시 → 재시도 프록시 → 메서드
                                          └── 재시도가 트랜잭션 안에 갇힘 ❌
                                              ① 커밋은 재시도가 끝난 뒤 → 커밋 시 예외를 못 잡음
                                              ② 잡아도 1차 캐시가 그대로 → §2-1 무한 실패
```

§1-4에서 본 것처럼 **낙관적 락 예외는 커밋 시점에 터진다.** 재시도 프록시가 트랜잭션
프록시 안쪽에 있으면, 재시도 로직이 다 끝나고 리턴한 **다음에** 커밋이 일어나므로
예외를 잡을 기회조차 없다. **재시도는 반드시 트랜잭션보다 바깥에 있어야 한다.**

Spring Retry의 기본 순서 설정은 재시도 advice가 트랜잭션보다 바깥에 오도록
잡혀 있고 `@EnableRetry(order = ...)`로 조정할 수도 있지만, **프록시 순서라는 눈에 안
보이는 규칙에 코드의 정확성을 의존시키는 것 자체가 나쁜 설계**다. 빈을 나누면
호출 스택에 순서가 드러나므로 읽는 사람이 헷갈릴 여지가 없다. **(가산점 포인트)**

> 덤으로, 같은 클래스 안에서 `this.decrease()`처럼 자기 메서드를 호출하면 프록시를
> 거치지 않아 `@Retryable`도 `@Transactional`도 **아예 동작하지 않는다.** 빈 분리는
> 이 자기 호출(self-invocation) 함정도 같이 막아준다.

### 2-4. 지수 백오프와 지터 — 재시도가 상황을 악화시키지 않게

실패한 5개가 **동시에** 즉시 재시도하면, 다음 라운드에서도 5개가 또 부딪힌다.
그래서 두 가지를 건다.

- **지수 백오프(exponential backoff)**: 대기 시간을 회차마다 곱해서 늘린다
  (50ms → 100ms → 200ms → 400ms). 경합이 심할수록 자연히 간격이 벌어져 압력이 낮아진다.
- **지터(jitter, 무작위 흔들기)**: 대기 시간에 난수를 섞는다. 이게 없으면 실패한
  요청들이 **정확히 같은 시각에 깨어나** 또 같이 부딪힌다(thundering herd, 천둥 떼 현상).
  위 코드의 `@Backoff(..., random = true)`가 이 역할이다.

그리고 **재시도 상한과 포기 경로**를 반드시 둔다. 위의 `@Recover`가 그것이다.
상한이 없으면 §3-2에서 볼 커넥션 고갈과 똑같은 결말로 간다.

### 2-5. 그래도 남는 한계 — 재시도 폭풍

한정판 재고처럼 **초당 500건이 전부 같은 로우 하나**를 치면 이야기가 달라진다.

```
1라운드: 500건이 SELECT → 계산 → UPDATE
         → 1건 성공, 499건이 영향 행 수 0
2라운드: 499건이 처음부터 다시 실행 (SELECT + 비즈니스 로직 + UPDATE)
         → 1건 성공, 498건 실패
...
```

**성공 1건당 낭비되는 작업량이 대기 중인 요청 수에 비례**한다. 이걸 재시도 폭풍이라
부른다. 낙관적 락의 전제("충돌은 드물다")가 깨진 상황이고, 여기서 낙관적 락은
**틀린 도구**다. 게다가 재시도 비용은 UPDATE 한 번이 아니라 **비즈니스 로직 전체의
재실행**이라는 점이 중요하다. 로직 안에 외부 API 호출이라도 있으면 재시도는 곧
그 API를 5배 때리는 것이 된다.

---

## 3. 비관적 락 — 진짜로 잠근다, 그리고 커넥션을 붙잡는다

### 3-1. 무엇이 어떤 SQL로 나가는가

```java
// Spring Data JPA — 리포지토리 메서드에 락 모드를 건다
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Product p where p.id = :id")
    Optional<Product> findByIdForUpdate(@Param("id") Long id);
}
```

```sql
-- 위 메서드가 만드는 SQL (MySQL/PostgreSQL 기준)
select p.id, p.name, p.stock, p.version from product p where p.id = ? for update
--                                                            ^^^^^^^^^^
--            이 행은 지금부터 내 트랜잭션이 커밋/롤백할 때까지 다른 트랜잭션이 못 건드린다
```

락 모드 3종의 차이는 짧게 정리된다.

| 모드 | 하는 일 | 전형적 SQL |
|---|---|---|
| `PESSIMISTIC_READ` | 공유 락 — 남의 읽기는 허용, 쓰기는 차단 | `for share` (구버전 MySQL은 `lock in share mode`) |
| `PESSIMISTIC_WRITE` | 배타 락 — 읽기·쓰기 모두 차단 | `for update` |
| `PESSIMISTIC_FORCE_INCREMENT` | 배타 락 + version 강제 증가 | `for update` + version UPDATE |

실무에서 쓰는 건 사실상 `PESSIMISTIC_WRITE`다. `PESSIMISTIC_READ`는 **DB와 방언에 따라
지원 범위가 다르고, 공유 락을 지원하지 않는 DB에서는 배타 락으로 강등되어 결과적으로
`PESSIMISTIC_WRITE`와 같아질 수 있다.** 또 공유 락은 "둘 다 읽고 둘 다 쓰려고 하는"
전형적인 데드락 패턴을 만들기 쉽다. **모르면 `PESSIMISTIC_WRITE`를 쓰는 게 안전하다.**

`PESSIMISTIC_FORCE_INCREMENT`는 잠금과 동시에 버전을 올려서, **비관적 락으로 보호한
변경을 낙관적 락 진영(준영속 화면 편집 등)에도 알려야 할 때** 쓴다.

### 3-2. 숨은 대가 — 붙잡히는 건 스레드가 아니라 커넥션이다

"비관적 락으로 바꾸면 재시도 폭풍은 사라진다"는 맞다. 499건은 재실행하지 않고
**그냥 기다린다.** 문제는 **기다리는 동안 무엇을 붙잡고 있느냐**다.

```
낙관적 락 + 재시도로 대기하는 요청
   └ 붙잡은 것: 애플리케이션 스레드
      (트랜잭션은 이미 롤백돼서 커넥션은 풀로 돌아가 있다)

비관적 락으로 대기하는 요청
   └ 붙잡은 것: 애플리케이션 스레드 + DB 커넥션 + 열린 트랜잭션
      (SELECT ... FOR UPDATE 를 보낸 상태로 응답을 기다린다 = 커넥션이 반납될 수 없다)
```

이 차이가 결정적이다. **커넥션 풀이 20개인데 락을 기다리는 요청이 21개면, 21번째부터는
락과 무관한 다른 모든 API까지 커넥션을 못 얻는다.** 재고 API 하나의 경합이
**서비스 전체를 마비**시킨다. 장애 격리가 깨지는 구조다.

그리고 여기서 자주 나오는 오해 하나를 정리해야 한다.

> **"가상 스레드를 쓰면 되지 않나요?" → 해결되지 않는다.**
>
> 가상 스레드가 싸게 만들어준 것은 **스레드**다. 그런데 병목은 **커넥션 풀 크기**이고,
> 그건 그대로 20개다. 오히려 스레드가 싸져서 동시 요청을 더 많이 받아들이면
> **커넥션을 기다리는 줄만 더 길어진다.** 게다가 락 대기는 DB 서버 안에서 일어나는
> 블로킹이라 JVM이 스레드를 언마운트해 다른 일을 시킬 수도 없다.
> **자원의 종류를 정확히 짚는 것**이 이 꼬리질문의 채점 포인트다.

(같은 논리가 [OSIV 트레이드오프](osiv-tradeoff-and-migration.md)에도 그대로 나온다 —
"아무 일도 하지 않는 커넥션을 잡는다". 락 대기는 그 최악의 형태다.)

### 3-3. 락 타임아웃 — 무한정 기다리게 두지 않는다

기본값으로 두면 요청은 **DB가 정한 시간만큼 하염없이 기다린다.** 락 대기 시간에
상한을 걸어야 커넥션 점유 시간의 최댓값이 정해진다.

```java
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    @Query("select p from Product p where p.id = :id")
    Optional<Product> findByIdForUpdate(@Param("id") Long id);
}
```

- `value = "0"` → **즉시 실패**. SQL로는 `for update nowait`. "기다리느니 바로 실패
  응답을 주겠다"는 정책. 대기 줄을 아예 만들지 않으므로 커넥션 보호에는 가장 강력하다.
- `value = "3000"` → 3초 대기 후 실패.
- 타임아웃이 나면 `jakarta.persistence.LockTimeoutException`(Spring 계층에서는
  `CannotAcquireLockException` 계열)이 뜬다.

**주의**: 이 힌트의 실제 지원 범위는 **DB와 방언에 따라 다르다.** `NOWAIT`(0)은
비교적 널리 지원되지만, 임의의 대기 시간(예: 3초)을 SQL 구문으로 표현하지 못하는 DB도
있다. MySQL(InnoDB)의 경우 락 대기 상한은 서버 설정(`innodb_lock_wait_timeout`)이
기본 방어선이다. **"쓰는 DB에서 실제로 어떤 SQL로 번역되는지 로그로 확인하고
쓴다"는 태도**를 보여주는 게 중요하다.

### 3-4. 데드락과 락 획득 순서

두 트랜잭션이 **서로 다른 순서로** 두 행을 잠그면 교착 상태가 된다.

```java
// ❌ BEFORE — 요청마다 잠그는 순서가 다르다
// 트랜잭션 A: 계좌 1 잠금 → 계좌 2 잠금 시도
// 트랜잭션 B: 계좌 2 잠금 → 계좌 1 잠금 시도   → 서로 상대를 기다림 = 데드락
public void transfer(Long fromId, Long toId, long amount) {
    Account from = repo.findByIdForUpdate(fromId).orElseThrow();
    Account to   = repo.findByIdForUpdate(toId).orElseThrow();
    ...
}

// ✅ AFTER — 항상 같은 기준(id 오름차순)으로 잠근다
public void transfer(Long fromId, Long toId, long amount) {
    List<Long> ordered = Stream.of(fromId, toId).sorted().toList();
    Map<Long, Account> locked = ordered.stream()
            .map(id -> repo.findByIdForUpdate(id).orElseThrow())
            .collect(toMap(Account::getId, identity()));
    // 모든 트랜잭션이 작은 id 부터 잠그므로 순환 대기가 성립할 수 없다
    ...
}
```

규칙은 한 줄이다. **여러 행을 잠가야 한다면, 시스템 전체가 합의한 하나의 순서로
잠근다.** 순환이 없으면 데드락도 없다.

DB는 데드락을 감지하면 한쪽을 희생시켜 예외를 던진다. 이 경우는 **재시도가 정당하다**
— 상대가 이미 물러났으므로 다시 하면 성공할 가능성이 높다. 낙관적 락 재시도와 같은
원칙(새 트랜잭션 + 백오프 + 상한)이 적용된다.

---

## 4. 놓치기 쉬운 축 — "기다리느냐"가 아니라 "얼마나 오래 기다리느냐"

### 4-1. 먼저 인정할 것: 직렬화는 사라지지 않는다

"어떤 방법을 써도 같은 로우를 1씩 깎는 이상, 어딘가에서는 순서대로 처리될 수밖에
없다" — 이 직관은 **완전히 옳다.** 낙관적 락이든 비관적 락이든 Redis 분산 락이든,
직렬화 지점을 없앨 수는 없고 위치만 옮길 뿐이다.

그래서 축을 바꿔야 한다. **직렬화를 없애는 게 아니라, 직렬화되는 구간을 짧게 만드는 것**이
목표다. 처리량은 이렇게 결정된다.

```
초당 처리 가능 건수 ≈ 1 / (임계 구간 길이)

임계 구간 5ms   → 초당 200건
임계 구간 0.5ms → 초당 2,000건
```

같은 "줄 서기"인데 앞사람이 창구에서 5분 있느냐 5초 있느냐의 차이다.

### 4-2. 지금 구조의 임계 구간은 무엇으로 채워져 있나

`SELECT ... FOR UPDATE` 방식의 락 보유 구간을 뜯어보자.

```
BEGIN
 │
 ├─ SELECT ... FOR UPDATE  ──▶ DB   ← 여기서 락 획득       ┐
 │                        ◀──  값 전송                     │
 ├─ 자바에서 stock - 1 계산, 검증 로직                       │ 락을 쥐고 있는 구간
 ├─ UPDATE ...            ──▶ DB                          │ = 네트워크 왕복 2~3회
 │                        ◀──                             │   + JVM 처리 시간
 └─ COMMIT                ──▶ DB   ← 여기서 락 해제        ┘
```

락을 쥐고 있는 동안 **애플리케이션과 DB 사이를 두세 번 오간다.** 왕복 하나가 같은
데이터센터에서도 수십 마이크로초~1밀리초 수준이고, 그 사이에 GC 일시 정지나 스레드
스케줄링 지연이 끼면 더 길어진다. 결과적으로 **밀리초 단위**가 된다.

### 4-3. 락을 애플리케이션에서 DB 문장 안으로 밀어 넣으면

```sql
-- 조건 판단과 갱신을 한 문장으로 합친다
UPDATE product SET stock = stock - 1 WHERE id = ? AND stock >= 1
```

```
BEGIN
 ├─ UPDATE ...  ──▶ DB   ← 락 획득 + 조건 판단 + 갱신을 DB 내부에서 한 번에  ┐ 락 보유 구간
 │             ◀──  영향 행 수                                              │ = 왕복 1회
 └─ COMMIT     ──▶ DB   ← 락 해제                                          ┘
```

**락 보유 구간에서 "값 전송 + 자바 계산 + UPDATE 전송"이 통째로 빠진다.** 조건 검사가
DB 엔진 안에서 일어나므로 애플리케이션을 왕복할 이유가 없다. 임계 구간의 길이가
**자릿수 단위로** 줄어든다(정확한 배수는 네트워크 지연·DB 사양에 따라 다르다).

정직하게 덧붙일 것이 하나 있다. **행 락은 문장이 끝날 때가 아니라 커밋할 때 풀린다.**
그러니 "한 문장이면 락이 마이크로초만 걸린다"는 말은 정확하지 않다. 줄어드는 것은
**락 보유 구간 안에 들어 있던 왕복 횟수와 애플리케이션 처리 시간**이다. 이 트랜잭션이
그 UPDATE 하나만 하고 즉시 커밋하는 형태여야 효과가 온전히 난다.

그리고 부수 효과가 하나 더 있다. **`영향 행 수 = 0`이 곧 "재고 없음"이다.**

```java
int affected = productRepository.decreaseStock(id);   // @Modifying UPDATE
if (affected == 0) {
    throw new OutOfStockException();   // 재시도 아님 — 즉시 품절 응답
}
```

낙관적 락의 0은 "누가 먼저 갔으니 다시 해봐라"였지만, 여기서의 0은 **"재고가 없다"는
최종 결론**이다. 그래서 **재시도 자체가 필요 없다.** 재시도 폭풍이 발생할 여지가
구조적으로 사라진다.

> 다만 이 방식도 공짜는 아니다 — 영속성 컨텍스트를 우회하고, 도메인 로직이 SQL로
> 새어 나가며, "몇 개 남았는지"를 알려면 다시 읽어야 한다.
> **낙관적 락 / 비관적 락 / 원자적 UPDATE / 분산 락 4종의 본격적인 비교는
> 고난이도⭐⭐⭐ 전용 문항**("재고 차감/포인트 차감 같은 동시성 갱신 문제를 …
> 각각으로 풀 때의 트레이드오프")**에서 다룬다.** 이 문항에서는 **"임계 구간의 길이라는
> 축이 존재한다"는 것을 아는 선까지**가 만점이다. 면접에서도 딱 여기까지 말하고
> "자세한 비교는 케이스에 따라"로 넘기는 게 깔끔하다. **(가산점 포인트)**

---

## 5. 선택 기준을 실행 가능한 규칙으로

### 5-1. "충돌이 드물면 낙관적"의 다음 단계

"드물다"를 감으로 말하면 근거가 안 된다. 실제로는 **세 가지를 본다.**

**① 같은 행에 동시 수정이 겹칠 확률을 추정한다.**
필요한 숫자는 세 개다 — 대상 행의 개수, 초당 쓰기 요청 수, 트랜잭션 하나가 그 행을
붙잡는 시간. 회원 10만 명의 프로필 수정은 요청이 10만 개 행에 흩어지므로 충돌 확률이
사실상 0이다. 반대로 **한정판 상품 1개 행에 초당 500건**이면 충돌은 예외가 아니라
기본값이다. **"행 하나당 초당 몇 건이 오는가"** 로 환산해 보는 습관이 핵심이다.

**② 재시도 비용을 계산한다. 재시도 비용 = 비즈니스 로직 전체의 재실행 비용이다.**
UPDATE 한 번을 다시 하는 게 아니다. 로직 안에 무거운 조회, 계산, **특히 외부 API
호출**이 있으면 재시도 비용이 폭증한다. 심지어 외부 호출은 **재시도할 때마다 부수
효과가 반복**될 수 있어(중복 결제 등) 낙관적 락 자체가 부적절해진다.
→ 재시도 비용이 크면 낙관적 락은 나쁜 선택이다.

**③ 사용자에게 실패를 보여줘도 되는가.**
낙관적 락은 결국 "실패할 수 있다"를 사용자 경험으로 노출하는 선택이다.
"다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도해 주세요"가 **합리적인 안내로
받아들여지는 화면**이면 낙관적 락이 잘 맞는다. 반대로 결제 버튼을 눌렀는데
"충돌했으니 다시"는 곤란하다.

세 답을 합치면 규칙이 나온다.

> **충돌 확률이 낮다 → 낙관적.**
> **충돌 확률이 높다 → 낙관적 락은 재시도 폭풍, 비관적 락은 커넥션 점유.
> 둘 다 답이 아닐 수 있으니 §4의 축(임계 구간 줄이기)을 먼저 검토한다.**
> **재시도 비용이 크거나 실패를 노출할 수 없다 → 비관적(단 락 타임아웃 필수).**

### 5-2. 낙관적 락이 정답인 전형

- **관리자 화면 동시 편집.** 두 관리자가 같은 공지사항을 열어 편집한다. 충돌은 하루에
  몇 번 있을까 말까고, 발생하면 "다른 관리자가 먼저 저장했습니다"를 보여주는 게
  **오히려 올바른 동작**이다. 나중에 저장한 사람이 앞사람 수정을 조용히 지워버리는
  것(lost update)이 진짜 사고다. 화면을 열 때 받은 version을 폼에 담아 보내면
  **화면을 연 시점 기준**의 충돌 검사가 된다.
- **주문·결제 상태 전이.** `결제대기 → 결제완료 → 배송중`처럼 상태가 한 방향으로만
  가는 경우. 정상 흐름에서는 한 주문을 두 곳에서 동시에 바꿀 일이 거의 없지만,
  **재시도된 웹훅이나 중복 클릭**으로 드물게 겹친다. 이때 낙관적 락이 두 번째 전이를
  깔끔하게 막아준다.
- **일반적인 엔티티 수정 전반.** 평상시 오버헤드가 0이라, **의심스러우면 일단
  `@Version`을 붙이는 것**이 합리적인 기본값이다.

### 5-3. 비관적 락이 정답인 전형

- **충돌이 상시적인 소수의 행.** 특정 계좌의 잔액, 인기 상품 1개의 재고처럼 경합이
  구조적으로 보장된 자원.
- **재시도가 비싸거나 위험한 로직.** 트랜잭션 안에서 여러 테이블을 갱신하거나
  되돌리기 어려운 작업이 섞여 있는 경우.
- **정합성이 사용자 경험보다 절대적으로 우선.** 정산, 잔액 차감 등.

**단, 비관적 락을 고른다면 반드시 세트로 말해야 하는 것들이 있다** — 락 타임아웃,
락 획득 순서 규칙, 트랜잭션 구간을 최대한 짧게(락 잡은 상태에서 외부 API 호출 금지),
그리고 커넥션 풀 여유. 이걸 같이 말하지 않으면 "비관적 락으로 하겠습니다"는
**커넥션 고갈을 예약한 답변**이다.

### 5-4. 한 장으로 정리

| | 낙관적 락 (`@Version`) | 비관적 락 (`PESSIMISTIC_WRITE`) |
|---|---|---|
| 실제 동작 | 잠그지 않음. UPDATE의 `WHERE version=?` 조건 | `SELECT ... FOR UPDATE`로 DB가 행을 잠금 |
| 충돌 판정 | 영향 행 수 0 → 예외 (**사후 감지**) | 애초에 동시 진입 불가 (**사전 차단**) |
| 평시 비용 | 0 (조건 하나 추가) | 락 획득·해제 + 대기 |
| 충돌 시 비용 | 로직 전체 재실행 | 대기 (재실행 없음) |
| 붙잡는 자원 | 애플리케이션 스레드 | 스레드 + **DB 커넥션 + 열린 트랜잭션** |
| 고경합 시 실패 모습 | 재시도 폭풍 | **커넥션 풀 고갈 → 전체 장애** |

---

## 6. 이걸 어떻게 "보장"하나 — 동시성 문제를 테스트로 재현하기

동시성 버그는 **평소에 안 나고, 트래픽이 몰릴 때만 난다.** 그래서 "이 코드는
동시성에 안전합니다"를 말로 하면 아무 보장이 안 된다. **재현하는 테스트를 코드로
고정**하는 것이 유일한 방법이다.

### 6-1. 재현 테스트의 뼈대 — `CountDownLatch` + `ExecutorService`

핵심은 **N개 스레드를 만들어놓고 동시에 출발시키는 것**이다. 그냥 루프로 제출하면
먼저 만든 스레드가 이미 끝나 있어 경합이 안 생긴다.

```java
@SpringBootTest
class StockConcurrencyTest {

    @Autowired StockFacade stockFacade;         // 재시도 포함 진입점
    @Autowired ProductRepository productRepository;
    @Autowired TransactionTemplate txTemplate;

    Long productId;

    @BeforeEach
    void setUp() {
        // ⚠️ 테스트 트랜잭션이 아니라 "커밋되는" 트랜잭션으로 픽스처를 만든다
        productId = txTemplate.execute(status ->
                productRepository.save(new Product("한정판", 100)).getId());
    }

    @Test
    void 동시에_100건이_차감해도_재고는_정확히_0이_된다() throws Exception {
        int threadCount = 100;
        ExecutorService pool = Executors.newFixedThreadPool(32);

        CountDownLatch ready = new CountDownLatch(threadCount);   // 전원 준비 완료 대기
        CountDownLatch start = new CountDownLatch(1);             // 출발 신호
        CountDownLatch done  = new CountDownLatch(threadCount);   // 전원 종료 대기

        AtomicInteger success  = new AtomicInteger();
        AtomicInteger conflict = new AtomicInteger();

        for (int i = 0; i < threadCount; i++) {
            pool.submit(() -> {
                ready.countDown();
                try {
                    start.await();                      // ← 여기서 전원이 대기하다가 동시에 출발
                    stockFacade.decrease(productId);
                    success.incrementAndGet();
                } catch (ObjectOptimisticLockingFailureException
                         | StockConflictException e) {
                    conflict.incrementAndGet();         // 충돌은 "실패"가 아니라 관측 대상이다
                } catch (Exception e) {
                    throw new RuntimeException(e);
                } finally {
                    done.countDown();
                }
            });
        }

        ready.await();                                   // 100개가 전부 출발선에 설 때까지
        start.countDown();                               // 동시 출발!
        assertThat(done.await(30, TimeUnit.SECONDS)).isTrue();
        pool.shutdown();

        // ⚠️ 테스트의 영속성 컨텍스트가 아니라 DB 의 최종 상태를 읽어야 한다
        int finalStock = txTemplate.execute(status ->
                productRepository.findById(productId).orElseThrow().getStock());

        assertThat(finalStock).isEqualTo(100 - success.get());   // 초과 차감이 없다
        assertThat(success.get() + conflict.get()).isEqualTo(threadCount);
        assertThat(finalStock).isZero();                          // 재시도가 제대로 돌았다면 0
    }
}
```

단정할 것은 세 가지다. **① 최종 재고가 산술적으로 맞는가**(초과 차감·lost update가
없는가) **② 성공 + 충돌 = 전체 요청 수인가**(조용히 사라진 요청이 없는가)
**③ 재시도를 붙였다면 최종적으로 전부 성공했는가.**

`@Version`을 일부러 떼고 이 테스트를 돌려보면 **최종 재고가 100보다 훨씬 크게 남는다** —
그게 lost update의 모습이고, 테스트가 진짜로 동작한다는 증거다. **테스트를 먼저
실패시켜 보는 것**까지가 세트다.

### 6-2. 함정 — `@Transactional`을 붙이면 재현되지 않는다

```java
// ❌ 이 테스트는 동시성을 재현하지 못한다
@SpringBootTest
@Transactional                    // ← 이 한 줄이 테스트를 무력화한다
class StockConcurrencyTest { ... }
```

이유가 세 겹이다.

- **픽스처가 커밋되지 않는다.** 테스트 메서드의 트랜잭션은 끝에서 롤백된다. 그래서
  `@BeforeEach`에서 저장한 상품은 **다른 스레드(=다른 커넥션)에서 보이지 않는다.**
  워커 스레드들이 전부 "상품 없음"으로 실패하거나 락 대기에 걸린다.
- **`@Transactional`은 스레드에 묶여 있다.** 테스트 스레드의 트랜잭션·영속성 컨텍스트는
  워커 스레드로 전파되지 않는다. 테스트가 의도한 경계와 실제 실행 경계가 다르다.
- **검증도 오염된다.** 마지막에 `productRepository.findById()`로 확인하면 **테스트
  스레드의 1차 캐시에 남은 옛날 엔티티**를 돌려받는다. DB는 0인데 테스트는 100을 본다.

**규칙**: 동시성 테스트에는 `@Transactional`을 붙이지 않는다. 대신
`TransactionTemplate`으로 **커밋되는** 픽스처를 만들고, `@AfterEach`에서 직접 지운다.
(테스트 격리를 위해 `@Sql`이나 truncate 유틸을 함께 쓰면 좋다.)

### 6-3. 두 가지 더

- **DB를 실제와 같은 것으로.** H2 인메모리는 락과 격리 수준 동작이 MySQL/PostgreSQL과
  다르다. 동시성 테스트만큼은 **Testcontainers로 운영과 같은 DB 엔진**을 띄우는 게
  맞다. H2에서 통과한 동시성 테스트는 보장의 근거가 되지 못한다.
- **커넥션 풀 크기를 의식한다.** 스레드 100개가 전부 `SELECT ... FOR UPDATE`를 하면
  풀 크기만큼만 진입하고 나머지는 커넥션을 기다린다. 테스트가 이유 없이 느리거나
  타임아웃이 나면 그건 버그가 아니라 **§3-2에서 설명한 커넥션 고갈을 테스트가 그대로
  재현한 것**이다. 오히려 좋은 신호이니, 그 시간을 측정해 임계값으로 고정해두면
  성능 회귀 테스트가 된다. **(가산점 포인트)**

---

## 7. 꼬리질문 대비 포인트

### "확인하는 순간과 업데이트하는 순간 사이에 다른 트랜잭션이 끼어들면 어떻게 되나요?"

**그 '사이'가 존재하지 않는다는 것이 답이다.** 확인이 별도 SELECT가 아니라
`UPDATE ... WHERE id = ? AND version = ?`의 조건절 안에 있기 때문이다. **DB는 한 문장을
원자적으로 처리하고, 그 행에 대해 UPDATE는 내부적으로 직렬화된다.** 두 트랜잭션이
동시에 같은 조건으로 UPDATE를 날리면 한쪽만 영향 행 수 1을 받고, 나머지는 0을 받는다.

일반화하면 이렇다. **check-then-act가 위험한 이유는 두 문장이기 때문이고, 해결책은
락을 거는 것만이 아니라 두 문장을 한 문장으로 합치는 것이다.** 같은 원리가 유니크 제약
(중복 체크 후 INSERT 대신 제약 위반을 잡기), 원자적 UPDATE(§4-3), Redis `SETNX`에
모두 적용된다.

### "낙관적 락 재시도를 걸었는데 예외가 계속 나거나 아예 안 잡힙니다. 왜죠?"

세 가지를 순서대로 의심한다.

1. **재시도가 트랜잭션 안에 있다.** 낙관적 락 예외는 **커밋 시점**에 터지므로,
   트랜잭션 안쪽의 `try-catch`나 `@Retryable`은 잡을 기회조차 없다. 잡히더라도 §2-1의
   1차 캐시 문제로 무한 실패한다. → **재시도 빈과 트랜잭션 빈을 분리한다.**
2. **잡는 예외 타입이 틀렸다.** Spring Data JPA에서는 `OptimisticLockException`이 아니라
   `ObjectOptimisticLockingFailureException`으로 변환되어 올라온다.
3. **자기 호출(self-invocation)이다.** 같은 클래스 안에서 `this.method()`로 부르면
   프록시를 안 거쳐 `@Retryable`이 아예 적용되지 않는다.

### "비관적 락을 쓰면 대기하는 요청들이 스레드를 붙잡습니다. 가상 스레드로 해결되나요?" (시니어 변별 포인트)

**해결되지 않는다.** 가상 스레드가 싸게 만든 자원은 스레드지만, 이 상황의 병목은
**DB 커넥션 풀**이다. `SELECT ... FOR UPDATE`로 대기 중인 요청은 **커넥션과 열린
트랜잭션을 함께 붙잡고 있고**, 풀 크기는 가상 스레드와 무관하게 그대로다.
오히려 스레드가 싸져서 동시 유입이 늘면 **커넥션 대기 줄만 길어진다.**

그리고 더 나쁜 건 **영향 범위**다. 커넥션은 서비스 전체가 공유하는 자원이라, 재고 API
하나의 경합이 로그인·조회 등 **락과 아무 관계 없는 API까지 마비**시킨다.
그래서 비관적 락을 쓸 때는 반드시 **락 타임아웃으로 커넥션 점유 시간의 상한을 못
박고**, 가능하면 **별도 커넥션 풀(또는 별도 인스턴스)로 격리**해 벌크헤드를 만든다.
"가상 스레드로 해결하겠다"가 아니라 **"자원의 종류를 구분하고 격리하겠다"** 가 답이다.

### "그럼 Redis 분산 락을 쓰면 되지 않나요?" (시니어 변별 포인트)

**DB 커넥션을 대기에서 떼어낸다는 점에서는 개선이 맞다.** 대기 줄이 DB 밖으로 나가므로
커넥션 풀이 락 대기로 고갈되지는 않는다. 다중 인스턴스 환경에서 JVM 락으로는 불가능한
조정을 해주는 것도 사실이다.

**다만 이 문항의 시나리오를 근본적으로 풀지는 못한다.** 500건이 여전히 줄을 서고,
임계 구간은 오히려 **Redis 왕복까지 더해져 길어질 수 있다.** 게다가 락과 데이터가
서로 다른 시스템에 있으므로 **Redis 장애 시 정합성 보장이 통째로 사라지고**, TTL이
만료됐는데 작업이 아직 안 끝난 경우 같은 새로운 실패 모드가 생긴다.

그래서 순서가 이렇다. **① 임계 구간 자체를 줄일 수 있는가(§4)를 먼저 본다 →
② 단일 DB로 해결 가능하면 분산 락은 불필요하다 → ③ 여러 시스템에 걸친 자원을
조정해야 할 때만 분산 락을 꺼낸다.** 분산 락은 "성능 해법"이 아니라
**"경계를 넘는 조정이 필요할 때의 도구"** 다.

### "`@Version`을 붙였는데 충돌이 감지되지 않는 경우가 있나요?"

있다. 네 가지가 대표적이다.

- **엔티티가 변경되지 않은 경우.** UPDATE가 안 나가면 버전 검사도 없다. 읽기만 한
  엔티티를 보호하려면 `LockModeType.OPTIMISTIC`이나 `OPTIMISTIC_FORCE_INCREMENT`를
  명시해야 한다(§1-5).
- **벌크 연산(`@Modifying`)이나 네이티브 SQL로 우회한 경우.** version을 직접 올리지
  않으면 다른 트랜잭션은 그 변경을 감지하지 못한다
  ([벌크 연산과 영속성 컨텍스트](bulk-operation-persistence-context.md)).
- **다른 행을 바꾼 경우.** `@Version`은 그 엔티티 행 하나만 보호한다. 자식 컬렉션만
  바뀌었다면 부모의 버전은 그대로다 → `OPTIMISTIC_FORCE_INCREMENT`로 애그리거트 단위
  보호를 건다.
- **애초에 없던 행을 만드는 경우(INSERT).** 낙관적 락은 "이미 있는 행"의 갱신 충돌만
  다룬다. 동시 INSERT로 인한 중복은 **DB 유니크 제약**이 막아야 한다 — 별도 문항으로
  다뤄지는 주제다.

### "낙관적 동시성 제어를 HTTP API 계층에서는 어떻게 표현하나요?" (가산점 포인트)

**`@Version`과 정확히 같은 구조가 HTTP에도 있다.** 서버가 응답에 `ETag`(리소스의 현재
버전 식별자)를 실어 보내고, 클라이언트는 수정 요청에 `If-Match: <그 ETag>`를 담아
보낸다. 서버는 현재 버전과 다르면 **412 Precondition Failed**를 돌려준다.

`ETag`를 엔티티의 `@Version` 값으로 만들면 **DB의 낙관적 락이 API 계약으로 그대로
번역된다.** "두 관리자가 같은 화면을 편집"하는 시나리오를 브라우저 새로고침 없이
안전하게 만드는 표준적인 방법이다. 이 연결을 말할 수 있으면 계층을 넘나드는 설계
감각을 보여주게 된다.

---

## 한 줄 요약

**낙관적 락은 락이 아니다** — 별도 SELECT 없이
`UPDATE ... SET ..., version = ? WHERE id = ? AND version = ?` **한 문장**을 날리고
**영향 행 수가 0인지로 충돌을 사후 감지**할 뿐이며, 그래서 평시 비용이 0인 대신
**충돌 시 로직 전체를 새 트랜잭션에서 재시도**해야 한다. 반면 **비관적 락은 진짜로
잠그는 대신 락 대기 시간 내내 DB 커넥션을 붙잡아** 가상 스레드로도 못 막는 풀 고갈을
부른다. 선택 기준은 **충돌 확률 × 재시도 비용 × 실패를 노출해도 되는가**이고,
**둘 다 답이 아닌 고경합 구간에서는 "기다림을 없앨 수 있나"가 아니라 "기다리는 구간을
짧게 만들 수 있나"를 물어야 한다.** 그리고 이 모든 판단은
**`CountDownLatch`로 동시 출발시킨 테스트로 재현해 고정하기 전까지는 주장일 뿐이다.**
