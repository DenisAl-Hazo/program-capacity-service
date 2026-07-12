# Program Capacity Service

Tracks a financing program's credit capacity in real time. Invoices reserve capacity when approved
for early payment and release it when repaid. An external treasury system feeds capacity updates over
Kafka, including periodic full-state reconciliation snapshots. Programs and invoices may be in
different currencies. All endpoints are authenticated. Runs locally via Docker Compose.

Package: `program-capacity-service` · handle: `pcs`

## TL;DR

One service, five endpoints, one Kafka topic. What it guarantees:

- **Integer money** — amounts are `bigint` minor units (cents) end-to-end; strings on the wire; FX
  is pure scaled-bigint math with documented half-up rounding. No floats, ever.
- **No oversubscription** — the capacity check and the write are a single conditional `UPDATE`;
  proven by a 20-parallel-writers test. A DB CHECK constraint backstops even future app bugs.
- **Idempotent everything** — HTTP mutations (`Idempotency-Key` header: replay same request,
  409 on key reuse) and Kafka messages (dedupe + version gate) — enforced by unique constraints
  committed in the same transaction as the effect.
- **Multi-currency** — invoices convert at reservation time with a persisted rate + timestamp;
  release returns exactly what was held (no FX drift); unknown pairs rejected (422 / DLQ).
- **Treasury reconciliation** — deltas and full-state snapshots over Kafka, version-gated,
  applied effectively-once (manual offset commit after the DB transaction), poison → DLQ.
- **Audit trail** — append-only `capacity_ledger` (trigger-enforced); `SUM(amount_base)` always
  equals the cached `reserved`.
- **Authenticated** — global JWT guard (deny-by-default), `/health` is the only public route.

**Try it in 2 minutes:** `docker compose up --build` → open [Swagger UI](http://localhost:3000/docs)
→ authorize with `npm run token:dev` → drive the whole lifecycle from the browser.

### Documentation map

| Document                                                             | TL;DR                                                                                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [DECISIONS.md](DECISIONS.md)                                         | Every design decision with its trade-off and what actually landed — money representation, concurrency, idempotency, reconciliation ordering, FX policy, auth |
| [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)               | Annotated repo map: every folder/file, what it does, and the exact order a request travels through the NestJS pipeline                                       |
| [docs/STARTUP.md](docs/STARTUP.md)                                   | Step-by-step local guide: setup, migrations, JWT, exercising the API, Kafka publishing, DBeaver, troubleshooting                                             |
| [docs/SCALING_AND_IMPROVEMENTS.md](docs/SCALING_AND_IMPROVEMENTS.md) | What's deliberately out of scope and how it would be built: security hardening, live FX, caching, partitioning/sharding, CQRS reads                          |
| [docs/BOTTLENECKS.md](docs/BOTTLENECKS.md)                           | Where the throughput ceiling actually is today: hot-program row locks, single-node Kafka, unbounded ledger growth, and an unkeyed-message ordering risk      |
| [docs/DEMO_WALKTHROUGH.md](docs/DEMO_WALKTHROUGH.md)                 | A linear, copy-pasteable script proving every feature works via Swagger UI + Kafka UI alone — no terminal required                                           |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)                 | The original phase-by-phase implementation plan (kept for context; status: implemented)                                                                      |

### Table of contents

- [Tech stack — what and why](#tech-stack--what-and-why)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [API walkthrough](#api-walkthrough)
- [Kafka: treasury ingestion](#kafka-treasury-ingestion)
- [Tests](#tests)
- [Database](#database)
- [Core invariants](#core-invariants-the-point-of-the-exercise)
- [Assumptions & trade-offs](#assumptions--trade-offs)

## Tech stack — what and why

| Instrument                                | Role                         | Why this one                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **NestJS** (strict TypeScript)            | HTTP framework, DI container | Modular architecture (guards, pipes, interceptors, filters, middleware) maps 1:1 onto the cross-cutting concerns this service needs: auth, validation, idempotency, error mapping, correlation ids                 |
| **PostgreSQL 16**                         | System of record             | ACID transactions carry the core invariant: the capacity check and the ledger write commit atomically or not at all. CHECK constraints, unique indexes and a trigger enforce the rules even against buggy app code |
| **TypeORM**                               | Entities + migrations        | Schema is versioned in `src/database/migrations/` (`synchronize` is off everywhere); raw SQL is used deliberately where precision matters (atomic conditional UPDATE, `ON CONFLICT` dedupe)                        |
| **Kafka** (`kafkajs`, dedicated consumer) | Treasury ingestion           | A hand-rolled consumer (not `@nestjs/microservices`) so offsets are committed manually **after** the DB transaction — at-least-once delivery + idempotent processor = effectively-once application                 |
| **Passport + JWT**                        | AuthN                        | Global `JwtAuthGuard` via `APP_GUARD`; `@Public()` opt-out for `/health`. Validates signature, expiry, issuer, audience                                                                                            |
| **Joi** (`@nestjs/config`)                | Config validation            | The app fails fast at boot on missing/invalid env vars instead of failing at 3am on the first request                                                                                                              |
| **nestjs-pino**                           | Structured logging           | JSON logs with a correlation id per request; `Authorization` header redacted                                                                                                                                       |
| **Jest + Testcontainers**                 | Tests                        | Unit tests for money/FX math; integration tests against **real Postgres** (the concurrency test is the whole point); e2e over HTTP with Supertest                                                                  |
| **Docker Compose**                        | Local runtime                | One command brings up Postgres, Kafka (KRaft, no ZooKeeper), Kafka UI, and the app                                                                                                                                 |
| **Husky + commitlint**                    | Git hygiene                  | Conventional Commits enforced on a single `dev` branch                                                                                                                                                             |

### NestJS building blocks used (where to look)

- **Middleware** — `CorrelationIdMiddleware` (`src/common/middleware/`): correlation id per request.
- **Guard** — `JwtAuthGuard` (`src/auth/`): global auth, `@Public()` opt-out.
- **Pipes** — global `ValidationPipe` (whitelist + forbidNonWhitelisted) + `ParseUUIDPipe` on params.
- **Interceptor** — `IdempotencyInterceptor` (`src/idempotency/`): enforces the `Idempotency-Key` header and replays stored responses.
- **Exception filter** — `GlobalExceptionFilter` (`src/common/filters/`): domain errors → HTTP codes, internals never leak.
- **Custom decorators** — `@Public()`, `@IdempotencyKeyParam()`.

## Quick start

```bash
cp .env.example .env
npm install
docker compose up -d postgres kafka kafka-ui   # infra only
npm run migration:run
npm run start:dev                              # app on http://localhost:3000
```

Or run everything (app included) in Docker — migrations are applied automatically before the
app starts, so a clean database works out of the box:

```bash
cp .env.example .env
docker compose up --build
```

Health (no auth): `GET http://localhost:3000/health`
Swagger UI (interactive API console): http://localhost:3000/docs
Kafka UI (topics, messages, consumer lag): http://localhost:8080

## Authentication

Every route except `/health` requires a bearer token.

```bash
TOKEN=$(npm run token:dev --silent)      # signs a JWT with JWT_* from .env
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/programs/<id>/availability
```

Invalid/missing tokens receive `401`. See DECISIONS.md §7 for the trade-off (HS256 local vs IdP in prod).

## API walkthrough

All mutations require an `Idempotency-Key` header (any unique string ≤ 255 chars; retries must
resend the same key + body). Amounts are **strings of integer minor units** (cents), never JSON numbers.

Prefer a UI? **Swagger UI at http://localhost:3000/docs** documents every route and can drive the
whole lifecycle from the browser (click _Authorize_ and paste the token from `npm run token:dev`;
each mutation form has an `Idempotency-Key` field).

```bash
TOKEN=$(npm run token:dev --silent)
AUTH="Authorization: Bearer $TOKEN"

# 1. Create a program with 1,000,000 USD-cents ($10,000) of capacity
curl -s -X POST http://localhost:3000/programs \
  -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"acme-q3","totalLimit":"1000000","baseCurrency":"USD"}'
# -> { "programId": "...", "available": "1000000", ... }

# 2. Reserve capacity for an invoice (EUR invoice on a USD program: converted with the stored rate)
curl -s -X POST http://localhost:3000/programs/<programId>/reservations \
  -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"invoiceId":"INV-001","amount":"10000","currency":"EUR"}'
# -> { "reservationId": "...", "amountBase": "10865", "fxRate": "1.08650000", ... }

# 3. Check availability
curl -s -H "$AUTH" http://localhost:3000/programs/<programId>/availability
# -> { "totalLimit": "1000000", "reserved": "10865", "available": "989135", ... }

# 4. Release when the invoice is repaid (returns EXACTLY the amount held — no FX drift)
curl -s -X POST http://localhost:3000/reservations/<reservationId>/release \
  -H "$AUTH" -H "Idempotency-Key: $(uuidgen)"
```

| Endpoint                          | Auth                  | Notes                                                             |
| --------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `GET /health`                     | public                | liveness + Postgres ping                                          |
| `POST /programs`                  | JWT + Idempotency-Key | create a program                                                  |
| `POST /programs/:id/reservations` | JWT + Idempotency-Key | atomic capacity check; `409` when full, `422` for unknown FX pair |
| `POST /reservations/:id/release`  | JWT + Idempotency-Key | `409` on double release                                           |
| `GET /programs/:id/availability`  | JWT                   | total / reserved / available + applied treasury version           |

## Kafka: treasury ingestion

Topic `treasury.capacity.events` (poison messages go to `treasury.capacity.dlq`).
Two message types, both version-gated per program (stale versions are ignored):

```jsonc
// Delta
{ "type": "CAPACITY_DELTA", "programId": "<uuid>", "version": 7,
  "delta": { "direction": "RESERVE", "amount": "50000", "currency": "USD" } }

// Full-state reconciliation snapshot (replaces totals, writes an adjustment ledger row)
{ "type": "RECONCILIATION_SNAPSHOT", "programId": "<uuid>", "version": 8,
  "snapshot": { "totalLimit": "2000000", "reserved": "120000", "baseCurrency": "USD" } }
```

Publish a test message from inside the Kafka container:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server localhost:9092 --topic treasury.capacity.events <<'EOF'
{"type":"CAPACITY_DELTA","programId":"<programId>","version":1,"delta":{"direction":"RESERVE","amount":"50000","currency":"USD"}}
EOF
```

Watch it land in **Kafka UI → http://localhost:8080** (topics, messages, consumer group lag), then
confirm via the availability endpoint.

## Tests

```bash
npm test                       # unit: money & FX math, guard, message validation
npm run test:integration       # real Postgres via Testcontainers (Docker must be running):
                               #   - 20 parallel writers cannot oversubscribe (the core invariant)
                               #   - idempotency replay/conflict, duplicate invoice
                               #   - treasury dedupe, version gating, snapshots, poison messages
                               #   - cross-currency conversion + exact-release
docker compose up -d postgres  # e2e needs the compose Postgres
npm run test:e2e               # full HTTP lifecycle through the real AppModule
```

## Database

Schema is created by migrations. Outside Docker they are an explicit step (`npm run migration:run`);
the Docker image runs any pending migrations automatically before starting the app (see the
`Dockerfile` CMD), so `docker compose up --build` works against a clean volume. Key tables:

- `programs` — capacity + cached `reserved` total, `applied_version` for treasury gating. A CHECK
  constraint makes oversubscription impossible even if app code regresses.
- `reservations` — one lifecycle per invoice (`UNIQUE (program_id, invoice_id)`).
- `capacity_ledger` — append-only (enforced by trigger); `SUM(amount_base) = programs.reserved` at all times.
- `idempotency_keys` — processed HTTP requests + Kafka messages; the PK is the dedupe guarantee.
- `fx_rates` — static seeded rates (see DECISIONS.md §6).

Connect with any client at `postgres://pcs:pcs@localhost:5432/pcs` (DBeaver: new PostgreSQL
connection, host `localhost`, port `5432`, db/user/password `pcs`).

## Core invariants (the point of the exercise)

1. Money is integer minor units (`bigint`) + explicit currency. Never floats — FX math is scaled bigint.
2. Capacity reservation is atomic at the DB level (one conditional `UPDATE`) — no oversubscription under concurrency.
3. Every mutation (HTTP + Kafka) is idempotent, enforced by unique constraints in the same transaction as the effect.
4. Reconciliation snapshots are version-gated; stale/out-of-order ones are ignored.
5. Multi-currency is explicit: convert with a stored, persisted rate — or reject unknown pairs.

## Assumptions & trade-offs

Every decision point is recorded in [DECISIONS.md](DECISIONS.md) — see the
[documentation map](#documentation-map) at the top for the full set of docs.
Git workflow: Conventional Commits on `dev`, enforced by Husky + commitlint.
Detailed engineering rules: `.cursor/rules/`.
