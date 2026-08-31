# N+1 문제 — N의 정체, 해결책 선택 기준, 그리고 사람에 의존하지 않는 탐지 장치

> 핵심 관전 포인트: 정의("목록을 조회했더니 각 행의 연관을 채우느라 쿼리가 더 나간다")는 출발점일 뿐이다. 실제로 갈리는 건 세 가지다. ① **N의 정체** — 추가 SELECT는 "결과 행 수"만큼이 아니라 **아직 1차 캐시에 없는 서로 다른 연관 id 수**만큼 나간다. 그래서 회원 1명에게 주문 1,000건을 붙인 픽스처로는 `1 + 1`로 끝나 **재현이 안 된다.** 테스트 픽스처는 건수가 아니라 **카디널리티**로 설계해야 하고, 측정 직전에 컨텍스트를 비워야 한다. ② **해결책 선택 기준** — 도구 이름 4개를 외우는 게 아니라 축 하나로 정리된다. **조인 계열**(`fetch join`, `@EntityGraph`)은 쿼리 1개지만 **행이 뻥튀김되므로 컬렉션 + 페이징에서 금지**되고 컬렉션 둘 이상도 못 쓴다. **분리 조회 계열**(`default_batch_fetch_size`, DTO 두 번 조회 후 조합)은 쿼리가 2개 이상이지만 **행이 늘지 않아 페이징과 공존한다.** 그래서 기준은 "컬렉션 + 페이징이면 fetch join 금지 → batch fetch size / to-one 여럿이면 fetch join / 조회 전용이면 DTO"다. ③ **자동 탐지 장치** — 이 문항의 실제 관문은 여기다. "쿼리 로그를 잘 보자"는 답이 아니다. **테스트에서 쿼리 수를 단정**(Hibernate `Statistics`, `SQLStatementCountValidator`)하고, **개발·스테이징에 요청 단위 쿼리 카운터**를 깔고(같은 SQL의 반복이 N+1의 지문이다), **ArchUnit으로 EAGER 자체를 금지**한다. 슬로우 쿼리 로그는 개별 쿼리가 1ms로 빨라서 N+1을 거의 못 잡고, APM은 잡아도 배포 후다 — **사후 발견은 예방 장치가 아니다.** 결론은 사고의 전환이다: **N+1은 성능 문제가 아니라 회귀(regression)다.** 한 번 고쳐도 다음 PR에서 재발하므로, 사람의 주의력이 아니라 **테스트로 고정**해야 한다.

---

## 0. 질문 + 의도

**질문**: "N+1 문제란 무엇이고 어떻게 해결하나요? (fetch join, `@EntityGraph`, batch size)"

**출제 의도**: rationale은 이 문항을 "JPA 성능 문제의 8할"로 규정하면서, 정작 채점 지점은 다른 데 둔다 — **"중요한 건 해결책 암기가 아니라 '운영 전에 어떻게 발견하는가'까지 말하는지"**. 즉 이 질문은 지식 확인 문항의 외형을 하고 있지만 실제로는 **품질을 시스템으로 고정해본 경험**을 재는 문항이다. `fetch join`을 안다는 것은 최소 요건이고, 변별은 "그 지식이 팀의 빌드 파이프라인에 장치로 박혀 있는가"에서 일어난다. 같은 문서가 다른 곳에서 답변의 3단계를 이렇게 예시한다 — 1단계 "fetch join으로 해결합니다", 2단계 "쿼리 로그로 배포 전에 잡습니다", **3단계 "테스트에서 쿼리 수를 검증합니다"**. 이 문서는 3단계에 도달하기 위한 문서다.

## 1. 정의는 한 줄로 끝내고 — N의 정체부터 바로잡는다

정의는 짧게 말하면 된다. **부모를 목록으로 조회한 쿼리 1개 뒤에, 각 부모의 연관을
채우려고 추가 쿼리가 더 나가는 것.** 여기까지는 대부분 정확히 답한다.

문제는 그다음이다. **N이 몇인가**를 잘못 알면 해결은 맞게 해도 **테스트가
통과해버린다.** 이게 N+1이 운영에서만 터지는 실제 이유다.

### 1-1. N은 "결과 행 수"가 아니다

Hibernate는 각 부모 행의 FK를 보고 연관을 채울 때 **먼저 영속성 컨텍스트(1차
캐시)를 뒤지고, 없을 때만 SELECT를 쏜다.** 그래서 식은 이렇게 된다.

```
N = | { 조회된 부모 행들이 가리키는 서로 다른 연관 id }  −  { 이미 1차 캐시에 있는 id } |
```

행 수(M)는 이 식에 **직접 등장하지 않는다.** M은 "서로 다른 연관 id가 몇 개까지
나올 수 있는가"의 상한일 뿐이다. 극단을 놓고 보면 분명해진다.

- 주문 1,000건이 **모두 같은 회원**이면 → 서로 다른 회원 id는 1개 → `1 + 1` = 쿼리 2개
- 주문 1,000건이 **각각 다른 회원**이면 → 서로 다른 회원 id는 1,000개 → `1 + 1000` = 쿼리 1,001개

같은 코드, 같은 건수인데 쿼리 수가 2개와 1,001개로 갈린다. **차이를 만드는 건
데이터 분포(카디널리티)뿐이다.**

(EAGER 매핑에서 이 일이 JPQL 번역 원리 때문에 일어나는 과정은
[03-eager-vs-lazy-fetch-strategy.md](03-eager-vs-lazy-fetch-strategy.md) §3에 상세히
있다. 1차 캐시가 왜 "성능 캐시"가 아닌지는
[02-persistence-context-dirty-checking.md](02-persistence-context-dirty-checking.md)
§1-1 참고. 이 문서는 그 위에서 **탐지와 선택**만 다룬다.)

### 1-2. 그래서 "테스트 데이터 1,000건 넣고 성능 테스트"는 실패한다

가장 흔한 오해가 여기다. 건수를 늘리는 것은 **N+1 재현과 거의 무관하다.**

```java
// Before: "데이터를 1,000건 넣고 성능 테스트" — 건수만 늘렸다. 재현되지 않는다.
@BeforeEach
void setUp() {
    Member member = memberRepository.save(new Member("홍길동"));   // ← 회원 1명
    for (int i = 0; i < 1_000; i++) {
        orderRepository.save(new Order(member, "상품" + i));        // 1,000건이 전부 같은 회원
    }
}

@Test
void 주문목록_조회() {
    orderService.list();     // 주문 1,000건 조회
}
// 서로 다른 회원 id = 1개 → 추가 SELECT 1회 → 총 쿼리 2개.
// 로그를 눈으로 봐도 깨끗하고, 응답도 빠르다. "N+1 없음"으로 통과한다.
// 운영에서는 주문 1,000건이 서로 다른 회원 800명이라 쿼리 801개가 나간다.
```

여기에 **함정이 하나 더 있다.** 위 픽스처를 "회원도 1,000명으로" 고쳐도 여전히
재현되지 않을 수 있다. `save()`로 넣은 회원들이 **아직 1차 캐시에 살아 있기
때문**이다. 식의 두 번째 항이 커져서 N이 0이 된다.

```java
// After: 카디널리티로 설계하고, 측정 직전에 컨텍스트를 비운다
@BeforeEach
void setUp() {
    for (int i = 0; i < 50; i++) {
        Member member = memberRepository.save(new Member("회원" + i));   // ① 회원 50명 — 서로 다른 id
        orderRepository.save(new Order(member, "상품" + i));             //    주문은 1건씩
    }
    em.flush();
    em.clear();   // ② 이 줄이 없으면 방금 save 한 회원 50명이 1차 캐시에 남아 N = 0 이 된다
}

@Test
void 주문목록_조회() {
    orderService.list();     // 주문 50건 조회
}
// 서로 다른 회원 50명, 캐시는 비어 있음 → 추가 SELECT 50회 → 총 51개. 이제 테스트로 잡을 수 있다.
```

②의 `em.clear()`는 사소해 보이지만 **N+1 테스트가 조용히 통과하는 원인 1위**다.
운영의 조회 요청은 항상 **빈 영속성 컨텍스트에서 시작**하는데, 테스트는 픽스처를
넣은 컨텍스트를 그대로 물고 측정에 들어간다. 이 비대칭을 없애야 테스트가 운영을
대표한다.

### 1-3. 픽스처는 건수가 아니라 카디널리티로 설계한다

세 가지 픽스처를 비교하면 설계 원칙이 바로 나온다.

| 픽스처 | 부모 행 수 | 서로 다른 연관 id | 총 쿼리 | 재현 |
|---|---|---|---|---|
| 회원 1명 + 주문 1,000건 | 1,000 | 1 | 2 | ✗ |
| 회원 1,000명 + 주문 1,000건, `clear()` 없음 | 1,000 | 1,000 (전부 캐시 히트) | 1 | ✗ |
| **회원 50명 + 주문 50건, `clear()` 있음** | 50 | 50 | 51 | ✓ |

건수를 20배 줄인 세 번째가 유일하게 재현한다. 그래서 규칙은 세 줄이다.

1. **부모마다 서로 다른 연관을 갖게 만든다.** 최악을 상정하는 것이고, 목록 API의
   운영 데이터는 대개 최악에 가깝다(주문 목록의 주문자는 거의 다 다른 사람이다).
2. **건수는 작게 유지한다.** 재현에 필요한 건 분포이고, 건수는 테스트를 느리게만
   만든다. 50건이면 충분하다.
3. **측정 직전에 `flush()` + `clear()`.** 픽스처를 만든 컨텍스트와 측정하는
   컨텍스트를 분리한다.

여기까지가 §3의 자동 탐지 장치가 **작동하기 위한 전제**다. 픽스처가 재현하지
못하면 아무리 정교한 쿼리 수 단정도 항상 통과한다 — 장치가 있는데 아무것도 잡지
못하는 최악의 상태가 된다.

## 2. 해결책 4종 — 직관에 이름을 붙이면 선택 기준이 생긴다

"조인으로 한 번에 가져오거나, 연관 데이터를 한 번에 다 가져와서 애플리케이션에서
조합한다"는 설명은 원리로는 이미 정확하다. 이 두 갈래에 정식 이름을 붙이면 **선택
기준이 자동으로 따라 나온다.**

| 갈래 | 도구 | 쿼리 수 | 결과 행 수 | 페이징 |
|---|---|---|---|---|
| **조인 계열** — "조인으로 한 번에" | `fetch join`, `@EntityGraph` | 1 | 부모 × 자식으로 **뻥튀김** | 컬렉션이면 **불가** |
| **분리 조회 계열** — "다 가져와 조합" | `default_batch_fetch_size`/`@BatchSize`, DTO 두 번 조회 | 2 이상 | 부모는 부모 수 그대로 | **가능** |

이 표의 **"결과 행 수" 칸이 모든 것을 결정한다.** 조인 계열이 페이징과 충돌하는
이유, 컬렉션 둘 이상을 못 쓰는 이유, `distinct`가 등장하는 이유가 전부 여기서
나온다. 반대로 분리 조회 계열의 장점도 하나로 요약된다 — **행이 늘지 않는다.**

### 2-1. ① `fetch join` — 그리고 두 개의 벽

```java
// Before: 연관이 LAZY 인데 DTO 변환에서 건드린다 → 접근 지점에서 N+1
@Query("select o from Order o")
List<Order> findAllOrders();
// o.getMember().getName() 을 부르는 순간 프록시 초기화가 회원 수만큼 나간다

// After: 그 쿼리에서만 함께 가져온다 — 쿼리 1개
@Query("select o from Order o join fetch o.member")
List<Order> findAllWithMember();
```

`join`과 `join fetch`의 차이를 정확히 말할 수 있어야 한다. 일반 `join`은
**SQL 조인만** 만들고 select 목록에는 부모만 남는다(연관은 여전히 프록시 →
N+1 그대로). `join fetch`는 **연관 엔티티의 컬럼까지 select 목록에 올려** 한
번에 채운다. "조인을 걸었는데 N+1이 그대로다"의 원인 대부분이 `fetch` 누락이다.

to-one 연관(`@ManyToOne`, `@OneToOne`)에는 fetch join이 거의 항상 정답이다.
**조인해도 행이 늘지 않기 때문**이다(부모 1행 : 연관 1행). 여러 개를 겹쳐도 된다.

```java
// to-one 이 셋이어도 행은 안 늘어난다 → 페이징도 정상 동작한다
@Query("select o from Order o join fetch o.member join fetch o.delivery join fetch o.coupon")
List<Order> findAllWithToOnes(Pageable pageable);
```

문제는 **컬렉션**(`@OneToMany`, `@ManyToMany`)이다. 여기서 벽이 두 개 나온다.

**벽 1 — 컬렉션 fetch join과 페이징은 함께 쓸 수 없다.**

주문 1건에 상품이 3개면 조인 결과는 3행이 된다. 이 상태에서 SQL에
`limit 10`을 붙이면 얻는 것은 "주문 10건"이 아니라 **"조인 결과 10행"**, 즉
주문 3~4건이고 그중 마지막 주문은 상품이 **잘린 상태**로 들어온다. 데이터가
틀리는 것이다. 그래서 Hibernate는 SQL에 limit을 붙이지 않는 쪽을 택한다.

```java
// Before: 컴파일도 되고 예외도 안 나는데, 프로덕션에서 OOM 으로 죽는 코드
@Query("select o from Order o join fetch o.items")
Page<Order> findPage(Pageable pageable);
// Hibernate 6.x: SQL 에 limit/offset 이 붙지 않는다. 조인 결과 전체를 읽어
// 메모리에 올린 뒤 애플리케이션에서 잘라낸다. 주문 100만 건이면 그대로 100만 건을 읽는다.
// 경고 로그는 나가지만 예외가 아니라서 아무도 모른 채 배포된다.
```

**확인 범위 / 통설 교정** — 이 지점은 버전에 따라 동작이 실제로 바뀌었으므로
정확히 알고 말하는 것이 좋다. 소스와 마이그레이션 가이드에서 확인한 내용이다.

- **Hibernate 5.x**: 메모리 페이징 + 경고 `HHH000104: firstResult/maxResults
  specified with collection fetch; applying in memory!`
- **Hibernate 6.0 ~ 7.3**: **여전히 메모리 페이징이다.** 다만 메시지 코드가
  **`HHH90003004`** 로 바뀌었고 로거가 `org.hibernate.orm.query`다. 흔히 인용되는
  `HHH000104`는 **5.x 코드이므로 6.x 로그에서 그 문자열로 grep 하면 안 걸린다.**
- **Hibernate 7.4.0부터**: limit/offset을 **부모에 대한 파생 테이블(서브쿼리)로
  밀어넣도록 바뀌었다**(`select ... from (select * from orders limit ?, ?) o join items ...`).
  즉 페이징이 DB에서 처리된다. 이전 동작으로 되돌리려면 쿼리 힌트
  `org.hibernate.limitInMemory`를 준다. 단 조건이 있다 — dialect가 서브쿼리 안의
  offset을 지원해야 하고(주요 상용 DB는 지원), 루트 엔티티가 하나여야 한다.
- 버전 대응: **Spring Boot 3.x → Hibernate 6.x(옛 동작)**, Spring Boot 4.0 →
  7.2(옛 동작), **Spring Boot 4.1 → 7.4(새 동작)**. 즉 **지금 대다수 프로젝트는
  여전히 메모리 페이징 구간**이다. 면접에서는 "6.x까지는 메모리 페이징이고
  7.4에서 서브쿼리로 밀어넣게 바뀌었다"까지 말하면 정확하다. **(가산점 포인트)**

이 함정을 **경고가 아니라 실패로** 바꾸는 설정이 있다. 이걸 아는 사람은 드물다.

```yaml
spring:
  jpa:
    properties:
      hibernate:
        # 기본값 false(경고만). true 로 두면 예외를 던진다 — 배포를 막는 쪽이 낫다.
        query.fail_on_pagination_over_collection_fetch: true
```

기본값이 `false`라서 **아무 조치를 안 하면 조용히 메모리 페이징이 된다.** 이걸
`true`로 켜는 것 자체가 §3에서 말할 "자동 장치"의 한 종류다 — 사람이 로그를
읽는 대신 애플리케이션이 실패한다. (Hibernate 7.4 이상에서는 파생 테이블 밀어넣기가
불가능한 경우에만 발동한다.)

**벽 2 — 컬렉션은 하나만 fetch join 할 수 있다.**

컬렉션 둘을 동시에 fetch join하면 두 컬렉션의 **카테시안 곱**이 나온다. 상품 3개와
배송이력 4개면 12행이 나오고, 애플리케이션이 중복을 걷어내긴 하지만 DB에서 읽는
데이터량 자체가 3×4로 곱해진다. 컬렉션이 각각 100개면 10,000행이다.

여기서 Hibernate가 막아주는 경우와 조용히 통과시키는 경우가 갈리는데, 이
구분이 정확히 알려져 있지 않다. **확인 범위**: 아래는 Hibernate 6.6·7.4 소스와
회귀 테스트에서 확인한 내용이다.

- **`bag` 둘을 fetch join할 때만 예외가 난다.** 예외는
  `org.hibernate.loader.MultipleBagFetchException`(`HibernateException` 상속)이고
  메시지는 `cannot simultaneously fetch multiple bags: [tags, comments]` 형태다.
  코드베이스 전체에서 이 예외를 던지는 곳은 한 군데이고 가드가
  `if (collectionClassification == CollectionClassification.BAG)`다. `bag`은
  **`@OrderColumn`이 없는 `List`**를 말한다.
- **`Set` 둘을 fetch join하면 예외도 경고도 없다.** `SET`·`LIST`(+`@OrderColumn`)·
  `MAP`은 그 가드를 통과한다. 그리고 Hibernate에는 **fetch join의 카테시안 곱을
  감지하거나 로그로 알려주는 코드가 아예 없다.** 즉 **완전히 조용하다.**
- **던져지는 시점은 쿼리 실행 시점**(SQM → SQL AST 변환 중)이다. 부트스트랩도,
  `createQuery` 파싱 시점도 아니다. Hibernate 6에서는 EAGER `List` 두 개를 가진
  엔티티로도 `SessionFactory`가 정상 부팅된다(회귀 테스트가 그것을 단정한다).
  실무 귀결이 중요하다 — **시작할 때 크게 실패해주지 않고, 실제로 둘 다 fetch하는
  쿼리를 타는 순간에만 뒤늦게 터진다.**
- **JPA 경로에서는 예외가 바뀌어 올라온다.** `ExceptionConverterImpl`이
  `MultipleBagFetchException`을 `IllegalArgumentException`으로 변환하므로,
  `EntityManager`나 Spring Data를 쓰는 코드는 `IllegalArgumentException`을 잡고
  `getCause()`로 풀어야 원인이 보인다.

```java
// JPA 경로에서 원인을 확인하는 방법 — 그대로 MultipleBagFetchException 을 잡으려 하면 안 잡힌다
try {
    orderRepository.findAllWithItemsAndHistories();
} catch (IllegalArgumentException e) {
    if (e.getCause() instanceof MultipleBagFetchException cause) {
        log.error("bag 두 개를 동시에 fetch 했다: {}", cause.getBagRoles());
    }
    throw e;
}
```

그래서 실무 요령으로 도는 **"`List`를 `Set`으로 바꾸면 된다"는 정확히 말하면
예외를 없애는 것이지 카테시안 곱을 없애는 게 아니다.** rows(A) × rows(B)는 그대로
발생하고 Hibernate가 메모리에서 중복만 걷어낸다(6.0부터 자동 — §2-1의 `distinct`
항목과 같은 메커니즘). 즉 **큰 소리로 실패하던 것을 조용한 성능 문제로 바꾸는
선택**이다. `@OrderColumn`을 붙여 `LIST`로 만드는 것도 결과가 같다. 감지 장치를
끄는 행위에 가까우므로, 컬렉션이 둘 이상이면 정답은 §2-3의 batch fetch size다.

참고로 `hibernate.mapping.default_list_semantics`의 기본값은 `BAG`이다. 즉
**아무 설정도 안 한 `List` 필드는 6.x·7.x에서도 5.x와 똑같이 bag**이고, 이 예외를
만날 수 있는 상태다.

**`distinct` — Hibernate 6부터는 오히려 빼야 한다.**

컬렉션 fetch join은 부모가 자식 수만큼 중복되므로, 반환된 `List<Order>`에 같은
주문이 3번 들어온다. 전통적인 해법은 JPQL에 `distinct`를 붙이는 것이었다. 그런데
**Hibernate 6.0부터 이 관행은 낡았고, 붙이면 오히려 손해다.**

```java
// Before: Hibernate 5 시절의 관행 — 6.x 에서는 불필요하고 비용만 든다
@Query("select distinct o from Order o join fetch o.items")
List<Order> findAllWithItems();

// After: Hibernate 6+ — distinct 없이도 부모 중복은 제거된다
@Query("select o from Order o join fetch o.items")
List<Order> findAllWithItems();
```

**확인 범위 / 통설 교정** — Hibernate 6.0 마이그레이션 가이드에서 확인한 내용이다.
6부터 **fetch join의 부모 엔티티 중복은 항상 Hibernate가 걸러낸다.** 그래서
`distinct`가 필요 없어졌고, 5.2에서 도입된
`hibernate.query.passDistinctThrough`(SQL로 `distinct`를 넘기지 않게 하는 설정)는
**6.0에서 제거됐다.** 중요한 귀결이 있다 — 6부터 `distinct`를 쓰면 **항상 SQL의
`select distinct`로 나가고 이를 막을 방법이 없다.** 조인으로 뻥튀김된 전체 행에
대해 DB가 정렬·해시 중복 제거를 하게 되므로 **실제 비용이 발생한다.** 즉 6.x에서
`distinct`는 "안전하게 붙여두는 것"이 아니라 **불필요한 DB 비용**이다.

### 2-2. ② `@EntityGraph` — 선언적 fetch join

`fetch join`과 **같은 SQL로 번역되는 선언형 표기**다. 그래서 §2-1의 두 벽이
**그대로 적용된다** — 컬렉션 + 페이징 금지, 컬렉션 둘 이상 금지.

"`@EntityGraph`를 쓰면 페이징이 된다"는 오해가 꽤 퍼져 있는데 사실이 아니고,
**확인 범위**로 메커니즘까지 확인했다. Hibernate 6.6이 페이징을 메모리로 돌리는
판정은 `hasLimit && containsCollectionFetches`인데, 이 `containsCollectionFetches`가
**"HQL 문장에 컬렉션 fetch가 있는가" 또는 "적용된 EntityGraph에 컬렉션이 EAGER
노드로 들어 있는가"** 의 논리합이다. 즉

```java
// join fetch 를 한 글자도 쓰지 않았는데도 인메모리 페이징 + HHH90003004 경고가 그대로 난다
@EntityGraph(attributePaths = "items")     // ← items 가 컬렉션이면 여기서 걸린다
Page<Order> findByStatus(OrderStatus status, Pageable pageable);
```

**`@EntityGraph`로 컬렉션을 지정하고 `Pageable`을 함께 넘기는 조합은 컬렉션
fetch join + 페이징과 완전히 동일한 함정**이다. `jakarta.persistence.fetchgraph` /
`loadgraph` 힌트를 직접 주는 경우도 같다. 반대로 **EAGER 노드가 전부 단일 값
연관(to-one)인 EntityGraph는 이 판정에 걸리지 않아 페이징이 정상 동작한다** —
§2-1에서 "to-one은 조인해도 행이 안 늘어난다"고 한 것과 같은 이야기다.

`fetch join`이 못 하는 일을 하나 한다. **쿼리 문장을 쓰지 않고도 붙일 수 있다.**

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    // ① 메서드 이름 파생 쿼리에 붙인다 — JPQL 을 쓸 수 없는 자리
    @EntityGraph(attributePaths = {"member", "delivery"})
    List<Order> findByStatus(OrderStatus status);

    // ② 상속받은 메서드를 오버라이드해 붙인다 — findAll() 에 fetch 를 먹인다
    @Override
    @EntityGraph(attributePaths = "member")
    List<Order> findAll();

    // ③ 중첩 경로도 된다 — 점 표기로 depth 를 내려간다
    @EntityGraph(attributePaths = {"member", "member.team"})
    Optional<Order> findWithMemberAndTeamById(Long id);
}
```

한 가지 구분을 알아두면 좋다. `@EntityGraph`에는 `type`이 있고 Spring Data의
기본값은 `FETCH`다. **`FETCH`는 그래프에 적지 않은 연관을 LAZY로 취급**하고,
`LOAD`는 적지 않은 연관을 **매핑의 기본값 그대로** 둔다. 그래서 EAGER 매핑이
남아 있는 프로젝트에서 `FETCH` 그래프는 이론상 EAGER를 쿼리 단위로 끄는 수단이
되지만, 실무에서 이걸 EAGER 허용의 근거로 삼기는 어렵다 — 그 논의는
[03-eager-vs-lazy-fetch-strategy.md](03-eager-vs-lazy-fetch-strategy.md) §4-3에 있다.

**언제 무엇을 쓰나**는 단순하다. **쿼리를 직접 쓰는 자리(JPQL/QueryDSL)에서는
`fetch join`**, **파생 쿼리나 상속 메서드처럼 문장이 없는 자리에서는
`@EntityGraph`**. 성능 차이가 아니라 표기 위치의 문제다.

### 2-3. ③ `default_batch_fetch_size` / `@BatchSize` — 페이징과 공존하는 유일한 도구

이게 후보자가 "연관 데이터를 한 번에 다 가져와서 애플리케이션에서 조합한다"고
설명한 것을 **Hibernate가 자동으로 해주는 버전**이다.

원리는 이렇다. 프록시(또는 미초기화 컬렉션) 하나를 초기화해야 하는 순간, Hibernate는
그 프록시만 채우지 않고 **같은 종류의 미초기화 프록시를 최대 size개까지 모아
`where id in (?, ?, ...)` 한 방으로 함께 채운다.** 그래서 쿼리 수가

```
1  +  ceil( 서로 다른 미해결 연관 id 수 / batch size )
```

로 떨어진다. `size = 100`이면 1 + 1000 이 1 + 10 이 된다.

```yaml
# 전역 설정 — 이게 실무의 정석 안전망이다. 100~1000 사이에서 고른다.
spring:
  jpa:
    properties:
      hibernate:
        default_batch_fetch_size: 100
```

```java
// 특정 연관만 다르게 주고 싶으면 필드/클래스 단위로 덮어쓴다
@Entity
public class Order {
    @BatchSize(size = 500)
    @OneToMany(mappedBy = "order")
    private List<OrderItem> items = new ArrayList<>();
}
```

**결정적 장점은 페이징과 공존한다는 것이다.** 부모 조회 쿼리에는 조인이 없으므로
`limit`/`offset`이 SQL에 정상적으로 붙고, 컬렉션은 그 뒤에 별도의 `IN` 쿼리로
채워진다. §2-1의 벽 1이 통째로 사라진다. 컬렉션이 둘 이상이어도 각각 `IN` 쿼리가
나가므로 카테시안 곱도 없다 — 벽 2도 사라진다.

```java
// Before: 컬렉션 fetch join + 페이징 → limit 이 SQL 에 안 붙고 전체를 메모리에 올린다
@Query("select o from Order o join fetch o.items")
Page<Order> findPage(Pageable pageable);

// After: fetch join 을 빼고(=쿼리에서 컬렉션을 fetch 하지 않고) batch fetch size 에 맡긴다
Page<Order> findAll(Pageable pageable);     // 부모 페이징 쿼리 1개 (limit 정상)
// items 접근 시 where order_id in (?,?,...) 로 묶여 나간다 → 총 1 + ceil(20/100) = 2개
```

**공존의 조건을 정확히 말해야 한다.** batch fetch가 페이징과 공존하는 이유는
"batch fetch가 특별해서"가 아니라 **페이징 쿼리가 컬렉션을 fetch하지 않기
때문**이다. 그리고 그 조건은 `join fetch`뿐 아니라 **컬렉션을 EAGER로 지정한
`@EntityGraph`/fetchgraph 힌트로도 깨진다**(§2-2). 즉 `@EntityGraph(attributePaths
= "items")`를 붙인 채 batch fetch size만 키워도 인메모리 페이징은 그대로다.
**"컬렉션은 쿼리에서 fetch하지 않는다"가 지켜야 할 규칙**이고, batch fetch size는
그 규칙을 지켰을 때 N+1을 대신 막아주는 장치다.

**확인 범위**: 이 동작은 Hibernate 회귀 테스트 `BatchPaginationTest`(HHH-16005,
6.2·6.6·7.4 브랜치에 존재)에서 직접 확인했다 — `@ManyToMany @BatchSize(size = 20)`
컬렉션에 `join fetch` 없는 쿼리 + `setMaxResults(20)`으로, 전체 요소를 순회해도
**총 쿼리 2개**(루트 1 + 배치 1)다. 다만 HHH-16005는 `@ManyToMany`에 `@BatchSize`가
무시되던 버그였고 수정 버전이 **6.1.7 / 6.2.0**이므로, 버전을 특정해 말한다면
"6.1.7 이상 / 6.2 이상"으로 한정하는 것이 정확하다. PostgreSQL에서의 배치 SQL은
`IN`이 아니라 **`where a.book_isbn = any (?)`** 형태로 PK 배열을 하나의 파라미터로
넘긴다(공식 튜닝 가이드).

**확인 범위 / 통설 교정 — 배치 크기 산정 방식은 버전에 따라 다르다.**
"size를 100으로 주면 100개씩 묶인다"는 설명은 **Hibernate 5에서는 사실이 아니었다.**
소스에서 확인한 내용이다.

- **Hibernate 5.x**: 지정한 수를 그대로 쓰지 않고 **내림차순 배치 크기 계열**을
  미리 만들어 재사용했다(`ArrayHelper.getBatchSizes`). size 32면 실제 배치 크기는
  `32, 16, 10, 9, 8, 7, ... 1`이고, 미해결 id 50개는 `32 + 16 + 2` → **쿼리 3개**가
  나간다. `ceil(50/32) = 2`와 어긋난다. 프리페어드 스테이트먼트 재사용을 위해
  파라미터 개수가 다른 SQL 종류를 제한하려는 설계였다.
- **Hibernate 6.2부터 완전히 바뀌었다**(HHH-16441). dialect가 SQL 배열 타입을
  지원하고 id가 단일 컬럼 기본 타입이면 **파라미터 하나에 배열을 바인딩해 SQL
  한 개**로 처리하고(PostgreSQL 등), 그렇지 않으면 **정확히 size개의 플레이스홀더를
  가진 `in (?,?,...)` 하나**를 쓰고 **남는 자리를 `null`로 채운다**(MySQL, H2 등).
  즉 SQL 모양이 하나로 고정되고, **`1 + ceil(N/size)` 공식이 6.2 이후로는 실제와
  맞는다.**
- 참고로 `hibernate.query.in_clause_parameter_padding`은 **이 배치 fetch와 무관한
  설정**이다(HQL의 `IN` 목록 확장과 다중 id 로딩에 적용된다). 두 개를 섞어 말하면
  틀린다.
- 프로퍼티 이름은 6.x·7.x에서 `hibernate.default_batch_fetch_size` 그대로이고,
  **Spring Boot에는 이 설정을 위한 전용(1급) 프로퍼티가 없다.** 반드시
  `spring.jpa.properties.hibernate.default_batch_fetch_size`로 넘겨야 한다 —
  `spring.jpa.hibernate.*` 아래에 적으면 조용히 무시된다. 이 오타는 "설정했는데
  안 먹는다"의 단골 원인이다.

한계도 정확히 말해야 한다. **쿼리가 1개가 되는 것은 아니다.** 왕복이 2회 이상
남고, N+1을 없애는 게 아니라 **1+N을 1+몇 개로 낮추는 완화책**이다. 그리고
가장 중요한 부작용은 성능이 아니라 **은폐**다 — 증상이 옅어져서 N+1이 있는지조차
모르게 된다. 그래서 전역 batch fetch size는 **§3의 탐지 장치와 반드시 함께**
깔아야 한다. 안전망만 깔면 "조용한 1 + 수십 쿼리" 상태로 굳는다.

### 2-4. ④ DTO 프로젝션 / 두 번 조회 후 애플리케이션 조합 — 조회 전용 화면의 정답

앞의 셋은 모두 **엔티티를 만든다**는 전제를 공유한다. 조회 전용 화면이라면 그
전제 자체를 버리는 것이 가장 근본적이다. 엔티티를 안 만들면 프록시도 없고
스냅샷도 없고 N+1이라는 문제 범주 자체가 사라진다(스냅샷·flush 비용은
[02-persistence-context-dirty-checking.md](02-persistence-context-dirty-checking.md)
§2 참고).

```java
// Before: DTO 를 반환하지만 "엔티티를 조회해서 자바에서 변환" — N+1 은 그대로다
public List<OrderDto> list() {
    return orderRepository.findAll().stream()
            .map(o -> new OrderDto(o.getId(), o.getMember().getName()))  // ← 여기서 N+1
            .toList();
}

// After: DTO 를 쿼리가 만든다 — 조인 1개, 필요한 컬럼만
@Query("""
       select new com.example.OrderDto(o.id, m.name)
       from Order o join o.member m
       """)
List<OrderDto> findAllDto();
```

**"DTO를 쓴다"와 "DTO 프로젝션"은 다르다.** 반환 타입이 DTO여도 엔티티를 조회해서
자바에서 변환하면 N+1은 그대로다. **DTO가 쿼리의 결과여야** 효과가 있다. 이 구분을
못 하면 "DTO로 바꿨는데 왜 여전히 느리죠"에 갇힌다.

컬렉션이 있는 화면은 한 번에 안 된다. 여기서 **후보자가 원리로 설명한 그 방법**이
정식 해법으로 등장한다 — **부모를 페이징으로 조회하고, 자식을 id 목록으로 한 번에
조회한 뒤, 애플리케이션에서 조합한다.**

```java
public Page<OrderView> page(Pageable pageable) {
    // ① 부모만 페이징 — 조인이 없으니 limit 이 SQL 에 그대로 붙는다
    Page<OrderRow> orders = orderRepository.findRows(pageable);              // 쿼리 1

    List<Long> orderIds = orders.getContent().stream().map(OrderRow::id).toList();

    // ② 자식을 id 목록으로 한 번에 — IN 절 하나
    Map<Long, List<ItemRow>> itemsByOrder = itemRepository.findRowsByOrderIdIn(orderIds)
            .stream().collect(groupingBy(ItemRow::orderId));                 // 쿼리 1

    // ③ 애플리케이션에서 조합 — 총 쿼리 2개, 페이징 정상, 카테시안 곱 없음
    return orders.map(o -> new OrderView(o, itemsByOrder.getOrDefault(o.id(), List.of())));
}
```

여기서 §2-3과의 관계를 짚으면 이해가 완성된다. **`default_batch_fetch_size`는
Hibernate가 ①②③을 엔티티 세계에서 자동으로 해주는 것**이고, 위 코드는 같은 일을
DTO 세계에서 손으로 하는 것이다. 원리가 하나라서 후보자의 직관("다 가져와서
조합")이 두 도구를 동시에 설명한다. 손으로 하는 대가로 얻는 것은 **필요한 컬럼만
읽는다는 것과 조합 규칙을 내가 통제한다는 것**이다.

### 2-5. 선택 기준 — 이 표 하나로 정리된다

| 상황 | 선택 | 근거 |
|---|---|---|
| to-one 연관 1~여러 개 (페이징 유무 무관) | `fetch join` / `@EntityGraph` | 조인해도 행이 안 늘어 `limit`이 정상 동작 |
| 컬렉션 1개 + 페이징 없음 | `fetch join` / `@EntityGraph` | 쿼리 1개. Hibernate 6+ 에서 `distinct`는 붙이지 않는다 |
| **컬렉션 + 페이징** | **batch fetch size** | fetch join 금지 구간(메모리 페이징). `@EntityGraph`로 컬렉션을 지정해도 같은 함정 |
| 컬렉션 2개 이상 | batch fetch size | fetch join은 카테시안 곱. bag 둘이면 예외, `Set` 둘이면 조용히 곱해진다 |
| 조회 전용 화면·목록 API | DTO 프로젝션 (컬렉션은 두 번 조회 후 조합) | 엔티티·프록시·스냅샷을 아예 만들지 않는다 |
| 전 구간 안전망 | 전역 `default_batch_fetch_size` 100~1000 | 놓친 지점의 피해를 1+N에서 1+몇 개로 낮춘다 |

면접에서 한 문장으로 말한다면 이렇다. **"컬렉션에 페이징이 붙으면 fetch join은
후보에서 빠지고 batch fetch size로 갑니다. to-one 여러 개면 fetch join, 조회
전용이면 DTO 프로젝션이고, 전역 batch fetch size는 안전망으로 항상 깔아둡니다."**

## 3. 자동 탐지 장치 — 이 문항의 실제 관문

여기가 채점 지점이다. rationale이 재려는 것은 "운영 전에 어떻게 발견하는가"이고,
**"쿼리 로그를 보고 성능 테스트를 한다"는 답은 여기서 미달로 기록된다.** 이유는
그 방법이 나쁘기 때문이 아니라 **사람에 의존하기 때문**이다.

### 3-0. 사람 의존 장치가 반드시 실패하는 네 가지 이유

1. **픽스처가 재현하지 못한다** — §1이 그 내용이다. 건수를 늘리는 방식의 성능
   테스트는 카디널리티가 낮아 N+1을 통과시킨다.
2. **로그는 흘러간다** — 실패한 요청의 로그는 읽지만, **성공한 요청이 쿼리 40개를
   쓴 사실은 아무도 보지 않는다.** N+1은 예외를 던지지 않으므로 로그에 있어도
   읽히지 않는다.
3. **리뷰는 diff만 본다** — N+1은 **두 파일 사이에서 태어난다.** 매핑 파일의
   `fetch` 누락과 서비스 파일의 `getMember()` 한 줄이 결합될 때 생기는데, PR의
   diff에는 보통 한쪽만 올라온다. 리뷰어가 다른 파일을 기억해야 잡히는 구조라서,
   팀이 커지고 PR이 늘면 확률적으로 반드시 새어나간다.
4. **한 번 고쳐도 재발한다** — 이게 결정적이다(§4). fetch join을 넣어 고친 API에
   다음 달 필드 하나가 추가되면서 `o.getDelivery().getAddress()` 한 줄이 붙으면
   N+1이 되살아난다. 고친 사람의 의도는 코드에 남지 않는다.

그래서 필요한 것은 **더 열심히 보는 것이 아니라, 사람이 안 봐도 실패하는 장치**다.
아래 네 층으로 쌓는다.

```flow
# N+1 이 태어나서 운영에 도달할 때까지 통과하는 관문들. 관문 4·5 만 있는 팀은 사실상 "운영에서 발견하는 팀"이다.
== 코드가 작성되는 순간
① 매핑에 fetch 를 안 적는다 | @ManyToOne 기본값이 EAGER 라서 "안 적었다"가 곧 "EAGER"다
② DTO 변환에서 연관을 한 줄 건드린다 | o.getMember().getName() — N+1 의 실제 발생 지점
== 관문 1 · ArchUnit (빌드 시점, 수 초)
③ 매핑 기본값을 못 박는다 | to-one 의 LAZY 명시 누락·EAGER 사용을 빌드 실패로 만든다
  ! ②는 못 잡는다 → 매핑이 옳아도 사용처에서 N+1 은 태어난다
== 관문 2 · 쿼리 수 단정 테스트 (PR 시점)
④ 이 API 는 쿼리 몇 개인가를 단정한다 | Statistics / SQLStatementCountValidator. ①②를 모두 잡는다
  - 전제는 픽스처의 카디널리티 | 부모마다 서로 다른 연관 id + 측정 직전 clear()
  ! 테스트가 없는 경로는 못 잡는다 → 그래서 관문 3 이 필요하다
== 관문 3 · 요청 단위 쿼리 카운터 (개발·스테이징, 모든 경로)
⑤ 요청 1 건의 쿼리 수와 SQL 반복을 센다 | 임계치 초과 시 WARN + 스택트레이스. 같은 SQL 반복이 N+1 의 지문
  ! 사람이 경고를 읽어야 조치된다 → 예방이 아니라 조기 발견
== 관문 4·5 · 운영 (사후 발견)
⑥ 슬로우 쿼리 로그 | 개별 쿼리는 1ms 라 임계치에 안 걸린다 — N+1 은 여기 거의 안 잡힌다
⑦ APM 트랜잭션 트레이스 | 잡히지만 이미 배포 후. 예방 장치가 아니라 마지막 그물
```

### 3-1. 1층 — 테스트에서 쿼리 수를 단정한다 (Hibernate `Statistics`)

가장 적은 비용으로 가장 큰 효과를 내는 장치다. 라이브러리 추가가 필요 없다.

```yaml
# 테스트 프로파일 — 기본값이 false 라서 켜지 않으면 카운터가 항상 0 이다
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
```

```java
@SpringBootTest
class OrderQueryQueryCountTest {

    @Autowired EntityManagerFactory emf;
    @Autowired OrderService orderService;
    @Autowired EntityManager em;

    @BeforeEach
    void setUp() {
        // §1-3 의 규칙: 부모마다 서로 다른 연관 + 측정 직전 clear()
        for (int i = 0; i < 50; i++) {
            Member m = memberRepository.save(new Member("회원" + i));
            orderRepository.save(new Order(m, "상품" + i));
        }
        em.flush();
        em.clear();
    }

    @Test
    void 주문목록_API는_쿼리_두_개_이내여야_한다() {
        Statistics stats = emf.unwrap(SessionFactory.class).getStatistics();
        stats.clear();                       // ← 전역·누적이므로 필수 (아래 함정 ①)

        orderService.list();

        assertThat(stats.getPrepareStatementCount())
                .as("N+1 회귀 — 연관을 fetch 하지 않는 코드가 들어왔다")
                .isLessThanOrEqualTo(2);
    }
}
```

**확인 범위**: 메서드 이름은 `getPrepareStatementCount()`다 — `Prepared`가 아니라
**`Prepare`**이고 오타처럼 보이지만 이게 실제 이름이다(Hibernate 6·7 소스와 공식
유저 가이드에서 확인). `SessionFactory`는 `getStatistics()`를 노출하며,
`emf.unwrap(SessionFactory.class)`로 얻는다. 활성화 프로퍼티는
`hibernate.generate_statistics`이고 기본값은 `false`다.

**함정 세 개를 알고 써야 한다.**

1. **`Statistics`는 `SessionFactory` 전역이고 누적이다.** 스레드 단위가 아니다.
   그래서 측정 전 `clear()`가 필수이고, **JUnit을 병렬로 돌리면 다른 테스트의
   쿼리가 섞여 들어와 단정이 무작위로 깨진다.** 병렬 실행 팀은 이 테스트들을 별도
   순차 실행 그룹으로 격리해야 한다. 이 점이 §3-2의 도구를 쓰는 실질적인 이유다 —
   그쪽은 스레드 단위라 병렬 실행에 안전하다.
2. **Hibernate를 경유한 쿼리만 센다.** 같은 트랜잭션 안에서 `JdbcTemplate`이나
   MyBatis로 쏜 쿼리는 안 잡힌다. ORM과 SQL을 병용하는 프로젝트라면 카운트가
   실제보다 작게 보인다.
3. **픽스처가 전제다.** §1-3을 지키지 않으면 이 테스트는 영원히 통과한다. 장치가
   있는데 아무것도 못 잡는 상태가 가장 위험하다 — "쿼리 수 테스트가 있으니
   안심"이라는 잘못된 신뢰를 만든다.

`Statistics`에는 다른 카운터도 있어서 함께 단정하면 진단력이 올라간다.
`getEntityUpdateCount()`를 0으로 단정하면 조회 API의 유령 UPDATE까지 같이 잡힌다
([02-persistence-context-dirty-checking.md](02-persistence-context-dirty-checking.md)
§5-2). **(가산점 포인트)**

### 3-2. 2층 — `SQLStatementCountValidator` (좌표 교정 필요)

쿼리를 **유형별로** 세고, Hibernate 밖에서 나간 쿼리까지 세는 도구다. 이름을
아는 사람은 많지만 **좌표가 이미 바뀌었다.**

**확인 범위 / 통설 교정** — 널리 인용되는 `com.vladmihalcea:db-util`은
**마지막 릴리스가 1.0.7(2022년)이고 프로젝트가 종료됐다.** 저자가 Hypersistence
Utils로 통합했다. Maven Central에서 확인한 현재 좌표는 다음이다.

```groovy
// 아티팩트 이름 끝의 숫자는 Hibernate 마이너 버전이다 — 프로젝트 버전에 맞춰 고른다
testImplementation "io.hypersistence:hypersistence-utils-hibernate-63:3.15.4"
// 카운팅 주체는 datasource-proxy 다. Hypersistence Utils 에서는 optional 이므로 직접 추가해야 한다
testImplementation "net.ttddyy:datasource-proxy:1.11.0"
```

패키지도 바뀌었다. `com.vladmihalcea.sql` → **`io.hypersistence.utils.jdbc.validator`**.
사용 가능한 단정 메서드는 다음이다 — **`AtMost`/`AtLeast` 변형은 두 라이브러리
어디에도 없다**(있다고 쓰인 글이 있으나 소스에는 없다).

`reset()`, `assertSelectCount(int)`, `assertInsertCount(int)`,
`assertUpdateCount(int)`, `assertDeleteCount(int)`, `assertTotalCount(int)`
— `assertTotalCount`는 Hypersistence Utils에만 있다.

**중요: `DataSource`를 프록시로 감싸지 않으면 모든 카운트가 0이다.** 이 검증기는
자체 상태를 갖지 않고 datasource-proxy의 카운터를 읽기만 한다. 그래서 "테스트가
항상 통과하는" 함정에 빠지기 쉽다.

```java
// 테스트 전용 설정 — DataSource 를 카운팅 프록시로 갈아끼운다
@TestConfiguration
class QueryCountingTestConfig implements BeanPostProcessor {

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean instanceof DataSource ds && !(ds instanceof ProxyDataSource)) {
            return ProxyDataSourceBuilder.create(ds)
                    .name("counting")
                    .listener(new DataSourceQueryCountListener())   // ← 이 리스너가 센다
                    .build();
        }
        return bean;
    }
}
```

```java
@Test
void 주문목록_API의_쿼리_구성을_못_박는다() {
    SQLStatementCountValidator.reset();      // @BeforeEach 여야 한다 — 아래 함정 ① 참고

    orderService.list();

    SQLStatementCountValidator.assertSelectCount(2);
    SQLStatementCountValidator.assertUpdateCount(0);   // 조회 API 인데 UPDATE 가 나가면 실패
}
```

**카운터의 저장 범위가 `Statistics`와 정반대라서, 함정도 정반대다.**
**확인 범위**: datasource-proxy(1.8·1.11.0) 소스에서 확인한 내용이다. 내부
`QueryCountHolder`는 `static ThreadLocal<ConcurrentMap<String, QueryCount>>`이고
`getGrandTotal()`은 **현재 스레드의 맵만 합산한다.** 데이터소스 이름으로 키를 잡을
뿐 스레드 간 집계는 하지 않는다. 귀결이 둘이다.

1. **병렬 테스트에 안전하다.** 스레드마다 카운터가 분리되므로 `Statistics`와 달리
   다른 테스트의 쿼리가 섞이지 않는다. 단 JUnit 5의 `@Execution(CONCURRENT)`는
   ForkJoinPool 워커를 **재사용**하므로 같은 워커에서 앞서 돌았던 테스트의 잔여
   상태가 남는다 → **`reset()`은 `@BeforeAll`이 아니라 반드시 `@BeforeEach`**여야
   한다. 이 하나를 틀리면 단정이 무작위로 깨진다.
2. **검증 대상이 다른 스레드에서 쿼리를 쏘면 조용히 0으로 집계된다.** `@Async`,
   `CompletableFuture.supplyAsync`, DB를 타는 parallel stream, executor로 넘긴
   트랜잭션이 모두 여기 해당한다. **에러가 나지 않고 그냥 통과한다** — 1층의
   "장치가 있는데 아무것도 못 잡는 상태"가 여기서도 재현된다. 비동기 경로를
   검증해야 한다면 datasource-proxy의 `SingleQueryCountHolder`(스레드 공유 전략)로
   바꿔야 하는데, 이때 `SQLStatementCountValidator.reset()`이 **사실상 동작하지
   않는다**는 함정이 따라온다(`QueryCountHolder.clear()`가 스레드의 참조만 버리고
   공유 카운터를 0으로 만들지 않는다). 전략 인스턴스의 `clear()`를 직접 호출해야
   한다. 요약하면 **이 도구는 동기 요청 경로 검증용으로 쓰는 것이 안전하다.**

**`Statistics`와 어느 쪽을 쓸까.** 라이브러리 없이 시작하려면 `Statistics`,
**유형별 분리·Hibernate 밖 쿼리·병렬 테스트 안전성이 필요하면** 이쪽이다.
실무에서는 대개 한쪽만 표준으로 정해 헬퍼로 감싸 쓴다 — 중요한 건 도구 선택이
아니라 **목록 API마다 쿼리 수 단정이 하나씩 붙어 있는 상태**다.

### 3-3. 3층 — 요청 단위 쿼리 카운터 (개발·스테이징의 모든 경로를 덮는다)

1·2층의 한계는 명확하다. **테스트가 있는 경로만 지킨다.** 새로 만든 API,
테스트를 안 쓴 관리자 화면, 조건 분기로만 타는 경로는 전부 무방비다. 그래서
**코드를 수정하지 않고 모든 요청을 감시하는 층**이 필요하다.

여기서 핵심 아이디어가 하나 있다. **N+1의 지문은 총 쿼리 수가 아니라 "같은 SQL의
반복"이다.** 정당하게 무거운 화면은 서로 다른 쿼리 60개를 쓸 수 있고 그건 N+1이
아니다. 반대로 N+1은 **파라미터만 다른 동일한 SQL이 수십 번** 반복된다. 그래서
총량 임계치보다 **정규화된 SQL별 반복 횟수**를 보는 편이 거짓 양성이 훨씬 적다.

```java
// 개발·스테이징 전용. 같은 SQL 이 임계치만큼 반복되면 그 순간의 스택을 찍는다.
@Slf4j
@Component
@Profile({"local", "dev", "staging"})       // 운영에는 넣지 않는다
public class NPlusOneSniffer implements QueryExecutionListener {

    private static final int REPEAT_THRESHOLD = 10;

    // MVC 는 요청 1건 = 스레드 1개라는 가정. 아래 "확인 범위" 참고
    private static final ThreadLocal<Map<String, Integer>> COUNTS =
            ThreadLocal.withInitial(HashMap::new);

    @Override
    public void afterQuery(ExecutionInfo exec, List<QueryInfo> queries) {
        for (QueryInfo q : queries) {
            String sql = q.getQuery();                    // 파라미터가 빠진 원형 SQL
            int n = COUNTS.get().merge(sql, 1, Integer::sum);
            if (n == REPEAT_THRESHOLD) {                  // == 로 딱 한 번만 찍는다
                log.warn("N+1 의심 — 같은 SQL 이 {}회 반복됐다: {}", n, sql,
                        new Throwable("이 스택의 어딘가가 루프에서 연관을 건드리고 있다"));
            }
        }
    }

    @Override
    public void beforeQuery(ExecutionInfo exec, List<QueryInfo> queries) { }

    static void reset() { COUNTS.remove(); }
}
```

```java
// 요청 경계에서 카운터를 초기화하고, 총량 임계치도 함께 본다
@Slf4j
@Component
@Profile({"local", "dev", "staging"})
public class QueryCountGuardFilter extends OncePerRequestFilter {

    private static final int TOTAL_THRESHOLD = 50;        // 팀 합의값

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        NPlusOneSniffer.reset();
        QueryCountHolder.clear();
        try {
            chain.doFilter(req, res);
        } finally {
            QueryCount count = QueryCountHolder.getGrandTotal();
            if (count != null && count.getSelect() >= TOTAL_THRESHOLD) {
                log.warn("QUERY-GUARD {} {} — SELECT {}건 (임계치 {})",
                        req.getMethod(), req.getRequestURI(), count.getSelect(), TOTAL_THRESHOLD);
            }
            NPlusOneSniffer.reset();
            QueryCountHolder.clear();
        }
    }
}
```

두 장치의 역할이 다르다. **필터는 "이 요청이 무겁다"를 알려주고, 스니퍼는 "누가
그랬는지"를 알려준다.** 스니퍼가 찍는 스택트레이스가 결정적인 이유는, 10번째
반복 시점의 스택에 **루프를 돌고 있는 그 코드 줄이 그대로 들어 있기 때문**이다.
로그를 보고 "어느 API가 느리네"에서 멈추지 않고 파일과 줄 번호로 직행한다.

**확인 범위**: `QueryCountHolder`가 `static ThreadLocal` 기반이고
`getGrandTotal()`이 현재 스레드만 합산한다는 것은 소스에서 확인했다(§3-2). 그래서
위 필터는 **요청 1건이 스레드 1개에서 처리된다는 가정**에서 정확하게 동작한다 —
Spring MVC의 기본 모델이 그렇다. 반대로 `@Async`나 WebFlux처럼 다른 스레드로
넘어가는 경로에서는 카운트가 나뉘거나 0이 되므로, 요청 스코프 빈이나 MDC 기반
컨텍스트 전파로 바꿔야 한다. `QueryExecutionListener`·`QueryInfo#getQuery()`의
정확한 시그니처는 프로젝트 버전에서 컴파일로 확인할 것.

**운영에 넣지 않는 이유**도 말할 수 있어야 한다. 모든 쿼리마다 맵 갱신과 문자열
키 해싱이 붙고, 경고마다 스택트레이스 생성 비용이 든다. 개발·스테이징에서
**배포 전에** 잡는 것이 목적이므로 프로파일로 가둔다. 운영에서 같은 정보가
필요하면 §3-5의 APM 쪽으로 간다.

### 3-4. 4층 — ArchUnit으로 기본값 자체를 못 박는다

지금까지의 층은 **결과(쿼리 수)** 를 검사한다. 한 층 더 앞에서 **원인(매핑)** 을
막을 수 있다. `@ManyToOne`·`@OneToOne`의 기본값이 EAGER이므로, **`fetch`를 안
적은 것 자체가 EAGER 선언**이다([03-eager-vs-lazy-fetch-strategy.md](03-eager-vs-lazy-fetch-strategy.md)
§2). 이걸 빌드에서 실패시킨다.

```java
@AnalyzeClasses(packages = "com.example.domain")
class EntityMappingRulesTest {

    @ArchTest
    static final ArchRule to_one_연관은_LAZY로_명시해야_한다 =
            fields().that().areAnnotatedWith(ManyToOne.class)
                    .or().areAnnotatedWith(OneToOne.class)
                    .should(new ArchCondition<JavaField>("fetch = LAZY 로 명시돼 있어야 한다") {
                        @Override
                        public void check(JavaField field, ConditionEvents events) {
                            FetchType fetch = field.isAnnotatedWith(ManyToOne.class)
                                    ? field.getAnnotationOfType(ManyToOne.class).fetch()
                                    : field.getAnnotationOfType(OneToOne.class).fetch();
                            if (fetch != FetchType.LAZY) {
                                events.add(SimpleConditionEvent.violated(field,
                                        field.getFullName() + " 의 fetch 가 EAGER 다"
                                        + " (명시하지 않은 경우도 기본값이 EAGER 라 여기서 걸린다)"));
                            }
                        }
                    });
}
```

이 룰의 **실제 이득은 EAGER를 일부러 적은 사람을 잡는 게 아니라, `fetch`를 적는
것을 잊은 사람을 잡는 것**이다. 후자가 압도적으로 많다. 애노테이션의 기본값을
읽어 판정하므로 두 경우가 자동으로 같이 걸린다.

레거시 프로젝트 도입 요령도 함께 말하면 좋다. 기존 위반이 200개면 룰을 켜는
순간 빌드가 안 돌아 결국 룰을 지운다. ArchUnit의 **`FreezingArchRule.freeze(rule)`**
로 현재 위반을 동결하면 **기존 것은 통과시키고 신규 위반만 실패**시킬 수 있다.
동결 목록을 조금씩 줄여나가는 방식이 현실적이다. **(가산점 포인트)**

**확인 범위**: `fields()`·`ArchCondition`·`SimpleConditionEvent`·`FreezingArchRule`은
ArchUnit의 공개 API이지만 정확한 시그니처는 버전별로 다를 수 있어 프로젝트에서
컴파일로 확인할 것.

이 층으로 막을 수 없는 것도 분명히 알아야 한다. **매핑이 전부 LAZY여도 N+1은
사용처에서 태어난다.** ArchUnit은 원인 하나를 봉쇄할 뿐이고, 실제 방어의 주력은
여전히 1·2층의 쿼리 수 단정이다.

### 3-5. APM·슬로우 쿼리 로그는 "예방"이 아니라 "사후 발견"이다

이 구분을 말하면 답변의 층이 확실히 올라간다. 그리고 이 문단에는 반직관적인
사실이 하나 있다.

**슬로우 쿼리 로그는 N+1을 거의 잡지 못한다.** N+1의 개별 쿼리는
`select * from member where id = ?` 같은 PK 단건 조회라서 **1ms 미만으로 매우
빠르다.** 슬로우 쿼리 임계치가 보통 1초이므로 **한 건도 걸리지 않는다.** 느린
것은 개별 쿼리가 아니라 **합계와 왕복 지연의 누적**이다. "슬로우 쿼리 로그를
보면 됩니다"라고 답하면 이 되묻기 한 방에 무너진다.

**APM(트랜잭션 트레이스)은 잡는다.** 요청 하나의 타임라인에 동일 쿼리가 수백 개
쌓인 그림이 그대로 보인다. 다만 성질이 다르다 — **이미 배포된 뒤에 실제 트래픽으로
관측되는 것**이다. 그래서 APM은 예방 장치가 아니라 **장치가 놓친 것을 잡는 마지막
그물**이다. 유용한 사용법이 하나 있는데, 트랜잭션 목록을 **응답 시간 순이 아니라
쿼리 수 순으로 정렬**하는 것이다. N+1은 데이터가 적은 동안 빠르기 때문에 응답
시간 정렬에서는 안 보이고, 쿼리 수 정렬에서는 1등으로 올라온다. **(가산점 포인트)**

정리하면 이렇다. **예방은 빌드와 테스트에서, 조기 발견은 스테이징 카운터에서,
사후 발견은 APM에서.** 셋을 같은 층으로 말하면 "장치를 갖췄다"가 아니라 "운영에서
발견하는 팀"이라는 뜻이 된다.

### 3-6. 층별 역할 정리

| 층 | 장치 | 시점 | 덮는 범위 | 못 잡는 것 |
|---|---|---|---|---|
| 1 | 쿼리 수 단정 테스트 (`Statistics`) | PR | 테스트가 있는 경로 | 테스트 없는 경로, 낮은 카디널리티 픽스처 |
| 2 | `SQLStatementCountValidator` | PR | 위와 같음 + 유형별·ORM 밖 쿼리 | 위와 같음 |
| 3 | 요청 단위 카운터 + SQL 반복 스니퍼 | 개발·스테이징 | **모든 경로** | 사람이 경고를 읽어야 조치됨 |
| 4 | ArchUnit EAGER 금지 | 빌드 | 매핑 전체 | 사용처에서 태어나는 N+1 |
| — | 슬로우 쿼리 로그 | 운영 | 사실상 없음 | N+1 자체 (개별 쿼리가 빠름) |
| — | APM 트랜잭션 트레이스 | 운영 | 실제 트래픽 전체 | 배포 전 차단 |

## 4. 원칙 — N+1은 성능 문제가 아니라 회귀다

이 문항의 결론은 도구 목록이 아니라 **문제의 분류를 바꾸는 것**이다.

성능 문제는 한 번 고치면 끝난다. 인덱스를 걸면 그 인덱스는 남아 있다. 그런데
**N+1은 고쳐도 재발한다.** 구조적 이유가 셋이다.

1. **원인과 발생 지점이 멀다.** 매핑 파일에서 태어나고 서비스 파일에서 터진다.
   둘을 동시에 보는 사람이 없다.
2. **기본값이 위험한 쪽이다.** to-one의 기본값이 EAGER라서 **아무것도 안 하면
   위험한 상태가 된다.** 안전을 위해 매번 능동적으로 한 줄을 적어야 하는 구조는
   확률적으로 반드시 새어나간다.
3. **기능 추가만으로도 되살아난다.** fetch join으로 고친 API에 "화면에 배송지도
   보여달라"는 요구가 오면 `o.getDelivery().getAddress()` 한 줄이 붙는다. 이 PR의
   diff에는 fetch join이 없고, 리뷰어는 이 API가 예전에 N+1로 고생했다는 사실을
   모른다.

**재발하는 문제에 대한 올바른 대응은 "더 잘 보기"가 아니라 "테스트로 고정하기"다.**
이건 N+1만의 이야기가 아니고 회귀 일반의 처방이다. 버그를 고칠 때 재현 테스트를
먼저 쓰는 것과 정확히 같은 논리다 — 다만 N+1은 예외를 던지지 않아서 "실패하는
테스트"를 자연스럽게 얻지 못하고, **쿼리 수라는 관측 지표를 직접 단정해야만**
실패를 만들 수 있다.

면접에서는 이 프레임을 결론으로 놓는 것이 좋다. **"N+1은 성능 문제로 분류하면
계속 재발합니다. 회귀로 분류하고, 목록 API마다 쿼리 수를 단정하는 테스트를 둬서
다음 PR에서 되살아나면 빌드가 깨지게 만듭니다."** — 이 문장이 rationale이 말한
3단계다.

## 5. 꼬리질문 대비 포인트

### "쿼리 수를 못 박는 테스트는 리팩터링마다 깨진다. 유지보수 비용이 이득보다 크지 않나?" (시니어 변별 포인트)

타당한 지적이고, "그래도 해야 한다"로 밀면 감점이다. 세 단계로 다룬다.

**① 대상을 좁힌다.** 전 API가 아니라 **목록·검색 API에만** 붙인다. N+1은 컬렉션이나
연관을 순회하는 목록에서 터지고 단건 조회에서는 거의 안 터진다. 대상이 좁으면
유지보수량 자체가 작다.

**② 정확한 수보다 상한을 쓴다.** `isEqualTo(1)`은 정당한 변경에도 깨진다.
`isLessThanOrEqualTo(3)`이면 의도를 표현하면서 여유가 생긴다. 다만 상한을 크게
잡으면 감지력이 죽는다.

**③ 가장 좋은 형태는 절대 수가 아니라 "비례하지 않음"을 단정하는 것이다.** N+1의
정의가 "쿼리 수가 데이터 건수에 비례한다"이므로, **정의를 그대로 테스트로 옮기면**
매직 넘버가 사라진다.

```java
// 건수를 두 배로 늘려도 쿼리 수가 같아야 한다 — N+1 의 정의를 그대로 단정한다
@Test
void 쿼리_수가_데이터_건수에_비례하지_않는다() {
    int q10 = countQueries(() -> orderService.list(), /* 서로 다른 회원 */ 10);
    int q20 = countQueries(() -> orderService.list(), 20);

    assertThat(q20)
            .as("건수를 2배로 늘렸는데 쿼리가 늘었다 = N+1")
            .isEqualTo(q10);
}
```

이 형태는 **리팩터링으로 쿼리 수가 1개에서 2개로 바뀌어도 깨지지 않고, N+1이
생기면 반드시 깨진다.** 정확히 원하는 성질만 고정하는 테스트라서 유지보수 비용이
가장 낮다. 여기까지 말하면 이 꼬리질문은 오히려 가점이 된다. **(가산점 포인트)**

### "컬렉션이 둘 이상이고 페이징까지 필요한 화면은 어떻게 푸나?"

fetch join은 벽 둘에 동시에 걸려서 **애초에 후보가 아니다.** 순서대로 푼다.

1. **부모만 페이징으로 조회한다.** 조인이 없으니 `limit`/`offset`이 SQL에 정상
   적용된다. 이것이 출발점이고, 여기서 흔들리면 나머지가 다 무너진다.
2. **컬렉션은 `default_batch_fetch_size`에 맡긴다.** 각 컬렉션이 별도의 `IN`
   쿼리로 채워지므로 카테시안 곱이 없고, 총 쿼리는
   `1 + (컬렉션 종류 수 × ceil(부모 수 / size))` 수준이다. 부모 20건에 컬렉션
   2종, size 100이면 총 3개다.
3. **조회 전용이면 두 번(또는 세 번) 조회 후 조합**(§2-4)이 더 낫다. 필요한
   컬럼만 읽고 엔티티를 안 만든다.
4. **요구사항을 되짚는 단계도 답에 포함시킨다.** 컬렉션 둘이 진짜로 필요한
   경우보다, 하나는 **개수만** 필요한 경우가 많다. 그러면 컬렉션 fetch가 아니라
   집계 프로젝션(`count`)으로 끝난다. 도구로 밀어붙이기 전에 이걸 확인하는 게
   가장 저렴한 해결이다.

### "`default_batch_fetch_size`를 전역 1000으로 두면 부작용은?" (트레이드오프 판단)

성능 쪽 부작용 셋과, 그보다 중요한 부작용 하나가 있다.

- **`IN` 파라미터 수 한계** — DB마다 상한이 있다(오라클의 1000이 대표적). Hibernate가
  dialect의 파라미터 한계를 보고 배치를 잘라주므로 설정값이 그대로 SQL에 나가는 건
  아니지만, **설정값을 키운 만큼 효과가 나지 않는 구간**이 생긴다.
- **한 번에 올라오는 행 수** — size 1000이면 컬렉션 초기화 한 번에 수천~수만 행이
  메모리로 올라올 수 있다. 응답 지연이 특정 요청에 몰리는 스파이크가 된다.
- **실행 계획 캐시** — 바인딩 파라미터 개수가 다른 SQL이 여러 개 생기면 캐시가
  나뉜다. 다만 Hibernate 6.2 이후로는 SQL 모양이 고정(정확히 size개 플레이스홀더 +
  `null` 패딩, 또는 배열 파라미터 1개)되어 이 압박이 이전보다 줄었다(§2-3).
- **그리고 가장 중요한 부작용은 성능이 아니라 은폐다.** 1+1000이 1+1이 되면서
  증상이 사라지므로, **N+1이 있다는 사실 자체를 팀이 모르게 된다.** 그 상태로
  코드가 쌓이면 나중에 fetch 전략을 손볼 때 어디부터 봐야 하는지 알 수 없다.

그래서 답은 "전역 batch fetch size는 깔되, **§3의 탐지 장치와 세트로 깐다**"다.
안전망은 피해를 줄이는 장치이고 탐지는 원인을 드러내는 장치라서, 안전망만 깔면
**조용히 나빠지는 시스템**이 된다. 값은 100~1000 범위에서 시작하고, 실측 없이
1000으로 올리지 않는다.

### "이미 운영 중인 서비스에서 N+1이 어디 있는지 전수로 찾으려면?"

새로 만드는 팀이 아니라 **물려받은 팀**의 질문이고, 답의 순서가 곧 실행력이다.

1. **스테이징에 §3-3 스니퍼를 켜고 트래픽을 흘린다.** e2e 스크립트, 부하 테스트
   스크립트, 또는 운영 트래픽 미러링. 나오는 것은 **"같은 SQL이 몇 번 반복됐는가"
   상위 목록**이고, 이게 곧 작업 목록이다. 코드를 한 줄도 안 고치고 현황이 나오는
   것이 이 방법의 장점이다.
2. **APM을 쿼리 수 순으로 정렬한다**(§3-5). 응답 시간 순으로 보면 안 보인다.
3. **`Statistics`를 Micrometer로 노출해 비율 지표를 만든다.** `쿼리 실행 수 / 요청
   수`를 대시보드에 올리면, 특정 배포 이후 비율이 튀는 것으로 회귀를 잡을 수 있다.
4. **정적으로도 좁힌다.** ArchUnit·grep으로 to-one EAGER 매핑과 목록을 반환하는
   리포지토리 메서드를 교차하면 후보가 나온다. 다만 정적 탐색은 사용처에서 태어나는
   유형을 못 잡으므로 보조 수단이다.

우선순위는 **트래픽 × 카디널리티**가 큰 API부터다. 하루 10회 호출되는 관리자
화면의 1+300은 급하지 않고, 초당 100회 호출되는 목록의 1+20이 훨씬 급하다.
그리고 **고친 API마다 §3-1의 테스트를 남긴다** — 이게 없으면 같은 작업을 1년
뒤에 또 한다.

### "이 장치들을 팀에 도입한다면 어느 순서로 넣나?" (시니어 변별 포인트)

전부 한 번에 넣으면 실패한다. **도입 비용·거짓 양성·즉시 이득**을 기준으로
순서를 잡는다.

1. **전역 `default_batch_fetch_size`** — 설정 한 줄, 코드 수정 0, 즉시 피해 감소.
   단독으로 두면 §2-3의 은폐가 생기므로 2번과 같은 스프린트에 넣는다.
2. **요청 단위 스니퍼(개발·스테이징)** — 기존 코드 수정이 0이고 프로파일로 격리돼
   위험이 낮은데, **현황 목록이 나온다.** 무엇을 고칠지 모르는 상태에서 테스트를
   먼저 쓰는 것은 순서가 거꾸로다.
3. **쿼리 수 단정 테스트** — 2번에서 나온 **상위 API부터** 붙인다. 전면 도입을
   시도하면 분량에 압사당해 중단된다. "새로 만드는 목록 API에는 반드시 붙인다"를
   컨벤션으로 추가하면 시간이 지나면서 커버리지가 자동으로 올라간다.
4. **ArchUnit EAGER 금지** — 기존 위반이 많으면 `FreezingArchRule`로 동결해
   **신규 유입만 차단**하고, 동결 목록을 스프린트마다 줄인다.
5. **APM 대시보드에 쿼리 수/요청 지표** — 마지막 그물. 앞의 넷이 없는 상태에서
   이것만 있으면 "운영에서 발견하는 팀"이다.

관통하는 원칙은 **현황 파악 → 상위부터 고정 → 신규 유입 차단**이다. 그리고 3번과
4번은 성질이 다르다는 점을 말하면 좋다 — **3번은 결과를 고정하고 4번은 원인을
봉쇄한다.** 둘 중 하나만 고르라면 3번이다. 매핑이 완벽해도 N+1은 사용처에서
태어나기 때문이다.

---

## 한 줄 요약

N+1의 N은 결과 행 수가 아니라 **1차 캐시에 없는 서로 다른 연관 id 수**라서
건수만 늘린 픽스처로는 재현되지 않고(픽스처는 **카디널리티**로 설계한다),
해결책은 **행이 뻥튀김되는 조인 계열**(`fetch join`·`@EntityGraph` — 컬렉션 +
페이징 금지, 컬렉션 둘 이상 금지)과 **행이 늘지 않는 분리 조회 계열**(batch
fetch size·DTO 두 번 조회 — 페이징과 공존)로 갈리므로 **"컬렉션 + 페이징이면
fetch join을 버린다"** 가 선택 기준의 핵심이며, 무엇보다 **N+1은 성능 문제가
아니라 회귀**여서 한 번 고쳐도 다음 PR에서 되살아나므로 — 쿼리 로그를 잘 보는
습관이 아니라 **쿼리 수를 단정하는 테스트·요청 단위 카운터·ArchUnit이라는 자동
장치로 고정**해야 한다.
