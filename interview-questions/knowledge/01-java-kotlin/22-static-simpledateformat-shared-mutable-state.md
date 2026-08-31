# static SimpleDateFormat과 공유 가변 상태 — 함정을 "목록"이 아니라 "유형"으로 찾기

> 핵심 관전 포인트: **`SimpleDateFormat`은 내부에 가변 `Calendar` 필드를
> 두고 parse/format 때마다 그 상태를 덮어쓰는 thread-unsafe 클래스다.
> static으로 공유하면 톰캣의 동시 요청 스레드들이 하나의 Calendar를
> 동시에 덮어써서, 예외 없이 남의 날짜가 섞여 나오거나 간헐적
> `NumberFormatException`이 터진다 — 단일 스레드 테스트는 전부 통과하고
> 운영 동시 요청에서만 드러난다. 해법은 불변·thread-safe인
> `DateTimeFormatter`(java.time)로 교체. 그리고 이건 개별 클래스의
> 문제가 아니라 "thread-unsafe 객체 × 공유 스코프"라는 유형의 문제라,
> 가변 static 필드·싱글턴 빈의 상태 필드·공유 컬렉션을 같은 축으로
> 전수 점검해야 한다.**

---

## 0. 질문 + 의도

**질문**: "AI가 생성한 코드에서 `SimpleDateFormat`을 static 필드로
공유하고 있습니다. 무엇이 문제이고, 같은 유형(공유 가변 상태)의 함정을
코드베이스 어디에서 더 찾아보겠습니까?"

**출제 의도**: 스레드 안전하지 않은 객체의 공유는 테스트를 전부 통과하고
동시 요청에서만 값이 섞이는 유형이라, 리뷰어의 머릿속 모델만이 방어선이다.
한 사례를 같은 패턴(가변 static, 싱글턴 빈의 상태 필드)으로 일반화해
찾는지 — 함정을 "목록"이 아니라 "유형"으로 아는지, AI가 생성한 코드를
검증할 수 있는 사람인지를 본다.

## 1. 무엇이 문제인가 — SimpleDateFormat의 내부 가변 상태

```java
// AI가 자주 생성하는 전형적 패턴 (오래된 학습 데이터의 관용구)
public class DateUtils {
    private static final SimpleDateFormat SDF =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    public static String format(Date date) {
        return SDF.format(date);      // 여러 요청 스레드가 동시에 호출
    }
}
```

`static final`이라 언뜻 안전해 보이지만, **`final`은 참조 고정일 뿐 내용물
불변이 아니다**(방어적 복사 문항과 같은 축). SimpleDateFormat은 내부에
`protected Calendar calendar` 필드를 두고, `format()`/`parse()`가 호출될
때마다 **그 하나의 Calendar에 날짜를 써넣고 → 읽는** 2단계로 동작한다.

두 스레드가 동시에 들어오면:

```text
스레드 A: calendar.setTime(2026-01-15)   ← A의 날짜 기록
스레드 B: calendar.setTime(2026-08-31)   ← B가 덮어씀!
스레드 A: calendar에서 필드를 읽어 문자열 조립 → "2026-08-31" (B의 날짜)
```

### 증상이 최악의 형태다

| 증상 | 왜 위험한가 |
|---|---|
| **예외 없이 남의 값이 나옴** | A 요청의 응답에 B의 날짜가 찍힘 — 로그도 정상, 알람도 없음. 데이터가 조용히 오염된다 |
| 간헐적 `NumberFormatException`, `ArrayIndexOutOfBoundsException` | parse 도중 내부 상태가 반쯤 덮어써졌을 때. 재현 불가 판정으로 방치되기 쉽다 |
| **단일 스레드에서는 완벽히 정상** | 단위 테스트·로컬 수동 테스트 전부 통과. 부하가 걸린 운영에서만 드러난다 |

이래서 이 유형은 "테스트로 잡는 버그"가 아니라 **"리뷰어의 머릿속 모델로
잡는 버그"**다. 코드를 보는 순간 "이 객체는 thread-safe인가? 이 참조는
몇 개의 스레드가 공유하는가?" 두 질문이 자동으로 떠올라야 한다.

## 2. 어떻게 고치나

```java
// After ①: java.time으로 교체 — 근본 해법
public class DateUtils {
    private static final DateTimeFormatter FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
            // DateTimeFormatter는 '불변' 객체 — 상태를 덮어쓰지 않고
            // 매 호출이 독립적이라 static 공유가 오히려 권장된다

    public static String format(LocalDateTime dt) {
        return dt.format(FMT);
    }
}
```

- **불변이면 공유가 안전해진다** — static이 문제가 아니라 "가변 + 공유"의
  조합이 문제였음을 보여주는 대비다. java.time 계열(`LocalDateTime`,
  `Instant`, `DateTimeFormatter`)은 전부 불변·thread-safe로 설계됐다.
- 레거시 API(`Date`)를 당장 못 걷어내는 경계에서는 차선책:

```java
// After ②: 매 호출 새로 생성 — 공유 자체를 제거 (호출 빈도 낮으면 충분)
return new SimpleDateFormat("yyyy-MM-dd").format(date);

// After ③: ThreadLocal — 스레드마다 자기 인스턴스 (레거시 핫패스용 차선책)
private static final ThreadLocal<SimpleDateFormat> SDF =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));
```

③은 스레드풀 환경에서 정리(remove) 문제가 따라오고(ThreadLocal 문항과
연결), 가변 상태를 없애는 게 아니라 격리하는 대증요법이다. 신규 코드라면
①이 정답이고 ②③은 마이그레이션 경계에서만 쓴다고 말하는 것이 좋다.

## 3. 같은 유형을 코드베이스에서 찾는 법 — "공유 가변 상태" 점검 축

면접의 진짜 배점은 여기다. SimpleDateFormat 하나를 고치는 게 아니라,
**"thread-unsafe 객체가 다중 스레드 스코프에 놓인 곳"이라는 유형**으로
일반화해서 수색 계획을 말해야 한다. 공유 스코프는 두 가지다:
**static 필드**, 그리고 **싱글턴 스프링 빈의 인스턴스 필드**(빈은 하나,
요청 스레드는 여럿 — 사실상 static과 같은 공유다).

### 수색 1순위: 가변 static 필드 전수 조사

```bash
# static인데 final이 아닌 필드 — 재대입 가능한 전역 상태
grep -rn "static \(?!final\)" --include="*.java"   # IDE 구조 검색이 더 정확
# final이어도 '가변 타입'이면 용의자
grep -rnE "static final (SimpleDateFormat|Calendar|DecimalFormat|NumberFormat|MessageDigest|StringBuilder)" --include="*.java"
```

- `static final Map<...> CACHE = new HashMap<>()` — 동기화 없는 공유
  HashMap은 동시 put에서 값 유실·무한루프(리사이징 경합)까지 가능.
  `ConcurrentHashMap`으로 교체 대상.
- 같은 이유로 thread-unsafe 단골들: `Calendar`,
  `DecimalFormat`/`NumberFormat`(포맷 계열 전반), `MessageDigest`,
  `Matcher`(단, `Pattern`은 불변이라 static 공유가 정석 — §4 꼬리질문).

### 수색 2순위: 싱글턴 빈의 인스턴스 필드

```java
@Service
public class ReportService {
    private List<Row> buffer = new ArrayList<>();   // 요청 간 공유되는 상태!
    private int processedCount;                     // 여러 요청이 동시에 ++

    public Report build(Request req) {
        buffer.clear();                             // 다른 요청의 작업을 지움
        ...
    }
}
```

`@Service`/`@Component`/`@Controller`는 기본 싱글턴이므로 **인스턴스
필드는 전 요청이 공유**한다. 점검 기준: 싱글턴 빈의 필드는 주입받은
협력자(불변 참조)와 설정값만 있어야 하고, **요청 처리 중간 상태가 필드에
있으면 즉시 용의자**다. 중간 상태는 지역 변수나 파라미터로 흐르게 한다.

### 수색 3순위: 도구로 상시 방어선 구축 (가산점 포인트)

- **SpotBugs**의 `STCAL`(static Calendar/DateFormat) 룰이 정확히 이
  패턴을 잡는다. SonarQube·Error Prone에도 대응 룰이 있다 — 사람 눈이
  아니라 CI가 잡게 만들어 재발을 막는다고 말하면 가산점.
- AI 생성 코드가 늘수록 이 방어선의 가치가 커진다: AI는 학습 데이터에
  많던 **오래된 관용구(static SimpleDateFormat이 대표)**를 자신 있게
  재생산하고, 컴파일되고 테스트도 통과하므로 정적 분석 + 리뷰어 모델
  없이는 걸러지지 않는다.

### 리뷰어의 2축 질문으로 요약

1. **이 객체는 thread-safe인가?** (Javadoc의 thread-safety 명시 확인 —
   불변이면 통과, 가변이면 다음 질문으로)
2. **이 참조는 몇 개의 스레드가 공유하는가?** (static / 싱글턴 빈 필드 /
   스레드 간 전달 — 지역 변수면 통과)

두 답이 "가변 + 공유"로 만나는 지점이 전부 이 유형의 함정이다.

## 4. 꼬리질문 대비 포인트

### "왜 테스트에서는 안 잡히나요? 잡으려면 어떻게 해야 하나요?"

단위 테스트는 단일 스레드로 돌기 때문이다. 경쟁 상태는 스레드 교차
타이밍이 맞아야만 드러나는데, 그 타이밍은 부하가 있어야 자주 발생한다.
잡는 방법은 순서대로: ① 정적 분석(SpotBugs STCAL 등)으로 패턴 자체를
차단 — 가장 싸고 확실, ② 동시성 유닛 테스트(여러 스레드로 같은 포맷터를
두들겨 결과 검증 — 이 클래스는 수십 스레드 × 수천 회면 거의 확실히
재현된다), ③ 부하 테스트 단계에서 응답 데이터 정합성까지 검증. "재현이
어려우니 운영 로그로 발견"은 이미 데이터가 오염된 뒤라는 점을 짚으면 좋다.

### "ThreadLocal로 감싸면 되는데 왜 굳이 DateTimeFormatter로 바꾸나요?" (시니어 변별 포인트)

ThreadLocal은 "가변 상태를 스레드별로 격리"하는 대증요법이고,
DateTimeFormatter는 "가변 상태 자체를 제거"하는 근본 해법이다.
ThreadLocal의 비용: 스레드풀 환경에서 remove를 안 하면 스레드 수만큼의
인스턴스가 스레드 수명 내내 잔류하고(누수·오염 위험은 ThreadLocal 문항
참고), 가상 스레드(Virtual Thread)처럼 스레드가 수십만 개로 늘어나는
모델에서는 스레드당 인스턴스 전략 자체가 낭비가 된다. 무엇보다 다음
수정자가 ThreadLocal을 걷어내고 그냥 공유하도록 "리팩토링"하는 순간
버그가 부활한다 — 불변으로 만들면 그런 퇴행이 원천적으로 불가능하다.
"동기화(synchronized)로 감싸는 건요?"까지 이어지면: 정확성은 얻지만
모든 포맷 호출이 한 줄로 직렬화되어 다중 스레드의 의미가 없어진다고
답한다.

### "`Pattern.compile()`을 static으로 두는 것도 위험한가요?"

아니다 — 그리고 이 대비가 이 질문의 이해도를 보여준다. `Pattern`은
컴파일된 정규식을 담은 **불변 객체**라 static 공유가 오히려 권장된다
(매번 compile하면 그게 성능 문제). 위험한 건 `pattern.matcher(input)`이
돌려주는 **`Matcher`** 쪽 — 매칭 진행 상태를 가진 가변 객체라 공유하면
안 되고, 호출마다 새로 만들어 지역 변수로 쓴다. 즉 "static이 나쁘다"가
아니라 **"불변은 공유해도 되고, 가변은 공유하면 안 된다"**가 규칙이다.

### "스프링 싱글턴 빈은 하나인데 왜 대부분 문제가 없나요?"

빈이 상태를 안 갖기 때문이다(stateless). 통상의 서비스 빈 필드는
주입받은 다른 빈 참조(생성 후 불변)와 설정값뿐이라, 여러 스레드가 같은
인스턴스의 메서드를 동시에 실행해도 각자의 스택(지역 변수·파라미터)에서만
작업하므로 안전하다. 즉 싱글턴이 안전한 게 아니라 **무상태라서 안전한
것** — 필드에 요청 처리 상태를 넣는 순간 static SimpleDateFormat과
정확히 같은 유형의 함정이 된다. 상태가 꼭 필요하면 요청 스코프 빈,
메서드 지역 변수, 또는 동시성 안전 구조(ConcurrentHashMap, AtomicLong)로
옮긴다.

### "AI 생성 코드에서 이런 유형을 리뷰할 때의 체크 순서를 말해주세요"

① 새로 등장한 static 필드와 빈 필드부터 본다(공유 스코프 먼저), ② 그
타입이 가변인지 Javadoc/설계로 확인한다(thread-safety 명시가 없으면
가변으로 간주), ③ 가변+공유가 확인되면 불변 대체재(java.time, 불변
컬렉션) → 공유 제거(지역 변수화) → 격리(ThreadLocal) → 동기화 순으로
해법을 고른다, ④ 같은 패턴이 반복되지 않게 정적 분석 룰을 CI에 추가한다.
개별 지적이 아니라 이 순서(스코프 → 가변성 → 해법 서열 → 재발 방지)를
말하는 것이 "유형으로 아는" 답변이다.

---

## 한 줄 요약

`static final SimpleDateFormat`이 위험한 이유는 static이 아니라 "가변
객체를 여러 스레드가 공유"하기 때문이며 — 같은 축(공유 스코프 × 가변성)
으로 가변 static 필드와 싱글턴 빈의 상태 필드를 전수 점검하고, 해법은
격리(ThreadLocal)보다 불변(DateTimeFormatter)으로 문제 자체를 없애는
쪽을 우선한다.
