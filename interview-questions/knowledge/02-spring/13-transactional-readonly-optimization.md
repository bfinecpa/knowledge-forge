# @Transactional(readOnly = true)의 실제 최적화 — "어느 계층에서 무슨 일이 일어나는가"로 분해하기

> 핵심 관전 포인트: **readOnly=true는 사실상 하이버네이트 최적화다.
> JPA/Hibernate 계층에서 플러시 모드를 MANUAL로 바꿔 커밋 시 flush를
> 생략하고, 더티 체킹용 엔티티 스냅샷 유지 부담을 없애 대량 조회의
> 메모리/CPU를 아낀다 — 이것이 가장 큰 실효다. 그 아래로 JDBC 드라이버에
> `Connection.setReadOnly(true)` 힌트가 전달되고(최적화 여부는 드라이버/DB
> 마다 다름), 인프라 계층에서는 리더/리플리카 분리 시 리플리카로 라우팅하는
> 근거가 된다. 단, 쓰기를 "막아주는" 안전장치가 아니다 — flush를 안 하니
> 변경이 에러 없이 조용히 무시될 뿐이다. "막는 게 아니라 힌트"라는 정확한
> 이해가 변별 포인트.**

---

## 0. 질문 + 의도

**질문**: "`@Transactional(readOnly = true)`는 실제로 어떤 최적화를 해주나요?"

**출제 의도**: 플러시 생략, replica 라우팅 힌트 등 실효를 아는지 본다.
"붙이면 좋다더라"식 카고컬트 습관인지, 효과를 알고 쓰는지를 가리는
질문이다.

## 답변의 축 — 계층별로 분해해서 말하기

"readOnly는 성능에 좋다더라"는 암기 답변과, "어느 계층에서 무슨 최적화가
일어나는지"를 분해하는 답변은 급이 다르다. readOnly=true 하나를 걸면
세 개의 계층이 각각 다르게 반응한다:

| 계층 | 무슨 일이 일어나나 | 실효 |
|---|---|---|
| JPA/Hibernate | 플러시 모드 MANUAL + 스냅샷 유지 생략 | **가장 큼 (확실한 최적화)** |
| JDBC 드라이버 | `Connection.setReadOnly(true)` 힌트 | 드라이버/DB마다 다름 |
| 인프라(DataSource) | 리플리카 라우팅의 판단 근거 | 구성했다면 매우 큼 |

첫 문장은 이렇게 시작하면 된다: **"readOnly는 사실상 하이버네이트
최적화입니다."** 그리고 계층을 내려가며 설명한다.

## 1. JPA/Hibernate 계층 — 가장 큰 실효

### 1-1. 플러시 모드가 MANUAL로 바뀐다

flush(플러시)란 영속성 컨텍스트(엔티티를 담아두는 1차 캐시)에 쌓인
변경 내용을 SQL로 만들어 DB에 내보내는 동작이다. 보통은 트랜잭션
커밋 직전에 자동으로 일어난다.

readOnly=true가 걸리면 스프링(정확히는 `HibernateJpaDialect` 등의
연동 코드)이 하이버네이트 세션의 플러시 모드를 `MANUAL`로 바꾼다.
"명시적으로 flush()를 부르지 않는 한 절대 flush하지 않는다"는 뜻이다.
그 결과 **트랜잭션 커밋 시점의 flush가 통째로 생략된다.**

### 1-2. 더티 체킹용 스냅샷 부담이 사라진다

flush 생략보다 실무 임팩트가 큰 게 이쪽이다. 더티 체킹(dirty checking,
변경 감지)이란 "조회해 온 엔티티가 나중에 바뀌었는지 알아내서 자동으로
UPDATE를 날려주는" JPA의 기능인데, 바뀌었는지 비교하려면 **조회 시점의
원본 복사본(스냅샷)을 메모리에 하나 더 들고 있어야** 한다.

- 일반 트랜잭션: 엔티티 1만 건 조회 → 엔티티 1만 건 + 스냅샷 1만 건,
  메모리 사용이 사실상 2배. flush 때마다 1만 건을 필드 단위로 비교하는
  CPU 비용도 든다.
- readOnly 트랜잭션: 하이버네이트가 "어차피 안 바뀔 것"으로 간주해
  엔티티를 read-only 상태로 로드 — 스냅샷을 만들지 않는다.
  메모리 절반, 비교 비용 제로.

대량 조회 API에서 readOnly 하나로 체감 성능이 달라지는 이유가 이것이다.

### before / after

```java
// before — readOnly 없이 조회만 하는 서비스
@Transactional
public List<MemberResponse> findMembers(SearchCondition condition) {
    List<Member> members = memberRepository.search(condition);  // 1만 건
    return members.stream().map(MemberResponse::from).toList();
}
// 내부에서 벌어지는 일:
// - 엔티티 1만 건마다 스냅샷 복사본 생성 (메모리 2배)
// - 커밋 직전 flush: 1만 건 전부를 스냅샷과 필드 단위 비교 (CPU 낭비)
// - 바뀐 게 없으니 결국 UPDATE 0건 — 전부 헛수고였던 비용
```

```java
// after — readOnly 선언
@Transactional(readOnly = true)
public List<MemberResponse> findMembers(SearchCondition condition) {
    List<Member> members = memberRepository.search(condition);  // 1만 건
    return members.stream().map(MemberResponse::from).toList();
}
// - 플러시 모드 MANUAL: 커밋 시 flush 자체가 생략
// - 스냅샷 생성 안 함: 메모리는 엔티티 1만 건분만, 비교 비용 0
// - "안 바꿀 것"이라는 의도가 시그니처에 드러나는 문서화 효과는 덤
```

## 2. JDBC 드라이버 계층 — "힌트"이지 보장이 아니다

스프링 트랜잭션 매니저는 커넥션을 얻을 때
`Connection.setReadOnly(true)`를 호출해 **드라이버에게 힌트를 전달**한다.
이걸 받아서 뭘 할지는 드라이버와 DB 구현에 달렸다:

- Oracle: read-only 트랜잭션 모드로 전환해 일관 읽기 최적화에 활용.
- PostgreSQL: 세션에 read-only 특성을 설정, 쓰기 시도 시 에러를 내는
  동작으로 이어질 수 있음.
- MySQL(Connector/J): 버전/설정에 따라 다르며, InnoDB의 읽기 전용
  트랜잭션 최적화(트랜잭션 ID 발급 생략 등)와 연계될 수 있음.

핵심은 **"드라이버/DB에 따라 최적화 여부가 다르고, 아무것도 안 하는
DB도 많다"**는 것. 그래서 이 계층만 믿고 readOnly를 논하면 안 되고,
확실한 실효는 1절의 하이버네이트 계층이라고 정리하는 게 정확하다.

## 3. 인프라 계층 — 리더/리플리카 라우팅의 근거

트래픽이 커지면 쓰기는 리더(primary) DB로, 읽기는 리플리카(replica,
복제본) DB로 분산하는 구성을 쓴다. 이때 "이 쿼리를 어느 DB로 보낼까"의
판단 근거가 바로 readOnly 플래그다:

- **MySQL Replication driver**(`ReplicationConnection`):
  `setReadOnly(true)`가 호출된 커넥션의 쿼리를 리플리카로 보낸다.
- **AbstractRoutingDataSource** + `TransactionSynchronizationManager
  .isCurrentTransactionReadOnly()`: 스프링에서 직접 라우팅 DataSource를
  구현할 때의 표준 패턴.
- **AWS RDS Proxy / 일부 프록시 계층**: read-only 세션을 리더 엔드포인트가
  아닌 리더-리플리카로 흘리는 근거로 활용.

이것이 실무에서 **조회 메서드에 readOnly를 규율 있게 붙여야 하는 진짜
이유 중 하나**다. 지금 당장 리플리카가 없어도, 붙여둔 팀은 나중에
분리 구성을 어노테이션 수정 없이 도입할 수 있고, 안 붙인 팀은 전체
서비스 코드를 뒤지는 마이그레이션을 치러야 한다.

## 4. 오해 바로잡기 — 쓰기를 "막아주는" 안전장치가 아니다

readOnly=true를 "이 트랜잭션에서는 쓰기가 금지된다"는 안전장치로
이해하면 틀렸다. 실제로는:

```java
@Transactional(readOnly = true)
public void updateName(Long id, String name) {
    Member member = memberRepository.findById(id).orElseThrow();
    member.changeName(name);   // 엔티티를 바꿨지만...
}
// 예외? 안 난다. UPDATE? 안 나간다.
// 플러시 모드가 MANUAL이라 flush가 없고,
// 스냅샷도 없어서 더티 체킹 자체가 불가능 —
// 변경이 "에러 없이 조용히 무시"된다.
```

- 하이버네이트 관점: flush를 안 하니 변경이 **조용히 증발**한다.
  개발자는 "저장됐겠지" 하고 지나가고, 데이터는 안 바뀌어 있고,
  로그에는 아무 흔적이 없다 — 막아주는 게 아니라 더 찾기 어려운
  버그가 되는 것이다.
- DB 관점: 드라이버/DB에 따라 쓰기 SQL에 예외를 던지는 경우도
  있지만(PostgreSQL 등), 그건 구현별 부수 효과지 보장이 아니다.

정리하면 readOnly는 **강제가 아니라 힌트**다. "안 바꿀 것"이라는 의도를
각 계층에 전달해 최적화 기회를 주는 선언이지, 바꾸려는 코드를 잡아주는
방어막이 아니다. 이 구분을 정확히 말하는 것이 변별 포인트다.

---

## 5. 꼬리질문 대비 포인트

### "readOnly=true인데 안에서 save()를 호출하면 무슨 일이 벌어지나?"

계층에 따라 갈린다고 답한다. 하이버네이트 계층에서는 플러시 모드가
MANUAL이라 대부분 **아무 일도 안 일어난다** — persist는 영속성
컨텍스트에 쌓이기만 하고 flush가 없으니 INSERT가 안 나가고, 예외도
없이 조용히 증발한다(가장 위험한 케이스). 단, ID 생성 전략이
`IDENTITY`면 ID를 받기 위해 INSERT가 즉시 나가야 하므로 flush와
무관하게 SQL이 실행될 수 있고, 이때 DB/드라이버가 read-only를 강제하는
구성(PostgreSQL의 read-only 세션 등)이면 그 시점에 예외가 터진다.
즉 "조용한 무시가 기본, 구성에 따라 예외" — 어느 쪽이든 개발자가
의도한 저장은 일어나지 않으므로, 조회 전용 메서드에 쓰기 로직이
섞이는 설계 자체를 막아야 한다고 마무리하면 좋다.

### "조회 메서드에 트랜잭션을 아예 안 거는 것과 readOnly 트랜잭션을 거는 것의 차이는?"

세 가지로 답한다.

1. **영속성 컨텍스트의 범위**: 트랜잭션이 없으면 리포지토리 호출 한 번
   한 번이 각자의 짧은 영속성 컨텍스트에서 돌고 즉시 닫힌다. 서비스
   메서드가 끝나기 전에 지연 로딩(lazy loading)을 시도하면
   **LazyInitializationException** — 이미 닫힌 컨텍스트에서 프록시를
   초기화하려다 터지는 것. readOnly 트랜잭션을 걸면 메서드 전체가
   하나의 영속성 컨텍스트를 공유해 지연 로딩이 안전하다.
2. **커넥션/라우팅의 일관성**: 트랜잭션이 없으면 쿼리마다 커넥션을
   따로 얻을 수 있어, 리플리카 분리 환경에서 쿼리들이 서로 다른
   DB로 흩어질 수 있다. readOnly 트랜잭션은 하나의 커넥션(하나의
   리플리카)에 묶어 같은 시점의 일관된 데이터를 읽게 한다.
3. **읽기 일관성**: 하나의 트랜잭션 안이면 (격리 수준에 따라) 여러
   쿼리가 같은 스냅샷을 보지만, 트랜잭션이 없으면 쿼리 사이에 다른
   트랜잭션의 커밋이 끼어들어 서로 안 맞는 데이터를 조합할 수 있다.

### "리더/리플리카 분리를 readOnly 기반으로 구현하는 방법은?"

구현 방법과 함정을 함께 답한다. 구현은 (1) MySQL이라면 Replication
driver가 `setReadOnly(true)` 커넥션을 리플리카로 보내주는 방식,
(2) 스프링에서 `AbstractRoutingDataSource`를 상속해
`determineCurrentLookupKey()`에서
`TransactionSynchronizationManager.isCurrentTransactionReadOnly()`로
분기하는 방식(이때 트랜잭션 시작 시점보다 커넥션 획득이 늦어지도록
`LazyConnectionDataSourceProxy`로 감싸는 게 정석 — 안 감싸면 readOnly
판정 전에 커넥션이 잡혀 라우팅이 안 먹는다), (3) AWS RDS Proxy 같은
프록시 계층에 맡기는 방식이 있다.

함정은 **복제 지연(replication lag)**이다. 리더에 쓴 내용이 리플리카에
복제되기까지 시간차가 있어서, "회원 가입(쓰기: 리더) 직후 내 정보
조회(읽기: 리플리카)"가 옛 데이터를 돌려줄 수 있다 — "쓰고 바로 읽기"
(read-your-own-writes) 문제. 대응은 쓰기 직후의 읽기를 리더로 보내는
설계(같은 트랜잭션/같은 요청 안에서 처리, 또는 세션 단위로 일정 시간
리더 고정), GTID 기반으로 복제 완료를 기다리는 방식 등이 있다.
이 함정까지 언급하면 "구성해 본 사람"의 답변이 된다.

### "모든 조회에 readOnly를 붙이는 팀 컨벤션은 합리적인가?"

트레이드오프를 판단해서 답한다. 찬성 근거: 하이버네이트 스냅샷/flush
절약은 조회가 많은 서비스에서 실질 이득이고, 리플리카 라우팅의 전제
조건이 되며, "이 메서드는 안 바꾼다"는 의도가 시그니처에 드러나는
문서화 효과가 있다. 규율 없이 "필요할 때만 붙이자"고 하면 결국 아무도
안 붙여서 라우팅 도입 시점에 전면 수정을 치르게 된다.

주의할 점: (1) readOnly가 쓰기를 막아주는 게 아니므로 "붙였으니
안전하다"는 착각은 금물 — 조회 메서드에 쓰기가 섞이면 조용히 증발하는
버그가 된다. (2) 클래스 레벨 `@Transactional(readOnly = true)` +
쓰기 메서드에만 `@Transactional` 오버라이드하는 패턴을 쓸 때, 쓰기
메서드에 어노테이션을 빼먹으면 변경이 증발한다 — 이 실수를 잡을
테스트/리뷰 장치가 함께 가야 한다. (3) 트랜잭션 자체가 필요 없는
초단순 조회에까지 트랜잭션 비용(커넥션 점유)을 지불하는 것 아니냐는
반론이 있지만, 어차피 커넥션은 쿼리 실행에 필요하고 readOnly 트랜잭션의
추가 비용은 미미해서 일관성의 이득이 크다 — 는 것이 일반적인 결론이다.
"기본은 붙인다, 단 안전장치가 아님을 팀이 공유한다"가 균형 잡힌 답이다.

### "readOnly를 붙였는데도 느리다면 어디를 의심하나?" (한 단계 더 들어오는 질문)

readOnly가 아끼는 건 스냅샷/flush 비용이지 쿼리 자체가 아니다.
N+1 문제, 인덱스 미사용, 불필요한 컬럼까지 엔티티로 다 가져오는 것
등은 readOnly와 무관하게 남는다. 대량 조회에서 애초에 엔티티가 필요
없다면 DTO 프로젝션(필요한 컬럼만 select)으로 영속성 컨텍스트를
아예 우회하는 게 readOnly보다 더 큰 최적화라는 점을 언급하면
"도구의 한계를 아는" 답변이 된다.

---

## 한 줄 요약

@Transactional(readOnly = true)는 하이버네이트의 플러시 모드를 MANUAL로
바꿔 커밋 시 flush를 생략하고 더티 체킹용 스냅샷을 만들지 않게 하는 것이
실효의 핵심이고, 아래로는 JDBC 드라이버 힌트(효과는 DB마다 다름)와
리더/리플리카 라우팅의 근거로 이어진다 — 단 쓰기를 막아주는 안전장치가
아니라 "안 바꾼다"는 힌트일 뿐이라, 변경은 에러 없이 조용히 증발한다는
것까지 말해야 정확한 이해다.
