# Spring Cache 추상화(@Cacheable)의 동작 원리와 함정 — "TTL 속성을 애너테이션에서 찾다가 못 찾는" 이유까지

> 핵심 관전 포인트: **`@Cacheable`은 프록시가 메서드 호출을 가로채 캐시를 먼저 조회하고, 히트면 메서드를 아예 실행하지 않고 캐시값을 돌려주며, 미스일 때만 실행 후 결과를 저장하는 read-through 구조다. 그래서 프록시 기반 애너테이션의 공통 제약(자기 호출 미적용)을 그대로 물려받고, 실무 사고는 대부분 두 곳에서 난다 — 기본 키 생성기는 파라미터 값만으로 키를 만들 뿐 클래스도 메서드도 키에 넣지 않아 같은 캐시 이름을 쓰는 두 메서드가 서로의 값을 받아 가고, 키에 사용자·테넌트 식별자가 빠지면 성능 버그가 아니라 남의 데이터가 보이는 보안 사고가 된다. null 캐싱은 "없는 데이터를 계속 조회하는 캐시 관통"과 "생겼는데도 없다고 나오는 지연" 사이의 선택이고, TTL은 애너테이션에 없다 — 만료의 의미와 단위가 구현체마다 달라 추상화 대상에서 빠졌기 때문이며 `CacheManager` 설정에서 캐시 이름별로 준다. 즉 이 질문은 애너테이션 한 줄 뒤의 동작과 "추상화의 경계가 어디까지인가"를 확인하고 쓰는지를 본다.**

---

## 0. 질문 + 의도

**질문**: "Spring Cache 추상화(`@Cacheable`)의 동작 원리와 함정은? (자기 호출 미적용, 캐시 키 설계, null 캐싱, TTL은 어디서 설정하나)"

**출제 의도**: 캐시 추상화도 AOP 프록시 위에 있어 자기 호출에 무력하고, 캐시 키 설계 실수는 "다른 사용자의 데이터가 보이는" 사고로 직결된다. 애너테이션 한 줄의 편의 뒤에 있는 동작(키 생성 규칙, null 처리, TTL은 캐시 매니저 설정임)을 확인하고 쓰는지 — Redis/캐싱 지식이 스프링 계층에 착지하는 지점을 검증하는 질문이다.

## 1. 동작 원리 — 프록시가 "조회 → 없으면 실행하고 저장"을 대신한다

### 1-1. 전제 지식 — 여기서 말하는 프록시가 무엇인가

`@Cacheable`을 붙이면 스프링은 그 빈을 그대로 등록하지 않고 **한 겹 감싼 대리인 객체**를 만들어 등록한다. 이 대리인이 프록시다.

**프록시는 원본 객체인 척하면서 호출을 먼저 받아 부가 작업을 한 뒤 원본에 넘기는 대리인 객체다.** 같은 인터페이스(또는 같은 클래스를 상속한 타입)를 구현하고 있어서 호출하는 쪽은 원본인지 대리인인지 구별하지 못한다. 비서가 사장 앞으로 온 전화를 먼저 받아 용건을 확인하고 필요할 때만 사장에게 연결하는 것과 같다.

```text
다른 빈이 주입받는 것        실제로 일하는 것
┌──────────────────┐        ┌──────────────────┐
│  MemberService   │        │  MemberService   │
│    (프록시)      │ ─────▶ │    (원본 빈)     │
│                  │        │                  │
│  캐시 조회/저장   │        │  DB 조회 로직     │
└──────────────────┘        └──────────────────┘
      ↑ @Cacheable의 동작은 전부 여기 있다
```

`@Transactional`, `@Async`와 **완전히 같은 메커니즘**(Spring AOP)이고, 가로채서 무엇을 하는지만 다르다. 트랜잭션은 앞에서 `BEGIN`을 걸고 뒤에서 `COMMIT`을 하고, 캐시는 앞에서 조회하고 뒤에서 저장한다.

### 1-2. 프록시가 하는 일을 코드로 풀면

```java
// 프록시가 대신 실행하는 로직 (개념적으로 옮긴 것)
public Member findMember(Long memberId) {
    Object key = keyGenerator.generate(target, method, memberId); // ① 캐시 키를 만든다
    Cache.ValueWrapper hit = cache.get(key);                      // ② 그 키로 캐시를 조회한다

    if (hit != null) {
        return (Member) hit.get();   // ③ 히트 — 원본 메서드를 아예 호출하지 않는다
    }

    Member result = target.findMember(memberId);  // ④ 미스일 때만 진짜 메서드를 실행한다
    cache.put(key, result);                       // ⑤ 그 결과를 캐시에 남긴다
    return result;
}
```

③에 밑줄을 그어 두자. **히트면 원본 메서드가 실행되지 않는다.** 이 한 줄이 1-4에서 볼 가장 흔한 사고의 원인이 된다.

이 패턴을 **read-through**라고 부른다. 읽기 경로 위에 캐시를 끼워 넣고, 미스일 때 캐시가 원본까지 "관통해서" 읽어 자기를 채운다는 뜻이다. 개발자는 캐시 조회·저장 코드를 한 줄도 쓰지 않는다.

### 1-3. 추상화 계층 — 구현체를 갈아끼울 수 있는 이유

```text
@Cacheable (애너테이션)
    ↓
CacheInterceptor (프록시가 실행하는 AOP 어드바이스 — 1-2의 로직이 여기 있다)
    ↓
CacheManager (캐시들의 관리자 — "members"라는 이름으로 Cache를 꺼내 준다)
    ↓
Cache (get / put / evict 세 동작만 있는 인터페이스)
    ↓
구현체: CaffeineCache / RedisCache / ConcurrentMapCache / ...
```

비즈니스 코드는 `@Cacheable(cacheNames = "members")`라는 **이름**만 알고, 그 "members" 캐시가 로컬 메모리(Caffeine)인지 원격 Redis인지는 `CacheManager` 빈 설정에서 결정된다.

그래서 "처음엔 Caffeine으로 시작했다가 서버가 여러 대가 되면 Redis로 교체"가 애너테이션 수정 없이 설정 교체만으로 가능하다. 이것이 추상화의 값어치다.

그리고 여기서 미리 눈여겨볼 것이 하나 있다. **`Cache` 인터페이스에는 get·put·evict밖에 없다.** "얼마나 살아 있을지"를 말하는 자리가 아예 없다는 뜻이고, 이것이 3-3에서 다룰 "TTL은 왜 애너테이션에 없는가"의 답이다.

```java
@Cacheable(cacheNames = "members", key = "#memberId")
public Member findMember(Long memberId) {
    return memberRepository.findById(memberId).orElseThrow();
}
```

### 1-4. 세 애너테이션의 관계 — 먼저 이것부터 세워야 한다

`@Cacheable`, `@CachePut`, `@CacheEvict`를 "캐시 관련 애너테이션 3종"으로 뭉뚱그려 외우면 반드시 사고가 난다. 셋은 하는 일이 겹치지 않고, **원본 메서드를 실행하는가**라는 기준 하나로 정확히 갈린다.

| | 원본 메서드 실행 | 캐시에 하는 일 | 한 줄 정의 |
|---|---|---|---|
| `@Cacheable` | **히트면 안 한다** | 미스일 때만 저장 | "있으면 안 부른다" |
| `@CachePut` | **항상 한다** | 결과로 항상 덮어쓴다 | "항상 부르고 결과를 덮어쓴다" |
| `@CacheEvict` | 항상 한다 | 지운다 | "지운다" |

```text
@Cacheable          @CachePut           @CacheEvict
   │                   │                    │
캐시 조회               │                    │
   ├─ 히트 → 반환 ✗    │                    │
   └─ 미스              │                    │
       ↓                ↓                    ↓
   메서드 실행       메서드 실행          메서드 실행
       ↓                ↓                    ↓
   캐시에 저장       캐시에 덮어쓰기       캐시에서 삭제
```

**여기서 주니어가 거의 반드시 한 번은 밟는 지뢰가 있다.** `@Cacheable`이라는 이름이 "캐시 가능" 혹은 "캐시에 넣는다"로 읽히기 때문에, **결과를 캐시에 반영하고 싶은 갱신 메서드에 `@Cacheable`을 붙이는** 것이다.

```java
// 문제: 이름만 보고 "결과를 캐시에 넣어 주겠지" 하고 갱신 메서드에 붙였다
@Cacheable(cacheNames = "members", key = "#member.id")
public Member updateMember(Member member) {
    return memberRepository.save(member);
}
```

무슨 일이 일어나는지 호출 순서대로 따라가 보자.

```text
1차 호출  updateMember(Member{id=1, name="변경전"})
          → 캐시 미스 → 메서드 실행 → DB 저장됨 → 캐시에 Member{id=1,"변경전"} 저장

2차 호출  updateMember(Member{id=1, name="변경후"})
          → 키 #member.id = 1 → 캐시 히트!
          → 메서드가 실행되지 않는다 ← save()가 아예 안 불린다
          → 캐시에 있던 "변경전"을 그대로 반환

결과: DB에는 저장이 안 되고, 화면에는 옛 값이 나오고, 예외는 안 난다.
```

**저장이 조용히 사라진다.** 예외도 경고도 없고, 심지어 메서드가 값을 리턴하기 때문에 성공한 것처럼 보인다. 1-2의 ③에서 밑줄 친 "히트면 원본 메서드가 실행되지 않는다"가 그대로 사고가 된 것이다.

```java
// 고침: 갱신에는 @CachePut — 항상 실행하고 그 결과로 캐시를 덮어쓴다
@CachePut(cacheNames = "members", key = "#member.id")
public Member updateMember(Member member) {
    return memberRepository.save(member);
}
```

`@CacheEvict`는 갱신과 삭제 양쪽에 쓸 수 있는데, `@CachePut`과의 선택 기준은 이렇다. **갱신 후의 값을 곧바로 다시 읽을 가능성이 높으면 `@CachePut`(미리 채워 둔다), 갱신 경로가 여러 개라 캐시에 넣을 "정확한 최종 값"을 이 메서드가 알지 못하면 `@CacheEvict`(지우고 다음 읽기에서 다시 채우게 한다)**다. 확신이 없으면 evict가 안전하다 — 틀린 값을 넣는 것보다 한 번 더 읽는 편이 낫다.

```java
// @CacheEvict: 캐시 무효화
@CacheEvict(cacheNames = "members", key = "#memberId")
public void deleteMember(Long memberId) { ... }

// allEntries = true: 해당 캐시 이름의 전체 엔트리 삭제
// beforeInvocation = true: 메서드 실행 "전에" 삭제한다.
//   기본값은 실행 후라서, 메서드가 예외를 던지면 삭제가 아예 일어나지 않는다.
//   "실패하더라도 캐시는 무조건 비워야 한다"면 before로 바꾼다.
@CacheEvict(cacheNames = "orgChart", allEntries = true, beforeInvocation = true)
public void rebuildOrgChart(Long companyId) { ... }
```

`beforeInvocation`의 기본값이 `false`라는 것도 짚고 넘어갈 값이 있다. 재구축 도중 예외가 나면 캐시에는 낡은 값이 그대로 남는데, 이 상태가 오히려 더 위험한 도메인(권한, 가격)이라면 `true`로 뒤집는다.

### 1-5. 프록시 기반의 공통 함정 — 자기 호출

캐시 로직은 **프록시에** 있는데, 같은 클래스 안에서 `this.method()`로 부르면 프록시를 거치지 않고 원본 객체를 직접 호출한다. 그래서 캐시가 아예 적용되지 않는다.

```java
@Service
public class MemberService {

    public MemberSummary summarize(Long memberId) {
        Member member = this.findMember(memberId);  // 문제: 프록시를 안 거쳐 캐시가 통째로 무시된다
        return MemberSummary.from(member);
    }

    @Cacheable(cacheNames = "members", key = "#memberId")
    public Member findMember(Long memberId) { ... }
}
```

에러도 경고도 없이 **조용히 캐시 없이 실행**되므로, "캐시를 붙였는데 DB 부하가 안 줄어든다"는 증상으로 한참 뒤에 발견된다. 히트율 지표가 없으면 발견 자체가 안 된다.

이 함정은 `@Cacheable`만의 것이 아니라 **프록시 기반 애너테이션 전부가 공유하는 제약**이다. CGLIB 프록시는 원본 클래스를 상속해 메서드를 오버라이드하는 방식이라 `private`·`final` 메서드도 가로챌 수 없다는 것까지 같은 원리에서 나온다.

원리와 네 가지 해법(별도 빈 분리, 자기 자신 주입, `AopContext.currentProxy()`, AspectJ)의 본론은 `11-transactional-self-invocation.md`에 있다. 면접에서는 **"프록시 기반 애너테이션은 전부 같은 제약을 공유한다"고 원리로 묶어 답하고 그 문서의 내용으로 이어 가면** 된다. 정석은 캐시 대상 메서드를 별도 빈으로 분리해 반드시 프록시를 통해 호출되게 하는 것이다.

## 2. 캐시 키와 조건 — 사고가 가장 많이 나는 대목

`@Cacheable`이 "무엇을, 어떤 이름으로" 저장하는지를 결정하는 것이 키다. 그리고 이 문서에서 가장 위험한 대목이 여기다.

### 2-1. 기본 키 생성기의 실제 규칙

`key`를 지정하지 않으면 `SimpleKeyGenerator`가 키를 만든다. 규칙은 딱 세 줄이고, 정확히 외워 둘 값이 있다.

| 파라미터 개수 | 만들어지는 키 |
|---|---|
| 0개 | `SimpleKey.EMPTY` (모든 무인자 호출이 같은 키를 공유한다) |
| 1개 | **그 파라미터 값 자체** (단, `null`이거나 배열이면 아래로 넘어간다) |
| 2개 이상 | 전부 묶은 `SimpleKey` 객체 (내부적으로 파라미터 배열의 `equals`/`hashCode`로 비교한다) |

여기서 **가장 중요한 사실**은 표에 없는 것이다.

> **기본 키에는 클래스 이름도, 메서드 이름도 들어가지 않는다. 파라미터 값만으로 키가 만들어진다.**

캐시 안에서 엔트리를 구분하는 것은 `(캐시 이름, 키)` 두 값뿐이므로, **같은 캐시 이름을 쓰는 서로 다른 두 메서드가 같은 값의 파라미터를 받으면 완전히 같은 자리에 쓰고 읽는다.**

### 2-2. 같은 캐시 이름을 공유하는 두 메서드가 서로의 값을 받아 간다

2-1의 사실이 실제로 어떻게 사고가 되는지 세 가지 모양으로 보자.

**모양 ① — 같은 클래스의 이름만 다른 두 메서드**

```java
// 문제: 캐시 이름이 같고 파라미터도 같은 모양이다 → 키가 완전히 동일하다
@Cacheable(cacheNames = "products")
public Product findProduct(Long productId) { ... }

@Cacheable(cacheNames = "products")
public ProductStock findStock(Long productId) { ... }
```

```text
findProduct(1L) 먼저 실행 → 캐시["products"][1L] = Product 인스턴스
findStock(1L)   나중에 실행 → 캐시["products"][1L] 히트 → Product를 반환
                → 호출부에서 ProductStock으로 캐스팅 → ClassCastException
```

예외가 터지면 그나마 다행이다. **두 메서드의 반환 타입이 같으면 예외조차 안 난다.** `findPriceByProductId(1L)`와 `findCostByProductId(1L)`가 둘 다 `Money`를 반환한다면, 원가가 판매가 자리에 조용히 들어앉는다.

**모양 ② — 다른 클래스의 같은 이름 메서드**

```java
// MemberService
@Cacheable(cacheNames = "members")
public Member find(Long id) { ... }

// AdminMemberService — 관리자용이라 마스킹을 풀고 내려준다
@Cacheable(cacheNames = "members")
public Member find(Long id) { ... }
```

클래스가 달라도 키에는 클래스가 안 들어가므로 **같은 자리**다. 관리자가 먼저 조회하면 마스킹이 풀린 주민번호가 캐시에 올라가고, 그다음 일반 사용자 조회가 그 값을 받아 간다. 이건 성능 버그가 아니라 개인정보 유출이다.

**모양 ③ — 진짜 오버로드**

오버로드된 두 메서드는 파라미터 목록이 달라야 하므로 대개 키도 달라지지만, **박싱만 다른 오버로드는 값이 같아진다.**

```java
// 문제: 두 오버로드가 결국 같은 Long 값을 키로 만든다
@Cacheable(cacheNames = "members")
public Member find(long id) { ... }        // 호출 시 Long.valueOf(id)로 박싱되어 넘어온다

@Cacheable(cacheNames = "members")
public Member find(Long id) { ... }        // 그대로 Long
// 프록시가 받는 args는 둘 다 Long — SimpleKeyGenerator는 그 Long을 그대로 키로 쓴다.
// 두 메서드가 완전히 같은 캐시 엔트리를 공유한다.
```

오버로드는 이 사고가 **가장 눈에 안 띄는 형태**다. 두 메서드가 나란히 붙어 있고 이름까지 같으니 "다른 메서드니까 다른 캐시겠지"라고 넘어가기 쉽다.

**고침은 두 층으로 한다.**

```java
// 고침 ①: 캐시 이름을 "저장하는 데이터의 의미" 단위로 분리한다.
//         한 캐시 이름에는 한 가지 타입, 한 가지 의미만 들어가게 한다.
@Cacheable(cacheNames = "products", key = "#productId")
public Product findProduct(Long productId) { ... }

@Cacheable(cacheNames = "productStocks", key = "#productId")   // 캐시 이름을 분리
public ProductStock findStock(Long productId) { ... }
```

```java
// 고침 ②: 키를 명시한다. 어차피 명시할 거라면 무엇으로 구분되는지가 코드에 남는다.
@Cacheable(cacheNames = "members", key = "'admin:' + #id")
public Member find(Long id) { ... }
```

원칙 한 줄. **캐시 이름은 "이 캐시에 무엇이 들어 있는가"를 말해야 하고, 그 이름 아래에는 한 종류만 들어가야 한다.**

### 2-3. 파라미터가 객체면 `equals`/`hashCode`가 없으면 히트율이 0이 된다

```java
// 문제: condition 객체에 equals/hashCode가 없다
@Cacheable(cacheNames = "search")
public List<Member> search(MemberSearchCondition condition) { ... }
```

`Object`의 기본 `equals`는 **참조 동일성**이다. 요청마다 새로 만들어지는 조건 객체는 내용이 완전히 같아도 서로 다른 객체이므로 키가 매번 달라진다.

```text
1번 요청: new MemberSearchCondition("서울", 20) → 키 A → 미스 → 저장
2번 요청: new MemberSearchCondition("서울", 20) → 키 B → 미스 → 저장   ← 내용은 같은데 다른 키
...
히트율 0% + 캐시에는 사실상 같은 값이 무한히 쌓인다 (메모리 누수처럼 보인다)
```

무서운 것은 **동작이 정상처럼 보인다**는 점이다. 결과는 다 맞고 응답도 나온다. 다만 캐시가 아무 일도 안 하고 있을 뿐이다.

```java
// 고침: record를 쓰면 equals/hashCode가 값 기반으로 자동 생성된다
public record MemberSearchCondition(String city, int minAge) {}
```

여기서 얻을 교훈은 **캐시는 붙였는지가 아니라 히트율로 확인해야 한다**는 것이다. `CacheMetricsRegistrar`나 Actuator의 캐시 지표로 히트/미스 비율을 대시보드에 올려 두지 않으면 이런 종류의 실패는 발견되지 않는다.

### 2-4. 키에 사용자·테넌트 식별자가 빠지면 보안 사고가 된다

출제 의도가 "다른 사용자의 데이터가 보이는 사고"라고 정확히 지목한 지점이다.

```java
// 문제: 회사(테넌트) 구분 없이 메뉴 권한을 캐싱한다
@Cacheable(cacheNames = "menuAuth", key = "#menuId")
public MenuAuth findMenuAuth(Long companyId, Long menuId) {
    return menuAuthRepository.find(companyId, menuId);
}
```

메서드는 `companyId`를 제대로 받아 DB를 정확히 조회한다. **문제는 키에만 그 값이 빠져 있다는 것**이다. 그래서 캐시 위에서는 회사 구분이 사라진다.

```text
t0  A사 사용자가 메뉴 100번 조회
    → 미스 → DB(A사, 100) 조회 → 캐시["menuAuth"][100] = A사의 권한 설정

t1  B사 사용자가 메뉴 100번 조회
    → 키가 100 → 히트! → A사의 권한 설정을 그대로 받는다
    → DB는 한 번도 안 갔고, 코드에는 아무 문제가 없어 보인다
```

```java
// 고침: 테넌트 식별자를 키에 반드시 포함한다
@Cacheable(cacheNames = "menuAuth", key = "#companyId + ':' + #menuId")
public MenuAuth findMenuAuth(Long companyId, Long menuId) { ... }
```

**이 사고가 특히 악질인 이유는 테스트로 잡히지 않는다는 것이다.** 단일 테넌트로 짠 테스트는 전부 통과한다. 통합 테스트도 대개 한 회사 데이터로 돌린다. 두 테넌트가 같은 인스턴스에서 같은 메뉴를 연달아 조회하는 상황은 운영에서만 생긴다.

그래서 **규칙을 사람의 기억이 아니라 구조에 맡기는 것**이 진짜 답이다.

```java
// 커스텀 KeyGenerator — 모든 키 앞에 현재 테넌트를 자동으로 붙인다
public class TenantAwareKeyGenerator implements KeyGenerator {

    @Override
    public Object generate(Object target, Method method, Object... params) {
        // 여기서 컨텍스트를 직접 읽는 이유: 개발자가 SpEL에 손으로 붙이는 것을 잊어도
        // 키에서 테넌트가 빠질 수 없게 만들기 위해서다. 빠뜨릴 자리를 없앤다.
        String tenant = TenantContext.currentTenantId();
        return tenant + ":" + SimpleKeyGenerator.generateKey(params);
    }
}
```

캐시 이름 자체에 테넌트 prefix를 붙이도록 `CacheManager` 레벨에서 처리하는 방법도 같은 계열이다. **"사람이 기억해서 지키는 규칙"을 "구조가 강제하는 규칙"으로 바꾸는 것**이 시니어의 답이다.

### 2-5. `key`에 SpEL을 쓸 때 알아 둘 것

`key` 속성은 SpEL(Spring Expression Language) 식이고, 여기서 쓸 수 있는 변수가 정해져 있다.

```java
@Cacheable(cacheNames = "orders", key = "#userId")                    // 파라미터 이름으로
@Cacheable(cacheNames = "orders", key = "#p0")                        // 인덱스로 (이름 정보가 없을 때)
@Cacheable(cacheNames = "orders", key = "#req.userId + ':' + #req.status")  // 객체 속성 조합
@Cacheable(cacheNames = "orders", key = "#root.methodName + ':' + #userId")  // 메서드 이름을 직접 넣기
```

`#root.methodName`은 2-2에서 본 충돌을 막는 손쉬운 방법이기도 하다. 다만 메서드 이름을 리팩터링하면 키가 통째로 바뀌어 기존 캐시가 전부 미스가 되므로, 배포 직후 원본에 부하가 몰릴 수 있다는 점은 알고 써야 한다.

문자열 키를 쓸 때는 **구분자가 값 안에 나타날 수 있는지**도 확인한다. `#a + ':' + #b`에서 `a="1:2", b="3"`과 `a="1", b="2:3"`은 둘 다 `"1:2:3"`이 되어 충돌한다. 값에 구분자가 섞일 수 있는 도메인이라면 구분자를 값에 안 나오는 문자로 바꾸거나 길이를 함께 넣는다.

### 2-6. `condition`과 `unless` — 평가 시점이 정반대다

주니어가 거의 구분하지 못하는 지점이고, 그래서 면접에서 잘 물어보는 지점이다. 둘 다 "조건부 캐싱"이지만 **언제 평가되는지**가 다르고, 그 차이에서 나머지가 전부 따라 나온다.

```text
                condition 평가        메서드 실행         unless 평가
  요청 ──────────────┬──────────────────────┬──────────────────┬────────▶
                     │                      │                  │
             파라미터만 볼 수 있다      원본 로직          결과(#result)를 볼 수 있다
             거짓이면 캐시 조회도        수행              참이면 저장만 건너뛴다
             저장도 통째로 건너뛴다
```

**`condition`은 메서드 실행 전에 평가된다.** 아직 결과가 없으니 파라미터만 보고 판단할 수 있고, `#result`는 참조할 수 없다. 거짓이면 **캐시 조회와 저장을 통째로 건너뛰고** 그냥 메서드만 실행한다.

```java
// id가 양수일 때만 캐시를 쓴다. 음수/임시 id로 캐시가 오염되는 것을 막는다.
@Cacheable(cacheNames = "members", condition = "#memberId > 0")
public Member findMember(Long memberId) { ... }
```

**`unless`는 메서드 실행 후에 평가된다.** 결과를 봤기 때문에 `#result`를 쓸 수 있고, 참이면 **저장만 거부한다**(이름 그대로 "이 조건이 아닌 한 저장한다"). 조회는 이미 실행 전에 끝났으므로 `unless`가 캐시 히트를 막지는 못한다.

```java
// null 결과는 캐시에 넣지 않는다 — 가장 흔한 용법이자 3-1의 트레이드오프가 시작되는 지점
@Cacheable(cacheNames = "members", unless = "#result == null")
public Member findMemberOrNull(Long memberId) { ... }
```

정리하면 이렇다.

| | `condition` | `unless` |
|---|---|---|
| 평가 시점 | 메서드 실행 **전** | 메서드 실행 **후** |
| `#result` 참조 | 불가 (`@Cacheable` 기준) | 가능 |
| 참일 때 | 캐시를 **쓴다** | 캐시에 저장을 **안 한다** |
| 영향 범위 | 조회 + 저장 둘 다 | 저장만 |

의미가 뒤집혀 있다는 것에 특히 주의한다. **`condition`은 참일 때 캐싱하고 `unless`는 참일 때 캐싱하지 않는다.** 이름이 각각 "이 조건이면"과 "이 조건이 아닌 한"이라서 그렇다.

한 가지 예외를 알아 두면 가산점이다. `@CachePut`은 항상 메서드를 실행하므로 그 `condition`은 **실행 후에 평가되고 `#result`를 참조할 수 있다.** "condition은 언제나 실행 전"이라고 외우면 이 지점에서 틀린다.

## 3. 만료·null·동시성 — 추상화 경계 밖의 문제들

### 3-1. null 캐싱 — "없음"을 기억할 것인가

스프링 캐시 추상화의 기본은 **null도 캐시 가능**이다. 구현체별로 조금씩 다르다.

- **Redis**: `null`을 그대로 직렬화할 수 없어 `NullValue`라는 마커 객체로 바꿔 저장한다(`allowNullValues` 기본값 `true`).
- **Caffeine**: null을 허용한다.
- `allowNullValues = false`로 설정하면 null 저장 시 예외가 난다.

문제는 "null을 캐시하는 게 맞느냐"인데, **양쪽 모두 대가가 있다.** 어느 쪽이 정답이 아니라 트레이드오프라는 것을 아는지가 이 질문의 핵심이다.

**null을 캐시하지 않으면(`unless = "#result == null"`) 캐시 관통이 생긴다.**

```text
없는 회원 id=99999를 반복 조회

요청1 → 캐시 미스 → DB 조회 → null → unless로 저장 거부
요청2 → 캐시 미스 → DB 조회 → null → 저장 거부
요청3 → 캐시 미스 → DB 조회 → null → 저장 거부
  ...
캐시가 아무것도 막지 못하고 요청이 그대로 DB를 "관통"한다.
```

이것을 **캐시 관통(cache penetration)**이라고 부른다. 캐시에 들어갈 값 자체가 없으니 캐시가 방패 역할을 전혀 못 하고 요청이 관통해 버린다는 뜻이다. 존재하지 않는 id를 무작위로 던지는 공격이 있으면 캐시를 통째로 무력화하고 DB를 직격할 수 있다.

**null을 캐시하면 이번엔 반대 문제가 생긴다.**

```text
t0     회원 id=1234 조회 → 없음 → null을 TTL 1시간으로 캐시
t0+5m  그 사람이 실제로 가입한다 (DB에는 데이터가 생겼다)
t0+6m  다시 조회 → 캐시 히트(null) → "없는 회원입니다"
       ...
t0+1h  TTL이 만료되어서야 겨우 보이기 시작한다
```

신규 가입자가 55분 동안 404를 받는다. "가입했는데 로그인이 안 된다"는 문의가 이 모양으로 들어온다.

| 선택 | 얻는 것 | 잃는 것 |
|---|---|---|
| null을 캐시함 | 없는 키 조회가 DB에 안 간다 (관통 차단) | "없음"이 TTL 동안 고정 — 새로 생긴 데이터가 안 보인다 |
| null을 캐시 안 함 | 새 데이터가 즉시 보인다 | 없는 키 조회가 매번 DB 관통 — 공격에 취약 |

**실무 절충안은 "null도 캐시하되 아주 짧은 TTL을 준다"**다. "없음"이라는 사실을 수십 초에서 수 분만 기억해서 관통은 막고, 새 데이터 반영 지연은 그 수십 초로 제한하는 것이다. 이를 위해 null 전용 캐시 이름을 따로 두고 TTL을 다르게 주는 구성이 자연스럽다(3-4 참고).

한 층 더 있다. **아예 존재할 수 없는 키를 DB에 가기 전에 걸러 내는 블룸 필터**를 앞에 두는 방법이다. 블룸 필터는 "확실히 없음" 또는 "아마 있음"만 답하는 확률적 자료구조라서, "확실히 없음"으로 판정된 요청은 캐시도 DB도 건드리지 않고 즉시 반환할 수 있다. 캐싱 쪽의 본론은 `05-redis-caching/06-cache-stampede.md`와 `05-redis-caching/05-look-aside-cache-aside-pattern.md`에 있다.

면접 답변으로는 이렇게 정리한다. **"데이터가 새로 생기는 빈도 vs 없는 키를 조회하는 빈도"라는 요구사항으로 고르는 문제이고, 대개는 짧은 TTL의 null 캐싱이 두 위험을 모두 줄인다.**

### 3-2. 동시에 미스가 몰리면 원본이 여러 번 실행된다 — `sync = true`

1-2의 의사코드를 다시 보면 "조회 → 미스 → 실행 → 저장" 사이에 아무 잠금이 없다. 그래서 같은 키에 대한 미스가 동시에 몰리면 **전부가 각자 메서드를 실행한다.**

```text
t0      캐시["orgChart"][7] 만료
t0+1ms  스레드 A: 미스 → 무거운 쿼리 시작
t0+2ms  스레드 B: 미스 → 무거운 쿼리 시작   (A가 아직 저장 전이라 B도 미스다)
t0+3ms  스레드 C: 미스 → 무거운 쿼리 시작
  ...   1,000개 스레드가 같은 쿼리를 1,000번 동시에 던진다
```

이것이 **캐시 스탬피드(cache stampede)**다. 평소에는 1초에 한 번도 안 나가던 무거운 쿼리가 만료 순간에 수백 번 동시에 나가 DB를 무너뜨린다.

`sync = true`를 주면 같은 키에 대해 **한 스레드만 실행하고 나머지는 그 결과를 기다린다.**

```java
@Cacheable(cacheNames = "orgChart", key = "#companyId", sync = true)
public OrgChart loadOrgChart(Long companyId) { ... }   // 수 초짜리 무거운 연산
```

다만 **한계를 정확히 말할 수 있어야 한다.** 이게 시니어 변별 지점이다.

**한계 ① — 로컬 범위에서만 막는다.** `sync = true`는 결국 자바 프로세스 안의 잠금이다. Caffeine은 `LoadingCache`의 키 단위 로딩으로 자체 지원하고, Redis는 스프링 데이터 레디스가 자바 쪽 잠금으로 흉내 낸다. 어느 쪽이든 **다른 JVM은 막지 못한다.**

```text
서버 4대 × sync = true
  → 각 서버에서는 한 스레드만 실행된다 (1,000번 → 1번)
  → 그러나 서버가 4대이므로 전체로는 4번 동시 실행된다
  → 1,000번을 4번으로 줄인 것이지 1번으로 만든 것이 아니다
```

전체에서 딱 한 번만 재계산되게 하려면 **Redis 분산 락**이 필요하다(`05-redis-caching/16-distributed-lock-pitfalls-redlock.md`). 다만 4번은 대개 견딜 만한 숫자라서, 분산 락의 복잡도를 지불할 가치가 있는지는 별도 판단이다.

**한계 ② — 함께 못 쓰는 속성이 있다.** `sync = true`일 때는 `unless`를 쓸 수 없고, 캐시 이름도 하나만 지정할 수 있으며, 같은 메서드에 다른 캐시 연산(`@CachePut`, `@CacheEvict`)을 겹칠 수 없다. 3-1에서 "null은 unless로 거른다"고 했는데 `sync`와 함께 쓰려면 다른 방법을 찾아야 한다는 뜻이다.

스탬피드 완화책 전체(지터, refresh-ahead, 분산 락)는 `05-redis-caching/06-cache-stampede.md`가 본론이다.

### 3-3. TTL은 애너테이션에 없다 — 이 질문의 핵심 함정

**`@Cacheable`에는 TTL(만료 시간) 속성이 존재하지 않는다.** 애너테이션에서 `ttl = ...`을 찾으면 못 찾는다. 이건 스프링이 빠뜨린 것이 아니라 **의도된 설계**이고, "왜 없는가"에 답하는 것이 이 질문의 본체다.

이유는 1-3에서 미리 본 계층 구조에 있다. 스프링 캐시 추상화가 정의한 `Cache` 인터페이스에는 **get·put·evict 세 동작밖에 없다.** 왜 그것만인가 — **모든 캐시 구현체가 공통으로 가진 개념이 그것뿐이기 때문이다.**

만료는 사정이 완전히 다르다. 구현체마다 개념 자체가 갈린다.

| 구현체 | 만료·퇴출 개념 |
|---|---|
| Redis | 키 단위 TTL. 만료 시각이 되면 서버가 지운다 |
| Caffeine | `expireAfterWrite`(쓴 뒤 경과), `expireAfterAccess`(마지막 접근 뒤 경과), `maximumSize`(크기 초과 시 LFU/LRU 유사 정책으로 퇴출), `refreshAfterWrite`(만료가 아니라 갱신) |
| Ehcache | TTL + TTI(time-to-idle) + 계층별(힙/오프힙/디스크) 별도 정책 |
| `ConcurrentMapCache` | **만료 개념이 아예 없다** |

`maximumSize`로 밀려나는 것은 "만료"인가 아닌가? `refreshAfterWrite`는 TTL인가 아닌가? `ConcurrentMapCache`에 `ttl = 10m`을 주면 어떻게 동작해야 하는가?

**공통 분모가 없는 것을 억지로 추상화하면 구현체마다 의미가 달라지는 애너테이션이 된다.** 그래서 스프링은 만료를 추상화하지 않고 구현체 설정에 남겼다. 애너테이션은 "어느 캐시에 넣을지"라는 **이름만** 말하고, 그 이름의 캐시가 어떤 성질을 갖는지는 `CacheManager`가 결정한다.

이 분업 자체가 답변의 골격이다. **"캐시 이름은 코드가 정하고, 그 캐시의 물리적 성질(저장소, TTL, 크기 상한)은 설정이 정한다."**

### 3-4. Redis — `RedisCacheConfiguration.entryTtl()`

```java
@Bean
public CacheManager cacheManager(RedisConnectionFactory factory) {
    RedisCacheConfiguration defaults = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(10));   // 이름을 따로 지정하지 않은 캐시의 기본 TTL

    // 캐시 이름별로 다른 TTL — 실무에서는 거의 필수다.
    // TTL의 근거는 "데이터가 얼마나 자주 바뀌는가"와 "얼마나 낡아도 괜찮은가"다.
    Map<String, RedisCacheConfiguration> perCache = Map.of(
            "members",  defaults.entryTtl(Duration.ofHours(1)),    // 잘 안 변한다 → 길게
            "orgChart", defaults.entryTtl(Duration.ofMinutes(5)),  // 자주 변한다 → 짧게
            "notFound", defaults.entryTtl(Duration.ofSeconds(30))  // 3-1의 null 캐싱용 → 아주 짧게
    );

    return RedisCacheManager.builder(factory)
            .cacheDefaults(defaults)
            .withInitialCacheConfigurations(perCache)
            .build();
}
```

부트를 쓰면 전역 기본값만은 프로퍼티로도 줄 수 있다.

```yaml
spring:
  cache:
    type: redis
    redis:
      time-to-live: 10m
      cache-null-values: true   # 3-1의 allowNullValues
```

다만 캐시 이름별 TTL은 프로퍼티로 표현할 수 없으므로 위의 `CacheManager` 빈이 필요하다.

### 3-5. Caffeine — `expireAfterWrite` 등

```java
@Bean
public CacheManager cacheManager() {
    CaffeineCacheManager manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
            .expireAfterWrite(Duration.ofMinutes(10))   // 쓴 지 10분이 지나면 만료
            .maximumSize(10_000));                      // 개수 상한 — 로컬 힙을 지키는 안전장치
    return manager;
}
// 또는 yml 한 줄로: spring.cache.caffeine.spec=expireAfterWrite=10m,maximumSize=10000
```

Caffeine에서 **캐시 이름별로 다른 TTL**을 주려면 이름마다 별도 빌더로 캐시를 등록한다.

```java
manager.registerCustomCache("orgChart",
        Caffeine.newBuilder()
                .expireAfterWrite(Duration.ofMinutes(5))
                .maximumSize(1_000)
                .build());
```

로컬 캐시에서는 `maximumSize`를 반드시 준다는 것도 짚어 둘 값이 있다. Redis는 별도 프로세스라 메모리가 넘치면 Redis가 죽지만, Caffeine은 **우리 애플리케이션의 힙**을 쓴다. 상한이 없으면 캐시가 커지다가 GC를 압박하고 결국 `OutOfMemoryError`로 애플리케이션 자체를 죽인다.

### 3-6. 캐시 이름별 TTL을 정하는 기준

TTL 숫자를 감으로 정하지 않으려면 기준이 있어야 한다. 두 질문으로 갈린다.

```text
① 이 데이터가 바뀌는 주기는?   → 그보다 짧게 잡으면 낡은 값을 볼 일이 거의 없다
② 낡은 값이 보이면 얼마나 곤란한가?
     권한·가격      → 매우 곤란 → 짧게 + 변경 시 즉시 evict
     회원 프로필     → 조금 곤란 → 중간
     공지 목록      → 별로     → 길게
```

그리고 **TTL은 무효화의 대체재가 아니라 안전망**이다. 변경 시 `@CacheEvict`로 즉시 지우는 것이 1차 방어이고, TTL은 "무효화 경로를 빠뜨렸을 때 최대 이만큼만 틀리게 하겠다"는 상한선이다. 무효화를 완벽하게 하는 것은 매우 어렵기 때문에 둘을 언제나 함께 둔다.

## 4. 꼬리질문 대비 포인트

### "`@Cacheable`, `@CachePut`, `@CacheEvict`는 각각 언제 쓰나요?"

기준을 **"원본 메서드를 실행하는가"** 하나로 잡고 답하면 깔끔하다.

`@Cacheable`은 "있으면 안 부른다" — 히트면 메서드를 실행하지 않으므로 **읽기 전용 조회에만** 쓴다. `@CachePut`은 "항상 부르고 결과를 덮어쓴다" — 갱신 메서드에서 결과를 캐시에 반영할 때. `@CacheEvict`는 "지운다" — 삭제, 또는 갱신 후의 정확한 최종 값을 이 메서드가 알지 못할 때.

**여기서 반드시 짚어야 할 실수가 있다.** 이름 때문에 `@Cacheable`을 갱신 메서드에 붙이는 경우가 흔하다 — "캐시 가능"이 "캐시에 넣어 준다"로 읽히기 때문이다. 그러면 두 번째 호출부터 캐시 히트가 나서 **`save()`가 아예 실행되지 않고 저장이 조용히 사라진다.** 예외도 안 나고 옛 값이 리턴되므로 성공한 것처럼 보인다.

`@CachePut`과 `@CacheEvict` 중 고를 때는 "이 메서드가 캐시에 넣을 정확한 값을 알고 있는가"로 판단한다. 확신이 없으면 evict가 안전하다 — 틀린 값을 넣는 것보다 다음 읽기에서 한 번 더 읽는 편이 낫다.

### "기본 키 생성 규칙을 정확히 설명해 주시겠어요?" (시니어 변별 포인트)

`SimpleKeyGenerator`의 규칙은 셋이다. **파라미터가 0개면 `SimpleKey.EMPTY`, 1개면 그 값 자체(단 null이거나 배열이면 제외), 2개 이상이면 전부 묶은 `SimpleKey`.**

그런데 진짜 답은 규칙에 없는 것이다. **키에는 클래스 이름도 메서드 이름도 들어가지 않는다.** 캐시 엔트리를 구분하는 것은 `(캐시 이름, 키)`뿐이므로, 같은 캐시 이름을 쓰는 두 메서드가 같은 값의 파라미터를 받으면 완전히 같은 자리에 읽고 쓴다.

사고 모양을 세 가지로 들면 좋다. ① 같은 클래스의 이름만 다른 두 메서드(`findProduct(1L)` / `findStock(1L)`) — 반환 타입이 다르면 `ClassCastException`이고, 같으면 **예외조차 없이 엉뚱한 값**이 나간다. ② 다른 클래스의 같은 이름 메서드 — 관리자용 조회가 캐시를 채우면 일반 사용자가 마스킹 안 된 값을 받아 간다. ③ 박싱만 다른 오버로드(`find(long)` / `find(Long)`) — 프록시에 도달할 때 둘 다 `Long`이라 키가 같아진다.

해법은 두 층이다. **캐시 이름을 "저장하는 데이터의 의미" 단위로 분리해 한 이름 아래 한 종류만 두고**, 그래도 겹칠 여지가 있으면 `key`를 명시하거나 `#root.methodName`을 키에 포함한다.

### "멀티테넌트 서비스에서 캐시 키 설계 시 반드시 넣어야 할 것은 무엇인가요?"

**테넌트 식별자(회사 ID 등)**, 사용자별 데이터라면 사용자 ID다. 빠뜨리면 A사가 채운 캐시를 B사가 받아 가는 **타사 데이터 유출** — 성능 버그가 아니라 보안 사고다.

이 사고의 성질까지 말해야 답이 완성된다. **메서드는 `companyId`를 정확히 받아 DB를 제대로 조회하는데 키에만 그 값이 빠져 있는 형태**라서 코드를 봐도 이상해 보이지 않는다. 그리고 **테스트로 잡히지 않는다** — 단일 테넌트 테스트는 전부 통과하고, 두 테넌트가 같은 인스턴스에서 같은 대상을 연달아 조회할 때만 재현된다.

그래서 대책은 "키에 꼭 넣읍시다"가 아니라 **구조로 강제하는 것**이다. 커스텀 `KeyGenerator`에서 현재 테넌트 컨텍스트를 읽어 모든 키에 자동으로 붙이거나, `CacheManager` 레벨에서 캐시 이름에 테넌트 prefix를 붙인다. **"사람이 기억해서 지키는 규칙"을 "빠뜨릴 자리가 없는 구조"로 바꾸는 것**이 시니어의 답이다.

### "`condition`과 `unless`의 차이가 뭔가요?"

**평가 시점이 다르고, 거기서 나머지가 전부 따라 나온다.**

`condition`은 메서드 실행 **전**에 평가된다. 아직 결과가 없으니 파라미터만 볼 수 있고 `#result`는 못 쓴다. 거짓이면 **캐시 조회와 저장을 통째로 건너뛴다.**

`unless`는 메서드 실행 **후**에 평가된다. 그래서 `#result`로 결과를 볼 수 있고, 참이면 **저장만 거부한다.** 조회는 이미 끝난 뒤라 `unless`로는 캐시 히트를 막을 수 없다.

의미도 뒤집혀 있다. **`condition`은 참일 때 캐싱하고, `unless`는 참일 때 캐싱하지 않는다.** 이름이 각각 "이 조건이면"과 "이 조건이 아닌 한"이라서다.

가산점으로 예외 하나를 덧붙이면 좋다. `@CachePut`은 항상 메서드를 실행하므로 그 `condition`은 실행 후에 평가되고 `#result`를 참조할 수 있다 — "condition은 언제나 실행 전"이라고 외우면 여기서 틀린다.

### "null을 캐시해야 하나요, 하지 말아야 하나요?"

**둘 다 대가가 있는 트레이드오프**라고 답하는 것이 정답 형태다.

`unless = "#result == null"`로 null을 캐시하지 않으면, 존재하지 않는 키를 반복 조회할 때 **매번 캐시를 그냥 통과해 DB를 때린다.** 이것이 **캐시 관통(cache penetration)**이다 — 캐시가 방패 역할을 전혀 못 하고 요청이 관통한다는 뜻이고, 없는 id를 무작위로 던지는 공격에 캐시가 통째로 무력해진다.

반대로 null을 캐시하면 **"없음"이 TTL 동안 고정된다.** 그 사이에 데이터가 실제로 생겨도 만료 전까지는 계속 "없음"이 나간다. 신규 가입자가 한 시간 동안 404를 받는 문의가 이 모양이다.

실무 절충은 **"null도 캐시하되 아주 짧은 TTL을 준다"**이다. "없음"을 수십 초만 기억해 관통은 막고 반영 지연은 그 수십 초로 제한한다. null 전용 캐시 이름을 따로 만들어 TTL을 다르게 주는 구성이 자연스럽다. 한 층 더 얹으면 **블룸 필터**로 존재할 수 없는 키를 캐시·DB에 가기 전에 걸러 내는 방법이 있다.

판단 기준을 한 줄로 말하면 **"데이터가 새로 생기는 빈도 vs 없는 키를 조회하는 빈도"**다.

### "TTL은 왜 애너테이션에 없나요? 어디서 설정하나요?" (시니어 변별 포인트)

"CacheManager 설정에서 합니다"까지는 절반이고, **왜 거기로 내려갔는지**를 말해야 이 질문의 의도에 답한 것이 된다.

스프링 캐시 추상화가 정의한 `Cache` 인터페이스에는 get·put·evict 세 동작밖에 없다. **모든 캐시 구현체가 공통으로 가진 개념이 그것뿐이기 때문**이다. 만료는 그렇지 않다 — Redis는 키 단위 TTL, Caffeine은 `expireAfterWrite`/`expireAfterAccess`/`maximumSize`/`refreshAfterWrite`, Ehcache는 TTL과 TTI를 따로 두고, `ConcurrentMapCache`에는 만료 개념이 아예 없다. 공통 분모가 없는 것을 억지로 추상화하면 **구현체마다 의미가 달라지는 애너테이션**이 된다.

그래서 분업이 이렇게 됐다. **애너테이션은 "어느 이름의 캐시에 넣을지"만 말하고, 그 캐시의 물리적 성질(저장소, TTL, 크기 상한)은 `CacheManager` 설정이 정한다.**

구체적으로는 Redis면 `RedisCacheConfiguration.entryTtl()`, Caffeine이면 `Caffeine.newBuilder().expireAfterWrite(...)`다. 여기에 **캐시 이름별로 다른 TTL을 주는 법**(Redis는 `withInitialCacheConfigurations`, Caffeine은 `registerCustomCache`)까지 붙이고, **TTL 값의 근거는 "데이터 변경 주기"와 "낡은 값이 보였을 때의 곤란함"**이라고 말하면 실무 경험이 드러난다.

마지막으로 **TTL은 무효화의 대체재가 아니라 안전망**이라는 관점을 덧붙이면 좋다. 변경 시 evict가 1차 방어이고, TTL은 "무효화를 빠뜨렸을 때 최대 이만큼만 틀리겠다"는 상한선이다.

### "캐시가 만료된 순간 같은 키로 요청 1,000개가 동시에 들어오면 어떻게 되나요?"

**캐시 스탬피드**다. 기본 동작은 1,000개 스레드가 전부 미스를 보고 전부 메서드를 실행한다 — 평소 잘 안 나가던 무거운 쿼리가 1,000번 동시에 DB를 때린다. 완화책을 계층별로 답한다.

1. **`sync = true`** — 같은 JVM 안에서는 한 스레드만 실행하고 나머지는 그 결과를 기다린다. 단일 인스턴스면 이걸로 충분한 경우가 많다.
2. **분산 락** — 서버가 4대면 `sync = true`로도 4번의 동시 실행이 남는다. "전체에서 딱 한 번만 재계산"이 필요하면 Redis 분산 락을 쓴다. 다만 4번이 견딜 만한 숫자라면 분산 락의 복잡도는 지불하지 않는 것도 정당한 판단이다.
3. **TTL 지터** — 같은 시각에 대량 적재된 캐시가 같은 시각에 일제히 만료되는 것 자체를 막기 위해 TTL에 무작위 오차를 섞는다.
4. **refresh-ahead** — 만료 **전에** 백그라운드로 미리 갱신한다. Caffeine의 `refreshAfterWrite`가 그것이고, 만료된 값이 아예 없어지는 구간을 만들지 않는다.

`sync = true`의 제약도 함께 말하면 정확한 답이 된다 — `unless`와 함께 쓸 수 없고, 캐시 이름을 하나만 지정할 수 있으며, 같은 메서드에 다른 캐시 연산을 겹칠 수 없다.

### "`@Cacheable`과 `@Transactional`을 같은 메서드에 쓰면 순서는 어떻게 되나요?"

둘 다 프록시 어드바이스이므로 **프록시 체인에서 누가 바깥인가**의 문제다. 기본 순서에서는 캐시 인터셉터가 트랜잭션 인터셉터보다 **바깥**에 있다.

```text
요청 ─▶ [캐시 인터셉터] ─▶ [트랜잭션 인터셉터] ─▶ 원본 메서드
         히트면 여기서 반환 ✗ (트랜잭션은 시작조차 안 된다)
```

조회 캐시에서는 이게 오히려 이득이다. **히트하면 DB 커넥션을 아예 잡지 않는다.**

주의할 것은 반대 상황이다. 캐시 저장(put)이 트랜잭션 **커밋 전**에 일어나므로, 저장 후 트랜잭션이 롤백되면 **DB에는 없는 값이 캐시에는 남는** 불일치가 생긴다. 대응은 캐시 조작을 커밋 이후로 미루는 것이다 — `TransactionAwareCacheManagerProxy`로 `CacheManager`를 감싸면 put/evict가 커밋 후에 반영되고, 더 명시적으로는 `@TransactionalEventListener(AFTER_COMMIT)`에서 무효화를 실행한다.

### "서버 2대가 각자 로컬 캐시(Caffeine)를 쓰면 무슨 문제가 생기나요?"

**인스턴스 간 불일치**다. A 서버에서 데이터를 수정하고 `@CacheEvict`로 무효화해도 그건 A의 로컬 캐시만 지운 것이고, B 서버는 TTL이 다할 때까지 옛 값을 계속 서빙한다.

사용자 눈에는 "수정했는데 새로고침하면 값이 왔다 갔다 한다"로 보인다 — 로드밸런서가 어느 서버로 보내느냐에 따라 다른 답이 나오기 때문이다. 재현이 안 되는 문의의 전형적 모양이다.

해법을 네 가지로 답한다.

1. **분산 캐시(Redis)로 전환** — 모두가 같은 캐시를 본다. 대신 매 조회에 네트워크 왕복이 붙는다.
2. **무효화 브로드캐스트** — 로컬 캐시는 유지하되 변경 이벤트를 Redis pub/sub 등으로 전 인스턴스에 뿌려 각자 evict하게 한다.
3. **2단 캐시(near cache)** — 로컬(빠름) + Redis(일관성)를 겹치고 무효화는 pub/sub으로. 성능과 일관성의 절충안이다.
4. **짧은 TTL로 감수** — "이 데이터가 몇 초의 불일치를 견딜 수 있나"가 판단 기준이고, 견딜 수 있다면 가장 단순한 답이다.

### "`@CacheEvict`만으로 무효화가 부족해지는 경우는 언제인가요?"

`@CacheEvict`는 **캐시를 쓰는 그 애플리케이션의, 그 메서드를 거친 변경**만 잡는다. 그래서 두 경우에 무너진다.

- **다른 서비스·배치·DBA가 DB를 직접 바꾸는 경우.** 그 경로는 `@CacheEvict`를 지나가지 않으므로 캐시는 낡은 채로 남는다.
- **변경 메서드가 여러 곳이라 evict를 빠뜨리는 경우.** 새 갱신 경로를 추가하면서 evict를 안 붙이면 조용히 낡은 값이 남는다.

해법은 무효화를 애너테이션이 아니라 **이벤트 기반으로 옮기는 것**이다. 데이터 변경 시 도메인 이벤트나 메시지(Kafka, Redis pub/sub)를 발행하고 캐시 보유자들이 구독해 evict한다. 더 근본적으로는 **CDC**(Debezium 등)로 DB 변경 자체를 구독하면 "어떤 경로로 바뀌었든" 무효화를 걸 수 있다.

그럼에도 완벽한 무효화는 어렵기 때문에 **TTL을 최후의 안전망으로 항상 함께 둔다.** "캐시 무효화는 컴퓨터 과학의 두 가지 어려운 문제 중 하나"라는 농담이 괜히 있는 게 아니다.

### "같은 클래스 안에서 `@Cacheable` 메서드를 호출하면 어떻게 되나요?"

적용되지 않는다. 캐시 로직은 **프록시에** 있는데 `this.method()`는 프록시를 거치지 않고 원본 객체를 직접 부르기 때문이다. `@Transactional` 자기 호출 문제와 완전히 같은 원리이고, CGLIB 프록시가 `private`·`final` 메서드를 못 가로채는 것도 같은 뿌리에서 나온다.

가장 무서운 점은 **에러도 경고도 없이 조용히 캐시 없이 실행된다**는 것이다. 히트율 모니터링이 없으면 "캐시를 붙였는데 DB 부하가 안 줄어든다"는 증상으로 한참 뒤에 발견된다.

해결은 캐시 대상 메서드를 별도 빈으로 분리해 반드시 프록시를 통해 호출되게 하는 것이 정석이고, 자세한 대안 비교는 `11-transactional-self-invocation.md`에 있다.

---

## 한 줄 요약

`@Cacheable`은 프록시가 메서드 앞에서 키로 캐시를 조회해 히트면 원본 실행을 건너뛰고 미스일 때만 실행 결과를 저장하는 read-through 추상화이고 — 그래서 "히트면 메서드가 안 돌아간다"는 성질이 갱신 메서드에 `@Cacheable`을 붙이는 순간 저장이 조용히 사라지는 사고가 되며(갱신은 `@CachePut`, 확신 없으면 `@CacheEvict`), 기본 키 생성기가 클래스도 메서드도 키에 넣지 않고 파라미터 값만 쓴다는 사실이 같은 캐시 이름을 공유하는 두 메서드의 값 뒤바뀜과 테넌트 식별자 누락에 의한 타사 데이터 유출로 이어지고(사람의 기억 대신 커스텀 `KeyGenerator`로 구조가 강제하게 만든다), null 캐싱은 캐시 관통과 반영 지연 사이의 트레이드오프라 짧은 TTL로 절충하며, TTL이 애너테이션에 없는 것은 만료의 의미가 구현체마다 달라 추상화 대상에서 빠졌기 때문이므로 `CacheManager` 설정에서 캐시 이름별로 준다 — 이 네 가지가 "추상화의 경계가 어디까지인가"를 아는 답변의 전부다.
