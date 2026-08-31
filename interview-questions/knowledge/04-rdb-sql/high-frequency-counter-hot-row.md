# 초고빈도 카운터와 핫 로우 — "대략 맞으면 되는 숫자"를 RDB 행 하나에 직렬화시키지 않는다

> 핵심 관전 포인트: **조회수 +1을 조회 트랜잭션 안에서 같은 행에 UPDATE하면,
> 그 행의 배타 락(X 락)이 커밋까지 유지되므로 수천 개의 "동시" 요청이
> 락 대기 큐에 한 줄로 서서 직렬화된다 — 그 행의 초당 갱신 상한은 대략
> `1 / 락 보유 시간`이고 서버를 늘려도 안 오른다. 줄 선 트랜잭션은 커넥션을
> 쥔 채 기다리므로 풀이 고갈되고, 조회수와 무관한 로그인·결제 API까지 커넥션을
> 못 얻어 장애가 된다. 락 뒤에는 쓰기 증폭이 따라온다 — UPDATE 한 번마다
> undo·redo·binlog가 쓰이고, `view_count`에 정렬용 세컨더리 인덱스가 있으면
> 엔트리가 삭제·재삽입되며, 같은 행 갱신은 리플리카에서도 병렬화가 안 돼
> 복제 지연이 쌓인다. 설계의 출발점은 기술이 아니라 도메인 판단이다 — 웹툰
> 조회수는 "대략 맞으면 되는 숫자"라서 Redis `INCR` 버퍼 + 주기 배치 반영으로
> DB 쓰기를 수백~수천분의 1로 줄이고, 그 대가인 유실 창(반영 주기 × 초당
> 증가량)과 Redis 의존을 비즈니스와 협상한다. 결제 잔액처럼 "정확해야 하는
> 숫자"는 같은 설계를 쓰면 안 된다. 그리고 유실을 "허용"했다면 반드시 유실을
> "측정"해야 한다 — 멱등한 flush 배치, 원천 로그 대비 대사(reconciliation)
> 배치, 드리프트 알람까지가 한 세트다.**

---

## 0. 질문 + 의도

**질문**: "웹툰 에피소드 조회수 같은 초고빈도 카운터 갱신을 RDB에 직접 하면
어떤 문제가 있나요? 어떻게 설계하겠습니까?"

**출제 의도**: rationale은 이렇게 적고 있다 — "같은 행 UPDATE의 락 직렬화라는
병목을 인식하고, 버퍼링·배치 반영·근사치 허용 같은 완화책과 그 대가(실시간성,
유실 가능성)를 비즈니스와 협상하는 능력. 웹툰 조회수는 정확히 이 문제라 도메인
적합성 검증이기도 하다." 즉 이 문항은 세 가지를 동시에 잰다. ① 문제를
"성능 저하"가 아니라 **이름 붙은 메커니즘 사슬**로 말할 수 있는가 ② 완화책
하나하나의 **대가를 같은 호흡에** 붙일 수 있는가 ③ "이 숫자는 얼마나 정확해야
하는가"라는 **도메인 판단**에서 설계를 출발시키는가. 고난이도 문항은
트레이드오프 서술 자체가 채점 대상이라, 완화책을 나열만 하고 대가를 안 붙이면
중급 답변으로 내려간다.

> 이 문서는 사전 학습용이다. 4장 기본 Q4에서 핫 로우 질문에 "성능 저하"로
> 뭉뚱그린 뒤 힌트를 받고서야 "락 경합"이라는 **이름 하나에만 도달**했고,
> 락 경합 이후의 사슬은 면접관이 보충했다. 그래서 이 문서는 §1에서 **락 경합
> "다음"에 무슨 일이 이어지는지**를 두 갈래(동시성 사슬 / 쓰기 증폭 사슬)로
> 가장 자세히 다루고, §2에서 완화 전략 목록과 각각의 "얻는 것 / 내는 것"을
> 표로 고정하며, §3에서 "유실 허용"을 "유실 측정"으로 닫는 안전망을 코드로
> 보여준다. 기본 Q4 문서
> [`normalization-vs-denormalization.md` §3](normalization-vs-denormalization.md)의
> 다섯 고리 사슬을 알고 있다는 전제에서 그 뒤를 잇는다.

---

## 1. 문제 — 같은 행 UPDATE 하나가 어떻게 전 서비스 장애가 되나

### 1-1. before — 조회 API 안의 `@Transactional` + 더티 체킹

가장 흔한 첫 구현이다. 에피소드를 읽어서 응답을 만들고, 그 김에 조회수도
1 올린다.

```java
// ❌ BEFORE — 조회 트랜잭션이 곧 쓰기 트랜잭션
@Service
@RequiredArgsConstructor
public class EpisodeService {

    private final EpisodeRepository episodeRepository;

    @Transactional                                   // ① 쓰기 트랜잭션 — 커넥션을 빌린다
    public EpisodeResponse view(Long episodeId) {
        Episode episode = episodeRepository.findById(episodeId).orElseThrow();  // ② SELECT (스냅샷 읽기)
        episode.increaseViewCount();                 // ③ 자바에서 view_count = 읽은 값 + 1
        return EpisodeResponse.from(episode);        // ④ 이미지 URL 목록 등 응답 조립 (지연 로딩이 끼면 더 길어진다)
    }   // ⑤ 커밋 직전 flush → UPDATE episode SET view_count = ?, ... WHERE id = ?
        //    → 행 X 락 획득 → redo 기록 → 커밋(fsync) → 락 해제
}
```

이 코드에는 문제가 세 겹으로 겹쳐 있다.

- **lost update**: ②는 스냅샷을 읽고 ③은 자바에서 더한다. 같은 순간 100을
  읽은 두 트랜잭션이 각각 101을 쓴다 — 락은 "덮어쓰는 순서"만 정해줄 뿐 "읽은
  값이 낡았다"는 사실은 알려주지 않는다. 조회수가 실제보다 적게 잡히는데,
  아무 예외도 안 난다.
- **조회 트랜잭션이 쓰기 트랜잭션이 된다**: `readOnly = true`를 못 쓰므로
  리드 리플리카로 보낼 수 없다 — 모든 에피소드 조회가 프라이머리로 몰린다
  ([`read-replica-routing-and-lag.md`](../03-jpa-orm/read-replica-routing-and-lag.md)).
  조회수 하나 때문에 읽기 분산 구조 전체가 무력화된다.
- **핫 로우(hot row)**: 신작 공개 직후 특정 에피소드 하나에 조회가 집중된다.
  수천 개 요청이 전부 **같은 행 하나**를 UPDATE한다. 이 셋 중 이것이
  장애를 만든다. 아래에서 두 갈래로 쪼갠다.

### 1-2. 사슬 A — 동시성: 행 X 락에서 무관한 API 장애까지

"락 경합"은 사슬의 **첫 고리 이름**이지 설명이 아니다. 고리를 하나씩
끊어서 말할 수 있어야 한다.

```text
⑴ 같은 행 UPDATE
   → 모든 요청이 episode.id = 신작 1화, 단 하나의 행을 갱신한다
      ↓
⑵ 행 X 락(배타 락) 직렬화
   → InnoDB의 UPDATE는 그 행의 레코드 락을 배타 모드로 잡고 "커밋까지" 유지한다.
     배타 락은 한 번에 하나만 통과시키므로 동시성이 1로 붕괴한다.
     그 행의 초당 갱신 상한 ≈ 1 / (락 획득 → UPDATE 실행 → redo fsync → 커밋 → 락 해제) 시간.
     락 보유가 2ms면 초당 500건이 벽이다. 앱 서버를 10대 → 100대로 늘려도 벽은 그대로다.
      ↓
⑶ 락 대기 큐 적체
   → 벽을 넘는 요청은 InnoDB 락 대기 큐에 선다. 유입이 처리 상한보다 크면 큐는 계속 자란다.
     innodb_lock_wait_timeout(기본 50초)까지는 "실패"가 아니라 "대기"다 — 그래서 더 위험하다.
      ↓
⑷ 트랜잭션 지연 — 대기가 대기를 키운다
   → 줄 뒤의 트랜잭션은 앞선 전원의 락 보유 시간을 합친 만큼 늦어진다.
     그리고 자기가 잡은 다른 락도 그만큼 오래 쥔다. 지연이 지연을 낳는다.
      ↓
⑸ 커넥션 점유
   → 락을 기다리는 트랜잭션은 DB 커넥션을 "쥔 채로" 기다린다. 대기 중인 커넥션은
     아무 일도 안 하면서 풀의 한 자리를 차지한다.
      ↓
⑹ 커넥션 풀 고갈
   → 풀 크기(예: 20)만큼의 트랜잭션이 전부 같은 행을 기다리면 풀은 비어 있는데 꽉 차 있다.
     HikariCP의 getConnection()이 connection-timeout(기본 30초)까지 대기한다.
      ↓
⑺ 무관한 API 장애 (전파)
   → 커넥션 풀은 서비스 전체가 공유한다. 로그인, 결제, 다른 웹툰 목록 조회 —
     조회수와 아무 상관없는 요청이 커넥션을 못 얻어 타임아웃된다.
     톰캣 스레드까지 커넥션 대기에 묶이면 헬스체크마저 실패해 인스턴스가 교체되기 시작한다.
```

⑵에서 ⑺까지를 한 문장으로 묶으면 — **행 하나의 배타 락이 서비스 전체의
동시성을 1로 만든다.** 병목이 CPU도 디스크도 아니고 "행 하나"라서 인프라
증설이 통하지 않는다는 점이 이 사슬의 핵심이다. ⑸ 이후는 4장 중급
[`connection-count-vs-throughput.md`](connection-count-vs-throughput.md)와
2장 [`hikaricp-connection-pool-exhaustion.md`](../02-spring/hikaricp-connection-pool-exhaustion.md)에서
다룬 "대기 줄이 DB 안에 서면 비싸다"의 정확히 그 상황이다.

### 1-3. 사슬 B — 쓰기 증폭: UPDATE 한 번이 디스크에 남기는 것들

락이 없다고 가정해도(예: 샤딩 카운터로 경합을 나눠도) 남는 비용이 있다.
"조회수 +1"은 논리적으로 8바이트 하나를 고치는 일이지만 InnoDB 안에서는
쓰기가 여러 곳에 증폭된다.

```text
UPDATE episode SET view_count = view_count + 1 WHERE id = ?  (초당 N번)
  │
  ├─ ⓐ undo 로그: 갱신 전 버전을 undo 페이지에 기록 (롤백 + MVCC용).
  │     그 행의 버전 체인이 매초 N개씩 자란다. 긴 조회 트랜잭션이 하나라도
  │     열려 있으면 purge가 못 지워 체인이 수천 개로 — 그 행을 "읽는" 쿼리마다
  │     체인 순회 비용 (→ mvcc-innodb.md §3 사슬)
  │
  ├─ ⓑ redo 로그(WAL): 변경분을 redo 버퍼에 쓰고, 커밋마다 fsync
  │     (innodb_flush_log_at_trx_commit=1). 순차 쓰기라 싸지만 "커밋 횟수"가
  │     곧 fsync 횟수다. 그룹 커밋이 묶어주지만 같은 행은 직렬이라 못 묶인다.
  │
  ├─ ⓒ binlog: 행 기반 복제면 UPDATE 한 번 = 이벤트 하나 (sync_binlog=1이면 또 fsync).
  │     초당 N개의 이벤트가 리플리카로 흘러간다.
  │
  ├─ ⓓ 세컨더리 인덱스 엔트리 이동: "인기순 정렬" 하려고 view_count에 인덱스를
  │     걸어뒀다면, 값이 바뀔 때마다 옛 엔트리 delete-mark + 새 엔트리 insert.
  │     B+Tree의 다른 위치로 이동하므로 페이지 분할·단편화가 따라온다.
  │     (→ clustered-vs-secondary-index.md §2)
  │
  ├─ ⓔ 버퍼 풀 더티 페이지: 그 행이 있는 데이터 페이지·undo 페이지·인덱스 페이지가
  │     계속 더티 상태 → 체크포인트/플러시 압박
  │
  └─ ⓕ 복제 지연: 리플리카는 binlog 이벤트를 재생하는데, "같은 행"에 대한
        변경은 의존 관계가 있어 멀티 스레드 applier로도 병렬화가 안 된다.
        프라이머리에서 직렬이던 것이 리플리카에서도 직렬 → 지연 누적 →
        리플리카에서 읽는 다른 화면들이 낡은 데이터를 보여준다
```

이 갈래가 중요한 이유는 §2의 전략 평가 기준이 되기 때문이다 — **샤딩
카운터는 사슬 A(경합)만 나누고 사슬 B(쓰기 총량)는 그대로 둔다. Redis
버퍼링은 A와 B를 동시에 줄인다.** 이 차이를 말할 수 있으면 "전략을 아는
것"에서 "전략의 비용 구조를 아는 것"으로 올라간다.

### 1-4. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 사슬로 말하면 |
|---|---|
| "성능이 저하된다" | 같은 행 배타 락에 직렬화 → 초당 상한 = 1/락 보유 시간 → 서버 증설 무효 |
| "락 경합이 일어난다" | 락 대기 큐 적체 → 트랜잭션 지연 → **커넥션을 쥔 채 대기** → 풀 고갈 |
| "다른 요청도 느려진다" | 풀은 전 서비스 공유 → 로그인·결제까지 커넥션 획득 타임아웃 → 전파 |
| "DB에 부하가 간다" | UPDATE마다 undo·redo·binlog 쓰기 + 인덱스 엔트리 이동 + 복제 지연 |

면접에서 "락 경합"까지 말했다면 그 다음 문장은 반드시 **"그 락을 기다리는
트랜잭션이 커넥션을 쥐고 있어서"** 여야 한다. 이 한 문장이 행 하나의 문제와
서비스 전체 장애를 잇는 다리다.

### 1-5. 원자적 UPDATE로 바꾸면? — 정확성은 잡히고 경합은 남는다

3장 [`concurrency-update-four-approaches.md`](../03-jpa-orm/concurrency-update-four-approaches.md)의
결론대로 "읽고 계산하고 쓰기"가 SQL 한 문장으로 압축되면 원자적 UPDATE가
기본값이다. 여기서도 첫 번째 개선은 그것이다.

```java
// 개선 1단계 — lost update 제거. 그러나 핫 로우 사슬은 그대로다
public interface EpisodeRepository extends JpaRepository<Episode, Long> {
    @Modifying(clearAutomatically = true)
    @Query("update Episode e set e.viewCount = e.viewCount + 1 where e.id = :id")
    int increaseViewCount(@Param("id") Long id);
}
```

얻는 것은 두 가지다 — 읽은 값에 의존하지 않으므로 **lost update가 사라지고**,
SELECT 후 자바 계산 없이 UPDATE 한 문장이라 **락 보유 시간이 짧아진다.**
그러나 초당 수천 요청이 **여전히 같은 행의 배타 락을 순서대로 잡는다.** 사슬
A의 ⑵~⑺과 사슬 B는 한 고리도 사라지지 않는다. "원자적 UPDATE로 해결했다"고
답하면 lost update와 핫 로우를 구분하지 못하는 것으로 읽힌다. 원자적 UPDATE는
**위생**이지 **처방**이 아니다.

---

## 2. 설계 — 판단 기준부터: 이 숫자는 얼마나 정확해야 하는가

### 2-1. "대략 맞으면 되는 숫자" vs "정확해야 하는 숫자"

기술 선택 전에 물어야 할 것은 세 축이다 — **정확도, 실시간성, 비용.** 셋을
동시에 최대로 가질 수는 없고, 어느 것을 얼마나 양보할지는 엔지니어가
혼자 정하는 게 아니라 **비즈니스와 협상**하는 것이다. 이 협상을 해 봤는지가
rationale이 말하는 "도메인 적합성 검증"이다.

| 숫자 | 정확도 요구 | 실시간성 요구 | 쓰기 양상 | 설계 방향 |
|---|---|---|---|---|
| 웹툰 조회수 | 근사 허용 — 0.1% 유실을 아무도 못 느낀다 | 분 단위면 충분 | 초고빈도, 특정 행 집중 | **버퍼 + 배치 반영** |
| 좋아요 수 | 합계는 근사, "내가 눌렀는지"는 정확 | 개인 상태 즉시, 합계 지연 OK | 고빈도 | 개인 상태는 행/SET에 정확히, 합계는 버퍼 |
| 재고 | 정확 — `qty >= 0` 불변식 | 즉시 | 이벤트성 집중 | 원자적 UPDATE + CHECK, 극단이면 Redis DECR 선점 (3장 §4-5) |
| 결제 잔액 | 정확, 유실 0, 감사 추적 | 즉시 | 계정별로 분산 — 핫 로우 자체가 드묾 | 원자적 UPDATE + 원장(append) — **버퍼링 금지** |

표 밖에서 판단 기준을 문장으로 고정한다.

- **틀려도 되는가**: 조회수가 1,000,352인지 1,000,340인지는 독자도 작가도
  구분 못 한다. 반면 잔액이 12원 비면 사고다. 유실을 허용할 수 없으면
  버퍼링은 선택지에서 빠진다.
- **늦어도 되는가**: 조회수는 1분 뒤에 반영돼도 아무도 모른다. 재고는
  "지금 살 수 있는가"라 지연이 곧 오버셀이다.
- **누가 대가를 지는가**: 유실·지연을 허용한 숫자는 "정확하지 않을 수 있다"는
  사실을 비즈니스가 알고 승인해야 한다. 정산·수익 배분에 조회수가 쓰인다면
  이야기가 달라진다 — 그때는 "화면에 보여주는 조회수"와 "정산용 조회수"를
  **분리**해서, 후자는 원천 로그에서 배치로 정확히 재계산한다.

이 문항에서 웹툰 조회수는 첫 번째 줄이다. 그래서 답의 골격은
"버퍼링 + 주기 반영"이고, 나머지는 그 대가를 어떻게 관리하느냐다.

### 2-2. 핫 로우 완화 전략 8종 — 얻는 것 / 내는 것

목록으로 인출할 수 있어야 한다. 전략 이름만이 아니라 **대가 열**을 같이
외운다.

| # | 전략 | 얻는 것 | 내는 것 | 유실 가능성 | 적합 |
|---|---|---|---|---|---|
| 1 | 원자적 UPDATE | lost update 제거, 락 보유 시간 단축 | 경합 사슬 A·B 그대로 | 0 | 기본 위생 (모든 경우) |
| 2 | UPDATE를 조회 트랜잭션에서 분리 | 조회는 `readOnly` → 리플리카로, 락 보유 최소 | 커밋 수·쓰기 증폭 동일 | 0 | 중간 빈도 |
| 3 | 샤딩 카운터 행 (N행) | 경합 1/N, DB만으로 해결 | 읽기 N행 SUM, 정렬·인덱스 불가, **쓰기 총량 동일**, N 변경 어려움 | 0 | 정확해야 하는데 경합이 큰 경우 |
| 4 | Redis `INCR` 버퍼 + 주기 배치 반영 | DB 쓰기 수백~수천분의 1, 락 0, 조회 read-only | 유실 창(주기 × TPS), Redis 의존, 이중 소스, flush 멱등성 숙제 | 주기 × 초당 증가량 | **조회수** |
| 5 | 앱 로컬 버퍼(`LongAdder`) + 주기 반영 | 네트워크 왕복 0 | 인스턴스 다운·배포마다 유실, 인스턴스별 합산 필요 | 4보다 큼 | 로그성 지표, 4의 앞단 |
| 6 | 이벤트 스트림 집계 (Kafka → 컨슈머 배치 집계) | 내구성, 재처리 가능, 다른 소비자(추천·정산) 공유 | 지연, at-least-once 중복 처리, 인프라 복잡도 | ≈0 (내구) | 집계가 다목적일 때 |
| 7 | 근사 자료구조 (HyperLogLog) | 메모리 상수 (유니크 방문자) | 오차 존재, 정확한 값은 영원히 없음 | — | UV, 유니크 조회자 |
| 8 | 표시 계층 캐시 | 읽기 부하 감소 | 표시 지연 | — | 다른 전략과 병행 |

각 줄을 문장으로 풀면 이렇다.

**2 — 트랜잭션 분리.** 조회는 `@Transactional(readOnly = true)`로 리플리카에서
읽고, 조회수 UPDATE는 응답 후 별도의 짧은 트랜잭션(또는 비동기)으로 보낸다.
조회 API가 쓰기에서 해방되는 것만으로 리플리카 라우팅이 살아난다. 그러나
UPDATE 자체는 초당 그대로 나가므로 핫 로우 사슬은 여전하다. `REQUIRES_NEW`로
같은 요청 안에서 분리하면 커넥션을 두 개 쥐는 셈이라 풀 고갈을 오히려
앞당긴다 — 분리하려면 **바깥 트랜잭션이 끝난 뒤**에 해야 한다.

**3 — 샤딩 카운터 행.** 1장의
[`longadder-false-sharing.md`](../01-java-kotlin/longadder-false-sharing.md)에서
본 "쓰기는 셀별로 분산, 읽기는 합산"의 DB 판이다. `LongAdder`가 CAS
경합 지점을 Cell 배열로 쪼갰듯, 행 하나를 N개 행으로 쪼갠다.

```sql
create table episode_view_shard (
    episode_id bigint not null,
    shard      tinyint not null,        -- 0..15
    cnt        bigint  not null default 0,
    primary key (episode_id, shard)
);

-- 쓰기: 무작위 샤드 하나에 +1 → 경합이 1/16
update episode_view_shard set cnt = cnt + 1 where episode_id = ? and shard = ?;

-- 읽기: 합산
select sum(cnt) from episode_view_shard where episode_id = ?;
```

얻는 것은 분명하다 — 사슬 A의 ⑵가 1/N로 완화되고, 외부 인프라 없이 DB만으로
**유실 0**을 유지한다. 내는 것도 분명하다 — 읽을 때마다 N행을 합산해야 하고,
"인기순 정렬"처럼 카운터 값으로 정렬·인덱스를 거는 것이 불가능해지며,
무엇보다 **사슬 B는 한 고리도 안 줄어든다.** 초당 5,000 UPDATE는 여전히
초당 5,000번의 undo·redo·binlog·커밋이다. 경합이 문제인지 쓰기 총량이
문제인지에 따라 이 전략의 가치가 달라진다.

**4 — Redis `INCR` 버퍼.** `INCR`/`HINCRBY`는 Redis가 단일 스레드로 명령을
실행하므로 락 없이 원자적이고, 메모리 연산이라 초당 수십만 건을 받는다.
N초마다 누적된 델타를 읽어 DB에 `view_count = view_count + Δ`로 **한 번**
반영하면, 초당 5,000건의 UPDATE가 1분에 한 번의 UPDATE(에피소드당 1행)로
줄어든다 — 사슬 A와 B가 동시에 1/300,000 수준으로 내려간다. 대가는
§2-4에서 따로 다룬다. 웹툰 조회수의 정답 방향이고, §2-3의 after 코드가
이것이다.

**5 — 앱 로컬 버퍼.** 4의 앞단에 `LongAdder`를 두고 몇 초에 한 번 Redis로
몰아 보내면 네트워크 왕복까지 줄일 수 있다. 그러나 인스턴스가 죽거나
배포로 내려가면 메모리의 델타가 통째로 사라진다 — 유실 창이 4보다 넓다.
graceful shutdown에서 마지막 flush를 보장하는 코드가 필요하고, 그것도
`kill -9`에는 무력하다. 조회수처럼 유실을 넓게 허용하는 곳이 아니면 쓰지
않는다.

**6 — 이벤트 스트림 집계.** 조회 한 건을 Kafka 이벤트로 발행하고, 컨슈머가
시간 창 단위로 집계해 DB에 반영한다. 4와 비교한 차이는 **내구성과
재처리 가능성**이다 — 브로커에 남아 있으니 컨슈머가 죽어도 유실이 없고,
집계 로직에 버그가 있어도 오프셋을 되감아 다시 계산할 수 있으며, 같은
이벤트를 추천·정산·통계가 함께 소비한다. 대가는 지연(브로커 → 컨슈머 →
집계 창 → 반영), at-least-once 전달이라 **중복 반영을 막는 멱등성 설계**가
필수라는 점, 그리고 Kafka 운영 비용이다. 조회수 하나를 위해 Kafka를
들이지는 않지만, 조회 로그가 이미 스트림으로 흐르는 조직이라면 자연스러운
선택이다. 파이프라인 상세는 7장 "조회수/좋아요 집계 파이프라인" 문서에서
다룬다 (`../07-traffic-performance/`, 작성 예정).

**7 — 근사 자료구조.** "이 에피소드를 본 유니크 독자 수"처럼 중복을 제거해야
하는 카운트는 정확히 세려면 독자 ID 집합을 통째로 들고 있어야 한다.
HyperLogLog(`PFADD`/`PFCOUNT`)는 키당 고정 12KB 안팎으로 1% 미만 오차의
근사치를 준다. 정확한 값은 영원히 얻을 수 없다는 것이 대가인데, 조회수
도메인에서는 그 대가가 거의 0이다. (가산점 포인트)

**8 — 표시 캐시.** 쓰기 문제와 별개로, 조회수를 보여주는 읽기 자체도
캐시한다. 4를 쓰면 Redis에 이미 최신 델타가 있으므로 "DB 기준값 + 미반영
델타"를 조합하거나, 그냥 분 단위 갱신값을 보여준다.

### 2-3. after — 웹툰 조회수: Redis 버퍼 + 멱등 flush

전략 4를 코드로 내린다. 세 부품이다 — **요청 경로의 버퍼**, **주기 flush**,
**flush의 멱등성 장치**.

```java
// ✅ AFTER ① 요청 경로 — 조회는 read-only, 카운트는 DB 트랜잭션 밖 자원에
@Service
@RequiredArgsConstructor
public class EpisodeService {

    private final EpisodeRepository episodeRepository;
    private final ViewCountBuffer viewCountBuffer;

    @Transactional(readOnly = true)                 // 리플리카로 라우팅 가능, 락 없음
    public EpisodeResponse view(Long episodeId) {
        Episode episode = episodeRepository.findById(episodeId).orElseThrow();
        viewCountBuffer.increment(episodeId);       // Redis HINCRBY — 실패해도 조회는 성공한다
        return EpisodeResponse.from(episode);
    }
}

@Component
@RequiredArgsConstructor
public class ViewCountBuffer {

    private final StringRedisTemplate redis;
    private final MeterRegistry meterRegistry;
    private final Clock clock;

    /** 1분 단위 버킷 키. 버킷을 시간으로 닫아야 flush 대상이 "더 이상 안 바뀌는 키"가 된다 */
    static String bucketKey(long bucket) {
        return "ep:views:" + bucket;
    }

    static long currentBucket(Instant now) {
        return now.getEpochSecond() / 60;
    }

    public void increment(Long episodeId) {
        try {
            redis.opsForHash().increment(
                bucketKey(currentBucket(clock.instant())), episodeId.toString(), 1);
        } catch (DataAccessException e) {
            // fail-open: 조회수 1건을 포기하고 조회 API는 살린다. 대신 포기한 만큼 센다 (§3)
            meterRegistry.counter("viewcount.buffer.failure").increment();
        }
    }
}
```

포인트는 세 가지다. ① 조회 트랜잭션에서 쓰기가 **완전히** 빠졌다 —
락도, undo/redo/binlog도, 리플리카 제약도 사라진다. ② Redis 호출은
`try/catch`로 **fail-open**이다 — 카운터 인프라 장애가 콘텐츠 조회 장애로
번지면 본말이 전도된다. ③ 키를 **시간 버킷**으로 나눈다 — "지금 쓰고 있는
키"와 "flush할 키"를 분리해야, 읽는 도중 들어온 증가분을 잃지 않는다.

```java
// ✅ AFTER ② 주기 flush — 닫힌 버킷만, 멱등하게
@Component
@RequiredArgsConstructor
public class ViewCountFlusher {

    private final StringRedisTemplate redis;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final Clock clock;

    private static final int LOOKBACK_BUCKETS = 10;   // 장애로 밀린 버킷도 따라잡는다

    @Scheduled(fixedDelay = 10_000)
    public void flush() {
        long current = ViewCountBuffer.currentBucket(clock.instant());
        // current-1 은 "방금 닫힌" 버킷 — 경계 직전에 키를 계산한 지각 쓰기가 아직 도착할 수 있어 한 칸 더 비운다
        for (long bucket = current - LOOKBACK_BUCKETS; bucket <= current - 2; bucket++) {
            flushBucket(bucket);
        }
    }

    void flushBucket(long bucket) {
        String key = ViewCountBuffer.bucketKey(bucket);
        Map<Object, Object> deltas = redis.opsForHash().entries(key);
        if (deltas.isEmpty()) return;

        Boolean applied = tx.execute(status -> {
            try {
                // ★ 멱등성의 핵심: "이 버킷은 반영했다"를 UPDATE와 같은 트랜잭션에 PK로 기록한다
                jdbc.update("insert into view_count_flush_log(bucket, total_delta, applied_at) values (?, ?, now())",
                    bucket, deltas.values().stream().mapToLong(v -> Long.parseLong((String) v)).sum());
            } catch (DuplicateKeyException alreadyApplied) {
                status.setRollbackOnly();           // 다른 인스턴스가 먼저 했거나, 지난 실행이 커밋 직후 죽었다
                return false;
            }
            jdbc.batchUpdate(
                "update episode set view_count = view_count + ? where id = ?",
                deltas.entrySet().stream()
                    .map(e -> new Object[]{ Long.parseLong((String) e.getValue()), Long.parseLong((String) e.getKey()) })
                    .toList());
            return true;
        });

        // 커밋 뒤에 삭제. 여기서 죽어도 다음 실행은 flush_log PK에 막혀 이중 반영이 불가능하다
        redis.delete(key);
    }
}
```

```sql
create table view_count_flush_log (
    bucket      bigint   primary key,   -- "마지막 반영 오프셋" 역할. 같은 버킷은 두 번 못 들어온다
    total_delta bigint   not null,      -- §3 대사 배치가 원천 로그와 비교할 때 쓴다
    applied_at  datetime not null
);
```

이 flush가 **왜 멱등한지**를 순서대로 말할 수 있어야 한다.

- **반영 여부의 기록이 반영 자체와 같은 트랜잭션에 있다.** flush_log INSERT와
  episode UPDATE가 함께 커밋되거나 함께 롤백된다. "UPDATE는 됐는데 기록이
  안 됐다"는 상태가 존재하지 않는다.
- **`bucket`이 PK다.** 인스턴스 3대가 동시에 같은 버킷을 집어도 INSERT는
  한 대만 성공한다 — 두 번째 인스턴스의 INSERT는 첫 번째의 커밋을 기다렸다가
  `DuplicateKeyException`을 받고 물러난다. DB의 유니크 제약이 조정자다
  ([`unique-constraint-concurrent-insert.md`](../03-jpa-orm/unique-constraint-concurrent-insert.md)와
  같은 원리). ShedLock을 얹으면 헛수고(불필요한 HGETALL)를 줄일 수 있지만
  **정합성은 ShedLock이 아니라 PK가 지킨다** — 분산 락은 최적화 장치라는 3장의
  결론이 여기서도 그대로다.
- **Redis 키 삭제는 커밋 뒤다.** 커밋과 삭제 사이에 프로세스가 죽으면 다음
  실행이 같은 델타를 다시 읽지만, flush_log PK에 막혀 반영은 건너뛰고 삭제만
  한다. 반대로 삭제를 먼저 하고 커밋 전에 죽으면 델타가 영원히 사라진다 —
  순서를 바꾸면 안 되는 이유다.
- **버킷 마감 유예.** `current - 2`까지만 flush하는 이유는, 59.999초에
  `currentBucket()`을 계산한 요청의 `HINCRBY`가 00.001초에 도착할 수 있기
  때문이다. 1분의 유예를 두면 실질적으로 지각 쓰기가 없다. 유예를 넘긴
  지각 쓰기는 이론상 유실인데, 이것까지 "유실 상한"에 포함해 말하면 된다.

### 2-4. 이 설계가 내는 대가 — 반드시 같은 호흡으로

after를 말한 뒤 대가를 붙이지 않으면 고난이도 문항에서 감점이다. 이
설계의 대가는 네 가지다.

**① 유실 창이 있다.** Redis가 죽거나 데이터를 잃으면 **아직 flush되지 않은
버킷**이 사라진다. 상한은 계산 가능하다 — `(flush 주기 + 마감 유예) × 초당
증가량`. 위 설정이면 최대 약 3분치, 초당 5,000건인 에피소드라면 약 90만 건이
최악의 유실이다. "얼마나 잃을 수 있는가"를 숫자로 말하고, 그 숫자를
비즈니스가 승인했는지가 협상의 실체다. 상한을 줄이는 손잡이는 flush 주기
단축(DB 쓰기 증가와 교환), Redis AOF `everysec`(디스크 쓰기와 교환),
Redis 복제(인프라 비용과 교환)다 — 전부 또 다른 트레이드오프다.

**② 실시간성이 떨어진다.** DB의 `view_count`는 최대 몇 분 낡아 있다. 화면에
"방금 내가 본 것"이 즉시 +1로 보여야 한다면 DB 값이 아니라 "DB 값 + Redis
미반영 델타"를 조합하거나 Redis에 총계 키를 따로 유지해야 하고, 그러면
**진실의 원천이 둘**이 된다. 이중 소스는 반드시 어긋나므로 §3의 대사가
따라와야 한다.

**③ Redis가 장애 지점에 추가된다.** fail-open으로 조회 API는 지켰지만
카운터는 Redis 가용성에 종속된다. Redis 장애 = 그 시간 동안 조회수 0.
이걸 알람 없이 지나가면 "지난주 화요일 오후 조회수가 왜 비었죠"라는
질문을 나중에 받는다.

**④ 코드가 늘어난다.** before는 한 줄이었다. after는 버퍼, 스케줄러,
flush_log 테이블, 멱등성 규칙, 모니터링이 생겼다. 이 복잡도를 감당할 만큼
트래픽이 실제로 핫 로우를 만드는지 — **측정 없이 도입하면 과설계**다.
초당 수십 건이면 전략 1+2로 충분하다.

---

## 3. 안전망 — 유실을 "허용"했으면 유실을 "측정"한다

"조회수는 대략 맞으면 된다"는 말은 "얼마나 틀렸는지 모른다"와 다르다.
허용한 오차 안에 실제로 머물고 있는지를 **시스템이 계속 확인**해야, 어느 날
flush 배치가 조용히 멈춰 조회수가 하루 종일 0으로 남는 사고를 사람의 기억
대신 알람이 잡는다.

### 3-1. 대사(reconciliation) 배치 — 원천 대비 드리프트를 숫자로

웹툰 서비스에는 보통 조회 로그가 원천으로 따로 있다 — 추천·정산·통계를
위해 조회 한 건을 append-only 테이블(일 파티션)이나 스트림으로 남긴다.
그 원천을 기준으로 **"카운터에 반영된 양"과 "실제 일어난 양"의 차이**를
매일 잰다.

```sql
-- 어제 하루: 원천 로그로 센 실제 조회 수 (에피소드별)
with actual as (
    select episode_id, count(*) as actual_cnt
    from   episode_view_log partition (p20260830)
    group  by episode_id
),
-- 어제 하루: flush 배치가 DB에 반영한 델타 합 (flush_log의 버킷 범위로 자른다)
applied as (
    select episode_id, sum(delta) as applied_cnt
    from   view_count_flush_detail            -- flush 시 에피소드별 델타를 남겨 두면 여기서 쓴다
    where  bucket between :day_start_bucket and :day_end_bucket
    group  by episode_id
)
select a.episode_id,
       a.actual_cnt,
       coalesce(p.applied_cnt, 0)                        as applied_cnt,
       a.actual_cnt - coalesce(p.applied_cnt, 0)         as drift,
       (a.actual_cnt - coalesce(p.applied_cnt, 0)) / a.actual_cnt as drift_ratio
from   actual a left join applied p on p.episode_id = a.episode_id
where  abs(a.actual_cnt - coalesce(p.applied_cnt, 0)) / a.actual_cnt > 0.01;   -- 1% 초과만
```

에피소드별 델타 상세를 남기지 않았다면 `view_count_flush_log.total_delta`의
일별 합과 원천 로그의 일별 총합만이라도 비교한다 — 전체 드리프트 비율
하나면 "flush가 멈췄다", "Redis가 30분 죽었다"는 사고를 잡기에 충분하다.
원천 로그가 아예 없다면 대사는 불가능하고, 그때는 §3-2의 관측 지표(버퍼
실패 건수, 미반영 버킷 수)가 유일한 안전망이라는 사실을 인정하고 말해야
한다.

**정정(correction)은 신중하게.** 드리프트가 크면 배치가 카운터를 고치는데,
절대값 `SET view_count = actual`은 위험하다 — 그 순간에도 flush가 델타를
더하고 있어서 정정과 flush가 경쟁한다. 안전한 형태는 "기준 버킷 B까지의
재계산값 + B 이후 flush_log에 기록된 델타"를 더하거나, 정정 시간 동안
flush를 멈추고(플래그) 진행하는 것이다. 정정을 자동화할지 사람이 승인할지도
비즈니스와 정한다.

### 3-2. 메트릭과 알람 — 결정을 코드로 고정

| 지표 | 의미 | 알람 기준 예 |
|---|---|---|
| `viewcount.buffer.failure` | fail-open으로 포기한 증가분 | 분당 N건 초과 |
| `viewcount.flush.lag` | 가장 오래된 미반영 버킷의 나이 | 5분 초과 (= flush가 멈췄다) |
| `viewcount.flush.pending_keys` | Redis에 남아 있는 버킷 키 수 | LOOKBACK 초과 (= 따라잡지 못한다) |
| `viewcount.flush.skipped` | flush_log PK 충돌로 건너뛴 횟수 | 지속 발생 시 스케줄러 중복 실행 점검 |
| `viewcount.drift_ratio` | 일 대사 결과 | 1% 초과 |

```java
// flush 지연을 시스템이 감시하게 만든다 — "누가 확인하겠지"를 없애는 코드
@Scheduled(fixedDelay = 30_000)
public void reportFlushLag() {
    long current = ViewCountBuffer.currentBucket(clock.instant());
    long oldestPending = LongStream.rangeClosed(current - LOOKBACK_BUCKETS, current - 2)
        .filter(b -> Boolean.TRUE.equals(redis.hasKey(ViewCountBuffer.bucketKey(b))))
        .findFirst().orElse(current);
    meterRegistry.gauge("viewcount.flush.lag.minutes", current - oldestPending);
}
```

### 3-3. 테스트 — 멱등성을 회귀 테스트로 고정

flush를 두 번 호출해도 한 번만 반영된다는 규칙은 코드 리뷰가 아니라
테스트가 지켜야 한다.

```java
@Test
void 같은_버킷을_두_번_flush해도_한_번만_반영된다() {
    long bucket = 1_000L;
    redis.opsForHash().increment(ViewCountBuffer.bucketKey(bucket), "42", 7);

    flusher.flushBucket(bucket);
    // 커밋 직후 죽어 Redis 삭제가 안 된 상황을 재현
    redis.opsForHash().increment(ViewCountBuffer.bucketKey(bucket), "42", 7);
    flusher.flushBucket(bucket);

    assertThat(jdbc.queryForObject("select view_count from episode where id = 42", Long.class))
        .isEqualTo(7L);   // 14가 아니다
}

@Test
void 인스턴스_두_대가_같은_버킷을_동시에_flush해도_한_번만_반영된다() throws Exception {
    long bucket = 2_000L;
    redis.opsForHash().increment(ViewCountBuffer.bucketKey(bucket), "42", 5);

    CountDownLatch ready = new CountDownLatch(2);
    CountDownLatch go = new CountDownLatch(1);
    Runnable worker = () -> { ready.countDown(); await(go); flusher.flushBucket(bucket); };
    var pool = Executors.newFixedThreadPool(2);
    pool.submit(worker); pool.submit(worker);
    ready.await(); go.countDown();
    pool.shutdown(); pool.awaitTermination(10, TimeUnit.SECONDS);

    assertThat(jdbc.queryForObject("select view_count from episode where id = 42", Long.class))
        .isEqualTo(5L);
}
```

---

## 4. 꼬리질문 대비 포인트

### "원자적 UPDATE(`view_count = view_count + 1`)로 바꾸면 해결되는 것 아닌가요?"

두 문제를 분리해서 답한다. 원자적 UPDATE가 해결하는 것은 **lost update**다 —
읽은 값에 의존하지 않으므로 동시 갱신이 서로를 덮어쓰지 않고, SELECT 후
자바 계산이 없어 락 보유 시간도 짧아진다. 그러나 **핫 로우는 그대로**다.
초당 수천 요청이 여전히 같은 행의 배타 락을 순서대로 잡으므로 그 행의 초당
상한은 여전히 `1 / 락 보유 시간`이고, 락 대기 → 커넥션 점유 → 풀 고갈 →
전파 사슬도, undo·redo·binlog·복제 지연이라는 쓰기 증폭도 한 고리도 안
사라진다. 원자적 UPDATE는 "정확성 위생"이고 핫 로우 처방은 "쓰기 지점을
행에서 떼어내는 것"이라 층이 다르다. 그래서 답은 "그것부터 하고, 그 위에
버퍼링을 얹는다"다.

### "Redis로 버퍼링하면 조회수가 유실될 수 있잖아요. 얼마나, 그리고 괜찮은가요?"

"괜찮다"가 아니라 **상한을 숫자로** 말한다. 유실 창은 `(flush 주기 + 버킷
마감 유예) × 초당 증가량`이고, 유실이 일어나는 조건은 Redis 장애·재시작으로
미반영 버킷을 잃는 경우와 fail-open으로 포기한 증가분이다. 예를 들어 1분
버킷 + 1분 유예 + 10초 주기면 최악 약 3분치다. 그 다음 문장은 도메인
판단이다 — 웹툰 조회수는 화면 표시용이라 이 손실을 아무도 감지하지 못하고,
정산에 쓰이는 숫자라면 원천 로그에서 배치로 정확히 재계산하는 별도 경로를
둔다. 그리고 "허용"으로 끝내지 않는다 — 대사 배치가 매일 원천 대비
드리프트를 재고, 1%를 넘으면 알람이 울리며, `buffer.failure`와 `flush.lag`
지표가 유실이 실제로 일어나는 순간을 잡는다. 유실 상한을 낮추고 싶으면
주기 단축·AOF·복제라는 손잡이가 있고 각각 DB 쓰기·디스크·인프라 비용과
교환된다는 것까지 붙이면 완성이다.

### "flush 배치가 인스턴스 3대에서 동시에 돌거나, 반영 도중 죽으면 어떻게 되나요?" (시니어 변별 포인트)

멱등성을 세 층으로 답한다. ① **반영 기록과 반영이 같은 트랜잭션**이다 —
`view_count_flush_log(bucket PK)` INSERT와 episode UPDATE가 함께 커밋되므로
"반영은 됐는데 기록이 없다"는 상태가 없다. ② **PK가 조정자**다 — 3대가
같은 버킷을 집어도 INSERT는 한 대만 성공하고, 나머지는 첫 번째의 커밋을
기다렸다가 중복 키로 물러난다. ShedLock은 헛수고를 줄이는 최적화이지
정합성 장치가 아니다. ③ **Redis 삭제는 커밋 뒤**다 — 커밋과 삭제 사이에
죽으면 다음 실행이 같은 델타를 다시 읽지만 PK에 막혀 건너뛰고 삭제만 한다.
순서를 뒤집어 삭제를 먼저 하면 커밋 전 장애에서 델타가 영구 유실된다.
이 세 층을 회귀 테스트(같은 버킷 2회 flush → 1회 반영, 2스레드 동시 flush →
1회 반영)로 고정해 두었다고까지 말하면, 안전망을 사람의 기억이 아니라
시스템에 두는 습관이 드러난다.

### "그럼 결제 잔액이나 재고도 같은 방식으로 Redis에 모았다 반영하면 되지 않나요?" (시니어 변별 포인트)

안 된다 — 그리고 **이유를 도메인 축으로** 말한다. 이 설계가 성립하는 전제는
"틀려도 되고 늦어도 된다"인데, 잔액은 유실 0·즉시 반영·감사 추적이 요구되고
`잔액 >= 0` 같은 불변식은 DB 제약이 지켜야 한다. Redis에 버퍼링하는 순간
불변식이 DB 밖으로 나가고, Redis 장애 시 "돈이 사라지는" 유실 창이 생긴다.
게다가 쓰기 양상이 다르다 — 잔액은 계정별로 분산돼 있어 핫 로우가 드물고,
재고는 이벤트성으로 집중되지만 정확해야 하므로 원자적 UPDATE + `CHECK` 제약이
기본이며, 초당 5만 같은 극단에서는 Redis `DECR`로 **선점**하되 최종 확정은
여전히 DB 제약이 하는 구조로 간다(3장 §4-5). 즉 같은 Redis라도 조회수에서는
"버퍼(진실은 나중에 DB)", 재고에서는 "선점 게이트(진실은 즉시 DB)"로 역할이
다르다. 이 구분을 못 하면 도구를 알고 도메인은 모르는 것으로 읽힌다.

### "'인기순' 정렬을 위해 `view_count`에 인덱스를 걸어두면 어떻게 되나요?" (가산점 포인트)

핫 로우 문제가 인덱스로 번진다. 세컨더리 인덱스는 값 순서로 정렬된 별도
B+Tree라서, `view_count`가 바뀔 때마다 옛 위치의 엔트리를 delete-mark하고
새 위치에 삽입한다 — 초당 수천 번의 인덱스 엔트리 이동, 페이지 분할, 그리고
그 인덱스 페이지들이 계속 더티 상태로 버퍼 풀을 점유한다. 게다가
"인기순"은 대개 최근 기간 기준이라 누적 조회수 인덱스로는 답이 안 나온다.
처방은 정렬을 카운터 행에서 떼어내는 것이다 — 버퍼링으로 DB UPDATE가
분당 1회로 줄면 인덱스 이동도 분당 1회라 견딜 만하고, 더 정석은 인기 순위를
Redis Sorted Set(`ZINCRBY`)이나 주기 집계 테이블로 따로 관리해 `episode`
테이블의 `view_count`에는 인덱스를 아예 두지 않는 것이다. 샤딩 카운터 행을
골랐다면 정렬 자체가 불가능해진다는 대가도 여기서 다시 등장한다.

---

## 한 줄 요약

초고빈도 카운터를 RDB 행 하나에 직접 UPDATE하면 그 행의 배타 락이 모든
요청을 직렬화해 초당 상한을 `1/락 보유 시간`에 묶고, 락을 기다리는
트랜잭션이 커넥션을 쥔 채 풀을 고갈시켜 무관한 API까지 무너뜨리며, 그 뒤로
undo·redo·binlog·인덱스 이동·복제 지연이라는 쓰기 증폭이 따라온다 — 그래서
"이 숫자는 얼마나 정확해야 하는가"를 먼저 묻고, 웹툰 조회수처럼 대략
맞으면 되는 숫자는 Redis `INCR` 버퍼 + 시간 버킷 + PK로 멱등한 flush로
DB 쓰기를 수천분의 1로 줄이되, 유실 상한을 숫자로 말하고 대사 배치와
드리프트 알람으로 그 상한을 시스템이 감시하게 하며, 결제 잔액처럼 정확해야
하는 숫자에는 같은 설계를 절대 쓰지 않는다.
