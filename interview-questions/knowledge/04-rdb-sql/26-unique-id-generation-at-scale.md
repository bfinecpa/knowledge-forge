# 대용량 유니크 채번 설계 — "주문번호"와 "PK"는 다른 물건이고, 답은 4방식의 트레이드오프 조립이다

> 핵심 관전 포인트: **채번 질문의 정답은 방식 이름이 아니라 요구사항을
> 쪼개는 순서다. 먼저 "내부 PK(조인·인덱스의 축)"와 "외부 주문번호(고객·
> CS·정산이 부르는 업무 식별자)"를 분리한다 — 두 식별자에 걸리는 요구가
> 다르기 때문이다. 내부 PK는 ① 작고(8바이트) ② 단조 증가(맨 끝 append →
> 순차 I/O)해야 하므로 후보는 Auto Increment 또는 Snowflake이고,
> 단일 DB면 Auto Increment, 샤딩·INSERT 전 ID 필요·다중 리전이면
> Snowflake다. UUID v4는 무작위 삽입 위치 → 페이지 분할 → 전 리프가
> 워킹셋 → 버퍼 풀 오염 → INSERT마다 디스크 랜덤 읽기의 사슬 때문에
> 클러스터드 PK로는 실격이고, UUID v7은 정렬성은 회복하지만 16바이트라는
> 곱셈 계수는 남는다. 외부 주문번호는 채번 테이블(+블록 할당, 별도 짧은
> 트랜잭션)로 날짜·채널 같은 업무 의미를 담아 만들되 유니크 제약을 최후
> 방어선으로 둔다. 그리고 각 방식이 내는 대가 — Auto Increment의 단일
> 노드 의존과 연속 번호 노출, 채번 테이블의 핫 로우 직렬화와 재기동 시
> 구멍, Snowflake의 시계 역행·워커 ID 배포, UUID v7의 크기와 생성 시각
> 노출 — 를 얻는 것과 같은 호흡에 붙여 말해야 고난이도 답이 된다.**

---

## 0. 질문 + 의도

**질문**: "유니크 채번(주문번호 등)을 대용량 트래픽에서 어떻게
설계하나요? (Auto Increment 한계, Snowflake, 채번 테이블, UUID v7 비교)"

**출제 의도**: rationale은 이 문항을 이렇게 설명한다 — "Auto Increment의
한계(샤딩, 노출 위험)에서 출발해 Snowflake/UUID v7의 트레이드오프(정렬성,
인덱스 지역성)까지 — **작은 주제 하나에 분산 시스템 지식이 압축돼 있어
깊이 측정에 효율적이다.**" 채점 지점은 셋이다. ⑴ 각 방식이 "왜" 빠르고
"왜" 막히는지를 스토리지 엔진(클러스터드 인덱스)과 분산 시스템(시계·조율)
두 층의 메커니즘으로 설명하는가 ⑵ 4방식을 같은 축으로 비교하고 각각의
대가를 붙이는가 ⑶ "주문번호"라는 단어에 숨은 두 요구(내부 식별 vs 외부
노출)를 분리해 설계로 착지시키는가.

**이 문서가 특히 겨냥하는 네 지점** (4장 기본 구간에서 반복된 패턴):

- **비용을 이름 붙은 사슬로** — "UUID는 인덱스에 안 좋다"에서 멈추지
  않는다. 무작위 키가 왜 랜덤 I/O가 되고 단조 증가 키가 왜 순차 I/O가
  되는지, 채번 테이블이 왜 핫 로우가 되는지, Auto Increment가 왜 단일
  노드에 묶이는지를 고리 하나씩 말한다(§1, §2).
- **트레이드오프를 양면으로** — 고난이도는 트레이드오프 서술이 곧 평가
  대상이다. 4방식 각각에 "얻는 것 / 내는 것"을 한 쌍으로 붙인다(§2 각 절
  말미의 대차대조표).
- **안전망을 코드로 고정** — 시계 역행 감지, 워커 ID 충돌 방지, 유니크
  제약 + 충돌 재시도, 블록 할당의 구멍 허용 정책 명문화, 동시성 채번
  테스트 — "조심하면 된다"가 아니라 사람이 기억하지 않아도 작동하는
  코드로 둔다(§4).
- **목록 인출** — 4방식 비교표(축: 정렬성·분산성·크기·노출·의존성)와
  선택 기준 6가지를 세트로 꺼낸다(§3). 결론은 항상 "PK와 주문번호
  분리"로 착지한다(§4).

**옆 문항과의 경계**:
[클러스터드 vs 세컨더리 인덱스](./03-clustered-vs-secondary-index.md)는
PK 설계 2원칙(작게·단조 증가)과 페이지 분할·버퍼 풀 오염 사슬의 원형을
다뤘다 — 이 문서는 그 원칙을 전제로 "그러면 어떤 채번 방식이 그 원칙을
만족하며 분산 환경까지 확장되는가"를 다룬다.
[대량 INSERT와 JDBC batch](../03-jpa-orm/21-bulk-insert-jdbc-batch.md)는
`IDENTITY`가 쓰기 지연을 무력화하는 메커니즘과 `allocationSize`, 그리고
"외부 채번은 배치가 느릴 때의 답이 아니다"를 다뤘다 — 이 문서는 그
문서가 "정당한 경우"로 남겨 둔 **분산 ID가 실제로 요구사항인 상황**의
설계다. 두 문서의 내용은 링크로 갈음하고 반복하지 않는다.

---

## 1. 먼저 요구를 쪼갠다 — "유니크 채번"에 숨은 여섯 가지 성질

"주문번호를 어떻게 채번하나요"라는 질문에 방식 이름부터 대면 감점이다.
"유니크"는 최소 조건일 뿐이고, 실제 설계는 아래 여섯 성질 중 **무엇을
어디까지 요구하느냐**로 갈린다.

1. **유일성** — 전역에서 절대 겹치지 않는가. 겹치면 어디서 걸러지는가.
2. **정렬성(시간 순)** — 나중에 만든 ID가 더 큰가. 클러스터드 인덱스의
   삽입 위치와 "최근 주문순" 정렬이 이것에 걸린다.
3. **분산 생성 가능성** — DB 한 대에 물어보지 않고 여러 인스턴스·여러
   리전·클라이언트에서 만들 수 있는가. INSERT 전에 ID를 알 수 있는가.
4. **노출 안전성** — 외부에 보여도 다음 번호·총량·증가율·생성 시각이
   새지 않는가.
5. **크기** — 8바이트인가 16바이트인가 36바이트 문자열인가. PK는 모든
   세컨더리 인덱스에 복제되는 곱셈 계수라서 크기는 곧 인덱스 총량이다.
6. **업무 의미(가독성)** — 날짜·채널 코드·체크 디짓을 담아 사람이 읽고
   불러줄 수 있어야 하는가.

이 여섯을 놓고 보면 **한 컬럼으로 전부 만족시키는 방식은 없다**는 게
바로 보인다. 정렬성·크기는 내부 PK가 원하는 성질이고, 노출 안전성·업무
의미는 외부 식별자가 원하는 성질이다. 그래서 결론은 정해져 있다 —
**내부 PK와 외부 주문번호를 분리하고, 각자에게 맞는 채번을 붙인다.**
이 결론을 먼저 말하고, 4방식은 "각 자리에 어떤 후보가 어울리는가"를
따지는 재료로 쓴다.

### 1-1. 등장인물의 이름을 먼저 고정한다 — 순차 I/O vs 랜덤 I/O

이 문서 전체를 관통하는 비용 모델이라 여기서 한 번 못 박는다.

- **순차 I/O**: 디스크(또는 SSD 블록)의 **이웃한 페이지를 이어서** 읽고
  쓰는 접근. 한 번 움직여 큰 덩어리를 처리하므로 페이지당 비용이 작다.
- **랜덤 I/O**: **흩어진 위치를 하나씩** 찾아가 읽고 쓰는 접근. 페이지
  한 장마다 위치 이동 비용을 따로 낸다. HDD에서는 수백 배, SSD에서도
  큐·캐시·쓰기 증폭 때문에 여전히 몇 배 이상 불리하다.
- **버퍼 풀**: 디스크 페이지를 담아두는 고정 크기 메모리 캐시. 필요한
  페이지가 여기 있으면 I/O가 없고, 없으면(캐시 미스) 디스크를 간다.
- **워킹셋**: 어떤 작업을 처리하는 동안 실제로 손대는 페이지들의 집합.
  워킹셋이 버퍼 풀보다 작으면 메모리 속도, 크면 캐시 미스가 상시 발생.

이제 질문은 이렇게 바뀐다 — **"이 채번 방식이 만드는 INSERT의 워킹셋은
몇 페이지인가, 그리고 그 페이지들은 디스크에서 이웃해 있는가."**

---

## 2. 4방식의 메커니즘과 대차대조표

### 2-1. Auto Increment — DB 한 대의 카운터

**메커니즘.** InnoDB는 테이블마다 메모리에 자동 증가 카운터를 들고
있고, INSERT가 들어오면 짧은 뮤텍스(테이블 락이 아니다) 아래에서 값을
하나 꺼내 준다. 나온 값은 항상 지금까지의 최댓값보다 크다.

**왜 순차 I/O가 되는가 — 사슬로.**

> 새 PK가 항상 최댓값이다 → 클러스터드 B+Tree에서 삽입 위치는 **항상
> 맨 오른쪽 리프 페이지 한 장**이다 → 그 페이지는 방금 만졌으니 버퍼 풀에
> 반드시 있다(캐시 미스 0) → 페이지가 가득 차면 InnoDB는 그 페이지를
> 반으로 가르지 않고 **뒤에 새 페이지를 하나 붙인다**(오른쪽 끝 삽입
> 최적화 — 페이지 분할이 아니라 append) → 더티 페이지가 끝자락에 몰려
> 있으니 체크포인트 때 **이웃한 페이지를 묶어 순차로 쓴다** → 결과적으로
> INSERT의 워킹셋은 "맨 끝 리프 몇 장 + 루트에서 거기까지의 브랜치
> 경로"뿐이라, **버퍼 풀이 테이블보다 훨씬 작아도 INSERT 처리량이 유지**된다.

접수창구 비유 — 서류를 늘 서류철 **맨 뒤에 끼우니** 서류철을 열어볼
필요도, 중간을 벌릴 필요도 없다.

**어디서 막히는가 — 단일 노드 의존의 사슬.**

> 카운터는 **그 DB 인스턴스의 메모리**에 있다 → ID를 받으려면 반드시 그
> 인스턴스에 INSERT를 실제로 실행해야 한다 → ⑴ INSERT 전에는 ID를 알 수
> 없다(이벤트 선발행·멱등 키·JPA 쓰기 지연 배치가 막힌다 — [IDENTITY가
> 배치를 무력화하는 이유](../03-jpa-orm/21-bulk-insert-jdbc-batch.md)) ⑵
> DB를 샤딩하면 샤드마다 카운터가 따로 돌아 **같은 값이 여러 샤드에서
> 나온다** ⑶ 다중 마스터는 `auto_increment_increment`/`offset`으로 홀짝
> 나누기가 가능하지만 노드 수를 미리 박아야 하고 늘리기 어렵다 ⑷ 쓰기
> 처리량의 상한이 "카운터를 가진 그 한 대"의 상한이다.

**노출 위험.** 값이 연속이라 외부에 보이면 ⑴ 하루 주문량·증가율이
그대로 새고 ⑵ `/orders/10231` 다음은 `10232`라고 누구나 추측할 수
있어 권한 검사가 한 곳이라도 빠지면 남의 주문이 열린다(IDOR). 이건
Auto Increment의 결함이 아니라 **내부 PK를 외부에 그대로 노출한 설계의
결함**이다 — 그래서 분리가 결론이다.

**대차대조표.**

- 얻는 것: 8바이트, 완전한 단조 증가(순차 I/O), 외부 의존성 0, 구현 0,
  운영자 누구나 이해.
- 내는 것: 단일 노드 의존(샤딩·다중 리전 불가), INSERT 전 ID 미확보,
  연속 번호 노출 위험, 카운터 영속성은 DB 버전·설정에 따라 다르므로
  재기동 후 값 재사용 가능성을 확인해야 함.

**언제 정답인가.** DB가 한 대(+ 리플리카)이고 ID를 외부에 직접 노출하지
않는다면 **여전히 첫 번째 정답**이다. "요즘은 다 Snowflake 쓰지
않나요"에 흔들리지 않는 것이 시니어다 — 인프라를 늘리지 않고 되는 일을
늘려서 하지 않는다.

### 2-2. 채번 테이블(+블록 할당) — 핫 로우를 어떻게 식히는가

**메커니즘.** `id_sequences(seq_name, next_val)` 같은 테이블에 이름별
카운터 행을 두고, 채번할 때마다 그 행을 `UPDATE ... SET next_val =
next_val + 1`로 밀어 값을 받는다. DB만 있으면 되고, 여러 애플리케이션
인스턴스가 같은 테이블을 보므로 **분산 생성이 된다**. 날짜별로 행을
따로 두면 `20260831-000123` 같은 **업무 의미 있는 번호**도 만들 수 있다.

**왜 병목이 되는가 — 핫 로우 사슬.** 이 사슬을 "성능 저하"나 "락 경합"
한 단어로 뭉뚱그리지 않는다.

> 모든 요청이 **같은 한 행**을 UPDATE한다 → InnoDB는 그 행에 배타(X)
> 락을 건다 → 락은 문장이 끝나도 풀리지 않고 **트랜잭션이 커밋될 때까지**
> 유지된다 → 채번을 주문 트랜잭션 안에서 했다면, 주문 저장·재고 차감·
> 외부 결제 호출이 끝날 때까지 다음 주문은 채번 행 앞에서 **줄을 선다**
> → 채번 처리량의 상한 = 1 / (주문 트랜잭션 한 건의 길이) → 대기 중인
> 요청은 각자 **커넥션을 쥔 채** 기다리므로 커넥션 풀이 마른다 → 채번과
> 무관한 API까지 커넥션을 못 얻어 지연이 번진다 → 락 대기 타임아웃과
> 데드락(채번 행 + 다른 행을 서로 반대 순서로 잡을 때)이 섞여 터진다.

같은 사슬이 조회수 카운터에서 어떻게 나타나는지는
[초고빈도 카운터와 핫 로우](./23-high-frequency-counter-hot-row.md)가 다룬다 —
채번 테이블은 "정확해야 하는 숫자"라서 그 문서의 처방(근사·비동기 집계)을
쓸 수 없고, 대신 아래 두 처방으로 락 보유 시간과 방문 횟수를 줄인다.

**처방 두 가지 — 둘 다 해야 한다.**

⑴ **채번 트랜잭션을 분리해 짧게 잡는다.** 채번은 `REQUIRES_NEW`로 별도
트랜잭션에서 UPDATE 한 문장만 실행하고 즉시 커밋한다. 락 보유 시간이
"주문 처리 전체"에서 "UPDATE 한 문장 + 커밋"으로 줄어든다. MySQL이면
`UPDATE id_sequences SET next_val = LAST_INSERT_ID(next_val + ?) WHERE
seq_name = ?` 뒤에 `SELECT LAST_INSERT_ID()`로 **SELECT FOR UPDATE 없이
한 문장으로** 값을 받아온다 (가산점 포인트).

⑵ **블록 할당(hi/lo).** 한 번 다녀올 때 1이 아니라 N개(예: 500)를
선점하고, 나머지는 인스턴스 메모리에서 나눠 준다. 채번 행 방문 횟수가
1/N이 되고, 핫 로우의 경합도 그만큼 준다. JPA의 `@TableGenerator` +
`allocationSize`가 정확히 이 방식이다(동작 상세는 [bulk-insert 문서
§4-1](../03-jpa-orm/21-bulk-insert-jdbc-batch.md) 참고).

```java
// ❌ before: 주문 트랜잭션 안에서 채번 행을 잡는다 — 락이 주문 처리 끝까지 산다
@Transactional
public Order place(PlaceOrderCommand cmd) {
    long seq = jdbc.queryForObject(
        "SELECT next_val FROM id_sequences WHERE seq_name = 'order' FOR UPDATE", Long.class);
    jdbc.update("UPDATE id_sequences SET next_val = ? WHERE seq_name = 'order'", seq + 1);
    // ↓ 재고 차감·결제 승인(외부 HTTP)·주문 저장이 끝나 커밋될 때까지
    //   다른 모든 주문이 id_sequences 행 앞에서 대기한다 → 커넥션 풀 고갈로 번진다
    inventory.reserve(cmd);
    payment.approve(cmd);
    return orderRepository.save(Order.of(cmd, seq));
}

// ✅ after: 블록 할당 + 별도 짧은 트랜잭션 — 락 보유 = UPDATE 한 문장
@Component
public class SequenceBlockAllocator {
    @Transactional(propagation = Propagation.REQUIRES_NEW)   // 바깥 트랜잭션과 분리, 즉시 커밋
    public long allocate(String name, int blockSize) {
        int updated = jdbc.update(
            "UPDATE id_sequences SET next_val = LAST_INSERT_ID(next_val + ?) WHERE seq_name = ?",
            blockSize, name);
        if (updated == 0) {                                   // 새 이름(예: 오늘 날짜)이면 행을 만든다
            jdbc.update("INSERT IGNORE INTO id_sequences(seq_name, next_val) VALUES (?, 0)", name);
            return allocate(name, blockSize);                 // 경쟁자가 먼저 만들었어도 UPDATE로 수렴
        }
        long end = jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
        return end - blockSize;                               // 블록 시작값 [start, start+blockSize)
    }
}
```

**블록 할당이 새로 지불하는 대가 — 반드시 같은 호흡에.**

- **재기동하면 구멍이 난다.** 인스턴스가 500개를 선점하고 120개 쓴 뒤
  재배포되면 380개는 버려진다. 인스턴스가 10대면 배포 한 번에 최대
  수천 개가 빈다. **"주문번호는 연속이 아니다"를 정책으로 명문화**해야
  한다 — 회계·CS·정산 담당자가 "번호가 비었는데 주문이 유실된 것 아니냐"고
  묻는 순간이 반드시 온다. 연속성이 진짜 규제 요건(예: 일부 국가의 세금
  계산서 일련번호)이라면 이 방식은 쓸 수 없고 건별 채번 + 짧은 트랜잭션으로
  돌아가 처리량을 포기해야 한다. 이 선택을 ADR 한 장으로 남긴다.
- **인스턴스 간 순서가 섞인다.** A가 [0,500), B가 [500,1000)을 들고
  있으면 시간상 나중인 A의 3번이 B의 501번보다 작다. "번호 순 = 시간
  순"이 아니다. 시간 순 정렬은 `created_at`으로 한다.
- **채번 테이블이 가용성 결합점이다.** 그 행이 잠기거나 그 DB가 죽으면
  채번이 멈춘다. 블록이 클수록 방문이 드물어 버티는 시간이 길어진다 —
  블록 크기는 "재기동 시 버릴 수 있는 양"과 "DB 장애 시 버틸 시간"의
  거래다.

**대차대조표.**

- 얻는 것: 분산 생성(여러 인스턴스), INSERT 전 ID 확보, 업무 의미(날짜·
  채널·접두어) 자유, DB 외 인프라 0, 8바이트 정수 또는 원하는 포맷.
- 내는 것: 핫 로우(분리 트랜잭션 + 블록으로 완화), 재기동 시 구멍,
  인스턴스 간 순서 교차, 채번 테이블 가용성 의존, 연속 노출 시 추측 위험은
  그대로.

### 2-3. Snowflake — 시계와 워커 ID로 조율 없이 만든다

**메커니즘.** 64비트 정수 하나를 세 조각으로 나눈다.

```text
| 1비트 | 41비트 타임스탬프(ms, 서비스 에포크 기준) | 10비트 워커 ID | 12비트 시퀀스 |
  부호     약 69년                                    1024대            ms당 4096개
```

각 서버가 **자기 시계 + 자기 워커 ID + 같은 ms 안의 카운터**로 로컬에서
만들므로 DB 왕복도, 서버 간 합의도 없다. 상위 비트가 시간이라 **거의
단조 증가**하고, `BIGINT` 한 칸에 들어간다.

**왜 클러스터드 PK로 좋은가.** 시간이 상위 비트이므로 새 ID는 거의
항상 트리의 오른쪽 끝 근처에 꽂힌다. 워커가 여럿이라 같은 ms 안에서는
워커 ID 순으로 살짝 섞이지만, 그 섞임은 **맨 끝 페이지 몇 장 안**에서
일어난다 — 워킹셋이 Auto Increment와 거의 같다. 즉 **분산 생성을 얻으면서
순차 I/O를 거의 포기하지 않는다.** 이것이 Snowflake가 대용량에서 표준
답이 된 이유다.

**어디서 위험한가 — 두 가지 의존.**

⑴ **시계 의존.** 유일성이 "같은 워커에서 시간은 뒤로 가지 않는다"에
걸려 있다. NTP가 시계를 뒤로 맞추거나, VM 마이그레이션·절전 복귀로
시계가 튀면 **이미 발급한 ms로 되돌아가 같은 ID를 다시 만들 수 있다.**
따라서 발급기는 마지막 발급 시각을 기억하고 **역행을 감지해야** 한다 —
작은 역행(수 ms)은 기다리고, 큰 역행은 발급을 거부한다(§4-1 코드).

⑵ **워커 ID 배포.** 두 서버가 같은 워커 ID를 들면 같은 ms에 같은 ID가
나온다. 오토스케일링·컨테이너 환경에서 "설정 파일에 1, 2, 3 적어두기"는
배포 한 번에 무너진다. 워커 ID는 **중앙에서 유일하게 임대**해야 한다 —
ZooKeeper 순차 노드(원조 구현), DB 테이블에 기동 시 INSERT해 받은 값,
K8s StatefulSet의 순번, Redis `SETNX` 임대 + 하트비트 등. 어느 것이든
"프로세스가 죽으면 회수, 살아 있으면 갱신"이 있어야 재사용 충돌이 없다
(§4-2).

**그 밖의 대가.**

- **생성 시각이 값에 드러난다.** 상위 41비트를 풀면 ms 단위 생성 시각이
  나온다. 시퀀스 비트로 "그 ms에 몇 건"도 어느 정도 읽힌다. 총량 추측은
  Auto Increment보다 훨씬 어렵지만 "언제 만들었는지도 숨겨라"는 요건이면
  부적합하다.
- **전역 순서는 ms 단위 근사다.** 워커 간 시계가 몇 ms 어긋나면 나중에
  만든 ID가 더 작을 수 있다. "ID 순 = 정확한 시간 순"으로 커서 페이지네이션을
  짜면 경계에서 건너뛰기가 생긴다.
- **에포크를 한 번 정하면 바꿀 수 없다.** 41비트는 에포크로부터 약 69년이다.
- **JSON 직렬화 함정.** 64비트 정수는 JavaScript `Number`의 안전 범위(2^53)를
  넘는다. API 응답에서는 **문자열로** 내보내야 끝자리가 뭉개지지 않는다
  (가산점 포인트).
- **업무 의미는 없다.** 사람이 읽거나 불러줄 수 없다.

**대차대조표.**

- 얻는 것: 8바이트, 거의 단조 증가(순차 I/O 유지), 조율 없는 분산 생성,
  INSERT 전 ID 확보, 초당 워커당 수백만 개, DB 왕복 0.
- 내는 것: 시계 역행 감지 의무, 워커 ID 임대 인프라, 생성 시각 노출,
  ms 단위 근사 순서, 에포크 고정, 문자열 직렬화, 업무 의미 없음.

### 2-4. UUID v7 — 무작위를 시간으로 길들였지만 16바이트는 남는다

**먼저 v4가 왜 실격인지 — 이 문서에서 가장 중요한 사슬.** UUID v4는
128비트 중 122비트가 전부 난수다. 이걸 클러스터드 PK로 쓰면:

> 새 행의 PK가 무작위다 → 삽입 위치가 **B+Tree 전역의 아무 리프**다 →
> 대상 리프가 버퍼 풀에 있을 확률은 (버퍼 풀 크기 / 인덱스 크기)에
> 불과하다 → 인덱스가 버퍼 풀보다 커지는 순간부터 **INSERT 한 건마다
> 대상 페이지를 디스크에서 먼저 읽어 와야 쓸 수 있다**(쓰기가 랜덤 읽기
> I/O를 유발) → 대상 페이지가 가득 차 있으면 **페이지 분할**(반으로
> 가르고 절반을 새 페이지로 옮기고 부모에 길잡이 키 추가) → 반쯤 빈
> 페이지가 전역에 쌓여 **적재율이 떨어진다** → 같은 행 수를 담는 데
> 페이지가 더 필요해 인덱스가 더 커지고, 버퍼 풀 적중률이 더 떨어진다
> (악순환) → 더티 페이지가 전역에 흩어져 **플러시도 랜덤 쓰기**가 된다
> → 게다가 PK가 16바이트(문자열이면 36바이트 이상)라 **모든 세컨더리
> 인덱스의 리프 엔트리에 그 크기가 복제**되어 세컨더리 트리들도 함께
> 비대해지고, 각각의 페이지가 더 빨리 차서 분할이 잦아진다.

이 사슬을 "인덱스가 깨진다", "정렬이 안 돼서 느리다"로 줄이면 기본
문항에서 했던 뭉뚱그리기의 반복이다. 고리를 다 말해야 한다 — **무작위
위치 → 캐시 미스 → 페이지 분할 → 적재율 저하 → 랜덤 I/O → 크기 복제로
세컨더리까지 증폭.**

**v7은 무엇을 고쳤는가.** RFC 9562의 UUID v7은 앞 48비트를 Unix ms
타임스탬프로, 나머지를 버전·변형 비트와 난수(74비트)로 채운다.

```text
| 48비트 unix_ts_ms | 4비트 ver(7) | 12비트 rand_a | 2비트 var | 62비트 rand_b |
```

상위 비트가 시간이므로 삽입 위치가 Snowflake처럼 **오른쪽 끝 근처로
모인다.** 페이지 분할·버퍼 풀 오염 사슬이 끊긴다. 게다가 난수 비트가
74개라 **같은 ms에 시계가 역행해도 충돌 확률이 사실상 0**이고, 워커 ID
배포도 필요 없다 — Snowflake가 짊어진 두 의존이 모두 사라진다. 표준이라
언어·DB 어디서나 통하고, 클라이언트나 오프라인 기기에서 미리 만들 수도
있다.

**무엇이 남는가.**

- **16바이트다.** `BIGINT`의 두 배이고, 이 차이는 모든 세컨더리 인덱스
  엔트리에 복제되는 곱셈 계수다. 1,000만 행 × 세컨더리 5개면 8바이트
  차이가 400MB 이상의 인덱스 증가로 나타나고, 페이지당 엔트리 수가
  줄어 버퍼 풀 적재율이 그만큼 낮아진다. **정렬성은 회복했지만 원칙 ①
  "작게"는 여전히 어긴다.**
- **문자열로 저장하면 최악이다.** `CHAR(36)`은 36바이트 이상이고 비교도
  느리다. MySQL이면 `BINARY(16)` + `UUID_TO_BIN()`/`BIN_TO_UUID()`로 저장한다.
  (`UUID_TO_BIN(uuid, 1)`의 스왑 플래그는 시간 필드가 뒤에 있는 v1을
  앞으로 돌리는 용도다. v7은 이미 시간이 앞이라 **스왑 없이** 넣는다 —
  스왑을 걸면 오히려 정렬성이 깨진다.)
- **생성 시각이 드러난다.** Snowflake와 같다.
- **가독성·업무 의미 0.** 주문번호로 고객에게 불러줄 수 없다.
- **Java 표준 `UUID.randomUUID()`는 v4다.** v7은 별도 라이브러리나 직접
  구현이 필요하다. Hibernate 최신 6.x 계열은 `@UuidGenerator`에 v7
  스타일을 지원하지만, 사용 중인 버전에서 지원 여부를 반드시 확인하고
  쓴다.

**대차대조표.**

- 얻는 것: 조율·시계 역행·워커 ID 걱정 없는 완전 무의존 분산 생성,
  거의 단조 증가(순차 I/O 회복), 표준, 클라이언트 생성 가능, 총량 추측
  불가.
- 내는 것: 16바이트 곱셈 계수(세컨더리 인덱스 비대·적재율 저하), 생성
  시각 노출, 가독성 0, 저장 타입을 잘못 고르면(문자열) v4와 다를 바 없는
  크기, JDK 표준 미지원.

### 2-5. 단조 증가에도 대가는 있다 (가산점 포인트)

트레이드오프를 양면으로 말하려면 "정렬성이 무조건 좋다"에서도 한 걸음
물러설 줄 알아야 한다. 모든 INSERT가 **맨 오른쪽 리프 한 장**에 몰리면
그 페이지(와 그 위 브랜치)의 래치를 두고 스레드들이 경합한다. 초당 수만
건 이상의 단일 테이블 삽입에서는 이 "마지막 페이지 핫스팟"이 병목으로
관측되기도 한다. 완화책은 샤딩·파티셔닝으로 끝 페이지를 여러 개로
나누는 것이지 랜덤 키로 돌아가는 것이 아니다 — 랜덤 키는 래치 경합
대신 디스크 I/O를 지불하는데, 그쪽이 수천 배 비싸다.

---

## 3. 비교표와 선택 기준 — 목록으로 인출한다

### 3-1. 4방식 비교표

| 축 | Auto Increment | 채번 테이블(+블록) | Snowflake | UUID v7 |
|---|---|---|---|---|
| 정렬성(시간 순) | 완전 단조 | 블록 단위(인스턴스 간 교차) | ms 단위 근사 단조 | ms 단위 근사 단조 |
| 분산 생성 | ✗ DB 단일 카운터 | △ DB 왕복 필요, 핫 로우 | ○ 로컬 생성, 조율 0 | ○ 로컬 생성, 조율 0 |
| INSERT 전 ID 확보 | ✗ | ○ | ○ | ○ |
| 크기 | 8B | 8B(정수) 또는 포맷 문자열 | 8B | 16B |
| 노출 위험 | 연속 → 총량·다음 값 추측 | 연속 → 동일 | 생성 시각·ms당 건수 노출 | 생성 시각 노출 |
| 의존성 | DB 노드 1대 | 채번 행의 락·가용성 | 시계 규율 + 워커 ID 임대 | 시계(역행은 난수가 완충) |
| 업무 의미 부여 | ✗ | ○ 날짜·채널·체크 디짓 자유 | ✗ | ✗ |
| 대표 대가 | 샤딩 불가, IDENTITY 배치 무력화 | 핫 로우, 재기동 시 구멍 | 시계 역행, 워커 ID 충돌 | 곱셈 계수 2배, JDK 미지원 |

표를 외우는 게 아니라 **축 여섯 개(정렬성·분산성·크기·노출·의존성·업무
의미)를 먼저 말하고 각 칸을 채우는 순서**를 몸에 붙인다. 면접에서
"UUID v7과 Snowflake 중 뭐가 낫나요"가 오면 표의 열 두 개를 나란히
읽으면 된다 — 같은 정렬성·같은 분산성, 크기 8 vs 16, 의존성은 Snowflake가
무겁고 UUID v7이 가볍다. **의존성을 살 여유(워커 ID 레지스트리, NTP
규율)가 있으면 Snowflake, 없으면 UUID v7이 크기를 내고 단순함을 산다.**

### 3-2. 선택 기준 6가지

1. **생성 지점이 하나인가 여럿인가.** DB 한 대(+리플리카)면 Auto
   Increment로 충분하다. 샤딩·다중 리전·클라이언트 생성이 요구되면
   Snowflake / UUID v7로 간다. 채번 테이블은 "인스턴스는 여럿이지만 DB는
   하나"인 중간 지대의 답이다.
2. **INSERT 전에 ID가 필요한가.** 이벤트를 먼저 발행하거나, 멱등 키로
   쓰거나, JPA 쓰기 지연 배치를 살려야 하면 Auto Increment는 탈락이다.
3. **외부에 노출되는가, 노출되면 무엇이 새는가.** 총량·증가율이 문제면
   연속 번호가 탈락, 생성 시각까지 숨겨야 하면 시간 정렬 ID도 탈락 →
   내부 PK와 별개의 무작위 외부 식별자가 필요하다.
4. **업무 의미(날짜·채널·체크 디짓) 요구가 있는가.** 있으면 어차피 PK와
   분리해야 하고, 외부 식별자 쪽은 채번 테이블 + 포맷 조립이 답이다.
5. **저장 엔진이 클러스터드인가.** InnoDB면 정렬성은 선택이 아니라
   필수다. PostgreSQL 힙 테이블이면 랜덤 키의 페이지 분할 비용이 덜
   치명적이라 UUID의 허용 범위가 넓어진다 — 엔진을 먼저 묻고 결론을 낸다.
6. **팀이 감당할 의존성은 어디까지인가.** Snowflake는 워커 ID 임대와
   시계 규율이라는 **운영 의무**를 사고, 채번 테이블은 DB 가용성에 묶이고,
   UUID v7은 의존성 대신 16바이트를 낸다. "인프라를 늘리지 않고 되는
   일을 늘려서 하지 않는다"가 기본값이다.

---

## 4. 결론 설계 — 내부 PK와 외부 주문번호를 분리하고 안전망을 코드로 고정한다

### 4-1. 스키마와 JPA 매핑 — before / after

```java
// ❌ before: UUID v4 문자열 하나가 PK이자 주문번호
@Entity
@Table(name = "orders")
public class Order {
    @Id
    @Column(length = 36)
    private String id = UUID.randomUUID().toString();   // v4: 122비트 난수, CHAR(36)
    // ① 36바이트 PK가 모든 세컨더리 인덱스(고객별·상태별·일자별...)에 복제 → 곱셈 계수
    // ② 삽입 위치 무작위 → 캐시 미스 → 페이지 분할 → 적재율↓ → INSERT마다 랜덤 I/O
    // ③ 이 값을 그대로 고객·CS에 노출 → 불러줄 수도, 날짜를 읽을 수도 없다
    // ④ id가 이미 채워진 채 save() → Spring Data는 "새 엔티티 아님"으로 보고
    //    merge → SELECT 한 번 더 나간다 (persist가 아니라 select + insert)
    ...
}
```

```java
// ✅ after: 내부 PK(BIGINT, 시간 순) + 외부 주문번호(업무 포맷, 유니크) 분리
@Entity
@Table(name = "orders",
       uniqueConstraints = @UniqueConstraint(name = "uk_orders_order_no", columnNames = "order_no"))
public class Order {

    @Id
    @GeneratedValue(generator = "snowflake")
    @GenericGenerator(name = "snowflake", strategy = "com.example.id.SnowflakeIdentifierGenerator")
    private Long id;               // 내부 식별자: 8바이트, 거의 단조 증가, 조인·FK·세컨더리 인덱스의 축
                                   // 단일 DB라면 @GeneratedValue(strategy = IDENTITY)로 바꿔도 이 구조는 그대로다

    @Column(name = "order_no", nullable = false, updatable = false, length = 20)
    private String orderNo;        // 외부 식별자: 20260831-A-004821-7 (날짜-채널-일련-체크디짓)
                                   // 고객·CS·정산이 부르는 번호. 유니크 제약이 최후 방어선

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;     // 시간 순 정렬·커서는 이 컬럼으로 — ID 순서를 시간 순으로 믿지 않는다

    protected Order() {}

    public static Order place(String orderNo, ...) { ... }
}
```

```sql
-- 세컨더리 인덱스는 전부 8바이트 PK를 품는다. order_no는 세컨더리 유니크 하나로 끝.
CREATE TABLE orders (
    id          BIGINT       NOT NULL PRIMARY KEY,          -- Snowflake (또는 AUTO_INCREMENT)
    order_no    VARCHAR(20)  NOT NULL,
    customer_id BIGINT       NOT NULL,
    status      VARCHAR(20)  NOT NULL,
    created_at  DATETIME(6)  NOT NULL,
    UNIQUE KEY uk_orders_order_no (order_no),
    KEY ix_orders_customer_created (customer_id, created_at)
);
```

**이 구조가 한 번에 해결하는 것.** 클러스터드 인덱스의 비용은 8바이트
단조 증가 PK가 감당한다(순차 I/O, 작은 곱셈 계수). 노출·가독성·업무
의미는 `order_no`가 감당한다. 두 요구가 한 컬럼에서 싸우던 것이 애초의
문제였다. 외부 API·URL·이메일·영수증에는 `order_no`만 나가고, `id`는
서비스 밖으로 나가지 않는다.

### 4-2. 안전망 ① — Snowflake 발급기: 시계 역행 감지와 시퀀스 고갈 대기

```java
public final class Snowflake {
    private static final long EPOCH = 1_735_689_600_000L;  // 2025-01-01T00:00:00Z — 한 번 정하면 못 바꾼다
    private static final long WORKER_BITS = 10, SEQ_BITS = 12;
    private static final long MAX_WORKER = (1L << WORKER_BITS) - 1;
    private static final long SEQ_MASK   = (1L << SEQ_BITS) - 1;
    private static final long TOLERABLE_BACKWARD_MS = 5;    // 이 이하 역행은 기다리고, 초과는 거부

    private final long workerId;
    private long lastTs = -1L;
    private long seq = 0L;

    public Snowflake(long workerId) {
        if (workerId < 0 || workerId > MAX_WORKER) throw new IllegalArgumentException("workerId out of range");
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long now = System.currentTimeMillis();

        if (now < lastTs) {                                   // ── 시계 역행 감지 ──
            long backward = lastTs - now;
            if (backward > TOLERABLE_BACKWARD_MS) {
                // 큰 역행: 같은 ms를 다시 쓰면 중복이므로 발급을 거부한다. 알람 대상.
                throw new ClockMovedBackwardsException(backward);
            }
            now = spinUntil(lastTs);                          // 작은 역행: 마지막 발급 시각까지 기다린다
        }

        if (now == lastTs) {
            seq = (seq + 1) & SEQ_MASK;
            if (seq == 0) now = spinUntil(lastTs + 1);        // 같은 ms에 4096개 소진 → 다음 ms까지 대기
        } else {
            seq = 0L;
        }
        lastTs = now;

        return ((now - EPOCH) << (WORKER_BITS + SEQ_BITS)) | (workerId << SEQ_BITS) | seq;
    }

    private static long spinUntil(long targetTs) {
        long now;
        do { now = System.currentTimeMillis(); } while (now < targetTs);
        return now;
    }
}
```

`ClockMovedBackwardsException`은 삼키지 않는다 — 주문 API는 실패로
응답하고 알람이 울려야 한다. "조용히 새 ID를 만들어 내는" 발급기는 중복
ID를 만들어 내는 발급기다. 운영 쪽 짝은 **NTP를 step이 아니라 slew로**
맞추도록 설정하는 것이다(시계를 한 번에 되돌리지 않고 천천히 늦춰
맞춘다).

### 4-3. 안전망 ② — 워커 ID 임대: 설정 파일이 아니라 등록 테이블

```sql
-- 기동 시 자기 자신을 등록하고, 살아 있는 동안 하트비트를 갱신한다.
CREATE TABLE id_workers (
    worker_id     SMALLINT     NOT NULL PRIMARY KEY,        -- 0 ~ 1023
    owner         VARCHAR(100) NOT NULL,                    -- 호스트명/파드명
    heartbeat_at  DATETIME(6)  NOT NULL
);
```

```java
@Component
public class WorkerIdLease {
    private static final Duration STALE = Duration.ofMinutes(5);

    @Transactional
    public int acquire(String owner) {
        // ① 오래 갱신되지 않은 슬롯(죽은 프로세스)이 있으면 빼앗는다
        Integer stale = jdbc.query(
            "SELECT worker_id FROM id_workers WHERE heartbeat_at < ? ORDER BY heartbeat_at LIMIT 1 FOR UPDATE SKIP LOCKED",
            rs -> rs.next() ? rs.getInt(1) : null, Timestamp.from(Instant.now().minus(STALE)));
        if (stale != null) {
            jdbc.update("UPDATE id_workers SET owner = ?, heartbeat_at = NOW(6) WHERE worker_id = ?", owner, stale);
            return stale;
        }
        // ② 없으면 빈 번호를 하나 INSERT — PK 충돌이 나면 경쟁자가 먼저 가져간 것이므로 다음 번호로
        for (int candidate = 0; candidate < 1024; candidate++) {
            try {
                jdbc.update("INSERT INTO id_workers(worker_id, owner, heartbeat_at) VALUES (?, ?, NOW(6))", candidate, owner);
                return candidate;
            } catch (DuplicateKeyException taken) { /* 다음 후보 */ }
        }
        throw new IllegalStateException("no free worker id");   // 1024대 초과 — 기동 실패가 정답
    }

    @Scheduled(fixedDelay = 30_000)
    public void heartbeat() { jdbc.update("UPDATE id_workers SET heartbeat_at = NOW(6) WHERE worker_id = ?", myWorkerId); }
}
```

핵심은 두 줄이다 — **PK 충돌을 "이미 누가 가져갔다"의 신호로 쓴다**(DB의
유니크 보장을 조율 도구로 쓰는 것), 그리고 **하트비트가 끊긴 슬롯만
회수**한다. 하트비트 주기보다 STALE을 충분히 길게 잡아 "잠깐 GC로 멈춘
살아 있는 프로세스"의 번호를 빼앗지 않게 한다. ZooKeeper·etcd·Redis
임대도 같은 구조를 다른 저장소로 구현한 것이다.

### 4-4. 안전망 ③ — 주문번호 생성기: 블록 할당 + 유니크 제약 + 새 트랜잭션에서 재시도

```java
@Component
public class OrderNoGenerator {
    private static final int BLOCK = 500;
    private final SequenceBlockAllocator allocator;   // §2-2의 REQUIRES_NEW 할당기
    private final Clock clock;

    private LocalDate blockDate;                      // 현재 블록의 날짜
    private long next, limit;                         // 현재 블록 [next, limit)

    public synchronized String next(Channel channel) {
        LocalDate today = LocalDate.now(clock);
        if (!today.equals(blockDate) || next >= limit) {          // 날짜가 바뀌었거나 블록 소진
            long start = allocator.allocate("order:" + today, BLOCK);
            blockDate = today; next = start; limit = start + BLOCK;
        }
        long serial = next++;
        String body = today.format(DateTimeFormatter.BASIC_ISO_DATE) + "-" + channel.code() + "-"
                    + String.format("%06d", serial);
        return body + "-" + luhnCheckDigit(body);                 // 체크 디짓: CS 오타 입력을 걸러 준다
    }
}
```

```java
@Service
public class PlaceOrderService {
    private static final int MAX_ATTEMPTS = 3;

    // 트랜잭션은 여기 밖에서 시작하지 않는다 — 충돌 시 "새 트랜잭션"으로 재시도해야 하기 때문
    public Order place(PlaceOrderCommand cmd) {
        for (int attempt = 1; ; attempt++) {
            try {
                return tx.execute(status -> {                        // TransactionTemplate: 시도마다 새 트랜잭션
                    String orderNo = orderNoGenerator.next(cmd.channel());
                    return orderRepository.save(Order.place(orderNo, cmd));
                });
            } catch (DataIntegrityViolationException dup) {         // uk_orders_order_no 위반 = 최후 방어선 작동
                if (attempt >= MAX_ATTEMPTS) throw dup;
                log.warn("order_no collision, retrying attempt={}", attempt + 1);
            }
        }
    }
}
```

세 가지가 코드로 고정된다.

- **유니크 제약이 최후 방어선이다.** 블록 할당기에 버그가 있어도, 두
  인스턴스가 어떤 경로로든 같은 번호를 만들어도, **DB가 거절한다.** 채번
  로직의 정확성을 믿는 것과 별개로 이 제약은 반드시 있어야 한다.
- **재시도는 새 트랜잭션에서.** JPA 트랜잭션 안에서 유니크 위반이 나면
  그 트랜잭션은 `rollback-only`로 표시되어 같은 트랜잭션에서는 아무것도
  커밋할 수 없다. 재시도 루프는 트랜잭션 **밖**에 있어야 한다.
- **구멍 허용은 정책이다.** 블록 할당을 택한 순간 "주문번호는 연속이
  아니다"가 시스템의 성질이 된다. 이 사실을 코드 주석이 아니라 ADR과
  운영 문서에 적고, CS·회계에 사전에 알린다.

**날짜별 연속 일련번호의 함정 (가산점 포인트).** `20260831-A-004821`은
사람이 읽기 좋지만 **하루 주문량이 그대로 보인다** — 연속 번호 노출
문제로 되돌아온 셈이다. 규모 추측까지 막아야 한다면 ⑴ 일련 부분을
Feistel 네트워크 같은 **전단사 치환**으로 섞어 유일성을 유지한 채 무작위처럼
보이게 하거나 ⑵ 일련 대신 난수 6~8자리를 쓰고 유니크 충돌 시 재시도한다
(충돌 확률 관리 필요). 어느 쪽이든 "누가 이 번호를 보고 무엇을 알아낼 수
있는가"를 요건에서 먼저 확정한다.

### 4-5. 안전망 ④ — 동시성 채번 테스트

"유니크할 것"은 코드 리뷰로 확인되지 않는다. 스레드 수십 개가 동시에
뽑아도 겹치지 않는다는 사실을 테스트로 고정한다.

```java
@Test
void concurrentGenerationProducesNoDuplicates() throws Exception {
    int threads = 32, perThread = 2_000;
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    CountDownLatch start = new CountDownLatch(1);
    Set<Long> ids = ConcurrentHashMap.newKeySet();

    for (int t = 0; t < threads; t++) {
        pool.submit(() -> { start.await(); for (int i = 0; i < perThread; i++) ids.add(snowflake.nextId()); return null; });
    }
    start.countDown();                                   // 32개 스레드를 같은 순간에 출발시킨다
    pool.shutdown(); pool.awaitTermination(30, TimeUnit.SECONDS);

    assertThat(ids).hasSize(threads * perThread);        // 하나라도 겹치면 크기가 줄어든다
}
```

같은 형태로 `OrderNoGenerator`도 검증하고, Testcontainers로 실제
MySQL을 띄워 `uk_orders_order_no`가 실제로 걸려 있는지(엔티티 어노테이션이
아니라 **DDL에**) 확인하는 테스트를 하나 더 둔다 — 유니크 제약이 없는
운영 DB는 최후 방어선이 없는 시스템이다.

---

## 5. 꼬리질문 대비 포인트

### "UUID v4를 PK로 쓰면 왜 INSERT가 느려지나요? v7로 바꾸면 완전히 해결되나요?"

사슬로 답한다 — 무작위 PK → 삽입 위치가 트리 전역 → 대상 리프가 버퍼
풀에 없을 확률이 높아 **INSERT마다 디스크 랜덤 읽기** → 가득 찬 페이지는
**분할**(가르고 옮기고 부모 갱신) → 반쯤 빈 페이지가 쌓여 **적재율 저하**
→ 인덱스가 커져 캐시 적중률이 더 떨어지는 악순환 → 더티 페이지가
흩어져 **플러시도 랜덤 쓰기** → 16~36바이트 PK가 **모든 세컨더리 인덱스에
복제**되어 증폭. v7은 시간을 상위 비트에 두어 삽입 위치를 오른쪽 끝으로
모으므로 **분할·버퍼 풀 오염 사슬은 끊긴다.** 하지만 **16바이트라는
곱셈 계수는 그대로**라 원칙 ① "작게"는 여전히 어긴다 — 세컨더리 인덱스
총량과 페이지당 엔트리 수에서 BIGINT 대비 대가를 낸다. "완전히
해결"이 아니라 "두 문제 중 치명적인 하나를 해결"이라고 답해야 정확하다.
그리고 `CHAR(36)`으로 저장하면 v7이어도 크기 문제는 v4와 같다 —
`BINARY(16)`이 전제다.

### "Snowflake에서 서버 시계가 뒤로 가면 무슨 일이 생기고, 어떻게 막나요?"

유일성이 "같은 워커에서 시간은 단조"라는 가정에 걸려 있으므로, 시계가
이미 발급한 ms로 되돌아가면 **같은 (시각, 워커, 시퀀스) 조합이 다시
나올 수 있다.** 발급기는 마지막 발급 시각을 들고 있다가 **역행을 감지**해야
한다 — 수 ms 이내면 그 시각까지 기다리고, 그 이상이면 예외로 발급을
거부하고 알람을 울린다(§4-2 코드). 예외를 삼키고 계속 발급하는 것이
최악이다. 운영 쪽에서는 NTP를 step(한 번에 되돌림)이 아니라 slew(천천히
보정)로 설정하고, VM 마이그레이션·절전 복귀 뒤 시계 점프를 모니터링한다.
**(가산점 포인트)** UUID v7은 같은 상황에서 74비트 난수가 완충하므로
역행 감지 코드가 필요 없다 — Snowflake의 시계 의존을 16바이트로 산
것이라고 연결하면 트레이드오프 서술이 완성된다.

### "채번 테이블이 왜 트래픽에서 병목이 되나요? 블록 할당하면 뭐가 남나요?"

핫 로우 사슬 — 모든 요청이 **같은 행**을 UPDATE → 배타 락 → 락은
**트랜잭션 커밋까지** 유지 → 채번을 주문 트랜잭션 안에서 하면 주문
처리 전체 길이만큼 다음 요청이 대기 → 처리량 상한 = 1/트랜잭션 길이 →
대기자가 커넥션을 쥔 채 서므로 **풀 고갈**로 다른 API까지 번진다. 처방은
둘 다 — `REQUIRES_NEW`로 채번 트랜잭션을 UPDATE 한 문장으로 짧게 분리하고,
블록 할당으로 방문 횟수를 1/N로 줄인다. 블록 할당 후 남는 것은 ⑴
**재기동 시 구멍**(선점분 폐기 — 연속성 요건이 있으면 못 쓴다, 정책
명문화 필요) ⑵ **인스턴스 간 순서 교차**(번호 순 ≠ 시간 순) ⑶ **채번
테이블 자체의 가용성 의존**이다. "블록 크기를 얼마로"는 "재기동 시 버릴
양"과 "DB 장애 시 버틸 시간"의 거래라고 답하면 된다.

### "주문번호에 날짜와 채널 코드를 넣어 달라는 요구가 왔습니다. PK를 바꾸시겠어요?" (시니어 변별 포인트)

바꾸지 않는다. 이 요구는 **"외부 식별자에 업무 의미를 담아 달라"**는
요구이지 "내부 식별자를 바꿔 달라"는 요구가 아니다. PK는 조인·FK·모든
세컨더리 인덱스의 축이라 **작고 단조 증가하는 정수**여야 하고, 날짜·채널이
들어간 문자열은 그 두 원칙을 다 어긴다(크기↑, 채널별로 삽입 위치가
갈라짐). 그래서 PK는 그대로 두고 `order_no` 컬럼을 유니크 제약과 함께
추가한다(§4-1). 이어서 되물어야 할 것 — "일련번호가 연속이면 하루
주문량이 노출되는데 괜찮은가"(§4-4 함정), "채널 코드가 바뀌면 기존
번호는 어떻게 하는가"(번호는 불변, 채널 매핑은 별도 테이블), "체크
디짓을 넣어 CS 오입력을 막을까". 요구를 한 단계 쪼개 어느 성질이 진짜
필요한지 되묻고, **PK와 업무 식별자를 겸용하던 것이 애초의 문제**였다고
짚는 것이 시니어의 답이다.

### "우리 서비스는 DB 한 대로 충분한데, 그래도 Snowflake를 미리 도입해야 할까요?" (시니어 변별 포인트)

아니다 — **의존성 비용을 먼저 말한다.** Snowflake는 워커 ID 임대
인프라(레지스트리·하트비트·회수)와 시계 규율(NTP slew, 역행 감지·알람)이라는
**상시 운영 의무**를 산다. DB 한 대인 지금은 Auto Increment가 순차 I/O,
8바이트, 의존성 0을 공짜로 주고 있다. 다만 **미리 해 둘 것은 하나**다 —
내부 PK를 외부에 노출하지 않도록 `order_no`를 지금부터 분리해 두는 것.
그러면 나중에 샤딩이나 다중 리전이 실제 요구가 됐을 때 **바뀌는 것은
`@GeneratedValue` 전략 한 줄과 마이그레이션**이고, 외부 계약(주문번호
포맷)은 그대로다. 넘어가는 신호도 정해 둔다 — ⑴ 샤딩/다중 마스터 결정
⑵ INSERT 전 ID가 필요한 설계(이벤트 선발행·배치 쓰기 지연) ⑶ 단일
노드 쓰기 처리량 한계 관측. 이 셋 중 하나가 오기 전에는 인프라를 늘리지
않는다. **(가산점 포인트)** 넘어갈 때 기존 Auto Increment 값과 Snowflake
값이 같은 `BIGINT` 컬럼에서 겹치지 않는지(에포크가 충분히 뒤라 Snowflake
값이 기존 최댓값보다 크다는 것) 확인하는 마이그레이션 체크까지 말하면
끝이다.

### "Snowflake ID로 정렬하면 정확한 시간 순이 되나요? 커서 페이지네이션 키로 써도 되나요?" (가산점 포인트)

**워커 안에서는 단조, 워커 간에는 ms 단위 근사**다. 두 서버의 시계가
몇 ms 어긋나면 나중에 만든 ID가 더 작을 수 있고, 같은 ms 안의 순서는
워커 ID 순이지 실제 발생 순이 아니다. 따라서 "최근 주문순" 목록의 정렬
키로는 `created_at`(+ 타이브레이커로 `id`)을 쓰고, ID는 **유일성과
인덱스 지역성**을 위한 것이라고 역할을 나눈다. 커서로 ID만 쓰면 시계
어긋남 경계에서 건너뛰기가 생길 수 있다. UUID v7도 같은 성질이다 —
"시간 정렬 ID"라는 말은 "인덱스 삽입 위치가 모인다"는 뜻이지 "정확한
발생 순서를 보장한다"는 뜻이 아니다.

---

## 한 줄 요약

**채번 설계의 답은 방식 이름이 아니라 분리다 — 내부 PK는 작고(8바이트)
단조 증가(맨 끝 append → 순차 I/O)해야 하므로 단일 DB면 Auto Increment,
분산이면 Snowflake(시계 역행 감지 + 워커 ID 임대를 코드로)이고, UUID v4는
무작위 위치 → 캐시 미스 → 페이지 분할 → 적재율 저하 → 랜덤 I/O → 세컨더리
복제 증폭의 사슬로 실격, UUID v7은 정렬성은 회복하되 16바이트 곱셈
계수를 낸다. 외부 주문번호는 채번 테이블(+블록 할당, 별도 짧은
트랜잭션, 구멍 허용 정책 명문화)로 업무 의미를 담고, 유니크 제약을 최후
방어선으로 둔다. 4방식은 정렬성·분산성·크기·노출·의존성·업무 의미 여섯
축으로 비교하고, 각 방식의 얻는 것과 내는 것을 같은 호흡에 붙인다.**
