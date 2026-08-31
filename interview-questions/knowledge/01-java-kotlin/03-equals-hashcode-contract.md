# equals()와 hashCode() 동시 재정의 — "분명 넣었는데 못 찾는" 버그의 뿌리

> 핵심 관전 포인트: **HashMap/HashSet은 객체를 찾을 때 `hashCode()`로 버킷
> (저장 칸)을 먼저 고르고, 그 칸 안에서 `equals()`로 최종 확인하는 2단계로
> 동작한다. 그래서 `equals()`만 재정의하고 `hashCode()`를 안 하면
> "논리적으로 같은 객체"가 서로 다른 칸으로 흩어져, 넣은 객체를 못 찾는다.
> 규약은 하나다 — `equals()`가 true인 두 객체는 반드시 같은 `hashCode()`를
> 반환해야 한다. 이 규약이 깨지면 예외 없이 조용히 틀어지기 때문에
> 중복 처리 실패, 캐시 미스 폭증처럼 엉뚱한 증상으로 나타난다.**

---

## 0. 질문 + 의도

**질문**: "`equals()`와 `hashCode()`를 함께 재정의해야 하는 이유는
무엇인가요?"

**출제 의도**: HashMap/Set에 넣은 객체가 "분명 넣었는데 못 찾는" 버그는
재현이 어렵고 증상이 엉뚱한 곳(중복 처리 실패, 캐시 미스 폭증)에서
나타난다. 이 규약을 모르면 그 버그를 몇 시간씩 엉뚱한 데서 찾는다.
AI가 생성한 엔티티/VO 코드에서 이 실수를 리뷰로 잡아낼 수 있는지도 본다.

## 1. 규약 — equals가 같으면 hashCode도 같아야 한다

`Object` 클래스의 Javadoc이 명시하는 계약(contract)은 이것이다.

- `equals()`가 **true**인 두 객체는 **반드시 같은** `hashCode()`를
  반환해야 한다.
- 반대 방향은 강제가 아니다 — `hashCode()`가 같아도 `equals()`는
  다를 수 있다(해시 충돌, 정상 상황).

재정의하지 않은 기본 구현은 **"메모리상 같은 객체인가"**(참조 동일성)
기준이다. `equals()`를 "필드 값이 같으면 같은 객체"로 재정의하는 순간,
동등성의 정의가 바뀌었으므로 `hashCode()`도 **같은 필드 기준으로** 함께
바꿔야 규약이 유지된다. 한쪽만 바꾸면 계약 위반이다.

비유하면 hashCode는 **도서관의 서가 번호**, equals는 **책 제목 대조**다.
같은 책인데 서가 번호를 매번 다르게 매기면, 사서(HashMap)는 엉뚱한
서가만 뒤지고 "그런 책 없다"고 답한다.

## 2. HashMap/HashSet이 객체를 찾는 2단계

해시 컬렉션의 조회는 항상 이 순서다.

1. `hashCode()`로 **버킷(저장 칸) 인덱스**를 계산해 그 칸으로 간다.
2. 그 칸 안의 후보들과 `equals()`로 **최종 동등성**을 확인한다.

핵심: **1단계에서 다른 칸으로 가면 2단계(equals)는 아예 호출되지 않는다.**
그래서 equals만 완벽히 재정의해도 hashCode가 다르면 못 찾는다.

```java
// Before: equals만 재정의 — hashCode 누락 (AI 생성 코드에서 흔한 형태)
public class Money {
    private final String currency;
    private final long amount;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money)) return false;
        Money m = (Money) o;
        return amount == m.amount && currency.equals(m.currency);
    }
    // hashCode() 재정의 없음 → Object 기본 구현(객체마다 제각각) 사용
}

Set<Money> paid = new HashSet<>();
paid.add(new Money("KRW", 1000));
paid.contains(new Money("KRW", 1000));  // false! — equals는 true인데 못 찾음
```

두 `Money` 객체는 equals로는 같지만, hashCode가 제각각이라 서로 다른
버킷에 배정된다. `contains`는 엉뚱한 버킷을 보고 false를 반환한다.

```java
// After: 둘을 같은 필드 기준으로 함께 재정의
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Money)) return false;
    Money m = (Money) o;
    return amount == m.amount && currency.equals(m.currency);
}

@Override
public int hashCode() {
    return Objects.hash(currency, amount);  // equals가 보는 필드와 반드시 동일하게
}
```

## 3. 실무에서 나타나는 증상 — 예외가 안 나서 더 무섭다

이 버그의 공통점은 **컴파일도 되고 예외도 없다**는 것. 증상이 원인과
동떨어진 곳에서 나타난다.

- **중복 처리 실패**: "이미 처리한 주문인지" `Set`으로 걸렀는데,
  같은 주문이 매번 새 객체로 들어와 전부 통과 → 중복 결제/중복 발송.
- **캐시 미스 폭증**: `HashMap<CacheKey, V>` 캐시에서 매번 못 찾아
  적중률 0% — 캐시는 "동작"하므로 모니터링 그래프를 보기 전까지 모른다.
- **`Map.put` 덮어쓰기 실패**: 같은 키로 put했는데 기존 값이 안 바뀌고
  항목이 계속 늘어난다(사실상 메모리 누수).
- 반대 방향 실수(equals 없이 hashCode만, 또는 서로 다른 필드 사용)도
  같은 계열의 버그를 만든다.

단위 테스트에서 같은 참조로 검증하면 전부 통과하고, **운영에서 역직렬화·
DB 조회로 "값은 같은 새 객체"가 만들어질 때만** 터진다 — 재현이 어려운
이유다.

## 4. 꼬리질문 대비 포인트

### "hashCode만 같고 equals가 다르면 어떻게 되나요?"

규약 위반이 아니다(허용되는 해시 충돌). 같은 버킷에 여러 객체가 모여서
equals 비교 횟수가 늘어나 **성능만 저하**되고, 동작은 정확하다.
극단적으로 모든 객체가 `hashCode()`에서 상수를 반환하면 HashMap이
사실상 연결 리스트가 되어 조회가 O(1) → O(n)으로 나빠진다.
(가산점 포인트: 자바의 HashMap은 한 버킷에 항목이 일정 수 이상 쌓이면
연결 리스트를 트리로 바꿔(트리화) 최악을 O(log n)으로 완화한다.)

### "가변 필드로 hashCode를 만들면 무슨 일이 생기나요?"

`Set`에 넣은 뒤 그 필드를 수정하면 hashCode가 바뀌지만 객체는 **옛날
해시값 기준 버킷에 그대로** 있다. 이후 `contains`는 새 해시값의 버킷을
보므로 못 찾고, `remove`도 실패한다 — 지울 수도 찾을 수도 없는
"유령 항목"이 된다. 그래서 equals/hashCode의 기준 필드는 **불변**이거나
최소한 컬렉션에 담긴 동안 바뀌지 않아야 한다. VO(값 객체)를 불변으로
설계하는 이유 중 하나다.

### "JPA 엔티티에서는 equals/hashCode를 어떻게 재정의하나요?" (시니어 변별 포인트)

엔티티는 두 가지 함정이 겹친다.

- **ID는 저장 전까지 null**이다. ID 기반 equals를 쓰면 비영속 상태의
  두 엔티티가 잘못 같아지거나(둘 다 null), 저장 시점에 hashCode가 바뀌어
  Set에서 유령이 된다. 그래서 **hashCode는 상수나 클래스 기반의 고정값을
  반환하고, equals는 ID가 있을 때만 ID로 비교**하는 절충이 널리 쓰인다
  (해시 분산은 포기하지만 규약 위반은 없다).
- **지연 로딩 프록시** 때문에 `getClass()` 비교는 프록시 vs 실제 클래스가
  달라 실패할 수 있어 `instanceof` 비교가 안전하고, 필드 직접 접근 대신
  getter를 거쳐야 프록시가 초기화된다.

모든 필드를 넣는 Lombok `@EqualsAndHashCode`나 IDE 자동 생성을 엔티티에
그대로 붙이는 것이 전형적인 리뷰 지적 대상이다 — 지연 로딩 필드 접근으로
의도치 않은 쿼리가 나가거나, 가변 필드 때문에 유령 항목이 생긴다.

### "record나 Lombok을 쓰면 신경 안 써도 되나요?"

`record`는 모든 컴포넌트 기준으로 equals/hashCode를 **항상 쌍으로** 자동
생성하므로 값 객체에 가장 안전한 선택이다. Lombok은
`@EqualsAndHashCode`가 쌍을 보장하지만, **어떤 필드를 기준으로 삼는지**는
여전히 사람의 판단이다(엔티티 함정은 위 참고). AI 생성 코드 리뷰에서
볼 지점: equals만 있고 hashCode가 없는 클래스, 두 메서드가 서로 다른
필드를 보는 클래스, 해시 컬렉션의 키로 쓰이는데 가변인 클래스.

### "equals 재정의 시 지켜야 할 일반 규약은 무엇인가요?"

반사성(자기 자신과 같다), 대칭성(a=b면 b=a), 추이성(a=b, b=c면 a=c),
일관성(필드가 안 변하면 결과도 불변), null과는 항상 false — 다섯 가지다.
실무에서 특히 깨지기 쉬운 것은 **대칭성**으로, 상속 관계에서 부모/자식이
서로 다른 기준으로 비교할 때 발생한다(가산점 포인트: 그래서 상속보다
조합, 또는 `instanceof` 대신 `getClass()` 비교라는 트레이드오프 논의가
나온다 — 값 객체라면 상속 자체를 피하고 final로 막는 것이 정석).

---

## 한 줄 요약

해시 컬렉션은 hashCode로 칸을 찾고 equals로 확인하는 2단계라,
동등성의 정의를 바꿨다면(equals 재정의) 칸 배정 기준(hashCode)도
같은 필드로 함께 바꿔야 한다 — 한쪽만 바꾸면 "넣었는데 못 찾는" 버그가
예외 없이 조용히 시작된다.
