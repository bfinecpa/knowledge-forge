# Soft delete와 유니크 제약·연관관계 조회 — 행을 안 지우기로 한 대가는 어디서든 청구된다

> 핵심 관전 포인트: 이 문항의 모든 증상은 **한 문장**에서 파생된다 — **"삭제했다"는 것은 우리 애플리케이션의 약속일 뿐, DB도 JPA도 그런 개념을 모른다.** DB 입장에서 탈퇴 회원의 행은 **여전히 존재하는 멀쩡한 행**이므로 `UNIQUE(email)`을 계속 점유한다. 그래서 "탈퇴했는데 재가입이 안 돼요"가 나온다. 같은 이유로 JPA는 `post.getComments()`를 채울 때 **FK만 보고 `where post_id = ?`로 자식 행을 전부** 긁어오므로 삭제된 댓글이 딸려온다. 해법은 두 갈래다. **연관관계 쪽**은 하이버네이트의 **`@SQLRestriction("deleted = false")`**(구버전 `@Where`)를 걸어 그 엔티티·컬렉션을 읽는 **모든 SQL에 조건을 자동으로 덧붙이고**, 짝인 **`@SQLDelete`**로 `delete` 호출을 UPDATE로 바꿔 세트를 완성한다(하이버네이트 6.4의 **`@SoftDelete`**는 이 둘을 하나로 묶은 것). **다만 그 대가는 "끌 수 없다"** — 조건이 전역으로 박히므로 **삭제된 데이터를 봐야 하는 관리자 화면·통계에서 우회할 방법이 애노테이션 차원에 없고**, 네이티브 쿼리나 별도 조회 경로를 따로 파야 한다. 중급 Q5의 `@JsonIgnore`가 "엔티티에 박히는 전역 스위치"라 실패했던 것과 **정확히 같은 성격의 함정**이다. **유니크 쪽**은 DB가 갈린다 — **PostgreSQL은 부분 유니크 인덱스** 한 줄(`CREATE UNIQUE INDEX ... ON member(email) WHERE deleted = false`)로 끝나고, **MySQL에는 그 기능이 없어서** 이메일 변형·복합 유니크 같은 우회로가 필요한 것이다. 우회로에는 다시 함정이 있다 — `deleted`가 **boolean이면 두 번째 탈퇴에서 다시 충돌**하고, `deleted_at`으로 바꾸면 **활성 행의 `NULL`끼리는 서로 다르다고 취급되어 "같은 이메일 활성 회원 2명"을 못 막는** 새 구멍이 열린다. 그래서 실질적인 정답은 **삭제 구분자를 "충돌할 수 없는 값"으로 만드는 것**(랜덤값, 삭제 순번, `deleted_seq = id`)이고, 규모가 커지면 **아카이브 테이블 분리**가 유니크·조회 조건·인덱스 문제를 **한꺼번에** 없앤다. 그리고 soft delete를 택한 이상 **모든 조회에 조건이 붙으므로 복합 인덱스 선두에 `deleted`를 넣어야 하고**, 데이터는 계속 쌓이며, 집계 쿼리에서 조건 하나를 빠뜨리면 **숫자가 조용히 틀린다.**

---

## 0. 질문 + 의도

**질문**: "Soft delete를 구현할 때 유니크 제약과 연관관계 조회는 어떻게 처리하나요?"

관련 질문:
"`member(id, email VARCHAR UNIQUE, deleted BOOLEAN)` 구조입니다. '탈퇴했다가 재가입하려는데 이미 사용 중인 이메일이라고 나온다'는 CS가 들어왔습니다. 왜 그렇고 어떻게 해결하겠습니까?"
"`Post` 1:N `Comment`에서 댓글도 soft delete인데 `post.getComments()`에 삭제된 댓글까지 딸려 옵니다. 왜 그렇고 어떻게 처리합니까?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**삭제된 행이 유니크 제약을 계속 점유해 '탈퇴했는데 재가입이 안 돼요'가 되는 실무 함정. 삭제를 '행 제거'가 아닌 도메인 상태로 다룰 때의 대가를 설계에 반영하는지 본다.**" 즉 채점 지점은 "soft delete를 아느냐"가 아니다. 그건 다 안다. 채점 지점은 **"안 지우기로 결정한 순간 어디어디에 청구서가 날아오는지를 미리 세어봤느냐"**다. 청구서는 최소 네 곳에서 온다 — **유니크 제약, 연관관계 조회, 인덱스, 집계**. 그리고 그 청구서를 **애플리케이션 코드로 막을지, 스키마로 막을지, 아니면 애초에 soft delete를 그만둘지**를 근거와 함께 고를 수 있느냐가 상·중을 가른다.

**함정 네 개**:
- **"JPA에 그런 기능이 있겠지"에서 멈추는 것.** 있다(`@SQLRestriction`/`@SQLDelete`/`@SoftDelete`). 그런데 그 도구의 **이름을 대지 못하면 "설계 감각은 있는데 손에 도구가 없는 사람"**으로 보이고, 더 중요하게는 **그 도구가 무엇을 못 하는지**(= 끌 수 없다)를 말할 수 없다.
- **`deleted` boolean으로 복합 유니크를 만들면 끝났다고 믿는 것.** 첫 번째 재가입까지는 통한다. **두 번째 탈퇴에서 다시 터진다**(§2-2).
- **`deleted_at`으로 바꾸면 해결됐다고 믿는 것.** 유니크 제약에서 **`NULL`은 서로 다른 값**이므로, 이 순간 "활성 회원 중복"이라는 **더 나쁜 구멍**이 열린다(§3).
- **삭제된 자식이 딸려오는 것을 애플리케이션에서 `filter`로 걸러내는 것.** 화면은 맞아지지만 **이미 전부 읽어온 뒤**라 I/O·메모리 비용은 그대로다. 조건은 **DB로 내려가야** 의미가 있다(§4-1).

> **이 문항에서 이미 도달해 있는 지점**(면접 기록 기준): 이메일 변형 → 랜덤값 → 복합 유니크 → boolean의 한계 인지 → `deleted_at`/순번 정수까지, **유도할 때마다 정확히 한 칸씩 전진했고 전부 실무에서 실제로 쓰이는 해법**이었다. 특히 면접관이 제시한 `deleted_at` 해법에 대해 **"초 단위면 마우스 두 번 클릭을 못 막는 것 아닌가"**라고 **정밀도 허점을 되받은 것**은 이 문항의 백미다(그 지적은 §3-3에서 정확히 맞다). 그러니 이 문서가 채울 것은 판단이 아니라 **① 도구 이름과 그 대가 ② 컬렉션에 딸려오는 메커니즘 ③ 부분 유니크 인덱스 ④ `NULL`과 유니크 제약의 상호작용**, 이 네 가지다.

---

## 1. 뿌리는 한 문장이다 — DB도 JPA도 "삭제됨"을 모른다

### 1-1. 재가입이 막히는 순간을 행 상태로 추적한다

스키마는 이렇다.

```sql
CREATE TABLE member (
  id      BIGINT       PRIMARY KEY AUTO_INCREMENT,
  email   VARCHAR(255) NOT NULL,
  deleted BOOLEAN      NOT NULL DEFAULT FALSE,
  UNIQUE KEY uk_member_email (email)      -- ← 문제의 진원지
);
```

`hong@a.com`이 가입 → 탈퇴 → 재가입을 시도하는 동안 테이블이 어떻게 변하는지 그대로 따라간다.

| 순서 | 동작 | 실행되는 SQL | 테이블 상태 | 결과 |
|---|---|---|---|---|
| ① | 가입 | `INSERT INTO member(email, deleted) VALUES('hong@a.com', false)` | `(1, hong@a.com, false)` | OK |
| ② | 탈퇴 | `UPDATE member SET deleted = true WHERE id = 1` | `(1, hong@a.com, true)` ← **행은 그대로 남아 있다** | OK |
| ③ | 재가입 | `INSERT INTO member(email, deleted) VALUES('hong@a.com', false)` | — | ✖ **`Duplicate entry 'hong@a.com' for key 'uk_member_email'`** |

②를 보라. **우리는 "지웠다"고 생각하지만 DB가 한 일은 컬럼 하나를 `true`로 바꾼 UPDATE 한 줄**이다. 인덱스에서 `hong@a.com` 항목은 **1밀리초도 빠진 적이 없다.** 그러니 ③이 막히는 것은 버그가 아니라 **우리가 시킨 대로 정확히 동작한 것**이다.

> 비유하자면 이렇다. 도서관에서 책을 **반납·폐기 처리**하면서 실제로는 서가에서 빼지 않고 **표지에 "폐기됨" 스티커만 붙였다.** 서가의 자리(= 유니크 인덱스의 자리)는 그대로 점유돼 있다. 같은 청구기호로 새 책을 꽂으려 하면 사서(= DB)는 "그 자리엔 이미 책이 있습니다"라고 답한다. 사서는 스티커를 읽지 않는다. **스티커의 의미는 우리끼리만 아는 규칙**이기 때문이다.

### 1-2. "우리끼리 아는 규칙"이라는 말의 정확한 의미

soft delete는 **표준 SQL에도 JPA 명세에도 존재하지 않는 개념**이다. 우리가 한 일은 이것뿐이다.

```
우리가 실제로 한 일:
  1. boolean 컬럼을 하나 만들었다
  2. "이 컬럼이 true면 없는 셈 치자"고 팀 안에서 약속했다

그 약속을 아는 주체:
  ✅ 우리가 직접 쓴 애플리케이션 코드 (where deleted = false 를 붙인 것들)
  ❌ DB 엔진 (유니크 제약, FK, ON DELETE CASCADE, 집계 함수 — 전부 모른다)
  ❌ JPA/하이버네이트 (연관관계 로딩, findAll, count — 전부 모른다)
  ❌ 다른 팀의 배치 잡, 리포팅 쿼리, BI 도구, 운영자의 수동 SQL
```

**이 목록이 이 문항의 전부다.** 유니크 제약이 막는 것도, 컬렉션에 삭제된 자식이 딸려오는 것도, 통계 숫자가 틀리는 것도 전부 **"약속을 모르는 주체가 자기 일을 정상적으로 했을 뿐"**이라는 하나의 원인에서 나온다.

그래서 처방의 방향도 둘로 정해진다.

1. **약속을 DB에 알려준다** — 부분 유니크 인덱스(§2-3), 생성 컬럼(§2-3), 아카이브 테이블 분리(§2-4).
2. **약속을 ORM에 알려준다** — `@SQLRestriction`/`@SQLDelete`/`@SoftDelete`(§4).

**둘 다 필요하다.** ORM에만 알려주면 유니크 제약은 여전히 막히고, DB에만 알려주면 컬렉션에 삭제된 자식이 계속 딸려온다.

---

## 2. 유니크 해법 4종 — DDL과 "포기하는 것"을 같이 적는다

네 가지 모두 실무에서 쓰인다. **우열이 아니라 조건이 다르다.** 각각 DDL, 마이그레이션 주의점, 얻는 것과 포기하는 것을 같이 적는다.

### 2-1. 해법 ① — 삭제 시 이메일 값을 변형한다 (애플리케이션 층)

가장 먼저 떠오르고, 실제로 가장 많이 쓰이는 방법이다. **탈퇴할 때 `email` 값 자체를 충돌하지 않는 값으로 바꿔버린다.**

```java
// ❌ BEFORE — 상수 접미사. 같은 사람이 두 번 탈퇴하면 다시 충돌한다.
public void withdraw(Member m) {
    m.setDeleted(true);
    m.setEmail(m.getEmail() + "_deleted");   // 두 번째 탈퇴 → 'hong@a.com_deleted' 중복
}

// ✅ AFTER — 충돌할 수 없는 값을 섞는다.
public void withdraw(Member m) {
    m.setDeleted(true);
    m.setDeletedAt(LocalDateTime.now());
    m.setOriginalEmail(m.getEmail());        // ← 원본은 별도 컬럼에 보존 (아래 설명)
    m.setEmail("deleted:" + m.getId() + ":" + m.getEmail());
}
```

**접미사를 무엇으로 할 것인가**가 유일한 설계점이다.

| 후보 | 충돌 가능성 | 비고 |
|---|---|---|
| 고정 문자열(`_deleted`) | **있음** — 두 번째 탈퇴에서 즉시 충돌 | 쓰면 안 된다 |
| 랜덤값(UUID) | 사실상 없음 | 가장 흔한 선택 |
| **PK(`id`)** | **없음(구조적으로 보장)** | id는 그 자체로 유일하다 |
| 삭제 시각 | **정밀도에 달림** | §3-3의 함정 |

**PK를 쓰는 쪽이 랜덤값보다 낫다.** 랜덤값은 "확률적으로 충돌하지 않는다"지만 **PK는 정의상 유일하므로 충돌이 구조적으로 불가능**하고, 값을 보면 어느 행에서 왔는지 바로 읽힌다.

**DDL**: 없다. 제약은 `UNIQUE(email)` 그대로 두고 애플리케이션만 바꾼다. 다만 접두사가 붙으므로 **컬럼 길이 여유**를 확인해야 한다(`VARCHAR(255)`에 이메일이 240자면 넘친다).

**마이그레이션 주의점**: 이미 `_deleted` 상수 접미사로 쌓인 데이터가 있다면 **접미사 규칙을 바꾸는 순간 기존 행과 새 행의 형식이 섞인다.** "원본 이메일이 무엇이었는지" 되짚는 로직(예: CS 담당자가 재가입 이력을 찾는 조회)이 **두 형식을 모두 파싱해야** 한다. 그래서 아래가 사실상 필수다.

**포기하는 것 — 이게 이 방법의 진짜 비용이다.** **원본 이메일이 사라진다.** 그러면 이런 요구를 못 받는다.

- "이 사람 예전에 가입한 적 있나요?"(재가입 이력 연결)
- "탈퇴 회원에게 발송한 메일 이력을 이메일로 조회해 주세요"(감사·컴플라이언스)
- "탈퇴를 취소하고 계정을 복구해 주세요"(원본을 못 되돌린다)

**처방은 `original_email` 같은 컬럼을 따로 두고 원본을 그대로 보존하는 것**이다. 그러면 `email`은 "유니크 제약을 만족시키기 위한 슬롯"이 되고, 의미 있는 값은 `original_email`이 갖는다. **이 순간 "왜 굳이 값을 훼손하지?"라는 질문이 자연스럽게 나오고**, 그 답이 다음 해법들이다 — **값은 그대로 두고 제약 쪽을 바꾸자.**

### 2-2. 해법 ② — 복합 유니크 + 삭제 구분자 (스키마 층, MySQL의 현실적 답)

`email` 값을 건드리지 않고 **유니크 키에 컬럼을 하나 더 넣는다.** 방향은 정확한데, **구분자를 무엇으로 두느냐**가 성패를 가른다.

**먼저 boolean으로 하면 왜 안 되는지**를 행 상태로 본다.

```sql
UNIQUE KEY uk_member_email_deleted (email, deleted)   -- deleted BOOLEAN
```

| 순서 | 동작 | 삽입/변경되는 키 | 테이블 상태 | 결과 |
|---|---|---|---|---|
| ① | 가입 | `(hong@a.com, false)` | `(1, hong@a.com, false)` | OK |
| ② | 탈퇴 | `(hong@a.com, true)` | `(1, hong@a.com, true)` | OK |
| ③ | **재가입** | `(hong@a.com, false)` | `(1, …, true)`, `(2, …, false)` | **OK — 해결된 것처럼 보인다** |
| ④ | **재탈퇴** | `(hong@a.com, true)` | ①번 행이 이미 `(hong@a.com, true)` | ✖ **다시 충돌** |

**boolean은 값이 두 개뿐이라 슬롯도 두 개뿐**이다. `(email, false)` 하나와 `(email, true)` 하나까지만 공존하고, **삭제된 행이 두 개가 되는 순간 무너진다.** 첫 재가입까지만 통하기 때문에 **QA를 통과하고 운영에서 터지는** 전형적인 유형이다.

**그래서 구분자를 "삭제될 때마다 달라지는 값"으로 바꿔야 한다.** 후보는 둘이다.

```sql
-- (A) 삭제 시각          → NULL 함정이 따라온다 (§3)
ALTER TABLE member ADD COLUMN deleted_at DATETIME(6) NULL;
ALTER TABLE member ADD UNIQUE KEY uk_member_email_deleted_at (email, deleted_at);

-- (B) 삭제 순번(정수)    → 활성은 0, 삭제될 때마다 유일한 값 (권장)
ALTER TABLE member ADD COLUMN deleted_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE member ADD UNIQUE KEY uk_member_email_deleted_seq (email, deleted_seq);
```

**(B)를 권장하는 이유**는 `NOT NULL`이라 §3의 `NULL` 함정이 원천적으로 없고, 값을 **`id`로 채우면 채번 경쟁조차 없기 때문**이다.

```java
// 삭제 순번을 자기 PK 로 채운다 — id 는 유일하므로 (email, deleted_seq) 도 반드시 유일하다.
// "max(deleted_seq) + 1" 같은 채번은 동시성에서 다시 경쟁이 생기므로 쓰지 않는다.
public void withdraw(Member m) {
    m.setDeletedSeq(m.getId());
    m.setDeletedAt(LocalDateTime.now());   // 시각은 "언제 지웠나"라는 정보로만 쓴다
}
```

여기서 **역할을 분리한 것이 핵심**이다. `deleted_at`은 **정보**(언제 탈퇴했나 — 보존 기간 계산·통계에 쓴다), `deleted_seq`는 **제약 만족용 슬롯**이다. 하나의 컬럼에 두 역할을 겸하게 하면 §3의 사고가 난다.

**마이그레이션 주의점 (중요)**:
1. **기존 `UNIQUE(email)`을 반드시 제거해야 한다.** 복합 유니크를 새로 추가해도 **단일 유니크가 남아 있으면 여전히 막힌다.** "제약을 추가했는데 안 고쳐졌다"는 문의의 대부분이 이것이다.
2. **제약을 지우는 순간부터 새 제약이 걸리기 전까지의 틈**에 중복이 들어올 수 있다. 한 마이그레이션 안에서 `DROP` + `ADD`를 함께 수행한다.
3. **기존 삭제 행의 `deleted_seq`를 채워야 한다** — 전부 기본값 `0`이면 삭제된 동일 이메일 행들끼리 충돌해 **인덱스 생성 자체가 실패**한다. `UPDATE member SET deleted_seq = id WHERE deleted = true;`를 먼저 돌린다.
4. 대형 테이블에서 인덱스 재생성은 **온라인 DDL 지원 여부와 락 시간**을 확인하고 트래픽이 적은 시간에 한다.

**얻는 것**: 이메일 원본이 그대로 남는다(감사·복구·이력 연결 전부 가능). **포기하는 것**: 유니크 키가 넓어지고(인덱스 크기·쓰기 비용 증가), **스키마에 "삭제"라는 도메인 개념이 새어 들어온다.** 그리고 **활성 중복을 막는 책임이 `deleted_seq = 0` 규약에 달려 있다** — 누군가 활성 행에 `0`이 아닌 값을 넣는 순간 같은 이메일 활성 회원이 두 명 생긴다. **규약이 제약을 대신하는 지점이 생겼다**는 뜻이고, 이건 다음 해법이 없애준다.

### 2-3. 해법 ③ — 부분 유니크 인덱스 (PostgreSQL) / 생성 컬럼 (MySQL)

**PostgreSQL이라면 이 문항은 한 줄로 끝난다.**

```sql
-- 활성 행에만 유니크를 건다. 삭제된 행은 인덱스에 아예 들어가지 않는다.
CREATE UNIQUE INDEX uk_member_email_active ON member (email) WHERE deleted = false;
```

**`WHERE` 절이 붙은 인덱스**를 부분 인덱스(partial index)라 한다. 조건에 맞는 행만 인덱스에 넣는다. 그러니 **삭제된 행은 인덱스에 존재하지 않고**, 몇 번을 탈퇴하든 자리를 점유하지 않는다. 이메일을 변형할 필요도, 복합 유니크를 만들 필요도, `deleted_seq` 규약을 지킬 필요도 **전부 사라진다.**

> **인과를 정확히 말하는 것이 중요하다**: 앞의 §2-1·§2-2가 "우회로"인 이유는 그것들이 열등한 발상이라서가 아니라 **MySQL에 부분 유니크 인덱스가 없기 때문**이다. 면접에서 "MySQL이라 이 방법을 못 써서 복합 유니크로 갑니다"라고 말하면 **DB 벤더 차이를 알고 선택한 사람**이 되고, 그냥 "복합 유니크로 합니다"라고 하면 **아는 방법이 그것뿐인 사람**이 된다. 같은 결론인데 평가가 갈리는 자리다.

**부가 이득 (가산점 포인트)**: 부분 인덱스는 **일반 조회 인덱스에도 그대로 쓸 수 있다.** soft delete 서비스는 어차피 거의 모든 쿼리에 `deleted = false`가 붙으므로, 인덱스도 활성 행만 담으면 **인덱스 크기가 활성 비율만큼 줄고 캐시 적중률이 올라간다.**

```sql
CREATE INDEX idx_member_active_created ON member (status, created_at) WHERE deleted = false;
```

**MySQL의 대체 수단은 생성 컬럼(generated column)이다.** 원리는 "**삭제된 행의 키를 `NULL`로 만들어 인덱스에서 사실상 빼는 것**"으로, §3에서 함정으로 등장하는 `NULL`의 성질을 **이번엔 의도적으로 이용**한다.

```sql
ALTER TABLE member
  ADD COLUMN email_active VARCHAR(255)
      GENERATED ALWAYS AS (CASE WHEN deleted THEN NULL ELSE email END) STORED,
  ADD UNIQUE KEY uk_member_email_active (email_active);
```

- 활성 행이면 `email_active = email` → **활성끼리는 유니크가 걸린다.**
- 삭제 행이면 `email_active = NULL` → **`NULL`은 서로 다르다고 취급되므로 몇 개든 공존한다.**

`email` 원본은 그대로 남고, 애플리케이션은 `email_active`의 존재를 몰라도 된다(계산은 DB가 한다). **부분 유니크 인덱스와 사실상 같은 효과**를 낸다.

**마이그레이션 주의점**:
1. **기존 중복 정리가 선행되어야 한다.** 이미 같은 이메일의 활성 행이 둘 이상이면 **인덱스 생성이 실패**한다. `SELECT email, COUNT(*) FROM member WHERE deleted = false GROUP BY email HAVING COUNT(*) > 1`로 먼저 파악하고, 비즈니스 규칙에 따라 정리한 뒤에 인덱스를 만든다. **대형 테이블에서는 이 정리가 며칠짜리 작업**이 될 수 있다(같은 이야기가 [복합 유니크 제약과 동시 INSERT](unique-constraint-concurrent-insert.md)에 있다).
2. **PostgreSQL에서는 `CREATE UNIQUE INDEX CONCURRENTLY`**로 만들어 쓰기 락을 피한다(대신 트랜잭션 안에서 못 쓰고, 실패 시 무효 인덱스가 남아 재시도 절차가 필요하다).
3. 여기서도 **기존 `UNIQUE(email)`을 반드시 제거**한다.
4. **생성 컬럼은 `STORED`면 디스크를 더 쓴다.** 인덱스를 걸려면 사실상 `STORED`가 편하다.
5. **테스트 DB가 H2라면 이 DDL은 그대로 통하지 않는다.** 로컬은 통과하고 운영에서 깨지는 대표적 자리라, 이 해법을 쓰는 순간 **Testcontainers로 실제 DB에서 테스트**하는 것이 사실상 필수가 된다(§7).

**얻는 것**: 애플리케이션 코드가 **완전히 깨끗해진다**(이메일 변형 없음, 규약 없음). 제약이 **스키마 하나에 응축**되므로 배치 잡·수동 SQL 같은 **모든 진입 경로**를 덮는다. **포기하는 것**: **DB 벤더에 묶인다.** MySQL↔PostgreSQL 이전이 가능성으로라도 있다면 마이그레이션 항목이 하나 늘고, 로컬/테스트 DB를 운영과 동일하게 맞춰야 한다.

### 2-4. 해법 ④ — 아카이브 테이블 분리 (문제 자체를 없앤다)

여기까지의 세 해법은 **"삭제된 행이 같은 테이블에 남아 있다"는 전제**를 유지한 채 그 부작용을 막는다. 네 번째는 **전제를 버린다** — 삭제된 행을 **별도 테이블로 옮기고 원본 테이블에서는 진짜로 지운다.**

```sql
CREATE TABLE member_archive (
  id           BIGINT       NOT NULL,          -- 원본 id 보존 (PK 로 두면 재탈퇴 시 충돌하므로 주의)
  email        VARCHAR(255) NOT NULL,          -- ★ UNIQUE 를 걸지 않는다
  archived_at  DATETIME(6)  NOT NULL,
  archive_seq  BIGINT       AUTO_INCREMENT PRIMARY KEY,
  -- 나머지 컬럼은 member 와 동일
  KEY idx_archive_email (email),               -- 이력 조회용 일반 인덱스
  KEY idx_archive_id (id)
);
```

```java
@Transactional
public void withdraw(Long memberId) {
    memberArchiveJdbc.copyFrom(memberId);   // INSERT INTO member_archive SELECT ... FROM member WHERE id = ?
    memberRepository.deleteById(memberId);  // 진짜 DELETE
}
```

**이 순간 사라지는 문제들**을 세어 보면 이 해법의 값어치가 보인다.

- **유니크 제약** — `member`에는 활성 행만 있으므로 `UNIQUE(email)`을 **그대로 두면 된다.** 재가입은 그냥 된다.
- **연관관계 조회** — `post.getComments()`가 삭제된 댓글을 가져올 수 없다. **없으니까.** `@SQLRestriction`도 필요 없다.
- **인덱스** — 모든 인덱스에서 `deleted` 선두 컬럼이 사라지고, 인덱스가 활성 데이터만큼만 커진다.
- **집계** — `count(*)`가 그냥 맞다. **조건 하나 빠뜨려 숫자가 틀리는 사고가 원천적으로 불가능**해진다.
- **FK 무결성** — DB의 외래 키와 `ON DELETE` 동작이 **다시 정상적으로 의미를 갖는다**(§6-3).

**포기하는 것 (반드시 같이 말할 것)**:
- **이력 조회가 두 테이블을 봐야 한다.** "전체 기간 주문 이력"처럼 활성·삭제를 함께 봐야 하는 화면은 `UNION ALL`이 되고, 그러면 **정렬·페이징이 두 테이블에 걸쳐 일어나 비용이 커진다.**
- **복구가 절차가 된다.** soft delete는 `deleted = false` 한 줄이면 복구지만, 아카이브는 **행을 되돌려 넣어야 하고 그 사이 같은 이메일로 다른 사람이 가입했으면 복구가 실패**한다. 이 실패는 사실 **정상**이지만(중복을 막은 것이다) 운영 절차로 정의돼 있어야 한다.
- **스키마가 두 벌이 된다.** 컬럼을 추가하는 마이그레이션마다 **아카이브 테이블도 같이 바꿔야 하고**, 안 바꾸면 복사 SQL이 조용히 깨진다. (그래서 아카이브를 **컬럼 미러링 대신 JSON 스냅샷 한 컬럼**으로 두는 선택지도 있다 — 스키마 동기화 부담은 사라지고 이력 조회 편의는 줄어든다.)
- **자식 데이터를 어떻게 할지 결정해야 한다.** 회원만 옮기고 주문을 남기면 **FK가 가리키는 부모가 없어진다.** 자식도 함께 옮기거나, 자식의 FK를 끊고 비식별 처리하는 정책이 필요하다.

**언제 이 선을 넘는가**는 §8의 시니어 변별 꼬리질문에서 다룬다.

### 2-5. 네 해법 대칭 비교 — 얻는 것 / 포기하는 것 / 해당 DB

| 해법 | 얻는 것 | 포기하는 것 | 해당 DB | 손대는 층 |
|---|---|---|---|---|
| ① 이메일 변형 + 랜덤/PK | DDL 변경 없음, 즉시 적용 | **원본 이메일 소실**(이력·감사·복구), 컬럼 길이, 규칙 파싱 부담 | 전부 | 애플리케이션 |
| ② 복합 유니크 + 삭제 순번 | 원본 보존, 표준 SQL만 사용 | 인덱스 확장, **`활성 = 0` 규약에 정합성이 의존** | 전부 | 스키마 + 약간의 코드 |
| ③ 부분 유니크 인덱스 / 생성 컬럼 | **코드가 깨끗**, 모든 진입 경로를 덮음 | **DB 벤더 종속**, 로컬/테스트 DB를 운영과 맞춰야 함 | PG(부분 인덱스) / MySQL(생성 컬럼) | 스키마 |
| ④ 아카이브 분리 | **유니크·조회·인덱스·집계 문제가 동시에 소멸** | UNION 이력 조회, 복구 절차, 스키마 이중 관리, 자식 처리 정책 | 전부 | 아키텍처 |

**선택 기준을 한 문장씩으로 정리하면 이렇다.**

- **PostgreSQL이고 삭제 데이터를 계속 조회해야 한다** → **③ 부분 유니크 인덱스.** 고민할 이유가 없다.
- **MySQL이고 스키마 변경이 가능하다** → **③의 생성 컬럼**이 가장 깨끗하고, 팀이 생성 컬럼에 익숙하지 않다면 **② 복합 유니크 + 삭제 순번**이 무난하다.
- **DDL 권한이 없거나 지금 당장 CS를 막아야 한다** → **① 이메일 변형**으로 급한 불을 끄되 **`original_email` 보존을 반드시 함께** 넣는다. 그리고 이건 임시방편임을 기록에 남긴다.
- **삭제 데이터가 활성 데이터보다 빠르게 쌓이거나, 삭제 데이터를 실질적으로 조회하지 않는다** → **④ 아카이브 분리.**

**그리고 어느 쪽을 고르든 유니크 제약 자체는 절대 빼지 않는다.** "애플리케이션에서 중복 검사를 하니까 제약은 없어도 된다"는 판단이 왜 틀리는지는 [복합 유니크 제약과 동시 INSERT](unique-constraint-concurrent-insert.md)에서 다룬 그대로다 — **배치 잡·수동 SQL·마이그레이션처럼 검사 코드를 안 거치는 경로가 반드시 존재**하고, 그걸 덮는 것은 DB 제약뿐이다.

---

## 3. `NULL`과 유니크 제약 — `deleted_at`이 열어버린 새 구멍

`deleted` boolean이 부족하니 `deleted_at DATETIME`으로 바꾸는 것은 **자연스럽고 실무에서도 흔한 선택**이다. 그런데 여기엔 **일반 대화에서 잘 안 나오는 함정**이 있다.

### 3-1. 유니크 제약에서 `NULL`은 "서로 다른 값"이다

표준 SQL에서 **`NULL`은 "값이 없음"이 아니라 "값을 알 수 없음"**이다. 그래서 `NULL = NULL`은 참이 아니라 **`UNKNOWN`**이고, 유니크 인덱스는 "같다고 판정할 수 없으니 중복이 아니다"로 처리한다. **`NULL`이 포함된 키는 몇 개든 공존할 수 있다.**

```sql
ALTER TABLE member ADD UNIQUE KEY uk_member_email_deleted_at (email, deleted_at);
-- 활성 회원은 deleted_at = NULL
```

| 순서 | 동작 | 삽입되는 키 | 결과 | 판정 |
|---|---|---|---|---|
| ① | 홍길동 가입 | `(hong@a.com, NULL)` | OK | 정상 |
| ② | **다른 사람이 같은 이메일로 가입** | `(hong@a.com, NULL)` | **OK ← 통과해버린다** | ✖ **활성 중복 발생** |
| ③ | 홍길동 탈퇴 | `(hong@a.com, 2026-08-10 14:03:11)` | OK | 정상 |
| ④ | 재가입 | `(hong@a.com, NULL)` | OK | 정상 |

**②가 이 함정의 전부다.** 재가입을 막던 문제를 풀려다가 **원래 있던 보호막(같은 이메일 활성 회원은 한 명)을 잃었다.** 그리고 이 구멍은 **재가입 실패처럼 CS로 즉시 올라오지 않는다** — 조용히 중복 계정이 쌓이다가, 나중에 `findByEmail`이 단건을 기대하는 코드에서 **예외로 터지거나 엉뚱한 계정에 로그인**되는 식으로 나타난다. **원인과 증상이 멀어서 추적이 어려운 유형**이다.

### 3-2. 처방 세 가지

```sql
-- (A) 센티널 값 — NULL 대신 "삭제 안 됨"을 뜻하는 실제 값을 쓴다
ALTER TABLE member MODIFY COLUMN deleted_at DATETIME(6) NOT NULL DEFAULT '1970-01-01 00:00:00';
-- 활성 = 에폭 상수. NOT NULL 이므로 (email, deleted_at) 이 활성 중복을 정상적으로 막는다.
-- 대가: "삭제 안 됨"을 날짜로 표현하게 되어 조회 조건이 deleted_at = '1970-01-01' 처럼 어색해진다.

-- (B) 생성 컬럼 (§2-3) — NULL 의 성질을 반대로 이용한다
--     활성일 때 email, 삭제일 때 NULL → 활성 중복은 막히고 삭제 행은 무제한 공존.

-- (C) 삭제 순번 정수 (§2-2 B) — NOT NULL DEFAULT 0, 삭제 시 id 를 넣는다
--     활성은 전부 0 이므로 (email, 0) 이 유일해야 하고, 삭제는 id 라 언제나 유일하다.
```

**(C)가 가장 깔끔하다.** 그리고 이건 **면접 기록에서 후보자가 `deleted_at`과 함께 이미 꺼낸 답**이다 — "int로 바꾸고 하나씩 더하는 방식"이 정확히 이것이고, `deleted_at`이 만든 `NULL` 구멍을 **동시에** 막는다. 즉 두 답 중 **뒤에 낸 답이 앞의 답을 구제하는 관계**였다.

### 3-3. "초 단위면 마우스 두 번 클릭을 못 막는 것 아닌가" — 이 지적은 맞다

`deleted_at`을 유니크 키에 넣는 순간, **정합성이 시간 정밀도에 의존하게 된다.** `DATETIME(0)`(초 단위)이라면 이런 일이 가능하다.

```
14:03:11.120   회원 A 탈퇴 → (hong@a.com, '2026-08-10 14:03:11')
14:03:11.480   (재가입 → 다시 탈퇴가 자동화 스크립트/더블클릭/재시도로 즉시 일어남)
               → (hong@a.com, '2026-08-10 14:03:11')   ← 같은 키! ✖ Duplicate entry
```

**정합성 규칙이 "사용자가 1초 안에 같은 동작을 두 번 하지 않는다"는 가정 위에 서 있다는 뜻**이고, 그 가정은 **더블클릭·클라이언트 재시도·배치 일괄 처리에서 그냥 깨진다.** 정밀도를 `DATETIME(6)`(마이크로초)으로 올리면 확률은 크게 줄지만 **"확률적으로 안전"이라는 성질 자체는 변하지 않는다.**

**여기서 얻을 일반화된 교훈이 이 문항의 핵심 중 하나다.**

> **유니크 키의 구성 요소로 "시간"을 쓰면 정합성이 확률에 의존한다.** 정합성은 확률이 아니라 **구조**로 보장해야 한다 — **PK, 시퀀스, UUID**처럼 **유일성이 정의상 보장되는 값**을 쓴다. 시각은 **정보로만** 남긴다.

그리고 이 원칙은 §2-2에서 `deleted_at`(정보)과 `deleted_seq`(제약 슬롯)의 **역할을 분리한 이유**와 정확히 같다.

---

## 4. 나머지 절반 — `post.getComments()`에 삭제된 댓글이 딸려온다

### 4-1. 왜 딸려오는가 — JPA는 FK만 본다

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
-- ❌ BEFORE — 실제로 나가는 SQL
select c.id, c.content, c.deleted, c.post_id
from   comment c
where  c.post_id = ?
```

**끝이다.** `deleted` 조건은 어디에도 없다. 하이버네이트가 아는 것은 **"`Comment.post` 필드가 `post_id` 컬럼에 매핑돼 있고, 이 부모의 자식은 `post_id`가 이 값인 행들"**뿐이다. `deleted` 컬럼은 **그냥 매핑된 필드 중 하나**이지 특별한 의미가 없다.

**핵심을 한 문장으로**: **JPA는 컬렉션을 채울 때 FK만 보고 자식 행을 전부 가져온다. "이 행은 삭제된 것"이라는 개념은 DB에도 JPA에도 존재하지 않고, 오직 우리 애플리케이션 코드 안에만 있다**(§1-2).

**흔한 오답 — 자바에서 걸러내기.**

```java
// ❌ 화면은 맞아지지만 비용은 그대로다
List<Comment> visible = post.getComments().stream()
        .filter(c -> !c.isDeleted())
        .toList();
```

삭제 댓글이 90%인 게시글이라면 **10배의 행을 읽어 네트워크로 전송하고 엔티티로 만든 뒤 버린다.** 게다가 **삭제된 댓글까지 영속성 컨텍스트에 올라가** 메모리와 flush 시 변경 감지 비용을 함께 먹는다([영속성 컨텍스트와 변경 감지](persistence-context-dirty-checking.md)). **조건은 DB로 내려가야 한다.**

### 4-2. 도구 — `@SQLRestriction` + `@SQLDelete` 세트

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

- **`@SQLRestriction("deleted = false")`** — 이 엔티티를 읽는 **모든 SQL의 `where`에 조건을 자동으로 끼워 넣는다.** (하이버네이트 6.3 이전에는 **`@Where`**라는 이름이었다. 지금은 이쪽이 표준 이름이고 `@Where`는 폐기 대상이다.)
- **`@SQLDelete`** — `entityManager.remove(comment)`나 `repository.delete(comment)`가 만들어내는 **DELETE 문을 우리가 지정한 SQL로 바꿔치기한다.** 그래서 "삭제 API를 호출하면 자동으로 soft delete"가 된다. `where id = ?`의 물음표에는 하이버네이트가 PK를 바인딩한다.

**두 개가 세트인 이유**는 명확하다. `@SQLDelete`만 있으면 **지워지긴 하는데 조회에 계속 나오고**, `@SQLRestriction`만 있으면 **조회에선 사라지는데 `delete`는 진짜로 행을 지운다.** 둘이 짝을 이뤄야 "삭제된 것처럼 보이고, 삭제된 것처럼 동작한다"가 완성된다.

이제 나가는 SQL이 이렇게 바뀐다.

```sql
-- ✅ AFTER — 컬렉션 초기화
select c.id, c.content, c.deleted, c.post_id
from   comment c
where  (c.deleted = false)          -- ← @SQLRestriction 이 끼워 넣은 조건
  and  c.post_id = ?

-- ✅ AFTER — repository.delete(comment)
update comment set deleted = true where id = ?      -- ← DELETE 대신 이게 나간다
```

**조건이 붙는 범위가 넓다는 점이 중요하다.** 엔티티 클래스에 붙이면 **컬렉션 초기화, `findAll`, JPQL, QueryDSL, fetch join, `count`** — 하이버네이트가 그 엔티티를 위해 만드는 SQL 전부에 붙는다. **그게 장점이고, 동시에 §5의 문제다.**

**범위를 좁히고 싶다면 컬렉션 필드에 붙인다.**

```java
@Entity
public class Post {
    @OneToMany(mappedBy = "post")
    @SQLRestriction("deleted = false")     // ← 이 컬렉션을 로딩할 때만 조건이 붙는다
    private List<Comment> comments = new ArrayList<>();
}
```

이러면 **`post.getComments()`는 살아 있는 댓글만** 담고, `commentRepository.findAll()`이나 관리자용 조회는 **삭제된 것까지 정상적으로 본다.** 「부모를 통해 볼 때만 감춘다」는 요구에 정확히 맞고, **§5의 "끌 수 없다" 문제도 절반은 피해 간다.** 어느 쪽에 붙일지는 **"이 엔티티는 시스템 전체에서 안 보여야 하는가, 아니면 이 경로에서만 안 보여야 하는가"**로 정한다.

### 4-3. 하이버네이트 6.4의 `@SoftDelete` — 세트를 하나로 묶은 것

```java
@Entity
@SoftDelete(columnName = "deleted")
public class Comment { … }
```

**`@SQLRestriction` + `@SQLDelete`가 하던 일을 애노테이션 하나로 선언한다.** 삭제를 UPDATE로 바꾸고, 조회에 조건을 자동으로 붙인다. 컬럼 이름을 지정할 수 있고, **컬럼의 의미가 "삭제됨 표시"인지 "활성 표시"인지**(`deleted` vs `active`)도 전략으로 고를 수 있다. SQL 문자열을 직접 쓰지 않으므로 **오타·테이블명 변경에 덜 취약**하다는 것이 실질적 이점이다.

**하지만 대가는 똑같다.** 전역으로 붙는 조건이라는 성질은 그대로이고, §5의 "끌 수 없다" 문제도 그대로 상속한다. **도구가 세련되어졌을 뿐 트레이드오프의 구조는 변하지 않았다.**

### 4-4. 애노테이션을 안 쓰는 선택지 — 조회 경로를 손으로 만든다

`@SQLRestriction`이 부담스럽다면(§5) **조건을 명시적으로 쓰는 쪽**이 있다. 투명성을 얻고 편의를 잃는다.

```java
// ① 리포지토리 메서드로 명시
List<Comment> findByPostIdAndDeletedFalse(Long postId);

// ② 컬렉션을 아예 매핑하지 않고 필요할 때 조회로 가져온다
//    → 연관관계 편의가 사라지는 대신 "무엇을 읽는지"가 코드에 보인다

// ③ 하이버네이트 @Filter — 켜고 끌 수 있는 조건
@FilterDef(name = "activeOnly")
@Filter(name = "activeOnly", condition = "deleted = false")
```

**`@Filter`가 개념적으로는 가장 좋은 답**이다. `@SQLRestriction`과 달리 **세션 단위로 켜고 끌 수 있어서** 관리자 경로에서는 끄면 된다. 문제는 **기본적으로 꺼져 있어서 요청마다 세션에 명시적으로 활성화해야 한다는 것**이다 — Spring Data JPA의 기본 조회 경로는 이 활성화를 해주지 않으므로 **인터셉터나 AOP로 매 요청 켜주는 장치**를 직접 만들어야 하고, **그 장치를 안 타는 경로(배치, 이벤트 핸들러, 테스트)에서는 조용히 꺼진 채로 동작한다.** "끌 수 있다"의 이면은 **"켜는 걸 잊을 수 있다"**다. 안전 방향이 반대인 셈이라, **누락의 대가가 큰 도메인(개인정보·결제)에서는 `@SQLRestriction` 쪽이 오히려 안전**하다.

### 4-5. `@SQLRestriction`이 개입하지 못하는 경로 (실무에서 반드시 만난다)

`@SQLRestriction`은 **"하이버네이트가 만드는 SQL에 문자열을 덧붙이는" 기능**이다. 그러니 **SQL이 안 나가거나, 하이버네이트가 안 만든 SQL**에는 개입할 수 없다.

- **네이티브 쿼리** — 우리가 쓴 SQL이 그대로 나간다. 조건은 직접 써야 한다. (§5에서는 이게 **탈출구**로 쓰인다.)
- **이미 영속성 컨텍스트에 올라온 인스턴스** — SQL이 안 나가므로 조건도 개입하지 않는다. 같은 트랜잭션에서 방금 soft delete한 엔티티를 다시 `findById`하면 **1차 캐시에서 그대로 돌아온다.**
- **JPQL/네이티브 벌크 연산** — `@Modifying` JPQL `delete`나 `deleteAllInBatch`는 **`@SQLDelete`를 거치지 않고 진짜 DELETE를 날린다**(§8 꼬리질문). 영속성 컨텍스트를 우회한다는 성질과 같은 뿌리다([벌크 연산과 영속성 컨텍스트](bulk-operation-persistence-context.md)).
- **DB가 스스로 하는 동작** — `ON DELETE CASCADE`, 트리거, 다른 팀의 배치 잡. 애초에 애플리케이션 밖이다.

**그리고 가장 자주 사고를 내는 경로 하나 (가산점 포인트)**: **`@ManyToOne` 쪽 부모가 soft delete된 경우**다.

```java
@Entity
@SQLRestriction("deleted = false")
public class Post { … }        // 게시글도 soft delete 라고 하자

// 삭제된 게시글에 달린 댓글을 가져와 comment.getPost().getTitle() 을 호출하면?
//   → 프록시 초기화 SQL:  select ... from post where (deleted = false) and id = ?
//   → 행이 없다 → EntityNotFoundException
```

FK는 살아 있는데 **조건 때문에 그 행을 못 읽는** 상황이다. **DB 관점에서는 참조 무결성이 멀쩡한데 애플리케이션 관점에서는 부모가 없는** 모순이 생긴 것이고, 이는 §6-3에서 다룰 "soft delete가 FK 무결성을 무의미하게 만든다"의 구체적 얼굴이다. **부모를 soft delete할 때 자식을 어떻게 할지 정책이 없으면 반드시 만난다.**

---

## 5. `@SQLRestriction`의 대가 — 끌 수 없다

**이 절이 이 문항에서 상·중을 가른다.** 도구 이름을 아는 것은 검색으로 5분이면 되지만, **그 도구가 무엇을 못 하는지**는 겪어야 안다.

### 5-1. 문제

```java
@Entity
@SQLRestriction("deleted = false")
public class Member { … }
```

이제 **관리자 화면**을 만든다.

```java
// 관리자: "탈퇴 회원 목록을 보여주세요"
memberRepository.findAll();                    // → 활성 회원만. 탈퇴 회원은 절대 안 나온다.
memberRepository.findByDeletedTrue();          // → where (deleted = false) and deleted = true → 항상 0건
memberRepository.findById(withdrawnId);        // → Optional.empty()
queryFactory.selectFrom(member).fetch();       // → 역시 활성만
```

**애노테이션을 끄는 방법이 없다.** 옵션도, 힌트도, "이번 쿼리만 제외" 같은 장치도 없다. 조건은 **매핑에 박혀 있고 컴파일 타임에 결정된다.**

**그리고 실패하는 방식이 나쁘다.** 예외가 나면 즉시 알아채겠지만, 실제로는 **조용히 빈 결과나 0건**이 돌아온다. 관리자 화면은 "탈퇴 회원이 없나 보다"라고 표시하고, 통계는 **0을 정상값처럼 보여준다.** 이건 [엔티티 직접 노출](entity-exposure-and-dto-boundary.md)에서 다룬 문제와 **완전히 같은 실패 모드**다.

### 5-2. `@JsonIgnore`와 정확히 같은 성격의 함정이다

중급 Q5에서 "엔티티에 `@JsonIgnore`를 붙이면 되지 않나"에 대한 답이 이랬다 — **`@JsonIgnore`는 필드에 붙는다. 즉 그 엔티티를 직렬화하는 모든 곳에 똑같이 적용되고, API마다 다른 요구(내부 관리자 API는 그 필드가 필요하다)를 표현할 수 없다.**

`@SQLRestriction`은 **똑같은 문장이 조회 층에서 반복된 것**이다.

| | `@JsonIgnore` | `@SQLRestriction` |
|---|---|---|
| 붙는 곳 | 엔티티 필드 | 엔티티 클래스/컬렉션 필드 |
| 적용 범위 | 그 엔티티를 직렬화하는 **모든 곳** | 그 엔티티를 조회하는 **모든 SQL** |
| 경로별 차등 | **불가능** | **불가능** |
| 실패 방식 | 필드가 조용히 빠짐 | 결과가 조용히 비어 있음 |
| 근본 원인 | **엔티티가 "표현 규칙"까지 짊어짐** | **엔티티가 "가시성 규칙"까지 짊어짐** |

**공통 교훈은 이것이다**: **엔티티에 박은 전역 스위치는 편리한 만큼 예외를 만들 수 없다.** 그리고 요구사항은 **거의 항상 예외를 만들어 온다**(관리자 화면, 통계, 데이터 복구, 고객센터 조회). 그러니 전역 스위치를 붙이기 전에 **"이 규칙에 예외가 생길 확률"**을 먼저 따져야 한다. `@JsonIgnore`는 그 확률이 높아서 DTO로 갔고, `@SQLRestriction`은 **확률이 높은데도 대안의 안전성이 더 낮아서**(§4-4의 `@Filter`) 여전히 쓰인다 — 그래서 **탈출구를 미리 설계해 두는 것**이 답이 된다.

### 5-3. 탈출구를 미리 설계한다

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
@Table(name = "member")          // ← 같은 테이블, @SQLRestriction 없음
@Immutable                       // 읽기 전용으로 못 박아 쓰기 사고를 차단
public class MemberAdminView { … }

// ③ 조회 전용 DTO 프로젝션 — 관리자 화면은 어차피 표시가 목적이다
//    (엔티티를 안 거치므로 조건도 안 붙고, 필요한 컬럼만 읽는다)
```

**②가 실무에서 가장 자주 보이는 형태**다. "같은 테이블을 두 엔티티가 매핑한다"는 것이 처음엔 이상해 보이지만, **읽는 목적이 다르면 읽는 모델도 다를 수 있다**는 관점(같은 데이터에 대한 서로 다른 뷰)에서는 자연스럽다. `@Immutable`을 붙여 **관리자 뷰로는 쓰기를 못 하게** 못 박아 두는 것이 안전하다. 조회 목적이 표시뿐이라면 **③ DTO 프로젝션**이 더 가볍다([조회 전용 DTO 프로젝션](dto-projection-for-read-only.md)의 "변경이 목적이면 엔티티, 표시가 목적이면 DTO"가 그대로 적용된다).

**면접에서 한 문장으로 말한다면**: "**`@SQLRestriction`을 쓰겠습니다. 대신 이건 끌 수 없는 전역 조건이라 관리자·통계 경로는 처음부터 네이티브 쿼리나 별도 조회 모델로 분리해 두고, 그 경로가 조용히 빈 결과를 주지 않는지 테스트로 고정합니다.**" — 도구 이름 + 대가 + 대가에 대한 대비까지 **한 호흡**에 들어 있다.

---

## 6. soft delete 자체의 대가 — 유니크와 조회 말고도 청구서는 더 온다

질문은 유니크와 연관관계 두 가지를 물었지만, **"안 지우기로 한 결정"의 청구서는 최소 네 곳에서 온다.** 나머지 둘을 말할 수 있으면 **"대가를 설계에 반영해 봤는지"**라는 출제 의도를 정면으로 맞힌다.

### 6-1. 인덱스 — 복합 인덱스 선두에 `deleted`를 넣어야 한다

soft delete를 켠 순간 **거의 모든 조회에 `deleted = false`가 붙는다.** 그런데 기존 인덱스는 그 컬럼을 모른다.

```sql
-- ❌ BEFORE
CREATE INDEX idx_member_status_created ON member (status, created_at);

-- 실제로 나가는 쿼리
SELECT * FROM member
WHERE deleted = false AND status = 'ACTIVE'
ORDER BY created_at DESC LIMIT 20;
-- → status, created_at 으로 인덱스를 타고, deleted 는 읽어온 행마다 사후 필터링(filtering)한다.
--    삭제 비율이 높을수록 "인덱스로 찾았는데 대부분 버리는" 낭비가 커진다.

-- ✅ AFTER
CREATE INDEX idx_member_deleted_status_created ON member (deleted, status, created_at);
```

**"카디널리티가 낮은 컬럼을 선두에 두면 안 된다"는 통념과 충돌해 보이지만, 이 경우엔 선두가 맞다.** 복합 인덱스는 **등치(=) 조건 컬럼들이 앞에 오고 그 뒤에 범위·정렬 컬럼이 와야 끝까지 활용**된다. `deleted = false`는 **항상 붙는 등치 조건**이므로 선두 자리가 정확하다. 값이 두 개뿐이라 선택도가 낮은 것은 사실이지만, 뒤따르는 `status`·`created_at`이 선택도를 채워준다.

**PostgreSQL이라면 더 나은 답이 있다 (가산점 포인트)** — §2-3에서 봤듯 **부분 인덱스**로 만들면 컬럼을 추가할 필요조차 없고 **인덱스 자체가 활성 행 크기로 줄어든다.**

```sql
CREATE INDEX idx_member_status_created_active
  ON member (status, created_at) WHERE deleted = false;
```

**그리고 이건 일회성 작업이 아니다.** soft delete를 켠 뒤에 추가되는 **모든 인덱스가 이 규칙을 따라야 한다.** 규칙이 사람의 기억에 의존하는 순간 언젠가 빠지므로, **마이그레이션 리뷰 체크리스트에 항목으로 박아두는 것**이 실질적인 처방이다(§7-3).

### 6-2. 집계 — 조건 하나가 빠지면 숫자가 조용히 틀린다

```sql
-- ❌ "가입자 수" — 탈퇴자까지 센다
SELECT COUNT(*) FROM member;

-- ❌ "이번 달 매출" — 취소(soft delete)된 주문까지 더한다
SELECT SUM(amount) FROM orders WHERE created_at >= '2026-08-01';
```

**이 실패가 특히 나쁜 이유는 예외가 안 나기 때문**이다. 쿼리는 성공하고, 숫자가 나오고, 대시보드에 표시된다. **틀렸다는 사실을 아무도 모른다.** 그리고 집계 쿼리는 **BI 도구·리포팅 스크립트·다른 팀의 애드혹 쿼리**처럼 우리 애플리케이션 밖에서 작성되는 경우가 많아 **`@SQLRestriction`의 보호 범위 밖**이다.

**처방 두 가지**:
- **활성 행만 담은 뷰(view)를 만들어 그것을 표준 조회 대상으로 공표한다.** `CREATE VIEW member_active AS SELECT * FROM member WHERE deleted = false;` — 다른 팀에게는 **테이블이 아니라 뷰를 알려준다.** 조건을 "기억해야 하는 규칙"에서 "기본으로 제공되는 대상"으로 바꾸는 것이 요점이다.
- **아카이브 분리(§2-4)** — 이 문제를 통째로 없앤다. 이것이 아카이브 쪽이 규모가 커질 때 정답 후보가 되는 큰 이유 중 하나다.

### 6-3. 참조 무결성 — DB의 FK가 의미를 잃는다

FK는 **행이 실제로 지워질 때** 동작한다. soft delete는 행을 지우지 않으므로 **FK도, `ON DELETE CASCADE`도, `ON DELETE RESTRICT`도 아무 일을 하지 않는다.**

```
회원 탈퇴 (soft delete)
  → DB: "member 행은 그대로 있다. 참조 무결성 완벽."
  → 애플리케이션: "삭제된 회원인데 주문이 살아 있고, 그 주문이 배송으로 넘어간다."
```

**"부모가 삭제되면 자식은 어떻게 되는가"를 DB가 더 이상 답해주지 않는다.** 그 책임이 전부 애플리케이션으로 넘어왔고, **경로마다 빠뜨릴 수 있다.** §4-5에서 본 `EntityNotFoundException`이 그 구체적 얼굴이다.

**그래서 정책을 명시적으로 정해야 한다** — 부모를 soft delete할 때 ① 자식도 함께 soft delete할 것인가 ② 자식은 남기되 부모 참조를 끊을 것인가 ③ 살아 있는 자식이 있으면 삭제를 거부할 것인가. **`CascadeType.REMOVE`는 이 일을 해주지 않는다** — `@SQLDelete`가 걸려 있으면 각 자식에 대해 DELETE 대신 UPDATE가 나가므로 **cascade 경로로는 동작하지만**, 부모를 `save()`로 상태만 바꾸는 방식(우리가 §2-2에서 쓴 `withdraw()`)에서는 **cascade가 애초에 발동하지 않는다.** 자세한 동작 차이는 [CascadeType.REMOVE와 orphanRemoval](cascade-remove-vs-orphan-removal.md)에 있다.

### 6-4. 데이터 누적과 개인정보

삭제 데이터는 **영원히 쌓인다.** 테이블·인덱스가 커지고, 백업이 커지고, 통계 갱신이 느려진다. 그리고 개인정보라면 **"파기해야 하는데 파기하지 않은 상태"**가 된다 — 이건 성능 문제가 아니라 **컴플라이언스 문제**다(§8 꼬리질문).

**그래서 soft delete를 도입할 때 "언제까지 보관하는가"를 함께 정해야 한다.** 보관 기간이 정해지면 자연스럽게 **주기적으로 오래된 삭제 행을 진짜로 지우거나 아카이브로 옮기는 배치**가 필요해지고, 그건 §2-4로 가는 길이기도 하다.

---

## 7. 안전망 — 테스트와 체크리스트로 고정한다

이 문항의 사고들은 **전부 "조용히" 일어난다.** 재가입 실패는 CS로 올라오기라도 하지만, 관리자 화면의 빈 결과·틀린 집계·인덱스 누락은 **아무도 알려주지 않는다.** 그래서 **관측이 아니라 테스트로 고정해야 한다.**

### 7-1. 재가입 시나리오 4단계 통합 테스트

**§2-2의 boolean 함정은 "재가입까지만 테스트하면 통과한다."** 그래서 테스트는 반드시 **재탈퇴까지 네 단계**여야 한다.

```java
@SpringBootTest
class MemberRejoinTest {

    @Autowired MemberService memberService;
    @Autowired MemberRepository memberRepository;

    private static final String EMAIL = "hong@a.com";

    @Test
    void 같은_이메일로_가입_탈퇴_재가입_재탈퇴가_모두_성공한다() {
        Long first  = memberService.join(EMAIL);       // ① 가입
        memberService.withdraw(first);                 // ② 탈퇴
        Long second = memberService.join(EMAIL);       // ③ 재가입  ← 단일 UNIQUE 면 여기서 실패
        memberService.withdraw(second);                // ④ 재탈퇴  ← boolean 복합 유니크면 여기서 실패

        Long third = memberService.join(EMAIL);        // ⑤ 한 번 더 (규칙이 일반화됐는지 확인)
        assertThat(third).isNotNull();
    }

    @Test
    void 활성_회원은_같은_이메일로_두_명_존재할_수_없다() {          // ← §3 의 NULL 구멍을 잡는 테스트
        memberService.join(EMAIL);
        assertThatThrownBy(() -> memberService.join(EMAIL))
                .isInstanceOf(DuplicateKeyException.class);
    }
}
```

**두 번째 테스트가 특히 중요하다.** `deleted_at`으로 바꾸는 리팩터링이 들어오는 순간 **이 테스트만 깨지고 첫 번째는 통과한다.** 즉 §3의 함정을 **정확히 그 지점에서** 잡아준다.

**주의 (횡단 약점 — 여기서 반복해서 걸린다)**: **테스트 메서드에 `@Transactional`을 붙이면 이 테스트는 무용지물이 된다.** 유니크 위반은 **flush 시점**에 DB가 판정하는데, 한 트랜잭션 안에서 전부 굴리면 flush가 언제 일어나는지에 따라 결과가 달라지고, 롤백 때문에 다음 테스트와의 격리도 어긋난다. **`@Transactional` 없이 실제 커밋되게 하고 뒷정리를 직접** 하거나 `@Commit`을 쓴다. 같은 함정을 [복합 유니크 제약과 동시 INSERT](unique-constraint-concurrent-insert.md)와 [flush 시점과 SQL 실행 순서](flush-timing-and-sql-ordering.md)에서도 다뤘다.

### 7-2. `@SQLRestriction`이 관리자 경로를 조용히 막지 않는지 확인하는 테스트

**§5의 사고는 "예외 없이 0건"으로 나타나므로, 0건이 아님을 단정하는 테스트**가 유일한 방어선이다.

```java
@Test
void 관리자_조회는_탈퇴_회원을_볼_수_있어야_한다() {
    Long id = memberService.join("bye@a.com");
    memberService.withdraw(id);

    // 서비스 경로: 안 보여야 정상
    assertThat(memberRepository.findById(id)).isEmpty();

    // 관리자 경로: 보여야 정상  ← @SQLRestriction 이 여기까지 먹으면 0건이 되고 테스트가 잡는다
    List<Member> withdrawn = memberAdminRepository.findWithdrawnMembers();
    assertThat(withdrawn).extracting(Member::getId).contains(id);
}
```

**이 테스트의 진짜 가치는 회귀 방지다.** 나중에 누군가 관리자 리포지토리를 "중복 같으니 통합하자"며 일반 리포지토리로 바꾸거나, 네이티브 쿼리를 JPQL로 "정리"하는 순간 **이 테스트가 실패해서 막아준다.** 주장으로 남겨둔 설계 원칙은 언젠가 지워지고, **테스트로 고정한 원칙만 살아남는다.**

### 7-3. 인덱스·스키마 점검을 절차로 만든다

- **마이그레이션 리뷰 체크리스트**에 두 줄을 박는다 — ① **"이 테이블이 soft delete 대상인가? 그렇다면 새 복합 인덱스 선두에 `deleted`가 있는가?"** ② **"유니크 제약을 추가/변경했다면 기존 단일 유니크를 제거했는가?"**
- **`ddl-auto=validate`**로 기동 시 엔티티 매핑과 실제 스키마의 불일치를 잡는다. 다만 **인덱스 구성까지 검증해 주지는 않으므로** 인덱스는 위 체크리스트나 별도 점검 쿼리(`information_schema`)로 봐야 한다.
- **느린 쿼리 로그**에 soft delete 테이블이 올라오면 **가장 먼저 의심할 것은 인덱스 선두 컬럼**이다.

### 7-4. 테스트 DB를 운영 DB와 맞춘다 (Testcontainers)

**이 문항의 해법 대부분은 벤더 의존적이다** — 부분 유니크 인덱스, 생성 컬럼, `NULL`의 유니크 취급, 그리고 `@SQLRestriction`이 만들어내는 SQL 방언. **H2로 테스트하면 §7-1의 테스트가 통과해도 운영에서 깨질 수 있다.** soft delete 스키마를 설계했다면 **테스트를 실제 DB(Testcontainers)로 돌리는 것이 선택이 아니라 전제**가 된다.

---

## 8. 꼬리질문 대비 포인트

### "`@SQLRestriction`을 붙였는데 관리자 화면에서 삭제된 데이터를 봐야 합니다. 어떻게 하나요?"

**애노테이션을 끌 방법은 없다.** 그래서 **조회 경로를 아예 다른 길로 낸다**(§5-3).

1. **네이티브 쿼리** — 하이버네이트가 만든 SQL이 아니므로 조건이 붙지 않는다. 가장 간단하고 가장 흔하다.
2. **같은 테이블을 매핑한 별도 엔티티**(`@Table(name = "member")` + `@SQLRestriction` 없음 + `@Immutable`) — 관리자 전용 읽기 모델. 쓰기 사고를 막기 위해 반드시 불변으로 못 박는다.
3. **DTO 프로젝션** — 관리자 화면은 표시가 목적이므로 엔티티를 거칠 이유가 애초에 없다.

**그리고 여기서 한 발 더 나가면 좋다 (가산점 포인트)**: 이 상황은 **`@Filter`를 대신 썼다면 세션마다 켜고 끌 수 있었다.** 하지만 `@Filter`는 **기본이 꺼짐**이라 요청마다 활성화 장치가 필요하고, **그 장치를 안 타는 경로에서는 조용히 전체가 노출된다.** 즉 **`@SQLRestriction`은 "예외를 못 만드는" 실패, `@Filter`는 "보호를 잊는" 실패**다. **개인정보처럼 노출 대가가 큰 도메인이면 전자가, 관리 편의가 중요하면 후자가 맞다** — 선택 기준은 **어느 쪽 실패가 더 비싼가**다.

### "부모를 soft delete하면 자식은 어떻게 되나요? cascade가 동작하나요?"

**케이스를 나눠서 답해야 한다.**

- **`repository.delete(parent)`를 호출하고 `CascadeType.REMOVE`가 걸려 있다면** — 하이버네이트는 자식 각각에 대해 삭제를 시도하고, 자식에 `@SQLDelete`가 있으면 **DELETE 대신 UPDATE가 나간다.** 즉 **cascade 경로로는 soft delete가 전파된다.**
- **부모를 `parent.setDeleted(true)`로 상태만 바꿨다면** — 이건 그냥 UPDATE 한 줄이다. **cascade는 애초에 발동하지 않는다.** 자식은 전부 살아 있다.

**실무에서 사고가 나는 쪽은 후자**다. `withdraw()` 같은 도메인 메서드는 대부분 상태 변경으로 구현되기 때문이다. 그래서 **부모 삭제 시 자식 정책을 도메인 메서드 안에 명시적으로 써야 한다.**

```java
public void withdraw() {
    this.deleted = true;
    this.deletedSeq = this.id;
    this.comments.forEach(Comment::softDelete);   // ← 자동으로 되지 않는다. 손으로 쓴다.
}
```

**그리고 DB의 `ON DELETE CASCADE`는 여기서 완전히 무력하다**(§6-3) — 행이 안 지워지니 발동할 계기 자체가 없다. 자세한 cascade 동작은 [CascadeType.REMOVE와 orphanRemoval](cascade-remove-vs-orphan-removal.md).

### "`@SQLDelete`를 걸었는데 어떤 경로에서는 행이 진짜로 지워졌습니다. 왜죠?" (가산점 포인트)

**`@SQLDelete`는 "하이버네이트가 엔티티 하나를 삭제할 때 만드는 DELETE 문"만 바꿔치기한다.** 그 경로를 안 타는 삭제는 전부 진짜 DELETE다.

```java
repository.delete(entity);          // ✅ @SQLDelete 적용 → UPDATE
repository.deleteAll(entities);     // ✅ 내부적으로 엔티티 단위 삭제 → UPDATE

repository.deleteAllInBatch();      // ❌ JPQL 벌크 delete → 진짜 DELETE
@Modifying @Query("delete from Comment c where c.post.id = :id")   // ❌ 진짜 DELETE
nativeQuery = "delete from comment where ..."                       // ❌ 진짜 DELETE
```

**뿌리는 하나다** — **벌크 연산은 영속성 컨텍스트와 엔티티 이벤트 경로를 통째로 우회해 SQL을 DB로 직행시킨다.** 그래서 `@SQLDelete`뿐 아니라 **JPA Auditing, 엔티티 리스너, 낙관적 락 버전 증가도 함께 빠진다.** "자동으로 되는 것"의 동작 경로를 알아야 **안 되는 경우도 예측할 수 있다**([벌크 연산과 영속성 컨텍스트](bulk-operation-persistence-context.md)).

**대응**: 성능 때문에 벌크가 필요하다면 **벌크 UPDATE로 직접 쓴다**(`update Comment c set c.deleted = true where c.post.id = :id`). 즉 "삭제 구문을 쓰되 UPDATE로 바뀌길 기대"하지 말고 **처음부터 UPDATE를 쓴다.**

### "soft delete 때문에 조회가 느려졌습니다. 어디부터 보나요?" (시니어 변별 포인트)

**순서대로 셋을 본다.**

1. **인덱스 선두 컬럼** — 거의 모든 쿼리에 `deleted = false`가 붙는데 복합 인덱스가 그걸 모르면 **인덱스로 찾은 행 대부분을 사후 필터링으로 버린다.** `deleted`를 선두로 올린다(§6-1). 등치 조건 → 범위·정렬 순서가 복합 인덱스의 기본 규칙이므로, 카디널리티가 낮아도 이 자리는 맞다.
2. **삭제 데이터 비율** — 활성 10%, 삭제 90%가 되면 **테이블·인덱스의 90%가 안 읽는 데이터**다. 버퍼 풀에 쓸모없는 페이지가 올라오고 캐시 적중률이 떨어진다. 이 지점이 곧 **아카이브 분리를 검토할 신호**다.
3. **`count` 쿼리와 페이징** — soft delete 테이블의 `count(*)`는 전체 스캔이 되기 쉽다. 부분 인덱스(PG)나 **집계 테이블 별도 유지**를 고려한다.

**PostgreSQL이라면 부분 인덱스 하나로 1·2를 동시에 완화한다** — 인덱스가 활성 행 크기로 줄어들기 때문이다.

**그리고 여기서 흔한 오답 하나**: "`deleted` 컬럼에 단독 인덱스를 만들자." 값이 두 개뿐이라 **선택도가 극도로 낮아 옵티마이저가 무시하거나, 타더라도 절반을 읽는다.** 의미가 있는 것은 **복합 인덱스의 선두 컬럼으로서**이지 단독 인덱스가 아니다.

### "그냥 처음부터 아카이브 테이블로 옮기는 게 낫지 않나요? 언제 그 선을 넘나요?" (시니어 변별 포인트)

**세 가지 축으로 판단한다.**

1. **삭제 데이터를 얼마나 자주 읽는가.** 복구 요청·이력 조회·감사 조회가 **일상적인 기능**이면 soft delete가 맞다. 삭제 데이터를 사실상 안 읽고 **"만약을 위해" 남기는 것**이라면 아카이브가 맞다. **"만약을 위해"는 아카이브의 신호다** — 백업과 다를 바 없는 목적에 운영 테이블의 성능을 계속 지불하고 있기 때문이다.
2. **삭제 비율의 증가 속도.** 활성 대비 삭제 비율이 **계속 커지는 구조**(예: 세션·알림·임시 데이터)면 시간이 갈수록 나빠지는 방향이라 **선을 언제 넘느냐의 문제일 뿐**이다. 반면 회원 테이블처럼 삭제가 드물게 쌓이면 soft delete로 오래 버틴다.
3. **집계의 정확도가 얼마나 중요한가.** 정산·매출처럼 **숫자가 틀리면 안 되는 도메인**이면, 조건 하나 빠뜨리면 조용히 틀리는 구조(§6-2)를 유지하는 것 자체가 위험이다. 아카이브 분리는 **그 위험을 구조적으로 제거**한다.

**대가를 같은 호흡에 말하는 것이 이 답의 완성이다** — 아카이브는 **이력 조회가 `UNION ALL`이 되고, 복구가 절차가 되며, 스키마를 두 벌 관리해야 하고, 자식 데이터 처리 정책이 필요하다.** 그래서 실무 절충은 대개 **"soft delete로 시작하고, 보관 기간(예: 탈퇴 후 N개월)이 지난 행을 배치로 아카이브 이관"**이다. 최근 데이터는 soft delete의 편의를, 오래된 데이터는 아카이브의 성능을 취한다.

### "개인정보 파기 의무와 soft delete는 충돌하지 않나요?" (가산점 포인트)

**충돌한다. 그리고 이건 기술 문제가 아니라 컴플라이언스 문제라 우선순위가 다르다.**

soft delete는 **"지운 척"**이므로, 이름·이메일·전화번호가 **DB에 그대로 남아 있다.** 사용자가 삭제를 요청했고 법·약관상 파기 의무가 있다면 **"deleted = true"는 파기가 아니다.**

**반대 방향의 요구도 동시에 존재한다** — 전자상거래 거래 기록처럼 **일정 기간 보존이 의무인 데이터**도 있다. 그래서 실무 답은 "전부 지운다"도 "전부 남긴다"도 아니고 **컬럼 단위로 나누는 것**이다.

- **식별 정보(이름·이메일·전화)** → **실제로 파기하거나 비식별 처리**한다(`이름 → '탈퇴회원'`, `email → 'deleted:{id}'`). §2-1의 이메일 변형이 **유니크 회피 수단이면서 동시에 비식별 수단**이 되는 지점이다.
- **거래·정산 기록** → 보존하되 **개인과 연결되지 않도록** 식별자를 끊거나 대체 키로 바꾼다.
- **보관 기간 만료 시** → 배치로 **진짜 삭제**하거나 아카이브에서도 제거한다.

**한 문장으로**: "**soft delete는 '삭제'가 아니라 '비활성화'다.** 파기 의무가 있는 데이터에는 soft delete를 쓰지 않거나, **쓰더라도 식별 정보는 즉시 파기하고 비식별 껍데기만 남긴다.**" 이 구분을 말할 수 있으면 **삭제를 도메인 상태로 다룰 때의 대가를 법·운영 층까지 세어본 사람**으로 보인다.

---

## 한 줄 요약

**"삭제됨"은 우리 팀 안의 약속일 뿐 DB도 JPA도 모른다** — 그래서 탈퇴 회원의 행은 여전히 `UNIQUE(email)`을 점유해 재가입을 막고(§1), JPA는 컬렉션을 채울 때 **FK만 보고 `where post_id = ?`로 자식을 전부 긁어와** 삭제된 댓글까지 딸려온다(§4-1). **연관관계 쪽 처방**은 **`@SQLRestriction("deleted = false")` + `@SQLDelete`** 세트(6.4의 `@SoftDelete`는 이 둘을 하나로 묶은 것)로 조회 SQL에 조건이 자동으로 붙게 하는 것이고, **그 대가는 "끌 수 없다"** — 관리자·통계 경로가 **예외 없이 조용히 0건**이 되므로 **네이티브 쿼리·별도 읽기 엔티티·DTO 프로젝션으로 탈출구를 처음부터 설계**해야 한다(중급 Q5의 `@JsonIgnore`가 실패한 이유와 **정확히 같은 구조** — 엔티티에 박은 전역 스위치는 예외를 만들 수 없다). **유니크 쪽 처방은 DB가 가른다** — **PostgreSQL은 부분 유니크 인덱스 한 줄**이면 끝이고, **MySQL엔 그 기능이 없어서** 이메일 변형(원본 소실)·복합 유니크(boolean이면 **두 번째 탈퇴에서 재충돌**)라는 우회로가 필요한 것이며, MySQL에서 가장 깨끗한 답은 **생성 컬럼으로 삭제 행의 키를 `NULL`로 만드는 것**이다. 그리고 `deleted_at`으로 갈아타면 **활성 행의 `NULL`끼리는 서로 다르다고 취급되어 "같은 이메일 활성 회원 2명"이라는 더 나쁜 구멍**이 열리고, 시간을 유니크 키에 넣는 순간 **정합성이 정밀도라는 확률에 의존**하게 된다 — 그래서 **삭제 구분자는 `deleted_seq = id`처럼 유일성이 정의상 보장되는 값**이어야 하고 **시각은 정보로만** 남긴다. soft delete를 택한 이상 **복합 인덱스 선두에 `deleted`를 넣어야 하고**, 데이터는 계속 쌓이며, **집계에서 조건 하나가 빠지면 예외 없이 숫자만 틀린다.** 이 청구서가 감당 범위를 넘어가면 **아카이브 테이블 분리**가 유니크·조회·인덱스·집계·FK 문제를 **한꺼번에** 없앤다(대신 `UNION` 이력 조회·복구 절차·스키마 이중 관리를 얻는다). 그리고 이 모든 규칙은 **가입–탈퇴–재가입–재탈퇴 4단계 테스트**와 **관리자 경로가 0건이 아님을 단정하는 테스트**로 고정하기 전까지는 **언젠가 지워질 주장일 뿐이다.**
