import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Core schema. Invariants live in the database, not in app code:
 * - programs.reserved can never exceed total_limit (CHECK) — backstop for the atomic update.
 * - capacity_ledger is append-only (trigger) and idempotency_key is UNIQUE — the real
 *   idempotency guarantee; app-level checks are just an optimization.
 * - ledger amount_base sign is tied to entry_type so SUM(amount_base) == programs.reserved.
 */
export class InitialSchema1751710000000 implements MigrationInterface {
  name = 'InitialSchema1751710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE programs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        total_limit bigint NOT NULL,
        reserved bigint NOT NULL DEFAULT 0,
        base_currency char(3) NOT NULL,
        applied_version bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_programs_total_limit_non_negative CHECK (total_limit >= 0),
        CONSTRAINT chk_programs_reserved_within_limit CHECK (reserved >= 0 AND reserved <= total_limit),
        CONSTRAINT chk_programs_base_currency_iso CHECK (base_currency ~ '^[A-Z]{3}$')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id uuid NOT NULL REFERENCES programs(id),
        invoice_id text NOT NULL,
        amount bigint NOT NULL,
        currency char(3) NOT NULL,
        amount_base bigint NOT NULL,
        fx_rate numeric(18,8),
        fx_rate_as_of timestamptz,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        released_at timestamptz,
        CONSTRAINT uq_reservations_program_invoice UNIQUE (program_id, invoice_id),
        CONSTRAINT chk_reservations_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_reservations_amount_base_positive CHECK (amount_base > 0),
        CONSTRAINT chk_reservations_status CHECK (status IN ('RESERVED', 'RELEASED')),
        CONSTRAINT chk_reservations_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_reservations_released_at CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_reservations_program_status ON reservations (program_id, status)
    `);

    await queryRunner.query(`
      CREATE TABLE capacity_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        program_id uuid NOT NULL REFERENCES programs(id),
        reservation_id uuid REFERENCES reservations(id),
        entry_type text NOT NULL,
        amount bigint NOT NULL,
        currency char(3) NOT NULL,
        amount_base bigint NOT NULL,
        fx_rate numeric(18,8),
        fx_rate_as_of timestamptz,
        source text NOT NULL,
        idempotency_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_capacity_ledger_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_ledger_entry_type CHECK (entry_type IN ('RESERVE', 'RELEASE', 'RECONCILIATION_ADJUSTMENT')),
        CONSTRAINT chk_ledger_source CHECK (source IN ('API', 'TREASURY')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_ledger_amount_base_sign CHECK (
          (entry_type = 'RESERVE' AND amount_base > 0)
          OR (entry_type = 'RELEASE' AND amount_base < 0)
          OR (entry_type = 'RECONCILIATION_ADJUSTMENT' AND amount_base <> 0)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_capacity_ledger_program_created ON capacity_ledger (program_id, created_at)
    `);

    await queryRunner.query(`
      CREATE FUNCTION forbid_capacity_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'capacity_ledger is append-only: % is not allowed', TG_OP;
      END
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_capacity_ledger_append_only
      BEFORE UPDATE OR DELETE ON capacity_ledger
      FOR EACH ROW EXECUTE FUNCTION forbid_capacity_ledger_mutation()
    `);

    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        key text PRIMARY KEY,
        request_hash text NOT NULL,
        response_status int,
        response_body jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE idempotency_keys`);
    await queryRunner.query(`DROP TRIGGER trg_capacity_ledger_append_only ON capacity_ledger`);
    await queryRunner.query(`DROP FUNCTION forbid_capacity_ledger_mutation()`);
    await queryRunner.query(`DROP TABLE capacity_ledger`);
    await queryRunner.query(`DROP TABLE reservations`);
    await queryRunner.query(`DROP TABLE programs`);
  }
}
