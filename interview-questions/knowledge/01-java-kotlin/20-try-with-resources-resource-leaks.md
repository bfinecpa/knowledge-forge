# try-with-resources — finally로 닫으면 진짜 원인이 사라진다

> 핵심 관전 포인트: **"finally에서 close하면 되는데 왜 새 문법이 필요한가"에 대한 답은 "더 간결해서"가 아니라 "finally 방식은 예외를 삼킨다"는 것이다. try 본문에서 예외 A가 나고 finally의 `close()`에서 예외 B가 나면, 자바는 진행 중이던 A를 버리고 B를 던진다 — 로그에는 "닫기 실패"만 남고 진짜 원인인 "읽기 실패"는 흔적도 없이 사라진다. try-with-resources는 반대로 A를 주 예외로 던지고 B를 `suppressed`로 A에 매달아 둘 다 보존한다. 여기에 더해 여러 자원을 선언의 역순(나중에 연 것을 먼저)으로 전부 닫아 주고, 하나의 close가 실패해도 나머지 close를 계속 실행한다. 자원 누수는 GC가 구제해 주지 않는 종류의 누수라(외부 자원은 close를 불러야만 반환된다) 평소엔 조용하다가 트래픽이 몰리는 날 커넥션 풀 고갈이나 `Too many open files`로 한꺼번에 터진다. 그래서 이 습관은 취향이 아니라 자원 생명주기를 의식하는지의 표본이고, 운영에서는 HikariCP의 `leakDetectionThreshold`와 풀 지표로 누수 지점을 특정하는 절차까지 갖춰야 한다.**

---

## 0. 질문 + 의도

**질문**: "try-with-resources는 어떤 문제를 해결하나요? 자원 누수가 발생하는 전형적인 코드 패턴은?"

**출제 의도**: 커넥션·스트림 누수는 평소엔 멀쩡하다가 트래픽이 몰리는 날 풀 고갈로 터진다. finally 수동 정리의 실수 가능성(예외 중첩, 반환 누락)을 언어 기능으로 제거하는 습관 — 자원의 생명주기를 의식하며 코드를 쓰는지의 표본으로 본다.

## 1. 전제와 진짜 문제 — finally는 예외를 삼킨다

### 1-1. 전제 지식 — "자원"이 무엇이고 왜 GC로는 안 되는가

먼저 이 문서에서 말하는 **자원(resource)**을 정의하고 가자. 자원은 **자바 힙 바깥의 무언가를 점유하는 객체**다. DB 커넥션, 파일 핸들, 소켓, 네이티브 메모리 같은 것들이다.

여기서 "힙 바깥"이 핵심이다. `new ArrayList<>()`로 만든 리스트는 힙 안에만 존재하므로, 아무도 참조하지 않게 되면 GC가 알아서 회수한다. 우리가 신경 쓸 일이 없다.

그런데 `dataSource.getConnection()`으로 받은 커넥션 객체는 다르다. 자바 객체는 힙에 있지만, 그 객체가 붙잡고 있는 진짜 자원 — **커넥션 풀의 한 자리**, **OS가 발급한 파일 디스크립터**, **DB 서버 쪽의 세션** — 은 힙 바깥에 있다. GC는 힙만 관리하므로 이것들의 존재를 알지 못한다.

```text
[자바 힙]                        [힙 바깥]

 Connection 객체  ──────────────> 커넥션 풀의 한 자리 (총 10개 중 1개)
                                  DB 서버의 세션 1개
                                  TCP 소켓 1개

 GC가 회수하는 범위 ─────┘        └───── GC가 손대지 못하는 범위
                                         close()를 불러야만 반환된다
```

**그래서 close 누락은 GC가 구제해 주지 않는 누수가 된다.** 자바 객체 쪽은 회수될지 몰라도, 그것이 붙잡고 있던 풀의 한 자리와 파일 디스크립터는 그대로 묶여 있다.

증상이 나타나는 방식도 여기서 나온다. **자원은 개수가 정해져 있다.** 커넥션 풀은 최대 크기가 있고, 프로세스가 열 수 있는 파일 디스크립터에도 OS 한도가 있다. 하나씩 새는 동안에는 아무 증상이 없다가, **한도에 도달하는 순간 그 자원을 쓰는 모든 코드가 동시에 죽는다.** 커넥션이면 `Connection is not available` 타임아웃, 파일 디스크립터면 `Too many open files`다.

평소엔 조용하고 트래픽이 몰리는 날 한꺼번에 터지는 이유가 이것이다. 새는 속도는 요청량에 비례하므로, 피크 트래픽에서 한도에 훨씬 빨리 도달한다.

### 1-2. finally의 진짜 결함 — 예외를 삼킨다

"자원은 finally에서 닫으면 되지 않나"가 자연스러운 반응이다. 실제로 자바 7 이전에는 그것이 유일한 방법이었다.

```java
// finally에서 닫는 고전적 형태 — close 호출 자체는 확실히 보장된다
static String readFirstLine(Path path) throws IOException {
    BufferedReader reader = Files.newBufferedReader(path);
    try {
        return reader.readLine();   // (A) 여기서 읽기가 실패한다고 하자
    } finally {
        reader.close();             // (B) 닫기도 실패한다고 하자
    }
}
```

close는 분명히 호출된다. 그런데 (A)와 (B)가 둘 다 예외를 던지면 이 메서드 밖으로 나가는 것은 무엇인가.

```text
[실제 출력]
Exception in thread "main" java.io.IOException: 닫기 실패(B)
	at java.base/java.io.BufferedReader.close(BufferedReader.java:...)
	at com.example.FileReader.readFirstLine(FileReader.java:9)
	at ...

  ★ (A)는 어디에도 없다. 로그 어디를 뒤져도 "읽기 실패"라는 단어가 나오지 않는다.
```

**진짜 원인인 A가 사라지고 부수적인 B만 남았다.** 이것이 finally 방식의 진짜 결함이고, "간결함" 같은 취향 문제가 아닌 이유다.

왜 이렇게 되는지는 자바의 `finally` 규칙 때문이다. **finally 블록이 예외를 던지며 끝나면, 그 예외가 진행 중이던 예외를 대체한다.** try에서 던져지던 A는 finally가 정상적으로 끝나야만 계속 전파되는데, finally 자신이 B를 던지면 메서드는 B와 함께 종료되고 A는 그냥 버려진다.

자원과 무관하게 이 규칙만 떼어 보면 더 분명하다.

```java
try {
    throw new IllegalStateException("A");
} finally {
    throw new IllegalArgumentException("B");
}
// 밖으로 나가는 것은 B뿐이다. A는 어디에도 기록되지 않고 사라진다.
// finally의 return도 같은 방식으로 try의 return을 덮어쓴다.
```

여기서 흔한 반론이 나온다. **"close가 예외를 던지는 일이 실제로 있나?"**

있다. 그리고 하필 **가장 나쁜 타이밍에 있다.**

`BufferedWriter.close()`는 내부적으로 버퍼를 비우는 `flush()`를 하므로 디스크가 가득 찼거나 네트워크가 끊겼으면 실패한다. 소켓의 close도 실패할 수 있고, DB 커넥션의 close도 마찬가지다.

결정적인 것은 이것이다. **try 본문이 실패한 원인과 close가 실패한 원인은 대개 같다.** DB 커넥션이 끊겨서 쿼리가 실패했다면, 그 끊긴 커넥션을 닫는 것도 실패한다. 네트워크가 죽어서 읽기가 실패했다면 닫기도 실패한다.

즉 **두 예외가 함께 나는 것은 우연이 아니라 상관관계가 있는 사건**이고, 그 말은 **진짜 심각한 장애일수록 원인이 은폐될 확률이 높다**는 뜻이다. 평소에는 잘 돌다가 진짜 장애 때만 로그가 쓸모없어지는 최악의 조합이다.

### 1-3. try-with-resources는 A를 던지고 B를 매달아 둔다

같은 코드를 try-with-resources로 바꾸면 결과가 달라진다.

```java
// After: 자원을 try의 괄호 안에서 선언한다
static String readFirstLine(Path path) throws IOException {
    try (BufferedReader reader = Files.newBufferedReader(path)) {
        return reader.readLine();   // (A) 읽기 실패
    }                               // (B) 블록을 벗어나며 close, 그것도 실패
}
```

```text
[실제 출력]
Exception in thread "main" java.io.IOException: 읽기 실패(A)
	at com.example.FileReader.readFirstLine(FileReader.java:8)
	at ...
	Suppressed: java.io.IOException: 닫기 실패(B)
		at java.base/java.io.BufferedReader.close(BufferedReader.java:...)
		at com.example.FileReader.readFirstLine(FileReader.java:9)
		... 1 more

  ★ 주 예외 자리에 A가 있고, B는 그 아래 "Suppressed:" 블록으로 붙어 있다.
    둘 다 남았고, 우선순위도 우리 직관과 일치한다.
```

**억제된 예외(suppressed exception)**는 "주 예외가 전파되는 동안 부수 경로에서 발생해 삼켜질 뻔한 예외를 주 예외 객체에 매달아 두는" 장치다. 삼켜지는(suppressed) 대신 붙어 있다는 뜻으로 이런 이름이 붙었다. try-with-resources를 만들면서 자바 7에서 `Throwable`에 `addSuppressed()`와 `getSuppressed()`가 추가됐다.

스택트레이스에만 찍히는 것이 아니라 코드로도 꺼낼 수 있다.

```java
try {
    readFirstLine(path);
} catch (IOException e) {
    System.out.println("주 예외: " + e.getMessage());        // 주 예외: 읽기 실패(A)
    for (Throwable s : e.getSuppressed()) {
        System.out.println("  억제됨: " + s.getMessage());   //   억제됨: 닫기 실패(B)
    }
}
```

두 방식의 차이를 한 줄로 정리하면 이렇다.

| | try 본문의 예외 A | close의 예외 B |
|---|---|---|
| finally 수동 정리 | **사라진다** | 밖으로 던져진다 |
| try-with-resources | 밖으로 던져진다 | A에 `suppressed`로 매달린다 |

**우선순위가 정확히 반대**다. finally는 나중에 난 예외가 이기고, try-with-resources는 원래 예외가 이긴다. 이 차이를 아는지가 이 주제의 이해도를 가르는 지점이다 (가산점 포인트).

### 1-4. 자원 누수가 나는 전형적 패턴 4가지 — 왜 사람이 계속 실수하는가

예외 은폐가 finally의 결함이라면, 자원 누수는 그보다 더 흔한 실수다. 패턴이 네 가지인데, 중요한 것은 패턴 자체가 아니라 **왜 이 실수가 반복되는가**다.

#### 패턴 ① try 블록 없이, 마지막 줄에서 close

```java
// Before: read()에서 예외가 나면 close()에 도달하지 못한다
InputStream in = new FileInputStream(path);
process(in.read());
in.close();          // 위에서 예외가 나면 이 줄은 실행되지 않는다
```

**왜 계속 실수하는가.** 이 코드는 위에서 아래로 읽으면 완벽히 자연스럽다 — 열고, 쓰고, 닫는다. 사람의 머릿속 실행 모델은 "코드는 위에서 아래로 순서대로 실행된다"인데, **예외는 그 순서를 가로지르는 보이지 않는 탈출구**다. 그 탈출구가 코드 모양에 전혀 드러나지 않는다. `in.read()` 한 줄만 봐서는 여기서 밖으로 튈 수 있다는 사실을 알 수 없다.

#### 패턴 ② finally는 썼지만, 자원이 여러 개일 때 일부만 닫힘

```java
// Before: conn.close()가 예외를 던지면 아래 두 줄은 영영 실행되지 않는다
Connection conn = null;
PreparedStatement stmt = null;
ResultSet rs = null;
try {
    conn = dataSource.getConnection();
    stmt = conn.prepareStatement(sql);
    rs = stmt.executeQuery();
    ...
} finally {
    conn.close();   // 여기서 예외가 나면
    stmt.close();   // 이 줄과
    rs.close();     // 이 줄은 건너뛴다 — stmt와 rs가 누수된다
}
```

순서를 바꿔도 해결되지 않는다. 셋 중 **어느 것이든** close가 예외를 던지면 그 뒤의 close들이 전부 건너뛰어진다.

"제대로" 하려면 close마다 null 체크와 개별 try-catch가 필요하다.

```java
} finally {
    if (rs != null)   { try { rs.close();   } catch (SQLException ignored) {} }
    if (stmt != null) { try { stmt.close(); } catch (SQLException ignored) {} }
    if (conn != null) { try { conn.close(); } catch (SQLException ignored) {} }
}
```

**왜 계속 실수하는가.** 정리 코드가 본문보다 길어졌다. 사람은 길고 반복적이며 "아무 일도 안 하는 것처럼 보이는" 장식 코드를 본능적으로 줄이려 하고, **줄이는 순간 틀린다.** 여기에 "정리 코드가 실패할 리 없다"는 무의식적 가정이 깔려 있어서 개별 try-catch를 생략하는 것이 합리적으로 느껴진다.

#### 패턴 ③ 예외 은폐 — 1-2에서 본 그것

```java
// Before: try 본문의 진짜 원인이 finally의 close 예외에 먹힌다
try {
    return parse(in);      // 여기서 난 예외가
} finally {
    in.close();            // 여기 예외에 덮여 사라진다
}
```

**왜 계속 실수하는가.** 이건 앞의 셋과 성격이 다르다. **실수했다는 자각조차 없다.** 코드는 정확히 의도대로 짜였고 close도 확실히 불리고 있다. 문제는 **언어의 finally 규칙이 개발자의 직관과 다르다**는 것이고, 이건 배우지 않으면 알 방법이 없다. 그리고 배우지 않아도 평소에는 아무 문제가 없다 — close가 실패하는 진짜 장애 때만 조용히 손해를 본다.

#### 패턴 ④ 조기 반환 경로에서 반환 누락

```java
// Before: 커넥션을 빌린 뒤 조건 분기에서 반환하지 않고 return
Connection conn = dataSource.getConnection();
if (alreadyProcessed(id)) {
    return;                 // conn이 풀로 반환되지 않는다
}
...
conn.close();
```

**왜 계속 실수하는가.** 이 패턴의 범인은 대개 **나중에 추가된 조기 반환**이다.

처음 짤 때는 맞는 코드였다. `getConnection()`과 `conn.close()`가 짝을 이루고 있었다. 그러다 몇 달 뒤 누군가 "이미 처리된 건은 빨리 건너뛰자"며 위쪽에 `return` 한 줄을 추가한다. 그 사람의 시야에는 그 `return`과 40줄 아래의 `close()`가 연결돼 보이지 않는다. 리뷰어에게도 마찬가지다 — diff에는 `return;` 한 줄만 찍혀 있고, 그 한 줄은 어느 모로 봐도 무해하다.

**자원의 획득과 반환이 물리적으로 떨어져 있는 코드는 시간이 지나면 반드시 샌다.** try-with-resources가 근본적으로 해결하는 것이 이것이다 — 자원의 수명을 **블록의 범위**로 묶어 버리므로, 그 블록 안 어디에서 어떻게 빠져나가든 close가 붙어 나간다. 나중에 `return`을 추가하는 사람이 자원의 존재를 몰라도 안전하다.

네 패턴의 공통점을 하나로 묶으면 이렇다. **전부 코드 리뷰와 테스트를 통과한다.** 자원은 한 번에 하나씩 새는 것이라 테스트에서는 증상이 없고, 리뷰에서는 위에서 아래로 읽으면 멀쩡해 보인다. **"잘 짜면 된다"가 아니라 사람이 반복하는 실수를 언어 기능으로 제거해야 하는 이유**가 여기에 있다.

## 2. 동작 — 무엇을 어떻게 보장하나

### 2-1. 기본 형태와 대상

```java
// try의 괄호 안에서 선언한 자원은 블록을 벗어나는 모든 경로에서 자동으로 닫힌다
try (Connection conn = dataSource.getConnection();
     PreparedStatement stmt = conn.prepareStatement(sql);
     ResultSet rs = stmt.executeQuery()) {
    while (rs.next()) { ... }
}   // 여기서 rs -> stmt -> conn 순으로 전부 close
```

대상은 **`AutoCloseable`을 구현한 객체**다. 이 인터페이스를 구현했다는 것 자체가 **"나는 닫아야 하는 자원이다"**라는 언어 수준의 표시다. 어떤 객체를 닫아야 하는지 헷갈리면 그 타입이 `AutoCloseable`을 구현했는지 보면 된다.

자바 9부터는 블록 밖에서 만든 변수도 사실상 final(effectively final, 한 번 대입하고 다시 대입하지 않는 변수)이면 이름만 넣을 수 있다.

```java
Connection conn = dataSource.getConnection();
try (conn) { ... }   // Java 9+
```

### 2-2. close 순서 — 선언의 역순

여러 자원을 선언하면 **선언의 역순**으로 닫힌다. 말로만 들으면 헷갈리니 실행 순서를 직접 찍어 보자.

```java
class Res implements AutoCloseable {
    private final String name;
    Res(String name) { this.name = name; System.out.println("open  " + name); }
    @Override public void close() { System.out.println("close " + name); }
}

try (Res a = new Res("A");
     Res b = new Res("B");
     Res c = new Res("C")) {
    System.out.println("본문 실행");
}
```

```text
[출력]
open  A     ← 위에서부터 순서대로 열리고
open  B
open  C
본문 실행
close C     ← 닫을 때는 거꾸로
close B
close A
```

**왜 역순인가.** 의존 관계 때문이다. 나중에 만든 자원이 먼저 만든 자원에 기대고 있다.

```text
Connection  ← 가장 먼저 열린다. 아무것에도 의존하지 않는다.
    ↑ 의존
PreparedStatement  ← 이 커넥션 위에서만 유효하다.
    ↑ 의존
ResultSet   ← 이 스테이트먼트가 살아 있어야 결과를 읽을 수 있다.
```

`Connection`을 먼저 닫으면 그 위에 매달린 `Statement`와 `ResultSet`은 이미 기반이 사라진 상태가 된다. 그 상태에서 close를 부르면 예외가 나거나, 더 나쁘게는 드라이버 구현에 따라 무엇이 일어날지 정의되지 않는다. **의존하는 쪽부터 풀어야 한다.**

비유하면 옷을 입고 벗는 순서다. 속옷 → 셔츠 → 코트 순으로 입었으면 벗을 때는 코트부터다. 셔츠를 먼저 벗을 방법은 없다.

### 2-3. 하나가 실패해도 나머지는 닫는다

패턴 ②에서 finally가 못 했던 것이 이것이다. try-with-resources는 **한 자원의 close가 예외를 던져도 나머지 자원의 close를 계속 실행한다.**

```text
[finally 수동 정리]
  conn.close() 실패 -> 예외 발생 -> stmt.close(), rs.close() 실행 안 됨
                                    → stmt와 rs 누수

[try-with-resources]
  rs.close()   -> 실패해도 계속 진행 (예외는 모아 둔다)
  stmt.close() -> 실행됨
  conn.close() -> 실행됨
                  → 누수 없음. 모아 둔 예외들은 주 예외에 suppressed로 첨부
```

자원 생성 중에 실패하는 경우도 안전하다. 두 번째 자원을 만들다 예외가 나면 **이미 만들어진 첫 번째 자원은 닫아 준다.** 이걸 수동으로 하려면 생성 단계마다 try를 중첩해야 한다.

### 2-4. 컴파일러가 대신 써 주는 코드

지금까지의 보장이 마법이 아니라 **컴파일러가 생성하는 평범한 코드**라는 것을 보면 이해가 굳어진다. 자원 하나 기준의 개념 형태다.

```java
Resource r = acquire();
Throwable primary = null;          // try 본문에서 난 "진짜" 예외를 기억해 둘 자리
try {
    ...본문...
} catch (Throwable t) {
    primary = t;                   // 기억해 두고
    throw t;                       // 그대로 다시 던진다
} finally {
    if (r != null) {
        if (primary != null) {
            // 본문에서 이미 예외가 났다면, close의 예외로 그것을 덮으면 안 된다.
            // 그래서 close를 별도로 try로 감싸 잡고, 주 예외에 매달아 둔다.
            try { r.close(); }
            catch (Throwable sup) { primary.addSuppressed(sup); }
        } else {
            // 본문이 정상이었다면 close의 예외는 감출 이유가 없으므로 그대로 전파한다.
            r.close();
        }
    }
}
```

**우리가 1-2에서 "직접 하려면 이렇게 해야 한다"고 본 그 귀찮은 코드를 컴파일러가 정확하게 써 준다.** try-with-resources가 하는 일은 새로운 능력을 주는 것이 아니라, **사람이 매번 정확히 하기 어려운 일을 기계가 대신하게 한 것**이다.

### 2-5. `AutoCloseable`과 `Closeable`의 차이

둘 다 `close()`를 가진 인터페이스인데 이름이 둘인 이유는 역사 때문이다.

**`Closeable`이 먼저 있었다.** 자바 5에서 `java.io` 패키지에 추가됐고, IO 스트림을 닫기 위한 것이라 `close() throws IOException`으로 선언되어 있다.

**`AutoCloseable`은 나중에 나왔다.** 자바 7에서 try-with-resources를 도입하면서, IO가 아닌 자원(DB 커넥션, 락, 네이티브 핸들)까지 이 문법으로 다루려면 `IOException`으로는 부족했다. 그래서 `java.lang`에 `close() throws Exception`을 선언한 상위 인터페이스를 새로 만들고, 기존 `Closeable`이 그것을 상속하도록 했다.

```text
AutoCloseable            (java.lang, Java 7)   close() throws Exception
    ↑ 상속
Closeable                (java.io,   Java 5)   close() throws IOException
```

명세상의 차이가 하나 더 있는데 실무에서 의미가 있다. **`Closeable`의 `close`는 멱등(idempotent)해야 한다고 명시되어 있다.** 멱등은 "여러 번 실행해도 결과가 한 번 실행한 것과 같다"는 성질이다. 이미 닫힌 스트림에 다시 `close()`를 불러도 아무 일도 일어나지 않아야 한다.

`AutoCloseable`은 멱등을 **요구하지는 않고 강력히 권장**한다. 요구하지 않는 이유는 락 해제처럼 두 번 부르면 실제로 문제가 되는 자원도 담아야 했기 때문이다.

**우리가 새 자원 클래스를 만든다면 가능하면 멱등하게 구현하는 것이 안전하다.** 자원을 넘겨받은 코드가 "혹시 안 닫혔을까 봐" 한 번 더 닫는 방어적 호출을 하는 일이 흔하기 때문이다.

## 3. 실무 — 어디서 새고, 어떻게 추적하나

### 3-1. 자주 새는 지점

| 자원 | 새는 방식 | 한도에 도달했을 때의 증상 |
|---|---|---|
| JDBC `Connection` (풀) | close 누락 = 풀에 미반환 | 풀 고갈. 커넥션 대기 타임아웃, 서비스 전면 지연 |
| `InputStream`/`OutputStream`, 소켓 | 파일 디스크립터 점유 | `Too many open files` — 프로세스가 새 파일도 소켓도 못 연다 |
| `Files.lines()`, `Files.list()`, `Files.walk()` | 반환된 `Stream`이 파일을 연 채로 유지 | 파일 디스크립터 누수 |
| HTTP 클라이언트의 응답 바디 | 바디를 소비하거나 닫지 않으면 커넥션이 풀로 반환되지 않음 | HTTP 커넥션 풀 고갈 |

세 번째 항목이 가장 자주 놓치는 자리다. **`Stream`이 닫아야 할 자원이라는 사실 자체를 모르는 경우가 많다.**

```java
// Before: Files.lines가 연 파일이 스트림 처리 후에도 열려 있다
List<String> errors = Files.lines(logPath)
        .filter(l -> l.contains("ERROR"))
        .toList();
// toList()로 종단 연산이 끝났으니 다 끝난 것처럼 보이지만,
// 파일 디스크립터는 반납되지 않았다.

// After: Stream도 AutoCloseable이므로 try-with-resources로 감싼다
try (Stream<String> lines = Files.lines(logPath)) {
    return lines.filter(l -> l.contains("ERROR")).toList();
}
```

여기서 정확히 알아둘 경계가 있다. **모든 스트림을 닫아야 하는 것은 아니다.** `list.stream()`이나 `Arrays.stream(arr)`처럼 컬렉션이나 배열에서 만든 스트림은 힙 안의 데이터만 훑으므로 닫을 것이 없다. **원본이 IO 자원인 스트림 — `Files.lines`, `Files.walk`, DB 커서를 흘려보내는 스트림 — 만 닫아야 한다.** `Stream`이 `AutoCloseable`을 구현하고 있는 것은 그 소수의 경우를 위해서다.

### 3-2. Spring이 대신해 주는 경계, 우리 책임이 남는 경계

실무에서 헷갈리는 지점이 여기다. **스프링으로 개발하면 `Connection`을 직접 닫을 일이 거의 없다.** 그렇다고 이 주제가 남의 일이 되는 것은 아니다.

**프레임워크가 관리해 주는 것.**

`JdbcTemplate`은 커넥션 획득, `PreparedStatement` 생성, `ResultSet` 순회, 그리고 **역순 close까지 전부 자기가 한다.** 우리가 넘기는 것은 SQL과 결과를 객체로 바꾸는 람다뿐이다. JPA도 마찬가지로 `EntityManager`와 그 아래 커넥션의 수명을 트랜잭션 경계에 맞춰 관리한다. 그래서 `@Transactional` 메서드 안에서 리포지터리를 부르는 평범한 코드에는 close할 것이 없다.

**우리 책임이 남는 것.**

첫째, **결과를 스트림으로 흘려보낼 때**다. 대량 데이터를 메모리에 한꺼번에 올리지 않으려고 `JdbcTemplate`의 `queryForStream`이나 JPA의 `getResultStream`을 쓰면, 그 스트림은 **`ResultSet`과 커넥션을 연 채로** 우리에게 넘어온다. 우리가 스트림을 다 쓰고 닫아야 커넥션이 반납된다. 편의를 위해 프레임워크가 관리를 우리에게 넘긴 경우다.

```java
// 스트리밍 조회는 커넥션을 붙잡은 채 결과를 흘려보낸다 — 반드시 닫는다
@Transactional(readOnly = true)
public void exportAll(Writer out) {
    try (Stream<Order> orders = orderRepository.streamAllBy()) {
        orders.forEach(o -> write(out, o));
    }   // 여기서 닫아야 ResultSet과 커넥션이 반납된다
}
```

둘째, **파일과 HTTP 클라이언트를 직접 다룰 때**다. 엑셀·CSV 생성, 업로드 파일 저장, 외부 API 호출의 응답 바디는 프레임워크가 대신 닫아 주지 않는다.

셋째, **직접 만든 자원 클래스**다. 락, 임시 디렉터리, 네이티브 핸들을 감싼 클래스를 만들었다면 `AutoCloseable`을 구현하고 호출부가 try-with-resources로 쓰게 하는 것이 관례다.

정리하면 **"프레임워크가 관리하는 경로에 있으면 안전하고, 그 경로 밖으로 나오는 순간 우리 책임"**이다. 그리고 누수 사고는 대개 그 경계를 넘는 코드 — 스트리밍 조회, 파일 처리, 외부 연동 — 에서 난다.

### 3-3. 커넥션 누수 추적 — 운영에서의 순서

누수를 안 만드는 것이 최선이지만, 이미 새고 있는 시스템에서 지점을 찾아내는 절차를 갖고 있느냐가 실무 역량이다. 순서가 있다.

**① 증상 확인 — 풀 지표를 본다.** 커넥션 풀은 보통 `active`(사용 중), `idle`(대기 중), `pending`(커넥션을 못 얻어 기다리는 스레드 수) 지표를 낸다. **`active`가 풀 최대치에 붙어 있고 `pending`이 쌓이면 고갈**이다.

여기서 흔한 오답이 **"풀 크기를 늘린다"**다. 누수라면 시간만 버는 조치다. 새는 속도가 그대로면 더 큰 풀도 결국 같은 방식으로 고갈되고, 그동안 DB 서버 쪽 세션만 늘어난다.

**② 누수인지 순수 부하인지 구분한다.** 이 구분이 방향을 정한다.

```text
[순수 부하]   트래픽 ↓  ->  active ↓      요청이 끝나면 커넥션이 돌아온다
[누수]        트래픽 ↓  ->  active 그대로  ★ 반납되지 않은 커넥션이 계속 잡혀 있다
```

**트래픽이 줄었는데도 `active`가 내려오지 않으면 누수다.** 트래픽과 함께 내려오면 용량 문제이므로 풀 크기나 쿼리 성능을 봐야 한다.

**③ 지점을 특정한다 — HikariCP의 `leakDetectionThreshold`.** 이 설정을 켜면 HikariCP가 **커넥션을 빌려간 뒤 설정 시간 안에 반납하지 않은 경우, 빌려간 지점의 스택트레이스를 경고 로그로 남긴다.** 누수 코드의 위치를 직접 찍어 주는 셈이라 실무의 1차 방어선이다.

```yaml
spring:
  datasource:
    hikari:
      # 정상적으로 가장 오래 걸리는 작업보다 넉넉히 위로 잡는다.
      # 너무 짧게 잡으면 정상적인 장시간 배치가 전부 경고로 찍혀 노이즈가 된다.
      # HikariCP는 2초(2000) 미만 값은 받지 않는다.
      leak-detection-threshold: 30000
```

DB 쪽에서 교차 확인도 한다. PostgreSQL이면 `pg_stat_activity`에서 `state`가 `idle in transaction`인 채로 오래 머무는 세션을 찾는다. 애플리케이션이 커넥션을 붙잡고 아무것도 안 하고 있다는 신호다.

```sql
-- 트랜잭션을 연 채 놀고 있는 세션 — 누수 또는 커밋 누락의 흔적
SELECT pid, state, now() - state_change AS idle_for, query
  FROM pg_stat_activity
 WHERE state = 'idle in transaction'
   AND now() - state_change > interval '1 minute'
 ORDER BY idle_for DESC;
```

**④ 스레드 덤프로 확인한다.** 풀이 고갈되면 커넥션을 기다리는 스레드들이 전부 같은 지점에서 대기한다. 스레드 덤프를 뜨면 **다수의 스레드가 `HikariPool.getConnection`에서 `TIMED_WAITING` 상태로 멈춰 있는** 모습이 보인다. 이건 "누가 새게 했는가"는 알려주지 않지만 **"지금 문제가 커넥션 풀이다"**를 확정해 준다. 애플리케이션이 느린 이유가 GC인지, 외부 API 대기인지, 커넥션 대기인지 가르는 데 쓴다.

**⑤ 수정한다.** 찾아낸 경로를 try-with-resources로 바꾸거나, 프레임워크가 관리하는 경로(트랜잭션 범위)로 편입시킨다. 1-4에서 본 대로 **조기 반환 분기와 예외 경로가 단골 범인**이므로 그쪽을 먼저 본다.

**⑥ 재발을 도구로 막는다.** OS 레벨에서는 `lsof -p <pid>`로 프로세스의 열린 파일 디스크립터 개수 추이를 볼 수 있다. 코드 레벨에서는 IDE, SonarQube, Error Prone 같은 정적 분석 도구가 전부 "`AutoCloseable`을 닫지 않음" 경고 규칙을 갖고 있다. **리뷰에서 사람이 잡기 전에 도구가 잡게 하는 것**이 가장 확실하다 (가산점 포인트).

## 4. 꼬리질문 대비 포인트

### "finally에서 close하면 되는데 try-with-resources가 굳이 왜 필요한가요?"

**"간결해서"라고 답하면 절반만 답한 것이다.** 핵심은 **finally 방식이 예외를 삼킨다**는 것이다.

try 본문에서 진짜 원인 예외 A가 나고 finally의 `close()`에서 예외 B가 나면, 자바의 finally 규칙상 **A는 버려지고 B만 밖으로 나간다.** 로그에는 "닫기 실패"만 남고 "읽기 실패"는 흔적도 없다. 게다가 **본문이 실패한 원인과 close가 실패한 원인은 대개 같으므로**(커넥션이 끊기면 쿼리도 close도 실패한다), 진짜 심각한 장애일수록 원인이 은폐될 확률이 높다.

try-with-resources는 A를 주 예외로 던지고 B를 `suppressed`로 A에 매달아 **둘 다 보존**한다. 우선순위가 정확히 반대다.

여기에 두 가지를 더 얹으면 답이 완성된다. **자원이 여러 개일 때** finally는 하나의 close 실패가 나머지 close를 건너뛰게 만들지만 try-with-resources는 나머지를 계속 닫는다. 그리고 **자원의 수명이 블록 범위로 묶이므로**, 나중에 누가 조기 반환을 추가해도 close가 따라 나간다.

한 문장으로 정리하면 **"할 수는 있지만 사람이 매번 정확히 하기 어려운 일을 컴파일러가 생성하는 코드로 내린 것"**이다.

### "자원을 여러 개 선언하면 close 순서는? 하나가 close 중 예외를 던지면요?"

**선언의 역순**으로 닫는다. `Connection` → `PreparedStatement` → `ResultSet` 순으로 선언했으면 `ResultSet` → `PreparedStatement` → `Connection` 순으로 닫힌다.

이유는 의존 관계다. 나중에 만든 자원이 먼저 만든 자원 위에 얹혀 있으므로(`ResultSet`은 `Statement`가, `Statement`는 `Connection`이 살아 있어야 유효하다), **의존하는 쪽부터 풀어야 한다.** 옷을 벗을 때 코트부터 벗는 것과 같다.

하나의 close가 예외를 던져도 **나머지 자원의 close는 계속 실행된다.** 그 예외들은 밖으로 전파되는 주 예외에 `suppressed`로 첨부된다. finally 수동 정리가 못 하는 부분이 정확히 이것이다.

### "suppressed exception이 뭔가요? catch한 예외에서 어떻게 확인하나요?"

주 예외가 전파되는 동안 **close 같은 부수 경로에서 발생해 삼켜질 뻔한 예외**를, 주 예외 객체에 `addSuppressed()`로 매달아 두는 장치다. try-with-resources를 위해 자바 7에서 `Throwable`에 추가됐다.

확인하는 방법은 두 가지다. 스택트레이스 출력에 `Suppressed: ...` 블록으로 함께 찍히고, 코드에서는 `e.getSuppressed()`가 배열로 돌려준다.

여기서 반드시 덧붙일 것이 **우선순위 대비**다. finally 수동 정리는 **나중에 난 close 예외가 이기고 원래 예외가 소멸**하는 반면, try-with-resources는 **원래 예외가 이기고 close 예외가 매달린다.** 정확히 반대다. 이 차이를 말할 수 있으면 문법을 외운 것이 아니라 왜 만들어졌는지를 이해한 것으로 읽힌다.

### "`AutoCloseable`과 `Closeable`의 차이는?"

역사 순서로 답하면 깔끔하다.

`Closeable`(`java.io`, 자바 5)이 먼저 있었고 `close() throws IOException`을 선언한다. IO 스트림용으로 만들어졌기 때문이다.

try-with-resources를 만들면서 IO 이외의 자원(DB 커넥션, 락, 네이티브 핸들)도 담아야 했는데 `IOException`으로는 표현이 안 됐다. 그래서 상위 인터페이스 `AutoCloseable`(`java.lang`, 자바 7)을 새로 만들어 `close() throws Exception`으로 선언하고, `Closeable`이 그것을 상속하게 했다.

계약상의 차이도 하나 있다. **`Closeable`의 `close`는 멱등(여러 번 불러도 안전)이어야 한다고 명세되어 있고**, `AutoCloseable`은 멱등을 권장하되 요구하지는 않는다. 요구하지 않는 이유는 락 해제처럼 두 번 부르면 실제로 문제가 되는 자원까지 담아야 했기 때문이다. 새 자원 클래스를 만들 때는 가능하면 멱등하게 구현하는 것이 안전하다 — 넘겨받은 쪽이 방어적으로 한 번 더 닫는 일이 흔하기 때문이다.

### "커넥션 누수가 의심될 때 운영에서 어떤 순서로 추적하겠습니까?" (시니어 변별 포인트)

순서를 갖고 답하는 것이 중요하다.

**① 증상 확인.** 풀 지표(`active`/`idle`/`pending`)를 본다. `active`가 최대치에 붙어 있고 `pending`이 쌓이면 고갈이다. 이때 **"풀 크기를 늘린다"는 누수라면 시간만 버는 오답**이다 — 새는 속도가 그대로면 더 큰 풀도 결국 고갈된다.

**② 누수 vs 순수 부하 구분.** 트래픽이 줄어도 `active`가 안 내려오면 누수, 트래픽과 함께 내려오면 용량 문제다. 이 구분이 이후 방향을 완전히 갈라놓는다.

**③ 지점 특정.** HikariCP의 `leakDetectionThreshold`를 걸어 미반납 커넥션의 **대여 지점 스택트레이스**를 수집한다. 임계값은 정상적으로 가장 오래 걸리는 작업보다 넉넉히 위로 잡아야 정상 배치가 경고로 도배되지 않는다. DB 쪽에서는 PostgreSQL의 `pg_stat_activity`에서 `idle in transaction` 상태로 오래 머무는 세션 목록으로 교차 확인한다.

**④ 스레드 덤프로 확정.** 다수의 스레드가 `HikariPool.getConnection`에서 대기 중이면 지금 병목이 커넥션 풀이라는 것이 확정된다. 느림의 원인이 GC인지 외부 API인지 커넥션 대기인지 가르는 용도다.

**⑤ 수정.** 해당 경로를 try-with-resources로 바꾸거나 프레임워크가 관리하는 트랜잭션 범위로 편입시킨다. **조기 반환 분기와 예외 경로가 단골 범인**이라는 것까지 말하면 좋다.

**⑥ 재발 방지.** 정적 분석 도구의 "`AutoCloseable`을 닫지 않음" 규칙을 CI에 걸어 사람 리뷰 이전에 잡히게 한다.

---

## 한 줄 요약

try-with-resources는 "close를 대신 불러 주는 문법"이 아니라 **사람이 finally로는 매번 정확히 할 수 없는 세 가지 — 모든 탈출 경로에서 닫기, 여러 자원을 선언 역순으로 하나도 빠짐없이 닫기, 그리고 close의 예외가 진짜 원인을 덮어쓰지 않게 `suppressed`로 보존하기 — 를 컴파일러 생성 코드로 보장하는 장치**이고, 힙 밖의 자원은 GC가 회수해 주지 않아 누수가 평소엔 조용하다가 피크 트래픽에 풀·파일 디스크립터 고갈로 한꺼번에 터지므로, `AutoCloseable` 자원(커넥션, 스트림, `Files.lines`가 돌려주는 `Stream`, 스트리밍 조회 결과까지)은 예외 없이 이 문법으로 다루고 운영에서는 풀 지표와 `leakDetectionThreshold`로 누수 지점을 특정하는 절차까지 갖추는 것이 완성형이다.
