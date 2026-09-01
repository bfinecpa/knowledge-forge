# 배포 없이 DB CPU만 올랐다 — "변경 없음"은 전제가 아니라 첫 번째 검증 대상이다

> 핵심 관전 포인트: **"배포 안 했다"는 코드가 안 바뀌었다는 말이지 시스템이
> 안 바뀌었다는 말이 아니다. DB는 배포 없이도 매일 변한다 — 데이터 증가·분포
> 변화, 자동 ANALYZE·제네릭 계획 전환에 따른 실행 계획 변경, 인접 배치·타 팀
> 잡, 트래픽 구성 변화·크롤러, 외부사 변경(웹훅 폭주), 인프라 작업(파라미터·
> 페일오버·레플리카 소실·앱 오토스케일로 커넥션 증가), 캐시 만료·무효화, 긴
> 트랜잭션이 VACUUM을 막아 생기는 bloat, 그리고 **PostgreSQL이 스스로 돌리는
> autovacuum**. 그래서 첫 행동은 원인을 찍는 것이 아니라 ① "변경 없음"이라는
> 전제를 **변경 타임라인**(배포·스키마·배치·인프라 이벤트·플래그·외부 공지·
> 트래픽·autovacuum 기록을 한 화면에)으로 검증하고, ② 후보를
> **언제부터**(CPU 곡선의 변곡점 시각과 모양) → **무엇이**(변곡점 전후의
> `pg_stat_statements` 스냅샷 비교 — 새로 나타난 쿼리 / 횟수 급증 / 건당 비용
> 급증의 세 갈래) → **왜**(그 쿼리의 실행 계획을 베이스라인과 대조, 발신자
> 추적) 순으로 좁힌다. "CPU**만**"이라는 증상도 단서다 — CPU는 DB가 메모리
> 안의 튜플을 많이 읽고 가시성을 판정하고 비교·정렬하고 있다는 뜻이고,
> `pg_stat_activity`에서는 **`state = 'active'`인데 `wait_event`가 비어 있는
> 세션**으로 보인다. 디스크 병목이면 iowait와 `IO` 대기, 락 대기면 `Lock`
> 대기만 늘고 CPU는 낮다. 이 검증이 사람의 기억이 아니라 시스템(변경
> 어노테이션, `pg_stat_statements` 스냅샷 잡, 실행 계획 베이스라인)에 고정돼
> 있어야 다음 장애 때도 같은 속도로 답이 나온다.**

---

## 0. 질문 + 의도

**질문**: "배포도 없었는데 어제부터 DB CPU만 올랐습니다. "변경이 없다"는
전제를 어떻게 검증하고, 원인 후보를 어떻게 좁혀가나요?"

**출제 의도**: 의도 2(장애 상황 판단)의 대표 형식. "배포 안 했는데요"는 코드
변경만 본 말이고, 시스템은 데이터 증가·통계 갱신·인접 배치·외부사 변경·인프라
작업, 그리고 DB가 스스로 돌리는 유지보수 작업으로 매일 변한다. "변경
없음"이라는 전제 자체를 의심하고 **변경의 정의를 넓혀** 조사하는지 — 진단의
첫 갈림길에서 방향을 잡는 능력을 본다. 즉 이 질문은 PostgreSQL 지식 시험이
아니라 ⑴ 전제를 검증하는 습관, ⑵ 후보 목록을 빠짐없이 인출하는 능력, ⑶ 각
후보가 왜 하필 CPU로 나타나는지를 자원 단위로 설명하는 능력, ⑷ 그 절차가
사람 기억이 아니라 시스템에 있는지를 한 번에 본다. 다만 PostgreSQL에서는
후보 목록에 **DB 자신이 원인인 줄**(autovacuum, 제네릭 계획 전환, bloat)이
몇 개 더 있어서, 그 줄을 알고 있는지가 "PG를 운영해 봤는가"를 가른다.

> 진단 문서로서의 위치: [02-spring의 기동 지연 진단](../02-spring/32-slow-application-startup-diagnosis.md)이
> "시간축 먼저 → 침묵 구간은 다른 도구로"의 방법론이었다면, 이 문서는 같은
> 방법론을 DB에 적용한다 — 다만 여기서는 "무엇이 바뀌었는가"를 확인하는 단계가
> 앞에 하나 더 붙는다. 실행 계획이 바뀌는 메커니즘 자체는
> [실행 계획 급변 문서](./31-execution-plan-sudden-change.md)로 분리하고
> 여기서는 후보 중 하나로만 다룬다.

---

## 1. 첫 갈림길 — "변경 없음"은 전제가 아니라 검증 대상이다

### 1-1. "배포 안 했다"가 실제로 뜻하는 것

"배포 없음"은 **우리 팀이 이 서비스의 코드를 어제 이후 올리지 않았다**는
사실 하나다. 그 문장이 배제하지 못하는 것:

- 코드는 같아도 **코드가 처리하는 데이터**가 다르다 (행 수, 값 분포, 특정
  고객의 데이터 크기, 죽은 튜플의 양).
- 코드는 같아도 **플래너가 고른 길**이 다를 수 있다 (자동 ANALYZE, 제네릭
  계획 전환, JIT·병렬 계획의 임계 통과).
- 코드는 같아도 **코드를 부르는 쪽**이 다르다 (트래픽 구성, 크롤러, 외부사
  웹훅, 타 팀 배치).
- 코드는 같아도 **코드가 도는 바닥**이 다르다 (파라미터, 페일오버, 레플리카
  소실, 패치, 앱 오토스케일로 늘어난 커넥션 수).
- 코드는 같아도 **코드가 타는 경로**가 다르다 (feature flag, 원격 설정, A/B
  비율 — 배포 없이 동작이 바뀌는 공식 통로).
- 코드는 같아도 **앞단의 방패**가 다르다 (캐시 히트율).
- 코드는 같아도 **DB가 스스로 돌리는 살림**이 다르다 (autovacuum·자동
  ANALYZE — 우리가 시킨 적 없는 작업이 우리 DB에서 돈다. PostgreSQL은 이
  방향이 특히 넓다).

그래서 "변경이 없다"는 결론이 아니라 **가설**이고, 검증 방법은 사람에게 "어제
뭐 하셨어요?"라고 묻는 것이 아니라 §4의 변경 타임라인을 여는 것이다. 사람의
기억은 자기 팀 배포까지만 미치고, 위 일곱 줄은 대부분 우리 팀 밖에서 — 마지막
줄은 아예 사람 밖에서 — 일어난다.

### 1-2. 변경의 정의를 넓힌 후보 목록 — 체크리스트 (암기 카드)

면접에서 이 표를 순서대로 말할 수 있으면 "목록 인출"은 통과다. 각 줄이 왜
CPU로 이어지는지는 §2에서 사슬로 편다.

| # | 후보 | 첫 확인 지점 | CPU로 이어지는 사슬 한 줄 |
|---|---|---|---|
| 0 | 배포 아닌 코드 경로 변경 (플래그·원격 설정·A/B) | 플래그 변경 이력, config 저장소 커밋 | 새 경로의 쿼리가 켜짐 → 스냅샷에 없던 `queryid` 등장 |
| 1 | 데이터 증가·분포 변화 | `pg_stat_user_tables`의 `n_live_tup`·`pg_total_relation_size()` 추이, 특정 키의 행 수 | 같은 계획으로 읽는 블록 수 ↑, 임계 통과(`work_mem` 스필·병렬 스캔 시작·인덱스 없는 쿼리의 선형 증가) |
| 2 | 실행 계획 변화 (자동 ANALYZE·제네릭 계획 전환·JIT·병렬) | `EXPLAIN` vs 베이스라인, 추정 `rows` vs 실측, `last_autoanalyze` | Seq Scan·조인 순서 역전·실행마다 JIT 컴파일 → 튜플 수·연산 폭증 |
| 3 | 인접 배치·크론·타 팀 잡·리포트 | 배치 메타 테이블, 크론 로그, `pg_stat_activity`의 `usename`·`application_name` | 대량 스캔·집계·정렬 → CPU + shared_buffers·OS 캐시 오염의 2차 피해 |
| 4 | 트래픽 구성 변화·크롤러·특정 사용자 | 엔드포인트별 RPS, UA·IP 분포, 페이지 번호 분포 | 총량은 같아도 비싼 쿼리 비중 ↑ |
| 5 | 외부사 변경 (웹훅 폭주·재전송 루프) | 웹훅 수신 건수, 외부사 공지·상태 페이지 | 이벤트당 조회+갱신 → 쿼리 수 ↑ |
| 6 | 인프라·토폴로지 (파라미터·페일오버·레플리카 소실·패치·앱 오토스케일) | 클라우드 이벤트 로그, `pg_postmaster_start_time()`, `pg_stat_activity` 커넥션 수 | 읽기가 프라이머리로 몰림 / 콜드 캐시 / 프로세스 수 ↑ → 컨텍스트 스위치·스냅샷 계산 |
| 7 | 캐시 무효화·만료 | 캐시 히트율, Redis 재시작·evict 지표 | 미스 → 원본 쿼리 폭증 |
| 8 | 롱 트랜잭션·bloat·락 | `pg_stat_activity`의 오래된 `xact_start`·`backend_xmin`, `n_dead_tup` | VACUUM이 못 치움 → 죽은 튜플 사이를 훑는 CPU, Index Only Scan이 `Heap Fetches`로 퇴화 (락 대기 자체는 CPU가 아님) |
| 9 | autovacuum (anti-wraparound·대량 갱신 뒤) | `pg_stat_progress_vacuum`, `backend_type = 'autovacuum worker'`, `last_autovacuum` | 워커가 힙 전체 + 모든 인덱스를 훑음 → 워커 수만큼 코어 점유 |

외우는 요령: **"코드는 같은데 무엇이 다른가"를 일곱 방향(데이터·계획·호출자·
바닥·경로·방패·살림)으로 돌리면 이 표가 재생된다.** 표를 통째로 외우는
것보다 §1-1의 일곱 줄에서 도출하는 편이 면접장에서 안전하다. 8·9번이
PostgreSQL 고유의 줄이다 — "살림" 방향이 없으면 이 둘이 빠진다.

### 1-3. 증상 읽기 — "CPU만"이 이미 후보를 반으로 가른다

메커니즘 사슬의 첫 관문은 여기다. "DB가 느리다"가 아니라 **"DB CPU가
올랐다"**는 정보량이 큰 증상이다. DB 서버의 CPU는 무슨 일에 쓰이는가 —
shared_buffers 안의 페이지에서 튜플을 찾고, 튜플마다 `xmin`/`xmax`로 내
스냅샷에 보이는지 판정하고, 조건과 비교하고, 정렬하고, 해시 테이블을 만들고,
결과를 직렬화해 보내는 데 쓰인다. 전부 **메모리 안에서 일어나는 계산**이다.
반대로 디스크에서 페이지를 기다리는 시간과 락을 기다리는 시간은 CPU를 쓰지
않는다.

PostgreSQL은 이 구분을 뷰 하나로 보여 준다. `pg_stat_activity`의 세션이
`state = 'active'`인데 `wait_event`가 **NULL**이면 "아무것도 안 기다리고
돌고 있다" = CPU를 쓰는 중이다. 무언가를 기다리면 `wait_event_type`에
종류(`IO`, `Lock`, `LWLock`, `Client`, …)가 찍힌다. 관리형 서비스의
Performance Insights가 "CPU"라고 그리는 막대가 정확히 이 조건이다.

| 증상 | 병목의 위치 | 판별 지표 (전후 비교) |
|---|---|---|
| user CPU ↑, `active` & `wait_event IS NULL` 세션 ↑ | 계산 — 읽는 튜플·블록 수, 쿼리 수, 건당 연산 증가 | `pg_stat_database.tup_returned`/s, `pg_stat_statements`의 건당 `shared_blks_hit`, `pg_stat_user_tables.seq_tup_read`, `temp_bytes` |
| iowait ↑, user CPU 낮음 | 디스크 — shared_buffers·OS 캐시 밖 페이지 대기 | `wait_event_type = 'IO'`(`DataFileRead`), `pg_stat_database.blks_read` 대 `blks_hit`, `pg_stat_statements.shared_blks_read`, `pg_stat_io`(PG 16+) |
| CPU 낮음, `active` 세션 ↑ | 대기 — 락 | `wait_event_type = 'Lock'`(`transactionid`·`tuple`·`relation`), `pg_locks WHERE NOT granted`, `pg_blocking_pids()` |
| system CPU ↑, `LWLock` 대기 ↑ | 내부 경합 — 커넥션·프로세스 수 | 커넥션 수, `wait_event_type = 'LWLock'`(`LockManager`·`BufferMapping`), 컨텍스트 스위치 수 |
| CPU 낮음, 앱 쪽 커넥션 획득 대기 ↑ | DB 밖 — 풀 크기·앱 스레드 | HikariCP pending 지표 ([connection-count 문서 §4](./15-connection-count-vs-throughput.md)) |

여기서 나오는 추론 세 가지:

1. **"CPU만 올랐다"면 디스크 병목이 아니라 계산 병목이다.** 흔히 헷갈리는
   사슬 — "데이터가 늘어 shared_buffers를 넘쳤다 → 디스크 I/O" — 는 iowait와
   `IO` 대기로 나타나지 user CPU로 나타나지 않는다. 물론 CPU 사용률 지표가
   user·system·iowait를 합산해 보여주는 대시보드라면 먼저 분해부터 해야
   한다(OS `top`, RDS Enhanced Monitoring의 `cpuUtilization.user/wait/system`).
   분해 결과 wait가 주범이면 후보의 무게가 데이터 증가·콜드 캐시 쪽으로,
   user가 주범이면 실행 계획·쿼리 수·bloat·autovacuum 쪽으로, **system이
   주범이면 프로세스 수(커넥션 폭증)** 쪽으로 이동한다 — PostgreSQL은 커넥션
   하나가 OS 프로세스 하나라서 마지막 갈래가 MySQL보다 훨씬 현실적이다.
2. **"DB CPU만" — 앱 서버 CPU는 그대로라면** 요청 총량이 늘어난 것이
   아니다(총량이 늘면 앱 CPU도 같이 오른다). 남는 것은 ⑴ 쿼리당 비용이
   올랐거나(계획·데이터·bloat), ⑵ 앱을 거치지 않는 발신자가
   있거나(배치·타 팀·수동 세션·레플리카 폴백·**autovacuum**), ⑶ 앱은
   기다리기만 하는 패턴(캐시 미스로 DB 호출 수만 증가)이다.
3. **락 대기는 CPU를 올리지 않는다.** "락 경합 때문에 CPU가 올랐다"는 사슬이
   틀린 이유다. 락은 후보 목록에 있지만 그 경로는 "락" 자체가 아니라 "긴
   트랜잭션 → VACUUM이 못 치움 → 죽은 튜플 사이를 훑는 비용 + 밀렸던
   VACUUM이 한꺼번에 돎"이라는 다른 사슬로 CPU에 닿는다(§2-8, §2-9).

---

## 2. 각 후보가 CPU로 나타나는 메커니즘 사슬

"원인 후보를 안다"와 "그 후보가 왜 CPU로 나타나는지 안다"는 다른 수준이다.
각 후보를 **변한 것 → DB 안에서 늘어난 일 → 그 일이 소비하는 자원** 세 마디로
끊어 말한다.

### 2-0. 배포 아닌 코드 경로 변경 — 플래그·원격 설정·A/B 비율

**변한 것**: 누군가 어제 feature flag를 켰거나, 원격 설정(config server)에서
페이지 크기·조회 기간·정렬 옵션을 바꿨거나, A/B 비율을 10%→50%로 올렸다.
배포 이력에는 아무것도 없다.
**늘어난 일**: 새 경로의 쿼리가 실행되기 시작하거나(어제 스냅샷에는 없던
`queryid`가 오늘 스냅샷에 나타난다), 기존 쿼리의 파라미터가 비싼 값으로
바뀐다(조회 기간 7일→90일). 파라미터가 바뀌면 같은 `queryid`인데 건당 읽는
블록만 오른다 — 그리고 파라미터 분포가 바뀌면 준비문의 **제네릭 계획**이
새 분포에서 틀린 계획이 되는 2차 효과(§2-2)가 붙기도 한다.
**자원**: 새 쿼리가 인덱스를 못 타면 튜플 수 폭증 → CPU. 파라미터 변경이면
같은 `queryid`의 `shared_blks_hit / calls`만 오른다.
**확인**: 플래그 시스템의 변경 이력, config 저장소 커밋 로그 — 이 둘이 변경
타임라인(§4-1)에 안 들어가 있으면 "배포 없음"은 영원히 검증되지 않는다.

### 2-1. 데이터 증가·분포 변화

**변한 것**: 행 수가 임계를 넘었거나, 특정 키의 행 수가 튀었거나(한 대형
고객이 어제 주문 10만 건을 넣었다), 값 분포가 바뀌었다(`status = 'PENDING'`
비율이 1%→30%).
**늘어난 일**: 실행 계획은 그대로인데 **같은 계획이 읽는 튜플·블록 수**가
늘어난다. `WHERE user_id = $1`이 `Index Scan`을 타도, 그 user의 행이 100건에서
10만 건이 되면 인덱스 엔트리 10만 개 + 힙 페치 10만 번이다. 범위
조건(`created_at > 어제`)은 하루 유입량에 정비례한다. 인덱스가 없어 `Seq
Scan`으로 돌던 쿼리는 테이블 크기에 **선형**이라 "작을 때는 문제없던 쿼리"가
어느 날 CPU 1위가 된다.
**자원**: 읽는 페이지가 shared_buffers·OS 캐시 안에 있으면 **CPU**(페이지 내
탐색·가시성 판정·비교), 넘치면 **iowait**. 그리고 데이터 증가는 **임계를 넘는
순간 계단식**으로 비용이 튄다 — 정렬·해시가 `work_mem`(기본 4MB, 노드당)을
넘으면 `Sort Method: external merge Disk:`·`Batches > 1`로 임시 파일을
쓰고(`pg_stat_database.temp_bytes` ↑), 테이블이
`min_parallel_table_scan_size`(기본 8MB)를 넘으면 플래너가 `Gather` 아래
병렬 워커를 붙이기 시작해 쿼리 하나가 코어를 여럿 쓴다(§2-2). "어제부터
갑자기"가 완만한 증가와 양립하는 이유가 이 임계들이다.
**확인**: 테이블 행 수·크기 추이(§4-3의 일별 스냅샷), 스냅샷 디프에서
`calls`는 같은데 `shared_blks_hit / calls`만 오른 쿼리, 그 쿼리의 파라미터별
대상 행 수, `pg_stat_user_tables`의 `seq_scan`·`seq_tup_read` 증가분.

### 2-2. 실행 계획 변화 — 자동 ANALYZE·제네릭 계획 전환·JIT·병렬

**변한 것**: 플래너의 입력 또는 플래너의 결정 방식. PostgreSQL에서는 세 갈래다.

- **자동 ANALYZE로 통계가 바뀌었다.** autovacuum은 테이블 행의 일정
  비율(`autovacuum_analyze_scale_factor` 기본 0.1 = 10% + 50행)이 바뀌면
  `ANALYZE`를 돌리고, 그 통계는 **표본**(`default_statistics_target` 기본
  100 → 약 3만 행)으로 MCV 목록·히스토그램을 만든다. 어제 대량 적재·삭제·
  상태 일괄 갱신이 있었다면 재수집이 돌았고, 표본이 운 나쁘게 편향되면 "이
  조건은 1%를 남긴다"에서 "30%를 남긴다"로 추정이 뒤집힌다.
  `pg_stat_user_tables.last_autoanalyze`가 어제 시각이면 이 갈래다.
- **제네릭 계획으로 전환됐다.** pgjdbc는 같은 문장을 5회 실행하면 서버
  준비문(prepared statement)으로 바꾸고, 서버는 커스텀 계획 5회 뒤 **제네릭
  계획**(파라미터 값을 모른 채 평균 선택도로 짠 계획)이 더 싸 보이면
  그쪽으로 고정한다. `status = $1`처럼 편중된 컬럼에서 평균 선택도는 어떤
  값에도 맞지 않는다 — PAID(90%)에는 Seq Scan이 맞고 FAILED(1%)에는 Index
  Scan이 맞는데 제네릭은 하나만 고른다. "어제부터"의 방아쇠는 통계 변화로
  제네릭·커스텀의 비용 비교가 뒤집힌 것이거나(위 갈래와 결합),
  파라미터 구성이 바뀐 것(§2-0·§2-4)이다. 함정은 진단 방법에 있다 — `psql`에서
  값을 직접 넣어 `EXPLAIN`을 뜨면 커스텀 계획이 나와 멀쩡해 보인다.
- **JIT·병렬이 붙기 시작했다.** PostgreSQL은 추정 비용이
  `jit_above_cost`(기본 100000)를 넘으면 그 쿼리의 식 평가·튜플 해체 코드를
  **실행마다** LLVM으로 컴파일한다(PG 12부터 기본 켜짐). 통계 변화로 추정
  비용이 부풀어 초당 수백 번 도는 짧은 쿼리가 이 임계를 넘으면, 5ms짜리
  쿼리에 수십 ms의 컴파일 CPU가 매번 붙는다. 병렬도 같은 구조다 — 추정 비용이
  커지면 플래너가 `Gather` + 워커 2개(`max_parallel_workers_per_gather` 기본
  2)를 붙이고, 그 쿼리는 코어를 셋 쓴다. 둘 다 "쿼리는 그대로, 실행 방식만
  무거워진" 변화라 `EXPLAIN (ANALYZE)` 끝의 `JIT: … Timing:` 줄과
  `Workers Launched:` 줄에서만 보인다.

**늘어난 일**: 추정이 뒤집히면 플래너는 **정직하게** 다른 길을 고른다 —
인덱스 대신 Seq Scan, 조인 순서 역전, Nested Loop 대신 Hash Join(또는 그
반대), 거기에 JIT·병렬. 쿼리 텍스트는 한 글자도 안 바뀌었는데 읽는 튜플 수가
자릿수로 뛴다.
**자원**: Seq Scan은 순차 I/O라 디스크 관점에서는 싸지만([index-not-used-full-scan
§4](./02-index-not-used-full-scan.md)), 테이블이 캐시에 올라와 있다면
**튜플마다 가시성 판정과 조건 비교를 하는 CPU**가 그대로 남는다. JIT은 순수
CPU, 병렬은 CPU 곱셈. "CPU만 올랐다"에 가장 잘 맞는 후보 중 하나가 이것이다.
**확인**: 그 `queryid`의 현재 `EXPLAIN (ANALYZE, BUFFERS)`를 베이스라인(§4-3)과
대조. 추정 `rows`와 실측이 자릿수로 다르면 통계가 범인 — 응급 처방은
`ANALYZE 테이블`. 리터럴 계획은 멀쩡한데 운영이 느리면 제네릭 계획을 의심 —
`auto_explain` 로그의 계획에 `$1`이 찍혀 있으면 준비문 경로이고,
`PREPARE` 후 `EXPLAIN EXECUTE`를 여섯 번 뜨거나 `SET plan_cache_mode =
force_generic_plan`으로 재현한다. 메커니즘의 나머지(MCV·히스토그램·확장
통계, 계획을 고정할 때의 대가)는
[실행 계획 급변 문서](./31-execution-plan-sudden-change.md)와
[explain 문서의 꼬리질문 1](./10-explain-and-slow-query-process.md)에 맡긴다.

### 2-3. 인접 배치·크론·타 팀 잡·리포트

**변한 것**: 새 잡이 등록됐거나, 기존 잡의 시간이 옮겨져 피크와 겹치거나,
잡의 처리량이 커졌거나(월말·이벤트), 타 팀이 같은 DB에 리포트 쿼리를 붙였다.
우리 배포 이력에는 없다 — 그 팀의 배포 이력에 있다.
**늘어난 일**: 배치는 본성상 **대량 스캔·집계·정렬**이다. 운영 쿼리 1만 건
분량의 튜플을 쿼리 한 개가 읽는다.
**자원**: 스캔·집계·정렬 자체가 CPU다. 그리고 **2차 피해** — 대량 스캔이
캐시의 뜨거운 페이지를 밀어낸다. PostgreSQL은 큰 테이블의 Seq Scan에 작은
링 버퍼를 써서 shared_buffers 오염을 완화하지만, **OS 페이지 캐시는 그대로
밀려나고**, 인덱스 스캔·Bitmap Heap Scan·정렬 임시 파일은 보호받지 못한다.
그래서 배치가 끝난 뒤에도 운영 쿼리가 디스크를 다시 읽어야 해서 iowait가
뒤따른다. "배치는 새벽 3시에 끝났는데 아침까지 느렸다"의 정체다. (가산점
포인트) 리포트 쿼리는 여기에 `work_mem`을 크게 잡은 세션이면 정렬·해시
메모리까지, 롱 트랜잭션이면 §2-8까지 겹친다.
**확인**: 배치 메타 테이블(Spring Batch의 `BATCH_JOB_EXECUTION`의
`START_TIME`/`END_TIME`), 크론 로그, `pg_stat_activity`의
`usename`·`application_name`·`client_addr` — DB 롤을 서비스별로 분리해 두었거나
JDBC URL에 `ApplicationName`을 박아 두었다면 발신자가 한눈에 보이고, 전부 하나의
롤을 이름 없이 쓰고 있다면 이 단계에서 막힌다(§4-4). 리포트·통계 쿼리를 운영
DB에서 떼어내는 구조적 해법은 [dashboard-stats 문서](./21-dashboard-stats-oltp-olap-separation.md)의
영역이다.

### 2-4. 트래픽 구성 변화·크롤러·특정 사용자

**변한 것**: 총 RPS는 어제와 같은데 **구성**이 다르다 — 검색·필터 페이지
비중이 올랐거나, 크롤러가 목록 API를 깊은 페이지까지 훑고 있거나, 특정
사용자(대형 고객, 어뷰저, 사내 스크립트)가 대량 조회를 돌리고 있다.
**늘어난 일**: 엔드포인트마다 쿼리 비용이 10~1,000배 다르다. `LIMIT 20 OFFSET
100000`은 20건을 주려고 10만 20건을 읽고 버린다([deep-pagination 문서](./13-deep-pagination-offset-vs-cursor.md)).
비싼 엔드포인트 비중이 5%→20%가 되면 총 RPS가 같아도 DB 일은 몇 배다.
**자원**: 읽는 튜플 수 증가 → CPU. 앱 CPU는 크게 안 오른다(앱은 20건만
직렬화한다) — "DB CPU만"과 잘 맞는다.
**확인**: 엔드포인트별 RPS와 p95, UA·IP별 요청 수, 페이지 번호 분포, 사용자별
호출 순위. APM이 있으면 "어느 엔드포인트의 DB 시간 합계가 어제 대비 가장
늘었나"가 한 번에 나온다.

### 2-5. 외부사 변경 — 웹훅 폭주·재전송 루프

**변한 것**: 결제사·물류사·메신저 등 외부 시스템이 배포했다. 이벤트 형식이
바뀌어 우리 쪽 처리가 실패 → 상대가 재전송 → 또 실패의 루프, 혹은 상대의 장애
복구로 밀렸던 이벤트가 한꺼번에 밀려온다.
**늘어난 일**: 웹훅 하나가 "주문 조회 + 상태 갱신 + 이력 INSERT" 세 쿼리라면
수신 건수에 정비례해 쿼리 수가 는다. 멱등 처리가 되어 있어도 **멱등 확인
조회**(`INSERT … ON CONFLICT DO NOTHING`이든 SELECT든)는 실행된다. 처리가
실패해 트랜잭션이 롤백되면 그 안에서 삽입했던 튜플은 **죽은 튜플로 남아**
VACUUM 몫이 된다 — 실패 루프는 CPU와 bloat를 동시에 만든다.
**자원**: 쿼리 수 증가형 CPU. 여기에 외부 API 응답 지연이 트랜잭션 안에 들어
있으면 §2-8의 긴 트랜잭션 사슬이 겹친다.
**확인**: 웹훅 수신 건수·실패율 그래프, 외부사 공지·상태 페이지·변경 알림 메일
— 이 채널이 변경 타임라인에 구독돼 있지 않으면 "외부사는 변경 없다"도
검증되지 않은 가설이다.

### 2-6. 인프라·토폴로지 — 파라미터·페일오버·레플리카 소실·패치·오토스케일

**변한 것**: 운영팀이나 관리형 서비스, 혹은 오토스케일러가 우리 모르게 무언가를
했다. 대표 다섯 가지:

- **파라미터 그룹 변경**: `shared_buffers`·`work_mem` 축소(메모리 재배분),
  `random_page_cost`·`effective_cache_size` 변경(플래너의 인덱스 선호가
  바뀐다), `jit`·`max_parallel_workers_per_gather` 조정, autovacuum 임계
  조정 — 일부는 즉시, 일부는 재시작 후 적용.
- **페일오버·재시작**: 새 프라이머리의 **shared_buffers와 OS 페이지 캐시는
  비어 있다**(콜드 캐시). 처음 몇 시간은 iowait가 오르고, 워밍이 끝나면
  회복한다. 스탠바이가 다른 사양이었다면 회복하지 않는다. 승격된 스탠바이는
  프라이머리의 `pg_stat_*` 누적 카운터를 물려받지 않으므로 스냅샷 디프가
  뒤틀리는데, 그 뒤틀림 자체가 단서다. 통계 카탈로그(`pg_statistic`)는 WAL로
  복제되므로 계획은 대개 그대로다 — 메이저 업그레이드(`pg_upgrade`)만 통계를
  옮기지 않아 `ANALYZE`가 필요하다.
- **레플리카 소실**: hot standby가 재시작되거나(기동 중에는 접속을 거부한다)
  복제 지연이 임계를 넘어 라우팅에서 빠지면 **읽기 트래픽 전부가
  프라이머리로 온다.** 앱은 오류 없이 폴백하므로 아무도 모르고, 프라이머리
  CPU만 두 배가 된다(§5 사례). 일부 관리형 서비스는 리더가 없으면 리더
  엔드포인트를 라이터로 향하게 한다.
- **앱 오토스케일아웃**: HPA가 앱 파드를 4개→8개로 늘리면 파드마다 HikariCP
  풀 10개씩, 커넥션이 40→80이다. PostgreSQL은 **커넥션 하나가 OS 프로세스
  하나**라 프로세스 80개가 스냅샷을 계산하고 락 테이블을 나눠 쓰며 컨텍스트
  스위치를 한다 — 쿼리 총량이 같아도 system CPU와 `LWLock` 대기가 는다. 앱
  배포는 없었고 "스케일 정책"이 동작했을 뿐이다.
- **자동 마이너 패치**: 플래너 동작이 미세하게 바뀌어 특정 쿼리의 계획이
  달라질 수 있다(드물지만 목록에 있어야 한다).

**자원**: 레플리카 소실은 쿼리 수 증가형 CPU, 콜드 캐시는 iowait, 파라미터
축소는 임시 파일 정렬·해시 스필로 CPU+I/O 혼합, 커넥션 증가는 system CPU.
**확인**: 클라우드 이벤트 로그(RDS 이벤트: failover, configuration change,
maintenance), 파라미터 그룹 변경 이력, 감사 로그(CloudTrail의
`ModifyDBInstance`·`ModifyDBParameterGroup`·`RebootDBInstance`), 프라이머리의
`pg_stat_replication`에서 사라진 스탠바이 행, `pg_stat_activity`의 커넥션 수
추이. `SELECT pg_postmaster_start_time()`이 하루보다 최근이면 어제 무슨 일이
있었던 것이다.

### 2-7. 캐시 무효화·만료

**변한 것**: Redis가 재시작됐거나(유지보수·OOM), 메모리 상한에 닿아 evict가
돌거나, 캐시 키 버전이 바뀌었거나, 같은 TTL로 적재된 키들이 **같은 시각에 일괄
만료**되기 시작했다(어제 예열 배치가 돈 뒤 24시간마다 동시 만료 — cache
stampede).
**늘어난 일**: 미스마다 원본 쿼리. 히트율 95%→70%면 DB로 오는 쿼리는 5%→30%,
즉 **6배**다. 앱은 캐시 대신 DB를 기다릴 뿐이라 앱 CPU는 거의 그대로다.
**자원**: 쿼리 수 증가형 CPU. 원본 쿼리가 비싼 집계였다면(캐시하는 이유가
그것이다) 건당 비용도 크다.
**확인**: 캐시 히트율 그래프의 어제 변곡점, Redis `evicted_keys`·`used_memory`·
재시작 시각, 앱 로그의 캐시 연결 오류. 재발 방지의 TTL 지터·확률적 조기 갱신은
5장 캐싱 문서의 영역이라 여기서는 후보로만 둔다.

### 2-8. 롱 트랜잭션·bloat·락 — 락 대기는 CPU가 아니고, 치우지 못한 튜플은 CPU다

이 후보는 §1-3의 자원 매핑을 정확히 말하는지 보는 시험 문제다.

**락 대기**는 프로세스가 잠들어 있는 상태다(`wait_event_type = 'Lock'`).
`active` 세션 수는 오르고 응답은 느려지지만 **CPU는 오르지 않는다.** "락
때문에 CPU가 올랐다"는 사슬이 끊겨 있다.

**긴 트랜잭션**은 다르다 — 다만 PostgreSQL에서 그 사슬은 MySQL과 모양이 다르다.
PostgreSQL은 옛 행 버전을 별도 공간으로 옮기지 않고 **힙 페이지 안에 그대로
둔다**(UPDATE = 새 튜플 삽입 + 옛 튜플에 `xmax` 표시). 그 옛 버전을 치우는
것이 VACUUM인데, VACUUM은 **가장 오래된 트랜잭션의 `backend_xmin`보다 새로운
죽은 튜플은 건드리지 못한다** — 그 트랜잭션이 아직 볼 수도 있으니까. 그래서
배치·수동 세션(`BEGIN;`만 치고 방치한 psql)·외부 호출을 품은 트랜잭션 하나가
어제부터 열려 있으면:

- 갱신이 잦은 테이블에 죽은 튜플이 쌓인다(`n_dead_tup` ↑). 페이지 단위
  정리(HOT pruning)도 같은 지평선에 막힌다. 페이지가 차면 새 버전은 새
  페이지로 가서 **테이블이 물리적으로 자란다**(bloat).
- 그 테이블을 읽는 **모든** 쿼리가 같은 결과를 얻기 위해 더 많은 페이지를
  읽고, 튜플마다 `xmin`/`xmax`를 보고 내 스냅샷에 보이는지 판정한다(힌트
  비트가 없으면 `pg_xact`까지 조회). 이 판정은 메모리 안의 계산이라 **순수
  CPU**다. 잠긴 행이 아니라 무관한 조회까지 느려진다.
- **Index Only Scan이 퇴화한다.** 죽은 튜플이 있는 페이지는 visibility map에서
  "전부 가시" 표시를 잃고, 그 페이지의 인덱스 엔트리마다 힙을 확인해야 한다 —
  계획의 `Heap Fetches`가 0에서 수만으로 뛴다. 커버링 인덱스로 설계한
  쿼리가 조용히 일반 Index Scan 비용이 된다.
- 인덱스에는 버전 정보가 없어 죽은 튜플을 가리키는 엔트리도 그대로 남는다 →
  인덱스도 커지고, 인덱스 스캔이 죽은 힙 튜플을 찾아갔다 버리는 일이 는다.

그리고 **트랜잭션을 닫아도 즉시 회복되지 않는다.** 죽은 튜플은 VACUUM이 돌아야
사라지고, 그 VACUUM 자체가 다음 후보(§2-9)의 CPU다. 사슬 전체는
[mvcc-postgresql §3](./11-mvcc-postgresql.md)에, 긴 트랜잭션을 만드는 코드
패턴과 짧게 유지하는 방법은
[long-transaction 문서](./16-long-transaction-harm-and-shortening.md)에 있다.

지평선을 붙드는 것은 세션의 트랜잭션만이 아니다 — `hot_standby_feedback`을 켠
레플리카의 긴 쿼리, 소비자가 멈춘 복제 슬롯, 정리 안 된 `PREPARE
TRANSACTION`도 같은 효과를 낸다. "우리 DB에 긴 트랜잭션은 없는데
`n_dead_tup`이 안 줄어든다"면 이쪽이다. (가산점 포인트)

**확인**:

```sql
-- 가장 오래된 트랜잭션 — 누가, 얼마나, 지평선을 어디까지 붙들고 있나
SELECT pid, usename, application_name, state,
       now() - xact_start        AS xact_age,
       age(backend_xmin)         AS xmin_age,     -- 이 값이 크면 VACUUM이 그만큼 못 치운다
       left(query, 60)           AS query
FROM   pg_stat_activity
WHERE  xact_start IS NOT NULL
ORDER  BY xact_start
LIMIT  5;
-- state = 'idle in transaction' + xact_age 수 시간 = 트랜잭션 열어 두고 딴짓 중인 세션

-- 죽은 튜플이 쌓인 테이블
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM   pg_stat_user_tables
ORDER  BY n_dead_tup DESC
LIMIT  5;
```

여기에 그 테이블을 읽는 대표 쿼리의 `EXPLAIN (ANALYZE, BUFFERS)`에서 `Heap
Fetches`와 `Buffers: shared hit`가 어제 베이스라인 대비 얼마나 불었는지를
보면 확정이다. 앱 쪽은 HikariCP의 커넥션 장기 점유(leak detection) 로그.

### 2-9. autovacuum — DB가 스스로 돌리는 배치가 CPU 그래프에 보인다

이 줄은 PostgreSQL 고유다. MySQL을 쓰던 팀이 PostgreSQL로 옮겨 처음 겪는
"배포 없는 CPU 상승"의 단골 원인이기도 하다.

**변한 것**: autovacuum 런처가 어제 어떤 테이블에 워커를 붙였다. 방아쇠는 셋 —
⑴ 대량 UPDATE/DELETE로 죽은 튜플이 `autovacuum_vacuum_scale_factor`(기본 0.2
= 20%)를 넘었다(1억 행 테이블이면 2천만 건). ⑵ 테이블의 XID 나이가
`autovacuum_freeze_max_age`(기본 2억)를 넘어 **anti-wraparound VACUUM**이
시작됐다 — 이것은 갱신량과 무관하게 **시간이 지나면 반드시 온다**(트랜잭션
ID는 32비트라 재사용 전에 옛 튜플을 얼려야 한다). ⑶ §2-8의 긴 트랜잭션이
어젯밤 닫혀서, 며칠 밀렸던 VACUUM이 한꺼번에 돌기 시작했다.
**늘어난 일**: 워커 하나가 테이블의 힙 페이지를 훑고, **그 테이블의 모든
인덱스를 각각 끝까지 훑어** 죽은 튜플을 가리키는 엔트리를 지운 뒤, 힙을 다시
훑어 공간을 회수한다. 수백 GB 테이블에 인덱스가 여섯 개면 시간 단위 작업이고,
워커는 `autovacuum_max_workers`(기본 3)까지 동시에 돈다. anti-wraparound
VACUUM은 아직 얼리지 않은 페이지를 전부 방문해야 해서 더 무겁고, 일반
autovacuum과 달리 **다른 세션의 락 요청에 양보해 취소되지 않는다.**
**자원**: 워커 수만큼의 코어 — 페이지 안 튜플 판정·인덱스 순회는 CPU, 페이지
읽기·쓰기는 I/O. 비용 기반 지연(cost delay)이 I/O를 완만하게 눌러 주지만
CPU 사용 자체는 그래프에 그대로 보인다. 그리고 §2-8과 붙으면 최악이다 — 긴
트랜잭션이 아직 열려 있으면 워커가 열심히 돌아도 지평선 뒤의 튜플은 못
치우고, 조건이 유지되는 한 **다시 시작해 같은 일을 반복**한다. "autovacuum이
계속 도는데 `n_dead_tup`이 안 줄어든다"가 그 신호다.
**확인**:

```sql
-- 지금 도는 VACUUM — 무엇을, 어느 단계까지
SELECT p.pid, p.relid::regclass AS table_name, p.phase,
       p.heap_blks_scanned, p.heap_blks_total,
       a.query                                  -- '(to prevent wraparound)'가 붙어 있으면 anti-wraparound
FROM   pg_stat_progress_vacuum p
JOIN   pg_stat_activity a USING (pid);
-- phase가 'vacuuming indexes'에 오래 머문다 = 인덱스가 크거나 많다

-- 어제 돈 VACUUM 이력과, wraparound까지 남은 거리
SELECT relname, last_autovacuum, autovacuum_count, n_dead_tup
FROM   pg_stat_user_tables ORDER BY last_autovacuum DESC NULLS LAST LIMIT 5;
SELECT relname, age(relfrozenxid) FROM pg_class
WHERE  relkind = 'r' ORDER BY age(relfrozenxid) DESC LIMIT 5;
```

`pg_stat_activity`에서 `backend_type = 'autovacuum worker'`인 행을 세는 것만으로
"지금 CPU를 쓰는 것이 우리 쿼리인가 DB의 살림인가"가 갈린다. 응급 조치의
함정은 §3-4에 — **anti-wraparound VACUUM은 죽이면 안 된다.**

---

## 3. 좁혀가는 절차 — 언제부터 → 무엇이 → 왜

후보 목록이 열 줄이라도 전부를 순서대로 확인하지는 않는다. 세 단계가 각각
후보를 걸러낸다: **시간축이 절반을 지우고, `pg_stat_statements` 비교가 남은
것을 세 갈래로 가르고, 마지막에 하나를 확정한다.**

### 3-1. 언제부터 — 변곡점의 시각과 모양

CPU 그래프를 열어 세 가지를 읽는다. 이 단계에서는 아직 DB에 접속하지 않는다.

**⑴ 변곡점의 시각을 분 단위로.** "어제부터"가 아니라 "어제 14:17부터"여야
다음 단계에서 그 시각 전후를 비교할 수 있다.

**⑵ 곡선의 모양.**

- **계단형**(몇 분 안에 35%→80%로 뛰고 유지): 그 시각에 **이벤트**가 있었다.
  배치 시작, 플래그 토글, 파라미터 적용, 페일오버, 레플리카 이탈, 자동
  ANALYZE로 계획 전환, autovacuum 워커 시작, 캐시 일괄 만료. 후보
  0·2·3·6·7·9가 남는다.
- **완만한 우상향**(며칠에 걸쳐 오르다 어제 임계를 넘음): **누적**이다. 데이터
  증가, 트래픽 증가, 죽은 튜플·bloat 누적. 후보 1·4·8이 남는다.
- **주기형**(매일 같은 시각 스파이크, 어제부터 진폭이 커짐): 스케줄이 있다.
  크론·배치·동시 만료 TTL, 배치 직후 따라붙는 autovacuum. 후보 3·7·9.
- **톱니형**(오르내리며 점점 상승): 재시도 루프나 큐 적체 — 후보 5. 또는
  autovacuum이 테이블 하나를 끝내고 다음 테이블로 옮겨 가는 모양 — 후보 9.

**⑶ 같은 시간축에 변경 타임라인을 겹친다.** 배포 이력, 스키마 마이그레이션
기록(`flyway_schema_history`의 `installed_on`), 배치 실행 기록, 플래그 변경,
클라우드 이벤트, 외부사 공지, 트래픽·캐시 히트율 그래프, 그리고 테이블별
`last_autovacuum`·`last_autoanalyze`를 **같은 화면의 세로선**으로 놓고
변곡점과 일치하는 것을 찾는다. 일치하는 세로선이 있으면 그것이 첫 번째
가설이고, 없으면 "관측되지 않는 변경"(제네릭 계획 전환, 데이터 임계 통과,
외부사)으로 무게가 옮겨간다. 이 화면이 없으면 각 팀 채널에 물어보며 반나절을
쓴다 — 그래서 §4-1이 안전망이다.

> 기동 지연 진단에서 "로그 타임스탬프 간격으로 구간을 먼저 특정"하던 것과 같은
> 원리다. 시간축을 먼저 확정하지 않고 DB에 들어가 `pg_stat_activity`부터 보는
> 것은 침묵 구간을 로그로 읽으려는 것과 같다.

### 3-2. 무엇이 — 변곡점 전후의 `pg_stat_statements` 스냅샷 비교

이제 DB에 들어간다. 볼 것은 "지금 느린 쿼리"가 아니라 **"변곡점 전과 후에
달라진 쿼리"**다. `pg_stat_statements`는 쿼리를 상수를 지운 패턴(`queryid`)별로
호출 수·총 실행 시간·읽은 블록 수를 누적하는데([explain 문서 §4-1](./10-explain-and-slow-query-process.md)),
**누적값**이라 그냥 조회하면 어제와 오늘이 섞인다. 그래서 스냅샷(§4-2)의
디프를 본다. 스냅샷이 없다면 차선으로 현재 값을 덤프한 뒤
`pg_stat_statements_reset()`을 부르고 10분 뒤 다시 읽어 "현재 구간"만이라도
확보한다.

디프에서 상위 쿼리를 **세 갈래**로 분류한다. 이 분류가 후보를 반으로 가른다.

| 갈래 | 스냅샷 디프에서 보이는 모양 | 남는 후보 |
|---|---|---|
| A. 새로 나타난 쿼리 | 전 스냅샷에 없던 `queryid` | 0 플래그 · 3 새 배치·타 팀 · 5 외부사 |
| B. 횟수가 급증한 쿼리 | `calls` ↑, 건당 시간·건당 블록은 그대로 | 4 트래픽 구성 · 5 웹훅 · 6 레플리카 폴백 · 7 캐시 미스 |
| C. 건당 비용이 급증한 쿼리 | `calls` 같음, `shared_blks_hit / calls`·`mean_exec_time` ↑ | 1 데이터 · 2 실행 계획 · 8 bloat(전 쿼리에 고루) · 9 autovacuum(전 쿼리에 고루, 그러나 pg_stat_statements에는 안 잡힘 — 아래) |

PostgreSQL에서 "건당 비용"의 척도는 **`shared_blks_hit + shared_blks_read`를
`calls`로 나눈 값**이다. `rows` 컬럼은 **반환**한 행 수라 검사한 양이 아니고,
읽은 블록 수는 죽은 튜플·bloat·계획 변화를 전부 포함하므로 CPU와 가장 잘
따라간다.

```sql
-- 변곡점 전(스냅샷 s1)과 후(스냅샷 s2)의 디프 — 총 실행 시간 증가분 순
SELECT s2.queryid,
       left(s2.query, 80)                                              AS query,
       s2.calls - coalesce(s1.calls, 0)                                AS calls_delta,     -- B 갈래 판별
       (s2.total_exec_time - coalesce(s1.total_exec_time, 0)) / 1000   AS sec_delta,       -- ms → s
       (s2.shared_blks_hit + s2.shared_blks_read
          - coalesce(s1.shared_blks_hit + s1.shared_blks_read, 0))
         / nullif(s2.calls - coalesce(s1.calls, 0), 0)                 AS blks_per_call,   -- C 갈래 판별
       (s1.queryid IS NULL)                                            AS is_new           -- A 갈래 판별
FROM   ops.stmt_snapshot s2
LEFT JOIN ops.stmt_snapshot s1
       ON  s1.queryid = s2.queryid AND s1.dbid = s2.dbid AND s1.userid = s2.userid
       AND s1.taken_at = '2026-08-30 14:00+09'
WHERE  s2.taken_at = '2026-08-30 15:00+09'
ORDER  BY sec_delta DESC
LIMIT  10;
```

읽는 법 — C 갈래인데 **모든** 쿼리의 건당 시간이 조금씩 올랐으면 개별 쿼리
문제가 아니라 전역 원인(bloat, shared_buffers 축소, 콜드 캐시, 커넥션 폭증,
인스턴스 사양)이고, **특정** 쿼리 하나만 자릿수로 뛰었으면 그 쿼리의 계획 또는
데이터다. B 갈래면 다음 질문은 "누가 부르나" — `pg_stat_activity`의
`usename`·`application_name`·`client_addr`로 발신자를 세고, 앱이면 APM의
엔드포인트별 호출 수로 내려간다.

**autovacuum은 이 디프에 없다.** `pg_stat_statements`는 클라이언트가 보낸
문장만 세므로, 워커가 쓰는 CPU는 "쿼리 쪽 증가분의 합이 CPU 증가분보다
작다"는 **빈칸**으로 나타난다. 그래서 디프와 **동시에** 떠 두는 것이 있다:

```sql
-- 지금 이 순간 CPU를 누가 쓰나 — 세션을 상태·대기 종류·발신자로 집계
SELECT backend_type, state, wait_event_type, application_name, count(*)
FROM   pg_stat_activity
GROUP  BY 1, 2, 3, 4
ORDER  BY count(*) DESC;
-- active + wait_event_type IS NULL 이 많으면 계산 병목, 'autovacuum worker' 행이 있으면 후보 9
```

**서버에 직접 붙을 수 있다면 한 단계 더 — OS의 pid가 곧 백엔드의 pid다.**
PostgreSQL은 커넥션 하나가 OS 프로세스 하나이므로, `top`에서 CPU를 가장 많이
쓰는 프로세스의 pid를 **그대로** `pg_stat_activity.pid`로 조회하면 "그 코어를
태우는 것이 어떤 쿼리인가, 아니면 autovacuum 워커인가"가 한 번에 확정된다.
"CPU 사용량"과 "쿼리"를 잇는 가장 짧은 다리이고, MySQL의 스레드 모델에서는
1:1이 아니라 `performance_schema.threads`로 OS 스레드 ID를 따로 매핑해야
얻는 정보다.

```bash
top -b -n1 -o %CPU | head -20        # ① CPU 상위 pid 확보 (postgres 프로세스들)
psql -c "SELECT pid, backend_type, state, wait_event_type, application_name,
                now() - query_start AS runtime, left(query, 80)
         FROM   pg_stat_activity WHERE pid = ANY('{12345,12346,12347}');"   # ② 그 pid의 정체
# backend_type 이 'client backend' 면 우리(또는 누군가)의 쿼리,
# 'autovacuum worker' 면 후보 9 — 이 한 줄로 §3-2의 "빈칸"이 채워진다
```

관리형 서비스(RDS·Aurora)는 셸이 없어 이 길이 막힌다 — 그쪽 대체재가 바로
아래의 Performance Insights다.

여기에 §2-8의 가장 오래된 트랜잭션, `pg_stat_progress_vacuum`,
`pg_postmaster_start_time()`, `pg_stat_database`의
`tup_returned`·`temp_bytes`·`blks_read` 증가분, 커넥션 수를 같이 본다. 스냅샷
디프의 총 `sec_delta`와 이 집계의 `active` 세션 수가 서로 크기가 맞아야 한다.
관리형 서비스라면 Performance Insights의 "wait event별 DB load"가 §1-3의
자원 매핑을 그래프로 대신해 준다 — PostgreSQL의 `wait_event`가 그대로 축이다.
(가산점 포인트)

> `pg_stat_statements`가 아예 안 켜져 있다면? `shared_preload_libraries`에
> 넣고 **재시작**해야 켜지므로 장애 당일에는 못 켠다. 차선은 1초 간격으로
> `pg_stat_activity`를 5분간 샘플링해 `query`·`wait_event`별로 세는 것 —
> 정밀도는 떨어져도 "무엇이 active 세션의 대부분을 차지하는가"는 나온다.
> 이것이 §4-2를 장애 전에 해 두어야 하는 첫 번째 이유다.

### 3-3. 왜 — 하나로 확정한다

갈래별로 마지막 확인이 다르다.

**C 갈래·특정 쿼리**: 그 쿼리의 `EXPLAIN (ANALYZE, BUFFERS)`를 지금 뜨고
**베이스라인**(§4-3에 어제 저장된 계획)과 나란히 놓는다. 노드 종류·인덱스
이름·조인 순서가 달라졌으면 실행 계획 변경(후보 2) — 추정 `rows`와 실측이
자릿수로 다르면 통계가 원인이고, `ANALYZE` 후 계획이 돌아오면 확정. 계획도
추정도 그대로인데 `Buffers: shared hit`만 늘었으면 데이터(후보 1) 또는
bloat(후보 8) — `Heap Fetches`가 크면 후보 8, 그 파라미터의 대상 행 수가 늘었으면
후보 1. 리터럴로 뜬 계획은 멀쩡한데 운영 실측만 느리면 제네릭 계획 —
`auto_explain` 로그에서 `$1`이 찍힌 실제 계획을 찾거나 `PREPARE` + `EXPLAIN
EXECUTE` 여섯 번으로 재현. 계획 끝에 `JIT:` 줄이나 `Workers Launched:`가 어제
없다가 생겼으면 후보 2의 셋째 갈래.

**C 갈래·전 쿼리**: 가장 오래된 `xact_start`·`backend_xmin`과 `n_dead_tup`(후보
8), `autovacuum worker` 행과 `pg_stat_progress_vacuum`(후보 9),
`pg_postmaster_start_time()`과 이벤트 로그(후보 6 페일오버·파라미터), 커넥션
수와 `LWLock` 대기(후보 6 오토스케일), `blks_read` 비율(콜드 캐시).

**B 갈래**: 발신자가 앱이면 엔드포인트→UA·IP·사용자 순으로(후보 4), 웹훅
핸들러면 수신 건수와 외부사 상태(후보 5), 캐시 조회 뒤의 원본 쿼리면
히트율(후보 7), 레플리카에서 오던 읽기 롤이 프라이머리 `pg_stat_activity`에
나타났으면 라우팅(후보 6).

**A 갈래**: 쿼리 텍스트가 어느 코드·어느 잡의 것인지 — 발신 롤·
`application_name`·호스트, 플래그 변경 이력, 타 팀 배포 이력.

확정의 기준은 하나다: **"이것을 되돌리면(끄면·닫으면·재수집하면) CPU가
내려간다"를 재현하거나, 최소한 시각·크기가 정량적으로 맞는다.** 원인 쿼리의
총 실행 시간 증가분(또는 autovacuum 워커 수 × 경과 시간)이 CPU 증가분과 크기가
비슷해야 한다. 크기가 안 맞으면 원인이 하나가 아니거나 다른 것이다.

### 3-4. 응급 조치와 그 대가 — 양면으로 말한다

원인을 확정하기 전이라도 CPU가 90%라면 무언가 해야 한다. 조치마다 **얻는 것과
잃는 것**을 한 호흡에 붙인다. 그리고 어떤 조치든 **먼저 증거를
보존**한다(`pg_stat_activity` 덤프, `pg_stat_statements` 스냅샷, `pg_locks`,
`pg_stat_user_tables`, `pg_stat_progress_vacuum`) — 조치가 성공하면 증거도
사라진다.

| 조치 | 얻는 것 | 잃는 것 |
|---|---|---|
| 원인 세션 종료 — `pg_cancel_backend(pid)`(문장만) / `pg_terminate_backend(pid)`(세션) | 즉시 부하 제거. **PostgreSQL의 롤백은 `pg_xact`에 abort 표시만 하는 O(1)라 큰 갱신도 롤백 부하가 이어지지 않는다** | 롤백된 갱신의 튜플은 **죽은 튜플로 남아 VACUUM 몫**이 된다. 배치라면 재실행 계획 필요. **anti-wraparound autovacuum은 죽여도 곧 다시 시작**되고, 방치하면 wraparound 보호로 DB가 쓰기를 거부한다 |
| 배치·크론 일시 중지 | 즉시 부하 제거 | 그 배치의 SLA(정산·리포트 지연), 밀린 처리량이 재개 시 몰림 |
| `ANALYZE 테이블` | 통계 원인이면 계획이 즉시 복귀. 쓰기를 막지 않고 초~분 | 원인이 통계가 아니면 무효. 표본이 다시 편향될 수 있어 근본 대책은 아님(`SET STATISTICS` 상향, `CREATE STATISTICS`가 그다음) |
| `ALTER ROLE app SET plan_cache_mode = force_custom_plan` | 제네릭 계획 원인이면 새 커넥션부터 즉시 | 실행마다 플래닝 비용. 근본은 분포·인덱스 설계 |
| `ALTER ROLE app SET jit = off` / `max_parallel_workers_per_gather = 0` | JIT·병렬 폭증형이면 즉시, 재시작 불필요 | 정말 큰 분석 쿼리는 느려짐. 롤 단위로 좁혀 건다 |
| `pg_hint_plan`·세션 `enable_*` | 특정 쿼리의 계획을 고정 | 데이터가 바뀌어도 계획이 안 바뀌는 **경직**. 코드 배포가 필요. PostgreSQL엔 힌트가 기본 문법이 아니라 확장 설치가 전제 |
| 리포트 롤에 `statement_timeout`·`work_mem` 제한 | 폭주 발신자를 즉시 억제 | 정상적으로 긴 쿼리도 실패 |
| 캐시 TTL 연장·예열 | 미스형이면 DB 호출 수 즉시 감소 | 데이터 신선도 저하, 예열 자체가 DB 부하 |
| 특정 발신자 rate limit·차단 | 크롤러·어뷰저형이면 즉시 효과 | 정상 사용자 오탐, 외부사면 계약 문제 |
| 레플리카 추가·읽기 분리 | 프라이머리 CPU를 구조적으로 나눔 | 복제 지연에 따른 stale read, `hot_standby_feedback`을 켜면 프라이머리 bloat, 비용, 라우팅 코드 |
| 인스턴스 스케일업 | 근본 원인 무관하게 여유 확보 | 재시작·페일오버를 동반하면 **콜드 shared_buffers·OS 캐시로 일시 악화**(`pg_prewarm`으로 완화), 비용, 원인을 덮어 재발 |

"스케일업하면 되죠"가 왜 부족한 답인지 — 원인을 덮을 뿐 아니라 재시작을
동반하면 몇 시간 동안 더 나빠질 수 있고, 데이터 증가·트래픽 구성처럼 계속
커지는 원인이면 다음 달에 같은 자리로 돌아온다. bloat가 원인이면 스케일업은
아예 무관하다 — 죽은 튜플은 코어를 늘려도 그대로다. 응급 조치는 "시간을
산다"이지 "해결"이 아니다.

---

## 4. 안전망 고정 — 검증을 사람의 기억에서 시스템으로

§3의 절차가 훌륭해도 그 입력(변경 타임라인, 전후 스냅샷, 베이스라인)이
**미리** 쌓여 있지 않으면 장애 당일에는 쓸 수 없다. "다음에는 이렇게 하자"를
사람이 기억하는 대신 잡과 파이프라인이 기억하게 만드는 네 가지.

### 4-1. 변경 타임라인 — 모든 변경을 하나의 어노테이션 스트림으로

```yaml
# ❌ before: 장애 당일 각 채널에 묻는다
#   "어제 배포하신 분?" / "인프라팀, 어제 뭐 하셨어요?" / "배치 새로 등록된 거 있나요?"
#   → 답이 오는 데 반나절, 오지 않는 답(외부사·플래그·autovacuum·자동 ANALYZE)은 영원히 공백

# ✅ after: 변경을 만드는 모든 통로가 같은 어노테이션 저장소에 이벤트를 남기고,
#           대시보드가 세로선으로 겹쳐 그린다
# 1) 배포 파이프라인 마지막 스텝
- name: annotate-deploy
  run: |
    curl -X POST "$GRAFANA/api/annotations" -H "Authorization: Bearer $TOKEN" \
      -d "{\"tags\":[\"deploy\",\"order-api\"],\"text\":\"$GIT_SHA by $ACTOR\"}"
# 2) 스키마 마이그레이션: flyway_schema_history / DATABASECHANGELOG 를 주기 수집 → 같은 저장소
# 3) 배치: BATCH_JOB_EXECUTION 의 START_TIME/END_TIME 을 주기 수집 → 같은 저장소 (잡 이름 태그)
# 4) 인프라: 클라우드 이벤트(failover·parameter change·maintenance) 구독 → 같은 저장소
# 5) 플래그·원격 설정: 변경 웹훅 → 같은 저장소
# 6) 외부사: 상태 페이지·변경 공지 RSS/웹훅 → 같은 저장소 (태그 vendor:payment)
# 7) DB의 살림: pg_stat_user_tables 의 last_autovacuum / last_autoanalyze 를 주기 수집
#    → 값이 바뀐 테이블마다 어노테이션 (태그 autovacuum:orders) — "관측되지 않는 변경"을 관측 가능하게
```

핵심은 도구가 아니라 원칙이다 — **변경을 만들 수 있는 통로마다 "기록을 남기는
것"이 통로의 일부**여야 한다. 사람이 "기록해야지"라고 기억하는 통로가 하나라도
남아 있으면 그 통로가 다음 장애의 원인이 된다. 7번은 사람이 아니라 DB가 만드는
변경이라 어노테이션이 아니면 아무 데도 남지 않는다.

### 4-2. `pg_stat_statements` 스냅샷 잡 — "어제와 오늘"을 비교 가능하게

```sql
-- ❌ before: 장애 당일 누적 뷰를 그냥 읽는다
--            → 어제 정상 구간까지 합산돼 급증한 쿼리가 묻힌다
SELECT queryid, left(query, 80), calls, total_exec_time
FROM   pg_stat_statements
ORDER  BY total_exec_time DESC LIMIT 10;

-- ✅ after: 주기(예: 10분)로 스냅샷을 남기고 §3-2 디프 쿼리로 구간 비교
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE ops.stmt_snapshot (
  taken_at          timestamptz      NOT NULL,
  dbid              oid              NOT NULL,
  userid            oid              NOT NULL,
  queryid           bigint           NOT NULL,
  query             text,
  calls             bigint,
  total_exec_time   double precision,          -- ms 누적
  rows              bigint,
  shared_blks_hit   bigint,
  shared_blks_read  bigint,
  temp_blks_written bigint,                    -- work_mem 스필의 흔적
  PRIMARY KEY (taken_at, dbid, userid, queryid)  -- PG 14+는 toplevel 도 키에 포함
);
-- pg_cron 또는 외부 크론에서:
INSERT INTO ops.stmt_snapshot
SELECT now(), dbid, userid, queryid, query, calls, total_exec_time, rows,
       shared_blks_hit, shared_blks_read, temp_blks_written
FROM   pg_stat_statements;                    -- 보존 기간은 별도 정리 잡으로 관리
```

알아둘 성질 세 가지: ⑴ 누적값은 **`pg_stat_statements_reset()`을 부르거나
크래시 복구를 거치면 0에서 시작**한다(정상 종료는 기본 설정에서 디스크에
저장했다가 복원한다). 스냅샷 디프가 음수면 그 사이 리셋이나 크래시·페일오버가
있었다는 뜻이고, 그 자체가 후보 6의 단서다. ⑵ 뷰에는 **항목 수
상한**(`pg_stat_statements.max`, 기본 5000)이 있어 상한을 넘으면 덜 쓰인
항목을 **통째로 버린다** — 상한 밖의 쿼리는 아예 안 보인다. 그 폐기 횟수가
`pg_stat_statements_info.dealloc`(PG 14+)에 쌓이는데, 이 값이 급증하면 "새 쿼리
패턴이 대량으로 생겼다"는 신호(ORM이 `IN ($1, $2, $3, …)` 길이별로 다른
`queryid`를 만드는 경우가 흔한 원인)다. ⑶ 관리형 서비스의 Performance
Insights나 서버 로그를 돌리는 `pgBadger` 일일 리포트가 이 잡을 대신할 수 있다
— 무엇이든 "전후 비교가 가능한 형태로 남는가"가 기준이다.

### 4-3. 실행 계획 베이스라인 + 테이블 크기 스냅샷

```bash
# ✅ 매일 새벽 (의사 코드): 총 비용 상위 N개 queryid 의 대표 쿼리를 EXPLAIN (FORMAT JSON) 으로
#    저장하고 전일과 diff. 비용 숫자는 매일 조금씩 달라지므로 노드 종류·관계·인덱스·추정 행만 추출해 비교
for q in "${TOP_QUERIES[@]}"; do
  psql -Atc "EXPLAIN (FORMAT JSON) $q" \
    | jq '.. | objects | select(has("Node Type"))
           | {node: .["Node Type"], rel: .["Relation Name"], index: .["Index Name"], rows: .["Plan Rows"]}' \
    > "plans/$(date +%F)/$(echo -n "$q" | sha1sum | cut -c1-12).json"
done
diff -rq "plans/$(date -v-1d +%F)" "plans/$(date +%F)" \
  | grep differ && notify "#db-alerts" "실행 계획 변경 감지 — 목록 첨부"
```

PostgreSQL에도 계획을 고정하는 내장 베이스라인 기능은 없으므로 **"바뀌었다"를
사람이 아니라 잡이 발견**하게 하는 것이 현실적 목표다. §3-3에서 "베이스라인과
대조"가 가능한 것은 이 잡이 어제 계획을 남겨 두었기 때문이다. 두 가지를
덧붙인다. ⑴ 리터럴을 넣은 `EXPLAIN`은 **커스텀 계획**이라 운영의 제네릭
계획과 다를 수 있다 — 준비문 경로가 뜨거운 쿼리는 `PREPARE p AS …; SET
plan_cache_mode = force_generic_plan; EXPLAIN EXECUTE p(…)`로 제네릭 계획도
같이 남긴다. ⑵ 실제 운영 계획의 원천은 `auto_explain`이다 —
`auto_explain.log_min_duration`을 낮게, `log_analyze`·`log_buffers`를 켜고
`sample_rate`로 양을 조절하면 "어제 실제로 돌았던 계획"이 로그에 남는다.
(가산점 포인트)

같은 잡에 테이블 통계를 일별로 적재해 두면 후보 1·8·9의 "어제 임계를
넘었나"가 그래프로 보인다:

```sql
INSERT INTO ops.table_snapshot
SELECT now(), relid::regclass::text AS table_name,
       n_live_tup, n_dead_tup, pg_total_relation_size(relid) AS total_bytes,
       seq_scan, seq_tup_read, idx_scan,
       last_autovacuum, last_autoanalyze, autovacuum_count
FROM   pg_stat_user_tables;
-- n_dead_tup 가 계속 오르면 후보 8, total_bytes 가 계단으로 뛰면 후보 1, seq_scan 이 튀면 후보 2
```

CI 단계에서의 `EXPLAIN` 단정은 [explain 문서 §4-4 층 2](./10-explain-and-slow-query-process.md)와
같은 도구다.

### 4-4. 증상 → 자원 지표 알람 세트, 그리고 발신자 식별

§1-3의 표를 알람으로 옮긴다: `active` 세션 수(실행 중 백엔드 급증),
`pg_stat_database.tup_returned`/s(읽는 튜플 수 급증 — CPU의 선행 지표),
`blks_read / (blks_hit + blks_read)` 비율(콜드 캐시·캐시 초과), 가장 오래된
`xact_start`와 `backend_xmin`의 나이(긴 트랜잭션), 테이블별 `n_dead_tup /
n_live_tup`(bloat), `temp_bytes`/s(스필), 커넥션 수 대 `max_connections`,
`autovacuum worker` 수와 `age(datfrozenxid)`(wraparound 접근), 캐시 히트율,
`pg_stat_replication.replay_lag`와 스탠바이 행의 존재. CPU 알람 하나만 있으면
"올랐다"는 알지만 "무엇이"는 모른다 — 지표를 자원별로 나눠 두면 알람 조합이
§1-3의 판별을 대신한다.

그리고 **발신자를 식별 가능하게** 만든다 — 두 겹이다. ⑴ DB 롤을 서비스별·
배치 전용·사람 전용으로 분리한다. ⑵ PostgreSQL 고유의 손쉬운 길:
`application_name`. JDBC URL에 `?ApplicationName=order-api`(HikariCP면
`dataSourceProperties`)를 박아 두면 `pg_stat_activity.application_name`에
그대로 찍히고, `log_line_prefix`에 `%a`를 넣으면 서버 로그의 모든 줄에
붙는다. 롤을 나눌 정치적 비용 없이도 "누가 부르나"가 뷰 한 번으로 끝난다.
§3-2의 "누가 부르나"가 `pg_stat_activity` 한 번으로 끝나느냐, 커넥션 IP를
역추적하느냐가 여기서 갈린다.

---

## 5. 실무 사례 — 레플리카가 조용히 사라진 날

**증상**: 화요일 아침 알람. 프라이머리 CPU가 월요일 14:17부터 38%→81%로
**계단형** 상승 후 유지. 앱 서버 CPU·RPS는 평소와 같음. 배포 파이프라인 이력:
마지막 배포는 금요일.

**① 언제부터**: 변곡점 14:17, 계단형 → 이벤트형 후보(0·2·3·6·7·9)로 압축.
변경 타임라인을 겹치니 14:16에 클라우드 이벤트 세로선 — "read replica:
instance restarted (maintenance)". 배포·플래그·배치·마이그레이션·autovacuum
세로선은 없음. 첫 가설: 후보 6.

**② 무엇이**: `pg_stat_statements` 스냅샷 14:00 vs 15:00 디프. 상위 8개가
전부 **B 갈래** — `SELECT … FROM episode WHERE series_id = $1`, `SELECT … FROM
comment WHERE episode_id = $1 ORDER BY id DESC LIMIT $2` 등 읽기 전용 쿼리의
`calls`가 프라이머리에서 2.1배, 건당 시간·건당 블록은 동일. 새 `queryid`(A)도,
건당 비용 급증(C)도 없음. `pg_stat_activity`의 발신자는
`application_name = 'webtoon-api:ro'`, 롤은 평소 레플리카에 붙던 `webtoon_ro`
— 프라이머리에 나타나 있음. 프라이머리의 `pg_stat_replication`: 14:16에 스탠바이
행이 사라졌다가 14:31에 복귀. 레플리카 지표: 14:16 이후 클라이언트 커넥션 0.

**③ 왜**: 레플리카가 유지보수로 재시작 → 기동 중에는 접속을 거부하고, 복구가
끝난 뒤에도 밀린 WAL을 재생하느라 `replay_lag`이 임계를 넘음 → 앱의 라우팅
데이터소스가 "레플리카 비정상"으로 판정하고 **조용히 프라이머리로 폴백** →
레플리카는 15분 뒤 정상이 됐지만 앱 쪽 헬스체크가 재편입을 시도하지 않는
구현이라 폴백 상태가 유지됨. 크기 검증: 읽기 쿼리 총 실행 시간 증가분이 CPU
증가분과 비례.

**응급 조치와 대가**: 앱 인스턴스 롤링 재시작으로 라우팅 초기화(수 분의 배포와
같은 위험, 그러나 코드 변경 없음) vs 레플리카 추가(수십 분, 비용). 전자를
택하고 5분 내 CPU 복귀.

**안전망으로 고정한 것**: ⑴ 폴백은 **시끄럽게** — 라우팅 데이터소스가
프라이머리로 폴백하는 순간 메트릭과 알람. 조용한 폴백은 가용성을 지키는 대신
장애를 숨긴다는 트레이드오프가 있었고, 가용성은 유지하되 알람을 붙이는 쪽으로
양면을 취함. ⑵ 레플리카 재편입을 주기 헬스체크로 자동화 — 헬스체크는
`pg_is_in_recovery()`와 `now() - pg_last_xact_replay_timestamp()`(지연)를 함께
본다. ⑶ 클라우드 이벤트가 변경 타임라인에 이미 들어와 있었기에 ①이 5분에
끝났음을 회고에 기록 — 없었다면 "인프라팀 어제 뭐 하셨어요?"에서 시작했을 것.

```java
// ❌ before: 조용한 폴백 — 가용성은 지키지만 아무도 모른다
@Override
protected Object determineCurrentLookupKey() {
    if (isReadOnlyTx() && replicaHealthy) return "replica";
    return "primary";                       // 폴백 사실이 어디에도 남지 않는다
}

// ✅ after: 폴백은 유지하되 관측 가능하게, 그리고 재편입을 시도한다
@Override
protected Object determineCurrentLookupKey() {
    if (isReadOnlyTx()) {
        if (replicaHealth.isHealthy()) return "replica";
        fallbackCounter.increment();        // 메트릭 → 알람 (지속 1분이면 페이지)
        replicaHealth.scheduleRecheck();    // 복구 시 자동 재편입 (pg_is_in_recovery + replay 지연 확인)
    }
    return "primary";
}
```

같은 절차를 후보 2(실행 계획 변화)에 적용한 사례는 C 갈래·특정 쿼리로 시작해
`EXPLAIN (ANALYZE, BUFFERS)` 대조 → `ANALYZE` 또는 `plan_cache_mode`로
끝나는데, 그 사례와 재발 방지(statistics target·확장 통계·배치 후 `ANALYZE`
스텝)는 [실행 계획 급변 문서](./31-execution-plan-sudden-change.md)에서
이어진다.

---

## 6. 꼬리질문 대비 포인트

### "CPU는 올랐는데 느린 쿼리 로그에는 아무것도 안 잡힙니다. 왜 그럴 수 있고, 어디를 보나요?"

`log_min_duration_statement`는 **건당 실행 시간**이 임계를 넘는 쿼리만
기록한다. CPU를 올리는 가장 흔한 패턴 — 건당 20ms인 쿼리가 초당 5,000번(캐시
미스, 크롤러, N+1, 레플리카 폴백) — 은 한 건도 임계를 안 넘는다. 그래서 §3-2의
B 갈래는 로그가 아니라 `pg_stat_statements`의 `calls × mean_exec_time`으로만
보인다. PostgreSQL에는 MySQL의 "인덱스 안 쓴 쿼리만 로그" 같은 스위치가 없으니
"빠르지만 많이 읽는" 쿼리는 `pg_stat_statements`를 `shared_blks_hit / calls`로
정렬하거나 `pg_stat_user_tables.seq_scan` 증가분으로 잡는다. 로그 쪽 보조
수단은 임계를 0에 가깝게 낮추되 `log_min_duration_sample` +
`log_statement_sample_rate`(PG 13+)로 표본만 남기는 것 — 전부 남기면 로그
I/O가 새 병목이 된다는 대가가 있다. 그리고 autovacuum은 어느 로그에도 쿼리로
안 남는다 — `log_autovacuum_min_duration`을 켜 두어야 "어제 몇 시에 어느
테이블을 얼마나 오래 청소했다"가 로그에 남는다. 결론: "로그에 없다"는 "느린
쿼리가 없다"가 아니라 "건당은 빠르다, 또는 클라이언트 쿼리가 아니다"는
정보이고, 그 자체가 B 갈래나 후보 9를 가리키는 단서다.

### "CPU 상승, I/O 대기, 락 대기를 지표만으로 어떻게 구분하나요?"

§1-3의 표를 말로 풀면 된다. `pg_stat_activity`에서 `active`이면서
`wait_event`가 NULL인 세션이 많고 user CPU가 높으면 **계산**(읽는 튜플 수·쿼리
수·정렬). user CPU는 낮은데 iowait와 `wait_event_type = 'IO'`(`DataFileRead`),
`pg_stat_database.blks_read`가 오르면 **디스크**(캐시 초과, 콜드 캐시, 대량
스캔의 오염). CPU도 iowait도 낮은데 `active`는 많고 `wait_event_type =
'Lock'`이면 **락** — `pg_blocking_pids()`로 누가 잡고 있는지 한 번에 나온다.
system CPU와 `LWLock` 대기가 함께 오르면 **프로세스 수**(커넥션 폭증 —
PostgreSQL 고유의 넷째 갈래). 셋 다 낮은데 앱만 느리면 DB 밖(커넥션 풀,
네트워크, 앱 스레드). 이 구분이 되어야 "CPU가 올랐으니 계획과 bloat를
보자"와 "iowait가 올랐으니 캐시와 배치를 보자"가 갈린다 — 같은 "DB가
느리다"에서 정반대의 첫 행동이 나온다.

### "원인을 찾기 전에 당장 CPU를 내려야 한다면 무엇을 하고, 그 대가는 무엇인가요?" (시니어 변별 포인트)

순서가 답이다. ⑴ **증거 보존** — `pg_stat_activity`·`pg_stat_statements`
스냅샷·`pg_locks`·`pg_stat_user_tables`·`pg_stat_progress_vacuum`을 파일로
뜬다. 조치가 성공하면 증거는 사라지고 재발 방지가 불가능해진다. ⑵ **가역적이고
국소적인 조치부터** — 발신자가 특정되면 그 배치 중지·그 IP 제한, 오래된
트랜잭션이면 `pg_terminate_backend`(PostgreSQL은 롤백이 O(1)라 MySQL처럼
롤백 부하가 이어지진 않지만 죽은 튜플은 남는다), 계획 문제로 보이면
`ANALYZE`, 제네릭 계획이면 롤 단위 `plan_cache_mode`, JIT·병렬이면 롤 단위
`jit = off`. 단 **autovacuum 워커는 죽이지 않는다** — 일반 것은 다시 오고,
anti-wraparound는 반드시 다시 오며 미루면 DB 전체가 쓰기를 멈춘다. 필요하면
속도 제한(cost delay)을 조정해 CPU를 시간과 바꾼다. ⑶ **전역 조치는 마지막**
— 스케일업은 재시작·페일오버를 동반하면 콜드 캐시로 몇 시간 더 나빠질 수
있고, 원인을 덮어 다음 달 같은 자리로 돌아오며, bloat 원인이면 아예 무관하다.
각 조치의 대가는 §3-4 표 그대로. 면접관이 듣고 싶은 문장은 "응급 조치는
시간을 사는 것이고, 무엇을 샀는지와 무엇을 지불했는지를 회고에 적는다"이다.

### "`pg_stat_statements`는 누적값인데 '어제와 오늘'을 어떻게 비교하나요? 운영 DB에서 켜두는 비용은요?" (시니어 변별 포인트)

누적값은 그 자체로는 구간 비교가 안 되므로 **주기 스냅샷의 디프**(§4-2)나
관리형 서비스의 Performance Insights, `pgBadger` 일일 리포트처럼 **"전후"가
남는 형태**가 필요하다. 없을 때의 차선은 현재 값을 덤프한 뒤
`pg_stat_statements_reset()`을 부르고 일정 시간 뒤 다시 읽어 현재 구간만
확보하는 것 — 단 이 순간 과거는 영구히 사라지므로 덤프가 먼저다. 성질로는
리셋·크래시 시 초기화(디프가 음수면 단서)와 항목 수 상한(넘치면 덜 쓰인
항목을 폐기, `dealloc` 급증 = 새 패턴 폭증) 두 가지를 알아야 한다. 비용은
트레이드오프다: 기본 계측은 문장당 해시·카운터 갱신 수준이라 대개 감수할
만하고, `track_planning`이나 `track_io_timing`처럼 시간을 재는 옵션을 더할수록
오버헤드가 붙으며, `auto_explain`을 `log_analyze = on`으로 모든 문장에 걸면
부하가 눈에 띈다(그래서 `sample_rate`). 반대로 아예 안 켜면 §3-2 전체를
잃는데, **`pg_stat_statements`는 `shared_preload_libraries`라 장애 당일에는 못
켠다**는 것이 결정적이다 — "미리 켜 두는 것"이 곧 진단 능력이다. "기본
`pg_stat_statements`는 켜 두고, 더 세밀한 계측은 표본 비율로 상시, 전수는
장애 시 잠깐"이 균형점이다.

### "'변경 없음'을 사람에게 묻지 않고 확인하려면 팀에 무엇이 갖춰져 있어야 하나요?" (시니어 변별 포인트)

§4를 우선순위로 답한다. ⑴ **변경 타임라인** — 배포·스키마·배치·플래그·인프라
이벤트·외부사 공지, 그리고 autovacuum·자동 ANALYZE 기록이 한 저장소에
어노테이션으로 들어오고 대시보드에 세로선으로 겹쳐 보이는 것. 이것이 없으면
§3-1이 성립하지 않는다. ⑵ **`pg_stat_statements` 스냅샷 잡** — 전후 비교의
재료(확장 자체가 미리 켜져 있어야 한다). ⑶ **실행 계획·테이블 통계 일별
스냅샷** — "관측되지 않는 변경"(통계·제네릭 계획·데이터 임계·bloat)을 관측
가능하게 만드는 것. ⑷ **발신자 식별** — 서비스·배치·사람별 롤 분리 +
`application_name`. 그리고 이 네 가지는 기능 개발이 아니라 **다음 장애의 진단
시간을 반나절에서 5분으로 줄이는 투자**라는 프레임으로 팀을 설득한다 — 시니어
변별은 도구 목록이 아니라 "이 투자가 언제 회수되는가"를 말할 수 있는지에 있다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **진단 뷰의 생김새** — MySQL은
`performance_schema.events_statements_summary_by_digest`에 `FIRST_SEEN`이
있어 "새 쿼리"를 뷰 한 번으로 알고, 상한을 넘은 패턴은 `DIGEST = NULL` 행에
뭉쳐 집계되며, 상태 카운터(`Threads_running`, `Innodb_rows_read`)와
`SHOW PROCESSLIST`의 State 문자열로 자원을 가른다. PostgreSQL은
`pg_stat_statements`에 첫 등장 시각이 없어 **스냅샷 LEFT JOIN**으로 알아내고,
상한을 넘으면 항목을 **폐기**하며(`dealloc`), 자원 구분은 `pg_stat_activity`의
`wait_event`(NULL = CPU)가 맡는다. ② **긴 트랜잭션이 CPU에 닿는 길** —
InnoDB는 옛 버전이 **언두 로그**에 있어 퍼지가 밀리면(History list length ↑)
읽기마다 **언두 체인을 순회**하는 CPU가 붙고, 트랜잭션을 닫으면 곧 회복된다.
PostgreSQL은 옛 버전이 힙에 남아 **VACUUM이 못 치우는 bloat**로 나타나고,
Index Only Scan이 `Heap Fetches`로 퇴화하며, 트랜잭션을 닫아도 VACUUM이 돌
때까지(그리고 그 VACUUM의 CPU까지) 회복되지 않는다. ③ **DB 자신의 배치** —
InnoDB의 퍼지 스레드·체인지 버퍼 병합은 조용한 백그라운드라 후보 목록에
잘 안 오르지만, PostgreSQL의 autovacuum(특히 anti-wraparound)은 CPU 그래프에
보이는 크기라 **후보 9번이 별도 줄**로 필요하다. ④ **커넥션 수** — MySQL은
스레드 모델이라 커넥션이 수백 개 늘어도 CPU에 잘 안 보이지만, PostgreSQL은
프로세스 모델이라 앱 오토스케일 한 번이 system CPU와 `LWLock` 대기로
나타난다. 같은 성질이 진단에서는 이점이 된다 — PG는 `top`의 pid를 그대로
`pg_stat_activity.pid`로 조회하면 "이 코어를 태우는 것"의 정체가 나오지만,
MySQL은 `performance_schema.threads`로 OS 스레드 ID를 한 번 더 매핑해야
한다. ⑤ **응급 조치의 대가** — MySQL `KILL`은 큰 갱신의 롤백이 실행만큼
오래 걸려 부하가 이어지고, 옵티마이저 힌트로 계획을 고정할 수 있다.
PostgreSQL `pg_terminate_backend`는 롤백이 O(1)이지만 죽은 튜플이 남고, 힌트
문법이 없어 `plan_cache_mode`·통계 교정·`pg_hint_plan` 확장으로 대응한다. 이
다섯을 짚으면 "한쪽만 써봤다"가 아니라 "저장 구조 차이에서 진단 절차가 어떻게
갈리는지 안다"로 들린다.

---

## 한 줄 요약

"배포 없음"은 코드가 안 바뀌었다는 말일 뿐이라 시스템의 변경(데이터·계획·
호출자·바닥·경로·방패·**살림**)을 변경 타임라인으로 먼저 검증하고, 좁히기는
**언제부터**(변곡점의 시각과 모양) → **무엇이**(전후 `pg_stat_statements`
스냅샷 비교를 새 쿼리·횟수 급증·건당 블록 급증 세 갈래로, 그 디프에 안 잡히는
autovacuum은 `pg_stat_activity`의 `backend_type`으로) → **왜**(계획 베이스라인
대조·발신자 추적)의 순서로 — "CPU만"은 계산 병목이라 `active`이면서
`wait_event`가 NULL인 세션으로 보이고 디스크(`IO`)·락(`Lock`)·프로세스
수(`LWLock`)와 구분되며, PostgreSQL 고유의 줄은 롱 트랜잭션이 VACUUM을 막아
생기는 bloat와 autovacuum 자체다. 이 절차의 입력(타임라인·스냅샷·베이스라인)은
장애 전에 시스템이 쌓아 두어야 장애 당일에 쓸 수 있다.
