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
- **3. JPA/ORM**: 기본 ⭐ 7/7 완료 ✅ — 중급 ⭐⭐ 0/12, 고난이도 ⭐⭐⭐ 0/4, +α 0/4
- 4~26: 미시작

### 2026-08-05 세션 #5 (3장 JPA/ORM 기본⭐)
- 3장 기본 ⭐ 7문항 전부 완료: JPA vs MyBatis, 영속성 컨텍스트/dirty checking, EAGER vs LAZY, N+1, merge vs dirty checking, 연관관계의 주인·mappedBy, LazyInitializationException.
- 평가 분포: **상 1**(주인·mappedBy), **중 5**(JPA vs MyBatis, 영속성 컨텍스트, EAGER/LAZY, N+1, LazyInitializationException — 마지막은 상 경계), **하 1**(merge).
- 강점: ① 개념 정의의 정확도가 높다 ② **조건을 되묻는 습관**("readOnly인가 default인가", "어떤 merge인가", "수정 요청인가") — 세션 #1~2의 역질문 능력과 같은 축 ③ **세션 후반으로 갈수록 자기 교정이 나온다**(EAGER 기본값 → 주인 논리 재구성 → 반론 없이 스스로 EAGER 처방 철회). 특히 마지막 문항에서 해결책마다 비용을 자발적으로 병기한 것은 1~2장에서 반복 지적된 "트레이드오프 한쪽만 서술" 패턴이 처음 깨진 지점.
- 약점: ① **품질을 시스템으로 고정해본 경험이 없다** — 유령 UPDATE 진단(Q2)과 N+1 자동 탐지(Q4) 모두 "잘 모르겠다". 세션 #4의 "진단 방법론 레퍼토리 부재"와 **정확히 같은 공백**이며 3장 최우선 보완 대상 ② **자주 쓰는 API의 내부 분기를 모른다** — `save()`의 persist/merge(Q5), `@ManyToOne` 기본값(Q3). 관례로 정답 코드를 써왔으나 이유를 모르는 구조 ③ OSIV 완전 미인지(중급 단독 문항에서 재검증).
- knowledge 문서 7건(03-jpa-orm 전체): jpa-vs-mybatis, persistence-context-dirty-checking, eager-vs-lazy-fetch-strategy, n-plus-one-detection-and-fixes, merge-vs-dirty-checking, association-owner-and-mappedby, lazy-initialization-exception. 앞 4건은 에이전트 위임, 뒤 3건은 API 529 반복 실패로 면접관이 직접 작성.
- 에이전트 위임 부산물 — **통설 교정 5건**: BigDecimal scale 불일치는 dirty 원인이 아님(`BigDecimalJavaType.areEqual`이 `compareTo` 기준) / `jakarta.persistence.fetchgraph`로 EAGER 재정의 가능(Hibernate 5.5+) / `com.vladmihalcea:db-util` 2022년 종료 → `io.hypersistence:hypersistence-utils` / `MultipleBagFetchException`은 bag 전용·쿼리 실행 시점·JPA 경로에서 `IllegalArgumentException`으로 래핑 / N+1의 N은 결과 행 수가 아니라 미해결 연관 id 수(→ 건수만 늘린 픽스처로는 재현 안 됨).
- 다음 세션: 3장 중급 ⭐⭐부터(fetch join+페이징). OSIV 문항과 벌크 연산 문항에서 위 약점 ①이 재검증된다.

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
