import { randomUUID } from 'crypto';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { CapacityLedgerEntry } from '../../src/ledger/capacity-ledger-entry.entity';
import { ProgramsService } from '../../src/programs/programs.service';
import {
  PoisonMessageError,
  TreasuryMessageDto,
} from '../../src/treasury/dto/treasury-message.dto';
import { TreasuryProcessor } from '../../src/treasury/treasury.processor';
import { ledgerSum, reservedOf, startTestDatabase, stopTestDatabase, TestDatabase } from './setup';
import { Program } from '../../src/programs/program.entity';

describe('Treasury ingestion (integration, real Postgres)', () => {
  let db: TestDatabase;
  let processor: TreasuryProcessor;
  let programs: ProgramsService;

  beforeAll(async () => {
    db = await startTestDatabase();
    processor = new TreasuryProcessor(db.dataSource);
    programs = new ProgramsService(db.dataSource, new IdempotencyService(db.dataSource));
  }, 120_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  async function createProgram(totalLimit = '10000'): Promise<string> {
    const response = await programs.create(
      { name: `program-${randomUUID()}`, totalLimit, baseCurrency: 'USD' },
      randomUUID(),
    );
    return response.programId;
  }

  function delta(
    programId: string,
    version: number,
    amount: string,
    direction: 'RESERVE' | 'RELEASE' = 'RESERVE',
  ): TreasuryMessageDto {
    const message = new TreasuryMessageDto();
    message.type = 'CAPACITY_DELTA';
    message.programId = programId;
    message.version = version;
    message.delta = { direction, amount, currency: 'USD' };
    return message;
  }

  function snapshot(
    programId: string,
    version: number,
    totalLimit: string,
    reserved: string,
  ): TreasuryMessageDto {
    const message = new TreasuryMessageDto();
    message.type = 'RECONCILIATION_SNAPSHOT';
    message.programId = programId;
    message.version = version;
    message.snapshot = { totalLimit, reserved, baseCurrency: 'USD' };
    return message;
  }

  async function appliedVersionOf(programId: string): Promise<bigint> {
    const program = await db.dataSource.getRepository(Program).findOneByOrFail({ id: programId });
    return program.appliedVersion;
  }

  it('applies a delta: reserved moves, ledger row written, version advances', async () => {
    const programId = await createProgram();

    const outcome = await processor.process(delta(programId, 1, '500'), randomUUID());

    expect(outcome).toBe('APPLIED');
    expect(await reservedOf(db.dataSource, programId)).toBe(500n);
    expect(await ledgerSum(db.dataSource, programId)).toBe(500n);
    expect(await appliedVersionOf(programId)).toBe(1n);
  });

  it('DUPLICATE: redelivered message (same idempotency key) has no second effect', async () => {
    const programId = await createProgram();
    const key = randomUUID();
    const message = delta(programId, 1, '500');

    expect(await processor.process(message, key)).toBe('APPLIED');
    expect(await processor.process(message, key)).toBe('DUPLICATE');

    expect(await reservedOf(db.dataSource, programId)).toBe(500n);
    const ledgerRows = await db.dataSource
      .getRepository(CapacityLedgerEntry)
      .countBy({ programId });
    expect(ledgerRows).toBe(1);
  });

  it('STALE: delta with version <= applied version is ignored', async () => {
    const programId = await createProgram();

    await processor.process(delta(programId, 5, '500'), randomUUID());
    const outcome = await processor.process(delta(programId, 3, '999'), randomUUID());

    expect(outcome).toBe('STALE');
    expect(await reservedOf(db.dataSource, programId)).toBe(500n);
    expect(await appliedVersionOf(programId)).toBe(5n);
  });

  it('applies a newer snapshot: totals replaced, adjustment ledger entry preserves audit trail', async () => {
    const programId = await createProgram('10000');
    await processor.process(delta(programId, 1, '500'), randomUUID());

    const outcome = await processor.process(snapshot(programId, 2, '20000', '1200'), randomUUID());

    expect(outcome).toBe('APPLIED');
    expect(await reservedOf(db.dataSource, programId)).toBe(1200n);
    // 500 (delta) + 700 (adjustment) = 1200 — the ledger still explains the state.
    expect(await ledgerSum(db.dataSource, programId)).toBe(1200n);
    expect(await appliedVersionOf(programId)).toBe(2n);

    const program = await db.dataSource.getRepository(Program).findOneByOrFail({ id: programId });
    expect(program.totalLimit).toBe(20000n);
  });

  it('STALE SNAPSHOT: version 3 after version 5 is ignored, state unchanged', async () => {
    const programId = await createProgram();
    await processor.process(snapshot(programId, 5, '10000', '800'), randomUUID());

    const outcome = await processor.process(snapshot(programId, 3, '99999', '1'), randomUUID());

    expect(outcome).toBe('STALE');
    expect(await reservedOf(db.dataSource, programId)).toBe(800n);
    expect(await appliedVersionOf(programId)).toBe(5n);
  });

  it('OUT-OF-ORDER: snapshot v10 wins; late delta v8 replayed afterwards is ignored', async () => {
    const programId = await createProgram();

    await processor.process(snapshot(programId, 10, '10000', '2000'), randomUUID());
    const outcome = await processor.process(delta(programId, 8, '500'), randomUUID());

    expect(outcome).toBe('STALE');
    expect(await reservedOf(db.dataSource, programId)).toBe(2000n);
    expect(await appliedVersionOf(programId)).toBe(10n);
  });

  it('poison: delta for an unknown program', async () => {
    await expect(
      processor.process(delta(randomUUID(), 1, '100'), randomUUID()),
    ).rejects.toBeInstanceOf(PoisonMessageError);
  });

  it('poison: delta that would oversubscribe the program', async () => {
    const programId = await createProgram('1000');

    await expect(
      processor.process(delta(programId, 1, '5000'), randomUUID()),
    ).rejects.toBeInstanceOf(PoisonMessageError);

    expect(await reservedOf(db.dataSource, programId)).toBe(0n);
  });

  it('poison: snapshot whose reserved exceeds its own limit', async () => {
    const programId = await createProgram();

    await expect(
      processor.process(snapshot(programId, 1, '1000', '2000'), randomUUID()),
    ).rejects.toBeInstanceOf(PoisonMessageError);
  });

  it('RELEASE delta returns capacity', async () => {
    const programId = await createProgram();
    await processor.process(delta(programId, 1, '500'), randomUUID());

    await processor.process(delta(programId, 2, '200', 'RELEASE'), randomUUID());

    expect(await reservedOf(db.dataSource, programId)).toBe(300n);
    expect(await ledgerSum(db.dataSource, programId)).toBe(300n);
  });
});
