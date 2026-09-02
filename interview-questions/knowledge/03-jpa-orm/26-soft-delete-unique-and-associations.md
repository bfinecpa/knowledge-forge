# Soft delete와 유니크 제약·연관관계 조회 — 행을 안 지우기로 한 대가는 어디서든 청구된다

> 핵심 관전 포인트: 이 문항의 모든 증상은 **한 문장**에서 파생된다 — **"삭제했다"는 것은 우리 애플리케이션의 약속일 뿐, DB도 JPA도 그런 개념을 모른다.** DB 입장에서 탈퇴 회원의 행은 **여전히 존재하는 멀쩡한 행**이므로 `unique (email)`을 계속 점유한다. 그래서 "탈퇴했는데 재가입이 안 돼요"가 나온다. 같은 이유로 JPA는 `post.getComments()`를 채울 때 **FK만 보고 `where post_id = ?`로 자식 행을 전부** 긁어오므로 삭제된 댓글이 딸려온다. 해법은 두 갈래다. **유니크 쪽**은 **PostgreSQL의 부분 유니크 인덱스** 한 줄(`create unique index ... on member (email) where deleted = false`)이면 끝난다 — 삭제된 행은 인덱스에 아예 들어가지 않으므로 몇 번을 탈퇴·재가입해도 자리를 점유하지 않고, 활성 중복만 정확히 막힌다. 이 성질의 뿌리는 **유니크 제약이 `NULL`을 서로 같지 않은 값으로 취급한다**는 표준 SQL 규칙인데, 같은 규칙이 자리를 바꾸면 함정이 된다 — `unique (email, deleted_at)` 같은 **복합 유니크로 가면 활성 행끼리 `NULL`이 서로 다르다고 판정되어 "같은 이메일 활성 회원 2명"이라는 더 나쁜 구멍**이 열린다(PostgreSQL 15+의 `nulls not distinct`로 뒤집을 수는 있다). 그래서 삭제 구분자는 **유일성이 정의상 보장되는 값**(`deleted_seq = id`)이어야 하고 시각은 정보로만 남긴다. **연관관계 쪽**은 하이버네이트의 **`@SQLRestriction("deleted = false")`**(6.3 이전 이름은 `@Where`)를 걸어 그 엔티티를 읽는 **모든 SQL에 조건을 자동으로 덧붙이고**, 짝인 **`@SQLDelete`**로 `delete` 호출을 UPDATE로 바꿔 세트를 완성한다(6.4의 **`@SoftDelete`**는 이 둘을 하나로 묶은 것). **다만 그 대가는 "끌 수 없다"** — 애노테이션 문서가 직접 "always applied and cannot be disabled"라고 못 박고 있어서, **삭제된 데이터를 봐야 하는 관리자 화면·통계는 예외 없이 조용히 0건**이 되고 네이티브 쿼리나 별도 조회 모델을 따로 파야 한다. 중급 Q5의 `@JsonIgnore`가 "엔티티에 박히는 전역 스위치"라 실패했던 것과 **정확히 같은 성격의 함정**이다. 그리고 soft delete를 택한 이상 청구서는 유니크·조회 말고도 더 온다 — **인덱스는 삭제 행까지 떠안고**(VACUUM으로도 안 줄어든다. 그 행들은 죽은 튜플이 아니라 살아 있는 행이다), **집계는 조건 하나가 빠지면 예외 없이 숫자만 조용히 틀리며**, **FK와 `on delete` 동작은 발동할 계기 자체를 잃고**, **개인정보는 파기 의무와 충돌한다.**

---

## 0. 질문 + 의도

**질문**: "Soft delete를 구현할 때 유니크 제약과 연관관계 조회는 어떻게 처리하나요?"

관련 질문:
"`member(id, email VARCHAR UNIQUE, deleted BOOLEAN)` 구조입니다. '탈퇴했다가 재가입하려는데 이미 사용 중인 이메일이라고 나온다'는 CS가 들어왔습니다. 왜 그렇고 어떻게 해결하겠습니까?"
"`Post` 1:N `Comment`에서 댓글도 soft delete인데 `post.getComments()`에 삭제된 댓글까지 딸려 옵니다. 왜 그렇고 어떻게 처리합니까?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**삭제된 행이 유니크 제약을 계속 점유해 '탈퇴했는데 재가입이 안 돼요'가 되는 실무 함정. 삭제를 '행 제거'가 아닌 도메인 상태로 다룰 때의 대가를 설계에 반영하는지 본다.**" 즉 채점 지점은 "soft delete를 아느냐"가 아니다. 그건 다 안다. 채점 지점은 **"안 지우기로 결정한 순간 어디어디에 청구서가 날아오는지를 미리 세어봤느냐"**다. 청구서는 최소 네 곳에서 온다 — **유니크 제약, 연관관계 조회, 인덱스, 집계**. 그리고 그 청구서를 **애플리케이션 코드로 막을지, 스키마로 막을지, 아니면 애초에 soft delete를 그만둘지**를 근거와 함께 고를 수 있느냐가 상·중을 가른다.

**빠지기 쉬운 함정 네 개**:

- **"JPA에 그런 기능이 있겠지"에서 멈추는 것.** 있다(`@SQLRestriction`/`@SQLDelete`/`@SoftDelete`). 그런데 그 도구의 **이름을 대지 못하면 "설계 감각은 있는데 손에 도구가 없는 사람"**으로 보이고, 더 중요하게는 **그 도구가 무엇을 못 하는지**(= 끌 수 없다)를 말할 수 없다.
- **`deleted` boolean으로 복합 유니크를 만들면 끝났다고 믿는 것.** 첫 번째 재가입까지는 통한다. **두 번째 탈퇴에서 다시 터진다**(§2-4).
- **`deleted_at`으로 바꾸면 해결됐다고 믿는 것.** 유니크 제약에서 **`NULL`은 서로 다른 값**이므로, 이 순간 "활성 회원 중복"이라는 **더 나쁜 구멍**이 열린다(§2-1, §2-4).
- **삭제된 자식이 딸려오는 것을 애플리케이션에서 `filter`로 걸러내는 것.** 화면은 맞아지지만 **이미 전부 읽어온 뒤**라 I/O·메모리 비용은 그대로다. 조건은 **DB로 내려가야** 의미가 있다(§3-1).

**기준 DB와 버전**: 이 저장소의 기준 데이터베이스는 **PostgreSQL**이다. DDL과 실행 계획 어휘는 PostgreSQL로 쓰고, MySQL에서만 성립하거나 MySQL에서만 필요한 우회로는 **"MySQL"이라고 명시**한다. 하이버네이트 동작은 **Hibernate ORM 6.x(본문 확인은 6.6.53.Final 소스와 애노테이션 문서)** 기준이다.

**읽는 순서**: §1은 **문제의 뿌리**다. 재가입 실패와 "삭제된 댓글이 딸려온다"는 서로 무관해 보이는 두 증상이 사실 한 문장에서 나온다는 것을 보인다. §2는 **유니크 축**이다. 모든 해법이 `NULL`의 성질 위에 서 있으므로 그것부터 세우고, 해법 네 가지를 DDL·마이그레이션 주의점·포기하는 것과 함께 놓는다. §3은 **연관 축과 나머지 청구서**다. 도구를 소개하고, 그 도구가 못 하는 일을 구체적 상황으로 보이고, 유니크·조회 말고 어디서 더 청구서가 오는지 세고, 마지막에 그 모든 규칙을 테스트로 고정한다.

---

## 1. 문제의 뿌리 — DB도 JPA도 "삭제됨"을 모른다

### 1-1. 증상 ① 재가입이 막히는 순간을 행 상태로 추적한다

스키마는 이렇다. 질문에 나온 그대로를 PostgreSQL DDL로 옮겼다.

```sql
create table member (
  id      bigint       generated always as identity primary key,
  email   varchar(255) not null,
  deleted boolean      not null default false,
  constraint uk_member_email unique (email)      -- 문제의 진원지
);
```

`hong@a.com`이 가입 → 탈퇴 → 재가입을 시도하는 동안 테이블이 어떻게 변하는지 그대로 따라간다.

| 순서 | 동작 | 실행되는 SQL | 테이블 상태 | 결과 |
|---|---|---|---|---|
| ① | 가입 | `insert into member(email, deleted) values('hong@a.com', false)` | `(1, hong@a.com, false)` | OK |
| ② | 탈퇴 | `update member set deleted = true where id = 1` | `(1, hong@a.com, true)` — **행은 그대로 남아 있다** | OK |
| ③ | 재가입 | `insert into member(email, deleted) values('hong@a.com', false)` | 변화 없음 | **실패** |

③에서 PostgreSQL이 돌려주는 에러는 이렇다.

```text
ERROR:  duplicate key value violates unique constraint "uk_member_email"
DETAIL:  Key (email)=(hong@a.com) already exists.
```

②를 보라. **우리는 "지웠다"고 생각하지만 DB가 한 일은 컬럼 하나를 `true`로 바꾼 UPDATE 한 줄**이다. 인덱스에서 `hong@a.com` 항목은 **1밀리초도 빠진 적이 없다.** 그러니 ③이 막히는 것은 버그가 아니라 **우리가 시킨 대로 정확히 동작한 것**이다.

> 비유하자면 이렇다. 도서관에서 책을 **폐기 처리**하면서 실제로는 서가에서 빼지 않고 **표지에 "폐기됨" 스티커만 붙였다.** 서가의 자리(= 유니크 인덱스의 자리)는 그대로 점유돼 있다. 같은 청구기호로 새 책을 꽂으려 하면 사서(= DB)는 "그 자리엔 이미 책이 있습니다"라고 답한다. 사서는 스티커를 읽지 않는다. **스티커의 의미는 우리끼리만 아는 규칙**이기 때문이다.

### 1-2. 증상 ② `post.getComments()`에 삭제된 댓글이 딸려온다

전혀 다른 증상처럼 보이는데, 같은 문장에서 나온다.

```java
@Entity
public class Post {
    @Id @GeneratedValue private Long id;

    @OneToMany(mappedBy = "post")
    private List<Comment> comments = new ArrayList<>();
}

@Entity
public class Comment {
    @Id @GeneratedValue private Long id;
    @ManyToOne(fetch = FetchType.LAZY) private Post post;
    private boolean deleted;
}
```

`post.getComments()`를 처음 건드리면 하이버네이트가 컬렉션을 초기화하며 SQL을 날린다.

```sql
-- before — 실제로 나가는 SQL
select c.id, c.content, c.deleted, c.post_id
from   comment c
where  c.post_id = ?
```

**끝이다.** `deleted` 조건은 어디에도 없다. 하이버네이트가 아는 것은 **"`Comment.post` 필드가 `post_id` 컬럼에 매핑돼 있고, 이 부모의 자식은 `post_id`가 이 값인 행들"**뿐이다. `deleted` 컬럼은 **그냥 매핑된 필드 중 하나**이지 특별한 의미가 없다.

**핵심을 한 문장으로**: **JPA는 컬렉션을 채울 때 FK만 보고 자식 행을 전부 가져온다. "이 행은 삭제된 것"이라는 개념은 DB에도 JPA에도 존재하지 않고, 오직 우리 애플리케이션 코드 안에만 있다.**

### 1-3. 두 증상은 한 문장에서 나온다 — 약속을 아는 주체와 모르는 주체

soft delete는 **표준 SQL에도 JPA 명세에도 존재하지 않는 개념**이다. 우리가 한 일은 이것뿐이다.

```text
우리가 실제로 한 일
  1. boolean 컬럼을 하나 만들었다
  2. "이 컬럼이 true 면 없는 셈 치자"고 팀 안에서 약속했다

그 약속을 아는 주체
  O  우리가 직접 쓴 애플리케이션 코드 (where deleted = false 를 붙인 것들)

그 약속을 모르는 주체
  X  DB 엔진        - 유니크 제약, FK, on delete cascade, 집계 함수, 옵티마이저
  X  JPA/하이버네이트 - 연관관계 로딩, findAll, count
  X  그 밖의 전부    - 다른 팀의 배치 잡, 리포팅 쿼리, BI 도구, 운영자의 수동 SQL
```

**이 목록이 이 문항의 전부다.** 유니크 제약이 막는 것도(§1-1), 컬렉션에 삭제된 자식이 딸려오는 것도(§1-2), 뒤에서 볼 통계 숫자가 틀리는 것도 전부 **"약속을 모르는 주체가 자기 일을 정상적으로 했을 뿐"**이라는 하나의 원인에서 나온다.

### 1-4. 그래서 처방도 두 갈래다

처방의 방향은 위 목록에서 기계적으로 따라 나온다. **모르는 주체에게 약속을 알려주면 된다.**

1. **약속을 DB에 알려준다** — 부분 유니크 인덱스(§2-2), 복합 유니크(§2-4), 아카이브 테이블 분리(§2-5), 활성 행 뷰(§3-8).
2. **약속을 ORM에 알려준다** — `@SQLRestriction`/`@SQLDelete`/`@SoftDelete`(§3-2 이하).

**둘 다 필요하다.** ORM에만 알려주면 유니크 제약은 여전히 막히고(제약은 DB가 판정하므로), DB에만 알려주면 컬렉션에 삭제된 자식이 계속 딸려온다(로딩 SQL은 ORM이 만드므로). 그리고 **세 번째 주체(다른 팀의 배치 잡, BI 도구)는 둘 중 어느 것으로도 못 덮는다** — 그 대응이 §3-8과 §2-5다.

---

## 2. 유니크 축 — `NULL`의 성질부터 세우고 해법 넷을 고른다

### 2-1. 전제 지식 — 유니크 제약에서 `NULL`은 서로 같지 않다

이 절이 §2 전체의 토대다. 뒤에 나오는 네 해법 중 셋이 이 성질 위에 서 있고, 그중 하나는 이 성질 때문에 무너진다.

**표준 SQL에서 `NULL`은 "값이 없음"이 아니라 "값을 알 수 없음"이다.** 알 수 없는 값 둘을 비교하면 답도 알 수 없으므로, `NULL = NULL`의 결과는 참도 거짓도 아닌 **`UNKNOWN`**이다.

유니크 제약은 **"두 키가 같다고 판정될 때"** 위반이다. 판정이 `UNKNOWN`이면 "같다고 판정된 것"이 아니므로 위반이 아니다. 그래서 이런 결론이 나온다.

> **`NULL`이 들어간 키는 유니크 제약을 몇 번이든 통과한다.** 유니크 인덱스에 `NULL` 키가 열 개 있어도 서로 충돌하지 않는다.

이것은 **PostgreSQL의 특이 동작이 아니라 표준 SQL의 규정**이고, MySQL도 같다. 실제로 확인하면 이렇다.

```sql
create table t (email varchar(50), deleted_at timestamptz, unique (email, deleted_at));

insert into t values ('a@x.com', null);   -- OK
insert into t values ('a@x.com', null);   -- OK  <- 통과한다. (a@x.com, NULL) = (a@x.com, NULL) 이
                                          --      참이 아니라 UNKNOWN 이기 때문
insert into t values ('a@x.com', '2026-03-01 10:00+09');  -- OK
insert into t values ('a@x.com', '2026-03-01 10:00+09');  -- 실패. 이쪽은 진짜로 같다
```

**PostgreSQL 15부터는 이 기본 동작을 뒤집을 수 있다.** `NULLS NOT DISTINCT` 옵션을 주면 `NULL`끼리를 같은 값으로 보고 중복을 막는다. 기본값은 여전히 `NULLS DISTINCT`(= 표준 동작)다.

```sql
-- PostgreSQL 15+ : NULL 끼리도 중복으로 판정하게 만든다
create unique index uk_t_email_deleted_at on t (email, deleted_at) nulls not distinct;

-- 테이블 제약으로 선언할 때
alter table t add constraint uk_t unique nulls not distinct (email, deleted_at);
```

**이 성질은 자리에 따라 해법이 되기도 하고 구멍이 되기도 한다.** 이 대비가 §2의 뼈대이므로 먼저 표로 못 박아 둔다.

| `NULL`을 쓰는 자리 | 무슨 일이 일어나나 | 결과 |
|---|---|---|
| **인덱스의 조건**으로 쓴다 — `where deleted_at is null` | 삭제 행이 **인덱스에서 통째로 빠진다** | **해법**(§2-2). 활성끼리만 유니크가 걸린다 |
| **키의 구성 요소**로 쓴다 — `unique (email, deleted_at)` | 활성 행끼리 `NULL = NULL`이 `UNKNOWN`이라 **중복 판정이 안 된다** | **구멍**(§2-4). 활성 중복이 뚫린다 |

같은 규칙인데 결과가 정반대다. **`NULL`을 "거르는 조건"으로 쓰면 이득이고, "비교하는 값"으로 쓰면 손해**라고 외워 두면 된다.

### 2-2. 해법 ① 부분 유니크 인덱스 — PostgreSQL의 기본 해법

**PostgreSQL이라면 이 문항은 한 줄로 끝난다.** 그래서 이 저장소 기준으로는 이것이 기본값이고, 나머지 셋은 "이걸 못 쓰는 사정이 있을 때"의 선택지다.

```sql
-- 활성 행에만 유니크를 건다. 삭제된 행은 인덱스에 아예 들어가지 않는다.
create unique index uk_member_email_active
    on member (email)
 where deleted = false;
```

**`where` 절이 붙은 인덱스**를 **부분 인덱스(partial index)**라고 한다. 테이블 전체가 아니라 **조건을 만족하는 행만** 인덱스에 담는다는 뜻에서 "부분"이다. 유니크 인덱스에 이 조건을 걸면 **유니크 판정의 대상 자체가 활성 행으로 좁혀진다.**

`deleted_at`을 쓰는 스키마라면 조건만 바꾸면 된다. 이쪽이 "언제 탈퇴했나"라는 정보를 공짜로 얻으므로 실무에서 더 흔하다.

```sql
create unique index uk_member_email_active
    on member (email)
 where deleted_at is null;                -- NULL 을 "거르는 조건"으로 쓴 자리 (§2-1)
```

#### 정말 되는지 시나리오로 검증한다

같은 이메일로 몇 번을 탈퇴·재가입해도 되는지, 그리고 막아야 할 것은 여전히 막히는지를 끝까지 따라간다. **인덱스에 무엇이 들어 있는지**를 함께 적는 것이 요점이다.

| 순서 | 동작 | 행 상태 | 이 행이 인덱스에 들어가나 | 인덱스 내용 | 결과 |
|---|---|---|---|---|---|
| ① | 가입 | `(1, hong@a.com, false)` | 들어간다 | `{hong@a.com → 1}` | OK |
| ② | 탈퇴 | `(1, hong@a.com, true)` | **빠진다** (조건 불만족) | `{}` | OK |
| ③ | 재가입 | `(2, hong@a.com, false)` | 들어간다 | `{hong@a.com → 2}` | OK |
| ④ | 재탈퇴 | `(2, hong@a.com, true)` | **빠진다** | `{}` | OK |
| ⑤ | 세 번째 가입 | `(3, hong@a.com, false)` | 들어간다 | `{hong@a.com → 3}` | OK |
| ⑥ | **다른 사람이 같은 이메일로 가입 시도** | `(4, hong@a.com, false)` | 들어가려 한다 | `{3, 4}` 충돌 | **차단** |

①~⑤에서 확인할 것은 **몇 번을 반복해도 인덱스에 활성 행이 최대 하나뿐**이라는 사실이다. 삭제 행이 몇 개 쌓이든 인덱스는 그들을 아예 모른다. 그리고 ⑥에서 **원래 지키려던 규칙(같은 이메일 활성 회원은 한 명)은 그대로 지켜진다.** 재가입을 뚫으면서 보호막을 잃지 않는 유일한 해법이 이것이다.

②에서 UPDATE 한 줄이 어떻게 인덱스 항목을 빼는지도 알아 두면 좋다. PostgreSQL의 UPDATE는 새 튜플 버전을 만드는데, 그 새 버전이 부분 인덱스의 조건을 만족하지 않으면 **인덱스에 항목을 만들지 않는다.** 그래서 "인덱스에서 뺀다"는 별도의 작업이 필요 없다.

#### 부가 이득 — 일반 조회 인덱스에도 그대로 쓴다 (가산점 포인트)

부분 인덱스는 유니크 전용 기능이 아니다. soft delete 서비스는 어차피 거의 모든 쿼리에 `deleted = false`가 붙으므로, **일반 인덱스도 활성 행만 담으면 인덱스 크기가 활성 비율만큼 줄고 캐시 적중률이 올라간다.**

```sql
create index idx_member_active_created
    on member (status, created_at)
 where deleted = false;
```

활성 10%, 삭제 90%인 테이블이라면 이 인덱스는 **전체 인덱스의 10분의 1 크기**다. 공유 버퍼에 들어갈 확률이 그만큼 올라간다.

#### 포기하는 것

- **DB 벤더에 묶인다.** MySQL에는 부분 인덱스가 없다(대체 수단은 바로 아래). PostgreSQL↔MySQL 이전 가능성이 있다면 마이그레이션 항목이 하나 늘어난다.
- **제약(constraint)이 아니라 인덱스다.** PostgreSQL에서 `unique` 제약은 유니크 인덱스가 뒷받침하지만, 부분 유니크 인덱스는 **제약으로 승격되지 않는다.** 여기서 세 가지 실무 제약이 따라 나온다.
  - `alter table ... add constraint ... unique (...)` 구문으로는 만들 수 없다. **`create unique index ... where ...`로만** 만든다.
  - **외래 키가 이 인덱스를 참조할 수 없다.** FK의 참조 대상은 기본키이거나 제약으로 선언된 유니크여야 한다. `email`을 다른 테이블에서 FK로 참조하고 있었다면 이 해법을 쓸 수 없다.
  - **`on conflict on constraint <이름>`을 쓸 수 없다.** upsert를 하려면 인덱스 술어를 같이 적어 추론시켜야 한다.

```sql
-- 부분 유니크 인덱스를 대상으로 upsert 하려면 where 절까지 함께 적는다
insert into member (email, deleted)
values ('hong@a.com', false)
on conflict (email) where deleted = false
do update set last_login_at = now();
```

- **로컬·테스트 DB를 운영과 맞춰야 한다.** H2로 테스트하면 이 DDL이 그대로 통하지 않거나 통해도 동작이 다르다. **이 해법을 쓰는 순간 Testcontainers로 실제 PostgreSQL에서 테스트하는 것이 사실상 전제가 된다**(§3-9).

#### MySQL이라면 — 생성 컬럼으로 같은 효과를 낸다

**MySQL에는 부분 인덱스가 없다.** 그래서 같은 아이디어를 다른 방법으로 구현한다. 원리는 "**삭제된 행의 키를 `NULL`로 만들어 유니크 판정에서 빼는 것**"이고, §2-1의 성질을 **이번엔 의도적으로 이용**한다.

```sql
-- MySQL 전용. 생성 컬럼(generated column)에 유니크를 건다
alter table member
  add column email_active varchar(255)
      generated always as (case when deleted then null else email end) stored,
  add unique key uk_member_email_active (email_active);
```

- 활성 행이면 `email_active = email` → **활성끼리는 유니크가 걸린다.**
- 삭제 행이면 `email_active = null` → **`NULL`은 서로 같지 않으므로 몇 개든 공존한다.**

`email` 원본은 그대로 남고, 애플리케이션은 `email_active`의 존재를 몰라도 된다(계산은 DB가 한다). **부분 유니크 인덱스와 사실상 같은 효과**다.

`stored`와 `virtual` 중 어느 쪽이냐는 선택 사항이다. **InnoDB는 `virtual` 생성 컬럼에도 세컨더리 인덱스를 만들 수 있으므로** 저장 공간을 아끼려면 `virtual`을 쓸 수 있고, 값을 실제로 저장해 두는 편이 낫다고 판단하면 `stored`를 쓴다. `stored`는 디스크를 더 쓰는 대신 조회 시 재계산이 없다.

**PostgreSQL에도 생성 컬럼이 있지만 여기서는 쓸 이유가 없다.** 부분 인덱스가 더 직접적이고 원본 컬럼을 그대로 쓰기 때문이다.

#### 마이그레이션 주의점

1. **기존 `unique (email)` 제약을 반드시 제거한다.** 부분 유니크 인덱스를 새로 만들어도 **전체 유니크 제약이 남아 있으면 여전히 막힌다.** "제약을 추가했는데 안 고쳐졌다"는 문의의 대부분이 이것이다.
2. **기존 활성 중복을 먼저 정리한다.** 이미 같은 이메일의 활성 행이 둘 이상이면 **인덱스 생성 자체가 실패**한다. 먼저 파악하고, 비즈니스 규칙에 따라 정리한 뒤에 만든다. **대형 테이블에서는 이 정리가 며칠짜리 작업**이 될 수 있다(같은 이야기가 [복합 유니크 제약과 동시 INSERT](14-unique-constraint-concurrent-insert.md)에 있다).

```sql
select email, count(*)
from   member
where  deleted = false
group  by email
having count(*) > 1;
```

3. **`create unique index concurrently`로 만들어 쓰기 락을 피한다.** 대신 두 가지 제약이 붙는다 — **트랜잭션 블록 안에서 쓸 수 없고**(Flyway 같은 마이그레이션 도구에서는 해당 스크립트를 트랜잭션 밖에서 실행하도록 설정해야 한다), **실패하면 `indisvalid = false`인 무효 인덱스가 남는다.** 무효 인덱스는 조회에 쓰이지 않으면서 쓰기 비용만 먹으므로 **`drop index`로 치우고 재시도**하는 절차까지 준비해 둔다.

```sql
-- 무효 인덱스가 남았는지 확인하는 쿼리
select indexrelid::regclass as index_name
from   pg_index
where  indisvalid = false;
```

4. **제약을 지우는 순간부터 새 인덱스가 걸릴 때까지의 틈**에 중복이 들어올 수 있다. 트래픽이 적은 시간에 하거나, 애플리케이션 레벨 검사를 그동안 유지한다.

### 2-3. 해법 ② 삭제 시 이메일 값을 변형한다 (애플리케이션 층)

가장 먼저 떠오르고, DDL 권한이 없을 때 실제로 가장 많이 쓰이는 방법이다. **탈퇴할 때 `email` 값 자체를 충돌하지 않는 값으로 바꿔버린다.**

```java
// before — 상수 접미사. 같은 사람이 두 번 탈퇴하면 다시 충돌한다.
public void withdraw(Member m) {
    m.setDeleted(true);
    m.setEmail(m.getEmail() + "_deleted");   // 두 번째 탈퇴 → 'hong@a.com_deleted' 중복
}

// after — 충돌할 수 없는 값을 섞는다.
public void withdraw(Member m) {
    m.setDeleted(true);
    m.setDeletedAt(OffsetDateTime.now());
    m.setOriginalEmail(m.getEmail());        // 원본은 별도 컬럼에 보존 (아래 설명)
    m.setEmail("deleted:" + m.getId() + ":" + m.getEmail());
}
```

**접미사를 무엇으로 할 것인가**가 유일한 설계점이다.

| 후보 | 충돌 가능성 | 왜 그런가 |
|---|---|---|
| 고정 문자열(`_deleted`) | **있음** | 두 번째 탈퇴에서 같은 값이 또 만들어진다. 쓰면 안 된다 |
| 랜덤값(UUID) | 사실상 없음 | 128비트 난수라 실질적으로 안 겹친다. 다만 **확률적** 보장이다 |
| **PK(`id`)** | **없음(구조적으로 보장)** | `id`는 정의상 유일하므로 `id`를 섞은 값도 반드시 유일하다 |
| 삭제 시각 | **정밀도에 달림** | 같은 순간에 두 번 일어나면 겹친다. §2-7의 함정 |

**PK를 쓰는 쪽이 랜덤값보다 낫다.** 랜덤값은 "확률적으로 충돌하지 않는다"지만 **PK는 정의상 유일하므로 충돌이 구조적으로 불가능**하고, 값을 보면 어느 행에서 왔는지 바로 읽힌다.

**DDL**: 없다. 제약은 `unique (email)` 그대로 두고 애플리케이션만 바꾼다. 다만 접두사가 붙으므로 **컬럼 길이 여유**를 확인해야 한다(`varchar(255)`에 이메일이 240자면 넘친다).

**마이그레이션 주의점**: 이미 `_deleted` 상수 접미사로 쌓인 데이터가 있다면 **접미사 규칙을 바꾸는 순간 기존 행과 새 행의 형식이 섞인다.** "원본 이메일이 무엇이었는지" 되짚는 로직(예: CS 담당자가 재가입 이력을 찾는 조회)이 **두 형식을 모두 파싱해야** 한다. 그래서 아래가 사실상 필수다.

**포기하는 것 — 이게 이 방법의 진짜 비용이다.** **원본 이메일이 사라진다.** 유니크 제약을 피하려고 **의미 있는 데이터를 훼손**하는 것이므로, 그 데이터를 쓰던 요구를 전부 못 받게 된다.

- "이 사람 예전에 가입한 적 있나요?"(재가입 이력 연결)
- "탈퇴 회원에게 발송한 메일 이력을 이메일로 조회해 주세요"(감사·컴플라이언스)
- "탈퇴를 취소하고 계정을 복구해 주세요"(원본을 못 되돌린다)

**처방은 `original_email` 같은 컬럼을 따로 두고 원본을 그대로 보존하는 것**이다. 그러면 `email`은 "유니크 제약을 만족시키기 위한 슬롯"이 되고, 의미 있는 값은 `original_email`이 갖는다. **이 순간 "왜 굳이 값을 훼손하지?"라는 질문이 자연스럽게 나오고**, 그 답이 나머지 해법들이다 — **값은 그대로 두고 제약 쪽을 바꾸자.**

### 2-4. 해법 ③ 복합 유니크 + 삭제 구분자 (표준 SQL, 어느 DB에서나)

`email` 값을 건드리지 않고 **유니크 키에 컬럼을 하나 더 넣는다.** 표준 SQL 기능만 쓰므로 벤더에 묶이지 않는 것이 장점이다. 방향은 정확한데, **구분자를 무엇으로 두느냐**가 성패를 가른다.

#### boolean으로 하면 왜 안 되는지

```sql
alter table member add constraint uk_member_email_deleted unique (email, deleted);
```

| 순서 | 동작 | 삽입/변경되는 키 | 테이블 상태 | 결과 |
|---|---|---|---|---|
| ① | 가입 | `(hong@a.com, false)` | `(1, hong@a.com, false)` | OK |
| ② | 탈퇴 | `(hong@a.com, true)` | `(1, hong@a.com, true)` | OK |
| ③ | **재가입** | `(hong@a.com, false)` | `(1, …, true)`, `(2, …, false)` | **OK — 해결된 것처럼 보인다** |
| ④ | **재탈퇴** | `(hong@a.com, true)` | ①번 행이 이미 `(hong@a.com, true)` | **다시 충돌** |

**boolean은 값이 두 개뿐이라 슬롯도 두 개뿐**이다. `(email, false)` 하나와 `(email, true)` 하나까지만 공존하고, **삭제된 행이 두 개가 되는 순간 무너진다.** 첫 재가입까지만 통하기 때문에 **QA를 통과하고 운영에서 터지는** 전형적인 유형이다.

**그래서 구분자를 "삭제될 때마다 달라지는 값"으로 바꿔야 한다.** 후보는 둘이다.

#### 후보 (A) 삭제 시각 — `NULL` 구멍이 따라온다

```sql
alter table member add column deleted_at timestamptz;      -- 활성이면 null
alter table member add constraint uk_member_email_deleted_at unique (email, deleted_at);
```

자연스러워 보이지만 여기서 §2-1의 성질이 **구멍 쪽으로** 작동한다. `deleted_at`을 **키의 구성 요소**로 썼기 때문이다.

| 순서 | 동작 | 삽입되는 키 | 판정 근거 | 결과 |
|---|---|---|---|---|
| ① | 홍길동 가입 | `(hong@a.com, NULL)` | — | OK |
| ② | **다른 사람이 같은 이메일로 가입** | `(hong@a.com, NULL)` | `NULL = NULL`이 `UNKNOWN` → 중복 아님 | **통과해버린다** |
| ③ | 홍길동 탈퇴 | `(hong@a.com, 2026-08-10 14:03:11+09)` | — | OK |
| ④ | 재가입 | `(hong@a.com, NULL)` | 위와 같음 | OK |

**②가 이 함정의 전부다.** 재가입을 막던 문제를 풀려다가 **원래 있던 보호막(같은 이메일 활성 회원은 한 명)을 잃었다.** 그리고 이 구멍은 **재가입 실패처럼 CS로 즉시 올라오지 않는다** — 조용히 중복 계정이 쌓이다가, 나중에 `findByEmail`이 단건을 기대하는 코드에서 **예외로 터지거나 엉뚱한 계정에 로그인**되는 식으로 나타난다. **원인과 증상이 멀어서 추적이 어려운 유형**이다.

막는 방법은 세 가지다.

```sql
-- (a) PostgreSQL 15+ : NULLS NOT DISTINCT 로 기본 동작을 뒤집는다
--     활성 행끼리의 (email, NULL) 이 중복으로 판정되어 ② 가 막힌다.
create unique index uk_member_email_deleted_at
    on member (email, deleted_at) nulls not distinct;

-- (b) 센티널 값 : NULL 대신 "삭제 안 됨"을 뜻하는 실제 값을 쓴다
--     순서가 중요하다. 기존 NULL 을 먼저 채우지 않으면 set not null 이 실패한다.
update member set deleted_at = 'epoch' where deleted_at is null;   -- 'epoch' = 1970-01-01 00:00:00+00
alter table member alter column deleted_at set default 'epoch';
alter table member alter column deleted_at set not null;
--     not null 이므로 (email, deleted_at) 이 활성 중복을 정상적으로 막는다.
--     대가: "삭제 안 됨"을 날짜로 표현하게 되어 조회 조건이 deleted_at = 'epoch' 처럼 어색해진다.

-- (c) 삭제 순번 정수로 갈아탄다  → 아래 (B)
```

**(a)는 깔끔하지만 §2-7의 시간 정밀도 문제는 그대로 남는다.** 활성 중복은 막아도, **같은 마이크로초에 두 번 탈퇴가 일어나면 삭제 행끼리 충돌**한다. 두 문제는 별개라는 것을 알고 골라야 한다.

#### 후보 (B) 삭제 순번 정수 — 권장

```sql
alter table member add column deleted_seq bigint not null default 0;
alter table member add constraint uk_member_email_deleted_seq unique (email, deleted_seq);
```

**(B)를 권장하는 이유**는 `not null`이라 `NULL` 함정이 원천적으로 없고, 값을 **`id`로 채우면 채번 경쟁조차 없기 때문**이다.

```java
// 삭제 순번을 자기 PK 로 채운다 — id 는 유일하므로 (email, deleted_seq) 도 반드시 유일하다.
// "max(deleted_seq) + 1" 같은 채번은 동시 탈퇴에서 같은 값을 두 번 뽑을 수 있으므로 쓰지 않는다.
public void withdraw(Member m) {
    m.setDeletedSeq(m.getId());
    m.setDeletedAt(OffsetDateTime.now());   // 시각은 "언제 지웠나"라는 정보로만 쓴다
}
```

여기서 **역할을 분리한 것이 핵심**이다. `deleted_at`은 **정보**(언제 탈퇴했나 — 보존 기간 계산·통계에 쓴다), `deleted_seq`는 **제약 만족용 슬롯**이다. 하나의 컬럼에 두 역할을 겸하게 하면 (A)의 사고가 난다.

#### 마이그레이션 주의점

1. **기존 `unique (email)` 제약을 반드시 제거한다.** 복합 유니크를 새로 추가해도 **단일 유니크가 남아 있으면 여전히 막힌다.**
2. **제약을 지우는 순간부터 새 제약이 걸리기 전까지의 틈**에 중복이 들어올 수 있다. 한 마이그레이션 안에서 `drop` + `add`를 함께 수행한다.
3. **기존 삭제 행의 `deleted_seq`를 먼저 채운다.** 전부 기본값 `0`이면 삭제된 동일 이메일 행들끼리 충돌해 **제약 생성 자체가 실패**한다. `update member set deleted_seq = id where deleted = true;`를 먼저 돌린다.
4. 대형 테이블에서 제약 추가는 인덱스를 새로 만드는 작업이다. PostgreSQL이라면 **`create unique index concurrently`로 인덱스를 먼저 만들고 `alter table ... add constraint ... unique using index`로 승격**하면 락 시간을 줄일 수 있다.

**얻는 것**: 이메일 원본이 그대로 남는다(감사·복구·이력 연결 전부 가능). 표준 SQL만 쓰므로 어느 DB에서나 같다.

**포기하는 것**: 유니크 키가 넓어지고(인덱스 크기·쓰기 비용 증가), **스키마에 "삭제"라는 도메인 개념이 새어 들어온다.** 그리고 **활성 중복을 막는 책임이 `deleted_seq = 0` 규약에 달려 있다** — 누군가 활성 행에 `0`이 아닌 값을 넣는 순간 같은 이메일 활성 회원이 두 명 생긴다. **규약이 제약을 대신하는 지점이 생겼다**는 뜻이고, 부분 유니크 인덱스(§2-2)는 이 규약이 아예 필요 없다는 점에서 한 단계 위다.

### 2-5. 해법 ④ 아카이브 테이블 분리 — 문제 자체를 없앤다

여기까지의 세 해법은 **"삭제된 행이 같은 테이블에 남아 있다"는 전제**를 유지한 채 그 부작용을 막는다. 네 번째는 **전제를 버린다** — 삭제된 행을 **별도 테이블로 옮기고 원본 테이블에서는 진짜로 지운다.**

```sql
create table member_archive (
  archive_seq bigint       generated always as identity primary key,
                                              -- 원본 id 를 PK 로 두면 재탈퇴 시 충돌하므로 별도 PK
  id          bigint       not null,          -- 원본 id 는 값으로만 보존
  email       varchar(255) not null,          -- 유니크를 걸지 않는다
  archived_at timestamptz  not null default now()
  -- 나머지 컬럼은 member 와 동일
);

create index idx_archive_email on member_archive (email);   -- 이력 조회용 일반 인덱스
create index idx_archive_id    on member_archive (id);
```

```java
@Transactional
public void withdraw(Long memberId) {
    memberArchiveJdbc.copyFrom(memberId);   // insert into member_archive select ... from member where id = ?
    memberRepository.deleteById(memberId);  // 진짜 DELETE
}
```

**이 순간 사라지는 문제들**을 세어 보면 이 해법의 값어치가 보인다.

- **유니크 제약** — `member`에는 활성 행만 있으므로 `unique (email)`을 **그대로 두면 된다.** 재가입은 그냥 된다.
- **연관관계 조회** — `post.getComments()`가 삭제된 댓글을 가져올 수 없다. **없으니까.** `@SQLRestriction`도 필요 없다.
- **인덱스** — 모든 인덱스가 활성 데이터만큼만 커진다. 부분 인덱스도 `deleted` 선두 컬럼도 필요 없다.
- **집계** — `count(*)`가 그냥 맞다. **조건 하나 빠뜨려 숫자가 틀리는 사고가 원천적으로 불가능**해진다.
- **FK 무결성** — DB의 외래 키와 `on delete` 동작이 **다시 정상적으로 의미를 갖는다**(§3-8).

**포기하는 것 (반드시 같이 말할 것)**:

- **이력 조회가 두 테이블을 봐야 한다.** "전체 기간 주문 이력"처럼 활성·삭제를 함께 봐야 하는 화면은 `union all`이 되고, 그러면 **정렬·페이징이 두 테이블에 걸쳐 일어나 비용이 커진다.** 인덱스로 정렬 순서를 만들어 주기도 어렵다.
- **복구가 절차가 된다.** soft delete는 `deleted = false` 한 줄이면 복구지만, 아카이브는 **행을 되돌려 넣어야 하고 그 사이 같은 이메일로 다른 사람이 가입했으면 복구가 실패**한다. 이 실패는 사실 **정상**이지만(중복을 막은 것이다) 운영 절차로 정의돼 있어야 한다.
- **스키마가 두 벌이 된다.** 컬럼을 추가하는 마이그레이션마다 **아카이브 테이블도 같이 바꿔야 하고**, 안 바꾸면 복사 SQL이 조용히 깨진다. 그래서 아카이브를 **컬럼 미러링 대신 `jsonb` 스냅샷 한 컬럼**으로 두는 선택지도 있다 — 스키마 동기화 부담은 사라지고 이력 조회 편의는 줄어든다.
- **자식 데이터를 어떻게 할지 결정해야 한다.** 회원만 옮기고 주문을 남기면 **FK가 가리키는 부모가 없어져 DELETE 자체가 거부된다.** 자식도 함께 옮기거나, 자식의 FK를 끊고 비식별 처리하는 정책이 필요하다.

**언제 이 선을 넘는가**는 §4의 시니어 변별 꼬리질문에서 다룬다.

### 2-6. 네 해법 대칭 비교와 선택 기준

| 해법 | 얻는 것 | 포기하는 것 | 쓸 수 있는 DB | 손대는 층 |
|---|---|---|---|---|
| ① 부분 유니크 인덱스 | **코드가 깨끗**, 모든 진입 경로를 덮음, 활성 중복도 정확히 차단, 조회 인덱스에도 재사용 | **DB 벤더 종속**, 제약이 아니라 인덱스(FK 참조·`on conflict on constraint` 불가), 테스트 DB를 운영과 맞춰야 함 | **PostgreSQL** (MySQL은 생성 컬럼으로 대체) | 스키마 |
| ② 이메일 변형 | DDL 변경 없음, 즉시 적용 | **원본 이메일 소실**(이력·감사·복구), 컬럼 길이, 규칙 파싱 부담 | 전부 | 애플리케이션 |
| ③ 복합 유니크 + 삭제 순번 | 원본 보존, 표준 SQL만 사용 | 인덱스 확장, **`활성 = 0` 규약에 정합성이 의존**, `deleted_at`으로 하면 `NULL` 구멍 | 전부 | 스키마 + 약간의 코드 |
| ④ 아카이브 분리 | **유니크·조회·인덱스·집계·FK 문제가 동시에 소멸** | `union` 이력 조회, 복구 절차, 스키마 이중 관리, 자식 처리 정책 | 전부 | 아키텍처 |

**선택 기준을 한 문장씩으로 정리하면 이렇다.**

- **PostgreSQL이고 삭제 데이터를 계속 조회해야 한다** → **① 부분 유니크 인덱스.** 이 저장소의 기본값이고, 고민할 이유가 없다.
- **MySQL이다** → **①의 생성 컬럼 변형**이 가장 깨끗하고, 팀이 생성 컬럼에 익숙하지 않다면 **③ 복합 유니크 + 삭제 순번**이 무난하다.
- **DDL 권한이 없거나 지금 당장 CS를 막아야 한다** → **② 이메일 변형**으로 급한 불을 끄되 **`original_email` 보존을 반드시 함께** 넣는다. 그리고 이건 임시방편임을 기록에 남긴다.
- **삭제 데이터가 활성 데이터보다 빠르게 쌓이거나, 삭제 데이터를 실질적으로 조회하지 않는다** → **④ 아카이브 분리.**

**면접에서 인과를 정확히 말하는 것이 중요하다.** ②·③이 "우회로"인 이유는 그것들이 열등한 발상이라서가 아니라 **부분 유니크 인덱스를 쓸 수 없는 사정이 있기 때문**이다. "MySQL이라 부분 인덱스를 못 써서 복합 유니크로 갑니다"라고 말하면 **벤더 차이를 알고 선택한 사람**이 되고, 그냥 "복합 유니크로 합니다"라고 하면 **아는 방법이 그것뿐인 사람**이 된다. 같은 결론인데 평가가 갈리는 자리다.

**그리고 어느 쪽을 고르든 유니크 제약 자체는 절대 빼지 않는다.** "애플리케이션에서 중복 검사를 하니까 제약은 없어도 된다"는 판단이 왜 틀리는지는 [복합 유니크 제약과 동시 INSERT](14-unique-constraint-concurrent-insert.md)에서 다룬 그대로다 — **배치 잡·수동 SQL·마이그레이션처럼 검사 코드를 안 거치는 경로가 반드시 존재**하고, 그걸 덮는 것은 DB 제약뿐이다.

### 2-7. 유니크 키에 시간을 넣으면 정합성이 확률이 된다

§2-4 (A)에서 `deleted_at`을 유니크 키에 넣었다. `NULL` 구멍을 막았다 해도 문제가 하나 더 남는다. **정합성이 시간 정밀도에 의존하게 된다는 것**이다.

`timestamp(0)`(초 단위)이라면 이런 일이 가능하다.

```text
14:03:11.120   회원 A 탈퇴 -> (hong@a.com, '2026-08-10 14:03:11')
14:03:11.480   재가입 후 다시 탈퇴가 즉시 일어난다
               (더블클릭, 클라이언트 재시도, 자동화 스크립트, 배치 일괄 처리)
               -> (hong@a.com, '2026-08-10 14:03:11')   <- 같은 키. 중복 오류
```

**정합성 규칙이 "사용자가 1초 안에 같은 동작을 두 번 하지 않는다"는 가정 위에 서 있다는 뜻**이고, 그 가정은 더블클릭·재시도·배치에서 그냥 깨진다. PostgreSQL의 `timestamptz` 기본 정밀도는 마이크로초라 확률은 크게 줄지만, **"확률적으로 안전"이라는 성질 자체는 변하지 않는다.** 배치가 같은 트랜잭션에서 여러 행을 지우면 `now()`가 트랜잭션 시작 시각으로 고정되어 **여러 행이 정확히 같은 값을 갖는다** — 확률이 아니라 확정적으로 충돌한다.

**여기서 얻을 일반화된 교훈이 이 문항의 핵심 중 하나다.**

> **유니크 키의 구성 요소로 "시간"을 쓰면 정합성이 확률에 의존한다.** 정합성은 확률이 아니라 **구조**로 보장해야 한다 — **PK, 시퀀스, UUID**처럼 **유일성이 정의상 보장되는 값**을 쓴다. 시각은 **정보로만** 남긴다.

그리고 이 원칙은 §2-4에서 `deleted_at`(정보)과 `deleted_seq`(제약 슬롯)의 **역할을 분리한 이유**와 정확히 같다. 부분 유니크 인덱스(§2-2)가 이 문제도 겪지 않는 이유 역시 같은 자리에서 설명된다 — **삭제 행은 애초에 인덱스에 없으므로 그들끼리 비교될 일이 없다.**

---

## 3. 연관 축과 나머지 청구서 — `@SQLRestriction`의 대가는 "끌 수 없다"

### 3-1. 흔한 오답 — 자바에서 걸러내기

§1-2에서 삭제된 댓글이 딸려오는 것을 봤다. 가장 먼저 떠오르는 처방은 자바에서 거르는 것인데, 이게 왜 처방이 아닌지부터 정리한다.

```java
// before — 화면은 맞아지지만 비용은 그대로다
List<Comment> visible = post.getComments().stream()
        .filter(c -> !c.isDeleted())
        .toList();
```

삭제 댓글이 90%인 게시글이라면 **10배의 행을 읽어 네트워크로 전송하고 엔티티로 만든 뒤 버린다.** 게다가 **삭제된 댓글까지 영속성 컨텍스트에 올라가** 메모리와 flush 시 변경 감지 비용을 함께 먹는다([영속성 컨텍스트와 변경 감지](02-persistence-context-dirty-checking.md)).

**조건은 DB로 내려가야 의미가 있다.** 그래야 읽는 행 수 자체가 줄어든다.

### 3-2. 도구 — `@SQLRestriction` + `@SQLDelete` 세트

```java
@Entity
@SQLRestriction("deleted = false")                                       // 조회에 조건을 자동으로 덧붙인다
@SQLDelete(sql = "update comment set deleted = true where id = ?")       // delete 를 UPDATE 로 바꾼다
public class Comment {
    @Id @GeneratedValue private Long id;
    @ManyToOne(fetch = FetchType.LAZY) private Post post;
    private boolean deleted;
}
```

**`@SQLRestriction("deleted = false")`** — 이 엔티티를 읽는 **모든 SQL의 `where`에 조건을 자동으로 끼워 넣는다.** 하이버네이트 6.3에서 추가됐고, 그 전에는 **`@Where(clause = "...")`**라는 이름이었다. `@Where`는 6.3부터 폐기 대상(`@Deprecated(since = "6.3")`)이므로 신규 코드에는 `@SQLRestriction`을 쓴다. 값은 **네이티브 SQL 조각**이라 JPQL이 아니라 컬럼 이름으로 쓴다는 점에 주의한다.

**`@SQLDelete`** — `entityManager.remove(comment)`나 `repository.delete(comment)`가 만들어내는 **DELETE 문을 우리가 지정한 SQL로 바꿔치기한다.** 그래서 "삭제 API를 호출하면 자동으로 soft delete"가 된다.

`@SQLDelete`에는 **문서에 명시된 파라미터 규칙**이 있고, 이걸 모르면 조용히 깨진다. 애노테이션 문서의 문장은 이렇다 — "주어진 SQL 문은 하이버네이트가 기대하는 개수의 `?` 파라미터를 **하이버네이트가 기대하는 정확한 순서로** 가져야 한다. 엔티티가 버전 관리된다면 **기본키 컬럼이 버전 컬럼보다 먼저** 온다."

```java
// @Version 이 있는 엔티티라면 물음표가 두 개여야 한다. PK 먼저, 그다음 버전.
@Entity
@SQLDelete(sql = "update comment set deleted = true where id = ? and version = ?")
public class Comment {
    @Id @GeneratedValue private Long id;
    @Version private Long version;
    ...
}
```

물음표 개수를 틀리면 바인딩이 어긋나 **엉뚱한 행을 지우거나 아무 행도 안 지운다.** 후자는 하이버네이트가 영향 행 수를 확인해 `StaleStateException`으로 알려주지만, 전자는 조용하다.

**두 개가 세트인 이유**는 명확하다. `@SQLDelete`만 있으면 **지워지긴 하는데 조회에 계속 나오고**, `@SQLRestriction`만 있으면 **조회에선 사라지는데 `delete`는 진짜로 행을 지운다.** 둘이 짝을 이뤄야 "삭제된 것처럼 보이고, 삭제된 것처럼 동작한다"가 완성된다.

이제 나가는 SQL이 이렇게 바뀐다.

```sql
-- after — 컬렉션 초기화
select c.id, c.content, c.deleted, c.post_id
from   comment c
where  (c.deleted = false)          -- @SQLRestriction 이 끼워 넣은 조건
  and  c.post_id = ?

-- after — repository.delete(comment)
update comment set deleted = true where id = ?      -- DELETE 대신 이게 나간다
```

### 3-3. 어디에 붙이느냐가 적용 범위를 정한다

`@SQLRestriction`은 **클래스에도 컬렉션 필드에도** 붙일 수 있고, 그 선택이 곧 적용 범위다. 여기서 고르는 것이 §3-6의 "끌 수 없다" 문제의 크기를 절반쯤 결정한다.

**클래스에 붙이면** 하이버네이트가 그 엔티티를 위해 만드는 SQL **전부**에 조건이 붙는다 — 컬렉션 초기화, `findById`, `findAll`, JPQL, QueryDSL, fetch join, `count`. 시스템 어디에서도 그 엔티티를 볼 수 없게 된다.

**컬렉션 필드에 붙이면** 그 컬렉션을 로딩할 때만 붙는다.

```java
@Entity
public class Post {
    @OneToMany(mappedBy = "post")
    @SQLRestriction("deleted = false")     // 이 컬렉션을 로딩할 때만 조건이 붙는다
    private List<Comment> comments = new ArrayList<>();
}
```

이러면 **`post.getComments()`는 살아 있는 댓글만** 담고, `commentRepository.findAll()`이나 관리자용 조회는 **삭제된 것까지 정상적으로 본다.** "부모를 통해 볼 때만 감춘다"는 요구에 정확히 맞고, **§3-6의 문제도 절반은 피해 간다.**

어느 쪽에 붙일지는 이 질문으로 정한다 — **"이 엔티티는 시스템 전체에서 안 보여야 하는가, 아니면 이 경로에서만 안 보여야 하는가."** 회원의 개인정보처럼 어디서도 새면 안 되는 것이면 클래스, 화면 표시 규칙에 가까우면 컬렉션 필드다.

### 3-4. 하이버네이트 6.4의 `@SoftDelete` — 세트를 하나로 묶은 것

```java
@Entity
@SoftDelete(columnName = "deleted")
public class Comment { … }
```

**`@SQLRestriction` + `@SQLDelete`가 하던 일을 애노테이션 하나로 선언한다.** 삭제를 UPDATE로 바꾸고, 조회에 조건을 자동으로 붙인다. SQL 문자열을 직접 쓰지 않으므로 **오타·테이블명 변경·`@Version` 파라미터 순서 같은 실수에 덜 취약**하다는 것이 실질적 이점이다.

옵션은 셋이다.

- **`columnName`** — 컬럼 이름. 생략하면 전략에 따른 기본값이 쓰인다.
- **`strategy`** — 컬럼의 의미가 "삭제됨 표시"인지 "활성 표시"인지 고른다. `SoftDeleteType.DELETED`(기본값, 기본 컬럼명 `deleted`)는 `true`가 삭제, `SoftDeleteType.ACTIVE`(기본 컬럼명 `active`)는 `true`가 활성이다.
- **`converter`** — boolean이 아닌 형태로 저장하고 싶을 때 쓰는 `AttributeConverter`. 예를 들어 `'Y'`/`'N'` 문자로 저장하는 레거시 스키마에 붙일 수 있다.

**붙일 수 있는 위치에 제약이 있다는 점을 알아야 한다.** 클래스에 붙일 때는 **상속 계층의 루트에 붙여야 하고 계층 전체에 적용**되며, 소프트 삭제 컬럼은 루트 테이블에 있다고 가정한다. 필드에 붙이는 것은 **`@ElementCollection`이나 `@ManyToMany`의 조인 테이블 행**에 대한 것이지, **`@OneToMany` 컬렉션에는 쓸 수 없다.** 즉 **§3-3에서 본 "컬렉션 필드에만 걸어 범위를 좁히는" 기법은 `@SoftDelete`로는 안 된다.** 그 기법이 필요하면 `@SQLRestriction`을 써야 한다.

그리고 이 애노테이션은 **`@Incubating`**으로 표시돼 있다. 하이버네이트가 "아직 API가 바뀔 수 있다"고 선언한 것이므로, 마이너 버전을 올릴 때 확인이 필요하다.

**대가는 똑같다.** 전역으로 붙는 조건이라는 성질은 그대로이고, 다음 절의 "끌 수 없다" 문제도 그대로 상속한다. **도구가 세련되어졌을 뿐 트레이드오프의 구조는 변하지 않았다.**

### 3-5. 조건이 개입하지 못하는 경로 (실무에서 반드시 만난다)

`@SQLRestriction`은 **"하이버네이트가 만드는 SQL에 문자열을 덧붙이는" 기능**이다. 그러니 **SQL이 안 나가거나, 하이버네이트가 안 만든 SQL**에는 개입할 수 없다. 이 목록을 외워 두면 사고의 절반은 예방된다.

- **네이티브 쿼리** — 우리가 쓴 SQL이 그대로 나간다. 조건은 직접 써야 한다. (§3-7에서는 이게 오히려 **탈출구**로 쓰인다.)
- **이미 영속성 컨텍스트에 올라온 인스턴스** — SQL이 안 나가므로 조건도 개입하지 않는다. 같은 트랜잭션에서 방금 soft delete한 엔티티를 다시 `findById`하면 **1차 캐시에서 그대로 돌아온다.**
- **JPQL/네이티브 벌크 연산** — `@Modifying` JPQL `delete`나 `deleteAllInBatch`는 **`@SQLDelete`를 거치지 않고 진짜 DELETE를 날린다**(§4 꼬리질문). 영속성 컨텍스트를 우회한다는 성질과 같은 뿌리다([벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md)).
- **DB가 스스로 하는 동작** — `on delete cascade`, 트리거, 다른 팀의 배치 잡. 애초에 애플리케이션 밖이다.

**그리고 가장 자주 사고를 내는 경로 하나 (가산점 포인트)**: **`@ManyToOne` 쪽 부모가 soft delete된 경우**다.

```java
@Entity
@SQLRestriction("deleted = false")
public class Post { … }        // 게시글도 soft delete 라고 하자

// 삭제된 게시글에 달린 댓글을 가져와 comment.getPost().getTitle() 을 호출하면?
//   프록시 초기화 SQL:  select ... from post where (deleted = false) and id = ?
//   행이 없다 -> EntityNotFoundException
```

FK는 살아 있는데 **조건 때문에 그 행을 못 읽는** 상황이다. **DB 관점에서는 참조 무결성이 멀쩡한데 애플리케이션 관점에서는 부모가 없는** 모순이 생긴 것이고, 이는 §3-8에서 다룰 "soft delete가 FK 무결성을 무의미하게 만든다"의 구체적 얼굴이다. **부모를 soft delete할 때 자식을 어떻게 할지 정책이 없으면 반드시 만난다.**

### 3-6. 대가 — 끌 수 없다, 그리고 `@JsonIgnore`와 같은 구조

**이 절이 이 문항에서 상·중을 가른다.** 도구 이름을 아는 것은 검색으로 5분이면 되지만, **그 도구가 무엇을 못 하는지**는 겪어야 안다.

#### 관리자 화면을 만드는 순간 막힌다

```java
@Entity
@SQLRestriction("deleted = false")
public class Member { … }
```

이 상태에서 **"탈퇴 회원 목록을 보여주세요"**라는 요구가 들어온다. 흔한 요구다 — CS팀이 재가입 이력을 확인해야 하고, 데이터 복구 요청이 들어오고, 월간 탈퇴율을 봐야 한다. 그런데 손에 든 조회 수단이 전부 막혀 있다.

```java
memberRepository.findAll();                    // 활성 회원만. 탈퇴 회원은 절대 안 나온다.
memberRepository.findByDeletedTrue();          // where (deleted = false) and deleted = true → 항상 0건
memberRepository.findById(withdrawnId);        // Optional.empty()
queryFactory.selectFrom(member).fetch();       // 역시 활성만
em.createQuery("select m from Member m").getResultList();   // 역시 활성만
```

**애노테이션을 끄는 방법이 없다.** 옵션도, 쿼리 힌트도, "이번 쿼리만 제외" 같은 장치도 없다. 이건 구현상의 누락이 아니라 **설계된 성질**이고, 애노테이션 문서에 직접 적혀 있다 — "`@SQLRestriction`은 **언제나 적용되며 비활성화할 수 없다.** 파라미터를 받을 수도 없다. 그래서 필터보다 훨씬 덜 유연하다."

**그리고 실패하는 방식이 나쁘다.** 예외가 나면 즉시 알아채겠지만, 실제로는 **조용히 빈 결과나 0건**이 돌아온다. 관리자 화면은 "탈퇴 회원이 없나 보다"라고 표시하고, 통계는 **0을 정상값처럼 보여준다.** 코드도 쿼리도 문법적으로 완벽하고 로그에도 아무것도 안 남는다.

#### `@JsonIgnore`와 정확히 같은 성격의 함정이다

중급 Q5에서 "엔티티에 `@JsonIgnore`를 붙이면 되지 않나"에 대한 답이 이랬다 — **`@JsonIgnore`는 필드에 붙는다. 즉 그 엔티티를 직렬화하는 모든 곳에 똑같이 적용되고, API마다 다른 요구(내부 관리자 API는 그 필드가 필요하다)를 표현할 수 없다.**

`@SQLRestriction`은 **똑같은 문장이 조회 층에서 반복된 것**이다.

| | `@JsonIgnore` | `@SQLRestriction` |
|---|---|---|
| 붙는 곳 | 엔티티 필드 | 엔티티 클래스 또는 컬렉션 필드 |
| 적용 범위 | 그 엔티티를 직렬화하는 **모든 곳** | 그 엔티티를 조회하는 **모든 SQL** |
| 경로별 차등 | **불가능** | **불가능** |
| 실패 방식 | 필드가 조용히 빠짐 | 결과가 조용히 비어 있음 |
| 근본 원인 | **엔티티가 "표현 규칙"까지 짊어짐** | **엔티티가 "가시성 규칙"까지 짊어짐** |

**공통 교훈은 이것이다**: **엔티티에 박은 전역 스위치는 편리한 만큼 예외를 만들 수 없다.** 그리고 요구사항은 **거의 항상 예외를 만들어 온다**(관리자 화면, 통계, 데이터 복구, 고객센터 조회). 그러니 전역 스위치를 붙이기 전에 **"이 규칙에 예외가 생길 확률"**을 먼저 따져야 한다.

`@JsonIgnore`는 그 확률이 높아서 DTO로 갔다. `@SQLRestriction`은 확률이 높은데도 여전히 쓰인다 — **대안의 안전 방향이 반대이기 때문**이다(§3-7). 그래서 답은 "쓰지 말자"가 아니라 **"쓰되 탈출구를 미리 설계해 두자"**가 된다.

### 3-7. 탈출구를 미리 설계한다

**핵심은 "조회 경로를 두 벌로 나누는 것"**이다. 서비스 경로는 `@SQLRestriction`이 걸린 엔티티를 쓰고, **관리자·통계 경로는 애초에 다른 길로 간다.**

```java
// ① 네이티브 쿼리 — 하이버네이트가 만드는 SQL 이 아니므로 조건이 안 붙는다
public interface MemberAdminRepository extends Repository<Member, Long> {

    @Query(value = "select * from member where deleted = true order by deleted_at desc",
           nativeQuery = true)
    List<Member> findWithdrawnMembers();
}

// ② 같은 테이블을 가리키는 "제약 없는" 별도 엔티티 — 관리자 전용
@Entity
@Table(name = "member")          // 같은 테이블, @SQLRestriction 없음
@Immutable                       // 읽기 전용으로 못 박아 쓰기 사고를 차단
public class MemberAdminView { … }

// ③ 조회 전용 DTO 프로젝션 — 관리자 화면은 어차피 표시가 목적이다
//    (엔티티를 안 거치므로 조건도 안 붙고, 필요한 컬럼만 읽는다)
```

**②가 실무에서 가장 자주 보이는 형태**다. "같은 테이블을 두 엔티티가 매핑한다"는 것이 처음엔 이상해 보이지만, **읽는 목적이 다르면 읽는 모델도 다를 수 있다**는 관점에서는 자연스럽다. `@Immutable`을 붙여 **관리자 뷰로는 쓰기를 못 하게** 못 박아 두는 것이 안전하다. 조회 목적이 표시뿐이라면 **③ DTO 프로젝션**이 더 가볍다([조회 전용 DTO 프로젝션](18-dto-projection-for-read-only.md)의 "변경이 목적이면 엔티티, 표시가 목적이면 DTO"가 그대로 적용된다).

#### 그렇다면 `@Filter`는 어떤가

**`@Filter`는 개념적으로 `@SQLRestriction`의 정확한 대안**이다. `@FilterDef`로 이름과 조건을 선언하고 `@Filter`로 엔티티에 붙이는데, **세션 단위로 켜고 끌 수 있다는 점이 결정적으로 다르다.**

```java
@FilterDef(name = "activeOnly", defaultCondition = "deleted = false", autoEnabled = true)
@Filter(name = "activeOnly")
@Entity
public class Member { … }
```

```java
// 관리자 경로에서만 끈다
session.disableFilter("activeOnly");
List<Member> all = memberRepository.findAll();     // 이제 탈퇴 회원도 나온다
```

**`autoEnabled = true`가 핵심이다.** 하이버네이트 문서는 "필터는 `enableFilter`로 명시적으로 켜지거나 `autoEnabled = true`로 선언되지 않으면 아무 효과가 없다"고 적고 있다. 즉 **기본이 꺼짐**이라 예전에는 "요청마다 켜주는 장치를 만들어야 하고 그 장치를 안 타는 경로(배치, 이벤트 핸들러, 테스트)에서는 조용히 전체가 노출된다"는 것이 `@Filter`의 결정적 약점이었다. `autoEnabled`는 **그 기본값을 뒤집어** 이 약점을 없앤다.

**대신 다른 함정이 하나 남는다.** `@FilterDef`에는 `applyToLoadByKey`라는 속성이 있고 **기본값이 `false`**인데, 그 뜻은 이렇다 — **필터는 기본적으로 기본키 조회에는 적용되지 않는다.** 문서가 예로 드는 것이 `@ManyToOne` 연관을 가져올 때와 `find()`를 호출할 때다.

```java
// autoEnabled = true 인 필터가 걸려 있어도
memberRepository.findAll();                 // 필터 적용 -> 활성만
em.find(Member.class, withdrawnId);         // 필터 미적용 -> 탈퇴 회원이 그대로 나온다
comment.getPost();                          // 필터 미적용 -> 삭제된 게시글도 로딩된다
```

`applyToLoadByKey = true`로 켜면 PK 조회에도 적용되지만, 그러면 **`@ManyToOne` 연관이 필터에 걸려 `null`이 될 상황에서 `EntityFilterException`이 던져진다.** 이 예외는 `EntityNotFoundException`의 하위 타입이고, 하이버네이트가 "연관을 조용히 `null`로 바꾸면 데이터 손실이니 차라리 예외로 알린다"고 선택한 결과다. 참고로 이 속성은 `@Incubating`이다.

**정리하면 선택 기준이 이렇게 바뀐다.**

| | `@SQLRestriction` | `@Filter` (`autoEnabled = true`) |
|---|---|---|
| 기본 상태 | 항상 켜짐, 끌 수 없다 | 켜짐, **세션 단위로 끌 수 있다** |
| PK 조회(`find`, `@ManyToOne`) | **적용된다** | **기본은 미적용.** `applyToLoadByKey = true`로 켜야 한다 |
| 파라미터 | 불가 | **가능**(`@ParamDef`로 테넌트 ID 같은 값을 넘길 수 있다) |
| 실패 방향 | **예외를 못 만든다**(관리자 화면이 조용히 0건) | **보호가 빠진 경로가 생긴다**(PK 조회로 삭제 데이터 노출) |

**선택 기준은 어느 쪽 실패가 더 비싼가**다. 개인정보처럼 **노출 대가가 큰 도메인**이면 PK 조회 구멍이 없는 `@SQLRestriction`이 안전하고, **관리 편의와 조건 파라미터화가 중요하면** `@Filter`가 맞다.

**면접에서 한 문장으로 말한다면**: "**`@SQLRestriction`을 쓰겠습니다. 대신 이건 끌 수 없는 전역 조건이라 관리자·통계 경로는 처음부터 네이티브 쿼리나 별도 조회 모델로 분리해 두고, 그 경로가 조용히 빈 결과를 주지 않는지 테스트로 고정합니다.**" — 도구 이름 + 대가 + 대가에 대한 대비까지 **한 호흡**에 들어 있다.

### 3-8. 나머지 청구서 — 인덱스·집계·참조 무결성·개인정보

질문은 유니크와 연관관계 두 가지를 물었지만, **"안 지우기로 한 결정"의 청구서는 최소 네 곳에서 더 온다.** 나머지를 말할 수 있으면 **"대가를 설계에 반영해 봤는지"**라는 출제 의도를 정면으로 맞힌다.

#### ① 인덱스 — 삭제 행까지 떠안는다

soft delete를 켠 순간 **거의 모든 조회에 `deleted = false`가 붙는다.** 그런데 기존 인덱스는 그 컬럼을 모른다.

```sql
-- before
create index idx_member_status_created on member (status, created_at);

-- 실제로 나가는 쿼리
select * from member
where  deleted = false and status = 'ACTIVE'
order  by created_at desc
limit  20;
```

이때 PostgreSQL의 실행 계획에는 이런 줄이 나온다.

```text
Index Scan using idx_member_status_created on member
  Index Cond: (status = 'ACTIVE')
  Filter: (deleted = false)
  Rows Removed by Filter: 18432        <- 인덱스로 찾아온 행 대부분을 버렸다는 뜻
```

**`Rows Removed by Filter`가 크다는 것은 "인덱스로 찾았는데 대부분 버렸다"**는 신호다. 삭제 비율이 높을수록 이 낭비가 커진다.

**PostgreSQL의 답은 부분 인덱스다**(§2-2). 인덱스 자체가 활성 행만 담으므로 조건이 인덱스에 흡수되고, 인덱스 크기도 줄어든다.

```sql
-- after (PostgreSQL)
create index idx_member_status_created_active
    on member (status, created_at) where deleted = false;
```

**부분 인덱스를 못 쓰는 DB(MySQL 등)라면 복합 인덱스 선두에 `deleted`를 넣는다.**

```sql
-- after (MySQL 등)
create index idx_member_deleted_status_created on member (deleted, status, created_at);
```

**"카디널리티가 낮은 컬럼을 선두에 두면 안 된다"는 통념과 충돌해 보이지만, 이 경우엔 선두가 맞다.** 복합 인덱스는 **등치(`=`) 조건 컬럼들이 앞에 오고 그 뒤에 범위·정렬 컬럼이 와야** 끝까지 활용된다. `deleted = false`는 **항상 붙는 등치 조건**이므로 선두 자리가 정확하다. 값이 두 개뿐이라 선택도가 낮은 것은 사실이지만, 뒤따르는 `status`·`created_at`이 선택도를 채워준다.

**그리고 이건 일회성 작업이 아니다.** soft delete를 켠 뒤에 추가되는 **모든 인덱스가 이 규칙을 따라야 한다.** 규칙이 사람의 기억에 의존하는 순간 언젠가 빠지므로, **마이그레이션 리뷰 체크리스트에 항목으로 박아두는 것**이 실질적인 처방이다(§3-9).

**PostgreSQL 사용자가 특히 혼동하는 지점 하나**: 삭제 행이 쌓여도 **VACUUM은 아무것도 회수하지 못한다.** VACUUM이 정리하는 것은 UPDATE·DELETE로 생긴 **죽은 튜플(dead tuple)**인데, soft delete된 행은 **살아 있는 튜플**이기 때문이다. "테이블이 큰데 VACUUM을 돌려도 안 줄어든다"는 상황의 흔한 원인이 이것이다. **줄이려면 진짜로 지우거나 아카이브로 옮기는 수밖에 없다.**

#### ② 집계 — 조건 하나가 빠지면 숫자가 조용히 틀린다

```sql
-- 잘못된 "가입자 수" — 탈퇴자까지 센다
select count(*) from member;

-- 잘못된 "이번 달 매출" — 취소(soft delete)된 주문까지 더한다
select sum(amount) from orders where created_at >= '2026-08-01';
```

**이 실패가 특히 나쁜 이유는 예외가 안 나기 때문**이다. 쿼리는 성공하고, 숫자가 나오고, 대시보드에 표시된다. **틀렸다는 사실을 아무도 모른다.** 그리고 집계 쿼리는 **BI 도구·리포팅 스크립트·다른 팀의 애드혹 쿼리**처럼 우리 애플리케이션 밖에서 작성되는 경우가 많아 **`@SQLRestriction`의 보호 범위 밖**이다(§1-3의 "약속을 모르는 주체" 세 번째 줄).

**처방 두 가지**:

- **활성 행만 담은 뷰를 만들어 그것을 표준 조회 대상으로 공표한다.** 다른 팀에게는 **테이블이 아니라 뷰를 알려준다.** 조건을 "기억해야 하는 규칙"에서 "기본으로 제공되는 대상"으로 바꾸는 것이 요점이다.

```sql
create view member_active as select * from member where deleted = false;
```

- **아카이브 분리(§2-5)** — 이 문제를 통째로 없앤다. 이것이 규모가 커질 때 아카이브가 정답 후보가 되는 큰 이유 중 하나다.

성능 측면도 하나 있다. **PostgreSQL의 `count(*)`는 조건에 맞는 행을 실제로 다 세므로**, 삭제 행 비율이 높을수록 비싸진다. 부분 인덱스를 만들어 두면 인덱스 온리 스캔으로 줄일 여지가 생기지만, **비저빌리티 맵이 최신이어야(최근에 VACUUM이 돌았어야) 효과가 난다.**

#### ③ 참조 무결성 — DB의 FK가 의미를 잃는다

FK는 **행이 실제로 지워질 때** 동작한다. soft delete는 행을 지우지 않으므로 **FK도, `on delete cascade`도, `on delete restrict`도 아무 일을 하지 않는다.**

```text
회원 탈퇴 (soft delete)
  -> DB:        "member 행은 그대로 있다. 참조 무결성 완벽."
  -> 애플리케이션: "삭제된 회원인데 주문이 살아 있고, 그 주문이 배송으로 넘어간다."
```

**"부모가 삭제되면 자식은 어떻게 되는가"를 DB가 더 이상 답해주지 않는다.** 그 책임이 전부 애플리케이션으로 넘어왔고, **경로마다 빠뜨릴 수 있다.** §3-5에서 본 `EntityNotFoundException`이 그 구체적 얼굴이다.

**그래서 정책을 명시적으로 정해야 한다** — 부모를 soft delete할 때 ① 자식도 함께 soft delete할 것인가 ② 자식은 남기되 부모 참조를 끊을 것인가 ③ 살아 있는 자식이 있으면 삭제를 거부할 것인가. **`CascadeType.REMOVE`는 이 일을 자동으로 해주지 않는다** — 자세한 조건은 §4 꼬리질문에서 갈라 본다.

#### ④ 데이터 누적과 개인정보

삭제 데이터는 **영원히 쌓인다.** 테이블·인덱스가 커지고, 백업이 커지고, 통계 갱신이 느려진다. 그리고 개인정보라면 **"파기해야 하는데 파기하지 않은 상태"**가 된다 — 이건 성능 문제가 아니라 **컴플라이언스 문제**이고, 우선순위가 다르다(§4 꼬리질문).

**그래서 soft delete를 도입할 때 "언제까지 보관하는가"를 함께 정해야 한다.** 보관 기간이 정해지면 자연스럽게 **주기적으로 오래된 삭제 행을 진짜로 지우거나 아카이브로 옮기는 배치**가 필요해지고, 그건 §2-5로 가는 길이기도 하다.

### 3-9. 안전망 — 테스트와 체크리스트로 고정한다

이 문항의 사고들은 **전부 "조용히" 일어난다.** 재가입 실패는 CS로 올라오기라도 하지만, 관리자 화면의 빈 결과·틀린 집계·인덱스 누락은 **아무도 알려주지 않는다.** 그래서 **관측이 아니라 테스트로 고정해야 한다.**

#### 재가입 시나리오는 네 단계여야 한다

**§2-4의 boolean 함정은 "재가입까지만 테스트하면 통과한다."** 그래서 테스트는 반드시 **재탈퇴까지** 가야 한다.

```java
@SpringBootTest
class MemberRejoinTest {

    @Autowired MemberService memberService;

    private static final String EMAIL = "hong@a.com";

    @Test
    void 같은_이메일로_가입_탈퇴_재가입_재탈퇴가_모두_성공한다() {
        Long first  = memberService.join(EMAIL);       // ① 가입
        memberService.withdraw(first);                 // ② 탈퇴
        Long second = memberService.join(EMAIL);       // ③ 재가입  — 단일 UNIQUE 면 여기서 실패
        memberService.withdraw(second);                // ④ 재탈퇴  — boolean 복합 유니크면 여기서 실패

        Long third = memberService.join(EMAIL);        // ⑤ 한 번 더 (규칙이 일반화됐는지 확인)
        assertThat(third).isNotNull();
    }

    @Test
    void 활성_회원은_같은_이메일로_두_명_존재할_수_없다() {          // §2-4 의 NULL 구멍을 잡는 테스트
        memberService.join(EMAIL);
        assertThatThrownBy(() -> memberService.join(EMAIL))
                .isInstanceOf(DataIntegrityViolationException.class);
    }
}
```

**두 번째 테스트가 특히 중요하다.** `deleted_at`을 유니크 키에 넣는 리팩터링이 들어오는 순간 **이 테스트만 깨지고 첫 번째는 통과한다.** 즉 §2-4 (A)의 함정을 **정확히 그 지점에서** 잡아준다.

**주의 (여기서 반복해서 걸리는 함정)**: **테스트 메서드에 `@Transactional`을 붙이면 이 테스트는 무용지물이 된다.** 유니크 위반은 **flush 시점**에 DB가 판정하는데, 한 트랜잭션 안에서 전부 굴리면 flush가 언제 일어나는지에 따라 결과가 달라지고, 롤백 때문에 다음 테스트와의 격리도 어긋난다. **`@Transactional` 없이 실제 커밋되게 하고 뒷정리를 직접** 하거나 `@Commit`을 쓴다. 같은 함정을 [복합 유니크 제약과 동시 INSERT](14-unique-constraint-concurrent-insert.md)와 [flush 시점과 SQL 실행 순서](15-flush-timing-and-sql-ordering.md)에서도 다뤘다.

#### 관리자 경로가 조용히 막히지 않는지 단정한다

**§3-6의 사고는 "예외 없이 0건"으로 나타나므로, 0건이 아님을 단정하는 테스트**가 유일한 방어선이다.

```java
@Test
void 관리자_조회는_탈퇴_회원을_볼_수_있어야_한다() {
    Long id = memberService.join("bye@a.com");
    memberService.withdraw(id);

    // 서비스 경로: 안 보여야 정상
    assertThat(memberRepository.findById(id)).isEmpty();

    // 관리자 경로: 보여야 정상 — @SQLRestriction 이 여기까지 먹으면 0건이 되고 테스트가 잡는다
    List<Member> withdrawn = memberAdminRepository.findWithdrawnMembers();
    assertThat(withdrawn).extracting(Member::getId).contains(id);
}
```

**이 테스트의 진짜 가치는 회귀 방지다.** 나중에 누군가 관리자 리포지토리를 "중복 같으니 통합하자"며 일반 리포지토리로 바꾸거나, 네이티브 쿼리를 JPQL로 "정리"하는 순간 **이 테스트가 실패해서 막아준다.** 주장으로 남겨둔 설계 원칙은 언젠가 지워지고, **테스트로 고정한 원칙만 살아남는다.**

#### 인덱스·스키마 점검을 절차로 만든다

- **마이그레이션 리뷰 체크리스트**에 두 줄을 박는다 — ① **"이 테이블이 soft delete 대상인가? 그렇다면 새 인덱스가 부분 인덱스이거나 선두에 `deleted`가 있는가?"** ② **"유니크 제약을 추가·변경했다면 기존 단일 유니크를 제거했는가?"**
- **`ddl-auto=validate`**로 기동 시 엔티티 매핑과 실제 스키마의 불일치를 잡는다. 다만 **인덱스 구성까지 검증해 주지는 않으므로** 인덱스는 위 체크리스트나 별도 점검 쿼리(`pg_indexes`)로 봐야 한다.
- **느린 쿼리 로그**에 soft delete 테이블이 올라오면 **가장 먼저 `explain (analyze, buffers)`로 `Rows Removed by Filter`를 확인**한다(§3-8).

#### 테스트 DB를 운영 DB와 맞춘다 (Testcontainers)

**이 문항의 해법 대부분은 벤더 의존적이다** — 부분 유니크 인덱스, `nulls not distinct`, 생성 컬럼, `NULL`의 유니크 취급, 그리고 `@SQLRestriction`이 만들어내는 SQL 방언. **H2로 테스트하면 재가입 테스트가 통과해도 운영에서 깨질 수 있다.** soft delete 스키마를 설계했다면 **테스트를 실제 PostgreSQL(Testcontainers)로 돌리는 것이 선택이 아니라 전제**가 된다.

---

## 4. 꼬리질문 대비 포인트

### "`@SQLRestriction`을 붙였는데 관리자 화면에서 삭제된 데이터를 봐야 합니다. 어떻게 하나요?"

**애노테이션을 끌 방법은 없다.** 애노테이션 문서가 "언제나 적용되며 비활성화할 수 없다"고 직접 못 박고 있다. 그래서 **조회 경로를 아예 다른 길로 낸다**(§3-7).

1. **네이티브 쿼리** — 하이버네이트가 만든 SQL이 아니므로 조건이 붙지 않는다. 가장 간단하고 가장 흔하다.
2. **같은 테이블을 매핑한 별도 엔티티**(`@Table(name = "member")` + `@SQLRestriction` 없음 + `@Immutable`) — 관리자 전용 읽기 모델. 쓰기 사고를 막기 위해 반드시 불변으로 못 박는다.
3. **DTO 프로젝션** — 관리자 화면은 표시가 목적이므로 엔티티를 거칠 이유가 애초에 없다.

**그리고 여기서 한 발 더 나가면 좋다 (가산점 포인트)**: 이 상황은 **`@Filter`를 대신 썼다면 `session.disableFilter()`로 끌 수 있었다.** 예전에는 `@Filter`가 기본 꺼짐이라 "켜는 걸 잊는" 실패가 더 무서웠는데, **하이버네이트 6.6 기준으로 `@FilterDef(autoEnabled = true)`가 있어 그 약점은 사라졌다.** 대신 남는 함정은 다른 것이다 — **`applyToLoadByKey`가 기본 `false`라, 필터는 `find()`와 `@ManyToOne` 로딩 같은 PK 조회에는 적용되지 않는다.** 즉 `em.find(Member.class, 탈퇴id)`가 탈퇴 회원을 그대로 돌려준다.

**정리하면 두 도구의 실패 방향이 반대다** — **`@SQLRestriction`은 "예외를 못 만드는" 실패, `@Filter`는 "PK 조회 경로에 보호가 빠지는" 실패.** **개인정보처럼 노출 대가가 큰 도메인이면 전자가, 관리 편의와 조건 파라미터화가 중요하면 후자가 맞다** — 선택 기준은 **어느 쪽 실패가 더 비싼가**다.

### "부모를 soft delete하면 자식은 어떻게 되나요? cascade가 동작하나요?"

**케이스를 나눠서 답해야 한다.**

- **`repository.delete(parent)`를 호출하고 `CascadeType.REMOVE`가 걸려 있다면** — 하이버네이트는 자식 각각에 대해 삭제를 시도하고, 자식에 `@SQLDelete`가 있으면 **DELETE 대신 UPDATE가 나간다.** 즉 **cascade 경로로는 soft delete가 전파된다.**
- **부모를 `parent.setDeleted(true)`로 상태만 바꿨다면** — 이건 그냥 UPDATE 한 줄이다. **cascade는 애초에 발동하지 않는다.** 자식은 전부 살아 있다.

**실무에서 사고가 나는 쪽은 후자**다. `withdraw()` 같은 도메인 메서드는 대부분 상태 변경으로 구현되기 때문이다. 그래서 **부모 삭제 시 자식 정책을 도메인 메서드 안에 명시적으로 써야 한다.**

```java
public void withdraw() {
    this.deleted = true;
    this.deletedSeq = this.id;
    this.comments.forEach(Comment::softDelete);   // 자동으로 되지 않는다. 손으로 쓴다.
}
```

**그리고 DB의 `on delete cascade`는 여기서 완전히 무력하다**(§3-8) — 행이 안 지워지니 발동할 계기 자체가 없다. 자세한 cascade 동작은 [CascadeType.REMOVE와 orphanRemoval](24-cascade-remove-vs-orphan-removal.md).

### "`@SQLDelete`를 걸었는데 어떤 경로에서는 행이 진짜로 지워졌습니다. 왜죠?" (가산점 포인트)

**`@SQLDelete`는 "하이버네이트가 엔티티 하나를 삭제할 때 만드는 DELETE 문"만 바꿔치기한다.** 그 경로를 안 타는 삭제는 전부 진짜 DELETE다.

```java
repository.delete(entity);          // @SQLDelete 적용 -> UPDATE
repository.deleteAll(entities);     // 내부적으로 엔티티 단위 삭제 -> UPDATE

repository.deleteAllInBatch();      // JPQL 벌크 delete -> 진짜 DELETE
@Modifying @Query("delete from Comment c where c.post.id = :id")   // 진짜 DELETE
nativeQuery = "delete from comment where ..."                      // 진짜 DELETE
```

**뿌리는 하나다** — **벌크 연산은 영속성 컨텍스트와 엔티티 이벤트 경로를 통째로 우회해 SQL을 DB로 직행시킨다.** 그래서 `@SQLDelete`뿐 아니라 **JPA Auditing, 엔티티 리스너, 낙관적 락 버전 증가도 함께 빠진다.** "자동으로 되는 것"의 동작 경로를 알아야 **안 되는 경우도 예측할 수 있다**([벌크 연산과 영속성 컨텍스트](11-bulk-operation-persistence-context.md)).

**대응**: 성능 때문에 벌크가 필요하다면 **벌크 UPDATE로 직접 쓴다**(`update Comment c set c.deleted = true where c.post.id = :id`). 즉 "삭제 구문을 쓰되 UPDATE로 바뀌길 기대"하지 말고 **처음부터 UPDATE를 쓴다.**

### "soft delete 때문에 조회가 느려졌습니다. 어디부터 보나요?" (시니어 변별 포인트)

**순서대로 셋을 본다.**

1. **실행 계획의 `Rows Removed by Filter`.** `explain (analyze, buffers)`를 찍어 인덱스로 찾아온 행 중 몇 개를 버렸는지 본다. 이 값이 크면 `deleted = false`가 인덱스에 흡수되지 않고 사후 필터로 처리되고 있다는 뜻이다. **PostgreSQL이면 부분 인덱스로, 아니면 복합 인덱스 선두에 `deleted`를 올려서** 해결한다(§3-8).
2. **삭제 데이터 비율.** 활성 10%, 삭제 90%가 되면 **테이블·인덱스의 90%가 안 읽는 데이터**다. 공유 버퍼에 쓸모없는 페이지가 올라오고 캐시 적중률이 떨어진다. **그리고 VACUUM으로는 절대 줄지 않는다** — 살아 있는 행이기 때문이다. 이 지점이 곧 **아카이브 분리를 검토할 신호**다.
3. **`count` 쿼리와 페이징.** soft delete 테이블의 `count(*)`는 조건에 맞는 행을 다 세므로 비싸다. 부분 인덱스로 인덱스 온리 스캔 여지를 만들거나 **집계 테이블을 별도로 유지**하는 쪽을 고려한다.

**PostgreSQL이라면 부분 인덱스 하나로 1·2를 동시에 완화한다** — 조건이 인덱스에 흡수되고, 인덱스 자체가 활성 행 크기로 줄어들기 때문이다.

**그리고 여기서 흔한 오답 하나**: "`deleted` 컬럼에 단독 인덱스를 만들자." 값이 두 개뿐이라 **선택도가 극도로 낮아 옵티마이저가 무시하거나, 타더라도 테이블의 절반 이상을 읽는다.** 의미가 있는 것은 **복합 인덱스의 선두 컬럼으로서**이거나 **부분 인덱스의 조건으로서**이지 단독 인덱스가 아니다.

### "그냥 처음부터 아카이브 테이블로 옮기는 게 낫지 않나요? 언제 그 선을 넘나요?" (시니어 변별 포인트)

**세 가지 축으로 판단한다.**

1. **삭제 데이터를 얼마나 자주 읽는가.** 복구 요청·이력 조회·감사 조회가 **일상적인 기능**이면 soft delete가 맞다. 삭제 데이터를 사실상 안 읽고 **"만약을 위해" 남기는 것**이라면 아카이브가 맞다. **"만약을 위해"는 아카이브의 신호다** — 백업과 다를 바 없는 목적에 운영 테이블의 성능을 계속 지불하고 있기 때문이다.
2. **삭제 비율의 증가 속도.** 활성 대비 삭제 비율이 **계속 커지는 구조**(예: 세션·알림·임시 데이터)면 시간이 갈수록 나빠지는 방향이라 **선을 언제 넘느냐의 문제일 뿐**이다. 반면 회원 테이블처럼 삭제가 드물게 쌓이면 soft delete로 오래 버틴다.
3. **집계의 정확도가 얼마나 중요한가.** 정산·매출처럼 **숫자가 틀리면 안 되는 도메인**이면, 조건 하나 빠뜨리면 조용히 틀리는 구조(§3-8)를 유지하는 것 자체가 위험이다. 아카이브 분리는 **그 위험을 구조적으로 제거**한다.

**대가를 같은 호흡에 말하는 것이 이 답의 완성이다** — 아카이브는 **이력 조회가 `union all`이 되고, 복구가 절차가 되며, 스키마를 두 벌 관리해야 하고, 자식 데이터 처리 정책이 필요하다.** 그래서 실무 절충은 대개 **"soft delete로 시작하고, 보관 기간(예: 탈퇴 후 N개월)이 지난 행을 배치로 아카이브 이관"**이다. 최근 데이터는 soft delete의 편의를, 오래된 데이터는 아카이브의 성능을 취한다.

### "개인정보 파기 의무와 soft delete는 충돌하지 않나요?" (가산점 포인트)

**충돌한다. 그리고 이건 기술 문제가 아니라 컴플라이언스 문제라 우선순위가 다르다.**

soft delete는 **"지운 척"**이므로, 이름·이메일·전화번호가 **DB에 그대로 남아 있다.** 사용자가 삭제를 요청했고 법·약관상 파기 의무가 있다면 **`deleted = true`는 파기가 아니다.**

**반대 방향의 요구도 동시에 존재한다** — 전자상거래 거래 기록처럼 **일정 기간 보존이 의무인 데이터**도 있다. 그래서 실무 답은 "전부 지운다"도 "전부 남긴다"도 아니고 **컬럼 단위로 나누는 것**이다.

- **식별 정보(이름·이메일·전화)** → **실제로 파기하거나 비식별 처리**한다(`이름 → '탈퇴회원'`, `email → 'deleted:{id}'`). §2-3의 이메일 변형이 **유니크 회피 수단이면서 동시에 비식별 수단**이 되는 지점이다. 두 요구가 같은 조치로 만족되므로, 부분 유니크 인덱스를 쓰는 스키마여도 개인정보 컬럼은 별도로 마스킹해야 한다.
- **거래·정산 기록** → 보존하되 **개인과 연결되지 않도록** 식별자를 끊거나 대체 키로 바꾼다.
- **보관 기간 만료 시** → 배치로 **진짜 삭제**하거나 아카이브에서도 제거한다.

**한 문장으로**: "**soft delete는 '삭제'가 아니라 '비활성화'다.** 파기 의무가 있는 데이터에는 soft delete를 쓰지 않거나, **쓰더라도 식별 정보는 즉시 파기하고 비식별 껍데기만 남긴다.**" 이 구분을 말할 수 있으면 **삭제를 도메인 상태로 다룰 때의 대가를 법·운영 층까지 세어본 사람**으로 보인다.

---

## 한 줄 요약

**"삭제됨"은 우리 팀 안의 약속일 뿐 DB도 JPA도 모른다** — 그래서 탈퇴 회원의 행은 여전히 `unique (email)`을 점유해 재가입을 막고(§1-1), JPA는 컬렉션을 채울 때 **FK만 보고 `where post_id = ?`로 자식을 전부 긁어와** 삭제된 댓글까지 딸려온다(§1-2). **유니크 쪽 처방은 PostgreSQL이라면 부분 유니크 인덱스 한 줄**(`create unique index ... on member (email) where deleted = false`)로 끝난다 — 삭제 행은 인덱스에 아예 들어가지 않으므로 몇 번을 탈퇴·재가입해도 되고 활성 중복만 정확히 막히며, 같은 부분 인덱스를 일반 조회에도 재사용하면 인덱스가 활성 비율만큼 줄어든다(대가는 벤더 종속과 "제약이 아니라 인덱스"라서 FK 참조·`on conflict on constraint`가 안 된다는 것). 이 모든 것의 토대는 **유니크 제약이 `NULL`을 서로 같지 않은 값으로 보기 때문에 `NULL` 키는 몇 개든 통과한다**는 표준 SQL 규칙인데, **같은 규칙이 자리를 바꾸면 정반대로 작동한다** — 인덱스의 조건으로 쓰면 해법이고, `unique (email, deleted_at)`처럼 키의 구성 요소로 쓰면 활성 행끼리 `NULL = NULL`이 `UNKNOWN`이 되어 **"같은 이메일 활성 회원 2명"이라는 더 나쁜 구멍**이 열린다(PostgreSQL 15+의 `nulls not distinct`로 뒤집을 수는 있지만 시간 정밀도 문제는 남는다). 그래서 삭제 구분자는 **`deleted_seq = id`처럼 유일성이 정의상 보장되는 값**이어야 하고 **시각은 정보로만** 남긴다 — 시간을 유니크 키에 넣는 순간 정합성이 확률에 의존하고, 한 트랜잭션에서 여러 행을 지우면 확정적으로 충돌한다. **연관관계 쪽 처방**은 **`@SQLRestriction("deleted = false")` + `@SQLDelete`** 세트(6.4의 `@SoftDelete`는 이 둘을 묶은 것이고 `@OneToMany` 컬렉션에는 못 붙인다)로 조회 SQL에 조건이 자동으로 붙게 하는 것이고, **그 대가는 문서에 "always applied and cannot be disabled"로 명시된 "끌 수 없다"** — 관리자·통계 경로가 **예외 없이 조용히 0건**이 되므로 **네이티브 쿼리·별도 읽기 엔티티·DTO 프로젝션으로 탈출구를 처음부터 설계**해야 한다(중급 Q5의 `@JsonIgnore`가 실패한 이유와 **정확히 같은 구조** — 엔티티에 박은 전역 스위치는 예외를 만들 수 없다). 대안인 `@Filter`는 6.6의 `autoEnabled = true`로 "켜는 걸 잊는" 약점이 사라졌지만 **`applyToLoadByKey`가 기본 `false`라 `find()`와 `@ManyToOne` 로딩에는 보호가 걸리지 않는다** — 두 도구의 실패 방향이 반대이므로 **어느 쪽 실패가 더 비싼가**로 고른다. 그리고 soft delete를 택한 이상 청구서는 계속 온다 — **인덱스는 삭제 행까지 떠안고 VACUUM으로도 안 줄어들며**(살아 있는 행이기 때문이다), **집계는 조건 하나가 빠지면 예외 없이 숫자만 틀리고**, **FK와 `on delete`는 발동할 계기를 잃고**, **개인정보는 파기 의무와 충돌한다.** 이 청구서가 감당 범위를 넘어가면 **아카이브 테이블 분리**가 유니크·조회·인덱스·집계·FK 문제를 **한꺼번에** 없앤다(대신 `union` 이력 조회·복구 절차·스키마 이중 관리·자식 처리 정책을 얻는다). 그리고 이 모든 규칙은 **가입-탈퇴-재가입-재탈퇴 4단계 테스트**와 **관리자 경로가 0건이 아님을 단정하는 테스트**로, 실제 PostgreSQL 위에서 고정하기 전까지는 **언젠가 지워질 주장일 뿐이다.**
