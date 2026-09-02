# JPA Auditing과 벌크 연산의 구멍 — "자동으로 채워진다"의 자동은 어느 경로에서만 참인가

> 핵심 관전 포인트: **JPA Auditing은 마법이 아니라 `@PrePersist`/`@PreUpdate`라는 엔티티 생명주기 콜백에 얹힌 코드다.** `AuditingEntityListener`는 **영속성 컨텍스트가 "이 엔티티를 지금 INSERT/UPDATE 하겠다"고 결정하는 순간에만** 호출되므로, **그 결정을 거치지 않는 경로 — 벌크 JPQL(`@Modifying`), 네이티브 쿼리, `JdbcTemplate`, DB 콘솔의 수동 SQL — 에서는 값이 전부 빠진다.** 그리고 이 누락의 성질이 핵심이다. **예외도, 경고 로그도, 실패 카운트도 없다. 조용히 빠진다.** 10만 건의 `updated_at`이 옛날 값 그대로여도 배치는 "성공"으로 끝난다. 처방은 **벌크를 유지한다면 SET 절에 감사 필드를 직접 쓰는 것**(`set m.status = 'DORMANT', m.updatedAt = :now, m.updatedBy = 'BATCH_DORMANT'`)이고, 건수가 감당 범위면 **엔티티를 로드해 변경 감지로 처리하는 것**(대가: 왕복 N번 + 영속성 컨텍스트 누적)이다. 여기서 **시각만 생각하면 절반만 답한 것**이다 — **`@LastModifiedBy`(주체)도 같이 빠지고**, 게다가 `AuditorAware`는 보통 SecurityContext에서 사용자를 꺼내는데 **배치 스레드에는 그것이 없어 평소 경로에서도 주체가 안 채워지는** 별개의 함정이 따라온다. 마지막으로 **감사(監査) 요구가 걸린 데이터라면 애플리케이션 레벨 Auditing은 신뢰 경계가 애플리케이션 안쪽이라는 점을 인정해야 한다** — Hibernate Envers나 DB 트리거로 내리되, **Envers도 벌크 연산에서는 똑같이 빠진다.** 그래서 실무 규칙은 **감사 대상 엔티티에 벌크 연산 금지**(ArchUnit 룰/리뷰 규칙) 또는 **이력 테이블에 직접 남기는 경로를 함께 만드는 것**이고, 이 규칙은 **테스트로 단정하기 전까지 언젠가 지워질 주장일 뿐이다.**

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
- **처방에서 도구를 바꿔 잡는 것.** "배치 사이즈 옵션으로 처리한다" 같은 답이 여기서 나온다. **`hibernate.jdbc.batch_size`는 값을 채우는 기능이 아니다**(2-1). 원인 진단이 맞아도 처방에서 엉뚱한 도구를 집으면 그 자리에서 "도구의 적용 범위를 모르는 사람"이 된다.
- **시각만 답하고 주체를 빠뜨리는 것.** `updatedAt`만 고쳐놓고 `updatedBy`는 여전히 옛 값인 배치가 실무에 흔하다(3-1).
- **"Envers 쓰면 됩니다"로 끝내는 것.** **Envers도 같은 이유로 벌크에서 빠진다**(3-7). 도구 이름을 대는 것과 **그 도구가 못 막는 것을 아는 것**은 다른 능력이다.

> **이 문항에서 이미 도달해 있는 지점**(면접 기록 기준): 메커니즘은 **경험 없이 추론만으로 정확히 맞혔다** — "`@EntityListeners`는 영속성 컨텍스트에 있는 엔티티만 대상이니 벌크는 그 경로를 안 타서 빠진다." 벌크를 유지한 채 남기는 법도 정확했다("업데이트 문에 추가한다"). 그리고 설계·규율 질문에 **유도 없이 "테스트 코드로 막는다"**는 안전망 답변이 나왔다. 그러니 이 문서가 채울 것은 원인 진단이 아니라 **① 처방에서 집을 도구의 정확한 이름과 적용 범위 ② 주체(`@LastModifiedBy`) 축 ③ 감사 요구가 걸린 데이터의 설계 층 ④ "테스트로 막는다"의 구체적 형태**, 이 네 가지다.

---

## 1. 어떻게 동작하고 어디서 빠지는가

이 장은 이 문서의 뼈대다. 여기서 세우는 인과 한 줄 — **"콜백은 영속성 컨텍스트의 판정 결과로 호출된다"** — 이 나머지 두 장의 모든 처방과 판단 기준을 낳는다.

### 1-1. 최소 동작 코드 — 무엇을 켜야 동작하는가

원인을 이야기하기 전에 **전체 부품을 한 화면에 올려둔다.** 이 문항의 답은 결국 "이 부품들 중 무엇이 언제 호출되는가"로 환원되기 때문이다.

```java
// ① 기능 활성화 — 이게 없으면 애노테이션이 있어도 아무 일도 일어나지 않는다
@Configuration
@EnableJpaAuditing                       // AuditorAware 빈이 하나뿐이면 타입으로 자동 주입된다.
public class JpaAuditingConfig {         // 둘 이상일 때만 auditorAwareRef = "auditorProvider" 로 지목한다.

    // ③ 주체(누가 바꿨는가)를 공급하는 부품
    @Bean
    public AuditorAware<String> auditorProvider() {
        return () -> {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth == null || !auth.isAuthenticated()) {
                return Optional.empty();          // 3-2 의 함정이 여기서 시작된다
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
@EntityListeners(AuditingEntityListener.class)      // 콜백을 등록하는 것은 정확히 이 한 줄이다
public abstract class BaseEntity {

    @CreatedDate
    @Column(updatable = false)                      // 생성 시각은 이후 UPDATE 문에서 제외한다
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

    public void toDormant() {          // 도메인 메서드 — 필드만 바꾼다. 이 경로가 변경 감지 경로다.
        this.status = MemberStatus.DORMANT;
    }
}
```

**부품별 역할을 한 줄씩 고정한다.**

| 부품 | 하는 일 | 없으면 |
|---|---|---|
| `@EnableJpaAuditing` | 리스너가 쓸 인프라(`AuditingHandler`, 시각 공급자, `AuditorAware`)를 컨텍스트에 등록 | 애노테이션이 **조용히 무시**된다 — 필드가 계속 `null` |
| `@EntityListeners(AuditingEntityListener.class)` | 그 엔티티에 **생명주기 콜백을 붙인다** | 그 엔티티만 Auditing 미적용 |
| `@MappedSuperclass BaseEntity` | 컬럼·애노테이션을 상속으로 배포 | 엔티티마다 네 필드를 복붙 |
| `AuditorAware<T>` | **주체**를 공급 | `@CreatedBy`/`@LastModifiedBy`가 안 채워짐 (3-3) |

**`@EnableJpaAuditing`이 없을 때 왜 조용한지**는 리스너 구현을 보면 바로 나온다. `AuditingEntityListener`는 `AuditingHandler`를 필드로 들고 있는데, 이 필드가 `null`이면 아무 일도 하지 않고 그냥 리턴한다.

```java
// spring-data-jpa: AuditingEntityListener 의 실제 구조 (요지)
@PrePersist
public void touchForCreate(Object target) {
    if (handler != null) {                     // 핸들러가 없으면 여기서 조용히 끝난다
        handler.getObject().markCreated(target);
    }
}
```

> **첫 번째 실수 유형이 여기 있다**: `@EnableJpaAuditing`을 빼먹으면 **컴파일도 되고 실행도 되고 예외도 없다.** 그냥 컬럼이 계속 비어 있을 뿐이다. **이 문항의 모든 실패 모드가 공유하는 성질** — 조용하다 — 이 설정 단계에서부터 시작된다.

### 1-2. `@MappedSuperclass`에 붙였는데 왜 자식에 적용되나

`@EntityListeners`는 **상속된다.** `BaseEntity`에 한 번 붙이면 `Member`, `Order`, `Payment` 전부에 콜백이 등록된다.

"코드 한 줄로 전 엔티티에 감사 컬럼을 배포"라는 이 편의성이 애플리케이션 레벨 Auditing의 **최대 장점**이자, 3-5에서 볼 **최대 약점의 뿌리**이기도 하다 — 편하게 켜지는 만큼 **어디까지 적용되는지 감각이 흐려진다.**

### 1-3. 인과의 핵심 — 리스너는 "생명주기 콜백"에 얹혀 있을 뿐이다

먼저 용어를 그 자리에서 정의한다. **엔티티 생명주기 콜백(lifecycle callback)이란, JPA가 엔티티를 저장·수정·삭제·조회하는 특정 시점마다 "이 메서드를 대신 불러주겠다"고 약속해둔 후크(hook)다.** 생명주기라는 이름은 엔티티가 "새 객체 → 영속 → 준영속 → 삭제"라는 일생을 지나간다는 관점에서 붙었고, 그 일생의 특정 지점에 코드를 끼워 넣는 장치라서 콜백이다. JPA 표준이 정한 후크는 `@PrePersist`, `@PostPersist`, `@PreUpdate`, `@PostUpdate`, `@PreRemove`, `@PostRemove`, `@PostLoad` 일곱 개다.

그리고 **`AuditingEntityListener`는 그중 두 개(`@PrePersist`, `@PreUpdate`)를 가진 평범한 클래스다.** 특별한 프레임워크 마법이 아니라, 우리가 직접 쓸 수도 있는 후크에 스프링 데이터가 미리 짜둔 코드가 얹혀 있는 것뿐이다.

```java
// spring-data-jpa 의 AuditingEntityListener — 실제로 이게 전부다
@Configurable
public class AuditingEntityListener {

    private @Nullable ObjectFactory<AuditingHandler> handler;

    @PrePersist                                  // INSERT 문을 만들기 직전에 불린다
    public void touchForCreate(Object target) {
        // createdAt / createdBy / updatedAt / updatedBy 를 채운다
    }

    @PreUpdate                                   // UPDATE 문을 만들기 직전에 불린다
    public void touchForUpdate(Object target) {
        // updatedAt / updatedBy 를 채운다
    }
}
```

여기서 **모든 답이 나온다.** `@PrePersist`/`@PreUpdate`는 **누가 호출하는가?** 하이버네이트다. 정확히는 **영속성 컨텍스트가 "이 엔티티 객체에 대해 INSERT/UPDATE 문을 만들겠다"고 결정하는 순간**이다.

> **비유하자면** — Auditing은 **출입문에 달린 자동 방명록**이다. 사람이 그 문으로 들어오면 이름과 시각이 자동으로 적힌다. 아주 잘 동작한다. **단, 창문으로 들어온 사람은 적히지 않는다.** 방명록은 사람을 감지하는 게 아니라 **문의 개폐를 감지**하기 때문이다. 벌크 UPDATE·네이티브 쿼리·`JdbcTemplate`은 전부 **창문**이다. 그리고 방명록은 "누가 창문으로 들어왔다"고 경고하지 않는다 — **그냥 아무것도 안 적힐 뿐이다.**

### 1-4. 정상 경로를 호출 흐름으로 그리면

말로만 두면 "리스너가 알아서 채운다" 수준에서 굳는다. `Member` 한 명을 휴면으로 바꾸는 **변경 감지 경로**를 단계로 펼쳐 놓는다.

```java
@Transactional
public void toDormant(Long memberId) {
    Member m = memberRepository.findById(memberId).orElseThrow();
    m.toDormant();                    // status 만 바꿨다. updatedAt 은 손대지 않았다.
}                                     // 여기서 커밋
```

```text
[정상 경로 — 변경 감지(dirty checking)]

  ① 엔티티 로드        findById() → SELECT
        │              영속성 컨텍스트에 "엔티티"와 "스냅샷"(로드 시점 값의 사본)이 함께 올라간다
        ▼
  ② 자바 객체 변경      m.toDormant() → status 필드만 바뀐다. SQL 은 아직 하나도 없다.
        │
        ▼
  ③ flush 시작         커밋 직전(또는 JPQL 실행 직전)에 하이버네이트가 자동으로 돈다
        │
        ▼
  ④ 액션 결정          스냅샷과 현재 값을 전부 비교 → "이 엔티티는 UPDATE 대상이다"라고 판정
        │              ◀── 이 문서 전체의 급소가 정확히 이 칸이다
        ▼
  ⑤ 콜백 발화          판정된 엔티티에 한해 @PreUpdate 리스너를 호출
        │              (판정되지 않은 엔티티에는 콜백이 가지 않는다)
        ▼
  ⑥ 필드 채움          AuditingEntityListener.touchForUpdate()
        │              updatedAt = 지금 시각,  updatedBy = AuditorAware 가 준 값
        ▼
  ⑦ SQL 생성·전송      UPDATE member SET status=?, updated_at=?, updated_by=?, ... WHERE id=?
        │
        ▼
  ⑧ 커밋
```

**④와 ⑤의 순서가 이 문항의 급소다.** 리스너는 ④의 **결과로** 호출된다. 즉

> **"영속성 컨텍스트가 이 엔티티를 변경 대상으로 판정했다"가 리스너 호출의 전제조건이다.**

전제조건이라는 말을 뒤집으면 이렇게 된다 — **판정이 없으면 콜백도 없다.** 리스너가 게으른 것도, 버그가 있는 것도 아니다. **호출될 계기 자체가 발생하지 않는다.**

### 1-5. 벌크 JPQL은 이 흐름의 어디를 건너뛰는가

같은 그림 위에 벌크 UPDATE를 얹으면 어디가 끊기는지 눈으로 보인다.

```java
@Modifying
@Query("update Member m set m.status = 'DORMANT' where m.lastLoginAt < :cut")
int toDormantBulk(@Param("cut") LocalDateTime cut);
```

```text
[벌크 JPQL 경로 — @Modifying]

  ① 엔티티 로드        ──── 건너뜀.  엔티티를 메모리에 올리지 않는다(그게 벌크를 쓰는 이유다)
        │
  ② 자바 객체 변경      ──── 건너뜀.  바꿀 자바 객체가 애초에 없다
        │
  ③ flush 시작         (flushAutomatically = true 라면, "이미 쌓여 있던 다른 변경"에만 돈다)
        │
  ④ 액션 결정          ──── 건너뜀.  비교할 스냅샷도, 판정할 대상 엔티티도 없다
        │
  ⑤ 콜백 발화          ──── 건너뜀   ◀── 여기서 Auditing 이 끊긴다. 예외 없이, 로그 없이.
        │
  ⑥ 필드 채움          ──── 건너뜀
        │
        ▼
  ⑦ SQL 생성·전송      UPDATE member SET status='DORMANT' WHERE last_login_at < ?
        │              ↑ 개발자가 쓴 SET 절이 그대로 나간다.
        │                감사 컬럼은 SET 절에 없으니 DB 에서도 안 바뀐다.
        ▼
  ⑧ 커밋               10만 행이 정상적으로 바뀐다. 반환값도 정확히 100000.
```

**끊긴 지점은 ⑤가 아니라 사실상 ④다.** ④가 없으니 ⑤가 발생할 수 없고, ⑤가 없으니 ⑥이 없고, ⑥이 없으니 ⑦의 SET 절에 감사 컬럼이 끼어들 방법이 없다. **하나의 인과 사슬이고, 끊는 곳은 언제나 맨 앞이다.**

여기서 **처방의 방향도 자동으로 두 갈래로 정해진다.**

- ⑦에서 **사람이 직접 SET 절에 써넣는다** → 2-4의 처방 ①
- ①~④를 **다시 타게 만든다**(엔티티를 로드해 변경 감지로) → 2-6의 처방 ②

세 번째 선택지는 없다. 흐름도 위에서 손댈 수 있는 칸이 그 둘뿐이기 때문이다.

### 1-6. 부수적으로 따라오는 두 가지 사실 (가산점 포인트)

**① `updatedAt`은 "setter를 호출한 시각"이 아니라 "flush 시각"이다.** 위 흐름에서 ②와 ⑥ 사이에 외부 API 호출이 3초 걸렸다면 `updatedAt`은 3초 뒤 값이다. 보통은 무의미한 차이지만, **밀리초 단위 순서로 이력을 재구성하는 로직**이라면 이 사실이 필요하다.

**② 변경이 없으면 `@PreUpdate`도 없다.** 값을 같은 값으로 다시 세팅하면 ④의 판정이 "안 바뀌었다"로 나오고 UPDATE 자체가 안 나가므로 `updatedAt`도 그대로다.

반대로 **의도치 않은 dirty 판정**이 생기면 정반대 증상이 나온다. `BigDecimal`의 scale 차이(`1.0`과 `1.00`은 `equals`가 false다), 컬렉션 재할당, `AttributeConverter`의 왕복 비대칭(DB에서 읽어 변환한 값이 원래 값과 다르게 나오는 경우) 같은 것들이다. 이때는 **아무도 수정하지 않은 행의 `updatedAt`이 갱신**된다. 그래서 "왜 이 행의 수정 시각이 바뀌었지?"라는 조사는 **Auditing 설정이 아니라 dirty checking 쪽**을 봐야 한다 → [영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md).

### 1-7. 경로별 기록 여부 — 판정 기준은 딱 하나다

같은 휴면 전환을 다섯 가지 방식으로 써본다. 코드는 비슷해 보이지만 1-4의 흐름도 위에서는 완전히 다른 경로다.

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

| 경로 | `@CreatedDate` | `@LastModifiedDate` | `@CreatedBy` / `@LastModifiedBy` | 리스너 호출 |
|---|---|---|---|---|
| (A) 변경 감지 | 해당 없음 (INSERT 아님) | **기록됨** | **기록됨** | `@PreUpdate` |
| (B) `save()` — 신규 | **기록됨** | **기록됨** | **기록됨** | `@PrePersist` |
| (B') `save()` — 병합(merge) | 해당 없음 | **기록됨** | **기록됨** | `@PreUpdate` |
| (C) 벌크 JPQL(`@Modifying`) | 조용히 누락 | **조용히 누락** | **조용히 누락** | **없음** |
| (D) 네이티브 변경 쿼리 | 조용히 누락 | **조용히 누락** | **조용히 누락** | **없음** |
| (E) `JdbcTemplate` / MyBatis | 조용히 누락 | **조용히 누락** | **조용히 누락** | **없음** |
| (F) DB 콘솔 수동 SQL·타 팀 배치 | 조용히 누락 | **조용히 누락** | **조용히 누락** | **없음** |
| (G) `deleteAllInBatch()` 등 벌크 삭제 | 해당 없음 | 해당 없음 | 해당 없음 | **없음** (`@PreRemove`도 안 돔) |

**표의 칸을 `O`/`X`가 아니라 "기록됨 / 조용히 누락"으로 쓴 이유가 있다.** `X`는 "실패했다"로 읽히고, 실패에는 보통 신호가 따라온다고 기대하게 된다. 하지만 여기서 벌어지는 일은 실패가 아니라 **아무 일도 일어나지 않는 것**이다. 표에서부터 그렇게 읽혀야 한다.

**(B)의 `@LastModifiedDate`가 왜 채워지는지**도 짚어둘 만하다. 신규 INSERT인데 "마지막 수정 시각"이 왜 찍히나 싶지만, 스프링 데이터가 **생성도 수정의 일종으로 취급해 함께 채우기** 때문이다. 신규 행의 `created_at`과 `updated_at`이 같은 값인 것은 이 때문이고, 원치 않으면 `@EnableJpaAuditing(modifyOnCreate = false)`로 끌 수 있다(기본값 `true`).

**(G)를 구분하는 것도 실전에서 중요하다.** `deleteAll()`은 엔티티를 전부 로드해 하나씩 지우므로 `@PreRemove`가 정상 발생하지만, `deleteAllInBatch()`는 `delete from Member` JPQL 한 문장을 `executeUpdate()`로 날린다 — **이름이 비슷한 두 메서드가 정반대 경로**다. soft delete를 `@PreRemove`나 `@SQLDelete`로 구현해뒀다면 `deleteAllInBatch()` 한 번으로 **진짜 삭제가 나간다.**

**(C)~(F)를 가르는 기준은 딱 하나다** — **영속성 컨텍스트가 엔티티 객체를 놓고 판정을 내렸는가.** 안 내렸으면 전부 누락이다. 이 기준을 손에 쥐고 있으면 **표에 없는 경로도 즉석에서 판정**할 수 있다. 그게 이 문항이 보려는 능력이다.

### 1-8. 실패가 "조용하다"는 것의 의미

이 문항이 위험한 진짜 이유는 원인이 어려워서가 아니다. **발견될 계기가 없어서**다.

```java
int updated = memberRepository.toDormantBulk(cutoff);
log.info("휴면 전환 완료: {}건", updated);      // "휴면 전환 완료: 100000건"
```

| 관측 지점 | 사고가 났을 때 보이는 것 |
|---|---|
| 예외 | **없다.** try-catch도, 에러 로그도 걸리지 않는다 |
| 경고 로그 | **없다.** 하이버네이트도 스프링 데이터도 아무 말을 하지 않는다 |
| 반환값(영향 행 수) | **정상이다.** 정확히 `100000`이 돌아온다 |
| 실패 카운트 | **없다.** 실패한 건이 0건이니 카운트할 것도 없다 |
| SQL 로그 | **정상이다.** `update member set status='DORMANT' where ...` 한 문장이 잘 실행됐다 |
| 배치 잡 상태 | **`COMPLETED`.** 스프링 배치 기준으로도 성공이다 |
| 모니터링·알림 | **울리지 않는다.** 울릴 신호가 없다 |

**즉 "성공했다"는 모든 신호가 정상이다.** 어느 관측 지점에도 이상이 없기 때문에 이 사고는 배포 직후에 발견되지 않는다.

**발견되는 시점은 대개 몇 달 뒤다.** 감사 요청이나 CS 조사에서 "이 회원 언제 휴면됐죠?"라는 질문이 들어왔을 때, `updated_at`이 2년 전 마지막 로그인 시각을 가리키고 있는 것으로 드러난다. 그리고 그때는 **원본 시각을 복구할 방법이 없다** — 어디에도 안 남았기 때문이다.

> **이 성질이 3-10(안전망)의 존재 이유다.** 예외가 나는 사고는 운영에서 잡힌다. **예외가 안 나는 사고는 테스트로 단정해두지 않으면 영원히 안 잡힌다.**

---

## 2. 처방과 그 대가

1-5에서 손댈 수 있는 칸이 두 개뿐이라는 것을 확인했다. 이 장은 그 두 처방을 코드로 펼치고, 각각이 무엇을 대가로 치르는지 계산한다. 다만 처방을 꺼내기 전에 **가장 흔한 오답 하나를 먼저 걷어낸다.**

### 2-1. 먼저 걷어낼 오해 — `hibernate.jdbc.batch_size`는 무엇을 하는 옵션인가

**세워야 할 오해부터 정확히 말한다.** "10만 건을 한 번에 바꾸는데 감사 컬럼이 안 채워진다"는 문제를 들으면, 이름에 `batch`가 들어간 이 옵션이 손에 잡힌다. **벌크(bulk) 연산 문제 → 배치(batch) 옵션**이라는 연상이 자연스럽기 때문이다. 실제로 이 오답은 면접에서 자주 나온다.

그런데 **이 옵션은 벌크 연산과 아무 관계가 없고, 값을 채우는 기능은 더더욱 아니다.** 이름이 비슷할 뿐이다.

하이버네이트 소스의 설정 정의를 그대로 보면 이렇게 적혀 있다.

```java
// org.hibernate.cfg.BatchSettings
/**
 * Specifies the maximum number of {@linkplain java.sql.PreparedStatement statements}
 * to {@linkplain PreparedStatement#addBatch batch} together.
 * A nonzero value enables batching
 *
 * @settingDefault 0
 */
String STATEMENT_BATCH_SIZE = "hibernate.jdbc.batch_size";
```

**핵심 단어는 "statements"(문장들)다.** 이 옵션은 **여러 개의 SQL 문장을 JDBC 드라이버 레벨에서 묶어 한 번에 전송**한다. `PreparedStatement.addBatch()`로 쌓았다가 `executeBatch()`로 한 번에 보내는 것이다. 기본값은 `0`이며 이는 배칭 꺼짐을 뜻한다.

```text
[batch_size = 0 (기본값)]   INSERT 1번째  →  네트워크 왕복
                            INSERT 2번째  →  네트워크 왕복      ... 1000건이면 왕복 1000번
                            ...

[batch_size = 500]          INSERT 1~500번째를 한 묶음  →  네트워크 왕복 1번
                            INSERT 501~1000번째를 한 묶음 →  네트워크 왕복 1번   ... 왕복 2번
```

**즉 이 옵션이 줄이는 것은 "왕복 횟수"다.** 이 옵션의 제대로 된 활용 — 언제 켜고 얼마로 잡으며 `IDENTITY` 전략에서 왜 무력화되는지 — 은 [벌크 INSERT와 JDBC 배치](21-bulk-insert-jdbc-batch.md)가 본론으로 다룬다. 여기서는 **이 문항과의 관계만** 확정한다.

### 2-2. 그래서 이 문항에 왜 무관한가

두 가지 이유로 무관하다.

**1. 문제의 성격이 다르다.** 우리 문제는 "느리다"가 아니라 **"컬럼이 안 채워진다"**다. `batch_size`는 전송 방식을 바꾸는 성능 옵션이지 값 공급 장치가 아니다. 1-5의 흐름도로 말하면, 이 옵션이 관여하는 지점은 ⑦(SQL 전송)인데 **끊긴 곳은 ④~⑥**이다. 관여 지점 자체가 겹치지 않는다.

**2. 묶을 대상 자체가 없다.** 벌크 UPDATE는 이미 **SQL 한 문장**이다(`update member set ... where last_login_at < ?`). 10만 건을 고치지만 **문장은 하나**다. "여러 문장을 묶는" 옵션에게 묶으라고 해도 묶을 게 없다.

```text
batch_size 가 효과를 내는 상황:   save() 를 10만 번 → UPDATE/INSERT 문장 10만 개 → 묶을 대상 있음
이 문항의 상황:                  벌크 UPDATE 1회   → UPDATE 문장 1개             → 묶을 대상 없음
```

**설령 `batch_size`를 1000으로 올려도 `updated_at`은 여전히 옛날 값이다.** 두 문제는 **교집합이 없다.**

### 2-3. 진짜 교훈 — 도구는 "해결하는 것"과 "해결 못 하는 것"을 세트로 외운다

이 오적용은 지식 부족이 아니다. **`batch_size`라는 이름을 최근에 정확히 배웠기 때문에 생긴 일**이다. 새로 배운 도구는 **적용 범위가 함께 고정되지 않으면 인접 문제로 번진다.** 그래서 도구를 익힐 때는 항상 **네 칸짜리 카드**로 외운다.

| 도구 | 해결하는 것 | **해결하지 못하는 것** | 관측 신호 |
|---|---|---|---|
| `hibernate.jdbc.batch_size` | 문장이 **여러 개**일 때 왕복 횟수 | **값 채우기**, 문장이 하나인 벌크 연산, Auditing 누락 | Hibernate `Statistics`의 배치 통계 |
| `@Modifying` | JPQL 변경 쿼리를 실행 경로로 태움 | **1차 캐시 동기화, Auditing, `@Version` 증가** | 반환 `int`(영향 행 수) |
| `AuditingEntityListener` | 컨텍스트를 **거치는** 변경의 시각·주체 기록 | **벌크·네이티브·`JdbcTemplate`·수동 SQL** | 컬럼이 조용히 안 바뀜 |
| Hibernate Envers | 컨텍스트를 **거치는** 변경의 **전체 이력** | **벌크 연산**(3-7), DB 직접 변경 | `_AUD` 테이블에 리비전 없음 |
| DB `ON UPDATE CURRENT_TIMESTAMP` / 트리거 | **모든 경로**의 시각 기록 | **애플리케이션 주체(누가)**, 벤더 종속 | DDL을 봐야만 존재를 앎 |
| `@Transactional` | 원자성·경계 | **락 경합, 컨텍스트 우회 경로** | — |

> **이 카드 습관이 "도구 이름이 없다"는 약점의 진짜 해법**이다. 이름만 늘리면 오적용도 같이 늘어난다. **"이 도구가 못 하는 것" 칸을 채우는 순간 그 도구는 잘못 집히지 않는다.**

### 2-4. 처방 ① — 벌크를 유지한 채 SET 절에 직접 쓴다

1-5의 흐름도에서 ⑦만 손대는 선택지다. 리스너가 ⑥에서 해주던 일을 사람이 SQL에 써넣는다.

```java
// BEFORE — 상태만 바꾼다. 감사 컬럼은 조용히 옛날 값 그대로.
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
// AFTER — 리스너가 해주던 일을 SET 절에 손으로 쓴다.
public interface MemberRepository extends JpaRepository<Member, Long> {

    @Modifying(flushAutomatically = true)          // 실행 전 미반영 변경분을 DB 에 먼저 반영한다
    @Query("""
           update Member m
              set m.status    = 'DORMANT',
                  m.updatedAt = :now,             // @LastModifiedDate 가 해주던 일
                  m.updatedBy = :actor            // @LastModifiedBy 가 해주던 일
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
    LocalDateTime now = LocalDateTime.now();               // 배치 전체가 같은 시각을 공유하게 만든다
    LocalDateTime cutoff = now.minusYears(1);
    return memberRepository.toDormantBulk(cutoff, now, "BATCH_DORMANT");
}
```

**설계 포인트 세 개.**

**1. 시각을 파라미터로 받는다.** JPQL 안에 `current_timestamp`를 써도 동작은 한다. 그런데 밖에서 주입하면 두 가지를 얻는다 — ① 배치가 여러 쿼리로 쪼개져도 **전체가 동일 시각으로 찍혀 이력이 한 덩어리로 읽히고** ② 테스트에서 `Clock`을 고정해 **등치 비교로 단정**할 수 있다. DB 함수를 쓰면 두 가지 다 잃는다.

**2. 주체를 상수 문자열로 명시한다.** `'BATCH_DORMANT'`처럼 **사람 계정과 구분되는 이름**을 쓴다. 나중에 "이 시점에 대량으로 바뀐 이유"를 조사할 때 **`updated_by`로 배치 실행 건을 통째로 골라낼 수 있다.** 이게 3-2의 `AuditorAware` 함정에 대한 가장 단순하고 확실한 대응이기도 하다.

**3. `@Modifying`의 두 옵션은 이 문항의 처방이 아니다.** `flushAutomatically`와 `clearAutomatically`는 둘 다 **기본값이 `false`**이고, **1차 캐시 정합성** 문제를 다루는 옵션이지 감사 컬럼과 무관하다. 다만 벌크를 쓰는 이상 그 문제도 동시에 존재하므로 함께 검토해야 한다 → [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md).

### 2-5. 같이 빠지는 것들도 SET 절에 넣어야 하는지 판단한다

감사 컬럼만 문제가 아니다. **영속성 컨텍스트를 우회하면 컨텍스트가 해주던 일이 전부 빠진다.** 1-4의 흐름도에서 ④~⑥ 구간이 통째로 사라졌으니, 그 구간에 걸려 있던 다른 기능들도 같이 사라지는 것이다.

```java
@Modifying
@Query("""
       update Member m
          set m.status    = 'DORMANT',
              m.updatedAt = :now,
              m.updatedBy = :actor,
              m.version   = m.version + 1        // 낙관적 락 버전도 자동으로는 안 올라간다
        where ...
       """)
```

`@Version`을 쓰고 있다면 **벌크는 버전을 올리지 않으므로 다른 트랜잭션이 이 변경을 감지하지 못한다** → [낙관적 락과 비관적 락](10-optimistic-vs-pessimistic-lock.md). soft delete의 `@SQLDelete`, `cascade`, 2차 캐시 무효화도 같은 이유로 빠진다.

> **하나로 묶으면**: **"JPA를 우회한 변경은 JPA가 모른다."** Auditing 누락은 이 원리의 한 사례일 뿐이고, **원리로 답하면 나머지 사례가 자동으로 딸려 나온다.**

### 2-6. 처방 ② — 엔티티를 로드해 변경 감지로 처리한다

1-5의 흐름도에서 ①~④를 **다시 타게 만드는** 선택지다. 손으로 쓸 것이 아무것도 없어지는 대신, 왕복과 메모리를 대가로 낸다.

```java
// 건수가 감당 범위라면 — 리스너가 정상 동작하는 경로로 되돌린다
@Transactional
public int toDormantByDirtyChecking(LocalDateTime cutoff) {
    List<Member> targets = memberRepository.findByStatusAndLastLoginAtBefore(
            MemberStatus.ACTIVE, cutoff);
    targets.forEach(Member::toDormant);      // 필드만 바꾼다 → 커밋 시 @PreUpdate 가 발생한다
    return targets.size();
}
```

**얻는 것**: 감사 컬럼·`@Version`·엔티티 리스너·도메인 이벤트가 **전부 정상 동작한다.** 감사 컬럼을 손으로 쓸 필요가 없으니 **"다음에 벌크 쿼리를 하나 더 추가한 사람이 SET 절을 빼먹는" 재발 경로도 사라진다.** 이건 성능이 아니라 **규율 측면의 이득**이고, 실무에서 과소평가되기 쉽다.

**포기하는 것**: 10만 건이면 이 코드는 쓸 수 없다.

- **UPDATE 문이 10만 개** 나간다(벌크는 1개).
- **엔티티 10만 개 + 스냅샷 10만 벌**이 영속성 컨텍스트에 쌓인다. 스냅샷은 dirty checking을 위한 사본이므로 메모리를 두 배로 먹고, flush마다 비교 대상이 늘어 **뒤로 갈수록 느려진다** → [벌크 INSERT와 JDBC 배치](21-bulk-insert-jdbc-batch.md).
- 트랜잭션이 길어져 **락 점유 시간과 커넥션 점유 시간**이 함께 늘어난다.

### 2-7. 선택 기준

| 조건 | 선택 | 이유 |
|---|---|---|
| 수백~수천 건, 감사 요구 있음 | **변경 감지** | 정합성이 성능보다 비싸다. 손으로 쓸 것이 없다 |
| 수만 건 이상 | **벌크 + SET 절 명시** | 왕복·메모리가 감당 안 된다 |
| 수만 건 이상 **+ 감사 요구가 강함** | **청크 단위 변경 감지**(2-8) 또는 **벌크 + 이력 테이블 직접 적재**(3-9) | 둘 중 무엇을 포기할지 정해야 한다 |

### 2-8. 중간 지대 — 청크로 끊어 변경 감지

두 처방 사이에는 절충안이 있다. Spring Batch의 chunk나 수동 페이징으로 **1000건씩 끊어 로드 → 변경 → `flush()` + `clear()`**를 반복하면, 컨텍스트가 매번 비워지므로 메모리 문제 없이 변경 감지 경로를 유지할 수 있다.

**왕복 횟수는 여전히 건수만큼**이다. 그런데 바로 여기서 `hibernate.jdbc.batch_size`가 **드디어 의미를 갖는다** — 이제 UPDATE 문장이 실제로 여러 개이기 때문이다.

> **2-1~2-3의 오적용을 뒤집어 보는 지점이 여기다.** `batch_size`는 틀린 도구가 아니라 **틀린 자리에 놓였던 도구**다. 문장이 여러 개인 이 설계로 오면 정확히 제 일을 한다. **"도구가 나쁜 게 아니라 문제와 도구의 짝이 틀렸다"**는 것이 2-3 교훈의 완성형이다.

---

## 3. 절반만 답하지 않기 위한 나머지

여기까지 답하면 "시각이 왜 안 찍히고 어떻게 찍는가"가 끝난다. 그런데 **면접에서 만점이 갈리는 곳은 여기서부터다.** 남은 것이 셋이다 — **주체(누가) 축**, **감사라는 요구의 층위**, 그리고 **이 모든 규칙을 코드로 고정하는 법**.

### 3-1. 주체 축 ① — 벌크에서는 시각과 같은 원인으로 빠진다

먼저 쉬운 쪽부터. 2-4의 AFTER 코드에서 `m.updatedBy = :actor`를 이미 넣었다. **원인은 시각과 완전히 동일하다** — 1-5 흐름도의 ⑤~⑥이 건너뛰어졌으니 시각도 주체도 같이 안 채워진 것뿐이다. 처방도 동일하다. SET 절에 같이 쓰면 된다.

**그런데 시각만 넣고 주체를 빠뜨리는 것이 실무에서 가장 흔한 절반짜리 수정이다.** "`updatedAt`이 안 찍힌다"가 신고 문구였으니 `updatedAt`만 고치고 끝내는 것이다.

그리고 감사 관점에서는 **"언제"보다 "누가"가 더 중요한 경우가 많다** — 개인정보 열람·수정 이력의 핵심 질문은 언제나 **"누가 봤는가/바꿨는가"**다. 절반만 고친 상태로 감사를 받으면, 시각이 있어도 답할 수 있는 게 없다.

### 3-2. 주체 축 ② — 배치 스레드에는 SecurityContext가 없다 (원인이 완전히 다르다)

여기서부터가 진짜다. **이것은 벌크 연산과 무관한 별개의 구멍**이고, **원인이 3-1과 완전히 다르다.** 두 실패를 섞어 말하면 처방도 섞여서 틀린다.

| | 3-1의 실패 | 3-2의 실패 |
|---|---|---|
| **원인** | 콜백 자체가 발생하지 않음 (경로 문제) | 콜백은 정상 발생하는데 **공급할 값이 없음** (컨텍스트 문제) |
| **일어나는 경로** | 벌크·네이티브·`JdbcTemplate` | **변경 감지 경로에서도 일어난다** |
| **같이 빠지는 것** | 시각도 같이 빠진다 | **시각은 정상으로 찍힌다.** 주체만 안 채워진다 |
| **처방** | SET 절에 직접 쓰기 / 변경 감지로 되돌리기 | `AuditorAware`에 시스템 주체 폴백 넣기 |

1-1의 `AuditorAware` 구현을 다시 본다.

```java
return () -> {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth == null || !auth.isAuthenticated()) {
        return Optional.empty();       // 배치 스레드에서는 항상 여기로 온다
    }
    return Optional.of(auth.getName());
};
```

`SecurityContextHolder`는 기본적으로 **`ThreadLocal` 기반**이다. `ThreadLocal`은 **스레드마다 별개의 값을 갖는 저장소**로, 스레드 A가 심어둔 값을 스레드 B가 읽을 수 없다. 스프링 시큐리티는 HTTP 요청을 받는 필터에서 인증 정보를 이 저장소에 심고 응답 후 지우는데, **심는 주체가 요청 처리 스레드**라는 것이 핵심이다.

그래서 다음 스레드들에는 **애초에 인증 정보가 없다.**

- 스케줄러(`@Scheduled`)가 도는 스레드
- Spring Batch의 워커 스레드
- `@Async`로 분기된 스레드
- 메시지 컨슈머(Kafka·RabbitMQ 리스너) 스레드
- 애플리케이션 기동 시 데이터 초기화 코드

즉 **변경 감지 경로로 완벽하게 정상 동작하는 배치**여도 주체는 채워지지 않는다.

> **벌크를 안 쓰더라도, 배치라는 이유만으로 주체 축은 이미 비어 있을 수 있다.**

### 3-3. 이때 실제로 채워지는 값 — `null`이 아니라 "직전 사람 이름"이다

여기서 흔히 잘못 알려진 부분을 스프링 데이터 소스로 확정한다. `AuditorAware`가 `Optional.empty()`를 반환하면 **필드에 `null`이 들어가는 것이 아니라, 필드를 아예 건드리지 않는다.**

```java
// spring-data-commons: AuditingHandlerSupport.touchAuditor()
private void touchAuditor(Auditor<?> auditor, AuditableBeanWrapper<?> wrapper, boolean isNew) {

    if (!auditor.isPresent()) {
        return;                    // setCreatedBy / setLastModifiedBy 를 아예 호출하지 않고 빠져나간다
    }
    if (isNew) {
        wrapper.setCreatedBy(auditor.getValue());
    }
    if (!isNew || modifyOnCreation) {
        wrapper.setLastModifiedBy(auditor.getValue());
    }
}
```

`Optional.empty()`는 `Auditor.none()`으로 변환되고 `isPresent()`가 `false`가 되어 **첫 줄의 조기 리턴에 걸린다.** 반면 바로 다음에 호출되는 시각 처리(`touchDate`)에는 이런 분기가 없어 **시각은 정상으로 채워진다.** 그래서 결과가 경우에 따라 갈린다.

| 상황 | `updated_at` | `updated_by`에 남는 값 |
|---|---|---|
| 배치가 **새 행을 INSERT** | 지금 시각으로 채워짐 | 필드가 원래 `null`이었으므로 **`null`로 저장** |
| 배치가 **기존 행을 UPDATE** | 지금 시각으로 채워짐 | **직전에 들어 있던 값이 그대로 유지되어 다시 저장된다** |

**두 번째 줄이 단순 누락보다 나쁘다.** 어제 `admin`이 웹 화면에서 고쳤던 행을 오늘 새벽 배치가 변경 감지 경로로 수정하면, 그 행은 `updated_at = 오늘 04:00`, `updated_by = 'admin'`이 된다. **행이 "admin이 오늘 새벽 4시에 이 데이터를 바꿨다"고 진술하게 되는 것이다.** admin은 그 시각에 아무것도 하지 않았다.

비어 있는 기록은 "모른다"는 뜻이라도 되지만, **틀린 기록은 조사를 엉뚱한 방향으로 끌고 간다.** 감사 데이터에서는 이쪽이 훨씬 위험하다.

### 3-4. 처방 — 시스템 주체를 명시적으로 심는다

방향은 하나다. **`Optional.empty()`를 절대 반환하지 않게 만든다.** 인증이 없는 경로에는 "인증이 없다"는 사실 자체를 값으로 기록한다.

```java
// ① 배치를 고려한 AuditorAware — 인증이 없으면 시스템 주체로 폴백한다
@Bean
public AuditorAware<String> auditorProvider() {
    return () -> {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated() || "anonymousUser".equals(auth.getPrincipal())) {
            return Optional.of(SystemActorHolder.current());   // empty 를 반환하지 않는 것이 요점
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
        SystemActorHolder.clear();      // 스레드 풀이 이 스레드를 재사용하므로 정리가 필수다
    }
}
```

**`finally`의 `clear()`가 없으면 안 되는 이유**를 짚어둔다. 스레드 풀은 작업이 끝나도 스레드를 죽이지 않고 다음 작업에 재사용한다. `ThreadLocal`에 남겨둔 값은 그 스레드가 처리하는 **완전히 무관한 다음 작업까지 따라간다.** 그러면 웹 요청이 `"BATCH_DORMANT"`가 바꾼 것으로 기록될 수 있다.

**③ `Optional.empty()`를 반환하지 않는 것 자체가 설계 결정이다.** 비어 있거나 옛 값이 남은 감사 필드보다 **`"SYSTEM"`이라는 명시적 값**이 낫다. `null`은 "기록에 실패했다"와 "시스템이 바꿨다"를 구분하지 못하지만, `"SYSTEM"`/`"BATCH_DORMANT"`는 **조사 가능한 정보**다. 그리고 3-3에서 본 "옛 값이 그대로 남는" 사고도 이 폴백 하나로 사라진다 — 항상 값을 공급하면 조기 리턴에 걸릴 일이 없기 때문이다.

> **(가산점 포인트)** `@Async`로 분기한 스레드에 인증 정보를 넘기고 싶다면 `SecurityContextHolder`의 전략을 `MODE_INHERITABLETHREADLOCAL`로 바꾸거나, 스프링 시큐리티가 제공하는 **`DelegatingSecurityContextExecutor` 계열 래퍼**로 실행기를 감싼다. 다만 **스레드 풀에서는 컨텍스트가 다음 작업으로 새는 위험**이 따라오므로, **배치에는 상속보다 위 ②의 명시적 주입이 안전하다.** "얻는 것(편의)과 포기하는 것(누수 위험)"을 같이 말하는 자리다.

### 3-5. 신뢰 경계란 무엇인가 — "애플리케이션 안쪽"이라는 말의 구체적 의미

**신뢰 경계(trust boundary)란 "이 안에서 일어난 일은 기록이 보장되고, 이 밖에서 일어난 일은 보장되지 않는다"고 선을 그을 수 있는 범위**를 말한다. 보안 설계에서 온 용어인데, 감사 로그를 설계할 때 가장 먼저 정해야 하는 것이 이 선이다. 선을 안 그으면 "우리는 다 기록하고 있다"는 근거 없는 믿음이 생긴다.

애플리케이션 레벨 Auditing의 선은 정확히 여기까지다.

```text
                     ┌──────────────────── 신뢰 경계 ────────────────────┐
                     │                                                  │
  웹 요청 ──────────▶ │  서비스 → 영속성 컨텍스트 → @PreUpdate → 기록됨   │ ──▶ DB
                     │                                                  │
  배치(변경 감지) ──▶ │  서비스 → 영속성 컨텍스트 → @PreUpdate → 기록됨   │ ──▶ DB
                     │       (단, 주체는 3-2 때문에 비어 있을 수 있다)     │
                     │                                                  │
                     └──────────────────────────────────────────────────┘

  배치(벌크 JPQL) ────────────────── 경계 밖 ──────────────────────────────▶ DB
  JdbcTemplate / MyBatis ─────────── 경계 밖 ──────────────────────────────▶ DB
  운영자의 DB 콘솔 UPDATE ─────────── 경계 밖 ──────────────────────────────▶ DB
  타 팀 시스템 / 레거시 배치 ───────── 경계 밖 ──────────────────────────────▶ DB
  DBA 의 데이터 패치 스크립트 ──────── 경계 밖 ──────────────────────────────▶ DB
```

**추상적으로 들리는 이 말을 구체적인 사건 둘로 바꿔 본다.**

**사건 1 — 누군가 DB 콘솔에서 직접 UPDATE한다.** 새벽에 장애 대응으로 운영자가 `update member set status='ACTIVE' where id = 12345`를 실행했다고 하자. 데이터는 바뀐다. 그리고 `updated_at`도 `updated_by`도 **아무 흔적을 남기지 않는다.** 이 변경은 애플리케이션을 통과하지 않았으므로 애플리케이션이 알 방법 자체가 없다. 나중에 "이 회원 상태가 왜 바뀌었죠?"를 조사하면, 감사 컬럼은 **그 전에 애플리케이션이 마지막으로 바꿨던 시각과 사람**을 가리키고 있다. 즉 **엉뚱한 사람이 범인으로 지목된다.**

**사건 2 — 감사 기록을 만드는 코드와 감사 대상 코드가 같은 사람 손에 있다.** 애플리케이션 코드를 수정·배포할 수 있는 사람은 `AuditorAware`가 반환하는 값도 바꿀 수 있고, `@LastModifiedBy` 애노테이션을 떼어낼 수도 있고, 벌크 쿼리로 감사 컬럼을 원하는 값으로 덮어쓸 수도 있다. **감시 카메라의 녹화 버튼이 감시 대상 방 안에 있는 구조**다. 이래서 진짜 감사(監査)에서는 "애플리케이션이 스스로 남긴 기록"을 최종 증거로 인정하지 않는 경우가 있다.

**정리하면 이 방식이 보장하는 것은 딱 하나다** — "우리 애플리케이션이 정상 경로로 바꾼 변경은 기록된다." 그 밖의 모든 것에 대해서는 **아무 말도 하지 않는다.**

### 3-6. 애플리케이션 레벨 Auditing이 얻은 것과 포기한 것

`@EntityListeners` 한 줄로 전 엔티티에 감사 컬럼을 배포한 이 방식은 **공짜가 아니다.** 3-5의 경계가 그 대가 중 하나이고, 대가는 셋이다.

| | 애플리케이션 레벨 Auditing |
|---|---|
| **얻는 것** | ① `BaseEntity` 한 줄로 **전 엔티티 일괄 적용** ② **DB 독립**(벤더가 바뀌어도 그대로) ③ 애플리케이션의 인증 정보를 그대로 주체로 사용 ④ 테스트에서 시각을 고정 가능 |
| **포기하는 것** | ① **신뢰 경계가 애플리케이션 안쪽** — 벌크·네이티브·`JdbcTemplate`·타 시스템·운영자 수동 SQL은 못 잡는다(3-5) ② **덮어쓰기식**이라 "언제 무엇이 무엇으로 바뀌었는지"의 **이력이 남지 않는다**(마지막 상태만) ③ 실패가 **조용하다**(1-8) |

**포기하는 것 ②를 놓치기 쉽다.** `@LastModifiedDate`는 **가장 최근 수정 시각 하나**만 갖는 컬럼이다. 두 번 수정되면 첫 번째 수정의 흔적은 두 번째가 덮어써서 사라진다. "3월 12일에 등급이 GOLD에서 SILVER로 바뀌었다"는 **변경 내역**은 어디에도 없다.

**감사 요구는 대부분 이력을 요구한다.** "이 데이터가 언제 어떻게 변해왔는가"를 묻지, "마지막에 언제 바뀌었는가"만 묻지 않는다. 그러므로 **`updated_at` 컬럼 하나로는 애초에 요건을 만족하지 못한다.** 이 구분을 말할 수 있으면 "감사"라는 단어를 실제로 다뤄본 사람으로 읽힌다.

정리하면 **부족한 것이 두 종류**다 — **기록의 형태**(덮어쓰기 vs 이력)와 **기록의 경계**(어느 경로까지 잡는가). 다음 두 절이 각각을 다룬다.

### 3-7. 한 층 내리기 ① — Hibernate Envers (그리고 Envers도 벌크에서 빠진다)

```java
@Entity
@Audited                       // 이 엔티티의 변경을 리비전 테이블에 남긴다
public class Member extends BaseEntity { ... }
```

Envers는 `member_AUD` 같은 **이력 테이블**과 리비전 메타 테이블을 만들고, 변경이 일어날 때마다 **그 시점의 스냅샷을 한 행씩 적재**한다. `AuditReader`로 "3월 12일 시점의 이 회원"을 그대로 복원할 수 있다. 3-6의 **포기하는 것 ②(기록의 형태)를 정확히 메운다.**

**그런데 여기서 반드시 덧붙여야 할 사실이 있다.**

> **Envers도 하이버네이트의 엔티티 이벤트(post-insert / post-update / post-delete) 리스너로 동작한다. 그래서 벌크 JPQL·네이티브 쿼리에서는 `AuditingEntityListener`와 똑같이 빠진다.**

이유는 1-4의 흐름도 그대로다. 접미사가 `Pre`냐 `Post`냐만 다를 뿐, **둘 다 ④의 판정이 있어야 발생하는 이벤트**다. 판정이 없으면 `Pre`도 `Post`도 없다.

```java
@Modifying
@Query("update Member m set m.status = 'DORMANT' where ...")
int toDormantBulk(...);
// member 테이블은 바뀐다
// member_AUD 에는 리비전이 단 한 건도 안 생긴다. 예외도 경고도 없다.
```

**"Envers 쓰면 됩니다"로 끝내면 이 지점에서 걸린다.** 3-6의 두 부족함을 다시 놓고 보면 명확하다 — Envers는 **기록의 형태**를 덮어쓰기에서 이력으로 바꿔주지만, **기록의 경계**(영속성 컨텍스트를 거치는 변경만)는 **전혀 바꾸지 못한다.** 심지어 Envers를 켜면 이력 테이블이 생겨서 "이제 다 기록된다"는 잘못된 안심이 추가되므로, **경계 문제는 그대로인 채 착시만 강해진다.**

### 3-8. 한 층 내리기 ② — DB로 내린다

경계를 진짜로 넓히려면 **애플리케이션 밖으로** 나가야 한다. 애플리케이션을 통과하지 않는 변경까지 잡으려면, 기록하는 주체가 **모든 변경이 반드시 지나가는 지점** 즉 DB에 있어야 하기 때문이다.

**(가) 컬럼 기본값 / `ON UPDATE`** — MySQL이라면 DDL 한 줄로 시각 축을 **모든 경로에 적용**할 수 있다.

```sql
ALTER TABLE member
  MODIFY updated_at TIMESTAMP NOT NULL
         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
```

이러면 **벌크든 네이티브든 `JdbcTemplate`이든 DB 콘솔이든** UPDATE가 나가는 순간 시각이 찍힌다. **다만 네 가지를 포기한다.**

- **"누가"는 여전히 모른다.** DB는 애플리케이션 사용자를 모른다. 아는 것은 DB 접속 계정뿐인데, 커넥션 풀을 쓰는 애플리케이션은 전부 같은 계정으로 붙는다.
- **벤더 종속이다.** PostgreSQL에는 `ON UPDATE` 절 문법이 없어 `BEFORE UPDATE` 트리거를 직접 만들어야 한다.
- **JPA가 채운 값과 DB가 채운 값이 경합한다.** 엔티티에 그냥 매핑된 채로 두면 하이버네이트가 자기 값을 SET 절에 실어 보내므로 DB 기본값이 무력화된다. DB에 맡길 컬럼은 `@Column(insertable = false, updatable = false)`이나 하이버네이트의 `@CurrentTimestamp(source = DB)` 계열로 **소유권을 명시**해야 한다. **소유권을 정하지 않은 이중 관리가 가장 나쁘다** — 값이 어디서 왔는지 아무도 모르게 된다.
- **같은 값으로 덮는 UPDATE에는 반응하지 않는다.** MySQL의 `ON UPDATE`는 **행의 다른 컬럼 값이 실제로 달라진 UPDATE에서만** 갱신된다.

**(나) 트리거 + 이력 테이블** — "누가"까지 필요하고 경계도 넓혀야 한다면 트리거로 `member_history`에 행을 남긴다. **모든 경로를 잡는 유일한 방법**이지만 대가가 크다.

- 애플리케이션 세션 사용자를 트리거에 전달할 방법을 따로 만들어야 한다(세션 변수 등) — **그 전달 코드를 안 타는 경로에서는 다시 비어버린다.** 즉 "누가"를 채우는 순간 경계 문제가 부분적으로 되돌아온다.
- **삭제 파급과 마찬가지로 로직이 DDL에만 있어 코드 리뷰로 발견되지 않는다.** 애플리케이션 저장소를 아무리 뒤져도 안 나온다.
- 스키마 마이그레이션·테스트 환경 구성이 무거워진다.

### 3-9. 실무 규칙 두 갈래 — 여기가 이 문항의 설계 답이다

경계를 완벽히 넓히는 것이 항상 가능하진 않다. 트리거를 못 쓰는 조직도 있고, 쓰더라도 "누가"는 여전히 새어나간다. 그래서 실무는 **둘 중 하나(또는 둘 다)를 택한다.**

**① 감사 대상 엔티티에는 벌크 연산을 금지한다.** 성능이 아니라 **정합성을 우선순위로 못 박는 규칙**이다. 그리고 사람의 주의력이 아니라 **도구로 고정**한다(3-11의 ArchUnit 룰). 감사 대상 엔티티를 `@Audited`나 전용 마커 애노테이션으로 표시해두면 룰이 대상을 식별할 수 있다.

**② 벌크가 불가피하면 이력 적재 경로를 함께 만든다.** 벌크 UPDATE와 **같은 트랜잭션 안에서** 이력 테이블에 `insert into member_history select ...` 형태로 한 문장을 더 넣는다.

```java
@Transactional
public int runDormantBatch(LocalDateTime now) {
    // ① 바꾸기 전 상태를 이력 테이블에 통째로 적재 (한 문장)
    int archived = historyRepository.archiveDormantTargets(cutoff, now, "BATCH_DORMANT");
    // ② 벌크 UPDATE (감사 컬럼 포함)
    int updated  = memberRepository.toDormantBulk(cutoff, now, "BATCH_DORMANT");
    if (archived != updated) {
        // 두 문장의 where 조건이 어긋나면 여기서 트랜잭션째 롤백된다
        throw new IllegalStateException("이력 건수 불일치: " + archived + " vs " + updated);
    }
    return updated;
}
```

**건수 일치 단정을 넣은 것이 이 코드의 핵심**이다. 두 문장이 **서로를 검증**하게 만들면, 조건이 어긋나 이력이 누락되는 순간 **조용한 실패가 시끄러운 실패로 승격**된다. 1-8에서 본 이 문항의 본질적 위험 — "관측 지점 어디에도 신호가 없다" — 에 대한 직접적인 대응이다. **관측 지점이 없으면 만들어 넣는 것이다.**

### 3-10. 안전망을 코드로 고정하기 — "테스트로 막는다"의 구체적 형태

이 사고는 **예외가 나지 않는다.** 그러므로 막는 방법은 하나뿐이다 — **단정(assertion)으로 고정하는 것.** 다만 "테스트를 쓴다"는 방향만으로는 부족하고, **무엇을 어떻게 단정하느냐**에서 갈린다.

**먼저 함정 — 같은 트랜잭션에서 검증하면 오염된다.**

```java
// 이 테스트는 벌크 UPDATE 의 결과를 제대로 보지 못한다
@Test
@Transactional
void 벌크_휴면전환_후_수정시각이_갱신된다() {
    Member m = memberRepository.save(new Member("hong@a.com", oldLogin));
    LocalDateTime before = m.getUpdatedAt();

    memberRepository.toDormantBulk(cutoff, now, "BATCH_DORMANT");

    Member found = memberRepository.findById(m.getId()).orElseThrow();
    assertThat(found.getUpdatedAt()).isAfter(before);      // 1차 캐시의 옛 객체를 보고 있다
}
```

**벌크 연산은 DB만 바꾸고 1차 캐시는 그대로 두므로**, 같은 트랜잭션의 `findById`는 **SELECT조차 나가지 않고 메모리의 옛 객체를 반환**한다. 이 테스트는 **버그가 없어도 실패하고, 있어도 실패**해서 아무것도 증명하지 못한다 → [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md).

**처방 — 컨텍스트를 비우고 다시 읽는다.**

```java
// 검증은 반드시 새로 읽어온 상태에서 한다
@Test
@Transactional
void 벌크_휴면전환은_수정시각과_주체를_남긴다() {
    LocalDateTime now = LocalDateTime.of(2026, 3, 12, 4, 0);
    Member m = memberRepository.save(new Member("hong@a.com", now.minusYears(2)));
    LocalDateTime beforeUpdatedAt = m.getUpdatedAt();
    em.flush();
    em.clear();                                           // 1차 캐시를 비운다

    int updated = memberRepository.toDormantBulk(now.minusYears(1), now, "BATCH_DORMANT");
    em.clear();                                           // 벌크 이후에도 다시 비운다

    assertThat(updated).isEqualTo(1);
    Member found = memberRepository.findById(m.getId()).orElseThrow();
    assertThat(found.getStatus()).isEqualTo(MemberStatus.DORMANT);
    assertThat(found.getUpdatedAt()).isEqualTo(now);                   // 시각 축
    assertThat(found.getUpdatedAt()).isNotEqualTo(beforeUpdatedAt);
    assertThat(found.getUpdatedBy()).isEqualTo("BATCH_DORMANT");       // 주체 축
}
```

**두 축을 모두 단정한 것이 핵심**이다. 시각만 단정하는 테스트는 3-1의 절반짜리 수정을 그대로 통과시킨다.

**시각을 고정하면** `isAfter` 같은 느슨한 단정 대신 **정확한 등치 비교**가 가능해진다. 고정하는 방법이 경로에 따라 둘로 갈리므로 구분해서 알아야 한다.

| 시각을 채우는 주체 | 고정 방법 |
|---|---|
| 벌크 SET 절 (2-4) — **내 코드가 `now`를 만든다** | `LocalDateTime.now()`를 직접 부르지 말고 `Clock` 빈을 주입받아 테스트에서 `Clock.fixed(...)`로 못 박는다 |
| 리스너 (`@LastModifiedDate`) — **스프링 데이터가 시각을 만든다** | `DateTimeProvider` 빈을 만들어 `@EnableJpaAuditing(dateTimeProviderRef = "fixedDateTimeProvider")`로 지목한다 |

두 번째가 존재하는 이유가 중요하다. 리스너 경로의 시각은 **내 코드가 만드는 값이 아니라** 스프링 데이터 내부의 `CurrentDateTimeProvider`가 만드는 값이라, `Clock` 빈을 아무리 갈아끼워도 바뀌지 않는다. **값을 만드는 주체가 다르면 고정하는 손잡이도 다르다.**

### 3-11. 회귀를 막는 세 겹

테스트 하나는 **그 쿼리 하나만** 지킨다. **다음 사람이 벌크 쿼리를 하나 더 추가하면 다시 뚫린다.** 그래서 세 겹으로 간다.

**① 스키마로 막기 — 다만 한계를 정확히 알고 쓴다.**

```sql
ALTER TABLE member
  MODIFY created_at TIMESTAMP NOT NULL,
  MODIFY created_by VARCHAR(50) NOT NULL;
```

`NOT NULL`은 **INSERT 경로의 누락을 즉시 실패로 만든다.** `JdbcTemplate`으로 감사 컬럼 없이 INSERT를 시도하면 그 자리에서 터진다 — **조용한 실패가 시끄러운 실패가 된다.**

다만 **UPDATE 누락은 못 잡는다.** 옛날 값이 그대로 남아 있을 뿐 `NULL`이 아니기 때문이다. 3-3에서 본 "직전 사람 이름이 그대로 남는" 경우도 마찬가지로 `NOT NULL`을 통과한다. **이것도 2-3의 도구 카드와 같은 성질이다 — 이 제약이 무엇을 못 하는지 알고 써야 한다.**

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

**③ 관측으로 막기 — 실제 SQL을 본다.** `p6spy`나 `datasource-proxy`로 바인딩 값까지 찍어두면, 벌크 UPDATE의 SET 절에 감사 컬럼이 들어갔는지 **로그로 눈으로 확인**할 수 있다.

그리고 통합 테스트는 **H2가 아니라 Testcontainers**로 실제 DB에서 돌린다 — `ON UPDATE CURRENT_TIMESTAMP`나 트리거를 쓰기로 했다면(3-8) **벤더 동작이 곧 정답의 일부**여서, H2에서 통과한 테스트가 운영 DB의 동작을 전혀 보증하지 못하기 때문이다.

### 3-12. 증상에서 원인으로 — 역방향 인덱스

원리에서 증상을 유도하는 건 원리를 알면 누구나 한다. 실무에서 필요한 건 **증상에서 원인으로 거슬러 올라가는 것**이다.

| 증상 | 원인 | 확인 방법 | 처방 |
|---|---|---|---|
| **특정 배치가 건드린 행만** `updated_at`이 옛날 값 | 벌크/네이티브가 리스너 경로 우회 (1-5·1-7) | 그 배치의 쿼리에 `@Modifying`이 붙어 있음 | SET 절에 `updatedAt`·`updatedBy` 명시 (2-4) |
| 감사 컬럼이 **전부** `null` | `@EnableJpaAuditing` 누락 (1-1) | 어떤 경로로 저장해도 비어 있음 | 설정 클래스에 애노테이션 추가 |
| `updated_at`은 찍히는데 `updated_by`가 **엉뚱한 사람 이름**이거나 신규 행만 `null` | `AuditorAware` 미등록 또는 **배치 스레드에 SecurityContext 없음** (3-2·3-3) | 웹 요청 경로에서는 정상, 배치 경로에서만 발생 | 시스템 주체 폴백 (3-4) |
| 아무도 수정 안 한 행의 `updated_at`이 바뀜 | **의도치 않은 dirty 판정** (1-6) | 커밋 시 예상 못한 UPDATE 로그 | 컨버터·`BigDecimal` scale·컬렉션 재할당 점검 |
| `member`는 바뀌었는데 `member_AUD`에 리비전 없음 | **Envers도 벌크에서 빠짐** (3-7) | 벌크로 바꾼 행만 이력 없음 | 벌크 금지 또는 이력 직접 적재 (3-9) |
| 특정 엔티티만 감사 컬럼이 안 채워짐 | 그 엔티티가 `BaseEntity`를 상속하지 않음 | 클래스 선언 확인 | 상속 또는 `@EntityListeners` 직접 부착 |
| DB 콘솔로 고친 행에 이력이 없음 | 애플리케이션 레벨 Auditing의 **신뢰 경계 밖** (3-5) | 애플리케이션 로그에 해당 변경 없음 | DB 트리거 / 운영 SQL 통제 절차 |
| soft delete 대상이 진짜로 지워짐 | `deleteAllInBatch()`가 `@PreRemove`·`@SQLDelete`를 우회 (1-7) | 삭제 로그에 `delete from` 한 문장만 있음 | `deleteAll()` 또는 상태 변경 벌크로 교체 |

**세 개의 대표 트리거만 외워도 대부분 잡힌다.**

```text
"배치가 건드린 행만 수정시각이 옛날"      → 벌크가 리스너 경로를 우회했다
"배치 경로에서만 updated_by 가 이상하다"  → 배치 스레드에 SecurityContext 가 없다
"이력 테이블에 리비전이 안 생겼다"        → Envers 도 같은 경로를 탄다
```

---

## 4. 꼬리질문 대비 포인트

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

**① 신뢰 경계가 애플리케이션 안쪽이다.** 벌크·네이티브·`JdbcTemplate`·타 팀 배치·운영자의 수동 SQL은 잡지 못한다. **"우리 코드가 정상 경로로 바꾼 것만" 기록**된다. 감사는 보통 **"어떤 경로로든 이 데이터가 바뀌면"**을 요구한다. 게다가 애플리케이션 코드를 바꿀 수 있는 사람은 감사 기록을 만드는 코드도 바꿀 수 있으므로, **감시 카메라의 녹화 버튼이 감시 대상 방 안에 있는 구조**라는 점까지 말하면 신뢰 경계라는 개념을 실제로 이해한 것으로 읽힌다.

**② 이력이 아니라 마지막 상태만 남는다.** `@LastModifiedDate`는 최근 수정 시각 하나뿐이라 "3월 12일에 GOLD → SILVER"라는 **변경 내역**이 없다. 감사 요건은 대부분 내역을 요구하므로 **애초에 요건을 만족하지 못한다.**

**그래서 층을 나눠 답한다.** 이력 형태가 필요하면 **Envers**(`@Audited` → 리비전 테이블), 경계까지 넓혀야 하면 **DB 트리거 + 이력 테이블**. **그리고 반드시 덧붙일 것 — Envers도 벌크 연산에서는 똑같이 빠진다.** Envers는 **기록의 형태**를 바꾸지만 **기록의 경계**는 전혀 바꾸지 않는다. 이 구분을 말하는 것이 이 질문의 변별점이다.

### "`@LastModifiedBy`가 배치에서만 `null`입니다. 왜죠?" (시니어 변별 포인트)

**`AuditorAware`가 `SecurityContextHolder`에서 사용자를 꺼내는데, 그것은 `ThreadLocal` 기반이라 배치·스케줄러·`@Async`·메시지 컨슈머 스레드에는 인증 정보가 없기 때문이다.** 벌크 여부와 무관한 **별개의 구멍**이며, **변경 감지 경로로 정상 동작하는 배치에서도 발생**한다.

**질문의 전제를 한 번 교정하면 확실히 갈린다 — 항상 `null`이 되는 것은 아니다.** 스프링 데이터는 `AuditorAware`가 `Optional.empty()`를 반환하면 **필드에 `null`을 쓰는 것이 아니라 필드를 아예 건드리지 않는다**(`AuditingHandlerSupport.touchAuditor()`의 조기 리턴). 그래서 신규 INSERT면 `null`로 남지만, **기존 행 UPDATE면 직전에 들어 있던 사람 이름이 그대로 유지된 채 새 시각과 함께 다시 저장된다.** 즉 그 행은 "그 사람이 방금 이걸 바꿨다"고 거짓 진술을 하게 된다. **비어 있는 기록보다 틀린 기록이 나쁘다.**

**처방**: ① `AuditorAware`에 **시스템 주체 폴백**을 넣어 `Optional.empty()` 대신 `"SYSTEM"`·`"BATCH_DORMANT"` 같은 **조사 가능한 값**을 반환한다 — `null`은 "기록 실패"와 "시스템 변경"을 구분하지 못한다. ② 배치 진입점에서 **실행 주체를 `ThreadLocal`에 명시적으로 심고 `finally`에서 지운다**(스레드 풀 재사용 때문에 정리가 필수). ③ 웹 요청에서 분기한 비동기 작업에 인증을 전달해야 한다면 `DelegatingSecurityContext...` 계열 래퍼를 쓰되, **스레드 풀에서 컨텍스트가 다음 작업으로 새는 위험**을 함께 인지한다.

### "`hibernate.jdbc.batch_size`를 올리면 이 문제가 해결되나요?"

**아니다. 문제의 종류가 다르다.** `batch_size`는 **여러 개의 SQL 문장을 JDBC 레벨에서 묶어 전송해 왕복 횟수를 줄이는 성능 옵션**(기본값 `0`, 즉 꺼짐)이지 값을 채우는 기능이 아니다. 게다가 **이 벌크 UPDATE는 이미 한 문장**이라 묶을 대상 자체가 없다. 값이 채워지지 않는 원인은 **리스너 경로를 안 탄 것**이므로, 처방은 **SET 절에 직접 쓰거나 변경 감지 경로로 되돌리는 것** 둘 중 하나다.

**다만 `batch_size`가 의미를 갖는 지점이 하나 있다** — 감사 컬럼 때문에 **벌크를 포기하고 청크 단위 변경 감지**로 바꾸면, 그때는 UPDATE 문장이 실제로 여러 개가 되므로 이 옵션이 제 일을 한다. **틀린 도구가 아니라 틀린 자리에 놓였던 도구**다.

### "이 사고를 배포 전에 잡으려면 어떻게 하나요?" (가산점 포인트)

**예외가 안 나는 사고이므로 단정으로 고정하는 수밖에 없다. 세 겹으로 간다.**

1. **테스트로 단정** — `@Modifying` 쿼리를 실행한 뒤 **`em.clear()`로 1차 캐시를 비우고** 재조회해 `updatedAt`과 `updatedBy`를 **둘 다** 검증한다. 비우지 않으면 벌크가 우회한 옛 객체를 보게 되어 **테스트가 아무것도 증명하지 못한다.** 시각은 고정한다 — 내 코드가 `now`를 만드는 벌크 경로는 `Clock.fixed`로, 스프링 데이터가 만드는 리스너 경로는 `@EnableJpaAuditing(dateTimeProviderRef = ...)`로 손잡이가 다르다.
2. **스키마로 승격** — 감사 컬럼을 `NOT NULL`로 두면 **INSERT 누락이 즉시 실패**한다. 단 **UPDATE 누락은 못 잡는다**(옛 값이 남을 뿐 `NULL`이 아니므로). 도구의 한계를 알고 쓴다.
3. **구조 룰로 회귀 차단** — ArchUnit으로 **`@Modifying`이 붙은 메서드가 감사 대상 엔티티를 건드리는지** 검사한다. 테스트 하나는 그 쿼리 하나만 지키지만, 룰은 **다음에 추가될 쿼리까지** 지킨다.

여기에 **p6spy로 실제 SQL을 관측**하고 **Testcontainers로 실제 DB에서** 돌리면(트리거나 `ON UPDATE`를 쓰기로 했다면 벤더 동작이 곧 정답의 일부다) 완성된다.

### "네이티브 쿼리나 `JdbcTemplate`도 같은 문제가 있나요? 판단 기준을 하나로 말한다면?" (가산점 포인트)

**있다. 그리고 기준은 하나다** — **"영속성 컨텍스트가 이 엔티티를 놓고 INSERT/UPDATE를 판정했는가."** 판정이 있으면 리스너가 호출되고, 없으면 안 된다. 벌크 JPQL·네이티브 쿼리·`JdbcTemplate`·MyBatis·DB 콘솔은 전부 판정이 없다.

**같은 이유로 함께 빠지는 것들**: `@Version` 증가, `cascade`/`orphanRemoval`, soft delete의 `@SQLDelete`, `@PreRemove` 같은 다른 생명주기 콜백, 2차 캐시 무효화, Envers 리비전. **한 문장으로 묶으면 "JPA를 우회한 변경은 JPA가 모른다."** 이렇게 답하면 지식이 조각이 아니라 원리로 들린다 → [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md), [Soft delete와 유니크 제약](26-soft-delete-unique-and-associations.md).

**그리고 여기서 반대 방향의 도구도 하나 알고 있으면 좋다** — **DB의 `ON UPDATE CURRENT_TIMESTAMP`나 트리거는 정확히 이 경계를 넘는 유일한 수단**이다. 대신 **"누가"는 못 채우고, 벤더에 묶이며, 로직이 DDL에만 있어 코드 리뷰에 안 보인다.** 얻는 것과 포기하는 것이 정확히 반대인 도구다.

---

## 한 줄 요약

**JPA Auditing은 마법이 아니라 `@PrePersist`/`@PreUpdate` 콜백에 얹힌 코드이고, 그 콜백은 "영속성 컨텍스트가 이 엔티티를 INSERT/UPDATE 대상으로 판정한 순간"에만 발생한다** — 그래서 판정을 거치지 않는 **벌크 JPQL·네이티브 쿼리·`JdbcTemplate`·수동 SQL에서는 예외도 경고도 실패 카운트도 없이 조용히 빠지고**, 배치는 "10만 건 성공"으로 정상 종료한다(1장). 처방은 **벌크를 유지하면 SET 절에 `m.updatedAt = :now, m.updatedBy = :actor`를 직접 쓰고**(시각은 밖에서 주입해 배치 전체가 같은 값을 공유하게, 주체는 `'BATCH_DORMANT'`처럼 사람 계정과 구분되게), **건수가 감당되면 엔티티를 로드해 변경 감지로 되돌리는 것**(대가: 왕복 N번 + 컨텍스트 누적)이다(2-4·2-6). 여기서 **`hibernate.jdbc.batch_size`는 이 문제와 교집합이 없다** — **문장이 여러 개일 때 왕복을 줄이는 옵션**이지 값을 채우지 않으며 **이 벌크는 이미 한 문장**이다. 다만 **청크 단위 변경 감지로 설계를 바꾸면 그때는 제 일을 한다** — 틀린 도구가 아니라 **틀린 자리에 놓였던 도구**이고, 그래서 **모든 도구는 "해결하는 것"과 "해결하지 못하는 것"을 세트로 외워야 한다**(2-1~2-3). 시각만 고치면 절반이다 — **`@LastModifiedBy`도 같은 원인으로 빠지고**, 그와 별개로 `AuditorAware`는 `SecurityContextHolder`(ThreadLocal)에 의존하므로 **배치·스케줄러·`@Async` 스레드에서는 벌크가 아니어도 이미 주체를 공급하지 못하며**, 이때 스프링 데이터는 필드에 `null`을 쓰는 게 아니라 **필드를 건드리지 않아 직전 사람 이름이 새 시각과 함께 다시 저장된다** — 비어 있는 기록보다 나쁜 **틀린 기록**이므로 **시스템 주체 폴백을 명시적으로 넣어야 한다**(3-1~3-4). 마지막으로 **애플리케이션 레벨 Auditing은 신뢰 경계가 애플리케이션 안쪽이고 마지막 상태만 남긴다** — DB 콘솔에서 직접 고친 변경은 흔적이 없고 애플리케이션 코드를 고칠 수 있는 사람은 감사 기록도 고칠 수 있으니, 이력이 필요하면 **Envers**, 경계를 넘으려면 **DB 트리거/`ON UPDATE CURRENT_TIMESTAMP`**(대신 "누가"를 잃고 벤더에 묶인다)로 내리되, **Envers도 벌크에서는 똑같이 빠진다**는 것을 반드시 함께 말해야 한다 — Envers가 바꾸는 것은 **기록의 형태**이지 **기록의 경계**가 아니다(3-5~3-8). 그래서 실무 규칙은 **감사 대상 엔티티에 벌크 금지**(ArchUnit 룰)이거나 **벌크와 이력 적재를 한 트랜잭션에 묶고 건수 일치를 단정**하는 것이며, 이 모든 규칙은 **`em.clear()` 이후 재조회해 시각과 주체를 둘 다 단정하는 테스트**로 고정하기 전까지는 **다음 사람이 벌크 쿼리를 하나 더 추가하는 순간 조용히 무너진다.**
