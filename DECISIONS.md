# DECISIONS.md

The task asks that assumptions and trade-offs be documented. Each section below is one decision
point: the decision taken, the trade-off it carries, and an **Implemented** note describing what
actually landed — so nothing was decided by accident.

## 1. Money representation

Decision: integer minor units stored as `BIGINT`, currency as ISO 4217 `CHAR(3)`.
Trade-off: `BIGINT` caps at ~9.2e18 minor units (ample for the stated $10M-scale program). If a
program could exceed 2^63 minor units, switch to `NUMERIC(38,0)`.

## 2. Source of truth for capacity

Decision: append-only `capacity_ledger`; `programs.reserved` is a cached derived total updated only
inside the reservation transaction.
Trade-off: caching the total makes the atomic conditional update simple and fast; correctness relies
on that column never being written outside the guarded transaction. Alternative (pure recompute from
ledger) is simpler to reason about but costlier per read.

**Implemented (phase 1):** ledger rows carry a signed `amount_base` — the exact delta applied to
`programs.reserved` in base currency (positive = consume, negative = free). This makes
`SUM(amount_base) == programs.reserved` a directly verifiable invariant. Sign is tied to
`entry_type` by a CHECK constraint; append-only is enforced by a DB trigger, not convention.
Treasury deltas reuse entry types RESERVE/RELEASE with `source = TREASURY` (no separate
TREASURY_DELTA type) — one code path, less to get wrong. Assumption: one reservation lifecycle
per invoice, enforced by UNIQUE (program_id, invoice_id).

## 3. Concurrency control

Decision: atomic conditional `UPDATE ... WHERE reserved + :amt <= total_limit`, check affected rows.
Trade-off: lock-free and fast; requires the cached-total approach. `SELECT FOR UPDATE` is the
alternative if we recompute from the ledger each time.

**Implemented (phase 2):** `ReservationsService.applyCapacityDelta` — one bound-parameter UPDATE
whose WHERE clause does the capacity check and the write in one statement; zero affected rows means
`InsufficientCapacityError` and the whole transaction (reservation + ledger row) rolls back.
Release uses the same statement with a negative delta plus `SELECT ... FOR UPDATE` on the
reservation row so double releases serialize. Proven by the 20-parallel-writers integration test.

## 4. Idempotency

Decision: unique constraint on `idempotency_key` in ledger + `processed_messages`; HTTP mutations
require an `Idempotency-Key` header; Kafka uses message key or partition+offset.
Trade-off: requires clients to send keys; we reject same-key-different-body replays as a conflict.

**Implemented (phase 2):** `IdempotencyInterceptor` enforces the header and replays stored
responses (fast path). The guarantee itself is the PK on `idempotency_keys` + the unique key on
`capacity_ledger`, written in the same transaction as the effect. On any error the service checks
whether the key was committed by a concurrent/previous attempt: same body -> replay stored
response; different body -> 409. Request hash = SHA-256 of the JSON body (assumes clients send
identical bodies for retries — reasonable for machine-generated retries).

**Refined (phase 6):** the request hash is canonical — `{ params, body }` serialized with
recursively sorted keys — computed identically by the interceptor (from the raw request) and by
the services (from route args + DTO). The e2e suite caught the original bug: the two sides hashed
different shapes, so an honest HTTP retry was misclassified as key reuse (409 instead of replay).
Key ordering must never affect idempotency decisions.

## 5. Reconciliation / ordering

Decision: monotonic `version` per program; apply snapshot/delta only if `version > applied_version`,
compare-and-set under `FOR UPDATE`.
Trade-off: relies on treasury providing a monotonic version. If only timestamps are available, use
source timestamp with a documented tie-break.

**Implemented (phase 4):** dedicated `kafkajs` consumer (not `@nestjs/microservices`) so offsets are
committed manually AFTER the DB transaction commits — at-least-once delivery + idempotent processor
= effectively-once application. Per message, in one transaction: dedupe insert (`ON CONFLICT DO
NOTHING`) -> `FOR UPDATE` lock -> version gate -> effect + ledger + `applied_version` bump.
Poison messages (bad schema, unknown program, capacity-impossible delta, self-inconsistent
snapshot) go to the DLQ topic with a reason and are acked; transient failures are rethrown without
committing the offset so Kafka redelivers. Treasury deltas must be in the program base currency
until the FX phase. `version` is a JSON integer (< 2^53) — acceptable for a sequence number.
If the broker is unreachable at boot in local dev, the HTTP API stays up and ingestion is disabled
(compose ordering guarantees the broker in the packaged setup).

## 6. Multi-currency

Decision: (b) convert at reservation time and persist the FX rate + timestamp on the ledger row.
Trade-off: (a) reject-on-mismatch is simplest and avoids FX-rounding disputes; (b) is more realistic
but needs a rate source and a defined rounding rule. We chose (b) because the task states invoices
MAY differ from the program currency — rejecting would fail the stated requirement.

**Implemented (phase 5):**

- `fx_rates` table seeded by migration with USD/EUR/GBP cross rates. A live rate feed is out of
  scope; the mechanics (persisted rate + `as_of` timestamp, deterministic rounding) are what matter.
  Unknown pairs are rejected: HTTP `422`, Kafka -> DLQ (an unknown pair can never succeed, so it is
  poison, not transient).
- Conversion is pure bigint math (`convertMinorUnits`): the rate is scaled to 8 decimals, multiply,
  then **round half-up** on the converted minor units. No floats anywhere in the path.
- The reservation stores `amount`+`currency` (original), `amount_base` (converted), `fx_rate`, and
  `fx_rate_as_of`. Release returns EXACTLY `amount_base` — the rate is read once at reservation
  time, so later rate changes cannot leak or strand capacity (no FX drift).
- Treasury deltas in a non-base currency convert the same way with the same persisted evidence.
  Snapshots must be in the program base currency (a base-currency change is a different, rarer
  operation that deserves an explicit migration path, not a snapshot side effect).

## 7. Authentication

Decision: global `JwtAuthGuard`, `@Public()` opt-out for health. HS256 with a shared secret for local.
Trade-off: fine for a local PoC; production would use asymmetric keys / an IdP.

**Implemented (scaffold):** `AuthModule` registers `JwtAuthGuard` via `APP_GUARD`. `JwtStrategy`
validates signature, expiry, issuer, and audience. `GET /health` is `@Public()`. Dev tokens via
`npm run token:dev` (reads `JWT_*` from `.env`). Authorization header is redacted in request logs.

**Not implemented (intentional):** refresh tokens / `POST /auth/refresh`. Production would use
OAuth2/OIDC (Auth0, Keycloak) or a refresh-token rotation endpoint; the UI calls refresh on 401
(expiry only) and redirects to login on refresh failure. See `docs/STARTUP.md` §5.

## 8. Snapshot vs ledger reconciliation

Decision: when a snapshot changes derived totals, record an append-only adjustment entry rather than
rewriting history.
Trade-off: preserves audit trail at the cost of an extra reconciliation entry to explain deltas.

**Implemented (phase 4):** `applySnapshot` sets `total_limit`/`reserved` to the snapshot state and
writes a `RECONCILIATION_ADJUSTMENT` ledger row for the reserved delta (skipped when zero), so
`SUM(amount_base) == reserved` still holds after reconciliation. Every applied/skipped snapshot is
logged with old/new state for auditability.
