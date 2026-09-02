# 벌크 연산(`@Modifying`)과 영속성 컨텍스트 — DB는 바뀌었는데 메모리는 옛날 값

> 핵심 관전 포인트: **벌크 연산은 영속성 컨텍스트를 거치지 않는다. 1차 캐시를 우회해 DB로 직행한다.** 그래서 답의 출발점은 딱 하나다 — **벌크 UPDATE 직후 DB와 1차 캐시는 서로 다른 값을 갖는다.** 흔한 오해가 "벌크 연산도 영속성 컨텍스트가 모아서 한번에 처리한다"인데 **정반대**다. 벌크 연산은 쓰기 지연(write-behind) 대상이 아니라, 오히려 **JPQL 실행 직전에 아직 안 나간 변경분을 flush한 다음 즉시 DB로 나간다.** 이 불일치가 만드는 사고는 두 방향이다. ① **조회 사고** — 컨텍스트에 남은 엔티티는 옛 값을 계속 돌려준다("DB는 바뀌었는데 API 응답은 그대로"). ② **덮어쓰기 사고** — 그 옛 값 엔티티를 조금이라도 건드리면 커밋 시점 dirty checking이 **전 컬럼 UPDATE**를 날려 **벌크 결과를 조용히 되돌린다.** `@Modifying`의 옵션 두 개는 **방향이 정반대**다 — `flushAutomatically`는 실행 **전** flush(변경분을 벌크 조건에 **반영**), `clearAutomatically`는 실행 **후** clear(낡은 캐시를 **폐기**). 다만 **`clearAutomatically`는 안전장치가 아니다** — 컨텍스트를 **통째로** 비우므로 같은 트랜잭션에서 수정 중이던 **다른 엔티티의 변경분까지 소실**되고, 남은 참조는 전부 준영속이 되어 지연 로딩이 터진다. **진짜 처방은 옵션이 아니라 배치다: 영속성 컨텍스트를 우회하는 연산과, 영속성 컨텍스트에 의존하는 연산을 같은 트랜잭션에 섞지 않는다.**

---

## 0. 질문 + 의도

**질문**: "벌크 연산(`@Modifying`) 후 영속성 컨텍스트는 어떻게 처리해야 하나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "벌크 UPDATE가 1차 캐시를 우회해 **'DB는 바뀌었는데 조회 결과는 옛날 값'** 인 상황은 **증상이 괴상해서 원인을 모르면 며칠을 헤맨다. 겪었거나 원리를 아는 사람만 즉답한다.**" 즉 이 문항의 채점 지점은 `@Modifying`의 사용법 암기가 아니다. **증상을 보고 원인을 역추적할 수 있는가**다. 코드에는 아무 잘못이 없어 보이고, 예외도 안 나고, 로그도 조용하다. 벌크 UPDATE는 분명히 성공했고 DB를 직접 조회하면 값이 바뀌어 있다. 그런데 애플리케이션이 돌려주는 값만 다르다 — 이 조합에서 "아, 1차 캐시구나"에 도달하지 못하면 며칠이 날아간다.

읽기 전에 용어 세 개만 미리 풀어두자. 이 문서는 이 셋의 관계만으로 굴러간다.

- **영속성 컨텍스트(persistence context)**: JPA가 트랜잭션 동안 엔티티를 담아두고 관리하는 메모리 공간이다. "영속(persistent) 상태의 객체들이 놓인 문맥"이라는 뜻이라 이 이름이 붙었다.
- **1차 캐시(first-level cache)**: 그 영속성 컨텍스트 안에서 **식별자(PK) → 엔티티 객체**로 저장해 두는 맵이다. `findById(1L)`을 두 번 불러도 두 번째는 DB로 나가지 않고 이 맵에서 꺼내 준다. 트랜잭션이 끝나면 통째로 사라진다. "1차"인 이유는 애플리케이션 전역에 남는 **2차 캐시**가 따로 있기 때문이다.
- **쓰기 지연(write-behind)**: 엔티티를 수정해도 그 자리에서 UPDATE를 보내지 않고, flush 시점(보통 커밋 직전)까지 모아 두었다가 한꺼번에 내보내는 동작이다. "쓰기(write)를 뒤로(behind) 미룬다"는 뜻이다.

**이 문항이 특히 위험한 이유 세 가지**:

- **실패가 조용하다.** 예외가 없다. 벌크 UPDATE가 dirty checking에 덮어쓰이면 **로그상 두 UPDATE는 모두 성공**이고, 남는 흔적은 "결과가 사라졌다"는 사실뿐이다.
- **테스트에서 안 잡힌다.** `@Transactional`을 붙인 테스트는 테스트와 서비스가 **같은 영속성 컨텍스트를 공유**하므로 검증용 재조회조차 1차 캐시에서 나온다(§3-6).
- **재현 조건이 배치 순서다.** 벌크 연산을 트랜잭션 앞쪽에 두면 터지고, 맨 뒤에 두면 안 터진다. "어제까지 되던 코드가 리팩터링 후 깨졌다"의 전형이다.

**함정 두 개**:

- **"영속성 컨텍스트가 알아서 처리하겠지"** — 벌크 연산은 컨텍스트를 **거치지 않는다**. 이 전제가 뒤집혀 있으면 이후 추론이 전부 반대로 간다.
- **"`clearAutomatically = true` 붙이면 끝"** — 증상은 사라지지만 **더 조용한 사고**(다른 엔티티 변경분 소실)로 옮겨간다. 이 옵션을 만병통치약으로 말하면 감점 지점이다(§2-8).

---

## 1. 원리 — 벌크 연산은 영속성 컨텍스트를 우회해 즉시 실행된다

### 1-1. 벌크 연산이란

**벌크 연산(bulk operation)** 은 **여러 행을 SQL 한 문장으로 한꺼번에 바꾸는 것**을 말한다. "덩어리(bulk)로 처리한다"는 뜻이다.

```java
// BEFORE — 한 건씩. 1만 건이면 SELECT 1번 + UPDATE 1만 번
@Transactional
public void expireAllCoupons() {
    List<Coupon> coupons = couponRepository.findByStatus(ACTIVE);  // 1만 건 메모리 적재
    for (Coupon c : coupons) {
        c.setStatus(EXPIRED);        // 변경 감지 → 커밋 시 UPDATE 1만 번
    }
}
```

```java
// AFTER — 벌크. UPDATE 1문장
@Modifying
@Query("update Coupon c set c.status = 'EXPIRED' where c.status = 'ACTIVE'")
int expireAllCoupons();
```

전자는 엔티티를 전부 메모리에 올리고(OOM 위험), 스냅샷을 뜨고, 커밋 시 1만 번의 UPDATE를 날린다. 후자는 **DB가 자기 안에서 한 번에 처리**한다. 대량 처리에서 벌크 연산을 쓰는 이유가 이것이다.

그리고 **바로 그 이유(엔티티를 메모리에 올리지 않는다) 때문에 영속성 컨텍스트를 우회한다** — 이 문항의 모든 문제가 여기서 파생된다. 엔티티를 안 올렸으니 1차 캐시에 넣을 것도 없고, 1차 캐시에 넣지 않았으니 캐시에 이미 들어 있던 옛 객체를 갱신해 줄 방법도 없다.

### 1-2. `@Modifying`을 붙이지 않으면 — 조회 실행 경로로 들어가 예외가 난다

Spring Data JPA는 `@Query`에 적힌 JPQL 문자열을 **파싱해서 조회인지 변경인지 판단하지 않는다.** 리포지토리 메서드를 만들 때 **어떤 실행 방식을 쓸지 미리 정해두는데**, 기본값이 **조회**다. 그래서 `@Modifying`은 개발자가 직접 붙이는 **"이건 조회가 아니라 변경 쿼리다"라는 표시(marker)** 다.

```java
// BEFORE — @Modifying 누락. 컴파일도 되고 애플리케이션도 뜬다. 호출하는 순간 터진다.
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Query("update Product p set p.stock = 0 where p.category = :category")
    int zeroStock(@Param("category") String category);
}
```

호출하면 Spring Data JPA가 **조회 실행 경로**로 들어가 `getResultList()`를 호출하고, 하이버네이트가 "SELECT 문이 아닌데 결과 목록을 달라고 한다"며 거부한다. 예외 타입과 메시지는 **하이버네이트 버전에 따라 다르다**:

```text
# 하이버네이트 5 (Spring Boot 2 계열)
org.hibernate.hql.internal.QueryExecutionRequestException:
    Not supported for DML operations [update Product p set p.stock = 0 where p.category = :category]

# 하이버네이트 6 (Spring Boot 3 계열)
org.hibernate.query.IllegalSelectQueryException:
    Expecting a selection query, but found 'update Product p set p.stock = 0 where p.category = :category'
```

둘 다 Spring의 예외 변환을 거쳐 보통 `InvalidDataAccessApiUsageException`으로 감싸져 올라온다. **면접에서는 정확한 클래스명을 외우는 것보다 "조회 실행 경로(`getResultList()`)로 들어가서 실패한다"는 메커니즘을 말하는 편이 낫다.** 버전마다 이름이 바뀌는 값이라 단정하면 위험하다.

```java
// AFTER — @Modifying 을 붙이면 executeUpdate() 경로로 실행된다
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Modifying
    @Query("update Product p set p.stock = 0 where p.category = :category")
    int zeroStock(@Param("category") String category);   // 반환값 = 영향받은 행 수
}
```

`@Modifying`이 하는 일을 정리하면 이 세 가지다.

- 실행 메서드를 `getResultList()` → **`executeUpdate()`** 로 바꾼다.
- 반환 타입으로 **`int`(또는 `void`)** 를 허용한다. `int`는 **영향받은 행 수(affected rows)** 다.
- `flushAutomatically` / `clearAutomatically` 옵션으로 **영속성 컨텍스트를 언제 손볼지**를 지정할 수 있게 한다(§2-5).

### 1-3. 트랜잭션도 필수다

변경 쿼리는 **쓰기 트랜잭션 안에서만** 실행할 수 있다. `@Transactional` 없이 호출하면 실행 시점에 이런 예외가 난다.

```text
jakarta.persistence.TransactionRequiredException: Executing an update/delete query
```

`JpaRepository`의 기본 구현체(`SimpleJpaRepository`)는 클래스 레벨이 `@Transactional(readOnly = true)`라서, **직접 선언한 `@Modifying` 메서드는 그 기본값을 물려받는다.** 즉 리포지토리 메서드만 덜렁 호출하면 읽기 전용 트랜잭션 안에서 변경을 시도하는 꼴이 된다.

```java
// BEFORE — 서비스에 트랜잭션이 없다
@Service
public class ProductService {
    public void reset(String category) {
        productRepository.zeroStock(category);   // TransactionRequiredException
    }
}
```

```java
// AFTER — 호출하는 서비스 메서드에 쓰기 트랜잭션을 건다
@Service
public class ProductService {

    @Transactional                                // readOnly 가 아닌 쓰기 트랜잭션
    public void reset(String category) {
        int affected = productRepository.zeroStock(category);
        log.info("재고 초기화 {}건", affected);     // 영향 행 수를 반드시 확인할 것
    }
}
```

> **영향 행 수를 버리지 마라.** `int` 반환값은 **"내가 의도한 만큼 바뀌었는가"를 검증할 수 있는 유일한 신호**다. `0`이 돌아왔다는 건 조건에 걸린 행이 하나도 없었다는 뜻이고, 이건 대개 **버그**다(§3-5의 "WHERE에 안 걸림" 증상). 반환 타입을 `void`로 두면 이 신호를 통째로 버리는 것이다. **(가산점 포인트)**

### 1-4. 실행 타이밍 — 가장 흔한 오해부터 깨고 간다

많은 사람이 벌크 연산을 이렇게 상상한다.

```text
상상하는 동작 (전부 틀렸다)
   ① 벌크 UPDATE 호출
   ② 영속성 컨텍스트가 "1만 건을 바꿔야겠군" 하고 기억해둔다
   ③ 1차 캐시의 엔티티들도 새 값으로 갱신된다
   ④ 커밋 시점에 모아서 DB로 나간다
```

특히 ②③이 치명적이다 — 이 그림에서는 DB와 메모리가 늘 일치하므로 **이 문항의 문제 자체가 존재하지 않게 된다.** 오해의 뿌리는 "JPA를 통해 나가는 모든 변경은 영속성 컨텍스트를 거친다"는 일반화인데, **벌크 연산은 정확히 그 규칙의 예외**다.

실제 동작은 이렇다.

```text
실제 동작
   ① 벌크 UPDATE 호출
   ② (flush 선행) 아직 DB에 안 나간 변경분을 먼저 내보낸다
   ③ UPDATE 문이 즉시 DB로 나간다   ← 커밋을 기다리지 않는다
   ④ 1차 캐시는 아무것도 모른다     ← 갱신되지 않는다
```

②가 왜 필요한지부터 보자. 앞서 정의한 쓰기 지연 때문에 **자바 코드에서 바꾼 값이 아직 DB에 없을 수 있다.** 그 상태로 벌크 UPDATE를 날리면 DB는 낡은 값을 기준으로 `WHERE`를 평가한다. 그래서 하이버네이트는 **JPQL을 실행하기 전에 flush를 먼저 수행**해 "쿼리가 최신 상태를 보게" 만든다. 이것이 **flush-before-query(자동 flush)** 동작이다.

단, 이 자동 flush는 **무조건 일어나지 않는다.** 하이버네이트는 최적화를 한다 — **쿼리가 건드리는 테이블과, 아직 반영되지 않은 변경분의 테이블이 겹칠 때만** flush한다. 이 테이블 집합을 **query space**라 부른다("이 쿼리가 발 딛고 선 공간"이라는 뜻이다). `Product`를 수정해둔 채 `Product`를 벌크 UPDATE하면 겹치므로 flush된다. 반면 `Event`를 수정해둔 채 `Ticket`을 벌크 UPDATE하면 **겹치지 않아 flush되지 않는다.** 이 세부는 §2-6과 §2-8에서 결정적으로 중요해진다.

> **정확도 주의**: 자동 flush의 정확한 발동 조건은 **flush 모드**(`AUTO` / `COMMIT` / `MANUAL`)와 **하이버네이트 버전·부트스트랩 방식**에 따라 달라진다. 기본값인 `FlushModeType.AUTO`에서 위 규칙이 적용되고, `@Transactional(readOnly = true)`는 세션을 `MANUAL`로 두어 **자동 flush를 아예 끈다.** 그래서 "하이버네이트가 알아서 flush해주니 괜찮다"에 기대는 것은 **설정 하나로 무너지는 가정**이다.

③이 이 문항의 핵심이다. 벌크 UPDATE는 **쓰기 지연 큐에 쌓였다가 커밋 때 나가는 것이 아니라, 호출하는 그 줄에서 즉시 DB로 나간다.** 실행하는 순간 DB의 값은 이미 바뀌어 있다.

④가 그 대가다. 영속성 컨텍스트를 거치지 않았으므로 **1차 캐시에 들어 있던 엔티티는 자기 값이 낡았다는 사실을 모른다.**

### 1-5. 타임라인으로 보면

`stock = 100`인 `Product`를 로드해둔 상태에서 벌크로 `stock = 0`을 날리는 상황이다.

```text
시각    코드                                  DB의 stock   1차 캐시 p.stock   메모
─────────────────────────────────────────────────────────────────────────────────
 t0    tx 시작                                    100            (없음)
 t1    p = findById(1L)                           100             100        SELECT 실행, 1차 캐시 적재
 t2    zeroStock()  ← 벌크 UPDATE                   0             100        여기서 갈라진다
        └ (t2-a) flush 선행: 밀린 변경분 내보냄
        └ (t2-b) UPDATE ... set stock = 0  즉시 실행
 t3    p.getStock()                                 0             100        읽는 값은 100 (캐시 히트)
 t4    커밋                                          ?             100        p 를 건드렸다면 §2-1의 사고
```

**t2 이후 DB는 0, 메모리는 100.** 이 두 줄이 어긋난 채로 트랜잭션이 계속 굴러가는 것 — 그게 이 문항의 전부다.

`p.getStock()`이 `100`을 돌려주는 이유는 **1차 캐시가 "같은 트랜잭션 안에서 같은 식별자는 같은 객체"를 보장하기 때문**이다(동일성 보장). `findById(1L)`을 다시 호출해도 **SELECT조차 나가지 않고** 캐시에 있는 그 객체가 그대로 돌아온다. 즉 **"다시 조회하면 되겠지"가 통하지 않는다.** 이 성질의 자세한 설명은 [영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md)에 있다.

> **면접에서 이 두 문장으로 시작하면 된다.**
> **"벌크 연산은 영속성 컨텍스트를 우회해 즉시 DB로 나갑니다. 그래서 실행 직후 DB와 1차 캐시가 어긋나고, 그 어긋남을 어떻게 정리하느냐가 이 질문의 답입니다."**

---

## 2. 사고와 옵션 — 덮어쓰기, 그리고 방향이 정반대인 두 스위치

불일치 자체보다 무서운 건 **불일치 상태의 엔티티를 건드렸을 때**다. 먼저 사고를 끝까지 보고, 그다음에 `@Modifying`이 제공하는 두 옵션이 그 사고의 어느 지점에 끼어드는지 본다.

### 2-1. 덮어쓰기 사고 — `name`만 바꿨는데 `stock`이 되돌아간다

```java
@Entity
public class Product {
    @Id @GeneratedValue
    private Long id;

    private String name;      // "구상품"
    private int stock;        // 100
    private String category;

    // getter / setter 생략
}
```

```java
public interface ProductRepository extends JpaRepository<Product, Long> {

    @Modifying
    @Query("update Product p set p.stock = 0")
    int zeroStockAll();
}
```

```java
// BEFORE — 벌크 연산과 엔티티 수정을 같은 트랜잭션에 섞었다
@Service
@RequiredArgsConstructor
public class ProductService {

    private final ProductRepository productRepository;

    @Transactional
    public void closeOutSale(Long id) {
        Product p = productRepository.findById(id).orElseThrow();   // stock = 100 적재
        System.out.println(p.getStock());   // 100

        productRepository.zeroStockAll();   // 벌크: DB의 모든 stock 이 0 이 된다
        System.out.println(p.getStock());   // 여전히 100 — 1차 캐시에서 읽기 때문

        p.setName("[마감] " + p.getName()); // 이름만 바꿨다. stock 은 손도 안 댔다.
    }   // 커밋. 여기서 사고가 난다.
}
```

**최종 DB의 `stock`은 `0`이 아니라 `100`이다.** 벌크 UPDATE는 분명히 성공했는데 그 결과가 **조용히 되돌려졌다.**

같은 일을 **메모리 값과 DB 값을 나란히 놓고** 보면 어디서 어긋나는지가 한눈에 들어온다.

| 시각 | 실행한 코드 | 메모리(1차 캐시)의 `p` | 스냅샷(로드 시점 복사본) | DB의 행 | 관찰 |
|---|---|---|---|---|---|
| t1 | `findById(1L)` | `name=구상품, stock=100` | `name=구상품, stock=100` | `name=구상품, stock=100` | 셋이 모두 같다 |
| t2 | `zeroStockAll()` (벌크) | `name=구상품, stock=100` | `name=구상품, stock=100` | `name=구상품, stock=0` | **DB만 앞서간다** |
| t3 | `p.getStock()` | `name=구상품, stock=100` | `name=구상품, stock=100` | `name=구상품, stock=0` | 읽은 값은 100 (틀린 값) |
| t4 | `p.setName("[마감] 구상품")` | `name=[마감] 구상품, stock=100` | `name=구상품, stock=100` | `name=구상품, stock=0` | 스냅샷과 달라졌다 → UPDATE 예약 |
| t5 | 커밋 (dirty checking) | `name=[마감] 구상품, stock=100` | — | `name=[마감] 구상품, stock=100` | **DB의 0이 100으로 되돌아감** |

t5에서 실제로 나가는 SQL이 사고의 전부다. `name`만 바꿨는데도 `stock`이 문장 안에 들어 있다.

```sql
-- t5, 커밋 직전 dirty checking 이 만들어 낸 UPDATE (전 컬럼)
update product
set    category = ?,   -- 바인딩: 그대로
       name     = ?,   -- 바인딩: '[마감] 구상품'   ← 내가 바꾼 것
       stock    = ?    -- 바인딩: 100              ← 내가 바꾼 적 없는데 들어간다
where  id = 1;
```

### 2-2. SQL 로그를 순서대로

`spring.jpa.show-sql=true`에 바인딩 파라미터 로그를 켜면 트랜잭션 전체가 이렇게 찍힌다.

```sql
-- ① findById
select p1_0.id, p1_0.category, p1_0.name, p1_0.stock
from   product p1_0
where  p1_0.id = 1;
-- 결과: name='구상품', stock=100  → 1차 캐시 + 스냅샷 저장

-- ② 벌크 UPDATE (즉시 실행)
update product set stock = 0;
-- 영향 행 수: N  → DB 의 stock 은 이제 전부 0

-- ③ 커밋 시점, dirty checking 이 만들어 낸 UPDATE
update product
set    category = ?,
       name     = ?,   -- '[마감] 구상품'
       stock    = ?    -- 100  ← ② 의 결과를 덮는다
where  id = 1;
```

**세 문장 모두 성공했다.** 예외도, 경고도, 롤백도 없다. 그래서 원인을 모르면 며칠을 헤맨다.

### 2-3. 왜 `stock`까지 되돌아가나 — 스냅샷 + 전 컬럼 UPDATE

두 가지 사실이 겹쳐서 생긴다.

**첫째, 스냅샷은 "로드 시점의 값"으로 고정된다.** 영속성 컨텍스트는 엔티티를 1차 캐시에 넣을 때 **그 순간의 필드 값들을 따로 복사해 보관**한다. 이 복사본이 스냅샷(snapshot, 그 순간을 찍은 사진)이다. 커밋 시점에는 **현재 엔티티 ↔ 스냅샷**을 비교해 달라진 게 있으면 UPDATE를 만든다. 이 비교 절차가 **dirty checking(변경 감지)** 이다 — "더러워진(dirty), 즉 로드 이후 값이 달라진 필드가 있는지 검사한다"는 뜻이다.

여기서 결정적인 건 **스냅샷이 DB를 다시 읽어 만들어지지 않는다**는 점이다. `stock`의 스냅샷은 t1의 `100`에 고정돼 있고, 벌크 UPDATE가 DB를 `0`으로 만든 사실은 스냅샷에 **반영되지 않는다.**

**둘째, 하이버네이트의 UPDATE에는 기본적으로 모든 컬럼이 들어간다.** 변경된 컬럼만 골라 넣는 게 아니라 **전 컬럼 UPDATE**가 기본이다. 이유는 성능이다 — 엔티티마다 UPDATE 문 문자열을 **미리 한 번 만들어 재사용**하고, JDBC 드라이버·DB의 실행 계획 캐시도 같은 SQL을 재사용할 수 있다. 조합마다 다른 SQL을 만들면 이 재사용이 전부 깨진다.

이 둘을 합치면 결론은 자동으로 따라온다.

```text
"name 이 바뀌었다" → UPDATE 를 만든다
                   → UPDATE 에는 모든 컬럼이 들어간다
                   → stock 자리에는 "현재 엔티티의 stock" 이 들어간다
                   → 그건 1차 캐시의 값, 즉 100
                   → 벌크가 만든 0 이 100 으로 덮인다
```

즉 **덮어쓰기는 버그가 아니라 dirty checking의 정상 동작**이다. 하이버네이트 입장에서는 "이 엔티티의 상태가 진실"이고, 자기 모르게 DB가 바뀐 줄 모를 뿐이다.

> **면접 답변 문장**: **"`name`만 바꿔도 하이버네이트는 전 컬럼 UPDATE를 날립니다. `stock` 자리에는 로드 시점 값인 100이 들어가고, 그게 벌크가 만든 0을 덮습니다. 스냅샷은 DB를 다시 읽어 만들어지지 않기 때문입니다."**

전 컬럼 UPDATE와 스냅샷 비교의 상세, 그리고 "시키지도 않은 UPDATE"를 추적하는 진단 절차는 [영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md)에 정리돼 있다.

### 2-4. `@DynamicUpdate`를 붙이면 해결되나 — 아니다

엔티티에 `@DynamicUpdate`를 붙이면 하이버네이트가 **실제로 변경된 컬럼만** UPDATE에 넣는다. "UPDATE 문을 미리 만들지 않고 매번 동적으로(dynamic) 만든다"는 뜻이다.

```java
@Entity
@DynamicUpdate                    // 변경된 컬럼만 UPDATE 에 포함
public class Product { ... }
```

```sql
-- @DynamicUpdate 를 붙였을 때 ③ 이 이렇게 바뀐다
update product set name = ? where id = 1;
--                 stock 이 빠졌다 → 벌크가 만든 0 이 살아남는다
```

**이 특정 덮어쓰기는 확실히 피한다. 그러나 근본 해결이 아니다.** 이유가 넷이다.

- **불일치 자체는 그대로다.** `p.getStock()`은 여전히 `100`을 돌려준다. 그 값으로 계산하거나 응답에 담으면 **틀린 값이 그대로 나간다.** 덮어쓰기만 막았을 뿐 **읽기 오염**은 남는다.
- **`stock`을 직접 건드리면 다시 터진다.** 예컨대 `p.setStock(p.getStock() - 1)`처럼 **낡은 값을 근거로 계산**하면 `stock`이 변경 컬럼에 포함되므로 `99`가 DB에 쓰인다. 벌크 결과는 또 사라진다.
- **엔티티 전역 설정이다.** 특정 트랜잭션의 문제를 풀려고 **그 엔티티의 모든 UPDATE 방식**을 바꾸는 것이라, 대가가 문제 범위보다 넓다. UPDATE 문을 매번 새로 만들어야 하므로 SQL 재사용·구문 캐시 이점을 잃는다.
- **의도가 드러나지 않는다.** 6개월 뒤 코드를 읽는 사람은 `@DynamicUpdate`가 "벌크 연산 덮어쓰기를 막으려고" 붙었다는 걸 알 수 없다. 누군가 성능상의 이유로 떼는 순간 사고가 부활한다.

**정리**: `@DynamicUpdate`는 컬럼 수가 아주 많고 갱신 대상이 소수일 때 쓰는 **성능 옵션**이지, 벌크 연산 대책이 아니다. 이 문항에서 `@DynamicUpdate`를 언급하는 것 자체는 좋지만, **"이건 증상 하나만 가리고 불일치는 그대로 남습니다"** 까지 붙여야 답이 완성된다. **(가산점 포인트)**

### 2-5. 두 옵션 — 하나는 실행 전, 하나는 실행 후

`@Modifying`에는 영속성 컨텍스트를 손보는 옵션이 두 개 있고, **하나는 쿼리 실행 전, 하나는 실행 후**에 동작한다. 둘 다 기본값은 `false`다.

```java
@Modifying(flushAutomatically = true,   // 실행 "전"  : 밀린 변경분을 DB로 내보낸다
           clearAutomatically = true)   // 실행 "후"  : 낡아버린 1차 캐시를 통째로 비운다
@Query("update Product p set p.stock = 0 where p.category = :category")
int zeroStock(@Param("category") String category);
```

표로 대비하면 이렇게 되는데, 표만 보면 "둘 다 캐시를 손보는 옵션" 정도로 뭉뚱그려 기억하게 된다.

| 옵션 | 시점 | 하는 일 | 데이터가 움직이는 방향 | 막아주는 사고 |
|---|---|---|---|---|
| `flushAutomatically = true` | 쿼리 실행 **전** | `em.flush()` — 밀린 변경분을 DB에 반영 | 메모리 → DB (내보낸다) | 방금 바꾼 값이 벌크의 `WHERE`에 안 걸림 |
| `clearAutomatically = true` | 쿼리 실행 **후** | `em.clear()` — 1차 캐시를 통째로 폐기 | 메모리 → 버림 (아무 데도 안 간다) | 낡은 값 조회 / dirty checking 덮어쓰기 |

정확히 이해하려면 **한 타임라인 위에 두 옵션을 같이 얹어야** 한다. 벌크 UPDATE 한 줄을 기준점으로 두고, 그 앞뒤에 각각 무엇이 끼어드는지를 보면 "방향이 반대"라는 말의 의미가 드러난다.

```text
 트랜잭션 시작
     │
     │   ── 구간 A ── 엔티티를 조회하고 수정한다.
     │                 수정분은 아직 메모리에만 있다 (쓰기 지연).
     │                 1차 캐시: 최신,  DB: 낡음
     │
     ├──▶ [flushAutomatically = true] 가 여기서 em.flush() 를 부른다
     │        방향:  메모리 ──────▶ DB     ("반영한다")
     │        효과:  DB 가 메모리를 따라잡는다 → 벌크의 WHERE 가 최신 상태를 본다
     │        빠뜨리면: 벌크 조건에 방금 바꾼 값이 안 걸린다 (영향 행 수 0)
     │
     ├──▶ 벌크 UPDATE 실행 (executeUpdate) — 커밋을 기다리지 않고 즉시 DB로 나간다
     │        이 순간부터  1차 캐시: 낡음,  DB: 최신   ← 두 옵션의 기준점
     │
     ├──▶ [clearAutomatically = true] 가 여기서 em.clear() 를 부른다
     │        방향:  메모리 ──────▶ 폐기   ("버린다". DB로 보내는 게 아니다)
     │        효과:  낡은 캐시가 사라진다 → 이후 조회가 DB를 다시 읽는다
     │        빠뜨리면: 낡은 값 조회 + 커밋 시 덮어쓰기 (§2-1)
     │
     │   ── 구간 B ── 캐시가 비었으므로 조회는 SELECT 를 새로 날린다.
     │                 대신 구간 A 에서 들고 있던 참조는 전부 준영속이다.
     │
  커밋
```

**"전에 넣고, 후에 버린다"** — 이 한 문장으로 외우면 헷갈리지 않는다. 더 정확히는 **`flushAutomatically`는 메모리의 내용을 DB로 밀어 넣어 살리는 쪽이고, `clearAutomatically`는 메모리의 내용을 아무 데도 보내지 않고 지우는 쪽**이다. 이름은 비슷하게 생겼지만 하나는 보존, 하나는 폐기다. 이 비대칭이 §2-8에서 사고의 원인이 된다.

### 2-6. `flushAutomatically = true` — 실행 전 flush(반영)

**막으려는 사고**: 자바 코드에서 방금 바꾼 값이 아직 DB에 없어서, **벌크 UPDATE의 `WHERE` 조건에 걸리지 않는 것.**

```java
// BEFORE — flushAutomatically 없음
@Modifying
@Query("update Ticket t set t.status = 'EXPIRED' where t.event.id = :eventId")
int expireTickets(@Param("eventId") Long eventId);
```

```java
@Transactional
public void closeEvent(Long eventId) {
    Event event = eventRepository.findById(eventId).orElseThrow();
    event.setStatus(CLOSED);           // ① 아직 DB 에 안 나갔다 (쓰기 지연)

    ticketRepository.expireTickets(eventId);   // ② 벌크
}
```

이 예에서는 `WHERE`가 `event.id`만 보므로 ①과 무관하다. 문제는 **벌크 조건이 방금 바꾼 값을 참조할 때**다.

```java
// 진짜 위험한 형태 — 벌크의 조건이 "방금 바꾼 값"에 의존한다
@Modifying
@Query("update Ticket t set t.status = 'EXPIRED' "
     + "where t.event.id in (select e.id from Event e where e.status = 'CLOSED')")
int expireTicketsOfClosedEvents();
```

```java
@Transactional
public void closeEvent(Long eventId) {
    Event event = eventRepository.findById(eventId).orElseThrow();
    event.setStatus(CLOSED);                       // ① 메모리에서만 CLOSED

    int n = ticketRepository.expireTicketsOfClosedEvents();
    // ② DB 안의 event.status 는 아직 OPEN 일 수 있다
    //    → 서브쿼리에 이 이벤트가 안 걸린다 → n = 0
    //    → 티켓은 하나도 만료되지 않는다. 예외 없이.
}
```

```java
// AFTER — 실행 전 flush 를 명시한다
@Modifying(flushAutomatically = true)
@Query("update Ticket t set t.status = 'EXPIRED' "
     + "where t.event.id in (select e.id from Event e where e.status = 'CLOSED')")
int expireTicketsOfClosedEvents();
```

> **"하이버네이트가 어차피 자동 flush 해주지 않나요?"** — **대개는 해준다. 그러나 조건부다.**
> §1-4에서 봤듯 자동 flush는 **쿼리가 건드리는 테이블과 밀린 변경분의 테이블이 겹칠 때만** 일어난다. 위 예는 서브쿼리에 `Event`가 등장하므로 겹칠 가능성이 높지만, **벌크가 건드리는 테이블에 등장하지 않는 엔티티의 변경분**은 flush되지 않는다. 게다가 `@Transactional(readOnly = true)`가 걸린 경로에서는 flush 모드가 `MANUAL`이라 **자동 flush가 아예 꺼진다.**
> 결론: **자동 flush는 하이버네이트의 최적화 휴리스틱이지 계약이 아니다.** `flushAutomatically = true`는 그 의존을 없애고 **"이 벌크는 최신 상태 위에서 돈다"를 코드에 명시**한다. 리뷰어에게 의도가 보인다는 것 자체가 값이다.

### 2-7. `clearAutomatically = true` — 실행 후 clear(폐기)

**막으려는 사고**: §1-5의 조회 오염과 §2-1의 덮어쓰기. 벌크 실행 직후 1차 캐시를 통째로 비워, **그 뒤의 조회가 DB를 다시 읽게** 만든다.

```java
// BEFORE
@Modifying
@Query("update Product p set p.stock = 0")
int zeroStockAll();
```

```java
@Transactional
public void closeOutSale(Long id) {
    Product p = productRepository.findById(id).orElseThrow();
    productRepository.zeroStockAll();

    Product again = productRepository.findById(id).orElseThrow();
    // SELECT 조차 나가지 않는다. 1차 캐시의 p 가 그대로 돌아온다.
    System.out.println(again == p);          // true
    System.out.println(again.getStock());    // 100  — DB 는 0 인데
}
```

```java
// AFTER
@Modifying(clearAutomatically = true)
@Query("update Product p set p.stock = 0")
int zeroStockAll();
```

```java
@Transactional
public void closeOutSale(Long id) {
    Product p = productRepository.findById(id).orElseThrow();
    productRepository.zeroStockAll();        // 실행 후 컨텍스트가 비워진다

    Product again = productRepository.findById(id).orElseThrow();
    // 캐시가 비었으므로 SELECT 가 실제로 나간다
    System.out.println(again == p);          // false — 다른 인스턴스
    System.out.println(again.getStock());    // 0     — DB 의 진실
}
```

후보자가 `@Modifying`이라는 이름을 모르는 상태에서 **"`EntityManager`를 clear하고 다시 조회하면 될 것 같다"** 고 도출한 처방이 정확히 이것이다. 옵션 없이 손으로 쓰면 이렇게 된다.

```java
@Transactional
public void closeOutSale(Long id) {
    Product p = productRepository.findById(id).orElseThrow();

    productRepository.zeroStockAll();
    entityManager.clear();                   // clearAutomatically = true 와 같은 일

    Product again = productRepository.findById(id).orElseThrow();  // 0
}
```

그럼 둘 다 켜면 끝인가.

```java
@Modifying(flushAutomatically = true, clearAutomatically = true)
```

**증상은 대부분 사라진다. 하지만 이걸 "안전장치"라고 부르면 안 된다.** 다음 두 소절이 이유다.

### 2-8. `clearAutomatically`가 안전장치가 아닌 이유 ① — 통째로 비운다

`clear()`는 **"방금 벌크로 건드린 엔티티만" 비우는 기능이 아니다. 영속성 컨텍스트 전체를 비운다.** 그 안에는 **같은 트랜잭션에서 수정 중이던, 벌크와 아무 상관 없는 엔티티들**도 들어 있다. 그것들의 변경분이 **아직 flush되지 않았다면 그대로 증발한다.** 커밋해도 UPDATE가 나가지 않는다.

§2-5의 타임라인에서 `clear()`의 화살표가 DB가 아니라 "폐기"를 향하고 있었던 이유가 이것이다. flush는 메모리의 내용을 DB에 옮겨 살리지만, clear는 어디로도 옮기지 않고 지운다.

```java
// BEFORE — clearAutomatically 를 "안전장치"로 믿고 트랜잭션 한가운데서 벌크
@Modifying(clearAutomatically = true)     // flushAutomatically 는 없다
@Query("update Ticket t set t.status = 'EXPIRED' where t.event.id = :eventId")
int expireTickets(@Param("eventId") Long eventId);
```

```java
@Transactional
public void closeEvent(Long eventId) {
    Event event = eventRepository.findById(eventId).orElseThrow();
    event.setStatus(CLOSED);                  // ① 이벤트를 CLOSED 로. 아직 flush 안 됨.

    int n = ticketRepository.expireTickets(eventId);
    //   └ 벌크는 ticket 테이블만 건드린다 → event 의 변경분과 테이블이 겹치지 않는다
    //     → 하이버네이트의 자동 flush 도 발동하지 않는다
    //   └ 실행 후 clear() → ① 의 변경분이 통째로 폐기된다

    notificationService.notifyClosed(event);  // ② event 는 이제 준영속(detached)
}   // ③ 커밋 — 티켓은 만료됐는데 이벤트는 여전히 OPEN 이다
```

**결과**: 티켓 1만 장은 EXPIRED가 됐는데 **이벤트만 OPEN으로 남는다.** 예외는 없다. `event.getStatus()`는 메모리에서 여전히 `CLOSED`를 돌려주므로 디버깅 중에도 정상으로 보인다. **DB만 틀려 있다.** 이건 §2-1의 덮어쓰기보다 더 조용한 사고다.

여기서 **`flushAutomatically = true`가 없다는 점이 결정적**이다. 있었다면 clear 이전에 ①이 DB로 나가 살아남는다. 그래서 두 옵션은 **짝으로 쓰지 않으면 위험**하다.

```java
// 그나마 나은 형태 — 반드시 짝으로
@Modifying(flushAutomatically = true, clearAutomatically = true)
@Query("update Ticket t set t.status = 'EXPIRED' where t.event.id = :eventId")
int expireTickets(@Param("eventId") Long eventId);
```

### 2-9. 이유 ② — clear 이후 모든 참조가 준영속이 된다

두 번째 부작용은 더 시끄럽다. `clear()`는 컨텍스트가 관리하던 엔티티를 전부 **준영속(detached)** 으로 만든다.

용어를 여기서 정의하고 가자. **준영속이란 "한때 영속성 컨텍스트가 관리했지만 지금은 떨어져 나온(detached) 상태"** 를 말한다. 자바 변수는 그대로 그 객체를 가리키고 있어서 겉보기에는 멀쩡하지만, **그 객체는 더 이상 영속성 컨텍스트와 연결돼 있지 않다.** 그래서 두 기능이 함께 죽는다 — 지연 로딩(아직 안 채운 연관을 나중에 DB에서 채워 넣는 기능)과 변경 감지(값이 바뀌면 커밋 때 UPDATE를 만들어 주는 기능)다. 둘 다 영속성 컨텍스트가 살아서 그 객체를 붙들고 있어야 동작하기 때문이다.

```java
@Transactional
public void closeEvent(Long eventId) {
    Event event = eventRepository.findById(eventId).orElseThrow();

    ticketRepository.expireTickets(eventId);   // clearAutomatically = true

    // event 는 준영속. 아직 초기화되지 않은 LAZY 연관을 건드리면 터진다.
    for (Sponsor s : event.getSponsors()) {     // LazyInitializationException
        ...
    }

    event.setStatus(CLOSED);                    // 변경 감지도 동작하지 않는다
                                                // (준영속 엔티티는 추적 대상이 아니다)
}   // 커밋해도 UPDATE 가 나가지 않는다
```

증상이 둘로 갈린다는 점이 고약하다. **초기화된 필드는 잘 읽히고, 초기화 안 된 LAZY 연관에서만 터진다.** 그래서 "어떤 요청은 되고 어떤 요청은 예외"라는 형태로 나타난다. 준영속 상태와 `LazyInitializationException`의 전모는 [LazyInitializationException](07-lazy-initialization-exception.md) 문서에 있다.

또 하나: **`clear()` 이후에 `p.setName(...)` 같은 수정을 해도 변경 감지가 동작하지 않는다.** 다시 영속 상태로 만들려면 재조회하거나 `merge`해야 하는데, `merge`는 또 다른 함정을 달고 온다([merge vs 변경 감지](05-merge-vs-dirty-checking.md)).

### 2-10. 정리 — 옵션이 하는 일과 못 하는 일

| `clearAutomatically = true` 의 효과 | 원했던 것인가 | 내용 |
|---|---|---|
| 벌크 이후의 조회가 DB를 다시 읽게 만든다 | 원했음 | 낡은 값 조회가 사라진다 |
| dirty checking 덮어쓰기를 막는다 | 원했음 | 캐시가 비었으니 덮어쓸 엔티티도 없다 |
| 벌크와 무관한 엔티티의 미flush 변경분을 폐기한다 | **원치 않았음** | 커밋해도 UPDATE가 안 나간다 (§2-8) |
| 살아 있던 모든 참조를 준영속으로 만든다 | **원치 않았음** | 지연 로딩 실패, 변경 감지 정지 (§2-9) |
| 이후 조회가 전부 SELECT를 다시 날린다 | **원치 않았음** | 캐시를 비운 대가, 성능 비용 |

> **한 문장으로**: `clearAutomatically`는 **"지금 이 트랜잭션에서 영속성 컨텍스트에 남아 있는 것이 아무것도 없다"** 가 참일 때만 안전하다. 그런데 그게 참이라면 **애초에 벌크를 그 자리에 둘 이유가 없다** — 그래서 다음 절이 진짜 답이다.

---

## 3. 처방과 안전망 — 옵션이 아니라 배치, 그리고 테스트로 고정하기

### 3-1. 원칙 한 문장

> **영속성 컨텍스트를 우회하는 연산과, 영속성 컨텍스트에 의존하는 연산을 같은 트랜잭션에 섞지 않는다.**

두 종류의 코드는 **서로 다른 진실의 원천**을 본다. 벌크 연산·네이티브 쿼리는 **DB**를 보고, 엔티티 수정·지연 로딩·변경 감지는 **1차 캐시**를 본다. 한 트랜잭션에 섞는 순간 "지금 어느 쪽이 진실인가"를 사람이 머릿속으로 추적해야 하고, 그 추적은 반드시 언젠가 실패한다. 옵션 두 개는 **섞인 상태를 사후에 봉합하는 도구**일 뿐이다.

### 3-2. 실행 형태 세 가지

**형태 A — 벌크를 트랜잭션의 맨 끝에 둔다** (가장 간단하고 대부분 이걸로 충분하다)

```java
// BEFORE — 벌크가 한가운데
@Transactional
public void closeEvent(Long eventId) {
    Event event = eventRepository.findById(eventId).orElseThrow();
    ticketRepository.expireTickets(eventId);      // 벌크
    event.setStatus(CLOSED);                      // 이후에 엔티티를 만진다 → 위험
    auditService.record(event);
}
```

```java
// AFTER — 엔티티 작업을 전부 끝낸 뒤 마지막에 벌크
@Transactional
public void closeEvent(Long eventId) {
    Event event = eventRepository.findById(eventId).orElseThrow();
    event.setStatus(CLOSED);
    auditService.record(event);

    entityManager.flush();                        // 엔티티 변경분을 먼저 확정하고
    ticketRepository.expireTickets(eventId);      // 벌크는 맨 끝에서 한 번
}   // 커밋. 벌크 이후 엔티티를 건드리는 코드가 아예 없다 → clear 도 필요 없다
```

핵심은 **"벌크 이후에 엔티티를 읽거나 쓰는 코드가 존재하지 않게" 만드는 것**이다. 그러면 불일치는 여전히 생기지만 **아무도 그 불일치를 관찰하지 않으므로** 사고가 나지 않는다. 그리고 트랜잭션이 끝나면 컨텍스트도 함께 닫히므로 낡은 캐시가 다음 요청으로 새지 않는다.

같은 원리의 **반대쪽 배치**도 성립한다 — **벌크를 엔티티를 조회하기 전(트랜잭션 맨 앞)에 두는 것**이다. 아직 1차 캐시에 아무것도 없으므로 낡아질 엔티티가 존재하지 않고, 이후 조회는 벌크가 반영된 DB를 읽는다. **"벌크 앞 또는 뒤, 어느 쪽이든 엔티티 작업 구간과 겹치지만 않으면 된다"** 가 정확한 표현이다.

**형태 B — 별도 트랜잭션으로 분리한다** (벌크 대상이 크거나 호출 지점이 여럿일 때)

```java
@Service
@RequiredArgsConstructor
public class TicketBulkService {

    private final TicketRepository ticketRepository;

    @Transactional(propagation = Propagation.REQUIRES_NEW)   // 자기만의 트랜잭션·컨텍스트
    public int expireTickets(Long eventId) {
        return ticketRepository.expireTickets(eventId);
    }
}
```

별도 트랜잭션은 **자기만의 영속성 컨텍스트**를 갖는다. 호출한 쪽 컨텍스트는 손대지 않으므로 §2-8의 소실 사고가 원천적으로 불가능하다. 다만 대가가 분명하다 — **원자성이 깨진다.** 바깥 트랜잭션이 롤백돼도 안쪽 벌크는 이미 커밋돼 있다. **"벌크만 성공하고 나머지는 롤백"이 허용되는 경우에만** 쓸 수 있다.

> `REQUIRES_NEW`는 **자기 자신 호출(self-invocation)에서는 동작하지 않는다.** 같은 클래스 안에서 `this.expireTickets(...)`로 부르면 프록시를 거치지 않아 새 트랜잭션이 열리지 않는다. **빈을 분리해야 한다.**

**형태 C — 트랜잭션 커밋 이후로 미룬다** (부수적인 정리 작업일 때)

`@TransactionalEventListener(phase = AFTER_COMMIT)`로 벌크를 커밋 이후에 실행하면, 그 시점엔 원래 컨텍스트가 이미 닫혀 있어 오염될 대상 자체가 없다. 단, 이것도 원자성 밖이므로 **실패했을 때의 보정 경로**를 반드시 설계해야 한다.

### 3-3. 어떤 걸 고를까

```text
벌크 이후에 엔티티를 안 만져도 되는가?
  ├─ 예 → 형태 A. 벌크를 맨 끝으로. 옵션도 clear 도 필요 없다. (기본 선택)
  └─ 아니오
       ├─ 벌크만 따로 커밋돼도 되는가?
       │    ├─ 예 → 형태 B (REQUIRES_NEW) 또는 형태 C
       │    └─ 아니오 → 같은 트랜잭션에 둘 수밖에 없다
       │                → @Modifying(flushAutomatically = true, clearAutomatically = true)
       │                → 단 §2-8, §2-9 의 대가를 알고 쓰는 것이며, 이후 코드는 반드시 재조회할 것
```

면접에서는 이 순서로 말하면 된다. **"먼저 배치로 풉니다. 배치로 못 풀 때만 옵션을 쓰고, 그때는 두 옵션을 반드시 짝으로 켭니다."**

### 3-4. 같은 원칙이 적용되는 것들 — 벌크만의 문제가 아니다

"영속성 컨텍스트를 우회한다"는 성질을 공유하는 것들은 **전부 같은 사고를 낸다.**

- **네이티브 쿼리(`@Query(nativeQuery = true)`)** — 벌크 연산과 완전히 동일하다. 변경 쿼리라면 `@Modifying`이 여전히 필요하고, 1차 캐시도 갱신되지 않는다. 하이버네이트는 네이티브 SQL의 문자열을 해석하지 못하므로 **어떤 테이블을 건드리는지 알 수 없고**, 그래서 자동 flush 판단도 JPQL과 다르게 동작한다.
- **JPA Auditing (`@CreatedDate` / `@LastModifiedDate`)** — 엔티티 리스너(영속성 컨텍스트 이벤트) 기반이라 **벌크 연산에서는 조용히 기록되지 않는다.** "벌크로 고친 행만 `updated_at`이 옛날 그대로"라는 증상이 여기서 나온다. 필요하면 벌크 JPQL에 `set p.updatedAt = :now`를 **직접 써야 한다.**
- **낙관적 락(`@Version`)** — 벌크 UPDATE는 version 컬럼을 자동으로 올리지 않는다. `set p.version = p.version + 1`을 명시하지 않으면 **다른 트랜잭션이 그 변경을 감지하지 못한다.** ([낙관적 락과 비관적 락](10-optimistic-vs-pessimistic-lock.md))
- **연쇄 삭제(`cascade`)와 고아 객체 제거(`orphanRemoval`)** — 이것들도 영속성 컨텍스트의 기능이다. 벌크 DELETE는 **자식 행을 알아서 지워주지 않는다.** "벌크로 부모를 지웠더니 FK 제약 위반" 또는 "고아 행이 남았다"가 여기서 나온다.
- **2차 캐시(second-level cache)** — 켜져 있다면 **벌크 연산은 2차 캐시도 무효화하지 않는다.** 1차 캐시는 트랜잭션이 끝나면 사라지지만 2차 캐시는 애플리케이션 전역에 **계속 남는다.** 즉 **불일치가 이 요청에서 끝나지 않고 이후 요청들까지 오염**시킨다. 벌크가 건드리는 엔티티에 2차 캐시를 쓴다면 캐시 영역을 명시적으로 비워야 한다. **(가산점 포인트)**

> **하나로 묶으면**: **"JPA를 우회한 변경은 JPA가 모른다."** 벌크 연산이 특별한 게 아니라, **영속성 컨텍스트를 거치지 않는 모든 경로가 같은 성질을 갖는다.** 이 한 문장으로 답하면 지식이 조각이 아니라 원리라는 게 드러난다.

### 3-5. 증상 → 원인 역방향 인덱스

**이 문항의 rationale이 말하는 "겪었거나 원리를 아는 사람만 즉답한다"는 결국 이 방향의 인덱스를 갖고 있느냐다.** 원인에서 증상을 유도하는 건 원리를 알면 누구나 한다. 실무에서 필요한 건 **증상에서 원인으로 거슬러 올라가는 것**이다. 아래를 트리거로 외워두면 며칠이 십 분이 된다.

| 증상 | 원인 | 확인 방법 | 처방 |
|---|---|---|---|
| DB를 직접 조회하면 바뀌었는데 **API 응답은 옛날 값** | 벌크 후 1차 캐시 미갱신 (§1-5) | 같은 트랜잭션 안에서 재조회 시 **SELECT가 안 나감** | 벌크 이후 재조회가 필요하면 `clearAutomatically` 또는 벌크를 맨 끝으로 |
| **벌크 UPDATE를 분명히 실행했는데 결과가 사라졌다** | 커밋 시 dirty checking의 전 컬럼 UPDATE가 덮어씀 (§2-1) | SQL 로그에 벌크 UPDATE **뒤에** 같은 행을 치는 UPDATE가 하나 더 | 벌크 이후 그 엔티티를 건드리지 않기 / 재조회 후 수정 |
| 벌크 UPDATE의 **`WHERE`에 방금 바꾼 값이 안 걸린다** (영향 행 수 0) | 실행 전 flush 누락 (§2-6) | 반환된 `int`가 0, DB엔 조건 만족 행이 있음 | `flushAutomatically = true` 또는 `em.flush()` 선행 |
| 벌크 실행 후 갑자기 **`LazyInitializationException`** | `clearAutomatically`가 참조를 준영속화 (§2-9) | 예외가 벌크 호출 **이후 줄에서만** 발생 | 벌크를 맨 끝으로 / clear 이후 필요한 엔티티는 재조회 |
| 벌크와 **무관한 엔티티의 수정이 통째로 사라짐** | `clearAutomatically`가 미flush 변경분 폐기 (§2-8) | 커밋 로그에 그 엔티티의 UPDATE가 아예 없음 | `flushAutomatically`를 **짝으로** 켜기 / 트랜잭션 분리 |
| 벌크 이후 `setter`를 호출해도 **UPDATE가 안 나감** | clear로 준영속화되어 변경 감지 정지 (§2-9) | 커밋 시 해당 UPDATE 부재 | 재조회 후 수정 |
| **벌크로 고친 행만 `updated_at`이 안 바뀜** | Auditing은 엔티티 리스너 기반, 벌크는 우회 (§3-4) | 벌크 대상 행만 타임스탬프가 옛날 | JPQL에 `set updatedAt = :now` 직접 명시 |
| 벌크로 바꿨는데 **낙관적 락이 충돌을 못 잡음** | 벌크가 `version`을 올리지 않음 (§3-4) | version 컬럼이 그대로 | JPQL에 `set version = version + 1` 명시 |
| **벌크 DELETE 후 FK 제약 위반 / 고아 행** | `cascade`·`orphanRemoval`은 컨텍스트 기능 (§3-4) | 자식 테이블에 행이 남아 있음 | 자식부터 벌크 삭제 / DB의 `ON DELETE` 제약 활용 |
| **재배포 전까지 옛날 값이 계속 나옴** | 2차 캐시가 무효화되지 않음 (§3-4) | 인스턴스를 재시작하면 정상 | 벌크 후 해당 캐시 영역 명시적 무효화 |
| **테스트는 통과하는데 운영에서만 터짐(또는 반대)** | `@Transactional` 테스트의 1차 캐시 공유 (§3-6) | 테스트에서 `em.clear()`를 넣으면 재현됨 | 검증을 **새 트랜잭션·새 컨텍스트**에서 (§3-7) |

**세 개의 대표 트리거만 외워도 대부분 잡힌다.**

```text
"DB 는 바뀌었는데 조회는 옛날 값"      → 벌크가 1차 캐시를 우회했다
"벌크 결과가 조용히 사라졌다"          → dirty checking 이 전 컬럼 UPDATE 로 덮었다
"벌크와 상관없는 수정이 사라졌다"      → clearAutomatically 가 미flush 변경분을 버렸다
```

### 3-6. 테스트의 함정 — `@Transactional` 테스트에서는 검증이 오염된다

이 문항의 사고는 **예외가 나지 않는다.** 예외가 안 나는 사고를 막는 방법은 하나뿐이다 — **단정(assertion)으로 고정하는 것.** 그런데 평소 쓰던 테스트 골격을 그대로 쓰면 단정 자체가 무력해진다.

```java
// BEFORE — 이 테스트는 사고를 절대 잡지 못한다
@SpringBootTest
@Transactional                                   // 테스트 메서드가 트랜잭션을 연다
class ProductServiceTest {

    @Test
    void 벌크_결과가_유지된다() {
        Product p = productRepository.save(new Product("구상품", 100));

        productService.closeOutSale(p.getId());  // 내부에서 벌크 + setName

        Product found = productRepository.findById(p.getId()).orElseThrow();
        assertThat(found.getStock()).isZero();   // 무엇을 검증한 걸까?
    }
}
```

문제가 셋이다.

- **테스트와 서비스가 같은 영속성 컨텍스트를 공유한다.** 테스트가 연 트랜잭션 안에서 서비스가 실행되므로(`@Transactional`은 기본이 `REQUIRED`), `findById`는 **1차 캐시에서** 나온다. **DB를 읽지 않는다.**
- **서비스의 커밋이 일어나지 않는다.** 테스트 트랜잭션은 끝에서 롤백되므로 **dirty checking으로 인한 덮어쓰기 UPDATE가 애초에 발생하지 않는다.** 잡으려는 사고가 실행되지 않는 것이다.
- 그래서 이 단정은 통과할 수도, 실패할 수도 있는데 **어느 쪽이든 우리가 알고 싶은 것과 무관하다.**

### 3-7. 처방 ① — 검증을 새 트랜잭션·새 컨텍스트에서

```java
// AFTER — 테스트에 @Transactional 을 붙이지 않고, 검증을 별도 트랜잭션에서
@SpringBootTest
class ProductServiceTest {

    @Autowired ProductService productService;
    @Autowired ProductRepository productRepository;
    @Autowired TransactionTemplate txTemplate;     // 트랜잭션 경계를 직접 잡는다

    @AfterEach
    void tearDown() {
        productRepository.deleteAll();             // 롤백이 없으니 직접 정리
    }

    @Test
    void 벌크로_0이_된_재고가_dirty_checking_에_덮어쓰이지_않는다() {
        Long id = txTemplate.execute(s ->
                productRepository.save(new Product("구상품", 100)).getId());

        productService.closeOutSale(id);           // 서비스가 자기 트랜잭션에서 커밋한다

        Integer stock = txTemplate.execute(s ->    // 새 트랜잭션 = 새 영속성 컨텍스트
                productRepository.findById(id).orElseThrow().getStock());

        assertThat(stock).isZero();                // 덮어쓰기가 있었다면 100 → 실패
    }
}
```

핵심은 **"쓴 트랜잭션과 읽는 트랜잭션을 분리한다"** 이다. 그래야 검증이 **1차 캐시가 아니라 DB**를 본다.

### 3-8. 처방 ② — `@Transactional`을 유지해야 한다면 `flush` + `clear`를 명시

기존 테스트 스위트가 전부 `@Transactional` 기반이라 뜯기 어렵다면, **검증 직전에 컨텍스트를 강제로 비워** 최소한 "캐시가 정답을 가리는" 문제만은 없앤다.

```java
@Test
@Transactional
void 벌크_직후_DB와_1차_캐시는_다르다() {
    Product p = productRepository.save(new Product("구상품", 100));
    entityManager.flush();
    entityManager.clear();                          // 저장 직후 캐시를 비워 "새로 조회한 상태"를 만든다

    Product loaded = productRepository.findById(p.getId()).orElseThrow();  // stock = 100
    productRepository.zeroStockAll();               // 벌크

    assertThat(loaded.getStock()).isEqualTo(100);   // ① 1차 캐시는 옛 값 그대로

    entityManager.clear();                          // ② 캐시를 비우고 다시 읽으면
    Product reloaded = productRepository.findById(p.getId()).orElseThrow();
    assertThat(reloaded.getStock()).isZero();       //    DB 는 이미 0
}
```

이 테스트는 **"불일치가 실제로 존재한다"는 사실 자체를 문서화**한다. 팀에 이 동작을 설명하는 데 문장 열 줄보다 낫다.

다만 **주의**: 이 방식으로는 §2-1의 덮어쓰기(커밋 시점에 발생)를 잡을 수 없다. 롤백되는 트랜잭션에서는 커밋 플러시가 일어나지 않기 때문이다. **덮어쓰기 회귀를 막으려면 §3-7이 필요하다.**

### 3-9. 처방 ③ — "커밋 시 유령 UPDATE 0건"을 단정

덮어쓰기의 본질은 **"내가 기대하지 않은 UPDATE가 커밋 시점에 하나 더 나갔다"** 이다. 그러면 값이 아니라 **쿼리 개수**를 단정하는 편이 원인에 더 가깝다.

```java
@Test
void 벌크_이후_커밋에서_추가_UPDATE가_나가지_않는다() {
    Long id = ...;

    SQLStatementCountValidator.reset();
    productService.closeOutSale(id);                 // 서비스가 커밋까지 수행

    SQLStatementCountValidator.assertSelectCount(1); // 조회 1
    SQLStatementCountValidator.assertUpdateCount(1); // 벌크 UPDATE 딱 1개
                                                     // 덮어쓰기가 있으면 2 → 실패
}
```

`SQLStatementCountValidator`(datasource-proxy 계열)나 하이버네이트의 `Statistics.getPrepareStatementCount()`로 같은 단정을 만들 수 있다. **이 도구 상자는 N+1 회귀 방지와 완전히 동일한 것**이며, 설치 방법과 주의점은 [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md) §3에 정리돼 있다. 한 번 깔아두면 **"조용한 추가 쿼리" 부류의 사고 전체**를 같은 방식으로 막을 수 있다.

### 3-10. 코드 리뷰 규칙으로도 고정하기

테스트가 못 잡는 부분은 **규칙**으로 막는다. 이 문항에서 값이 나오는 규칙은 셋이다. **(가산점 포인트)**

- **`@Modifying` 메서드는 `int`를 반환한다** — 영향 행 수를 버리지 않기 위해서(§1-3).
- **`clearAutomatically = true`는 `flushAutomatically = true`와 짝으로만 쓴다** — 단독 사용은 §2-8의 소실 사고를 부른다.
- **`@Modifying` 호출 다음 줄부터는 이전에 로드한 엔티티를 사용하지 않는다** — 지킬 수 없다면 그 벌크는 자리를 잘못 잡은 것이다(§3-2).

---

## 4. 꼬리질문 대비 포인트

### "`@Modifying`을 빼면 정확히 무슨 일이 일어나나요?"

Spring Data JPA는 JPQL 문자열을 해석해 조회/변경을 판단하지 않고 **메서드 단위로 실행 방식을 미리 정해두는데, 기본이 조회**다. 그래서 `@Modifying`이 없으면 UPDATE 문을 들고 **`getResultList()`** 를 호출하고, 하이버네이트가 "SELECT가 아닌데 결과 목록을 요구한다"며 거부한다. 예외 타입은 버전에 따라 다르다 — 하이버네이트 5에서는 `QueryExecutionRequestException: Not supported for DML operations`, 하이버네이트 6에서는 `IllegalSelectQueryException: Expecting a selection query, but found ...` 계열이고, Spring 계층에서는 대개 `InvalidDataAccessApiUsageException`으로 변환돼 올라온다. **정확한 클래스명보다 "조회 실행 경로로 들어가 실패한다"는 메커니즘을 말하는 게 안전하다.** 그리고 `@Modifying`을 붙여도 **쓰기 트랜잭션이 없으면** `TransactionRequiredException`이 난다 — `SimpleJpaRepository`가 `readOnly = true`를 기본으로 갖기 때문이다.

### "`clearAutomatically = true`만 붙이면 안 되나요?" (시니어 변별 포인트)

**증상은 사라지지만 더 조용한 사고로 옮겨간다.** `clear()`는 벌크 대상만 골라 비우는 게 아니라 **영속성 컨텍스트 전체를 비운다.** 같은 트랜잭션에서 수정 중이던 다른 엔티티의 변경분이 아직 flush되지 않았다면 **그대로 증발**하고, 커밋해도 UPDATE가 나가지 않는다. 특히 그 엔티티가 벌크와 **다른 테이블**이면 하이버네이트의 자동 flush도 발동하지 않아 **확실히 사라진다.** 덤으로 살아 있던 모든 참조가 준영속이 되어 지연 로딩은 `LazyInitializationException`, 이후의 `setter`는 변경 감지 정지다. 그래서 **`flushAutomatically`와 반드시 짝으로 써야 하고**, 더 근본적으로는 **벌크를 트랜잭션 맨 끝으로 옮기거나 별도 트랜잭션으로 분리**해 옵션이 필요 없는 구조로 만드는 게 정답이다.

### "`flushAutomatically`는 왜 필요한가요? 어차피 하이버네이트가 자동으로 flush하지 않나요?" (시니어 변별 포인트)

**대개는 해준다. 하지만 조건부이고, 그 조건은 계약이 아니라 최적화 휴리스틱이다.** 하이버네이트는 기본 flush 모드(`AUTO`)에서 **쿼리가 건드리는 테이블과 아직 반영되지 않은 변경분의 테이블이 겹칠 때만** flush한다. 겹치지 않으면 건너뛴다. 게다가 `@Transactional(readOnly = true)`는 세션을 `MANUAL`로 두어 **자동 flush 자체를 끈다.** 즉 "하이버네이트가 알아서 해준다"는 **설정 하나로 무너지는 가정**이다. `flushAutomatically = true`는 Spring Data JPA가 실행 직전에 flush를 **명시적으로** 수행하게 만들어 이 의존을 없애고, 동시에 **"이 벌크는 최신 상태 위에서 돈다"는 의도를 코드에 드러낸다.**

> 정확도 주의: 자동 flush의 세부 발동 조건은 하이버네이트 버전과 부트스트랩 방식(JPA `EntityManager` vs 네이티브 `Session`)에 따라 차이가 있다. 면접에서는 **"조건부다 / 그래서 명시하는 게 안전하다"** 까지만 말하는 편이 안전하다.

### "벌크 UPDATE 결과가 왜 dirty checking에 덮어쓰이나요? `name`만 바꿨는데요."

두 사실이 겹쳐서 그렇다. **① 스냅샷은 로드 시점 값으로 고정된다** — 벌크가 DB를 바꿔도 스냅샷은 갱신되지 않는다. **② 하이버네이트의 UPDATE는 기본적으로 전 컬럼을 포함한다** — SQL 문자열을 미리 만들어 재사용하고 DB의 실행 계획 캐시를 살리기 위해서다. 그래서 `name`이 바뀌었다는 이유로 UPDATE가 만들어지면 그 안의 `stock` 자리에는 **1차 캐시의 값(100)** 이 들어가고, 벌크가 만든 `0`을 덮는다. **버그가 아니라 정상 동작**이며, 하이버네이트는 자기 모르게 DB가 바뀐 사실을 알 방법이 없다. `@DynamicUpdate`를 붙이면 이 특정 덮어쓰기는 피하지만 **불일치 자체와 읽기 오염은 그대로**이고, 낡은 값을 근거로 `stock`을 계산해 넣는 순간 다시 터진다.

### "그럼 벌크 연산은 아예 쓰지 말아야 하나요?"

아니다. **대량 갱신에서 벌크 연산은 대체 불가능**하다. 1만 건을 한 건씩 처리하면 엔티티 1만 개를 메모리에 올리고(OOM), 스냅샷을 1만 개 만들고, UPDATE를 1만 번 날린다. 벌크는 이걸 **SQL 한 문장**으로 끝낸다. 문제는 벌크 자체가 아니라 **벌크를 영속성 컨텍스트에 의존하는 코드와 같은 트랜잭션에 섞는 것**이다. 그래서 규칙은 "쓰지 마라"가 아니라 **"섞지 마라"** 다 — 벌크는 트랜잭션의 맨 끝이나 별도 트랜잭션에 두고, 그 뒤로는 기존 엔티티 참조를 쓰지 않는다.

### "이 사고를 배포 전에 잡으려면 어떻게 하나요?" (가산점 포인트)

**예외가 안 나는 사고이므로 단정으로 고정해야 한다.** 다만 `@Transactional`을 붙인 테스트는 **테스트와 서비스가 같은 영속성 컨텍스트를 공유**하고 **끝에서 롤백되어 커밋 플러시가 일어나지 않으므로**, 잡으려는 사고가 실행조차 되지 않는다. 그래서 ① **쓰는 트랜잭션과 읽는 트랜잭션을 분리**하고(`TransactionTemplate`), ② 값 단정에 더해 **`assertUpdateCount(1)` 같은 쿼리 수 단정**으로 "커밋 시점의 유령 UPDATE 0건"을 고정한다. ③ 테스트로 못 막는 부분은 리뷰 규칙으로 — `@Modifying`은 `int` 반환, `clearAutomatically`는 `flushAutomatically`와 짝으로, 벌크 호출 이후에는 이전 엔티티 참조 금지. 같은 도구 상자가 [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md)의 쿼리 수 단정과 정확히 동일하다.

### "네이티브 쿼리도 같은 문제가 있나요?" (가산점 포인트)

**있다. 원인이 벌크가 아니라 "영속성 컨텍스트를 우회한다"는 성질에 있기 때문이다.** 네이티브 변경 쿼리도 `@Modifying`이 필요하고, 1차 캐시를 갱신하지 않으며, 덮어쓰기도 똑같이 난다. 게다가 하이버네이트는 네이티브 SQL 문자열을 해석하지 못해 **어떤 테이블을 건드리는지 모르므로** 자동 flush 판단이 JPQL과 다르게 동작한다. 같은 이유로 **JPA Auditing이 기록되지 않고**(리스너 기반), **`@Version`이 올라가지 않고**, **`cascade`·`orphanRemoval`이 동작하지 않으며**, **2차 캐시도 무효화되지 않는다** — 2차 캐시는 트랜잭션이 끝나도 남으므로 불일치가 **이후 요청들까지 오염**시킨다는 점에서 더 위험하다. 한 문장으로 묶으면 **"JPA를 우회한 변경은 JPA가 모른다"** 이다.

---

## 한 줄 요약

**벌크 연산은 영속성 컨텍스트를 우회해 즉시 DB로 나간다** — 쓰기 지연 대상이 아니라 오히려 **실행 직전 flush가 선행되고 그 자리에서 UPDATE가 실행**되며, 1차 캐시는 갱신되지 않아 **DB와 메모리가 어긋난 채로 트랜잭션이 이어진다.** 그 불일치는 **낡은 값 조회**와, 그 엔티티를 조금만 건드려도 **전 컬럼 UPDATE가 벌크 결과를 조용히 덮어쓰는 사고**로 터진다. `@Modifying`의 두 옵션은 방향이 반대여서 **`flushAutomatically`는 실행 전 반영, `clearAutomatically`는 실행 후 폐기**이고, **`clearAutomatically`는 컨텍스트를 통째로 비워 다른 엔티티의 미flush 변경분까지 소실시키므로 안전장치가 아니다.** 그래서 진짜 처방은 옵션이 아니라 배치 — **영속성 컨텍스트를 우회하는 연산과 그것에 의존하는 연산을 같은 트랜잭션에 섞지 않는다.** 그리고 이 사고는 예외를 던지지 않으므로, **트랜잭션을 분리한 테스트와 쿼리 수 단정으로 고정하기 전까지는 언제든 되살아난다.**
