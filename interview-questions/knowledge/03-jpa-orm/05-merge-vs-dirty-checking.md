# merge vs dirty checking — "계산해서 고치기"와 "모르니까 전부 덮기"

> 핵심 관전 포인트: 변경 감지(dirty checking)는 **무엇이 바뀌었는지 스냅샷과 비교해 계산**한다. `merge`는 **무엇이 바뀌었는지 모르니 넘어온 객체의 모든 필드를 덮어쓴다.** `merge`도 결국 변경 감지를 타지만 **덮어쓰기가 끝난 상태로** 타기 때문에, 채우지 않은 필드의 `null`까지 "변경"으로 잡혀 UPDATE에 실려 나간다. 그래서 `new Member()`에 id와 두 필드만 채워 `save()`하면 **예외 없이, 로그도 정상인 채로 나머지 컬럼이 전부 `null`이 된다.** 이 사고의 방아쇠는 Spring Data의 `save()`가 **id 유무로 `persist`와 `merge`로 갈린다**는 점이다 — id가 있으면 "중복 에러"가 아니라 조용한 UPDATE다. 처방은 하나뿐이다: **조회해서 영속 상태로 만든 뒤 필요한 필드만 바꾼다.** `merge`가 정당한 자리는 값을 덮어쓰는 것이 곧 요구사항인 **재부착(reattach)** 뿐이고, 그조차 실무에서는 거의 없다.

---

## 0. 질문 + 의도

**질문**: "`merge`와 dirty checking의 차이는?"

**출제 의도**: `merge`의 오해(detached 엔티티 전체 덮어쓰기)는 "안 바꾼 필드가 null로
덮이는" 데이터 유실 사고를 만든다. 미묘하지만 사고 유형이 명확한 지식이다.

**함정**: 이 질문은 "정답 코드를 쓰는가"를 묻지 않는다. 대부분의 개발자는 관례상
"조회해서 setter로 바꾼다"를 이미 쓰고 있다. 묻는 것은 **왜 그게 옳은지 아는가**다.
이유를 모른 채 관례를 따르는 사람은 DTO를 엔티티로 변환하는 코드를 작성하는 순간,
또는 팀에 들어온 후배의 `save()` 코드를 리뷰하는 순간에 사고를 통과시킨다.

---

## 1. 먼저 엔티티의 세 가지 상태

`merge`를 이해하려면 상태 구분이 먼저다. 용어를 풀어 쓰면 이렇다.

| 상태 | 뜻 | 특징 |
|---|---|---|
| 비영속 (transient/new) | 방금 `new`로 만들었고 영속성 컨텍스트가 모른다 | id가 없다(보통) |
| **영속 (managed)** | 영속성 컨텍스트가 추적 중이다 | **필드를 바꾸면 flush 때 UPDATE가 나간다** |
| **준영속 (detached)** | 한때 영속이었거나 id는 있지만, 지금은 추적 대상이 아니다 | **필드를 바꿔도 아무 일도 일어나지 않는다** |

- **영속성 컨텍스트**란 트랜잭션 동안 엔티티를 담아 추적하는 메모리 공간이다. 여기에
  들어 있는 동안만 "내가 이 객체를 바꾸면 DB에 반영된다"가 성립한다. 자세한 구조는
  [영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md) 문서에 있다.
- **준영속이 문제의 온상**이다. 컨트롤러에서 요청 DTO를 받아 `new Member()`로 만들고
  id를 채운 객체는 **비영속처럼 보이지만 JPA 입장에서는 "id가 있는 낯선 객체"** 다.
  이 객체를 DB에 반영하려면 어떻게든 영속 상태와 연결해야 하는데, 그 연결 작업이
  바로 `merge`다.

---

## 2. 변경 감지 — "무엇이 바뀌었는지 계산한다"

영속 상태 엔티티를 고치는 정상 경로다.

```java
@Transactional
public void changeContact(Long id, String name, String phone) {
    Member member = memberRepository.findById(id).orElseThrow();  // ① SELECT → 영속 상태
    member.setName(name);                                          // ② 필드만 변경
    member.setPhone(phone);
    // ③ save() 호출 없음 — 커밋 시점에 flush가 알아서 UPDATE를 만든다
}
```

일어나는 일:

1. `findById`가 DB에서 읽어오면서 **그 시점의 필드값 복사본(스냅샷)** 을 따로 보관한다.
2. `setName`/`setPhone`은 **엔티티 인스턴스 자체**를 바꾼다. 스냅샷은 그대로 남는다.
3. 커밋 직전 flush에서 **인스턴스와 스냅샷을 필드별로 비교**해 달라진 것을 찾아낸다.
4. 달라진 게 있으면 UPDATE를 만든다.

핵심은 3번이다. **JPA는 "무엇이 바뀌었는지"를 알고 있다** — 계산해서 알아낸다.
`name`과 `phone`만 손댔으니 나머지 8개 필드는 스냅샷과 동일하고, 따라서 "변경되지
않았다"고 판정된다.

> 참고: 기본 설정에서 UPDATE 문의 `SET` 절에는 **전 컬럼이 들어간다**(변경된 컬럼만
> 나가지 않는다). 하지만 값은 스냅샷과 같은 값이 실리므로 **결과가 바뀌지 않는다.**
> 이 구분이 뒤에서 `@DynamicUpdate` 오해를 푸는 열쇠가 된다.

---

## 3. `merge` — "무엇이 바뀌었는지 모르니 전부 덮는다"

준영속 객체를 넘겼을 때 일어나는 일이다.

### 3-1. 동작 5단계

```java
Member detached = new Member();
detached.setId(1L);
detached.setName("홍길동");
detached.setPhone("010-1111-2222");

Member managed = em.merge(detached);
```

1. **id로 1차 캐시를 찾는다.** 없으면 **DB에서 SELECT**한다. → `merge`는 항상
   조회가 선행된다는 뜻이다.
2. **DB에도 행이 없으면** 새 엔티티를 만들어 **INSERT 경로**로 간다(flush 시점에
   INSERT). 즉 `merge`는 "수정"만이 아니라 "없으면 삽입"까지 한다.
3. 찾아온 **영속 엔티티에 넘어온 객체의 모든 필드를 복사한다.** ← 여기가 전부다.
4. **그 영속 엔티티를 반환한다.** 넘긴 `detached`는 **끝까지 준영속으로 남는다.**
5. flush 시점에 변경 감지가 돌아 UPDATE를 만든다.

3단계에 주목하자. `merge`는 넘어온 객체의 어느 필드가 "사용자가 의도적으로 바꾼
값"이고 어느 필드가 "그냥 안 채운 값"인지 **구분할 수단이 없다.** 그래서 전부 덮는다.

### 3-2. 그래서 사고가 난다

회원 엔티티에 필드가 10개 있고, 수정 화면은 이름·전화번호 2개만 보낸다.

```java
// ❌ BEFORE — 조용한 데이터 유실
@Transactional
public void updateMember(MemberUpdateRequest request) {
    Member member = new Member();
    member.setId(request.getId());
    member.setName(request.getName());
    member.setPhone(request.getPhone());
    memberRepository.save(member);   // id가 있으므로 merge 호출
}
```

실행되는 SQL:

```sql
-- ① merge가 먼저 읽는다
select m.id, m.name, m.phone, m.email, m.address, m.birth_date,
       m.grade, m.point, m.created_at, m.updated_at
  from member m where m.id = 1;

-- ② 전 필드를 덮은 뒤 flush
update member
   set name       = '홍길동',
       phone      = '010-1111-2222',
       email      = null,       -- ← 유실
       address    = null,       -- ← 유실
       birth_date = null,       -- ← 유실
       grade      = null,       -- ← 유실
       point      = null,       -- ← 유실
       created_at = null,       -- ← 유실
       updated_at = null        -- ← 유실
 where id = 1;
```

**예외가 나지 않는다.** 트랜잭션은 정상 커밋되고, 응답은 200이고, 애플리케이션
로그에는 아무 이상이 없다. 등급과 포인트가 조용히 사라지고, 며칠 뒤 고객센터로
문의가 들어온다.

```java
// ✅ AFTER — 조회 후 필요한 필드만
@Transactional
public void updateMember(MemberUpdateRequest request) {
    Member member = memberRepository.findById(request.getId())
            .orElseThrow(() -> new MemberNotFoundException(request.getId()));
    member.changeContact(request.getName(), request.getPhone());  // 도메인 메서드
    // save() 호출 불필요 — 변경 감지가 처리한다
}
```

```java
// 엔티티: setter를 열지 않고 "바뀔 수 있는 것"을 메서드로 고정한다
public class Member {
    public void changeContact(String name, String phone) {
        this.name = name;
        this.phone = phone;
    }
}
```

`setName`/`setPhone`을 public setter로 열어두면 다음 사람이 또 전체를 만진다.
**변경 가능한 범위를 메서드 시그니처로 고정하는 것**이 이 사고를 구조적으로 막는
방법이다. (가산점 포인트)

### 3-3. 두 개를 나란히 놓으면

| | 변경 감지 | `merge` |
|---|---|---|
| 출발점 | **영속** 엔티티 | **준영속** 객체 |
| "무엇이 바뀌었나" | 스냅샷과 비교해 **계산** | **모른다 → 전부 덮는다** |
| 안 건드린 필드 | 스냅샷과 같으므로 값이 유지된다 | **넘어온 값(주로 `null`)으로 덮인다** |
| 선행 SELECT | 이미 조회한 상태 | **항상 발생**(1차 캐시에 없으면) |
| 반환값 | 없음 (그 객체가 곧 영속) | **새 영속 인스턴스** |

**한 문장 정리**: `merge`도 결국 변경 감지를 탄다. 다만 **덮어쓰기가 이미 끝난
상태로** 타기 때문에, 변경 감지는 `null`을 "정당한 변경"으로 인식한다. 변경 감지가
잘못된 게 아니라 **입력이 이미 오염된 것**이다.

---

## 4. 방아쇠 — `save()`는 id 유무로 갈린다

이 사고의 출발점은 `merge`를 직접 호출한 적이 없다는 점이다. `repository.save()`를
썼을 뿐이다.

```java
// Spring Data JPA — SimpleJpaRepository
@Transactional
public <S extends T> S save(S entity) {
    if (entityInformation.isNew(entity)) {
        entityManager.persist(entity);   // 신규 → INSERT
        return entity;
    } else {
        return entityManager.merge(entity);   // 신규가 아니면 → merge
    }
}
```

`save()`는 **INSERT 전용 메서드가 아니다.** "신규인가?"를 판정해 두 갈래로 나뉜다.

### 4-1. `isNew()`의 판정 규칙

기본 판정(`AbstractEntityInformation`)은 **id를 본다.**

- id 타입이 **래퍼 타입**(`Long`, `String` 등)이면 → `id == null`일 때 신규
- id 타입이 **원시 타입**(`long`, `int`)이면 → `0`일 때 신규

그런데 **`@Version` 필드가 있으면 판정 기준이 바뀐다**(`JpaMetamodelEntityInformation`).
버전 속성이 있고 그 타입이 원시 타입이 아니면, **id가 아니라 버전 필드가 `null`인지**로
신규를 판정한다. 낙관적 락을 쓰는 엔티티에서 "id를 채웠는데도 persist가 불렸다"는
현상이 여기서 나온다.

`Persistable<ID>` 인터페이스를 구현하면 `isNew()`를 직접 정의할 수 있다. UUID처럼
**애플리케이션이 id를 미리 만드는** 전략에서는 id가 항상 채워져 있으므로 기본 판정이
"신규가 아니다"로 오판해 불필요한 SELECT가 매번 나간다 — 이때 `Persistable`로 신규
판정을 직접 내리는 것이 정석이다. (가산점 포인트)

> 확인 범위: `save()`와 `isNew()`의 분기 구조는 Spring Data JPA의 공개된 구현으로
> 널리 알려진 내용이다. 다만 세부 클래스명과 판정 순서는 버전에 따라 변동이 있을 수
> 있으므로, 팀에서 쓰는 버전의 `SimpleJpaRepository`·`JpaMetamodelEntityInformation`을
> 직접 열어 확인하는 것을 권한다.

### 4-2. "id 중복 에러가 나지 않나요?"

나지 않는다. 이 오해가 위험한 이유는 **오해의 방향**이다. "에러가 날 것"이라고
믿으면 그 코드를 안전하다고 판단하게 된다. 실제로는 에러가 나지 않고 UPDATE가
성공한다. 사고는 예외가 날 때 나는 게 아니라 **조용히 성공할 때** 난다.

---

## 5. `merge`의 나머지 함정 세 가지

### 5-1. 반환값을 버리면 아무 일도 일어나지 않는다

```java
// ❌ BEFORE
Member member = new Member();
member.setId(1L);
memberRepository.save(member);
member.setName("변경");        // member는 준영속 — 이 변경은 사라진다

// ✅ AFTER
Member managed = memberRepository.save(member);   // 반환된 것이 영속 인스턴스
managed.setName("변경");                            // 이것만 반영된다
```

`merge`는 **넘긴 객체를 영속 상태로 만들지 않는다.** 새 인스턴스를 만들어 값을
복사하고 그것을 반환한다. "수정이 반영되지 않는다"는 문의의 상당수가 이것이다.

### 5-2. `@DynamicUpdate`로는 막을 수 없다

`@DynamicUpdate`는 **변경된 컬럼만 `SET` 절에 넣는** 옵션이다. 그러니 `null` 덮어쓰기를
막아줄 것처럼 보인다. 막지 못한다.

이유는 단순하다. `merge`가 `email`을 `null`로 덮은 시점에 **그 필드는 실제로 변경된
것**이다(원래 값 → `null`). 변경 감지는 이것을 정당한 변경으로 판정하고,
`@DynamicUpdate`는 "변경된 컬럼"을 넣으므로 `email = null`을 **정확히 포함시킨다.**

```sql
-- @DynamicUpdate 적용 후에도
update member set name=?, phone=?, email=null, address=null, ... where id=?
--                                 ^^^^^^^^^^ 여전히 나간다
```

`@DynamicUpdate`가 줄여주는 것은 **"안 바뀐 컬럼"** 이다. `merge` 사고에서는 안 바뀐
컬럼이 없다 — 전부 바뀌었기 때문이다. 이건 흔한 오해이므로 면접에서 반대로 짚으면
가산점이다.

### 5-3. 연관관계와 cascade가 얽히면 컬렉션이 사라질 수 있다

`merge`는 `CascadeType.MERGE`(또는 `ALL`)가 설정된 연관에만 전파된다. 문제는 그
전파가 **컬렉션까지 덮는다**는 점이다.

```java
// ❌ 위험한 조합
@OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
private List<OrderItem> items = new ArrayList<>();
```

요청 DTO로부터 `new Order()`를 만들면 `items`는 **빈 `ArrayList`** 다. 이 객체를
`merge`하면 관리 중인 컬렉션이 빈 컬렉션으로 덮이고, `orphanRemoval = true`가
"컬렉션에서 빠진 자식은 삭제"를 수행한다. → **주문 항목 전체 DELETE.**

정상 경로(조회 후 필요한 것만 수정)를 쓰면 이 문제가 애초에 생기지 않는다. `merge`를
피하는 근거가 하나 더 늘어나는 셈이다.

> 확인 범위: cascade·orphanRemoval과 `merge`의 상호작용은 매핑 설정과 컬렉션의
> 초기화 상태(빈 컬렉션인지 미초기화 프록시인지)에 따라 결과가 갈린다. 위 시나리오는
> "DTO에서 새로 만든 엔티티의 컬렉션은 빈 `ArrayList`"인 경우를 전제한 것이다. 실제
> 프로젝트에서는 반드시 쿼리 로그로 DELETE가 나가는지 직접 확인할 것.

---

## 6. `merge`가 정당한 자리는 어디인가

거의 없다. 정확히는 **"넘어온 값으로 전부 덮는 것이 곧 요구사항인 경우"** 뿐이다.

- **재부착(reattach)**: 세션이나 캐시에 통째로 보관했던 엔티티, 또는 원격 호출로
  전체 상태를 받아온 엔티티를 다시 영속 상태로 붙일 때. 이때는 "받은 것이 전체"라는
  전제가 실제로 참이다.
- 그 외에는 조회 후 변경 감지가 맞다.

### "값을 전부 바꿔야 할 때는 merge가 맞지 않나?"

그조차 안전하지 않다. 이유는 `merge`가 **두 가지 `null`을 구분할 수 없다**는 데 있다.

| 클라이언트의 의도 | 요청에 담긴 값 |
|---|---|
| "이 필드는 안 건드릴게" | 필드가 아예 없거나 `null` |
| "이 필드를 비워줘" | `null` |

`merge`에게는 둘 다 똑같은 `null`이다. 즉 **`merge`로는 PATCH 시맨틱을 구현할 수
없다.** 부분 수정 API를 만들 때 이 구분이 곧 요구사항이 되고, 그래서 실무에서는
DTO로 받아 "온 것만 적용"하는 코드를 직접 쓴다.

```java
// PATCH — "온 것만 적용"을 명시적으로
@Transactional
public void patchMember(Long id, MemberPatchRequest request) {
    Member member = memberRepository.findById(id).orElseThrow();
    if (request.getName() != null)  member.changeName(request.getName());
    if (request.getPhone() != null) member.changePhone(request.getPhone());
    // "비워달라"를 표현해야 하면 Optional<T> 또는 JsonNullable 같은 3-상태 타입을 쓴다
}
```

### 부수 비용

`merge`는 **항상 SELECT가 선행된다**(1차 캐시에 없으면). 건별 수정이 많은 배치에서는
조회 쿼리가 그대로 배로 붙는다. 변경 감지 경로는 어차피 조회를 하고 그 객체를 쓰므로
추가 조회가 없다.

---

## 7. 꼬리질문 대비 포인트

### "`save()`를 호출하지 않았는데 UPDATE가 나갔습니다. 왜죠?"

영속 상태 엔티티의 필드를 바꿨기 때문이다. 영속성 컨텍스트가 스냅샷과 비교해 변경을
찾아내고 flush 시점에 UPDATE를 만든다. `save()`는 **비영속 객체를 영속화하거나
준영속 객체를 병합할 때** 필요한 것이고, 이미 영속 상태인 엔티티에는 불필요하다.
반대로 조회 전용 트랜잭션에서 의도치 않은 UPDATE가 나가는 문제는
[영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md)의 진단 절차를 쓴다.

### "그럼 `save()`는 언제 호출해야 하나요?"

**신규 저장**(비영속 → 영속)에만 필요하다. 수정 로직에서 `save()`를 부르는 코드는
대개 두 가지 중 하나다 — ① 습관적으로 붙였고 실제로는 아무 효과가 없다(이미 영속
상태라 `merge`가 같은 인스턴스를 반환) ② 준영속 객체를 넘기고 있어서 위험하다.
후자를 걸러내는 리뷰 포인트: **`save()`의 인자가 `new`로 만든 객체인가, 조회해온
객체인가.**

### "`merge` 대신 `find` + setter를 쓰면 SELECT가 한 번 더 나가서 손해 아닌가요?"

아니다. `merge`도 내부에서 SELECT를 한다. 쿼리 수는 같고, `find` + setter 쪽이
**의도가 코드에 드러난다**는 이점이 있다. 오히려 `merge`가 불리한 경우가 있다 —
`getReferenceById`로 프록시만 얻어 필드 하나만 바꾸는 최적화가 가능한데, `merge`는
그 선택지를 없앤다.

### "엔티티에 setter를 열지 말라는 말은 자주 듣는데, 이 사고와 무슨 관계인가요?" (시니어 변별 포인트)

관계가 직접적이다. 이 사고의 본질은 **"바뀌어도 되는 필드"와 "바뀌면 안 되는 필드"가
코드에 표현되어 있지 않다**는 것이다. setter가 전부 열려 있으면 `merge`가 전부 덮는
것을 문법적으로 막을 수 없고, 리뷰에서 사람이 눈으로 찾아야 한다.
`member.changeContact(name, phone)` 같은 도메인 메서드만 열어두면 "연락처 변경"이라는
연산의 범위가 타입으로 고정되고, 그 밖의 필드를 건드리는 코드는 **컴파일되지 않는다.**
사고 예방을 사람의 주의력에서 타입 시스템으로 옮기는 것 — 이게 "setter를 닫아라"의
실제 값이다.

### "그럼 `merge`는 왜 JPA 명세에 있는 건가요?" (시니어 변별 포인트)

`merge`는 **분리된 계층 사이에서 엔티티가 오갔던 시대의 도구**다. 원격 호출로 엔티티를
직렬화해 보내고 받아서 다시 붙이는(detach → 전송 → reattach) 구조에서는 "받은 것이
전체 상태"라는 전제가 실제로 참이었고, 그때 `merge`는 정확히 필요한 연산이었다.
지금은 계층 간에 DTO를 주고받고 엔티티는 트랜잭션 안에 머무르는 구조가 표준이 되어
그 전제가 깨졌다. 즉 `merge`는 잘못된 API가 아니라 **전제가 달라진 API**다. 이렇게
답하면 "왜 쓰지 말라는지"를 원리로 이해하고 있음을 보일 수 있다.

---

## 한 줄 요약

변경 감지는 **무엇이 바뀌었는지 계산해서 그것만 고치고**, `merge`는 **무엇이 바뀌었는지
모르니 전부 덮는다** — 그래서 `new` 엔티티에 id만 채워 `save()`하면 예외 없이 나머지
컬럼이 `null`이 되고, 처방은 언제나 "조회해서 영속 상태로 만든 뒤 필요한 필드만
바꾸기"다.
