# SSRF (Server-Side Request Forgery) — 서버를 프록시로 삼아 내부망을 뚫는 공격

> 핵심 관전 포인트: SSRF는 **공격자가 서버를 속여, 서버가 대신 HTTP 요청을 보내게** 만드는 공격이다. 위력의 원천은 **신뢰 위치의 차이** — 공격자 본인은 못 가는 내부망·localhost·클라우드
> 메타데이터 서버라도 **서버는 갈 수 있다**. 그래서 "이 URL 좀 가져와 줘" 기능(이미지 프록시, 웹훅, PDF 렌더러, URL 프리뷰)에 사용자 URL을 검증 없이 태우면, 방화벽이 막지 못하는
> **서버→내부** 경로가 그대로 뚫린다. 방어는 **allowlist + 사설 IP 차단 + 리다이렉트 금지 + 메타데이터 보호(IMDSv2)**.

## 0. 질문 + 의도

**질문**: "SSRF가 무엇이고, 왜 방화벽·내부망 분리만으로는 막지 못하나? 어떻게 방어하나?"

**출제 의도**: 네트워크 경계(방화벽) 방어의 한계를 이해하는지, 그리고 "사용자가 준 URL을 서버가 그대로 호출"하는 흔한 패턴이 왜 위험한지 아는지 확인한다. actuator·메타데이터 서버 같은 실제 표적과 연결해 설명할 수 있으면 깊이가 드러난다.

## 1. 무엇인가 — 신뢰 위치를 훔쳐 쓰는 공격

방화벽은 보통 **외부 → 내부** 방향을 막는다. 하지만 **서버 → 내부**는 정상 트래픽이라 막지 않는다. SSRF는 바로 이 틈을 노린다. 공격자가 직접 내부망에 접근하는 대신, **내부망에 접근할 수 있는 서버에게 요청을 시키는 것**이다.

취약한 코드는 대부분 이렇게 생겼다 — 사용자가 준 URL을 검증 없이 서버가 직접 호출한다.

```java
// ❌ 취약: 사용자 입력 URL을 그대로 서버가 요청
@GetMapping("/fetch-image")
public byte[] fetchImage(@RequestParam String url) {
    return restTemplate.getForObject(url, byte[].class);   // 서버가 요청을 보냄
}
```

정상 사용과 공격 사용은 **입력 URL만** 다르다.

```
# 정상
GET /fetch-image?url=https://cdn.example.com/cat.jpg

# 공격 ①: 외부에선 막힌 actuator를 서버 자신을 통해 호출
GET /fetch-image?url=http://localhost:9292/actuator/heapdump

# 공격 ②: 내부망의 다른 서버 (방화벽은 외부→내부만 막지, 서버→내부는 안 막음)
GET /fetch-image?url=http://192.168.0.10:6379/          # 내부 Redis

# 공격 ③: 클라우드 메타데이터 서버 → 임시 자격증명 탈취 (가장 악명 높음)
GET /fetch-image?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

## 2. 왜 위험한가 — 표적별로

- **내부 관리 도구 우회**: 외부에 막혀 있어도 서버 자신(`localhost`)이나 내부망 IP로는 열려 있는 것들 — actuator(`/env`, `/heapdump`), 어드민 콘솔, 내부 API. 네트워크 위치로만 숨긴 방어가 SSRF 한 방에 무력화된다.
- **클라우드 메타데이터 서버(`169.254.169.254`)**: AWS/GCP 등에서 인스턴스가 자기 정보와 **IAM 임시 자격증명(access key)**을 받는 링크-로컬 주소. SSRF로 여기서 자격증명을 빼내면 클라우드 계정 자체가 털린다. **2019년 Capital One 대형 유출**의 핵심 수법이 정확히 이것이었다(WAF 서버의 SSRF → 메타데이터 → S3 접근).
- **포트 스캔·내부 정찰**: 응답 시간·에러 메시지 차이로 내부망에 어떤 서비스가 떠 있는지 훑을 수 있다.

## 3. actuator 문서와 이어지는 지점

[actuator-endpoints-security.md](../02-spring/actuator-endpoints-security.md)에서 heapdump·env를 "관리 포트 분리(내부망 제한)"로 숨겨도, **앱에 SSRF 취약점이 하나 있으면 그 방어가 우회된다.** 공격자가 직접 `/actuator/heapdump`를 못 불러도, SSRF로 서버에게 `http://localhost:9292/actuator/heapdump`를 부르게 시키면 그만이기 때문이다. 이것이 actuator 방어를 **네트워크 제한만으로 끝내지 않고 인증까지 겹으로 거는(3중 방어)** 이유다 — 네트워크 위치만 믿으면 SSRF에 뚫린다.

## 4. 방어 방법

1. **allowlist(허용 목록)** — 사용자 URL을 그대로 쓰지 말고, 허용된 도메인/IP만 통과시킨다. 블랙리스트(차단 목록)는 우회 표현(`0x7f.0.0.1`, `2130706433`, DNS rebinding 등)이 많아 뚫린다. 반드시 **화이트리스트**로.
2. **사설·링크로컬 IP 대역 차단** — DNS 해석 **결과 IP**를 검사해 `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`(메타데이터!)로 향하면 거부한다. 문자열이 아니라 실제 해석된 IP를 봐야 함(DNS rebinding 방지).
3. **리다이렉트 따라가기 비활성화** — allowlist를 통과한 뒤 `302`로 내부 주소로 튕기는 우회를 막는다.
4. **클라우드 메타데이터 보호** — AWS라면 **IMDSv2 강제**(토큰을 먼저 받아야 조회 가능하게 만들어, 단순 GET 하나로는 자격증명이 안 나오도록). 필요 없으면 메타데이터 접근 자체를 hop limit=1로 제한.
5. **응답을 그대로 돌려주지 않기** — 가져온 콘텐츠를 사용자에게 원문 그대로 노출하면 내부 정보가 새므로, 필요한 형태로만 가공해 반환.

```java
// ✅ 방어: 해석된 IP를 allowlist/사설대역으로 검증 후 요청, 리다이렉트 금지
URI target = URI.create(url);
InetAddress addr = InetAddress.getByName(target.getHost());   // 실제 IP 해석
if (addr.isLoopbackAddress() || addr.isSiteLocalAddress()
        || addr.isLinkLocalAddress() || !ALLOWED_HOSTS.contains(target.getHost())) {
    throw new IllegalArgumentException("허용되지 않은 대상");
}
// RestTemplate/HttpClient는 followRedirects=false 로 설정
```

## 5. 꼬리질문 대비 포인트

- **"방화벽이 있는데 왜 못 막나?"** — 방화벽은 외부→내부를 막지만 SSRF는 **서버→내부**를 이용한다. 서버는 이미 경계 안에 있으니 방화벽 뒤를 자유롭게 다닌다.
- **"블랙리스트로 사설 IP만 막으면 안 되나?"** — `127.0.0.1`을 `0x7f.0.0.1`·`017700000001`·`2130706433`로 쓰거나, allowlist 통과 도메인을 사설 IP로 재해석시키는 **DNS rebinding**으로 우회된다. 그래서 **해석된 IP 검증 + allowlist**가 정석.
- **"어디에 잘 생기나?"** — URL을 입력받아 서버가 가져오는 모든 곳: 이미지/파일 프록시, 웹훅(webhook) 등록, URL 미리보기(OG 태그 파싱), 서버사이드 PDF/HTML 렌더러, 외부 API 콜백 URL.

## 한 줄 요약

SSRF는 **"서버야, 이 주소로 요청 좀 보내줘"를 공격자가 시킬 수 있을 때, 서버의 네트워크 위치와 권한을 훔쳐 내부망·localhost·클라우드 메타데이터(`169.254.169.254`)를 치는** 공격이다. 방화벽으로는 못 막으므로(서버→내부는 열려 있음) **allowlist + 해석 IP 기반 사설대역 차단 + 리다이렉트 금지 + IMDSv2**로 방어하고, actuator 같은 내부 자산은 네트워크 제한 위에 **인증**을 한 겹 더 얹는다.
