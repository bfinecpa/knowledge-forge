# 3. JPA / ORM

## 기본 ⭐

- JPA를 사용하는 이유는? SQL Mapper(MyBatis)와의 차이는?
- 영속성 컨텍스트란 무엇인가요? 1차 캐시, 쓰기 지연, 변경 감지(dirty checking)를 설명해주세요.
- 즉시 로딩(EAGER)과 지연 로딩(LAZY)의 차이, 기본 전략을 어떻게 가져가나요?
- N+1 문제란 무엇이고 어떻게 해결하나요? (fetch join, `@EntityGraph`, batch size)
- `merge`와 dirty checking의 차이는?
- 연관관계의 주인(owner)이란? `mappedBy`는 왜 필요한가요?
- `LazyInitializationException`은 왜 발생하나요? 해결 방법들(트랜잭션 범위 조정, fetch join, DTO 변환 시점)과 각각의 트레이드오프는?

## 중급 ⭐⭐

- fetch join과 페이징을 함께 쓸 때의 문제(메모리에서 페이징)와 해결책은?
- OSIV(Open Session In View)를 켰을 때와 껐을 때의 트레이드오프는? 대용량 트래픽 서비스에서는 어떻게 설정하겠습니까?
- JPA의 낙관적 락(`@Version`)과 비관적 락의 차이, 각각 언제 사용하나요?
- 벌크 연산(`@Modifying`) 후 영속성 컨텍스트는 어떻게 처리해야 하나요?
- 엔티티를 API 응답으로 직접 노출하면 안 되는 이유는?
- QueryDSL을 사용해본 경험이 있나요? 동적 쿼리를 어떻게 구성했나요?
- 복합 유니크 제약이 있는 테이블에 동시 INSERT가 몰릴 때 JPA 레벨에서 어떤 문제가 생기나요?
- 영속성 컨텍스트의 flush는 언제 일어나나요? 쓰기 지연 SQL의 실행 순서가 코드 순서와 달라서 생기는 문제(유니크 제약, 데드락)는?
- `findById`와 `getReferenceById`의 차이는? 프록시 반환이 유용한 경우는 언제인가요?
- 상속 관계 매핑 전략(SINGLE_TABLE, JOINED, TABLE_PER_CLASS)의 트레이드오프와 선택 기준은?
- 조회 전용 화면에 엔티티 대신 DTO 프로젝션을 쓰는 이유와 방법은? (영속성 컨텍스트 비용, 필요한 컬럼만 조회)
- 동료의 PR: `List<Long> ids`를 루프 돌며 건별 `findById`로 조회합니다. 지금 데이터 규모에서는 빠릅니다. 어떤 리뷰 코멘트를 남기나요?

## 고난이도 ⭐⭐⭐

- 재고 차감/포인트 차감 같은 동시성 갱신 문제를 낙관적 락, 비관적 락, 원자적 UPDATE, 분산 락 각각으로 풀 때의 트레이드오프를 비교해주세요.
- 대량 데이터 INSERT 시 JPA의 한계와 JDBC batch로 우회하는 방법(IDENTITY 전략의 문제 포함)을 설명해주세요.
- 하나의 트랜잭션에서 여러 Aggregate를 수정하면 왜 문제가 되나요? 도메인 이벤트 기반으로 어떻게 분리하나요?
- 멀티 DB(read replica) 환경에서 `@Transactional(readOnly=true)` 기반 라우팅을 어떻게 구현하나요? replication lag은 어떻게 다루나요?

## 알면 좋은 +α

- `CascadeType.REMOVE`와 `orphanRemoval`의 차이는? 어떤 사고 위험이 있나요?
- JPA 엔티티의 `equals`/`hashCode`는 어떻게 구현해야 하나요? 프록시와 id 생성 시점 문제는?
- Soft delete를 구현할 때 유니크 제약과 연관관계 조회는 어떻게 처리하나요?
- JPA Auditing(생성/수정 시각·주체 자동 기록)은 어떻게 동작하나요? 벌크 연산에서는 왜 기록되지 않나요?
