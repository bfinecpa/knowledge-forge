# G1GC vs ZGC — 동작 원리와 특징 비교

> 핵심 관전 포인트: **모든 GC는 결국 같은 일(Mark / Sweep / Compact)을 한다.
> 차이는 단 하나 — "어떤 단계를 STW로 하고, 어떤 단계를 앱과 동시에(concurrent) 하느냐"이며,
> 이 배치의 차이가 G1과 ZGC의 모든 특징을 만든다.**

---

## 0. 질문 + 의도

**질문**: "G1 GC와 ZGC의 차이를 설명해주세요. 지연시간(latency)에 민감한
서비스라면 무엇을 선택하겠습니까?"

**출제 의도**: GC 선택은 서비스 특성(처리량형 배치 vs p99 민감 API)에 따른
의사결정이고, 잘못 고르면 하드웨어를 늘려도 해결이 안 된다. "선택의 근거를
말할 수 있는가"로 인프라 결정에 참여할 수 있는 연차인지 가늠한다.

## 선행 개념: 포인터(참조)란

```java
User user = new User("철수");
```

- `new User("철수")` → 힙 어딘가(예: `0x7f3a00`)에 실제 객체 데이터가 저장됨
- 변수 `user`는 객체 자체가 아니라 **"객체가 있는 주소값(`0x7f3a00`)"** 을 담음 → 이것이 포인터(참조)

```
  변수 user            힙(heap)
 ┌──────────┐        ┌──────────────────┐
 │0x7f3a00  │ ─────▶ │ User 객체         │  ← 0x7f3a00 번지
 └──────────┘        │  name = "철수"    │
   (포인터)          └──────────────────┘
```

- C/C++에서는 포인터, Java에서는 참조(reference)라 부르지만 **JVM 내부에 저장되는 것은 결국 객체의 주소**로 본질은 같다.
- **GC 난이도의 근원**: GC가 조각모음으로 객체를 옮기면(`0x7f3a00` → `0x9c1200`),
  그 객체를 가리키던 **모든 포인터가 옛 주소를 담은 쓰레기 참조가 된다** → 전부 갱신해야 한다.

---

## 1. 일반적인 GC의 전체 과정 (기본형: Mark-Sweep-Compact)

GC의 고전적 3대 작업:

| 작업 | 하는 일 |
|---|---|
| **Mark** | root(스택/레지스터/전역변수)에서 출발, 참조 그래프를 순회하며 도달 가능한 객체를 "살아있음" 표시 |
| **Sweep** | 표시 안 된(죽은) 객체의 메모리를 **제자리에서** 회수 → free list 등록 |
| **Compact** | 살아남은 객체를 한쪽으로 밀어 단편화 제거 + 포인터 전부 수정 |

기본형(Serial/Parallel Full GC)의 동작:

```
[앱 실행 중...] ── 힙 부족! ──▶ ⛔ 전체 STW
                                  ① Mark → ② Sweep → ③ Compact
                                ⛔ STW 끝 ──▶ [앱 재개]
```

**문제**: ①②③ 전부 STW 안에서 수행 → **pause 시간이 live 객체 수(∝ 힙 크기)에 정비례.**
힙이 커지면 pause가 수 초~수십 초. 이 문제를 풀려는 역사가 곧 GC의 진화사.

### 세대(Generational) 가설 — 대부분 GC의 공통 최적화

> "대부분의 객체는 생성 직후 금방 죽는다."

- 힙을 **Young**(새 객체, 자주·빠르게 수거) / **Old**(오래 살아남은 객체, 가끔 수거)로 분리
- Young GC는 살아남는 소수만 복사하면 되므로 빠름
- **문제는 항상 Old 영역 수거** → G1과 ZGC는 이 문제에 대한 서로 다른 답

### 방식별 3대 작업 대응

| | Mark | Sweep | Compact |
|---|---|---|---|
| Mark-Sweep (CMS) | ✅ | ✅ | ❌ (안 함 → 단편화가 고질병) |
| Mark-Sweep-Compact (Serial/Parallel Full GC) | ✅ | ✅ | ✅ |
| **Mark-Evacuate (G1, ZGC)** | ✅ | ⤵ 복사에 흡수 | ⤵ 복사에 흡수 |

**복사(evacuation) 방식의 핵심**: region에서 산 객체만 다른 region으로 퍼내면
옛 region은 통째로 반납 → **Sweep과 Compact가 "복사" 하나로 합쳐진다.**
죽은 객체를 개별적으로 건드리지 않는다.

---

## 2. G1GC의 전체 과정

**전략: "힙을 잘게 쪼개서(region), STW로 하되 조금씩 나눠서 하자."**

- 힙을 수천 개의 **동일 크기 region**(1~32MB, 보통 힙/2048)으로 분할
- 각 region은 Eden / Survivor / Old / Humongous 역할을 **동적으로** 부여받음

### 2-1. Young GC (STW, 반복 발생)

```
Eden region들이 가득 참
  ⛔ STW
     - root 스캔 + RSet 스캔 (← "누가 young 객체를 가리키나")
     - 살아있는 객체를 Survivor/Old region으로 복사(evacuation)
     - 그 객체를 가리키던 포인터 전부 수정
  ⛔ STW 끝
```

- **복사와 포인터 수정을 전부 STW 중에** 수행
- pause = young live set에 비례 → pause 목표(`MaxGCPauseMillis`, 기본 200ms)에 맞춰 **young region 개수를 조절**

### 2-2. Concurrent Marking Cycle (Old 점유율이 임계치 초과 시)

```
⛔ Initial Mark (짧은 STW, Young GC에 편승) : root가 가리키는 old 객체 마킹
▶  Concurrent Mark (앱과 동시)              : old 참조 그래프 순회, live 객체 마킹
⛔ Remark (짧은 STW)                        : 마킹 중 놓친 변경분 마무리
⛔ Cleanup (짧은 STW)                       : region별 live 비율 집계, 완전 빈 region 즉시 회수
```

- 산출물: **"각 old region의 live 비율"** 통계
- 마킹 중 앱의 참조 변경은 **write barrier**(참조를 *쓸 때* 기록)로 추적

### 2-3. Mixed GC (STW, 몇 차례 반복) — "Garbage-First"의 유래

```
⛔ STW
   - 쓰레기 비율이 가장 높은(= 복사할 live가 가장 적은 = 가성비 최고) old region부터
   - pause 목표 안에 처리 가능한 만큼만 CSet(Collection Set)에 담고
   - young + 선택된 old region의 live 객체 복사 + 포인터 수정
⛔ STW 끝    ← 이걸 몇 번 반복해 old를 조금씩 청소
```

### 2-4. 실패 시: Full GC (fallback)

수거가 할당 속도를 못 따라가면(evacuation failure, humongous 할당 실패 등)
→ **전체 힙 STW Full GC**로 추락. pause가 힙 크기에 정비례하는 최악 시나리오.

### G1 요약

> Mark는 (대부분) concurrent, 하지만 **Compact(복사+포인터 수정)는 언제나 STW.**
> 대신 STW 분량을 region 단위로 쪼개고, 가성비 좋은 region부터 골라 pause 목표를 맞춘다.

---

## 3. ZGC의 전체 과정

**전략: "쪼개서 나눠 하는 것도 한계가 있다. 아예 Compact까지 앱과 동시에 하자."**

### 3-0. 두 가지 무기

**① Colored Pointer (색칠된 포인터)**
- 64비트 포인터는 주소 표현에 비트를 다 쓰지 않음 → **남는 비트에 "색(상태)"을 기록**
- 색의 종류: **marked0, marked1, remapped** (+ finalizable)
- 색은 **객체의 생사가 아니라 "이 참조가 현 단계 처리를 통과했는가"라는 참조의 처리 상태**를 나타냄

**② Load Barrier (읽기 배리어)**
- 앱 스레드가 힙에서 **참조를 읽을 때마다** 실행되는 작은 검사 코드
- 판단 기준은 단 하나: `포인터의 색 == 지금의 "좋은 색(good color)"?`
  - 예 → 그냥 통과 (비용 거의 0)
  - 아니오 → 느린 경로: 필요한 처리(마킹/주소 교정)를 하고 **포인터를 좋은 색으로 고쳐 씀 (self-healing)**
- GC 단계가 바뀔 때마다 "좋은 색" 지정만 바꾸면 전체 힙 포인터가 재검사 대상이 됨
  → **힙을 순회하며 리셋할 필요가 없다** (STW가 짧은 이유 중 하나)

### 3-1. Mark 단계

```
⛔ Pause Mark Start (STW, <1ms)  : root 스캔만. (좋은 색 = markedX로 flip)
▶  Concurrent Mark (앱과 동시)   : 참조 그래프 순회
     - 객체  → mark bitmap에 "살아있음" 기록   ← 진짜 마킹
     - 포인터 → "이번 주기 처리됨" 색으로 색칠  ← 진행 표식
     - 앱 스레드도 load barrier를 통해 마킹에 참여
⛔ Pause Mark End (STW, <1ms)    : 마킹 종료 동기화
```

**마킹 vs 색칠 구분** (혼동 주의):
- **마킹** = 살아있는 객체를 찾아 **mark bitmap에 기록**하는 것 (모든 GC 공통 개념)
- **포인터 색칠** = "이 참조는 이번에 처리 완료"를 포인터 비트에 태그하는 ZGC 특유의 기법
- 색칠은 마킹의 부수 효과이자 중복 작업 방지 장치이지, 마킹의 정의가 아님

### 3-2. 준비 단계 (Concurrent)

```
▶  Concurrent Prepare : mark bitmap 통계로 "쓰레기 많은 region"을
                        재배치 대상(relocation set)으로 선정 (garbage-first 아이디어 동일!)
```

### 3-3. Relocate 단계 — 혁신의 핵심

```
⛔ Pause Relocate Start (STW, <1ms) : root가 가리키는 객체만 이동/수정. (좋은 색 = remapped로 flip)
▶  Concurrent Relocate (앱과 동시!)
     - GC 스레드가 relocation set의 live 객체를 새 region으로 복사
     - 옛 위치 → 새 위치 대응표(forwarding table) 기록
     - 복사 끝난 옛 region은 즉시 회수·재사용
```

이 동안 앱이 포인터를 읽으면 load barrier가:

| 케이스 | 배리어의 동작 |
|---|---|
| ① 색이 remapped | 이미 검사 완료 → 그냥 통과 |
| ②-a 옛 색 + relocation set에 없음 | 주소 유효 → **색만 remapped로** 변경 |
| ②-b 옛 색 + 이사 대상 + 이미 복사됨 | forwarding table에서 새 주소 조회 → **"새 주소 + remapped"로** 고쳐 씀 |
| ②-c 옛 색 + 이사 대상 + 아직 안 옮겨짐 | **앱 스레드가 직접 그 자리에서 객체를 복사**하고 table 기록 → "새 주소 + remapped" |

②-c 덕분에 앱이 옛 주소의 객체를 만질 가능성이 **원천 차단**된다.

### 3-4. Remap (다음 사이클에 무임승차)

- 아무도 안 읽어 옛 색인 채 남은 포인터들은 **다음 사이클의 concurrent mark가
  그래프를 순회하면서 겸사겸사 전부 새 주소로 갱신** + 새 마킹 색으로 색칠
- 별도 순회 단계를 안 만들어 순회 비용 1회 절약

### 3-5. 색의 변천과 두 개의 mark 색

```
        [주기 N: mark]        [주기 N: relocate]      [주기 N+1: mark]
색:      marked0        →      remapped          →     marked1
의미:   "살아있음 확인"        "주소 최신 보증"          "새 주기 생존 재확인"
```

- **marked 색**: "이 객체는 이번 주기에 살아있음 확인" — 단, 마킹 시점엔 relocation set이
  정해지지 않아 **주소가 최신인지는 보증 못 함**
- **remapped 색**: "이사 검사를 통과한 최신 주소" 보증서
- **mark 색이 2개(marked0/1)인 이유**: remap이 다음 마킹에 얹혀 지연 처리되므로
  힙에 지난 주기 색과 이번 주기 색이 공존 → 색을 주기마다 뒤집기(flip)만 하면
  지난 주기 것들이 자동으로 "낡은 것"이 됨 → **리셋 순회/STW 불필요**

### ZGC 요약

> Mark도 concurrent, **Compact(복사+포인터 수정)까지 concurrent.**
> STW는 root 처리 3곳뿐 — root 개수는 스레드 수에 비례하고 **힙 크기와 무관**.

---

## 4. 비교 — "어느 단계가 STW인가"가 모든 특징을 만든다

### 4-1. 단계별 STW 배치

| 단계 | 기본형 (Parallel) | G1 | ZGC |
|---|---|---|---|
| **Mark** | ⛔ STW | ▶ 대부분 concurrent | ▶ concurrent |
| **수거 대상 선정** | (전체) | ⛔ STW 중 (가성비순) | ▶ concurrent (가성비순) |
| **객체 복사 (Compact)** | ⛔ STW | ⛔ **STW** | ▶ **concurrent** ← 결정적 차이 |
| **포인터 수정** | ⛔ STW | ⛔ **STW** | ▶ concurrent (self-healing) |
| **상시 오버헤드** | 없음 | write barrier (쓸 때) | **load barrier (읽을 때)** + 색 비트 |

### 4-2. 특징이 도출되는 과정

**① G1의 pause는 힙/live set 규모에 영향을 받는다**
- 복사+포인터 수정이 STW이기 때문. pause = 복사할 live 양 + RSet 스캔 비용
- G1의 설계 의도 자체는 "pause 고정 + 빈도 증가"가 맞다 (CSet 크기 조절). 하지만:
  - **Young GC는 CSet을 쪼갤 수 없다** — 모든 young region을 한 번에 STW 수거.
    힙이 크면 young도 크게 잡히는 경향 → 복사량 증가 (줄이면 GC 빈도 급증 → throughput 악화)
  - **RSet 스캔 단가가 힙에 비례** — 힙이 크면 region 간 cross-reference 증가 → RSet 비대
    → CSet 크기를 조절해도 "region당 처리 단가" 자체가 올라감
  - **Full GC fallback** — 최악의 경우 힙 전체 STW

**② ZGC는 힙이 TB급이어도 pause < 1ms**
- STW에서 하는 일이 root 처리뿐. root 수는 스레드 수에 비례, 힙 크기와 무관
- 무거운 일(마킹·복사·포인터 수정)은 전부 concurrent로 밀어냄
- 단, **STW가 아예 없는 것은 아니다** — Mark Start / Mark End / Relocate Start 3곳의
  짧은 STW 존재. "STW-free"가 아니라 "**pause가 힙에 비례하지 않는다**"가 정확한 표현
- 상용 JVM GC 중 STW가 완전히 0인 것은 없음 (Shenandoah도 마찬가지)

**③ ZGC의 대가: throughput 세금**
- 복사를 concurrent로 하려면 "앱이 옛 주소를 읽는 사고"를 막아야 함 → **모든 참조 읽기에 load barrier**
- 읽기는 쓰기보다 압도적으로 빈번 → G1의 write barrier보다 상시 비용이 큼
- STW 비용을 없앤 대신 **비용을 실행 시간 전체에 얇게 펴 바른 것**
- colored pointer 관련 메모리 오버헤드도 존재

**④ G1은 균형형, 범용 기본값 (Java 9+)**
- 상시 배리어 비용이 상대적으로 쌈(write barrier만), STW 복사는 구현이 단순·효율적
- 수십 GB 이하 힙 + 200ms급 pause 허용이면 최적의 절충

**⑤ 둘 다 garbage-first**
- "쓰레기 많은 region부터 수거해 복사량 최소화" 아이디어는 동일
- 다른 것은 그 복사를 **멈추고 하느냐(G1) vs 돌면서 하느냐(ZGC)** 뿐

**⑥ 실패 모드의 차이**
- G1: 못 따라가면 전체 힙 STW **Full GC 낭떠러지**
- ZGC: Full GC 없음. 대신 회수가 할당을 못 따라가면 **할당하려는 스레드만 개별 대기(allocation stall)**
  → 전체가 멈추진 않지만 지연은 발생. 할당률 높은 워크로드가 약점이었고,
  이를 개선한 것이 **Generational ZGC**

---

## 5. Region 설계 비교

**둘 다 region 기반** — 복사 방식의 필연적 귀결:
부분 수거하려면 힙이 "골라낼 수 있는 단위"로 나뉘어야 하고,
region별 live 비율 집계로 garbage-first 선별이 가능해지며,
산 객체를 퍼낸 region은 통째로 반납된다.
G1이 확립한 뼈대를 ZGC가 계승한 것.

| | G1 | ZGC |
|---|---|---|
| 크기 | **전부 동일** (1~32MB 고정, 보통 힙/2048) | **3종 크기 클래스**: Small(2MB) / Medium(32MB) / Large(가변) |
| 큰 객체 | region의 50% 초과 = **humongous** → 연속 region 여러 개를 이어붙임. 연속 공간 확보가 필요해 단편화에 취약 → evacuation failure → Full GC의 단골 원인 | 큰 객체는 **Large region**(객체 1개 = region 1개)에 저장, 복사하지 않고 제자리 수거 → 구조적으로 완화 |
| 역할 | Eden / Survivor / Old / Humongous 동적 부여 | Generational ZGC: **Young / Old 두 가지** 소속 |

---

## 6. 세대(Generation) 설계 비교

### 두 개의 독립적인 축

```
축 1: 힙을 어떻게 나누고 무엇부터 수거하나 → region, young/old, garbage-first  ← 두 GC가 수렴 (검증된 정답)
축 2: 수거 작업(특히 복사)을 언제 하나     → STW vs concurrent                ← 두 GC를 가르는 본질
```

- ZGC는 원래 세대 구분이 **없었고**(단일 세대), 할당률 높은 워크로드에서 회수가 할당을
  못 따라가는 약점 → **JDK 21 Generational ZGC**에서 세대 도입 (세대 가설이 정답이라는 인정)
- 세대 구조가 같아져도 **실행 방식은 그대로 다름**:

| Young 수거 | G1 | Generational ZGC |
|---|---|---|
| 방식 | ⛔ STW 중 복사 | ▶ **young 수거조차 concurrent** |
| pause | young live set에 비례 (수 ms~수십 ms) | root 처리만 STW → 여전히 <1ms |
| 구조 | — | 독립적인 concurrent 수집기 2개(young/old)가 각자 사이클로 도는 구조 |

### Survivor는 어디 갔나

- G1의 Eden/Survivor는 **둘 다 young**이며, 존재 이유는 **나이(age) 추적**:
  성급하게 승격시키면 금방 죽을 객체가 old를 오염 → 몇 번 생존한 놈만 승격
- ZGC의 region 라벨은 young/old 둘뿐이지만 **aging 파이프라인은 그대로 존재**:
  생존자를 복사해 넣는 **대상 young region 자체를 나이 그룹으로 묶음** (region이 곧 나이표)
- Survivor라는 고정 명칭이 불필요해진 이유: G1은 "다음에 어디를 비울지"를 region
  역할로 정적 관리하지만, ZGC는 매 사이클 mark bitmap 통계로 relocation set을
  **동적 선정**하므로 나이 정보만 있으면 충분

---

## 7. 최종 비교표와 선택 기준

| 항목 | G1 GC | ZGC |
|---|---|---|
| 목표 | 예측 가능한 pause (기본 200ms 목표) | pause < 1ms, 힙 크기와 무관 |
| Compact 실행 | STW | concurrent |
| 상시 비용 | write barrier | load barrier + 색 비트 (throughput 세금) |
| 적정 힙 | 수 GB ~ 수십 GB | 수백 GB ~ TB급 |
| 실패 모드 | Full GC (전체 STW) | allocation stall (해당 스레드만 대기) |
| 기본 채택 | Java 9+ 기본 GC | JDK 15 production-ready, JDK 21+ Generational 권장 |
| 활성화 | `-XX:+UseG1GC` | `-XX:+UseZGC` (JDK 21: `-XX:+ZGenerational`, JDK 23+: Generational이 기본) |

**선택 기준**
- **G1**: 일반 웹 애플리케이션, 힙 수십 GB 이하, throughput/지연 균형 (대부분의 기본값으로 충분)
- **ZGC**: 초대형 힙, GC pause로 인한 tail latency를 반드시 억제해야 하는 저지연 서비스
  (실시간 거래, 대규모 캐시 등)

---

## 8. 한 문장 결론

> 고전 GC의 3대 작업은 **Mark–Sweep–Compact**. 기본형은 셋 다 STW로 한다.
> G1과 ZGC는 복사(evacuation) 방식으로 **Sweep+Compact를 "region 단위 복사" 하나로 합쳤고**,
> 남은 문제는 "그 복사를 언제 하나" —
> **G1은 Mark만 concurrent로 빼고 복사는 "STW로 하되 region 단위로 잘게 쪼개는" 절충**,
> **ZGC는 colored pointer + load barrier를 대가로 복사까지 concurrent로 빼낸 극단.**
> 그래서 G1은 "균형과 예측 가능성", ZGC는 "힙 무관 초저지연 + 약간의 throughput 세금"이라는
> 특징이 나온다.

---

## 부록: 자주 헷갈리는 포인트 Q&A

**Q1. G1은 region 크기가 일정하니 pause도 일정하고 횟수만 늘어나는 것 아닌가?**
→ 설계 의도는 맞다(Mixed GC는 실제로 그렇게 동작). 하지만 ① Young GC는 통째로 STW 수거라
young 크기에 비례하고, ② RSet 스캔 단가가 힙에 비례하며, ③ Full GC fallback이 있어
결과적으로 큰 힙에서 pause가 커지는 경향이 나타난다. (§4-2 ①)

**Q2. ZGC는 STW가 아예 없나?**
→ 아니다. Mark Start / Mark End / Relocate Start 3곳의 짧은 STW가 있다.
다만 전부 root 처리 수준이라 힙 크기와 무관하게 <1ms. (§4-2 ②)

**Q3. ZGC의 마킹 = 포인터 색칠인가?**
→ 아니다. 마킹은 live 객체를 mark bitmap에 기록하는 것(모든 GC 공통),
색칠은 "이 참조는 처리 완료"라는 진행 표식(ZGC 특유). 색은 객체의 생사가 아니라
**참조의 처리 상태**를 나타낸다. (§3-1)

**Q4. remapped 색은 언제 쓰이나?**
→ Relocate Start부터 다음 주기까지의 "좋은 색". "이 주소는 이사 검사를 통과한 최신 주소"라는
보증서다. marked 색은 생사만 보증하고 주소 최신성은 보증하지 못하므로 별도 색이 필요하다. (§3-3, §3-5)

**Q5. Generational ZGC의 young/old는 G1과 같은 것 아닌가?**
→ 세대·region 구조(축 1)는 같다 — 검증된 설계로의 수렴. 다른 것은 실행 방식(축 2):
G1은 young 수거를 STW로, ZGC는 young 수거조차 concurrent로 한다. (§6)

**Q6. ZGC엔 Survivor가 없나?**
→ 라벨은 young/old 둘뿐이지만, aging 기능은 "young region을 나이 그룹으로 묶는" 방식으로
흡수되어 그대로 존재한다. (§6)
