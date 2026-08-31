# 백엔드 면접 기술 질문 리스트 (콘텐츠 플랫폼/대용량 트래픽 포지션 대비)

> 대상: Java/Kotlin + Spring Boot 기반 웹 서비스 백엔드
> 공고 키워드: 대용량 트래픽, 결제/콘텐츠 연동, Redis/Kafka/Spring Batch, RESTful API, RDB, 컨테이너
> 난이도 표기: ⭐ 기본 / ⭐⭐ 중급 / ⭐⭐⭐ 고난이도

## 섹션 목차

- [1. Java / Kotlin 언어](01-java-kotlin.md)
- [2. Spring / Spring Boot](02-spring.md)
- [3. JPA / ORM](03-jpa-orm.md)
- [4. RDB / SQL / 데이터 모델링](04-rdb-sql.md)
- [5. Redis / 캐싱](05-redis-caching.md)
- [6. Kafka / 메시징 / 이벤트 기반 아키텍처](06-kafka-messaging.md)
- [7. 대용량 트래픽 / 성능 최적화](07-traffic-performance.md)
- [8. 네트워크 / HTTP / 웹](08-network-http.md)
- [9. REST API 설계](09-rest-api.md)
- [10. 결제 / 정합성 (도메인 심화)](10-payment-consistency.md)
- [11. Spring Batch / 배치 처리](11-spring-batch.md)
- [12. NoSQL / 데이터 다양성](12-nosql.md)
- [13. 아키텍처 / 설계](13-architecture.md)
- [14. 운영 / 장애 대응 / 관측성](14-operations-observability.md)
- [15. 컨테이너 / 인프라 (Docker, Kubernetes)](15-container-infra.md)
- [16. 보안](16-security.md)
- [17. 테스트 / 코드 품질](17-test-quality.md)
- [18. 비동기 / Non-blocking 프로그래밍](18-async-nonblocking.md)
- [19. CS 기초 (운영체제 / 자료구조)](19-cs-fundamentals.md)
- [20. 경험 기반 / 시나리오 질문 (기술 태도)](20-experience-scenario.md)
- [21. 시스템 설계 (화이트보드 대비)](21-system-design.md)
- [22. 글로벌 서비스 / 국제화 (시간, 인코딩, 규제)](22-global-i18n.md)
- [23. 빌드 / CI·CD / 형상관리](23-build-cicd.md)
- [24. AI 도구 활용 / 성장 방식](24-ai-tools.md)
- [25. 시니어 잣대 대응 (연차 이상의 변별 질문)](25-senior-differentiation.md)
- [26. 인증 / 인가 / 세션 (이력 기반 심화)](26-auth-session.md)

---

## 준비 팁

1. **모든 "고난이도" 질문은 정답보다 사고 과정**을 본다 — 트레이드오프를 양쪽 다 말하고, 본인의 선택 기준을 명확히.
2. **경험 질문은 STAR 구조**(상황-과제-행동-결과)로, 반드시 수치(TPS, latency, 절감률)를 준비.
3. 공고 도메인(콘텐츠, 결제, 글로벌) 특성상 **멱등성, 정합성, 스파이크 트래픽** 관련 질문은 거의 확실히 나온다 — 10, 5, 7장을 집중 준비.
4. "모르는 것"을 물어보면 아는 지점까지 설명하고 추론하는 모습을 보여줄 것 — 침묵이나 즉답 포기가 최악.
5. 꼬리 질문에 대비해 본인이 말한 모든 키워드는 한 단계 더 깊이 설명할 수 있어야 한다.
6. **답변의 3단계 등급을 의식하라** — ① 안다(개념 설명) ② 겪었다(증상·삽질·트레이드오프) ③ 체계를 만들었다(재발 방지를 팀 자산으로). 공고 연차보다 높은 잣대가 적용될 수 있으므로, 주력 3~4개
   주제는 반드시 ③단계 답을 준비할 것. (상세: [`../rationale/25-senior-differentiation.md`](../rationale/25-senior-differentiation.md))
