# 조회수/좋아요 집계 파이프라인 — 정확성·실시간성·부하, 셋 다 가질 수는 없다

> 핵심 관전 포인트: **조회마다 `UPDATE view_count = view_count + 1`을 치면 인기 콘텐츠의 행(row) 하나가 처리 상한을 정해 버린다 — PostgreSQL은 MVCC 덕분에 읽기가 쓰기를 막지 않지만 같은 행을 갱신하는 트랜잭션끼리는 행 잠금으로 직렬화되므로, 잠금 보유 시간이 2ms면 그 행은 초당 500건이 상한이고 서버를 20대로 늘려도 그 숫자는 변하지 않는다. 그래서 해법의 골격은 write-behind다 — 쓰기를 캐시에 먼저 받아 두고(Redis `INCR`) 수 초~수십 초 주기로 합산해 DB에 배치 upsert 한 건으로 반영한다. 얻는 것은 DB 쓰기 횟수의 극적 감소와 핫 로우 제거이고, 잃는 것은 아직 반영되지 않은 구간이 Redis 장애 시 사라진다는 것이다. flush 주기는 기술 결정이 아니라 "조회수 몇 건까지 사라져도 되는가"라는 비즈니스 합의이고, 주기를 5초에서 60초로 늘리면 DB 쓰기는 12분의 1이 되지만 최대 유실 창은 12배가 된다. 그리고 좋아요는 조회수와 다른 파이프라인이다 — 조회수는 합계만 필요하지만 좋아요는 "누가 눌렀는지"가 필요해서(내 상태 표시, 연타 방어, 취소) 카운터만으로는 성립하지 않고 사용자별 상태가 원본, 카운트는 그 파생물이 된다. 마지막으로 이 숫자가 작가 정산에 쓰이는 순간 근사 파이프라인은 전부 무효가 되고, 카운터가 아니라 이벤트를 남겨 재계산 가능하게 만드는 원장 방식으로 갈아타야 한다.**

---

## 0. 질문 + 의도

**질문**: "조회수/좋아요 집계를 실시간에 가깝게 보여주되 DB 부하를 최소화하는 파이프라인을 설계해보세요."

**출제 의도**: 정확성·실시간성·부하의 3자 트레이드오프를 비즈니스 요구("조회수가 1 정도 틀려도 되는가")와 협상하며 설계하는지 본다. 기술 선택 이전에 **요구사항의 완화 가능 지점을 찾는 습관** — 요구를 전부 만족하려는 사람은 과잉 설계를 하고, 완화 지점을 찾는 사람은 값싸고 견고한 설계를 한다.

## 1. 왜 매 조회마다 UPDATE 하면 안 되는가 — 한 행이 처리 상한을 정한다

이 질문의 답을 설계하기 전에, **왜 그 소박한 한 줄짜리 `UPDATE`가 안 되는지**를 숫자로 말할 수 있어야 한다. "부하가 크니까"는 답이 아니다. 진짜 이유는 부하의 총량이 아니라 **부하가 한 행에 모인다**는 데 있고, 그 행에는 서버 대수와 무관한 처리 상한이 있다.

```java
// Before: 조회할 때마다 카운터 UPDATE — 인기 콘텐츠에서 붕괴한다
@Transactional
public WebtoonDetail view(Long webtoonId) {
    webtoonRepository.incrementViewCount(webtoonId);
    // UPDATE webtoon SET view_count = view_count + 1 WHERE id = ?
    return findDetail(webtoonId);   // 이 줄이 왜 문제인지는 1-3에서 본다
}
```

### 1-1. 전제 지식 — PostgreSQL에서 "읽기는 안 막히는데 쓰기끼리는 줄을 선다"

먼저 **MVCC(multi-version concurrency control, 다중 버전 동시성 제어)**가 무엇인지 짚고 가야 한다. 이름 그대로, 한 행의 **여러 버전을 동시에 보관해 두고** 트랜잭션마다 자기 시점에 맞는 버전을 보여 주는 방식이다.

PostgreSQL에서 `UPDATE`는 기존 행을 제자리에서 고치지 않는다. **새 버전의 행을 추가로 쓰고, 기존 버전에 "이 트랜잭션이 이 버전을 무효화했다"는 표시를 남긴다.** 그래서 갱신이 진행 중이어도 다른 트랜잭션은 여전히 예전 버전을 읽을 수 있다.

여기서 초심자가 가장 자주 오해하는 지점이 나온다. **"MVCC라서 락이 없다"가 아니다.** MVCC가 없애 주는 것은 **읽기와 쓰기 사이의 충돌**뿐이다.

```
[읽기 vs 쓰기]   조회 트랜잭션은 갱신 중인 행의 "이전 버전"을 읽고 지나간다
                 → 서로 기다리지 않는다. 이것이 MVCC의 이득이다.

[쓰기 vs 쓰기]   같은 행의 새 버전을 두 트랜잭션이 동시에 만들 수는 없다
                 → 먼저 손을 댄 트랜잭션이 끝날 때까지 뒤엣것은 기다린다.
                    MVCC는 여기서 아무것도 해 주지 않는다.
```

왜 쓰기끼리는 기다려야 하는가. `view_count = view_count + 1`은 **읽고 더해서 쓰는 연산**이다. 두 트랜잭션이 각각 "지금 값은 100"을 읽고 각각 101을 쓰면 결과는 101이 되어 한 건이 사라진다. 이것을 막으려면 **누가 먼저인지를 정해서 한 번에 하나씩 처리**해야 한다. 순서를 정하는 유일한 수단이 잠금이다.

동작을 시간축에 놓아 보면 이렇다.

```
T1  BEGIN
T1  UPDATE webtoon SET view_count = view_count + 1 WHERE id = 123
       -> 123번 행의 새 버전을 쓰고, 그 행에 "T1이 작업 중"이라는 표식을 남긴다
T2  UPDATE webtoon SET view_count = view_count + 1 WHERE id = 123
       -> 표식을 보고 "T1이 끝날 때까지 대기" 상태로 들어간다
          (pg_stat_activity: wait_event_type='Lock', wait_event='transactionid')
T3, T4, ... 같은 행에 오는 모든 UPDATE가 같은 줄에 선다
T1  COMMIT
       -> T2가 깨어나 방금 커밋된 최신 버전(101)을 다시 읽어 102를 쓴다
          (READ COMMITTED에서는 이 재평가가 자동으로 일어나므로 값 자체는 정확하다)
```

**값은 정확하다. 문제는 처리량이다.** 이 줄에서 한 번에 한 건씩만 통과한다.

(격리 수준을 REPEATABLE READ 이상으로 올리면 대기 대신 `could not serialize access due to concurrent update` 에러로 즉시 실패한다. 기다림이 에러로 바뀔 뿐, 한 번에 하나씩만 통과한다는 사실은 같다.)

### 1-2. 락 보유 시간이 그 행의 처리 상한을 정한다 — 계산으로 보기

이제 상한을 계산할 수 있다. 17번 문서의 Little's Law를 그대로 쓴다.

`L = λW`에서 각 기호는 이렇다.

- **L** = 그 자원을 동시에 점유하고 있는 개수
- **λ** = 초당 유입 건수 (단위: `건/초`)
- **W** = 한 건이 그 자원을 점유하는 시간 (단위: `초`)

행 잠금에서는 **L이 항상 1**이다. 한 번에 한 트랜잭션만 그 행의 새 버전을 만들 수 있으므로, 동시 점유 수의 상한이 구조적으로 1이다. 식을 λ에 대해 풀면 이렇게 된다.

```
L = λW  에서  L = 1  이므로

        L        1
  λ = ─────  = ─────
        W        W

  단위를 붙여 확인한다:
        1 (건)
      ────────  =  건/초        <- W를 "초"로 맞춰야 건/초가 나온다
        W (초)
```

**단위가 핵심이다.** W를 ms로 두고 나누면 답이 1,000배 틀린다. 17번 문서의 규칙 그대로 — λ의 시간 단위와 W의 시간 단위를 같게 만든다. 아래 표는 모두 ms를 초로 바꾼 뒤 계산한 것이다.

| 락 보유 시간 W | 계산 | 그 행 하나의 처리 상한 λ |
|---|---|---|
| 0.5 ms = 0.0005초 | 1 ÷ 0.0005 | 2,000 건/초 |
| 1 ms = 0.001초 | 1 ÷ 0.001 | 1,000 건/초 |
| 2 ms = 0.002초 | 1 ÷ 0.002 | **500 건/초** |
| 5 ms = 0.005초 | 1 ÷ 0.005 | 200 건/초 |
| 20 ms = 0.02초 | 1 ÷ 0.02 | 50 건/초 |
| 100 ms = 0.1초 | 1 ÷ 0.1 | 10 건/초 |

이 표에서 읽어야 할 것은 숫자 하나가 아니라 **관계**다. 락 보유 시간이 2배가 되면 그 행의 처리 상한은 절반이 된다. 반비례다.

그리고 이 숫자를 실제 트래픽과 나란히 놓으면 결론이 나온다. **인기 웹툰 한 편의 신작 공개 직후에는 그 한 편에 초당 수천 건의 조회가 몰린다.** 초당 3,000건이라고 하자.

```
그 행이 처리할 수 있는 양:     500 건/초  (W = 2ms 가정)
그 행에 실제로 도착하는 양:  3,000 건/초

      3,000 - 500 = 2,500 건/초 씩 대기 줄이 길어진다
```

대기 줄은 초당 2,500건씩 자라기만 하고 줄어들지 않는다. **이것은 "느려진다"가 아니라 "터진다"다.** 17번 문서의 표현으로, 안정 상태(λ ≤ 처리 능력)가 성립하지 않으므로 평균 대기 시간이라는 값 자체가 존재하지 않는다.

### 1-3. 트랜잭션 범위가 락 보유 시간을 정한다 — Before 코드의 진짜 죄

방금 W를 2ms로 가정했지만, **W는 `UPDATE` 문의 실행 시간이 아니다.** 정확히는 **`UPDATE`가 그 행에 손을 댄 순간부터 그 트랜잭션이 `COMMIT` 또는 `ROLLBACK`될 때까지**다. 커밋 전에는 그 행의 새 버전이 확정되지 않았으므로 잠금을 풀 수 없다.

이 사실을 알고 Before 코드를 다시 보면 진짜 문제가 드러난다.

```java
@Transactional
public WebtoonDetail view(Long webtoonId) {
    webtoonRepository.incrementViewCount(webtoonId);   // <- 여기서 행 잠금을 잡는다
    return findDetail(webtoonId);                      // <- 잠금을 쥔 채로 이걸 다 한다
}   // <- 여기(커밋)에서야 잠금이 풀린다
```

`findDetail`이 회차 목록·작가 정보·구매 이력까지 조회해 20ms가 걸린다고 하자. 그러면 W는 2ms가 아니라 **20ms 남짓**이 되고, 위 표에 따라 그 행의 처리 상한은 **50 건/초**로 떨어진다. 초당 3,000건이 오는 행에서 50건/초라는 것은 사실상 마비다.

즉 같은 `UPDATE` 한 줄이라도 **트랜잭션 안에서 어디에 놓이는지에 따라 처리 상한이 10배 달라진다**(500 건/초 → 50 건/초).

```java
// 그나마 나은 버전: 잠금을 마지막에 잡고 즉시 커밋한다
public WebtoonDetail view(Long webtoonId) {
    WebtoonDetail detail = findDetail(webtoonId);   // 트랜잭션 밖에서 읽는다
    countInOwnTransaction(webtoonId);               // 카운터만 별도 짧은 트랜잭션
    return detail;
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
void countInOwnTransaction(Long webtoonId) {
    webtoonRepository.incrementViewCount(webtoonId);
}   // UPDATE 직후 커밋 -> W가 UPDATE + 커밋 시간으로 최소화된다
```

이렇게 하면 W가 2ms 수준으로 줄어 상한이 500건/초로 회복된다. **그런데 여전히 3,000건/초를 못 받는다.** 이것이 중요하다 — 트랜잭션 범위를 아무리 조여도 상한은 산술적으로 수백 건/초 자리수에 머문다. 코드를 다듬어 해결되는 문제가 아니라 **접근 자체를 바꿔야 하는 문제**라는 결론이 여기서 나온다.

### 1-4. 서버를 늘려도 이 숫자는 변하지 않는다

여기서 반드시 짚어야 할 것이 하나 있다. `λ = 1/W` 라는 식에 **서버 대수가 들어가지 않는다.**

앱 서버를 2대에서 20대로 늘려도 그 행 하나의 처리 상한은 여전히 500건/초다. 오히려 나빠진다 — 20대가 각자 커넥션 풀을 들고 같은 행에 몰려들면 대기 줄만 10배 길어지고, 대기 줄이 길어지면 커넥션 점유 시간이 늘어나 다른 기능까지 끌어들인다(1-5).

이것은 02번 문서가 말한 **"읽기는 대수를 늘려 확장되지만 쓰기는 한 지점으로 수렴해야 한다"**는 비대칭의 가장 좁은 사례다. 02번 문서에서는 그 "한 지점"이 프라이머리 DB였는데, 여기서는 프라이머리 DB 안의 **행 한 개**로까지 좁혀진 것이다.

그리고 이 지점에서 조회수 기능의 성질이 드러난다. **조회수는 본질적으로 핫스팟을 만드는 기능이다.** 트래픽이 여러 행에 퍼지면 DB는 잘 버티지만, "인기"라는 속성이 트래픽을 한 행에 모은다. 게다가 조회는 원래 읽기 트래픽인데, 카운터를 DB에 직접 쓰는 순간 **읽기 트래픽 전부가 쓰기 트래픽으로 둔갑한다.** 그러면 읽기 복제본으로 분산할 길도 막힌다 — 쓰기는 프라이머리로만 가기 때문이다.

그래서 답은 "DB를 키우자"가 아니라 **"DB 앞에서 흡수하자"**가 된다.

### 1-5. 대기는 커넥션을 붙잡는다 — 조회수 기능 하나가 서비스 전체를 세우는 경로

락 경합이 단지 "조회수 API가 느려진다"로 끝나지 않는 이유를 반드시 알아야 한다. **락을 기다리는 트랜잭션은 DB 커넥션을 쥔 채 기다린다.**

숫자로 따라가 보자. HikariCP 풀 크기 50, 행 처리 상한 500건/초, 유입 3,000건/초인 상황이다.

```
1) 3,000건/초가 들어오지만 그 행은 500건/초만 통과시킨다.
2) 통과를 기다리는 요청들이 커넥션을 붙잡은 채 쌓인다.
3) 커넥션 50개가 전부 락 대기로 채워진다.
4) 이때 커넥션 하나의 평균 점유 시간은 L = λW 를 W에 대해 풀어 구한다:

        L        50 건
   W = ───  =  ─────────  =  0.1 초  =  100 ms
        λ      500 건/초

   -> 조회수 UPDATE 한 건이 커넥션을 100ms씩 붙잡는다.
      (락을 안 걸었을 때의 2ms에서 50배로 늘어난 것이다)
5) 나머지 2,500건/초는 커넥션을 얻지 못한다:
      HikariPool-1 - Connection is not available, request timed out
```

여기서 결정적인 사실은 **그 커넥션 풀을 조회수 기능만 쓰는 게 아니라는 것**이다. 로그인, 결제, 구매 이력 조회 — 조회수와 아무 관련 없는 모든 쿼리가 같은 풀을 공유한다. 조회수 기능 하나가 풀을 다 먹으면 **서비스 전체가 DB에 접근할 수 없게 된다.**

18번 문서가 다룬 연쇄 장애의 전형적인 경로가 그대로 성립한다.

```
인기작 한 편의 행 잠금 경합
    -> 락 대기 트랜잭션이 커넥션을 장시간 점유
    -> 커넥션 풀 고갈
    -> 커넥션을 못 얻은 요청이 톰캣 스레드를 붙잡고 대기
    -> 톰캣 스레드 풀 고갈
    -> 헬스체크 응답 실패 -> LB가 인스턴스를 빼 버림
    -> 남은 인스턴스에 트래픽 집중 -> 같은 붕괴 반복
```

18번 문서의 언어로 말하면, **조회수 기능에 bulkhead가 없어서 폭발 반경이 서비스 전체가 된 것**이다. 이 경로를 설명할 수 있으면 "조회수 UPDATE가 왜 위험한가"에 대한 답이 완성된다.

### 1-6. MVCC의 부작용 — 한 행에 초당 수천 번 UPDATE하면 무슨 일이 생기는가

락 경합만 문제가 아니다. PostgreSQL에서 `UPDATE`는 **새 버전을 추가로 쓰는 것**이라고 했다. 그 말은 갱신 한 번마다 **쓸모없어진 예전 버전(dead tuple, 죽은 튜플)이 하나 생긴다**는 뜻이다.

죽은 튜플은 **autovacuum**이라는 백그라운드 프로세스가 청소한다. 문제는 속도다. 초당 3,000번 갱신되는 행은 **초당 3,000개의 죽은 튜플**을 만들고, 그것들이 같은 페이지(디스크 블록)에 쌓인다. autovacuum이 따라오지 못하면 테이블이 부풀고(**bloat, 블로트**), 부푼 테이블은 같은 데이터를 읽는 데 더 많은 페이지를 읽어야 하므로 조회까지 느려진다.

완화 장치가 없지는 않다. **HOT(heap-only tuple) 업데이트**는 ① 인덱스가 걸린 컬럼을 바꾸지 않고 ② 같은 페이지 안에 새 버전을 넣을 공간이 있을 때 발동하는 최적화로, 인덱스 항목을 새로 만들지 않고 페이지 안에서 정리까지 해 준다. `view_count`는 보통 인덱스가 없으니 ①은 만족한다. ②를 만족시키려면 페이지에 여유 공간을 남겨 둬야 한다.

```sql
-- 페이지의 30%를 새 버전용 여유로 남겨 HOT 업데이트가 발동하게 한다.
-- fillfactor 기본값은 100(꽉 채움)이라 갱신이 잦은 테이블에서는 낮춰 주는 것이 정석이다.
ALTER TABLE webtoon_stats SET (fillfactor = 70);

-- 이 테이블만 autovacuum을 더 자주 돌게 한다.
-- 기본 임계치는 "행 수의 20%가 변경되면"인데, 통계 테이블은 그보다 훨씬 자주 돌아야 한다.
ALTER TABLE webtoon_stats SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold    = 100
);
```

그래도 근본 해결은 아니다. 갱신 한 번마다 WAL(선행 기록 로그, 02번 문서 참고)도 쓰이므로, **초당 3,000번의 카운터 증가는 초당 3,000건의 WAL을 만들어 디스크와 복제 대역까지 먹는다.** 읽기 복제본이 여럿이면 그 WAL을 복제본 수만큼 전송한다. 조회수 카운터 하나가 복제 지연의 원인이 되는 것이다.

여기서 실무 디테일 하나를 챙기고 가자. **카운터 컬럼은 원본 테이블(`webtoon`)에 두지 말고 별도 통계 테이블(`webtoon_stats`)로 분리한다.** 이유가 셋이다.

첫째, `webtoon` 테이블은 제목·작가·설명 등 폭이 넓어서 행 하나가 크다. 카운터 1 증가 때문에 그 큰 행을 통째로 복사하는 것은 낭비다. 둘째, `webtoon`에는 인덱스가 여러 개 걸려 있어 HOT 업데이트가 깨질 확률이 높다. 셋째, 작가가 작품 설명을 수정하는 트랜잭션과 조회수 증가 트랜잭션이 **같은 행을 두고 싸우게 된다** — 서로 완전히 무관한 두 기능이 잠금을 공유하는 것이다.

### 1-7. 진단 — 이 상황을 PostgreSQL에서 어떻게 확인하는가

"락 경합인 것 같다"는 추측을 사실로 바꾸는 쿼리를 알아 두어야 한다. `pg_stat_activity`는 지금 DB에 붙어 있는 세션 하나하나가 무엇을 하고 있는지 보여 주는 뷰이고, 그중 `wait_event_type`이 **"지금 무엇을 기다리는가"**를 말해 준다.

```sql
-- ① 지금 활성 세션들이 무엇을 기다리는지 종류별로 센다.
--    wait_event_type = 'Lock' 이 다수라면 락 경합이 맞다.
--    (참고: 'Client'는 클라이언트 응답 대기, 'IO'는 디스크 대기 — 원인이 다르다)
SELECT wait_event_type, wait_event, count(*)
  FROM pg_stat_activity
 WHERE state = 'active'
   AND backend_type = 'client backend'
 GROUP BY wait_event_type, wait_event
 ORDER BY count(*) DESC;

-- 핫 로우 경합일 때 전형적으로 나오는 모양:
--  wait_event_type | wait_event    | count
-- -----------------+---------------+-------
--  Lock            | transactionid |    47   <- 앞선 트랜잭션의 커밋을 기다린다
--  Lock            | tuple         |     2   <- 그 튜플의 대기 순번을 기다린다
```

`transactionid`와 `tuple`을 구분해 읽을 수 있으면 좋다. `transactionid`는 **"저 트랜잭션이 끝나기를 기다린다"**는 뜻이고, `tuple`은 **"이 튜플에 대한 대기 줄에 서기를 기다린다"**는 뜻이다. 둘이 함께 대량으로 나타나는 것이 핫 로우 경합의 서명이다.

다음은 **누가 누구를 막고 있는지**를 본다.

```sql
-- ② 막고 있는 놈을 찾는다. pg_blocking_pids()는 이 세션을 막고 있는 세션의 pid를 준다.
SELECT a.pid,
       a.wait_event_type,
       a.wait_event,
       pg_blocking_pids(a.pid)      AS blocked_by,   -- 이 세션을 막은 세션들
       now() - a.xact_start         AS xact_age,     -- 트랜잭션이 열려 있는 시간
       left(a.query, 80)            AS query
  FROM pg_stat_activity a
 WHERE a.wait_event_type = 'Lock'
 ORDER BY xact_age DESC
 LIMIT 30;
```

`blocked_by`에 **같은 pid가 수십 개 세션에서 반복해서 나오면** 그 한 트랜잭션이 병목이라는 뜻이다. 그리고 `xact_age`가 크면 1-3에서 본 문제 — 트랜잭션 범위가 넓어 잠금을 오래 쥐고 있는 것 — 를 의심한다.

마지막으로 **어느 행이 문제인지**를 특정한다.

```sql
-- ③ 어떤 테이블·어떤 튜플에 대기가 몰렸는지 본다.
--    granted = false 인 행이 "아직 못 얻은 잠금 요청"이다.
SELECT l.relation::regclass AS table_name,
       l.locktype,
       l.transactionid,
       l.granted,
       count(*)
  FROM pg_locks l
 WHERE l.granted = false
 GROUP BY 1, 2, 3, 4
 ORDER BY count(*) DESC;
```

이 셋을 순서대로 돌리면 "조회수 UPDATE가 특정 행에서 직렬화되고 있다"를 증거로 말할 수 있다. 06번 문서(지연 병목 조사)의 절차와 같은 흐름 — **추측을 지표로 확정한 뒤에 설계를 바꾼다.**

## 2. 설계 골격 — write-behind, 그리고 flush 주기를 정하는 계산

### 2-1. write-behind가 무엇인가 — write-through와 무엇이 갈리는가

해법의 이름부터 정의하자. **write-behind(뒤에서 쓰기, write-back이라고도 한다)는 쓰기를 캐시에 먼저 받아 두고 즉시 성공을 반환한 뒤, DB 반영은 나중에 모아서 하는 방식**이다. "뒤에서"라는 이름은 DB 반영이 응답 경로 **뒤로** 빠져 사용자를 기다리게 하지 않는다는 뜻이다.

비교 대상은 **write-through(쓰기 관통)**다. 이쪽은 앱이 캐시에 쓰면 캐시가 그 쓰기를 **DB까지 동기로 전달**하고, DB 쓰기까지 성공해야 앱에 성공을 돌려준다. 쓰기가 캐시를 **관통해서** DB까지 간다는 뜻의 이름이다.

두 방식이 무엇을 주고 무엇을 받는지가 이 설계의 전부다.

| | write-through | write-behind |
|---|---|---|
| 응답 시점 | DB 쓰기까지 끝난 뒤 | 캐시에 쓴 직후 |
| DB 쓰기 횟수 | 요청 수와 **1:1** | **주기당 1번**으로 압축 |
| 핫 로우 경합 | 그대로 남는다 | 사라진다 |
| 캐시가 죽으면 | 잃을 것이 없다 (DB에 이미 있다) | **미반영 구간이 사라진다** |

핵심은 마지막 두 줄이다. write-behind가 **얻는 것은 DB 쓰기 횟수의 극적 감소**다 — 10초 동안 같은 콘텐츠에 들어온 수천 건의 `INCR`이 배치 `UPDATE` 한 건으로 합쳐지고, 그 결과 1절에서 본 핫 로우 경합이 원인 단계에서 사라진다. **잃는 것은 아직 DB에 반영되지 않은 구간의 유실 가능성**이다. 캐시는 기본적으로 휘발성 저장소이므로 이 위험은 이론이 아니라 실재한다.

그래서 write-behind는 **유실이 허용되는 데이터에만 쓸 수 있는 카드**다. 조회수·좋아요 카운터는 몇 건 사라져도 되니까 훌륭한 선택이고, 잔액·주문은 유실이 곧 사고이므로 쓸 수 없다. 5장 05번 문서(look-aside 패턴)가 네 가지 캐시 패턴을 한 축으로 정리해 두었으니 용어는 그쪽과 같이 쓴다.

한 가지 더. 5장 05번 문서에서 말하는 정통 write-behind는 **캐시 계층이 스스로 DB에 반영해 주는** 구조다. 그런데 Redis는 우리 DB를 모르므로 그 일을 해 줄 수 없다. **그래서 여기서 만드는 것은 "애플리케이션이 직접 구현하는 write-behind"**다 — 버퍼는 Redis에 두고, 모아서 반영하는 코드는 우리가 쓴다.

### 2-2. 파이프라인 전체 그림

```
[조회 요청 도착]
    │
    │ API는 카운트를 DB에 쓰지 않는다. 이것이 이 설계의 유일한 규칙이다.
    ▼
[Redis INCR view:delta:123]        메모리 연산, 락 경합 없음, 초당 수십만 처리
[Redis SADD view:dirty  123]       "이 콘텐츠에 미반영 증가분이 있다"는 표식
    │
    │ 주기적 flush (예: 10초마다, 단일 실행자)
    ▼
[SPOP view:dirty -> 대상 id 목록]
[GETDEL view:delta:{id} -> 각 id의 증가분]   원자적으로 "가져가면서 비운다"
    │
    ▼
[INSERT ... ON CONFLICT DO UPDATE]  여러 콘텐츠를 SQL 한 문장으로 반영
    │
    ▼
[PostgreSQL webtoon_stats.view_count]   영속 원본 (확정된 조회수)


[화면 표시 경로]
    표시값 = webtoon_stats.view_count (확정분)  +  view:delta:123 (미반영분)
    -> flush 전후로 숫자가 뒤로 가지 않는다 (2-3에서 설명)
```

이 그림에서 읽어야 할 구조는 **DB가 "확정분"만 들고, Redis가 "아직 확정되지 않은 증가분"만 든다**는 역할 분담이다. 두 값을 더한 것이 현재 조회수다. 이 분담이 왜 중요한지는 곧 나온다 — Redis 키가 통째로 사라져도 DB의 확정분은 온전하기 때문에, 유실이 "그 순간의 미반영분"으로만 국한된다.

### 2-3. After 코드 — 조회는 Redis로 흡수한다

```java
// After: DB를 건드리지 않고 Redis에 흡수한다
@Service
@RequiredArgsConstructor
public class ViewCountService {

    private static final String DELTA_KEY = "view:delta:";   // 미반영 증가분
    private static final String TOTAL_KEY = "view:total:";   // 표시용 누적값
    private static final String DIRTY_SET = "view:dirty";    // 미반영 콘텐츠 목록

    private final StringRedisTemplate redis;
    private final WebtoonStatsRepository statsRepository;

    public void countView(Long webtoonId) {
        String id = webtoonId.toString();
        // 세 명령을 파이프라인으로 한 번에 보낸다. 왕복(RTT)을 3번에서 1번으로 줄이려는 것이고,
        // 조회 API의 응답 시간에 얹히는 비용을 최소화하는 것이 목적이다.
        redis.executePipelined((RedisCallback<Object>) conn -> {
            StringRedisConnection c = (StringRedisConnection) conn;
            c.incr(DELTA_KEY + id);       // (1) DB에 반영할 증가분
            c.incr(TOTAL_KEY + id);       // (2) 화면에 보여줄 누적값
            c.sAdd(DIRTY_SET, id);        // (3) flush 대상 표식 — 반드시 (1) 뒤에 온다
            return null;
        });
        // (1)을 (3)보다 먼저 실행하는 순서가 중요하다. 이유는 2-4의 유실 증명에서 밝힌다.
    }
}
```

**표시용 값(`view:total`)을 왜 따로 두는가.** "DB 확정분 + Redis 증가분"을 매번 더해서 보여 주면 될 것 같지만, DB 확정분을 캐시해 두는 순간 문제가 생긴다. flush가 돌아 DB 확정분이 늘고 `view:delta`가 0으로 비워졌는데 캐시된 DB 값이 아직 옛 값이면, **표시되는 숫자가 뒤로 간다.** 사용자 눈에는 조회수가 줄어드는 것으로 보이고, 이것은 "몇 건 틀림"과는 성질이 다른 버그다.

그래서 **표시용 누적 카운터를 별도로 두고 그것만 읽는다.** flush는 `view:delta`만 건드리므로 `view:total`은 영향을 받지 않아 단조 증가가 보장된다.

```java
    public long readViewCount(Long webtoonId) {
        String total = redis.opsForValue().get(TOTAL_KEY + webtoonId);
        if (total != null) {
            return Long.parseLong(total);
        }
        // 키가 없다 = Redis 재시작이나 eviction으로 표시용 값이 사라졌다.
        // DB 확정분 + 아직 남아 있는 미반영 증가분으로 다시 씨를 뿌린다.
        long persisted = statsRepository.findViewCount(webtoonId);
        String delta = redis.opsForValue().get(DELTA_KEY + webtoonId);
        long seed = persisted + (delta == null ? 0L : Long.parseLong(delta));

        // setIfAbsent(= SET NX): 여러 스레드가 동시에 씨를 뿌리려 할 때
        // 먼저 쓴 쪽만 이기게 한다. 나중에 온 쪽이 덮어쓰면 그사이 INCR된 만큼이 사라진다.
        redis.opsForValue().setIfAbsent(TOTAL_KEY + webtoonId, String.valueOf(seed));
        return Long.parseLong(redis.opsForValue().get(TOTAL_KEY + webtoonId));
    }
```

효과를 숫자 감각으로 확인하자. 초당 3,000건이 몰리는 인기작 한 편에서, **그 행의 DB 갱신 빈도가 초당 3,000회에서 flush 주기당 1회로 떨어진다.** 주기 10초라면 초당 0.1회다. 1-2의 상한 500건/초 대비 여유가 5,000배가 된다.

한 콘텐츠에 초당 5,000 조회가 몰리는 규모로 올려도 결론이 같다. **초당 5,000 조회 × 10초 = 5만 건의 쓰기가 `UPDATE` 1번으로 압축된다.** 압축비가 5만 대 1이고, 그 1번이 다루는 것은 `view_count = view_count + 50000`이라는 한 줄이다.

더 본질적인 변화는 이것이다. **DB 쓰기 부하가 조회 트래픽에 비례하지 않게 된다.** 이제 부하는 "조회수가 발생한 콘텐츠 수 ÷ flush 주기"에만 비례한다. 트래픽이 10배 되어도 콘텐츠 수가 그대로면 DB 쓰기는 그대로다. **부하의 축을 트래픽에서 분리한 것**이 이 설계의 본질이다.

### 2-4. flush를 원자적으로 — 왜 GET 후 DEL이면 안 되는가

flush의 핵심은 **"읽으면서 비운다"를 한 걸음으로 하는 것**이다. 두 걸음으로 나누면 그 사이에 들어온 증가분이 사라진다. 왜 그런지 시간축에 놓아 보자.

```
[틀린 방식: GET 후 DEL]

t0   Redis:  view:delta:123 = 5000
t1   flush:  GET view:delta:123        -> 5000 을 받아 애플리케이션 메모리에 담는다
t2   ★ 사용자 조회 3건 도착
     Redis:  INCR ×3                   -> view:delta:123 = 5003
t3   flush:  DEL view:delta:123        -> 키가 삭제된다
t4   flush:  DB에 5000 을 더한다

  결과: t2의 3건은 DB에도 없고 Redis에도 없다. 조용히 사라졌다.
        그리고 이 유실은 로그에도 에러로 남지 않는다 — 아무도 실패하지 않았기 때문이다.
```

문제의 구조를 정확히 말하면 이렇다. **t1에서 값을 읽은 시점과 t3에서 키를 지운 시점 사이에 상태가 변했는데, t3의 `DEL`은 "무엇을 지우는지"를 확인하지 않는다.** 5003을 지우면서 5000만 가져간 것이다.

Redis는 명령 하나하나가 원자적이지만(5장 01번 문서 — 싱글 스레드로 명령을 하나씩 처리한다), **명령 두 개 사이에는 다른 클라이언트가 끼어들 수 있다.** 이것이 5장 22번 문서(Lua 스크립트)가 다루는 check-then-act 문제와 정확히 같은 구조다.

해결은 **하나의 명령으로 만드는 것**이다. Redis 6.2부터 `GETDEL`이 있다 — 값을 반환하면서 그 키를 삭제하는 것을 원자적으로 한다.

```
[옳은 방식: GETDEL]

t0   Redis:  view:delta:123 = 5000
t1   flush:  GETDEL view:delta:123     -> 5000 을 반환하고 동시에 키 삭제
t2   사용자 조회 3건 도착
     Redis:  INCR ×3                   -> 키가 새로 만들어져 3 이 된다
t3   flush:  DB에 5000 을 더한다

  결과: 3건은 다음 flush에서 반영된다. 아무것도 사라지지 않았다.
```

`GETDEL`을 못 쓰는 버전이라면 대안이 둘 있다.

```java
// 대안 ①: GETSET — 값을 반환하면서 0으로 덮는다. 이것도 단일 명령이라 원자적이다.
//          단점은 키가 0인 상태로 계속 남아 메모리를 조금씩 먹는다는 것.
String delta = redis.opsForValue().getAndSet(DELTA_KEY + id, "0");

// 대안 ②: Lua 스크립트 — 여러 명령을 서버 안에서 한 덩어리로 실행한다.
//          여러 키를 한 번에 회수해야 할 때 왕복까지 줄여 준다.
```

```lua
-- flush_deltas.lua: 넘겨받은 키들의 값을 모아 반환하면서 전부 삭제한다.
-- Redis는 스크립트 실행 중 다른 명령을 처리하지 않으므로 중간에 끼어들 틈이 없다.
local result = {}
for i = 1, #KEYS do
  local v = redis.call('GETDEL', KEYS[i])
  result[i] = v or '0'      -- 키가 없으면 0으로 채워 인덱스를 맞춘다
end
return result
```

**Lua 스크립트는 짧게 유지해야 한다.** 5장 22번 문서가 경고하는 대로, 스크립트가 도는 동안 Redis 전체가 멈춘다. 한 번에 수만 개 키를 넘기면 그것 자체가 장애가 되므로 수백~1,000개 단위로 끊어서 호출한다.

#### dirty 집합에서도 같은 문제가 생기지 않는가

생긴다. 그래서 dirty 집합도 원자적으로 회수한다 — `SPOP`은 멤버를 반환하면서 제거하는 단일 명령이다.

```java
// 원자적으로 최대 1,000개를 꺼내 온다. 꺼낸 순간 집합에서 사라진다.
List<String> ids = redis.opsForSet().pop(DIRTY_SET, 1000);
```

그런데 여기서 한 번 더 따져 봐야 한다. **`SPOP`으로 id를 꺼낸 뒤 `GETDEL`을 하기까지의 틈에 새 조회가 들어오면?** 그 조회의 `INCR`은 `GETDEL` 전이라면 함께 회수되니 문제없고, `GETDEL` 후라면 회수되지 않는데 그 id는 이미 dirty 집합에서 빠져 있다. 증가분이 고아가 되는 것처럼 보인다.

**2-3의 코드에서 `INCR`을 `SADD`보다 먼저 실행한 이유가 여기 있다.** 그 순서 덕분에 고아가 생기지 않는다는 것을 증명할 수 있다.

```
기호   조회 한 건: INCR 시각 i,  SADD 시각 s     (코드 순서상 항상 i < s)
       flush 한 회: SPOP 시각 p,  GETDEL 시각 g   (코드 순서상 항상 p < g)

경우 A) i < g  ->  그 증가분은 이번 GETDEL 결과에 포함된다. 반영 완료.

경우 B) i > g  ->  이번에 회수되지 않았다. 그런데
                   s > i > g > p 이므로 s > p 다.
                   즉 SADD가 SPOP보다 늦게 일어났으므로
                   그 id는 지금 dirty 집합에 다시 들어가 있다.
                   -> 다음 flush에서 반영된다.

  두 경우가 전부이므로, 유실은 없고 최대 한 주기의 지연만 남는다.
```

이 순서 의존을 코드 주석으로 남겨 두지 않으면 나중에 누군가가 "가독성을 위해" 두 줄의 순서를 바꿔 조용한 버그를 만든다. **원자성에 기대는 코드는 왜 그 순서인지를 반드시 적어 둔다.**

더 단단하게 하려면 **키 로테이션(이중 버퍼링)**이 있다. 증가분을 해시 하나에 모으고, flush 시점에 그 해시의 이름을 바꿔 버리는 방식이다.

```
평상시:  HINCRBY view:delta:{cur} 123 1     <- 모든 조회가 여기에 쌓인다

flush:   RENAME view:delta:{cur} view:delta:{flushing}
           -> RENAME은 단일 명령이라 원자적이다.
           -> 이 순간 이후의 HINCRBY는 새로 만들어지는 {cur} 해시에 쌓인다.
           -> 즉 "이 순간까지의 증가분"이 통째로 {flushing}에 격리된다.
         HGETALL view:delta:{flushing}  -> 여유롭게 읽어 DB에 반영
         DEL     view:delta:{flushing}  -> 반영 확인 후 삭제
```

경계가 `RENAME` 한 번으로 딱 끊기므로 위와 같은 순서 증명이 필요 없다. 대가는 두 가지다. 첫째, **증가분 전체가 키 하나에 모이므로 Redis Cluster에서 그 키가 있는 노드 한 대에 쓰기가 집중된다**(2-9의 핫 키 문제가 여기서 발생한다). 둘째, `RENAME`은 두 키가 같은 슬롯에 있어야 하므로 `{...}` 해시 태그로 슬롯을 묶어야 한다.

#### DB 반영이 실패하면 회수한 증가분은 어떻게 되는가

`GETDEL`로 가져온 순간 그 값은 애플리케이션 메모리에만 있다. DB 쓰기가 실패하면 사라진다. **되돌려 놓는다.**

```java
try {
    statsRepository.applyDeltas(deltas);      // 배치 upsert (2-5)
} catch (DataAccessException e) {
    // 증가분은 더하기라서 순서가 상관없고 되돌려 놓아도 안전하다.
    // 이 성질(교환법칙)이 delta 방식의 숨은 장점이다.
    deltas.forEach((id, delta) -> {
        redis.opsForValue().increment(DELTA_KEY + id, delta);
        redis.opsForSet().add(DIRTY_SET, id.toString());   // 표식도 되돌린다
    });
    throw e;   // 다음 주기에 다시 시도된다
}
```

되돌리기가 이렇게 간단한 이유는 **증가분이 더하기이기 때문**이다. "절대값을 덮어쓰는" 방식이었다면 되돌릴 때 그사이 들어온 증가분을 어떻게 처리할지가 곧바로 문제가 된다. 20번 문서에서 다룰 CRDT 이야기와 같은 원리 — **어떤 순서로 합쳐도 같은 결과가 나오는 자료구조는 분산 환경의 실패 처리를 극적으로 단순하게 만든다.**

### 2-5. DB 반영은 한 문장으로 — PostgreSQL upsert

회수한 증가분을 콘텐츠마다 `UPDATE` 한 번씩 치면 콘텐츠가 5,000편이면 왕복 5,000번이다. **여러 콘텐츠를 SQL 한 문장으로 반영한다.**

먼저 테이블은 1-6에서 말한 대로 분리한다.

```sql
CREATE TABLE webtoon_stats (
    webtoon_id bigint      PRIMARY KEY,
    view_count bigint      NOT NULL DEFAULT 0,
    like_count bigint      NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- 갱신이 잦으므로 페이지에 여유를 남겨 HOT 업데이트를 유도한다 (1-6 참고)
ALTER TABLE webtoon_stats SET (fillfactor = 70);
```

반영은 `INSERT ... ON CONFLICT DO UPDATE`로 한다. 이것은 **"없으면 넣고 있으면 고친다"**를 한 문장으로 하는 PostgreSQL 문법이고, 흔히 **upsert**라고 부른다. 조회수 통계는 첫 조회 때 행이 없을 수 있으므로 이 형태가 맞다.

```sql
-- 여러 콘텐츠의 증가분을 한 문장으로 반영한다.
-- unnest(배열)로 여러 행을 만들어 넣는 것이 요점이다.
INSERT INTO webtoon_stats AS s (webtoon_id, view_count)
SELECT * FROM unnest(?::bigint[], ?::bigint[])   -- (id 배열, 증가분 배열)
ON CONFLICT (webtoon_id) DO UPDATE
   SET view_count = s.view_count + EXCLUDED.view_count,   -- 기존값 + 이번 증가분
       updated_at = now();
```

`EXCLUDED`는 **"충돌 때문에 삽입되지 못한 그 행"**을 가리키는 PostgreSQL의 특수 별칭이다. 그래서 `s.view_count + EXCLUDED.view_count`는 "DB에 이미 있는 확정분 + 이번에 가져온 증가분"이 된다. `INSERT INTO ... AS s`로 별칭을 붙여 두면 기존 행을 `s.`로 참조할 수 있다.

**절대값을 덮어쓰지 않고 더하는 형태를 쓰는 이유**가 중요하다. `SET view_count = EXCLUDED.view_count`로 덮어쓰면 Redis가 진실의 원천이 되어야 하는데, Redis 키가 evict되거나 재시작으로 사라지면 조회수가 **과거 값으로 되돌아간다.** 더하기 형태면 Redis는 "아직 안 더한 몫"만 들고 있으므로 사라져도 그 몫만 잃는다.

```java
@Component
@RequiredArgsConstructor
public class ViewCountFlusher {

    // 2-4의 스크립트. 넘긴 키들의 값을 모아 반환하면서 전부 삭제한다.
    private static final RedisScript<List> FLUSH_DELTAS =
            RedisScript.of(new ClassPathResource("redis/flush_deltas.lua"), List.class);

    private final StringRedisTemplate redis;
    private final JdbcTemplate jdbc;

    public void flushOnce() {
        // SPOP count 는 List 로 돌려준다. 꺼낸 순간 집합에서 사라지므로 원자적이다.
        List<String> ids = redis.opsForSet().pop("view:dirty", 1000);
        if (ids == null || ids.isEmpty()) return;

        // 같은 id가 두 번 들어오면 안 된다. 이유는 아래 함정 참고.
        // SPOP은 집합에서 꺼내므로 중복이 없지만, 되돌리기(2-4)를 거친
        // 목록과 합쳐질 수 있으니 방어적으로 한 번 더 정리한다.
        List<Long> idList = ids.stream().map(Long::parseLong).distinct().sorted().toList();
        //                                                              ^^^^^^
        // 정렬하는 이유: 두 flush가 어쩌다 동시에 돌면 같은 행들을 반대 순서로 잠가
        // 데드락이 난다. 항상 같은 순서로 잠그면 데드락이 원리적으로 사라진다.

        // 2-4의 Lua 스크립트로 증가분을 원자적으로 회수한다.
        // 키마다 GETDEL을 따로 보내면 왕복이 id 수만큼 생기므로,
        // 서버 안에서 한 번에 처리하는 스크립트가 왕복까지 1번으로 줄여 준다.
        List<String> keys = idList.stream().map(id -> "view:delta:" + id).toList();
        @SuppressWarnings("unchecked")
        List<String> raw = (List<String>) redis.execute(FLUSH_DELTAS, keys);

        List<Long> targets = new ArrayList<>();
        List<Long> deltas  = new ArrayList<>();
        for (int i = 0; i < idList.size(); i++) {
            long d = Long.parseLong(raw.get(i));
            if (d > 0) { targets.add(idList.get(i)); deltas.add(d); }
            // 0이면 문장에서 제외한다 — 값이 안 바뀌는 UPDATE도 새 행 버전을
            // 만들어 죽은 튜플을 남기므로(1-6), 굳이 치지 않는 것이 낫다.
        }
        if (targets.isEmpty()) return;

        jdbc.update("""
            INSERT INTO webtoon_stats AS s (webtoon_id, view_count)
            SELECT * FROM unnest(?::bigint[], ?::bigint[])
            ON CONFLICT (webtoon_id) DO UPDATE
               SET view_count = s.view_count + EXCLUDED.view_count,
                   updated_at = now()
            """, targets.toArray(new Long[0]), deltas.toArray(new Long[0]));
    }
}
```

**함정 하나를 반드시 알아 둬야 한다.** 한 `INSERT ... ON CONFLICT DO UPDATE` 문장 안에 **같은 키가 두 번 등장하면** PostgreSQL이 에러를 낸다.

```
ERROR:  ON CONFLICT DO UPDATE command cannot affect row a second time
HINT:   Ensure that no rows proposed for insertion within the same command
        have duplicate constrained values.
```

한 문장 안에서 같은 행을 두 번 고치는 것이 정의되지 않기 때문이다. 그래서 배치를 만들 때 **키 중복을 미리 합쳐 두는 것**이 필수다. 위 코드의 `distinct()`가 그 역할이다. 배치를 구성하는 코드가 여러 곳에 흩어져 있으면 이 에러가 운영 중에 튀어나온다.

### 2-6. flush 주기를 정하는 계산 — 유실 창과 DB 쓰기의 교환

"10초마다"라고 썼지만 그 10초는 어디서 나온 숫자인가. **주기를 짧게 하면 유실 창이 작아지지만 DB 쓰기가 늘고, 길게 하면 반대다.** 이 교환을 숫자로 세워 보자.

전제를 명시한다.

```
λ_all  = 전체 조회 유입          10,000 건/초
λ_top  = 인기작 1편의 유입        3,000 건/초
C      = 조회가 발생한 콘텐츠 수   5,000 편   (= flush마다 처리할 dirty 키 수)
T      = flush 주기 (초)
```

주기 T에서 세 가지 값이 나온다.

```
① DB에 반영되는 행 수(초당)  =  C / T
     주기마다 dirty 키 C개를 한 번씩 갱신하므로, 초당으로 환산하면 C ÷ T 다.

② flush SQL 문장 수(초당)     =  (C / 배치크기) / T
     배치 1,000행이면 주기마다 5문장이므로 5 ÷ T 다.

③ 최대 유실 조회 수           =  λ × T
     Redis가 죽는 최악의 순간은 flush 직전이고, 그때 최대 T초치가 미반영 상태다.
```

숫자를 넣어 보자.

| T | ① DB 반영 행/초 | ② SQL 문장/초 | ③ 최대 유실(전체) | ③' 최대 유실(인기작 1편) | 인기작 행의 갱신 빈도 |
|---|---|---|---|---|---|
| 1초 | 5,000 | 5 | 10,000 건 | 3,000 건 | 1회/초 |
| 5초 | 1,000 | 1 | 50,000 건 | 15,000 건 | 0.2회/초 |
| 10초 | 500 | 0.5 | 100,000 건 | 30,000 건 | 0.1회/초 |
| 60초 | 83 | 0.083 | 600,000 건 | 180,000 건 | 0.017회/초 |

계산을 한 줄씩 확인하면 이렇다. T=5초일 때 ①은 5,000 ÷ 5 = 1,000행/초, ③은 10,000 × 5 = 50,000건. T=60초일 때 ①은 5,000 ÷ 60 = 83.3행/초, ③은 10,000 × 60 = 600,000건.

**주기를 5초에서 60초로 12배 늘리면 DB 쓰기는 정확히 12분의 1(1,000 → 83)이 되고 최대 유실 창은 정확히 12배(5만 → 60만)가 된다.** 정비례와 반비례가 맞물린 깔끔한 교환이다. 이 관계를 알고 있으면 "몇 초가 적당한가요?"라는 질문에 "무엇을 얼마나 지불할 수 있는지에 따라 다릅니다"가 아니라 **숫자로** 답할 수 있다.

표에서 함께 봐야 할 열이 마지막 열이다. **주기가 1초여도 인기작 행의 갱신 빈도는 초당 1회**로, 1-2의 상한 500건/초에 비해 500배 여유가 있다. 즉 **핫 로우 문제는 주기와 거의 무관하게 이미 해결된다.** 주기를 늘려서 추가로 사는 것은 DB의 전체 쓰기량(그리고 그에 딸린 WAL·죽은 튜플·복제 대역)일 뿐이다.

그래서 주기 결정의 실질적 축은 **"DB 쓰기량을 얼마나 더 줄일 필요가 있는가"와 "유실 창을 얼마까지 허용하는가"**의 둘로 좁혀진다.

### 2-7. 유실을 어디까지 감수하는가 — 이것이 비즈니스 합의다

위 표의 ③번 열을 보면 "60만 건 유실"이 끔찍하게 들린다. 이 숫자를 정직하게 읽는 법을 알아야 한다.

**첫째, 유실은 Redis가 죽었을 때만 일어난다.** 정상 운영에서는 모든 증가분이 다음 주기에 DB로 간다. 그러니 기대 유실량은 `창 크기 × 장애 빈도`다.

**둘째, 그 절대량을 전체 조회량과 비교해야 한다.**

```
월 전체 조회량 = 10,000 건/초 × 30일
               = 10,000 × (30 × 24 × 60 × 60) 초
               = 10,000 × 2,592,000
               = 25,920,000,000 건  (약 259억 건)

월 1회 Redis 페일오버가 있고 그때 T=10초치를 잃는다면
  유실량 = 100,000 건
  유실률 = 100,000 ÷ 25,920,000,000 ≈ 0.0000039 = 약 0.0004%
```

**월 유실률이 백만분의 4다.** "조회수 60만 건이 사라진다"는 문장과 "조회수의 0.0004%가 사라진다"는 문장은 같은 사실인데, 비즈니스 담당자와 협상할 때는 후자로 말해야 한다.

**셋째, 그래서 이것은 기술 결정이 아니라 합의다.** 물어야 할 질문은 "flush 주기를 몇 초로 할까요?"가 아니라 이것이다.

- "장애 시 최근 10초치 조회수가 사라져도 됩니까?" — 대부분의 서비스에서 **된다.** 이 합의가 있어야 이 설계 전체가 성립한다.
- "조회수가 화면에서 몇 초 늦게 반영돼도 됩니까?" — 표시용 값은 Redis에서 읽으므로 사실상 즉시다. 늦는 것은 DB의 확정분뿐이고, 그것을 보는 것은 사용자가 아니라 배치·분석이다.
- "조회수가 1~2 틀려도 됩니까?" — 된다면 뒤에 나오는 확률 자료구조·샤딩 같은 카드까지 쓸 수 있다.

허용 폭을 더 줄여야 한다면 비용을 순서대로 지불한다.

① **flush 주기 단축** — 가장 싸다. 위 표에서 T만 줄이면 되고 코드 변경이 없다.
② **Redis AOF 영속화** — Redis가 받은 명령을 디스크에 기록해 재시작 시 재생한다. `appendfsync everysec`이면 최대 1초치만 잃는다. 대가는 쓰기 지연 증가와 디스크 I/O다(5장 08번 문서).
③ **Kafka에 원본 이벤트를 남기기** — 조회 이벤트 자체를 로그로 보존하므로 장애 후 재집계가 가능하다. 가장 비싸고 가장 튼튼하다(2-10).

**"유실 0"이 진짜 요구라면 그것은 조회수가 아니다.** 3-6에서 다룬다.

### 2-8. flush 실행 주체는 하나여야 한다

`@Scheduled`를 붙이면 앱 인스턴스가 N대일 때 N번 돈다. 이 함정과 그 해법(ShedLock 분산 락, 리더 선출, 쿠버네티스 CronJob으로 분리, `pg_try_advisory_xact_lock`)은 **04번 문서 3-3에 코드까지 정리되어 있으니 그대로 적용한다.** 여기서는 조회수 flush에 특유한 부분만 짚는다.

**증가분을 더하는 방식(`view_count = view_count + delta`)이라 순서는 상관없다.** 어느 인스턴스가 먼저 반영하든 최종 합계는 같다. 그래서 이 작업에는 "순서 보장"이 필요 없다.

**그러나 중복 반영은 그대로 오차가 된다.** 두 인스턴스가 같은 증가분을 각각 DB에 더하면 조회수가 두 배로 뛴다. 그래서 이 작업에서 정말 필요한 것은 상호 배제가 아니라 **"증가분을 원자적으로 회수하는 것"**이다.

2-4의 `GETDEL`이 그 역할을 한다. 두 인스턴스가 동시에 flush를 시작해도 같은 키에 대해 `GETDEL`이 성공하는 것은 한쪽뿐이고, 다른 쪽은 `null`을 받아 건너뛴다. **즉 원자적 회수가 갖춰져 있으면 분산 락 없이도 중복 반영이 나지 않는다.**

그렇다면 락은 왜 두는가. 두 가지 이유다. 첫째, **불필요한 DB 왕복과 커넥션 점유를 줄이기 위해서**다. 다섯 인스턴스가 동시에 돌면 넷은 빈손으로 왕복만 한다. 둘째, **되돌리기(2-4의 실패 처리)가 동시에 여러 인스턴스에서 일어나면 추론이 어려워지기 때문**이다.

정리하면 이렇다. **원자적 회수가 정합성의 근거이고, 분산 락은 효율과 단순성을 위한 장치다.** 04번 문서가 말한 "분산 락은 정확히 한 번을 보장하지 않으므로 작업 자체가 멱등하거나 원자적이어야 한다"는 원칙이 여기서도 그대로 적용된다.

### 2-9. 핫 키 — DB에서 쫓아낸 문제가 Redis에서 다시 나타난다

Redis `INCR`이 초당 수십만을 처리한다고 해서 무한이라는 뜻은 아니다. **Redis도 키 하나에 대한 명령은 한 노드의 싱글 스레드에서 하나씩 처리된다**(5장 01번 문서). 즉 1절에서 본 것과 **같은 구조의 병목**이 자리수만 바뀌어 다시 나타난다.

| | 처리 상한(자리수) | 초당 3,000건을 감당하는가 |
|---|---|---|
| PostgreSQL 한 행의 `UPDATE` | 수백 건/초 | **못 한다** |
| Redis 한 키의 `INCR` | 수만~수십만 건/초 | 한다 |

이 자리수 차이가 write-behind가 성립하는 이유의 전부다. 그래서 초당 3,000건 수준에서는 Redis 단일 키로 충분하다. **문제는 그 위다** — 대형 이벤트에서 한 콘텐츠에 초당 수십만이 몰리면 그 키가 있는 노드 한 대가 포화된다.

그리고 여기서 반드시 알아야 할 사실이 있다. **Redis Cluster를 써도 이 문제는 해결되지 않는다.** 클러스터는 키 이름을 해시해 슬롯을 정하고 그 슬롯을 가진 노드로 보내므로, **분산의 단위가 키다.** 노드를 100대로 늘려도 키 하나의 부하는 쪼개지지 않는다(5장 13번 문서).

해법은 1절에서 본 것과 **같은 원리**다 — 하나를 여러 개로 쪼개고 읽을 때 합산한다.

```java
// 핫 키 샤딩: 키를 N개로 쪼개 무작위로 INCR하고, 읽을 때 합산한다
public class ShardedCounter {

    private static final int SHARDS = 16;   // 2의 거듭제곱이면 나머지 연산이 싸다

    private final StringRedisTemplate redis;

    public void increment(long webtoonId) {
        // 스레드마다 다른 샤드로 흩어지게 한다. ThreadLocalRandom을 쓰는 이유는
        // Random을 공유하면 그 자체가 경합 지점이 되기 때문이다.
        int shard = ThreadLocalRandom.current().nextInt(SHARDS);
        redis.opsForValue().increment(shardKey(webtoonId, shard));
    }

    public long sum(long webtoonId) {
        List<String> keys = IntStream.range(0, SHARDS)
                .mapToObj(s -> shardKey(webtoonId, s))
                .toList();
        // MGET 한 번으로 16개를 가져온다. 루프로 GET 16번 하면 왕복이 16번이다
        // (5장 21번 문서). 단, 클러스터에서는 키들이 서로 다른 슬롯에 있으므로
        // 클라이언트가 슬롯별로 쪼개 보낸다 — 왕복이 노드 수만큼 생긴다.
        List<String> values = redis.opsForValue().multiGet(keys);
        return values == null ? 0L
                : values.stream().filter(Objects::nonNull)
                        .mapToLong(Long::parseLong).sum();
    }

    private String shardKey(long webtoonId, int shard) {
        // 해시 태그 {}를 쓰지 않는 것이 중요하다. {view:123} 처럼 묶으면
        // 16개 키가 같은 슬롯 = 같은 노드로 가서 샤딩한 의미가 사라진다.
        return "view:delta:" + webtoonId + ":s" + shard;
    }
}
```

샤딩의 대가는 명확하다.

**쓰기 부하는 16분의 1이 된다.** 초당 320,000건이 몰려도 샤드당 20,000건이고, 16개 슬롯이 서로 다른 노드로 흩어지면 노드당 20,000건이다.

**읽기 비용은 16배가 된다.** 표시할 때마다 16개 키를 읽어 합산해야 한다. 그래서 실무에서는 합산 결과를 **짧은 TTL(1~5초)로 한 번 더 캐시**한다. 이것이 "몇 초 늦어도 되는가"라는 합의가 다시 값을 하는 지점이다 — 그 합의가 있으면 읽기 비용 16배를 1초에 한 번으로 눌러 버릴 수 있다.

**샤드 수는 함부로 바꿀 수 없다.** 16에서 32로 늘리면 예전 16개 키에 남아 있는 값을 읽어 합쳐야 하고, 줄이면 사라지는 샤드의 값을 옮겨야 한다. 그래서 샤딩은 **핫 키로 판명된 소수 콘텐츠에만 적용하고, 나머지는 단일 키로 두는 것**이 실무의 선택이다. 어느 콘텐츠가 핫 키인지는 감지 절차(5장 13번 문서)로 찾는다.

### 2-10. 더 큰 트래픽에서는 Kafka로

Redis 버퍼링의 성질을 한마디로 말하면 **"이미 합쳐진 숫자만 남기고 원본을 버린다"**는 것이다. `INCR`이 5,000번 일어나도 남는 것은 `5000`이라는 값 하나이고, 그 5,000건이 각각 언제 누가 어떤 콘텐츠를 봤는지는 어디에도 없다. 그래서 값이 사라지면 복구할 근거가 없다.

트래픽이 더 크거나 유실을 더 줄여야 하면 **조회 이벤트 자체를 Kafka에 흘린다.**

```
[조회 이벤트] -> [Kafka: view-events 토픽]  ← 원본 이벤트가 보존된다
                        │
       ┌────────────────┴────────────────┐
       ▼                                 ▼
[스트림 집계]                      [원본 로그 적재]
 윈도우(10초) 단위로 합산            객체 저장소·데이터 웨어하우스
       │                                 │
       ▼                                 ▼
[DB upsert]                        [정산·분석 배치 재집계]
 화면 표시용                          정확성이 필요한 용도 (3-6)
```

이 구성이 사는 것은 셋이다.

**첫째, 원본이 남으므로 재집계가 가능하다.** 집계 단계가 죽어도 오프셋을 되돌려 다시 처리하면 된다(6장 19번 문서 — 대량 재처리). 유실 걱정이 "재집계 시간" 문제로 바뀐다.

**둘째, 파티션 소유권이 단일 처리자를 자동으로 보장한다.** 2-8에서 분산 락이 필요했던 이유가 사라진다. 콘텐츠 id를 파티션 키로 쓰면 같은 콘텐츠의 이벤트는 항상 같은 파티션으로 가고, 한 파티션은 컨슈머 그룹 안에서 한 컨슈머만 읽는다(6장 03번 문서). **애플리케이션이 상호 배제를 구현하는 대신 메시징 계층의 구조가 그것을 준다.**

**셋째, 표시용과 정산용을 같은 원본에서 갈라 만들 수 있다.** 이것이 3-6에서 핵심이 된다.

대가는 운영 복잡도다. Kafka 클러스터, 컨슈머 그룹, 컨슈머 랙 관리(6장 16번 문서)가 전부 새로 생긴다. **그래서 순서는 언제나 Redis 버퍼링이 먼저이고, "원본 이벤트가 필요하다"는 요구가 생겼을 때 Kafka로 간다.**

## 3. 좋아요는 조회수와 다르다 — 요구사항이 파이프라인을 가른다

여기서 이 질문의 진짜 주제가 드러난다. 조회수와 좋아요는 겉보기에 같은 "카운트"다. 둘 다 숫자 하나를 화면에 보여 준다. 그런데 **요구사항이 다르고, 그 차이가 파이프라인 구조를 완전히 다르게 만든다.**

### 3-1. 요구사항을 나란히 놓고 보기

무엇이 다른지 기능 요구 차원에서 하나씩 짚자.

**조회수에 필요한 것은 합계뿐이다.** 화면에 "조회 1,234만"을 띄우면 끝이다. **"내가 이 웹툰을 봤는지"를 조회수 기능이 알아야 할 이유가 없다.** 같은 사람이 열 번 봐도 열 번 세는 것이 오히려 자연스럽다(그것을 막고 싶다면 그때는 유니크 카운트라는 다른 요구가 된다 — 3-5).

**좋아요에는 세 가지가 더 필요하다.**

첫째, **내가 누른 상태를 화면에 표시해야 한다.** 하트가 채워져 있는지 비어 있는지를 사용자별로 알아야 하므로, "누가 눌렀는지"를 저장하지 않으면 이 요구를 만족시킬 방법이 없다.

둘째, **두 번 눌러도 1이어야 한다.** 같은 사용자가 두 번 누르면 두 번째는 무시되어야 한다. 이것을 판정하려면 "이 사용자가 이미 눌렀는지"를 알아야 한다.

셋째, **취소가 가능해야 한다.** 취소는 카운트를 1 줄이는 일인데, **누가 눌렀는지를 모르면 "누른 적 없는 사람의 취소"를 막을 수 없다.** 누른 적 없는 사람이 취소를 열 번 호출하면 카운트가 마이너스로 간다.

정리하면 이렇다.

| 항목 | 조회수 | 좋아요 |
|---|---|---|
| 필요한 데이터 | **합계만** | **누가 눌렀는지** + 합계 |
| 오차 허용 | 몇 개 틀려도 됨 (근사치) | 안 됨 — 내가 누른 게 사라지면 버그 |
| 사용자별 기록 | 불필요 | **필수** (내 상태 표시, 중복 방지, 취소) |
| 같은 요청 반복 | 반복해서 세는 것이 자연 | **한 번만 세야 한다** (멱등성 요구) |
| 유실 시 | 재집계 or 수용 | 데이터 손실 사고 |
| 발생 빈도 | 조회마다 (초당 수천) | 드물다 (조회의 수십~수백분의 1) |

마지막 줄이 설계 여지를 만든다. **좋아요는 조회보다 훨씬 드물기 때문에 동기 DB 쓰기를 감당할 수 있다.** 조회수는 그럴 수 없어서 write-behind가 필수였지만, 좋아요는 선택의 여지가 있다.

### 3-2. 그래서 구조가 다르다 — 카운트는 파생 데이터다

위 요구사항에서 구조가 자동으로 결정된다. **좋아요의 원본은 "누가 눌렀나"라는 관계 데이터이고, 좋아요 개수는 그 관계로부터 파생된 값이다.**

두 구조를 나란히 그려 보면 차이가 분명하다.

```
[조회수 — 카운터가 원본이다]

    조회 이벤트 ──> Redis INCR ──> 배치 ──> DB view_count
                                            (이 숫자 자체가 진실)

    * 원본이 카운터이므로, 카운터가 틀리면 바로잡을 근거가 없다.
      그래서 "몇 개 틀려도 된다"는 합의가 반드시 선행되어야 한다.


[좋아요 — 관계가 원본이고 카운트는 파생물이다]

    좋아요 클릭
        │
        ▼
    DB content_like (user_id, content_id)   ← ★ 진실의 원천 (동기 쓰기)
        │   PRIMARY KEY (user_id, content_id) 가 중복을 막는다
        │
        ├──> 실제로 새로 들어갔을 때만 카운트를 +1
        │        │
        │        ▼
        │    Redis like:count:123 ──> 배치 ──> DB like_count
        │                                       (파생 캐시 — 틀리면 재계산 가능)
        │
        └──> "내가 눌렀는지" 조회는 관계에서 직접 읽는다

    * 카운트가 틀려도 관계 데이터로 SELECT count(*) 해서 복원할 수 있다.
      이것이 조회수와의 결정적 차이다.
```

**"카운트가 틀리면 재계산할 수 있다"**는 성질이 이 구조의 값이다. 정합성 사고가 났을 때 조회수는 손을 쓸 수 없지만 좋아요는 다음 SQL 한 줄로 복원된다.

```sql
-- 좋아요 카운트 정합성 보정 배치 (예: 하루 한 번)
-- 관계 데이터가 원본이므로 언제든 여기서 진실을 다시 계산할 수 있다.
UPDATE webtoon_stats s
   SET like_count = t.cnt,
       updated_at = now()
  FROM (SELECT content_id, count(*) AS cnt
          FROM content_like
         GROUP BY content_id) t
 WHERE s.webtoon_id = t.content_id
   AND s.like_count <> t.cnt;   -- 실제로 어긋난 행만 갱신한다 (죽은 튜플 절약)
```

여기서 일반화할 수 있는 원칙이 하나 나온다. **집계는 파생 데이터이고, 원본은 사실 기록이다.** 이 분리가 있으면 집계 계층에서 무슨 일이 나도 복구할 수 있고, 없으면 집계가 곧 원본이라 틀린 것을 알 방법조차 없다. 10장 13번 문서(감사와 append-only 설계)가 돈 도메인에서 같은 이야기를 한다 — **"지금 상태"를 덮어쓰는 모델은 "어떻게 여기까지 왔는가"에 답하지 못한다.**

### 3-3. 연타는 멱등성 문제다 — DB로 막기

"좋아요 버튼을 따닥 눌러서 카운트가 2가 되는" 문제는 UI 버그처럼 보이지만 **멱등성 문제**다.

**멱등성(idempotency)**은 "같은 작업을 여러 번 실행해도 결과가 한 번 실행한 것과 같은 성질"이다. 좋아요는 본질적으로 멱등해야 하는 연산이다 — 사용자가 같은 콘텐츠에 좋아요를 열 번 요청해도 최종 상태는 "좋아요 1개"여야 한다.

그리고 연타는 이 문제가 드러나는 여러 경로 중 하나일 뿐이다. **네트워크 재시도, 브라우저 새로고침, 모바일 앱의 자동 재요청, 게이트웨이의 타임아웃 재시도**가 모두 같은 요청을 두 번 보낸다. 그래서 프런트엔드에서 버튼을 비활성화하는 것은 완화책이고 근본 대책이 아니다.

애플리케이션 레벨 검사는 왜 안 되는지 보자.

```java
// Before: 조회 후 분기 — 동시 요청 두 건이 나란히 통과한다
@Transactional
public void like(Long userId, Long contentId) {
    if (likeRepository.existsBy(userId, contentId)) {   // ①
        return;
    }
    likeRepository.insert(userId, contentId);            // ②
    statsRepository.incrementLikeCount(contentId);       // ③
}
```

```
스레드 A: ① exists? -> false
스레드 B: ① exists? -> false      <- A가 아직 ②를 안 했으므로 B도 false를 본다
스레드 A: ② INSERT (성공)
스레드 B: ② INSERT (성공)          <- 제약이 없으면 두 행이 들어간다
스레드 A: ③ like_count + 1
스레드 B: ③ like_count + 1         <- 카운트가 2가 됐다
```

**"확인하고 행동한다(check-then-act)"는 두 걸음 사이에 틈이 있다.** 그 틈을 없애려면 확인과 선점이 한 걸음이어야 하고, 그것을 원자적으로 해 주는 곳이 DB다.

```sql
CREATE TABLE content_like (
    user_id    bigint      NOT NULL,
    content_id bigint      NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- 이 복합 PK가 멱등성의 근거다. 애플리케이션이 아니라 DB가
    -- 쓰기 시점에 원자적으로 "이미 있는가"를 판정한다.
    PRIMARY KEY (user_id, content_id)
);
-- 콘텐츠 기준 조회("이 웹툰을 좋아한 사람들", 카운트 재계산)를 위한 인덱스.
-- PK는 (user_id, content_id) 순서라 content_id 단독 조건에 쓰이지 않는다.
CREATE INDEX idx_like_content ON content_like (content_id);
```

```java
// After: INSERT를 먼저 시도하고, 실제로 들어갔는지로 판정한다
@Transactional
public LikeResult like(Long userId, Long contentId) {
    int inserted = likeRepository.insertIfAbsent(userId, contentId);
    // insertIfAbsent =
    //   INSERT INTO content_like (user_id, content_id) VALUES (?, ?)
    //   ON CONFLICT (user_id, content_id) DO NOTHING
    //
    // ON CONFLICT DO NOTHING을 쓰는 이유: 그냥 INSERT하면 중복 시 예외가 나고,
    // 예외는 트랜잭션을 오염시켜 이후 쿼리가 전부 실패한다. 중복은 오류가 아니라
    // 정상적으로 예상되는 상황이므로 예외 없이 흡수하는 것이 맞다.

    if (inserted == 0) {
        // 이미 눌렀던 사용자다. 카운터를 건드리지 않고 성공으로 응답한다.
        // 실패로 응답하면 클라이언트가 재시도해 같은 상황을 반복한다.
        return LikeResult.alreadyLiked();
    }

    // 실제로 새 행이 들어간 이 경로에서만 카운터를 올린다.
    // 즉 "카운터 증가"가 "관계 삽입 성공"에 종속되어 있다 —
    // 이 종속 관계가 카운트와 관계 데이터의 정합성을 유지하는 장치다.
    redis.opsForValue().increment("like:delta:" + contentId);
    redis.opsForSet().add("like:dirty", contentId.toString());
    return LikeResult.liked();
}
```

취소도 같은 원리다. **"삭제가 실제로 일어났는지"로 판정한다.**

```java
@Transactional
public LikeResult unlike(Long userId, Long contentId) {
    int deleted = likeRepository.delete(userId, contentId);
    // DELETE FROM content_like WHERE user_id = ? AND content_id = ?
    // 반환값은 삭제된 행 수다. 없던 행을 지우려 하면 0이 온다.

    if (deleted == 0) {
        // 누른 적 없는 사용자의 취소 요청이다. 카운터를 내리지 않는다.
        // 이 판정이 없으면 취소를 반복 호출해 카운트를 마이너스로 만들 수 있다.
        return LikeResult.notLiked();
    }
    redis.opsForValue().decrement("like:delta:" + contentId);
    redis.opsForSet().add("like:dirty", contentId.toString());
    return LikeResult.unliked();
}
```

이 두 코드의 공통 구조를 한 문장으로 말할 수 있어야 한다. **원본(관계 데이터)의 변경이 실제로 일어났는지를 DB가 판정하게 하고, 그 판정 결과에만 카운터 변경을 매단다.** 카운터만 있고 원본이 없으면 이 판정을 애플리케이션 로직으로 해야 해서 반드시 구멍이 난다.

(주의: `like:delta`는 음수가 될 수 있으므로 2-5의 배치 SQL에서 `d > 0` 필터를 쓰면 안 된다. 좋아요 flush에는 `d != 0` 조건을 쓰고, `like_count`가 음수로 내려가지 않도록 `GREATEST(s.like_count + EXCLUDED.like_count, 0)`을 씌우는 방어를 함께 둔다.)

### 3-4. Redis 쪽에서의 멱등 처리 — SADD의 반환값

DB 동기 쓰기가 부담스러운 규모라면(예: 대형 이벤트에서 좋아요가 초당 수만 건) 좋아요 판정 자체를 Redis로 올릴 수 있다. 이때 쓰는 것이 **Set의 멱등한 성질**이다.

`SADD`는 **집합에 실제로 새로 추가된 멤버 수를 반환한다.** 이미 있는 멤버를 추가하면 0을 반환한다. 즉 `SADD` 한 번으로 "이미 눌렀는가" 판정과 "누른 것으로 기록" 두 가지가 원자적으로 끝난다.

```
SADD like:users:123 user:777   -> 1   (새로 추가됨 = 처음 누른 것)
SADD like:users:123 user:777   -> 0   (이미 있음 = 두 번째 클릭)
```

그런데 여기서 **자바 코드로 두 걸음을 밟으면 안 된다.**

```java
// Before: SADD와 INCR이 두 명령으로 나뉘어 있다
Long added = redis.opsForSet().add("like:users:" + contentId, userId.toString());
if (added != null && added == 1L) {
    redis.opsForValue().increment("like:count:" + contentId);
}
// SADD가 성공한 직후 이 인스턴스가 죽으면? 집합에는 들어갔는데 카운트는 안 올랐다.
// 그리고 그 사용자는 이미 "누른 상태"이므로 다시 눌러도 SADD가 0을 반환해
// 카운트가 영구히 1 모자란 상태로 남는다.
```

두 명령을 한 덩어리로 묶는다. 5장 22번 문서의 Lua 스크립트가 정확히 이 용도다.

```lua
-- like_once.lua
-- KEYS[1] = 누른 사용자 집합,  KEYS[2] = 카운트 키
-- ARGV[1] = userId
-- 반환: 1 = 이번에 새로 눌렀다, 0 = 이미 누른 상태였다
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 1 then
  redis.call('INCR', KEYS[2])
end
return added
-- 이 스크립트 전체가 원자적이다. SADD와 INCR 사이에 다른 클라이언트가
-- 끼어들 수 없고, 중간에 인스턴스가 죽어도 절반만 반영된 상태가 남지 않는다.
```

```java
// After: 판정과 카운트 증가가 한 걸음이다
private static final RedisScript<Long> LIKE_ONCE =
        RedisScript.of(new ClassPathResource("redis/like_once.lua"), Long.class);

public LikeResult like(Long userId, Long contentId) {
    // 두 키를 {} 해시 태그로 묶는다. Redis Cluster에서 한 스크립트가 만지는 키들은
    // 같은 슬롯(= 같은 노드)에 있어야 하고, 해시 태그가 그것을 강제하는 장치다.
    List<String> keys = List.of(
            "like:{webtoon:" + contentId + "}:users",
            "like:{webtoon:" + contentId + "}:count");

    Long added = redis.execute(LIKE_ONCE, keys, userId.toString());
    if (added == null || added == 0L) {
        return LikeResult.alreadyLiked();
    }
    // 원본(관계)을 DB에 영속화하는 일은 비동기로 미룬다.
    // Redis 집합은 표시·판정용 캐시이고, 진실의 원천은 여전히 DB의 관계 테이블이다.
    likeEventPublisher.publish(new LikeEvent(userId, contentId));
    return LikeResult.liked();
}
```

**이 구조에서 반드시 짚어야 할 한계**가 있다. Redis 집합은 휘발성이므로 그것만으로는 "누가 눌렀는지"의 진실이 될 수 없다. 그래서 원본은 여전히 DB의 관계 테이블이고, Redis는 그 앞단의 판정 캐시다. Redis가 죽으면 집합이 사라지지만 DB 관계 테이블이 남아 있으므로 복원이 가능하다 — **3-2에서 세운 "원본은 관계, 카운트는 파생" 구조가 여기서도 안전망 역할을 한다.**

그리고 대형 콘텐츠의 좋아요 사용자 집합은 멤버 수가 수백만이 될 수 있다. 이것이 5장 23번 문서가 다루는 **빅 키(big key)** 문제다 — 큰 집합을 `DEL`하면 그 시간만큼 Redis 전체가 멈추므로 `UNLINK`를 쓰고, 메모리 압박이 오면 콘텐츠별로 TTL을 두어 오래된 집합은 DB에서 다시 채우게 한다.

### 3-5. 유니크 사용자 수가 필요하면 — HyperLogLog

"조회수"가 아니라 **"몇 명이 봤는가"**를 요구하는 경우가 있다. 이때 정확한 답을 원하면 방문자 id를 전부 저장해야 하고, 메모리가 방문자 수에 비례해 커진다. 인기작 하나에 일일 방문자 500만이면 그 집합 하나가 수백 MB다.

**HyperLogLog**는 멤버를 저장하지 않고 해시 관측의 통계만 남겨 **12KB 고정 메모리로 표준오차 약 0.81%의 근사 유니크 카운트**를 준다(5장 25번 문서). 방문자가 100명이든 1억 명이든 12KB다.

```java
// PFADD: 방문자를 넣는다. 이미 있는 방문자를 또 넣어도 카운트가 늘지 않는다.
redis.opsForHyperLogLog().add("uv:webtoon:123:20260901", userId.toString());

// PFCOUNT: 근사 유니크 수를 읽는다.
long uv = redis.opsForHyperLogLog().size("uv:webtoon:123:20260901");

// PFMERGE: 일별 HLL을 합쳐 주간·월간 UV를 만든다.
// 날짜별 집합을 단순 합산하면 중복 방문자가 여러 번 세어지지만,
// HLL은 병합해도 유니크 성질이 유지된다 — 이것이 HLL의 결정적 이점이다.
redis.opsForHyperLogLog().union("uv:webtoon:123:week36",
        "uv:webtoon:123:20260901", "uv:webtoon:123:20260902" /* ... */);
```

**대가는 두 가지다.** 정확한 값이 아니라 약 0.81% 오차가 있다는 것, 그리고 **"누가 왔는지"는 물을 수 없다**는 것이다. 개수만 알 수 있다. 그래서 "이 사용자가 이 회차를 봤는지"를 판정해야 하는 이어보기 기능에는 쓸 수 없다.

이것은 이 문서 전체와 같은 계열의 트레이드오프다. **정확도를 조금 팔아 자원을 크게 아끼는 것** — 그리고 그 거래를 할 수 있는지는 다시 요구사항에 달려 있다.

### 3-6. 이 집계가 정산(돈)에 쓰이면 설계가 완전히 달라진다

지금까지의 모든 설계는 **"몇 건 틀려도 된다"는 합의 위에 세워졌다.** 그 합의가 깨지는 순간이 있다. **작가 정산이다.**

조회수가 작가에게 지급할 금액의 근거가 되면 허용 오차가 0에 수렴한다. 그러면 2절의 파이프라인은 **전부 무효**다. 무엇이 왜 무효인지 하나씩 짚자.

**첫째, Redis의 미반영 구간 유실이 곧 돈의 유실이다.** 2-7에서 "월 유실률 0.0004%"라고 계산한 그 값이, 정산에서는 "작가에게 덜 지급한 금액"이 된다. 0.0004%든 얼마든, **"우리 시스템이 조회수를 조금 잃었습니다"는 지급 근거로 성립하지 않는다.**

**둘째, 재계산할 근거가 없다.** 2-10에서 말한 대로 카운터 방식은 합쳐진 숫자만 남기고 원본을 버린다. 정산 금액에 이견이 생기면 "이 숫자가 왜 이 값인지"를 증명해야 하는데, 증명할 재료가 없다.

**셋째, 어뷰징 필터를 적용할 수 없다.** 같은 IP에서 반복 조회, 봇 트래픽, 자동 스크립트를 걸러내려면 **개별 조회 이벤트의 속성**(IP, 사용자, 시각, 디바이스)이 필요하다. `INCR`은 그 정보를 남기지 않는다.

그래서 정산용 설계는 **카운터가 아니라 원장(ledger)**이 된다. 원장은 회계에서 온 말로, **일어난 일을 삭제·수정 없이 순서대로 계속 덧붙여 기록하는 장부**다. 10장 13번 문서가 다루는 append-only 설계와 같은 구조다.

```
[표시용 파이프라인 — 실시간·근사]           [정산용 파이프라인 — 배치·정확]

조회 이벤트                                조회 이벤트
   │                                          │
   ▼                                          ▼
Redis INCR (버퍼)                       Kafka view-events (원본 보존)
   │                                          │
   ▼                                          ▼
10초 배치 upsert                        객체 저장소에 원본 적재 (불변)
   │                                          │
   ▼                                          ▼
webtoon_stats.view_count                일 단위 정산 배치
   │                                          │  ① 어뷰징 필터 (IP·빈도·디바이스)
   ▼                                          │  ② 유니크·중복 판정
화면 "조회 1,234만"                       │  ③ 멱등하게 재집계
                                              ▼
                                        settlement_ledger (append-only)
                                              │
                                              ▼
                                        지급 금액 산정

  * 두 경로는 같은 조회 이벤트에서 갈라지지만 결과 숫자는 다르다.
    표시용은 어뷰징을 포함한 총 조회, 정산용은 필터를 통과한 유효 조회다.
```

정산 배치가 갖춰야 할 성질을 짚어 두자.

**멱등성.** 정산 배치는 반드시 두 번 돌게 된다 — 장애 후 재실행, 데이터 보정, 로직 수정 후 소급 재계산. 그래서 **같은 기간을 다시 계산해도 결과가 같아야 한다.** 카운터 방식(`+ delta`)은 두 번 돌면 두 배가 되므로 이 요구를 만족할 수 없다. 원본 이벤트를 조건으로 재집계하는 방식이라야 몇 번 돌려도 같은 값이 나온다.

```sql
-- 정산 원장: 기록은 추가만 하고 고치지 않는다.
CREATE TABLE settlement_ledger (
    id           bigserial   PRIMARY KEY,
    author_id    bigint      NOT NULL,
    webtoon_id   bigint      NOT NULL,
    period       date        NOT NULL,   -- 정산 대상 일자
    valid_views  bigint      NOT NULL,   -- 어뷰징 필터를 통과한 유효 조회 수
    amount       numeric(18,2) NOT NULL, -- 지급액 (돈은 부동소수 금지 — 10장 11번 문서)
    calc_version int         NOT NULL,   -- 어느 버전의 집계 로직으로 계산했는가
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- 같은 기간·같은 작품에 같은 버전의 계산이 두 번 들어가는 것을 DB가 막는다.
    -- 배치를 두 번 돌려도 두 번째는 이 제약에 걸려 흡수된다 = 멱등하다.
    UNIQUE (webtoon_id, period, calc_version)
);
-- 로직을 수정해 소급 재계산할 때는 기존 행을 UPDATE하지 않고
-- calc_version을 올려 새 행을 넣는다. 그러면 "왜 금액이 바뀌었는지"가
-- 두 행의 차이로 남아 감사에 답할 수 있다.
```

**추적성.** "이 작가에게 이번 달 얼마를 왜 지급했는지"를 이벤트 단위까지 되짚을 수 있어야 한다. 원본 이벤트가 객체 저장소에 남아 있고 원장에 계산 버전이 기록되어 있으면 이것이 가능하다.

**운영 디테일 하나까지 챙기면 좋다.** 표시용 숫자(1,234만)와 정산 근거 숫자(유효 조회)가 다르므로, 작가가 정산 화면과 작품 페이지의 숫자를 비교하면 반드시 문의가 들어온다. 그래서 **정산 화면에 "표시 조회수와 정산 기준 조회수는 어뷰징 필터 적용 여부로 다를 수 있음"을 명시**하고, 가능하면 두 숫자를 나란히 보여 준다. 기술 설계로 정합성을 만드는 것과, 두 숫자가 다른 이유를 사용자에게 설명하는 것은 별개의 일이다.

이 절의 결론을 한 문장으로 말하면 이렇다. **같은 "조회수"라는 숫자라도 용도가 다르면 다른 파이프라인이 필요하다.** 요구사항이 아키텍처를 결정한다는 이 질문의 출제 의도에 대한 정면 답변이 이것이다.

## 4. 꼬리질문 대비 포인트

### "Redis가 죽으면 아직 반영 안 된 조회수는 유실되잖아요?"

맞다. 그리고 **그것을 비즈니스와 먼저 협상하는 것이 이 설계의 일부**라고 답한다(2-7).

물어야 할 질문은 "장애 시 최근 T초치 조회수 유실이 허용되는가?"다. 대부분의 서비스에서 조회수는 허용되고, **그 합의가 있어야 write-behind라는 카드 자체가 성립한다.** 허용되지 않으면 다른 설계로 가야 한다.

그리고 유실량을 정직하게 제시할 수 있어야 한다. T=10초, 유입 10,000건/초, 월 1회 페일오버라면 월 유실 10만 건이고, 월 전체 조회 259억 건에 대해 **약 0.0004%**다. "60만 건 사라진다"와 "0.0004% 사라진다"는 같은 사실인데 협상에서는 후자로 말해야 한다.

허용 폭을 줄여야 한다면 비용 순서로 올라간다. ① **flush 주기 단축** — 코드 변경 없이 T만 줄인다. ② **Redis AOF 영속화** — `appendfsync everysec`이면 최대 1초치만 잃는다(5장 08번 문서). ③ **Kafka에 원본 이벤트 보존** — 재집계가 가능해지므로 유실 걱정이 재처리 시간 문제로 바뀐다.

**"유실 0"이 진짜 요구라면 그것은 조회수가 아니라 정산용 데이터**이므로 카운터가 아닌 원장 방식으로 가야 한다고 답한다(3-6).

### "인기 웹툰 딱 하나에 트래픽이 몰리면 Redis 키 하나가 병목이 되지 않나요?"

된다. 그리고 **1절의 DB 핫 로우 문제를 Redis에서 다시 만난 것**이라는 구조 인식을 보여 주는 것이 이 질문의 핵심이다(2-9).

Redis도 키 하나에 대한 명령은 한 노드의 싱글 스레드에서 하나씩 처리된다. **Redis Cluster를 써도 해결되지 않는다** — 분산의 단위가 키이므로 노드를 100대로 늘려도 키 하나의 부하는 쪼개지지 않는다(5장 13번 문서).

다만 자리수가 다르다는 점을 짚어야 한다. PostgreSQL 한 행은 수백 건/초, Redis 한 키는 수만~수십만 건/초다. **이 자리수 차이가 write-behind가 성립하는 이유이고, 그래서 초당 수천 수준에서는 단일 키로 충분하다.** 문제가 되는 것은 초당 수십만 규모다.

해법은 1절과 **같은 원리** — 하나를 쪼개고 읽을 때 합산한다. `view:delta:123:s0` ~ `:s15`처럼 키를 N개로 나눠 무작위로 `INCR`하고 읽을 때 `MGET`으로 합산한다. 이때 **`{}` 해시 태그를 쓰지 않아야** 키들이 다른 슬롯으로 흩어진다는 실무 디테일까지 말하면 좋다.

대가는 명확하다. 쓰기 부하는 N분의 1이 되지만 **읽기 비용이 N배**가 된다. 그래서 합산 결과를 짧은 TTL로 한 번 더 캐시하고, 샤딩은 핫 키로 판명된 소수 콘텐츠에만 적용한다.

### "flush 스케줄러가 여러 서버에서 동시에 돌면 중복 반영되지 않나요?"

`@Scheduled`는 그 JVM 안의 타이머이므로 인스턴스가 N대면 N번 돈다. 이 함정과 해법(ShedLock, 리더 선출, 쿠버네티스 CronJob 분리, `pg_try_advisory_xact_lock`)은 **04번 문서 3-3에 정리되어 있으므로 그것을 적용한다**고 답하고, 조회수 flush에 특유한 지점으로 넘어가는 것이 좋다(2-8).

특유한 지점은 이것이다. **증가분을 더하는 방식이라 순서는 상관없지만 중복 반영은 그대로 오차가 된다.** 그래서 이 작업에서 정말 필요한 것은 상호 배제가 아니라 **원자적 회수**다.

`GETDEL`(또는 `GETSET`)이 그 역할을 한다. 두 인스턴스가 동시에 flush를 시작해도 같은 키에 `GETDEL`이 성공하는 것은 한쪽뿐이고 다른 쪽은 `null`을 받아 건너뛴다. **원자적 회수가 갖춰져 있으면 락 없이도 중복 반영이 나지 않는다.**

그러면 락은 왜 두는가 — **불필요한 DB 왕복과 커넥션 점유를 줄이고, 실패 시 되돌리기의 추론을 단순하게 하기 위해서**다. 정합성의 근거는 원자적 회수이고 락은 효율 장치라는 순서를 밝히면 이해의 깊이가 드러난다. 04번 문서가 말한 "분산 락은 정확히 한 번을 보장하지 않으므로 작업 자체가 원자적이거나 멱등해야 한다"는 원칙과 같은 이야기다.

**아예 flush를 Kafka 컨슈머로 옮기면** 파티션 소유권이 단일 처리자를 자동으로 보장하므로 락이 필요 없어진다(2-10). 애플리케이션이 상호 배제를 구현하는 대신 메시징 계층의 구조가 그것을 주는 것이다.

### "좋아요 버튼 연타(따닥)로 카운트가 어긋나는 건 어떻게 막나요?"

**멱등성 문제**로 규정하는 것부터 시작한다(3-3). 연타는 여러 경로 중 하나일 뿐이고, 네트워크 재시도·새로고침·게이트웨이 재시도가 모두 같은 요청을 두 번 보낸다. 그래서 프런트엔드 버튼 비활성화는 완화책이고 근본 대책이 아니다.

근본 대책은 **원본이 관계 테이블이기 때문에 막힌다**는 구조에서 나온다. `PRIMARY KEY (user_id, content_id)`가 두 번째 `INSERT`를 거부하고, 그 판정이 애플리케이션이 아니라 **DB 안에서 쓰기 시점에 원자적으로** 일어난다.

여기서 반드시 대비해서 말해야 할 것이 **애플리케이션 레벨 `exists()` 검사가 왜 안 되는지**다. 동시 요청 두 건이 나란히 `false`를 보고 둘 다 통과한다 — check-then-act의 틈이다. 그래서 조회 후 분기가 아니라 **`INSERT ... ON CONFLICT DO NOTHING`을 먼저 시도하고 삽입된 행 수로 판정**한다.

그리고 취소에도 같은 원리가 필요하다는 점까지 말하면 좋다. `DELETE`의 반환 행 수가 0이면 누른 적 없는 사용자의 취소이므로 카운터를 내리지 않는다. **이 판정이 없으면 취소를 반복 호출해 카운트를 마이너스로 만들 수 있다.**

**카운터만 있고 원본이 없으면** 이 판정을 애플리케이션 로직으로 해야 해서 반드시 구멍이 난다. "집계는 파생 데이터, 원본은 사실 기록"이라는 분리가 정합성의 근거임을 다시 강조할 기회다(3-2). Redis 쪽에서 판정해야 하는 규모라면 `SADD`의 반환값(새로 추가된 멤버 수)을 쓰고, `SADD`와 `INCR`을 **Lua 스크립트로 한 덩어리로 묶어야** 절반만 반영된 상태가 남지 않는다(3-4).

### "이 집계가 작가 정산(돈)에 쓰인다면 설계가 어떻게 달라지나요?" (시니어 변별 포인트)

허용 오차가 0에 수렴하므로 **2절의 근사 파이프라인은 전부 무효**라고 단언하는 것에서 시작한다(3-6). 무엇이 왜 무효인지를 셋으로 정리한다.

① **Redis 미반영 구간의 유실이 곧 돈의 유실이다.** 0.0004%라는 수치가 정산에서는 "작가에게 덜 지급한 금액"이 되고, "시스템이 조회수를 조금 잃었습니다"는 지급 근거로 성립하지 않는다.
② **재계산할 근거가 없다.** 카운터는 합쳐진 숫자만 남기고 원본을 버리므로, 금액에 이견이 생겼을 때 증명할 재료가 없다.
③ **어뷰징 필터를 적용할 수 없다.** 동일 IP 반복 조회·봇을 걸러내려면 개별 이벤트의 속성(IP·사용자·시각·디바이스)이 필요한데 `INCR`은 그것을 남기지 않는다.

그래서 답은 **화면 표시용(실시간·근사)과 정산용(배치·정확)을 분리**하고, 정산용은 **카운터가 아니라 원장 방식**으로 가는 것이다. 조회 이벤트 원본을 Kafka와 객체 저장소에 불변으로 남기고, 일 단위 배치가 어뷰징 필터를 거쳐 **멱등하게 재집계**한 값을 append-only 원장에 기록한다(10장 13번 문서와 같은 구조).

멱등성이 왜 필수인지를 말하면 깊이가 드러난다. **정산 배치는 반드시 두 번 돌게 된다** — 장애 후 재실행, 데이터 보정, 로직 수정 후 소급 재계산. 카운터 방식(`+ delta`)은 두 번 돌면 두 배가 되므로 이 요구를 원리적으로 만족할 수 없다. 원본 이벤트를 조건으로 재집계하는 방식이라야 몇 번 돌려도 같은 값이 나오고, `UNIQUE (webtoon_id, period, calc_version)` 같은 제약으로 중복 기록을 DB가 막게 한다.

운영 디테일까지 얹으면 가산점 포인트다. **표시용 숫자와 정산 기준 숫자가 다르므로 작가 문의가 반드시 온다.** 정산 화면에 "어뷰징 필터 적용 여부로 표시 조회수와 다를 수 있음"을 명시하고 두 숫자를 나란히 보여 준다. 그리고 로직을 수정해 소급 재계산할 때는 기존 원장 행을 `UPDATE`하지 않고 `calc_version`을 올려 새 행을 넣어, **"왜 금액이 바뀌었는지"가 두 행의 차이로 남게** 한다.

---

## 한 줄 요약

조회수 집계의 정답은 특정 기술이 아니라, **PostgreSQL에서 같은 행을 갱신하는 트랜잭션은 행 잠금으로 직렬화되므로 잠금 보유 시간 2ms가 그 행의 상한을 초당 500건으로 못 박고 서버를 늘려도 그 숫자가 변하지 않는다는 사실**에서 출발해, **"조회수가 몇 초 늦고 몇 건 사라져도 되는가"라는 비즈니스 합의로 허용 오차를 확보한 뒤 그만큼을 write-behind로 사는 것**이다 — 조회는 Redis `INCR`로 흡수하고 `GETDEL`로 원자적으로 회수해(`GET` 후 `DEL`이면 그 틈의 증가분이 조용히 사라진다) `INSERT ... ON CONFLICT DO UPDATE` 한 문장으로 반영하며, flush 주기는 "5초에서 60초로 늘리면 DB 쓰기는 12분의 1, 유실 창은 12배"라는 계산 위에서 정하고, 핫 키는 DB에서 쫓아낸 문제가 Redis에서 다시 나타난 것이므로 같은 원리(쪼개고 합산)로 풀며, **좋아요는 "누가 눌렀는지"가 필요해서 관계 테이블이 원본이고 카운트는 파생물이라는 다른 구조를 가지고**(그래서 유니크 제약이 연타라는 멱등성 문제의 근본 해법이 된다), **이 숫자가 정산에 쓰이는 순간 근사 파이프라인은 전부 무효가 되어 원본 이벤트를 남겨 멱등하게 재집계하는 원장 방식으로 갈아타야 한다**는 것까지가 완성형이다.
