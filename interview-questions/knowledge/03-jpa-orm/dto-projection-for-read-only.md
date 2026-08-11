# 조회 전용 DTO 프로젝션 — "이 조회의 목적이 변경인가, 표시인가"

> 핵심 관전 포인트: 이 질문은 **결합도 질문이 아니라 조회 비용 질문**이다. "엔티티를 노출하면 안 된다"(계층 경계)와 결론이 비슷해 보여도 근거의 층이 다르므로, 첫 답변에서 초점을 맞춰야 한다. **이유는 세 층이다.** **1층 조회 컬럼** — 엔티티 조회는 매핑된 컬럼을 전부 읽으므로 목록에 쓰지도 않는 `description TEXT`, `detail_html`까지 DB에서 읽어 네트워크로 실어 온다. **2층 영속성 컨텍스트 비용** — 엔티티는 1차 캐시에 적재되고 변경 감지용 **스냅샷이 복사되어 메모리가 사실상 2배**가 되며, 커밋 시점에 `엔티티 수 × 필드 수`만큼 비교가 돈다. **3층 결합도** — 화면 요구와 엔티티 구조는 변경의 이유가 다르다. **여기서 `@Transactional(readOnly = true)`는 대체가 아니라 병행 수단이다** — 없어지는 것은 스냅샷과 변경 감지뿐이고, **① 1차 캐시 적재 ② 불필요 컬럼·전송 ③ 지연 로딩 프록시(뒤에서 누가 건드리면 쿼리 폭발)** 는 그대로 남는다. 구현은 **JPQL `select new` / QueryDSL `Projections`·`@QueryProjection` / Spring Data 인터페이스 프로젝션 / 네이티브+`@SqlResultSetMapping`** 네 가지이고, **`@QueryProjection`은 파라미터 개수와 타입만 잡는다. 같은 타입끼리의 순서 교체는 못 잡는다** — 순서를 원천 차단하는 것은 **이름 기반 매핑**이다. 그리고 반드시 포기하는 것도 함께 말한다 — **1:N 조인 시 행 중복, 변경 감지 불가, DTO 클래스 증식.** 판단 기준은 한 문장이다 — **"변경이 목적이면 엔티티, 표시가 목적이면 DTO."**

---

## 0. 질문 + 의도

**질문**: "조회 전용 화면(상품 목록, 주문 내역)에서 엔티티 대신 DTO로 직접 프로젝션하는 이유는? 어떤 방법으로 구현하나?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**조회 전용 DTO 프로젝션** — 목록 조회에
엔티티를 쓰면 필요 없는 컬럼까지 읽고 영속성 컨텍스트 관리 비용(스냅샷 유지)까지
지불한다. **'변경이 목적인 조회'와 '표시가 목적인 조회'를 구분해 도구를 달리 쓰는지** —
조회 성능 최적화의 첫 단추이자 **CQRS(12장)로 이어지는 사고의 출발점**이다."

의도문에 명시된 두 단어가 채점표다.

- **"필요 없는 컬럼"** — 실제로 나가는 SQL의 SELECT 절을 의식하는가.
- **"영속성 컨텍스트 관리 비용(스냅샷 유지)"** — 엔티티를 하나 읽는 행위에 저장소 조회
  이상의 비용이 붙는다는 것을 아는가.

그리고 이 문항이 **`@Transactional(readOnly = true)`라는 유도성 반론과 세트로 나온다**는
점이 중요하다. "readOnly를 걸면 스냅샷이 안 만들어지는데, 그럼 DTO 프로젝션은 필요
없는 거 아닌가요?" 라는 반론에 무너지면 앞서 말한 이유가 전부 되돌려진다. 이 반론의
정답은 **"없어지는 것과 남는 것을 나눠서 말하기"** 이며, §2-2가 통째로 여기에 배정되어
있다.

**함정 두 개**:

- **결합도 축으로 답하고 멈추는 것.** "화면이 바뀌면 엔티티를 고쳐야 한다"는 말은 참이지만
  **이 질문의 답이 아니다.** 그건 [엔티티 직접 노출 금지](entity-exposure-and-dto-boundary.md)의
  답변 축이고, 그 축으로는 "그럼 엔티티로 조회한 뒤 서비스에서 DTO로 변환해도 되지 않나요?"
  라는 한마디에 논거가 전부 무력화된다. §1-1이 이 경계를 갈라준다.
- **구현 방법을 하나만 대는 것.** `Projections.constructor` 하나만 말하면 "그 방식을
  써봤다"는 정보만 전달된다. 이 문항의 후반부는 **네 가지를 알고 상황에 따라 고르는가**를
  본다(§3).

---

## 1. 먼저 질문의 초점을 맞춘다

### 1-1. "엔티티 노출 금지"와 이 질문은 결론이 비슷해도 근거의 층이 다르다

두 질문을 나란히 놓으면 결론이 똑같이 "DTO를 쓰라"로 끝난다. 그래서 하나로 뭉쳐
기억하기 쉬운데, **묻는 것이 다르다.**

| | 엔티티 직접 노출 금지 | 조회 전용 DTO 프로젝션 |
|---|---|---|
| 묻는 것 | 무엇을 **내보낼지** | 무엇을 **가져올지** |
| 근거의 층 | 계층 경계·결합도·보안 | 조회 비용(컬럼·메모리·쿼리) |
| 경계선의 위치 | 서비스 → 컨트롤러 | DB → 애플리케이션 |

이 표의 진짜 의미는 **"둘은 동시에 만족될 수도, 한쪽만 만족될 수도 있다"** 는 것이다.

```java
// (A) 계층 경계는 지켰다. 그런데 조회 비용은 그대로다.
//     — "엔티티 노출 금지" 질문에는 만점, 이 질문에는 0점인 코드
@Transactional(readOnly = true)
public Page<ProductListDto> findProducts(Pageable pageable) {
    return productRepository.findAll(pageable)          // 엔티티 20건을 전부 읽는다
            .map(ProductListDto::from);                 // 밖으로는 DTO만 나간다
}
```

컨트롤러 밖으로는 DTO만 나가므로 **결합도 논거로는 A와 B(조회 자체를 DTO로)가
완전히 동일하다.** 따라서 결합도만 말하면 이 질문에 답하지 못한 것이다.
질문은 **"A가 추가로 지불하는 비용이 무엇인가"** 다.

> 계층 경계·보안 쪽 논거 전체는 [엔티티 직접 노출 금지](entity-exposure-and-dto-boundary.md)에
> 있다. 이 문서는 **그 문서와 겹치는 결합도 이야기를 반복하지 않고**, DB에서
> 애플리케이션까지 오는 구간의 비용만 다룬다.

### 1-2. 이 질문에 답하는 3층 골격

암기할 목록이 아니라 **외울 골격**으로 접근한다. 순서는 **면접관이 검증하기 쉬운 것부터**다.

```
1층  조회 컬럼        — SELECT 절이 달라진다 (불필요 컬럼·네트워크 전송)
2층  영속성 컨텍스트   — 1차 캐시 적재 + 스냅샷 복사 + 커밋 시 변경 감지
3층  결합도·설계      — 화면 요구와 엔티티 구조는 변경의 이유가 다르다
```

3층을 마지막에 두는 이유가 있다. **1·2층은 SQL 로그와 메모리로 증명되는 사실이고,
3층은 설계 취향이 개입한다.** 증명 가능한 것부터 말하면 반론이 붙어도 근거가 남고,
취향부터 말하면 "우리 팀은 다르게 봅니다"로 끝난다. 실제 면접에서 결합도만 말했다가
"A로도 되지 않나요?"에 막히는 이유가 정확히 이것이다.

### 1-3. 40초 답변 스크립트

```
"이유를 세 층으로 나눠 말씀드리겠습니다.

첫째, 나가는 SQL이 다릅니다. 엔티티를 조회하면 매핑된 컬럼을 전부 읽습니다.
상품 목록에는 상품명·가격·썸네일만 필요한데 description TEXT나 detail_html까지
DB가 읽어서 네트워크로 실어 옵니다. DTO 프로젝션은 SELECT 절에 세 컬럼만 남습니다.

둘째, 영속성 컨텍스트 비용입니다. 엔티티는 1차 캐시에 적재되고, 변경 감지를 위해
원본 스냅샷이 한 부 더 복사되어 메모리가 사실상 두 배가 되고, 커밋 시점에
엔티티 수 곱하기 필드 수만큼 비교가 돕니다. DTO는 영속 객체가 아니라서 이 비용이
아예 발생하지 않습니다.

셋째, 결합도입니다. 화면 요구와 엔티티 구조는 변경의 이유가 다릅니다.
다만 이 셋째 층은 엔티티로 조회한 뒤 서비스에서 변환해도 해결되므로,
조회 자체를 DTO로 하는 근거는 앞의 두 층입니다.

readOnly = true를 걸면 둘째 층에서 스냅샷과 변경 감지는 사라지지만
1차 캐시 적재와 첫째 층은 그대로 남습니다. 그래서 readOnly는 DTO 프로젝션의
대체가 아니라 병행 수단으로 봅니다."
```

마지막 문장이 핵심이다. **면접관이 던질 반론을 내가 먼저 처리해버리면** 그 뒤의
꼬리질문이 "그럼 방법은?"으로 넘어간다.

---

## 2. A / A+readOnly / B — 세 방식을 대칭 비교

### 2-0. 예시 고정 — 상품 목록 화면

이 문서 전체가 이 하나의 화면을 쓴다.

```java
@Entity
public class Product {
    @Id @GeneratedValue
    private Long id;

    private String name;           // 목록에 필요
    private BigDecimal price;      // 목록에 필요
    private String thumbnailUrl;   // 목록에 필요

    @Column(columnDefinition = "TEXT")
    private String description;    // 상세 화면에만. 평균 2KB

    @Column(columnDefinition = "TEXT")
    private String detailHtml;     // 상세 화면에만. 에디터 산출물이라 수십 KB도 흔하다

    @Enumerated(EnumType.STRING)
    private ProductStatus status;

    @ManyToOne(fetch = FetchType.LAZY)
    private Category category;     // 목록에는 카테고리명만 필요

    @OneToMany(mappedBy = "product", fetch = FetchType.LAZY)
    private List<ProductOption> options = new ArrayList<>();  // 목록에는 불필요
}
```

- 목록 화면은 **상품명·가격·썸네일·카테고리명**만 쓴다.
- 페이징 20건.
- **이 화면이 전체 호출량을 지배한다.** 메인 진입 화면이라 초당 호출 수가 가장 많다.

마지막 조건이 중요하다. 최적화 판단은 **단건 비용 × 호출 빈도**로 하는 것이고,
"20건 조회가 얼마나 무겁겠나"는 곱하기 전의 이야기다.

### 2-1. A — 엔티티로 조회하고 서비스에서 DTO로 변환

```java
// A. 가장 흔한 코드. 계층 경계는 지켜졌다.
@Transactional
public Page<ProductListDto> findProducts(Pageable pageable) {
    return productRepository.findAll(pageable)
            .map(p -> new ProductListDto(
                    p.getId(), p.getName(), p.getPrice(), p.getThumbnailUrl(),
                    p.getCategory().getName()));   // ← LAZY 프록시 초기화 = 추가 쿼리
}
```

실제로 일어나는 일을 항목별로 뜯으면 이렇다.

**(1) SQL — 매핑된 컬럼 전부**

```sql
-- description, detail_html까지 읽는다. 목록 화면은 이 두 컬럼을 쓰지 않는다.
select p.id, p.name, p.price, p.thumbnail_url,
       p.description, p.detail_html, p.status, p.category_id
  from product p
 limit 20;
```

`description` 2KB + `detailHtml` 수십 KB짜리 행이 20건이면 **한 번의 목록 조회에
수백 KB가 DB 버퍼에서 읽혀 네트워크를 타고 넘어온다.** 화면은 그 데이터를 한 글자도
쓰지 않는다. 여기서 비용이 붙는 지점은 세 군데다 — **DB의 디스크·버퍼 읽기,
DB↔앱 네트워크 전송, JVM의 String 생성.** 특히 TEXT/BLOB 계열은 벤더에 따라
행 밖(off-page)에 저장되어 **추가 페이지 접근**을 유발하기도 한다.

**(2) N+1 — `getCategory().getName()`**

`Category`가 LAZY이므로 행마다 프록시 초기화 쿼리가 나간다. 20건이면 `1 + 20`.
**DTO 변환 코드가 연관을 건드리는 순간 N+1은 그대로 발생한다** — DTO로 감싸는 것
자체가 N+1을 없애주지는 않는다.

**(3) 영속성 컨텍스트 — 적재 + 스냅샷**

`Product` 20개 + `Category` 최대 20개가 1차 캐시에 들어가고, **각각에 대해 변경 감지용
원본 스냅샷이 한 부 더 복사된다.** 목록 화면 하나가 실제로 보관하는 메모리는
"엔티티 20개"가 아니라 **"엔티티 20개 + 스냅샷 20부"** 다. `detailHtml`이 무거우면
이 두 배가 그대로 두 배로 아프다.

**(4) 커밋 시점 — 변경 감지가 돈다**

트랜잭션이 끝날 때 Hibernate는 1차 캐시의 모든 엔티티에 대해 스냅샷과 현재 값을
필드 단위로 비교한다. 비용은 대략 **`엔티티 수 × 필드 수`** 다. 아무것도 수정하지
않았어도 **비교는 전부 돈다.** 여기에 [의도하지 않은 UPDATE](persistence-context-dirty-checking.md)
가 나갈 위험까지 얹힌다 — 컨버터 왕복 비대칭이나 `BigDecimal` scale 차이로
"안 시킨 UPDATE"가 조회 화면에서 나가는 사고가 실제로 있다.

**조회만 하는 화면인데 쓰기 경로의 기계장치가 전부 켜져 있는 상태**가 A다.

### 2-2. A + readOnly — 스냅샷은 사라진다. 그런데 세 가지가 남는다

```java
// A + readOnly. 여기까지는 반드시 해야 한다. 그런데 이게 B의 대체는 아니다.
@Transactional(readOnly = true)
public Page<ProductListDto> findProducts(Pageable pageable) { ... }
```

**없어지는 것 (정확히 두 개)**

- **스냅샷 복사** — Hibernate 조합에서 Spring은 세션을 read-only로 표시하고, read-only로
  로드된 엔티티는 **원본 스냅샷을 보관하지 않는다.** §2-1의 (3)에서 말한 메모리 2배가
  1배로 줄어든다.
- **변경 감지 / flush** — flush 모드가 사실상 꺼지므로 커밋 시점의 필드 비교와
  UPDATE가 일어나지 않는다. §2-1의 (4)가 사라지고, "안 시킨 UPDATE" 위험도 함께 사라진다.

> **확인 범위**: 이 최적화는 **JPA 표준이 보장하는 것이 아니라 Hibernate 구현에 기댄
> 동작**이다. JPA 표준에서 `readOnly`는 힌트에 가깝다. 면접에서는 "Spring + Hibernate
> 조합에서"라는 전제를 붙여 말하는 편이 정확하다.

**남는 것 (세 개 — 이 문항의 핵심)**

1. **1차 캐시 적재.** 스냅샷을 안 만들어도 **엔티티 인스턴스 자체는 영속성 컨텍스트의
   Map에 들어간다.** 20건이면 20개, 배치로 5,000건을 훑으면 5,000개가 쌓이고
   **트랜잭션이 끝날 때까지 GC 대상이 아니다.** 영속성 컨텍스트는 트랜잭션 범위의
   강한 참조 컨테이너라서, "읽기만 하는데 왜 메모리가?"의 답이 여기 있다.
2. **`select *` 로 인한 불필요 컬럼·네트워크 전송.** `readOnly`는 **SELECT 절을 한 글자도
   바꾸지 않는다.** `description`, `detailHtml`은 그대로 읽히고 그대로 넘어온다.
   §2-1의 (1)이 통째로 남는다.
3. **지연 로딩 프록시.** 엔티티를 손에 들고 있으면 그 안의 LAZY 연관은 여전히
   **살아 있는 뇌관**이다. 오늘의 변환 코드가 `getCategory()`를 안 부르더라도,
   내일 누군가 "카테고리명도 보여주자"며 한 줄 추가하면 그 자리에서 N+1이 생긴다.
   **DTO 프로젝션은 이 뇌관 자체를 제거한다** — 반환 타입에 프록시가 없으므로
   실수할 표면이 없다.

**결론: `readOnly`는 대체가 아니라 병행 수단이다.** 그리고 실무에서는 조회 전용
메서드에 **어차피 붙인다** — 스냅샷 절감만이 이유가 아니라, `readOnly` 플래그가
**읽기 전용 replica로 라우팅하는 스위치**로 쓰이기 때문이다(`LazyConnectionDataSourceProxy` +
`AbstractRoutingDataSource` 조합). 그래서 답변은 이렇게 정리한다 —
**"readOnly는 붙인다. 그리고 DTO 프로젝션도 한다. 둘은 서로 다른 비용을 지운다."**

### 2-3. B — 조회 자체를 DTO로

```java
// B. 조회 시점부터 DTO. 목적이 "표시"임을 쿼리가 알고 있다.
@Transactional(readOnly = true)
public Page<ProductListDto> findProducts(Pageable pageable) {
    return productQueryRepository.findListPage(pageable);
}
```

```java
// QueryDSL 구현 — 상세는 §3-2
List<ProductListDto> content = queryFactory
        .select(new QProductListDto(
                product.id, product.name, product.price,
                product.thumbnailUrl, category.name))
        .from(product)
        .join(product.category, category)      // 조인 한 번, 추가 쿼리 없음
        .where(product.status.eq(ProductStatus.ON_SALE))
        .offset(pageable.getOffset())
        .limit(pageable.getPageSize())
        .fetch();
```

```sql
-- 나가는 SQL. SELECT 절에 화면이 쓰는 것만 있다. 쿼리 1회.
select p.id, p.name, p.price, p.thumbnail_url, c.name
  from product p
  join category c on c.id = p.category_id
 where p.status = 'ON_SALE'
 limit 20;
```

일어나는 일은 **일어나지 않는 일의 목록**으로 설명하는 편이 정확하다.

- `description`·`detailHtml`을 **읽지 않는다.**
- 영속성 컨텍스트에 **아무것도 적재되지 않는다**(DTO는 영속 객체가 아니다).
- 스냅샷도, 커밋 시점 비교도 **없다.**
- 반환 객체 안에 **프록시가 없다** → 미래의 N+1 표면이 없다.
- 카테고리명은 조인으로 함께 오므로 **`1 + N`이 `1`이 된다.**

### 2-4. 세 방식 대칭 비교

| | A (엔티티→변환) | A + `readOnly` | B (DTO 프로젝션) |
|---|---|---|---|
| SELECT 절 | 매핑 컬럼 전부 | **전부 (동일)** | 필요한 컬럼만 |
| 대형 TEXT 전송 | 발생 | **발생** | 없음 |
| 1차 캐시 적재 | 적재 | **적재** | 없음 |
| 스냅샷 메모리 | 엔티티 2배 | 1배 | 없음 |
| 커밋 시 변경 감지 | 돈다 | 안 돈다 | 없음 |
| LAZY 프록시 | 남음 | **남음** | 없음 |
| 연관 조회 | N+1 위험 | **N+1 위험** | 조인 1회 |
| 변경 감지로 수정 | 가능 | 불가(읽기 전용) | 불가 |

`readOnly` 열에서 **굵게 표시된 다섯 항목이 그대로 남는다**는 것이 §2-2의 결론이다.
이 표를 머릿속에 두면 "readOnly로 충분하지 않나요?"에 즉답할 수 있다.

### 2-5. 그런데 A가 옳은 경우도 있다 (양면으로 말하기)

**목적이 변경이면 A가 정답이다.** 아니, A만 가능하다.

```java
// 가격 인상 — 이 조회의 목적은 "변경"이다. DTO로 가져오면 아무것도 못 한다.
@Transactional
public void raisePrice(Long productId, BigDecimal rate) {
    Product product = productRepository.findById(productId).orElseThrow();
    product.raisePrice(rate);      // 변경 감지가 UPDATE를 만들어 준다
}
```

여기서 DTO 프로젝션을 쓰면 **영속 객체가 아니므로 값을 바꿔도 DB에 반영되지 않는다.**
지금 우리가 "비용"이라고 부른 스냅샷과 1차 캐시가 바로 **이 기능의 대가**다.
그래서 최종 판단 기준은 하나의 문장으로 압축된다.

> **"이 조회의 목적이 변경이면 엔티티, 표시면 DTO."**

이 한 문장이 12장 CQRS(명령과 조회의 모델을 분리한다)의 출발점이다. 별도 저장소나
이벤트 소싱까지 가지 않아도, **같은 테이블 위에서 쓰기 모델(엔티티)과 읽기 모델(DTO)을
분리하는 것**만으로 CQRS의 실익 절반은 이미 얻는다.

---

## 3. 구현 4종과 선택 기준

### 3-1. JPQL 생성자 표현식 — `select new`

```java
public interface ProductRepository extends JpaRepository<Product, Long> {

    // 패키지 전체 경로를 문자열로 써야 한다. 클래스를 옮기면 컴파일은 통과하고 런타임에 깨진다.
    @Query("""
            select new com.example.product.dto.ProductListDto(
                p.id, p.name, p.price, p.thumbnailUrl, c.name)
            from Product p join p.category c
            where p.status = :status
            """)
    List<ProductListDto> findList(@Param("status") ProductStatus status);
}
```

- **장점**: 표준 JPA만으로 되고, 추가 의존성이 없다.
- **단점 세 가지**:
  - **패키지 전체 경로가 문자열로 박힌다** — 리팩터링에 취약하다(IDE가 문자열 안의
    클래스 이동을 따라가 주기도 하지만 보장은 아니다).
  - **생성자만 가능**하다. 이름 기반 매핑이 없으므로 §4의 순서 교체 함정에 그대로 노출된다.
  - **동적 조건을 붙이기 어렵다** — 조건 조합이 늘면 문자열 결합으로 돌아가야 한다.

### 3-2. QueryDSL — `Projections` 3종 + `@QueryProjection`

QueryDSL은 **매핑 방식이 네 가지**라서 이 문항의 중심이다.

```java
// (1) constructor — 생성자 파라미터에 순서대로 꽂는다
Projections.constructor(ProductListDto.class,
        product.id, product.name, product.price, product.thumbnailUrl, category.name)

// (2) fields — 필드 이름으로 꽂는다 (리플렉션으로 필드에 직접 대입, setter 불필요)
Projections.fields(ProductListDto.class,
        product.id, product.name, product.price, product.thumbnailUrl,
        category.name.as("categoryName"))   // ← 이름이 다르면 별칭으로 맞춘다

// (3) bean — setter 이름으로 꽂는다 (기본 생성자 + setter 필요)
Projections.bean(ProductListDto.class, ...)

// (4) @QueryProjection — DTO 생성자에 애노테이션을 붙여 Q타입을 생성
new QProductListDto(product.id, product.name, product.price,
        product.thumbnailUrl, category.name)
```

```java
public class ProductListDto {
    private final Long id;
    private final String name;
    private final BigDecimal price;
    private final String thumbnailUrl;
    private final String categoryName;

    @QueryProjection   // 애노테이션 프로세서가 QProductListDto를 생성한다
    public ProductListDto(Long id, String name, BigDecimal price,
                          String thumbnailUrl, String categoryName) { ... }
}
```

**`@QueryProjection`의 이점과 대가를 함께 말해야 한다.**

- **이점**: 생성자 시그니처가 **컴파일 타임에 검증된다.** 파라미터 개수를 틀리거나
  `Long`이 갈 자리에 `String`을 넣으면 **빌드가 깨진다.** `Projections.constructor`는
  이걸 런타임까지 미룬다.
- **대가**: DTO 클래스가 **QueryDSL에 컴파일 의존**하게 된다. DTO를 API 응답 타입으로
  쓰면서 웹 모듈에 두는 구조라면, 웹 모듈이 QueryDSL을 알아야 한다는 뜻이다.
  멀티 모듈에서 이걸 피하려고 `Projections.constructor`를 택하는 팀도 있다 —
  **의존 방향을 지키려고 컴파일 안전성을 포기하는 트레이드오프**다.
- **한계**: **같은 타입끼리의 순서 교체는 못 잡는다.** §4-2가 이 이야기 전부다.

### 3-3. Spring Data 인터페이스 프로젝션 — 이름 기반, 코드가 가장 짧다

```java
// 인터페이스만 선언하면 끝. 구현체는 Spring Data가 프록시로 만든다.
public interface ProductListView {
    Long getId();
    String getName();
    BigDecimal getPrice();
    String getThumbnailUrl();
}

public interface ProductRepository extends JpaRepository<Product, Long> {
    // 반환 타입만 바꾸면 SELECT 절이 게터 목록으로 줄어든다
    Page<ProductListView> findByStatus(ProductStatus status, Pageable pageable);
}
```

```sql
-- 실제로 나가는 SQL. description, detail_html이 없다.
select p.id, p.name, p.price, p.thumbnail_url
  from product p
 where p.status = ?
 limit 20;
```

- **이름 기반**이라 §4의 순서 교체 함정 자체가 성립하지 않는다.
- **필요한 컬럼만** SELECT한다.
- **중첩 프로젝션**도 된다 — 연관 엔티티를 다시 인터페이스로 받는다.

```java
public interface ProductListView {
    String getName();
    CategoryView getCategory();          // 중첩

    interface CategoryView {
        String getName();
    }
}
```

**(가산점 포인트) 닫힌 프로젝션과 열린 프로젝션의 결정적 차이**

```java
// 닫힌(closed) 프로젝션 — 게터가 엔티티 속성과 1:1로 대응한다.
//   → Spring Data가 필요한 컬럼만 SELECT할 수 있다. 최적화가 걸린다.
public interface ProductListView {
    String getName();
    BigDecimal getPrice();
}

// 열린(open) 프로젝션 — @Value에 SpEL을 써서 계산한다.
//   → 어떤 속성이 필요한지 정적으로 알 수 없으므로 루트 엔티티를 전부 로드한 뒤 계산한다.
//     "인터페이스 프로젝션을 썼는데 왜 description까지 읽히나"의 답이 여기 있다.
public interface ProductListView {
    String getName();

    @Value("#{target.price * 1.1}")      // ← 이 한 줄이 컬럼 최적화를 무력화한다
    BigDecimal getPriceWithTax();
}
```

**부가세 계산 같은 사소한 편의 하나가 이 문항의 1층 이점을 통째로 날린다.**
계산은 프로젝션이 아니라 DTO나 화면 계층에서 하는 편이 안전하다. 이걸 아는지가
"인터페이스 프로젝션을 써봤다"와 "왜 그렇게 동작하는지 안다"를 가른다.

**단점**: 인터페이스가 늘어나고, 게터 목록만으로는 표현하기 어려운 집계·조건부
프로젝션에는 부적합하다. 동적 조건이 붙으면 메서드 이름이 폭발한다.

### 3-4. 네이티브 쿼리 + `@SqlResultSetMapping` — 마지막 수단

```java
@SqlResultSetMapping(
    name = "ProductListMapping",
    classes = @ConstructorResult(
        targetClass = ProductListDto.class,
        columns = {
            @ColumnResult(name = "id", type = Long.class),
            @ColumnResult(name = "name", type = String.class),
            @ColumnResult(name = "price", type = BigDecimal.class)
        }))
@Entity
public class Product { ... }
```

- **쓰는 이유**: 윈도 함수, 벤더 전용 힌트, 재귀 CTE 등 **JPQL·QueryDSL로 표현할 수
  없는 SQL**이 필요할 때.
- **대가**: 벤더 종속이 생기고, 컬럼명이 문자열이며, 애노테이션이 엔티티 클래스에
  얹혀 지저분해진다. 그리고 **네이티브 쿼리는 실행 직전 auto-flush를 유발**하므로
  같은 트랜잭션의 쓰기 지연 SQL이 예상치 못한 시점에 나갈 수 있다
  ([flush 시점과 SQL 실행 순서](flush-timing-and-sql-ordering.md)).

### 3-5. 선택 기준 — 두 축으로 자른다

```
단순 조회 (조건 고정, 컬럼만 골라 담기)
    → Spring Data 인터페이스 프로젝션   (코드 최소, 이름 기반이라 안전)

복잡한 동적 조건 · 집계 · 여러 테이블 조합
    → QueryDSL + @QueryProjection      (타입 안전 + 조건 합성)

표준 JPA만 쓸 수 있는 환경, 조건 고정
    → JPQL select new

JPQL로 표현 불가능한 SQL
    → 네이티브 + @SqlResultSetMapping   (마지막 수단)
```

면접에서는 이렇게 한 문장으로 말한다 —
**"단순 조회는 인터페이스 프로젝션으로 짧게 끝내고, 검색 조건이 조합되거나 집계가
들어가면 QueryDSL로 갑니다. 조건 조합은 `BooleanExpression` 메서드로 쪼개
`where(...)`에 나열하면 `if` 없이 합성됩니다."**

> 동적 조건 조합의 상세는 [QueryDSL 동적 쿼리](querydsl-dynamic-query-composition.md)에
> 있다. 페이징 count 쿼리 최적화도 그 문서에 정리돼 있다.

---

## 4. 순서 교체 함정 — 도구가 **못** 막는 것까지 안다

이 절이 시니어 변별 지점이다. 도구의 효능만 아는 사람과 **효능의 경계**를 아는 사람이
여기서 갈린다.

### 4-1. `Projections.constructor` — 값이 뒤바뀐 채 조용히 통과한다

```java
// before — 정상
public class ProductListDto {
    public ProductListDto(Long id, String name, String thumbnailUrl) { ... }
}

Projections.constructor(ProductListDto.class,
        product.id, product.name, product.thumbnailUrl)
```

```java
// after — 누군가 DTO 생성자의 파라미터 순서를 바꿨다 (코드 정리, 필드 재배치 등)
public class ProductListDto {
    public ProductListDto(Long id, String thumbnailUrl, String name) { ... }
    //                             ^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^ 순서 교체
}

// 쿼리 쪽은 아무도 안 고쳤다.
Projections.constructor(ProductListDto.class,
        product.id, product.name, product.thumbnailUrl)
// ❌ 컴파일 통과. 실행 통과. 예외 없음.
//    name 자리에 썸네일 URL이, thumbnailUrl 자리에 상품명이 들어간다.
//    화면에서 이미지가 안 나오고 상품명 칸에 "/img/p1.jpg"가 찍힌다.
```

**왜 통과하는가**: `Projections.constructor`는 `Class<?>`와 `Expression<?>...`을 받아
**런타임에 리플렉션으로 타입이 맞는 생성자를 찾는다.** `(Long, String, String)`을
찾으면 되므로, 두 `String`이 서로 바뀐 것은 **구별할 방법이 없다.**

이것이 이 함정의 성질을 규정한다 — **예외가 안 난다.** 예외가 나면 배포 전에 잡히지만,
값이 바뀐 채 성공하면 **데이터가 잘못 표시된 상태로 운영에 나간다.** 조용한 실패가
더 나쁘다.

### 4-2. `@QueryProjection` — 개수·타입은 잡는다. 순서는 못 잡는다

```java
public class ProductListDto {
    @QueryProjection
    public ProductListDto(Long id, String name, String thumbnailUrl) { ... }
}

// 생성된 Q타입을 쓴다
new QProductListDto(product.id, product.name, product.thumbnailUrl)
```

**잡아주는 것 두 개**

```java
// (a) 파라미터 개수 오류 → 컴파일 에러
new QProductListDto(product.id, product.name);
// ❌ 컴파일 실패: constructor QProductListDto cannot be applied to given types

// (b) 타입 불일치 → 컴파일 에러
new QProductListDto(product.name, product.id, product.thumbnailUrl);
// ❌ 컴파일 실패: StringPath는 NumberExpression<Long> 자리에 들어갈 수 없다
```

**못 잡는 것 — 같은 타입끼리의 순서 교체**

```java
// 누군가 생성자 순서를 바꿨다
@QueryProjection
public ProductListDto(Long id, String thumbnailUrl, String name) { ... }
//                             ^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^ 교체

// 재생성된 Q타입의 생성자 시그니처는? — 여전히 (Long, String, String)이다.
new QProductListDto(product.id, product.name, product.thumbnailUrl);
// ❌ 컴파일 통과. constructor 방식과 결과가 똑같다.
//    컴파일러가 보는 것은 "타입의 나열"이고, 그건 하나도 바뀌지 않았다.
```

**핵심 문장**: **`@QueryProjection`이 옮기는 검증 시점은 "생성자의 존재와 시그니처"까지다.
같은 타입 파라미터들의 의미가 뒤바뀐 것은 타입 시스템의 사정거리 밖이다.**

면접에서 "`@QueryProjection`을 쓰면 컴파일 시점에 잡힙니다"까지만 말하면 절반이다.
**"단, 같은 타입끼리 순서가 바뀌는 경우는 시그니처가 그대로라 못 잡습니다"** 를 붙이는
것이 변별점이다.

### 4-3. 이름 기반 매핑 — 순서가 변수 자체가 아니다

```java
// after — 이름으로 꽂으므로 생성자·필드 순서를 어떻게 바꿔도 무관하다
Projections.fields(ProductListDto.class,
        product.id,
        product.name,                              // 필드명 name과 일치
        product.thumbnailUrl)                      // 필드명 thumbnailUrl과 일치
// ✅ DTO의 필드 선언 순서가 뒤바뀌어도 값은 제자리에 들어간다.
//    순서라는 개념이 매핑에 존재하지 않는다.
```

```java
// 표현식 이름이 필드명과 다를 때만 별칭으로 맞춘다 — 이때 별칭이 새로운 실수 지점이 된다
Projections.fields(ProductListDto.class,
        product.id,
        product.name,
        category.name.as("categoryName"))   // 별칭을 빼면 name에 카테고리명이 덮인다
```

```java
// 가장 강한 형태 — Spring Data 인터페이스 프로젝션
public interface ProductListView {
    String getName();          // 게터 이름 = 속성 이름. 순서라는 축이 아예 없다.
    String getThumbnailUrl();
}
```

**세 방식을 한 줄로 정리하면 이렇다.**

| 방식 | 잡는 것 | 못 잡는 것 |
|---|---|---|
| `Projections.constructor` | 없음(런타임 생성자 탐색) | 개수·타입·순서 전부 |
| `@QueryProjection` | 파라미터 개수, 타입 | **동일 타입 순서 교체** |
| 이름 기반(`fields`/`bean`/인터페이스) | 순서 교체 | 이름 오타·별칭 누락 |

**어느 것도 완전하지 않다.** 그래서 마지막 안전망은 도구가 아니라 §6의 테스트다.
"완전한 도구는 없으므로 결과를 테스트로 고정한다"까지 말하는 것이 이 절의 결론이다.

### 4-4. 실무 사례 — 순서 교체가 조용히 배포된 경로

실제로 나는 이 유형을 이런 흐름으로 만난다.

1. 상품 목록 DTO에 필드가 6개 있고 그중 4개가 `String`이다
   (`name`, `thumbnailUrl`, `categoryName`, `brandName`).
2. 스프린트 중 코드 스타일 정리 PR에서 **필드를 "성격별로" 재배치**한다 —
   이름 관련 필드끼리 모으는 식의 지극히 선의의 리팩터링.
3. 생성자도 같이 재배치된다. 리뷰어는 필드 순서 변경을 위험으로 보지 않는다.
   **쿼리 파일은 이 PR의 diff에 등장하지 않는다.**
4. 테스트가 있지만 `assertThat(result).hasSize(20)` 수준이라 통과한다.
5. 배포 후 QA가 "브랜드명 칸에 카테고리명이 나온다"고 제보한다.

**막을 수 있었던 지점은 3번이 아니라 4번이다.** 사람에게 "필드 순서를 바꾸지 마세요"를
요구하는 것은 대책이 아니다. **값의 내용을 검증하는 테스트 한 줄**이 대책이다.

```java
// 이 한 줄이 위 시나리오를 4번에서 끊는다
assertThat(result.get(0).getThumbnailUrl()).startsWith("https://cdn.");
assertThat(result.get(0).getName()).isEqualTo("무선 이어폰");
```

---

## 5. DTO 프로젝션이 포기하는 것

**"장점만 말하고 멈추면 감점"** 이 이 문항의 채점 방식이다. 얻는 것을 말한 만큼
포기하는 것도 같은 호흡에 말한다.

### 5-1. 1:N 컬렉션을 조인해 담으면 행이 중복된다

목록에 옵션명까지 보여달라는 요구가 붙었다고 하자.

```java
// ❌ 컬렉션을 조인해서 DTO 하나에 담으려는 시도
queryFactory
        .select(new QProductListDto(
                product.id, product.name, option.name))   // option은 1:N
        .from(product)
        .join(product.options, option)
        .limit(20)
        .fetch();
```

```sql
-- 조인 결과는 "상품 × 옵션" 카티전 곱에 가깝다
select p.id, p.name, o.name from product p join product_option o on o.product_id = p.id limit 20;

-- id | name        | option
--  1 | 무선 이어폰  | 화이트
--  1 | 무선 이어폰  | 블랙       ← 같은 상품이 옵션 수만큼 반복
--  1 | 무선 이어폰  | 로즈골드
--  2 | 블루투스 키보드 | 영문
-- ...
```

**두 가지가 동시에 깨진다.**

- **DTO 하나로 안 떨어진다.** `List<ProductListDto>`의 원소 수가 상품 수가 아니라
  행 수다. 상품 하나가 여러 개로 보인다.
- **`limit 20`이 상품 20건을 의미하지 않는다.** DB는 조인 결과 행을 20개 자르므로
  **상품 7개만 실려 올 수도 있다.** 이게 **DTO 프로젝션 버전의 페이징 붕괴**이며,
  [fetch join + 페이징](fetch-join-pagination-in-memory.md)에서 본 것과 **정확히 같은
  구조의 문제**다. 다만 증상은 다르다 — fetch join은 `HHH000104` 경고를 내며 메모리에서
  자르지만, **DTO 프로젝션은 경고조차 없이 그냥 잘못된 개수를 돌려준다.**

`distinct`도 답이 아니다. 옵션명이 다르면 행이 진짜로 서로 달라서 중복 제거 대상이 아니다.

### 5-2. 처방 — 루트 페이징 + `in` 절 2차 쿼리 + 애플리케이션 그룹핑

```java
@Transactional(readOnly = true)
public Page<ProductListDto> findListPage(Pageable pageable) {

    // (1) 루트만 페이징 조회 — 컬렉션 조인 없음. limit 20 = 상품 20건이 보장된다.
    List<ProductListDto> content = queryFactory
            .select(new QProductListDto(
                    product.id, product.name, product.price,
                    product.thumbnailUrl, category.name))
            .from(product)
            .join(product.category, category)        // ToOne 조인은 행이 늘지 않아 안전
            .where(product.status.eq(ProductStatus.ON_SALE))
            .offset(pageable.getOffset())
            .limit(pageable.getPageSize())
            .fetch();

    // (2) 방금 가져온 20개의 id로 자식을 한 번에 조회 — in 절 쿼리 1회
    List<Long> productIds = content.stream().map(ProductListDto::id).toList();

    Map<Long, List<String>> optionNames = queryFactory
            .select(option.product.id, option.name)
            .from(option)
            .where(option.product.id.in(productIds))
            .fetch()
            .stream()
            .collect(groupingBy(
                    t -> t.get(option.product.id),
                    mapping(t -> t.get(option.name), toList())));

    // (3) 애플리케이션에서 조립
    //     setter로 채우지 않고 새 인스턴스를 만든다 — DTO를 불변으로 유지하는 이유는 §5-3
    content = content.stream()
            .map(dto -> dto.withOptionNames(
                    optionNames.getOrDefault(dto.id(), List.of())))
            .toList();

    // count 쿼리는 필요할 때만 (PageableExecutionUtils)
    JPAQuery<Long> countQuery = queryFactory
            .select(product.count()).from(product)
            .where(product.status.eq(ProductStatus.ON_SALE));

    return PageableExecutionUtils.getPage(content, pageable, countQuery::fetchOne);
}
```

**쿼리 수는 `1 + 1`로 고정된다** — 상품이 20건이든 100건이든 자식 쿼리는 1회다.
이 구조를 어디서 봤는가? **`default_batch_fetch_size`가 하는 일과 정확히 같다.**
Hibernate는 LAZY 컬렉션을 `in (…)`으로 묶어 `1 + ceil(N/size)`로 줄인다. 여기서는
그 묶음을 **내가 손으로 만든 것**이다.

그래서 답변에 이 문장을 붙이면 좋다 —
**"컬렉션은 조인으로 한 번에 담지 않고, 루트를 페이징한 뒤 id 목록으로 `in` 절 한 번을
더 나가서 애플리케이션에서 묶습니다. `default_batch_fetch_size`가 자동으로 해주는 것과
같은 구조를 DTO 세계에서 손으로 하는 겁니다."**

**(가산점 포인트) 언제 이 수고를 하지 않는가**: 컬렉션 개수가 작고 상한이 확실하면
(예: 옵션이 상품당 최대 3개) 루트에 `group_concat`/`string_agg` 같은 집계 함수로
한 컬럼에 밀어 넣는 방법도 있다. 대가는 **벤더 종속과 길이 제한**이며,
목록 화면에서 "대표 옵션 3개만"처럼 상한이 요구사항에 이미 있을 때만 정당하다.

### 5-3. 반환 DTO는 영속 객체가 아니다 — 변경 감지가 안 된다

```java
// ❌ DTO를 고쳐도 DB에는 아무 일도 일어나지 않는다. 예외조차 없다.
@Transactional
public void discount(Long productId) {
    ProductListDto dto = productQueryRepository.findOne(productId);
    dto.setPrice(dto.getPrice().multiply(new BigDecimal("0.9")));
    // 커밋. UPDATE 없음. 로그에도 아무것도 없다.
}
```

```java
// ✅ 변경이 목적이면 엔티티로 가져온다
@Transactional
public void discount(Long productId) {
    Product product = productRepository.findById(productId).orElseThrow();
    product.discount(new BigDecimal("0.9"));   // 변경 감지 → UPDATE
}
```

**여기서 §2-5의 판단 기준이 반복된다.** 스냅샷과 1차 캐시는 낭비가 아니라
**변경 감지라는 기능의 대가**다. 조회 화면에서는 그 기능을 안 쓰므로 대가만 남고,
수정 로직에서는 그 기능이 전부다.

실무 대비로 하나 더 — **DTO는 setter 없는 불변 객체로 만드는 편이 안전하다.**
setter가 있으면 위 코드가 "될 것 같아 보여서" 실제로 작성된다. 필드를 `final`로 두고
생성자로만 채우면 그 실수의 표면이 사라진다.

### 5-4. 화면 수만큼 DTO 클래스가 늘어난다

목록, 상세, 관리자 목록, 엑셀 다운로드, 검색 결과, 추천 위젯… 화면마다 필요한 컬럼이
다르면 DTO도 갈라진다. **"클래스가 너무 많다"는 불만은 정당한 비용 지적이다.**

그렇다고 큰 DTO 하나로 합치면 이 문항의 1층 이점이 사라진다 — 필드를 다 채우려면
컬럼을 다 읽어야 하고, 그러면 엔티티와 다를 게 없다. **"필드를 null로 두고 안 쓰는
화면은 무시한다"는 절충이 최악**이다. 어느 필드가 채워졌는지 코드로 알 수 없어져서
NPE와 오표시가 늘어난다.

현실적인 관리 방법은 이렇다.

- **패키지를 화면 단위로 나눈다** — `product.query.list`, `product.query.detail`.
  클래스 수가 많아도 찾는 비용이 늘지 않는다.
- **DTO는 쿼리 코드 옆에 둔다.** 화면 요구가 바뀌면 쿼리와 DTO를 같이 고치게 되므로
  변경이 한 디렉터리에서 끝난다.
- **공통 조각은 상속이 아니라 컴포지션으로.** `PriceView` 같은 작은 값 묶음을 필드로
  품는다. 상속으로 필드를 물려받으면 안 쓰는 필드가 다시 따라온다.
- **레코드를 쓴다** — 보일러플레이트가 줄어들면 클래스 수에 대한 체감 부담이 크게 줄고,
  불변이라 §5-3의 실수 표면도 사라진다.

```java
public record ProductListDto(Long id, String name, BigDecimal price,
                             String thumbnailUrl, String categoryName) {}
```

---

## 6. 관측·검증 — 눈으로 보고, 테스트로 고정한다

이 절이 없으면 앞의 모든 이야기가 "그럴 것이다"로 남는다. **프로젝션은 눈으로
확인하기 전까지 최적화가 아니다.**

### 6-1. 지금 나가는 SQL의 SELECT 절을 확인하는 절차

```yaml
# 개발 프로파일에만
spring:
  jpa:
    properties:
      hibernate:
        format_sql: true
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE   # 바인딩 값까지
```

`show-sql: true`는 표준 출력으로 직접 뿌리므로 로깅 프레임워크를 우회한다.
**로거 레벨로 켜는 편이 낫다.**

그 위에 **`p6spy`(또는 `datasource-proxy`)** 를 얹으면 **바인딩 값이 채워진 완성된
SQL 한 줄**과 실행 시간을 볼 수 있다. 이 문항에서는 특히 유용하다 — SELECT 절에
`description`이 있는지 없는지가 **한눈에 보이는 것**이 목적이기 때문이다.

**확인 체크리스트 (실제로 이 순서로 본다)**

1. SELECT 절에 **화면이 안 쓰는 컬럼이 있는지.** 있으면 프로젝션이 안 걸린 것이다
   (열린 프로젝션이거나, 반환 타입이 엔티티이거나).
2. 쿼리가 **몇 번 나가는지.** 목록 조회에서 같은 형태의 SELECT가 반복되면 N+1이다.
3. `limit`이 **붙어 있는지.** 없으면 페이징이 메모리에서 처리되고 있다.
4. `HHH000104` 경고가 있는지(fetch join + 페이징 신호).

### 6-2. 회귀는 사람이 아니라 테스트가 막는다

세 층으로 고정한다.

**(1) 쿼리 수 단정**

```java
@Test
void 상품목록은_쿼리_두_번만_나간다() {
    SQLStatementCountValidator.reset();

    productQueryService.findListPage(PageRequest.of(0, 20));

    // 루트 1회 + 옵션 in 절 1회. N+1이 생기면 여기서 깨진다.
    SQLStatementCountValidator.assertSelectCount(2);
}
```

**(2) 영속성 컨텍스트에 아무것도 안 올라왔는지 단정 — 이 문항 전용 안전망**

```java
@Test
void DTO_프로젝션은_엔티티를_적재하지_않는다() {
    Statistics stats = entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
    stats.clear();

    productQueryService.findListPage(PageRequest.of(0, 20));

    // 누군가 "간편하게" 엔티티 조회 + 변환으로 되돌리면 이 단정이 깨진다.
    assertThat(stats.getEntityLoadCount()).isZero();
}
```

이 테스트가 특히 값지다. **§2의 A/B 구분을 코드로 못 박는 유일한 방법**이기 때문이다.
"DTO로 조회한다"는 규약은 리뷰에서 지키기 어렵지만, `entityLoadCount == 0`은
누구도 우회할 수 없다.

**(3) 값의 내용을 단정 — §4의 순서 교체 대비**

```java
@Test
void 목록_DTO의_각_필드가_제자리에_들어간다() {
    var dto = productQueryService.findListPage(PageRequest.of(0, 20)).getContent().get(0);

    // 타입이 같은 필드들을 서로 구별되는 값으로 단정한다 — 순서 교체가 여기서 잡힌다
    assertThat(dto.name()).isEqualTo("무선 이어폰");
    assertThat(dto.thumbnailUrl()).startsWith("https://cdn.");
    assertThat(dto.categoryName()).isEqualTo("음향기기");
}
```

**픽스처 설계가 곧 테스트의 감도다.** 모든 문자열 필드에 `"test"`를 넣으면
순서가 뒤바뀌어도 통과한다. **같은 타입 필드끼리는 서로 절대 헷갈리지 않는 값**을
넣는다 — 이것이 이 유형의 회귀를 잡는 실질적 조건이다.

**(4) 조회 컬럼 자체를 단정 (가산점 포인트)**

`datasource-proxy`의 리스너로 실행된 SQL 문자열을 수집하면 이런 단정도 가능하다.

```java
assertThat(capturedSql).doesNotContain("detail_html");
```

과하다고 느껴질 수 있지만, **"대형 컬럼을 목록 쿼리에서 절대 읽지 않는다"가 성능
요구사항인 화면**이라면 이 한 줄이 그 요구사항의 유일한 문서이자 집행 장치다.

> 이 도구 상자는 3장 전체에서 반복된다 —
> [N+1 탐지와 해결](n-plus-one-detection-and-fixes.md)의 쿼리 수 단정,
> [fetch join + 페이징](fetch-join-pagination-in-memory.md)의 경고 승격,
> [영속성 컨텍스트](persistence-context-dirty-checking.md)의 Statistics 활용.
> 결론은 하나다 — **"조심하겠다"는 대책이 아니다.**

---

## 7. 꼬리질문 대비 포인트

### "`@Transactional(readOnly = true)`를 걸면 스냅샷도 안 만들고 변경 감지도 안 하니, 엔티티로 조회해도 되지 않나요?"

**없어지는 것과 남는 것을 나눠서 답한다.**

없어지는 것은 정확히 두 개다 — **스냅샷 복사와 커밋 시점 변경 감지.**
남는 것은 세 개다.

1. **1차 캐시 적재** — 스냅샷을 안 만들어도 엔티티 인스턴스는 영속성 컨텍스트에
   들어가고 트랜잭션이 끝날 때까지 참조가 유지된다. 배치로 수천 건을 훑으면 그대로 쌓인다.
2. **`select *`** — `readOnly`는 SELECT 절을 바꾸지 않는다. `description`,
   `detail_html`은 그대로 읽히고 그대로 전송된다.
3. **지연 로딩 프록시** — 엔티티를 손에 들고 있으면 LAZY 연관이 살아 있는 뇌관으로
   남는다. 오늘은 안 건드려도 내일 누가 게터 한 줄을 추가하면 N+1이 생긴다.

그래서 결론은 **"대체가 아니라 병행"** 이다. 덧붙이면 좋은 한마디 —
**"조회 전용 메서드에는 `readOnly`를 어차피 붙입니다. 스냅샷 절감만이 이유가 아니라
읽기 replica로 라우팅하는 스위치로도 쓰이기 때문입니다."**
이 라우팅 축은 3장 고난이도 문항(읽기/쓰기 분리)으로 그대로 이어진다.

### "컬럼 몇 개 덜 읽는 게 그렇게 큰 차이인가요? 어차피 인덱스로 찾은 20건인데요."

**"항상 크다"고 답하면 오히려 감점이다. 커지는 조건을 말하는 게 답이다.**

차이가 **작은** 경우: 컬럼이 다 작고(수십 바이트), 건수가 적고, 호출 빈도도 낮으면
측정 가능한 차이가 안 난다. 이때는 코드가 짧은 쪽(A + readOnly)이 낫다.

차이가 **커지는 조건 네 가지**:

- **대형 컬럼이 있다** — `TEXT`/`BLOB`은 벤더에 따라 행 밖에 저장되어 추가 페이지
  접근을 유발한다. 20건 × 수십 KB는 목록 한 번에 수백 KB 전송이다.
- **호출 빈도가 높다** — 메인 진입 화면처럼 호출량을 지배하면 단건 차이 × 빈도가
  네트워크와 DB 버퍼에 그대로 누적된다.
- **커버링 인덱스가 가능해진다** — SELECT 절이 좁아지면 인덱스만 읽고 테이블 접근을
  생략할 수 있는 경우가 생긴다. 이건 "몇 %" 수준이 아니라 **접근 방식이 바뀌는** 차이다.
- **건수가 늘어난다** — 엑셀 다운로드, 배치 집계처럼 수만 건을 훑는 경로에서는
  1차 캐시 적재만으로도 힙이 위험해진다.

마무리 문장 — **"그래서 저는 '컬럼 수'로 판단하지 않고 **대형 컬럼 유무 × 호출
빈도**로 판단합니다. 그리고 판단이 애매하면 `p6spy`로 실제 SQL을 보고 응답 시간을
재서 결정합니다."** **측정 없이 최적화를 주장하지 않는 태도**가 이 답의 핵심이다.

### "`@QueryProjection`을 쓰면 컴파일 시점에 잡히니까 안전하지 않나요?" (시니어 변별 포인트)

**절반만 안전하다. 무엇을 잡고 무엇을 못 잡는지가 정확한 답이다.**

- **잡는 것**: 파라미터 **개수** 오류, **타입** 불일치. 둘 다 빌드를 깬다.
- **못 잡는 것**: **같은 타입끼리의 순서 교체.** `(Long, String, String)` 생성자에서
  두 `String`의 순서를 바꿔도 시그니처는 그대로이므로 컴파일러가 볼 것이 없다.
  결과는 `Projections.constructor`와 동일하게 **값이 바뀐 채 조용히 통과**한다.

**순서를 원천 차단하는 것은 이름 기반 매핑**이다 — `Projections.fields`/`bean`은
프로퍼티 이름으로 꽂으므로 순서가 매핑의 변수가 아니고, Spring Data 인터페이스
프로젝션은 게터 이름이 곧 속성이라 순서라는 축이 아예 없다.

**단, 이름 기반도 완전하지 않다** — 별칭 누락(`category.name`을
`.as("categoryName")` 없이 넘기면 `name` 필드에 카테고리명이 들어간다)과
필드명 오타는 여전히 런타임 문제다.

그래서 최종 답은 **"어느 도구도 완전하지 않으므로 결과를 테스트로 고정합니다.
같은 타입 필드들을 서로 헷갈리지 않는 값으로 픽스처를 만들고 필드별로 단정합니다"**
로 닫는다. **도구의 한계를 알고 그 자리에 안전망을 놓는 것**이 이 질문의 만점 답이다.

### "DTO 프로젝션을 쓰면 항상 이득인가요? 포기하는 게 뭔가요?" (시니어 변별 포인트)

**셋을 한 호흡에 말한다.**

1. **1:N 컬렉션을 담을 수 없다.** 조인하면 행이 상품 × 옵션으로 늘어나 DTO 하나로 안
   떨어지고, **`limit 20`이 상품 20건을 의미하지 않게 된다.** fetch join + 페이징과 같은
   구조의 문제지만 **경고조차 없다**는 점이 더 나쁘다. 처방은 **루트만 페이징하고
   자식은 id 목록으로 `in` 절 2차 쿼리 후 애플리케이션에서 그룹핑** —
   `default_batch_fetch_size`가 자동으로 해주는 일을 손으로 하는 것이다.
2. **변경 감지가 안 된다.** DTO는 영속 객체가 아니므로 값을 바꿔도 UPDATE가 나가지
   않고, **예외도 안 난다.** 수정 목적 조회에는 쓸 수 없다. 애초에 setter 없는 불변
   객체(레코드)로 만들어 그 실수 표면을 없애는 편이 낫다.
3. **화면 수만큼 DTO가 늘어난다.** 이건 실제 비용이다. 큰 DTO 하나로 합치면
   컬럼을 다 읽어야 해서 이 기법의 이점이 사라지고, 필드를 null로 비워두는 절충은
   최악이다(어느 필드가 유효한지 코드로 알 수 없어진다).

그리고 판단 기준으로 닫는다 — **"그래서 기준은 하나입니다. 이 조회의 목적이
변경이면 엔티티, 표시면 DTO. 스냅샷과 1차 캐시는 낭비가 아니라 변경 감지의 대가이고,
조회 화면은 그 기능을 안 쓰니까 대가만 남는 겁니다."**

### "인터페이스 프로젝션이 코드가 가장 짧다면 왜 QueryDSL을 쓰나요?"

**두 축으로 자른다 — 조건의 동적 여부, 그리고 표현력.**

인터페이스 프로젝션이 이기는 곳: 조건이 고정된 단순 조회. 인터페이스 하나와
반환 타입 변경으로 끝나고, 이름 기반이라 순서 함정도 없고, 중첩 프로젝션도 된다.

QueryDSL이 필요한 곳:

- **동적 조건** — 검색 필터가 조합되면 파생 쿼리 메서드 이름이 폭발한다.
  QueryDSL은 `BooleanExpression` 메서드로 쪼개 `where(nameEq(x), statusEq(y))`처럼
  나열하면 `null`이 조용히 무시되어 `if`가 사라진다.
- **집계·서브쿼리·`case when`** — 게터 목록으로는 표현할 수 없다.
- **count 쿼리 최적화** — `PageableExecutionUtils.getPage(...)`로 마지막 페이지에서
  count를 생략하거나, count 쿼리에서 join을 떼는 조정이 필요할 때.

그리고 **한 프로젝트에서 둘을 섞어 쓰는 게 정상**이다. "하나로 통일"이 목표가 아니라
**단순한 곳은 짧게, 복잡한 곳은 통제 가능하게**가 목표다.

### "그럼 조회 전용 코드는 어디에 두시나요?" (설계 판단 · 가산점 포인트)

**쓰기와 읽기를 같은 클래스에 두지 않는다.** 실무 구조는 보통 이렇게 간다.

- `ProductRepository` — `JpaRepository`. **쓰기와 단건 조회(변경 목적)용.**
  엔티티를 반환한다.
- `ProductQueryRepository` — QueryDSL 구현. **표시 목적 조회 전용.** DTO만 반환한다.
- 서비스도 `ProductService`(명령)와 `ProductQueryService`(조회)로 가른다.

이렇게 가르는 실익은 코드 정리가 아니라 **규칙을 파일 단위로 강제할 수 있다는 것**이다.
`ProductQueryRepository`의 모든 메서드가 DTO를 반환한다는 규약은 ArchUnit 룰로
검사할 수 있고, `@Transactional(readOnly = true)`를 클래스 단위로 걸 수 있고,
읽기 replica 라우팅도 이 경계에서 갈린다.

이것이 **CQRS의 가장 값싼 형태**다 — 저장소를 두 개로 나누거나 이벤트 소싱을
도입하지 않고, **같은 테이블 위에서 모델만 두 개로 가르는 것.** 여기까지만 해도
"조회 성능을 조회 쪽에서만 최적화할 수 있게 되는" 이점을 얻는다.
읽기 모델을 별도 저장소로 물리 분리하는 판단은 그 다음 단계이고,
**정합성 지연(eventual consistency)을 화면이 감당할 수 있느냐**가 그때의 기준이다.

---

## 한 줄 요약

**조회 전용 화면에 DTO 프로젝션을 쓰는 이유는 결합도가 아니라 조회 비용이다 —
엔티티 조회는 목록에 안 쓰는 `description`·`detail_html`까지 읽어 전송하고(1층),
1차 캐시에 적재하며 변경 감지용 스냅샷으로 메모리를 두 배 쓰고 커밋마다 전 필드를
비교한다(2층). `@Transactional(readOnly = true)`는 스냅샷과 변경 감지만 없애고
**1차 캐시 적재·불필요 컬럼 전송·지연 로딩 프록시는 남기므로 대체가 아니라 병행
수단**이다. 구현은 JPQL `select new`, QueryDSL `Projections`/`@QueryProjection`,
Spring Data 인터페이스 프로젝션, 네이티브+`@SqlResultSetMapping` 네 가지이며
단순 조회는 인터페이스 프로젝션, 동적 조건·집계는 QueryDSL이다. **`@QueryProjection`은
파라미터 개수와 타입만 잡고 동일 타입 순서 교체는 못 잡으므로** 순서를 없애려면
이름 기반 매핑을, 그마저 못 잡는 것은 필드별 값 단정 테스트로 막는다. 대신 포기하는
것도 함께 말한다 — **1:N 조인 시 행 중복(루트 페이징 + `in` 절 2차 쿼리 + 그룹핑으로
처방), 변경 감지 불가, DTO 클래스 증식.** 기준은 한 문장이다 — **"변경이 목적이면
엔티티, 표시가 목적이면 DTO."**
