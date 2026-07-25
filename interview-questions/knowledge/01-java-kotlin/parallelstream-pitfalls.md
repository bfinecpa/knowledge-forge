# parallelStream()을 웹 애플리케이션에서 함부로 쓰면 안 되는 이유

> 핵심 관전 포인트: **parallelStream()의 문제는 "병렬이라서"가 아니라
> "JVM 전체가 공유하는 단 하나의 common ForkJoinPool 위에서 돈다"는 데 있다.
> 웹 앱은 이미 요청 단위로 병렬(스레드 풀)인데, 그 위에 전역 공유 풀을 얹으면
> 요청 간 간섭·블로킹 I/O에 의한 풀 고갈·컨텍스트 유실이 생긴다.
> 병렬화의 이득은 "CPU-bound + 충분히 큰 데이터"라는 좁은 조건에서만 나온다.**

---

## 0. 질문 + 의도

**질문**: "Stream의 `parallelStream()`을 실무에서 함부로 쓰면 안 되는
이유는?"

**출제 의도**: 공용 ForkJoinPool을 웹 요청 처리에서 나눠 쓰면 한 기능의
부하가 전체 서비스를 굶긴다. "편해 보이는 API의 숨은 공유 자원"을 의식하는
습관이 있는지 본다.

## 선행 개념: parallelStream()은 어디서 실행되나

```java
list.parallelStream().map(this::process).toList();
```

- 스트림을 spliterator로 분할해 **ForkJoinPool.commonPool()** 에서 병렬 실행
- common pool의 크기 = **`CPU 코어 수 - 1`** (기본값).
  예: 8코어 → 워커 스레드 7개
- 이 풀은 **JVM 전체에 딱 하나** — 모든 parallelStream, `CompletableFuture`의
  기본 async 메서드(`supplyAsync` 등 executor 미지정 시)가 **같은 풀을 공유**
- 호출한 스레드(예: 톰캣 워커)도 태스크 처리에 참여한다

**비유: JVM 안에 "워커 7명짜리 공용 작업반"이 딱 하나 있다.**
요청 A가 부르든, 요청 B가 부르든, 어떤 라이브러리 내부 코드가 부르든
전부 이 7명한테 일을 시킨다. 이 "전역 공유 + 코어 수만큼의 작은 크기"라는
설계가 아래 모든 문제의 근원이다.

---

## 1. 문제 1 — 전역 공유 풀: 요청 간 간섭

웹 애플리케이션은 이미 요청 단위로 병렬이다 (톰캣 기본 워커 200개).
요청 200개가 **각자 독립적으로** 처리되어, 요청 A가 느려도 요청 B는 영향이
없다 — 이것이 웹 서버의 기본 격리 모델인데, parallelStream이 이걸 깬다:

```
10:00:00.000  요청 A: 10만 건 데이터를 parallelStream으로 가공 시작
              → 작업반 7명 전원이 A의 일감을 잡음

10:00:00.050  요청 B: 고작 50건짜리 parallelStream 호출
              → 작업반 전원이 A 일을 하는 중 → B의 일감은 큐에서 대기
              → B는 아무 잘못 없이 A가 끝날 때까지 기다림
```

- 한 요청의 무거운 작업이 **다른 모든 요청의 병렬 작업을 지연**시킨다
- 요청 B의 응답 시간이 B 자신의 코드가 아니라 **"그 순간 다른 요청이 뭘 하고
  있었는가"에 의해 결정**된다 → 어제는 10ms, 오늘은 800ms. 지연이 복불복이
  되고, 혼자 테스트할 땐(부하 없을 땐) 절대 재현이 안 된다
- 라이브러리 내부에서 몰래 쓰는 parallelStream까지 같은 풀을 두드린다

### 이미 병렬인 곳에서의 추가 병렬화는 이득이 없다

- 200개 요청이 동시에 도는 서버에서 CPU 코어는 이미 포화 상태
- 거기에 요청마다 7개 스레드로 쪼개봐야 **총 처리량은 늘지 않고**
  분할·병합·컨텍스트 스위칭 오버헤드만 추가된다
- 병렬화가 유효한 건 "한가한 CPU를 놀리고 있을 때"인데, 웹 서버의 피크
  타임은 정확히 그 반대 상황이다

---

## 2. 문제 2 — 블로킹 I/O를 태우면 풀 전체가 고갈된다

가장 흔하고 가장 치명적인 오용:

```java
// 안티패턴: 병렬로 외부 API 호출
orders.parallelStream()
      .map(order -> restClient.call(order))   // 블로킹 I/O!
      .toList();
```

- common pool은 **CPU-bound(계산 노동) 작업 전제**로 코어 수만큼만 뽑은
  인원이다. 워커가 API 응답을 기다리는 동안은 일을 하는 게 아니라
  **잠들어 있는** 것 — 주문이 7건 이상이면:

```
워커 1~7: 전원 외부 API 응답 대기 (잠듦)
→ 작업반에 깨어 있는 사람 0명
→ 이 순간 JVM 안의 "모든" parallelStream이 멈춤
→ executor 안 넘긴 CompletableFuture.supplyAsync()도 같은 작업반이라 같이 멈춤
```

- 무서운 건 **장애의 전파 범위**: 외부 API가 느려진 건 "주문 조회" 기능
  하나인데, 공용 작업반이 통째로 잠들었으니 아무 상관 없는 다른 기능들까지
  다 같이 멈춘다. **격리가 없어서 국소 장애가 전역 장애가 된다**
  (전용 ExecutorService면 "그 기능 전용 작업반"만 잠들어 피해가 기능 안에
  갇힌다 — 격리가 해법인 이유)
- ForkJoinPool의 work-stealing은 "짧은 CPU 작업을 잘게 쪼개 훔쳐가는"
  구조라 블로킹과 궁합이 최악 (`ManagedBlocker`로 보상 스레드를 만들 수는
  있지만 parallelStream에서 쓸 일은 사실상 없다)

---

## 3. 문제 3 — 스레드가 바뀌며 컨텍스트가 유실된다

**비유: 일을 대신 하는 사람은 내 주머니 속을 모른다.**
Java에는 "스레드마다 붙어 있는 개인 주머니"(ThreadLocal 계열)가 많은데,
요청 처리 중에는 전부 **톰캣 워커 스레드의 주머니**에 들어 있다.
parallelStream 안의 람다는 톰캣 워커가 아니라 **작업반(common pool) 스레드**가
실행하고, 그 스레드의 주머니는 비어 있다:

```java
@Transactional
public void process(List<Item> items) {
    // 여기는 톰캣 워커 스레드: 트랜잭션 있음, 인증정보 있음, traceId 있음

    items.parallelStream().forEach(item -> {
        // 여기는 common pool 워커 스레드:
        SecurityContextHolder.getContext().getAuthentication(); // → null!
        log.info("...");        // → traceId 빠진 로그 (추적 단절)
        repository.save(item);  // → 트랜잭션 "밖"에서 실행!
    });
}
```

| 유실되는 것 | 증상 |
|---|---|
| `ThreadLocal` | 요청 스레드에 담아둔 값이 워커에서 null |
| `SecurityContextHolder` (Spring Security) | 워커에서 인증 정보 없음 → 인가 실패 |
| MDC (로깅) | traceId가 빠진 로그 → 분산 추적 단절 |
| 트랜잭션 컨텍스트 | `@Transactional`은 스레드 바인딩 → 워커의 DB 접근은 **트랜잭션 밖** + 커넥션 풀을 워커 수만큼 추가 점유 |

- 특히 트랜잭션 유실이 제일 위험하다 — 예외가 터지는 게 아니라 각자
  **auto-commit으로 조용히 실행**되고, 나중에 트랜잭션이 롤백해도 이미
  커밋된 건 안 돌아온다. LazyInitializationException이 간헐적으로 터지는
  형태로도 나타난다 — "조용히 틀리는" 부류라 발견도 늦다
- common pool 워커는 데몬 스레드라 클래스로더 등 컨테이너 환경에서
  추가로 미묘한 문제를 일으킬 수 있다

---

## 4. 문제 4 — 애초에 병렬화 이득이 나는 조건이 좁다

병렬화 비용(분할 + 태스크 스케줄링 + 결과 병합)을 상회하는 이득이 나려면:

| 조건 | 이유 |
|---|---|
| **원소당 작업이 CPU-bound** | I/O면 §2의 풀 고갈 |
| **데이터가 충분히 큼** (경험칙: 원소수 × 원소당 연산비용이 ~10만 단위 이상) | 작으면 분할 오버헤드가 이득을 잠식 |
| **분할이 싼 자료구조** | ArrayList/배열 O(1) 분할 ✅, LinkedList·Iterator 기반 ❌ |
| **원소 간 독립 + 무상태 연산** | 공유 상태 변경 시 레이스 (아래) |
| **병합이 싼 연산** | `findAny`/`reduce` ✅, 순서 유지 `forEachOrdered`·`limit` ❌ |

웹 요청 처리에서 다루는 데이터(수십~수백 건 DTO 변환)는 대부분
이 조건에 **하나도 해당하지 않는다** — 순차 스트림이 오히려 빠른 경우가 흔하다.

### 덤: 정확성 함정

```java
List<String> result = new ArrayList<>();          // 스레드 안전 X
items.parallelStream().forEach(i -> result.add(i)); // 레이스! 유실/예외
```

- 순차에서는 우연히 돌던 side-effect 코드가 병렬에서 터진다
  → `collect(toList())` 같은 collector로 병합해야 안전
- `stream().parallel()` 은 순차/병렬을 **파이프라인 전체 단위**로 전환하므로
  중간에 섞을 수도 없다

---

## 5. 그러면 어떻게 해야 하나

| 상황 | 올바른 선택 |
|---|---|
| 수십~수백 건 DTO 변환 등 일반 웹 로직 | **그냥 순차 stream()** — 대부분 이걸로 충분 |
| 병렬 외부 API 호출 (I/O-bound) | **전용 ExecutorService** + `CompletableFuture.supplyAsync(task, executor)` — executor를 명시해 common pool 격리, 크기·타임아웃·모니터링 독립 관리 |
| 진짜 CPU-bound 대량 연산 (배치, 이미지, 암호화 등) | 전용 풀에서 실행하거나, 요청 경로 밖(배치/비동기 잡)으로 분리. parallelStream을 쓰더라도 **웹 요청 스레드에서 직접 호출하지 않기** |
| Java 21+ 대량 동시 I/O | **가상 스레드** — 블로킹 I/O를 싸게 만드는 정공법. 단 CPU-bound에는 이득 없음 |

- 커스텀 ForkJoinPool 안에서 `pool.submit(() -> list.parallelStream()...)` 로
  풀을 격리하는 우회도 있지만, **공식 보장이 아닌 구현 디테일에 기댄
  트릭**이라 권장하지 않는다 (내부 splitting 일부가 여전히 common pool을
  탈 수 있고, 코드 의도도 불명확)
- `-Djava.util.concurrent.ForkJoinPool.common.parallelism=N` 으로 common pool
  크기를 키우는 것도 전역 설정이라 근본 해결이 아니다

---

## 6. 한 문장 결론 (모범답안 요약)

> parallelStream()은 JVM에 하나뿐인 common ForkJoinPool(코어 수-1)에서 돌기
> 때문에, 이미 요청 단위로 병렬인 웹 앱에서는 ① 요청 간 간섭으로 지연이
> 예측 불가능해지고, ② 블로킹 I/O를 태우면 전역 풀이 고갈되어 장애가 서비스
> 전체로 전파되며, ③ 스레드가 바뀌면서 ThreadLocal·SecurityContext·MDC·
> 트랜잭션이 유실되고, ④ 애초에 웹에서 다루는 작은 데이터는 분할·병합
> 오버헤드 때문에 이득도 없다. 병렬 I/O는 전용 ExecutorService(또는 가상
> 스레드), CPU-bound 대량 연산은 요청 경로 밖으로 분리하는 게 정석이다.

직관 버전 (작업반 비유):

> JVM에 하나뿐인 공용 작업반이라 ① 남의 요청과 자리 다툼을 하고(간섭),
> ② 누가 I/O 대기 작업을 태우면 반 전체가 잠들어 전체 서비스가 멈추며(고갈),
> ③ 내 스레드가 아닌 남의 스레드가 일을 대신 하니 스레드 주머니에 든 것들
> (인증·traceId·트랜잭션)이 딸려가지 않는다(유실).

---

## 부록: 자주 헷갈리는 포인트 Q&A

**Q1. common pool의 크기는 얼마인가?**
→ 기본값 `Runtime.availableProcessors() - 1`. 8코어면 워커 7개.
CPU-bound 전제의 크기라서 블로킹 작업이 들어오면 바로 고갈된다. (선행 개념 절, §2)

**Q2. parallelStream이 느려질 수 있는 이유는?**
→ 분할(spliterator)·스케줄링·병합 오버헤드가 원소당 작업 비용을 상회하면
순차보다 느리다. 데이터가 작거나, LinkedList처럼 분할이 비싼 소스이거나,
순서 유지 연산(limit, forEachOrdered)이 있으면 특히 그렇다. (§4)

**Q3. CompletableFuture는 안전한가?**
→ executor를 지정하지 않으면(`supplyAsync(task)`) **같은 common pool**을
쓰므로 동일한 문제가 있다. 반드시 전용 executor를 두 번째 인자로 넘겨라. (§2, §5)

**Q4. @Transactional 메서드 안에서 parallelStream으로 DB에 접근하면?**
→ 트랜잭션은 스레드에 바인딩되므로 워커 스레드의 DB 접근은 트랜잭션 밖이다.
예외 없이 조용히 틀리거나(auto-commit), LazyInitializationException이
간헐적으로 터지고, 커넥션도 워커 수만큼 추가 점유한다. (§3)

**Q5. 커스텀 ForkJoinPool로 감싸면 되지 않나?**
→ `pool.submit(() -> stream.parallel()...)` 트릭이 있지만 공식 스펙이 아닌
구현 디테일 의존이라 권장하지 않는다. 의도가 "격리된 풀에서 병렬 실행"이면
ExecutorService + CompletableFuture로 명시하는 게 맞다. (§5)

**Q6. 그럼 parallelStream은 언제 써도 되나?**
→ CPU-bound + 대량 데이터 + 분할 싼 소스(배열/ArrayList) + 무상태 연산 +
웹 요청 경로 밖(배치, CLI, 초기화 등 common pool을 독점해도 되는 환경).
이 조건이 다 맞는 곳에서는 코드 한 줄로 코어를 다 쓰는 훌륭한 도구다. (§4, §5)

**Q7. 가상 스레드(Java 21)가 나왔으니 parallelStream으로 I/O 해도 되지 않나?**
→ 아니다. parallelStream은 여전히 플랫폼 스레드 기반 common pool에서 돈다.
가상 스레드의 이득은 `Executors.newVirtualThreadPerTaskExecutor()` 등으로
태스크를 직접 제출할 때 얻는 것이지, parallelStream과는 무관하다. (§5)
