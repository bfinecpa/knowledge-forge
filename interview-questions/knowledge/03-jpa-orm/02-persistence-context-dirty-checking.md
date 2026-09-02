# 영속성 컨텍스트 — 4개의 저장소, flush의 정량 비용, 그리고 "내가 안 시킨 UPDATE"

> 핵심 관전 포인트: 영속성 컨텍스트는 "엔티티를 담아두는 메모리"가 아니라 **네 개의 저장소**다 — ① 1차 캐시(`@Id` → 엔티티 인스턴스 맵) ② 스냅샷 저장소(로드 시점 필드값 복사본) ③ 쓰기 지연 SQL 저장소 ④ 그 결과로 얻는 동일성 보장(같은 트랜잭션·같은 id는 `==`가 참). **1차 캐시는 성능 캐시가 아니라 동일성·정합성 장치**다 — 범위가 트랜잭션이라 히트율을 기대하는 설계는 애초에 성립하지 않는다. 변경 감지의 구조는 "바뀐 값을 따로 모아둔다"가 아니라 **엔티티 인스턴스 자체가 바뀌고 스냅샷은 로드 시점의 사진으로 남는 것**이라, 무엇이 바뀌었는지는 flush 때 대조해봐야 알 수 있다 → 그래서 **flush마다 `O(관리 엔티티 수 × 필드 수)` 비교가 불가피하고 메모리는 엔티티마다 스냅샷 한 벌씩 늘어난다**. 회피는 `@Transactional(readOnly = true)`(flush 억제)보다 **DTO 프로젝션**(애초에 컨텍스트에 안 올림)이 더 근본적이다. flush가 만드는 SQL은 두 가지가 반직관적이다 — 실행 순서는 코드 순서가 아니라 **INSERT → UPDATE → DELETE 고정**이고, UPDATE는 **전 컬럼**이 기본이다. "안 시킨 UPDATE"는 setter 전수 조사로 끝나지 않는다 — **컬렉션 재할당, 컨버터 왕복, 시간 정밀도, OSIV+setter**가 단골이고, 비교는 엔티티의 `equals`가 아니라 **Hibernate의 타입별 비교기**가 한다. 진단은 감이 아니라 3단 — **바인딩 SQL 로그 → Statistics 카운트 → flush 리스너 스택트레이스**.

---

## 0. 질문 + 의도

**질문**: "영속성 컨텍스트란 무엇인가요? 1차 캐시, 쓰기 지연, 변경 감지(dirty checking)를 설명해주세요."

**출제 의도**: JPA의 거의 모든 미스터리("save 안 했는데 UPDATE가 나감", "조회했는데 쿼리가 안 나감", "DB는 바뀌었는데 조회 결과는 옛 값")가 이 개념 하나로 설명된다. 이걸 모르고 JPA를 쓰는 건 자동변속기 원리를 모르고 견인차를 모는 것과 같다 — **평소엔 되지만 이상 동작 시 속수무책이다.** 그래서 이 질문의 실제 채점 지점은 정의 암기가 아니라 **"이상 동작이 났을 때 원인을 좁혀 들어갈 수 있는가"** 다.

**함정**: 네 개념의 정의(트랜잭션 범위 메모리 / 조회 시 스냅샷 / 커밋 시 비교 / UPDATE 생성)는 정확히 말해도, 그 뒤 두 가지에서 갈린다.

1. **비용을 정량으로 못 말한다** — "메모리와 GC" 정도에서 멈추고, flush마다 전건 비교라는 CPU 비용에 도달하지 못한다.
2. **역방향 추론을 못 한다** — "왜 UPDATE가 나가는가"는 설명하는데, "코드가 값을 바꾸지 않았는데 왜 UPDATE가 나가는가"는 설명하지 못한다.

이 문서는 3장 전체가 딛고 서는 바닥이다. N+1도, `LazyInitializationException`도, 벌크 연산의 함정도, 낙관적 락의 버전 증가도 전부 "영속성 컨텍스트가 지금 무엇을 들고 있고 flush 때 무엇을 하는가"로 환원된다. 그래서 여기서는 개념을 정의하고 넘어가는 대신 **엔티티를 처음 조회하는 순간부터 커밋까지 무슨 일이 일어나는지를 단계별로** 따라간다.

## 1. 영속성 컨텍스트 = 네 개의 저장소

"트랜잭션 범위에서 엔티티를 메모리에 보관하는 것"은 맞지만, **보관소가 하나가 아니라 넷**이라는 점까지 말해야 이후 모든 동작이 설명된다.

### 1-1. 먼저 단어 두 개 — flush와 commit은 다른 일이다

이 문서에서 가장 자주 나오는 단어부터 못 박고 시작하자. 둘을 뭉뚱그리면 뒤의 설명이 전부 흐릿해진다.

**flush(플러시)**란 영속성 컨텍스트가 들고 있던 변경을 **SQL로 만들어 DB로 내보내는** 동작이다. "내보낸다"까지가 전부다.

**commit(커밋)**은 그렇게 내보낸 것을 **트랜잭션 차원에서 확정하는** 동작이다. 커밋하기 전까지 그 변경은 언제든 롤백으로 사라질 수 있다.

```text
  em.flush()                          tx.commit()
      │                                    │
      ▼                                    ▼
  UPDATE 문이 DB로 나갔다            그 UPDATE가 확정됐다
  (다른 트랜잭션에는 아직 안 보인다)   (이제 되돌릴 수 없다)
      │
      └── 이 사이에 롤백되면 나갔던 UPDATE는 없던 일이 된다
```

그래서 **"flush했으니 저장됐다"는 틀린 문장**이다. flush는 커밋이 아니다. 이 구분은 §4의 "`flush()`를 직접 호출해도 되나" 질문에서 다시 결정적으로 쓰인다.

순서상 커밋은 flush를 포함한다 — 커밋할 때 JPA는 **먼저 flush를 돌려 남은 변경을 SQL로 내보내고, 그다음 커밋**한다. 그래서 "커밋 시점에 UPDATE가 나간다"는 표현은 정확히는 "커밋 직전의 자동 flush에서 UPDATE가 만들어져 나간다"는 뜻이다.

flush는 커밋 직전에만 일어나는 것이 아니다. 언제 또 일어나는지는 §2-2에서 다루고, 그 횟수가 곧 비용이 된다.

### 1-2. 엔티티를 처음 조회하는 순간 — 단계별로

`orderRepository.findById(1L)` 한 줄이 실제로 무슨 일을 하는지를 먼저 봐야 한다. 여기서 만들어지는 것이 뒤의 모든 동작을 결정한다.

```text
em.find(Order.class, 1L)  ─ 한 줄이 실제로 하는 일

 ① select ... from orders where id = 1        DB에서 행 하나를 읽는다
        │
 ② Order 인스턴스를 만들어 필드를 채운다        읽은 행을 자바 객체로 옮긴다
        │
        ├──▶ 1차 캐시       { 1L → order }
        │                    "이 트랜잭션에서 id 1L 은 이 인스턴스다"라고 등록한다.
        │                    다음에 같은 id 를 find 하면 SELECT 없이 이걸 그대로 돌려준다.
        │
        └──▶ 스냅샷 저장소   { 1L → ["PAID", 10000, null, 2026-01-02] }
                             지금 채운 그 값들을 한 벌 더 복사해 따로 보관한다.
                             이 사본은 앞으로 아무도 건드리지 않는다 — 로드 시점의 사진이다.
```

여기서 놓치면 안 되는 것은 **②에서 두 개가 만들어진다**는 사실이다. 하나는 우리가 코드에서 만지게 될 엔티티 인스턴스이고, 다른 하나는 그 순간의 필드값을 통째로 복사해둔 **스냅샷**이다. 스냅샷은 우리 코드에서 접근할 수 없는 곳(`EntityEntry.loadedState`)에 조용히 놓인다.

그리고 커밋 직전이 되면 이 두 벌을 **필드 단위로 하나씩 맞춰본다.**

```text
커밋 직전, 관리 중인 Order(id=1) 하나에 대해 벌어지는 대조

  현재 인스턴스의 필드              스냅샷(로드 시점의 사진)         판정
  ────────────────────────────────────────────────────────────────────────
  status      = "CANCELED"    ↔    status      = "PAID"           다름
  totalAmount = 10000         ↔    totalAmount = 10000            같음
  memo        = null          ↔    memo        = null             같음
  orderedAt   = 2026-01-02    ↔    orderedAt   = 2026-01-02       같음
  ────────────────────────────────────────────────────────────────────────
  다른 필드가 하나라도 있으므로 이 엔티티는 "dirty(더러워졌다)"로 판정된다.
  → 쓰기 지연 저장소에 UPDATE 문이 한 건 등록된다.
  → 단, 그 UPDATE 에 status 만 담기는 것이 아니다(§2-5):
     update orders set status=?, total_amount=?, memo=?, ordered_at=? where id=?
```

**"변경 감지(dirty checking)"라는 이름은 여기서 나온다.** 개발자가 "이거 바뀌었으니 저장해줘"라고 말하지 않아도 JPA가 스스로 **감지(detect)**해서 UPDATE를 만든다는 뜻이다. 감지의 정체는 마법이 아니라 위의 대조표 한 장이다.

### 1-3. 왜 스냅샷을 따로 두는가 — 자바에는 "이 객체 바뀌었다"를 알려주는 장치가 없다

여기서 자연스럽게 나오는 질문이 있다. 메모리를 두 배로 쓰면서까지 사본을 보관하는 이유가 무엇인가. 그냥 바뀔 때마다 표시해두면 되지 않나.

답은 자바 언어 자체에 있다. **자바에는 "이 객체의 필드가 방금 바뀌었다"를 밖에 알려주는 표준 장치가 없다.** `order.status = CANCELED`라는 대입은 그냥 메모리 한 칸을 덮어쓸 뿐이고, 그 사실을 어디에도 통보하지 않는다. JPA가 `order` 인스턴스를 아무리 들여다봐도 "지금 이 값이 원래 값인지 누가 바꾼 값인지"는 알 수 없다.

그래서 남는 선택지는 원리적으로 셋뿐이다.

| 방식 | 어떻게 감지하나 | 대가 |
|---|---|---|
| **스냅샷 대조** (Hibernate 기본) | 로드 시점 사본을 들고 있다가 flush 때 맞춰본다 | 메모리(사본 한 벌) + CPU(전건 비교) |
| 변경 통보(setter에 코드 삽입) | 값을 바꾸는 모든 통로에 "바뀌었다" 신호를 심는다 | 엔티티가 프레임워크 코드에 오염된다. 필드 직접 대입은 못 잡는다 |
| 바이트코드 강화 | 빌드/로딩 시점에 엔티티 클래스를 변형해 필드 쓰기를 가로챈다 | 별도 빌드 설정이 필요하고 디버깅이 어려워진다 |

Hibernate가 기본으로 첫 번째를 고른 이유는 **엔티티가 아무것도 상속하지 않고 아무 애노테이션 없이도 순수 자바 객체(POJO)로 남을 수 있기 때문**이다. 우리가 `order.cancel()`이라고만 써도 되는 것, 엔티티 클래스에 JPA 인터페이스를 구현하지 않아도 되는 것이 전부 이 선택의 결과다. 그 편의의 청구서가 §2의 비용이다.

비유하면 이렇다. 스냅샷 대조는 **집을 나서기 전에 방 사진을 찍어두고, 돌아와서 사진과 지금 방을 비교해 무엇이 달라졌는지 찾는 방식**이다. 방 안의 모든 물건에 센서를 다는 방식(변경 통보)보다 물건 쪽이 깨끗하지만, 돌아올 때마다 방 전체를 훑어야 한다.

### 1-4. 저장소 넷을 한 표로

| 저장소 | 담는 것 | 키 | 없다면 |
|---|---|---|---|
| **1차 캐시** | 엔티티 인스턴스 | `@Id` 값 | 같은 id를 두 번 조회하면 서로 다른 객체 2개 |
| **스냅샷 저장소** | 로드 시점 필드값 **복사본** | `@Id` 값 | 무엇이 바뀌었는지 알 방법이 없음 → `save()` 수동 호출 |
| **쓰기 지연 SQL 저장소** | 아직 안 보낸 INSERT/UPDATE/DELETE | 등록 순서 | 필드 수정마다 쿼리 1건 즉시 전송 |
| **동일성 보장** | (위 셋의 **결과**) | — | 같은 트랜잭션 안에서 앱 스스로 lost update를 만듦 |

네 번째 줄이 나머지 셋과 성질이 다르다는 점을 짚어두자. 동일성 보장은 별도의 자료구조가 아니라 **1차 캐시가 있기 때문에 저절로 따라오는 성질**이다. 그래서 "저장소 넷"이라고 말하되 마지막 하나는 결과라고 덧붙이면 정확하다.

### 1-5. 1차 캐시는 성능 캐시가 아니다

`@Id` → 엔티티 인스턴스를 담은 `Map` 하나가 1차 캐시의 전부다. 같은 트랜잭션에서 같은 id를 다시 `find` 하면 SELECT가 생략되는 건 맞다. 그러나 이걸 **성능 장치로 설계에 쓰면 안 된다.**

- **범위가 트랜잭션이다.** 트랜잭션이 끝나면 통째로 사라진다. 히트율을 설계 변수로 쓸 수 있는 캐시는 범위가 트랜잭션보다 길어야 한다(2차 캐시, Redis).
- **JPQL은 1차 캐시를 조회 경로로 쓰지 않는다**(§1-9). 조회 방식만 바꿔도 효과가 사라지는 것은 성능 장치라 부를 수 없다.
- 애초에 **같은 트랜잭션에서 같은 엔티티를 여러 번 조회하는 코드 자체가 설계 문제**인 경우가 많다.

그러면 1차 캐시의 진짜 값은 무엇인가 — **동일성과 정합성**이다.

여기서 전제 지식을 하나 깔자. **lost update(갱신 손실)**란 두 개의 수정이 같은 데이터를 두고 경쟁할 때 나중 것이 앞선 것을 덮어써서 앞선 변경이 사라지는 현상이다. 보통은 서로 다른 트랜잭션 사이의 문제로 배우지만, 1차 캐시가 없다면 **한 트랜잭션 안에서 우리 코드가 스스로** 이 현상을 만들 수 있다.

```java
@Transactional
public void applyCoupon(Long orderId) {
    Order a = orderRepository.findById(orderId).orElseThrow();
    Order b = orderRepository.findById(orderId).orElseThrow();

    a.discount(1000);
    b.discount(2000);

    // a == b 가 참이다. 즉 하나의 인스턴스에 두 변경이 누적되고
    // flush 시점에 UPDATE 1건(할인 3000)이 나간다.
    // 만약 서로 다른 객체 2개였다면 나중 UPDATE가 앞선 변경을 덮어써서
    // 트랜잭션 하나 안에서 우리 코드가 스스로 lost update를 만든다.
}
```

두 서비스 메서드가 각자 조회해 각자 수정하는 실무 코드가 조용히 잘 동작하는 이유가 이것이다. 즉 1차 캐시는 **"쿼리를 아껴주는 캐시"가 아니라 "같은 것을 같은 것으로 다루게 해주는 장치"** 다. 첫 답변에서 이렇게 말하면 급이 달라진다.

### 1-6. 스냅샷은 "변경분 모음"이 아니라 로드 시점의 사진이다

여기가 가장 흔하게 흐릿해지는 지점이다. "변경된 데이터를 분리해서 갖고 있다"는 설명은 구조를 거꾸로 본 것이다. 실제로는 **바뀌는 것이 엔티티 인스턴스 자체이고, 따로 갖는 쪽이 안 바뀐 원본(스냅샷)** 이다.

```java
Order order = em.find(Order.class, 1L);
// 1차 캐시   : { 1L -> order }                      ← 인스턴스 그 자체
// 스냅샷     : { 1L -> ["PAID", 10000, "2026-01-02"] }  ← 로드 시점 필드값 복사본

order.cancel();          // status: PAID -> CANCELED
// 1차 캐시의 order 인스턴스가 바뀐다. 스냅샷은 여전히 "PAID".
// "변경분"을 모아둔 자리는 어디에도 없다.
```

이 구조 차이가 실무에서 두 가지 결과를 만든다.

- **무엇이 바뀌었는지 flush 전까지 아무도 모른다.** 그래서 "수정하지 않은 엔티티도 비교 대상"이라는 결론이 나온다 — 수정 여부는 대조 후에야 알기 때문에. 이게 §2의 비용이 불가피한 이유다.
- **setter 호출 한 번이 곧 UPDATE 예약이 아니다.** 값을 넣었어도 스냅샷과 같으면 UPDATE는 나가지 않는다. 반대로 setter를 안 불러도 대조 결과가 다르면 UPDATE가 나간다 — §3이 전부 이 문장에서 나온다.

전체 흐름을 한 장으로 정리하면 이렇다.

```text
스냅샷은 "변경분 모음"이 아니라 로드 시점의 사진이다.
무엇이 바뀌었는지는 ④에서 대조해봐야 비로소 알 수 있다 — 그래서 전건 비교를 피할 수 없다.

─ 조회 시점 · em.find(Order.class, 1L) ────────────────────────────────────────
 ① SELECT 실행 → 인스턴스 생성      1차 캐시에 1L → order 로 등록
 ② 같은 값을 한 벌 더 복사          스냅샷 저장소에 1L → ["PAID", 10000, ...]
                                    엔티티마다 사본이 한 벌씩 더 생기는 지점

─ 코드 실행 중 · order.cancel() ───────────────────────────────────────────────
 ③ 인스턴스의 필드가 바뀐다         바뀌는 건 order 하나. 스냅샷은 그대로 "PAID".
                                    SQL 은 아직 만들어지지 않았다

─ flush 시점 · 커밋 직전 / JPQL 실행 직전 / em.flush() 호출 ────────────────────
 ④ 관리 엔티티 전건 × 전 필드 대조   수정 안 한 엔티티도 예외 없다
                                    — 수정 여부는 대조 후에야 알기 때문
 ⑤ 차이가 있는 엔티티만 UPDATE 생성  변경된 컬럼만이 아니라 전 컬럼 UPDATE 가 기본값
 ⑥ 쓰기 지연 저장소를 순서대로 전송  코드 순서가 아니라 INSERT → UPDATE → DELETE 고정
```

### 1-7. 쓰기 지연 — 모아두는 이유는 세 가지

`persist()`나 필드 수정 즉시 SQL을 보내지 않고 flush 시점까지 모아둔다. 이득은 "쿼리를 한 번에 보내서 빠르다"보다 구체적이다.

- **JDBC 배치가 가능해진다** — 같은 종류의 INSERT/UPDATE를 묶어 왕복 횟수를 줄인다(`hibernate.jdbc.batch_size`).
- **쓰기 락 보유 구간이 짧아진다** — UPDATE를 쏜 순간부터 커밋까지 그 행의 락을 쥐고 있으므로, 쓰기를 커밋 직전으로 미루면 락 보유 시간이 줄어 경합이 감소한다. 이 항목을 말하면 가산점 포인트다.
- **같은 엔티티를 여러 번 수정해도 UPDATE는 1건** — §1-5의 예시가 그것이다.

예외가 하나 있다. `@GeneratedValue(strategy = IDENTITY)`는 **INSERT를 보내야 id를 알 수 있으므로** `persist()` 시점에 INSERT가 즉시 나간다(그래서 이 전략에서는 INSERT 배치가 무력화된다). "쓰기 지연"에 예외가 있다는 것까지 말하면 좋다.

### 1-8. 동일성 보장

```java
Order a = em.find(Order.class, 1L);
Order b = em.find(Order.class, 1L);
a == b;                 // true — 같은 트랜잭션, 같은 id
// 다른 트랜잭션이라면 false. 그래서 엔티티 비교는 id 기준 equals 로 해야 한다.
```

같은 트랜잭션 안에서만 성립한다는 조건을 빠뜨리지 않는 것이 중요하다. 트랜잭션 경계를 넘어 엔티티를 비교·컬렉션에 담아야 한다면 `==`나 기본 `equals`가 아니라 **id 기반 `equals`/`hashCode`** 가 필요하다.

### 1-9. JPQL은 1차 캐시를 우회한다 (조회 경로에서만)

두 가지를 함께 알아야 한다.

- **JPQL/QueryDSL 조회는 항상 DB로 나간다.** 1차 캐시를 먼저 뒤지는 것은 `find(id)` 같은 id 기반 조회뿐이다. 1차 캐시를 성능 장치로 볼 수 없는 이유다.
- **DB에서 읽어온 행이 이미 관리 중인 인스턴스를 덮지 않는다.** 결과 행의 id가 1차 캐시에 이미 있으면 **기존 인스턴스가 반환되고, 방금 읽은 행의 값은 버려진다.**

```java
@Transactional
public void demo(Long id) {
    Order order = orderRepository.findById(id).orElseThrow();   // status = PAID, 1차 캐시 등록
    orderRepository.bulkCancelAll();                            // JPQL UPDATE ... (DB는 CANCELED)

    List<Order> list = orderRepository.findAllByStatusJpql();    // SELECT 는 DB로 나간다
    // list 안의 그 엔티티는 방금 읽은 CANCELED 가 아니라 1차 캐시의 PAID 인스턴스다.
    // "DB는 바뀌었는데 조회 결과는 옛 값" 미스터리의 정체.
}
```

이는 버그가 아니라 **한 트랜잭션 안에서 같은 엔티티가 도중에 값이 바뀌지 않게 하는(repeatable read) 의도된 동작**이다. 벌크 연산이나 네이티브 쿼리로 DB를 직접 바꿨다면 `em.clear()`(또는 `@Modifying(clearAutomatically = true)`)로 1차 캐시를 비워야 한다.

반대 방향도 있다. **JPQL 실행 직전에는 flush가 먼저 일어난다**(기본 `FlushMode.AUTO`). 안 그러면 방금 `persist()`한 데이터가 조회 결과에 빠지기 때문이다. 이 자동 flush가 §2-2의 비용을 여러 번 발생시키는 원인이다.

## 2. flush — 실제 비용과 그것이 만드는 SQL의 두 가지 반직관

"조회만 했는데 커밋 시점에 애플리케이션이 하는 일이 있나?"에 **"메모리와 GC"만 답하면 절반**이다. 나머지 절반이 CPU다. 그리고 그렇게 만들어진 SQL 자체에도 반직관적인 성질이 둘 있다(§2-4, §2-5).

### 2-1. 메모리 — 엔티티마다 스냅샷 한 벌이 더 생긴다

엔티티 1,000건을 읽으면 인스턴스 1,000개 + 스냅샷 1,000벌이다. **엔티티 하나당 한 벌씩 늘어난다**는 성질이 핵심이고, 조회 건수가 커질수록 선형으로 따라온다.

스냅샷 한 벌이 얼마나 되는지 대략의 감을 잡아두면 답변이 구체적이 된다. 스냅샷은 엔티티 인스턴스의 사본이 아니라 **필드값을 순서대로 담은 `Object[]` 배열 하나**다.

```text
필드 20개짜리 엔티티, 64비트 JVM · 압축 oop(힙 32GB 미만) 기준

  Object[20] 한 벌
    객체 헤더 12바이트 + 배열 길이 4바이트          = 16바이트
    참조 20개 × 4바이트                             = 80바이트
                                                    ──────────
                                                      96바이트 (8바이트 정렬에 이미 맞음)

  1,000건이면 96 × 1,000 = 96,000바이트 ≈ 94KB (배열 자체만 계산했을 때)
```

여기에 **정확히 해둘 점**이 하나 있다. "메모리가 2배"라는 표현은 상한에 가까운 어림이다. 스냅샷 배열에 들어가는 값은 타입별 **MutabilityPlan**(그 타입을 복사할 때 어떻게 복사할지 정해둔 규칙)에 따라 다르게 담긴다.

- **불변 타입**(`String`, `Integer`, `enum`, `LocalDate` 등)은 같은 인스턴스를 그대로 가리킨다. 문자열 본체가 두 벌 생기지는 않고 **참조 하나(4~8바이트)만** 늘어난다.
- **가변 타입**(`java.util.Date`, 배열, 그리고 §3-3의 컨버터 매핑 값)은 **깊은 복사본이 새로 만들어진다.** 이쪽은 실제로 객체가 하나 더 생긴다.

그래서 정확한 문장은 "힙 사용량이 정확히 2배가 된다"가 아니라 **"관리 엔티티 하나마다 스냅샷 배열 한 벌이 반드시 추가되고, 가변 타입 필드는 그 값까지 한 벌 더 복사된다"**이다. 배치처럼 관리 엔티티 수가 만 단위로 올라가면 이 선형 증가가 그대로 OOM 위험이 된다.

### 2-2. CPU — flush마다 `O(관리 엔티티 수 × 필드 수)`

여기가 이 질문의 변별 지점이다. 필드 20개인 엔티티 1,000건이면 **flush 1회에 20 × 1,000 = 20,000번의 필드 비교**가 일어난다. 그리고 결정적으로 —

**flush는 커밋 때 한 번만 일어나지 않는다.** 기본 `FlushMode.AUTO`에서는 JPQL/QueryDSL 쿼리를 실행할 때마다 그 앞에서 flush가 돈다(§1-9). 조회 메서드 안에서 JPQL을 3번 호출했다면 flush는 4번(3 + 커밋 1) 일어나고, 비교는 20,000 × 4 = **80,000번**이 된다.

그리고 조회 전용 화면이라면 **그 비교의 결과는 전부 "변경 없음"** 이다. 100% 헛수고인 CPU를 지불한 것이다. 이 문장까지 말하면 정량 감각이 있는 답변이 된다.

배치에서는 이 성질이 더 고약해진다. `clear()`를 빼먹으면 관리 엔티티가 계속 쌓이므로, flush 한 번의 비용 자체가 회를 거듭할수록 커진다.

```text
5만 건을 순회 수정하면서 1,000건마다 flush() 만 하고 clear() 는 하지 않은 경우

  1회차 flush : 관리 엔티티   1,000건 비교
  2회차 flush : 관리 엔티티   2,000건 비교   ← 앞의 1,000건이 그대로 남아 있다
  3회차 flush : 관리 엔티티   3,000건 비교
   ...
 50회차 flush : 관리 엔티티  50,000건 비교

  누적 = 1,000 + 2,000 + ... + 50,000
       = 1,000 × (50 × 51 / 2)
       = 1,275,000건   (flush 1회 평균 25,500건)

  → chunk 마다 flush() 후 반드시 clear() 로 컨텍스트를 비워야
    회차마다 1,000건씩 고정, 누적 50,000건으로 돌아온다 (25배 차이)
```

이 곡선이 **진행될수록 느려지는(관리 엔티티 수에 대해 사실상 `O(n²)`인) 배치**의 정체다. "처음엔 빨랐는데 갈수록 느려진다"는 배치 장애 리포트를 보면 이 패턴부터 의심하면 된다.

### 2-3. 회피 수단 두 가지 — 같은 문제를 다른 층에서 푼다

| | `@Transactional(readOnly = true)` | **DTO 프로젝션** |
|---|---|---|
| 무엇을 하나 | flush 자체를 억제(`FlushMode.MANUAL`) + 세션을 read-only로 | 애초에 엔티티를 안 만든다 |
| 1차 캐시 | 여전히 올라간다 | 올라가지 않는다 |
| 스냅샷 | 생략(조건 있음, 아래) | 존재 자체가 없음 |
| SELECT 컬럼 | 엔티티 전 컬럼 | 필요한 컬럼만 |
| 성질 | 이미 지불한 비용의 **뒷단을 깎는 사후 최적화** | **비용 구조를 만들지 않는 설계** |

용어를 하나 풀어두자. **DTO 프로젝션**이란 조회 결과를 엔티티가 아니라 **그 화면에 필요한 필드만 담은 전용 객체(DTO, Data Transfer Object)로 직접 받아오는 것**이다. "프로젝션(projection, 사영)"은 관계형 대수에서 필요한 컬럼만 골라내는 연산의 이름이고, 여기서도 뜻이 같다 — 전체 행이 아니라 필요한 컬럼만 뽑는다.

```java
// before — 목록 조회인데 엔티티를 그대로 올린다
@Transactional
public List<OrderResponse> list(SearchCond cond) {
    List<Order> orders = orderRepository.search(cond);   // 1,000건: 인스턴스 + 스냅샷
    return orders.stream().map(OrderResponse::from).toList();
}
// flush 때 20,000번 비교 → 결과는 전부 "변경 없음". 게다가 목록에 안 쓰는
// LOB/설명 컬럼까지 전부 SELECT 된다.
```

```java
// after ① — readOnly: flush 를 막아 비교를 실행하지 않게 한다
@Transactional(readOnly = true)
public List<OrderResponse> list(SearchCond cond) { ... }
```

```java
// after ② — DTO 프로젝션: 컨텍스트에 올리지 않아 비용 자체가 발생하지 않는다
public interface OrderRepository extends JpaRepository<Order, Long> {
    @Query("""
        select new com.example.order.OrderResponse(o.id, o.status, o.totalAmount, o.orderedAt)
        from Order o where o.status = :status
        """)
    List<OrderResponse> findResponses(@Param("status") OrderStatus status);
}
// 1차 캐시 X, 스냅샷 X, 쓰기 지연 X, 필요한 4개 컬럼만 SELECT.
// 반환값이 엔티티가 아니므로 "실수로 수정" 자체가 불가능하고,
// 컨트롤러에서 지연 로딩을 건드릴 여지도 없다(LazyInitializationException 원천 차단).
```

**DTO 프로젝션이 더 근본적인 이유**를 세 가지로 정리하면 좋다.

1. `readOnly`는 **뒷단만 깎는다** — 엔티티 인스턴스화, 전 컬럼 SELECT, 1차 캐시 등록 비용은 그대로 남는다. DTO는 그 앞단부터 없앤다.
2. `readOnly`는 **실수에 취약하다** — 쓰기 로직이 섞여 들어가면 예외 없이 조용히 증발한다(막아주는 안전장치가 아니다 → `02-spring/13-transactional-readonly-optimization.md`).
3. `readOnly`의 효과는 **구성에 따라 흔들린다**(바로 아래 확인 범위). DTO는 구성과 무관하게 성립한다.

**확인 범위 노트** — "readOnly면 스냅샷을 만들지 않는다"는 설명은 널리 통용되지만, 확인해보면 조건이 붙는다. Spring Framework 6.2.x / 현재 main의 `HibernateJpaDialect.beginTransaction`은 read-only 트랜잭션에서 `FlushMode.MANUAL`은 **항상** 걸지만, 스냅샷 생략의 실제 스위치인 `Session.setDefaultReadOnly(true)`는 **트랜잭션-로컬 EntityManager일 때만** 호출한다(`JpaTransactionManager`가 이 트랜잭션에서 EntityManager를 새로 만든 경우 = `isNewEntityManagerHolder()`). 즉 이미 열려 있는 EntityManager에 참여하는 경로(OSIV 등)에서는 flush 억제는 되어도 스냅샷 생략은 보장되지 않는다.

정리하면 — **확실한 이득은 "flush가 없으니 비교가 실행되지 않는다"(CPU)이고, 메모리 절감은 구성에 따라 달라질 수 있다.** 버전·구성에 따라 다를 수 있으니 중요한 판단이라면 heap이나 Statistics로 직접 확인하는 편이 안전하다.

### 2-4. 반직관 ① — 실행 순서는 코드 순서가 아니다

flush가 쓰기 지연 저장소를 비울 때, 등록된 순서대로 SQL을 쏘지 않는다. Hibernate는 **종류별로 정해진 순서**로 실행한다. 5.6과 현재 main의 `ActionQueue`에서 확인한 순서는 다음과 같다.

1. 고아 객체 제거(orphan removal)
2. **엔티티 INSERT**
3. **엔티티 UPDATE**
4. 컬렉션 대기 연산 → 컬렉션 DELETE → 컬렉션 UPDATE → 컬렉션 재생성
5. **엔티티 DELETE**

그래서 이런 코드가 터진다.

```java
// before — 코드는 "지우고 다시 넣기"인데, SQL은 "넣고 나서 지우기"로 나간다
@Transactional
public void replaceTags(Long postId, List<String> names) {
    tagRepository.deleteByPostId(postId);            // DELETE 예약
    names.forEach(n -> tagRepository.save(new Tag(postId, n)));  // INSERT 예약
}
// flush 시: INSERT 가 먼저, DELETE 가 나중 →
// (post_id, name) 유니크 제약이 있으면 여기서 위반 예외.
// "분명 지우고 넣었는데 중복 오류"의 정체.
```

```java
// after — 순서를 코드로 강제한다
@Transactional
public void replaceTags(Long postId, List<String> names) {
    tagRepository.deleteByPostId(postId);
    tagRepository.flush();                           // 여기서 DELETE 를 먼저 내보낸다
    names.forEach(n -> tagRepository.save(new Tag(postId, n)));
}
```

`flush()`를 끼우는 것이 유일한 답은 아니다(이미 있는 행을 지우지 않고 재사용하는 설계, 컬렉션 `clear()` + `addAll()` 등). 중급 문항에서 더 깊이 다루므로 여기서는 **"함정이 존재하고 그 원리가 고정 실행 순서다"** 까지 말하면 충분하다. 전체 순서 규칙과 그 이유(FK 위반 회피 + JDBC 배치), 데드락 축, 배포 전에 잡는 방법은 [flush 시점과 쓰기 지연 SQL 실행 순서](15-flush-timing-and-sql-ordering.md)에서 다룬다.

### 2-5. 반직관 ② — 기본 UPDATE는 전 컬럼 UPDATE다

"변경된 컬럼만 UPDATE 된다"는 흔한 오해다. Hibernate는 기본적으로 엔티티별 UPDATE 문을 **부팅 시점에 전 컬럼 기준으로 한 번 만들어두고 재사용**한다.

```sql
-- status 하나만 바꿨는데 실제로 나가는 SQL
update orders set status=?, total_amount=?, memo=?, ordered_at=?, updated_at=? where id=?
```

이유는 성능이다 — SQL 문자열이 고정이라 매 flush마다 새로 만들 필요가 없고, DB의 구문(파싱) 캐시와 `PreparedStatement` 재사용 이점을 그대로 얻는다.

부작용이 셋 있다.

- **안 바꾼 컬럼도 덮어쓴다** — 로드 시점 값이 그대로 다시 쓰인다. §3-3의 "NULL이 조용히 'N'으로 바뀌는" 사고가 여기서 나온다.
- **큰 컬럼도 매번 전송한다** — LOB/긴 텍스트 컬럼이 있으면 트래픽이 낭비된다.
- **감사(audit) 트리거가 전 컬럼 변경으로 기록한다** — 변경 이력이 부풀어 보인다.

`@DynamicUpdate`를 붙이면 **바뀐 컬럼만으로 SQL을 매 flush마다 생성**한다. 트레이드오프는 명확하다 — 조합마다 SQL이 달라지므로 **미리 만들어둔 정적 SQL과 구문 캐시 이점을 잃는다.** 그래서 전역 적용보다 **컬럼이 매우 많거나 LOB이 있는 특정 엔티티에 한정**하는 것이 일반적 판단이다.

## 3. "안 시킨 UPDATE" — setter 전수 조사로는 안 끝난다

조회성 API인데 `updated_at`이 갱신되고 감사 로그에 UPDATE가 남는다. "엔티티를 수정하는 메서드를 쓰는지 확인한다"는 **1단계로는 타당하지만, 전수 조사에서 정말 없었을 때 답이 끊기면 안 된다.** 남은 것들이 실무 단골이다.

### 3-1. 먼저 비교의 주체를 바로잡자 — `equals`가 아니다

기본 필드의 dirty checking은 **엔티티의 `equals`/`hashCode`를 쓰지 않는다.** Hibernate가 필드 타입별 비교기(`JavaType#areEqual`)로 스냅샷과 현재 값을 하나씩 대조한다. 그래서 엔티티에 Lombok `@EqualsAndHashCode`를 어떻게 붙였든 기본 필드 dirty 판정에는 영향이 없다.

이 사실이 널리 퍼진 통설 하나를 정리해준다.

**"BigDecimal scale 불일치(`1.10` vs `1.1`) 때문에 dirty로 판정된다"** — 자바의 `BigDecimal.equals`는 scale까지 봐서 둘을 다르다고 판단하는 것이 맞다(`01-java-kotlin/32-bigdecimal-equals-compareto.md`). 그런데 **Hibernate는 이 필드를 `equals`로 비교하지 않는다.** 확인해보면 5.6의 `BigDecimalTypeDescriptor`와 현재 main의 `BigDecimalJavaType` 모두 `areEqual`을 이렇게 재정의해 두었다.

```java
// Hibernate 소스 (5.6 / main 동일) — equals 가 아니라 compareTo 다
return one == another
    || ( one != null && another != null && one.compareTo( another ) == 0 );
```

`compareTo`는 값만 보고 scale은 무시하므로 `1.10`과 `1.1`을 같다고 판정한다. 즉 **기본 매핑에서는 scale 차이만으로 dirty가 되지 않는다**(확인 범위: 위 두 버전의 소스. 아주 오래된 버전이나 커스텀 `UserType`은 별도 확인이 필요하다).

scale이 여전히 사고를 내는 자리는 JPA 밖이다 — 자바 컬렉션(`Set`, `contains`), 직접 구현한 `equals`, 금액 일치 검증, 그리고 **BigDecimal을 문자열로 저장하는 컨버터**(문자열이 되면 `"1.10" != "1.1"`이므로 §3-3 문제로 바뀐다).

여기서 얻을 교훈이 §3 전체를 관통한다: **"자바에서 다른 값인가"가 아니라 "Hibernate의 그 타입 비교기가 다르다고 보는가"를 물어야 한다.**

정리하면 단골 원인은 다음과 같다.

| 원인 | 판정 이유 | 빈도 |
|---|---|---|
| 컬렉션 재할당 | 관리 컬렉션 인스턴스가 교체됨 | 매우 높음(파괴적) |
| `AttributeConverter` | 스냅샷이 컨버터 왕복 복사본이라 원본과 어긋남 | 높음 |
| 시간 타입 정밀도 | 로드된 값(초 단위)과 코드가 넣은 값(나노초)이 다름 | 높음 |
| OSIV + setter | 트랜잭션 밖 setter가 컨텍스트에 남아 다음 커밋에 실림 | 높음(원인 추적 최난도) |
| BigDecimal scale | (통설 — 위 검증 결과 기본 매핑에서는 해당 없음) | — |

### 3-2. 컬렉션 재할당 — 가장 파괴적

```java
// before — DTO 를 엔티티에 반영하면서 컬렉션을 통째로 갈아끼운다
@Transactional
public void update(Long orderId, OrderUpdateRequest req) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    order.setItems(new ArrayList<>(req.toItems()));   // 문제의 한 줄
}
// Hibernate 는 관리 중이던 컬렉션(PersistentCollection)이 "버려졌다"고 보고
// 기존 자식 전체 DELETE + 새 컬렉션 전체 INSERT 를 만든다.
// 내용이 완전히 동일해도 마찬가지다 — 인스턴스가 바뀌었기 때문.
// orphanRemoval = true 라면 예외로 터진다:
//   "A collection with cascade=all-delete-orphan was no longer referenced..."
```

왜 이런 일이 벌어지는지 한 줄 더 들어가면 이해가 굳는다. 엔티티를 로드할 때 Hibernate는 컬렉션 필드에 우리가 넣어둔 `ArrayList`를 그대로 두지 않고, **자기가 관리할 수 있는 래퍼(`PersistentBag` 등, 통칭 `PersistentCollection`)로 바꿔 끼운다.** 그 래퍼가 추가·삭제를 추적한다. 그런데 `setItems(new ArrayList<>(...))`는 그 래퍼를 통째로 버리고 생판 다른 `ArrayList`를 꽂아버리는 행위다. Hibernate 입장에서는 "관리하던 컬렉션이 사라졌다"이므로, 안전한 해석은 하나뿐이다 — **옛것은 전부 지우고 새것을 전부 넣는다.**

```java
// after — 관리 컬렉션 인스턴스를 유지하고 내용만 바꾼다
@Entity
public class Order {
    @OneToMany(mappedBy = "order", cascade = ALL, orphanRemoval = true)
    private final List<OrderItem> items = new ArrayList<>();   // 교체 불가로 못 박는다

    public void replaceItems(List<OrderItem> newItems) {
        this.items.clear();                 // 같은 인스턴스를 비우고
        newItems.forEach(this::addItem);    // 다시 채운다 → 차이나는 행만 처리된다
    }

    private void addItem(OrderItem item) {
        items.add(item);
        item.setOrder(this);                // 양방향 동기화
    }
}
```

핵심은 **컬렉션 필드에 setter를 만들지 않는 것**이다. `final` + 초기화로 두면 이 사고가 구조적으로 불가능해진다. (`clear()` + `addAll()`도 자식 전체 DELETE + INSERT로 나갈 수 있어 대량 자식에는 부담이 있다 — 그때는 자식을 개별 식별해 차분만 반영하는 설계로 간다.)

### 3-3. `AttributeConverter` — 스냅샷 자체가 컨버터 왕복 복사본이다

전제부터 깔자. **`AttributeConverter`**는 "자바 필드 타입 ↔ DB 컬럼 타입"을 상호 변환하는 규칙을 담은 클래스다. `Boolean` 필드를 `'Y'`/`'N'` 문자로 저장하거나, POJO를 JSON 문자열 컬럼에 넣을 때 쓴다.

이 원인은 메커니즘을 알면 예측 가능해진다. §2-1에서 스냅샷은 타입별 MutabilityPlan에 따라 복사된다고 했는데, 컨버터가 걸린 필드의 복사 규칙이 특이하다. 확인해보면 Hibernate main의 `AttributeConverterMutabilityPlan`은 스냅샷용 깊은 복사를 이렇게 만든다.

```java
// Hibernate 소스 (main) — 스냅샷은 "컨버터로 내보냈다 다시 읽은 값"이다
protected T deepCopyNotNull(T value) {
    return converter.toDomainValue( converter.toRelationalValue( value ) );
}
```

즉 **스냅샷에 들어가는 값은 원본 필드값이 아니라, 컨버터를 한 바퀴 돌려 나온 값**이다. 그리고 컨버터로 매핑한 값은 **기본적으로 mutable(가변)로 간주**된다(원시 타입과 enum은 immutable로 추론). 여기서 두 가지 사고가 나온다.

- **왕복이 값을 바꾸면 로드 직후부터 dirty다.** 정규화, 자릿수 보정, JSON 키 순서 변경 등 왕복이 값을 손대는 컨버터라면 스냅샷과 필드가 처음부터 다르다.
- **도메인 타입에 `equals`가 없으면 항상 dirty다.** 왕복 복사본은 새 인스턴스라, `equals`가 없으면 동일성 비교가 되어 매 flush마다 "다르다"가 된다.

```java
// before — JSON 컬럼을 POJO 로 매핑, equals 없음
public class ShippingMeta {        // equals/hashCode 가 없는 것이 문제의 시작
    private String courier;
    private String trackingNo;
}

@Converter
public class ShippingMetaConverter implements AttributeConverter<ShippingMeta, String> {
    public String convertToDatabaseColumn(ShippingMeta m) { return toJson(m); }
    public ShippingMeta convertToEntityAttribute(String s) { return fromJson(s); }
}
// 스냅샷 = fromJson(toJson(meta)) → 값은 같지만 다른 인스턴스
// → equals 가 없으니 매번 "변경됨" → 조회만 해도 flush 마다 UPDATE
```

```java
// after ① — 도메인 타입을 값 객체로: record 는 equals 를 자동 생성한다
public record ShippingMeta(String courier, String trackingNo) {}
```

```java
// after ② — 왕복 비용도 아깝다면 불변임을 선언한다
@Convert(converter = ShippingMetaConverter.class)
@Immutable            // 또는 @Mutability(...) 로 복사·비교 전략을 지정
private ShippingMeta shippingMeta;
```

**`Y`/`N` ↔ `Boolean` 컨버터의 `null`↔`false`는 성질이 조금 다르다.** DB의 NULL을 `false`로 읽는 컨버터라면 스냅샷도 `false`이므로 이것만으로 dirty가 되지는 않는다. 대신 **다른 필드 하나가 dirty가 된 순간 §2-5의 전 컬럼 UPDATE가 NULL이던 컬럼에 `'N'`을 써버린다** — "아무도 안 바꿨는데 NULL이 N이 되어 있다"는 데이터 변조로 나타난다. 즉 유령 UPDATE의 **원인이 아니라 피해가 커지는 경로**다. 이 구분을 정확히 하면 좋다.

### 3-4. 시간 타입 정밀도

DB 컬럼이 초 단위(`TIMESTAMP(0)`, MySQL `DATETIME`)인데 자바 `LocalDateTime`은 나노초까지 갖는다. 확인해보면 `LocalDateTimeJavaType`은 `areEqual`을 재정의하지 않고 **`Object.equals`를 쓴다**(= 나노초까지 비교). 반면 `java.sql.Timestamp` 경로(`JdbcTimestampJavaType`)는 밀리초 + 밀리초 미만 나노 잔여값을 비교한다. 어느 쪽이든 **정밀도가 다른 값이 들어오면 다르다고 판정된다.**

```text
같은 "2026-01-02 10:00:00" 인데 판정은 "다름"

  DB 컬럼 TIMESTAMP(0) 에서 읽은 값   →  2026-01-02T10:00:00
  DTO 를 거쳐 다시 세팅된 값          →  2026-01-02T10:00:00.123456789
                                          └─ 초 미만이 살아 있다

  areEqual(스냅샷, 현재) = false  →  dirty  →  UPDATE
```

사고는 보통 "값을 새로 넣는 코드"와 결합해 일어난다.

```java
// before — DTO -> 엔티티 매핑에서 전 필드를 다시 세팅한다
@Transactional
public void sync(Long id, OrderDto dto) {
    Order order = orderRepository.findById(id).orElseThrow();
    BeanUtils.copyProperties(dto, order);   // orderedAt, createdAt 까지 전부 다시 세팅된다
}
// dto 가 JSON/외부 API 를 거쳐 나노초를 잃었거나 DB 가 초 단위로 잘라 저장했다면
// "같은 시각"인데도 값이 달라 매번 dirty → 유령 UPDATE.
```

```java
// after — 바꿔야 하는 것만, 도메인 메서드로 바꾼다
@Transactional
public void sync(Long id, OrderDto dto) {
    Order order = orderRepository.findById(id).orElseThrow();
    order.changeShippingAddress(dto.address());   // 변경 대상만 명시
}
```

구조적 예방은 **자바 타입과 DB 컬럼 정밀도를 맞추는 것**이다. 컬럼을 `TIMESTAMP(6)`로 두거나, 애플리케이션에서 저장 전 `truncatedTo(ChronoUnit.MICROS)` 같은 정규화를 일관되게 적용한다. 그리고 `BeanUtils.copyProperties` / 전 필드 매퍼를 엔티티에 쓰지 않는다 — 이것 하나가 §3-2·3-4를 동시에 막는다.

### 3-5. OSIV + setter — 추적이 가장 어려운 유형

전제 지식부터. **OSIV(Open Session In View)**는 "뷰(응답 생성)까지 영속성 컨텍스트를 열어둔다"는 뜻의 설정이다. Spring Boot는 `spring.jpa.open-in-view`가 **기본 true**다(부팅 로그에 경고가 찍힌다). 이 경우 영속성 컨텍스트가 **트랜잭션이 끝난 뒤에도 요청이 끝날 때까지 열려 있다.** 그래서 컨트롤러나 DTO 변환 코드에서 엔티티를 만지면 그 변경이 컨텍스트에 남는다.

```java
// before
@GetMapping("/orders/{id}")
public OrderResponse get(@PathVariable Long id) {
    Order order = orderService.findById(id);      // 트랜잭션은 여기서 이미 끝났다
    order.setStatusLabel(labelOf(order));         // 표시용 가공. 하지만 order 는 여전히 관리 상태
    log.info("{}", order.getItems().size());      // 지연 로딩도 여기서 조용히 돈다
    return OrderResponse.from(order);
}
// 변경은 이 시점에 UPDATE 되지 않는다. 그래서 아무도 알아채지 못한다.
// 그런데 같은 요청에서 이후 다른 @Transactional 메서드가 이 컨텍스트에 참여하면
// 그 커밋의 flush 에 이 변경이 실려 나간다 —
// 조회 컨트롤러 코드와 UPDATE 를 낸 트랜잭션이 서로 다른 곳에 있어 추적이 어렵다.
```

이 유형이 최난도인 이유가 여기 있다. **원인 코드와 증상이 서로 다른 트랜잭션에 있다.** 로그에서 UPDATE를 낸 트랜잭션을 아무리 뒤져도 그 안에는 수정 코드가 없다.

```java
// after — 세 겹으로 막는다
// ① 표시용 가공은 엔티티가 아니라 DTO 에서
@GetMapping("/orders/{id}")
public OrderResponse get(@PathVariable Long id) {
    return orderService.getResponse(id);   // 트랜잭션 안에서 DTO 로 변환해 반환
}
```

```yaml
# ② OSIV 를 끈다 — 트랜잭션 종료와 함께 컨텍스트가 닫혀 이 사고가 불가능해진다
#    (끄면 컨트롤러 지연 로딩이 LazyInitializationException 으로 드러난다 —
#     숨어 있던 문제가 표면화되는 것이므로 전환은 단계적으로)
spring.jpa.open-in-view: false
```

③ 엔티티에서 표시용 setter를 없애고 변경은 도메인 메서드로만 열어둔다.

### 3-6. `updated_at`은 원인이 아니라 결과다

운영 문의는 보통 "`updated_at`이 왜 바뀌었나"로 들어온다. 그런데 JPA Auditing(`@LastModifiedDate`)이나 `@UpdateTimestamp`는 **엔티티가 dirty로 판정돼 UPDATE가 만들어질 때 그 UPDATE에 얹혀 갱신된다.** 즉 `updated_at`이 바뀌었다는 것은 **이미 dirty였다는 증거**다.

그래서 조사 방향을 뒤집어야 한다 — "Auditing 설정이 잘못됐나"가 아니라 **"어느 필드가 dirty로 판정됐나"** 로 가야 한다. 그게 §3-7부터의 진단 3단이다.

### 3-7. 진단 1단 — 어떤 SQL이 어떤 값으로 나가는지 본다

"수정 메서드를 찾아본다"에서 끝나지 않으려면 도구가 있어야 한다. 좁혀 들어가는 순서가 있고, 첫 단계는 눈으로 보는 것이다.

```yaml
logging.level.org.hibernate.SQL: DEBUG
logging.level.org.hibernate.orm.jdbc.bind: TRACE   # Hibernate 6 기준 바인딩 파라미터 카테고리
# 실무에서는 p6spy / datasource-proxy 가 낫다 —
# 값이 채워진 완성 SQL + 실행 시간이 한 줄로 나오고, 호출 스택 필터도 붙는다
decorator.datasource.p6spy.enable-logging: true
```

여기서 얻는 것은 **어느 테이블·어느 id가 UPDATE되는지, 그리고 어떤 값으로 바뀌는지**다. 전 컬럼 UPDATE(§2-5)라서 "무엇이 바뀌었는지"는 아직 안 보인다는 한계까지 알고 있으면 좋다.

### 3-8. 진단 2단 — 몇 건인지 세고, 테스트로 못 박는다

```yaml
spring.jpa.properties.hibernate.generate_statistics: true
```

```java
// 사후 진단보다 이게 더 중요하다 — 조회 API 테스트에 회귀 방지선을 깐다
@Test
void 조회_API는_UPDATE를_만들지_않는다() {
    Statistics stats = entityManagerFactory
            .unwrap(SessionFactoryImplementor.class).getStatistics();
    stats.clear();

    orderQueryService.list(cond);

    assertThat(stats.getEntityUpdateCount()).isZero();     // 유령 UPDATE 즉시 실패
    assertThat(stats.getPrepareStatementCount()).isLessThan(5);   // N+1 도 같이 잡힌다
}
```

운영 중이라면 같은 `Statistics`를 Micrometer로 노출해 `entityUpdateCount`를 대시보드에 올린다. "조회 트래픽이 늘 때 UPDATE 카운트도 같이 오른다"가 보이면 가설이 확정된다.

### 3-9. 진단 3단 — 결정적 한 방: flush 리스너에서 스택트레이스

어느 코드가 dirty를 만들었는지 **역추적**하는 방법이다. 이걸 말하면 "실제로 추적해본 사람"의 답변이 된다. 원리는 단순하다 — Hibernate가 §1-2의 대조를 끝낸 직후에 끼어들어 **"어느 엔티티의 어느 필드가 무엇에서 무엇으로 바뀌었다고 판정됐는지"와 그 순간의 호출 스택을 함께 찍는 것**이다.

```java
// 개발/스테이징 전용. dirty 로 판정된 엔티티와 그 필드명, 그리고 호출 스택을 찍는다
public class DirtyTraceListener implements FlushEntityEventListener {

    @Override
    public void onFlushEntity(FlushEntityEvent event) {
        int[] dirty = event.getDirtyProperties();
        if (dirty == null || dirty.length == 0) return;   // 변경 없음이면 볼 것도 없다

        String[] names = event.getEntityEntry().getPersister().getPropertyNames();
        Object[] current = event.getPropertyValues();
        Object[] loaded = event.getEntityEntry().getLoadedState();   // 스냅샷

        StringBuilder sb = new StringBuilder();
        for (int i : dirty) {
            // 스냅샷 값 -> 현재 값 형태로 남겨야 "무엇이 달라 dirty 인지"가 보인다
            sb.append(names[i]).append(": ")
              .append(loaded == null ? "?" : loaded[i]).append(" -> ").append(current[i])
              .append(' ');
        }
        // 예외를 던지지 않고 스택만 얻는다 — 여기서 "누가 바꿨는가"가 드러난다
        log.warn("DIRTY {}#{} [{}]",
                event.getEntityEntry().getEntityName(),
                event.getEntityEntry().getId(), sb,
                new Throwable("dirty origin"));
    }
}
```

```java
@Component
@RequiredArgsConstructor
public class DirtyTraceRegistrar {
    private final EntityManagerFactory emf;

    @PostConstruct
    void register() {
        SessionFactoryImplementor sf = emf.unwrap(SessionFactoryImplementor.class);
        EventListenerRegistry registry =
                sf.getServiceRegistry().getService(EventListenerRegistry.class);
        // append 로 붙여야 기본 리스너가 dirty 계산을 끝낸 뒤에 실행된다
        registry.appendListeners(EventType.FLUSH_ENTITY, new DirtyTraceListener());
    }
}
```

**확인 범위 노트**: `FlushEntityEvent`가 `getDirtyProperties()`, `getPropertyValues()`, `getDatabaseSnapshot()`을 제공하는 것은 소스에서 확인했다. 다만 리스너 레지스트리를 얻는 경로(`getServiceRegistry().getService(...)` vs 세션 팩토리의 전용 접근자)와 `getLoadedState()` 같은 세부 API는 **Hibernate 버전에 따라 이름·위치가 다를 수 있으니** 프로젝트 버전에서 컴파일로 확인해야 한다. 더 간단한 대안으로 `org.hibernate.Interceptor`의 `onFlushDirty`(변경 전/후 값을 함께 받는다)를 쓰는 방법도 있다.

바이트코드 강화(bytecode enhancement)로 dirty tracking을 켠 프로젝트라면 비교 주체 자체가 달라진다는 점도 염두에 둘 것(§1-3의 세 번째 방식) — 이 경로의 세부 동작은 버전별로 다를 수 있어 별도 확인이 필요하다.

## 4. 꼬리질문 대비 포인트

### "1차 캐시가 성능 캐시가 아니라면, 같은 트랜잭션에서 같은 엔티티를 100번 조회하면 쿼리가 1번 나가는 건 성능 이득 아닌가?"

이득이긴 하지만 **부수 효과**다. 성능 장치라 부르지 못하는 이유가 셋이다. ① 범위가 트랜잭션이라 히트율을 설계 변수로 쓸 수 없다 — 캐시 설계는 "몇 %가 맞는가"를 예측할 수 있어야 하는데 트랜잭션마다 빈 상태로 시작한다. ② JPQL은 1차 캐시를 조회 경로로 쓰지 않으므로 조회 방식만 바꿔도 효과가 사라진다. ③ 애초에 같은 엔티티를 100번 조회하는 코드는 리팩터링 대상이다.

트랜잭션보다 오래 사는 캐시가 필요하면 2차 캐시나 Redis로 가야 하고, 그건 **정합성 관리 책임이 따라오는 완전히 다른 결정**이다. 1차 캐시의 값은 동일성 보장(§1-5)이라고 정리하면 된다.

### "엔티티 5만 건을 순회 수정하는 배치에서 영속성 컨텍스트는 어떻게 되나?"

정량으로 답해야 하는 질문이다. 5만 건이 컨텍스트에 쌓이면 인스턴스 5만 개에 더해 **스냅샷 배열이 5만 벌** 얹히고(§2-1), 그 상태에서 flush가 돌 때마다 5만 건 × 필드 수만큼 비교한다.

1,000건마다 `flush()`만 하고 `clear()`를 빼먹으면 관리 엔티티가 계속 누적되므로 **flush 회차마다 비교 대상이 1,000건씩 늘어난다.** 누적 비교량은 1,000 + 2,000 + ... + 50,000 = **127만 5천 건**(flush 1회 평균 25,500건)이고, 진행될수록 느려지는(관리 엔티티 수에 대해 사실상 `O(n²)`인) 곡선이 나온다. chunk마다 `clear()`까지 했다면 누적 5만 건으로 끝나므로 **25배 차이**다.

대응은 chunk마다 `flush()` + **`clear()`** 로 컨텍스트를 비우는 것이고, 단순 값 갱신이면 애초에 벌크 UPDATE나 `JdbcTemplate` 배치로 내려가는 게 맞다(단, 그러면 1차 캐시·Auditing이 우회된다 → §1-9). Spring Batch의 chunk 단위가 트랜잭션 경계와 맞물려 이 문제를 구조적으로 해결하는 도구라는 것까지 말하면 가산점 포인트다.

### "`flush()`를 직접 호출해야 하는 상황은? 남용의 위험은?"

필요한 경우는 세 가지다. ① §2-4처럼 **실행 순서를 강제**해야 할 때(DELETE를 INSERT보다 먼저), ② 생성된 키나 DB 계산값(트리거, 시퀀스)을 **트랜잭션 도중에 읽어야** 할 때, ③ 배치에서 `clear()`와 짝지어 컨텍스트 비대를 막을 때.

위험은 두 가지다. **락 보유 시간이 늘어난다** — flush로 UPDATE를 보내면 그 순간부터 커밋까지 그 행의 쓰기 락을 쥐고 있으므로, 트랜잭션 앞쪽에서 flush하고 뒤에서 외부 API를 호출하는 코드는 경합·타임아웃을 만든다(쓰기 지연의 이득 §1-7을 스스로 버리는 것).

그리고 **flush는 커밋이 아니다**(§1-1) — 롤백되면 다 사라지는데 "flush했으니 저장됐다"고 착각하는 코드가 생긴다. 결론은 "순서나 생성값이 필요할 때만 최소로, 가능하면 커밋 직전으로 미룬다"다.

### "조회 API의 유령 UPDATE를 팀 차원에서 구조적으로 막는다면 무엇을 넣겠나?" (시니어 변별 포인트)

개별 버그를 잡는 답이 아니라 **재발이 불가능한 구조**를 제시해야 한다. 우선순위 순으로 다섯 가지다.

1. **조회는 DTO 프로젝션이 기본**(§2-3) — 엔티티를 반환하지 않으면 이 사고 범주 자체가 사라진다. 가장 근본적이라 1순위다.
2. **엔티티에 public setter 금지, 컬렉션 필드는 `final`** — §3-2·3-4의 원인 두 개를 코드 구조로 봉쇄한다. `BeanUtils.copyProperties`/전 필드 매퍼를 엔티티에 쓰지 않는 규칙도 함께.
3. **`open-in-view: false`** — §3-5를 원천 차단한다. 단, 끄는 순간 숨어 있던 지연 로딩이 예외로 드러나므로 단계적 전환과 테스트가 전제다.
4. **테스트에서 `entityUpdateCount` 단정**(§3-8) — 조회 API 공통 테스트로 깔면 유령 UPDATE가 PR 단계에서 실패로 잡힌다. 사람의 주의력이 아니라 자동 장치로 막는다는 점이 핵심.
5. **`readOnly = true` 컨벤션** — 이득은 확실하지만 안전장치가 아니고 효과가 구성에 따라 흔들리므로(§2-3 확인 범위) 1~4의 보완재로 둔다.

"코드 리뷰로 본다"만 답하면 약하다. **사람이 아니라 빌드가 잡게 만드는가**가 이 질문의 채점 지점이다.

### "`@DynamicUpdate`를 전역으로 켜는 건 어떤가?" (트레이드오프 판단)

권하지 않는다. 얻는 것은 "안 바꾼 컬럼을 건드리지 않음"인데, 잃는 것은 **정적 SQL과 구문 캐시 이점**이다 — 변경 컬럼 조합마다 SQL이 달라지므로 매 flush마다 SQL을 만들고, DB 쪽 파싱 캐시 히트율도 떨어진다. 쓰기가 많은 시스템에서 이건 측정 가능한 손실이다.

그래서 판단은 **엔티티 단위**로 한다 — 컬럼이 아주 많은 테이블, LOB/긴 텍스트가 있어 전송량이 아까운 엔티티, 또는 감사 트리거가 컬럼 단위로 이력을 남겨 전 컬럼 UPDATE가 이력을 오염시키는 경우에 한정한다.

그리고 중요한 것 — `@DynamicUpdate`는 **유령 UPDATE를 없애주지 않는다.** dirty 판정 자체는 그대로라 UPDATE는 여전히 나가고, 나가는 컬럼 목록만 줄어든다. 증상을 옅게 만들어 **원인 추적을 더 어렵게 만드는 부작용**이 있다는 점까지 말하면 좋다.

### "네이티브 쿼리로 UPDATE를 쐈는데 조회 결과가 안 바뀐다면?"

§1-9의 정반대 방향이다. JPQL 벌크 연산이나 `JdbcTemplate`/native UPDATE는 **영속성 컨텍스트를 우회**하므로, 1차 캐시에 남은 인스턴스가 옛 값을 그대로 돌려준다.

더 위험한 건 그 옛 인스턴스가 dirty로 판정되면 **방금 벌크로 바꾼 값을 전 컬럼 UPDATE로 되돌려 놓는다**는 것이다. 대응은 벌크 직후 `em.clear()`(`@Modifying(clearAutomatically = true, flushAutomatically = true)`), 그리고 애초에 벌크 연산은 **엔티티를 조회하기 전에** 배치하는 설계다. Auditing과 `@Version`도 우회된다는 점을 덧붙이면 가산점 포인트다.

전체 그림(옵션 두 개의 반대 방향, `clearAutomatically`의 부작용, 증상→원인 인덱스)은 [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md)에 별도로 정리돼 있다.

---

## 한 줄 요약

영속성 컨텍스트는 네 개의 저장소다 — **1차 캐시**(`@Id`→인스턴스 맵, 성능 캐시가 아니라 동일성·정합성 장치로서 앱이 스스로 lost update를 만들지 않게 해준다), **스냅샷 저장소**(엔티티를 조회하는 순간 그 시점 필드값을 통째로 복사해 따로 보관하는 로드 시점의 사진이며, 자바에는 "이 객체가 바뀌었다"를 알려주는 장치가 없어서 대조 말고는 방법이 없기 때문에 존재한다), **쓰기 지연 SQL 저장소**(배치와 락 보유 시간 단축이 진짜 이득), 그리고 그 결과인 **동일성 보장**. 무엇이 바뀌었는지는 대조 후에만 알 수 있으므로 flush마다 `O(관리 엔티티 수 × 필드 수)` 비교가 불가피하고(JPQL 실행마다 자동 flush가 도니 횟수도 늘어난다) 메모리는 엔티티마다 스냅샷 배열 한 벌씩 늘어난다 — 그래서 조회 전용은 `readOnly`로 flush를 막거나, 더 근본적으로 **DTO 프로젝션으로 애초에 컨텍스트에 올리지 않는다**. flush는 SQL을 내보내는 것이지 확정하는 것이 아니고(확정은 커밋), 그렇게 만들어진 SQL은 코드 순서가 아니라 **INSERT → UPDATE → DELETE 고정**이며 **전 컬럼 UPDATE**가 기본이라 각각 유니크 제약 위반과 조용한 데이터 변조를 낳는다. "안 시킨 UPDATE"는 setter 전수 조사로 끝나지 않는다 — 비교 주체가 엔티티의 `equals`가 아니라 **Hibernate의 타입별 비교기**(BigDecimal은 확인 결과 `compareTo`를 쓰므로 scale 통설은 기본 매핑에서 성립하지 않는다)임을 알고, **컬렉션 재할당 / 컨버터 왕복 복사본 / 시간 정밀도 / OSIV+setter**를 순서대로 짚어야 하며, `updated_at`은 원인이 아니라 dirty였다는 결과다. 진단은 감이 아니라 3단이다 — **바인딩 SQL 로그 → Statistics `entityUpdateCount`(테스트에 단정으로 못 박기) → flush 이벤트 리스너에서 스택트레이스로 역추적.**
