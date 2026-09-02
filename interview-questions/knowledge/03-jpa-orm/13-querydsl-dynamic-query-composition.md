# QueryDSL 동적 쿼리 — `where(null)`이 조용히 무시된다는 성질 하나가 절반을 가른다

> 핵심 관전 포인트: **QueryDSL 동적 쿼리의 모든 관용구는 한 문장에서 나온다 — `where()`에 `null`을 넘기면 예외도 아니고 0건도 아니고 그 조건만 사라진다.** `where(nameEq(x), statusEq(y), null)`은 `null` 자리만 없는 셈 치고 나머지로 쿼리를 만든다. 이걸 알면 조건마다 **`BooleanExpression`을 반환하는 메서드**를 만들어 `where()`에 나열하는 순간 `if` 여섯 줄이 통째로 사라진다. **하지만 진짜 이점은 `if` 제거가 아니다.** `BooleanBuilder`는 "쌓는 통"이라 결과가 통 안에 갇히지만, `BooleanExpression`은 **값**이라서 `nameEq(x).and(statusIn(y))`처럼 **합성**하고, 다른 쿼리에서 **재사용**하고, 조건 자체를 **단위 테스트**할 수 있다. 대신 함정이 하나 — **앞쪽이 `null`이면 `.and()` 호출에서 NPE**가 난다(`null.and(...)`). 뒤쪽 `null`은 안전하다(`a.and(null)`은 `a`를 그대로 돌려준다). 그래서 합성할 땐 `Expressions.allOf(...)`처럼 **앞뒤 모두 null을 건너뛰는 유틸**을 쓴다. **선택 기준은 대체가 아니라 용도** — 단순 AND 나열이면 메서드 분리, `OR` 중첩처럼 조건 트리를 런타임에 조립해야 하면 `BooleanBuilder`. 그리고 페이징 — **`Page` 반환은 쿼리 2번이고 조건 없는 count는 전건 스캔**인데, `PageableExecutionUtils.getPage(content, pageable, countQuery::fetchOne)`는 **첫 페이지에 다 담기거나 마지막 페이지일 때 count 쿼리 자체를 생략**한다. 가장 위 층의 답은 더 단순하다 — **조건 없는 전체 검색을 애초에 못 하게 만드는 구조**(페이징 강제 시그니처, 페이지 크기 clamp, 필수 조건 검증).

---

## 0. 질문 + 의도

**질문**: "QueryDSL을 사용해본 경험이 있나요? 동적 쿼리를 어떻게 구성했나요?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**QueryDSL 동적 쿼리** — 검색 필터 조합 같은 실무 요구를 문자열 조립 없이 타입 안전하게 푸는 경험. **'실무 CRUD 너머의 조회 요구'를 다뤄봤는지 확인한다.**"

핵심 단어는 **"실무 CRUD 너머"** 다. `findByEmail` 수준의 메서드 이름 쿼리는 누구나 쓴다. 그런데 검색 화면 하나만 만들어도 요구는 바로 이렇게 온다 — **"조건 6개인데 사용자가 아무거나 골라서 넣습니다."**

이 순간 메서드 이름 방식은 조합 폭발로 죽는다. 조건 6개를 사용자가 임의로 고른다면 가능한 조합은 2의 6제곱, 즉 64가지다. `findByNameAndStatus`, `findByNameAndStatusAndGrade`처럼 메서드를 만들어 나가면 이론상 64개를 만들어야 한다는 뜻이다. 그렇다고 JPQL 문자열을 `StringBuilder`로 이어 붙이면 공백 하나 빠져서 밤을 새운다. 그래서 이 질문은 **"그 지점을 겪어봤는가"** 를 묻는다.

그런데 이 문항이 진짜 변별력을 갖는 자리는 한 칸 더 안쪽이다. **"써봤다"고 답하는 사람은 많은데, 그중 상당수가 `BooleanBuilder` + `if` 나열에 머물러 있다.** 그 자체가 틀린 코드는 아니지만, **`where(null)`이 무시된다는 성질을 모르면 거기서 멈출 수밖에 없다.** 그리고 그 성질을 모른다는 것은 곧 조건을 **합성·재사용 가능한 값**으로 다루는 사고에 도달하지 못했다는 뜻이다. 도구의 관용구 하나가 코드 구조 전체를 가르는 흔치 않은 사례다.

**함정 두 개**:

- **"동적 쿼리를 어떻게 구성했나"에 개념어로 답하는 것.** "조건이 들어왔는지 분기해서 where에 추가했다"는 **방향은 맞지만 코드가 아니다.** 이 문항은 실제로 써본 사람만 답할 수 있는 코드 수준의 서술을 기대한다. `BooleanBuilder`든 `BooleanExpression` 메서드든 **구체적인 이름과 형태**를 말해야 한다.
- **페이징을 조회 성능 얘기로만 끝내는 것.** 검색 API의 진짜 위험은 느린 쿼리가 아니라 **조건 없이 들어온 요청이 전건을 긁는 것**이고, 이걸 "조심하겠다"가 아니라 **구조로 막았다**고 말할 수 있는지에서 갈린다(§3-6).

## 1. 관용구의 뿌리 — `where()`에 넘긴 `null`은 그 조건만 지운다

### 1-1. 전제 지식 — `QMember.member`는 대체 어디서 오는가

본론에 들어가기 전에 깔아야 할 전제가 하나 있다. 앞으로 나올 코드는 전부 `member.name.eq(...)` 같은 형태인데, 이 `member`가 어디서 온 물건인지 모르면 "타입 안전"이라는 말도 공허하게 들린다.

QueryDSL은 **쿼리를 문자열이 아니라 자바 코드로 쓰게 해주는 라이브러리**다. 그러려면 테이블의 컬럼(정확히는 엔티티의 필드)을 가리킬 자바 객체가 있어야 한다. `"member.name"`이라는 문자열 대신 `member.name`이라는 **필드 접근**으로 쓰기 위해서다. 그 객체를 담는 클래스를 사람이 손으로 만들지는 않는다. **빌드할 때 자동으로 생성된다.**

생성 주체는 **어노테이션 프로세서(annotation processor)** 다. 어노테이션 프로세서란 컴파일러(javac)가 컴파일 도중에 호출하는 플러그인으로, 소스 코드에 붙은 어노테이션을 읽고 **새 소스 파일을 만들어내는** 프로그램이다. QueryDSL이 제공하는 프로세서는 `@Entity`가 붙은 클래스를 전부 찾아 그에 대응하는 클래스를 하나씩 뽑아낸다. 그 클래스의 이름이 원래 이름 앞에 `Q`를 붙인 `QMember`이고, `Q`는 Query의 Q다. 이렇게 만들어진 클래스를 통칭 **Q타입**이라 부른다.

```text
[내가 쓴 코드]                    [빌드]                        [생성물]
Member.java                  javac 실행
  @Entity                      └─ QueryDSL 어노테이션 프로세서가
  Long id                          @Entity 를 스캔               QMember.java
  String name        ──────▶       필드 목록을 읽어           ──▶   public static final QMember member
  int age                          Q타입 소스를 생성                NumberPath<Long> id
  MemberStatus status              (같은 빌드에서 함께 컴파일)       StringPath name
                                                                    NumberPath<Integer> age
   build/generated/sources/annotationProcessor/... 아래에 생긴다      EnumPath<MemberStatus> status
```

여기서 두 가지가 따라 나온다.

**첫째, 필드마다 타입이 다르다.** `name`은 `StringPath`, `age`는 `NumberPath<Integer>`, `status`는 `EnumPath<MemberStatus>`다. 타입이 다르다는 것은 **쓸 수 있는 연산자가 다르다**는 뜻이다. `StringPath`에는 `contains()`나 `startsWith()`가 있고 `NumberPath`에는 `gt()`나 `between()`이 있다. 그래서 `member.name.gt(20)`처럼 말이 안 되는 조건을 쓰면 **컴파일이 안 된다.** 문자열로 쿼리를 쓸 때는 이런 실수가 런타임까지 살아남는다.

**둘째, 이것이 "컴파일 타임에 오타를 잡는다"의 정확한 의미다.** `member.nmae`라고 잘못 쓰면 `QMember`에 그런 필드가 없으므로 IDE가 즉시 빨간 줄을 긋고 빌드가 깨진다. `"select m from Member m where m.nmae = :name"`이라는 문자열은 컴파일도 되고 배포도 되고, 그 화면을 처음 연 사용자가 500을 받는다. **오류를 발견하는 시점이 배포 후에서 저장하는 순간으로 당겨지는 것**이 QueryDSL을 쓰는 첫 번째 이유다.

`QMember.member`의 `member`는 QueryDSL이 만들어 둔 **기본 인스턴스**다. `QMember` 클래스 안에 `public static final QMember member = new QMember("member")`처럼 선언돼 있고, 괄호 안의 `"member"`는 SQL로 나갈 때 쓰이는 **별칭(alias)** 이다. 그래서 실무에서는 아래처럼 정적 임포트해 쓰는 것이 관례다.

```java
import static com.example.domain.QMember.member;   // 이 한 줄 덕분에 member.name 으로 쓸 수 있다

queryFactory.selectFrom(member).where(member.name.eq("김"))...
```

같은 테이블을 두 번 참조해야 하는 자기 조인 같은 경우에는 `QMember m2 = new QMember("m2")`처럼 별칭이 다른 인스턴스를 직접 만든다. 기본 인스턴스 하나로는 별칭이 겹치기 때문이다.

Q타입이 생성되지 않으면 그 아래 모든 코드가 컴파일조차 되지 않으므로, 이것이 QueryDSL 도입의 첫 관문이자 가장 흔한 실패 지점이다. 빌드 설정과 깨지는 경로는 §3-14에서 따로 다룬다.

### 1-2. 먼저 정답부터

```java
query.where(user.name.eq(name), null, user.age.gt(20));
```

이 코드는 어떻게 되나. 후보는 세 개다.

- ① `NullPointerException`이 난다
- ② 조건이 하나도 안 맞아 **0건**이 나온다
- ③ **`null`인 자리만 없는 셈 치고** `name = ? and age > ?`로 나간다

**정답은 ③이다.** `null`은 "거짓"도 "참"도 아니고 **"이 조건은 존재하지 않는다"** 로 해석된다. 그래서 위 쿼리는 정확히 아래와 같다.

```java
query.where(user.name.eq(name), user.age.gt(20));
```

이 한 줄이 QueryDSL 동적 쿼리의 **전부**다. 이 성질이 있기 때문에 "조건이 있으면 넣고 없으면 안 넣는다"는 분기를 **`if`로 쓸 필요가 없다.** 조건을 만드는 쪽에서 `null`을 반환하기만 하면, `where()`가 알아서 걸러낸다.

> 참고로 `query.where(null)`처럼 **`null` 리터럴 하나만** 넘기면 자바 컴파일러가 `where(Predicate)`인지 `where(Predicate...)`인지 판단하지 못해 경고가 뜬다. 실무에서는 항상 `where(nameEq(x))`처럼 **메서드 호출 결과**를 넘기므로 이 모호성은 생기지 않는다. 개념 설명용 예시일 뿐이다.

### 1-3. 왜 그런가 — 라이브러리 안쪽

이건 "그렇게 동작하더라"가 아니라 **명시적으로 그렇게 짜인 코드**다. `where(...)`는 인자를 하나씩 순회하며 쿼리 메타데이터에 넣는데, 그 진입점에서 `null`을 즉시 걸러낸다.

```java
// QueryMixin — where(Predicate...)는 인자를 하나씩 addWhere로 넘긴다
public final T where(Predicate... o) {
    for (Predicate e : o) {
        metadata.addWhere(convert(e, Role.WHERE));
    }
    return self;
}

// DefaultQueryMetadata — 여기서 null이 조용히 버려진다
public void addWhere(Predicate e) {
    if (e == null) {
        return;          // 예외도 아니고 로그도 아니다. 그냥 빠져나간다.
    }
    ...
}
```

> **확인 범위**: 위 코드는 로컬에 받아둔 **Querydsl 5.1.0**의 `querydsl-core` 소스 (`com.querydsl.core.support.QueryMixin`, `com.querydsl.core.DefaultQueryMetadata`)를 직접 확인한 것이다. 이 동작은 QueryDSL의 오래된 계약이라 버전이 달라도 같지만, 정확한 코드 형태는 버전에 따라 다를 수 있다.

**"조용히"라는 단어가 중요하다.** 로그도 경고도 없다. 이건 장점이자 단점이다 — 장점은 `if` 없이 동적 쿼리가 되는 것이고, **단점은 실수로 `null`이 흘러들어도 아무도 알려주지 않는다는 것**이다(§2-5, §3-9에서 다시 다룬다).

### 1-4. `null`의 비대칭 — 관대한 곳이 세 군데, 터지는 곳이 한 군데

여기서 헷갈리기 쉬운 지점. **`null`을 관대하게 처리하는 곳이 `where()` 말고도 두 군데 더 있고, 셋 다 동작이 조금씩 다르다.** 그리고 딱 한 자리만 예외를 던진다.

```java
// ① BooleanBuilder.and(null) — 아무 일도 안 일어난다 (no-op)
public BooleanBuilder and(@Nullable Predicate right) {
    if (right != null) {          // null이면 통에 안 넣고 그냥 반환
        ...
    }
    return this;
}

// ② BooleanExpression.and(null) — 자기 자신을 그대로 돌려준다
public BooleanExpression and(@Nullable Predicate right) {
    right = (Predicate) ExpressionUtils.extract(right);
    if (right != null) {
        return Expressions.booleanOperation(Ops.AND, mixin, right);
    } else {
        return this;              // a.and(null) == a
    }
}

// ③ BooleanExpression.or(null) — 역시 자기 자신을 그대로 돌려준다
public BooleanExpression or(@Nullable Predicate right) {
    ... else {
        return this;              // a.or(null) == a
    }
}
```

> **확인 범위**: 위 세 코드 모두 **Querydsl 5.1.0** 소스 (`com.querydsl.core.BooleanBuilder`, `com.querydsl.core.types.dsl.BooleanExpression`)에서 그대로 확인했다.

**여기서 반드시 붙잡아야 할 것이 `null`의 비대칭이다.** 아래 세 줄이 이 문서에서 가장 자주 사고를 내는 지점이다.

| 표현 | 결과 | 왜 그런가 |
|---|---|---|
| `where(null)` | 안전 — 그 조건만 사라진다 | `addWhere`가 `null`을 걸러낸다(§1-3) |
| `a.and(null)` | 안전 — `a`가 그대로 남는다 | **오른쪽** `null`은 `and()` 안에서 검사된다 |
| `null.and(a)` | **NullPointerException** | **왼쪽**이 `null`이면 부를 메서드 자체가 없다 |

세 번째 줄의 이유는 QueryDSL과 아무 상관이 없다. **`null` 참조에 대고 메서드를 호출하는 것은 자바에서 무조건 NPE**이기 때문이다. 라이브러리가 아무리 관대해도, 그 라이브러리 코드에 진입하기 전에 터진다. 그러니까 이렇게 외우면 된다 — **`null`을 인자로 넘기는 것은 안전하고, `null`에 점을 찍는 것이 위험하다.**

전체를 한 표로 정리하면 이렇다.

| 표현 | 결과 | 한마디 |
|---|---|---|
| `where(a, null, c)` | `a AND c` | `null` 자리만 사라진다 |
| `builder.and(null)` | 통에 아무것도 안 담김 | `BooleanBuilder`도 `null`에 관대하다 |
| `a.and(null)` | `a` | **오른쪽** `null`은 안전 |
| `a.or(null)` | `a` | **오른쪽** `null`은 안전 |
| `null.and(b)` | **NPE** | **왼쪽** `null`이 진짜 함정 (§2-5) |

**실무 처방은 두 가지뿐이다.** 조건을 합칠 때 앞쪽이 `null`일 수 있다면, 그 합성을 직접 하지 말고 `null`을 알아서 건너뛰는 도구에 맡긴다.

```java
// 위험: 사용자가 이름을 안 넣으면 nameEq(name)이 null → null.and(...) → NPE
return nameEq(name).and(statusEq(status));

// 처방 A — Expressions.allOf: 앞이든 뒤든 null을 건너뛴다. 전부 null이면 결과도 null.
return Expressions.allOf(nameEq(name), statusEq(status));

// 처방 B — BooleanBuilder로 받는다: 빌더의 and()는 null을 그냥 무시한다(위 ①).
BooleanBuilder builder = new BooleanBuilder();
builder.and(nameEq(name))       // null이면 아무 일도 안 일어난다
       .and(statusEq(status));
return builder;
```

두 처방의 원리는 같다 — **`null` 검사를 사람이 아니라 도구가 하게 만든다.** A는 값을 그대로 유지하므로 반환해서 다른 곳에 넘길 수 있고(§2), B는 통이라 반복문 안에서 누적할 때 편하다(§2-8). 각각의 세부는 §2-5에서 코드로 다시 본다.

**추가로 `or(null)`의 의미론에 주의가 필요하다.** `a.or(null)`이 `a`가 되는 것은 `AND`일 때와 결과의 방향이 반대다.

- `AND`에서 조건 하나가 빠지면 → **제약이 줄어 결과가 넓어진다**
- `OR`에서 가지 하나가 빠지면 → **선택지가 줄어 결과가 좁아진다**

QueryDSL은 어느 쪽이든 **"그 조건은 애초에 없었던 것"** 으로 취급한다. 이게 동적 쿼리에서 원하는 동작인 경우가 대부분이지만(사용자가 이름을 안 넣었으면 이름으로 OR 검색할 이유도 없다), **`null`을 "무조건 참"으로 착각하면 `OR`에서 결과가 반대로 나온다.** 면접에서 이 구분까지 말하면 **(가산점 포인트)** 다.

### 1-5. before — `BooleanBuilder` + `if` (가장 흔한 형태)

조건 6개짜리 회원 검색이다. 이름·이메일·상태(enum)·등급 목록·가입일 시작·가입일 종료.

```java
// before: 동작은 한다. 다만 조건이 늘어날 때마다 이 메서드가 같이 길어진다.
public Page<Member> search(MemberSearchCond cond, Pageable pageable) {
    BooleanBuilder builder = new BooleanBuilder();

    if (cond.getName() != null) {
        builder.and(member.name.contains(cond.getName()));
    }
    if (cond.getEmail() != null) {
        builder.and(member.email.eq(cond.getEmail()));
    }
    if (cond.getStatus() != null) {                       // enum
        builder.and(member.status.eq(cond.getStatus()));
    }
    if (cond.getGrades() != null && !cond.getGrades().isEmpty()) {
        builder.and(member.grade.in(cond.getGrades()));
    }
    if (cond.getJoinedFrom() != null) {
        builder.and(member.joinedAt.goe(cond.getJoinedFrom()));
    }
    if (cond.getJoinedTo() != null) {
        builder.and(member.joinedAt.loe(cond.getJoinedTo()));
    }

    List<Member> content = queryFactory
            .selectFrom(member)
            .where(builder)
            .offset(pageable.getOffset())
            .limit(pageable.getPageSize())
            .fetch();
    ...
}
```

이 코드의 문제는 **"길다"가 아니다.** 진짜 문제는 세 가지다.

- **조건 하나하나에 이름이 없다.** "가입 기간 조건"이라는 개념이 코드 어디에도 이름으로 존재하지 않고, `if` 두 덩어리로만 흩어져 있다.
- **다른 쿼리에서 못 쓴다.** 관리자용 회원 검색과 통계용 회원 집계가 같은 "활성 회원" 조건을 쓴다면, 그 `if` 블록을 **복사**해야 한다.
- **조건만 따로 테스트할 수 없다.** `builder` 내부 상태를 검증하려면 결국 DB를 띄워 쿼리를 돌려야 한다.

### 1-6. after — `BooleanExpression` 반환 메서드 + `where()` 나열

```java
// after: if가 한 줄도 없다. 조건마다 이름이 생겼고, 각각이 독립된 값이다.
public Page<Member> search(MemberSearchCond cond, Pageable pageable) {
    List<Member> content = queryFactory
            .selectFrom(member)
            .where(
                    nameContains(cond.getName()),
                    emailEq(cond.getEmail()),
                    statusEq(cond.getStatus()),
                    gradeIn(cond.getGrades()),
                    joinedGoe(cond.getJoinedFrom()),
                    joinedLoe(cond.getJoinedTo())
            )
            .offset(pageable.getOffset())
            .limit(pageable.getPageSize())
            .fetch();
    ...
}

// --- 조건 하나 = 메서드 하나. 값이 없으면 null을 돌려준다. ---

private BooleanExpression nameContains(String name) {
    return name == null ? null : member.name.contains(name);
}

private BooleanExpression emailEq(String email) {
    return email == null ? null : member.email.eq(email);
}

private BooleanExpression statusEq(MemberStatus status) {   // enum도 똑같다
    return status == null ? null : member.status.eq(status);
}

private BooleanExpression gradeIn(List<Grade> grades) {
    // 빈 리스트를 in()에 넣으면 "in ()" 같은 이상한 SQL이 되거나
    // 벤더에 따라 항상 false가 된다. 빈 것도 null로 눕힌다.
    return (grades == null || grades.isEmpty()) ? null : member.grade.in(grades);
}

private BooleanExpression joinedGoe(LocalDate from) {
    return from == null ? null : member.joinedAt.goe(from.atStartOfDay());
}

private BooleanExpression joinedLoe(LocalDate to) {
    return to == null ? null : member.joinedAt.loe(to.atTime(LocalTime.MAX));
}
```

**핵심은 `where()`에 나열된 여섯 개 중 `null`인 것은 알아서 빠진다는 것**이다. 사용자가 이름만 넣었으면 `where member.name like ?` 하나만 나가고, 아무것도 안 넣었으면 `where` 절 자체가 사라진다(§3-9에서 이 마지막 경우를 막는다).

`where()`에 인자를 여러 개 나열하면 **`AND`로 묶인다.** 이게 기본이고, `OR`가 필요하면 §2-5의 방법을 쓴다.

### 1-7. 무엇이 사라졌고, 무엇이 사라지지 않았나

| | before | after |
|---|---|---|
| 분기 | `if` 6개 | 없음(각 메서드 안 삼항 연산자) |
| 조건의 이름 | 없음 | 메서드 이름 |
| 재사용 | 복사 | 메서드 호출 |
| 단위 테스트 | 어려움 | 가능(§2-4) |

**사라지지 않은 것도 정확히 말해야 한다.** `null` 체크 자체는 없어지지 않았다. `if`에서 삼항 연산자로 **자리를 옮겼을 뿐**이다. 그래서 "코드가 짧아진다"만 이유로 들면 약하다. 진짜 이유는 다음 절이다.

## 2. 왜 이 방식인가 — 조건이 "값"이 되면 세 가지가 열린다

### 2-1. 통과 값 — 이 대비가 이 문서의 심장이다

이 절이 이 문서에서 가장 중요하다. `if`를 없애는 건 부수 효과고, **조건이 `BooleanExpression`이라는 값(value)이 되었다는 사실**이 본질이다.

먼저 두 타입의 정체를 각각 한 문장으로 정의하자.

- **`BooleanBuilder`는 조건을 담아 두는 통이다.** 정확히는 내부에 `Predicate` 하나를 필드로 들고 있다가, `and()`를 부를 때마다 그 필드를 새로 합친 결과로 **바꿔치기하는 가변(mutable) 객체**다. 통을 흔들면 통 안의 내용물이 바뀐다.
- **`BooleanExpression`은 조건 하나를 표현하는 불변(immutable) 값이다.** `a.and(b)`는 `a`를 바꾸지 않는다. `a`와 `b`를 재료로 **새로운 세 번째 값**을 만들어 돌려준다. 숫자 `3 + 4`가 `3`을 바꾸지 않고 `7`이라는 새 값을 만드는 것과 같다.

비유하자면 이렇다. 통은 **장바구니**다. 물건을 계속 던져 넣을 수 있지만, 장바구니 자체를 다른 사람에게 "값"으로 건네주기는 어렵다(건네준 뒤 내가 하나 더 넣으면 상대의 장바구니도 바뀐다). 값은 **영수증에 적힌 금액**이다. 몇 번을 복사해도 같고, 누구에게 보여줘도 안전하며, 다른 금액과 더해 새 금액을 만들 수 있다.

```text
[통]  BooleanBuilder                        [값]  BooleanExpression
      ┌──────────────┐                            isActive()  ──┐
      │ and(A)       │                                          ├─ and ─▶ 새 값
      │ and(B)  ─────┼──▶ 결과가 통 안에 있다        gradeIn(x) ──┘
      │ and(C)       │    꺼내려면 통째로 넘겨야 하고
      └──────────────┘    넘긴 뒤에도 원본이 변할 수 있다   새 값도 다시 재료가 된다
```

**"값이라서 무엇이 가능해지는가"** 를 세 가지로 나눠 코드로 확인한다. 각 항목 끝에 **통 안에 갇히면 왜 그게 안 되는지**를 한 줄씩 붙인다.

### 2-2. 열리는 것 ① 합성 — 조건을 재료로 새 조건을 만든다

```java
// "활성 회원"이라는 도메인 개념 하나가 조건으로 존재하게 된다
private BooleanExpression isActive() {
    return member.status.eq(MemberStatus.ACTIVE)
            .and(member.deletedAt.isNull());
}

// "최근 90일 내 로그인한 활성 회원" — 위에서 만든 값을 그대로 재료로 쓴다
private BooleanExpression isRecentlyActive() {
    return isActive()
            .and(member.lastLoginAt.goe(LocalDateTime.now().minusDays(90)));
}

// 검색 조건끼리 묶어 하나의 값으로 만들 수도 있다
private BooleanExpression nameAndStatus(String name, MemberStatus status) {
    return Expressions.allOf(nameEq(name), statusEq(status));   // null 안전 합성 (§2-5)
}
```

`isActive()`는 이제 **이름이 붙은 도메인 규칙**이다. "탈퇴 회원은 `deletedAt`이 채워진다"는 지식이 코드의 한 군데에만 있고, 나머지는 `isActive()`를 부르면 된다.

**통이면 왜 안 되나**: `BooleanBuilder`를 반환해 봐야 그것은 "조건"이 아니라 "조건이 담긴 통"이라, 다른 통에 `AND`로 붙이는 순간 괄호 중첩이 지저분해지고 무엇보다 **`isActive()`라는 이름을 가진 값이 코드에 존재하지 않는다.**

### 2-3. 열리는 것 ② 재사용 — 다른 쿼리, 다른 리포지토리에서 그대로

```java
// 목록 조회
queryFactory.selectFrom(member)
        .where(isActive(), gradeIn(cond.getGrades()))
        .fetch();

// 집계 — 같은 조건을 그대로 재사용
queryFactory.select(member.count())
        .from(member)
        .where(isActive())
        .fetchOne();

// 다른 화면 — 활성 회원 중 미인증만
queryFactory.selectFrom(member)
        .where(isActive(), member.emailVerified.isFalse())
        .fetch();
```

**"활성 회원의 정의가 바뀌었다"는 요구가 왔을 때 고칠 자리가 한 곳**이라는 것이 재사용의 실질적 가치다. `if` 블록을 복사해 쓴 코드베이스에서는 이 요구가 **"grep해서 다 찾아 고치기"** 가 된다. 그리고 하나를 빠뜨린다.

조건이 여러 리포지토리에서 쓰인다면 `MemberPredicates` 같은 **정적 메서드 모음 클래스**로 빼는 것이 실무 관행이다.

```java
public final class MemberPredicates {
    private MemberPredicates() {}

    public static BooleanExpression isActive() { ... }
    public static BooleanExpression nameContains(String name) { ... }
}
```

**통이면 왜 안 되나**: 빌더는 가변이라 **여러 쿼리가 같은 인스턴스를 공유하면 서로를 오염시킨다.** A 쿼리가 쓰던 통에 B 쿼리가 조건을 하나 더 넣으면 A의 조건도 바뀐다. 그래서 재사용하려면 쓸 때마다 새 통을 만들어야 하고, 그러려면 "통을 만들어 주는 메서드"를 또 두어야 한다 — 결국 값 하나면 될 일에 한 겹이 더 붙는다.

### 2-4. 열리는 것 ③ 단위 테스트 — 조건 자체를 DB 없이 검증한다

`BooleanExpression`은 값이므로 **DB 없이** 그 자체를 검사할 수 있다.

```java
@Test
void 이름이_null이면_조건을_만들지_않는다() {
    assertThat(MemberPredicates.nameContains(null)).isNull();
}

@Test
void 빈_등급_목록은_조건이_되지_않는다() {   // in () 사고를 막는 회귀 테스트
    assertThat(MemberPredicates.gradeIn(List.of())).isNull();
}

@Test
void 이름_조건은_like로_변환된다() {
    assertThat(MemberPredicates.nameContains("김").toString())
            .contains("contains");   // 표현식의 문자열 형태를 검사
}
```

특히 두 번째 테스트가 실무적으로 값지다. **"빈 리스트를 `in()`에 넣으면 안 된다"는 지식이 코드 리뷰어의 기억이 아니라 테스트에 박힌다.** 이건 3장 전체를 관통하는 "안전망을 코드로 고정한다"는 주제와 정확히 같은 이야기다(§3-11).

**통이면 왜 안 되나**: 검사할 대상이 메서드의 반환값이 아니라 **빌더 내부에 쌓인 상태**라, "이 조건이 만들어졌는가"를 물어보려면 결국 쿼리를 실행해 결과 행을 봐야 한다. 즉 DB가 필요해지고, 조건 하나를 검증하는 데 통합 테스트 한 벌이 필요해진다.

> **확인 범위**: 표현식의 `toString()` 형태는 QueryDSL 버전에 따라 문자열이 달라질 수 있다. `null` 여부 검사(첫 두 테스트)는 안정적이지만, 문자열 매칭 테스트는 깨지기 쉬우니 실제 SQL 검증은 통합 테스트에서 하는 편이 낫다.

### 2-5. 함정 — 앞쪽이 `null`이면 NPE

**여기가 이 방식의 유일한 진짜 함정이다.** §1-4에서 봤듯 `a.and(null)`은 안전하다. 문제는 반대 방향이다.

```java
// 위험: name이 null이면 nameEq(name)이 null → null.and(...) → NullPointerException
private BooleanExpression nameAndStatus(String name, MemberStatus status) {
    return nameEq(name).and(statusEq(status));
}
```

`where()`의 관대함에 익숙해지면 **합성할 때도 관대할 거라고 착각**하는데, 자바 메서드 호출은 그렇지 않다. `null` 참조에 `.and()`를 부르면 그냥 NPE다. **그리고 이 NPE는 "사용자가 이름을 안 넣었을 때만" 터진다** — 개발자는 항상 조건을 채워서 테스트하므로 운영에서 처음 만난다.

**대응 세 가지.**

**(1) `Expressions.allOf` / `anyOf` — 가장 깔끔하다.**

```java
// 안전: 앞이든 뒤든 null을 건너뛴다. 전부 null이면 결과도 null(= where에서 사라짐).
private BooleanExpression nameAndStatus(String name, MemberStatus status) {
    return Expressions.allOf(nameEq(name), statusEq(status));
}

// OR가 필요할 때 — 통합 검색어를 이름 또는 이메일에서 찾기
private BooleanExpression keywordMatches(String keyword) {
    return Expressions.anyOf(nameContains(keyword), emailContains(keyword));
}
```

왜 안전한지 근거가 있다. `allOf`의 구현은 이렇다.

```java
public static BooleanExpression allOf(BooleanExpression... exprs) {
    BooleanExpression rv = null;
    for (BooleanExpression b : exprs) {
        rv = rv == null ? b : rv.and(b);
    }
    return rv;
}
```

`rv`가 아직 `null`이면 그냥 `b`를 대입하므로 **선행 `null`을 건너뛰고**, `b`가 `null`이면 `rv.and(null)`이 `rv`를 돌려주므로 **후행 `null`도 무해**하다. 전부 `null`이면 `null`이 반환되고, 그건 `where()`에서 조용히 사라진다. **null 안전성이 끝까지 전파된다.** `anyOf`도 `and` 대신 `or`일 뿐 구조가 같다.

> **확인 범위**: `Expressions.allOf` / `anyOf`의 위 구현은 **Querydsl 5.1.0** (`com.querydsl.core.types.dsl.Expressions`)에서 확인했다. 두 메서드는 `BooleanExpression...`을 받으므로, 조건 메서드의 반환 타입을 `Predicate`가 아니라 **`BooleanExpression`으로 선언해야 그대로 넘길 수 있다.** 이것이 반환 타입을 `BooleanExpression`으로 쓰는 실용적인 이유이기도 하다.

**(2) `BooleanBuilder`로 받아 합친다** — 빌더의 `and()`도 `null`을 무시하므로(§1-4의 ①), 앞쪽 `null` 문제가 원천적으로 없다.

```java
// 안전: 첫 조건이 null이어도 통이 그냥 무시한다
BooleanBuilder builder = new BooleanBuilder();
builder.and(nameEq(name))
       .and(statusEq(status));
```

반환 타입이 통이라 §2-2~2-4의 세 이점을 포기하게 되지만, **반복문 안에서 개수를 모르고 누적할 때**는 이쪽이 정직하다(§2-8).

**(3) `Optional`로 감싸기** — 표현은 되지만 길어져서 조건이 세 개만 넘어가도 읽기 힘들다.

```java
// 동작하지만 권장하지 않는다 — 조건이 늘면 급격히 지저분해진다
return Optional.ofNullable(nameEq(name))
        .map(e -> e.and(statusEq(status)))
        .orElse(statusEq(status));
```

**(4) 첫 조건을 항상 참인 값으로 고정** — `Expressions.TRUE`나 `1=1` 같은 상수로 시작하는 방식. 동작은 하지만 **필요 없는 조건이 SQL에 남을 수 있어** 권장하지 않는다. `allOf`가 있으니 쓸 이유가 없다.

**`OR` 그룹을 쓸 때 반드시 인식해야 할 부작용 하나.**

```java
// A AND (B OR C) 를 만들려면
.where(
    isActive(),                                    // A
    Expressions.anyOf(nameContains(k), emailContains(k))   // (B OR C)
)
```

`k`가 `null`이면 `anyOf`는 `null`을 반환하고, **그 괄호 그룹이 통째로 사라진다.** 결과는 `where isActive()` 하나뿐 — 즉 **검색어가 없으면 전체 활성 회원**이 나온다. 이게 의도라면 좋지만, 의도가 아니라면 이건 §1-3에서 말한 "조용한 무시"가 그대로 사고로 이어지는 경로다. **`OR` 그룹이 사라졌을 때 결과가 어떻게 되는지를 반드시 한 번은 따져봐야 한다.**

### 2-6. 그래서 `BooleanBuilder`에는 왜 이 성질이 없나

한 문장으로 정리하면 이렇다. **`BooleanBuilder`는 가변 상태를 쌓는 빌더고, `BooleanExpression`은 불변 값이다.**

빌더는 "지금까지 뭘 담았는지"라는 상태를 가지므로 함부로 공유하거나 재사용할 수 없고(한 요청에서 쓰던 통을 다른 곳에 넘기면 이후 `and()` 호출이 원본을 오염시킨다), 반환해도 받는 쪽에서 다시 조작해야 한다. 값은 그런 걱정이 없다 — **`isActive()`는 몇 번을 불러도 같고, 어디에 넘겨도 안전하다.**

### 2-7. 선택 기준 ① — 단순 AND 나열이면 메서드 분리

여기까지 읽으면 `BooleanBuilder`가 열등해 보이지만, **그렇지 않다.** 둘은 잘하는 일이 다르다.

조건들이 전부 `AND`로만 묶이고 개수가 정해져 있으면 §1-6이 명백히 낫다. 실무 검색 화면의 대부분이 여기 해당한다.

### 2-8. 선택 기준 ② — 조건 트리를 런타임에 조립해야 하면 `BooleanBuilder`

**개수가 런타임에 결정되거나, 중첩 구조가 데이터에 따라 달라지는 경우**가 `BooleanBuilder`의 자리다.

```java
// 사용자가 정의한 필터 규칙을 DB에서 읽어와 조립하는 경우
// — 조건의 개수도, 연산자도 실행 시점에야 안다
public Predicate buildFrom(List<FilterRule> rules) {
    BooleanBuilder builder = new BooleanBuilder();
    for (FilterRule rule : rules) {          // 몇 개인지 컴파일 시점에 모른다
        BooleanExpression e = toExpression(rule);
        if (rule.getConjunction() == Conjunction.OR) {
            builder.or(e);
        } else {
            builder.and(e);
        }
    }
    return builder;
}
```

이걸 `where()` 나열로 쓰려면 배열을 동적으로 만들어야 하는데, 그럴 바에는 `BooleanBuilder`가 정직하다. **"반복문 안에서 조건을 누적한다"가 신호**다.

또 하나. `BooleanBuilder`는 `and`/`or`/`andNot` 같은 **연산자를 실행 중에 바꿔 끼울 수 있고**, `hasValue()`로 **조건이 하나라도 담겼는지 물어볼 수 있다.** 이 두 번째 능력은 §3-9의 "조건 없는 전체 검색 차단"에 그대로 쓰인다.

### 2-9. 실무에서는 섞어 쓴다

가장 흔한 실전 형태는 **둘 다**다. `BooleanBuilder`를 뼈대로 쓰되, 담기는 조건은 `BooleanExpression` 메서드로 만든다 — §1-4에서 확인했듯 `BooleanBuilder.and(null)`도 무해하기 때문에 이 조합이 자연스럽게 성립한다.

```java
// 필수 조건은 빌더에 먼저 넣고, 선택 조건은 메서드로 얹는다
BooleanBuilder builder = new BooleanBuilder(isActive());   // 필수 — 항상 non-null

builder.and(nameContains(cond.getName()))       // null이면 무시됨
       .and(statusEq(cond.getStatus()))
       .and(Expressions.anyOf(                  // OR 그룹은 anyOf로
               tagEq(cond.getTag()),
               categoryEq(cond.getCategory())));
```

면접에서 "둘 중 뭐가 낫나요"라는 질문에는 **"용도가 다르고 실무에서는 섞어 씁니다"** 라고 답한 뒤 위 기준을 대는 것이 정확하다. 한쪽을 열등하다고 말하면 오히려 감점이다.

## 3. 실무 적용 — 페이징과 count, 구조적 가드, DTO, 함정들

### 3-1. 페이징의 출발점 — `Page` 반환은 쿼리 2번이다

- `Page<T>`를 반환하면 **쿼리가 2번** 나간다 — 데이터(content) 쿼리 + 총건수(count) 쿼리.
- 검색 조건이 하나도 없으면 count 쿼리는 `select count(*) from member`가 되어 **테이블 전건을 센다.** 500만 건이면 500만 건을 센다.
- 페이징이 리포지토리 시그니처로 강제돼 있으면(§3-7) content 쿼리는 안전하다. **위험한 쪽은 count다.**

이 지점부터가 채워야 할 곳이다.

### 3-2. `PageableExecutionUtils.getPage` — count를 아예 안 날리는 경우가 있다

Spring Data는 **총건수를 계산으로 알아낼 수 있으면 count 쿼리를 실행하지 않는** 헬퍼를 제공한다.

```java
// before: count를 항상 실행한다
long total = queryFactory.select(member.count()).from(member).where(...).fetchOne();
return new PageImpl<>(content, pageable, total);

// after: 필요할 때만 실행한다 — countQuery는 아직 실행되지 않은 "쿼리 객체"로 넘긴다
JPAQuery<Long> countQuery = queryFactory
        .select(member.count())
        .from(member)
        .where(nameContains(...), statusEq(...));   // join 없음! (§3-3)

return PageableExecutionUtils.getPage(content, pageable, countQuery::fetchOne);
```

`countQuery::fetchOne`이 **메서드 참조**라는 점이 핵심이다. 넘기는 것은 결과가 아니라 **"필요하면 실행할 함수"** 이고, `getPage`가 실행 여부를 판단한다.

**언제 생략되는가.** 실제 구현은 이렇게 판정한다.

```java
// Spring Data Commons — org.springframework.data.support.PageableExecutionUtils
public static <T> Page<T> getPage(List<T> content, Pageable pageable, LongSupplier totalSupplier) {

    if (pageable.isUnpaged()) {                      // 페이징 자체가 없으면
        return new PageImpl<>(content, pageable, content.size());        // count 생략
    }

    if (isPartialPage(content, pageable)) {          // 가져온 건수 < 페이지 크기
        if (isFirstPage(pageable)) {                 //   첫 페이지라면
            return new PageImpl<>(content, pageable, content.size());    // count 생략
        } else if (!content.isEmpty()) {             //   마지막 페이지라면
            return new PageImpl<>(content, pageable,
                    pageable.getOffset() + content.size());              // count 생략
        }
    }

    return new PageImpl<>(content, pageable, totalSupplier.getAsLong()); // 여기서만 실행
}
```

말로 풀면 **"이번에 가져온 결과만 보고도 총건수를 확신할 수 있으면 안 센다"** 이다.

- **첫 페이지인데 페이지 크기(20)보다 적게(7건) 왔다** → 전체가 7건이다. 셀 필요 없음.
- **3페이지(offset 40)인데 20건 요청에 7건 왔다** → 마지막 페이지다. 총 47건.
- **20건 요청에 20건 꽉 찼다** → 뒤에 더 있을 수도 있다. **count를 실행한다.**
- **부분 페이지인데 결과가 0건이고 첫 페이지도 아니다** → 범위를 벗어난 페이지 요청이라 총건수를 추론할 수 없다. **count를 실행한다.**

> **확인 범위**: 위 코드는 로컬에 받아둔 **Spring Data Commons 3.5.13**의 `org.springframework.data.support.PageableExecutionUtils` 소스를 그대로 옮긴 것이다(가독성을 위해 `Assert` 검증부만 생략). **패키지 경로가 버전에 따라 다르다** — 오래된 프로젝트에서는 `org.springframework.data.repository.support` 아래에 있을 수 있으니 import를 확인해야 한다. 또한 javadoc이 명시하듯 **`content`는 페이지 크기 이하여야 한다** — `limit`을 적용하지 않고 넘기면 판정이 어긋난다.

**냉정하게 말하면 이 최적화가 실제로 먹히는 구간은 제한적이다.** 데이터가 많은 검색에서는 첫 페이지가 꽉 차므로 count가 그대로 나간다. 하지만 **조건을 걸어 결과가 적은 검색이 훨씬 많고**, 그 경우 쿼리 2번이 1번으로 줄어든다. 공짜로 얻는 최적화이므로 안 쓸 이유가 없다.

### 3-3. count 쿼리에서는 join을 걷어낸다

이건 위 최적화보다 효과가 크다.

```java
// before: content 쿼리를 복사해서 select만 바꾼 count 쿼리
JPAQuery<Long> countQuery = queryFactory
        .select(member.count())
        .from(member)
        .leftJoin(member.team, team)          // 결과 표시용 — 세는 데는 필요 없다
        .leftJoin(member.grade, grade)        // 정렬용 — 세는 데는 필요 없다
        .where(nameContains(...));

// after: 세는 데 필요한 것만 남긴다
JPAQuery<Long> countQuery = queryFactory
        .select(member.count())
        .from(member)
        .where(nameContains(...));            // where에 team 조건이 없다면 join도 불필요
```

**판단 기준은 단순하다 — 그 join이 `where` 조건에 쓰이는가.**

- **결과를 보여주려고 붙인 join**(팀 이름을 화면에 출력) → count에서 제거
- **정렬 때문에 붙인 join** → count에는 정렬 자체가 없으므로 제거
- **`where` 조건이 그 테이블 컬럼을 참조** → **제거하면 안 된다.** 건수가 달라진다.

`fetch join`은 애초에 count 쿼리에 있으면 안 된다. 세는 데 연관 데이터를 가져올 이유가 없고, JPQL 규칙상 문제도 된다. 관련 함정은 [fetch join + 페이징](08-fetch-join-pagination-in-memory.md)에 정리돼 있다.

**주의 하나 (가산점 포인트).** `join`(inner join)을 제거할 때는 조심해야 한다. inner join은 **매칭되는 행이 없으면 결과에서 빠지므로 그 자체가 필터**다. `leftJoin`은 건수에 영향이 없어 안전하게 제거되지만, `join`을 무심코 지우면 **총건수가 실제보다 커진다.** "화면 표시용이니까 지워도 되겠지"가 통하지 않는 경우다. 반대로 **1:N `leftJoin`이 걸려 있으면 행이 뻥튀기되어 count가 부풀려지는** 문제도 있는데, 이 역시 count에서 join을 걷어내면 자연히 해결된다.

### 3-4. `fetchResults()` / `fetchCount()`를 쓰지 않는 이유

QueryDSL에는 content와 count를 한 번에 처리해 주는 편한 메서드가 있었다.

```java
// 편하지만 쓰지 않는다
QueryResults<Member> results = queryFactory.selectFrom(member)
        .where(...)
        .offset(...).limit(...)
        .fetchResults();          // 내부적으로 count 쿼리를 자동 생성
long total = results.getTotal();
List<Member> content = results.getResults();
```

**문제는 count 쿼리를 "원본 쿼리를 변형해서" 만들어 낸다는 데 있다.** 단순한 쿼리면 잘 되지만, **`group by`가 여러 개이거나 `having`이 있으면 그 변형이 불가능하다.** 그런 경우 QueryDSL의 JPA 구현은 **count를 DB에 맡기지 않고 전체를 메모리로 가져와 `size()`를 세는 방식으로 폴백**한다. 즉 **총건수를 알려고 전건을 애플리케이션 메모리에 올린다.** 500만 건이면 그대로 OOM이다. 경고 로그가 한 줄 남지만, 이건 [fetch join + 페이징](08-fetch-join-pagination-in-memory.md)의 `HHH000104`와 성격이 완전히 같은 함정이다 — **조용히 위험해지고, 신호는 로그 한 줄뿐이다.**

그래서 처방은 **content 쿼리와 count 쿼리를 손으로 분리**하는 것이다(§3-2, §3-3). 분리하면 count 쿼리의 join·select를 내가 통제할 수 있다는 부수 이득도 따라온다.

> **확인 범위**: **Querydsl 5.1.0** 기준으로 `com.querydsl.jpa.impl.AbstractJPAQuery`의 `fetchResults()`와 `fetchCount()`는 **둘 다 `@Deprecated`** 이고, javadoc이 "multiple group by elements 또는 having이 있으면 count를 메모리에서 계산하며, 큰 결과 집합에서는 심각한 성능 저하가 있다"고 명시한다. 다만 같은 5.1.0에서 **상위 인터페이스 `com.querydsl.core.Fetchable`에는 `@Deprecated`가 붙어 있지 않다** — 즉 "JPA 구현에서 deprecated"인 상태다. deprecated 표시의 범위는 버전에 따라 달라졌으므로, **쓰지 않는 근거는 어노테이션이 아니라 위 폴백 동작 자체**로 이해하는 것이 안전하다.

또 하나. 직접 만든 count 쿼리에서 `fetchOne()`은 **결과가 없으면 `null`을 반환**하고 결과가 둘 이상이면 `NonUniqueResultException`을 던진다. `group by` 없는 순수 count는 항상 한 행이 나오지만, 방어적으로 쓰려면 이렇게 한다.

```java
Long total = countQuery.fetchOne();
return total == null ? 0L : total;
```

### 3-5. 한 층 위 — 정확한 총건수가 정말 필요한가

여기까지가 "count를 싸게 만드는 법"이라면, 시니어는 한 번 더 묻는다. **"이 화면에 총 4,821,933건이라는 숫자가 정말 필요한가?"**

대용량 검색에서 정확한 총건수는 **가장 비싼 요구사항**인데, 정작 사용자가 그 숫자를 쓰는 경우는 거의 없다. 대안들이다.

- **무한 스크롤 / "더 보기"** — 총건수 자체가 필요 없다. `Slice<T>`를 쓰면 Spring Data가 **count 쿼리를 아예 안 날린다.** `pageSize + 1`건을 가져와 "다음이 있는지"만 판정한다. **가장 근본적인 해법**이다.

  ```java
  // 총건수가 필요 없으면 Slice — count 쿼리가 없다
  List<Member> content = queryFactory.selectFrom(member)
          .where(...)
          .offset(pageable.getOffset())
          .limit(pageable.getPageSize() + 1)   // 한 건 더 가져와 다음 존재 여부만 판정
          .fetch();

  boolean hasNext = content.size() > pageable.getPageSize();
  if (hasNext) {
      content.remove(pageable.getPageSize());
  }
  return new SliceImpl<>(content, pageable, hasNext);
  ```

- **"1,000건 이상" 표기** — count에 상한을 두고 그 이상은 세지 않는다. 구글 검색 결과가 이 방식이다.
- **근사치** — 통계 테이블이나 별도 집계 배치의 값을 쓴다. 실시간 정확도를 포기하는 대신 비용이 0에 수렴한다.
- **정확한 count가 정말 필요한 화면은 따로 둔다** — 정산·감사 같은 화면은 느려도 정확해야 하고, 일반 검색 화면은 빨라야 한다. **두 요구를 같은 엔드포인트에 묶지 않는다.**

면접에서 count 최적화를 물었을 때 **"그 숫자가 필요한지부터 되묻는" 답변**은 설계 판단력을 보여주는 자리다 **(가산점 포인트)**.

### 3-6. 개별 쿼리에서 조심하는 게 아니라, 구조가 실수를 불가능하게 만든다

"조건 없이 검색하면 500만 건이 메모리에 올라오지 않겠느냐"는 지적에 대해, **"리포지토리 메서드가 항상 `Pageable`을 받는 구조라면 조건이 없어도 한 페이지 분량만 나가므로 그 문제는 발생하지 않는다"** 는 반박이 성립한다. 이건 정확한 지적이고, 더 중요하게는 **문제를 개별 케이스가 아니라 구조로 막는 사고방식**이다.

이 사고를 일반화하면 이렇게 된다.

> **"조심하겠습니다"는 대책이 아니다. 대책은 실수할 수 없게 만드는 것이다.**

검색 API에 적용할 수 있는 구조적 가드를 층별로 정리한다.

### 3-7. 가드 1 — 시그니처가 페이징을 강제한다

```java
// before: 페이징 없는 오버로드가 존재하면, 누군가는 반드시 그걸 쓴다
List<Member> search(MemberSearchCond cond);
Page<Member> search(MemberSearchCond cond, Pageable pageable);
```

```java
// after: 페이징 없는 검색은 애초에 호출할 방법이 없다
public interface MemberSearchRepository {
    Page<Member> search(MemberSearchCond cond, Pageable pageable);
}
```

**"편의를 위해" 페이징 없는 오버로드를 하나 열어두는 순간 가드가 무너진다.** 당장은 데이터가 적어서 괜찮고, 1년 뒤 그 메서드가 장애의 원인이 된다. 전체 조회가 정말 필요한 배치가 있다면 **`searchAllForBatch()`처럼 이름에 용도를 박아** 검색 API와 분리한다 — 이름이 곧 리뷰 신호가 된다.

### 3-8. 가드 2 — 페이지 크기 상한을 코드로 자른다

시그니처가 `Pageable`을 강제해도 **`size=1000000`이 들어오면 뚫린다.** `Pageable`은 클라이언트가 채우는 값이다.

```java
// 요청이 뭘 보내든 최대치를 넘길 수 없다
private static final int MAX_PAGE_SIZE = 100;

private Pageable clamp(Pageable pageable) {
    if (pageable.getPageSize() <= MAX_PAGE_SIZE) {
        return pageable;
    }
    return PageRequest.of(pageable.getPageNumber(), MAX_PAGE_SIZE, pageable.getSort());
}
```

Spring MVC를 쓴다면 애플리케이션 전역으로 걸 수도 있다.

```yaml
spring:
  data:
    web:
      pageable:
        max-page-size: 100        # 이 값을 넘는 요청은 이 값으로 잘린다
        default-page-size: 20
```

**설정과 코드 둘 다 두는 것이 안전하다.** 설정은 `@PageableDefault`가 붙은 컨트롤러 경로에만 적용되고, 서비스가 직접 `PageRequest`를 만드는 경로에는 효력이 없기 때문이다.

한 가지 더 (가산점 포인트). **깊은 페이지도 상한이 필요하다.** `offset=1000000`은 페이지 크기가 20이어도 DB가 100만 건을 건너뛰며 읽는다. 검색 화면에서 100페이지 뒤로 가는 사용자는 없으므로 **최대 페이지 번호를 제한**하거나, 정말 깊은 탐색이 필요하면 **커서 기반 페이징**(마지막으로 본 id 이후를 조회)으로 바꾼다.

### 3-9. 가드 3 — 조건 없는 전체 검색을 애초에 못 하게 한다

§1-3에서 본 "조용한 무시"의 그림자다. **조건이 전부 `null`이면 `where` 절이 통째로 사라지고, 아무도 경고하지 않는다.** 이게 이 방식의 유일한 구조적 위험이다.

대용량 검색 화면의 표준 관행은 두 가지다.

**(1) 필수 조건을 하나 강제한다.**

```java
// 조건이 하나도 없으면 쿼리를 만들기 전에 거절한다
public Page<Member> search(MemberSearchCond cond, Pageable pageable) {
    if (cond.isEmpty()) {
        throw new IllegalArgumentException("검색 조건을 하나 이상 지정해야 합니다.");
    }
    ...
}
```

`BooleanBuilder`를 쓰고 있다면 `hasValue()`로 같은 판정을 할 수 있다 — **"조건이 하나라도 담겼는가"를 물어볼 수 있다는 게 빌더의 실질적 장점**이다.

```java
BooleanBuilder builder = buildConditions(cond);
if (!builder.hasValue()) {
    throw new IllegalArgumentException("검색 조건을 하나 이상 지정해야 합니다.");
}
```

**(2) 기본 기간 조건을 자동으로 주입한다.** 거절보다 사용자 경험이 낫다.

```java
// 사용자가 기간을 안 넣으면 최근 30일로 채운다 — 화면에도 그렇게 표시한다
private BooleanExpression periodBetween(LocalDate from, LocalDate to) {
    LocalDate start = (from != null) ? from : LocalDate.now().minusDays(30);
    LocalDate end   = (to   != null) ? to   : LocalDate.now();
    return member.joinedAt.between(start.atStartOfDay(), end.atTime(LocalTime.MAX));
}
```

**여기서 이 조건 메서드는 절대 `null`을 반환하지 않는다.** 그게 핵심이다. 이 하나만으로 **"조건이 전부 비는 경우"가 구조적으로 사라진다.** 게다가 `joinedAt`에 인덱스가 있으면 이 기본 조건이 곧 인덱스 진입점이 되어 쿼리 전체가 빨라진다. 주문 조회, 로그 검색, 결제 내역 — 대용량 조회 화면이 거의 예외 없이 "조회 기간"을 필수로 두는 이유가 이것이다.

**(3) 관리자 화면이라 전체 조회가 정말 필요하다면**, 그건 검색 API가 아니라 **다운로드/배치 API**로 분리하고 비동기 처리한다. "같은 API에서 조건만 안 넣으면 전체가 나오는" 구조가 위험한 것이지, 전체 조회 자체가 죄는 아니다.

### 3-10. 세 가드를 함께 놓고 보면

```text
   요청
    │
    ▼
┌─────────────────────────────────────────────────┐
│ [가드 3] 조건이 비었나?                          │  가장 위에서 가장 많이 막는다
│          → 거절하거나 기본 기간을 주입한다        │
└───────────────────────┬─────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────┐
│ [가드 2] 페이지 크기가 상한을 넘나?               │  size=1000000 을 잘라낸다
│          → MAX_PAGE_SIZE 로 clamp                │
└───────────────────────┬─────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────┐
│ [가드 1] 페이징 없는 경로가 존재하나?             │  시그니처에 아예 없다
│          → 애초에 호출할 방법이 없다              │
└───────────────────────┬─────────────────────────┘
                        ▼
                    쿼리 실행
```

세 개는 서로를 보완한다. 가드 1만 있으면 `size=1000000`에 뚫리고, 가드 2만 있으면 count가 전건을 센다. **가드 3이 가장 위쪽에서 가장 많이 막는다.**

### 3-11. 그리고 이 가드들을 테스트로 고정한다

가드는 코드로 넣는 순간이 아니라 **누군가 무심코 지웠을 때 빌드가 깨질 때** 완성된다.

```java
@Test
void 검색_조건이_하나도_없으면_예외() {
    assertThatThrownBy(() -> repository.search(new MemberSearchCond(), PageRequest.of(0, 20)))
            .isInstanceOf(IllegalArgumentException.class);
}

@Test
void 페이지_크기는_상한을_넘지_못한다() {
    Page<Member> page = repository.search(validCond(), PageRequest.of(0, 100_000));
    assertThat(page.getSize()).isLessThanOrEqualTo(100);
}
```

ArchUnit으로 구조 자체를 룰로 박을 수도 있다 **(가산점 포인트)**.

```java
// 검색 리포지토리의 public 메서드는 반드시 Pageable을 받는다
ArchRule rule = methods()
        .that().areDeclaredInClassesThat().haveSimpleNameEndingWith("SearchRepository")
        .and().arePublic()
        .should().haveRawParameterTypes(
                DescribedPredicate.describe("Pageable을 포함",
                        types -> types.stream().anyMatch(t -> t.isAssignableTo(Pageable.class))));
```

> **확인 범위**: 위 ArchUnit 룰은 개념을 보이기 위한 스케치다. `methods()` API의 정확한 조합은 ArchUnit 버전에 따라 다르므로, 실제 적용 시 컴파일을 확인해야 한다. 요지는 **"페이징 강제를 사람의 리뷰가 아니라 빌드가 지키게 한다"** 는 것이다.

같은 계열의 안전망(쿼리 수 단정, 경고 로그를 실패로 승격, ArchUnit 구조 룰)이 [N+1 탐지와 해결](04-n-plus-one-detection-and-fixes.md), [OSIV 트레이드오프와 전환](09-osiv-tradeoff-and-migration.md), [엔티티 직접 노출과 DTO 경계](12-entity-exposure-and-dto-boundary.md)에도 정리돼 있다. **개별 문항이 아니라 이 도구 상자를 한 번에 익히는 것이 효율적이다.**

### 3-12. DTO 프로젝션 ① — `Projections.constructor`는 DTO에 아무 자국도 남기지 않는다

검색 화면은 **표시가 목적인 조회**다. 변경할 것도 아닌 엔티티를 영속성 컨텍스트에 올리면 스냅샷을 뜨고 dirty checking 대상이 되며, 응답으로 그대로 내보내면 [엔티티 직접 노출](12-entity-exposure-and-dto-boundary.md)의 모든 문제를 그대로 떠안는다. QueryDSL은 이 지점을 잘 처리한다.

여기서 **프로젝션(projection)** 이란 "행 전체가 아니라 필요한 컬럼만 뽑아 원하는 모양으로 담는 것"을 말한다. SQL의 `SELECT` 절이 하는 일 그대로이고, QueryDSL에서는 그 결과를 엔티티가 아니라 DTO로 받는 방법을 여러 가지로 제공한다.

```java
// DTO는 순수 자바 클래스 — QueryDSL을 전혀 모른다
public record MemberSearchDto(Long id, String name, String email, MemberStatus status) {}

// 조회할 때만 생성자에 매핑한다
List<MemberSearchDto> content = queryFactory
        .select(Projections.constructor(MemberSearchDto.class,
                member.id, member.name, member.email, member.status))
        .from(member)
        .where(nameContains(...), statusEq(...))
        .offset(pageable.getOffset())
        .limit(pageable.getPageSize())
        .fetch();
```

**장점은 DTO가 깨끗하다는 것.** API 응답 DTO를 그대로 쓸 수 있고, 다른 모듈로 옮겨도 QueryDSL 의존이 따라가지 않는다.

**단점은 컴파일러가 검사해 주지 않는다는 것.** 인자 개수나 타입이 생성자와 안 맞아도 **컴파일은 통과하고 실행할 때 터진다.** 필드를 하나 추가하면서 `Projections.constructor` 쪽을 안 고치면 운영에서 만난다.

### 3-13. DTO 프로젝션 ② — `@QueryProjection`은 컴파일 시점에 잡힌다

```java
public record MemberSearchDto(Long id, String name, String email, MemberStatus status) {
    @QueryProjection                                    // DTO에 QueryDSL 어노테이션이 박힌다
    public MemberSearchDto {}
}

// 어노테이션 프로세서가 QMemberSearchDto를 생성해 준다
List<MemberSearchDto> content = queryFactory
        .select(new QMemberSearchDto(member.id, member.name, member.email, member.status))
        .from(member)
        ...
```

여기서 Q클래스가 하나 더 생기는 이유는 §1-1과 같다 — **어노테이션 프로세서가 빌드 중에 만들어 준다.** `@Entity`에서 `QMember`가 나오듯, `@QueryProjection`에서 `QMemberSearchDto`가 나온다.

**장점은 타입 안전성.** 인자를 빠뜨리거나 순서를 바꾸면 **컴파일 에러**다. 필드가 늘어나면 빌드가 즉시 알려준다.

**단점은 DTO가 QueryDSL에 의존한다는 것.** `com.querydsl.core.annotations.QueryProjection` import가 DTO에 들어가고, DTO마다 Q 클래스가 하나씩 더 생성된다. **응답 DTO를 그대로 쓰면 API 계층 클래스가 영속 기술에 묶인다** — 계층 경계를 지키려고 DTO를 쓰는 건데 DTO가 다시 기술에 묶이는 아이러니다.

### 3-14. DTO 프로젝션 ③ — 그래서 어떻게 고르나

실무에서 자주 쓰는 절충은 이렇다.

- **조회 전용 내부 DTO(리포지토리 반환용)** → `@QueryProjection`. 어차피 영속 계층 안에 사는 클래스라 의존이 문제되지 않고, 컴파일 검사 이득이 크다.
- **API 응답 DTO** → 위 내부 DTO를 서비스에서 변환하거나, `Projections.constructor`. 응답 클래스에 QueryDSL 자국을 남기지 않는다.
- **필드가 많고 자주 바뀌는 조회** → `@QueryProjection`의 컴파일 검사 이득이 가장 크게 나타나는 구간이다.

`Projections.fields` / `Projections.bean`도 있지만(생성자 없이 필드나 세터로 채움), **이름이 안 맞으면 조용히 `null`로 채워지므로** 앞의 두 방식보다 위험하다. 검색 결과의 특정 컬럼이 항상 `null`로 나오는 버그가 여기서 나온다.

**그리고 DTO 프로젝션은 그 자체로 성능 최적화다.** 필요한 컬럼만 SELECT하고, 영속성 컨텍스트에 담기지 않아 스냅샷 비용이 없다. 목록 조회에서 엔티티 대신 DTO를 쓰는 이유의 절반이 이것이다 — [엔티티 직접 노출과 DTO 경계](12-entity-exposure-and-dto-boundary.md)와 [영속성 컨텍스트와 dirty checking](02-persistence-context-dirty-checking.md)에 더 자세히 있다.

### 3-15. 함정 ① — Q타입이 안 생긴다 (가장 흔한 첫 관문)

`QMember`를 import할 수 없다는 컴파일 에러로 시작한다. §1-1에서 봤듯 Q타입은 **어노테이션 프로세서가 빌드 중에 생성하는 코드**라, 프로세서가 안 돌면 존재하지 않는다.

```gradle
// Spring Boot 3 / Jakarta 기준 — classifier가 핵심이다
dependencies {
    implementation "com.querydsl:querydsl-jpa:5.1.0:jakarta"
    annotationProcessor "com.querydsl:querydsl-apt:5.1.0:jakarta"
    annotationProcessor "jakarta.annotation:jakarta.annotation-api"
    annotationProcessor "jakarta.persistence:jakarta.persistence-api"
}
```

**깨지는 지점 세 가지.**

- **`jakarta` classifier 누락.** Spring Boot 3는 `jakarta.persistence`를 쓰는데 classifier 없는 아티팩트는 `javax.persistence` 기준이라 **`@Entity`를 못 알아본다.** 에러가 안 나고 **Q타입이 그냥 안 생기는** 형태로 실패해서 원인을 찾기 어렵다.
- **`implementation`에 apt를 넣는 것.** 프로세서는 `annotationProcessor` 스코프여야 실행된다.
- **IDE와 Gradle의 생성 경로 불일치.** IDE는 컴파일되는데 CI에서 깨지거나 반대가 된다. `./gradlew clean build`로 확인하는 습관이 필요하고, Q타입 디렉토리는 **생성물이므로 `.gitignore`에 넣는다.**

> **확인 범위**: 위 좌표(`querydsl-jpa:5.1.0:jakarta`, `querydsl-apt:5.1.0:jakarta`)는 로컬 Gradle 캐시에 실제로 존재하는 아티팩트로 확인했다. 그리고 이 apt 아티팩트는 `META-INF/services/javax.annotation.processing.Processor`에 `com.querydsl.apt.jpa.JPAAnnotationProcessor`를 등록하고 있으므로 **프로세서를 별도 옵션으로 지정할 필요가 없다.** 다만 Gradle 버전과 프로젝트 구성에 따라 추가 설정이 필요한 경우가 있으니, 정확한 스니펫은 사용 중인 버전 조합에서 검증해야 한다.

### 3-16. 함정 ② — 문자열 `Expressions`로 도망가면 타입 안전성이 사라진다

QueryDSL로 표현하기 어려운 함수를 만나면 이런 유혹이 온다.

```java
// QueryDSL을 쓰는 이유가 사라지는 코드
.where(Expressions.stringTemplate("function('json_extract', {0}, '$.type')", member.meta)
        .eq("VIP"))
```

동작은 한다. 하지만 **컬럼 이름을 바꿔도 컴파일러가 안 잡아주고, 오타는 런타임 에러이며, DB 방언이 바뀌면 깨진다.** QueryDSL을 도입한 이유가 "문자열 조립을 없애는 것"이었는데 그 자리로 돌아간 셈이다. §1-1에서 말한 "컴파일 타임에 오타를 잡는다"는 이점을 스스로 반납하는 코드다.

**허용 기준**: 벤더 고유 함수처럼 정말 표현 수단이 없을 때만, **한 곳에 격리해서** 쓴다. `MemberExpressions.metaTypeEq(String type)` 같은 메서드로 감싸면 문자열이 한 군데에만 존재하고 §2-4처럼 테스트도 붙일 수 있다. **문자열이 리포지토리 곳곳에 흩어지는 것이 문제**지, 존재 자체가 문제는 아니다.

### 3-17. 함정 ③ — 동적 정렬(`OrderSpecifier`)을 사용자 입력으로 받을 때

"정렬 컬럼을 클라이언트가 지정한다"는 요구는 흔하다. 그리고 여기서 가장 위험한 코드가 나온다.

```java
// 최악: 사용자 문자열이 그대로 쿼리 조각이 된다 — SQL 주입 경로
.orderBy(Expressions.stringTemplate(request.getSortExpr()).asc())

// 나쁨: 주입까지는 아니어도, 엔티티의 모든 필드로 정렬할 수 있게 된다
PathBuilder<Member> path = new PathBuilder<>(Member.class, "member");
.orderBy(new OrderSpecifier(Order.ASC, path.get(request.getSortField())))
```

두 번째가 왜 문제인가. **정렬 결과로 값을 추론할 수 있다.** `sortField=password`나 `sortField=ssn`으로 정렬한 목록을 여러 번 조회하면 값의 순서 정보가 새어 나가고, 없는 필드를 넣으면 런타임 예외로 **내부 구조가 에러 메시지에 노출**된다.

```java
// 화이트리스트 — 허용된 이름만 미리 만들어 둔 OrderSpecifier로 매핑한다
private static final Map<String, OrderSpecifier<?>> SORTS = Map.of(
        "name",     member.name.asc(),
        "joinedAt", member.joinedAt.desc(),
        "grade",    member.grade.asc());

private OrderSpecifier<?> toOrder(String key) {
    OrderSpecifier<?> order = SORTS.get(key);
    return order != null ? order : member.id.desc();   // 기본 정렬로 폴백
}
```

**원칙은 하나다 — 사용자 입력은 "정렬 기준을 고르는 키"일 뿐, 쿼리 조각이 아니다.** Spring Data의 `Sort`를 그대로 QueryDSL 경로로 변환할 때도 같은 검증이 필요하다.

**정렬에 관한 실무 팁 하나 (가산점 포인트).** 페이징에서 **정렬이 고유하지 않으면 페이지 간 중복·누락이 생긴다.** `joinedAt`으로만 정렬했는데 같은 시각 가입자가 여러 명이면, DB가 매 쿼리마다 순서를 다르게 줄 수 있어 2페이지에 1페이지 항목이 다시 나온다. **정렬 마지막에 항상 `id`를 붙여 전순서를 만든다** — `.orderBy(member.joinedAt.desc(), member.id.desc())`.

## 4. 꼬리질문 대비 포인트

### "`where()`에 `null`을 넘기면 무시되는데, 그럼 실수로 `null`이 들어가도 아무도 모르는 것 아닌가요?"

**맞다. 그게 이 방식의 유일한 구조적 약점이다.** 예외도 로그도 없이 조건 하나가 사라지므로, "왜 검색 결과가 이상하게 많지?"라는 증상으로만 드러난다. 특히 `Expressions.anyOf(...)`로 만든 `OR` 그룹이 통째로 사라지면 결과가 크게 넓어진다(§2-5).

세 가지로 막는다. **첫째, 조건 메서드에 단위 테스트를 붙인다**(§2-4) — "값이 있으면 `null`이 아니다"를 명시적으로 검사한다. **둘째, 절대 `null`을 반환하면 안 되는 조건은 그렇게 설계한다** — 기본 기간 주입(§3-9)처럼 항상 값을 만드는 메서드는 `null` 분기 자체가 없다. **셋째, 최소 한 개의 조건이 있어야 실행되도록 전체를 검증한다**(§3-9). **핵심은 "조용한 무시"를 없애는 게 아니라 — 그건 라이브러리 계약이라 못 바꾼다 — 조용히 무시돼도 결과가 위험하지 않게 구조를 짜는 것이다.**

### "`BooleanBuilder`와 `BooleanExpression` 메서드 중 어느 쪽이 낫습니까?"

**대체재가 아니라 용도가 다르다**고 답한다. 조건이 컴파일 시점에 정해져 있고 `AND`로만 묶이면 메서드 분리가 명백히 낫다 — `if`가 사라지고 조건마다 이름이 생기며 재사용·테스트가 가능해진다. 반면 **조건의 개수나 연산자가 런타임에 결정되는 경우**(사용자 정의 필터 규칙을 DB에서 읽어 조립) 반복문 안에서 누적해야 하므로 `BooleanBuilder`가 정직하다.

**근거를 한 겹 더 대면 좋다.** 차이의 뿌리는 **통과 값**이다. 빌더는 조건을 쌓는 가변 통이라 결과가 통 안에 갇히고, `BooleanExpression`은 불변 값이라 합성·재사용·단위 테스트가 열린다(§2-1~2-4).

**실무에서는 섞어 쓴다.** `BooleanBuilder`도 `and(null)`을 무시하므로(§1-4), 빌더를 뼈대로 두고 담기는 조건은 `BooleanExpression` 메서드로 만들면 양쪽 장점을 다 가진다. 그리고 빌더에만 있는 `hasValue()`는 "조건이 하나라도 있는가"를 물어볼 수 있어 §3-9의 가드에 그대로 쓰인다.

### "조건들을 `.and()`로 이어 붙였더니 가끔 `NullPointerException`이 납니다. 왜죠?"

**`a.and(null)`은 안전하지만 `null.and(b)`는 NPE**이기 때문이다(§1-4, §2-5). `nameEq(name).and(statusEq(status))`에서 사용자가 이름을 안 넣으면 `nameEq`가 `null`을 반환하고, 그 `null`에 `.and()`를 호출하는 순간 터진다. **`null`을 인자로 넘기는 것은 안전하고, `null`에 점을 찍는 것이 위험하다**로 외우면 헷갈리지 않는다.

고약한 점은 **개발자는 항상 조건을 채워서 테스트하므로 운영에서 처음 만난다**는 것이다. 처방은 `Expressions.allOf(nameEq(name), statusEq(status))` — `allOf`는 `rv == null ? b : rv.and(b)` 형태라 **선행 `null`을 건너뛰고 후행 `null`도 무해하며, 전부 `null`이면 `null`을 반환**해 `where()`에서 자연히 사라진다. `OR`가 필요하면 `anyOf`가 같은 성질을 갖는다. 값으로 돌려줄 필요가 없다면 `BooleanBuilder`에 `and()`로 담는 것도 같은 효과다.

### "`Page`를 반환할 때 count 쿼리를 줄이는 방법은?" (시니어 변별 포인트)

**세 층으로 답한다.**

**1층 — 실행 자체를 생략한다.** `PageableExecutionUtils.getPage(content, pageable, countQuery::fetchOne)`는 count를 **함수로** 받아, 결과만 보고 총건수를 확신할 수 있으면 실행하지 않는다. 첫 페이지인데 페이지 크기보다 적게 왔으면 그게 전체이고, 중간 페이지인데 덜 왔으면 `offset + 가져온 수`가 전체다(§3-2).

**2층 — 실행되는 count를 싸게 만든다.** content 쿼리를 복사해 `select`만 바꾸면 표시용·정렬용 join이 그대로 따라간다. **`where`에 쓰이지 않는 `leftJoin`은 전부 제거**한다. 단 **inner join은 그 자체가 필터**라 지우면 건수가 달라지고, `fetch join`은 count에 있어선 안 된다(§3-3). 그리고 `fetchResults()`는 쓰지 않는다 — `group by`가 여럿이거나 `having`이 있으면 **전건을 메모리에 올려 세는 방식으로 폴백**한다(§3-4).

**3층 — 요구사항 자체를 되묻는다.** 이 층이 시니어의 자리다. "총 4,821,933건"이라는 숫자가 사용자에게 필요한가? 무한 스크롤이면 `Slice`로 count를 아예 없앨 수 있고, "1,000건 이상" 표기나 배치 집계 근사치로 대체할 수도 있다. **정확한 총건수가 정말 필요한 화면(정산·감사)과 빨라야 하는 화면(일반 검색)을 같은 엔드포인트에 묶지 않는 것**이 근본 처방이다(§3-5).

### "검색 조건을 하나도 안 넣고 조회하면 어떤 쿼리가 나갑니까? 위험하지 않나요?" (시니어 변별 포인트)

**`where` 절이 통째로 사라진 전체 조회가 나간다.** 다만 위험의 크기는 **구조에 따라 다르다**는 점을 함께 말해야 정확하다.

리포지토리 메서드가 항상 `Pageable`을 받아 `offset`/`limit`을 적용하는 구조라면 **content 쿼리는 한 페이지 분량만 가져오므로 OOM은 구조적으로 발생하지 않는다.** 남는 위험은 두 가지다 — **`Page`를 반환할 때의 count 쿼리가 전건을 세는 것**과, **깊은 `offset`이 DB에서 앞부분을 건너뛰며 읽는 비용**이다.

그래서 답은 세 겹이다. **① 페이징을 시그니처로 강제**해 페이징 없는 경로를 아예 없앤다(편의용 오버로드를 하나라도 열어두면 누군가 반드시 그걸 쓴다). **② 페이지 크기를 코드에서 clamp**한다 — `Pageable`은 클라이언트가 채우는 값이라 `size=1000000`이 들어올 수 있다. **③ 가장 위에서 조건 없는 검색을 막는다** — 필수 조건 하나를 강제하거나 기본 기간을 자동 주입한다. 특히 기본 기간 주입은 `null`을 절대 반환하지 않는 조건이 하나 생기는 것이라 **"조건이 전부 비는 경우"가 구조적으로 사라지고**, 인덱스 진입점까지 덤으로 얻는다(§3-6~3-10).

**"조심하겠습니다"가 아니라 "그렇게 호출할 방법이 없습니다"로 답하는 것**이 이 질문의 핵심이고, 그 가드들은 테스트와 ArchUnit 룰로 고정해야 완성된다.

### "동적 정렬을 클라이언트가 지정하게 하려는데 주의할 점은?" (가산점 포인트)

**사용자 입력은 정렬 기준을 고르는 키일 뿐, 쿼리 조각이 아니다.** `Expressions.stringTemplate(사용자입력)`은 문자열이 그대로 쿼리에 들어가는 **주입 경로**이고, `PathBuilder.get(사용자입력)`도 안전하지 않다 — 엔티티의 아무 필드로나 정렬할 수 있게 되어 정렬 순서로 값을 추론당하거나, 없는 필드는 런타임 예외로 내부 구조를 노출한다. **허용 키 → 미리 만들어 둔 `OrderSpecifier` 맵**으로 화이트리스트하고, 매칭 실패 시 기본 정렬로 폴백한다.

그리고 **정렬은 고유해야 한다.** 동점이 생길 수 있는 컬럼으로만 정렬하면 페이지 간에 항목이 중복되거나 누락된다. 마지막에 항상 `id`를 붙여 전순서를 만든다(§3-17).

---

## 한 줄 요약

**QueryDSL 동적 쿼리는 `where()`에 넘긴 `null`이 예외도 0건도 아닌 "그 조건만 사라짐"으로 처리된다는 성질 하나 위에 서 있다 — 그래서 조건마다 `BooleanExpression`을 반환하는 메서드를 만들어 `where()`에 나열하면 `if`가 전부 없어지고, 더 중요하게는 조건이 값이 되어 `and()`로 합성되고 다른 쿼리에서 재사용되며 DB 없이 단위 테스트된다(단 `null.and(...)`은 NPE이므로 `Expressions.allOf`로 감싼다). `BooleanBuilder`는 열등한 대안이 아니라 조건 트리를 런타임에 조립할 때 쓰는 다른 도구고, 페이징에서는 count를 `PageableExecutionUtils`로 생략하고 join을 걷어내되 그전에 "그 총건수가 정말 필요한가"를 되물어야 하며, 궁극적으로는 개별 쿼리에서 조심하는 대신 페이징 강제 시그니처·페이지 크기 clamp·필수 조건 검증으로 조건 없는 전체 검색을 호출할 방법 자체를 없애는 것이 답이다.**
