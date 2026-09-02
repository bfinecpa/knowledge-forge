# ThreadLocal — 값은 ThreadLocal이 아니라 Thread 안에 있다

> 핵심 관전 포인트: **ThreadLocal은 "같은 변수인데 스레드마다 다른 값"을 갖게 해주는 스레드 전용 저장소다. 인증 정보·트랜잭션 커넥션·로그 traceId처럼 모든 메서드에 파라미터로 넘기기 어려운 요청 문맥을 실어 나르는 데 쓴다. 위험은 전부 저장 구조에서 나온다 — 값은 ThreadLocal 객체가 아니라 `Thread` 객체 안의 `ThreadLocalMap`에 들어가고, ThreadLocal 인스턴스는 그 맵의 키일 뿐이다. 톰캣은 스레드를 만들고 버리는 게 아니라 풀에서 재사용하므로, 스레드가 살아 있는 한 그 맵도 값도 그대로 살아 있다. 그래서 `remove()`를 안 하면 ① 이전 요청의 데이터가 다음 요청(다른 사용자)에게 그대로 보이는 보안 사고와 ② 값이 GC되지 않는 메모리 누수가 동시에 생긴다. 요청 경계의 `finally`에서 `remove()`가 철칙이고, 비동기로 작업을 넘기면 반대로 문맥이 아예 전파되지 않는다.**

---

## 0. 질문 + 의도

**질문**: "ThreadLocal은 언제 쓰고, 톰캣 같은 스레드풀 환경에서 어떤 위험이 있나요?"

**출제 의도**: 톰캣은 스레드를 재사용하므로 정리 안 한 ThreadLocal은 "다른 사용자의 인증 정보가 섞여 보이는" 류의 보안 사고로 직결된다. 프레임워크가 숨겨준 실행 모델을 이해하고 쓰는지 확인하는 질문이다.

## 1. ThreadLocal의 저장 구조 — 이 그림 하나에서 모든 위험이 나온다

### 1-1. 전제 지식 — 내 컨트롤러 코드는 재사용되는 스레드 위에서 돈다

먼저 깔아야 할 사실이 하나 있다. **톰캣은 요청마다 스레드를 새로 만들지 않는다.** 애플리케이션이 뜰 때 워커 스레드를 미리 만들어 풀에 담아두고, 요청이 오면 그중 한 개를 빌려주고, 응답을 보내고 나면 그 스레드를 죽이지 않고 **풀로 되돌려 다음 요청에 다시 빌려준다.** 스프링 부트의 톰캣 기본 최대 워커 수는 200개다.

스레드를 매번 만들지 않는 이유는 비용 때문이다. OS 스레드 하나를 만들면 커널 자료구조와 스택 메모리(보통 1MB 수준)가 딸려 오는데, 초당 수천 건의 요청마다 이걸 만들고 버리면 그 비용이 실제 업무 처리 비용을 압도한다. 그래서 미리 만들어 돌려 쓴다.

이 사실은 평소에는 의식할 필요가 없다. 컨트롤러 메서드의 지역 변수와 파라미터는 **스레드마다 따로 있는 스택**에 올라가므로, 스레드가 재사용되든 말든 요청 사이에 섞일 일이 없기 때문이다. 요청이 끝나면 스택이 걷히고 다음 요청이 깨끗한 스택에서 시작한다.

**문제는 스택 바깥에 무언가를 남겨둘 때 생긴다.** ThreadLocal이 정확히 그 "스택 바깥, 그러나 스레드에 붙어 있는" 저장소다. 이 문서의 나머지는 전부 이 한 문장의 결과다.

### 1-2. ThreadLocal이란 — 스레드마다 칸이 다른 사물함

`ThreadLocal`은 **같은 변수를 여러 스레드가 읽고 써도 각 스레드가 자기 값만 보게** 해주는 저장소다.

```java
private static final ThreadLocal<String> currentUser = new ThreadLocal<>();

// 스레드 A                             // 스레드 B
currentUser.set("alice");               currentUser.set("bob");
currentUser.get();  // "alice"          currentUser.get();  // "bob"
```

`currentUser`는 분명히 `static` 필드 하나인데, A는 "alice"를 보고 B는 "bob"을 본다. 보통의 static 필드였다면 나중에 쓴 값이 앞의 값을 덮어썼을 것이다.

비유하면 **헬스장 사물함**이다. 사물함 번호(ThreadLocal 변수)는 하나지만, 그 번호로 회원(스레드)마다 자기 칸이 배정되어 각자 자기 물건만 넣고 뺀다. 번호를 공유한다고 물건이 섞이지는 않는다.

### 1-3. 값은 어디에 저장되는가 — 이름이 착각을 부른다

이름이 `ThreadLocal`이라 **값이 ThreadLocal 객체 안에 들어 있다고 착각하기 쉽지만 정반대다.** 값은 `Thread` 객체 안에 들어간다.

`Thread` 클래스에는 `threadLocals`라는 필드가 있고, 그 타입이 `ThreadLocalMap`이다. 이름 그대로 맵(키-값 저장소)이며, **키가 ThreadLocal 인스턴스, 값이 우리가 `set()`으로 넣은 값**이다.

```
[Thread 객체 #7]  (톰캣 워커 — 풀에 담긴 채 계속 살아 있다)
 └─ threadLocals : ThreadLocalMap
     ├─ Entry  key = currentUser 인스턴스 (약한 참조)  ->  value = User("alice")  (강한 참조)
     ├─ Entry  key = MDC의 ThreadLocal   (약한 참조)  ->  value = Map{traceId=..} (강한 참조)
     └─ Entry  key = 트랜잭션의 ThreadLocal(약한 참조) ->  value = Connection      (강한 참조)

[Thread 객체 #8]  (또 다른 톰캣 워커)
 └─ threadLocals : ThreadLocalMap
     └─ Entry  key = currentUser 인스턴스 (7번과 같은 키!) -> value = User("bob")
```

이 그림에서 정확히 읽어야 할 것은 두 가지다.

**첫째, ThreadLocal 인스턴스는 저장소가 아니라 키다.** `currentUser` 객체는 값을 하나도 들고 있지 않다. 스레드 #7의 맵에서도 키, 스레드 #8의 맵에서도 키로 쓰일 뿐이다.

**둘째, 값의 개수는 스레드 수만큼이다.** ThreadLocal 하나를 선언했다고 값이 하나가 아니라, 그 ThreadLocal에 `set()`을 한 스레드 수만큼 값이 존재한다. 워커 200개가 전부 `set()`했다면 값도 200개다.

메서드 동작도 이 구조에서 그대로 따라 나온다.

- `set(v)`: `Thread.currentThread()`를 찾아 **그 스레드의 맵**에 `(this, v)`를 넣는다.
- `get()`: `Thread.currentThread()`를 찾아 **그 스레드의 맵**에서 `this`를 키로 조회한다.
- `remove()`: **그 스레드의 맵**에서 `this` 항목을 지운다.

세 메서드 모두 "현재 스레드"를 기준으로 동작한다는 점이 핵심이다. **실행 중인 스레드가 바뀌면 뒤지는 맵 자체가 바뀐다.**

### 1-4. 이 한 그림에서 나오는 세 가지 결론

방금 본 구조에서 이 문서의 위험 세 개가 전부 따라 나온다. 미리 한 번 짚고 가면 뒤가 쉬워진다.

**결론 (a) 스레드가 살아 있는 한 값도 살아 있다.** 값은 `Thread` 객체가 붙잡고 있으므로, 스레드의 수명이 곧 값의 수명이다. 요청이 끝나는 것과 값이 사라지는 것은 아무 관계가 없다.

**결론 (b) 그래서 톰캣 풀에서는 요청 A의 값이 요청 B에 새어 나간다.** 스레드 #7이 요청 A를 처리하며 넣은 값은 응답 후에도 #7의 맵에 남아 있고, #7이 요청 B를 빌려주면 요청 B의 코드가 그 값을 그대로 읽는다.

**결론 (c) 키는 약한 참조인데 값은 강한 참조라, 값이 GC되지 않는다.** `Entry`는 키(ThreadLocal)만 약하게 붙잡고 값은 강하게 붙잡는다. 그래서 키가 사라져도 `Thread -> ThreadLocalMap -> Entry -> value`라는 강한 참조 사슬이 남아 값은 회수되지 않는다.

(a)(b)(c)를 각각 2절과 3절에서 풀어 본다.

## 2. 언제 쓰나 — 파라미터로 넘길 수 없는 요청 문맥

### 2-1. 문제 상황 — 시그니처를 오염시키지 않고 문맥을 나르기

한 요청을 처리하는 동안 컨트롤러에서 서비스, 서비스에서 리포지터리, 그 사이의 유틸리티까지 수십 개 메서드를 거친다. 그런데 그 깊은 곳에서 "지금 요청한 사람이 누구인지"나 "이 요청의 추적 ID가 뭔지"가 필요해진다.

가장 정직한 방법은 파라미터로 넘기는 것이다. 문제는 **중간에 그 값을 전혀 쓰지 않는 메서드들까지 전부 시그니처를 바꿔야** 한다는 점이다.

```java
// Before: 쓰지도 않는 값을 그저 전달하기 위해 시그니처가 오염된다
public Order create(OrderRequest req, User user, String traceId) {
    return orderProcessor.process(req, user, traceId);   // 여기선 안 쓰는데 받아서 넘김
}
```

이렇게 **여러 계층을 가로질러 필요한 관심사**를 횡단 관심사(cross-cutting concern)라고 부른다. 계층을 세로로 자르는 게 아니라 가로로 관통한다고 해서 "횡단"이다. 인증 정보, 로그 추적 ID, 트랜잭션 커넥션, 다국어 로케일이 전형적인 예다.

ThreadLocal은 이 문맥을 **시그니처가 아니라 스레드에 실어 나른다.** "한 요청은 한 스레드가 끝까지 처리한다"는 서블릿 모델의 전제 덕분에, 스레드에 붙여두면 그 요청의 어느 지점에서든 꺼내 쓸 수 있다.

```java
// After: 요청 경계에서 한 번 넣고, 필요한 곳에서 꺼내 쓴다
public Order create(OrderRequest req) {
    return orderProcessor.process(req);   // 중간 계층은 문맥을 몰라도 된다
}
```

### 2-2. 이미 매일 쓰고 있다 — 프레임워크 기능들의 정체

ThreadLocal을 직접 써본 적이 없더라도, 스프링 애플리케이션을 만들었다면 이미 하루에도 수백 번 쓰고 있다. 아래 기능들이 전부 ThreadLocal 위에 서 있다.

**Spring Security의 `SecurityContextHolder`.** 아무 서비스 메서드에서나 `SecurityContextHolder.getContext().getAuthentication()`을 부르면 현재 사용자가 나오는 이유가 이것이다. 인증 필터가 요청 초입에서 인증 결과를 ThreadLocal에 넣어두기 때문이다.

**`@Transactional`.** 스프링이 트랜잭션을 시작하면서 획득한 DB 커넥션을 `TransactionSynchronizationManager`가 ThreadLocal에 바인딩한다. 그래야 같은 스레드에서 실행되는 여러 리포지터리 호출이 **각자 커넥션을 새로 빌리지 않고 같은 커넥션을 쓴다.** 같은 커넥션을 써야 같은 트랜잭션이 되기 때문이다.

**로그 MDC(Mapped Diagnostic Context).** 진단 정보를 키-값으로 담아두는 맵이라는 뜻의 이름이다. 요청 초입에서 `MDC.put("traceId", ...)`을 해두면 그 스레드에서 찍는 모든 로그에 traceId가 자동으로 붙는다. 로그 한 줄마다 traceId를 인자로 넘기지 않아도 되는 이유가 이것이다.

**스레드 안전하지 않은 객체를 스레드별로 하나씩 두는 용도.** 여러 스레드가 같이 쓰면 깨지는 객체를 공유하는 대신, 스레드마다 자기 인스턴스를 갖게 하는 방식이다.

```java
// Before: SimpleDateFormat은 내부에 가변 Calendar 필드를 두고 거기에
// 파싱 중간 결과를 쌓는다. 여러 스레드가 한 인스턴스를 동시에 쓰면
// 서로의 중간 결과를 덮어써서 날짜가 뒤섞이거나 예외가 튄다.
private static final SimpleDateFormat FMT = new SimpleDateFormat("yyyy-MM-dd");

// After: 스레드마다 자기 인스턴스를 갖게 해 공유 자체를 없앤다.
// withInitial은 "그 스레드에서 처음 get()할 때 이 함수로 값을 만들어라"는 뜻이다.
private static final ThreadLocal<SimpleDateFormat> FMT =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));
```

다만 이 용법에는 단서가 붙는다. **진짜 정답은 불변이라 애초에 공유해도 안전한 `DateTimeFormatter`로 갈아타는 것**이고, ThreadLocal은 레거시 코드를 당장 걷어낼 수 없을 때의 차선책이다 (가산점 포인트). 가변 상태를 없애는 게 아니라 스레드별로 격리하는 대증요법이기 때문이다. `22-static-simpledateformat-shared-mutable-state.md`에서 이 판단을 자세히 다룬다.

## 3. 스레드풀 환경의 위험 — 톰캣은 스레드를 버리지 않는다

1-1에서 본 대로 톰캣은 워커 스레드를 재사용한다. 여기에 1-4의 결론 (a) "스레드가 살아 있는 한 값도 살아 있다"를 겹치면, **"스레드가 죽으면 ThreadLocal 값도 사라진다"는 안전장치가 작동하지 않는 환경**이 된다. 위험 세 개가 여기서 나온다.

### 3-1. 위험 ① 데이터 오염 — 다른 사용자의 정보가 보인다

```java
// Before: 넣기만 하고 지우지 않는 인증 필터
void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) {
    currentUser.set(authenticate(request));   // alice로 인증해 스레드에 붙인다
    chain.doFilter(request, response);
    // remove()가 없다. 스레드는 alice를 담은 채 그대로 풀로 반납된다.
}
```

이 코드가 만드는 사고를 타임라인으로 보면 이렇다.

```
t0   요청 1 (alice) 이 워커 스레드 #7에 배정
     -> currentUser.set(alice)
     -> 스레드 #7 맵: { currentUser -> alice }

t1   요청 1 응답 완료. 스레드 #7이 풀로 반납된다.
     -> 스레드 #7 맵: { currentUser -> alice }   ★ 그대로 남아 있다

t2   요청 2 가 스레드 #7에 배정된다.
     이 요청은 인증이 필요 없는 공개 API이거나, 인증에 실패해
     set()이 호출되지 않는 경로다.

t3   요청 2 의 코드가 currentUser.get() 을 호출
     -> 스레드 #7 맵을 뒤진다 -> alice 가 나온다   ★ 사고
```

결과는 데이터 유출이다. 인증되지 않은 요청이 alice로 인식되어 alice의 주문 내역을 조회하고, 최악의 경우 alice의 이름으로 쓰기 작업까지 한다.

이 버그가 악랄한 이유는 **재현이 안 된다**는 점이다. 어느 요청이 어느 스레드에 배정될지는 그때그때 다르므로, 사고가 나려면 "직전에 그 스레드를 쓴 요청이 값을 남겼고, 지금 요청은 값을 덮어쓰지 않는 경로"라는 두 조건이 겹쳐야 한다. 개발자 혼자 테스트하면 스레드가 한두 개만 돌아 거의 걸리지 않고, **트래픽이 많은 운영에서만 간헐적으로 터진다.**

"가끔 다른 사람 이름이 보인대요"라는 CS 문의가 들어오면 정리되지 않은 ThreadLocal을 가장 먼저 의심해야 하는 이유다.

### 3-2. 위험 ② 메모리 누수 — 값이 GC되지 않는다

1-4의 결론 (c)를 여기서 풀어 본다. 참조 사슬을 다시 보자.

```
[Thread #7]  --강한 참조-->  ThreadLocalMap  --강한 참조-->  Entry
                                                              |
                                       key: ThreadLocal (약한 참조)
                                       value: 우리가 넣은 객체 (강한 참조)
```

**강한 참조(strong reference)**는 우리가 평소에 쓰는 보통의 참조다. 강한 참조로 붙잡혀 있는 객체는 GC가 절대 회수하지 않는다. **약한 참조(weak reference)**는 "붙잡고는 있지만 GC가 회수해도 좋다"는 뜻의 약한 연결이다. 다른 강한 참조가 없으면 GC가 그냥 가져간다.

`Entry`는 키만 약하게 잡고 값은 강하게 잡는다. 키를 약하게 잡은 것은 나름의 배려다 — ThreadLocal 인스턴스 자체가 어디서도 참조되지 않게 되면 키가 GC되고, 그 `Entry`는 "키가 null인 항목", 즉 **stale entry(낡은 항목)**가 된다. `ThreadLocalMap`은 이후 그 맵에 `set()`이나 `get()`이 일어날 때 지나가는 김에 stale entry를 정리한다.

문제는 **그 정리가 언제 일어날지 보장이 없다**는 것이다. 해당 스레드가 그 맵을 다시 건드리지 않으면 stale entry는 영원히 남고, 키는 사라졌는데 값은 강한 참조로 매달려 있으니 **키가 없어 꺼낼 수도 없는 값이 힙에 눌러앉는다.**

실무에서 더 흔한 형태는 stale entry조차 아니다. ThreadLocal을 `static final`로 선언하면 키는 애플리케이션이 사는 동안 절대 GC되지 않으므로 stale entry는 생기지 않지만, **값은 remove하지 않는 한 그대로 남는다.**

누수 규모는 곱셈으로 계산된다.

```
워커 스레드 200개 × 요청마다 넣은 객체 1MB = 200MB 상주
```

요청마다 파싱 결과나 조회 캐시 같은 큰 객체를 ThreadLocal에 넣고 지우지 않으면, 모든 워커가 한 번씩 그 코드를 지나간 시점부터 200MB가 힙에서 회수되지 않는 상태로 고정된다. 새 요청이 값을 덮어쓰면 이전 값은 회수되지만, 항상 **워커 수만큼의 객체는 상시 살아 있게** 된다.

**웹 애플리케이션 재배포 시에는 더 큰 문제로 번진다.** 값 객체가 우리 애플리케이션의 클래스를 참조하고 있으면, 그 값을 통해 **이전 버전의 클래스로더 전체**가 붙잡힌다. 톰캣은 재배포 시 워커 스레드를 그대로 두고 애플리케이션만 갈아 끼우므로, 살아남은 스레드의 맵이 옛 클래스로더를 놓아주지 않는다. 그러면 이전 앱의 모든 클래스 메타데이터가 Metaspace에 남고, 재배포를 반복할수록 쌓인다. 톰캣이 애플리케이션 종료 시 "이 웹 애플리케이션이 ThreadLocal을 만들었는데 정리하지 않았다"는 경고를 남기는 이유가 정확히 이것이다.

### 3-3. 올바른 사용 — 요청 경계의 finally에서 remove()

오염과 누수는 원인이 하나이므로 대응도 하나다. **값을 넣은 스레드가 풀로 돌아가기 전에 반드시 지운다.**

```java
// After: 요청 경계(필터/인터셉터)에서 넣고, 반드시 finally에서 지운다
void doFilter(ServletRequest request, ServletResponse response, FilterChain chain) {
    currentUser.set(authenticate(request));
    try {
        chain.doFilter(request, response);
    } finally {
        // finally여야 하는 이유: 아래 체인에서 예외가 터져도 스레드는
        // 어차피 풀로 반납된다. 정상 경로에서만 지우면 예외가 난 요청의
        // 값이 그대로 남아 다음 요청에 새어 나간다.
        currentUser.remove();
    }
}
```

`remove()`를 `try` 블록 끝에 두는 것과 `finally`에 두는 것의 차이는 사고 확률의 차이가 아니다. **예외가 나는 요청은 오히려 흔하고**, 그럴 때마다 오염된 스레드가 하나씩 늘어난다.

여기서 실무적으로 중요한 구분이 하나 있다. **Spring Security, MDC 필터, `@Transactional` 같은 프레임워크 기능은 이 정리를 프레임워크가 해준다.** `SecurityContextPersistenceFilter`는 요청이 끝나면 컨텍스트를 지우고, 트랜잭션 매니저는 커밋/롤백 후 커넥션 바인딩을 해제한다.

**위험한 것은 우리가 직접 만든 ThreadLocal이다.** 직접 선언했다면 `set`과 `remove`의 짝을 요청 경계에서 우리가 책임져야 하고, 그 짝을 보장하는 자리는 필터나 인터셉터의 `finally`다. 서비스 계층 여기저기서 `set`하고 아무도 `remove`하지 않는 구조가 사고의 전형이다.

### 3-4. 위험 ③ 비동기로 넘기면 값이 아예 사라진다

오염이 "지워야 할 값이 남는" 문제라면, 이번엔 반대로 **있어야 할 값이 없는** 문제다. 원인은 같다 — ThreadLocal은 스레드에 붙어 있다.

```java
// Before: @Async 메서드는 톰캣 워커가 아니라 다른 풀의 다른 스레드에서 실행된다
@Async
public void sendMail() {
    User user = currentUser.get();   // null
    // 톰캣 워커의 맵에 있던 값이지, 이 실행 스레드의 맵에는 없다.
}
```

1-3에서 본 대로 `get()`은 `Thread.currentThread()`의 맵을 뒤진다. `@Async` 메서드를 실행하는 것은 스프링의 태스크 실행기 풀에 속한 **다른 스레드**이고, 그 스레드의 맵은 이 문맥에 대해 비어 있다.

같은 이유로 `CompletableFuture.supplyAsync(...)`의 람다, `parallelStream()`의 람다도 전부 문맥이 끊긴다. 증상은 단순히 null이 나오는 데 그치지 않는다.

- `SecurityContextHolder`가 비어 인가 검사가 실패하거나, 감사 로그에 사용자가 안 남는다.
- MDC가 비어 비동기 구간의 로그에 traceId가 빠지고, 분산 추적이 그 지점에서 끊긴다.
- 트랜잭션 커넥션 바인딩이 없어, 비동기 스레드의 DB 접근이 **트랜잭션 밖에서 auto-commit으로** 실행된다. 예외가 나지 않고 조용히 틀린다는 점에서 가장 위험하다.

해결은 **작업을 제출하는 시점에 값을 복사해서 넘기는 것**이다. 호출 스레드에서 값을 캡처해 두었다가, 실행 스레드에서 `set` → 작업 실행 → `finally`에서 `remove` 하는 껍데기로 작업을 감싼다.

```java
// After: 스프링의 TaskDecorator로 제출 시점의 문맥을 복사한다
public class ContextCopyingDecorator implements TaskDecorator {
    @Override
    public Runnable decorate(Runnable task) {
        // 이 줄은 '제출하는 스레드'(톰캣 워커)에서 실행된다 — 지금 캡처해야 한다.
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        SecurityContext security = SecurityContextHolder.getContext();

        return () -> {
            // 이 안쪽은 '실행하는 스레드'(비동기 풀)에서 실행된다.
            if (mdc != null) MDC.setContextMap(mdc);
            SecurityContextHolder.setContext(security);
            try {
                task.run();
            } finally {
                // 비동기 풀의 스레드도 재사용되므로, 3-1의 오염과
                // 3-2의 누수가 여기서 그대로 재발한다. 정리는 여기서도 필수다.
                MDC.clear();
                SecurityContextHolder.clearContext();
            }
        };
    }
}
```

`decorate` 바깥과 람다 안쪽이 **서로 다른 스레드에서 실행된다**는 점이 이 코드의 전부다. 캡처는 바깥에서(호출 스레드), 복원은 안쪽에서(실행 스레드) 해야 한다. Spring Security는 같은 일을 하는 `DelegatingSecurityContextExecutor`를 따로 제공한다.

**`InheritableThreadLocal`로 해결하려는 시도는 스레드풀에서 실패한다.** `InheritableThreadLocal`은 이름 그대로 상속되는 ThreadLocal인데, 상속이 일어나는 시점이 **자식 스레드를 `new Thread()`로 생성하는 그 순간**이다. 스레드풀은 스레드를 애초에 딱 한 번 만들어놓고 계속 재사용하므로, 풀 스레드가 물려받는 것은 **"풀이 스레드를 만들던 시점"의 값**이지 "지금 작업을 제출한 요청"의 값이 아니다.

결과는 오히려 더 나쁘다. null이 나오면 즉시 알아채기라도 하는데, **엉뚱한 옛날 값이 그럴듯하게 나오면 한참 뒤에야 발견된다.** Spring Security의 `MODE_INHERITABLETHREADLOCAL` 설정이 스레드풀 환경에서 권장되지 않는 이유이기도 하다. 풀 환경의 답은 상속이 아니라 **제출 시점 복사**다.

### 3-5. 가상 스레드에서는 어떻게 달라지는가 (가산점 포인트)

가상 스레드(virtual thread)는 JVM이 관리하는 가벼운 스레드로, OS 스레드에 1:1로 묶이지 않아 수십만 개를 만들어도 부담이 적다. 여기서 ThreadLocal의 전제가 뒤집힌다.

**오염 위험은 사라진다.** 가상 스레드는 **풀링하지 않고 작업(요청)마다 새로 만들어 쓰고 버리는** 모델이 표준이다. 스레드가 재사용되지 않으므로 1-4의 결론 (b)가 성립하지 않는다. 요청이 끝나면 스레드가 사라지고 그 맵도 값도 함께 회수된다.

**대신 개수 비용이 문제가 된다.** 값의 개수는 스레드 수만큼이라는 1-3의 사실이 여기서 반대 방향으로 작용한다. 스레드가 200개일 때는 "스레드당 하나씩 만들어 재사용해서 아낀다"는 계산이 성립했지만(2-2의 `SimpleDateFormat` 예), 스레드가 수십만 개면 인스턴스도 수십만 개가 되어 **아끼려던 비용이 오히려 부담이 된다.**

이 지점에서 `ScopedValue`가 나온 배경이 설명된다. 가상 스레드와 함께 프리뷰로 도입된 API로, ThreadLocal과 문제 의식은 같지만 설계가 반대다.

| | ThreadLocal | ScopedValue |
|---|---|---|
| 값 | 가변 — 아무 때나 `set`으로 바꿈 | 불변 — 바인딩 시점에 정해짐 |
| 수명 | 스레드 수명 (직접 `remove` 필요) | 정해진 실행 범위 (자동 해제) |
| 정리 누락 | 오염·누수로 이어짐 | 구조적으로 불가능 |

```java
// ScopedValue: 값이 유효한 범위를 코드 블록으로 명시한다
private static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

ScopedValue.where(CURRENT_USER, alice).run(() -> {
    handleRequest();   // 이 블록 안에서만 CURRENT_USER.get() 이 alice
});
// 블록을 벗어나면 바인딩이 자동으로 풀린다 — remove()를 잊을 방법이 없다
```

핵심은 **ThreadLocal의 손익이 스레드의 수명 모델에 종속된다**는 것이다. 풀(재사용)에서는 오염과 누수를, 가상 스레드(대량 생성)에서는 개수 비용을 걱정해야 한다. 같은 API인데 걱정거리가 정반대로 바뀐다.

## 4. 꼬리질문 대비 포인트

### "ThreadLocalMap의 키는 약한 참조라던데, 그런데도 왜 메모리 누수가 생기나요?"

**약한 참조인 것은 키(ThreadLocal 객체) 쪽뿐이고, 값은 강한 참조**이기 때문이다.

ThreadLocal 객체가 다른 곳에서 참조를 잃으면 키는 GC되어 `Entry`가 stale entry(키가 null인 항목)가 된다. 하지만 `Thread -> ThreadLocalMap -> Entry -> value` 사슬에서 값 쪽은 여전히 강한 참조라 값은 살아남는다. 키가 없어 **꺼낼 수도 없는 값이 힙을 차지하는** 상태다.

stale entry는 이후 그 맵에 `set`/`get`/`remove`가 일어날 때 부수적으로 청소될 수 있지만 **보장이 없다.** 그 스레드가 해당 맵을 다시 건드리지 않으면 영원히 남는다.

정리하면 **약한 참조 키는 안전망이 아니라 미봉책**이고, 확실한 해제는 `remove()` 하나뿐이다. (약한 참조 자체의 동작은 `31-reference-types-weakhashmap.md`와 연결된다.)

### "static final로 선언한 ThreadLocal도 누수가 되나요?"

**된다. 오히려 stale entry 문제만 없어질 뿐 값 누수는 그대로다.**

`static final`이면 ThreadLocal 객체가 애플리케이션이 사는 동안 강하게 참조되므로 키가 GC될 일이 없다 — 즉 stale entry는 생기지 않는다. 여기까지만 보고 "그럼 안전하겠네"로 넘어가는 것이 흔한 오해다.

값 쪽 이야기는 전혀 달라지지 않는다. `remove()`하지 않으면 **워커 스레드 수만큼의 값이 상시 살아 있고**, 재배포 환경에서는 그 값이 이전 앱의 클래스로더를 붙잡아 Metaspace 누수로 번진다.

선언 방식과 무관하게 원칙은 하나다 — **쓰고 나면 remove.**

### "@Async나 CompletableFuture로 작업을 넘기면 ThreadLocal 값은 어떻게 되나요?"

**안 넘어간다.** `get()`은 실행 중인 스레드의 맵을 뒤지는데 실행 스레드가 바뀌었기 때문이다.

해결은 **제출 시점 복사**다. 작업을 감싸는 데코레이터에서 호출 스레드의 값(MDC 맵, `SecurityContext` 등)을 캡처해 두었다가, 실행 스레드에서 `set`하고 작업이 끝나면 `finally`에서 정리한다. 스프링이라면 Executor에 `TaskDecorator`를 끼우는 것이 표준적이고, Spring Security는 `DelegatingSecurityContextExecutor`를 제공한다.

여기에 **정리(finally remove)를 빼먹으면 비동기 풀에서 오염과 누수가 그대로 재발한다**는 것까지 말하면 가산점 포인트다. 톰캣 풀만 재사용되는 게 아니라 비동기 실행기 풀도 똑같이 재사용되기 때문이다.

### "InheritableThreadLocal을 쓰면 해결되지 않나요?"

**스레드풀에서는 해결되지 않고, null이 나오는 것보다 나쁜 결과가 나온다.**

`InheritableThreadLocal`이 값을 복사하는 시점은 **자식 스레드를 생성하는 순간**이다. 스레드풀은 스레드를 한 번만 만들어놓고 계속 재사용하므로, 풀 스레드가 물려받은 값은 "풀이 스레드를 만들던 시점"의 값이다. 지금 작업을 제출한 요청과는 아무 관계가 없다.

그래서 요청마다 다른 문맥을 기대했는데 **모든 요청이 같은 옛날 값을 보게** 된다. null이면 즉시 NPE로 드러나기라도 하는데, 그럴듯한 값이 나오면 발견이 한참 늦는다.

풀 환경의 답은 상속이 아니라 **제출 시점 복사(데코레이터)**다.

### "Virtual Thread 환경에서는 ThreadLocal을 어떻게 봐야 하나요?" (시니어 변별 포인트)

**전제가 뒤집히므로 걱정거리도 바뀐다**고 답하는 것이 핵심이다.

가상 스레드도 ThreadLocal을 지원하지만, 스레드를 **풀링하지 않고 작업마다 새로 만들어 버리는** 모델이라 재사용 오염 위험은 사라진다. 요청이 끝나면 스레드와 함께 맵도 값도 회수된다.

대신 반대편 비용이 커진다. 값은 스레드마다 하나씩 존재하므로 스레드가 수십만 개가 되면 값도 수십만 개다. "스레드당 하나씩 만들어 재사용해 비용을 아낀다"는 전제(예: `SimpleDateFormat` 재사용) 자체가 무너진다.

그래서 "값을 계속 바꿔 끼우는 가변 저장소"라는 용법 대신, **정해진 실행 범위 동안 불변 값을 공유하는 `ScopedValue`** 같은 대안이 나왔다. 범위를 벗어나면 바인딩이 자동으로 풀리므로 `remove()` 누락이라는 사고 유형 자체가 사라진다.

한 문장으로 정리하면 **ThreadLocal의 손익은 스레드의 수명 모델에 종속된다** — 풀(재사용)에서는 오염과 누수를, 가상 스레드(대량 생성)에서는 개수 비용을 걱정해야 한다.

---

## 한 줄 요약

ThreadLocal의 값은 ThreadLocal 객체가 아니라 `Thread` 객체 안의 `ThreadLocalMap`에 ThreadLocal 인스턴스를 키로 저장되므로 **스레드가 살아 있는 한 값도 살아 있고**, 톰캣은 워커 스레드를 재사용하기 때문에 요청 경계의 `finally`에서 `remove()`하지 않으면 이전 요청의 데이터가 다음 사용자에게 보이는 보안 사고와 (키는 약한 참조지만 값은 강한 참조라) GC되지 않는 메모리 누수가 함께 터진다 — 반대로 `@Async`·`CompletableFuture`처럼 스레드가 바뀌는 순간에는 문맥이 전파되지 않으므로 `TaskDecorator`로 제출 시점에 복사해야 하고(`InheritableThreadLocal`은 생성 시점 복사라 풀에서는 오답), 가상 스레드에서는 재사용 오염이 사라지는 대신 스레드 수만큼의 값이 부담이 되어 `ScopedValue`가 등장했다.
