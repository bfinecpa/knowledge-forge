# 면접 집계 / 횡단 정보

> 세션 로그와 완료 현황만. 문답 전문·평가·메모·약점 노트는 각 섹션 파일(`NN-*.md`)에.
> 재개 지점은 `../interview-state.md`.

## 세션 로그

### 2026-07-13 세션 #1
- 1장 Java/Kotlin 기본 ⭐ 9문항 + 중급 ⭐⭐ 2문항(G1vsZGC, GC튜닝) 진행.
- 평가 분포(기본): 상 5(JVM메모리, GC, equals/hashCode, final, Checked/Unchecked), 중 3(인터페이스vs추상클래스, Java8+실무, String불변성), 하 1(enum).
- 중급: G1vsZGC 상, GC튜닝 상.
- 강점: 메커니즘 사고·역질문 능력(조기승격 추론, colored pointer/load barrier 재구성, 스트림 전제/N+1 반문). 운영 감각(트랜잭션 롤백, Metaspace 누수, 누수vs트래픽 판별).
- 약점: 실무 남용 사례(Stream)·트레이드오프 근거(상속vs합성) 서술 약함. enum 고급 패턴·StringBuilder/Buffer 미숙. OOM 문구 즉시 판독.

## 완료 현황

- **1. Java/Kotlin**: 전체 완료 ✅✅ — 기본 ⭐ 9/9, 중급 ⭐⭐ 13/13, 고난이도 ⭐⭐⭐ 6/6, +α 4/4 (총 32문항).
- **2. Spring**: 전체 완료 ✅✅ — 기본 ⭐ 9/9, 중급 ⭐⭐ 12/12, 고난이도 ⭐⭐⭐ 7/7, +α 7/7 (총 35문항).
- 3~26: 미시작

### 2026-07-20 세션 #4 (2장 마무리)
- 2장 잔여 완료: 고난이도 ⭐⭐⭐ 3~7번(트랜잭션 동기화, 풀 크기 산정, HikariCP 고갈 진단, WebFlux vs MVC, graceful shutdown) + +α 7문항 전부.
- 평가 분포: 고난이도 — 중 4(트랜잭션 동기화, 풀 산정, 고갈 진단(하 경계), graceful), 하 1(WebFlux). +α — 상 1(AI 코드 트랜잭션 체크리스트), 중 3(@Value/@ConfigurationProperties, ArgumentResolver(상 경계 2)), 하 3(Actuator, Security 필터 체인, 기동 시간 진단, @Scheduled 중 3개... 정확히는 하 4: Actuator/Security체인/기동진단/@Scheduled).
- 강점: **세션 내 학습 전이가 뚜렷** — AFTER_COMMIT 자발 수렴(Q24), Little's law 획득 후 정확 재배정(Q25), 마지막 체크리스트(Q35)에서 세션 전체가 응집되어 최고 수행. ThreadLocal 패턴 연결(Q33).
- 약점: ① 블로킹/논블로킹 스레딩 모델 구분(Q25 오개념·Q27 포기) ② 진단 방법론 레퍼토리 부재 — "무엇을 떠서 볼지"(스레드 덤프, leakDetectionThreshold, startup 계측)가 Q26·Q32에서 반복 공백 ③ Security 필터 체인 — Q6에 이어 Q31도 포기, IAM 종사자로서 최우선 보완 ④ AI 위임 답변(Q32 "AI한테 시킨다")이 진단 모델 부재와 결합될 때 가장 취약 — 세션 #1~2의 태도 관찰과 동일 맥락.
- 이번 세션부터 knowledge 문서화를 에이전트 위임으로 진행: 02-spring에 8건 신규(transaction-synchronization, pool-sizing, hikaricp-exhaustion, webflux-vs-mvc, graceful-shutdown, value-vs-configprops, actuator, argument-resolver, scheduled-threading — 9건).
- 다음 세션: 3장 JPA/ORM 기본⭐부터. 2장 약점 노트 재도전(특히 Security 체인·진단 방법론)도 후보.

### 2026-07-14~15 세션 #2
- 1장 잔여 전부 완료: 중급 6문항 + 고난이도 6문항 + +α 4문항.
- 평가 분포: 중급 잔여 — 상 1(static SDF), 중 3(Optional, try-with-resources, 방어적복사), 하 2(parallelStream, 타입소거). 고난이도 — 상 4(JIT, 동기화도구, false sharing, Virtual Thread), 중 1(OOM힙덤프), 하 1(데드락). +α — 상 1(record), 중 1(Integer캐싱), 하 2(참조3종, BigDecimal).
- 강점: **고난이도에서 오히려 강함** — 원리 추론(탈최적화=다형성 가정 붕괴, LongAdder 설계 자력 도출, false sharing 힌트 1개로 재구성), Virtual Thread는 1장 최고 완성도. 신기술을 제약으로 검토(커넥션 풀 상한 소멸·ThreadLocal 메모리). static SDF에서 역질문→기준 수립.
- 약점: 도구·관용구·용어 층 — commonPool, TypeReference, unmodifiableList/copyOf, leakDetectionThreshold, retained/dominator, 데드락 4조건, 참조 3종, BigDecimal scale 전부 미접촉. "테스트 통과형 잠복 버그" 유형화가 SDF에선 됐지만 Integer 캐싱에선 안 나옴(일관성 미흡).
- 다음 세션: 2장 Spring 기본부터. 1장 약점 노트 재도전도 후보.
- 태도 관찰(2회째): "암기성 질문은 AI한테 물어보면 되는데 왜 묻나" 문제 제기 — 세션1의 "OOM 문구 AI 검색" 발언과 동일 주제. 면접관이 rationale 6원칙(상황 인지·장애 실시간 판단·검색 색인으로서의 어휘)으로 답변함. 지식 계층에 대한 본인 나름의 기준이 있는 것 — 실무 태도로는 합리적이나, 면접 상황에서는 "모른다" 대신 방어로 보일 위험을 본인이 인지할 필요.
