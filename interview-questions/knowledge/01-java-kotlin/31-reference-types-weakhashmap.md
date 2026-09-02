# Strong / Soft / Weak 참조와 WeakHashMap — GC에게 "이건 버려도 된다"고 말하는 법

> 핵심 관전 포인트: **GC는 "GC 루트에서 도달 가능하면 살린다"는 규칙 하나로 움직이는데, 그 규칙만 있으면 개발자가 GC에게 의사를 전달할 방법이 없다. "이건 메모리가 부족하면 버려도 좋다"거나 "내가 붙잡고 있다는 사실이 이 객체를 살리는 이유가 되면 안 된다"는 요구를 표현할 수단이 필요해서 Java 1.2에 참조 강도가 들어왔다. 네 등급은 전부 "GC가 언제 회수하는가" 하나의 축 위에 있다 — Strong은 도달 가능한 한 절대 회수되지 않고, Soft는 도달 가능해도 메모리가 부족해지면 OOM 대신 먼저 버려지고, Weak는 약한 참조만 남는 순간 다음 GC에 회수되고, Phantom은 회수가 확정된 뒤 정리 훅을 실행하기 위해서만 존재한다. 여기서 중요한 건 **강도가 객체의 성질이 아니라 그 객체를 가리키는 참조의 성질**이라는 점이다 — 같은 객체를 strong 하나와 weak 하나가 동시에 가리키면 strong이 이긴다. WeakHashMap은 `Entry`가 `WeakReference`를 상속해 **키만** 약하게 잡고 값은 강하게 잡는 맵이라, 키를 아무도 안 쓰게 되면 엔트리가 알아서 사라진다. 대신 함정이 둘 있다 — 값이 자기 키를 참조하면 엔트리는 영원히 죽지 않고, String 리터럴이나 -128~127 Integer를 키로 쓰면 풀과 박싱 캐시가 강하게 붙들고 있어 절대 회수되지 않는다. 그리고 엔트리는 GC 순간이 아니라 **그 다음에 맵의 메서드가 호출될 때** `expungeStaleEntries()`로 정리된다.**

---

## 0. 질문 + 의도

**질문**: "Strong/Soft/Weak 참조의 차이는? WeakHashMap은 어떤 용도에 쓰나요?"

**출제 의도**: 로컬 캐시·리스너 보관 자료구조에서 메모리 누수를 만들지 않는 도구(WeakHashMap 등)의 기반 지식이다. GC와 참조의 상호작용까지 아는 깊이의 표본으로, 힙에 오래 남는 자료구조를 설계할 때 생명주기를 의식하는 사람인지를 본다.

## 1. 참조 강도 — GC에게 의사를 전달하는 유일한 수단

### 1-1. 전제 지식 — 도달 가능성 규칙만으로는 표현할 수 없는 요구가 있다

`02-gc-basics-generational.md`에서 GC의 판정 규칙 하나를 세웠다. GC는 **GC 루트**(스레드 스택의 지역변수, static 필드처럼 힙 바깥에서 힙 안을 가리키는 참조들)에서 출발해 참조를 따라가며 닿는 객체에 "살아있음" 표시(**mark**)를 남기고, 끝내 닿지 않은 객체를 회수한다. 이것이 **도달 가능성(reachability)** 판정이다.

이 규칙은 정확하지만 **표현력이 딱 두 단계뿐**이다. 참조가 있으면 산다, 없으면 죽는다. 그 사이가 없다.

그런데 실무에는 그 사이에 놓이는 요구가 분명히 존재한다.

- **"이 이미지 썸네일은 메모리가 넉넉할 땐 들고 있고 싶은데, 힙이 모자라지면 OOM으로 죽느니 이걸 먼저 버려줬으면 좋겠다."** 강한 참조로 들면 절대 안 버려져서 OOM이 나고, 참조를 안 들면 매번 다시 만들어야 한다. 둘 다 원하는 게 아니다.
- **"이 사용자 객체에 부가 정보를 하나 붙여두고 싶은데, 내가 붙여둔 그 사실 때문에 사용자 객체가 힙에 계속 살아 있으면 곤란하다."** 부가 정보를 담은 맵이 사용자 객체를 강하게 잡는 순간, 원본의 수명이 맵의 수명에 묶여 버린다.

두 요구의 공통점은 **"내가 참조하고 있다는 사실을, GC가 살려야 할 근거로 취급하지 말아 달라"**는 것이다. 강한 참조 하나로는 이 말을 할 수 없다.

그래서 Java 1.2에서 `java.lang.ref` 패키지가 들어왔다. 참조를 **객체를 감싼 상자**로 만들어서, 상자의 종류로 GC에게 "이 객체를 얼마나 붙잡아 달라고 부탁하는지"를 전달하는 것이다. 이 부탁의 세기가 **참조 강도(reference strength)**다.

```java
// 지금까지 써온 방식 — 변수가 객체를 직접 가리킨다. 이게 강한 참조다.
byte[] thumbnail = loadThumbnail(id);

// 상자에 넣어 가리키는 방식 — 상자의 종류가 곧 부탁의 세기다.
SoftReference<byte[]> boxed = new SoftReference<>(loadThumbnail(id));
byte[] thumbnail = boxed.get();   // 꺼낼 때는 get(). 이미 회수됐으면 null이 나온다.
```

핵심 차이는 **한 단계를 거친다**는 것이다. `boxed`라는 변수는 상자를 강하게 가리키고, **상자가 안의 배열을 약하게(soft하게) 가리킨다.** GC는 이 상자를 특별 취급해서, 안쪽 화살표를 "살려야 할 근거"로 세지 않는다.

### 1-2. 네 등급 — 전부 "GC가 언제 회수하는가" 하나의 축 위에 있다

등급이 네 개라고 하면 네 개를 따로 외워야 할 것 같지만 그렇지 않다. 전부 **"GC가 이 객체를 회수해도 되는 시점이 언제인가"**라는 하나의 축 위에서 회수 시점을 앞으로 당긴 순서다.

| | 회수 시점 | `get()`이 null을 주는 시점 |
|---|---|---|
| Strong | 도달 가능한 한 절대 회수 안 함 | (상자가 없으므로 해당 없음) |
| Soft | 도달 가능해도 **메모리가 부족해지면** 회수 | 힙 압박으로 정리된 뒤 |
| Weak | **약한 참조만 남는 순간** 다음 GC에 회수 | 그 다음 GC 직후 |
| Phantom | 회수가 확정된 뒤 정리 훅 실행용으로만 남음 | **항상 null** |

표만 보면 순서만 남으니, 각 칸이 실제로 무슨 뜻인지 풀어 쓴다.

**Strong(강한 참조)**은 우리가 평소에 쓰는 보통의 참조다. `Object o = new Object()`의 `o`가 그것이다. 강한 참조로 도달할 수 있는 객체는 **힙이 꽉 차서 OOM으로 죽는 한이 있어도** 회수되지 않는다. 이것이 기본값이고, `static` 컬렉션에 넣어둔 객체가 영영 안 죽는 이유이기도 하다.

**Soft(부드러운 참조)**는 "여유가 있는 동안만 들고 있어 줘"다. 강한 참조가 하나도 없고 soft 참조로만 닿는 객체를 **soft하게 도달 가능(softly reachable)**하다고 부르는데, JVM은 이런 객체를 평소에는 그냥 둔다. 그러다 힙이 부족해져 OOM이 임박하면 **OOM을 던지기 전에 반드시 이것들을 전부 정리한다.** 이 "OOM 전에 정리한다"는 것이 명세가 보장하는 부분이고, 그 전에 언제 정리할지는 JVM 재량이다.

**Weak(약한 참조)**는 "붙잡고는 있지만 이걸 근거로 살리지는 말아 줘"다. weak 참조로만 닿는 객체(**weakly reachable**)는 메모리가 남아돌아도 **다음 GC에 그냥 회수된다.** Soft와의 차이는 "메모리 압박이라는 조건이 붙느냐 아니냐" 하나뿐이다.

**Phantom(유령 참조)**은 성격이 다르다. `get()`이 **항상 null**이라 객체를 꺼내는 용도가 아예 없다. 객체가 회수되기로 확정된 뒤 "이제 정리해도 된다"는 **신호를 받기 위한 용도**로만 쓴다. 2-3에서 다룬다.

비유로 정리하면 이렇다. **Strong은 내 책상 위에 올려둔 물건**이다 — 사무실이 아무리 좁아져도 아무도 못 치운다. **Soft는 창고에 넣어둔 물건**이다 — 평소엔 그대로 있지만 창고가 꽉 차면 관리인이 오래된 것부터 버린다. **Weak는 모니터에 붙인 포스트잇**이다 — 청소가 한 번 돌면 무조건 떨어진다. **Phantom은 폐기물 처리 확인증**이다 — 물건 자체는 이미 없고, "버렸으니 뒷정리하라"는 통지만 남는다.

### 1-3. 강도는 객체의 성질이 아니라 "참조의 성질"이다

여기가 이 주제에서 가장 자주 어긋나는 지점이다. "이 객체는 weak 객체다" 같은 말은 성립하지 않는다. **약한 것은 객체가 아니라 화살표다.**

한 객체를 여러 화살표가 동시에 가리킬 수 있고, 그중 종류가 섞여 있을 수 있다. 이때 GC의 판정 기준은 **"그 객체에 닿는 경로 중 가장 강한 것"**이다. 강한 경로가 하나라도 있으면 그 객체는 강하게 도달 가능하고, 그러면 다른 화살표가 아무리 약해도 회수되지 않는다.

```
[상황 A] 강한 참조와 약한 참조가 동시에 같은 객체를 가리킨다

  [GC 루트: 스택의 shared]
        │
        │ 강한 참조
        ▼
   ┌──────────┐
   │  Object  │   가장 강한 경로 = 강한 참조
   └──────────┘   -> 강하게 도달 가능 -> 회수 불가
        ▲
        │ 약한 참조 (WeakReference 상자 안의 화살표)
   [weakOnShared]


[상황 B] shared = null 로 강한 참조만 끊는다

   ┌──────────┐
   │  Object  │   남은 경로 = 약한 참조뿐
   └──────────┘   -> 약하게 도달 가능 -> 다음 GC에 회수
        ▲
        │ 약한 참조
   [weakOnShared]        이후 weakOnShared.get() 은 null
```

코드로 확인하면 이렇다.

```java
Object shared = new Object();                                  // 강한 참조 하나
WeakReference<Object> weakOnShared = new WeakReference<>(shared); // 약한 참조 하나, 같은 객체

System.gc();
System.out.println(weakOnShared.get() != null);   // true — 강한 참조가 이긴다

shared = null;                                     // 강한 참조를 끊는다
System.gc();
System.out.println(weakOnShared.get() == null);   // true — 이제 약한 참조만 남았으므로 회수됐다
```

이 코드를 OpenJDK 21(G1 GC)에서 실제로 돌리면 순서대로 `true`, `true`가 나온다. 즉 **약한 참조를 만들어 뒀다고 해서 객체가 약해지는 게 아니고, 강한 참조가 전부 사라진 순간에 비로소 약한 참조의 존재가 의미를 갖는다.**

한 가지 단서를 달아 둔다. `System.gc()`는 **"GC를 지금 돌려 달라"는 힌트일 뿐 보장이 아니다.** JVM은 이 요청을 무시할 수 있고, `-XX:+DisableExplicitGC` 옵션이 켜져 있으면 실제로 무시한다. 그래서 이런 코드는 학습·실험용이지 프로덕션 코드에 쓰는 것이 아니다. 아래에 나오는 관측 결과도 전부 "이 환경에서 이렇게 관측됐다"는 뜻이지 명세의 보장이 아니다.

### 1-4. Soft/Weak를 쓰는 쪽이 지켜야 하는 계약 — `get()`은 언제든 null이다

참조 강도를 쓰기로 했다면 사용하는 쪽 코드가 반드시 달라져야 한다. **`get()`은 언제든 `null`을 돌려줄 수 있다.** 심지어 `if (ref.get() != null)`로 검사한 직후에도 그 사이에 GC가 돌면 다음 `get()`은 null일 수 있다.

```java
// (문제) 검사와 사용 사이에 GC가 끼어들 수 있다
if (soft.get() != null) {
    process(soft.get());          // 여기서 null이 들어갈 수 있다
}

// (개선) 지역 변수로 한 번만 꺼내 강한 참조로 고정한 뒤 쓴다
byte[] cached = soft.get();       // 이 순간 cached는 강한 참조가 된다.
                                  // 이 변수가 살아 있는 동안에는 회수되지 않는다.
if (cached == null) {
    cached = loadExpensiveData(); // 회수됐으면 다시 만든다
    soft = new SoftReference<>(cached);
}
process(cached);
```

개선 코드의 핵심은 `byte[] cached = soft.get()` 한 줄이다. 이 대입으로 **지역 변수라는 강한 참조가 생기므로**, 그 뒤로는 1-3의 규칙에 따라 회수되지 않는다. Soft/Weak 참조를 다루는 코드의 기본형이 이것이다 — **꺼내서 강하게 고정하고, null이면 재생성한다.**

여기서 따라오는 설계상의 제약이 하나 있다. **재생성이 가능한 데이터에만 쓸 수 있다.** 다시 만들 수 없는 유일한 데이터를 soft/weak로 들고 있다가 회수되면 복구할 방법이 없다.

## 2. 등급별로 — 이걸 안 쓰면 무슨 문제가 생기는가

### 2-1. Soft — "메모리가 남으면 들고 있고, 부족하면 OOM 대신 이게 먼저 죽는다"

먼저 강한 참조로만 캐시를 만들면 무슨 일이 생기는지 본다.

```java
// (문제) 강한 참조 캐시 — 크기 제한이 없으면 캐시가 힙을 다 먹고 OOM
public class ThumbnailCache {
    private final Map<Long, byte[]> cache = new HashMap<>();

    public byte[] get(long imageId) {
        // computeIfAbsent로 넣은 배열은 강한 참조로 맵에 붙잡힌다.
        // 이미지 종류가 늘수록 맵은 단조 증가하고, 줄어드는 경로가 없다.
        return cache.computeIfAbsent(imageId, this::render);
    }
}
```

이 캐시의 문제는 "느리다"가 아니라 **"줄어드는 경로가 없다"**는 것이다. 힙이 꽉 차면 GC는 이 배열들을 회수하고 싶어도 못 한다 — 맵이 강하게 잡고 있으니 도달 가능하고, 도달 가능하면 살려야 하기 때문이다. 결국 `OutOfMemoryError: Java heap space`로 프로세스가 죽는다. **캐시 때문에 서비스가 죽는 것**이 강한 참조 캐시의 전형적인 실패다.

`SoftReference`로 바꾸면 이 실패의 성격이 달라진다.

```java
// (개선) soft 참조 캐시 — 힙이 부족해지면 JVM이 캐시부터 비운다
public class ThumbnailCache {
    private final Map<Long, SoftReference<byte[]>> cache = new HashMap<>();

    public byte[] get(long imageId) {
        SoftReference<byte[]> ref = cache.get(imageId);
        byte[] data = (ref == null) ? null : ref.get();   // 회수됐으면 null

        if (data == null) {                                // 없거나 회수됐으면 다시 만든다
            data = render(imageId);
            cache.put(imageId, new SoftReference<>(data));
        }
        return data;
    }
}
```

이제 힙이 부족해지면 JVM이 **OOM을 던지기 전에** softly reachable한 배열들을 회수한다. 서비스는 죽는 대신 캐시 미스가 늘어 느려질 뿐이다. **"죽는 실패"를 "느려지는 실패"로 바꾼 것**이 SoftReference가 주는 가치다.

실제로 그렇게 동작하는지 확인해 보자. 힙을 64MB로 제한하고 8MB짜리 배열을 soft로 들고 있다가, 4MB씩 강하게 할당해 압박을 준다.

```java
SoftReference<byte[]> soft = new SoftReference<>(new byte[8 * 1024 * 1024]);
System.gc();
System.out.println(soft.get() != null);   // 보통 GC로는 안 죽는다

List<byte[]> pressure = new ArrayList<>();
for (int i = 0; i < 10_000; i++) {
    pressure.add(new byte[4 * 1024 * 1024]);   // 힙을 계속 강하게 점유한다
    if (soft.get() == null) {
        System.out.println("압박 " + (i + 1) * 4 + "MB 시점에 soft 참조가 끊겼다");
        break;
    }
}
```

`java -Xmx64m`으로 실행한 결과다.

```
true
압박 40MB 시점에 soft 참조가 끊겼다
```

두 가지가 확인된다. **평범한 GC로는 soft 참조가 끊기지 않는다**는 것(첫 줄), 그리고 **힙이 모자라지자 OOM이 나기 전에 정리됐다**는 것이다. 루프는 `OutOfMemoryError` 없이 정상적으로 빠져나왔다.

**(가산점 포인트) 회수 정책에는 튜닝 손잡이가 있다.** HotSpot은 soft 참조를 "마지막으로 접근한 지 얼마나 됐는가"와 "지금 남은 힙이 얼마인가"를 곱해 판단하는데, 그 계수가 `-XX:SoftRefLRUPolicyMSPerMB`다. 이 환경(OpenJDK 21)의 기본값은 `1000`으로, **남은 힙 1MB당 1000ms(1초)만큼 살려둔다**는 뜻이다. 남은 힙이 100MB면 최근 100초 안에 쓴 것은 유지되고, 남은 힙이 5MB로 쪼그라들면 5초 넘게 안 쓴 것부터 버려진다. 힙이 줄수록 자동으로 공격적이 되는 구조다.

**그럼에도 실무의 로컬 캐시를 SoftReference로 만드는 것은 권장되지 않는다.** 이유는 성능이 아니라 **예측 가능성**이다.

- **언제 비워질지 모른다.** 위 계산식은 남은 힙 크기에 좌우되므로, 같은 코드가 트래픽 패턴에 따라 캐시 히트율이 요동친다. 히트율이 재현되지 않으면 성능 회귀를 추적할 수 없다.
- **비워지는 단위를 고를 수 없다.** GC는 "덜 중요한 항목"을 모르므로, 방금 만든 비싼 항목과 거의 안 쓰이는 항목을 구분하지 않는다.
- **GC 부담이 늘어난다.** soft 참조는 회수 판정을 GC가 매번 다시 해야 하는 대상이라, 수가 많아지면 GC 시간이 늘어난다. 특히 Old 영역까지 승격된 soft 참조는 Full GC를 유발하는 쪽으로 작용한다.

그래서 실무의 로컬 캐시는 **Caffeine**(또는 Ehcache)처럼 **"최대 5,000개, 쓰기 후 10분 만료, LRU 유사 정책"**을 명시적으로 선언하는 라이브러리를 쓴다.

```java
// 실무 기본형 — 비워지는 조건을 코드가 정한다
Cache<Long, byte[]> cache = Caffeine.newBuilder()
        .maximumSize(5_000)                          // 개수 상한이 곧 메모리 상한의 근거가 된다
        .expireAfterWrite(Duration.ofMinutes(10))    // 신선도 요구를 시간으로 표현한다
        .recordStats()                                // 히트율을 지표로 뽑아 튜닝 근거로 삼는다
        .build();
```

정리하면 **SoftReference는 "OOM 방어의 마지막 안전판"으로는 의미가 있지만 "캐시 정책"으로는 부족하다.** 캐시를 비우는 기준은 메모리 압박이 아니라 **사용 패턴**이어야 하기 때문이다.

### 2-2. Weak — "부가 정보를 곁들이되, 그 정보 때문에 원본이 살아 있으면 안 될 때"

Weak가 필요한 상황은 캐시와 성격이 다르다. **어떤 객체에 곁다리 정보를 붙여두고 싶은데, 그 객체의 클래스를 내가 수정할 수 없을 때** 생긴다.

예를 들어 외부 라이브러리가 주는 `Connection` 객체마다 "이 커넥션을 언제 빌려 갔는지"를 기록해 두고 싶다고 하자. `Connection` 클래스에 필드를 추가할 수는 없으니 바깥에 맵을 하나 둔다.

```java
// (문제) 강한 참조 맵에 부가 정보를 붙인다
public class LeaseTracker {
    private static final Map<Connection, Instant> leasedAt = new HashMap<>();

    public static void onBorrow(Connection c) { leasedAt.put(c, Instant.now()); }
    // onReturn 을 호출해 remove 하는 것을 한 번이라도 빠뜨리면,
    // static 맵은 GC 루트이므로 그 Connection 은 영원히 회수되지 않는다.
}
```

이 코드가 만드는 것은 정확히 `02-gc-basics-generational.md`가 말한 누수 형태다 — **"실수로 참조를 놓치는 누수는 없고, 실수로 참조를 붙잡는 누수는 있다."** 부가 정보를 붙였을 뿐인데 **원본의 수명이 추적기의 수명에 묶여 버렸다.**

원하는 건 "원본이 살아 있는 동안만 유효한 부가 정보"다. 즉 **원본이 죽으면 부가 정보도 같이 사라져야 하고, 부가 정보가 원본을 살려서는 안 된다.** 이것이 weak 참조의 용도이고, 그대로 `WeakHashMap`으로 이어진다(3절).

```java
// (개선) 키를 약하게 잡는 맵 — 원본이 죽으면 기록도 함께 사라진다
private static final Map<Connection, Instant> leasedAt =
        Collections.synchronizedMap(new WeakHashMap<>());
```

이때 유의할 점 하나. **weak는 "언젠가 다시 쓸 것"을 담는 용도가 아니다.** weak 참조만 남으면 다음 GC에 바로 사라지므로, "지금은 안 쓰지만 나중에 필요할 것"을 담아 두면 그냥 없어진다. Weak가 답하는 질문은 **"누가 아직 이걸 쓰고 있는가"**이지 "나중에 필요한가"가 아니다.

### 2-3. Phantom — `finalize()`가 폐기된 자리 (가산점 포인트)

Phantom을 이해하려면 먼저 **"객체가 회수될 때 뒷정리를 실행하고 싶다"**는 요구가 왜 생기는지를 봐야 한다.

Java 객체 중에는 힙 바깥의 자원을 대표하는 것들이 있다. 파일 디스크립터, 소켓, 네이티브 메모리(`DirectByteBuffer`가 잡는 오프힙 버퍼) 같은 것들이다. **GC는 힙만 관리하므로**, 자바 객체가 회수돼도 그 객체가 붙잡고 있던 OS 자원은 자동으로 풀리지 않는다. 누군가는 닫아 줘야 한다.

Java가 처음 내놓은 답이 `Object.finalize()`였다. 객체가 회수되기 직전에 JVM이 이 메서드를 호출해 준다는 약속이다. 그런데 이 설계는 결함이 심해 결국 폐기됐다. 이유가 셋이다.

**(1) 객체를 되살릴 수 있다.** `finalize()` 안에서 `this`를 다시 어딘가에 대입하면 그 객체는 다시 도달 가능해진다. GC가 "죽었다"고 판정한 객체가 살아 돌아오는 것이다.

```java
public class Res {
    static Res zombie;
    @Override protected void finalize() {
        zombie = this;   // 회수 직전에 자기 자신을 static 필드에 되살린다
    }
    public static void main(String[] a) throws Exception {
        new Res();       // 아무도 참조하지 않는 객체
        System.gc(); Thread.sleep(300);
        System.out.println(zombie != null);
    }
}
```

실제로 실행하면 `true`가 나온다. GC의 판정을 애플리케이션 코드가 뒤집을 수 있다는 뜻이고, 이것만으로도 GC 알고리즘의 전제가 무너진다.

**(2) 실행 시점이 보장되지 않는다.** `finalize()`는 별도의 finalizer 스레드가 큐에서 꺼내 실행하는데, 그 스레드가 언제 스케줄되는지, 애초에 큐가 언제 비워지는지 알 수 없다. 프로세스가 끝날 때까지 한 번도 안 불릴 수도 있다. **자원 해제를 이것에 맡기면 파일 디스크립터가 고갈된 뒤에야 정리가 도는 상황**이 벌어진다.

**(3) 회수가 최소 두 사이클로 늘어난다.** `finalize()`를 가진 객체는 GC가 한 번 만나면 회수하지 못하고 finalizer 큐에 등록만 하고 지나간다. 실제 회수는 finalize가 실행된 뒤 **다음 GC**에서 일어난다. 게다가 `finalize()` 안에서 예외가 나면 조용히 무시돼 정리가 안 된 채로 넘어간다.

그래서 `Object.finalize()`는 **Java 9에서 deprecated, Java 18에서 제거 예정(deprecated for removal)**이 됐다. Java 21에서 `finalize()`를 오버라이드하면 컴파일러가 이렇게 경고한다.

```
warning: [removal] finalize() in Object has been deprecated and marked for removal
```

Java 18부터는 `--finalization=disabled` 실행 옵션으로 finalization 기능 자체를 꺼 볼 수도 있다.

대체재가 두 겹이다.

**첫째, 대부분의 경우 정답은 `try-with-resources`다.** 자원 해제를 GC에 맡기지 않고 **코드가 명시적으로, 정해진 시점에** 하는 것이다(`20-try-with-resources-resource-leaks.md`). GC 기반 정리는 "혹시 개발자가 빠뜨렸을 때의 안전망"이지 1차 수단이 아니다.

**둘째, 안전망이 필요하면 Java 9+의 `Cleaner`를 쓴다.** `Cleaner`는 내부적으로 `PhantomReference`를 쓴다. Phantom의 `get()`이 항상 null인 이유가 여기서 풀린다 — **객체를 꺼낼 수 없게 만들어야 되살릴 방법이 원천 차단**되기 때문이다. `finalize()`의 결함 (1)을 설계로 막은 것이다.

```java
public class NativeBuffer implements AutoCloseable {
    private static final Cleaner CLEANER = Cleaner.create();

    // 정리 작업은 반드시 static 클래스여야 한다.
    // 내부 클래스로 만들면 바깥 인스턴스(NativeBuffer)를 암묵적으로 참조하게 되고,
    // 그러면 정리 대상이 강하게 도달 가능해져 영원히 정리가 돌지 않는다.
    private static class ReleaseTask implements Runnable {
        private final long address;
        ReleaseTask(long address) { this.address = address; }
        @Override public void run() { freeNative(address); }
    }

    private final Cleaner.Cleanable cleanable;

    public NativeBuffer(long size) {
        long address = allocateNative(size);
        this.cleanable = CLEANER.register(this, new ReleaseTask(address));
    }

    @Override public void close() {
        cleanable.clean();   // 1차 수단: 명시적 해제. 여러 번 불러도 한 번만 실행된다.
    }
}
```

주석에 적은 함정이 실무에서 가장 자주 밟는 지점이다. `CLEANER.register(this, task)`에서 **`task`가 `this`를 참조하면 `this`가 영원히 강하게 도달 가능**해져서 정리가 절대 실행되지 않는다. 정리 작업은 해제에 필요한 값(위 예에서는 네이티브 주소)만 복사해 들고 있어야 한다.

동작을 확인해 보면 이렇다.

```java
Cleaner c = Cleaner.create();
Object o = new Object();
c.register(o, () -> System.out.println("cleanup 실행됨"));
o = null;
System.gc(); Thread.sleep(300);
// 출력: cleanup 실행됨
```

네 등급의 관계를 한 장으로 정리하면 이렇다.

```
힙 사용량                    낮음 ─────────────────────────────▶ OOM 직전
                             │                                   │
Strong 으로 도달 가능        │  살아있음 ────────────────────────│─▶ 살아있음 (OOM 나도 유지)
Soft   으로만 도달 가능      │  살아있음 ────────────────▶ 회수   │
Weak   으로만 도달 가능      │  다음 GC 에 회수                   │
Phantom 으로만 도달 가능     │  이미 회수 확정, 큐에 넣어 정리 훅만 실행
```

## 3. WeakHashMap — 키가 죽으면 엔트리도 죽는 맵

### 3-1. 일반 `HashMap`이 만드는 누수

`HashMap`은 키와 값을 **둘 다 강한 참조로** 들고 있다. 그래서 맵에 넣는 순간 그 객체의 수명은 맵의 수명에 묶인다.

```java
// (문제) HashMap — 맵이 살아 있는 한 키도 값도 절대 회수되지 않는다
Map<User, Session> sessions = new HashMap<>();

User user = new User("kim");
sessions.put(user, new Session(user));

user = null;   // 바깥에서 참조를 끊어도

// sessions -> Entry -> key(User) 라는 강한 참조 사슬이 남아 있다.
// sessions 가 static 필드나 싱글톤 빈이면 이 사슬은 애플리케이션이 사는 내내 유지된다.
```

이 맵이 `static`이거나 싱글톤 스프링 빈의 필드라면 GC 루트에서 영원히 닿으므로, `User`와 `Session`은 **프로세스가 죽을 때까지 힙에 남는다.** 요청마다 하나씩 쌓이면 그대로 OOM이다.

```java
// (개선) WeakHashMap — 키를 아무도 안 쓰게 되면 엔트리가 사라진다
Map<User, Session> sessions = new WeakHashMap<>();

User user = new User("kim");
sessions.put(user, someSession);

user = null;   // 바깥 참조가 끊기면
// 다음 GC에서 User 가 회수되고, 그 뒤 맵에 접근할 때 엔트리도 제거된다
```

실제로 그렇게 되는지 확인해 보자.

```java
Map<Object, String> m = new WeakHashMap<>();
Object k1 = new Object();
Object k2 = new Object();
m.put(k1, "v1");
m.put(k2, "v2");
System.out.println(m.size());   // 2

k1 = null;                      // k1 만 바깥 참조를 끊는다
System.gc(); Thread.sleep(200);
System.out.println(m.size());   // 1 — k1 엔트리만 사라졌다
```

OpenJDK 21에서 실행하면 `2`, `1`이 나온다. **바깥에서 안 쓰는 키의 엔트리만 골라 사라진 것**이다.

### 3-2. 내부 구조 — `Entry`가 `WeakReference`를 상속한다

"키를 약하게 잡는다"는 문장을 구조로 보면 훨씬 명확해진다. JDK의 `WeakHashMap` 소스는 이렇게 생겼다.

```java
private static class Entry<K,V> extends WeakReference<Object> implements Map.Entry<K,V> {
    V value;              // 값은 그냥 필드 — 강한 참조다
    final int hash;
    Entry<K,V> next;

    Entry(Object key, V value, ReferenceQueue<Object> queue, int hash, Entry<K,V> next) {
        super(key, queue);   // 키를 WeakReference 의 referent 자리에 넣는다 — 약한 참조
        this.value = value;
        ...
    }
}
```

`Entry`가 **`WeakReference`를 상속**한다는 것이 전부다. `WeakReference`가 물려주는 "감싸는 대상(referent)" 자리에 **키**를 넣고, **값은 평범한 `value` 필드**로 들고 있다. 그림으로 보면 이렇다.

```
[GC 루트] ──강한──▶ [WeakHashMap]
                         │ 강한
                         ▼
                    table[i] : Entry  (extends WeakReference)
                         │
       referent 자리 ────┼───약한 참조───▶ [키 객체]
                         │
       value 필드   ─────┴───강한 참조───▶ [값 객체]
```

**키로 가는 화살표만 약하고, 값으로 가는 화살표는 여전히 강하다.** 여기서 3-3의 함정이 나온다.

이 "키는 약하게, 값은 강하게" 구조는 처음 보는 것이 아니다. `16-threadlocal-thread-pool-risks.md`에서 본 `ThreadLocalMap`의 `Entry`가 **정확히 같은 구조**다. 그쪽은 키가 `ThreadLocal` 인스턴스이고 값이 우리가 `set()`한 객체였다. 같은 설계에서 같은 종류의 문제가 나오므로, 한쪽을 이해하면 다른 쪽도 같이 이해된다.

### 3-3. 함정 ① — 값이 자기 키를 강하게 참조하면 엔트리는 영원히 죽지 않는다

3-2의 그림에서 **값에서 키로 향하는 화살표를 하나만 그으면** 무슨 일이 일어나는지 보자.

```java
// (문제) 값이 자기 키를 들고 있다 — 매우 흔한 형태다
Map<User, Session> sessions = new WeakHashMap<>();
User user = new User("kim");
sessions.put(user, new Session(user));   // Session 이 생성자에서 user 를 필드로 보관한다
user = null;
// 이제 이 엔트리는 영원히 사라지지 않는다
```

참조 사슬을 따라가면 이유가 보인다.

```
[우리가 의도한 경로 — 약하다]
   [Entry] ──referent 자리(약한)──▶ [User]

[값을 통해 실수로 만들어진 경로 — 강하다]
   [GC 루트] ──강한──▶ [WeakHashMap] ──강한──▶ [Entry]
                                                 │  value 필드 (강한)
                                                 ▼
                                             [Session]
                                                 │  session.user 필드 (강한)
                                                 ▼
                                              [User]   <- 강한 화살표만 밟고 도착했다

1-3의 규칙: 그 객체에 닿는 경로 중 "가장 강한 것"이 판정 기준이다.
  -> User 는 강하게 도달 가능 -> 키가 회수되지 않는다
  -> 엔트리도 제거되지 않는다 -> 약한 참조가 무력화됐다
```

**맵이 자기 손으로 자기 키를 살리는 순환**이 만들어진 것이다. `02-gc-basics-generational.md`의 순환 참조 이야기와 헷갈리기 쉬운데 결정적으로 다르다. 그쪽 순환은 **바깥에서 진입 경로가 없어서** 통째로 회수됐다. 여기는 **GC 루트에서 맵으로 들어오는 진입 경로가 살아 있어서** 순환 전체가 살아남는다.

실측으로 확인해 보자.

```java
class Node { Object key; Node(Object k) { this.key = k; } }

// 값이 키를 잡는 경우
Map<Object, Node> cyc = new WeakHashMap<>();
Object ck = new Object();
Node cv = new Node(ck);      // 값이 키를 강하게 붙잡는다
cyc.put(ck, cv);
ck = null; cv = null;        // 지역 강한 참조는 전부 끊었다
System.gc(); Thread.sleep(200);
System.out.println(cyc.size());   // 1 — 사라지지 않았다

// 값이 키를 안 잡는 경우
Map<Object, String> ok = new WeakHashMap<>();
Object ok1 = new Object();
ok.put(ok1, "값이 키를 참조하지 않음");
ok1 = null;
System.gc(); Thread.sleep(200);
System.out.println(ok.size());    // 0 — 정상적으로 사라졌다
```

실행 결과는 `1`과 `0`이다. 같은 `WeakHashMap`인데 **값의 내용에 따라 정반대로 동작한다.**

```java
// (개선) 값이 키를 참조하지 않도록 필요한 것만 복사해 담는다
sessions.put(user, new Session(user.getId(), user.getName()));
//                             ^^^^^^^^^^^^ User 인스턴스가 아니라 그 안의 값만 옮긴다
```

이 함정은 **값이 키를 간접적으로 참조할 때 훨씬 찾기 어렵다.** `Session -> Order -> Customer -> User`처럼 서너 단계를 건너 키에 닿아도 결과는 똑같다. 그래서 `WeakHashMap`을 쓸 때는 **값 객체의 참조 그래프에 키가 등장하지 않는지**를 명시적으로 확인해야 한다. 값이 키에 닿는 것을 구조적으로 막고 싶으면, JDK가 `ThreadLocalMap`에서 못 한 것을 우리가 하는 방법은 **값을 원시 값이나 불변 DTO로 좁히는 것** 하나뿐이다.

### 3-4. 함정 ② — String 리터럴과 작은 Integer를 키로 쓰면 안 된다

두 번째 함정은 "키가 회수될 수 있는 객체인가"의 문제다. **애초에 절대 회수되지 않는 객체를 키로 넣으면 `WeakHashMap`은 그냥 안 비워지는 `HashMap`이 된다.**

대표적인 것이 둘이다.

**String 리터럴.** `04-string-immutability-stringbuilder.md`에서 봤듯이 소스 코드에 등장하는 문자열 리터럴은 **String pool**에 하나만 만들어져 공유된다. 그리고 그 리터럴은 **그 코드가 속한 클래스의 런타임 상수 풀이 강하게 참조**한다. 클래스가 로딩돼 있는 한 리터럴은 강하게 도달 가능하므로 절대 회수되지 않는다.

```java
Map<String, String> sm = new WeakHashMap<>();
String lit = "리터럴-키";                        // 클래스 상수 풀이 강하게 잡고 있다
String neu = new String("런타임-키");            // 힙에 새로 만든 별개의 객체
sm.put(lit, "리터럴이 키");
sm.put(neu, "new String이 키");
System.out.println(sm.size());   // 2

lit = null; neu = null;          // 지역 변수 참조는 둘 다 끊는다
System.gc(); Thread.sleep(200);
System.out.println(sm.size());        // 1
System.out.println(sm.entrySet());    // [리터럴-키=리터럴이 키]
```

실행 결과는 `2` → `1`이고, 남은 것은 **리터럴 쪽**이다. 지역 변수를 똑같이 null로 밀었는데 한쪽만 살아남았다 — **리터럴에는 우리가 모르는 강한 참조(클래스 상수 풀)가 하나 더 있기 때문**이다.

**박싱된 작은 `Integer`.** `30-integer-cache-boxed-equality.md`에서 본 대로 `Integer.valueOf`는 -128~127 범위의 객체를 **미리 만들어 둔 `IntegerCache.cache` 배열에서 꺼내 준다.** 이 배열은 `static` 필드이므로 GC 루트다. 오토박싱으로 맵에 넣은 작은 정수는 전부 이 캐시의 인스턴스이고, 따라서 강하게 도달 가능하다.

```java
Map<Integer, String> im = new WeakHashMap<>();
for (int i = 125; i <= 130; i++) {
    im.put(i, "v" + i);   // 오토박싱 -> Integer.valueOf(i)
}
System.out.println(im.size());   // 6

System.gc(); Thread.sleep(200);
System.out.println(new TreeMap<>(im).keySet());   // 남은 키
```

실행 결과다.

```
6
[125, 126, 127]
```

**125, 126, 127만 남고 128, 129, 130은 사라졌다.** 정확히 `IntegerCache`의 상한 127에서 갈린다. 같은 코드, 같은 타입인데 **값의 크기에 따라 엔트리의 생사가 갈리는 것**이다. 이런 자료구조는 개발 환경(id가 1, 2, 3)에서는 엔트리가 전부 남아 정상처럼 보이고, 운영에서 id가 커지는 순간 엔트리가 사라지기 시작한다.

정리하면 **`WeakHashMap`의 키는 "그 객체가 실제로 회수될 수 있는 객체"여야 한다.** 리터럴·박싱 캐시·`enum` 상수·`Class` 객체처럼 어딘가가 강하게 붙들고 있는 것을 키로 쓰면 약한 참조가 아무 일도 하지 않는다.

### 3-5. 엔트리는 정확히 언제 사라지는가 — `ReferenceQueue`와 `expungeStaleEntries()`

"키가 회수되면 엔트리도 사라진다"는 문장은 결과만 맞고 **시점이 틀렸다.** 정확한 순서를 알아야 `size()`가 이상하게 보이는 상황을 설명할 수 있다.

먼저 `ReferenceQueue`가 무엇인지 짚는다. **`ReferenceQueue`는 "당신이 감싸 둔 객체가 방금 회수됐습니다"라는 통지를 받는 우편함이다.** `WeakReference`를 만들 때 큐를 함께 넘겨 두면, GC가 그 객체를 회수하면서 **참조 상자 자체를 그 큐에 넣어 준다.** 그러면 우리는 큐를 폴링해서 "회수된 상자들"을 하나씩 꺼내 뒷정리를 할 수 있다.

`WeakHashMap`은 내부에 이 큐를 하나 갖고 있고(`private final ReferenceQueue<Object> queue`), 모든 `Entry`를 이 큐에 등록해 만든다. 그리고 큐를 비우며 죽은 엔트리를 테이블에서 떼어내는 메서드가 **`expungeStaleEntries()`**다. `expunge`는 "지워 없애다", `stale entry`는 **"키가 이미 null이 된 낡은 항목"**을 뜻한다.

문제는 **이 메서드가 GC에 의해 호출되지 않는다**는 것이다. GC는 큐에 넣기까지만 하고, 큐를 비우는 일은 **맵의 메서드가 호출될 때 곁다리로** 일어난다.

```
t1   키 객체에 대한 바깥의 강한 참조가 사라진다
      맵 상태: table 에 Entry 있음, size 필드 = 2

t2   GC 가 돈다
      - Entry 의 referent(키) 자리를 null 로 지운다
      - Entry 자체를 WeakHashMap 의 ReferenceQueue 에 넣는다
      맵 상태: table 에 Entry 그대로 있음(키만 null), size 필드 = 2  <- 아직 안 줄었다
      값 객체도 Entry.value 가 강하게 잡고 있어 그대로 살아 있다

t3   누군가 map.size() / get() / put() / entrySet() ... 을 호출한다
      - expungeStaleEntries() 가 큐를 다 비우며
        해당 Entry 를 table 에서 떼고, e.value = null 로 밀고, size-- 한다
      맵 상태: table 에서 제거됨, size 필드 = 1
```

이걸 실제로 관측하려면 **맵의 어떤 public 메서드도 호출하지 않고** 내부 상태를 봐야 한다(`size()`를 부르는 순간 t3가 일어나 버리기 때문이다). 리플렉션으로 `table`과 `size` 필드를 직접 읽어 확인한 결과다.

```
F1 GC 직후, 맵 메서드 호출 전 raw table 상태 = 테이블에 남은 Entry 2개(그중 키가 이미 null인 것 1개), size 필드 = 2
F2 size() 호출 = 1
F3 size() 이후 raw table 상태 = 테이블에 남은 Entry 1개(그중 키가 이미 null인 것 0개), size 필드 = 1
```

`F1`이 t2 상태다. **GC는 이미 끝났고 키도 null이 됐는데, 엔트리는 테이블에 그대로 있고 `size` 필드도 2다.** `F2`에서 `size()`를 부르는 순간 정리가 일어나 1이 되고, `F3`에서 테이블에서도 실제로 사라졌음이 확인된다.

여기서 두 가지 실무적 결론이 나온다.

**첫째, 아무도 맵을 건드리지 않으면 정리도 안 된다.** "만들어 두고 가끔만 조회하는" `WeakHashMap`은 키가 죽은 뒤에도 상당 기간 엔트리와 **값 객체**를 힙에 붙잡고 있을 수 있다. 값이 무거우면 이것 자체가 누수처럼 보인다. `16-threadlocal-thread-pool-risks.md`에서 "`ThreadLocalMap`의 stale entry 정리가 언제 일어날지 보장이 없다"고 한 것과 완전히 같은 이야기다.

**둘째, `size()`는 스냅샷이다.** JDK 소스의 `size()` 주석도 그렇게 말한다 — "This result is a snapshot." 아무것도 넣거나 빼지 않았는데 두 번 부른 `size()`가 다를 수 있다. **`WeakHashMap`의 `size()`로 단정적인 판단(용량 제한, 검증)을 하면 안 된다.**

참고로 `isEmpty()`는 내부적으로 `size() == 0`을 호출하므로 정리를 유발한다. 반면 정리 없이 즉시 답하는 메서드는 없다고 보면 된다 — `getTable()`을 거치는 거의 모든 조회·수정 메서드가 첫 줄에서 `expungeStaleEntries()`를 부른다.

### 3-6. 키를 찾는 것은 `equals`, 살려두는 것은 인스턴스

또 하나 자주 어긋나는 지점이다. **`WeakHashMap`은 키를 `equals`/`hashCode`로 찾는다.** 참조 동일성(`==`)으로 찾는 것이 아니다 — 그건 `IdentityHashMap`이다.

그런데 **엔트리를 살려두는 판정은 `equals`가 아니라 "맵에 저장된 그 키 인스턴스가 도달 가능한가"로** 한다. 이 둘이 어긋나면 이상해 보이는 동작이 나온다.

```java
Map<String, String> em = new WeakHashMap<>();
String stored = new String("주문-42");
em.put(stored, "값");

String lookup = new String("주문-42");        // 내용은 같지만 다른 인스턴스
System.out.println(stored == lookup);         // false
System.out.println(em.get(lookup));           // "값"  <- equals 로 찾으므로 조회된다

stored = null;                                 // 맵에 "저장된" 인스턴스만 참조를 끊는다
System.gc(); Thread.sleep(200);

System.out.println(em.size());                 // 0
System.out.println(em.get(lookup));            // null  <- lookup 은 멀쩡히 살아 있는데도
```

실행하면 `false`, `값`, `0`, `null`이 나온다. **`lookup`이라는 동등한 문자열을 손에 쥐고 있는데도 엔트리가 사라졌다.** 살려주는 것은 `equals`가 아니라 저장된 인스턴스이기 때문이다.

그래서 `WeakHashMap`은 **"키 인스턴스 자체가 도메인에서 의미를 갖는" 경우에 적합하다.** 커넥션 객체, 클래스로더, 세션 객체처럼 그 인스턴스 하나가 곧 대상인 경우다. 반대로 **주문번호 문자열, 사용자 id처럼 값이 같으면 같은 것으로 취급되고 매번 새로 만들어지는 키에는 부적합하다.** 조회는 되는데 언제 사라질지 모르는 자료구조가 된다.

**(가산점 포인트)** Guava의 `MapMaker().weakKeys()`와 Caffeine의 `weakKeys()`는 이 부분에서 `WeakHashMap`과 **의도적으로 다르게** 동작한다. 이들은 키 비교를 **동일성(`==`)으로** 한다. 실제로 확인해 보면 이렇다.

```java
ConcurrentMap<String, String> m = new MapMaker().weakKeys().makeMap();
String stored = new String("주문-42");
m.put(stored, "값");
String lookup = new String("주문-42");

m.get(lookup);   // null   <- equals 가 아니라 == 로 찾는다
m.get(stored);   // "값"
```

이유는 일관성이다. **약한 키의 수명은 인스턴스 단위로 결정되는데 조회는 equals 단위로 한다면, 방금 `get`으로 찾아지던 키가 다음 순간 사라지는 3-6의 혼란이 그대로 남는다.** 그래서 이들은 아예 조회 기준까지 인스턴스로 맞췄다. `WeakHashMap`을 이 라이브러리로 갈아탈 때 **조용히 동작이 바뀌는 지점**이므로 알아둘 만하다.

### 3-7. 그래서 어디에 쓰고, 어디에 쓰지 않는가

**쓰는 자리 (1) — 수정할 수 없는 객체에 부가 정보를 붙일 때.** 2-2에서 본 형태다. 원본 클래스에 필드를 추가할 수 없어 바깥 맵으로 메타데이터를 관리하되, 그 관리 때문에 원본이 살아 있으면 안 되는 경우다.

**쓰는 자리 (2) — 클래스로더 단위 캐시.** 프레임워크가 클래스 메타데이터를 캐싱할 때 `Map<ClassLoader, ...>`나 `Map<Class<?>, ...>` 형태를 쓰는데, 이걸 강한 참조로 잡으면 **애플리케이션을 재배포해도 옛 클래스로더가 회수되지 않아** `Metaspace` 누수가 난다. 톰캣에 war를 반복 배포할 때 나는 전형적인 누수 형태다. 키를 약하게 잡으면 클래스로더가 언로드될 때 캐시도 함께 사라진다.

**쓰는 자리 (3) — 리스너/콜백 레지스트리. 단, 조건이 붙는다.** "등록만 하고 해제를 깜빡해도 누수가 안 난다"는 것이 교과서적인 설명인데, 실제로는 **반대 방향으로 터진다.** 리스너를 붙잡는 다른 강한 참조가 없으면 **등록하자마자 다음 GC에 사라진다.**

```java
Map<Runnable, Boolean> listeners = new WeakHashMap<>();

String name = "주문-리스너";
listeners.put(() -> System.out.println(name), Boolean.TRUE);      // 캡처 람다
listeners.put(new Runnable() { public void run() {} }, Boolean.TRUE); // 익명 클래스
System.out.println(listeners.size());   // 2

System.gc(); Thread.sleep(200);
System.out.println(listeners.size());   // 0  <- 등록한 리스너가 전부 증발했다
```

실행 결과는 `2` → `0`이다. **인라인으로 만들어 바로 등록한 리스너는 아무도 강하게 붙잡지 않으므로 즉시 사라진다.** 이벤트가 조용히 안 오는 버그가 되는데, 예외도 안 나고 로그도 안 남아 추적이 매우 어렵다.

```java
// (개선) 리스너의 수명을 붙잡는 주체를 명시한다
public class OrderPanel {
    private final Runnable listener = () -> refresh();   // 패널이 자기 리스너를 필드로 붙잡는다
    public OrderPanel(EventBus bus) { bus.register(listener); }
}
// 패널이 살아 있는 동안 리스너도 살아 있고, 패널이 죽으면 리스너도 레지스트리에서 사라진다
```

즉 **약한 레지스트리가 성립하려면 "리스너의 수명을 대신 책임지는 소유자"가 반드시 있어야 한다.** 리스너의 수명이 곧 그 컴포넌트의 수명이라는 구조가 있을 때만 쓰는 패턴이지, 아무 데나 끼워 넣는 안전망이 아니다.

**(참고로 비캡처 람다는 다르게 동작한다.)** 위 코드의 `name` 캡처를 없애고 `() -> System.out.println("이벤트")`처럼 아무것도 캡처하지 않는 람다로 바꾸면 GC 후에도 사라지지 않는다. 비캡처 람다는 호출 지점마다 인스턴스를 하나만 만들어 재사용하고 그 인스턴스를 호출 지점이 붙잡고 있기 때문이다. **캡처 여부에 따라 결과가 뒤집히는 것** 자체가 이 패턴을 신뢰할 수 없게 만드는 이유다.

**쓰지 않는 자리 — 일반적인 캐시.** 4절의 세 번째 꼬리질문에서 다룬다. 한 줄로 말하면 **`WeakHashMap`은 "지금 쓰고 있는가"에는 답하지만 "나중에 또 쓸 것인가"에는 답하지 못한다.**

## 4. 꼬리질문 대비 포인트

### "값도 Weak인가요?"

아니다. **키만 약한 참조이고 값은 강한 참조다.** `Entry`가 `WeakReference`를 상속해서 물려받은 referent 자리에 키를 넣고, 값은 평범한 `value` 필드로 들고 있기 때문이다(3-2).

그래서 **값이 자기 키를 참조하면 약한 참조가 무력화된다.** `루트 -> 맵 -> Entry -> value -> key`라는 강한 경로가 생겨 키가 강하게 도달 가능해지고, 키가 안 죽으니 엔트리도 안 죽는다(3-3). 실측으로도 확인된다 — 값이 키를 잡는 맵은 GC 후에도 `size()`가 1이고, 안 잡는 맵은 0이 된다.

값 객체가 **간접적으로** 키에 닿는 경우가 더 위험하다. `Session -> Order -> Customer -> User`처럼 몇 단계를 건너도 결과는 같으므로, 값에는 원시 값이나 키를 참조하지 않는 불변 DTO만 담는 것이 안전하다.

### "엔트리는 정확히 언제 사라지나요?"

**키가 회수되는 순간이 아니다.** 순서는 이렇다.

1. GC가 키를 회수하면서 `Entry`의 referent 자리를 null로 지우고, `Entry` 자체를 맵 내부의 `ReferenceQueue`에 넣는다. **이 시점에는 테이블에도 엔트리가 그대로 있고 `size` 필드도 안 줄어든다.**
2. 그 다음 누군가 맵의 메서드(`size()`, `get()`, `put()`, `entrySet()` 등)를 호출하면, 그 메서드가 첫 줄에서 `expungeStaleEntries()`를 불러 큐를 비우며 엔트리를 테이블에서 떼고 `size--` 한다.

리플렉션으로 내부를 직접 들여다보면 이 두 단계가 분리돼 있음이 그대로 보인다 — GC 직후에도 "테이블에 Entry 2개(그중 키가 null인 것 1개), size 필드 = 2"이고, `size()`를 한 번 부르면 그제서야 1이 된다.

실무적 함의는 둘이다. **아무도 맵을 건드리지 않으면 정리도 안 되므로**, 값이 무거우면 그동안 그 값이 힙을 계속 차지한다. 그리고 **`size()`는 스냅샷**이라 아무것도 넣거나 빼지 않아도 값이 달라질 수 있으므로 용량 판단의 근거로 쓰면 안 된다.

### "그러면 캐시를 WeakHashMap으로 만들면 되지 않나요?" (시니어 변별 포인트)

안 된다. **캐시가 답해야 하는 질문과 `WeakHashMap`이 답하는 질문이 다르기 때문이다.**

캐시의 존재 이유는 **"지금은 아무도 안 쓰지만 곧 또 쓸 것"**을 미리 들고 있는 것이다. 조회가 끝나 아무도 안 붙잡고 있는 값을 그래도 보관하고 있다가 다음 요청에 바로 내주는 것이 캐시다.

그런데 `WeakHashMap`이 유지해 주는 조건은 정확히 **"키를 지금 누군가 강하게 붙잡고 있는가"**다. 아무도 안 붙잡는 순간 사라진다. 즉 **캐시가 값을 들고 있어야 할 바로 그 구간에 `WeakHashMap`은 항목을 버린다.** 히트율이 사실상 0에 수렴하는 구조라, 캐시의 모양을 하고 있지만 캐시로 동작하지 않는다.

`SoftReference` 캐시는 이 문제는 없지만 다른 문제가 있다(2-1). 비워지는 조건이 **메모리 압박**이라 트래픽 패턴에 따라 히트율이 요동치고, 어떤 항목이 버려질지 고를 수 없고, soft 참조가 많아지면 GC 부담이 늘어난다.

**캐시를 비우는 기준은 메모리 압박이 아니라 사용 패턴이어야 한다.** 얼마나 최근에 얼마나 자주 쓰였는지, 데이터가 얼마나 오래되면 못 믿을 것이 되는지가 기준이다. 그래서 실무의 답은 Caffeine처럼 `maximumSize`·`expireAfterWrite`·`recordStats`로 **정책을 코드가 선언하고 히트율을 지표로 확인할 수 있는** 도구다.

정리하면 **참조 강도는 "생명주기 연동" 도구이지 "캐시 정책" 도구가 아니다.** `WeakHashMap`이 답하는 질문은 "누가 아직 이걸 쓰고 있는가"이고, 캐시가 답해야 하는 질문은 "이걸 또 쓸 확률이 얼마인가"다.

### "ThreadLocal의 메모리 누수와 어떻게 이어지나요?"

**구조가 정확히 같다.** `Thread` 객체 안의 `ThreadLocalMap`도 `Entry`가 `WeakReference`를 상속해 **키(ThreadLocal 인스턴스)만 약하게, 값은 강하게** 잡는다. `WeakHashMap`과 같은 설계다.

같은 설계이므로 같은 결과가 나온다. **키가 죽어도 값은 안 죽는다.** ThreadLocal 인스턴스가 어디서도 참조되지 않아 키가 회수되면 그 `Entry`는 stale entry가 되는데, `Thread -> ThreadLocalMap -> Entry -> value` 사슬에서 값 쪽은 여전히 강한 참조라 **키가 없어 꺼낼 수조차 없는 값이 힙에 남는다.**

정리 시점의 문제도 같다. `ThreadLocalMap`도 GC가 아니라 **그 맵에 `set()`/`get()`이 일어날 때 지나가는 김에** stale entry를 치운다. 해당 스레드가 그 맵을 다시 안 건드리면 영원히 안 치워진다. `WeakHashMap`의 `expungeStaleEntries()`와 같은 이야기다.

차이는 **누가 맵을 붙잡고 있느냐**다. `WeakHashMap`은 우리가 만든 맵이라 맵 자체를 버리면 끝이지만, `ThreadLocalMap`은 **톰캣 워커 스레드**가 붙잡고 있고 그 스레드는 풀에서 재사용되며 애플리케이션 내내 죽지 않는다. 그래서 ThreadLocal 쪽이 훨씬 위험하다.

결론도 같은 방향이다. **약한 참조 키는 안전망이 아니라 미봉책**이고, 확실한 해제는 요청 경계의 `finally`에서 `remove()`를 부르는 것 하나뿐이다(`16-threadlocal-thread-pool-risks.md`).

### "스레드 안전한가요? 대안은 뭐가 있나요?"

**안전하지 않다.** `HashMap`과 마찬가지로 동기화가 전혀 없다. 게다가 `WeakHashMap`에는 일반 `HashMap`에 없는 위험이 하나 더 있다 — **조회 메서드조차 내부 상태를 바꾼다.** `get()`이 `getTable()`을 거치며 `expungeStaleEntries()`로 테이블과 `size`를 수정하기 때문이다. 그래서 **"읽기만 하는 스레드"라는 개념이 성립하지 않는다.**

선택지는 셋이다.

**`Collections.synchronizedMap(new WeakHashMap<>())`** — 가장 단순하다. 모든 메서드를 하나의 락으로 감싼다. 다만 순회할 때는 사용하는 쪽이 직접 맵 객체에 `synchronized` 블록을 걸어야 하고, 락 경합이 있으면 처리량이 떨어진다.

**Guava의 `new MapMaker().weakKeys().makeMap()`** — 동시성을 지원하는 약한 키 맵이다. 3-6에서 본 대로 **키 비교가 `equals`가 아니라 `==`**라는 것이 `WeakHashMap`과의 결정적 차이다.

**Caffeine의 `Caffeine.newBuilder().weakKeys().build()`** — 캐시 정책(크기·만료·통계)과 약한 키를 함께 쓸 수 있다. 캐시가 목적이라면 이쪽이 맞다.

참고로 **`ConcurrentHashMap`에는 약한 키 버전이 없다.** 그래서 "동시성 + 약한 키"가 동시에 필요하면 JDK 표준만으로는 답이 없고 위 라이브러리 중 하나를 골라야 한다.

---

## 한 줄 요약

참조 강도는 도달 가능성 규칙 하나뿐인 GC에게 **"이건 메모리가 부족하면 버려도 되고(Soft), 이건 내가 붙잡고 있다는 사실을 살릴 근거로 세지 말라(Weak)"**고 말하는 유일한 수단이고 — 강도는 객체가 아니라 **화살표의 성질**이라 강한 화살표가 하나라도 있으면 그것이 이긴다 — `WeakHashMap`은 `Entry`가 `WeakReference`를 상속해 **키만** 약하게 잡는 맵이라 키를 아무도 안 쓰면 엔트리가 사라지지만, **값이 자기 키를 참조하면 무력화되고, 리터럴이나 -128~127 Integer를 키로 쓰면 애초에 회수되지 않으며, 정리는 GC 순간이 아니라 그 다음에 맵을 건드릴 때** `expungeStaleEntries()`로 일어나므로 `size()`는 스냅샷일 뿐이다. 그리고 이 도구는 **생명주기 연동**을 위한 것이지 캐시가 아니다 — 캐시는 "지금 누가 쓰는가"가 아니라 "또 쓸 확률이 얼마인가"로 비워야 하므로 Caffeine 같은 정책 기반 도구가 맞다.
