# 상속 관계 매핑 전략 — 선택은 "자식 고유 컬럼의 양 × 다형성 조회의 빈도" 두 축으로 압축된다

> 핵심 관전 포인트: **상속을 테이블로 내리는 방법은 세 가지고, **선택을 가르는 축은 두 개뿐**이다 — ① **자식만 갖는 고유 컬럼이 얼마나 많은가** ② **부모 타입으로 조회하는 일(다형성 조회)이 얼마나 잦은가.** 자식 컬럼이 적고 부모 타입 목록 조회가 지배적이면 **`SINGLE_TABLE`** — 조인이 0이고, 대가는 **자식 고유 컬럼에 `NOT NULL`을 못 거는 무결성 구멍 + 테이블 비대**다(방어는 애플리케이션 검증 + DB `CHECK` 제약). 자식 컬럼이 많고 무결성이 중요하며 목록에 자식 필드가 필요 없으면 **`JOINED`** — 대가는 **상세 조회마다 조인 1회, 부모 타입으로 엔티티를 조회하면 자식 테이블 전부에 `LEFT OUTER JOIN`, INSERT가 테이블 2개로 분할**이다. 여기서 멈추면 안 된다 — 자식이 3종에서 15종이 되면 문제의 성질이 바뀐다. **outer join 15개짜리 쿼리는 "조인 비용"이 아니라 "옵티마이저가 실행계획을 잘못 잡는 문제"** 이고, 그때부터 성능은 평균이 아니라 p99에서 무너진다. **`TABLE_PER_CLASS`는 부모 타입 조회를 아예 안 할 때만 후보** — 공통 필드 조회가 `UNION ALL` 전체 스캔이 되고, **`IDENTITY` 전략을 쓸 수 없으며**(자식 테이블마다 독립 `auto_increment`면 ID가 충돌), 부모 타입으로 FK를 걸 수도 없다. 그리고 이 결정은 **되돌리기가 가장 비싼 축**이다 — 전략 변경 = 데이터 마이그레이션. 그래서 기준은 "지금 자식이 3개"가 아니라 **"3년 뒤 자식이 몇 종이고, 목록 화면이 자식 필드를 요구할 것인가"** 다. 마지막으로, **상속을 테이블로 안 내리는 선택지**(`@MappedSuperclass`, 컴포지션 + JSON 컬럼)가 실무에서 정답인 경우가 생각보다 많다.**

---

## 0. 질문 + 의도

**질문**: "상속 관계 매핑 전략(SINGLE_TABLE, JOINED, TABLE_PER_CLASS)의 트레이드오프와 선택 기준은?"

관련 질문(실제로 이어진 꼬리질문):
"`Payment` 부모 + `CardPayment`(카드번호·할부개월) / `BankTransferPayment`(계좌·은행코드) / `PointPayment` 세 자식, 결제수단은 계속 늘어난다. 단일 테이블에 다 몰기 vs 부모+자식 조인 중 어느 쪽? **택하지 않은 쪽에서 무엇을 포기하나?**"
"운영 6개월 뒤 '목록에도 카드면 할부개월, 계좌이체면 은행명을 보여달라'는 요구가 왔다. 하루 수십만 건 호출되는 페이징 화면이다. 어떤 SQL이 나가고 무슨 문제가 생기나?"
"조회 트래픽이 지배적이니 애초에 SINGLE_TABLE이 맞았다고 반박할 수 있다. `card_number`·`bank_code`에 `NOT NULL`을 못 거는 무결성 구멍은 어떻게 방어하나?"
"`TABLE_PER_CLASS`는 왜 실무에서 거의 권장되지 않나?"

**출제 의도**: rationale은 이렇게 적고 있다 — "**상속 구조를 테이블로 내리는 결정은 조회 성능(조인 비용), 무결성(nullable 컬럼), 확장성(타입 추가)의 트레이드오프이고 한번 정하면 바꾸기 매우 비싸다. 객체 모델과 관계 모델의 임피던스 불일치를 실제로 다뤄봤는지 본다.**" 즉 이 문항은 애노테이션 세 개를 외웠는지 묻는 게 아니다. 채점 지점은 셋이다 — ① **세 축(성능·무결성·확장성)을 동시에 저울에 올리는가** ② **자기가 고른 쪽이 지불하는 비용을 유도 없이 스스로 꺼내는가** ③ **"한번 정하면 바꾸기 매우 비싸다"는 성질을 알고, 그래서 현재가 아니라 미래의 조회 패턴으로 정하는가**.

**이 문서의 성격**: 이 문항의 평가는 **중**이었지만 **사실 오류는 하나도 없었다.** 경험이 전무한 영역에서 시나리오만으로 실무 정답(`JOINED`)에 도달했고, 답하기 전에 **"목록·단건에 어떤 데이터가 노출되는가"를 되물었다** — 상속 매핑의 선택 변수를 정확히 알고 요구사항을 확정하러 간 행동이다. 감점 사유는 **단 하나**, "택한 쪽이 지불하는 비용"을 유도 없이 꺼내지 못한 것이다. 그래서 이 문서는 **지식을 보충하는 문서라기보다 답변 구조를 교정하는 문서**다. §2에서 세 전략 각각을 **① 매핑 → ② DDL → ③ 단건 조회 SQL → ④ 부모 타입 목록 조회 SQL → ⑤ INSERT SQL → ⑥ 얻는 것 / 포기하는 것** 이라는 **완전히 같은 여섯 칸**으로 강제 대조한다. 여섯째 칸을 매번 두 줄로 나눠 쓰는 것이 이 문서의 전부다.

---

## 1. 이미 맞춘 것 — 30초 안에 다시 말할 수 있게

이 절은 **확인용**이다. 아래 네 문장을 그대로 말할 수 있으면 §2부터 읽으면 된다.

- **답하기 전에 조회 패턴을 확정하라** — "단건·목록 조회에 노출되어야 하는 데이터가 무엇인가?" 상속 매핑은 **조회 패턴이 결정**하므로, 이 질문 없이 전략을 고르는 것은 근거 없이 고르는 것이다. (면접에서 이 되질문 자체가 점수다.)
- **`SINGLE_TABLE`의 무결성 구멍은 "애플리케이션 검증 + DB `CHECK` 제약"으로 막는다** — `NOT NULL`을 못 거는 이유는 같은 컬럼이 다른 타입 row에서는 반드시 비어 있어야 하기 때문이고, 그래서 조건부 제약이 필요하다. (§3-3에 실제 DDL)
- **`TABLE_PER_CLASS`의 공통 필드 조회는 자식 테이블들을 `UNION ALL` 한다** — 이것이 첫 번째 결격 사유다. 두 번째는 `IDENTITY` 불가(§2-3).
- **`JOINED`를 고르는 근거는 셋** — nullable 컬럼 회피(무결성), 결제수단 추가 시 공용 테이블 컬럼 증식 방지(확장성), 목록은 공통 필드만 필요(성능).

여기까지가 이미 나온 답이다. **빠진 한 줄이 이것이다.**

> **"`JOINED`를 택하겠습니다. 대신 상세 조회마다 조인 1회, 부모 타입으로 엔티티를 조회하면 자식 테이블 전부에 `LEFT OUTER JOIN`, INSERT가 테이블 2개로 갈라지는 비용을 지불합니다."**
>
> 트레이드오프 질문의 답은 **"고른 것 + 포기한 것"이 한 호흡**이어야 한다. 상대가 반대편 단점을 물어야 나오는 순간, "저 사람은 한쪽만 봤다"가 된다.

---

## 2. 같은 객체 모델, 세 가지 테이블 — 여섯 칸으로 대조한다

시나리오를 끝까지 고정한다.

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

> **용어 정리** — **다형성 조회(polymorphic query)** 란 "부모 타입으로 조회해서 자식들을 한꺼번에 받는 것"이다. `select p from Payment p`를 실행하면 결과에 `CardPayment`·`BankTransferPayment`·`PointPayment`가 섞여 돌아온다. 이 문항의 두 축 중 하나가 바로 **이 조회를 얼마나 자주 하는가**이고, 세 전략의 성능 차이는 거의 전부 여기서 갈린다.

---

### 2-1. `SINGLE_TABLE` — 테이블 하나에 전부 몰기

#### ① 매핑

```java
@Entity
@Inheritance(strategy = InheritanceType.SINGLE_TABLE)
@DiscriminatorColumn(name = "payment_type")          // 없으면 기본 이름 DTYPE
public abstract class Payment { /* 위와 동일 */ }

@Entity @DiscriminatorValue("CARD")                  // 값을 반드시 명시한다 (§3)
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
    card_number     varchar(20)  null,   -- CardPayment 전용 → 나머지 타입 row에서는 반드시 null
    installment     integer      null,   -- CardPayment 전용
    account_no      varchar(30)  null,   -- BankTransferPayment 전용
    bank_code       varchar(10)  null,   -- BankTransferPayment 전용
    point_wallet_id bigint       null,   -- PointPayment 전용
    primary key (payment_id)
);
-- 자식이 15종이 되면 이 테이블의 컬럼은 60개가 된다. 그리고 전부 null 허용이다.
```

#### ③ 단건 상세 조회 SQL — **조인 0**

```sql
select p.payment_id, p.payment_type, p.amount, p.paid_at, p.status,
       p.card_number, p.installment, p.account_no, p.bank_code, p.point_wallet_id
from payment p
where p.payment_id = ?
```

자식 타입으로 특정해 조회하면(`CardPayment`) 구분 컬럼 조건이 자동으로 붙는다 — `where p.payment_id = ? and p.payment_type = 'CARD'`. **타입 확인을 SQL이 해준다.**

#### ④ 부모 타입 목록 조회 SQL — **조인 0**

```sql
select p.payment_id, p.payment_type, p.amount, p.paid_at, p.status,
       p.card_number, p.installment, p.account_no, p.bank_code, p.point_wallet_id
from payment p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
```

**여기가 `SINGLE_TABLE`의 존재 이유다.** 다형성 조회가 단일 테이블 스캔 한 번으로 끝난다. 자식이 15종이 되어도 이 쿼리의 **모양은 변하지 않는다.**

#### ⑤ INSERT SQL — **1문장**

```sql
insert into payment (payment_type, amount, paid_at, status, card_number, installment)
values ('CARD', ?, ?, ?, ?, ?)
```

자기 컬럼만 채우고 형제 컬럼은 아예 문장에 등장하지 않는다. **쓰기가 가장 싸다.**

#### ⑥ 얻는 것 / 포기하는 것

**얻는 것**
- **조인이 0이다.** 다형성 조회·단건 조회 모두 테이블 하나로 끝난다.
- **INSERT / UPDATE / DELETE가 각 1문장.** 쓰기 비용과 트랜잭션 길이가 최소.
- **구분 컬럼으로 타입을 즉시 알 수 있다.** 통계·집계 쿼리가 단순하다(`group by payment_type`).
- 자식 타입에 대한 **폴리모픽 FK가 자연스럽다** — 다른 테이블이 `payment_id`를 참조하면 끝.

**포기하는 것**
- **자식 고유 컬럼에 `NOT NULL`을 걸 수 없다.** `card_number`는 카드 결제엔 필수인데 포인트 결제 row에선 반드시 null이어야 한다 → 스키마로 표현 불가. **DB가 지켜주던 것을 애플리케이션이 지켜야 한다.**
- **테이블이 비대해진다.** row 하나가 넓어지면 **데이터 페이지 하나에 들어가는 행 수가 줄고**, 공통 필드만 읽는 목록 조회조차 넓은 행을 읽는다(완화책: 목록 쿼리를 커버링 인덱스로 처리, DTO 프로젝션으로 필요한 컬럼만).
- **자식 하나를 추가하는 일이 "전 서비스가 쓰는 공용 테이블 `ALTER`"** 가 된다. 수억 row 테이블의 컬럼 추가는 배포 이벤트다.
- **컬럼 이름 충돌**을 사람이 관리해야 한다. 두 자식이 각각 `amount`라는 다른 의미의 필드를 갖고 싶으면 한쪽 이름을 바꿔야 한다.
- 자식별 인덱스가 **전체 row에 걸린다** — 카드 결제만 쓰는 `card_number` 인덱스가 포인트 결제 row까지 포함한 인덱스가 된다.

---

### 2-2. `JOINED` — 부모 테이블 + 자식 테이블로 정규화

#### ① 매핑

```java
@Entity
@Inheritance(strategy = InheritanceType.JOINED)
@DiscriminatorColumn(name = "payment_type")   // JOINED에선 선택이지만 넣는 편이 낫다 (§3-2)
public abstract class Payment { /* 위와 동일 */ }

@Entity
@DiscriminatorValue("CARD")
@PrimaryKeyJoinColumn(name = "payment_id")    // 자식 PK가 곧 부모 FK
public class CardPayment extends Payment {
    @Column(nullable = false) private String cardNumber;   // ← NOT NULL을 걸 수 있다
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
-- bank_transfer_payment, point_payment 도 같은 모양.
-- 결제수단이 추가되면 공용 테이블 ALTER가 아니라 새 테이블 CREATE 다.
```

#### ③ 단건 상세 조회 SQL — **조인 1회**

```sql
-- CardPayment 로 특정해 조회 → 부모와 inner join 한 번
select c.payment_id, p.amount, p.paid_at, p.status,
       c.card_number, c.installment
from card_payment c
join payment p on p.payment_id = c.payment_id
where c.payment_id = ?
```

**후보자가 말한 "단건은 하나의 row에 join하면 된다"가 정확히 이것이다.** 상세 화면은 어차피 호출량이 적으니 조인 1회는 싼 대가다.

#### ④ 부모 타입 목록 조회 SQL — **자식 테이블 전부에 `LEFT OUTER JOIN`**

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

`select p from Payment p`의 결과로 돌아와야 하는 것은 **`Payment`가 아니라 `CardPayment`·`BankTransferPayment`의 완성된 인스턴스**다. `Payment`는 추상 클래스라 인스턴스가 존재할 수 없다. 그러니 Hibernate는 각 row가 어떤 자식인지 판정하고 **그 자식의 필드까지 채워서** 객체를 만들어야 한다. 자식 테이블에 행이 없는 경우도 있으니(카드 결제 row는 `point_payment`에 없다) **`INNER JOIN`이 아니라 `LEFT OUTER JOIN`** 이다. 화면이 `amount`만 쓰는지 Hibernate는 알 수 없다.

> **후보자가 10-1에서 말한 "목록은 부모 테이블만 조회하면 된다"는 이 지점에서 어긋난다.** 엔티티로 조회하는 한 부모 테이블만으로 끝나지 않는다. **부모 테이블만 읽게 하려면 엔티티가 아니라 DTO로 뽑아야 한다** — §4-4의 처방이 이것이다. (실제 SQL은 반드시 `show_sql`로 확인하라. 구분 컬럼 유무·Hibernate 버전에 따라 조인을 붙이는 조건이 조금씩 다르다.)

#### ⑤ INSERT SQL — **2문장으로 분할**

```sql
insert into payment (payment_type, amount, paid_at, status) values ('CARD', ?, ?, ?)
insert into card_payment (payment_id, card_number, installment) values (?, ?, ?)
```

3단 상속이면 3문장이 된다. **한 건 저장에 왕복이 2회**이므로 트랜잭션이 길어지고, 대량 적재에서는 이 배수가 그대로 처리 시간에 곱해진다. `DELETE`도 자식 → 부모 순서로 2문장이다. 다만 `UPDATE`는 **건드린 필드가 속한 테이블만** 나간다(할부개월만 바꾸면 `update card_payment ...` 1문장).

#### ⑥ 얻는 것 / 포기하는 것

**얻는 것**
- **자식 고유 컬럼에 `NOT NULL`·`UNIQUE`·`FK`를 전부 걸 수 있다.** 무결성을 DB가 지킨다 — 애플리케이션 버그가 있어도 이상한 데이터가 못 들어온다.
- **자식 추가 = 새 테이블 `CREATE`.** 운영 중인 공용 테이블을 `ALTER`하지 않으므로 배포 리스크가 낮다. 후보자가 짚은 "컬럼을 계속 추가할 수 없다"는 문제가 여기서 사라진다.
- **저장 공간이 정직하다.** null 컬럼을 쌓지 않는다. 부모 테이블이 좁으므로 공통 필드 인덱스의 밀도가 좋다.
- **자식 타입으로 특정한 조회는 형제 테이블을 건드리지 않는다** — `select c from CardPayment c`는 부모와의 조인 1회로 끝난다. (§4-4의 열쇠)

**포기하는 것**
- **단건 상세 조회마다 조인 1회.** (보통 감수할 만하다.)
- **부모 타입 엔티티 조회 시 자식 테이블 전부에 `LEFT OUTER JOIN`.** 자식이 늘어날수록 조인 개수가 **선형으로** 늘어난다. 목록 화면이 호출량 지배적이면 이 비용이 서비스 전체 비용이 된다.
- **INSERT / DELETE가 테이블 수만큼 분할.** 쓰기 비용·트랜잭션 길이·락을 잡는 테이블 수가 모두 증가한다.
- **자식이 15종이 되면 문제의 성질이 바뀐다** — 아래가 그 이야기다.

#### 2-2-1. 자식 15종: "조인이 느리다"가 아니라 "실행계획이 흔들린다"

조인 15개짜리 쿼리에서 실제로 무슨 일이 벌어지는가. 두 가지가 겹친다.

1. **row 하나마다 15번의 PK 조회.** outer join 각각은 PK 기준 1건 매칭(`eq_ref`)이라 개별 비용은 작다. 하지만 **20건 페이징이면 20 × 15 = 300번의 인덱스 탐색**이고, 여기에 목록 화면 호출량이 곱해진다.
2. **옵티마이저가 실행계획을 잘못 잡기 시작한다.** 조인 대상이 늘면 옵티마이저가 고려해야 하는 **조인 순서 조합이 폭발적으로 늘어난다.** 그래서 옵티마이저는 어느 시점부터 **모든 순서를 다 검토하지 않고 탐색을 끊는다.** 그 결과가 두 가지 증상으로 나타난다.
   - 통계가 조금 틀어지거나 데이터 분포가 바뀌면 **같은 쿼리가 어제와 다른 계획으로 실행된다.** 어제 30ms였던 목록 조회가 오늘 3초가 된다.
   - `order by ... limit 20`을 **인덱스로 처리하지 못하고** 조인 결과를 전부 만든 뒤 정렬하는 계획으로 넘어갈 수 있다. 이 순간 페이징의 전제(20건만 만지면 된다)가 깨진다.

**이것이 "조인 비용" 문제와 결정적으로 다른 점**은, 조인 비용은 예측 가능하게 나빠지지만 **옵티마이저 오판은 예측 불가능하게 나빠진다**는 것이다. 평균 응답시간은 멀쩡한데 **p99가 무너지고, 재현이 안 되고, 배포한 것도 없는데 어제부터 느려졌다**는 형태로 온다. 그래서 처방도 다르다 — 조인 비용은 인덱스로 줄이지만, **옵티마이저 오판은 쿼리 모양 자체를 바꿔야 한다**(§4-4).

> (가산점 포인트) 여기까지 말하면 시니어 신호가 된다. "조인이 15개면 느립니다"는 누구나 말한다. **"조인 개수가 임계를 넘으면 성능이 느려지는 게 아니라 불안정해집니다 — 그리고 불안정한 게 더 나쁩니다"** 가 경험에서 나오는 문장이다.

---

### 2-3. `TABLE_PER_CLASS` — 자식마다 독립 테이블

#### ① 매핑

```java
@Entity
@Inheritance(strategy = InheritanceType.TABLE_PER_CLASS)
public abstract class Payment {

    // IDENTITY를 쓸 수 없다. 아래 ⑥에서 이유를 본다.
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
-- payment 테이블은 없다. → 다른 테이블이 "결제"를 참조하는 FK를 걸 대상이 없다.
```

#### ③ 단건 상세 조회 SQL — **조인 0, 세 전략 중 가장 빠르다**

```sql
select c.payment_id, c.amount, c.paid_at, c.status, c.card_number, c.installment
from card_payment c
where c.payment_id = ?
```

**타입을 알고 있을 때는 이 전략이 최적이다.** 조인도 없고 불필요한 컬럼도 없다.

#### ④ 부모 타입 목록 조회 SQL — **`UNION ALL` 전체 스캔**

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

여기서 두 가지를 반드시 짚어야 한다.

- **`null` 패딩이 등장한다.** "nullable 컬럼을 피하려고" 이 전략을 골랐더라도, **부모 타입으로 조회하는 순간 쿼리 안에서 nullable 컬럼이 되살아난다.** 스키마에서 없앤 것이 실행계획에서 돌아온다.
- **`limit 20`이 `UNION ALL` 바깥에 있다.** DB는 자식 테이블 전부를 읽어 합집합을 만든 다음 정렬하고 나서야 20건을 자를 수 있다. **페이징의 전제가 원천적으로 깨진다.** `where paid_at between ...` 조건은 각 자식 테이블로 밀려 들어갈 수 있지만(그건 옵티마이저에 달렸다), **정렬은 합친 뒤에야 가능하다.** `count(*)`도 마찬가지로 union을 만들어야 한다.

#### ⑤ INSERT SQL — **1문장**

```sql
insert into card_payment (payment_id, amount, paid_at, status, card_number, installment)
values (?, ?, ?, ?, ?, ?)
```

쓰기는 가장 단순하다(단, id를 시퀀스에서 미리 받아야 한다).

#### ⑥ 얻는 것 / 포기하는 것

**얻는 것**
- **자식 타입을 알고 하는 조회는 조인 0 + 불필요한 컬럼 0.** 세 전략 중 최적이다.
- **모든 컬럼에 `NOT NULL`을 걸 수 있다.**
- **자식 테이블이 완전히 독립적이다.** 테이블별로 인덱스·파티셔닝·보관 정책·심지어 물리적 분리를 자유롭게 할 수 있다.

**포기하는 것**
- **부모 타입 조회가 `UNION ALL` 전체 스캔이 된다.** 페이징·정렬·집계가 모두 이 위에서 일어난다. 자식이 늘면 union 항이 늘어난다.
- **`IDENTITY` 전략을 쓸 수 없다.** 이유: 자식 테이블마다 독립 `auto_increment`면 `card_payment`에도 `payment_id = 1`이, `bank_transfer_payment`에도 `payment_id = 1`이 생긴다. 그러면 **`em.find(Payment.class, 1L)`이 어느 것을 가리키는지 정할 수 없고, `UNION ALL` 결과에 같은 id가 두 번 등장한다.** 계층 전체에서 id가 유일해야 하므로 **`SEQUENCE` 또는 `TABLE` 생성기가 필수**다. 자동 증가 컬럼이 없는 환경(예: 시퀀스를 안 쓰는 팀 표준)이라면 이 한 줄로 탈락한다.
- **부모 타입으로 FK를 걸 수 없다.** `Refund.payment_id`가 "어떤 결제든" 참조해야 하는데 참조 대상 테이블이 없다. 즉 **다른 테이블과의 참조 무결성을 DB가 지켜줄 수 없다.** `@ManyToOne Payment` 같은 다형성 연관관계도 매핑이 어색해진다.
- **공통 컬럼 추가가 모든 자식 테이블 `ALTER`** 가 된다. `SINGLE_TABLE`의 "공용 테이블 하나를 고치는 부담"이 "N개 테이블을 동시에 고치는 부담"으로 바뀐다.
- **공통 필드에 유니크 제약을 계층 전체 범위로 걸 수 없다.** (예: `transaction_key`가 전체 결제에서 유일해야 한다면 표현 불가.)

**결론**: `TABLE_PER_CLASS`는 **부모 타입 조회를 아예 하지 않고, 자식들이 서로 거의 남남이며, 다른 테이블이 부모를 참조하지도 않을 때만** 후보다. 그런데 그 조건이 성립한다면 **애초에 상속을 엔티티로 표현할 이유가 없다** — 그때의 정직한 답은 `@MappedSuperclass`다(§5-1).

---

### 2-4. 세 전략, 한 표로

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

**표는 여기까지다.** 실전에서 결정을 내리는 건 표가 아니라 **"목록 화면이 자식 필드를 요구하는가"** 한 질문이다.

```flow
# 선택 절차 — 표를 외우는 게 아니라 두 축을 순서대로 묻는다
== 요구사항 확정 (답하기 전에)
① 목록과 단건에 각각 어떤 필드가 노출되는가 | 이걸 안 묻고 고르면 근거 없이 고른 것이다
  - 목록: 공통 필드만인가, 자식 고유 필드까지인가
  - 목록의 호출량이 상세보다 지배적인가
② 자식 고유 컬럼은 몇 개이고, 3년 뒤 자식은 몇 종이 되는가 | 지금이 아니라 미래로 정한다
== 두 축으로 판정
③ 자식 고유 컬럼의 양 × 다형성 조회의 빈도
? ④ 자식 컬럼 적음 + 부모 타입 조회 지배적 → SINGLE_TABLE | 얻는 것: 조인 0 / 포기: NOT NULL·테이블 비대
? ⑤ 자식 컬럼 많음 + 무결성 중요 + 목록에 자식 필드 불필요 → JOINED | 얻는 것: 무결성·확장성 / 포기: 상세 조인 1회 + 부모 조회 시 자식 전체 OUTER JOIN + INSERT 분할
? ⑥ 부모 타입 조회를 아예 안 함 → TABLE_PER_CLASS | UNION ALL·IDENTITY 불가·부모 FK 불가를 감수할 이유가 있을 때만
? ⑦ 다형성 조회가 필요 없다 → 테이블로 안 내린다 | @MappedSuperclass 또는 컴포지션 + JSON 컬럼
== 결정을 코드로 고정하고 검증
⑧ 실제 SQL을 찍어 눈으로 확인한다 | show_sql / p6spy + EXPLAIN
  - 목록 쿼리에 조인이 몇 개 붙는지
  - INSERT가 몇 문장으로 갈라지는지
  - order by ... limit 이 인덱스로 처리되는지
⑨ 쿼리 수·조인 수를 테스트로 단정한다 | 자식이 추가될 때 자동으로 깨지게 만든다
  ! 여기서 안 보면 3년 뒤 데이터 마이그레이션으로 갚는다
```

---

## 3. 구분 컬럼 — `@DiscriminatorColumn` / `@DiscriminatorValue`

### 3-1. 무엇을 하는 물건인가

한 테이블에 여러 타입의 row가 섞여 있으면 **"이 row는 어떤 자식인가"를 적어둘 칸**이 필요하다. 그 칸이 **구분 컬럼(discriminator column)** 이고, 거기에 들어가는 **값**이 discriminator value다.

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
@DiscriminatorValue("CARD")     // ← 클래스 이름과 데이터를 분리한다
public class CardPayment extends Payment { ... }
```

### 3-2. 값을 명시해야 하는 이유 — 클래스 리네임에 데이터가 안 깨진다

`@DiscriminatorValue`를 생략하면 DB에 **`'CardPayment'`라는 자바 클래스 이름이 그대로 저장된다.** 즉 **자바 코드의 식별자가 데이터가 된다.**

```java
// Before — @DiscriminatorValue 없음. DB에는 'CardPayment' 가 쌓여 있다
@Entity
public class CardPayment extends Payment { ... }

// 6개월 뒤 리팩터링: "카드 말고 신용카드로 이름을 정확히 하자"
@Entity
public class CreditCardPayment extends Payment { ... }
// → 이제 Hibernate는 'CreditCardPayment' 를 찾는다.
//    이미 저장된 수백만 건의 'CardPayment' row 는 매핑할 클래스가 없는 데이터가 된다.
//    조회하는 순간 "이 구분 값에 해당하는 엔티티가 없다"는 예외로 터진다.
//    수습 = UPDATE payment SET payment_type='CreditCardPayment' (수백만 건 업데이트)

// After — 값을 명시해 두었다
@Entity
@DiscriminatorValue("CARD")
public class CreditCardPayment extends Payment { ... }
// → 클래스 이름을 무엇으로 바꿔도 DB에는 계속 'CARD'. 데이터는 아무 영향이 없다.
```

**교훈은 상속 매핑을 넘어선다** — "자바 클래스 이름·enum 이름이 DB에 그대로 문자열로 저장되는 지점은 전부 리팩터링 폭탄"이다. `@Enumerated(EnumType.STRING)`도 같은 성질이고, 그래서 enum 상수 이름을 함부로 바꾸면 안 된다.

또한 값을 짧게 명시하면 **저장 공간과 인덱스 크기**에서도 이득이다(기본 `varchar(31)`에 긴 클래스 이름을 넣는 것과 `'CARD'` 4바이트는 다르다).

### 3-3. `JOINED`에서는 선택이지만, 넣는 편이 낫다

`JOINED`는 "어느 자식 테이블에 행이 있는가"로 타입을 알아낼 수 있으므로 구분 컬럼이 **필수는 아니다.** 그래도 넣는 이유는 셋이다.

- **부모 테이블만 봐도 타입을 안다.** 통계·모니터링·운영 쿼리를 조인 없이 쓸 수 있다(`select payment_type, count(*) from payment group by payment_type`).
- **`CHECK` 제약이나 부분 인덱스의 조건으로 쓸 수 있다.**
- **자식 테이블 조인 없이 타입만 필요할 때 Hibernate가 그 컬럼을 이용할 여지가 생긴다.** (실제 SQL은 반드시 로그로 확인하라.)

> (가산점 포인트) **구분 컬럼을 엔티티 필드로도 읽고 싶으면 읽기 전용으로 매핑한다** — `@Column(name = "payment_type", insertable = false, updatable = false)`. 그러지 않으면 Hibernate가 관리하는 컬럼과 내 필드가 같은 컬럼을 두 번 쓰겠다고 다투게 된다. 또한 이미 운영 중인 레거시 테이블처럼 **구분 값이 컬럼 하나로 깔끔하게 안 떨어지는 경우**엔 Hibernate의 `@DiscriminatorFormula`로 SQL 식을 구분자로 쓸 수 있다.

### 3-4. `SINGLE_TABLE`의 무결성 구멍을 실제로 막는 코드

후보자의 답("애플리케이션에서 검증하고 DB에는 `CHECK` 제약")이 정답이다. 그 답을 **DDL로 내려쓸 수 있어야** 완성이다.

```sql
-- 카드 결제라면 카드 관련 컬럼이 반드시 있어야 하고,
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

두 방향을 **모두** 걸어야 한다. 앞줄만 걸면 "카드 결제인데 카드번호가 없는" 데이터는 막지만, **"포인트 결제인데 카드번호가 들어 있는"** 쓰레기 데이터는 막지 못한다. 후자가 더 흔하고 더 찾기 어렵다(코드 버그로 `setCardNumber`가 잘못 호출되는 경우).

**주의할 점 둘.**

- **`CHECK`를 실제로 강제하는지 벤더·버전을 확인해야 한다.** MySQL은 8.0.16부터 `CHECK`를 실제로 검사하고, 그 이전 버전은 **구문만 받아들이고 조용히 무시한다.** "제약을 걸었다"고 믿는데 아무것도 안 걸려 있는 상태가 최악이므로, **제약을 넣은 뒤 반드시 위반 데이터를 넣어보는 테스트로 확인**한다.
- **제약이 마이그레이션 스크립트에만 있으면 자식이 추가될 때 잊는다.** 결제수단 15종이면 `CHECK` 절도 15개가 되고, 이건 사람이 관리해서 유지되지 않는다. **엔티티 옆에 붙여 코드로 고정**하면 자식 클래스를 만들 때 같이 보인다.

```java
// Hibernate의 @Check 로 제약을 엔티티 옆에 둔다 — 스키마 생성·검증에 함께 반영된다
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

그리고 **애플리케이션 쪽 방어는 검증 메서드가 아니라 생성자로 한다.** `card_number`가 null인 `CardPayment`를 **애초에 만들 수 없게** 만드는 것이 검증보다 강하다.

```java
// Before — 필드를 세터로 채운다. "카드번호 없는 카드결제"가 만들어질 수 있고,
//          그 상태로 저장되면 CHECK 제약이 flush 시점에 터진다(원인 지점과 발현 지점이 멀다)
CardPayment p = new CardPayment();
p.setAmount(amount);
p.setCardNumber(cardNumber);   // 이 줄을 빼먹어도 컴파일된다

// After — 필수값을 생성자에서 받고 거기서 검증한다. 불완전한 객체가 존재할 수 없다
public CardPayment(BigDecimal amount, String cardNumber, int installment) {
    super(amount);
    if (cardNumber == null || cardNumber.isBlank())
        throw new IllegalArgumentException("카드 결제는 카드번호가 필수다");
    if (installment < 0) throw new IllegalArgumentException("할부개월은 음수일 수 없다");
    this.cardNumber = cardNumber;
    this.installment = installment;
}
```

**`CHECK` 제약은 최후 방어선이고, 생성자는 첫 방어선이다.** 둘 다 있어야 "코드로 막고, DB로도 막았다"가 된다.

---

## 4. 6개월 뒤 요구가 바뀐다 — "목록에도 자식 고유 필드를 보여달라"

이것이 이 문항의 진짜 시험이다. 처음 결정할 때는 목록이 공통 필드만 쓴다고 했다. 6개월 뒤 기획이 온다 — **"목록에서 카드면 할부개월, 계좌이체면 은행명을 함께 보여주세요."** 하루 수십만 건 호출되는 페이징 화면이다.

### 4-1. `JOINED`에서 벌어지는 일

```sql
-- Before — 목록에 공통 필드만 노출하던 시절 (DTO 프로젝션으로 조회했다면)
select p.payment_id, p.amount, p.paid_at, p.status
from payment p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
-- 부모 테이블 하나. 좁은 row. order by + limit 이 인덱스로 처리된다.

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
-- 그리고 §2-2-1의 문제가 시작된다 — 느려지는 게 아니라 불안정해진다.
```

**핵심**: `JOINED`에서 이 요구는 **회피 불가능한 구조적 비용**을 만든다. 조인은 인덱스로 줄일 수 있는 종류의 비용이 아니다 — **필요한 데이터가 물리적으로 다른 테이블에 흩어져 있기 때문**이다. 자식이 늘어날 때마다 목록 쿼리가 자동으로 무거워지고, **아무도 목록 화면을 건드리지 않았는데** 성능이 나빠진다.

### 4-2. `SINGLE_TABLE`에서 벌어지는 일

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

**`SINGLE_TABLE`이 이 요구를 거의 공짜로 흡수한다.** 이것이 면접관이 10-3에서 반박한 이유다 — "조회 트래픽이 지배적이면 애초에 `SINGLE_TABLE`이 맞지 않았나?"

**그러나 공짜는 아니다.** 6개월 동안 결제수단이 3종에서 8종으로 늘었다면 그 테이블은 이미 컬럼 35개짜리가 되어 있고, row가 넓어져 **같은 20건을 읽는 데 더 많은 데이터 페이지를 만진다.** 그리고 `CHECK` 제약은 8개로 늘어 있어야 한다. **얻은 것은 "쿼리 모양의 안정성", 지불한 것은 "테이블 비대와 무결성을 사람이 관리하는 비용"** 이다.

### 4-3. `TABLE_PER_CLASS`에서 벌어지는 일

**가장 나쁘다.** 목록이 자식 필드를 요구하는지 여부와 무관하게, **부모 타입 페이징 자체가 이미 `UNION ALL` 전체 스캔**이었다. 요구가 추가되면 union 각 항의 컬럼 목록이 늘어날 뿐이고, `order by ... limit`은 여전히 합집합을 다 만든 뒤에야 적용된다. **하루 수십만 건 호출되는 화면에서 쓸 수 없다.**

### 4-4. 전략을 바꾸지 않고 푸는 길 (여기가 실무의 정답이다)

`JOINED`에서 이 요구가 왔다고 **전략을 바꾸면 안 된다.** 전략 변경은 데이터 마이그레이션이고, 그건 이 문제의 크기에 비해 과한 대가다. **쿼리를 바꿔서 푼다.** 위에서부터 시도한다.

**① 목록은 엔티티가 아니라 DTO로 조회한다 — 필요한 자식 컬럼만 좁힌다.**

```java
// Before — 엔티티로 목록을 조회한다. Hibernate는 완성된 자식 인스턴스를 만들어야 하므로
//          화면이 쓰지 않는 자식 컬럼까지 전부 outer join 해서 읽는다
Page<Payment> page = paymentRepository.findByPaidAtBetween(from, to, pageable);

// After — 화면이 실제로 쓰는 필드만 DTO로 뽑는다. 참조하지 않은 자식 테이블은 조인되지 않는다
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

**② 그래도 무거우면, 목록 전용 읽기 모델을 만든다 — 표시용 요약을 부모 테이블에 비정규화.**

목록에 필요한 것은 대개 **"할부개월 3"이 아니라 "카드 3개월"이라는 한 줄 문자열**이다. 그렇다면 그 문자열을 부모 테이블에 컬럼 하나로 갖는다.

```java
// Payment 에 표시용 요약 컬럼을 둔다. 값은 저장 시점에 자식이 스스로 만든다
@Column(name = "method_label", length = 60, nullable = false)
private String methodLabel;          // "카드 3개월" / "국민은행" / "포인트"

protected abstract String buildMethodLabel();   // 자식이 구현
@PrePersist @PreUpdate
void refreshLabel() { this.methodLabel = buildMethodLabel(); }
```

```sql
-- 목록 조회에서 조인이 완전히 사라진다. 자식이 몇 종이 되어도 이 쿼리는 안 변한다
select p.payment_id, p.amount, p.paid_at, p.status, p.method_label
from payment p
where p.paid_at between ? and ?
order by p.paid_at desc
limit 20
```

**대가를 정직하게 말해야 한다** — 같은 정보가 두 곳에 존재하므로 **동기화 책임**이 생긴다(`@PrePersist`/`@PreUpdate`로 코드에 고정하되, **벌크 UPDATE는 이 콜백을 타지 않는다**는 것을 반드시 기억한다). 그리고 표시 문구가 바뀌면 **과거 데이터의 일괄 갱신**이 필요하다. 이건 "정규화를 깨고 조회 성능을 산" 거래이고, **화면 표시용이며 검색 대상이 아닐 때만** 정당하다.

**③ 목록 화면을 타입별로 쪼갤 수 있는지 기획과 협상한다.**

`JOINED`에서 **자식 타입으로 특정한 조회는 형제 테이블을 건드리지 않는다.** 화면에 "결제수단" 필터가 있다면(대개 있다) 그 필터가 선택된 경우는 조인 1회로 끝난다. **"전체" 탭만 무거운 것**이므로, 기본 필터를 강제하거나 "전체" 탭의 기간을 좁히는 것만으로 문제의 90%가 사라지는 경우가 많다. **요구사항을 협상하는 것도 처방이다.**

**④ 마지막 수단이 전략 변경이다.** 그리고 그건 §6-2의 마이그레이션 이야기다.

---

## 5. 상속을 테이블로 내리지 않는 선택지

면접에서 "세 전략 중 하나"만 말하면 **주어진 보기 안에서만 생각한 것**이 된다. **`@Inheritance`를 안 쓰는 답이 실무에서 더 자주 정답이다.**

### 5-1. `@MappedSuperclass` — 공통 컬럼만 물려주고, 다형성은 포기한다

```java
// Before — 부모를 엔티티로 만들었다. 다형성 조회를 위해 세 전략 중 하나를 골라야 한다
@Entity
@Inheritance(strategy = InheritanceType.TABLE_PER_CLASS)
public abstract class Payment { ... }

// After — 부모를 "컬럼 묶음"으로만 쓴다. 엔티티가 아니다
@MappedSuperclass
public abstract class PaymentBase {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)   // ← IDENTITY 를 쓸 수 있다
    private Long id;
    private BigDecimal amount;
    private LocalDateTime paidAt;
    @Enumerated(EnumType.STRING) private PaymentStatus status;
}

@Entity
public class CardPayment extends PaymentBase {      // 독립 엔티티. 테이블도 독립
    @Column(nullable = false) private String cardNumber;
    @Column(nullable = false) private int installment;
}
```

DDL은 `TABLE_PER_CLASS`와 거의 같다(자식마다 공통 컬럼이 복제된 독립 테이블). 차이는 **JPA가 이 계층을 상속으로 인식하지 않는다**는 것이다. 그래서 얻는 것과 잃는 것이 이렇게 갈린다.

**얻는 것**: `UNION ALL`이 생길 여지가 없다. **`IDENTITY`를 쓸 수 있다.** 자식마다 완전히 독립적으로 진화할 수 있다. 매핑이 단순해 사고가 날 여지가 적다.

**포기하는 것**: **`select p from PaymentBase p`가 불가능하다.** `PaymentBase`는 엔티티가 아니므로 JPQL의 조회 대상도, `@ManyToOne`의 타겟도 될 수 없다. 즉 **다형성을 완전히 포기**한다. "모든 결제 목록"이 필요하면 세 번 조회해서 애플리케이션에서 합치거나, 별도의 읽기 모델(뷰·전용 테이블)을 만들어야 한다.

> **판단 규칙 하나** — **`TABLE_PER_CLASS`를 고민하고 있다면, 대개 정답은 `@MappedSuperclass`다.** `TABLE_PER_CLASS`가 성립하는 조건("부모 타입 조회를 안 한다")이 곧 `@MappedSuperclass`를 쓸 수 있는 조건이고, `@MappedSuperclass`는 그 대가(`UNION ALL`, `IDENTITY` 불가)를 안 낸다. **`TABLE_PER_CLASS`를 고르는 것은 "쓰지 않을 다형성"을 위해 비용을 내는 일**이다.

### 5-2. 컴포지션 + JSON 컬럼 — 스키마 변경 없이 결제수단을 추가한다

상속을 아예 버리고 **"결제수단 종류"를 값으로, "수단별 상세"를 JSON 한 칸으로** 담는다.

```java
// Before — 결제수단마다 클래스와 테이블(또는 컬럼)이 늘어난다
@Entity class CardPayment extends Payment { ... }
@Entity class BankTransferPayment extends Payment { ... }
@Entity class PointPayment extends Payment { ... }
// 결제수단 하나 추가 = 클래스 추가 + DDL 변경 + 배포

// After — 테이블은 하나, 클래스도 하나. 수단별 속성은 JSON 한 칸에
@Entity
public class Payment {
    @Id @GeneratedValue private Long id;
    private BigDecimal amount;
    private LocalDateTime paidAt;
    @Enumerated(EnumType.STRING) private PaymentMethod method;   // CARD / BANK / POINT / ...

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "method_detail", columnDefinition = "json")
    private Map<String, Object> methodDetail;    // {"cardNumber":"...","installment":3}
}
// 결제수단 하나 추가 = enum 상수 + 검증 로직. DDL 변경 0.
```

**얻는 것**: 결제수단 추가에 **DDL이 필요 없다.** nullable 컬럼도 늘지 않고 조인도 없다. 외부 PG 응답 원문처럼 **스키마가 우리 통제 밖에 있는 데이터**를 담기에 특히 좋다.

**포기하는 것**: **그 속성으로 검색·정렬·제약을 걸 수 없다.** "할부 3개월 이상 결제를 모아 보여줘"가 인덱스로 처리되지 않고, `bank_code`에 FK를 걸 수도 없다. **타입 안전성도 사라진다** — `Map<String,Object>`에 무엇이 들어 있는지는 컴파일러가 모르므로, 스키마 검증 책임이 전부 애플리케이션으로 넘어온다(그래서 실무에서는 `Map`이 아니라 수단별 `sealed` 클래스로 역직렬화해 타입을 되찾는다).

**부분적인 회복은 가능하다** — 자주 검색하는 키만 **생성 컬럼(generated column)으로 꺼내 인덱스를 걸면** 그 키에 한해 검색 성능을 되찾을 수 있다. 즉 "전부 JSON"이 아니라 **"검색 대상은 컬럼, 표시 전용은 JSON"** 이 실전 구성이다.

**언제 쓰는가**: 자식 고유 속성이 **표시·감사(audit) 목적이고 검색 조건이 아닐 때**, 그리고 **종류가 빠르게 늘어날 때**. 반대로 "은행코드로 정산 집계를 낸다" 같은 요구가 있으면 그 컬럼은 JSON에 두면 안 된다.

---

## 6. 선택 기준을 한 문장으로 고정하고, 결정을 검증한다

### 6-1. 두 축, 그리고 미래로 정한다

> **"자식 고유 컬럼이 적고 부모 타입 조회가 지배적이면 `SINGLE_TABLE`, 자식 고유 컬럼이 많고 무결성이 중요하며 목록에 자식 필드가 불필요하면 `JOINED`, 부모 타입 조회를 아예 안 하면 상속을 테이블로 내리지 않는다(`@MappedSuperclass`). `TABLE_PER_CLASS`는 그 사이에 낀 좁은 경우뿐이다."**

여기에 **시제**를 붙여야 완성이다.

**전략 변경은 데이터 마이그레이션이다.** `SINGLE_TABLE` → `JOINED`는 컬럼을 새 테이블로 옮기고 원본을 지우는 작업이고, 그 과정에서 무중단을 유지해야 하며, 롤백 계획도 있어야 한다. 애노테이션 한 줄을 바꾸는 일처럼 보이지만 **가장 되돌리기 비싼 결정 중 하나**다.

그래서 판단 기준은 **현재가 아니라 미래**여야 한다.

- ❌ "지금 결제수단이 3개니까 조인 3개는 괜찮다"
- ✅ "**3년 뒤 결제수단이 몇 종이 될 것이고, 그때 목록 화면이 자식 필드를 요구할 것인가**"

시나리오에는 이미 답이 있었다 — **"결제수단은 계속 늘어날 예정"**. 이 한 줄이 "조인 개수가 계속 늘어난다"를 뜻하므로, `JOINED`를 고르려면 **§4-4의 처방(목록은 DTO로, 필요하면 표시용 요약 컬럼)을 처음부터 설계에 포함**해야 한다. **전략 선택과 조회 설계는 한 세트다.**

### 6-2. 이미 운영 중인 것을 바꿔야 한다면

`SINGLE_TABLE` → `JOINED` 전환의 순서만 말할 수 있으면 된다.

1. **자식 테이블을 만든다** (기존 테이블은 그대로 둔다).
2. **양쪽에 쓴다** — 애플리케이션이 기존 컬럼과 새 자식 테이블에 동시에 기록한다. 이 단계에서 롤백이 자유롭다.
3. **과거 데이터를 배치로 채운다** — 청크로 나눠 옮기고, 옮긴 뒤 **양쪽 값이 같은지 검증 쿼리로 확인**한다.
4. **읽기를 새 구조로 전환한다** (매핑을 `JOINED`로 바꾼다). 문제가 생기면 읽기만 되돌린다.
5. **기존 컬럼을 지운다** — 여기서부터 되돌릴 수 없다. 그래서 가장 마지막이다.

핵심은 **"애노테이션을 바꾸고 배포"가 아니라 "쓰기 이중화 → 백필 → 검증 → 읽기 전환 → 정리"** 라는 다섯 단계라는 것, 그리고 **각 단계 사이에 롤백 가능 지점이 있다**는 것이다.

### 6-3. 결정을 눈으로 확인하고, 테스트로 고정한다

세 전략의 차이는 **전부 SQL에 나타난다.** 그러니 **찍어 보면 끝난다.** 상속 전략을 고를 때 다음을 반드시 한다.

```yaml
# 개발·테스트 환경에서 SQL을 눈으로 본다
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

- **p6spy / datasource-proxy** 로 **완성된 SQL 한 줄**을 본다(파라미터가 박힌 형태여야 `EXPLAIN`에 바로 붙일 수 있다).
- 목록 쿼리를 **`EXPLAIN`으로 확인**한다. 조인 개수, 조인 순서, `order by`가 인덱스로 처리되는지(정렬을 위한 임시 작업이 생기는지), `limit`이 조기 종료로 이어지는지.
- **`SINGLE_TABLE`과 `JOINED`를 둘 다 만들어 같은 데이터로 재보는 것**이 가장 확실하다. 프로토타입 두 개는 마이그레이션 한 번보다 압도적으로 싸다.

그리고 **자식이 추가될 때 자동으로 경고가 오게** 만든다. 이 문항의 위험은 "처음엔 괜찮았는데 자식이 늘면서 조용히 무거워지는" 형태로 오기 때문이다.

```java
// 목록 조회가 만드는 쿼리 수·조인 수를 테스트로 단정한다.
// 결제수단이 추가되면서 조인이 늘면 이 테스트가 먼저 깨진다 — 운영이 아니라 CI에서.
@Test
void 결제_목록_조회는_쿼리_한_방에_끝나야_한다() {
    SQLStatementCountValidator.reset();

    List<PaymentRowDto> rows = paymentQueryRepository.findRows(from, to, PageRequest.of(0, 20));

    SQLStatementCountValidator.assertSelectCount(1);   // 쿼리 수 고정
    assertThat(rows).hasSize(20);
}
```

> **왜 이걸 강조하는가** — 3장 전체에서 반복된 공백이 **"문제를 만나면 잘 푸는데, 문제가 오기 전에 잡는 장치를 만드는 습관이 없다"** 는 것이었다. 상속 매핑은 그 습관이 없으면 **가장 크게 물리는 주제**다. 잘못 고른 대가를 3년 뒤 마이그레이션으로 갚기 때문이다. **결정 근거를 SQL 로그로 남기고, 그 근거가 깨지는 순간을 테스트로 잡는다.** 이게 이 문서의 마지막 요구다.

---

## 7. 알아두면 점수가 되는 주변 사실 (가산점 포인트)

### 7-1. 부모 엔티티를 추상 클래스로 만들어라

`Payment`가 구체 클래스면 **"자식 중 어느 것도 아닌 Payment"** 인스턴스를 만들어 저장할 수 있다. `SINGLE_TABLE`이면 구분 값이 `'Payment'`인 row가 생기고, `JOINED`면 자식 테이블에 짝이 없는 부모 row가 생긴다. **도메인에 존재하지 않는 상태가 데이터로 만들어진다.** `abstract`로 선언하면 컴파일러가 막는다.

### 7-2. `JOINED`에서 자식 테이블 PK 이름은 `@PrimaryKeyJoinColumn`으로 정한다

기본값은 부모의 PK 컬럼 이름을 그대로 쓴다. 팀 컨벤션이 `card_payment_id` 같은 형태라면 `@PrimaryKeyJoinColumn(name = "...")`으로 지정한다. 그리고 **자식 PK는 그 자체가 부모를 향한 FK**이므로, 이 FK 덕분에 "자식은 있는데 부모가 없는" 상태가 DB 수준에서 불가능해진다 — `JOINED`가 무결성에서 강한 이유의 절반이 이것이다.

### 7-3. 자식 타입만 조회할 때의 전략별 비대칭

- `SINGLE_TABLE`: `where payment_type = 'CARD'` — **전체 테이블에서 걸러낸다.** 카드 결제가 전체의 1%면 그 1%를 찾기 위해 구분 컬럼 인덱스가 필요하다.
- `JOINED`: `card_payment` 테이블 자체가 이미 카드 결제만 담고 있다. **자연스러운 파티셔닝**이다.
- `TABLE_PER_CLASS`: 위와 같고 조인조차 없다.

즉 **"자식 타입별 조회가 잦다"는 축은 `JOINED` 쪽에 점수를 준다.** 두 축(자식 컬럼 양 / 다형성 조회 빈도)에 덧붙일 수 있는 세 번째 관점이다.

### 7-4. `@Inheritance`가 걸려 있으면 다른 최적화가 꺼지기도 한다

Hibernate에는 "초기화되지 않은 프록시를 로딩 없이 바로 삭제하는" 최적화 경로가 있는데, **엔티티에 상속 서브클래스가 있으면 이 최적화가 적용되지 않는다**(어느 테이블을 지워야 하는지 알려면 타입을 알아야 하므로). 즉 `delete(getReferenceById(id))`로 SELECT를 없애는 기법이 상속 계층에서는 기대대로 동작하지 않을 수 있다. **상속 매핑은 그 엔티티 하나의 문제로 끝나지 않는다** — 자세한 조건은 `16-find-by-id-vs-get-reference-by-id.md`에 있다.

### 7-5. 상속 계층에 걸린 `@ManyToOne`은 무엇을 참조하는가

`Refund`가 `@ManyToOne Payment payment`를 갖는다면 —

- `SINGLE_TABLE` / `JOINED`: `refund.payment_id`가 **`payment` 테이블을 참조하는 정상 FK**다. 타입이 무엇이든 상관없다.
- `TABLE_PER_CLASS`: 참조할 단일 테이블이 없다. FK를 걸 수 없고, 그 연관을 따라가는 조회는 `UNION`을 타게 된다. **다른 애그리거트가 "결제"를 참조하는 순간 이 전략은 탈락**이라고 봐도 된다.

### 7-6. 세 전략 모두 "타입을 바꾸는 것"은 지원하지 않는다

카드 결제를 계좌이체 결제로 **타입만 바꿔서** 저장하는 것은 JPA에서 불가능하다(자바 객체의 클래스를 바꿀 수 없으므로). 필요하면 **기존 것을 지우고 새로 만들거나**, 애초에 상속이 아니라 **§5-2의 "수단을 값으로 갖는" 모델**을 택해야 한다. **"타입이 바뀔 수 있는가"는 상속 자체가 적합한지를 가르는 질문**이다 — 상속은 "한번 정해지면 안 바뀌는 종류"를 표현하는 도구다.

---

## 8. 꼬리질문 대비 포인트

### "`JOINED`를 택하겠다고 했습니다. 그 선택이 지불하는 비용을 말해보세요."

세 가지고, **한 호흡에** 말한다.

① **상세 조회마다 부모와 조인 1회** — 상세는 호출량이 적으니 보통 감수한다.
② **부모 타입으로 엔티티를 조회하면 자식 테이블 전부에 `LEFT OUTER JOIN`** — 결과가 완성된 자식 인스턴스여야 하고 자식 테이블에 짝이 없는 경우가 있으므로 outer join이다. 화면이 공통 필드만 쓰더라도 붙는다. **자식이 늘면 조인 개수가 선형으로 늘어난다.**
③ **INSERT가 테이블 수만큼 분할된다** — 한 건 저장에 왕복 2회, 3단 상속이면 3회. `DELETE`도 자식→부모 2문장. 쓰기 비용과 트랜잭션 길이, 락을 잡는 테이블 수가 모두 늘어난다.

그리고 **처방을 붙여서 마무리한다** — "그래서 `JOINED`를 고를 때는 **목록 조회를 처음부터 DTO 프로젝션으로 설계**해서 엔티티 다형성 조회를 피합니다."

### "목록에는 공통 필드만 쓸 겁니다. 그러면 `JOINED`에서 부모 테이블만 읽으면 되는 거 아닌가요?"

**엔티티로 조회하는 한 그렇게 되지 않는다.** `select p from Payment p`의 결과는 `Payment`(추상)가 아니라 **완성된 `CardPayment`·`BankTransferPayment` 인스턴스**여야 하므로, Hibernate는 타입을 판정하고 그 자식의 필드까지 채워야 한다. 그래서 자식 테이블 전부에 `LEFT OUTER JOIN`이 붙는다. **내 화면이 `amount`만 쓴다는 사실을 Hibernate는 알 수 없다.**

부모 테이블만 읽게 하려면 **엔티티가 아니라 DTO로 뽑아야 한다** — 쿼리에서 참조하지 않은 자식 테이블은 조인되지 않는다. 조인 개수를 **"자식 수"에서 "화면이 실제로 쓰는 자식 수"로** 떨어뜨리는 것이 처방의 핵심이다. 그리고 **실제 SQL을 로그로 확인해서 그 처방이 먹혔는지 눈으로 본다.**

### "`TABLE_PER_CLASS`는 `UNION ALL` 말고 또 어떤 결격 사유가 있나요?"

**`IDENTITY` 전략을 쓸 수 없다.** 자식 테이블마다 독립 `auto_increment`를 쓰면 `card_payment`에도 `payment_id = 1`이, `bank_transfer_payment`에도 `payment_id = 1`이 생긴다. 그러면 **`em.find(Payment.class, 1L)`이 어느 것인지 정할 수 없고, `UNION ALL` 결과에 같은 id가 중복 등장한다.** 계층 전체에서 id가 유일해야 하므로 **`SEQUENCE`나 `TABLE` 생성기가 필수**다.

세 번째도 있다 — **부모 타입으로 FK를 걸 수 없다.** 참조할 단일 부모 테이블이 없으므로 `Refund → Payment` 같은 관계에서 참조 무결성을 DB가 지켜줄 수 없다. 그리고 **공통 컬럼 추가가 모든 자식 테이블 `ALTER`** 다.

### "`SINGLE_TABLE`의 무결성 구멍을 `CHECK`로 막는다고 했습니다. 그 제약은 어떻게 생겼고, 한계는 무엇인가요?"

**양방향으로 걸어야 한다** — "카드 결제면 카드번호가 있어야 한다"와 **"카드 결제가 아니면 카드번호가 없어야 한다"** 둘 다. 앞줄만 걸면 "포인트 결제인데 카드번호가 들어 있는" 쓰레기 데이터를 못 막는데, 실무에서 더 흔하고 더 늦게 발견되는 건 후자다.

한계는 셋이다.
- **벤더·버전 의존** — MySQL은 8.0.16부터 `CHECK`를 실제로 검사하고 그 이전은 구문만 받고 무시한다. 그래서 **제약을 넣은 뒤 위반 데이터를 넣어보는 테스트로 실제 작동을 확인**해야 한다.
- **개수가 자식 수만큼 늘어난다** — 15종이면 `CHECK` 절도 15개, 사람이 관리해서 유지되지 않는다. 그래서 Hibernate `@Check`처럼 **엔티티 옆에 코드로 붙여** 자식을 추가할 때 같이 보이게 한다.
- **여러 자식에 걸친 규칙은 표현이 급격히 복잡해진다.** 조건이 두세 컬럼을 넘어가면 `CHECK`로 표현 가능하더라도 읽을 수 없게 된다.

그래서 **`CHECK`는 최후 방어선이고, 첫 방어선은 생성자**다 — 필수값을 생성자에서 받아 **불완전한 객체가 애초에 만들어지지 못하게** 한다.

### "결제수단이 15종으로 늘면 `JOINED`의 문제는 '조인이 느려지는 것'인가요?" (시니어 변별 포인트)

**아니다. 그 지점부터 문제의 성질이 바뀐다.**

outer join 하나하나는 PK 기준 1건 매칭이라 개별 비용이 작다. 진짜 문제는 **옵티마이저**다. 조인 대상이 늘면 검토해야 할 **조인 순서 조합이 폭발적으로 늘어나고**, 옵티마이저는 어느 시점부터 **모든 경우를 다 보지 않고 탐색을 끊는다.** 결과는 두 가지 증상이다.

- **같은 쿼리가 계획을 갈아탄다** — 통계가 조금 틀어지거나 데이터 분포가 바뀌면 어제 30ms였던 목록 조회가 오늘 3초가 된다. **배포한 것도 없는데 느려진다.**
- **`order by ... limit 20`을 인덱스로 못 처리하는 계획으로 넘어갈 수 있다** — 조인 결과를 전부 만든 뒤 정렬하는 순간 **페이징의 전제 자체가 무너진다.**

**핵심은 "느려진다"가 아니라 "불안정해진다"** 는 것이다. 조인 비용은 예측 가능하게 나빠지지만 옵티마이저 오판은 예측 불가능하게 나빠진다. 평균은 멀쩡한데 **p99가 무너지고, 재현이 안 된다.** 그래서 처방도 다르다 — 인덱스 추가로는 안 되고 **쿼리 모양 자체를 바꿔야 한다**(DTO로 조인 대상 축소 → 표시용 요약 컬럼 비정규화 → 목록을 타입별로 분리).

### "상속을 아예 테이블로 내리지 않는 선택지도 있나요?" (시니어 변별 포인트)

두 개 있다.

**① `@MappedSuperclass`** — 부모를 엔티티가 아니라 **"공통 컬럼 묶음"** 으로만 쓴다. DDL은 `TABLE_PER_CLASS`와 비슷하지만 JPA가 상속으로 인식하지 않으므로 **`UNION ALL`이 생길 여지가 없고 `IDENTITY`도 쓸 수 있다.** 대가는 **다형성 완전 포기** — `select p from Payment p`도, `@ManyToOne Payment`도 불가능하다. **판단 규칙: `TABLE_PER_CLASS`를 고민하고 있다면 대개 정답은 `@MappedSuperclass`다.** `TABLE_PER_CLASS`가 성립하는 조건이 곧 `@MappedSuperclass`를 쓸 수 있는 조건인데, 후자는 그 대가를 안 낸다.

**② 컴포지션 + JSON 컬럼** — 상속을 버리고 `Payment` 하나에 `method` enum + `methodDetail` JSON을 둔다. **결제수단 추가에 DDL이 0**이고, 외부 PG 응답처럼 스키마가 우리 통제 밖인 데이터에 특히 좋다. 대가는 **그 속성으로 검색·정렬·제약이 불가능**하고 **타입 안전성이 사라지는 것**이다. 그래서 실전 구성은 "전부 JSON"이 아니라 **"검색 대상은 컬럼, 표시 전용은 JSON"** 이고, 자주 검색하는 키만 생성 컬럼으로 꺼내 인덱스를 거는 것으로 일부 회복한다.

**선택 기준 한 줄**: 자식 고유 속성이 **검색·집계·제약의 대상이면 컬럼(→ `SINGLE_TABLE`/`JOINED`)**, **표시·감사 목적이고 종류가 빠르게 늘면 JSON**이다.

### "이미 `SINGLE_TABLE`로 3년 운영했는데 `JOINED`로 바꿔야 한다면 어떻게 하겠습니까?" (시니어 변별 포인트)

**먼저 "안 바꿔도 되는지"를 검토한다.** 목록이 무거운 게 문제라면 §4-4의 처방(DTO 프로젝션, 표시용 요약 컬럼, 타입별 목록 분리)이 마이그레이션보다 훨씬 싸다. **전략 변경은 마지막 수단**이다.

정말 바꿔야 한다면 **애노테이션 한 줄을 바꿔 배포하는 일이 아니라 다섯 단계**다.

1. **자식 테이블 생성** (기존 컬럼은 그대로 둔다)
2. **쓰기 이중화** — 기존 컬럼과 새 자식 테이블에 동시 기록. 이 단계까지 롤백이 자유롭다.
3. **과거 데이터 백필** — 청크로 옮기고, **양쪽 값이 일치하는지 검증 쿼리로 확인**한다.
4. **읽기 전환** — 매핑을 `JOINED`로 바꾼다. 문제가 생기면 읽기만 되돌린다.
5. **기존 컬럼 제거** — 여기서부터 되돌릴 수 없으므로 가장 마지막이다.

핵심은 **각 단계 사이에 롤백 가능 지점이 있다**는 것과, **3번의 검증 없이 4번으로 넘어가지 않는다**는 것이다. 그리고 이 경험이 알려주는 교훈이 처음 결정으로 되돌아온다 — **상속 전략은 "지금 자식이 3개"가 아니라 "3년 뒤 자식이 몇 종이고 목록 화면이 자식 필드를 요구할 것인가"로 정해야 한다.**

---

## 한 줄 요약

상속 매핑의 선택은 **자식 고유 컬럼의 양 × 다형성 조회의 빈도** 두 축으로 압축되고, 어느 쪽을 고르든 **"얻는 것과 포기하는 것"을 한 호흡에** 말할 수 있어야 한다 — `SINGLE_TABLE`은 조인 0을 얻고 `NOT NULL`과 좁은 테이블을 포기하며, `JOINED`는 무결성과 확장성을 얻고 **상세 조인 1회 + 부모 타입 조회 시 자식 전체 `LEFT OUTER JOIN` + INSERT 분할**을 지불하고(자식이 15종이 되면 그 대가는 "느려짐"이 아니라 **"실행계획이 흔들림"** 으로 성질이 바뀐다), `TABLE_PER_CLASS`는 `UNION ALL`·`IDENTITY` 불가·부모 FK 불가라는 값을 치르므로 대개 **`@MappedSuperclass`가 더 정직한 답**이다. 그리고 이 결정은 되돌리기가 가장 비싼 축이므로, **미래의 조회 패턴으로 정하고, 실제 SQL을 찍어 확인하고, 쿼리 수를 테스트로 고정해** 자식이 늘어날 때 운영이 아니라 CI에서 먼저 깨지게 만든다.
