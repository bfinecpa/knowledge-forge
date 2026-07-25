# JVM 힙 덤프 & 스레드 덤프 — 내용물, 형식, 운영 환경에서의 확보 전략

> 핵심 관전 포인트: **두 덤프는 "무엇을 찍는가"와 "비용"이 완전히 다르다.
> 힙 덤프는 객체 그래프 전체를 찍는 바이너리(HPROF)라 힙 크기에 비례하는 STW를
> 유발하고, 스레드 덤프는 스택만 찍는 텍스트라 밀리초면 끝난다.
> 그래서 운영 전략도 갈린다 — 힙 덤프는 "어떻게 안 뜨고 버티거나, 뜨더라도
> 트래픽을 뺀 뒤 뜰 것인가"의 문제고, 스레드 덤프는 "여러 장을 어떻게 제대로
> 떠서 어떻게 오독하지 않을 것인가"의 문제다.**

---

## 0. 질문 + 의도

**질문**: "OutOfMemoryError가 발생했습니다. 힙 덤프 분석부터 원인 규명까지의
과정을 구체적으로 설명해주세요."
"스레드 덤프에서 데드락을 어떻게 찾나요? 데드락의 4가지 조건과 실무적 예방
방법은?"

**출제 의도**: 실제 해본 사람과 아닌 사람의 답이 극명하게 갈리는 질문이다.
도구 이름(MAT, dominator tree)이 아니라 "덤프를 뜨면 서비스가 멈추는데
운영 중에 어떻게 뜰 건가" 같은 현실 제약을 언급하는지로 경험의 진위를
가린다. 두 덤프의 비용 차이를 알아야 장애 순간 어떤 덤프를 먼저 뜰지
판단할 수 있다.

## 1. 힙 덤프 — 무엇이 어떤 형태로 들어가는가

### 1-1. HPROF 바이너리 포맷

덤프 시점에 힙에 살아있던 **모든 객체의 필드 값, 클래스 메타데이터, GC 루트,
스레드 스택**이 통째로 들어간다. 텍스트가 아니라 도구(MAT, VisualVM)로 여는 것이
전제. 파일 크기 ≈ 힙 사용량.

실제 파일 첫 부분(hexdump):

```
00000000: 4a41 5641 2050 524f 4649 4c45 2031 2e30  JAVA PROFILE 1.0
00000010: 2e32 0000 0000 0800 0001 9f5f a859 ef01  .2........._.Y..
```

| 위치 | 내용 |
|---|---|
| `JAVA PROFILE 1.0.2\0` | 매직 헤더 (포맷 버전) |
| `00 00 00 08` | 식별자(포인터) 크기 = 8바이트 (64비트 JVM) |
| 8바이트 | 덤프 시각 (epoch millis) |
| 이후 | 레코드 반복: `[태그 1B][시각차 4B][길이 4B][본문]` |

### 1-2. 레코드 종류

- **`0x01` UTF8** — 모든 심볼 문자열(클래스명·필드명·메서드명). 이후 레코드가 ID로 참조
- **`0x02` LOAD_CLASS** — 로드된 클래스 목록 (클래스 ID ↔ 이름)
- **`0x04`/`0x05` STACK_FRAME / STACK_TRACE** — 덤프 시점 스레드 스택
- **`0x0C`/`0x1C` HEAP_DUMP (SEGMENT)** — 파일의 95% 이상을 차지하는 본체. 서브 레코드:
  - **GC ROOT** — JNI 전역 참조, 스레드 로컬, static 필드, 모니터 락 등 "왜 살아있는가"의 시작점
  - **CLASS_DUMP** — static 필드 값 + 인스턴스 필드 레이아웃
  - **INSTANCE_DUMP** — 객체마다 `[객체 ID][클래스 ID][필드 raw 바이트]`. 참조 필드는 상대 객체의 ID(주소)
  - **OBJECT_ARRAY_DUMP / PRIMITIVE_ARRAY_DUMP** — 배열 내용 전체. `byte[]`/`char[]`가 통째로 들어감

예: `map.put("session-42", new byte[1024])` 하나는
`HashMap$Node` INSTANCE_DUMP(key/value 참조 ID) → `String` INSTANCE_DUMP
→ `byte[]` PRIMITIVE_ARRAY_DUMP("session-42" 실제 바이트)로 연결 저장된다.

### 1-3. 보안 함의

`strings example.hprof`만 돌려도 힙에 있던 String 내용물이 그대로 나온다.
**비밀번호·세션 토큰·개인정보가 힙에 있었다면 덤프에 평문으로 들어간다**
→ 운영 덤프 파일은 민감 자료로 취급 (전송·보관·삭제 정책 필요).

### 1-4. 분석 도구에서 보는 3대 뷰

```
 num     #instances         #bytes  class name
   1:         16191        1214888  [B                  ← byte[] 배열
   3:         15935         382440  java.lang.String
   7:          4261         136352  java.util.HashMap$Node
```

- **Histogram** — 클래스별 인스턴스 수/바이트. "뭐가 많은가"
- **Dominator Tree** — retained heap("이 객체를 없애면 얼마 회수되나") 기준 트리. 릭 용의자 탐색의 핵심
- **Path to GC Roots** — 용의자 → GC 루트 참조 체인. "누가 붙잡고 있어서 못 죽는가"
  예: `static cache → HashMap → Node[] → Node → byte[]`

덤프 명령: `jcmd <pid> GC.heap_dump <경로>` / `jmap -dump:live,format=b,file=... <pid>`
OOM 자동 덤프: `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=...`

---

## 2. 스레드 덤프 — 무엇이 어떤 형태로 들어가는가

### 2-1. 평문 텍스트, 전체 구조

```
2026-07-14 17:22:05
Full thread dump OpenJDK 64-Bit Server VM (21.0.10 mixed mode, sharing):

Threads class SMR info: ...          ← JVM 내부 정보 (분석 시 무시)
"스레드이름" ... 스레드 항목 반복 ...   ← 본체
JNI global refs: ...
Found N Java-level deadlock(s)       ← 데드락 있으면 맨 뒤에 자동 감지 결과
```

### 2-2. 스레드 항목 하나의 해부

```
"worker-blocked" #21 [26115] prio=5 os_prio=31 cpu=0.10ms elapsed=3.89s
    tid=0x...949925a00 nid=26115 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
	at ThreadDemo.lambda$main$1(ThreadDemo.java:10)
	- waiting to lock <0x000000070edf1c50> (a java.lang.Object)
```

- 첫 줄: 이름, `#번호`, **`cpu=` 누적 CPU 시간**(폭주 스레드 탐색 핵심),
  `nid`(OS 네이티브 스레드 ID — `top -H`와 매칭하는 값)
- 둘째 줄: 상태 — `RUNNABLE` / `BLOCKED` / `WAITING` / `TIMED_WAITING`
- 스택 중간의 `- locked <주소>` / `- waiting to lock <주소>`가 락 분석의 열쇠

### 2-3. 락 경합이 보이는 방식 — 주소로 짝 맞추기

같은 락 주소가 두 스레드에 교차로 나타난다:

```
"worker-holding-lock" ... TIMED_WAITING (sleeping)
	- locked <0x000000070edf1c50>          ← 락을 쥔 채 잠들어 있음

"worker-blocked" ... BLOCKED (on object monitor)
	- waiting to lock <0x000000070edf1c50> ← 같은 주소를 기다림
```

`Object.wait()` 대기는 락을 잡았다가 놓고 기다리므로 `locked`와 `waiting on`이
**같은 주소로 함께** 나온다:

```
"consumer-waiting" ... WAITING (on object monitor)
	at java.lang.Object.wait0(Native Method)
	- waiting on <0x000000070edf1c70>
	at ThreadDemo.lambda$main$2(ThreadDemo.java:15)
	- locked <0x000000070edf1c70>
```

### 2-4. 데드락 자동 감지

JVM이 직접 찾아서 덤프 맨 끝에 결론까지 써준다:

```
Found one Java-level deadlock:
=============================
"deadlock-1":
  waiting to lock monitor ... (object 0x...c90), which is held by "deadlock-2"
"deadlock-2":
  waiting to lock monitor ... (object 0x...c80), which is held by "deadlock-1"
...
Found 1 deadlock.
```

### 2-5. 힙 덤프와의 비교

| | 힙 덤프 | 스레드 덤프 |
|---|---|---|
| 형식 | HPROF 바이너리, 수 GB 가능 | 평문 텍스트, 수십 KB |
| 내용 | 객체·필드 값 전부 | 스레드별 스택 + 락 소유 관계 |
| 용도 | 메모리 릭, OOM | 행(hang), 데드락, CPU 폭주, 응답 지연 |
| 비용 | STW 길고 무거움 | 거의 즉시, 운영 중 부담 없음 |

명령: `jcmd <pid> Thread.print` / `jstack <pid>` / `kill -3 <pid>`(stdout 출력)

---

## 3. [면접] 운영에서 힙 덤프를 뜨면 무슨 일이? 수 GB라면? 실제로는 어떻게 확보?

### 3-1. 덤프 순간 일어나는 일

- 일관된 스냅샷이 필요하므로 **모든 스레드를 세이프포인트에 멈춘 STW 상태에서**
  힙 전체를 순회하며 직렬화. GC pause와 달리 **힙 순회 + 디스크 쓰기가 끝날 때까지** 정지
- `jmap -dump:live` / `jcmd GC.heap_dump`(기본)는 살아있는 객체만 담기 위해
  **덤프 전 Full GC를 한 번 유발** → 실제 정지 = Full GC + 순회 + 파일 쓰기의 합

### 3-2. 힙이 수 GB라면 — 연쇄 장애가 진짜 문제

- 정지 시간이 **수십 초~분 단위**로 늘어남 (힙 크기·객체 수·디스크 I/O에 비례)
- 진행 중 요청 전부 타임아웃 → 상류 서비스로 장애 전파
- **헬스체크 실패** → LB가 노드 제외, 최악은 **k8s liveness probe가 덤프 도중
  프로세스를 죽임** (덤프도 못 건지고 장애만 확대)
- 파일 크기 수 GB → 디스크 용량·I/O 대역폭 문제. NFS 등 느린 볼륨이면 정지 더 길어짐

### 3-3. 실제 확보 전략 (우선순위 순)

1. **사전 설정으로 자동 확보 (최선)** —
   `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps`
   OOM 시점엔 어차피 죽는 중이라 STW 비용 무관, 릭이 최대인 순간을 얻음. 운영 기본 옵션
2. **트래픽 뺀 뒤 덤프** — 문제 인스턴스를 LB에서 drain 후 덤프.
   liveness probe 일시 완화, 빠른 로컬 디스크에 쓰기
3. **트래픽 못 빼면 gcore** — `gcore <pid>`는 힙 순회 없이 메모리 복사라 정지가 짧음.
   이후 **오프라인에서** `jmap -dump ... <core파일>`로 hprof 변환.
   정지 비용을 서비스 → 분석 장비로 이전
4. **풀 덤프 회피 대안** —
   `jmap -histo <pid>`(히스토그램만, 정지 짧음. 몇 분 간격 2회 떠서 증가분 비교),
   **JFR OldObjectSample**(오버헤드 <1%로 상시 가동, 할당 스택까지 추적)

> 한 줄 요약: "힙 크기에 비례하는 STW + 헬스체크 연쇄 장애 위험 → ① OOM 자동
> 덤프 사전 설정 ② 뜰 땐 drain 후 ③ 안 되면 gcore/histo/JFR로 대체"

---

## 4. [면접] 운영에서 스레드 덤프를 뜰 때 주의점

### 4-1. 전제

스택만 걷으므로 정지는 보통 **밀리초 단위** → 운영 중 안전이 원칙.
함정은 무게가 아니라 **뜨는 방법과 해석**에 있다.

### 4-2. 뜨는 시점의 주의점

- **`-F` 강제 모드의 함정** — `jstack -F`는 디버거 어태치로 **프로세스를 서스펜드**하는
  무거운 방식 + 상태 부정확. 일반 모드가 안 먹힌다는 것 자체가 "세이프포인트 도달 불가"
  라는 진단 정보. 그때만 `-F`/`kill -3`/gcore로 단계적 전환
- **time-to-safepoint 지연** — JNI 장기 실행, 세이프포인트 폴링 없는 카운티드 루프에
  갇힌 스레드가 있으면 정지가 예상보다 길어질 수 있음
- **`kill -3`는 출력 위치 먼저 확인** — 프로세스를 죽이지 않고 **stdout**에 씀.
  stdout 리다이렉트 위치(catalina.out, 컨테이너 로그)를 모르면 덤프 유실
- **권한·환경** — `jcmd`/`jstack`은 **JVM 프로세스와 같은 uid**여야 어태치 가능
  (root라도 uid 다르면 실패). 컨테이너면 같은 PID 네임스페이스(`kubectl exec`)에서

### 4-3. 확보 전략 — 한 장은 진단이 아니다

- **3~5초 간격 3~5장 연속**. 여러 장에서 같은 스레드가 같은 스택이면 그게 진범
  ("잠깐 대기"와 "갇힘"은 한 장으론 구분 불가)
- **CPU 폭주면 `top -H -p <pid>`를 같은 시점에** 함께.
  top 스레드 ID(10진) → 16진 변환 → 덤프의 `nid=0x...` 매칭이 표준 절차
- 덤프마다 타임스탬프. **락 주소는 GC로 객체 이동 시 바뀔 수 있으므로
  주소 짝 맞추기는 한 덤프 안에서만** 유효

### 4-4. 해석 시의 함정

- **`java.util.concurrent` 락은 `- locked` 줄에 안 나온다.**
  `ReentrantLock` 대기는 BLOCKED가 아니라 `WAITING (parking)` +
  `AbstractQueuedSynchronizer`로 보임. 소유자는 `jstack -l`의
  "Locked ownable synchronizers" 섹션에서 확인.
  모르면 "BLOCKED 없으니 락 문제 아님"으로 오판
- 수백 개 WAITING 자체는 정상(스레드풀 idle).
  **비정상 신호는 상태가 아니라 스택의 위치** —
  예: 커넥션 풀 `getConnection`에서 수십 개 대기 중

> 한 줄 요약: "밀리초급이라 안전하지만 ① `-F` 피하고 정석 도구를 같은 uid로
> ② 반드시 여러 장 + CPU 이슈면 top -H 동시 확보 ③ j.u.c 락은 BLOCKED로
> 안 보인다는 걸 알고 해석"

---

## 5. [면접] shallow size vs retained size — 누수 분석은 왜 retained 정렬인가

### 5-0. 단어 뜻 자체가 정의다

- **shallow** = "얕은"(deep의 반대). 참조를 따라 깊이 들어가지 않고 객체의
  **표면(자기 자신)만** 잰다는 뜻. `shallow copy`(얕은 복사)와 같은 용법
- **retained** = "붙잡아 둔"(retain = 계속 쥐고 놓지 않다). 이 객체가
  **붙잡아 두고 있는 바람에 GC가 회수하지 못하는** 메모리라는 뜻.
  customer retention(고객 유지)의 그 retain

→ shallow size = "얕게 잰 크기(자기 몸집만)",
retained size = "붙잡고 있는 크기(놓아주면 풀려날 총량)"

### 5-1. 정의

- **Shallow size** — 객체 **자신이 직접 차지하는 메모리**.
  객체 헤더(마크 워드 + 클래스 포인터) + 필드 크기.
  참조 필드는 **포인터 크기(4~8B)만** 계산, 가리키는 대상은 미포함
- **Retained size** — **"이 객체가 GC로 수거되면 함께 회수되는 총량"**.
  자기 자신 + **오직 이 객체를 통해서만 도달 가능한**(다른 GC 루트 경로가 없는)
  모든 객체의 shallow size 합. MAT Dominator Tree가 바로 이 지배 관계
  ("A를 지나지 않고는 B에 도달 불가")로 만든 트리
- 미묘함: **다른 곳에서도 참조되는 공유 객체는 retained에 포함 안 됨.**
  캐시 A·B가 같은 객체를 참조하면 어느 쪽 retained에도 안 잡히고
  둘의 공통 지배자(dominator)에 귀속 (이 객체가 죽어도 공유 객체는 살아남으므로)

### 5-2. 예시

```java
static Map<String, byte[]> cache = new HashMap<>();  // 1MB 항목 × 1000개
```

| 객체 | shallow | retained |
|---|---|---|
| `HashMap` 인스턴스 | ~48 B | **~1 GB** |
| `Node[]` 테이블 | 수 KB | ~1 GB |
| `byte[]` 하나 | 1 MB | 1 MB |

릭의 원인인 `HashMap`은 shallow로 보면 48바이트짜리 티끌.

### 5-3. 왜 누수 분석은 retained 기준인가

1. **shallow 정렬은 항상 같은 용의자만 보여준다 — 증상이지 원인이 아니다.**
   어떤 덤프든 shallow 상위권은 `byte[]`, `char[]`, `String`, `Object[]`
   (데이터가 담기는 곳이 결국 배열이라 릭 유무와 무관하게 동일).
   "byte[]가 3GB"는 동어반복일 뿐 **누가 왜 붙잡는지** 말해주지 않음
2. **retained 정렬은 "소유자"를 직접 가리킨다.**
   누수는 구조적으로 "작은 홀더(캐시 맵, 리스너 리스트, ThreadLocal,
   static 컬렉션)가 거대한 그래프를 놓아주지 않는" 형태.
   retained 정렬 시 48B짜리 HashMap이 1GB로 최상단에 떠오름 —
   **shallow는 작고 retained는 거대한 비대칭이 릭의 시그니처**
3. **retained는 조치와 직결되는 숫자.**
   "이 참조를 끊으면 정확히 이만큼 회수"라는 의미 →
   상위 항목에서 Path to GC Roots로 올라가면 곧바로 수정할 코드에 도달

> 한 줄 요약: "shallow는 자기 자신의 크기(참조는 포인터만), retained는 죽으면
> 함께 회수되는 총량(dominator 기준). 릭은 '작은 홀더가 거대한 그래프를 쥔'
> 구조라 shallow 정렬은 증상(byte[])만, retained 정렬이 원인(홀더)을 최상단에
> 띄우고 그 숫자가 곧 회수량이라 조치로 직결된다"
