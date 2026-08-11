# flush 시점과 쓰기 지연 SQL 실행 순서 — 코드 순서는 실행 순서가 아니다

> 핵심 관전 포인트: flush가 일어나는 시점은 **세 가지**다 — ① **트랜잭션 커밋 직전**(자동) ② **JPQL·Criteria·네이티브 쿼리를 실행하기 직전**(auto-flush, 아직 DB에 안 보낸 변경분 때문에 쿼리 결과가 틀리는 것을 막으려고) ③ **`em.flush()` 명시 호출**. 여기서 사람들이 놓치는 **비대칭**이 하나 있다 — **`findById`는 flush를 유발하지 않는다.** auto-flush는 "이 쿼리가 건드리는 테이블(**query space**)에 미반영 변경이 있는가"를 판정해서 결정하는데, `em.find()`는 PK 조회라 **그 판정 경로 자체를 타지 않는다. 1차 캐시에 있든 없든 마찬가지다.** 그래서 같은 트랜잭션에서 `findByName`은 flush를 부르고 `findById`는 안 부른다. 그리고 flush가 실제로 SQL을 내보낼 때, **순서는 내가 코드에 쓴 순서가 아니라 Hibernate가 `ActionQueue`에 고정해 둔 타입별 순서**다 — `orphanRemoval → INSERT → UPDATE → 컬렉션 삭제 → 컬렉션 갱신 → 컬렉션 생성 → **DELETE**`. **DELETE가 항상 맨 마지막**이고, 이유는 ① FK 제약 위반을 줄이려는 의도 ② **같은 종류의 SQL을 몰아야 JDBC 배치가 먹히기** 때문이다. 그래서 "지우고 넣기"가 실제로는 "넣고 지우기"가 되어 유니크 제약을 위반한다. 최선의 처방은 `flush()`를 끼워 넣는 것이 아니라 **애초에 DELETE+INSERT를 UPDATE로 바꾸는 것**이다. 같은 원리의 더 나쁜 얼굴이 **데드락**인데, 이건 **Hibernate가 순서를 지켜주지 않으므로 반드시 PK 정렬로 코드에 고정**해야 한다. 마지막으로 이 유형은 **배포 전에 기계로 잡을 수 있다** — **p6spy로 실제 SQL 순서 관측** + **`@DataJpaTest`의 롤백이 커밋 시점 문제를 숨기므로 `@Commit`/`TestTransaction`으로 실제 커밋** + **H2 대신 Testcontainers로 실제 DB**.

---

## 0. 질문 + 의도

**질문**: "영속성 컨텍스트의 flush는 언제 일어나나요? 쓰기 지연 SQL의 실행 순서가 코드 순서와 달라서 생기는 문제(유니크 제약, 데드락)는?"

관련 질문:
"`save(new Member("kim"))` 직후 같은 트랜잭션에서 `findByName("kim")`을 호출하면 결과 크기가 0인가 1인가?"
"그럼 같은 트랜잭션에서 `findById(1L)`은? 이때도 flush가 일어나나?"
"`email`에 유니크 제약이 있는 테이블에서 `delete(기존 행)` 후 `save(같은 email 새 행)` — 코드는 지우고 넣는데 유니크 위반이 난다. 왜인가? 어떻게 고치겠나? 그리고 이 유형은 테스트에서 잘 안 잡히고 운영에서 터지는데, 배포 전에 발견할 방법이 있나?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**flush가 커밋·JPQL 실행 직전에 일어나고 쓰기 지연 SQL이 코드 순서와 다르게 나갈 수 있음을 모르면, '코드상 삭제 후 삽입인데 유니크 제약 위반' 같은 미스터리를 못 푼다. 영속성 컨텍스트 이해가 진짜인지 검증하는 실전 문항.**" 즉 이 질문은 영속성 컨텍스트를 **개념으로 외웠는지, 아니면 SQL이 실제로 언제 어떤 순서로 나가는지까지 그림이 있는지**를 가르는 리트머스다. 채점 지점은 네 층이다. ① flush **시점을 세 개 다** 말하는가(하나만 말하면 개념만 외운 것) ② `findById`/`findByName`의 **비대칭을 설명**하는가(= auto-flush의 판정 기준을 아는가) ③ 순서가 뒤집히는 원인을 "**Hibernate가 정해둔 규칙**"으로 말하는가, 아니면 "왜인지 모르겠지만 그렇더라"에 머무는가 ④ **배포 전에 잡는 장치**를 설계할 수 있는가.

**함정 세 개**:
- **"flush는 커밋할 때 일어난다"에서 멈추는 것.** 이 답은 틀리지 않았지만, 커밋 시점만 알면 **트랜잭션 중간에 일어나는 auto-flush를 설명할 수 없고**, 그래서 "저장했는데 조회에 왜 나오지?" 또는 반대로 "왜 유니크 위반이 커밋도 안 했는데 나지?"를 못 푼다.
- **"조회하면 flush된다"로 일반화하는 것.** 조회에도 두 종류가 있고 **정반대로 동작한다**(§2). 이 비대칭을 모르면 `findById`로 후속 검증을 하는 테스트가 왜 통과하는지 설명할 수 없다.
- **`flush()`를 끼워 넣는 것을 정답이라고 믿는 것.** 동작은 한다. 그러나 그건 **증상 대응**이고, 애초에 DELETE+INSERT를 하지 않는 설계가 훨씬 낫다(§4).

---

## 1. flush란 무엇인가 — 그리고 세 개의 시점

### 1-1. 먼저 못 하나: flush는 커밋이 아니다

영속성 컨텍스트의 내부 구조(1차 캐시·스냅샷·쓰기 지연 저장소)와 flush의 정량 비용은 [영속성 컨텍스트와 변경 감지](persistence-context-dirty-checking.md)에서 다뤘다. 이 문서는 **"언제 나가는가"와 "어떤 순서로 나가는가"** 두 축에 집중한다.

flush는 **영속성 컨텍스트에 쌓인 변경분을 SQL로 만들어 DB로 보내는 행위**다. 커밋은 **DB에게 "지금까지 보낸 걸 확정하라"고 말하는 행위**다. 둘은 완전히 다르다.

```
[애플리케이션 메모리]                 [DB]
영속성 컨텍스트                       트랜잭션(아직 미확정)
  - 1차 캐시                            ↑
  - 쓰기 지연 SQL 저장소  ── flush ──→  SQL 도착 (락 잡힘, 제약 검사됨)
                                        ↑
                          ── commit ─→ 확정 (락 해제, 다른 트랜잭션에 보임)
```

비유하자면 **flush는 편지를 우체통에 넣는 것**이고 **commit은 배달을 확정하는 것**이다. 우체통에 넣는 순간(flush) 이미 **DB는 그 SQL을 실행**한다 — 그래서 **그 시점에 유니크 제약 검사도 되고, 행 잠금(락)도 걸린다.** 롤백하면 다 사라지므로 "flush했으니 저장됐다"는 착각은 위험하다.

**이 문항이 다루는 두 문제가 정확히 여기서 나온다.** 유니크 위반은 **flush 시점에 DB가 검사**하기 때문에 나고, 데드락은 **flush 시점에 락이 잡히기** 때문에 난다. 즉 "flush가 언제 일어나는가"는 학술적 질문이 아니라 **"내 트랜잭션이 언제 DB를 건드리는가"라는 운영 질문**이다.

### 1-2. 시점 ① — 트랜잭션 커밋 직전 (자동)

가장 익숙한 시점이다. `@Transactional` 메서드가 정상 종료되면 Spring이 커밋을 부르고, 커밋 직전에 Hibernate가 flush를 수행한다.

```java
@Transactional
public void changeName(Long id, String name) {
    Member m = memberRepository.findById(id).orElseThrow();
    m.setName(name);       // ← 여기서는 SQL이 나가지 않는다
}                          // ← 메서드가 끝나며 커밋 → 그 직전에 flush → 여기서 UPDATE 발생
```

**핵심은 "메서드 안에서는 SQL이 안 나갔다"는 것**이다. 그래서 디버거로 메서드 중간에 멈춰 DB를 조회해도 옛날 값이 보인다.

### 1-3. 시점 ② — JPQL·Criteria·네이티브 쿼리 실행 직전 (auto-flush)

**후보자가 유도 후 정확히 설명한 부분이라 짧게 정리한다.** JPQL 같은 쿼리는 **DB에 직접 나가서 DB의 데이터를 읽는다.** 그런데 내가 방금 저장한 데이터가 아직 메모리에만 있고 DB에는 없다면, 쿼리 결과가 **틀린다.**

```java
@Transactional
public void demo() {
    memberRepository.save(new Member("kim"));           // 메모리에만 INSERT 예약
    List<Member> found = memberRepository.findByName("kim");
    //                   ↑ JPQL → 실행 직전에 auto-flush → INSERT가 DB로 나감 → 결과 1건
}
```

**auto-flush가 없다면 결과는 0건**이 되고, "분명 방금 저장했는데 조회가 안 된다"는 버그가 된다. Hibernate가 이를 막으려고 **쿼리 실행 직전에 자동으로 flush**하는 것이다.

> 정리하면 auto-flush의 존재 이유는 **"내 트랜잭션 안에서의 읽기 일관성"** 한 가지다. 내가 방금 한 변경은 내가 조회할 때 보여야 한다(read-your-own-writes).

### 1-4. 시점 ③ — `em.flush()` 명시 호출

개발자가 직접 부른다. Spring Data JPA에서는 `repository.flush()`, `saveAndFlush()`도 같은 일을 한다.

필요한 경우는 셋이다. ① **실행 순서를 강제**해야 할 때(§4-2) ② DB가 만들어 주는 값(시퀀스/트리거/기본값)을 **트랜잭션 도중에 읽어야** 할 때 ③ 대량 처리에서 `clear()`와 짝지어 컨텍스트 비대를 막을 때.

대가도 분명하다. **flush로 UPDATE/DELETE를 보내는 순간부터 커밋까지 그 행의 쓰기 락을 쥐고 있게 된다.** 트랜잭션 앞쪽에서 flush하고 뒤에서 외부 API를 호출하는 코드는 락 보유 시간을 수백 ms 단위로 늘려 경합을 만든다. 그래서 원칙은 **"필요할 때만 최소로, 가능하면 커밋 직전으로 미룬다"**.

### 1-5. `FlushModeType.COMMIT` — ②를 끌 수는 있지만 쓰지 않는다

flush 모드는 두 가지다.

| 모드 | 동작 | 실무 |
|---|---|---|
| `AUTO` (기본) | 커밋 직전 + 쿼리 실행 직전 | 사실상 항상 이것 |
| `COMMIT` | 커밋 직전에만 | 거의 쓰지 않는다 |

`COMMIT`으로 바꾸면 auto-flush가 사라져 쿼리가 조금 줄어든다. 그러나 그 대가로 **"저장했는데 조회에 안 나온다"는 버그를 스스로 만드는 셈**이다.

```java
// before — 위험한 최적화
@Transactional
public void danger() {
    em.setFlushMode(FlushModeType.COMMIT);
    memberRepository.save(new Member("kim"));
    long n = memberRepository.countByName("kim");   // JPQL인데 flush가 안 일어난다
    if (n == 0) throw new IllegalStateException("저장 실패?");  // ← 여기서 터진다
}
```

```java
// after — 기본값(AUTO)을 그대로 둔다. 성능이 정말 문제면 flush 모드가 아니라
//         "쓰기와 읽기를 같은 트랜잭션에 섞지 않는 설계"로 푼다.
@Transactional
public void safe() {
    memberRepository.save(new Member("kim"));
    long n = memberRepository.countByName("kim");   // auto-flush → 정확히 1
}
```

**면접에서는 "끌 수 있지만 그 순간 읽기 일관성을 잃으므로 안 쓴다"까지 말하는 것이 정답**이다. 존재를 모르는 것과, 알면서 안 쓰는 것은 다르다.

---

## 2. `findById`는 왜 flush를 유발하지 않는가 — auto-flush의 판정 기준

여기가 **이 문항에서 가장 많이 틀리는 지점**이다. "1차 캐시에 있으면 안 하고, 없으면 DB에 가야 하니까 flush하겠지"라는 추론은 자연스럽지만 **틀렸다.** **1차 캐시에 있든 없든 `findById`는 flush를 유발하지 않는다.**

### 2-1. auto-flush의 판정 기준은 "query space"다

Hibernate는 JPQL을 실행하기 전에 이렇게 판정한다.

```
1. 이 쿼리가 읽을 테이블 집합을 구한다  →  이것을 query space 라고 부른다
   (예: "select m from Member m"  →  query space = { member })
2. 지금 쓰기 지연 저장소에 쌓인 작업들이 건드리는 테이블 집합을 구한다
   (예: Member INSERT 대기 중  →  { member })
3. 두 집합이 겹치는가?
     겹친다  → flush 한다 (안 하면 쿼리 결과가 틀리니까)
     안 겹친다 → flush 하지 않는다
```

`query space`는 어려운 말이 아니라 **"이 쿼리가 손대는 테이블 이름 목록"**이다. 겹칠 때만 flush하므로, `Member`를 저장해 두고 `Order`를 JPQL로 조회하면 **flush가 일어나지 않는다.**

```java
@Transactional
public void spaceDemo() {
    memberRepository.save(new Member("kim"));   // 대기 중인 작업의 테이블 = { member }

    orderRepository.findByStatus(PAID);         // query space = { orders } → 안 겹침 → flush 없음
    memberRepository.findByName("kim");         // query space = { member } → 겹침   → flush 발생
}
```

> **(가산점 포인트) 네이티브 쿼리는 이 판정을 못 한다.** SQL 문자열을 Hibernate가 파싱해 테이블을 알아내지는 않기 때문에, 네이티브 쿼리는 **"어느 테이블을 건드리는지 모른다"고 보고 보수적으로 전체를 flush**한다. 이걸 좁히려면 `NativeQuery.addSynchronizedEntityClass(...)`로 관련 엔티티를 알려줘야 한다. "네이티브 쿼리 하나 때문에 트랜잭션 중간에 예상 못 한 UPDATE 폭탄이 나갔다"는 사고의 정체가 이것이다.

### 2-2. `em.find()`는 그 판정 경로 자체를 타지 않는다

`findById`(내부적으로 `EntityManager.find()`)는 **쿼리가 아니다.** 이것은 **"PK가 이것인 엔티티 하나를 달라"는 조회(lookup)** 이고, Hibernate의 처리 경로는 이렇다.

```
findById(1L)
  → 1차 캐시에 (Member, 1) 있나?
       있다  → 그대로 반환 (SQL 없음)
       없다  → select ... from member where id = ? 를 즉시 실행해서 채운다
                ↑ 이 경로 어디에도 "query space 비교 → auto-flush" 단계가 없다
```

**왜 없어도 되는가**를 이해하면 외울 필요가 없다. auto-flush의 목적은 **"내 변경분이 빠진 결과가 나오는 것"을 막는 것**인데,

- **아직 INSERT 안 된 새 엔티티**: 어차피 영속성 컨텍스트에 있으므로 `find()`는 **1차 캐시에서 찾아 반환한다.** DB에 갈 필요가 없다.
- **수정만 하고 아직 UPDATE 안 된 엔티티**: 이것도 1차 캐시에 있고, **JPA는 "같은 트랜잭션·같은 PK면 항상 같은 인스턴스"(동일성 보장)** 를 지키므로, DB에서 옛날 값을 읽어와도 **캐시에 있는 인스턴스를 그대로 돌려준다.** 즉 **내가 바꾼 값이 그대로 보인다.**

**PK 조회는 flush 없이도 읽기 일관성이 이미 보장되므로, Hibernate가 flush할 이유가 없는 것이다.** 반면 JPQL은 조건(`where name = 'kim'`)을 **DB가** 평가하므로, 미반영 변경이 DB에 없으면 **애초에 결과 집합에서 빠져버린다** — 그래서 flush가 필수다.

### 2-3. 비대칭을 코드로 확인하기

```java
// before — 흔한 오해: "조회하면 flush된다"
@Transactional
public void misunderstanding() {
    Member m = memberRepository.findById(1L).orElseThrow();
    m.setName("changed");                 // UPDATE 예약 (아직 SQL 없음)

    memberRepository.findById(1L);        // ❌ flush 안 일어난다. SQL도 안 나간다(1차 캐시 히트)
    memberRepository.findById(999L);      // ❌ flush 안 일어난다. select 999 만 나간다
                                          //    ← "캐시에 없으면 flush하겠지"가 틀리는 지점
    // 이 시점까지 DB에는 UPDATE 가 단 한 건도 도착하지 않았다.
}
```

```java
// after — 실제로 flush를 유발하는 것은 JPQL 쪽이다
@Transactional
public void reality() {
    Member m = memberRepository.findById(1L).orElseThrow();
    m.setName("changed");                 // UPDATE 예약

    memberRepository.findByName("changed");
    // ✅ JPQL → query space {member} 겹침 → auto-flush
    //    실제 SQL 순서:  update member set ... where id=1     ← flush
    //                    select ... from member where name=?  ← 쿼리
}
```

**면접에서 이 비대칭을 한 문장으로 말한다면**: "`findById`는 쿼리가 아니라 PK 조회라 auto-flush 판정 경로를 타지 않습니다. 1차 캐시 히트 여부와 무관하고, PK 조회는 동일성 보장 덕분에 flush 없이도 내 변경분이 보이기 때문에 flush할 이유가 없습니다."

> **(가산점 포인트) 실무에서 이 비대칭이 물리는 순간**: 저장 로직 테스트에서 `saveAndAssert`를 `findById`로 검증하면, **flush가 한 번도 일어나지 않은 채로 1차 캐시에 있는 그 객체를 그대로 돌려받으므로 무조건 통과한다.** DB에 정말 들어갔는지는 전혀 검증되지 않는다. 이것이 §6-2에서 다룰 "테스트가 통과하는데 운영에서 터지는" 첫 번째 이유다.

---

## 3. 실행 순서는 코드 순서가 아니다 — `ActionQueue`의 고정 순서

### 3-1. Hibernate가 미리 정해둔 순서

flush가 일어나면 Hibernate는 쌓인 작업들을 **내가 호출한 순서가 아니라, 작업 종류별로 미리 정해진 순서**로 실행한다. 이 대기열이 `ActionQueue`이고 순서는 다음과 같이 **고정**되어 있다.

```
① 고아 객체 제거 (orphanRemoval)
② 엔티티 INSERT
③ 엔티티 UPDATE
④ 컬렉션 삭제 (collection remove)
⑤ 컬렉션 갱신 (collection update)
⑥ 컬렉션 생성 (collection recreate)
⑦ 엔티티 DELETE      ← 항상 맨 마지막
```

**중요한 것은 "DELETE가 항상 맨 마지막"이라는 사실 하나**다. 이건 설정으로 바꿀 수 있는 값이 아니라 Hibernate의 구현에 박혀 있는 규칙이다.

### 3-2. 왜 하필 DELETE가 뒤인가 — 이유 두 가지

**이유 ① FK(외래 키) 제약 위반을 줄이려는 의도.** 부모-자식 관계에서 자식이 부모를 참조할 때, 부모를 먼저 지우면 FK 위반이 난다. INSERT를 앞에 두고 DELETE를 뒤에 두면 **"필요한 행은 먼저 만들어 두고, 참조가 끊긴 행을 나중에 지우는"** 순서가 되어 일반적인 경우에 안전하다.

**이유 ② 같은 종류의 SQL을 몰아야 JDBC 배치가 먹히기 때문.** JDBC 배치는 **같은 형태의 SQL을 하나로 묶어 한 번에 보내는 최적화**다.

```
섞여 있으면 (코드 순서대로 실행한다면):
  insert / delete / insert / delete / insert  →  묶을 수 없다. 네트워크 왕복 5회

종류별로 몰아두면:
  insert · insert · insert  →  한 묶음
  delete · delete           →  한 묶음        →  네트워크 왕복 2회
```

**즉 순서 고정은 버그가 아니라 성능을 위한 의도적 설계**다. 이걸 알면 "왜 안 고쳐주냐"가 아니라 "이 규칙 위에서 어떻게 코드를 쓸 것인가"로 사고가 바뀐다.

> **(가산점 포인트) `IDENTITY` 전략에서는 INSERT가 지연되지 않는다.** PK를 DB의 auto_increment에 맡기면(`GenerationType.IDENTITY`), Hibernate는 **엔티티를 영속 상태로 만들려면 id가 필요한데 그 id를 DB만 알기 때문에** `persist()` 시점에 **INSERT를 즉시 실행**한다. 그래서 IDENTITY 환경에서는 §3-3의 문제가 **더 확실하게** 터진다 — DELETE는 flush까지 대기하는데 INSERT는 이미 나가버렸기 때문이다. 덤으로 **IDENTITY는 INSERT 배치도 사실상 불가능**하다.

### 3-3. 재현 — "지우고 넣었는데 유니크 위반"

`member` 테이블의 `email`에 유니크 제약이 있다고 하자.

```sql
create table member (
    id    bigint auto_increment primary key,
    email varchar(255) not null,
    name  varchar(255),
    constraint uk_member_email unique (email)
);
```

```java
// before — 코드는 "지우고 넣기"인데, SQL은 "넣고 나서 지우기"로 나간다
@Transactional
public void replaceMember(String email, String newName) {
    Member old = memberRepository.findByEmail(email).orElseThrow();
    memberRepository.delete(old);                       // ① DELETE 예약 (아직 SQL 없음)
    memberRepository.save(new Member(email, newName));  // ② INSERT 예약 (아직 SQL 없음)
}   // ← 커밋 직전 flush. ActionQueue 규칙에 따라 INSERT가 먼저, DELETE가 나중.
```

실제로 나가는 SQL 로그(p6spy 기준, 바인딩값 포함):

```
-- ① 커밋 직전 flush 시작
insert into member (email, name) values ('kim@example.com', 'kim2')
   ↑ 여기서 터진다:
     Duplicate entry 'kim@example.com' for key 'uk_member_email'   (MySQL)
     → org.hibernate.exception.ConstraintViolationException
     → org.springframework.dao.DataIntegrityViolationException

-- ② delete from member where id = 1     ← 여기까지 오지도 못한다
```

**"분명 지우고 넣었는데 중복 오류"의 정체가 이것**이다. 원인을 한 문장으로 말하면: **DELETE는 항상 맨 마지막에 실행되므로, DELETE로 자리를 비운 뒤 INSERT를 넣는다는 전제가 성립하지 않는다.**

> 로컬 테스트에서 통과하는 이유도 여기서 설명된다. **테스트가 롤백되면 커밋 직전 flush가 아예 실행되지 않아** 이 예외를 만날 기회 자체가 없기 때문이다(§6-2).

---

## 4. 처방 세 가지 — 좋은 순서대로

### 4-1. 최선 — 애초에 DELETE + INSERT를 하지 않는다

**§3-3의 상황은 사실 UPDATE 한 줄로 끝나는 일**이다. 이메일 주인의 이름을 바꾸는 것이라면 행을 지웠다 새로 만들 이유가 없다.

```java
// after (최선) — 지웠다 넣는 대신, 있는 행을 고친다
@Transactional
public void replaceMember(String email, String newName) {
    Member m = memberRepository.findByEmail(email).orElseThrow();
    m.changeName(newName);   // 변경 감지 → flush 시 UPDATE 한 건. 유니크 충돌 자체가 없다.
}
```

이 쪽이 나은 이유는 예외를 피하는 것 말고도 셋이다. ① **PK가 유지**되므로 이 행을 참조하는 FK·로그·외부 시스템의 참조가 깨지지 않는다 ② **UPDATE 1건**으로 끝나 DELETE+INSERT 2건보다 싸고 락 범위도 좁다 ③ `created_at` 같은 **생성 이력이 보존**된다.

**`flush()`를 끼워 넣는 것은 증상 대응이라는 점을 분명히 하자.** 순서 문제는 사라지지만 "지웠다 새로 만든다"는 잘못된 모델링은 그대로 남는다.

컬렉션 교체에서도 같은 판단이 적용된다.

```java
// before — 태그 전체 교체를 삭제+삽입으로
@Transactional
public void replaceTags(Long postId, List<String> names) {
    tagRepository.deleteByPostId(postId);
    names.forEach(n -> tagRepository.save(new Tag(postId, n)));   // (post_id, name) 유니크면 터진다
}
```

```java
// after — 차집합만 건드린다. 실제로 바뀐 것만 SQL이 나가므로 더 싸기도 하다.
@Transactional
public void replaceTags(Long postId, List<String> names) {
    Set<String> target  = new HashSet<>(names);
    List<Tag>   current = tagRepository.findByPostId(postId);

    current.stream()
           .filter(t -> !target.contains(t.getName()))
           .forEach(tagRepository::delete);              // 빠진 것만 삭제

    Set<String> exists = current.stream().map(Tag::getName).collect(toSet());
    target.stream()
          .filter(n -> !exists.contains(n))
          .forEach(n -> tagRepository.save(new Tag(postId, n)));   // 새 것만 삽입
    // 삭제 대상과 삽입 대상이 겹치지 않으므로 순서가 뒤집혀도 충돌하지 않는다
}
```

### 4-2. 차선 — 구조상 불가피하면 `em.flush()`로 경계를 명시

**"delete 후 flush를 끼운다"는 처방 자체는 맞다.** 다만 최선이 아니라 차선이라는 위치를 알고 쓰는 것이 중요하다.

```java
// after (차선) — 지우고 넣는 것이 정말 불가피할 때
@Transactional
public void replaceMember(String email, String newName) {
    memberRepository.delete(memberRepository.findByEmail(email).orElseThrow());
    memberRepository.flush();   // ← 여기서 DELETE를 먼저 내보내 자리를 비운다
    memberRepository.save(new Member(email, newName));
}
```

**언제 정말 불가피한가**: ① 행 전체를 새 스키마로 재구성해야 해서 필드 매핑이 1:1이 아닐 때 ② 상속 매핑에서 **타입이 바뀌는** 경우(엔티티 타입 자체가 달라지면 UPDATE로 표현 불가) ③ 이력 테이블처럼 **행 교체가 도메인 의미 자체**일 때.

주의점 둘. **첫째, 이 `flush()`에는 반드시 주석으로 이유를 남긴다.** 이유 없는 `flush()`는 다음 사람이 "불필요해 보이는데?" 하며 지우고, 그러면 버그가 조용히 부활한다. **둘째, flush로 DELETE를 먼저 보내면 그 행의 락을 커밋까지 쥔다.** 이 사이에 외부 API 호출 같은 긴 작업을 넣으면 안 된다.

### 4-3. soft delete 환경이면 — 유니크 제약 자체를 분리한다

물리 삭제 대신 `deleted_at` 플래그로 지우는 방식(soft delete)을 쓴다면, **"지운 행"이 테이블에 그대로 남아 있으므로 순서와 무관하게 유니크 제약이 계속 충돌**한다. 이 경우 처방은 코드가 아니라 **제약의 정의를 바꾸는 것**이다.

```sql
-- before — 한 번 쓴 이메일은 탈퇴 후에도 영원히 재사용 불가
constraint uk_member_email unique (email)

-- after (MySQL) — 삭제 시각을 제약에 포함. 살아 있는 행끼리만 유니크.
--   deleted_at 을 NOT NULL DEFAULT '9999-12-31 00:00:00' 같은 sentinel 로 두면
--   "NULL 은 유니크 검사에서 서로 다른 값으로 취급된다"는 함정도 피할 수 있다.
constraint uk_member_email unique (email, deleted_at)
```

```sql
-- after (PostgreSQL) — 부분 인덱스가 더 깔끔하다
create unique index uk_member_email_alive
    on member (email) where deleted_at is null;
```

> **(가산점 포인트) MySQL에서 `unique (email, deleted_at)`으로 두고 `deleted_at`을 NULL로 쓰면 제약이 사실상 무력화된다.** SQL 표준에서 NULL은 서로 같지 않다고 보므로, `(kim@x.com, NULL)` 행이 **여러 개 들어간다.** 그래서 sentinel 값이나 PostgreSQL 부분 인덱스를 쓴다.

---

## 5. 데드락 — 같은 원리의 더 나쁜 얼굴

### 5-1. 원리: 락을 잡는 순서가 트랜잭션마다 다르면 데드락

유니크 위반은 **예외 하나로 끝나고 원인도 로그에 찍힌다.** 데드락은 **재현이 안 되고, 부하가 높을 때만 나고, 로그에는 "Deadlock found when trying to get lock"이라는 문장만 남는다.** 같은 원리인데 훨씬 잡기 어렵다.

**flush로 UPDATE가 나가는 순간, 그 행에 쓰기 락이 걸리고 커밋까지 유지된다**(§1-1). 그래서 한 트랜잭션에서 여러 행을 UPDATE하면 **락을 여러 개 순차적으로 쥐게 된다.** 두 트랜잭션이 **서로 반대 순서로** 쥐면 교착이다.

```
시각   트랜잭션 A                        트랜잭션 B
 t1    id=1 락 획득
 t2                                      id=2 락 획득
 t3    id=2 락 요청 → B가 쥠, 대기
 t4                                      id=1 락 요청 → A가 쥠, 대기
       ────────────── 서로 영원히 기다림 = 데드락 ──────────────
       DB가 한쪽을 희생자로 골라 강제 롤백시킨다
```

### 5-2. 그 "순서"는 어디서 오는가

여기가 핵심이다. **flush 안의 UPDATE들이 어떤 순서로 나가는지는 내가 엔티티를 다룬 순서(정확히는 영속성 컨텍스트에 올라온 순서)에 좌우된다.** 그리고 그 순서는 **요청마다 얼마든지 달라진다.**

```java
// before — 요청이 준 순서를 그대로 따른다 → 트랜잭션마다 락 순서가 달라진다
@Transactional
public void addPoints(List<Long> memberIds, int amount) {
    for (Long id : memberIds) {                       // 클라이언트가 준 순서 그대로
        Member m = memberRepository.findById(id).orElseThrow();
        m.addPoint(amount);
    }
}
// 요청 A: [1, 2, 3]  → 락을 1 → 2 → 3 순으로
// 요청 B: [3, 2, 1]  → 락을 3 → 2 → 1 순으로   ← 서로 반대. 데드락 성립.
```

순서가 흔들리는 경로는 이 밖에도 많다. **`HashSet`/`HashMap` 순회 순서**(해시값에 따라 달라짐), **`ORDER BY` 없는 SELECT의 반환 순서**(DB가 보장하지 않음), **컬렉션을 `Set`으로 매핑한 연관관계**, **여러 서비스가 각자 다른 순서로 같은 테이블들을 건드리는 경우**.

### 5-3. 처방 — PK로 정렬한 뒤 처리한다

```java
// after — 항상 같은 기준(PK 오름차순)으로 정렬한 뒤 처리한다
@Transactional
public void addPoints(List<Long> memberIds, int amount) {
    List<Long> ordered = memberIds.stream().distinct().sorted().toList();
    //                                      ↑ 중복 제거    ↑ 항상 같은 순서로 고정

    for (Long id : ordered) {
        Member m = memberRepository.findById(id).orElseThrow();
        m.addPoint(amount);
    }
}
// 요청 A: [1,2,3] → 정렬 후 1,2,3
// 요청 B: [3,2,1] → 정렬 후 1,2,3   ← 두 트랜잭션의 락 획득 순서가 같아졌다.
//                                     뒤에 온 쪽은 그냥 "대기"할 뿐 교착이 없다.
```

한 번에 여러 엔티티를 조회해 처리할 때도 마찬가지다.

```java
// before — ORDER BY 가 없어 반환 순서가 보장되지 않는다
List<Member> members = memberRepository.findAllByIdIn(ids);

// after — 조회 단계에서 순서를 고정한다
List<Member> members = memberRepository.findAllByIdInOrderByIdAsc(ids);
```

비관적 락을 쓸 때도 같은 원칙이다.

```java
// after — 락을 명시적으로 잡을 때도 PK 오름차순으로
for (Long id : ids.stream().sorted().toList()) {
    accountRepository.findByIdForUpdate(id);   // @Lock(PESSIMISTIC_WRITE)
}
```

### 5-4. **이건 Hibernate가 지켜주지 않는다** — 이 문항의 핵심 대비

**flush의 타입별 순서(§3-1)는 Hibernate가 고정해 준다. 그러나 같은 타입 안에서 어떤 행을 먼저 처리할지는 기본적으로 보장하지 않는다.** 즉,

- **"DELETE가 INSERT보다 뒤"** → **Hibernate의 규칙.** 내가 바꿀 수 없고, 알고 피해야 한다.
- **"1번 행 락 → 2번 행 락"** → **내 코드의 책임.** Hibernate는 관여하지 않으니 **정렬로 직접 고정해야 한다.**

**면접에서 이 대비를 명시적으로 말하면 이해도가 확실히 드러난다.**

> **(가산점 포인트) 부분적인 도움은 있다 — `hibernate.order_updates`.** 이 옵션을 켜면 Hibernate가 flush 시점에 UPDATE들을 **엔티티 타입과 PK 기준으로 정렬**해 실행한다. 배치 효율을 위한 옵션인데 부수 효과로 데드락 확률도 낮아진다(`hibernate.order_inserts`도 INSERT에 대해 같은 일을 한다). **다만 기본값이 꺼져 있고, 한계가 분명하다** — ① **한 번의 flush 안에서만** 유효하다(중간에 flush가 여러 번 일어나면 소용없다) ② **비관적 락(`SELECT ... FOR UPDATE`)이나 벌크 JPQL처럼 Hibernate의 UPDATE 액션을 거치지 않는 락 획득 순서는 전혀 덮지 못한다.** 그래서 **"옵션은 보험이고, 정렬은 코드로 고정한다"**가 결론이다.

---

## 6. 배포 전에 잡는 방법 — 사람 눈 말고 기계로

여기가 이 문항에서 가장 중요한 대목이다. **"코드 리뷰로 잡는다"는 답은 답이 아니다.** 이 유형의 버그는 **소스 코드만 봐서는 안 보인다** — `delete()` 다음에 `save()`가 있는 것은 지극히 자연스러워 보이고, 문제는 **실행 시점에 순서가 뒤집힌다**는 데 있기 때문이다. 그래서 **실행을 관측하는 장치**가 필요하다.

### 6-1. 실제 SQL 순서를 눈으로 본다 — p6spy / datasource-proxy

**`show-sql: true`나 Hibernate 로거로는 부족하다.** 바인딩 값이 `?`로 찍혀 어떤 행이 지워지고 어떤 행이 들어갔는지 알 수 없고, 여러 스레드가 섞이면 순서도 흐려진다.

```yaml
# before — 이걸로 만족하고 있으면 순서 문제를 못 본다
spring:
  jpa:
    show-sql: true         # 바인딩값이 ? 로만 보인다
    properties:
      hibernate:
        format_sql: true
```

```gradle
// after — p6spy: 실제 실행된 SQL을 바인딩값이 채워진 완성 문장으로, 실행 순서대로 찍는다
testImplementation 'com.github.gavlyukovskiy:p6spy-spring-boot-starter:<버전>'
```

```
-- p6spy 출력 (실제 순서와 실제 값이 보인다)
1ms | insert into member (email, name) values ('kim@example.com', 'kim2')
0ms | delete from member where id=1
     ↑ 코드는 delete 가 먼저였는데 로그는 insert 가 먼저다 — 이걸 봐야 알 수 있다
```

**습관으로 만들 것**: **쓰기 로직(특히 삭제·교체·다건 수정)을 건드린 PR에서는 테스트 로그의 SQL 순서를 한 번 눈으로 확인한다.** 이것만으로도 §3-3 유형은 배포 전에 걸러진다.

한 걸음 더 가면 **순서를 테스트로 단정**할 수 있다. `datasource-proxy`는 실행된 쿼리를 프로그램으로 수집할 수 있어서 이렇게 쓴다.

```java
// after — "DELETE 가 INSERT 보다 먼저 실행되었는가"를 테스트가 기계적으로 검증한다
@Test
void delete가_insert보다_먼저_나가야_한다() {
    QueryExecutionListener listener = /* 실행 SQL을 순서대로 수집 */;

    service.replaceMember("kim@example.com", "kim2");

    List<String> sqls = listener.getExecutedSql();
    int deleteIdx = indexOfFirstStartingWith(sqls, "delete from member");
    int insertIdx = indexOfFirstStartingWith(sqls, "insert into member");
    assertThat(deleteIdx).isLessThan(insertIdx);   // 회귀하면 여기서 빨간불
}
```

이렇게 해두면 나중에 누가 `flush()`를 "불필요해 보인다"며 지웠을 때 **테스트가 막아준다.** 주석보다 강한 방어다.

### 6-2. **`@DataJpaTest`로는 못 잡는다** — 롤백이 커밋 시점 문제를 숨긴다

**이 함정 하나가 "테스트는 초록불인데 운영에서 터진다"의 절반을 설명한다.**

Spring의 테스트는 **기본적으로 각 테스트 종료 시 트랜잭션을 롤백**한다(`@DataJpaTest`, `@SpringBootTest` + `@Transactional` 모두). 그런데 §3-3의 예외는 **커밋 직전 flush에서** 난다. **롤백되면 그 flush가 아예 실행되지 않으므로 예외를 만날 기회 자체가 없다.**

```java
// before — 초록불인데 운영에서 터지는 테스트
@DataJpaTest                                  // 종료 시 자동 롤백
class MemberServiceTest {

    @Test
    void 이메일_교체() {
        service.replaceMember("kim@example.com", "kim2");
        // 테스트 메서드가 끝난다 → 커밋이 아니라 롤백
        // → 커밋 직전 flush 가 실행되지 않음 → INSERT/DELETE 가 DB에 도달조차 안 함
        // → 유니크 위반이 발생할 기회가 없다 → ✅ 통과
    }
}
```

```java
// after (1) — @Commit 으로 실제 커밋을 일으킨다
@DataJpaTest
class MemberServiceTest {

    @Test
    @Commit                                   // ← 롤백하지 않고 진짜 커밋한다
    void 이메일_교체() {
        service.replaceMember("kim@example.com", "kim2");
        // 커밋 직전 flush 발생 → insert 가 먼저 나감 → 🔴 DataIntegrityViolationException
        //   = 배포 전에 잡혔다
    }
}
```

```java
// after (2) — TestTransaction 으로 커밋 시점을 테스트 안에서 직접 만든다
@Test
void 이메일_교체() {
    service.replaceMember("kim@example.com", "kim2");

    TestTransaction.flagForCommit();
    TestTransaction.end();        // ← 여기서 실제 커밋이 일어난다. 문제가 여기서 드러난다.

    TestTransaction.start();      // 검증용으로 새 트랜잭션을 연다
    assertThat(memberRepository.findByEmail("kim@example.com"))
        .get().extracting(Member::getName).isEqualTo("kim2");
}
```

```java
// after (3) — 더 근본적인 방법: 테스트에 트랜잭션을 걸지 않는다
@SpringBootTest                               // @Transactional 을 붙이지 않는다
class MemberServiceIntegrationTest {

    @AfterEach
    void cleanUp() { memberRepository.deleteAllInBatch(); }   // 정리는 직접

    @Test
    void 이메일_교체() {
        // 서비스의 @Transactional 이 진짜로 시작되고 진짜로 커밋된다.
        // 운영과 같은 트랜잭션 경계 = 운영과 같은 flush 타이밍.
        service.replaceMember("kim@example.com", "kim2");
    }
}
```

**세 방법의 위치**: `@Commit`이 가장 손쉽고, `TestTransaction`은 "커밋 전후"를 나눠 검증하고 싶을 때 쓴다. **(3)이 가장 정확하다** — 테스트가 트랜잭션을 감싸면 서비스의 `@Transactional`이 참여(join)해버려서, **커밋 타이밍뿐 아니라 `REQUIRES_NEW`, 롤백 마킹, 지연 로딩 가능 범위까지 전부 운영과 달라지기** 때문이다. 정리 비용을 감수할 가치가 있다.

> **한 줄로 기억할 것**: **"롤백되는 테스트는 커밋 시점에 나는 문제를 구조적으로 통과시킨다."** 유니크 위반, FK 위반, 데드락, `UnexpectedRollbackException` — 이 문항이 다루는 종류의 사고는 전부 여기에 해당한다.

### 6-3. H2가 아니라 Testcontainers로 실제 DB에서 돌린다

**유니크 제약과 데드락의 동작은 DB 벤더마다 다르다.** 그래서 "H2에서 통과하고 MySQL에서 터지는" 대표 유형이 바로 이 문항이다. 구체적으로 갈리는 지점들:

- **락 획득 단위와 범위** — MySQL InnoDB는 인덱스에 락을 걸고, 유니크 인덱스 검사 과정에서 **gap 락**을 잡기도 한다. 이 때문에 "행이 겹치지 않는데도" 데드락이 나는 상황이 MySQL에만 존재한다.
- **데드락 탐지와 희생자 선택** — 누가 롤백되는지, 얼마 만에 탐지되는지가 다르다. H2는 아예 타임아웃으로 처리하기도 한다.
- **제약 위반 예외의 형태** — 에러 코드·메시지가 달라, 예외를 코드로 분기하는 로직은 H2에서만 맞을 수 있다.
- **`ON DUPLICATE KEY UPDATE`, `ON CONFLICT` 같은 upsert 문법** — 아예 없거나 다르다.

```java
// before — H2 인메모리. 빠르지만 "다른 DB"다.
@DataJpaTest                    // spring.datasource.url=jdbc:h2:mem:...
class MemberServiceTest { }
```

```java
// after — 운영과 같은 엔진을 컨테이너로 띄운다
@SpringBootTest
@Testcontainers
class MemberServiceIntegrationTest {

    @Container
    static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");
    //     ↑ 운영과 같은 메이저 버전으로 맞춘다

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", mysql::getJdbcUrl);
        r.add("spring.datasource.username", mysql::getUsername);
        r.add("spring.datasource.password", mysql::getPassword);
    }
}
```

**속도 걱정에 대한 답**: 컨테이너를 `static`으로 두면 **클래스 간 재사용**되고, Testcontainers의 **reusable 모드**를 켜면 로컬에서 컨테이너가 살아 있어 재기동 비용도 사라진다. 전략은 **"단위 테스트는 H2로 빠르게, DB 의존 동작(제약·락·네이티브 쿼리·마이그레이션)은 Testcontainers로"** 나누는 것이다.

### 6-4. 데드락은 재현 테스트로 고정한다

데드락은 "부하가 있어야 난다"고 포기하기 쉽지만, **두 스레드와 `CountDownLatch`만 있으면 결정론적으로 재현**할 수 있다.

```java
// after — 반대 순서로 갱신하면 데드락이 나는지, 정렬 후에는 안 나는지를 테스트로 고정
@Test
void 정렬하면_데드락이_나지_않는다() throws Exception {
    CountDownLatch ready = new CountDownLatch(2);
    CountDownLatch go    = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);

    Callable<Void> taskA = () -> { ready.countDown(); go.await();
                                   service.addPoints(List.of(1L, 2L), 10); return null; };
    Callable<Void> taskB = () -> { ready.countDown(); go.await();
                                   service.addPoints(List.of(2L, 1L), 10); return null; };
    //                                                 ↑ 반대 순서로 들어온 요청

    Future<Void> fa = pool.submit(taskA);
    Future<Void> fb = pool.submit(taskB);
    ready.await();
    go.countDown();               // 동시에 출발시킨다

    // addPoints 안에서 정렬하지 않으면 → 한쪽이 DeadlockLoserDataAccessException 으로 실패
    // 정렬을 넣으면 → 둘 다 성공
    assertThatCode(() -> { fa.get(); fb.get(); }).doesNotThrowAnyException();
}
```

이 테스트를 **정렬 코드를 넣기 전에 먼저 작성해 빨간불을 확인**하는 것이 중요하다. 빨간불을 못 봤다면 그 테스트는 아무것도 지키지 못한다.

### 6-5. 안전망 체크리스트

이 문항 하나만이 아니라 **"운영에서만 터지는 JPA 사고" 전반에 공통으로 적용되는 도구 상자**다.

| 잡고 싶은 것 | 장치 |
|---|---|
| SQL 실행 순서·바인딩값 | p6spy / datasource-proxy 로그, 쿼리 수집 후 순서 단정 테스트 |
| 커밋 시점에만 나는 예외 | `@Commit`, `TestTransaction`, 트랜잭션 없는 통합 테스트 |
| 벤더별 제약·락 동작 | Testcontainers(운영과 같은 엔진·메이저 버전) |
| 데드락 | 2스레드 + `CountDownLatch` 재현 테스트 |
| 예상치 못한 쿼리 증가(N+1) | `Statistics.getPrepareStatementCount()` / `SQLStatementCountValidator` 단정 |
| 위험한 구조 자체 | ArchUnit 룰(예: 서비스 계층에서 `deleteAll` 직접 호출 금지) |

**면접에서의 한 문장**: "이 유형은 소스만 봐서는 안 보이므로 **실행을 관측하는 장치**로 잡습니다. p6spy로 실제 SQL 순서를 보고, 롤백되는 테스트는 커밋 시점 문제를 숨기니 `@Commit`으로 실제 커밋을 일으키고, 제약·락 동작은 벤더마다 다르니 Testcontainers로 운영과 같은 DB에서 돌립니다."

---

## 7. 꼬리질문 대비 포인트

### "`save()` 직후 `findByName()`의 결과는 0인가 1인가? 그럼 `findById()`는?"

`findByName`은 **1**이다. JPQL이므로 실행 직전 auto-flush가 일어나 INSERT가 DB로 나가고, 그 다음 SELECT가 실행되기 때문이다.

`findById`는 **flush를 유발하지 않는다.** PK 조회는 쿼리가 아니라 lookup이라 query space 판정 경로를 타지 않는다. **1차 캐시에 있든 없든 마찬가지**다 — "캐시에 없으면 DB에 가야 하니 flush하겠지"는 자연스럽지만 틀린 추론이다. 그래도 결과는 올바른데, 새로 저장한 엔티티는 이미 1차 캐시에 있어 그대로 반환되고, 수정된 엔티티는 **동일성 보장** 덕분에 DB에서 옛 값을 읽어와도 캐시의 인스턴스를 돌려주기 때문이다. **PK 조회는 flush 없이도 읽기 일관성이 성립하므로 flush할 이유가 없다.**

### "`ActionQueue`의 순서를 바꿀 수 있나? DELETE를 먼저 보내고 싶다면?"

**타입별 순서는 바꿀 수 없다.** Hibernate 구현에 박혀 있고, 이유가 **FK 위반 회피 + JDBC 배치 효율**이라는 설계 의도이기 때문이다. 개발자가 순서에 개입할 수 있는 유일한 수단은 **`flush()`로 실행 경계를 하나 더 만드는 것**이다 — DELETE만 쌓아두고 flush하면 그 flush에는 DELETE밖에 없으므로 DELETE가 먼저 나간다.

다만 **순서를 강제하려 든다는 것 자체가 설계 신호**다. "지웠다 다시 넣는" 모델을 "고친다"로 바꿀 수 있는지를 먼저 검토하는 편이 낫다(§4-1). 참고로 **같은 타입 안의 순서**는 `hibernate.order_inserts` / `hibernate.order_updates`로 PK 정렬을 켤 수 있는데, 이건 배치 효율을 위한 옵션이고 **기본값은 꺼져 있으며 한 번의 flush 안에서만 유효**하다. **(가산점 포인트)**

### "커밋도 안 했는데 왜 유니크 제약 위반이 나나?"

**flush와 commit이 다르기 때문**이다. flush는 SQL을 DB로 보내는 것이고, DB는 **SQL을 받는 즉시 제약을 검사하고 락을 잡는다.** 커밋은 그 뒤에 "확정하라"고 말할 뿐이다. 그래서 **flush 시점에 이미 `ConstraintViolationException`이 발생**하고, Spring이 `DataIntegrityViolationException`으로 번역해 올려준다.

여기서 이어지는 실무 함정이 하나 있다([복합 유니크 제약과 동시 INSERT](unique-constraint-concurrent-insert.md)에서 더 자세히 다룬다). **이 예외를 `try/catch`로 잡아도 트랜잭션은 살아나지 않는다.** 제약 위반이 나면 Hibernate 세션이 오염 상태로 간주되고 Spring 트랜잭션에 **rollback-only 플래그**가 찍히므로, catch 후 정상 종료해도 커밋 시점에 **`UnexpectedRollbackException`**이 터지며 catch 블록 안에서 한 작업까지 함께 롤백된다. 처방은 후속 작업을 **`REQUIRES_NEW`로 분리**하거나 예외를 **트랜잭션 경계 밖에서** 잡는 것이다. **(가산점 포인트)**

### "데드락 순서를 Hibernate가 정렬해 주지 않나? 왜 코드로 고정해야 하나?" (시니어 변별 포인트)

**Hibernate가 보장하는 것과 보장하지 않는 것을 정확히 나눠야 한다.**

Hibernate가 보장하는 것은 **작업 "타입"의 순서**다 — INSERT는 항상 DELETE보다 먼저다. 이건 내가 바꿀 수 없으니 **알고 피해야 할 규칙**이다.

Hibernate가 보장하지 않는 것은 **같은 타입 안에서 어떤 행을 먼저 처리할지**다. 기본 설정에서 UPDATE들은 대체로 영속성 컨텍스트에 올라온 순서로 나가고, 그 순서는 **요청 파라미터 순서, `Set` 순회 순서, `ORDER BY` 없는 SELECT의 반환 순서**에 따라 요청마다 달라진다. 그래서 **락 획득 순서는 내 코드의 책임**이고, 처방은 **처리 대상을 항상 같은 기준(보통 PK 오름차순)으로 정렬한 뒤 순회하는 것**이다.

`hibernate.order_updates`가 부분적으로 돕지만 보험 이상은 아니다 — **기본값이 꺼져 있고, 한 번의 flush 안에서만 유효하며, `SELECT ... FOR UPDATE`나 벌크 JPQL처럼 Hibernate의 UPDATE 액션을 거치지 않는 락 획득은 전혀 덮지 못한다.** 그래서 결론은 **"옵션은 보험, 정렬은 코드로 고정"**이다.

한 걸음 더 가면 **트랜잭션 자체를 짧게 자르는 것**이 근본 처방이다. 1000건을 한 트랜잭션에서 UPDATE하면 정렬을 해도 락 보유 시간이 길어 경합이 커지므로, 배치로 쪼개거나 아예 벌크 UPDATE 한 문장으로 내리는 편이 낫다.

### "이 유형을 배포 전에 발견하는 장치를 팀에 하나만 넣는다면 무엇을 넣겠나?" (시니어 변별 포인트)

**`@DataJpaTest`의 자동 롤백을 걷어내는 것**을 고르겠다. 이유는 **비용 대비 커버 범위**다.

p6spy는 로그를 남길 뿐 **사람이 봐야** 하고, Testcontainers는 인프라 변경이 필요하다. 반면 **"쓰기 로직의 통합 테스트는 실제 커밋까지 간다"**는 규칙 하나는 `@Commit` 한 줄 또는 테스트 클래스에서 `@Transactional`을 빼는 것으로 끝나는데, 이것만으로 **유니크 위반, FK 위반, `UnexpectedRollbackException`, 커밋 시점 flush 순서 문제, 데드락**이 한꺼번에 표면으로 올라온다. **롤백되는 테스트는 커밋 시점 문제를 구조적으로 통과시킨다** — 이 한 가지 성질이 지금까지 통과해 온 초록불의 신뢰도를 통째로 깎아먹고 있기 때문이다.

그 다음 순서는 이렇게 붙이겠다. ② **p6spy를 테스트 프로파일 기본으로** 켜서 SQL 순서가 항상 로그에 남게 한다(보는 비용은 리뷰어에게 넘긴다) ③ 쓰기 핵심 경로에는 **쿼리 수·순서 단정 테스트**를 붙여 사람의 눈에서 기계로 옮긴다 ④ 제약·락에 의존하는 시나리오는 **Testcontainers**로 옮긴다.

**원칙은 하나다 — "사람이 잘 보자"는 대책이 아니다. 회귀를 막으려면 빨간불이 되는 테스트가 존재해야 한다.**

---

## 한 줄 요약

**flush는 커밋 직전·JPQL 실행 직전(auto-flush)·`em.flush()` 세 시점에 일어나고 `findById`는 PK 조회라 그 판정 경로를 타지 않으며, flush가 SQL을 내보내는 순서는 내 코드 순서가 아니라 Hibernate가 FK 안전과 JDBC 배치를 위해 고정해 둔 `ActionQueue` 순서(DELETE가 항상 마지막)다 — 그래서 "지우고 넣기"는 "넣고 지우기"가 되고, 최선의 처방은 `flush()`를 끼우는 것이 아니라 DELETE+INSERT를 UPDATE로 바꾸는 것이며, 같은 원리로 생기는 데드락은 Hibernate가 지켜주지 않으니 PK 정렬로 코드에 고정하고, 이 모든 것은 p6spy·`@Commit`·Testcontainers로 배포 전에 기계가 잡게 만든다.**
