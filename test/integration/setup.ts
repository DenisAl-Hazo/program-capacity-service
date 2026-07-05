import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { InitialSchema1751710000000 } from '../../src/database/migrations/1751710000000-InitialSchema';
import { AddFxRates1751720000000 } from '../../src/database/migrations/1751720000000-AddFxRates';
import { FxRate } from '../../src/fx/fx-rate.entity';
import { IdempotencyKey } from '../../src/idempotency/idempotency-key.entity';
import { CapacityLedgerEntry } from '../../src/ledger/capacity-ledger-entry.entity';
import { Program } from '../../src/programs/program.entity';
import { Reservation } from '../../src/reservations/reservation.entity';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  dataSource: DataSource;
}

/** Real Postgres + real migrations — integration tests must exercise the actual constraints. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const dataSource = new DataSource({
    type: 'postgres',
    url: container.getConnectionUri(),
    entities: [Program, Reservation, CapacityLedgerEntry, IdempotencyKey, FxRate],
    migrations: [InitialSchema1751710000000, AddFxRates1751720000000],
    synchronize: false,
  });
  await dataSource.initialize();
  await dataSource.runMigrations();

  return { container, dataSource };
}

export async function stopTestDatabase(db: TestDatabase): Promise<void> {
  await db.dataSource.destroy();
  await db.container.stop();
}

export async function ledgerSum(dataSource: DataSource, programId: string): Promise<bigint> {
  const rows = await dataSource.query<Array<{ sum: string }>>(
    `SELECT COALESCE(SUM(amount_base), 0)::text AS sum FROM capacity_ledger WHERE program_id = $1`,
    [programId],
  );
  return BigInt(rows[0].sum);
}

export async function reservedOf(dataSource: DataSource, programId: string): Promise<bigint> {
  const program = await dataSource.getRepository(Program).findOneByOrFail({ id: programId });
  return program.reserved;
}
