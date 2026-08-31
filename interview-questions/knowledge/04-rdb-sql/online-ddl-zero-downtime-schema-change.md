# 무중단 스키마 변경(online DDL) — "컬럼 하나 추가"가 서비스를 세우는 사슬과 그 사슬을 끊는 방법

> 핵심 관전 포인트: **대용량 테이블의 ALTER가 위험한 이유는 두 갈래다.
> ① 알고리즘과 무관하게 모든 ALTER는 테이블의 배타 메타데이터 락(MDL)을
> 잡아야 하는데, 열려 있는 긴 트랜잭션 하나가 그것을 막으면 ALTER가
> 대기하고, 그 뒤로 들어오는 그 테이블의 모든 쿼리가 줄을 서고, 앱의
> 커넥션 풀이 고갈되어 무관한 API까지 전면 장애가 된다. ② 알고리즘이
> COPY/재구성이면 수 시간 동안 쓰기 차단·디스크 2배·복제 지연이 따라온다.
> 그래서 답은 "MySQL 8 알고리즘 3종(INSTANT / INPLACE / COPY) 중 무엇이
> 걸리는지 먼저 판별 → 컬럼 추가는 INSTANT, 인덱스 추가는 INPLACE로
> 네이티브 처리하되 `lock_wait_timeout`을 짧게 → 재구성이 불가피하면
> pt-online-schema-change 또는 gh-ost로 청크 복사 → 이 절차를 사람 기억이
> 아니라 마이그레이션 도구·CI 린트·체크리스트에 고정"이다. 도구 셋은 각각
> 복제 지연 / 트리거 부하 / FK 미지원이라는 대가를 지불하며, 어느 것도
> MDL 문제 자체를 없애주지는 않는다.**

---

## 0. 질문 + 의도

**질문**: "대용량 테이블에 컬럼 추가/인덱스 추가를 무중단으로 하려면?
(online DDL, pt-osc 등)"

**출제 의도**: "컬럼 하나 추가"가 수억 건 테이블에서는 **서비스 중단
리스크**임을 아는지. 이 감각이 없는 사람은 운영 DB에 습관처럼 ALTER를
날려 사고를 낸다. 동시에 **스키마 변경 절차를 갖춘 팀에서 일해봤는지**도
드러난다 — 즉 "도구 이름을 아는가"가 아니라 ⑴ 왜 위험한지를 메커니즘으로
말할 수 있는가 ⑵ 선택지마다 무슨 대가를 치르는지 아는가 ⑶ 그 판단을
개인의 주의력이 아니라 팀의 절차로 고정해봤는가를 본다.

> 이 문서는 후보자의 횡단 약점 4가지를 겨냥해 구성했다 — ① 비용·인과를
> **이름 붙은 사슬**로 말하기(1장) ② 선택지마다 **대가를 양면으로**
> 조립하기(3장) ③ 안전망을 **팀 규칙·코드로 고정**하기(4장) ④ 알고리즘
> 3종 ↔ 대표 작업을 **목록으로 인출**하기(2장).

> 역할 구분: [graceful-shutdown-zero-downtime-deploy.md](../02-spring/graceful-shutdown-zero-downtime-deploy.md)는
> **앱 프로세스 교체**의 무중단(LB 제외 → 진행 중 요청 완료 → SIGTERM)을
> 다룬다. 이 문서는 **스키마 변경**의 무중단이다. 둘은 별개의 축이고 둘 다
> 있어야 "무중단 배포"가 성립한다 — 배포 파이프라인이 완벽해도 ALTER 한
> 줄이 서비스를 세우고, 스키마를 무중단으로 바꿔도 구버전 앱이 새
> 스키마에서 죽으면 롤링 배포 중 에러가 난다(4-4절).

---

## 1. 왜 ALTER 한 줄이 전면 장애가 되는가 — 세 개의 사슬

"ALTER는 위험하다"를 아는 것과 **어떤 단계를 거쳐 장애가 되는지**를 말할
수 있는 것은 다른 평가를 받는다. 이 장은 뭉뚱그린 "락 걸려서 느려진다"를
세 개의 사슬로 쪼갠다. 면접에서는 사슬 A를 먼저, 그 다음 B·C를 말한다.

### 1-1. 사슬 A — 메타데이터 락 대기 (알고리즘과 무관, 가장 흔한 사고)

등장인물의 이름부터 고정한다.

- **메타데이터 락(MDL, metadata lock)**: 행이 아니라 **테이블 정의**를
  보호하는 락. 어떤 문장이 테이블을 읽거나 쓰는 동안 그 테이블의 구조가
  바뀌면 안 되므로, SELECT/INSERT/UPDATE는 **공유(shared) MDL**을,
  ALTER/DROP은 **배타(exclusive) MDL**을 요구한다. 행 락(`innodb_lock_wait_timeout`,
  기본 50초)과는 **완전히 다른 락**이다.
- 공유 MDL은 **문장이 끝날 때가 아니라 트랜잭션이 끝날 때** 풀린다.
  트랜잭션 안에서 SELECT 한 번 하고 커밋을 안 한 세션은 그 테이블의 공유
  MDL을 계속 쥐고 있다.
- MDL 대기의 상한은 `lock_wait_timeout`인데 **기본값이 31,536,000초
  (1년)** 다. 사실상 무한 대기다.

이제 사슬:

> ⑴ 어떤 세션이 `orders` 테이블을 건드리는 **긴 트랜잭션**을 열어 두고
> 있다 — 대시보드 집계 쿼리, 배치, 개발자가 워크벤치에서 `BEGIN` 후 잊은
> 세션, 외부 API 호출을 트랜잭션 안에 넣은 앱 코드. 이 세션은 공유 MDL을
> 쥐고 있다.
> ⑵ 운영자가 `ALTER TABLE orders ADD COLUMN ...`을 실행한다. ALTER는
> 배타 MDL을 요청하고, ⑴ 때문에 **대기**한다(`SHOW PROCESSLIST`에
> `Waiting for table metadata lock`). `lock_wait_timeout`이 1년이므로
> 스스로 포기하지 않는다.
> ⑶ MDL은 **큐**다. 배타 요청이 대기 중이면, DDL이 영원히 굶는 것을 막기
> 위해 **그 뒤에 들어오는 공유 요청도 배타 요청을 추월하지 못하고 줄을
> 선다.** 즉 이 순간부터 `orders`를 읽는 SELECT 한 줄까지 **전부 멈춘다.**
> ⑷ 앱 관점: 요청 스레드가 DB 응답을 기다리며 **커넥션을 쥔 채** 멈춘다.
> HikariCP 풀(기본 10개)은 순식간에 바닥난다. 풀은 앱 전체가 공유하므로
> **`orders`와 아무 상관없는 API**(로그인, 상품 조회)까지
> `connection-timeout`(기본 30초) 후 실패한다.
> ⑸ 톰캣 워커 스레드도 대기 중인 요청으로 가득 차고, 헬스체크가 타임아웃
> → LB 제외 또는 재시작 → 재시작해도 DB 쪽 큐는 그대로라 다시 막힘.
> **테이블 하나의 락 대기가 서비스 전면 장애로 증폭**됐다.

여기서 반드시 짚을 것: 이 사슬은 **ALTER의 알고리즘이 INSTANT여도
똑같이 발생한다.** INSTANT는 "실행 시간이 수 ms"라는 뜻이지 "MDL을 안
잡는다"는 뜻이 아니다. 1ms짜리 ALTER가 ⑴의 긴 트랜잭션 뒤에서 10분을
대기하면, 그 10분 동안 서비스는 죽어 있다. "MySQL 8이니까 INSTANT라
안전하다"는 말이 위험한 이유다.

복구는 사슬의 ⑴ 또는 ⑵를 끊는 것이다 — 원흉 트랜잭션을 `KILL` 하거나
ALTER 세션을 `KILL` 한다. ALTER를 죽이면 큐가 즉시 풀린다. 진단 쿼리는
4-1절에 있다.

### 1-2. 사슬 B — 테이블 재구성의 자원 비용 (COPY / INPLACE-rebuild)

알고리즘이 COPY거나 INPLACE 중에서도 재구성(rebuild)이 필요한 작업이면,
MDL을 무사히 얻은 뒤에도 두 번째 사슬이 기다린다.

> ⑴ 새 테이블 파일을 만들고 **전 행을 읽어 다시 쓴다** → 테이블 크기만큼
> **디스크가 일시적으로 2배** 필요하다(모자라면 중간에 실패하고, 실패
> 정리도 오래 걸린다).
> ⑵ 수 시간 동안 **CPU와 디스크 I/O를 점유**한다 → 같은 인스턴스의 다른
> 쿼리도 느려진다(버퍼 풀을 복사 작업이 밀어내는 것도 포함).
> ⑶ COPY라면 그 시간 내내 **쓰기가 차단**된다(읽기만 허용) →
> 주문·결제 API가 통째로 실패한다. INPLACE-rebuild라면 쓰기는 허용되지만,
> 그 사이의 변경분을 **온라인 로그**(임시 파일, `innodb_online_alter_log_max_size`,
> 기본 128MB)에 쌓았다가 끝에 반영하는데, 쓰기가 많아 로그가 넘치면
> **수 시간 작업이 마지막에 실패**한다.
> ⑷ 마지막에 원본 ↔ 새 테이블을 교체하며 **다시 배타 MDL**을 잡는다 →
> 사슬 A가 여기서 한 번 더 발생할 수 있다.

### 1-3. 사슬 C — 복제 지연 (프라이머리에서 "온라인"이어도)

세 번째 사슬은 프라이머리에서 아무 문제 없이 끝난 ALTER가 **읽기
복제본**을 무너뜨리는 경로다. 이걸 아는지가 "네이티브 online DDL만으로
충분한가"에 답하는 열쇠다.

> ⑴ 프라이머리에서 INPLACE로 3시간 걸린 인덱스 추가가 끝나면, 그 ALTER
> **문장 자체**가 바이너리 로그에 기록된다.
> ⑵ 복제본은 그 문장을 받아 **같은 ALTER를 처음부터 다시 실행**한다 —
> 또 3시간. DDL은 병렬 적용의 장벽이라 뒤의 트랜잭션들은 **그 3시간 동안
> 전부 큐에 쌓인다.**
> ⑶ 복제 지연이 최대 3시간까지 벌어진다 → 읽기 복제본으로 보내는
> 조회가 **3시간 전 데이터**를 돌려준다 → "주문했는데 목록에 없어요",
> 복제본을 보는 배치가 오래된 데이터로 계산.

pt-osc·gh-ost가 존재하는 가장 큰 이유가 이 사슬이다. 두 도구는 큰 ALTER를
**작은 청크의 일반 DML**로 바꿔 복제본이 실시간으로 따라오게 하고, 복제
지연이 임계치를 넘으면 스스로 속도를 늦춘다.

### 1-4. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "ALTER 하면 락 걸려서 느려진다" | **MDL 큐** | 긴 트랜잭션이 공유 MDL 점유 → ALTER가 배타 MDL 대기(타임아웃 1년) → 뒤따르는 모든 쿼리가 큐에 → 커넥션 풀 고갈 → 무관한 API까지 전면 장애 |
| "테이블이 커서 오래 걸린다" | **재구성(rebuild) 비용** | 전 행 재작성 → 디스크 2배 + CPU/I/O 점유 → (COPY) 쓰기 차단 / (INPLACE) 온라인 로그 초과 시 말미 실패 → 교체 시 MDL 재획득 |
| "복제본이 밀린다" | **DDL 재실행 장벽** | ALTER 문장이 binlog로 전파 → 복제본이 같은 시간만큼 재실행 → 그동안 뒤 트랜잭션 전부 대기 → 지연 = ALTER 소요 시간 |

---

## 2. MySQL 8 ALTER 알고리즘 3종 — 암기 목록과 "왜 그렇게 갈리는가"

목록을 인출하려면 먼저 **갈리는 원리** 하나를 잡아야 한다. 판별 기준은
**"이 작업이 클러스터드 인덱스 안의 행(row) 레이아웃을 건드리는가"** 다.

- 행을 전혀 안 건드리고 **데이터 딕셔너리(메타데이터)만 고치면 되는가** →
  **INSTANT**. 예: 컬럼 추가 — 기존 행은 물리적으로 그대로 두고, 딕셔너리에
  "이 컬럼은 기본값 X"라고 적어 두면 읽을 때 채워 넣을 수 있다.
- 행은 그대로 두되 **별도의 구조를 새로 만들면 되는가** → **INPLACE
  (재구성 없음)**. 예: 세컨더리 인덱스 추가 — 테이블을 한 번 스캔해 새
  B+Tree를 따로 짓는다. 클러스터드 인덱스의 행은 한 글자도 안 바뀐다.
- **모든 행을 다시 써야 하는가** → 재구성. 엔진이 내부에서 DML을 허용하며
  할 수 있으면 **INPLACE(재구성)**, 서버 계층이 임시 테이블로 복사해야
  하면 **COPY**. 예: 컬럼 타입 변경(INT → BIGINT)은 모든 행의 바이트
  배치가 바뀌므로 COPY다.

이 원리 위에 목록을 얹는다.

| 알고리즘 | 무엇을 하나 | 대표 작업 (암기) | 동시 DML | 디스크 |
|---|---|---|---|---|
| **INSTANT** | 데이터 딕셔너리만 수정, 행은 안 건드림 | **컬럼 추가**(8.0.12+, NULL 허용 또는 DEFAULT 명시), 컬럼 삭제(8.0.29+), 컬럼 DEFAULT 설정/제거, 테이블 이름 변경, ENUM/SET 값 끝에 추가, 가상 컬럼 추가/삭제 | 허용 (수 ms) | 없음 |
| **INPLACE — 재구성 없음** | 행은 그대로, 별도 구조만 생성/변경 | **세컨더리 인덱스 추가/삭제**, 인덱스 이름 변경, 컬럼 이름 변경, AUTO_INCREMENT 값 변경, VARCHAR 길이 **확장**(길이 바이트 수가 유지되는 범위), FK 삭제 | 허용 | 인덱스 크기만큼 |
| **INPLACE — 재구성** | 엔진 내부에서 전 행 재작성, 그동안의 DML은 온라인 로그에 모아 끝에 반영 | NULL ↔ NOT NULL 변경, 컬럼 순서 변경, PK 추가, ROW_FORMAT 변경, `OPTIMIZE TABLE`, (INSTANT 조건이 안 맞는) 컬럼 추가/삭제 | 허용 (온라인 로그 한도 내) | 테이블 크기만큼 (2배) |
| **COPY** | 서버가 임시 테이블 생성 → 전 행 복사 → 교체 | **컬럼 타입 변경**(INT→BIGINT, VARCHAR→TEXT), VARCHAR 길이 **축소**, 문자셋 변환, PK 삭제, FK 추가(`foreign_key_checks=1`일 때) | **차단** (읽기만) | 테이블 크기만큼 (2배) |

암기용 압축: **"추가는 INSTANT, 인덱스는 INPLACE, 타입은 COPY."**
질문의 두 작업 — 컬럼 추가 = INSTANT, 인덱스 추가 = INPLACE(재구성 없음)
— 는 둘 다 네이티브로 DML을 막지 않는다. 그런데도 이 문항이 중급인 이유는
1장의 사슬 A(MDL)와 사슬 C(복제 지연)가 알고리즘과 무관하게 남기 때문이다.

### 2-1. 알고리즘을 "요청"하지 말고 "단언"하라

MySQL은 `ALGORITHM`을 명시하지 않으면 **가능한 가장 가벼운 것을 골라
주지만, 안 되면 조용히 무거운 쪽으로 내려간다.** 컬럼 추가가 어떤 이유로
INSTANT가 불가능하면 INPLACE-재구성으로, 그것도 안 되면 COPY로 — 운영자는
실행이 끝날 때까지 모른다.

```sql
-- ❌ before: 알고리즘을 MySQL 재량에 맡김
ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(32) NULL;
-- INSTANT가 될 거라 "믿고" 실행. 조건이 안 맞으면(아래 참고) 재구성으로
-- 조용히 강등 → 수 시간 디스크 2배 + 복제 지연. 끝날 때까지 아무도 모름.

-- ✅ after: 알고리즘과 락 수준을 단언 — 안 되면 즉시 에러로 멈춘다
ALTER TABLE orders
    ADD COLUMN coupon_code VARCHAR(32) NULL,
    ALGORITHM = INSTANT, LOCK = NONE;
-- 지원 안 되면: ERROR 1846 ALGORITHM=INSTANT is not supported. Reason: ...
-- → 사람이 "그럼 gh-ost로 가자"를 결정할 기회가 생긴다.

ALTER TABLE orders
    ADD INDEX idx_orders_user_created (user_id, created_at),
    ALGORITHM = INPLACE, LOCK = NONE;
```

`LOCK` 절은 `NONE`(DML 허용) / `SHARED`(읽기만) / `EXCLUSIVE` 이고,
`LOCK=NONE`을 단언하면 "쓰기를 막아야만 가능한 작업"일 때 역시 에러로
멈춘다. **"실패하면 에러로 멈추게 한다"는 것 자체가 안전망**이다 —
4장에서 이걸 리뷰 규칙과 린트로 고정한다.

INSTANT 컬럼 추가가 **거부되는 대표 조건**(면접에서 한두 개만 말해도
충분): `ROW_FORMAT=COMPRESSED` 테이블, FULLTEXT 인덱스가 있는 테이블,
그리고 **한 ALTER 문에 INSTANT 불가 작업을 섞은 경우** — ALTER 한 문장은
**가장 무거운 작업의 알고리즘으로 통일**된다. `ADD COLUMN`과
`MODIFY ... BIGINT`를 한 줄에 쓰면 컬럼 추가까지 COPY가 된다. 그래서
**작업은 알고리즘별로 문장을 쪼개는 것**이 규칙이다.

**(가산점 포인트)** INSTANT 컬럼 추가는 행에 "버전"을 매겨 기존 행을 안
건드리는 방식이라 **테이블당 누적 횟수 상한**(8.0.29 기준 64회)이 있고,
넘기면 재구성이 필요하다. "INSTANT는 공짜"가 아니라 "재구성을 미루는
빚"이라는 인식이 있으면 한 단계 위로 평가된다.

---

## 3. 도구 3종의 트레이드오프 — 네이티브 online DDL / pt-osc / gh-ost

이 장이 약점 ②를 겨냥한다. 세 선택지 각각을 **"무엇을 얻고, 무엇을
지불하는가"를 한 호흡에** 말하는 연습이다. 편익만 말하고 멈추면 "도구
이름을 아는 사람", 대가까지 말하면 "써 본 사람"으로 갈린다.

### 3-1. 네이티브 online DDL (`ALGORITHM=INSTANT/INPLACE, LOCK=NONE`)

**얻는 것**: 도구·권한·추가 인프라가 필요 없다. INSTANT면 사실상 무료다.
INPLACE 인덱스 추가도 DML을 막지 않는다. 가장 단순해서 실수 여지가 적다.

**지불하는 것**:
- **하나의 문장**으로 실행되므로 **중간에 멈추거나 속도를 조절할 수
  없다.** 부하가 치솟아도 끝나거나 죽이거나 둘 중 하나다.
- **복제 지연 = ALTER 소요 시간**(사슬 C). 복제본을 읽기에 쓰는 구조라면
  "프라이머리는 온라인이었는데 서비스는 장애"가 된다.
- 재구성 작업이면 디스크 2배 + 온라인 로그 초과로 **말미에 실패**할 수
  있고, 그때까지 쓴 시간·I/O는 날아간다.
- MDL(사슬 A)은 그대로 남는다 — 이건 아래 둘도 마찬가지.

**적합**: INSTANT가 되는 모든 것. 복제본이 없거나 복제 지연을 감내할 수
있는 환경에서의 INPLACE 인덱스 추가. 테이블이 "대용량"의 문턱 아래일 때.

### 3-2. pt-online-schema-change (Percona Toolkit) — 트리거 방식

**동작**: ① 빈 복제 테이블 `_orders_new`를 만들고 거기에 ALTER를 적용한다
(빈 테이블이라 즉시). ② 원본에 **AFTER INSERT/UPDATE/DELETE 트리거
3개**를 걸어, 복사 중에 들어오는 변경을 새 테이블에도 그대로 적용한다.
③ 원본 행을 **PK 범위 청크**(`--chunk-size`, `--chunk-time`)로 잘라
`INSERT ... SELECT`로 옮기되, 복제 지연(`--max-lag`)이나 부하
(`--max-load Threads_running=N`)가 임계치를 넘으면 쉰다. ④ 다 옮기면
`RENAME TABLE orders TO _orders_old, _orders_new TO orders` 로 **원자적
교체**, 옛 테이블은 삭제(`--no-drop-old-table`로 보존 가능).

```bash
pt-online-schema-change \
  --alter "ADD INDEX idx_orders_user_created (user_id, created_at)" \
  D=shop,t=orders \
  --chunk-size=1000 --max-lag=1 --check-interval=1 \
  --max-load "Threads_running=25" --critical-load "Threads_running=50" \
  --alter-foreign-keys-method=rebuild_constraints \
  --execute          # 없으면 dry-run
```

**얻는 것**: 큰 ALTER가 **작은 DML의 연속**이 되어 복제본이 실시간으로
따라온다(사슬 C 해소). 부하·지연에 따라 **스스로 감속**한다. 도중에
죽여도 원본은 무손상이다. 오래된 MySQL에서도 돌고, 검증된 역사가 길다.

**지불하는 것**:
- **트리거 부하**: 복사가 진행되는 몇 시간 동안 원본의 **모든 쓰기가
  트리거를 통해 새 테이블에도 동기적으로 한 번 더 써진다.** 트리거는 그
  쓰기와 **같은 트랜잭션 안에서** 실행되므로 쓰기 지연이 늘고, 트랜잭션이
  잡는 락 범위가 새 테이블까지 넓어져 **데드락 가능성**이 생긴다. 쓰기
  폭주 테이블에서는 이 부하 자체가 장애가 될 수 있다.
- **FK 제약**: 다른 테이블이 `orders`를 참조하고 있으면, 교체 후 그 FK가
  `_orders_old`를 가리키게 된다. `rebuild_constraints`는 자식 테이블들에
  ALTER를 쳐서 FK를 다시 거는데 **자식이 크면 그것이 또 하나의 대공사**고,
  `drop_swap`은 원본을 먼저 DROP하고 새 것을 RENAME 하므로 **테이블이
  잠깐 존재하지 않는 창**이 생긴다.
- 기존에 트리거가 있는 테이블은 제약이 있고(버전에 따라 `--preserve-triggers`),
  청크를 자르려면 **PK 또는 유니크 키가 필수**다.
- 디스크 2배. 실행 중 "일시정지"는 없고 감속만 있다.

### 3-3. gh-ost (GitHub Online Schema Transmogrifier) — 트리거 없는 방식

**동작**: 트리거 대신 **자신이 복제본인 척** MySQL에 붙어 **ROW 포맷
바이너리 로그**를 읽고, 원본 테이블에 대한 변경 이벤트를 고스트 테이블
`_orders_gho`에 **비동기로** 적용한다. 행 복사는 pt-osc처럼 청크로 진행.
끝나면 짧은 락 안에서 원자적 교체(cut-over). 상태·속도·중단은 실행 중에
**소켓/플래그 파일로 대화형 제어**한다.

```bash
gh-ost \
  --host=replica-host --assume-master-host=primary-host \
  --database=shop --table=orders \
  --alter="MODIFY amount BIGINT NOT NULL" \
  --chunk-size=1000 \
  --max-lag-millis=1500 \
  --max-load="Threads_running=25" --critical-load="Threads_running=100" \
  --throttle-flag-file=/tmp/gh-ost.throttle \
  --postpone-cut-over-flag-file=/tmp/gh-ost.postpone \
  --execute
# 복제본(replica-host)에서 binlog를 읽어 프라이머리 부하 최소화.
# throttle 파일을 touch 하면 즉시 일시정지, 지우면 재개.
# postpone 파일이 있는 동안은 복사가 끝나도 교체를 미룬다 → 사람이 확인 후 교체.
```

**얻는 것**: **원본 쓰기 경로에 아무것도 끼어들지 않는다** — 트리거가
없으니 쓰기 지연 증가도, 락 범위 확대도 없다(pt-osc의 최대 대가 해소).
binlog를 **복제본에서 읽어** 프라이머리 부하를 더 줄일 수 있다. **일시정지
/재개/속도 조절/교체 연기**를 실행 중에 할 수 있어 "지금 트래픽 튀니까
잠깐 멈춰"가 가능하다. `--test-on-replica`로 **복제본에서 리허설**하고
소요 시간·결과를 검증할 수 있다.

**지불하는 것**:
- **FK 미지원** — 부모든 자식이든 FK가 걸린 테이블은 아예 다루지 않는다.
  FK를 DB 제약으로 쓰는 스키마에서는 선택지에서 빠진다(하드 리밋).
- **`binlog_format=ROW`가 필수**이고, 기존 트리거가 있는 테이블은
  지원하지 않는다.
- binlog 이벤트 적용이 **순차**라 쓰기가 아주 많은 테이블에서는 복사가
  변경을 따라잡는 시간이 길어져 **총 소요 시간이 pt-osc보다 길 수 있다.**
- 디스크 2배. 교체 순간의 짧은 락 창은 남는다.

### 3-4. 한눈에 — 그리고 셋의 공통 한계

| | 네이티브 online DDL | pt-osc | gh-ost |
|---|---|---|---|
| 원본 쓰기 부하 | 없음(INSTANT/INPLACE) | **트리거로 동기 증가** | 없음(비동기 binlog) |
| 복제 지연 | **= ALTER 시간** | 감시·감속 | 감시·감속 |
| 실행 중 제어 | 불가(죽이기만) | 감속만 | 일시정지/재개/교체 연기 |
| FK | 그대로 | 자식 재구성 or drop_swap | **불가** |
| 전제 조건 | 없음 | PK/UK | ROW binlog, 트리거 없음 |
| 디스크 | 재구성 시 2배 | 2배 | 2배 |

선택 순서는 **"가벼운 것부터 배제"** 다: ① INSTANT가 되면 네이티브 →
② INPLACE인데 복제 지연을 감당할 수 있으면 네이티브 → ③ 재구성이거나
복제 지연을 못 견디면 도구 → ④ FK가 있으면 pt-osc, 없으면 쓰기 부하가
민감할수록 gh-ost.

**셋의 공통 한계 — MDL은 남는다.** pt-osc의 트리거 생성·RENAME, gh-ost의
cut-over, 네이티브의 시작·종료는 모두 **배타 MDL**을 잡는다. 그래서 두
도구는 그 순간의 락 대기 상한을 **짧게 두고 실패하면 재시도**하도록
내장돼 있다(pt-osc `--set-vars lock_wait_timeout=…` + `--tries`,
gh-ost `--cut-over-lock-timeout-seconds` + 재시도). **직접 ALTER를 칠 때도
이 동작을 흉내 내야 한다** — 그게 다음 장의 첫 번째 규칙이다.

---

## 4. 절차를 팀 규칙으로 고정하기 — 안전망

이 장이 약점 ③을 겨냥한다. 1~3장의 지식은 **"그날 그 사람이 기억하고
있었는가"에 의존하면 무용지물**이다. 출제 의도의 후반부("스키마 변경
절차를 갖춘 팀에서 일해봤는지")는 정확히 이걸 묻는다. 규칙은 **사람의
주의력이 아니라 실행 경로에** 심어야 한다.

### 4-1. 규칙 1 — `lock_wait_timeout`을 짧게 두고, 실패하면 재시도

사슬 A의 ⑵("1년 대기")를 끊는 가장 값싼 안전망이다. ALTER가 MDL을 몇 초
안에 못 얻으면 **스스로 실패**하게 만든다. 실패는 아무에게도 피해를 주지
않는다 — 대기가 피해를 준다.

```sql
-- ❌ before: 기본값(1년) 그대로 실행 → 긴 트랜잭션 하나에 서비스 전체가 인질
ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(32) NULL, ALGORITHM=INSTANT, LOCK=NONE;

-- ✅ after: 이 세션에서만 MDL 대기 상한을 5초로 → 못 얻으면 에러, 큐도 즉시 해소
SET SESSION lock_wait_timeout = 5;
ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(32) NULL, ALGORITHM=INSTANT, LOCK=NONE;
-- ERROR 1205 Lock wait timeout exceeded 가 나면 → 원흉 트랜잭션을 찾거나 잠시 후 재시도
```

```bash
# 재시도 루프 — 운영 런북 스크립트에 고정 (사람이 F5를 누르지 않게)
for i in $(seq 1 30); do
  mysql shop -e "SET SESSION lock_wait_timeout=3;
                 ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(32) NULL,
                 ALGORITHM=INSTANT, LOCK=NONE;" && break
  sleep 5
done
```

실행 **전에** 긴 트랜잭션을 확인하고, 실행 **중** 막히면 누가 막는지 보는
쿼리도 런북에 같이 둔다.

```sql
-- 실행 전: 60초 넘게 열려 있는 트랜잭션 (사슬 A의 ⑴ 후보)
SELECT trx_id, trx_started, trx_mysql_thread_id, trx_query
  FROM information_schema.INNODB_TRX
 WHERE trx_started < NOW() - INTERVAL 60 SECOND;

-- 실행 중 막혔을 때: 누가 어떤 MDL을 쥐고 있고 누가 기다리는지
SELECT * FROM sys.schema_table_lock_waits;
SELECT object_name, lock_type, lock_status, owner_thread_id
  FROM performance_schema.metadata_locks
 WHERE object_schema = 'shop' AND object_name = 'orders';
```

### 4-2. 규칙 2 — `ALGORITHM`/`LOCK` 명시를 강제 (리뷰 + 린트)

2-1절의 "단언"을 개인 습관이 아니라 **CI가 검사**하게 한다. 마이그레이션
SQL에 `ALTER TABLE`이 있는데 `ALGORITHM=`이 없으면 빌드 실패. 정규식
한 줄짜리 스크립트로 충분하고, 스키마 린터를 쓸 수 있으면 더 좋다.

```bash
# ci/lint-migrations.sh — ALTER에 ALGORITHM 절이 없으면 실패
if grep -rliE '^\s*ALTER\s+TABLE' src/main/resources/db/migration \
   | xargs grep -LiE 'ALGORITHM\s*=' | grep -q .; then
  echo "ALTER TABLE without ALGORITHM= found. Declare INSTANT/INPLACE explicitly." >&2
  exit 1
fi
```

**(가산점 포인트)** `skeema` 같은 선언형 스키마 도구는 린트 규칙에 더해,
**일정 크기 이상 테이블의 ALTER를 자동으로 pt-osc/gh-ost로 감싸는
옵션**(`alter-wrapper`, `alter-wrapper-min-size`)이 있다. "큰 테이블이면
도구를 쓰자"는 규칙을 도구가 대신 기억하게 만드는 사례다.

### 4-3. 규칙 3 — 마이그레이션 도구(Flyway/Liquibase)와의 결합

Spring 팀은 대개 Flyway/Liquibase로 스키마를 버전 관리하고, 기본 설정은
**앱 기동 시 마이그레이션 실행**이다. 여기에 대형 테이블 DDL이 섞이면
전용 함정이 생긴다.

> 앱 기동 → Flyway가 3시간짜리 ALTER 시작 → 기동이 끝나지 않아 readiness
> 실패 → 롤링 배포가 멈추거나 오케스트레이터가 타임아웃으로 컨테이너를
> 죽임 → **MySQL DDL은 트랜잭션 롤백이 안 되므로**(8.0의 원자적 DDL은
> "문장 하나가 반쯤 적용되지 않는다"는 뜻이지 "스크립트를 되돌린다"는 뜻이
> 아니다) 어디까지 적용됐는지 불명 + Flyway 히스토리는 실패로 표시 → 다음
> 기동도 실패 → `flyway repair`와 수동 복구.

규칙은 세 겹이다.

**⑴ 마이그레이션을 앱 기동에서 떼어 파이프라인 단계로.** 앱은
`spring.flyway.enabled=false`, CI/CD가 배포 직전에 `flyway migrate`를
별도 잡으로 실행한다. 앱은 `spring.jpa.hibernate.ddl-auto=validate`로
**"스키마가 기대와 다르면 기동 실패"** 만 담당한다(관련: [unique-constraint-concurrent-insert.md](../03-jpa-orm/unique-constraint-concurrent-insert.md)의
"선언은 있는데 실물이 없다"를 잡는 같은 안전망). 그래도 Flyway로 실행하는
SQL에는 4-1의 타임아웃을 심는다 —
`spring.flyway.init-sql=SET SESSION lock_wait_timeout=5` 또는 SQL 파일 첫
줄에 `SET SESSION lock_wait_timeout = 5;`.

**⑵ 대형 테이블 목록을 저장소에 두고, 그 테이블의 재구성 DDL은 Flyway
SQL로 금지.** 대신 gh-ost/pt-osc 런북으로 **배포와 분리해** 먼저
실행한다. 그리고 Flyway 쪽에는 SQL 대신 **"이미 적용됐는지 검증만 하는
게이트 마이그레이션"** 을 둔다 — 사람이 gh-ost를 잊었으면 배포가 실패하게.

```java
// ❌ before: V43__orders_amount_bigint.sql
//    ALTER TABLE orders MODIFY amount BIGINT NOT NULL;
//    → COPY 알고리즘, 앱 기동 중 수 시간 쓰기 차단, 실패 시 반쯤 적용

// ✅ after: V43__gate_orders_amount_bigint.java — 실물을 확인만 한다
public class V43__gate_orders_amount_bigint extends BaseJavaMigration {
    @Override
    public void migrate(Context ctx) throws Exception {
        try (var st = ctx.getConnection().createStatement();
             var rs = st.executeQuery("""
                 SELECT DATA_TYPE FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'amount'""")) {
            rs.next();
            if (!"bigint".equalsIgnoreCase(rs.getString(1))) {
                // gh-ost 런북(docs/runbook/orders-amount-bigint.md)을 먼저 실행해야 한다
                throw new IllegalStateException(
                    "orders.amount is not BIGINT yet — run gh-ost migration before deploying V43");
            }
        }
    }
}
```

Liquibase라면 같은 의도를 선언으로 쓴다 — 전제조건이 이미 충족돼 있으면
"실행된 것으로 표시"하고, 아니면 실패.

```xml
<changeSet id="43-orders-amount-bigint-gate" author="team">
  <preConditions onFail="HALT">
    <sqlCheck expectedResult="bigint">
      SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='amount'
    </sqlCheck>
  </preConditions>
  <comment>out-of-band gh-ost 적용 여부 검증 — 미적용 시 배포 중단</comment>
</changeSet>
```

**⑶ 작은 DDL은 Flyway SQL로 두되 알고리즘 단언 + 문장 분리.** INSTANT
컬럼 추가처럼 안전한 것까지 런북으로 보내면 절차가 무거워져 지켜지지
않는다. 규칙은 "지킬 수 있을 만큼만 무겁게".

### 4-4. 규칙 4 — Expand / Contract: 앱 배포 무중단과 맞물리는 지점

스키마를 무중단으로 바꿔도, **롤링 배포 중에는 구버전과 신버전 앱이 같은
DB를 동시에 본다.** 컬럼을 지우거나 이름을 바꾸는 순간 구버전 앱이 죽고,
`ddl-auto=validate`를 켜 뒀다면 구버전 인스턴스가 재기동조차 못 한다.
그래서 파괴적 변경은 **한 릴리스에서 금지**하고 두 단계로 나눈다.

> **Expand(확장)**: 새 컬럼/테이블을 **추가만** 한다(INSTANT). 신버전 앱은
> 양쪽에 쓰고 새 쪽을 읽는다. 구버전 앱은 새 컬럼의 존재를 몰라도 동작한다.
> → 백필(batch backfill)은 **청크 UPDATE**로 저트래픽 시간대에.
> → **Contract(축소)**: 구버전 앱이 **한 대도 남지 않은 것을 확인한 뒤**
> 다음 릴리스에서 옛 컬럼을 지운다(INSTANT DROP 또는 도구).

순서를 한 줄로: **호환되는 스키마 먼저 → 앱 배포(프로세스 교체의
무중단은 [graceful-shutdown-zero-downtime-deploy.md](../02-spring/graceful-shutdown-zero-downtime-deploy.md)) → 정리 DDL은 다음 릴리스.**
컬럼 이름 변경도 "새 컬럼 추가 → 양쪽 쓰기 → 읽기 전환 → 옛 컬럼 삭제"
네 단계로 푼다. `SELECT *`와 위치 기반 매핑을 금지하는 코딩 규칙도 이
축의 일부다(컬럼 추가만으로 깨지지 않게).

### 4-5. 규칙 5 — PR 템플릿 체크리스트 (사람이 판단해야 하는 것만 남긴다)

위 규칙들이 기계가 잡는 부분이고, 나머지는 리뷰어가 **같은 질문을 매번
같은 순서로** 던지게 템플릿에 박는다.

```markdown
## 스키마 변경 체크리스트 (DDL이 포함된 PR은 필수)
- [ ] 대상 테이블 현재 행 수 / 크기:            (대형 테이블 목록 해당 여부: 예/아니오)
- [ ] 알고리즘 판별: INSTANT / INPLACE(재구성 없음|재구성) / COPY — 근거:
- [ ] 문장을 알고리즘별로 분리했는가 (INSTANT 작업과 재구성 작업을 한 ALTER에 섞지 않음)
- [ ] 재구성이면: gh-ost / pt-osc 중 선택과 이유 (FK 유무, 쓰기 부하, 복제 구성)
- [ ] 스테이징(운영 크기 스냅샷)에서 리허설 — 소요 시간:    임시 디스크:    (여유 ≥ 테이블 × 2)
- [ ] 실행 창: 저트래픽 시간대       / 실행 전 INNODB_TRX 확인 / lock_wait_timeout 설정 확인
- [ ] 복제 지연 감시 임계치와 중단 기준 (--max-lag / --max-load / --critical-load)
- [ ] Expand/Contract: 이 변경이 구버전 앱과 호환되는가 — 파괴적 변경이면 어느 릴리스에서 Contract 하는가
- [ ] 롤백 방법 (INSTANT 컬럼 → DROP / 도구 → 옛 테이블 보존 기간)
- [ ] 실행자·감시자·연락 채널
```

체크리스트의 역할은 "생각나게 하기"다. 4-1~4-3처럼 코드·설정으로 고정할
수 있는 것은 체크리스트에 두지 않고 코드로 옮기는 것이 원칙 — 체크박스는
사람이 여전히 무시할 수 있기 때문이다.

---

## 5. 실무 사례 — "INSTANT니까 괜찮다"며 점심시간에 친 ALTER

상황: `orders`(수억 건)에 `coupon_code` 컬럼을 추가하는 PR이 승인됐다.
리뷰어는 "MySQL 8이고 INSTANT라 1ms면 끝난다"고 했고, 담당자는 점심시간에
운영 DB에 `ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(32) NULL;`을
실행했다. 12분 뒤 전 API가 타임아웃으로 죽었다.

사슬 A가 그대로 재현됐다: 정산팀 대시보드가 **매 시 정각에 리포팅
트랜잭션**을 열어 `orders`를 15분간 읽고 있었다(⑴). ALTER는 배타 MDL을
못 얻고 대기(⑵), `lock_wait_timeout`은 기본값 1년(⑵). 그 뒤로 `orders`를
읽는 모든 API 요청이 큐에 섰고(⑶), HikariCP 풀 10개가 30초 안에 바닥나
로그인·상품 조회까지 `connection-timeout`으로 실패(⑷), 헬스체크 실패로
인스턴스가 재시작을 반복(⑸). 담당자는 `SHOW PROCESSLIST`에서
`Waiting for table metadata lock`을 보고 ALTER 세션을 `KILL` 했고, 큐는
즉시 풀렸다. ALTER 자체는 나중에 리포팅 트랜잭션이 끝난 직후 재실행해
**정확히 수 ms**에 끝났다.

이 사고에서 배운 규칙이 4장이다: INSTANT 판별은 맞았지만 **MDL은
알고리즘과 무관**하다는 것(1-1), `lock_wait_timeout=5`가 있었으면 5초짜리
에러로 끝났을 것(4-1), 실행 전 `INNODB_TRX` 확인이 런북에 있었으면
대시보드 트랜잭션을 미리 봤을 것(4-1), 그리고 이 셋을 담당자의 기억이
아니라 **런북 스크립트와 Flyway `init-sql`에 고정**해야 다음 사람이 같은
사고를 안 낸다는 것(4-3). "리뷰어가 INSTANT를 확인했다"는 사실은 사슬 A
앞에서 아무 보호가 되지 않았다.

---

## 6. 꼬리질문 대비 포인트

### "MySQL 8이면 컬럼 추가는 INSTANT라 그냥 쳐도 되는 것 아닌가요?"

두 가지로 나눠 답한다. **첫째, INSTANT여도 배타 MDL은 잡는다.** 긴
트랜잭션이 공유 MDL을 쥐고 있으면 1ms짜리 ALTER가 그 뒤에서 대기하고,
그 뒤로 들어오는 모든 쿼리가 큐에 서며, 커넥션 풀이 고갈돼 무관한
API까지 죽는다 — 알고리즘이 아니라 락 큐의 문제다. 그래서 INSTANT여도
`lock_wait_timeout`을 짧게 두고 재시도하는 절차를 밟는다. **둘째, INSTANT가
된다는 보장을 확인해야 한다.** `ALGORITHM=INSTANT, LOCK=NONE`을 단언해서
조건이 안 맞으면(COMPRESSED, FULLTEXT, 다른 재구성 작업과 혼합, 누적 횟수
초과) 조용히 재구성으로 강등되지 않고 에러로 멈추게 한다. "그냥 쳐도
된다"는 이 두 확인을 생략한 말이다.

### "인덱스 추가는 INPLACE라 DML도 허용되는데, 그런데도 도구를 쓰는 이유가 뭔가요?"

프라이머리에서는 온라인이어도 **복제본에서는 아니기 때문**이다. ALTER
문장이 binlog로 전파되면 복제본은 같은 ALTER를 처음부터 재실행하고, DDL은
병렬 적용의 장벽이라 그 시간 동안 뒤의 트랜잭션이 전부 대기한다 → 복제
지연이 ALTER 소요 시간만큼 벌어진다. 읽기를 복제본으로 보내는 구조라면
그건 곧 "방금 쓴 데이터가 안 보이는" 장애다. 여기에 ⑵ 실행 중 속도
조절·중단이 불가능하다는 것, ⑶ 온라인 로그 초과로 말미에 실패할 수
있다는 것이 붙는다. pt-osc/gh-ost는 큰 ALTER를 청크 DML로 바꿔 복제본이
따라오게 하고 지연이 임계치를 넘으면 감속한다. 반대로 **복제본이 없거나
지연을 감내할 수 있는 환경이면 네이티브 INPLACE가 가장 단순하고 옳다** —
도구는 공짜가 아니다(3-2, 3-3의 대가).

### "pt-osc와 gh-ost 중 무엇을 고르나요? 각각 무엇을 포기하나요?" (시니어 변별 포인트)

첫 분기는 **FK**다 — 대상 테이블이 FK의 부모든 자식이든 gh-ost는 불가하므로
pt-osc밖에 없고, 그때는 `rebuild_constraints`(자식 재구성 비용)와
`drop_swap`(테이블 부재 창) 중 하나를 감수한다. FK가 없다면 두 번째
분기는 **쓰기 부하 민감도**다 — pt-osc는 트리거가 원본의 모든 쓰기에
동기적으로 끼어들어 쓰기 지연과 락 범위를 늘리므로, 쓰기가 몰리는
테이블일수록 gh-ost가 낫다. gh-ost가 지불하는 것은 ROW binlog 전제, 기존
트리거 불가, binlog 순차 적용 탓에 쓰기 폭주 시 총 시간이 더 길 수 있다는
점이다. 대신 실행 중 일시정지·교체 연기·복제본 리허설이라는 **운영
통제력**을 얻는다. 어느 쪽이든 **디스크 2배와 cut-over 순간의 MDL**은
공통이므로 그 둘은 도구로 해결되지 않는다고 덧붙이면 완결된다. 결정을
"우리 팀은 항상 X"가 아니라 이 두 분기로 말하는 것이 핵심이다.

### "Flyway를 쓰는데, 대형 테이블 DDL은 실제로 어떻게 흘러가나요?"

세 겹으로 답한다. ⑴ 마이그레이션 실행을 **앱 기동에서 떼어** 파이프라인
단계로 옮긴다 — 기동 중 긴 DDL은 readiness 실패·롤링 배포 정지·타임아웃
재시작을 부르고, MySQL DDL은 스크립트 단위 롤백이 안 되어 반쯤 적용된
상태를 남기기 때문이다. 앱은 `ddl-auto=validate`로 검증만 한다. ⑵ 대형
테이블의 재구성 DDL은 Flyway SQL로 쓰지 않고 gh-ost/pt-osc 런북으로
**배포 전에 별도 실행**하며, Flyway에는 `information_schema`로 **적용
여부를 확인만 하는 게이트 마이그레이션**(Java 마이그레이션 또는 Liquibase
`preConditions`)을 둬서 잊으면 배포가 실패하게 한다. ⑶ 나머지 작은 DDL은
Flyway SQL로 두되 `ALGORITHM/LOCK` 단언, 알고리즘별 문장 분리,
`init-sql`로 `lock_wait_timeout`을 심는다. **"사람이 gh-ost를 잊으면
어떻게 되나요"에 "배포가 실패합니다"라고 답할 수 있어야** 절차가 있는
팀이다.

### "PostgreSQL이면 같은 문제인가요?" (가산점 포인트)

락 큐의 원리는 같다 — ALTER는 `ACCESS EXCLUSIVE` 락을 잡고, 긴 트랜잭션
뒤에서 대기하면 뒤따르는 쿼리가 모두 막히므로 **`lock_timeout`을 짧게
두고 재시도**하는 절차는 그대로 필요하다. 다른 점은 도구 지형이다.
PostgreSQL은 DDL이 **트랜잭션 안에서 롤백**되므로 마이그레이션 실패
복구가 쉽고, `ADD COLUMN ... DEFAULT`는 상수 기본값이면 카탈로그에만
기록해 즉시 끝나며(11+), 인덱스는 `CREATE INDEX CONCURRENTLY`로 쓰기를
막지 않고 만든다 — 단 이건 트랜잭션 안에서 못 쓰고 실패하면 `INVALID`
인덱스가 남아 지워야 한다. 제약 추가는 `NOT VALID`로 걸고 나중에
`VALIDATE CONSTRAINT`로 나눠 긴 락을 피한다. 즉 "MySQL의 pt-osc/gh-ost
자리"를 PostgreSQL에서는 **DB 내장 기능 + `lock_timeout` 재시도**가 상당
부분 대신한다. 엔진마다 답이 다르다는 걸 알고 "우리 DB는 무엇인가"부터
확인하는 것이 시니어의 순서다.

---

## 한 줄 요약

**대용량 테이블의 ALTER는 알고리즘과 무관한 메타데이터 락 큐(긴 트랜잭션 →
ALTER 대기 → 뒤따르는 모든 쿼리 대기 → 커넥션 풀 고갈 → 전면 장애)와,
재구성 알고리즘의 자원 비용(쓰기 차단·디스크 2배·복제 지연)이라는 두
사슬로 서비스를 세운다. 그래서 MySQL 8 알고리즘 3종을 판별해 컬럼 추가는
INSTANT, 인덱스 추가는 INPLACE로 단언하고, 재구성이 불가피하면 복제 지연
(네이티브) / 트리거 부하·FK 처리(pt-osc) / FK 미지원(gh-ost)이라는 대가를
비교해 고르며, `lock_wait_timeout` 단축·알고리즘 단언 린트·마이그레이션의
배포 분리와 게이트·Expand/Contract를 사람의 기억이 아니라 팀의 실행
경로에 고정한다.**
