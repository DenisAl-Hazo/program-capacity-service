import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Static rate table seeded by migration (a live feed is out of scope — DECISIONS.md §6).
 * Convention: amount_to = round_half_up(amount_from * rate).
 */
@Entity('fx_rates')
export class FxRate {
  @PrimaryColumn({ type: 'char', length: 3, name: 'from_currency' })
  fromCurrency!: string;

  @PrimaryColumn({ type: 'char', length: 3, name: 'to_currency' })
  toCurrency!: string;

  /** Numeric kept as string; conversion math happens on scaled bigint, never floats. */
  @Column({ type: 'numeric', precision: 18, scale: 8 })
  rate!: string;

  @Column({ type: 'timestamptz', name: 'as_of' })
  asOf!: Date;
}
