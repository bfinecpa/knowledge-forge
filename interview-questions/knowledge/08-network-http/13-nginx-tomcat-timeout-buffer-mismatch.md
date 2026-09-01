# Nginx-Tomcat 타임아웃/버퍼 불일치 — 계층 간 설정이 어긋나면 생기는 유령 현상

> 핵심 관전 포인트: **요청 하나는 Nginx와 Tomcat 양쪽의 설정 나사를
> 모두 통과하는데, 두 계층은 서로의 설정을 모른다. 이 불일치가 앱
> 로그에 안 남는 유령 현상을 만든다 — Nginx의 응답 대기(proxy_read_timeout)가
> Tomcat 처리 시간보다 짧으면 사용자는 504를 봤는데 Tomcat은 끝까지
> 처리해 버리는 "유령 성공", keep-alive 유휴 타임아웃이 어긋나면 Tomcat이
> 먼저 닫은 커넥션에 Nginx가 요청을 실어 간헐적 502, 본문 크기 한도
> (client_max_body_size)가 앱 설정과 다르면 "특정 크기에서만 실패하는
> 업로드". 원칙은 하나다 — 바깥 계층의 대기는 안쪽보다 길게, 안쪽
> (upstream) 커넥션의 유휴 수명은 재사용하는 쪽보다 길게, 크기 한도는
> 전 계층에서 일관되게.**

---

## 0. 질문 + 의도

**질문**: "Nginx와 Tomcat 사이의 타임아웃/버퍼 설정 불일치로 생길 수 있는 문제는?"

**출제 의도**: 계층 간 설정 불일치가 만드는 유령 현상(업로드가 특정
크기에서만 실패, 간헐적 502)의 정체를 아는지 — 시스템을 자기 앱이
아니라 계층 스택 전체로 보는 시야를 확인한다. 이런 장애는 앱 로그에
단서가 없어서, 겪어본(또는 원리로 예측할 수 있는) 사람과 아닌 사람의
초동 대응이 극명하게 갈린다.

## 1. 왜 불일치가 문제인가 — 요청 하나, 나사는 양쪽에

요청 하나가 지나는 길에는 계층마다 독립적인 상한이 걸려 있다:

```
클라이언트 ──> Nginx ──────────────> Tomcat(Spring)
              client_max_body_size   multipart max-file-size
              proxy_read_timeout     처리 시간(쿼리·외부호출)
              proxy_buffer/버퍼링    응답 생성 방식(스트리밍 여부)
              upstream keepalive     keepAliveTimeout
```

각 계층은 **자기 나사만 알고 상대의 나사를 모른다.** Nginx는 Tomcat이
얼마나 오래 걸릴지 모르고, Tomcat은 Nginx가 언제 포기할지 모른다.
어긋난 두 값 사이의 좁은 구간에서만 터지는 문제라서 재현이 어렵고
("어제는 됐는데요"), 반려는 Nginx가 했으므로 **앱 로그에는 아무것도
없다.** 이것이 유령 현상의 공통 구조다.

## 2. 타임아웃 불일치 — 504와 유령 성공, 간헐적 502

### (1) proxy_read_timeout < Tomcat 처리 시간 → 504 + 유령 성공

`proxy_read_timeout`(기본 60초)은 Nginx가 Tomcat의 응답을 기다리는
상한이다. Tomcat의 실제 처리(무거운 쿼리, 외부 API 호출)가 이보다
길면:

1. Nginx는 60초에 포기하고 클라이언트에 **504**를 반환한다.
2. 그런데 Tomcat은 그 사실을 모른다 — **처리를 계속해서 끝까지 완료**한다
   (커밋도 된다).
3. 사용자는 실패 화면을 봤으므로 다시 시도한다 → **같은 작업이 두 번
   실행**된다. 결제·주문이면 중복 처리 사고다.

"사용자는 실패를 봤는데 데이터는 만들어져 있다"는 미스터리의 정체가
바로 이것이다. 타임아웃은 **처리를 중단시키는 게 아니라 기다림을
중단시킬 뿐**이라는 사실이 핵심이다.

대응은 두 방향이다: (a) 오래 걸리는 작업 자체를 비동기화(즉시 접수
응답 + 후속 처리)하거나 처리 시간을 줄이는 근본 대응, (b) 계층 정렬 —
Nginx의 대기 상한을 Tomcat의 최악 처리 시간(p99 + 여유)보다 길게,
동시에 그 최악 시간이 정말 허용 가능한지 재검토. 무작정 늘리는 것은
느린 요청이 Nginx 커넥션과 Tomcat 스레드를 그만큼 오래 잡게
허용하는 것이므로 답이 아니다.

### (2) keep-alive 유휴 타임아웃 경쟁 → 간헐적 502

Nginx ↔ Tomcat 사이 커넥션을 매 요청마다 새로 맺으면 낭비이므로
upstream keep-alive로 재사용한다. 그런데 유휴 커넥션을 "언제
닫을지"의 타이머가 양쪽에 따로 있다:

- Nginx: upstream 블록의 `keepalive` 풀이 유휴 커넥션을 보관
- Tomcat: `keepAliveTimeout` — 유휴 커넥션을 이 시간 뒤 닫음

**Tomcat의 유휴 타임아웃이 Nginx의 재사용 시점보다 짧으면 경쟁(race)이
생긴다**: Tomcat이 유휴 커넥션을 닫는 바로 그 순간, Nginx가 그 커넥션에
새 요청을 실어 보내는 경우다. Nginx 입장에선 보냈는데 연결이 끊겨
있으니 error log에 `upstream prematurely closed connection`을 남기고
502가 된다. 확률적으로 드물게 터지므로 "간헐적 502, 재현 불가,
Tomcat은 멀쩡"이라는 전형적인 유령 장애가 된다.

원칙: **커넥션을 재사용하는 쪽(Nginx)이 기대하는 수명보다, 커넥션을
들고 있는 쪽(Tomcat)의 유휴 타임아웃이 길어야 한다.** 즉 닫는 결정은
가능한 한 재사용하는 쪽이 먼저 하게 만든다.

```nginx
# Nginx — upstream keep-alive를 쓸 때의 정석 세트
upstream tomcat_upstream {
    server 10.0.0.11:8080;
    keepalive 32;                  # 유휴 커넥션 풀
}
server {
    location /api/ {
        proxy_pass http://tomcat_upstream;
        proxy_http_version 1.1;           # keep-alive에 필요
        proxy_set_header Connection "";   # "close" 전파 방지
    }
}
```

```yaml
# Spring Boot(내장 Tomcat) — 유휴 타임아웃을 Nginx보다 넉넉하게
server:
  tomcat:
    keep-alive-timeout: 75000   # Nginx의 재사용 기대 시간보다 길게
```

### (3) 체인 전체의 타임아웃 정렬 (가산점 포인트)

실제 경로는 `클라이언트 → (CDN/LB) → Nginx → Tomcat`으로 더 길다.
원칙은 **바깥 계층의 대기 상한이 안쪽에서 걸리는 일의 최악 합보다
길어야 한다**는 것 — 안쪽이 아직 일하는데 바깥이 먼저 끊으면 (1)의
유령 성공이 계층 수만큼 반복될 수 있다. 이는 07-traffic-performance의
"타임아웃 예산"과 같은 산수의 계층 스택 버전이다: 사용자 응답 SLO에서
출발해 바깥에서 안으로 예산을 나눠준다.

또 하나의 함정: `proxy_next_upstream` 설정에 따라 Nginx는 실패한
요청을 **다음 upstream 서버로 재전송**할 수 있다. 타임아웃까지
재시도 조건에 넣으면 "이미 처리 중일 수도 있는" 비멱등 요청(POST)이
다른 서버에서 한 번 더 실행될 수 있다 — 프록시 계층의 재시도도
애플리케이션 재시도와 똑같이 멱등성 검토가 필요하다.

## 3. 버퍼/크기 불일치 — 특정 크기에서만 실패하는 업로드

### (1) client_max_body_size vs 앱의 multipart 한도 → 413

Nginx의 `client_max_body_size`(기본 **1MB**)를 넘는 요청 본문은
Tomcat에 도달하기 전에 **413 Request Entity Too Large**로 반려된다.
Spring의 multipart 한도만 늘려놓고 Nginx를 잊으면 "작은 파일은 되는데
큰 파일만 실패하고, 앱 로그엔 아무것도 없는" 상태가 된다. 반대로
Nginx만 크게 열고 Spring 한도가 작으면 이번엔 앱에서 예외가 난다 —
**한도는 전 계층에서 일관되게** 맞춰야 한다.

```nginx
# Before: 기본값 1m — 프로필 이미지 2MB 업로드가 413으로 반려 (앱 로그 없음)
# After: 서비스 요구 크기 + 여유로 명시
server {
    client_max_body_size 20m;
}
```

```yaml
# Spring 쪽 한도도 같은 기준으로 정렬
spring:
  servlet:
    multipart:
      max-file-size: 20MB
      max-request-size: 20MB
```

점검 순서를 체득해두면 좋다: 업로드가 크기 의존적으로 실패하면
경로상의 모든 크기 한도(CDN/LB → Nginx → Tomcat/Spring)를 바깥에서
안쪽으로 확인한다.

### (2) proxy_buffer_size vs 큰 응답 헤더 → 502

Nginx는 upstream 응답의 **헤더**를 `proxy_buffer_size` 한 조각에
담는다. 응답 헤더가 이보다 크면(대형 쿠키, 토큰을 헤더로 내려주는
경우 등) error log에 `upstream sent too big header`를 남기고 502가
된다. "로그인한 특정 사용자만 502"처럼 데이터 의존적으로 나타나는
전형적인 유령 현상 — 헤더에 뭘 실어 보내는지가 인프라 설정과 충돌하는
사례다.

### (3) 응답 버퍼링 vs 스트리밍 응답 → 끊기는 SSE, 디스크 임시파일

`proxy_buffering on`(기본)은 느린 클라이언트로부터 Tomcat을 지키는
좋은 기본값이지만(12번 문서), **응답을 즉시 흘려보내야 하는
스트리밍**(SSE, 대용량 다운로드 스트림)과는 상충한다:

- SSE: Nginx가 버퍼를 채울 때까지 이벤트를 붙들고 있어 실시간성이
  깨지거나 아예 전달이 안 된다.
- 버퍼 초과분은 디스크 임시 파일로 내려가므로, 대용량 응답이 많으면
  Nginx 디스크 I/O가 병목이 된다.

```nginx
# SSE 경로만 버퍼링 해제 (전역 해제는 버퍼링의 보호 효과를 버리는 것)
location /api/notifications/stream {
    proxy_pass http://tomcat_upstream;
    proxy_buffering off;
    proxy_read_timeout 3600s;   # 장수 커넥션 — 유휴 상한도 함께 재검토
}
```

앱에서 응답 헤더 `X-Accel-Buffering: no`를 내려 경로별로 제어할 수도
있다 — 인프라 설정 변경 없이 앱이 스스로 선언하는 방식이라는 점에서
협업 비용이 낮다.

## 4. 진단 관점 — error log 메시지가 불일치의 지문이다

502/504가 났을 때 Nginx error log의 문구가 어느 불일치인지 바로
알려준다:

| error log 문구 | 의심 지점 |
|---|---|
| `upstream timed out ... while reading response header` | proxy_read_timeout < 처리 시간 (504) |
| `upstream prematurely closed connection` | keep-alive 경쟁 or Tomcat 프로세스 죽음 (502) |
| `connect() failed ... Connection refused` | Tomcat 다운/포트 불일치 (502) |
| `upstream sent too big header` | proxy_buffer_size < 응답 헤더 (502) |
| `client intended to send too large body` | client_max_body_size 초과 (413) |

access log에 `$upstream_response_time`과 `$upstream_status`를 남겨두면
"Tomcat이 느렸던 것"과 "Nginx가 못 기다린 것"을 숫자로 구분할 수 있다.

## 5. 꼬리질문 대비 포인트

### "간헐적으로 502가 나는데 Tomcat 메트릭은 멀쩡합니다. 뭘 의심하겠어요?"

먼저 Nginx error log의 문구를 본다. `upstream prematurely closed`라면
keep-alive 유휴 타임아웃 경쟁(Tomcat이 닫는 순간 Nginx가 재사용)을
의심하고, Tomcat의 keep-alive 타임아웃을 Nginx의 재사용 기대보다 길게
정렬한다. 배포 시점과 겹친다면 graceful shutdown 미비(처리 중 커넥션을
물고 종료)도 후보다. 핵심은 "Tomcat이 멀쩡해 보여도 두 계층 사이
커넥션 수명 관리의 문제일 수 있다"는 방향 전환이다.

### "Nginx가 504를 반환한 뒤 Tomcat에서 처리 중이던 요청은 어떻게 되나요?"

그대로 끝까지 실행된다. 타임아웃은 Nginx의 기다림을 끊을 뿐 Tomcat의
처리를 중단시키지 않는다. 그래서 사용자가 본 실패와 실제 결과가
어긋나는 유령 성공이 생기고, 사용자 재시도가 겹치면 중복 처리가 된다.
방어는 애플리케이션 레벨 멱등성(멱등 키)이며, 이것이 "타임아웃 뒤
재시도는 멱등성과 세트"라는 원칙이 프록시 계층에도 적용되는 이유다.

### "업로드가 10MB 근처에서만 실패한다는 제보를 받으면 어떤 순서로 봅니까?"

크기 의존적 실패는 경로상 어딘가의 크기 한도다. 바깥에서 안쪽으로 —
CDN/LB의 본문 한도, Nginx `client_max_body_size`, Spring multipart
`max-file-size`/`max-request-size` — 를 순서대로 확인한다. 사용자가
받은 상태 코드(413이면 프록시 계열, 500이면 앱 예외 가능성)와 앱 로그
유무(없으면 앱 도달 전 반려)가 어느 계층인지 좁혀준다. 근본적으로는
파일 크기 요구사항이 바뀔 때 전 계층 한도를 함께 바꾸는 체크리스트가
있어야 재발을 막는다.

### "계층별 타임아웃 값은 어떤 원칙으로 정하나요?" (시니어 변별 포인트)

방향이 핵심이다: **클라이언트에 가까운 바깥 계층일수록 대기 상한이
길어야 하고, 안쪽에서 일어나는 일(재시도 포함)의 최악 합이 바깥 예산
안에 들어와야 한다.** 바깥이 먼저 끊으면 안쪽의 일이 유령 성공이 되기
때문이다. 값 자체는 감이 아니라 안쪽 처리 시간의 p99 관측치 + 여유로
정하고, 반대로 keep-alive 같은 "유휴 커넥션 수명"은 방향이 뒤집힌다 —
커넥션을 들고 있는 안쪽(Tomcat)이 재사용하는 바깥(Nginx)보다 늦게
닫아야 경쟁이 없다. "대기 상한은 바깥이 길게, 유휴 수명은 안쪽이
길게"로 두 규칙을 구분해 말하면 이 주제를 정리해 본 사람으로 보인다.

### "proxy_buffering은 끄는 게 좋은가요, 켜는 게 좋은가요?" (가산점 포인트)

기본은 켠다 — 느린 클라이언트로부터 Tomcat 스레드를 격리하는 보호
장치이기 때문이다. 끄는 것은 즉시성이 필요한 특정 경로(SSE, 스트리밍
다운로드)에 한해 location 단위로 한다. 전역으로 끄면 응답 전송이
클라이언트 속도에 묶여 Tomcat 스레드 점유 시간이 늘어난다.
`X-Accel-Buffering` 헤더로 앱이 경로별로 선언하는 방법까지 말하면
인프라와 앱의 협업 방식을 아는 것으로 보인다.

---

## 한 줄 요약

Nginx와 Tomcat은 서로의 설정을 모르는 채 각자의 타임아웃·버퍼·크기
한도를 적용하므로, 어긋난 값 사이에서 유령 현상(504 후 유령 성공,
keep-alive 경쟁의 간헐적 502, 특정 크기에서만 실패하는 업로드)이
생긴다 — 대기 상한은 바깥 계층이 안쪽보다 길게, 유휴 커넥션 수명은
안쪽이 바깥보다 길게, 크기 한도는 전 계층 일관되게 정렬하고, Nginx
error log의 문구를 불일치의 지문으로 읽는 것이 초동 대응의 핵심이다.
