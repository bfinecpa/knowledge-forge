# `findById` vs `getReferenceById` — 축은 "존재 검증을 어디서 하느냐"다

> 핵심 관전 포인트: **`findById`는 즉시 SELECT를 날려 실제 엔티티를 가져오고, `getReferenceById`는 SELECT 없이 `id`만 든 가짜 객체(프록시)를 돌려준다.** 프록시가 이득이 되는 자리는 **엔티티의 필드 값이 전혀 필요 없고 연관관계의 외래 키(FK)만 채우면 되는 경우** — 이때 `order.setMember(proxy)` 후 저장하면 SQL이 `SELECT + INSERT`에서 **`INSERT` 하나로** 줄어든다. **같은 낭비가 숨어 있는 두 번째 자리가 `deleteById`다.** Spring Data의 `deleteById`는 내부적으로 `findById`로 한 번 읽고 지우므로 `SELECT + DELETE`가 나가는데, `delete(getReferenceById(id))`로 바꾸면 **DELETE 한 문장**이 된다(단 Hibernate가 이 최적화를 켤 수 있는 조건이 있다). 대가는 하나다 — **실패 지점이 호출 지점에서 멀어진다.** 없는 `id`였다는 사실이 프록시를 **실제로 건드리는 순간**에야 드러나고, 그 순간이 트랜잭션 안이면 `EntityNotFoundException`, 영속성 컨텍스트가 닫힌 뒤면 **`LazyInitializationException`**이라는 전혀 다른 이름으로 나타난다. 그래서 선택 기준은 성능이 아니라 **"존재 검증을 어디서 하느냐"** 한 축이다 — **단건 API는 `findById`로 호출 지점에서 즉시 검증**하고, **대량 처리는 `IN` 절로 존재를 한 번에 검증한 뒤 `getReferenceById`로 SELECT를 제거**한다. 그리고 배치라면 여기서 멈추면 안 된다. **SELECT 10만 번을 없애도 INSERT 10만 번이 남고, `IDENTITY` 전략이면 JDBC 배치가 아예 작동하지 않는다.**

---

## 0. 질문 + 의도

**질문**: "`findById`와 `getReferenceById`의 차이는? 프록시 반환이 유용한 경우는 언제인가요?"

관련 질문(실제로 이어진 꼬리질문):
"`createOrder`에서 `findById` → `getReferenceById`로 바꾸면 SQL이 어떻게 달라지나?"
"`getReferenceById(999L)`인데 999번이 DB에 없으면? 예외가 난다면 언제·어디서 나나?"
"FK 제약이 있으면 INSERT 시점에 DB가 막아준다. 'DB를 최후 방어선으로'라는 원칙대로면 `getReferenceById`가 낫지 않나?"
"CSV 10만 건 배치 적재라면? `findById`면 SELECT가 10만 번인데 그래도 쓸 이유가 없나?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**연관관계 설정만 필요한데 SELECT를 날리는 낭비를 프록시로 없앨 수 있는지 — JPA를 '동작하게' 쓰는 수준과 '쿼리를 통제하며' 쓰는 수준을 가르는 디테일이다.**" 즉 이 문항은 API 두 개의 차이를 묻는 것처럼 보이지만, 실제 채점 지점은 **"내가 쓴 코드에서 SQL이 몇 개 나가는지 머릿속에 그림이 있는가"**다. 여기에 더해 꼬리질문 구조가 하나 더 검사한다 — **성능 이득과 그 대가(실패 지점의 이동)를 저울에 같이 올릴 수 있는가**, 그리고 **전제(단건 → 10만 건)가 바뀌었을 때 판단을 갈아탈 수 있는가**.

**이 문서의 성격**: 이 문항은 후보자가 **"상"**을 받았다. 개념·SQL 차이·유용한 경우·예외 시점·프록시의 대가·배치에서의 최적 패턴까지 **사실 오류 없이, 힌트 없이** 나왔다. 그래서 이 문서는 **공백을 메우는 문서가 아니다.** 이미 도달한 수준은 §1에서 **짧게 사실로 고정**하고, 지면의 대부분은 **그 위에 얹을 것**에 쓴다 — `deleteById`의 숨은 SELECT(§2), 같은 실수인데 이름이 갈리는 예외(§3), 프록시가 `getClass()`를 배신하는 문제(§4), 배치의 다음 병목(§5), 그리고 이 전부를 하나로 묶는 선택 기준과 완성형 코드(§6).

---

## 1. 이미 맞춘 것 — 30초 안에 다시 말할 수 있게

이 절은 **확인용**이다. 아래 다섯 문장을 그대로 말할 수 있으면 §2부터 읽으면 된다.

### 1-1. 두 메서드의 차이

| | `findById(id)` | `getReferenceById(id)` |
|---|---|---|
| 반환 | `Optional<T>` — 실제 엔티티 | `T` — `id`만 채워진 프록시 |
| 호출 즉시 SELECT | **난다** | **안 난다** |
| 없는 `id`일 때 | `Optional.empty()` — 호출 지점에서 즉시 알 수 있다 | **아무 일도 안 일어난다.** 나중에 프록시를 건드릴 때 터진다 |
| 밑바탕 | `EntityManager.find()` | `EntityManager.getReference()` |

**프록시(proxy)**란 "대리인"이라는 뜻으로, 여기서는 **Hibernate가 런타임에 만들어 낸 `Member`의 가짜 자식 클래스 인스턴스**다. 겉모습은 `Member`지만 속은 비어 있고 `id`와 "나는 아직 안 채워졌다"는 표시만 들고 있다. 그러다 **`getName()` 같은 실제 필드 접근이 처음 일어나는 순간** DB로 SELECT를 날려 자기 속을 채운다. 이것을 **프록시 초기화**라고 부른다.

> `getId()`만은 예외다. **`id`는 프록시가 이미 알고 있으므로 `getId()` 호출은 초기화를 일으키지 않는다.** 프록시를 쓰는 이유가 바로 여기에 있다.

### 1-2. SQL이 실제로 어떻게 달라지는가

```java
// before — 회원의 이름도 등급도 쓰지 않는데 회원 한 줄을 통째로 읽어 온다
@Transactional
public Long createOrder(Long memberId, int amount) {
    Member member = memberRepository.findById(memberId)
                                    .orElseThrow(MemberNotFoundException::new);
    Order order = new Order(member, amount);   // member는 FK 값(id)으로만 쓰인다
    return orderRepository.save(order).getId();
}
```

```sql
-- 나가는 SQL 2개
select m.id, m.name, m.email, m.grade, m.created_at from member m where m.id = ?
insert into orders (member_id, amount) values (?, ?)
```

```java
// after — FK만 필요하므로 "id를 든 껍데기"만 받아 연결한다
@Transactional
public Long createOrder(Long memberId, int amount) {
    Member member = memberRepository.getReferenceById(memberId);  // SELECT 없음
    Order order = new Order(member, amount);
    return orderRepository.save(order).getId();
}
```

```sql
-- 나가는 SQL 1개
insert into orders (member_id, amount) values (?, ?)
```

**INSERT가 필요로 하는 것은 `member_id` 컬럼 값 하나뿐**이고, 그 값은 프록시가 이미 들고 있다. 그래서 Hibernate는 프록시를 초기화할 이유가 없고, SELECT는 나가지 않는다.

### 1-3. 대가: 실패 지점이 호출 지점에서 멀어진다

`getReferenceById(999L)`에서 999번이 DB에 없어도 **그 줄에서는 아무 일도 일어나지 않는다.** 문제는 나중에 드러난다.

- 프록시를 **초기화하면** 그때 예외 — 스택 트레이스는 `getName()`을 부른 자리를 가리키고, 정작 원인인 `getReferenceById(999L)`은 거기 없다.
- 프록시를 **초기화하지 않고 FK로만 쓰면** 예외조차 안 난다. DB에 FK 제약이 있으면 flush 시점에 `DataIntegrityViolationException`으로 잡히지만, **FK 제약이 없는 테이블이면 존재하지 않는 회원을 가리키는 주문이 조용히 저장된다.** 이게 최악이다 — 며칠 뒤 조인 결과가 비어 있는 것으로 발견된다.

**"원인 지점과 발현 지점이 멀어지면 장애 분석이 어려워진다"** — 이 한 문장이 프록시의 대가 전부이고, 이 문서의 나머지는 사실상 **그 대가를 어떻게 관리할 것인가**에 대한 이야기다.

---

## 2. 같은 낭비가 숨어 있는 두 번째 자리 — `deleteById`

`createOrder`의 SELECT는 눈에 띄기라도 한다. **`deleteById`의 SELECT는 코드에 흔적조차 없다.**

### 2-1. `deleteById`는 내부에서 한 번 읽고 지운다

Spring Data JPA의 구현체(`SimpleJpaRepository`)는 이렇게 생겼다.

```java
// Spring Data JPA — SimpleJpaRepository
@Transactional
public void deleteById(ID id) {
    Assert.notNull(id, ID_MUST_NOT_BE_NULL);
    findById(id).ifPresent(this::delete);   // ← 여기서 SELECT가 한 번 나간다
}
```

`findById`로 읽어 온 뒤 있으면 지운다. 그래서 SQL은 이렇게 된다.

```java
// before — 코드는 한 줄인데 쿼리는 두 개다
@Transactional
public void cancel(Long orderId) {
    orderRepository.deleteById(orderId);
}
```

```sql
select o.id, o.member_id, o.amount, o.status, o.created_at from orders o where o.id = ?
delete from orders where id = ?
```

```java
// after — 프록시로 지운다. 지우는 데 필요한 것은 id뿐이다
@Transactional
public void cancel(Long orderId) {
    orderRepository.delete(orderRepository.getReferenceById(orderId));
}
```

```sql
delete from orders where id = ?
```

**왜 SELECT가 사라지는가**는 두 단계로 갈린다.

**① Spring Data 쪽** — `delete(T entity)`의 내부는 이렇다.

```java
// Spring Data JPA — SimpleJpaRepository.doDelete (요지)
if (entityManager.contains(entity)) {
    entityManager.remove(entity);       // ← 프록시는 이미 영속 상태라 여기로 빠진다
    return true;
}
// (준영속 엔티티였다면 아래에서 find로 존재를 확인한 뒤 merge → remove)
```

`getReferenceById`가 만든 프록시는 **이미 영속성 컨텍스트에 등록된 상태**이므로 `contains`가 `true`고, 아래쪽의 `find`(= 추가 SELECT)를 타지 않는다.

**② Hibernate 쪽** — Hibernate에는 **"초기화되지 않은 프록시를 로딩 없이 바로 지우는" 최적화 경로**가 실제로 구현되어 있다(`DefaultDeleteEventListener.optimizeUnloadedDelete`). 이 경로를 타면 프록시를 초기화하지 않고 DELETE 액션만 큐에 등록한다.

### 2-2. 그 최적화가 조용히 꺼지는 조건 (여기가 진짜 포인트)

**항상 되는 게 아니다.** Hibernate는 아래 조건을 **전부** 만족할 때만 로딩 없이 지운다. 하나라도 걸리면 프록시를 초기화하고(= SELECT를 날리고) 평소 경로로 지운다.

- 세션에 커스텀 `Interceptor`가 없을 것
- 엔티티에 **상속 서브클래스가 없을 것** (`@Inheritance` 매핑이 걸려 있으면 탈락)
- **cascade delete 설정이 없을 것** (자식까지 지워야 하면 부모 상태를 알아야 하므로)
- **`@NaturalId`가 없을 것**
- PK를 참조하지 않는 컬렉션이 없을 것
- **`@PreRemove` / `@PostRemove` 콜백이 없을 것** (콜백에 엔티티를 넘겨야 하니 로딩이 필요하다)
- **PRE_DELETE / POST_DELETE 이벤트 리스너가 없을 것**

마지막 항목이 실무에서 가장 자주 걸린다. Hibernate 소스의 주석이 두 가지를 콕 집어 언급한다 — **Bean Validation이 PRE_DELETE 리스너를 등록하고, Hibernate Envers가 POST_DELETE 리스너를 등록한다.** 즉 `spring-boot-starter-validation`이 클래스패스에 있는 흔한 프로젝트에서는 이 최적화가 **꺼져 있을 수 있다.**

> **그래서 결론은 "외우지 말고 로그로 확인하라"다.** `delete(getReferenceById(id))`로 바꿨으면 p6spy나 `spring.jpa.show-sql`로 **SELECT가 실제로 사라졌는지 눈으로 확인**하고, 성능이 중요한 경로라면 **쿼리 수를 단정하는 테스트**(`SQLStatementCountValidator.assertSelectCount(0)`)로 고정한다. 최적화 조건이 Hibernate 버전과 프로젝트 설정에 따라 갈리는 종류의 것이라면, **사람의 기억이 아니라 기계가 지켜야 한다.**

### 2-3. `deleteById`에는 "존재하지 않으면 조용히 넘어간다"는 성질이 있다

바꾸기 전에 알아야 할 **의미 차이**가 하나 있다. 현재 Spring Data의 `deleteById` javadoc은 이렇게 적고 있다 — *"If the entity is not found in the persistence store it is silently ignored."* 코드에서도 `findById(id).ifPresent(...)`이므로 **없는 `id`를 지우려 하면 아무 일도 없이 끝난다.**

그런데 `delete(getReferenceById(id))`는 다르다. 최적화 경로를 타서 SELECT 없이 DELETE가 나갔는데 **영향 받은 행이 0개**면, Hibernate는 "누가 먼저 지웠다"고 판단해 **stale state 계열 예외**를 올리고 Spring은 이를 `ObjectOptimisticLockingFailureException`으로 번역한다. 최적화가 꺼져 프록시가 초기화되는 경로였다면 **`EntityNotFoundException`**이 난다.

정리하면 **`deleteById` → `delete(getReferenceById(id))` 치환은 순수한 성능 개선이 아니라 "없는 id를 조용히 넘길 것인가, 예외로 만들 것인가"라는 동작 변경을 동반한다.** 멱등한 삭제 API(같은 요청을 두 번 보내도 200)를 쓰고 있었다면 이 치환이 두 번째 호출을 500으로 바꿔 버릴 수 있다.

> **참고**: 이 자리에서 `EmptyResultDataAccessException`이라는 이름을 기억하는 사람이 많은데, 그건 **예전 Spring Data에서 없는 `id`를 삭제할 때 던지던 예외**다. 지금은 위와 같이 조용히 무시하는 쪽으로 바뀌었다. **"내가 아는 예외 이름이 지금 이 버전에서도 유효한가"를 확인하는 습관**이 필요한 대표적인 지점이고, 이건 바로 다음 절의 주제이기도 하다.

---

## 3. 같은 실수인데 예외 이름이 갈린다 — `EntityNotFoundException` vs `LazyInitializationException`

프록시를 쓰다 사고가 나면 **원인은 하나인데 이름이 두 개**로 나타난다. 이걸 모르면 검색 키워드를 잘못 잡아 엉뚱한 곳을 파게 된다.

| 언제 프록시를 건드렸나 | 행이 DB에 | 나는 예외 | 진짜 원인 |
|---|---|---|---|
| **트랜잭션 안**(영속성 컨텍스트 살아 있음) | 없다 | `EntityNotFoundException` | 존재하지 않는 `id`로 프록시를 만들었다 |
| **트랜잭션 안** | 있다 | 예외 없음 (SELECT 1회 후 정상) | — |
| **트랜잭션 밖**(컨텍스트 닫힘, OSIV 꺼짐) | 있든 없든 | **`LazyInitializationException`** | 프록시를 트랜잭션 밖으로 내보냈다 |
| 초기화 안 하고 FK로만 사용, FK 제약 있음 | 없다 | `DataIntegrityViolationException` (flush 시점) | DB가 막아 줬다 |
| 초기화 안 하고 FK로만 사용, FK 제약 없음 | 없다 | **예외 없음** | 유령 FK가 조용히 저장된다 |

핵심은 이것이다 — **`LazyInitializationException`은 "행이 없어서" 나는 예외가 아니다.** 행이 멀쩡히 있어도 난다. 원인은 **"프록시를 채우려고 봤더니 `EntityManager`(세션)가 이미 닫혀 있더라"**이고, 그래서 DB에 물어볼 수조차 없다는 뜻이다. 반대로 `EntityNotFoundException`은 **DB에 물어볼 수는 있었는데 답이 빈** 경우다.

```java
// before — 서비스가 프록시를 그대로 반환한다. OSIV를 끈 환경에서 지뢰가 된다
@Transactional(readOnly = true)
public Member getMember(Long id) {
    return memberRepository.getReferenceById(id);   // 껍데기가 밖으로 나간다
}

// 컨트롤러: 트랜잭션은 이미 끝났다
@GetMapping("/members/{id}")
public MemberResponse get(@PathVariable Long id) {
    Member m = memberService.getMember(id);
    return new MemberResponse(m.getId(), m.getName());
    //                                     ↑ 여기서 초기화 시도
    //   OSIV 켜짐(기본값) → 세션이 살아 있어 SELECT가 나가고 동작한다 (문제가 숨는다)
    //   OSIV 꺼짐        → LazyInitializationException
}
```

```java
// after — 프록시는 트랜잭션 경계를 넘지 않는다. 밖으로 나가는 것은 DTO뿐이다
@Transactional(readOnly = true)
public MemberResponse getMember(Long id) {
    Member m = memberRepository.findById(id)          // 값이 필요하면 findById가 정답이다
                               .orElseThrow(MemberNotFoundException::new);
    return new MemberResponse(m.getId(), m.getName()); // 트랜잭션 안에서 DTO로 변환
}
```

여기서 **`getReferenceById`와 OSIV 설정이 서로 얽혀 있다**는 점이 중요하다. `open-in-view=true`(Spring Boot 기본값)는 트랜잭션이 끝난 뒤에도 `EntityManager`를 응답이 끝날 때까지 열어 두므로, **위 before 코드가 "잘 돌아간다".** 그러다 커넥션 고갈을 잡으려고 OSIV를 끄는 순간 **여태 잘 돌던 화면들이 `LazyInitializationException`으로 무너진다.** 상세한 전환 절차는 [OSIV 트레이드오프와 전환](09-osiv-tradeoff-and-migration.md)에, 예외 자체의 처방 범위는 [LazyInitializationException](07-lazy-initialization-exception.md)에 정리되어 있다.

**면접에서의 한 문장**: "`getReferenceById`가 만든 프록시는 **트랜잭션 안에서 소비하고 끝내는 것**이 원칙입니다. 밖으로 내보내면 OSIV 설정에 따라 동작이 갈리고, 껐을 때 `LazyInitializationException`으로 한꺼번에 드러납니다."

---

## 4. 프록시는 `getClass()`와 `==`를 배신한다

`getReferenceById`가 돌려준 것은 `Member`가 아니라 **`Member`를 상속한 런타임 생성 클래스**다. 클래스 이름을 찍어 보면 `Member$HibernateProxy$aB3xK1` 같은 것이 나온다.

```java
Member proxy = memberRepository.getReferenceById(1L);

proxy instanceof Member        // true  — 상속했으므로 통과한다
proxy.getClass() == Member.class  // false — 이게 함정이다
proxy.getClass().getSimpleName()  // "Member$HibernateProxy$aB3xK1"
```

`instanceof`는 통과하지만 **`getClass()` 비교는 깨진다.** 그리고 하필 IDE가 자동 생성해 주는 `equals`가 `getClass()` 비교를 쓴다.

```java
// before — IDE가 만들어 준 전형적인 equals. 프록시가 섞이면 조용히 오작동한다
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (o == null || getClass() != o.getClass()) return false;   // ← 여기서 false
    Member member = (Member) o;
    return Objects.equals(id, member.id);
}
```

증상은 이렇게 나타난다.

```java
Member real  = memberRepository.findById(1L).orElseThrow();   // 실제 엔티티
Member proxy = order.getMember();                             // LAZY 연관 → 프록시 (같은 1번)

real.equals(proxy);              // false !!  — 같은 행인데 다르다고 나온다
Set<Member> set = new HashSet<>();
set.add(real);
set.contains(proxy);             // false !!  — 컬렉션에서 못 찾는다
```

**같은 DB 행을 가리키는 두 객체가 서로 다르다고 판정된다.** `Set`에 중복으로 들어가고, `List.contains`가 실패하고, `removeIf`가 아무것도 못 지운다. 원인이 `equals`에 있다는 것을 떠올리기 전까지는 도무지 설명이 안 되는 종류의 버그다.

처방은 두 갈래다.

```java
// after (1) — instanceof 기반. 가장 간단하고 JPA 구현체에 의존하지 않는다
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Member other)) return false;   // 프록시도 Member의 하위 타입이라 통과
    return id != null && id.equals(other.getId());    // ← 필드 직접 접근이 아니라 getId()
}

@Override
public int hashCode() {
    return getClass().hashCode();   // id가 나중에 채워져도 값이 안 변하도록 고정값을 쓴다
}
```

두 가지 주의점이 있다. **① `other.id`가 아니라 `other.getId()`를 써야 한다.** 상대가 프록시일 때 필드를 직접 읽으면 그 프록시의 필드는 비어 있어 `null`이 나온다(프록시의 실제 값은 내부 target 객체에 있다). **② `hashCode()`를 `Objects.hash(id)`로 두면 안 된다.** 아직 `id`가 없는 새 엔티티를 `Set`에 넣은 뒤 저장되어 `id`가 채워지면 해시가 바뀌어 컬렉션에서 영영 못 찾게 된다. 그래서 고정값을 쓴다.

```java
// after (2) — "실질 클래스(effective class)"를 꺼내 비교한다.
//             상속 매핑이 있어 타입 구분이 꼭 필요할 때 쓰는 정석 템플릿이다
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (o == null) return false;
    Class<?> thisClass = effectiveClass(this);
    Class<?> thatClass = effectiveClass(o);
    if (thisClass != thatClass) return false;
    Long thatId = ((Member) o).getId();
    return id != null && id.equals(thatId);
}

@Override
public int hashCode() {
    return effectiveClass(this).hashCode();
}

private static Class<?> effectiveClass(Object o) {
    return (o instanceof HibernateProxy hp)
            ? hp.getHibernateLazyInitializer().getPersistentClass()  // 프록시 → 원래 클래스
            : o.getClass();
}
```

프록시를 **초기화해도 상관없는 상황**이라면 더 짧은 길도 있다. `Hibernate.unproxy(entity)`는 프록시를 벗겨 실제 엔티티를 돌려주고, `Hibernate.getClass(entity)`는 실제 클래스를 돌려준다. 다만 **둘 다 프록시를 초기화하므로 SELECT가 나갈 수 있다** — SELECT를 없애려고 프록시를 쓰는 마당에 `equals` 안에서 SELECT를 유발하면 본말이 전도된다. 그래서 `equals`/`hashCode` 안에서는 **초기화를 일으키지 않는** 위 두 방식을 쓴다.

> 이 주제는 **+α의 `equals`/`hashCode` 문항으로 그대로 이어진다.** "JPA 엔티티의 `equals`/`hashCode`를 어떻게 구현하나요?"라는 질문이 나오면 답의 뼈대는 셋이다 — **① 비즈니스 키가 있으면 그것으로, 없으면 `id`로 ② `getClass()` 대신 `instanceof` 또는 실질 클래스 비교(프록시 때문에) ③ `hashCode`는 `id`에 의존하지 않는 고정값(저장 전후로 해시가 바뀌면 안 되므로)**.

---

## 5. 배치의 진짜 병목은 그다음이다

10만 건 CSV 적재에서 `getReferenceById`로 회원 조회 SELECT 10만 번을 없앴다고 하자. **그래서 얼마나 빨라지는가?** 여기서 멈추면 안 된다.

```
before:  SELECT 100,000회  +  INSERT 100,000회  =  왕복 200,000회
after :                        INSERT 100,000회  =  왕복 100,000회
```

절반은 줄었다. 그러나 **남은 10만 번의 INSERT가 여전히 한 건씩 네트워크를 왕복**한다. 이게 실제 병목이다.

### 5-1. JDBC 배치를 켜면 되지 않나 — `IDENTITY`가 그것을 무력화한다

JDBC에는 여러 문장을 한 번에 보내는 **배치(batch)** 기능이 있고, Hibernate도 `hibernate.jdbc.batch_size`로 이를 지원한다. 그런데 **PK 생성 전략이 `IDENTITY`(MySQL의 `AUTO_INCREMENT`)면 이 기능이 작동하지 않는다.**

이유는 간단하다. `IDENTITY`는 **DB가 INSERT를 실행해야 비로소 `id`가 정해진다.** 그런데 JPA는 `persist()` 시점에 엔티티를 영속성 컨텍스트의 1차 캐시에 `id`를 키로 넣어야 한다. **`id`를 얻으려면 INSERT를 지금 당장 실행할 수밖에 없고**, 그래서 Hibernate는 `IDENTITY` 엔티티에 대해 **쓰기 지연을 포기하고 `persist()`마다 즉시 INSERT를 날린다.** 모아 둘 문장이 없으니 배치도 없다.

```java
// before — 아무리 batch_size를 키워도 INSERT가 한 건씩 나간다
@Entity
public class Order {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)   // ← 배치가 죽는 원인
    private Long id;
}
```

```java
// after — 시퀀스로 바꾸면 id를 미리 확보할 수 있어 INSERT를 모을 수 있다
@Entity
@SequenceGenerator(name = "order_seq", sequenceName = "order_seq",
                   allocationSize = 100)   // 시퀀스를 한 번 호출해 100개를 미리 받아 둔다
public class Order {
    @Id @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "order_seq")
    private Long id;
}
```

```yaml
# 그리고 배치를 실제로 켠다
spring:
  jpa:
    properties:
      hibernate:
        jdbc.batch_size: 100
        order_inserts: true      # 같은 테이블 INSERT끼리 모아야 배치가 먹는다
        order_updates: true
```

`allocationSize`는 **"시퀀스를 한 번 호출해서 번호를 몇 개나 미리 받아 둘 것인가"**다. 기본값 그대로 두면 INSERT마다 시퀀스 조회가 한 번씩 붙어 왕복이 오히려 늘어난다. 다만 값을 키우면 **애플리케이션이 재시작될 때 받아 둔 번호 중 안 쓴 것이 버려져 `id`에 구멍이 생긴다** — `id`가 연속이어야 한다는 요구가 있으면 못 쓴다.

> **MySQL 사용자를 위한 함정 하나(가산점 포인트)**: MySQL은 시퀀스를 지원하지 않아 보통 별도 테이블 기반 전략을 쓰게 되고, 그마저도 **JDBC URL에 `rewriteBatchedStatements=true`를 붙이지 않으면 드라이버가 문장을 실제로 합쳐 보내지 않는다.** 설정을 다 켰는데 안 빨라졌다면 여기를 의심한다.

### 5-2. 그래도 안 되면 ORM 밖으로 내려간다

수십만 건 이상의 순수 적재라면 JPA를 고집할 이유가 없다. **엔티티 인스턴스 10만 개 + 스냅샷 10만 개**를 메모리에 만드는 비용 자체가 부담이고, 변경 감지(dirty checking)는 애초에 필요 없는 기능이다.

```java
// after — 적재 전용 경로는 JdbcTemplate 벌크로 내린다
jdbcTemplate.batchUpdate(
    "insert into orders (member_id, amount) values (?, ?)",
    rows, 1000,
    (ps, row) -> { ps.setLong(1, row.memberId()); ps.setInt(2, row.amount()); }
);
```

JPA를 유지한다면 최소한 **청크마다 `flush()` + `clear()`**로 영속성 컨텍스트가 무한히 커지는 것을 막아야 한다(§6 코드 참고). 이걸 안 하면 SELECT를 없앤 보람도 없이 OOM으로 끝난다.

> 이 절은 고난이도 ⭐⭐⭐의 **"대량 데이터 INSERT 시 JPA의 한계와 JDBC batch / `IDENTITY` 문제"** 문항의 예고편이다. 이번 문항에서 "`getReferenceById`로 SELECT를 없앤다"까지 말한 뒤 **"다만 그건 절반이고, 남은 INSERT는 `IDENTITY`면 배치가 안 걸리므로 시퀀스나 JdbcTemplate으로 내려가야 합니다"**를 덧붙이면, 두 문항을 하나로 꿴 사람이라는 신호가 된다.

---

## 6. 선택 기준을 한 문장으로 고정한다

**축은 성능이 아니라 "존재 검증을 어디서 하느냐"다.**

- **단건 API** → `findById`. 검증을 **호출 지점에서 즉시** 끝낸다. SELECT 한 번이 아깝지 않고, 없는 `id`면 그 줄에서 `404`로 끝나므로 **에러 위치와 원인이 같은 자리에 있다.**
- **대량 처리** → **`IN` 절로 존재를 한 번에 검증**한 뒤 `getReferenceById`. 검증은 유지하되 **N번의 SELECT를 1번으로** 접는다.

같은 말을 다르게 하면 이렇다 — **`findById`를 쓰는 진짜 이유는 "엔티티를 가져오려고"가 아니라 "존재를 확인하려고"인 경우가 대부분이다.** 그렇다면 그 확인을 더 싸게 할 방법이 있으면 `findById`를 버려도 된다. 없으면 버리면 안 된다.

### 6-1. 완성형 패턴 — 일괄 검증 + 프록시 연결

```java
// after — 배치의 정석. 존재 검증은 쿼리 1번으로, 연결은 SELECT 0번으로
@Transactional
public ImportResult importOrders(List<OrderCsvRow> rows) {

    // ── 1) 필요한 회원 id를 중복 제거해 모은다
    //       10만 행이라도 실제 회원 수는 수천일 수 있다. 중복 제거가 첫 번째 절약이다.
    Set<Long> memberIds = rows.stream()
                              .map(OrderCsvRow::memberId)
                              .collect(Collectors.toSet());

    // ── 2) 존재 검증을 한 번의 쿼리로 끝낸다
    //       엔티티를 로딩하지 않고 id 컬럼만 뽑는다 (프로젝션)
    Set<Long> existingIds = findExistingMemberIds(memberIds);

    // ── 3) 누락분은 조용히 넘기지 말고 리포트로 남긴다
    Set<Long> missing = new HashSet<>(memberIds);
    missing.removeAll(existingIds);
    if (!missing.isEmpty()) {
        log.warn("존재하지 않는 회원 {}건 — 해당 행을 건너뜁니다. 예시: {}",
                 missing.size(), missing.stream().limit(20).toList());
        // 정책에 따라 셋 중 하나: 전체 실패시키기 / 해당 행만 스킵 / 오류 파일로 분리 적재
    }

    // ── 4) 검증이 끝났으므로 이제 SELECT 없이 프록시로 연결한다
    int saved = 0;
    for (OrderCsvRow row : rows) {
        if (!existingIds.contains(row.memberId())) continue;   // 검증에서 걸러진 행

        Member ref = memberRepository.getReferenceById(row.memberId());  // SELECT 없음
        em.persist(new Order(ref, row.amount()));

        if (++saved % 1000 == 0) {   // ── 5) 청크마다 비워 준다
            em.flush();
            em.clear();              // 프록시·엔티티가 무한히 쌓이는 것을 막는다
        }
    }
    return new ImportResult(saved, missing);
}

/** id가 많으면 IN 절도 쪼갠다 (Oracle의 1000개 제한, 파서 부하 회피) */
private Set<Long> findExistingMemberIds(Set<Long> ids) {
    Set<Long> result = new HashSet<>();
    for (List<Long> chunk : Lists.partition(new ArrayList<>(ids), 1000)) {
        result.addAll(memberRepository.findExistingIds(chunk));
    }
    return result;
}
```

```java
// 검증 쿼리 — 엔티티가 아니라 id만 가져온다. 영속성 컨텍스트에 아무것도 안 쌓인다
public interface MemberRepository extends JpaRepository<Member, Long> {

    @Query("select m.id from Member m where m.id in :ids")
    List<Long> findExistingIds(@Param("ids") Collection<Long> ids);
}
```

**설계 포인트 네 개**를 짚어 둔다.

**① 왜 `findAllById`가 아니라 id 프로젝션인가.** `findAllById(ids)`도 쿼리 한 번으로 존재를 확인할 수 있어 훨씬 간단하다. 다만 **엔티티를 통째로 로딩해 1차 캐시에 올린다.** 회원 수가 수천 명 수준이면 `findAllById`가 실용적이고(그리고 이미 로딩되었으므로 §7-2에 의해 `getReferenceById`가 실제 엔티티를 그대로 돌려준다 — 결과적으로 추가 SELECT도 없다), 수십만이면 id만 뽑는 편이 안전하다. **판단 기준은 "검증 대상 집합의 크기"**다.

**② 누락분을 예외로 끝내지 않는 이유.** 배치에서 10만 건 중 3건이 잘못됐다고 전체를 실패시키면 재실행 비용이 크다. **어떤 `id`가 왜 빠졌는지 리포트로 남기고 나머지를 처리**하는 편이 대개 낫다. 이것이 `getReferenceById`의 대가인 "발현 지점이 멀어진다"를 실질적으로 상쇄하는 장치다 — **실패를 나중에 발견하는 대신, 아예 미리 목록으로 뽑아 둔다.**

**③ 검증과 사용 사이에 시간 차가 있다.** 검증 쿼리 이후 다른 트랜잭션이 회원을 지우면 프록시는 다시 유령이 된다. **최후 방어선은 여전히 DB의 FK 제약**이다 — 일괄 검증은 FK 제약을 대체하는 것이 아니라 **"장애를 조기에, 읽기 쉬운 형태로 드러내는 층"**을 하나 더 얹는 것이다.

**④ `em.clear()` 이후에도 `getReferenceById`는 안전하다.** 컨텍스트를 비우면 기존 프록시는 준영속이 되지만, 다음 루프에서 `getReferenceById`를 다시 부르면 새 프록시가 만들어진다. 다만 **`clear()` 이전에 만든 프록시를 `clear()` 이후에 초기화하려 하면 `LazyInitializationException`**이 난다(§3의 세 번째 행과 같은 상황이다).

### 6-2. 면접에서 말할 순서

1. "`findById`는 즉시 SELECT, `getReferenceById`는 `id`만 든 프록시입니다."
2. "**연관관계 FK만 채우면 되는 경우**에 `SELECT + INSERT`가 `INSERT` 하나로 줄어듭니다. `deleteById`도 내부적으로 `findById`를 하므로 같은 치환이 가능합니다."
3. "대가는 **실패 지점이 멀어지는 것**입니다. 없는 `id`는 프록시를 실제로 쓸 때, 트랜잭션 안이면 `EntityNotFoundException`, 밖이면 `LazyInitializationException`으로 늦게 드러납니다."
4. "그래서 **선택 기준은 존재 검증을 어디서 하느냐**입니다. 단건 API는 `findById`로 호출 지점에서, 대량 처리는 `IN` 절로 한 번에 검증한 뒤 `getReferenceById`로 SELECT를 없앱니다."
5. "다만 배치라면 **SELECT를 없앤 건 절반**이고, 남은 INSERT는 `IDENTITY` 전략에서 배치가 안 걸리므로 시퀀스나 JdbcTemplate까지 봐야 합니다."

---

## 7. 알아두면 점수가 되는 주변 사실 (가산점 포인트)

### 7-1. `getOne` → `getById` → `getReferenceById`로 이름이 두 번 바뀐 이유

같은 기능이 세 번 이름을 갈아입었다. 처음엔 `getOne`이었고, 다음이 `getById`, 지금이 `getReferenceById`다. **앞의 둘은 deprecated 되었고 최종 정착이 `getReferenceById`다.**

이유는 순전히 **이름이 거짓말을 했기 때문**이다. `getOne`/`getById`는 "하나 가져온다"로 읽히므로 **`findById`와 같은 것인데 `Optional`만 안 씌운 버전**이라고 오해하기 딱 좋았고, 실제로 그렇게 쓰다가 `LazyInitializationException`을 만나는 사례가 끊이지 않았다. 그래서 이름에 **`Reference`(참조)**를 박아 **"이건 실제 값이 아니라 참조를 준다"**를 API 이름만으로 알 수 있게 만든 것이다.

**면접에서의 의미**: 오래된 코드에서 `getOne`을 보면 그건 "옛날 `findById`"가 아니라 **지금의 `getReferenceById`와 정확히 같은 것**이고, 따라서 §3의 지뢰를 그대로 안고 있다는 뜻이다.

### 7-2. 이미 1차 캐시에 있으면 `getReferenceById`는 프록시를 주지 않는다

```java
@Transactional
public void demo1(Long id) {
    Member real  = memberRepository.findById(id).orElseThrow();      // SELECT 발생, 실제 엔티티
    Member ref   = memberRepository.getReferenceById(id);            // SELECT 없음
    System.out.println(ref == real);                                 // true — 프록시가 아니다!
}
```

**이미 영속성 컨텍스트(1차 캐시)에 실제 엔티티가 있으면, `getReferenceById`는 굳이 프록시를 만들지 않고 그 엔티티를 그대로 돌려준다.** 프록시는 "아직 안 읽은 것을 미루기 위한 장치"인데 이미 읽었으니 미룰 것이 없다.

반대 순서는 반대로 동작한다.

```java
@Transactional
public void demo2(Long id) {
    Member ref  = memberRepository.getReferenceById(id);             // 프록시 생성
    Member real = memberRepository.findById(id).orElseThrow();       // SELECT는 나가지만…
    System.out.println(real.getClass().getSimpleName());             // Member$HibernateProxy...
    System.out.println(ref == real);                                 // true — 프록시가 반환된다
}
```

`findById`인데 프록시가 나온다. 이건 버그가 아니라 **동일성 보장(identity guarantee)** 때문이다. JPA는 **"같은 트랜잭션 안에서 같은 `id`를 조회하면 항상 같은 인스턴스를 준다"**를 보장한다. 앞에서 이미 프록시를 인스턴스로 내줬으니, 뒤에서 다른 인스턴스를 줄 수 없어 **그 프록시를 초기화해서(SELECT는 나간다) 같은 인스턴스를 돌려준다.**

**실무적 함의 두 개.** ① `getReferenceById`를 썼다고 해서 반드시 프록시가 나온다고 가정하고 코드를 짜면 안 된다(§4의 `equals` 문제가 **어떤 실행 경로에서는 재현되고 어떤 경로에서는 안 되는** 이유가 이것이다). ② 반대로 **검증 단계에서 `findAllById`로 미리 로딩해 두면 이후 `getReferenceById`는 자동으로 실제 엔티티를 준다** — §6-1의 ①에서 말한 그 얘기다.

### 7-3. `@ManyToOne(fetch = LAZY)` 필드가 사실 같은 물건이다

`getReferenceById`를 별개의 기능으로 기억하면 절반만 아는 것이다. **`@ManyToOne(fetch = LAZY)` 연관 필드에 Hibernate가 넣어 두는 것이 정확히 같은 프록시다.**

```java
@Transactional(readOnly = true)
public void demo3(Long orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();  // orders만 SELECT
    Member m = order.getMember();      // 프록시. 여기까지 SELECT 없음
    Long id  = m.getId();              // 여전히 SELECT 없음 (FK 값은 orders 행에 이미 있었다)
    String n = m.getName();            // ← 여기서 member SELECT 발생 (프록시 초기화)
}
```

그래서 이 문항에서 배운 것들이 그대로 전이된다.

- **`order.getMember().getId()`는 쿼리를 유발하지 않는다.** DTO를 만들 때 `memberId`만 필요하면 fetch join도 필요 없다.
- **§3의 예외 표가 그대로 적용된다.** LAZY 연관을 트랜잭션 밖에서 건드리면 `LazyInitializationException`이다.
- **§4의 `equals` 함정이 그대로 적용된다.** 오히려 이쪽이 더 자주 터진다 — 개발자가 `getReferenceById`를 직접 부른 적이 없어도 프록시는 이미 도처에 있기 때문이다.
- **N+1은 이 프록시들이 루프에서 하나씩 초기화되는 현상**이다.

정리하면 **`getReferenceById`는 "LAZY 연관에서 자동으로 일어나는 일을 개발자가 직접 손으로 하는 것"**이다. 자세한 내용은 [EAGER vs LAZY 페치 전략](03-eager-vs-lazy-fetch-strategy.md)과 [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md)에 있다.

### 7-4. 프록시를 만들 수 없는 엔티티도 있다

Hibernate는 **엔티티 클래스를 상속해서** 프록시를 만든다. 그래서 클래스가 `final`이면 상속할 수 없어 프록시를 못 만들고, **`getReferenceById`가 그냥 SELECT를 날려 실제 엔티티를 반환한다.** 메서드가 `final`인 경우에도 그 메서드는 가로채지 못한다. Kotlin 클래스가 기본적으로 `final`이라 **`kotlin-allopen`(`kotlin-jpa`) 플러그인 없이 JPA 엔티티를 쓰면 지연 로딩이 통째로 무력화**되는 것이 같은 이유다. "분명 LAZY로 걸었는데 SELECT가 다 나간다"의 원인으로 한 번은 의심해 볼 지점이다.

---

## 8. 꼬리질문 대비 포인트

### "`getReferenceById`로 받은 프록시에서 `getId()`를 부르면 SELECT가 나가나요?"

**안 나간다.** `id`는 프록시를 만들 때 이미 알고 있던 값이라 DB에 물어볼 필요가 없다. 초기화를 일으키는 것은 **`id` 이외의 필드에 접근할 때**다.

이 성질이 실무에서 갖는 의미가 크다. **`order.getMember().getId()`만 쓰는 DTO 변환은 회원 테이블을 전혀 읽지 않는다.** 반대로 말하면, DTO에 `memberName` 하나를 추가하는 순간 조용히 N+1이 시작된다 — 코드 변경량은 한 줄인데 쿼리는 N배가 된다. **"필드 하나 추가"가 성능 변경인 지점**을 알아보는 것이 이 질문의 노림수다.

### "그럼 항상 `getReferenceById`를 쓰면 되지 않나요? 어차피 필요하면 알아서 SELECT하는데."

**결국 초기화할 거라면 이득이 0이고 위험만 남는다.** 프록시를 채우는 SELECT나 `findById`의 SELECT나 같은 쿼리 한 번이다. 오히려 나빠지는 경우가 셋이다.

**① 여러 건이면 N+1이 된다.** `findAllById`로 10건을 한 번에 읽는 대신 프록시 10개를 각각 초기화하면 SELECT가 10번 나간다. 프록시 초기화에는 **`IN` 절로 묶는 기능이 기본으로 붙어 있지 않다**(`@BatchSize`나 `default_batch_fetch_size`를 켜야 한다).

**② 실패가 늦게, 엉뚱한 자리에서 드러난다.** `findById`는 없는 `id`를 그 줄에서 알려 준다.

**③ 코드를 읽는 사람이 SQL을 예측할 수 없게 된다.** `getReferenceById`가 곳곳에 뿌려져 있으면 어느 줄에서 쿼리가 나가는지 추적하기 어려워진다.

그래서 원칙은 **"기본은 `findById`, `getReferenceById`는 '이 객체의 필드를 절대 읽지 않는다'가 확실한 자리에만"**이다.

### "서비스에서 `getReferenceById` 결과를 컨트롤러로 넘기면 무슨 일이 나나요?"

**OSIV 설정에 따라 동작이 갈린다.** Spring Boot 기본값(`spring.jpa.open-in-view=true`)에서는 트랜잭션이 끝난 뒤에도 `EntityManager`가 응답 완료까지 열려 있으므로 **컨트롤러에서 초기화가 되고 코드가 잘 돌아간다.** 문제는 그게 "잘 돌아가는 게 아니라 문제가 숨은 것"이라는 점이다 — 커넥션을 뷰 렌더링까지 붙잡고, 나중에 OSIV를 끄면 그동안 쌓인 모든 지뢰가 `LazyInitializationException`으로 한꺼번에 터진다.

그래서 처방은 예외를 잡는 것이 아니라 **경계를 세우는 것**이다. **프록시는 트랜잭션 안에서 소비하고, 밖으로 나가는 것은 DTO뿐**으로 규칙을 정하고, `open-in-view=false` 프로파일로 도는 통합 테스트를 하나 붙여 **기계가 이 규칙을 지키게** 한다. (자세히는 [OSIV 트레이드오프와 전환](09-osiv-tradeoff-and-migration.md).)

### "FK 제약이 있으면 DB가 막아 줍니다. '유니크 제약은 DB를 최후 방어선으로' 원칙과 같은 논리인데, 그럼 `getReferenceById`가 낫지 않나요?" (시니어 변별 포인트)

**"최후 방어선"과 "유일한 방어선"은 다르다.** DB 제약은 **데이터가 깨지는 것을 막는 장치**이고, 애플리케이션의 조기 검증은 **문제를 읽을 수 있는 형태로 드러내는 장치**다. 역할이 다르므로 하나가 다른 하나를 대체하지 않는다.

구체적으로 세 가지가 갈린다. **① 진단 가능성** — FK 위반은 `DataIntegrityViolationException`과 벤더별 에러 코드로 올라온다. 여기서 "몇 번 회원이 없었는지"를 알아내려면 SQL 로그와 바인딩 파라미터를 뒤져야 한다. 반면 `findById`의 `orElseThrow`는 **어떤 `id`가 왜 없었는지를 도메인 언어로** 알려 준다. **② 응답 품질** — 클라이언트에게 `404 존재하지 않는 회원`을 주는 것과 `500 데이터 무결성 위반`을 주는 것은 다른 API다. **③ FK 제약이 항상 있다는 보장이 없다** — 성능이나 샤딩 때문에 FK를 걸지 않는 테이블이 흔하고, 그런 테이블에서는 **아무 예외도 나지 않고 유령 데이터가 그대로 저장된다.**

그리고 결정적으로, **이 둘은 양자택일이 아니다.** §6-1의 패턴이 바로 그 답이다 — **일괄 검증으로 조기에 읽기 쉽게 드러내고, FK 제약은 그대로 두어 최후 방어선으로 남긴다.** 성능(SELECT 제거)과 진단 가능성(조기 검증)을 둘 다 가져가는 방법이 있는데 한쪽을 포기할 이유가 없다.

### "배치에서 `getReferenceById`로 SELECT 10만 번을 없앴습니다. 다음 병목은 무엇이고, 어디까지 내려가겠습니까?" (시니어 변별 포인트)

**남은 INSERT 10만 번**이다. 순서대로 이렇게 접근한다.

**① 먼저 측정한다.** SELECT를 없앤 뒤 실제로 얼마나 줄었는지 확인하지 않고 다음 최적화로 넘어가지 않는다. p6spy로 실제 나가는 문장 수를, `Statistics`로 쿼리 횟수를 본다. 병목이 DB 왕복이 아니라 CSV 파싱이었을 수도 있다.

**② JDBC 배치를 켠다.** `hibernate.jdbc.batch_size`, `order_inserts`. **여기서 `IDENTITY` 전략이면 배치가 아예 안 걸린다** — `id`를 얻으려고 `persist()`마다 즉시 INSERT를 날리기 때문이다. 시퀀스(+`allocationSize`)로 바꿀 수 있는지 검토한다. MySQL이면 JDBC URL의 `rewriteBatchedStatements=true`도 확인한다.

**③ 영속성 컨텍스트를 청크마다 비운다.** `flush()` + `clear()`. 이걸 안 하면 배치를 켜도 메모리에서 무너진다.

**④ 그래도 부족하면 ORM 밖으로 내려간다.** 순수 적재에 변경 감지는 필요 없는 기능인데 스냅샷 비용은 그대로 낸다. `JdbcTemplate.batchUpdate`, 또는 물량이 정말 크면 DB의 벌크 로더(`LOAD DATA INFILE`, `COPY`)까지 간다.

**마지막으로 트레이드오프를 명시한다.** JdbcTemplate으로 내려가면 **엔티티 생명주기·검증·감사 로그(`@CreatedDate` 등)가 전부 우회된다.** 그래서 이 선택은 "적재 전용 경로"로 **격리해 두는 것**이 조건이다 — 일반 도메인 로직과 같은 서비스에 섞으면, 어떤 경로로 들어온 데이터는 감사 컬럼이 채워지고 어떤 경로는 안 채워지는 상태가 되어 나중에 원인 불명의 데이터 불일치로 돌아온다.

### "엔티티의 `equals`/`hashCode`를 구현할 때 프록시 때문에 주의할 점은?"

**IDE가 생성한 `getClass() != o.getClass()` 비교가 프록시에서 깨진다.** 프록시의 실제 클래스는 `Member$HibernateProxy...`라 `Member.class`와 같지 않아서, **같은 행을 가리키는 실제 엔티티와 프록시가 서로 다르다고 판정된다.** `Set`에 중복으로 들어가고 `contains`가 실패한다.

처방은 **`instanceof` 기반 비교** 또는 **실질 클래스 비교**(`HibernateProxy`면 `getHibernateLazyInitializer().getPersistentClass()`)다. 두 가지를 함께 지켜야 한다 — **상대 객체의 필드를 직접 읽지 말고 `getId()`로 읽을 것**(프록시의 필드는 비어 있다), **`hashCode`는 `id`에 의존하지 않는 고정값일 것**(저장되며 `id`가 채워지면 해시가 바뀌어 컬렉션에서 못 찾게 된다). `Hibernate.unproxy()`나 `Hibernate.getClass()`도 정답이지만 **프록시를 초기화하므로 `equals` 안에서 쓰면 의도치 않은 SELECT를 부른다.**

---

## 한 줄 요약

**`findById`는 즉시 SELECT로 실제 엔티티를, `getReferenceById`는 SELECT 없이 `id`만 든 프록시를 주므로 FK만 채우면 되는 자리에서 `SELECT + INSERT`를 `INSERT` 하나로 줄이고 `deleteById`의 숨은 SELECT도 같은 방식으로 없앨 수 있지만, 그 대가는 "없는 `id`였다"는 사실이 프록시를 실제로 쓰는 순간까지 미뤄지는 것 — 트랜잭션 안이면 `EntityNotFoundException`, 밖이면 `LazyInitializationException`이라는 다른 이름으로 — 이므로 선택의 축은 성능이 아니라 "존재 검증을 어디서 하느냐"이고, 단건 API는 `findById`로 호출 지점에서 즉시, 대량 처리는 `IN` 절 일괄 검증 후 `getReferenceById`로 SELECT를 제거하되 거기서 멈추지 말고 남은 INSERT의 `IDENTITY`·JDBC 배치 문제까지 내려가야 한다.**
