import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from '../common/database/bigint.transformer';

export const RESERVATION_STATUSES = ['RESERVED', 'RELEASED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

@Entity('reservations')
@Index('uq_reservations_program_invoice', ['programId', 'invoiceId'], { unique: true })
export class Reservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'program_id' })
  programId!: string;

  @Column({ type: 'text', name: 'invoice_id' })
  invoiceId!: string;

  /** Amount as requested by the client, in its original currency. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: bigint;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  /** Amount actually held against capacity, in the program's base currency. */
  @Column({ type: 'bigint', name: 'amount_base', transformer: bigintTransformer })
  amountBase!: bigint;

  /** FX evidence when currency != base currency; null otherwise. Numeric kept as string. */
  @Column({ type: 'numeric', precision: 18, scale: 8, name: 'fx_rate', nullable: true })
  fxRate!: string | null;

  @Column({ type: 'timestamptz', name: 'fx_rate_as_of', nullable: true })
  fxRateAsOf!: Date | null;

  @Column({ type: 'text' })
  status!: ReservationStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'released_at', nullable: true })
  releasedAt!: Date | null;
}
