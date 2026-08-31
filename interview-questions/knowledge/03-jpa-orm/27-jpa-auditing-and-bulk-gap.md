# JPA Auditing과 벌크 연산의 구멍 — "자동으로 채워진다"의 자동은 어느 경로에서만 참인가

> 핵심 관전 포인트: **JPA Auditing은 마법이 아니라 `@PrePersist`/`@PreUpdate`라는 엔티티 생명주기 콜백에 얹힌 코드다.** `AuditingEntityListener`는 **영속성 컨텍스트가 "이 엔티티를 지금 INSERT/UPDATE 하겠다"고 결정하는 순간에만** 호출되므로, **그 결정을 거치지 않는 경로 — 벌크 JPQL(`@Modifying`), 네이티브 쿼리, `JdbcTemplate`, DB 콘솔의 수동 SQL — 에서는 값이 전부 빠진다.** 그리고 이 누락의 성질이 핵심이다. **예외도, 경고 로그도, 실패 카운트도 없다. 조용히 빠진다.** 10만 건의 `updated_at`이 옛날 값 그대로여도 배치는 "성공"으로 끝난다. 처방은 **벌크를 유지한다면 SET 절에 감사 필드를 직접 쓰는 것**(`set m.status = 'DORMANT', m.updatedAt = :now, m.updatedBy = 'BATCH_DORMANT'`)이고, 건수가 감당 범위면 **엔티티를 로드해 변경 감지로 처리하는 것**(대가: 왕복 N번 + 영속성 컨텍스트 누적)이다. 여기서 **시각만 생각하면 절반만 답한 것**이다 — **`@LastModifiedBy`(주체)도 같이 빠지고**, 게다가 `AuditorAware`는 보통 SecurityContext에서 사용자를 꺼내는데 **배치 스레드에는 그것이 없어 평소 경로에서도 `null`이 되는** 별개의 함정이 따라온다. 마지막으로 **감사(監査) 요구가 걸린 데이터라면 애플리케이션 레벨 Auditing은 신뢰 경계가 애플리케이션 안쪽이라는 점을 인정해야 한다** — Hibernate Envers나 DB 트리거로 내리되, **Envers도 벌크 연산에서는 똑같이 빠진다.** 그래서 실무 규칙은 **감사 대상 엔티티에 벌크 연산 금지**(ArchUnit 룰/리뷰 규칙) 또는 **이력 테이블에 직접 남기는 경로를 함께 만드는 것**이고, 이 규칙은 **테스트로 단정하기 전까지 언젠가 지워질 주장일 뿐이다.**

---

## 0. 질문 + 의도

**질문**: "JPA Auditing(생성/수정 시각·주체 자동 기록)은 어떻게 동작하나요? 벌크 연산에서는 왜 기록되지 않나요?"

**면접 시나리오**: `BaseEntity`에 `@EntityListeners(AuditingEntityListener.class)` + `@CreatedDate`/`@LastModifiedDate`/`@LastModifiedBy`를 적용해 잘 동작하고 있다. 그런데 **휴면 전환 벌크 UPDATE로 바뀐 10만 건은 `updatedAt`이 예전 값 그대로**다. 왜이며 어떻게 처리하나?

**출제 의도**: rationale은 이렇게 적고 있다 — "**생성/수정 이력이 리스너(영속성 컨텍스트 이벤트) 기반이라 벌크 연산·네이티브 쿼리에서는 조용히 빠진다는 것을 아는지 — '자동으로 되는 것'의 동작 경로를 알아야 안 되는 경우도 예측할 수 있다. 감사 요구가 있는 데이터라면 이 구멍이 곧 컴플라이언스 이슈다.**"

즉 채점 지점은 "Auditing을 설정할 줄 아느냐"가 아니다. 그건 스타터 문서 한 페이지다. 채점 지점은 셋이다.

1. **동작 경로를 말할 수 있는가** — "리스너다"에서 멈추지 않고 **"어느 이벤트에 걸려 있고, 그 이벤트는 누가 발생시키는가"**까지.
2. **경로를 알기 때문에 예외를 예측할 수 있는가** — 벌크·네이티브·`JdbcTemplate`·트리거 없는 수동 SQL. **아직 겪지 않은 경로도 같은 논리로 판정**할 수 있는가.
3. **감사 요구라는 층위를 아는가** — 애플리케이션 레벨 Auditing의 **신뢰 경계가 어디까지인지**, 그 밖을 요구받으면 무엇으로 내려가는지.

**함정 세 개**:
- **처방에서 도구를 바꿔 잡는 것.** "배치 사이즈 옵션으로 처리한다" 같은 답이 여기서 나온다. **`hibernate.jdbc.batch_size`는 값을 채우는 기능이 아니다**(§4). 원인 진단이 맞아도 처방에서 엉뚱한 도구를 집으면 그 자리에서 "도구의 적용 범위를 모르는 사람"이 된다.
- **시각만 답하고 주체를 빠뜨리는 것.** `updatedAt`만 고쳐놓고 `updatedBy`는 여전히 비어 있는 배치가 실무에 흔하다(§6).
- **"Envers 쓰면 됩니다"로 끝내는 것.** **Envers도 같은 이유로 벌크에서 빠진다**(§7-2). 도구 이름을 대는 것과 **그 도구가 못 막는 것을 아는 것**은 다른 능력이다.

> **이 문항에서 이미 도달해 있는 지점**(면접 기록 기준): 메커니즘은 **경험 없이 추론만으로 정확히 맞혔다** — "`@EntityListeners`는 영속성 컨텍스트에 있는 엔티티만 대상이니 벌크는 그 경로를 안 타서 빠진다." 벌크를 유지한 채 남기는 법도 정확했다("업데이트 문에 추가한다"). 그리고 설계·규율 질문에 **유도 없이 "테스트 코드로 막는다"**는 안전망 답변이 나왔다. 그러니 이 문서가 채울 것은 원인 진단이 아니라 **① 처방에서 집을 도구의 정확한 이름과 적용 범위 ② 주체(`@LastModifiedBy`) 축 ③ 감사 요구가 걸린 데이터의 설계 층 ④ "테스트로 막는다"의 구체적 형태**, 이 네 가지다.

---

## 1. 최소 동작 코드 — Auditing은 무엇을 켜야 동작하는가

원인을 이야기하기 전에 **전체 부품을 한 화면에 올려둔다.** 이 문항의 답은 "이 부품들 중 무엇이 언제 호출되는가"로 환원되기 때문이다.

### 1-1. 부품 네 개

```java
// ① 기능 활성화 — 이게 없으면 애노테이션이 있어도 아무 일도 일어나지 않는다
@Configuration
@EnableJpaAuditing                       // (선택) auditorAwareRef = "auditorProvider"
public class JpaAuditingConfig {

    // ③ 주체(누가 바꿨는가)를 공급하는 부품
    @Bean
    public AuditorAware<String> auditorProvider() {
        return () -> {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth == null || !auth.isAuthenticated()) {
                return Optional.empty();          // ← §6 의 함정이 여기서 시작된다
            }
            return Optional.of(auth.getName());
        };
    }
}
```

```java
// ② 공통 필드 묶음 — 테이블은 만들지 않고 컬럼만 자식에게 물려준다
@Getter
@MappedSuperclass                                   // 이 클래스용 테이블은 생기지 않는다
@EntityListeners(AuditingEntityListener.class)      // ★ 이 한 줄이 콜백을 등록한다
public abstract class BaseEntity {

    @CreatedDate
    @Column(updatable = false)                      // 생성 시각은 이후 UPDATE에서 제외
    private LocalDateTime createdAt;

    @LastModifiedDate
    private LocalDateTime updatedAt;

    @CreatedBy
    @Column(updatable = false)
    private String createdBy;

    @LastModifiedBy
    private String updatedBy;
}
```

```java
// ④ 실제 엔티티 — 상속만 하면 네 컬럼이 따라온다
@Entity
@Getter
public class Member extends BaseEntity {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String email;

    @Enumerated(EnumType.STRING)
    private MemberStatus status;       // ACTIVE / DORMANT / WITHDRAWN

    private LocalDateTime lastLoginAt;

    public void toDormant() {          // ← 도메인 메서드(변경 감지 경로)
        this.status = MemberStatus.DORMANT;
    }
}
```

**부품별 역할을 한 줄씩 고정한다.**

| 부품 | 하는 일 | 없으면 |
|---|---|---|
| `@EnableJpaAuditing` | 리스너가 쓸 인프라(시각 공급자, `AuditorAware`)를 컨텍스트에 등록 | 애노테이션이 **조용히 무시**된다 — 필드가 계속 `null` |
| `@EntityListeners(AuditingEntityListener.class)` | 그 엔티티에 **생명주기 콜백을 붙인다** | 그 엔티티만 Auditing 미적용 |
| `@MappedSuperclass BaseEntity` | 컬럼·애노테이션을 상속으로 배포 | 엔티티마다 네 필드를 복붙 |
| `AuditorAware<T>` | **주체**를 공급 | `@CreatedBy`/`@LastModifiedBy`가 `null` |

> **첫 번째 실수 유형이 여기 있다**: `@EnableJpaAuditing`을 빼먹으면 **컴파일도 되고 실행도 되고 예외도 없다.** 그냥 컬럼이 계속 비어 있을 뿐이다. **이 문항의 모든 실패 모드가 공유하는 성질** — 조용하다 — 이 설정 단계에서부터 시작된다.

### 1-2. `@MappedSuperclass`에 붙였는데 왜 자식에 적용되나

`@EntityListeners`는 **상속된다.** `BaseEntity`에 한 번 붙이면 `Member`, `Order`, `Payment` 전부에 콜백이 등록된다. "코드 한 줄로 전 엔티티에 감사 컬럼을 배포"라는 이 편의성이 애플리케이션 레벨 Auditing의 **최대 장점**이자, §8에서 볼 **최대 약점의 뿌리**이기도 하다 — 편하게 켜지는 만큼 **어디까지 적용되는지 감각이 흐려진다.**

---

## 2. 동작 경로 — 리스너는 "생명주기 이벤트"에 얹혀 있다

### 2-1. 한 문장으로

**`AuditingEntityListener`는 JPA 표준 콜백인 `@PrePersist`와 `@PreUpdate` 메서드를 가진 평범한 클래스다.**

```java
// 개념적으로 이렇게 생겼다 (실제 구현의 요지)
public class AuditingEntityListener {

    @PrePersist                                  // INSERT 직전
    public void touchForCreate(Object target) {
        // createdAt / createdBy / updatedAt / updatedBy 를 채운다
    }

    @PreUpdate                                   // UPDATE 직전
    public void touchForUpdate(Object target) {
        // updatedAt / updatedBy 를 채운다
    }
}
```

여기서 **모든 답이 나온다.** `@PrePersist`/`@PreUpdate`는 **누가 호출하는가?** 하이버네이트다. 정확히는 **영속성 컨텍스트가 "이 엔티티 객체에 대해 INSERT/UPDATE 문을 만들겠다"고 결정하는 순간**이다.

> **비유하자면** — Auditing은 **출입문에 달린 자동 방명록**이다. 사람이 그 문으로 들어오면 이름과 시각이 자동으로 적힌다. 아주 잘 동작한다. **단, 창문으로 들어온 사람은 적히지 않는다.** 방명록은 사람을 감지하는 게 아니라 **문의 개폐를 감지**하기 때문이다. 벌크 UPDATE·네이티브 쿼리·`JdbcTemplate`은 전부 **창문**이다. 그리고 방명록은 "누가 창문으로 들어왔다"고 경고하지 않는다 — **그냥 아무것도 안 적힐 뿐이다.**

### 2-2. 정상 경로를 타임라인으로

`Member` 한 명을 휴면으로 바꾸는 **변경 감지 경로**를 따라가 본다.

```java
@Transactional
public void toDormant(Long memberId) {
    Member m = memberRepository.findById(memberId).orElseThrow();
    m.toDormant();                    // status 만 바꿨다. updatedAt 은 안 건드렸다.
}                                     // ← 커밋
```

```
① findById            → SELECT, 영속성 컨텍스트에 엔티티 + 스냅샷 적재
② m.toDormant()       → 자바 객체의 필드만 바뀜. SQL 은 아직 없다.
③ 커밋 → flush 시작
④ dirty checking      → 스냅샷과 비교 → "status 가 바뀌었다. UPDATE 대상이다"  ★ 여기서 판정
⑤ @PreUpdate 콜백 발생 → AuditingEntityListener.touchForUpdate() 호출
                         updatedAt = now, updatedBy = AuditorAware 가 준 값
⑥ UPDATE member SET status=?, updated_at=?, updated_by=?, ... WHERE id=?
⑦ 커밋
```

**④와 ⑤의 순서가 이 문항의 급소다.** 리스너는 ④의 **결과로** 호출된다. 즉

> **"영속성 컨텍스트가 이 엔티티를 변경 대상으로 판정했다"가 리스너 호출의 전제조건이다.**

그러니 판정 자체가 일어나지 않는 경로에서는 리스너가 **호출될 계기가 없다.** 벌크 UPDATE는 엔티티를 메모리에 올리지도 않으므로 비교할 스냅샷도, 판정할 대상도 없다.

### 2-3. 부수적으로 따라오는 두 가지 사실 (가산점 포인트)

**① `updatedAt`은 "setter를 호출한 시각"이 아니라 "flush 시각"이다.** 위 타임라인에서 ②와 ⑤ 사이에 외부 API 호출이 3초 걸렸다면 `updatedAt`은 3초 뒤 값이다. 보통은 무의미한 차이지만, **밀리초 단위 순서로 이력을 재구성하는 로직**이라면 이 사실이 필요하다.

**② 변경이 없으면 `@PreUpdate`도 없다.** 값을 같은 값으로 다시 세팅하면 dirty checking이 "안 바뀌었다"고 판정하고 UPDATE 자체가 안 나가므로 `updatedAt`도 그대로다. 반대로 **의도치 않은 dirty 판정**(`BigDecimal` scale 차이, 컬렉션 재할당, 컨버터 왕복 비대칭)이 생기면 **아무도 수정하지 않은 행의 `updatedAt`이 갱신**된다. 그래서 "왜 이 행의 수정 시각이 바뀌었지?"라는 조사는 **Auditing 설정이 아니라 dirty checking 쪽**을 봐야 한다 → [영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md).

---

## 3. 경로별 O/X 표 — "조용히"가 핵심이다

### 3-1. 같은 휴면 전환을 다섯 가지 경로로 써보면

```java
// (A) 변경 감지 — 엔티티를 로드해 필드를 바꾼다
Member m = repo.findById(id).orElseThrow();
m.toDormant();

// (B) save() — 새 엔티티 저장 / 준영속 엔티티 병합
repo.save(new Member("hong@a.com"));

// (C) 벌크 JPQL — 이 문항의 사고 지점
@Modifying
@Query("update Member m set m.status = 'DORMANT' where m.lastLoginAt < :cut")
int toDormantBulk(@Param("cut") LocalDateTime cut);

// (D) 네이티브 쿼리
@Modifying
@Query(value = "update member set status = 'DORMANT' where last_login_at < :cut",
       nativeQuery = true)
int toDormantNative(@Param("cut") LocalDateTime cut);

// (E) JdbcTemplate — JPA 자체를 거치지 않는다
jdbcTemplate.update("update member set status = 'DORMANT' where last_login_at < ?", cut);
```

| 경로 | `@CreatedDate` | `@LastModifiedDate` | `@CreatedBy` / `@LastModifiedBy` | 리스너 호출 여부 |
|---|---|---|---|---|
| (A) 변경 감지 | — (INSERT 아님) | **O** | **O** | `@PreUpdate` |
| (B) `save()` — 신규 | **O** | **O** | **O** | `@PrePersist` |
| (B') `save()` — 병합(merge) | — | **O** | **O** | `@PreUpdate` |
| (C) 벌크 JPQL(`@Modifying`) | ✖ | **✖** | **✖** | **없음** |
| (D) 네이티브 변경 쿼리 | ✖ | **✖** | **✖** | **없음** |
| (E) `JdbcTemplate` / MyBatis | ✖ | **✖** | **✖** | **없음** |
| (F) DB 콘솔 수동 SQL·타 팀 배치 | ✖ | **✖** | **✖** | **없음** |
| (G) `deleteAllInBatch()` 등 벌크 삭제 | — | — | — | **없음**(`@PreRemove`도 안 돔) |

**(C)~(F)를 가르는 기준은 딱 하나다** — **영속성 컨텍스트가 엔티티 객체를 놓고 판정을 내렸는가.** 안 내렸으면 전부 ✖다. 이 기준을 손에 쥐고 있으면 **표에 없는 경로도 즉석에서 판정**할 수 있다. 그게 이 문항이 보려는 능력이다.

### 3-2. 실패가 "조용하다"는 것의 의미

```java
int updated = memberRepository.toDormantBulk(cutoff);
log.info("휴면 전환 완료: {}건", updated);      // → "휴면 전환 완료: 100000건"
```

- 예외? **없다.**
- 경고 로그? **없다.**
- 반환값이 이상한가? **아니다. 정확히 10만이다.**
- SQL 로그를 봐도? **`update member set status='DORMANT' where ...` — 한 문장이 정상 실행됐다.**

**즉 "성공했다"는 모든 신호가 정상이다.** 이 사고는 배포 직후에 발견되지 않는다. **몇 달 뒤 감사 요청이나 CS 조사에서 "이 회원 언제 휴면됐죠?"라는 질문이 들어왔을 때** `updated_at`이 2년 전 로그인 시각을 가리키고 있는 것으로 발견된다. 그때는 **원본 시각을 복구할 방법이 없다.**

> **이 성질이 §9(안전망)의 존재 이유다.** 예외가 나는 사고는 운영에서 잡힌다. **예외가 안 나는 사고는 테스트로 단정해두지 않으면 영원히 안 잡힌다.**

---

## 4. 처방에서 도구를 바꿔 잡는 실수 — `hibernate.jdbc.batch_size`는 무엇을 하는 옵션인가

이 절은 이 문서에서 **가장 중요한 교정**이다. 원인 진단이 정확했는데 처방에서 **"`batch_size` 옵션으로 처리한다"**가 나오는 순간, 면접관은 진단의 신뢰도까지 재검토한다.

### 4-1. `batch_size`가 실제로 하는 일

```
hibernate.jdbc.batch_size = 500
```

이 옵션은 **여러 개의 SQL 문장을 JDBC 드라이버 레벨에서 묶어 한 번에 전송**한다. `PreparedStatement.addBatch()`로 쌓았다가 `executeBatch()`로 한 번에 보내는 것이다.

```
[batch_size 끄면]  INSERT ①  →  네트워크 왕복
                   INSERT ②  →  네트워크 왕복       ... 1000건이면 왕복 1000번
                   ...

[batch_size 켜면]  INSERT ① ~ ⑤⓪⓪ 을 한 묶음  →  네트워크 왕복 1번   ... 1000건이면 왕복 2번
```

**즉 이 옵션이 줄이는 것은 "왕복 횟수"다. 값을 채우는 기능이 아니다.**

### 4-2. 그래서 이 문항에 왜 무관한가

두 가지 이유로 무관하다.

1. **문제의 성격이 다르다.** 우리 문제는 "느리다"가 아니라 **"컬럼이 안 채워진다"**다. `batch_size`는 성능 옵션이지 값 공급 장치가 아니다.
2. **묶을 대상 자체가 없다.** 벌크 UPDATE는 이미 **SQL 한 문장**이다(`update member set ... where last_login_at < ?`). 10만 건을 고치지만 **문장은 하나**다. 묶으라고 해도 묶을 게 없다.

```
batch_size 가 효과를 내는 상황:   save() 를 10만 번 → UPDATE/INSERT 문장 10만 개  → 묶을 대상 있음
이 문항의 상황:                  벌크 UPDATE 1회   → UPDATE 문장 1개              → 묶을 대상 없음
```

**설령 `batch_size`를 1000으로 올려도 `updated_at`은 여전히 옛날 값이다.** 두 문제는 **교집합이 없다.**

### 4-3. 진짜 교훈 — 도구는 "해결하는 것"과 "해결 못 하는 것"을 세트로 외운다

이 오적용은 지식 부족이 아니다. **`batch_size`라는 이름을 최근에 정확히 배웠기 때문에 생긴 일**이다. 새로 배운 도구는 **적용 범위가 함께 고정되지 않으면 인접 문제로 번진다.** 그래서 도구를 익힐 때는 항상 **네 칸짜리 카드**로 외운다.

| 도구 | 해결하는 것 | **해결하지 못하는 것** | 관측 신호 |
|---|---|---|---|
| `hibernate.jdbc.batch_size` | 문장이 **여러 개**일 때 왕복 횟수 | **값 채우기**, 문장이 하나인 벌크 연산, Auditing 누락 | Hibernate `Statistics`의 배치 통계 |
| `@Modifying` | JPQL 변경 쿼리를 실행 경로로 태움 | **1차 캐시 동기화, Auditing, `@Version` 증가** | 반환 `int`(영향 행 수) |
| `AuditingEntityListener` | 컨텍스트를 **거치는** 변경의 시각·주체 기록 | **벌크·네이티브·`JdbcTemplate`·수동 SQL** | 컬럼이 조용히 안 바뀜 |
| Hibernate Envers | 컨텍스트를 **거치는** 변경의 **전체 이력** | **벌크 연산**(§7-2), DB 직접 변경 | `_AUD` 테이블에 리비전 없음 |
| DB `ON UPDATE CURRENT_TIMESTAMP` / 트리거 | **모든 경로**의 시각 기록 | **애플리케이션 주체(누가)**, 벤더 종속 | DDL을 봐야만 존재를 앎 |
| `@Transactional` | 원자성·경계 | **락 경합, 컨텍스트 우회 경로** | — |

> **이 카드 습관이 "도구 이름이 없다"는 약점의 진짜 해법**이다. 이름만 늘리면 오적용도 같이 늘어난다. **"이 도구가 못 하는 것" 칸을 채우는 순간 그 도구는 잘못 집히지 않는다.**

---

## 5. 처방 ① — 벌크를 유지한 채 SET 절에 직접 쓴다

### 5-1. before / after

```java
// ❌ BEFORE — 상태만 바꾼다. 감사 컬럼은 조용히 옛날 값 그대로.
public interface MemberRepository extends JpaRepository<Member, Long> {

    @Modifying
    @Query("""
           update Member m
              set m.status = 'DORMANT'
            where m.status = 'ACTIVE'
              and m.lastLoginAt < :cutoff
           """)
    int toDormantBulk(@Param("cutoff") LocalDateTime cutoff);
}
```

```java
// ✅ AFTER — 리스너가 해주던 일을 SET 절에 손으로 쓴다.
public interface MemberRepository extends JpaRepository<Member, Long> {

    @Modifying(flushAutomatically = true)          // 실행 전 미반영 변경분을 DB 에 반영
    @Query("""
           update Member m
              set m.status    = 'DORMANT',
                  m.updatedAt = :now,             // ← @LastModifiedDate 대신
                  m.updatedBy = :actor            // ← @LastModifiedBy 대신
            where m.status = 'ACTIVE'
              and m.lastLoginAt < :cutoff
           """)
    int toDormantBulk(@Param("cutoff") LocalDateTime cutoff,
                      @Param("now")    LocalDateTime now,
                      @Param("actor")  String actor);
}
```

```java
// 호출부 — 시각은 밖에서 주입한다
@Transactional
public int runDormantBatch() {
    LocalDateTime now = LocalDateTime.now();               // 배치 전체가 같은 시각을 공유
    LocalDateTime cutoff = now.minusYears(1);
    return memberRepository.toDormantBulk(cutoff, now, "BATCH_DORMANT");
}
```

**설계 포인트 세 개.**

1. **시각을 파라미터로 받는다.** JPQL 안에 `current_timestamp`를 써도 되지만, **밖에서 주입하면 ① 배치 전체가 동일 시각으로 찍혀 이력이 한 덩어리로 읽히고 ② 테스트에서 `Clock`을 고정해 단정할 수 있다.** DB 함수를 쓰면 두 가지 다 잃는다.
2. **주체를 상수 문자열로 명시한다.** `'BATCH_DORMANT'`처럼 **사람 계정과 구분되는 이름**을 쓴다. 나중에 "이 시점에 대량으로 바뀐 이유"를 조사할 때 **`updated_by`로 배치 실행 건을 통째로 골라낼 수 있다.** 이게 §6의 `AuditorAware` 함정에 대한 가장 단순하고 확실한 대응이기도 하다.
3. **`@Modifying`의 두 옵션은 이 문항의 처방이 아니다.** `flushAutomatically`/`clearAutomatically`는 **1차 캐시 정합성** 문제를 다루는 옵션이지 감사 컬럼과 무관하다. 다만 벌크를 쓰는 이상 그 문제도 동시에 존재하므로 함께 검토해야 한다 → [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md).

### 5-2. 같이 빠지는 것들도 SET 절에 넣어야 하는지 판단한다

감사 컬럼만 문제가 아니다. **영속성 컨텍스트를 우회하면 컨텍스트가 해주던 일이 전부 빠진다.**

```java
@Modifying
@Query("""
       update Member m
          set m.status    = 'DORMANT',
              m.updatedAt = :now,
              m.updatedBy = :actor,
              m.version   = m.version + 1        // ← 낙관적 락도 자동으로 안 올라간다
        where ...
       """)
```

`@Version`을 쓰고 있다면 **벌크는 버전을 올리지 않으므로 다른 트랜잭션이 이 변경을 감지하지 못한다** → [낙관적 락과 비관적 락](10-optimistic-vs-pessimistic-lock.md). soft delete의 `@SQLDelete`, `cascade`, 2차 캐시 무효화도 같은 이유로 빠진다.

> **하나로 묶으면**: **"JPA를 우회한 변경은 JPA가 모른다."** Auditing 누락은 이 원리의 한 사례일 뿐이고, **원리로 답하면 나머지 사례가 자동으로 딸려 나온다.**

---

## 6. 처방 ② — 엔티티를 로드해 변경 감지로 처리한다 (그리고 그 대가)

### 6-1. 코드

```java
// ✅ 건수가 감당 범위라면 — 리스너가 정상 동작하는 경로로 되돌린다
@Transactional
public int toDormantByDirtyChecking(LocalDateTime cutoff) {
    List<Member> targets = memberRepository.findByStatusAndLastLoginAtBefore(
            MemberStatus.ACTIVE, cutoff);
    targets.forEach(Member::toDormant);      // 필드만 바꾼다 → 커밋 시 @PreUpdate 발생
    return targets.size();
}
```

**얻는 것**: 감사 컬럼·`@Version`·엔티티 리스너·도메인 이벤트가 **전부 정상 동작한다.** 감사 컬럼을 손으로 쓸 필요가 없으니 **"다음에 벌크 쿼리를 하나 더 추가한 사람이 SET 절을 빼먹는" 재발 경로도 사라진다.**

**포기하는 것**: 10만 건이면 이 코드는 쓸 수 없다.

- **UPDATE 문이 10만 개** 나간다(벌크는 1개).
- **엔티티 10만 개 + 스냅샷 10만 벌**이 영속성 컨텍스트에 쌓여 힙이 밀리고, flush마다 비교 대상이 늘어 **뒤로 갈수록 느려진다** → [벌크 INSERT와 JDBC 배치](21-bulk-insert-jdbc-batch.md).
- 트랜잭션이 길어져 **락 점유 시간과 커넥션 점유 시간**이 함께 늘어난다.

### 6-2. 선택 기준

| 조건 | 선택 | 이유 |
|---|---|---|
| 수백~수천 건, 감사 요구 있음 | **변경 감지** | 정합성이 성능보다 비싸다. 손으로 쓸 것이 없다 |
| 수만 건 이상 | **벌크 + SET 절 명시** | 왕복·메모리가 감당 안 된다 |
| 수만 건 이상 **+ 감사 요구가 강함** | **청크 단위 변경 감지**(§6-3) 또는 **벌크 + 이력 테이블 직접 적재**(§7-4) | 둘 중 무엇을 포기할지 정해야 한다 |

### 6-3. 중간 지대 — 청크로 끊어 변경 감지

Spring Batch의 chunk나 수동 페이징으로 **1000건씩 끊어 로드 → 변경 → `flush()` + `clear()`**를 반복하면 메모리 문제 없이 변경 감지 경로를 유지할 수 있다. **왕복 횟수는 여전히 건수만큼**이지만, 여기서는 `hibernate.jdbc.batch_size`가 **드디어 의미를 갖는다** — 이제 UPDATE 문장이 실제로 여러 개이기 때문이다.

> **§4의 오적용을 뒤집어 보는 지점이 여기다.** `batch_size`는 틀린 도구가 아니라 **틀린 자리에 놓였던 도구**다. 문장이 여러 개인 이 설계로 오면 정확히 제 일을 한다. **"도구가 나쁜 게 아니라 문제와 도구의 짝이 틀렸다"**는 것이 §4 교훈의 완성형이다.

---

## 7. 주체(`@LastModifiedBy`) 축 — 시각만 고치면 절반만 답한 것이다

### 7-1. 벌크에서 주체도 똑같이 빠진다

§5의 AFTER 코드에서 `m.updatedBy = :actor`를 이미 넣었다. **시각만 넣고 주체를 빠뜨리는 것이 실무에서 가장 흔한 절반짜리 수정**이다. 그리고 감사 관점에서는 **"언제"보다 "누가"가 더 중요한 경우가 많다** — 개인정보 열람·수정 이력의 핵심 질문은 언제나 **"누가 봤는가/바꿨는가"**다.

### 7-2. 더 고약한 함정 — `AuditorAware`는 배치 스레드에서 `null`이 된다

이건 **벌크 연산과 무관한 별개의 구멍**이다. §1-1의 `AuditorAware` 구현을 다시 본다.

```java
return () -> {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth == null || !auth.isAuthenticated()) {
        return Optional.empty();       // ← 배치 스레드에서는 항상 여기로 온다
    }
    return Optional.of(auth.getName());
};
```

`SecurityContextHolder`는 기본적으로 **`ThreadLocal` 기반**이다. 즉 **HTTP 요청을 처리하는 스레드**에는 인증 정보가 심겨 있지만,

- 스케줄러(`@Scheduled`)가 도는 스레드
- Spring Batch의 워커 스레드
- `@Async`로 분기된 스레드
- 메시지 컨슈머(Kafka 리스너) 스레드
- 애플리케이션 기동 시 데이터 초기화 코드

**이 스레드들에는 SecurityContext가 없다.** 그래서 **변경 감지 경로로 정상 동작하는 배치**여도 `updatedBy`가 조용히 `null`로 채워진다. 즉

> **벌크를 안 쓰더라도, 배치라는 이유만으로 주체 축은 이미 비어 있을 수 있다.**

**처방 세 가지.**

```java
// ① 배치 전용 AuditorAware — 인증이 없으면 시스템 계정으로 폴백한다
@Bean
public AuditorAware<String> auditorProvider() {
    return () -> {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated() || "anonymousUser".equals(auth.getPrincipal())) {
            return Optional.of(SystemActorHolder.current());   // ② 아래
        }
        return Optional.of(auth.getName());
    };
}

// ② 실행 주체를 명시적으로 심는 홀더 — 배치 진입점에서 세팅한다
public final class SystemActorHolder {
    private static final ThreadLocal<String> ACTOR = new ThreadLocal<>();
    public static void set(String actor) { ACTOR.set(actor); }
    public static void clear()           { ACTOR.remove(); }
    public static String current()       { return ACTOR.get() != null ? ACTOR.get() : "SYSTEM"; }
}

@Scheduled(cron = "0 0 4 * * *")
public void dormantJob() {
    SystemActorHolder.set("BATCH_DORMANT");
    try {
        dormantService.run();
    } finally {
        SystemActorHolder.clear();      // ← 스레드 풀 재사용을 고려하면 필수
    }
}
```

**③ `Optional.empty()`를 반환하지 않는 것 자체가 설계 결정이다.** 비어 있는 감사 필드보다 **`"SYSTEM"`이라는 명시적 값**이 낫다. `null`은 "기록에 실패했다"와 "시스템이 바꿨다"를 구분하지 못하지만, `"SYSTEM"`/`"BATCH_DORMANT"`는 **조사 가능한 정보**다.

> **(가산점 포인트)** `@Async`로 분기한 스레드에 인증 정보를 넘기고 싶다면 `SecurityContextHolder`의 전략을 `MODE_INHERITABLETHREADLOCAL`로 바꾸거나, Spring Security가 제공하는 **`DelegatingSecurityContextExecutor` 계열 래퍼**로 실행기를 감싼다. 다만 **스레드 풀에서는 컨텍스트가 다음 작업으로 새는 위험**이 따라오므로, **배치에는 상속보다 위 ②의 명시적 주입이 안전하다.** "얻는 것(편의)과 포기하는 것(누수 위험)"을 같이 말하는 자리다.

---

## 8. 감사 요구가 걸린 데이터 — 애플리케이션 레벨 Auditing의 신뢰 경계

### 8-1. 무엇을 얻고 무엇을 포기했는가

`@EntityListeners` 한 줄로 전 엔티티에 감사 컬럼을 배포한 이 방식은 **공짜가 아니다.**

| | 애플리케이션 레벨 Auditing |
|---|---|
| **얻는 것** | ① `BaseEntity` 한 줄로 **전 엔티티 일괄 적용** ② **DB 독립**(벤더 바뀌어도 그대로) ③ 애플리케이션의 인증 정보를 그대로 주체로 사용 ④ 테스트에서 `Clock`으로 고정 가능 |
| **포기하는 것** | ① **신뢰 경계가 애플리케이션 안쪽** — 벌크·네이티브·`JdbcTemplate`·타 시스템·운영자 수동 SQL은 못 잡는다 ② **덮어쓰기식**이라 "언제 무엇이 무엇으로 바뀌었는지"의 **이력이 남지 않는다**(마지막 상태만) ③ 실패가 **조용하다** |

**②를 놓치기 쉽다.** `@LastModifiedDate`는 **가장 최근 수정 시각 하나**만 갖는다. "3월 12일에 등급이 GOLD에서 SILVER로 바뀌었다"는 **변경 이력**은 어디에도 없다. **감사 요구는 대부분 이력을 요구하므로, `updated_at` 컬럼 하나로는 애초에 요건을 만족하지 못한다.** 이 구분을 말할 수 있으면 "감사"라는 단어를 실제로 다뤄본 사람으로 읽힌다.

### 8-2. 한 층 내리기 ① — Hibernate Envers (그리고 Envers도 벌크에서 빠진다)

```java
@Entity
@Audited                       // ← 이 엔티티의 변경을 리비전 테이블에 남긴다
public class Member extends BaseEntity { ... }
```

Envers는 `member_AUD` 같은 **이력 테이블**과 리비전 메타 테이블을 만들고, 변경이 일어날 때마다 **그 시점의 스냅샷을 한 행씩 적재**한다. `AuditReader`로 "3월 12일 시점의 이 회원"을 그대로 복원할 수 있다. §8-1의 **포기하는 것 ②를 정확히 메운다.**

**그런데 여기서 반드시 덧붙여야 할 사실이 있다.**

> **Envers도 하이버네이트의 엔티티 이벤트(post-insert / post-update / post-delete) 리스너로 동작한다. 그래서 벌크 JPQL·네이티브 쿼리에서는 `AuditingEntityListener`와 똑같이 빠진다.**

```java
@Modifying
@Query("update Member m set m.status = 'DORMANT' where ...")
int toDormantBulk(...);
// → member 테이블은 바뀐다
// → member_AUD 에는 리비전이 단 한 건도 안 생긴다. 예외도 경고도 없다.
```

**"Envers 쓰면 됩니다"로 끝내면 이 지점에서 걸린다.** Envers는 **기록의 형태**(덮어쓰기 → 이력)를 바꿔주지만 **기록의 신뢰 경계**(= 영속성 컨텍스트를 거치는 변경만)는 **전혀 바꾸지 못한다.** 두 문제를 구분하는 것이 이 절의 요지다.

### 8-3. 한 층 내리기 ② — DB로 내린다

경계를 진짜로 넓히려면 **애플리케이션 밖으로** 나가야 한다.

**(가) 컬럼 기본값 / `ON UPDATE`** — MySQL이라면 DDL 한 줄로 시각 축을 **모든 경로에 적용**할 수 있다.

```sql
ALTER TABLE member
  MODIFY updated_at TIMESTAMP NOT NULL
         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
```

이러면 **벌크든 네이티브든 `JdbcTemplate`이든 DB 콘솔이든** UPDATE가 나가는 순간 시각이 찍힌다. **다만 세 가지를 포기한다.**

- **"누가"는 여전히 모른다.** DB는 애플리케이션 사용자를 모른다.
- **벤더 종속**이다. PostgreSQL에는 이 문법이 없어 트리거가 필요하다.
- **JPA가 채운 값과 DB가 채운 값이 경합**할 수 있다. 엔티티에 매핑된 채로 두면 하이버네이트가 자기 값을 써버리므로, DB에 맡길 컬럼은 `@Column(insertable = false, updatable = false)`이나 `@Generated` 계열로 **소유권을 명시**해야 한다. **소유권을 정하지 않은 이중 관리가 가장 나쁘다.**
- 그리고 MySQL의 `ON UPDATE`는 **실제로 값이 달라진 UPDATE에서만** 갱신된다 — 같은 값으로 덮는 UPDATE에는 반응하지 않는다.

**(나) 트리거 + 이력 테이블** — "누가"까지 필요하고 경계도 넓혀야 한다면 트리거로 `member_history`에 행을 남긴다. **모든 경로를 잡는 유일한 방법**이지만 대가가 크다.

- 애플리케이션 세션 사용자를 트리거에 전달할 방법을 따로 만들어야 한다(세션 변수 등) — **그 전달 코드를 안 타는 경로에서는 다시 비어버린다.**
- **삭제 파급과 마찬가지로 로직이 DDL에만 있어 코드 리뷰로 발견되지 않는다.**
- 스키마 마이그레이션·테스트 환경 구성이 무거워진다.

### 8-4. 실무 규칙 두 갈래 — 여기가 이 문항의 설계 답이다

경계를 완벽히 넓히는 것이 항상 가능하진 않다. 그래서 실무는 **둘 중 하나(또는 둘 다)를 택한다.**

**① 감사 대상 엔티티에는 벌크 연산을 금지한다.** 성능이 아니라 **정합성을 우선순위로 못 박는 규칙**이다. 사람의 주의력이 아니라 **도구로 고정**한다(§9-3의 ArchUnit 룰). 감사 대상 엔티티를 `@Audited`나 전용 마커 애노테이션으로 표시해두면 룰이 대상을 식별할 수 있다.

**② 벌크가 불가피하면 이력 적재 경로를 함께 만든다.** 벌크 UPDATE와 **같은 트랜잭션 안에서** 이력 테이블에 `insert into member_history select ...` 형태로 한 문장을 더 넣는다.

```java
@Transactional
public int runDormantBatch(LocalDateTime now) {
    // ① 바꾸기 전 상태를 이력 테이블에 통째로 적재 (한 문장)
    int archived = historyRepository.archiveDormantTargets(cutoff, now, "BATCH_DORMANT");
    // ② 벌크 UPDATE (감사 컬럼 포함)
    int updated  = memberRepository.toDormantBulk(cutoff, now, "BATCH_DORMANT");
    if (archived != updated) {
        throw new IllegalStateException("이력 건수 불일치: " + archived + " vs " + updated);
    }
    return updated;
}
```

**건수 일치 단정을 넣은 것이 이 코드의 핵심**이다. 두 문장이 **서로를 검증**하게 만들면, 조건이 어긋나 이력이 누락되는 순간 **조용한 실패가 시끄러운 실패로 승격**된다. §3-2에서 본 이 문항의 본질적 위험 — "조용하다" — 에 대한 직접적인 대응이다.

---

## 9. 안전망을 코드로 고정하기 — "테스트로 막는다"의 구체적 형태

이 사고는 **예외가 나지 않는다.** 그러므로 막는 방법은 하나뿐이다 — **단정(assertion)으로 고정하는 것.** 다만 "테스트를 쓴다"는 방향만으로는 부족하고, **무엇을 어떻게 단정하느냐**에서 갈린다.

### 9-1. 먼저 함정 — 같은 트랜잭션에서 검증하면 오염된다

```java
// ❌ 이 테스트는 벌크 UPDATE 의 결과를 제대로 보지 못한다
@Test
@Transactional
void 벌크_휴면전환_후_수정시각이_갱신된다() {
    Member m = memberRepository.save(new Member("hong@a.com", oldLogin));
    LocalDateTime before = m.getUpdatedAt();

    memberRepository.toDormantBulk(cutoff, now, "BATCH_DORMANT");

    Member found = memberRepository.findById(m.getId()).orElseThrow();
    assertThat(found.getUpdatedAt()).isAfter(before);      // ← 1차 캐시의 옛 객체를 본다
}
```

**벌크 연산은 DB만 바꾸고 1차 캐시는 그대로 두므로**, 같은 트랜잭션의 `findById`는 **SELECT조차 나가지 않고 메모리의 옛 객체를 반환**한다. 이 테스트는 **버그가 없어도 실패하고, 있어도 실패**해서 아무것도 증명하지 못한다 → [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md).

### 9-2. 처방 — 컨텍스트를 비우고 다시 읽는다

```java
// ✅ 검증은 반드시 새 컨텍스트에서
@Test
@Transactional
void 벌크_휴면전환은_수정시각과_주체를_남긴다() {
    LocalDateTime now = LocalDateTime.of(2026, 3, 12, 4, 0);
    Member m = memberRepository.save(new Member("hong@a.com", now.minusYears(2)));
    LocalDateTime beforeUpdatedAt = m.getUpdatedAt();
    em.flush();
    em.clear();                                           // ★ 1차 캐시를 비운다

    int updated = memberRepository.toDormantBulk(now.minusYears(1), now, "BATCH_DORMANT");
    em.clear();                                           // ★ 벌크 이후에도 다시 비운다

    assertThat(updated).isEqualTo(1);
    Member found = memberRepository.findById(m.getId()).orElseThrow();
    assertThat(found.getStatus()).isEqualTo(MemberStatus.DORMANT);
    assertThat(found.getUpdatedAt()).isEqualTo(now);                   // ← 시각 축
    assertThat(found.getUpdatedAt()).isNotEqualTo(beforeUpdatedAt);
    assertThat(found.getUpdatedBy()).isEqualTo("BATCH_DORMANT");       // ← 주체 축
}
```

**두 축을 모두 단정한 것이 핵심**이다. 시각만 단정하는 테스트는 §7의 절반짜리 수정을 그대로 통과시킨다.

**시각을 `Clock`으로 고정하면** `isAfter` 같은 느슨한 단정 대신 **정확한 등치 비교**가 가능해진다. `LocalDateTime.now()`를 코드 안에서 직접 부르지 않고 `Clock` 빈을 주입받는 설계로 바꾸면, 테스트에서 `Clock.fixed(...)`로 못 박을 수 있다.

### 9-3. 회귀를 막는 세 겹

테스트 하나는 **그 쿼리 하나만** 지킨다. **다음 사람이 벌크 쿼리를 하나 더 추가하면 다시 뚫린다.** 그래서 세 겹으로 간다.

**① 스키마로 막기 — 다만 한계를 정확히 알고 쓴다.**

```sql
ALTER TABLE member
  MODIFY created_at TIMESTAMP NOT NULL,
  MODIFY created_by VARCHAR(50) NOT NULL;
```

`NOT NULL`은 **INSERT 경로의 누락을 즉시 실패로 만든다.** `JdbcTemplate`으로 감사 컬럼 없이 INSERT를 시도하면 그 자리에서 터진다 — **조용한 실패가 시끄러운 실패가 된다.** 다만 **UPDATE 누락은 못 잡는다.** 옛날 값이 그대로 남아 있을 뿐 `NULL`이 아니기 때문이다. **이것도 §4의 도구 카드와 같은 성질이다 — 이 제약이 무엇을 못 하는지 알고 써야 한다.**

**② 구조 룰로 막기 — 감사 대상 엔티티에 벌크 금지.**

```java
@AnalyzeClasses(packages = "com.example")
class AuditingRuleTest {

    @ArchTest
    static final ArchRule 감사대상_엔티티에는_벌크_변경쿼리를_쓰지_않는다 =
        methods().that().areAnnotatedWith(Modifying.class)
                 .should(new ArchCondition<>("감사 대상 엔티티를 건드리지 않는다") {
                     @Override
                     public void check(JavaMethod method, ConditionEvents events) {
                         String jpql = method.getAnnotationOfType(Query.class).value();
                         for (String audited : AUDITED_ENTITY_NAMES) {   // @Audited 스캔 결과
                             if (jpql.contains(audited) && !jpql.contains("updatedBy")) {
                                 events.add(SimpleConditionEvent.violated(method,
                                     audited + " 는 감사 대상입니다. "
                                     + "벌크 대신 변경 감지를 쓰거나 SET 절에 감사 필드를 명시하세요: "
                                     + method.getFullName()));
                             }
                         }
                     }
                 });
}
```

**완벽한 정적 검사는 아니다**(문자열 매칭이고, 네이티브 쿼리·`JdbcTemplate`은 별도 룰이 필요하다). 그래도 **"리뷰어의 기억"보다는 훨씬 낫다.** 규칙을 문서가 아니라 **빌드가 강제**하게 만드는 것이 요점이다.

**③ 관측으로 막기 — 실제 SQL을 본다.** `p6spy`/`datasource-proxy`로 바인딩 값까지 찍어두면, 벌크 UPDATE의 SET 절에 감사 컬럼이 들어갔는지 **로그로 눈으로 확인**할 수 있다. 그리고 통합 테스트는 **H2가 아니라 Testcontainers**로 실제 DB에서 돌린다 — `ON UPDATE CURRENT_TIMESTAMP`나 트리거를 쓰기로 했다면 **벤더 동작이 곧 정답의 일부**이기 때문이다.

---

## 10. 증상 → 원인 역방향 인덱스

원리에서 증상을 유도하는 건 원리를 알면 누구나 한다. 실무에서 필요한 건 **증상에서 원인으로 거슬러 올라가는 것**이다.

| 증상 | 원인 | 확인 방법 | 처방 |
|---|---|---|---|
| **특정 배치가 건드린 행만** `updated_at`이 옛날 값 | 벌크/네이티브가 리스너 경로 우회 (§2·§3) | 그 배치의 쿼리에 `@Modifying`이 붙어 있음 | SET 절에 `updatedAt`·`updatedBy` 명시 (§5) |
| 감사 컬럼이 **전부** `null` | `@EnableJpaAuditing` 누락 (§1-1) | 어떤 경로로 저장해도 비어 있음 | 설정 클래스에 애노테이션 추가 |
| `updated_at`은 찍히는데 `updated_by`만 `null` | `AuditorAware` 미등록 또는 **배치 스레드에 SecurityContext 없음** (§7-2) | 웹 요청 경로에서는 채워짐 | 시스템 계정 폴백 (§7-2) |
| 아무도 수정 안 한 행의 `updated_at`이 바뀜 | **의도치 않은 dirty 판정** (§2-3) | 커밋 시 예상 못한 UPDATE 로그 | 컨버터·`BigDecimal` scale·컬렉션 재할당 점검 |
| `member`는 바뀌었는데 `member_AUD`에 리비전 없음 | **Envers도 벌크에서 빠짐** (§8-2) | 벌크로 바꾼 행만 이력 없음 | 벌크 금지 또는 이력 직접 적재 (§8-4) |
| 특정 엔티티만 감사 컬럼이 안 채워짐 | 그 엔티티가 `BaseEntity`를 상속하지 않음 | 클래스 선언 확인 | 상속 또는 `@EntityListeners` 직접 부착 |
| DB 콘솔로 고친 행에 이력이 없음 | 애플리케이션 레벨 Auditing의 **신뢰 경계 밖** (§8-1) | 애플리케이션 로그에 해당 변경 없음 | DB 트리거 / 운영 SQL 통제 절차 |

**세 개의 대표 트리거만 외워도 대부분 잡힌다.**

```
"배치가 건드린 행만 수정시각이 옛날"     → 벌크가 리스너 경로를 우회했다
"updated_by 만 null"                    → 배치 스레드에 SecurityContext 가 없다
"이력 테이블에 리비전이 안 생겼다"       → Envers 도 같은 경로를 탄다
```

---

## 11. 꼬리질문 대비 포인트

### "리스너는 정확히 언제 호출되나요? `save()`를 부른 시점인가요?"

**아니다. flush 시점이다.** `@PrePersist`/`@PreUpdate`는 **하이버네이트가 실제로 INSERT/UPDATE 문을 만들기 직전**에 호출된다. `save()`를 부른 시각과 flush 시각 사이에 외부 API 호출이 3초 걸렸다면 `createdAt`은 3초 뒤 값이다.

**그래서 두 가지가 따라온다.** ① **변경이 없으면 UPDATE 자체가 안 나가므로 `@PreUpdate`도 없다** — 같은 값으로 다시 세팅하는 건 감사 이력을 남기지 않는다. ② 반대로 **의도치 않은 dirty 판정이 생기면 아무도 수정하지 않은 행의 `updatedAt`이 갱신**된다. "이 행이 왜 어제 수정된 걸로 나오죠?"라는 조사는 **Auditing이 아니라 dirty checking 쪽**을 봐야 한다.

### "그럼 벌크 연산은 아예 쓰면 안 되나요?"

**아니다. 판단 기준은 "이 엔티티에 감사 요구가 걸려 있는가"다.**

- **감사 요구가 없는 데이터**(집계 캐시 컬럼, 조회수, 임시 플래그) — 벌크가 정답이다. 10만 건을 굳이 로드할 이유가 없다.
- **감사 요구가 있는 데이터**(회원 상태, 권한, 개인정보, 금액) — **벌크를 쓰되 SET 절에 감사 필드를 명시**하거나, 건수가 감당되면 **변경 감지 경로로 되돌린다.**
- **감사 요구가 강하고 건수도 큰 경우** — **벌크 + 이력 테이블 직접 적재를 같은 트랜잭션에** 묶고, **건수 일치를 단정**해서 누락이 즉시 실패가 되게 만든다.

**핵심은 벌크의 금지가 아니라 "벌크를 쓰는 순간 컨텍스트가 해주던 일 목록을 손으로 인수인계받는다"는 인식**이다. 감사 컬럼, `@Version`, `cascade`, `@SQLDelete`, 2차 캐시 무효화가 그 목록이다.

### "감사 요구가 있는 데이터라면 애플리케이션 레벨 Auditing으로 충분한가요?" (시니어 변별 포인트)

**충분하지 않다. 두 가지가 부족하다.**

**① 신뢰 경계가 애플리케이션 안쪽이다.** 벌크·네이티브·`JdbcTemplate`·타 팀 배치·운영자의 수동 SQL은 잡지 못한다. **"우리 코드가 정상 경로로 바꾼 것만" 기록**된다. 감사는 보통 **"어떤 경로로든 이 데이터가 바뀌면"**을 요구한다.

**② 이력이 아니라 마지막 상태만 남는다.** `@LastModifiedDate`는 최근 수정 시각 하나뿐이라 "3월 12일에 GOLD → SILVER"라는 **변경 내역**이 없다. 감사 요건은 대부분 내역을 요구하므로 **애초에 요건을 만족하지 못한다.**

**그래서 층을 나눠 답한다.** 이력 형태가 필요하면 **Envers**(`@Audited` → 리비전 테이블), 경계까지 넓혀야 하면 **DB 트리거 + 이력 테이블**. **그리고 반드시 덧붙일 것 — Envers도 벌크 연산에서는 똑같이 빠진다.** Envers는 **기록의 형태**를 바꾸지만 **기록의 경계**는 전혀 바꾸지 않는다. 이 구분을 말하는 것이 이 질문의 변별점이다.

### "`@LastModifiedBy`가 배치에서만 `null`입니다. 왜죠?" (시니어 변별 포인트)

**`AuditorAware`가 `SecurityContextHolder`에서 사용자를 꺼내는데, 그것은 `ThreadLocal` 기반이라 배치·스케줄러·`@Async`·메시지 컨슈머 스레드에는 인증 정보가 없기 때문이다.** 벌크 여부와 무관한 **별개의 구멍**이며, **변경 감지 경로로 정상 동작하는 배치에서도 발생**한다.

**처방**: ① `AuditorAware`에 **시스템 계정 폴백**을 넣어 `Optional.empty()` 대신 `"SYSTEM"`·`"BATCH_DORMANT"` 같은 **조사 가능한 값**을 반환한다 — `null`은 "기록 실패"와 "시스템 변경"을 구분하지 못한다. ② 배치 진입점에서 **실행 주체를 `ThreadLocal`에 명시적으로 심고 `finally`에서 지운다**(스레드 풀 재사용 때문에 정리가 필수). ③ 웹 요청에서 분기한 비동기 작업에 인증을 전달해야 한다면 `DelegatingSecurityContext...` 계열 래퍼를 쓰되, **스레드 풀에서 컨텍스트가 다음 작업으로 새는 위험**을 함께 인지한다.

### "`hibernate.jdbc.batch_size`를 올리면 이 문제가 해결되나요?"

**아니다. 문제의 종류가 다르다.** `batch_size`는 **여러 개의 SQL 문장을 JDBC 레벨에서 묶어 전송해 왕복 횟수를 줄이는 성능 옵션**이지 값을 채우는 기능이 아니다. 게다가 **이 벌크 UPDATE는 이미 한 문장**이라 묶을 대상 자체가 없다. 값이 채워지지 않는 원인은 **리스너 경로를 안 탄 것**이므로, 처방은 **SET 절에 직접 쓰거나 변경 감지 경로로 되돌리는 것** 둘 중 하나다.

**다만 `batch_size`가 의미를 갖는 지점이 하나 있다** — 감사 컬럼 때문에 **벌크를 포기하고 청크 단위 변경 감지**로 바꾸면, 그때는 UPDATE 문장이 실제로 여러 개가 되므로 이 옵션이 제 일을 한다. **틀린 도구가 아니라 틀린 자리에 놓였던 도구**다.

### "이 사고를 배포 전에 잡으려면 어떻게 하나요?" (가산점 포인트)

**예외가 안 나는 사고이므로 단정으로 고정하는 수밖에 없다. 세 겹으로 간다.**

1. **테스트로 단정** — `@Modifying` 쿼리를 실행한 뒤 **`em.clear()`로 1차 캐시를 비우고** 재조회해 `updatedAt`과 `updatedBy`를 **둘 다** 검증한다. 비우지 않으면 벌크가 우회한 옛 객체를 보게 되어 **테스트가 아무것도 증명하지 못한다.** 시각은 `Clock.fixed`로 고정해 등치 비교한다.
2. **스키마로 승격** — 감사 컬럼을 `NOT NULL`로 두면 **INSERT 누락이 즉시 실패**한다. 단 **UPDATE 누락은 못 잡는다**(옛 값이 남을 뿐 `NULL`이 아니므로). 도구의 한계를 알고 쓴다.
3. **구조 룰로 회귀 차단** — ArchUnit으로 **`@Modifying`이 붙은 메서드가 감사 대상 엔티티를 건드리는지** 검사한다. 테스트 하나는 그 쿼리 하나만 지키지만, 룰은 **다음에 추가될 쿼리까지** 지킨다.

여기에 **p6spy로 실제 SQL을 관측**하고 **Testcontainers로 실제 DB에서** 돌리면(트리거나 `ON UPDATE`를 쓰기로 했다면 벤더 동작이 곧 정답의 일부다) 완성된다.

### "네이티브 쿼리나 `JdbcTemplate`도 같은 문제가 있나요? 판단 기준을 하나로 말한다면?" (가산점 포인트)

**있다. 그리고 기준은 하나다** — **"영속성 컨텍스트가 이 엔티티를 놓고 INSERT/UPDATE를 판정했는가."** 판정이 있으면 리스너가 호출되고, 없으면 안 된다. 벌크 JPQL·네이티브 쿼리·`JdbcTemplate`·MyBatis·DB 콘솔은 전부 판정이 없다.

**같은 이유로 함께 빠지는 것들**: `@Version` 증가, `cascade`/`orphanRemoval`, soft delete의 `@SQLDelete`, `@PreRemove` 같은 다른 생명주기 콜백, 2차 캐시 무효화, Envers 리비전. **한 문장으로 묶으면 "JPA를 우회한 변경은 JPA가 모른다."** 이렇게 답하면 지식이 조각이 아니라 원리로 들린다 → [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md), [Soft delete와 유니크 제약](26-soft-delete-unique-and-associations.md).

**그리고 여기서 반대 방향의 도구도 하나 알고 있으면 좋다** — **DB의 `ON UPDATE CURRENT_TIMESTAMP`나 트리거는 정확히 이 경계를 넘는 유일한 수단**이다. 대신 **"누가"는 못 채우고, 벤더에 묶이며, 로직이 DDL에만 있어 코드 리뷰에 안 보인다.** 얻는 것과 포기하는 것이 정확히 반대인 도구다.

---

## 한 줄 요약

**JPA Auditing은 마법이 아니라 `@PrePersist`/`@PreUpdate` 콜백에 얹힌 코드이고, 그 콜백은 "영속성 컨텍스트가 이 엔티티를 INSERT/UPDATE 대상으로 판정한 순간"에만 발생한다** — 그래서 판정을 거치지 않는 **벌크 JPQL·네이티브 쿼리·`JdbcTemplate`·수동 SQL에서는 예외도 경고도 없이 조용히 빠진다**(§2·§3). 처방은 **벌크를 유지하면 SET 절에 `m.updatedAt = :now, m.updatedBy = :actor`를 직접 쓰고**(시각은 밖에서 주입해 배치 전체가 같은 값을 공유하게, 주체는 `'BATCH_DORMANT'`처럼 사람 계정과 구분되게), **건수가 감당되면 엔티티를 로드해 변경 감지로 되돌리는 것**(대가: 왕복 N번 + 컨텍스트 누적)이다(§5·§6). 여기서 **`hibernate.jdbc.batch_size`는 이 문제와 교집합이 없다** — **문장이 여러 개일 때 왕복을 줄이는 옵션**이지 값을 채우지 않으며 **이 벌크는 이미 한 문장**이다. 다만 **청크 단위 변경 감지로 설계를 바꾸면 그때는 제 일을 한다** — 틀린 도구가 아니라 **틀린 자리에 놓였던 도구**이고, 그래서 **모든 도구는 "해결하는 것"과 "해결하지 못하는 것"을 세트로 외워야 한다**(§4). 시각만 고치면 절반이다 — **`@LastModifiedBy`도 같이 빠지고**, 게다가 `AuditorAware`는 `SecurityContextHolder`(ThreadLocal)에 의존하므로 **배치·스케줄러·`@Async` 스레드에서는 벌크가 아니어도 이미 `null`**이라 **시스템 계정 폴백을 명시적으로 넣어야 한다**(§7). 마지막으로 **애플리케이션 레벨 Auditing은 신뢰 경계가 애플리케이션 안쪽이고 마지막 상태만 남긴다** — 이력이 필요하면 **Envers**, 경계를 넘으려면 **DB 트리거/`ON UPDATE CURRENT_TIMESTAMP`**(대신 "누가"를 잃고 벤더에 묶인다)로 내리되, **Envers도 벌크에서는 똑같이 빠진다**는 것을 반드시 함께 말해야 한다 — Envers가 바꾸는 것은 **기록의 형태**이지 **기록의 경계**가 아니다(§8). 그래서 실무 규칙은 **감사 대상 엔티티에 벌크 금지**(ArchUnit 룰)이거나 **벌크와 이력 적재를 한 트랜잭션에 묶고 건수 일치를 단정**하는 것이며, 이 모든 규칙은 **`em.clear()` 이후 재조회해 시각과 주체를 둘 다 단정하는 테스트**로 고정하기 전까지는 **다음 사람이 벌크 쿼리를 하나 더 추가하는 순간 조용히 무너진다.**
