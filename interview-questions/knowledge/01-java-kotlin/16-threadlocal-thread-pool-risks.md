# ThreadLocal — 스레드마다 독립된 저장소, 스레드풀에서는 시한폭탄

> 핵심 관전 포인트: **ThreadLocal은 "같은 변수인데 스레드마다 다른 값"을 갖는
> 스레드 전용 저장소다. 파라미터로 일일이 넘기기 어려운 요청 문맥(인증 정보,
> 트랜잭션, 로그 traceId)을 실어 나르는 데 쓴다.
> 위험은 톰캣의 실행 모델에서 온다 — 톰캣은 스레드를 만들고 버리는 게 아니라
> 풀에서 재사용하므로, `remove()`를 안 하면 ① 이전 요청의 데이터가 다음
> 요청(다른 사용자!)에게 그대로 노출되고 ② 값이 GC되지 않는 메모리 누수가
> 생긴다. 사용 후 finally에서 `remove()`가 철칙이다.**

---

## 0. 질문 + 의도

**질문**: "ThreadLocal은 언제 쓰고, 톰캣 같은 스레드풀 환경에서 어떤 위험이
있나요?"

**출제 의도**: 톰캣은 스레드를 재사용하므로 정리 안 한 ThreadLocal은 "다른
사용자의 인증 정보가 섞여 보이는" 류의 보안 사고로 직결된다. 프레임워크가
숨겨준 실행 모델을 이해하고 쓰는지 확인하는 질문이다.

## 1. ThreadLocal이란 — 스레드마다 칸이 다른 사물함

같은 `ThreadLocal` 변수를 여러 스레드가 읽고 써도, **각 스레드는 자기 값만
본다.** 비유하면 헬스장 사물함이다 — 사물함 번호(ThreadLocal 변수)는 하나지만,
회원(스레드)마다 자기 칸에 자기 물건을 넣는다.

```java
private static final ThreadLocal<String> currentUser = new ThreadLocal<>();

// 스레드 A                             // 스레드 B
currentUser.set("alice");               currentUser.set("bob");
currentUser.get();  // "alice"          currentUser.get();  // "bob"
```

### 내부 구조 (위험을 이해하는 데 필수)

값은 ThreadLocal 객체가 아니라 **각 Thread 객체 안에** 저장된다.

```
Thread 객체
 └─ threadLocals: ThreadLocalMap
     └─ Entry[ key = ThreadLocal 참조(약한 참조), value = 저장한 값(강한 참조) ]
```

- `set()`은 "현재 스레드의 맵"에 넣고, `get()`은 "현재 스레드의 맵"에서 꺼낸다
- **스레드가 살아 있는 한 그 맵도, 그 안의 value도 살아 있다** — 이 사실이
  뒤에 나올 두 위험(오염·누수)의 뿌리다

## 2. 언제 쓰나 — "모든 메서드에 파라미터로 넘기기 싫은 요청 문맥"

한 요청을 처리하는 동안 수십 개 메서드를 거치는데, 인증 정보나 traceId를
**모든 메서드 시그니처에 파라미터로 추가할 수는 없다.** 이런 횡단
관심사(cross-cutting context)를 스레드에 붙여 나르는 것이 ThreadLocal의
정당한 용도다. 실제로 매일 쓰는 프레임워크 기능들이 전부 이것이다:

- **Spring Security `SecurityContextHolder`** — 현재 요청의 인증 정보
- **`@Transactional`** — 트랜잭션 시작 시 획득한 DB 커넥션을 ThreadLocal에
  바인딩해서, 같은 스레드의 Repository 호출들이 같은 커넥션을 쓰게 한다
  (`TransactionSynchronizationManager`)
- **로그 MDC** — traceId/userId를 넣어두면 그 스레드의 모든 로그에 자동 출력
- **thread-safe하지 않은 객체의 공유 회피** — 인스턴스를 스레드별로 하나씩

```java
// ❌ before: SimpleDateFormat은 내부 상태를 가져 thread-safe하지 않다
private static final SimpleDateFormat FMT = new SimpleDateFormat("yyyy-MM-dd");
// 여러 요청 스레드가 동시에 쓰면 날짜가 뒤섞여 파싱된다

// ✅ after: 스레드마다 자기 인스턴스
private static final ThreadLocal<SimpleDateFormat> FMT =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));
// (진짜 정답은 불변인 DateTimeFormatter로 교체 — 가산점 포인트)
```

## 3. 스레드풀 환경의 위험 — 톰캣은 스레드를 버리지 않는다

톰캣은 요청마다 스레드를 새로 만들지 않고, **풀에 담긴 워커 스레드를 계속
재사용**한다. "스레드가 죽으면 ThreadLocal도 사라진다"는 안전장치가
**작동하지 않는 환경**이라는 뜻이다.

### 위험 ① 데이터 오염 — 다른 사용자의 정보가 보인다 (보안 사고)

```java
// ❌ 요청 처리 필터
void doFilter(request, response, chain) {
    currentUser.set(authenticate(request));   // alice로 인증
    chain.doFilter(request, response);
    // remove() 없이 끝남 — 스레드는 alice를 담은 채 풀로 반납된다
}
```

사고 시나리오:

1. 요청 1: alice가 로그인 → 워커 스레드 #7에 `currentUser = alice` 저장
2. 요청 2: **인증에 실패하거나 인증을 건너뛰는 경로**의 요청이 스레드 #7에 배정
3. `set()`이 호출되지 않았으므로 `get()`은 **이전 요청의 alice를 반환**
4. bob의 화면에 alice의 주문 내역이 보인다 — 데이터 유출 사고

이 버그의 악랄한 점: 스레드 배정은 운에 달렸으므로 **재현이 안 되고, 트래픽이
많은 운영에서만 간헐적으로 터진다.** "가끔 다른 사람 이름이 보인대요"라는
문의가 들어오면 가장 먼저 의심할 곳이 정리 안 된 ThreadLocal이다.

### 위험 ② 메모리 누수 — 값이 GC되지 않는다

스레드가 풀에서 계속 살아 있으므로 `Thread → ThreadLocalMap → Entry → value`
강한 참조 사슬도 계속 살아 있다. 요청마다 큰 객체(파싱 결과, 캐시 등)를
넣고 remove하지 않으면 **워커 스레드 수 × 객체 크기**만큼 힙에 눌러앉는다.
웹앱 재배포 시에는 value가 이전 클래스로더를 붙잡아 Metaspace/클래스로더
누수로 번지기도 한다 (톰캣이 재배포 때 "ThreadLocal을 정리하지 않았다"는
경고를 남기는 이유).

### 올바른 사용 — finally에서 remove()

```java
// ✅ after: 요청 경계(필터/인터셉터)에서 넣고, 반드시 finally에서 지운다
void doFilter(request, response, chain) {
    currentUser.set(authenticate(request));
    try {
        chain.doFilter(request, response);
    } finally {
        currentUser.remove();   // 예외가 나도 반드시 정리 — 오염·누수 둘 다 차단
    }
}
```

Spring Security, MDC 필터 등 프레임워크 제공 기능은 이 정리를 프레임워크가
해준다. **위험한 것은 우리가 직접 만든 ThreadLocal** — 만들었다면 요청
경계에서 set/remove의 짝을 우리가 책임져야 한다.

### 위험 ③ 비동기로 넘어가면 값이 사라진다 (오염의 반대 문제)

```java
// ❌ @Async 메서드는 다른 풀의 다른 스레드에서 실행된다
@Async
public void sendMail() {
    currentUser.get();   // null! — 호출한 스레드의 ThreadLocal은 안 넘어온다
}
```

`@Async`, `CompletableFuture`, `parallelStream()`은 **다른 스레드**에서
실행되므로 ThreadLocal 문맥이 끊긴다. 필요하면 작업 제출 시점에 값을 복사해
넘기는 장치(Spring의 `TaskDecorator`로 MDC/SecurityContext 복사 등)를 직접
달아야 한다. "ThreadLocal은 스레드에 붙어 있다"는 같은 원리의 다른 얼굴이다.

## 4. 꼬리질문 대비 포인트

### "ThreadLocalMap의 key는 약한 참조라던데, 그런데도 왜 메모리 누수가 생기나요?"

약한 참조인 것은 **key(ThreadLocal 객체) 쪽만**이다. ThreadLocal 객체가
참조를 잃으면 key는 GC되지만, **value는 여전히 강한 참조**로 Entry에 매달려
있다(`Thread → ThreadLocalMap → Entry → value`). key가 null이 된 stale entry는
이후 그 맵에 set/get이 일어날 때 부수적으로 청소될 수 있을 뿐 보장이 없다.
그래서 약한 참조는 안전망이 아니라 미봉책이고, `remove()`만이 확실한 해제다.
(`31-reference-types-weakhashmap.md`의 약한 참조 개념과 연결)

### "static final로 선언한 ThreadLocal도 누수가 되나요?"

static final이면 ThreadLocal 객체 자체는 앱이 사는 동안 살아 있으므로 key가
GC될 일은 없다 — 즉 stale entry 문제는 없다. 하지만 **value가 스레드에 남는
문제는 그대로**다: remove하지 않으면 워커 스레드 수만큼 value가 상주하고,
재배포 환경에서는 이전 앱의 클래스로더를 붙잡는다. 선언 방식과 무관하게
"쓰고 나면 remove"가 원칙이다.

### "@Async나 CompletableFuture로 작업을 넘기면 ThreadLocal 값은 어떻게 되나요?"

안 넘어간다. 실행 스레드가 다르기 때문이다. 해결은 제출 시점 복사 —
작업을 감싸는 데코레이터에서 호출 스레드의 값(MDC 맵, SecurityContext 등)을
캡처했다가 실행 스레드에서 set하고 finally에서 remove한다. Spring이라면
Executor에 `TaskDecorator`를 끼우는 방식이 표준적이다. 이 정리(finally
remove)를 빼먹으면 **비동기 풀에서 위험 ①·②가 그대로 재발**한다는 것까지
말하면 가산점 포인트.

### "InheritableThreadLocal을 쓰면 해결되지 않나요?"

안 된다. InheritableThreadLocal은 **자식 스레드를 생성하는 시점에** 부모 값을
복사한다. 스레드풀은 스레드를 애초에 한 번만 만들어놓고 재사용하므로, 풀
스레드가 물려받는 것은 "풀을 만든 시점"의 값이지 "작업을 제출한 요청"의 값이
아니다. 요청마다 다른 문맥을 기대하면 엉뚱한(만들던 시점의) 값이 보이는 더
찾기 어려운 버그가 된다. 풀 환경에서는 제출 시점 복사(데코레이터)가 답이다.

### "Virtual Thread 환경에서는 ThreadLocal을 어떻게 봐야 하나요?" (시니어 변별 포인트)

가상 스레드도 ThreadLocal을 지원하지만 전제가 뒤집힌다. ① 가상 스레드는
풀링하지 않고 **작업마다 새로 만들어 버리는** 모델이라 재사용 오염 위험은
사라지는 대신, ② 스레드가 수십만 개로 늘어나므로 "스레드당 하나씩"이라는
비용 절약 전제(예: SimpleDateFormat 재사용)가 무너지고 스레드 수만큼의
value가 메모리 부담이 된다. 그래서 "값을 계속 바꿔 끼우는 가변 저장소"
용법 대신, 정해진 실행 범위 동안 불변 값을 공유하는 ScopedValue 같은
대안이 나왔다. 요지는 **ThreadLocal의 손익은 스레드의 수명 모델에
종속된다**는 것 — 풀(재사용)에서는 오염을, 가상 스레드(대량 생성)에서는
개수 비용을 걱정해야 한다.

---

## 한 줄 요약

ThreadLocal은 요청 문맥(인증·트랜잭션·traceId)을 파라미터 없이 스레드에 실어
나르는 도구지만, 톰캣은 스레드를 재사용하므로 요청 경계의 finally에서
`remove()`하지 않으면 다른 사용자에게 이전 요청의 데이터가 보이는 보안 사고와
GC되지 않는 메모리 누수로 직결된다 — 프레임워크가 해주는 정리를 직접 만든
ThreadLocal에는 우리가 해줘야 한다.
