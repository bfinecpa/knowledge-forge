# 15. 컨테이너 / 인프라 (Docker, Kubernetes)

## 기본 ⭐

- 컨테이너와 VM의 차이는? Docker 이미지와 컨테이너의 관계는?
- Dockerfile 작성 시 이미지 크기와 빌드 캐시를 최적화하는 방법은? (멀티 스테이지 빌드)
- Kubernetes의 Pod, Deployment, Service 개념을 설명해주세요.

## 중급 ⭐⭐

- 컨테이너 환경에서 JVM 힙 설정 시 주의점은? (컨테이너 메모리 한계 인식)
- K8s의 requests/limits는 무엇이고, limit 초과 시 무슨 일이 벌어지나요? (OOMKilled, CPU throttling)
- HPA(오토스케일링)는 어떤 지표로 트리거하나요? 스케일아웃이 트래픽 스파이크를 못 따라갈 때는?
- 롤링 업데이트 중 트래픽 유실이 없으려면 어떤 설정들이 맞물려야 하나요? (readiness, preStop, graceful shutdown)

## 고난이도 ⭐⭐⭐

- 특정 Pod만 latency가 높은 현상 — 노드 레벨(noisy neighbor, CPU throttling)에서의 원인 추적 방법은?
- Stateful 워크로드(DB, Kafka)를 K8s에서 운영하는 것에 대한 견해는?
- 서비스 메시(Istio 등)가 해결하는 문제와 도입 비용에 대한 판단 기준은?

## 알면 좋은 +α

- 컨테이너에서 로그를 파일이 아니라 stdout으로 남기는 이유는?
- ConfigMap/Secret을 변경하면 실행 중인 Pod에 어떻게 반영되나요? 주의점은?
- PodDisruptionBudget은 무엇이고, 노드 점검(drain) 시 서비스를 어떻게 보호하나요?
