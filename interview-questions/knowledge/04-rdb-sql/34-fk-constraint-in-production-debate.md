# 운영 DB의 FK 제약 논쟁 — PostgreSQL에서 FK가 실제로 무엇을 잡는가, 그리고 포기한 방어선을 무엇으로 메우는가

> 핵심 관전 포인트: **FK는 "가리키는 곳이 반드시 있다"를 어떤 경로로 들어와도
> 강제하는 최후 방어선이다. PostgreSQL에서 그 대가에는 이름이 정확히 붙는다 —
> 자식 INSERT마다 부모 행에 **`FOR KEY SHARE`** 락을 커밋까지 쥐고(공유끼리
> 겹치면 `xmax`에 multixact), 부모 DELETE·키 UPDATE마다 자식 테이블을 훑는데
> **PG는 자식 FK 컬럼 인덱스를 자동으로 만들어 주지 않아** 그 훑기가 그대로
> Seq Scan이 된다 — **PG에서 FK로 나는 사고의 1순위다.** 반대로 InnoDB의
> 고전 데드락("자식 INSERT의 S 락 ↔ 부모 카운터 UPDATE의 X 락")은 **PG에서
> 나지 않는다**: 키가 아닌 컬럼만 바꾸는 UPDATE는 `FOR NO KEY UPDATE`를 잡고
> 이건 `FOR KEY SHARE`와 충돌하지 않기 때문이며, 그 사슬은 코드가 부모를
> `SELECT … FOR UPDATE`(JPA `PESSIMISTIC_WRITE`)로 잡을 때만 살아난다.
> 남는 진짜 이유는 운영 쪽 — `ADD FOREIGN KEY`의 `SHARE ROW EXCLUSIVE` +
> 전체 검증, 적재·아카이빙의 순서 제약, 샤딩·서비스 분리에서의 성립 불가,
> CASCADE가 남기는 죽은 튜플·WAL, 그리고 "대규모 회사 관행의 전파". 그런데
> PG는 이 중 절반을 깎을 도구를 엔진에 갖고 있다(FK 컬럼 인덱스 ·
> `FOR NO KEY UPDATE` · `NOT VALID`→`VALIDATE` · `DEFERRABLE` ·
> `session_replication_role`). 그래서 **PG에서 "건다"는 더 강한 기본값**이고,
> 빼는 것은 조건이 확인된 예외이며, 빼는 순간 앱 레벨 존재 검증 + 소프트
> 삭제 + FK 컬럼 인덱스 강제 + 고아 탐지 배치와 알람 + 소프트 참조 규약·
> 문서화(+ 테스트 환경에서만 FK 켜기)가 한 세트로 따라와야 한다. 대체 체계를
> 운영할 준비 없이 FK만 빼는 것은 결정이 아니라 방치다.**

---

## 0. 질문 + 의도

**질문**: "운영 DB에서 FK 제약을 걸지 않는 팀이 많은 이유는 무엇이고,
본인의 견해는? FK 없이 정합성은 어떻게 지키나요?"

**PostgreSQL 기준 재해석**: "PostgreSQL에서 FK가 검사할 때 실제로 잡는 락과
훑는 대상은 무엇이고, 그중 어디까지가 정말 'FK를 빼야 할 이유'인가? 뺀다면
정합성은 무엇으로 지키나?"

**출제 의도**: 대용량 환경에서 FK가 만드는 비용(락 전파, 마이그레이션
제약, 샤딩 불가)과 FK를 포기했을 때 잃는 최후 방어선을 **양쪽 다** 말할
수 있는지 — 교과서 규범("참조 무결성은 DB가 지킨다")과 실무 관행("운영
DB엔 FK 안 건다")이 충돌하는 지점에서 **"우리 서비스의 조건"으로 결론을
내는 사고**를 본다. 앱 레벨 검증 + 배치 정합성 점검으로 대체하는 체계까지
말하면 상급이다.

즉 이 문항은 "FK 찬성/반대"를 묻는 것이 아니다. 채점 지점은 세 층이다 —
⑴ 비용을 "느려진다"가 아니라 **메커니즘으로** 말하는가 ⑵ 잃는 것을
**회피하지 않고 정면으로** 말한 뒤 조건으로 결론 내는가 ⑶ 포기한 방어선을
**사람의 주의력이 아닌 체계로** 대체하는가.

PostgreSQL에서는 한 층이 더 붙는다 — ⑷ **"들은 이유"가 우리 엔진에도
해당되는지 검증했는가**(2-1, 2-2).

> 이 문서는 후보자의 횡단 약점 4가지를 겨냥해 구성했다 — ① FK의 비용을
> **이름 붙은 메커니즘 사슬**로 말하기(2장) ② 잃는 것까지 **양면으로
> 조립**하고 "우리 서비스의 조건"으로 결론 내기(3장·5장) ③ 포기한
> 방어선을 **코드·잡·규약으로 고정**하기(4장) ④ "안 거는 이유 N가지 /
> 잃는 것 N가지 / 대체 체계 N가지"를 **목록으로 인출**하기(각 장 첫머리).

> 연결 문서: FK가 걸린 테이블의 스키마 변경이 왜 까다로운지는
> [무중단 스키마 변경](14-online-ddl-zero-downtime-schema-change.md),
> `FOR UPDATE`와 `FOR NO KEY UPDATE`의 차이는
> [SELECT FOR UPDATE 락 범위](19-select-for-update-lock-scope.md),
> PG에서 데드락이 나는 유형은
> [행 락과 데드락](12-gap-lock-next-key-lock-deadlock.md),
> "정합성이 DB 제약이 아니라 앱 관례에 살면 왜 새는지"는
> [정규화 vs 반정규화](04-normalization-vs-denormalization.md) §2-3,
> soft delete가 FK를 무의미하게 만드는 지점은
> [Soft delete와 유니크·연관관계](../03-jpa-orm/26-soft-delete-unique-and-associations.md) §6-3,
> JPA cascade와 DB `ON DELETE CASCADE`의 차이는
> [CascadeType.REMOVE와 orphanRemoval](../03-jpa-orm/24-cascade-remove-vs-orphan-removal.md) §7,
> "참조는 둘, FK는 하나"의 매핑 기초는
> [연관관계의 주인과 mappedBy](../03-jpa-orm/06-association-owner-and-mappedby.md)에 있다.

---

## 1. FK가 하는 일 — 무엇을 지키고, 그 대가로 PostgreSQL이 매번 무엇을 하는가

### 1-1. 참조 무결성 = "가리키는 곳이 반드시 있다"

외래 키(FK, foreign key) 제약은 한 문장이다 — **자식 행의 참조 컬럼 값은
부모 테이블에 반드시 존재하는 키여야 한다.** `comments.post_id = 42`라면
`posts.id = 42`가 있어야 하고, 그 행을 지우려면 먼저 댓글을 처리해야
한다. 이 성질을 참조 무결성(referential integrity)이라 부르고, 이것이
깨진 자식 행 — 부모 없는 자식 — 을 **고아 행(orphan row)** 이라 한다.

비유하면 FK는 건물 출입구의 경비원이다. 어떤 문으로 들어오든(앱 코드, 배치,
운영자의 psql `DELETE`) 신분증(부모 존재)을 확인한다. 경비원을 없애면 출입도
이삿짐(대량 적재)도 빨라지지만, 그때부터 "누가 들어왔는지"는 각 부서(코드
경로)가 알아서 확인해야 한다.

> PG에서 "DB가 지키는 불변식"의 도구 상자는 FK 하나가 아니다 — `CHECK`,
> `UNIQUE`(부분 유니크 인덱스 포함), PG 고유의 `EXCLUDE` 제약까지 있다. FK
> 논쟁이 "제약 전체를 뺄 것인가"로 번지지 않으려면 **참조 무결성만 앱으로
> 내려보내는 결정**임을 분명히 해 둔다.

### 1-2. 검사가 일어나는 네 순간 — 그리고 각 순간에 PG가 잡는 것

FK를 "느리다"고 뭉뚱그리지 않으려면 **언제 검사가 일어나고 그때 무엇을
잡는지**부터 고정해야 한다.

| 순간 | PostgreSQL이 하는 일 | 잡는 락 |
|---|---|---|
| ① 자식 INSERT | 부모의 PK(또는 유니크 인덱스)에서 참조 값을 찾는다 | **부모 행에 `FOR KEY SHARE`** — 트랜잭션 끝까지 유지 |
| ② 자식의 FK 컬럼 UPDATE | 새 부모 값을 ①처럼 찾는다 | 새 부모 행에 `FOR KEY SHARE` |
| ③ 부모 DELETE | 자식 테이블에서 이 부모를 참조하는 행을 찾는다 — **인덱스가 없으면 Seq Scan** | 찾은 자식 행에 `FOR KEY SHARE`(RESTRICT/NO ACTION). CASCADE면 자식에 실제 DELETE |
| ④ 부모 키 UPDATE | ③과 같다 (실무에선 드묾) | ③과 같다 |

여기서 고정할 것이 네 가지다.

- **검사는 내부 트리거로 구현된다.** PG의 FK는 문법 설탕이 아니라 시스템
  트리거다(`pg_constraint`에 제약, `pg_trigger`에 그것이 만든 내부 트리거).
  이 사실이 뒤에서 두 번 쓰인다: ⓐ `session_replication_role = replica`로
  **트리거를 끄면 FK 검사도 꺼진다**(2-3), ⓑ FK 컬럼 인덱스 점검을
  **카탈로그 쿼리**로 자동화할 수 있다(4-3).
- **락은 `FOR KEY SHARE`이지 "공유 락"이 아니다.** PG의 행 락은 네 등급
  (`FOR UPDATE` > `FOR NO KEY UPDATE` > `FOR SHARE` > `FOR KEY SHARE`)이고
  FK가 잡는 것은 **가장 약한 등급** — "이 행의 키를 바꾸거나 지우지만 마라"
  라서 부모의 **키가 아닌 컬럼을 바꾸는 UPDATE는 막지 않는다.** 2-1이
  InnoDB와 갈리는 지점이 전부 여기서 나온다.
- **잡은 락은 트랜잭션이 끝날 때까지 살고, 튜플 헤더 `xmax`에 기록된다.**
  그래서 락을 잡는 것만으로 부모 페이지가 더러워지고 WAL이 쓰인다 —
  **"읽기 검사"처럼 보이는 자식 INSERT가 부모 테이블에도 쓰기 부하를
  만든다**(가산점 포인트). 같은 부모를 여러 트랜잭션이 동시에 공유 락으로
  잡으면 `xmax`에 단일 XID 대신 **multixact ID**가 들어가고 멤버 목록이 별도
  저장소로 빠진다 — 핫 부모의 숨은 비용이 여기 있다.
- **검사 시점을 미룰 수 있다.** `DEFERRABLE INITIALLY DEFERRED`면 검사가
  **커밋 시점**까지 미뤄진다(부모를 붙잡는 창도 그만큼 늦게 열린다). 상호
  참조하는 두 행을 한 트랜잭션에서 넣을 때의 정석이고, 대가는 위반이
  **COMMIT에서 터진다**는 것과 대량 변경 시 검사 큐가 커밋에 몰린다는 것.
  덧붙여 **`NO ACTION`은 미룰 수 있고 `RESTRICT`는 못 미룬다.**

검사 자체의 CPU 비용은 작다 — 부모 유니크 인덱스 탐색 한 번 + 가시성 확인용
힙 페치 한 번. **FK 비용의 실체는 "찾기"가 아니라 "찾은 뒤 쥐고 있는 락",
"인덱스가 없을 때의 훑기", 운영상의 제약**이다. 이 구분을 못 하면 "FK는
느려서 뺐다"가 근거 없는 관행 반복으로 들린다.

---

## 2. FK를 걸지 않는 이유 7가지 — 각각을 메커니즘 사슬로

목록부터 인출한다. 면접에서는 이 순서로 말한다.

> **FK를 안 거는 이유 7가지 (PostgreSQL 판)**
> ① 락 전파 — 자식 INSERT의 `FOR KEY SHARE`가 부모의 `FOR UPDATE`와 충돌
> ② **부모 DELETE의 자식 검사 — PG는 FK 컬럼 인덱스를 자동 생성하지 않는다**
> ③ 대량 적재·마이그레이션·아카이빙의 순서 제약
> ④ 스키마 변경 제약 — `ADD FOREIGN KEY`의 `SHARE ROW EXCLUSIVE` + 전체 검증
> ⑤ 샤딩·서비스 분리에서 FK 성립 불가 (파티셔닝은 PG에선 예외)
> ⑥ CASCADE의 예측 불가 폭발 — 죽은 튜플·WAL·레플리카 지연까지
> ⑦ (솔직한 이유) 관행의 전파 — 성능은 사후 정당화인 경우가 많다

**PG에서는 ②가 1순위다.** ①이 첫 줄에 오는 것은 MySQL 이야기를 그대로
옮겨온 순서이고, PG 운영에서 FK 때문에 사람이 불려 나가는 사고는 거의 전부
②다. 이 순서 감각까지 말하면 "읽어서 아는" 게 아니라 "겪어서 아는" 사람으로
들린다.

### 2-1. ① 락 전파 — `FOR KEY SHARE` ↔ `FOR UPDATE`, 그리고 PG에서 사라지는 고전 데드락

가장 자주 인용되는 사슬이고 [정규화 문서](04-normalization-vs-denormalization.md)의
`posts.comment_count` 예제와 맞물린다. **그런데 PostgreSQL에서는 이 사슬의
중간이 끊어진다** — 끊어지는 지점을 짚는 것이 이 절의 목적이다.

> **⑴ 자식 INSERT가 부모 행에 `FOR KEY SHARE`**: `INSERT INTO comments
> (post_id) VALUES (42)`는 FK 검사로 `posts.id = 42` 행에 가장 약한 등급의
> 행 락을 잡고 커밋까지 쥔다.
>
> **⑵ 그런데 부모 카운터 UPDATE는 이것과 충돌하지 않는다**:
> `UPDATE posts SET comment_count = comment_count + 1 WHERE id = 42`는
> **키가 아닌 컬럼만 바꾸므로 PG가 `FOR NO KEY UPDATE`를 잡는다.**
> `FOR NO KEY UPDATE`는 `FOR KEY SHARE`와 **호환**된다 → 대기 없음.
> InnoDB에서 데드락을 만들던 바로 그 조합이 PG에서는 그냥 통과한다.
>
> **⑶ 사슬이 살아나는 조건 — 코드가 부모를 `FOR UPDATE`로 잡을 때**:
> 재고·잔액·포인트를 다루느라 `SELECT … FROM posts WHERE id = 42 FOR
> UPDATE`(JPA `@Lock(PESSIMISTIC_WRITE)`)를 쓰면 이야기가 달라진다.
> `FOR UPDATE`는 **모든 등급과 충돌**하므로 `FOR KEY SHARE`를 막는다 →
> **그 부모를 참조하는 모든 자식 INSERT가 줄을 선다.** FK가 없었다면 자식
> INSERT는 부모의 락에 아무 관심이 없었을 것이다.
>
> **⑷ 대기의 교차 = 데드락**: 두 트랜잭션이 각각 "자식 INSERT → 부모
> `FOR UPDATE`" 순서로 가면, 서로가 쥔 `FOR KEY SHARE` 때문에 둘 다
> `FOR UPDATE`를 못 얻어 교착한다.
>
> **⑸ 대기 전파**: 데드락이 아니어도, 부모를 `FOR UPDATE`로 오래 쥐는
> 트랜잭션 하나가 그 부모의 자식 INSERT 전부를 락 큐에 세운다 → 트랜잭션
> 장기화 → 커넥션 풀 고갈 → 무관한 API까지 전파. PG에서는 여기에 한 겹 더
> 붙는다 — 길어진 트랜잭션이 VACUUM을 막아
> [bloat](16-long-transaction-harm-and-shortening.md)로 번진다.

```sql
-- ❌ before: PG에서 실제로 데드락이 나는 형태 — 부모를 FOR UPDATE 로 잡는 코드
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
-- ✅ after: 락 등급을 낮춘다 — PG에서는 이것이 정답이고, 순서 반전이 필요 없다
BEGIN;
INSERT INTO comments (post_id, body) VALUES (42, 'a');   -- 부모에 FOR KEY SHARE
UPDATE posts SET comment_count = comment_count + 1       -- 부모에 FOR NO KEY UPDATE
WHERE id = 42;                                           -- ← KEY SHARE 와 호환. 대기도 데드락도 없다
COMMIT;
-- 명시적으로 잠가야 한다면 FOR UPDATE 가 아니라 FOR NO KEY UPDATE 를 쓴다.
-- (부모의 키를 바꾸거나 지울 게 아니라면 FOR UPDATE 는 과하다)
```

> **MySQL 대조 — 여기가 엔진이 갈리는 지점이다.** InnoDB에는 락 등급이
> `FOR KEY SHARE`처럼 세분돼 있지 않다. 자식 INSERT는 부모 행에 **공유(S)
> 레코드 락**을 잡고, `comment_count` UPDATE는 **배타(X) 락**을 요구하며,
> S와 X는 호환되지 않는다 → **두 트랜잭션이 "자식 INSERT → 부모 UPDATE"
> 순서로 가면 그것만으로 데드락**(`ERROR 1213 (40001)`). 회피하려면 부모
> UPDATE를 먼저 두어 X를 선점해야 하는데, 그러면 락 보유 시간이 길어지는
> 딜레마가 생긴다. 덧붙여 InnoDB는 **READ COMMITTED로 낮춰도 FK 검사의 갭
> 락은 남는다.** PG에는 갭 락이라는 개념 자체가 없다
> ([행 락과 데드락 문서](12-gap-lock-next-key-lock-deadlock.md)).
> **"FK는 락 때문에 못 쓴다"는 논거를 PG에 그대로 옮기면 틀린다** — 이
> 대조를 말할 수 있으면 두 엔진을 원리로 이해한 사람으로 들린다.

그래서 PG에서 ①의 정확한 서술은 **"FK가 락 사고를 만드는 게 아니라, 부모를
`FOR UPDATE`로 잡는 코드가 있을 때 FK가 그 락의 영향 범위를 자식 INSERT까지
넓힌다"**가 된다. 처방도 여기서 나온다 — FK를 빼기 전에 **락 등급을 낮추거나
원자적 UPDATE로 명시적 락을 없앤다.** 그러고도 남는 경합이라면 그건 FK
문제가 아니라 [핫 로우 문제](23-high-frequency-counter-hot-row.md)다.

### 2-2. ② 부모 DELETE의 자식 검사 — PG는 FK 컬럼 인덱스를 자동으로 만들지 않는다

**PostgreSQL에서 FK로 나는 사고의 압도적 1위다.**

부모 행을 지우면 DB는 "이 부모를 가리키는 자식이 있나"를 자식 테이블에서
찾아야 한다. 자식의 FK 컬럼에 인덱스가 있으면 탐색 한 번, 없으면 **자식
테이블 전체 Seq Scan**이다. 그리고 —

- **MySQL(InnoDB)**: FK를 만들 때 자식 FK 컬럼 인덱스가 없으면 **자동으로
  만든다** — 그래서 이 함정을 거의 겪지 않는다.
- **PostgreSQL**: **자동으로 만들지 않는다.** 부모 쪽은 PK라 이미 있지만
  자식 쪽은 사람이 만들어야 한다. 이 한 줄이 PG FK 사고의 대부분을 설명한다.

증상은 이렇게 나타난다.

```sql
-- ❌ before: FK 는 걸었는데 인덱스는 안 만들었다 (PG 에서 아주 흔하다)
CREATE TABLE comments (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id    bigint NOT NULL REFERENCES posts (id),   -- 인덱스는 생기지 않는다
    body       text   NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 부모 한 행 삭제 = 자식 1억 건 Seq Scan
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM posts WHERE id = 42;
--  Delete on posts  (actual time=8421.093..8421.094 rows=0 loops=1)
--    ->  Index Scan using posts_pkey on posts  (actual rows=1 loops=1)
--  Trigger RI_ConstraintTrigger_a_16428 for constraint comments_post_id_fkey:
--        time=8412.377 calls=1                     ← 시간의 99%가 FK 트리거 안에 있다
--  Execution Time: 8421.402 ms
-- (트리거가 도는 SELECT 1 FROM comments WHERE post_id = $1 FOR KEY SHARE 가
--  Seq Scan 이다. 계획 본문에는 안 보이고 Trigger 줄의 time 으로만 드러난다.)

-- ✅ after: 자식 FK 컬럼 인덱스 — 다시 재면 Trigger 의 time 이 밀리초로 떨어진다
CREATE INDEX CONCURRENTLY idx_comments_post_id ON comments (post_id);
```

**진단 포인트 둘.** ⓐ 계획 트리에는 FK 검사가 안 보이고 **`Trigger …:
time=… calls=…` 줄**로만 드러난다 — "DELETE 한 줄인데 8초"의 범인을 찾는
자리다(`EXPLAIN ANALYZE`는 실제로 실행되므로 DML은 `BEGIN; … ROLLBACK;`으로
감싼다). ⓑ 상시 감시는 자식 테이블의 `pg_stat_user_tables.seq_scan`으로.

같은 함정이 **`ON DELETE CASCADE`에서는 곱해진다.** 캐스케이드는 자식에
실제 `DELETE FROM comments WHERE post_id = $1`을 실행하므로, 인덱스가 없으면
**부모 한 행마다 자식 전체 스캔**이다 — 부모 1,000건 정리 배치가 풀스캔
1,000번이 된다.

즉 ②는 "FK를 빼는 이유"라기보다 **"PG에서 FK를 걸면 반드시 함께 만들어야
하는 것을 빠뜨렸을 때 생기는 문제"**다. 4-3의 린트가 PG에서 **FK를 걸든 안
걸든** 필요한 이유이기도 하다.

### 2-3. ③ 대량 적재·마이그레이션·아카이빙의 순서 제약

FK가 있으면 데이터 이동에 **순서**가 생긴다.

- **적재**: 부모 → 자식 순서로만 넣을 수 있다. 수억 건을 병렬로 붓는
  파이프라인에서 이 순서는 병렬성을 죽인다. PG에서 푸는 방법은 셋이다.

```sql
-- ⑴ 검사 트리거를 통째로 끄고 붓는다 (슈퍼유저 권한 필요)
SET session_replication_role = replica;   -- FK·사용자 트리거가 발동하지 않는다
COPY comments FROM '/data/comments.csv' WITH (FORMAT csv);
SET session_replication_role = origin;
-- ⚠️ 되돌려도 이미 들어간 데이터는 검사하지 않는다 — MySQL 의 foreign_key_checks=0 과
--    같은 함정. "적재 중엔 어차피 끈다"가 "평소에도 없는 것과 뭐가 다른가"로 이어진다.

-- ⑵ 제약을 잠시 떼고 붓고, 다시 붙일 때 검증까지 한다 (PG 정석)
ALTER TABLE comments DROP CONSTRAINT comments_post_id_fkey;
COPY comments FROM '/data/comments.csv' WITH (FORMAT csv);
ALTER TABLE comments ADD CONSTRAINT comments_post_id_fkey
    FOREIGN KEY (post_id) REFERENCES posts (id) NOT VALID;   -- 락 짧게, 새 행부터 검사
ALTER TABLE comments VALIDATE CONSTRAINT comments_post_id_fkey;  -- 쓰기 허용하며 기존 행 검증

-- ⑶ 한 트랜잭션 안에서 순서를 섞어야 하면 검사를 커밋으로 미룬다
--    ALTER TABLE … ALTER CONSTRAINT … DEFERRABLE INITIALLY DEFERRED;
--    또는 한시적으로  BEGIN; SET CONSTRAINTS ALL DEFERRED; … COMMIT;
```

⑵가 "적재 때문에 FK를 아예 안 건다"를 상당 부분 무력화하는 선택지다 —
**검사를 영구히 포기하는 대신 나중에 한 번 몰아서 한다.** 이 도구를 아느냐
모르느냐로 결론이 갈린다.

- **아카이빙**: 오래된 부모를 옮기려면 자식을 먼저 옮기거나 지워야 하고,
  자식이 여러 테이블에 흩어져 있으면 아카이빙 잡이 FK 그래프 전체를 알아야
  한다. PG는 이동을 한 문장으로 원자화할 수 있지만
  (`WITH moved AS (DELETE … RETURNING *) INSERT …`) **순서 제약은 그대로**다.
- **테이블 교체·복구**: `pg_restore`로 테이블 하나만 되살리거나 새 테이블로
  스왑하는 작업에서 FK가 다른 테이블을 물고 있으면 순서·잠금 창이 생긴다.
  (`pg_restore`가 제약을 데이터 적재 뒤에 거는 것도 같은 이유다.)

### 2-4. ④ 스키마 변경 제약 — `ADD FOREIGN KEY`의 잠금과 검증 스캔

PostgreSQL에는 gh-ost·pt-osc 같은 외부 도구 이야기가 없다. 대신
**모든 것이 잠금 수준의 문제**로 환원된다
([무중단 스키마 변경 문서](14-online-ddl-zero-downtime-schema-change.md)).

- **`ADD FOREIGN KEY`(그냥)**: **두 테이블 모두에 `SHARE ROW EXCLUSIVE`**
  락을 잡고 자식 전체를 훑어 기존 데이터를 검증한다. SELECT는 허용하지만
  **INSERT/UPDATE/DELETE를 막고**, **부모 테이블의 쓰기까지 함께 막힌다**는
  점이 자주 간과된다.
- **대기열 함정**: 이 락 요청은 진행 중인 롱 트랜잭션 뒤에 줄을 서고,
  **그 뒤로 오는 모든 쓰기가 다시 그 뒤에 줄을 선다** — 마이그레이션 한 줄이
  장애가 되는 전형적 경로다. 그래서 PG의 DDL은 항상 이 형태로 감싼다:

```sql
-- ✅ 운영에서 FK 를 거는 정석 — 짧은 락 + 재시도, 그리고 검증은 따로
SET lock_timeout = '2s';                       -- 못 잡으면 포기(뒤를 막지 않는다)
ALTER TABLE comments ADD CONSTRAINT comments_post_id_fkey
    FOREIGN KEY (post_id) REFERENCES posts (id) NOT VALID;   -- 검증 스캔 없음 = 락이 짧다
RESET lock_timeout;
-- 실패하면 잠시 뒤 재시도. 여기까지만 해도 "새로 들어오는 행"은 이미 검사된다.

ALTER TABLE comments VALIDATE CONSTRAINT comments_post_id_fkey;
-- SHARE UPDATE EXCLUSIVE — 읽기·쓰기를 막지 않고 기존 데이터를 훑는다.
-- 대신 오래 걸리고, 도는 동안 그 테이블의 autovacuum·다른 DDL 과는 충돌한다.
```

- **타입 변경의 연쇄**: 부모 PK를 `int` → `bigint`로 바꾸는 작업은 테이블
  재작성인 데다 **그 키를 참조하는 FK들이 다시 검증**되고, 자식 FK 컬럼도
  함께 바꿔야 하므로 작업 단위가 **FK 그래프 전체**로 커진다.
- **인덱스 순서**: 자식 FK 컬럼 인덱스는 `CREATE INDEX CONCURRENTLY`로
  **먼저** 만든다. FK를 먼저 걸면 검증 스캔이 인덱스 없이 돈다.

> **MySQL 대조**: 같은 제약이 MySQL에서는 **도구 선택지 문제**로 나타난다 —
> gh-ost는 대상이 FK의 부모든 자식이든 **지원하지 않고**(하드 리밋),
> pt-online-schema-change는 `--alter-foreign-keys-method`로
> `rebuild_constraints`(자식마다 또 하나의 대공사)나 `drop_swap`(테이블이
> 잠깐 존재하지 않는 창)을 골라야 하며, 네이티브 `ADD FOREIGN KEY`는 검사를
> 켠 상태면 **COPY 알고리즘**(쓰기 차단, 디스크 2배)이다. **PG에는
> `NOT VALID` → `VALIDATE`라는 정식 우회로가 엔진 안에 있다**는 것이 결정적
> 차이고, 그래서 "④ 때문에 뺀다"는 논거는 PG에서 그만큼 세지 않다.

### 2-5. ⑤ 샤딩·서비스 분리 — FK가 성립 불가한 지형 (파티셔닝은 예외)

FK는 **같은 DB 안의 두 테이블** 사이에서만 성립한다.

- **샤딩**: `comments`가 `user_id`로 샤딩되고 `posts`가 `post_id`로
  샤딩되면 부모와 자식이 다른 서버에 있다. 검사할 대상이 물리적으로
  다른 곳에 있으니 FK 자체가 정의될 수 없다
  ([샤딩 문서](24-sharding-timing-shard-key-and-cross-shard.md) — 크로스
  샤드 조인이 사라지는 것과 같은 뿌리다). PG의 분산 확장(Citus)에서도
  FK는 **co-location된 분산 테이블 사이나 reference table을 향할 때로
  제한**된다 — "같은 샤드에 같이 사는 관계만 DB가 지켜준다"는 규칙이
  샤드 키 설계를 거꾸로 규정한다. `postgres_fdw`로 원격 테이블을 붙여도
  FK는 걸리지 않는다.
- **파티셔닝 — 여기서 PG는 MySQL과 다르다.** MySQL의 파티션 테이블은 FK를
  지원하지 않아 "파티셔닝 도입 = FK 제거"가 강제되지만, **PG의 선언적
  파티셔닝은 파티션 테이블이 FK의 자식 쪽도 부모 쪽도 될 수 있다.** 다만
  부모가 파티션 테이블이면 참조되는 유니크 키가 **파티션 키를 포함**해야
  하므로 참조 모델이 파티션 키에 끌려간다 — PG에서 질문은 "파티셔닝하니까
  FK를 걷어낼까"가 아니라 **"파티션 키를 참조 키에 넣을 수 있는가"**다.
- **서비스 분리(MSA)**: 주문 서비스의 `orders.member_id`가 회원 서비스의
  `members.id`를 가리키지만 DB가 다르다 — 참조는 **DB가 아니라 계약(API·
  이벤트)으로만 지켜지고**, 4-5절의 소프트 참조 규약이 유일한 선택지다.

"언젠가 샤딩·분리할 것"이라면 FK에 기대 짠 코드(삭제 순서를 FK에 맡기기,
cascade)는 그때 전부 다시 짜야 한다. 그래서 **처음부터 FK 없는 규율로 가는
팀**이 생긴다. 다만 PG에서 그 "언젠가"의 첫 단계는 대개 샤딩이 아니라
**파티셔닝·레플리카·PgBouncer**이고 그 단계까지는 FK를 유지할 수 있다.

### 2-6. ⑥ CASCADE의 예측 불가 폭발

`ON DELETE CASCADE`는 부모 한 행 DELETE가 자식 → 손자 → 증손자로 번진다.

- **범위가 코드에 안 보인다.** `DELETE FROM posts WHERE id = 42` 한 줄이
  댓글·첨부·알림·통계 수만 건을 지우는데 리뷰어는 그 한 줄만 본다 —
  [cascade 문서](../03-jpa-orm/24-cascade-remove-vs-orphan-removal.md) §7의
  "JPA cascade는 파급이 보이고, DB cascade는 안 보인다"가 이 지점이다.
- **인덱스가 없으면 부모 한 행마다 자식 풀스캔**(2-2) — 곱셈으로 커진다.
- **PG에서는 지운 만큼 죽은 튜플이 남는다.** DELETE는 공간을 바로 돌려주지
  않고 `xmax`만 표시한다 — 캐스케이드로 자식 수십만 건을 지우면 그만큼
  죽은 튜플·인덱스 엔트리가 남아 **VACUUM 부담과 bloat**가 되고, 그 삭제는
  전부 **WAL로 기록돼 레플리카 지연**을 만든다
  ([MVCC 문서](11-mvcc-postgresql.md),
  [대량 삭제 문서](25-mass-delete-archiving-and-partitioning.md)). "부모 한
  행 삭제"의 진짜 청구서는 **그 뒤 몇 시간의 autovacuum**에 온다.
- **락과 시간이 예측 불가**다. 삭제되는 자식 행마다 락이 튜플 헤더에
  기록되고(PG는 락 에스컬레이션이 없어 행 수 제한은 없다) 트랜잭션은 그만큼
  길어진다 — [장기 트랜잭션의 해악](16-long-transaction-harm-and-shortening.md)이
  한 문장에서 시작된다.

> **MySQL 대조 (방향이 반대다)**: MySQL은 캐스케이드된 삭제가 **자식 트리거를
> 발동시키지 않아** 감사 로그가 비는 사고가 나지만, PG의 캐스케이드는 자식에
> **실제 `DELETE`를 실행**하므로 자식 트리거가 정상 발동한다 — 로그는 남되
> 트리거 비용까지 곱해진다.

그래서 FK를 쓰더라도 `CASCADE` 없이 `RESTRICT`(또는 `NO ACTION`)만 쓰는 팀이
많고, "어차피 RESTRICT만 쓸 거면 앱에서 막는 것과 뭐가 다른가"가 또 다른
논거가 된다. 답은 3-1이다 — **RESTRICT는 psql에서 들어와도 막지만 앱 코드는
앱을 거치는 경로만 막는다.**

### 2-7. ⑦ 솔직한 이유 — 관행의 전파

위 여섯이 다 해당되는 팀은 많지 않은데 "운영 DB엔 FK 안 건다"는 규칙은 훨씬
넓게 퍼져 있다. **대규모 서비스 회사의 DBA 컨벤션이 "정답"으로 전파**됐기
때문이다 — 그 회사들은 ①~⑥을 실제로 겪었지만, 컨벤션만 가져온 팀은 겪지
않은 문제를 피하려고 방어선을 버린다.

**PostgreSQL 사용자에게는 한 겹이 더 있다.** 널리 인용되는 FK 반대 논거의
상당수는 **InnoDB의 락 모델과 gh-ost 제약에서 나온 것**이라 PG에서는
성립하지 않거나 도구로 깎이고(2-1, 2-4), 반대로 **PG에만 있는 진짜 함정
(2-2)은 그 글들에 안 적혀 있다.** 그래서 관행만 옮겨 오면 두 번 틀린다 —
없는 문제를 피하려다 있는 문제를 놓친다. 인정하고 말하는 것이 오히려 신뢰를
준다: **"성능 때문에 뺐다"는 대개 사후 정당화이고, PG에서 실제 결정 요인은
운영 유연성(③④)과 분산 계획(⑤)이다.**

### 2-8. PG라면 빼기 전에 깎을 수 있는 것 — 다섯 가지 (가산점 포인트)

위 일곱 중 몇 개는 PG에서 **제거가 아니라 조정으로** 해결된다. "FK를
뺄까요?"에 곧장 답하지 않고 이 목록을 먼저 꺼내는 것이 이 문항에서 가장
인상적인 답변 경로다.

| 이유 | PG에서의 처방 | 남는 대가 |
|---|---|---|
| ② 부모 DELETE 풀스캔 | 자식 FK 컬럼에 `CREATE INDEX CONCURRENTLY` | 인덱스 하나 몫의 쓰기·공간 |
| ① `FOR UPDATE` 충돌 | `FOR NO KEY UPDATE`로 낮추거나 원자적 UPDATE로 명시적 락 제거 | 부모 키를 바꾸는 경로에는 그대로 필요 |
| ④ `ADD FOREIGN KEY` 잠금 | `NOT VALID` → `VALIDATE` (+ `lock_timeout` + 재시도) | 검증 전까지 기존 데이터 보장 없음 |
| ③ 적재 순서 | `DEFERRABLE INITIALLY DEFERRED`, 또는 뗐다 `NOT VALID`로 복구 | 위반이 COMMIT에서 터진다 |
| ③ 대량 적재 | `session_replication_role = replica`로 트리거 우회 | 슈퍼유저 + **소급 검사 없음** |

**깎이지 않는 것은 ⑤(분산 지형)와 ⑥(CASCADE)**뿐이고 ⑥은 `CASCADE`를 안
쓰면 사라진다. 즉 **PG에서 FK를 빼야 할 진짜 이유는 "샤딩·서비스 분리가
로드맵에 있다" 하나로 수렴한다** — 5장 결론의 근거다.

---

## 3. FK를 포기하면 잃는 것 4가지 — 정면으로

트레이드오프의 반대편이고, 가장 자주 건너뛰는 면이다. 2장만 말하고 끝내면
"관행을 외운 사람", 3장까지 말해야 "결정을 내릴 수 있는 사람"이다.

> **FK를 빼면 잃는 것 4가지**
> ① 최후 방어선 — 어떤 경로로 와도 뚫리지 않는 유일한 검사
> ② 고아 행이 쌓이지 않는다는 보장 — 증상은 몇 달 뒤에 엉뚱한 곳에서
> ③ 스키마의 문서 역할 — `\d` 출력·ERD·신규 입사자의 지도
> ④ (PG판) **카탈로그 근거** — "이 컬럼은 참조 컬럼"이라는 기계가 읽을 수
>    있는 사실. 인덱스 린트·고아 탐지 목록이 전부 여기에 얹혀 있다

### 3-1. ① 최후 방어선 — 불변식이 DB 제약에서 앱 관례로 내려온다

[정규화 문서](04-normalization-vs-denormalization.md) §2-3의 문장을 그대로
가져온다 — **"FK나 UNIQUE 제약은 DB가 지키므로 어떤 코드 경로로 들어와도
뚫리지 않는다. 반면 앱의 약속은 약속을 모르는 경로가 하나만 생겨도
뚫린다."** FK를 빼는 것은 참조 무결성을 정확히 그 "앱의 약속" 등급으로
강등시키는 일이다.

뚫는 경로는 늘 같은 세 종류다.

- **새 코드 경로**: 신입이 만든 관리자 일괄 삭제 API가 자식 처리를 빼먹는다.
  컴파일도 테스트도 통과한다.
- **앱을 거치지 않는 경로**: 장애 대응 중 psql `DELETE`, 데이터 보정
  스크립트, ETL 역적재, `COPY` 적재.
- **경로 비대칭**: 생성 경로는 부모를 확인하는데, 나중에 추가된 "계정 병합"
  경로는 참조를 옮기는 걸 잊는다.

FK가 있으면 이 셋이 전부 **에러로 즉시 드러난다.** 없으면 전부 **조용히
성공**한다. 이 차이가 최후 방어선의 뜻이다.

> PG에서는 "DB가 알아서 에러를 내주겠지"가 다른 곳에서는 실제로 맞는다 —
> 타입이 안 맞는 비교는 조용한 풀스캔이 아니라 `operator does not exist`
> 에러로 드러난다([풀스캔 원인 문서](02-index-not-used-full-scan.md)).
> 그래서 더 조심해야 한다 — **참조 무결성만은 제약을 걸지 않는 한 PG도
> 아무 말을 하지 않는다.**

### 3-2. ② 고아 행 — 조용히 쌓이고, 증상은 엉뚱한 곳에서 터진다

고아 행이 무서운 것은 생길 때가 아니라 **발견될 때**다.

- 부모를 조인해 화면을 그리는 코드가 `null`을 만나 NPE — 그런데 원인 행은
  석 달 전 배치가 만들었다.
- INNER JOIN 통계에서 고아 행이 빠져 매출 집계가 조용히 작다. 아무도 모른다.
- 개인정보 삭제 요청으로 회원을 지웠는데 그 회원의 주소가 담긴 자식 행이
  남아 있다 — 버그가 아니라 컴플라이언스 사고다.
- 뒤늦게 지우려는데 "정말 고아인지, 부모가 다른 경로로 옮겨진 건지"를
  판별할 근거가 없다.

FK는 이 모든 것을 **생성 시점에 0건으로** 유지한다. 대체 체계(4-4절)는
"발견 시점"을 몇 시간 단위로 당기는 것이지 0건을 보장하지 못한다 —
이 차이를 알고 받아들이는 것이 결정이다.

PG에서 한 가지가 더 붙는다. **고아 탐지 쿼리 자체가 비싸다.** 부모 없는
자식을 찾는 것은 안티조인이라 자식이 수억 건이면 `Hash Anti Join`으로 양쪽을
통째로 훑는다([조인 문서](06-join-types-and-execution.md)). 즉 FK를 빼서
아낀 비용의 일부를 **매시간 도는 탐지 배치로 도로 지불**한다.

### 3-3. ③ 스키마의 문서 역할

FK가 있는 스키마는 그 자체로 ERD다. psql에서 `\d comments` 한 번이면 "이
테이블은 누구를 가리키고 누가 나를 가리키는가"가 `Foreign-key constraints:` /
`Referenced by:` 두 줄로 나오고, DB 도구도 이걸 읽어 관계를 그린다. FK가
없으면 `member_id`가 `members.id`인지 `legacy_members.member_no`인지
**컬럼 이름과 부족의 기억**으로만 남는다 — 테이블이 200개를 넘으면 이 지식은
반드시 유실되고, 4-5절의 문서화 규약이 그 자리를 메워야 한다.

### 3-4. ④ 카탈로그 근거의 소멸 — PG에서 가장 비싸게 치르는 손실

여기서 MySQL과 결론이 갈린다. MySQL에서 이 칸은 **자동 생성 인덱스**인데
**PG는 애초에 만들어 주지 않으므로 잃을 것이 없다**(2-2). 대신 PG가 잃는
것은 한 단계 위다 — **"이 컬럼은 참조 컬럼"이라는 사실이 카탈로그에서
사라진다.**

이게 왜 큰 손실인지는 4-3의 린트를 보면 안다. FK가 있으면 인덱스 누락
점검을 `pg_constraint`(제약 목록) 하나로 **기계가 정확히** 할 수 있다.
FK가 없으면 `SELECT … FROM pg_constraint WHERE contype = 'f'`가 0행을
돌려주고, 근거는 `%_id`라는 **이름 규약**뿐이라 규약을 안 지킨 컬럼은
검사에서 새고 규약을 지켰지만 참조가 아닌 컬럼은 거짓 양성이 된다. 같은
일이 고아 탐지 배치의 커버리지 목록에서도 반복된다 — FK가 있으면 "검사할
관계 목록"이 카탈로그에 이미 있지만, 없으면 사람이 위키에 적어 관리하는
목록이 되고 새 컬럼이 생길 때마다 조용히 빠진다.

그리고 그 근거가 없어 인덱스를 빠뜨리면, 가장 흔한 조회부터 무너진다.

```sql
-- orders.member_id 는 논리적 FK 인데 인덱스가 없다
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE member_id = $1;
--  Seq Scan on orders  (actual rows=12 loops=1)
--    Filter: (member_id = $1)
--    Rows Removed by Filter: 49999988      ← 12행을 위해 5천만 행을 읽었다
--    Buffers: shared read=412000
```

**요약하면 — MySQL에서 FK 제거의 대표 함정이 "인덱스가 같이 사라지는 것"
이라면, PG에서는 "인덱스가 필요하다는 사실을 아무도 기계적으로 알 수 없게
되는 것"이다.** 처방은 같지만(4-3), PG에서는 그 린트가 **FK를 걸든 안 걸든
필수**라는 점이 다르다.

---

## 4. FK 없이 정합성을 지키는 체계 7가지 — 안전망을 코드·잡·규약으로 고정

FK를 빼기로 했다면 아래 일곱은 **선택이 아니라 세트**다 — 하나라도 빠지면
3장의 손실을 그대로 떠안는다.

> **대체 체계 7가지**
> ① 앱 레벨 존재 검증 — 그리고 레이스 조건의 보정(`FOR KEY SHARE`)
> ② 삭제는 소프트 삭제/아카이브로 — 부모가 안 사라지면 고아가 안 생긴다
> ③ FK 컬럼 인덱스 강제 — 마이그레이션 린트로
> ④ 고아 행 탐지 배치 + 알람 — 발견 지연을 시간 단위로
> ⑤ 소프트 참조 규약 + 스키마 문서화 — 이름·`COMMENT ON`·ERD 도구
> ⑥ 테스트/스테이징에서만 FK 켜기 — 버그를 운영 전에 드러내는 선택지
> ⑦ JPA에서 매핑과 물리 제약을 분리 — `NO_CONSTRAINT`와 `ddl-auto`

### 4-1. ① 앱 레벨 존재 검증 — 도메인 서비스가 경비원이 된다

```java
// ❌ before: FK 도 없고 검증도 없다 — 존재하지 않는 postId 가 그대로 저장된다
@Transactional
public Long addComment(Long postId, String body) {
    Comment comment = new Comment(postId, body);
    return commentRepository.save(comment).getId();   // 고아 행 생성 경로
}
```

```java
// ✅ after: 부모 존재(그리고 삭제되지 않음)를 같은 트랜잭션에서 확인한다
@Transactional
public Long addComment(Long postId, String body) {
    Post post = postRepository.findActiveById(postId)        // deleted_at IS NULL 조건 포함
        .orElseThrow(() -> new PostNotFoundException(postId));
    Comment comment = new Comment(post.getId(), body);
    return commentRepository.save(comment).getId();
}
```

검증은 **도메인 서비스 한 곳**에 둔다. 컨트롤러·배치·관리자 API가 각자
검증하면 3-1의 "경로 비대칭"이 그대로 재현된다.

**레이스 조건을 정직하게 말한다.** 위 코드에도 구멍이 있다 —
`findActiveById`와 `save` 사이에 다른 트랜잭션이 부모를 **물리 삭제**하면
고아가 생긴다. FK의 `FOR KEY SHARE`가 하던 일이 정확히 이 틈을 막는
것이었다. 보정 선택지는 셋이고 각각 대가가 있다.

- **부모를 물리 삭제하지 않는다(4-2)** → 틈 자체가 사라진다. 대부분의
  팀이 실제로 택하는 답이다.
- **부모를 `FOR KEY SHARE`로 읽는다** → FK가 잡던 락을 **정확히 같은
  등급으로** 손으로 잡는 것이다. PG에서는 이 선택지가 MySQL보다 훨씬
  매력적이다 — `FOR KEY SHARE`는 부모의 `comment_count` UPDATE
  (`FOR NO KEY UPDATE`)를 **막지 않아** 경합이 거의 없다. 주의: **JPA
  `@Lock`에는 이 등급이 없다** — `PESSIMISTIC_READ`는 한 등급 센
  `FOR SHARE`로 나가 부모의 일반 UPDATE까지 막는다.

```java
// FK 가 하던 것과 정확히 같은 락 — JPA @Lock 으로는 표현되지 않는다
@Query(value = "SELECT id FROM posts WHERE id = :id AND deleted_at IS NULL FOR KEY SHARE",
       nativeQuery = true)
Optional<Long> lockParentForKeyShare(@Param("id") Long id);
// @Lock(PESSIMISTIC_READ)  → FOR SHARE   (부모의 비-키 UPDATE 까지 막는다 — 과하다)
// @Lock(PESSIMISTIC_WRITE) → FOR UPDATE  (2-1 의 사슬을 손으로 만드는 셈 — 쓰지 않는다)
```

- **틈을 인정하고 4-4의 배치가 잡게 한다** → 가장 흔한 현실적 답.
  "0건 보장"이 아니라 "N시간 내 발견"이라는 등급으로 내려온 것을
  인지하고 말한다.

삭제 쪽도 같다.

```java
// ❌ before: "자식 있나" 확인 후 삭제 — 확인과 삭제 사이에 자식이 들어오면 고아
@Transactional
public void deletePost(Long postId) {
    if (commentRepository.existsByPostId(postId)) {
        throw new PostHasCommentsException(postId);
    }
    postRepository.deleteById(postId);   // 물리 삭제. 이 사이에 addComment 가 끼면 고아
}
```

```java
// ✅ after: 물리 삭제 대신 soft delete — 자식이 가리키는 행이 사라지지 않는다
@Transactional
public void deletePost(Long postId) {
    Post post = postRepository.findActiveById(postId)
        .orElseThrow(() -> new PostNotFoundException(postId));
    post.markDeleted(clock.now());       // UPDATE posts SET deleted_at = $1 WHERE id = $2
    // 자식 정책은 명시적으로: 댓글도 함께 soft delete 할지, 남길지 — 도메인 규칙으로
    commentRepository.softDeleteAllByPostId(postId);
}
```

> PG 각주: `deleted_at`을 인덱스(부분·복합)에 넣었다면 그 컬럼을 바꾸는
> UPDATE는 HOT에서 탈락해 **그 테이블의 모든 인덱스에 새 엔트리**를 꽂는다.
> 소프트 삭제를 대체 체계의 축으로 삼는다면 이 쓰기 증폭도 계산에 넣는다.

### 4-2. ② 삭제는 소프트 삭제/아카이브로 — 고아가 생기는 조건을 없앤다

고아 행은 "부모가 사라질 때" 생긴다. 부모가 사라지지 않으면 — `deleted_at`만
찍히면 — **참조 무결성은 FK 없이도 물리적으로 깨질 수 없다.** FK를 빼는 팀이
거의 예외 없이 soft delete를 함께 택하는 이유다.

대신 두 가지를 짊어진다. 첫째,
[soft delete 문서](../03-jpa-orm/26-soft-delete-unique-and-associations.md)
§6-3에서 본 대로 **"삭제된 부모를 가리키는 살아 있는 자식"이라는 논리적
고아**가 새로 생기고, 이건 FK가 있어도 못 막는다 — 도메인 규칙으로 정해야
한다. 둘째, 언젠가 **아카이브로 이동**해야 하는데 그 이동이 2-3절의 순서
제약을 다시 만난다 — 다만 FK가 없으니 자식·부모를 독립적으로 옮길 수 있고,
"옮긴 뒤 고아가 없는지"는 4-4의 배치가 검증한다. (PG라면 이동은
`WITH moved AS (DELETE … RETURNING *) INSERT …`로 원자화할 수 있고, 아카이브
대상이 통째로 파티션이면 `DETACH`/`DROP`이 더 싸다 —
[대량 삭제 문서](25-mass-delete-archiving-and-partitioning.md).)

### 4-3. ③ FK 컬럼 인덱스 강제 — 사람 기억이 아니라 린트로

**PG에서 이 항목은 "FK를 뺐을 때의 대체 체계"가 아니라 상시 필수다**(2-2) —
FK가 있어도 인덱스는 안 생기기 때문이다. 그래서 린트를 두 벌 둔다: 물리 FK는
카탈로그로 정확히, 논리적 FK는 이름 규약으로 근사하게.

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
-- ⑵ 논리적 FK(제약 없음): 카탈로그 근거가 없으니 이름 규약으로 훑는다 — 3-4 의 대가
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

마이그레이션이 적용된 테스트 DB(Testcontainers의 PostgreSQL)에서 두 쿼리가
한 행이라도 돌려주면 빌드를 깨뜨린다. 예외는 허용 목록으로 관리하고
**"넣으려면 PR에 이유를 적는다"**가 곧 리뷰 게이트가 된다. 덧붙일 둘 —
ⓐ 운영에서는 반드시 `CREATE INDEX CONCURRENTLY`(트랜잭션 블록 안에서는 불가,
실패하면 `INVALID` 인덱스가 남으므로 `pg_index.indisvalid` 확인 후 DROP·재시도),
ⓑ **FK 컬럼과 그 인덱스에는 부모 PK 값이 그대로 들어가므로** PK를 UUID로
잡으면 비용이 여기서 청구된다
([클러스터드 vs 세컨더리 문서](03-clustered-vs-secondary-index.md)).

### 4-4. ④ 고아 행 탐지 배치 + 알람 — 발견 지연을 시간 단위로 묶는다

FK가 "생성 시점 0건"을 보장했다면, 배치는 **"N시간 안에 발견하고 사람을
부른다"** 를 보장한다 — 어긋남을 전제로 한 안전망이다.

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

운영 규칙까지 세트다.

- **주기**: 핵심 관계(주문–회원, 결제–주문)는 시간 단위, 나머지는 일
  단위. 배치 자체가 부하가 되면 안 되므로 레플리카에서, 청크로, 야간에.
  다만 **레플리카에서 오래 도는 쿼리는 PG에서 공짜가 아니다** —
  `max_standby_streaming_delay`를 넘기면 쿼리가 취소되고
  (`canceling statement due to conflict with recovery`),
  `hot_standby_feedback = on`으로 막으면 그 대가가 프라이머리의 VACUUM
  지연(=bloat)으로 넘어간다. 청크를 짧게 끊고 `SET LOCAL statement_timeout`
  을 걸어 두는 이유가 여기에 있다.
- **결과 처리**: 0건이 아니면 **알람**(Slack·페이저) → 자동 삭제가 아니라
  **격리 테이블로 이동 + 원인 경로 추적**. 자동 삭제는 "부모가 다른 경로로
  옮겨진 정상 데이터"를 지울 수 있다.
- **지표화**: 고아 건수를 시계열 지표로 남기면 "어느 배포 이후 늘었다"가
  보인다 — 3-1의 "새 코드 경로"를 잡는 유일한 방법이다.
- **커버리지 목록**: 검사하는 관계를 목록으로 관리하고, 새 `*_id` 컬럼이
  생기면 4-3의 린트가 "탐지 목록에도 추가했나"를 함께 묻게 한다. FK가
  없으면 이 목록을 카탈로그에서 자동 생성할 수 없다는 것(3-4)이 이 항목의
  상시 리스크다.

```java
@Scheduled(cron = "0 15 * * * *")                  // 매시 15분
public void detectOrphanComments() {
    long count = orphanScanner.scanInChunks("comments", "post_id", "posts", "id");
    orphanGauge.set("comments.post_id", count);    // 시계열 지표
    if (count > 0) alert.page("orphan rows: comments.post_id -> posts.id = " + count);
}
```

### 4-5. ⑤ 소프트 참조 규약 + 스키마 문서화 — 잃어버린 "문서로서의 스키마"를 되찾기

**소프트 참조(soft reference) 규약**: 물리 FK 대신 팀이 지키는 이름·타입
규칙이다.

- 참조 컬럼은 `<부모단수>_id`, 타입은 부모 PK와 동일(`bigint` ↔ `bigint`).
  다르면 컬럼 쪽에 캐스트가 붙어 인덱스를 못 타거나 아예
  `operator does not exist` 에러가 난다
  ([풀스캔 원인 문서](02-index-not-used-full-scan.md)).
- `COMMENT ON COLUMN`으로 대상을 명시한다 — 도구가 읽고 사람이 읽는다.
- 서비스 경계를 넘는 참조는 코드에서도 `@ManyToOne Member`가 아니라
  **`Long memberId`** 로 둔다 — "DB가 지켜주지 않는 참조"임이 타입에 드러난다.

```sql
CREATE TABLE orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    member_id  bigint NOT NULL,                  -- 논리적 FK
    amount     numeric(19, 2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_member_id ON orders (member_id);   -- 4-3: 손으로 만든다

COMMENT ON COLUMN orders.member_id IS 'FK(logical) -> members.id — 회원 서비스 소유';
COMMENT ON TABLE  orders           IS '주문. 물리 FK 미사용 — 고아 탐지 배치 orphan-check.orders 참조';
```

**ERD 도구**: 물리 FK가 없어도 이름 규약으로 관계를 추론해 그려주는 도구
(SchemaSpy의 implied relationship, dbdocs 류)를 CI에 붙여 문서를 자동
생성한다. 손으로 그린 ERD는 반드시 낡는다.

### 4-6. ⑥ 테스트·스테이징에서만 FK 켜기 — 선택지와 그 대가 (가산점 포인트)

운영에는 FK가 없지만 **테스트 DB에는 FK를 건다.** 4-1의 검증을 빠뜨린 새
코드 경로가 통합 테스트에서 FK 위반 예외로 **즉시 드러난다.**

```sql
-- src/test/resources/db/testonly/R__fk_constraints.sql  (테스트 프로파일에서만 적용)
ALTER TABLE comments ADD CONSTRAINT fk_comments_post
    FOREIGN KEY (post_id) REFERENCES posts (id);
ALTER TABLE orders   ADD CONSTRAINT fk_orders_member
    FOREIGN KEY (member_id) REFERENCES members (id);
```

(`application-test.yml`에서 `spring.flyway.locations`에 `classpath:db/testonly`
를 덧붙여 테스트 프로파일에서만 적용되게 한다.)

대가도 같이 말한다. ⑴ **테스트와 운영의 락 동작이 달라진다** — 테스트에서만
부모에 `FOR KEY SHARE`가 잡히므로 2-1의 대기·데드락이 한쪽에서만 난다.
⑵ 픽스처 정리(`TRUNCATE`) 순서가 FK에 묶인다(PG는 `TRUNCATE … CASCADE`나
여러 테이블 나열로 푼다). ⑶ 스테이징에 FK를 두면 운영 데이터를 복제해 넣을
때 기존 고아 때문에 적재가 실패한다 — 그 실패가 오히려 고아를 발견하는
계기가 되기도 한다.

### 4-7. ⑦ JPA — 객체 매핑과 물리 제약은 별개다

JPA의 `@ManyToOne`은 **객체 참조를 어떻게 로딩할지**에 대한 선언이고,
DB의 FK 제약과는 독립이다. 그런데 Hibernate가 DDL을 생성하면(`ddl-auto`)
`@JoinColumn`마다 **FK 제약을 기본으로 만든다.** 여기서 두 가지 사고가
난다.

```java
// ❌ before: 팀 규칙은 "운영 DB 에 FK 없음"인데, 매핑은 FK 를 만든다
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
// ✅ after: 매핑은 유지하되 "물리 FK 를 만들지 마라"를 명시한다
@Entity
public class Comment {
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(
        name = "post_id",
        foreignKey = @ForeignKey(ConstraintMode.NO_CONSTRAINT)   // DDL 생성 시 FK 제약 생략
    )
    private Post post;
}

// 서비스 경계를 넘거나 애초에 객체 그래프가 필요 없는 참조는 ID 만 든다 (4-5 소프트 참조)
@Entity
public class Order {
    @Column(name = "member_id", nullable = false)
    private Long memberId;                   // 타입 자체가 "DB 가 지켜주지 않는 참조"라고 말한다
}
```

운영에서는 스키마를 마이그레이션 도구가 소유한다 — `ddl-auto: none`.
(`validate`도 가능하지만 테이블·컬럼·타입만 보고 **FK 유무는 검사하지
않으므로** "FK 없는 운영 스키마"를 잡아주지 않는다.)

`NO_CONSTRAINT`로 물리 FK가 없어도 `@ManyToOne` 지연 로딩·조인은 그대로
동작한다. 단, **부모가 없는 자식을 로딩하면 프록시 초기화 시점에
`EntityNotFoundException`** 이 난다 — 고아 행이 있는 운영 DB에서 JPA가
먼저 비명을 지르는 지점이고, 4-4 배치가 있으면 그 전에 잡힌다.

---

## 5. 본인의 견해 — "우리 서비스의 조건"으로 결론 내기

### 5-1. 판단 기준 6축

"FK 건다/안 건다"는 팀의 신념이 아니라 아래 여섯 축의 답으로 정해진다.
PG 기준으로 축의 내용이 달라진다는 것까지 말하면 좋다.

| 축 | 질문 (PG 기준) | FK 유지 쪽 | FK 제거 쪽 |
|---|---|---|---|
| ① 핫 부모 + 명시적 락 | 부모를 `FOR UPDATE`로 잡는 경로가 있는가 | 없다 (또는 `FOR NO KEY UPDATE`로 낮출 수 있다) | 있고 못 바꾼다 → 2-1 사슬 |
| ② 스키마 변경 규모 | 수억 건 테이블에 `SHARE ROW EXCLUSIVE` 창을 못 내는가 | `NOT VALID` + `VALIDATE`로 충분 | 그마저 어려운 규모·트래픽 |
| ③ 분산 계획 | 샤딩·서비스 분리가 로드맵에 있는가 (파티셔닝은 해당 없음) | 없다 | 있다 → 어차피 불가 |
| ④ 삭제 정책 | 부모를 물리 삭제하는가 | 그렇다 → FK가 막아줘야 | soft delete → 고아 조건 자체가 없음 |
| ⑤ 데이터 민감도 | 돈·법적 근거·개인정보인가 | 그렇다 → 방어선 필요 | 로그·집계·파생 데이터 |
| ⑥ 팀 규율·도구 | 4장 체계를 운영할 배치 인프라·CI 린트·리뷰 문화가 있는가 | 없다 → 빼면 방치 | 있다 |

⑥이 결정적이다. **①~⑤가 전부 "제거"를 가리켜도 ⑥이 없으면 빼지
않는다** — 대체 체계 없이 FK만 빼는 것은 트레이드오프가 아니라 손실만
받아들인 것이기 때문이다. 그리고 **PG에서는 ①과 ②가 약한 근거**라는 점을
덧붙인다(2-8): ①은 락 등급을 낮추면 대개 사라지고 ②는
`NOT VALID`/`VALIDATE`로 깎인다. 반대로 **어느 쪽을 고르든 4-3(FK 컬럼
인덱스)은 무조건 한다.**

### 5-2. 결론은 세 갈래다 — 그리고 PG에서 기본값은 더 강하게 "건다"

**내 견해: 기본값은 FK를 건다. PG에서는 반대 논거의 절반이 엔진 차이나 내장
도구로 깎이므로 이 기본값이 더 강해진다. 빼는 것은 위 조건이 확인된
예외이며, 빼는 순간 4장의 일곱 가지가 세트로 따라온다.**

- **걸어라** — 단일 DB, 중간 이하 쓰기 부하, 작은 팀, 물리 삭제가 있는
  도메인. 여기서 FK의 비용(부모 유니크 인덱스 탐색 한 번 + 가장 약한 등급의
  행 락)은 4장 체계의 운영 비용보다 훨씬 싸다. 단 두 가지를 함께 한다 —
  **`CASCADE` 대신 `RESTRICT`/`NO ACTION`으로 파급을 코드에 드러내고,
  자식 FK 컬럼 인덱스를 반드시 만든다.**
- **선택적으로 걸어라** — 대부분의 중규모 서비스가 여기다. 원장성 관계
  (결제 → 주문, 정산 → 결제)에는 FK를 유지하고, 고빈도·로그성 자식(알림,
  이력, 이벤트 로그)과 부모를 `FOR UPDATE`로 잡는 관계에는 빼고 4장 체계를
  붙인다. 서비스 경계를 넘는 참조는 무조건 소프트 참조다. **"테이블마다
  판단한다"가 가장 성숙한 답이다.**
- **빼라** — 샤딩·서비스 분리가 이미 있거나 확정, 적재 파이프라인이 병렬로
  붓는 구조, 4장을 이미 운영하는 팀. 이 팀은 FK를 빼는 것이 아니라 **FK가
  하던 일을 다른 자리(앱·배치·CI)에서 하고 있는 것**이다.

### 5-3. 면접에서 말하는 순서

> "이유는 일곱 가지로 정리되는데 PostgreSQL 기준으로는 순서가 달라집니다.
> 1순위는 **락이 아니라 인덱스**입니다 — PG는 자식 FK 컬럼 인덱스를 자동으로
> 만들어 주지 않아 부모를 지울 때마다 자식이 Seq Scan이 되고,
> `EXPLAIN ANALYZE`의 `Trigger` 줄에 시간이 다 찍히는 걸로 확인합니다.
> 둘째는 운영 — `ADD FOREIGN KEY`가 두 테이블에 `SHARE ROW EXCLUSIVE`를 잡고
> 전체를 검증하며, 적재·아카이빙에 순서가 강제됩니다. 셋째는 지형 — 샤딩·
> 서비스 분리에서는 FK가 정의 자체가 안 됩니다. 솔직히 대규모 회사의 관행이
> 전파된 몫도 큽니다.
>
> 그런데 흔히 인용되는 **락 논거는 PG에 그대로 옮기면 틀립니다.** MySQL은
> 자식 INSERT의 공유 락과 부모 카운터 UPDATE의 배타 락이 교차해 데드락이
> 나는데, PG에서 자식 INSERT가 잡는 건 `FOR KEY SHARE`이고 키가 아닌 컬럼만
> 바꾸는 UPDATE는 `FOR NO KEY UPDATE`라 **둘이 호환**됩니다. 그 데드락이
> 살아나는 건 코드가 부모를 `FOR UPDATE`(JPA `PESSIMISTIC_WRITE`)로 잡을
> 때뿐이고, 그건 락 등급을 낮춰 해결하는 게 먼저입니다.
>
> 대신 잃는 것도 분명합니다. 최후 방어선, 고아 0건 보장, `\d` 한 줄로 관계가
> 보이는 문서성, 그리고 PG에서 특히 아픈 것 — **'이 컬럼은 참조 컬럼'이라는
> 카탈로그 근거**가 사라져 인덱스 린트와 고아 탐지 목록이 이름 규약에 얹히게
> 되는 겁니다.
>
> 제 견해는 기본값은 건다, 이고 PG에서는 더 강합니다. 인덱스는
> `CREATE INDEX CONCURRENTLY`, DDL 잠금은 `NOT VALID` 뒤
> `VALIDATE CONSTRAINT`, 적재 순서는 `DEFERRABLE INITIALLY DEFERRED`나
> `session_replication_role`로 깎이니 정말 남는 이유는 분산 계획 하나입니다.
> 빼기로 했다면 앱 레벨 존재 검증, 소프트 삭제, FK 컬럼 인덱스 CI 린트,
> 고아 탐지 배치와 알람, 소프트 참조 규약과 문서화, 테스트 환경 FK,
> JPA `NO_CONSTRAINT`까지 세트로 갑니다. 현실적으론 테이블마다 판단해서
> 원장성 관계엔 걸고 고빈도·로그성 관계와 서비스 경계를 넘는 참조엔 빼는
> 구성이 가장 많습니다."

---

## 6. 꼬리질문 대비 포인트

### "FK가 락을 잡는다고 했는데, PostgreSQL에서는 정확히 어떤 락이 어디에 걸리나요?"

자식 `INSERT`(또는 FK 컬럼 UPDATE)는 **부모 행에 `FOR KEY SHARE`** 를 잡고
트랜잭션 끝까지 유지한다. PG의 행 락 네 등급 중 가장 약한 것으로 "이 행의
키를 바꾸거나 지우지 마라"는 뜻이다. 그래서
`UPDATE posts SET comment_count = comment_count + 1`처럼 **키가 아닌 컬럼만
바꾸는 UPDATE(= `FOR NO KEY UPDATE`)와는 충돌하지 않는다** — InnoDB에서
데드락을 만들던 조합이 PG에서는 그냥 통과한다. 충돌하는 것은
`SELECT … FOR UPDATE`(JPA `PESSIMISTIC_WRITE`)와 부모 키 UPDATE·DELETE
뿐이고, 그 경로가 있으면 그 부모를 참조하는 **자식 INSERT 전부가 줄을
선다.** 덧붙일 셋 — ① 락은 별도 락 테이블이 아니라 **튜플 헤더 `xmax`에
기록**되므로 부모 페이지가 더러워지고 WAL이 쓰인다(자식 INSERT가 부모
테이블에도 쓰기 부하를 만든다), ② 같은 부모를 여러 트랜잭션이 동시에
공유 락으로 잡으면 `xmax`에 **multixact**가 생겨 비용이 붙는다, ③ 부모
DELETE 쪽에서는 **자식 행에** `FOR KEY SHARE`가 걸리는데, 그 자식을 찾는
스캔이 인덱스 없이 돌면 그게 진짜 사고다.

### "PostgreSQL에서 FK를 걸었더니 부모 DELETE가 갑자기 느려졌습니다. 무엇부터 보나요?"

**자식 FK 컬럼의 인덱스부터 본다. PG는 그걸 자동으로 만들어 주지 않는다.**
부모를 지울 때마다 검사 트리거 안에서
`SELECT 1 FROM 자식 WHERE fk_col = $1 FOR KEY SHARE`가 **Seq Scan**으로 돈다.
확진은 `BEGIN; EXPLAIN (ANALYZE, BUFFERS) DELETE …; ROLLBACK;` — 계획 트리에는
안 보이고 **`Trigger …: time=… calls=…` 줄**에 시간이 전부 찍혀 있으면
그것이다. 처방은 `CREATE INDEX CONCURRENTLY`, 상시 감시는
`pg_stat_user_tables.seq_scan` 증가. 이 함정이 `ON DELETE CASCADE`에서는
**부모 행 수만큼 곱해진다**는 것까지 말한다.

### "앱에서 부모 존재를 확인하고 INSERT하면 FK와 같은 것 아닌가요?"

같지 않다 — 두 가지가 빠진다. ⑴ **레이스 조건**: 확인과 INSERT 사이에
다른 트랜잭션이 부모를 물리 삭제하면 고아가 생긴다. FK의 `FOR KEY SHARE`가
정확히 이 틈을 막던 장치다. 손으로 같은 수준을 만들려면 부모를
`SELECT … FOR KEY SHARE`로 읽으면 되고, **PG에서는 이게 MySQL보다 훨씬 쓸
만하다** — 이 등급은 부모의 일반 UPDATE를 막지 않아 경합이 거의 없다. 다만
**JPA `@Lock`에는 이 등급이 없어**(`PESSIMISTIC_READ`는 한 등급 센
`FOR SHARE`) 네이티브 쿼리로 내려 써야 한다. ⑵ **경로 커버리지**: 앱 검증은
앱을 거치는 경로만 지킨다 — psql `DELETE`, 보정 스크립트, `COPY` 적재,
검증을 빠뜨린 새 API는 못 막는다. 그래서 진입점을 도메인 서비스 한 곳으로
모으고 테스트 환경에선 FK를 켠다. 현실적 결론은 보장 등급이 **"생성 시
0건"에서 "발견 지연 N시간"으로 내려왔음을 인지하고 말하는 것**이다.

### "FK를 안 걸었을 때 팀이 가장 흔히 놓치는 게 뭔가요?"

**인덱스다 — 그런데 PostgreSQL에서는 이유가 한 겹 더 깊다.** MySQL이라면
"FK가 만들어 주던 인덱스가 함께 사라져서"인데, PG는 애초에 만들어 주지
않으므로 **FK를 걸든 안 걸든 인덱스를 잊는다.** 진짜로 잃는 것은
`pg_constraint`라는 **카탈로그 근거**다 — FK가 있으면 "인덱스 없는 FK
컬럼"을 카탈로그 쿼리로 정확히 뽑아 CI에서 빌드를 깨뜨릴 수 있지만, 빼면
근거가 `%_id`라는 이름 규약뿐이라 규약을 안 지킨 컬럼이 조용히 샌다. 처방은
"잊지 말자"가 아니라 **린트 두 벌**(카탈로그용 + 이름 규약용)이고 예외는
허용 목록 + PR 사유로 관리한다. 두 번째로 자주 놓치는 것은 **고아 탐지
배치의 커버리지 목록**인데, 이것도 FK가 있었으면 카탈로그에서 자동
생성됐을 목록이다.

### "MSA로 분리된 서비스 간 참조는 어떻게 정합성을 지키나요?"

DB가 다르므로 FK는 선택지에 없고(`postgres_fdw`로 원격 테이블을 붙여도 FK는
걸리지 않는다), 참조는 **계약**으로만 지켜진다. ⑴ 코드에서는 `Long memberId`
로 든다 — "DB가 지켜주지 않는 참조"임이 타입에 드러난다. ⑵ 생성 시 상대
서비스에 존재를 묻거나(동기 API — 결합·지연 대가), 상대가 발행한 이벤트로
만든 **로컬 사본**을 참조한다(최종적 일관성 대가). PG라면 그 이벤트 발행이
**transactional outbox + 논리 디코딩 CDC**(Debezium pgoutput)로 트랜잭션과
원자적으로 묶인다. ⑶ 상대가 삭제되면 이벤트로 통보받아 로컬 자식을 처리하고,
이벤트 유실을 전제로 **주기적 대사(reconciliation) 배치**가 두 서비스의 ID
집합을 맞춰 본다 — 단일 DB의 "고아 탐지 배치"가 서비스 간에서는 "대사 배치"가
되는 것이고,
["결제됐는데 주문이 없다" 사고](27-payment-succeeded-order-missing-incident.md)의
Outbox·대사와 같은 도구 상자다.

### "그럼 나중에 FK를 다시 걸 수 있나요? 이미 고아가 있으면요?" (시니어 변별 포인트)

**PostgreSQL은 MySQL보다 나은 답을 갖고 있다 — 하지만 절반만 낫다.**
⑴ **DDL 비용은 해결된다**: 그냥 `ADD FOREIGN KEY`는 두 테이블에
`SHARE ROW EXCLUSIVE`를 잡고 자식 전체를 검증해 쓰기를 막지만,
`ADD CONSTRAINT … NOT VALID`로 걸면 검증 스캔 없이 짧은 락으로 끝나고
**그 순간부터 새로 들어오는 행은 검사된다.** 기존 데이터는 나중에
`VALIDATE CONSTRAINT`(`SHARE UPDATE EXCLUSIVE` — 읽기·쓰기를 안 막는다)로
따로 검증하고, 여기에 `SET lock_timeout = '2s'` + 재시도를 반드시 씌운다
(락 대기가 뒤따르는 모든 쿼리를 줄 세우는 것이 PG DDL 사고의 정석 경로다).
⑵ **기존 고아는 해결되지 않는다**: `VALIDATE CONSTRAINT`는 위반이 한 행만
있어도 실패한다. 4-4의 탐지 쿼리로 고아를 찾아 격리·정리하는 데이터 정비가
선행돼야 하고 이게 몇 주짜리 프로젝트가 되곤 한다. `NOT VALID`인 채로
방치하는 것은 **"새 쓰기만 검사되는 반쪽 제약"**이고,
`session_replication_role = replica`로 우회해 부은 데이터도 소급 검사되지
않는다 — 방어선이 아니라 거짓 안심이다. 결론 — MySQL에서는 "FK는 나중에
걸면 된다"가 사실상 거짓이지만, **PG에서는 "DDL은 나중에 걸 수 있다,
데이터 정비는 나중에도 어렵다"**가 정확한 답이다.

### "결제·정산처럼 돈이 걸린 테이블도 FK를 빼나요?" (시니어 변별 포인트)

여기서 "우리 팀은 FK 안 겁니다"로 일괄 답하면 탈락이다. 판단 축 ⑤(데이터
민감도)가 다른 축을 누른다 — **원장성 관계(결제 → 주문, 정산 → 결제)는
고아 한 건이 곧 돈의 불일치**이고, "N시간 내 발견"이 아니라 "생성 시 0건"이
필요하다. 이 관계는 핫 부모도 아니고, 샤딩하더라도 주문과 결제는 같은 샤드
키로 묶는 것이 정석이라 FK 제거의 이유 ①⑤가 해당되지 않는다. 따라서
**원장성 관계에는 FK를 유지하고, 그 위에 고아 탐지가 아니라 금액 대사 배치를
얹는다.** PG라면 둘을 더 붙인다 — 결제 DB에서는 `synchronous_commit`을 끄지
않고, 멱등키에 `UNIQUE` + `INSERT … ON CONFLICT DO NOTHING RETURNING`으로
중복 처리를 DB가 막게 한다. 같은 시스템 안에서도 알림·이력 테이블은 FK를
빼는 — **"테이블마다 판단"이 이 질문의 정답 형태**다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **FK 컬럼 인덱스** — MySQL(InnoDB)은 FK를 만들 때 자식 FK
컬럼 인덱스를 자동 생성하지만 **PG는 하지 않는다.** PG FK 사고의 1순위가
여기서 나오고, 반대로 "FK를 빼면 인덱스도 사라진다"는 MySQL식 경고는 PG에
적용되지 않는다. ② **락 등급** — InnoDB는 자식 INSERT의 공유(S) 락과 부모
카운터 UPDATE의 배타(X) 락 조합만으로 데드락이 나고 READ COMMITTED로 낮춰도
FK 검사의 갭 락이 남지만, PG는 `FOR KEY SHARE` ↔ `FOR NO KEY UPDATE`가
호환이라 그 데드락이 없고 갭 락 개념 자체가 없다. ③ **스키마 변경** —
MySQL은 gh-ost가 FK 테이블을 못 다루고 `ADD FOREIGN KEY`가 COPY라 **도구
선택지** 문제가 되지만, PG는 `NOT VALID` → `VALIDATE`라는 정식 우회로가 엔진
안에 있다. ④ **검사 시점** — PG는 `DEFERRABLE INITIALLY DEFERRED`로 커밋까지
미룰 수 있고(`RESTRICT`는 못 미룬다), MySQL은 즉시 검사만 있다.
⑤ **파티셔닝과 캐스케이드** — MySQL 파티션 테이블은 FK 미지원이라
"파티셔닝 = FK 제거"가 강제되지만 PG는 지원하고, 캐스케이드 삭제도 MySQL은
자식 트리거를 발동시키지 않는 반면 PG는 발동시킨다.

---

## 한 줄 요약

**FK는 "가리키는 곳이 반드시 있다"를 어떤 경로로 와도 강제하는 최후
방어선이고, PostgreSQL에서 그 대가는 자식 INSERT마다 부모 행에 커밋까지 쥐는
`FOR KEY SHARE`(겹치면 multixact) · **자식 FK 컬럼 인덱스를 자동 생성하지
않아 부모 DELETE가 자식 Seq Scan이 되는 것(PG 사고 1순위, `EXPLAIN ANALYZE`의
`Trigger` 줄로 확진)** · `ADD FOREIGN KEY`의 `SHARE ROW EXCLUSIVE` + 전체
검증 · 적재·아카이빙의 순서 제약 · 샤딩·분리에서의 성립 불가 · CASCADE가
남기는 죽은 튜플과 WAL이다. 반대로 InnoDB의 고전 데드락(자식 INSERT의 S 락 ↔
부모 카운터 UPDATE의 X 락)은 PG에서 나지 않는다 — `FOR NO KEY UPDATE`가
`FOR KEY SHARE`와 호환이라, 그 사슬은 코드가 부모를 `FOR UPDATE`로 잡을 때만
살아난다. 빼면 최후 방어선·고아 0건 보장·문서로서의 스키마·**참조 컬럼이라는
카탈로그 근거**를 잃는다. 그래서 기본값은 걸고(PG는 인덱스 ·
`FOR NO KEY UPDATE` · `NOT VALID`+`VALIDATE` · `DEFERRABLE` ·
`session_replication_role`로 반대 논거의 절반을 깎으므로 기본값이 더 강하다),
빼는 것은 분산 계획 같은 조건이 확인된 예외로 다루며, 빼는 순간 앱 레벨 존재
검증(+`FOR KEY SHARE`) + 소프트 삭제 + FK 컬럼 인덱스 린트 + 고아 탐지 배치와
알람 + 소프트 참조 규약·문서화 + 테스트 환경 FK + JPA `NO_CONSTRAINT`가 한
세트로 따라와야 한다 — 대체 체계 없이 FK만 빼는 것은 결정이 아니라 방치다.**
