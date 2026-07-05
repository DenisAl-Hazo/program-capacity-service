import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka, KafkaMessage, Producer, logLevel } from 'kafkajs';
import { AppConfig } from '../config/env.validation';
import { PoisonMessageError, parseTreasuryMessage } from './dto/treasury-message.dto';
import { TreasuryProcessor } from './treasury.processor';

const START_RETRY_ATTEMPTS = 15;
const START_RETRY_DELAY_MS = 4_000;

/**
 * Dedicated kafkajs consumer (not @nestjs/microservices) because offsets must be
 * committed manually AFTER the DB transaction commits. At-least-once delivery plus
 * an idempotent processor gives effectively-once application.
 */
@Injectable()
export class TreasuryConsumerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumerService.name);
  private kafka?: Kafka;
  private consumer?: Consumer;
  private producer?: Producer;
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly processor: TreasuryProcessor,
  ) {
    this.enabled = this.configService.get('nodeEnv', { infer: true }) !== 'test';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    // Fire-and-forget: HTTP must come up even while the broker is still starting.
    void this.startWithRetry();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
  }

  private async startWithRetry(): Promise<void> {
    const kafkaConfig = this.configService.get('kafka', { infer: true });
    this.kafka = new Kafka({
      clientId: kafkaConfig.clientId,
      brokers: kafkaConfig.brokers,
      logLevel: logLevel.NOTHING,
    });

    for (let attempt = 1; attempt <= START_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.start(kafkaConfig.treasuryTopic, kafkaConfig.dlqTopic, kafkaConfig.groupId);
        this.logger.log({ msg: 'treasury consumer running', topic: kafkaConfig.treasuryTopic });
        return;
      } catch (error) {
        this.logger.warn({
          msg: 'treasury consumer start failed, retrying',
          attempt,
          err: error instanceof Error ? error.message : String(error),
        });
        await this.consumer?.disconnect().catch(() => undefined);
        await this.producer?.disconnect().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, START_RETRY_DELAY_MS));
      }
    }
    // Local-dev convenience: HTTP API stays usable without a broker. In compose,
    // depends_on + healthchecks make this practically unreachable.
    this.logger.error('kafka unreachable after retries — treasury ingestion disabled');
  }

  private async start(treasuryTopic: string, dlqTopic: string, groupId: string): Promise<void> {
    // Deterministic topic creation — no reliance on broker auto-create timing.
    const admin = this.kafka!.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: [{ topic: treasuryTopic }, { topic: dlqTopic }],
        waitForLeaders: true,
      });
    } finally {
      await admin.disconnect();
    }

    this.producer = this.kafka!.producer();
    this.consumer = this.kafka!.consumer({ groupId });
    await this.producer.connect();
    await this.consumer.connect();
    // fromBeginning: a brand-new consumer group must not silently skip history;
    // established groups resume from their committed offsets regardless.
    await this.consumer.subscribe({ topic: treasuryTopic, fromBeginning: true });
    await this.consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.handleMessage(payload),
    });
  }

  private async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    const fallbackKey = `treasury:${topic}:${partition}:${message.offset}`;

    try {
      const dto = parseTreasuryMessage(message.value);
      const idempotencyKey = dto.idempotencyKey ?? fallbackKey;
      await this.processor.process(dto, idempotencyKey);
    } catch (error) {
      if (error instanceof PoisonMessageError) {
        await this.sendToDlq(message, error.message);
      } else {
        // Transient (e.g. DB down): rethrow without committing -> Kafka redelivers.
        throw error;
      }
    }

    await this.consumer!.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private async sendToDlq(message: KafkaMessage, reason: string): Promise<void> {
    const kafkaConfig = this.configService.get('kafka', { infer: true });
    this.logger.warn({ msg: 'routing poison message to DLQ', reason });
    await this.producer!.send({
      topic: kafkaConfig.dlqTopic,
      messages: [
        {
          key: message.key,
          value: JSON.stringify({
            reason,
            original: message.value ? message.value.toString() : null,
            failedAt: new Date().toISOString(),
          }),
        },
      ],
    });
  }
}
