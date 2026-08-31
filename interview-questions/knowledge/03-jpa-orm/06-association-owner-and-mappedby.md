# 연관관계의 주인과 mappedBy — 참조는 둘, FK는 하나

> 핵심 관전 포인트: 객체 세계에서 양방향 연관은 **참조가 두 개**지만, 테이블 세계에는 **FK가 하나**뿐이다. 이 비대칭 때문에 두 참조가 어긋났을 때 어느 쪽을 따를지 정해야 하고, 그 기준이 **연관관계의 주인**이다. 주인은 **FK를 가진 쪽**이고 다대일 관계에서는 항상 **다(N)쪽**이다. `mappedBy`는 "나는 주인이 아니고 상대의 이 필드가 FK를 관리한다"는 **읽기 전용 선언**이며, 그래서 `team.getMembers().add(member)`만 하고 커밋하면 FK는 `null`로 남는다. 여기서 한 층 더 들어가면 — **연관관계 편의 메서드가 필요한 진짜 이유는 DB가 아니라 1차 캐시다.** 주인만 세팅하면 DB의 FK는 정확히 갱신되지만, 같은 트랜잭션에서 이미 로딩된 컬렉션은 갱신 전 상태로 남아 "DB는 맞는데 화면은 틀린" 현상이 난다. 그리고 양방향을 둘지 말지의 판단 축은 "조회가 편한가"가 아니라 **"생명주기를 공유하는가"** 다.

---

## 0. 질문 + 의도

**질문**: "연관관계의 주인(owner)이란? `mappedBy`는 왜 필요한가요?"

**출제 의도**: FK 갱신이 "왜 안 되는지" 헤매는 신입 단골 이슈. 이걸 명확히 설명하면
JPA 매핑을 눈감고도 다루는 수준임을 시사한다.

**함정**: 정의를 맞히는 것으로는 부족하다. 이 질문의 변별력은 두 곳에 있다 —
① **왜 주인이라는 개념이 애초에 필요한가**(설계 의도) ② **양방향을 쓸지 말지를 무엇으로
판단하는가**(설계 판단). "보통 단방향으로 씁니다"에서 멈추면 근거 없는 관례로 들린다.

---

## 1. 왜 주인이 필요한가 — 개수가 안 맞는다

먼저 두 세계의 모양이 다르다는 것을 보자.

**객체 세계** — 양방향으로 매핑하면 참조가 **두 개** 생긴다.

```java
team.getMembers()   // 참조 ①: 팀 → 멤버들
member.getTeam()    // 참조 ②: 멤버 → 팀
```

**테이블 세계** — 관계를 표현하는 것은 **FK 하나**뿐이다.

```
member 테이블:  id | name | team_id   ← 이 컬럼 하나가 관계의 전부
team   테이블:  id | name
```

참조가 둘인데 저장할 자리는 하나다. 그러면 이런 상황이 생긴다.

```java
member.setTeam(teamA);              // 참조 ②는 A팀
teamB.getMembers().add(member);     // 참조 ①은 B팀
// team_id 컬럼에 무엇을 넣어야 하나?
```

**둘 중 어느 쪽을 진실로 볼지 정하지 않으면 이 상황이 결정 불가능하다.** JPA는 이
문제를 "한쪽만 FK를 관리한다"는 규칙으로 푼다. 그 한쪽이 **연관관계의 주인(owner)** 이고,
나머지 한쪽은 **읽기 전용**이 된다. 즉 주인 개념은 편의 장치가 아니라 **모호성 제거
장치**다.

> 면접에서 이 답을 만들 때: "객체는 참조가 둘인데 테이블은 FK가 하나라서, 둘이
> 어긋났을 때 따를 기준이 필요합니다. 주인이 그 기준입니다." — 여기까지 말하면
> 정의를 외운 게 아니라 이유를 이해한 것으로 들린다.

---

## 2. 주인은 누구인가

### 2-1. 규칙: FK를 가진 쪽

**FK 컬럼이 있는 테이블에 매핑된 엔티티가 주인**이다. 다대일 관계에서 FK는 항상
다(N)쪽 테이블에 있으므로 결론이 하나로 정해진다.

```java
class Team {
    @Id @GeneratedValue
    private Long id;

    @OneToMany(mappedBy = "team")          // ← 주인이 아니다. 읽기 전용
    private List<Member> members = new ArrayList<>();
}

class Member {
    @Id @GeneratedValue
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)     // ← 주인
    @JoinColumn(name = "team_id")          //    FK 컬럼을 직접 지정
    private Team team;
}
```

- **`@ManyToOne`이 붙은 쪽이 주인**, `@OneToMany`가 `mappedBy`를 갖는다. 예외가 없다.
- `mappedBy = "team"`의 `"team"`은 **주인 엔티티의 필드 이름**이다. "내 반대편은
  `Member.team` 필드이고, FK 관리는 그쪽이 한다"는 뜻이다.
- `@ManyToOne`의 기본 로딩 전략은 **EAGER**이므로 `fetch = LAZY`를 손으로 붙여야 한다.
  이유는 [EAGER vs LAZY 기본 전략](03-eager-vs-lazy-fetch-strategy.md)에 있다.

### 2-2. 일대일은 설계 선택이다

1:1은 FK를 어느 테이블에 둬도 되므로 **주인이 규칙으로 정해지지 않는다.**

- 주 테이블(예: `member`)에 FK를 두면 → 조회가 잦은 쪽에서 조인 없이 접근할 수 있다.
- 대상 테이블(예: `locker`)에 FK를 두면 → 나중에 1:N으로 바뀔 때 스키마 변경이 작다.

선택의 대가가 하나 더 있다: **주인이 아닌 쪽의 지연 로딩이 걸리지 않는다.** FK가 상대
테이블에 있으면 연관이 존재하는지(`null`인지) 알 수 없어 프록시를 만들 수 없기
때문이다. 자세한 내용은 [EAGER vs LAZY](03-eager-vs-lazy-fetch-strategy.md) 문서에 있다.

---

## 3. `mappedBy`가 하는 일 — 읽기 전용 선언

`mappedBy`는 "이 필드는 관계를 **읽기만** 한다"는 표시다. 그래서 다음 코드는 아무
일도 하지 않는다.

```java
// ❌ BEFORE — FK가 갱신되지 않는다
@Transactional
public void joinTeam(Long teamId, Long memberId) {
    Team team = teamRepository.findById(teamId).orElseThrow();
    Member member = memberRepository.findById(memberId).orElseThrow();

    team.getMembers().add(member);   // 주인이 아닌 쪽만 변경
    // 커밋
}
```

```sql
-- 나가는 쿼리: 없다. UPDATE가 아예 발생하지 않는다.
-- member.team_id 는 여전히 null
```

**예외도 경고도 없다.** JPA는 `mappedBy`가 붙은 컬렉션의 변경을 **flush 대상에서
제외**하기 때문이다. 신입이 반나절 헤매는 대표 지점이 여기다.

```java
// ✅ AFTER — 주인 쪽을 세팅한다
@Transactional
public void joinTeam(Long teamId, Long memberId) {
    Team team = teamRepository.findById(teamId).orElseThrow();
    Member member = memberRepository.findById(memberId).orElseThrow();

    member.setTeam(team);   // 주인 쪽 → FK가 갱신된다
}
```

```sql
update member set team_id = 1 where id = 10;
```

### `mappedBy`를 빼면 어떻게 되는가

`@OneToMany`만 두고 `mappedBy`도 `@JoinColumn`도 없으면, JPA는 이 관계를
**조인 테이블(`team_member` 같은 중간 테이블)** 로 매핑한다. 즉 관계를 표현할 자리가
없으니 새로 만들어버린다. 의도한 스키마와 달라지므로, 양방향을 만들 때 `mappedBy`를
빼먹으면 **테이블이 하나 더 생기는** 증상으로 드러난다.

`@OneToMany` + `@JoinColumn`(단방향, `mappedBy` 없음)도 가능하다. FK는 자식 테이블에
생기지만 **관리 주체가 부모**가 된다. 이 조합의 대가는 쿼리 수다.

```sql
-- 자식을 INSERT할 때 부모가 FK를 아직 모르므로
insert into member (id, name, team_id) values (?, ?, null);
-- 부모 컬렉션 처리 단계에서 FK를 채우는 UPDATE가 별도로 나간다
update member set team_id = ? where id = ?;
```

INSERT 하나로 끝날 일이 INSERT + UPDATE가 된다. 그래서 실무에서는 이 조합보다
**다대일 단방향** 또는 **양방향 + `mappedBy`** 를 쓴다.

> 확인 범위: 조인 테이블 생성과 추가 UPDATE는 JPA/Hibernate의 오래된 표준 동작이다.
> 다만 구체적인 쿼리 순서와 개수는 배치 설정·id 생성 전략에 따라 달라질 수 있으므로,
> 실제 프로젝트에서는 쿼리 로그로 확인하는 것을 권한다.

---

## 4. 편의 메서드의 진짜 이유는 1차 캐시다

여기가 이 주제에서 가장 자주 잘못 설명되는 부분이다.

흔한 설명은 "양쪽 다 세팅해야 DB에 반영된다"인데, **틀렸다.** 주인만 세팅해도 DB는
정확히 갱신된다. 그럼 왜 양쪽을 세팅하라는 것일까?

### 4-1. 증상 재현

```java
@Transactional
public void joinTeamAndCount(Long teamId, Long memberId) {
    Team team = teamRepository.findById(teamId).orElseThrow();
    int before = team.getMembers().size();   // ① 여기서 컬렉션이 로딩된다 (예: 3)

    Member member = memberRepository.findById(memberId).orElseThrow();
    member.setTeam(team);                    // ② 주인 세팅 → FK는 갱신된다

    int after = team.getMembers().size();    // ③ 몇이 나올까?
}
```

`after`는 **여전히 3**이다. `4`가 아니다.

이유는 ①에서 이미 벌어졌다. `team.getMembers()`를 호출한 순간 컬렉션이 DB에서
로딩되어 **영속성 컨텍스트(1차 캐시)에 그 상태로 올라갔다.** ②에서 바꾼 것은
`member.team` 필드이고, 이미 메모리에 올라온 `team.members` 리스트에는 아무도
손대지 않았다. 그리고 같은 트랜잭션 안에서 `teamRepository.findById(teamId)`를 다시
불러도 **1차 캐시가 같은 인스턴스를 돌려주므로** 컬렉션도 그대로다.

즉 **DB는 맞고 메모리는 틀린 상태**가 된다. 이 트랜잭션 안에서 그 컬렉션을 근거로
계산하거나 응답을 만들면 결과가 어긋난다. "DB를 직접 조회하면 맞는데 화면에는 안
보인다"는 문의가 여기서 나온다.

### 4-2. 처방 — 연관관계 편의 메서드

```java
// ✅ 주인 쪽 엔티티에 두는 것이 관례
public class Member {
    public void setTeam(Team team) {
        // 기존 팀에서 자신을 제거 (팀 이동 시 필수)
        if (this.team != null) {
            this.team.getMembers().remove(this);
        }
        this.team = team;                    // ① FK를 관리하는 쪽
        if (team != null) {
            team.getMembers().add(this);     // ② 객체 그래프 일관성
        }
    }
}
```

①이 **DB를 위한 코드**, ②가 **메모리를 위한 코드**다. 둘의 목적이 다르다는 것을
구분해서 말하면 이 개념을 이해한 것으로 들린다.

편의 메서드를 **양쪽 엔티티에 다 두면 안 된다.** `member.setTeam(team)`과
`team.addMember(member)`가 서로를 호출하면 무한 재귀에 빠지거나 컬렉션에 중복이
들어간다. **한쪽에만 두고 팀 내에서 규칙으로 정하는 것**이 관례다.

### 4-3. 함정: `equals`/`hashCode`와 컬렉션 조작

편의 메서드 안의 `remove(this)`는 컬렉션에서 자기 자신을 찾아야 한다. 이때 엔티티의
`equals`/`hashCode` 구현이 문제가 된다.

- id 기준으로 구현하면 → **아직 저장되지 않은 엔티티는 id가 `null`** 이라 서로 같다고
  판정되거나 찾지 못한다.
- 기본 구현(참조 동일성)을 쓰면 → 같은 트랜잭션 안에서는 1차 캐시가 동일 인스턴스를
  보장하므로 대체로 동작한다. 하지만 트랜잭션을 넘나들면 깨진다.

실무 해법은 **비즈니스 키(자연키)로 `equals`/`hashCode`를 구현**하거나, 컬렉션을
`Set` 대신 `List`로 두고 참조 동일성에 의존하는 것이다. 이 주제는 별도 문항
(`equals`/`hashCode` 구현)에서 더 깊이 다룬다. (가산점 포인트)

---

## 5. 양방향으로 둘지 단방향으로 둘지

### 5-1. 단방향이 기본값이어야 하는 이유

양방향에는 유지 비용이 붙는다.

- **편의 메서드를 계속 관리해야 한다.** 새 연관이 늘어날 때마다, 팀 이동 같은 케이스가
  생길 때마다 손이 간다.
- **무한 순환 참조**가 생긴다. JSON 직렬화(`Team → members → team → members …`),
  `toString()`, `equals()`에서 스택 오버플로가 난다. `@JsonIgnore`나 DTO 변환으로
  막아야 하는데, 그 자체가 양방향의 대가다.

```java
// ❌ BEFORE — 엔티티를 그대로 응답으로 내보내면 순환 참조로 터진다
@GetMapping("/teams/{id}")
public Team getTeam(@PathVariable Long id) {
    return teamRepository.findById(id).orElseThrow();
}

// ✅ AFTER — DTO로 끊는다
@GetMapping("/teams/{id}")
public TeamResponse getTeam(@PathVariable Long id) {
    return TeamResponse.from(teamRepository.findById(id).orElseThrow());
}
```

- **테스트에서 양쪽 정합성을 신경 써야 한다.** "FK는 맞는데 컬렉션이 안 맞는" 상태가
  가능하므로 검증 지점이 늘어난다.

그리고 결정적으로, **양방향이 주는 이점 대부분은 리포지토리 쿼리로 대체된다.**

```java
// 팀 상세 화면의 소속 멤버 목록 — 양방향 없이도 충분하다
List<Member> members = memberRepository.findByTeamId(teamId);
```

즉 **"조회가 편해서" 양방향을 두는 것은 근거가 약하다.** 조회는 쿼리로 해결된다.

### 5-2. 그럼 언제 양방향인가 — 생명주기를 공유할 때

판단 축은 이것이다. **부모를 저장·삭제할 때 자식도 함께 저장·삭제되어야 하는가?**

- **그렇다** → 같은 Aggregate(하나의 일관성 단위)다. 이때는 `cascade`와
  `orphanRemoval`이 의미를 갖고, 그것들을 쓰려면 부모가 컬렉션을 들고 있어야 한다.
  → **양방향(또는 최소한 부모 → 자식 컬렉션)이 정당하다.**
  - 예: `Order` ↔ `OrderItem`. 주문 항목은 주문 없이 존재할 이유가 없고, 주문을
    지우면 항목도 지워져야 한다.
- **아니다** → 각자 독립적인 생명주기다. 조회 요구가 있어도 쿼리로 푼다.
  → **단방향.**
  - 예: `Member` → `Team`. 멤버를 지운다고 팀을 지우지 않고, 팀을 지운다고 멤버를
    지우지 않는다.

> 면접에서 이렇게 답하면 근거가 선다: "기본은 단방향으로 둡니다. 양방향은 편의
> 메서드 유지·순환 참조 대응 같은 비용이 붙는데, 조회 요구는 대부분 리포지토리
> 쿼리로 해결되기 때문입니다. 양방향을 여는 기준은 조회 편의가 아니라 **생명주기를
> 공유하는지** — 부모를 지울 때 자식도 지워져야 하는 관계, 즉 cascade가 의미를 갖는
> Aggregate 경계 안에서만 양방향을 둡니다."

---

## 6. 꼬리질문 대비 포인트

### "`team.getMembers().add(member)`만 했는데 왜 FK가 안 바뀌나요?"

`@OneToMany(mappedBy = ...)`가 붙은 필드는 **읽기 전용**이라 flush 대상에서 제외된다.
FK를 관리하는 것은 주인(`Member.team`)이므로 `member.setTeam(team)`을 호출해야 UPDATE가
나간다. 예외나 경고가 없다는 점이 이 버그의 특징이다.

### "그럼 주인이 아닌 쪽은 왜 매핑하나요? 없어도 되는 거 아닌가요?"

없어도 된다 — 그게 단방향이다. 주인이 아닌 쪽을 매핑하는 이유는 두 가지다:
① **객체 그래프를 따라가는 코드가 자연스러워진다**(`order.getItems()`)
② **`cascade`/`orphanRemoval`을 걸 수 있다** — 부모가 자식 컬렉션을 들고 있어야
생명주기를 함께 관리할 수 있다. 이 두 이유가 없으면 매핑하지 않는 것이 낫다.

### "양쪽 다 FK를 관리하게 하면 안 되나요?" (설계 의도)

두 참조가 어긋났을 때 어느 쪽을 따를지 결정할 수 없다. 게다가 양쪽이 각자 갱신을
시도하면 같은 컬럼에 UPDATE가 중복으로 나가고, 순서에 따라 결과가 달라지는
비결정적 동작이 된다. JPA는 이를 "주인 한쪽만 쓴다"로 원천 차단했다.

### "편의 메서드를 안 쓰고 주인만 세팅하면 DB는 맞잖아요. 그래도 문제인가요?" (시니어 변별 포인트)

DB는 맞다. 문제는 **같은 트랜잭션 안의 메모리 상태**다. 컬렉션이 이미 로딩되어
1차 캐시에 올라와 있으면 그 리스트는 갱신 전 상태로 남고, 1차 캐시는 같은 트랜잭션에서
같은 인스턴스를 돌려주므로 다시 조회해도 고쳐지지 않는다. 그 컬렉션을 근거로 개수를
세거나 응답을 만들면 결과가 틀린다. **편의 메서드는 영속화를 위한 장치가 아니라 객체
그래프 일관성을 위한 장치**라고 말할 수 있으면 이 개념을 정확히 이해한 것이다.

### "그럼 편의 메서드 없이도 안전하게 만드는 방법이 있나요?" (시니어 변별 포인트)

두 가지 방향이 있다.
① **연관 변경을 한 곳으로 모은다** — 부모의 도메인 메서드(`order.addItem(item)`)만
공개하고 자식의 `setOrder`는 패키지 전용으로 닫는다. 진입점이 하나면 양쪽 세팅을
빠뜨릴 수 없다.
② **애초에 양방향을 두지 않는다** — 컬렉션이 없으면 불일치할 대상도 없다. 단방향 +
쿼리 조합이 가장 안전한 구성인 이유가 이것이다.
즉 "편의 메서드를 잘 쓰자"보다 **"불일치가 가능한 구조를 만들지 말자"** 가 상위 처방이다.

### "다대다(`@ManyToMany`)는 주인을 어떻게 정하나요?"

`@ManyToMany`도 한쪽에 `mappedBy`를 두어 주인을 정한다. 다만 실무에서는
`@ManyToMany` 자체를 쓰지 않는 편이 정석이다 — 중간 테이블에 컬럼(가입 일시, 상태
등)을 추가할 수 없고, 컬렉션 변경 시 중간 테이블 행이 전부 삭제·재삽입되는 동작이
있기 때문이다. **중간 엔티티를 명시적으로 만들어 `@ManyToOne` 두 개로 푸는 것**이
권장 구성이며, 그러면 주인 문제도 자연히 사라진다. (가산점 포인트)

---

## 한 줄 요약

객체에는 참조가 둘, 테이블에는 FK가 하나 — 그 비대칭에서 "어느 쪽을 진실로 볼지"를
정하는 것이 연관관계의 주인이고, `mappedBy`는 "나는 읽기만 한다"는 선언이다. 주인만
세팅하면 DB는 맞지만 1차 캐시의 컬렉션은 어긋나므로 편의 메서드가 필요하며, 양방향을
열지 말지는 조회 편의가 아니라 **생명주기를 공유하는지**로 판단한다.
