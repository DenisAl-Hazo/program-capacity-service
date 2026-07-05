import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Static FX rate table (DECISIONS.md §6): a live feed is out of scope for this service,
 * but the conversion mechanics (persisted rate + timestamp, deterministic rounding)
 * are exactly what a production system needs. Convention: amount_to = amount_from * rate.
 */
export class AddFxRates1751720000000 implements MigrationInterface {
  name = 'AddFxRates1751720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE fx_rates (
        from_currency char(3) NOT NULL,
        to_currency char(3) NOT NULL,
        rate numeric(18,8) NOT NULL,
        as_of timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_fx_rates PRIMARY KEY (from_currency, to_currency),
        CONSTRAINT chk_fx_rates_rate_positive CHECK (rate > 0),
        CONSTRAINT chk_fx_rates_currencies_differ CHECK (from_currency <> to_currency),
        CONSTRAINT chk_fx_rates_from_iso CHECK (from_currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_fx_rates_to_iso CHECK (to_currency ~ '^[A-Z]{3}$')
      )
    `);

    await queryRunner.query(`
      INSERT INTO fx_rates (from_currency, to_currency, rate) VALUES
        ('EUR', 'USD', 1.08650000),
        ('USD', 'EUR', 0.92040000),
        ('GBP', 'USD', 1.27300000),
        ('USD', 'GBP', 0.78550000),
        ('EUR', 'GBP', 0.85350000),
        ('GBP', 'EUR', 1.17160000)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE fx_rates`);
  }
}
