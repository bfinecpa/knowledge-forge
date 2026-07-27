# Java Memory Model의 happens-before 관계

> 핵심 관전 포인트: **멀티스레드에서 "내가 쓴 값을 다른 스레드가 언제 보는가"는
> 기본적으로 보장되지 않는다 (컴파일러 재배치 + CPU 캐시 때문).
> happens-before는 JMM이 제공하는 "이 두 연산 사이에서는 앞선 쓰기가
> 뒤 읽기에 반드시 보인다"는 공식 보증 목록이며,
> volatile·synchronized·Thread.start/join 이 전부 이 보증을 만드는 도구다.**

---

## 0. 질문 + 의도

**질문**: "Java Memory Model에서 happens-before 관계란 무엇인가요?"

**출제 의도**: 동시성 코드의 정확성을 "돌려보니 되던데요"가 아니라 규칙으로
논증할 수 있는지를 본다. 이게 되는 사람만 lock-free 코드나 AI가 생성한
동시성 코드를 검증할 수 있다.

## 선행 개념: 왜 이런 규칙이 필요한가

### 문제 1 — 가시성(visibility)

```java
// 스레드 A                        // 스레드 B
sharedFlag = true;                 while (!sharedFlag) { }  // 영원히 안 끝날 수 있음
```

- CPU 코어마다 캐시가 있고, 쓰기가 메인 메모리에 언제 반영될지·다른 코어가
  언제 읽어갈지 보장이 없다
- 스레드 A가 쓴 값을 스레드 B가 **영영 못 볼 수도** 있다

### 문제 2 — 재배치(reordering)

```java
// 프로그래머가 쓴 순서              // 실제 실행될 수 있는 순서
data = 42;        // ①              ready = true;   // ② 먼저!
ready = true;     // ②              data = 42;      // ①
```

- 컴파일러(JIT)와 CPU는 **단일 스레드 안에서 결과가 같기만 하면** 명령을
  자유롭게 재배치해 최적화한다
- 단일 스레드에서는 문제없지만, 다른 스레드가 `ready == true`를 보고
  `data`를 읽으면 42가 아닌 0을 볼 수 있다

**JMM(Java Memory Model)** 은 이 혼돈 속에서 "무엇만은 보장되는가"를 정의한
명세이고, 그 보장의 언어가 **happens-before** 다.

---

## 1. happens-before의 정의

> 연산 A **happens-before** 연산 B 이면:
> ① A의 결과(메모리 쓰기)가 B에게 **반드시 보이고**,
> ② A와 B의 순서가 B의 관점에서 **뒤집혀 보이지 않는다.**

주의할 점 두 가지:

- **시간 순서가 아니라 가시성 보증이다.** "A가 시계상 먼저 실행됐다"는
  happens-before가 아니다. 시계상 먼저 실행돼도 HB 관계가 없으면 안 보일 수 있다.
- **부분 순서(partial order)다.** 모든 연산 쌍에 순서가 있는 게 아니라,
  아래 규칙에 해당하는 쌍에만 순서가 있다. HB 관계가 없는 두 연산은
  서로 어떤 순서로든 보일 수 있다.

---

## 2. happens-before 규칙 목록 (JLS §17.4.5)

| 규칙 | 내용 |
|---|---|
| **프로그램 순서** | 한 스레드 안에서, 코드에 먼저 나온 연산 HB 뒤에 나온 연산 |
| **모니터 락** | `synchronized` 블록의 **unlock** HB 같은 락의 **이후 lock** |
| **volatile** | volatile 변수에 대한 **쓰기** HB 그 변수의 **이후 읽기** |
| **스레드 시작** | `thread.start()` 호출 HB 그 스레드 안의 모든 연산 |
| **스레드 종료** | 스레드의 모든 연산 HB 그 스레드에 대한 `join()` 리턴 |
| **인터럽트** | `interrupt()` 호출 HB 대상 스레드가 인터럽트를 감지하는 시점 |
| **finalizer** | 생성자 끝 HB `finalize()` 시작 |
| **이행성(transitivity)** | A HB B 이고 B HB C 이면 → **A HB C** |

### 프로그램 순서 규칙의 함정

"한 스레드 안에서는 코드 순서대로"는 **그 스레드 관점에서만** 유효하다.
재배치는 여전히 일어난다 — 단지 단일 스레드의 결과가 안 바뀔 뿐.
**다른 스레드가 끼어들면 재배치가 관측된다.** 그래서 스레드 간에는
반드시 아래처럼 동기화 연산으로 HB 다리를 놓아야 한다.

---

## 3. 이행성이 실전의 핵심 — "다리 놓기" 패턴

volatile 규칙 하나가 **일반 변수까지 통째로** 보이게 만드는 이유:

```java
int data = 0;                 // 일반 변수 (volatile 아님!)
volatile boolean ready = false;

// 스레드 A                   // 스레드 B
data = 42;        // ①        if (ready) {          // ③
ready = true;     // ②            print(data);      // ④ 반드시 42
                              }
```

```
① HB ② : 프로그램 순서 (스레드 A 내부)
② HB ③ : volatile 쓰기 → volatile 읽기
③ HB ④ : 프로그램 순서 (스레드 B 내부)
─────────────────────────────────────
∴ ① HB ④ : 이행성 → data=42가 반드시 보인다
```

- volatile 쓰기는 "그 이전에 쓴 **모든 것**을 함께 발행"하고,
  volatile 읽기는 "그 이후 읽는 모든 것의 **가시성 기준점**"이 된다
- `synchronized`도 동일한 구조: unlock 이전의 모든 쓰기가
  같은 락의 lock 이후에 전부 보인다
- 이 패턴을 **safe publication**(안전한 발행)이라 부른다

### 반례 — 다리가 없으면

```java
int data = 0;
boolean ready = false;        // volatile 아님

// 스레드 A                   // 스레드 B
data = 42;                    if (ready)       // true를 볼 수도 있는데
ready = true;                     print(data); // data는 0일 수 있다!
```

②와 ③ 사이에 HB가 없다 → ①②가 재배치되어 B가 `ready=true`를 먼저 볼 수
있고, `data=42`는 영영 안 보일 수도 있다. 이런 상태를 **데이터 레이스**라
부른다: HB 관계 없이 한쪽이 쓰고 다른 쪽이 읽는(또는 둘 다 쓰는) 것.

---

## 4. 도구별 대응 — 무엇이 HB를 만드나

| 도구 | 만들어지는 HB | 상호배제(원자성) |
|---|---|---|
| `synchronized` | unlock HB lock (같은 락) | ✅ 있음 |
| `volatile` | 쓰기 HB 읽기 (같은 변수) | ❌ 없음 (가시성·순서만) |
| `Atomic*` / `VarHandle` CAS | volatile과 동일 시맨틱 | ✅ 해당 연산 한정 |
| `Thread.start()` / `join()` | 호출 전 HB 스레드 내부 / 스레드 내부 HB join 후 | — |
| `java.util.concurrent` 전반 | 문서화된 HB 제공 (예: 큐에 put HB 그 원소 take) | 구현별 |
| `final` 필드 | HB는 아니지만 생성자 완료 후 불변값의 안전한 발행 보장 | — |

- **volatile ≠ 원자성**: `volatile int count`의 `count++`는 여전히 깨진다
  (읽기-계산-쓰기 3단계). 가시성 문제와 원자성 문제는 별개다.
- `java.util.concurrent`의 클래스들은 API 문서에 HB 보증을 명시한다.
  예: `ExecutorService.submit()` 이전 연산 HB 태스크 실행,
  `Future.get()` 리턴 이후에 태스크의 결과가 전부 보임.

---

## 5. 실전 연결: ConcurrentHashMap의 무락 읽기

`concurrenthashmap-internals.md` 에서 본 "get이 락 없이 안전한 이유"가
정확히 happens-before 다:

- `Node.val`, `Node.next`, `table`이 **volatile** → put 스레드의 쓰기 HB
  get 스레드의 읽기 → 락 없이도 최신 값이 보인다
- `Node.key`, `hash`는 **final** → 생성자 완료 후 안전하게 발행
- 즉 "락 = 가시성 도구"라는 등식을 깨고, **가시성은 volatile로,
  상호배제는 (필요한 곳만) synchronized/CAS로** 분리한 설계

---

## 6. 한 문장 결론 (모범답안 요약)

> happens-before는 JMM이 정의한 연산 간 부분 순서로,
> **"A happens-before B이면 A의 메모리 쓰기가 B에 반드시 보이고 순서가
> 뒤집혀 관측되지 않는다"**는 보증이다. 프로그램 순서·모니터 락·volatile·
> start/join 등의 규칙으로 만들어지고 **이행성으로 연결**되며,
> 이 관계가 없는 공유 접근이 곧 데이터 레이스다.
> 실무적으로는 "일반 변수 쓰기들을 volatile 쓰기/unlock 뒤에 실어 보내고,
> volatile 읽기/lock 을 통해 받는" safe publication 패턴으로 활용된다.

---

## 부록: 자주 헷갈리는 포인트 Q&A

**Q1. happens-before는 "시간상 먼저 일어난다"는 뜻인가?**
→ 아니다. 가시성·순서의 **보증**이지 실행 시각이 아니다. 시계상 먼저
실행됐어도 HB 관계가 없으면 다른 스레드에게 안 보일 수 있다. (§1)

**Q2. 한 스레드 안에서는 재배치가 안 일어나나?**
→ 일어난다. 프로그램 순서 규칙은 "그 스레드 혼자 볼 때 결과가 코드 순서와
같다"는 뜻이고, 다른 스레드는 재배치된 순서를 관측할 수 있다.
그래서 스레드 간에는 volatile/락으로 HB 다리를 놓아야 한다. (§2)

**Q3. volatile을 쓰면 원자성도 보장되나?**
→ 아니다. volatile은 가시성과 재배치 금지만 준다. `volatile int`의 `++`는
여전히 3단계 복합 연산이라 깨진다 → `AtomicInteger`(CAS)나 락 필요. (§4)

**Q4. volatile 변수 하나로 일반 변수 여러 개의 가시성을 보장할 수 있는 근거는?**
→ 이행성. "일반 쓰기들 HB volatile 쓰기 HB volatile 읽기 HB 일반 읽기들"로
연결되어 volatile 쓰기 이전의 모든 쓰기가 함께 발행된다(safe publication).
ready 플래그 패턴이 대표 예. (§3)

**Q5. 데이터 레이스의 정확한 정의는?**
→ 서로 다른 스레드의 두 접근이 같은 변수를 대상으로 하고, 적어도 하나가
쓰기이며, 둘 사이에 happens-before 관계가 없는 것. JMM은 레이스가 있는
프로그램의 읽기 결과를 사실상 보증하지 않는다. (§3)

**Q6. synchronized 블록이 비어 있어도 HB 효과가 있나?**
→ 같은 락을 두 스레드가 잡는다면 unlock HB lock 이 성립하므로 이론상 효과는
있다. 하지만 JIT가 무의미한 락을 제거(lock elision)할 수 있어 이런 용법에
의존하면 안 되고, 의도가 가시성이면 volatile을 쓰는 게 맞다. (§2, §4)

**Q7. ConcurrentHashMap의 get이 락 없이 안전한 것과 무슨 관계인가?**
→ `Node.val`/`next`/`table`이 volatile이라 put의 쓰기 HB get의 읽기가
성립하기 때문. 가시성은 volatile로, 상호배제는 필요한 버킷에만
synchronized/CAS로 분리한 설계다. (§5)
