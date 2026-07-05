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

## 3. Concurrency control
Decision: atomic conditional `UPDATE ... WHERE reserved + :amt <= total_limit`, check affected rows.
Trade-off: lock-free and fast; requires the cached-total approach. `SELECT FOR UPDATE` is the
alternative if we recompute from the ledger each time.

## 4. Idempotency
Decision: unique constraint on `idempotency_key` in ledger + `processed_messages`; HTTP mutations
require an `Idempotency-Key` header; Kafka uses message key or partition+offset.
Trade-off: requires clients to send keys; we reject same-key-different-body replays as a conflict.

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
