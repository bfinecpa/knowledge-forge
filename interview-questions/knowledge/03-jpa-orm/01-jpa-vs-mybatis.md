# JPA vs MyBatis — "결합도가 줄어든다"의 실체와, 그 대가

> 핵심 관전 포인트: "JPA는 객체스럽게 쓸 수 있다"는 말만으로는 절반도 설명이 안 된다. 줄어드는 결합은 **세 층**이다 — ① **벤더/방언 종속**(SQL을 Dialect가 생성하므로 페이징·시퀀스 문법이 코드에 박히지 않는다) ② **SQL의 부재**(컬럼 하나 추가가 XML 전수 검사로 번지지 않는다) ③ **도메인 로직의 거처**(MyBatis의 VO는 결과셋을 담는 그릇이라 규칙이 서비스로 새어나가지만, JPA 엔티티는 상태와 규칙을 함께 가질 수 있다). 이 중 ③이 "객체스럽게"의 진짜 값이고, 그걸 가능하게 하는 엔진이 **영속성 컨텍스트**(변경 감지·1차 캐시·쓰기 지연·지연 로딩)다 — MyBatis에는 이에 대응하는 장치가 아예 없다. 대신 대가가 명확하다: **쿼리가 코드에 안 보인다.** 그래서 N+1과 불필요한 UPDATE가 조용히 나가고, JPA를 쓰는 사람에게 쿼리 로그 확인은 취향이 아니라 의무가 된다. 그래서 실무의 결론은 "둘 중 하나"가 아니라 **쓰기는 ORM, 복잡한 읽기는 SQL**이라는 병용이며, 이 분리가 CQRS로 이어지는 첫 단추다.

## 0. 질문 + 의도

**질문**: "JPA를 사용하는 이유는? SQL Mapper(MyBatis)와의 차이는?"

**출제 의도**: 도구 선택의 근거를 말할 수 있는지. 팀마다 둘 다 쓰이므로 "왜 이
프로젝트엔 이게 맞는가"를 논할 수 있어야 기술 스택 논의에 참여할 수 있다.

**함정**: "JPA는 편하다 / 생산성이 좋다"로만 답하면 취향 진술이 된다. 면접관이
듣고 싶은 건 **양면**이다 — 무엇을 얻고 무엇을 지불하는지. 대가를 말하지 못하는
선택은 선택이 아니라 습관이다.

## 1. 두 도구가 하는 일이 애초에 다르다

| | MyBatis | JPA (구현체: Hibernate) |
|---|---|---|
| 분류 | **SQL Mapper** | **ORM**(Object-Relational Mapping) |
| 개발자가 쓰는 것 | SQL | 객체 조작 코드 |
| SQL을 만드는 주체 | 개발자 | 프레임워크(Dialect가 방언별로 생성) |
| 매핑 대상 | SQL 결과셋 ↔ 객체 필드 | **테이블 ↔ 엔티티**(관계·상속 포함) |
| 상태 추적 | 없음 | **영속성 컨텍스트**가 추적 |

**용어 풀이**
- **SQL Mapper**: SQL은 내가 쓰고, 그 결과를 객체에 담아주는 것까지만 대신해주는 도구. "SQL 실행 + 결과 매핑"의 반복 코드(JDBC boilerplate)를 없애준다.
- **ORM**: 객체를 다루면 프레임워크가 그에 맞는 SQL을 만들어 실행해주는 도구. 객체 모델과 관계 모델의 차이(임피던스 불일치)를 프레임워크가 흡수한다.
- **JPA는 명세(인터페이스), Hibernate는 구현체**다. 실무에서 "JPA를 쓴다"는 대개 "Hibernate를 JPA 표준 방식으로 쓴다"는 뜻이고, `spring-boot-starter-data-jpa`가 그 조합을 묶어준다.
- **Spring Data JPA**는 또 한 층 위다 — JPA를 쓰는 반복 코드(EntityManager 직접 호출)를 `Repository` 인터페이스로 걷어내 준다. 즉 **JPA ≠ Spring Data JPA**이고, 뒤에서 볼 "메서드 이름만 바꾸면 된다"는 이 층의 기능이다.

## 2. "결합도가 줄어든다"의 세 층

여기를 정확히 쪼개서 말하는 것이 이 질문의 핵심이다. "결합도"라는 한 단어로
뭉쳐두면 반론(§4)에 바로 무너진다.

### 2-1. 벤더/방언(dialect) 종속

같은 "상위 10건 조회"가 DB마다 문법이 다르다.

```sql
-- MySQL
SELECT * FROM orders ORDER BY id DESC LIMIT 10 OFFSET 20;
-- Oracle 11g 이하
SELECT * FROM (SELECT a.*, ROWNUM rn FROM (SELECT * FROM orders ORDER BY id DESC) a WHERE ROWNUM <= 30) WHERE rn > 20;
```

MyBatis에서는 이 문법이 **XML에 그대로 박힌다.** JPA에서는 같은 코드가 방언에
따라 다른 SQL로 생성된다.

```java
// 동일 코드가 Dialect에 따라 LIMIT / ROW_NUMBER() / TOP 으로 번역된다
orderRepository.findAll(PageRequest.of(2, 10, Sort.by(DESC, "id")));
```

키 생성 전략(`IDENTITY` / `SEQUENCE`), 페이징, 함수명, 락 문법(`FOR UPDATE`)이
모두 여기 해당한다.

**과대평가 주의**: "DB를 바꿔도 코드가 그대로"는 마케팅 문구에 가깝다. 실제
전환에서는 native 쿼리, 타입 차이(`boolean`/`NUMBER(1)`), 힌트, 인덱스 전략이
전부 재검토 대상이다. 정직한 표현은 **"바뀌는 면적이 줄어든다"** 다.

### 2-2. SQL이 애플리케이션에 없다 → 스키마 변경의 파급 면적

운영 중인 `orders` 테이블에 `canceled_at` 컬럼 하나가 추가됐다고 하자.

```xml
<!-- MyBatis: 그 테이블을 건드리는 모든 구문을 찾아 수정 -->
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
<!-- ... 이 테이블을 SELECT 하는 다른 구문들도 전수 확인 -->
```

```java
// JPA: 엔티티에 필드 하나
@Entity
public class Order {
    private LocalDateTime canceledAt;   // 끝. INSERT/UPDATE/SELECT 문은 자동 생성된다
}
```

수정 지점이 "구문 개수만큼"에서 "필드 1개"로 줄어든다. 게다가 **누락이 조용히
지나가지 않는다** — MyBatis에서 `UPDATE` 구문 하나를 빼먹으면 그 경로에서만
값이 저장되지 않는 버그가 되고, 컴파일도 통과한다.

### 2-3. 도메인 로직의 거처 — "객체스럽게"의 진짜 값

세 층 중 가장 중요하고, 면접에서 가장 덜 언급되는 층이다.

MyBatis의 VO/DTO는 구조상 **결과셋을 담는 그릇**이다. 상태를 담기만 하니 규칙은
서비스로 흘러나간다.

```java
// ❌ 규칙이 서비스에 흩어진다 (MyBatis 스타일에서 흔한 귀결)
public class Order {          // getter/setter만 있는 그릇
    private String status;
    private LocalDateTime canceledAt;
    // getters / setters ...
}

@Service
public class OrderService {
    public void cancel(Long id) {
        Order order = orderMapper.findById(id);
        if (!"PAID".equals(order.getStatus())) {          // 규칙 ①
            throw new IllegalStateException("결제 완료 상태만 취소 가능");
        }
        order.setStatus("CANCELED");                       // 규칙 ②
        order.setCanceledAt(LocalDateTime.now());          // 규칙 ③
        orderMapper.update(order);                         // 명시적 UPDATE 필요
    }
}

@Service
public class AdminOrderService {
    public void forceCancel(Long id) {
        Order order = orderMapper.findById(id);
        order.setStatus("CANCELED");
        // ⚠️ canceledAt 세팅을 깜빡 — 같은 규칙이 두 곳에 복붙되며 갈라진다
        orderMapper.update(order);
    }
}
```

문제는 "setter가 많다"가 아니라 **취소라는 규칙이 한 군데에 없다**는 것이다.
경로가 늘어날수록 규칙이 복제되고, 복제된 순간부터 갈라진다.

```java
// ✅ 규칙이 엔티티 안에 있고, 변경은 영속성 컨텍스트가 감지한다
@Entity
public class Order {
    @Enumerated(EnumType.STRING)
    private OrderStatus status;
    private LocalDateTime canceledAt;

    public void cancel() {                     // 취소의 규칙이 여기 하나뿐
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
        // save() 호출이 없다 — 변경 감지(dirty checking)가 UPDATE를 만들어 낸다
    }
}
```

`status`를 `String`이 아니라 enum으로 둘 수 있는 것도 같은 층의 이득이다
(`@Enumerated`가 매핑을 흡수). **불변식(invariant)을 객체가 스스로 지킬 수
있게 되는 것** — 이게 "객체스럽다"의 실체이고, 도메인 주도 설계가 ORM 위에서
자연스러운 이유다.

MyBatis로 같은 설계를 못 하는 건 아니다. 다만 `save()`를 손으로 부르는 순간
"어디서 저장했는지"를 개발자가 계속 추적해야 하고, 그 추적 부담이 결국 로직을
서비스로 끌어내린다.

## 3. JPA에만 있는 엔진 — 영속성 컨텍스트

§2-3의 "`save()` 없이 UPDATE가 나간다"를 가능하게 하는 장치다. MyBatis에는
대응물이 **없다**(캐시는 있지만 상태 추적은 없다).

| 기능 | 하는 일 | MyBatis에서라면 |
|---|---|---|
| **변경 감지**(dirty checking) | 조회 시점 스냅샷과 커밋 시점을 비교해 바뀐 필드만 UPDATE | 개발자가 `update` 구문 호출 |
| **1차 캐시** | 같은 트랜잭션에서 같은 ID 재조회 시 쿼리 생략, **동일성(`==`) 보장** | 매번 SELECT, 서로 다른 객체 |
| **쓰기 지연**(write-behind) | INSERT/UPDATE를 모아 flush 시점에 전송 → JDBC batch 여지 | 호출 즉시 전송 |
| **지연 로딩**(lazy loading) | 연관 객체를 실제 접근 시점에 조회 | 필요한 조인을 SQL에 직접 명시 |

이 넷이 §2-3의 코드를 성립시킨다. 동시에 **§4의 대가를 만드는 원인**도
정확히 이 넷이다 — 편의와 위험이 같은 뿌리에서 나온다.

## 4. 대가 — 쿼리가 안 보인다

여기를 자발적으로 말하는지가 "중"과 "상"을 가른다.

### 4-1. 의도하지 않은 쿼리가 조용히 나간다

**N+1 문제** — 목록 1건 조회에 연관 데이터 조회가 N번 따라붙는다.

```java
// 코드에는 반복문이 없는데 쿼리는 1 + N 번 나간다
List<Order> orders = orderRepository.findAll();        // SELECT * FROM orders (1번)
for (Order o : orders) {
    o.getMember().getName();                            // 건마다 SELECT member (N번)
}
```

MyBatis라면 개발자가 조인을 안 썼다는 사실이 SQL에 그대로 보인다. JPA에서는
**코드만 보면 문제가 안 보인다.** 그래서 JPA를 쓰는 팀에게 다음은 선택이 아니다.

```yaml
# 개발/스테이징에서 쿼리를 눈으로 확인 (운영은 성능·보안 고려해 별도 판단)
spring.jpa.properties.hibernate.format_sql: true
logging.level.org.hibernate.SQL: DEBUG
# 쿼리 수 회귀를 테스트로 고정하는 것이 더 확실하다
decorator.datasource.p6spy.enable-logging: true   # 또는 Hibernate Statistics 로 쿼리 수 단정
```

### 4-2. 조회만 하려 했는데 UPDATE가 나간다

```java
@Transactional
public OrderDto get(Long id) {
    Order order = orderRepository.findById(id).orElseThrow();
    order.setStatus(order.getStatus().normalize());   // 표시용 정규화 의도였다
    return OrderDto.from(order);
}   // 커밋 시점에 변경 감지가 동작해 UPDATE 발생 — 의도한 적 없음
```

"저장 코드가 없으니 저장되지 않는다"는 직관이 JPA에서는 틀린다. 반대로 `@Transactional(readOnly = true)`를
붙이면 스냅샷 유지와 flush가 생략돼 이 사고 자체가 막히고 성능도 이득이다
(`02-spring/13-transactional-readonly-optimization.md`).

### 4-3. 복잡한 조회는 결국 다른 도구로 내려간다

Spring Data JPA의 "메서드 이름으로 쿼리 생성"은 조건이 적고 고정일 때만 유효하다.

```java
// 조건 2개까지는 우아하다
List<Member> findByStatusAndOrganizationId(Status status, Long orgId);

// 선택적 조건이 6개(이름·이메일·가입일 범위·상태·조직·최근 로그인)면?
// findByNameContainingAndEmailContainingAndCreatedAtBetweenAnd...  ← 조합 폭발. 불가능하다
```

그래서 동적 조회는 JPQL이나 **QueryDSL**로 간다.

```java
// QueryDSL — 입력된 조건만 where 에 참여 (null 은 무시된다)
queryFactory.selectFrom(member)
    .where(nameLike(cond.name()), emailLike(cond.email()), joinedBetween(cond.from(), cond.to()))
    .fetch();

private BooleanExpression nameLike(String name) {
    return name == null ? null : member.name.contains(name);
}
```

**여기서 반드시 짚어야 할 구분** — QueryDSL이 MyBatis보다 나은 점은 **컴파일
시점 타입 안전성**(컬럼명 오타·타입 불일치를 빌드가 잡고, 필드명 변경이 IDE
리팩터링으로 전파된다)이다. 이건 **안전성 축의 이득이지 결합도 축의 이득이
아니다.** §2의 세 층과 섞어 말하면 논점이 흐려진다.

그리고 다음 영역은 여전히 SQL이 이긴다.

- 다중 서브쿼리, 윈도 함수(`ROW_NUMBER`, `LAG`), `PIVOT`, 재귀 CTE
- 통계·리포트·정산 집계 — 애초에 엔티티 단위가 아니라 집계 결과가 목적
- 실행 계획을 보며 튜닝(힌트, 인덱스 유도)이 반복되는 쿼리
- 대량 배치 UPDATE/DELETE — 건별 처리로는 감당 불가

### 4-4. 대량 처리와 학습 곡선

- **대량 INSERT**: JPA의 기본 경로는 건별 INSERT다. `IDENTITY` 전략은 키를 얻으려 즉시 INSERT를 보내야 해서 **JDBC batch가 무력화**된다(→ `SEQUENCE` + batch, 또는 JdbcTemplate으로 내려가기).
- **학습 곡선의 성질이 나쁘다**: 몰라도 일단 돌아간다. 그래서 이상 동작이 났을 때(안 바꾼 값이 저장됨, 조회 결과가 옛날 값, `LazyInitializationException`) 원인을 못 찾는다. MyBatis는 모르는 게 SQL 문법 하나라 바닥이 얕다.
- **`merge`의 함정**: detached 엔티티를 `merge`하면 전체 필드를 덮어써서, 세팅하지 않은 필드가 `null`로 저장되는 데이터 유실이 발생한다.

## 5. 선택 기준

| 판단 축 | JPA 유리 | MyBatis 유리 |
|---|---|---|
| 작업 성격 | 상태 변경(등록/수정/취소)이 중심 | 조회·집계·리포트가 중심 |
| 도메인 규칙 | 엔티티에 담을 규칙이 많다 | 규칙보다 데이터 가공이 목적 |
| 쿼리 복잡도 | 단순~중간, 패턴이 반복적 | 서브쿼리·윈도 함수·튜닝 상시 |
| 스키마 | 새로 설계, 정규화·객체 모델과 정합 | 레거시 스키마(복합키, 비정규화, 뷰 의존) |
| 팀 | JPA 경험자 있음, 리뷰로 N+1 걸러낼 수 있음 | SQL 강한 팀, ORM 학습 비용 부담 |
| 성능 통제 | 프레임워크 기본에 맡기고 필요 시 개입 | 쿼리 단위로 전면 통제 필요 |

**"레거시 스키마"는 특히 강한 신호다.** 복합키, 컬럼명 규칙 부재, 뷰 기반 조회,
트리거 의존 같은 환경에서 JPA는 매핑 자체와 싸우게 된다. 이럴 때 MyBatis는
회피가 아니라 합리적 선택이다.

## 6. 실무의 결론 — 병용

대용량 서비스에서 흔한 구도는 **쓰기는 ORM, 복잡한 읽기는 SQL**이다.

| 경로 | 도구 | 이유 |
|---|---|---|
| 주문 생성·취소, 회원 상태 변경 | JPA | 도메인 규칙 + 변경 감지 |
| 목록/상세 조회 | JPA + **DTO 프로젝션** | 필요한 컬럼만, 영속성 컨텍스트 비용 회피 |
| 검색 필터 조합 | QueryDSL | 동적 조건 + 타입 안전 |
| 정산·리포트·통계 | MyBatis / native / JdbcTemplate | 집계·윈도 함수·튜닝 |
| 대량 배치 | JdbcTemplate batch | 건별 처리 회피 |

한 트랜잭션에서 JPA와 JdbcTemplate을 섞어도 **같은 커넥션을 공유**한다
(`02-spring/24-transaction-synchronization-connection-binding.md`). 다만 섞을 때
주의점이 하나 있다 — JdbcTemplate/native로 UPDATE를 쏘면 **영속성 컨텍스트는
그 사실을 모른다.** 1차 캐시에 옛 값이 남아 "DB는 바뀌었는데 조회 결과는 예전
값"이 된다. 벌크 연산 뒤 `clear()`가 필요한 이유와 같은 원리다.

이 "변경은 객체로, 조회는 조회에 맞는 도구로"라는 분리가 **CQRS**(명령과 조회의
모델을 분리하는 패턴)로 이어지는 첫 단추다.

## 7. 꼬리질문 대비 포인트

- **"QueryDSL로 쿼리를 직접 짜면 결국 MyBatis와 같은 거 아닌가?"** — 아니다. 그리고 답을 "타입 안전"으로만 끝내면 안 된다. ① 여전히 SQL을 쓰지 않으므로 방언 종속이 없다 ② 엔티티(§2-3)와 영속성 컨텍스트(§3)가 그대로 살아 있어 조회한 객체를 그대로 변경할 수 있다 ③ 거기에 **덧붙여** 컴파일 시점 타입 안전이 있다 — ③은 안전성 축의 별도 이득이고 ①②가 결합도 답변이다.
- **"JPA를 쓰면 성능이 나빠지나?"** — 기본 경로에 맡기면 나쁠 수 있다(N+1, 불필요 UPDATE, 필요 없는 컬럼 조회). 통제하면 MyBatis와 큰 차이가 없다 — fetch join/`@EntityGraph`, `@BatchSize`, DTO 프로젝션, `readOnly`, 배치 설정. 즉 **"JPA가 느리다"가 아니라 "통제 없이 쓴 JPA가 느리다"** 이고, 통제하려면 §3~§4를 알아야 한다.
- **"운영 전에 N+1을 어떻게 발견하나?"** — rationale이 실제로 보려는 지점이다. ① 개발 환경에서 SQL 로깅 상시 ON ② **테스트에서 쿼리 수 단정**(Hibernate `Statistics`의 `getQueryExecutionCount`, 또는 p6spy로 카운트) ③ PR 리뷰에서 반복문 안의 연관 접근을 지적 ④ APM/slow query 로그로 사후 관측. "코드 리뷰로 본다"만 답하면 약하고, **자동으로 걸러지는 장치**를 말해야 한다.
- **"DB를 Oracle에서 MySQL로 바꾼다면 JPA라 편한가?"** — 면적은 줄지만 공짜는 아니다. native 쿼리·타입 매핑·시퀀스 전략·힌트·인덱스 전략은 전부 재검토다. "코드가 그대로"라고 답하면 경험 없음이 드러난다.
- **"레거시 DB에 JPA를 붙이라면?"** — 복합키(`@IdClass`/`@EmbeddedId`), 뷰 매핑, 트리거 의존, 컬럼 규칙 부재와 싸워야 한다. 조회 비중이 크면 MyBatis, 신규 도메인만 JPA로 두는 **부분 도입**이 현실적이다.
- **"팀에 JPA 경험자가 없다면?"** — 도구 성능이 아니라 **팀 역량이 선택 변수**임을 인지하는지 보는 질문. JPA는 "몰라도 돌아가고 이상하면 못 잡는" 성질(§4-4)이라 경험자 부재의 위험이 MyBatis보다 크다. 리뷰어 확보·쿼리 수 테스트 같은 안전망 없이 도입하면 6개월 뒤 성능 문제가 온다.
- **"그럼 본인은 새 프로젝트에서 어떻게 정하겠나?"** — 단일 도구를 고르기보다 §6의 경로별 분리를 제시하는 것이 가장 좋은 답이다. 결정 근거는 "빠른 개발"이 아니라 **스키마 상태 + 조회 복잡도 + 팀 역량** 세 축으로 말한다.

## 한 줄 요약

JPA가 줄이는 결합은 세 층 — **방언 종속**(SQL을 Dialect가 생성), **SQL의 부재**(컬럼 추가가 XML 전수 수정으로 번지지 않음), 그리고 가장 중요한 **도메인 로직의 거처**(MyBatis VO는 결과셋 그릇이라 규칙이 서비스로 흩어지지만, JPA 엔티티는 상태와 불변식을 함께 가질 수 있고 `save()` 없이도 변경 감지가 UPDATE를 만든다) — 이며 그 엔진이 영속성 컨텍스트(변경 감지·1차 캐시·쓰기 지연·지연 로딩)다. 대가는 **쿼리 비가시성**이라 N+1과 의도치 않은 UPDATE가 조용히 나가고(→ 쿼리 로깅과 쿼리 수 테스트가 의무), 동적 조회는 QueryDSL로(이건 결합도가 아니라 타입 안전 축의 이득), 집계·윈도 함수·대량 배치는 SQL로 내려가야 하며, 레거시 스키마·SQL 강한 팀·튜닝 상시 환경에서는 MyBatis가 합리적 선택이다. 그래서 실무의 답은 "둘 중 하나"가 아니라 **쓰기는 ORM, 복잡한 읽기는 SQL**이고(native로 쏜 변경은 1차 캐시가 모른다는 함정 포함), 이 분리가 CQRS로 가는 첫 단추다.
