import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../common/database/bigint.transformer';

/**
 * `reserved` is a cached total derived from capacity_ledger. It must only change
 * inside the same transaction as a ledger insert, via the atomic conditional update.
 */
@Entity('programs')
export class Program {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'bigint', name: 'total_limit', transformer: bigintTransformer })
  totalLimit!: bigint;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  reserved!: bigint;

  @Column({ type: 'char', length: 3, name: 'base_currency' })
  baseCurrency!: string;

  @Column({ type: 'bigint', name: 'applied_version', transformer: bigintTransformer })
  appliedVersion!: bigint;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
