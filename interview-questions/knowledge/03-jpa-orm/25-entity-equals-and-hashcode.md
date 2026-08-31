# 엔티티의 `equals`/`hashCode` — id는 저장돼야 생기고, 클래스는 프록시에 가려진다

> 핵심 관전 포인트: **`Set`에 넣은 엔티티가 `save()` 후 사라지는 이유는 `hashCode`가 `id`로 만들어졌고 그 `id`가 저장 시점에 `null` → `1`로 바뀌기 때문이다.** `HashSet`은 **넣을 때의 해시로 정한 버킷**을 기억하는데, 해시가 바뀌면 `contains()`는 **엉뚱한 버킷을 뒤지고 `equals`까지 가보지도 못한 채** `false`를 돌려준다. 여기에 JPA 고유의 두 번째 함정이 겹친다 — **지연 로딩이 만든 프록시는 `Member`가 아니라 `Member$HibernateProxy`라서 IDE가 생성해 주는 `getClass() != o.getClass()` 비교가 깨지고**, 프록시의 **필드를 직접 읽으면 비어 있어 `null`**이 나온다. 그래서 정석 구현은 넷이다 — **① `getClass()`가 아니라 `instanceof`로 타입 비교 ② 상대의 `id`는 `other.id`가 아니라 `other.getId()`로 ③ `id != null && id.equals(...)`로 미저장끼리는 절대 같다고 하지 않기 ④ `hashCode()`는 `id`와 무관한 상수(`return 31;` 또는 `getClass().hashCode()`)**. `hashCode` 상수 반환이 이상해 보이지만 규약이 요구하는 것은 **"같은 객체는 항상 같은 값"** 하나뿐이고, 버킷이 하나가 되는 대가는 **엔티티를 수천 개씩 `Set`에 넣는 일이 거의 없으므로** 감수할 만하다. 그리고 진짜 정답은 그 위에 있다 — **엔티티를 `Set`·`Map` 키로 쓰지 않는 것**, 그리고 **엔티티에 Lombok `@Data`를 붙이지 않는 것**이다. 후자는 모든 필드 기반 `equals`를 만들어 이 사고를 그대로 재현하는 데다, **`equals` 한 번이 지연 로딩 연관을 전부 초기화해 쿼리 폭탄**이 된다.

---

## 0. 질문 + 의도

**질문**: "JPA 엔티티의 `equals`/`hashCode`는 어떻게 구현해야 하나요? 프록시와 id 생성 시점 문제는?"

실제로 이어진 꼬리질문:
"`Set<Member>`에 넣은 미저장 엔티티를 `save()` 한 뒤 `contains(member)`가 `false`가 된다. 왜인가?"
"`name`·`email`·`phone`을 사용자가 마이페이지에서 전부 바꿀 수 있다면? **변하지 않는 자연 키가 아예 없는 엔티티**라면 무엇을 기준으로 하나?"
"그 조건에서 `hashCode()`는 무엇을 반환해야 규약을 지키나? 힌트 — **'항상 같은 값을 유지한다'만 만족하면 된다.**"
"`equals`에서 `getClass() != o.getClass()` 비교가 깨지는 상황은?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**프록시 클래스 비교, id가 저장 전엔 null인 시점 문제로 Set/Map에서 엔티티가 사라지는 미묘한 버그. 1장의 equals 규약이 JPA라는 구체 환경에서 어떻게 꼬이는지 아는 응용 깊이.**" 즉 이 문항은 `equals`/`hashCode` 규약을 외웠는지 묻는 것이 아니다. **규약은 이미 안다고 전제하고, 그것을 JPA라는 구체적인 환경에 놓았을 때 두 가지 새 변수(프록시, 나중에 생기는 식별자)가 어떻게 규약을 무너뜨리는지**를 본다. 1장 `equals`/`hashCode` 문항의 **응용편**이며, 같은 장의 `getReferenceById`(프록시) 문항과 한 뿌리다.

**이 문서의 성격**: 후보자는 **원인을 즉답**했고("`id`가 `null`일 때와 저장 후의 `hashCode`가 달라져서"), `getClass()` 비교가 프록시에서 깨진다는 것도 단서 한 마디에 바로 연결했다. 그래서 §1은 짧게 확인만 하고, 지면 대부분은 **막혔던 두 곳**에 쓴다 — **엔티티와 값 객체(VO)의 성질 차이**(§3), **`hashCode` 상수 반환이라는 정석**(§5). 그 사이에 잘못된 구현 3종을 올바른 최종형으로 고쳐 나가는 과정(§4)을 놓고, 마지막에 전략 선택 기준(§6)·`Set` 회피(§7)·Lombok(§8)·안전망(§9)을 얹는다.

---

## 1. 왜 사라지는가 — `HashSet`의 버킷을 그림처럼 따라가기

먼저 사고 코드부터 본다.

```java
// before — 어디에도 이상한 곳이 없어 보인다
@Entity
public class Member {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String name;

    @Override public boolean equals(Object o) { /* id 비교 */ }
    @Override public int hashCode() { return Objects.hash(id); }   // ← 여기가 폭탄
}
```

```java
Set<Member> members = new HashSet<>();
Member member = new Member("주덕");

members.add(member);           // 아직 저장 전 — id는 null
memberRepository.save(member); // 저장 — DB가 id에 1을 채워 준다

members.contains(member);      // false  ← 분명 그 객체인데 없다고 한다
members.size();                // 1      ← 그런데 크기는 1이다
members.iterator().next() == member;  // true  ← 꺼내 보면 그 객체가 맞다
members.remove(member);        // false  ← 지우지도 못한다
```

**"안에 있는데 없다고 하고, 지울 수도 없다."** 이 조합이 이 버그의 지문이다.

### 1-1. `HashSet`이 실제로 하는 일 — 5단계

`HashSet`은 내부적으로 `HashMap`이고, `HashMap`은 **배열(버킷) + 각 칸의 연결 리스트**다. 값을 찾는 순서가 정해져 있다.

```
[1] add(member)
    member.hashCode()  →  31 * 1 + null → 31  (id가 null이므로)
    버킷 번호 = 31 & (16-1) = 15
    → 15번 칸에 저장한다. 이때 계산한 해시 31을 노드에 함께 적어 둔다.

    버킷:  [0][1][2] ... [14][15: (hash=31, member)]

[2] save(member)
    INSERT 실행 → DB가 id = 1 을 만들어 준다
    Hibernate가 리플렉션으로 member.id 필드에 1을 써넣는다
    ★ 이 순간 member 객체의 hashCode()가 바뀐다. 그런데 Set은 그 사실을 모른다.
      Set에게 "얘 해시 바뀌었어"라고 알려 줄 방법이 애초에 없다.

[3] contains(member)
    member.hashCode()  →  31 * 1 + 1 → 32  (id가 1이 되었으므로)
    버킷 번호 = 32 & (16-1) = 0
    → 0번 칸을 뒤진다

[4] 0번 칸은 비어 있다
    → equals()를 호출할 후보조차 없다.  ★ equals는 아예 실행되지 않는다.

[5] return false
```

**여기서 가장 중요한 사실**: 이 버그는 `equals`가 잘못돼서 생긴 게 아니다. **`equals`가 호출되기도 전에 끝난다.** `hashCode`가 바뀌는 순간 그 객체는 컬렉션 안에서 **주소를 잃어버린 상태**가 된다. 상자에 물건을 넣어 두고 라벨을 바꿔 붙인 것과 같다 — 물건은 그 상자에 그대로 있는데(그래서 `size()`는 1이고 순회하면 나온다), 라벨을 보고 찾아가면 다른 상자로 간다.

> **`HashMap`이 해시를 노드에 저장해 둔다**는 점도 함께 기억할 만하다. 저장 시점의 해시는 노드에 박제되고, 조회 시점의 해시는 **키 객체에서 다시 계산**된다. 그래서 리사이즈가 일어나도 둘은 영원히 어긋난 채로 남는다. **한 번 어긋나면 스스로 복구되지 않는다.**

### 1-2. 이 버그가 유독 늦게 발견되는 이유

- **테스트에서는 대개 안 걸린다.** 테스트는 보통 `save()`부터 하고 그 결과를 컬렉션에 담는다. `id`가 이미 있는 상태로 넣으면 해시가 바뀔 일이 없다. **"저장 전에 컬렉션에 넣는" 순서가 되어야만** 재현된다.
- **증상이 원인에서 멀다.** 실제로는 "중복 등록이 안 걸러진다", "장바구니에서 삭제가 안 된다", "캐시 적중률이 0%다" 같은 **엉뚱한 얼굴**로 나타난다.
- **`remove`가 실패하므로 메모리에서 안 빠진다.** 장시간 유지되는 컬렉션(세션, 로컬 캐시)이라면 누수로 이어진다.

---

## 2. 규약은 그대로다 — JPA가 추가하는 변수가 두 개일 뿐

`equals`/`hashCode` 규약 자체는 1장에서 다룬 그대로다(→ 1장 `equals`/`hashCode` 동시 재정의, [BigDecimal의 equals vs compareTo](../01-java-kotlin/32-bigdecimal-equals-compareto.md)에서 "같다의 기준이 하나가 아니다"라는 같은 주제를 다룬다). 여기서 필요한 것은 **딱 두 줄**이다.

- `a.equals(b)`가 `true`면 `a.hashCode() == b.hashCode()`여야 한다.
- **같은 객체에 대해 `hashCode()`는 (equals 비교에 쓰는 정보가 안 바뀌는 한) 항상 같은 값을 돌려줘야 한다.**

JPA는 이 두 줄에 **새 변수 두 개**를 밀어 넣는다.

| | 일반 자바 객체 | JPA 엔티티 |
|---|---|---|
| 식별자 | 처음부터 있다 | **저장돼야 생긴다** (`IDENTITY`/`SEQUENCE`) |
| 런타임 타입 | `getClass()`가 그 클래스 | **프록시면 `Member$HibernateProxy`** |
| 필드 읽기 | 그냥 읽으면 값이 있다 | **프록시의 필드는 비어 있다** — getter로 읽어야 한다 |

두 번째·세 번째가 같은 뿌리다. `@ManyToOne(fetch = LAZY)` 연관이든 `getReferenceById`든, JPA는 **원본 클래스를 상속한 대역 객체**를 만들어 끼워 넣는다. 겉모습은 `Member`인데 속은 비어 있고 `id`와 "나는 아직 안 채워졌다"는 표시만 들고 있다. 자세한 동작은 [`findById` vs `getReferenceById`](16-find-by-id-vs-get-reference-by-id.md)에 있다. 이 문서에서 필요한 성질은 셋이다.

```java
Member proxy = memberRepository.getReferenceById(1L);

proxy instanceof Member             // true   — 상속했으니 통과한다
proxy.getClass() == Member.class    // false  ← 함정 ①
proxy.getId()                       // 1      — 초기화 없이 읽힌다
// proxy.id (필드 직접 접근)         // null   ← 함정 ② 값은 내부 target에 있다
```

**`instanceof`는 통과하고 `getClass()` 비교는 깨진다.** 그리고 하필 IDE가 자동 생성해 주는 `equals`가 `getClass()` 비교를 쓴다. 이것이 이 문항의 절반이다.

---

## 3. 엔티티와 값 객체(VO)는 "같다"의 기준이 다르다

여기가 이번 면접에서 갈린 지점이다. 꼬리질문 2-2에 대한 답은 이랬다 — **"필드를 `final`로 하고, 변경할 때는 새 객체를 만들면 된다. 그럼 그 필드들로 `hashCode`를 만들어도 상관없다."**

**이 답은 틀린 답이 아니라 대상을 잘못 고른 답이다.** 값 객체(VO)에는 **정확한 처방**이고, 엔티티에는 **성립하지 않는다.**

### 3-1. 두 종류의 객체는 정체성의 근거가 다르다

| | **엔티티**(Entity) | **값 객체**(Value Object) |
|---|---|---|
| 예시 | `Member`, `Order`, `Post` | `Money`, `Address`, `Period`, `Email` |
| "같다"의 기준 | **식별자가 같으면 같다** | **값이 전부 같으면 같다** |
| 대응하는 것 | DB의 **한 행** | 그 행의 **몇 개 컬럼 값** |
| 변경 방식 | **내용이 바뀐다**(같은 객체가 계속 그 객체) | **새 객체로 교체한다**(원본은 안 바뀐다) |
| 수명 | 생성 → 저장 → 수정 → 삭제, 추적된다 | 붙어 있는 엔티티의 부품, 독립 수명 없다 |
| `equals` 기준 | `id` | 모든 값 필드 |

"이름을 바꾼 회원"과 "10,000원 → 20,000원이 된 금액"의 차이를 생각하면 명확해진다.

- **회원의 이름이 바뀌어도 같은 회원이다.** 1번 회원은 개명해도 1번 회원이고, 그 사람의 주문 이력도 그대로 따라온다.
- **10,000원이 20,000원이 되는 일은 없다.** 그냥 **다른 금액**이다. `Money.of(10000)`을 들고 있다가 20,000원이 되면 `Money.of(20000)`이라는 **새 객체로 교체**하는 것이지, 그 객체의 속이 바뀌는 게 아니다.

### 3-2. 그래서 엔티티에 `final`을 적용하면 무너지는 것이 둘이다

**① 도메인 의미가 무너진다.** 이름을 바꾸려고 새 `Member` 객체를 만들면, JPA 입장에서 그건 **다른 행**이다. `id`가 없는 새 객체를 `save()` 하면 UPDATE가 아니라 **INSERT**가 나간다. 회원이 개명할 때마다 회원 테이블에 행이 하나씩 늘어난다.

**② JPA의 기본 동작이 무너진다.** 변경 감지(dirty checking)는 **"영속성 컨텍스트가 들고 있는 스냅샷과 현재 필드 값을 비교해서, 달라진 것을 UPDATE로 내보낸다"**는 메커니즘이다. **필드가 바뀌는 것을 전제로 설계된 기능**이므로 필드를 `final`로 만들면 이 기능 자체가 성립하지 않는다(→ [영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md)). 애초에 JPA는 엔티티에 **기본 생성자**를 요구하고 리플렉션으로 필드를 채우므로, `final` 필드로는 엔티티를 매핑하는 것부터 어렵다.

```java
// ✗ 엔티티에 VO의 논리를 적용한 코드 — 도메인도 JPA도 무너진다
@Entity
public class Member {
    @Id @GeneratedValue private Long id;
    private final String name;      // final이면 Hibernate가 채울 수 없다
    private final String email;

    public Member withName(String newName) {          // 변경 = 새 객체
        return new Member(newName, this.email);       // ← 저장하면 INSERT. 다른 회원이 된다
    }
    @Override public int hashCode() { return Objects.hash(name, email); }
}
```

```java
// ✓ VO에는 정확히 이 논리가 맞다 — 그리고 equals/hashCode를 모든 값으로 만드는 게 옳다
@Embeddable
public class Money {
    private BigDecimal amount;      // JPA가 리플렉션으로 채워야 해서 문법적 final은 못 쓴다.
    private String currency;        // 대신 "setter를 만들지 않는다"는 규율로 불변을 지킨다.

    protected Money() {}            // JPA 전용 기본 생성자

    public Money plus(Money other) {                  // 변경이 아니라 새 객체 생성
        return new Money(this.amount.add(other.amount), this.currency);
    }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money m)) return false;
        return currency.equals(m.currency) && amount.compareTo(m.amount) == 0;
        //                                    ↑ BigDecimal은 equals가 아니라 compareTo (1장 참고)
    }
    @Override public int hashCode() { return Objects.hash(currency, amount.stripTrailingZeros()); }
}
```

VO의 `equals`/`hashCode`는 **아무 문제가 없다.** 값이 안 변하므로 해시도 안 변하고, 프록시가 만들어지지 않으므로(`@Embeddable`은 엔티티가 아니라 지연 로딩 대상이 아니다) 타입 비교도 안전하다. **후보자가 말한 처방은 여기서는 100% 정답이다.**

### 3-3. 한 문장으로 고정

**"엔티티는 식별자가 고정되고 내용은 변하는 객체, 값 객체는 값 전체가 곧 정체성이라 변하면 다른 것."**

이 구분은 JPA의 세부 사항이 아니라 **DDD의 첫 페이지**다. 그리고 실무적으로 이런 판단으로 이어진다 — **주소·금액·기간·좌표·이메일처럼 "값 자체가 의미의 전부"인 것은 엔티티로 만들지 말고 `@Embeddable` VO로 내려라.** 그러면 그 부분에 대해서는 `equals`/`hashCode` 문제가 애초에 발생하지 않고, `Set`에 넣어도 안전하며, 검증 로직을 그 클래스 안에 모을 수 있다.

---

## 4. 잘못된 구현 3종 → 올바른 최종형

### 4-1. ✗ 유형 1: Lombok `@Data` (실무에서 가장 흔하다)

```java
// before — 한 줄인데 지뢰가 세 개다
@Entity
@Data                                     // @Getter @Setter @ToString @EqualsAndHashCode
public class Member {
    @Id @GeneratedValue private Long id;
    private String name;
    private String email;

    @ManyToOne(fetch = FetchType.LAZY)
    private Team team;

    @OneToMany(mappedBy = "member")
    private List<Order> orders = new ArrayList<>();
}
```

문제가 셋이다.

1. **`equals`/`hashCode`가 모든 필드 기반**으로 생성된다 → `name`을 바꾸면 해시가 바뀐다. §1의 사고가 `id` 말고 **모든 필드에서** 일어난다.
2. **`equals` 한 번이 쿼리 폭탄**이 된다. Lombok은 getter가 있으면 getter를 호출하도록 생성하는데, 그 getter들 중에 `getTeam()`과 `getOrders()`가 있다. **비교 한 번에 지연 로딩 연관이 전부 초기화**된다. `Set`에 100건을 넣으면 해시 충돌마다 `equals`가 돌고, 그때마다 SELECT가 나간다.
3. **`toString`이 양방향 연관을 타고 무한 순환**한다(`Member` → `orders` → 각 `Order` → `member` → …). 로그 한 줄 찍으려다 `StackOverflowError`가 난다.

**결론: 엔티티에는 `@Data`를 붙이지 않는다.** 필요한 것은 `@Getter` 하나이고, 나머지는 직접 쓰거나 안 쓴다.

### 4-2. ✗ 유형 2: 모든 필드 기반 수동 구현 (IDE 자동 생성)

```java
// before — Lombok을 안 썼을 뿐 본질은 같다
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (o == null || getClass() != o.getClass()) return false;
    Member member = (Member) o;
    return Objects.equals(name, member.name)
        && Objects.equals(email, member.email);
}

@Override
public int hashCode() {
    return Objects.hash(name, email);       // ← 사용자가 마이페이지에서 바꾸는 필드
}
```

이것이 꼬리질문 2-1의 답("`id`가 아닌 다른 필드로 구현")을 그대로 코드로 옮긴 것이다. **불변 자연키가 진짜로 존재하면 유효한 전략**(§6-A)이지만, `name`·`email`·`phone`처럼 **사용자가 바꿀 수 있는 필드**라면 §1과 똑같은 사고가 난다. `id` 대신 `name`이 바뀌는 것뿐이고, 오히려 **언제 바뀔지 예측이 안 되므로 더 나쁘다.**

### 4-3. ✗ 유형 3: `getClass()` 비교 + 필드 직접 접근

```java
// before — id 기반으로 고친 버전. 이제 됐을까? 아직 두 개가 남았다
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (o == null || getClass() != o.getClass()) return false;   // ← 함정 ①
    Member member = (Member) o;
    return Objects.equals(id, member.id);                        // ← 함정 ②③
}

@Override
public int hashCode() {
    return Objects.hash(id);                                     // ← 함정 ④
}
```

**함정 ① `getClass()` 비교 → 프록시에서 깨진다.**

```java
Member real  = memberRepository.findById(1L).orElseThrow();   // 실제 엔티티
Member proxy = someOrder.getMember();                         // LAZY 연관 → 프록시 (같은 1번)

real.equals(proxy);   // false !! — getClass()가 Member.class vs Member$HibernateProxy
```

**함정 ② `member.id` 필드 직접 접근 → 프록시의 필드는 비어 있다.** `equals`는 같은 클래스의 private 필드에 접근할 수 있어서 문법적으로는 통과하지만, 상대가 프록시면 **그 프록시 인스턴스의 `id` 필드는 `null`**이다(실제 값은 내부 target 객체에 있고, 그 값은 `getId()`를 통해서만 나온다). `getClass()` 문제를 `instanceof`로 고쳐도 이것 때문에 여전히 `false`가 나온다.

**함정 ③ `Objects.equals(id, member.id)`는 `null == null`을 `true`로 만든다.** 저장 전 엔티티가 둘 있으면 `id`가 둘 다 `null`이라 **서로 다른 회원 두 명이 같다고 판정된다.** `Set`에 넣으면 하나만 남는다 — §1과 정반대 방향의 데이터 유실 사고다.

**함정 ④ `Objects.hash(id)` → §1의 사고 그대로.**

### 4-4. ✓ 올바른 최종형

```java
// after — 함정 넷을 모두 막은 형태
@Entity
@Getter                                     // @Data가 아니라 @Getter만
public class Member {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;                     // ① 자기 자신은 여기서 끝난다
        if (!(o instanceof Member other)) return false;  // ② getClass()가 아니라 instanceof
                                                         //    프록시도 Member의 하위 타입이라 통과
        return id != null && id.equals(other.getId());   // ③ id가 null이면 무조건 false
                                                         // ④ other.id가 아니라 other.getId()
    }

    @Override
    public int hashCode() {
        return 31;                                       // ⑤ id와 무관한 상수. 절대 안 변한다
    }
}
```

네 줄에 각각 이유가 붙는다.

**① `this == o`가 맨 앞에 있어야 하는 이유.** `id`가 아직 `null`인 미저장 엔티티도 **자기 자신과는 같아야** 한다. 세 번째 줄의 `id != null` 조건 때문에 미저장 엔티티는 모든 비교에서 `false`가 되는데, 그러면 `set.contains(theSameInstance)`조차 실패한다. 그것을 이 첫 줄이 막는다. **`hashCode`가 상수라 버킷이 그대로이므로, 저장 전에 넣고 저장 후에 찾아도 같은 버킷에서 `this == o`로 잡힌다** — §1의 사고가 여기서 완전히 해소된다.

**② `instanceof`가 프록시를 통과시킨다.** Hibernate 프록시는 `Member`를 **상속**하므로 `o instanceof Member`는 `true`다. Hibernate에 의존해도 괜찮다면 `Hibernate.getClass(o)`가 프록시를 벗겨 실제 클래스를 돌려주므로 `Hibernate.getClass(this) != Hibernate.getClass(o)` 형태도 정답이다. 다만 **`Hibernate.getClass()`와 `Hibernate.unproxy()`는 프록시를 초기화하므로 SELECT를 유발할 수 있다** — SELECT를 아끼려고 프록시를 쓰는 마당에 `equals` 안에서 SELECT가 나가면 본말이 전도된다. 초기화 없이 실제 클래스만 얻으려면 이렇게 한다.

```java
// 상속 매핑이 있어 타입 구분이 꼭 필요할 때 쓰는 템플릿 — 초기화를 일으키지 않는다
private static Class<?> effectiveClass(Object o) {
    return (o instanceof HibernateProxy hp)
            ? hp.getHibernateLazyInitializer().getPersistentClass()
            : o.getClass();
}
```

**③ `id != null &&`가 미저장끼리의 오판을 막는다.** 저장 전에는 모든 비교가 `false`가 된다. **"아직 식별자가 없으므로 같다고 말할 근거가 없다"**는 뜻이고, 이것이 도메인적으로도 옳다 — 아직 회원가입하지 않은 두 사람이 같은 사람인지 시스템은 알 수 없다.

**④ `other.getId()`로 읽어야 프록시에서도 값이 나온다.** 이 한 글자 차이가 실무에서 가장 자주 터지는 지점이다.

**⑤ `hashCode()`가 상수여야 하는 이유는 §5에서.**

---

## 5. `hashCode()`는 상수를 반환해도 된다 — 오히려 그게 정석이다

꼬리질문 2-3에서 막힌 지점이다. 힌트는 **"항상 같은 값을 유지한다만 만족하면 된다"**였다.

### 5-1. 규약이 요구하지 않는 것

`hashCode` 규약을 오해하기 쉬운 지점이 여기다. 규약이 요구하는 것은 두 가지뿐이다.

- **같은 객체는 항상 같은 값을 돌려줄 것** (일관성)
- **`equals`가 `true`인 두 객체는 같은 값을 돌려줄 것**

**"다른 객체는 다른 값을 돌려줄 것"은 규약이 아니다.** 그건 성능을 위한 권고이고, 안 지켜도 프로그램은 **정확하게 동작한다** — 느려질 뿐이다.

그래서 `return 31;`은 **규약을 완벽하게 지킨다.** `getClass().hashCode()`도 마찬가지고(타입마다 값이 달라 조금 낫다), Hibernate 계열 템플릿에서는 `effectiveClass(this).hashCode()`를 쓴다.

```java
// 세 가지 다 유효하다
@Override public int hashCode() { return 31; }                              // 가장 단순
@Override public int hashCode() { return getClass().hashCode(); }           // 타입별로 분산
@Override public int hashCode() { return effectiveClass(this).hashCode(); } // 프록시·상속까지 고려
```

> `getClass().hashCode()`를 쓸 때 알아둘 것 하나: **엔티티가 `equals`/`hashCode`를 오버라이드하면, 프록시에 대한 그 호출은 대상 객체 쪽으로 넘어가면서 프록시가 초기화될 수 있다.** 그래서 이 메서드들의 본문이 `id` 이외의 필드를 만지면 그 비용이 그대로 SELECT가 된다(§8의 Lombok 쿼리 폭탄이 정확히 이 경로다). 상수 반환은 이 경로에서 아무것도 하지 않으므로 가장 안전하다.

### 5-2. 그 대가와, 그 대가를 감수하는 근거

**대가는 명확하다 — 버킷이 하나가 되어 `HashSet`이 사실상 연결 리스트가 된다.** 조회가 O(1)에서 **O(n)**이 되고, 원소 n개를 넣으면 비교 횟수가 n²/2에 비례한다.

**그런데 이 대가가 실제로 문제가 되려면 "엔티티를 수천 개 이상 `Set`에 담는" 상황이어야 한다.** 실무에서 그런 코드는 드물다. 엔티티를 담는 컬렉션은 대개 **한 주문의 주문상품 몇 개, 한 게시글의 첨부 몇 개** 수준이고, 그 규모에서 O(1)과 O(n)의 차이는 측정되지 않는다. **정확성을 얻고 측정되지 않는 성능을 내주는 거래**이므로 감수한다.

**그래도 규모가 커지는 자리가 하나 있다** — **연관관계를 `Set`으로 매핑했고 자식이 수천 건**인 경우다. Hibernate가 그 컬렉션을 로딩할 때 원소를 하나씩 `Set`에 넣는데, 상수 해시면 전부 한 버킷에 쌓이면서 로딩 자체가 O(n²)이 된다. 그래서 **답은 "상수 해시를 포기하자"가 아니라 "그런 컬렉션을 `Set`으로 매핑하지 말자"**(§7)로 간다.

### 5-3. 상수 반환이 싫다면 — 근본 해법은 "id를 저장 전에 갖는 것" (가산점 포인트)

상수 해시가 찜찜한 이유는 결국 **`id`가 저장돼야 생기기 때문**이다. 그렇다면 **`id`를 애플리케이션이 직접 만들면** 이 문제 전체가 사라진다.

```java
// after — 생성자에서 id를 만든다. 저장 전에도 id가 있고, 저장돼도 안 바뀐다
@Entity
public class Member {

    @Id
    private UUID id;                       // @GeneratedValue 없음 — DB에 맡기지 않는다

    protected Member() {}

    public Member(String name) {
        this.id = UUID.randomUUID();       // ★ new 하는 순간 정체성이 확정된다
        this.name = name;
    }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Member other)) return false;
        return id.equals(other.getId());   // null 체크가 필요 없다
    }
    @Override public int hashCode() { return id.hashCode(); }   // 상수일 필요가 없다
}
```

**얻는 것**: `Set`/`Map` 문제 소멸, 저장 전후 일관성, 미저장 객체끼리도 정확한 구분, 그리고 **`IDENTITY`가 막아 놓은 JDBC 배치 INSERT까지 열린다**(→ [`findById` vs `getReferenceById`](16-find-by-id-vs-get-reference-by-id.md) §5).

**포기하는 것**: 랜덤 UUID는 값이 뒤죽박죽이라 **B-Tree 인덱스에서 삽입 위치가 흩어지고**(페이지 분할·캐시 효율 저하), 저장 공간도 `bigint`보다 크다. 그래서 실무에서는 **시간순으로 증가하는 형태의 식별자**(UUIDv7, TSID 같은 정렬 가능한 ID)를 쓴다. 도입은 초기 설계에서 결정할 사항이고, 운영 중인 테이블을 바꾸는 것은 마이그레이션 비용이 크다.

**면접에서의 한 줄**: "`hashCode` 상수 반환은 **`id`가 나중에 생긴다는 제약에 대한 대응**입니다. 애초에 그 제약을 없애려면 식별자를 애플리케이션에서 생성하면 되고, 그러면 `equals`/`hashCode`를 평범하게 `id` 기반으로 쓸 수 있습니다. 다만 인덱스 지역성이라는 다른 비용을 냅니다."

---

## 6. 전략 세 가지 — 각각 얻는 것과 포기하는 것

**"무엇이 정답인가"가 아니라 "무엇을 내주고 무엇을 얻는가"로 정리한다.**

### A. 자연키(비즈니스 키) 기반

```java
// 예: 국가 코드, ISBN, 사업자등록번호처럼 도메인이 부여하고 절대 안 바뀌는 값
@Override public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Book other)) return false;
    return isbn.equals(other.getIsbn());
}
@Override public int hashCode() { return isbn.hashCode(); }
```

- **얻는 것**: 저장 전후 완전히 일관. 다른 영속성 컨텍스트·다른 트랜잭션·직렬화 왕복을 넘어서도 같은 판정. 해시가 잘 분산돼 `Set` 성능도 정상.
- **포기하는 것**: **진짜로 불변인 자연키가 실제로 존재해야 한다** — 이게 대부분의 엔티티에서 성립하지 않는다. 이메일·전화번호·사번은 전부 바뀔 수 있고, "안 바뀔 것 같았는데 바뀌는" 사고가 이 전략의 전형적인 실패다. 그리고 **`equals` 안에서 그 필드를 읽으므로 상대가 프록시면 초기화(SELECT)가 일어난다.**
- **쓸 자리**: 도메인이 부여한 코드성 식별자가 있는 엔티티. 있으면 `@NaturalId`로 명시해 의도를 코드에 남긴다.

### B. `id` 기반 + 상수 `hashCode` (§4-4의 최종형)

- **얻는 것**: 저장 후에는 **같은 행 = 같은 객체**가 정확히 성립. 프록시와 실제 엔티티도 같다고 판정. 준영속·다른 트랜잭션·DTO 왕복을 넘어서도 동작. `equals`가 `id`만 만지므로 **초기화(SELECT)를 유발하지 않는다.**
- **포기하는 것**: ① **미저장 엔티티들끼리는 전부 서로 다르다**(같은 내용의 새 객체 두 개도 다르다 — 대개 이게 옳지만, "내용이 같으면 중복"이라는 판정을 `Set`에 맡길 수는 없다) ② **버킷 하나** → `Set` 규모가 커지면 O(n) ③ 코드를 처음 보는 사람에게 `return 31;`이 이상해 보여 **주석이 필요하다.**
- **쓸 자리**: 불변 자연키가 없고, 엔티티를 `Set`/`Map`에 담거나 컬렉션 비교를 해야 하는 경우. **가장 범용적인 기본값.**

### C. 아예 오버라이드하지 않기 (기본 동일성 비교)

- **얻는 것**: 가장 단순하고, 틀릴 여지가 0이다. 프록시 초기화도 없다. **그리고 생각보다 잘 동작한다** — JPA는 **"같은 영속성 컨텍스트 안에서 같은 `id`를 조회하면 항상 같은 인스턴스를 준다"**(동일성 보장)를 지키므로, 한 트랜잭션 안에서는 `==`만으로 "같은 행"이 정확히 판정된다.
- **포기하는 것**: **영속성 컨텍스트 경계를 넘는 순간 무너진다.** 트랜잭션이 다르면, 준영속 상태면, 캐시에서 꺼냈으면, 테스트에서 두 번 조회했으면 — **같은 행인데 다른 객체**가 된다. `Set`에 중복이 쌓이고 `contains`가 실패한다.
- **쓸 자리**: **대부분의 엔티티.** `Set`/`Map`에 넣지 않고 컬렉션 비교도 하지 않는다면, 오버라이드하지 않는 것이 가장 안전하다.

### 선택 기준을 한 문장으로

**"불변 자연키가 있으면 A, 없고 `Set`/`Map`/준영속 비교가 필요하면 B, 그런 요구가 없으면 오버라이드하지 않는 C. 그리고 애초에 B가 필요한 상황을 만들지 않는 것(§7)이 가장 낫다."**

---

## 7. 가장 확실한 처방 — 엔티티를 `Set`·`Map` 키로 쓰지 않기

지금까지의 모든 함정은 **"엔티티를 해시 기반 자료구조에 넣는다"**는 전제 위에 있다. 그 전제를 없애면 문제 자체가 사라진다.

```java
// before — 컬렉션을 Set으로 매핑. equals/hashCode에 정확성을 의존하게 된다
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
private Set<OrderItem> items = new HashSet<>();
```

```java
// after — 특별한 이유가 없으면 List
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
private List<OrderItem> items = new ArrayList<>();
```

`List`는 순서만 유지할 뿐 해시를 쓰지 않으므로, `equals`/`hashCode`를 오버라이드하지 않아도 **추가·순회·인덱스 접근이 전부 정상**이다.

**다만 "무조건 `List`"는 아니다.** 두 가지를 함께 알아야 한다.

- **중복을 막아야 한다면 `Set`이 아니라 DB의 유니크 제약이 맡아야 한다.** 애플리케이션 컬렉션은 동시성 상황에서 중복을 못 막는다(→ [복합 유니크 제약과 동시 INSERT](14-unique-constraint-concurrent-insert.md)). `Set`으로 중복을 막고 있다고 믿는 코드는 대개 이미 뚫려 있다.
- **`@ManyToMany`나 조인 테이블을 쓰는 컬렉션에서는 `List`(bag) 매핑이 "전부 삭제 후 재삽입"으로 동작하는 알려진 문제**가 있어 `Set`이 권장되기도 한다. 그런 자리에서 `Set`을 쓰기로 했다면 **§4-4의 `equals`/`hashCode`를 반드시 함께 구현해야 한다** — 이 두 선택은 세트다.

`Map`의 키도 마찬가지다. **엔티티를 키로 쓰지 말고 `id`를 키로 쓴다.**

```java
// before
Map<Member, List<Order>> ordersByMember = orders.stream()
        .collect(groupingBy(Order::getMember));      // 엔티티가 키 → 해시 함정 전부 상속

// after — id를 키로 쓰면 equals/hashCode를 신경 쓸 일이 없다
Map<Long, List<Order>> ordersByMemberId = orders.stream()
        .collect(groupingBy(o -> o.getMember().getId()));   // getId()는 프록시도 초기화 안 한다
```

`after`에는 보너스가 하나 더 있다 — **`getMember().getId()`는 프록시를 초기화하지 않으므로 SELECT가 나가지 않는다.** `before`는 그룹핑 과정에서 `hashCode`가 호출되며 회원마다 SELECT가 나갈 수 있다.

---

## 8. 실무 최대 함정은 Lombok이다

`equals`/`hashCode`를 손으로 잘못 쓰는 사람보다, **Lombok이 대신 잘못 써 주는 경우**가 압도적으로 많다. 어노테이션 한 줄이라 리뷰에서 눈에 안 띄고, 붙인 사람도 `equals`를 만들었다는 자각이 없다.

### 8-1. 무엇이 생성되는가

`@Data`는 `@Getter @Setter @ToString @EqualsAndHashCode @RequiredArgsConstructor`의 묶음이다. 이 중 `@EqualsAndHashCode`가 **모든 인스턴스 필드를 기준으로** 두 메서드를 만든다. 그리고 Lombok은 **getter가 있으면 필드가 아니라 getter를 호출하도록 생성한다.**

그래서 결과가 이렇게 된다.

- **프록시 필드 직접 접근 함정(§4-3 ②)은 피해 간다** — getter를 쓰므로.
- **그 대신 모든 연관 필드의 getter가 호출된다.** `equals` 한 번에 `getTeam()`, `getOrders()`가 불리고 **지연 로딩이 전부 초기화**된다. `Set`에 담거나 `contains`를 부를 때마다 SELECT가 줄줄이 나간다. **"조회 화면 하나에서 쿼리가 수백 개"의 원인을 추적하다 `equals`에서 발견하는** 유형이다.
- **저장 시점 해시 변동은 그대로 남는다** — 모든 필드에 `id`도 포함되므로.

### 8-2. 절충안과 그 한계

```java
// 절충안 — id만 명시적으로 포함시킨다
@Entity
@Getter
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
public class Member {
    @Id @GeneratedValue
    @EqualsAndHashCode.Include                     // 이 필드만 사용
    private Long id;

    private String name;
    @ManyToOne(fetch = LAZY) private Team team;    // 비교에서 제외 → 초기화 안 됨
}
```

**막아 주는 것**: 연관 초기화로 인한 쿼리 폭탄, 사용자 수정 필드로 인한 해시 변동.

**여전히 못 막는 것 — 이게 핵심이다.**

- **`id`가 `null`이던 시점의 해시와 저장 후 해시가 다르다.** Lombok이 생성하는 `hashCode`는 `id`가 `null`이면 고정된 상수를, 값이 있으면 그 값의 해시를 섞는다. 즉 **§1의 사고가 그대로 재현된다.** `onlyExplicitlyIncluded`는 이 문제를 건드리지 않는다.
- **미저장 엔티티 두 개가 같다고 판정된다.** 둘 다 `id`가 `null`이면 `equals`가 `true`가 된다 — §4-3의 함정 ③이다.

**결론**: `onlyExplicitlyIncluded`는 **`@Data`보다는 훨씬 낫지만 정답은 아니다.** `id`가 저장 시점에 생기는 한, **`id != null &&` 조건과 상수 `hashCode`는 Lombok으로 표현할 수 없다.** 그래서 엔티티의 `equals`/`hashCode`는 **직접 쓰거나, 아예 안 쓰거나**(§6-C) 둘 중 하나다. 예외는 §5-3처럼 **`id`를 애플리케이션이 생성하는 경우** — 그때는 `@EqualsAndHashCode(onlyExplicitlyIncluded = true)`가 완전한 해답이 된다.

> `@ToString`도 같이 정리해야 한다. 엔티티에 `@ToString`을 붙이면 **양방향 연관을 타고 무한 순환**하거나 **지연 로딩을 전부 초기화**한다. 꼭 필요하면 `@ToString(exclude = {"team", "orders"})` 또는 `@ToString.Exclude`로 연관을 전부 빼야 한다. 같은 이유로 **엔티티를 JSON으로 직렬화하는 것도 금지**다(→ [엔티티 직접 노출과 DTO 경계](12-entity-exposure-and-dto-boundary.md)).

---

## 9. 안전망 — 사람의 기억이 아니라 기계가 지키게 한다

이 버그의 특징은 **리뷰에서 안 보이고 테스트에서 안 걸린다**는 것이다. 그래서 규칙을 코드로 고정한다.

### 9-1. 구조 규칙: 엔티티에 `@Data`를 금지한다

```java
// ArchUnit — 엔티티에 위험한 Lombok 어노테이션을 붙이지 못하게 막는다
@AnalyzeClasses(packages = "com.example.domain")
class EntityConventionTest {

    @ArchTest
    static final ArchRule 엔티티에는_Data와_EqualsAndHashCode를_붙이지_않는다 =
        noClasses().that().areAnnotatedWith(Entity.class)
            .should().beAnnotatedWith(Data.class)
            .orShould().beAnnotatedWith(EqualsAndHashCode.class)
            .orShould().beAnnotatedWith(ToString.class)
            .because("모든 필드 기반 equals/hashCode/toString은 해시 변동·쿼리 폭탄·무한 순환을 만든다");
}
```

**이 룰의 가치는 "지금 잘못된 코드를 잡는 것"이 아니라 "6개월 뒤 새로 들어온 사람이 습관적으로 붙이는 것을 막는 것"**이다. `@Data`는 편해서 반드시 다시 들어온다.

### 9-2. 동작 테스트 세 개

```java
@DataJpaTest
class MemberEqualityTest {

    @Autowired MemberRepository memberRepository;
    @Autowired EntityManager em;

    @Test
    void 저장_전에_Set에_넣은_엔티티는_저장_후에도_찾을_수_있다() {   // §1의 사고
        Set<Member> set = new HashSet<>();
        Member member = new Member("주덕");
        set.add(member);

        memberRepository.save(member);          // id가 채워진다

        assertThat(set).contains(member);       // 상수 hashCode 덕에 통과
        assertThat(set.remove(member)).isTrue();
    }

    @Test
    void 미저장_엔티티_두_개는_같다고_판정되지_않는다() {            // §4-3 함정 ③
        Set<Member> set = new HashSet<>();
        set.add(new Member("주덕"));
        set.add(new Member("영희"));

        assertThat(set).hasSize(2);             // id가 둘 다 null인데 하나로 합쳐지면 실패
    }

    @Test
    void 프록시와_실제_엔티티는_같다고_판정된다() {                  // §4-3 함정 ①②
        Long id = memberRepository.save(new Member("주덕")).getId();
        em.flush();
        em.clear();                             // 1차 캐시를 비워야 진짜 프록시가 나온다

        Member proxy = memberRepository.getReferenceById(id);
        Member real  = memberRepository.findById(id).orElseThrow();

        assertThat(proxy).isEqualTo(real);      // 양방향 모두 확인해야 대칭성까지 검증된다
        assertThat(real).isEqualTo(proxy);
        assertThat(proxy.hashCode()).isEqualTo(real.hashCode());
    }
}
```

> **`@DataJpaTest`는 기본적으로 테스트 끝에 롤백**하므로 커밋 시점에만 드러나는 문제는 숨는다. 첫 번째 테스트처럼 **저장 시점의 `id` 부여**가 관건이면 `save()` 뒤에 `flush()`를 명시하거나 `@Commit`을 붙여 실제 시점을 만들어 줘야 한다.

### 9-3. `equals`가 쿼리를 유발하지 않는지 단정한다

§8의 쿼리 폭탄은 **테스트가 통과하면서도 느려지는** 종류라 기능 테스트로는 안 잡힌다. **쿼리 수를 직접 단정**한다.

```java
@Test
void equals_비교는_추가_쿼리를_유발하지_않는다() {
    Member a = memberRepository.getReferenceById(1L);
    Member b = memberRepository.getReferenceById(1L);

    SQLStatementCountValidator.reset();
    a.equals(b);
    a.hashCode();
    SQLStatementCountValidator.assertSelectCount(0);   // 하나라도 나가면 실패
}
```

이 테스트 하나가 **누군가 `equals`에 `name` 비교를 슬쩍 추가하거나 `@Data`를 붙이는 순간** 빨간불을 켠다. **"문제를 만나면 잘 푸는 것"과 "문제가 오기 전에 잡는 장치를 만드는 것"의 차이가 여기에 있다.**

---

## 10. 꼬리질문 대비 포인트

### "`hashCode`가 항상 같은 값이면 `HashSet`의 의미가 없지 않나요? 성능 문제 아닌가요?"

**맞다. 버킷이 하나가 되어 조회가 O(1)에서 O(n)이 된다.** 다만 그 대가를 감수하는 근거가 둘 있다.

**① 규약이 요구하는 것은 "항상 같은 값"이지 "잘 분산된 값"이 아니다.** 상수 반환은 **정확성을 완전히 보장**하고, 잃는 것은 성능뿐이다. 반대로 `id` 기반 해시는 성능은 좋지만 **정확성이 깨진다** — 저장 시점에 값이 바뀌므로. **깨진 정확성은 회복 불가능이고, 느린 정확성은 필요하면 개선할 수 있다.**

**② 엔티티를 대량으로 `Set`에 넣는 코드가 실무에 거의 없다.** 한 주문의 주문상품 몇 개, 한 게시글의 첨부 몇 개 수준에서 O(n)은 측정되지 않는다.

**단, 예외가 하나 있다** — 연관관계를 `Set`으로 매핑했고 자식이 수천 건이면 Hibernate가 그 컬렉션을 로딩하며 전부 한 버킷에 밀어 넣어 O(n²)이 된다. **그런 상황이면 답은 "해시를 분산시키자"가 아니라 "그 컬렉션을 `Set`으로 매핑하지 말자" 또는 "식별자를 애플리케이션에서 생성하자"**다.

### "`id != null` 조건 때문에 미저장 엔티티는 자기 자신과도 다르다고 나오지 않나요?"

**아니다. 맨 앞의 `this == o`가 잡는다.** 그래서 `equals`의 첫 줄에 그것이 있어야 한다.

정리하면 미저장 엔티티의 판정은 이렇게 된다 — **자기 자신하고만 같고, 다른 모든 객체와는 다르다.** 이건 결함이 아니라 **의도된 설계**다. 아직 식별자가 없다는 것은 **"이 객체가 어느 행인지 시스템이 아직 모른다"**는 뜻이고, 그 상태에서 두 객체가 같은 것이라고 단정할 근거는 없다. 이름이 같다고 같은 회원이라고 판정해 버리면 `Set`에서 한 명이 조용히 사라진다.

그리고 `hashCode`가 상수라서 **저장 전에 넣은 객체가 저장 후에도 같은 버킷에 있고**, `contains(sameInstance)`는 그 버킷에서 `this == o`로 잡힌다. **§1의 사고가 정확히 이 조합으로 해소된다.**

### "`equals`에서 `getClass()` 대신 `instanceof`를 쓰면 대칭성이 깨진다고 배웠는데요?" (시니어 변별 포인트)

**일반론으로는 맞는 지적이고, JPA 프록시에서는 적용되지 않는다.** 이 구분이 이 질문의 핵심이다.

`instanceof`가 위험하다고 하는 이유는 **상속으로 상태를 추가한 서브클래스** 때문이다. `Point`와 `ColorPoint`가 있을 때 `point.equals(colorPoint)`는 `true`인데 `colorPoint.equals(point)`는 `false`가 되어 **대칭성이 깨진다.** 그래서 `getClass()` 비교로 타입이 정확히 같을 것을 요구하라는 조언이 나온다.

**그런데 Hibernate 프록시는 "상태를 추가한 서브클래스"가 아니다.** 같은 엔티티를 가리키는 **대역(代役)**이고, 논리적으로는 `Member` 그 자체다. `Member$HibernateProxy`는 새 필드를 추가하지 않고, 개발자가 상속 계층을 설계한 결과도 아니며, **런타임에 프레임워크가 몰래 끼워 넣은 것**이다. 여기서 `getClass()`로 엄격하게 굴면 **"같은 DB 행을 가리키는 두 객체가 다르다"**는, 훨씬 나쁜 결과가 나온다.

**정리하면 규칙의 목적으로 돌아가야 한다** — `getClass()` 비교의 목적은 "의미가 다른 두 타입이 섞이는 것을 막는 것"인데, 프록시는 의미가 다르지 않다. **진짜로 상속 매핑(`@Inheritance`)을 써서 `Member`와 `AdminMember`를 구분해야 한다면**, `instanceof` 대신 §4-4의 `effectiveClass()`처럼 **프록시를 벗긴 실질 클래스끼리 비교**하면 두 요구가 동시에 만족된다.

### "Lombok `@EqualsAndHashCode(onlyExplicitlyIncluded = true)`로 `id`만 포함시키면 되지 않나요?"

**`@Data`보다는 훨씬 낫지만 정답은 아니다.** 막아 주는 것과 못 막는 것을 나눠서 봐야 한다.

**막아 준다**: 연관 getter 호출로 인한 지연 로딩 초기화(쿼리 폭탄), 사용자가 수정하는 필드로 인한 해시 변동.

**못 막는다**: ① **`id`가 `null`이던 시점과 저장 후의 해시가 다르다** — 이 문항의 본론인 §1 사고가 그대로 남는다 ② **미저장 엔티티 두 개가 `id`가 둘 다 `null`이라 같다고 판정된다.**

Lombok으로는 **`id != null && ...` 조건도, 상수 `hashCode`도 표현할 수 없다.** 그래서 선택지는 셋뿐이다 — **직접 작성하거나(§4-4), 아예 오버라이드하지 않거나(§6-C), 식별자를 애플리케이션에서 생성해 `id`가 `null`인 시점을 없애거나(§5-3).** 세 번째를 택하면 그때는 `onlyExplicitlyIncluded`가 완전한 해답이 된다.

### "그럼 모든 엔티티에 이 `equals`/`hashCode`를 넣어야 하나요?" (시니어 변별 포인트)

**아니다. 기본은 "넣지 않는 것"이다.** 필요할 때만 넣는다.

근거는 JPA의 **동일성 보장**이다. **같은 영속성 컨텍스트 안에서 같은 `id`를 조회하면 항상 같은 인스턴스가 돌아온다.** 그래서 한 트랜잭션 안에서만 사는 엔티티라면 오버라이드 없는 기본 `equals`(참조 비교)로도 "같은 행 = 같다"가 정확히 성립하고, **틀릴 여지가 0이며 프록시 초기화도 없다.**

**넣어야 하는 조건은 명확히 셋이다.**

1. 엔티티를 **`Set`에 담거나 `Map`의 키로** 쓴다.
2. **영속성 컨텍스트 경계를 넘어** 같은 엔티티를 비교한다 — 준영속 객체와 새로 조회한 객체, 서로 다른 트랜잭션의 결과, 직렬화 왕복 후.
3. 컬렉션 API(`contains`, `remove`, `distinct`, `removeAll`)의 결과에 **비즈니스 로직이 의존**한다.

**셋 다 아니라면 오버라이드하지 않는 것이 더 나은 코드**다. 그리고 셋 중 하나에 해당한다면, 그다음 질문은 **"이 구조를 바꿔서 조건 자체를 없앨 수 있는가"**여야 한다 — `Set`을 `List`로, `Map<Member, ...>`를 `Map<Long, ...>`으로 바꾸면 문제 자체가 사라진다(§7). **`equals`를 잘 쓰는 것보다 `equals`가 필요 없게 만드는 쪽이 항상 낫다.**

### "이 버그를 실제로 만났다면 어떻게 진단하겠습니까?"

증상이 원인에서 멀어서 **지문을 알아보는 것**이 전부다. 순서는 이렇다.

**① 지문 확인** — "`size()`는 1인데 `contains()`는 `false`", "순회하면 나오는데 `remove()`가 안 된다", "중복 등록이 안 걸러진다", "`Set`에 넣었는데 개수가 예상보다 적다"(미저장끼리 같다고 판정된 반대 방향 사고). 이 넷 중 하나면 **해시 기반 컬렉션 + 가변 키**를 의심한다.

**② 키 객체의 `equals`/`hashCode`를 확인한다** — 엔티티인가? `@Data`가 붙어 있는가? `hashCode`가 `id`나 가변 필드를 쓰는가?

**③ 넣은 시점과 찾은 시점 사이에 `save()`나 setter 호출이 있었는지 본다.** 있으면 그게 원인이다.

**④ 재현 테스트를 먼저 쓴다** — §9-2의 첫 번째 테스트가 그대로 재현 코드다. 고치기 전에 실패하는 테스트를 만들어야 **고쳤다는 것을 증명**할 수 있고, 그 테스트가 그대로 회귀 방지 장치로 남는다.

**⑤ 고친 뒤 안전망을 건다** — §9-1의 ArchUnit 룰과 §9-3의 쿼리 수 단정. 이 버그는 **한 번 고쳐도 다음 사람이 `@Data`를 붙이면 그대로 돌아온다.**

---

## 한 줄 요약

**`Set`에 넣은 엔티티가 `save()` 후 사라지는 것은 `hashCode`가 `id` 기반이라 저장 시점에 값이 바뀌면서 `HashSet`이 기억한 버킷과 어긋나 `equals`까지 가보지도 못하기 때문이고, 여기에 지연 로딩 프록시가 `getClass()` 비교를 깨뜨리고 필드 직접 접근을 `null`로 만드는 함정이 겹치므로, 정석 구현은 `instanceof` + `other.getId()` + `id != null &&` + **상수 `hashCode`**(규약이 요구하는 건 "잘 분산된 값"이 아니라 "항상 같은 값"뿐이고 버킷 하나의 대가는 엔티티를 대량으로 `Set`에 넣지 않으므로 감수한다)이며, "필드를 `final`로 하고 새 객체를 만든다"는 처방은 값 객체(`Money`, `Address`)에는 정확하지만 **DB 한 행에 대응하고 변경 감지가 필드 변경을 전제로 하는 엔티티에는 성립하지 않는다** — 결국 가장 확실한 처방은 엔티티를 `Set`·`Map` 키로 쓰지 않고 컬렉션은 `List`로 매핑하며 엔티티에 Lombok `@Data`를 금지하는 것이고(`onlyExplicitlyIncluded`도 `id`가 `null`이던 시점 문제는 못 막는다), 근본 해법은 식별자를 애플리케이션에서 생성해 "`id`가 나중에 생긴다"는 전제 자체를 없애는 것이다.**
