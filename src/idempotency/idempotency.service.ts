import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { IdempotencyConflictError } from '../common/errors/domain-error';
import { IdempotencyKey } from './idempotency-key.entity';

interface SaveResultParams {
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
}

/**
 * The real idempotency guarantee is the unique constraint on idempotency_keys.key
 * (and capacity_ledger.idempotency_key). This service is the bookkeeping around it:
 * hash comparison for replay-vs-conflict decisions and response storage for replays.
 */
@Injectable()
export class IdempotencyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  computeRequestHash(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex');
  }

  async findByKey(key: string): Promise<IdempotencyKey | null> {
    return this.dataSource.getRepository(IdempotencyKey).findOneBy({ key });
  }

  assertSameRequest(record: IdempotencyKey, requestHash: string): void {
    if (record.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
  }

  /**
   * Must be called inside the same transaction as the business effect.
   * Strict INSERT (not save/upsert) so a concurrent duplicate hits the PK constraint.
   */
  async saveResult(manager: EntityManager, params: SaveResultParams): Promise<void> {
    await manager.query(
      `INSERT INTO idempotency_keys (key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4)`,
      [params.key, params.requestHash, params.responseStatus, JSON.stringify(params.responseBody)],
    );
  }

  /**
   * Recovery path for retries and concurrent duplicates: if the key is already
   * committed, replay the stored response (or reject a different body). Returns
   * null when the key is unknown — the original error should then propagate.
   */
  async tryReplay<T>(key: string, requestHash: string): Promise<T | null> {
    const record = await this.findByKey(key);
    if (!record) {
      return null;
    }
    this.assertSameRequest(record, requestHash);
    return record.responseBody as T;
  }
}
