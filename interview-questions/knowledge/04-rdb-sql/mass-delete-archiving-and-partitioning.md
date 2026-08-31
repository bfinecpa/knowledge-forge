# 수억 건 삭제/아카이빙 — `DELETE` 한 방이 장애가 되는 다섯 사슬과, 청크 · 파티션 DROP · 복사 후 RENAME이 각각 지불하는 값

> 핵심 관전 포인트: **수억 건 테이블에 `DELETE ... WHERE created_at < ?`
> 한 방은 "느린 쿼리"가 아니라 자원 다섯 개에서 동시에 출발하는 장애다 —
> ① 거대 트랜잭션의 undo 폭증(+ 중간에 KILL하면 롤백이 원 작업만큼,
> 혹은 더 오래) ② 커밋까지 쥐는 행 락·갭 락 → 대기 → 커넥션 풀 고갈
> ③ 커밋 순간의 거대 binlog 덩어리 → 복제본이 단일 트랜잭션으로 재생 →
> 읽기 복제본 stale ④ 세컨더리 인덱스마다 흩어진 엔트리 삭제 = 랜덤
> I/O로 버퍼 풀 오염 ⑤ 다 지워도 `.ibd`는 안 줄어드는 공간 미반환.
> 그래서 답은 접근법 3종을 조건에 따라 고르는 것이다 — **청크 삭제**
> (지금 당장 가능하지만 총 시간·총 I/O가 크고 공간은 안 돌아옴) /
> **파티션 DROP**(즉시·저비용이지만 사전 파티셔닝 필요, 파티션 키가
> PK·모든 유니크 키에 포함돼야 하는 제약, 조회에 프루닝 조건 필요,
> FK 불가) / **남길 것만 복사 후 RENAME**(공간 완전 회수·인덱스
> 재구축이지만 복사 중 쓰기 델타·디스크 2배). 어느 쪽이든 **삭제 전
> 아카이브 검증(건수·체크섬) → 드라이런 → 복제 지연 임계 시 스스로
> 멈추는 청크 루프 → 파티션 자동 생성·드랍 스케줄러 → 보존 정책
> (retention)을 테이블 설계 시점에 고정**을 사람의 기억이 아니라 코드로
> 박는다.**

---

## 0. 질문 + 의도

**질문**: "수억 건 테이블에서 특정 기간 데이터를 삭제/아카이빙해야
합니다. 어떻게 접근하겠습니까? (파티셔닝 포함)"

**출제 의도**: rationale은 이렇게 적고 있다 — "DELETE 한 방이 undo
폭증·복제 지연·락으로 장애가 되는 것을 아는지. **'작업을 운영에 안전하게
수행하는 방법'(청크 분할, 파티션 드랍) 자체가 시니어의 기술**임을
확인한다." 즉 이 문항의 채점 지점은 SQL 문법이 아니다. ⑴ 왜 위험한지를
**자원별 메커니즘**으로 말할 수 있는가 ⑵ 선택지마다 **무엇을 지불하는지**
아는가 ⑶ 그 절차를 담당자의 주의력이 아니라 **코드와 스키마가 지키게**
만들어 봤는가. 고난이도 문항이므로 트레이드오프 서술 자체가 평가 대상이다
— "청크로 나눠서 지웁니다"까지는 누구나 말하고, "청크로 나누면 대신
무엇이 나빠지는가"에서 갈린다.

> 이 문서는 후보자의 횡단 약점 4가지를 겨냥해 구성했다 — ① 비용·인과를
> **자원별 사슬**로 말하기(1장) ② 접근법 3종 각각의 **대가를 양면으로**
> 조립하기(2장) ③ 안전망을 **코드·스키마로 고정**하기(4장) ④ "접근법 3종
> 비교표"와 "청크 루프 필수 요소 9가지"를 **목록으로 인출**하기(2-0절 ·
> 3-0절).

> 역할 구분:
> - [long-transaction-harm-and-shortening.md](./long-transaction-harm-and-shortening.md)는
>   긴 트랜잭션의 **일반론**(네 사슬)이다. 이 문서의 1장은 그 사슬이 "대량
>   DELETE"라는 특정 작업에서 어떤 모습으로 나타나는지에 더해, 그 문서에
>   없는 **인덱스 랜덤 I/O**와 **공간 미반환** 두 사슬을 추가한다.
> - [online-ddl-zero-downtime-schema-change.md](./online-ddl-zero-downtime-schema-change.md)는
>   **스키마 변경**의 무중단이다. 파티셔닝 도입·`OPTIMIZE TABLE`·
>   `DROP PARTITION`은 전부 DDL이라 그쪽의 MDL 사슬이 그대로 적용된다.
> - [bulk-operation-persistence-context.md](../03-jpa-orm/bulk-operation-persistence-context.md)는
>   JPQL 벌크 연산과 영속성 컨텍스트의 불일치를 다룬다. 이 문서의 삭제
>   루프가 JPA를 거치지 않고 JDBC로 내려가는 이유가 거기 있다.
> - 이 문서는 **대량 삭제를 운영 중인 DB에서 안전하게 실행하는 절차**를
>   담당한다.

---

## 1. 왜 `DELETE ... WHERE created_at < ?` 한 방이 장애가 되는가 — 자원별 다섯 사슬

```sql
-- "3개월 지난 조회 로그 지워주세요" 티켓을 받고 새벽에 실행한 한 줄
DELETE FROM episode_view_log
 WHERE created_at < DATE_SUB(NOW(), INTERVAL 3 MONTH);   -- 대상 약 2억 건
```

"오래 걸린다"가 답이 아니다. 이 한 문장은 **하나의 트랜잭션**으로 2억 행을
지우며, 그동안 아래 다섯 자원을 동시에 점유·소모한다. 면접에서는 A → B → C
순으로 말하고, D·E는 "그리고 다 끝나도"로 붙인다. 각 사슬은 "무슨 자원이
→ 어떻게 쌓여 → 누구의 무엇이 → 왜 죽는가"까지 간다.

### 1-1. 사슬 A — undo: 트랜잭션 크기에 비례해 자라고, 중단하면 더 오래 걸린다

등장인물부터. **undo 로그**는 롤백과 MVCC의 과거 버전을 위해 "변경 전
상태"를 기록하는 영역이다([mvcc-innodb.md](./mvcc-innodb.md) 2-2). 행 하나를
지울 때 InnoDB는 행을 즉시 제거하지 않고 **delete-mark**(삭제 표시)를 찍고
undo 레코드를 하나 남긴다. 물리 제거는 나중에 purge 스레드가 한다.

> ⑴ 2억 행 × undo 레코드 → undo 테이블스페이스가 수 GB~수십 GB로
> 팽창한다. 커밋 전까지는 하나도 지울 수 없다 — 자기 자신의 롤백 재료라서.
> ⑵ 그사이 이 트랜잭션은 시스템에서 **가장 오래된 활성 트랜잭션**이 되어
> purge를 정지시킨다 → history list length 급증 → 이 테이블과 무관한
> 조회까지 버전 체인을 순회하느라 느려진다(long-transaction 사슬 (a)).
> ⑶ 40분쯤 지나 "복제 지연 급증" 알람에 담당자가 `KILL` — 그 순간부터
> **롤백**이 시작된다. 롤백은 undo를 역순으로 하나씩 적용하며 delete-mark를
> 지우고 인덱스 엔트리도 되돌리므로 **원 작업과 비슷하거나 더 오래**
> 걸린다. 롤백은 취소할 수 없고, 서버를 재시작해도 crash recovery가 이어서
> 롤백한다. 40분 삭제 → 1시간 넘는 롤백 → 결과는 **0건 삭제**.
> ⑷ 정상 커밋되더라도 끝이 아니다 — 커밋 직후 purge가 2억 개 delete-mark
> 행을 물리 삭제하느라 한동안 I/O 스파이크가 이어진다.

### 1-2. 사슬 B — 락: 커밋까지 쥔다 → 대기 큐 → 커넥션 고갈

> ⑴ InnoDB의 DELETE는 **스캔한 행**에 배타(X) 락을 건다. `created_at`에
> 인덱스가 있으면 삭제 대상 범위에만, 없으면 풀스캔이라 **테이블 전 행**을
> 스캔하며 잠근다. REPEATABLE READ에서는 조건에 안 맞아 스캔만 한 행의
> 락도 트랜잭션 끝까지 유지된다(READ COMMITTED는 조건 평가 후 해제).
> ⑵ 기본 격리 수준(REPEATABLE READ)이면 넥스트키 락이라 해당 인덱스
> 범위의 **"사이"**까지 잠근다 → 그 구간에 들어오는 INSERT가 대기한다
> ([gap-lock-next-key-lock-deadlock.md](./gap-lock-next-key-lock-deadlock.md)).
> 과거 기간이라 신규 INSERT는 대개 범위 밖이지만, 풀스캔이면 범위가 곧
> 테이블 전체다.
> ⑶ 이 락들은 **문장이 아니라 트랜잭션이 끝날 때** 풀린다 — 2억 행을 다
> 지울 때까지.
> ⑷ 락을 기다리는 세션은 커넥션을 쥔 채 `innodb_lock_wait_timeout`(기본
> 50초)까지 대기 → 앱의 HikariCP 풀이 대기자로 채워짐 → 이 테이블과
> 무관한 API까지 `connection-timeout`으로 실패(long-transaction 사슬
> (b)·(d)).

### 1-3. 사슬 C — binlog · 복제: 커밋 순간 한 덩어리 → 복제본 stale

> ⑴ ROW 포맷이면 삭제 행마다 이벤트가 기록된다 → 이 트랜잭션의 binlog가
> 수 GB. binlog는 **트랜잭션 단위로 커밋 시점에 한 번에** 기록되므로 그
> 전까지는 binlog 캐시(넘치면 임시 파일)에 쌓이고, 커밋 자체가 수십 초
> 걸린다. (가산점 포인트) `max_binlog_cache_size`를 넘으면 몇 시간 일하고
> **커밋 직전에 에러로 실패**한다 — 그리고 롤백.
> ⑵ 복제본은 트랜잭션을 단위로 재생한다. 2억 행짜리 트랜잭션 하나는
> 워커 하나가 처음부터 다시 삭제하고, 프라이머리에서 그 커밋 **이후에**
> 커밋된 트랜잭션들은 전부 그 뒤에 줄을 선다 → 프라이머리에서 걸린
> 시간만큼 복제본도 걸린다.
> ⑶ `Seconds_Behind_Source`가 수십 분~시간 → 리플리카로 라우팅된 조회가
> 오래된 데이터를 돌려준다("알림 읽었는데 안 읽음으로 나와요") → 지연
> 기반 헬스체크가 리플리카를 빼면 그 부하가 마스터로 몰린다
> ([read-replica-routing-and-lag.md](../03-jpa-orm/read-replica-routing-and-lag.md) 7장).
> ⑷ 프라이머리에서 롤백했으면 복제본엔 아무것도 안 가지만, 커밋됐으면
> 복제본 쪽에서 멈출 방법이 없다 — 복제 정합성을 깨지 않는 한.

### 1-4. 사슬 D — 인덱스 유지 비용: 세컨더리 인덱스마다 랜덤 I/O

여기가 후보자의 반복 공백(**랜덤 vs 순차 I/O 비용 모델**)이 직접 시험되는
지점이다.

> ⑴ 행 하나 삭제 = 클러스터드 인덱스 1건 + 세컨더리 인덱스 N개 각 1건의
> delete-mark. `episode_view_log`에 `(member_id, created_at)`,
> `(episode_id, created_at)` 인덱스가 있으면 삭제 1건이 **B+Tree 세 개**를
> 건드린다.
> ⑵ 클러스터드 인덱스는 `id`가 시간 순이라 지난 3개월 행이 **물리적으로
> 붙어** 있다 → 페이지 단위로 순차 처리. 그러나 세컨더리 인덱스는
> `member_id` 순으로 정렬돼 있어 같은 3개월 행이 **인덱스 전체에 흩어져**
> 있다 → 2억 건 × N개 = 수억 번의 랜덤 페이지 접근
> ([clustered-vs-secondary-index.md](./clustered-vs-secondary-index.md)).
> ⑶ change buffer가 세컨더리 인덱스의 delete-mark를 일부 버퍼링해 주지만
> 결국 그 페이지를 읽어 머지해야 하고, 그동안 **버퍼 풀이 삭제 대상
> 페이지로 채워진다** → 운영 조회가 쓰던 데이터 페이지가 밀려나 캐시
> 미스 → 삭제와 무관한 쿼리의 p99 상승.
> ⑷ 커밋 후 purge가 같은 페이지들을 **다시** 방문해 물리 삭제 → 랜덤 I/O
> 한 번 더.

### 1-5. 사슬 E — 다 지워도 디스크는 안 줄어든다 (공간 미반환 · 조각화)

> ⑴ 삭제가 성공하고 purge까지 끝나도 InnoDB는 빈 페이지를 **그 테이블
> 스페이스 안의 free 목록**에 돌려놓을 뿐, `.ibd` 파일을 줄이지 않는다.
> "디스크 80% 알람을 잡으려고" 시작했다면 목적 달성에 실패한다.
> ⑵ 부분적으로 빈 페이지들이 남는다 → 범위 스캔 시 페이지당 유효 행이
> 줄어 같은 결과를 내는 데 더 많은 페이지 I/O → "지웠는데 더 느려졌다".
> ⑶ 회수하려면 `OPTIMIZE TABLE`(InnoDB에서는 `ALTER TABLE ... FORCE`,
> 즉 **테이블 재구성**) → online-ddl의 사슬 B(디스크 2배·복제 지연)와
> 사슬 A(MDL)가 그대로 재발한다.

### 1-6. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "오래 걸린다" | **undo 폭증 · 롤백 배증** | 2억 undo 레코드 → 테이블스페이스 팽창 + purge 정지 → 중단하면 역순 롤백이 원 작업 이상 → 결과 0건 |
| "락 걸려서 느려진다" | **락 보유 큐** | 스캔 행 X 락(풀스캔이면 전 행) + 넥스트키 락 → 커밋까지 유지 → 대기자가 커넥션 점유 → 풀 고갈 → 무관 API 장애 |
| "복제본이 밀린다" | **binlog 한 덩어리** | 커밋 시 수 GB 이벤트 일괄 기록 → 복제본이 단일 트랜잭션으로 재생 → 이후 트랜잭션 전부 대기 → 읽기 stale |
| "인덱스 때문에 느리다" | **세컨더리 랜덤 I/O** | 행 1건 = 인덱스 N개 delete-mark → 세컨더리는 시간순이 아니라 흩어짐 → 랜덤 페이지 I/O → 버퍼 풀 오염 → 남의 쿼리 캐시 미스 |
| "지웠는데 용량이 그대로다" | **공간 미반환** | 빈 페이지는 free 목록으로만 → `.ibd` 불변 → 회수는 재구성(=DDL) → MDL·디스크 2배 재발 |

---

## 2. 접근법 3종 비교 — 목록 먼저, 대가를 양면으로

### 2-0. 한 장 비교표 (인출용)

| | ① 청크 삭제 | ② 파티션 DROP | ③ 남길 것만 복사 후 RENAME |
|---|---|---|---|
| 사전 조건 | 없음 (PK 범위 seek만 되면) | **미리 파티셔닝돼 있어야** | 남길 비율이 작고, 복사 중 쓰기 델타를 처리할 수단 |
| 소요 시간 | 길다 (수 시간~며칠) | **즉시** (건수 무관) | 남길 데이터 크기에 비례 |
| 사슬 A~C | 청크마다 짧게 끊김 | 발생 안 함 (DDL 한 줄) | 복사 트랜잭션에서 발생 → 복사도 청크로 |
| 사슬 D (인덱스 I/O) | **그대로 전부 지불** | 없음 | 없음 (새 인덱스는 정렬 빌드) |
| 사슬 E (공간) | 미반환 | 즉시 반환 | 완전 반환 + 조각 모음 효과 |
| 되돌리기 | 청크 단위 (이미 지운 건 아카이브에서) | 불가 (백업·아카이브에서만) | old 테이블이 살아 있는 동안 RENAME 되돌리면 즉시 |
| 지불하는 것 | 총 I/O 최대 · 중간 상태 노출 · 스로틀 운영 | PK/유니크 제약 · 프루닝 조건 · FK 불가 · 파티션 관리 | 쓰기 델타 · 디스크 2배 · FK 참조 · AUTO_INCREMENT |
| 언제 | 파티션 없는 기존 테이블, 지금 당장 | 처음부터 보존 정책이 있는 시계열 테이블 | 지울 게 남길 것보다 훨씬 많을 때 |

표는 인출용이고, 면접에서 점수가 나는 건 각 칸의 **"왜"**다. 아래에서 한
접근법마다 얻는 것과 지불하는 것을 같은 호흡에 적는다.

### 2-1. 청크 삭제 — PK 범위로 잘라 짧은 트랜잭션 수천 개로

아이디어는 하나다. **1장의 다섯 사슬은 모두 "트랜잭션 하나가 크다"에서
출발하므로, 트랜잭션을 작게 여러 개로 쪼개면 사슬 A·B·C가 각각 짧게
끊긴다.** undo는 청크 크기만큼만 쌓였다가 커밋과 함께 정리되고, 락은
수백 ms만 유지되고, binlog 이벤트도 청크 단위로 흘러가 복제본이
실시간으로 따라온다.

단, "어떻게 자르느냐"가 성패를 가른다.

```sql
-- 나쁜 청크: 매번 인덱스 앞쪽부터 다시 스캔한다.
-- delete-mark 행이 purge되기 전까지 다음 청크는 "이미 지운 유령 엔트리"를
-- 건너뛰며 시작하므로 갈수록 느려진다. ORDER BY 없는 LIMIT는 비결정적이라
-- statement 기반 binlog에서는 unsafe 경고까지 난다.
DELETE FROM episode_view_log
 WHERE created_at < '2026-06-01'
 LIMIT 5000;

-- 좋은 청크: 경계를 먼저 고정하고, PK 범위로 클러스터드 인덱스를 seek한다.
SELECT MAX(id) FROM episode_view_log WHERE created_at < '2026-06-01';  -- 상한 1회 계산
-- 루프 본문: (last_id, last_id + 5000] 구간만
DELETE FROM episode_view_log
 WHERE id > ? AND id <= ?
   AND created_at < '2026-06-01';   -- 안전벨트: PK가 시간 순이 아닌 행이 섞여 있어도 오삭제 방지
```

PK 범위가 성립하려면 **PK가 시간에 따라 단조 증가**해야 한다
(AUTO_INCREMENT, Snowflake/TSID, UUID v7). 그러면 "특정 기간"이 곧 "PK의
연속 구간"이고, 각 청크는 클러스터드 인덱스의 인접 페이지 몇 장이다. PK가
UUID v4처럼 무작위면 이 구조가 무너지고 `(created_at, id)` 인덱스로 키셋
탐색을 해야 한다 — 매 청크마다 세컨더리 → 클러스터드 룩업 비용이 붙는다
([deep-pagination-offset-vs-cursor.md](./deep-pagination-offset-vs-cursor.md)
3-3의 "배치의 전수 순회"와 같은 함정).

**얻는 것**
- 사전 준비가 없다. 파티션이 없는 기존 테이블에 **지금 당장** 적용된다.
- 트랜잭션마다 짧으니 사슬 A·B·C가 청크 길이로 제한된다.
- **멈출 수 있다.** 복제 지연이 오르면 쉬고, 피크 시간엔 안 돌고, 킬
  스위치로 즉시 세운다. 한 방 DELETE에는 없는 성질이다.

**지불하는 것 (반드시 같이 말할 것)**
- **총 시간이 길다.** 2억 건을 5,000건 청크 + 100ms 휴식이면 4만 번 반복,
  며칠짜리 작업이 된다. 그동안 운영 부하가 "약하게, 오래" 걸린다.
- **총 I/O는 오히려 최대다.** 사슬 D(인덱스 랜덤 I/O)는 청크로 나눠도
  한 건도 안 줄어든다 — 나눠서 지불할 뿐 총액은 같다. 청크 간 sleep은
  버퍼 풀이 숨 쉴 시간을 주는 것이지 비용을 없애지 않는다.
- **공간은 그대로 안 돌아온다**(사슬 E). 디스크 회수가 목적이면 청크
  삭제만으로는 끝나지 않는다.
- **중간 상태가 노출된다.** 삭제 중에는 "3개월 전 로그가 절반만 남은"
  상태가 조회된다. 그 기간 집계·통계 배치는 어긋난 숫자를 낸다 → 삭제
  창을 공지하거나 집계를 아카이브 쪽으로 돌려야 한다.
- **운영이 필요하다.** 청크 크기·sleep·임계값을 측정하고 조정하는 사람과
  코드가 필요하다(3장). "스크립트 하나 돌려놓고 퇴근"이 안 된다.
- 같은 범위를 갱신하는 트랜잭션과 **데드락**이 날 수 있어 청크 단위
  재시도가 필요하고, 대량 삭제 후 **인덱스 통계**가 바뀌어 다른 쿼리의
  실행 계획이 흔들릴 수 있다(`ANALYZE TABLE` 고려).

### 2-2. 파티션 DROP — 삭제를 DML이 아니라 "파일 제거"로 바꾼다

```sql
CREATE TABLE episode_view_log (
  id         BIGINT      NOT NULL,
  member_id  BIGINT      NOT NULL,
  episode_id BIGINT      NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id, created_at),            -- ★ 파티션 키가 PK에 들어가야 한다 (아래 대가 2)
  KEY idx_member  (member_id,  created_at),
  KEY idx_episode (episode_id, created_at)
) PARTITION BY RANGE COLUMNS (created_at) (
  PARTITION p202606 VALUES LESS THAN ('2026-07-01'),
  PARTITION p202607 VALUES LESS THAN ('2026-08-01'),
  PARTITION p202608 VALUES LESS THAN ('2026-09-01'),
  PARTITION p202609 VALUES LESS THAN ('2026-10-01')
  -- 선택: PARTITION p_future VALUES LESS THAN (MAXVALUE)   ← catch-all, 대가는 아래 5
);

-- 3개월 보존: 지난 달 파티션 하나를 통째로
ALTER TABLE episode_view_log DROP PARTITION p202605;   -- 건수와 무관하게 즉시, 파일 삭제
```

**얻는 것**
- 수천만 건이든 수억 건이든 **즉시** 끝난다. 행을 하나씩 지우는 게 아니라
  파티션의 데이터 파일을 버리는 것이라 undo도, 행 단위 binlog 이벤트도,
  인덱스 랜덤 I/O도 없다(사슬 A~D 소멸).
- **공간이 즉시 반환된다**(사슬 E 소멸). 파티션이 곧 별도 파일이라서.
- 복제본에도 `ALTER TABLE ... DROP PARTITION` 한 줄만 가므로 복제 지연이
  없다.

**지불하는 것 (여기가 이 문항의 시니어 변별 지점)**

1. **사전에 파티셔닝돼 있어야 한다.** 이미 수억 건 쌓인 테이블에 파티션을
   거는 것 자체가 **전체 재구성(COPY)**이다 → online-ddl 문서의 사슬 A·B가
   그대로 온다. 즉 파티션 DROP은 "이번 삭제"의 답이 아니라 **"다음
   삭제"를 위한 투자**다. 도입 경로는 둘 — pt-osc/gh-ost로 파티션된 새
   테이블로 옮기거나, 새 파티션 테이블을 만들어 신규 쓰기를 돌리고 구
   테이블은 청크 삭제로 자연 소멸시킨다.
2. **파티션 키가 PK와 모든 유니크 키에 포함돼야 한다.** MySQL의 규칙이다.
   `PRIMARY KEY (id)`였다면 `(id, created_at)`으로 바꿔야 하고, 그 결과
   (a) `id` 단독의 유일성을 **DB가 더 이상 보장하지 않는다** — 채번기가
   보장해야 한다 (b) 모든 세컨더리 인덱스 리프가 PK `(id, created_at)`을
   품게 되어 **인덱스가 커진다** (c) `UNIQUE (member_id, episode_id)` 같은
   업무 유니크가 필요하면 거기에도 `created_at`을 넣어야 하는데, 그 순간
   업무 규칙("한 회원이 한 에피소드에 한 번")이 표현 불가능해진다 → 사실상
   **유니크 제약이 필요한 테이블은 파티셔닝에 부적합**하다 (d) JPA
   엔티티의 `@Id`가 복합키(`@IdClass`/`@EmbeddedId`)가 된다.
3. **조회에 파티션 키 조건이 없으면 모든 파티션을 뒤진다.** MySQL 파티션
   테이블의 인덱스는 파티션별 로컬 인덱스이고 글로벌 인덱스가 없다.
   `WHERE id = ?`만으로는 어느 파티션인지 모르므로 **파티션 수만큼 인덱스
   seek**를 한다. `WHERE created_at BETWEEN ... AND id = ?`처럼 **파티션
   프루닝**(pruning: 조건으로 파티션을 미리 걸러내는 것) 조건이 붙어야
   한다 → 조회 API의 계약이 바뀐다("기간은 필수"). `EXPLAIN`의
   `partitions` 컬럼으로 확인한다.
4. **FK를 못 쓴다.** InnoDB 파티션 테이블은 FK를 정의할 수도, 다른
   테이블에서 참조될 수도 없다.
5. **파티션은 유한하다.** RANGE 파티션에서 다음 달 파티션이 없으면 그달
   첫 INSERT가 **실패**한다(`Table has no partition for value`). MAXVALUE
   catch-all을 두면 실패는 없지만 거기 쌓인 데이터를 나중에
   `REORGANIZE PARTITION`으로 쪼개야 하고 그건 그 파티션의 재구성이다.
   어느 쪽이든 **자동 생성 스케줄러 + "미래 파티션이 N개 이상 존재"
   알람**이 필수다(4-4).
6. **DROP PARTITION도 DDL이다.** 배타 MDL이 필요하므로 그 테이블을 읽는
   긴 트랜잭션이 있으면 online-ddl 사슬 A(MDL 큐 → 전면 장애)가 그대로
   재현된다. `lock_wait_timeout`을 짧게 두고 재시도한다.
7. **삭제 단위가 파티션으로 굳는다.** "5월 데이터 중 탈퇴 회원 것만"은
   여전히 DML이다. 파티션 단위(일/주/월)는 보존 정책의 세밀함과 파티션 수
   상한(테이블당 8,192개) 사이에서 정한다.
8. 백업·복구·통계 수집이 파티션 단위 운영 지식을 요구한다 — 팀에 그
   경험이 없으면 그 자체가 비용이다.

정리하면 파티션 DROP은 **"삭제가 설계의 일부일 때"** 최강이고, **"삭제가
나중에 생각난 요구일 때"** 가장 비싸다. 그래서 4-5절의 "보존 정책을 설계
시점에"가 이 접근법의 전제 조건이다.

### 2-3. 남길 것만 새 테이블로 복사한 뒤 RENAME — 삭제 대신 "재작성"

```sql
-- 1) 같은 구조의 빈 테이블 (이 기회에 파티셔닝을 함께 도입할 수 있다)
CREATE TABLE episode_view_log_new LIKE episode_view_log;
ALTER TABLE episode_view_log_new AUTO_INCREMENT = <원본 현재값보다 큰 값>;  -- 카운터는 따라오지 않는다

-- 2) 남길 행만 복사 — 이것도 한 방이 아니라 PK 범위 청크로
--    (INSERT ... SELECT 한 방 = 거대 트랜잭션 + REPEATABLE READ에서 원본 행에
--     공유 넥스트키 락 → 원본 쓰기 차단)
INSERT INTO episode_view_log_new
SELECT * FROM episode_view_log
 WHERE id > ? AND id <= ? AND created_at >= '2026-06-01';

-- 3) 복사 시작 이후 들어온 쓰기(델타)를 따라잡은 뒤 원자적 교체
RENAME TABLE episode_view_log     TO episode_view_log_old,
             episode_view_log_new TO episode_view_log;

-- 4) 며칠 관찰 후
DROP TABLE episode_view_log_old;   -- 공간 즉시 반환
```

**얻는 것**
- 삭제 I/O를 **아예 지불하지 않는다.** 지울 90%를 건드리지 않고 남길 10%만
  옮긴다. 새 테이블의 세컨더리 인덱스는 흩어진 delete-mark가 아니라
  **정렬된 빌드**로 만들어지므로 순차 I/O다.
- **공간이 완전히 회수되고 조각화가 0이 된다.** `OPTIMIZE TABLE`을 한 것과
  같은 효과를 삭제와 동시에 얻는다.
- `RENAME TABLE`은 원자적이라 교체 순간 앱은 끊김 없이 새 테이블을 본다.
  old 테이블을 며칠 두면 **되돌리기도 RENAME 한 번**이다.

**지불하는 것**
- **복사 시작 이후의 쓰기 델타.** 복사가 3시간 걸리면 그 3시간 동안 원본에
  들어온 INSERT/UPDATE는 새 테이블에 없다. 해법은 둘뿐이다 — 쓰기를
  멈추는 **점검 창**을 잡거나, 트리거/binlog로 델타를 따라잡는다. 후자는
  pt-osc/gh-ost가 하는 일 그 자체인데, 그 도구들은 **전체 행**을 복사하지
  "남길 행만" 골라 복사하는 옵션이 표준은 아니다 → 직접 짜거나 점검 창을
  받아야 한다. 이게 이 접근법의 가장 큰 대가다.
- **디스크가 일시적으로 2배**(원본 + 새 테이블 + old 보관 기간).
- **원본을 참조하는 FK**가 있으면 RENAME 후 자식 테이블의 FK가 old
  테이블을 따라간다 → 자식 FK를 재정의해야 하고 그것도 DDL이다. 트리거·
  뷰·권한도 새 테이블에 다시 건다.
- 남길 비율이 크면(예: 절반) 복사 비용이 삭제 비용을 넘어 손해다.
- `RENAME`도 MDL을 잡는다 — 짧지만 긴 트랜잭션이 있으면 대기한다.

### 2-4. 선택 기준 — 결정 순서로 말하기

1. **이미 파티셔닝돼 있는가?** → 파티션 DROP. 다른 선택지는 볼 필요가 없다.
2. **지울 비율이 압도적(대략 80~90% 이상)이고, 점검 창이나 델타 처리
   수단이 있는가?** → 복사 후 RENAME. 이 기회에 파티셔닝을 함께 도입한다.
3. **그 외** → 청크 삭제로 지금의 문제를 풀고, **동시에** 파티셔닝 도입
   계획을 세운다. 청크 삭제는 "이번"의 답이고 파티션은 "다음"의 답이다.

(가산점 포인트) 직접 짜기 전에 **pt-archiver**(Percona Toolkit)를 검토한다.
PK 기준 청크로 다른 테이블/파일에 옮기고 지우며 `--check-slave-lag`,
`--sleep`, `--txn-size`, `--bulk-delete` 같은 옵션으로 3장의 필수 요소를
검증된 형태로 제공한다. "도구가 있다는 것을 알고, 그래도 직접 짤 때는
같은 요소를 빠뜨리지 않는다"가 시니어의 태도다.

---

## 3. 청크 삭제 루프 — 필수 요소 9가지와 before/after

### 3-0. 필수 요소 9가지 (인출용 목록)

1. **경계 고정** — 시작 전에 `MAX(id)`로 상한을 한 번 계산해 "움직이는
   목표"를 없앤다. 매 청크마다 `NOW()`로 계산하면 삭제 대상이 계속 늘어나
   끝나지 않는다.
2. **PK 범위 커서** — `id > last AND id <= last + N`. `LIMIT`가 아니다(2-1).
3. **청크 크기** — 트랜잭션 하나가 수백 ms 안에 끝나도록. 1,000~10,000에서
   시작해 **측정 후** 결정한다. 정답 숫자는 없고 측정만 있다.
4. **청크 간 sleep + 적응형 스로틀** — 청크가 느려지면 크기를 줄이고
   휴식을 늘린다. 버퍼 풀·purge·복제본이 따라올 시간을 준다.
5. **복제 지연 게이트** — 임계 초과면 대기, 일정 시간 넘게 초과면 중단.
   사람이 알람을 보고 멈추는 게 아니라 루프가 스스로 멈춘다.
6. **DB 부하 게이트** — `Threads_running`, 락 대기, 커넥션 풀 사용률.
7. **진행 위치 영속화 + 멱등** — 마지막 `id`를 삭제와 **같은 트랜잭션**에
   기록한다. 프로세스가 언제 죽어도 그 지점부터 재개되고, 같은 범위를 두
   번 지워도 무해하다.
8. **킬 스위치 + 실행 시간 창** — 파일/플래그/설정값 하나로 즉시 정지,
   피크 시간에는 자동으로 안 돈다.
9. **관측** — 청크당 소요·삭제 건수·현재 지연을 메트릭과 로그로 남기고,
   이상치(청크 시간 급증, 삭제 0건 연속)에 알람을 건다.

여기에 **0번: 삭제 전 아카이브 검증**(4-1)이 앞에 붙는다. 이 열 가지 중
하나라도 빠진 "청크 삭제"는 한 방 DELETE를 여러 번으로 늘려 놓은 것에
불과하다.

### 3-1. before — `@Scheduled` + 한 방 (그리고 더 나쁜 파생 삭제 메서드)

```java
@Component
@RequiredArgsConstructor
public class ViewLogCleanupScheduler {

    private final EpisodeViewLogRepository repository;

    @Scheduled(cron = "0 0 4 * * *")
    @Transactional                                   // ← 2억 행이 한 트랜잭션
    public void purgeOld() {
        LocalDateTime cutoff = LocalDateTime.now().minusMonths(3);

        // 함정 1: Spring Data JPA의 파생 삭제 메서드(deleteBy...)는 벌크 DELETE가 아니다.
        //   엔티티를 전부 SELECT해서 영속성 컨텍스트에 올린 뒤 건별 em.remove() → 건별 DELETE.
        //   2억 엔티티 적재(OOM) + DELETE 2억 번 + 그래도 한 트랜잭션.
        repository.deleteByCreatedAtBefore(cutoff);

        // 함정 2: 그래서 @Modifying @Query("delete ... where e.createdAt < :cutoff") 로 바꾸면?
        //   영속성 컨텍스트는 우회하지만(bulk-operation 문서), DB 입장에선 여전히
        //   1장의 한 방 DELETE 그대로다. 사슬 A~E 전부 발생.
    }
}
```

두 함정의 공통점은 **"몇 건이 지워지는가"를 코드가 모른다**는 것이다.
안전한 삭제 코드는 자기가 지금 몇 건을 지우고 있고 DB가 그걸 감당하는지를
매 순간 안다.

### 3-2. after ① — 스케줄러 + `TransactionTemplate` + `JdbcTemplate`: 청크마다 커밋

```java
@Component
@RequiredArgsConstructor
public class ViewLogChunkPurger {

    private static final Logger log = LoggerFactory.getLogger(ViewLogChunkPurger.class);
    private static final String TABLE = "episode_view_log";

    private final JdbcTemplate jdbc;                 // 프라이머리 DataSource
    private final TransactionTemplate tx;            // 청크 하나 = 트랜잭션 하나
    private final ReplicationLagProbe lagProbe;      // 리플리카 지연 측정 (3-4)
    private final PurgeProgressRepository progress;  // 진행 위치 영속화 (별도 테이블)
    private final ArchiveVerifier archiveVerifier;   // 삭제 허가 범위 (4-1)
    private final PurgeProperties props;             // chunkSize, sleep, lagThreshold, window, killSwitch...
    private final MeterRegistry meters;

    // ★ 이 메서드에 @Transactional을 붙이지 않는다.
    //   붙이는 순간 안의 TransactionTemplate(기본 REQUIRED)이 그 트랜잭션에 참여해
    //   루프 전체가 다시 "한 방"이 된다. 실제로 자주 나는 실수다.
    @Scheduled(cron = "0 0 2 * * *")                 // 8. off-peak 시작
    public void run() {
        LocalDateTime cutoff = LocalDate.now().minusMonths(props.retentionMonths()).atStartOfDay();

        // 1. 경계 고정 — 오늘 밤 지울 상한 PK를 한 번만 계산
        Long maxId = jdbc.queryForObject(
            "SELECT MAX(id) FROM " + TABLE + " WHERE created_at < ?", Long.class, cutoff);
        if (maxId == null) return;

        // 0. 아카이브가 검증된 범위까지만 지운다
        long verifiedUntil = archiveVerifier.verifiedUntilId(TABLE);
        maxId = Math.min(maxId, verifiedUntil);

        // 7. 재개 — 마지막으로 지운 id 다음부터
        long lastId = progress.lastDeletedId(TABLE).orElse(0L);
        int chunk = props.chunkSize();

        while (lastId < maxId) {
            // 8. 킬 스위치 + 시간 창 — 진행 위치는 이미 저장돼 있으므로 그냥 return
            if (props.killSwitchOn() || !props.window().contains(LocalTime.now())) {
                log.warn("[purge] paused at id={}", lastId);
                return;
            }
            // 5. 복제 지연 게이트 — 임계 초과면 기다리고, 계속 초과면 오늘은 포기
            if (!lagProbe.waitUntilBelow(props.lagThresholdSec(), props.lagWaitMax())) {
                log.error("[purge] replica lag stayed above {}s — aborting today", props.lagThresholdSec());
                meters.counter("purge.aborted", "reason", "replica_lag").increment();
                return;
            }
            // 6. DB 부하 게이트
            if (dbBusy()) { sleepQuietly(props.backoff()); continue; }

            final long from = lastId;
            final long to   = Math.min(lastId + chunk, maxId);

            long started = System.nanoTime();
            // 2. PK 범위 청크 — 하나의 짧은 트랜잭션. 진행 위치 갱신도 같은 트랜잭션 (7)
            int deleted = tx.execute(status -> {
                int n = jdbc.update(
                    "DELETE FROM " + TABLE + " WHERE id > ? AND id <= ? AND created_at < ?",
                    from, to, cutoff);
                progress.save(TABLE, to);
                return n;
            });
            long elapsedMs = (System.nanoTime() - started) / 1_000_000;

            // 9. 관측
            meters.timer("purge.chunk.duration").record(Duration.ofMillis(elapsedMs));
            meters.counter("purge.rows.deleted").increment(deleted);
            log.info("[purge] ({}, {}] deleted={} in {}ms chunk={} lag={}s",
                     from, to, deleted, elapsedMs, chunk, lagProbe.current());

            // 3·4. 적응형 스로틀 — 목표 시간의 2배를 넘으면 반으로, 절반 이하면 두 배로
            chunk  = adapt(chunk, elapsedMs);
            lastId = to;
            sleepQuietly(props.sleepBetweenChunks());   // 트랜잭션 밖에서 잔다
        }
        progress.clear(TABLE);
        log.info("[purge] completed up to id={}", maxId);
    }

    private int adapt(int chunk, long elapsedMs) {
        long target = props.targetChunkMs();            // 예: 200ms
        if (elapsedMs > target * 2) return Math.max(chunk / 2, props.minChunk());
        if (elapsedMs < target / 2) return Math.min(chunk * 2, props.maxChunk());
        return chunk;
    }

    private boolean dbBusy() {
        Integer running = jdbc.queryForObject(
            "SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_running'",
            Integer.class);
        return running != null && running > props.maxThreadsRunning();
    }

    private static void sleepQuietly(Duration d) {
        try { Thread.sleep(d.toMillis()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

코드에서 봐야 할 것 세 가지:

- **`run()`에 `@Transactional`이 없다.** 이게 있으면 안의
  `TransactionTemplate`이 바깥 트랜잭션에 참여해(REQUIRED) 커밋이 루프
  끝까지 미뤄진다 — 청크로 "보이지만" DB에는 한 방이다. 리뷰에서 가장
  먼저 볼 줄이다.
- **sleep은 트랜잭션 밖이다.** `tx.execute` 블록 안에서 자면 락과 undo를
  쥔 채 잔다.
- **진행 위치 저장이 DELETE와 같은 트랜잭션이다.** 그래서 "지웠는데 위치
  저장 전에 죽음 → 재시작 시 같은 범위 재삭제"가 있어도 0건이 지워질 뿐
  무해하고(멱등), "위치는 저장했는데 안 지움"은 원천적으로 불가능하다.

`@Scheduled`는 기본이 단일 스레드라 이 루프가 도는 동안 다른 스케줄이
전부 막힌다 — 전용 `TaskScheduler`를 준다. 그리고 **인스턴스가 여러 대**면
같은 루프가 동시에 돌므로 ShedLock 같은 분산 락이나 "배치 전용 인스턴스
1대" 규칙이 필요하다.

### 3-3. after ② — Spring Batch `Tasklet` 버전: 재시작·진행 위치를 프레임워크가

같은 루프를 Spring Batch로 옮기면 7번(진행 위치)과 재시작을 프레임워크가
맡는다. 청크 지향 스텝(reader → processor → writer)은 "읽어서 쓰는"
모델이라 순수 범위 삭제에는 맞지 않고, **`Tasklet`의 `execute()` 호출
1회 = 트랜잭션 1개**라는 성질을 쓰는 편이 정확하다.

```java
@Bean
public Step purgeViewLogStep(JobRepository jobRepository, PlatformTransactionManager txm,
                             ViewLogPurgeTasklet tasklet, PurgeProperties props) {
    return new StepBuilder("purgeViewLog", jobRepository)
        .tasklet(tasklet, txm)                                    // execute() 1회 = 트랜잭션 1개
        .listener(new SleepAfterChunk(props.sleepBetweenChunks())) // 커밋 "뒤"에 잔다
        .build();
}

@Component
@StepScope
@RequiredArgsConstructor
public class ViewLogPurgeTasklet implements Tasklet {

    private final JdbcTemplate jdbc;
    private final ReplicationLagProbe lagProbe;
    private final PurgeProperties props;
    @Value("#{jobParameters['cutoff']}") private LocalDateTime cutoff;   // JobParameter → 같은 파라미터면 재실행이 아니라 "재시작"

    @Override
    public RepeatStatus execute(StepContribution contribution, ChunkContext ctx) {
        ExecutionContext ec = ctx.getStepContext().getStepExecution().getExecutionContext();

        if (!ec.containsKey("maxId")) {                            // 1. 경계 고정 — 첫 호출 때 한 번
            Long maxId = jdbc.queryForObject(
                "SELECT MAX(id) FROM episode_view_log WHERE created_at < ?", Long.class, cutoff);
            if (maxId == null) return RepeatStatus.FINISHED;
            ec.putLong("maxId", maxId);
        }
        long maxId  = ec.getLong("maxId");
        long lastId = ec.getLong("lastId", 0L);                    // 7. 재시작 시 여기서부터
        if (lastId >= maxId) return RepeatStatus.FINISHED;

        // 5. 복제 지연 게이트 — 여기는 트랜잭션 안이므로 "기다리지" 않고 즉시 실패시킨다.
        //    스텝 FAILED → 다음 스케줄에 같은 JobParameter로 restart → lastId부터 이어진다.
        if (lagProbe.current() > props.lagThresholdSec()) {
            throw new PurgeThrottledException("replica lag " + lagProbe.current() + "s");
        }

        long to = Math.min(lastId + props.chunkSize(), maxId);
        int n = jdbc.update(                                        // 2. PK 범위 청크
            "DELETE FROM episode_view_log WHERE id > ? AND id <= ? AND created_at < ?",
            lastId, to, cutoff);
        contribution.incrementWriteCount(n);                        // 9. StepExecution에 누적
        ec.putLong("lastId", to);                                   // 7. 커밋과 함께 JobRepository에 저장

        return RepeatStatus.CONTINUABLE;                            // 새 트랜잭션으로 다시 호출된다
    }
}

/** Tasklet의 execute()는 트랜잭션 안이다. sleep은 커밋 뒤에 불리는 afterChunk에 둔다. */
@RequiredArgsConstructor
class SleepAfterChunk implements ChunkListener {
    private final Duration sleep;
    @Override public void afterChunk(ChunkContext context) {
        try { Thread.sleep(sleep.toMillis()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

Spring Batch가 얹어 주는 것과 여전히 직접 해야 하는 것을 구분해 말한다.
얹어 주는 것 — `ExecutionContext`가 커밋마다 저장되어 **재시작이 공짜**,
`JobParameters`로 **같은 cutoff의 중복 실행 방지**, `StepExecution`에
**처리 건수·소요 시간이 기록**돼 관측의 절반이 해결. 직접 해야 하는 것 —
복제 지연 게이트, 스로틀, 킬 스위치, 아카이브 검증은 프레임워크가 모른다.
"Spring Batch를 쓰면 안전하다"는 말은 절반만 맞다.

### 3-4. 복제 지연은 어떻게 재나 — `ReplicationLagProbe`

게이트 5번이 성립하려면 앱이 지연을 **숫자로** 알아야 한다. 두 방법이
있고, 자세한 비교는 read-replica 문서 5장에 있다.

- `SHOW REPLICA STATUS`의 `Seconds_Behind_Source` — 간단하지만 SQL 스레드가
  멈춰 있거나 릴레이 로그를 다 받고 적용 중일 때 **0으로 보이는 함정**이
  있다.
- **하트비트 테이블** — 프라이머리가 1초마다 현재 시각을 한 행에 쓰고,
  리플리카에서 그 행을 읽어 지금 시각과의 차이를 지연으로 삼는다. 복제
  경로 전체를 실제로 통과한 값이라 더 정확하다.

```java
@Component
@RequiredArgsConstructor
public class ReplicationLagProbe {

    private final List<JdbcTemplate> replicas;   // 리플리카별 DataSource

    /** 모든 리플리카 중 최대 지연(초). 하트비트 방식. */
    public double current() {
        return replicas.stream()
            .mapToDouble(r -> r.queryForObject(
                "SELECT TIMESTAMPDIFF(MICROSECOND, ts, UTC_TIMESTAMP(6)) / 1e6 " +
                "  FROM replication_heartbeat WHERE id = 1", Double.class))
            .max().orElse(0.0);
    }

    /** 임계 아래로 내려올 때까지 최대 maxWait 동안 기다린다. 못 내려오면 false. */
    public boolean waitUntilBelow(double thresholdSec, Duration maxWait) {
        long deadline = System.nanoTime() + maxWait.toNanos();
        while (current() > thresholdSec) {
            if (System.nanoTime() > deadline) return false;
            try { Thread.sleep(5_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        return true;
    }
}
```

관리형 DB(예: Aurora)는 리플리카 지연을 함수·모니터링 지표로 제공하므로
그 값을 같은 인터페이스 뒤에 숨긴다. 중요한 건 측정 방법이 아니라 **루프가
그 숫자를 보고 스스로 멈춘다**는 구조다.

---

## 4. 안전망 — 사람이 아니라 코드·스키마가 지킨다

### 4-1. 삭제 전 아카이브 검증 — 건수 + 체크섬, 그리고 유예 기간

순서는 **아카이브 → 검증 → (유예) → 삭제**다. 아카이브와 삭제를 한
트랜잭션에 묶고 싶은 유혹이 있지만, 아카이브 목적지가 다른 저장소(별도
DB, 오브젝트 스토리지의 Parquet)면 어차피 한 트랜잭션이 아니고, 같은 DB의
아카이브 테이블이라도 "옮겼다"와 "옮긴 게 맞다"는 다른 문제다.

```sql
-- 원본 쪽: 삭제 예정 범위를 고정하고 세 값을 뽑는다
SELECT COUNT(*)                                                                    AS cnt,
       BIT_XOR(CRC32(CONCAT_WS('|', id, member_id, episode_id, created_at)))       AS xor_crc,
       SUM(CRC32(CONCAT_WS('|', id, member_id, episode_id, created_at)))           AS sum_crc
  FROM episode_view_log
 WHERE id > ? AND id <= ? AND created_at < ?;
-- 아카이브 쪽에서 같은 범위·같은 식으로 뽑아 세 값이 모두 같아야 "그 범위 삭제 허가"
```

- `COUNT`만 보면 "건수는 같은데 내용이 다른" 경우를 놓치고, `BIT_XOR`만
  보면 같은 행이 두 번 들어간 경우를 놓친다(XOR은 짝수 번이면 0). 그래서
  셋을 함께 본다. NULL 가능 컬럼은 `IFNULL(col, '')`로 감싼다.
- 오브젝트 스토리지로 내보내는 경우 내보내기 작업이 파일별 **건수·CRC를
  매니페스트**에 기록하고, 검증기는 원본 범위 값과 매니페스트를 비교한다.
- 검증을 통과한 상한 `id`를 `archive_verification(table, verified_until_id,
  verified_at)`에 기록하고, 3-2의 루프는 **그 값 이하만** 지운다. 검증
  코드와 삭제 코드가 테이블 하나로 연결되어 "검증 안 하고 지우기"가
  구조적으로 불가능해진다.
- **유예 기간**을 둔다 — 검증 후 예컨대 7일 뒤에 삭제. 그 사이 아카이브에서
  **샘플 복원 테스트**(무작위 행 100건을 아카이브에서 읽어 원본과 대조)를
  자동으로 돌린다. 복구를 한 번도 연습 안 한 백업은 없는 것과 같다는
  원칙이 여기서도 적용된다.

### 4-2. 드라이런 — 실행 전에 계획서를 뽑아 사람이 승인한다

```java
public PurgePlan dryRun(String table, LocalDateTime cutoff) {
    Long maxId = jdbc.queryForObject("SELECT MAX(id) FROM " + table + " WHERE created_at < ?", Long.class, cutoff);
    Long minId = jdbc.queryForObject("SELECT MIN(id) FROM " + table, Long.class);
    // 수억 건 COUNT(*) 자체가 무거우므로 PK 범위 폭으로 추정하고, 정확한 수는 EXPLAIN의 rows로 보조
    long estimatedRows = (maxId == null || minId == null) ? 0 : maxId - minId;
    String plan = jdbc.queryForList(
        "EXPLAIN DELETE FROM " + table + " WHERE id > ? AND id <= ? AND created_at < ?",
        minId, minId + props.chunkSize(), cutoff).toString();       // type=range, key=PRIMARY 인지 확인

    return new PurgePlan(
        table, cutoff, minId, maxId, estimatedRows,
        estimatedRows / props.chunkSize(),                          // 예상 청크 수
        Duration.ofMillis(estimatedRows / props.chunkSize() * (props.targetChunkMs() + props.sleepBetweenChunks().toMillis())),
        plan,
        archiveVerifier.verifiedUntilId(table) >= (maxId == null ? 0 : maxId),   // 아카이브 검증 완료 여부
        lagProbe.current(),                                          // 현재 복제 지연
        longestOpenTransactionSec()                                  // information_schema.innodb_trx
    );
}
```

드라이런이 확인하는 것은 다섯 가지다 — **대상 범위와 건수의 자릿수**(2억인지
2천만인지), **실행 계획이 PK range인지**(풀스캔이면 청크가 아니다),
**아카이브 검증이 끝났는지**, **현재 복제 지연**, **열려 있는 긴
트랜잭션**. 이 계획서가 티켓에 첨부되고 승인된 뒤에야 실제 실행 플래그가
켜진다. "새벽에 담당자가 SQL을 직접 친다"를 "코드가 계획서를 만들고
사람은 승인만 한다"로 바꾸는 것이다.

### 4-3. 루프 안의 자동 중단 — 알람이 아니라 게이트

3장에 이미 들어 있지만 안전망 관점에서 다시 짚는다. 대량 삭제 사고의
전형은 "알람이 울렸고, 사람이 보고, 판단하고, KILL했다"인데 그 사이 40분이
지나 있고 KILL은 롤백을 부른다. 게이트는 그 40분을 0으로 만든다.

| 게이트 | 신호 | 동작 |
|---|---|---|
| 복제 지연 | 하트비트 지연 > 임계(예: 5초) | 대기 → 일정 시간 초과 시 오늘 중단 |
| DB 부하 | `Threads_running` > 임계 | 백오프 |
| 커넥션 풀 | HikariCP active/total > 70% | 백오프 (내 루프가 풀을 굶기고 있다는 신호) |
| 청크 시간 | 목표의 2배 초과 | 청크 크기 절반 |
| 시간 창 | 피크 시간 진입 | 진행 위치 저장 후 종료 |
| 킬 스위치 | 설정값/파일/캐시 키 | 즉시 종료 |

### 4-4. 파티션 자동 생성 · 드랍 스케줄러

파티션 DROP 접근법의 대가 5·6번(파티션 고갈 → INSERT 실패, DDL의 MDL)을
사람의 달력이 아니라 코드가 처리한다.

```java
@Component
@RequiredArgsConstructor
public class PartitionMaintenanceScheduler {

    private final JdbcTemplate jdbc;
    private final RetentionPolicyRepository policies;   // 4-5: 테이블별 보존 기간·선행 생성 개수
    private final ArchiveVerifier archiveVerifier;
    private final AlertClient alert;

    @Scheduled(cron = "0 30 3 * * *")
    public void maintain() {
        for (RetentionPolicy p : policies.findAllPartitioned()) {
            ensureFuturePartitions(p);
            dropExpiredPartitions(p);
        }
    }

    /** 미래 파티션이 항상 aheadMonths개 존재하게 한다 — 이게 없으면 다음 달 첫 INSERT가 실패한다. */
    private void ensureFuturePartitions(RetentionPolicy p) {
        YearMonth now = YearMonth.now(ZoneOffset.UTC);
        for (int i = 1; i <= p.aheadMonths(); i++) {
            YearMonth ym = now.plusMonths(i);
            if (!partitionExists(p.table(), name(ym))) {
                jdbc.execute("SET SESSION lock_wait_timeout = 5");           // MDL 대기 상한
                jdbc.execute(("ALTER TABLE %s ADD PARTITION (PARTITION %s VALUES LESS THAN ('%s'))")
                    .formatted(p.table(), name(ym), ym.plusMonths(1).atDay(1)));
            }
        }
    }

    /** 보존 기간이 지난 파티션을 드랍한다 — 단, 아카이브 검증이 끝난 것만. */
    private void dropExpiredPartitions(RetentionPolicy p) {
        YearMonth oldestToKeep = YearMonth.now(ZoneOffset.UTC).minusMonths(p.retentionMonths());
        for (String partition : partitionsOlderThan(p.table(), oldestToKeep)) {
            if (p.archiveRequired() && !archiveVerifier.isVerified(p.table(), partition)) {
                alert.warn("[partition] %s.%s 보존 만료됐으나 아카이브 미검증 — 드랍 보류".formatted(p.table(), partition));
                continue;                                                    // 드랍하지 않는다. 사람이 본다.
            }
            jdbc.execute("SET SESSION lock_wait_timeout = 5");
            jdbc.execute("ALTER TABLE %s DROP PARTITION %s".formatted(p.table(), partition));
        }
    }

    private boolean partitionExists(String table, String partition) {
        Integer n = jdbc.queryForObject(
            "SELECT COUNT(*) FROM information_schema.PARTITIONS " +
            " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME = ?",
            Integer.class, table, partition);
        return n != null && n > 0;
    }
    // partitionsOlderThan(...)도 information_schema.PARTITIONS 의 PARTITION_DESCRIPTION 으로 계산
    private static String name(YearMonth ym) { return "p" + ym.getYear() + "%02d".formatted(ym.getMonthValue()); }
}
```

스케줄러와 **독립된** 감시를 하나 더 둔다 — "미래 파티션이 2개 미만이면
경보". 스케줄러 자체가 배포 실수로 죽어 있을 때를 위한 것이다. 안전망을
지키는 안전망이 하나는 있어야 한다. MySQL의 Event Scheduler로 DB 안에서
같은 일을 할 수도 있는데, 앱 코드에 두면 배포·테스트·관측 경로가 다른
코드와 같아지고 DB에 두면 앱과 무관하게 돈다 — 팀이 DB 쪽 스크립트를 얼마나
잘 관리하느냐로 고른다.

### 4-5. 보존 정책을 설계 시점에 — "이 행은 언제 죽는가"에 답이 없는 테이블은 만들지 않는다

가장 싼 대량 삭제는 **처음부터 삭제가 쉬운 구조로 만든 테이블**의
삭제다. 그래서 이벤트성 테이블(`*_log`, `*_history`, `*_event`)의 DDL PR은
다음 넷에 답해야 통과한다.

1. **보존 기간** — "무기한"은 답이 아니다. 무기한이면 왜 RDB인지 답해야 한다.
2. **삭제 방식** — 파티션 DROP인지 청크 삭제인지. 파티션이면 PK에
   `created_at`이 들어가고 FK가 없어야 하므로 **지금** 정해야 한다.
3. **아카이브 여부와 목적지** — 지우기 전에 어디로 보내는지, 안 보낸다면
   그 합의가 어디 기록돼 있는지.
4. **PK 단조 증가 또는 `created_at` 인덱스** — 청크 삭제가 PK range로
   가능한 구조인지.

이 답을 사람의 리뷰 기억이 아니라 **기계가 읽는 자리**에 둔다. 테이블
COMMENT와 `retention_policy` 메타 테이블 — 4-4의 스케줄러가 이 테이블을
읽어 동작하므로 "새 로그 테이블 추가 = 정책 행 하나 INSERT"가 되고
테이블마다 스케줄러 코드를 새로 짜지 않는다.

```sql
CREATE TABLE notification_history (
  ...
) COMMENT = 'retention=90d;purge=partition-monthly;archive=s3://.../notification_history/'
  PARTITION BY RANGE COLUMNS (created_at) (...);

INSERT INTO retention_policy (table_name, retention_months, ahead_months, purge_method, archive_required)
VALUES ('notification_history', 3, 3, 'PARTITION_DROP', TRUE);
```

```bash
# ci/lint-retention.sh — 이벤트성 테이블 DDL에 retention 메타가 없으면 CI 실패
for f in $(git diff --name-only origin/main -- 'src/main/resources/db/migration/*.sql'); do
  if grep -qiE 'CREATE TABLE [`"]?[a-z_]+_(log|history|event)s?[`"]?' "$f" \
     && ! grep -qiE "COMMENT\s*=\s*'[^']*retention=" "$f"; then
    echo "::error file=$f::이벤트성 테이블은 COMMENT에 retention=<기간>;purge=<방식>을 명시해야 합니다 (knowledge/04-rdb-sql/mass-delete-archiving-and-partitioning.md 4-5)"
    exit 1
  fi
done
```

### 4-6. 대량 삭제 체크리스트 (PR · 런북 필수)

```markdown
## 대량 삭제/아카이빙 체크리스트
- [ ] 접근법 선택 근거: 파티션 유무 / 지울 비율 / 점검 창 가능 여부 (2-4)
- [ ] 드라이런 계획서 첨부: 범위·건수 자릿수·EXPLAIN(type=range, key=PRIMARY)·예상 소요 (4-2)
- [ ] 아카이브 검증(건수·XOR·SUM) 통과 + verified_until_id 기록 + 샘플 복원 테스트 (4-1)
- [ ] 청크 루프에 게이트 6종(복제 지연·Threads_running·풀 사용률·청크 시간·시간 창·킬 스위치) (4-3)
- [ ] run() 에 @Transactional 없음 / sleep 이 트랜잭션 밖 / 진행 위치가 DELETE 와 같은 트랜잭션 (3-2)
- [ ] 다중 인스턴스 동시 실행 방지 (분산 락 또는 전용 인스턴스)
- [ ] DDL(DROP PARTITION / RENAME / OPTIMIZE)이 포함되면 lock_wait_timeout 단축 + innodb_trx 사전 확인 (online-ddl 4-1)
- [ ] 실행 중 관측 대시보드: 청크 시간·삭제 건수·복제 지연·풀 사용률
- [ ] 재발 방지: retention_policy 등록 / 파티션 스케줄러 대상 추가
```

---

## 5. 실무 사례 — 웹툰 조회 로그 · 알림 이력 N개월 보존

상황: `episode_view_log`(에피소드 조회 로그, 하루 수백만 건)와
`notification_history`(알림 발송 이력)는 "3개월 보존"이 기획 문서에는
있었지만 코드에는 없었다. 2년이 지나 두 테이블이 각각 수억 건, 디스크
사용률 82% 알람이 울렸다. 담당자는 새벽 3시에 워크벤치에서
`DELETE FROM notification_history WHERE created_at < DATE_SUB(NOW(), INTERVAL 3 MONTH)`를
실행했다.

25분 뒤 복제 지연 알람(사슬 C), 30분 뒤 알림함 API(리플리카 라우팅)의
"읽음 처리했는데 안 읽음으로 나와요" 문의, 35분 뒤 `notification_history`에
INSERT하는 알림 발송 워커가 락 대기로 밀리며 커넥션 풀 고갈(사슬 B), 40분에
`KILL`. 롤백은 1시간 10분 걸렸고(사슬 A) 아침에 확인한 디스크 사용률은
82%였다 — 어차피 커밋됐어도 사슬 E 때문에 줄지 않았을 숫자다. 지운 행은
0건.

대응은 세 단계로 갔다.

- **즉시(그 주)**: 두 테이블 모두 3-2의 청크 루프로 전환. 첫날 청크
  5,000·sleep 200ms로 시작해 청크 시간 120ms, 복제 지연 최대 1.8초를
  확인하고 청크 10,000으로 올림. 아카이브는 두 테이블이 달랐다 —
  `episode_view_log`는 분석용이라 **오브젝트 스토리지에 Parquet로 내보낸
  뒤 매니페스트 건수·CRC 검증**, `notification_history`는 사용자가 다시
  볼 일이 없다는 것을 기획과 **문서로 합의**하고 아카이브 없이 삭제.
  "아카이브 안 함"도 결정이고, 결정은 기록돼야 한다.
- **단기(다음 스프린트)**: 디스크는 청크 삭제로 안 돌아오므로
  `notification_history`는 남길 3개월(전체의 12%)만 **새 파티션 테이블로
  복사 후 RENAME**(2-3). 델타는 알림 워커를 15분 멈추는 점검 창으로
  처리했고, 이 순간 파티셔닝이 도입됐다. PK를 `(id, created_at)`으로
  바꾸면서 알림 이력의 `@Id`가 복합키가 되는 비용을 지불했다(2-2 대가 2).
- **중기**: `retention_policy` 테이블과 4-4 스케줄러 도입, 4-5 CI 린트
  추가. 이후 새로 생긴 `episode_reaction_log`는 DDL PR 단계에서 "보존
  기간?"을 묻는 린트에 걸려 처음부터 월 파티션으로 만들어졌고, 그
  테이블의 첫 삭제는 `DROP PARTITION` 한 줄, 0.3초였다.

이 사고의 교훈은 "DELETE를 나눠 치자"가 아니다. **삭제는 테이블을 만들
때 이미 결정된 비용**이고, 그 결정을 미룬 값을 2년 뒤 새벽 3시에 한꺼번에
치른 것이다.

---

## 6. 꼬리질문 대비 포인트

### "청크 크기와 sleep은 어떻게 정하나요? 1,000이면 안전한가요?"

숫자가 아니라 **측정 기준**으로 답한다. 목표는 "청크 트랜잭션 하나가
수백 ms 안에 끝나고, 그동안 복제 지연·락 대기·`Threads_running`이 평소
수준을 벗어나지 않는 것"이다. 1,000에서 시작해 청크 시간과 복제 지연을
보며 두 배씩 올리고, 목표 시간의 2배를 넘으면 절반으로 내리는 **적응형**이
정답에 가깝다(3-2 `adapt`). 행 크기·세컨더리 인덱스 수·디스크 종류에
따라 같은 1,000이 50ms일 수도 2초일 수도 있어서 고정 숫자는 답이 될 수
없다. sleep은 버퍼 풀·purge·복제본이 따라올 시간이며, 대체로 청크 시간과
비슷한 길이에서 시작한다.

### "`DELETE ... LIMIT 1000`을 반복하면 안 되나요? 훨씬 간단한데요."

세 가지 이유로 PK 범위가 낫다. ① `LIMIT`는 매번 인덱스 앞쪽부터 다시
스캔하는데, 방금 지운 행은 purge 전까지 delete-mark 상태로 인덱스에 남아
있어 **다음 청크가 유령 엔트리를 건너뛰며 시작**한다 → 청크가 갈수록
느려진다. PK 범위는 매 청크가 고정된 클러스터드 구간 seek라 속도가
일정하다. ② `ORDER BY` 없는 `LIMIT`는 어떤 행이 지워질지 **비결정적**이라
statement 기반 binlog에서 unsafe 경고가 나고 프라이머리·복제본이 다른
행을 지울 수 있다. ③ 잠그는 범위가 예측되지 않는다 — PK 범위는 "이
구간"이라고 말할 수 있지만 `LIMIT`는 옵티마이저가 고른 경로에 따라 다르다.
`LIMIT`가 허용되는 경우는 PK가 시간 순이 아니어서 범위가 성립하지 않을
때뿐이고, 그때도 `(created_at, id)` 키셋으로 하한을 밀며 간다.

### "파티셔닝하면 무엇을 잃나요? PK를 왜 바꿔야 하죠?" (시니어 변별 포인트)

MySQL은 **파티션 키 컬럼이 테이블의 모든 유니크 키(PK 포함)에 들어 있어야**
한다. 이유는 유니크 검사가 파티션 단위 로컬 인덱스로 이뤄지기 때문이다 —
글로벌 인덱스가 없으니 `id`만으로 유일성을 검사하려면 모든 파티션을 다
봐야 하고, MySQL은 그 비용 대신 제약을 택했다. 그래서 `PRIMARY KEY (id)`
→ `(id, created_at)`이 되고, 잃는 것은 넷이다: `id` 단독 유일성의 DB
보장, 세컨더리 인덱스 크기(리프가 복합 PK를 품음), 업무 유니크 제약의
표현력(`UNIQUE(member_id, episode_id)`에 `created_at`을 끼워 넣는 순간
의미가 사라짐), JPA `@Id`의 단순함. 여기에 **FK 불가**, **프루닝 조건 없는
조회의 파티션 수 배수 seek**, **파티션 고갈 시 INSERT 실패**까지 얹는다.
그래서 판단 기준은 "삭제가 잦은가"가 아니라 **"이 테이블에 유니크
제약·FK·기간 없는 점 조회가 있는가"**다. 셋 다 없는 순수 시계열(로그·
이력·이벤트)에서만 파티셔닝은 공짜에 가깝고, 하나라도 있으면 그 제약과
싸우는 비용이 삭제 편의를 넘는다.

### "아카이브가 제대로 됐다는 걸 어떻게 보장하나요? 삭제한 뒤 아카이브가 깨져 있었다면요?" (시니어 변별 포인트)

"보장"은 삭제 **전**에만 가능하므로 절차를 앞에 둔다. ① 범위 고정 후
원본과 아카이브에서 `COUNT` + `BIT_XOR(CRC32)` + `SUM(CRC32)` 세 값을
비교한다(하나만으로는 건수 불일치·중복 적재를 각각 놓친다). ② 통과한
상한을 `archive_verification`에 기록하고 삭제 루프는 그 값 이하만
지운다 — 검증과 삭제가 코드로 연결돼 있어 순서를 어길 수 없다. ③ 검증과
삭제 사이에 **유예 기간**을 두고 그동안 **샘플 복원 테스트**를 자동으로
돌린다 — 아카이브에서 읽어 원본과 대조하는 것이 "복구가 되는 백업"의
유일한 증거다. 그래도 삭제 후 깨진 것을 발견했다면 남은 카드는 DB 백업의
PITR(시점 복구)로 삭제 직전 시점의 스냅샷을 별도 인스턴스에 복원해 그
범위만 다시 추출하는 것이다 — 그래서 대량 삭제 일정은 **백업 보존 기간
안에서 잡고, 삭제 전 스냅샷을 하나 더 뜬다**. 이 답에서 면접관이 듣고
싶은 문장은 "삭제는 되돌릴 수 없으니 되돌릴 수 있는 지점을 삭제 전에
만들어 둔다"이다.

### "다 지웠는데 디스크가 안 줄었습니다. 왜죠? 어떻게 회수하나요?" (가산점 포인트)

InnoDB의 DELETE는 페이지를 비울 뿐 **테이블스페이스 파일(`.ibd`)을 OS에
돌려주지 않는다.** 빈 페이지는 그 테이블의 free 목록에 들어가 이후
INSERT가 재사용한다 — 그래서 "앞으로 3개월치가 다시 쌓일 자리"로는
쓸모가 있지만 디스크 알람은 그대로다. 회수 방법은 셋뿐이고 전부 "테이블을
새로 쓰는 것"이다: `OPTIMIZE TABLE`(= `ALTER TABLE ... FORCE`, 재구성 →
online-ddl의 디스크 2배·MDL·복제 지연 사슬), 복사 후 RENAME(2-3), 파티션
DROP(2-2, 파티션 파일 자체가 사라지므로 즉시). 그래서 "디스크 회수"가
목적이라면 청크 삭제는 **절반의 답**이고, 처음부터 그 목적을 말하고
접근법을 골라야 한다. `information_schema.TABLES`의 `DATA_FREE`로
"지웠지만 회수 안 된 공간"을 숫자로 볼 수 있다.

### "PostgreSQL이면 같은 문제인가요?" (가산점 포인트)

큰 그림은 같고 부품 이름이 다르다. PostgreSQL은 undo 대신 **행의 옛
버전을 테이블 안에 그대로 남기는(dead tuple)** MVCC라 대량 DELETE 후
**VACUUM**이 dead tuple을 치우기 전까지 테이블·인덱스 bloat가 그대로 남고,
VACUUM도 공간을 OS에 돌려주지는 않는다(`VACUUM FULL`은 재작성 + 배타
락이라 사실상 `OPTIMIZE TABLE`과 같은 위치, 무중단은 `pg_repack`). 긴
트랜잭션이 VACUUM을 막아 bloat가 커지는 사슬은 InnoDB의 purge 정지와
정확히 대응한다. 파티션은 선언적 파티셔닝으로 `DROP TABLE`/`DETACH
PARTITION`(CONCURRENTLY 옵션)이 가능하고, **PK·유니크에 파티션 키가
포함돼야 하는 제약은 PostgreSQL도 같다.** 차이는 PostgreSQL이 파티션
테이블에서도 FK를 지원하는 범위가 넓고, 복제가 WAL 스트리밍이라 "거대
트랜잭션 하나가 복제본을 막는" 양상이 binlog와는 다르게 나타난다는 점
정도다. 면접에서 이 질문의 목적은 "MySQL 암기"가 아니라 **원리(과거 버전
보관 → 정리 지연 → 공간·성능 비용)를 다른 엔진에 옮겨 말할 수 있는가**다.

---

## 한 줄 요약

**수억 건 `DELETE` 한 방은 undo 폭증(중단하면 롤백 배증) · 커밋까지 쥐는
락 큐 · binlog 한 덩어리로 인한 복제 지연 · 세컨더리 인덱스 랜덤 I/O ·
공간 미반환이라는 다섯 사슬이 동시에 터지는 장애이므로, "지금 당장이지만
총 I/O 최대·공간 미회수"인 PK 범위 청크 삭제 / "즉시·저비용이지만 사전
파티셔닝·PK에 파티션 키·프루닝 조건·FK 불가"인 파티션 DROP / "공간 완전
회수지만 쓰기 델타·디스크 2배"인 복사 후 RENAME을 조건에 따라 고르고,
아카이브 검증(건수·체크섬) → 드라이런 → 복제 지연 게이트가 있는 청크
루프 → 파티션 자동 생성·드랍 스케줄러 → 테이블 설계 시점의 보존 정책을
사람의 기억이 아니라 코드와 스키마에 고정한다.**
