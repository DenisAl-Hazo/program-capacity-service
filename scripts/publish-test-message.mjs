#!/usr/bin/env node
/**
 * Publish a sample treasury delta to the local Kafka topic.
 * Usage:
 *   node scripts/publish-test-message.mjs <programId> [version]
 * Requires: docker compose kafka running, topic created (app boot or manual).
 */
import { Kafka } from 'kafkajs';
import { config } from 'dotenv';

config();

const programId = process.argv[2];
const version = Number(process.argv[3] ?? 1);

if (!programId) {
  console.error('Usage: node scripts/publish-test-message.mjs <programId> [version]');
  process.exit(1);
}

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(',');
const topic = process.env.KAFKA_TREASURY_TOPIC ?? 'treasury.capacity.events';

const kafka = new Kafka({ clientId: 'pcs-publisher', brokers });
const producer = kafka.producer();

const message = {
  type: 'CAPACITY_DELTA',
  programId,
  version,
  idempotencyKey: `script-${Date.now()}`,
  delta: { direction: 'RESERVE', amount: '50000', currency: 'USD' },
};

await producer.connect();
await producer.send({
  topic,
  messages: [{ key: programId, value: JSON.stringify(message) }],
});
await producer.disconnect();

console.log(`Published to ${topic}:`);
console.log(JSON.stringify(message, null, 2));
