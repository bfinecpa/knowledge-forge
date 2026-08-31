# RestTemplate vs WebClient vs RestClient — "최신이니까 WebClient"가 왜 틀린 판단인가

> 핵심 관전 포인트: **세 클라이언트의 스펙 차이는 표 한 장이면 끝나지만,
> 질문의 본체는 선택 기준이다. HTTP 클라이언트는 "최신순"이 아니라
> "우리 앱의 실행 모델(스레드 모델)과 맞는가"로 고른다.
> 톰캣 기반 MVC 앱에서 WebClient를 `.block()`으로 쓰면 논블로킹의
> 이점은 하나도 못 얻고 리액터 의존성과 디버깅 복잡도만 떠안는다.
> 평범한 MVC 신규 개발이면 RestClient가 기본값, 진짜 논블로킹이
> 필요한 상황(WebFlux 스택, 대량 동시 외부 호출)이면 WebClient다.
> 그리고 어떤 클라이언트를 고르든 타임아웃·커넥션 풀·에러 핸들링을
> 명시하지 않으면 사고가 난다 — 기본 타임아웃은 사실상 무제한이다.**

---

## 0. 질문 + 의도

**질문**: "`RestTemplate`, `WebClient`, `RestClient`의 차이와 선택 기준은?"

**출제 의도**: 단순 API 선택 같지만 실제로는 타임아웃·커넥션풀 설정이
어디 있는지 아는가의 질문이다. 외부 호출 클라이언트의 기본 설정을
방치한 채 운영에 가는 것이 연쇄 장애의 고전적 시작점이다.

## 1. 3종 비교 — 스펙은 표 한 장

| | RestTemplate | WebClient | RestClient |
|---|---|---|---|
| 등장 시점 | 스프링 3.0 (2009) | 스프링 5.0 (2017) | 스프링 6.1 / 부트 3.2 (2023) |
| 실행 모델 | **동기·블로킹** | **논블로킹·리액티브** | **동기·블로킹** |
| 소속 스택 | spring-web (MVC) | spring-webflux (리액터) | spring-web (MVC) |
| 반환 타입 | 일반 객체 | `Mono<T>` / `Flux<T>` | 일반 객체 |
| API 스타일 | 메서드 나열형 (`getForObject`, `postForEntity`, `exchange`...) | fluent API (메서드 체이닝) | fluent API (WebClient와 거의 같은 모양) |
| 현재 상태 | **유지보수 모드** (deprecated 아님 — 버그 수정은 계속, 신규 기능 없음) | 활발히 유지 | **RestTemplate의 실질적 후계자** |

용어부터 풀면:

- **동기·블로킹**: 응답이 올 때까지 그 요청을 처리하던 스레드가
  **멈춰서 기다린다**. 코드는 위에서 아래로 읽히는 대로 흐르니 단순하다.
- **논블로킹·리액티브**: 요청을 던져놓고 스레드는 다른 일을 하러 간다.
  응답이 도착하면 콜백처럼 이어서 처리된다. 스레드를 적게 쓰고
  동시 처리량이 높지만, 코드가 `Mono`/`Flux`라는 "미래에 올 값의
  포장지"로 감싸져서 흐름을 따라가기 어려워진다.

## 2. 같은 GET 호출, 3가지 코드

외부 API에서 회원 하나를 가져오는 같은 작업이다.

```java
// ① RestTemplate — 메서드 나열형, 옛날 스타일
RestTemplate restTemplate = new RestTemplate();
Member member = restTemplate.getForObject(
        "https://api.example.com/members/{id}", Member.class, id);
```

```java
// ② WebClient — 논블로킹, Mono로 반환
WebClient webClient = WebClient.create("https://api.example.com");

Mono<Member> memberMono = webClient.get()
        .uri("/members/{id}", id)
        .retrieve()
        .bodyToMono(Member.class);
// 여기서 memberMono는 "아직 값이 아니다". 구독(subscribe)되어야 실행되고,
// MVC 코드에서 당장 값이 필요하면 .block()으로 기다려야 한다 ← 함정의 시작
```

```java
// ③ RestClient — 동기·블로킹인데 API는 모던 fluent
RestClient restClient = RestClient.create("https://api.example.com");

Member member = restClient.get()
        .uri("/members/{id}", id)
        .retrieve()
        .body(Member.class);
// WebClient와 거의 같은 모양인데 반환이 그냥 Member — MVC 코드에 자연스럽다
```

②와 ③을 나란히 보면 RestClient의 정체가 보인다: **WebClient의 좋은 API
디자인을 가져오되, 실행 모델은 MVC에 맞는 동기·블로킹으로 만든 것.**
"RestTemplate은 낡았고 WebClient는 우리 스택에 안 맞는다"는 오랜
어정쩡함을 해소하려고 나온 물건이다.

## 3. 선택 기준 — 이 질문의 본체

### 3-1. "최신이니까 WebClient"가 왜 틀렸나

한동안 "RestTemplate은 유지보수 모드니까 WebClient로 가야 한다"는 말이
널리 퍼졌고, 실제로 톰캣 기반 MVC 앱에 WebClient를 넣고 `.block()`으로
쓰는 코드가 양산됐다. 이게 왜 나쁜 선택인가:

```java
// 톰캣 MVC 앱에서 흔히 보는 코드
Member member = webClient.get()
        .uri("/members/{id}", id)
        .retrieve()
        .bodyToMono(Member.class)
        .block();   // ← 결국 스레드를 세워놓고 기다린다
```

- **논블로킹의 이점이 0이다.** `.block()`을 부르는 순간 호출 스레드
  (톰캣 요청 스레드)는 응답을 기다리며 멈춘다. RestTemplate과
  실행 모델상 완전히 동일해진다. 톰캣의 "요청 하나 = 스레드 하나"
  모델 위에서는 애초에 논블로킹이 성립할 자리가 없다.
- **비용은 그대로 추가된다.** 리액터(reactor-core, reactor-netty)
  의존성이 들어오고, 예외가 나면 스택트레이스가 리액터 내부 체인으로
  도배되어 디버깅이 어려워지고, `.block()`을 리액티브 스레드 안에서
  잘못 부르면 `IllegalStateException`(block()/blockFirst()/blockLast()
  are blocking...) 같은 새로운 종류의 장애까지 생긴다.

즉 얻는 것 없이 잃기만 한다. 핵심 문장: **HTTP 클라이언트의 실행 모델은
앱이 서 있는 스레드 모델과 맞아야 한다.** 도구의 최신 여부가 아니라
우리 앱의 바닥이 판단 기준이다.

### 3-2. 실무 결정 트리

- **평범한 스프링 MVC 앱(톰캣, 부트 3.2+) 신규 개발** →
  **RestClient가 기본값.** 동기 모델이라 앱과 맞고, API도 모던하다.
- **WebFlux 스택이거나, 진짜 논블로킹이 필요** (외부 API 수십·수백 개를
  동시에 호출해 조합, 스트리밍 응답, 스레드 수를 늘릴 수 없는
  고동시성 게이트웨이) → **WebClient.** 이때는 `.block()` 없이
  `Mono`/`Flux` 체인 그대로 끝까지 흘려보내야 이점이 산다.
- **기존 RestTemplate 코드** → 잘 돌고 있으면 급하게 갈아탈 이유 없다
  (deprecated가 아니다). 신규 코드부터 RestClient로 쓰고, 리팩토링
  기회가 있을 때 옮기는 정도가 현실적이다. RestClient는 RestTemplate과
  같은 기반(메시지 컨버터, 요청 팩토리)을 공유해서 마이그레이션 비용도 낮다.

## 4. 어느 클라이언트든 반드시 챙기는 실무 공통 화두

면접에서 "선택"만 답하고 끝내면 반쪽이다. 뭘 고르든 아래 세 가지를
명시하지 않으면 사고가 난다.

### 4-1. 타임아웃 — 기본값은 사실상 무제한

외부 API가 응답을 안 주는데 타임아웃이 없으면, 그 요청을 처리하던
스레드는 **영원히 기다린다**. 이런 요청이 몇십 개 쌓이면:

```
외부 API 지연 → 우리 스레드들이 전부 대기 → 톰캣 스레드 풀 고갈
→ 외부 API와 무관한 요청까지 전부 응답 불가 → 서비스 전체 장애
```

남의 장애가 내 장애로 전이되는 고전적 연쇄다. 그래서 connect
timeout(연결 수립까지)과 read timeout(응답 수신까지)을 **반드시 명시**한다.

```java
// RestClient / RestTemplate — 요청 팩토리에 설정
ClientHttpRequestFactorySettings settings = ClientHttpRequestFactorySettings.defaults()
        .withConnectTimeout(Duration.ofSeconds(3))
        .withReadTimeout(Duration.ofSeconds(5));

RestClient restClient = RestClient.builder()
        .baseUrl("https://api.example.com")
        .requestFactory(ClientHttpRequestFactoryBuilder.detect().build(settings))
        .build();
```

```java
// WebClient — 하부 HTTP 라이브러리(reactor-netty)에 설정
HttpClient httpClient = HttpClient.create()
        .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)
        .responseTimeout(Duration.ofSeconds(5));

WebClient webClient = WebClient.builder()
        .baseUrl("https://api.example.com")
        .clientConnector(new ReactorClientHttpConnector(httpClient))
        .build();
```

### 4-2. 커넥션 풀 — 재사용은 늘리고, 개수에는 상한을 건다

HTTP 연결을 매번 새로 맺으면(TCP 핸드셰이크 + TLS) 느리고, 무한정
맺으면 소켓이 고갈된다. 이 한 문장이 커넥션 풀이 **양방향 장치**라는
뜻이다 — 아래가 없으면 절반만 이해한 것이다.

| 방향 | 막는 것 | 수단 |
|---|---|---|
| **하한** | 매번 새로 맺는 낭비 | 연결 재사용 (핸드셰이크 0 RTT) |
| **상한** | 무한정 늘어나는 자원 고갈 | 최대 커넥션 수 / 호스트당 커넥션 수 |

프로덕션에서는 Apache HttpClient나 reactor-netty의 커넥션 풀을 붙이고
최대 커넥션 수, 호스트당 커넥션 수, 유휴 커넥션 정리 주기를 정한다.
"기본 `SimpleClientHttpRequestFactory`는 풀이 없다"까지 알면 가산점
(`HttpURLConnection`을 쓰는데 관리 주체가 없어 사실상 매번 새로 맺는다).

#### 오해 먼저 — 연결 ≠ 요청

"요청할 때마다 TCP 핸드셰이크를 하는 것 아닌가?"는 흔한 오해다.
**연결은 관(pipe)이고 요청은 그 관으로 흘리는 물**이다. 관을 뚫는 데만
비용이 들고, 이미 뚫린 관에는 그냥 흘리면 된다.

```
[HTTP/1.0 — 요청 1개당 연결 1개]
핸드셰이크 → 요청1 → 응답1 → 종료
핸드셰이크 → 요청2 → 응답2 → 종료

[HTTP/1.1 keep-alive(기본값) — 연결 하나를 재사용]
핸드셰이크 → 요청1 → 응답1 → 요청2 → 응답2 → 요청3 → ... → 종료
             └───────────── 같은 TCP 연결 ─────────────┘
```

브라우저도 같은 방식이다. 호스트당 6개쯤만 열어두고 그 위로 이미지·
CSS·JS 수십 개를 순차로 흘린다.

#### 재사용으로 아끼는 비용

```
새 HTTPS 연결 1개를 여는 비용
  TCP 3-way 핸드셰이크   : 1 RTT
  TLS 핸드셰이크         : + 2 RTT (TLS 1.3이면 + 1 RTT)
  ──────────────────────────────────────────────
  합계                    : 2~3 RTT  ← 요청 첫 바이트를 보내기도 전에
```

RTT 30ms인 외부 API라면 **호출마다 60~90ms를 그냥 버린다.** 여기에 TLS
키 교환의 비대칭 암호 연산 CPU 비용이 양쪽 모두에 붙는다. 재사용된
연결이면 이 비용이 전부 0이다.

#### 그런데 keep-alive만으로는 왜 부족한가

keep-alive는 "연결 하나를 계속 쓴다"는 **프로토콜 차원의 약속**일 뿐이다.
실제 앱에서는 스레드 수백 개가 동시에 같은 API를 부른다. 이때 누가 지금
어떤 연결을 쓰는지 추적하고, 다 쓴 연결을 버리지 않고 회수하고, 남는
연결이 없을 때 새로 열지 기다릴지 판단하고, 오래 논 연결을 정리하는
**관리자**가 필요하다. 그게 커넥션 풀이다.

> 풀 = keep-alive 연결들을 여러 스레드가 안전하게 나눠 쓰게 하는 관리자.

#### 무한정 열면 안 되는 이유 ① — fd 고갈

**fd(파일 디스크립터)** 는 커널이 열어둔 무언가를 가리키는, 프로세스가
들고 있는 작은 정수다. 물품보관소 번호표와 같다 — 실물(소켓·파일)은
커널이 보관하고 프로세스는 번호만 들고 다닌다. 유닉스의 "everything is
a file" 원칙에 따라 파일·**소켓**·파이프·터미널이 전부 fd로 표현되고,
그래서 `read()`/`write()`/`close()`로 똑같이 다뤄진다. 자바의 `Socket`,
`FileInputStream`도 내부에 `FileDescriptor`를 하나씩 안고 있다.

```
프로세스                        커널
┌──────────────┐            ┌────────────────────────────┐
│  fd 테이블    │            │  실제 객체                 │
│   0 ─────────┼───────────▶│  stdin                     │
│   3 ─────────┼───────────▶│  /app/config.yml (파일)    │
│   7 ─────────┼───────────▶│  TCP 소켓 → 외부 API       │
│  12 ─────────┼───────────▶│  TCP 소켓 → 인바운드 요청  │
└──────────────┘            └────────────────────────────┘
       ↑ 이 테이블의 상한이 `ulimit -n` (리눅스 기본 1024인 경우가 흔함)
```

중요한 건 이 테이블이 **프로세스당 하나**라는 점이다. 아웃바운드용·
인바운드용·파일용이 따로가 아니라 한 통장을 같이 쓴다.

```
외부 API 호출로 fd를 다 써버림
  → 새 인바운드 연결 수락(accept)도 fd가 필요한데 못 받음  ← 서비스 정지
  → 로그 파일 쓰기·설정 파일 읽기도 실패
  → 전부 "Too many open files"
```

외부 호출 하나가 서버 전체를 마비시키는 경로가 이것이다.
(`ls /proc/<PID>/fd | wc -l`로 현재 사용량을 볼 수 있다.)

#### 무한정 열면 안 되는 이유 ② — TIME_WAIT과 포트 고갈

"소켓 하나당 포트 하나"가 아니다. TCP 연결의 신분증은 **4-튜플**이고,
이 묶음만 유일하면 된다.

```
(로컬 IP, 로컬 포트, 원격 IP, 원격 포트)
```

응답 패킷이 도착했을 때 커널이 "이걸 어느 소켓에 넣지?"를 판단할 근거가
이 튜플뿐이라서 연결마다 달라야 한다. **서버 쪽**을 보면 이게 명확하다 —
동시 접속 1만 명이어도 서버가 쓰는 로컬 포트는 443 하나다.

```
소켓 #1 : (10.0.0.5:443, 203.0.113.7:51234)
소켓 #2 : (10.0.0.5:443, 203.0.113.7:51235)   ← 원격 포트로 구분
소켓 #3 : (10.0.0.5:443, 198.51.100.2:40001)  ← 원격 IP로 구분
```

그런데 **클라이언트가 같은 대상 서버로 연결할 때**는 사정이 다르다.

```
소켓 #1 : (10.0.0.5:33001, 93.184.216.34:443)
소켓 #2 : (10.0.0.5:33002, 93.184.216.34:443)
           ──────── ─────  ─────────────────
           내 IP 고정        상대 IP:포트 고정
                  ↑ 네 자리 중 유일하게 바꿀 수 있는 자리
```

세 자리가 고정이라 **로컬 포트만이 구분자**가 된다. 결과적으로 연결
하나가 로컬 포트 하나를 잡아먹는다. 여기에 TIME_WAIT이 겹친다 —
연결을 끊어도 커널은 뒤늦게 도착한 옛 패킷이 새 연결에 섞이는 걸 막기
위해 **그 튜플을 60초간(리눅스) 예약**해 둔다. fd는 즉시 반납되지만
로컬 포트는 잠긴 채다.

```
임시 포트 범위(리눅스 기본 32768~60999) ≈ 28,000개
28,000 ÷ 60초 ≈ 초당 470 연결이 물리적 상한

초과 → java.net.BindException: Cannot assign requested address
```

**CPU도 메모리도 멀쩡한데 연결만 실패**하므로 원인 파악이 어렵다.
단 이 예산은 전역이 아니라 **(상대 IP:포트)마다 따로** 주어진다 —
상대가 다르면 튜플이 달라지므로 같은 로컬 포트를 다시 쓸 수 있다.

#### 무한정 열면 안 되는 이유 ③ — 상한은 제약이 아니라 백프레셔

설계 관점에서 가장 중요한 이유다. 외부 API가 느려졌을 때를 비교하면:

```
[풀 없음 / 무제한]
  응답 5초로 지연 → 연결이 계속 증가 → 500개 … 2000개 … 5000개
  → fd·포트 고갈 → 서버 전체 사망 (느리고, 원인 불명확하고, 복구도 느림)

[풀 있음 / 최대 50]
  응답 5초로 지연 → 50개에서 멈춤
  → 51번째 스레드는 풀에서 대기 → 지정 시간 내 못 얻으면 즉시 실패
  → 빠른 실패 + 지표에 "pool timeout"으로 명확히 기록
```

상한은 압력을 **눈에 보이는 형태로 바꿔** 조용한 자원 고갈사를 빠르고
진단 가능한 실패로 전환한다. 서킷 브레이커·벌크헤드와 같은 계열의
발상이며, 4-1의 타임아웃과 짝을 이룬다.

#### 설정

```java
// WebClient — reactor-netty ConnectionProvider
ConnectionProvider provider = ConnectionProvider.builder("api-pool")
        .maxConnections(50)                             // 상한
        .pendingAcquireTimeout(Duration.ofSeconds(3))   // 상한 도달 시 빠른 실패
        .maxIdleTime(Duration.ofSeconds(20))            // 유휴 정리 (아래 참고)
        .build();

HttpClient httpClient = HttpClient.create(provider)
        .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)
        .responseTimeout(Duration.ofSeconds(5));
```

```java
// RestClient / RestTemplate — Apache HttpClient 5 풀
PoolingHttpClientConnectionManager cm = PoolingHttpClientConnectionManagerBuilder.create()
        .setMaxConnTotal(100)     // 전체 상한
        .setMaxConnPerRoute(50)   // 호스트당 상한 — 한 대상이 풀을 독점하지 못하게
        .build();
```

`maxConnPerRoute`가 따로 있는 이유는, 느려진 대상 하나가 전체 풀을
독차지해 **다른 정상 API 호출까지 굶기는 것**을 막기 위해서다.

#### 왜 "유휴 커넥션 정리 주기"가 필요한가

풀에 넣어둔 연결은 **내가 안 쓰는 동안 상대가 끊을 수 있다.** 서버의
keep-alive 타임아웃, 중간 LB나 NAT의 유휴 타임아웃 때문이다. 내 쪽은
살아있는 줄 알고 꺼내 쓰다가 첫 요청에서 connection reset이나
`NoHttpResponseException`을 맞는다 — 재현이 안 되는 간헐적 오류의
단골 원인이다.

그래서 **내 쪽 유휴 정리 시간을 상대 서버의 keep-alive 타임아웃보다
짧게** 잡는다(상대가 60초면 나는 20초). 죽은 연결을 잡기 전에 내가 먼저
버리는 것이다.

> **정리**: 요청은 초당 5,000개여도 연결은 50개로 고정 — 풀의 본질은
> **유한 자원(fd·포트)의 소모량을 요청량에서 분리하는 것**이다.

### 4-3. 에러 핸들링 — 4xx/5xx 처리 방식이 서로 다르다

- **RestTemplate / RestClient**: 4xx/5xx 응답이면 기본적으로
  `HttpClientErrorException` / `HttpServerErrorException`을 **던진다**.
  RestClient는 `onStatus()`로 상태별 핸들러를 fluent하게 등록할 수 있다.
- **WebClient**: `retrieve()`는 4xx/5xx에서 `WebClientResponseException`을
  담은 **에러 시그널**을 Mono에 흘린다(try-catch가 아니라 `onErrorResume`
  같은 리액티브 연산자로 처리). 상태코드와 무관하게 응답을 직접 다루려면
  `exchangeToMono()`를 쓴다.

```java
// RestClient의 상태별 핸들링
Member member = restClient.get()
        .uri("/members/{id}", id)
        .retrieve()
        .onStatus(HttpStatusCode::is4xxClientError, (request, response) -> {
            throw new MemberNotFoundException(id);
        })
        .body(Member.class);
```

"외부 API의 404를 우리 도메인 예외로 번역해서 경계 안쪽에 HTTP
세부사항이 새지 않게 한다"는 관점까지 붙이면 설계 감각을 보여줄 수 있다.

## 5. 가산점 — HTTP Interface (@HttpExchange)

스프링 6부터는 세 클라이언트 위에 얹는 **선언적 추상화**가 있다.
인터페이스에 어노테이션만 달면 스프링이 구현체를 만들어준다
(Feign과 같은 발상, 스프링 내장판).

```java
public interface MemberApi {

    @GetExchange("/members/{id}")
    Member getMember(@PathVariable Long id);
}

// 어댑터만 갈아끼우면 하부 클라이언트 교체 가능
RestClient restClient = RestClient.create("https://api.example.com");
MemberApi memberApi = HttpServiceProxyFactory
        .builderFor(RestClientAdapter.create(restClient))
        .build()
        .createClient(MemberApi.class);

Member member = memberApi.getMember(1L);  // 그냥 메서드 호출처럼
```

호출부 코드가 "어떤 HTTP 클라이언트를 쓰는가"에서 분리되므로,
나중에 RestClient → WebClient로 바꿔도 호출부는 안 바뀐다.
"클라이언트 선택을 어댑터 한 줄에 가두는 구조"라고 말하면
이 질문의 선택 기준 논의와 자연스럽게 연결된다.

## 6. AI 시대 관점 — 스펙 나열은 AI의 몫, 스택 판단은 리뷰어의 몫

세 클라이언트의 스펙 비교표는 AI에게 물으면 몇 초 만에 나온다.
하지만 AI는 "우리 앱이 톰캣 위 MVC인지, WebFlux인지, 스레드 풀
사정이 어떤지"라는 **컨텍스트를 모른 채** 제안한다. 실제로 AI가
생성한 코드에는 "비동기 처리가 필요해 보여서" WebClient +
`.block()` 조합이 자주 들어 있다 — 3-1에서 본 최악의 조합이다.

리뷰어가 할 일은 스펙 지식이 아니라 판단이다:
"이 코드베이스는 톰캣 MVC다. `.block()`으로 쓸 거면 WebClient를
들일 이유가 없다. RestClient로 바꾸고 타임아웃을 명시하라."
— 이렇게 실행 모델에 근거해 AI의 제안을 걸러내는 것이
사람이 유지해야 할 역량이고, 이 질문이 여전히 면접에 나오는 이유다.

---

## 7. 꼬리질문 대비 포인트

### "MVC 앱에서 WebClient를 .block()으로 쓰면 구체적으로 뭐가 문제인가?"

`.block()`을 부르는 순간 톰캣 요청 스레드가 응답을 기다리며 멈추므로
실행 모델은 RestTemplate과 완전히 같아진다 — 논블로킹의 이점이 0이다.
반면 비용은 다 낸다: 리액터 의존성 추가, 리액터 체인으로 도배된
스택트레이스 때문에 디버깅 난도 상승, 리액티브 스레드 위에서
`.block()`이 호출되면 `IllegalStateException`이 터지는 새로운 장애
유형까지. "얻는 것 없이 복잡도만 산 것"이라고 요약하면 된다.

### "RestTemplate은 deprecated인가? 기존 코드를 다 갈아타야 하나?"

deprecated가 아니다. **유지보수 모드** — 버그와 보안 수정은 계속되지만
새 기능은 안 들어간다는 뜻이고, 당장 못 쓰게 된다는 뜻이 아니다.
따라서 잘 돌아가는 기존 코드를 갈아타는 것 자체가 목적이 되면 안 되고,
"신규 코드는 RestClient, 기존 코드는 손댈 일이 생길 때 함께 이전"이
현실적 판단이다. RestClient가 RestTemplate과 같은 기반(메시지 컨버터,
ClientHttpRequestFactory)을 공유해 점진 이전 비용이 낮다는 점,
그리고 "돌아가는 코드를 트렌드 때문에 바꾸는 것도 리스크"라는
비용-편익 관점을 함께 말하면 시니어다운 답이 된다.

### "외부 API 호출에 타임아웃을 안 정하면 무슨 일이 벌어지나?"

기본값이 사실상 무제한이라, 외부 API가 응답을 안 주면 우리 스레드가
영원히 대기한다. 이런 요청이 쌓이면 톰캣 스레드 풀이 고갈되어
그 API와 무관한 요청까지 전부 죽는다 — **남의 장애가 내 장애로
전이**되는 연쇄다. 한 단계 더: 그 외부 호출이 `@Transactional` 안에
있으면 스레드만이 아니라 **DB 커넥션까지 쥔 채** 대기하므로,
톰캣 풀보다 훨씬 작은 DB 커넥션 풀(기본 10개 수준)이 먼저 고갈되어
장애가 더 빨리, 더 넓게 퍼진다. 그래서 "타임아웃 명시 + 트랜잭션
안에서 외부 호출 하지 않기"가 세트 결론이다.

### "외부 API를 대량으로 동시에 호출해야 하면 어떻게 하나?"

전통적 답: 동기 클라이언트로 100개를 순차 호출하면 지연이 합산되니
(100 × 응답시간), WebClient로 논블로킹 병렬 호출한다 —
`Flux.fromIterable(ids).flatMap(id -> webClient.get()...)` 식으로
적은 스레드로 동시에 흘려보내고 결과를 조합한다.

다만 **자바 21 가상 스레드 이후 판도가 바뀌었다**: 블로킹 호출이라도
가상 스레드에서는 스레드가 대기하는 비용이 거의 0이라, RestClient
같은 동기 클라이언트를 가상 스레드 + ExecutorService로 병렬 실행해도
동시성 목표를 달성할 수 있다. 코드는 순차 코드처럼 읽히면서 동시성은
확보되므로, "대량 동시 호출 = 무조건 WebClient"라는 공식도 약해졌다.
이 판도 변화까지 언급하면 최신 지형을 아는 답변이 된다.

### "그럼 MVC에서 WebClient를 쓰는 게 정당화되는 경우는 없나?"

있다. 핵심은 `.block()`으로 즉시 값을 뽑지 않는 사용일 때다.
(1) SSE·스트리밍 응답을 받아 흘려보내는 경우 — 동기 클라이언트로는
자연스럽게 다루기 어렵다. (2) 여러 외부 API를 동시 호출해 조합하되
결과를 `DeferredResult`/`CompletableFuture`로 이어 톰캣 스레드를
잡아두지 않는 경우. (3) 조직이 WebFlux로의 이전을 진행 중이라
클라이언트를 먼저 통일하는 과도기 전략. 반대로 "단건 호출하고 바로
`.block()`"이 코드의 전부라면 정당화되지 않는다 — 정당성은 도구가
아니라 **사용 패턴**에서 나온다고 정리하면 된다.

---

## 한 줄 요약

RestTemplate(동기·유지보수 모드), WebClient(논블로킹·리액티브),
RestClient(동기 + 모던 API, RestTemplate의 후계자)의 스펙 차이보다
중요한 것은 선택 기준이다 — HTTP 클라이언트는 최신순이 아니라
앱의 스레드 모델과 맞는 실행 모델로 골라야 하므로, 톰캣 MVC라면
RestClient가 기본값이고 WebClient는 `.block()` 없이 논블로킹을
끝까지 살릴 수 있을 때만 정당하며, 무엇을 고르든 타임아웃·커넥션 풀·
에러 핸들링을 명시하지 않으면 남의 장애가 내 장애가 된다.
