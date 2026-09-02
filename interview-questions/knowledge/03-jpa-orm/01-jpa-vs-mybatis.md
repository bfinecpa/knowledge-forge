# JPA vs MyBatis — "결합도가 줄어든다"의 실체와, 그 대가

> 핵심 관전 포인트: **"JPA는 객체스럽게 쓸 수 있다"는 말만으로는 절반도 설명이 안 된다. 줄어드는 결합은 세 층이다 — ① 벤더/방언 종속(SQL을 Dialect가 생성하므로 페이징·시퀀스 문법이 코드에 박히지 않는다) ② SQL의 부재(컬럼 하나 추가가 XML 전수 검사로 번지지 않는다) ③ 도메인 로직의 거처(MyBatis의 VO는 결과셋을 담는 그릇이라 규칙이 서비스로 새어나가지만, JPA 엔티티는 상태와 규칙을 함께 가질 수 있다). 이 중 ③이 "객체스럽게"의 진짜 값이고, 그걸 가능하게 하는 엔진이 영속성 컨텍스트(변경 감지·1차 캐시·쓰기 지연·지연 로딩)다 — MyBatis에는 이에 대응하는 장치가 아예 없다. 대신 대가가 명확하다: 쿼리가 코드에 안 보인다. 그래서 N+1과 불필요한 UPDATE가 조용히 나가고, JPA를 쓰는 사람에게 쿼리 로그 확인은 취향이 아니라 의무가 된다. 그래서 실무의 결론은 "둘 중 하나"가 아니라 쓰기는 ORM, 복잡한 읽기는 SQL이라는 병용이며, 이 분리가 CQRS로 이어지는 첫 단추다.**

---

## 0. 질문 + 의도

**질문**: "JPA를 사용하는 이유는? SQL Mapper(MyBatis)와의 차이는?"

**출제 의도**: 도구 선택의 근거를 말할 수 있는지. 팀마다 둘 다 쓰이므로 "왜 이 프로젝트엔 이게 맞는가"를 논할 수 있어야 기술 스택 논의에 참여할 수 있다.

**함정**: "JPA는 편하다 / 생산성이 좋다"로만 답하면 취향 진술이 된다. 면접관이 듣고 싶은 건 **양면**이다 — 무엇을 얻고 무엇을 지불하는지. 대가를 말하지 못하는 선택은 선택이 아니라 습관이다.

이 문서는 **3장(JPA / ORM)의 첫 문서**다. 뒤에 오는 문서들이 당연한 전제로 깔고 들어가는 용어 — 영속성 컨텍스트, 변경 감지, 지연 로딩, N+1 — 가 여기서 처음 등장하므로, 각 용어를 등장하는 자리에서 정의하고 넘어간다. 다만 영속성 컨텍스트의 내부 동작(스냅샷을 언제 어디에 뜨는지, flush가 정확히 언제 도는지, 쓰기 지연 SQL 저장소의 구조)은 [02번 문서](02-persistence-context-dirty-checking.md)의 본론이다. 여기서는 그 깊이까지 가지 않고 **"MyBatis에는 왜 이에 대응하는 장치가 없는가"**라는 대비 축에 필요한 만큼만 다룬다.

## 1. 원리 — 두 도구가 하는 일이 애초에 다르고, 그래서 결합이 세 층에서 줄어든다

### 1-1. 분류부터 다르다 — SQL Mapper와 ORM

| | MyBatis | JPA (구현체: Hibernate) |
|---|---|---|
| 분류 | **SQL Mapper** | **ORM**(Object-Relational Mapping) |
| 개발자가 쓰는 것 | SQL | 객체 조작 코드 |
| SQL을 만드는 주체 | 개발자 | 프레임워크(Dialect가 방언별로 생성) |
| 매핑 대상 | SQL 결과셋 ↔ 객체 필드 | **테이블 ↔ 엔티티**(관계·상속 포함) |
| 상태 추적 | 없음 | **영속성 컨텍스트**가 추적 |

용어를 그 자리에서 풀고 가자.

**SQL Mapper**는 SQL은 내가 쓰고, 그 결과를 객체에 담아주는 것까지만 대신해주는 도구다. 순수 JDBC로 조회를 한 번 하려면 커넥션을 얻고 `PreparedStatement`를 만들고 파라미터를 바인딩하고 `ResultSet`을 한 줄씩 돌며 `rs.getString("name")`을 객체에 옮겨 담고 마지막에 전부 닫아야 한다. 이 반복 코드를 JDBC boilerplate라고 부르는데, SQL Mapper가 없애주는 것이 정확히 이 부분이다. **SQL 자체는 그대로 내 손에 남는다.**

**ORM**은 한 단계 더 간다. 객체를 다루면 프레임워크가 그에 맞는 SQL을 만들어 실행해준다. ORM이라는 이름 자체가 "객체(Object)와 관계형(Relational) 데이터를 서로 대응(Mapping)시킨다"는 뜻이다. 여기서 대응시켜야 할 차이를 **임피던스 불일치(impedance mismatch)**라고 부른다 — 객체 세계에는 상속과 참조와 다형성이 있는데 테이블 세계에는 없고, 반대로 테이블 세계에는 외래 키와 조인이 있는데 객체에는 없다. 두 세계의 모양이 안 맞는다는 뜻으로 전기 공학의 임피던스 정합 개념에서 빌려온 말이다. ORM은 이 불일치를 프레임워크 안으로 흡수한다.

### 1-2. 이름 세 개를 먼저 정리한다 — JPA, Hibernate, Spring Data JPA

이 셋을 뭉뚱그려 쓰면 뒤의 설명이 계속 흔들리므로 층을 나눠 두자.

```text
[Spring Data JPA]   Repository 인터페이스만 선언하면 구현체를 만들어 준다
        │            (findById, save, 메서드 이름 쿼리, 페이징 …)
        ▼
[JPA]               자바 표준 명세(인터페이스). EntityManager, @Entity, JPQL을 정의한다
        │            명세일 뿐이므로 그 자체로는 아무것도 실행하지 못한다
        ▼
[Hibernate]         그 명세를 실제로 구현한 라이브러리. SQL을 만들고 실행하는 주체
        │
        ▼
[JDBC]              드라이버를 통해 DB와 통신
```

**JPA는 명세(인터페이스)이고 Hibernate는 구현체**다. 실무에서 "JPA를 쓴다"는 대개 "Hibernate를 JPA 표준 방식으로 쓴다"는 뜻이고, `spring-boot-starter-data-jpa` 의존성 하나가 이 조합을 통째로 묶어준다.

**Spring Data JPA는 또 한 층 위**다. JPA를 쓸 때 반복되는 코드(`EntityManager`를 주입받아 직접 호출하는 부분)를 `Repository` 인터페이스로 걷어내 준다. 즉 **JPA와 Spring Data JPA는 같은 것이 아니고**, 뒤에서 볼 "메서드 이름만 바꾸면 쿼리가 생성된다"는 이야기는 JPA가 아니라 이 층의 기능이다. 면접에서 둘을 섞어 말하면 층을 구분하지 못하는 인상을 준다.

### 1-3. 세 층으로 쪼개서 말해야 하는 이유

"JPA를 쓰면 DB와의 결합도가 줄어든다"는 문장은 그 자체로는 아무것도 설명하지 않는다. **무엇과 무엇 사이의 결합이 줄어드는지**를 말하지 않았기 때문이다. 그리고 뭉뚱그려 두면 "그래봐야 QueryDSL로 쿼리 짜면 MyBatis랑 똑같잖아요" 같은 반론에 그대로 무너진다.

줄어드는 결합은 성격이 다른 세 층에 나뉘어 있다. 아래 1-4, 1-5, 1-6이 각각 한 층이고, **세 번째 층이 가장 중요한데 면접에서 가장 덜 언급된다.**

### 1-4. 결합 ① 벤더·방언 종속 — SQL 문법이 코드에 박히지 않는다

먼저 전제. 같은 "정렬해서 21번째부터 10건"이라는 요구가 DB 제품마다 문법이 전혀 다르다.

```sql
-- MySQL / PostgreSQL
SELECT * FROM orders ORDER BY id DESC LIMIT 10 OFFSET 20;
-- Oracle 11g 이하
SELECT * FROM (SELECT a.*, ROWNUM rn FROM (SELECT * FROM orders ORDER BY id DESC) a WHERE ROWNUM <= 30) WHERE rn > 20;
```

**방언(dialect)**은 이렇게 제품마다 갈리는 SQL 문법 차이를 가리키는 말이다. 사람의 언어에서 지역마다 말이 갈리는 것에 빗댄 이름이다. Hibernate는 `Dialect`라는 클래스로 이 차이를 흡수한다 — **DB 제품별 번역기**라고 보면 된다. 어떤 페이징 문법을 쓸지, 시퀀스를 어떻게 호출할지, 문자열 결합 함수 이름이 무엇인지를 이 클래스가 알고 있고, Hibernate는 같은 요청을 받아 접속한 DB에 맞는 SQL로 번역해 내보낸다.

MyBatis에서는 위 문법이 **XML에 그대로 박힌다.** DB를 바꾸면 그 XML을 사람이 고쳐야 한다. JPA에서는 같은 자바 코드가 방언에 따라 다른 SQL로 생성된다.

```java
// 이 한 줄이 Dialect에 따라 LIMIT / ROW_NUMBER() / TOP 으로 각각 번역돼 나간다.
// 페이징 문법을 코드가 알지 못한다는 것이 이 층의 이득이다.
orderRepository.findAll(PageRequest.of(2, 10, Sort.by(DESC, "id")));
```

키 생성 전략(`IDENTITY` / `SEQUENCE`), 페이징, 함수명, 락 문법(`FOR UPDATE`)이 모두 여기 해당한다.

**과대평가 주의.** "DB를 바꿔도 코드가 그대로"는 마케팅 문구에 가깝다. 실제 전환에서는 native 쿼리(직접 쓴 SQL), 타입 차이(`boolean`을 Oracle에서는 `NUMBER(1)`로 받는 식), 옵티마이저 힌트, 인덱스 전략이 전부 재검토 대상이다. 정직한 표현은 **"바뀌는 면적이 줄어든다"**다. 면접에서 "코드가 그대로입니다"라고 답하면 전환을 해본 적이 없다는 사실이 드러난다.

### 1-5. 결합 ② SQL이 애플리케이션에 없다 — 스키마 변경의 파급 면적

운영 중인 `orders` 테이블에 `canceled_at` 컬럼 하나가 추가됐다고 하자. 어디를 고쳐야 하는가.

```xml
<!-- MyBatis: 그 테이블을 건드리는 모든 구문을 찾아 수정해야 한다 -->
<resultMap id="orderMap" type="Order">
  <result column="canceled_at" property="canceledAt"/>   <!-- 추가 -->
</resultMap>

<insert id="insert">
  INSERT INTO orders (id, status, canceled_at)            <!-- 추가 -->
  VALUES (#{id}, #{status}, #{canceledAt})                <!-- 추가 -->
</insert>

<update id="update">
  UPDATE orders SET status = #{status}, canceled_at = #{canceledAt} WHERE id = #{id}
</update>
<!-- 그리고 이 테이블을 SELECT 하는 다른 구문들도 전수 확인해야 한다 -->
```

```java
// JPA: 엔티티에 필드 하나를 더한다.
@Entity
public class Order {
    // 이 한 줄로 INSERT/UPDATE/SELECT 문이 전부 다시 생성된다.
    // 고칠 곳이 "구문 개수만큼"에서 "필드 1개"로 줄어드는 지점이다.
    private LocalDateTime canceledAt;
}
```

수정 지점의 개수도 개수지만, 더 중요한 것은 **누락이 조용히 지나가지 않는다**는 점이다. MyBatis에서 `UPDATE` 구문 하나를 빼먹으면 그 경로에서만 값이 저장되지 않는 버그가 되는데, 컴파일은 멀쩡히 통과한다. 사람이 전수 검사로 막아야 하는 종류의 버그다.

### 1-6. 결합 ③ 도메인 로직의 거처 — "객체스럽게"의 진짜 값

세 층 중 가장 중요하고, 면접에서 가장 덜 언급되는 층이다.

먼저 용어 하나. MyBatis 실무에서 흔히 말하는 **VO(Value Object)**는 원래 "값 그 자체로 동일성을 판단하는 불변 객체"를 뜻하는 설계 용어지만, 현장에서는 관례적으로 **SQL 결과셋 한 행을 담는 자바 객체**를 그렇게 부른다(DTO라고 부르는 팀도 있다). 이름이 무엇이든 구조는 같다 — getter와 setter만 있고, **값을 담는 것 외의 책임이 없다.**

책임이 없으면 규칙은 어디로 가는가. 서비스로 나간다.

```java
// before — 규칙이 서비스에 흩어진다 (MyBatis 스타일에서 흔한 귀결)
public class Order {          // getter/setter만 있는 그릇
    private String status;
    private LocalDateTime canceledAt;
    // getters / setters ...
}

@Service
public class OrderService {
    public void cancel(Long id) {
        Order order = orderMapper.findById(id);
        if (!"PAID".equals(order.getStatus())) {          // 취소 규칙 ①: 결제 완료만 취소 가능
            throw new IllegalStateException("결제 완료 상태만 취소 가능");
        }
        order.setStatus("CANCELED");                       // 취소 규칙 ②: 상태를 바꾼다
        order.setCanceledAt(LocalDateTime.now());          // 취소 규칙 ③: 취소 시각을 남긴다
        orderMapper.update(order);                         // 저장은 명시적으로 호출해야 한다
    }
}

@Service
public class AdminOrderService {
    public void forceCancel(Long id) {
        Order order = orderMapper.findById(id);
        order.setStatus("CANCELED");
        // 문제: canceledAt 세팅을 빠뜨렸다.
        // 규칙 ①②③이 한 덩어리로 묶여 있지 않으니 경로마다 복붙되고, 복붙된 순간부터 갈라진다.
        orderMapper.update(order);
    }
}
```

문제는 "setter가 많다"가 아니다. **"취소"라는 규칙이 한 군데에 없다**는 것이다. 취소 경로가 사용자용·관리자용·배치용으로 늘어날 때마다 규칙이 복제되고, 복제된 순간부터 서로 갈라진다. 어느 쪽이 진짜 취소 규칙인지 코드만 봐서는 알 수 없게 된다.

JPA에서는 규칙을 엔티티 안에 둘 수 있다.

```java
// after — 규칙이 엔티티 안에 있고, 변경은 영속성 컨텍스트가 감지한다
@Entity
public class Order {
    @Enumerated(EnumType.STRING)   // enum을 문자열 컬럼으로 매핑한다. String 필드를 쓸 이유가 없어진다
    private OrderStatus status;
    private LocalDateTime canceledAt;

    public void cancel() {                     // "취소"의 규칙이 이 메서드 하나뿐이다
        if (status != OrderStatus.PAID) {
            throw new IllegalStateException("결제 완료 상태만 취소 가능");
        }
        this.status = OrderStatus.CANCELED;
        this.canceledAt = LocalDateTime.now();
    }
}

@Service
public class OrderService {
    @Transactional
    public void cancel(Long id) {
        orderRepository.findById(id).orElseThrow().cancel();
        // save() 호출이 없다. 이 부분이 다음 절(변경 감지)의 주제다.
    }
}
```

`status`를 `String`이 아니라 enum으로 둘 수 있는 것도 같은 층의 이득이다(`@Enumerated`가 매핑을 흡수하므로 DB 컬럼 타입을 신경 쓰지 않아도 된다). **불변식(invariant)을 객체가 스스로 지킬 수 있게 되는 것** — 불변식이란 "이 객체가 살아 있는 동안 항상 참이어야 하는 조건"을 말하고, 여기서는 "CANCELED 상태이면 canceledAt이 반드시 있다"가 그것이다. 이게 "객체스럽다"의 실체이고, 도메인 주도 설계가 ORM 위에서 자연스러운 이유다.

오해를 하나 막아두자. **MyBatis로 같은 설계를 못 하는 것은 아니다.** 엔티티에 `cancel()` 메서드를 두고 그 뒤에 `mapper.update(order)`를 부르면 된다. 다만 `update`를 손으로 부르는 순간 "이 객체를 어디서 저장했는지"를 개발자가 계속 추적해야 하고, 그 추적 부담이 결국 로직을 서비스 쪽으로 끌어내린다. 구조적으로 불가능한 것이 아니라 **중력이 반대 방향으로 걸려 있다.**

## 2. 엔진과 대가 — 영속성 컨텍스트가 세 층을 떠받치고, 같은 것이 대가를 만든다

### 2-1. 영속성 컨텍스트란 무엇인가

1-6의 마지막 코드에서 `save()`를 부르지 않았는데도 UPDATE가 나갔다. 이것을 가능하게 하는 장치가 **영속성 컨텍스트(persistence context)**다.

정의부터 하면, **트랜잭션이 살아 있는 동안 조회·저장한 엔티티를 담아두고 그 상태를 계속 추적하는 메모리 공간**이다. "영속(persistence)"은 데이터를 저장 매체에 남긴다는 뜻이고, "컨텍스트(context)"는 그 작업이 벌어지는 문맥·범위를 뜻한다. 합치면 "저장을 관리하는 작업 범위"쯤 된다. Spring 환경에서는 보통 **트랜잭션 하나가 영속성 컨텍스트 하나**에 대응한다.

비유하자면 **DB와 애플리케이션 사이에 놓인 작업대**다. 필요한 물건(엔티티)을 DB에서 꺼내 작업대에 올려두고, 작업대 위에서 고치고, 작업이 끝나는 시점(커밋)에 바뀐 것만 DB로 되돌려 보낸다. 작업대에 올려두는 동안에는 DB에 다녀오지 않아도 되고, 무엇이 어떻게 바뀌었는지도 작업대가 기억한다.

**MyBatis에는 이에 대응하는 장치가 없다.** MyBatis에도 캐시(1차·2차)는 있지만 그것은 "같은 SQL을 또 부르면 결과를 재사용한다"는 조회 캐시이지, **객체의 변경을 추적해 UPDATE로 바꿔주는 장치가 아니다.** 이 차이가 아래 네 기능 전부의 출발점이다.

영속성 컨텍스트가 하는 일은 네 가지다. 하나씩 본다.

### 2-2. 기능 ① 변경 감지(dirty checking) — "무엇이 바뀌었는지" 계산해 준다

**변경 감지**는 엔티티를 조회한 시점의 값을 따로 복사해 두었다가(이 복사본을 **스냅샷**이라 부른다) 커밋 직전에 현재 값과 필드별로 비교해, 달라진 것이 있으면 UPDATE 문을 만들어 내보내는 기능이다. "dirty"는 "원본과 달라진, 손댄"이라는 뜻으로 쓰이는 관용어다.

```java
@Transactional
public void changeName(Long id, String newName) {
    Order order = orderRepository.findById(id).orElseThrow();  // 이 순간 스냅샷이 떠진다
    order.rename(newName);                                     // 인스턴스만 바뀐다. 스냅샷은 그대로다
    // 커밋 직전, 인스턴스와 스냅샷을 비교해 달라진 필드를 찾아 UPDATE를 만든다.
}
```

**MyBatis에서라면** 개발자가 `mapper.update(order)`를 직접 불러야 한다. 부르지 않으면 저장되지 않고, 두 번 부르면 두 번 나간다. 즉 "언제 저장할지"의 결정권이 개발자에게 있다.

JPA에서는 그 결정권이 프레임워크에 있다. **이것이 1-6의 설계를 성립시키는 힘이자, 2-7에서 볼 사고의 원인이다.** 편의와 위험이 같은 뿌리에서 나온다는 점을 기억해 두자.

### 2-3. 기능 ② 1차 캐시 — 같은 트랜잭션에서 같은 ID는 같은 객체다

영속성 컨텍스트는 조회한 엔티티를 **`(엔티티 타입, id)`를 열쇠로 하는 맵**에 담아둔다. 이것을 **1차 캐시**라고 부른다. "1차"인 이유는 트랜잭션 범위의 이 캐시와 구분되는 **2차 캐시**(애플리케이션 전체가 공유하는 캐시)가 따로 있기 때문이다.

효과가 둘이다. 첫째, 같은 트랜잭션에서 같은 id를 다시 조회하면 **SELECT가 아예 나가지 않는다.** 캐시에 있는 인스턴스를 그대로 돌려준다. 둘째, 그래서 **동일성(`==`)이 보장된다.**

```java
@Transactional
public void sameInstance(Long id) {
    Order a = orderRepository.findById(id).orElseThrow();   // SELECT 1회
    Order b = orderRepository.findById(id).orElseThrow();   // 쿼리가 나가지 않는다
    // a == b 가 true다. 두 변수가 같은 인스턴스를 가리킨다.
}
```

**MyBatis에서라면** 두 번 조회하면 SELECT가 두 번 나가고, 서로 다른 객체가 두 개 만들어진다. `a == b`는 `false`다. 이것은 버그가 아니라 SQL Mapper의 정상 동작이다 — "결과셋을 객체로 담아준다"가 전부이므로 같은 행을 두 번 읽으면 객체도 두 개다.

동일성 보장이 왜 중요한가. **한 트랜잭션 안에서 같은 데이터를 두 경로로 조회했을 때 한쪽에서 바꾼 값이 다른 쪽에도 보이기 때문이다.** MyBatis에서는 두 객체가 따로 놀아 "분명히 바꿨는데 다른 코드에서는 옛날 값"이 나올 수 있다. 대신 이 편의가 3-3에서 볼 함정(native 쿼리로 바꾼 값을 1차 캐시가 모른다)의 원인이 되기도 한다.

### 2-4. 기능 ③ 쓰기 지연(write-behind) — SQL을 모았다가 한 번에 내보낸다

**쓰기 지연**은 INSERT·UPDATE·DELETE를 만들어지는 즉시 DB로 보내지 않고 영속성 컨텍스트 안의 SQL 저장소에 쌓아두었다가, **flush 시점에 모아서 한 번에 보내는** 동작이다. "지연(behind)"이라는 이름은 "쓰기를 뒤로 미룬다"는 뜻이다.

여기서 **flush**라는 용어가 나오는데, **쌓아둔 SQL을 실제로 DB에 내보내는 행위**를 말한다. 기본적으로는 트랜잭션 커밋 직전에 자동으로 일어난다(다른 시점도 있는데 그건 [15번 문서](15-flush-timing-and-sql-ordering.md)의 주제다). 주의할 것은 **flush는 커밋이 아니라는 점**이다. SQL을 보냈을 뿐 아직 확정되지 않았고, 롤백하면 사라진다.

```java
@Transactional
public void saveThree() {
    orderRepository.save(new Order(...));   // 이 시점에 INSERT가 나가지 않는다
    orderRepository.save(new Order(...));   // 저장소에 쌓인다
    orderRepository.save(new Order(...));
    // 커밋 직전 flush에서 세 INSERT가 한 번에 전송된다.
    // 모아서 보내므로 JDBC batch(여러 SQL을 한 번의 네트워크 왕복으로 보내는 기능)를 쓸 여지가 생긴다.
}
```

**MyBatis에서라면** `mapper.insert()`를 부른 즉시 DB로 나간다. 모아 보내려면 개발자가 배치 모드 세션을 직접 열어 관리해야 한다.

여기에 이득이 하나 더 있다. 쌓아둔 SQL을 보내기 전에 **순서를 조정할 수 있다.** 부모 INSERT가 자식 INSERT보다 먼저 나가야 FK 제약에 걸리지 않는데, 이런 순서 보장이 쓰기 지연 덕분에 가능하다.

### 2-5. 기능 ④ 지연 로딩(lazy loading) — 연관 객체를 쓸 때 조회한다

객체 세계에서는 `order.getMember().getName()`처럼 참조를 타고 들어가는 것이 자연스럽다. 그런데 주문을 하나 읽을 때마다 회원까지 조인해서 읽어오면, 회원 정보를 안 쓰는 화면에서는 낭비다.

**지연 로딩**은 연관된 객체를 **실제로 그 필드에 접근하는 순간**에 조회하는 전략이다. 그때까지는 진짜 객체 대신 **프록시(proxy)**를 넣어둔다. 프록시는 겉모습은 진짜 엔티티인 척하지만 속은 비어 있고, 누군가 값을 물어보는 순간 그때 SELECT를 날려 자기 속을 채우는 대리인 객체다.

```java
Order order = orderRepository.findById(1L).orElseThrow();   // SELECT orders 만 나간다
// 이 시점에 order.member는 프록시다. member 테이블은 아직 읽지 않았다.
String name = order.getMember().getName();                  // 여기서 SELECT member 가 나간다
```

**MyBatis에서라면** 필요한 조인을 SQL에 직접 쓴다. 조인을 안 썼으면 연관 데이터가 없는 것이고, 그 사실이 SQL에 그대로 보인다.

지연 로딩은 편리하지만 **"쿼리가 나가는 시점을 코드만 보고는 알 수 없게" 만든다.** 바로 다음 절의 N+1이 여기서 나오고, 트랜잭션이 끝난 뒤에 프록시를 건드려서 터지는 `LazyInitializationException`([07번 문서](07-lazy-initialization-exception.md))도 여기서 나온다.

### 2-6. 네 기능 요약 — 편의와 위험은 같은 뿌리다

| 기능 | 하는 일 | MyBatis에서라면 | 이것이 만드는 위험 |
|---|---|---|---|
| **변경 감지** | 스냅샷과 비교해 바뀐 것을 찾아 UPDATE 생성 | 개발자가 `update` 구문 호출 | 의도 없는 UPDATE (2-8) |
| **1차 캐시** | 같은 id 재조회 시 쿼리 생략, 동일성(`==`) 보장 | 매번 SELECT, 서로 다른 객체 | native 변경을 모른다 (3-3) |
| **쓰기 지연** | SQL을 모아 flush 시점에 전송, 순서 조정 | 호출 즉시 전송 | 쿼리 시점이 코드와 어긋난다 |
| **지연 로딩** | 연관 객체를 접근 시점에 조회 | 조인을 SQL에 직접 명시 | N+1 (2-7), `LazyInitializationException` |

오른쪽 두 열을 나란히 보는 것이 이 문서의 핵심이다. **JPA가 주는 편의와 JPA가 만드는 사고는 서로 다른 기능에서 나오는 것이 아니라 정확히 같은 기능에서 나온다.** 그래서 "JPA의 단점은 무엇인가"라는 질문에 답하려면 장점을 만드는 메커니즘을 알아야 한다.

### 2-7. 대가 ① 의도하지 않은 쿼리가 조용히 나간다 — N+1

**N+1 문제**란 목록을 1번 조회했을 뿐인데 그 결과 건수(N)만큼 연관 조회가 추가로 따라붙어 총 `1 + N`번의 쿼리가 나가는 현상이다. 이름 그대로 "1번 + N번"이다.

```java
// 코드에는 쿼리를 부르는 곳이 한 군데뿐인데, 실제로는 1 + N 번 나간다
List<Order> orders = orderRepository.findAll();        // SELECT * FROM orders  (1번)
for (Order o : orders) {
    o.getMember().getName();                            // 건마다 SELECT member (N번)
}
```

주문이 100건이면 쿼리가 101번이다. 개발 DB에 데이터가 10건일 때는 아무도 눈치채지 못하고, 운영에서 터진다.

**MyBatis라면** 개발자가 조인을 안 썼다는 사실이 SQL에 그대로 보인다. JPA에서는 **코드만 봐서는 문제가 보이지 않는다** — 반복문 안에 쿼리 호출이 없기 때문이다. 그래서 JPA를 쓰는 팀에게 다음은 선택이 아니라 의무가 된다.

```yaml
# 개발/스테이징에서 쿼리를 눈으로 확인한다 (운영은 로그량·성능·보안을 고려해 별도 판단)
spring.jpa.properties.hibernate.format_sql: true
logging.level.org.hibernate.SQL: DEBUG
# 눈으로 보는 것보다 확실한 것은 쿼리 수를 테스트로 고정하는 것이다
decorator.datasource.p6spy.enable-logging: true   # 또는 Hibernate Statistics 로 쿼리 수 단정
```

진단과 해결(fetch join, `@EntityGraph`, `@BatchSize`)은 [04번 문서](04-n-plus-one-detection-and-fixes.md)의 본론이다. 여기서 말할 것은 **"쿼리가 코드에 보이지 않는다"가 JPA의 근본 대가**라는 사실 하나다.

### 2-8. 대가 ② 조회만 하려 했는데 UPDATE가 나간다

```java
@Transactional
public OrderDto get(Long id) {
    Order order = orderRepository.findById(id).orElseThrow();
    order.setStatus(order.getStatus().normalize());   // 화면 표시용으로 정규화할 의도였다
    return OrderDto.from(order);
}   // 커밋 시점에 변경 감지가 돌아 UPDATE가 나간다. 저장할 생각이 없었다.
```

**"저장 코드가 없으니 저장되지 않는다"는 직관이 JPA에서는 틀린다.** 영속 상태 엔티티의 필드를 건드린 것 자체가 저장 지시이기 때문이다.

막는 방법은 `@Transactional(readOnly = true)`다. 이 옵션을 붙이면 Hibernate가 flush 모드를 `MANUAL`로 바꿔 **자동 flush를 하지 않고**, 나아가 스냅샷을 뜨지 않아도 되므로 **메모리와 비교 비용까지 절약된다.** 사고 예방과 성능이 같은 방향인 드문 경우다(`02-spring/13-transactional-readonly-optimization.md`).

### 2-9. 대가 ③ 복잡한 조회는 결국 다른 도구로 내려간다

Spring Data JPA의 "메서드 이름으로 쿼리 생성"은 조건이 적고 고정일 때만 유효하다.

```java
// 조건 2개까지는 우아하다
List<Member> findByStatusAndOrganizationId(Status status, Long orgId);

// 선택적 조건이 6개(이름·이메일·가입일 범위·상태·조직·최근 로그인)라면?
// findByNameContainingAndEmailContainingAndCreatedAtBetweenAnd...  ← 조합 폭발이다. 불가능하다
```

조건이 "선택적"이라는 점이 핵심이다. 사용자가 이름만 넣을 수도, 이름과 상태를 함께 넣을 수도 있으므로 필요한 메서드 개수가 조건 개수의 지수로 늘어난다. 그래서 동적 조회는 JPQL이나 **QueryDSL**로 간다.

```java
// QueryDSL — where에 넘긴 조건 중 null인 것은 자동으로 무시된다.
// 즉 "입력된 조건만 참여"가 if문 없이 표현된다.
queryFactory.selectFrom(member)
    .where(nameLike(cond.name()), emailLike(cond.email()), joinedBetween(cond.from(), cond.to()))
    .fetch();

private BooleanExpression nameLike(String name) {
    return name == null ? null : member.name.contains(name);   // null을 돌려주면 그 조건은 빠진다
}
```

**여기서 반드시 짚어야 할 구분이 있다.** QueryDSL이 MyBatis보다 나은 점은 **컴파일 시점 타입 안전성**이다 — 컬럼명 오타와 타입 불일치를 빌드가 잡아내고, 필드명을 바꾸면 IDE 리팩터링이 쿼리까지 따라간다. XML 문자열은 이 중 어느 것도 되지 않는다. 다만 이것은 **안전성 축의 이득이지 결합도 축의 이득이 아니다.** 1-4~1-6의 세 층과 섞어 말하면 논점이 흐려지고, "그럼 결국 쿼리 짜는 건 똑같잖아요"라는 반론에 답을 못 하게 된다.

그리고 다음 영역은 여전히 SQL이 이긴다.

- 다중 서브쿼리, 윈도 함수(`ROW_NUMBER`, `LAG`), `PIVOT`, 재귀 CTE
- 통계·리포트·정산 집계 — 애초에 결과가 엔티티 단위가 아니라 집계 행이다
- 실행 계획을 보며 힌트나 인덱스 유도로 튜닝을 반복해야 하는 쿼리
- 대량 배치 UPDATE/DELETE — 건별 처리로는 감당할 수 없다

### 2-10. 대가 ④ 대량 처리와 학습 곡선

**대량 INSERT가 느리다.** JPA의 기본 경로는 건별 INSERT다. 특히 `IDENTITY` 전략(DB의 auto_increment에 키 생성을 맡기는 방식)에서는 **키 값을 알아야 영속성 컨텍스트의 1차 캐시에 넣을 수 있는데 그 키를 DB만 알고 있으므로, INSERT를 즉시 보내 키를 받아와야 한다.** 그래서 2-4의 쓰기 지연이 무력화되고 JDBC batch도 함께 무력화된다. 대안은 `SEQUENCE` 전략(미리 키를 받아올 수 있으므로 모아서 보낼 수 있다)에 batch 설정을 얹거나, 아예 JdbcTemplate으로 내려가는 것이다([21번 문서](21-bulk-insert-jdbc-batch.md)).

> 확인 범위: "IDENTITY면 batch가 안 된다"는 오랫동안 참이었으나, Hibernate 6.5 계열에서 드라이버가 배치 실행 후 생성 키 반환을 지원하는 경우에 한해 일부 개선이 있었다. 팀에서 쓰는 Hibernate 버전과 드라이버 조합에서 실제로 batch가 묶이는지는 쿼리 로그나 `Statistics`로 직접 확인하는 것이 안전하다.

**학습 곡선의 성질이 나쁘다.** 몰라도 일단 돌아간다는 것이 문제다. 그래서 이상 동작이 났을 때(안 바꾼 값이 저장됨, 조회 결과가 옛날 값, `LazyInitializationException`) 원인을 찾지 못한다. MyBatis는 모르는 것이 SQL 문법 하나라 바닥이 얕다 — 로그에 찍힌 SQL이 곧 진실이다.

**`merge`의 함정.** 준영속 상태(한때 영속이었지만 지금은 추적되지 않는 상태) 엔티티를 `merge`하면 전체 필드를 덮어써서, 세팅하지 않은 필드가 `null`로 저장되는 데이터 유실이 발생한다. 예외도 나지 않는다. 자세한 것은 [05번 문서](05-merge-vs-dirty-checking.md)에 있다.

## 3. 판단 — 무엇으로 고르고, 실무에서는 어떻게 섞는가

### 3-1. 선택 기준 여섯 축

| 판단 축 | JPA 유리 | MyBatis 유리 |
|---|---|---|
| 작업 성격 | 상태 변경(등록/수정/취소)이 중심 | 조회·집계·리포트가 중심 |
| 도메인 규칙 | 엔티티에 담을 규칙이 많다 | 규칙보다 데이터 가공이 목적 |
| 쿼리 복잡도 | 단순~중간, 패턴이 반복적 | 서브쿼리·윈도 함수·튜닝 상시 |
| 스키마 | 새로 설계, 정규화·객체 모델과 정합 | 레거시 스키마(복합키, 비정규화, 뷰 의존) |
| 팀 | JPA 경험자 있음, 리뷰로 N+1 걸러낼 수 있음 | SQL 강한 팀, ORM 학습 비용 부담 |
| 성능 통제 | 프레임워크 기본에 맡기고 필요 시 개입 | 쿼리 단위로 전면 통제 필요 |

**"레거시 스키마"는 특히 강한 신호다.** 복합키, 컬럼명 규칙 부재, 뷰 기반 조회, 트리거 의존 같은 환경에서 JPA는 비즈니스 로직이 아니라 매핑 자체와 싸우게 된다. 이럴 때 MyBatis를 고르는 것은 회피가 아니라 합리적 선택이다.

**"팀"이 판단 축에 들어간다는 점도 짚을 만하다.** 도구의 성능만으로 결정하는 사람과 팀 역량을 변수로 넣는 사람은 답변의 무게가 다르다. 2-10에서 봤듯 JPA는 "몰라도 돌아가고 이상하면 못 잡는" 성질이라, 경험자 부재의 위험이 MyBatis보다 크다.

### 3-2. 실무의 결론은 "둘 중 하나"가 아니라 병용이다

대용량 서비스에서 흔한 구도는 **쓰기는 ORM, 복잡한 읽기는 SQL**이다. 도구를 프로젝트 단위가 아니라 **경로 단위**로 고르는 것이다.

| 경로 | 도구 | 이유 |
|---|---|---|
| 주문 생성·취소, 회원 상태 변경 | JPA | 도메인 규칙(1-6) + 변경 감지(2-2) |
| 목록/상세 조회 | JPA + **DTO 프로젝션** | 필요한 컬럼만 읽고, 영속성 컨텍스트 비용을 회피한다 |
| 검색 필터 조합 | QueryDSL | 동적 조건 + 타입 안전(2-9) |
| 정산·리포트·통계 | MyBatis / native / JdbcTemplate | 집계·윈도 함수·튜닝 |
| 대량 배치 | JdbcTemplate batch | 건별 처리 회피(2-10) |

**DTO 프로젝션**이라는 용어를 풀어두자. 엔티티 전체를 읽어 오는 대신 **필요한 컬럼만 골라 DTO 객체로 바로 받는 조회 방식**이다. 필요 없는 컬럼을 안 읽으니 네트워크·메모리가 절약되고, 무엇보다 **결과가 엔티티가 아니므로 영속성 컨텍스트에 올라가지 않는다** — 스냅샷도 안 뜨고 변경 감지도 안 돌고 의도치 않은 UPDATE도 없다([18번 문서](18-dto-projection-for-read-only.md)).

### 3-3. 섞을 때의 함정 — native로 쏜 변경은 1차 캐시가 모른다

한 트랜잭션에서 JPA와 JdbcTemplate을 섞어도 **같은 커넥션을 공유한다**(`02-spring/24-transaction-synchronization-connection-binding.md`). 그러므로 트랜잭션은 하나로 묶인다. 여기까지는 안심해도 된다.

문제는 다른 곳에 있다. JdbcTemplate이나 native 쿼리로 UPDATE를 쏘면 **영속성 컨텍스트는 그 사실을 모른다.**

```text
t1  Order를 조회한다                → 1차 캐시에 status=PAID 로 올라간다
t2  JdbcTemplate으로 UPDATE 실행    → DB의 status는 CANCELED가 된다
t3  같은 트랜잭션에서 다시 조회      → 1차 캐시가 t1의 인스턴스를 돌려준다
                                      결과: status=PAID  (DB와 다르다)
```

2-3에서 본 1차 캐시의 편의가 여기서는 정확히 반대로 작용한다. **DB는 바뀌었는데 조회 결과는 예전 값**이 되는 것이다. JPQL 벌크 연산(`@Modifying` 쿼리) 뒤에 `clear()`가 필요하다고 하는 이유와 같은 원리이고, 자세한 것은 [11번 문서](11-bulk-operation-persistence-context.md)에 있다.

### 3-4. 이 분리가 CQRS의 첫 단추다

**CQRS(Command Query Responsibility Segregation, 명령·조회 책임 분리)**는 **데이터를 바꾸는 경로(명령)와 읽는 경로(조회)에 서로 다른 모델을 쓰는** 설계 패턴이다. 이름의 "책임 분리"가 정확히 그 뜻이다.

3-2의 표가 이미 CQRS의 초입이다. 바꾸는 쪽은 엔티티와 도메인 규칙으로, 읽는 쪽은 DTO 프로젝션과 SQL로 — **하나의 모델로 두 요구를 모두 만족시키려 하지 않는 것**이 이 패턴의 출발점이다. 여기서 더 나아가면 읽기 전용 저장소를 따로 두거나 읽기 모델을 비동기로 갱신하는 단계까지 가지만, 그것은 13장(아키텍처)의 주제다.

## 4. 꼬리질문 대비 포인트

### "QueryDSL로 쿼리를 직접 짜면 결국 MyBatis와 같은 거 아닌가요?"

**아니다.** 그리고 답을 "타입 안전"으로만 끝내면 안 된다. 세 가지를 나눠 말한다.

① **여전히 SQL을 쓰지 않는다.** QueryDSL이 만들어 내는 것은 JPQL이고, 그것을 다시 방언별 SQL로 번역하는 것은 Hibernate다. 1-4의 방언 종속이 그대로 없다.

② **엔티티와 영속성 컨텍스트가 살아 있다.** QueryDSL로 조회한 결과가 엔티티라면 그것은 영속 상태이므로, 그대로 필드를 바꾸면 변경 감지가 UPDATE를 만든다. MyBatis의 결과 객체는 그릇일 뿐이라 이 연결이 없다. 1-6과 2-2의 이득이 유지된다는 뜻이다.

③ **거기에 덧붙여** 컴파일 시점 타입 안전이 있다.

핵심은 **①②가 결합도 축의 답이고 ③은 안전성 축의 별도 이득**이라는 구분이다. 이걸 섞으면 질문자의 함정에 그대로 걸린다.

### "JPA를 쓰면 성능이 나빠지나요?"

**기본 경로에 맡기면 나빠질 수 있다.** N+1, 의도치 않은 UPDATE, 필요 없는 컬럼까지 조회하는 것이 대표적이다. 전부 2절에서 본, 편의를 만드는 그 기능들이 만드는 비용이다.

**통제하면 MyBatis와 큰 차이가 없다.** fetch join과 `@EntityGraph`로 N+1을 접고, `@BatchSize`로 남은 지연 로딩을 묶고, DTO 프로젝션으로 필요한 컬럼만 읽고, `readOnly`로 스냅샷 비용을 없애고, batch 설정으로 INSERT를 모은다.

그래서 정확한 문장은 **"JPA가 느리다"가 아니라 "통제 없이 쓴 JPA가 느리다"**이고, 통제하려면 2절의 네 기능과 그 대가를 알아야 한다. 이 답변 자체가 "메커니즘을 알고 쓴다"는 신호가 된다.

### "운영에 나가기 전에 N+1을 어떻게 발견하나요?"

**"코드 리뷰로 본다"만 답하면 약하다.** 사람의 주의력에 기대는 장치는 언젠가 뚫린다. 자동으로 걸러지는 장치를 말해야 한다.

① 개발 환경에서 **SQL 로깅을 상시 켠다.** 개발 중에 쿼리가 101번 나가는 것을 눈으로 보게 만든다.

② **테스트에서 쿼리 수를 단정한다.** Hibernate `Statistics`의 `getQueryExecutionCount()`나 p6spy로 카운트를 세어 "이 API는 쿼리 3개"를 테스트로 고정한다. 회귀가 나면 빌드가 깨진다. 이것이 가장 확실한 장치다.

③ PR 리뷰에서 **반복문 안의 연관 접근**을 지적한다.

④ APM과 slow query 로그로 사후 관측한다.

①③은 사람이 하고 ②④는 기계가 한다는 점을 구분해서 말하면 좋다.

### "DB를 Oracle에서 MySQL로 바꾼다면 JPA라서 편한가요?"

**면적은 줄지만 공짜는 아니다.** 1-4에서 본 대로 페이징·시퀀스·함수명·락 문법은 Dialect가 흡수한다. 그러나 native 쿼리, 타입 매핑(`boolean`과 `NUMBER(1)`), 시퀀스 대 auto_increment의 키 전략 차이, 옵티마이저 힌트, 인덱스 전략은 전부 재검토 대상이다.

"코드가 그대로입니다"라고 답하면 전환을 해본 적이 없다는 사실이 드러난다. **"바뀌는 면적이 줄어든다"**가 정직한 표현이다.

### "레거시 DB에 JPA를 붙이라고 하면 어떻게 하시겠어요?"

복합키(`@IdClass` / `@EmbeddedId`), 뷰 매핑, 트리거 의존, 컬럼 규칙 부재와 싸워야 한다. 이런 환경에서는 JPA의 이득(1-4~1-6)이 거의 나오지 않는 반면 매핑 비용만 지불하게 된다.

현실적인 답은 **부분 도입**이다. 조회 비중이 크고 기존 스키마에 얽힌 영역은 MyBatis로 두고, 새로 만드는 도메인만 JPA로 시작한다. 3-2에서 본 경로별 도구 선택을 시간 축으로 적용하는 셈이다.

### "팀에 JPA 경험자가 없다면요?"

이 질문은 **도구 성능이 아니라 팀 역량이 선택 변수임을 인지하는지** 보는 질문이다.

JPA는 2-10에서 본 대로 "몰라도 돌아가고 이상하면 못 잡는" 성질이라, 경험자 부재의 위험이 MyBatis보다 크다. MyBatis에서 모르는 것은 SQL 문법 하나지만, JPA에서 모르는 것은 "왜 쿼리가 101번 나가는가"다.

그러므로 답은 "도입하지 말자"가 아니라 **안전망을 먼저 세우고 도입하자**가 된다. 리뷰어 확보, 쿼리 수 테스트, SQL 로깅 상시화 — 이 셋 없이 도입하면 6개월 뒤에 성능 문제가 온다.

### "그럼 본인은 새 프로젝트에서 어떻게 정하겠습니까?" (시니어 변별 포인트)

**단일 도구를 고르지 않는 것**이 가장 좋은 답이다. 3-2의 경로별 분리를 제시하고, 그 근거를 셋으로 든다.

결정 근거는 "빠른 개발"이 아니라 **스키마 상태 + 조회 복잡도 + 팀 역량** 세 축이다. 스키마가 새것이고 도메인 규칙이 많으면 쓰기는 JPA가 확실히 유리하고, 조회 복잡도가 높은 경로는 어차피 SQL로 내려가야 하며, 팀 역량은 안전망(쿼리 수 테스트, 리뷰 기준)으로 보강할 수 있는지로 판단한다.

"둘 중 하나를 고르라"는 질문에 **"경로마다 다르게 고른다"고 답하되 그 분리 기준을 말하는 것** — 이것이 도구를 써본 사람과 골라본 사람의 차이다.

---

## 한 줄 요약

JPA가 줄이는 결합은 세 층 — **방언 종속**(SQL을 Dialect가 생성), **SQL의 부재**(컬럼 추가가 XML 전수 수정으로 번지지 않음), 그리고 가장 중요한 **도메인 로직의 거처**(MyBatis VO는 결과셋 그릇이라 규칙이 서비스로 흩어지지만, JPA 엔티티는 상태와 불변식을 함께 가질 수 있고 `save()` 없이도 변경 감지가 UPDATE를 만든다) — 이며 그 엔진이 영속성 컨텍스트(변경 감지·1차 캐시·쓰기 지연·지연 로딩)다. 대가는 **쿼리 비가시성**이라 N+1과 의도치 않은 UPDATE가 조용히 나가고(그래서 쿼리 로깅과 쿼리 수 테스트가 의무), 동적 조회는 QueryDSL로 가되 그것은 결합도가 아니라 타입 안전 축의 이득이며, 집계·윈도 함수·대량 배치는 SQL로 내려가야 하고, 레거시 스키마·SQL 강한 팀·튜닝 상시 환경에서는 MyBatis가 합리적 선택이다. 그래서 실무의 답은 "둘 중 하나"가 아니라 **쓰기는 ORM, 복잡한 읽기는 SQL**이고(native로 쏜 변경은 1차 캐시가 모른다는 함정 포함), 이 분리가 CQRS로 가는 첫 단추다.
