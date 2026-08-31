# volatile — 가시성은 보장하지만, 원자성은 보장하지 않는다

> 핵심 관전 포인트: **volatile은 두 가지를 보장한다 — ① 가시성(한 스레드가 쓴
> 값이 다른 스레드에게 반드시 보인다), ② 그 변수를 기준으로 한 재배치 방지.
> 그러나 원자성은 보장하지 않는다 — `volatile int count`의 `count++`는
> 읽기→계산→쓰기 3단계 복합 연산이라 여전히 깨진다.
> 그래서 volatile은 "한 스레드가 쓰고 여러 스레드가 읽는 플래그/상태 발행"에만
> 적합하고, 복합 연산에는 `AtomicInteger`(CAS)나 락이 필요하다.**

---

## 0. 질문 + 의도

**질문**: "`volatile` 키워드는 무엇을 보장하고, 무엇을 보장하지 못하나요?
(가시성 vs 원자성)"

**출제 의도**: `volatile int counter++` 같은 코드가 왜 틀렸는지 즉시 보이는지를
확인한다. 동시성 버그는 테스트를 통과하고 운영에서만 터지므로, 코드 리뷰
단계에서 잡을 수 있는 사람의 가치가 특히 크다.

## 1. 보장하는 것 ① — 가시성 (visibility)

### 왜 기본적으로는 안 보이는가

CPU 코어마다 자기 캐시가 있고, JIT 컴파일러는 "이 값은 안 바뀌네"라고 판단하면
메모리를 다시 읽지 않도록 최적화한다. 즉 **한 스레드가 변수에 쓴 값을 다른
스레드가 언제 볼지, 심지어 영영 못 볼 수도 있는 게 기본 상태**다.

비유하면: 각 스레드가 원본 문서(메인 메모리)의 **복사본(캐시)을 들고
일하는 것**과 같다. 누가 원본을 고쳐도 내 복사본만 계속 보면 모른다.
volatile은 "이 변수는 복사본 보지 말고 **항상 원본을 확인해라**"는 표시다.

### before — 영원히 안 멈추는 스레드

```java
class Worker implements Runnable {
    private boolean stopRequested = false;   // ❌ volatile 없음

    public void run() {
        while (!stopRequested) {             // JIT가 "안 바뀌는 값"으로 보고
            doWork();                        // 루프 밖으로 읽기를 끌어올릴 수 있다
        }                                    // → 사실상 while(true)로 컴파일
    }

    public void stop() { stopRequested = true; }  // 다른 스레드가 호출해도
}                                                 // 워커에게 안 보일 수 있다
```

이 코드는 로컬 테스트에서는 대부분 잘 멈춘다(JIT가 덜 최적화된 상태).
**운영에서 오래 돌던 서버에서만** 안 멈추는 스레드가 발견된다 —
출제 의도가 짚는 "테스트를 통과하고 운영에서 터지는" 전형이다.

### after — volatile로 가시성 확보

```java
private volatile boolean stopRequested = false;  // ✅ 쓰기가 즉시 발행되고,
                                                 //    읽기는 항상 최신 값을 본다
```

### 보장하는 것 ② — 재배치 방지 (ordering)

volatile 쓰기/읽기는 그 앞뒤 코드가 **변수를 넘어 재배치되는 것을 막는다.**
그래서 volatile 변수 하나가 "그 이전에 쓴 일반 변수들까지 통째로 발행"하는
다리 역할을 한다(safe publication).

```java
int data = 0;                    // 일반 변수
volatile boolean ready = false;

// 스레드 A                      // 스레드 B
data = 42;      // ①             if (ready) {        // ready=true를 봤다면
ready = true;   // ② 발행         print(data);       // data=42도 반드시 보인다
                                 }
```

이 보증의 공식적인 근거(happens-before 규칙과 이행성)는
`15-jmm-happens-before.md`에서 다룬다. 이 문서에서는 결론만:
**volatile 쓰기 이전의 모든 쓰기는, 그 volatile을 읽은 스레드에게 함께 보인다.**

---

## 2. 보장하지 못하는 것 — 원자성 (atomicity)

### `volatile int count++`가 깨지는 이유

`count++`는 한 줄이지만 실제로는 **3단계 복합 연산**이다:

```
① count 읽기  →  ② +1 계산  →  ③ count 쓰기
```

volatile은 ①과 ③ 각각이 "최신 값을 읽고 즉시 발행"되게 할 뿐,
**①~③ 사이에 다른 스레드가 끼어드는 것은 전혀 막지 못한다.**

```java
private volatile int count = 0;

// 스레드 A                          // 스레드 B
① count 읽기 → 10
                                     ① count 읽기 → 10  (A가 아직 안 씀)
② 10 + 1 = 11
                                     ② 10 + 1 = 11
③ count = 11 쓰기
                                     ③ count = 11 쓰기   // ❌ 증가 1회 유실!
```

두 스레드가 각각 1씩 더했는데 결과는 11 — **lost update**다.
가시성 문제(못 본다)와 원자성 문제(끼어든다)는 **서로 다른 문제**이고,
volatile은 앞의 것만 해결한다.

### after — 복합 연산에는 CAS 또는 락

```java
// ✅ 방법 1: AtomicInteger — CAS(비교 후 교체)로 원자적 증가
private final AtomicInteger count = new AtomicInteger();
count.incrementAndGet();   // "내가 읽은 값 그대로면 바꿔라"를 하드웨어 명령으로

// ✅ 방법 2: synchronized — 상호배제로 끼어들기 자체를 차단
private int count = 0;
public synchronized void increment() { count++; }
```

### check-then-act도 마찬가지로 깨진다

```java
private volatile Connection conn;

public Connection get() {
    if (conn == null) {        // ❌ 검사(check)와
        conn = create();       // ❌ 행동(act) 사이에 다른 스레드가 끼어들면
    }                          //    create()가 두 번 실행된다
    return conn;
}
```

"null 검사 후 초기화", "잔액 확인 후 차감" 같은 **검사-후-행동 패턴은
개별 읽기/쓰기가 아니라 연산 묶음이 원자적이어야** 하므로 volatile로는 안 된다.

### 예외 하나 — long/double의 단일 읽기/쓰기 (가산점 포인트)

64비트 값인 `long`/`double`은 volatile이 없으면 읽기/쓰기 자체가 32비트씩
두 번으로 쪼개질 수 있다고 JLS가 허용한다(반쪽만 쓰인 값을 읽는 word tearing).
`volatile long`은 **단일 읽기/쓰기의 원자성은** 보장한다 — 단, 이것도
`++` 같은 복합 연산의 원자성과는 별개다.

---

## 3. 실무 판단 기준 — volatile이 맞는 자리 / 틀린 자리

### volatile이 맞는 자리: "한 명이 쓰고, 여럿이 읽는" 구조

- **종료/상태 플래그**: `volatile boolean shutdown` — 쓰는 쪽은 관리 스레드
  하나, 읽는 쪽은 워커 여럿
- **불변 객체 교체 발행**: 설정 리로드처럼 새 불변 객체를 만들어 참조만 바꿔치기

```java
private volatile Config config;   // Config는 불변 객체

public void reload() {
    config = loadNewConfig();     // ✅ 참조 교체 한 번 = 단일 쓰기 → 원자적
}                                 //    읽는 쪽은 항상 온전한 옛것 아니면 온전한 새것
```

- **double-checked locking의 인스턴스 필드**: 재배치 방지가 필수인 자리
  (꼬리질문 4 참고)

### volatile이 틀린 자리

- 카운터, 누적 합계 등 **읽고-고치고-쓰는 모든 것** → `Atomic*` 또는 락
- 검사-후-행동 (null 체크 후 초기화, 조건 확인 후 갱신) → 락 또는 CAS 루프
- **두 변수가 함께 일관돼야 하는 불변식** (예: `balance`와 `history`가 같이
  움직여야 함) → volatile 두 개로는 "둘 다 최신"을 못 만든다. 락으로 묶어야 한다

### 코드 리뷰 체크리스트 (AI 생성 코드 검증 포함)

AI가 생성한 동시성 코드에서 특히 자주 보이는 오류가 "동기화가 필요하다는 건
알았는데 volatile을 만능으로 쓴" 형태다. 리뷰할 때는:

1. volatile 변수에 `++`, `+=`, `--` 가 있는가 → 즉시 지적
2. volatile 변수를 `if`로 검사한 뒤 그 결과로 쓰기를 하는가 → check-then-act
3. 쓰는 스레드가 정말 하나인가 → 둘 이상이면 volatile로 부족할 가능성이 높다

---

## 4. 꼬리질문 대비 포인트

### "`volatile int count`에 `count++`를 하면 정확히 무엇이 어떻게 깨지나요?"

`count++`는 읽기→계산→쓰기 3단계이고 volatile은 이 묶음을 원자적으로 만들지
않는다. 두 스레드가 같은 값을 읽고 각자 +1해서 쓰면 한 번의 증가가 유실된다
(lost update). 해결은 `AtomicInteger.incrementAndGet()`(CAS) 또는
`synchronized` — 가시성 문제가 아니라 상호배제 문제이기 때문이다.

### "AtomicInteger는 락 없이 어떻게 원자성을 보장하나요?"

CAS(Compare-And-Swap) — "메모리 값이 내가 읽었던 값 그대로면 새 값으로
바꿔라"를 CPU가 **하나의 하드웨어 명령**으로 처리한다. 중간에 다른 스레드가
값을 바꿨으면 실패가 반환되고, 실패하면 다시 읽어서 재시도하는 루프를 돈다.
락처럼 스레드를 재우지 않아서 경합이 짧을 때 훨씬 싸다.
(경합이 극심한 카운터라면 `LongAdder`가 낫다 — `27-longadder-false-sharing.md`)

### "volatile과 synchronized의 차이는? 언제 volatile로 충분한가요?" (시니어 변별 포인트)

synchronized는 **가시성 + 상호배제** 둘 다 주고, volatile은 **가시성(과
재배치 방지)만** 준다. volatile로 충분한 조건은 ① 쓰기가 현재 값에 의존하지
않고(단순 대입), ② 다른 변수와 묶인 불변식이 없고, ③ 쓰는 스레드가 사실상
하나일 때 — 즉 상태 플래그나 불변 객체 참조 교체다. 이 조건을 하나라도
벗어나면 락이나 CAS로 올라가야 한다. 비용 관점에서는 volatile 읽기가 락
획득보다 훨씬 싸므로, "읽기가 압도적으로 많은 발행/구독 구조"에서 volatile을
선택하는 것이 설계 판단이다.

### "double-checked locking 싱글턴에서 volatile은 왜 필요한가요?"

```java
private static volatile Holder instance;   // volatile 없으면 깨진다

static Holder get() {
    if (instance == null) {                 // ① 락 없이 1차 검사
        synchronized (Holder.class) {
            if (instance == null) {
                instance = new Holder();    // ② 이 한 줄이 사실은 3단계
            }
        }
    }
    return instance;
}
```

`new Holder()`는 "메모리 할당 → 생성자 실행 → 참조 대입"인데, volatile이
없으면 **참조 대입이 생성자 실행보다 먼저** 재배치될 수 있다. 그러면 ①에서
락 없이 읽은 다른 스레드가 "참조는 있는데 필드는 초기화 전인" 반쪽짜리 객체를
쓰게 된다. volatile이 이 재배치를 막고, 쓰기 이전의 생성자 쓰기들까지 함께
발행되게 한다. (요즘은 holder 클래스 관용구나 enum 싱글턴이 더 안전한
대안이라는 언급이 가산점 포인트)

### "volatile 읽기/쓰기에는 비용이 없나요?"

공짜는 아니다. 값을 레지스터/캐시에 오래 담아두는 최적화가 금지되고, 쓰기
시점에 메모리 배리어가 들어가 CPU 파이프라인 최적화가 제한된다. 다만 락처럼
스레드 블로킹·컨텍스트 스위칭을 일으키지는 않아서 일반적으로 락보다 훨씬
싸다. "그러니 아무 데나 volatile을 붙이자"가 아니라, **동시 접근되는 변수에만
정확히 붙이는 것**이 맞다.

---

## 한 줄 요약

volatile은 "쓴 값이 반드시 보이고 순서가 뒤집히지 않는다"(가시성 + 재배치
방지)까지만 보장하는 도구라서, 한 스레드가 쓰고 여럿이 읽는 플래그·불변 참조
교체에는 정답이지만, `count++`처럼 읽고-고치고-쓰는 복합 연산의 원자성은
전혀 보장하지 못하므로 그 자리에는 CAS(Atomic*)나 락을 써야 한다.
