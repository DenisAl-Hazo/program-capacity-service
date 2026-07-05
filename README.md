# Program Capacity Service

Tracks a financing program's credit capacity in real time. Invoices reserve capacity when approved
for early payment and release it when repaid. An external treasury system feeds capacity updates over
Kafka, including periodic full-state reconciliation snapshots. Programs and invoices may be in
different currencies. All endpoints are authenticated. Runs locally via Docker Compose.

Package: `program-capacity-service` · handle: `pcs`

## Stack
NestJS + TypeScript (strict) · PostgreSQL via TypeORM · Kafka (kafkajs) · Jest + Testcontainers ·
Docker + Docker Compose. Single `dev` branch, Conventional Commits (Husky + commitlint), no CI/CD.

## Quick start

```bash
cp .env.example .env
npm install
docker compose up -d          # Postgres + Kafka (+ app)
npm run start:dev             # local dev against compose infra
```

Or run everything in Docker:

```bash
cp .env.example .env
docker compose up --build
```

Health (no auth): `GET http://localhost:3000/health`

## Authentication

Every route is protected by a global JWT guard. Opt out per-route with `@Public()` (used by `/health`).

1. Ensure `.env` contains `JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE` (see `.env.example`).
2. Generate a dev token:

```bash
npm run token:dev
# optional subject: npm run token:dev -- my-service-account
```

3. Call protected endpoints with the bearer token:

```bash
TOKEN=$(npm run token:dev --silent)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/some-future-route
```

Tokens are validated for signature, expiry, issuer, and audience. Invalid or missing tokens receive `401`.

## Configuration

All config is loaded from environment variables and validated at boot with Joi. See `.env.example`.
The app fails fast on startup if required values are missing or invalid.

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `KAFKA_BROKERS` | Comma-separated broker list |
| `JWT_*` | Bearer token signing and validation |

## Migrations

TypeORM migrations live in `src/database/migrations/`. `synchronize` is disabled everywhere.

```bash
npm run migration:run
npm run migration:revert
```

## Tests

```bash
npm test                      # unit tests
docker compose up -d postgres # required for e2e DB health check
npm run test:e2e
```

## Core invariants (see `.cursor/rules/` for the full spec)

1. Money is integer minor units + explicit currency. Never floats.
2. Capacity reservation is atomic at the DB level — no oversubscription under concurrency.
3. Every mutation (HTTP + Kafka) is idempotent, enforced by a unique constraint.
4. Reconciliation snapshots are version-gated; stale/out-of-order ones are ignored.
5. Multi-currency is explicit: convert-with-stored-rate OR reject.

## Endpoints (planned — all authenticated except health)

- `GET  /health` — liveness + Postgres ping (public)
- `POST /programs/:id/reservations` — reserve capacity
- `POST /reservations/:id/release` — release capacity
- `GET  /programs/:id/availability` — current total / reserved / available

## Assumptions & trade-offs

See `DECISIONS.md`.

## Development

Git workflow and commit conventions: `GIT_SETUP.md`. Detailed engineering rules: `.cursor/rules/`.
