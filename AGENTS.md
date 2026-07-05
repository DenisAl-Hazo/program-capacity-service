# AGENTS.md

**Project: Program Capacity Service** (package: `program-capacity-service`, handle: `pcs`)

High-level orientation for AI agents working in this repo. Detailed, file-scoped rules live in
`.cursor/rules/`. This file is the "how this project thinks" summary.

## Stack (pinned)
NestJS + TypeScript (strict) · PostgreSQL via TypeORM · Kafka (kafkajs) · Jest + Testcontainers ·
Docker + docker-compose. Single `dev` branch, Conventional Commits via Husky + commitlint, no CI/CD.

## What this service does
Tracks a financing program's credit capacity in real time. Invoices reserve capacity when approved
for early payment and release it when repaid. An external treasury system also feeds capacity changes
over Kafka, including periodic full-state reconciliation snapshots. Programs and invoices may be in
different currencies. All endpoints are authenticated. Runs locally via docker-compose.

## Non-negotiables (the whole point of the exercise)
1. Money is integer minor units + explicit currency. Never floats.
2. Capacity reservation is atomic at the DB level — no read-modify-write races, no oversubscription.
3. Every mutation (HTTP and Kafka) is idempotent, guaranteed by a unique constraint.
4. Reconciliation snapshots are version-gated; stale/out-of-order snapshots are ignored.
5. Multi-currency is explicit: convert-with-stored-rate OR reject — never silently mix.

The capacity ledger is append-only and is the source of truth. Derived totals must only change
inside the same transaction as the ledger write.

## Working agreement
- Propose the schema + the atomic capacity operation BEFORE writing feature code; get it right first.
- Ship migrations and tests with every feature. The concurrency test is mandatory.
- Record every assumption or trade-off in DECISIONS.md as you go — the task explicitly asks for this.
- Prefer boring and verifiable over clever. This is money.

## Local run (target)
- `docker-compose up` brings Postgres + Kafka + app.
- `.env` from `.env.example`. Migrations run on boot or via an explicit script.
- README documents: how to auth (get a token), how to hit each endpoint, how to publish a test
  Kafka message, and how to run tests.

## Suggested build order
1. Config + auth guard + health.
2. Program + ledger schema + migrations.
3. Atomic reservation + release (with the concurrency test) — the core.
4. Availability query.
5. Kafka consumer: deltas, then reconciliation snapshots with version gating.
6. FX handling for cross-currency.
7. Harden: idempotency edges, DLQ, logging, README, DECISIONS.md.
