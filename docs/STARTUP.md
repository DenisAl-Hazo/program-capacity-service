# Startup guide — Program Capacity Service

Step-by-step instructions to run the service locally, connect tools, exercise the API,
and inspect Kafka. For architecture decisions see `DECISIONS.md`; for the build plan see
`docs/DEVELOPMENT_PLAN.md`.

## Prerequisites

- **Node.js 20+** (22 recommended for latest testcontainers; v10 works on Node 20)
- **Docker Desktop** (Postgres, Kafka, Kafka UI)
- **npm** (ships with Node)

## 1. First-time setup

```bash
cp .env.example .env
npm install
```

Edit `.env` only if your ports differ. Defaults assume compose Postgres on `5432` and Kafka
on host port **9094** (internal docker network uses `kafka:9092`).

## 2. Start infrastructure

```bash
docker compose up -d postgres kafka kafka-ui
```

| Service   | Host URL / port        | Purpose                          |
|-----------|------------------------|----------------------------------|
| Postgres  | `localhost:5432`       | System of record                 |
| Kafka     | `localhost:9094`     | Treasury ingestion (host dev)    |
| Kafka UI  | http://localhost:8080  | Browse topics, messages, lag     |

Wait until healthy:

```bash
docker compose ps
```

## 3. Database migrations

```bash
npm run migration:run
```

Creates `programs`, `reservations`, `capacity_ledger`, `idempotency_keys`, `fx_rates`
(seeded with USD/EUR/GBP cross rates).

## 4. Run the app

**Option A — local Node (recommended for development):**

```bash
npm run start:dev
```

App: http://localhost:3000  
Health (public): http://localhost:3000/health

**Option B — everything in Docker:**

```bash
docker compose up --build
```

## 5. Get a JWT

Every route except `/health` requires `Authorization: Bearer <token>`.

```bash
npm run token:dev
# or with a custom subject:
npm run token:dev -- my-service-account
```

Token is signed with `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` from `.env` (default TTL 1h).

### JWT expiry and refresh (not implemented — how production would handle it)

This PoC uses **short-lived access tokens only** (no refresh endpoint). That is
deliberate scope control. In production with a UI:

1. **Access token** (what we have): short TTL (15–60 min), sent on every API call.
   When expired the API returns **401** with a clear body (we do not return 403 for expiry).
2. **Refresh token**: long-lived, **httpOnly secure cookie** or stored server-side; never
   in localStorage if you can avoid it.
3. **UI flow**: on 401 (and only when the failure is expiry, not bad credentials), the client
   calls `POST /auth/refresh` with the refresh token; backend validates it, rotates it,
   returns a new access token. If refresh fails → redirect to login.
4. **Industrial standard**: OAuth 2.0 / OpenID Connect via an IdP (Auth0, Keycloak, Cognito).
   The UI uses the authorization-code + PKCE flow; our service validates JWTs via JWKS
   (RS256), not a shared HS256 secret.

We document this pattern here so reviewers know the gap is intentional, not an oversight.

## 6. Exercise the API

```bash
TOKEN=$(npm run token:dev --silent)
AUTH="Authorization: Bearer $TOKEN"

# Create program ($10,000 USD capacity = 1_000_000 cents)
curl -s -X POST http://localhost:3000/programs \
  -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"demo","totalLimit":"1000000","baseCurrency":"USD"}'

# Reserve (EUR invoice on USD program — converted at seeded rate)
curl -s -X POST http://localhost:3000/programs/<programId>/reservations \
  -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"invoiceId":"INV-1","amount":"10000","currency":"EUR"}'

# Availability
curl -s -H "$AUTH" http://localhost:3000/programs/<programId>/availability

# Release
curl -s -X POST http://localhost:3000/reservations/<reservationId>/release \
  -H "$AUTH" -H "Idempotency-Key: $(uuidgen)"
```

All mutating endpoints require **`Idempotency-Key`**. Retries must reuse the same key and body.

## 7. Kafka — publish and inspect

**Kafka UI:** open http://localhost:8080 → cluster `local` → Topics →
`treasury.capacity.events` (messages, consumer group `pcs-treasury-consumer`, lag).

**Script helper** (host app must be running with `KAFKA_BROKERS=localhost:9094`):

```bash
node scripts/publish-test-message.mjs <programId> 1
```

**Manual publish** from inside the Kafka container:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server localhost:9092 --topic treasury.capacity.events <<'EOF'
{"type":"CAPACITY_DELTA","programId":"<uuid>","version":2,"delta":{"direction":"RESERVE","amount":"50000","currency":"USD"}}
EOF
```

Poison messages land in `treasury.capacity.dlq` (visible in Kafka UI).

## 8. Connect DBeaver (or any SQL client)

| Field    | Value        |
|----------|--------------|
| Host     | `localhost`  |
| Port     | `5432`       |
| Database | `pcs`        |
| User     | `pcs`        |
| Password | `pcs`        |

JDBC: `jdbc:postgresql://localhost:5432/pcs`

Useful sanity queries:

```sql
SELECT id, total_limit, reserved, base_currency, applied_version FROM programs;
SELECT entry_type, amount, currency, amount_base, source FROM capacity_ledger ORDER BY created_at;
SELECT * FROM fx_rates;
```

## 9. Tests

```bash
npm test                    # unit: money, FX math, guards, message schema
npm run test:integration    # Testcontainers Postgres (Docker required)
docker compose up -d postgres
npm run test:e2e            # full HTTP lifecycle via AppModule + compose Postgres
```

## 10. Tech stack summary

| Layer | Choice | Why |
|-------|--------|-----|
| HTTP | NestJS + strict TS | Guards, pipes, interceptors, filters map to auth, validation, idempotency, errors |
| DB | PostgreSQL 16 | ACID transactions for atomic capacity + ledger; CHECK/trigger enforce invariants |
| ORM | TypeORM + migrations | Schema versioned; raw SQL where races matter |
| Messaging | Kafka (KRaft) + kafkajs | Manual offset commit after DB tx; at-least-once + idempotent handler |
| Auth | JWT (Passport) | Global guard; `@Public()` for health only |
| Config | Joi via `@nestjs/config` | Fail fast at boot |
| Logging | nestjs-pino | JSON logs, correlation id, redacted Authorization |
| Tests | Jest + Testcontainers + Supertest | Unit / integration / e2e — see README § Tests |
| Local ops | Docker Compose | Postgres + Kafka + Kafka UI + optional app image |

### NestJS instruments in this codebase

- **Middleware** — `CorrelationIdMiddleware`: `x-correlation-id` on every request
- **Guard** — `JwtAuthGuard`: global auth, `@Public()` opt-out
- **Pipe** — global `ValidationPipe` + `ParseUUIDPipe`
- **Interceptor** — `IdempotencyInterceptor`: header enforcement + response replay
- **Filter** — `GlobalExceptionFilter`: domain errors → HTTP codes, no stack leaks
- **Decorator** — `@Public()`, `@IdempotencyKeyParam()`

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `migration:run` connection refused | `docker compose up -d postgres` |
| Kafka consumer not starting | Check `KAFKA_BROKERS=localhost:9094` in `.env`; wait for kafka healthy |
| Kafka UI empty | Refresh after first message; topic auto-created on app boot |
| E2e fails | Compose Postgres running; `.env` present; run migrations first |
| 401 on API | `npm run token:dev` — token may have expired (re-issue; no refresh endpoint yet) |
