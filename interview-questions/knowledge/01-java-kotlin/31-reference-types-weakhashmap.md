# Strong / Soft / Weak 참조와 WeakHashMap — GC 관점의 참조 강도

> 핵심 관전 포인트: **자바의 참조는 "GC가 이 객체를 언제 수거할 수 있는가"
> 기준으로 강도가 나뉜다. Strong 참조는 살아있는 한 절대 수거되지 않고,
> Soft 참조는 메모리가 부족해질 때만 수거되며, Weak 참조는 다음 GC 사이클에
> 바로 수거된다. WeakHashMap은 키를 Weak 참조로 들고 있어서, 키 객체를
> 외부에서 아무도 참조하지 않으면 엔트리가 자동으로 제거되는 맵이다 —
> "객체의 생명주기를 맵이 방해하지 않게" 하고 싶을 때 쓴다.**

---

## 0. 질문 + 의도

**질문**: "Strong/Soft/Weak 참조의 차이는? WeakHashMap은 어떤 용도에
쓰나요?"

**출제 의도**: 로컬 캐시·리스너 보관 자료구조에서 메모리 누수를 만들지 않는
도구(WeakHashMap 등)의 기반 지식이다. GC와 참조의 상호작용까지 아는 깊이의
표본으로, 힙에 오래 남는 자료구조를 설계할 때 생명주기를 의식하는 사람인지를
본다.

## 1. 참조 강도란 무엇인가

GC의 판단 기준은 "이 객체에 도달할 수 있는가(reachability)"인데,
**어떤 종류의 참조로 도달하느냐**에 따라 수거 시점이 달라진다.

| 참조     | 수거 시점                       | 비유                        |
|--------|-----------------------------|---------------------------|
| Strong | 참조가 끊기기 전엔 절대 수거 안 됨        | 내 책상 위의 물건                |
| Soft   | 메모리가 부족(OOM 직전)할 때만 수거      | 창고의 물건 — 자리가 없으면 버림       |
| Weak   | 다음 GC 때 바로 수거               | 포스트잇 — 청소하면 무조건 버림        |

```java
// Strong: 우리가 평소에 쓰는 모든 참조
Object strong = new Object();          // strong이 살아있는 한 GC 대상 아님

// Soft: 메모리가 부족해지기 전까지는 살려둠
SoftReference<byte[]> soft = new SoftReference<>(new byte[1024 * 1024]);
byte[] data = soft.get();              // 아직 수거 안 됐으면 객체, 수거됐으면 null

// Weak: GC가 돌면 바로 수거
WeakReference<Object> weak = new WeakReference<>(new Object());
System.gc();
weak.get();                            // 거의 확실히 null
```

**공통 주의점**: Soft/Weak 참조는 `get()`이 언제든 `null`을 돌려줄 수 있다.
사용하는 쪽은 항상 null 체크 후 재생성하는 로직이 필요하다.

```java
byte[] cached = soft.get();
if (cached == null) {
    cached = loadExpensiveData();               // 수거됐으면 다시 만든다
    soft = new SoftReference<>(cached);
}
```

## 2. 각 참조의 실무 용도

### Soft — "메모리가 남으면 캐시, 부족하면 버림"

메모리 여유가 있는 동안만 갖고 있으면 되는 데이터에 쓴다.
다만 **수거 시점이 JVM 재량이라 예측이 어렵다**는 단점 때문에,
실무 캐시는 Caffeine/Ehcache처럼 크기·시간 기반으로 명시적으로
제어하는 라이브러리를 더 선호한다.

### Weak — "다른 곳에서 쓰는 동안만 나도 알고 있으면 됨"

객체의 수명을 **내가 연장하고 싶지 않을 때** 쓴다.
"본체가 살아있는 동안만 유효한 부가 정보"를 들고 있는 쪽에 적합하다.
→ 이것이 WeakHashMap으로 이어진다.

### Phantom — (가산점 포인트)

네 번째 참조. `get()`이 **항상 null**이고, 객체가 수거된 뒤
ReferenceQueue를 통해 후처리(네이티브 리소스 정리 등)를 하기 위한
용도다. `finalize()`의 안전한 대체재로, Java 9+의 `Cleaner`가
내부적으로 사용한다.

## 3. WeakHashMap — 키가 죽으면 엔트리도 죽는 맵

일반 HashMap은 키를 Strong 참조로 들고 있어서,
**맵에 넣는 순간 그 객체는 맵이 사라질 때까지 절대 GC되지 않는다.**
이것이 메모리 누수의 흔한 원인이다.

```java
// Before: HashMap — 메모리 누수
Map<User, Session> map = new HashMap<>();
User user = new User("kim");
map.put(user, session);
user = null;   // 외부 참조를 끊어도...
// map이 키를 강하게 붙잡고 있어서 User는 영원히 GC 안 됨

// After: WeakHashMap — 자동 정리
Map<User, Session> map = new WeakHashMap<>();
User user = new User("kim");
map.put(user, session);
user = null;   // 외부에서 아무도 User를 참조하지 않으면
// 다음 GC 때 User가 수거되고, 해당 엔트리도 맵에서 자동 제거됨
```

### 대표적인 사용처

1. **객체에 부가 정보 붙이기** — 원본 클래스를 수정할 수 없는 객체에
   메타데이터를 연결하되, 원본이 죽으면 메타데이터도 같이 사라지게
   하고 싶을 때. (예: ClassLoader별 캐시 — 클래스로더가 언로드되면
   캐시도 자동 정리)
2. **리스너/콜백 등록 관리** — 등록만 하고 해제를 깜빡해도
   누수가 안 생기게.
3. **수명 짧은 캐시** — 캐시 때문에 원본 객체가 메모리에
   잡혀있으면 안 되는 경우.

## 4. 꼬리질문 대비 포인트

### "값도 Weak인가요?"

아니다. **키만 Weak이고 값은 Strong이다.** 그래서 값이 키를 참조하면
키가 영영 수거되지 않아 WeakHashMap의 의미가 사라진다.

```java
// 안티패턴: 값이 키를 붙잡는 경우
map.put(user, new Session(user));   // Session이 user를 Strong으로 참조
// → user는 절대 GC 안 됨, 엔트리도 절대 안 사라짐
```

### "아무 키나 넣어도 되나요?"

키 비교가 사실상 **동일성(identity)에 의존하는 게 자연스러운 경우**에
적합하다. `new String("a")`처럼 동등(equals)한 객체가 계속 재생성되는
키에는 부적합하다 — 원래 넣은 키 인스턴스에 대한 외부 참조가 사라지는
순간 엔트리가 증발하기 때문이다.

### "엔트리는 정확히 언제 사라지나요?"

GC가 키를 수거하는 순간이 아니라, **GC 이후 맵에 접근할 때**
(내부의 ReferenceQueue를 비우면서) 제거된다.
그래서 `size()`가 호출 시점마다 달라질 수 있다.

### "스레드 안전한가요?"

아니다. 동시성 환경에서는 `Collections.synchronizedMap`으로 감싸거나
별도 동기화가 필요하다. (ConcurrentHashMap에는 Weak 키 버전이 없고,
필요하면 Guava의 `MapMaker.weakKeys()`나 Caffeine을 쓴다.)

---

## 한 줄 요약

참조 강도는 **"GC에게 이 객체를 얼마나 붙잡아 달라고 부탁하는 정도"**이고,
WeakHashMap은 그중 Weak 참조를 활용해
**키 객체의 생명주기를 맵이 방해하지 않는 자료구조**다.
