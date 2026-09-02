# 수억 건 삭제/아카이빙 — PostgreSQL에서 `DELETE` 한 방이 장애가 되는 다섯 사슬과, 청크 · 파티션 DETACH · 복사 후 교체가 각각 지불하는 값

> 핵심 관전 포인트: **수억 건 테이블에 `DELETE ... WHERE created_at < ?` 한 방은 "느린 쿼리"가 아니라 자원 다섯 개에서 동시에 출발하는 장애다. 출발점은 PostgreSQL의 `DELETE`가 행을 실제로 치우지 않는다는 사실이다 — 튜플에 "이 트랜잭션이 지웠다"는 표시(`xmax`)만 남기고 공간은 1바이트도 안 돌려주며, 진짜 청소는 나중에 VACUUM이 한다. 그래서 삭제가 끝나도 정리 작업이 남고, 심지어 그 한 문장이 도는 동안에는 "아직 이 트랜잭션이 볼 수 있어야 하는 가장 오래된 시점"이 고정돼 무관한 테이블의 VACUUM까지 함께 멈춘다. 락은 PostgreSQL이 상대적으로 나은 축이지만(갭 락이 없어 잠그는 범위가 좁다) 길게 쥔 약한 테이블 락 뒤에 강한 락 요청 하나가 서면 그 뒤의 평범한 SELECT까지 줄을 서고, PostgreSQL은 자식 테이블의 외래 키 컬럼에 인덱스를 자동으로 만들어 주지 않아 부모 한 건을 지울 때마다 자식 전체 스캔이 나기도 한다. WAL(변경 기록)은 커밋을 기다리지 않고 흘러가므로 "롤백했으니 복제본은 무사"가 성립하지 않고, 밀린 복제 슬롯이나 아카이브가 WAL을 붙잡으면 `pg_wal` 디스크가 차서 서버가 정지한다. 인덱스는 삭제 순간에 아예 건드리지 않는 대신 VACUUM이 모든 인덱스를 전수 스캔하며 청구서를 나중에 낸다. 그리고 다 지워도 파일 크기는 그대로다. PostgreSQL의 위안은 하나 — 롤백이 상수 시간이라 중간에 KILL해도 MySQL InnoDB처럼 "롤백이 원 작업보다 오래 걸리는" 공포가 없다. 대신 그동안 쓴 WAL과 멈춰 있던 VACUUM은 환불되지 않는다. 답은 접근법 3종을 조건에 따라 고르는 것이다 — 삭제라는 일을 잘게 나누는 청크 삭제(지금 당장 가능하지만 총 I/O·VACUUM 부채가 크고 공간은 안 돌아온다), 삭제를 DML이 아닌 것으로 바꾸는 파티션 DETACH·DROP(즉시·저비용이지만 사전 파티셔닝과 PK에 파티션 키 포함, 프루닝 조건이 필요하다), 남길 것만 옮기고 버리는 복사 후 교체(공간 완전 회수지만 쓰기 델타와 디스크 2배를 낸다). 어느 쪽이든 삭제 전 아카이브 검증(건수·체크섬·`EXCEPT`) → 드라이런 → 복제 지연·VACUUM 추격 임계에서 스스로 멈추는 청크 루프 → 파티션 자동 생성·드랍 스케줄러 → 보존 정책을 테이블 설계 시점에 고정, 이 절차를 사람의 기억이 아니라 코드로 박는다.**

---

## 0. 질문 + 의도

**질문**: "수억 건 테이블에서 특정 기간 데이터를 삭제/아카이빙해야 합니다. 어떻게 접근하겠습니까? (파티셔닝 포함)"

**PostgreSQL 기준 재해석**: "수억 건 테이블에서 특정 기간 데이터를 삭제/아카이빙할 때, **죽은 튜플·VACUUM·WAL·복제 슬롯**에 어떤 부채가 쌓이고, 청크 삭제 / 파티션 DETACH / 테이블 교체 중 무엇을 무슨 근거로 고르겠습니까?"

**출제 의도**: rationale은 이렇게 적고 있다 — "DELETE 한 방이 자원 폭증·복제 지연·락으로 장애가 되는 것을 아는지. **'작업을 운영에 안전하게 수행하는 방법'(청크 분할, 파티션 드랍) 자체가 시니어의 기술**임을 확인한다." 즉 이 문항의 채점 지점은 SQL 문법이 아니다. ⑴ 왜 위험한지를 **자원별 메커니즘**으로 말할 수 있는가 ⑵ 선택지마다 **무엇을 지불하는지** 아는가 ⑶ 그 절차를 담당자의 주의력이 아니라 **코드와 스키마가 지키게** 만들어 봤는가. 고난이도 문항이므로 트레이드오프 서술 자체가 평가 대상이다 — "청크로 나눠서 지웁니다"까지는 누구나 말하고, "청크로 나누면 대신 무엇이 나빠지는가"에서 갈린다. PostgreSQL에서는 여기에 한 겹이 더 붙는다: **삭제 작업은 끝나도 정리 작업(VACUUM)이 남는다**는 것을 답에 넣는지.

> 이 문서는 후보자의 횡단 약점 4가지를 겨냥해 구성했다 — ① 비용·인과를 **자원별 사슬**로 말하기(1장) ② 접근법 3종 각각의 **대가를 양면으로** 조립하기(2장) ③ 안전망을 **코드·스키마로 고정**하기(3장) ④ "접근법 3종 비교표"와 "청크 루프 필수 요소 9가지"를 **목록으로 인출**하기(2-1절 · 2-6절).

> 역할 구분:
> - [16-long-transaction-harm-and-shortening.md](./16-long-transaction-harm-and-shortening.md)는 긴 트랜잭션의 **일반론**이다. 이 문서의 1장은 그 사슬이 "대량 DELETE"라는 특정 작업에서 어떤 모습으로 나타나는지에 더해, 그 문서에 없는 **인덱스 정리 비용**과 **공간 미반환** 두 사슬을 추가한다.
> - [14-online-ddl-zero-downtime-schema-change.md](./14-online-ddl-zero-downtime-schema-change.md)는 **스키마 변경**의 무중단이다. 파티셔닝 도입·`VACUUM FULL`·`ATTACH/DETACH`·테이블 RENAME은 전부 DDL이라 그쪽의 **잠금 대기열** 사슬이 그대로 적용된다.
> - [11-mvcc-postgresql.md](./11-mvcc-postgresql.md)는 죽은 튜플과 VACUUM의 원리다. 이 문서 1장의 사슬 A·D·E는 전부 거기서 출발한다.
> - [11-bulk-operation-persistence-context.md](../03-jpa-orm/11-bulk-operation-persistence-context.md)는 JPQL 벌크 연산과 영속성 컨텍스트의 불일치를 다룬다. 이 문서의 삭제 루프가 JPA를 거치지 않고 JDBC로 내려가는 이유가 거기 있다.
> - 이 문서는 **대량 삭제를 운영 중인 DB에서 안전하게 실행하는 절차**를 담당한다.

---

## 1. 왜 `DELETE ... WHERE created_at < ?` 한 방이 장애가 되는가 — 자원별 다섯 사슬

```sql
-- "3개월 지난 조회 로그 지워주세요" 티켓을 받고 새벽에 실행한 한 줄
DELETE FROM episode_view_log
 WHERE created_at < now() - interval '3 months';   -- 대상 약 2억 건
```

"오래 걸린다"가 답이 아니다. 이 한 문장은 **하나의 트랜잭션**으로 2억 행을 지우며, 그동안 아래 다섯 자원을 동시에 점유·소모한다. 면접에서는 A → B → C 순으로 말하고, D·E는 "그리고 다 끝나도"로 붙인다. 각 사슬은 "무슨 자원이 → 어떻게 쌓여 → 누구의 무엇이 → 왜 죽는가"까지 간다.

### 1-1. 사슬 A — 죽은 튜플과 VACUUM: 지우는 게 아니라 "지웠다고 표시"할 뿐이다

**먼저 PostgreSQL의 `DELETE`가 물리적으로 무엇을 하는지부터 못 박는다.** 이 한 가지를 잘못 알고 있으면 나머지 네 사슬이 전부 어긋난다.

PostgreSQL의 `DELETE`는 행을 **제거하지 않는다.** 행이 들어 있는 8KB 힙 페이지 안의 그 튜플에 **`xmax`를 기록**할 뿐이다. `xmax`는 "이 튜플을 지운(또는 갱신한) 트랜잭션의 ID"를 적는 튜플 헤더의 칸이다. 바이트는 그 자리에 그대로 남고, 헤더에 "몇 번 트랜잭션이 이걸 지웠다"는 쪽지만 붙는다.

왜 이런 구조인가. PostgreSQL은 **MVCC**(Multi-Version Concurrency Control, 다중 버전 동시성 제어)로 읽기와 쓰기가 서로를 막지 않게 만드는데, 그러려면 **누군가는 아직 옛 버전을 봐야 하기 때문**이다. 내가 지운 순간에도, 나보다 먼저 시작해 아직 안 끝난 트랜잭션은 "그 행이 아직 살아 있던 세계"를 보고 있어야 한다. 그래서 지운 즉시 바이트를 없애면 안 된다. MySQL의 InnoDB가 옛 버전을 **언두 로그**라는 별도 영역에 쌓아 두는 것과 달리, PostgreSQL은 **옛 버전이 곧 그 자리의 그 행**이다.

커밋되고 나면 그 튜플은 **죽은 튜플(dead tuple)** 이 된다. 아무도 볼 필요가 없어졌는데 공간은 차지하고 있는 시체다. 이 시체를 실제로 치우고 그 공간을 재사용 가능하게 만드는 것이 **VACUUM**(진공청소기라는 이름 그대로, 죽은 튜플을 빨아들이는 청소 작업)이고, 평소에는 **autovacuum** 백그라운드 프로세스가 알아서 돈다.

**여기서 이 문서 전체를 관통하는 한 문장이 나온다.** VACUUM은 아무 죽은 튜플이나 치울 수 없다 — **"지금 열려 있는 가장 오래된 스냅샷보다 나중에 죽은 튜플"은 그 스냅샷을 가진 누군가가 아직 볼 수 있으므로 치울 수 없다.** 이 문장 하나가 "긴 트랜잭션은 왜 나쁜가"의 전부다. 트랜잭션 두 개를 놓고 시간축에 그려 보면 눈에 보인다.

```text
시간 ────────────────────────────────────────────────────────────────────▶

  T1 (분석 쿼리)     BEGIN ─────────────────────── 계속 돌고 있음 ─────────▶
                      │ 스냅샷 획득: "XID 1000 시점의 세계를 본다"
                      │
  T2 (주문 UPDATE)         BEGIN ─ UPDATE order ─ COMMIT
                                     │              (XID 1500)
                                     └─ 옛 버전 튜플이 여기서 죽었다
                                        (xmax = 1500)
                                                            │
  autovacuum                                                ▼
                                              "order 테이블에 죽은 튜플이 있네,
                                               치워도 되나?"
                                                     │
                                                     ├─ 클러스터에서 열려 있는
                                                     │  가장 오래된 스냅샷 = T1의 1000
                                                     │
                                                     └─ 죽은 시점(1500) > 1000
                                                        → T1이 아직 이 옛 버전을
                                                          볼 권리가 있다 → 못 치운다

  결론: T1이 커밋하거나 롤백해서 사라지기 전까지, 그 죽은 튜플은 계속 쌓인다.
        T1이 order 테이블을 읽지 않아도 마찬가지다 — 판정 기준이 "이 테이블을
        읽는가"가 아니라 "클러스터에서 가장 오래된 스냅샷이 몇 번인가"이기 때문.
```

이 "내가 아직 볼 수 있어야 하는 가장 오래된 XID"를 PostgreSQL은 백엔드마다 `backend_xmin`이라는 값으로 들고 있고, `pg_stat_activity`에서 조회할 수 있다. 트랜잭션이 열려 있는 동안 이 값은 **고정된다.** 그리고 VACUUM은 클러스터 전체의 `backend_xmin` 중 가장 작은 값을 기준선으로 삼는다.

**그래서 40분짜리 `DELETE` 한 방이 하는 일은 이렇다.**

> ⑴ **트랜잭션이 도는 40분 동안 이 백엔드의 `backend_xmin`이 고정된다.** 그러면 위 다이어그램의 T1 자리에 이 DELETE가 앉는 셈이고, **삭제 대상 테이블이 아니라 클러스터 전체의 VACUUM이 그 시점에 묶인다.** 조회 로그를 지우는 작업이 아무 상관 없는 주문 테이블의 청소를 40분간 세운다. 그 40분 동안 주문 테이블에서 발생한 UPDATE·DELETE의 죽은 튜플은 쌓이기만 한다 → [16번 문서](./16-long-transaction-harm-and-shortening.md)의 사슬이 그대로 재발한다.
>
> 여기서 한 단계 더 길어지면 **XID wraparound 압박**이 온다. PostgreSQL의 트랜잭션 ID는 32비트 순환 번호라 약 20억을 쓰면 한 바퀴 돌고, 돌기 전에 VACUUM이 오래된 튜플을 "언제나 과거"로 얼려(freeze) 둬야 한다. VACUUM이 계속 막혀 있으면 이 얼리는 작업이 밀리고, `autovacuum_freeze_max_age`를 넘기면 서버가 다른 일을 제치고 강제 VACUUM을 돌리며, 그래도 못 따라가면 **쓰기를 거부하는 상태**까지 간다.
>
> ⑵ 40분쯤 지나 담당자가 취소(`pg_cancel_backend`)하면 — **여기서 PostgreSQL은 MySQL의 InnoDB와 결정적으로 다르다. 롤백이 O(1)이다.** 되돌릴 언두를 역순으로 적용하는 단계가 없고, `pg_xact`(예전 이름 CLOG. 트랜잭션별 커밋/중단 상태를 2비트씩 적어 두는 배열)에 "이 XID는 abort"라고 찍으면 끝난다. 그 순간 2억 개 튜플의 `xmax`는 "abort된 트랜잭션이 찍은 것"이 되어 무시되고 행은 그대로 살아 있다. **"KILL하면 롤백이 원 작업만큼 걸린다"는 공포는 PostgreSQL에는 없다.**
>
> ⑶ 대신 **환불되지 않는 것**이 있다: 40분 동안 만진 페이지는 전부 더티가 되어 이미 디스크로 나갔고, WAL도 이미 다 나갔고, 그동안 멈춰 있던 VACUUM의 부채도 그대로다. **작업은 0건인데 비용은 다 냈다.**
>
> ⑷ 정상 커밋되면 진짜 청구서가 그때 온다 — **2억 개의 죽은 튜플.** autovacuum이 이걸 치우는데, autovacuum은 운영 부하를 배려해 **비용 기반 지연**(`autovacuum_vacuum_cost_delay` / `autovacuum_vacuum_cost_limit` — 일정 비용만큼 일하면 잠깐 쉬는 방식)으로 스로틀되므로 수 시간~며칠이 걸린다. 그동안 테이블은 부풀어 있고(bloat), 같은 결과를 내는 데 더 많은 페이지를 읽고, `Index Only Scan`은 visibility map(어느 페이지가 "전부 살아 있는 튜플뿐"인지 표시해 둔 비트맵)이 낡아 **힙 페치로 퇴화**한다.

**⑵의 "롤백이 O(1)"은 MySQL과 나란히 놓아야 감이 온다.** 같은 상황에서 두 엔진이 무엇을 하는지 표로 본다.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| 옛 버전을 어디에 두나 | **제자리.** 힙 페이지의 그 튜플에 `xmax`만 찍는다 | **별도 영역.** MySQL의 언두 로그(undo tablespace)에 "되돌리는 방법"을 순서대로 쌓는다 |
| 2억 건 DELETE 중 KILL하면 | `pg_xact`에 "이 XID는 abort" **한 항목**을 찍는다. 튜플은 손도 안 댄다 | MySQL은 쌓아 둔 **언두 레코드 2억 개를 역순으로 다시 적용**한다 — 지운 행을 하나씩 되살리는 실제 작업 |
| 걸리는 시간 | **상수.** 1초 미만 | **원 작업에 비례.** MySQL에서 "40분 삭제 → 1시간 롤백 → 결과 0건"이 실제로 나온다 |
| 그래도 남는 비용 | 이미 나간 WAL·더티 페이지, 40분간 멈춰 있던 VACUUM 부채 | MySQL은 팽창한 언두 테이블스페이스, 밀린 purge(언두 정리) 작업 |
| 뒷정리는 누가 | **VACUUM**이 나중에 죽은 튜플을 치운다 | MySQL은 **purge 스레드**가 나중에 언두 레코드와 delete-mark를 치운다 |

읽는 법은 이렇다. **두 엔진 모두 "옛 버전을 누군가 나중에 치워야 한다"는 구조는 같고, 다른 것은 그 옛 버전을 어디에 두느냐다.** 제자리에 두면(PostgreSQL) 되돌리기가 공짜인 대신 테이블이 부풀고, 별도 영역에 두면(MySQL) 테이블은 깨끗한 대신 되돌리기가 원 작업만큼 비싸다. 면접에서 "PostgreSQL은 롤백이 빠릅니다"만 말하면 절반이고, **"대신 VACUUM 부채로 같은 값을 뒤에서 낸다"**까지 붙여야 완성이다.

관측 지점: `pg_stat_user_tables`의 `n_dead_tup` / `last_autovacuum`, 진행 중인 VACUUM은 `pg_stat_progress_vacuum`, 트랜잭션 나이는 `pg_stat_activity`의 `now() - xact_start`와 `backend_xmin`.

> **MySQL 대조:** InnoDB는 delete-mark + 언두 레코드를 남기므로 undo 테이블스페이스가 트랜잭션 크기에 비례해 팽창하고, 중간에 `KILL`하면 **undo를 역순으로 적용하는 롤백이 원 작업 이상 걸린다**(40분 삭제 → 1시간 롤백 → 0건). 그리고 가장 오래된 활성 트랜잭션이 purge를 막아 history list length가 치솟는다. PostgreSQL은 롤백 공짜, 대신 **VACUUM 부채**로 같은 값을 뒤에서 낸다 — 이름과 지불 시점이 다를 뿐 "옛 버전을 누군가 나중에 치워야 한다"는 구조는 같다.

### 1-2. 사슬 B — 락: 범위는 좁지만, 대기열과 FK가 남는다

PostgreSQL의 행 락은 **별도 락 테이블이 아니라 튜플 헤더 `xmax`에 기록**된다. 즉 1-1에서 본 "지웠다는 표시"와 "잠갔다는 표시"가 같은 칸이다. 그래서 **락 에스컬레이션**(잠글 행이 너무 많아지면 락을 테이블 단위로 승격하는 동작)도, 잠글 수 있는 행 수 제한도 없다. 그리고 **갭 락·넥스트 키 락이 없다** — 스캔했지만 조건에 안 맞는 행, 아직 존재하지 않는 행은 잠그지 않는다. 여기까지는 MySQL의 InnoDB보다 명백히 낫다. 그래도 남는 것이 넷이다.

> ⑴ **삭제 대상 행은 커밋까지 잠긴다.** 그 행을 `UPDATE`하거나 `FOR UPDATE`하려는 트랜잭션은 `pg_stat_activity`에서 `wait_event_type = 'Lock'`, `wait_event = 'transactionid'`로 대기한다. 과거 데이터라 경합이 적을 것 같지만, "3개월 지난 알림을 읽음 처리" 같은 뒤늦은 UPDATE가 하나라도 있으면 그 세션은 **40분을 통째로** 기다린다(`lock_timeout`을 안 걸었다면 — PostgreSQL은 락 대기에 기본 상한이 없다).
> ⑵ **테이블 락 대기열이 진짜 위험이다.** DELETE는 테이블에 `ROW EXCLUSIVE`를 잡는다. 이 락은 다른 DML과는 서로 양보하는 약한 락이라 그 자체로는 문제가 없다. 문제는 그 상태에서 누군가 `ALTER TABLE`이나 `VACUUM FULL`, 파티션 `ATTACH` 같은 **`ACCESS EXCLUSIVE` 요청**(그 테이블을 아무도 못 건드리게 하는 최강 락)을 할 때다. 그 요청은 대기열에 서고, **PostgreSQL의 락 대기열은 앞사람을 추월할 수 없으므로 그 뒤에 오는 평범한 SELECT까지 전부 그 뒤에 줄 선다.** 40분짜리 DELETE + 배포 스크립트의 ALTER 한 줄 = 테이블 전면 정지([14번 문서](./14-online-ddl-zero-downtime-schema-change.md)).
> ⑶ **FK 자식 검사가 조용한 폭탄이다.** PostgreSQL은 **자식 테이블의 FK 컬럼에 인덱스를 자동으로 만들어 주지 않는다**(MySQL은 만든다). 부모 행 하나를 지울 때마다 자식 테이블에서 "이 부모를 참조하는 행이 있나"를 확인해야 하는데 인덱스가 없으면 **자식 전체 스캔**이다. 부모 2억 건 × 자식 풀스캔 = 사실상 영원히 안 끝난다. `ON DELETE CASCADE`면 여기에 자식 삭제 비용까지 곱해진다. 대량 삭제 전에 **자식 FK 컬럼 인덱스 유무를 먼저 확인**하는 것이 PostgreSQL에서 가장 흔한 사고 예방이다(조회 SQL은 3-3에 있다).
> ⑷ 락을 기다리는 세션은 커넥션을 쥔 채 대기하고, **PostgreSQL의 커넥션은 스레드가 아니라 OS 프로세스**라 그 자체가 비싸다 → HikariCP 풀이 대기자로 채워짐 → 이 테이블과 무관한 API까지 `connection-timeout`으로 실패. 방어는 `lock_timeout`(작업 쪽에서 "이만큼 못 잡으면 포기")과 `idle_in_transaction_session_timeout`(전역으로 "트랜잭션 열어 놓고 노는 세션은 끊는다")이다.

> **MySQL 대조:** InnoDB는 **스캔한 행 전부**에 X 락을 걸고, 기본 REPEATABLE READ에서는 **넥스트 키 락**으로 인덱스 범위의 "사이"까지 잠근다 → 그 구간에 들어오는 INSERT까지 대기한다([12번 문서](./12-gap-lock-next-key-lock-deadlock.md)). `created_at`에 인덱스가 없어 풀스캔이면 사실상 테이블 락이다. PostgreSQL에는 이 경로가 없는 대신, "긴 `ROW EXCLUSIVE` 뒤에 선 `ACCESS EXCLUSIVE`가 SELECT까지 세우는" 경로가 있다.

### 1-3. 사슬 C — WAL · 복제: 커밋을 기다리지 않고 흘러간다

용어부터. **WAL**(Write-Ahead Log, 미리 쓰는 로그)은 "데이터 파일을 바꾸기 전에 무엇을 바꿀지부터 적어 두는" 변경 기록이다. 이걸 먼저 디스크에 안전하게 적어 두면 갑자기 정전이 나도 재부팅 후 그 기록을 다시 재생해 복구할 수 있다.

MySQL에는 복구용 리두 로그와 복제용 binlog가 따로 있지만, PostgreSQL에는 **WAL 하나**뿐이고 이것이 크래시 복구·스트리밍 복제·PITR(시점 복구)·논리 디코딩을 전부 담당한다. 이 "하나"라는 성질이 대량 삭제에서 정반대 두 방향으로 작용한다.

> ⑴ **WAL 총량이 튄다.** DELETE 한 행이 남기는 WAL 레코드 자체는 작다(튜플 헤더 변경 몇 바이트). 그런데 **`full_page_writes`** 때문에 총량이 부푼다. 이것은 "체크포인트(데이터 파일을 디스크와 동기화하는 시점) 이후 처음 만지는 페이지는 그 8KB 전체를 WAL에 통째로 실어 둔다"는 설정이다. 페이지를 디스크에 쓰는 도중 정전이 나면 페이지가 반만 쓰인 채 깨질 수 있는데, 그때 온전한 사본으로 되돌리기 위한 보험이다. 2억 행이 수백만 페이지에 흩어져 있으면 그 페이지마다 8KB가 실려 **WAL이 수십 GB로 부푼다.**
> ⑵ **WAL은 커밋을 기다리지 않는다.** MySQL의 binlog가 트랜잭션 캐시에 모였다가 커밋 시점에 한 덩어리로 나가는 것과 달리, PostgreSQL의 WAL은 **생성되는 대로** 흘러가고 standby(대기 서버)는 받는 즉시 재생한다. 변경이 standby의 쿼리에 **보이는 것**만 커밋 레코드를 재생한 이후다. 좋은 소식은 "커밋 순간 수 GB 덩어리가 복제본을 막는" 양상이 없다는 것이고, 나쁜 소식은 **"프라이머리에서 롤백했으니 복제본은 무사"가 성립하지 않는다**는 것이다 — 복제본은 이미 같은 I/O를 다 지불한 뒤에야 abort 레코드를 재생한다.
> ⑶ **standby 재생은 단일 프로세스다.** 프라이머리가 여러 백엔드로 만든 WAL을 standby의 startup 프로세스 하나가 순서대로 재생하므로, 대량 삭제 구간에서 `replay_lag`이 벌어진다 → 리플리카로 라우팅된 조회가 오래된 데이터를 돌려준다("알림 읽었는데 안 읽음으로 나와요") → 지연 기반 헬스체크가 리플리카를 빼면 그 부하가 프라이머리로 몰린다([23-read-replica-routing-and-lag.md](../03-jpa-orm/23-read-replica-routing-and-lag.md)).
> ⑷ **standby 쿼리 충돌.** 삭제 뒤 VACUUM이 죽은 튜플을 정리한 WAL을 standby가 재생할 때, standby에서 그 튜플을 보고 있는 조회가 있으면 충돌한다. 선택지는 둘 다 대가가 있다 — `max_standby_streaming_delay`만큼 재생을 미루거나(지연↑), 그 쿼리를 취소한다(`ERROR: canceling statement due to conflict with recovery`). `hot_standby_feedback = on`으로 취소를 막으면 standby가 "나 아직 이거 보고 있어요"를 프라이머리에 알리게 되는데, 그러면 **프라이머리의 VACUUM이 standby 쿼리를 기다리게 되어 프라이머리 bloat가 커진다** — 사슬 A로 되돌아온다.
> ⑸ **(가산점 포인트) 진짜 무서운 것은 `pg_wal` 디스크다.** WAL 폭증 + 아카이브 명령이 못 따라감(`pg_stat_archiver.failed_count`) 또는 뒤처진 **복제 슬롯**이 WAL을 붙잡음 → `pg_wal` 디렉토리가 가득 참 → **PANIC으로 서버 정지.** 복제 슬롯이란 "이 복제본이 아직 안 받아 간 WAL은 지우지 마라"고 프라이머리에 걸어 두는 표식이다. 유실을 막아 주는 대신, **그 복제본이 사라져도 표식은 남아 WAL이 무한정 쌓인다.** 대량 삭제 전에 볼 것은 슬롯의 `pg_replication_slots.wal_status`·잔여 바이트와 아카이브 실패 수이고, 방어는 최근 버전의 `max_slot_wal_keep_size`(슬롯이 붙잡을 WAL 상한)와 **버려진 슬롯 정리**다. "복제본 하나 떼어냈는데 슬롯을 안 지워서 한 달 뒤 프라이머리가 죽는" 사고의 원형이 여기다.

> **MySQL 대조:** binlog는 트랜잭션 단위로 **커밋 시점에 한 번에** 기록되고 ROW 포맷이면 삭제 행마다 이벤트가 남아 수 GB 덩어리가 된다 → `max_binlog_cache_size`를 넘으면 **몇 시간 일하고 커밋 직전에 실패**하는 일까지 있다. 복제본은 그 트랜잭션을 단위로 재생하므로 워커 하나가 처음부터 다시 삭제하고 이후 트랜잭션이 전부 그 뒤에 줄 선다. PostgreSQL은 "덩어리"가 없는 대신 "슬롯·아카이브가 밀리면 디스크가 찬다"가 있다.

### 1-4. 사슬 D — 인덱스: 지울 땐 안 건드리고, VACUUM이 몰아서 낸다

여기가 후보자의 반복 공백(**랜덤 vs 순차 I/O 비용 모델**)이 직접 시험되는 지점이고, PostgreSQL에서는 MySQL의 InnoDB와 **비용이 발생하는 시점**이 다르다.

> ⑴ **DELETE 순간에는 인덱스를 전혀 건드리지 않는다.** PostgreSQL의 인덱스 엔트리는 `(키, TID)` 쌍뿐이다. TID는 "몇 번째 페이지의 몇 번째 슬롯"이라는 물리 주소이고, 엔트리 어디에도 `xmin`/`xmax` 같은 **버전 정보가 없다.** 그러니 "이 행은 지워졌다"는 사실을 인덱스에 쓸 자리 자체가 없다. 삭제 직후에도 **모든 인덱스에 그 행의 엔트리가 그대로 남아 있고**, 조회는 인덱스에서 TID를 얻어 힙에 가 본 뒤에야 "죽은 튜플이네" 하고 버린다. 그래서 MySQL의 InnoDB가 "삭제 1건 = 인덱스 N개 각 1건 delete-mark(랜덤 I/O)"를 삭제 시점에 내는 것과 달리, PostgreSQL의 삭제 자체는 힙 페이지만 만지는 비교적 순차적인 작업이다.
> ⑵ **청구서는 VACUUM이 받는다.** VACUUM은 ⓐ 힙을 스캔해 죽은 튜플의 TID를 `maintenance_work_mem` 크기의 목록에 모으고 ⓑ **테이블의 모든 인덱스를 처음부터 끝까지 전수 스캔**하며 그 TID를 가진 엔트리를 지운 뒤 ⓒ 힙에서 튜플을 회수한다. 인덱스를 "찾아서 지우는" 게 아니라 **통째로 읽으며 걸러 내는** 이유는, 인덱스에는 TID로 역인덱스가 없기 때문이다. 인덱스가 3개면 인덱스 3개를 통째로 읽는다.
> ⑶ **죽은 TID가 `maintenance_work_mem`을 넘으면 ⓐ~ⓒ를 여러 라운드 반복한다.** 2억 건이면 라운드가 여러 번 돌고, 그때마다 **인덱스 전수 스캔을 처음부터 다시** 한다. 대량 삭제 대상 테이블의 VACUUM 전에 `maintenance_work_mem`을 세션 단위로 올려야 하는 이유가 이것이다 — 라운드 수를 줄이는 것이 곧 인덱스 전수 스캔 횟수를 줄이는 것이다.
> ⑷ **그러는 동안 shared_buffers가 오염된다.** PostgreSQL은 대량 스캔과 VACUUM에 작은 링 버퍼(전체 캐시 대신 정해진 몇 MB만 돌려 쓰는 방식)를 써서 오염을 어느 정도 제한하지만, 더티 페이지를 밀어내는 쓰기와 체크포인트 부하는 그대로 운영 조회의 p99에 얹힌다.
> ⑸ 삭제로 비워진 인덱스 페이지는 그 인덱스의 재사용 목록으로 갈 뿐 **인덱스 파일이 작아지지는 않는다** → 인덱스 bloat → `REINDEX CONCURRENTLY`(서비스를 세우지 않고 인덱스를 새로 만들어 갈아 끼우는 명령)가 별도로 필요하다.

> **MySQL 대조:** InnoDB는 삭제 시점에 클러스터드 1건 + 세컨더리 N건의 delete-mark를 찍고, 세컨더리는 `member_id` 순이라 같은 3개월치 행이 인덱스 전체에 흩어져 있어 **삭제 순간에** 수억 번의 랜덤 페이지 접근이 난다(change buffer가 일부 미루지만 결국 머지해야 한다). 그리고 커밋 후 purge가 같은 페이지를 다시 방문한다. **PostgreSQL은 그 비용을 삭제 시점이 아니라 VACUUM 시점으로 옮겼을 뿐, 총액을 없앤 게 아니다** — 이 문장이 사슬 D의 핵심이다.

### 1-5. 사슬 E — 다 지워도 디스크는 안 줄어든다 (공간 미반환 · bloat)

> ⑴ 커밋 직후에는 공간이 **0바이트** 회수된다. 죽은 튜플이 그 자리에 그대로 있기 때문이다. "디스크 80% 알람을 잡으려고" 시작했다면 이 시점에 목적 달성은커녕 **더 나빠져 있다**(WAL이 늘었으므로).
> ⑵ VACUUM이 돌고 나면 그 공간은 **Free Space Map**(페이지별 남은 공간을 적어 둔 지도)에 등록돼 **그 테이블의 이후 INSERT/UPDATE가 재사용**한다. 파일 크기는 그대로다. 즉 "앞으로 3개월치가 다시 쌓일 자리"로는 쓸모가 있지만 OS가 보는 디스크 사용량은 1바이트도 안 줄어든다. 예외는 하나 — **파일 끝쪽의 완전히 빈 페이지들**만 잘라 OS에 반환하는데(truncate), 이때 짧은 `ACCESS EXCLUSIVE` 락이 필요해 못 잡으면 그냥 포기한다. 게다가 3개월 전 데이터는 파일 **앞쪽**에 있으므로(오래된 행이 먼저 쌓였다) 이 예외는 거의 발동하지 않는다.
> ⑶ 부분적으로 빈 페이지가 남는다 → 페이지당 유효 행이 줄어 같은 결과를 내는 데 더 많은 페이지 I/O → **"지웠는데 더 느려졌다".**
> ⑷ 완전히 회수하려면 **테이블을 다시 쓰는 수밖에 없다**: `VACUUM FULL`(`ACCESS EXCLUSIVE` + 디스크 일시 2배 + 그동안 읽기도 불가) 또는 **`pg_repack`**(확장. 무중단에 가깝게 재작성하지만 마지막 교체 순간에는 짧은 배타 락이 필요하고 디스크 2배는 같다). 인덱스는 `REINDEX CONCURRENTLY`.
> ⑸ 얼마나 부풀었는지는 `pgstattuple` 확장의 `free_percent`/`dead_tuple_percent`(정확·무거움) 또는 `pgstattuple_approx`(가벼움)로 숫자를 본다. `pg_total_relation_size()`와 `pg_class.reltuples`를 같이 보면 "행당 바이트"가 평소보다 몇 배인지로도 감을 잡는다.

### 1-6. 말하기 훈련 — 뭉뚱그린 표현을 사슬로 교체

| 뭉뚱그린 표현 | 이름 | 사슬로 말하면 |
|---|---|---|
| "오래 걸린다" | **VACUUM 부채 · xmin 고정** | 삭제는 `xmax` 표시뿐 → 커밋 후 2억 죽은 튜플 → autovacuum이 스로틀되며 며칠 → 그동안 bloat·Index Only Scan 퇴화. 도는 동안엔 `backend_xmin`이 **클러스터 전체 VACUUM**을 묶는다 |
| "중간에 죽이면 큰일 난다" | **롤백은 O(1)** | PostgreSQL은 `pg_xact`에 abort 한 항목 → 즉시 끝. 단 이미 쓴 WAL·더티 페이지·멈춘 VACUUM은 환불 없음 → **비용은 다 내고 결과는 0건** |
| "락 걸려서 느려진다" | **대기열 + FK 검사** | 갭 락 없음(대상 행만) → 그러나 긴 `ROW EXCLUSIVE` 뒤 `ACCESS EXCLUSIVE`가 서면 SELECT까지 정지. 자식 FK 컬럼 인덱스가 없으면 부모 1건마다 자식 전체 스캔 |
| "복제본이 밀린다" | **WAL 흐름 + 슬롯** | WAL은 커밋 전부터 흘러가 standby가 실시간 재생(롤백해도 이미 지불) → 단일 startup 프로세스라 `replay_lag`↑ → VACUUM 재생이 standby 쿼리와 충돌 → 슬롯·아카이브가 밀리면 `pg_wal` 풀 → PANIC |
| "인덱스 때문에 느리다" | **인덱스 정리 이연** | 삭제 시점엔 인덱스 무접촉 → VACUUM이 **모든 인덱스 전수 스캔**, 죽은 TID가 `maintenance_work_mem`을 넘으면 라운드 반복 → 인덱스 bloat는 `REINDEX CONCURRENTLY`로만 회수 |
| "지웠는데 용량이 그대로다" | **공간 미반환** | 죽은 튜플 → VACUUM 후에도 FSM 재사용용일 뿐, **파일 끝 빈 페이지만** OS 반환 → 완전 회수는 `VACUUM FULL`/`pg_repack`(=재작성, 디스크 2배·배타 락) |

---

## 2. 접근법 3종과 청크 삭제 루프 — 대가를 양면으로

**표를 보기 전에 "왜 선택지가 이 셋뿐인가"를 먼저 세운다.** 결론부터 외우면 상황이 조금만 달라져도 못 고른다. 1장이 말한 것은 결국 하나다 — **비싼 것은 "삭제"가 아니라 "한 트랜잭션이 크다"는 사실과, "지운 자리를 나중에 청소해야 한다"는 구조**다. 그렇다면 이 비용을 줄이는 방법은 논리적으로 셋밖에 없다.

```text
"2억 행을 없애야 한다"에 대해 할 수 있는 일

  ⑴ 같은 일을 잘게 나눠서 한다
     → 트랜잭션 하나를 작게 만들면 사슬 A~C가 청크 길이로 제한된다.
       총량은 그대로다 — 나눠 낼 뿐이다.                    → ① 청크 삭제

  ⑵ 삭제를 아예 "행을 지우는 일"이 아닌 것으로 바꾼다
     → 지울 행들이 처음부터 별도 파일에 모여 있다면, 그 파일을 통째로
       버리면 된다. 죽은 튜플도 인덱스 정리도 발생하지 않는다.
       "행 2억 개 삭제"가 "테이블 1개 DROP"이 된다.        → ② 파티션 DETACH·DROP

  ⑶ 지울 것을 건드리지 않고, 남길 것만 들고 나온다
     → 90%를 지우는 대신 10%를 새 테이블로 옮기고 원본을 통째로 버린다.
       삭제 I/O를 아예 지불하지 않는다.                     → ③ 복사 후 교체

  이 셋 말고는 없다. "인덱스를 지웠다 다시 만든다", "파티션을 나중에
  도입한다" 같은 변형은 전부 위 셋 중 하나의 세부 사항이다.
```

⑵는 "미리 그렇게 만들어 뒀어야" 성립하고, ⑶은 "남길 게 적어야" 성립한다. 둘 다 안 되면 ⑴만 남는다 — **선택은 취향이 아니라 전제 조건이 결정한다.** 이 순서로 말하면 2-5의 결정 트리가 자연스럽게 따라 나온다.

### 2-1. 한 장 비교표 (인출용)

| | ① 청크 삭제 | ② 파티션 DETACH · DROP | ③ 남길 것만 복사 후 교체 |
|---|---|---|---|
| 사전 조건 | 없음 (PK 범위 seek만 되면) | **미리 선언적 파티셔닝돼 있어야** | 남길 비율이 작고, 복사 중 쓰기 델타를 처리할 수단 |
| 소요 시간 | 길다 (수 시간~며칠) + **VACUUM 시간 별도** | **즉시** (건수 무관) | 남길 데이터 크기에 비례 |
| 사슬 A (VACUUM) | **그대로 전부 지불** + 추격 관리 필요 | 발생 안 함 (파일이 사라진다) | 원본을 안 건드리므로 없음 |
| 사슬 B·C (락·WAL) | 청크마다 짧게 끊김 | DETACH 순간만 (CONCURRENTLY면 배타 락 회피) | 복사 트랜잭션에서 발생 → 복사도 청크로 |
| 사슬 D (인덱스 정리) | VACUUM이 전수 스캔으로 지불 | 없음 | 없음 (새 인덱스는 정렬 빌드) |
| 사슬 E (공간) | 미반환 (`VACUUM FULL`/`pg_repack` 별도) | 즉시 반환 | 완전 반환 + bloat 0 |
| 되돌리기 | 청크 단위 (이미 지운 건 아카이브에서) | DETACH까지면 **ATTACH로 복귀 가능**, DROP 후엔 백업뿐 | old 테이블이 살아 있는 동안 RENAME 되돌리면 즉시 |
| 지불하는 것 | 총 I/O 최대 · VACUUM 부채 · 중간 상태 노출 · 스로틀 운영 | PK/유니크에 파티션 키 · 프루닝 조건 · 파티션 수 관리 | 쓰기 델타 · 디스크 2배 · FK/뷰 재연결 · 시퀀스 이관 |
| 언제 | 파티션 없는 기존 테이블, 지금 당장 | 처음부터 보존 정책이 있는 시계열 테이블 | 지울 게 남길 것보다 훨씬 많을 때 |

표는 인출용이고, 면접에서 점수가 나는 건 각 칸의 **"왜"**다. 아래에서 한 접근법마다 얻는 것과 지불하는 것을 같은 호흡에 적는다.

### 2-2. 청크 삭제 — PK 범위로 잘라 짧은 트랜잭션 수천 개로

아이디어는 하나다. **1장의 사슬 A~C는 모두 "트랜잭션 하나가 크다"에서 출발하므로, 트랜잭션을 작게 여러 개로 쪼개면 각각 짧게 끊긴다.** `backend_xmin`이 청크마다 풀려 VACUUM이 따라올 수 있고, 락은 수백 ms만 유지되고, WAL도 고르게 흘러가 복제본이 실시간으로 따라온다.

단, "어떻게 자르느냐"가 성패를 가른다. 그리고 **PostgreSQL의 `DELETE`에는 `LIMIT` 절이 없다** — MySQL식 `DELETE ... LIMIT 5000`을 그대로 옮길 수 없으니 관용구를 알아야 한다.

```sql
-- before — 나쁜 청크: 서브쿼리 LIMIT으로 흉내 내기.
--   매번 인덱스 앞쪽부터 다시 스캔한다. 방금 지운 행의 인덱스 엔트리는
--   VACUUM 전까지 그대로 남아 있어(사슬 D-⑴) 다음 청크가 그 유령 엔트리들을
--   건너뛰며 시작한다 — 갈수록 느려진다.
--   (PostgreSQL은 두 번째 스캔부터 엔트리에 'killed' 힌트를 찍어 힙까지는 안 가지만,
--    엔트리를 훑는 비용 자체는 그대로다.)
DELETE FROM episode_view_log
 WHERE id IN (SELECT id FROM episode_view_log
               WHERE created_at < '2026-06-01' LIMIT 5000);

-- after — 좋은 청크: 경계를 먼저 고정하고, PK 범위로 인덱스를 seek한다.
SELECT max(id) FROM episode_view_log WHERE created_at < '2026-06-01';  -- 상한 1회 계산
-- 루프 본문: (last_id, last_id + 5000] 구간만
DELETE FROM episode_view_log
 WHERE id > $1 AND id <= $2
   AND created_at < $3;   -- 안전벨트: PK가 시간 순이 아닌 행이 섞여 있어도 오삭제 방지
```

PK 범위가 성립하려면 **PK가 시간에 따라 단조 증가**해야 한다(`bigint GENERATED ALWAYS AS IDENTITY`, Snowflake/TSID, UUID v7). 그러면 "특정 기간"이 곧 "PK의 연속 구간"이고, 각 청크는 PK 인덱스의 인접한 리프 구간이다. PK가 UUID v4처럼 무작위면 이 구조가 무너지고 `(created_at, id)` 인덱스로 키셋 탐색을 해야 한다 — PostgreSQL은 인덱스가 힙을 TID로 가리키므로 매 청크마다 **인덱스 → 힙 랜덤 접근** 비용이 붙는다([13-deep-pagination-offset-vs-cursor.md](./13-deep-pagination-offset-vs-cursor.md)의 키셋 패턴을 그대로 쓴다).

**(가산점 포인트) `ctid` 청크** — PK가 아예 없거나 무작위이고 인덱스를 새로 만들 여유도 없다면, 물리 위치인 `ctid`로 자를 수 있다: `DELETE FROM t WHERE ctid = ANY(ARRAY(SELECT ctid FROM t WHERE 조건 LIMIT 5000))`. 힙을 앞에서부터 순차로 훑는 성질이라 유령 엔트리 문제가 없다. 단 `ctid`는 **VACUUM/UPDATE로 변할 수 있는 물리 주소**이므로 한 문장 안에서만 쓰고 애플리케이션이 들고 다니면 안 된다.

**얻는 것**

- 사전 준비가 없다. 파티션이 없는 기존 테이블에 **지금 당장** 적용된다.
- 트랜잭션마다 짧으니 사슬 A~C가 청크 길이로 제한되고, 특히 **`backend_xmin`이 청크마다 풀려 VACUUM이 따라올 수 있다.**
- **멈출 수 있다.** 복제 지연이 오르면 쉬고, 피크 시간엔 안 돌고, 킬 스위치로 즉시 세운다. 한 방 DELETE에는 없는 성질이다.

**지불하는 것 (반드시 같이 말할 것)**

- **총 시간이 길다.** 얼마나 긴지는 곱셈으로 나온다. 2억 건을 5,000건 청크로 나누면 `200,000,000 ÷ 5,000 = 40,000`번 반복이고, 청크 하나가 실행 200ms + 휴식 100ms = 0.3초라면 `40,000 × 0.3초 = 12,000초 ≈ 3시간 20분`이다. **여기서 흔한 오해를 정정한다 — 순수 루프 시간만으로는 "며칠"이 되지 않는다.** 며칠이 되는 것은 다른 이유들 때문이다: ⓐ 피크 시간을 피해 **야간 창(예: 02:00~05:00, 하루 3시간)에만 돌리면** 3시간 20분짜리 작업이 이틀 밤에 걸친다 ⓑ 게이트에 걸려 백오프하는 시간이 붙는다 ⓒ 행이 크거나 인덱스가 많아 청크 하나가 1초씩 걸리면 `40,000 × 1.1초 ≈ 12시간`으로 바로 네 배가 된다. 어느 쪽이든 그동안 운영 부하가 "약하게, 오래" 걸린다.
- **총 I/O는 오히려 최대다.** 사슬 D(VACUUM의 인덱스 전수 스캔)는 청크로 나눠도 한 건도 안 줄어든다 — 나눠서 지불할 뿐 총액은 같다. 오히려 라운드가 늘어 조금 더 든다.
- **VACUUM 추격을 관리해야 한다(PostgreSQL 고유).** 청크가 죽은 튜플을 만드는 속도가 autovacuum이 치우는 속도보다 빠르면 bloat가 계속 자란다. 그래서 대상 테이블에 임계를 낮춰 두고(`ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.01)`), 루프의 게이트에 **`n_dead_tup` 증가율**을 넣고, 전체 종료 후 `VACUUM (ANALYZE)`를 명시적으로 한 번 돌린다.
- **공간은 그대로 안 돌아온다**(사슬 E). 디스크 회수가 목적이면 청크 삭제만으로는 끝나지 않는다.
- **중간 상태가 노출된다.** 삭제 중에는 "3개월 전 로그가 절반만 남은" 상태가 조회된다. 그 기간 집계·통계 배치는 어긋난 숫자를 낸다 → 삭제 창을 공지하거나 집계를 아카이브 쪽으로 돌려야 한다.
- **운영이 필요하다.** 청크 크기·sleep·임계값을 측정하고 조정하는 사람과 코드가 필요하다(2-6 이후). "스크립트 하나 돌려놓고 퇴근"이 안 된다.
- 같은 범위를 갱신하는 트랜잭션과 **데드락**이 날 수 있어 청크 단위 재시도가 필요하고(`40P01`), 대량 삭제 후 **통계가 낡아** 다른 쿼리의 실행 계획이 흔들릴 수 있다(`ANALYZE` 필수 — `VACUUM (ANALYZE)`로 함께).
- **행 트리거가 있으면 2억 번 실행된다.** 감사 로그 트리거가 걸린 테이블은 삭제가 몇 배로 비싸진다. 확인하고 가야 하고, 우회(`session_replication_role = replica`)는 슈퍼유저 권한 + 정합성 리스크라 기본 선택지가 아니다.

### 2-3. 파티션 DETACH · DROP — 삭제를 DML이 아니라 "테이블 떼어내기"로 바꾼다

용어부터. **파티셔닝**은 논리적으로 한 테이블인 것을 물리적으로 여러 테이블(파티션)로 쪼개 저장하는 구조다. PostgreSQL 10부터의 **선언적 파티셔닝**에서는 부모 테이블이 데이터를 갖지 않는 **라우팅 테이블**이 되고, 실제 행은 파티션 키 값에 따라 자식 테이블 파일에 들어간다. 그러면 "8월 데이터"는 곧 "8월 파티션 파일"이므로, 삭제가 **DML이 아니라 DDL**이 된다.

```sql
-- 선언적 파티셔닝 (PG 10+): 부모는 데이터를 갖지 않는 라우팅 테이블이다
CREATE SEQUENCE episode_view_log_id_seq AS bigint;

CREATE TABLE episode_view_log (
  id         bigint      NOT NULL DEFAULT nextval('episode_view_log_id_seq'),
  member_id  bigint      NOT NULL,
  episode_id bigint      NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (id, created_at)          -- ※ 파티션 키가 PK에 들어가야 한다 (아래 대가 2)
) PARTITION BY RANGE (created_at);

CREATE TABLE episode_view_log_2026_08 PARTITION OF episode_view_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE episode_view_log_2026_09 PARTITION OF episode_view_log
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- 부모에 인덱스를 만들면 모든 파티션에 로컬 인덱스가 자동 생성된다
CREATE INDEX ON episode_view_log (member_id, created_at);

-- 3개월 보존: 지난 달 파티션을 통째로
-- ① 잠금을 피하며 떼어낸다 (PG 14+). 트랜잭션 블록 안에서는 실행 불가.
ALTER TABLE episode_view_log DETACH PARTITION episode_view_log_2026_05 CONCURRENTLY;
-- ② 떼어낸 뒤에는 평범한 독립 테이블 — 여기서 아카이브(COPY/pg_dump)한다.
-- ③ 버린다. 건수와 무관하게 즉시, 공간도 즉시 반환.
DROP TABLE episode_view_log_2026_05;
```

**얻는 것**

- 수천만 건이든 수억 건이든 **즉시** 끝난다. 행을 하나씩 지우는 게 아니라 파티션이라는 **별도 파일을 버리는 것**이라 죽은 튜플도, VACUUM 부채도, 인덱스 정리도 없다(사슬 A·D 소멸). `DROP TABLE`이 하는 일은 카탈로그에서 항목을 지우고 파일을 unlink하는 것뿐이라, 2억 건이든 20건이든 같은 시간이 걸린다.
- **공간이 즉시 반환된다**(사슬 E 소멸). 파티션이 곧 별도 relation, 즉 별도 파일이라서.
- WAL에도 카탈로그 변경 몇 줄만 남으므로 복제 지연이 없다(사슬 C 소멸).
- **`DETACH`와 `DROP`을 분리할 수 있다(PostgreSQL의 이점).** 떼어낸 파티션은 평범한 테이블이 되므로 그 상태에서 아카이브하고, 검증하고, 며칠 두었다가 버린다. 잘못 뗐으면 `ATTACH PARTITION`으로 되돌릴 수 있다 — MySQL의 `DROP PARTITION`이 "즉시 소멸"인 것과 다른, **되돌릴 수 있는 중간 상태**다.
- **`DETACH PARTITION CONCURRENTLY`(PG 14+)** 는 `ACCESS EXCLUSIVE` 대신 약한 잠금으로 두 단계에 나눠 처리해, 사슬 B의 "대기열이 SELECT까지 세우는" 사고를 피한다.

**지불하는 것 (여기가 이 문항의 시니어 변별 지점)**

1. **사전에 파티셔닝돼 있어야 한다.** 이미 수억 건 쌓인 일반 테이블을 파티션 테이블로 바꾸는 것은 **전체 재작성**이다 → 14번 문서의 잠금·디스크 사슬이 그대로 온다. 즉 파티션 DROP은 "이번 삭제"의 답이 아니라 **"다음 삭제"를 위한 투자**다. 도입 경로는 둘 — 2-4처럼 새 파티션 테이블로 복사 후 교체하거나, 새 파티션 테이블에 신규 쓰기를 돌리고 구 테이블은 청크 삭제로 자연 소멸시킨다(둘을 `UNION ALL` 뷰로 덮어 전환기를 견디는 변형도 있다).
2. **파티션 키가 PK와 모든 유니크 제약에 포함돼야 한다.** PostgreSQL도 MySQL과 같은 규칙이고 이유도 같다 — **글로벌 인덱스가 없어**(모든 파티션을 한 덩어리로 훑는 인덱스가 없어) 유니크 검사가 파티션 로컬로만 이뤄지기 때문이다. `id`만으로 유일성을 보려면 모든 파티션의 인덱스를 다 봐야 하는데, PostgreSQL은 그 비용 대신 제약을 택했다. 그래서 `PRIMARY KEY (id)`였다면 `(id, created_at)`이 되고, 그 결과 (a) `id` 단독의 유일성을 **DB가 더 이상 보장하지 않는다** — 채번기가 보장해야 한다 (b) `UNIQUE (member_id, episode_id)` 같은 업무 유니크가 필요하면 거기에도 `created_at`을 넣어야 하는데, 그 순간 업무 규칙("한 회원이 한 에피소드에 한 번")이 표현 불가능해진다 → 사실상 **업무 유니크 제약이 필요한 테이블은 파티셔닝에 부적합**하다 (c) JPA 엔티티의 `@Id`가 복합키(`@IdClass`/`@EmbeddedId`)가 된다.
   *(PostgreSQL에서는 MySQL의 InnoDB와 달리 세컨더리 인덱스 리프에 PK가 복제되지 않으므로, "PK가 길어져 모든 인덱스가 커진다"는 InnoDB식 대가는 없다 — 대신 위 (a)(b)(c)는 그대로다.)*
3. **조회에 파티션 키 조건이 없으면 모든 파티션을 뒤진다.** `WHERE id = ?`만으로는 어느 파티션인지 모르므로 **파티션 수만큼 인덱스 seek**를 한다. `WHERE created_at >= ? AND created_at < ? AND id = ?`처럼 **파티션 프루닝**(pruning: 조건으로 볼 필요 없는 파티션을 미리 잘라 내는 것) 조건이 붙어야 한다 → 조회 API의 계약이 바뀐다("기간은 필수"). 확인은 `EXPLAIN` — 프루닝된 파티션은 계획에 **아예 나타나지 않고**, 실행 시점 프루닝(파라미터가 실행 때 정해지는 경우)은 `(never executed)`로 찍힌다.
4. **파티션 수 자체가 비용이다.** 계획 단계에서 모든 파티션의 메타데이터를 보고 각각에 잠금을 잡으므로, 수천 개가 되면 **계획 시간과 잠금 획득 비용이 눈에 띄게 늘고** `max_locks_per_transaction` 한도에도 걸린다. 그래서 파티션 단위(일/주/월)는 보존 정책의 세밀함과 파티션 수 사이에서 정한다. 로그성 테이블에 "일 단위 파티션 × 3년"(약 1,095개)은 대개 과하다.
5. **파티션은 유한하다.** RANGE 파티션에서 다음 달 파티션이 없으면 그달 첫 INSERT가 **실패**한다(`no partition of relation ... found for row`). `DEFAULT` 파티션을 두면 실패는 없지만, 거기 쌓인 데이터를 나중에 정규 파티션으로 옮기려 할 때 **`ATTACH`가 DEFAULT 파티션 전체를 스캔해 "겹치는 행이 없음"을 검증**하느라 그 순간이 오히려 무거워진다. 어느 쪽이든 **자동 생성 스케줄러 + "미래 파티션이 N개 이상 존재" 알람**이 필수다(3-5).
6. **`ATTACH`에는 검증 스캔이 붙는다.** 기존 테이블을 파티션으로 붙일 때 PostgreSQL은 그 테이블 전체를 훑어 파티션 경계를 지키는지 확인한다. 미리 같은 조건의 `CHECK` 제약을 만들어 두면 이 스캔을 생략시킬 수 있다 — 대량 데이터를 붙일 때 반드시 쓰는 요령이다.
7. **`DETACH ... CONCURRENTLY`에도 제약이 있다.** 트랜잭션 블록 안에서 실행할 수 없고(마이그레이션 도구에서 트랜잭션 밖으로 빼야 한다), 진행 중인 트랜잭션이 끝나기를 기다리며, 도중에 실패하면 파티션이 "분리 진행 중" 상태로 남아 `ALTER TABLE ... DETACH PARTITION FINALIZE`로 마무리해야 한다.
8. **삭제 단위가 파티션으로 굳는다.** "5월 데이터 중 탈퇴 회원 것만"은 여전히 DML이다. 그리고 파티션별 인덱스를 무중단으로 만들려면 `CREATE INDEX CONCURRENTLY`를 **파티션마다** 돌린 뒤 부모의 인덱스에 `ALTER INDEX ... ATTACH PARTITION`으로 붙이는 절차를 알아야 한다(부모에 바로 만드는 `CREATE INDEX`는 `CONCURRENTLY`를 못 쓴다). 백업·통계 수집도 파티션 단위 운영 지식을 요구한다.

> **MySQL 대조:** ① MySQL은 파티션 테이블에 **FK를 아예 못 쓴다**(정의도, 참조되는 것도 불가). **PostgreSQL은 파티션 테이블에도 FK를 걸 수 있고 참조될 수도 있다**(최근 버전) — 파티셔닝 도입의 가장 큰 장벽 하나가 PostgreSQL에는 없다. ② MySQL은 `ALTER TABLE ... DROP PARTITION`으로 즉시 소멸이고 되돌릴 수 없지만, PostgreSQL은 `DETACH` → (아카이브·검증·유예) → `DROP`으로 **중간 상태를 둘 수 있다.** ③ MySQL의 `DROP PARTITION`은 배타 MDL을 잡아 그 테이블을 읽는 긴 트랜잭션이 있으면 전면 대기가 되지만, PostgreSQL은 `DETACH ... CONCURRENTLY`로 그 구간을 회피할 수 있다.

정리하면 파티션 DROP은 **"삭제가 설계의 일부일 때"** 최강이고, **"삭제가 나중에 생각난 요구일 때"** 가장 비싸다. 그래서 3-6절의 "보존 정책을 설계 시점에"가 이 접근법의 전제 조건이다.

### 2-4. 남길 것만 새 테이블로 복사한 뒤 교체 — 삭제 대신 "재작성"

```sql
-- 1) 같은 구조의 빈 테이블 (이 기회에 파티셔닝을 함께 도입할 수 있다)
CREATE TABLE episode_view_log_new (LIKE episode_view_log INCLUDING ALL);

-- 2) 남길 행만 복사 — 이것도 한 방이 아니라 PK 범위 청크로
--    (INSERT ... SELECT 한 방 = 거대 트랜잭션 → 사슬 A·C 그대로)
INSERT INTO episode_view_log_new
SELECT * FROM episode_view_log
 WHERE id > $1 AND id <= $2 AND created_at >= '2026-06-01';

-- 3) 복사 시작 이후 들어온 쓰기(델타)를 따라잡은 뒤 원자적 교체
--    ※ PostgreSQL은 DDL이 트랜잭션에 포함되므로 RENAME 둘을 한 트랜잭션에 묶을 수 있다.
BEGIN;
  SET LOCAL lock_timeout = '3s';                     -- 대기열을 만들지 않는다
  ALTER TABLE episode_view_log     RENAME TO episode_view_log_old;
  ALTER TABLE episode_view_log_new RENAME TO episode_view_log;
  SELECT setval('episode_view_log_id_seq',           -- 시퀀스는 따라오지 않는다
                (SELECT max(id) FROM episode_view_log));
COMMIT;

-- 4) 며칠 관찰 후
DROP TABLE episode_view_log_old;   -- 공간 즉시 반환
```

**얻는 것**

- 삭제 I/O를 **아예 지불하지 않는다.** 지울 90%를 건드리지 않고 남길 10%만 옮긴다. 죽은 튜플이 생기지 않으니 **VACUUM 부채도 0**이고, 새 테이블의 인덱스는 흩어진 정리 작업이 아니라 **정렬 빌드**(행을 다 넣은 뒤 정렬해 한 번에 쌓는 방식)로 만들어져 훨씬 싸다.
- **공간이 완전히 회수되고 bloat가 0이 된다.** `VACUUM FULL`을 한 것과 같은 효과를 삭제와 동시에 얻는다.
- **교체가 원자적이다.** PostgreSQL은 `RENAME TABLE a TO b, c TO d` 같은 다중 RENAME 문법이 없는 대신 **DDL이 트랜잭션에 포함되므로** 위처럼 `BEGIN ... COMMIT`으로 묶으면 같은 효과다. 커밋 순간 앱은 끊김 없이 새 테이블을 본다. old 테이블을 며칠 두면 **되돌리기도 RENAME 한 번**이다. (이 "DDL을 롤백할 수 있다"는 성질 자체가 MySQL과의 대표적 차이다.)

**지불하는 것**

- **복사 시작 이후의 쓰기 델타.** 복사가 3시간 걸리면 그 3시간 동안 원본에 들어온 INSERT/UPDATE는 새 테이블에 없다. 해법은 셋이다 — 쓰기를 멈추는 **점검 창**을 잡거나, 트리거로 델타를 새 테이블에 이중 기록하거나, **논리 복제**(`PUBLICATION`/`SUBSCRIPTION` — WAL을 행 단위 변경으로 디코딩해 다른 테이블로 흘려보내는 기능)로 원본을 새 테이블에 따라붙게 한다. 세 번째가 PostgreSQL의 정석에 가깝지만 설정·모니터링 부담이 있고, "남길 행만"을 표현하려면 퍼블리케이션 행 필터가 필요하다. 이게 이 접근법의 가장 큰 대가다.
- **디스크가 일시적으로 2배**(원본 + 새 테이블 + old 보관 기간).
- **이름이 아니라 OID로 묶인 것들이 따라오지 않는다.** PostgreSQL에서 FK·뷰는 테이블 **이름이 아니라 OID**(카탈로그의 객체 고유 번호)로 연결되므로, RENAME해도 자식 테이블의 FK와 기존 뷰는 **여전히 `_old` 테이블을 가리킨다.** 자식 FK를 재정의하고(`NOT VALID`로 먼저 걸고 나중에 `VALIDATE`해서 잠금 시간을 줄인다), 뷰를 다시 만들고, 권한(GRANT)과 RLS 정책·트리거·기본값 시퀀스 소유권까지 새 테이블에 다시 건다. 체크리스트로 만들지 않으면 반드시 하나 빠뜨린다.
- **시퀀스가 따라오지 않는다.** `LIKE ... INCLUDING ALL`은 기본값 표현식을 복사할 뿐이므로, 교체 트랜잭션 안에서 `setval()`로 맞춘다. 안 하면 교체 직후 첫 INSERT가 PK 중복(`23505`)으로 죽는다.
- 남길 비율이 크면(예: 절반) 복사 비용이 삭제 비용을 넘어 손해다.
- RENAME은 `ACCESS EXCLUSIVE`다 — 짧지만, 긴 트랜잭션이 있으면 대기열을 만들어 사슬 B가 발동한다. 위 예시처럼 **`lock_timeout` + 재시도**가 필수다.

### 2-5. 선택 기준 — 결정 순서로 말하기

1. **이미 파티셔닝돼 있는가?** → 파티션 DETACH·DROP. 다른 선택지는 볼 필요가 없다.
2. **지울 비율이 압도적(대략 80~90% 이상)이고, 점검 창이나 델타 처리 수단이 있는가?** → 복사 후 교체. 이 기회에 파티셔닝을 함께 도입한다.
3. **그 외** → 청크 삭제로 지금의 문제를 풀고, **동시에** 파티셔닝 도입 계획을 세운다. 청크 삭제는 "이번"의 답이고 파티션은 "다음"의 답이다.
4. **어느 쪽이든 "디스크를 되찾는 것"이 목적이면 한 단계가 더 있다** — 청크 삭제는 공간을 안 돌려주므로 `pg_repack`(또는 점검 창의 `VACUUM FULL`)과 `REINDEX CONCURRENTLY`를 같은 티켓에 넣는다.

(가산점 포인트) 도구도 알아 둔다. PostgreSQL에서는 **`pg_partman`**(파티션 자동 생성·보존 기간 만료 처리)과 **`pg_cron`**(DB 안에서 도는 스케줄러) 조합이 3-5절 스케줄러를 상당 부분 대체하고, 재작성은 **`pg_repack`**이 맡는다. "도구가 있다는 것을 알고, 그래도 직접 짤 때는 같은 요소를 빠뜨리지 않는다"가 시니어의 태도다.

> **MySQL 대조:** MySQL 쪽의 대응 도구는 **pt-archiver**(Percona Toolkit)로, PK 기준 청크로 다른 테이블/파일에 옮기고 지우며 `--check-slave-lag`, `--sleep`, `--txn-size` 같은 옵션으로 아래 2-6의 필수 요소를 검증된 형태로 제공한다. PostgreSQL에는 이만큼 표준화된 아카이빙 CLI가 없어 **직접 짜거나 `pg_partman`의 보존 기능에 얹는 쪽**이 일반적이다 — 그래서 아래 루프를 스스로 조립할 수 있어야 한다.

### 2-6. 청크 삭제 루프 — 필수 요소 9가지 (인출용 목록)

1. **경계 고정** — 시작 전에 `max(id)`로 상한을 한 번 계산해 "움직이는 목표"를 없앤다. 매 청크마다 `now()`로 계산하면 시간이 흐르는 만큼 삭제 대상이 계속 늘어나 끝나지 않는다.
2. **PK 범위 커서** — `id > last AND id <= last + N`. 서브쿼리 `LIMIT`가 아니다(2-2).
3. **청크 크기** — 트랜잭션 하나가 수백 ms 안에 끝나도록. 1,000~10,000에서 시작해 **측정 후** 결정한다. 정답 숫자는 없고 측정만 있다.
4. **청크 간 sleep + 적응형 스로틀** — 청크가 느려지면 크기를 줄이고 휴식을 늘린다. autovacuum·체크포인터·복제본이 따라올 시간을 준다.
5. **복제 지연 게이트** — 임계 초과면 대기, 일정 시간 넘게 초과면 중단. 사람이 알람을 보고 멈추는 게 아니라 루프가 스스로 멈춘다.
6. **DB 부하 게이트 + VACUUM 추격 게이트(PostgreSQL 고유)** — 활성 백엔드 수, 락 대기, 커넥션 풀 사용률에 더해 **`n_dead_tup`이 임계를 넘으면 쉰다.** 죽은 튜플을 만드는 속도가 치우는 속도를 넘으면 bloat가 자란다는 신호다.
7. **진행 위치 영속화 + 멱등** — 마지막 `id`를 삭제와 **같은 트랜잭션**에 기록한다. 프로세스가 언제 죽어도 그 지점부터 재개되고, 같은 범위를 두 번 지워도 무해하다.
8. **킬 스위치 + 실행 시간 창** — 파일/플래그/설정값 하나로 즉시 정지, 피크 시간에는 자동으로 안 돈다.
9. **관측** — 청크당 소요·삭제 건수·현재 지연·`n_dead_tup`을 메트릭과 로그로 남기고, 이상치(청크 시간 급증, 삭제 0건 연속)에 알람을 건다.

여기에 **0번: 삭제 전 아카이브 검증**(3-2)이 앞에 붙고, **10번: 종료 후 `VACUUM (ANALYZE)`와 필요하면 `REINDEX CONCURRENTLY`**가 뒤에 붙는다. 이 열두 가지 중 하나라도 빠진 "청크 삭제"는 한 방 DELETE를 여러 번으로 늘려 놓은 것에 불과하다.

### 2-7. before — `@Scheduled` + 한 방 (그리고 더 나쁜 파생 삭제 메서드)

```java
@Component
@RequiredArgsConstructor
public class ViewLogCleanupScheduler {

    private final EpisodeViewLogRepository repository;

    @Scheduled(cron = "0 0 4 * * *")
    @Transactional                                   // ← 2억 행이 한 트랜잭션
    public void purgeOld() {
        OffsetDateTime cutoff = OffsetDateTime.now().minusMonths(3);

        // 함정 1: Spring Data JPA의 파생 삭제 메서드(deleteBy...)는 벌크 DELETE가 아니다.
        //   엔티티를 전부 SELECT해서 영속성 컨텍스트에 올린 뒤 건별 em.remove() → 건별 DELETE.
        //   2억 엔티티 적재(OOM) + DELETE 2억 번 + 그래도 한 트랜잭션.
        repository.deleteByCreatedAtBefore(cutoff);

        // 함정 2: 그래서 @Modifying @Query("delete ... where e.createdAt < :cutoff") 로 바꾸면?
        //   영속성 컨텍스트는 우회하지만(bulk-operation 문서), DB 입장에선 여전히
        //   1장의 한 방 DELETE 그대로다. 사슬 A~E 전부 발생 —
        //   특히 이 트랜잭션이 열려 있는 내내 backend_xmin이 고정돼
        //   "무관한 테이블의 VACUUM까지" 멈춘다.
    }
}
```

두 함정의 공통점은 **"몇 건이 지워지는가"를 코드가 모른다**는 것이다. 안전한 삭제 코드는 자기가 지금 몇 건을 지우고 있고 DB가 그걸 감당하는지를 매 순간 안다.

### 2-8. after ① — 스케줄러 + `TransactionTemplate` + `JdbcTemplate`: 청크마다 커밋

```java
@Component
@RequiredArgsConstructor
public class ViewLogChunkPurger {

    private static final Logger log = LoggerFactory.getLogger(ViewLogChunkPurger.class);
    private static final String TABLE = "episode_view_log";

    private final JdbcTemplate jdbc;                 // 프라이머리 DataSource (pgjdbc + HikariCP)
    private final TransactionTemplate tx;            // 청크 하나 = 트랜잭션 하나
    private final ReplicationLagProbe lagProbe;      // 리플리카 지연 측정 (2-10)
    private final PurgeProgressRepository progress;  // 진행 위치 영속화 (별도 테이블)
    private final ArchiveVerifier archiveVerifier;   // 삭제 허가 범위 (3-2)
    private final PurgeProperties props;             // chunkSize, sleep, lagThreshold, window, killSwitch...
    private final MeterRegistry meters;

    // ※ 이 메서드에 @Transactional을 붙이지 않는다.
    //   붙이는 순간 안의 TransactionTemplate(기본 REQUIRED)이 그 트랜잭션에 참여해
    //   루프 전체가 다시 "한 방"이 된다. PostgreSQL에서는 그 순간 backend_xmin도 루프 내내
    //   고정돼 VACUUM이 클러스터 전체에서 멈춘다. 실제로 자주 나는 실수다.
    @Scheduled(cron = "0 0 2 * * *")                 // 8. off-peak 시작
    public void run() {
        OffsetDateTime cutoff = LocalDate.now().minusMonths(props.retentionMonths())
                                         .atStartOfDay().atOffset(ZoneOffset.UTC);

        // 1. 경계 고정 — 오늘 밤 지울 상한 PK를 한 번만 계산한다.
        //    루프 안에서 매번 계산하면 그사이 흐른 시간만큼 대상이 늘어 끝나지 않는다.
        Long maxId = jdbc.queryForObject(
            "SELECT max(id) FROM " + TABLE + " WHERE created_at < ?", Long.class, cutoff);
        if (maxId == null) return;

        // 0. 아카이브가 "검증까지" 끝난 범위까지만 지운다.
        //    삭제는 되돌릴 수 없으므로, 되돌릴 수 있는 사본이 확인된 지점이 곧 삭제 허가선이다.
        long verifiedUntil = archiveVerifier.verifiedUntilId(TABLE);
        maxId = Math.min(maxId, verifiedUntil);

        // 7. 재개 — 어젯밤 시간 창에 걸려 멈췄다면 그 지점부터 이어서 시작한다.
        long lastId = progress.lastDeletedId(TABLE).orElse(0L);
        int chunk = props.chunkSize();

        while (lastId < maxId) {
            // 8. 킬 스위치 + 시간 창.
            //    진행 위치는 청크마다 커밋돼 있으므로 여기서는 그냥 return 해도 안전하다.
            if (props.killSwitchOn() || !props.window().contains(LocalTime.now())) {
                log.warn("[purge] paused at id={}", lastId);
                return;
            }
            // 5. 복제 지연 게이트.
            //    왜 재는가: 삭제가 만든 WAL을 standby는 단일 프로세스로 순서대로 재생하므로(사슬 C-⑶),
            //    내가 만드는 WAL 속도가 재생 속도를 넘으면 리플리카가 뒤처지고
            //    리플리카로 라우팅된 조회가 오래된 데이터를 돌려주기 시작한다.
            //    즉 이 숫자는 "내 배치가 사용자 눈에 보이는 데이터를 얼마나 낡게 만들고 있나"의 지표다.
            if (!lagProbe.waitUntilBelow(props.lagThresholdSec(), props.lagWaitMax())) {
                log.error("[purge] replica lag stayed above {}s — aborting today", props.lagThresholdSec());
                meters.counter("purge.aborted", "reason", "replica_lag").increment();
                return;
            }
            // 6. DB 부하 + VACUUM 추격 게이트.
            //    n_dead_tup 이 계속 오른다 = 내가 시체를 만드는 속도 > autovacuum 이 치우는 속도.
            //    이 상태로 계속 밀면 삭제는 진행되는데 테이블은 오히려 부푼다.
            if (dbBusy() || deadTuplesTooHigh()) { sleepQuietly(props.backoff()); continue; }

            final long from = lastId;
            final long to   = Math.min(lastId + chunk, maxId);

            long started = System.nanoTime();
            // 2. PK 범위 청크 = 짧은 트랜잭션 하나.
            //    왜 청크마다 커밋해야 하는가: 커밋해야 backend_xmin 이 풀리고,
            //    그래야 이 청크가 만든 죽은 튜플을 autovacuum 이 치우기 시작할 수 있다.
            //    커밋하지 않고 루프를 도는 것은 "쪼갠 척하는 한 방"일 뿐이다.
            //    진행 위치 갱신도 같은 트랜잭션에 넣어 둘을 원자적으로 묶는다 (7).
            int deleted = tx.execute(status -> {
                // 락을 못 잡으면 기다리지 않고 이 청크만 실패시킨다.
                // 기다리면 그 대기 자체가 ACCESS EXCLUSIVE 대기열의 앞사람이 되어
                // 뒤따르는 SELECT 까지 세운다(사슬 B-⑵).
                jdbc.execute("SET LOCAL lock_timeout = '3s'");
                int n = jdbc.update(
                    "DELETE FROM " + TABLE + " WHERE id > ? AND id <= ? AND created_at < ?",
                    from, to, cutoff);
                progress.save(TABLE, to);
                return n;
            });
            long elapsedMs = (System.nanoTime() - started) / 1_000_000;

            // 9. 관측 — 사후 분석이 아니라 "지금 멈춰야 하나"를 사람이 판단할 재료다.
            meters.timer("purge.chunk.duration").record(Duration.ofMillis(elapsedMs));
            meters.counter("purge.rows.deleted").increment(deleted);
            log.info("[purge] ({}, {}] deleted={} in {}ms chunk={} lag={}s dead={}",
                     from, to, deleted, elapsedMs, chunk, lagProbe.current(), deadTuples());

            // 3·4. 적응형 스로틀 — 목표 시간의 2배를 넘으면 반으로, 절반 이하면 두 배로.
            //      "정답 청크 크기"를 사람이 정하는 대신 루프가 측정으로 수렴시킨다.
            chunk  = adapt(chunk, elapsedMs);
            lastId = to;
            // 4. sleep 은 왜 필요한가: 삭제는 커밋으로 끝나지만 뒷정리는 그때부터 시작된다.
            //    autovacuum 이 죽은 튜플을 치우고, 체크포인터가 더티 페이지를 내리고,
            //    standby 가 WAL 을 재생할 시간을 비워 주는 것이 이 휴식의 목적이다.
            //    쉬지 않으면 삭제 속도가 뒷정리 속도를 계속 앞질러 부채만 쌓인다.
            //    ※ 트랜잭션 "밖"에서 잔다 — 안에서 자면 스냅샷을 쥔 채 자는 것이라
            //      idle in transaction 상태가 되어 VACUUM 을 오히려 막는다.
            sleepQuietly(props.sleepBetweenChunks());
        }
        progress.clear(TABLE);

        // 10. 종료 후 정리 — VACUUM 은 트랜잭션 블록 안에서 실행할 수 없다.
        //     (JdbcTemplate 이 트랜잭션 밖에서 부르는 것이므로 여기서는 문제없다)
        //     ANALYZE 를 같이 도는 이유: 2억 건이 사라지면 통계가 낡아
        //     이 테이블을 쓰는 다른 쿼리의 실행 계획이 흔들린다.
        jdbc.execute("VACUUM (ANALYZE, VERBOSE) " + TABLE);
        log.info("[purge] completed up to id={}", maxId);
    }

    private int adapt(int chunk, long elapsedMs) {
        long target = props.targetChunkMs();            // 예: 200ms
        if (elapsedMs > target * 2) return Math.max(chunk / 2, props.minChunk());
        if (elapsedMs < target / 2) return Math.min(chunk * 2, props.maxChunk());
        return chunk;
    }

    /** PostgreSQL은 커넥션 = 프로세스다. 활성 백엔드 수와 락 대기가 곧 부하 지표다. */
    private boolean dbBusy() {
        Integer active = jdbc.queryForObject(
            "SELECT count(*) FROM pg_stat_activity " +
            " WHERE state = 'active' AND backend_type = 'client backend'", Integer.class);
        Integer waiting = jdbc.queryForObject(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'", Integer.class);
        return (active != null && active > props.maxActiveBackends())
            || (waiting != null && waiting > props.maxLockWaiters());
    }

    /** 죽은 튜플이 임계를 넘으면 autovacuum 이 못 따라오고 있다는 뜻 — 쉰다. */
    private boolean deadTuplesTooHigh() { return deadTuples() > props.maxDeadTuples(); }

    private long deadTuples() {
        Long n = jdbc.queryForObject(
            "SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = ?", Long.class, TABLE);
        return n == null ? 0L : n;
    }

    private static void sleepQuietly(Duration d) {
        try { Thread.sleep(d.toMillis()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

코드에서 봐야 할 것 다섯 가지:

- **`run()`에 `@Transactional`이 없다.** 이게 있으면 안의 `TransactionTemplate`이 바깥 트랜잭션에 참여해(전파 속성 기본값이 REQUIRED다) 커밋이 루프 끝까지 미뤄진다 — 청크로 "보이지만" DB에는 한 방이다. PostgreSQL에서는 여기에 더해 `backend_xmin` 고정으로 **클러스터 전체 VACUUM이 루프 내내 멈춘다.** 리뷰에서 가장 먼저 볼 줄이다.
- **sleep은 트랜잭션 밖이다.** `tx.execute` 블록 안에서 자면 락과 스냅샷을 쥔 채 잔다 — 즉 `idle in transaction` 상태로 VACUUM을 막는다. "쉬어 주려고 넣은 sleep이 오히려 VACUUM을 막는" 것이 이 실수의 아이러니다.
- **진행 위치 저장이 DELETE와 같은 트랜잭션이다.** 그래서 "지웠는데 위치 저장 전에 죽음 → 재시작 시 같은 범위 재삭제"가 있어도 0건이 지워질 뿐 무해하고(멱등), "위치는 저장했는데 안 지움"은 원천적으로 불가능하다.
- **`SET LOCAL lock_timeout`이 청크 트랜잭션 안에 있다.** `SET LOCAL`은 그 트랜잭션에서만 유효하다는 뜻이라 커밋과 함께 원래 값으로 돌아간다. 락을 못 잡으면 기다리지 않고 실패하고, 그 청크만 재시도한다 — 사슬 B의 대기열 사고를 구조적으로 막는다.
- **`VACUUM`이 루프 밖에 있다.** VACUUM은 트랜잭션 블록 안에서 실행할 수 없으므로 `TransactionTemplate` 안에 넣으면 에러다. 그리고 무거운 작업이므로 청크마다가 아니라 **작업 종료 후 한 번**이 기본이고, 도중에는 autovacuum이 따라오도록 테이블 임계를 낮춰 두는 편이 낫다: `ALTER TABLE episode_view_log SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 10000);`

`@Scheduled`는 기본이 단일 스레드라 이 루프가 도는 동안 다른 스케줄이 전부 막힌다 — 전용 `TaskScheduler`를 준다. 그리고 **인스턴스가 여러 대**면 같은 루프가 동시에 돌므로 ShedLock 같은 분산 락, 또는 PostgreSQL이라면 **`pg_try_advisory_lock(키)`** 한 줄로 "이 작업은 클러스터에서 한 번만"을 DB가 보장하게 할 수 있다(세션이 끊기면 자동 해제되는 것도 장점이다 — 프로세스가 죽어도 락이 남지 않는다).

### 2-9. after ② — Spring Batch `Tasklet` 버전: 재시작·진행 위치를 프레임워크가

같은 루프를 Spring Batch로 옮기면 7번(진행 위치)과 재시작을 프레임워크가 맡는다. 청크 지향 스텝(reader → processor → writer)은 "읽어서 쓰는" 모델이라 순수 범위 삭제에는 맞지 않고, **`Tasklet`의 `execute()` 호출 1회 = 트랜잭션 1개**라는 성질을 쓰는 편이 정확하다.

```java
@Bean
public Step purgeViewLogStep(JobRepository jobRepository, PlatformTransactionManager txm,
                             ViewLogPurgeTasklet tasklet, PurgeProperties props) {
    return new StepBuilder("purgeViewLog", jobRepository)
        .tasklet(tasklet, txm)                                    // execute() 1회 = 트랜잭션 1개
        .listener(new SleepAfterChunk(props.sleepBetweenChunks())) // 커밋 "뒤"에 잔다
        .build();
}

@Component
@StepScope
@RequiredArgsConstructor
public class ViewLogPurgeTasklet implements Tasklet {

    private final JdbcTemplate jdbc;
    private final ReplicationLagProbe lagProbe;
    private final PurgeProperties props;
    @Value("#{jobParameters['cutoff']}") private OffsetDateTime cutoff;   // 같은 파라미터면 재실행이 아니라 "재시작"

    @Override
    public RepeatStatus execute(StepContribution contribution, ChunkContext ctx) {
        ExecutionContext ec = ctx.getStepContext().getStepExecution().getExecutionContext();

        if (!ec.containsKey("maxId")) {                            // 1. 경계 고정 — 첫 호출 때 한 번
            Long maxId = jdbc.queryForObject(
                "SELECT max(id) FROM episode_view_log WHERE created_at < ?", Long.class, cutoff);
            if (maxId == null) return RepeatStatus.FINISHED;
            ec.putLong("maxId", maxId);
        }
        long maxId  = ec.getLong("maxId");
        long lastId = ec.getLong("lastId", 0L);                    // 7. 재시작 시 여기서부터
        if (lastId >= maxId) return RepeatStatus.FINISHED;

        // 5. 복제 지연 게이트 — 여기는 트랜잭션 안이므로 "기다리지" 않고 즉시 실패시킨다.
        //    트랜잭션 안에서 기다리면 그 자체가 idle in transaction → VACUUM 방해다.
        //    스텝 FAILED → 다음 스케줄에 같은 JobParameter로 restart → lastId부터 이어진다.
        if (lagProbe.current() > props.lagThresholdSec()) {
            throw new PurgeThrottledException("replica lag " + lagProbe.current() + "s");
        }

        jdbc.execute("SET LOCAL lock_timeout = '3s'");
        long to = Math.min(lastId + props.chunkSize(), maxId);
        int n = jdbc.update(                                        // 2. PK 범위 청크
            "DELETE FROM episode_view_log WHERE id > ? AND id <= ? AND created_at < ?",
            lastId, to, cutoff);
        contribution.incrementWriteCount(n);                        // 9. StepExecution에 누적
        ec.putLong("lastId", to);                                   // 7. 커밋과 함께 JobRepository에 저장

        return RepeatStatus.CONTINUABLE;                            // 새 트랜잭션으로 다시 호출된다
    }
}

/** Tasklet의 execute()는 트랜잭션 안이다. sleep은 커밋 뒤에 불리는 afterChunk에 둔다. */
@RequiredArgsConstructor
class SleepAfterChunk implements ChunkListener {
    private final Duration sleep;
    @Override public void afterChunk(ChunkContext context) {
        try { Thread.sleep(sleep.toMillis()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

Spring Batch가 얹어 주는 것과 여전히 직접 해야 하는 것을 구분해 말한다. 얹어 주는 것 — `ExecutionContext`가 커밋마다 저장되어 **재시작이 공짜**, `JobParameters`로 **같은 cutoff의 중복 실행 방지**, `StepExecution`에 **처리 건수·소요 시간이 기록**돼 관측의 절반이 해결. 직접 해야 하는 것 — 복제 지연 게이트, VACUUM 추격 게이트, 스로틀, 킬 스위치, 아카이브 검증, 종료 후 `VACUUM (ANALYZE)`는 프레임워크가 모른다. "Spring Batch를 쓰면 안전하다"는 말은 절반만 맞다.

### 2-10. 복제 지연은 어떻게 재나 — `ReplicationLagProbe`

게이트 5번이 성립하려면 앱이 지연을 **숫자로** 알아야 한다. PostgreSQL에는 재는 축이 셋 있고, 자세한 비교는 read-replica 문서 5장에 있다.

- **프라이머리에서 `pg_stat_replication`** — standby별 `replay_lag`(`interval` 타입, "이 standby가 재생을 마치기까지 걸린 시간")과 `sent_lsn`/`replay_lsn`의 **바이트 차**. LSN은 WAL 안의 위치를 가리키는 주소이므로 둘의 차이가 곧 "아직 재생 안 된 WAL 바이트"다. 대량 삭제 중에는 바이트 차가 먼저 튀므로 둘 다 본다. 프라이머리 한 곳만 조회하면 되어 게이트로 쓰기 편하다.
- **standby에서 `now() - pg_last_xact_replay_timestamp()`** — 실제로 재생된 마지막 트랜잭션의 시각과의 차. 함정은 **쓰기가 없으면 이 값이 계속 커진다**는 것(지연이 아니라 "조용함"을 재는 셈).
- **하트비트 테이블** — 프라이머리가 1초마다 현재 시각을 한 행에 쓰고, 리플리카에서 그 행을 읽어 지금 시각과의 차이를 지연으로 삼는다. 위 함정을 없애 주고, 복제 경로 전체를 실제로 통과한 값이라 가장 신뢰할 수 있다. 단 그 UPDATE 자체가 죽은 튜플을 만드는 핫 로우이므로 `fillfactor`를 낮춰(페이지에 여유를 남겨) HOT 업데이트가 되게 해 둔다([23번 문서](./23-high-frequency-counter-hot-row.md)).

```java
@Component
@RequiredArgsConstructor
public class ReplicationLagProbe {

    private final JdbcTemplate primary;

    /** 모든 standby 중 최대 재생 지연(초). 프라이머리 한 번 조회로 끝난다. */
    public double current() {
        Double sec = primary.queryForObject(
            "SELECT coalesce(max(extract(epoch FROM replay_lag)), 0) " +
            "  FROM pg_stat_replication", Double.class);
        return sec == null ? 0.0 : sec;
    }

    /** 아직 재생되지 않은 WAL 바이트 — 지연 초가 0이어도 이쪽이 크면 밀리는 중이다. */
    public long pendingBytes() {
        Long b = primary.queryForObject(
            "SELECT coalesce(max(pg_wal_lsn_diff(sent_lsn, replay_lsn)), 0) " +
            "  FROM pg_stat_replication", Long.class);
        return b == null ? 0L : b;
    }

    /** 임계 아래로 내려올 때까지 최대 maxWait 동안 기다린다. 못 내려오면 false. */
    public boolean waitUntilBelow(double thresholdSec, Duration maxWait) {
        long deadline = System.nanoTime() + maxWait.toNanos();
        while (current() > thresholdSec) {
            if (System.nanoTime() > deadline) return false;
            try { Thread.sleep(5_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        }
        return true;
    }
}
```

관리형 DB(RDS/Aurora PostgreSQL)는 복제 지연을 모니터링 지표로도 제공하므로 그 값을 같은 인터페이스 뒤에 숨긴다. 중요한 건 측정 방법이 아니라 **루프가 그 숫자를 보고 스스로 멈춘다**는 구조다. 그리고 PostgreSQL에서는 지연과 함께 **복제 슬롯의 잔여 WAL**(`pg_replication_slots`)도 같은 게이트에 넣는 것이 좋다 — 슬롯이 밀리는 것은 지연보다 위험한 신호(사슬 C-⑸)다.

### 2-11. (가산점 포인트) 아카이브와 삭제를 한 문장으로 — data-modifying CTE

"아카이브 테이블로 옮기고 원본에서 지운다"를 두 문장으로 쓰면 그 사이에 경쟁이 끼어들 수 있다. PostgreSQL은 **`DELETE ... RETURNING`을 CTE**(WITH 절로 이름을 붙인 임시 결과 집합)**로 받아 그대로 `INSERT`할 수 있다** — 표준 SQL에는 없는, PostgreSQL의 대표적인 무기다.

```sql
-- before — 두 문장: 그 사이에 새 트랜잭션이 같은 행을 건드릴 수 있고,
--    INSERT는 성공했는데 DELETE가 실패하면 중복 아카이브가 남는다.
INSERT INTO episode_view_log_archive
SELECT * FROM episode_view_log WHERE id > $1 AND id <= $2 AND created_at < $3;
DELETE FROM episode_view_log       WHERE id > $1 AND id <= $2 AND created_at < $3;

-- after — 한 문장: 지운 행이 곧 아카이브로 들어간다. 원자적이고, 두 번 읽지 않는다.
WITH moved AS (
  DELETE FROM episode_view_log
   WHERE id > $1 AND id <= $2 AND created_at < $3
  RETURNING *
)
INSERT INTO episode_view_log_archive
SELECT * FROM moved;
```

알아야 할 성질 셋. ① CTE 안의 문장들은 **같은 스냅샷**을 보고, 서로의 효과를 보지 못한다 — 그래서 "지우면서 동시에 읽는" 순서 문제가 없다. ② 실행 순서는 보장되지 않지만 **모두 실행되는 것은 보장**된다(위 형태처럼 바깥이 CTE 결과를 소비하면 순서 걱정도 사라진다). ③ `RETURNING` 결과가 중간에 물화(메모리나 임시 파일에 실체화)되므로 **청크 크기를 그대로 유지해야 한다** — 2억 건을 한 문장으로 옮기면 1장의 사슬이 그대로 돌아온다. 아카이브 목적지가 다른 데이터베이스나 오브젝트 스토리지면 이 패턴을 못 쓰므로, 그때는 3-2의 "검증 후 삭제" 절차로 간다.

---

## 3. 실무 사례 · 안전망 — 사람이 아니라 코드·스키마가 지킨다

### 3-1. 실무 사례 — 웹툰 조회 로그 · 알림 이력 N개월 보존

상황: `episode_view_log`(에피소드 조회 로그, 하루 약 30만 건)와 `notification_history`(알림 발송 이력)는 "3개월 보존"이 기획 문서에는 있었지만 코드에는 없었다. 2년이 지나 계산이 이렇게 됐다.

```text
episode_view_log 누적량
  하루 30만 건 × 730일 = 2억 1,900만 건        ← "수억 건" 테이블의 정체
  남길 3개월(90일)     = 2,700만 건
  지울 것(약 640일치)  = 1억 9,200만 건        ← 1장의 "대상 약 2억 건"이 이 숫자다
```

디스크 사용률 82% 알람이 울렸고, 담당자는 새벽 3시에 psql에서 `DELETE FROM notification_history WHERE created_at < now() - interval '3 months'`를 실행했다.

25분 뒤 복제 지연 알람(사슬 C), 30분 뒤 알림함 API(리플리카 라우팅)의 "읽음 처리했는데 안 읽음으로 나와요" 문의, 35분 뒤 `notification_history`를 갱신하는 워커가 락 대기로 밀리며 커넥션 풀 고갈(사슬 B), 40분에 취소.

**취소 자체는 1초 만에 끝났다**(PostgreSQL의 롤백은 `pg_xact`에 abort 표시 하나) — 여기까지는 MySQL의 InnoDB보다 나았다. 문제는 그 뒤였다. 지운 행은 0건인데 ① 그 40분 동안 `backend_xmin`이 고정돼 있어서 **무관한 주문 테이블의 죽은 튜플이 수천만 개 쌓였고**(사슬 A-⑴) ② `full_page_writes`로 부푼 WAL이 아카이브를 밀어 `pg_wal` 사용량이 위험 수위까지 올랐으며 ③ 아침에 확인한 디스크 사용률은 82% 그대로였다 — 어차피 커밋됐어도 사슬 E 때문에 줄지 않았을 숫자다.

대응은 세 단계로 갔다.

- **즉시(그 주)**: 두 테이블 모두 2-8의 청크 루프로 전환. 첫날 청크 5,000·sleep 200ms로 시작해 청크 시간 120ms, `replay_lag` 최대 1.8초를 확인하고 청크 10,000으로 올렸다. 소요 시간이 실제로 어떻게 줄었는지는 곱셈으로 나온다.

  ```text
  [청크 5,000 · 실행 120ms · sleep 200ms]
    반복 횟수 = 192,000,000 ÷ 5,000 = 38,400회
    1회 소요  = 120ms + 200ms = 0.32초
    총 소요   = 38,400 × 0.32 = 12,288초 ≈ 3시간 25분

  [청크 10,000 · 실행 240ms · sleep 200ms]   (청크를 2배로 하면 실행 시간도 대략 2배)
    반복 횟수 = 192,000,000 ÷ 10,000 = 19,200회
    1회 소요  = 240ms + 200ms = 0.44초
    총 소요   = 19,200 × 0.44 = 8,448초 ≈ 2시간 21분

    → 줄어든 것은 "sleep 총량"이다(38,400 × 0.2초 = 7,680초 → 19,200 × 0.2초 = 3,840초).
      실행 시간 총량은 4,608초로 거의 그대로다 — 지울 행 수는 안 변했으니 당연하다.
      즉 청크를 키워서 얻는 이득은 "고정 오버헤드와 휴식 횟수를 줄이는 것"이고,
      키울수록 트랜잭션이 길어져 사슬 A~C가 커지는 것이 반대편 비용이다.
  ```

  02:00~05:00 야간 창에만 돌렸으므로 첫 버전은 이틀 밤, 청크를 올린 뒤로는 하룻밤에 끝났다. 대상 테이블에 `autovacuum_vacuum_scale_factor = 0.01`을 걸어 autovacuum이 따라오게 하고, `n_dead_tup` 게이트를 켜 두 번 백오프가 걸린 것을 확인했다. 아카이브는 두 테이블이 달랐다 — `episode_view_log`는 분석용이라 **`COPY (SELECT ...) TO`로 내보내 매니페스트 건수·체크섬 검증**, `notification_history`는 사용자가 다시 볼 일이 없다는 것을 기획과 **문서로 합의**하고 아카이브 없이 삭제. "아카이브 안 함"도 결정이고, 결정은 기록돼야 한다.
- **단기(다음 스프린트)**: 디스크는 청크 삭제로 안 돌아오므로(사슬 E) `notification_history`는 남길 3개월만 **새 파티션 테이블로 복사 후 트랜잭션 안에서 RENAME 교체**(2-4). 2년치에서 3개월만 남기므로 남길 비율은 `3 ÷ 24 = 12.5%`, 즉 87.5%를 버리는 셈이라 2-5의 기준("지울 비율 80~90% 이상")에 정확히 들어맞았다. 델타는 알림 워커를 15분 멈추는 점검 창으로 처리했고, 이 순간 파티셔닝이 도입됐다. PK를 `(id, created_at)`으로 바꾸면서 알림 이력의 `@Id`가 복합키가 되는 비용을 지불했고(2-3 대가 2), 교체 트랜잭션에서 `setval()`을 빠뜨려 스테이징에서 첫 INSERT가 PK 중복으로 죽는 것을 미리 잡았다. `episode_view_log`는 파티션 도입 대신 `pg_repack`으로 공간만 회수했다(FK 참조가 있어 교체가 더 비쌌다).
- **중기**: `retention_policy` 테이블과 3-5 스케줄러(`DETACH CONCURRENTLY` → 유예 → `DROP`) 도입, 3-6 CI 린트 추가. 이후 새로 생긴 `episode_reaction_log`는 DDL PR 단계에서 "보존 기간?"을 묻는 린트에 걸려 처음부터 월 파티션으로 만들어졌고, 그 테이블의 첫 삭제는 `DETACH` + `DROP TABLE` 두 줄, 1초 미만이었다.

이 사고의 교훈은 "DELETE를 나눠 치자"가 아니다. **삭제는 테이블을 만들 때 이미 결정된 비용**이고, 그 결정을 미룬 값을 2년 뒤 새벽 3시에 한꺼번에 치른 것이다. 그리고 PostgreSQL에서는 값의 절반이 **삭제가 끝난 뒤에** 청구된다.

### 3-2. 삭제 전 아카이브 검증 — 건수 + 체크섬 + `EXCEPT`, 그리고 유예 기간

순서는 **아카이브 → 검증 → (유예) → 삭제**다. 2-11의 CTE로 한 트랜잭션에 묶을 수 있는 경우는 다행이지만, 아카이브 목적지가 다른 저장소(별도 DB, 오브젝트 스토리지의 Parquet)면 어차피 한 트랜잭션이 아니고, 같은 DB의 아카이브 테이블이라도 "옮겼다"와 "옮긴 게 맞다"는 다른 문제다.

```sql
-- 원본 쪽: 삭제 예정 범위를 고정하고 세 값을 뽑는다
SELECT count(*)    AS cnt,
       sum(h)      AS sum_h,
       bit_xor(h)  AS xor_h          -- bit_xor 집계는 최근 버전에서 제공
FROM (
  SELECT ('x' || substr(
            md5(concat_ws('|',
                  id, member_id, episode_id,
                  extract(epoch FROM created_at)   -- ※ timestamptz를 그대로 문자열화하면
                )),                                --   세션 TimeZone에 따라 표현이 달라진다
          1, 8))::bit(32)::int AS h
  FROM episode_view_log
  WHERE id > $1 AND id <= $2 AND created_at < $3
) s;
-- 아카이브 쪽에서 같은 범위·같은 식으로 뽑아 세 값이 모두 같아야 "그 범위 삭제 허가"
```

- **왜 세 값을 다 보는가.** `count`만 보면 "건수는 같은데 내용이 다른" 경우를 놓치고, `bit_xor`만 보면 같은 행이 두 번 들어간 경우를 놓친다(XOR은 같은 값이 짝수 번 들어오면 서로 상쇄돼 0이 된다). `sum`은 순서에 무관하게 값의 총합을 보고, `bit_xor`는 비트 패턴의 어긋남을 본다 — 서로 다른 종류의 오류를 잡으므로 셋을 함께 본다. PostgreSQL에는 CRC32 내장 함수가 없어 **md5 앞 8자리를 32비트 정수로 접는** 위 관용구를 쓴다.
- **PostgreSQL 고유의 함정 둘.** ⑴ `timestamptz`를 문자열로 만들면 **세션 `TimeZone` 설정에 따라 표현이 달라져** 원본과 아카이브의 체크섬이 이유 없이 어긋난다 → 위처럼 `extract(epoch ...)`나 `AT TIME ZONE 'UTC'`로 기준을 고정한다([30번 문서](./30-datetime-vs-timestamp-timezone.md)). ⑵ NULL 가능 컬럼은 `coalesce(col::text, '\N')`로 감싼다 — `concat_ws`는 NULL 인자를 통째로 건너뛰므로, NULL이 하나 있으면 그 뒤 컬럼들이 한 칸씩 밀려 전혀 다른 문자열이 되기 때문이다.
- **아카이브가 같은 DB 안이면 체크섬보다 확실한 방법이 있다** — 집합 차집합을 직접 본다. 양방향 모두 0이어야 한다.

```sql
-- 원본에는 있는데 아카이브에 없는 행 (반대 방향도 같이 확인한다)
SELECT count(*) FROM (
  SELECT id, member_id, episode_id, created_at FROM episode_view_log
   WHERE id > $1 AND id <= $2 AND created_at < $3
  EXCEPT ALL
  SELECT id, member_id, episode_id, created_at FROM episode_view_log_archive
   WHERE id > $1 AND id <= $2
) d;   -- EXCEPT ALL 이므로 중복 적재까지 잡힌다 (EXCEPT 는 중복을 접어 버려 못 잡는다)
```

- 오브젝트 스토리지로 내보내는 경우(`COPY (SELECT ...) TO ...` 또는 클라이언트 쪽 `\copy`) 내보내기 작업이 파일별 **건수·체크섬을 매니페스트**(무엇을 어디에 몇 건 썼는지 적은 목록 파일)에 기록하고, 검증기는 원본 범위 값과 매니페스트를 비교한다.
- 검증을 통과한 상한 `id`를 `archive_verification(table_name, verified_until_id, verified_at)`에 기록하고, 2-8의 루프는 **그 값 이하만** 지운다. 검증 코드와 삭제 코드가 테이블 하나로 연결되어 "검증 안 하고 지우기"가 구조적으로 불가능해진다.
- **유예 기간**을 둔다 — 검증 후 예컨대 7일 뒤에 삭제. 그 사이 아카이브에서 **샘플 복원 테스트**(무작위 행 100건을 아카이브에서 읽어 원본과 대조)를 자동으로 돌린다. 복구를 한 번도 연습 안 한 백업은 없는 것과 같다는 원칙이 여기서도 적용된다. 파티션 방식이라면 이 유예를 **`DETACH`한 채로 두는 기간**으로 자연스럽게 구현할 수 있다(2-3).

### 3-3. 드라이런 — 실행 전에 계획서를 뽑아 사람이 승인한다

```java
public PurgePlan dryRun(String table, OffsetDateTime cutoff) {
    Long maxId = jdbc.queryForObject("SELECT max(id) FROM " + table + " WHERE created_at < ?", Long.class, cutoff);
    Long minId = jdbc.queryForObject("SELECT min(id) FROM " + table, Long.class);
    // 수억 건 count(*)는 그 자체가 무거우므로 카탈로그 추정치와 PK 범위 폭으로 갈음한다
    Float estimatedRows = jdbc.queryForObject(
        "SELECT reltuples FROM pg_class WHERE oid = ?::regclass", Float.class, table);

    // ※ EXPLAIN 은 ANALYZE 없이 쓴다 — PostgreSQL의 EXPLAIN ANALYZE 는 DML을 실제로 실행한다.
    //   꼭 실측하려면 BEGIN; EXPLAIN (ANALYZE) DELETE ...; ROLLBACK; 으로 감싼다.
    String plan = String.join("\n", jdbc.queryForList(
        "EXPLAIN DELETE FROM " + table + " WHERE id > ? AND id <= ? AND created_at < ?",
        String.class, minId, minId + props.chunkSize(), cutoff));
    // 기대: "Delete on ..." 아래 "Index Scan using <table>_pkey" — Seq Scan 이면 청크가 아니다

    return new PurgePlan(
        table, cutoff, minId, maxId, estimatedRows,
        tableSizePretty(table),                                      // pg_size_pretty(pg_total_relation_size(...))
        deadTupleRatio(table),                                       // pg_stat_user_tables
        plan,
        childForeignKeysWithoutIndex(table),                         // ※ PostgreSQL 최대 함정 사전 점검
        archiveVerifier.verifiedUntilId(table) >= (maxId == null ? 0 : maxId),
        lagProbe.current(), lagProbe.pendingBytes(),
        oldestTransactionSec(),                                      // pg_stat_activity: now() - xact_start
        replicationSlotLagBytes()                                    // pg_replication_slots
    );
}
```

드라이런이 확인하는 것은 일곱 가지다 — **대상 범위와 건수의 자릿수**(2억인지 2천만인지), **실행 계획이 PK 인덱스 스캔인지**(Seq Scan이면 청크가 아니다), **자식 FK 컬럼에 인덱스가 있는지**(없으면 시작하면 안 된다), **아카이브 검증이 끝났는지**, **현재 복제 지연과 슬롯 잔여 WAL**, **열려 있는 가장 오래된 트랜잭션**(이게 길면 내가 만든 죽은 튜플을 autovacuum이 못 치운다), **현재 bloat 비율**. 이 계획서가 티켓에 첨부되고 승인된 뒤에야 실제 실행 플래그가 켜진다. "새벽에 담당자가 SQL을 직접 친다"를 "코드가 계획서를 만들고 사람은 승인만 한다"로 바꾸는 것이다.

`childForeignKeysWithoutIndex`는 이런 조회다 — PostgreSQL에서 대량 삭제 전에 반드시 한 번 돌린다(사슬 B-⑶).

```sql
-- 이 테이블을 참조하는 자식 FK 중, 자식 쪽 컬럼을 선두로 하는 인덱스가 없는 것
SELECT c.conrelid::regclass AS child, c.conname
FROM pg_constraint c
WHERE c.confrelid = 'episode_view_log'::regclass
  AND c.contype = 'f'
  AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = c.conrelid
          AND i.indisvalid
          -- indkey(int2vector)를 배열로 펴서 "FK 컬럼들이 인덱스의 선두 접두사인가"를 본다
          AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)]
              = c.conkey
      );
-- 한 행이라도 나오면: 부모 1건 삭제마다 그 자식 테이블 전체 스캔이다.
-- 처방은 CREATE INDEX CONCURRENTLY 먼저, 삭제는 그다음.
```

### 3-4. 루프 안의 자동 중단 — 알람이 아니라 게이트

2장에 이미 들어 있지만 안전망 관점에서 다시 짚는다. 대량 삭제 사고의 전형은 "알람이 울렸고, 사람이 보고, 판단하고, 취소했다"인데 그 사이 40분이 지나 있다. PostgreSQL은 롤백이 공짜라 MySQL의 InnoDB만큼 극적이진 않지만, 그 40분 동안 멈춰 있던 VACUUM과 쌓인 WAL은 그대로 남는다. **알람은 사람의 반응 시간을 필요로 하고, 게이트는 필요로 하지 않는다** — 게이트는 그 40분을 0으로 만든다.

| 게이트 | 신호 | 동작 |
|---|---|---|
| 복제 지연 | `pg_stat_replication.replay_lag` > 임계(예: 5초) 또는 `sent_lsn - replay_lsn` 바이트 급증 | 대기 → 일정 시간 초과 시 오늘 중단 |
| 복제 슬롯 | `pg_replication_slots`의 잔여 WAL이 임계 초과 / `wal_status`가 정상이 아님 | 즉시 중단 (디스크 풀 위험) |
| VACUUM 추격 | `pg_stat_user_tables.n_dead_tup` > 임계, `last_autovacuum`이 오래됨 | 백오프 (죽은 튜플 생성 속도 > 회수 속도) |
| DB 부하 | `pg_stat_activity`의 active 백엔드 수 / `wait_event_type = 'Lock'` 대기자 수 | 백오프 |
| 커넥션 풀 | HikariCP active/total > 70% | 백오프 (내 루프가 풀을 굶기고 있다는 신호) |
| 청크 시간 | 목표의 2배 초과 | 청크 크기 절반 |
| 락 획득 | `SET LOCAL lock_timeout` 초과로 청크 실패 | 그 청크만 재시도 (대기열을 만들지 않는다) |
| 시간 창 | 피크 시간 진입 | 진행 위치 저장 후 종료 |
| 킬 스위치 | 설정값/파일/캐시 키 | 즉시 종료 |

### 3-5. 파티션 자동 생성 · 드랍 스케줄러

파티션 방식의 대가 5·7번(파티션 고갈 → INSERT 실패, DETACH의 제약)을 사람의 달력이 아니라 코드가 처리한다.

```java
@Component
@RequiredArgsConstructor
public class PartitionMaintenanceScheduler {

    private final JdbcTemplate jdbc;
    private final RetentionPolicyRepository policies;   // 3-6: 테이블별 보존 기간·선행 생성 개수
    private final ArchiveVerifier archiveVerifier;
    private final AlertClient alert;

    @Scheduled(cron = "0 30 3 * * *")
    public void maintain() {
        for (RetentionPolicy p : policies.findAllPartitioned()) {
            ensureFuturePartitions(p);
            detachAndDropExpired(p);
        }
    }

    /** 미래 파티션이 항상 aheadMonths개 존재하게 한다 — 이게 없으면 다음 달 첫 INSERT가 실패한다. */
    private void ensureFuturePartitions(RetentionPolicy p) {
        YearMonth now = YearMonth.now(ZoneOffset.UTC);
        for (int i = 1; i <= p.aheadMonths(); i++) {
            YearMonth ym = now.plusMonths(i);
            if (!partitionExists(p.table(), name(p, ym))) {
                jdbc.execute("SET lock_timeout = '5s'");          // 대기열을 만들지 않는다
                jdbc.execute("""
                    CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')
                    """.formatted(name(p, ym), p.table(),
                                  ym.atDay(1), ym.plusMonths(1).atDay(1)));
            }
        }
    }

    /** 보존 기간이 지난 파티션을 떼어내고, 아카이브 검증이 끝난 것만 버린다. */
    private void detachAndDropExpired(RetentionPolicy p) {
        YearMonth oldestToKeep = YearMonth.now(ZoneOffset.UTC).minusMonths(p.retentionMonths());

        for (String part : attachedPartitionsOlderThan(p.table(), oldestToKeep)) {
            jdbc.execute("SET lock_timeout = '5s'");
            // CONCURRENTLY 는 트랜잭션 블록 안에서 실행할 수 없다 — 자동 커밋 경로로 보낸다.
            jdbc.execute("ALTER TABLE %s DETACH PARTITION %s CONCURRENTLY".formatted(p.table(), part));
            alert.info("[partition] %s 분리 완료 — 아카이브 대기".formatted(part));
        }
        // 떼어낸 뒤 유예 기간이 지났고 아카이브가 검증된 것만 버린다
        for (String part : detachedPartitionsPastGrace(p)) {
            if (p.archiveRequired() && !archiveVerifier.isVerified(p.table(), part)) {
                alert.warn("[partition] %s 보존 만료·분리 완료됐으나 아카이브 미검증 — 드랍 보류".formatted(part));
                continue;                                          // 드랍하지 않는다. 사람이 본다.
            }
            jdbc.execute("DROP TABLE %s".formatted(part));         // 즉시, 공간 반환
        }
    }

    private boolean partitionExists(String table, String partition) {
        Integer n = jdbc.queryForObject(
            "SELECT count(*) FROM pg_class WHERE relname = ? AND relkind = 'r'", Integer.class, partition);
        return n != null && n > 0;
    }
    // attachedPartitionsOlderThan(...) 은 pg_inherits + pg_get_expr(relpartbound) 로 경계를 읽어 계산한다
    private static String name(RetentionPolicy p, YearMonth ym) {
        return "%s_%d_%02d".formatted(p.table(), ym.getYear(), ym.getMonthValue());
    }
}
```

스케줄러와 **독립된** 감시를 하나 더 둔다 — "미래 파티션이 2개 미만이면 경보", "분리된 채 유예 기간을 훨씬 넘긴 파티션이 있으면 경보". 스케줄러 자체가 배포 실수로 죽어 있을 때를 위한 것이다. 안전망을 지키는 안전망이 하나는 있어야 한다. PostgreSQL에서는 같은 일을 **`pg_partman` + `pg_cron`**으로 DB 안에서 처리할 수도 있는데, 앱 코드에 두면 배포·테스트·관측 경로가 다른 코드와 같아지고 DB에 두면 앱과 무관하게 돈다 — 팀이 확장과 DB 쪽 스케줄을 얼마나 잘 관리하느냐로 고른다.

### 3-6. 보존 정책을 설계 시점에 — "이 행은 언제 죽는가"에 답이 없는 테이블은 만들지 않는다

가장 싼 대량 삭제는 **처음부터 삭제가 쉬운 구조로 만든 테이블**의 삭제다. 그래서 이벤트성 테이블(`*_log`, `*_history`, `*_event`)의 DDL PR은 다음 넷에 답해야 통과한다.

1. **보존 기간** — "무기한"은 답이 아니다. 무기한이면 왜 RDB인지 답해야 한다.
2. **삭제 방식** — 파티션 DETACH인지 청크 삭제인지. 파티션이면 PK에 `created_at`이 들어가고 업무 유니크 제약을 포기해야 하므로 **지금** 정해야 한다.
3. **아카이브 여부와 목적지** — 지우기 전에 어디로 보내는지, 안 보낸다면 그 합의가 어디 기록돼 있는지.
4. **PK 단조 증가 또는 `(created_at, id)` 인덱스** — 청크 삭제가 범위 커서로 가능한 구조인지. 그리고 **이 테이블을 참조하는 FK가 생긴다면 자식 컬럼에 인덱스를 함께 만든다**(PostgreSQL은 자동 생성하지 않는다).

이 답을 사람의 리뷰 기억이 아니라 **기계가 읽는 자리**에 둔다. 테이블 COMMENT와 `retention_policy` 메타 테이블 — 3-5의 스케줄러가 이 테이블을 읽어 동작하므로 "새 로그 테이블 추가 = 정책 행 하나 INSERT"가 되고 테이블마다 스케줄러 코드를 새로 짜지 않는다.

```sql
CREATE TABLE notification_history (
  id         bigint      NOT NULL DEFAULT nextval('notification_history_id_seq'),
  member_id  bigint      NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE notification_history IS
  'retention=90d;purge=partition-monthly;archive=s3://.../notification_history/';

INSERT INTO retention_policy (table_name, retention_months, ahead_months, purge_method, archive_required)
VALUES ('notification_history', 3, 3, 'PARTITION_DETACH', true);
```

```bash
# ci/lint-retention.sh — 이벤트성 테이블 DDL에 retention 메타가 없으면 CI 실패
for f in $(git diff --name-only origin/main -- 'src/main/resources/db/migration/*.sql'); do
  if grep -qiE 'CREATE TABLE "?[a-z_]+_(log|history|event)s?"?' "$f" \
     && ! grep -qiE "COMMENT ON TABLE[^;]*retention=" "$f"; then
    echo "::error file=$f::이벤트성 테이블은 COMMENT ON TABLE 에 retention=<기간>;purge=<방식>을 명시해야 합니다 (knowledge/04-rdb-sql/25-mass-delete-archiving-and-partitioning.md 3-6)"
    exit 1
  fi
done
```

### 3-7. 대량 삭제 체크리스트 (PR · 런북 필수)

```markdown
### 대량 삭제/아카이빙 체크리스트 (PostgreSQL)
- [ ] 접근법 선택 근거: 파티션 유무 / 지울 비율 / 점검 창·논리 복제 가능 여부 (2-5)
- [ ] 드라이런 계획서 첨부: 범위·건수 자릿수·EXPLAIN(PK Index Scan)·예상 소요 (3-3)
- [ ] 자식 FK 컬럼 인덱스 존재 확인 — 없으면 먼저 CREATE INDEX CONCURRENTLY (3-3)
- [ ] 아카이브 검증(건수·체크섬·EXCEPT ALL) 통과 + verified_until_id 기록 + 샘플 복원 테스트 (3-2)
- [ ] 청크 루프 게이트: 복제 지연 / 복제 슬롯 잔여 WAL / n_dead_tup / active 백엔드 / 풀 사용률 / 청크 시간 / lock_timeout / 시간 창 / 킬 스위치 (3-4)
- [ ] run() 에 @Transactional 없음 / sleep 이 트랜잭션 밖 / 진행 위치가 DELETE 와 같은 트랜잭션 (2-8)
- [ ] 대상 테이블 autovacuum 임계 하향(ALTER TABLE ... SET) + 종료 후 VACUUM (ANALYZE) (2-2, 2-8)
- [ ] 디스크 회수가 목적이면 pg_repack / REINDEX CONCURRENTLY 를 같은 티켓에 (1-5)
- [ ] 다중 인스턴스 동시 실행 방지 (분산 락 또는 pg_try_advisory_lock)
- [ ] DDL(DETACH / RENAME / VACUUM FULL)이 포함되면 lock_timeout 단축 + pg_stat_activity 롱 트랜잭션 사전 확인 (14번 문서)
- [ ] 실행 중 관측 대시보드: 청크 시간·삭제 건수·replay_lag·n_dead_tup·pg_wal 사용량
- [ ] 재발 방지: retention_policy 등록 / 파티션 스케줄러 대상 추가
```

---

## 4. 꼬리질문 대비 포인트

### "청크 크기와 sleep은 어떻게 정하나요? 1,000이면 안전한가요?"

숫자가 아니라 **측정 기준**으로 답한다. 목표는 "청크 트랜잭션 하나가 수백 ms 안에 끝나고, 그동안 `replay_lag`·락 대기·활성 백엔드 수가 평소 수준을 벗어나지 않는 것"이다. 1,000에서 시작해 청크 시간과 복제 지연을 보며 두 배씩 올리고, 목표 시간의 2배를 넘으면 절반으로 내리는 **적응형**이 정답에 가깝다(2-8 `adapt`). 행 크기·인덱스 수·디스크 종류에 따라 같은 1,000이 50ms일 수도 2초일 수도 있어서 고정 숫자는 답이 될 수 없다. **PostgreSQL이면 지표가 하나 더 붙는다** — `pg_stat_user_tables.n_dead_tup`. 청크가 죽은 튜플을 만드는 속도가 autovacuum이 치우는 속도를 넘어서면 숫자가 단조 증가하는데, 그게 "sleep을 늘려야 한다"는 가장 정확한 신호다. sleep은 autovacuum·체크포인터·복제본이 따라올 시간이며, 대체로 청크 시간과 비슷한 길이에서 시작한다. 그리고 **총 소요 시간은 곱셈으로 미리 말할 수 있어야 한다** — "2억 건 ÷ 청크 5,000 = 4만 회, 회당 (실행 200ms + 휴식 100ms) = 0.3초, 총 12,000초 ≈ 3시간 20분"까지 계산해서 티켓에 적고, 여기에 야간 창과 백오프를 곱해 "며칠짜리"인지를 판단한다.

### "`DELETE ... LIMIT 1000`을 반복하면 안 되나요? 훨씬 간단한데요."

**PostgreSQL의 `DELETE`에는 `LIMIT` 절이 없다**는 것부터 짚는다. 흉내 내려면 `WHERE id IN (SELECT id ... LIMIT n)`이나 `ctid = ANY(...)`가 되는데, 그 형태보다 PK 범위가 나은 이유가 셋이다. ① 서브쿼리 `LIMIT`는 매번 인덱스 앞쪽부터 다시 스캔하는데, **방금 지운 행의 인덱스 엔트리는 VACUUM 전까지 그대로 남아 있어**(PostgreSQL의 DELETE는 인덱스를 안 건드린다) 다음 청크가 그 유령 엔트리들을 건너뛰며 시작한다 → 갈수록 느려진다. PostgreSQL은 두 번째 스캔부터 엔트리에 'killed' 힌트를 찍어 힙까지는 안 가지만 훑는 비용은 남는다. PK 범위는 매 청크가 고정된 인덱스 구간 seek라 속도가 일정하다. ② 어떤 행이 지워질지 **비결정적**이라 재현·감사가 어렵고, 진행 위치를 저장할 커서 자체가 없어 7번(재개)이 성립하지 않는다. ③ 잠그는 범위를 말로 설명할 수 없다 — PK 범위는 "이 구간"이라고 티켓에 쓸 수 있다. 예외는 PK가 시간 순이 아닐 때인데, 그때도 `LIMIT`이 아니라 `(created_at, id)` 키셋으로 하한을 밀거나 `ctid` 순차 청크를 쓴다.

### "파티셔닝하면 무엇을 잃나요? PK를 왜 바꿔야 하죠?" (시니어 변별 포인트)

PostgreSQL도 **파티션 키 컬럼이 PK를 포함한 모든 유니크 제약에 들어 있어야** 한다. 이유는 **글로벌 인덱스가 없기** 때문이다 — 유니크 검사가 파티션 로컬 인덱스로만 이뤄지니 `id`만으로 유일성을 검사하려면 모든 파티션을 다 봐야 하고, PostgreSQL은 그 비용 대신 제약을 택했다. 그래서 `PRIMARY KEY (id)` → `(id, created_at)`이 되고, 잃는 것은 셋이다: `id` 단독 유일성의 DB 보장(채번기가 책임진다), 업무 유니크 제약의 표현력(`UNIQUE(member_id, episode_id)`에 `created_at`을 끼워 넣는 순간 "한 회원이 한 에피소드에 한 번"이라는 의미가 사라진다), JPA `@Id`의 단순함. 여기에 **프루닝 조건 없는 조회의 파티션 수 배수 seek**, **파티션 수가 늘수록 커지는 계획·잠금 비용**, **파티션 고갈 시 INSERT 실패**를 얹는다. 그래서 판단 기준은 "삭제가 잦은가"가 아니라 **"이 테이블에 업무 유니크 제약과 기간 없는 점 조회가 있는가"**다. **단, MySQL의 InnoDB와 달리 PostgreSQL은 파티션 테이블에 FK를 걸 수도, 참조될 수도 있으므로(최근 버전) "FK 때문에 파티셔닝을 포기"할 필요는 없다** — 이 차이를 짚으면 "MySQL 문서를 외운 답"과 구분된다. 반대로 PostgreSQL에서 새로 생기는 숙제는 **파티션별 인덱스 무중단 생성**(각 파티션에 `CREATE INDEX CONCURRENTLY` → 부모 인덱스에 `ATTACH`)과 **`ATTACH` 시 검증 스캔**(미리 같은 `CHECK` 제약을 걸어 생략)이다.

### "아카이브가 제대로 됐다는 걸 어떻게 보장하나요? 삭제한 뒤 아카이브가 깨져 있었다면요?" (시니어 변별 포인트)

"보장"은 삭제 **전**에만 가능하므로 절차를 앞에 둔다. ① 범위 고정 후 원본과 아카이브에서 `count(*)` + `sum(해시)` + `bit_xor(해시)` 세 값을 비교한다(하나만으로는 건수 불일치·중복 적재를 각각 놓친다). 같은 DB 안이면 `EXCEPT ALL`로 양방향 차집합이 0인지 보는 쪽이 더 확실하다. PostgreSQL에서만 조심할 것 둘 — `timestamptz`를 문자열화하면 세션 `TimeZone`에 따라 값이 달라지므로 `extract(epoch ...)`로 고정하고, NULL 컬럼은 `coalesce`로 감싼다(`concat_ws`가 NULL을 건너뛰어 컬럼이 밀린다). ② 통과한 상한을 `archive_verification`에 기록하고 삭제 루프는 그 값 이하만 지운다 — 검증과 삭제가 코드로 연결돼 있어 순서를 어길 수 없다. ③ 검증과 삭제 사이에 **유예 기간**을 두고 그동안 **샘플 복원 테스트**를 자동으로 돌린다. 파티션 방식이라면 이 유예를 **`DETACH`한 채 며칠 두는 것**으로 구현하면 되돌리기가 `ATTACH` 한 줄이 되어 가장 안전하다. 그래도 삭제 후 깨진 것을 발견했다면 남은 카드는 **PITR**(Point-In-Time Recovery, 시점 복구) — 베이스 백업 + WAL 아카이브로 삭제 직전 시점을 별도 인스턴스에 복원해(`recovery_target_time`) 그 범위만 다시 추출한다. 그래서 대량 삭제 일정은 **WAL 아카이브 보존 기간 안에서 잡는다.** 이 답에서 면접관이 듣고 싶은 문장은 "삭제는 되돌릴 수 없으니 되돌릴 수 있는 지점을 삭제 전에 만들어 둔다"이다.

### "다 지웠는데 디스크가 안 줄었습니다. 왜죠? 어떻게 회수하나요?" (가산점 포인트)

PostgreSQL의 `DELETE`는 튜플에 `xmax`를 표시할 뿐이라 커밋 직후에는 **0바이트**가 회수된다. VACUUM이 돌면 그 공간은 **Free Space Map에 등록돼 그 테이블의 이후 INSERT가 재사용**할 뿐 파일은 그대로다 — 그래서 "앞으로 3개월치가 다시 쌓일 자리"로는 쓸모가 있지만 디스크 알람은 그대로다. VACUUM이 OS에 돌려주는 유일한 경우는 **파일 끝쪽의 완전히 빈 페이지**를 잘라내는 것인데, 짧은 `ACCESS EXCLUSIVE` 락이 필요해 못 잡으면 포기하고, 애초에 오래된 데이터는 파일 앞쪽에 있어 잘 발동하지 않는다. 회수 방법은 전부 "테이블을 새로 쓰는 것"이다: **`VACUUM FULL`**(재작성 + `ACCESS EXCLUSIVE` + 디스크 2배, 그동안 읽기도 불가), **`pg_repack`**(확장, 무중단에 가깝지만 교체 순간 짧은 배타 락 + 디스크 2배), **복사 후 교체**(2-4), **파티션 `DROP`**(2-3, 파일 자체가 사라지므로 즉시). 인덱스 bloat는 별도로 **`REINDEX CONCURRENTLY`**가 필요하다. 얼마나 부풀었는지는 `pgstattuple`의 `free_percent`/`dead_tuple_percent`로 숫자를 본다. 그래서 "디스크 회수"가 목적이라면 청크 삭제는 **절반의 답**이고, 처음부터 그 목적을 말하고 접근법을 골라야 한다.

### "삭제 대신 다른 테이블로 옮기고 싶습니다. PostgreSQL에서 가장 깔끔한 방법은?" (가산점 포인트)

같은 DB 안이라면 **`WITH moved AS (DELETE ... RETURNING *) INSERT INTO archive SELECT * FROM moved`** 한 문장이다(2-11). 지운 행이 곧 아카이브로 들어가므로 두 문장 사이의 경쟁이 사라지고, 원본을 두 번 읽지 않는다. CTE 안의 문장들은 **같은 스냅샷**을 보고 서로의 효과를 못 보므로 "지우면서 읽는" 순서 문제도 없다. 주의점은 셋 — ① 여전히 **한 트랜잭션**이므로 청크 크기를 지켜야 한다(2억 건을 한 문장으로 하면 1장이 그대로 재현된다) ② `RETURNING` 결과가 중간에 물화되므로 메모리·임시 파일을 쓴다 ③ 아카이브 테이블에 트리거나 FK가 있으면 그 비용이 그대로 붙는다. 목적지가 다른 DB나 오브젝트 스토리지면 이 패턴을 못 쓰므로 `COPY (SELECT ...) TO` → 검증 → 삭제 순서로 가고, 파티션 테이블이라면 **`DETACH`만 해 두면 그 자체가 "옮긴 것"**이라 복사조차 필요 없다.

### "MySQL로 물어보면 답이 달라지는 부분은?" (경험 대조)

다섯 지점이다. ① **삭제의 물리적 의미** — InnoDB는 delete-mark + 언두 레코드를 남겨 undo 테이블스페이스가 트랜잭션 크기만큼 팽창하고 purge 스레드가 정리하지만, PostgreSQL은 튜플 `xmax`만 찍고 **VACUUM**이 정리한다. 옛 버전을 별도 공간에 두느냐 제자리에 두느냐의 차이다. ② **중단 비용** — InnoDB는 `KILL`하면 undo를 역순으로 적용하는 롤백이 **원 작업 이상** 걸려 "40분 삭제 → 1시간 롤백 → 0건"이 나오지만, **PostgreSQL은 `pg_xact`에 abort 표시를 찍는 O(1) 작업**이라 즉시 끝난다. 대신 PostgreSQL은 그 트랜잭션이 살아 있는 동안 `backend_xmin`으로 **클러스터 전체 VACUUM을 묶는다**는 대가를 따로 낸다. ③ **인덱스 비용의 시점** — InnoDB는 삭제 순간 세컨더리 인덱스마다 랜덤 I/O를 내지만, PostgreSQL은 삭제 시점에 인덱스를 안 건드리고 **VACUUM이 모든 인덱스를 전수 스캔**하며 나중에 낸다(총액은 사라지지 않는다). ④ **락** — InnoDB는 스캔한 행 전부 + 넥스트 키 락이라 범위가 넓지만, PostgreSQL은 갭 락이 없어 대상 행만 잠근다. 대신 PostgreSQL에는 **`ACCESS EXCLUSIVE` 대기열이 뒤의 SELECT까지 세우는** 경로와, **자식 FK 컬럼 인덱스를 자동 생성하지 않아 부모 삭제가 자식 풀스캔이 되는** 함정이 있다(MySQL은 자동 생성한다). ⑤ **파티션** — 규칙(파티션 키가 유니크 제약에 포함)은 같지만, MySQL은 파티션 테이블에 **FK를 아예 못 쓰고** `DROP PARTITION`이 되돌릴 수 없는 반면, PostgreSQL은 **FK를 쓸 수 있고** `DETACH CONCURRENTLY` → 유예 → `DROP`으로 **되돌릴 수 있는 중간 상태**를 만들 수 있다. 이 다섯을 짚으면 "한쪽만 써봤다"가 아니라 "구조에서 도출했다"로 들린다.

---

## 한 줄 요약

**PostgreSQL에서 수억 건 `DELETE` 한 방은 죽은 튜플과 VACUUM 부채(도는 동안 `backend_xmin`이 클러스터 전체 VACUUM을 묶는다) · 대기열과 FK 자식 풀스캔 · 커밋을 기다리지 않고 흘러가 슬롯·아카이브까지 미는 WAL · VACUUM이 모든 인덱스를 전수 스캔하며 뒤늦게 내는 인덱스 청구서 · 0바이트 회수되는 공간이라는 다섯 사슬이 동시에 터지는 장애이므로(롤백만은 O(1)로 공짜지만 그동안 낸 비용은 환불되지 않는다), 삭제라는 일에 할 수 있는 셋 — "지금 당장이지만 총 I/O 최대·VACUUM 부채·공간 미회수"인 PK 범위 청크 삭제 / "즉시·저비용이고 DETACH로 되돌릴 수 있지만 사전 파티셔닝·PK에 파티션 키·프루닝 조건이 필요한" 파티션 DETACH·DROP / "공간 완전 회수지만 쓰기 델타·디스크 2배·OID로 묶인 FK·뷰·시퀀스 재연결이 필요한" 복사 후 트랜잭션 RENAME 교체 — 를 조건에 따라 고르고, 아카이브 검증(건수·체크섬·`EXCEPT ALL`) → 드라이런(자식 FK 인덱스 확인 포함) → 복제 지연·슬롯·`n_dead_tup` 게이트가 있는 청크 루프 → 종료 후 `VACUUM (ANALYZE)`·`REINDEX CONCURRENTLY` → 파티션 자동 생성·드랍 스케줄러 → 테이블 설계 시점의 보존 정책을 사람의 기억이 아니라 코드와 스키마에 고정한다.**
