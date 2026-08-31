# try-with-resources — finally 수동 정리가 놓치는 자원 누수와 예외 은폐를 언어가 대신 막는다

> 핵심 관전 포인트: **try-with-resources는 `AutoCloseable` 자원의 close를
> 컴파일러가 생성한 코드로 보장하는 문법이다(Java 7+). 해결하는 문제는
> 두 가지 — ① finally 수동 정리에서 사람이 반복적으로 저지르는 실수
> (close 누락, 중첩 자원 중 일부만 닫힘)로 인한 **자원 누수**, ② finally의
> close가 예외를 던지면 try 본문의 원래 예외를 **덮어써 버리는 예외 은폐**.
> try-with-resources는 선언 역순으로 전부 닫아주고, close에서 난 예외는
> suppressed로 원래 예외에 첨부해 둘 다 보존한다. 자원 누수는 평소엔
> 멀쩡하다가 트래픽 몰리는 날 커넥션 풀·파일 디스크립터 고갈로 터지는
> 유형이라, 이 습관이 곧 자원 생명주기를 의식하는 개발자인지의 표본이다.**

---

## 0. 질문 + 의도

**질문**: "try-with-resources는 어떤 문제를 해결하나요? 자원 누수가
발생하는 전형적인 코드 패턴은?"

**출제 의도**: 커넥션·스트림 누수는 평소엔 멀쩡하다가 트래픽이 몰리는 날
풀 고갈로 터진다. finally 수동 정리의 실수 가능성(예외 중첩, 반환 누락)을
언어 기능으로 제거하는 습관 — 자원의 생명주기를 의식하며 코드를 쓰는지의
표본으로 본다.

## 1. 해결하는 문제 — 수동 정리는 왜 계속 실패하는가

"자원(resource)"은 힙 밖의 무언가를 점유하는 객체다: DB 커넥션, 파일
핸들(파일 디스크립터), 소켓, 네이티브 메모리. **GC는 힙 객체만 회수할 뿐
이런 외부 자원은 close를 불러야만 반환된다** — 그래서 close 누락은 GC가
구제해 주지 않는 누수가 된다.

### 자원 누수가 발생하는 전형적 패턴 4가지

**패턴 ① — try 블록 안에서 close (가장 흔한 초급 실수)**

```java
// before: read()에서 예외가 나면 close()에 도달하지 못한다 → 누수
InputStream in = new FileInputStream(path);
process(in.read());
in.close();   // 예외 시 실행 안 됨
```

**패턴 ② — finally는 썼지만, 자원이 여러 개일 때 일부만 닫힘**

```java
// before: conn.close()가 예외를 던지면 stmt/rs는 영영 안 닫힌다.
// 순서를 바꿔도, 셋 중 하나의 close 예외가 나머지를 건너뛰게 만든다
Connection conn = null; PreparedStatement stmt = null; ResultSet rs = null;
try {
    conn = dataSource.getConnection();
    stmt = conn.prepareStatement(sql);
    rs = stmt.executeQuery();
    ...
} finally {
    conn.close();   // 여기서 예외가 나면 ↓ 두 줄은 실행되지 않음
    stmt.close();
    rs.close();
}
// "제대로" 하려면 close마다 null 체크 + 개별 try-catch로 감싸야 한다
// → 정리 코드가 본문보다 길어지고, 이 장식을 누군가는 반드시 빠뜨린다
```

**패턴 ③ — 예외 은폐(masking): finally의 예외가 원래 예외를 덮어씀**

```java
// before: try 본문에서 IOException(진짜 원인)이 났는데
// finally의 close()도 예외를 던지면 — 메서드 밖으로는 close의 예외만 전파된다.
// 로그에는 "close 실패"만 남고 진짜 원인(읽기 실패)은 흔적도 없이 사라진다
try {
    return parse(in);      // ← 여기서 난 예외가
} finally {
    in.close();            // ← 여기 예외에 먹혀버림
}
```

**패턴 ④ — 반환 누락: early return·예외 경로에서 풀 반환을 빼먹음**

```java
// before: 커넥션 풀에서 빌린 커넥션을 조건 분기에서 반환하지 않고 return
Connection conn = dataSource.getConnection();
if (alreadyProcessed(id)) {
    return;               // conn이 풀로 반환되지 않음 — 풀 크기만큼 쌓이면 서비스 정지
}
...
conn.close();
```

이 패턴들의 공통점: **코드 리뷰와 테스트를 다 통과한다.** 자원은 하나씩
새는 것이라 평상시 트래픽에서는 증상이 없고, 트래픽이 몰려 풀/FD 한도에
도달하는 순간 `Connection is not available` 타임아웃이나
`Too many open files`로 한꺼번에 터진다. "잘 짜면 된다"가 아니라 **사람이
반복하는 실수를 언어 기능으로 제거해야 하는 이유**다.

## 2. try-with-resources의 동작 — 무엇을 어떻게 보장하나

```java
// after: 위 패턴 ①②③을 전부 해결하는 형태
try (Connection conn = dataSource.getConnection();
     PreparedStatement stmt = conn.prepareStatement(sql);
     ResultSet rs = stmt.executeQuery()) {
    while (rs.next()) { ... }
}   // 블록 종료 시 rs → stmt → conn 순(선언 역순)으로 전부 close
```

보장하는 것:

1. **close 보장** — 정상 종료든 예외든 return이든, 블록을 벗어나는 모든
   경로에서 close가 호출된다. 대상은 `AutoCloseable` 구현체.
2. **선언 역순으로 전부 닫는다** — 자원이 여러 개일 때 뒤에 선언된 것부터
   닫고, **하나의 close가 예외를 던져도 나머지 close는 계속 실행**된다
   (패턴 ② 해결). 의존 순서(rs는 stmt에, stmt는 conn에 의존)와 역순이
   일치하도록 설계된 규칙이다.
3. **suppressed exception으로 예외를 둘 다 보존** — try 본문의 예외가
   "주 예외"로 전파되고, close에서 난 예외는 주 예외에
   `addSuppressed()`로 첨부된다(패턴 ③ 해결). 스택트레이스에
   `Suppressed:` 항목으로 함께 출력되고, 코드에서는
   `e.getSuppressed()`로 꺼낼 수 있다. finally 수동 정리와 **정확히 반대
   우선순위**(finally는 나중 예외가 이김 vs TWR은 원래 예외가 이김)라는
   점이 핵심 차이다. (가산점 포인트)
4. **자원 생성 실패도 안전** — 두 번째 자원 생성 중 예외가 나면 이미
   생성된 첫 번째 자원은 닫아준다. 수동으로 이걸 하려면 생성 단계마다
   try를 중첩해야 한다.

Java 9부터는 블록 밖에서 만든 변수도 사실상 final(effectively final)이면
`try (conn; stmt)`처럼 이름만 넣을 수 있다.

```java
// 컴파일러가 대신 써 주는 코드의 개념 형태 (자원 1개 기준)
Resource r = acquire();
Throwable primary = null;
try { ... }
catch (Throwable t) { primary = t; throw t; }
finally {
    if (r != null) {
        if (primary != null) {
            try { r.close(); }
            catch (Throwable sup) { primary.addSuppressed(sup); }  // 은폐 대신 첨부
        } else {
            r.close();
        }
    }
}
```

## 3. 실무에서 자주 새는 지점 — "커넥션·스트림만"이 아니다

| 자원 | 새는 방식 | 증상 |
|---|---|---|
| JDBC `Connection` (풀) | close 누락 = 풀에 미반환 | 풀 고갈 → 커넥션 대기 타임아웃, 서비스 전면 지연 |
| `InputStream`/`OutputStream`, 소켓 | 파일 디스크립터 점유 | `Too many open files` — 프로세스 전체가 새 파일/소켓을 못 연다 |
| `Files.lines()`, `Files.list()`, `Files.walk()` | **반환된 Stream이 파일을 연 채로 유지** — Stream도 닫아야 하는 자원인 걸 모르고 방치 | FD 누수. `Stream`이 `AutoCloseable`인 이유가 이것 |
| HTTP 클라이언트 응답 바디 | 바디를 소비/close하지 않으면 커넥션이 커넥션 풀로 반환되지 않음 | HTTP 커넥션 풀 고갈 |

```java
// before: Files.lines가 연 파일이 스트림 처리 후에도 열려 있다
List<String> errors = Files.lines(logPath)
        .filter(l -> l.contains("ERROR"))
        .toList();

// after: 종단 연산이 끝나도 파일은 자동으로 닫히지 않는다 — TWR로 감싼다
try (Stream<String> lines = Files.lines(logPath)) {
    return lines.filter(l -> l.contains("ERROR")).toList();
}
```

### 탐지와 방어선 (가산점 포인트)

- **HikariCP `leakDetectionThreshold`**: 커넥션을 빌린 뒤 설정 시간 안에
  반환하지 않으면 **빌려간 지점의 스택트레이스**를 경고 로그로 남긴다 —
  누수 코드 위치를 바로 찍어주는 실무 1차 방어선.
- OS 레벨: `lsof -p <pid>`로 프로세스의 열린 FD 목록/개수 추이 확인.
- 정적 분석: IDE·SonarQube·Error Prone 모두 "AutoCloseable을 닫지 않음"
  경고 규칙이 있다. 리뷰에서 사람이 잡기 전에 도구가 잡게 한다.

## 4. 꼬리질문 대비 포인트

### "finally에서 close하면 되는데 try-with-resources가 굳이 왜 필요한가요?"

finally도 close 호출 자체는 보장하지만 두 가지를 못 한다. ① 자원이
여러 개일 때 한 close의 예외가 나머지 close를 건너뛰게 만드는 문제 —
제대로 막으려면 close마다 개별 try-catch가 필요해 정리 코드가 본문보다
길어진다. ② 예외 은폐 — finally의 close 예외가 try 본문의 원래 예외를
덮어써서 진짜 원인이 로그에서 사라진다. try-with-resources는 역순 전체
close와 suppressed 첨부로 이 둘을 컴파일러 생성 코드로 해결한다. 즉
"할 수는 있지만 사람이 매번 정확히 하기 어려운 일"을 언어로 내린 것이다.

### "자원을 여러 개 선언하면 close 순서는? 하나가 close 중 예외를 던지면?"

**선언의 역순**으로 닫는다 — 나중에 만든 자원이 먼저 만든 자원에
의존하므로(ResultSet → Statement → Connection) 의존하는 쪽부터 닫는 게
안전하기 때문이다. 하나의 close가 예외를 던져도 **나머지 자원의 close는
계속 실행**되고, 그 예외들은 전파되는 예외에 suppressed로 첨부된다.

### "suppressed exception이 뭔가요? catch한 예외에서 어떻게 확인하나요?"

주 예외가 전파되는 동안 close 등 부수 경로에서 발생해 "삼켜질 뻔한"
예외를 주 예외 객체에 `addSuppressed()`로 매달아 두는 메커니즘이다
(try-with-resources를 위해 Java 7에서 Throwable에 추가).
스택트레이스 출력에 `Suppressed: ...` 블록으로 함께 찍히고, 코드로는
`e.getSuppressed()` 배열로 꺼낸다. 주의: **finally 수동 정리에서는 반대**
— finally에서 던진 예외가 이기고 원래 예외가 소멸한다. 이 우선순위 차이를
아는지가 이 주제의 이해도를 가른다.

### "AutoCloseable과 Closeable의 차이는?"

`Closeable`(java.io, Java 5)이 먼저 있었고 `close() throws IOException`을
선언한다. try-with-resources를 만들면서 IO 이외의 자원도 담기 위해 상위
인터페이스 `AutoCloseable`(`close() throws Exception`)을 추가했고
Closeable이 이를 상속한다. 계약상 차이 하나: **Closeable의 close는
멱등(여러 번 불러도 안전)이어야 한다**고 명세되어 있고, AutoCloseable은
멱등을 권장하되 요구하지는 않는다. 새 자원 클래스를 만들 때는 가능하면
멱등하게 구현하는 게 안전하다.

### "커넥션 누수가 의심될 때 운영에서 어떤 순서로 추적하겠습니까?" (시니어 변별 포인트)

① **증상 확인** — 풀 메트릭(active/idle/pending)을 본다. active가 풀
최대치에 붙어 있고 pending(대기)이 쌓이면 고갈. 이때 "풀 크기를 늘린다"는
누수라면 시간만 버는 오답이다 — 새는 속도가 그대로면 더 큰 풀도 결국
고갈된다. ② **누수 vs 순수 부하 구분** — 트래픽이 줄어도 active가
내려오지 않으면 누수, 트래픽과 함께 내려오면 용량 문제. ③ **지점 특정** —
HikariCP `leakDetectionThreshold`를 걸어 미반환 커넥션의 대여 지점
스택트레이스를 수집한다. DB 쪽에서는 장시간 idle-in-transaction 세션
목록으로 교차 확인. ④ **수정** — 해당 경로를 try-with-resources로
바꾸거나, 프레임워크가 관리하는 경로(트랜잭션 범위)로 편입시킨다.
early return 분기와 예외 경로가 단골 범인이다.

---

## 한 줄 요약

try-with-resources는 "close를 부르는 것"이 아니라 **사람이 finally로는
매번 정확히 할 수 없는 것 — 모든 탈출 경로에서, 여러 자원을 역순으로
빠짐없이 닫고, close의 예외가 진짜 원인을 덮어쓰지 않게 suppressed로
보존하는 것 — 을 컴파일러 생성 코드로 보장하는 장치**이며, 자원 누수는
평소엔 조용하다가 피크 트래픽에 풀·FD 고갈로 폭발하는 유형이므로
AutoCloseable 자원(커넥션, 스트림, `Files.lines`의 Stream까지)은
예외 없이 이 문법으로 다루는 습관이 방어선이다.
