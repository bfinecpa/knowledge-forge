# CascadeType.REMOVE와 orphanRemoval — 삭제의 방아쇠가 몇 개인가

> 핵심 관전 포인트: 둘 다 "부모를 지우면 자식도 지운다"를 해주지만 **방아쇠(트리거)의 개수가 다르다.** **`CascadeType.REMOVE`의 방아쇠는 하나** — **부모에 `remove()`가 호출될 때**뿐이다. **`orphanRemoval = true`는 방아쇠가 둘** — 부모 삭제에 더해 **"부모와의 연결이 끊긴 순간"** 에도 자식을 지운다. 즉 `post.getAttachments().remove(a)` **한 줄이 곧 `delete from attachment where id = ?`** 가 된다. **컬렉션에서 빼는 행위가 삭제 명령이 되는 것**이 결정적 차이다. 사고는 이 비대칭에서 나온다 — ① **`orphanRemoval`** 은 "목록을 갈아끼우려던" 코드(`clear()` + `addAll()`, 컬렉션 필드 재할당)가 **전건 DELETE**가 된다. 기본⭐ Q2에서 다룬 **"안 시킨 UPDATE"의 삭제판**이고, UPDATE와 달리 **되돌릴 수 없다.** ② **`CascadeType.REMOVE`** 는 자식이 **다른 엔티티와 공유되는 참조**일 때 부모 삭제가 공유 자원을 지운다. 그리고 이게 대부분 **`CascadeType.ALL`에 REMOVE가 들어 있어서 의도치 않게 켜진다.** 공통 비용은 **자식 수만큼 DELETE 문이 만들어진다**는 것이고(100건이면 DELETE 100번), 벌크 DELETE로 내려가면 **영속성 컨텍스트 불일치**(중급 Q4)가 따라온다. 판단 기준은 하나다 — **자식이 부모 없이는 존재 의미가 없는 종속 관계(Aggregate 안쪽)일 때만 켠다.** 공유되거나 독립 조회되는 엔티티에는 켜지 않고, **`CascadeType.ALL`을 습관적으로 쓰지 않는다.** 마지막으로, 이 유형은 **안전망으로 원천 차단할 수 있다** — 컬렉션을 `unmodifiableList`로만 노출하고 `addAttachment`/`removeAttachment`만 열면 `clear()`도 재할당도 애초에 불가능해진다.

---

## 0. 질문 + 의도

**질문**: "`Post` 1:N `Attachment`에서 `cascade = CascadeType.REMOVE`와 `orphanRemoval = true`의 차이는? 각각의 사고 위험은?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**편의 설정 하나가 '부모를 지웠더니 공유되던 자식까지 사라지는' 연쇄 삭제 사고를 만든다. 파급 범위를 모르는 편의 기능은 쓰지 않는 신중함을 본다.**"

즉 이 문항이 재는 것은 애노테이션 두 개의 뜻이 아니다. **"동작을 자동화하는 옵션을 켤 때, 그 자동화가 어디까지 번지는지를 확인하고 켜는 사람인가"** 를 본다. `cascade`와 `orphanRemoval`은 **켜기는 한 단어인데 파급은 데이터 유실**인 전형적인 비대칭 옵션이라, 신중함을 재기에 딱 맞는 소재다. 채점 지점은 네 층이다.

1. **차이를 트리거로 말하는가** — "orphanRemoval이 더 강력하다" 같은 형용사가 아니라, **"REMOVE는 부모 삭제 하나, orphanRemoval은 거기에 연결 해제까지"** 라는 **방아쇠의 개수**로 말하는가.
2. **사고 시나리오를 구체적인 코드 한 줄로 댈 수 있는가** — `attachments.clear()`, `this.attachments = newList`.
3. **`CascadeType.ALL`에 REMOVE가 포함된다**는 것을 아는가. 실무 사고의 대부분은 REMOVE를 명시적으로 켠 사람이 아니라 **ALL을 관성으로 쓴 사람**에게서 난다.
4. **켜는 기준을 말할 수 있는가** — "종속 관계일 때만"이라는 Aggregate 경계 감각.

**함정 세 개**:
- **"둘 다 자식을 지웁니다"에서 멈추는 것.** 맞는 말이지만 **언제** 지우는지가 이 질문의 전부다. 차이를 못 대면 옵션을 켜본 적은 있어도 그 결과를 관찰한 적은 없는 것으로 들린다.
- **"orphanRemoval이 더 안전하다/위험하다"로 단정하는 것.** 안전·위험은 **자식이 어떤 성격인지**에 달렸고, 옵션 자체의 속성이 아니다. 종속 자식에게는 `orphanRemoval`이 정답이고, 공유 자식에게는 둘 다 오답이다.
- **DB의 `ON DELETE CASCADE`와 같은 것이라고 말하는 것.** 이름은 닮았지만 **동작 주체가 다르다**(§7). 이 둘을 구분 못 하면 "JPA를 껐다 켰다 하는 삭제"의 부작용을 설명할 수 없다.

---

## 1. cascade란 무엇인가 — "영속성 전이"를 말 그대로 풀면

이 절은 개념 자체를 처음부터 쌓는다. `cascade`를 한 번도 안 켜봤어도 §3부터 읽을 수 있게 만드는 것이 목적이다.

### 1-1. cascade가 없을 때의 코드

`Post`(게시글)와 `Attachment`(첨부파일)를 준비한다.

```java
@Entity
public class Post {
    @Id @GeneratedValue
    private Long id;
    private String title;

    @OneToMany(mappedBy = "post")           // cascade 없음, orphanRemoval 없음
    private List<Attachment> attachments = new ArrayList<>();
}

@Entity
public class Attachment {
    @Id @GeneratedValue
    private Long id;
    private String fileName;

    @ManyToOne(fetch = FetchType.LAZY)      // 연관관계의 주인 (FK를 가진 쪽)
    @JoinColumn(name = "post_id")
    private Post post;
}
```

이 상태에서 게시글과 첨부파일을 함께 저장하려면 이렇게 써야 한다.

```java
// ❌ BEFORE — 자식마다 리포지토리를 직접 호출한다
@Transactional
public void write(String title, List<String> fileNames) {
    Post post = new Post(title);
    postRepository.save(post);                       // ① 부모 저장

    for (String name : fileNames) {
        Attachment a = new Attachment(name, post);
        attachmentRepository.save(a);                // ② 자식마다 저장
    }
}
```

부모만 `save()`하고 자식을 빠뜨리면 첨부파일은 **아무 예외 없이 그냥 저장되지 않는다.** 영속성 컨텍스트는 `save()`(정확히는 `persist()`)를 호출한 엔티티만 관리 대상으로 삼기 때문이다. 자식이 늘어날수록 이 "리포지토리를 하나씩 부르는 코드"가 서비스 계층에 쌓인다.

### 1-2. cascade = "부모에 한 작업을 자식에게도 전파한다"

**cascade(영속성 전이)** 는 이 반복을 없애는 장치다. **부모 엔티티에 수행한 영속성 작업을, 연관된 자식 엔티티에도 자동으로 전파**한다.

```java
@OneToMany(mappedBy = "post", cascade = CascadeType.PERSIST)
private List<Attachment> attachments = new ArrayList<>();
```

```java
// ✅ AFTER — 부모만 저장하면 컬렉션에 담긴 자식이 함께 저장된다
@Transactional
public void write(String title, List<String> fileNames) {
    Post post = new Post(title);
    for (String name : fileNames) {
        post.addAttachment(new Attachment(name));    // 컬렉션에 담기만 한다
    }
    postRepository.save(post);                       // 자식까지 INSERT
}
```

여기서 **"전파"의 의미를 정확히 잡아야 한다.** cascade는 SQL을 만들어내는 기능이 아니라, **`EntityManager`의 메서드 호출을 자식에게 대신 호출해주는 기능**이다. `persist(post)`를 부르면 JPA가 `post.attachments`를 순회하며 각 자식에 대해 `persist(child)`를 호출해준다 — 그뿐이다. 사람이 손으로 부르던 걸 대신 불러주는, **호출의 자동화**다.

이 정의를 잡아두면 다음 두 가지가 자연히 따라온다.

- **cascade는 애플리케이션(JPA) 레벨의 기능이다.** DB는 이런 설정이 있는지도 모른다. JPA를 거치지 않는 경로(네이티브 쿼리, 벌크 연산, DBA가 콘솔에서 친 SQL)에는 전혀 적용되지 않는다.
- **cascade가 동작하려면 자식이 메모리에 올라와 있어야 한다.** 부모의 컬렉션이 지연 로딩 상태면, JPA는 전파하기 위해 **먼저 자식을 SELECT로 다 읽는다.** §6의 성능 문제가 여기서 출발한다.

### 1-3. CascadeType 여섯 가지 — 각각 무엇을 전파하는가

| 값 | 전파하는 작업 | 언제 일어나나 |
|---|---|---|
| `PERSIST` | 저장(`persist`) | 부모를 새로 저장할 때 자식도 INSERT |
| `MERGE` | 병합(`merge`) | 준영속 부모를 다시 붙일 때 자식도 함께 |
| `REMOVE` | 삭제(`remove`) | **부모를 삭제할 때 자식도 DELETE** |
| `REFRESH` | 새로고침(`refresh`) | 부모를 DB에서 다시 읽을 때 자식도 |
| `DETACH` | 분리(`detach`) | 부모를 영속성 컨텍스트에서 뗄 때 자식도 |
| `ALL` | **위 다섯 개 전부** | — |

여기서 이 문서 전체의 출발점이 되는 사실 하나.

> **`CascadeType.ALL`에는 `REMOVE`가 포함되어 있다.**

실무 사고의 대부분은 REMOVE를 의식적으로 켠 사람에게서 나지 않는다. **"저장할 때 편하니까"** 하는 이유로 `cascade = CascadeType.ALL`을 쓴 사람에게서 난다. 저장 편의를 원해서 켠 옵션에 **삭제 전파가 딸려 들어온 것**이고, 그 사실은 코드 어디에도 안 적혀 있다. 몇 달 뒤 누군가 `postRepository.delete(post)`를 호출하는 순간에야 드러난다.

```java
// ⚠️ 이 한 줄에 "부모를 지우면 자식도 지운다"가 들어 있다
@OneToMany(mappedBy = "post", cascade = CascadeType.ALL)
private List<Attachment> attachments = new ArrayList<>();

// 저장 편의만 원했다면 이렇게 써야 한다
@OneToMany(mappedBy = "post", cascade = {CascadeType.PERSIST, CascadeType.MERGE})
private List<Attachment> attachments = new ArrayList<>();
```

> 면접에서 이 한 문장을 먼저 꺼내면 좋다: "**`CascadeType.ALL`은 편의가 아니라 다섯 개 옵션을 한꺼번에 켜는 선언이고, 그중 하나가 삭제 전파입니다.** 그래서 저는 필요한 타입만 골라서 켭니다."

### 1-4. cascade는 연관관계의 주인과 무관하다

헷갈리기 쉬운 지점 하나. `mappedBy`가 붙은 쪽은 **FK 관리에 대해서만** 읽기 전용이다. `cascade`와 `orphanRemoval`은 **FK 관리가 아니라 생명주기 전파**라서, `mappedBy` 쪽(`Post.attachments`)에 붙이는 것이 정상이고 정상적으로 동작한다. "읽기 전용인데 왜 삭제가 되지?"라는 의문이 생긴다면, **두 개념이 다른 축**임을 다시 확인하면 된다. ([연관관계의 주인과 mappedBy](06-association-owner-and-mappedby.md))

---

## 2. orphanRemoval — "고아"의 정의부터

### 2-1. 고아(orphan)란 무엇인가

**부모가 더 이상 자신을 참조하지 않게 된 자식 엔티티**를 고아라고 부른다. 여기서 "참조하지 않는다"의 판정 기준이 결정적이다.

> **부모의 컬렉션에서 빠졌는가.**

DB의 FK 값이 아니다. `post_id` 컬럼에 값이 남아 있어도, **메모리상의 `post.attachments` 리스트에서 그 자식이 빠지면 고아**로 판정된다. `orphanRemoval = true`는 **"고아가 된 자식은 DELETE하라"** 는 선언이다.

```java
@OneToMany(mappedBy = "post", orphanRemoval = true)
private List<Attachment> attachments = new ArrayList<>();
```

```java
@Transactional
public void deleteAttachment(Long postId, Long attachmentId) {
    Post post = postRepository.findById(postId).orElseThrow();
    Attachment target = post.getAttachments().stream()
            .filter(a -> a.getId().equals(attachmentId))
            .findFirst().orElseThrow();

    post.getAttachments().remove(target);   // ← 이 한 줄이 DELETE다
}
```

```sql
-- 커밋 시점에 나가는 SQL
delete from attachment where id = 42;
```

`attachmentRepository.delete(...)`를 부른 적이 없다. **컬렉션에서 원소를 뺀 것이 삭제 명령이 되었다.** 이것이 `orphanRemoval`의 전부이자, 사고의 원천이다.

### 2-2. 핵심 차이 — 방아쇠의 개수

| | `CascadeType.REMOVE` | `orphanRemoval = true` |
|---|---|---|
| 부모에 `remove()` 호출 | 자식 DELETE | 자식 DELETE |
| 컬렉션에서 자식 제거 | **아무 일도 안 일어남** | **자식 DELETE** |
| 개념 | 부모의 삭제 **작업을 전파** | 자식의 **생명주기를 부모가 소유** |

한 문장으로 말하면 이렇다.

> **`CascadeType.REMOVE`의 방아쇠는 "부모의 `remove()`" 하나뿐이고, `orphanRemoval`은 거기에 "부모와의 연결 해제"가 하나 더 붙는다.**

그리고 이 차이는 **의미의 차이**로 이어진다. `CascadeType.REMOVE`는 "부모를 지울 때 딸린 것도 같이 치워줘"라는 **작업 편의**다. `orphanRemoval`은 "이 자식은 부모의 소유물이라, 부모의 목록에서 빠지는 순간 존재할 이유가 없다"는 **도메인 선언**이다. 후자가 더 강한 주장이고, 그래서 더 위험하다.

### 2-3. 둘의 포함 관계 — `orphanRemoval`만 켜도 부모 삭제가 전파된다

자주 나오는 꼬리질문이다. **`orphanRemoval = true`는 부모가 삭제될 때의 자식 삭제도 포함한다.** 부모가 사라지면 그 자식들은 전원 고아가 되는 셈이니, 개념적으로도 자연스럽다.

즉 다음 두 설정은 **삭제 동작에 관해서는** 사실상 같다.

```java
@OneToMany(mappedBy = "post", cascade = CascadeType.REMOVE, orphanRemoval = true)  // REMOVE는 잉여
@OneToMany(mappedBy = "post", orphanRemoval = true)                                // 이걸로 충분
```

그럼에도 실무에서 `cascade = CascadeType.ALL, orphanRemoval = true`를 함께 쓰는 이유는 **`ALL` 안의 PERSIST/MERGE가 필요해서**다. REMOVE 때문이 아니다. 이 구분을 말할 수 있으면 관성으로 붙인 것이 아님이 드러난다.

---

## 3. 다섯 가지 시나리오 — 실제로 나가는 SQL

`Post` 1개에 `Attachment` 3건(id 41, 42, 43)이 달려 있다고 하자. 설정과 동작을 바꿔가며 무엇이 나가는지 본다.

| # | 설정 | 코드 | 나가는 SQL | 결과 |
|---|---|---|---|---|
| ① | 없음 | `postRepository.delete(post)` | `delete from post where id=1` | **FK 제약 위반 → 예외** |
| ② | `cascade=REMOVE` | `postRepository.delete(post)` | 자식 SELECT → `delete attachment` ×3 → `delete post` | 정상 삭제 |
| ③ | `orphanRemoval=true` | `postRepository.delete(post)` | ②와 동일 | 정상 삭제 |
| ④ | `orphanRemoval=true` | `post.getAttachments().remove(a42)` | `delete from attachment where id=42` | 자식 1건 삭제 |
| ⑤ | `cascade=REMOVE`만 | `post.getAttachments().remove(a42)` | **없음** | **아무 일도 안 일어남** |

각 줄을 코드와 함께 확인한다.

### ① 설정 없음 + 부모 삭제 → FK 제약 위반

```java
@Transactional
public void deletePost(Long postId) {
    Post post = postRepository.findById(postId).orElseThrow();
    postRepository.delete(post);
}
```

```sql
delete from post where id = 1;
-- ERROR: Cannot delete or update a parent row:
--        a foreign key constraint fails (`attachment`, CONSTRAINT `fk_attachment_post` ...)
```

자식 행 3건이 `post_id = 1`을 붙들고 있으므로 DB가 부모 삭제를 거부한다. **이 예외는 좋은 예외다.** 데이터를 지키려고 DB가 막아준 것이고, "자식을 어떻게 처리할지 정하지 않았다"는 사실을 배포 전에 알려준다. 이 지점에서 개발자가 고르는 선택지가 세 가지고, 이후 절이 그 셋을 다룬다.

- 자식을 먼저 지운다(수동 또는 벌크)
- `cascade`/`orphanRemoval`로 JPA에 맡긴다
- DB FK에 `ON DELETE CASCADE`를 건다

### ② `CascadeType.REMOVE` + 부모 삭제

```java
@OneToMany(mappedBy = "post", cascade = CascadeType.REMOVE)
private List<Attachment> attachments = new ArrayList<>();
```

```sql
-- ⓐ 전파하려면 자식이 메모리에 있어야 하므로 먼저 읽는다
select a.id, a.file_name, a.post_id from attachment a where a.post_id = 1;

-- ⓑ 자식마다 DELETE (3건이면 3문장, 100건이면 100문장)
delete from attachment where id = 41;
delete from attachment where id = 42;
delete from attachment where id = 43;

-- ⓒ 마지막에 부모
delete from post where id = 1;
```

**주목할 두 가지.** ⓐ 컬렉션을 LAZY로 뒀어도 삭제를 위해 결국 SELECT가 나간다. ⓑ **DELETE는 한 문장으로 묶이지 않는다.** `delete from attachment where post_id = 1` 같은 문장은 나가지 않는다. JPA의 삭제 단위는 언제나 **엔티티 1건**이기 때문이다.

### ③ `orphanRemoval = true` + 부모 삭제

②와 동일한 SQL이 나간다. §2-3에서 본 대로 `orphanRemoval`이 부모 삭제 전파를 포함하기 때문이다.

### ④ `orphanRemoval = true` + 컬렉션에서 자식 하나 제거

```java
post.getAttachments().remove(a42);
```

```sql
delete from attachment where id = 42;
```

**부모는 그대로 살아 있고 자식 1건만 지워진다.** 이 동작이 `orphanRemoval` 고유의 것이며, ②·③과 갈리는 유일한 지점이다.

여기에 [flush 시점과 SQL 실행 순서](15-flush-timing-and-sql-ordering.md)에서 다룬 사실이 하나 붙는다. Hibernate의 `ActionQueue`에서 **고아 제거(orphan removal)는 실행 순서상 맨 앞**이다(`orphanRemoval → INSERT → UPDATE → 컬렉션 3종 → DELETE`). 그래서 같은 트랜잭션에서 "첨부 A를 빼고 같은 파일명으로 A'를 새로 넣는" 코드는, 일반 엔티티 DELETE와 달리 **삭제가 먼저 나가서** 유니크 제약을 안 건드린다. `orphanRemoval`이 순서 면에서는 오히려 유리한, 흔치 않은 케이스다. (가산점 포인트)

### ⑤ `CascadeType.REMOVE`만 켠 상태 + 컬렉션에서 제거 — 조용한 방치

여기가 이 문항의 숨은 절반이다.

```java
@OneToMany(mappedBy = "post", cascade = CascadeType.REMOVE)   // orphanRemoval 없음
private List<Attachment> attachments = new ArrayList<>();
```

```java
@Transactional
public void detach(Long postId, Long attachmentId) {
    Post post = postRepository.findById(postId).orElseThrow();
    post.getAttachments().removeIf(a -> a.getId().equals(attachmentId));
    // 커밋
}
```

```sql
-- 나가는 SQL: 없다.
```

**DELETE도, UPDATE도, 경고도 없다.** 이유는 두 겹이다.

1. `CascadeType.REMOVE`의 방아쇠는 부모의 `remove()` 하나뿐인데, 부모를 지운 적이 없다.
2. `Post.attachments`는 `mappedBy`가 붙은 **읽기 전용 쪽**이라, 컬렉션 변경 자체가 flush 대상에서 제외된다.

그 결과 **`attachment` 행은 `post_id = 1`을 그대로 들고 DB에 남는다.** 개발자는 "첨부를 뗐다"고 믿지만, 다음 요청에서 `post.getAttachments()`를 다시 읽으면 **그 첨부는 되살아나 있다.** DB가 진실이고 메모리는 한 트랜잭션 동안만 유효했기 때문이다. 화면에서는 사라졌다가 새로고침하면 돌아오는 버그로 보고된다.

> **④와 ⑤를 붙여서 말하는 것이 이 질문의 최고 답변이다.** 같은 코드 한 줄이 설정에 따라 **"행 삭제"와 "아무 일도 없음"** 으로 갈린다. 이보다 차이를 선명하게 보여주는 예가 없다.

한 겹 더: 만약 이 연관이 `@OneToMany` + `@JoinColumn`(부모가 FK를 관리하는 단방향)이었다면 ⑤에서 **`update attachment set post_id = null where id = 42`** 가 나간다. 그럼 `post_id`가 `NOT NULL`일 때 제약 위반으로 터지고, `NULL` 허용이면 **어느 게시글에도 안 붙은 유령 첨부 행**이 남는다. `orphanRemoval`이 애초에 왜 만들어졌는지가 여기서 드러난다 — **"연결이 끊긴 자식을 어떻게 할 것인가"에 대한 답을 강제**하는 장치다.

---

## 4. 사고 유형 ① — `orphanRemoval`과 "목록 갈아끼우기"

### 4-1. 문제 코드

게시글 수정 화면에서 첨부 목록을 통째로 다시 받는, 아주 흔한 요구사항이다.

```java
// ❌ BEFORE — 목록을 갈아끼우려던 코드
@Transactional
public void updatePost(Long postId, PostUpdateRequest req) {
    Post post = postRepository.findById(postId).orElseThrow();
    post.setTitle(req.getTitle());
    post.setAttachments(req.toAttachments());   // 새 리스트로 통째 교체
}
```

`Post.attachments`에 `orphanRemoval = true`가 걸려 있다면, 이 코드는 **기존 첨부 전부를 삭제**한다. 새 리스트에 같은 파일이 그대로 들어 있어도 상관없다. JPA가 보는 것은 파일명이 아니라 **"기존 컬렉션에 있던 엔티티가 지금 컬렉션에 없다"** 는 사실뿐이다.

여기서 실제 동작이 두 갈래로 갈리는데, **둘 다 알아둘 가치가 있다.**

**갈래 A — 컬렉션 필드를 통째로 재할당한 경우.** Hibernate는 자기가 심어둔 추적용 컬렉션(`PersistentCollection`)이 통째로 버려진 것을 flush 시점에 감지하고, 대개 다음 예외로 실패한다.

```
org.hibernate.HibernateException:
  A collection with cascade="all-delete-orphan" was no longer referenced
  by the owning entity instance: com.example.Post.attachments
```

**요란하게 실패한다는 점에서는 차라리 낫다.** 다만 이 예외 메시지가 무엇을 말하는지 모르면 원인을 못 찾고, 결국 사람들은 검색해서 나온 처방을 그대로 붙인다 — 그게 갈래 B다.

**갈래 B — `clear()` 후 `addAll()`.** 예외는 사라진다. 그리고 **진짜 사고가 여기서 난다.**

```java
// ❌ 예외는 없어졌지만 더 위험해졌다
post.getAttachments().clear();
post.getAttachments().addAll(req.toAttachments());
```

```sql
-- 기존 3건 전부 삭제
delete from attachment where id = 41;
delete from attachment where id = 42;
delete from attachment where id = 43;
-- 새로 3건 삽입 (id가 바뀐다)
insert into attachment (file_name, post_id) values ('a.png', 1);
insert into attachment (file_name, post_id) values ('b.png', 1);
insert into attachment (file_name, post_id) values ('c.png', 1);
```

**제목만 바꾸려던 요청이 첨부 3건을 지우고 다시 만들었다.** 겉보기 결과가 같아 보여서 더 나쁘다. 실제로 깨지는 것은 이런 것들이다.

- **자식의 id가 전부 바뀐다.** 그 id를 참조하던 다른 테이블(다운로드 이력, 댓글의 인용, 외부 시스템이 저장해둔 URL)이 전부 끊긴다.
- **감사 이력이 오염된다.** JPA Auditing의 `createdAt`이 오늘로 리셋되어 "1년 전 올린 파일"이 "방금 올린 파일"이 된다.
- **파일 실체가 남는다.** 스토리지에 있는 실제 파일을 지우는 후처리가 `attachmentService.delete()`에 붙어 있었다면, JPA가 직접 지운 이 경로에서는 **그 코드가 아예 실행되지 않는다.** DB 행만 사라지고 스토리지에는 참조 없는 파일이 계속 쌓인다.
- **되돌릴 수 없다.** 기본⭐ Q2의 "안 시킨 UPDATE"는 값이 바뀐 것이라 재계산으로 복구할 여지가 있다. **DELETE는 백업 말고는 복구 수단이 없다.**

### 4-2. 처방 — 차이만 반영한다

```java
// ✅ AFTER — 없어진 것만 지우고 새로 생긴 것만 넣는다
public void syncAttachments(List<String> fileNames) {
    // 목록에서 빠진 것만 제거 → 그 자식만 DELETE
    this.attachments.removeIf(a -> !fileNames.contains(a.getFileName()));

    // 새로 들어온 것만 추가 → 그 자식만 INSERT
    Set<String> existing = this.attachments.stream()
            .map(Attachment::getFileName)
            .collect(Collectors.toSet());
    fileNames.stream()
            .filter(name -> !existing.contains(name))
            .forEach(name -> addAttachment(new Attachment(name)));
}
```

핵심은 **"교체"를 "차이 반영"으로 바꾸는 것**이다. `orphanRemoval`이 켜진 컬렉션에서 `clear()`와 재할당은 **금지어**라고 팀 규칙으로 정해도 좋다. §9에서 이 규칙을 코드로 강제하는 방법을 다룬다.

### 4-3. 또 하나의 함정 — 자식을 다른 부모로 옮길 때

```java
// ❌ 첨부를 다른 게시글로 옮기려던 코드
oldPost.getAttachments().remove(attachment);   // ← 이 순간 고아로 확정
newPost.getAttachments().add(attachment);
attachment.setPost(newPost);
```

`orphanRemoval`은 **"컬렉션에서 빠졌다"만 보고 판단**한다. 같은 트랜잭션 안에서 다른 부모에 다시 붙였는지는 고려하지 않는다. 그래서 이 코드는 **이동이 아니라 삭제**가 된다(또는 삭제 후 재삽입으로 id가 바뀐다).

이건 버그라기보다 **`orphanRemoval`의 의미가 그렇다는 신호**다. "이 자식은 이 부모의 것"이라고 선언해놓고 다른 부모에게 넘기는 것은 모순이다. **자식이 부모 사이를 이동해야 하는 도메인이라면 `orphanRemoval`을 켜면 안 된다.** 이 판단을 면접에서 말할 수 있으면 옵션을 외운 게 아니라 의미를 이해한 것으로 들린다.

---

## 5. 사고 유형 ② — `CascadeType.REMOVE`와 공유되는 자식

### 5-1. 문제 코드

첨부파일을 게시글마다 복사하지 않고, **같은 파일을 여러 게시글이 공유**하도록 설계했다고 하자. 실무에서는 이미지 저장소, 태그, 코드 테이블, 첨부 원본 등에서 흔하다.

```java
@Entity
public class Post {
    @ManyToMany(cascade = CascadeType.ALL)    // ⚠️ ALL에 REMOVE가 들어 있다
    @JoinTable(name = "post_attachment")
    private List<Attachment> attachments = new ArrayList<>();
}
```

```java
@Transactional
public void deletePost(Long postId) {
    postRepository.delete(postRepository.findById(postId).orElseThrow());
}
```

```sql
delete from post_attachment where post_id = 1;
delete from attachment where id = 41;   -- ← 다른 게시글 5개가 참조 중인 파일
delete from attachment where id = 42;
delete from post where id = 1;
```

**게시글 하나를 지웠더니, 다른 게시글에 붙어 있던 첨부가 사라졌다.** 다른 게시글은 아무도 건드리지 않았는데 첨부가 없어진다. 그리고 다른 게시글이 그 첨부를 FK로 붙들고 있다면 이번엔 **FK 제약 위반으로 게시글 삭제 자체가 실패**한다 — 데이터가 안 지워지는 것이 오히려 다행인 경우다.

### 5-2. 왜 이런 설정이 코드에 들어오나

REMOVE를 의식적으로 켠 사람은 거의 없다. 실제 경로는 대개 이렇다.

1. 저장할 때 자식마다 `save()` 부르는 게 번거로워서 `cascade`를 검색한다.
2. 예제 대부분이 `cascade = CascadeType.ALL`이다. 그대로 복사한다.
3. 저장은 잘 된다. **삭제는 몇 달 동안 아무도 호출하지 않는다.**
4. 어느 날 관리자 화면에 "게시글 삭제" 기능이 붙는다.
5. 운영에서 데이터가 사라진다.

**옵션을 켠 시점과 사고가 난 시점이 몇 달 떨어져 있다는 것**이 이 유형의 가장 나쁜 성질이다. 코드 리뷰에서 `CascadeType.ALL` 한 단어를 그냥 넘기면, 몇 달 뒤에 다른 사람이 대가를 치른다.

### 5-3. 처방

```java
// ✅ 필요한 전파만 명시한다
@ManyToMany(cascade = {CascadeType.PERSIST, CascadeType.MERGE})
private List<Attachment> attachments = new ArrayList<>();
```

그리고 더 상위의 처방: **공유되는 자식에는 `@ManyToMany` 대신 중간 엔티티**(`PostAttachment`)를 두고, cascade는 **게시글 → 중간 엔티티**에만 건다. 게시글을 지우면 연결만 끊기고 첨부 원본은 남는다. 소유 관계와 참조 관계가 코드에 분리되어 드러나는 구성이다.

```java
@Entity
public class Post {
    @OneToMany(mappedBy = "post", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<PostAttachment> links = new ArrayList<>();   // 연결만 소유
}

@Entity
public class PostAttachment {
    @ManyToOne(fetch = FetchType.LAZY) private Post post;
    @ManyToOne(fetch = FetchType.LAZY) private Attachment attachment;  // cascade 없음
}
```

> **판단 규칙 한 줄**: `cascade`가 향하는 방향은 **소유**여야 한다. 공유되는 것을 향하면 안 된다.

---

## 6. 공통 위험 — 자식 수만큼 DELETE가 나간다

### 6-1. 삭제 단위는 언제나 엔티티 1건

§3-②에서 본 대로, 자식이 100건이면 **DELETE 문 100개**가 만들어진다. `hibernate.jdbc.batch_size`를 설정하면 JDBC 배치로 묶여 **네트워크 왕복은 줄지만**, 만들어지는 문장 수 자체는 줄지 않는다. 자식이 수만 건이면 트랜잭션이 길어지고, 그 사이 락이 잡혀 있으며, 커밋 전에 전부 메모리에 로딩되어 있어야 한다.

게다가 **자식의 자식이 있으면 재귀적으로 반복된다.** `Post → Attachment → AttachmentThumbnail`에 모두 cascade가 걸려 있으면, 게시글 하나 삭제가 SELECT 3단계 + DELETE 수백 건이 된다. 삭제 버튼 하나가 타임아웃 나는 시나리오가 여기다.

### 6-2. 벌크 DELETE로 내려가면 — 영속성 컨텍스트 불일치

```java
// 자식 삭제를 한 문장으로
@Modifying
@Query("delete from Attachment a where a.post.id = :postId")
int deleteByPostId(@Param("postId") Long postId);
```

```sql
delete from attachment where post_id = 1;   -- 한 문장
```

성능은 해결됐지만 **대가가 따라온다.** 벌크 연산은 영속성 컨텍스트를 **우회해서** DB로 바로 나간다. 그래서 이미 1차 캐시에 올라와 있던 `Attachment` 엔티티들은 **DB에서는 지워졌는데 메모리에는 그대로 남는다.**

```java
@Transactional
public void deletePost(Long postId) {
    Post post = postRepository.findById(postId).orElseThrow();
    post.getAttachments().size();              // ① 자식 3건이 1차 캐시에 올라옴

    attachmentRepository.deleteByPostId(postId);   // ② DB에서는 사라짐

    post.getAttachments().size();              // ③ 여전히 3 — 1차 캐시가 답한다
    postRepository.delete(post);               // ④ 캐시에 남은 자식에 대해 또 DELETE 시도
}
```

이 불일치의 메커니즘과 `clearAutomatically`·`flushAutomatically`의 방향, 그리고 "**진짜 처방은 벌크 연산을 트랜잭션 끝이나 별도 트랜잭션으로 미는 것**"이라는 결론은 [벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md)에 정리되어 있다. 여기서 붙잡을 연결은 하나다.

> **cascade의 성능 문제를 벌크로 풀면, 벌크의 정합성 문제가 따라온다.** 둘은 세트로 온다.

### 6-3. DB에 맡기는 선택지 — `ON DELETE CASCADE`

세 번째 길은 애초에 JPA를 안 거치는 것이다. FK 제약 자체에 삭제 규칙을 심는다.

```sql
alter table attachment
  add constraint fk_attachment_post foreign key (post_id) references post(id)
  on delete cascade;
```

Hibernate에서는 매핑에 다음을 붙여 이 DDL을 생성하게 할 수 있다.

```java
@OneToMany(mappedBy = "post")
@OnDelete(action = OnDeleteAction.CASCADE)     // org.hibernate.annotations
private List<Attachment> attachments = new ArrayList<>();
```

**얻는 것**: `delete from post where id = 1` 한 문장으로 끝난다. 자식을 SELECT할 필요도, DELETE를 100개 만들 필요도 없다. 대량 삭제에서는 압도적으로 빠르다.

**포기하는 것** — 이쪽이 더 중요하다.

- **JPA가 모르는 삭제가 된다.** 1차 캐시에는 자식 엔티티가 그대로 남아, 같은 트랜잭션에서 조회하면 사라진 행이 조회된다(§6-2와 같은 문제).
- **JPA Auditing·엔티티 리스너가 전부 건너뛰어진다.** `@PreRemove`, soft delete를 위한 `@SQLDelete`, 이력 테이블 적재가 **조용히 안 돈다.** 감사 요구가 있는 데이터라면 이게 곧 컴플라이언스 구멍이다.
- **애플리케이션 코드를 읽어도 삭제 파급이 안 보인다.** 파급이 DDL에 있어서, 코드 리뷰로는 절대 발견되지 않는다.
- **후처리가 안 돈다.** 스토리지의 실제 파일 삭제, 캐시 무효화, 이벤트 발행 — DB가 지운 행에 대해서는 아무것도 실행되지 않는다.

> 확인 범위: `@OnDelete`를 붙였을 때 Hibernate가 자식 개별 DELETE를 생략하는지, 그리고 그 생략 조건은 매핑 형태(단방향/양방향, 조인 컬럼/조인 테이블)와 버전에 따라 다를 수 있다. **실제 프로젝트에서는 반드시 SQL 로그로 확인**하고 넘어가는 것을 권한다.

### 6-4. 세 갈래 정리

| 방식 | 나가는 SQL | 리스너·후처리 | 정합성 | 적합한 규모 |
|---|---|---|---|---|
| cascade / orphanRemoval | SELECT + 자식 수만큼 DELETE | 정상 동작 | 안전 | 자식 수십 건까지 |
| 벌크 DELETE (`@Modifying`) | 한 문장 | 동작 안 함 | 1차 캐시 불일치 관리 필요 | 수백~수만 건 |
| DB `ON DELETE CASCADE` | 부모 한 문장 | 동작 안 함 | 코드에 파급이 안 보임 | 대량, 또는 성능이 최우선 |

**"작은 Aggregate는 JPA에 맡기고, 대량 삭제는 벌크로 내리되 그때는 정합성을 손으로 챙긴다"** 가 실무의 기본형이다.

---

## 7. cascade와 DB의 `ON DELETE CASCADE`는 다르다

이름이 닮아서 같은 것으로 착각하기 쉬운데, **동작 주체와 적용 범위가 다르다.**

| | JPA `CascadeType.REMOVE` | DB `ON DELETE CASCADE` |
|---|---|---|
| 누가 지우나 | 애플리케이션(Hibernate) | DB 엔진 |
| 적용 범위 | JPA를 통한 삭제만 | **모든 삭제**(콘솔 SQL, 배치, 다른 애플리케이션) |
| 리스너·Auditing | 동작함 | 동작 안 함 |
| SQL 개수 | 자식 수만큼 | 부모 1건 |
| 어디에 적혀 있나 | 엔티티 코드 | DDL(스키마) |

**둘을 동시에 켜는 것도 가능하다.** 그러면 JPA가 자식 DELETE를 다 만들어 보내고, DB의 규칙은 지울 게 없어서 그냥 놀게 된다 — 느리지만 틀리지는 않는다. 다만 **"코드를 봐도, DDL을 봐도 어느 쪽이 실제로 지우는지 모르는 상태"** 가 되므로, 하나로 정하고 팀에 명시하는 편이 낫다.

---

## 8. 판단 기준 — 언제 켜고, 무엇을 얻고, 무엇을 포기하나

### 8-1. 켜는 기준: 부모 없이 존재 의미가 없는가

한 문장으로 자를 수 있다.

> **자식이 부모 없이는 존재 의미가 없는 종속 관계일 때만 켠다.**

이는 DDD의 **Aggregate 경계**와 같은 판단이다. Aggregate 루트(부모)가 자식의 생명주기를 소유하고, 자식은 루트를 통해서만 접근한다.

**켜도 되는 예**
- `Order` → `OrderItem` — 주문 항목은 주문 없이 존재할 이유가 없다.
- `Post` → `Attachment` — 게시글 전용 첨부라면(다른 글이 공유하지 않는다면) 종속이다.
- `Survey` → `Question` → `Choice` — 설문 밖의 선택지는 무의미하다.

**켜면 안 되는 예**
- `Team` → `Member` — 팀을 없앤다고 사람을 지우지 않는다.
- `Post` → `Category`, `Tag` — 공유되고 독립적으로 관리된다.
- `Order` → `Product` — 상품은 주문보다 오래 산다.
- **자식이 독립적으로 조회·수정되는 화면이 있는 경우** — 자체 리포지토리와 API가 있다는 것은 독립 생명주기를 갖는다는 증거다.

빠른 자가진단 세 가지.

1. **"자식만 따로 조회하는 API가 있나?"** — 있다면 종속이 아니다.
2. **"자식을 다른 부모에게 옮기는 요구가 생길 수 있나?"** — 있다면 `orphanRemoval`은 금물이다(§4-3).
3. **"자식을 참조하는 제3의 엔티티가 있나?"** — 있다면 공유 자원이다.

### 8-2. 켰을 때 얻는 것

- **도메인이 자식의 생명주기를 소유한다.** 서비스 계층에서 `attachmentRepository`를 직접 다룰 일이 없어지고, 자식 조작이 부모의 도메인 메서드 안으로 모인다. 저장 로직이 흩어지지 않는다.
- **Aggregate 경계가 코드로 드러난다.** `cascade = ALL, orphanRemoval = true`는 문서로 적을 필요 없는 "이 자식은 이 부모의 것" 선언이다. 매핑을 보면 경계가 보인다.
- **부모만 저장·삭제하면 되므로 서비스 코드가 짧아진다.** 자식 저장을 빠뜨려서 데이터가 반만 들어가는 실수가 구조적으로 사라진다.

### 8-3. 켜서 포기하는 것

- **삭제 파급이 코드에 안 보인다.** `postRepository.delete(post)` 한 줄만 봐서는 몇 개 테이블이 영향받는지 알 수 없다. 매핑까지 열어봐야 한다.
- **성능을 포기한다.** SELECT + 자식 수만큼 DELETE(§6-1).
- **실수 한 줄의 대가가 데이터 유실이다.** `clear()` 하나, 재할당 하나. UPDATE 사고와 달리 **복구 수단이 백업뿐**이다.
- **코드 리뷰의 난이도가 올라간다.** 컬렉션을 만지는 모든 코드가 잠재적 DELETE라서, 리뷰어가 매핑을 기억하고 있어야 한다.

> **면접용 한 호흡 서술**: "`orphanRemoval`을 켜면 **자식의 생명주기를 도메인이 소유하게 되어** 서비스에서 자식 리포지토리를 다룰 일이 없어지고 Aggregate 경계가 코드에 드러납니다. 대신 **삭제 파급이 호출부에서 안 보이고, 자식 수만큼 DELETE가 나가며, 컬렉션을 잘못 만진 한 줄이 곧 데이터 유실**이 됩니다. 그 대가를 감당할 수 있는 경우는 **자식이 부모 없이 존재 의미가 없을 때뿐**이라, 저는 종속 관계에만 켜고 컬렉션은 캡슐화해서 잘못 만질 수 없게 막습니다."

---

## 9. 안전망 — 잘못 쓸 수 없게 코드로 막는다

"조심하자"는 처방은 사람이 바뀌면 사라진다. `orphanRemoval`이 걸린 컬렉션은 **애초에 위험한 조작이 불가능하도록** 만들 수 있다.

### 9-1. 컬렉션을 밖으로 내보내지 않는다

```java
// ❌ BEFORE — 컬렉션 원본이 밖으로 나간다
public class Post {
    @OneToMany(mappedBy = "post", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<Attachment> attachments = new ArrayList<>();

    public List<Attachment> getAttachments() { return attachments; }   // 위험
    public void setAttachments(List<Attachment> a) { this.attachments = a; }  // 더 위험
}
```

이 클래스는 **호출자 누구나 `post.getAttachments().clear()`를 칠 수 있다.** setter는 §4-1의 재할당 예외로 가는 문이다.

```java
// ✅ AFTER — 읽기는 읽기 전용 뷰로, 쓰기는 의도가 드러나는 메서드로만
public class Post {
    @OneToMany(mappedBy = "post", cascade = CascadeType.ALL, orphanRemoval = true)
    private final List<Attachment> attachments = new ArrayList<>();   // final: 재할당 원천 차단

    public List<Attachment> getAttachments() {
        return Collections.unmodifiableList(attachments);   // clear()/add() 호출 시 예외
    }

    public void addAttachment(Attachment a) {
        attachments.add(a);
        a.setPost(this);          // 연관관계 편의 메서드 (양쪽 일관성)
    }

    public void removeAttachment(Attachment a) {
        attachments.remove(a);    // 이 메서드를 통해야만 DELETE가 일어난다
        a.setPost(null);
    }
}
```

효과는 세 가지다.

- `clear()`·`removeIf()`·`addAll()`이 **컴파일은 되지만 런타임에 `UnsupportedOperationException`** 으로 즉시 막힌다. 조용한 데이터 유실이 **시끄러운 실패**로 바뀐다.
- 필드를 `final`로 두면 **재할당이 컴파일 단계에서 불가능**해진다. §4-1의 갈래 A 예외를 만날 일 자체가 없다.
- **DELETE가 일어나는 진입점이 `removeAttachment` 하나로 좁혀진다.** 리뷰에서 이 메서드 호출부만 보면 되고, 파일 실체 삭제 같은 후처리도 여기 한 곳에 붙일 수 있다.

> 이 후보자의 횡단 약점("문제를 만나면 잘 푸는데, 오기 전에 잡는 장치를 만드는 습관은 없다")에 정확히 대응하는 항목이다. **"조심한다"가 아니라 "못 하게 만든다"** 로 답을 바꾸는 것이 이 절의 목적이다.

### 9-2. 삭제 쿼리 수를 테스트로 단정한다

"제목만 바꿨는데 DELETE가 3번 나갔다"는 사실은 **테스트에서 쿼리 수를 세면** 바로 잡힌다.

```java
@Test
void 제목만_수정하면_DELETE는_한_건도_나가지_않는다() {
    SQLStatementCountValidator.reset();

    postService.updateTitle(postId, "새 제목");
    em.flush();

    SQLStatementCountValidator.assertDeleteCount(0);   // 회귀를 여기서 고정
    SQLStatementCountValidator.assertInsertCount(0);
}

@Test
void 첨부_한_건_제거는_DELETE_한_건이다() {
    SQLStatementCountValidator.reset();

    postService.removeAttachment(postId, attachmentId);
    em.flush();

    SQLStatementCountValidator.assertDeleteCount(1);
}
```

Hibernate `Statistics`의 `getEntityDeleteCount()`로도 같은 단정을 만들 수 있다. 핵심은 **"몇 건이 지워지는가"를 숫자로 못 박아두는 것**이다. 나중에 누가 `orphanRemoval`을 켜거나 컬렉션 조작을 바꾸면 이 테스트가 먼저 깨진다.

주의: `@DataJpaTest`는 기본적으로 테스트 후 롤백하므로 **커밋 시점에만 드러나는 문제를 숨긴다.** `em.flush()`를 명시하거나 `@Commit`/`TestTransaction`으로 실제 커밋을 일으켜야 한다.

### 9-3. `CascadeType.ALL`을 구조 룰로 막는다

관성으로 붙는 `ALL`은 리뷰로 막기 어렵다. ArchUnit으로 규칙을 코드에 박아둔다.

```java
@Test
void OneToMany에_CascadeType_ALL을_쓰지_않는다() {
    ArchRule rule = fields()
        .that().areAnnotatedWith(OneToMany.class)
        .should(new ArchCondition<JavaField>("CascadeType.ALL을 쓰지 않는다") {
            @Override
            public void check(JavaField field, ConditionEvents events) {
                OneToMany a = field.reflect().getAnnotation(OneToMany.class);
                if (Arrays.asList(a.cascade()).contains(CascadeType.ALL)) {
                    events.add(SimpleConditionEvent.violated(field,
                        field.getFullName() + " : CascadeType.ALL은 REMOVE를 포함합니다. "
                        + "필요한 타입만 명시하세요 (PERSIST/MERGE). "
                        + "삭제 전파가 의도라면 orphanRemoval=true를 명시하고 리뷰를 받으세요."));
                }
            }
        });

    rule.check(new ClassFileImporter().importPackages("com.example.domain"));
}
```

- **"금지"가 아니라 "명시 강제"** 라는 점이 중요하다. 삭제 전파가 진짜로 필요하면 `orphanRemoval = true`를 손으로 적게 만든다. **적는 순간 그것은 결정이 되고, 리뷰 대상이 된다.**
- 같은 방식으로 `@OneToMany`에 setter가 있는지, 컬렉션 필드가 `final`인지도 룰로 만들 수 있다.

### 9-4. 실제 SQL을 눈으로 본다

`p6spy`나 `datasource-proxy`로 **바인딩 값까지 찍힌 실제 SQL**을 개발 환경에서 상시 노출한다. "제목만 바꿨는데 로그에 `delete from attachment`가 세 줄 찍히는" 장면을 한 번 보면, 그 다음부터는 매핑을 열어보게 된다. **관측이 습관을 만든다.**

### 9-5. soft delete와의 상호작용

삭제를 물리 삭제가 아니라 `deleted_at` 컬럼으로 다루는 경우, cascade와의 조합에 함정이 있다.

```java
@Entity
@SQLDelete(sql = "update attachment set deleted_at = now() where id = ?")
@Where(clause = "deleted_at is null")
public class Attachment { ... }
```

- **JPA를 거치는 삭제**(cascade, orphanRemoval)는 `@SQLDelete`를 타므로 **DELETE가 UPDATE로 치환**된다. 여기까지는 의도대로다.
- **DB `ON DELETE CASCADE`나 벌크 DELETE는 `@SQLDelete`를 우회한다.** 같은 도메인 안에서 **어떤 경로로 지웠느냐에 따라 물리 삭제와 논리 삭제가 섞인다.** 데이터가 조용히 두 종류가 되는, 발견하기 매우 어려운 상태다.
- 그리고 soft delete는 **유니크 제약을 계속 점유**한다. "지운 파일과 같은 이름으로 다시 못 올린다" 같은 증상이 여기서 나온다(별도 문항 주제).

> **결론: soft delete를 도입한 도메인에서는 삭제 경로를 하나로 통일한다.** JPA로 지우기로 했으면 `ON DELETE CASCADE`를 걸지 않고, 벌크 삭제를 쓰기로 했으면 그 쿼리도 `deleted_at`을 갱신하도록 손으로 맞춰야 한다. (가산점 포인트)

---

## 10. 꼬리질문 대비 포인트

### "`cascade = CascadeType.ALL`을 그냥 쓰면 안 되나요? 편한데요."

`ALL`은 편의 옵션이 아니라 **다섯 개 전파를 한꺼번에 켜는 선언**이고, 그중 `REMOVE`는 데이터를 지운다. 저장 편의가 목적이었다면 `{PERSIST, MERGE}`만 켜면 된다. 실무 사고의 대부분이 **"저장이 편하려고 켰는데 삭제까지 딸려온" 경로**로 발생하고, 켠 시점과 사고 시점이 몇 달 떨어져 있어서 원인 추적도 어렵다. 그래서 저는 필요한 타입만 명시하고, `@OneToMany`에 `ALL`이 붙는 것을 ArchUnit 룰로 막습니다.

### "`orphanRemoval = true`를 켜면 `CascadeType.REMOVE`는 따로 안 써도 되나요?"

네. **`orphanRemoval`은 부모 삭제 시의 자식 삭제도 포함**합니다 — 부모가 사라지면 자식은 전부 고아가 되니 개념적으로도 자연스럽습니다. 그래서 `cascade = REMOVE, orphanRemoval = true`에서 `REMOVE`는 잉여입니다. 실무에서 `cascade = ALL, orphanRemoval = true`를 함께 쓰는 이유는 **`ALL` 안의 `PERSIST`/`MERGE`가 필요해서**지 `REMOVE` 때문이 아닙니다.

### "첨부를 다른 게시글로 옮기려고 컬렉션에서 뺐는데 삭제됐습니다. 왜 그런가요?"

`orphanRemoval`은 **"부모 컬렉션에서 빠졌다"만 보고 판단**합니다. 같은 트랜잭션에서 다른 부모에 다시 붙였는지는 고려하지 않습니다. 그래서 이동이 삭제가 되거나, 삭제 후 재삽입으로 **id가 바뀝니다.** 이건 버그라기보다 **`orphanRemoval`의 의미가 그렇다는 신호**입니다 — "이 자식은 이 부모의 소유"라고 선언해놓고 다른 부모에게 넘기는 것은 모순이니까요. **자식이 부모 사이를 이동하는 도메인이라면 `orphanRemoval`을 켜면 안 됩니다.**

### "게시글에 첨부가 10만 건이면 어떻게 지우나요?"

`orphanRemoval`에 맡기면 **SELECT 한 번 + DELETE 10만 문장**이 만들어지고, 그 전부가 한 트랜잭션 안에서 락을 잡습니다. 현실적이지 않습니다. 선택지는 둘입니다.
① **벌크 DELETE** — `@Modifying`으로 `delete from Attachment a where a.post.id = :id` 한 문장. 대신 **영속성 컨텍스트를 우회하므로 1차 캐시와 DB가 어긋납니다.** 처방은 벌크를 트랜잭션 끝이나 별도 트랜잭션으로 밀거나, 이후 컨텍스트를 비우는 것입니다.
② **DB FK의 `ON DELETE CASCADE`** — 부모 DELETE 한 문장으로 끝나 가장 빠릅니다. 대신 **JPA 리스너·Auditing·soft delete·후처리가 전부 건너뛰어지고, 삭제 파급이 애플리케이션 코드에 안 보입니다.**
그리고 규모가 이 정도면 애초에 **동기 삭제가 맞는지**를 되묻습니다. 부모만 지우고 자식은 배치로 나눠 지우는 비동기 정리가 운영에서 더 안전합니다.

### "DB에 `ON DELETE CASCADE`를 걸면 JPA 설정은 필요 없는 것 아닌가요?" (시니어 변별 포인트)

**동작 주체가 다릅니다.** DB 규칙은 모든 경로(콘솔 SQL, 배치, 다른 애플리케이션)에 적용되므로 **정합성 보장은 더 강력합니다.** 대신 포기하는 것이 셋입니다. ① **엔티티 리스너·Auditing·`@SQLDelete`가 안 돕니다** — 감사 이력이 조용히 비고, soft delete가 우회됩니다. ② **1차 캐시에는 자식이 그대로 남아** 같은 트랜잭션에서 사라진 행이 조회됩니다. ③ **삭제 파급이 DDL에만 있어서 코드 리뷰로는 절대 발견되지 않습니다.**
그래서 저는 **"작은 Aggregate는 JPA에, 대량 삭제는 DB나 벌크에"** 로 나누고, 어느 쪽이든 **한 도메인 안에서는 경로를 하나로 통일**합니다. 둘을 섞으면 "어떤 경로로 지웠느냐에 따라 이력이 남기도 하고 안 남기도 하는" 상태가 되는데, 이건 발견이 거의 불가능한 종류의 문제입니다.

### "그럼 애초에 이런 사고가 안 나게 하려면 뭘 하시겠어요?" (시니어 변별 포인트)

**조심하는 게 아니라 못 하게 만듭니다.** 세 층입니다.
① **캡슐화** — 컬렉션 필드를 `final`로 두고(재할당 불가), getter는 `Collections.unmodifiableList`로 반환하고(`clear()` 시 예외), `addAttachment`/`removeAttachment`만 공개합니다. **DELETE가 일어나는 진입점이 한 곳으로 좁혀집니다.**
② **테스트로 회귀 고정** — `SQLStatementCountValidator.assertDeleteCount(0)` 같은 단정을 수정 시나리오에 걸어둡니다. 누가 매핑을 바꾸면 테스트가 먼저 깨집니다.
③ **구조 룰** — `@OneToMany`에 `CascadeType.ALL` 금지 ArchUnit 룰. 금지가 목적이 아니라 **삭제 전파를 쓰려면 `orphanRemoval = true`를 손으로 적게 만드는 것**이 목적입니다. 적는 순간 결정이 되고 리뷰 대상이 됩니다.
그리고 개발 환경에서는 `p6spy`로 실제 SQL을 상시 노출합니다. "제목만 바꿨는데 `delete`가 세 줄 찍히는" 걸 한 번 보면 그 다음부터는 매핑을 열어보게 됩니다.

### "`@ElementCollection`은 어떤가요?" (가산점 포인트)

`@ElementCollection`으로 매핑한 **값 타입**은 애초에 독립된 생명주기가 없어서, **`orphanRemoval`을 켜지 않아도 항상 고아 제거처럼 동작**합니다. 부모에서 빠지면 행이 사라집니다. 게다가 값 타입 컬렉션은 **하나를 바꿔도 해당 부모의 행을 전부 지우고 다시 넣는** 동작이 있어서, 요소가 많으면 성능이 나쁩니다. 그래서 실무에서는 값 타입 컬렉션 대신 **엔티티로 승격시키고 `@OneToMany` + `orphanRemoval`로 다루는 것**이 권장 구성입니다 — 그때 비로소 삭제 파급을 우리가 통제할 수 있게 됩니다.

---

## 한 줄 요약

**`CascadeType.REMOVE`의 방아쇠는 "부모 삭제" 하나뿐이고, `orphanRemoval = true`는 거기에 "부모와의 연결 해제"가 하나 더 붙어 `getAttachments().remove(a)` 한 줄이 곧 DELETE가 된다.** 그래서 `orphanRemoval`은 목록을 갈아끼우려던 `clear()`가 전건 삭제가 되고, `CascadeType.REMOVE`는(대개 `ALL`에 딸려 들어와) 공유되는 자식까지 지운다. **자식이 부모 없이 존재 의미가 없는 종속 관계에만 켜고, `ALL`을 습관으로 쓰지 않으며, 컬렉션은 `unmodifiableList` + 전용 메서드로 캡슐화해 잘못 만질 수 없게 막는다.**
