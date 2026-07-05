# Development Plan — Program Capacity & Invoice Reservation

Status: PROPOSED (awaiting approval). Implementation follows this document phase by phase;
each phase lands as one or more Conventional Commits on `dev` with migrations + tests included.

Scope guard: this is a proof of concept (PoC). We implement everything the task
demands (correctness, atomicity, idempotency, reconciliation, multi-currency, auth, local run)
and deliberately skip infrastructure that only matters at scale (see "Out of scope" at the end).

---

## 0. Already done (scaffold)

- NestJS strict TS, validated config (Joi), global `JwtAuthGuard` + `@Public()`, `/health`,
  pino logging with correlation id, global exception filter.
- docker-compose: `postgres:16-alpine` + single-node `apache/kafka` (KRaft, no ZooKeeper) + app.
  Minimal images, no extra services.
- TypeORM data source + migration scripts, Husky + commitlint gates.

---

## 1. Domain model & schema (the foundation — approved before any feature code)

### Core principle

The **append-only `capacity_ledger` is the source of truth**. `programs.reserved` is a cached
derived total that only ever changes in the same transaction as a ledger insert, guarded by an
atomic conditional update. DB constraints — not app code — enforce every invariant.

### Tables (one migration per phase that needs them)

**`programs`**

| column                  | type        | notes                                                                     |
| ----------------------- | ----------- | ------------------------------------------------------------------------- |
| id                      | uuid PK     |                                                                           |
| name                    | text        | for humans/demo                                                           |
| total_limit             | bigint      | minor units, `CHECK (total_limit >= 0)`                                   |
| reserved                | bigint      | cached derived total, `CHECK (reserved >= 0 AND reserved <= total_limit)` |
| base_currency           | char(3)     | ISO 4217                                                                  |
| applied_version         | bigint      | treasury version gate, default 0                                          |
| created_at / updated_at | timestamptz |                                                                           |

**`capacity_ledger`** (APPEND-ONLY; UPDATE/DELETE blocked by a DB trigger)

| column          | type                   | notes                                                       |
| --------------- | ---------------------- | ----------------------------------------------------------- |
| id              | uuid PK                |                                                             |
| program_id      | uuid FK                |                                                             |
| reservation_id  | uuid nullable          | link to reservation when applicable                         |
| entry_type      | enum                   | RESERVE, RELEASE, TREASURY_DELTA, RECONCILIATION_ADJUSTMENT |
| amount          | bigint                 | original amount, minor units, `CHECK (amount > 0)`          |
| currency        | char(3)                | original currency                                           |
| amount_base     | bigint                 | amount converted to program base currency                   |
| fx_rate         | numeric(18,8) nullable | null when currency == base                                  |
| fx_rate_as_of   | timestamptz nullable   | when the used rate was sourced                              |
| source          | enum                   | API, TREASURY                                               |
| idempotency_key | text **UNIQUE**        | the idempotency guarantee                                   |
| created_at      | timestamptz            |                                                             |

**`reservations`**

| column                   | type                  | notes                                                             |
| ------------------------ | --------------------- | ----------------------------------------------------------------- |
| id                       | uuid PK               |                                                                   |
| program_id               | uuid FK               |                                                                   |
| invoice_id               | text                  | **UNIQUE (program_id, invoice_id)** — one reservation per invoice |
| amount / currency        | bigint / char(3)      | as requested                                                      |
| amount_base              | bigint                | reserved against capacity in base currency                        |
| fx_rate / fx_rate_as_of  | numeric / timestamptz | persisted conversion evidence                                     |
| status                   | enum                  | RESERVED, RELEASED                                                |
| created_at / released_at | timestamptz           |                                                                   |

**`idempotency_keys`** (HTTP + Kafka dedupe)

| column                          | type        | notes                                                                             |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| key                             | text PK     | `Idempotency-Key` header or `treasury:<topic>:<partition>:<offset>` / message key |
| request_hash                    | text        | detect same-key-different-body replays → 409 Conflict                             |
| response_status / response_body | int / jsonb | replay the original response on duplicate                                         |
| created_at                      | timestamptz |                                                                                   |

**`fx_rates`** (static, seeded by migration — see §5)

| column       | type          | notes                                       |
| ------------ | ------------- | ------------------------------------------- |
| base / quote | char(3)       | PK (base, quote)                            |
| rate         | numeric(18,8) | multiply: amount_quote * rate = amount_base |
| as_of        | timestamptz   |                                             |

### The atomic capacity operation (the heart of the service)

```sql
-- inside ONE transaction, bound params only:
UPDATE programs
   SET reserved = reserved + $1, updated_at = now()
 WHERE id = $2
   AND reserved + $1 <= total_limit;
-- rowCount = 0  →  InsufficientCapacityError (or 404 if program missing) — abort, no ledger row.
-- rowCount = 1  →  INSERT reservations row + INSERT capacity_ledger row, commit.
```

Release (also one transaction):

```sql
UPDATE reservations SET status = 'RELEASED', released_at = now()
 WHERE id = $1 AND status = 'RESERVED';           -- rowCount 0 → already released / not found
UPDATE programs SET reserved = reserved - $amount_base WHERE id = $program_id;
-- + ledger row (RELEASE), same tx. reserved >= 0 CHECK backstops accounting bugs.
```

TypeScript side: all money math on `bigint` (TypeORM bigint columns kept as strings, converted
via a small `Money` value object — amount `bigint` + currency, no bare numbers anywhere).

---

## 2. Phases

### Phase 1 — schema, migrations, money value object

- Migration: all tables above (except `fx_rates`, seeded in Phase 5) + append-only trigger on ledger.
- `Money` value object (`bigint` + ISO currency, parse-from-string, add/subtract with currency check).
- Unit tests: Money arithmetic, currency-mismatch rejection, string parsing edge cases.
- Commits: `feat(db): add program, ledger, reservation and idempotency schema`,
  `feat(common): add money value object with bigint minor units`

### Phase 2 — atomic reservation + release (the core)

- `POST /programs` (minimal create — needed to demo/test everything else),
  `POST /programs/:id/reservations`, `POST /reservations/:id/release`.
- `Idempotency-Key` header required on mutations (guard); replay returns stored response;
  same key + different body → 409.
- Typed domain errors → HTTP mapping: `InsufficientCapacityError` → 409,
  `DuplicateOperationError` → replay/409, `ProgramNotFoundError` → 404.
- **Mandatory concurrency integration test** (Testcontainers Postgres, real migrations):
  N parallel reservations exceeding the limit — assert exact number succeed, `reserved` never
  exceeds `total_limit`.
- Idempotency test: same request twice → one ledger row. Release test: capacity returns;
  double release is safe.
- Commits: `feat(reservations): add atomic capacity reservation and release`,
  `feat(idempotency): enforce idempotency-key on mutations`,
  `test(reservations): add concurrent oversubscription integration test`

### Phase 3 — availability query

- `GET /programs/:id/availability` → `{ programId, currency, totalLimit, reserved, available, version }`
  (amounts as strings of minor units — never JSON numbers).
- e2e test incl. 401 without token.
- Commit: `feat(programs): add availability endpoint`

### Phase 4 — Kafka treasury consumer (deltas + reconciliation snapshots)

- Dedicated `kafkajs` consumer service (not `@nestjs/microservices`) — we need manual offset
  commit AFTER the DB transaction commits. At-least-once + idempotent handler = effectively-once.
- Message envelope (documented in README): `type: CAPACITY_DELTA | RECONCILIATION_SNAPSHOT`,
  `programId`, `version`, payload, `idempotencyKey`. Validated with class-validator; malformed
  → DLQ topic with reason, then ack.
- Processing per message, in ONE transaction: dedupe on idempotency key → version gate
  (`SELECT ... FOR UPDATE`, skip if `version <= applied_version`) → apply + ledger row +
  advance `applied_version` → commit → commit offset.
- Snapshot application: set totals to snapshot state; the difference is recorded as an
  append-only `RECONCILIATION_ADJUSTMENT` ledger entry (audit trail preserved).
- Transient failure (DB down): don't ack, let Kafka redeliver. Poison: DLQ + ack.
- Integration tests (Testcontainers Kafka + Postgres): delta applied, duplicate skipped,
  stale snapshot ignored, snapshot-then-older-delta ignored.
- Commits: `feat(treasury): add kafka consumer for capacity deltas`,
  `feat(treasury): apply version-gated reconciliation snapshots`,
  `test(treasury): cover duplicate, stale and out-of-order messages`

### Phase 5 — multi-currency (FX)

- Decision (goes to DECISIONS.md §6): **convert at reservation time using a static seeded rate
  table; persist `fx_rate` + `as_of` on both reservation and ledger row.** Rationale: the task
  explicitly says invoices may be denominated differently, so rejecting would dodge the
  requirement; a live rate feed is out of scope, a seeded table shows the correct mechanics.
- Rounding: converted minor units rounded **half-up**, documented; math via `bigint` scaled
  arithmetic (rate stored as numeric string, applied with integer math — no floats anywhere).
- No rate available → 422 `UnsupportedCurrencyPairError`. Release always releases `amount_base`
  recorded at reservation time (no re-conversion — no FX drift on release).
- Unit tests: conversion rounding edges, missing pair rejection.
- Commit: `feat(fx): convert cross-currency reservations with persisted rate`

### Phase 6 — hardening & docs

- README: full local walkthrough — get a token, curl each endpoint, publish a test Kafka message
  (`docker compose exec kafka ...` one-liner), run tests. A short `scripts/publish-test-message.mjs`
  helper for the Kafka demo.
- DECISIONS.md: fill every open decision with what was actually implemented.
- Final pass: log hygiene (no secrets/amount tampering), error responses never leak stack traces.
- Commits: `docs(readme): add local run and demo walkthrough`, `docs: finalize decision log`

---

## 3. Testing summary (what proves this is production-grade)

| test                                        | proves                                          |
| ------------------------------------------- | ----------------------------------------------- |
| concurrent reservations (Testcontainers PG) | no oversubscription — the atomic invariant      |
| same Idempotency-Key twice                  | exactly one effect, response replayed           |
| same key, different body                    | 409 Conflict                                    |
| stale snapshot (v3 after v5)                | ignored, state unchanged                        |
| snapshot v10 then delta v8                  | delta ignored — version gate wins               |
| cross-currency reservation                  | converted with persisted rate, correct rounding |
| reserve → release                           | availability restored; double release safe      |
| unauthenticated request                     | 401 on every non-public route                   |

---

## 4. Ideas for improvement (documented, deliberately NOT implemented)

- **Transactional outbox** for emitting our own events (we currently only consume).
- **OpenAPI/Swagger** generation from DTOs.
- **Asymmetric JWT (RS256) / external IdP** instead of shared HS256 secret.
- **Rate limiting** (`@nestjs/throttler`) on mutating endpoints.
- **Live FX feed** with rate staleness policy instead of the seeded table.
- **Schema registry (Avro/Protobuf)** for Kafka contracts instead of JSON + class-validator.
- **Metrics/observability**: Prometheus counters for reservations, DLQ depth, consumer lag.
- **Periodic ledger-vs-cache consistency job** asserting `SUM(ledger) == programs.reserved`.
- **NUMERIC(38,0)** money columns if a program could ever exceed bigint minor units.
