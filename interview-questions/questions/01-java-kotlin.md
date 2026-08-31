# 1. Java / Kotlin 언어

## 기본 ⭐

- JVM 메모리 구조(Heap, Stack, Metaspace)를 설명해주세요. 객체는 어디에 생성되나요?
- GC가 동작하는 원리를 설명해주세요. Young/Old 영역은 왜 나뉘어 있나요?
- `equals()`와 `hashCode()`를 함께 재정의해야 하는 이유는 무엇인가요?
- String이 불변(immutable)인 이유와 그로 인한 장점은 무엇인가요? `StringBuilder`는 언제 쓰나요?
- Checked Exception과 Unchecked Exception의 차이는? 실무에서 어떤 기준으로 선택하나요?
- 인터페이스와 추상 클래스의 차이, 각각 언제 사용하나요?
- `final` 키워드가 클래스/메서드/변수에 붙었을 때 각각 어떤 의미인가요?
- Java 8 이후 추가된 주요 기능(Stream, Optional, 람다)을 실무에서 어떻게 활용했나요?

<!-- - Kotlin의 null safety(`?`, `!!`, `?:`)를 설명해주세요. Java와 상호운용 시 플랫폼 타입이란? -->
<!-- - Kotlin의 `data class`, `sealed class`는 어떤 상황에 유용한가요? -->

- enum을 단순 상수 집합 이상으로 활용하는 패턴(전략 메서드 보유, 허용 상태 전이 정의)을 설명해주세요.

## 중급 ⭐⭐

- G1 GC와 ZGC의 차이를 설명해주세요. 지연시간(latency)에 민감한 서비스라면 무엇을 선택하겠습니까?
- GC 튜닝 경험이 있나요? Full GC가 자주 발생할 때 어떤 순서로 원인을 추적하나요?
- `HashMap`의 내부 동작(해시 충돌 처리, 리사이징, 트리화)을 설명해주세요.
- `ConcurrentHashMap`은 어떻게 thread-safe를 보장하나요? `Collections.synchronizedMap`과의 차이는?
- `volatile` 키워드는 무엇을 보장하고, 무엇을 보장하지 못하나요? (가시성 vs 원자성)
- Java Memory Model에서 happens-before 관계란 무엇인가요?
- ThreadLocal은 언제 쓰고, 톰캣 같은 스레드풀 환경에서 어떤 위험이 있나요?
- Stream의 `parallelStream()`을 실무에서 함부로 쓰면 안 되는 이유는?

<!-- - Kotlin Coroutine의 동작 원리(CPS 변환, suspend)를 설명해주세요. 스레드와의 차이는? -->
<!-- - Coroutine의 `Dispatchers.IO`와 `Dispatchers.Default`의 차이와 사용 기준은? -->

- 제네릭의 타입 소거(type erasure)란? 런타임에 타입 정보가 없어서 생기는 실무 제약은? 와일드카드(`? extends`, `? super`)의 사용 기준(PECS)은?
- `Optional`을 필드나 메서드 파라미터에 쓰지 말라는 권고의 이유는? 실무에서 `Optional`의 올바른 사용 범위는 어디까지인가요?
- try-with-resources는 어떤 문제를 해결하나요? 자원 누수가 발생하는 전형적인 코드 패턴은?
- 방어적 복사(defensive copy)란? getter로 내부 컬렉션을 그대로 반환하면 어떤 문제가 생기나요?
- AI가 생성한 코드에서 `SimpleDateFormat`을 static 필드로 공유하고 있습니다. 무엇이 문제이고, 같은 유형(공유 가변 상태)의 함정을 코드베이스 어디에서 더 찾아보겠습니까?

## 고난이도 ⭐⭐⭐

- OutOfMemoryError가 발생했습니다. 힙 덤프 분석부터 원인 규명까지의 과정을 구체적으로 설명해주세요.
- 스레드 덤프에서 데드락을 어떻게 찾나요? 데드락의 4가지 조건과 실무적 예방 방법은?
- JIT 컴파일러의 동작(C1/C2, 인라이닝, 탈최적화)이 성능에 미치는 영향을 설명해주세요.
- `synchronized`, `ReentrantLock`, `StampedLock`, CAS 기반 Atomic 클래스의 차이와 선택 기준은?
- False sharing이란 무엇이고 어떻게 회피하나요?
- Virtual Thread(Project Loom)는 기존 스레드 모델과 무엇이 다른가요? pinning 문제란?

<!-- - Kotlin Coroutine의 structured concurrency가 왜 중요한가요? `GlobalScope`가 위험한 이유는? -->

## 알면 좋은 +α

- Java의 record는 언제 쓰나요? <!-- Kotlin의 data class와 무엇이 다른가요? -->
- `Integer a = 127, b = 127`일 때 `a == b`는 true인데 128이면 false인 이유는? 이런 코드의 위험은 무엇인가요?
- Strong/Soft/Weak 참조의 차이는? WeakHashMap은 어떤 용도에 쓰나요?

<!-- - Kotlin의 inline 함수와 reified 타입 파라미터는 어떤 문제를 해결하나요? -->

- `BigDecimal`의 `equals`와 `compareTo`가 다르게 동작하는 경우는? 금액 비교 코드에서 어떤 버그를 만드나요?
