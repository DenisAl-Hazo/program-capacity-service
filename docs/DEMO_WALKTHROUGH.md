# Demo walkthrough — prove every feature works (Swagger + Kafka UI)

A short, linear script to demonstrate the whole service is alive: HTTP lifecycle, idempotency,
FX, concurrency safety, and Kafka treasury ingestion (deltas, dedupe, versioning, snapshots,
poison → DLQ). No terminal required except where noted.

Prerequisites: `docker compose up --build`, then open:

- Swagger UI: http://localhost:3000/docs
- Kafka UI: http://localhost:8080

Get a token: `npm run token:dev` → paste into Swagger's **Authorize** button.

## 1. Create a program

`POST /programs` — Idempotency-Key: `demo-create-1` — body:

```json
{ "name": "demo", "totalLimit": "1000000", "baseCurrency": "USD" }
```

Expect **201**, `available:"1000000"`. Copy `programId` — used everywhere below as `{PID}`.

## 2. Reserve with FX conversion

`POST /programs/{PID}/reservations` — Idempotency-Key: `demo-res-1` — body:

```json
{ "invoiceId": "INV-001", "amount": "10000", "currency": "EUR" }
```

Expect **201**, `amountBase:"10865"`, `fxRate:"1.08650000"`. Copy `reservationId` as `{RID}`.

## 3. Idempotent replay (same key + body)

Repeat step 2 exactly. Expect **201**, response byte-identical to step 2 — no new reservation created.

## 4. Conflict (same key, different body)

Same endpoint, key `demo-res-1`, change `"amount"` to `"1"`. Expect **409**.

## 5. Duplicate invoice (new key, same invoice)

Key `demo-res-2`, same body as step 2. Expect **409** (`DuplicateInvoiceError`).

## 6. Insufficient capacity

Key `demo-res-3`, body `{"invoiceId":"INV-BIG","amount":"99999999","currency":"USD"}`. Expect **409**.

## 7. Unknown FX pair

Key `demo-res-4`, body `{"invoiceId":"INV-JPY","amount":"100","currency":"JPY"}`. Expect **422**.

## 8. Availability check

`GET /programs/{PID}/availability`. Expect `reserved:"10865"`, `available:"989135"`.

## 9. Release

`POST /reservations/{RID}/release` — Idempotency-Key: `demo-rel-1`. Expect **200**, `amountBase:"10865"` (exact — no FX drift). Re-check availability: `reserved:"0"`.

## 10. Double release

Repeat step 9 with the **same** key `demo-rel-1` → **200**, identical replay.
Repeat with a **new** key `demo-rel-2` → **409** (already released).

## 11. Auth check

Click **Authorize** → Logout. Retry step 8 → **401**. Re-authorize before continuing.

## 12. Kafka — capacity delta

Kafka UI → Topics → `treasury.capacity.events` → **Produce Message** → Value:

```json
{
  "type": "CAPACITY_DELTA",
  "programId": "{PID}",
  "version": 1,
  "idempotencyKey": "demo-t-1",
  "delta": { "direction": "RESERVE", "amount": "50000", "currency": "USD" }
}
```

Within a few seconds, re-check availability in Swagger: `reserved:"50000"`, `appliedVersion:"1"`.

## 13. Kafka — duplicate delivery (dedupe)

Produce the **exact same** message again. Availability unchanged — proves the dedupe insert absorbs at-least-once redelivery.

## 14. Kafka — stale version (ignored)

Produce with the same `version:1`, new key `demo-t-2`, a large amount. Availability unchanged — proves the version gate, independent of the dedupe key.

## 15. Kafka — reconciliation snapshot

```json
{
  "type": "RECONCILIATION_SNAPSHOT",
  "programId": "{PID}",
  "version": 2,
  "idempotencyKey": "demo-t-3",
  "snapshot": { "totalLimit": "2000000", "reserved": "120000", "baseCurrency": "USD" }
}
```

Availability now shows `totalLimit:"2000000"`, `reserved:"120000"` exactly, `appliedVersion:"2"`.

## 16. Kafka — poison messages → DLQ

Produce two bad messages:

- Malformed JSON: `not json at all`
- Unknown program: `{"type":"CAPACITY_DELTA","programId":"00000000-0000-0000-0000-000000000000","version":1,"delta":{"direction":"RESERVE","amount":"100","currency":"USD"}}`

Kafka UI → Topics → `treasury.capacity.dlq` → both messages appear, each wrapping the original payload with a `reason`. The main topic's consumer offset keeps advancing — poison messages never block the queue.

## What this proves

Every core invariant from the README in one script: integer-money FX conversion, idempotent
HTTP + Kafka mutations, atomic capacity enforcement, version-gated reconciliation, and
poison-message isolation — all observable without a terminal. For the concurrency guarantee
(20 parallel writers, exactly 10 succeed) see the integration test suite (`npm run
test:integration`) or `docs/STARTUP.md` — that scenario needs parallel requests Swagger can't fire.
