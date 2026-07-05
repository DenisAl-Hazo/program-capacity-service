import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Dedupe store for HTTP mutations (Idempotency-Key header) and Kafka messages
 * (message key or topic:partition:offset). The PK is the idempotency guarantee.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  /** Hash of the request body — same key + different hash is rejected as a conflict. */
  @Column({ type: 'text', name: 'request_hash' })
  requestHash!: string;

  @Column({ type: 'int', name: 'response_status', nullable: true })
  responseStatus!: number | null;

  @Column({ type: 'jsonb', name: 'response_body', nullable: true })
  responseBody!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
