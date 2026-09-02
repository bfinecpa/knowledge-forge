# 복합 유니크 제약과 동시 INSERT — JPA는 방어선이 아니다

> 핵심 관전 포인트: 첫 문장에서 오해부터 부순다 — **JPA는 유니크 제약을 검사하지 않는다.** 1차 캐시(영속성 컨텍스트)는 `@Id`, 즉 **기본 키(PK)만을 키로 갖는 Map**이라 `(user_id, coupon_id)` 같은 유니크 컬럼 조합은 **애초에 관리 대상이 아니다.** `persist()`는 "쓰기 지연 SQL 저장소"에 INSERT 문을 쌓아둘 뿐이고, **중복 확인 SELECT를 날리지도, 락을 잡지도 않는다.** 검증은 flush 시점에 **전적으로 DB가** 하고, DB가 던진 `ConstraintViolationException`을 Spring이 `DataIntegrityViolationException`으로 번역해 올려줄 뿐이다. 그래서 `if (exists()) throw; save();` 같은 **애플리케이션 사전 검사는 UX용(친절한 에러 메시지)이지 정합성 보장 수단이 아니다** — 두 스레드가 모두 `false`를 받고 통과하는 틈이 반드시 존재한다. 여기서 사람들이 가장 크게 헛디디는 지점이 하나 더 있다. **예외를 `try/catch`로 잡아도 트랜잭션은 살아나지 않는다.** 제약 위반이 나는 순간 하이버네이트 세션이 오염 상태가 되고 Spring 트랜잭션에 **rollback-only 플래그**가 찍히므로, catch 블록 안에서 이력을 저장하고 정상 종료시켜도 커밋 시점에 **`UnexpectedRollbackException`**이 터지며 그 이력 저장까지 함께 롤백된다. 처방은 후속 작업을 **`REQUIRES_NEW`로 분리**하거나 예외를 **트랜잭션 경계 밖에서** 잡는 것. 그리고 마지막 원칙: **락을 아무리 잘 걸어도 DB 유니크 제약은 절대 빼지 않는다** — 락은 TTL 만료·네트워크 분단·노드 페일오버·락 해제와 커밋의 순서 역전에서 뚫리고, 무엇보다 **배치 잡·운영자 수동 SQL·데이터 마이그레이션처럼 락 획득 코드를 아예 거치지 않는 진입 경로**를 전혀 덮지 못한다. **모든 진입 경로를 덮는 것은 DB 제약뿐이다.**

---

## 0. 질문 + 의도

**질문**: "복합 유니크 제약이 있는 테이블에 동시 INSERT가 몰릴 때 JPA 레벨에서 어떤 문제가 생기나요?"

관련 질문:
"`(user_id, coupon_id)` 복합 유니크 제약이 걸린 쿠폰 발급 테이블에 같은 사용자의 발급 요청이 동시에 들어올 때, JPA 레벨에서 어떤 문제가 생기고 어떻게 대응하겠습니까?"
"분산 락으로 동시 진입을 확실히 막았다면 DB 유니크 제약은 빼도 되나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**중복 체크 후 저장(check-then-act) 패턴이 동시성에서 깨지는 것을 아는지.** 회원가입, 쿠폰 발급 등에서 반복 출제되는 실전 상황으로, **DB 제약을 최후 방어선으로 쓰는 설계 습관**을 본다." 즉 채점 지점은 세 층이다. ① `persist()`와 flush 사이에서 **누가 무엇을 검사하는가**를 사실로 아는가(= JPA는 검사하지 않는다) ② 사전 검사가 깨지는 **시간 순서를 말할 수 있는가** ③ 방어선을 **여러 겹으로 쌓되 가장 아래는 항상 DB**라는 설계 습관이 있는가.

**함정 세 개**:
- **"영속성 컨텍스트가 알아서 걸러준다"는 전제.** ORM이 무언가를 대신 해준다는 인상 때문에 생기는 오해인데, 이 전제 위에서는 "그럼 JPA가 락을 잡겠네 → 커넥션이 고갈되겠네"까지 **틀린 결론이 자동으로 따라온다.** 뒤에서 보겠지만 커넥션 대기는 실제로 일어날 수 있으나 **이유가 완전히 다르다**(§1-8).
- **`try/catch`로 잡으면 끝났다고 믿는 것.** 예외를 잡는 것과 트랜잭션을 살리는 것은 별개다. 이 문항에서 실무 사고를 가르는 지점이 바로 여기다(§2-1~2-5).
- **"락을 걸었으니 제약은 없어도 된다"는 최적화.** 유니크 인덱스는 성능 부담이 아니라 **마지막 안전망**이고, 락이 덮지 못하는 경로가 반드시 존재한다(§2-6~2-8).

## 1. 왜 뚫리는가 — JPA는 검사하지 않고, 사전 검사에는 틈이 있다

### 1-1. 가장 흔한 오해: "영속성 컨텍스트가 중복을 걸러줄 것이다"

많은 사람이 `persist()`(또는 Spring Data JPA의 `save()`)의 동작을 이렇게 상상한다.

```text
① 영속성 컨텍스트가 엔티티의 유니크 컬럼(user_id, coupon_id)을 읽는다
② SELECT ... WHERE user_id = ? AND coupon_id = ?  로 이미 있는지 확인한다
③ 없으면 락을 잡고 INSERT 한다
④ 그래서 중복이 안 생긴다
```

**①~③ 전부 일어나지 않는다.** 하이버네이트는 유니크 컬럼이 무엇인지 **런타임에 알 필요조차 없다.** `@Table(uniqueConstraints = ...)`나 `@Column(unique = true)` 선언은 **DDL(테이블 생성 SQL)을 자동 생성할 때만 쓰이는 메타데이터**이고, INSERT 실행 경로에는 아무 영향을 주지 않는다.

> **왜 이 오해가 생기나**: 하이버네이트는 **PK 중복은 실제로 걸러준다.** 같은 트랜잭션 안에서 이미 관리 중인 id로 `persist()`를 부르면 DB에 가기 전에 `EntityExistsException`이 나기도 한다. 이 경험이 "유니크도 걸러주겠지"로 일반화되는 것이다. **PK와 유니크 제약은 하이버네이트에게 전혀 다른 지위**라는 것이 핵심이다.

### 1-2. 1차 캐시는 `@Id`를 키로 하는 Map이다

영속성 컨텍스트의 1차 캐시를 자료구조로 그리면 이렇다.

```text
Map<EntityKey, Object>
       ↑
   EntityKey = (엔티티 타입, @Id 값)
```

`CouponIssue(id=101, userId=7, couponId=3)`을 관리 중이라면 캐시의 키는 **`(CouponIssue, 101)`** 하나뿐이다. `(7, 3)`이라는 조합은 **키가 아니라 그냥 필드 값**이라, 캐시에 "이미 (7,3)이 있는가?"를 물어볼 방법 자체가 없다. 물어보려면 **캐시 전체를 순회하며 필드를 비교**해야 하는데, 하이버네이트는 그런 일을 하지 않는다.

**그리고 결정적으로, 1차 캐시는 트랜잭션 하나의 범위다.** 설령 캐시가 유니크 조합을 관리한다 해도, **다른 스레드·다른 서버의 트랜잭션이 만든 행은 애초에 보이지 않는다.** 동시성 문제는 정의상 서로 다른 트랜잭션 사이에서 일어나므로, **트랜잭션 안에 갇힌 캐시가 트랜잭션 사이의 충돌을 막는다는 건 구조적으로 불가능하다.**

> 비유하자면 1차 캐시는 **"내가 이번 회의에서 꺼낸 서류들을 사번으로 정리해 둔 내 책상"**이다. 옆자리 동료가 지금 무슨 서류를 쓰고 있는지 내 책상은 알 수 없고, 애초에 "이름+부서 조합으로 찾기"라는 색인도 없다.

### 1-3. `persist()`가 실제로 하는 일

`persist()`는 세 가지만 한다.

1. 엔티티를 **영속 상태(managed)**로 만들어 1차 캐시에 넣는다.
2. **INSERT 문을 "쓰기 지연 SQL 저장소(action queue)"에 쌓아둔다.** — 여기서 "쓰기 지연"은 SQL을 만들어만 두고 **DB로 보내지 않고 미뤄둔다**는 뜻이다.
3. 끝. **SELECT도 없고 락도 없다.**

```java
@Transactional
public void issue(Long userId, Long couponId) {
    CouponIssue issue = new CouponIssue(userId, couponId);
    couponIssueRepository.save(issue);
    // 이 시점의 SQL 로그: (SEQUENCE 전략이면) 아무것도 없거나 시퀀스 조회 한 줄뿐.
    // 중복 확인 SELECT는 존재하지 않는다.
}   // ← 메서드가 끝나며 커밋 → flush → 그제서야 INSERT 가 DB로 나간다
```

**단, "언제 INSERT가 나가는가"는 PK 생성 전략에 따라 갈린다.** 이 차이가 예외가 터지는 코드 줄 위치를 바꾸기 때문에 실무 디버깅에서 중요하다.

```java
// ── ① IDENTITY 전략 (MySQL AUTO_INCREMENT, PostgreSQL identity 컬럼) ──
@Id @GeneratedValue(strategy = GenerationType.IDENTITY)
private Long id;
// save() 하는 그 줄에서 INSERT 가 즉시 나간다.
//   → id 를 DB가 만들어주므로, INSERT 를 해봐야 id 를 알 수 있다.
//   → 쓰기 지연이 원천적으로 불가능하고, 예외도 save() 줄에서 바로 터진다.

// ── ② SEQUENCE 전략 (PostgreSQL, Oracle) ──────────────────
@Id @GeneratedValue(strategy = GenerationType.SEQUENCE)
private Long id;
// save() 시점엔 시퀀스에서 번호만 받아오고 INSERT 는 쌓아둔다.
//   → 예외는 한참 뒤 커밋(flush) 시점에 터진다.
//   → 스택 트레이스가 save() 를 가리키지 않아 원인 추적이 어렵다.
```

### 1-4. 검증은 flush 시점의 DB가 한다 — 예외가 올라오는 3층 구조

flush가 일어나면 쌓아둔 INSERT가 DB로 나가고, 그때 **DB의 유니크 인덱스가** 중복을 발견한다.

그런데 DB가 낸 에러가 우리 코드까지 그대로 올라오지는 않는다. 중간에 **두 번 번역된다.** 번역이 있는 이유는 단순하다 — **위층 코드가 아래층 기술에 묶이지 않게 하려는 것**이다. 서비스 코드가 "MySQL 에러 코드 1062"를 알아야 한다면 그 코드는 PostgreSQL로 못 옮기고, "하이버네이트 예외"를 알아야 한다면 ORM을 못 바꾼다.

```text
[1층] DB — 유니크 인덱스가 중복을 발견하고 벤더 고유의 에러를 낸다
      PostgreSQL:
        ERROR: duplicate key value violates unique constraint "uk_coupon_issue_user_coupon"
        DETAIL: Key (user_id, coupon_id)=(7, 3) already exists.        (SQLSTATE 23505)
      MySQL:
        ERROR 1062 (23000): Duplicate entry '7-3' for key 'uk_coupon_issue_user_coupon'
        │
        │  JDBC 드라이버가 SQLException 으로 감싼다 (벤더 에러 코드가 그대로 담긴다)
        ▼
[2층] 하이버네이트 — SQLException 을 자기 예외 계층으로 번역한다
      org.hibernate.exception.ConstraintViolationException
        │      (getConstraintName() 으로 위반된 제약 이름을 꺼낼 수 있다 → §4)
        │  Spring 의 예외 변환기(PersistenceExceptionTranslator)가 다시 번역
        ▼
[3층] Spring — 벤더·ORM 중립적인 예외 계층으로 바꾼다
      org.springframework.dao.DataIntegrityViolationException
        └ (설정에 따라) 하위 타입 DuplicateKeyException 으로 더 좁혀질 수 있다
```

**애플리케이션 코드가 잡아야 할 것은 3층이다.** 1·2층을 직접 잡으면 DB 벤더나 ORM 구현에 코드가 묶인다. Spring이 이 번역을 해주는 이유가 정확히 그것이다.

**이름 충돌 주의 (가산점 포인트)**: `ConstraintViolationException`이라는 이름의 클래스는 **두 개**다.

```java
org.hibernate.exception.ConstraintViolationException      // DB 제약 위반 (지금 이 문항)
jakarta.validation.ConstraintViolationException           // Bean Validation (@NotNull 등) 위반
```

전혀 다른 층의 예외인데 IDE 자동 임포트가 엉뚱한 쪽을 잡아 **"분명 catch 했는데 안 잡힌다"**는 상황이 실제로 자주 생긴다. 면접에서 이 구분을 짚으면 실제로 겪어본 사람이라는 신호가 된다.

**그런데 "무엇을 catch할 것인가"에는 함정이 하나 더 있다.** `DataIntegrityViolationException`은 유니크 위반뿐 아니라 NOT NULL 위반, 외래 키 위반, 길이 초과까지 포괄하는 넓은 타입이다. **너무 넓게 잡으면 전혀 다른 버그를 "이미 발급됨"으로 오인해 삼켜버린다.**

```java
// before: 너무 넓게 잡아 다른 무결성 오류까지 "중복"으로 취급
catch (DataIntegrityViolationException e) {
    return IssueResult.ALREADY_ISSUED;   // NOT NULL 위반도 여기로 들어온다
}
```

그럼 `DuplicateKeyException`으로 좁혀 잡으면 되지 않나 싶지만, **Spring Data JPA(하이버네이트) 경로에서는 기본 설정으로 그 예외가 오지 않는다.** 하이버네이트의 `ConstraintViolationException`은 `HibernateJpaDialect`에서 `DataIntegrityViolationException`으로 변환될 뿐이고, 그보다 좁은 `DuplicateKeyException`으로 내려가려면 **SQLSTATE를 보고 판단하는 JDBC용 예외 변환기가 끼어 있어야** 하는데 그 자리가 기본값으로 비어 있기 때문이다. (`JdbcTemplate`이나 Spring Data JDBC 경로에서는 그 변환기가 기본으로 동작하므로 `DuplicateKeyException`이 온다 — 같은 Spring인데 경로에 따라 다르다는 것이 헷갈리는 지점이다.)

그래서 선택지는 둘이다.

```java
// after A: 좁은 타입이 오도록 변환기를 켠다.
//   SQLExceptionTranslator 빈이 하나 있으면 Spring Boot가 그것을 JPA 예외 변환 경로에
//   꽂아준다. 그 뒤로는 SQLSTATE 23505(PostgreSQL) / 23000+1062(MySQL) 가
//   DuplicateKeyException 으로 좁혀져 올라온다.
@Bean
SQLExceptionTranslator sqlExceptionTranslator() {
    return new SQLExceptionSubclassTranslator();
}

catch (DuplicateKeyException e) {          // 이제 중복만 정확히 골라낸다
    return IssueResult.ALREADY_ISSUED;
}

// after B: 변환기를 건드리지 않고, 원인 예외에서 제약 이름을 확인해 좁힌다.
catch (DataIntegrityViolationException e) {
    if (e.getCause() instanceof org.hibernate.exception.ConstraintViolationException ce
            && "uk_coupon_issue_user_coupon".equals(ce.getConstraintName())) {
        return IssueResult.ALREADY_ISSUED;
    }
    throw e;                                // 그 외 무결성 오류는 그대로 올려보낸다
}
```

A는 설정 한 번으로 코드가 깔끔해지고, B는 설정 없이 되지만 문자열 비교라 제약 이름을 바꾸는 마이그레이션에 취약하다(§4의 꼬리질문에서 다시 다룬다). **어느 쪽이든 "그냥 `DataIntegrityViolationException`을 통째로 삼키는" 코드보다는 낫다.**

> **확인 범위**: 위 서술은 로컬 캐시의 **spring-orm 6.2.19**(`org.springframework.orm.jpa.vendor.HibernateJpaDialect`), **spring-jdbc 6.2.19**(`SQLExceptionSubclassTranslator`, `SQLStateSQLExceptionTranslator.indicatesDuplicateKey`), **spring-boot-autoconfigure 3.5.16**(`HibernateJpaConfiguration.createJpaVendorAdapter`) 소스를 직접 확인한 것이다. `HibernateJpaDialect`는 `ConstraintViolationException`을 `DataIntegrityViolationException`으로 변환하고, 별도로 주입된 JDBC 예외 변환기가 있을 때만 그 결과를 우선 사용한다. Spring Boot는 컨텍스트에 `SQLExceptionTranslator` 빈이 **유일하게 하나** 있을 때 그것을 주입한다(`ifUnique`). 버전에 따라 동작이 다를 수 있으니 실제 프로젝트에서는 통합 테스트로 어떤 예외가 오는지 한 번 확인하고 쓰는 편이 안전하다.

### 1-5. check-then-act — "확인하고 나서 행동한다"의 사이에 틈이 있다

여기서 이 문항의 핵심 용어가 나온다. **check-then-act**는 말 그대로 **"확인(check)하고 나서 행동(act)한다"**는 뜻이고, 그 둘이 **분리된 두 개의 문장**이라는 데 문제가 있다.

```java
if (!repo.existsByUserIdAndCouponId(userId, couponId)) {   // ← check (확인)
    repo.save(new CouponIssue(userId, couponId));          // ← act  (행동)
}
```

확인이 끝나고 행동이 시작되기까지는 **아무리 짧아도 시간이 걸린다.** 그리고 그 사이에 다른 스레드가 끼어들 수 있다. 끼어든 스레드가 행을 만들어 버리면, 내가 방금 받은 "없다"는 답은 **이미 낡은 정보**가 된다. 이 "끼어들 수 있는 시간 구간"을 **틈(window)** 이라고 부른다.

비유하면 이렇다. **빈 회의실을 확인하고 걸어가는 사이에 다른 팀이 먼저 들어가 앉는 것**과 같다. "비어 있다"를 본 것은 사실이지만, 그 사실은 내가 문을 여는 순간까지 유지된다는 보장이 없다. 예약 시스템(= 원자적 연산)이 필요한 이유가 이것이다.

**원자적(atomic)이라는 말이 여기서 나온다.** 확인과 행동이 **쪼개질 수 없는 한 덩어리로** 실행되면 그 사이에 아무도 끼어들 수 없다. `exists()` + `save()`는 두 덩어리이므로 원자적이지 않다. 반대로 §3-1의 upsert는 확인과 삽입이 **DB의 한 문장 안에서** 일어나므로 원자적이다.

같은 사용자의 요청 두 개가 동시에 들어온 상황을 시간축에 그리면 이렇게 된다.

```text
시각   스레드 A                              스레드 B                        DB의 상태
──────────────────────────────────────────────────────────────────────────────────────
 t1   exists(7,3) → SELECT → false                                          (7,3) 없음
 t2                                        exists(7,3) → SELECT → false     (7,3) 없음
      └──────────────── 둘 다 "없다"를 받고 통과했다 ────────────────┘
 t3   save() → 쓰기 지연 저장소에 적재                                       아직 변화 없음
 t4                                        save() → 쓰기 지연 저장소에 적재  아직 변화 없음
 t5   커밋 → flush → INSERT (7,3)  성공                                     (7,3) 생성됨
 t6                                        커밋 → flush → INSERT (7,3)
 t7                                        중복 발견 → 예외                  (7,3) 하나 유지

      ├────────────── 틈(window) ──────────────┤
      t1의 확인 결과가 t5에서 무효가 되는 구간. 이 구간을 없애지 못하면
      사전 검사는 몇 겹을 해도 같은 방식으로 뚫린다.
```

**t1~t4 구간에서 JPA는 아무것도 막지 않았다.** 막은 것은 t7의 DB 유니크 인덱스 하나뿐이다. 이 그림이 이 문항의 전부라고 해도 과언이 아니다.

그리고 여기서 결론이 하나 자동으로 따라 나온다 — **사전 검사는 정합성 장치가 아니다.** 틈이 존재하는 한, 검사를 두 번 하든 세 번 하든 통과할 수 있다. 사전 검사의 쓸모는 다른 데 있다(§1-7).

### 1-6. 격리 수준을 올려도 이 틈은 사라지지 않는다

여기서 사람들이 마지막으로 붙잡는 희망이 **"트랜잭션 격리 수준을 올리면 되지 않나"**인데, **막을 수 없다.**

전제부터 깔자. **격리 수준(isolation level)** 은 "동시에 도는 트랜잭션들이 서로의 작업을 얼마나 볼 수 있는가"를 정하는 설정이다. 그런데 그 규정의 대상이 **"이미 존재하는 행을 어떻게 보느냐"**이지, **"아직 존재하지 않는 행을 남이 만들려 하는 것"**이 아니다.

REPEATABLE READ에서 두 트랜잭션은 각자의 스냅샷을 보고 둘 다 "없다"고 판단한다 — 스냅샷은 **상대의 미커밋 INSERT를 정의상 보여주지 않기 때문**이다. 즉 격리 수준이 높아질수록 오히려 상대의 작업이 더 안 보인다. (SERIALIZABLE은 이야기가 달라지는데, 그래도 답이 아닌 이유는 §4 꼬리질문에서 따로 다룬다.)

### 1-7. 그럼 사전 검사를 지워야 하나 — 지우지 말고 **역할을 바꿔라**

사전 검사는 여전히 쓸모가 있다. 다만 그 쓸모가 **정합성이 아니라 UX**라는 것을 코드가 드러내야 한다.

```java
// before: 사전 검사가 "정합성 보장 장치"인 척하고 있다
@Transactional
public void issue(Long userId, Long couponId) {
    if (repo.existsByUserIdAndCouponId(userId, couponId)) {
        throw new AlreadyIssuedException();
    }
    repo.save(new CouponIssue(userId, couponId));
    // 문제 1: 동시 요청에서 이 검사는 그냥 통과한다.
    // 문제 2: DB 예외에 대한 처리가 없어, 뚫렸을 때 사용자는 500 을 받는다.
    // 문제 3: 읽는 사람이 "이걸로 막힌다"고 믿게 만든다 — 코드가 거짓말을 한다.
}

// after: 두 층의 역할을 코드가 명시한다
@Transactional
public void issue(Long userId, Long couponId) {
    // [1층 · UX] 흔한 케이스(재클릭, 새로고침)를 친절한 메시지로 걸러낸다.
    //           동시성은 막지 못한다 — 막으라고 둔 것이 아니다.
    if (repo.existsByUserIdAndCouponId(userId, couponId)) {
        throw new AlreadyIssuedException();
    }

    // [2층 · 정합성] 진짜 방어선. 동시 요청에서 뚫린 한 건은 여기서 반드시 걸린다.
    repo.save(new CouponIssue(userId, couponId));
}
```

**주석 두 줄이 이 코드의 핵심이다.** 6개월 뒤의 동료(혹은 AI 코드 리뷰)가 "어차피 DB가 막는데 이 exists는 낭비 아닌가?"라고 물을 때, 혹은 반대로 "exists가 있으니 유니크 제약은 빼도 되겠네"라고 판단할 때, **역할이 적혀 있지 않으면 둘 중 하나는 반드시 잘못 지워진다.**

> 사전 검사에는 **비용을 줄이는 실용적 효과**도 있다. 중복 요청이 많은 화면이라면 대부분을 SELECT 한 방으로 끝내 **예외 생성·트랜잭션 롤백·재시도 비용을 아낀다.** 다만 이건 부가 효과이지 존재 이유가 아니다.

그런데 **after 코드에도 아직 큰 구멍이 남아 있다.** 2층에서 예외가 터졌을 때 그걸 어떻게 처리할 것인가 — 여기서 대부분이 다음 함정에 빠진다(§2).

### 1-8. "커넥션이 고갈된다"는 직관 — 결론은 스칠 수 있으나 이유가 다르다

"동시 INSERT가 몰리면 커넥션이 부족해진다"는 답이 흔히 나온다. **JPA가 락을 잡아서가 아니다.** 실제로 대기가 생긴다면 원인은 **DB 쪽에 있다.**

DB는 유니크 인덱스에 값을 넣기 전에 **같은 값이 이미 있는지 인덱스를 확인**하는데, 그 값을 만든 트랜잭션이 아직 커밋도 롤백도 안 한 상태라면 **결과를 확정할 수 없다.** 커밋되면 중복이고 롤백되면 중복이 아니기 때문이다. 그래서 **뒤에 온 INSERT는 앞 트랜잭션이 끝날 때까지 대기**한다. PostgreSQL은 앞 트랜잭션의 트랜잭션 ID에 걸린 락이 풀릴 때까지 기다리고, MySQL(InnoDB)은 해당 인덱스 레코드의 락을 기다린다 — **표현은 달라도 "앞이 끝나야 내 운명이 정해진다"는 구조는 같다.**

이 대기 동안 그 요청은 **DB 커넥션을 붙잡고 있으므로**, 앞 트랜잭션이 길면(외부 API 호출을 끼워 넣었다든가) 대기 줄이 길어지고 커넥션 풀이 마를 수 있다.

즉 **"커넥션 고갈"이라는 현상은 가능하지만, 그 원인은 JPA의 락이 아니라 DB의 유니크 인덱스 검사 대기**다. 처방도 그래서 달라진다 — "JPA 락을 없애자"가 아니라 **"INSERT를 포함한 트랜잭션을 짧게 유지하고, 외부 호출을 트랜잭션 밖으로 빼자"**가 된다. (같은 이야기가 [낙관적 락 vs 비관적 락](10-optimistic-vs-pessimistic-lock.md)의 "비관적 락의 진짜 대가는 커넥션 점유"와 정확히 겹친다.)

## 2. 방어의 함정 — 예외를 잡아도, 락을 걸어도 끝나지 않는다

### 2-1. 증상: "분명히 catch 했는데 메서드 끝에서 예외가 터진다"

```java
// before: 겉보기엔 완벽한 방어 코드. 그러나 반드시 실패한다.
@Transactional
public IssueResult issue(Long userId, Long couponId) {
    try {
        repo.save(new CouponIssue(userId, couponId));
        return IssueResult.SUCCESS;
    } catch (DataIntegrityViolationException e) {
        // 중복이구나. 이력만 남기고 정상 응답으로 마무리하자.
        issueLogRepository.save(IssueLog.duplicated(userId, couponId));
        return IssueResult.ALREADY_ISSUED;
    }
}
```

이 코드를 실행하면 이렇게 된다.

```text
1. save() → flush → 유니크 위반 → DataIntegrityViolationException
2. catch 진입 — 예외는 정상적으로 잡힌다
3. IssueLog 저장 (겉보기엔 성공)
4. return IssueResult.ALREADY_ISSUED  — 메서드는 정상 종료
5. @Transactional 프록시가 커밋 시도
6. org.springframework.transaction.UnexpectedRollbackException:
     Transaction silently rolled back because it has been marked as rollback-only
7. 3번의 IssueLog 도 함께 롤백되어 사라진다
```

**예외를 잡았지만 트랜잭션은 이미 사형 선고를 받은 상태였다.**

### 2-2. rollback-only 마킹이란 무엇인가 — 예외 객체와 상태 플래그는 다른 층위다

이 절이 이 문서에서 가장 많이 헛디디는 지점이다. 용어부터 정확히 정의하고 가자.

**rollback-only 마킹이란, 트랜잭션 객체에 "이건 무슨 일이 있어도 커밋하면 안 된다"는 표시를 박아두는 것**이다. 스프링 트랜잭션은 커밋할지 롤백할지를 마지막에 한 번 결정하는데, 그 결정 직전에 이 표시를 확인한다. 표시가 켜져 있으면 **개발자가 아무리 정상 리턴을 해도 커밋하지 않는다.** "이 트랜잭션은 커밋 대상에서 제외한다"는 낙인이라고 이해하면 된다.

**그럼 누가 그 표시를 켰는가.** 여기서는 하이버네이트다. 그리고 근거가 두 층에 있다.

**첫째, JPA 명세 차원의 규칙이다.** `EntityManager` 연산이 예외를 던지면 **영속성 제공자(하이버네이트)는 그 트랜잭션을 롤백 대상으로 표시해야 한다**고 명세가 규정한다(조회 결과 없음이나 락 타임아웃 같은 소수 예외를 제외하고). 하이버네이트의 예외 변환 코드가 실제로 그렇게 되어 있다.

```java
// org.hibernate.internal.ExceptionConverterImpl
private void rollbackIfNecessary(PersistenceException e) {
    if ( !( e instanceof NoResultException          // 이 넷만 예외적으로 봐준다
            || e instanceof NonUniqueResultException
            || e instanceof LockTimeoutException
            || e instanceof QueryTimeoutException ) ) {
        try {
            sharedSessionContract.markForRollbackOnly();   // ← 여기서 낙인이 찍힌다
        }
        catch (Exception ne) { ... }
    }
}
```

**이유는 단순하다.** 제약 위반이 난 시점에 **하이버네이트 세션 안의 상태와 DB의 상태가 어긋났고**, 하이버네이트는 어긋난 정도를 정확히 알 수 없다. 쓰기 지연 저장소에 남은 SQL 중 무엇이 나갔고 무엇이 안 나갔는지, 1차 캐시의 어떤 엔티티가 유효한지 보장할 수 없으므로 **"이 세션은 오염됐다. 더 쓰지 말고 버려라"**가 유일하게 안전한 선택이다.

**둘째, 그 표시를 Spring이 커밋 직전에 읽는다.** `try/catch`로는 이 표시를 지울 수 없다. **예외 객체를 잡는 것과 트랜잭션의 상태 플래그를 끄는 것은 완전히 다른 층위**이기 때문이다.

```text
[1] repo.save() → flush → DB 유니크 위반
      └─ 하이버네이트가 세션 트랜잭션에 rollback-only 표시를 켠다  ← 여기가 낙인
[2] 내 catch 블록이 예외 객체를 잡는다
      └─ 잡은 것은 "예외 객체"다. [1]에서 켜진 플래그와는 아무 상관이 없다
[3] catch 안에서 IssueLog 저장 — 같은 트랜잭션이므로 이것도 같은 운명이 된다
[4] 메서드가 정상 리턴 → @Transactional 프록시가 commit() 호출
[5] Spring 이 커밋 직전에 rollback-only 플래그를 확인 → 켜져 있다
[6] 커밋 대신 롤백하고 UnexpectedRollbackException 을 던진다
      └─ [3]의 IssueLog 도 함께 사라진다
```

> 비유: **경보기가 울린 것을 손으로 막았다고 해서, 이미 잠긴 방화 셔터가 열리지는 않는다.** `catch`는 소리를 막았을 뿐이고, 셔터(rollback-only)는 별도 장치다.

**실제로 로그에 찍히는 예외 원문은 이렇다.**

```text
org.springframework.transaction.UnexpectedRollbackException:
    Transaction silently rolled back because it has been marked as rollback-only
    at org.springframework.transaction.support.AbstractPlatformTransactionManager
         .processCommit(AbstractPlatformTransactionManager.java:805)
    at org.springframework.transaction.support.AbstractPlatformTransactionManager
         .commit(AbstractPlatformTransactionManager.java:756)
    ...
```

**"silently(조용히)"라는 단어가 그냥 수사가 아니라 동작의 서술이라는 점이 중요하다.** JPA/하이버네이트 조합에서는 커밋 요청을 받은 하이버네이트가 rollback-only 표시를 보고 **아무 예외도 던지지 않고 조용히 롤백한 뒤 정상 리턴**한다. 그래서 Spring이 미리 기록해 둔 "이건 커밋될 수 없는 트랜잭션이었다"는 사실을 근거로 **뒤늦게** 예외를 만들어 던진다. 즉 **catch 블록 안에서 한 모든 DB 작업이 성공한 것처럼 보이다가 마지막에 통째로 사라진다.**

메시지가 조금 다르게 보일 수도 있다. JDBC/MyBatis처럼 트랜잭션 관리자가 다른 경로에서는 **`Transaction rolled back because it has been marked as rollback-only`**(`silently`가 빠진 형태)로 나온다. **둘은 같은 사건의 다른 경로일 뿐**이므로, 로그에서 어느 쪽을 보든 진단은 같다 — "안쪽에서 rollback-only가 찍혔고 누군가 예외를 삼켰다"부터 의심한다.

> **확인 범위**: 위 두 메시지는 **spring-tx 6.2.19**의 `AbstractPlatformTransactionManager` 소스에 각각 `processCommit`(silently 포함)과 `processRollback`(silently 없음)으로 존재하는 문자열을 그대로 옮긴 것이다. JPA에서 앞쪽 경로를 타는 이유는 **spring-orm 6.2.19**의 `JpaTransactionManager.shouldCommitOnGlobalRollbackOnly()`가 `true`이고, **hibernate-core 6.6.53.Final**의 `JdbcResourceLocalTransactionCoordinatorImpl`이 JPA 준수 모드가 꺼져 있을 때 rollback-only 트랜잭션의 commit을 **예외 없이 롤백 처리**하기 때문이다(소스에서 확인). 스택 트레이스의 줄 번호는 버전에 따라 달라진다.

### 2-3. 처방 ① — 후속 작업을 `REQUIRES_NEW`로 분리한다

살아남아야 하는 작업(이력, 감사 로그, 알림 발송 기록)을 **별도 트랜잭션**으로 떼어낸다.

```java
// after ①: 이력 저장을 독립 트랜잭션으로 분리
@Service
@RequiredArgsConstructor
public class IssueLogService {

    private final IssueLogRepository issueLogRepository;

    @Transactional(propagation = Propagation.REQUIRES_NEW)   // ← 핵심
    public void logDuplicated(Long userId, Long couponId) {
        // 바깥 트랜잭션을 "잠시 보류"시키고 완전히 새 트랜잭션(새 커넥션)에서 실행된다.
        // 바깥이 롤백돼도 이 저장은 독립적으로 커밋되어 살아남는다.
        issueLogRepository.save(IssueLog.duplicated(userId, couponId));
    }
}
```

여기서 `REQUIRES_NEW`가 무엇인지 한 줄로 정의하고 가자. **전파(propagation)** 는 "이미 열려 있는 트랜잭션이 있을 때 이 메서드가 어떻게 행동할지"를 정하는 설정이고, 기본값 `REQUIRED`가 "있으면 합류한다"인 반면 **`REQUIRES_NEW`는 "있어도 무시하고 새 트랜잭션을 따로 연다"**는 뜻이다. 별도 트랜잭션이니 별도 커넥션을 쓰고, 그래서 바깥의 낙인과 무관해진다.

**`REQUIRES_NEW`의 대가 세 가지 (가산점 포인트)** — 공짜가 아니다.

- **커넥션을 하나 더 쓴다.** 바깥 트랜잭션의 커넥션을 붙잡은 채 새 커넥션을 빌리므로, 요청당 커넥션 사용량이 2배가 된다. 트래픽이 몰리는 경로에서 남발하면 **풀 고갈로 교착 상태**가 될 수 있다.
- **같은 클래스 안에서 호출하면 적용되지 않는다.** `this.logDuplicated(...)`는 Spring 프록시를 거치지 않아 `@Transactional`이 통째로 무시된다(자기 호출 문제). 위 예시처럼 **반드시 다른 빈으로 분리**해야 한다.
- **바깥이 롤백돼도 안쪽은 남는다** — 이게 목적이지만, 목적이 아닌 곳에 붙이면 **"주문은 실패했는데 결제 이력만 남는"** 정합성 사고가 된다. 붙이기 전에 "이 기록은 바깥이 실패해도 남아야 하는가?"를 반드시 자문한다.

### 2-4. 처방 ② — 예외를 트랜잭션 경계 **밖**에서 잡는다

더 근본적이고 대개 더 나은 해법이다. **트랜잭션 안에서는 잡지 않고 그대로 터뜨린 뒤, 트랜잭션이 완전히 롤백된 다음 바깥 계층에서 잡는다.**

```java
// after ②: 계층을 나눠 경계 밖에서 처리

// [안쪽] 트랜잭션 담당. 예외를 잡지 않고 그대로 올려보낸다.
@Service
@RequiredArgsConstructor
public class CouponIssueService {

    private final CouponIssueRepository repo;

    @Transactional
    public void issue(Long userId, Long couponId) {
        if (repo.existsByUserIdAndCouponId(userId, couponId)) {   // UX 층
            throw new AlreadyIssuedException();
        }
        repo.save(new CouponIssue(userId, couponId));             // 정합성 층
    }
}

// [바깥] 트랜잭션 없음. 여기서 잡으면 이미 롤백이 끝난 뒤라 안전하다.
@Service
@RequiredArgsConstructor
public class CouponIssueFacade {

    private final CouponIssueService couponIssueService;
    private final IssueLogService issueLogService;

    // @Transactional 을 붙이지 않는 것이 포인트다.
    public IssueResult issue(Long userId, Long couponId) {
        try {
            couponIssueService.issue(userId, couponId);
            return IssueResult.SUCCESS;

        } catch (AlreadyIssuedException e) {                 // 사전 검사에 걸린 흔한 경우
            return IssueResult.ALREADY_ISSUED;

        } catch (DataIntegrityViolationException e) {        // 동시성으로 뚫린 경우
            // 이 시점엔 안쪽 트랜잭션이 이미 롤백 완료 상태다.
            // 여기서 시작하는 DB 작업은 완전히 새 트랜잭션에서 깨끗하게 돌아간다.
            // (§1-4의 after A 설정을 했다면 DuplicateKeyException 으로 더 좁혀 잡는다)
            issueLogService.logDuplicated(userId, couponId);
            return IssueResult.ALREADY_ISSUED;
        }
    }
}
```

이 구조의 이점은 rollback-only 회피만이 아니다. **"트랜잭션 경계"와 "예외를 사용자 응답으로 번역하는 경계"를 물리적으로 분리**했기 때문에, 나중에 누가 파사드에 `@Transactional`을 붙이는 순간 문제가 되살아난다는 것도 **클래스 이름만으로 드러난다.**

### 2-5. 어느 쪽을 고를까

**기본은 ②(경계 밖에서 잡기)다.** 트랜잭션 경계를 단순하게 유지하는 쪽이 언제나 유지보수에 유리하고, 커넥션도 추가로 쓰지 않는다.

**①(`REQUIRES_NEW`)은 "바깥의 성패와 무관하게 반드시 남아야 하는 기록"에만 쓴다.** 감사 로그, 부정 사용 탐지 이력, 외부 결제사 응답 원문처럼 **롤백돼서는 안 되는 증거**가 여기 해당한다.

### 2-6. 락이 뚫리는 경로 ① — 락 로직 자체의 실패

"Redis 분산 락으로 완벽히 막았으니 유니크 인덱스는 빼서 INSERT 성능을 아끼자"는 제안은 실무에서 실제로 나온다. **답은 항상 '안 된다'이고, 중요한 것은 그 근거를 구체적으로 대는 것이다.**

- **TTL 만료.** 락에는 "이 프로세스가 죽어도 영원히 잠기지 않도록" 만료 시간(TTL)을 건다. 그런데 작업이 TTL보다 오래 걸리면(GC 정지, DB 지연, 외부 API 지연) **락이 저절로 풀리고 두 번째 요청이 들어온다.** 첫 번째 요청은 자기 락이 풀린 줄도 모르고 계속 진행한다.
- **네트워크 분단.** 락은 획득했는데 해제 명령이 Redis에 닿지 못하거나, 반대로 애플리케이션이 Redis를 일시적으로 못 봐서 **락 획득 실패를 "락 없이 진행"으로 처리**하는 폴백이 걸려 있으면 그 순간 무방비가 된다.
- **Redis 노드 장애와 페일오버.** 복제가 비동기라면 마스터가 락 정보를 복제본에 넘기기 전에 죽을 수 있다. 승격된 새 마스터에는 **그 락이 아예 존재하지 않으므로** 두 번째 요청이 같은 락을 새로 획득한다.
- **배포 중 락 키 네이밍 변경.** `coupon:issue:{userId}` → `coupon-issue:v2:{userId}:{couponId}`처럼 키 규칙을 바꾸는 배포가 롤링으로 나가면, **구버전 인스턴스와 신버전 인스턴스가 서로 다른 키를 잡는다.** 둘 다 락 획득에 성공하고 둘 다 통과한다.
- **락 해제와 트랜잭션 커밋의 순서 역전 (가장 흔한 실수).** 트랜잭션 안쪽에서 락을 잡으면 **락이 먼저 풀리고 커밋이 나중에 일어난다.** 그 사이에 들어온 두 번째 요청은 아직 커밋되지 않은 첫 번째 요청의 INSERT를 보지 못해 `exists()`에서 `false`를 받는다. **락을 완벽히 구현해도 감싸는 순서를 틀리면 그대로 뚫린다.**

```java
// before: 락이 트랜잭션 안쪽에 있다. 락 해제 → (틈) → 커밋 순서로 뚫린다.
@Transactional
public void issue(Long userId, Long couponId) {
    lock.acquire(key);
    try {
        if (repo.existsByUserIdAndCouponId(userId, couponId)) throw new AlreadyIssuedException();
        repo.save(new CouponIssue(userId, couponId));
    } finally {
        lock.release(key);      // ← 여기서 락이 풀린다
    }
}                               // ← 커밋은 그 다음이다. 이 틈에 다음 요청이 통과한다.

// after: 락이 트랜잭션을 완전히 감싼다. 커밋이 끝난 뒤에야 락이 풀린다.
public void issue(Long userId, Long couponId) {          // 트랜잭션 없음
    lock.acquire(key);
    try {
        couponIssueService.issue(userId, couponId);      // 이 안에서 @Transactional 시작·커밋
    } finally {
        lock.release(key);
    }
}
```

### 2-7. 락이 뚫리는 경로 ② — 락을 아예 거치지 않는 진입 경로

위 다섯 가지는 **락 로직을 잘 짜면 확률을 낮출 수 있다.** 그러나 다음은 **락 로직을 아무리 잘 짜도 확률이 0이 되지 않는다.** 애초에 그 코드를 지나가지 않기 때문이다.

- **배치 잡 / 스케줄러.** "미발급 사용자에게 쿠폰 일괄 발급" 같은 잡은 API 서비스 코드가 아니라 별도 모듈에 있고, **락 획득 코드를 거치지 않는다.**
- **운영자의 수동 SQL.** 장애 대응이나 CS 요청으로 콘솔에서 직접 `INSERT`를 실행하는 순간이 온다. 애플리케이션 락은 이 경로를 인지조차 못 한다.
- **데이터 마이그레이션 / 백필 스크립트.** 다른 테이블에서 옮겨 담거나 과거 데이터를 채워 넣는 작업 역시 애플리케이션 밖이다.
- **다른 팀·다른 서비스의 쓰기.** 같은 DB를 참조하는 관리자 도구나 사내 백오피스가 있다면 그쪽도 락을 모른다.
- **테스트 코드와 시드 데이터.** 성능 테스트용 데이터 주입이 실서비스와 같은 스키마에 들어가는 경우.

**락은 "우리 애플리케이션의 특정 코드 경로"를 지키는 장치이고, 유니크 제약은 "그 테이블에 값을 쓰는 모든 경로"를 지키는 장치다.** 지키는 범위 자체가 다르므로 하나가 다른 하나를 대체할 수 없다.

### 2-8. 방어선을 계층으로 이해하기

```text
계층        수단                              성격
──────────────────────────────────────────────────────────────────────────────
[UI]        중복 클릭 방지 (버튼 비활성화)      오작동 줄이기용. 새로고침·API 직접 호출에 무력
  │
[API]       멱등성 키 / 사전 exists 검사        UX + 비용 절감용. 동시성엔 무력
  │
[App]       분산 락 / 비관적 락                 강력하지만 §2-6·2-7 경로에서 뚫림
  │
[DB]        복합 유니크 제약                    모든 경로를 덮는 유일한 층. 절대 제거 금지
──────────────────────────────────────────────────────────────────────────────
    위로 갈수록 친절하고 싸다  ↑        ↓  아래로 갈수록 확실하다
```

**위층으로 갈수록 사용자 경험이 좋아지고, 아래층으로 갈수록 확실해진다.** 그래서 위층은 "대부분의 경우를 싸고 친절하게 처리"하고, 맨 아래층은 "무슨 일이 있어도 데이터를 지킨다"는 역할 분담이 된다. 어느 층이든 뚫릴 수 있다는 전제로 쌓는 것이 **심층 방어(defense in depth)**이고, 이 문항이 실제로 보려는 설계 습관이 그것이다.

## 3. 처방과 선택 — 원자적 upsert, 판단의 축, 실무의 얼굴들

### 3-1. 제3의 선택지 — 원자적 upsert로 예외 자체를 없앤다

"락으로 막느냐, 예외를 잡느냐"는 이분법에는 세 번째 답이 있다. **DB에게 "있으면 무시하고 없으면 넣어라"를 한 문장으로 시키는 것**이다. §1-5에서 정의한 틈이 여기서는 존재하지 않는다 — 확인과 삽입이 **한 문장 안에서** 일어나기 때문이다.

**upsert**라는 이름은 update와 insert를 합친 말이다. "이미 있으면 갱신(update), 없으면 삽입(insert)"이라는 뜻이고, "있으면 아무것도 안 함"까지 포함해 부른다.

```sql
-- PostgreSQL (이 저장소의 기준 DB) — 어떤 제약에서 충돌할지 명시할 수 있다
INSERT INTO coupon_issue (user_id, coupon_id, issued_at)
VALUES (?, ?, ?)
ON CONFLICT (user_id, coupon_id) DO NOTHING;

-- PostgreSQL — "있으면 갱신"이 요구사항일 때는 DO UPDATE 를 쓴다
-- EXCLUDED 는 "넣으려다 충돌한 그 행"을 가리키는 특수 별칭이다
INSERT INTO coupon_issue (user_id, coupon_id, issued_at)
VALUES (?, ?, ?)
ON CONFLICT (user_id, coupon_id)
DO UPDATE SET issued_at = EXCLUDED.issued_at;

-- MySQL 문법 (벤더가 다르면 구문도 다르다) — 중복이면 조용히 넘어간다
INSERT INTO coupon_issue (user_id, coupon_id, issued_at)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE user_id = user_id;   -- 아무것도 바꾸지 않는 관용구

-- MySQL 문법 — 더 짧지만 위험한 버전 (§3-4 참고)
INSERT IGNORE INTO coupon_issue (user_id, coupon_id, issued_at) VALUES (?, ?, ?);
```

**PostgreSQL의 `ON CONFLICT (user_id, coupon_id)`는 그 컬럼 조합에 유니크 인덱스가 실제로 있어야만 동작한다.** 즉 이 방식조차도 **유니크 제약을 전제로 성립한다** — "제약을 빼도 되나"라는 질문에 대한 또 하나의 답이다.

### 3-2. Spring Data JPA에서 쓰는 법

JPQL에는 이런 구문이 없으므로 **네이티브 쿼리**로 쓴다. 네이티브 쿼리란 JPQL로 번역하지 않고 **DB에 그대로 보내는 SQL**을 말한다.

```java
public interface CouponIssueRepository extends JpaRepository<CouponIssue, Long> {

    @Modifying                                    // 조회가 아니라 "변경" 쿼리라는 표시
    @Query(value = """
            INSERT INTO coupon_issue (user_id, coupon_id, issued_at)
            VALUES (:userId, :couponId, now())
            ON CONFLICT (user_id, coupon_id) DO NOTHING
            """, nativeQuery = true)
    int insertIfAbsent(@Param("userId") Long userId, @Param("couponId") Long couponId);
}
```

```java
@Transactional
public IssueResult issue(Long userId, Long couponId) {
    int affected = repo.insertIfAbsent(userId, couponId);
    // PostgreSQL 의 ON CONFLICT ... DO NOTHING 은 영향 행 수가 이렇게 나온다:
    //   1 = 새로 INSERT 됨,  0 = 충돌해서 아무것도 하지 않음
    return affected == 1 ? IssueResult.SUCCESS : IssueResult.ALREADY_ISSUED;
}
```

MySQL을 쓴다면 같은 자리에 `ON DUPLICATE KEY UPDATE user_id = user_id`가 들어가는데, **영향 행 수의 의미가 다르다는 점에 주의**해야 한다 — MySQL은 `1 = 새로 INSERT 됨`, `2 = 실제로 UPDATE 됨`, `0 = 값이 그대로라 변경 없음`이다. 위처럼 "아무것도 바꾸지 않는" 관용구를 쓰면 중복일 때 0이 돌아온다.

**얻는 것이 두 가지다.** ① 왕복이 한 번이라 가장 빠르고 락 비용이 0이다. ② **예외가 아예 발생하지 않으므로 §2의 rollback-only 문제까지 통째로 우회된다.** 이 두 번째 효과가 특히 크다 — 예외 처리 설계 자체가 사라진다.

### 3-3. 대가 — 영속성 컨텍스트를 우회한다

네이티브 쿼리는 **1차 캐시를 지나치지 않고 곧장 DB로 간다.** 이것은 벌크 연산(`@Modifying` UPDATE/DELETE)과 정확히 같은 성질이며, 같은 함정을 가진다([벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md)).

```java
// before: 방금 넣었는데 조회하면 없다(혹은 옛 값이 보인다)
@Transactional
public void issueAndNotify(Long userId, Long couponId) {
    repo.insertIfAbsent(userId, couponId);                       // DB 에는 들어갔다
    long count = repo.countByUserId(userId);                     // 1차 캐시 상태와 어긋날 수 있다
    CouponIssue issue = repo.findByUserIdAndCouponId(userId, couponId).orElseThrow();
    // ↑ 1차 캐시에 이미 같은 id 의 엔티티가 있었다면 DB 결과가 아니라 캐시본이 반환된다
}

// after: 경계를 명확히 한다
@Transactional
public IssueResult issue(Long userId, Long couponId) {
    int affected = repo.insertIfAbsent(userId, couponId);
    return affected == 1 ? IssueResult.SUCCESS : IssueResult.ALREADY_ISSUED;
    // 이 트랜잭션에서는 결과 코드만 쓰고, 엔티티를 다시 읽지 않는다.
    // 방금 넣은 행이 꼭 필요하면 별도 트랜잭션에서 조회하거나
    // 같은 트랜잭션이라면 명시적으로 컨텍스트를 비운 뒤 조회한다.
}
```

`@Modifying(flushAutomatically = true, clearAutomatically = true)` 옵션으로 "실행 전에 flush, 실행 후에 컨텍스트 비우기"를 자동화할 수는 있다. 다만 컨텍스트를 비우면 **관리 중이던 다른 엔티티의 변경 감지도 함께 날아가므로**, 옵션을 켜는 것보다 **애초에 이 트랜잭션에서 엔티티를 다시 읽지 않도록 경계를 좁게 잡는 편**이 안전하다.

**추가로 잃는 것들**: 하이버네이트의 엔티티 리스너·감사(`@CreatedDate` 등)·`@Version` 증가가 동작하지 않고, SQL이 DB 벤더에 묶인다(PostgreSQL과 MySQL 구문이 다르다). 그래서 upsert는 **"엔티티 생명주기가 단순한 관계 테이블"**에 가장 잘 맞는다 — 쿠폰 발급 이력, 좋아요, 팔로우, 조회 기록처럼 **"있으면 그만, 없으면 만든다"가 전부인 행**이 그렇다.

### 3-4. `INSERT IGNORE`의 함정 (가산점 포인트)

MySQL의 `INSERT IGNORE`는 짧아서 매력적이지만, **무시하는 범위가 중복만이 아니다.** 데이터 잘림, 타입 변환 실패 같은 다른 오류까지 **경고로 낮춰 조용히 통과시킨다.** "쿠폰 코드가 잘려서 저장됐는데 아무도 몰랐다" 같은 사고가 여기서 나온다.

그래서 **의도가 "중복만 무시"라면 `ON DUPLICATE KEY UPDATE`를 쓰는 편이 안전하다.** PostgreSQL의 `ON CONFLICT ... DO NOTHING`은 애초에 충돌만 다루므로 이 문제가 없다.

또 하나: **한 테이블에 유니크 인덱스가 여러 개일 때** upsert 구문이 "어느 제약에서 충돌했는지"를 구분해 주는지가 벤더마다 다르다. PostgreSQL은 `ON CONFLICT (컬럼)`으로 대상 제약을 **지정할 수 있어** 의도한 제약에서만 무시하도록 만들 수 있지만, MySQL은 지정 수단이 없어 **어느 유니크 키에서 충돌해도 똑같이 무시**된다. 그 경우 의도한 제약이 아닌 다른 제약에서 충돌한 것을 **성공으로 오인**할 수 있으므로, 유니크 인덱스가 여럿인 테이블에서는 신중해야 한다.

### 3-5. 그래서 무엇을 고를 것인가

| 상황 | 선택 | 이유 |
|---|---|---|
| 충돌이 드물다 (오타·더블클릭 수준) | 유니크 제약 + 예외 처리 | 평시 비용 0. 충돌할 때만 비용 지불 |
| 충돌이 잦다 (선착순 이벤트) | 사전 차단(분산 락) + 유니크 제약 | 예외·롤백·재시도 비용이 락 비용을 넘어섬 |
| "있으면 무시" 그 자체가 요구사항 | 원자적 upsert + 유니크 제약 | 왕복 1회, 예외 없음, rollback-only 회피 |

표의 세 줄 모두 **오른쪽 끝에 유니크 제약이 있다.** 이것이 이 문항의 결론이다.

판단의 축은 **"충돌 빈도 × 실패 시 비용"**이다. 락은 **모든 요청이 항상 비용을 낸다**(Redis 왕복, 대기 시간, 락 인프라 운영). 예외 처리는 **충돌하는 요청만 비용을 낸다**(예외 생성, 트랜잭션 롤백). 그러니 100건 중 1건이 충돌한다면 99건에게 락 비용을 물리는 것이 손해고, 100건 중 80건이 충돌한다면 80건분의 롤백이 락보다 비싸다.

**upsert는 이 축의 바깥에 있다.** 충돌 여부와 무관하게 왕복 한 번이고 예외도 없으므로, **요구사항이 "있으면 무시"로 정확히 표현되는 경우엔 빈도를 따질 필요조차 없다.** 다만 §3-3의 대가(영속성 컨텍스트 우회, 벤더 종속)를 받아들일 수 있어야 한다.

**실무 순서로 정리하면**: ① 먼저 DB에 복합 유니크 제약을 건다 → ② 요구사항이 "있으면 무시"인지 "중복이면 에러"인지 정한다 → ③ 전자면 upsert, 후자면 예외 처리 → ④ 측정해서 충돌률이 실제로 높을 때만 락을 추가한다. **락은 마지막에 붙이는 최적화이지 출발점이 아니다.**

### 3-6. 실무에서 이 문항이 나타나는 얼굴들

**회원가입 이메일 중복.** 가장 고전적인 사례다. 사용자가 가입 버튼을 두 번 빠르게 누르거나, 응답이 느려 새로고침하면 그대로 재현된다. `exists` 검사만 있고 유니크 인덱스가 없는 서비스는 **같은 이메일로 계정이 두 개 생기고**, 이후 로그인 로직이 `findByEmail`에서 예외를 뿜기 시작한다 — 원인과 증상이 멀어서 추적이 어려운 전형적인 사례다.

**좋아요·팔로우 토글.** 클라이언트가 재시도 로직을 갖고 있으면 같은 요청이 두 번 도착하는 것이 정상 상황이다. 여기는 **upsert가 가장 잘 맞는 자리**다 — "이미 좋아요면 그냥 성공으로 응답"이 곧 요구사항이기 때문이다.

**결제·주문 이중 처리.** 여기서는 유니크 제약이 **멱등성 키(idempotency key)**로 쓰인다. 클라이언트가 만든 요청 식별자를 유니크 컬럼으로 두면, 네트워크 재시도로 같은 요청이 두 번 와도 **두 번째는 DB가 막고 첫 번째 결과를 돌려준다.** 이 패턴을 언급하면 "DB 제약을 단순 검증이 아니라 **설계 도구**로 쓴다"는 신호가 된다. **(가산점 포인트)**

**Soft delete와의 충돌.** 탈퇴를 `deleted_at` 표시로만 처리하면 삭제된 행이 유니크 값을 계속 점유해 **"탈퇴했는데 재가입이 안 됩니다"**가 된다. 흔한 우회는 유니크 키에 삭제 시각이나 삭제 시퀀스를 포함시키는 것인데, 여기엔 **NULL 처리라는 함정**이 따라온다 — 표준 SQL에서 **유니크 인덱스는 NULL을 서로 다른 값으로 취급**하므로, `deleted_at`이 NULL인 행은 아무리 많아도 중복으로 걸리지 않는다. 복합 유니크 키에 nullable 컬럼을 넣을 때 반드시 확인해야 할 사실이다. **(가산점 포인트)**

## 4. 꼬리질문 대비 포인트

### "`save()`를 부르는 그 줄에서 바로 예외가 나나요, 아니면 나중인가요?"

**PK 생성 전략에 따라 다르다**(§1-3).

- **IDENTITY(MySQL AUTO_INCREMENT, PostgreSQL identity 컬럼)**: id를 DB가 만들어주므로 쓰기 지연이 불가능하다. `save()` 호출 즉시 INSERT가 나가고, **그 줄에서 바로 예외가 터진다.**
- **SEQUENCE/TABLE**: id를 미리 확보할 수 있어 INSERT를 쌓아둔다. 예외는 **커밋 직전 flush 시점**에 터지고, 스택 트레이스가 `save()` 호출부를 가리키지 않아 원인 파악이 어렵다.

**진단하려다 헷갈리기 쉬운 점**: `saveAndFlush()`나 JPQL 실행은 강제로 flush를 유발하므로 **엉뚱한 줄에서 예외가 터진 것처럼 보인다.** "코드상 순서와 실제 SQL 실행 순서가 다르다"는 것이 영속성 컨텍스트의 기본 성질이다([영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md)).

### "예외를 잡았을 때, 여러 유니크 제약 중 어느 것이 깨진 건지 구분할 수 있나요?"

**할 수 있지만 방법이 지저분하다.** 하이버네이트의 `org.hibernate.exception.ConstraintViolationException`에는 `getConstraintName()`이 있어 위반된 제약 이름을 얻을 수 있다.

```java
catch (DataIntegrityViolationException e) {
    Throwable cause = e.getCause();
    if (cause instanceof org.hibernate.exception.ConstraintViolationException ce) {
        String name = ce.getConstraintName();   // 예: "uk_coupon_issue_user_coupon"
        if ("uk_coupon_issue_user_coupon".equals(name)) return IssueResult.ALREADY_ISSUED;
        if ("uk_coupon_issue_serial".equals(name))      return IssueResult.SERIAL_TAKEN;
    }
    throw e;
}
```

**두 가지가 전제된다.** ① **제약에 사람이 읽을 수 있는 이름을 붙여야 한다.** 이름을 안 주면 DB가 자동 생성한 이름이 붙어 코드가 그 이름에 묶인다. ② 결국 **문자열 비교라 취약하다** — 제약 이름을 바꾸는 마이그레이션에 분기가 조용히 깨진다.

**예외 타입만으로는 구분이 안 된다는 점도 짚으면 좋다.** `DuplicateKeyException`까지 좁혀 잡아도 그것은 "유니크/PK 중복"이라는 사실만 알려줄 뿐 **어느 제약인지는 알려주지 않는다.** 게다가 그 좁은 타입 자체가 JPA 경로에서는 기본 설정으로 오지 않는다(§1-4).

그래서 실무에서는 **분기가 필요할 만큼 제약이 여러 개라면, 애초에 예외 분기 대신 사전 검사(UX 층)에서 케이스를 나눠 메시지를 만드는 편**을 택하는 경우가 많다. 예외 처리는 "뚫린 소수 케이스의 안전한 마무리"에만 쓰는 것이다.

### "유니크 위반이 나면 재시도를 걸면 되지 않나요?" (시니어 변별 포인트)

**안 된다. 유니크 위반은 재시도 대상이 아니다.** 여기서 **일시적 실패(transient)**와 **결정적 실패(deterministic)**를 구분해야 한다.

- **데드락, 락 타임아웃, 낙관적 락 충돌**은 일시적이다. 같은 작업을 다시 하면 이번엔 성공할 수 있다 — 그래서 재시도가 정답이다([낙관적 락 vs 비관적 락](10-optimistic-vs-pessimistic-lock.md)).
- **유니크 위반은 결정적이다.** 같은 값으로 다시 INSERT하면 **100% 다시 실패한다.** 앞선 트랜잭션이 커밋해 그 행은 이미 존재하기 때문이다. 재시도는 **실패를 늦출 뿐 아니라 DB에 무의미한 부하를 더한다.**

**따라서 유니크 위반의 올바른 처리는 재시도가 아니라 "결과 해석"이다.** "이미 존재한다"는 것은 대개 **원하던 상태가 이미 달성됐다**는 뜻이므로, 요구사항에 따라 성공(멱등)으로 응답하거나 "이미 발급됨"으로 응답한다. 이 구분을 말할 수 있으면 재시도 정책을 설계해 본 사람이라는 신호가 된다.

**(주의)** 다만 `@Retryable`을 `DataIntegrityViolationException`에 걸어두는 코드가 실제로 존재하는데, §2의 rollback-only 문제와 겹치면 **"영원히 실패하며 커넥션만 소모하는 루프"**가 된다. 재시도 대상 예외는 **일시적 실패로 한정**해야 한다.

### "트랜잭션 격리 수준을 SERIALIZABLE로 올리면 유니크 제약 없이 막을 수 있나요?" (시니어 변별 포인트)

**이론적으로는 막히지만, 실무적으로는 답이 아니다.**

먼저 **REPEATABLE READ로는 못 막는다.** 격리 수준은 "이미 존재하는 행을 어떻게 볼 것인가"를 규정할 뿐, "아직 없는 행을 남이 만드는 것"을 다루지 않는다. 두 트랜잭션은 각자의 스냅샷에서 "없다"를 읽고 둘 다 통과한다(§1-6).

**SERIALIZABLE로 올리면 동작 방식이 달라진다.** PostgreSQL은 직렬화 이상(serialization anomaly)을 탐지해 한쪽에 **직렬화 실패 예외**를 던지고, MySQL(InnoDB)은 일반 SELECT를 잠금 읽기로 승격시켜 두 트랜잭션이 서로의 공유 락 때문에 진행하지 못해 **데드락으로 한쪽이 죽는다** — 어느 쪽도 "막았다"기보다 **"실패시켰다"**에 가깝다.

**어느 쪽이든 실무 답이 아닌 이유가 셋이다.** ① 격리 수준은 **트랜잭션 전체에 걸리므로**, 이 한 줄을 지키려고 무관한 모든 쿼리의 동시성까지 희생한다. ② 데드락·직렬화 실패는 **재시도 로직을 강제**하므로 유니크 제약보다 처리가 복잡해진다. ③ 무엇보다 **§2-7의 "락을 안 거치는 경로"는 여전히 안 막힌다** — 격리 수준은 트랜잭션을 쓰는 코드에만 적용되기 때문이다.

**한 문장으로**: "SERIALIZABLE은 이 문제를 풀 수 있지만, **유니크 인덱스 하나로 되는 일을 서비스 전체의 동시성을 팔아서 하는 것**이라 선택지가 아니다."

### "`@Table(uniqueConstraints = ...)`를 붙였는데 운영 DB엔 제약이 없었습니다. 왜죠?"

**이 애노테이션은 DDL 자동 생성에만 쓰이는 메타데이터이기 때문이다.** 운영 환경은 보통 `spring.jpa.hibernate.ddl-auto=none`(또는 `validate`)이므로 **하이버네이트가 테이블을 만들지 않는다.** 즉 애노테이션은 **문서로만 남고 실제 인덱스는 생기지 않는다.**

**처방**: 실제 제약은 **Flyway/Liquibase 같은 마이그레이션 도구로 DDL을 명시**해 만든다. 그리고 `ddl-auto=validate`로 두면 애플리케이션 기동 시 **엔티티 매핑과 실제 스키마가 어긋나면 실패**하게 만들 수 있다 — "선언은 있는데 실물이 없다"를 배포 전에 잡는 안전망이다.

**여기에 실무에서 반드시 부딪히는 문제가 하나 더 있다 (가산점 포인트)**: **이미 중복 데이터가 쌓인 테이블에는 유니크 인덱스를 만들 수 없다.** 마이그레이션이 통째로 실패한다. 그래서 순서가 이렇게 된다 — ① 중복 행을 조회해 파악 → ② 비즈니스 규칙에 따라 정리(가장 오래된 것만 남기기 등) → ③ 그 다음에 인덱스 생성. **"제약을 지금 추가하면 되지 않나"라는 말이 대형 테이블에서는 며칠짜리 작업**이라는 감각까지 보여주면 좋다.

### "이 동시성 상황을 테스트로 어떻게 고정하나요?" (가산점 포인트)

**가장 흔한 실패는 `@Transactional` 테스트로 재현을 시도하는 것**이다. 테스트 메서드에 `@Transactional`이 붙으면 모든 작업이 한 트랜잭션에 묶여 **애초에 동시성이 존재하지 않고**, 게다가 테스트가 끝나며 롤백되므로 다른 스레드가 커밋된 데이터를 볼 수도 없다. **동시성 테스트에서는 `@Transactional`을 떼고, 뒷정리를 직접 해야 한다.**

```java
@Test
void 동시_요청_중_한_건만_성공한다() throws Exception {
    int threads = 10;
    var ready = new CountDownLatch(threads);   // 전원 준비 완료 대기
    var start = new CountDownLatch(1);         // 동시 출발 신호
    var done  = new CountDownLatch(threads);
    var success = new AtomicInteger();
    var pool = Executors.newFixedThreadPool(threads);

    for (int i = 0; i < threads; i++) {
        pool.submit(() -> {
            ready.countDown();
            try {
                start.await();                 // ← 여기서 전원이 동시에 출발한다
                facade.issue(USER_ID, COUPON_ID);
                success.incrementAndGet();
            } catch (Exception ignored) {
            } finally {
                done.countDown();
            }
        });
    }
    ready.await();
    start.countDown();                         // 출발 신호
    done.await();

    assertThat(success.get()).isEqualTo(1);                                  // 성공은 정확히 1건
    assertThat(repo.countByUserIdAndCouponId(USER_ID, COUPON_ID)).isEqualTo(1); // DB에도 1행
}
```

**`CountDownLatch`가 핵심**이다. 스레드를 그냥 띄우면 먼저 뜬 스레드가 이미 끝난 뒤에 다음이 시작돼 **경합이 재현되지 않는다.** 전원이 준비될 때까지 붙잡아 뒀다가 동시에 출발시켜야 §1-5의 시간축이 실제로 만들어진다.

**그리고 이 테스트의 진짜 가치는 회귀 방지다.** 누군가 "유니크 인덱스가 성능에 부담이니 빼자"거나 "락이 있으니 제약은 없어도 된다"고 판단하는 순간, 이 테스트가 실패해서 막아준다. **주장으로 남겨둔 설계 원칙은 언젠가 지워지고, 테스트로 고정한 원칙만 살아남는다.**

---

## 한 줄 요약

**JPA는 유니크 제약을 검사하지 않는다** — 1차 캐시는 `@Id`를 키로 하는 Map이라 유니크 컬럼 조합은 관리 대상이 아니고, `persist()`는 쓰기 지연 저장소에 INSERT를 쌓을 뿐 **SELECT도 락도 없으며**, 검증은 flush 시점에 **전적으로 DB가** 한다. 그래서 `exists()` → `save()` 사전 검사는 **UX용이지 정합성 보장 수단이 아니고**(확인과 행동 사이의 틈은 격리 수준을 올려도 사라지지 않는다), 뚫린 한 건에서 나는 예외는 **잡아도 트랜잭션을 살리지 못한다**(rollback-only 마킹 → 커밋 시 `UnexpectedRollbackException`, catch 안의 저장까지 소멸 → **`REQUIRES_NEW` 분리 또는 트랜잭션 경계 밖에서 catch**). 대응은 **충돌 빈도 × 실패 비용**으로 고르되 — 드물면 예외 처리, 잦으면 사전 차단, "있으면 무시"면 **원자적 upsert(`INSERT ... ON CONFLICT DO NOTHING`)가 예외 자체를 없앤다** — **어느 쪽을 고르든 DB 복합 유니크 제약은 항상 남긴다.** 락은 TTL 만료·네트워크 분단·노드 페일오버·락 해제와 커밋의 순서 역전에서 뚫리고, 무엇보다 **배치 잡·운영자 수동 SQL·마이그레이션처럼 락 코드를 거치지 않는 경로를 전혀 덮지 못하기 때문이다.** 그리고 이 원칙은 **`CountDownLatch`로 동시 출발시킨 테스트로 고정하기 전까지는 언젠가 지워질 주장일 뿐이다.**
