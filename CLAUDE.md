# knowledge-forge

지식을 담금질해 내 것으로 만드는 프로젝트. 모의면접은 학습 도구이고, 목적은 지식 기반의 성장이다. 지금은 백엔드 중심이지만 추후 다른 도메인 지식도 다룬다. (dop-iam 저장소에서 2026-07-25 분리)

## 구조

| 경로 | 용도 |
|---|---|
| `interview-questions/questions/` | 질문지 — 섹션별 파일 `NN-슬러그.md` (26개 섹션, ~507문항). 목차: `README.md` |
| `interview-questions/rationale/` | 출제 의도 문서 — 질문지와 같은 파일명으로 1:1 대응 |
| `interview-questions/interview-state.md` | 면접 진행 상태 (재개 지점) |
| `interview-questions/knowledge/` | 학습 지식 문서 (26개 카테고리: 01-java-kotlin ~ 26-auth-session) |
| `interview-questions/knowledge-web/` | knowledge 문서의 학습용 웹 버전 (HTML, 1:1 매핑). 빌드 변환이 아니라 `knowledge-web-designer` 에이전트가 md를 바탕으로 가독성·암기 중심으로 재구성해 직접 작성 |
| `interview-questions/transcript/` | 섹션별 문답 기록 + 약점 노트 |
| `.claude/skills/interview/` | 모의면접 스킬 — "면접 연습하자" 또는 `/interview`로 시작 |

## 규칙

- 새 knowledge 문서는 해당 카테고리 디렉토리에 저장한다.
- 기술 설명은 전문용어를 풀어서 쓰고 before/after 코드 예시를 곁들인다.
