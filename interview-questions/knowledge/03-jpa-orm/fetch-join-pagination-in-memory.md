# 컬렉션 fetch join + 페이징 — `limit`이 SQL에서 사라지고 힙에서 잘린다

> 핵심 관전 포인트: 문제는 **`fetch join` 전체가 아니라 컬렉션(ToMany) fetch join + 페이징**이라는 조합 하나다. 판별 축은 딱 하나 — **조인 결과의 행 수가 루트 엔티티 수와 같은가.** ToOne(`@ManyToOne`, `@OneToOne`)은 부모 1행 : 연관 1행이라 행이 안 늘고 `limit`이 SQL에 정상 부착되지만, 컬렉션은 부모 1행이 자식 수만큼 불어나 `limit 10`이 "게시글 10건"이 아니라 **"조인 결과 10행"** 을 자른다. 그러면 마지막 게시글의 댓글이 잘린 채 들어와 **데이터가 틀린다.** 그래서 Hibernate는 정합성을 지키는 쪽을 택한다 — **SQL에서 `limit`/`offset`을 아예 빼고, 조건에 맞는 전체를 힙에 올린 뒤 자바에서 `subList`로 잘라낸다.** 그 결과가 이 문항의 본질이다: **예외도 안 나고 결과도 맞는데 데이터가 늘면 OOM으로 죽는다.** 사전 신호는 경고 로그 한 줄뿐이고, 개발 DB에서는 증상이 0이다. 그래서 해법 3종(**ToOne은 fetch join / 컬렉션은 `default_batch_fetch_size` / 조회 전용은 DTO 프로젝션**)만큼 중요한 것이 **배포 전에 잡는 장치**다 — `hibernate.query.fail_on_pagination_over_collection_fetch: true` 한 줄로 경고를 예외로 승격시키는 것이 첫 방어선이다.

---

## 0. 질문 + 의도

**질문**: "fetch join과 페이징을 함께 쓸 때의 문제(메모리에서 페이징)와 해결책은?"

**출제 의도**: rationale은 이 문항을 이렇게 설명한다 — "limit이 쿼리에 안 붙고 전체를 메모리에 올리는 이 함정은 데이터가 적을 땐 멀쩡하다가 데이터 증가와 함께 OOM으로 터진다. **'지금은 되는데 나중에 터지는' 코드를 미리 알아보는 눈**을 검사한다." 즉 채점 지점은 "fetch join과 페이징은 같이 못 쓴다"는 암기가 아니라, **실패가 어떤 모습으로 드러나는지**(예외가 아니라 경고 한 줄)와 **그것을 운영 전에 어떻게 붙잡는지**다.

**함정**: 이 문항은 "문제와 해결책"을 묻는 형식이라 해결책 나열로 끝내기 쉽다. 그런데 해결책은 [N+1 탐지와 해결](n-plus-one-detection-and-fixes.md)에서 이미 다루는 내용이고, 이 문항이 따로 존재하는 이유는 **"쿼리는 성공하는데 나중에 죽는다"는 실패 양식** 자체에 있다.

---

## 1. 문제의 범위부터 정확히 못 박는다 — 컬렉션일 때만이다

"fetch join과 페이징은 같이 못 쓴다"는 흔한 요약은 **틀렸다.** 정확히는 **컬렉션을 fetch join할 때만** 문제다.

### 1-1. 판별 축은 "조인해도 행 수가 그대로인가" 하나뿐

```java
// ✅ 안전 — ToOne 연관은 몇 개를 겹쳐 fetch join 해도 행이 안 늘어난다
@Query("""
       select p from Post p
       join fetch p.author        // @ManyToOne  → Post 1행 : Author 1행
       join fetch p.category      // @ManyToOne  → Post 1행 : Category 1행
       join fetch p.thumbnail     // @OneToOne   → Post 1행 : Thumbnail 1행
       """)
Page<Post> findPageWithToOnes(Pageable pageable);
// 조인 결과 = Post 20행. limit 20 이 SQL 에 그대로 붙고, 원하는 대로 Post 20건이 온다.

// ❌ 위험 — 컬렉션 하나만 끼면 그 순간 성질이 바뀐다
@Query("select p from Post p join fetch p.comments")   // @OneToMany
Page<Post> findPage(Pageable pageable);
// Post 1건에 댓글 10개면 조인 결과는 10행. limit 20 을 붙이면 Post 2건만 온다.
```

**`@OneToOne`이 안전한 이유는 "1:1이라서"가 아니라 "단일 값이라서"** 다. 같은 이유로
`@ManyToOne`도 안전하다 — 게시글 1,000개가 같은 작성자를 가리켜도, **조인 결과는 여전히
게시글 1건당 1행**이다. 그래서 정확한 표현은 "1:1은 괜찮다"가 아니라
**"ToOne(단일 값 연관)은 괜찮고 ToMany(컬렉션)만 문제다"** 이다. 면접에서 이 한 단어
차이가 "겪어서 아는 사람"과 "외운 사람"을 가른다.

### 1-2. `limit`을 붙이면 왜 결과가 "틀리는가"

여기가 이 문항의 출발점이고, 대부분은 "Post가 2건만 온다"까지만 말한다. 한 걸음 더 가면
더 나쁜 사실이 있다 — **마지막 Post의 댓글이 잘린다.**

```
Post 1 (댓글 10개) → 조인 결과 1~10행
Post 2 (댓글 10개) → 조인 결과 11~20행
Post 3 (댓글 10개) → 조인 결과 21~30행

여기에 limit 25 를 붙이면 25행까지만 읽는다.
→ Post 1: 댓글 10개 (정상)
→ Post 2: 댓글 10개 (정상)
→ Post 3: 댓글 5개  ← 실제로는 10개인데 5개짜리 게시글로 조립된다
```

즉 `limit`을 SQL에 붙이는 선택은 **건수를 틀리게 하는 데서 끝나지 않고 엔티티의 상태를
거짓으로 만든다.** 그리고 그 잘린 컬렉션을 가진 엔티티가 영속성 컨텍스트에 올라가면,
변경 감지가 "댓글 5개가 삭제됐다"고 판단할 위험까지 생긴다(`orphanRemoval`이 켜져
있으면 실제 DELETE로 이어진다).

**Hibernate는 이 결과 오염을 허용하지 않는 쪽을 택했다.** 그래서 `limit`을 SQL에서
빼버린다. 이 선택을 알고 나면 다음 절의 동작이 "이상한 버그"가 아니라 **의도된
트레이드오프**로 읽힌다 — 정확성을 지키기 위해 메모리를 지불한 것이다.

---

## 2. Hibernate가 실제로 하는 일 — 전량 로딩 후 `subList`

### 2-1. 동작 순서

```
① 쿼리에 컬렉션 fetch가 있고 + 페이징이 걸려 있다  →  감지
② 경고 로그를 한 줄 남긴다 (예외 아님)
③ 쿼리 옵션에서 limit/offset 을 제거한다  →  SQL 에 limit 이 안 나간다
④ where 조건에 맞는 전체 행을 읽어 엔티티로 조립한다  →  전부 힙에 올라간다
⑤ 부모 중복을 제거한다
⑥ 자바 List 에서 subList(first, first + max) 로 잘라 반환한다
```

**확인 범위**: 위 흐름은 Hibernate 6.6.53 소스에서 직접 확인했다.
`QuerySqmImpl.doList()`가 `hasLimit && containsCollectionFetches`인 경우
`errorOrLogForPaginationWithCollectionFetch()`를 호출한 뒤 `omitSqlQueryOptions(...)`로
limit을 떼어내고, 마지막에 `handleDistinct()`가
`list.subList( first, Math.min( first + max, resultSize ) )`를 수행한다. 말 그대로
**자바의 `subList`** 다.

실제로 나가는 SQL을 대조하면 이렇다.

```sql
-- 기대한 SQL
select p.*, c.* from post p left join comment c on c.post_id = p.id
where p.status = 'PUBLISHED'
order by p.created_at desc
limit 20 offset 0;          -- ← 이 줄이

-- 실제로 나가는 SQL
select p.*, c.* from post p left join comment c on c.post_id = p.id
where p.status = 'PUBLISHED'
order by p.created_at desc;  -- ← 통째로 사라진다
```

`status = 'PUBLISHED'`인 게시글이 100만 건이고 평균 댓글이 10개면, **1,000만 행을 읽어
게시글 100만 개 + 댓글 1,000만 개를 힙에 올린 뒤 앞의 20개만 남기고 버린다.**

### 2-2. 사전 신호는 경고 로그 한 줄뿐이다 (그리고 버전마다 코드가 다르다)

```
WARN org.hibernate.orm.query :
HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
```

**확인 범위 / 통설 교정** — 인터넷에 널리 인용되는 코드는 `HHH000104`인데, 이건
**Hibernate 5.x의 코드**다. 6.6.53 소스에서 확인한 내용은 다음과 같다.

- **Hibernate 5.x**: `HHH000104: firstResult/maxResults specified with collection fetch;
  applying in memory!` (끝에 느낌표가 있다)
- **Hibernate 6.x ~ 7.3**: 메시지 문구는 거의 같지만 **id가 `90003004`** 이라
  `HHH90003004`로 찍히고, 로거는 `org.hibernate.orm.query`, 레벨은 `WARN`이다
  (`org.hibernate.query.QueryLogging` 참고).
- **실무 귀결**: **로그를 `HHH000104` 문자열로 grep 하면 6.x 프로젝트에서는 하나도 안
  걸린다.** 검색·알람 룰은 코드가 아니라 **`firstResult/maxResults specified with
  collection fetch`** 라는 문구로 잡는 것이 버전에 안전하다. **(가산점 포인트)**
- **Hibernate 7.4부터는 동작 자체가 바뀌었다** — limit/offset을 부모에 대한
  파생 테이블(서브쿼리)로 밀어넣어 **DB에서 페이징한다.** 옛 동작으로 되돌리는 쿼리
  힌트가 `org.hibernate.limitInMemory`다. 다만 Spring Boot 3.x는 Hibernate 6.x이므로
  **현재 현업의 대다수 프로젝트는 여전히 메모리 페이징 구간**이다. 버전별 대응표는
  [N+1 탐지와 해결](n-plus-one-detection-and-fixes.md) §2-1에 정리돼 있다.

### 2-3. 이 문항의 진짜 위험 — 세 가지가 동시에 성립한다

이 버그가 유독 오래 살아남는 이유는 **평범한 버그의 신호 세 가지가 전부 없기 때문**이다.

1. **예외가 안 난다.** 컴파일도 되고 런타임 예외도 없다. 기본 설정에서는 경고 로그만 찍는다.
2. **결과가 맞다.** 반환된 게시글 20건은 정확하고 각 게시글의 댓글도 온전하다. QA가
   화면을 봐도 이상한 곳이 없다. 페이지 번호, 총 건수(count 쿼리는 별도로 나가고 정상이다)
   까지 다 맞는다.
3. **개발 환경에서는 증상이 0이다.** 로컬 DB의 게시글이 200건이면 200건을 힙에 올리는
   건 아무 일도 아니다. **부하 테스트를 해도 데이터가 적으면 안 잡힌다** — 이건 요청
   수의 문제가 아니라 **데이터 양의 문제**이기 때문이다.

그래서 이 코드는 **정상적으로 리뷰를 통과하고 정상적으로 배포된다.** 그리고 데이터가
임계점을 넘는 어느 날, 갑자기 죽는다.

죽는 방식도 고약하다. **`OutOfMemoryError`는 힙을 채운 그 요청이 아니라 옆 요청에서 날
수 있다.** 힙은 프로세스 전체가 공유하는 자원이라, 목록 API가 힙을 90% 채워두면
아무 관계 없는 결제 API가 메모리 부족으로 실패한다. 그래서 스택 트레이스가 범인을
가리키지 않고, **"어제부터 서버가 가끔 죽는데 원인을 모르겠다"** 로 며칠이 흘러간다.
Full GC가 반복되면서 응답 지연이 먼저 오고, OOM은 그다음에 온다.

> 이 문항의 정답을 한 문장으로 말하면 이렇다 —
> **"결과가 맞다는 것이 안전하다는 뜻이 아니다. 이건 정확성 문제가 아니라 자원 문제고,
> 자원 문제는 데이터가 자라야만 드러난다."**

---

## 3. 해법 3종과 선택 기준

### 3-1. ① ToOne 연관은 fetch join으로 함께 가져온다

§1에서 확인한 대로 행이 안 늘어나므로 **페이징과 아무 갈등이 없다.** 여러 개를 겹쳐도
된다. 목록 API에서 작성자 닉네임, 카테고리 이름처럼 **건당 하나씩 붙는 값**은 전부
여기서 처리한다.

```java
// ✅ ToOne 은 조인으로 끌고 온다 — 쿼리 1개, limit 정상 부착
@Query("select p from Post p join fetch p.author")
Page<Post> findPageWithAuthor(Pageable pageable);
```

`join`과 `join fetch`의 차이는 반드시 짚어야 한다. 일반 `join`은 SQL 조인만 만들고
select 목록에는 부모만 올라가므로 **연관은 여전히 프록시**이고 N+1이 그대로다.
`join fetch`여야 연관의 컬럼까지 함께 읽는다.

### 3-2. ② 컬렉션은 `default_batch_fetch_size`에 맡긴다 (표준 해법)

**컬렉션은 쿼리에서 fetch하지 않는다.** LAZY로 두고, 실제로 접근하는 순간
Hibernate가 묶어서 가져오게 한다.

```java
// ❌ BEFORE — 컬렉션을 fetch join 해서 페이징이 메모리로 넘어간다
@Query("select p from Post p join fetch p.comments")
Page<Post> findPage(Pageable pageable);

// ✅ AFTER — 컬렉션 fetch 를 빼면 limit 이 SQL 에 정상 부착된다
Page<Post> findAll(Pageable pageable);
// p.getComments() 에 접근하는 순간 batch fetch 가 발동한다
```

설정은 한 줄이다. **위치를 틀리는 사람이 아주 많다.**

```yaml
spring:
  jpa:
    properties:            # ← 이 단계가 반드시 있어야 한다
      hibernate:
        default_batch_fetch_size: 100
```

`spring.jpa.hibernate.default_batch_fetch_size`로 적으면 **에러도 경고도 없이 조용히
무시된다.** Spring Boot에는 이 설정을 위한 전용 프로퍼티가 없어서
`spring.jpa.properties.` 아래로 넘겨야 Hibernate에 전달된다. "설정했는데 안 먹는다"의
단골 원인이다. **(가산점 포인트)**

특정 연관만 다르게 주려면 필드에 붙인다.

```java
@Entity
public class Post {
    @BatchSize(size = 200)                    // 이 컬렉션만 200 으로
    @OneToMany(mappedBy = "post")
    private List<Comment> comments = new ArrayList<>();
}
```

**켜면 실제로 나가는 쿼리는 이렇게 바뀐다.**

```sql
-- ① 부모 페이징 쿼리 — 조인이 없으니 limit 이 SQL 에 붙는다
select p.* from post p where p.status = 'PUBLISHED' order by p.created_at desc
limit 20 offset 0;

-- ② 컬렉션 접근 시, 20개 프록시를 한 번에 묶어서
select c.* from comment c where c.post_id in (?, ?, ?, ... );   -- ← 파라미터 20개
```

**쿼리 수는 `1 + N`에서 `1 + ceil(N / size)`로 떨어진다.** 페이지 크기 20에
size 100이면 `1 + ceil(20/100) = 2`, 즉 **총 2쿼리**다. 눈치챘겠지만 이건
**"ToOne 조인해 페이징 → post_id로 컬렉션 일괄 조회 → 애플리케이션에서 조합"이라는
2쿼리 설계를 Hibernate가 대신 해주는 것**이다. 손으로 짜던 패턴에 이름이 붙어 있는
것뿐이다.

**size는 어떻게 정하나.** 감각은 단순하다.

- **하한**: 한 페이지에서 채워야 할 부모 수보다 커야 의미가 있다. 페이지 크기가 20인데
  size가 5면 컬렉션 쿼리가 4번 나간다. **페이지 크기 이상**이 최소선이다.
- **상한**: size만큼 `IN` 파라미터가 늘어 SQL이 길어지고, DB에 따라 `IN` 목록의 최대
  항목 수 제한에 걸릴 수 있다.
- **실무 기본값**: 전역에 **100** 정도를 깔아 안전망으로 쓰고, 유독 큰 페이지를 쓰는
  화면의 연관만 `@BatchSize`로 올린다. 100~1000 범위를 벗어날 일은 드물다.

**공존의 조건을 정확히 말해야 한다.** batch fetch가 페이징과 공존하는 이유는 그 기능이
특별해서가 아니라 **페이징 쿼리가 컬렉션을 fetch하지 않기 때문**이다. 그래서
`default_batch_fetch_size`를 켜두고도 `@EntityGraph(attributePaths = "comments")`를
붙이면 **메모리 페이징이 그대로 재현된다** — `@EntityGraph`는 fetch join과 같은 SQL로
번역되기 때문이다. 지켜야 할 규칙은 설정값이 아니라 **"페이징 쿼리에서 컬렉션을
fetch하지 않는다"** 이다.

한계도 정직하게 말한다. **쿼리가 1개가 되는 것은 아니고**, N+1을 없애는 게 아니라
`1+N`을 `1+몇 개`로 낮추는 완화책이다. 그리고 가장 큰 부작용은 성능이 아니라
**은폐**다 — 증상이 옅어져서 문제의 존재 자체를 모르게 된다. 그래서 §4의 탐지 장치와
반드시 짝으로 깔아야 한다. 내부 동작(버전별 배치 크기 산정 방식, PostgreSQL의 배열
바인딩 등)은 [N+1 탐지와 해결](n-plus-one-detection-and-fixes.md) §2-3에 정리돼 있다.

### 3-3. ③ 조회 전용 화면이면 애초에 DTO 프로젝션

앞의 둘은 **엔티티를 만든다**는 전제를 공유한다. 목록 API처럼 읽기만 하는 화면이라면
그 전제를 버리는 게 가장 근본적이다. 엔티티를 안 만들면 프록시도 스냅샷도 없다.

```java
public Page<PostView> page(Pageable pageable) {
    // ① 부모를 필요한 컬럼만, 페이징으로 — limit 정상
    Page<PostRow> posts = postRepository.findRows(pageable);                    // 쿼리 1

    List<Long> postIds = posts.getContent().stream().map(PostRow::id).toList();

    // ② 자식을 id 목록으로 한 번에
    Map<Long, List<CommentRow>> byPost = commentRepository.findRowsByPostIdIn(postIds)
            .stream().collect(groupingBy(CommentRow::postId));                  // 쿼리 2

    // ③ 애플리케이션에서 조합 — 총 2쿼리, 페이징 정상, 행 증폭 없음
    return posts.map(p -> new PostView(p, byPost.getOrDefault(p.id(), List.of())));
}
```

주의할 구분이 하나 있다. **"DTO를 반환한다"와 "DTO 프로젝션"은 다르다.** 반환 타입이
DTO여도 엔티티를 조회해서 자바에서 변환하면 아무것도 달라지지 않는다. **DTO가 쿼리의
결과여야** 효과가 있다.

### 3-4. "id만 먼저 페이징하고 다시 조회"는 언제 필요한가

`select distinct p.id from Post p join p.comments c ... limit 20`으로 id를 먼저 뽑는
2단계 방식도 자주 언급된다. 방향은 맞지만 **조건을 정확히 붙여야 한다.**

- **컬렉션에 검색 조건이 걸린 경우에만 그 조인이 필요하다.** 예: "댓글에 특정 키워드가
  달린 게시글 목록". 이때는 조인이 불가피하고, 행이 불어나므로 `distinct`가 SQL에
  반드시 있어야 한다.
- **컬렉션이 그냥 화면에 필요할 뿐이라면 그 조인 자체가 불필요하다.** 조건이 게시글에만
  걸려 있으면 `select p from Post p where ... limit 20`으로 끝이고, 컬렉션은 3-2/3-3의
  방식으로 채우면 된다. **조인을 걷어내는 게 id 서브쿼리보다 낫다.**
- 참고로 **엔티티 fetch join에 붙이는 `distinct`는 Hibernate 6부터 불필요하고 오히려
  손해**다(부모 중복 제거를 Hibernate가 항상 해주는데, `distinct`를 쓰면 SQL로도
  나가서 DB가 중복 제거 비용을 낸다). 반면 **위처럼 id만 프로젝션하는 쿼리의
  `distinct`는 여전히 필수**다. 둘을 같은 것으로 뭉뚱그리면 틀린다. **(가산점 포인트)**

### 3-5. 선택 기준

| 상황 | 선택 | 근거 |
|---|---|---|
| ToOne 연관 (페이징 유무 무관) | `fetch join` / `@EntityGraph` | 조인해도 행이 안 늘어 `limit` 정상 |
| 컬렉션 1개 + **페이징 없음** | `fetch join` | 쿼리 1개. 6+ 에서 `distinct`는 빼는 게 낫다 |
| **컬렉션 + 페이징** | **batch fetch size** | fetch join 금지 구간 |
| 컬렉션 2개 이상 | batch fetch size | fetch join은 카테시안 곱 |
| 조회 전용 목록 API | DTO 프로젝션 (컬렉션은 2단 조회) | 엔티티·프록시를 아예 안 만든다 |
| 전 구간 안전망 | 전역 `default_batch_fetch_size` | 놓친 지점의 피해를 낮춘다 |

면접에서 한 문장으로: **"ToOne은 fetch join으로 함께 끌고, 컬렉션은 fetch에서 빼고
batch fetch size에 맡깁니다. 조회 전용 화면이면 아예 DTO 프로젝션으로 갑니다."**

---

## 4. 배포 전에 잡는 장치 — 이 문항의 실제 관문

§2-3에서 확인한 대로 이 버그는 **예외 없음 / 결과 정상 / 개발 환경 무증상**이 동시에
성립한다. 사람의 주의력으로 잡을 수 있는 조건이 하나도 없다는 뜻이다. 그래서
"코드 리뷰에서 잘 보겠다", "쿼리 로그를 확인하겠다"는 답은 **여기서 미달로 기록된다.**
필요한 것은 **사람이 안 봐도 실패하는 장치**다.

### 4-1. 1층 — 경고를 예외로 승격시킨다 (가장 먼저 할 일)

Hibernate에는 이 상황을 **경고 대신 예외로 만드는 설정**이 있다. 아는 사람이 드물다.

```yaml
spring:
  jpa:
    properties:
      hibernate:
        query:
          fail_on_pagination_over_collection_fetch: true   # 기본값 false
```

**확인 범위**: 6.6.53 소스에서 확인했다. 프로퍼티 이름은
`hibernate.query.fail_on_pagination_over_collection_fetch`이고 **기본값은 `false`**,
Hibernate **5.2.13부터** 존재한다. `true`면 `AbstractSqmSelectionQuery`가 로그 대신
`HibernateException`을 던지며, 메시지는 다음과 같다.

```
org.hibernate.HibernateException:
setFirstResult() or setMaxResults() specified with collection fetch join
(in-memory pagination was about to be applied, but
 'hibernate.query.fail_on_pagination_over_collection_fetch' is enabled)
```

기본값이 `false`라는 사실이 이 문항의 핵심을 그대로 말해준다 — **아무 조치도 안 하면
조용히 메모리 페이징이 된다.** 이 한 줄을 켜는 순간 문제의 성격이 바뀐다.

- 배포 전에 **테스트가 빨간불로 실패한다.** 목록 API를 한 번이라도 호출하는 테스트가
  있으면 그 자리에서 잡힌다.
- 데이터가 적어도 잡힌다. **이 검사는 데이터 양이 아니라 쿼리의 모양을 보기 때문**이다.
  §2-3의 세 번째 조건(개발 환경 무증상)을 정면으로 무력화한다.

주의점 둘. ① 예외는 부팅 시점이 아니라 **그 쿼리를 실행하는 시점**에 난다. 그러므로
"켜두면 안전하다"가 아니라 **"켜두고 그 쿼리를 타는 테스트가 있어야 안전하다"** 이다.
② Hibernate 7.4 이상에서는 파생 테이블로 밀어넣기가 가능한 경우 애초에 메모리 페이징이
아니므로 발동하지 않는다.

### 4-2. 2층 — 경고 로그를 테스트에서 실패로 만든다

`fail_on_pagination_over_collection_fetch`를 운영에 켜는 것이 부담스러운 팀도 있다
(§5의 마지막 꼬리질문 참고). 그런 경우에도 **테스트에서는 경고 자체를 실패로 다룰 수
있다.** 로그 어펜더를 붙여 WARN을 수집한 뒤 단정하면 된다.

```java
// ✅ Hibernate 쿼리 로거의 WARN 을 수집해 "한 건도 없어야 한다" 로 못 박는다
class NoInMemoryPaginationTest {

    private ListAppender<ILoggingEvent> appender;
    private Logger queryLogger;

    @BeforeEach
    void attach() {
        // 6.x 의 로거 이름. 5.x 는 org.hibernate 하위의 다른 이름이므로,
        // 버전이 다르면 실제 로그 한 줄을 찍어보고 로거 이름을 확인해 맞춘다.
        queryLogger = (Logger) LoggerFactory.getLogger("org.hibernate.orm.query");
        appender = new ListAppender<>();
        appender.start();
        queryLogger.addAppender(appender);
    }

    @AfterEach
    void detach() {
        queryLogger.detachAppender(appender);
    }

    @Test
    void 게시글_목록은_메모리_페이징을_하지_않는다() {
        postService.list(PageRequest.of(0, 20));

        // 메시지 코드(HHH000104 / HHH90003004)는 버전마다 달라지므로 문구로 잡는다
        assertThat(appender.list)
                .noneMatch(e -> e.getFormattedMessage()
                        .contains("firstResult/maxResults specified with collection fetch"));
    }
}
```

**메시지 코드가 아니라 문구로 매칭하는 것이 핵심이다.** §2-2에서 본 대로 `HHH000104`는
5.x 코드라서 6.x에서는 절대 안 걸린다. 운영 로그 알람 룰도 같은 이유로 문구 기준이어야
한다. **(가산점 포인트)**

### 4-3. 3층 — 쿼리 수를 단정한다

배치 fetch로 고친 뒤에는 **"이 API는 쿼리 몇 개인가"** 를 테스트로 고정한다. 이게 있어야
다음 PR에서 누군가 `@EntityGraph(attributePaths = "comments")`를 붙여 원상 복구시키는
것을 막을 수 있다.

```java
@Test
void 목록_API_는_쿼리_2개로_끝난다() {
    Statistics stats = entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
    stats.clear();
    entityManager.clear();          // 1차 캐시가 남아 있으면 쿼리 수가 줄어 통과해버린다

    postService.list(PageRequest.of(0, 20));   // 부모 1 + 컬렉션 배치 1

    assertThat(stats.getPrepareStatementCount()).isEqualTo(2);
}
```

메서드 이름은 `getPrepareStatementCount()`다(`Prepared`가 아니다). `Statistics`를 쓰려면
`spring.jpa.properties.hibernate.generate_statistics=true`가 필요하다. 이 계열 장치의
층별 구성(요청 단위 쿼리 카운터, `SQLStatementCountValidator`, ArchUnit 룰)은
[N+1 탐지와 해결](n-plus-one-detection-and-fixes.md) §3에 정리돼 있다 — **같은 장치가
이 문항의 회귀도 함께 막는다.**

### 4-4. 4층 — "로컬에서 안 터진다"를 안전 신호로 읽지 않는다

가장 중요한데 코드가 아닌 항목이다. **개발 DB에 데이터가 적다는 사실은 검증이 아니라
사각지대다.** 이 인식을 픽스처 설계 규칙으로 바꿔야 한다.

페이징 + 컬렉션을 다루는 테스트는 **두 조건을 동시에** 만족해야 문제가 재현된다.

```java
// ❌ BEFORE — 게시글 1건에 댓글 100개. 데이터는 많지만 페이징이 발동을 안 해 통과한다
Post post = savePost();
IntStream.range(0, 100).forEach(i -> saveComment(post));

// ✅ AFTER — 부모 수가 페이지 크기를 넘고(50 > 20), 자식이 1개보다 많다(행 증폭 발생)
IntStream.range(0, 50).forEach(i -> {
    Post p = savePost();
    IntStream.range(0, 3).forEach(j -> saveComment(p));
});
```

즉 **부모 수 > 페이지 크기**(페이징이 실제로 잘라야 함)이고 **자식 수 > 1**(행이 실제로
불어나야 함)이어야 한다. 둘 중 하나만 만족하는 픽스처는 문제를 통과시킨다. 이건 N+1
재현 실패의 원인("픽스처는 건수가 아니라 카디널리티로 설계한다")과 정확히 같은 함정이다.

여기에 운영 관점의 습관을 하나 더 붙이면 완성된다 — **"운영 데이터가 지금의 10배가
되면 이 코드는 어떻게 되나"** 를 목록·검색 API에 대해 배포 전에 한 번씩 묻는 것.
이 문항은 그 질문을 안 하면 절대 안 걸리는 유형이다.

### 4-5. 층별 정리와 도입 순서

| 층 | 장치 | 언제 잡히나 | 비용 |
|---|---|---|---|
| 1 | `fail_on_pagination_over_collection_fetch: true` | 그 쿼리를 실행하는 순간 | 설정 한 줄 |
| 2 | 로그 어펜더로 WARN 단정 | 테스트 실행 시 | 테스트 유틸 1개 |
| 3 | `Statistics` 쿼리 수 단정 | PR 단계 | 테스트당 3줄 |
| 4 | 카디널리티 픽스처 | 위 셋의 전제 조건 | 픽스처 규칙 |

**도입 순서는 1 → 4 → 3 → 2다.** 1번이 압도적으로 저렴하고 효과가 크므로 먼저 켜고,
그다음 4번으로 "1번이 발동할 수 있는 테스트"를 확보한다. 3번은 고친 뒤 회귀를 막는
자물쇠이고, 2번은 1번을 전 환경에 켜지 못하는 팀의 대체재다.

---

## 5. 꼬리질문 대비 포인트

### "결과는 정확하게 나온다면서요. 그럼 뭐가 문제인가요?"

**정확성의 문제가 아니라 자원의 문제**이기 때문이다. 반환되는 20건은 완벽하지만, 그
20건을 얻기 위해 조건에 맞는 **전체**를 읽어 엔티티로 조립한다. 비용은 세 군데서 난다 —
DB에서 전체 행을 스캔·전송하는 I/O, 그것을 엔티티로 만드는 CPU, 그리고 힙 사용량이다.
그리고 이 비용은 **데이터 양에 비례해 자란다.** 오늘 200건이면 무해하고 내년 200만
건이면 치명적이다. 즉 이건 "버그가 있다/없다"의 문제가 아니라 **시한폭탄이 있다/없다**의
문제다.

### "페이지 정보(전체 건수, 마지막 페이지)는 왜 정상으로 보이나요?"

`Page`를 반환할 때 **총 건수를 세는 count 쿼리는 별도로 나가고, 거기엔 조인 fetch가
없으므로 정상**이기 때문이다. 그래서 화면의 페이지네이션 UI는 완벽하게 동작하고, 내용도
맞다. **관측 가능한 모든 지표가 정상을 가리키는데 힙만 조용히 차오르는 상태** —
§2-3에서 말한 "신호가 없다"는 것의 구체적인 모습이다. 이 질문에 "count는 정상이라
더 헷갈린다"고 답하면 실제로 겪어본 사람으로 읽힌다.

### "`default_batch_fetch_size`를 전역으로 1000처럼 크게 두면 부작용은 없나요?" (트레이드오프 판단)

세 가지가 있다. ① **`IN` 파라미터가 그만큼 늘어난다** — SQL 길이가 커지고, DB에 따라
`IN` 목록 항목 수 제한에 걸릴 수 있다. ② **한 번에 올라오는 엔티티 수가 커진다** —
배치 크기가 곧 한 쿼리로 힙에 올리는 자식 수의 상한이므로, 자식이 무거운 엔티티면
큰 값이 그 자체로 메모리 압력이 된다. ③ **가장 큰 부작용은 은폐다** — 값이 크면 N+1이
`1+2`쯤으로 줄어 로그가 조용해지고, **문제가 있는지조차 모르게 된다.** 그래서 전역
batch fetch size는 "안전망"이지 "해결"이 아니고, **§4의 탐지 장치와 반드시 함께**
깔아야 한다. 안전망만 깔면 "조용한 1 + 수십 쿼리" 상태로 굳는다.

### "컬렉션이 두 개고 페이징도 필요한 화면은 어떻게 푸나요?"

fetch join은 아예 후보에서 빠진다 — 컬렉션 둘을 조인하면 **카테시안 곱**이 되기
때문이다(각각 100개면 10,000행). 그리고 `List` 둘이면 `MultipleBagFetchException`으로
크게 실패하지만 **`Set` 둘이면 예외도 경고도 없이 조용히 곱해진다.** 그래서 정답은
**ToOne만 fetch join하고 컬렉션 둘은 batch fetch size에 맡기는 것**이다. 각 컬렉션이
독립적인 `IN` 쿼리로 나가므로 곱이 아니라 합이 되고(총 3쿼리), 페이징도 정상이다. 흔히
도는 요령인 "`List`를 `Set`으로 바꾸면 된다"는 **예외를 없애는 것이지 카테시안 곱을
없애는 게 아니다** — 큰 소리로 실패하던 것을 조용한 성능 문제로 바꾸는, 감지 장치를
끄는 행위에 가깝다. 자세한 근거는 [N+1 탐지와 해결](n-plus-one-detection-and-fixes.md)
§2-1에 있다. **(가산점 포인트)**

### "`fail_on_pagination_over_collection_fetch`를 운영에도 켜는 게 맞나요?" (시니어 변별 포인트)

기본 입장은 **켜는 쪽**이고, 근거는 "예외가 OOM보다 싸다"는 것이다. 이 설정이 없으면
장애는 **OOM으로, 무관한 API에서, 원인 불명으로** 온다. 켜두면 문제가 **그 API 하나의
500 에러로, 스택 트레이스와 함께** 온다. 피해 범위와 진단 시간이 비교가 안 된다.

다만 조건 없이 "무조건 켜세요"는 정확한 답이 아니다. 켜는 순간 **지금까지 조용히 잘
돌던 API가 즉시 실패하기** 때문이다. 그래서 순서를 말하는 편이 낫다.

1. **로컬·CI·테스트 프로파일에 먼저 켠다.** 여기엔 반대 이유가 없다. 신규 코드가
   이 함정에 빠지는 것을 그날로 막는다.
2. **스테이징에서 켜고 전 화면을 돌려 기존 위반 지점을 전수로 뽑는다.** 이 단계가
   운영 적용 전의 조사에 해당한다.
3. **위반 지점을 다 정리한 뒤 운영에 켠다.** 이때부터는 회귀 방지 장치로 작동한다.

즉 답변의 형태는 "켠다/안 켠다"가 아니라 **"어느 환경에 어떤 순서로 켜서, 켜는 행위
자체를 조사 도구로 쓴다"** 여야 한다. 이건 `spring.jpa.open-in-view: false`를 켜서
숨어 있던 `LazyInitializationException`을 드러내는 것과 완전히 같은 전략이다
([LazyInitializationException](lazy-initialization-exception.md) §4 참고).

### "Hibernate 7.4에서 고쳐졌다면 이 지식은 이제 필요 없는 것 아닌가요?" (시니어 변별 포인트)

세 가지 이유로 여전히 필요하다. ① **버전이 안 따라온다** — Spring Boot 3.x는 Hibernate
6.x이고, 현업 프로젝트의 다수가 여기 있다. 프레임워크 메이저 업그레이드는 몇 년 단위로
밀린다. ② **7.4의 개선에도 조건이 있다** — 파생 테이블 방식은 DB가 서브쿼리 안의
limit/offset을 지원해야 하고 루트 엔티티가 하나여야 한다. 조건을 못 맞추면 옛 동작으로
떨어지는데, 그때 필요한 지식이 정확히 이것이다. ③ **더 중요한 건 원리 쪽이다** — 이
문항이 가르치는 것은 `limit` 부착 여부가 아니라 **"조인은 행을 증폭시키고, 페이징의
단위와 조인 결과의 단위는 다르다"** 는 관계다. 이건 JPA 밖에서도 똑같이 나온다.
MyBatis에서 1:N 조인 결과에 `limit`을 붙일 때, 리포트 쿼리에서 상세 조인 후 상위 N건을
자를 때 전부 같은 함정이다. **도구가 막아주는 범위가 넓어졌을 뿐, 판단해야 하는
사람은 그대로다.**

---

## 한 줄 요약

컬렉션 fetch join에 페이징을 걸면 Hibernate는 결과가 틀어지는 것을 막으려 **SQL에서
`limit`을 빼고 전체를 힙에 올린 뒤 자바에서 잘라내며**, 예외도 없고 결과도 맞고 개발
환경에선 증상도 없기 때문에 — 해법 3종(ToOne은 fetch join / 컬렉션은 batch fetch size /
조회 전용은 DTO)만큼이나 **`fail_on_pagination_over_collection_fetch`로 경고를 예외로
승격시켜 배포 전에 실패하게 만드는 것**이 이 문항의 진짜 답이다.
