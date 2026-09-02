# 통계 조회의 분리 — "기능은 다른데 자원은 공유"를 OLTP/OLAP 분리 사다리로 푼다

> 핵심 관전 포인트: **대시보드 집계와 운영 트랜잭션은 "기능은 다른데
> 자원은 공유"하는 관계다. 무거운 집계 쿼리 하나가 ① 대량 페이지를 읽어
> shared_buffers와 OS 페이지 캐시의 핫 데이터를 밀어내고(운영 쿼리가
> 메모리 대신 디스크로 떨어진다) ② 병렬 워커까지 데려가 코어 여러 개와
> 디스크 I/O 큐를 수 분간 점유하고, `work_mem`을 넘친 정렬·해시가 임시
> 파일을 쓰고 ③ 긴 스냅샷(`backend_xmin`)으로 VACUUM을 막아 죽은 튜플을
> 쌓고(bloat) ④ 커넥션(= 백엔드 프로세스)을 오래 쥐고 `ACCESS SHARE` 락으로
> DDL과 그 뒤 쿼리까지 세운다 — 그리고 스탠바이에서 돌려도 WAL 재생과
> 충돌해 **쿼리가 취소되거나 복제 지연을 만든다.** 분리는 사다리로 오른다
> — ⓪ 실시간 요구를 되묻고(하루 지연 허용 가능?) ① 쿼리를 다이어트하고
> ② 통계 전용 스탠바이로 라우팅하고 ③ 집계 테이블 + 사전 계산 배치(또는
> materialized view)로 "조회 시점의 계산"을 "배치 시점의 계산"으로 옮기고
> ④ 임의 분석이 필요해지면 논리 디코딩 CDC로 OLAP 저장소에 뺀다. 각 단은
> 대가가 따른다 — 스탠바이는 `max_standby_streaming_delay`(취소) 대
> `hot_standby_feedback`(프라이머리 bloat)의 삼자택일과 (스탠바이 위에서도
> 여전히 무거운) 자원 경쟁, 집계 테이블은 실시간성 상실과 배치 실패·원본
> 정정 시 보정 부담, OLAP은 이중 저장과 파이프라인 운영. 그리고 어느 단을
> 고르든 통계 쿼리가 운영 DB로 새지 않도록 별도 DataSource·읽기 전용 롤·
> `statement_timeout`·롤 단위 자원 설정·`pg_hba.conf`·ArchUnit으로 코드와
> 권한에 고정한다.**

---

## 0. 질문 + 의도

**질문**: "대시보드용 통계 조회가 운영 트래픽과 같은 DB를 때리고 있습니다.
어떻게 분리하나요? (집계 테이블, 사전 계산 배치, replica)"

**출제 의도**: rationale은 이렇게 적고 있다 — "무거운 집계 쿼리 하나가
운영 트랜잭션의 락·버퍼·CPU를 잠식하는 것은 **'기능은 다른데 자원은
공유'하는 문제의 전형**이다. **실시간 요구를 되물어(하루 지연 허용 가능?)
사전 계산으로 내리는 협상**까지 — OLTP와 OLAP를 분리하는 감각(12장 CQRS의
실용 판)을 확인한다."

세 문장이 각각 채점 지점이다.

- **"잠식"을 메커니즘으로 말하는가** — "부하가 커진다"가 아니라
  shared_buffers·CPU·I/O 큐·VACUUM·커넥션·테이블 락 중 **무엇이 어떻게**
  잠식되는지. PostgreSQL은 MVCC 옛 버전이 힙 안에 남고 커넥션이 프로세스라
  잠식의 모양이 MySQL과 다르다 — 그 차이까지 말하면 "써 본 사람"이다.
- **기술 해법 이전에 요구를 되묻는가** — 괄호 안의 세 단어(집계 테이블,
  사전 계산 배치, replica)는 전부 "실시간이 아니어도 된다"는 합의 위에서
  싸진다. 그 합의를 끌어내는 대화를 해봤는지 본다.
- **OLTP/OLAP 분리를 감각으로 갖고 있는가** — 같은 데이터라도 "건별로
  쓰고 읽는 일"과 "수억 건을 훑어 숫자 하나로 접는 일"은 저장 구조부터
  다른 시스템이 맞다는 것. 12장 CQRS(읽기 모델 분리)의 실용 판이다.

> 이 문서는 사전 학습용이다. 4장에서 반복된 네 가지 공백을 이 질문의
> 해당 지점에서 명시적으로 겨냥한다 — ① 비용을 **이름 붙은 메커니즘
> 사슬**로 말하기(§1-2) ② 해법마다 **대가를 한 호흡에** 붙이기(§3)
> ③ 결정을 **코드·권한·설정으로 고정**하기(§5) ④ **"분리 단계 사다리"를
> 목록으로 인출**하기(§2). 리플리카 라우팅의 구현 상세(`AbstractRoutingDataSource`,
> `LazyConnectionDataSourceProxy` 함정, lag 계측, read-your-writes)는
> [`../03-jpa-orm/23-read-replica-routing-and-lag.md`](../03-jpa-orm/23-read-replica-routing-and-lag.md)에서
> 이미 다뤘으므로 링크로 넘기고, 여기서는 **OLTP/OLAP 분리 판단과 집계
> 테이블·배치 설계, 그리고 PostgreSQL 스탠바이 고유의 충돌 문제**에 지면을 쓴다.

## 1. 왜 같은 DB에 두면 안 되는가 — OLTP와 OLAP는 자원을 정반대로 쓴다

### 1-1. 두 워크로드의 모양

| 항목 | OLTP (운영 트랜잭션) | OLAP (대시보드 집계) |
|---|---|---|
| 한 번에 만지는 행 | 수 건 ~ 수십 건 | 수십만 ~ 수억 건 |
| 접근 방식 | 인덱스로 콕 찍는 랜덤 접근(`Index Scan`) | 범위 스캔·`Seq Scan` + GROUP BY·정렬 |
| 쿼리 1건 실행 시간 | 밀리초 | 초 ~ 분 |
| 동시 실행 수 | 초당 수백 ~ 수천 | 초당 몇 건 |
| 최적 저장 구조 | 행 저장(힙) + B-tree | 열 저장(column store) |

OLTP(Online Transaction Processing)는 "주문 한 건 넣고, 주문 한 건
읽는" 일이고, OLAP(Online Analytical Processing)는 "지난 3년 주문을 셀러별·
월별로 접어 매출 추이를 만드는" 일이다. **같은 `orders` 테이블을 보지만
DB에게 시키는 일의 성격이 반대다.** PostgreSQL의 `shared_buffers` 크기,
인덱스 구조, 커넥션(프로세스) 수, `work_mem`, autovacuum 임계는 전부 OLTP에
맞춰 조정돼 있고, 그 위에서 OLAP 쿼리를 돌리면 OLAP만 느린 게 아니라
**OLTP가 같이 느려진다.**

비유하면 **편의점 계산대(OLTP) 직원에게 손님 줄이 선 채로 창고 재고
전수조사(OLAP)를 시키는 것**이다. 전수조사가 느린 것은 둘째 문제고, 그동안
계산대 줄이 안 빠지는 것이 첫째 문제다.

### 1-2. 해악의 메커니즘 사슬 — "부하가 커진다"를 자원 다섯 개로 쪼개기

> 겨냥하는 공백 ①: 4장 기본 구간 내내 비용을 말할 때 "성능 저하", "부하
> 증가", "메모리 부하"에서 멈췄다. 이 질문에서 "집계 쿼리가 운영에 왜
> 해롭죠?"에 "DB가 바빠져서요"는 **답의 제목**이다. 아래 다섯 사슬을
> **자원 이름 → 원인 → 운영 쿼리에 나타나는 결과**의 화살표로 말할 수
> 있어야 한다.

```text
집계 쿼리 1건 (예: 3년치 orders ⋈ order_items GROUP BY seller_id, month)
   │
   ├─ A. 캐시(두 겹): 대량 페이지 읽기 → shared_buffers는 링 버퍼로 일부 방어하지만 OS 페이지 캐시는 통째로 갈림
   │                  → 운영 쿼리가 메모리 대신 디스크 랜덤 I/O로 떨어짐
   ├─ B. CPU·I/O 큐·임시 파일: 병렬 워커 포함 코어 2~3개를 수 분간 점유 + 대량 순차 읽기가 디스크 큐를 채움
   │                  + work_mem 초과분이 임시 파일(쓰기 I/O)로 → 운영 쿼리의 작은 랜덤 읽기가 그 뒤에 줄을 섬 (await ↑)
   ├─ C. MVCC/VACUUM: 수 분짜리 스냅샷(backend_xmin) → 그 뒤 생긴 죽은 튜플을 VACUUM이 못 치움
   │                  → 힙·인덱스 bloat, visibility map 낡음 → Index Only Scan이 힙 페치로 퇴화
   ├─ D. 커넥션·락: 백엔드 프로세스 하나를 수 분 점유(풀 고갈) + ACCESS SHARE 락 → ACCESS EXCLUSIVE(DDL)가 대기
   │                  → 그 DDL 뒤로 오는 쿼리 전부 대기
   └─ E. (스탠바이로 보내도) WAL 재생과 충돌 → 쿼리 취소(conflict with recovery) 또는 재생 지연 ↑ → "쓰고 바로 읽으면 없어요"
   │
   ▼
운영 API p99 ↑, 커넥션 풀 pending ↑, DB CPU·디스크 %util ↑ — "배포도 안 했는데" 느려진다
```

### 사슬 A — 캐시 오염: PostgreSQL은 캐시가 두 겹이다

PostgreSQL은 디스크 페이지를 **`shared_buffers`**(기본 128MB, 운영에서는
보통 메모리의 1/4 안팎)에 올리고, 그 아래에 **OS 페이지 캐시**가 한 겹 더
있다(이중 캐시). 운영 쿼리가 빠른 이유는 자주 쓰는 페이지(최근 주문, 인기
상품, 활성 유저)가 이 두 겹 중 어딘가에 **이미 있어서**다. 그런데 집계
쿼리가 3년치 주문 페이지 수백만 개를 읽어 올리면, 캐시는 크기가 정해져
있으므로 **누군가는 쫓겨나야 한다.** 쫓겨나는 것이 운영의 핫 페이지면,
다음 운영 쿼리는 메모리 대신 디스크로 간다 — 그것도 인덱스 탐색 특유의
**랜덤 I/O**로.

사슬로 말하면: **대량 페이지 적재 → 캐시에서 핫 페이지 축출 → 캐시
히트율 하락 → 운영 쿼리 디스크 랜덤 읽기 증가 → 응답시간 ↑ + 디스크 큐
적체(사슬 B로 연결).** 시그니처는 `pg_stat_database`의 `blks_read`가
`blks_hit` 대비 급증하는 것, `pg_statio_user_tables.heap_blks_read`의
상승, 그리고 PG 16+라면 `pg_stat_io`에서 `context = 'bulkread'`의 `reads`가
튀는 것이다. 확장 `pg_buffercache`를 깔면 지금 shared_buffers 안에 어느
테이블 페이지가 몇 개 있는지 직접 셀 수 있다.

여기서 한 단계 더 아는 사람이 하는 말 (가산점 포인트): **PostgreSQL에는
이 문제를 알고 만든 방어가 있다.** `shared_buffers`의 1/4보다 큰 테이블을
`Seq Scan`할 때는 일반 버퍼 대신 **256KB짜리 작은 링 버퍼**(bulkread
전략)를 돌려 쓴다 — 읽은 페이지를 링 안의 몇십 개 버퍼에서 재활용하므로
shared_buffers의 핫 페이지를 직접 밀어내지 않는다. **그래서 "풀스캔 한 번 =
shared_buffers 전멸"은 과장이다.** 그러나 방어는 뚫린다 — ① **OS 페이지
캐시에는 이런 보호가 없다.** 3년치 페이지는 커널 캐시를 통째로 갈아엎고,
평소 shared_buffers 미스를 받아주던 2차 방어선이 사라져 미스가 곧 디스크
읽기가 된다. ② 링은 `Seq Scan`에만 붙는다 — `Bitmap Heap Scan`·`Index
Scan`으로 넓게 읽는 집계, 해시 조인 빌드, 정렬 스필의 임시 파일은 일반
경로다. ③ 대시보드 위젯 6개가 같은 테이블을 6번 훑으면 링 버퍼 때문에
shared_buffers에 **남지 않으므로** 매번 OS 캐시나 디스크에서 다시 읽는다 —
방어가 도리어 반복 비용이 되고, 그 6번이 OS 캐시를 계속 갈아엎는다.
면접에서 "방어가 있지만 이런 경우 뚫린다"까지 말하면 버퍼를 실제로
들여다본 사람으로 보인다.

> MySQL 대조: InnoDB는 캐시가 버퍼 풀 한 겹이고(O_DIRECT로 OS 캐시를
> 우회), 방어는 midpoint insertion LRU — 새 페이지는 old 영역(기본 37%)에
> 들어가고 `innodb_old_blocks_time`(기본 1초) 안의 재접근은 young으로
> 승격되지 않는다. 시그니처는 `Innodb_buffer_pool_reads` /
> `Innodb_buffer_pool_read_requests`. 뚫리는 조건도 비슷하다(재스캔·조인으로
> 1초 뒤 재접근 → 승격).

### 사슬 B — CPU 코어, 디스크 I/O 큐, 그리고 임시 파일

- **CPU**: PostgreSQL에서 쿼리 하나는 백엔드 프로세스 하나가 실행한다 —
  그런데 대량 집계는 플래너가 **병렬 쿼리**로 만들기 딱 좋은 모양이라
  `max_parallel_workers_per_gather`(기본 2)만큼 워커가 붙어 리더 포함
  **코어 3개**를 쓴다(`Gather` 아래 `Parallel Seq Scan` → `Partial
  HashAggregate`). 8코어 서버에서 집계 쿼리 하나는 운영 처리 능력의 3/8을
  수 분간 가져가는 것이고, 위젯 3개면 사실상 전부다. 남은 코어에 운영
  프로세스가 몰리면 컨텍스트 스위칭 비용이 얹힌다
  ([`15-connection-count-vs-throughput.md`](15-connection-count-vs-throughput.md) §2 사슬 A).
  좋은 소식은 이 병렬도를 **롤 단위로 0으로 박을 수 있다**는 것(§5-3).
- **디스크 큐**: 집계가 읽는 과거 데이터는 캐시에 없으므로 디스크에서
  **대량의 순차 읽기 스트림**이 들어온다. 디스크(SSD 포함)가 동시에 처리할
  수 있는 요청 수에는 상한이 있어, 운영 쿼리의 **작은 랜덤 읽기가 그
  스트림 뒤에 줄을 선다** — `iostat`의 `await`가 오르고, 운영 쿼리 하나의
  실행 시간이 늘어난다.
- **임시 파일**: 정렬·해시 집계·해시 조인은 각각 `work_mem`(기본 4MB,
  **노드당·프로세스당**; 해시는 × `hash_mem_multiplier` 2.0)까지만 메모리를
  쓰고 넘치면 임시 파일로 흘린다 — 계획에 `Sort Method: external merge
  Disk: ...`, `Batches: 65`, `Buffers: temp read=... written=...`로 찍히고
  `pg_stat_database.temp_files/temp_bytes`가 는다(`log_temp_files`로 로그).
  읽기 부하였던 집계가 **쓰기 I/O까지** 만들기 시작하는 지점이다. "그럼
  `work_mem`을 올리면?" — 노드당·프로세스당이라 위젯 6개 × 프로세스 3개 ×
  노드 2개 = 36배로 곱해져 운영 메모리를 먹고 OS 캐시를 더 줄인다(사슬 A로
  되돌아감). 통계 롤에만 적당히 주는 것이 답이다(§5-3).

이 사슬이 계획에 어떻게 찍히는지 한 번 보면 잊히지 않는다.

```text
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.seller_id, date_trunc('month', o.paid_at) AS month, sum(oi.amount)
FROM orders o JOIN order_items oi ON oi.order_id = o.id
WHERE o.paid_at >= now() - interval '3 years'
GROUP BY 1, 2;

 Finalize GroupAggregate  (actual time=598210.4..612044.9 rows=1183220 loops=1)
   Buffers: shared hit=51230 read=9137684, temp read=812340 written=812340  ← 읽은 페이지 914만 개(≈ 70GB) + 임시 파일 6GB
   ->  Gather Merge  (actual rows=1190412 loops=1)
         Workers Planned: 2  Workers Launched: 2                             ← 리더 + 워커 2 = 코어 3개
         ->  Sort  (actual rows=396804 loops=3)
               Sort Key: o.seller_id, (date_trunc('month', o.paid_at))
               Sort Method: external merge  Disk: 1638400kB                 ← work_mem 초과 → 디스크 정렬
               ->  Partial HashAggregate  (actual rows=396804 loops=3)
                     Batches: 65  Memory Usage: 8241kB  Disk Usage: 1195008kB  ← 해시 집계도 스필
                     ->  Parallel Hash Join  (actual rows=41203311 loops=3)
                           ->  Parallel Seq Scan on order_items oi           ← 3년치 전부 (링 버퍼 경로)
                                 Buffers: shared read=6120433
                           ->  Parallel Hash
                                 Buckets: 4194304  Batches: 32  Memory Usage: 262176kB   ← 해시 조인도 32조각으로 스필
                                 ->  Parallel Seq Scan on orders o
                                       Filter: (paid_at >= (now() - '3 years'::interval))
                                       Rows Removed by Filter: 41210
                                       Buffers: shared read=3017251
 Planning Time: 0.9 ms
 Execution Time: 612390.2 ms                                                ← 10분
```

`shared read`(디스크·OS 캐시에서 온 페이지)가 사슬 A, `Workers Launched`가
코어 점유, `temp written`·`Disk:`·`Batches`가 임시 파일 — **사슬 B 전체가
`BUFFERS` 한 줄에 들어 있다.**

사슬로 말하면: **집계 프로세스 여럿의 코어 점유 + 대량 순차 읽기 + 임시
파일 스필 → 운영 쿼리의 CPU 대기와 I/O 큐 대기 → 쿼리당 실행 시간 ↑ →
커넥션 점유 시간 ↑ → 풀 pending(사슬 D로 연결).**

> MySQL 대조: 쿼리 = 스레드 1개(병렬 실행 없음)라 코어 1개다.
> `sort_buffer_size`·`tmp_table_size`를 넘으면 `Sort_merge_passes`·
> `Created_tmp_disk_tables`가 는다. "쿼리 하나가 코어 여러 개를 가져갈 수
> 있다"는 PostgreSQL 쪽 추가 항목이다.

### 사슬 C — 긴 스냅샷 → VACUUM 정지 → bloat

MVCC에서 SELECT는 락을 안 잡는 대신 **자기가 시작한 시점의 스냅샷**을 들고
있다. 10분짜리 집계는 10분 동안 스냅샷을 쥔다 — READ COMMITTED여도 **그
문장이 끝날 때까지**, REPEATABLE READ면 트랜잭션 끝까지다. 그 스냅샷의
하한이 `pg_stat_activity.backend_xmin`이고, **VACUUM은 가장 오래된
`backend_xmin`보다 뒤에 죽은 튜플을 치우지 못한다**(autovacuum 로그에
"dead but not yet removable, oldest xmin: ..."로 찍힌다). 그 사이 운영
트랜잭션들이 만든 옛 버전은 "저 스냅샷이 볼 수도 있는 버전"이라 남는다.

PostgreSQL이 MySQL과 다른 지점은 **그 옛 버전이 별도 공간이 아니라 힙
페이지 안에 그대로 남는다**는 것이다. 그래서 대가가 힙과 인덱스 자체에
나타난다.

사슬로 말하면: **긴 스냅샷 보유 → VACUUM이 죽은 튜플 회수 불가 → ① 핫
테이블의 페이지가 죽은 튜플로 차서 같은 행 수를 읽는 데 더 많은 페이지
(사슬 A 가중) ② 페이지 여유가 없어 HOT 갱신이 깨지고 모든 인덱스에 새
엔트리(인덱스 bloat) ③ 갱신으로 내려간 visibility map 비트를 VACUUM이 다시
못 올려 운영 쿼리의 `Index Only Scan`이 `Heap Fetches`로 퇴화 → 집계가
끝나면 밀린 autovacuum이 한꺼번에 돌아 I/O 스파이크.** 이 사슬은
[`11-mvcc-postgresql.md`](11-mvcc-postgresql.md) §3에서 이미 고정했다 —
여기서는 "그 긴 트랜잭션의 대표 주범이 대시보드 집계"라는 것만 붙이면 된다.
집계 쿼리는 `orders`만 보지만 청구서는 `users`·`products`를 읽는 조회들이
받는다. **`backend_xmin`은 테이블 단위가 아니라 데이터베이스 단위이기
때문이다.** 오래 반복되면 XID wraparound 여유도 줄어 anti-wraparound
VACUUM이라는 가장 시끄러운 손님을 부른다.

> MySQL 대조: InnoDB는 옛 버전을 언두 로그에 두므로 같은 해악이 "purge
> 정지 → history list length 증가 → 핫 로우의 버전 체인 순회(언두 페이지를
> 버퍼 풀로 끌어올리며)"로 나타난다. 위치가 다를 뿐 "긴 읽기가 정리를
> 막는다"는 같다. PostgreSQL 쪽 추가 함정은 죽은 튜플이 힙 안에 있어 회수가
> 늦으면 **테이블 파일 자체가 커지고**, 커진 파일은 일반 VACUUM으로 안
> 줄어든다는 것(`pg_repack`/`VACUUM FULL`).

### 사슬 D — 커넥션(= 프로세스) 점유와 테이블 락

- **커넥션**: 대시보드가 운영 커넥션 풀(예: 최대 20)을 같이 쓰면, 위젯
  6개 × 동시 사용자 2명 = 커넥션 12개가 수 분간 사라진다. 운영 요청은
  남은 8개를 두고 줄을 서고, `connection-timeout`이 지나면 500이 난다.
  DB가 멀쩡해도 앱이 먼저 죽는 경로다
  ([`../02-spring/26-hikaricp-connection-pool-exhaustion.md`](../02-spring/26-hikaricp-connection-pool-exhaustion.md)).
  PostgreSQL에서는 커넥션이 OS 프로세스이므로 그 12개는 **CPU 100%로 도는
  프로세스 12개**이기도 하다 — `pg_stat_activity`에 `state = 'active'`,
  `now() - query_start`가 수 분인 행으로 보인다.
- **테이블 락**: SELECT는 행 락을 안 잡지만 **테이블 구조가 도중에 바뀌지
  않도록 `ACCESS SHARE` 락은 잡는다** — 문장이 끝날 때까지(명시적
  트랜잭션이면 커밋까지). 이때 누군가 `ALTER TABLE orders ADD COLUMN ...`을
  실행하면 `ACCESS EXCLUSIVE`가 필요해 집계가 끝날 때까지 기다리고,
  PostgreSQL의 락 큐는 **선착순이라 그 ALTER 뒤로 들어오는 `orders`에 대한
  모든 SELECT·INSERT가 ALTER 뒤에 줄을 선다.** `pg_stat_activity`에
  `wait_event_type = 'Lock'`, `wait_event = 'relation'`이 수십 개 찍히고
  `pg_blocking_pids()`가 전부 집계 쿼리의 pid를 가리키며 주문 테이블이
  통째로 멈춘다. `ADD COLUMN` 자체는 카탈로그만 고치는 1ms짜리 작업인데도
  그렇다. "통계 쿼리 하나 + 컬럼 추가 하나 = 테이블 정지"다. DDL 쪽 방어는
  `SET lock_timeout = '2s'` + 재시도
  ([`14-online-ddl-zero-downtime-schema-change.md`](14-online-ddl-zero-downtime-schema-change.md)).
  일반 autovacuum은 `SHARE UPDATE EXCLUSIVE`라 `ACCESS SHARE`와 충돌하지
  않는다 — 사슬 C가 "락"이 아니라 "xmin" 때문인 이유다.

> MySQL 대조: 같은 현상이 메타데이터 락(MDL)으로 난다 — `SHOW PROCESSLIST`의
> `Waiting for table metadata lock`. 온라인 DDL도 시작과 끝에 잠깐 배타
> MDL이 필요하므로 줄 세우기는 동일하다.

### 사슬 E — 스탠바이로 보내도 남는 것: 취소 아니면 지연 아니면 프라이머리 bloat

"그럼 스탠바이에서 돌리면 되죠"는 2단(§2-2)의 정답이지만 **공짜가 아니다.**
PostgreSQL의 스트리밍 복제 스탠바이는 프라이머리의 WAL을 받아 startup
프로세스가 재생(replay)하는데, **재생과 스탠바이 위의 긴 쿼리는 충돌한다.**

- **스냅샷 충돌**: 프라이머리에서 VACUUM이 죽은 튜플을 치운 WAL 레코드가
  도착했는데, 스탠바이의 집계 쿼리가 아직 그 버전을 볼 수 있는 스냅샷을
  쥐고 있다.
- **락 충돌**: 프라이머리에서 실행된 DDL(`ACCESS EXCLUSIVE`)의 WAL이
  도착했는데, 스탠바이의 집계가 그 테이블에 `ACCESS SHARE`를 쥐고 있다.

충돌하면 재생은 `max_standby_streaming_delay`(기본 30초)까지 기다렸다가
**쿼리를 강제 취소**한다 — `ERROR: canceling statement due to conflict with
recovery`. 즉 스탠바이의 **기본 동작은 "재생 30초 지연 → 집계 취소"**다.
취소 횟수는 스탠바이의 `pg_stat_database_conflicts`(`confl_snapshot`,
`confl_lock`, ...)에 쌓인다. 여기서 선택지가 갈리고, 어느 쪽도 공짜가 아니다.

- `max_standby_streaming_delay`를 크게(또는 `-1` = 무한 대기) → 취소는 안
  되지만 **재생이 집계가 끝날 때까지 멈춘다** → lag가 집계 시간만큼 → 그
  스탠바이를 함께 쓰는 운영 읽기가 옛 데이터를 본다("등록했는데 목록에
  없어요", 라우팅 문서 §4).
- `hot_standby_feedback = on` → 스탠바이가 자기 가장 오래된 xmin을
  프라이머리에 보고하고, 프라이머리 VACUUM이 그 튜플을 안 치운다 → 스냅샷
  충돌 자체가 사라진다. **대신 사슬 C가 프라이머리로 옮겨온다** — 스탠바이의
  14분짜리 집계가 프라이머리의 VACUUM을 14분 멈춘다(락 충돌은 여전히 남는다).

**비용이 사라지지 않고 자리만 옮긴다** (가산점 포인트). 그리고 충돌과 별개로
집계가 스탠바이의 CPU·디스크 큐를 점유하면 **startup 프로세스도 같은 줄에
서서** 재생 처리량 자체가 떨어진다. 관찰은 프라이머리의
`pg_stat_replication.replay_lag`(와 `backend_xmin` — feedback으로 넘어온
xmin), 스탠바이의 `now() - pg_last_xact_replay_timestamp()`.

> MySQL 대조: binlog 레플리카는 쿼리를 취소하지 않는다. 대신 applier
> 스레드가 집계 SELECT의 MDL에 막혀 `Seconds_Behind_Source`가 집계 시간만큼
> 한 번에 튄다 — MySQL은 "지연만", PostgreSQL은 "취소 / 지연 / 프라이머리
> bloat" 중 택일이다. 또 MySQL 레플리카는 인덱스를 프라이머리와 다르게 둘 수
> 있지만 PostgreSQL 물리 스탠바이는 바이트 동일이라 **통계용 인덱스를 따로
> 못 만든다** → 그게 필요하면 논리 복제(§2-2).

### 다섯 사슬을 한 문장으로

> "집계 쿼리 하나가 **캐시에선 핫 페이지 축출과 OS 캐시 오염, CPU·디스크에선
> 병렬 워커의 코어 점유와 I/O 큐 적체와 임시 파일, MVCC에선 VACUUM 정지와
> bloat, 커넥션 풀에선 프로세스 장기 점유, 락에선 DDL 뒤 대기열**을 만들어
> 그와 무관한 운영 쿼리 하나하나를 느리게 하고, 스탠바이로 옮겨도 WAL 재생과
> 충돌해 취소되거나 지연을 만들거나 feedback으로 프라이머리 bloat를 되돌려
>준다."

### 1-3. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 이렇게 말하면 제목만 말한 것 | 이렇게 바꾼다 |
|---|---|
| "DB에 부하가 가요" | "집계가 읽어 올린 페이지가 운영 핫 페이지를 OS 캐시와 shared_buffers에서 밀어내서, 운영 쿼리가 디스크 랜덤 I/O로 떨어집니다. 병렬 워커까지 붙으면 코어도 3개씩 가져갑니다" |
| "락 때문에 느려져요" | "SELECT는 행 락은 안 잡지만 ACCESS SHARE를 잡아서, ALTER 하나가 걸리면 그 뒤 쿼리가 전부 대기합니다. 그리고 긴 스냅샷이 backend_xmin을 잡아 VACUUM이 멈추고 무관한 테이블까지 bloat가 쌓입니다" |
| "커넥션이 부족해져요" | "위젯당 백엔드 프로세스 하나를 수 분씩 쥐어서 운영 풀 20개 중 12개가 사라지고, 운영 요청이 connection-timeout에서 실패합니다" |
| "replica로 보내면 돼요" | "스탠바이로 보내면 프라이머리는 보호되지만, 집계가 WAL 재생과 충돌해 30초 뒤 취소되거나, 취소를 막으면 재생이 밀려 그 스탠바이를 쓰는 운영 읽기가 옛 데이터를 보고, hot_standby_feedback으로 막으면 프라이머리 VACUUM이 멈춥니다" |

## 2. 분리 단계 사다리 — 0단부터 4단까지 (암기 목록)

> 겨냥하는 공백 ④: 3장부터 반복된 "이 상황 → 이 도구" 목록 인출 실패.
> 이 질문의 정답은 하나의 기술이 아니라 **순서가 있는 목록**이다. 아래
> 다섯 줄을 통째로 외우고, 각 단에서 "무엇을 무엇으로 바꾸는지"를 한
> 구절로 붙인다.

```text
0단  실시간 요구 되묻기          — "하루(혹은 5분) 지연 허용 가능?"  요구를 낮추면 아래 단이 전부 싸진다
1단  쿼리·인덱스 다이어트        — 분리가 아니라 전제 조건. 기간 제한·부분/커버링 인덱스·BRIN·불필요 조인 제거
2단  통계 전용 스탠바이           — 자원 격리(부분). 운영 read 스탠바이와도 분리. 대가: 취소/지연/프라이머리 bloat 삼자택일·여전히 무거움
3단  집계 테이블 + 사전 계산 배치  — 시간 이동: "조회 시점 계산"을 "배치 시점 계산"으로. PG 변종: materialized view. 대가: 실시간성·보정
4단  논리 디코딩 CDC → OLAP 저장소 — 시스템 분리: 열 저장소로 임의 분석. 대가: 이중 저장·파이프라인·복제 슬롯 운영
```

사다리를 오르는 방향은 **"운영 DB에서 집계 작업을 얼마나 멀리 떼어
놓는가"** 다. 2단은 같은 데이터의 복제본 위에서 여전히 집계를 실행하고,
3단은 집계 자체를 미리 해두고, 4단은 집계에 맞는 다른 저장소로 옮긴다.
높이 오를수록 운영 격리는 완전해지고 대신 **지연·복잡도·비용**이 는다.

### 2-0. 0단 — 요구를 되묻는다: 협상 대화 예시

기술 해법을 고르기 전에 **"실시간"이 정말 요구인지**를 확인한다. 대부분의
대시보드는 실시간이 아니라 "새로고침하면 바뀌는 것"을 원할 뿐이고, 그
둘은 비용이 수십 배 다르다.

```text
백엔드: 이 대시보드의 "오늘 매출"은 몇 분 전 숫자면 될까요? 지금은 새로고침할
        때마다 주문 테이블 전체를 다시 집계해서, 이게 돌 때 주문 API가 같이
        느려집니다.
기획:   실시간이면 좋죠. 근데 꼭 그래야 하냐고 물으시는 거면… 어디에 쓰느냐에
        따라 다를 것 같아요.
백엔드: 용도를 여쭤볼게요. 이 매출 그래프를 보고 누가 어떤 결정을 하나요?
기획:   마케팅팀이 오전에 어제까지의 추이를 보고 프로모션을 조정해요. 오늘
        숫자는 참고용이고요.
백엔드: 그러면 "어제까지"는 하루 한 번 새벽에 계산해 두고, "오늘"만 5분 간격이면
        될까요? 화면에 "○○:○○ 기준"을 붙여서 몇 분 전 숫자인지 보이게 하고요.
기획:   그건 괜찮아요. 다만 월말 정산 화면은 취소·환불이 정확히 반영돼야 해요.
백엔드: 그 화면은 '정확'이 '실시간'보다 중요하니까 — 마감 시점에 확정 계산을
        돌리고, 마감 전에는 "잠정치"라고 표시하는 걸로 하죠. 이렇게 하면 운영
        DB에는 부하가 거의 안 가고, 정산 숫자도 더 믿을 수 있게 됩니다.
```

이 대화에서 백엔드가 한 일은 세 가지다 — **① 비용을 알려줬고**(운영
API가 느려진다) **② "실시간"을 용도로 분해했고**(의사결정 주기가
하루라면 하루 지연은 손실이 아니다) **③ 항목별로 다른 SLA를 받아냈다.**
결과물은 이런 표다.

| 대시보드 항목 | 허용 지연 | 정확도 | 처리 방식 |
|---|---|---|---|
| 어제까지 일별 매출 추이 | 하루 | 확정치 | 새벽 배치 → 집계 테이블 |
| 오늘 매출 | 5분 | 잠정치 | 5분 배치 또는 스탠바이 위 소량 조회 + 캐시 |
| 월말 정산 | 마감 시점 | 확정치(환불 반영) | 마감 배치 + 재계산 창 |
| 실시간 접속자 수 | 초 | 근사치 허용 | Redis 카운터 (RDB 밖) |

"요구사항의 비용을 알려주는 것까지가 백엔드의 일"이라는 rationale의 관점이
정확히 이 표다. **되묻지 않고 4단으로 직행하면 과잉 설계이고, 되묻지 않고
1단에서 버티면 운영 장애다.**

### 2-1. 1단 — 쿼리 다이어트 (분리 전에 반드시)

분리는 "무거운 쿼리를 옮기는 것"이지 "무거운 쿼리를 가볍게 하는 것"이
아니다. 옮기기 전에 다이어트부터 한다. **다이어트의 본질은 인덱스를 다는
것이 아니라 읽는 페이지 수를 줄이는 것**이다 — 3년치 전체를 접어야 하는
쿼리에는 어떤 인덱스도 도움이 안 되고 `Seq Scan`이 오히려 옳다.

- **기간 제한**: `WHERE paid_at >= $1`이 없는 집계는 테이블이 크는 만큼
  매일 느려진다. 대시보드가 보여주는 범위(최근 90일)만 읽게 한다.
  `paid_at`으로 RANGE 파티셔닝돼 있으면 파티션 프루닝이 같은 효과를 낸다.
- **커버링 인덱스**: `(seller_id, paid_at) INCLUDE (amount)` 같은 인덱스가
  있으면 집계가 힙을 건드리지 않고 `Index Only Scan`으로 끝난다 — 사슬
  A·B가 크게 준다. 단 visibility map이 신선해야 하므로 계획의 `Heap
  Fetches`를 확인한다 ([`09-covering-index.md`](09-covering-index.md)).
  `status IN ('PAID', 'REFUNDED')`처럼 조건이 고정돼 있으면 **부분
  인덱스**(`WHERE status IN (...)`)로 인덱스 자체를 줄인다.
- **BRIN**: 추가 순서대로 쌓이는 `orders.paid_at`처럼 물리 순서와 값 순서의
  상관관계가 높은 컬럼에는 수 MB짜리 BRIN 인덱스로 "이 날짜 범위는 이
  블록 구간에만 있다"를 알려 줘 `Seq Scan`을 범위 스캔으로 바꿀 수 있다 —
  B-tree보다 수백 배 작아 쓰기 비용이 거의 없다.
- **불필요한 조인 제거**: 위젯이 `order_items`를 안 보여주는데 조인돼
  있는 경우가 흔하다. `EXPLAIN (ANALYZE, BUFFERS)`로 `actual rows`와 읽은
  블록 수를 확인한다
  ([`10-explain-and-slow-query-process.md`](10-explain-and-slow-query-process.md)).

다이어트로 충분하면 여기서 멈춰도 된다. 그러나 **"충분"의 기준은 대시보드
응답시간이 아니라 운영 지표(캐시 히트율, p99, pending)** 다. 대시보드는
2초 만에 나오는데 그 2초 동안 운영 p99가 튄다면 다음 단으로 간다.

### 2-2. 2단 — 통계 전용 스탠바이 ("운영 read 스탠바이"와도 분리한다)

운영 DB의 스트리밍 복제 스탠바이(hot standby)에서 집계를 실행한다.
프라이머리는 사슬 A~D에서 벗어난다. 구현(`readOnly` 기반 라우팅, lazy
프록시, lag 계측)은 라우팅 문서에 전부 있으므로 여기서는 **이 문항 고유의
판단 세 가지**만 짚는다.

**첫째, 운영 읽기가 쓰는 스탠바이와 통계용 스탠바이를 분리한다 — 두
스탠바이의 설정이 정반대여야 하기 때문이다.** 같은 스탠바이에 두면 사슬
A·B·C가 그대로 재현돼 **운영 조회(목록·상세)가 느려지고**, 사슬 E로 취소 아니면
lag가 커져 read-your-writes 문제가 잦아진다. 통계 스탠바이는 lag가 10분이어도
상관없지만 취소되면 안 되고, 운영 스탠바이는 lag가 수 초를 넘으면 안 된다 —
**허용 lag가 다른 워크로드는 다른 복제본에 둔다.** `max_standby_streaming_delay`와
`hot_standby_feedback`은 스탠바이별 설정이므로 이것이 가능하다.

```text
primary ──WAL──▶ standby-1, standby-2   ← 운영 읽기 라우팅: max_standby_streaming_delay 짧게(취소 감수), hot_standby_feedback 검토
        └─WAL──▶ standby-stats          ← 대시보드·배치·분석가: max_standby_streaming_delay = -1(지연 감수), hot_standby_feedback = off
                                          statement_timeout 길게 허용, 운영 라우팅 풀에는 절대 안 넣음
```

`synchronous_standby_names`를 쓰고 있다면 통계 스탠바이는 거기서 뺀다 —
특히 `synchronous_commit = remote_apply`라면 재생이 멈춘 스탠바이가
**프라이머리의 커밋을 세운다** (가산점 포인트). 스탠바이가 여럿이면
`standby-stats`는 프라이머리가 아니라 `standby-1`에서 받아오는 cascading
구성으로 프라이머리의 WAL 전송 부담을 줄일 수 있다.

**둘째, 물리 스탠바이는 바이트 동일이라 통계용 인덱스를 못 만든다.**
집계에만 필요한 인덱스(월별 BRIN, 셀러별 커버링)를 운영 테이블에 얹기
싫다면 **논리 복제**(`PUBLICATION`/`SUBSCRIPTION`)로 별도 통계 DB에
테이블을 흘려보낸다 — 구독 쪽은 독립된 DB라 인덱스·스키마·버전이 자유롭고
재생 충돌 개념 자체가 없다. 대가: DDL은 복제되지 않아 컬럼 추가를 양쪽에서
해야 하고, UPDATE/DELETE 복제에 `REPLICA IDENTITY`(보통 PK)가 필요하며,
구독당 apply 워커가 순차 적용이라 프라이머리 쓰기가 많으면 지연되고, 복제
슬롯이 소비되지 않은 WAL을 붙들어 둔다(§2-4).

**셋째, 스탠바이는 "격리"이지 "해결"이 아니다.** 집계 쿼리는 스탠바이에서도
똑같이 10분 걸린다. 대시보드 사용자가 5명이고 하루 몇 번 보는 내부
도구라면 이걸로 충분하다. 사용자가 셀러 10만 명이고 각자 자기 매출을
본다면 스탠바이가 몇 대여도 못 버틴다 — 그때는 3단이다. **2단에서 멈출 수
있는 조건은 "실행 횟수가 적고 실행 시간을 감수할 수 있을 때"** 다.

### 2-3. 3단 — 집계 테이블 + 사전 계산 배치 (이 문항의 중심)

아이디어는 하나다 — **계산을 조회 시점에서 배치 시점으로 옮긴다.** 조회
때마다 3년치 주문을 접는 대신, 새벽에 한 번 접어서 "날짜 × 셀러"당 한
행짜리 작은 테이블에 넣어 두고, 대시보드는 그 테이블에서 몇 행만 읽는다.
조회 비용이 O(주문 수)에서 O(날짜 수)로 떨어지고, 운영 DB는 집계 실행에서
완전히 벗어난다.

[`04-normalization-vs-denormalization.md`](04-normalization-vs-denormalization.md)
§1-2의 "연산(집계) 컬럼"이 행 하나(`posts.comment_count`)에 붙는
반정규화였다면, 집계 테이블은 **테이블 단위의 반정규화**다. 그래서 대가도
같은 종류다 — **원본과 사본이 어긋날 수 있고, 어긋남을 관리하는 장치를
함께 설계해야 한다.** 설계 상세(스키마·증분 배치·실패 보정)는 §4에 코드로
쓴다. 판단만 먼저 정리하면,

- **맞는 경우**: 질문이 고정돼 있다(대시보드 위젯은 정해진 차원으로 정해진
  숫자를 본다). 지연을 분~하루 허용한다. 사용자·조회 횟수가 많다.
- **안 맞는 경우**: 매번 다른 차원으로 자르는 임의 질의(ad-hoc)다 —
  차원 조합마다 집계 테이블을 만들다 보면 테이블이 수십 개가 되고 배치가
  새벽 시간을 다 잡아먹는다. 그 신호가 오면 4단이다.

**PostgreSQL 변종 — materialized view** (가산점 포인트). PG에는 "집계
테이블 + 배치"를 SQL 두 문장으로 주는 도구가 있다.

```sql
-- ✅ 3단의 PG 변종 — 정의 한 번, 갱신은 REFRESH 한 문장
CREATE MATERIALIZED VIEW daily_seller_sales_mv AS
SELECT (o.paid_at AT TIME ZONE 'Asia/Seoul')::date AS stat_date,
       o.seller_id,
       count(*)                                    AS order_count,
       sum(o.amount)                               AS gross_amount,
       sum(coalesce(r.amount, 0))                  AS refund_amount
FROM orders o LEFT JOIN refunds r ON r.order_id = o.id
WHERE o.status IN ('PAID', 'REFUNDED')
GROUP BY 1, 2;

CREATE UNIQUE INDEX ON daily_seller_sales_mv (stat_date, seller_id);   -- CONCURRENTLY 갱신의 필수 조건

-- 새벽마다 (pg_cron: SELECT cron.schedule('10 0 * * *', $$REFRESH MATERIALIZED VIEW CONCURRENTLY daily_seller_sales_mv$$);)
REFRESH MATERIALIZED VIEW CONCURRENTLY daily_seller_sales_mv;
```

코드가 0줄이라는 장점 뒤에 한계 넷을 같은 호흡에 붙여야 한다. ① **증분이
없다** — `REFRESH`는 정의 전체를 다시 실행하므로 3년치를 매일 다시 접는다.
§4-3의 "최근 3일만 재계산" 기법이 불가능해 원본이 크면 배치가 더 무겁다.
② `REFRESH`의 기본 동작은 `ACCESS EXCLUSIVE`로 **읽기까지 막는다**;
`CONCURRENTLY`는 유니크 인덱스가 있어야 하고 새 결과를 임시로 만들어 옛
결과와 대조해 차이만 반영하므로 더 느리고 임시 공간을 쓴다(대신 대시보드가
계속 읽는다). ③ **스탠바이에서는 REFRESH가 불가하다**(읽기 전용) — 원본
읽기가 프라이머리에서 일어나므로 "무거운 읽기는 스탠바이, 가벼운 쓰기만
프라이머리"라는 §4-2의 구조를 못 만든다. ④ 원본이 삭제·정정돼도 다음
REFRESH가 알아서 반영한다는 점은 장점이지만, 그것이 곧 "전체 재계산"이라는
비용의 다른 이름이다. 결론: **원본이 수백만 행 이하거나 파티션 프루닝으로
읽기가 작고, 위젯 몇 개에 하루 1회면 MV로 충분하다.** 3년치 수억 행 +
재계산 창 + 정정 큐가 필요하면 직접 만든 집계 테이블이다. 증분 MV는
확장(`pg_ivm`) 영역이다.

### 2-4. 4단 — 논리 디코딩 CDC → OLAP 저장소

변경 데이터 캡처(CDC, Change Data Capture)는 프라이머리의 WAL을 **논리
디코딩**(`wal_level = logical`, 복제 슬롯, `pgoutput` 플러그인)으로 읽어
행 변경 이벤트를 흘려보내는 방식이다(Debezium PostgreSQL 커넥터가 대표).
이 이벤트를 Kafka를 거쳐 **열 저장소(column store)** — ClickHouse, BigQuery,
Redshift, Snowflake 같은 — 로 적재하면, 분석가가 어떤 차원으로 잘라도
운영 DB는 전혀 모른다.

열 저장소가 집계에 유리한 이유는 구조에 있다. 행 저장소(PG의 힙)는
`sum(amount)` 하나를 구하려 해도 행 전체(수십 컬럼)가 들어 있는 8KB
페이지를 읽지만, 열 저장소는 `amount` 컬럼 블록만 읽는다 — 읽는 바이트가
수십 분의 1이고 같은 타입이 연속돼 압축률도 높다. **OLAP 전용 DB가 따로
존재하는 이유가 이 한 줄이다.** PG 안에서 열 저장을 흉내 내는 확장도 있어
이름만 알아 두면 된다 — Citus의 columnar 저장(`USING columnar`), 시계열
쪽의 TimescaleDB 압축. 다만 이 단의 본질은 확장이 아니라 **"다른
저장소"**이고, 확장을 얹는 선택은 "운영 DB 안에 OLAP를 다시 들인다"는
뜻이라 사슬 A~D가 부분적으로 되돌아온다.

- **맞는 경우**: 임의 질의가 필요하다. 차원이 자주 바뀐다. 데이터 분석가·
  BI 도구가 SQL로 직접 탐색한다. 집계 테이블이 10개를 넘어가며 배치 창이
  모자란다.
- **대가**: 데이터가 두 벌 있다(저장 비용 + 어느 쪽이 정답인지의 규칙).
  파이프라인이 운영 대상이 된다(커넥터 죽음, 오프셋, 재처리). 운영 스키마
  변경이 파이프라인을 깨뜨린다(컬럼 추가·타입 변경 → 스키마 진화 동기화).
  개인정보가 복제되는 범위가 넓어진다(마스킹 설계). 초~분의 최종 일관성.
- **PostgreSQL 고유 함정 — 복제 슬롯** (가산점 포인트): 슬롯은 소비자가
  아직 안 읽은 WAL을 **프라이머리가 지우지 못하게** 붙든다. 커넥터가 죽은
  채 주말을 넘기면 **프라이머리 디스크가 WAL로 찬다.** 방어는
  `max_slot_wal_keep_size`(PG 13+)로 상한을 두고(넘으면 슬롯이 무효화되고
  커넥터는 초기 스냅샷부터 다시), `pg_replication_slots`의 지연을 알람에
  건다. 분석 파이프라인 하나가 운영 DB를 세울 수 있는 경로라 4단의 "파이프라인
  운영"이 말뿐이 아님을 보여 주는 예다.

### 2-5. 어느 단에서 멈추나 — 판단 기준 한 표

| 상황 | 멈출 단 |
|---|---|
| 지연 허용 안 됨 + 쿼리를 인덱스·파티션으로 가볍게 만들 수 있음 | 1단 |
| 초 단위 지연 OK, 쿼리 고정, 내부 사용자 소수, 실행 횟수 적음 | 2단 |
| 분~하루 지연 OK, 질문 고정(위젯), 원본 작음 | 3단 — materialized view + pg_cron |
| 분~하루 지연 OK, 질문 고정(위젯), 사용자·조회 횟수 많음, 원본 큼 | 3단 — 집계 테이블 + 증분 배치 (+2단 위에서 배치 실행) |
| 임의 질의, 차원 다수, 분석가 존재, 집계 테이블 폭증 | 4단 |

실무에서 가장 흔한 착지는 **2단 + 3단의 조합**이다 — 배치는 통계 스탠바이에서
읽어 계산하고, 결과만 프라이머리의 작은 테이블에 쓰고(그 테이블은 다시
스탠바이로 복제된다), 대시보드는 스탠바이에서 그 작은 테이블을 읽는다.

## 3. 트레이드오프 양면 — 세 해법을 한 호흡에

> 겨냥하는 공백 ②: 3장에서 3회, 4장 Q4에서 재발한 "편익만 말하고 대가는
> 물어봐야 나오는" 습관. 이 질문은 괄호 안에 해법 셋을 적어줬으므로,
> 면접관은 "셋 중 뭘 쓰겠느냐"가 아니라 **"각각 무엇을 얻고 무엇을
> 내주는지를 같은 문장 안에서 말하는가"** 를 본다. 얻는 것 → 내주는 것 →
> 내준 것을 관리하는 장치, 이 세 박자를 한 호흡으로.

| 해법 | 얻는 것 | 내주는 것 | 내준 것을 관리하는 장치 |
|---|---|---|---|
| **스탠바이 라우팅** | 프라이머리 자원 격리, 코드 변경 최소, 데이터는 항상 "거의 최신" | 재생 충돌의 삼자택일 — 취소(`max_standby_streaming_delay`) / 지연(그 스탠바이를 운영 읽기가 같이 쓰면 read-your-writes 깨짐) / 프라이머리 bloat(`hot_standby_feedback`), 스탠바이 위에서도 여전히 무거움, 인덱스 못 바꿈, 인프라 비용 | 통계 전용 스탠바이 분리(delay -1, feedback off), lag·취소 카운트 계측, 화면에 "N분 전 기준" 표시 |
| **집계 테이블 + 배치** | 조회 비용 O(날짜 수), 운영 DB는 집계에서 완전 해방, 사용자 수에 무관 | **실시간성 상실**, 배치 실패·지연·중복 실행 시 틀린 숫자, 원본 정정(환불·취소)의 재반영, 질문이 바뀌면 테이블·배치도 바뀜 | 멱등 재계산 + `ON CONFLICT` UPSERT, 재계산 창, 배치 상태 테이블과 성공 시각 노출, 지연 알람, 주기 보정 |
| **materialized view** (위의 PG 변종) | 코드 0줄, 정정·삭제 자동 반영, `CONCURRENTLY`면 갱신 중 읽기 가능 | 전량 재계산(증분 없음), 프라이머리에서만 REFRESH 가능(원본 읽기가 프라이머리로), 유니크 인덱스 필수, 갱신 시 임시 공간 | 원본을 파티션·기간으로 작게 유지, `pg_cron` 실패 알람, 갱신 소요 시간 추적 |
| **CDC → OLAP 저장소** | 임의 질의·차원 자유, 열 저장 압축·속도, 분석 워크로드가 운영에서 완전 분리 | **이중 저장 비용**, 파이프라인이 운영 대상(커넥터·슬롯·재처리), 스키마 진화 동기화, 최종 일관성, 개인정보 복제 범위, 복제 슬롯의 WAL 보존 위험 | 스키마 레지스트리, 정합성 검증 잡(건수·합계 대사), 마스킹, 슬롯 지연·`max_slot_wal_keep_size` |

표를 양면 문장으로 조립하면 이렇게 된다 — 면접에서 그대로 말하는 형태다.

> "**스탠바이로 보내면** 프라이머리는 캐시·CPU·VACUUM 잠식에서 벗어나고
> 코드도 거의 안 바뀌지만, **대신** 긴 집계가 WAL 재생과 충돌해 30초 뒤
> 취소되거나, 취소를 막으면 재생이 밀리거나, feedback을 켜면 프라이머리
> VACUUM이 멈추는 셋 중 하나를 골라야 하고, 집계 자체는 스탠바이에서 여전히
> 10분이 걸려서 사용자가 많아지면 못 버팁니다. 그래서 통계 전용 스탠바이를
> 따로 두고 delay는 -1, feedback은 off로 두고 lag를 지표로 봅니다.
> **집계 테이블로 내리면** 조회가 수 밀리초로 떨어지고 운영 DB는 집계에서
> 완전히 해방되지만, **대신** 실시간성을 잃고 배치가 실패하거나 두 번 돌거나
> 원본이 나중에 정정되면 숫자가 틀립니다. 그래서 배치를 구간 재계산 +
> `ON CONFLICT` UPSERT로 멱등하게 만들고 재계산 창과 성공 시각을 화면에
> 노출합니다. 원본이 작으면 materialized view + `REFRESH CONCURRENTLY`로
> 같은 걸 코드 없이 얻을 수 있지만 전량 재계산이라 원본이 크면 안 맞습니다.
> **CDC로 OLAP 저장소에 빼면** 어떤 차원으로 잘라도 운영이 모르지만,
> **대신** 데이터가 두 벌이 되고 파이프라인과 복제 슬롯이 새 운영 대상이
> 되며 스키마 변경 때마다 동기화를 챙겨야 합니다. 그래서 질문이 고정된
> 대시보드에는 과합니다."

덧붙일 양면 하나 더 — **"실시간을 잃는다"는 항상 손실이 아니다.** 집계
테이블은 배치가 끝난 시점의 **일관된 스냅샷**이라 "위젯 A는 10:00 기준,
위젯 B는 10:03 기준"처럼 위젯 간 숫자가 안 맞는 일이 없다. 실시간 집계는
매 위젯이 다른 순간을 보므로 합계가 안 맞는 문의가 온다. 정산·리포트처럼
**"모두가 같은 숫자를 봐야 하는" 화면은 오히려 사전 계산이 정확성 면에서
낫다.** (PG에서 배치 한 트랜잭션 안의 `now()`가 전부 같은 값이라는 사실이
"기준 시각 한 개"를 공짜로 준다 — §4-3.)

## 4. 집계 테이블·배치 설계 — before / after

### 4-1. before — 대시보드가 운영 리포지토리를 그대로 쓴다

```java
// ❌ before — 운영 JPA 리포지토리에 집계 쿼리를 얹었다
public interface OrderRepository extends JpaRepository<Order, Long> {

    @Query("""
        select new com.shop.dashboard.DailySales(function('date', o.paidAt), sum(o.amount))
        from Order o
        where o.sellerId = :sellerId and o.paidAt between :from and :to
        group by function('date', o.paidAt)
        """)
    List<DailySales> aggregateDailySales(Long sellerId, OffsetDateTime from, OffsetDateTime to);
}

@RestController
class DashboardController {
    private final OrderRepository orderRepository;   // 운영 DataSource · 운영 커넥션 풀 · 운영 롤

    @GetMapping("/seller/dashboard/sales")
    List<DailySales> sales(@AuthSeller Long sellerId, LocalDate from, LocalDate to) {
        return orderRepository.aggregateDailySales(sellerId, from.atStartOfDay(SEOUL).toOffsetDateTime(),
                                                   to.plusDays(1).atStartOfDay(SEOUL).toOffsetDateTime());
        // - @Transactional 없음 → readOnly 라우팅을 탈 정보 자체가 없어 프라이머리로 간다
        // - 타임아웃 없음(statement_timeout도 없음) → from=2021-01-01을 넣으면 수 분짜리 쿼리가 운영 풀 커넥션
        //   (= 백엔드 프로세스)을 수 분 점유하고 병렬 워커 2개까지 데려간다
        // - 운영 롤 → 실수로 잠금 조회를 붙여도, 다른 테이블을 조인해도 막을 것이 없다
        // - function('date', o.paidAt)은 timestamptz를 세션 TimeZone으로 잘라서, UTC 세션이면 날짜 경계가 9시간 어긋난다
        // - 셀러 10만 명이 각자 새로고침 → 사슬 A~D가 동시에 10만 번
    }
}
```

### 4-2. after ① — 집계 테이블 스키마: 단위(grain)를 먼저 정한다

집계 테이블 설계의 첫 결정은 **한 행이 무엇을 뜻하는가(grain)** 다. "날짜 ×
셀러"로 정하면 대시보드가 보여줄 수 있는 것은 그 단위와 그 단위를 더한
것뿐이다(셀러별 일·주·월 매출은 되고, 상품별은 안 된다). 차원을 하나
추가할 때마다 행 수가 곱으로 늘므로 **위젯이 실제로 자르는 차원만** 넣는다.

```sql
-- ✅ after ① — 날짜 × 셀러 단위 집계 테이블
CREATE TABLE daily_seller_sales (
    stat_date     date          NOT NULL,
    seller_id     bigint        NOT NULL,
    order_count   integer       NOT NULL,
    gross_amount  numeric(15,2) NOT NULL,   -- 결제 금액 합
    refund_amount numeric(15,2) NOT NULL,   -- 환불 금액 합 (원본 정정을 흡수하는 컬럼)
    net_amount    numeric(15,2) GENERATED ALWAYS AS (gross_amount - refund_amount) STORED,   -- 파생값은 DB가 계산 (PG 12+)
    computed_at   timestamptz   NOT NULL,   -- 이 행을 마지막으로 계산한 시각 → 화면의 "기준 시각"
    PRIMARY KEY (stat_date, seller_id)
);
-- 조회 패턴은 "셀러 하나의 기간 범위" → (seller_id, stat_date) 순서의 인덱스가 실제 조회를 받는다
CREATE INDEX daily_seller_sales_seller_date_idx ON daily_seller_sales (seller_id, stat_date);

-- 배치 실행 상태: 대시보드가 "어디까지 계산됐는지"를 이 표에서 읽는다
CREATE TABLE stats_batch_run (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_name      text        NOT NULL,
    range_from    date        NOT NULL,
    range_to      date        NOT NULL,   -- exclusive
    status        text        NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    error_message text
);
CREATE INDEX stats_batch_run_job_status_idx ON stats_batch_run (job_name, status, finished_at);
```

`net_amount`를 generated column으로 둔 이유는 "gross − refund"라는 불변식을
배치 코드가 아니라 테이블이 지키게 하기 위해서다 — 누가 어떤 경로로
UPSERT하든 어긋날 수 없다.

이 테이블을 **어디에 두는가**도 결정이다. 쓰기가 하루 수만 행으로 작으므로
프라이머리에 둬도 되고, 그러면 통계 스탠바이로 복제돼 대시보드가 거기서
읽는다. 완전한 격리를 원하면 논리 복제 대상인 별도 stats DB에 둔다. 어느
쪽이든 **무거운 계산(원본 읽기)은 통계 스탠바이에서 하고, 가벼운 결과
쓰기만 프라이머리로 간다** — 읽는 곳과 쓰는 곳이 다르다는 점이 §5-1에서
DataSource가 둘로 나뉘는 이유이고, 스탠바이가 읽기 전용이라 이 방향을 어길
수 없다는 점이 PG가 주는 안전장치다.

### 4-3. after ② — 증분 배치: 재계산 창 + 구간 절대값 재계산 + UPSERT

배치 설계에서 가장 중요한 결정은 **"어제 값에 더할 것인가, 어제 구간을
통째로 다시 계산할 것인가"** 다.

- **증분 덧셈** (`gross_amount = gross_amount + 오늘 새 주문 합`): 빠르다.
  그러나 배치가 두 번 돌면 두 배가 되고, 어제 주문이 오늘 환불되면 어제
  행을 어떻게 고칠지 별도 로직이 필요하다. **멱등하지 않다.**
- **구간 절대값 재계산** (`gross_amount = 그 날짜 구간 전체를 다시 sum`):
  같은 구간을 몇 번 돌려도 같은 값이 나온다. 환불도 원본에 반영돼 있으면
  다시 계산할 때 저절로 반영된다. **멱등하다.** 대신 구간이 넓을수록
  배치가 무겁다.

그래서 정석은 **"최근 N일(재계산 창)은 매번 통째로 다시 계산하고, 그
이전은 건드리지 않는다"** 이다. N은 "원본이 정정될 수 있는 기간"(환불
가능 기간, 지연 도착 데이터의 최대 지연)에서 나온다. **멱등성은 재시도
정책이 아니라 계산 방식에서 나온다** — 이 한 문장이 배치 설계의 핵심이다.

```java
// ✅ after ② — 통계 스탠바이에서 읽고(무거움), 프라이머리에 결과만 쓴다(가벼움)
@Component
public class DailySalesAggregationJob {

    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final int RECOMPUTE_WINDOW_DAYS = 3;   // 환불 가능 기간·지연 도착 상한에서 도출

    private final NamedParameterJdbcTemplate statsBatchJdbc;   // → standby-stats, 롤 stats_batch (타임아웃 30분·work_mem 넉넉히, §5-3)
    private final NamedParameterJdbcTemplate mainJdbc;         // → primary
    private final StatsBatchRunRepository runRepository;

    @Scheduled(cron = "0 10 0 * * *", zone = "Asia/Seoul")
    @SchedulerLock(name = "dailySalesAggregation", lockAtMostFor = "PT2H")   // 인스턴스 2대면 배치도 2번 도는 문제 차단
    public void run() {
        LocalDate to   = LocalDate.now(SEOUL);                              // exclusive: 오늘은 아직 안 닫힘
        LocalDate from = to.minusDays(RECOMPUTE_WINDOW_DAYS);
        long runId = runRepository.start("dailySalesAggregation", from, to);
        try {
            // 1) 무거운 읽기: 재계산 창 구간을 통째로 다시 집계 (standby-stats)
            //    - 날짜 경계는 timestamptz를 서울 벽시계로 바꾼 뒤 자른다. date(paid_at)은 세션 TimeZone에 따라 결과가 달라진다
            //    - :from/:to 는 OffsetDateTime → timestamptz 로 바인딩. (seller_id, paid_at) 또는 paid_at BRIN이 3일 범위를 좁힌다
            List<DailySellerSalesRow> rows = statsBatchJdbc.query("""
                SELECT (o.paid_at AT TIME ZONE 'Asia/Seoul')::date   AS stat_date,
                       o.seller_id,
                       count(*)                                       AS order_count,
                       sum(o.amount)                                  AS gross_amount,
                       sum(coalesce(r.amount, 0))                     AS refund_amount
                FROM orders o
                LEFT JOIN refunds r ON r.order_id = o.id
                WHERE o.paid_at >= :from AND o.paid_at < :to
                  AND o.status IN ('PAID', 'REFUNDED')
                GROUP BY 1, 2
                """,
                Map.of("from", from.atStartOfDay(SEOUL).toOffsetDateTime(),
                       "to",   to.atStartOfDay(SEOUL).toOffsetDateTime()),
                ROW_MAPPER);

            // 2) 가벼운 쓰기: 같은 키면 덮어쓴다 → 두 번 돌아도 같은 결과 (멱등)
            //    now()는 트랜잭션 시작 시각이라 한 배치의 모든 행이 같은 computed_at을 갖는다 = "기준 시각 한 개"
            mainJdbc.batchUpdate("""
                INSERT INTO daily_seller_sales
                    (stat_date, seller_id, order_count, gross_amount, refund_amount, computed_at)
                VALUES (:statDate, :sellerId, :orderCount, :gross, :refund, now())
                ON CONFLICT (stat_date, seller_id) DO UPDATE
                   SET order_count   = EXCLUDED.order_count,
                       gross_amount  = EXCLUDED.gross_amount,
                       refund_amount = EXCLUDED.refund_amount,
                       computed_at   = EXCLUDED.computed_at
                """, SqlParameterSourceUtils.createBatch(rows));
            // - DO UPDATE는 값이 같아도 새 튜플 버전을 만든다(WAL·bloat). 창이 3일 × 셀러 수 정도면 무시해도 되고,
            //   창이 넓으면 WHERE (t.order_count, t.gross_amount, t.refund_amount) IS DISTINCT FROM (EXCLUDED....)로
            //   무변경 행을 건너뛴다 — 그 경우 "기준 시각"은 computed_at이 아니라 stats_batch_run.finished_at에서 읽는다
            // - 행이 수백만이면 COPY → 임시 테이블 → 단일 INSERT ... ON CONFLICT 가 정석 (32 문서)

            // 3) 창 안에서 주문이 0건이 된 (날짜, 셀러)는 UPSERT로는 안 지워진다 — 창 구간을 먼저 DELETE 하거나
            //    0건 행을 명시적으로 만들어 넣는다. (전부 환불돼도 order_count는 남으므로 보통은 문제 없음)

            runRepository.success(runId);
        } catch (Exception e) {
            runRepository.fail(runId, e);   // 알람은 이 상태를 보고 울린다 (§4-4)
            throw e;
        }
    }
}
```

주석 3)이 놓치기 쉬운 구멍이다 — UPSERT는 "있는 키를 갱신"하지 "사라진
키를 삭제"하지는 않는다. 재계산 창 안의 어떤 키가 원본에서 완전히 없어질
수 있는 도메인(주문 삭제가 물리 삭제인 경우)이라면 **창 구간 DELETE 후
INSERT**가 더 안전하다. 그 경우 DELETE와 INSERT를 한 트랜잭션으로 묶어
대시보드가 빈 구간을 보지 않게 한다 — PG의 MVCC 덕에 커밋 전까지
스탠바이의 독자는 옛 행을 그대로 본다.

> MySQL 대조: 같은 UPSERT가 `INSERT ... ON DUPLICATE KEY UPDATE col =
> new.col` 형태다. PG의 `ON CONFLICT`는 충돌 대상(유니크 인덱스)을 명시해야
> 하고 `EXCLUDED`로 새 값을 참조한다 — 부작용 비교는
> [`32-bulk-upsert-side-effects.md`](32-bulk-upsert-side-effects.md).

다중 인스턴스에서 `@Scheduled`가 인스턴스 수만큼 도는 문제와 ShedLock은
[`../02-spring/34-scheduled-tasks-threading.md`](../02-spring/34-scheduled-tasks-threading.md)
§5에 있다. 데이터가 커서 한 번에 못 읽으면 reader(스탠바이)–processor–writer(프라이머리)
청크 구조, 즉 Spring Batch의 기본 모양(11장)이 정확히 이 형태다.

### 4-4. 실패 세 가지와 보정 — "어긋남을 전제로 설계한다"

집계 테이블은 원본의 사본이다. 사본은 어긋난다. 반정규화 문서의 "장치 ③
보정 배치"가 여기서는 **세 가지 실패 유형별 장치**로 늘어난다.

**실패 ① 배치가 안 돌았다 / 실패했다** — 대시보드에 어제 숫자가 없거나
그제 숫자가 어제로 보인다.

- 장치: `stats_batch_run`을 보고 **"마지막 SUCCESS가 기준 시각 이후에
  없으면" 알람**. 대시보드는 `computed_at`을 "○월 ○일 00:10 기준"으로
  **화면에 노출**해 낡은 숫자를 숨기지 않는다. 복구는 그냥 다시 돌리는
  것 — 멱등하니까. 재실행 절차를 runbook으로 적어 두고 수동 트리거
  엔드포인트(관리자 권한)를 만들어 둔다. 실패 원인이 스탠바이의 "conflict
  with recovery" 취소라면 그 스탠바이의 `max_standby_streaming_delay`가
  통계용 설정(§2-2)인지부터 본다.

**실패 ② 배치가 두 번 돌았다** — 재시도, 인스턴스 2대, 수동 실행과 스케줄
겹침.

- 장치: §4-3의 **구간 절대값 재계산 + UPSERT**는 몇 번 돌아도 같은 값이다.
  덧셈 누적이었다면 여기서 두 배가 됐다. ShedLock은 "동시에" 도는 것을
  막고, 멱등성은 "따로따로 두 번" 도는 것을 무해하게 만든다 — 둘은 다른
  구멍을 막는다. 두 배치가 진짜로 동시에 같은 키를 UPSERT하면 PG는 유니크
  인덱스에서 한쪽을 다른 쪽 커밋까지 기다리게 하므로 값은 안 깨지지만,
  행 순서가 다르면 데드락(`40P01`)이 날 수 있다 — 결과를 키 순으로 정렬해
  쓰는 습관이 여기서도 유효하다.

**실패 ③ 원본이 나중에 바뀌었다** — 어제 주문이 오늘 환불됐다, 결제 확정이
지연돼 어제 주문이 오늘 들어왔다(late-arriving data), 운영자가 DB에서
직접 정정했다.

- 장치 1: **재계산 창** — 최근 N일은 매일 다시 계산되므로 창 안의 정정은
  자동 반영된다.
- 장치 2: 창 밖의 정정(30일 전 주문 환불)은 **정정 이벤트가 해당 날짜를
  재계산 큐에 넣는다** — 환불 서비스가 `refund.created` 이벤트를 내면
  리스너가 `(stat_date, seller_id)`를 `stats_recompute_queue`에 적고, 다음
  배치가 큐에 있는 키만 추가로 재계산한다.
- 장치 3: **주기 전체 대사(reconciliation)** — 월 1회, 집계 테이블의 월 합계와
  원본의 월 합계를 스탠바이에서 비교해 차이가 나면 그 달을 통째로 재계산하고
  알람을 남긴다. 이벤트를 안 거치는 경로(DB 직접 수정)를 잡는 마지막
  그물이다.

세 장치의 관계는 **"어긋남을 막는다"가 아니라 "어긋남이 남아 있는 시간을
줄인다"** 다. 반정규화 문서 §2-3의 통찰 — 불변식이 DB 제약이 아니라
애플리케이션 관례에 사는 한 언젠가 어긋난다 — 가 그대로 적용된다.

### 4-5. 하이브리드 — 과거는 집계 테이블, 오늘은 소량 실시간

"오늘 매출은 5분 지연"이라는 0단의 합의를 구현하는 가장 단순한 형태는
**과거 구간과 오늘 구간을 다른 곳에서 읽어 합치는 것**이다.

```sql
-- 어제까지: 집계 테이블 (행 수 = 날짜 수). 오늘 날짜는 세션 TimeZone에 기대지 않고 서울 기준으로 직접 구한다
SELECT stat_date, net_amount
FROM daily_seller_sales
WHERE seller_id = $1
  AND stat_date >= $2
  AND stat_date <  (now() AT TIME ZONE 'Asia/Seoul')::date

UNION ALL

-- 오늘: 원본에서 오늘치만 (standby-stats, (seller_id, paid_at) 인덱스로 오늘 범위만 탐색 → 수십~수백 행)
SELECT (now() AT TIME ZONE 'Asia/Seoul')::date,
       sum(o.amount) - sum(coalesce(r.amount, 0))
FROM orders o LEFT JOIN refunds r ON r.order_id = o.id
WHERE o.seller_id = $1
  AND o.paid_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'   -- 서울 자정을 timestamptz로
  AND o.status IN ('PAID', 'REFUNDED');
```

오늘 구간은 셀러 하나의 하루치라 `Index Scan` 범위 탐색으로 작게 끝난다(1단
다이어트의 조건을 만족한다). 그래도 셀러 10만 명이 초 단위로 새로고침하면
부담이므로 오늘 구간 결과를 **5분 TTL 캐시**에 얹는다 — 0단에서 "5분"을
받아냈기 때문에 가능한 처방이다. 요구를 되묻는 것이 기술 선택지를 여는
과정임을 보여주는 지점이다. (`current_date`를 쓰지 않은 이유: 세션
`TimeZone`이 UTC인 커넥션에서는 새벽 0~9시에 "오늘"이 어제가 된다 —
[`30-datetime-vs-timestamp-timezone.md`](30-datetime-vs-timestamp-timezone.md).)

## 5. 안전망 — 통계 쿼리가 운영 DB로 새지 못하게 고정한다

> 겨냥하는 공백 ③: 3장에서 7회 반복된 "안전망을 사람의 기억에 맡기는"
> 습관. "통계 쿼리는 스탠바이로 보내기로 했다"는 결정은 **새 위젯을 만드는
> 다음 개발자가 모른다.** 결정은 코드·권한·설정·빌드가 지키게 한다.
> 아래 다섯 층은 하나가 뚫려도 다음 층이 잡도록 겹친다.

```text
층 1  DataSource 분리   — 통계 코드는 물리적으로 다른 문(별도 빈·별도 풀·별도 롤)으로만 나간다. URL에 targetServerType=secondary
층 2  권한·자원          — 읽기 전용 롤 + CONNECTION LIMIT + 롤 단위 GUC(statement_timeout·work_mem·병렬 0·temp_file_limit)
                          + pg_hba.conf(프라이머리는 reject) + 네트워크
층 3  시간              — 타임아웃 3겹 (DB statement_timeout / JDBC / 풀)
층 4  규칙              — ArchUnit: 대시보드 패키지는 운영 리포지토리에 의존 불가
층 5  관측              — 프라이머리 pg_stat_activity·pg_stat_statements에 stats 롤이 1건이라도 보이면 알람, 스탠바이 취소 카운트, stats 풀 지표
```

### 5-1. 층 1 — DataSource 분리: `@Qualifier`로 물리적으로 다른 문을 낸다

리플리카 라우팅 문서의 `AbstractRoutingDataSource`는 **하나의 JPA 세계 안에서
"이번 트랜잭션은 어느 복제본으로"를 고르는 장치**다. 통계는 그 세계 밖이다
— 다른 테이블(집계 테이블), 다른 쿼리 스타일(네이티브 집계 SQL), 다른
타임아웃(30초), 다른 롤, 다른 풀 크기, 다른 세션 설정(`work_mem`, 병렬도).
경계가 "트랜잭션 속성"이 아니라 **"모듈"** 이므로, 라우팅 키를 추가하기보다
**별도 DataSource 빈을 따로 꽂는 것**이 단순하고 안전하다.

```yaml
# ✅ after — 운영과 통계는 다른 문
datasource:
  main:
    jdbc-url: jdbc:postgresql://primary.internal:5432/shop?ApplicationName=shop-api
    username: app
    password: ${DB_PASSWORD}
    maximum-pool-size: 20
  stats:
    jdbc-url: jdbc:postgresql://standby-stats.internal:5432/shop?targetServerType=secondary&ApplicationName=dashboard
    #  targetServerType=secondary — pgjdbc가 접속 직후 이 서버가 읽기 전용(복구 중)인지 확인하고 프라이머리면 접속을 거부한다.
    #  주소가 잘못 바뀌거나 스탠바이가 승격돼도 통계 풀은 프라이머리에 붙지 못한다.
    #  ApplicationName — pg_stat_activity.application_name 으로 "이 쿼리가 대시보드 것"임을 한눈에 (층 5)
    username: stats_ro                                        # SELECT 권한만 (§5-3)
    password: ${STATS_DB_PASSWORD}
    maximum-pool-size: 4                                      # 동시 통계 쿼리 상한 = 풀 크기. 운영 풀과 별개라 운영 슬롯을 못 뺏는다
    connection-timeout: 3000                                  # 4개가 다 차면 3초 뒤 빨리 실패 → 대시보드만 "잠시 후 다시" (운영 무영향)
    read-only: true                                           # pgjdbc: 트랜잭션을 READ ONLY로 시작 → 쓰기가 섞이면 ERROR 25006
    leak-detection-threshold: 60000                           # 60초 넘게 안 돌려주면 스택 트레이스 로그
    # statement_timeout은 connection-init-sql이 아니라 롤에 박는다(ALTER ROLE stats_ro SET ..., §5-3) — 앱 밖(psql·BI 도구)에서 붙어도 같은 예산
```

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @Primary                                   // JPA·기본 JdbcTemplate 자동 설정은 계속 운영 DB를 잡는다
    @ConfigurationProperties("datasource.main")
    public DataSource mainDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    @ConfigurationProperties("datasource.stats")
    public DataSource statsDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    public NamedParameterJdbcTemplate statsJdbcTemplate(@Qualifier("statsDataSource") DataSource ds) {
        JdbcTemplate template = new JdbcTemplate(ds);
        template.setQueryTimeout(30);          // JDBC 층 타임아웃(초) — 앱 스레드를 풀어준다 (§5-4)
        return new NamedParameterJdbcTemplate(template);
    }

    @Bean
    public PlatformTransactionManager statsTransactionManager(@Qualifier("statsDataSource") DataSource ds) {
        return new DataSourceTransactionManager(ds);   // 통계 쪽에서 @Transactional("statsTransactionManager")를 쓸 때
    }
}
```

```java
// ✅ after — 대시보드 리포지토리는 생성자에서 통계 문만 받는다
@Repository
public class DailySellerSalesRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public DailySellerSalesRepository(@Qualifier("statsJdbcTemplate") NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;                      // 운영 DataSource를 주입받을 방법이 이 클래스에는 없다
    }

    public List<DailySales> findDaily(long sellerId, LocalDate from, LocalDate to) {
        return jdbc.query("""
            SELECT stat_date, net_amount, computed_at
            FROM daily_seller_sales
            WHERE seller_id = :sellerId AND stat_date >= :from AND stat_date < :to
            ORDER BY stat_date
            """,
            Map.of("sellerId", sellerId, "from", from, "to", to),
            (rs, i) -> new DailySales(rs.getObject("stat_date", LocalDate.class),
                                      rs.getBigDecimal("net_amount"),
                                      rs.getObject("computed_at", OffsetDateTime.class)));   // timestamptz ↔ OffsetDateTime
    }
}
```

before와 비교하면 바뀐 것은 **"어느 문으로 나가는가"가 코드 구조에 박혔다**는
점이다. `DailySellerSalesRepository`는 `OrderRepository`를 모른다.
`DashboardController`가 `OrderRepository`를 주입받는 순간 층 4(ArchUnit)가
빌드를 깨뜨린다.

### 5-2. 층 1의 대안 — 이미 `AbstractRoutingDataSource`를 쓰고 있다면

라우팅이 이미 있으면 키를 하나 추가하고 애노테이션으로 강제하는 방법도
있다. 골격만 적는다 — `LazyConnectionDataSourceProxy` 필수, `ThreadLocal`
정리, `@Async` 스레드에서의 유실 같은 함정은 라우팅 문서 §2·§6-3과 같다.

```java
public enum DataSourceKey { PRIMARY, STANDBY, STATS }

@Target(ElementType.METHOD) @Retention(RetentionPolicy.RUNTIME)
public @interface StatsQuery {}

@Aspect @Component
public class StatsRouteAspect {
    @Around("@annotation(StatsQuery)")
    public Object route(ProceedingJoinPoint pjp) throws Throwable {
        RouteContext.force(DataSourceKey.STATS);        // determineCurrentLookupKey()가 ①번으로 먼저 본다
        try { return pjp.proceed(); }
        finally { RouteContext.clear(); }                // 안 지우면 다음 요청이 같은 스레드에서 STATS로 샌다
    }
}
```

단점은 명확하다 — 같은 `EntityManagerFactory`·같은 `JdbcTemplate`을 공유하므로
**타임아웃·풀 크기·롤·세션 설정을 통계만 따로 주기가 어렵고**, 애노테이션을
빠뜨린 새 위젯은 조용히 프라이머리로 간다(라우팅 문서 §9-1의 "라우팅 키별
쿼리 수 비율" 지표가 유일한 안전망이 된다). **통계처럼 경계가 뚜렷한 모듈은
별도 DataSource가 맞고, 라우팅은 같은 엔티티를 읽는 OLTP 조회 분산에 맞다.**

### 5-3. 층 2 — 권한과 자원: 롤 하나에 "무엇을·얼마나·어떻게"를 박는다

코드가 뚫려도 DB가 거부하게 한다. **조용히 잘못 동작하는 것보다 시끄럽게
실패하는 것이 낫다** — 라우팅 문서의 `app_ro` 원칙과 같다. PostgreSQL은
**롤 단위로 세션 설정(GUC) 기본값을 걸 수 있어서** 자원 예산을 계정에
붙일 수 있다는 것이 특징이다.

```sql
-- ✅ PostgreSQL — 대화형 통계 롤: SELECT만, 동시 접속 상한, 시간·메모리·코어·디스크 예산
CREATE ROLE stats_ro LOGIN PASSWORD '...' CONNECTION LIMIT 8;          -- 인스턴스 수 × stats 풀 크기 이하
GRANT USAGE ON SCHEMA public TO stats_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stats_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stats_ro;   -- 앞으로 생길 테이블도 (PG는 자동 부여가 없다)
ALTER ROLE stats_ro SET default_transaction_read_only = on;
ALTER ROLE stats_ro SET statement_timeout = '30s';                      -- 시간: 대화형은 30초
ALTER ROLE stats_ro SET idle_in_transaction_session_timeout = '10s';    -- 트랜잭션 열어 두고 노는 세션 정리 (스냅샷 보유 방지)
ALTER ROLE stats_ro SET max_parallel_workers_per_gather = 0;            -- 코어: 통계 쿼리 1건 = 프로세스 1개로 고정 (사슬 B)
ALTER ROLE stats_ro SET work_mem = '64MB';                              -- 메모리: 노드당 상한 (운영 롤의 4MB와 분리)
ALTER ROLE stats_ro SET temp_file_limit = '2GB';                        -- 디스크: 임시 파일 상한 — 이건 일반 롤이 세션에서 못 푼다

-- 배치용 롤은 따로: 같은 SELECT 권한, 다른 시간·메모리 예산 ("통계" 하나로 묶지 않는다, §5-4)
CREATE ROLE stats_batch LOGIN PASSWORD '...' CONNECTION LIMIT 2;
GRANT stats_ro TO stats_batch;                                          -- 권한은 물려받지만 SET 기본값은 물려받지 않는다 → 따로 건다
ALTER ROLE stats_batch SET default_transaction_read_only = on;
ALTER ROLE stats_batch SET statement_timeout = '30min';
ALTER ROLE stats_batch SET work_mem = '512MB';
ALTER ROLE stats_batch SET max_parallel_workers_per_gather = 2;
ALTER ROLE stats_batch SET temp_file_limit = '20GB';
```

```text
# primary 의 pg_hba.conf — 통계 롤은 프라이머리에 아예 못 붙는다 (첫 매칭 규칙이 이기므로 위쪽에 둔다)
host    shop    stats_ro,stats_batch    0.0.0.0/0          reject
# standby-stats 의 pg_hba.conf — 통계 워커 대역에서만
host    shop    stats_ro,stats_batch    10.0.20.0/24       scram-sha-256
```

- **`GRANT SELECT`만**: 통계 코드에 실수로 `UPDATE`가 섞이면 권한 오류로
  즉시 실패한다. `SELECT ... FOR UPDATE`도 UPDATE 권한이 필요하므로 거부되고,
  hot standby에서는 행 락 자체가 허용되지 않는다 — 세 겹으로 막힌다.
- **`CONNECTION LIMIT`**: 앱의 풀 크기 설정을 누가 40으로 올려도 DB가 8에서
  막는다. **설정은 바뀌지만 권한은 리뷰를 거친다.**
- **자원 예산 — PG에는 리소스 그룹이 없다.** 대신 롤 단위 GUC로 사슬 B를
  네 축에서 억제한다: `max_parallel_workers_per_gather = 0`(코어 — 8코어 중
  1개 이상 못 가져감), `work_mem`(메모리), `temp_file_limit`(디스크),
  `statement_timeout`(시간). **주의: `ALTER ROLE ... SET`은 기본값이지
  상한이 아니다** — 일반 롤도 세션에서 `SET statement_timeout = 0`으로 풀 수
  있다(`temp_file_limit`처럼 슈퍼유저 전용 설정만 진짜 상한). 그래서 이
  층만으로는 부족하고 층 4·5가 필요하다. 진짜 CPU 격리는 인스턴스 분리
  (전용 스탠바이)나 OS cgroup이다.
- **네트워크 층**: 롤은 클러스터 전체 객체라 WAL로 스탠바이에 복제되므로
  "계정이 스탠바이에만 있다"는 성립하지 않는다. 대신 **`pg_hba.conf`는
  서버마다 따로인 파일**이라 프라이머리에서 통계 롤을 `reject`할 수 있다 —
  `jdbc-url`에 프라이머리 주소를 넣어도 인증 단계에서 끊긴다. 여기에
  프라이머리 5432 포트를 여는 보안 그룹에 통계 워커·분석 도구 대역을 넣지
  않는 것이 물리적 차단이다.

> MySQL 대조: `CREATE USER 'stats_ro'@'10.0.20.%'`(호스트가 계정의 일부),
> `MAX_USER_CONNECTIONS 8`, 그리고 8.0 **리소스 그룹**(`CREATE RESOURCE GROUP
> stats_rg TYPE = USER VCPU = 6-7 THREAD_PRIORITY = 15` + 쿼리 힌트
> `/*+ RESOURCE_GROUP(stats_rg) */`)으로 통계 스레드를 특정 코어·낮은
> 우선순위에 가둘 수 있다 — PG에 없는 도구다. 반대로 PG의 "롤에 GUC
> 기본값을 건다"와 "pg_hba.conf로 서버별 접속 거부"는 MySQL에 없는 도구다.

### 5-4. 층 3 — 타임아웃 3겹: 왜 하나로는 부족한가

| 층 | 설정 | 잡는 것 |
|---|---|---|
| DB 세션 | `statement_timeout`(롤·세션·트랜잭션 단위, **모든 문장**에 적용) | **앱이 죽어도** DB가 스스로 쿼리를 죽인다. 앱 재시작·네트워크 단절 뒤 고아 쿼리가 계속 도는 것을 막는다 |
| JDBC | `JdbcTemplate.setQueryTimeout(30)` / `@Transactional(timeout = 30)` / JPA `jakarta.persistence.query.timeout` | 앱 **스레드**를 풀어준다. pgjdbc가 별도 소켓으로 취소 요청을 보낸다(`pg_cancel_backend`와 같은 경로) |
| 커넥션 풀 | `maximum-pool-size: 4` + `connection-timeout: 3000` | **동시 실행 수 상한**. 5번째 통계 요청은 3초 뒤 빨리 실패 — 톰캣 스레드가 묶여 운영 요청까지 죽는 연쇄를 끊는다 |

세 층이 필요한 이유는 **잡는 대상이 다르기 때문**이다. JDBC 타임아웃만
있으면 앱이 OOM으로 죽는 순간 취소 요청을 보낼 주체가 사라져 DB에서
집계가 끝까지 돈다. DB 타임아웃만 있으면 30초 동안 톰캣 스레드가 묶여
있다. 풀 상한이 없으면 30초짜리 쿼리 100개가 동시에 들어와 스탠바이가
넘어간다. **DB 층은 마지막 보루, JDBC 층은 앱 보호, 풀 층은 동시성 제어**다.

배치 잡은 예외다 — 새벽 배치의 집계는 30초를 넘는 것이 정상이므로 배치는
`stats_batch` 롤(`statement_timeout = '30min'`)과 배치용 `JdbcTemplate`
(`setQueryTimeout(1800)`)을 따로 가지며, 대시보드 API용 빈과 분리한다.
**"통계"라는 이름 하나로 묶지 말고 대화형(짧게)과 배치(길게)를 나눈다** —
§5-3에서 롤을 둘로 만든 이유다.

> MySQL 대조: DB 층은 `max_execution_time`(ms, **SELECT 전용**)이고 드라이버는
> `KILL QUERY`를 보낸다. PG의 `statement_timeout`은 DML·DDL에도 걸린다.

### 5-5. 층 4·5 — 규칙과 관측: 빌드가 잡고, 지표가 잡는다

```java
// 층 4 — ArchUnit: 대시보드 패키지는 운영 리포지토리·JPA 리포지토리에 의존할 수 없다
@AnalyzeClasses(packages = "com.shop")
class DashboardIsolationTest {

    @ArchTest
    static final ArchRule dashboard_must_not_touch_oltp_repositories =
        noClasses().that().resideInAPackage("..dashboard..")
            .should().dependOnClassesThat().resideInAnyPackage("..order.repository..", "..payment.repository..")
            .orShould().dependOnClassesThat().areAssignableTo(JpaRepository.class)
            .because("대시보드 조회는 statsDataSource(집계 테이블·통계 스탠바이)만 사용한다 — 운영 DB 보호 결정 (ADR-017)");

    @ArchTest
    static final ArchRule stats_jdbc_only_in_dashboard_and_batch =
        classes().that().dependOnClassesThat().haveSimpleName("DailySellerSalesRepository")
            .should().resideInAnyPackage("..dashboard..", "..statsbatch..");
}
```

```yaml
# 층 5 — 관측: "새는지"는 사람이 아니라 지표가 말한다
# ① 프라이머리에서 통계 롤의 쿼리가 1건이라도 관측되면 알람
#    지금:  SELECT count(*) FROM pg_stat_activity WHERE usename IN ('stats_ro', 'stats_batch');
#    누적:  SELECT sum(s.calls) FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
#            WHERE r.rolname IN ('stats_ro', 'stats_batch');
#    → 누군가 통계 코드에 운영 DataSource를 꽂았거나 jdbc-url이 바뀌었다 (pg_hba reject가 살아 있으면 접속 실패 로그가 먼저 뜬다)
#    application_name = 'dashboard' 로도 같은 것을 잡는다 — 롤을 잘못 써도 이름은 남는다
# ② hikaricp.connections.pending{pool="stats"} 가 지속되면 → 통계 수요가 상한을 넘었다 = 사다리 다음 단으로 올라갈 신호
# ③ standby-stats 지연: 프라이머리 pg_stat_replication.replay_lag / 스탠바이 now() - pg_last_xact_replay_timestamp()
#    (느슨하게, 예: 10분 — 배치 창이 늦어지는지)
#    + 스탠바이 pg_stat_database_conflicts.confl_snapshot / confl_lock 증가 = 집계가 취소되고 있다 (§7)
# ④ stats_batch_run 의 마지막 SUCCESS 시각 — 기준 시각(예: 01:00)까지 없으면 알람 (§4-4 실패 ①)
```

①은 이 문서의 안전망 중 가장 값싸고 결정적이다 — **"통계 쿼리는 운영 DB로
가지 않는다"는 결정 자체를 지표로 감시**한다. 라우팅 문서 §9-1의 "라우팅
키별 쿼리 수 비율"과 같은 발상이다: 틀려도 에러가 안 나는 결정은 지표로만
지킬 수 있다.

## 6. 실제 사례 — 월말 정산 대시보드가 주문 API를 세웠다

- **증상**: 월말 오전 10시, 주문 생성 API p99가 200ms → 3s. DB CPU 45% → 95%.
  배포 없음. 앱 로그에는 `HikariPool-1 - Connection is not available, request
  timed out after 3000ms`가 산발.
- **진단**: `pg_stat_activity` — `usename = 'app'`, `state = 'active'`,
  `now() - query_start`가 14분인 쿼리가 4개, 전부 `SELECT ... FROM orders o
  JOIN order_items oi ... GROUP BY o.seller_id, date(o.paid_at)`. 각각
  `leader_pid`로 묶인 병렬 워커 2개가 딸려 **프로세스 12개가 8코어를 채움**
  (사슬 B). 정산팀이 월말이라 정산 대시보드를 여러 탭에서 열어둔 것.
  `pg_stat_database.blks_read` 급증(사슬 A), 가장 오래된 `backend_xmin`이
  14분 전이고 `orders`·`payments`의 `n_dead_tup`이 오르는 중(사슬 C),
  HikariCP active 20/20 with pending(사슬 D).
- **즉시 조치**: 리더 pid에 `SELECT pg_cancel_backend(pid)`(워커도 함께
  멈춘다; 안 죽으면 `pg_terminate_backend`). 정산 대시보드 메뉴를 feature
  flag로 잠시 내림. 5분 안에 p99 회복.
- **단기(그 주)**: 층 1~3 — `statsDataSource`(standby-stats, `stats_ro`,
  `targetServerType=secondary`, 풀 4, 30초 타임아웃) 분리. 첫날 스탠바이에서
  `canceling statement due to conflict with recovery`가 터져 — 운영 읽기와
  분리된 전용 스탠바이이므로 `max_standby_streaming_delay = -1`,
  `hot_standby_feedback = off`로 확정. 운영 영향은 0이 됐지만 **대시보드는
  여전히 스탠바이에서 14분** — 2단은 격리이지 해결이 아님을 팀이 체감.
- **중기(그 달)**: 0단 협상 — 정산팀과 "마감 전 잠정치(하루 1회 갱신) / 마감
  후 확정치(마감 배치)" 합의. 3단 — `daily_seller_sales` + 새벽 배치 + 3일
  재계산 창 + 환불 이벤트 재계산 큐. 대시보드 응답 50ms. 층 4·5 — ArchUnit
  룰과 프라이머리의 통계 롤 쿼리 수 알람 추가.
- **배운 것**: "배포 안 했는데요"의 변경은 코드가 아니라 **달력(월말)** 이었다.
  시스템은 데이터 증가·사용 패턴·인접 배치로 매일 바뀐다 — 다음 문항("변경
  없음"의 검증)으로 이어지는 교훈이다.

## 7. 꼬리질문 대비 포인트

### "스탠바이로 보냈는데 운영 API가 여전히 느려집니다. 왜죠?"

원인 후보를 **두 갈래**로 나눠 확인한다.

- **정말 스탠바이로 갔는가** — 라우팅 기반이라면 `LazyConnectionDataSourceProxy`
  누락이나 `@Transactional(readOnly = true)` 누락으로 **프라이머리로 새고
  있을** 가능성이 1순위다. 확인은 프라이머리의 `pg_stat_activity`에서
  `application_name = 'dashboard'`나 통계 롤의 쿼리를 직접 찾는 것 —
  DataSource마다 `ApplicationName`을 다르게 줘 두면 한 줄 쿼리로 끝난다
  (라우팅 문서 §2·§9). 별도 DataSource 방식이면 `jdbc-url`과 롤을 확인한다 —
  `targetServerType=secondary`와 `pg_hba` reject가 있었다면 애초에 접속이
  실패했을 것이고, 층 5-①의 알람이 있으면 이미 울렸을 것이다.
- **스탠바이로 갔는데도 운영이 느리다면** — 두 경로다. ① 그 스탠바이를
  **운영 읽기가 같이 쓰고 있다**: 사슬 A·B·C가 스탠바이 위에서 운영 조회를
  느리게 하고, 사슬 E로 lag가 커져 라우팅이 그 스탠바이를 풀에서 빼면
  **남은 스탠바이나 프라이머리가 그 부하를 다 받는다**(라우팅 문서 §7).
  처방은 통계 전용 스탠바이 분리. ② PG 고유 경로 — 그 스탠바이에
  **`hot_standby_feedback = on`**이 켜져 있다: 스탠바이의 14분짜리 집계가
  잡은 xmin이 프라이머리로 보고돼 **프라이머리의 VACUUM이 14분 멈춘다.**
  "스탠바이로 보냈는데 프라이머리 bloat가 늘고 운영 쿼리가 느려지는", 겉으로는
  이해되지 않는 경로다. 프라이머리 `pg_stat_replication.backend_xmin`에
  스탠바이가 붙들고 있는 xmin이 보인다. 처방은 통계 스탠바이에서 feedback을
  끄고 대신 `max_standby_streaming_delay`를 넉넉히 주는 것.

### "스탠바이에서 통계 쿼리가 자꾸 취소됩니다(conflict with recovery). 어떻게 하죠?" (가산점 포인트)

먼저 **무엇과 충돌했는지**를 `pg_stat_database_conflicts`로 본다 —
`confl_snapshot`(프라이머리 VACUUM이 치운 튜플을 스탠바이 쿼리가 아직 봄)이
대부분이고, `confl_lock`(프라이머리 DDL의 ACCESS EXCLUSIVE 재생)이 그다음이다.
그다음 선택지 넷을 대가와 함께 늘어놓는다.

1. **`max_standby_streaming_delay`를 늘리거나 `-1`** — 재생이 집계 끝까지
   기다린다. 대가는 lag. 운영 읽기가 없는 전용 스탠바이라면 이것이 정답이다.
   단 이 스탠바이를 페일오버 후보로도 쓴다면 승격 시 밀린 WAL만큼 RTO가
   늘고, `synchronous_standby_names`에 들어 있으면 프라이머리 커밋을 세운다.
2. **`hot_standby_feedback = on`** — 스냅샷 충돌이 사라진다(락 충돌은 남는다).
   대가는 프라이머리 bloat — 대시보드 14분이 프라이머리 VACUUM 지연 14분.
   **짧은 쿼리만 도는 운영 읽기 스탠바이엔 켜도 싸고, 긴 집계가 도는 통계
   스탠바이엔 비싸다.**
3. **논리 복제로 별도 통계 DB** — 재생 충돌이라는 개념 자체가 없고 인덱스도
   자유. 대가는 DDL 수동 동기화·`REPLICA IDENTITY`·복제 슬롯 운영·apply 지연.
4. **앱에서 취소 에러를 잡아 재시도** — 수 초짜리 쿼리엔 통하지만 10분짜리
   집계엔 무의미하다. 재시도할 게 아니라 3단으로 올라갈 신호다.

판단을 한 줄로: **통계 전용 스탠바이 = delay `-1` + feedback off, 운영 읽기
스탠바이 = delay 짧게 + feedback on 검토.** 두 스탠바이의 설정이 정반대라는
사실 자체가 "허용 lag가 다른 워크로드는 다른 복제본에"의 PG 판이다.

### "집계 배치가 새벽에 실패했습니다. 대시보드는 어떻게 되고, 어떻게 복구하나요?"

**대시보드는 어제 배치 결과(그제까지의 숫자)를 그대로 보여주되, `computed_at`
기준 시각이 화면에 있어 사용자가 "어제 것이 아직 안 들어왔다"를 알 수
있어야 한다.** 낡은 숫자를 최신인 척 보여주는 것이 진짜 사고다.

복구는 **재실행**이다 — §4-3의 구간 절대값 재계산 + `ON CONFLICT` UPSERT라서
실패 지점이 어디였든 처음부터 다시 돌리면 된다. 도중에 절반만 UPSERT됐어도
다음 실행이 덮어쓴다. 필요한 것은 ① `stats_batch_run`의 FAILED를 보고 우는
알람 ② 관리자용 수동 트리거 ③ 실패 원인이 `statement_timeout`이면 배치가
`stats_batch` 롤·배치용 `JdbcTemplate`으로 대화형과 분리돼 있는지, 스탠바이
취소면 그 스탠바이의 `max_standby_streaming_delay`가 통계용인지 확인
(§5-4, §2-2) ④ 재계산 창이 3일이므로 **하루 실패는 다음 날 배치가 자동으로
메운다**는 것 — 창은 정정 반영만이 아니라 실패 흡수 장치이기도 하다.
만약 덧셈 누적 방식이었다면 "어디까지 더해졌는지"를 알아내야 해서 복구가
수작업이 된다 — 멱등 설계의 값어치가 드러나는 순간이다.

### "환불·주문 취소처럼 과거 데이터가 바뀌면 집계 테이블은 어떻게 맞추나요?"

**세 겹으로 답한다(§4-4 실패 ③).** ① 최근 N일은 재계산 창이 매일 다시
계산하므로 자동 반영 — N은 환불 가능 기간에서 도출. ② 창 밖의 정정은
정정 이벤트(`refund.created`)가 해당 `(stat_date, seller_id)`를 재계산 큐에
넣고 다음 배치가 그 키만 추가 계산. ③ 이벤트를 안 거치는 경로(운영자 DB
직접 수정)를 위해 월 1회 원본과 집계의 합계를 대사해 차이 나는 달을
재계산.

여기에 **스키마 차원의 답**을 덧붙이면 좋다 — `refund_amount`를 별도
컬럼으로 두고 `net_amount`를 generated column으로 파생시킨 이유가 이것이다.
환불이 `gross_amount`를 깎는 게 아니라 `refund_amount`에 쌓이므로, "환불 전
매출"과 "순매출"을 둘 다 보여줄 수 있고 정산팀의 "환불이 제대로 반영됐나요?"
문의에 숫자로 답할 수 있으며, 둘의 차이가 DB 안에서 항상 맞는다. 집계
테이블의 컬럼은 **정정이 어떻게 들어오는지를 알고** 설계한다. materialized
view였다면 이 질문은 "다음 REFRESH가 전부 다시 계산한다"로 끝나지만, 그것이
곧 매일 3년치를 읽는다는 뜻임을 같이 말한다.

### "실시간 통계가 정말 필요하다고 하면요?" (시니어 변별 포인트)

먼저 **"실시간"을 항목별로 쪼갠다** — 대시보드 전체가 실시간이어야 하는
경우는 거의 없다. 0단의 표처럼 "오늘 매출 5분 / 어제까지 하루 / 접속자
수 초 단위"로 분해하면 진짜 실시간이 필요한 항목은 한두 개로 준다.

그 한두 개에 대한 처방은 **RDB 밖**이다. ① 이벤트 시점에 미리 더해두는
카운터(Redis `INCRBY`, 주문 확정 이벤트마다 `sales:today:{sellerId}`에
가산 — 조회는 O(1)) ② 스트림 집계(Kafka Streams·Flink로 주문 이벤트를
윈도우 집계해 결과를 Redis나 집계 테이블에 씀; 이벤트의 출처가 4단의 논리
디코딩 CDC면 앱 코드를 안 건드린다). 둘 다 **"조회 시점에 계산하지
않는다"는 원칙은 3단과 같고, 계산 시점이 "배치"에서 "이벤트 도착 순간"으로
당겨진 것**뿐이다. "RDB 안에서 카운터 행을 UPDATE하면 되지 않나"는 PG에서
특히 나쁜 답이다 — 갱신마다 새 튜플 버전이 생겨 핫 로우 한 행이 페이지를
죽은 튜플로 채운다
([`23-high-frequency-counter-hot-row.md`](23-high-frequency-counter-hot-row.md)).

대가를 같은 호흡에 붙인다 — 카운터는 이벤트 유실·중복 시 어긋나고 원본과
대사가 필요하다. 스트림 집계는 인프라(Kafka·상태 저장소)와 운영 역량이
필요하고, 지연 도착·정정 이벤트를 윈도우가 닫힌 뒤 어떻게 반영할지가
어렵다. 그래서 **"정말 필요한가"를 한 번 더 되묻는 것이 시니어의 답**이다 —
"실시간 대신 5분 지연이면 비용이 1/10인데, 5분이 의사결정을 바꾸나요?"

### "이게 CQRS인가요? 뭐가 다른가요?" (가산점 포인트)

핵심 아이디어는 같다 — **쓰기 모델(정규화된 `orders`)과 읽기 모델(대시보드에
맞게 접힌 `daily_seller_sales`)을 분리하고, 읽기 모델을 쓰기 모델에서
파생시킨다.** rationale이 "12장 CQRS의 실용 판"이라 부른 이유다.

다른 점은 **파생 방법과 범위**다. 교과서 CQRS는 커맨드 측이 이벤트를
발행하고 프로젝터가 이벤트를 소비해 읽기 모델을 갱신하며, 이벤트 소싱과
함께 오는 경우가 많다. 여기서는 배치(3단)나 논리 디코딩 CDC(4단)가 그
프로젝터 역할을 하고, 쓰기 모델은 평범한 PG 테이블 그대로다 — CDC라면
WAL이 곧 이벤트 스트림이라 커맨드 측이 이벤트를 따로 발행할 필요조차 없다.
**아키텍처를 바꾸지 않고 CQRS의 이득(읽기 모델 최적화, 워크로드 격리)만
취하는 것**이 실용 판이라는 뜻이고, 이 문항이 4장(RDB)에 있는 이유이기도
하다. 이 답을 하면 "패턴 이름을 아는 사람"이 아니라 "패턴이 해결하는 문제를
아는 사람"으로 보인다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **캐시 오염의 모양** — InnoDB는 버퍼 풀 한 겹에 midpoint
LRU(old 37%, `innodb_old_blocks_time`)로 방어하고 `Innodb_buffer_pool_reads`로
본다. PG는 shared_buffers + OS 캐시 두 겹이고, 링 버퍼가 shared_buffers는
지키지만 **OS 캐시는 무방비**라 `pg_stat_database.blks_read`·`pg_stat_io`
(bulkread)와 OS 지표를 같이 본다. ② **긴 읽기의 MVCC 비용** — MySQL은
"purge 정지 → history list length → 언두 체인 순회"이고, PG는 "`backend_xmin`
→ VACUUM 정지 → 힙·인덱스 bloat + visibility map 낡음"이다. 대가가 별도
공간(언두)이 아니라 **테이블 파일 자체**에 남는 것이 PG 쪽이 더 오래가는
이유다. ③ **레플리카의 반응** — MySQL 레플리카는 applier가 MDL에 막혀
`Seconds_Behind_Source`가 튈 뿐 쿼리를 죽이지 않지만, PG 스탠바이는 재생과
충돌하면 **취소하거나(`max_standby_streaming_delay`) 지연하거나
프라이머리에 bloat를 되돌려 준다(`hot_standby_feedback`)** — 삼자택일이
PG 고유 답이다. 또 MySQL 레플리카는 인덱스를 따로 둘 수 있지만 PG 물리
스탠바이는 못 두고 논리 복제가 필요하다. ④ **도구함** — MySQL은 리소스
그룹과 `max_execution_time`(SELECT 전용)이 있고 materialized view가 없다.
PG는 리소스 그룹이 없는 대신 롤 단위 GUC(병렬 0·`work_mem`·`temp_file_limit`·
`statement_timeout`), `pg_hba.conf` 서버별 거부, 그리고 **materialized view +
`REFRESH CONCURRENTLY`**가 있다. ⑤ **코어 점유** — MySQL은 쿼리 = 스레드
1개라 집계 하나가 코어 1개지만, PG는 병렬 쿼리로 3개를 가져갈 수 있어 롤
단위로 병렬도를 끄는 것이 처방에 들어간다. 이 다섯을 짚으면 "replica로
보내면 돼요"가 아니라 "이 DB에서는 이렇게 새어 나간다"로 들린다.

---

## 한 줄 요약

**집계 쿼리는 운영 트랜잭션과 shared_buffers·OS 캐시·CPU(병렬 워커)·I/O 큐·
VACUUM(`backend_xmin`)·커넥션(프로세스)·`ACCESS SHARE` 락을 나눠 쓰며 그
하나하나를 잠식하므로, "하루 지연 허용 가능?"을 먼저 되물어 요구를 낮춘 뒤
통계 전용 스탠바이(delay `-1` + feedback off — 취소·지연·프라이머리 bloat의
삼자택일을 알고 고른다) → 멱등한 집계 테이블·`ON CONFLICT` 배치(원본이
작으면 materialized view + `REFRESH CONCURRENTLY`) → 논리 디코딩 CDC·OLAP의
사다리를 필요한 높이까지만 오르되, 어느 단이든 통계 쿼리가 운영 DB로 새지
못하게 DataSource(`targetServerType=secondary`)·롤 단위 GUC·`pg_hba.conf`·
타임아웃·ArchUnit·지표로 고정한다.**
