# Known bottlenecks

Where this service's throughput ceiling actually is, grounded in the code — as opposed to
`SCALING_AND_IMPROVEMENTS.md`, which covers _future features_ and _scaling strategies_. This
document is the "where would it slow down or misbehave first" answer.

## 1. Row-lock contention on one hot program

**Where:** `ReservationsService.applyCapacityDelta` (`src/reservations/reservations.service.ts`)
and the equivalent statement in `TreasuryProcessor.applyDelta`. Every reservation, release, or
treasury delta against the _same_ `program_id` serializes on that one row's Postgres lock —
concurrent writers queue up and are processed one at a time.

**Impact:** different programs never block each other (locks are per-row, not per-table), so
overall system throughput scales with the number of active programs. But one single program
can only process writes as fast as Postgres commits one row-locked transaction after another —
sub-millisecond normally, but a real, per-program ceiling if one program received extreme
concurrent load (e.g. a very large financing program with many simultaneous invoice approvals).

**Mitigation:** none needed at current scale — this is the correct, intentional trade-off
(DECISIONS.md §3) that makes the atomic capacity check possible at all. If a single program's
write volume ever became the bottleneck, sharding by `program_id`
(`SCALING_AND_IMPROVEMENTS.md` §3 Idea B) would _not_ help — it spreads _different_ programs
across machines, but one hot program still lives on one shard, still serializes on one row.
There is no way to parallelize writes to one program's capacity total without changing the
correctness model itself (e.g. splitting capacity into pre-allocated sub-pools — a much larger
design change, not recommended unless this ever becomes a measured, real problem).

## 2. Single-node Kafka

**Where:** `docker-compose.yml` — one broker, KRaft mode, `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1`
and `KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1`. Deliberate for a local/demo setup
(DECISIONS.md, README tech-stack table).

**Impact:** if this broker fails, treasury ingestion stops entirely until it recovers — no
replica to fail over to. `TreasuryConsumerService`'s retry loop (`src/treasury/treasury.consumer.ts`)
reconnects automatically once the broker returns, and the HTTP API stays up throughout (a broker
outage never blocks reservations/releases/availability), but new treasury messages queue up
unprocessed in the meantime.

**Mitigation:** a config-only change in production — 3+ broker nodes with replication factor 3
survives a single-broker failure with zero data loss. No application code changes needed;
`kafkajs` already just talks to "the brokers list" from config.

## 3. Unbounded growth of append-only tables

**Where:** `capacity_ledger` and `idempotency_keys` only ever receive `INSERT`s (the ledger's
append-only trigger physically forbids `UPDATE`/`DELETE`). Both tables grow forever.

**Impact:** not a correctness problem — a scale problem. Over years of data, query latency on
`capacity_ledger` lookups by `program_id` degrades, and index bloat increases VACUUM pressure.

**Mitigation:** already designed in `SCALING_AND_IMPROVEMENTS.md` §2 item 4 (idempotency key TTL)
and §3 Idea A (time-range partitioning of both tables) — see those sections for the full plan.

## 4. Kafka messages are not keyed by `programId` — a real ordering gap if partitions are ever added

**Where:** every produce example in this repo (README, `docs/STARTUP.md`, `docs/DEMO_WALKTHROUGH.md`)
sends messages with an empty Kafka message key. The topic currently has a single partition
(`docker-compose.yml`'s `KAFKA_AUTO_CREATE_TOPICS_ENABLE` / `TreasuryConsumerService`'s
`admin.createTopics` call does not specify a partition count, so it defaults to 1).

**Why it's harmless today:** Kafka only guarantees message ordering _within one partition_. With
exactly one partition, every message for every program lands in one global order, consumed by
one consumer — trivially correct.

**The risk if partitions are added later** (e.g. to let multiple app instances consume Kafka in
parallel — see Bottleneck 1's "different programs scale independently" point): messages for the
_same_ `program_id` could be split across different partitions and processed out of order by
different consumers running in parallel. `TreasuryProcessor`'s version gate
(`version <= program.appliedVersion` → outcome `STALE`) means this can **never cause double
application or data corruption** — an out-of-order message is always safely ignored, not
mis-applied. But it _is_ a silent, quiet loss of a legitimate business event: the delta or
snapshot that arrived "out of turn" simply never applies (marked `STALE` permanently) instead of
being correctly sequenced and applied.

**Mitigation (required before ever increasing partition count):** key every produced message by
`programId`:

```ts
await producer.send({
  topic: treasuryTopic,
  messages: [{ key: message.programId, value: JSON.stringify(message) }],
});
```

Kafka guarantees same-key messages always land in the same partition, restoring per-program
ordering even with many partitions and many parallel consumers. This is a producer-side change
only — nothing in `TreasuryConsumerService` or `TreasuryProcessor` needs to change, since the
version gate already tolerates (rather than requires) in-order delivery; keying just makes
out-of-order delivery _stop happening_ instead of merely being tolerated.
