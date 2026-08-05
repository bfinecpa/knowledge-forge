# 즉시 로딩 vs 지연 로딩 — 기본값이 EAGER인 연관, JPQL이 N+1이 되는 번역 원리, 되돌릴 수 있는 기본값

> 핵심 관전 포인트: 정의("함께 vs 쓸 때")는 출발점일 뿐이고, 실제로 갈리는 건 세 가지다. ① **기본값을 가르는 축은 "즉시 로딩 가능성"이 아니라 단일 값 연관(to-one) vs 컬렉션 연관(to-many)** 이다 — `@ManyToOne`·`@OneToOne`이 **EAGER**, `@OneToMany`·`@ManyToMany`가 LAZY. 실무에서 가장 많이 쓰는 `@ManyToOne`이 EAGER라서, **LAZY를 기본 전략으로 쓴다는 말은 to-one 전부에 손으로 `fetch = FetchType.LAZY`를 적는다는 뜻**이다. ② **JPQL에서 EAGER는 조인이 아니라 N+1이 된다** — JPQL은 작성한 대로 SQL로 번역되고 **글로벌 fetch 전략은 그 번역에 개입하지 않는다.** 번역된 SQL을 실행한 뒤 Hibernate가 EAGER 계약을 지키려고 연관을 추가 SELECT로 채운다. 무서운 건 **`find()`는 조인이 나가므로 단건 테스트에서는 절대 안 보이고 목록 API에서만 터지는 비대칭**이다. ③ **EAGER를 금지하는 결정적 근거는 "낭비"가 아니라 되돌릴 수 없다는 성질**이다 — LAZY를 특정 쿼리에서 켜는 건 `join fetch` 한 줄인데, EAGER를 특정 쿼리에서 끄는 건 기본 경로로는 불가능하다(fetchgraph라는 예외가 있으나 결론을 뒤집지 못한다 → §4-3). 그래서 **기본값은 되돌릴 수 있는 방향으로 둔다.** 정답 조합은 **LAZY 전역 기본 + 필요한 지점에서 명시적 fetch**(fetch join / `@EntityGraph` / `@BatchSize` / DTO 프로젝션)이고, LAZY의 대가(`LazyInitializationException`, 접근 지점의 N+1)를 아는 상태에서의 선택이어야 한다.

---

## 0. 질문 + 의도

**질문**: "즉시 로딩(EAGER)과 지연 로딩(LAZY)의 차이, 기본 전략을 어떻게
가져가나요?"

**출제 의도**: 기본값을 잘못 두면 **스키마가 커질수록 조회 하나가 조인 폭탄이
된다.** 초기 설계 결정이 1년 뒤 성능을 결정하는 대표 사례라, 면접관은 답보다
**기본 전략의 근거**를 듣고 싶어 한다. 즉 이 질문은 지식 문제가 아니라
**"비가역적 결정을 근거를 갖고 내려본 적 있는가"** 를 보는 자리다.

**함정**: 정의와 "LAZY를 기본으로 씁니다"는 대부분 맞게 답한다. 갈리는 지점은
넷이다.

1. **`@ManyToOne`의 기본값을 LAZY라고 답한다.** 실무에서 가장 많이 쓰는 연관인데
   기본값이 EAGER다. 이걸 틀리면 "LAZY를 기본으로 쓴다"는 진술 자체가
   코드에서 지켜지고 있는지 의심받는다(§2).
2. **JPQL에서 EAGER가 조인으로 안 나가는 "이유"를 못 말한다.** "JPA 설정 상"은
   답이 아니다 — 설정이 아니라 **JPQL 번역 원리**다(§3).
3. **그 귀결이 N+1이라는 것을 스스로 연결하지 못한다.** 관찰("작성한 쿼리대로
   나간다")까지는 하는데 "그럼 EAGER 연관은 누가 채우나"를 되묻지 않는다(§3-3).
4. **LAZY를 고른 근거가 "안 쓰는 곳이 더 많아서" 한 축뿐이다.** 그건 낭비 회피
   논거이고, 면접관이 기다리는 건 **되돌릴 수 없는 기본값을 피한다**는 설계
   논거다(§4-3).

## 1. LAZY의 실체는 프록시 — 여기까지만 알고 가면 나머지가 다 풀린다

"쓸 때 불러온다"는 설명은 결과이고, 구조는 이렇다. LAZY 연관 필드에는
**엔티티가 아니라 Hibernate가 런타임에 만든 하위 클래스 인스턴스(프록시)** 가
들어가 있다.

용어 두 개만 풀어두자.

- **프록시(proxy, 대리인)**: 원본 클래스를 상속해 만든 껍데기 객체.
  겉보기 타입은 같아서 `Member`를 기대하는 코드에 그대로 넘길 수 있지만,
  내부에는 **id 하나와 "아직 안 채웠다"는 표시**만 있다.
- **초기화(initialize)**: 프록시의 메서드가 처음 호출되는 순간 Hibernate가
  SELECT를 날려 실제 값을 채우는 동작.

```java
@Transactional
public void demo(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    // 여기까지 SELECT 1건 (orders 만)

    Member m = order.getMember();
    // 아직 SELECT 없음. m 은 Member$HibernateProxy 인스턴스이고
    // 안에는 member_id 값만 들어 있다.
    System.out.println(m.getClass());   // class Member$HibernateProxy$xxxx

    m.getName();
    // 이 순간 SELECT member ... where id = ? 가 나간다 (초기화)
}
```

여기서 곧바로 두 가지가 따라 나온다.

- **id는 쿼리 없이 읽을 수 있다.** `order.getMember().getId()`는 프록시가 이미
  갖고 있는 값이라 초기화가 일어나지 않는다(연관 FK가 `orders` 테이블에 있으므로).
  "id만 필요한데 왜 쿼리가 나가지?" 같은 오해를 이 문장으로 정리할 수 있다.
  **확인 범위**: Hibernate가 그 게터를 식별자 게터로 인식할 때 성립한다 —
  접근 방식(필드/프로퍼티)이나 게터 이름 구성에 따라 초기화가 일어나는 경우도
  보고되므로, 이 성질에 성능을 기대는 코드를 쓸 거라면 쿼리 로그로 확인해야 한다.
- **초기화는 영속성 컨텍스트가 살아 있을 때만 가능하다.** 트랜잭션이 끝난 뒤
  (컨트롤러·뷰·직렬화 시점에) 프록시를 건드리면
  `LazyInitializationException`이 난다. 이건 LAZY의 버그가 아니라 **LAZY를
  고르면서 지불하기로 한 대가**다(별도 문항이 있으므로 여기서는 존재만 짚는다).

또 하나 — **프록시를 만들려면 "연관이 null인지 아닌지"를 알아야 한다.**
FK가 내 테이블에 있으면 그 값이 null인지 보면 되니까 문제가 없다. 이 전제가
깨지는 자리가 딱 하나 있고, 그게 §6의 함정이다.

## 2. 연관관계별 기본값 — 가르는 축은 "단일 값 vs 컬렉션"

| 애노테이션 | 기본 `fetch` | 성질 |
|---|---|---|
| `@ManyToOne` | **EAGER** | 단일 값 연관(to-one). FK가 내 테이블에 있고 결과는 0~1건 |
| `@OneToOne` | **EAGER** | 단일 값 연관(to-one). 결과는 0~1건 |
| `@OneToMany` | LAZY | 컬렉션 연관(to-many). **결과 건수를 예측할 수 없다** |
| `@ManyToMany` | LAZY | 컬렉션 연관(to-many). 조인 테이블까지 얹힌다 |

### 2-1. 왜 이 축인가

"1대1은 즉시 로딩 가능성이 높고 다대1은 낮아서"라는 설명은 사실과 다르다.
명세가 본 것은 **결과 크기를 컴파일 시점에 알 수 있는가**다.

- **to-one**: 조인해서 붙는 행이 최대 1건이다. 결과셋 크기가 늘지 않으므로
  "같이 가져와도 손해가 크지 않다"고 명세가 판단한 것이다.
- **to-many**: 붙는 행이 3건일 수도 30만 건일 수도 있다. 그리고 컬렉션을 조인하면
  **부모 행이 자식 수만큼 복제**되어 결과셋 자체가 곱셈으로 커진다. 여기에
  EAGER를 기본값으로 두는 것은 명세 차원에서도 무리다.

즉 기준은 "쓸 확률"이 아니라 **"기본값으로 켰을 때 최악의 비용이 유한한가"**
다. 이렇게 말하면 암기가 아니라 원리로 답한 것이 된다.

### 2-2. 이 사실을 놓치기 쉬운 이유 — 놓치면 전략이 무너진다

`@ManyToOne`이 EAGER라는 걸 잊는 데는 구조적인 이유가 있다.

- **애노테이션에 안 보인다.** `@ManyToOne`이라고만 적으면 EAGER인데, 코드에는
  EAGER라는 글자가 어디에도 없다. 반대로 LAZY는 늘 명시되어 있으니 눈에 남는다.
  **"명시된 것만 기억에 남고, 기본값은 안 보인다."**
- **`@OneToMany`가 LAZY라는 사실이 기억을 오염시킨다.** "컬렉션이 무거우니까
  LAZY, JPA도 성능을 생각하니까 나머지도 LAZY겠지"라는 추론이 자연스럽게
  일어난다. 실제로는 반대다.
- **단건 조회에서는 티가 안 난다.** `find()`가 조인 한 방으로 끝나므로
  개발 중에 문제로 인식되지 않는다(§3).

그래서 결론은 하나다 — **"기본 전략은 LAZY입니다"는 to-one 전부에 손으로 적어야
비로소 사실이 된다.**

```java
// Before: "우리 프로젝트 기본 전략은 LAZY 입니다" 라고 말하지만 실제로는 전부 EAGER
@Entity
public class Order {
    @Id @GeneratedValue
    private Long id;

    @ManyToOne                       // ← 기본값 EAGER. 코드에 EAGER 글자가 없어서 안 보인다
    @JoinColumn(name = "member_id")
    private Member member;

    @OneToOne                        // ← 기본값 EAGER
    @JoinColumn(name = "delivery_id")
    private Delivery delivery;

    @OneToMany(mappedBy = "order")   // ← 이건 원래 LAZY (기본값이 이미 LAZY)
    private List<OrderItem> items = new ArrayList<>();
}

// After: to-one 에 예외 없이 LAZY 를 명시 — 컬렉션은 기본값이 이미 LAZY 지만 의도를 남긴다
@Entity
public class Order {
    @Id @GeneratedValue
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "member_id")
    private Member member;

    @OneToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "delivery_id")   // 주인 쪽이라 LAZY 가 실제로 걸린다 (§6)
    private Delivery delivery;

    @OneToMany(mappedBy = "order", fetch = FetchType.LAZY)
    private List<OrderItem> items = new ArrayList<>();
}
```

빠뜨림을 사람의 주의력에 맡기지 않는 방법도 함께 말하면 좋다 —
**엔티티 소스에 `@ManyToOne(` 뒤에 `fetch`가 없으면 실패시키는 정적 검사**
(ArchUnit 규칙, 커스텀 린트, 하다못해 CI의 grep)를 걸어두는 것이다.
리뷰로 잡는 것보다 확실하다. **(가산점 포인트)**

## 3. JPQL에서 EAGER가 N+1이 되는 메커니즘 — 이 문항의 최대 변별 지점

"EAGER면 조인 한 번에 다 가져오니 효율적 아닌가?"라는 반론에 정확히 답하려면
**로드 경로가 두 개**라는 것부터 분리해야 한다.

### 3-1. 두 개의 경로 — `find()`는 조인, 쿼리는 추가 SELECT

| 경로 | 예 | EAGER to-one을 채우는 방식 |
|---|---|---|
| **엔티티 로드** | `em.find()`, `findById()` | **조인**. SQL을 Hibernate가 직접 만들므로 fetch 전략을 반영할 수 있다 |
| **엔티티 쿼리** | JPQL, Criteria, QueryDSL, 파생 쿼리 | **본 쿼리 실행 후 추가 SELECT**. 그래서 1 + N |

`find()` 쪽은 이해가 쉽다. **SQL의 저자가 Hibernate**이기 때문이다. "id로
`Order` 하나를 가져와라"는 요청만 받았으니, Hibernate가 매핑을 보고 EAGER
연관까지 포함한 SQL을 스스로 조립한다.

```sql
-- em.find(Order.class, 1L) — @ManyToOne(EAGER) member 가 조인으로 함께 나온다
select o.id, o.status, o.total_price, o.member_id,
       m.id, m.name, m.team_id
from orders o
left join member m on m.id = o.member_id      -- 연관이 optional=false 로 선언되면 inner join
where o.id = ?
```

### 3-2. JPQL은 "작성한 쿼리"가 SQL의 원본이다

문제는 두 번째 경로다. JPQL을 쓰는 순간 **SQL의 저자가 개발자로 바뀐다.**
JPQL은 엔티티·필드 이름을 테이블·컬럼 이름으로 바꾸는 **번역기**이고,
번역의 입력은 매핑에 선언된 fetch 전략이 아니라 **내가 쓴 쿼리 문장**이다.

```sql
-- Before: JPQL — select o from Order o   (@ManyToOne member 는 EAGER 기본값 그대로)
-- ① 번역 결과: 작성한 대로. join 이 없다. 글로벌 fetch 전략은 이 번역에 개입하지 않는다
select o.id, o.status, o.total_price, o.member_id from orders o;

-- ② 그런데 member 는 EAGER 다. 결과를 돌려주기 전에 반드시 채워져 있어야 한다
--    → Hibernate 가 행마다 추가 SELECT 를 쏜다
select m.id, m.name, m.team_id from member m where m.id = ?;   -- 1
select m.id, m.name, m.team_id from member m where m.id = ?;   -- 2
-- ... 서로 다른 member 가 100 명이면 100 번. 총 1 + 100 = 101 개 쿼리

-- After: join fetch 를 손으로 적으면 번역 결과에 조인이 들어간다
-- select o from Order o join fetch o.member
select o.id, o.status, o.total_price, o.member_id,
       m.id, m.name, m.team_id
from orders o
inner join member m on m.id = o.member_id;                     -- 총 1 개 쿼리
```

핵심 문장은 이것이다 — **"JPQL은 작성한 대로 SQL로 번역되고, 글로벌 fetch
전략은 그 번역에 개입하지 않는다. 번역된 SQL을 실행한 뒤에야 Hibernate가 EAGER
계약을 지키려고 연관을 추가 쿼리로 채운다."**

Hibernate 공식 문서도 같은 말을 한다 — "엔티티 쿼리의 fetch 정책은 재정의될 수
없으므로, Hibernate는 결과를 사용자에게 돌려주기 전에 EAGER 연관이 채워졌음을
보장하기 위해 보조 SELECT를 필요로 한다. EAGER 연관을 `join fetch` 하는 것을
잊으면 그 하나하나에 대해 보조 SELECT를 발행하고, 이는 N+1 문제로 이어진다."

### 3-3. "설정 문제"가 아니라 "번역 원리"라고 말해야 하는 이유

이 차이가 왜 채점 지점인가. **"설정 상 그렇다"고 답하면 "설정을 바꾸면 조인이
나가겠네"라는 잘못된 결론**으로 이어진다. 그런 설정은 없다. 조인이 나가려면
**쿼리 문장 자체가 달라져야** 한다 — 그게 `join fetch`이고 `@EntityGraph`다.

번역 원리로 이해했다는 증거가 하나 더 있다. **`select o from Order o`와
`select o from Order o join o.member m`(fetch 없는 그냥 조인)은 총 쿼리 수가
같다.** 조인은 SQL에 들어가지만 그건 필터·정렬용이고, 결과셋에서 `member`
컬럼을 가져오지 않으므로 EAGER 연관은 여전히 추가 SELECT로 채워진다.
**"조인"과 "fetch(결과에 담기)"는 다른 이야기**라는 것 — 이걸 말하면 원리로
이해했다는 신호가 된다. **(가산점 포인트)**

### 3-4. N의 정체 — "행 수"가 아니라 "컨텍스트에 없는 서로 다른 id 수"

정확히 말하면 추가 SELECT는 행마다 무조건 나가지 않는다. Hibernate는 각 행의
FK로 **먼저 영속성 컨텍스트(1차 캐시)를 뒤지고**, 없을 때만 SELECT를 쏜다
(1차 캐시의 성질은
[persistence-context-dirty-checking.md](persistence-context-dirty-checking.md)
§1 참고).

그래서 N은 **"결과 100건"이 아니라 "그 100건이 가리키는 서로 다른 회원 중 아직
컨텍스트에 없는 수"** 다. 이게 실무에서 더 고약한 이유가 있다.

- **테스트 데이터는 회원이 1~2명**이라 1 + 1로 끝난다. "N+1 없네" 하고 넘어간다.
- **운영은 주문 100건이 서로 다른 회원 100명**이라 1 + 100이 된다.
- 데이터 분포에 따라 증상이 있다가 없다가 하므로 **"재현이 안 되는 성능 이슈"**
  로 분류되고 방치된다.

### 3-5. 그래서 진짜 위험은 비대칭성이다

```flow
# 같은 EAGER 매핑인데 로드 경로에 따라 쿼리 수가 1 과 1+N 으로 갈린다. 단건 테스트는 언제나 통과하고, 목록 API 만 운영에서 터진다 — EAGER 를 금지하는 첫 번째 근거.
== 경로 A · em.find(Order.class, 1L) — SQL 의 저자가 Hibernate
① 매핑을 보고 SQL 을 조립한다 | EAGER 연관을 조인에 포함시킬 수 있다
② 쿼리 1 개로 끝난다 | 단건 조회 테스트·개발 중 확인에서 전혀 문제가 보이지 않는다
== 경로 B · JPQL "select o from Order o" — SQL 의 저자가 개발자
③ 작성한 문장을 그대로 SQL 로 번역 | 글로벌 fetch 전략은 이 번역에 개입하지 않는다. join 이 없다
④ 번역된 SQL 실행 → 주문 100 건 확보 | 여기까지 쿼리 1 개
⑤ EAGER 계약을 지키려고 연관을 채운다 | 행마다 FK 로 1 차 캐시 확인 → 없으면 SELECT
  - 서로 다른 member 100 명이면 SELECT 100 회 | N 은 행 수가 아니라 "캐시에 없는 서로 다른 id 수"
  ! 총 101 개 쿼리 → 목록 API 만 느려진다 | 테스트 데이터는 회원 1~2 명이라 1+1 로 끝나 재현되지 않는다
== 해결은 설정이 아니라 쿼리 문장
⑥ join fetch / @EntityGraph 로 번역 결과를 바꾼다 | "설정을 바꾼다"로는 해결되지 않는 이유
```

## 4. EAGER를 기본값으로 두지 않는 세 근거

"안 쓰는 곳이 더 많아서 낭비"는 맞는 말이지만 **가장 약한 근거**다. 낭비는
측정해서 감수할 수도 있는 성질의 문제인데, 아래 셋은 감수의 대상이 아니다.

### 4-1. ① JPQL 비대칭 — 개발에서 안 보이고 운영에서 터진다

§3의 내용이 그대로 첫 번째 근거다. **개발·테스트에서 잡히지 않는 성능 결함**은
"성능이 나쁘다"보다 나쁘다. 목록 API, 페이징, 엑셀 내려받기, 배치 — 데이터가
많은 쪽에만 정확히 나타나기 때문이다.

### 4-2. ② 연쇄 전파 — 조인 depth가 누적된다

EAGER는 **전염된다.** `find()` 경로에서 Hibernate는 EAGER 연관을 조인으로
붙이는데, 그 연관 엔티티의 EAGER 연관도 다시 붙여야 한다.

```java
// Before: to-one 을 전부 기본값으로 방치 — 각 EAGER 가 서로를 끌어온다
@Entity class Order  { @ManyToOne Member member; @OneToOne Delivery delivery; }
@Entity class Member { @ManyToOne Team team; @OneToOne Grade grade; }
@Entity class Team   { @ManyToOne Company company; }
@Entity class Company{ @ManyToOne Address hq; }

// orderRepository.findById(1L) 한 줄에서 나가는 SQL:
//   orders
//     left join member    left join delivery
//       left join team      left join grade
//         left join company
//           left join address
// → 주문 1건을 보려고 테이블 7개가 조인된다. 여기에 감사 로그·코드 테이블이
//   몇 개 더 붙으면 10개가 금방 넘는다.
// 문제는 이게 "누가 EAGER 를 켰는가"로 추적되지 않는다는 것 — 아무도 켜지
// 않았고, 전부 기본값이다.

// After: to-one 전부 LAZY. 전파 경로가 끊긴다
@Entity class Order  { @ManyToOne(fetch = LAZY) Member member;
                       @OneToOne(fetch = LAZY)  Delivery delivery; }
@Entity class Member { @ManyToOne(fetch = LAZY) Team team;
                       @OneToOne(fetch = LAZY)  Grade grade; }
// findById(1L) → select ... from orders where id = ?  (테이블 1개)
// team 이 필요한 화면에서만 join fetch 로 그 화면만큼 켠다
```

여기서 강조할 점은 **비용이 곱셈으로 커진다는 것보다, 원인이 국소적이지 않다는
것**이다. `Order`를 조회하는 코드가 느려진 이유가 `Company` 엔티티에 누군가
추가한 `@ManyToOne` 한 줄일 수 있다. **모듈 경계를 넘어 성능이 결합된다** —
설계에서 가장 피해야 하는 종류의 결합이다.

### 4-3. ③ 결정적 근거 — 되돌릴 수 없는 기본값

두 방향의 난이도를 나란히 놓으면 답이 나온다.

| | 켜기(더 가져오기) | 끄기(덜 가져오기) |
|---|---|---|
| **LAZY 기본** | 그 쿼리에 `join fetch` / `@EntityGraph` 한 줄 | (필요 없음) |
| **EAGER 기본** | (필요 없음) | **기본 경로로는 불가능** |
| 실수했을 때 | N+1이 **쿼리 로그에 즉시 보인다** | 쿠키처럼 조용히 무거워진다 |

**LAZY는 지점별로 켤 수 있고, EAGER는 지점별로 끌 수 없다.** 그래서 기본값을
LAZY로 두면 "부족한 곳을 필요할 때 채우는" 게임이 되고, EAGER로 두면 "과한 곳을
줄일 방법이 없는" 게임이 된다. 이걸 원칙으로 승격하면 —

> **기본값은 되돌릴 수 있는 방향으로 둔다.** 되돌릴 수 없는 기본값은 시간이
> 지날수록 선택지를 잃게 만든다.

이 논거가 "안 쓰는 곳이 더 많아서"보다 한 층 위인 이유는, **비용 계산이 틀려도
살아남는 논거**이기 때문이다. 설령 대부분의 화면에서 연관을 쓴다고 밝혀져도
(= 낭비 논거가 무너져도) "지점별로 끌 수 없다"는 성질은 그대로 남는다.
이건 fetch 전략에 국한된 이야기가 아니라 캐시 켜기/끄기, 기본 트랜잭션 전파,
기본 타임아웃에도 그대로 적용되는 설계 원칙이다. **(가산점 포인트)**

#### 널리 퍼진 "EAGER는 절대 끌 수 없다"는 설명의 교정

정확히 말하면 **"기본 경로로는 끌 수 없다"** 가 맞다. JPA 명세에는
`jakarta.persistence.fetchgraph` 힌트가 있고 — 스프링 데이터에서는
`@EntityGraph(type = EntityGraphType.FETCH)` — 명세는 **그래프에 명시되지 않은
속성을 `FetchType.LAZY`로 취급한다**고 규정한다. 즉 그래프를 비워 넘기면 EAGER
연관도 프록시로 남는다. Hibernate는 이 기능을 **5.5부터 구현**했다(그 이전에는
힌트가 사실상 무시됐다).

그런데 이 교정은 결론을 뒤집지 못한다.

- **힌트를 붙인 쿼리에서만 꺼진다.** 나머지 쿼리 전부는 여전히 EAGER다.
  "끌 수 있다"가 아니라 "쿼리마다 손으로 꺼야 한다"이고, 하나 빠뜨리면 조용히
  원래대로 돌아간다.
- **`loadgraph`(`EntityGraphType.LOAD`)로는 안 된다.** 명세상 `loadgraph`는
  그래프에 없는 속성을 **선언된 fetch 타입대로** 처리하므로 EAGER는 EAGER로
  남는다. 이름이 비슷해 가장 헷갈리는 지점이다.
- **비용의 비대칭은 그대로다.** LAZY를 켜는 쪽은 `join fetch` 한 줄이고,
  잊으면 N+1이 로그에 바로 보인다. EAGER를 끄는 쪽은 힌트를 정확히 골라
  전 쿼리에 발라야 하고, 잊으면 아무 신호가 없다.

**확인 범위**: `fetchgraph`가 EAGER를 재정의한다는 동작은 Hibernate 5.5 이상에
대해 문서로 확인했다. 6.x 각 마이너 버전에서 to-one/컬렉션별로 어떻게 동작하는지는
편차가 있을 수 있으니, 실제로 쓸 거라면 **프로젝트 버전에서 쿼리 로그로 확인**하는
편이 안전하다. 면접에서는 "원칙적으로 불가능"보다 **"fetchgraph라는 예외가 있지만
쿼리마다 손으로 발라야 하므로 기본값 선택의 결론은 바뀌지 않는다"** 라고
말하는 편이 정확하고 인상도 좋다. **(가산점 포인트)**

## 5. 정답 조합 — LAZY 전역 기본 + 지점별 명시적 fetch

전략은 두 문장이다. **매핑에서는 전부 LAZY로 둔다. 어떤 데이터를 함께 가져올지는
매핑이 아니라 쿼리(=유스케이스)가 정한다.**

이게 왜 옳은 분업인가 — **"연관을 함께 써야 하는가"는 화면마다 다른 질문이고,
매핑은 화면을 모른다.** 매핑에 EAGER를 적는 것은 모든 유스케이스를 대신해
한 번에 결정해버리는 행위다.

### 5-1. 켜는 도구 네 개 — 언제 무엇을 쓰나

| 도구 | 쓰는 자리 | 주의 |
|---|---|---|
| `join fetch` | JPQL/QueryDSL에서 그 쿼리만 | **컬렉션 fetch join + 페이징은 금지** — limit이 SQL에 붙지 못하고 전체를 메모리에 올린다 |
| `@EntityGraph` | 스프링 데이터 리포지토리 메서드 | 쿼리 문장을 안 고치고 붙일 수 있어 파생 쿼리에 적합 |
| `@BatchSize` / `default_batch_fetch_size` | 컬렉션이 여러 개거나 fetch join이 안 되는 자리 | 1+N을 1+(N/size)로 줄이는 **완화책**. 없애는 건 아니다 |
| **DTO 프로젝션** | 조회 전용 화면·목록 API | 필요한 컬럼만 select. 엔티티를 안 만들므로 이 문제 범주 자체가 사라진다 |

우선순위 감각까지 말하면 좋다. **쓰기(도메인 로직)는 엔티티 + fetch join,
읽기 전용 화면은 DTO 프로젝션**이 기본이다. 조회 전용인데 엔티티를 올리는 건
지연 로딩 논쟁 이전에 이미 비용을 지불하는 선택이다(스냅샷·flush 비용 →
[persistence-context-dirty-checking.md](persistence-context-dirty-checking.md) §2).

```java
// Before: LAZY 로 잘 깔아뒀지만, 목록 API 에서 연관을 쓰면 결국 N+1
@Transactional(readOnly = true)
public List<OrderDto> list() {
    return orderRepository.findAll().stream()          // 쿼리 1
            .map(o -> new OrderDto(o.getId(),
                                   o.getMember().getName()))   // 프록시 초기화 × N
            .toList();
}
// → LAZY 라고 N+1 이 사라지는 게 아니다. "접근 지점"으로 옮겨간 것일 뿐이다.

// After: ① 필요한 연관만 그 쿼리에서 켠다  ② 조회 전용이면 애초에 엔티티를 만들지 않는다
//   ① 도메인 로직이 엔티티를 필요로 하는 경우
@Query("select o from Order o join fetch o.member")
List<Order> findAllWithMember();

//   ② 읽기 전용 목록 API — 더 근본적. 엔티티도 프록시도 스냅샷도 만들지 않는다
@Query("""
       select new com.example.OrderDto(o.id, m.name)
       from Order o join o.member m
       """)
List<OrderDto> findAllDto();
```

### 5-2. LAZY의 대가를 아는 상태에서의 선택이어야 한다

면접에서 감점되는 답은 "LAZY가 좋으니까 LAZY"다. LAZY에도 대가가 둘 있고,
이걸 함께 말해야 트레이드오프를 아는 답이 된다.

- **`LazyInitializationException`** — 트랜잭션 밖에서 프록시를 건드리면 터진다.
  대응은 **경계 안에서 필요한 걸 다 채워 DTO로 내보내는 것**이다. "OSIV를
  켜서 해결"은 커넥션을 뷰 렌더링까지 붙잡아두는 대가를 숨기는 선택이고,
  "그래서 EAGER로 바꿨다"는 문제를 §4로 되돌리는 선택이다.
- **접근 지점의 N+1** — §5-1의 before 코드가 그것이다. LAZY는 N+1을 없애지
  않고 **발생 지점을 예측 가능한 곳(내가 연관을 건드리는 줄)으로 옮긴다.**
  그 대신 로그에 즉시 보이고 그 쿼리에 fetch join을 붙여 고칠 수 있다 — 이게
  §4-3에서 말한 "되돌릴 수 있음"의 실체다.

그리고 전략의 마지막 조각은 도구가 아니라 습관이다. **쿼리 로그를 상시 켜두고,
목록 API에는 쿼리 수를 단정하는 테스트를 둔다.** N+1은 "해결책을 아는가"보다
**"운영 전에 발견하는 장치가 있는가"** 로 평가된다.

```java
// 쿼리 수를 못 박는 테스트 — 사람의 주의력이 아니라 빌드가 잡게 만든다
@Test
void 주문목록은_쿼리_한번이어야_한다() {
    var stats = entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
    stats.clear();

    orderService.list();

    assertThat(stats.getPrepareStatementCount()).isEqualTo(1);
    // 누가 to-one 에 EAGER 를 추가하거나 fetch join 을 빼면 이 테스트가 깨진다
}
```
(`getStatistics()`를 쓰려면 `spring.jpa.properties.hibernate.generate_statistics=true`가
필요하다. 정확한 카운터 이름은 Hibernate 버전에 따라 다를 수 있어 프로젝트에서
확인이 필요하다.)

## 6. 함정 — `@OneToOne`의 주인이 아닌 쪽은 LAZY가 걸리지 않는다

`fetch = LAZY`를 적었는데도 즉시 쿼리가 나가는 자리가 있다. **`mappedBy`가 붙은
쪽(연관관계의 주인이 아닌 쪽)의 `@OneToOne`** 이다.

```java
// Before: LAZY 를 적었지만 걸리지 않는다
@Entity
public class Member {
    @Id @GeneratedValue private Long id;

    @OneToOne(mappedBy = "member", fetch = FetchType.LAZY)   // ← 무시된다
    private Locker locker;
}

@Entity
public class Locker {
    @Id @GeneratedValue private Long id;

    @OneToOne(fetch = FetchType.LAZY)      // 이쪽은 FK 를 갖고 있어 LAZY 가 걸린다
    @JoinColumn(name = "member_id")        // ← FK 는 locker 테이블에 있다
    private Member member;
}

// em.find(Member.class, 1L) 하면:
//   select ... from member where id = ?
//   select ... from locker where member_id = ?   ← LAZY 인데도 즉시 나간다
```

이유는 §1의 마지막 문장에서 이미 나왔다. **프록시를 넣으려면 연관이 null인지
아닌지를 알아야 하는데, FK가 상대 테이블(`locker`)에 있어서 알 수 없다.**
`member` 테이블만 봐서는 사물함이 있는 회원인지 알 방법이 없고, `locker.locker`
필드에 프록시를 넣어놨다가 실제로 행이 없으면 **`null`이어야 할 자리에 객체가
들어가 있는** 상태가 된다. 그럴 수는 없으니 Hibernate는 "어차피 `locker`를
조회해봐야 아는 거라면 지금 조회해서 실제 엔티티(또는 null)를 넣자"를 택한다.

반대로 주인 쪽(`Locker.member`)은 `locker.member_id` 값이 있는지 보면 되므로
프록시를 안전하게 만들 수 있다 — **같은 `@OneToOne`인데 방향에 따라 갈리는
이유가 이것**이다. `@ManyToOne`이 늘 LAZY로 잘 걸리는 이유도 같다(항상 FK를
가진 쪽이므로).

### 6-1. 대응 — 우선순위 순

1. **역방향 연관을 아예 매핑하지 않는다.** 가장 확실하다. `Member`에서
   사물함이 필요한 화면이 몇 개 안 되면 `lockerRepository.findByMemberId(id)`로
   조회하는 쪽이 낫다. **양방향 매핑은 공짜가 아니다.**
2. **공유 PK(`@MapsId`)로 만든다.** 자식이 부모의 PK를 자기 PK로 그대로 쓰면
   (`locker.id == member.id`) 부모 쪽 연관 없이도 id 하나로 조회할 수 있다.
   1:1 관계의 정석 매핑이기도 하다.
3. **`optional = false`** — "이 연관은 반드시 존재한다"고 선언하면 null 여부를
   조회할 필요가 없어져 프록시가 가능해진다는 접근이다. 다만 이건 **주의해서
   써야 한다**(아래 확인 범위).

**확인 범위**: `mappedBy` 쪽에 `optional = false`를 주면 LAZY가 걸리는지는
**Hibernate 버전에 따라 다르다고 보고되어 있다.** 조사한 자료(Thorben Janssen)는
"일부 버전에서는 동작하지만 모든 버전에서 동작하지는 않으며, 향후 업데이트에서
바뀔 수 있음을 감수해야 한다"고 명시한다. 이 문서에서는 **버전별로 확실히
동작한다고 단정하지 않는다** — 쓸 거라면 프로젝트 버전에서 쿼리 로그로 확인해야
한다. 그리고 더 중요한 건 **`optional = false`는 성능 우회책이 아니라 도메인
사실의 선언**이라는 점이다. 실제로 사물함 없는 회원이 존재하는 도메인에
`optional = false`를 붙이면 프록시 초기화 시점에 예외가 나거나 데이터 불일치가
드러난다. "LAZY를 걸려고 붙인다"는 동기로 접근하면 안 된다.

**바이트코드 강화(bytecode enhancement)** 경로도 있다. 빌드 시점에 엔티티
클래스를 변형해 필드 접근을 가로채는 방식으로, 프록시 없이도 지연 로딩을
구현한다(`enableLazyInitialization` 옵션). 다만 이 경로는 **Hibernate 버전과 빌드
플러그인 구성에 따라 동작과 필요한 애노테이션이 달라져 왔다** — 예전에는
`@LazyToOne(NO_PROXY)`를 함께 붙여야 했고, Hibernate 5.5 이후에는 필요 없어졌다고
알려져 있다. 이 문서에서는 **"별도 빌드 설정이 필요한 경로가 있고, 세부 동작은
버전 확인이 필요하다"** 까지만 확인했다. 면접에서도 이 정도로 말하는 편이
정확하다. 위 1·2번이 버전에 의존하지 않는 해법이라는 점이 더 중요하다.

## 7. 꼬리질문 대비 포인트

### "to-one 을 전부 LAZY로 바꿨는데도 목록 API에서 N+1이 났다. 왜인가?"

**LAZY는 N+1을 없애지 않고 발생 지점을 옮긴다.** 이제 쿼리는 매핑이 아니라
"연관을 건드리는 코드 줄"에서 나간다. `orders`를 100건 조회한 뒤 루프에서
`order.getMember().getName()`을 부르면 프록시 초기화가 100번 일어나 결과는
똑같이 101개 쿼리다.

차이는 **고칠 수 있는가**다. EAGER였다면 매핑을 건드리지 않고는 방법이 없지만,
LAZY라면 그 쿼리에 `join fetch o.member` 한 줄을 붙이거나(또는
`@EntityGraph`), 조회 전용이면 DTO 프로젝션으로 내려서 끝난다. 그리고 스트림
안에서 조용히 나가는 SELECT가 로그에 그대로 찍히므로 **발견 가능**하다.
"LAZY가 N+1을 막아준다"고 답하면 감점, **"LAZY는 N+1을 예측 가능한 자리로
옮겨 고칠 수 있게 만든다"** 가 정답이다.

### "기존 프로젝트의 EAGER를 전부 LAZY로 바꾸는 리팩터링을 맡았다. 순서를 어떻게 잡나?" (시니어 변별 포인트)

한 번에 바꾸면 반드시 사고가 난다. **EAGER가 지금까지 가려주고 있던 지연 로딩이
전부 `LazyInitializationException`으로 드러나기 때문**이고, 그 지점들은 컨트롤러
·직렬화·템플릿처럼 트랜잭션 밖에 흩어져 있다. 순서는 이렇게 잡는다.

1. **관측을 먼저 깐다.** 쿼리 로그 + `generate_statistics`, 주요 API의 현재
   쿼리 수를 기록해둔다. 바꾼 뒤 좋아졌는지 말할 수 있어야 한다.
2. **OSIV 상태를 확인한다.** `spring.jpa.open-in-view`가 켜져 있으면
   `LazyInitializationException`이 안 나고 대신 **컨트롤러에서 조용히 추가 쿼리가
   나간다.** 즉 예외라는 안전망이 없는 상태다. 리팩터링 중에는 오히려 예외가
   나는 게 낫다는 판단(테스트 환경에서 `false`로 두고 돌리기)이 유효하다.
3. **경계 안에서 다 채우는 구조로 먼저 바꾼다.** 서비스가 엔티티를 반환하지 않고
   DTO를 반환하도록 정리하면, 이후 fetch 전략을 어떻게 바꿔도 밖에서는 깨지지
   않는다. **가장 근본적인 단계이자 순서상 앞에 와야 하는 단계.**
4. **엔티티 하나씩, 조회 경로 하나씩 바꾼다.** 바꾼 엔티티를 쓰는 API의
   쿼리 수 테스트를 함께 추가한다.
5. **마지막에 정적 검사를 걸어 재발을 막는다**(§2-2). 되돌아가지 않게 만드는
   단계까지 말하면 완성이다.

"한 번에 전부 바꾸고 테스트 돌립니다"는 위험 인식이 없는 답이고,
"위험해서 안 바꿉니다"는 개선 능력이 없는 답이다. **드러날 위험을 예측하고
드러나는 순서를 설계한다**가 이 질문의 채점 지점이다.

### "글로벌 설정 하나로 to-one 기본값을 LAZY로 바꿀 수 없나?"

**JPA 명세에 그런 표준 스위치는 없다.** 기본값은 애노테이션별로 명세에 고정되어
있고, 이를 뒤집는 표준 설정 항목은 정의되어 있지 않다. 그래서 "매핑마다 손으로
적는다 + 안 적힌 걸 정적 검사로 잡는다"가 현실적인 유일한 관철 방법이다.

여기서 절대 꺼내면 안 되는 답이 하나 있다 — **`hibernate.enable_lazy_load_no_trans`**
(트랜잭션 밖 지연 로딩을 허용하는 옵션)다. 이건 기본값 문제와 아무 관련이 없고,
`LazyInitializationException`을 증상만 없애는 옵션이다. 접근할 때마다 짧은
트랜잭션/커넥션을 새로 열기 때문에 **N+1을 커넥션 N개짜리 문제로 승격**시킨다.
"예외가 안 나게 하는 방법"과 "문제를 해결하는 방법"을 구분하는지 보는 함정이라
생각하면 된다.

### "`@BatchSize`는 EAGER의 N+1도 줄여주나? 그럼 EAGER로 둬도 되는 것 아닌가?"

줄여준다. `@BatchSize(size = 100)`이나
`spring.jpa.properties.hibernate.default_batch_fetch_size=100`을 주면
연관을 하나씩 조회하는 대신 **`where id in (?, ?, ... )`으로 묶어** 1+N을
1+(N/size)로 낮춘다. 그래서 "EAGER인데 참을 만해졌다"는 상태가 만들어지긴 한다.

그런데 이건 **완화책이지 해결책이 아니다.** ① 쿼리가 1개가 되는 게 아니라
여전히 왕복이 2회 이상이고, ② §4-2의 연쇄 전파와 §4-3의 "지점별로 끌 수 없음"은
전혀 해결되지 않는다. 오히려 증상을 옅게 만들어 **원인 추적을 어렵게 하는
부작용**이 있다. 배치 fetch가 진짜로 유용한 자리는 **컬렉션이 둘 이상이라
fetch join으로 한 번에 못 가져오는 경우**(카테시안 곱 회피)이고, 그건 LAZY를
전제로 한 도구다.

한 가지 덧붙이면, 전역 배치 fetch 설정과 EAGER를 함께 쓸 때 **연관 필드에
실제 엔티티 대신 프록시가 들어와 구체 타입 캐스팅이 깨진다는 보고가 Hibernate
6.2 계열에서 있었다**(Hibernate 포럼). 즉 "EAGER + 배치"는 조합 자체가 미묘한
영역이다 — **확인 범위**: 포럼 논의를 확인한 수준이며 버전별 정확한 동작은
프로젝트에서 검증이 필요하다. 결론은 그대로다. 배치 fetch는 LAZY 전략의 보조
도구로 쓰고, EAGER를 정당화하는 근거로는 쓰지 않는다. **(가산점 포인트)**

### "그럼 EAGER를 써야 하는 자리는 정말 하나도 없나?" (트레이드오프 판단)

"절대 없다"고 단호하게 말하는 것보다, **어떤 조건이면 EAGER가 정당화되는지를
따져보고 그 조건이 실무에서 성립하기 어렵다는 것을 보이는 편**이 낫다. 정당화
조건은 셋이 동시에 만족될 때다 — ① 그 엔티티를 조회하는 **모든** 유스케이스가
그 연관을 쓴다 ② 연관 엔티티가 작고 개수가 유한하다(코드/구분값 테이블) ③ 그
연관이 다시 다른 연관을 끌고 가지 않는다.

문제는 ①이 **미래에 대한 약속**이라는 점이다. 지금은 참일 수 있지만 6개월 뒤
새 목록 API가 추가되면 깨지고, 그때 **끌 방법이 없다.** 그리고 ②·③이 참이라면
그건 애초에 연관 엔티티가 아니라 **`@Enumerated`나 `@Embeddable`, 또는 코드값을
그냥 컬럼으로 두는 편이 맞는 설계**일 가능성이 높다. 즉 EAGER가 정당화되는
조건을 파고들면 대부분 **"연관 매핑 자체를 다시 볼 문제"** 로 귀결된다.

그래서 실무 답은 "예외 없이 LAZY, 함께 가져올지는 쿼리가 결정"이다. 다만
이유가 "EAGER는 나쁘니까"가 아니라 **"틀렸을 때 되돌릴 수 있는 쪽을 기본값으로
두기 때문"** 이라고 말하는 것 — 여기까지 오면 이 문항은 만점이다.

---

## 한 줄 요약

EAGER/LAZY는 "함께 가져오나 나중에 가져오나"의 문제가 아니라 **기본값을 어느
방향으로 두면 나중에 되돌릴 수 있는가**의 문제다 — 명세가 to-one(`@ManyToOne`
·`@OneToOne`)을 EAGER로 둔 축은 "결과가 1건이라 최악 비용이 유한하다"였고
to-many를 LAZY로 둔 축은 "크기를 예측할 수 없다"였으므로, LAZY 전략을 쓴다는
말은 **to-one 전부에 손으로 `fetch = LAZY`를 적는다는 뜻**이다. EAGER를 피하는
가장 강한 근거는 낭비가 아니라 **JPQL은 작성한 대로 번역되고 글로벌 fetch
전략이 그 번역에 개입하지 않아 EAGER 연관이 행마다 추가 SELECT로 채워지는데,
`find()`는 조인이라 단건 테스트에서는 절대 보이지 않는 비대칭**과 **연쇄 전파로
성능이 모듈 경계를 넘어 결합된다**는 것, 그리고 결정적으로 **LAZY는 `join fetch`
한 줄로 켤 수 있지만 EAGER는 지점별로 끌 수 없다**는 비가역성이다. 정답은
**LAZY 전역 기본 + 지점별 명시적 fetch(fetch join / `@EntityGraph` /
`@BatchSize` / DTO 프로젝션) + 쿼리 로그와 쿼리 수 테스트라는 발견 장치**이고,
그 선택은 `LazyInitializationException`과 접근 지점 N+1이라는 **대가를 알고
지불하는 선택**이어야 한다.
