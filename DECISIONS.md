# DECISIONS.md

The task asks that assumptions and trade-offs be documented. Fill each of these in as you build.
Below are the decision points that WILL come up — with the recommended default and the trade-off,
so nothing is decided by accident.

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

## 5. Reconciliation / ordering

Decision: monotonic `version` per program; apply snapshot/delta only if `version > applied_version`,
compare-and-set under `FOR UPDATE`.
Trade-off: relies on treasury providing a monotonic version. If only timestamps are available, use
source timestamp with a documented tie-break.

## 6. Multi-currency

Decision: <choose> (a) reject reservations whose currency != program base currency, OR
(b) convert at reservation time and persist the FX rate + timestamp on the ledger row.
Trade-off: (a) is simplest and avoids FX-rounding disputes; (b) is more realistic but needs a rate
source and a defined rounding rule (round half-up on the converted minor units). RECORD which you chose.

## 7. Authentication

Decision: global `JwtAuthGuard`, `@Public()` opt-out for health. HS256 with a shared secret for local.
Trade-off: fine for a local PoC; production would use asymmetric keys / an IdP.

**Implemented (scaffold):** `AuthModule` registers `JwtAuthGuard` via `APP_GUARD`. `JwtStrategy`
validates signature, expiry, issuer, and audience. `GET /health` is `@Public()`. Dev tokens via
`npm run token:dev` (reads `JWT_*` from `.env`). Authorization header is redacted in request logs.

## 8. Snapshot vs ledger reconciliation

Decision: when a snapshot changes derived totals, record an append-only adjustment entry rather than
rewriting history.
Trade-off: preserves audit trail at the cost of an extra reconciliation entry to explain deltas.
