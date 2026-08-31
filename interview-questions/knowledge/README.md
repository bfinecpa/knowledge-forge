# knowledge 패키지 구조

`../questions/`의 26개 섹션 파일과 1:1로 대응한다 (같은 파일명).
새 문서는 해당 질문이 속한 카테고리 디렉토리에 저장할 것.

| 디렉토리 | 면접 질문 카테고리 |
|---|---|
| `01-java-kotlin` | 1. Java / Kotlin 언어 |
| `02-spring` | 2. Spring / Spring Boot |
| `03-jpa-orm` | 3. JPA / ORM |
| `04-rdb-sql` | 4. RDB / SQL / 데이터 모델링 |
| `05-redis-caching` | 5. Redis / 캐싱 |
| `06-kafka-messaging` | 6. Kafka / 메시징 / 이벤트 기반 아키텍처 |
| `07-traffic-performance` | 7. 대용량 트래픽 / 성능 최적화 |
| `08-network-http` | 8. 네트워크 / HTTP / 웹 |
| `09-rest-api` | 9. REST API 설계 |
| `10-payment-consistency` | 10. 결제 / 정합성 (도메인 심화) |
| `11-spring-batch` | 11. Spring Batch / 배치 처리 |
| `12-nosql` | 12. NoSQL / 데이터 다양성 |
| `13-architecture` | 13. 아키텍처 / 설계 |
| `14-operations-observability` | 14. 운영 / 장애 대응 / 관측성 |
| `15-container-infra` | 15. 컨테이너 / 인프라 (Docker, Kubernetes) |
| `16-security` | 16. 보안 |
| `17-test-quality` | 17. 테스트 / 코드 품질 |
| `18-async-nonblocking` | 18. 비동기 / Non-blocking 프로그래밍 |
| `19-cs-fundamentals` | 19. CS 기초 (운영체제 / 자료구조) |
| `20-experience-scenario` | 20. 경험 기반 / 시나리오 질문 (기술 태도) |
| `21-system-design` | 21. 시스템 설계 (화이트보드 대비) |
| `22-global-i18n` | 22. 글로벌 서비스 / 국제화 (시간, 인코딩, 규제) |
| `23-build-cicd` | 23. 빌드 / CI·CD / 형상관리 |
| `24-ai-tools` | 24. AI 도구 활용 / 성장 방식 |
| `25-senior-differentiation` | 25. 시니어 잣대 대응 (연차 이상의 변별 질문) |
| `26-auth-session` | 26. 인증 / 인가 / 세션 (이력 기반 심화) |

## 문서 형식

- 파일명: 주제 기반 kebab-case (예: `bigdecimal-equals-compareto.md`)
- 상단에 `> 핵심 관전 포인트:` 인용 블록 — 면접에서 첫 답변으로 말할 요약
- 본문은 번호 섹션, before/after 코드 예시, 꼬리질문 대비 포인트 포함
- 마지막에 "한 줄 요약" 섹션
