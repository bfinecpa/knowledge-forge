# 동기화 도구 선택 — synchronized vs ReentrantLock vs StampedLock vs Atomic(CAS)

> 핵심 관전 포인트: **기본값은 synchronized다. 현대 JVM에서 경쟁 없는
> synchronized는 매우 싸므로, "성능 때문에" 갈아타는 것은 대부분 근거 없는
> 최적화다. ReentrantLock을 쓰는 진짜 이유는 성능이 아니라 기능(tryLock
> 타임아웃, 인터럽트 가능 대기, 공정성, 다중 Condition)이고, StampedLock은
> 읽기가 압도적으로 많을 때의 특화 도구(낙관적 읽기), Atomic은 보호 대상이
> 변수 하나일 때의 논블로킹 도구다. 그리고 이 넷보다 먼저 물어볼 질문은
> "직접 동기화가 필요하긴 한가?" — 동시성 컬렉션·불변 객체로 해결되면
> 그쪽이 항상 낫다.**

---

## 0. 질문 + 의도

**질문**: "`synchronized`, `ReentrantLock`, `StampedLock`, CAS 기반 Atomic
클래스의 차이와 선택 기준은?"

**출제 의도**: 동기화 도구 선택은 경합 정도와 읽기/쓰기 비율에 따른
트레이드오프 판단이다. 항상 synchronized만 쓰는 사람은 고경합 지점에서
병목을 만들고, 항상 lock-free를 쓰는 사람은 검증 불가능한 코드를 만든다 —
도구별 진짜 선택 근거를 말할 수 있는지를 본다.

## 1. synchronized — "문 잠그고 들어가는 방"

JVM이 언어 차원에서 제공하는 잠금. 블록을 벗어나면 **자동으로 잠금이
풀리기 때문에** 실수로 잠금을 안 푸는 사고가 원천적으로 없다.

```java
private final Object lock = new Object();
private int count = 0;

public void increment() {
    synchronized (lock) {   // 한 번에 한 스레드만 진입
        count++;
    }                        // 블록 끝나면 자동 해제 (예외가 터져도 해제됨)
}
```

- **장점**: 코드가 단순하고, 잠금 해제를 까먹을 수 없다. JVM이 지속적으로
  최적화해 와서(락 생략·락 병합·적응형 스핀 등) 경쟁이 적을 때는 성능도
  충분히 좋다.
- **단점**: 유연성이 없다. "잠금 시도해보고 안 되면 포기", "3초만 기다려보기",
  "대기 순서 보장(공정성)" 같은 것이 전부 불가능하다. 잠금 대기 중인
  스레드는 인터럽트로 깨울 수도 없다.

---

## 2. ReentrantLock — "synchronized + 옵션 패키지"

synchronized가 못 하는 것들을 메서드로 제공하는 잠금 클래스. 대신
**해제를 직접 해야 해서** `try-finally`가 필수다.

```java
private final ReentrantLock lock = new ReentrantLock();

public boolean transfer() throws InterruptedException {
    // 잠금을 "시도"만 해보고, 1초 안에 못 얻으면 포기 — synchronized로는 불가능
    if (!lock.tryLock(1, TimeUnit.SECONDS)) {
        return false;   // 무한 대기 대신 실패 처리 (데드락 회피에 유용)
    }
    try {
        // 임계 영역
        return true;
    } finally {
        lock.unlock();   // 반드시 직접 해제 — 까먹으면 영원히 잠김
    }
}
```

synchronized 대비 추가로 할 수 있는 것:

| 기능 | 설명 |
|---|---|
| `tryLock()` / `tryLock(timeout)` | 못 얻으면 포기하거나 제한시간만 대기 |
| `lockInterruptibly()` | 잠금 대기 중에도 인터럽트로 깨울 수 있음 |
| `new ReentrantLock(true)` | 공정 모드 — 오래 기다린 스레드부터 잠금 획득 (기아 방지, 대신 처리량 하락) |
| `newCondition()` 여러 개 | 하나의 잠금에 대기실을 여러 개 둠. 예: 큐에서 "안 비었음" 대기실과 "안 찼음" 대기실을 분리 (synchronized의 wait/notify는 대기실이 하나뿐) |

---

## 3. StampedLock — "읽기가 대부분일 때의 특화 잠금"

핵심은 **낙관적 읽기(optimistic read)**. "읽는 동안 아무도 안 고치겠지"라고
가정하고 잠금 없이 읽은 뒤, 다 읽고 나서 **그 가정이 맞았는지 검증**만 한다.
쓰기가 드물면 검증이 거의 항상 성공하므로, 읽기 비용이 사실상 0에 가까워진다.

```java
private final StampedLock sl = new StampedLock();
private double x, y;

public double distance() {
    long stamp = sl.tryOptimisticRead();  // 잠금 없이 "도장"만 받음
    double cx = x, cy = y;                // 일단 지역 변수로 복사해서 읽는다
    if (!sl.validate(stamp)) {            // 읽는 동안 쓰기가 있었나 검증
        stamp = sl.readLock();            // 있었다면 그때만 진짜 읽기 잠금으로 재시도
        try {
            cx = x;
            cy = y;
        } finally {
            sl.unlockRead(stamp);
        }
    }
    return Math.sqrt(cx * cx + cy * cy);
}
```

- **장점**: 읽기 위주 워크로드에서 `ReentrantReadWriteLock`보다 확실히
  빠르다 (읽기 잠금조차 안 잡으니까).
- **단점(주의점이 많다)**:
  - **재진입 불가** — 같은 스레드가 잠금을 두 번 잡으면 데드락. 잠금 잡은
    채로 다른 메서드를 호출하는 구조면 위험하다.
  - Condition 지원 없음.
  - 낙관적 읽기 중에는 **찢어진 값(중간 상태)** 을 읽을 수 있으므로, 반드시
    지역 변수에 복사한 뒤 `validate()` 통과 후에만 사용해야 한다. 코드
    패턴을 정확히 지켜야 해서 실수 여지가 크다.

---

## 4. Atomic 클래스 (CAS 기반) — "잠금 없이 변수 하나 지키기"

`AtomicInteger`, `AtomicLong`, `AtomicReference` 등은 잠금 대신 CPU의
**CAS(Compare-And-Swap)** 명령을 쓴다. CAS는 "현재 값이 내가 알던 A가
맞으면 B로 바꿔줘, 아니면 실패 알려줘"를 하드웨어가 원자적으로 처리하는
연산이다. 실패하면 성공할 때까지 다시 시도한다.

```java
// before: 잠금 방식
private int count = 0;

public synchronized void increment() {
    count++;
}

// after: CAS 방식 — 잠금이 없으니 스레드가 블로킹(대기 상태로 잠들기)되지 않음
private final AtomicInteger count = new AtomicInteger();

public void increment() {
    count.incrementAndGet();
}
```

- **장점**: 스레드가 잠들지 않으므로(논블로킹) 문맥 교환 비용이 없고,
  경쟁이 낮거나 중간 수준일 때 잠금보다 빠르다.
- **단점**:
  - **변수 하나짜리 연산에만** 적합. "계좌 A에서 빼고 B에 더하기"처럼
    여러 변수를 한 덩어리로 바꿔야 하면 CAS로는 안 되고 잠금이 필요하다.
  - 경쟁이 극심하면 CAS 실패→재시도가 반복돼 CPU만 태울 수 있다. 이럴 때
    카운터 용도라면 `LongAdder`가 대안 — 내부적으로 카운터를 여러 칸으로
    쪼개 경쟁 자체를 분산시킨다 (대신 정확한 순간값 읽기는 약하다).

---

## 5. 선택 기준 정리

```
보호 대상이 변수 하나인가?
 ├─ 예 → Atomic (카운터인데 경쟁 극심 → LongAdder)
 └─ 아니오 (여러 변수/복합 로직)
     ├─ 특별한 요구 없음 → synchronized  ← 기본값
     ├─ 타임아웃·인터럽트·공정성·Condition 여러 개 필요 → ReentrantLock
     └─ 읽기 ≫ 쓰기 (예: 읽기 99%)
         ├─ 성능이 정말 병목이고 코드 패턴 감당 가능 → StampedLock
         └─ 재진입 필요하거나 안전하게 가려면 → ReentrantReadWriteLock
```

실무 감각으로 덧붙이면:

- **성능 때문에 synchronized를 피하는 건 대부분 근거 없는 최적화**다.
  현대 JVM에서 경쟁 없는 synchronized는 매우 싸다. 측정으로 병목이
  확인됐을 때만 갈아탄다.
- ReentrantLock을 쓰는 진짜 이유는 성능이 아니라 **기능**(tryLock으로
  데드락 회피, 공정성, 다중 Condition)이다.
- StampedLock은 성능은 최고지만 오용하기 쉬운 도구라, "읽기 극단적으로
  많음 + 성능 측정으로 병목 확인됨 + 재진입 없음"이 다 맞을 때만 쓴다.
- 그리고 이 넷보다 먼저 물어볼 질문: **직접 동기화가 필요하긴 한가?**
  `ConcurrentHashMap`, `BlockingQueue` 같은 동시성 컬렉션이나 불변 객체로
  해결되면 그쪽이 항상 낫다.
