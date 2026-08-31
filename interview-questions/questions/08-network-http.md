# 8. 네트워크 / HTTP / 웹

## 기본 ⭐

- 브라우저에 URL을 입력했을 때 일어나는 일을 설명해주세요. (DNS → TCP → TLS → HTTP)
- TCP 3-way handshake와 4-way handshake(종료)를 설명해주세요.
- TCP와 UDP의 차이는?
- HTTP 메서드별 멱등성과 안전성(safe)을 설명해주세요.
- HTTP 상태 코드: 200/201/204, 301/302, 400/401/403/404/409, 500/502/503/504의 의미와 사용 기준은?
- HTTPS(TLS) handshake 과정을 설명해주세요. 대칭키와 비대칭키는 각각 어디에 쓰이나요?
- 쿠키와 세션, 토큰 기반 인증의 차이는?
- CORS란 무엇이고 preflight 요청은 왜 필요한가요?

## 중급 ⭐⭐

- HTTP/1.1, HTTP/2, HTTP/3의 차이(HOL blocking 관점)를 설명해주세요.
- keep-alive와 커넥션 풀은 왜 중요한가요? `TIME_WAIT`이 대량 발생하는 원인과 대응은?
- 502와 504의 차이 — 각각 발생했을 때 어디를 먼저 봐야 하나요?
- Nginx의 역할(reverse proxy, 정적 서빙, 버퍼링, LB)과 이벤트 기반 아키텍처를 설명해주세요.
- Nginx와 Tomcat 사이의 타임아웃/버퍼 설정 불일치로 생길 수 있는 문제는?
- 웹소켓과 SSE, 폴링의 차이와 선택 기준은?
- 대용량 파일(이미지) 업로드/다운로드 시 서버 설계 고려사항은? (스트리밍, presigned URL)

## 고난이도 ⭐⭐⭐

- L4와 L7 로드밸런서의 차이와, 각각에서 가능한 라우팅/장애 감지 방식은?
- TLS termination을 어디서 할지(LB vs 애플리케이션)의 트레이드오프는?
- 특정 사용자만 간헐적으로 timeout이 발생합니다. 네트워크 계층에서 어떻게 추적하나요? (tcpdump, MTU, retransmission)
- DNS TTL과 배포/failover의 관계 — DNS 기반 트래픽 전환의 함정은?

## 알면 좋은 +α

- HTTP 캐싱 헤더(Cache-Control, ETag, Last-Modified)와 304 응답 흐름을 설명해주세요. CDN 캐시 제어와는 어떻게 연결되나요?
- 응답 압축(gzip/brotli)의 트레이드오프는? 압축하지 말아야 할 응답은?
- 프록시/LB 뒤에서 실제 클라이언트 IP는 어떻게 얻나요? `X-Forwarded-For`를 그대로 믿으면 안 되는 이유는?
