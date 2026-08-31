# DATETIME vs TIMESTAMP — "벽시계를 적는 타입"과 "순간을 적는 타입", 그리고 시간 원칙이 스키마에 착지하는 지점

> 핵심 관전 포인트: **MySQL의 두 타입은 "무엇을 저장하느냐"가 다르다.
> `TIMESTAMP`는 저장할 때 세션 타임존 → UTC로 변환해 1970년 기준 초
> (epoch)로 적고, 읽을 때 UTC → 세션 타임존으로 되돌리는 "순간(instant)"
> 타입이다 — 4바이트와 자동 UTC 정규화를 얻는 대신 2038-01-19까지의 범위와
> 세션 타임존 의존을 낸다. `DATETIME`은 아무 변환 없이 받은 벽시계 값을
> 그대로 적는 타입이다 — 넓은 범위(1000~9999년)와 "보이는 값 = 저장된 값"의
> 예측 가능성을 얻는 대신 타임존 정보가 사라지므로 "이 컬럼은 UTC다"라는
> 규율을 애플리케이션이 지켜야 한다. 값이 몇 시간 밀리는 사고는 언제나
> 네 개의 시계 — JVM 기본 타임존, Hibernate가 JDBC에 값을 넘기는 기준 존,
> JDBC 드라이버의 커넥션 타임존, DB 세션 `time_zone` — 중 하나가 어긋날 때
> 생긴다. 글로벌 서비스라면 나는 과거·현재의 사건(`created_at`, `paid_at`)은
> `DATETIME(6)` + 네 시계 UTC 고정 + 회귀 테스트로 가고, 미래 일정(예약
> 공개 시각)은 로컬 벽시계 + IANA 존 ID를 분해 저장한 뒤 UTC는 재계산
> 가능한 파생 컬럼으로만 둔다. `TIMESTAMP`는 2038 이전 값만 들어오는
> 이벤트·로그 컬럼이거나, 여러 언어의 클라이언트가 DB에 직접 써서 앱 규율을
> 믿을 수 없을 때 고른다. 어느 쪽이든 선택과 안전망은 한 세트다 —
> `-Duser.timezone=UTC`, `connectionTimeZone=UTC`,
> `hibernate.jdbc.time_zone=UTC`, DB `default-time-zone='+00:00'`,
> `Instant` 타입 규약을 ArchUnit으로, 타임존을 바꿔 도는 테스트.**

---

## 0. 질문 + 의도

**질문**: "DATETIME과 TIMESTAMP의 차이(타임존 동작, 범위)는? 글로벌
서비스라면 무엇을 선택하겠습니까?"

**출제 의도**: rationale은 이렇게 적고 있다 — "타임존 처리·범위(2038년
문제)·기본값 동작의 차이는 **22장의 시간 원칙이 스키마 레벨에 착지하는
지점**이다. 컬럼 타입 선택 하나가 글로벌 확장의 발목을 잡는 사례를 아는지
본다." 즉 채점 지점은 두 타입의 스펙 암기가 아니라 셋이다. ⑴ 값이 저장되고
읽히는 **변환 경로를 사슬로** 말할 수 있는가 — 그래야 "어디가 어긋나면
몇 시간 밀리는지"를 겪지 않고도 예측한다. ⑵ 두 타입의 **얻는 것과 내는
것을 양면으로** 조립해 "우리 서비스의 조건"으로 결론을 내는가 — 정답이
하나가 아닌 문항이라 결론보다 근거의 구조를 본다. ⑶ 선택을 **설정·타입
규약·테스트로 고정**하는가 — "UTC로 저장하기로 했다"는 결정은 코드로
못 박기 전까지 언젠가 깨질 관례일 뿐이다.

> **이 문서가 겨냥하는 지점**(사전 학습): 이 문항은 22장(글로벌/시간)의
> 원칙을 4장의 스키마 결정으로 내려 보내는 다리다. 시간 원칙 전반과
> `Instant`/`LocalDateTime`/`ZonedDateTime`의 상세는 22장 문서가 맡고,
> 여기서는 **MySQL 타입의 변환 메커니즘, JDBC·Hibernate 층의 시계, 그
> 위에 놓는 안전망**에 집중한다. 생성·수정 시각을 채우는 JPA Auditing
> 경로는 [JPA Auditing과 벌크 연산의
> 구멍](../03-jpa-orm/27-jpa-auditing-and-bulk-gap.md)에 있다 — 그 문서의
> 예제가 `LocalDateTime createdAt`을 쓰고 있는데, 이 문서는 그 필드 타입을
> 왜 `Instant`로 바꿔야 하는지에서 출발한다.

---

## 1. 개념 — 두 타입은 무엇을 저장하는가

### 1-1. 비유: 항해일지와 벽시계 사진

비유부터. `TIMESTAMP`는 **항해일지**다. 선원은 현지 시각으로 적지만
일지에는 세계 표준시(UTC)로 환산해 기록하고, 읽는 사람은 자기 항구의
시각으로 되돌려 본다. 어느 항구에서 읽어도 **"같은 순간"** 을 가리키지만,
**환산에 쓴 시계(세션 타임존)가 틀리면 기록 자체가 틀린다.**

`DATETIME`은 **벽시계를 찍은 사진**이다. 숫자는 정확히 남지만, 사진 어디에도
"어느 도시의 벽시계"인지는 없다. 사진을 찍은 사람이 "서울이었다"고 기억하는
동안만 의미가 유지되고, 그 사람이 떠나면(코드가 바뀌면, 서버가 옮겨가면)
숫자는 남고 기준은 사라진다.

이 비유가 곧 아래 세 개의 메커니즘 사슬이다. 면접에서 "TIMESTAMP는
타임존 변환이 있고 DATETIME은 없다"라고 결과만 말하는 것과, **어느 단계에서
어느 시계로 변환되는지를 순서대로** 말하는 것이 이 질문의 첫 변별점이다.

### 1-2. 사슬 ① `TIMESTAMP` — 세션 타임존 → UTC → (읽는 세션의) 타임존

클라이언트가 `INSERT ... VALUES ('2026-08-31 09:00:00')` 를 보냈다고 하자.

> **⑴ 리터럴에는 타임존이 없다.** `'2026-08-31 09:00:00'`은 그냥 숫자
> 묶음이다. → **⑵ 서버는 그 묶음을 세션 `time_zone`으로 해석한다.** 세션
> 변수의 기본값은 `SYSTEM`, 즉 **DB 서버 OS의 타임존**이다. → **⑶ 해석한
> 순간을 UTC로 변환해 epoch 초로 저장한다.** 세션이 `Asia/Seoul`이면
> `2026-08-31T00:00:00Z`, 세션이 UTC면 `2026-08-31T09:00:00Z`. **같은
> 문자열이 다른 순간이 된다.** → **⑷ 읽을 때는 저장된 UTC 순간을 "읽는
> 세션의" `time_zone`으로 되돌린다.** 쓴 세션과 읽는 세션의 존이 다르면
> 같은 행이 다른 숫자로 보인다.

이 사슬에서 네 가지가 따라 나온다.

- **얻는 것**: 세션 존만 정합하면 **어떤 언어의 어떤 클라이언트가 넣어도
  UTC 순간으로 정규화된다.** 규율이 DB에 있다.
- **내는 것**: 세션 존이 어긋나면 **저장 자체가 밀린다.** 그리고 저장할
  때와 같은 (틀린) 존으로 읽으면 되돌아오기 때문에 **앱에서는 정상으로
  보인다** — §2-2의 사고가 이것이다.
- 세션 존에 DST(서머타임)가 있으면 로컬 → UTC 변환이 1:1이 아닌 시간대가
  생긴다(시계를 되돌리는 날의 중복 1시간, 앞당기는 날의 존재하지 않는
  1시간). 세션 존을 UTC로 두면 이 문제 자체가 없다.
- 비교·정렬·인덱스는 저장된 UTC 순간 기준이라 **세션 존과 무관하게
  일관**된다. 인덱스 순서가 존 설정에 따라 바뀌지는 않는다.

`NOW()`/`CURRENT_TIMESTAMP`도 같은 세션 존의 벽시계를 돌려준다. UTC가
필요하면 `UTC_TIMESTAMP()`다.

### 1-3. 사슬 ② `DATETIME` — 변환 없음, 그래서 타임존 정보가 사라진다

같은 `INSERT`가 `DATETIME` 컬럼으로 가면 이렇다.

> **⑴ 리터럴이 도착한다.** → **⑵ 해석도 변환도 없다.** 연·월·일·시·분·초
> 묶음을 그대로 압축해 저장한다. → **⑶ 읽을 때도 그대로 돌려준다.** 세션
> 존이 무엇이든, 누가 읽든 `2026-08-31 09:00:00`. → **⑷ 그래서 "어느 존의
> 09:00였는지"는 값 어디에도 없다.** 그 정보는 값을 넣은 코드의 머릿속
> (`LocalDateTime.now()`를 부른 JVM의 기본 존)에만 있었고, 저장되는
> 순간 소실됐다.

따라서 `DATETIME`을 쓰는 순간 **"이 컬럼의 값은 UTC 벽시계다"라는 규약은
DB가 아니라 애플리케이션이 지켜야 한다.** DB는 KST 벽시계가 들어와도 막지
않는다. 이것이 DATETIME이 내는 가장 큰 비용이고, §3의 안전망이 전부 이
비용을 갚기 위한 것이다.

한 가지 함정이 더 있다. `DATETIME` 컬럼에 `DEFAULT CURRENT_TIMESTAMP`를
걸면 **세션 존의 벽시계**가 들어간다. 앱은 UTC를 넣고 DB 기본값은 KST를
넣는 "한 컬럼 두 기준"이 조용히 생길 수 있다. 그래서 **DATETIME을 골라도 DB
세션 존은 UTC로 맞춰야 한다** — "DATETIME은 타임존과 무관하니 DB 설정은
아무래도 된다"는 반쪽 이해다.

### 1-4. 사슬 ③ 범위 — 2038년 문제와 1970년 문제

`TIMESTAMP`는 내부적으로 **1970-01-01 00:00:00 UTC부터의 초를 4바이트에
저장**한다. 그래서 범위가 `1970-01-01 00:00:01` UTC ~ **`2038-01-19 03:14:07`
UTC**다(`00:00:00`은 "0 값"으로 예약돼 있어 저장 불가). 사슬은 이렇다.

> **⑴ 4바이트 초 카운터** → **⑵ 부호 있는 32비트의 최댓값 2³¹−1초
> = 2038-01-19 03:14:07 UTC** → **⑶ 그 이후 값은 저장 불가** — strict SQL
> 모드면 에러, 아니면 경고와 함께 0 값(`0000-00-00 00:00:00`)으로
> 대체된다 → **⑷ 1970년 이전도 마찬가지로 불가.**

"12년 뒤 얘기"가 아니다. **미래 시각을 담는 컬럼은 지금 이미 2038년을
넘는 값을 받는다** — 영구 이용권의 `expires_at = 9999-12-31`, 30년 만기
계약의 종료일, "무기한 정지"를 먼 미래 날짜로 표현하는 관례. 그리고 1970년
이전이 필요한 컬럼(생년월일, 역사 데이터)도 처음부터 못 쓴다. 나중에
타입을 바꾸려면 **테이블 재작성**이고, 수억 건 테이블이면 그 자체가 무중단
DDL 문제다([무중단 DDL](./14-online-ddl-zero-downtime-schema-change.md)).

`DATETIME`은 `1000-01-01 00:00:00` ~ `9999-12-31 23:59:59`로, 실무에서
범위를 걱정할 일이 없다.

크기는 현재 저장 포맷 기준 **`TIMESTAMP` 4바이트, `DATETIME` 5바이트**이고,
둘 다 소수 초 자릿수(`(3)`, `(6)`)에 따라 0~3바이트가 붙는다. 1바이트
차이는 수억 행의 이벤트 테이블에서만 의미 있는 숫자다.

### 1-5. `DEFAULT` / `ON UPDATE` 동작 — 그리고 레거시의 묵시 동작

현재 MySQL에서는 **두 타입 모두** `DEFAULT CURRENT_TIMESTAMP`와
`ON UPDATE CURRENT_TIMESTAMP`를 쓸 수 있다. 여기서 알아둘 것 세 가지.

- `ON UPDATE CURRENT_TIMESTAMP`는 **DB 레벨**이라 벌크 UPDATE, 네이티브
  쿼리, 콘솔 수동 SQL에서도 동작한다 — JPA Auditing이 빠지는 바로 그
  경로에서 살아 있다([JPA Auditing과 벌크 연산의
  구멍](../03-jpa-orm/27-jpa-auditing-and-bulk-gap.md)). 단 **다른 컬럼 값이
  실제로 바뀔 때만** 갱신되고, 같은 값으로 덮어쓰는 UPDATE에서는 움직이지
  않는다. 그리고 채워지는 값은 **세션 존의 벽시계**다.
- **레거시 묵시 동작**: `explicit_defaults_for_timestamp`가 `OFF`인 옛
  설정에서는 테이블의 **첫 번째 `TIMESTAMP` 컬럼에 자동으로
  `DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`가 붙고**,
  `NOT NULL`이 묵시 적용되며, `NULL`을 대입하면 현재 시각이 들어갔다. 즉
  "`updated_at`에 NULL을 넣었는데 지금 시각이 됐다"는 이 마법의 결과다.
  MySQL 8.0은 기본값이 `ON`이라 마법이 꺼져 있지만, 옛 설정을 물려받은
  서버나 옛 DDL 덤프에서는 살아 있을 수 있다 — `TIMESTAMP`를 고르면 이
  이력까지 안고 가는 것이다.
- **소수 초**: 자릿수를 안 적으면 `(0)`이고, 초 아래는 기본적으로
  **반올림**된다(`TIME_TRUNCATE_FRACTIONAL` SQL 모드면 절삭). 자바
  `Instant`는 나노초를 갖고 있어 `DATETIME(0)`에 넣으면 저장 후 읽은 값이
  원본과 달라져 `assertEquals(saved, found)`가 깨지고, `.9995초`가 다음
  초로 올라가 초 경계를 넘기도 한다. **`(6)`으로 선언하거나 앱에서
  `truncatedTo(ChronoUnit.MICROS)`로 맞추는 것**이 정석이다(가산점 포인트).

### 1-6. 비교표 — 목록으로 인출한다

| 항목 | `DATETIME` | `TIMESTAMP` |
|---|---|---|
| 저장하는 것 | 벽시계 값 그대로(변환 없음) | 세션 존 → UTC로 변환한 순간(epoch 초) |
| 읽을 때 | 저장한 값 그대로 | UTC → 읽는 세션 존으로 역변환 |
| 범위 | 1000-01-01 ~ 9999-12-31 | 1970-01-01 00:00:01 ~ 2038-01-19 03:14:07 (UTC) |
| 크기 | 5바이트 (+소수 초 0~3) | 4바이트 (+소수 초 0~3) |
| 타임존 정보 | 없음 — 규약을 앱이 지킴 | 없음 — 대신 UTC 순간으로 정규화됨 |
| 세션 존 의존 | 없음(단 `CURRENT_TIMESTAMP` 기본값은 세션 존) | 저장·조회 모두 의존 |
| `DEFAULT`/`ON UPDATE CURRENT_TIMESTAMP` | 가능 | 가능 + 옛 설정의 묵시 자동 부여 |
| 어울리는 자리 | UTC 규율이 코드로 고정된 서비스의 사건 시각, 미래 일정의 로컬 벽시계 | 2038 이전 값만 오는 이벤트·로그, 다국어 클라이언트가 직접 쓰는 테이블 |

표는 인출용이고, 결정은 §2-3·§2-4의 양면 서술로 한다.

---

## 2. 네 개의 시계 — 값이 밀리는 사고의 사슬과 선택의 양면

### 2-1. 값이 DB에 닿기까지 지나는 네 개의 시계

`Instant`(또는 `LocalDateTime`) 하나가 `DATETIME`/`TIMESTAMP` 컬럼에 적힐
때까지, 서로 독립적으로 설정되는 시계 네 개를 지난다. **하나만 어긋나도
값이 밀리고, 어긋난 자리에 따라 밀리는 방향과 증상이 다르다.**

> **① JVM 기본 타임존** — `-Duser.timezone`, 없으면 OS의 `TZ`. `LocalDateTime.now()`,
> `ZoneId.systemDefault()`, `new Date().toString()`, `Timestamp.valueOf(...)`
> 의 기준이다. 개발 PC(KST)와 컨테이너 이미지(대개 UTC)가 다르기 가장 쉬운
> 시계다.
>
> **② Hibernate가 JDBC에 값을 넘길 때의 기준 존** — 기본은 ①과 같다.
> `hibernate.jdbc.time_zone=UTC`를 주면 Hibernate가
> `setTimestamp(idx, ts, Calendar(UTC))`처럼 **"이 값은 UTC 기준 벽시계"라고
> 명시해서** 드라이버에 넘긴다.
>
> **③ JDBC 드라이버의 커넥션 타임존** — MySQL Connector/J의
> `connectionTimeZone`(구 이름 `serverTimezone`). 기본 `SERVER`는 접속 시
> 서버의 세션 존을 읽어 온다. 드라이버는 **"순간" 성격의 값
> (`java.sql.Timestamp` 등)을 ②의 기준 존 → ③의 존으로 변환한 벽시계
> 문자열로 보낸다**(`preserveInstants=true`가 기본). 반면 **`LocalDateTime`은
> 순간이 아니라고 보고 변환 없이 벽시계 그대로** 보낸다(최근 Connector/J
> 기준. 옛 버전은 옵션에 따라 달랐으므로 드라이버 버전을 올릴 때 이 동작이
> 바뀌는지 확인 대상이다). 서버가 `SYSTEM`을
> 보고하고 그 OS 존 이름이 `KST`처럼 JVM이 모르는 약어면 그 유명한
> "The server time zone value 'KST' is unrecognized" 오류가 나는데, **이
> 오류를 없애려고 아무 값이나 넣는 것이 §2-2 두 번째 사고의 시작**이다.
>
> **④ DB 세션 `time_zone`** — 기본 `SYSTEM`(DB 서버 OS 존). `TIMESTAMP`
> 변환의 기준이자 `NOW()`/`CURRENT_TIMESTAMP`의 기준. 클라우드 관리형
> DB는 UTC인 경우가 많고, 직접 설치한 국내 서버는 KST인 경우가 많다.

핵심은 이것이다 — **①~④가 전부 같은 존이면 변환이 항등이 되어 어떤 타입을
써도 값이 안 밀린다.** 그래서 처방은 "각 시계를 정확히 이해해 서로 다른
존을 맞물리게 조립하기"가 아니라 **"네 개를 전부 UTC로 못 박아 변환이
일어날 일 자체를 없애기"** 다. 이해는 사고를 진단할 때 필요하고, 설계는
이해에 의존하지 않게 만든다.

### 2-2. 사고 사슬 두 개 — "앱에서는 맞는데 DB에서 보면 9시간 다르다"

**사고 ①: `LocalDateTime` + `DATETIME` + 운영 DB만 UTC.** 국내 서비스.
개발 PC와 로컬 MySQL은 KST, 운영 앱 서버(VM)도 KST, 그런데 운영 DB
(관리형)는 기본값대로 UTC. 결제 시각은 `paidAt = LocalDateTime.now()`로
채우고 `DATETIME`에 저장한다. 30분 넘게 미완료인 결제를 정리하는 배치는
SQL로 `WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL 30 MINUTE`.

> **⑴ `LocalDateTime.now()`는 시계 ①(KST)의 벽시계** `09:00`. → **⑵
> 드라이버는 `LocalDateTime`을 변환 없이 보내고, `DATETIME`은 그대로
> 적는다** — `'09:00'`, 존 정보 소실. → **⑶ 배치의 `NOW()`는 시계 ④(UTC)의
> 벽시계** `00:00`. → **⑷ 같은 컬럼 위에서 "KST 벽시계 값"과 "UTC 벽시계
> 기준선"이 비교된다** — DB 입장에서는 둘 다 그냥 숫자다. → **⑸ 방금 생긴
> 주문의 `created_at`(09:00)이 기준선(23:30 전날)보다 9시간 미래라
> 배치는 아무것도 정리하지 않는다.** 로컬에서는 시계 ①과 ④가 우연히 둘 다
> KST라 완벽히 동작했으므로 테스트도 통과했다.

그리고 두 번째 파도가 온다. 앱을 컨테이너로 옮기면서 시계 ①이 UTC가
되면, **그날 배포 시점부터의 행은 UTC 벽시계, 그 이전 행은 KST 벽시계**가
한 컬럼에 섞인다. 어느 행이 어느 기준인지는 배포 시각으로 추정하는 수밖에
없고, 그 경계 근처의 데이터는 영영 애매하다. **DATETIME이 존 정보를 버린
대가는 사고가 났을 때 "값을 복구할 근거"가 없다는 것**으로 청구된다.

**사고 ②: `TIMESTAMP` + 드라이버 커넥션 존 오설정 — 대칭 오류라 앱에선 안
보인다.** 시계 ①은 KST, 시계 ④도 KST(직접 설치한 DB, OS 존 약어 `KST`).
드라이버가 "server time zone 'KST' is unrecognized"를 내자 검색해서 나온
대로 URL에 `serverTimezone=UTC`를 붙였다. 오류는 사라졌다.

> **⑴ 드라이버(시계 ③)는 이제 "서버 세션은 UTC"라고 믿는다.** → **⑵
> `Instant` 09:00 KST(= 00:00Z)를 넘기면 드라이버는 ① KST → ③ UTC로 변환해
> `'00:00'`을 보낸다.** → **⑶ 서버 세션(시계 ④)은 실제로 KST이므로 `'00:00'`을
> KST로 해석 → UTC로 변환 → 전날 `15:00Z`를 저장한다.** 진짜 순간보다 9시간
> 이르다. → **⑷ 읽을 때는 정확히 반대로 되돌아온다** — 서버가 KST로 `'00:00'`을
> 내주고, 드라이버가 "UTC겠지" 하고 KST 09:00으로 바꾼다. **앱 화면은
> 정상이다.** → **⑸ 틀린 값은 이 드라이버를 거치지 않는 모든 곳에서만
> 보인다** — DB 콘솔, SQL의 `NOW()`와 비교하는 배치, 파이썬으로 짠 정산
> 스크립트, BI 도구, 리플리카에서 뽑는 리포트. 발견은 몇 달 뒤 정산 금액이
> 하루치씩 어긋난다는 제보로 온다.

두 사고의 공통 구조 — **어긋난 시계 한 쌍이 왕복에서 서로 상쇄되면 앱은
정상으로 보이고, 제3의 독자(콘솔·배치·타 언어)가 나타날 때 드러난다.**
그래서 §3-3의 회귀 테스트는 반드시 **드라이버를 거치지 않은 "DB에 실제로
적힌 문자열"** 을 단정한다.

### 2-3. 트레이드오프 양면 — 각 타입이 얻는 것과 내는 것

한 호흡에 양면으로 말한다. 면접관은 어느 쪽을 고르는지보다 **반대편 비용을
빠뜨리지 않는지**를 본다.

**`TIMESTAMP`가 얻는 것**: ⑴ **UTC 정규화를 DB가 강제**한다 — 세션 존만
정합하면 자바든 파이썬이든 콘솔이든 넣는 순간 UTC 순간이 된다. 규율이
스키마에 있다. ⑵ 4바이트. ⑶ 타입 자체가 "순간"이라 **컬럼의 의미가
DDL에 드러난다.** ⑷ 비교·정렬이 세션 존과 무관하게 순간 기준으로 일관된다.

**`TIMESTAMP`가 내는 것**: ⑴ **1970~2038** — 미래 시각·과거 생년월일
컬럼에 못 쓰고, 나중에 바꾸면 대용량 테이블 재작성이다. ⑵ **세션 존
의존** — 같은 행이 보는 사람의 세션 존마다 다른 숫자로 보여 디버깅이
헷갈리고, 세션 존이 틀리면 저장 자체가 밀리며(사고 ②), DST 존이면 변환이
1:1이 아니다. ⑶ 옛 설정의 **묵시 `DEFAULT`/`NULL` 동작**이라는 이력.
⑷ "DB가 알아서 UTC로 해주니 앱은 신경 안 써도 된다"는 **거짓 안도감** —
세션 존 정합은 여전히 앱 쪽(드라이버 설정)의 책임이다.

**`DATETIME`이 얻는 것**: ⑴ **1000~9999**, 범위 걱정 없음. ⑵ **세션 존
무관** — 콘솔에서 보이는 값이 곧 저장된 값이라 예측 가능하고, 누가 어디서
읽어도 같은 숫자다. ⑶ 묵시 동작 없음.

**`DATETIME`이 내는 것**: ⑴ **타임존 정보가 없다** — "이 컬럼은 UTC"라는
규약이 코드·설정·리뷰 규칙에 있어야 하고, 규약이 깨져 KST 벽시계가
들어와도 **DB는 못 잡는다**(사고 ①). ⑵ 그 결과 사고가 나면 **복구 근거가
값에 없다.** ⑶ 1바이트 더. ⑷ `DEFAULT CURRENT_TIMESTAMP`가 세션 존
벽시계를 넣으므로 **결국 DB 세션 존도 UTC로 맞춰야 한다** — "타임존
무관"이 "설정 무관"은 아니다.

**둘 다 내야 하는 것**: 네 개의 시계 정합. 어느 타입을 골라도 이 비용은
면제되지 않는다. 차이는 **정합이 깨졌을 때 무엇이 틀리는가** — `TIMESTAMP`는
저장된 순간이 틀리고(대칭 오류로 숨음), `DATETIME`은 저장된 값의 기준이
틀린다(콘솔에서 바로 보임).

### 2-4. 선택 조건 — "글로벌 서비스라면"에 대한 내 결론

시각 컬럼을 한 종류로 보지 않는 것이 출발점이다. **과거·현재의 사건**과
**미래의 일정**은 저장해야 할 것이 다르다.

**(a) 과거·현재의 사건** — `created_at`, `paid_at`, `last_login_at`,
`deleted_at`. 저장할 것은 "그 일이 벌어진 **순간**"이고, 순간은 UTC 하나로
충분하다. 여기서 나는 **`DATETIME(6)` + 네 시계 UTC 고정 + 회귀
테스트**를 고른다. 근거는 셋이다. ⑴ 2038 한계가 없어 같은 규약을 만료일
같은 미래 순간 컬럼에도 그대로 쓸 수 있다 — 테이블마다 타입이 갈리면
규약이 둘이 된다. ⑵ 세션 존에 따라 값이 다르게 보이는 함정이 없어 "저장된
값 = UTC 벽시계"라는 **단일 규칙**만 지키면 되고, 그 규칙은 어차피
`TIMESTAMP`를 써도 지켜야 하는 세션 존 정합과 같은 일이다. ⑶ 대칭 오류로
숨지 않고 콘솔에서 바로 보이므로 회귀 테스트로 잡기 쉽다. **단, 이 선택은
§3의 안전망 없이는 `TIMESTAMP`보다 위험하다** — 규율이 앱에 있으니까.
선택과 안전망은 한 세트로 말해야 한다.

`TIMESTAMP`를 고르는 조건은 명확하다 — **⑴ 값이 2038 이전으로 한정되는
컬럼**(이벤트 로그, 감사 로그, 접속 기록)이면서 **⑵ 여러 언어·도구의
클라이언트가 DB에 직접 써서 앱 규율을 신뢰할 수 없거나** **⑶ 수억 행
규모라 1바이트가 의미 있을 때.** 이 조건이면 DB가 정규화를 강제해 주는
편익이 범위·세션 의존 비용보다 크다.

**(b) 미래의 일정** — "매일 밤 11시 신작 공개", 구독 갱신일, 예약 발송
시각. 사용자가 의도한 것은 "**그 도시의 벽시계로 23:00**"이지 특정 UTC
순간이 아니다. 지금 UTC로 환산해 저장하면 **DST 전환이나 그 나라의 DST
폐지(tzdata 변경)로 환산 결과가 바뀌는 순간 의도와 어긋난다.** 그래서
**로컬 벽시계(`DATETIME`) + IANA 존 ID(`VARCHAR`, `Asia/Seoul`처럼 규칙을
담는 이름 — `+09:00` 같은 오프셋은 규칙을 못 담는다)** 를 분해 저장하고,
UTC 순간은 **정렬·스캔용 파생 컬럼(언제든 재계산 가능한 캐시)** 으로만
둔다. 이 설계의 상세와 DST 전환일의 문제는 [22장 글로벌 서비스/시간
문서](../22-global-i18n/)가 다룬다.

**(c) 날짜만 의미 있는 것** — 생년월일, 정산 기준일. `DATE`다. 시각을 붙여
`TIMESTAMP`로 두면 1970년 이전이 안 들어가고, 존 변환 한 번에 하루가
밀린다.

**(d) PostgreSQL이라면** (가산점 포인트) — `timestamptz`(timestamp with
time zone)가 답이다. 이름과 달리 존을 저장하는 게 아니라 **UTC 순간을
8바이트로 저장하고 세션 `TimeZone`으로 입출력 변환**하는, MySQL
`TIMESTAMP`의 역할에 2038 한계가 없는 타입이다. `timestamp`(without time
zone)는 MySQL `DATETIME`에 해당한다.

---

## 3. 안전망 — 선택을 설정·타입 규약·테스트로 고정한다

"UTC로 저장하기로 했다"는 결정은 세 층에 못 박아야 유지된다. **설정**(네
시계), **타입 규약**(어떤 자바 타입을 어디에 쓰는가), **테스트**(어긋나면
빌드가 깨진다).

### 3-1. before / after — JPA 엔티티와 네 시계 설정

```java
// before — 값이 "지금 이 서버가 있는 곳"의 벽시계에 묶인다
@Entity
public class Payment {
    @Id @GeneratedValue
    private Long id;

    @CreatedDate
    private LocalDateTime createdAt;   // ① 타임존 없는 벽시계 — "어디 기준 09:00"인지 값이 모른다

    private LocalDateTime paidAt;      // ② paidAt = LocalDateTime.now();
                                       //    → JVM 기본 존의 벽시계. 개발 PC(KST)와 컨테이너(UTC)에서
                                       //      서로 다른 값이 저장되고, DATETIME은 그 차이를 기록하지 않는다
}
```

```properties
# before — 시계 네 개를 전부 "기본값"에 맡긴다
#   ① JVM: OS 존   ② Hibernate: ①과 같음   ③ 드라이버: SERVER(=④를 따라감)   ④ DB: SYSTEM(DB OS 존)
#   → 앱 서버 OS와 DB 서버 OS의 TZ가 우연히 같을 때만 맞는다
spring.datasource.url=jdbc:mysql://db:3306/app
```

```java
// after — 사건은 Instant(순간), 미래 일정은 로컬 벽시계 + 존 ID로 분해
@Entity
public class Payment {
    @Id @GeneratedValue
    private Long id;

    @CreatedDate
    private Instant createdAt;         // ① 순간 — 어느 서버에서 만들어도 같은 값

    private Instant paidAt;            // ② paidAt = clock.instant();  ← Clock 주입, 테스트에서 고정 가능
}

@Entity
public class EpisodeSchedule {
    @Id @GeneratedValue
    private Long id;

    @LocalWallClock                    // 프로젝트 마커 — "의도적으로 로컬 벽시계" (§3-2의 ArchUnit 예외 근거)
    private LocalDateTime publishLocalAt;   // 2026-09-01T23:00 — 사용자가 고른 그 벽시계
    private String        publishZoneId;    // "Asia/Seoul" — 오프셋(+09:00)이 아니라 규칙을 담는 IANA 존 ID
    private Instant       publishAtUtc;     // 정렬·스캔용 파생 캐시 — 존 규칙이 바뀌면 재계산한다
}
```

```sql
-- after — DDL. "UTC"를 컬럼 코멘트로 남겨 규약을 스키마에도 적어 둔다
CREATE TABLE payment (
    id         BIGINT PRIMARY KEY AUTO_INCREMENT,
    -- DEFAULT 는 앱 밖 경로(콘솔·타 언어 배치)용 — 세션 존이 UTC 여야 앱이 넣는 값과 기준이 같다(§1-3)
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'UTC',
    paid_at    DATETIME(6) NULL                                 COMMENT 'UTC'
);

CREATE TABLE episode_schedule (
    id               BIGINT PRIMARY KEY AUTO_INCREMENT,
    publish_local_at DATETIME    NOT NULL COMMENT 'publish_zone_id 기준 로컬 벽시계',
    publish_zone_id  VARCHAR(64) NOT NULL COMMENT 'IANA 존 ID',
    publish_at_utc   DATETIME(6) NOT NULL COMMENT '파생 캐시(UTC). 재계산 가능',
    INDEX idx_publish_at_utc (publish_at_utc)
);
```

```yaml
# after — 네 개의 시계를 전부 UTC로 못 박는다 (③ ② 설정)
spring:
  datasource:
    # ③ 드라이버 커넥션 존 = UTC. forceConnectionTimeZoneToSession=true 는 접속 시
    #   세션 time_zone 도 같은 값으로 SET 해 ④까지 맞춘다 (서버 설정을 만질 수 없을 때).
    #   단, 이름 있는 존('UTC')을 세션에 SET 하려면 MySQL에 tz 테이블이 로드돼 있어야 한다.
    url: jdbc:mysql://db:3306/app?connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true
  jpa:
    properties:
      # ② Hibernate → JDBC 로 넘기는 기준 존 = UTC. JVM 기본 존이 무엇이든 UTC 벽시계로 바인딩
      hibernate.jdbc.time_zone: UTC
  jackson:
    # (표시 층) JSON 직렬화 기준 — 응답은 ISO-8601 + 오프셋('Z')로 나간다
    time-zone: UTC
```

```dockerfile
# ① JVM 기본 존 = UTC. 애플리케이션 코드에서 TimeZone.setDefault()로 바꾸는 것은
#    이미 초기화된 것들(로깅, 커넥션 풀)에 늦게 적용될 수 있어 실행 옵션으로 준다
ENV TZ=UTC
ENV JAVA_TOOL_OPTIONS="-Duser.timezone=UTC"
```

```ini
# ④ DB 서버 기본 세션 존 = UTC (my.cnf). 드라이버 옵션이 세션을 덮더라도,
#    콘솔·배치·타 언어 클라이언트·DEFAULT CURRENT_TIMESTAMP 를 위해 서버 기본값도 맞춘다.
#    '+00:00' 오프셋 표기는 tz 테이블 없이도 동작한다.
[mysqld]
default-time-zone = '+00:00'
```

`@CreatedDate`가 `Instant` 필드를 채우는 것은 Spring Data가 지원한다.
"지금"을 `Clock`에서 꺼내려면 `DateTimeProvider` 빈을 등록해
`@EnableJpaAuditing(dateTimeProviderRef = "...")`로 연결한다 — 그러면
Auditing 시각도 테스트에서 고정된다.

### 3-2. 타입 규약을 ArchUnit으로 — "규칙을 아는 사람"에 의존하지 않기

자바 타입 규약은 세 줄이다. **순간은 `Instant`**(저장·전송·비교의 기본),
**로컬 벽시계는 `LocalDateTime`**(미래 일정의 사용자 입력처럼 "존을 모르는
것이 의도"인 자리에만), **`ZonedDateTime`은 계산용**(로컬 벽시계 + 존 ID로
순간을 구할 때 잠깐 쓰고 저장은 분해해서). 이 규약을 리뷰 코멘트로만 두면
세 번째 신규 입사자 때 깨진다. 빌드에 넣는다.

```java
@AnalyzeClasses(packages = "com.example")
class TimeTypeRulesTest {

    // 규약 1: 엔티티 필드에 LocalDateTime 금지 — 예외는 @LocalWallClock 으로 의도를 밝힌 필드뿐
    @ArchTest
    static final ArchRule entities_store_instants =
        noFields().that().areDeclaredInClassesThat().areAnnotatedWith(Entity.class)
            .and().areNotAnnotatedWith(LocalWallClock.class)
            .should().haveRawType(LocalDateTime.class)
            .because("엔티티의 시각은 Instant(UTC 순간)로 저장한다. 미래 로컬 일정만 @LocalWallClock 으로 표시");

    // 규약 2: JVM 기본 존에 몰래 의존하는 API 호출 금지 — '지금'은 주입받은 Clock 에서 꺼낸다
    @ArchTest
    static final ArchRule no_default_zone_dependency =
        noClasses().should().callMethod(LocalDateTime.class, "now")
            .orShould().callMethod(ZoneId.class, "systemDefault")
            .orShould().callConstructor(Date.class)
            .because("서버가 어디에 있든 같은 값이어야 한다. Clock.instant() / ZoneId.of(사용자 존)을 쓴다");
}
```

규약 2가 잡는 것이 사고 ①의 첫 고리(`LocalDateTime.now()`)다. **사고
사슬의 첫 고리를 컴파일·빌드 단계에서 끊는 것**이 안전망의 요령이다 —
네 번째 고리(배치 오작동)에서 잡으면 이미 데이터가 섞인 뒤다.

### 3-3. 타임존을 바꿔 돌리는 회귀 테스트 — "DB에 실제로 적힌 문자열"을 단정한다

설정 네 개는 누군가 URL을 정리하다가, 베이스 이미지를 바꾸다가, DB를
이전하다가 하나씩 사라진다. 사라지면 빌드가 깨져야 한다. 요령 두 가지 —
**⑴ DB 컨테이너와 테스트 JVM을 일부러 UTC가 아닌 존으로 띄운다**(설정이
OS 존을 이기는지 증명) **⑵ 드라이버 변환을 거치지 않도록 값을 문자열로
꺼내 단정한다**(사고 ②처럼 대칭 오류가 숨는 것을 막는다).

```java
@SpringBootTest
@Testcontainers
@Tag("timezone")                     // 아래 빌드 매트릭스가 이 태그를 여러 JVM 존에서 돌린다
class TimeZoneRegressionTest {

    // ⑴ DB OS 존을 일부러 UTC가 아닌 곳으로 — 설정(④)이 SYSTEM 을 이기는지 확인
    @Container
    static final MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0")
            .withEnv("TZ", "America/Los_Angeles");

    @Autowired PaymentRepository repo;
    @Autowired JdbcTemplate jdbc;

    @Test
    void 세션_존은_UTC_로_고정돼_있다() {
        // ③④ 정합 — 드라이버 force 옵션 또는 서버 default-time-zone 이 살아 있는가
        assertThat(jdbc.queryForObject("SELECT @@session.time_zone", String.class))
                .isIn("UTC", "+00:00");
    }

    @Test
    void 어떤_JVM_존에서_돌려도_DB에는_UTC_벽시계가_적힌다() {
        Instant paidAt = Instant.parse("2026-08-31T00:00:00Z");
        Long id = repo.save(Payment.paid(paidAt)).getId();

        // ⑵ 드라이버의 역변환을 거치지 않는 "실제로 적힌 값" — 문자열로 꺼낸다
        String raw = jdbc.queryForObject(
                "SELECT DATE_FORMAT(paid_at, '%Y-%m-%d %H:%i:%s') FROM payment WHERE id = ?",
                String.class, id);
        assertThat(raw).isEqualTo("2026-08-31 00:00:00");          // KST 09:00 이 적혔다면 여기서 깨진다

        // 앱 경로로 읽어도 같은 순간
        assertThat(repo.findById(id).orElseThrow().getPaidAt()).isEqualTo(paidAt);
    }

    @Test
    void DB_기본값_CURRENT_TIMESTAMP_도_UTC_로_들어간다() {
        // §1-3의 "한 컬럼 두 기준" 방지 — DEFAULT 로 채워진 created_at 과 UTC 로 넣은 paid_at 의 기준이 같은가
        long id = 999_999L;
        jdbc.update("INSERT INTO payment (id, paid_at) VALUES (?, UTC_TIMESTAMP(6))", id);
        Integer diffSec = jdbc.queryForObject(
                "SELECT ABS(TIMESTAMPDIFF(SECOND, created_at, paid_at)) FROM payment WHERE id = ?",
                Integer.class, id);
        assertThat(diffSec).isLessThan(5);                          // 9시간(32400초) 차이면 세션 존이 틀린 것
    }
}
```

"어떤 JVM 존에서 돌려도"는 **테스트 코드 안에서 `TimeZone.setDefault()`를
바꾸는 방식으로 하지 않는다** — 드라이버와 커넥션 풀은 접속 시점의 기본
존을 잡아 두므로 런타임에 바꾼 값이 반영되지 않아 거짓 통과가 난다. 대신
**빌드 매트릭스**로 JVM 자체를 다른 존으로 띄운다.

```groovy
// build.gradle — 같은 테스트를 세 존에서 돌린다. 하나라도 깨지면 설정 ①②③④ 중 무엇이 새는지 바로 안다
["UTC", "Asia/Seoul", "America/Los_Angeles"].each { zone ->
    tasks.register("testIn${zone.replace('/', '_')}", Test) {
        systemProperty "user.timezone", zone
        useJUnitPlatform { includeTags "timezone" }
    }
}
```

세 번째 테스트의 요점은 "DB 기본값 경로(`DEFAULT CURRENT_TIMESTAMP`)와
앱 경로의 기준이 같은가"를 단정하는 것이다 — 세션 존이 KST로 새면 이
테스트가 `32400`으로 깨진다.

### 3-4. 글로벌 서비스 시간 원칙 — 그리고 각 원칙이 스키마에 착지하는 지점

rationale의 표현대로, 22장의 원칙은 4장에서 컬럼 하나하나로 착지한다.
목록으로 인출한다.

1. **저장은 UTC 순간.** 과거·현재의 사건은 UTC 하나로 적는다. → 착지:
   `DATETIME(6)` + 네 시계 UTC 고정(또는 `TIMESTAMP`), 컬럼 코멘트 `'UTC'`,
   `DEFAULT CURRENT_TIMESTAMP`도 UTC 세션에서만.
2. **표시는 사용자 타임존, 변환은 가장 바깥에서.** 사용자 존은
   프로필/요청에서 받고, 변환은 응답 직렬화 층에서 한다. → 착지: DB에서
   `CONVERT_TZ(created_at, ...)`로 표시용 변환을 하지 않는다. 특히 **`WHERE
   CONVERT_TZ(paid_at, ...) >= ...`처럼 컬럼에 함수를 씌우면 인덱스를 못
   탄다**([인덱스가 있는데 풀스캔](./02-index-not-used-full-scan.md)) — "오늘
   매출" 같은 **일 단위 경계는 앱이 비즈니스 존으로 시작·끝 순간을 계산해
   UTC 상수로 바인딩**한다(`paid_at >= :startUtc AND paid_at < :endUtc`).
3. **미래 일정은 로컬 벽시계 + IANA 존 ID.** 사용자가 의도한 것은 벽시계다.
   → 착지: 컬럼 두 개(`publish_local_at`, `publish_zone_id`) + 파생 UTC
   컬럼은 재계산 가능한 캐시. 오프셋(`+09:00`) 저장 금지.
4. **타임존 규칙 변경(tzdata)에 대비.** DST 폐지·도입은 실제로 일어난다.
   → 착지: 파생 UTC 컬럼을 "진실"로 삼지 않는다(규칙이 바뀌면 3의 원본에서
   재계산하는 배치가 있어야 한다). tzdata 갱신 절차(JVM·OS·MySQL tz
   테이블)를 운영 항목으로 둔다.
5. **네 개의 시계를 하나로 못 박고 테스트로 지킨다.** → 착지: §3-1 설정
   4종 + §3-3 회귀 테스트 + 빌드 매트릭스.
6. **"지금"은 주입받은 `Clock`에서.** `LocalDateTime.now()`·`new Date()`·
   `ZoneId.systemDefault()` 금지. → 착지: §3-2 ArchUnit. 배치의 기준
   시각도 SQL의 `NOW()`에 맡기지 않고 앱이 `Instant`로 계산해 파라미터로
   넘긴다 — 그래야 사고 ①의 "컬럼과 기준선의 존이 다른" 비교가 생기지 않고,
   테스트에서 기준 시각을 고정할 수 있다.
7. **타입 규약을 이름으로.** `Instant`(순간) / `LocalDateTime`(의도된 로컬
   벽시계) / `ZonedDateTime`(계산용) / `LocalDate`(날짜만). → 착지: 컬럼
   타입도 대응된다 — `DATETIME(6)` UTC / `DATETIME` + 존 ID / (저장 안 함)
   / `DATE`.

---

## 4. 꼬리질문 대비 포인트

### "TIMESTAMP를 쓰면 DB가 UTC로 저장해 주니 앱은 타임존을 신경 안 써도 되지 않나요?"

**아니다 — 책임의 위치가 바뀔 뿐 없어지지 않는다.** 사슬로 답한다.
`TIMESTAMP`의 UTC 변환은 **세션 `time_zone`을 기준**으로 하고, 세션 존은
DB 서버 OS(`SYSTEM`)나 드라이버 설정(`connectionTimeZone` +
`forceConnectionTimeZoneToSession`)이 정한다. 그 세션 존이 실제와 다르면
**저장되는 순간 자체가 밀리고**(§2-2 사고 ②), 같은 드라이버로 읽으면
대칭으로 되돌아와 앱에선 안 보인다. 게다가 앱 안에서 `LocalDateTime.now()`로
만든 값은 드라이버가 변환 없이 벽시계로 보내므로, 서버가 그것을 세션
존으로 해석하는 순간 JVM 존과 세션 존이 다르면 또 밀린다. 즉 `TIMESTAMP`가
면제해 주는 것은 "여러 클라이언트가 각자 UTC로 변환하는 수고"이지 "네 시계의
정합"이 아니다. 그리고 그 대가로 2038·세션 의존·묵시 DEFAULT를 낸다 —
양면을 붙여서 답한다.

### "DATETIME에 UTC를 저장하기로 했는데, 누군가 KST 벽시계를 넣으면 DB는 모릅니다. 어떻게 막나요?"

세 층으로 답한다. **⑴ 첫 고리를 빌드에서 끊는다** — 엔티티 필드
`LocalDateTime` 금지 + `LocalDateTime.now()`/`ZoneId.systemDefault()`/`new
Date()` 호출 금지를 ArchUnit으로(§3-2). KST 벽시계는 대개 `LocalDateTime.now()`
에서 태어난다. **⑵ 값이 밀릴 수 있는 시계 네 개를 설정으로 못 박는다** —
JVM `-Duser.timezone=UTC`, `hibernate.jdbc.time_zone=UTC`,
`connectionTimeZone=UTC`, DB `default-time-zone='+00:00'`(§3-1). 넷이 같으면
변환이 항등이라 실수해도 안 밀린다. **⑶ 회귀 테스트로 지킨다** — DB
컨테이너를 UTC 아닌 존으로 띄우고 JVM도 여러 존으로 돌리며, **드라이버를
거치지 않은 문자열**로 저장값을 단정(§3-3). 여기에 운영 안전망 하나 —
**정합성 점검 쿼리**: `created_at`이 `UTC_TIMESTAMP()`보다 미래인 행이
있으면 알림. 미래에 생성된 행은 존이 밀린 증거다(사고 ①이 이 쿼리 하나로
첫날 잡혔을 것이다).

### "2038년 문제는 12년 뒤 얘기인데 지금 왜 신경 쓰나요?"

**미래 시각 컬럼은 오늘 이미 2038년을 넘는 값을 받기 때문**이다 — 영구
이용권 `expires_at = 9999-12-31`, 30년 만기 계약, "무기한"을 먼 미래로
표현하는 관례. strict 모드면 INSERT가 에러로 죽고, 아니면 0 값이 들어가
"만료일 0000-00-00"이라는 데이터가 생긴다. 반대편 경계도 있다 — 1970년
이전 생년월일은 `TIMESTAMP`에 애초에 못 들어간다. 그리고 "나중에 바꾸면
되지"의 비용이 크다 — 타입 변경은 **테이블 재작성**이라 수억 건이면 무중단
DDL 도구를 동원하는 작업이고, 그 사이 `TIMESTAMP`로 쌓인 값은 세션 존에
따라 다르게 읽히므로 변환 시점의 세션 존까지 맞춰야 한다. 즉 2038은 "먼
미래의 만기"가 아니라 **"미래 시각을 담는 모든 컬럼에 대해 지금 타입을
고르는 기준"** 이다. 가산점으로 — 이 문제는 MySQL 함수 층이 아니라
**컬럼 타입의 4바이트 저장 포맷**에서 오는 것이라 SQL 함수의 64비트 지원과
별개다.

### "'매일 밤 11시 신작 공개'를 그냥 UTC로 환산해 저장하면 안 되나요? 저장은 UTC가 원칙이라면서요."

**"저장은 UTC"는 과거·현재의 사건에 대한 원칙이고, 미래 일정은 저장할
것이 다르다.** 사용자가 정한 것은 "서울 벽시계로 23:00"이라는 **규칙**이지
특정 UTC 순간이 아니다. 지금 `14:00Z`로 환산해 저장하면 — ⑴ DST가 있는
존이면 전환일 이후 환산 결과가 1시간 바뀌어 "22:00 공개"가 된다 ⑵ 그
나라가 DST를 폐지하거나 도입하면(tzdata 변경) 이미 저장된 모든 미래
행이 틀린다 ⑶ 되돌릴 근거(원래 벽시계와 존)가 값에 없다. 그래서 **로컬
벽시계 + IANA 존 ID를 원본으로 저장**하고, UTC는 스캔·정렬용 **파생
캐시**로 두되 존 규칙이 바뀌면 원본에서 재계산한다. 오프셋(`+09:00`)이
아니라 존 ID(`Asia/Seoul`)여야 하는 이유도 같다 — 오프셋은 "지금의 결과"이고
존 ID는 "규칙"이다. 스캐너(배치)는 파생 UTC 컬럼으로 "지금 공개할 것"을
찾되, 실제 공개 직전에 원본으로 한 번 더 검증하면 규칙 변경 사이의 창도
막는다. DST 전환일에 존재하지 않는 시각(02:30이 없는 날)의 처리는 22장
문서의 몫이다.

### "이미 DATETIME에 KST 벽시계로 3년치가 쌓여 있는 서비스가 글로벌 진출합니다. 어떻게 전환하시겠어요?" (시니어 변별 포인트)

**"컬럼의 의미를 바꾸는 마이그레이션"** 이라 타입 변경보다 어렵다 — 값의
모양은 같고 기준만 바뀌기 때문에, 전환 중에 "이 행은 어느 기준인가"를
잃으면 복구가 안 된다. 순서로 답한다.

**⑴ 진단 먼저** — 정말 전부 KST인가? §2-2 사고 ①처럼 이미 UTC와 KST가
섞여 있을 수 있다. 배포 이력·`created_at`이 미래인 행·`NOW()` 기준 배치의
오작동 로그로 경계를 찾는다. 섞여 있으면 구간별 오프셋을 먼저 확정한다.

**⑵ 쓰기 경로부터 UTC로 고정** — §3-1의 네 시계 설정과 ArchUnit을 먼저
넣되, **기존 컬럼은 건드리지 않고 새 컬럼(`paid_at_utc DATETIME(6)`)에
이중 쓰기**한다. 이 시점부터 새 행은 두 컬럼이 다 채워진다.

**⑶ 백필** — 기존 행을 `paid_at_utc = CONVERT_TZ(paid_at, 'Asia/Seoul',
'+00:00')`로 채운다(이름 있는 존을 쓰려면 tz 테이블 로드 필요, 또는 KST는
DST가 없으므로 `paid_at - INTERVAL 9 HOUR`로 충분하다 — **한국이 DST가 없는
것이 이 마이그레이션의 행운**이고, DST가 있는 존이었다면 행마다 규칙을
적용해야 한다). 수억 건이면 PK 범위로 쪼개 배치로 돌린다([무중단
DDL](./14-online-ddl-zero-downtime-schema-change.md)의 백필 절차와 같다).

**⑷ 읽기 전환 → 검증 → 정리** — 읽기를 새 컬럼으로 옮기고, 두 컬럼의
차이가 정확히 9시간인지 전수 점검 쿼리로 확인한 뒤, 구 컬럼을 삭제하고
새 컬럼을 원래 이름으로 돌리거나 그대로 둔다. 컬럼 코멘트에 `'UTC'`를
남긴다.

**⑸ 이 기회에 미래 일정 컬럼을 분리** — 예약 공개 시각처럼 "벽시계가
의도"인 컬럼은 UTC로 환산하는 것이 아니라 존 ID 컬럼을 추가해 §2-4(b)
구조로 바꾼다. 전환의 트레이드오프를 양면으로 — 이중 쓰기 기간에는 코드가
두 컬럼을 알아야 하고 저장 공간이 늘지만, **한 번의 `UPDATE`로 제자리
변환하는 것은 실행 도중 앱이 어느 기준으로 읽어야 하는지 정의할 수 없어**
서비스 중단 없이는 불가능하다. 마지막으로 — **이 전환이 필요해진 이유가
곧 "처음에 네 시계를 UTC로 못 박고 `Instant`를 썼어야 하는 이유"** 라고
닫는다.

---

## 한 줄 요약

**`TIMESTAMP`는 세션 타임존 → UTC로 변환해 4바이트 epoch 초로 적고 읽을 때
되돌리는 "순간" 타입이라 자동 UTC 정규화를 얻는 대신 2038년 범위와 세션
존 의존을 내고, `DATETIME`은 변환 없이 벽시계를 그대로 적는 타입이라 넓은
범위와 예측 가능성을 얻는 대신 타임존 정보가 사라져 "이 컬럼은 UTC"라는
규율을 앱이 지켜야 하므로 — 글로벌 서비스라면 사건 시각은 `DATETIME(6)` +
네 개의 시계(JVM·Hibernate·JDBC·DB 세션) UTC 고정 + `Instant` 타입 규약
(ArchUnit) + 타임존을 바꿔 도는 회귀 테스트를 한 세트로 고르고, 미래
일정은 로컬 벽시계 + IANA 존 ID를 원본으로 분해 저장해 UTC는 재계산 가능한
파생 컬럼으로만 두며, `TIMESTAMP`는 2038 이전 값만 오고 다국어 클라이언트가
직접 쓰는 로그성 테이블에 한정한다.**
