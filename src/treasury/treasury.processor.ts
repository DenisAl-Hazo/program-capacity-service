import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Money } from '../common/money/money';
import { CapacityLedgerEntry } from '../ledger/capacity-ledger-entry.entity';
import { Program } from '../programs/program.entity';
import {
  PoisonMessageError,
  TreasuryDeltaDto,
  TreasuryMessageDto,
  TreasurySnapshotDto,
} from './dto/treasury-message.dto';

export type TreasuryOutcome = 'APPLIED' | 'DUPLICATE' | 'STALE';

/**
 * Applies validated treasury messages. Everything happens in ONE transaction:
 * dedupe insert -> FOR UPDATE lock -> version gate -> effect + ledger + version bump.
 * Throws PoisonMessageError for messages that can never succeed (caller DLQs them);
 * any other error is transient and must lead to redelivery (offset not committed).
 */
@Injectable()
export class TreasuryProcessor {
  private readonly logger = new Logger(TreasuryProcessor.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async process(message: TreasuryMessageDto, idempotencyKey: string): Promise<TreasuryOutcome> {
    const outcome = await this.dataSource.transaction<TreasuryOutcome>(async (manager) => {
      // Dedupe first: at-least-once delivery means the same message WILL come again.
      // Note: TypeORM returns rows directly for INSERT..RETURNING (unlike UPDATE).
      const inserted = await manager.query<Array<{ key: string }>>(
        `INSERT INTO idempotency_keys (key, request_hash)
         VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey, `treasury:v${message.version}:${message.type}`],
      );
      if (inserted.length === 0) {
        return 'DUPLICATE';
      }

      const program = await manager.getRepository(Program).findOne({
        where: { id: message.programId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!program) {
        throw new PoisonMessageError(`unknown program ${message.programId}`);
      }

      // Version gate: arrival order is not trustworthy, the version field is.
      const version = BigInt(message.version);
      if (version <= program.appliedVersion) {
        return 'STALE';
      }

      if (message.type === 'CAPACITY_DELTA') {
        await this.applyDelta(manager, program, message.delta!, idempotencyKey);
      } else {
        await this.applySnapshot(manager, program, message.snapshot!, idempotencyKey);
      }

      await manager.query(
        `UPDATE programs SET applied_version = $1, updated_at = now() WHERE id = $2`,
        [version.toString(), program.id],
      );
      return 'APPLIED';
    });

    this.logger.log({
      msg: 'treasury message processed',
      outcome,
      type: message.type,
      programId: message.programId,
      version: message.version,
    });
    return outcome;
  }

  private async applyDelta(
    manager: EntityManager,
    program: Program,
    delta: TreasuryDeltaDto,
    idempotencyKey: string,
  ): Promise<void> {
    // Cross-currency treasury deltas land with the FX phase; reject explicitly until then.
    if (delta.currency !== program.baseCurrency) {
      throw new PoisonMessageError(
        `delta currency ${delta.currency} does not match program base ${program.baseCurrency}`,
      );
    }
    const amount = Money.fromString(delta.amount, delta.currency);
    const signedDelta = delta.direction === 'RESERVE' ? amount.amount : -amount.amount;

    const [rows] = await manager.query<[unknown[], number]>(
      `UPDATE programs
          SET reserved = reserved + $1, updated_at = now()
        WHERE id = $2
          AND reserved + $1 <= total_limit
          AND reserved + $1 >= 0
        RETURNING reserved`,
      [signedDelta.toString(), program.id],
    );
    if (rows.length === 0) {
      // Would overdraw or underflow given current state — cannot ever apply as-is.
      throw new PoisonMessageError(
        `delta ${delta.direction} ${delta.amount} ${delta.currency} violates capacity bounds`,
      );
    }

    await manager.getRepository(CapacityLedgerEntry).insert({
      programId: program.id,
      reservationId: null,
      entryType: delta.direction,
      amount: amount.amount,
      currency: delta.currency,
      amountBase: signedDelta,
      fxRate: null,
      fxRateAsOf: null,
      source: 'TREASURY',
      idempotencyKey,
    });
  }

  private async applySnapshot(
    manager: EntityManager,
    program: Program,
    snapshot: TreasurySnapshotDto,
    idempotencyKey: string,
  ): Promise<void> {
    if (snapshot.baseCurrency !== program.baseCurrency) {
      throw new PoisonMessageError(
        `snapshot currency ${snapshot.baseCurrency} does not match program base ${program.baseCurrency}`,
      );
    }
    const totalLimit = Money.fromString(snapshot.totalLimit, snapshot.baseCurrency);
    const reserved = Money.fromString(snapshot.reserved, snapshot.baseCurrency);
    if (reserved.amount > totalLimit.amount) {
      throw new PoisonMessageError('snapshot reserved exceeds its total limit');
    }

    // History is never rewritten: the difference becomes an append-only adjustment entry.
    const adjustment = reserved.amount - program.reserved;
    if (adjustment !== 0n) {
      await manager.getRepository(CapacityLedgerEntry).insert({
        programId: program.id,
        reservationId: null,
        entryType: 'RECONCILIATION_ADJUSTMENT',
        amount: adjustment < 0n ? -adjustment : adjustment,
        currency: snapshot.baseCurrency,
        amountBase: adjustment,
        fxRate: null,
        fxRateAsOf: null,
        source: 'TREASURY',
        idempotencyKey,
      });
    }

    await manager.query(
      `UPDATE programs SET total_limit = $1, reserved = $2, updated_at = now() WHERE id = $3`,
      [totalLimit.amount.toString(), reserved.amount.toString(), program.id],
    );

    this.logger.log({
      msg: 'reconciliation snapshot applied',
      programId: program.id,
      oldReserved: program.reserved.toString(),
      newReserved: reserved.amount.toString(),
      oldVersion: program.appliedVersion.toString(),
    });
  }
}
