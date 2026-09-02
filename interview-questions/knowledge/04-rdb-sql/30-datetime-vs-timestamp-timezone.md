# timestamp vs timestamptz — "벽시계를 적는 타입"과 "순간을 적는 타입", 그리고 시간 원칙이 스키마에 착지하는 지점

> 핵심 관전 포인트: **PostgreSQL의 두 타입은 "무엇을 저장하느냐"가 다르다. `timestamptz`(with time zone)는 이름과 달리 타임존을 저장하지 않는다 — 들어온 값을 세션 `TimeZone`으로 해석해 UTC 순간 하나로 정규화해 적고, 읽을 때 읽는 세션의 `TimeZone`으로 되돌려 보여줄 뿐이다. 즉 저장된 것은 "언제"이지 "어디의 몇 시"가 아니다. 반대로 `timestamp`(without time zone)는 아무 변환 없이 받은 벽시계 값을 그대로 적으므로, "어느 도시의 09:00인지"는 값 어디에도 없고 그 규약은 애플리케이션이 지켜야 한다. 그리고 PostgreSQL에서는 두 타입이 똑같이 8바이트·마이크로초 해상도·4713 BC~294276 AD 범위라, MySQL에서 선택을 갈랐던 2038년 한계와 1바이트 저울질이 통째로 사라진다 — 선택 축이 "타임존 정보를 DB가 정규화해 주느냐, 앱이 규율로 지키느냐" 하나만 남는다. 그래서 결론이 단순해진다: 과거·현재의 사건은 무조건 `timestamptz`, `timestamp`는 "벽시계 자체가 의미인" 미래 일정에 IANA 존 ID 컬럼과 짝으로만 쓴다. 대신 PostgreSQL 고유의 함정 셋을 알아야 한다 — ① 같은 값이 세션 `TimeZone`에 따라 다른 문자열로 보이므로 콘솔에서 본 숫자로 사고를 판정하면 안 되고, 판정은 `AT TIME ZONE 'UTC'`로 기준을 못 박고 해야 한다 ② `now()`는 "지금"이 아니라 트랜잭션이 시작된 시각이라 한 배치에서 넣은 1만 건이 전부 같은 `created_at`을 갖고, 그 값으로 삽입 순서를 가리거나 증분 동기화를 돌리면 행이 조용히 새어 나간다 ③ pgjdbc가 접속할 때 JVM 기본 타임존을 세션 `TimeZone`으로 밀어 넣으므로, 서버 `timezone`을 UTC로 맞춰도 앱 세션은 JVM 존을 따라간다. 안전망은 선택과 한 세트다 — `-Duser.timezone=UTC`, `hibernate.jdbc.time_zone=UTC`, `ALTER DATABASE … SET timezone='UTC'`, `Instant` 타입 규약을 ArchUnit으로, 그리고 값뿐 아니라 컬럼 타입이 정말 `timestamptz`인지까지 단정하는 회귀 테스트.**

---

## 0. 질문 + 의도

**질문**: "DATETIME과 TIMESTAMP의 차이(타임존 동작, 범위)는? 글로벌 서비스라면 무엇을 선택하겠습니까?"

**PostgreSQL 기준 재해석**: "`timestamp`(without time zone)와 `timestamptz`(with time zone)의 차이(타임존 동작, 저장 형태)는? 글로벌 서비스라면 무엇을 선택하겠습니까?"

**출제 의도**: rationale은 이렇게 적고 있다 — "타임존 처리·범위(2038년 문제)·기본값 동작의 차이는 **22장의 시간 원칙이 스키마 레벨에 착지하는 지점**이다. 컬럼 타입 선택 하나가 글로벌 확장의 발목을 잡는 사례를 아는지 본다." 즉 채점 지점은 두 타입의 스펙 암기가 아니라 셋이다. ⑴ 값이 저장되고 읽히는 **변환 경로를 사슬로** 말할 수 있는가 — 그래야 "어디가 어긋나면 몇 시간 밀리는지"를 겪지 않고도 예측한다. ⑵ 두 타입의 **얻는 것과 내는 것을 양면으로** 조립해 "우리 서비스의 조건"으로 결론을 내는가. ⑶ 선택을 **설정·타입 규약·테스트로 고정**하는가 — "UTC로 저장하기로 했다"는 결정은 코드로 못 박기 전까지 언젠가 깨질 관례일 뿐이다.

PostgreSQL로 물으면 ⑵의 무게가 달라진다. MySQL에서는 범위(2038)와 크기가 결론을 갈랐지만 **PostgreSQL은 두 타입이 같은 8바이트·같은 범위라 그 축이 사라진다** — 남는 축은 오직 "타임존 정보를 DB가 정규화해 주느냐, 앱이 규약으로 지키느냐" 하나다. 그래서 답이 더 단정적이어야 하고, 대신 **"왜 그런데도 `timestamp`가 남아 있는가"**(미래 일정)와 **PostgreSQL 특유의 함정 셋**(세션 TimeZone, `now()`, pgjdbc)을 말할 수 있어야 변별된다.

> **이 문서가 겨냥하는 지점**(사전 학습): 이 문항은 22장(글로벌/시간)의 원칙을 4장의 스키마 결정으로 내려 보내는 다리다. 시간 원칙 전반과 `Instant`/`LocalDateTime`/`ZonedDateTime`의 상세는 22장 문서가 맡고, 여기서는 **PostgreSQL 타입의 변환 메커니즘, pgjdbc·Hibernate 층의 시계, 그 위에 놓는 안전망**에 집중한다. 생성·수정 시각을 채우는 JPA Auditing 경로는 [JPA Auditing과 벌크 연산의 구멍](../03-jpa-orm/27-jpa-auditing-and-bulk-gap.md)에 있다 — 그 문서의 예제가 `LocalDateTime createdAt`을 쓰고 있는데, 이 문서는 그 필드 타입을 왜 `Instant`로 바꿔야 하는지에서 출발한다.

---

## 1. 개념 — 두 타입은 무엇을 저장하는가

이 장은 소절이 아홉 개라 길다. 길을 잃지 않도록 **여기서 짚는 것이 결국 세 가지**라는 것을 먼저 말해 둔다.

```text
① 두 타입이 각각 "무엇을" 저장하는가          → 1-1 (비유) · 1-2 (timestamptz) · 1-4 (timestamp)
   핵심 문장: timestamptz 는 순간을 저장하고, timestamp 는 벽시계를 저장한다.
   그 사이에 1-3 이 들어가 "그럼 타임존은 어디 있나"라는 오해를 정면으로 깬다.

② 두 타입을 가르는 축이 몇 개인가              → 1-5 (범위·크기가 같아서 축이 하나로 줄어든다)
   핵심 문장: MySQL 을 갈랐던 2038·바이트 수 논쟁이 PostgreSQL 에는 없다.

③ 그 위에서 실제로 사람을 무는 함정들           → 1-6 (AT TIME ZONE) · 1-7 (now()) · 1-8 (자동 갱신)
   핵심 문장: 타입을 맞게 골라도 이 셋을 모르면 값이 밀리거나 뭉친다.
                                                  1-9 는 여기까지를 한 표로 접는다.
```

### 1-1. 비유: 항해일지와 벽시계 사진

비유부터. `timestamptz`는 **항해일지**다. 선원은 현지 시각으로 적지만 일지에는 세계 표준시(UTC)로 환산해 기록하고, 읽는 사람은 자기 항구의 시각으로 되돌려 본다. 어느 항구에서 읽어도 **"같은 순간"** 을 가리킨다. 중요한 건 **일지에 "어느 항구에서 적었는지"는 안 남는다**는 점이다 — 환산 결과인 UTC만 남는다.

`timestamp`는 **벽시계를 찍은 사진**이다. 숫자는 정확히 남지만, 사진 어디에도 "어느 도시의 벽시계"인지는 없다. 사진을 찍은 사람이 "서울이었다"고 기억하는 동안만 의미가 유지되고, 그 사람이 떠나면(코드가 바뀌면, 서버가 옮겨가면) 숫자는 남고 기준은 사라진다.

이 비유가 곧 아래 사슬들이다. 면접에서 "`timestamptz`는 타임존 변환이 있고 `timestamp`는 없다"라고 결과만 말하는 것과, **어느 단계에서 어느 시계로 변환되는지를 순서대로** 말하는 것이 이 질문의 첫 변별점이다.

### 1-2. 사슬 ① `timestamptz` — 세션 TimeZone → UTC → (읽는 세션의) TimeZone

클라이언트가 `INSERT … VALUES ('2026-08-31 09:00:00')` 를 보냈다고 하자.

> **⑴ 리터럴에는 타임존이 없다.** `'2026-08-31 09:00:00'`은 그냥 숫자 묶음이다. → **⑵ 서버는 그 묶음을 세션 `TimeZone`으로 해석한다.** (리터럴에 `+09` 같은 오프셋이 붙어 있으면 그걸 쓰고 세션은 안 본다.) → **⑶ 해석한 순간을 UTC로 환산해 8바이트 정수 하나로 저장한다.** 세션이 `Asia/Seoul`이면 `2026-08-31T00:00:00Z`, 세션이 `UTC`면 `2026-08-31T09:00:00Z`. **같은 문자열이 다른 순간이 된다.** → **⑷ 읽을 때는 저장된 UTC 순간을 "읽는 세션의" `TimeZone`으로 되돌려 문자열로 만든다.** 쓴 세션과 읽는 세션의 존이 다르면 같은 행이 다른 숫자로 보인다.

이 사슬에서 네 가지가 따라 나온다.

- **얻는 것**: 세션 존이 무엇이든 **저장되는 것은 언제나 UTC 순간 하나**다. 자바든 파이썬이든 psql이든, 넣는 순간 정규화된다 — 규율이 DB에 있다.
- **내는 것**: 세션 존이 어긋나면 **오프셋 없는 리터럴의 해석이 밀린다.** (오프셋을 명시하거나 드라이버가 `OffsetDateTime`으로 보내면 이 위험이 사라진다 — §2-1에서 이것이 PostgreSQL의 결론을 정하는 결정타가 된다.)
- 출력이 세션 존에 따라 달라지므로 **"콘솔에서 본 숫자"로 사고를 판정하면 안 된다.** 판정은 `SET timezone='UTC'` 또는 `paid_at AT TIME ZONE 'UTC'`로 기준을 못 박고 해야 한다(§3-3).
- 비교·정렬·인덱스는 저장된 UTC 정수 기준이라 **세션 존과 무관하게 일관**된다. `SET timezone`을 바꿔도 인덱스 순서나 `WHERE` 결과는 안 바뀐다.

### 1-3. 이름이 거짓말한다 — "with time zone"인데 타임존을 저장하지 않는다

이 문항에서 가장 흔한 오답이 **"`timestamptz`는 타임존까지 같이 저장한다"**이다. 그런데 "타임존을 저장하지 않는다"를 먼저 던지면 대부분 "그럼 대체 뭘 저장하는데?"에서 막힌다. 순서를 뒤집어서, **먼저 무엇이 있고 그다음 무엇이 없는지**로 가는 편이 이해가 빠르다.

**질문 1. 그럼 무엇을 저장하는가 — UTC 순간 하나, 8바이트 정수 하나.** `timestamptz` 컬럼 한 칸에 들어 있는 것은 "2000-01-01 00:00:00 UTC로부터 몇 마이크로초 지났는가"라는 **부호 있는 64비트 정수 딱 하나**다. 다른 칸은 없다. 존 이름을 담을 자리도, 오프셋을 담을 자리도 물리적으로 존재하지 않는다.

**질문 2. 그럼 출력에 붙는 `+09`는 어디서 오는가 — 읽는 세션의 `TimeZone` 설정에서.** 저장된 정수를 사람이 읽을 문자열로 바꿀 때, PostgreSQL은 **그 순간 이 세션의 `TimeZone` 파라미터**를 보고 환산해 표기를 붙인다. 그러니까 `+09`는 **데이터가 들고 온 정보가 아니라, 지금 이 세션이 쓴 번역기의 상표**다.

**여기까지 세우고 나면 "이름이 거짓말한다"가 충격이 아니라 당연한 귀결이 된다.** `with time zone`이라는 이름은 "타임존을 저장한다"가 아니라 "타임존을 **의식한다**"는 뜻으로 읽어야 한다 — 입력을 해석할 때 한 번, 출력을 만들 때 한 번, 존을 쓴다. 그 사이에 남는 것은 존이 사라진 UTC 정수뿐이다.

실험 한 번이면 끝난다.

```sql
-- 오해: "with time zone 이니까 '+09' 가 값에 남겠지"
SET timezone = 'UTC';
SELECT '2026-08-31 09:00:00+09'::timestamptz;
--   2026-08-31 00:00:00+00
--   ↑ 입력의 +09 는 "해석"에만 쓰이고 사라졌다.
--     출력의 +00 은 "저장된 존"이 아니라 "지금 이 세션의 존"이다.

-- 증명: 값은 그대로인데 보이는 문자열만 세션을 따라 바뀐다
SET timezone = 'Asia/Seoul';
SELECT '2026-08-31 09:00:00+09'::timestamptz;
--   2026-08-31 09:00:00+09     ← 같은 순간, 다른 표기
```

**같은 한 칸을 세 세션으로 읽으면 이렇게 보인다.** 저장된 정수는 전 행이 동일하다는 것이 이 표의 전부다.

| 저장된 8바이트 정수 (2000-01-01 00:00:00 UTC 기준 마이크로초) | 읽는 세션의 `TimeZone` | 보이는 문자열 |
|---|---|---|
| `841449600000000` | `UTC` | `2026-08-31 00:00:00+00` |
| `841449600000000` | `Asia/Seoul` (UTC+9, 서머타임 없음) | `2026-08-31 09:00:00+09` |
| `841449600000000` | `America/Los_Angeles` (8월은 서머타임 중 = UTC-7) | `2026-08-30 17:00:00-07` |

검산: `2026-08-31 00:00:00Z` 는 PostgreSQL 기준점(2000-01-01 00:00:00 UTC)에서 `841,449,600초` 뒤이고, 마이크로초로 접으면 `841,449,600,000,000`이다. 여기에 서울은 `+9시간`이라 같은 날 09:00, 로스앤젤레스는 8월이면 서머타임이 적용돼 `-7시간`이라 **하루가 넘어가 전날 17:00**이 된다. **날짜까지 바뀐다**는 것이 "콘솔에서 본 숫자로 판정하지 마라"의 실질적 이유다 — 일별 집계를 콘솔에서 눈으로 확인하다가 하루씩 어긋난 것을 못 잡는다.

**두 타입을 한 테이블에 나란히 두고 보면 차이가 더 선명하다.** 면접에서 이 실험을 말로 재현할 수 있으면 "스펙을 외운 사람"과 갈린다.

```sql
CREATE TABLE tz_demo (
    id    int,
    wall  timestamp,      -- 벽시계 값 그대로
    inst  timestamptz     -- UTC 순간으로 정규화
);

-- ⑴ 서울 세션에서 한 건
SET timezone = 'Asia/Seoul';
INSERT INTO tz_demo VALUES (1, '2026-08-31 09:00:00', '2026-08-31 09:00:00');

-- ⑵ UTC 세션에서 한 건 — 문자열은 ⑴과 글자 하나 다르지 않다
SET timezone = 'UTC';
INSERT INTO tz_demo VALUES (2, '2026-08-31 09:00:00', '2026-08-31 09:00:00');
```

```sql
-- before — 세션 UTC로 읽는다
SET timezone = 'UTC';
SELECT id, wall, inst FROM tz_demo;
--  id |        wall         |          inst
-- ----+---------------------+------------------------
--   1 | 2026-08-31 09:00:00 | 2026-08-31 00:00:00+00   ← 서울 09:00 = UTC 00:00
--   2 | 2026-08-31 09:00:00 | 2026-08-31 09:00:00+00
--     ↑ wall 은 두 행이 같다(변환이 없으니 당연). inst 는 9시간 다르다.
--       "같은 INSERT 문자열인데 저장된 순간이 다르다"가 사슬 ⑵의 증거.

-- after — 세션만 바꿔 다시 읽는다 — 데이터는 한 글자도 안 건드렸다
SET timezone = 'Asia/Seoul';
SELECT id, wall, inst FROM tz_demo;
--  id |        wall         |          inst
-- ----+---------------------+------------------------
--   1 | 2026-08-31 09:00:00 | 2026-08-31 09:00:00+09   ← 넣은 그대로 되돌아왔다
--   2 | 2026-08-31 09:00:00 | 2026-08-31 18:00:00+09
--     ↑ wall 은 세션을 바꿔도 요지부동 — "타임존 무관"의 정확한 의미.
--       inst 만 표기가 바뀐다 — 값이 바뀐 게 아니라 번역기가 바뀐 것.
```

여기서 두 문장을 인출용으로 고정한다.

> **`timestamptz` = "순간을 저장하고, 존은 입출력에서만 쓴다". `timestamp` = "벽시계를 저장하고, 존은 아예 모른다".**
> 그래서 **`timestamptz` 컬럼을 보고 "몇 시로 저장돼 있나요?"는 잘못된 질문**이다 — 답이 보는 사람의 세션에 달려 있기 때문이다. 올바른 질문은 "어느 순간인가요?"이고, 그 답은 `AT TIME ZONE 'UTC'`로 못 박아야 한다.

### 1-4. 사슬 ② `timestamp` — 변환 없음, 그래서 타임존 정보가 사라진다

같은 `INSERT`가 `timestamp` 컬럼으로 가면 이렇다.

> **⑴ 리터럴이 도착한다.** → **⑵ 해석도 변환도 없다.** 연·월·일·시·분·초 묶음을 그대로 저장한다. 리터럴에 `+09` 같은 오프셋이 붙어 있어도 **그냥 무시된다.** → **⑶ 읽을 때도 그대로 돌려준다.** 세션 존이 무엇이든, 누가 읽든 `2026-08-31 09:00:00`. → **⑷ 그래서 "어느 존의 09:00였는지"는 값 어디에도 없다.** 그 정보는 값을 넣은 코드의 머릿속(`LocalDateTime.now()`를 부른 JVM의 기본 존)에만 있었고, 저장되는 순간 소실됐다.

따라서 `timestamp`를 쓰는 순간 **"이 컬럼의 값은 UTC 벽시계다"라는 규약은 DB가 아니라 애플리케이션이 지켜야 한다.** DB는 KST 벽시계가 들어와도 막지 않는다. 이것이 `timestamp`가 내는 가장 큰 비용이고, §3의 안전망이 전부 이 비용을 갚기 위한 것이다.

한 가지 함정이 더 있다. `timestamp` 컬럼에 `DEFAULT now()`를 걸면 **세션 존의 벽시계**가 들어간다. `now()`가 돌려주는 값은 `timestamptz`(순간)인데, 이걸 `timestamp` 컬럼에 넣으려면 벽시계로 낮춰야 하고, 그 낮추는 기준이 세션 존이기 때문이다. 앱은 UTC를 넣고 DB 기본값은 KST를 넣는 "한 컬럼 두 기준"이 조용히 생길 수 있다. 그래서 **`timestamp`를 골라도 세션 존은 UTC로 맞춰야 한다** — "`timestamp`는 타임존과 무관하니 설정은 아무래도 된다"는 반쪽 이해다.

**타입이 섞이면 비교에서 승격이 일어난다 (가산점 포인트).** `timestamp` 컬럼을 `timestamptz`(예: `now()`)와 비교하면, 벽시계와 순간은 애초에 비교할 수 없는 서로 다른 것이므로 PostgreSQL이 좌변을 **세션 `TimeZone`으로 해석해 `timestamptz`로 승격**한 뒤 비교한다. 즉 **한쪽만 `timestamp`인 순간, 그 비교 결과는 세션 존에 따라 달라진다.** §2-2의 사고 ①이 정확히 이 지점에서 터진다.

### 1-5. 사슬 ③ 범위·크기 — 두 타입이 완전히 같아서 선택 축 하나가 사라진다

PostgreSQL은 **`timestamp`와 `timestamptz` 모두 8바이트, 해상도 마이크로초, 범위 4713 BC ~ 294276 AD**다. 사슬로 말하면 —

> **⑴ 두 타입의 저장 크기가 같다** → **⑵ 범위도 같다** → **⑶ 그래서 "2038년까지밖에 못 담아서"·"1바이트 아끼려고" 같은 선택 근거가 아예 성립하지 않는다** → **⑷ 남는 선택 축은 오직 "타임존 정보를 DB가 정규화하느냐, 앱이 규약으로 지키느냐" 하나다.**

> **MySQL 대조**: MySQL은 `TIMESTAMP`가 1970 기준 초를 **4바이트**에 담는다. 부호 있는 32비트가 담을 수 있는 최대 초가 `2^31 - 1 = 2,147,483,647`이고, 1970-01-01 00:00:00 UTC에 이만큼 더하면 정확히 **`2038-01-19 03:14:07` UTC**가 나온다 — 이것이 "2038년 문제"의 정체다. 반면 `DATETIME`은 **5바이트**(소수 초를 쓰면 최대 3바이트 추가)에 1000~9999년을 담는다. 그래서 MySQL에서는 **"영구 이용권 `expires_at = 9999-12-31`을 담아야 하니 `DATETIME`"** 처럼 범위가 타입 선택을 뒤집는 일이 실제로 벌어지고, 나중에 바꾸려면 대용량 테이블 재작성이다. **PostgreSQL에서는 이 논쟁 자체가 없다** — 이 대조를 짚으면 "두 DB의 스펙을 외운" 게 아니라 "선택 근거가 왜 달라지는지"를 아는 것으로 들린다.

대신 PostgreSQL에는 **특수값 `'infinity'` / `'-infinity'`가 있다 (가산점 포인트).** "무기한 정지", "만료 없음"을 `9999-12-31` 같은 마법 날짜로 표현하던 관례를 타입 차원에서 대체한다.

```sql
-- before — 마법 날짜. "9999-12-31 이면 무기한"이라는 규약을 사람이 기억해야 한다
ALTER TABLE membership ADD COLUMN expires_at timestamptz NOT NULL
    DEFAULT '9999-12-31 23:59:59+00';

-- after — 무한대. 비교 연산이 그대로 성립하고(항상 미래), 의미가 값에 드러난다
ALTER TABLE membership ADD COLUMN expires_at timestamptz NOT NULL
    DEFAULT 'infinity';
SELECT * FROM membership WHERE expires_at > now();   -- 'infinity' 행은 언제나 참
```

**소수 초 (가산점 포인트).** PostgreSQL의 기본 해상도는 **마이크로초(소수점 6자리)**이고 `timestamptz(3)`처럼 자릿수를 줄여 선언할 수도 있다. 자바 `Instant`는 **나노초(9자리)**를 갖고 있어 저장·조회를 왕복하면 뒤 3자리가 잘려 나간다 — `assertEquals(saved, found)`가 깨지는 흔한 원인이다. 처방은 앱에서 `truncatedTo(ChronoUnit.MICROS)`로 미리 맞추거나, 비교를 "허용 오차 안"으로 단정하는 것. 자릿수를 줄여 선언하면(`(0)`, `(3)`) 그만큼 더 크게 어긋나므로 **특별한 이유가 없으면 기본(마이크로초)을 쓴다.**

### 1-6. `AT TIME ZONE` — 값을 바꾸는 게 아니라 **타입을 뒤집는** 연산자

이걸 "타임존 변환 함수"로만 알면 반쪽이다. 핵심은 **입력 타입에 따라 출력 타입이 반대로 뒤집힌다**는 것이다. 이름이 하나뿐이라 방향을 헷갈리기 쉬우니, **양방향을 나란히 놓고 각각 언제 쓰는지까지 붙여서** 외운다.

| 방향 | 식 | 읽는 법 | 결과 타입 | 언제 쓰나 |
|---|---|---|---|---|
| 내림 (순간 → 벽시계) | `timestamptz AT TIME ZONE 'Asia/Seoul'` | "이 **순간**은 서울에서 몇 시인가" | **`timestamp`** (벽시계) | 리포트·화면 표시, 존별 하루 경계로 집계, 검증 SQL에서 `AT TIME ZONE 'UTC'`로 기준 고정 |
| 올림 (벽시계 → 순간) | `timestamp AT TIME ZONE 'Asia/Seoul'` | "이 **벽시계**를 서울 시각으로 읽으면 어느 순간인가" | **`timestamptz`** (순간) | 미래 일정의 원본(로컬 벽시계 + 존 ID)에서 UTC 파생 컬럼을 계산할 때, 옛 `timestamp` 컬럼을 `timestamptz`로 마이그레이션할 때 |

방향을 기억하는 요령은 **"AT TIME ZONE은 항상 반대편으로 넘긴다"**이다 — 순간을 주면 벽시계를 돌려주고, 벽시계를 주면 순간을 돌려준다. 결과에 `+09` 같은 표기가 붙으면 순간(`timestamptz`), 안 붙으면 벽시계(`timestamp`)다.

```sql
SET timezone = 'UTC';

-- ⑴ 내림: 순간 → 벽시계 (표시·리포트용). 존을 명시했으므로 세션과 무관하다
SELECT paid_at AT TIME ZONE 'Asia/Seoul' AS seoul_wall FROM payment;
--   2026-08-31 09:00:00      ← 타임존 표기(+09)가 사라진 것에 주목: timestamp 다
--   쓰임새: "서울 기준으로 언제 결제됐나"를 사람에게 보여 줄 때.
--          세션이 UTC든 LA든 이 값은 안 흔들린다.

-- ⑵ 올림: 벽시계 → 순간 (미래 일정의 원본에서 UTC를 계산할 때)
SELECT publish_local_at AT TIME ZONE publish_zone_id AS publish_at_utc
FROM episode_schedule;
--   2026-09-01 14:00:00+00   ← 이제 timestamptz 다
--   검산: 서울(UTC+9) 벽시계 2026-09-01 23:00 → 9시간을 빼면 같은 날 14:00 UTC.
--   쓰임새: "밤 11시 공개"라는 규칙에서 스캐너가 쓸 실제 순간을 뽑을 때.
```

두 번 쓰면 "존 A의 벽시계를 존 B의 벽시계로" 바꾸는 것도 된다: `(wall AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'America/Los_Angeles'` — 앞쪽이 벽시계를 순간으로 올리고, 뒤쪽이 그 순간을 다른 벽시계로 내린다. **"타입이 오르내린다"로 이해하면 헷갈리지 않는다.**

### 1-7. `now()`는 "지금"이 아니다 — 트랜잭션 시작 시각

PostgreSQL에서 가장 자주 사람을 무는 함정이고, MySQL 경험만으로는 예측할 수 없는 동작이다.

| 함수 | 언제의 시각인가 | 트랜잭션 안에서 여러 번 부르면 |
|---|---|---|
| `now()` = `CURRENT_TIMESTAMP` = `transaction_timestamp()` | **트랜잭션이 시작된 시각** | **전부 같은 값** |
| `statement_timestamp()` | 현재 문장이 시작된 시각 | 문장마다 다른 값 |
| `clock_timestamp()` | 실제로 함수가 호출된 순간 | 부를 때마다 다른 값 |

왜 이렇게 만들었는가부터 짚으면 외우기 쉽다. **한 트랜잭션은 "한 시점의 세계"라는 것이 트랜잭션의 정의에 가깝기 때문**이다. 같은 트랜잭션 안에서 `now()`를 부를 때마다 값이 달라지면 "이 트랜잭션이 만든 행들의 시각"이 제각각이 되어 원자성이라는 착시가 깨진다. PostgreSQL은 일관성을 택했고, 그 대가로 아래 사고가 생긴다.

```sql
-- before — 트랜잭션이 길면 now() 는 과거를 가리킨다
BEGIN;
--  … 외부 API 호출·대량 계산으로 10분 경과 …
INSERT INTO payment (paid_at) VALUES (now());
COMMIT;
--   저장된 paid_at 은 실제 결제 시각보다 10분 이르다.
--   "created_at 이 실제 삽입 시각보다 과거"라는 제보의 정체.

-- after — 실제 순간이 필요하면 clock_timestamp()
INSERT INTO payment (paid_at) VALUES (clock_timestamp());
```

**그래서 무슨 사고가 나는가 — 배치 1만 건이 전부 같은 시각을 갖는다.** 정산 배치가 한 트랜잭션에서 1만 건을 INSERT하고 `created_at`이 `DEFAULT now()`라면, 그 1만 행의 `created_at`은 **글자 하나 다르지 않은 같은 값**이 된다. "1만 건이 같은 밀리초에 들어갔을 리 없다"는 직관이 여기서 배신당한다. 그리고 이 뭉친 값이 두 군데에서 정확히 터진다.

```text
사고 A — 커서(키셋) 페이지네이션이 행을 건너뛰거나 반복한다

  WHERE created_at < :마지막본값 ORDER BY created_at DESC LIMIT 20

  created_at 이 1만 건 전부 '10:00:00.000' 이라면
    1페이지: 그중 20건을 뽑는다 (어느 20건인지는 정렬이 정하지 않는다)
    2페이지: created_at < '10:00:00.000' → 그 1만 건이 통째로 사라진다
             (같은 값은 "<" 를 만족하지 않으므로)
    → 9,980건이 영영 안 보인다.
  처방: 타이브레이커를 id 로 둔다. (created_at, id) 복합 커서.
       → 딥 페이지네이션 문서가 "타이브레이커는 유일한 컬럼이어야 한다"고
         말하는 실제 이유가 이것이다.

사고 B — 시간 범위 조회 / 증분 동기화가 행을 조용히 흘린다

  WHERE updated_at > :마지막처리값     (5분마다 폴링하는 배치)

  T1: BEGIN (10:00:00)  ── 10분간 작업 ──  UPDATE(updated_at = now() = 10:00:00) ─ COMMIT(10:10:00)
  폴링: 10:05 실행 → 마지막처리값 = 10:05:00 으로 전진
       10:10 실행 → WHERE updated_at > '10:05:00'
                    그런데 방금 커밋된 행의 updated_at 은 10:00:00 이다
                    → 이미 지나간 구간에 끼어들었으므로 영영 안 잡힌다.

  "커밋 순서"와 "타임스탬프 순서"가 어긋나는 것이 원인이고,
  now() 가 트랜잭션 시작 시각이라는 성질이 그 어긋남을 최대 트랜잭션 길이만큼 벌린다.
```

> **⑴ 한 트랜잭션에서 1만 건을 INSERT 하면 `DEFAULT now()`로 채워진 `created_at`이 1만 건 전부 같은 값이 된다** → **⑵ `created_at`으로는 삽입 순서를 가릴 수 없다**(키셋 페이지네이션의 타이브레이커가 `id`여야 하는 이유 — [딥 페이지네이션](./13-deep-pagination-offset-vs-cursor.md)) → **⑶ 더 위험한 것은 증분 동기화다.** `WHERE updated_at > :마지막값`으로 폴링하는 배치는, 트랜잭션 시작 시각으로 찍힌 행이 **나중에 커밋되면서 이미 지나간 구간에 끼어들기** 때문에 행을 조용히 건너뛴다 → **⑷ 처방은 세 갈래**: 폴링 경계에 여유(lookback — 마지막 처리 시각에서 최대 트랜잭션 길이만큼 되돌려 겹쳐 읽고, 중복은 멱등 처리로 흡수)를 두거나, `updated_at`을 `clock_timestamp()`로 찍거나(다만 이래도 커밋 순서와의 어긋남은 트랜잭션 길이만큼 남는다), 애초에 **논리 디코딩 기반 CDC**로 타임스탬프가 아니라 **커밋 순서 자체**를 따르게 한다. 근본 처방은 셋째다.

> **MySQL 대조**: MySQL의 `NOW()`는 **문장이 시작된 시각**이라 같은 트랜잭션 안이라도 문장마다 값이 다르다(실제 호출 시각이 필요하면 `SYSDATE()`). 즉 위 ⑴~⑷ 사고는 **MySQL에서는 잘 안 나고 PostgreSQL에서만 나는** 부류다. "PostgreSQL로 옮기고 나서 증분 배치가 이상해졌다"의 단골 원인. 다만 "MySQL이면 안전하다"는 아니다 — 한 문장으로 1만 건을 INSERT하면 MySQL에서도 그 1만 건은 같은 값이고, 커밋 순서와 타임스탬프 순서가 어긋나는 것도 그대로다. PostgreSQL은 그 창을 트랜잭션 길이만큼 크게 벌릴 뿐이다.

### 1-8. `DEFAULT`와 자동 갱신 — `ON UPDATE CURRENT_TIMESTAMP`가 없다

`DEFAULT now()`(또는 `DEFAULT clock_timestamp()`)는 그대로 쓸 수 있다. 없는 것은 **UPDATE 시 자동 갱신**이다.

> **MySQL 대조**: MySQL은 `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP` 한 줄로 DB 레벨 자동 갱신을 얻는다 — 벌크 UPDATE·네이티브 쿼리·콘솔 수동 SQL처럼 **JPA Auditing이 빠지는 경로에서도 살아 있다**([JPA Auditing과 벌크 연산의 구멍](../03-jpa-orm/27-jpa-auditing-and-bulk-gap.md)). 덤으로 `explicit_defaults_for_timestamp=OFF`인 옛 설정에서는 첫 `TIMESTAMP` 컬럼에 이 동작이 **묵시로 붙고** NULL 대입이 현재 시각이 되는 마법까지 있었다. **PostgreSQL에는 자동 갱신도, 묵시 마법도 없다.**

PostgreSQL에서는 **트리거로 직접 만든다.** 문법이 한 줄 더 들 뿐, 조건을 붙일 수 있어 오히려 세밀하다.

```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    -- now() 를 쓰면 트랜잭션 시작 시각이 박힌다(§1-7). "수정된 순간"이 의도라면 clock.
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_touch
    BEFORE UPDATE ON payment
    FOR EACH ROW
    -- 값이 실제로 바뀔 때만 — 같은 값으로 덮어쓰는 UPDATE 에는 안 붙는다.
    -- IS DISTINCT FROM 을 쓰는 이유: NULL <> NULL 은 NULL(=거짓 취급)이라
    -- 평범한 <> 로는 "NULL 이 값으로 바뀐" 변경을 놓친다.
    WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION touch_updated_at();
```

트리거가 DB 레벨이라는 점이 요점이다 — `@Modifying` 벌크 UPDATE, 네이티브 쿼리, psql 수동 SQL에서도 동작해 JPA Auditing의 구멍을 메운다.

### 1-9. 비교표 — 목록으로 인출한다

| 항목 | `timestamp` (without time zone) | `timestamptz` (with time zone) |
|---|---|---|
| 저장하는 것 | 벽시계 값 그대로(변환 없음) | 세션 존으로 해석한 **UTC 순간** |
| 타임존을 저장하나 | 아니다 | **아니다** (정규화만 한다 — 이름의 함정) |
| 읽을 때 | 저장한 값 그대로 | UTC 순간 → 읽는 세션 존으로 표기 변환 |
| 크기 / 해상도 | 8바이트 / 마이크로초 | 8바이트 / 마이크로초 |
| 범위 | 4713 BC ~ 294276 AD | 4713 BC ~ 294276 AD |
| 세션 `TimeZone` 의존 | 없음(단 `DEFAULT now()`와 `timestamptz`와의 비교는 의존) | 입력 해석·출력 표기에 의존(저장된 순간은 불변) |
| 오프셋 붙은 리터럴 | **무시된다** | 해석에 사용된다 |
| 비교·정렬·인덱스 | 벽시계 기준 | UTC 순간 기준 — 세션과 무관하게 일관 |
| 자바 매핑(pgjdbc) | `LocalDateTime` | `OffsetDateTime` / `Instant` |
| 어울리는 자리 | **벽시계 자체가 의미인 미래 일정**(존 ID 컬럼과 짝) | **과거·현재의 모든 사건**(기본값) |

표는 인출용이고, 결정은 §2-3·§2-4의 양면 서술로 한다.

---

## 2. 시계들 — 값이 밀리는 사고의 사슬과 선택의 양면

### 2-1. 값이 DB에 닿기까지 지나는 시계 — PostgreSQL에서 하나가 사라지고 하나가 생긴다

`Instant`(또는 `LocalDateTime`) 하나가 컬럼에 적힐 때까지 **네 개의 시계**를 지난다. 각 시계가 어디에 있고 무엇을 결정하는지부터 세운다.

> **① JVM 기본 타임존** — `-Duser.timezone`, 없으면 OS의 `TZ`. `LocalDateTime.now()`, `ZoneId.systemDefault()`의 기준이다. 개발 PC(KST)와 컨테이너 이미지(대개 UTC)가 다르기 가장 쉬운 시계다.
>
> **② Hibernate가 JDBC에 값을 넘길 때의 기준 존** — 기본은 ①과 같다. `hibernate.jdbc.time_zone=UTC`를 주면 "이 값은 UTC 기준 벽시계"라고 명시해 넘긴다. **`timestamp`(without tz) 컬럼에 바인딩할 때만 의미가 있다** — `timestamptz`로 가는 값은 오프셋이 이미 붙어 있어 이 설정과 무관하다.
>
> **③ DB 세션 `TimeZone`** — `SHOW TimeZone`으로 보이는 값. `timestamptz`의 입출력 변환과 `now()`의 표기 기준. **여기가 PostgreSQL의 결정적 지점이다: pgjdbc는 접속할 때 세션 `TimeZone`을 JVM 기본 타임존(①)으로 설정한다.** 서버 `timezone`을 UTC로 맞춰 놓아도 **앱의 세션은 ①을 따라간다.**
>
> **④ 앱 밖 독자의 세션 `TimeZone`** — psql, 정산 배치, 파이썬 스크립트, BI 도구, 관리 콘솔. 이쪽은 서버 `timezone` 파라미터(또는 `ALTER DATABASE … SET timezone`)를 따른다.

**말로만 읽으면 어느 단계에서 값이 바뀌는지 안 잡힌다. 실제 값을 하나 넣어 끝까지 따라가 본다.** 서울 시각으로 09:00에 결제가 일어났고, 앱은 컨테이너(JVM 존 UTC)에서 돌고 있다고 하자.

```text
[경로 A] Instant + timestamptz 컬럼  ← 권장 조합. 시계가 어긋나도 저장이 안 밀린다

 ① JVM (user.timezone=UTC)
      Instant.now()  →  2026-08-31T00:00:00Z          "순간" 자체. 존이 없는 값이다.
        │              (서울 09:00 = UTC 00:00. 한국은 서머타임이 없어 항상 +9)
        ▼
 ② Hibernate → JDBC 바인딩
      Instant 를 OffsetDateTime(2026-08-31T00:00:00+00) 으로 넘긴다
      hibernate.jdbc.time_zone 은 여기서 쓰이지 않는다 ─ 오프셋이 이미 값 안에 있으므로
        │
        ▼
 ③ pgjdbc → 서버 (세션 TimeZone = ① 의 UTC)
      리터럴에 오프셋이 붙어 있으므로 서버는 세션 TimeZone 을 보지 않는다
      → 세션 존이 무엇이든 해석 결과가 같다  ※ 여기가 이 조합의 핵심
        │
        ▼
 ④ 저장 (timestamptz)
      8바이트 정수 841449600000000  (= 2026-08-31T00:00:00Z)

 ⇒ ①②③ 중 무엇이 KST 로 잘못 설정돼 있어도 저장된 정수는 그대로다.


[경로 B] LocalDateTime + timestamp 컬럼  ← 사고 ①·② 의 뿌리

 ① JVM (user.timezone 이 KST 로 새어 있음)
      LocalDateTime.now()  →  2026-08-31T09:00                존이 없는 "벽시계".
        │                     어느 존의 09:00 인지는 이 값이 모른다
        ▼
 ② Hibernate → JDBC 바인딩
      벽시계를 그대로 넘긴다. 변환 없음
        │
        ▼
 ③ pgjdbc → 서버 (세션 TimeZone = KST)
      컬럼이 timestamp 이므로 서버도 해석하지 않는다. 오프셋이 붙어 있어도 무시
        │
        ▼
 ④ 저장 (timestamp)
      '2026-08-31 09:00:00'                        ← "KST 였다"는 사실은 저장되지 않았다

 ⇒ 나중에 이 컬럼을 now()(=timestamptz) 와 비교하면 세션 존으로 승격되므로(§1-4),
   그때의 세션이 UTC 면 이 값은 UTC 09:00 으로 해석돼 9시간 미래가 된다.
```

**PostgreSQL에서는 시계 ③이 독립 설정이 아니라 ①의 그림자다.** 이 한 문장이 PostgreSQL과 MySQL을 가른다.

> **MySQL 대조**: Connector/J는 `connectionTimeZone`(구 `serverTimezone`)이 **서버 세션 존과 독립된 설정**이라, 드라이버가 믿는 존과 서버가 실제로 쓰는 존이 어긋나면 **저장되는 순간 자체가 밀리고**, 읽을 때 대칭으로 되돌아와 **앱에서는 정상으로 보이는** 고전적 사고가 난다("The server time zone value 'KST' is unrecognized"를 없애려고 `serverTimezone=UTC`를 붙였다가 9시간 밀리는 그 사고). **pgjdbc는 세션 존을 JVM 존으로 직접 밀어 넣어 이 어긋남을 원천 차단한다** — PostgreSQL에서 그 사고는 안 난다.

대신 PostgreSQL에서는 **③이 ①의 그림자이므로 ①·③이 항상 붙어 다니고, 문제는 ③과 ④의 간극으로 옮겨간다** — 즉 **"앱이 보는 존"과 "psql·배치·BI가 보는 존"이 다르다.**

그리고 여기서 **PostgreSQL의 결론을 정하는 결정타**가 나온다.

> **`timestamptz` 컬럼에 `Instant`/`OffsetDateTime`을 쓰면 ①②③④가 전부 어긋나 있어도 저장된 순간은 안 밀린다.** 위 경로 A가 보여 준 대로, 드라이버가 오프셋을 명시해 보내므로 세션 존이 해석에 개입할 여지가 없기 때문이다. 반대로 **`timestamp` 컬럼은 이 시계들의 정합에 전적으로 의존한다.** 즉 PostgreSQL에서 타입 선택은 "성능·범위 저울질"이 아니라 **"운영 실수에 대한 내성"의 선택**이다.

### 2-2. 사고 사슬 두 개 — "앱에서는 맞는데 psql에서 보면 9시간 다르다"

**사고 ①: `LocalDateTime` + `timestamp` 컬럼 + 배치의 `now()`.** 국내 서비스. 결제 시각은 `paidAt = LocalDateTime.now()`로 채우고 `timestamp` 컬럼에 저장한다. 30분 넘게 미완료인 결제를 정리하는 배치는 SQL로 `WHERE status = 'PENDING' AND created_at < now() - interval '30 minutes'`.

> **⑴ `LocalDateTime.now()`는 시계 ①(KST)의 벽시계** `09:00`. → **⑵ pgjdbc는 `LocalDateTime`을 `timestamp`에 변환 없이 적는다** — `'09:00'`, 존 정보 소실. → **⑶ 배치 SQL의 `now()`는 `timestamptz`(진짜 순간)다.** → **⑷ `timestamp < timestamptz` 비교라서 PostgreSQL은 좌변을 읽는 세션의 TimeZone으로 해석해 순간으로 승격한다**(§1-4). → **⑸ 그래서 이 배치의 정확성이 "누가 실행하느냐"에 달린다** — 앱(세션 KST)이 돌리면 우연히 맞고, cron이 psql(세션 UTC)로 돌리면 KST 벽시계 09:00이 UTC 09:00으로 해석돼 **기준선보다 9시간 미래가 되어 아무것도 정리하지 않는다.** → **⑹ 로컬 개발에서는 앱도 psql도 다 KST라 완벽히 동작했으므로 테스트도 통과했다.**

그리고 두 번째 파도가 온다. 앱을 컨테이너로 옮기면서 시계 ①이 UTC가 되면, **그날 배포 시점부터의 행은 UTC 벽시계, 그 이전 행은 KST 벽시계**가 한 컬럼에 섞인다. 어느 행이 어느 기준인지는 배포 시각으로 추정하는 수밖에 없고, 그 경계 근처의 데이터는 영영 애매하다. **`timestamp`가 존 정보를 버린 대가는 사고가 났을 때 "값을 복구할 근거"가 없다는 것**으로 청구된다.

**사고 ②: `Instant`인데 컬럼이 `timestamp` — 왕복에서 상쇄돼 앱에선 안 보인다.** 엔티티는 제대로 `Instant`를 쓴다. 그런데 스키마가 Hibernate 자동 생성이거나, 마이그레이션 스크립트에 `timestamp`로 적혀 있다. `hibernate.jdbc.time_zone`은 안 줬다.

> **⑴ Hibernate는 `Instant`를 `timestamp` 컬럼에 넣기 위해 벽시계로 낮춰야 한다 — 기준은 시계 ②(= 기본값이면 JVM 존 KST).** → **⑵ 진짜 순간 `00:00Z`가 `'09:00'`이라는 KST 벽시계로 저장된다.** → **⑶ 읽을 때도 같은 KST 기준으로 되돌리므로 앱이 받는 `Instant`는 정확히 `00:00Z`다 — 앱 화면·앱 테스트 전부 정상.** → **⑷ 틀린 값은 이 경로를 거치지 않는 모든 곳에서만 보인다** — psql, `now()`와 비교하는 SQL 배치, 파이썬 정산 스크립트, BI 도구, 레플리카에서 뽑는 리포트. → **⑸ 발견은 몇 달 뒤 정산 금액이 하루치씩 어긋난다는 제보로 온다.**

두 사고의 공통 구조 — **어긋난 시계 한 쌍이 왕복에서 서로 상쇄되면 앱은 정상으로 보이고, 제3의 독자(psql·배치·타 언어)가 나타날 때 드러난다.** 그리고 둘 다 **컬럼 타입이 `timestamptz`였으면 애초에 일어나지 않았다** — §3-3의 회귀 테스트가 **값뿐 아니라 컬럼 타입까지 단정**하는 이유다.

### 2-3. 트레이드오프 양면 — 각 타입이 얻는 것과 내는 것

한 호흡에 양면으로 말한다. 면접관은 어느 쪽을 고르는지보다 **반대편 비용을 빠뜨리지 않는지**를 본다.

**`timestamptz`가 얻는 것**: ⑴ **UTC 정규화를 DB가 강제**한다 — 자바든 파이썬이든 psql이든 넣는 순간 순간(instant)이 된다. 규율이 스키마에 있다. ⑵ **드라이버가 오프셋을 명시해 보내므로 시계가 어긋나도 저장이 안 밀린다**(§2-1) — 운영 실수에 대한 내성. ⑶ 타입 자체가 "순간"이라 **컬럼의 의미가 DDL에 드러난다.** ⑷ 비교·정렬·인덱스가 세션 존과 무관하게 일관된다. ⑸ 읽는 쪽이 자기 존으로 보게 하는 표시 변환이 공짜다.

**`timestamptz`가 내는 것**: ⑴ **출력이 세션 존에 따라 달라져 디버깅이 헷갈린다** — psql에서 본 숫자와 BI에서 본 숫자가 다를 수 있고(§1-3의 3열 표처럼 **날짜까지 달라진다**), "몇 시로 저장돼 있나"라는 질문 자체가 성립하지 않는다. 판정은 늘 `AT TIME ZONE 'UTC'`로 못 박아야 한다. ⑵ **`::date`·`date_trunc` 계열 연산이 세션 존에 의존**해 그대로 쓰면 인덱스를 못 타고 조용히 풀스캔이 된다(§2-5). ⑶ **이름이 오해를 부른다** — "존이 저장되니 미래 일정도 그냥 넣으면 되겠지"라는 잘못된 안도감(§2-4 (b)). ⑷ DST가 있는 존을 세션에 쓰면 벽시계 → 순간 변환이 1:1이 아닌 시간대가 생긴다(전환일의 중복 1시간, 존재하지 않는 1시간).

**`timestamp`가 얻는 것**: ⑴ **세션 존 무관** — psql에서 보이는 값이 곧 저장된 값이라 예측 가능하고, 누가 어디서 읽어도 같은 숫자다. ⑵ **"벽시계가 의도"인 값을 왜곡 없이 담는다** — 미래 일정의 원본, DST가 개입하면 안 되는 값. ⑶ 존 변환이 없어 연산이 단순하다.

**`timestamp`가 내는 것**: ⑴ **타임존 정보가 없다** — "이 컬럼은 UTC"라는 규약이 코드·설정·리뷰 규칙에 있어야 하고, 규약이 깨져 KST 벽시계가 들어와도 **DB는 못 잡는다**(사고 ①·②). ⑵ 그 결과 사고가 나면 **복구 근거가 값에 없다.** ⑶ `now()`·`timestamptz`와 비교하는 순간 **세션 존이 결과를 바꾼다**(§1-4). ⑷ `DEFAULT now()`가 세션 존 벽시계를 넣으므로 **결국 세션 존도 UTC로 맞춰야 한다** — "타임존 무관"이 "설정 무관"은 아니다.

**둘 다 내야 하는 것**: 시계 정합. 어느 타입을 골라도 이 비용이 0이 되지는 않는다. 차이는 **정합이 깨졌을 때 무엇이 틀리는가** — `timestamptz`는 보이는 표기만 틀리고(값은 무사), `timestamp`는 저장된 값의 기준이 틀린다(복구 불가). **이 비대칭이 PostgreSQL에서 결론을 정한다.**

### 2-4. 선택 조건 — "글로벌 서비스라면"에 대한 내 결론

시각 컬럼을 한 종류로 보지 않는 것이 출발점이다. **과거·현재의 사건**과 **미래의 일정**은 저장해야 할 것이 다르다.

**(a) 과거·현재의 사건** — `created_at`, `paid_at`, `last_login_at`, `deleted_at`. 저장할 것은 "그 일이 벌어진 **순간**"이고, 순간은 UTC 하나로 충분하다. 여기서는 **`timestamptz` + 자바 `Instant`**가 답이다. 근거는 셋이다. ⑴ **DB가 정규화를 강제**하므로 앱 규율이 깨져도 순간이 안 틀린다 — psql로 손댄 데이터도, 파이썬 배치가 넣은 데이터도 같은 기준이 된다. ⑵ **범위·크기가 `timestamp`와 같아 반대편에 낼 대가가 없다** — MySQL에서 `DATETIME`을 고르게 만들던 2038·1바이트 근거가 PostgreSQL에는 존재하지 않는다. ⑶ **시계가 어긋나도 저장이 안 밀린다**(§2-1) — 운영에서 실수는 반드시 일어나므로, 실수했을 때 "표기만 틀리는" 쪽을 고르는 것이 설계다.

> **MySQL이었다면 결론이 뒤집힌다.** MySQL에서는 `TIMESTAMP`의 2038 한계와 묵시 `DEFAULT` 이력 때문에 **`DATETIME(6)` + 네 시계 UTC 고정 + 앱 규율**을 고르는 것이 합리적이었다. **PostgreSQL은 `timestamptz`에서 그 두 대가가 사라지므로 같은 논리가 정반대 결론에 착지한다.** 면접에서 이 문장을 붙이면 "격언을 옮겨온" 게 아니라 "근거에서 다시 도출한" 것으로 들린다.

**(b) 미래의 일정** — "매일 밤 11시 신작 공개", 구독 갱신일, 예약 발송 시각. 사용자가 의도한 것은 "**그 도시의 벽시계로 23:00**"이지 특정 UTC 순간이 아니다. 지금 UTC로 환산해 저장하면 **DST 전환이나 그 나라의 DST 폐지(tzdata 변경)로 환산 결과가 바뀌는 순간 의도와 어긋난다.** 그래서 **로컬 벽시계(`timestamp`) + IANA 존 ID(`text`, `Asia/Seoul`처럼 규칙을 담는 이름 — `+09:00` 같은 오프셋은 "지금의 결과"일 뿐 규칙을 못 담는다)** 를 분해 저장하고, UTC 순간은 **정렬·스캔용 파생 컬럼(언제든 `AT TIME ZONE`으로 재계산 가능한 캐시)** 으로만 둔다. **`timestamptz`가 존을 저장한다고 오해하면 이 설계를 건너뛰게 되고**, tzdata가 바뀌는 날 예약 시각 전체가 조용히 틀어진다. 이 설계의 상세와 DST 전환일의 문제는 [22장 글로벌 서비스/시간 문서](../22-global-i18n/)가 다룬다.

**(c) 날짜만 의미 있는 것** — 생년월일, 정산 기준일. `date`다. 시각을 붙여 `timestamptz`로 두면 존 변환 한 번에 하루가 밀린다(§1-3의 LA 행이 정확히 그 예다).

**(d) 구간이 의미인 것** (가산점 포인트) — 예약, 대여, 유효기간처럼 "겹치면 안 되는 구간"은 PostgreSQL에 전용 도구가 있다. `tstzrange`(timestamptz의 범위 타입)와 **`EXCLUDE` 제약**이다. `EXCLUDE`는 "이 조건들을 동시에 만족하는 두 행이 존재하면 거부한다"는 제약으로, 유니크 제약을 등호가 아닌 임의 연산자로 일반화한 것이다.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- 스칼라 = 비교를 GiST에서 쓰려면 필요

CREATE TABLE reservation (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id bigint      NOT NULL,
    period  tstzrange   NOT NULL,
    -- 같은 방(room_id =)에서 기간이 겹치면(&&) 아예 INSERT 가 거부된다.
    -- 앱의 "조회 후 없으면 INSERT" 경쟁을 제약으로 대체한다.
    EXCLUDE USING gist (room_id WITH =, period WITH &&)
);
```

`start_at`/`end_at` 두 컬럼 + 애플리케이션 겹침 검사로 풀던 문제를 DB 제약으로 내리는 것 — MySQL에는 대응물이 없는 PostgreSQL 고유 카드다.

**(e) 시각만 있고 날짜가 없는 것** — `time`을 쓴다. **`timetz`(time with time zone)는 쓰지 않는다** — 날짜가 없으면 DST 규칙을 적용할 수 없어(그 오프셋이 여름 것인지 겨울 것인지 알 방법이 없다) 오프셋이 의미를 갖지 못하고, PostgreSQL 문서 자체가 유용성에 의문을 표시하는 타입이다.

### 2-5. 인덱스 함정 — `timestamptz`에 `::date`를 씌우면 두 번 진다

`timestamptz`를 고르면 따라오는 실무 함정이 하나 있다. **"오늘 매출"류의 일 단위 집계**다.

**"두 번 진다"의 두 번이 각각 무엇인지부터 나눠서 못 박는다.**

> **첫 번째 패배 — 컬럼에 함수/캐스트를 씌우면 인덱스를 못 탄다.** 인덱스는 `paid_at` 값 자체로 정렬돼 있는데, 조건이 요구하는 것은 `paid_at::date`라는 **가공된 값**이다. 인덱스에는 그 가공된 값이 없으므로 옵티마이저는 모든 행을 읽어 하나씩 캐스트해 볼 수밖에 없다 → `Seq Scan`. 여기까지는 PostgreSQL만의 이야기가 아니라 인덱스의 일반 원리다([인덱스가 있는데 풀스캔](./02-index-not-used-full-scan.md)).
>
> **두 번째 패배 — 이 식은 그대로는 표현식 인덱스로 만들 수도 없다.** 보통 첫 번째 패배는 "가공된 값 자체를 인덱스로 만들어" 우회한다(표현식 인덱스). 그런데 `timestamptz → date` 캐스트는 **세션 `TimeZone`에 따라 결과가 달라지는 STABLE 함수**다(같은 입력이라도 세션 설정이 바뀌면 결과가 바뀐다). 인덱스는 "언제 어디서 계산해도 같은 값"을 전제로 디스크에 값을 굳혀 두는 구조이므로, PostgreSQL은 IMMUTABLE(입력이 같으면 언제나 같은 결과) 함수만 인덱스 식으로 받는다. 그래서 `CREATE INDEX ... ((paid_at::date))`는 **`functions in index expression must be marked IMMUTABLE`로 거부된다.** MySQL에서 `DATE(col)` 함수 인덱스로 넘기던 습관이 여기서 통하지 않는다.
>
> **덤으로 세 번째** — `'2026-08-31'`이 **어느 존의 하루인지가 세션 설정에 숨는다.** 같은 쿼리가 psql(세션 UTC)과 앱(세션 KST)에서 다른 답을 낸다. 쿼리 텍스트만 봐서는 그 사실을 알 수 없다는 것이 가장 나쁘다.

```sql
-- before — 컬럼에 캐스트를 씌운다
SELECT sum(amount) FROM payment
WHERE paid_at::date = DATE '2026-08-31';
--  Seq Scan on payment  (actual rows=1204 loops=1)
--    Filter: ((paid_at)::date = '2026-08-31'::date)
--    Rows Removed by Filter: 4,318,796
--    Buffers: shared read=61,204
--  ↑ 431만 행을 읽어 1,204행을 건졌다. 필요한 것의 3,600배를 읽은 셈.

-- after — 경계를 앱이 "비즈니스 존"으로 계산해 UTC 순간으로 바인딩한다
SELECT sum(amount) FROM payment
WHERE paid_at >= $1 AND paid_at < $2;      -- $1,$2 = OffsetDateTime (UTC)
--  Index Scan using idx_payment_paid_at on payment
--    Index Cond: ((paid_at >= $1) AND (paid_at < $2))
--    (actual rows=1204 loops=1)
--    Buffers: shared hit=38
--  ↑ 61,204 버퍼 → 38 버퍼. 컬럼이 맨몸이라 인덱스 범위 탐색이 되고,
--    경계 계산이 앱 코드에 드러나 "무슨 존의 하루인가"가 리뷰에서 보인다.
--    ※ >= 와 < 로 반열린 구간을 쓰는 이유: BETWEEN 은 양끝을 포함하므로
--      자정 정각에 찍힌 행이 이틀에 중복으로 잡힌다.
```

경계 계산은 자바 쪽에서 이렇게 나온다 — 존이 **코드에 명시**되는 것이 요점:

```java
ZoneId biz = ZoneId.of("Asia/Seoul");                  // 비즈니스 존을 명시
LocalDate day = LocalDate.of(2026, 8, 31);
Instant from = day.atStartOfDay(biz).toInstant();      // 2026-08-30T15:00:00Z
Instant to   = day.plusDays(1).atStartOfDay(biz).toInstant();  // 2026-08-31T15:00:00Z
// 서울은 UTC+9 이므로 "서울의 8/31 하루"는 UTC 로 8/30 15:00 ~ 8/31 15:00 이다.
// DST 가 있는 존이라면 atStartOfDay 가 23시간/25시간짜리 하루를 알아서 처리한다 —
// 이것이 "앱이 계산해서 넘긴다"의 진짜 이득이다. SQL 로는 이 처리를 흉내 내기 어렵다.
```

> **가산점 — 그래도 SQL 안에서 존별 하루를 다뤄야 한다면.** 존을 **상수로 박아** `date_trunc('day', paid_at AT TIME ZONE 'Asia/Seoul')`처럼 쓴다. 그리고 **이 식은 표현식 인덱스로 만들 수 있다.** 이유는 함수 변동성 표시가 갈리기 때문이다 — `AT TIME ZONE`에 **존을 리터럴로 준** 형태는 IMMUTABLE로 표시돼 있고(세션 설정을 안 보므로), 그것이 돌려주는 `timestamp`에 대한 `date_trunc`도 IMMUTABLE이다. 반면 존 없이 `timestamptz`에 바로 거는 `date_trunc('day', paid_at)`이나 `paid_at::date`는 세션 의존이라 STABLE이고 거부된다. **정리하면 "존을 명시하면 인덱스가 되고, 세션에 맡기면 안 된다."** 다만 이 우회에는 대가가 둘 있다. ⑴ **존이 인덱스에 박힌다** — 서울용·LA용 인덱스를 따로 만들어야 하고, 글로벌 서비스에서는 이게 곧 인덱스 개수 폭발이다. ⑵ **IMMUTABLE 표시는 "tzdata가 안 바뀐다"는 가정 위의 실용적 약속**이라, 그 존의 규칙이 실제로 바뀌면 인덱스에 굳어 있는 값이 현실과 어긋나 `REINDEX`가 필요하다. 그래서 **정석은 여전히 위 after의 UTC 경계 범위 조건**이다 — 인덱스 하나로 모든 존을 커버하고, tzdata 변경에도 영향을 안 받는다.

**`interval` 산술의 DST 함정도 같은 계열이다 (가산점 포인트).** `timestamptz + interval '1 day'`는 세션 존의 **달력 기준 하루**를 더하므로 DST 전환일에는 23시간 또는 25시간이 되고, `+ interval '24 hours'`는 정확히 24시간이다. "매일 같은 시각"이 의도면 전자, "정확히 하루 뒤 순간"이 의도면 후자다 — **둘이 다르다는 것을 아는지가 변별점**이고, UTC 세션에서는 DST가 없어 둘이 같아지므로 차이가 숨는다(한국만 서비스할 때 이 버그가 안 드러나는 이유도 같다 — 한국에는 현재 서머타임이 없다).

---

## 3. 안전망 — 선택을 설정·타입 규약·테스트로 고정한다

"`timestamptz` + `Instant`로 간다"는 결정은 세 층에 못 박아야 유지된다. **설정**(시계), **타입 규약**(어떤 자바 타입을 어디에 쓰는가), **테스트**(어긋나면 빌드가 깨진다).

### 3-1. before / after — JPA 엔티티, PG DDL, 시계 설정

```java
// before — 값이 "지금 이 서버가 있는 곳"의 벽시계에 묶인다
@Entity
public class Payment {
    @Id @GeneratedValue
    private Long id;

    @CreatedDate
    private LocalDateTime createdAt;   // ① 타임존 없는 벽시계 — "어디 기준 09:00"인지 값이 모른다
                                       //    Hibernate 자동 DDL이면 컬럼도 timestamp 로 만들어진다

    private LocalDateTime paidAt;      // ② paidAt = LocalDateTime.now();
                                       //    → JVM 기본 존의 벽시계. 개발 PC(KST)와 컨테이너(UTC)에서
                                       //      서로 다른 값이 저장되고, timestamp 는 그 차이를 기록하지 않는다
}
```

```java
// after — 사건은 Instant(순간) + timestamptz, 미래 일정은 로컬 벽시계 + 존 ID로 분해
@Entity
public class Payment {
    @Id @GeneratedValue
    private Long id;

    @CreatedDate
    @Column(columnDefinition = "timestamptz")   // 의도를 엔티티에도 남긴다(DDL은 아래 마이그레이션이 진실)
    private Instant createdAt;                  // 순간 — 어느 서버에서 만들어도 같은 값

    @Column(columnDefinition = "timestamptz")
    private Instant paidAt;                     // paidAt = clock.instant();  ← Clock 주입, 테스트에서 고정 가능
}

@Entity
public class EpisodeSchedule {
    @Id @GeneratedValue
    private Long id;

    @LocalWallClock                    // 프로젝트 마커 — "의도적으로 로컬 벽시계" (§3-2의 ArchUnit 예외 근거)
    private LocalDateTime publishLocalAt;   // 2026-09-01T23:00 — 사용자가 고른 그 벽시계 → timestamp
    private String        publishZoneId;    // "Asia/Seoul" — 오프셋(+09:00)이 아니라 규칙을 담는 IANA 존 ID
    private Instant       publishAtUtc;     // 정렬·스캔용 파생 캐시 → timestamptz. 존 규칙이 바뀌면 재계산
}
```

> **Hibernate 버전 주의**: `Instant`·`OffsetDateTime`을 어떤 SQL 타입으로 내보낼지(그리고 `hibernate.timezone.default_storage`가 어떻게 작동할지)는 Hibernate 메이저 버전 사이에 달라져 왔다. **DDL을 Hibernate 자동 생성에 맡기지 말고 마이그레이션 스크립트(Flyway/Liquibase)를 진실로 삼은 뒤, §3-3의 "컬럼 타입 단정" 테스트로 실제 타입을 못 박는다.** 이것이 버전 지식에 의존하지 않는 유일한 방법이다.

```sql
-- after — DDL. 사건 시각은 timestamptz, 규약은 COMMENT 로 스키마에도 적는다
CREATE TABLE payment (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- DEFAULT 는 앱 밖 경로(psql·타 언어 배치)용. now() = 트랜잭션 시작 시각(§1-7)
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at    timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    amount     numeric(12,2) NOT NULL
);
COMMENT ON COLUMN payment.created_at IS 'UTC 순간. DEFAULT now() = 트랜잭션 시작 시각';
CREATE INDEX idx_payment_paid_at ON payment (paid_at);   -- §2-5의 범위 조건이 타는 인덱스

-- 미래 일정: 원본은 "벽시계 + 존 ID", UTC 는 재계산 가능한 파생 캐시
CREATE TABLE episode_schedule (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    publish_local_at timestamp   NOT NULL,   -- publish_zone_id 기준 로컬 벽시계 (변환 금지)
    publish_zone_id  text        NOT NULL,   -- IANA 존 ID. 오프셋 저장 금지
    publish_at_utc   timestamptz NOT NULL    -- 파생 캐시 = publish_local_at AT TIME ZONE publish_zone_id
);
CREATE INDEX idx_schedule_publish_utc ON episode_schedule (publish_at_utc);
COMMENT ON COLUMN episode_schedule.publish_at_utc IS
    '파생 캐시. tzdata 변경 시 publish_local_at + publish_zone_id 에서 재계산한다';
```

> **왜 `publish_at_utc`를 generated column으로 만들지 않나** — 생성 컬럼은 "원본이 바뀔 때만" 다시 계산된다. 그런데 이 값이 틀어지는 원인은 원본 변경이 아니라 **tzdata(존 규칙) 변경**이다. **"규칙이 바뀌면 배치가 다시 계산한다"가 설계 의도**이므로, 재계산 주체를 앱·배치로 두고 컬럼은 평범한 캐시로 남긴다.

`updated_at` 자동 갱신은 §1-8의 `BEFORE UPDATE` 트리거로 붙인다 — DB 레벨이라 벌크 UPDATE·네이티브 쿼리·psql 수동 SQL에서도 살아 있다.

```yaml
# after — 시계를 못 박는다
spring:
  datasource:
    url: jdbc:postgresql://db:5432/app
  jpa:
    properties:
      # ② Hibernate → JDBC 기준 존. timestamptz 로 가는 값에는 영향이 없지만,
      #    남아 있는 timestamp 컬럼(미래 일정 원본 등)을 위해 UTC 로 고정해 둔다
      hibernate.jdbc.time_zone: UTC
  jackson:
    # (표시 층) JSON 직렬화 기준 — 응답은 ISO-8601 + 오프셋('Z')로 나간다
    time-zone: UTC
```

```dockerfile
# ① JVM 기본 존 = UTC.
#    PostgreSQL 에서는 이 한 줄이 곧 "앱 세션의 TimeZone"이다 —
#    pgjdbc 가 접속할 때 이 값을 세션 TimeZone 으로 설정하기 때문(③).
#    코드에서 TimeZone.setDefault() 로 바꾸는 것은 커넥션 풀 초기화보다 늦을 수 있어 실행 옵션으로 준다.
ENV TZ=UTC
ENV JAVA_TOOL_OPTIONS="-Duser.timezone=UTC"
```

```sql
-- ④ 앱 밖 독자(psql·배치·BI·관리 콘솔)의 기준. 서버 postgresql.conf 의
--    timezone = 'UTC' 와 같은 목적이며, DB/롤 단위로도 못 박을 수 있다.
--    주의: pgjdbc 로 붙는 앱 세션은 이 값을 ① 로 덮으므로, 앱 쪽 처방은 위 Dockerfile 이다.
ALTER DATABASE app     SET timezone = 'UTC';
ALTER ROLE     analyst SET timezone = 'UTC';
```

`@CreatedDate`가 `Instant` 필드를 채우는 것은 Spring Data가 지원한다. "지금"을 `Clock`에서 꺼내려면 `DateTimeProvider` 빈을 등록해 `@EnableJpaAuditing(dateTimeProviderRef = "…")`로 연결한다 — 그러면 Auditing 시각도 테스트에서 고정된다.

### 3-2. 타입 규약을 ArchUnit으로 — "규칙을 아는 사람"에 의존하지 않기

자바 타입 규약은 세 줄이다. **순간은 `Instant`**(저장·전송·비교의 기본, 컬럼은 `timestamptz`), **로컬 벽시계는 `LocalDateTime`**(미래 일정의 사용자 입력처럼 "존을 모르는 것이 의도"인 자리에만, 컬럼은 `timestamp` + 존 ID), **`ZonedDateTime`은 계산용**(로컬 벽시계 + 존 ID로 순간을 구할 때 잠깐 쓰고 저장은 분해해서). 이 규약을 리뷰 코멘트로만 두면 세 번째 신규 입사자 때 깨진다. 빌드에 넣는다.

```java
@AnalyzeClasses(packages = "com.example")
class TimeTypeRulesTest {

    // 규약 1: 엔티티 필드에 LocalDateTime 금지 — 예외는 @LocalWallClock 으로 의도를 밝힌 필드뿐
    //         (LocalDateTime 필드는 곧 timestamp 컬럼이 되고, 그것이 §2-2 두 사고의 공통 뿌리다)
    @ArchTest
    static final ArchRule entities_store_instants =
        noFields().that().areDeclaredInClassesThat().areAnnotatedWith(Entity.class)
            .and().areNotAnnotatedWith(LocalWallClock.class)
            .should().haveRawType(LocalDateTime.class)
            .because("엔티티의 시각은 Instant(→ timestamptz)로 저장한다. 미래 로컬 일정만 @LocalWallClock 으로 표시");

    // 규약 2: JVM 기본 존에 몰래 의존하는 API 호출 금지 — '지금'은 주입받은 Clock 에서 꺼낸다
    @ArchTest
    static final ArchRule no_default_zone_dependency =
        noClasses().should().callMethod(LocalDateTime.class, "now")
            .orShould().callMethod(ZoneId.class, "systemDefault")
            .orShould().callConstructor(Date.class)
            .because("서버가 어디에 있든 같은 값이어야 한다. Clock.instant() / ZoneId.of(사용자 존)을 쓴다");
}
```

규약 2가 잡는 것이 사고 ①의 첫 고리(`LocalDateTime.now()`)다. **사고 사슬의 첫 고리를 빌드 단계에서 끊는 것**이 안전망의 요령이다 — 마지막 고리(배치 오작동)에서 잡으면 이미 데이터가 섞인 뒤다.

### 3-3. 회귀 테스트 — "컬럼 타입"과 "UTC로 못 박은 값"을 단정한다

설정은 누군가 URL을 정리하다가, 베이스 이미지를 바꾸다가, 마이그레이션을 손으로 고치다가 하나씩 사라진다. 사라지면 빌드가 깨져야 한다. PostgreSQL판 요령은 셋이다 — **⑴ DB 컨테이너와 테스트 JVM을 일부러 UTC가 아닌 존으로 띄운다** **⑵ 값을 단정할 때 `AT TIME ZONE 'UTC'`로 기준을 못 박는다**(세션 존에 따라 표기가 달라지는 §1-3을 통과하기 위해) **⑶ 값뿐 아니라 `information_schema`로 컬럼 타입까지 단정한다**(§2-2 사고 ②는 타입이 잘못된 순간 시작된다).

```java
@SpringBootTest
@Testcontainers
@Tag("timezone")                     // 아래 빌드 매트릭스가 이 태그를 여러 JVM 존에서 돌린다
class TimeZoneRegressionTest {

    // ⑴ DB OS 존을 일부러 UTC가 아닌 곳으로 — 설정이 OS 존을 이기는지 확인
    @Container
    static final PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:16")
            .withEnv("TZ", "America/Los_Angeles");

    @Autowired PaymentRepository repo;
    @Autowired JdbcTemplate jdbc;

    @Test
    void 컬럼_타입이_timestamptz다() {
        // 사고 ②의 뿌리 차단 — 마이그레이션이나 자동 DDL이 timestamp 로 만들었으면 여기서 깨진다
        String type = jdbc.queryForObject(
                "SELECT data_type FROM information_schema.columns "
              + "WHERE table_name = 'payment' AND column_name = 'paid_at'", String.class);
        assertThat(type).isEqualTo("timestamp with time zone");
    }

    @Test
    void 앱_세션의_TimeZone은_JVM_존을_따라간다() {
        // pgjdbc 가 접속 시 세션 TimeZone 을 JVM 존으로 설정한다는 사실 자체를 문서화하는 테스트.
        // -Duser.timezone=UTC 가 빠지면 여기서 깨져 "왜 psql 과 다르게 보이나"를 미리 알려준다.
        assertThat(jdbc.queryForObject("SHOW TimeZone", String.class))
                .isEqualTo(java.util.TimeZone.getDefault().getID());
    }

    @Test
    void 어떤_JVM_존에서_돌려도_같은_순간이_저장된다() {
        Instant paidAt = Instant.parse("2026-08-31T00:00:00Z");
        Long id = repo.save(Payment.paid(paidAt)).getId();

        // ⑵ 세션 존 표기에 흔들리지 않도록 UTC 로 못 박아 문자열로 꺼낸다
        String raw = jdbc.queryForObject(
                "SELECT to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') "
              + "FROM payment WHERE id = ?", String.class, id);
        assertThat(raw).isEqualTo("2026-08-31 00:00:00");   // KST 09:00 이 적혔다면 여기서 깨진다

        // 앱 경로로 읽어도 같은 순간
        assertThat(repo.findById(id).orElseThrow().getPaidAt()).isEqualTo(paidAt);
    }

    @Test
    void DB_DEFAULT_경로와_앱_경로의_기준이_같다() {
        // §1-4의 "한 컬럼 두 기준" 방지 — DEFAULT now() 로 채워진 created_at 과
        // 앱이 넣은 paid_at 의 기준이 같은가
        Long id = jdbc.queryForObject(
                "INSERT INTO payment (paid_at, amount) VALUES (now(), 1000) RETURNING id",
                Long.class);
        Double diffSec = jdbc.queryForObject(
                "SELECT abs(extract(epoch FROM (paid_at - created_at))) FROM payment WHERE id = ?",
                Double.class, id);
        assertThat(diffSec).isLessThan(5.0);   // 9시간(= 32,400초) 차이면 기준이 어긋난 것
    }
}
```

"어떤 JVM 존에서 돌려도"는 **테스트 코드 안에서 `TimeZone.setDefault()`를 바꾸는 방식으로 하지 않는다** — pgjdbc는 **접속 시점의 JVM 기본 존**으로 세션 `TimeZone`을 잡아 두므로, 런타임에 바꾼 값은 이미 열린 풀의 커넥션에 반영되지 않아 거짓 통과가 난다. 대신 **빌드 매트릭스**로 JVM 자체를 다른 존으로 띄운다.

```groovy
// build.gradle — 같은 테스트를 세 존에서 돌린다. 하나라도 깨지면 어느 설정이 새는지 바로 안다
["UTC", "Asia/Seoul", "America/Los_Angeles"].each { zone ->
    tasks.register("testIn${zone.replace('/', '_')}", Test) {
        systemProperty "user.timezone", zone
        useJUnitPlatform { includeTags "timezone" }
    }
}
```

세 존을 이렇게 고른 이유도 근거가 있다 — UTC(기준), `Asia/Seoul`(DST 없이 +9시간만 어긋나는 존), `America/Los_Angeles`(**DST가 있고 부호가 반대인 존**). 세 번째가 있어야 "여름과 겨울에 다르게 깨지는" 버그와 "날짜가 하루 앞으로 밀리는" 버그가 잡힌다.

`timestamptz`를 쓰면 세 존 모두 통과하는 것이 정상이다 — **그게 이 타입을 고른 이유**다. `timestamp` 컬럼이 하나라도 섞여 있으면 그 컬럼에서만 `Asia/Seoul` 잡이 깨지고, 그것이 곧 "어디에 규약 의존이 남아 있는지"의 지도가 된다.

### 3-4. 글로벌 서비스 시간 원칙 — 그리고 각 원칙이 PG 스키마에 착지하는 지점

rationale의 표현대로, 22장의 원칙은 4장에서 컬럼 하나하나로 착지한다. 목록으로 인출한다.

1. **저장은 UTC 순간.** 과거·현재의 사건은 UTC 하나로 적는다. → 착지: **`timestamptz`**. PostgreSQL에서는 이게 곧 UTC 정규화이므로 "앱이 UTC로 바꿔 넣는다"는 규약이 필요 없다. `DEFAULT now()`도 안전하다.
2. **표시는 사용자 타임존, 변환은 가장 바깥에서.** → 착지: DB에서는 `AT TIME ZONE`을 **표시용 SELECT 목록에서만** 쓰고 `WHERE`에는 쓰지 않는다. **`WHERE paid_at::date = …`처럼 컬럼에 캐스트를 씌우면 인덱스를 못 타고, 그 식은 세션 의존이라 표현식 인덱스로도 못 만든다**(§2-5, [인덱스가 있는데 풀스캔](./02-index-not-used-full-scan.md)). 존을 리터럴로 박은 `date_trunc('day', paid_at AT TIME ZONE 'Asia/Seoul')`은 표현식 인덱스가 되지만 존마다 인덱스가 하나씩 필요하므로, **일 단위 경계는 앱이 비즈니스 존으로 시작·끝 순간을 계산해 UTC 파라미터로 바인딩**하는 쪽이 정석이다(`paid_at >= $1 AND paid_at < $2`).
3. **미래 일정은 로컬 벽시계 + IANA 존 ID.** → 착지: `timestamp` + `text` 두 컬럼 + 파생 `timestamptz` 캐시. 오프셋(`+09:00`) 저장 금지. **`timestamptz`가 존을 저장한다는 오해가 이 원칙을 건너뛰게 만든다**(§1-3).
4. **타임존 규칙 변경(tzdata)에 대비.** DST 폐지·도입은 실제로 일어난다. → 착지: 파생 UTC 컬럼을 "진실"로 삼지 않는다(규칙이 바뀌면 3의 원본에서 `AT TIME ZONE`으로 재계산하는 배치가 있어야 한다). tzdata 갱신 절차(JVM·OS·PostgreSQL 서버)를 운영 항목으로 둔다. 존을 박아 만든 표현식 인덱스가 있다면 그것도 `REINDEX` 대상이다(§2-5).
5. **시계를 하나로 못 박고 테스트로 지킨다.** → 착지: §3-1 설정(`-Duser.timezone=UTC` → pgjdbc 세션까지 따라온다, `ALTER DATABASE … SET timezone`) + §3-3 회귀 테스트 + 빌드 매트릭스.
6. **"지금"은 주입받은 `Clock`에서.** → 착지: §3-2 ArchUnit. **그리고 SQL 쪽에서는 `now()`가 트랜잭션 시작 시각임을 기억한다**(§1-7) — 배치의 기준 시각을 `now()`에 맡기지 않고 앱이 `Instant`로 계산해 파라미터로 넘기면, 사고 ①의 "컬럼과 기준선의 존이 다른" 비교도, 트랜잭션 길이에 따라 기준선이 밀리는 문제도 함께 사라지고 테스트에서 고정할 수 있다.
7. **타입 규약을 이름으로.** `Instant`(순간) / `LocalDateTime`(의도된 로컬 벽시계) / `ZonedDateTime`(계산용) / `LocalDate`(날짜만). → 착지: 컬럼 타입도 1:1로 대응된다 — `timestamptz` / `timestamp` + 존 ID / (저장 안 함) / `date`. **자바 타입과 PostgreSQL 타입이 한 쌍씩 맞물리는 것이 PostgreSQL의 편한 점**이다.

---

## 4. 꼬리질문 대비 포인트

### "`timestamptz`는 타임존까지 저장하는 건가요? 이름이 그런데요."

**아니다 — 저장하는 것은 UTC 순간 하나뿐이고, 존은 입출력에서만 쓰인다.** 사슬로 답한다. 입력에 오프셋이 있으면 그걸로, 없으면 **세션 `TimeZone`으로 해석**해 UTC로 환산한 8바이트 정수를 저장한다. 출력할 때 붙는 `+09` 같은 표기는 **"저장된 존"이 아니라 "지금 이 세션의 존"**이다. 증명은 한 줄이면 된다 — `SET timezone` 을 바꿔가며 같은 행을 두 번 읽으면 표기만 바뀐다(§1-3). 세션을 `America/Los_Angeles`로 두면 **날짜까지 하루 앞으로 밀려 보인다**는 것까지 덧붙이면 확실하다. 그래서 **`timestamptz` 컬럼에 "몇 시로 저장돼 있나요?"는 성립하지 않는 질문**이고, 판정은 `AT TIME ZONE 'UTC'`로 못 박아야 한다. 실무적 파장이 큰 오해다 — "존이 저장되니 예약 시각도 그냥 넣으면 되겠지"라고 믿으면 **미래 일정에 존 ID 컬럼을 두지 않게 되고**, tzdata가 바뀌는 날 예약 시각 전체가 조용히 틀어진다.

### "그럼 `timestamp`(without time zone)는 안 쓰나요? 어떤 자리에 남기나요?"

**과거·현재의 사건에는 안 쓴다. 남는 자리는 "벽시계 자체가 의미인 값"뿐**이다. ⑴ **미래 일정의 원본** — "매일 밤 11시 공개"는 순간이 아니라 규칙이라 `timestamp`(로컬 벽시계) + IANA 존 ID로 분해 저장한다(§2-4 (b)). ⑵ **DST가 개입하면 안 되는 사무적 값** — 예: 계약서에 적힌 "2026-09-01 09:00"이라는 문자열 자체가 법적 사실인 경우. ⑶ **외부 시스템이 존 없이 준 값을 원문 그대로 보관**할 때(변환은 나중에 근거와 함께). 양면을 붙이면 — `timestamp`가 얻는 것은 "세션 존과 무관하게 보이는 값 = 저장된 값"이라는 예측 가능성이고, 내는 것은 **타임존 정보 소실과 복구 근거 없음**, 그리고 `now()`·`timestamptz`와 비교하는 순간 세션 존이 결과를 바꾼다는 것이다(§1-4). PostgreSQL에서는 두 타입의 크기·범위가 같으므로 **"성능·용량 때문에 `timestamp`"라는 근거는 아예 없다** — 오직 의미로만 고른다.

### "`created_at`이 실제 시각보다 이르고, 한 배치에서 넣은 1만 건이 전부 같은 시각입니다."

**`now()`가 "지금"이 아니라 트랜잭션 시작 시각이기 때문이다** (§1-7). `now()` = `CURRENT_TIMESTAMP` = `transaction_timestamp()`이고, 문장 시작 시각은 `statement_timestamp()`, 실제 호출 순간은 `clock_timestamp()`다. 트랜잭션이 10분 열려 있었으면 `DEFAULT now()`로 채워진 값은 10분 과거를 가리키고, 한 트랜잭션의 대량 INSERT는 전부 같은 값이 된다. 파장 셋 — ⑴ **`created_at`으로는 삽입 순서를 가릴 수 없다.** 커서 페이지네이션이 `WHERE created_at < :마지막값`으로 다음 장을 뜨면, 같은 값을 가진 1만 건이 `<` 조건을 못 만족해 **통째로 건너뛰어진다** — 키셋 페이지네이션의 타이브레이커가 `id`처럼 유일한 컬럼이어야 하는 이유가 이것이다([딥 페이지네이션](./13-deep-pagination-offset-vs-cursor.md)). ⑵ **`WHERE updated_at > :마지막값` 폴링 방식의 증분 동기화가 행을 조용히 건너뛴다** — 트랜잭션 시작 시각으로 찍힌 행이 나중에 커밋되면서 이미 지나간 구간에 끼어들기 때문. ⑶ 배치의 기준선도 `now()`로 잡으면 트랜잭션 길이만큼 밀린다. 처방은 **의도에 맞는 함수를 고르는 것**(감사·수정 시각은 `clock_timestamp()`), **폴링 경계에 여유(lookback)를 두고 중복은 멱등 처리로 흡수하는 것**, 그리고 근본 처방으로 **논리 디코딩 기반 CDC로 타임스탬프 대신 커밋 순서를 따르게 하는 것**이다. (가산점) MySQL의 `NOW()`는 **문장** 시작 시각이라 이 사고가 잘 안 난다 — "MySQL에서 PostgreSQL로 옮기고 나서 증분 배치가 이상해졌다"의 정체가 이것이다.

### "'매일 밤 11시 신작 공개'를 그냥 `timestamptz`에 넣으면 안 되나요? 저장은 UTC가 원칙이라면서요."

**"저장은 UTC 순간"은 과거·현재의 사건에 대한 원칙이고, 미래 일정은 저장할 것이 다르다.** 사용자가 정한 것은 "서울 벽시계로 23:00"이라는 **규칙**이지 특정 UTC 순간이 아니다. 지금 `14:00Z`로 환산해 저장하면(서울 23:00 − 9시간 = 같은 날 14:00 UTC) — ⑴ DST가 있는 존이면 전환일 이후 환산 결과가 1시간 바뀌어 "22:00 공개"가 된다 ⑵ 그 나라가 DST를 폐지하거나 도입하면(tzdata 변경) 이미 저장된 모든 미래 행이 틀린다 ⑶ 되돌릴 근거(원래 벽시계와 존)가 값에 없다 — **`timestamptz`가 존을 저장해 줄 거라는 오해가 여기서 정확히 대가를 청구한다.** 그래서 **`timestamp`(로컬 벽시계) + IANA 존 ID(`text`)를 원본으로 저장**하고, UTC는 스캔·정렬용 **파생 캐시**로 두되 존 규칙이 바뀌면 `publish_local_at AT TIME ZONE publish_zone_id`로 재계산한다. 오프셋(`+09:00`)이 아니라 존 ID(`Asia/Seoul`)여야 하는 이유도 같다 — 오프셋은 "지금의 결과"이고 존 ID는 "규칙"이다. 스캐너(배치)는 파생 UTC 컬럼으로 "지금 공개할 것"을 찾되, 실제 공개 직전에 원본으로 한 번 더 검증하면 규칙 변경 사이의 창도 막는다. DST 전환일에 존재하지 않는 시각(02:30이 없는 날)의 처리는 22장 문서의 몫이다.

### "이미 `timestamp`에 KST 벽시계로 3년치가 쌓여 있는 서비스가 글로벌 진출합니다. 어떻게 전환하시겠어요?" (시니어 변별 포인트)

**"컬럼의 의미를 바꾸는 마이그레이션"** 이라 단순한 타입 변경보다 어렵다 — 값의 모양은 같고 기준만 바뀌기 때문에, 전환 중에 "이 행은 어느 기준인가"를 잃으면 복구가 안 된다. 순서로 답한다.

**⑴ 진단 먼저** — 정말 전부 KST인가? §2-2 사고 ①처럼 이미 UTC와 KST가 섞여 있을 수 있다. 배포 이력, `created_at`이 미래인 행, `now()` 기준 배치의 오작동 로그로 경계를 찾는다. 섞여 있으면 구간별 오프셋을 먼저 확정한다.

**⑵ "한 줄로 되지 않나"에 대한 답부터** — 문법적으로는 된다: `ALTER TABLE payment ALTER COLUMN paid_at TYPE timestamptz USING paid_at AT TIME ZONE 'Asia/Seoul';` 하지만 이건 **`ACCESS EXCLUSIVE` 잠금 + 테이블 전체 재작성**이고, PostgreSQL에서 그 잠금은 **진행 중인 롱 쿼리 뒤에 줄 서면서 그 뒤에 오는 모든 SELECT까지 줄 세운다** — 수억 건이면 서비스 중단이다([무중단 DDL](./14-online-ddl-zero-downtime-schema-change.md)). (세션 `TimeZone`이 UTC일 때 이 변환의 재작성을 피하는 최적화가 최근 버전에 있으므로, **스테이징에서 실제 잠금·소요를 재 보고** 들어가는 것이 맞다.) 작은 테이블이면 `SET lock_timeout = '2s'` + 재시도로 끝내고, 큰 테이블이면 ⑶으로 간다.

**⑶ 새 컬럼 + 이중 쓰기** — `ALTER TABLE payment ADD COLUMN paid_at_tz timestamptz;`는 NULL 허용이라 **카탈로그만 건드리고 즉시 끝난다**(PG 11+는 상수 DEFAULT가 붙어도 재작성 없음). 앱이 두 컬럼을 다 채우거나, `BEFORE INSERT OR UPDATE` 트리거로 `NEW.paid_at_tz := NEW.paid_at AT TIME ZONE 'Asia/Seoul'`을 자동화한다. 이 시점부터 새 행은 두 컬럼이 다 채워진다.

**⑷ 백필 — PostgreSQL 고유의 비용을 계산에 넣는다.** `UPDATE … SET paid_at_tz = paid_at AT TIME ZONE 'Asia/Seoul' WHERE id BETWEEN $1 AND $2`를 PK 범위로 쪼개 돌린다. PostgreSQL의 UPDATE는 제자리 수정이 아니라 **새 튜플 버전을 만들므로**, 전수 백필은 테이블을 사실상 두 배로 부풀리고 WAL·레플리카 지연·autovacuum 추격 실패를 부른다([대량 삭제/아카이빙](./25-mass-delete-archiving-and-partitioning.md)의 사슬이 그대로 온다). 그래서 **배치 크기를 작게, 사이사이 `VACUUM (ANALYZE)`, 새 컬럼의 인덱스는 백필이 끝난 뒤 `CREATE INDEX CONCURRENTLY`로.** (한국이 DST가 없어서 `AT TIME ZONE 'Asia/Seoul'`이 전 구간 균일하게 +9시간인 것이 이 마이그레이션의 행운이고, DST가 있는 존이었다면 행마다 규칙이 다르게 적용된다 — 그래서 오프셋이 아니라 **존 ID로 변환**해야 한다.)

**⑸ 읽기 전환 → 검증 → 정리** — 읽기를 새 컬럼으로 옮기고, 두 컬럼의 관계가 전 구간에서 성립하는지 전수 점검(`WHERE paid_at_tz <> paid_at AT TIME ZONE 'Asia/Seoul'`가 0건)한 뒤 구 컬럼을 `DROP`한다. `DROP COLUMN`은 카탈로그만 바꾸므로 즉시지만 **공간은 바로 안 돌아온다** — 회수는 `VACUUM`(재사용) 또는 `pg_repack`(축소)의 몫이다. 컬럼 이름을 되돌릴 거면 `RENAME`도 잠금이 짧다.

**⑹ 이 기회에 미래 일정 컬럼을 분리** — 예약 공개 시각처럼 "벽시계가 의도"인 컬럼은 UTC로 환산하는 것이 아니라 존 ID 컬럼을 추가해 §2-4(b) 구조로 바꾼다. 전환의 트레이드오프를 양면으로 — 이중 쓰기 기간에는 코드가 두 컬럼을 알아야 하고 저장 공간이 늘지만, **제자리에서 한 번에 바꾸는 방식은 실행 도중 앱이 어느 기준으로 읽어야 하는지 정의할 수 없어** 무중단이 불가능하다. 마지막으로 — **이 전환이 필요해진 이유가 곧 "처음부터 `timestamptz` + `Instant`를 썼어야 하는 이유"** 라고 닫는다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **결론 자체가 뒤집힌다** — MySQL에서는 `TIMESTAMP`의 **2038 한계**(4바이트 epoch 초. `2^31 − 1`초를 1970년에 더하면 `2038-01-19 03:14:07` UTC다)와 옛 설정의 묵시 `DEFAULT`/`NULL` 마법(`explicit_defaults_for_timestamp`) 때문에 **`DATETIME(6)` + 앱이 UTC 규율을 지키는** 쪽이 합리적이었지만, PostgreSQL은 `timestamp`와 `timestamptz`가 **같은 8바이트·같은 범위**라 그 두 근거가 사라져 **`timestamptz`가 기본**이 된다. ② **드라이버-세션 관계** — Connector/J의 `connectionTimeZone`은 서버 세션과 독립 설정이라 어긋나면 **저장된 순간 자체가 밀리고 왕복 상쇄로 앱에선 안 보이는** 고전 사고가 나지만, **pgjdbc는 접속 시 JVM 기본 존을 세션 `TimeZone`으로 밀어 넣어** 그 어긋남을 없앤다 — 대신 PostgreSQL의 사고는 "앱과 psql·배치가 다른 존을 본다"로 옮겨간다. ③ **`NOW()`의 의미** — MySQL은 **문장** 시작 시각, PostgreSQL은 **트랜잭션** 시작 시각이라 롱 트랜잭션·대량 INSERT·증분 동기화에서 PostgreSQL에서만 나는 사고가 있다(`clock_timestamp()`가 해법). ④ **자동 갱신** — MySQL의 `ON UPDATE CURRENT_TIMESTAMP`가 PostgreSQL에는 없어 `BEFORE UPDATE` 트리거로 만든다. 대신 `WHEN (OLD.* IS DISTINCT FROM NEW.*)`처럼 조건을 붙일 수 있어 더 세밀하다. ⑤ **일 단위 집계** — MySQL은 `DATE(col)` 함수 인덱스로 우회하는 길이 있지만, PostgreSQL은 `timestamptz::date`가 세션 존 의존(STABLE)이라 **그 식으로는 표현식 인덱스를 만들 수 없다.** 존을 리터럴로 박아 `date_trunc('day', paid_at AT TIME ZONE 'Asia/Seoul')`로 쓰면 IMMUTABLE이 되어 인덱스가 만들어지지만 **존마다 인덱스가 하나씩 필요하고 tzdata 변경 시 재구축 대상**이라, 실무의 정석은 **앱이 계산한 UTC 경계 범위 조건**이다. 이 다섯을 짚으면 "타입 스펙 암기"가 아니라 "저장 구조와 드라이버 동작에서 도출"로 들린다.

---

## 한 줄 요약

**PostgreSQL의 `timestamptz`는 이름과 달리 타임존을 저장하지 않고 입력을 세션 `TimeZone`으로 해석해 UTC 순간 하나(8바이트 정수 하나)로 정규화해 적는 타입이고, `timestamp`는 변환 없이 벽시계를 그대로 적어 "어느 존의 값인지"를 버리는 타입인데 — 둘 다 8바이트·마이크로초·4713 BC~294276 AD라 MySQL을 갈랐던 2038·크기 논쟁이 통째로 사라지므로, 글로벌 서비스라면 과거·현재의 모든 사건은 `timestamptz` + 자바 `Instant`(드라이버가 오프셋을 명시해 보내므로 시계가 어긋나도 저장이 안 밀린다)로 가고, `timestamp`는 "벽시계 자체가 의도"인 미래 일정에 IANA 존 ID 컬럼과 짝으로만 남겨 UTC는 재계산 가능한 파생 캐시로 둔다. 남는 것은 PostgreSQL 고유의 함정 셋 — 출력이 세션 존을 따라 달라져 날짜까지 하루 밀려 보이므로 판정은 `AT TIME ZONE 'UTC'`로 못 박고, `now()`는 트랜잭션 시작 시각이라 한 배치의 1만 건이 같은 값을 갖고 커서 페이지네이션과 증분 동기화가 조용히 행을 흘리므로 `clock_timestamp()`나 CDC를 쓰며, pgjdbc가 세션 `TimeZone`을 JVM 존으로 설정하므로 `-Duser.timezone=UTC` 한 줄이 곧 세션 설정이다 — 그리고 이 셋은 `-Duser.timezone=UTC`·`hibernate.jdbc.time_zone=UTC`·`ALTER DATABASE … SET timezone='UTC'`·ArchUnit 타입 규약·컬럼 타입까지 단정하는 회귀 테스트로 못 박는다.**
