# Project structure

Annotated map of the repository: what lives where, and the path a request travels.
Companion docs: [README](../README.md) (run & use), [DECISIONS.md](../DECISIONS.md) (why),
[STARTUP.md](STARTUP.md) (step-by-step local guide).

## The 30-second version

```
src/
├── main.ts                 bootstrap: logger, global validation, Swagger (/docs), listen
├── app.module.ts           root module — imports every feature module, zero logic
├── config/                 env validation (Joi) + typed AppConfig — app dies at boot if misconfigured
├── common/                 cross-cutting: money value object, domain errors, exception filter,
│                           correlation-id middleware, pino logging, bigint & pg-error helpers
├── auth/                   global JWT guard (deny-by-default), passport strategy, @Public() opt-out
├── database/               TypeORM CLI data source + hand-written SQL migrations (the schema truth)
├── programs/               POST /programs, GET /programs/:id/availability
├── reservations/           POST reserve / release — the atomic capacity check lives here
├── ledger/                 append-only capacity_ledger entity (written by others, no API of its own)
├── idempotency/            Idempotency-Key machinery: interceptor (fast path), service (hash+replay),
│                           entity (the PK that IS the guarantee)
├── fx/                     currency conversion: pure-bigint math, seeded fx_rates table
├── treasury/               Kafka: consumer (plumbing, manual offsets, DLQ) + processor (transactional apply)
└── health/                 GET /health — public, Terminus DB ping
test/
├── integration/            Testcontainers + real Postgres: concurrency, idempotency, treasury
└── *.e2e-spec.ts           real HTTP through the full AppModule (Supertest)
```

## Root files

| File                                                     | Purpose                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `package.json`                                           | scripts (`start:dev`, `migration:run`, `test*`, `token:dev`) + dependencies                     |
| `docker-compose.yml`                                     | Postgres 16, Kafka (KRaft), Kafka UI, app — healthchecks gate startup order                     |
| `Dockerfile`                                             | 2-stage build; CMD applies pending migrations, then starts the app                              |
| `.env.example` / `.env`                                  | configuration; validated by Joi at boot (see `src/config/`)                                     |
| `tsconfig*.json`                                         | strict TypeScript                                                                               |
| `eslint.config.mjs`, `.prettierrc`                       | lint + format (also run by git hooks)                                                           |
| `.husky/`, `commitlint.config.cjs`, `.lintstagedrc.json` | git hooks: commit-msg → commitlint, pre-commit → lint-staged + typecheck, pre-push → unit tests |
| `nest-cli.json`                                          | Nest build config + `@nestjs/swagger` plugin (derives API schemas from DTOs)                    |
| `scripts/generate-dev-token.mjs`                         | signs a local-dev JWT from `.env` (`npm run token:dev`)                                         |
| `README.md`, `DECISIONS.md`, `docs/`                     | documentation (see the map in the README)                                                       |

## `src/` — module by module

Each feature folder is a NestJS module: `*.module.ts` wires providers, `*.controller.ts` maps
routes, `*.service.ts` holds logic, `*.entity.ts` maps a table, `dto/` validates the wire format.

### config/

- `env.validation.ts` — Joi schema (fail-fast at boot) + typed `AppConfig` factory. Nothing else
  in the codebase reads `process.env` directly.
- `config.module.ts` — registers `@nestjs/config` with that schema.

### common/ (cross-cutting, no business logic)

- `money/money.ts` — immutable value object: `bigint` minor units + ISO 4217 currency. Rejects
  floats/negatives at construction; refuses cross-currency arithmetic.
- `errors/domain-error.ts` — one error class per business failure; services throw these, never
  HTTP exceptions.
- `filters/global-exception.filter.ts` — maps domain errors → 404/409/422/400; unknown errors →
  opaque 500 (logged with stack, never leaked to the client).
- `middleware/correlation-id.middleware.ts` — accepts or generates `x-correlation-id`; echoed on
  responses and attached to every log line.
- `database/bigint.transformer.ts` — Postgres BIGINT ↔ JS `bigint` (money never touches `number`).
- `database/pg-errors.ts` — recognizes Postgres unique-violations by constraint name so services
  can map them to precise domain errors.
- `common.module.ts` — registers pino logging (`nestjs-pino`), the filter, the middleware.

### auth/

- `auth.module.ts` — registers the guard as `APP_GUARD`: **every** route requires a JWT unless it
  opts out. Secure by default.
- `jwt.strategy.ts` — verifies signature, expiry, issuer, audience (passport-jwt).
- `jwt-auth.guard.ts` — checks `@Public()` metadata, otherwise delegates to Passport.
- `public.decorator.ts` — the opt-out marker (used by `/health` only).

### database/

- `data-source.ts` — standalone DataSource for the TypeORM CLI; used by `npm run migration:run`
  and by the Docker entrypoint.
- `database.module.ts` — runtime connection; `synchronize: false`, `migrationsRun: false` —
  schema changes only via explicit migrations.
- `migrations/` — hand-written SQL. The initial migration carries the invariants: CHECK
  constraints (no oversubscription), the append-only trigger on `capacity_ledger`, unique keys
  (idempotency, one reservation per invoice). The second seeds `fx_rates`.

### programs/ · reservations/ · ledger/

- `programs.service.ts` — create program; read availability.
- `reservations.service.ts` — the heart of the service. `reserve()` and `release()` run one DB
  transaction each; `applyCapacityDelta()` is the single conditional UPDATE whose WHERE clause
  makes the capacity check and the write one atomic statement.
- `ledger/capacity-ledger-entry.entity.ts` — append-only audit trail; signed `amount_base` keeps
  `SUM(amount_base) = programs.reserved` verifiable at all times.
- DTOs — amounts are **strings** of integer minor units (`^[1-9]\d*$`), never JSON numbers.

### idempotency/

- `idempotency.interceptor.ts` — enforces the `Idempotency-Key` header on mutations; replays
  stored responses without invoking the handler (rxjs short-circuit). Fast path only.
- `idempotency.service.ts` — canonical request hash (recursively sorted keys), same-transaction
  result storage, replay-vs-conflict decision. The real guarantee is the table's primary key.
- `idempotency-key.entity.ts` — key (PK), request hash, frozen response status/body (jsonb).

### fx/

- `fx-conversion.ts` — pure bigint conversion: rate scaled to 8 decimals, multiply, round
  half-up. No floats anywhere.
- `fx.service.ts` — rate lookup; same-currency short-circuit; unknown pair → error (422 / DLQ).
- `fx-rate.entity.ts` — the seeded `fx_rates` table (static by design, see DECISIONS.md §6).

### treasury/

- `treasury.consumer.ts` — kafkajs plumbing: connect with retry (HTTP survives a dead broker),
  `autoCommit: false`, offsets committed **after** the DB transaction, poison → DLQ topic.
- `treasury.processor.ts` — transactional apply: dedupe insert → `FOR UPDATE` lock → version
  gate → effect + ledger + `applied_version` bump. Deltas and reconciliation snapshots.
- `dto/treasury-message.dto.ts` — schema validation of raw Kafka payloads; any defect →
  `PoisonMessageError`.

### health/

- `health.controller.ts` — `@Public()`; Terminus pings Postgres through the app's own pool.
  Kafka is deliberately not part of health (broker outage must not kill the HTTP API).

## The request pipeline (execution order)

```
HTTP request
 → CorrelationIdMiddleware   (common/)      stamp x-correlation-id
 → JwtAuthGuard              (auth/)        401 unless valid JWT or @Public()
 → IdempotencyInterceptor    (idempotency/) 400 without key; replay stored response; else proceed
 → ValidationPipe + DTO      (dto/)         reject bad shapes, unknown fields, non-string amounts
 → Controller → Service                     one DB transaction: effect + ledger + idempotency record
 → GlobalExceptionFilter     (common/)      only on error: domain error → HTTP code
```

Kafka messages skip the HTTP pipeline: `consumer → parse/validate → processor (one transaction)
→ commit offset`, with poison messages routed to the DLQ instead of blocking the partition.

## test/

- `src/**/*.spec.ts` — **unit**: pure logic (money, FX math, guard, message validation, hashing).
- `test/integration/` — **integration**: Testcontainers boots a real Postgres and runs real
  migrations; proves the 20-parallel-writers invariant, idempotency replay/conflict, treasury
  dedupe/version-gating/snapshots/poison handling.
- `test/*.e2e-spec.ts` — **e2e**: real HTTP against the full AppModule (guards, pipes,
  interceptors, filter) via Supertest; requires the compose Postgres.
- `test/jest-integration.json` / `test/jest-e2e.json` — suite configs (`--runInBand` for
  integration: the suites share containers).
