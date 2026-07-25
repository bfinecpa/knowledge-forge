# ConcurrentHashMap 내부 메커니즘 — 버킷 단위 락 + CAS, 무락 읽기

> 핵심 관전 포인트: **동시성 자료구조의 설계는 결국 "락의 범위를 얼마나 좁히고,
> 어디까지 락 없이 처리하느냐"의 문제다.
> ConcurrentHashMap은 쓰기를 "빈 버킷이면 CAS, 있으면 head 노드 synchronized"로
> 락 범위를 버킷 1개까지 좁혔고, 읽기는 volatile의 happens-before 보장에 기대어
> 아예 락을 없앴다. 그 대가가 약한 일관성(weak consistency)이다.**

---

## 0. 질문 + 의도

**질문**: "`ConcurrentHashMap`은 어떻게 thread-safe를 보장하나요?
`Collections.synchronizedMap`과의 차이는?"

**출제 의도**: "thread-safe 컬렉션을 쓰면 안전하다"는 착각(복합 연산은
여전히 원자적이지 않음)을 갖고 있는지 검사한다. 이 착각은 부하가 걸려야만
드러나는 최악의 버그를 만들기에, 내부 락 구조까지 정확한 동작 모델을 갖고
있는지를 본다.

## 선행 개념: CAS (Compare-And-Swap)

**"현재 값이 내가 기대한 값이면 새 값으로 바꿔라"**를 하나의 원자적 연산으로
수행하는 CPU 명령어 (x86의 `CMPXCHG` 등 하드웨어 명령).

```
CAS(메모리 위치 V, 기대값 A, 새 값 B)
→ V의 현재 값이 A와 같으면 B로 교체하고 true
→ 다르면 아무것도 안 하고 false
```

### 왜 필요한가

`count++`는 사실 "읽기 → 계산 → 쓰기" 3단계 → 두 스레드가 동시에 하면 갱신 유실.
락으로 감싸면 해결되지만 블로킹 비용이 크다. CAS는 락 없이 이렇게 푼다:

```java
// AtomicInteger.incrementAndGet()의 동작 원리
do {
    int current = value;          // 1. 현재 값 읽기
    int next = current + 1;       // 2. 새 값 계산
} while (!compareAndSet(current, next));  // 3. "아직 current면 next로" 시도
// 실패 = 그 사이 누가 바꿈 → 다시 읽어서 재시도
```

- 실패해도 스레드가 잠들지 않고 즉시 재시도 → **논블로킹(lock-free)**
- 경합이 적으면 락보다 훨씬 쌈 / 경합이 극심하면 재시도 반복으로 오히려 손해
- `AtomicInteger`, `AtomicReference`, `LongAdder` 전부 CAS 기반
  (내부적으로 `Unsafe`/`VarHandle`의 compareAndSet 계열 호출)

**ABA 문제**: 값이 A→B→A로 바뀌면 CAS는 "안 바뀌었다"고 착각.
대부분(참조 교체, 카운터)은 문제없지만, 필요하면 `AtomicStampedReference`처럼
버전 스탬프를 함께 비교해 해결.

---

## 1. 전체 구조 — Java 7 vs Java 8의 락 단위 변화

내부는 `HashMap`처럼 `Node<K,V>[] table` 배열 하나.

| | Java 7까지 | Java 8부터 |
|---|---|---|
| 락 구조 | `Segment` 배열 (기본 16개, 락 스트라이핑) | Segment 제거, **버킷의 head 노드 자체가 락** |
| 락 단위 | 테이블의 1/16 | **버킷 1개** |
| 동시 쓰기 상한 | 세그먼트 수 (기본 16) | 이론상 버킷 수 N |

체인이 8개 초과 + 테이블 64 이상이면 레드블랙 트리(`TreeBin`)로 전환되는 것도
HashMap과 동일 (이때 락은 TreeBin 노드에 걸림).

---

## 2. 쓰기(put) 경로 — CAS와 synchronized의 역할 분담

`putVal()`은 버킷 상태에 따라 두 가지 전략을 쓴다.

### 2-1. 빈 버킷이면 → CAS (락 없음)

```java
if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
    if (casTabAt(tab, i, null, new Node<>(hash, key, value)))
        break;  // 성공하면 끝. 락을 아예 안 잡음
}
```

- "그 슬롯이 여전히 null이면 새 노드를 꽂는다"를 원자적으로 시도
- 경합 없으면 락 비용 0
- CAS 실패(다른 스레드가 먼저 꽂음) → 루프 돌아 아래 락 경로로

### 2-2. 버킷에 이미 노드가 있으면 → 첫 노드에 synchronized

```java
synchronized (f) {   // f = 해당 버킷의 head 노드
    if (tabAt(tab, i) == f) {  // 락 잡은 사이 head가 안 바뀌었는지 재확인
        // 체인 순회하며 덮어쓰기 or 꼬리에 추가
    }
}
```

- **락의 범위 = 그 버킷 하나** → 서로 다른 버킷에는 동시 쓰기 가능
- `tabAt(tab, i) == f` 재검사 이유: 락을 기다리는 동안 리사이즈/트리화로
  head 노드가 교체됐을 수 있음 → 교체됐으면 재시도

---

## 3. 읽기(get) — 락이 전혀 없는 이유

```java
public V get(Object key) {
    // synchronized도, CAS 재시도 루프도 없음
    Node<K,V> e = tabAt(tab, (n - 1) & h);
    ...
}
```

무락(lock-free) 읽기의 근거: **가시성(visibility)을 락 대신 volatile로 보장.**

| 필드 | 선언 | 역할 |
|---|---|---|
| `Node.val`, `Node.next` | **volatile** | 쓰기 스레드의 갱신이 happens-before로 읽기 스레드에 즉시 보임 |
| `table` | volatile + `tabAt()`은 `Unsafe.getObjectAcquire`(volatile read 시맨틱) | 슬롯 접근 가시성 |
| `Node.key`, `hash` | **final** | 생성 이후 불변 → 안전한 발행(safe publication) |

읽기 스레드는 "그 순간의 일관된 스냅샷 노드"를 따라가기만 하면 되고,
쓰는 쪽과 충돌할 게 없다 → get은 경합이 아무리 심해도 블로킹되지 않음.

---

## 4. 트레이드오프: 약한 일관성 (weakly consistent)

무락 읽기의 대가:

- **get**: 락으로 직렬화된 최신 상태가 아니라 "어느 시점엔가 유효했던 상태" 반환 가능
- **iterator**: 순회 중 발생한 수정이 보일 수도, 안 보일 수도 있음.
  `ConcurrentModificationException`을 던지지 않음 (fail-safe)
- **size()**: 정확한 순간값이 아닌 근사치

---

## 5. 곁들이면 좋은 두 가지

### 5-1. size 집계 — CounterCell 분산

모든 스레드가 하나의 count 필드를 CAS하면 그게 병목
→ `LongAdder`와 같은 원리의 **`baseCount + CounterCell[]`**로 카운트를 분산,
`size()` 호출 시 합산.

### 5-2. 협력적 리사이즈 — helpTransfer

- 리사이즈 중인 버킷에는 `ForwardingNode`(hash = MOVED)가 꽂힘
- put 하러 온 스레드가 이걸 만나면 대기하는 대신 `helpTransfer()`로
  **리사이즈 작업을 나눠서 돕는다**
- 그동안 get은 ForwardingNode를 통해 새 테이블로 넘어가 읽기를 계속

---

## 6. 한 문장 결론

> 쓰기는 "빈 버킷이면 CAS, 있으면 head 노드에 synchronized"로
> 락 범위를 버킷 1개로 최소화하고,
> 읽기는 volatile 필드(val/next/table)의 happens-before 보장에 기대어
> 락 없이 수행한다. 그 대가로 읽기·순회·size는 약한 일관성을 가진다.

---

## 부록: 자주 헷갈리는 포인트 Q&A

**Q1. Java 8 CHM에도 Segment가 있나?**
→ 없다. Java 7까지의 구조(기본 16개 세그먼트, 락 스트라이핑)이고,
Java 8에서 제거되어 버킷 head 노드 자체를 락으로 쓴다. 락 단위가
테이블의 1/16 → 버킷 1개로 훨씬 잘게 쪼개졌다. (§1)

**Q2. put은 항상 락을 잡나?**
→ 아니다. 빈 버킷이면 CAS만으로 삽입하고 락을 아예 안 잡는다.
버킷에 노드가 이미 있을 때만 head 노드에 synchronized. (§2)

**Q3. get이 락 없이도 안전한 근거는?**
→ `Node.val`/`Node.next`/`table`이 volatile이라 happens-before로 가시성이
보장되고, `key`/`hash`는 final이라 안전하게 발행된다. 읽기는 스냅샷을
따라가기만 하면 되므로 쓰기와 충돌하지 않는다. (§3)

**Q4. 락을 잡은 뒤 `tabAt(tab, i) == f`를 다시 확인하는 이유는?**
→ 락을 기다리는 동안 리사이즈나 트리화로 head 노드가 교체됐을 수 있어서.
교체됐으면 그 락은 무효 → 루프 돌아 재시도. (§2-2)

**Q5. size()는 왜 정확하지 않나?**
→ 단일 count 필드 CAS는 병목이라 `baseCount + CounterCell[]`로 분산 집계하고
호출 시 합산하기 때문. 합산하는 동안에도 맵은 변하므로 근사치다. (§4, §5-1)

**Q6. CAS가 락보다 항상 빠른가?**
→ 아니다. 경합이 적으면 블로킹이 없어 훨씬 싸지만, 경합이 극심하면
재시도가 반복되며 오히려 손해일 수 있다. CHM이 "빈 버킷=CAS 1회 시도,
실패하면 synchronized"로 섞어 쓰는 이유다. (선행 개념 절, §2)
