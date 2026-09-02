# 운영 DB의 FK 제약 논쟁 — PostgreSQL에서 FK가 실제로 무엇을 잡는가, 그리고 포기한 방어선을 무엇으로 메우는가

> 핵심 관전 포인트: **FK는 "가리키는 곳이 반드시 있다"를 어떤 경로로 들어와도 강제하는 최후 방어선이다. PostgreSQL에서 그 대가에는 이름이 정확히 붙는다 — 자식 INSERT마다 부모 행에 **`FOR KEY SHARE`** 락을 커밋까지 쥐고(공유끼리 겹치면 `xmax`에 multixact), 부모 DELETE·키 UPDATE마다 자식 테이블을 훑는데 **PostgreSQL은 자식 FK 컬럼 인덱스를 자동으로 만들어 주지 않아** 그 훑기가 그대로 Seq Scan이 된다 — **PostgreSQL에서 FK로 나는 사고의 1순위다.** 반대로 InnoDB(MySQL)의 고전 데드락("자식 INSERT의 S 락 ↔ 부모 카운터 UPDATE의 X 락")은 **PostgreSQL에서 나지 않는다**: 키가 아닌 컬럼만 바꾸는 UPDATE는 `FOR NO KEY UPDATE`를 잡고 이건 `FOR KEY SHARE`와 충돌하지 않기 때문이며, 그 사슬은 코드가 부모를 `SELECT … FOR UPDATE`(JPA `PESSIMISTIC_WRITE`)로 잡을 때만 살아난다. 남는 진짜 이유는 운영 쪽 — `ADD FOREIGN KEY`의 `SHARE ROW EXCLUSIVE` + 전체 검증, 적재·아카이빙의 순서 제약, 샤딩·서비스 분리에서의 성립 불가, CASCADE가 남기는 죽은 튜플·WAL, 그리고 "대규모 회사 관행의 전파". 그런데 PostgreSQL은 이 중 절반을 깎을 도구를 엔진에 갖고 있다(FK 컬럼 인덱스 · `FOR NO KEY UPDATE` · `NOT VALID`→`VALIDATE` · `DEFERRABLE` · `session_replication_role`). 그래서 **PostgreSQL에서 "건다"는 더 강한 기본값**이고, 빼는 것은 조건이 확인된 예외이며, 빼는 순간 앱 레벨 존재 검증 + 소프트 삭제 + FK 컬럼 인덱스 강제 + 고아 탐지 배치와 알람 + 소프트 참조 규약·문서화(+ 테스트 환경에서만 FK 켜기)가 한 세트로 따라와야 한다. 대체 체계를 운영할 준비 없이 FK만 빼는 것은 결정이 아니라 방치다.**

---

## 0. 질문 + 의도

**질문**: "운영 DB에서 FK 제약을 걸지 않는 팀이 많은 이유는 무엇이고, 본인의 견해는? FK 없이 정합성은 어떻게 지키나요?"

**PostgreSQL 기준 재해석**: "PostgreSQL에서 FK가 검사할 때 실제로 잡는 락과 훑는 대상은 무엇이고, 그중 어디까지가 정말 'FK를 빼야 할 이유'인가? 뺀다면 정합성은 무엇으로 지키나?"

**출제 의도**: 대용량 환경에서 FK가 만드는 비용(락 전파, 마이그레이션 제약, 샤딩 불가)과 FK를 포기했을 때 잃는 최후 방어선을 **양쪽 다** 말할 수 있는지 — 교과서 규범("참조 무결성은 DB가 지킨다")과 실무 관행("운영 DB엔 FK 안 건다")이 충돌하는 지점에서 **"우리 서비스의 조건"으로 결론을 내는 사고**를 본다. 앱 레벨 검증 + 배치 정합성 점검으로 대체하는 체계까지 말하면 상급이다.

즉 이 문항은 "FK 찬성/반대"를 묻는 것이 아니다. **찬반 논쟁형 문항의 채점은 어느 쪽을 골랐는지가 아니라 양쪽을 같은 무게로 다뤘는지에서 갈린다.** 채점 지점은 세 층이다 — ⑴ 비용을 "느려진다"가 아니라 **메커니즘으로** 말하는가 ⑵ 잃는 것을 **회피하지 않고 정면으로** 말한 뒤 조건으로 결론 내는가 ⑶ 포기한 방어선을 **사람의 주의력이 아닌 체계로** 대체하는가.

PostgreSQL에서는 한 층이 더 붙는다 — ⑷ **"들은 이유"가 우리 엔진에도 해당되는지 검증했는가**(2-1, 2-2).

> 이 문서의 구성은 그 채점 지점을 그대로 따른다. **1장**에서 FK가 무엇을 지키고 그때 PostgreSQL이 매번 무슨 일을 하는지를 고정하고(여기가 나머지 전부의 토대다), **2장**에서 "걸지 않는 이유 7가지"와 "포기하면 잃는 것 4가지"를 **같은 장 안에 나란히** 놓아 어느 쪽으로도 기울지 않게 하며, **3장**에서 대체 체계 일곱과 조건부 결론을 다룬다. 후보자의 횡단 약점 네 가지 — ① 비용을 **이름 붙은 메커니즘 사슬**로 말하기 ② 잃는 것까지 **양면으로 조립**하고 "우리 서비스의 조건"으로 결론 내기 ③ 포기한 방어선을 **코드·잡·규약으로 고정**하기 ④ "안 거는 이유 N가지 / 잃는 것 N가지 / 대체 체계 N가지"를 **목록으로 인출**하기 — 를 겨냥한 배치다.

> 연결 문서: FK가 걸린 테이블의 스키마 변경이 왜 까다로운지는 [무중단 스키마 변경](14-online-ddl-zero-downtime-schema-change.md), `FOR UPDATE`와 `FOR NO KEY UPDATE`의 차이와 **행 락 4종 충돌 행렬 전체**는 [SELECT FOR UPDATE 락 범위 §1-5](19-select-for-update-lock-scope.md), PostgreSQL에서 데드락이 나는 유형은 [행 락과 데드락](12-gap-lock-next-key-lock-deadlock.md), "정합성이 DB 제약이 아니라 앱 관례에 살면 왜 새는지"는 [정규화 vs 반정규화 §2-3](04-normalization-vs-denormalization.md), soft delete가 FK를 무의미하게 만드는 지점은 [Soft delete와 유니크·연관관계 §3-8](../03-jpa-orm/26-soft-delete-unique-and-associations.md), JPA cascade와 DB `ON DELETE CASCADE`의 차이는 [CascadeType.REMOVE와 orphanRemoval §3-1](../03-jpa-orm/24-cascade-remove-vs-orphan-removal.md), "참조는 둘, FK는 하나"의 매핑 기초는 [연관관계의 주인과 mappedBy](../03-jpa-orm/06-association-owner-and-mappedby.md)에 있다.

---

## 1. FK가 하는 일 — 무엇을 지키고, 그 대가로 PostgreSQL이 매번 무엇을 하는가

### 1-1. 참조 무결성 = "가리키는 곳이 반드시 있다", 그리고 고아 행이란 무엇인가

외래 키(FK, foreign key) 제약은 한 문장이다 — **자식 행의 참조 컬럼 값은 부모 테이블에 반드시 존재하는 키여야 한다.** `comments.post_id = 42`라면 `posts.id = 42`가 있어야 하고, 그 행을 지우려면 먼저 댓글을 처리해야 한다. 이 성질을 **참조 무결성(referential integrity)**이라 부른다.

이 문서 전체에서 반복해서 나오는 용어를 여기서 못 박는다.

> **고아 행(orphan row)** = **가리키는 부모가 이미 사라진 자식 행.** `comments.post_id = 42`인데 `posts`에 `id = 42`가 없는 상태의 그 댓글 행이다. 부모가 있었다가 지워졌거나, 애초에 없는 값으로 자식이 들어왔거나 둘 중 하나다. 참조 무결성이 깨졌다는 말과 "고아 행이 생겼다"는 말은 같은 뜻이다.

이름이 직관적인 만큼 무서움은 과소평가되기 쉬운데, **고아 행의 진짜 성질은 "생겨도 아무 일도 일어나지 않는다"는 것**이다. 왜 조용한지는 2-10에서 구체 시나리오로 다룬다.

비유하면 FK는 건물 출입구의 경비원이다. 어떤 문으로 들어오든(앱 코드, 배치, 운영자의 psql `DELETE`) 신분증(부모 존재)을 확인한다. 경비원을 없애면 출입도 이삿짐(대량 적재)도 빨라지지만, 그때부터 "누가 들어왔는지"는 각 부서(코드 경로)가 알아서 확인해야 한다.

> PostgreSQL에서 "DB가 지키는 불변식"의 도구 상자는 FK 하나가 아니다 — `CHECK`(값의 범위·형식), `UNIQUE`(부분 유니크 인덱스 포함), PostgreSQL 고유의 `EXCLUDE` 제약(기간 겹침 금지 같은 것)까지 있다. FK 논쟁이 "제약 전체를 뺄 것인가"로 번지지 않으려면 **참조 무결성만 앱으로 내려보내는 결정**임을 분명히 해 둔다.

### 1-2. 검사가 일어나는 네 순간 — 그리고 각 순간에 PostgreSQL이 하는 일

FK를 "느리다"고 뭉뚱그리지 않으려면 **언제 검사가 일어나고 그때 무엇을 하는지**부터 고정해야 한다. **이 표가 이 문서 전체의 토대다** — 2장의 "걸지 않는 이유 7가지" 중 최소 세 개(①, ②, ⑥)가 이 표의 칸 하나에서 유도된다.

FK 검사는 딱 **네 순간**에만 일어난다. 그 밖의 어떤 순간에도 FK는 아무 일도 하지 않는다 — 평상시 SELECT에는 비용이 0이라는 뜻이다.

| 순간 | ⑴ PostgreSQL이 확인하는 것 | ⑵ 어느 테이블의 어느 행에 무슨 락 | ⑶ 인덱스가 없으면 도는 스캔 |
|---|---|---|---|
| **① 자식 INSERT** | "이 `post_id` 값을 가진 부모가 있는가" — 부모의 PK(또는 유니크 인덱스)를 탐색 | **부모 행**에 `FOR KEY SHARE`. 커밋까지 유지 | 부모 쪽은 **PK 인덱스가 항상 있으므로 문제없다** (FK는 유니크 제약이 있는 컬럼만 참조할 수 있다) |
| **② 자식의 FK 컬럼 UPDATE** | ①과 같다 — **새 부모 값**의 존재 확인 (옛 부모는 놓아준다) | 새 **부모 행**에 `FOR KEY SHARE` | ①과 같다 |
| **③ 부모 DELETE** | "이 부모를 가리키는 자식이 남아 있는가" — **자식 테이블을 역방향으로 탐색** | `RESTRICT`/`NO ACTION`이면 찾아낸 **자식 행**에 `FOR KEY SHARE`. `CASCADE`면 자식에 실제 DELETE 실행 | **자식 테이블 전체 Seq Scan** — PostgreSQL은 자식 FK 컬럼 인덱스를 자동으로 만들지 않는다. **여기가 사고의 1순위다(2-2)** |
| **④ 부모 키 UPDATE** | ③과 같다 (참조되는 키 값이 바뀌면 기존 자식이 고아가 되므로) | ③과 같다 | ③과 같다. 실무에서는 PK를 바꾸는 일이 드물어 잘 안 만난다 |

표를 세로로 읽으면 두 방향이 보인다. **①②는 "자식 → 부모" 방향**이고 부모에는 PK가 반드시 있으니 탐색이 항상 싸다 — 여기서 나오는 비용은 스캔이 아니라 **락**이다(2-1). **③④는 "부모 → 자식" 방향**이고 자식 쪽에는 인덱스가 보장되지 않는다 — 여기서 나오는 비용은 락이 아니라 **스캔**이다(2-2).

**FK 비용을 한 문장으로 요약하면**: 자식 방향은 락 문제, 부모 방향은 인덱스 문제. 이 구분을 못 하면 "FK는 느려서 뺐다"가 근거 없는 관행 반복으로 들린다.

### 1-3. 표에서 고정할 네 가지

**⑴ 검사는 내부 트리거로 구현된다.** PostgreSQL의 FK는 문법 설탕이 아니라 **시스템 트리거**다. 제약 자체는 카탈로그 테이블 `pg_constraint`에 한 행으로 들어가고, 그 제약이 만드는 실제 검사 트리거는 `pg_trigger`에 들어간다. 이 사실이 뒤에서 세 번 쓰인다: ⓐ `session_replication_role = replica`로 **트리거를 끄면 FK 검사도 함께 꺼진다**(2-3) ⓑ FK 컬럼 인덱스 점검을 **카탈로그 쿼리**로 자동화할 수 있다(3-3) ⓒ 부모 DELETE가 느릴 때 그 시간이 실행 계획 트리가 아니라 **`Trigger …` 줄**에 찍힌다(2-2).

**⑵ 락은 `FOR KEY SHARE`이지 그냥 "공유 락"이 아니다.** PostgreSQL의 행 락은 네 등급이고(`FOR UPDATE` > `FOR NO KEY UPDATE` > `FOR SHARE` > `FOR KEY SHARE`), FK가 잡는 것은 **가장 약한 등급**이다. 뜻은 정확히 "이 행의 **키를 바꾸거나 행을 지우지만** 마라"이고, 그래서 부모의 **키가 아닌 컬럼을 바꾸는 UPDATE는 막지 않는다.** 2-1이 MySQL(InnoDB)과 갈리는 지점이 전부 여기서 나온다.

**⑶ 잡은 락은 트랜잭션이 끝날 때까지 살고, 튜플 헤더 `xmax`에 기록된다.** PostgreSQL은 락을 별도의 락 테이블이 아니라 **데이터 자체(튜플 헤더)에 적는다.** 그래서 락을 잡는 것만으로 부모 페이지가 더러워지고 WAL이 쓰인다 — **"읽기 검사"처럼 보이는 자식 INSERT가 부모 테이블에도 쓰기 부하를 만든다**(가산점 포인트).

여기에 한 겹이 더 있다. `xmax`는 트랜잭션 ID 하나만 담을 수 있는 필드인데, 같은 부모를 여러 트랜잭션이 **동시에 공유 락으로** 잡으면 담을 것이 여럿이 된다. 그래서 PostgreSQL은 그 자리에 **multixact ID**("여럿을 가리키는 하나의 번호")를 넣고 구성원 목록은 별도 저장소(`pg_multixact`)에 둔다. 인기 게시글 하나에 댓글이 초당 수백 개씩 달리면 그 부모 행의 `xmax`에 multixact가 계속 만들어지고 갱신된다 — **핫 부모의 숨은 비용**이 여기 있다.

**⑷ 검사 시점을 미룰 수 있다.** `DEFERRABLE INITIALLY DEFERRED`로 만든 FK는 검사가 **문장 끝이 아니라 커밋 시점**까지 미뤄진다(부모를 붙잡는 락의 창도 그만큼 늦게 열린다). 서로를 참조하는 두 행을 한 트랜잭션에서 넣어야 할 때의 정석이다. 대가는 두 가지 — 위반이 **COMMIT에서 터지므로** 어느 문장이 범인인지 추적이 어렵고, 대량 변경 시 미뤄진 검사 큐가 커밋 순간에 몰린다. 덧붙여 **`NO ACTION`은 미룰 수 있고 `RESTRICT`는 못 미룬다** — 둘의 실질적 차이가 거의 여기뿐이다.

마지막으로 비용의 크기를 오해하지 않게 못 박아 둔다. **검사 자체의 CPU 비용은 작다** — 자식 INSERT 한 건당 부모 유니크 인덱스 탐색 한 번 + 가시성 확인용 힙 페치 한 번이면 끝이다. **FK 비용의 실체는 "찾기"가 아니라 "찾은 뒤 쥐고 있는 락", "인덱스가 없을 때의 훑기", 그리고 운영상의 제약**이다.

---

## 2. 양면 대조 — 걸지 않는 이유 7가지 vs 포기하면 잃는 것 4가지

이 문항이 논쟁형인 이유는 **양쪽 다 진짜이기 때문**이다. FK를 빼는 팀은 겪은 문제가 있어서 빼고, FK를 유지하는 팀도 겪은 문제가 있어서 유지한다. 그래서 이 장은 두 목록을 **같은 장 안에 같은 밀도로** 놓는다 — 한쪽만 말하면 어느 쪽이든 절반짜리 답이다.

> **FK를 안 거는 이유 7가지 (PostgreSQL 판)**
> ① 락 전파 — 자식 INSERT의 `FOR KEY SHARE`가 부모의 `FOR UPDATE`와 충돌
> ② **부모 DELETE의 자식 검사 — PostgreSQL은 FK 컬럼 인덱스를 자동 생성하지 않는다**
> ③ 대량 적재·마이그레이션·아카이빙의 순서 제약
> ④ 스키마 변경 제약 — `ADD FOREIGN KEY`의 `SHARE ROW EXCLUSIVE` + 전체 검증
> ⑤ 샤딩·서비스 분리에서 FK 성립 불가 (파티셔닝은 PostgreSQL에선 예외)
> ⑥ CASCADE의 예측 불가 폭발 — 죽은 튜플·WAL·레플리카 지연까지
> ⑦ (솔직한 이유) 관행의 전파 — 성능은 사후 정당화인 경우가 많다

> **FK를 빼면 잃는 것 4가지**
> ⑧ 최후 방어선 — 어떤 경로로 와도 뚫리지 않는 유일한 검사
> ⑨ 고아 행이 쌓이지 않는다는 보장 — 증상은 몇 달 뒤에 엉뚱한 곳에서
> ⑩ 스키마의 문서 역할 — `\d` 출력·ERD·신규 입사자의 지도
> ⑪ (PostgreSQL판) **카탈로그 근거** — "이 컬럼은 참조 컬럼"이라는 기계가 읽을 수 있는 사실. 인덱스 린트·고아 탐지 목록이 전부 여기에 얹혀 있다

**PostgreSQL에서는 ②가 1순위다.** ①이 첫 줄에 오는 것은 MySQL 이야기를 그대로 옮겨온 순서이고, PostgreSQL 운영에서 FK 때문에 사람이 불려 나가는 사고는 거의 전부 ②다. 이 순서 감각까지 말하면 "읽어서 아는" 게 아니라 "겪어서 아는" 사람으로 들린다.

### 2-1. 이유 ① 락 전파 — `FOR KEY SHARE` ↔ `FOR UPDATE`, 그리고 PostgreSQL에서 사라지는 고전 데드락

가장 자주 인용되는 사슬이고 [정규화 문서](04-normalization-vs-denormalization.md)의 `posts.comment_count` 예제와 맞물린다. **그런데 PostgreSQL에서는 이 사슬의 중간이 끊어진다** — 끊어지는 지점을 짚는 것이 이 절의 목적이다. 세 질문에 순서대로 답하면 전부 나온다.

#### ⑴ 왜 자식 INSERT가 **부모 행**을 잠그는가

`INSERT INTO comments (post_id) VALUES (42)`는 FK 검사로 `posts.id = 42`가 있는지 본다. 있으면 통과다. 그런데 **"봤다"와 "커밋했다" 사이에 시간이 있다.** 그 사이에 다른 트랜잭션이 `DELETE FROM posts WHERE id = 42`를 커밋해 버리면, 내 댓글은 커밋되는 순간 **고아 행**이 된다 — 검사는 통과했는데 결과는 무결성 위반이다.

그래서 DB는 확인한 그 부모 행을 **"내가 커밋할 때까지는 사라지지도 키가 바뀌지도 마라"**고 붙잡아 둔다. 이것이 FK 검사가 부모 행에 락을 거는 이유다. 검사가 읽기처럼 생겼는데 락을 남기는 것이 이상해 보이지만, **락이 없으면 검사가 의미가 없다.**

#### ⑵ 왜 하필 `FOR KEY SHARE`인가 — `FOR UPDATE`가 아니라

자식이 부모에게 바라는 것은 딱 하나다. **"내가 참조하는 그 키로 부모가 계속 존재할 것."** 부모의 제목이 바뀌든 조회수가 바뀌든 댓글 수가 바뀌든, 자식은 아무 상관이 없다.

그러니 필요한 락은 "이 행의 **키**를 바꾸거나 지우지 마라"라는 가장 약한 등급이면 충분하다. 그게 `FOR KEY SHARE`다 — **KEY**(키에 대해서만) **SHARE**(공유로, 즉 여럿이 동시에 잡을 수 있게). 이름 자체가 정의다.

만약 FK가 `FOR UPDATE`(가장 강한 등급)를 잡았다면 어떻게 될까. `FOR UPDATE`는 다른 모든 등급과 충돌하므로, **댓글 하나가 달리는 동안 그 게시글의 조회수 UPDATE도, 다른 댓글의 INSERT도 전부 줄을 서게 된다.** 등급을 세분해 둔 덕에 PostgreSQL은 이 대기를 전부 피한다.

#### ⑶ 그래서 MySQL의 고전적 FK 데드락이 PostgreSQL에서는 왜 사라지는가

FK 데드락의 교과서 예제는 "댓글을 달면서 게시글의 댓글 수 카운터도 올리는" 코드다.

```text
T1: INSERT INTO comments (post_id) VALUES (42)     → 부모 42 에 락 A
    UPDATE posts SET comment_count = ... WHERE id = 42  → 부모 42 에 락 B
T2: 같은 순서로 같은 부모 42 에 대해

MySQL(InnoDB):
    락 A = 공유(S) 레코드 락,  락 B = 배타(X) 락 — S와 X는 호환되지 않는다
    T1 의 S 와 T2 의 S 는 둘 다 통과 → 그 다음 둘 다 X 를 원함
    → T1 은 T2 의 S 때문에, T2 는 T1 의 S 때문에 대기 → 교착
    → ERROR 1213 (40001) Deadlock found

PostgreSQL:
    락 A = FOR KEY SHARE
    락 B = FOR NO KEY UPDATE   ← comment_count 는 키가 아니므로 PG 가 이 등급을 고른다
    FOR KEY SHARE 와 FOR NO KEY UPDATE 는 호환된다
    → T1 도 T2 도 대기 없이 통과. 데드락 자체가 존재하지 않는다
```

**핵심은 "PostgreSQL이 UPDATE의 락 등급을 바뀌는 컬럼에 따라 자동으로 고른다"는 것이다.** 참조되는 키(보통 PK)를 건드리지 않는 UPDATE는 `FOR NO KEY UPDATE`, 키를 바꾸거나 행을 지우는 것만 `FOR UPDATE`다. 이 자동 강등이 InnoDB에는 없다 — InnoDB의 UPDATE는 무엇을 바꾸든 X 락이다.

#### FK 맥락의 충돌 행렬

행 락 4종의 전체 충돌 행렬은 [SELECT FOR UPDATE 락 범위 §1-5](19-select-for-update-lock-scope.md)에 있다. 여기서는 FK 맥락에서 실제로 만나는 세 등급만 잘라 본다.

| 요청(행) \ 이미 걸린 락(열) | `FOR KEY SHARE`<br>(FK 검사 = 자식 INSERT) | `FOR NO KEY UPDATE`<br>(부모의 비-키 UPDATE) | `FOR UPDATE`<br>(부모 DELETE·키 UPDATE·`PESSIMISTIC_WRITE`) |
|---|---|---|---|
| **`FOR KEY SHARE`** (자식 INSERT) | 통과 (겹치면 `xmax`에 multixact) | **통과** ← 여기가 InnoDB와 갈린다 | **충돌(대기)** |
| **`FOR NO KEY UPDATE`** (부모 카운터 UPDATE) | **통과** | 충돌(대기) | 충돌(대기) |
| **`FOR UPDATE`** (부모 DELETE·키 UPDATE) | **충돌(대기)** | 충돌(대기) | 충돌(대기) |

**표에서 읽어야 할 것은 첫 행의 가운데 칸 하나다.** `FOR KEY SHARE`와 충돌하는 것은 `FOR UPDATE` 하나뿐이고, `FOR UPDATE`는 **부모를 지우거나 부모의 키를 바꾸거나 코드가 명시적으로 `SELECT … FOR UPDATE`를 쓸 때만** 나온다. 그러니 —

> **PostgreSQL에서 ①의 정확한 서술은 "FK가 락 사고를 만든다"가 아니라 "부모를 `FOR UPDATE`로 잡는 코드가 있을 때, FK가 그 락의 영향 범위를 자식 INSERT까지 넓힌다"이다.**

#### 사슬이 살아나는 조건과 그 뒤

재고·잔액·포인트를 다루느라 `SELECT … FROM posts WHERE id = 42 FOR UPDATE`(JPA `@Lock(PESSIMISTIC_WRITE)`)를 쓰면 이야기가 달라진다. `FOR UPDATE`는 표의 마지막 행처럼 **모든 등급과 충돌**하므로 `FOR KEY SHARE`를 막는다 → **그 부모를 참조하는 모든 자식 INSERT가 줄을 선다.** FK가 없었다면 자식 INSERT는 부모의 락에 아무 관심이 없었을 것이다.

그 뒤로 두 갈래가 이어진다.

- **대기의 교차 = 데드락.** 두 트랜잭션이 각각 "자식 INSERT → 부모 `FOR UPDATE`" 순서로 가면, 서로가 쥔 `FOR KEY SHARE` 때문에 둘 다 `FOR UPDATE`를 못 얻어 교착한다. `deadlock_timeout`(기본 1초) 뒤 감지돼 한쪽이 `40P01`로 죽는다.
- **대기 전파.** 데드락이 아니어도, 부모를 `FOR UPDATE`로 오래 쥐는 트랜잭션 하나가 그 부모의 자식 INSERT 전부를 락 큐에 세운다 → 트랜잭션 장기화 → 커넥션 풀 고갈 → 무관한 API까지 전파. PostgreSQL에서는 여기에 한 겹 더 붙는다 — 길어진 트랜잭션이 VACUUM을 막아 [bloat](16-long-transaction-harm-and-shortening.md)로 번진다.

```sql
-- before — PostgreSQL에서 실제로 데드락이 나는 형태. 부모를 FOR UPDATE 로 잡는 코드다
-- T1                                          -- T2
BEGIN;                                         BEGIN;
INSERT INTO comments (post_id, body)           INSERT INTO comments (post_id, body)
VALUES (42, 'a');                              VALUES (42, 'b');
-- FK 검사 → posts.id=42 에 FOR KEY SHARE      -- FK 검사 → posts.id=42 에 FOR KEY SHARE
--                                             -- KEY SHARE 끼리는 호환 → 둘 다 통과
--                                             -- (xmax 에 multixact 가 만들어진다)
SELECT * FROM posts WHERE id = 42
FOR UPDATE;        -- T2 의 KEY SHARE 때문에 대기
                                               SELECT * FROM posts WHERE id = 42
                                               FOR UPDATE;   -- T1 의 KEY SHARE 때문에 대기
-- ⇒ deadlock_timeout(기본 1초) 후 감지 → 한쪽을 abort
-- ERROR: deadlock detected  (SQLSTATE 40P01)
```

```sql
-- after — 락 등급을 낮춘다. PostgreSQL에서는 이것이 정답이고, 순서 반전 같은 우회가 필요 없다
BEGIN;
INSERT INTO comments (post_id, body) VALUES (42, 'a');   -- 부모에 FOR KEY SHARE
UPDATE posts SET comment_count = comment_count + 1       -- 부모에 FOR NO KEY UPDATE
WHERE id = 42;                                           -- ← KEY SHARE 와 호환. 대기도 데드락도 없다
COMMIT;
-- 명시적으로 잠가야 한다면 FOR UPDATE 가 아니라 FOR NO KEY UPDATE 를 쓴다.
-- 판단 기준 한 줄: "이 트랜잭션이 부모의 키를 바꾸거나 부모 행을 지우는가?"
-- 아니라면 FOR UPDATE 는 과하다.
```

> **MySQL 대조 — 여기가 엔진이 갈리는 지점이다.** InnoDB에는 락 등급이 `FOR KEY SHARE`처럼 세분돼 있지 않다. 자식 INSERT는 부모 행에 **공유(S) 레코드 락**을 잡고, `comment_count` UPDATE는 **배타(X) 락**을 요구하며, S와 X는 호환되지 않는다 → **두 트랜잭션이 "자식 INSERT → 부모 UPDATE" 순서로 가면 그것만으로 데드락**(`ERROR 1213 (40001)`). 회피하려면 부모 UPDATE를 먼저 두어 X를 선점해야 하는데, 그러면 락 보유 시간이 길어지는 딜레마가 생긴다. 덧붙여 InnoDB는 **READ COMMITTED로 낮춰도 FK 검사의 갭 락은 남는다.** PostgreSQL에는 갭 락이라는 개념 자체가 없다([행 락과 데드락 문서](12-gap-lock-next-key-lock-deadlock.md)). **"FK는 락 때문에 못 쓴다"는 논거를 PostgreSQL에 그대로 옮기면 틀린다** — 이 대조를 말할 수 있으면 두 엔진을 원리로 이해한 사람으로 들린다.

처방도 여기서 나온다 — FK를 빼기 전에 **락 등급을 낮추거나 원자적 UPDATE로 명시적 락을 없앤다.** 그러고도 남는 경합이라면 그건 FK 문제가 아니라 [핫 로우 문제](23-high-frequency-counter-hot-row.md)다.

### 2-2. 이유 ② 부모 DELETE의 자식 검사 — PostgreSQL은 FK 컬럼 인덱스를 자동으로 만들지 않는다

**PostgreSQL에서 FK로 나는 사고의 압도적 1위다.**

1-2 표의 ③번 행을 펼치면 된다. 부모 행을 지우면 DB는 "이 부모를 가리키는 자식이 있나"를 자식 테이블에서 찾아야 한다. 자식의 FK 컬럼에 인덱스가 있으면 탐색 한 번, 없으면 **자식 테이블 전체 Seq Scan**이다. 그리고 —

- **MySQL(InnoDB)**: FK를 만들 때 자식 FK 컬럼 인덱스가 없으면 **자동으로 만든다** — 그래서 이 함정을 거의 겪지 않는다.
- **PostgreSQL**: **자동으로 만들지 않는다.** 부모 쪽은 PK라 이미 있지만 자식 쪽은 사람이 만들어야 한다. 이 한 줄이 PostgreSQL FK 사고의 대부분을 설명한다.

증상은 이렇게 나타난다.

```sql
-- before — FK 는 걸었는데 인덱스는 안 만들었다 (PostgreSQL 에서 아주 흔하다)
CREATE TABLE comments (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id    bigint NOT NULL REFERENCES posts (id),   -- 인덱스는 생기지 않는다
    body       text   NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 부모 한 행 삭제 = 자식 1천만 건 Seq Scan
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM posts WHERE id = 42;
--  Delete on posts  (actual time=8421.093..8421.094 rows=0 loops=1)
--    ->  Index Scan using posts_pkey on posts  (actual rows=1 loops=1)
--  Trigger RI_ConstraintTrigger_a_16428 for constraint comments_post_id_fkey:
--        time=8412.377 calls=1                     ← 시간의 99%가 FK 트리거 안에 있다
--  Execution Time: 8421.402 ms
-- (트리거가 도는 SELECT 1 FROM comments WHERE post_id = $1 FOR KEY SHARE 가
--  Seq Scan 이다. 계획 본문에는 안 보이고 Trigger 줄의 time 으로만 드러난다.)
ROLLBACK;

-- after — 자식 FK 컬럼 인덱스. 다시 재면 Trigger 의 time 이 밀리초로 떨어진다
CREATE INDEX CONCURRENTLY idx_comments_post_id ON comments (post_id);
```

**"자식 1천만 건이면 왜 8초인가"를 계산해 둔다.** 이 숫자가 손에 잡혀야 "인덱스를 만들자"가 취향이 아니라 결론이 된다.

```text
comments 한 행의 크기
   튜플 헤더 23B + 정렬 패딩 1B                        = 24B
   id(bigint) 8 + post_id(bigint) 8 + created_at 8     = 24B
   body(text) 평균 140자 + varlena 헤더 4B             = 144B
                                                 합계 = 192B

페이지당 행 수
   (8192 - 24) ÷ (192 + 4)  =  8168 ÷ 196  ≈  41 행       (24B 페이지 헤더, 4B 라인 포인터)

자식 1천만 건의 테이블 크기
   10,000,000 ÷ 41  =  243,903 페이지  =  243,903 × 8KB  ≈  1.9 GB

Seq Scan 소요 시간
   디스크 순차 읽기 250MB/s 기준 :  1,900MB ÷ 250MB/s  ≈  7.6 초
   여기에 행 하나하나를 비교하는 CPU 약 1초  →  합계 약 8.6 초
   → EXPLAIN 의 Trigger time = 8,412ms 와 맞는다

부모 한 행을 지우는 데 1.9GB를 읽는다. 그리고 이 비용은 부모 행 수에 곱해진다.
자식이 1억 건이면 같은 계산으로 244만 페이지 = 19GB = 약 80초다.
```

**진단 포인트 둘.** ⓐ 계획 트리에는 FK 검사가 안 보이고 **`Trigger …: time=… calls=…` 줄**로만 드러난다 — "DELETE 한 줄인데 8초"의 범인을 찾는 자리다(`EXPLAIN ANALYZE`는 실제로 실행되므로 DML은 위 예처럼 `BEGIN; … ROLLBACK;`으로 감싼다). ⓑ 상시 감시는 자식 테이블의 `pg_stat_user_tables.seq_scan` 증가로.

같은 함정이 **`ON DELETE CASCADE`에서는 곱해진다.** 캐스케이드는 자식에 실제 `DELETE FROM comments WHERE post_id = $1`을 실행하므로, 인덱스가 없으면 **부모 한 행마다 자식 전체 스캔**이다 — 부모 1,000건을 정리하는 배치가 1.9GB짜리 풀스캔을 1,000번 돌아 **1.9TB를 읽는다.** 배치가 밤새 안 끝나는 이유가 이것이다.

즉 ②는 "FK를 빼는 이유"라기보다 **"PostgreSQL에서 FK를 걸면 반드시 함께 만들어야 하는 것을 빠뜨렸을 때 생기는 문제"**다. 3-3의 린트가 PostgreSQL에서 **FK를 걸든 안 걸든** 필요한 이유이기도 하다.

### 2-3. 이유 ③ 대량 적재·마이그레이션·아카이빙의 순서 제약

FK가 있으면 데이터 이동에 **순서**가 생긴다. 부모가 없으면 자식을 못 넣으니 "부모 먼저, 자식 나중"이 강제된다.

**적재**: 수억 건을 여러 워커가 병렬로 붓는 파이프라인에서 이 순서는 병렬성을 죽인다. "댓글 워커"가 "게시글 워커"의 완료를 기다려야 하기 때문이다. PostgreSQL에서 푸는 방법은 셋이고, 셋이 지불하는 대가가 다르다.

```sql
-- ⑴ 검사 트리거를 통째로 끄고 붓는다 (슈퍼유저 권한 필요)
SET session_replication_role = replica;   -- FK·사용자 트리거가 발동하지 않는다
COPY comments FROM '/data/comments.csv' WITH (FORMAT csv);
SET session_replication_role = origin;
-- 주의: 되돌려도 이미 들어간 데이터는 소급 검사되지 않는다 — MySQL 의 foreign_key_checks=0 과
--    같은 함정이다. "적재 중엔 어차피 끈다"가 "평소에도 없는 것과 뭐가 다른가"로 이어진다.

-- ⑵ 제약을 잠시 떼고 붓고, 다시 붙일 때 검증까지 한다 (PostgreSQL 정석)
ALTER TABLE comments DROP CONSTRAINT comments_post_id_fkey;
COPY comments FROM '/data/comments.csv' WITH (FORMAT csv);
ALTER TABLE comments ADD CONSTRAINT comments_post_id_fkey
    FOREIGN KEY (post_id) REFERENCES posts (id) NOT VALID;   -- 락 짧게, 새 행부터 검사
ALTER TABLE comments VALIDATE CONSTRAINT comments_post_id_fkey;  -- 쓰기 허용하며 기존 행 검증

-- ⑶ 한 트랜잭션 안에서 순서를 섞어야 하면 검사를 커밋으로 미룬다
--    ALTER TABLE … ALTER CONSTRAINT … DEFERRABLE INITIALLY DEFERRED;
--    또는 한시적으로  BEGIN; SET CONSTRAINTS ALL DEFERRED; … COMMIT;
```

⑵가 **"적재 때문에 FK를 아예 안 건다"를 상당 부분 무력화하는 선택지**다 — 검사를 영구히 포기하는 대신 **나중에 한 번 몰아서 한다.** 이 도구를 아느냐 모르느냐로 결론이 갈리므로, 각 단계가 무슨 락을 잡는지는 2-4에서 자세히 본다.

**아카이빙**: 오래된 부모를 옮기려면 자식을 먼저 옮기거나 지워야 하고, 자식이 여러 테이블에 흩어져 있으면 아카이빙 잡이 **FK 그래프 전체**를 알아야 한다. PostgreSQL은 이동을 한 문장으로 원자화할 수 있지만(`WITH moved AS (DELETE … RETURNING *) INSERT …`) **순서 제약은 그대로**다.

**테이블 교체·복구**: `pg_restore`로 테이블 하나만 되살리거나 새 테이블로 스왑하는 작업에서 FK가 다른 테이블을 물고 있으면 순서·잠금 창이 생긴다. (`pg_restore`가 제약을 데이터 적재 뒤에 거는 것도 같은 이유다.)

### 2-4. 이유 ④ 스키마 변경 제약 — `ADD FOREIGN KEY`의 잠금과 검증 스캔

PostgreSQL에는 gh-ost·pt-osc 같은 외부 도구 이야기가 없다. 대신 **모든 것이 잠금 수준의 문제**로 환원된다([무중단 스키마 변경](14-online-ddl-zero-downtime-schema-change.md)).

#### 그냥 `ADD FOREIGN KEY`를 치면 무슨 일이 일어나나

`ALTER TABLE comments ADD FOREIGN KEY (post_id) REFERENCES posts (id)` 한 줄은 두 가지 일을 **한 트랜잭션 안에서** 한다.

1. **제약을 카탈로그에 등록**한다 — 이것 자체는 순식간이다.
2. **기존 데이터가 이 제약을 이미 만족하는지 자식 테이블 전체를 훑어 검증**한다 — 1천만 건이면 2-2에서 계산한 그 1.9GB 스캔이다.

그리고 이 트랜잭션은 시작할 때 **두 테이블 모두에 `SHARE ROW EXCLUSIVE` 락**을 잡는다. SELECT는 허용하지만 **INSERT/UPDATE/DELETE를 막고**, **부모 테이블의 쓰기까지 함께 막힌다**는 점이 자주 간과된다. 자식에 FK를 거는데 부모의 쓰기가 멈추는 것이다(부모의 키가 검증 도중에 바뀌면 검증 결과가 무효가 되니 당연한 조치다).

**대기열 함정이 여기에 겹친다.** PostgreSQL의 락 요청은 줄을 서는데, **줄을 선 요청 뒤로 오는 요청도 함께 줄을 선다.** 그래서 진행 중인 롱 트랜잭션 하나가 이 `ALTER TABLE`을 막고 있으면, `ALTER TABLE`이 그 뒤의 **모든 일반 쓰기까지 줄 세운다** — 마이그레이션 한 줄이 전면 장애가 되는 전형적 경로다.

#### `NOT VALID` → `VALIDATE` 2단계 — 이 문서의 실전 카드

PostgreSQL은 위 두 가지 일을 **분리할 수 있게** 해 뒀다. 이것이 MySQL에 없는 결정적 차이다.

| 단계 | 무엇을 하나 | 잡는 락 | 얼마나 오래 | 무엇이 막히나 |
|---|---|---|---|---|
| **1단계** `ADD CONSTRAINT … NOT VALID` | 제약을 카탈로그에 등록만 한다. **기존 데이터는 훑지 않는다** | `SHARE ROW EXCLUSIVE` (두 테이블) | **밀리초** — 카탈로그 한 행 쓰기가 전부 | 그 순간뿐. `lock_timeout`으로 대기를 끊으면 사실상 무해 |
| **2단계** `VALIDATE CONSTRAINT` | 기존 데이터 전체를 훑어 위반이 없는지 확인하고, 제약을 "검증됨"으로 표시 | **`SHARE UPDATE EXCLUSIVE`** (두 테이블) | 자식 크기에 비례 — 1천만 건이면 수 초~수십 초 | **읽기도 쓰기도 안 막는다.** 대신 그 테이블의 autovacuum·다른 DDL과는 충돌 |

**왜 이렇게 나누면 운영 중에 걸 수 있는가**를 한 문장으로 정리하면 — **비싼 일(전체 스캔)과 위험한 락(쓰기 차단)을 서로 다른 단계로 떼어 놓았기 때문**이다. 1단계는 락이 세지만 순식간이라 창이 열리지 않고, 2단계는 오래 걸리지만 락이 약해 아무도 안 막는다. 원래는 "세고 + 긴" 하나였던 것이 "세고 짧은 것"과 "약하고 긴 것"으로 갈라진다.

그리고 **1단계만 끝나도 이미 절반의 방어선이 선다** — `NOT VALID` 상태의 FK도 **새로 들어오는 INSERT/UPDATE는 정상적으로 검사한다.** 검증되지 않은 것은 "이미 들어와 있던 과거 데이터"뿐이다.

```sql
-- 운영에서 FK 를 거는 정석 — 짧은 락 + 재시도, 그리고 검증은 따로
SET lock_timeout = '2s';                       -- 2초 안에 못 잡으면 포기(뒤를 막지 않는다)
ALTER TABLE comments ADD CONSTRAINT comments_post_id_fkey
    FOREIGN KEY (post_id) REFERENCES posts (id) NOT VALID;   -- 검증 스캔 없음 = 락이 짧다
RESET lock_timeout;
-- 실패하면 잠시 뒤 재시도. 여기까지만 해도 "새로 들어오는 행"은 이미 검사된다.

ALTER TABLE comments VALIDATE CONSTRAINT comments_post_id_fkey;
-- SHARE UPDATE EXCLUSIVE — 읽기·쓰기를 막지 않고 기존 데이터를 훑는다.
-- 트래픽이 한가한 시간에 돌린다(autovacuum 과는 충돌하므로).
```

`lock_timeout`을 짧게 걸고 실패하면 재시도하는 이 패턴은 FK만의 이야기가 아니라 PostgreSQL DDL 전반의 규칙이다 — 상세는 [무중단 스키마 변경 §2-2](14-online-ddl-zero-downtime-schema-change.md)(제약을 `NOT VALID`로 걸고 `VALIDATE`로 검증)와 §3-1(`lock_timeout` + 재시도)에 있다. 여기서는 **FK 맥락에서 이 카드가 "④를 이유로 FK를 빼자"는 논거를 거의 무력화한다**는 점만 짚는다.

#### 나머지 두 가지

- **타입 변경의 연쇄**: 부모 PK를 `int` → `bigint`로 바꾸는 작업은 테이블 재작성인 데다 **그 키를 참조하는 FK들이 다시 검증**되고, 자식 FK 컬럼도 함께 바꿔야 하므로 작업 단위가 **FK 그래프 전체**로 커진다.
- **인덱스 순서**: 자식 FK 컬럼 인덱스는 `CREATE INDEX CONCURRENTLY`로 **먼저** 만든다. FK를 먼저 걸면 `VALIDATE`의 검증 스캔이 인덱스 없이 돈다.

> **MySQL 대조**: 같은 제약이 MySQL에서는 **도구 선택지 문제**로 나타난다 — gh-ost는 대상이 FK의 부모든 자식이든 **지원하지 않고**(하드 리밋), pt-online-schema-change는 `--alter-foreign-keys-method`로 `rebuild_constraints`(자식마다 또 하나의 대공사)나 `drop_swap`(테이블이 잠깐 존재하지 않는 창)을 골라야 하며, 네이티브 `ADD FOREIGN KEY`는 검사를 켠 상태면 **COPY 알고리즘**(쓰기 차단, 디스크 2배)이다. **PostgreSQL에는 `NOT VALID` → `VALIDATE`라는 정식 우회로가 엔진 안에 있다**는 것이 결정적 차이고, 그래서 "④ 때문에 뺀다"는 논거는 PostgreSQL에서 그만큼 세지 않다.

### 2-5. 이유 ⑤ 샤딩·서비스 분리 — FK가 성립 불가한 지형 (파티셔닝은 예외)

FK는 **같은 DB 안의 두 테이블** 사이에서만 성립한다. 검사를 하려면 부모 테이블을 실제로 읽어야 하는데, 부모가 다른 서버에 있으면 읽을 방법이 없기 때문이다.

- **샤딩**: `comments`가 `user_id`로 샤딩되고 `posts`가 `post_id`로 샤딩되면 부모와 자식이 다른 서버에 있다. 검사할 대상이 물리적으로 다른 곳에 있으니 FK 자체가 정의될 수 없다([샤딩 문서](24-sharding-timing-shard-key-and-cross-shard.md) — 크로스 샤드 조인이 사라지는 것과 같은 뿌리다). PostgreSQL의 분산 확장(Citus)에서도 FK는 **co-location된 분산 테이블 사이나 reference table을 향할 때로 제한**된다 — "같은 샤드에 같이 사는 관계만 DB가 지켜준다"는 규칙이 샤드 키 설계를 거꾸로 규정한다. `postgres_fdw`로 원격 테이블을 붙여도 FK는 걸리지 않는다.
- **파티셔닝 — 여기서 PostgreSQL은 MySQL과 다르다.** MySQL의 파티션 테이블은 FK를 지원하지 않아 "파티셔닝 도입 = FK 제거"가 강제되지만, **PostgreSQL의 선언적 파티셔닝은 파티션 테이블이 FK의 자식 쪽도 부모 쪽도 될 수 있다.** 다만 부모가 파티션 테이블이면 참조되는 유니크 키가 **파티션 키를 포함**해야 하므로 참조 모델이 파티션 키에 끌려간다 — PostgreSQL에서 질문은 "파티셔닝하니까 FK를 걷어낼까"가 아니라 **"파티션 키를 참조 키에 넣을 수 있는가"**다.
- **서비스 분리(MSA)**: 주문 서비스의 `orders.member_id`가 회원 서비스의 `members.id`를 가리키지만 DB가 다르다 — 참조는 **DB가 아니라 계약(API·이벤트)으로만 지켜지고**, 3-5의 소프트 참조 규약이 유일한 선택지다.

"언젠가 샤딩·분리할 것"이라면 FK에 기대 짠 코드(삭제 순서를 FK에 맡기기, cascade)는 그때 전부 다시 짜야 한다. 그래서 **처음부터 FK 없는 규율로 가는 팀**이 생긴다. 다만 PostgreSQL에서 그 "언젠가"의 첫 단계는 대개 샤딩이 아니라 **파티셔닝·레플리카·PgBouncer**이고 그 단계까지는 FK를 유지할 수 있다.

### 2-6. 이유 ⑥ CASCADE의 예측 불가 폭발

`ON DELETE CASCADE`는 부모 한 행 DELETE가 자식 → 손자 → 증손자로 번진다.

- **범위가 코드에 안 보인다.** `DELETE FROM posts WHERE id = 42` 한 줄이 댓글·첨부·알림·통계 수만 건을 지우는데 리뷰어는 그 한 줄만 본다 — [cascade 문서 §3-1](../03-jpa-orm/24-cascade-remove-vs-orphan-removal.md)의 "JPA cascade는 파급이 보이고, DB cascade는 안 보인다"가 이 지점이다.
- **인덱스가 없으면 부모 한 행마다 자식 풀스캔**(2-2) — 곱셈으로 커진다. 계산까지 해 두면 부모 1,000건 정리에 1.9TB 읽기다.
- **PostgreSQL에서는 지운 만큼 죽은 튜플이 남는다.** DELETE는 공간을 바로 돌려주지 않고 튜플 헤더 `xmax`에 "이 XID 이후로는 없는 것"이라고 표시만 한다 — 캐스케이드로 자식 수십만 건을 지우면 그만큼 죽은 튜플·인덱스 엔트리가 남아 **VACUUM 부담과 bloat**가 되고, 그 삭제는 전부 **WAL로 기록돼 레플리카 지연**을 만든다([MVCC 문서](11-mvcc-postgresql.md), [대량 삭제 문서](25-mass-delete-archiving-and-partitioning.md)). "부모 한 행 삭제"의 진짜 청구서는 **그 뒤 몇 시간의 autovacuum**에 온다.
- **락과 시간이 예측 불가**다. 삭제되는 자식 행마다 락이 튜플 헤더에 기록되고(PostgreSQL은 락 에스컬레이션이 없어 행 수 제한은 없다) 트랜잭션은 그만큼 길어진다 — [장기 트랜잭션의 해악](16-long-transaction-harm-and-shortening.md)이 한 문장에서 시작된다.

> **MySQL 대조 (방향이 반대다)**: MySQL은 캐스케이드된 삭제가 **자식 트리거를 발동시키지 않아** 감사 로그가 비는 사고가 나지만, PostgreSQL의 캐스케이드는 자식에 **실제 `DELETE`를 실행**하므로 자식 트리거가 정상 발동한다 — 로그는 남되 트리거 비용까지 곱해진다.

그래서 FK를 쓰더라도 `CASCADE` 없이 `RESTRICT`(또는 `NO ACTION`)만 쓰는 팀이 많고, "어차피 RESTRICT만 쓸 거면 앱에서 막는 것과 뭐가 다른가"가 또 다른 논거가 된다. 답은 2-9다 — **RESTRICT는 psql에서 들어와도 막지만 앱 코드는 앱을 거치는 경로만 막는다.**

### 2-7. 이유 ⑦ 솔직한 이유 — 관행의 전파

위 여섯이 다 해당되는 팀은 많지 않은데 "운영 DB엔 FK 안 건다"는 규칙은 훨씬 넓게 퍼져 있다. **대규모 서비스 회사의 DBA 컨벤션이 "정답"으로 전파**됐기 때문이다 — 그 회사들은 ①~⑥을 실제로 겪었지만, 컨벤션만 가져온 팀은 겪지 않은 문제를 피하려고 방어선을 버린다.

**PostgreSQL 사용자에게는 한 겹이 더 있다.** 널리 인용되는 FK 반대 논거의 상당수는 **InnoDB(MySQL)의 락 모델과 gh-ost 제약에서 나온 것**이라 PostgreSQL에서는 성립하지 않거나 도구로 깎이고(2-1, 2-4), 반대로 **PostgreSQL에만 있는 진짜 함정(2-2)은 그 글들에 안 적혀 있다.** 그래서 관행만 옮겨 오면 두 번 틀린다 — 없는 문제를 피하려다 있는 문제를 놓친다.

인정하고 말하는 것이 오히려 신뢰를 준다: **"성능 때문에 뺐다"는 대개 사후 정당화이고, PostgreSQL에서 실제 결정 요인은 운영 유연성(③④)과 분산 계획(⑤)이다.**

### 2-8. PostgreSQL이라면 빼기 전에 깎을 수 있는 것 — 다섯 가지 (가산점 포인트)

위 일곱 중 몇 개는 PostgreSQL에서 **제거가 아니라 조정으로** 해결된다. "FK를 뺄까요?"에 곧장 답하지 않고 이 목록을 먼저 꺼내는 것이 이 문항에서 가장 인상적인 답변 경로다.

| 이유 | PostgreSQL에서의 처방 | 남는 대가 |
|---|---|---|
| ② 부모 DELETE 풀스캔 | 자식 FK 컬럼에 `CREATE INDEX CONCURRENTLY` | 인덱스 하나 몫의 쓰기·공간 |
| ① `FOR UPDATE` 충돌 | `FOR NO KEY UPDATE`로 낮추거나 원자적 UPDATE로 명시적 락 제거 | 부모 키를 바꾸는 경로에는 그대로 필요 |
| ④ `ADD FOREIGN KEY` 잠금 | `NOT VALID` → `VALIDATE` (+ `lock_timeout` + 재시도) | 검증 전까지 기존 데이터 보장 없음 |
| ③ 적재 순서 | `DEFERRABLE INITIALLY DEFERRED`, 또는 뗐다 `NOT VALID`로 복구 | 위반이 COMMIT에서 터진다 |
| ③ 대량 적재 | `session_replication_role = replica`로 트리거 우회 | 슈퍼유저 권한 + **소급 검사 없음** |

**깎이지 않는 것은 ⑤(분산 지형)와 ⑥(CASCADE)**뿐이고 ⑥은 `CASCADE`를 안 쓰면 사라진다. 즉 **PostgreSQL에서 FK를 빼야 할 진짜 이유는 "샤딩·서비스 분리가 로드맵에 있다" 하나로 수렴한다** — 3-8 결론의 근거다.

---

여기까지가 저울의 한쪽이다. **이제 반대쪽을 같은 밀도로 본다.** 2장을 여기서 끊고 "그래서 뺀다"로 가면 그것이 이 문항에서 가장 흔한 감점이다 — 비용은 눈에 보이고 잃는 것은 안 보이기 때문에, 의식적으로 반대편에 같은 분량을 써야 균형이 맞는다.

---

### 2-9. 잃는 것 ⑧ 최후 방어선 — 불변식이 DB 제약에서 앱 관례로 내려온다

[정규화 문서 §2-3](04-normalization-vs-denormalization.md)의 문장을 그대로 가져온다 — **"FK나 UNIQUE 제약은 DB가 지키므로 어떤 코드 경로로 들어와도 뚫리지 않는다. 반면 앱의 약속은 약속을 모르는 경로가 하나만 생겨도 뚫린다."** FK를 빼는 것은 참조 무결성을 정확히 그 "앱의 약속" 등급으로 강등시키는 일이다.

용어를 하나 붙여 두면 이해가 쉽다. **불변식(invariant)**이란 "이 시스템에서 언제나 참이어야 하는 명제"다. "모든 댓글에는 존재하는 게시글이 있다"가 불변식이고, FK는 그것을 **DB 엔진이 강제하는 등급**으로 올려놓은 것이다. FK를 빼면 같은 명제가 "우리 팀이 그렇게 하기로 했다" 등급으로 내려온다.

뚫는 경로는 늘 같은 세 종류다.

- **새 코드 경로**: 신입이 만든 관리자 일괄 삭제 API가 자식 처리를 빼먹는다. 컴파일도 테스트도 통과한다 — 검증을 빼먹은 것은 문법 오류가 아니기 때문이다.
- **앱을 거치지 않는 경로**: 장애 대응 중 운영자가 psql에서 친 `DELETE`, 데이터 보정 스크립트, ETL 역적재, `COPY` 적재. 이 경로들은 애초에 애플리케이션 코드를 지나가지 않는다.
- **경로 비대칭**: 생성 경로는 부모를 확인하는데, 나중에 추가된 "계정 병합" 경로는 참조를 옮기는 걸 잊는다. 검증이 한 군데가 아니라 여러 군데 흩어져 있을 때 반드시 생긴다.

FK가 있으면 이 셋이 전부 **에러로 즉시 드러난다**(`23503 foreign_key_violation`). 없으면 전부 **조용히 성공**한다. 이 차이가 최후 방어선의 뜻이다.

> PostgreSQL에서는 "DB가 알아서 에러를 내주겠지"가 다른 곳에서는 실제로 맞는다 — 타입이 안 맞는 비교는 조용한 풀스캔이 아니라 `operator does not exist` 에러로 드러난다([풀스캔 원인 문서](02-index-not-used-full-scan.md)). 그래서 더 조심해야 한다 — **참조 무결성만은 제약을 걸지 않는 한 PostgreSQL도 아무 말을 하지 않는다.**

### 2-10. 잃는 것 ⑨ 고아 행 — 왜 조용히 쌓이고, 왜 증상이 엉뚱한 곳에서 터지는가

1-1에서 정의한 대로 고아 행은 **가리키는 부모가 이미 사라진 자식 행**이다. 이것이 무서운 것은 생길 때가 아니라 **발견될 때**다.

#### 왜 조용한가 — 가장 흔한 조회 경로가 고아를 가려 준다

이유는 단순하다. **애플리케이션의 대표적인 조회가 대부분 부모와 자식을 조인하는데, 그 조인(INNER JOIN)이 고아 행을 자동으로 걸러 버리기 때문**이다.

```text
comments 테이블의 실제 상태
   id=1  post_id=42   "재밌어요"        ← posts.id=42 있음 (정상)
   id=2  post_id=42   "다음 화 언제"    ← posts.id=42 있음 (정상)
   id=3  post_id=99   "잘 봤습니다"     ← posts.id=99 없음 (고아)
   id=4  post_id=99   "구독합니다"      ← posts.id=99 없음 (고아)

화면을 그리는 쿼리
   SELECT c.*, p.title
   FROM comments c JOIN posts p ON p.id = c.post_id      ← INNER JOIN
   결과: id=1, id=2 만 나온다.  id=3, 4 는 "조인에 실패해서" 결과에서 빠진다.

   → 화면에는 아무 이상이 없다. 에러도 없고 빈 칸도 없다.
   → 고아 행은 "보이지 않는 상태로 테이블에 남아 있다."
     이 상태가 몇 달 동안 아무 신호 없이 계속된다.
```

**조용한 것과 문제가 없는 것은 다르다.** 문제는 조인을 안 하는 경로에서 뒤늦게 터진다.

#### 어디서 터지는가 — 네 가지 얼굴

- **집계가 조용히 틀린다.** `SELECT count(*) FROM comments`(1억 건 중 고아 300만 건 포함)와 `SELECT count(*) FROM comments c JOIN posts p ON …`(9,700만 건)이 다른 값을 낸다. 어느 쪽이 맞는지 아무도 모르고, **매출·정산 집계가 이 차이를 만나면 그때는 숫자 문제가 아니라 신뢰 문제**가 된다.
- **배치가 NPE로 죽는다.** 야간 배치가 `comment.getPost().getTitle()`을 부르는 순간 프록시 초기화가 실패한다(JPA라면 `EntityNotFoundException`). 스택 트레이스는 **어젯밤 배치**를 가리키는데, 원인 행은 **석 달 전 삭제 배치**가 만들었다. 원인과 증상 사이가 세 달이라 추적이 사실상 불가능하다.
- **컴플라이언스 사고가 된다.** 개인정보 삭제 요청으로 회원을 지웠는데 그 회원의 주소·연락처가 담긴 자식 행(주문, 배송지)이 남아 있다. **삭제했다고 보고한 데이터가 실제로는 남아 있는 상태**이고, 이건 버그가 아니라 법적 사고다.
- **뒤늦게 지우려 해도 판단 근거가 없다.** 정리하려고 보니 "이게 정말 고아인지, 아니면 부모가 다른 경로로 옮겨져 자식이 새 부모를 가리켜야 하는 건지"를 알 방법이 없다. 삭제된 부모의 정보가 이미 없으므로 **복구가 아니라 폐기밖에 선택지가 없다.**

FK는 이 모든 것을 **생성 시점에 0건으로** 유지한다. 대체 체계(3-4)는 "발견 시점"을 몇 시간 단위로 당기는 것이지 0건을 보장하지 못한다 — **보장 등급이 "생성 시 0건"에서 "발견 지연 N시간"으로 내려온다는 것을 알고 받아들이는 것이 결정**이다.

PostgreSQL에서 한 가지가 더 붙는다. **고아 탐지 쿼리 자체가 비싸다.** 부모 없는 자식을 찾는 것은 안티조인(`NOT EXISTS`)이라 자식이 수억 건이면 `Hash Anti Join`으로 양쪽을 통째로 훑는다([조인 문서](06-join-types-and-execution.md)). 즉 **FK를 빼서 아낀 비용의 일부를 매시간 도는 탐지 배치로 도로 지불**한다.

### 2-11. 잃는 것 ⑩ 스키마의 문서 역할

FK가 있는 스키마는 그 자체로 ERD다. psql에서 `\d comments` 한 번이면 "이 테이블은 누구를 가리키고 누가 나를 가리키는가"가 두 줄로 나온다.

```text
psql=# \d comments
                        Table "public.comments"
   Column   |  Type   | ...
 id         | bigint  | ...
 post_id    | bigint  | not null
 body       | text    | not null
Indexes:
    "comments_pkey" PRIMARY KEY, btree (id)
    "idx_comments_post_id" btree (post_id)
Foreign-key constraints:
    "comments_post_id_fkey" FOREIGN KEY (post_id) REFERENCES posts(id)   ← 내가 가리키는 것
Referenced by:
    TABLE "comment_reports" CONSTRAINT "..." FOREIGN KEY (comment_id) REFERENCES comments(id)
                                                                     ↑ 나를 가리키는 것
```

FK가 없으면 이 두 블록이 통째로 사라지고, `member_id`가 `members.id`인지 `legacy_members.member_no`인지는 **컬럼 이름과 부족의 기억**으로만 남는다 — 테이블이 200개를 넘으면 이 지식은 반드시 유실되고, 3-5의 문서화 규약이 그 자리를 메워야 한다.

### 2-12. 잃는 것 ⑪ 카탈로그 근거의 소멸 — PostgreSQL에서 가장 비싸게 치르는 손실

이 항목이 목록에서 가장 안 와닿는 자리라 따로 풀어 쓴다. 여기서 MySQL과 결론이 갈린다 — MySQL에서 이 칸은 **자동 생성 인덱스**인데 **PostgreSQL은 애초에 만들어 주지 않으므로 잃을 것이 없다**(2-2). 대신 PostgreSQL이 잃는 것은 한 단계 위다.

#### "카탈로그 근거"란 무엇인가

PostgreSQL은 자기 스키마 정보를 시스템 카탈로그라는 **일반 테이블**에 저장한다. FK를 하나 걸면 `pg_constraint`에 이런 행 하나가 생긴다.

```sql
SELECT conname, conrelid::regclass AS child, confrelid::regclass AS parent, conkey, confkey
FROM pg_constraint WHERE contype = 'f';
--       conname         |  child   | parent | conkey | confkey
-- ----------------------+----------+--------+--------+---------
--  comments_post_id_fkey| comments | posts  | {2}    | {1}
--   ↑ "comments 의 2번 컬럼이 posts 의 1번 컬럼을 참조한다"는 사실이
--     사람의 머리가 아니라 SQL로 조회 가능한 데이터로 존재한다.
```

**이 한 행이 곧 "기계가 읽을 수 있는 관계 선언"이다.** FK를 빼면 이 행이 없어지고, 관계는 **사람의 머리와 위키 문서에만** 남는다.

#### 이 한 행을 읽고 자동으로 일하는 도구들

FK를 뺀다는 것은 아래 도구들이 전부 **관계를 모르는 상태**가 된다는 뜻이다. 구체적인 이름으로 세어 보면 손실의 크기가 보인다.

| 분류 | 도구 | FK가 있으면 자동으로 되는 일 | FK가 없으면 |
|---|---|---|---|
| **ORM 역공학** | Hibernate 리버스 엔지니어링, JPA Buddy, IntelliJ의 "Generate Persistence Mapping", jOOQ 코드 생성, Prisma `db pull`, Django `inspectdb`, SQLAlchemy `automap` | DB에서 엔티티 클래스를 뽑을 때 `@ManyToOne`·`@OneToMany` 매핑과 조인 경로를 **자동 생성** | `Long postId` 필드 하나로만 나온다. 관계는 사람이 손으로 다시 쓴다 |
| **ERD 생성** | DBeaver ER Diagram, pgAdmin ERD Tool, SchemaSpy, dbdocs/dbdiagram | 테이블 사이에 **선을 그어 준다** | 테이블 상자만 흩어져 있고 선이 하나도 없는 그림이 나온다 |
| **데이터 계보(lineage)·카탈로그** | DataHub, OpenMetadata, Amundsen | "이 테이블은 저 테이블에 종속" 관계를 **수집해 계보 그래프에 반영** | 관계가 비어 있어 영향도 분석("이 테이블 지우면 뭐가 깨지나")이 안 된다 |
| **마이그레이션·스키마 관리** | Liquibase `generateChangeLog`, Atlas `schema inspect`, `pg_dump`/`pg_restore` | 제약을 포함해 스키마를 재현하고, **적재 순서(부모 먼저)를 스스로 결정** | 순서를 사람이 지정해야 하고, 덤프를 복원하면 관계가 사라진 스키마가 된다 |
| **테스트 데이터 생성** | 팩토리·픽스처 라이브러리, Testcontainers 시드 | 자식을 만들 때 **부모를 먼저 만들어야 함을 스스로 안다** | 시드 순서를 사람이 관리한다 |
| **우리 팀의 자동화** | 3-3의 인덱스 린트, 3-4의 고아 탐지 커버리지 목록 | `pg_constraint` 한 번 조회로 **검사 대상 목록이 정확히 나온다** | `%_id`라는 이름 규약으로 근사할 수밖에 없다 |

마지막 줄이 실무에서 제일 아프다. FK가 있으면 인덱스 누락 점검을 `pg_constraint` 하나로 **기계가 정확히** 할 수 있다. FK가 없으면 `SELECT … FROM pg_constraint WHERE contype = 'f'`가 0행을 돌려주고, 근거는 `%_id`라는 **이름 규약**뿐이라 **규약을 안 지킨 컬럼(`writer`, `owner_no`)은 검사에서 새고, 규약을 지켰지만 참조가 아닌 컬럼(`external_id`, `trace_id`)은 거짓 양성**이 된다. 같은 일이 고아 탐지 배치의 커버리지 목록에서도 반복된다 — FK가 있으면 "검사할 관계 목록"이 카탈로그에 이미 있지만, 없으면 사람이 위키에 적어 관리하는 목록이 되고 새 컬럼이 생길 때마다 조용히 빠진다.

그리고 그 근거가 없어 인덱스를 빠뜨리면, 가장 흔한 조회부터 무너진다.

```sql
-- orders.member_id 는 논리적 FK 인데 인덱스가 없다
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE member_id = $1;
--  Seq Scan on orders  (actual rows=12 loops=1)
--    Filter: (member_id = $1)
--    Rows Removed by Filter: 49999988      ← 12행을 위해 5천만 행을 읽었다
--    Buffers: shared read=368000
-- 계산: orders 한 행 = 튜플 헤더 24B + id 8 + member_id 8 + amount(numeric) 8 + created_at 8 = 56B
--       페이지당 = (8192-24) ÷ (56+4) ≈ 136 행 → 5천만 ÷ 136 ≈ 368,000 페이지 = 2.8GB
--       회원 한 명의 주문 12건을 찾으려고 매번 2.8GB를 읽는다.
```

**요약하면 — MySQL에서 FK 제거의 대표 함정이 "인덱스가 같이 사라지는 것"이라면, PostgreSQL에서는 "인덱스가 필요하다는 사실을 아무도 기계적으로 알 수 없게 되는 것"이다.** 처방은 같지만(3-3), PostgreSQL에서는 그 린트가 **FK를 걸든 안 걸든 필수**라는 점이 다르다.

---

**양면을 한 저울에 올려 두고 2장을 닫는다.** 아래 표를 왼쪽에서 오른쪽으로 읽으면 "무엇을 얻으려고 무엇을 내주는가"가 한 줄씩 대응한다.

| FK를 빼서 얻는 것 (2-1 ~ 2-8) | 그 대가로 내주는 것 (2-9 ~ 2-12) |
|---|---|
| 부모를 `FOR UPDATE`로 잡는 코드가 자식 INSERT를 막지 않는다 (①) | 자식 INSERT 시점의 부모 존재 보장이 사라진다 — 레이스 조건이 생긴다 (⑧) |
| 부모 DELETE가 자식 스캔을 돌지 않는다 (②) | 부모를 지워도 아무도 막지 않는다 → 고아가 조용히 생긴다 (⑨) |
| 적재·아카이빙에 순서 제약이 없다 (③) | 순서를 안 지켜도 에러가 안 나므로, 안 지킨 것을 알 방법이 없다 (⑧⑨) |
| 대형 테이블에 DDL 창을 안 내도 된다 (④) | 나중에 다시 걸려면 데이터 정비가 선행돼야 한다 (4장 여섯 번째 꼬리질문) |
| 샤딩·서비스 분리가 가능해진다 (⑤) | 분리 이후의 정합성은 전부 앱과 배치의 몫이 된다 (⑧⑨) |
| CASCADE의 예측 불가 폭발이 없다 (⑥) | 삭제 파급을 코드가 전부 책임진다 — 빠뜨리면 고아 (⑨) |
| — | `\d` 한 줄로 보이던 관계가 사라진다 (⑩) |
| — | 인덱스 린트·고아 탐지·ERD·ORM 역공학의 **기계적 근거**가 사라진다 (⑪) |

오른쪽 두 줄에 대응하는 왼쪽 칸이 비어 있다는 것이 이 표의 요점이다 — **⑩과 ⑪은 무엇을 얻으려고 내주는 것이 아니라, 다른 것을 얻으면서 딸려 나가는 손실**이다. 그래서 대체 체계가 필요하다.

---

## 3. 안전망 · 결론 — 포기한 방어선을 무엇으로 메우고, 어떤 조건에서 무엇을 고르는가

FK를 빼기로 했다면 아래 일곱은 **선택이 아니라 세트**다 — 하나라도 빠지면 2-9 ~ 2-12의 손실을 그대로 떠안는다.

> **대체 체계 7가지**
> ① 앱 레벨 존재 검증 — 그리고 레이스 조건의 보정(`FOR KEY SHARE`)
> ② 삭제는 소프트 삭제/아카이브로 — 부모가 안 사라지면 고아가 안 생긴다
> ③ FK 컬럼 인덱스 강제 — 마이그레이션 린트로
> ④ 고아 행 탐지 배치 + 알람 — 발견 지연을 시간 단위로
> ⑤ 소프트 참조 규약 + 스키마 문서화 — 이름·`COMMENT ON`·ERD 도구
> ⑥ 테스트/스테이징에서만 FK 켜기 — 버그를 운영 전에 드러내는 선택지
> ⑦ JPA에서 매핑과 물리 제약을 분리 — `NO_CONSTRAINT`와 `ddl-auto`

### 3-1. ① 앱 레벨 존재 검증 — 도메인 서비스가 경비원이 된다

```java
// before — FK 도 없고 검증도 없다. 존재하지 않는 postId 가 그대로 저장된다
@Transactional
public Long addComment(Long postId, String body) {
    Comment comment = new Comment(postId, body);
    return commentRepository.save(comment).getId();   // 고아 행 생성 경로
}
```

```java
// after — 부모 존재(그리고 삭제되지 않음)를 같은 트랜잭션에서 확인한다
@Transactional
public Long addComment(Long postId, String body) {
    Post post = postRepository.findActiveById(postId)        // deleted_at IS NULL 조건 포함
        .orElseThrow(() -> new PostNotFoundException(postId));
    Comment comment = new Comment(post.getId(), body);
    return commentRepository.save(comment).getId();
}
```

검증은 **도메인 서비스 한 곳**에 둔다. 컨트롤러·배치·관리자 API가 각자 검증하면 2-9의 "경로 비대칭"이 그대로 재현된다.

**레이스 조건을 정직하게 말한다.** 위 코드에도 구멍이 있다 — `findActiveById`와 `save` 사이에 다른 트랜잭션이 부모를 **물리 삭제**하면 고아가 생긴다. 2-1 ⑴에서 본 대로 **FK의 `FOR KEY SHARE`가 하던 일이 정확히 이 틈을 막는 것**이었다. 보정 선택지는 셋이고 각각 대가가 있다.

- **부모를 물리 삭제하지 않는다(3-2)** → 틈 자체가 사라진다. 대부분의 팀이 실제로 택하는 답이다.
- **부모를 `FOR KEY SHARE`로 읽는다** → FK가 잡던 락을 **정확히 같은 등급으로** 손으로 잡는 것이다. PostgreSQL에서는 이 선택지가 MySQL보다 훨씬 매력적이다 — 2-1의 충돌 행렬대로 `FOR KEY SHARE`는 부모의 `comment_count` UPDATE(`FOR NO KEY UPDATE`)를 **막지 않아** 경합이 거의 없다. 주의: **JPA `@Lock`에는 이 등급이 없다** — `PESSIMISTIC_READ`는 한 등급 센 `FOR SHARE`로 나가 부모의 일반 UPDATE까지 막는다.

```java
// FK 가 하던 것과 정확히 같은 락 — JPA @Lock 으로는 표현되지 않는다
@Query(value = "SELECT id FROM posts WHERE id = :id AND deleted_at IS NULL FOR KEY SHARE",
       nativeQuery = true)
Optional<Long> lockParentForKeyShare(@Param("id") Long id);
// @Lock(PESSIMISTIC_READ)  → FOR SHARE   (부모의 비-키 UPDATE 까지 막는다 — 과하다)
// @Lock(PESSIMISTIC_WRITE) → FOR UPDATE  (2-1 의 사슬을 손으로 만드는 셈 — 쓰지 않는다)
```

- **틈을 인정하고 3-4의 배치가 잡게 한다** → 가장 흔한 현실적 답. "0건 보장"이 아니라 "N시간 내 발견"이라는 등급으로 내려온 것을 인지하고 말한다.

삭제 쪽도 같다.

```java
// before — "자식 있나" 확인 후 삭제. 확인과 삭제 사이에 자식이 들어오면 고아가 된다
@Transactional
public void deletePost(Long postId) {
    if (commentRepository.existsByPostId(postId)) {
        throw new PostHasCommentsException(postId);
    }
    postRepository.deleteById(postId);   // 물리 삭제. 이 사이에 addComment 가 끼면 고아
}
```

```java
// after — 물리 삭제 대신 soft delete. 자식이 가리키는 행이 사라지지 않는다
@Transactional
public void deletePost(Long postId) {
    Post post = postRepository.findActiveById(postId)
        .orElseThrow(() -> new PostNotFoundException(postId));
    post.markDeleted(clock.now());       // UPDATE posts SET deleted_at = $1 WHERE id = $2
    // 자식 정책은 명시적으로: 댓글도 함께 soft delete 할지, 남길지 — 도메인 규칙으로
    commentRepository.softDeleteAllByPostId(postId);
}
```

> PostgreSQL 각주: `deleted_at`을 인덱스(부분·복합)에 넣었다면 그 컬럼을 바꾸는 UPDATE는 HOT(인덱스를 안 건드리는 업데이트)에서 탈락해 **그 테이블의 모든 인덱스에 새 엔트리**를 꽂는다. 소프트 삭제를 대체 체계의 축으로 삼는다면 이 쓰기 증폭도 계산에 넣는다.

### 3-2. ② 삭제는 소프트 삭제/아카이브로 — 고아가 생기는 조건을 없앤다

고아 행은 "부모가 사라질 때" 생긴다. 부모가 사라지지 않으면 — `deleted_at`만 찍히면 — **참조 무결성은 FK 없이도 물리적으로 깨질 수 없다.** FK를 빼는 팀이 거의 예외 없이 soft delete를 함께 택하는 이유다.

대신 두 가지를 짊어진다. 첫째, [soft delete 문서 §3-8](../03-jpa-orm/26-soft-delete-unique-and-associations.md)에서 본 대로 **"삭제된 부모를 가리키는 살아 있는 자식"이라는 논리적 고아**가 새로 생기고, 이건 FK가 있어도 못 막는다 — 도메인 규칙으로 정해야 한다. 둘째, 언젠가 **아카이브로 이동**해야 하는데 그 이동이 2-3의 순서 제약을 다시 만난다 — 다만 FK가 없으니 자식·부모를 독립적으로 옮길 수 있고, "옮긴 뒤 고아가 없는지"는 3-4의 배치가 검증한다. (PostgreSQL이라면 이동은 `WITH moved AS (DELETE … RETURNING *) INSERT …`로 원자화할 수 있고, 아카이브 대상이 통째로 파티션이면 `DETACH`/`DROP`이 더 싸다 — [대량 삭제 문서](25-mass-delete-archiving-and-partitioning.md).)

### 3-3. ③ FK 컬럼 인덱스 강제 — 사람 기억이 아니라 린트로

**PostgreSQL에서 이 항목은 "FK를 뺐을 때의 대체 체계"가 아니라 상시 필수다**(2-2) — FK가 있어도 인덱스는 안 생기기 때문이다. 그래서 린트를 두 벌 둔다: 물리 FK는 카탈로그로 정확히, 논리적 FK는 이름 규약으로 근사하게. 두 벌이 필요한 이유가 정확히 2-12에서 말한 "카탈로그 근거의 소멸"이다.

```sql
-- ⑴ 물리 FK 가 있는 관계: pg_constraint 가 정답을 알고 있다
--    자식 FK 컬럼이 어떤 인덱스의 "선두 컬럼들"도 아닌 제약을 뽑는다
SELECT c.conrelid::regclass  AS child_table,
       c.confrelid::regclass AS parent_table,
       c.conname             AS constraint_name
FROM pg_constraint c
WHERE c.contype = 'f'
  AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND i.indisvalid                                    -- INVALID 인덱스는 인정하지 않는다
          AND (i.indkey::smallint[])[0:cardinality(c.conkey) - 1] @> c.conkey
      );
-- (단순화 버전 — 부분 인덱스의 WHERE 절, 연산자 클래스, 복합 FK 의 컬럼 순서는 따로 확인)
```

```sql
-- ⑵ 논리적 FK(제약 없음): 카탈로그 근거가 없으니 이름 규약으로 훑는다 — 2-12 의 대가
SELECT a.attrelid::regclass AS tbl, a.attname
FROM pg_attribute a
JOIN pg_class t ON t.oid = a.attrelid AND t.relkind = 'r'
                AND t.relnamespace = 'public'::regnamespace
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND a.attname LIKE '%\_id' AND a.attname <> 'id'
  AND NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = a.attrelid AND i.indisvalid
                    AND i.indkey[0] = a.attnum);   -- 선두 컬럼일 때만 인정
```

```java
@Test   // 새 테이블·새 컬럼이 들어와도 사람이 기억할 필요가 없다
void everyFkColumnIsIndexed() {
    List<String> missing = jdbcTemplate.queryForList(MISSING_FK_INDEX_SQL, String.class);
    assertThat(missing)
        .as("FK(물리/논리) 컬럼에 인덱스가 없다 — 마이그레이션에 CREATE INDEX 를 추가하라")
        .isEmpty();
}
```

마이그레이션이 적용된 테스트 DB(Testcontainers의 PostgreSQL)에서 두 쿼리가 한 행이라도 돌려주면 빌드를 깨뜨린다. 예외는 허용 목록으로 관리하고 **"넣으려면 PR에 이유를 적는다"**가 곧 리뷰 게이트가 된다.

덧붙일 둘 — ⓐ 운영에서는 반드시 `CREATE INDEX CONCURRENTLY`(트랜잭션 블록 안에서는 불가, 실패하면 `INVALID` 인덱스가 남으므로 `pg_index.indisvalid` 확인 후 DROP·재시도) ⓑ **FK 컬럼과 그 인덱스에는 부모 PK 값이 그대로 들어가므로** PK를 UUID로 잡으면 비용이 여기서 청구된다([클러스터드 vs 세컨더리 문서](03-clustered-vs-secondary-index.md)).

### 3-4. ④ 고아 행 탐지 배치 + 알람 — 발견 지연을 시간 단위로 묶는다

FK가 "생성 시점 0건"을 보장했다면, 배치는 **"N시간 안에 발견하고 사람을 부른다"**를 보장한다 — 어긋남을 전제로 한 안전망이다. 2-10에서 본 "석 달 뒤에 엉뚱한 곳에서 터진다"를 "몇 시간 뒤에 알람으로 온다"로 바꾸는 것이 목표다.

```sql
-- 고아 탐지의 기본형: 부모가 없는 자식 (PG 에서는 NOT EXISTS 가 Anti Join 으로 계획된다)
SELECT c.id, c.post_id, c.created_at
FROM comments c
WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id)
  AND c.created_at < now() - interval '10 minutes'  -- ① 유예 창: 진행 중 트랜잭션·복제 지연 제외
  AND c.id BETWEEN $1 AND $2                        -- ② PK 범위로 청크 — 대형 테이블 전면 스캔 금지
LIMIT 1000;

-- soft delete 를 쓰는 팀은 "논리적 고아"도 함께 본다
SELECT c.id, c.post_id
FROM comments c
JOIN posts p ON p.id = c.post_id
WHERE p.deleted_at IS NOT NULL
  AND c.deleted_at IS NULL                          -- 부모는 삭제됐는데 자식은 살아 있다
  AND c.id BETWEEN $1 AND $2;
```

유예 창(①)이 왜 필요한지 한 줄로 — **아직 커밋되지 않은 트랜잭션의 자식은 잠깐 고아처럼 보인다.** 부모를 넣은 트랜잭션이 커밋되기 전이거나, 레플리카에서 검사하는데 복제가 조금 밀려 있으면 정상 데이터가 오탐된다.

운영 규칙까지 세트다.

- **주기**: 핵심 관계(주문–회원, 결제–주문)는 시간 단위, 나머지는 일 단위. 배치 자체가 부하가 되면 안 되므로 레플리카에서, 청크로, 야간에. 다만 **레플리카에서 오래 도는 쿼리는 PostgreSQL에서 공짜가 아니다** — `max_standby_streaming_delay`를 넘기면 쿼리가 취소되고(`canceling statement due to conflict with recovery`), `hot_standby_feedback = on`으로 막으면 그 대가가 프라이머리의 VACUUM 지연(=bloat)으로 넘어간다. 청크를 짧게 끊고 `SET LOCAL statement_timeout`을 걸어 두는 이유가 여기에 있다.
- **결과 처리**: 0건이 아니면 **알람**(Slack·페이저) → 자동 삭제가 아니라 **격리 테이블로 이동 + 원인 경로 추적**. 자동 삭제는 "부모가 다른 경로로 옮겨진 정상 데이터"를 지울 수 있다.
- **지표화**: 고아 건수를 시계열 지표로 남기면 "어느 배포 이후 늘었다"가 보인다 — 2-9의 "새 코드 경로"를 잡는 유일한 방법이다.
- **커버리지 목록**: 검사하는 관계를 목록으로 관리하고, 새 `*_id` 컬럼이 생기면 3-3의 린트가 "탐지 목록에도 추가했나"를 함께 묻게 한다. FK가 없으면 이 목록을 카탈로그에서 자동 생성할 수 없다는 것(2-12)이 이 항목의 상시 리스크다.

```java
@Scheduled(cron = "0 15 * * * *")                  // 매시 15분
public void detectOrphanComments() {
    long count = orphanScanner.scanInChunks("comments", "post_id", "posts", "id");
    orphanGauge.set("comments.post_id", count);    // 시계열 지표
    if (count > 0) alert.page("orphan rows: comments.post_id -> posts.id = " + count);
}
```

### 3-5. ⑤ 소프트 참조 규약 + 스키마 문서화 — 잃어버린 "문서로서의 스키마"를 되찾기

**소프트 참조(soft reference) 규약**: 물리 FK 대신 팀이 지키는 이름·타입 규칙이다. 2-11과 2-12에서 잃은 것을 사람의 규율로 부분적으로 되찾는 시도다.

- 참조 컬럼은 `<부모단수>_id`, 타입은 부모 PK와 동일(`bigint` ↔ `bigint`). 다르면 컬럼 쪽에 캐스트가 붙어 인덱스를 못 타거나 아예 `operator does not exist` 에러가 난다([풀스캔 원인 문서](02-index-not-used-full-scan.md)).
- `COMMENT ON COLUMN`으로 대상을 명시한다 — 도구가 읽고 사람이 읽는다. `pg_description` 카탈로그에 저장되므로, **잃어버린 "기계가 읽을 수 있는 근거"를 아주 약한 형태로나마 복원하는 수단**이다(다만 자유 텍스트라 도구가 관계로 해석해 주지는 않는다).
- 서비스 경계를 넘는 참조는 코드에서도 `@ManyToOne Member`가 아니라 **`Long memberId`**로 둔다 — "DB가 지켜주지 않는 참조"임이 타입에 드러난다.

```sql
CREATE TABLE orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    member_id  bigint NOT NULL,                  -- 논리적 FK
    amount     numeric(19, 2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_member_id ON orders (member_id);   -- 3-3: 손으로 만든다

COMMENT ON COLUMN orders.member_id IS 'FK(logical) -> members.id — 회원 서비스 소유';
COMMENT ON TABLE  orders           IS '주문. 물리 FK 미사용 — 고아 탐지 배치 orphan-check.orders 참조';
```

**ERD 도구**: 물리 FK가 없어도 이름 규약으로 관계를 추론해 그려주는 도구(SchemaSpy의 implied relationship, dbdocs 류)를 CI에 붙여 문서를 자동 생성한다. 손으로 그린 ERD는 반드시 낡는다.

### 3-6. ⑥ 테스트·스테이징에서만 FK 켜기 — 선택지와 그 대가 (가산점 포인트)

운영에는 FK가 없지만 **테스트 DB에는 FK를 건다.** 3-1의 검증을 빠뜨린 새 코드 경로가 통합 테스트에서 FK 위반 예외로 **즉시 드러난다.** 2-9의 "새 코드 경로"를 운영 이전에 잡는 유일한 자동 수단이다.

```sql
-- src/test/resources/db/testonly/R__fk_constraints.sql  (테스트 프로파일에서만 적용)
ALTER TABLE comments ADD CONSTRAINT fk_comments_post
    FOREIGN KEY (post_id) REFERENCES posts (id);
ALTER TABLE orders   ADD CONSTRAINT fk_orders_member
    FOREIGN KEY (member_id) REFERENCES members (id);
```

(`application-test.yml`에서 `spring.flyway.locations`에 `classpath:db/testonly`를 덧붙여 테스트 프로파일에서만 적용되게 한다.)

대가도 같이 말한다. ⑴ **테스트와 운영의 락 동작이 달라진다** — 테스트에서만 부모에 `FOR KEY SHARE`가 잡히므로 2-1의 대기·데드락이 한쪽에서만 난다. ⑵ 픽스처 정리(`TRUNCATE`) 순서가 FK에 묶인다(PostgreSQL은 `TRUNCATE … CASCADE`나 여러 테이블 나열로 푼다). ⑶ 스테이징에 FK를 두면 운영 데이터를 복제해 넣을 때 기존 고아 때문에 적재가 실패한다 — 그 실패가 오히려 고아를 발견하는 계기가 되기도 한다.

### 3-7. ⑦ JPA — 객체 매핑과 물리 제약은 별개다

JPA의 `@ManyToOne`은 **객체 참조를 어떻게 로딩할지**에 대한 선언이고, DB의 FK 제약과는 독립이다. 그런데 Hibernate가 DDL을 생성하면(`ddl-auto`) `@JoinColumn`마다 **FK 제약을 기본으로 만든다.** 여기서 두 가지 사고가 난다.

```java
// before — 팀 규칙은 "운영 DB 에 FK 없음"인데, 매핑은 FK 를 만든다
@Entity
public class Comment {
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "post_id")            // ddl-auto=create/update 면 FK 제약이 생성된다
    private Post post;
}
// 사고 ①: 로컬·테스트는 ddl-auto 로 FK 있는 스키마, 운영은 Flyway 로 FK 없는 스키마
//         → "테스트에선 예외, 운영에선 조용히 고아"가 반대로도 일어난다
// 사고 ②: 어느 날 누가 운영에 ddl-auto=update 를 켰다 → 수억 건 테이블에
//         ADD FOREIGN KEY = SHARE ROW EXCLUSIVE + 전체 검증 스캔 → 두 테이블의 쓰기 차단,
//         게다가 그 락 요청이 대기열에 서면서 뒤따라오는 쓰기까지 줄 세운다 (2-4)
```

```java
// after — 매핑은 유지하되 "물리 FK 를 만들지 마라"를 명시한다
@Entity
public class Comment {
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(
        name = "post_id",
        foreignKey = @ForeignKey(ConstraintMode.NO_CONSTRAINT)   // DDL 생성 시 FK 제약 생략
    )
    private Post post;
}

// 서비스 경계를 넘거나 애초에 객체 그래프가 필요 없는 참조는 ID 만 든다 (3-5 소프트 참조)
@Entity
public class Order {
    @Column(name = "member_id", nullable = false)
    private Long memberId;                   // 타입 자체가 "DB 가 지켜주지 않는 참조"라고 말한다
}
```

운영에서는 스키마를 마이그레이션 도구가 소유한다 — `ddl-auto: none`. (`validate`도 가능하지만 테이블·컬럼·타입만 보고 **FK 유무는 검사하지 않으므로** "FK 없는 운영 스키마"를 잡아주지 않는다.)

`NO_CONSTRAINT`로 물리 FK가 없어도 `@ManyToOne` 지연 로딩·조인은 그대로 동작한다. 단, **부모가 없는 자식을 로딩하면 프록시 초기화 시점에 `EntityNotFoundException`**이 난다 — 고아 행이 있는 운영 DB에서 JPA가 먼저 비명을 지르는 지점이고(2-10의 "배치가 NPE로 죽는다"가 이 얼굴이다), 3-4 배치가 있으면 그 전에 잡힌다.

### 3-8. 판단 기준 6축 — 결론보다 축이 먼저다

"FK 건다/안 건다"는 팀의 신념이 아니라 아래 여섯 축의 답으로 정해진다. **결론을 먼저 말하면 그 결론이 어떤 조건에서 뒤집히는지를 말할 수 없으므로, 축을 먼저 세운다.** PostgreSQL 기준으로 축의 내용이 달라진다는 것까지 말하면 좋다.

| 축 | 질문 (PostgreSQL 기준) | FK 유지 쪽 | FK 제거 쪽 |
|---|---|---|---|
| ① 핫 부모 + 명시적 락 | 부모를 `FOR UPDATE`로 잡는 경로가 있는가 | 없다 (또는 `FOR NO KEY UPDATE`로 낮출 수 있다) | 있고 못 바꾼다 → 2-1 사슬 |
| ② 스키마 변경 규모 | 수억 건 테이블에 `SHARE ROW EXCLUSIVE` 창을 못 내는가 | `NOT VALID` + `VALIDATE`로 충분 | 그마저 어려운 규모·트래픽 |
| ③ 분산 계획 | 샤딩·서비스 분리가 로드맵에 있는가 (파티셔닝은 해당 없음) | 없다 | 있다 → 어차피 불가 |
| ④ 삭제 정책 | 부모를 물리 삭제하는가 | 그렇다 → FK가 막아줘야 | soft delete → 고아 조건 자체가 없음 |
| ⑤ 데이터 민감도 | 돈·법적 근거·개인정보인가 | 그렇다 → 방어선 필요 | 로그·집계·파생 데이터 |
| ⑥ 팀 규율·도구 | 3장 체계를 운영할 배치 인프라·CI 린트·리뷰 문화가 있는가 | 없다 → 빼면 방치 | 있다 |

**⑥이 결정적이다.** ①~⑤가 전부 "제거"를 가리켜도 ⑥이 없으면 빼지 않는다 — 대체 체계 없이 FK만 빼는 것은 트레이드오프가 아니라 손실만 받아들인 것이기 때문이다.

그리고 **PostgreSQL에서는 ①과 ②가 약한 근거**라는 점을 덧붙인다(2-8): ①은 락 등급을 낮추면 대개 사라지고 ②는 `NOT VALID`/`VALIDATE`로 깎인다. 반대로 **어느 쪽을 고르든 3-3(FK 컬럼 인덱스)은 무조건 한다.**

### 3-9. 축의 조합이 결론으로 떨어지는 표 — 그리고 세 갈래

여섯 축의 값 조합이 어떻게 결론으로 떨어지는지를 표로 고정한다. 위에서부터 읽으며 **처음 맞는 줄에서 멈추면** 그것이 권고다.

| ⑥ 규율·도구 | ③ 분산 계획 | ⑤ 민감도 | ④ 삭제 정책 | ①② 락·DDL | 권고 |
|---|---|---|---|---|---|
| **없음** | 무관 | 무관 | 무관 | 무관 | **건다.** 대체 체계를 못 굴리면 빼는 것은 손실만 취하는 선택이다 |
| 있음 | 없음 | **높음**(돈·법적·개인정보) | 무관 | 무관 | **건다.** `CASCADE` 대신 `RESTRICT`, 자식 FK 컬럼 인덱스 필수 |
| 있음 | 없음 | 낮음(로그·파생) | soft delete | ① 핫 부모 있고 못 바꿈 | **이 관계만 뺀다** + 3장 세트 |
| 있음 | 없음 | 낮음(로그·파생) | soft delete | ① 없음 | **걸어도 된다.** 비용이 거의 0이므로 굳이 뺄 이유가 없다 |
| 있음 | 없음 | **혼재** | 혼재 | 혼재 | **선택적으로.** 원장성 관계는 걸고 로그성 관계는 뺀다 — 가장 흔한 답 |
| 있음 | **있다/확정** | 높음 | 무관 | 무관 | **뺀다**(불가피). 고아 탐지가 아니라 **금액 대사 배치**를 얹는다 |
| 있음 | **있다/확정** | 낮음 | 무관 | 무관 | **뺀다** + 3장 세트 |

표를 세 갈래로 요약하면 이렇다.

**내 견해: 기본값은 FK를 건다. PostgreSQL에서는 반대 논거의 절반이 엔진 차이나 내장 도구로 깎이므로 이 기본값이 더 강해진다. 빼는 것은 위 조건이 확인된 예외이며, 빼는 순간 3장의 일곱 가지가 세트로 따라온다.**

- **걸어라** — 단일 DB, 중간 이하 쓰기 부하, 작은 팀, 물리 삭제가 있는 도메인. 여기서 FK의 비용(부모 유니크 인덱스 탐색 한 번 + 가장 약한 등급의 행 락)은 3장 체계의 운영 비용보다 훨씬 싸다. 단 두 가지를 함께 한다 — **`CASCADE` 대신 `RESTRICT`/`NO ACTION`으로 파급을 코드에 드러내고, 자식 FK 컬럼 인덱스를 반드시 만든다.**
- **선택적으로 걸어라** — 대부분의 중규모 서비스가 여기다. 원장성 관계(결제 → 주문, 정산 → 결제)에는 FK를 유지하고, 고빈도·로그성 자식(알림, 이력, 이벤트 로그)과 부모를 `FOR UPDATE`로 잡는 관계에는 빼고 3장 체계를 붙인다. 서비스 경계를 넘는 참조는 무조건 소프트 참조다. **"테이블마다 판단한다"가 가장 성숙한 답이다.**
- **빼라** — 샤딩·서비스 분리가 이미 있거나 확정, 적재 파이프라인이 병렬로 붓는 구조, 3장을 이미 운영하는 팀. 이 팀은 FK를 빼는 것이 아니라 **FK가 하던 일을 다른 자리(앱·배치·CI)에서 하고 있는 것**이다.

### 3-10. 면접에서 말하는 순서

> "이유는 일곱 가지로 정리되는데 PostgreSQL 기준으로는 순서가 달라집니다. 1순위는 **락이 아니라 인덱스**입니다 — PostgreSQL은 자식 FK 컬럼 인덱스를 자동으로 만들어 주지 않아 부모를 지울 때마다 자식이 Seq Scan이 되고, `EXPLAIN ANALYZE`의 `Trigger` 줄에 시간이 다 찍히는 걸로 확인합니다. 자식이 1천만 건이면 1.9GB를 매번 읽는 셈이고, `ON DELETE CASCADE`면 부모 행 수만큼 곱해집니다.
>
> 둘째는 운영 — `ADD FOREIGN KEY`가 두 테이블에 `SHARE ROW EXCLUSIVE`를 잡고 전체를 검증하며, 적재·아카이빙에 순서가 강제됩니다. 셋째는 지형 — 샤딩·서비스 분리에서는 FK가 정의 자체가 안 됩니다. 솔직히 대규모 회사의 관행이 전파된 몫도 큽니다.
>
> 그런데 흔히 인용되는 **락 논거는 PostgreSQL에 그대로 옮기면 틀립니다.** MySQL은 자식 INSERT의 공유 락과 부모 카운터 UPDATE의 배타 락이 교차해 데드락이 나는데, PostgreSQL에서 자식 INSERT가 잡는 건 `FOR KEY SHARE`이고 키가 아닌 컬럼만 바꾸는 UPDATE는 `FOR NO KEY UPDATE`라 **둘이 호환**됩니다. 그 데드락이 살아나는 건 코드가 부모를 `FOR UPDATE`(JPA `PESSIMISTIC_WRITE`)로 잡을 때뿐이고, 그건 락 등급을 낮춰 해결하는 게 먼저입니다.
>
> 대신 잃는 것도 분명합니다. 최후 방어선, 고아 0건 보장, `\d` 한 줄로 관계가 보이는 문서성, 그리고 PostgreSQL에서 특히 아픈 것 — **'이 컬럼은 참조 컬럼'이라는 카탈로그 근거**가 사라져 인덱스 린트와 고아 탐지 목록, ORM 역공학과 ERD 자동 생성이 전부 이름 규약에 얹히게 되는 겁니다. 고아 행은 INNER JOIN이 가려 주기 때문에 조용히 쌓이고, 집계·배치·컴플라이언스에서 몇 달 뒤에 터집니다.
>
> 제 견해는 기본값은 건다, 이고 PostgreSQL에서는 더 강합니다. 인덱스는 `CREATE INDEX CONCURRENTLY`, DDL 잠금은 `NOT VALID` 뒤 `VALIDATE CONSTRAINT`, 적재 순서는 `DEFERRABLE INITIALLY DEFERRED`나 `session_replication_role`로 깎이니 정말 남는 이유는 분산 계획 하나입니다. 빼기로 했다면 앱 레벨 존재 검증, 소프트 삭제, FK 컬럼 인덱스 CI 린트, 고아 탐지 배치와 알람, 소프트 참조 규약과 문서화, 테스트 환경 FK, JPA `NO_CONSTRAINT`까지 세트로 갑니다. 현실적으론 테이블마다 판단해서 원장성 관계엔 걸고 고빈도·로그성 관계와 서비스 경계를 넘는 참조엔 빼는 구성이 가장 많습니다."

---

## 4. 꼬리질문 대비 포인트

### "FK가 락을 잡는다고 했는데, PostgreSQL에서는 정확히 어떤 락이 어디에 걸리나요?"

자식 `INSERT`(또는 FK 컬럼 UPDATE)는 **부모 행에 `FOR KEY SHARE`**를 잡고 트랜잭션 끝까지 유지한다. PostgreSQL의 행 락 네 등급 중 가장 약한 것으로 "이 행의 키를 바꾸거나 지우지 마라"는 뜻이다 — 자식이 부모에게 바라는 것이 정확히 그것뿐이기 때문이다.

그래서 `UPDATE posts SET comment_count = comment_count + 1`처럼 **키가 아닌 컬럼만 바꾸는 UPDATE(= `FOR NO KEY UPDATE`)와는 충돌하지 않는다** — InnoDB에서 데드락을 만들던 조합이 PostgreSQL에서는 그냥 통과한다. 충돌하는 것은 `SELECT … FOR UPDATE`(JPA `PESSIMISTIC_WRITE`)와 부모 키 UPDATE·DELETE뿐이고, 그 경로가 있으면 그 부모를 참조하는 **자식 INSERT 전부가 줄을 선다.**

덧붙일 셋 — ① 락은 별도 락 테이블이 아니라 **튜플 헤더 `xmax`에 기록**되므로 부모 페이지가 더러워지고 WAL이 쓰인다(자식 INSERT가 부모 테이블에도 쓰기 부하를 만든다), ② 같은 부모를 여러 트랜잭션이 동시에 공유 락으로 잡으면 `xmax`에 **multixact**가 생겨 비용이 붙는다, ③ 부모 DELETE 쪽에서는 **자식 행에** `FOR KEY SHARE`가 걸리는데, 그 자식을 찾는 스캔이 인덱스 없이 돌면 그게 진짜 사고다.

### "PostgreSQL에서 FK를 걸었더니 부모 DELETE가 갑자기 느려졌습니다. 무엇부터 보나요?"

**자식 FK 컬럼의 인덱스부터 본다. PostgreSQL은 그걸 자동으로 만들어 주지 않는다.** 부모를 지울 때마다 검사 트리거 안에서 `SELECT 1 FROM 자식 WHERE fk_col = $1 FOR KEY SHARE`가 **Seq Scan**으로 돈다.

확진은 `BEGIN; EXPLAIN (ANALYZE, BUFFERS) DELETE …; ROLLBACK;` — 계획 트리에는 안 보이고 **`Trigger …: time=… calls=…` 줄**에 시간이 전부 찍혀 있으면 그것이다. 규모 감각까지 붙이면 좋다: 자식 1천만 건에 평균 행 192B면 24만 페이지 = 1.9GB이고, 순차 읽기 250MB/s 기준 약 8초다.

처방은 `CREATE INDEX CONCURRENTLY`, 상시 감시는 `pg_stat_user_tables.seq_scan` 증가. 이 함정이 `ON DELETE CASCADE`에서는 **부모 행 수만큼 곱해진다**는 것까지 말한다 — 부모 1,000건 정리 배치면 1.9TB 읽기다.

### "앱에서 부모 존재를 확인하고 INSERT하면 FK와 같은 것 아닌가요?"

같지 않다 — 두 가지가 빠진다.

⑴ **레이스 조건**: 확인과 INSERT 사이에 다른 트랜잭션이 부모를 물리 삭제하면 고아가 생긴다. FK의 `FOR KEY SHARE`가 정확히 이 틈을 막던 장치다. 손으로 같은 수준을 만들려면 부모를 `SELECT … FOR KEY SHARE`로 읽으면 되고, **PostgreSQL에서는 이게 MySQL보다 훨씬 쓸 만하다** — 이 등급은 부모의 일반 UPDATE를 막지 않아 경합이 거의 없다. 다만 **JPA `@Lock`에는 이 등급이 없어**(`PESSIMISTIC_READ`는 한 등급 센 `FOR SHARE`) 네이티브 쿼리로 내려 써야 한다.

⑵ **경로 커버리지**: 앱 검증은 앱을 거치는 경로만 지킨다 — psql `DELETE`, 보정 스크립트, `COPY` 적재, 검증을 빠뜨린 새 API는 못 막는다. 그래서 진입점을 도메인 서비스 한 곳으로 모으고 테스트 환경에선 FK를 켠다.

현실적 결론은 보장 등급이 **"생성 시 0건"에서 "발견 지연 N시간"으로 내려왔음을 인지하고 말하는 것**이다.

### "FK를 안 걸었을 때 팀이 가장 흔히 놓치는 게 뭔가요?"

**인덱스다 — 그런데 PostgreSQL에서는 이유가 한 겹 더 깊다.** MySQL이라면 "FK가 만들어 주던 인덱스가 함께 사라져서"인데, PostgreSQL은 애초에 만들어 주지 않으므로 **FK를 걸든 안 걸든 인덱스를 잊는다.**

진짜로 잃는 것은 `pg_constraint`라는 **카탈로그 근거**다 — FK가 있으면 "인덱스 없는 FK 컬럼"을 카탈로그 쿼리로 정확히 뽑아 CI에서 빌드를 깨뜨릴 수 있지만, 빼면 근거가 `%_id`라는 이름 규약뿐이라 규약을 안 지킨 컬럼(`writer`, `owner_no`)이 조용히 새고 참조가 아닌 컬럼(`trace_id`)은 거짓 양성이 된다. 처방은 "잊지 말자"가 아니라 **린트 두 벌**(카탈로그용 + 이름 규약용)이고 예외는 허용 목록 + PR 사유로 관리한다.

두 번째로 자주 놓치는 것은 **고아 탐지 배치의 커버리지 목록**인데, 이것도 FK가 있었으면 카탈로그에서 자동 생성됐을 목록이다. 셋째로는 ORM 역공학·ERD 자동 생성 도구가 관계를 못 그리게 되는 것 — 신규 입사자의 온보딩 비용으로 청구된다.

### "MSA로 분리된 서비스 간 참조는 어떻게 정합성을 지키나요?"

DB가 다르므로 FK는 선택지에 없고(`postgres_fdw`로 원격 테이블을 붙여도 FK는 걸리지 않는다), 참조는 **계약**으로만 지켜진다.

⑴ 코드에서는 `Long memberId`로 든다 — "DB가 지켜주지 않는 참조"임이 타입에 드러난다. ⑵ 생성 시 상대 서비스에 존재를 묻거나(동기 API — 결합·지연 대가), 상대가 발행한 이벤트로 만든 **로컬 사본**을 참조한다(최종적 일관성 대가). PostgreSQL이라면 그 이벤트 발행이 **transactional outbox + 논리 디코딩 CDC**(Debezium pgoutput)로 트랜잭션과 원자적으로 묶인다. ⑶ 상대가 삭제되면 이벤트로 통보받아 로컬 자식을 처리하고, 이벤트 유실을 전제로 **주기적 대사(reconciliation) 배치**가 두 서비스의 ID 집합을 맞춰 본다 — 단일 DB의 "고아 탐지 배치"가 서비스 간에서는 "대사 배치"가 되는 것이고, ["결제됐는데 주문이 없다" 사고](27-payment-succeeded-order-missing-incident.md)의 Outbox·대사와 같은 도구 상자다.

### "그럼 나중에 FK를 다시 걸 수 있나요? 이미 고아가 있으면요?" (시니어 변별 포인트)

**PostgreSQL은 MySQL보다 나은 답을 갖고 있다 — 하지만 절반만 낫다.**

⑴ **DDL 비용은 해결된다**: 그냥 `ADD FOREIGN KEY`는 두 테이블에 `SHARE ROW EXCLUSIVE`를 잡고 자식 전체를 검증해 쓰기를 막지만, `ADD CONSTRAINT … NOT VALID`로 걸면 검증 스캔 없이 밀리초짜리 락으로 끝나고 **그 순간부터 새로 들어오는 행은 검사된다.** 기존 데이터는 나중에 `VALIDATE CONSTRAINT`(`SHARE UPDATE EXCLUSIVE` — 읽기·쓰기를 안 막는다)로 따로 검증하고, 여기에 `SET lock_timeout = '2s'` + 재시도를 반드시 씌운다(락 대기가 뒤따르는 모든 쿼리를 줄 세우는 것이 PostgreSQL DDL 사고의 정석 경로다).

⑵ **기존 고아는 해결되지 않는다**: `VALIDATE CONSTRAINT`는 위반이 한 행만 있어도 실패한다. 3-4의 탐지 쿼리로 고아를 찾아 격리·정리하는 데이터 정비가 선행돼야 하고 이게 몇 주짜리 프로젝트가 되곤 한다. 게다가 2-10에서 본 대로 **"이게 정말 고아인지 판단할 근거가 이미 없다"**는 것이 정비를 어렵게 만든다.

`NOT VALID`인 채로 방치하는 것은 **"새 쓰기만 검사되는 반쪽 제약"**이고, `session_replication_role = replica`로 우회해 부은 데이터도 소급 검사되지 않는다 — 방어선이 아니라 거짓 안심이다.

결론 — MySQL에서는 "FK는 나중에 걸면 된다"가 사실상 거짓이지만, **PostgreSQL에서는 "DDL은 나중에 걸 수 있다, 데이터 정비는 나중에도 어렵다"**가 정확한 답이다.

### "결제·정산처럼 돈이 걸린 테이블도 FK를 빼나요?" (시니어 변별 포인트)

여기서 "우리 팀은 FK 안 겁니다"로 일괄 답하면 탈락이다. 3-8의 판단 축 ⑤(데이터 민감도)가 다른 축을 누른다 — **원장성 관계(결제 → 주문, 정산 → 결제)는 고아 한 건이 곧 돈의 불일치**이고, "N시간 내 발견"이 아니라 "생성 시 0건"이 필요하다.

게다가 이 관계는 3-9 결정 표의 조건을 하나씩 짚어 보면 FK 제거의 근거가 거의 없다 — 핫 부모도 아니고(주문 한 건에 결제 한 건), 샤딩하더라도 주문과 결제는 같은 샤드 키로 묶는 것이 정석이라 축 ①⑤가 해당되지 않는다.

따라서 **원장성 관계에는 FK를 유지하고, 그 위에 고아 탐지가 아니라 금액 대사 배치를 얹는다.** PostgreSQL이라면 둘을 더 붙인다 — 결제 DB에서는 `synchronous_commit`을 끄지 않고(커밋이 WAL fsync를 기다리게 둔다), 멱등키에 `UNIQUE` + `INSERT … ON CONFLICT DO NOTHING RETURNING`으로 중복 처리를 DB가 막게 한다.

같은 시스템 안에서도 알림·이력 테이블은 FK를 빼는 — **"테이블마다 판단"이 이 질문의 정답 형태**다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **FK 컬럼 인덱스** — MySQL(InnoDB)은 FK를 만들 때 자식 FK 컬럼 인덱스를 자동 생성하지만 **PostgreSQL은 하지 않는다.** PostgreSQL FK 사고의 1순위가 여기서 나오고, 반대로 "FK를 빼면 인덱스도 사라진다"는 MySQL식 경고는 PostgreSQL에 적용되지 않는다. ② **락 등급** — InnoDB는 자식 INSERT의 공유(S) 락과 부모 카운터 UPDATE의 배타(X) 락 조합만으로 데드락이 나고 READ COMMITTED로 낮춰도 FK 검사의 갭 락이 남지만, PostgreSQL은 `FOR KEY SHARE` ↔ `FOR NO KEY UPDATE`가 호환이라 그 데드락이 없고 갭 락 개념 자체가 없다. ③ **스키마 변경** — MySQL은 gh-ost가 FK 테이블을 못 다루고 `ADD FOREIGN KEY`가 COPY라 **도구 선택지** 문제가 되지만, PostgreSQL은 `NOT VALID` → `VALIDATE`라는 정식 우회로가 엔진 안에 있다. ④ **검사 시점** — PostgreSQL은 `DEFERRABLE INITIALLY DEFERRED`로 커밋까지 미룰 수 있고(`RESTRICT`는 못 미룬다), MySQL은 즉시 검사만 있다. ⑤ **파티셔닝과 캐스케이드** — MySQL 파티션 테이블은 FK 미지원이라 "파티셔닝 = FK 제거"가 강제되지만 PostgreSQL은 지원하고, 캐스케이드 삭제도 MySQL은 자식 트리거를 발동시키지 않는 반면 PostgreSQL은 발동시킨다.

---

## 한 줄 요약

**FK는 "가리키는 곳이 반드시 있다"를 어떤 경로로 와도 강제하는 최후 방어선이고, PostgreSQL에서 그 대가는 자식 INSERT마다 부모 행에 커밋까지 쥐는 `FOR KEY SHARE`(겹치면 multixact) · **자식 FK 컬럼 인덱스를 자동 생성하지 않아 부모 DELETE가 자식 Seq Scan이 되는 것(PostgreSQL 사고 1순위 — 자식 1천만 건이면 1.9GB를 매번 읽고, `EXPLAIN ANALYZE`의 `Trigger` 줄로 확진)** · `ADD FOREIGN KEY`의 `SHARE ROW EXCLUSIVE` + 전체 검증 · 적재·아카이빙의 순서 제약 · 샤딩·분리에서의 성립 불가 · CASCADE가 남기는 죽은 튜플과 WAL이다. 반대로 InnoDB(MySQL)의 고전 데드락(자식 INSERT의 S 락 ↔ 부모 카운터 UPDATE의 X 락)은 PostgreSQL에서 나지 않는다 — `FOR NO KEY UPDATE`가 `FOR KEY SHARE`와 호환이라, 그 사슬은 코드가 부모를 `FOR UPDATE`로 잡을 때만 살아난다. 빼면 최후 방어선 · 고아 0건 보장(고아는 INNER JOIN이 가려 주기에 조용히 쌓이고 집계·배치·컴플라이언스에서 몇 달 뒤 터진다) · 문서로서의 스키마 · **참조 컬럼이라는 카탈로그 근거**(ORM 역공학·ERD 생성·데이터 계보·마이그레이션 도구·인덱스 린트가 전부 여기 얹혀 있다)를 잃는다. 그래서 기본값은 걸고(PostgreSQL은 인덱스 · `FOR NO KEY UPDATE` · `NOT VALID`+`VALIDATE` · `DEFERRABLE` · `session_replication_role`로 반대 논거의 절반을 깎으므로 기본값이 더 강하다), 빼는 것은 판단 6축 — 핫 부모·DDL 규모·분산 계획·삭제 정책·데이터 민감도·팀 규율 — 중 분산 계획 같은 조건이 확인된 예외로 다루며, 빼는 순간 앱 레벨 존재 검증(+`FOR KEY SHARE`) + 소프트 삭제 + FK 컬럼 인덱스 린트 + 고아 탐지 배치와 알람 + 소프트 참조 규약·문서화 + 테스트 환경 FK + JPA `NO_CONSTRAINT`가 한 세트로 따라와야 한다 — 대체 체계 없이 FK만 빼는 것은 결정이 아니라 방치다.**
