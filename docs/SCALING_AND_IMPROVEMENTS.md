# Scaling & Improvement Notes

Companion to `DECISIONS.md`. Three topics: (1) security hardening, (2) future improvements,
(3) database partitioning / sharding. Nothing here is implemented — these are the documented
next steps if the service moves from PoC scale to production scale.

---

## 1. Security hardening (beyond the PoC scope)

Current state: global JWT guard (HS256 shared secret), Joi-validated env, strict DTO validation,
`Authorization` header redacted in logs, internals never leaked by the exception filter.

Production gaps, in priority order:

1. **AuthZ, not just AuthN.** Any valid token can mutate any program. Add scopes/roles in the JWT
   (`programs:write`, `treasury:admin`) and a claims guard per route; ideally tenant-scope tokens
   so a client can only see its own programs.
2. **Asymmetric keys / IdP.** Replace the HS256 shared secret with RS256/ES256 via JWKS from an
   IdP (Auth0/Keycloak/Cognito) so the service never holds a signing secret and rotation is free.
3. **Rate limiting & body limits.** `@nestjs/throttler` (or the API gateway) against brute-force
   and reservation-spam; explicit JSON body-size limit.
4. **Kafka channel security.** The broker is PLAINTEXT with no ACLs. Production: TLS + SASL
   (SCRAM or mTLS), topic ACLs so only treasury can produce to `treasury.capacity.v1`, and
   message signing or schema-registry validation if the producer is another team.
5. **Secrets management.** `.env` files → a secret store (Vault / AWS Secrets Manager / k8s
   secrets), plus DB credential rotation. Never bake secrets into images.
6. **Transport & headers.** TLS termination in front of the app; `helmet` for header hygiene
   (low value for a machine-to-machine API but free).
7. **Audit trail for reads.** Ledger covers mutations; if availability data is commercially
   sensitive, log authenticated reads with subject + correlation id.
8. **DLQ hygiene.** DLQ messages contain full original payloads — treat the DLQ topic with the
   same access controls as the source topic.

---

## 2. Future improvements (non-security)

1. **Migrations at deploy time.** ✅ _Done:_ the Docker image now runs pending migrations before
   starting the app (`Dockerfile` CMD), so `docker compose up --build` works on a clean volume.
   Outside Docker, migrations stay an explicit step (`npm run migration:run`). In a multi-replica
   deployment, move the migration step to a dedicated release-pipeline stage / init job so only
   one runner applies it (TypeORM takes a lock, but a pipeline stage is cleaner).
2. **Live FX rates.** `fx_rates` is a seeded static table. Real system: rate ingestion job with
   `as_of` history (append-only rate table, pick latest ≤ now), staleness alarm, and a maximum
   rate age policy per program. The persisted-evidence mechanics already in place stay unchanged.
3. **Currency exponents.** Conversion treats rates as minor-unit → minor-unit. All seeded pairs
   (USD/EUR/GBP) share exponent 2, so this is currently correct — but adding JPY (0 decimals) or
   BHD (3) silently mis-scales by 10^Δexponent unless rates are pre-adjusted. Add an ISO 4217
   exponent table and normalize through major units before rounding.
4. **Idempotency key TTL.** `idempotency_keys` grows forever and replays forever. Industry norm:
   24h–7d retention with a sweeper job (or partition by day and drop old partitions — see §3).
   Also consider scoping keys per endpoint to prevent cross-endpoint key collisions.
5. **Snapshot vs. open reservations.** A reconciliation snapshot may set `reserved` below the sum
   of open API reservations; a later release can then fail the `reserved + delta >= 0` guard
   (surfaces as a 409 on an honest release). Decide a policy: clamp releases at zero with an
   adjustment ledger row, or reject snapshots inconsistent with open reservations.
6. **Stuck-poison alerting.** DLQ'd messages are logged but nothing watches the DLQ. Add a
   consumer-lag + DLQ-depth alert, and a documented replay runbook (fix data, re-produce to main
   topic with the same idempotency key — dedupe makes replay safe).
7. **Observability.** Metrics (reservation success/conflict rates, capacity utilization per
   program, Kafka lag, DLQ depth) via OpenTelemetry/Prometheus; traces across HTTP → DB → Kafka.
8. **Operational drift check.** A periodic job asserting `SUM(ledger.amount_base) = programs.reserved`
   per program (the invariant is enforced transactionally, but a cheap cron proves it stays true
   and catches manual-SQL accidents).
9. **Node version pinning.** Add `.nvmrc` + `engines` (Node ≥ 20) — the repo currently fails on
   older default Node with a cryptic Jest syntax error.
10. **OpenAPI spec.** ✅ _Done:_ `@nestjs/swagger` with the CLI plugin; Swagger UI at `/docs`
    (bearer auth + `Idempotency-Key` fields) doubles as the "simple UI" for manual exercise.
    Remaining nice-to-have: typed response schemas (response DTOs are interfaces, so only
    request bodies are fully schema'd today).
11. **Caching (Redis).** Deliberately absent today — every read hits Postgres, which is correct
    at this scale. Where a cache earns its place later, in order of safety:
    - **FX rates** — near-static reference data; cache in Redis (or per-instance memory) with a
      TTL matching the rate-refresh cadence. Safe: the rate used is persisted on the ledger row
      anyway, so a stale cached rate is evidence-consistent, just older.
    - **Availability reads** — cache `GET /programs/:id/availability` with a short TTL (1–5s)
      or invalidate on write; huge win for polling dashboards/pricing engines (see §3 Idea C
      for the full CDC read-model version).
    - **Idempotency fast-path** — Redis lookup before the DB read in the interceptor. Only the
      fast path: the guarantee must remain the Postgres PK in the effect's transaction.
    - **Hard rule:** the reserve/release _write_ path must never consult a cache for the
      capacity decision — the atomic conditional UPDATE against the authoritative row is the
      whole correctness story. A cache that "knows" available capacity is how you oversubscribe.

---

## 3. Database partitioning & sharding

The write hot spot is one row per program (`programs.reserved` conditional UPDATE) — that is
by design and stays fast at any table size. The _growth_ problem is the append-only tables.

### Idea A — Time-range partition the append-only tables (first, cheap, local)

`capacity_ledger` and `idempotency_keys` grow monotonically; neither is ever updated.

- **`capacity_ledger`**: native Postgres `PARTITION BY RANGE (created_at)`, monthly partitions.
  Queries are `(program_id, created_at)` — partition pruning keeps index depth flat. Old
  partitions become read-only cold storage (detach → archive to S3/parquet). The append-only
  trigger and sign CHECK apply per partition unchanged.
- **`idempotency_keys`**: daily/weekly range partitions on `created_at`; retention = drop the
  partition (instant, no VACUUM churn) instead of a DELETE sweeper. Caveat: Postgres requires
  the partition key in the PK, so the key becomes `(key, created_at)` — dedupe lookups stay
  point reads because `key` remains the leading column.

When: ledger > ~100M rows or idempotency churn causes bloat. Effort: one migration + a
partition-maintenance job (pg_partman). No application code changes.

### Idea B — Shard by `program_id` (when one Postgres runs out)

Every transaction in the service touches exactly **one program**: reservation, release, treasury
delta, snapshot, availability. There are no cross-program queries in the hot path. That makes
`program_id` a perfect shard key — each transaction stays single-shard, so the atomic
conditional UPDATE and the same-transaction idempotency guarantees survive sharding untouched.

- Application-level routing (consistent hashing on `program_id` over N Postgres clusters) or
  Citus with `program_id` as the distribution column and `programs`, `reservations`,
  `capacity_ledger` co-located.
- Kafka aligns for free: key treasury messages by `programId` so per-program ordering and the
  version gate hold within one partition → one consumer → one shard.
- The pieces that need design: global `fx_rates` (small — replicate to every shard), cross-shard
  reporting (feed a read model, see Idea C), and shard rebalancing (Citus does this; hand-rolled
  routing needs a directory service).
- **What NOT to do:** shard by invoice or by ledger id — both would split a program's capacity
  state across shards and destroy the single-statement atomicity the whole design rests on.

When: sustained write volume beyond a single primary (~tens of thousands of reservations/sec)
or a single program-set too large for one box. Sharding is the _last_ resort — a bigger primary
plus Idea A plus Idea C covers a very long way.

### Idea C — CQRS read model / read replicas (scale reads without touching writes)

Availability (`GET /programs/:id/availability`) is the natural high-QPS endpoint (pricing
engines, dashboards polling). Reads can leave the primary:

- **Step 1: streaming replica** for availability + reporting queries. Trade-off: replication lag
  means a just-committed reservation may not be visible — acceptable for dashboards, documented
  for callers (the write path already returns authoritative state in its response).
- **Step 2: CDC read model** — Debezium on `programs`/`capacity_ledger` → a projection service
  → Redis (hot availability lookups) or a columnar store (ledger analytics). The ledger is
  append-only and idempotency-keyed, which makes projections trivially replayable and exactly
  the audit-friendly event source CDC wants.
- Keep **all writes** on the primary. The conditional-UPDATE invariant only holds where the
  authoritative `reserved` row lives.

When: read QPS dominates (typical 100:1 read/write in pricing flows) — this is usually needed
long before Idea B.

### Suggested order

1. Idea A (partitioning) — maintenance-level effort, removes the unbounded-growth risk.
2. Idea C (read model) — handles the realistic load profile (read-heavy).
3. Idea B (sharding) — only when single-primary write throughput is truly exhausted.
