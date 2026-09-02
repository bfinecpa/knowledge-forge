# LazyInitializationException — 처방의 범위를 문제의 범위에 맞춘다

> 핵심 관전 포인트: **원인을 정확히 말하면 "트랜잭션이 끝나서"가 아니라 `EntityManager`(세션)가 닫힌 뒤에 프록시 초기화를 요청해서다. 이 구분이 결정적인 이유는 OSIV가 정확히 그 틈을 이용하는 장치이기 때문이다 — 트랜잭션은 서비스에서 끝났는데 `EntityManager`는 응답이 끝날 때까지 열어둔다. Spring Boot에서 `spring.jpa.open-in-view`가 기본 `true`라서, 많은 팀이 이 예외를 거의 못 보고 지나간다. 해결책은 네 가지인데 중요한 것은 목록이 아니라 범위다: fetch join / `@EntityGraph`는 그 쿼리 한 곳에만 듣는 지점별 처방, 트랜잭션 안에서 DTO 변환은 엔티티가 계층을 넘지 않게 하는 근본 처방, 트랜잭션 범위 확대는 커넥션 보유 시간을 늘려 대용량에서 금지, EAGER 전환과 OSIV는 전역 스위치로 덮는 증상 은폐다. 예외는 한 지점에서 났는데 EAGER는 모든 쿼리를 바꾼다 — 처방의 범위가 문제의 범위보다 크면 그건 해결이 아니라 이동이다.**

---

## 0. 질문 + 의도

**질문**: "`LazyInitializationException`은 왜 발생하나요? 해결 방법들(트랜잭션 범위 조정, fetch join, DTO 변환 시점)과 각각의 트레이드오프는?"

**출제 의도**: JPA 입문자가 가장 먼저 부딪히는 예외이고, 해결책의 선택(트랜잭션 연장? fetch join? DTO 변환 시점 이동?)이 곧 계층 설계 이해를 드러낸다. "무조건 EAGER로" 또는 "OSIV 켜서" 같은 답은 증상 은폐임을 아는지 — 예외 하나로 영속성 컨텍스트의 생명주기 전체를 검증하는 효율 높은 질문이다.

**함정**: 해결책을 나열하는 것만으로는 변별이 안 된다. 각 해결책이 **어느 범위에 작용하는지**, 그리고 그 범위가 문제의 범위와 맞는지를 말해야 한다.

버전에 의존하는 서술은 **Hibernate 6.6 / Spring Boot 3.5 기준**이고, 예외 메시지와 프로퍼티 동작은 `hibernate-core:6.6.53.Final`과 `spring-boot-autoconfigure:3.5.16` 소스에서 직접 확인한 것이다.

## 1. 정확한 원인 — 트랜잭션이 아니라 EntityManager (그리고 OSIV가 그 틈을 메운다)

### 1-1. 전제 지식 — 프록시란 무엇인가

먼저 이 예외에 등장하는 주인공부터 정의하고 가자. **프록시(proxy)는 진짜 엔티티 대신 그 자리에 들어앉은 가짜 객체다.** 겉모습은 `Team`이라서 `Team` 타입 변수에 들어가고 `getName()`도 호출할 수 있지만, 속에는 식별자(id)만 들어 있고 나머지 필드는 비어 있다. 그리고 **누군가 그 빈 필드에 접근하는 순간 DB를 한 번 다녀와서** 자기 속을 채우려 한다. 대리인이라는 뜻에서 프록시다.

```java
Member member = memberRepository.findById(1L).orElseThrow();
// member.team 필드에 들어 있는 것은 실제 Team 이 아니라 Team 을 흉내 낸 프록시다.
// 이 시점에 team 테이블로 나간 쿼리는 아직 없다.

member.getTeam().getId();     // id 는 프록시가 이미 들고 있다 → 쿼리 안 나감
member.getTeam().getName();   // name 은 없다 → 여기서 select ... from team 이 나간다
```

비유하자면 프록시는 **택배 부재중 안내표**다. 물건 자체는 아직 안 왔지만 "송장번호 1번 물건이 당신 앞으로 있다"는 사실은 적혀 있다. 송장번호만 필요하면 안내표만 봐도 되지만, 물건의 내용물이 궁금해지는 순간 누군가 물류센터에 다녀와야 한다.

이 "다녀오는" 동작을 **프록시 초기화**라고 부른다. 그리고 이 문서의 예외는 전부 **초기화를 하려는데 다녀올 방법이 없을 때** 난다.

지연 로딩(LAZY)이란 결국 "연관 자리에 프록시를 심어두고, 실제로 쓰일 때까지 쿼리를 미루는 것"이다. 미루는 대신 나중에 갚아야 하는데, 갚을 수 있는 시간이 정해져 있다는 것이 문제의 출발점이다.

### 1-2. 실제 예외 — 메시지와 스택트레이스를 그대로 본다

로그에서 실제로 마주치는 모습은 이렇다. 단일 값 연관(`@ManyToOne`, `@OneToOne`)의 프록시를 건드렸을 때다.

```text
org.hibernate.LazyInitializationException: Could not initialize proxy [com.example.member.Team#1] - no session
	at org.hibernate.proxy.AbstractLazyInitializer.initialize(AbstractLazyInitializer.java:173)
	at org.hibernate.proxy.AbstractLazyInitializer.getImplementation(AbstractLazyInitializer.java:327)
	at org.hibernate.proxy.pojo.bytebuddy.ByteBuddyInterceptor.intercept(ByteBuddyInterceptor.java:44)
	at org.hibernate.proxy.ProxyConfiguration$InterceptorDispatcher.intercept(ProxyConfiguration.java:102)
	at com.example.member.Team$HibernateProxy$k9Qa1Zx.getName(Unknown Source)
	at com.example.member.MemberController.get(MemberController.java:31)
	... 생략
```

이 다섯 줄을 아래에서 위로 읽으면 사고 경위가 전부 나온다.

| 스택 줄 | 읽는 법 |
|---|---|
| `MemberController.get(MemberController.java:31)` | 내가 쓴 코드. 여기서 연관을 건드렸다 |
| `Team$HibernateProxy$k9Qa1Zx.getName(Unknown Source)` | 내가 만든 적 없는 클래스. Hibernate가 런타임에 만든 프록시다. 소스 파일이 없으니 `Unknown Source`다 |
| `ByteBuddyInterceptor.intercept` | 프록시가 호출을 가로채 "실물이 필요하네"라고 판단한 지점 |
| `AbstractLazyInitializer.getImplementation` | 실물을 달라고 요청 |
| `AbstractLazyInitializer.initialize` | 실물을 만들려다 실패하고 예외를 던진 자리 |

**클래스 이름에 `$HibernateProxy$`가 박혀 있다는 것만 봐도 이 예외의 성격이 드러난다.** 내 코드가 잡고 있던 객체가 실물이 아니라 대리인이었고, 그 대리인이 일할 수 없는 상태였다는 뜻이다.

컬렉션 연관(`@OneToMany`)을 건드리면 메시지도 스택도 다르다. 컬렉션은 프록시가 아니라 **영속성 컬렉션(persistent collection)** 이라는 다른 구현이 감싸고 있기 때문이다.

```text
org.hibernate.LazyInitializationException: failed to lazily initialize a collection of role: com.example.member.Member.orders: could not initialize proxy - no Session
	at org.hibernate.collection.spi.AbstractPersistentCollection.throwLazyInitializationException(AbstractPersistentCollection.java:633)
	at org.hibernate.collection.spi.AbstractPersistentCollection.withTemporarySessionIfNeeded(AbstractPersistentCollection.java:219)
	at org.hibernate.collection.spi.AbstractPersistentCollection.readSize(AbstractPersistentCollection.java:150)
	at org.hibernate.collection.spi.PersistentBag.size(PersistentBag.java:353)
	at com.example.member.MemberController.get(MemberController.java:33)
	... 생략
```

`of role: com.example.member.Member.orders`가 **어느 엔티티의 어느 필드에서 터졌는지**를 정확히 알려준다. 컬렉션 쪽 메시지가 오히려 진단에 유리하다.

메시지 뒤쪽의 사유 문구는 세 가지가 있고, 각각 다른 상황을 가리킨다.

| 뒤쪽 문구 | 무슨 뜻인가 | 전형적인 상황 |
|---|---|---|
| `no session` / `no Session` | 이 프록시에 붙어 있던 세션 참조 자체가 없다 | 엔티티가 세션 밖으로 나온 뒤(준영속) 접근 |
| `the owning session was closed` | 세션이 있긴 한데 이미 닫혔다 | 트랜잭션·요청이 끝난 뒤 접근 |
| `the owning session is disconnected` | 세션은 열려 있는데 DB 커넥션이 떨어져 있다 | 커넥션을 반납한 상태에서 접근 |

> 확인 범위 / 통설 교정: 인터넷에 널리 인용되는 형태는 `could not initialize proxy [...] - no Session`(소문자 c, 대문자 S)인데, **Hibernate 6.6.53에서 단일 값 프록시 메시지는 `Could not initialize proxy [...] - no session`(대문자 C, 소문자 s)** 이다(`org.hibernate.proxy.AbstractLazyInitializer`). 반면 **컬렉션 쪽은 6.6에서도 여전히 `could not initialize proxy - no Session`(소문자 c, 대문자 S)** 이다(`org.hibernate.collection.spi.AbstractPersistentCollection`). 같은 예외 클래스인데 두 경로의 대소문자가 서로 다르다는 뜻이다. **그래서 로그 알람 규칙을 `no Session` 같은 대소문자 구분 문자열로 걸면 절반을 놓친다.** 잡으려면 예외 클래스명 `org.hibernate.LazyInitializationException`으로 걸거나, 대소문자를 무시하고 `initialize proxy`로 거는 편이 버전과 경로 양쪽에 안전하다.

### 1-3. 두 개의 생명주기 — 트랜잭션과 EntityManager는 다른 것이다

`no session`이라는 문구가 핵심이다. 트랜잭션이 아니라 **세션이 없다**고 말하고 있다. 그런데 "트랜잭션"과 "세션"이 실무에서 거의 붙어 다니다 보니 둘을 같은 것으로 여기기 쉽다. 정확히 갈라보자.

**트랜잭션**은 DB 작업 여러 개를 "전부 성공 아니면 전부 없던 일"로 묶는 구간이다. 스프링에서는 `@Transactional`을 붙인 메서드를 감싼 프록시가 진입할 때 열고 리턴할 때 커밋하며 닫는다.

**`EntityManager`(Hibernate 용어로는 세션)** 는 **영속성 컨텍스트를 담고 있는 작업 단위 객체**다. 지금 어떤 엔티티를 읽어서 관리 중인지(1차 캐시), 무엇이 변경됐는지(변경 감지용 스냅샷)를 들고 있는 그릇이다. **프록시는 자기를 만들어준 이 `EntityManager`를 붙들고 있다가, 초기화가 필요해지면 그 `EntityManager`에게 쿼리를 부탁한다.**

두 생명주기의 결정적 차이는 **여는 주체가 다르다**는 데 있다.

| | 누가 여는가 | 누가 닫는가 |
|---|---|---|
| 트랜잭션 | `@Transactional` 프록시가 서비스 메서드 진입 시 | 같은 프록시가 리턴/예외 시 |
| `EntityManager` | 기본은 트랜잭션이 열릴 때 함께. **OSIV를 켜면 인터셉터가 요청 시작 시점에 미리** | 자기를 연 쪽이 닫는다 |

보통은 둘이 같이 열리고 같이 닫히므로 구분할 일이 없다. 그래서 "트랜잭션이 끝나서 터졌다"는 설명이 대부분의 경우 결과적으로 맞다. 하지만 **반드시 같이 끝나는 것은 아니고**, 그 예외가 바로 Spring Boot의 기본 설정이다.

### 1-4. 한 타임라인으로 보기 — OSIV 끔 vs 켬

문장으로 읽으면 헷갈리므로 시간축에 그린다. 같은 코드를 두 설정에서 돌린 것이다.

```java
// 두 그림에서 공통으로 도는 코드
@Transactional(readOnly = true)
public Member findMember(Long id) {
    return memberRepository.findById(id).orElseThrow();   // team 은 프록시로 남는다
}

// 컨트롤러
Member member = memberService.findMember(1L);
String teamName = member.getTeam().getName();   // 문제의 한 줄
```

```text
[A] spring.jpa.open-in-view: false  (명시적으로 끈 경우)

시각  일어나는 일                                          트랜잭션   EntityManager
──────────────────────────────────────────────────────────────────────────────────
t0   HTTP 요청 도착, DispatcherServlet 진입                  없음        없음
t1   컨트롤러 메서드 진입                                    없음        없음
t2   memberService.findMember(1L) 호출
       @Transactional 프록시가 트랜잭션을 연다               열림        열림  ← 여기서 생긴다
t3     findById 실행, Member 로딩
       member.team 자리에는 Team 프록시가 들어간다           열림        열림
t4   서비스 메서드 리턴, 커밋                                닫힘        닫힘  ← 같이 끝난다
t5   컨트롤러에서 member.getTeam().getName()
       프록시가 초기화를 시도한다
       자기를 만든 EntityManager 가 없다                     없음        없음
       → LazyInitializationException
```

```text
[B] spring.jpa.open-in-view: true  (Spring Boot 기본값)

시각  일어나는 일                                          트랜잭션   EntityManager
──────────────────────────────────────────────────────────────────────────────────
t0   HTTP 요청 도착
       OpenEntityManagerInViewInterceptor 가
       여기서 EntityManager 를 먼저 연다                     없음        열림  ← 앞당겨졌다
t1   컨트롤러 메서드 진입                                    없음        열림
t2   memberService.findMember(1L) 호출
       프록시가 트랜잭션만 연다 (EntityManager 는 재사용)    열림        열림
t3     Member 로딩, team 은 프록시                           열림        열림
t4   서비스 메서드 리턴, 커밋                                닫힘        열림  ← 안 닫힌다
t5   컨트롤러에서 member.getTeam().getName()
       EntityManager 가 살아 있으므로 초기화가 성공한다
       select ... from team where id = 1 이 나간다           없음        열림
       → 정상 동작. 트랜잭션 밖에서 쿼리가 나갔다.
t6   응답 직렬화까지 끝난 뒤
       인터셉터가 EntityManager 를 닫는다                    없음        닫힘
```

두 그림의 차이는 **t4의 오른쪽 칸 하나뿐**이다. 그리고 그 한 칸이 이 예외의 유무를 가른다.

여기서 이 문서의 첫 문장이 왜 그렇게 쓰였는지가 드러난다. [B]의 t5를 보라 — **트랜잭션은 이미 닫혔는데 지연 로딩은 성공한다.** 그러니 "트랜잭션이 끝나서 나는 예외"라는 설명으로는 [B]가 설명되지 않는다. 정확한 문장은 **"`EntityManager`가 닫힌 뒤에 프록시 초기화를 요청해서 나는 예외"** 다.

세 가지 경우를 표로 압축하면 이렇다.

| 상황 | 트랜잭션 | EntityManager | 지연 로딩 |
|---|---|---|---|
| OSIV 끔 | 서비스에서 종료 | 서비스에서 종료 | 예외 |
| **OSIV 켬 (기본값)** | 서비스에서 종료 | **응답 완료까지 유지** | 동작 |
| 트랜잭션 범위 확대 | 컨트롤러까지 유지 | 컨트롤러까지 유지 | 동작 |

가운데 줄이 이 예외를 이해하는 열쇠다. **트랜잭션은 끝났는데 지연 로딩이 되는 상태**가 실재하며, 그것이 Spring Boot의 기본값이다.

**그래서 "왜 개발할 땐 멀쩡한데 나중에 터지나"가 풀린다.** 개발과 운영이 둘 다 [B]로 돌고 있으면 이 코드는 몇 년이고 조용하다. 그러다 성능 튜닝 회의에서 누군가 `open-in-view: false`를 넣는 순간, 코드는 한 줄도 안 바뀌었는데 [A]로 바뀌면서 여기저기서 터진다. 뒤에서 볼 테스트 코드의 경우도 원리가 같다 — 웹 요청이 없으니 애초에 [A]로 돌기 때문이다.

### 1-5. OSIV란 무엇이고 왜 기본으로 켜져 있나

**OSIV(Open Session In View)** 는 `EntityManager`를 **HTTP 요청이 시작될 때 열고 응답이 끝날 때 닫는** 장치다. 이름 그대로 "뷰(view)를 그리는 동안에도 세션(session)을 열어(open) 둔다"는 뜻이다. 트랜잭션 경계(`@Transactional`)와 무관하게 세션을 살려두므로, 컨트롤러나 뷰 템플릿, JSON 직렬화 단계에서도 지연 로딩이 동작한다.

기술적 실체는 인터셉터 하나다. Spring Boot는 서블릿 웹 애플리케이션일 때 `OpenEntityManagerInViewInterceptor`를 자동으로 등록하는데, 그 조건이 `spring.jpa.open-in-view`이고 **값을 지정하지 않으면 켜진 것으로 본다**(`matchIfMissing = true`). 즉 **기본값이 `true`** 다.

이 실체를 알아두면 나중에 "OSIV가 언제 안 듣는가"가 저절로 풀린다. 인터셉터는 웹 요청 처리 경로에 걸리는 물건이므로, **웹 요청이 없는 곳에는 애초에 걸릴 자리가 없다.**

기본으로 켜져 있는 이유는 **입문 장벽을 낮추기 위해서**다. 이게 꺼져 있으면 JPA를 처음 쓰는 사람은 튜토리얼 수준의 코드에서도 곧바로 `LazyInitializationException`을 만난다. 다만 Spring Boot 자신도 이 기본값이 무해하다고 보지 않아서, 명시적으로 설정하지 않으면 기동할 때 경고를 남긴다.

```text
spring.jpa.open-in-view is enabled by default. Therefore, database queries may be performed during view rendering. Explicitly configure spring.jpa.open-in-view to disable this warning
```

"기본으로 켜져 있으니, 뷰 렌더링 중에 DB 쿼리가 나갈 수 있다. 이 경고를 없애려면 `spring.jpa.open-in-view`를 명시적으로 설정하라"는 안내다. **프레임워크가 "이건 알고 쓰라"고 경고하는 설정이라는 점이 이미 성격을 말해준다.** 그리고 이 경고는 값을 지정하지 않았을 때만 나온다 — `true`라고 명시해도 사라진다. 경고가 겨냥하는 것은 켜져 있다는 사실 자체가 아니라 **모르고 켜져 있다는 상태**다.

### 1-6. OSIV의 대가 (1) — 커넥션 보유 시간

OSIV의 비용은 **커넥션을 오래 붙잡는 것**이다.

트랜잭션이 끝난 뒤 컨트롤러에서 지연 로딩을 하면, 그 쿼리를 위해 커넥션이 필요하다. 그리고 그 커넥션은 `EntityManager`가 닫힐 때까지 — 즉 앞 그림 [B]의 t6, **응답이 완료될 때까지** — 풀로 돌아가지 않는다. 뷰 렌더링이나 JSON 직렬화가 느린 요청, 응답 크기가 큰 API, 외부 API 호출이 뒤에 붙은 흐름에서 이 시간이 길어진다.

커넥션 풀은 유한하다(HikariCP 기본 10개 수준). 요청당 커넥션 보유 시간이 늘어나면 동시 처리량이 그만큼 줄고, 트래픽이 늘면 **커넥션 풀 고갈 → 요청 대기 → 타임아웃**의 연쇄가 생긴다. 대용량 트래픽 서비스에서 OSIV를 끄는 이유가 이것이다.

> 확인 범위: 커넥션이 정확히 언제 풀로 반환되는지는 Hibernate의 커넥션 릴리스 모드와 트랜잭션 종류(resource-local / JTA)에 따라 달라진다. 위 설명은 "트랜잭션 밖에서 지연 로딩을 하면 그 커넥션이 세션 종료 시점까지 유지된다"는, 널리 통용되는 동작을 전제로 한 것이다. 팀의 설정에서 실제 보유 시간을 재려면 HikariCP의 활성 커넥션 지표와 요청 처리 시간을 함께 보는 것이 확실하다.

### 1-7. OSIV의 대가 (2) — N+1을 보이지 않는 곳으로 밀어넣는다

부작용이 하나 더 있고, 운영에서는 이쪽이 더 아프다. 컨트롤러와 직렬화 단계에서 지연 로딩이 자유롭게 일어나면 **쿼리가 서비스 계층 밖에서 나간다.**

결과는 세 가지다. 첫째, 서비스 코드만 읽어서는 이 API가 총 몇 개의 쿼리를 쓰는지 알 수 없다. 둘째, 응답 DTO에 필드를 하나 추가한 것만으로 목록 건수만큼 쿼리가 늘어난다 — 코드 리뷰에서 "필드 하나 추가"로 보이는 변경이 실제로는 쿼리 100개짜리 변경이다. 셋째, 그 쿼리가 트랜잭션 밖에서 나가므로 읽는 시점이 제각각이라 같은 응답 안에서도 데이터의 기준 시각이 어긋날 수 있다.

즉 OSIV는 `LazyInitializationException`을 막는 대신 **N+1을 보이지 않는 곳으로 밀어넣는다.** 탐지 방법은 [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md)에 있다.

### 1-8. OSIV가 켜져 있어도 예외가 나는 자리

"켜져 있는데 왜 나는가"는 좋은 꼬리질문이다. 답은 1-5에서 이미 나왔다 — OSIV의 실체는 **웹 요청 경로에 걸리는 인터셉터**이므로, 웹 요청 스코프 밖에서는 무력하다.

- **테스트 코드** — 웹 요청이 없으므로 인터셉터가 걸리지 않는다. `@DataJpaTest`나 단위 테스트에서 서비스 메서드 반환값의 연관을 만지면 바로 터진다.
- **`@Async`·`@Scheduled`·별도 스레드** — `EntityManager`는 스레드에 묶여 있다(`ThreadLocal`로 전파된다). 다른 스레드로 엔티티를 넘기면 그 스레드에는 세션이 없다.
- **배치 처리** — 웹 요청 밖이다.
- **응답 직렬화가 끝난 뒤** — 인터셉터가 세션을 닫은 이후에 도는 코드(일부 필터, 로깅 AOP).
- **엔티티를 캐시나 정적 필드에 담아 재사용** — 다음 요청에서 꺼내 쓰면 이미 닫힌 세션의 프록시다.

"이 예외 자주 봤다"는 사람이 OSIV의 존재를 몰랐다면, 실제로 본 자리는 대개 위 목록 중 하나다. 이걸 짚어내면 원인 분석 능력을 보일 수 있다.

## 2. 해결책 네 가지 — 목록이 아니라 범위로 본다

해결책을 외우기 전에 판단 축부터 세우자. 이 예외의 발생 지점은 **특정 화면의 특정 쿼리 하나**다. 그렇다면 처방도 그 크기여야 한다. **처방의 작용 범위가 문제의 범위보다 크면 그건 해결이 아니라 이동이다** — 여기서 잡은 문제를 저기로 옮기고, 옮긴 자리에서는 아무도 그것이 문제인 줄 모른다. 아래 네 가지를 "무엇을 하는가"가 아니라 "**어디까지 영향을 주는가**"로 읽어야 하는 이유다.

### 2-1. fetch join / `@EntityGraph` — 지점별 처방 (표준)

필요한 연관을 **조회하는 그 쿼리에서** 함께 가져온다. 프록시를 심는 대신 처음부터 실물을 채워 오므로 초기화할 일 자체가 없어진다.

```java
// (1) JPQL fetch join — 조인해서 team 컬럼까지 함께 select 한다
@Query("select m from Member m join fetch m.team where m.id = :id")
Optional<Member> findWithTeam(@Param("id") Long id);

// (2) @EntityGraph — 같은 일을 선언적으로. 쿼리 문자열을 안 쓴다.
@EntityGraph(attributePaths = "team")
Optional<Member> findById(Long id);
```

여기서 반드시 구분해야 할 것이 하나 있다. **일반 `join`과 `join fetch`는 다르다.** 일반 `join`은 SQL 조인만 만들 뿐 select 목록에는 부모만 올라가므로 **연관은 여전히 프록시로 남고 예외도 그대로 난다.** `fetch`가 붙어야 연관의 컬럼까지 함께 읽어 실물을 채운다.

- **범위**: 이 쿼리 하나. 다른 조회에는 영향이 없다.
- **트레이드오프**: 컬렉션을 fetch join하면 **페이징과 함께 쓸 수 없고**(전체를 메모리에 올려 자르는 동작), bag 성격의 컬렉션을 둘 이상 fetch join하면 예외가 난다. 이 제약과 대안(배치 fetch size)은 [컬렉션 fetch join과 페이징](08-fetch-join-pagination-in-memory.md)과 [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md)에 정리되어 있다.
- **왜 표준인가**: 문제가 난 지점에만 정확히 작용하고, **무엇을 함께 가져오는지가 코드에 드러난다.** 반년 뒤에 읽는 사람도 이 쿼리가 team까지 읽는다는 사실을 알 수 있다.

### 2-2. 트랜잭션 안에서 DTO로 변환 — 근본 처방

앞의 처방이 "예외가 난 쿼리를 고치는" 것이라면, 이쪽은 **예외가 날 수 있는 구조 자체를 없애는** 것이다. 엔티티가 계층을 넘어가지 못하게 만든다.

```java
// BEFORE — 엔티티를 그대로 컨트롤러로 반환한다.
//          반환된 Member 안에는 초기화되지 않은 프록시가 그대로 들어 있다.
@Transactional(readOnly = true)
public Member findMember(Long id) {
    return memberRepository.findById(id).orElseThrow();
}

// AFTER — 세션이 살아 있는 동안 필요한 값을 다 꺼내서 DTO 로 옮겨 담는다.
@Transactional(readOnly = true)
public MemberResponse findMember(Long id) {
    Member member = memberRepository.findById(id).orElseThrow();
    return new MemberResponse(
            member.getId(),
            member.getName(),
            // 이 줄에서 프록시 초기화가 일어난다. 아직 트랜잭션 안이고
            // EntityManager 가 열려 있으므로 안전하게 쿼리가 나간다.
            member.getTeam().getName()
    );
    // 반환되는 MemberResponse 는 String 과 Long 만 든 평범한 객체다.
    // 프록시가 한 조각도 들어 있지 않으므로 컨트롤러에서 무슨 짓을 해도 이 예외는 못 난다.
}
```

- **범위**: 계층 경계 전체. 이 방식을 팀 규칙으로 세우면 **이 예외가 구조적으로 발생할 수 없다** — 컨트롤러에 프록시가 도달하지 않기 때문이다.
- **트레이드오프**: 화면별 DTO와 변환 코드가 늘어난다. 다만 이 비용은 순수한 대가라기보다 **다른 이득을 함께 가져온다** — 엔티티 스펙을 바꿔도 API 응답이 조용히 따라 바뀌지 않고, 응답에 무엇이 담기는지가 타입으로 고정된다.
- 더 나아가 **DTO 프로젝션**(엔티티를 만들지 않고 처음부터 필요한 컬럼만 뽑아 DTO로 받는 조회)을 쓰면 엔티티를 영속성 컨텍스트에 올리지 않으므로 스냅샷·변경 감지 비용까지 없앤다. 조회 전용 화면의 정답이다. 여기서 주의할 구분이 하나 있다 — **"DTO를 반환한다"와 "DTO 프로젝션"은 다르다.** 위 AFTER 코드는 엔티티를 조회한 뒤 자바에서 옮겨 담은 것이라 DTO 반환이지 DTO 프로젝션이 아니다. 프로젝션은 **DTO가 쿼리의 결과 자체**여야 한다.

### 2-3. 트랜잭션 범위 확대 — 대용량에서 금지

`@Transactional`을 컨트롤러까지 올리거나 트랜잭션을 길게 잡는 방식이다. 앞 그림의 t4를 뒤로 미뤄서 t5가 트랜잭션 안에 들어오게 만드는 셈이다.

- **범위**: 해당 요청 흐름 전체.
- **트레이드오프**: **커넥션 보유 시간이 그만큼 늘어난다.** OSIV와 같은 문제인데, 여기에 더해 **쓰기 트랜잭션이 길어지면 DB 락 보유 시간도 늘어난다.** 뷰 렌더링이나 외부 API 호출 시간까지 트랜잭션 안에 들어가면, 트래픽이 조금만 늘어도 커넥션 풀 고갈과 락 경합이 동시에 터진다.
- 실무 원칙은 정확히 반대 방향이다: **트랜잭션은 짧게, 경계는 서비스 메서드 하나에.** 이 처방은 그 원칙을 정면으로 거스르므로, 예외를 없애려다 훨씬 큰 문제를 들여오는 쪽에 가깝다.

### 2-4. EAGER 전환 — 증상 은폐

`fetch = FetchType.EAGER`로 바꾸면 예외는 사라진다. 프록시를 안 심고 처음부터 실물을 같이 읽어오기 때문이다. 그런데 이건 해결이 아니다.

**범위가 맞지 않는다.** 예외는 특정 화면 한 곳에서 났는데, EAGER는 그 연관을 쓰는 **모든 쿼리**를 바꾼다. 그 연관이 전혀 필요 없던 조회에서도 조인이나 추가 쿼리가 나가고, 연관이 겹치면 조인 깊이가 누적된다.

게다가 **쿼리 단위로 되돌리기가 어렵다.** 방향이 비대칭이기 때문이다 — LAZY를 기본으로 두고 필요한 쿼리에서만 fetch join으로 켜는 것은 쉬운데, EAGER를 기본으로 두고 특정 쿼리에서만 끄는 것은 훨씬 번거롭다. 자세한 근거는 [EAGER vs LAZY 기본 전략](03-eager-vs-lazy-fetch-strategy.md)에 있다.

한 문장으로: **예외는 한 지점에서 났는데 처방은 전역에 적용된다.** 이 비대칭을 지적할 수 있으면 이 문항의 핵심 판단을 통과한 것이다.

### 2-5. 비교 정리

| 처방 | 작용 범위 | 주된 대가 | 권장도 |
|---|---|---|---|
| fetch join / `@EntityGraph` | 그 쿼리 하나 | 컬렉션과 페이징을 같이 못 씀 | **표준** |
| 트랜잭션 안 DTO 변환 | 계층 경계 전체 | DTO·변환 코드 증가 | **근본** |
| 트랜잭션 범위 확대 | 요청 흐름 전체 | 커넥션·락 보유 시간 증가 | 지양 |
| OSIV | 애플리케이션 전역 | 커넥션 보유 시간, N+1 은닉 | 대용량은 끔 |
| EAGER 전환 | 애플리케이션 전역 | 되돌리기 어려움, 조인 폭탄 | 지양 |

위 둘과 아래 셋 사이에 선이 하나 그어져 있다. **위 둘은 "이 화면에서 무엇을 함께 읽을지"를 개발자가 명시적으로 결정하는 방식**이고, **아래 셋은 그 결정을 안 하고 넘어가도 되게 만드는 방식**이다. 결정을 미루면 편해지지만, 미룬 결정은 사라지지 않고 운영 중에 청구서로 돌아온다.

## 3. 실무에서의 조합

### 3-1. OSIV를 끄는 것은 설정 변경이 아니라 조사다

대용량 트래픽 서비스의 표준 구성은 이렇다.

```yaml
spring:
  jpa:
    open-in-view: false   # 명시적으로 끈다. 기본값이 true 라서 안 쓰면 켜진 것이다.
```

끄면 그동안 숨어 있던 `LazyInitializationException`이 여기저기서 드러난다. 이때 겁먹고 되돌리기 쉬운데, **그게 목적이다.** 예외 하나하나가 "여기서 지연 로딩이 계층을 넘고 있었다"는 신고서다. 끄기 전까지 그 지점들은 존재하되 보이지 않았을 뿐, 없었던 것이 아니다.

그래서 이 설정 한 줄을 **조사 도구**로 쓰는 것이 정석이다. 순서가 있다.

1. **로컬과 CI에 먼저 끈다.** 여기서 나는 예외는 아무에게도 피해를 주지 않는다.
2. **스테이징에서 끄고 전 화면을 한 번 돌린다.** 위반 지점 목록이 여기서 전수로 나온다.
3. **목록을 다 정리한 뒤 운영에 끈다.** 이때부터는 회귀 방지 장치로 작동한다.

같은 전략을 컬렉션 fetch join + 페이징 문제에도 쓴다 — `fail_on_pagination_over_collection_fetch`를 켜서 조용한 메모리 페이징을 예외로 승격시키는 것이 정확히 같은 발상이다([컬렉션 fetch join과 페이징](08-fetch-join-pagination-in-memory.md) 참고).

### 3-2. 드러난 지점을 정리하는 순서

노출된 지점을 아무 순서로나 고치면 품이 많이 든다. 효율 순서가 있다.

1. **응답 DTO 변환을 서비스 계층으로 내린다.** 이것만으로 대부분이 사라진다. 개별 쿼리를 건드리지 않고 계층 규칙 하나로 한꺼번에 없애는 것이라 투입 대비 효과가 가장 크다.
2. 남은 곳 중 **연관을 반드시 함께 읽어야 하는 조회**에 fetch join / `@EntityGraph`를 붙인다.
3. **컬렉션과 페이징이 얽힌 곳**은 fetch join을 쓰지 못하므로 `default_batch_fetch_size`로 푼다.
4. 조회 전용 화면은 아예 **DTO 프로젝션**으로 바꿔 엔티티를 영속성 컨텍스트에 올리지 않는다.

1번을 먼저 하는 이유를 한 번 더 말하면 이렇다. **2번은 지점마다 반복해야 하지만 1번은 규칙이라 한 번만 세우면 된다.** 지점별 처방부터 시작하면 새 화면이 추가될 때마다 같은 일을 다시 하게 된다.

### 3-3. 회귀를 막는다

4단계를 끝내도 다음 PR에서 누군가 엔티티를 컨트롤러로 반환하거나 fetch join을 지우면 원상 복구된다. 사람의 주의력에 기대지 않으려면 쿼리 수를 테스트로 고정해야 한다 — [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md)의 자동 탐지 장치가 그대로 쓰인다.

그리고 `open-in-view: false`를 **테스트 프로파일에도 반드시 넣어둔다.** 운영만 끄고 테스트는 켜두면, 테스트가 통과하는데 운영에서 터지는 최악의 조합이 만들어진다.

## 4. 꼬리질문 대비 포인트

### "OSIV를 끄면 개발이 불편해지지 않나요?"

불편해진다. 그리고 그 불편이 **비용을 드러내는 역할**을 한다.

OSIV가 켜져 있으면 "컨트롤러에서 연관을 만지면 쿼리가 나간다"는 사실이 코드 어디에도 보이지 않는다. 그래서 응답 필드를 하나 추가하는 작업이 조용히 쿼리 100개를 늘린다. 끄면 그 순간 예외로 알려주므로, 개발자가 **의도적으로** fetch 전략을 선택하게 된다.

즉 OSIV를 끄는 것은 편의를 버리는 게 아니라 **결정을 앞당기는 것**이다. 어차피 해야 할 결정을 운영 장애 때 하느냐 개발 중에 하느냐의 차이다.

### "`@Transactional(readOnly = true)`를 컨트롤러에 붙이면 안 되나요?"

동작은 한다. 하지만 두 가지가 틀어진다.

첫째, 트랜잭션 경계가 컨트롤러로 올라가면 **커넥션과 락 보유 시간이 요청 전체로 늘어난다.** 뷰 렌더링과 직렬화 시간까지 트랜잭션 안에 들어간다.

둘째, 더 중요한 문제로 **트랜잭션 경계와 비즈니스 단위가 어긋난다.** `@Transactional`은 "무엇이 하나의 원자적 작업인가"를 선언하는 자리인데, 그 선언이 웹 계층으로 번지면 서비스 자체에는 경계가 없어진다. 나중에 그 서비스를 다른 진입점(배치, 메시지 컨슈머)에서 재사용할 때 트랜잭션이 아예 안 걸린다.

트랜잭션은 서비스 메서드에 두는 것이 원칙이다.

### "`Hibernate.initialize()`로 미리 초기화하면 되지 않나요?"

트랜잭션 안에서 `Hibernate.initialize(member.getTeam())`을 호출하면 예외는 막힌다. 프록시를 미리 채워두는 것이므로 의도 자체는 맞다.

다만 이건 fetch join과 같은 목적을 **쿼리를 한 번 더 써서** 달성하는 것이다(조인 한 번 대신 SELECT 두 번). 초기화 대상이 컬렉션이고 대상 엔티티가 여러 건이면 그 자체로 N+1이 된다 — 20건을 순회하며 `initialize`를 부르면 쿼리가 20번 나간다.

"연관을 명시적으로 로딩한다"는 의도는 옳으니, 목적이 같다면 **처음 조회에서 함께 가져오는 fetch join / `@EntityGraph`가 우선**이다. `Hibernate.initialize()`는 쿼리를 내가 못 고치는 상황(공용 리포지터리 메서드를 그대로 써야 할 때)의 차선책으로 남겨둔다.

### "예외 메시지의 `no Session`은 정확히 무슨 뜻인가요?" (원리 확인)

프록시가 초기화 쿼리를 실행하려면 자기를 만든 세션(`EntityManager`)이 열려 있어야 한다. `no Session`은 그 세션이 아예 없다는 뜻이고, 같은 계열로 `the owning session was closed`(있었는데 닫혔다), `the owning session is disconnected`(열려는 있는데 커넥션이 없다)가 있다.

여기서 파생되는 정확한 표현이 하나 있다 — 이 예외는 **"트랜잭션 밖에서 났다"가 아니라 "세션 밖에서 났다"** 이다. OSIV는 트랜잭션 없이 세션만 열어두는 구성이므로, 트랜잭션 밖에서도 지연 로딩이 되는 상태가 실제로 존재하기 때문이다.

실무 감각을 하나 더 붙이면 좋다. **로그 알람 규칙을 `no Session` 문자열로 걸면 절반을 놓친다.** Hibernate 6.6에서 단일 값 프록시는 `- no session`(소문자 s), 컬렉션은 `- no Session`(대문자 S)으로 서로 다르게 찍힌다. 예외 클래스명 `org.hibernate.LazyInitializationException`으로 거는 편이 안전하다.

### "테스트에서만 이 예외가 나고 운영에서는 안 납니다. 왜죠?" (시니어 변별 포인트)

운영은 웹 요청이므로 OSIV 인터셉터가 세션을 열어두지만, 테스트는 웹 요청 스코프가 없어 인터셉터가 걸릴 자리 자체가 없다. 그래서 서비스 메서드가 끝나는 순간 세션이 닫힌다.

그리고 이 현상은 **버그가 아니라 경고로 읽어야 한다.** 테스트가 알려주는 것은 "이 코드는 OSIV에 의존하고 있다"는 사실이다. OSIV를 끄는 순간 운영에서도 똑같이 터진다. 즉 **테스트가 미래의 장애를 미리 보여주고 있는 것**이다.

그러므로 대응은 `@Transactional`을 테스트에 붙여 세션을 억지로 살려 덮는 것이 아니라, **DTO 변환을 서비스로 내려 근본을 고치는 것**이다. 테스트에 `@Transactional`을 붙이는 순간 그 테스트는 운영과 다른 조건에서 도는 테스트가 되어, 검증 능력을 스스로 반납한다.

### "그럼 어떤 상황에서 OSIV를 켜두는 것이 합리적인가요?" (트레이드오프 판단)

세 조건이 겹칠 때다. 첫째, 트래픽이 크지 않아 커넥션 보유 시간이 병목이 아니다. 둘째, 서버 사이드 렌더링(Thymeleaf 등)을 써서 뷰에서 엔티티를 자연스럽게 순회하는 구조다. 셋째, 팀이 작아 DTO 계층을 유지하는 비용이 상대적으로 크다.

즉 **소규모 사내 시스템이나 어드민 페이지**가 전형적인 자리다.

반대로 **트래픽이 큰 공개 API**에서는 켜둘 이유가 거의 없다. API는 어차피 JSON 응답 DTO를 만들어야 하므로 **OSIV가 주는 이점 자체가 작고**, 커넥션 보유 시간이라는 비용만 온전히 남는다.

"무조건 끄세요"보다 이렇게 조건으로 답하는 편이 정확하다. 그리고 켜두기로 했다면 **`open-in-view: true`라고 명시**하는 편이 낫다 — 기본값에 기대어 켜져 있는 것과, 알고 켜둔 것은 다르다.

---

## 한 줄 요약

`LazyInitializationException`은 트랜잭션이 아니라 **세션(`EntityManager`)이 닫힌 뒤 프록시를 초기화하려 해서** 나는 예외이고, Spring Boot가 OSIV를 기본으로 켜서 세션 수명을 응답 완료까지 늘려두기 때문에 많은 팀이 이 예외를 못 보고 지나간다 — 해결의 기준은 목록 암기가 아니라 **처방의 범위를 문제의 범위에 맞추는 것**이다.
