# 데드락 — 스레드 덤프에서 찾는 법, 성립 4조건, 코드 레벨 예방 전략

> 핵심 관전 포인트: **데드락은 4가지 조건(Coffman)이 전부 동시에 성립해야만
> 발생하므로, 예방이란 "그중 하나를 구조적으로 깨는 것"이다.
> 코드 레벨의 정석은 순환 대기를 깨는 전역 락 순서(lock ordering) 규칙이고,
> 순서를 통제할 수 없을 때의 차선책은 점유 대기/비선점을 완화하는
> tryLock 타임아웃 + 백오프다. 진단은 JVM이 스레드 덤프 맨 끝에
> `Found one Java-level deadlock`으로 답을 써주지만, j.u.c 락과
> 유사 증상(스레드풀 고갈 등)을 오독하지 않는 게 실력 포인트.**

---

## 0. 질문 + 의도

**질문**: "스레드 덤프에서 데드락을 어떻게 찾나요? 데드락의 4가지 조건과
실무적 예방 방법은?"

**출제 의도**: 데드락은 서비스가 "죽지 않고 멈추는" 형태라 재시작으로 덮기
쉽고, 근본 원인을 못 찾으면 반복된다. 덤프를 읽어 락 순환을 찾는 능력은
반복 장애를 끊는 능력이며, 4조건과 예방 전략까지 답할 수 있는지로 재발
방지책을 설계할 수 있는 사람인지를 가린다.

## 1. 스레드 덤프에서 데드락 찾기

### 1-1. 가장 빠른 방법 — JVM 자동 탐지 문구

`jcmd <pid> Thread.print` / `jstack <pid>` / `kill -3 <pid>`로 뜬 덤프의
**맨 아래**를 먼저 본다. JVM이 데드락을 자동 탐지해서 결론까지 써준다:

```
Found one Java-level deadlock:
=============================
"Thread-A":
  waiting to lock monitor 0x00007f... (object 0x000000076b..., a java.lang.Object),
  which is held by "Thread-B"
"Thread-B":
  waiting to lock monitor 0x00007f... (object 0x000000076c..., a java.lang.Object),
  which is held by "Thread-A"

Java stack information for the threads listed above: ...
Found 1 deadlock.
```

`synchronized` 모니터 락뿐 아니라 `ReentrantLock` 등
`java.util.concurrent` 락(ownable synchronizer)도 탐지 대상이다.

### 1-2. 수동으로 찾기 — 락 주소로 사이클 추적

1. 상태가 `BLOCKED (on object monitor)`인 스레드를 모은다
   (`ReentrantLock` 대기는 `WAITING (parking)` + `parking to wait for <0x...>`)
2. 각 스레드의 `- waiting to lock <0x주소>` 와 `- locked <0x주소>` 를 대조
3. "A가 기다리는 락을 B가 쥐고, B가 기다리는 락을 A가 쥔" **순환 고리** 확인

```
"Thread-A": BLOCKED
    - waiting to lock <0x...c90>     ← B가 쥔 락
    - locked <0x...c80>              ← A가 쥔 락

"Thread-B": BLOCKED
    - waiting to lock <0x...c80>     ← A가 쥔 락  → 사이클 성립
    - locked <0x...c90>
```

- 락 주소 짝 맞추기는 **한 덤프 안에서만** 유효 (GC로 객체 이동 시 주소가 바뀜)
- 코드 레벨 상시 탐지: `ThreadMXBean.findDeadlockedThreads()` —
  헬스체크·모니터링에 심어 런타임 감지 가능

### 1-3. 함정 — 덤프에 deadlock 문구가 없는데도 멈춰 있다면

데드락이 아니라 유사 증상일 수 있다. `WAITING` 스레드들의 **스택 위치**로 판별:

- **스레드풀 고갈** — 모든 워커가 외부 I/O·`getConnection` 등에서 대기
- **커넥션 풀 데드락** — 한 스레드가 커넥션 2개를 필요로 하는 구조에서 풀 소진
- **라이브락** — 상태는 계속 바뀌는데 진전이 없음 (덤프 여러 장 비교로만 확인)
- `ReentrantLock` 데드락인데 `jstack`에 `-l` 옵션을 안 줘서 소유자 정보
  ("Locked ownable synchronizers" 섹션)를 못 본 경우

---

## 2. 데드락 성립 4조건 (Coffman 조건)

**4가지가 모두 동시에 성립해야** 데드락이 발생한다. 역으로, 하나만 깨면 예방된다.

| 조건 | 의미 | 이걸 깨는 실무 기법 |
|---|---|---|
| **상호 배제** (Mutual Exclusion) | 자원을 한 번에 한 스레드만 사용 | 락 프리 자료구조·CAS, 불변 객체 |
| **점유 대기** (Hold and Wait) | 자원을 쥔 채 다른 자원을 기다림 | 필요한 락 한 번에 획득, tryLock 실패 시 전부 반납 |
| **비선점** (No Preemption) | 남이 쥔 자원을 강제로 뺏을 수 없음 | 타임아웃 있는 락 (`tryLock(timeout)`) |
| **순환 대기** (Circular Wait) | 대기 관계가 원형 고리를 이룸 | **전역 락 순서 고정** ← 가장 표준 |

---

## 3. 실무 예방 방법

- **락 순서 고정 (lock ordering)** — 순환 대기 제거. 가장 표준적 (→ 4장)
- **타임아웃 있는 락 획득** — `ReentrantLock.tryLock(timeout)`.
  못 잡으면 쥔 락을 놓고 물러남 (→ 5장)
- **락 자체를 줄이기** — `ConcurrentHashMap`, `AtomicLong` 같은 동시성
  자료구조·CAS, 불변 객체, 스레드 한정(thread confinement)
- **락 범위 최소화 + open call** — 락을 쥔 채 외부 메서드(콜백, 다른 객체의
  synchronized 메서드, DB/네트워크 호출)를 부르지 않는다.
  락 안에서 무슨 락을 또 잡을지 예측 불가능해지는 것이 데드락의 온상
- **한 번에 하나의 락만** — 애초에 락 2개가 필요 없게 설계.
  락 분할 대신 단일 락, 또는 메시지 큐/단일 스레드 이벤트 루프로 접근 직렬화
- **DB도 같은 원리** — 여러 행 갱신 시 항상 같은 순서(예: PK 오름차순),
  `SELECT ... FOR UPDATE` 순서 통일. DB 데드락도 순환 대기가 본질

---

## 4. [면접] 코드 레벨 원천 차단 규칙 하나 — 전역 락 순서(lock ordering)

### 4-1. 규칙

**"어떤 스레드든 락1과 락2를 둘 다 잡아야 한다면, 반드시 정해진 전역
순서(예: 락1 → 락2)로만 잡는다."**

모든 스레드가 같은 순서로 잡으면 순환 대기 조건이 **구조적으로 성립 불가**
→ 데드락 원천 차단. 전형적 발생 코드(A: 락1→락2, B: 락2→락1)에서
B를 락1→락2로 고치면 끝.

### 4-2. 락 객체가 동적으로 정해질 때 — 고유값으로 순서 정규화

`transfer(from, to)` 계좌 이체처럼 호출에 따라 인자 순서가 뒤집히는 경우:

```java
void transfer(Account a, Account b) {
    Account first  = a.getId() < b.getId() ? a : b;
    Account second = a.getId() < b.getId() ? b : a;
    synchronized (first) {
        synchronized (second) { /* 이체 */ }
    }
}
```

고유 ID가 없으면 `System.identityHashCode(a) < identityHashCode(b)` 비교 +
**동률일 때만 tie-breaking 락**을 추가로 잡는 패턴
(Java Concurrency in Practice의 정석 풀이).

---

## 5. [면접] 순서를 통제할 수 없을 때의 차선책 — tryLock 타임아웃 + 백오프

서드파티 라이브러리가 내부에서 락을 잡거나, 콜백 안에서 락 획득이 일어나는 등
**락 순서를 코드로 강제할 수 없는 상황**에서는 "무한정 기다리지 않는 것"으로 대응:

```java
while (true) {
    if (lock1.tryLock(timeout, MILLISECONDS)) {
        try {
            if (lock2.tryLock(timeout, MILLISECONDS)) {
                try { /* 작업 */ return; }
                finally { lock2.unlock(); }
            }
        } finally { lock1.unlock(); }
    }
    Thread.sleep(randomBackoff());   // 랜덤 백오프 후 재시도
}
```

핵심 포인트 3가지:

1. 데드락을 **예방**하는 게 아니라, 걸려도 **빠져나오게** 하는 전략
   (비선점 조건을 깨는 효과)
2. 실패 시 **쥐고 있던 락을 전부 놓고** 물러나야 한다 — 그래야 점유 대기가 풀림
3. 재시도에 **랜덤 백오프** 필수 — 없으면 두 스레드가 계속 동시에
   잡았다 놨다 반복하는 **라이브락**으로 변질

추가 차선책:

- `ThreadMXBean` 기반 **탐지 후 복구** — 모니터링 + 알람/재시작
- **설계 변경으로 우회** — 해당 자원 접근을 단일 스레드 큐로 직렬화

> 한 줄 요약: "덤프 맨 끝의 Found deadlock 문구 또는 BLOCKED 스레드들의
> locked/waiting to lock 주소 사이클로 찾는다. 성립 조건은 상호배제·점유대기·
> 비선점·순환대기 4가지가 동시에 만족될 때고, 예방은 하나를 깨는 것 —
> 정석은 전역 락 순서로 순환 대기를 원천 차단(동적 락은 ID 정규화 + tie-breaking),
> 순서 통제가 불가능하면 tryLock 타임아웃 + 전부 반납 + 랜덤 백오프로
> 걸려도 빠져나오게 한다"
