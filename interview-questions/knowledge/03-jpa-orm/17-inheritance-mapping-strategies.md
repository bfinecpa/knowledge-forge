# 상속 관계 매핑 전략 — 선택은 "자식 고유 컬럼의 양 × 다형성 조회의 빈도" 두 축으로 압축된다

> 핵심 관전 포인트: 상속을 테이블로 내리는 방법은 세 가지고, **선택을 가르는 축은 두 개뿐**이다 — ① **자식만 갖는 고유 컬럼이 얼마나 많은가** ② **부모 타입으로 조회하는 일(다형성 조회)이 얼마나 잦은가.** 자식 컬럼이 적고 부모 타입 목록 조회가 지배적이면 **`SINGLE_TABLE`** — 조인이 0이고, 대가는 **자식 고유 컬럼에 `NOT NULL`을 못 거는 무결성 구멍 + 테이블 비대**다(방어는 애플리케이션 검증 + DB `CHECK` 제약). 자식 컬럼이 많고 무결성이 중요하며 목록에 자식 필드가 필요 없으면 **`JOINED`** — 대가는 **상세 조회마다 조인 1회, 부모 타입으로 엔티티를 조회하면 자식 테이블 전부에 `LEFT OUTER JOIN`, INSERT가 테이블 2개로 분할**이다. 여기서 멈추면 안 된다 — 자식이 3종에서 15종이 되면 문제의 성질이 바뀐다. **outer join 15개짜리 쿼리는 "조인 비용"이 아니라 "옵티마이저가 실행계획을 잘못 잡는 문제"** 이고, 그때부터 성능은 평균이 아니라 p99에서 무너진다. **`TABLE_PER_CLASS`는 부모 타입 조회를 아예 안 할 때만 후보** — 공통 필드 조회가 `UNION ALL` 전체 스캔이 되고, **`IDENTITY` 전략을 쓸 수 없으며**(자식 테이블마다 독립 자동 증가 컬럼이면 ID가 충돌), 부모 타입으로 FK를 걸 수도 없다. 그리고 이 결정은 **되돌리기가 가장 비싼 축**이다 — 전략 변경 = 데이터 마이그레이션. 그래서 기준은 "지금 자식이 3개"가 아니라 **"3년 뒤 자식이 몇 종이고, 목록 화면이 자식 필드를 요구할 것인가"** 다. 마지막으로, **상속을 테이블로 안 내리는 선택지**(`@MappedSuperclass`, 컴포지션 + JSON 컬럼)가 실무에서 정답인 경우가 생각보다 많다.

---

## 0. 질문 + 의도

**질문**: "상속 관계 매핑 전략(SINGLE_TABLE, JOINED, TABLE_PER_CLASS)의 트레이드오프와 선택 기준은?"

관련 질문(실제로 이어진 꼬리질문):
"`Payment` 부모 + `CardPayment`(카드번호·할부개월) / `BankTransferPayment`(계좌·은행코드) / `PointPayment` 세 자식, 결제수단은 계속 늘어난다. 단일 테이블에 다 몰기 vs 부모+자식 조인 중 어느 쪽? **택하지 않은 쪽에서 무엇을 포기하나?**"
"운영 6개월 뒤 '목록에도 카드면 할부개월, 계좌이체면 은행명을 보여달라'는 요구가 왔다. 하루 수십만 건 호출되는 페이징 화면이다. 어떤 SQL이 나가고 무슨 문제가 생기나?"
"조회 트래픽이 지배적이니 애초에 SINGLE_TABLE이 맞았다고 반박할 수 있다. `card_number`·`bank_code`에 `NOT NULL`을 못 거는 무결성 구멍은 어떻게 방어하나?"
"`TABLE_PER_CLASS`는 왜 실무에서 거의 권장되지 않나?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**상속 구조를 테이블로 내리는 결정은 조회 성능(조인 비용), 무결성(nullable 컬럼), 확장성(타입 추가)의 트레이드오프이고 한번 정하면 바꾸기 매우 비싸다. 객체 모델과 관계 모델의 임피던스 불일치를 실제로 다뤄봤는지 본다.**" 즉 이 문항은 애노테이션 세 개를 외웠는지 묻는 게 아니다. 채점 지점은 셋이다 — ① **세 축(성능·무결성·확장성)을 동시에 저울에 올리는가** ② **자기가 고른 쪽이 지불하는 비용을 유도 없이 스스로 꺼내는가** ③ **"한번 정하면 바꾸기 매우 비싸다"는 성질을 알고, 그래서 현재가 아니라 미래의 조회 패턴으로 정하는가**.

용어 하나를 먼저 풀고 가자. **임피던스 불일치(impedance mismatch)** 는 원래 전기 회로에서 두 회로의 저항이 안 맞아 신호가 제대로 넘어가지 않는 현상을 가리키는 말인데, 여기서는 **객체 세계의 개념(상속)이 관계형 DB 세계에는 대응하는 개념이 없어서 생기는 간극**을 뜻한다. 자바에는 `extends`가 있지만 SQL 테이블에는 "이 테이블은 저 테이블을 상속한다"는 문법이 없다. 그래서 개발자가 **상속을 테이블 모양으로 직접 번역**해야 하고, 번역 방식이 셋인 것이 이 문항의 전부다.

**이 문서가 하는 일**: §1에서 세 전략 각각을 **① 매핑 → ② DDL → ③ 단건 조회 SQL → ④ 부모 타입 목록 조회 SQL → ⑤ INSERT SQL → ⑥ 얻는 것 / 포기하는 것** 이라는 **완전히 같은 여섯 칸**으로 강제 대조한다. 여섯째 칸을 매번 두 줄("얻는 것"과 "포기하는 것")로 나눠 쓰는 것이 이 문서의 핵심 훈련이다. 트레이드오프 질문에서 감점이 나는 지점은 지식 부족이 아니라 **"고른 것"만 말하고 "포기한 것"을 상대가 물어야 꺼내는 답변 구조**이기 때문이다.

---

## 1. 같은 객체 모델을 세 가지 테이블로 내린다

### 1-1. 먼저 굳혀둘 네 문장 — 이 문서의 결론 미리보기

아래 네 문장이 이 문서가 도달하려는 지점이다. 지금 다 이해되지 않아도 좋다. §1-4부터 하나씩 근거를 채운다.

- **전략을 고르기 전에 조회 패턴부터 확정한다.** "단건·목록 조회에 노출되어야 하는 데이터가 무엇인가?" 상속 매핑은 **조회 패턴이 결정**하므로, 이 질문 없이 전략을 고르는 것은 근거 없이 고르는 것이다. 면접에서는 이 되질문 자체가 점수다.
- **`SINGLE_TABLE`의 무결성 구멍은 "애플리케이션 검증 + DB `CHECK` 제약"으로 막는다.** `NOT NULL`을 못 거는 이유는 같은 컬럼이 다른 타입 행에서는 반드시 비어 있어야 하기 때문이고, 그래서 무조건 제약이 아니라 **조건부 제약**이 필요하다. (§2-4에 실제 DDL)
- **`TABLE_PER_CLASS`의 공통 필드 조회는 자식 테이블들을 `UNION ALL` 한다.** 이것이 첫 번째 결격 사유다. 두 번째는 `IDENTITY` 전략을 쓸 수 없다는 것이다. (§1-6)
- **`JOINED`를 고르는 근거는 셋이다** — nullable 컬럼 회피(무결성), 결제수단 추가 시 공용 테이블 컬럼 증식 방지(확장성), 목록은 공통 필드만 필요(성능).

그리고 이 네 문장에 **반드시 한 줄을 더 붙여야** 답변이 완성된다.

> **"`JOINED`를 택하겠습니다. 대신 상세 조회마다 조인 1회, 부모 타입으로 엔티티를 조회하면 자식 테이블 전부에 `LEFT OUTER JOIN`, INSERT가 테이블 2개로 갈라지는 비용을 지불합니다."**
>
> 트레이드오프 질문의 답은 **"고른 것 + 포기한 것"이 한 호흡**이어야 한다. 상대가 반대편 단점을 물어야 그제서야 나오는 순간, "저 사람은 한쪽만 봤다"가 된다.

### 1-2. 시나리오와 객체 모델을 끝까지 고정한다

- **도메인**: `Payment`(부모, 추상) / `CardPayment`(카드번호·할부개월) / `BankTransferPayment`(계좌번호·은행코드) / `PointPayment`(포인트지갑ID). **결제수단은 계속 늘어난다.**
- **조회 패턴**: **목록** = 기간별 페이징 20건, **공통 필드만**, 호출량 지배적 / **단건 상세** = 자식 고유 필드까지 전부.

공통 부모는 이렇게 생겼다. 세 전략은 `@Inheritance(strategy = ...)` 한 줄만 다르다.

```java
@Entity
@Inheritance(strategy = /* ← 여기만 바뀐다 */)
public abstract class Payment {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "payment_id")
    private Long id;

    private BigDecimal amount;      // 공통 — 목록에 노출
    private LocalDateTime paidAt;   // 공통 — 목록에 노출 + 기간 검색 조건
    @Enumerated(EnumType.STRING)
    private PaymentStatus status;   // 공통 — 목록에 노출
}
```

```java
@Entity
public class CardPayment extends Payment {
    private String cardNumber;   // 자식 고유 — 상세에만 노출
    private int installment;     // 자식 고유 — 상세에만 노출
}

@Entity
public class BankTransferPayment extends Payment {
    private String accountNo;    // 자식 고유
    private String bankCode;     // 자식 고유
}

@Entity
public class PointPayment extends Payment {
    private Long pointWalletId;  // 자식 고유
}
```

**용어 정리 — 다형성 조회(polymorphic query).** "부모 타입으로 조회해서 자식들을 한꺼번에 받는 것"이다. `select p from Payment p`를 실행하면 결과 리스트에 `CardPayment`·`BankTransferPayment`·`PointPayment`가 섞여 돌아온다. "여러(poly) 모습(morph)으로 나오는 조회"라 다형성 조회다.

이 문항의 두 축 중 하나가 바로 **이 조회를 얼마나 자주 하는가**이고, 세 전략의 성능 차이는 거의 전부 여기서 갈린다. 반대로 `select c from CardPayment c`처럼 **자식 타입을 특정한 조회**는 다형성 조회가 아니며, 세 전략 모두에서 비교적 싸다.

### 1-3. 세 전략이 만드는 테이블을 나란히 놓고 본다

전략 선택은 결국 **"이 객체 모델이 DB에서 어떤 테이블 그림이 되는가"** 를 고르는 일이다. 그러니 SQL을 보기 전에 그림부터 나란히 놓는다. 같은 결제 3건(카드 101 / 계좌이체 102 / 포인트 103)이 세 전략에서 각각 어떻게 저장되는지 보자.

**① `SINGLE_TABLE` — 테이블 1개. 모든 자식의 컬럼이 한 테이블에 모인다.**

```text
payment
┌────────────┬──────────────┬────────┬─────────┬────────┬─────────────┬─────────────┬────────────┬───────────┬─────────────────┐
│ payment_id │ payment_type │ amount │ paid_at │ status │ card_number │ installment │ account_no │ bank_code │ point_wallet_id │
├────────────┼──────────────┼────────┼─────────┼────────┼─────────────┼─────────────┼────────────┼───────────┼─────────────────┤
│        101 │ CARD         │ 19900  │ 09-01   │ PAID   │ 1234-****   │           3 │ (null)     │ (null)    │ (null)          │
│        102 │ BANK         │ 50000  │ 09-01   │ PAID   │ (null)      │      (null) │ 110-****   │ 004       │ (null)          │
│        103 │ POINT        │  3000  │ 09-02   │ PAID   │ (null)      │      (null) │ (null)     │ (null)    │              77 │
└────────────┴──────────────┴────────┴─────────┴────────┴─────────────┴─────────────┴────────────┴───────────┴─────────────────┘
 └──────────── 모든 행이 채우는 공통 컬럼 ────────────┘└─── 카드 전용 ───────────┘└─ 계좌이체 전용 ───────┘└─ 포인트 전용 ──┘
                                                        (다른 타입 행에서는 반드시 null)
```

**② `JOINED` — 테이블 1 + 자식 수. 공통은 부모 테이블, 고유는 자식 테이블. 자식의 PK가 곧 부모를 가리키는 FK다.**

```text
payment (부모 — 공통 컬럼만. 행이 좁다)
┌────────────┬──────────────┬────────┬─────────┬────────┐
│ payment_id │ payment_type │ amount │ paid_at │ status │
├────────────┼──────────────┼────────┼─────────┼────────┤
│        101 │ CARD         │ 19900  │ 09-01   │ PAID   │
│        102 │ BANK         │ 50000  │ 09-01   │ PAID   │
│        103 │ POINT        │  3000  │ 09-02   │ PAID   │
└─────┬──────┴──────────────┴────────┴─────────┴────────┘
      │ payment_id 로 1:1 연결 (자식 PK = 부모를 향한 FK)
      ├───────────────────────────┬──────────────────────────┐
      ▼                           ▼                          ▼
card_payment                bank_transfer_payment       point_payment
┌────────────┬─────────────┬─────────────┐  ┌────────────┬────────────┬───────────┐  ┌────────────┬─────────────────┐
│ payment_id │ card_number │ installment │  │ payment_id │ account_no │ bank_code │  │ payment_id │ point_wallet_id │
├────────────┼─────────────┼─────────────┤  ├────────────┼────────────┼───────────┤  ├────────────┼─────────────────┤
│        101 │ 1234-****   │           3 │  │        102 │ 110-****   │ 004       │  │        103 │              77 │
└────────────┴─────────────┴─────────────┘  └────────────┴────────────┴───────────┘  └────────────┴─────────────────┘
    행이 1건뿐 — 카드 결제만 여기 산다        행이 1건뿐                                 행이 1건뿐
    null 이 없다 → NOT NULL 을 걸 수 있다
```

**③ `TABLE_PER_CLASS` — 자식 수만큼. 부모 테이블이 아예 없고, 공통 컬럼이 자식마다 복제된다.**

```text
(payment 테이블은 존재하지 않는다 — 부모가 추상 클래스이므로)

card_payment                                              bank_transfer_payment
┌────────────┬────────┬─────────┬────────┬─────────────┬─┐  ┌────────────┬────────┬─────────┬────────┬────────────┬─┐
│ payment_id │ amount │ paid_at │ status │ card_number │…│  │ payment_id │ amount │ paid_at │ status │ account_no │…│
├────────────┼────────┼─────────┼────────┼─────────────┼─┤  ├────────────┼────────┼─────────┼────────┼────────────┼─┤
│        101 │ 19900  │ 09-01   │ PAID   │ 1234-****   │ │  │        102 │ 50000  │ 09-01   │ PAID   │ 110-****   │ │
└────────────┴────────┴─────────┴────────┴─────────────┴─┘  └────────────┴────────┴─────────┴────────┴────────────┴─┘
              └─── 공통 컬럼이 여기 복제 ───┘                              └─── 같은 공통 컬럼이 또 복제 ───┘

  → "모든 결제 목록"을 보려면 이 테이블들을 UNION ALL 로 합쳐야 한다.
  → 다른 테이블이 "어떤 결제든" 참조하는 FK 를 걸 대상 테이블이 없다.
```

이 세 그림만 머릿속에 있으면 나머지는 전부 그림에서 유도된다. **`SINGLE_TABLE`의 null 구멍**은 첫 번째 그림의 `(null)` 칸들이고, **`JOINED`의 조인**은 두 번째 그림의 화살표이며, **`TABLE_PER_CLASS`의 `UNION ALL`과 FK 불가**는 세 번째 그림에 부모 상자가 없다는 사실 그 자체다.

이제 각 전략을 같은 여섯 칸으로 뜯는다.

> **DDL 표기 안내**: 아래 `create table` 예시는 MySQL 문법으로 적었다(`auto_increment`, `datetime(6)`). PostgreSQL이면 `bigint generated by default as identity`, `timestamptz`, `numeric(19,2)`로 바꿔 읽으면 된다. 전략 선택의 논지는 벤더와 무관하다. 다만 §2-4의 `CHECK` 제약만은 **PostgreSQL 기준으로 쓴다** — 벤더별 강제 여부가 갈리는 지점이라 거기서 따로 설명한다.

### 1-4. `SINGLE_TABLE` — 테이블 하나에 전부 몰기

#### ① 매핑

```java
@Entity
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name = "payment_type")          // 없으면 기본 컬럼 이름은 DTYPE
public abstract class Payment { /* §1-2와 동일 */ }

@Entity @DiscriminatorValue("CARD")                  // 값을 반드시 명시한다 (§2-2)
public class CardPayment extends Payment { ... }
```

#### ② DDL

```sql
create table payment (
    payment_id      bigint       not null auto_increment,
    payment_type    varchar(31)  not null,            -- 구분 컬럼(discriminator)
    amount          decimal(19,2) not null,
    paid_at         datetime(6)  not null,
    status          varchar(20)  not null,
    card_number     varchar(20)  null,   -- CardPayment 전용 → 나머지 타입 행에서는 반드시 null
    installment     integer      null,   -- CardPayment 전용
    account_no      varchar(30)  null,   -- BankTransferPayment 전용
    bank_code       varchar(10)  null,   -- BankTransferPayment 전용
    point_wallet_id bigint       null,   -- PointPayment 전용
    primary key (payment_id)
);
```

컬럼 수가 어떻게 늘어나는지 계산해 두자. 공통 컬럼이 5개(`payment_id`, `payment_type`, `amount`, `paid_at`, `status`)이고 자식 하나가 평균 3~4개의 고유 컬럼을 갖는다고 하면, **자식 15종이면 5 + 15 × 3~4 = 50~65개** 다. 그리고 그 45~60개는 **전부 null 허용**이다. "컬럼이 60개쯤 되고 그중 대부분이 nullable인 테이블"이 이 전략의 3년 뒤 모습이다.

#### ③ 단건 상세 조회 SQL — 조인 0

```sql
select p.payment_id, p.payment_type, p.amount, p.paid_at, p.status,
       p.card_number, p.installment, p.account_no, p.bank_code, p.point_wallet_id
from payment p
where p.payment_id = ?
```

자식 타입으로 특정해 조회하면(`em.find(CardPayment.class, id)`) 구분 컬럼 조건이 자동으로 붙는다 — `where p.payment_id = ? and p.payment_type = 'CARD'`. **타입이 맞는지 확인하는 일을 SQL이 대신 해준다.**

#### ④ 부모 타입 목록 조회 SQL — 조인 0

```sql
select p.payment_id, p.payment_type, p.amount, p.paid_at, p.status,
       p.card_number, p.installment, p.account_no, p.bank_code, p.point_wallet_id
from payment p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
```

**여기가 `SINGLE_TABLE`의 존재 이유다.** 다형성 조회가 단일 테이블 스캔 한 번으로 끝난다. 자식이 15종이 되어도 이 쿼리의 **모양은 변하지 않는다** — 컬럼 목록만 길어질 뿐 조인은 여전히 0이다.

#### ⑤ INSERT SQL — 1문장

```sql
insert into payment (payment_type, amount, paid_at, status, card_number, installment)
values ('CARD', ?, ?, ?, ?, ?)
```

자기 컬럼만 채우고 형제 컬럼은 아예 문장에 등장하지 않는다. **쓰기가 가장 싸다.**

#### ⑥ 얻는 것 / 포기하는 것

**얻는 것**

- **조인이 0이다.** 다형성 조회·단건 조회 모두 테이블 하나로 끝난다.
- **INSERT / UPDATE / DELETE가 각 1문장이다.** 쓰기 비용과 트랜잭션 길이가 최소다.
- **구분 컬럼으로 타입을 즉시 알 수 있다.** 통계·집계 쿼리가 단순해진다(`group by payment_type`).
- **다른 테이블이 "어떤 결제든" 참조하는 FK가 자연스럽다.** `refund.payment_id`가 `payment` 테이블 하나만 가리키면 끝이다.

**포기하는 것**

- **자식 고유 컬럼에 `NOT NULL`을 걸 수 없다.** `card_number`는 카드 결제엔 필수인데 포인트 결제 행에선 반드시 null이어야 한다. 한 컬럼에 "어떤 행에서는 필수, 어떤 행에서는 금지"라는 두 규칙이 동시에 걸려야 하는데, `NOT NULL`은 그런 조건부 표현을 할 수 없다. **DB가 지켜주던 것을 애플리케이션이 지켜야 한다.** (자세한 이유와 방어책은 §2-4)
- **테이블이 비대해진다.** 행 하나가 넓어지면 **데이터 페이지 하나에 들어가는 행 수가 줄고**, 공통 필드만 읽는 목록 조회조차 넓은 행을 읽어야 한다. (완화책: 목록 쿼리를 커버링 인덱스로 처리하거나 DTO 프로젝션으로 필요한 컬럼만 뽑는다. **커버링 인덱스**란 쿼리가 필요로 하는 컬럼이 전부 인덱스 안에 들어 있어서 테이블 본체를 읽지 않아도 되는 인덱스를 말한다.)
- **자식 하나를 추가하는 일이 "전 서비스가 쓰는 공용 테이블 `ALTER`"** 가 된다. 수억 행 테이블의 컬럼 추가는 그 자체로 배포 이벤트다.
- **컬럼 이름 충돌을 사람이 관리해야 한다.** 두 자식이 각각 `amount`라는 서로 다른 의미의 필드를 갖고 싶으면 한쪽 이름을 바꿔야 한다.
- **자식별 인덱스가 전체 행에 걸린다.** 카드 결제만 쓰는 `card_number` 인덱스가 포인트 결제 행까지 포함한 인덱스가 된다. (PostgreSQL이면 **부분 인덱스**로 상당 부분 회복할 수 있다 — §2-4)

### 1-5. `JOINED` — 부모 테이블 + 자식 테이블로 정규화

#### ① 매핑

```java
@Entity
@Inheritance(strategy = InheritanceType.JOINED)
@DiscriminatorColumn(name = "payment_type")   // JOINED에선 선택이지만 넣는 편이 낫다 (§2-3)
public abstract class Payment { /* §1-2와 동일 */ }

@Entity
@DiscriminatorValue("CARD")
@PrimaryKeyJoinColumn(name = "payment_id")    // 자식 PK가 곧 부모를 향한 FK
public class CardPayment extends Payment {
    @Column(nullable = false) private String cardNumber;   // NOT NULL을 걸 수 있다
    @Column(nullable = false) private int installment;
}
```

#### ② DDL

```sql
create table payment (                              -- 공통 필드만. 좁고 가볍다
    payment_id   bigint        not null auto_increment,
    payment_type varchar(31)   not null,
    amount       decimal(19,2) not null,
    paid_at      datetime(6)   not null,
    status       varchar(20)   not null,
    primary key (payment_id)
);

create table card_payment (
    payment_id  bigint      not null,               -- PK이면서 동시에 부모를 가리키는 FK
    card_number varchar(20) not null,               -- 진짜 NOT NULL
    installment integer     not null,
    primary key (payment_id),
    constraint fk_card_payment foreign key (payment_id) references payment (payment_id)
);
-- bank_transfer_payment, point_payment 도 같은 모양이다.
-- 결제수단이 추가되면 공용 테이블 ALTER 가 아니라 새 테이블 CREATE 다.
```

#### ③ 단건 상세 조회 SQL — 조인 1회

```sql
-- CardPayment 로 특정해 조회 → 부모와 inner join 한 번
select c.payment_id, p.amount, p.paid_at, p.status,
       c.card_number, c.installment
from card_payment c
join payment p on p.payment_id = c.payment_id
where c.payment_id = ?
```

**"단건은 한 행에 조인 한 번이면 된다"가 정확히 이것이다.** 상세 화면은 어차피 호출량이 적으니 조인 1회는 싼 대가다.

#### ④ 부모 타입 목록 조회 SQL — 자식 테이블 전부에 `LEFT OUTER JOIN`

**여기가 이 문항 전체에서 가장 중요한 SQL이다.** `select p from Payment p`처럼 **부모 타입으로 엔티티를 조회**하면 이렇게 나간다.

```sql
select p.payment_id, p.amount, p.paid_at, p.status,
       c.card_number, c.installment,            -- 카드 자식 컬럼
       b.account_no, b.bank_code,               -- 계좌이체 자식 컬럼
       pt.point_wallet_id,                      -- 포인트 자식 컬럼
       p.payment_type
from payment p
left outer join card_payment          c  on p.payment_id = c.payment_id
left outer join bank_transfer_payment b  on p.payment_id = b.payment_id
left outer join point_payment         pt on p.payment_id = pt.payment_id
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
```

**왜 `LEFT OUTER JOIN`인가, 그리고 왜 "공통 필드만 쓸 건데도" 붙는가.**

`select p from Payment p`의 결과로 돌아와야 하는 것은 **`Payment`가 아니라 `CardPayment`·`BankTransferPayment`의 완성된 인스턴스**다. `Payment`는 추상 클래스라 인스턴스가 존재할 수 없기 때문이다.

그러니 Hibernate는 각 행이 어떤 자식인지 판정하고 **그 자식의 필드까지 채워서** 객체를 만들어야 한다. 필드를 채우려면 그 자식 테이블을 읽어야 하고, 자식 테이블에 짝이 없는 경우도 있으므로(카드 결제 행은 `point_payment`에 존재하지 않는다) **`INNER JOIN`이 아니라 `LEFT OUTER JOIN`** 이어야 한다.

여기서 흔히 나오는 반론 — "목록은 공통 필드만 쓸 거니까 부모 테이블만 읽으면 되지 않나?" — 이 지점에서 어긋난다. **내 화면이 `amount`만 쓴다는 사실을 Hibernate는 알 수 없다.** 반환 타입이 `Payment`인 이상 완성된 객체를 만들어야 하고, 완성된 객체를 만들려면 자식 컬럼이 필요하다.

부모 테이블만 읽게 하려면 **엔티티가 아니라 DTO로 뽑아야 한다** — §2-7의 처방이 이것이다. (실제 SQL은 반드시 `show_sql`로 확인하라. 구분 컬럼 유무와 Hibernate 버전에 따라 조인을 붙이는 조건이 조금씩 다르다.)

#### ⑤ INSERT SQL — 2문장으로 분할

```sql
insert into payment (payment_type, amount, paid_at, status) values ('CARD', ?, ?, ?)
insert into card_payment (payment_id, card_number, installment) values (?, ?, ?)
```

3단 상속(부모 → 중간 → 자식)이면 3문장이 된다. **한 건 저장에 DB 왕복이 2회**이므로 트랜잭션이 길어지고, 대량 적재에서는 이 배수가 그대로 처리 시간에 곱해진다.

`DELETE`도 자식 → 부모 순서로 2문장이다(FK 때문에 자식을 먼저 지워야 한다). 다만 `UPDATE`는 **건드린 필드가 속한 테이블만** 나간다 — 할부개월만 바꾸면 `update card_payment ...` 1문장이다.

#### ⑥ 얻는 것 / 포기하는 것

**얻는 것**

- **자식 고유 컬럼에 `NOT NULL`·`UNIQUE`·`FK`를 전부 걸 수 있다.** 자식 테이블에는 그 타입의 행만 살기 때문이다. 무결성을 DB가 지키므로 애플리케이션에 버그가 있어도 이상한 데이터가 들어오지 못한다.
- **자식 추가 = 새 테이블 `CREATE`.** 운영 중인 공용 테이블을 `ALTER`하지 않으므로 배포 리스크가 낮다. "공용 테이블에 컬럼을 계속 추가할 수 없다"는 `SINGLE_TABLE`의 문제가 여기서 사라진다.
- **저장 공간이 정직하다.** null 컬럼을 쌓지 않는다. 부모 테이블이 좁으므로 공통 필드 인덱스의 밀도도 좋다.
- **자식 타입으로 특정한 조회는 형제 테이블을 건드리지 않는다.** `select c from CardPayment c`는 부모와의 조인 1회로 끝난다. (§2-7의 열쇠)

**포기하는 것**

- **단건 상세 조회마다 조인 1회.** 보통 감수할 만하다.
- **부모 타입 엔티티 조회 시 자식 테이블 전부에 `LEFT OUTER JOIN`.** 자식이 늘어날수록 조인 개수가 **선형으로** 늘어난다. 목록 화면이 호출량 지배적이면 이 비용이 곧 서비스 전체 비용이 된다.
- **INSERT / DELETE가 테이블 수만큼 분할된다.** 쓰기 비용·트랜잭션 길이·락을 잡는 테이블 수가 모두 증가한다.
- **자식이 15종이 되면 문제의 성질 자체가 바뀐다.** 조인이 "느려지는" 문제에서 "실행계획이 흔들리는" 문제로 넘어간다. 이 문항의 시니어 변별 지점이고, §2-5에서 통째로 다룬다.

### 1-6. `TABLE_PER_CLASS` — 자식마다 독립 테이블

#### ① 매핑

```java
@Entity
@Inheritance(strategy = InheritanceType.TABLE_PER_CLASS)
public abstract class Payment {

    // IDENTITY 를 쓸 수 없다. 아래 ⑥에서 이유를 본다.
    @Id @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "payment_seq")
    @SequenceGenerator(name = "payment_seq", sequenceName = "payment_seq", allocationSize = 50)
    @Column(name = "payment_id")
    private Long id;
    ...
}
```

#### ② DDL — 부모 테이블이 아예 없다(부모가 추상이면)

```sql
create table card_payment (
    payment_id  bigint        not null,
    amount      decimal(19,2) not null,   -- 공통 필드가 복제된다
    paid_at     datetime(6)   not null,   -- 공통 필드가 복제된다
    status      varchar(20)   not null,   -- 공통 필드가 복제된다
    card_number varchar(20)   not null,
    installment integer       not null,
    primary key (payment_id)
);

create table bank_transfer_payment (
    payment_id bigint        not null,
    amount     decimal(19,2) not null,   -- 또 복제
    paid_at    datetime(6)   not null,
    status     varchar(20)   not null,
    account_no varchar(30)   not null,
    bank_code  varchar(10)   not null,
    primary key (payment_id)
);
-- payment 테이블은 없다. → 다른 테이블이 "결제"를 참조하는 FK 를 걸 대상이 없다.
```

#### ③ 단건 상세 조회 SQL — 조인 0, 세 전략 중 가장 빠르다

```sql
select c.payment_id, c.amount, c.paid_at, c.status, c.card_number, c.installment
from card_payment c
where c.payment_id = ?
```

**타입을 알고 있을 때는 이 전략이 최적이다.** 조인도 없고 불필요한 컬럼도 없다.

#### ④ 부모 타입 목록 조회 SQL — `UNION ALL` 전체 스캔

```sql
select p.payment_id, p.amount, p.paid_at, p.status,
       p.card_number, p.installment, p.account_no, p.bank_code, p.point_wallet_id
from (
    select payment_id, amount, paid_at, status,
           card_number, installment,
           null as account_no, null as bank_code, null as point_wallet_id,  -- null 패딩
           1 as clazz_
    from card_payment
  union all
    select payment_id, amount, paid_at, status,
           null, null, account_no, bank_code, null, 2 as clazz_
    from bank_transfer_payment
  union all
    select payment_id, amount, paid_at, status,
           null, null, null, null, point_wallet_id, 3 as clazz_
    from point_payment
) p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
```

이 SQL은 Hibernate가 실제로 만드는 모양이다. 컬럼 목록의 자리를 맞추려고 없는 컬럼을 `null`로 채우고, 각 항이 어느 자식인지 표시하려고 `clazz_`라는 상수 컬럼을 붙인다.

여기서 두 가지를 반드시 짚어야 한다.

- **`null` 패딩이 등장한다.** "nullable 컬럼을 피하려고" 이 전략을 골랐더라도, **부모 타입으로 조회하는 순간 쿼리 안에서 nullable 컬럼이 되살아난다.** 스키마에서 없앤 것이 실행계획에서 돌아오는 셈이다.
- **`limit 20`이 `UNION ALL` 바깥에 있다.** DB는 자식 테이블 전부를 읽어 합집합을 만든 다음 정렬하고 나서야 20건을 자를 수 있다. **페이징의 전제(20건만 만지면 된다)가 원천적으로 깨진다.** `where paid_at between ...` 조건은 각 자식 테이블 안쪽으로 밀려 들어갈 수 있지만(그건 옵티마이저에 달렸다), **정렬은 합친 뒤에야 가능하다.** `count(*)`도 마찬가지로 합집합을 만들어야 한다.

#### ⑤ INSERT SQL — 1문장

```sql
insert into card_payment (payment_id, amount, paid_at, status, card_number, installment)
values (?, ?, ?, ?, ?, ?)
```

쓰기는 가장 단순하다. 단, id를 시퀀스에서 미리 받아와야 한다.

#### ⑥ 얻는 것 / 포기하는 것

**얻는 것**

- **자식 타입을 알고 하는 조회는 조인 0 + 불필요한 컬럼 0.** 세 전략 중 최적이다.
- **모든 컬럼에 `NOT NULL`을 걸 수 있다.**
- **자식 테이블이 완전히 독립적이다.** 테이블별로 인덱스·파티셔닝·보관 정책·심지어 물리적 분리까지 자유롭게 할 수 있다.

**포기하는 것**

- **부모 타입 조회가 `UNION ALL` 전체 스캔이 된다.** 페이징·정렬·집계가 모두 그 합집합 위에서 일어난다. 자식이 늘면 union 항도 늘어난다.
- **`IDENTITY` 전략을 쓸 수 없다.** 이유는 이렇다. 자동 증가 컬럼은 **테이블마다 독립적으로** 번호를 매기므로, `card_payment`에도 `payment_id = 1`이 생기고 `bank_transfer_payment`에도 `payment_id = 1`이 생긴다. 그러면 **`em.find(Payment.class, 1L)`이 둘 중 어느 것을 가리키는지 정할 수 없고, `UNION ALL` 결과에 같은 id가 두 번 등장한다.** 계층 전체에서 id가 유일해야 하므로 **`SEQUENCE` 또는 `TABLE` 생성기가 필수**다. Hibernate는 이 조합을 아예 기동 시점에 막는다 — `UnionSubclassEntityPersister`가 `MappingException`을 던지며, 메시지는 **`Cannot use identity column key generation with <union-subclass> mapping for: <엔티티명>`** 이다(Hibernate 6.6 기준). 시퀀스를 쓰지 않는 팀 표준이라면 이 한 줄로 이 전략은 탈락이다.
- **부모 타입으로 FK를 걸 수 없다.** `refund.payment_id`가 "어떤 결제든" 참조해야 하는데 참조 대상 테이블이 존재하지 않는다. 즉 **다른 테이블과의 참조 무결성을 DB가 지켜줄 수 없다.** `@ManyToOne Payment` 같은 다형성 연관관계도 매핑이 어색해진다.
- **공통 컬럼 추가가 모든 자식 테이블 `ALTER`가 된다.** `SINGLE_TABLE`의 "공용 테이블 하나를 고치는 부담"이 "N개 테이블을 동시에 고치는 부담"으로 바뀔 뿐이다.
- **공통 필드에 유니크 제약을 계층 전체 범위로 걸 수 없다.** 예를 들어 `transaction_key`가 전체 결제에서 유일해야 한다면, 테이블이 갈라져 있으므로 표현할 방법이 없다.

**결론**: `TABLE_PER_CLASS`는 **부모 타입 조회를 아예 하지 않고, 자식들이 서로 거의 남남이며, 다른 테이블이 부모를 참조하지도 않을 때만** 후보다. 그런데 그 조건이 성립한다면 **애초에 상속을 엔티티로 표현할 이유가 없다.** 그때의 더 정직한 답은 `@MappedSuperclass`이고, §3-1에서 다룬다.

### 1-7. 세 전략, 한 표로

| | `SINGLE_TABLE` | `JOINED` | `TABLE_PER_CLASS` |
|---|---|---|---|
| 테이블 수 | 1개 | 1 + 자식 수 | 자식 수 (부모 없음) |
| 단건 상세 조회 | 조인 0 | 조인 1회 | 조인 0 |
| **부모 타입 목록 조회** | **조인 0** | **자식 전체 `LEFT OUTER JOIN`** | **`UNION ALL` 전체 스캔** |
| INSERT | 1문장 | 테이블 수만큼 | 1문장 |
| 자식 컬럼 `NOT NULL` | **불가** | 가능 | 가능 |
| 자식 추가 시 DDL | 공용 테이블 `ALTER` | 새 테이블 `CREATE` | 새 테이블 `CREATE` |
| 부모 타입 FK 참조 | 가능 | 가능 | **불가** |
| `IDENTITY` 사용 | 가능 | 가능 | **불가** |
| 구분 컬럼 | 필수(기본 `DTYPE`) | 선택 | 없음 |

**표는 여기까지다.** 실전에서 결정을 내리는 건 표가 아니라 **"목록 화면이 자식 필드를 요구하는가"** 한 질문이다. 그 질문을 포함한 선택 절차를 순서대로 그리면 이렇게 된다.

```text
[상속 전략 선택 절차] — 표를 외우는 게 아니라 두 축을 순서대로 묻는다

 ┌─ 1단계. 요구사항 확정 (답하기 전에 반드시) ────────────────────────────────┐
 │  ① 목록과 단건에 각각 어떤 필드가 노출되는가                                │
 │     ├─ 목록: 공통 필드만인가, 자식 고유 필드까지인가                        │
 │     └─ 목록의 호출량이 상세보다 지배적인가                                  │
 │  ② 자식 고유 컬럼은 몇 개이고, 3년 뒤 자식은 몇 종이 되는가                 │
 │     └─ 지금이 아니라 미래로 정한다. 되돌리기가 가장 비싼 결정이므로.        │
 └──────────────────────────────────┬──────────────────────────────────────┘
                                    │
 ┌─ 2단계. 두 축으로 판정 ───────────▼──────────────────────────────────────┐
 │        자식 고유 컬럼의 양  ×  다형성 조회의 빈도                          │
 │                                                                          │
 │  ③ 자식 컬럼 적음 + 부모 타입 조회 지배적                                  │
 │       → SINGLE_TABLE                                                     │
 │         얻는 것: 조인 0 / 포기: NOT NULL 불가 · 테이블 비대                │
 │                                                                          │
 │  ④ 자식 컬럼 많음 + 무결성 중요 + 목록에 자식 필드 불필요                  │
 │       → JOINED                                                           │
 │         얻는 것: 무결성 · 확장성                                          │
 │         포기: 상세 조인 1회 + 부모 조회 시 자식 전체 OUTER JOIN            │
 │               + INSERT 분할                                              │
 │                                                                          │
 │  ⑤ 부모 타입 조회를 아예 안 함                                            │
 │       → TABLE_PER_CLASS                                                  │
 │         UNION ALL · IDENTITY 불가 · 부모 FK 불가를 감수할 이유가 있을 때만 │
 │                                                                          │
 │  ⑥ 다형성 조회가 필요 없다                                                │
 │       → 테이블로 안 내린다                                                │
 │         @MappedSuperclass 또는 컴포지션 + JSON 컬럼 (§3-1, §3-2)          │
 └──────────────────────────────────┬──────────────────────────────────────┘
                                    │
 ┌─ 3단계. 결정을 코드로 고정하고 검증 ─▼──────────────────────────────────┐
 │  ⑦ 실제 SQL 을 찍어 눈으로 확인한다  (show_sql / p6spy + EXPLAIN)        │
 │     ├─ 목록 쿼리에 조인이 몇 개 붙는지                                   │
 │     ├─ INSERT 가 몇 문장으로 갈라지는지                                  │
 │     └─ order by ... limit 이 인덱스로 처리되는지                         │
 │  ⑧ 쿼리 수 · 조인 수를 테스트로 단정한다                                 │
 │     └─ 자식이 추가될 때 운영이 아니라 CI 에서 먼저 깨지게 만든다          │
 │                                                                         │
 │  여기서 안 보면 3년 뒤 데이터 마이그레이션으로 갚는다.                    │
 └─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 운영에서 드러나는 차이 — 구분 컬럼, 무결성 구멍, 그리고 6개월 뒤

§1은 "처음 만들 때" 이야기였다. 이 절은 **만들고 나서 시간이 지나면 무엇이 실제로 아픈가**를 다룬다. 상속 매핑이 위험한 이유는 처음에 안 아프고 나중에 아프기 때문이다.

### 2-1. 구분 컬럼은 무엇을 하는 물건인가

한 테이블에 여러 타입의 행이 섞여 있으면 **"이 행은 어떤 자식인가"를 적어둘 칸**이 필요하다. 그 칸이 **구분 컬럼(discriminator column)** 이고, 거기에 들어가는 **값**이 discriminator value다. `discriminate`가 "구별한다"는 뜻이니 말 그대로 "구별용 컬럼"이다.

```java
// Before — 애노테이션을 생략했다. 동작은 하지만 두 가지가 암묵값으로 정해진다
@Entity
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
public abstract class Payment { ... }

@Entity
public class CardPayment extends Payment { ... }
// → 컬럼 이름은 DTYPE, 저장되는 값은 엔티티 이름 그대로 'CardPayment'

// After — 컬럼 이름과 값을 명시한다
@Entity
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name = "payment_type", length = 20)
public abstract class Payment { ... }

@Entity
@DiscriminatorValue("CARD")     // 클래스 이름과 데이터를 분리한다
public class CardPayment extends Payment { ... }
```

### 2-2. 값을 명시해야 하는 이유 — 클래스 이름을 바꿔도 데이터가 안 깨진다

`@DiscriminatorValue`를 생략하면 DB에 **`'CardPayment'`라는 자바 클래스 이름이 그대로 저장된다.** 즉 **자바 코드의 식별자가 곧 데이터가 된다.** 코드는 리팩터링의 대상이고 데이터는 아니므로, 이 둘을 묶어두면 리팩터링이 데이터 사고가 된다.

```java
// Before — @DiscriminatorValue 없음. DB에는 'CardPayment' 가 쌓여 있다
@Entity
public class CardPayment extends Payment { ... }

// 6개월 뒤 리팩터링: "카드 말고 신용카드로 이름을 정확히 하자"
@Entity
public class CreditCardPayment extends Payment { ... }
// → 이제 Hibernate 는 구분 값 'CreditCardPayment' 를 찾는다.
//    이미 저장된 수백만 건의 'CardPayment' 행은 매핑할 클래스가 없는 데이터가 된다.
//    조회하는 순간 "이 구분 값에 해당하는 엔티티를 못 찾겠다"는 예외로 터진다
//    (Hibernate 6.6 의 메시지: Could not resolve discriminator value).
//    수습 = UPDATE payment SET payment_type='CreditCardPayment' (수백만 건 업데이트)

// After — 값을 명시해 두었다
@Entity
@DiscriminatorValue("CARD")
public class CreditCardPayment extends Payment { ... }
// → 클래스 이름을 무엇으로 바꿔도 DB 에는 계속 'CARD'. 데이터는 아무 영향이 없다.
```

**교훈은 상속 매핑을 넘어선다.** "자바 클래스 이름이나 enum 상수 이름이 DB에 그대로 문자열로 저장되는 지점은 전부 리팩터링 폭탄"이다. `@Enumerated(EnumType.STRING)`도 정확히 같은 성질이고, 그래서 enum 상수 이름을 함부로 바꾸면 안 된다.

또한 값을 짧게 명시하면 **저장 공간과 인덱스 크기**에서도 이득이다. 구분 컬럼의 기본 길이는 `varchar(31)`인데, 거기에 긴 클래스 이름을 넣는 것과 `'CARD'` 4바이트를 넣는 것은 수억 행에서 차이가 난다.

### 2-3. `JOINED`에서는 선택이지만, 넣는 편이 낫다

`JOINED`는 "어느 자식 테이블에 행이 있는가"로 타입을 알아낼 수 있으므로 구분 컬럼이 **필수는 아니다.** 그래도 넣는 이유가 셋이다.

- **부모 테이블만 봐도 타입을 안다.** 통계·모니터링·운영 쿼리를 조인 없이 쓸 수 있다(`select payment_type, count(*) from payment group by payment_type`).
- **`CHECK` 제약이나 부분 인덱스의 조건으로 쓸 수 있다.**
- **자식 테이블 조인 없이 타입만 필요할 때 Hibernate가 그 컬럼을 이용할 여지가 생긴다.** (실제 SQL은 반드시 로그로 확인하라.)

> **가산점 포인트**: 구분 컬럼을 엔티티 필드로도 읽고 싶으면 **읽기 전용으로 매핑한다** — `@Column(name = "payment_type", insertable = false, updatable = false)`. 그러지 않으면 Hibernate가 관리하는 컬럼과 내 필드가 같은 컬럼을 두 번 쓰겠다고 다투게 된다. 또한 이미 운영 중인 레거시 테이블처럼 **구분 값이 컬럼 하나로 깔끔하게 안 떨어지는 경우**엔 Hibernate의 `@DiscriminatorFormula`로 SQL 식을 구분자로 쓸 수 있다.

### 2-4. `SINGLE_TABLE`의 무결성 구멍 — 왜 `NOT NULL`을 못 걸고, 무엇으로 막는가

#### 왜 못 거는가 — 데이터를 직접 보면 즉시 이해된다

`NOT NULL`은 **"이 컬럼은 모든 행에서 값이 있어야 한다"** 는 제약이다. 그런데 `SINGLE_TABLE`에서는 한 테이블에 서로 다른 타입의 행이 섞여 살고, 자식 고유 컬럼은 **자기 타입 행에서만 값이 있고 나머지 타입 행에서는 반드시 비어 있어야 한다.**

§1-3의 그림에서 `card_number` 컬럼만 세로로 뽑아 보자.

```text
payment 테이블의 card_number 컬럼 하나만 세로로 본다

  payment_id │ payment_type │ card_number │ card_number 에 요구되는 규칙
 ────────────┼──────────────┼─────────────┼──────────────────────────────
         101 │ CARD         │ 1234-****   │ 반드시 있어야 한다   (필수)
         104 │ CARD         │ 5678-****   │ 반드시 있어야 한다   (필수)
         102 │ BANK         │ (null)      │ 반드시 없어야 한다   (금지)
         103 │ POINT        │ (null)      │ 반드시 없어야 한다   (금지)

  → 한 컬럼에 "필수"와 "금지"라는 두 규칙이 행마다 갈라져 걸린다.
  → NOT NULL 은 "전부 필수"만 표현할 수 있다. 조건부 표현이 불가능하다.
  → 그래서 NOT NULL 을 걸면 102, 103 행이 아예 저장되지 못한다.
     결국 nullable 로 열어두게 되고, 그 순간 DB 는 아무것도 지켜주지 않는다.
```

이 표가 `SINGLE_TABLE`의 무결성 구멍 그 자체다. **컬럼 하나에 두 개의 상반된 규칙이 필요한데 `NOT NULL`은 규칙을 하나만 표현할 수 있다.** 그래서 필요한 것이 **조건부 제약**, 즉 `CHECK`다.

그리고 이 구멍이 실제로 만들어내는 쓰레기 데이터는 두 방향이다.

```text
방향 A — "카드 결제인데 카드번호가 없다"
  payment_id=105, payment_type='CARD', card_number=(null)
  → 상세 화면에서 NPE. 원인은 대체로 저장 로직의 누락.

방향 B — "포인트 결제인데 카드번호가 들어 있다"   ← 이쪽이 더 흔하고 더 늦게 발견된다
  payment_id=106, payment_type='POINT', card_number='1234-****'
  → 화면에는 안 보이니 아무도 모른다. 나중에 정산·통계 쿼리에서 숫자가 안 맞는다.
```

#### 방어 ① — DB `CHECK` 제약 (PostgreSQL 기준)

`CHECK` 제약은 **"행이 저장될 때 이 조건식이 참이어야 한다"** 는 규칙이다. 조건식 안에서 다른 컬럼을 참조할 수 있으므로, "구분 컬럼이 이 값일 때만"이라는 조건부 표현이 가능하다.

```sql
-- PostgreSQL. 카드 결제라면 카드 관련 컬럼이 반드시 있어야 하고,
-- 카드 결제가 아니라면 그 컬럼들은 반드시 비어 있어야 한다.
alter table payment add constraint ck_payment_card check (
    (payment_type <> 'CARD' or (card_number is not null and installment is not null))
and (payment_type =  'CARD' or (card_number is     null and installment is     null))
);

alter table payment add constraint ck_payment_bank check (
    (payment_type <> 'BANK' or (account_no is not null and bank_code is not null))
and (payment_type =  'BANK' or (account_no is     null and bank_code is     null))
);
```

조건식이 `or`로 된 이유를 풀어 두자. `A or B` 형태는 **"A가 아니면 B여야 한다"** 는 함의를 SQL로 쓴 것이다. 첫 줄 `payment_type <> 'CARD' or (...)` 는 **"카드가 아니거나, 아니면 카드 컬럼들이 채워져 있어야 한다"** = "카드면 카드 컬럼이 채워져야 한다"이고, 둘째 줄은 그 반대 방향이다.

**두 방향을 모두 걸어야 한다.** 앞줄만 걸면 방향 A는 막지만 **방향 B(포인트 결제인데 카드번호가 들어 있는 행)** 는 그대로 통과한다. 실무에서 더 흔하고 더 찾기 어려운 것이 방향 B다.

#### 운영 중인 테이블에 제약을 붙일 때 — PostgreSQL의 `NOT VALID`

수억 행이 이미 있는 테이블에 `CHECK`를 그냥 붙이면, PostgreSQL은 **기존 행 전부를 검사하는 동안 테이블에 `ACCESS EXCLUSIVE` 락(읽기까지 막는 가장 강한 락)을 잡는다.** 운영 중에는 쓸 수 없는 방식이다.

그래서 두 단계로 나눈다.

```sql
-- ① NOT VALID 로 붙인다 — 기존 행은 검사하지 않는다. 락 시간이 사실상 0 이다.
--    이 순간부터 새로 들어오거나 수정되는 행에는 제약이 적용된다.
alter table payment add constraint ck_payment_card check (
    (payment_type <> 'CARD' or (card_number is not null and installment is not null))
and (payment_type =  'CARD' or (card_number is     null and installment is     null))
) not valid;

-- ② 기존 데이터를 정리한 뒤, 별도로 검증한다.
--    VALIDATE 는 SHARE UPDATE EXCLUSIVE 락만 잡으므로 읽기/쓰기를 막지 않는다.
alter table payment validate constraint ck_payment_card;
```

이 두 단계 사이에 **"기존 위반 행을 찾아 고치는 시간"** 이 생긴다는 것이 핵심이다. 그 조회는 제약과 같은 조건식을 `where`에 뒤집어 넣으면 된다.

```sql
-- 이미 들어와 있는 위반 행을 먼저 찾는다
select payment_id, payment_type, card_number, installment
from payment
where not (
    (payment_type <> 'CARD' or (card_number is not null and installment is not null))
and (payment_type =  'CARD' or (card_number is     null and installment is     null))
);
```

#### 방어 ② — PostgreSQL 부분 인덱스로 "자식별 인덱스" 문제까지 회복한다

§1-4의 "포기하는 것"에 **"자식별 인덱스가 전체 행에 걸린다"** 가 있었다. PostgreSQL의 **부분 인덱스(partial index)** — `where` 절이 붙은 인덱스 — 를 쓰면 이 문제를 상당 부분 되돌릴 수 있다.

```sql
-- 카드 결제 행만 색인한다. 포인트/계좌이체 행은 인덱스에 아예 들어가지 않는다.
create index ix_payment_card_number on payment (card_number)
    where payment_type = 'CARD';

-- 유니크 제약도 타입별로 걸 수 있다 — SINGLE_TABLE 에서 특히 유용하다.
create unique index ux_payment_account on payment (account_no)
    where payment_type = 'BANK';
```

인덱스가 작아지므로 탐색도 빨라지고, **"카드 결제 안에서만 유일"** 같은 조건부 유니크 제약도 표현할 수 있게 된다. `SINGLE_TABLE`을 고르면서 무결성 걱정을 하는 상황이라면 이 도구를 알고 있는지가 답변의 깊이를 가른다.

#### 벤더 주의 — `CHECK`가 실제로 검사되는가

- **PostgreSQL**은 `CHECK`를 처음부터 실제로 강제한다. 위 DDL은 그대로 동작한다.
- **MySQL은 8.0.16부터** `CHECK`를 실제로 검사하고, **그 이전 버전은 구문만 받아들이고 조용히 무시한다.** "제약을 걸었다"고 믿는데 아무것도 안 걸려 있는 상태가 최악이므로, **제약을 넣은 뒤 반드시 위반 데이터를 넣어보는 테스트로 실제 작동을 확인**한다.

#### 방어 ③ — 제약을 마이그레이션 스크립트가 아니라 엔티티 옆에 둔다

**제약이 마이그레이션 스크립트에만 있으면 자식이 추가될 때 잊는다.** 결제수단이 15종이면 `CHECK` 절도 15개가 되고, 이건 사람의 기억으로 유지되지 않는다. **엔티티 옆에 붙여 코드로 고정**하면 자식 클래스를 만들 때 같이 눈에 들어온다.

```java
// Hibernate 의 @Check 로 제약을 엔티티 옆에 둔다 — 스키마 생성·검증에 함께 반영된다.
// (Hibernate 6.6: name 은 선택, constraints 는 필수. @Check 는 반복 적용 가능하다.)
@Entity
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name = "payment_type", length = 20)
@org.hibernate.annotations.Check(
    name = "ck_payment_card",
    constraints = "(payment_type <> 'CARD' or (card_number is not null and installment is not null)) " +
                  "and (payment_type = 'CARD' or (card_number is null and installment is null))"
)
public abstract class Payment { ... }
```

#### 방어 ④ — 첫 방어선은 생성자다

**애플리케이션 쪽 방어는 검증 메서드가 아니라 생성자로 한다.** `card_number`가 null인 `CardPayment`를 **애초에 만들 수 없게** 만드는 것이, 만들어 놓고 나중에 검사하는 것보다 강하다.

```java
// Before — 필드를 세터로 채운다. "카드번호 없는 카드결제" 객체가 만들어질 수 있고,
//          그 상태로 저장되면 CHECK 제약이 flush 시점에 터진다.
//          객체를 잘못 만든 지점과 예외가 터지는 지점이 멀어서 원인 추적이 어렵다.
CardPayment p = new CardPayment();
p.setAmount(amount);
p.setCardNumber(cardNumber);   // 이 줄을 빼먹어도 컴파일된다

// After — 필수값을 생성자에서 받고 거기서 검증한다. 불완전한 객체가 존재할 수 없다.
public CardPayment(BigDecimal amount, String cardNumber, int installment) {
    super(amount);
    if (cardNumber == null || cardNumber.isBlank())
        throw new IllegalArgumentException("카드 결제는 카드번호가 필수다");
    if (installment < 0)
        throw new IllegalArgumentException("할부개월은 음수일 수 없다");
    this.cardNumber = cardNumber;
    this.installment = installment;
}
```

**`CHECK` 제약은 최후 방어선이고, 생성자는 첫 방어선이다.** 둘 다 있어야 "코드로 막고, DB로도 막았다"가 된다.

### 2-5. 자식이 3종에서 15종이 되면 문제의 성질이 바뀐다 (시니어 변별 지점)

`JOINED`의 부모 타입 목록 조회는 자식 테이블 전부에 `LEFT OUTER JOIN`이 붙는다고 했다. 자식이 3종이면 조인 3개, 15종이면 조인 15개다. 그런데 **"조인 15개는 조인 3개보다 5배 느리다"가 아니다.** 어느 지점부터 **문제의 종류 자체가 바뀐다.** 이걸 말할 수 있느냐가 이 문항의 시니어 변별점이다.

#### 겹치는 두 가지

**첫째, 행 하나마다 15번의 PK 조회가 붙는다.** outer join 각각은 PK 기준 1건 매칭이라 개별 비용은 작다. 하지만 **20건 페이징이면 20 × 15 = 300번의 인덱스 탐색**이고, 여기에 목록 화면의 호출량이 곱해진다. 이건 예측 가능한, 선형으로 증가하는 비용이다.

**둘째 — 이쪽이 진짜다 — 옵티마이저가 실행계획을 잘못 잡기 시작한다.**

#### 왜 조인이 많아지면 옵티마이저가 틀리는가

먼저 옵티마이저가 하는 일을 한 문장으로 정의하자. **옵티마이저(optimizer)는 같은 결과를 내는 여러 실행 방법 중에서 가장 싸 보이는 하나를 고르는 DB의 부품**이다. 조인 쿼리에서 가장 큰 선택지는 **조인 순서** — 어느 테이블을 먼저 읽고 어디에 붙일 것인가 — 인데, 이 선택지의 개수가 테이블 수에 따라 **조합적으로 폭발한다.**

```text
조인 순서 후보의 개수 (테이블 n개를 줄 세우는 경우의 수 = n!)

  부모 1 + 자식  3 = 테이블  4개  →   4! =                    24 가지
  부모 1 + 자식  5 = 테이블  6개  →   6! =                   720 가지
  부모 1 + 자식  9 = 테이블 10개  →  10! =             3,628,800 가지
  부모 1 + 자식 15 = 테이블 16개  →  16! = 20,922,789,888,000 가지 (약 2.1 × 10^13)

  24가지는 전부 계산해 보고 고를 수 있다.
  20조 가지는 계산해 볼 수 없다. 쿼리 하나 계획 짜다가 하루가 간다.
```

그래서 **모든 DB는 어느 지점부터 "전부 검토하기"를 포기하고 휴리스틱(경험적 어림짐작)으로 전환한다.** 이건 버그가 아니라 설계다 — 최적 계획을 찾느라 쿼리보다 오래 걸리면 의미가 없기 때문이다.

- **PostgreSQL**: `geqo_threshold` 설정의 기본값이 **12**다. `FROM` 항목이 12개 이상이면 완전 탐색(동적 계획법)을 그만두고 **GEQO(유전 알고리즘 기반 탐색)** 로 전환한다. GEQO는 탐색 공간 전체가 아니라 **일부만 샘플링해서** 괜찮아 보이는 것을 고른다. 즉 **자식이 11종을 넘는 순간(부모 1 + 자식 11 = 12) 계획을 고르는 방식 자체가 바뀐다.**
- **MySQL**: `optimizer_prune_level`의 기본값이 **1**이라, 유망해 보이지 않는 부분 계획을 **중간에 잘라낸다.** `optimizer_search_depth`(기본 62)가 탐색 깊이의 상한을 둔다.

**핵심은 이것이다 — 조인이 일정 개수를 넘으면 옵티마이저는 "최적 계획"을 찾는 것이 아니라 "괜찮아 보이는 계획"을 찾는다.** 그리고 "괜찮아 보이는"의 판단 근거는 **통계 정보**(각 테이블에 행이 몇 개이고 값 분포가 어떤지에 대한 DB의 추정치)인데, 통계는 실제 데이터보다 항상 조금 낡아 있다. 탐색 공간의 일부만 보면서 낡은 추정치에 의존하면, **입력이 조금만 흔들려도 결과가 크게 튄다.**

#### 그래서 두 가지 증상으로 나타난다

- **같은 쿼리가 어제와 다른 계획으로 실행된다.** 통계가 조금 틀어지거나 데이터 분포가 바뀌면 옵티마이저가 다른 계획을 고른다. 어제 30ms였던 목록 조회가 오늘 3초가 된다. **배포한 것도 없는데 느려진다.**
- **`order by ... limit 20`을 인덱스로 처리하지 못하는 계획으로 넘어갈 수 있다.** 원래는 `paid_at` 인덱스를 정렬된 순서로 20건만 훑고 끝내면 되는데, 계획이 바뀌면 **조인 결과를 전부 만든 뒤 정렬**하게 된다. 이 순간 페이징의 전제(20건만 만지면 된다)가 통째로 깨진다.

#### 왜 "느려짐"보다 "불안정해짐"이 더 나쁜가

**조인 비용은 예측 가능하게 나빠지지만, 옵티마이저 오판은 예측 불가능하게 나빠진다.**

여기서 **p99**라는 지표를 정의하고 가자. **p99(99번째 백분위수)는 요청들의 응답 시간을 빠른 순으로 줄 세웠을 때, 위에서 99%지점에 있는 값**이다. 요청 1,000건이면 990번째로 느린 값이고, "요청의 99%는 이 시간 안에 끝난다"는 상한을 뜻한다. 평균이 "보통 얼마나 빠른가"를 보여준다면, **p99는 "가장 느린 1%가 얼마나 나쁜가"** 를 보여준다.

```text
평균은 멀쩡한데 p99 가 무너지는 그림

  응답 시간을 빠른 순으로 1,000건 줄 세우면

   1번째 ────────────────────────────────── 990번째 ─── 1000번째
    25ms          대부분 30ms 근처              3,200ms      8,900ms
                       │                          │
                    평균 ≈ 42ms                  p99 = 3,200ms
                  "지표상 아무 문제 없음"      "100명 중 1명은 3초를 기다린다"

  → 평균만 보는 대시보드에서는 이 장애가 보이지 않는다.
  → 사용자 제보("가끔 엄청 느려요")로 먼저 알게 되고, 재현이 안 된다.
```

옵티마이저가 계획을 잘못 잡는 것은 **모든 요청에 균일하게 일어나지 않는다.** 조건 값에 따라, 통계 갱신 타이밍에 따라 일부 요청만 나쁜 계획으로 실행된다. 그래서 평균은 멀쩡하고 p99만 무너지며, **재현이 안 되고, 배포한 것도 없는데 어제부터 느려졌다**는 형태로 온다.

**그래서 처방도 다르다.** 조인 비용은 인덱스를 추가해 줄일 수 있지만, **옵티마이저 오판은 인덱스로 해결되지 않는다 — 쿼리에 등장하는 테이블 수 자체를 줄여야 한다.** 그 방법이 §2-7이다.

> **가산점 포인트**: 여기까지 말하면 시니어 신호가 된다. "조인이 15개면 느립니다"는 누구나 말한다. **"조인 개수가 임계를 넘으면 성능이 느려지는 게 아니라 불안정해집니다 — 그리고 불안정한 게 더 나쁩니다"** 가 경험에서 나오는 문장이다.

### 2-6. 6개월 뒤 요구가 바뀐다 — "목록에도 자식 고유 필드를 보여달라"

이것이 이 문항의 진짜 시험이다. 처음 결정할 때는 목록이 공통 필드만 쓴다고 했다. 6개월 뒤 기획이 온다 — **"목록에서 카드면 할부개월, 계좌이체면 은행명을 함께 보여주세요."** 하루 수십만 건 호출되는 페이징 화면이다.

전제가 하나 바뀌었을 뿐인데 세 전략에서 벌어지는 일이 완전히 다르다.

#### `JOINED`에서 벌어지는 일

```sql
-- Before — 목록에 공통 필드만 노출하던 시절 (DTO 프로젝션으로 조회했다면)
select p.payment_id, p.amount, p.paid_at, p.status
from payment p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
-- 부모 테이블 하나. 좁은 행. order by + limit 이 인덱스로 처리된다.

-- After — 자식 고유 필드가 필요해진 순간
select p.payment_id, p.amount, p.paid_at, p.status,
       c.installment, b.bank_code, pt.point_wallet_id      -- 자식 컬럼이 필요하다
from payment p
left outer join card_payment          c  on p.payment_id = c.payment_id
left outer join bank_transfer_payment b  on p.payment_id = b.payment_id
left outer join point_payment         pt on p.payment_id = pt.payment_id
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
-- 자식 수만큼 outer join. 결제수단이 15종이 되면 outer join 15개.
-- 그리고 §2-5 의 문제가 시작된다 — 느려지는 게 아니라 불안정해진다.
```

**핵심**: `JOINED`에서 이 요구는 **회피 불가능한 구조적 비용**을 만든다. 조인은 인덱스로 줄일 수 있는 종류의 비용이 아니다 — **필요한 데이터가 물리적으로 다른 테이블에 흩어져 있기 때문**이다. 그리고 자식이 늘어날 때마다 목록 쿼리가 자동으로 무거워진다. **아무도 목록 화면 코드를 건드리지 않았는데** 성능이 나빠지는 구조다.

#### `SINGLE_TABLE`에서 벌어지는 일

```sql
-- Before
select p.payment_id, p.amount, p.paid_at, p.status
from payment p where p.paid_at between ? and ? order by p.paid_at desc limit 20

-- After — 컬럼 목록만 늘어난다. 조인은 여전히 0
select p.payment_id, p.amount, p.paid_at, p.status,
       p.installment, p.bank_code, p.point_wallet_id
from payment p where p.paid_at between ? and ? order by p.paid_at desc limit 20
-- 쿼리의 "모양"이 안 바뀐다. 결제수단이 15종이 되어도 조인은 0.
```

**`SINGLE_TABLE`이 이 요구를 거의 공짜로 흡수한다.** 그래서 "조회 트래픽이 지배적이면 애초에 `SINGLE_TABLE`이 맞지 않았나?"라는 반박이 성립한다.

**그러나 공짜는 아니다.** 6개월 동안 결제수단이 3종에서 8종으로 늘었다면 그 테이블은 이미 **공통 5개 + 8종 × 자식당 3~4개 ≒ 컬럼 30~40개**짜리가 되어 있고, 행이 넓어져 **같은 20건을 읽는 데 더 많은 데이터 페이지를 만진다.** 그리고 `CHECK` 제약은 8개로 늘어 있어야 한다. **얻은 것은 "쿼리 모양의 안정성", 지불한 것은 "테이블 비대와 무결성을 사람이 관리하는 비용"** 이다.

#### `TABLE_PER_CLASS`에서 벌어지는 일

**가장 나쁘다.** 목록이 자식 필드를 요구하는지 여부와 무관하게, **부모 타입 페이징 자체가 이미 `UNION ALL` 전체 스캔**이었다. 요구가 추가되면 union 각 항의 컬럼 목록이 늘어날 뿐이고, `order by ... limit`은 여전히 합집합을 다 만든 뒤에야 적용된다. **하루 수십만 건 호출되는 화면에서는 쓸 수 없다.**

### 2-7. 전략을 바꾸지 않고 푸는 길 — 여기가 실무의 정답이다

`JOINED`에서 이 요구가 왔다고 **전략을 바꾸면 안 된다.** 전략 변경은 데이터 마이그레이션이고, 그건 이 문제의 크기에 비해 과한 대가다. **쿼리를 바꿔서 푼다.** 위에서부터 순서대로 시도한다.

#### ① 목록은 엔티티가 아니라 DTO로 조회한다 — 필요한 자식 컬럼만 좁힌다

```java
// Before — 엔티티로 목록을 조회한다. Hibernate 는 완성된 자식 인스턴스를 만들어야 하므로
//          화면이 쓰지 않는 자식 컬럼까지 전부 outer join 해서 읽는다.
Page<Payment> page = paymentRepository.findByPaidAtBetween(from, to, pageable);

// After — 화면이 실제로 쓰는 필드만 DTO 로 뽑는다.
//         쿼리에서 참조하지 않은 자식 테이블은 조인 대상에 아예 등장하지 않는다.
@Query("""
    select new com.example.PaymentRowDto(p.id, p.amount, p.paidAt, p.status,
                                        c.installment, b.bankCode)
    from Payment p
      left join CardPayment         c  on c.id = p.id
      left join BankTransferPayment b  on b.id = p.id
    where p.paidAt between :from and :to
    """)
Page<PaymentRowDto> findRows(@Param("from") LocalDateTime from,
                             @Param("to")   LocalDateTime to, Pageable pageable);
// 자식이 15종이어도 화면이 두 종의 필드만 쓴다면 조인은 2개다.
// 조인 개수를 "자식 수"에서 "화면이 실제로 쓰는 자식 수"로 떨어뜨린 것이 이 처방의 전부다.
```

조인 대상 테이블이 16개에서 3개로 줄면 §2-5의 조합 폭발도 함께 사라진다. `3! = 6`가지는 옵티마이저가 전부 검토하고 최선을 고를 수 있는 규모다. **"쿼리 모양을 바꿔야 한다"는 말의 구체적 의미가 이것이다.**

#### ② 그래도 무거우면, 목록 전용 읽기 모델을 만든다 — 표시용 요약을 부모 테이블에 비정규화

목록에 필요한 것은 대개 **"할부개월 3"이 아니라 "카드 3개월"이라는 한 줄 문자열**이다. 그렇다면 그 문자열을 부모 테이블에 컬럼 하나로 갖는다.

```java
// Payment 에 표시용 요약 컬럼을 둔다. 값은 저장 시점에 자식이 스스로 만든다.
@Column(name = "method_label", length = 60, nullable = false)
private String methodLabel;          // "카드 3개월" / "국민은행" / "포인트"

protected abstract String buildMethodLabel();   // 자식이 자기 표시 문구를 만든다

// 저장·수정 직전에 호출되어 요약 컬럼을 최신 상태로 맞춘다
@PrePersist @PreUpdate
void refreshLabel() { this.methodLabel = buildMethodLabel(); }
```

```sql
-- 목록 조회에서 조인이 완전히 사라진다. 자식이 몇 종이 되어도 이 쿼리는 안 변한다.
select p.payment_id, p.amount, p.paid_at, p.status, p.method_label
from payment p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
```

**대가를 정직하게 말해야 한다.** 같은 정보가 두 곳에 존재하므로 **동기화 책임**이 생긴다. `@PrePersist`/`@PreUpdate`로 코드에 고정하되, **벌크 UPDATE(JPQL `update ...` 문)는 이 콜백을 타지 않는다**는 것을 반드시 기억한다 — 영속성 컨텍스트를 우회해 DB에 직접 나가는 SQL이기 때문이다. 그리고 표시 문구 규칙이 바뀌면 **과거 데이터의 일괄 갱신**이 필요하다.

이건 "정규화를 깨고 조회 성능을 산" 거래이고, **화면 표시용이며 검색 대상이 아닐 때만** 정당하다.

#### ③ 목록 화면을 타입별로 쪼갤 수 있는지 기획과 협상한다

`JOINED`에서 **자식 타입으로 특정한 조회는 형제 테이블을 건드리지 않는다.** 화면에 "결제수단" 필터가 있다면(대개 있다) 그 필터가 선택된 경우는 조인 1회로 끝난다.

**즉 무거운 것은 "전체" 탭 하나뿐**이므로, 기본 필터를 강제하거나 "전체" 탭의 조회 기간을 좁히는 것만으로 문제의 90%가 사라지는 경우가 많다. **요구사항을 협상하는 것도 처방이다.**

#### ④ 마지막 수단이 전략 변경이다

그리고 그건 §3-4의 마이그레이션 이야기다.

---

## 3. 판단 — 무엇을 고르고, 언제 상속 자체를 접을 것인가

### 3-1. `@MappedSuperclass` — 공통 컬럼만 물려주고, 다형성은 포기한다

세 전략 중 하나만 말하면 **주어진 보기 안에서만 생각한 것**이 된다. 실무에서는 **`@Inheritance`를 안 쓰는 답이 더 자주 정답**이다. 그 첫 번째가 `@MappedSuperclass`다.

`@MappedSuperclass`는 **"이 클래스는 엔티티가 아니라 컬럼 묶음일 뿐이니, 상속받는 엔티티의 테이블에 이 필드들을 그냥 포함시켜라"** 는 선언이다. 부모가 엔티티가 아니라는 것이 전부이자 핵심이다.

```java
// Before — 부모를 엔티티로 만들었다. 다형성 조회를 위해 세 전략 중 하나를 골라야 한다.
@Entity
@Inheritance(strategy = InheritanceType.TABLE_PER_CLASS)
public abstract class Payment { ... }

// After — 부모를 "컬럼 묶음"으로만 쓴다. 엔티티가 아니다.
@MappedSuperclass
public abstract class PaymentBase {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)   // IDENTITY 를 쓸 수 있다
    private Long id;
    private BigDecimal amount;
    private LocalDateTime paidAt;
    @Enumerated(EnumType.STRING) private PaymentStatus status;
}

@Entity
public class CardPayment extends PaymentBase {      // 독립 엔티티. 테이블도 독립.
    @Column(nullable = false) private String cardNumber;
    @Column(nullable = false) private int installment;
}
```

DDL은 `TABLE_PER_CLASS`와 거의 같다 — 자식마다 공통 컬럼이 복제된 독립 테이블이다. 차이는 **JPA가 이 계층을 상속으로 인식하지 않는다**는 것 하나뿐인데, 그 하나에서 모든 차이가 나온다.

**얻는 것**: JPA가 상속으로 안 보므로 **`UNION ALL`이 생길 여지가 없다.** 계층 전체의 id 유일성을 요구하지 않으므로 **`IDENTITY`를 쓸 수 있다.** 자식마다 완전히 독립적으로 진화할 수 있고, 매핑이 단순해 사고가 날 여지가 적다.

**포기하는 것**: **`select p from PaymentBase p`가 불가능하다.** `PaymentBase`는 엔티티가 아니므로 JPQL의 조회 대상도, `@ManyToOne`의 타겟도 될 수 없다. 즉 **다형성을 완전히 포기**한다. "모든 결제 목록"이 필요하면 세 번 조회해서 애플리케이션에서 합치거나, 별도의 읽기 모델(DB 뷰나 전용 테이블)을 만들어야 한다.

> **판단 규칙 하나** — **`TABLE_PER_CLASS`를 고민하고 있다면, 대개 정답은 `@MappedSuperclass`다.** `TABLE_PER_CLASS`가 성립하는 조건("부모 타입 조회를 안 한다")이 곧 `@MappedSuperclass`를 쓸 수 있는 조건이고, `@MappedSuperclass`는 그 대가(`UNION ALL`, `IDENTITY` 불가)를 안 낸다. **`TABLE_PER_CLASS`를 고르는 것은 "쓰지 않을 다형성"을 위해 비용을 내는 일**이다.

### 3-2. 컴포지션 + JSON 컬럼 — 스키마 변경 없이 결제수단을 추가한다

두 번째 선택지는 상속을 아예 버리는 것이다. **"결제수단 종류"를 값(enum)으로, "수단별 상세"를 JSON 한 칸으로** 담는다. 상속(is-a) 대신 **컴포지션(has-a)** 으로 모델을 바꾸는 것이다.

```java
// Before — 결제수단마다 클래스와 테이블(또는 컬럼)이 늘어난다
@Entity class CardPayment extends Payment { ... }
@Entity class BankTransferPayment extends Payment { ... }
@Entity class PointPayment extends Payment { ... }
// 결제수단 하나 추가 = 클래스 추가 + DDL 변경 + 배포

// After — 테이블은 하나, 클래스도 하나. 수단별 속성은 JSON 한 칸에.
@Entity
public class Payment {
    @Id @GeneratedValue private Long id;
    private BigDecimal amount;
    private LocalDateTime paidAt;
    @Enumerated(EnumType.STRING) private PaymentMethod method;   // CARD / BANK / POINT / ...

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "method_detail", columnDefinition = "jsonb")
    private Map<String, Object> methodDetail;    // {"cardNumber":"...","installment":3}
}
// 결제수단 하나 추가 = enum 상수 + 검증 로직. DDL 변경 0.
```

**얻는 것**: 결제수단 추가에 **DDL이 필요 없다.** nullable 컬럼도 늘지 않고 조인도 없다. 외부 결제대행사(PG) 응답 원문처럼 **스키마가 우리 통제 밖에 있는 데이터**를 담기에 특히 좋다.

**포기하는 것**: **그 속성으로 검색·정렬·제약을 걸 수 없다.** "할부 3개월 이상 결제를 모아 보여줘"가 인덱스로 처리되지 않고, `bank_code`에 FK를 걸 수도 없다. **타입 안전성도 사라진다** — `Map<String,Object>`에 무엇이 들어 있는지는 컴파일러가 모르므로, 스키마 검증 책임이 전부 애플리케이션으로 넘어온다. 그래서 실무에서는 `Map`이 아니라 수단별 `sealed` 클래스로 역직렬화해 타입을 되찾는다.

**부분적인 회복은 가능하다.** 자주 검색하는 키만 **생성 컬럼(generated column)으로 꺼내 인덱스를 걸면** 그 키에 한해 검색 성능을 되찾을 수 있다. PostgreSQL이라면 `jsonb` 표현식에 직접 인덱스를 걸 수도 있다(`create index ... on payment ((method_detail->>'bankCode'))`). 즉 "전부 JSON"이 아니라 **"검색 대상은 컬럼, 표시 전용은 JSON"** 이 실전 구성이다.

**언제 쓰는가**: 자식 고유 속성이 **표시·감사(audit) 목적이고 검색 조건이 아닐 때**, 그리고 **종류가 빠르게 늘어날 때**. 반대로 "은행코드로 정산 집계를 낸다" 같은 요구가 있으면 그 값은 JSON에 두면 안 된다.

### 3-3. 두 축, 그리고 미래로 정한다

선택 기준을 한 문장으로 고정한다.

> **"자식 고유 컬럼이 적고 부모 타입 조회가 지배적이면 `SINGLE_TABLE`, 자식 고유 컬럼이 많고 무결성이 중요하며 목록에 자식 필드가 불필요하면 `JOINED`, 부모 타입 조회를 아예 안 하면 상속을 테이블로 내리지 않는다(`@MappedSuperclass`). `TABLE_PER_CLASS`는 그 사이에 낀 좁은 경우뿐이다."**

여기에 **시제**를 붙여야 완성이다.

**전략 변경은 데이터 마이그레이션이다.** `SINGLE_TABLE` → `JOINED`는 컬럼을 새 테이블로 옮기고 원본을 지우는 작업이고, 그 과정에서 무중단을 유지해야 하며, 롤백 계획도 있어야 한다. 애노테이션 한 줄을 바꾸는 일처럼 보이지만 **가장 되돌리기 비싼 결정 중 하나**다.

그래서 판단 기준은 **현재가 아니라 미래**여야 한다.

- 틀린 기준: "지금 결제수단이 3개니까 조인 3개는 괜찮다"
- 옳은 기준: "**3년 뒤 결제수단이 몇 종이 될 것이고, 그때 목록 화면이 자식 필드를 요구할 것인가**"

시나리오에는 이미 답이 있었다 — **"결제수단은 계속 늘어날 예정"**. 이 한 줄이 "조인 개수가 계속 늘어난다"를 뜻하므로, `JOINED`를 고르려면 **§2-7의 처방(목록은 DTO로, 필요하면 표시용 요약 컬럼)을 처음부터 설계에 포함**해야 한다. **전략 선택과 조회 설계는 한 세트다.**

### 3-4. 이미 운영 중인 것을 바꿔야 한다면

`SINGLE_TABLE` → `JOINED` 전환의 순서만 말할 수 있으면 된다.

```text
[전략 전환 5단계] — 각 단계 사이에 롤백 가능 지점이 있다는 것이 핵심

 ① 자식 테이블 생성        기존 컬럼은 그대로 둔다. 읽지도 쓰지도 않는 빈 테이블.
        │                  롤백: 테이블만 지우면 된다.
        ▼
 ② 쓰기 이중화             애플리케이션이 기존 컬럼과 새 자식 테이블에 동시에 기록.
        │                  롤백: 자식 테이블 쓰기만 끄면 된다. 아직 자유롭다.
        ▼
 ③ 과거 데이터 백필         청크로 나눠 옮긴다. 옮긴 뒤 양쪽 값이 같은지 검증 쿼리로 확인.
        │                  검증 없이 ④로 넘어가지 않는다. 이 문장이 이 절차의 전부다.
        ▼
 ④ 읽기 전환               매핑을 JOINED 로 바꾼다.
        │                  롤백: 읽기만 되돌린다. 데이터는 양쪽에 다 있으므로 안전하다.
        ▼
 ⑤ 기존 컬럼 제거           여기서부터 되돌릴 수 없다. 그래서 가장 마지막이다.
```

핵심은 **"애노테이션을 바꾸고 배포"가 아니라 "쓰기 이중화 → 백필 → 검증 → 읽기 전환 → 정리"** 라는 다섯 단계라는 것, 그리고 **각 단계 사이에 롤백 가능 지점이 있다**는 것이다.

### 3-5. 결정을 눈으로 확인하고, 테스트로 고정한다

세 전략의 차이는 **전부 SQL에 나타난다.** 그러니 **찍어 보면 끝난다.** 상속 전략을 고를 때 다음을 반드시 한다.

```yaml
# 개발·테스트 환경에서 SQL 을 눈으로 본다
spring:
  jpa:
    show-sql: true
    properties:
      hibernate:
        format_sql: true
logging:
  level:
    org.hibernate.SQL: debug
    org.hibernate.orm.jdbc.bind: trace   # 바인딩된 실제 파라미터 값까지
```

- **p6spy나 datasource-proxy**로 **완성된 SQL 한 줄**을 본다. 파라미터가 물음표가 아니라 실제 값으로 박힌 형태여야 `EXPLAIN`에 바로 붙일 수 있다.
- 목록 쿼리를 **`EXPLAIN`으로 확인**한다. 조인 개수, 조인 순서, `order by`가 인덱스로 처리되는지(정렬을 위한 별도 작업이 생기는지), `limit`이 조기 종료로 이어지는지를 본다.
- **`SINGLE_TABLE`과 `JOINED`를 둘 다 만들어 같은 데이터로 재보는 것**이 가장 확실하다. 프로토타입 두 개는 마이그레이션 한 번보다 압도적으로 싸다.

그리고 **자식이 추가될 때 자동으로 경고가 오게** 만든다. 이 문항의 위험은 "처음엔 괜찮았는데 자식이 늘면서 조용히 무거워지는" 형태로 오기 때문이다.

```java
// 목록 조회가 만드는 쿼리 수·조인 수를 테스트로 단정한다.
// 결제수단이 추가되면서 조인이 늘면 이 테스트가 먼저 깨진다 — 운영이 아니라 CI 에서.
@Test
void 결제_목록_조회는_쿼리_한_방에_끝나야_한다() {
    SQLStatementCountValidator.reset();

    List<PaymentRowDto> rows = paymentQueryRepository.findRows(from, to, PageRequest.of(0, 20));

    SQLStatementCountValidator.assertSelectCount(1);   // 쿼리 수 고정
    assertThat(rows).hasSize(20);
}
```

> **왜 이걸 강조하는가** — 상속 매핑은 **"문제를 만나면 잘 푸는데, 문제가 오기 전에 잡는 장치를 만드는 습관"** 이 없으면 가장 크게 물리는 주제다. 잘못 고른 대가를 3년 뒤 마이그레이션으로 갚기 때문이다. **결정 근거를 SQL 로그로 남기고, 그 근거가 깨지는 순간을 테스트로 잡는다.**

### 3-6. 알아두면 점수가 되는 주변 사실 (가산점 포인트)

**① 부모 엔티티는 추상 클래스로 만들어라.**

`Payment`가 구체 클래스면 **"자식 중 어느 것도 아닌 Payment"** 인스턴스를 만들어 저장할 수 있다. `SINGLE_TABLE`이면 구분 값이 `'Payment'`인 행이 생기고, `JOINED`면 자식 테이블에 짝이 없는 부모 행이 생긴다. **도메인에 존재하지 않는 상태가 데이터로 만들어진다.** `abstract`로 선언하면 컴파일러가 그 실수를 막아준다.

**② `JOINED`에서 자식 테이블 PK 이름은 `@PrimaryKeyJoinColumn`으로 정한다.**

기본값은 부모의 PK 컬럼 이름을 그대로 쓴다. 팀 컨벤션이 `card_payment_id` 같은 형태라면 `@PrimaryKeyJoinColumn(name = "...")`으로 지정한다. 그리고 **자식 PK는 그 자체가 부모를 향한 FK**이므로, 이 FK 덕분에 "자식은 있는데 부모가 없는" 상태가 DB 수준에서 불가능해진다 — `JOINED`가 무결성에서 강한 이유의 절반이 이것이다.

**③ 자식 타입만 조회할 때의 전략별 비대칭.**

- `SINGLE_TABLE`: `where payment_type = 'CARD'` — **전체 테이블에서 걸러낸다.** 카드 결제가 전체의 1%면 그 1%를 찾기 위해 구분 컬럼 인덱스가 필요하다.
- `JOINED`: `card_payment` 테이블 자체가 이미 카드 결제만 담고 있다. **자연스러운 파티셔닝**이다.
- `TABLE_PER_CLASS`: 위와 같고 조인조차 없다.

즉 **"자식 타입별 조회가 잦다"는 축은 `JOINED` 쪽에 점수를 준다.** 두 축(자식 컬럼 양 / 다형성 조회 빈도)에 덧붙일 수 있는 세 번째 관점이다.

**④ `@Inheritance`가 걸려 있으면 다른 최적화가 꺼지기도 한다.**

Hibernate에는 "초기화되지 않은 프록시를 로딩 없이 바로 삭제하는" 최적화 경로가 있는데, **엔티티에 상속 서브클래스가 있으면 이 최적화가 적용되지 않는다.** 어느 테이블을 지워야 하는지 알려면 타입을 먼저 알아야 하기 때문이다. 즉 `delete(getReferenceById(id))`로 SELECT를 없애는 기법이 상속 계층에서는 기대대로 동작하지 않을 수 있다. **상속 매핑은 그 엔티티 하나의 문제로 끝나지 않는다** — 자세한 조건은 [findById vs getReferenceById](16-find-by-id-vs-get-reference-by-id.md)에 있다.

**⑤ 상속 계층에 걸린 `@ManyToOne`은 무엇을 참조하는가.**

`Refund`가 `@ManyToOne Payment payment`를 갖는다면 —

- `SINGLE_TABLE` / `JOINED`: `refund.payment_id`가 **`payment` 테이블을 참조하는 정상 FK**다. 타입이 무엇이든 상관없다.
- `TABLE_PER_CLASS`: 참조할 단일 테이블이 없다. FK를 걸 수 없고, 그 연관을 따라가는 조회는 `UNION`을 타게 된다. **다른 애그리거트가 "결제"를 참조하는 순간 이 전략은 탈락**이라고 봐도 된다.

**⑥ 세 전략 모두 "타입을 바꾸는 것"은 지원하지 않는다.**

카드 결제를 계좌이체 결제로 **타입만 바꿔서** 저장하는 것은 JPA에서 불가능하다. 자바 객체의 클래스를 런타임에 바꿀 수 없기 때문이다. 필요하면 **기존 것을 지우고 새로 만들거나**, 애초에 상속이 아니라 **§3-2의 "수단을 값으로 갖는" 모델**을 택해야 한다. **"타입이 바뀔 수 있는가"는 상속 자체가 적합한지를 가르는 질문**이다 — 상속은 "한번 정해지면 안 바뀌는 종류"를 표현하는 도구다.

---

## 4. 꼬리질문 대비 포인트

### "`JOINED`를 택하겠다고 했습니다. 그 선택이 지불하는 비용을 말해보세요."

세 가지고, **한 호흡에** 말한다.

① **상세 조회마다 부모와 조인 1회** — 상세는 호출량이 적으니 보통 감수한다.

② **부모 타입으로 엔티티를 조회하면 자식 테이블 전부에 `LEFT OUTER JOIN`** — 결과가 완성된 자식 인스턴스여야 하고 자식 테이블에 짝이 없는 경우가 있으므로 outer join이다. 화면이 공통 필드만 쓰더라도 붙는다. **자식이 늘면 조인 개수가 선형으로 늘어난다.**

③ **INSERT가 테이블 수만큼 분할된다** — 한 건 저장에 왕복 2회, 3단 상속이면 3회. `DELETE`도 자식에서 부모 순으로 2문장. 쓰기 비용과 트랜잭션 길이, 락을 잡는 테이블 수가 모두 늘어난다.

그리고 **처방을 붙여서 마무리한다** — "그래서 `JOINED`를 고를 때는 **목록 조회를 처음부터 DTO 프로젝션으로 설계**해서 엔티티 다형성 조회를 피합니다."

### "목록에는 공통 필드만 쓸 겁니다. 그러면 `JOINED`에서 부모 테이블만 읽으면 되는 거 아닌가요?"

**엔티티로 조회하는 한 그렇게 되지 않는다.** `select p from Payment p`의 결과는 `Payment`(추상)가 아니라 **완성된 `CardPayment`·`BankTransferPayment` 인스턴스**여야 하므로, Hibernate는 타입을 판정하고 그 자식의 필드까지 채워야 한다. 그래서 자식 테이블 전부에 `LEFT OUTER JOIN`이 붙는다. **내 화면이 `amount`만 쓴다는 사실을 Hibernate는 알 수 없다.**

부모 테이블만 읽게 하려면 **엔티티가 아니라 DTO로 뽑아야 한다** — 쿼리에서 참조하지 않은 자식 테이블은 조인되지 않는다. 조인 개수를 **"자식 수"에서 "화면이 실제로 쓰는 자식 수"로** 떨어뜨리는 것이 처방의 핵심이다. 그리고 **실제 SQL을 로그로 확인해서 그 처방이 먹혔는지 눈으로 본다.**

### "`TABLE_PER_CLASS`는 `UNION ALL` 말고 또 어떤 결격 사유가 있나요?"

**`IDENTITY` 전략을 쓸 수 없다.** 자동 증가 컬럼은 테이블마다 독립적으로 번호를 매기므로 `card_payment`에도 `payment_id = 1`이, `bank_transfer_payment`에도 `payment_id = 1`이 생긴다. 그러면 **`em.find(Payment.class, 1L)`이 어느 것인지 정할 수 없고, `UNION ALL` 결과에 같은 id가 중복 등장한다.** 계층 전체에서 id가 유일해야 하므로 **`SEQUENCE`나 `TABLE` 생성기가 필수**다. Hibernate는 기동 시점에 `MappingException`으로 이 조합을 거부한다(`Cannot use identity column key generation with <union-subclass> mapping for: ...`).

세 번째도 있다 — **부모 타입으로 FK를 걸 수 없다.** 참조할 단일 부모 테이블이 없으므로 `Refund → Payment` 같은 관계에서 참조 무결성을 DB가 지켜줄 수 없다. 그리고 **공통 컬럼 추가가 모든 자식 테이블 `ALTER`** 다.

### "`SINGLE_TABLE`의 무결성 구멍을 `CHECK`로 막는다고 했습니다. 그 제약은 어떻게 생겼고, 한계는 무엇인가요?"

**양방향으로 걸어야 한다** — "카드 결제면 카드번호가 있어야 한다"와 **"카드 결제가 아니면 카드번호가 없어야 한다"** 둘 다. 앞줄만 걸면 "포인트 결제인데 카드번호가 들어 있는" 쓰레기 데이터를 못 막는데, 실무에서 더 흔하고 더 늦게 발견되는 건 후자다.

한계는 셋이다.

- **벤더 의존이 있다** — PostgreSQL은 처음부터 강제하지만, MySQL은 8.0.16부터 실제로 검사하고 그 이전은 구문만 받고 무시한다. 그래서 **제약을 넣은 뒤 위반 데이터를 넣어보는 테스트로 실제 작동을 확인**해야 한다.
- **개수가 자식 수만큼 늘어난다** — 15종이면 `CHECK` 절도 15개고, 사람의 기억으로 관리해서는 유지되지 않는다. 그래서 Hibernate `@Check`처럼 **엔티티 옆에 코드로 붙여** 자식을 추가할 때 같이 보이게 한다.
- **여러 자식에 걸친 규칙은 표현이 급격히 복잡해진다** — 조건이 두세 컬럼을 넘어가면 `CHECK`로 표현은 되더라도 읽을 수 없게 된다.

운영 중인 큰 테이블에 붙이는 방법도 함께 말하면 좋다 — **PostgreSQL이면 `NOT VALID`로 먼저 붙여 새 데이터부터 막고, 기존 위반 행을 정리한 뒤 `VALIDATE CONSTRAINT`로 검증**한다. 그냥 붙이면 전체 행을 검사하는 동안 테이블에 가장 강한 락이 걸린다.

그리고 마무리는 이렇게 — **`CHECK`는 최후 방어선이고, 첫 방어선은 생성자**다. 필수값을 생성자에서 받아 **불완전한 객체가 애초에 만들어지지 못하게** 한다.

### "결제수단이 15종으로 늘면 `JOINED`의 문제는 '조인이 느려지는 것'인가요?" (시니어 변별 포인트)

**아니다. 그 지점부터 문제의 성질이 바뀐다.**

outer join 하나하나는 PK 기준 1건 매칭이라 개별 비용이 작다. 진짜 문제는 **옵티마이저**다. 조인 대상 테이블이 n개면 조인 순서 후보는 `n!`인데, **자식 3종(테이블 4개)이면 24가지지만 자식 15종(테이블 16개)이면 약 2.1 × 10^13가지**다. 전부 검토하는 것이 불가능해지므로 **DB는 어느 지점부터 완전 탐색을 포기하고 휴리스틱으로 전환한다.** PostgreSQL은 `geqo_threshold`(기본 12) 이상이면 유전 알고리즘 기반 탐색으로 바꾸고, MySQL은 `optimizer_prune_level`(기본 1)로 유망하지 않은 부분 계획을 잘라낸다.

탐색 공간의 일부만 보면서 낡은 통계에 의존하면 결과가 튄다. 증상은 둘이다.

- **같은 쿼리가 계획을 갈아탄다** — 통계가 조금 틀어지거나 데이터 분포가 바뀌면 어제 30ms였던 목록 조회가 오늘 3초가 된다. **배포한 것도 없는데 느려진다.**
- **`order by ... limit 20`을 인덱스로 못 처리하는 계획으로 넘어갈 수 있다** — 조인 결과를 전부 만든 뒤 정렬하는 순간 **페이징의 전제 자체가 무너진다.**

**핵심은 "느려진다"가 아니라 "불안정해진다"** 는 것이다. 조인 비용은 예측 가능하게 나빠지지만 옵티마이저 오판은 예측 불가능하게 나빠진다. 모든 요청이 아니라 일부 요청만 나쁜 계획을 타므로 **평균은 멀쩡한데 p99(응답 시간을 빠른 순으로 줄 세웠을 때 99%지점의 값, 즉 가장 느린 1%의 상한)가 무너지고, 재현이 안 된다.**

그래서 처방도 다르다 — 인덱스 추가로는 안 되고 **쿼리에 등장하는 테이블 수 자체를 줄여야 한다**(DTO로 조인 대상 축소 → 표시용 요약 컬럼 비정규화 → 목록을 타입별로 분리).

### "상속을 아예 테이블로 내리지 않는 선택지도 있나요?" (시니어 변별 포인트)

두 개 있다.

**① `@MappedSuperclass`** — 부모를 엔티티가 아니라 **"공통 컬럼 묶음"** 으로만 쓴다. DDL은 `TABLE_PER_CLASS`와 비슷하지만 JPA가 상속으로 인식하지 않으므로 **`UNION ALL`이 생길 여지가 없고 `IDENTITY`도 쓸 수 있다.** 대가는 **다형성 완전 포기** — `select p from Payment p`도, `@ManyToOne Payment`도 불가능하다. **판단 규칙: `TABLE_PER_CLASS`를 고민하고 있다면 대개 정답은 `@MappedSuperclass`다.** `TABLE_PER_CLASS`가 성립하는 조건이 곧 `@MappedSuperclass`를 쓸 수 있는 조건인데, 후자는 그 대가를 안 낸다.

**② 컴포지션 + JSON 컬럼** — 상속을 버리고 `Payment` 하나에 `method` enum + `methodDetail` JSON을 둔다. **결제수단 추가에 DDL이 0**이고, 외부 결제대행사 응답처럼 스키마가 우리 통제 밖인 데이터에 특히 좋다. 대가는 **그 속성으로 검색·정렬·제약이 불가능**하고 **타입 안전성이 사라지는 것**이다. 그래서 실전 구성은 "전부 JSON"이 아니라 **"검색 대상은 컬럼, 표시 전용은 JSON"** 이고, 자주 검색하는 키만 생성 컬럼이나 표현식 인덱스로 꺼내 일부 회복한다.

**선택 기준 한 줄**: 자식 고유 속성이 **검색·집계·제약의 대상이면 컬럼(`SINGLE_TABLE`이나 `JOINED`)**, **표시·감사 목적이고 종류가 빠르게 늘면 JSON**이다.

### "이미 `SINGLE_TABLE`로 3년 운영했는데 `JOINED`로 바꿔야 한다면 어떻게 하겠습니까?" (시니어 변별 포인트)

**먼저 "안 바꿔도 되는지"를 검토한다.** 목록이 무거운 게 문제라면 §2-7의 처방(DTO 프로젝션, 표시용 요약 컬럼, 타입별 목록 분리)이 마이그레이션보다 훨씬 싸다. **전략 변경은 마지막 수단**이다.

정말 바꿔야 한다면 **애노테이션 한 줄을 바꿔 배포하는 일이 아니라 다섯 단계**다.

1. **자식 테이블 생성** — 기존 컬럼은 그대로 둔다.
2. **쓰기 이중화** — 기존 컬럼과 새 자식 테이블에 동시 기록. 이 단계까지 롤백이 자유롭다.
3. **과거 데이터 백필** — 청크로 옮기고, **양쪽 값이 일치하는지 검증 쿼리로 확인**한다.
4. **읽기 전환** — 매핑을 `JOINED`로 바꾼다. 문제가 생기면 읽기만 되돌린다.
5. **기존 컬럼 제거** — 여기서부터 되돌릴 수 없으므로 가장 마지막이다.

핵심은 **각 단계 사이에 롤백 가능 지점이 있다**는 것과, **3번의 검증 없이 4번으로 넘어가지 않는다**는 것이다. 그리고 이 경험이 알려주는 교훈이 처음 결정으로 되돌아온다 — **상속 전략은 "지금 자식이 3개"가 아니라 "3년 뒤 자식이 몇 종이고 목록 화면이 자식 필드를 요구할 것인가"로 정해야 한다.**

---

## 한 줄 요약

상속 매핑의 선택은 **자식 고유 컬럼의 양 × 다형성 조회의 빈도** 두 축으로 압축되고, 어느 쪽을 고르든 **"얻는 것과 포기하는 것"을 한 호흡에** 말할 수 있어야 한다 — `SINGLE_TABLE`은 조인 0을 얻고 `NOT NULL`과 좁은 테이블을 포기하며(한 컬럼에 "필수"와 "금지"가 행마다 갈려 걸리므로 조건부 `CHECK` 제약과 생성자 검증으로 막는다), `JOINED`는 무결성과 확장성을 얻고 **상세 조인 1회 + 부모 타입 조회 시 자식 전체 `LEFT OUTER JOIN` + INSERT 분할**을 지불하고(자식이 15종이 되면 조인 순서 후보가 `16!`로 폭발해 옵티마이저가 완전 탐색을 포기하므로, 대가는 "느려짐"이 아니라 **"실행계획이 흔들림"** 으로 성질이 바뀌고 평균이 아니라 p99에서 터진다), `TABLE_PER_CLASS`는 `UNION ALL`·`IDENTITY` 불가·부모 FK 불가라는 값을 치르므로 대개 **`@MappedSuperclass`가 더 정직한 답**이다. 그리고 이 결정은 되돌리기가 가장 비싼 축이므로, **미래의 조회 패턴으로 정하고, 실제 SQL을 찍어 확인하고, 쿼리 수를 테스트로 고정해** 자식이 늘어날 때 운영이 아니라 CI에서 먼저 깨지게 만든다.
