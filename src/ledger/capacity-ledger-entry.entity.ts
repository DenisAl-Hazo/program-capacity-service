import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '../common/database/bigint.transformer';

export const LEDGER_ENTRY_TYPES = ['RESERVE', 'RELEASE', 'RECONCILIATION_ADJUSTMENT'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const LEDGER_SOURCES = ['API', 'TREASURY'] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

/**
 * Append-only source of truth for capacity. UPDATE/DELETE are blocked by a DB trigger.
 * Invariant: SUM(amount_base) per program == programs.reserved at all times.
 */
@Entity('capacity_ledger')
@Index('idx_capacity_ledger_program_created', ['programId', 'createdAt'])
export class CapacityLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'program_id' })
  programId!: string;

  @Column({ type: 'uuid', name: 'reservation_id', nullable: true })
  reservationId!: string | null;

  @Column({ type: 'text', name: 'entry_type' })
  entryType!: LedgerEntryType;

  /** Original instructed amount — always positive, in `currency`. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: bigint;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  /**
   * Signed delta applied to programs.reserved, in base currency:
   * positive consumes capacity (RESERVE), negative frees it (RELEASE),
   * either sign for RECONCILIATION_ADJUSTMENT. Enforced by a CHECK constraint.
   */
  @Column({ type: 'bigint', name: 'amount_base', transformer: bigintTransformer })
  amountBase!: bigint;

  @Column({ type: 'numeric', precision: 18, scale: 8, name: 'fx_rate', nullable: true })
  fxRate!: string | null;

  @Column({ type: 'timestamptz', name: 'fx_rate_as_of', nullable: true })
  fxRateAsOf!: Date | null;

  @Column({ type: 'text' })
  source!: LedgerSource;

  @Column({ type: 'text', name: 'idempotency_key', unique: true })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
