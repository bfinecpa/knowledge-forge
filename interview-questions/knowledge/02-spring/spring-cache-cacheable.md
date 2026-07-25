# Spring Cache 추상화(@Cacheable)의 동작 원리와 함정 — "TTL 속성을 애너테이션에서 찾다가 못 찾는" 이유까지

> 핵심 관전 포인트: **@Cacheable은 프록시가 메서드 호출을 가로채서
> 캐시 키로 먼저 조회하고, 히트면 메서드를 실행하지 않고 캐시값을
> 반환, 미스면 실행 후 결과를 캐시에 저장하고 반환하는 read-through
> 구조다. CacheManager/Cache 추상화 위에 Caffeine·Redis·EhCache 같은
> 구현체를 갈아끼운다. 프록시 기반이라 자기 호출에는 적용되지 않고
> (@Transactional과 동일 원리), 키 설계를 잘못하면 충돌·데이터 유출이
> 나며, null 캐싱은 "없음이 고정" vs "캐시 관통"의 트레이드오프다.
> 그리고 결정적으로 — @Cacheable에는 TTL 속성이 없다. 만료는 추상화
> 대상이 아니어서 구현체 설정(RedisCacheConfiguration, Caffeine spec)에서
> 해야 한다.**

---

## 0. 질문 + 의도

**질문**: "Spring Cache 추상화(`@Cacheable`)의 동작 원리와 함정은? (자기 호출
미적용, 캐시 키 설계, null 캐싱, TTL은 어디서 설정하나)"

**출제 의도**: 캐시 추상화도 AOP 프록시 위에 있어 자기 호출에 무력하고,
캐시 키 설계 실수는 "다른 사용자의 데이터가 보이는" 사고로 직결된다.
애너테이션 한 줄의 편의 뒤에 있는 동작(키 생성 규칙, null 처리, TTL은
캐시 매니저 설정임)을 확인하고 쓰는지 — Redis/캐싱 지식이 스프링 계층에
착지하는 지점을 검증하는 질문이다.

## 1. 동작 원리 — 프록시가 "조회 → 없으면 실행+저장"을 대신한다

`@Cacheable`을 붙이면 스프링이 그 빈을 감싸는 **프록시 객체**를 만들고,
다른 빈이 주입받는 것은 이 프록시다. @Transactional과 완전히 같은
메커니즘(Spring AOP)이고, 가로채서 하는 일만 다르다.

프록시가 하는 일을 의사코드로 풀면 이렇다:

```java
// 프록시가 하는 일 (개념적으로)
public Member findMember(Long memberId) {
    Object key = keyGenerator.generate(target, method, memberId); // ① 캐시 키 생성
    Cache.ValueWrapper hit = cache.get(key);                      // ② 캐시 조회

    if (hit != null) {
        return (Member) hit.get();      // ③ 히트 → 메서드 실행 없이 즉시 반환
    }

    Member result = target.findMember(memberId);  // ④ 미스 → 진짜 메서드 실행
    cache.put(key, result);                       // ⑤ 결과를 캐시에 저장
    return result;                                // ⑥ 반환
}
```

이 패턴을 **read-through**(읽기 경로에 캐시를 끼워넣고, 미스 시 원본을
읽어 캐시를 채우는 방식)라고 부른다. 개발자는 캐시 조회/저장 코드를
한 줄도 안 쓰고, 프록시가 메서드 앞뒤에서 대신 해준다.

### 추상화 구조 — 구현체를 갈아끼우는 이유

```
@Cacheable (애너테이션)
    ↓
CacheInterceptor (프록시가 실행하는 AOP 어드바이스)
    ↓
CacheManager (캐시들의 관리자 — "orders"라는 이름으로 Cache를 꺼내줌)
    ↓
Cache (get/put/evict 인터페이스)
    ↓
구현체: CaffeineCache / RedisCache / EhCache / ConcurrentMapCache ...
```

비즈니스 코드는 `@Cacheable(cacheNames = "members")`만 알고,
그 "members" 캐시가 로컬 메모리(Caffeine)인지 원격 Redis인지는
`CacheManager` 빈 설정에서 결정된다. 그래서 "처음엔 Caffeine으로
시작했다가 서버가 여러 대가 되면 Redis로 교체"가 애너테이션
수정 없이 설정 교체만으로 가능하다 — 이것이 추상화의 값어치다.

```java
@Cacheable(cacheNames = "members", key = "#memberId")
public Member findMember(Long memberId) {
    return memberRepository.findById(memberId).orElseThrow();
}
```

## 2. 프록시 공통 함정 — 자기 호출에는 적용 안 됨

@Transactional, @Async와 **완전히 같은 함정**이다. 캐시 조회/저장
코드는 프록시에 있는데, `this.method()`는 프록시를 거치지 않고
원본 객체를 직접 부른다.

```java
@Service
public class MemberService {

    public MemberSummary summarize(Long memberId) {
        Member member = this.findMember(memberId);  // ❌ 캐시 안 탐 — 매번 DB 조회
        return MemberSummary.from(member);
    }

    @Cacheable(cacheNames = "members", key = "#memberId")
    public Member findMember(Long memberId) { ... }
}
```

에러도 경고도 없이 **조용히 캐시 없이 실행**되므로, "캐시를 붙였는데
DB 부하가 안 줄어든다"는 증상으로 나중에 발견된다. 해결은 캐시 대상
메서드를 별도 빈으로 분리해 프록시를 통해 호출되게 하는 것이 정석.
CGLIB 프록시는 오버라이드 방식이라 **private/final 메서드도 가로챌 수
없어** 마찬가지로 적용되지 않는다 — "프록시 기반 애너테이션은 전부
같은 제약을 공유한다"고 원리로 묶어 답하면 좋다.

## 3. 정밀 제어 속성 — "그런 건 안 되지 않나?"가 오답인 것들

@Cacheable을 "붙이면 무조건 캐시"로만 알면 절반만 아는 것이다.
언제 캐싱할지/뺄지를 선언적으로 제어하는 속성이 다 있다.

### condition — 파라미터 기반 사전 판단

메서드 실행 **전에** 파라미터를 보고, 조건이 참일 때만 캐시를
조회/저장한다. 거짓이면 캐시 자체를 건너뛰고 그냥 메서드만 실행.

```java
// id가 양수일 때만 캐싱 시도 (임시/음수 id는 캐시 오염 방지)
@Cacheable(cacheNames = "members", condition = "#memberId > 0")
public Member findMember(Long memberId) { ... }
```

### unless — 결과 기반 사후 제외

메서드 실행 **후에** 결과를 보고, 조건이 참이면 캐시에 **저장하지
않는다** (조회는 정상 수행). `#result`로 리턴값을 참조한다.

```java
// null 결과는 캐시에 넣지 않기 — 가장 흔한 용법
@Cacheable(cacheNames = "members", unless = "#result == null")
public Member findMemberOrNull(Long memberId) { ... }
```

condition은 "실행 전, 파라미터로", unless는 "실행 후, 결과로" —
방향이 반대라는 걸 정확히 구분해 말하면 가산점.

### sync = true — 동시 미스 시 한 스레드만 실행

캐시 미스가 동시에 몰리면 기본 동작은 **전부 각자 메서드를 실행**한다
(같은 DB 쿼리 N번). `sync = true`를 주면 같은 키에 대해 **한 스레드만
실행하고 나머지는 그 결과를 기다린다** — 캐시 스탬피드 완화 장치.

```java
@Cacheable(cacheNames = "orgChart", key = "#companyId", sync = true)
public OrgChart loadOrgChart(Long companyId) { ... }  // 비싼 연산
```

단, 구현체가 지원해야 하고(Caffeine은 자체 지원, Redis는 스프링이
로컬 락으로 흉내 — **같은 JVM 안에서만** 직렬화됨), sync 모드에서는
unless 등 일부 속성 조합이 제한된다.

### @CachePut / @CacheEvict — 갱신과 무효화

```java
// @CachePut: 항상 메서드를 실행하고, 결과로 캐시를 갱신 (조회 안 함)
@CachePut(cacheNames = "members", key = "#member.id")
public Member updateMember(Member member) { ... }

// @CacheEvict: 캐시 무효화
@CacheEvict(cacheNames = "members", key = "#memberId")
public void deleteMember(Long memberId) { ... }

// allEntries = true: 해당 캐시 이름의 전체 엔트리 삭제
// beforeInvocation = true: 메서드 실행 "전에" 삭제
//   (기본은 실행 후 — 메서드가 예외를 던지면 삭제가 안 되는데,
//    "실패해도 무조건 지워야 한다"면 before로)
@CacheEvict(cacheNames = "orgChart", allEntries = true, beforeInvocation = true)
public void rebuildOrgChart(Long companyId) { ... }
```

## 4. 캐시 키 설계 — 충돌과 데이터 유출의 근원

### 기본 키 생성 — SimpleKeyGenerator

key를 지정하지 않으면 `SimpleKeyGenerator`가 **파라미터 전체를 조합**해
키를 만든다. 파라미터 0개면 `SimpleKey.EMPTY`, 1개면 그 값 자체,
여러 개면 전부 묶은 `SimpleKey` 객체.

여기서 나오는 함정들:

**① 파라미터가 객체면 equals/hashCode가 필수**

```java
@Cacheable(cacheNames = "search")
public List<Member> search(MemberSearchCondition condition) { ... }
// condition에 equals/hashCode가 없으면 → 매번 다른 키 → 캐시 히트 0%
// (Object 기본 equals는 참조 동일성이라 새 객체마다 다른 키가 됨)
```

record를 쓰거나 equals/hashCode를 구현해야 한다. 히트율이 0%여도
동작은 정상처럼 보이기 때문에 모니터링 없이는 발견이 늦는다.

**② 같은 캐시명 + 같은 키 = 충돌 (타입 캐스팅 에러)**

```java
@Cacheable(cacheNames = "members", key = "#id")
public Member findMember(Long id) { ... }

@Cacheable(cacheNames = "members", key = "#id")   // ❌ 같은 캐시, 같은 키 형태
public MemberProfile findProfile(Long id) { ... }
// findMember(1L)이 먼저 캐시를 채우면, findProfile(1L)은
// 캐시에서 Member를 꺼내 MemberProfile로 캐스팅 → ClassCastException
```

캐시 이름은 "저장하는 데이터의 의미" 단위로 분리하고, 한 캐시
이름에는 한 가지 타입만 들어가게 설계한다.

**③ 키에 사용자/테넌트 구분 누락 = 데이터 유출 (멀티테넌트 치명타)**

```java
// ❌ 회사(테넌트) 구분 없이 메뉴 권한을 캐싱
@Cacheable(cacheNames = "menuAuth", key = "#menuId")
public MenuAuth findMenuAuth(Long menuId) { ... }
// A사가 먼저 조회해 캐시를 채우면, B사 사용자도 A사의 권한 설정을 받는다.
// IAM/B2B 멀티테넌트 서비스에서는 "타사 데이터가 보이는" 보안 사고.

// ✅ 테넌트 ID를 키에 반드시 포함
@Cacheable(cacheNames = "menuAuth", key = "#companyId + ':' + #menuId")
public MenuAuth findMenuAuth(Long companyId, Long menuId) { ... }
```

기능 테스트로는 잡기 어렵다 — 단일 테넌트로 테스트하면 멀쩡하고,
운영에서 테넌트가 섞일 때만 터진다. 멀티테넌트 코드베이스라면
"캐시 키에 테넌트 식별자가 있는가"를 코드 리뷰 체크리스트에 박아야
한다. (실무 도메인이 IAM/B2B라면 이 포인트를 자기 경험으로 연결해
말하는 것이 가장 강한 답변이다.)

## 5. null 캐싱 — "없음을 기억할 것인가"의 트레이드오프

스프링 캐시 추상화의 기본은 **null도 캐시 가능**이다. 다만 구현체마다
다르다:

- **Redis**: null을 그대로 직렬화할 수 없어 `NullValue`라는 마커
  객체로 바꿔 저장한다 (기본 allowNullValues = true).
- **Caffeine**: null 허용.
- 일부 구현체/설정(allowNullValues = false)에서는 null 저장 시 예외.

문제는 "null을 캐시하는 게 맞느냐"인데, 양쪽 다 비용이 있다:

| 선택 | 결과 |
|---|---|
| null을 캐시함 | "없음"이 TTL 동안 고정 — 그 사이 데이터가 새로 생겨도 안 보임 (신규 가입자가 계속 404) |
| null을 캐시 안 함 (`unless = "#result == null"`) | 없는 키 조회가 **매번 DB 관통** — 존재하지 않는 id를 반복/악의적으로 조회하면 캐시가 무력화되고 DB가 직격 (캐시 관통, cache penetration) |

실무 절충안: **null도 캐시하되 짧은 TTL을 준다.** "없음"이라는 사실을
잠깐(수십 초~수 분)만 기억해서 관통 공격은 막고, 신규 데이터 반영
지연은 짧게 제한하는 것. 이를 위해 null용 캐시 이름을 분리해 TTL을
따로 주는 구성이 자연스럽다 (다음 절의 캐시별 TTL 커스터마이징 참조).
어느 쪽이 정답이 아니라 "데이터가 새로 생기는 빈도 vs 없는 키 조회
빈도"라는 요구사항으로 고르는 문제라고 답하면 시니어 답변이다.

## 6. TTL은 애너테이션에 없다 — 이 질문의 핵심 함정

**@Cacheable에는 TTL(만료 시간) 속성이 존재하지 않는다.** 애너테이션에서
`ttl = ...`을 찾으면 못 찾는다. 이유는 설계 철학 —
스프링 캐시 추상화는 get/put/evict라는 **공통 분모만** 추상화했고,
만료 정책은 구현체마다 개념이 너무 달라(TTL, TTI, 크기 기반, 참조
기반...) **추상화하지 않았다**. 그래서 TTL은 구현체 설정에서 준다.

### Redis — RedisCacheConfiguration.entryTtl()

```java
@Bean
public CacheManager cacheManager(RedisConnectionFactory factory) {
    RedisCacheConfiguration defaults = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(10));          // 기본 TTL 10분

    // 캐시 이름별로 다른 TTL — 실무에서 거의 필수
    Map<String, RedisCacheConfiguration> perCache = Map.of(
            "members",     defaults.entryTtl(Duration.ofHours(1)),   // 잘 안 변함 → 길게
            "orgChart",    defaults.entryTtl(Duration.ofMinutes(5)), // 자주 변함 → 짧게
            "notFound",    defaults.entryTtl(Duration.ofSeconds(30)) // null 캐싱용 → 아주 짧게
    );

    return RedisCacheManager.builder(factory)
            .cacheDefaults(defaults)
            .withInitialCacheConfigurations(perCache)
            .build();
}
```

### Caffeine — spec(expireAfterWrite 등)

```java
@Bean
public CacheManager cacheManager() {
    CaffeineCacheManager manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
            .expireAfterWrite(Duration.ofMinutes(10))   // 쓴 지 10분 후 만료
            .maximumSize(10_000));                      // 크기 제한 (로컬 메모리 보호)
    return manager;
}
// 또는 yml: spring.cache.caffeine.spec=expireAfterWrite=10m,maximumSize=10000
```

Caffeine에서 캐시별로 다른 TTL을 주려면 캐시 이름마다 별도
`Caffeine` 빌더로 캐시를 등록하는 커스터마이징이 필요하다
(`manager.registerCustomCache("orgChart", Caffeine.newBuilder()...build())`).

면접에서 "TTL은 어디서 설정하나"는 **추상화의 경계가 어디까지인지
아는지**를 묻는 질문이다. "애너테이션에는 없고, 만료는 추상화 대상이
아니라서 CacheManager 설정에서 구현체별로 준다"가 정답 골격이고,
"캐시 이름별로 데이터 변경 빈도에 맞춰 TTL을 다르게 준다"까지 붙이면
실무 경험이 드러난다.

---

## 7. 꼬리질문 대비 포인트

### "캐시가 만료된 순간 같은 키로 요청 1000개가 동시에 들어오면?"

캐시 스탬피드(cache stampede, thundering herd). 기본 동작은 1000개
스레드가 **전부 미스를 보고 전부 메서드를 실행** — 비싼 쿼리가 1000번
동시에 DB를 때린다. 완화책을 계층별로:

1. **`sync = true`** — 같은 JVM 안에서는 한 스레드만 실행, 나머지는
   대기. 단일 인스턴스면 이걸로 충분한 경우가 많다.
2. **분산 락** — 서버가 N대면 sync=true로도 N개의 동시 실행은 남는다.
   Redis 분산 락(Redisson 등)으로 "전체에서 한 놈만 재계산"을 보장.
3. **TTL 지터(jitter)** — 같은 시각에 대량 적재된 캐시가 같은 시각에
   일제히 만료되는 것 자체를 막기 위해 TTL에 랜덤 오차를 섞는다.
4. (심화) 만료 **전에** 백그라운드로 미리 갱신하는 refresh-ahead —
   Caffeine의 `refreshAfterWrite`.

### "@Cacheable과 @Transactional을 같은 메서드에 쓰면 순서는?"

둘 다 프록시 어드바이스라 **프록시 체인에서의 순서** 문제다. 기본
순서상 캐시 인터셉터가 트랜잭션 인터셉터보다 **바깥**에 있다 —
즉 캐시 조회가 먼저고, **캐시 히트면 트랜잭션은 시작조차 안 된다**
(조회 캐시로는 이게 오히려 이득 — 커넥션을 안 잡는다). 주의할 것은
반대 상황: 캐시에 저장(put)되는 시점이 트랜잭션 **커밋 전**이라,
저장 후 트랜잭션이 롤백되면 **DB에는 없는 값이 캐시에는 남는**
불일치가 날 수 있다. 이를 다루려면 커밋 후에 캐시를 조작하도록
`TransactionAwareCacheManagerProxy`(커밋 후 put/evict 반영)를 쓰거나
`@TransactionalEventListener(AFTER_COMMIT)`로 무효화를 미룬다.

### "서버 2대가 각자 로컬 캐시(Caffeine)를 쓰면 무슨 문제가 생기나?"

**인스턴스 간 불일치.** A 서버에서 데이터를 수정하고 @CacheEvict로
무효화해도, 그건 A의 로컬 캐시만 지운 것 — B 서버는 TTL이 다할 때까지
옛날 값을 계속 서빙한다. 사용자가 "수정했는데 새로고침하면 왔다갔다
한다"(로드밸런서가 어느 서버로 보내느냐에 따라)는 전형적 증상. 해법:

1. **분산 캐시(Redis)로 전환** — 모두가 같은 캐시를 봄. 대신 네트워크
   왕복 비용.
2. **무효화 브로드캐스트** — 로컬 캐시는 유지하되, 변경 이벤트를
   Redis pub/sub 등으로 전 인스턴스에 뿌려 각자 evict.
3. **2단 캐시(near cache)** — 로컬(빠름) + Redis(일관성)를 겹치고
   무효화는 pub/sub으로. 성능과 일관성의 절충.
4. 불일치를 감수할 수 있는 데이터라면 **짧은 TTL**만으로 때우는 것도
   유효한 선택 — "이 데이터가 몇 초의 불일치를 견딜 수 있나"가 판단
   기준이다.

### "캐시 무효화 전략 — @CacheEvict만으로 부족한 경우는?"

@CacheEvict는 **캐시를 쓰는 그 애플리케이션의, 그 메서드를 거친
변경**만 잡는다. 부족해지는 경우:

- **다른 서비스/배치/DBA가 데이터를 직접 바꾸는 경우** — 그 경로는
  @CacheEvict를 안 지나가므로 캐시는 낡은 채로 남는다.
- 변경 메서드가 여러 곳이라 evict 누락이 생기기 쉬운 경우.

해법은 무효화를 애너테이션이 아니라 **이벤트 기반**으로 옮기는 것:
데이터 변경 시 도메인 이벤트/메시지(Kafka, Redis pub/sub)를 발행하고
캐시 보유자들이 구독해서 evict. 더 근본적으로는 DB 변경 자체를
구독하는 CDC(Debezium 등)로 "어떤 경로로 바뀌었든" 무효화를 보장.
그래도 완벽한 무효화는 어렵기 때문에 **TTL을 최후의 안전망**으로
항상 함께 두는 것이 실무 정석이다 ("캐시 무효화는 컴퓨터 과학의 두
가지 어려운 문제 중 하나"라는 농담이 괜히 있는 게 아니다).

### "멀티테넌트 서비스에서 캐시 키 설계 시 반드시 넣어야 할 것은?"

**테넌트 식별자(회사 ID 등).** 누락하면 A사가 채운 캐시를 B사가
받아가는 **타사 데이터 유출** — 성능 버그가 아니라 보안 사고다.
사용자별 데이터라면 사용자 ID도 마찬가지. 실수 방지 장치까지 말하면
좋다: 키 SpEL에 매번 손으로 붙이지 말고 **커스텀 KeyGenerator**로
현재 테넌트 컨텍스트(ThreadLocal 등)를 모든 키에 자동 포함시키거나,
아예 CacheManager 레벨에서 캐시 이름에 테넌트 prefix를 붙이는 방식.
"사람이 기억해서 지키는 규칙"을 "구조가 강제하는 규칙"으로 바꾸는
것이 시니어의 답이다.

### "같은 클래스 안에서 @Cacheable 메서드를 호출하면?"

적용되지 않는다. 캐시 로직은 프록시에 있는데 `this.method()`는
프록시를 안 거치기 때문 — @Transactional 자기 호출 문제와 동일
원리다. 조용히 캐시 없이 실행되므로 히트율 모니터링이 없으면 발견도
늦다. 해결은 별도 빈으로 분리가 정석.

---

## 한 줄 요약

@Cacheable은 프록시가 메서드 앞에서 키로 캐시를 조회해 히트면 실행을
건너뛰고 미스면 실행 결과를 저장하는 read-through 추상화라서 —
자기 호출 미적용(프록시 공통 함정), 키 설계 실수(equals/hashCode·캐시명
충돌·테넌트 누락 시 데이터 유출), null 캐싱의 트레이드오프(없음 고정
vs 캐시 관통)가 전부 이 구조에서 나오고, TTL은 추상화 대상이 아니라
애너테이션이 아닌 구현체 설정(Redis entryTtl, Caffeine spec)에서 캐시
이름별로 주는 것까지 알아야 "추상화의 경계"를 이해한 답변이 된다.
