import { randomUUID } from 'crypto';
import {
  CurrencyMismatchError,
  DuplicateInvoiceError,
  IdempotencyConflictError,
  InsufficientCapacityError,
  ProgramNotFoundError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../../src/common/errors/domain-error';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { CapacityLedgerEntry } from '../../src/ledger/capacity-ledger-entry.entity';
import { ProgramsService } from '../../src/programs/programs.service';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { ledgerSum, reservedOf, startTestDatabase, stopTestDatabase, TestDatabase } from './setup';

describe('Reservations (integration, real Postgres)', () => {
  let db: TestDatabase;
  let programs: ProgramsService;
  let reservations: ReservationsService;

  beforeAll(async () => {
    db = await startTestDatabase();
    const idempotency = new IdempotencyService(db.dataSource);
    programs = new ProgramsService(db.dataSource, idempotency);
    reservations = new ReservationsService(db.dataSource, idempotency);
  }, 120_000);

  afterAll(async () => {
    await stopTestDatabase(db);
  });

  async function createProgram(totalLimit: string, currency = 'USD'): Promise<string> {
    const response = await programs.create(
      { name: `program-${randomUUID()}`, totalLimit, baseCurrency: currency },
      randomUUID(),
    );
    return response.programId;
  }

  function reserve(
    programId: string,
    amount: string,
    overrides?: Partial<{ invoiceId: string; currency: string; key: string }>,
  ) {
    return reservations.reserve(
      programId,
      {
        invoiceId: overrides?.invoiceId ?? `inv-${randomUUID()}`,
        amount,
        currency: overrides?.currency ?? 'USD',
      },
      overrides?.key ?? randomUUID(),
    );
  }

  describe('CONCURRENCY — the invariant that matters most', () => {
    it('never oversubscribes: 20 parallel reservations of 100 against a limit of 1000 -> exactly 10 succeed', async () => {
      const programId = await createProgram('1000');

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => reserve(programId, '100')),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(fulfilled).toHaveLength(10);
      expect(rejected).toHaveLength(10);
      for (const rejection of rejected) {
        expect(rejection.reason).toBeInstanceOf(InsufficientCapacityError);
      }

      expect(await reservedOf(db.dataSource, programId)).toBe(1000n);
      expect(await ledgerSum(db.dataSource, programId)).toBe(1000n);
    }, 60_000);
  });

  describe('IDEMPOTENCY', () => {
    it('same key + same body twice -> one ledger row, identical response', async () => {
      const programId = await createProgram('1000');
      const key = randomUUID();
      const invoiceId = `inv-${randomUUID()}`;

      const first = await reserve(programId, '100', { invoiceId, key });
      const second = await reserve(programId, '100', { invoiceId, key });

      expect(second).toEqual(first);
      expect(await reservedOf(db.dataSource, programId)).toBe(100n);

      const ledgerRows = await db.dataSource
        .getRepository(CapacityLedgerEntry)
        .countBy({ programId });
      expect(ledgerRows).toBe(1);
    });

    it('same key + different body -> conflict, no second effect', async () => {
      const programId = await createProgram('1000');
      const key = randomUUID();

      await reserve(programId, '100', { key });
      await expect(reserve(programId, '999', { key })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );

      expect(await reservedOf(db.dataSource, programId)).toBe(100n);
    });

    it('same invoice with a NEW key -> duplicate invoice conflict', async () => {
      const programId = await createProgram('1000');
      const invoiceId = `inv-${randomUUID()}`;

      await reserve(programId, '100', { invoiceId });
      await expect(reserve(programId, '100', { invoiceId })).rejects.toBeInstanceOf(
        DuplicateInvoiceError,
      );
    });
  });

  describe('capacity and validation', () => {
    it('rejects a reservation exceeding available capacity and leaves no trace', async () => {
      const programId = await createProgram('1000');

      await expect(reserve(programId, '1001')).rejects.toBeInstanceOf(InsufficientCapacityError);

      expect(await reservedOf(db.dataSource, programId)).toBe(0n);
      expect(await ledgerSum(db.dataSource, programId)).toBe(0n);
    });

    it('rejects a currency differing from the program base currency (pre-FX phase)', async () => {
      const programId = await createProgram('1000', 'USD');

      await expect(reserve(programId, '100', { currency: 'EUR' })).rejects.toBeInstanceOf(
        CurrencyMismatchError,
      );
    });

    it('rejects reservations against an unknown program', async () => {
      await expect(reserve(randomUUID(), '100')).rejects.toBeInstanceOf(ProgramNotFoundError);
    });
  });

  describe('RELEASE', () => {
    it('release returns capacity and the ledger nets to zero', async () => {
      const programId = await createProgram('1000');
      const reservation = await reserve(programId, '400');

      const released = await reservations.release(reservation.reservationId, randomUUID());

      expect(released.status).toBe('RELEASED');
      expect(released.releasedAt).not.toBeNull();
      expect(await reservedOf(db.dataSource, programId)).toBe(0n);
      expect(await ledgerSum(db.dataSource, programId)).toBe(0n);
    });

    it('double release with the SAME key replays the original response', async () => {
      const programId = await createProgram('1000');
      const reservation = await reserve(programId, '400');
      const key = randomUUID();

      const first = await reservations.release(reservation.reservationId, key);
      const second = await reservations.release(reservation.reservationId, key);

      expect(second).toEqual(first);
      expect(await reservedOf(db.dataSource, programId)).toBe(0n);
      expect(await ledgerSum(db.dataSource, programId)).toBe(0n);
    });

    it('double release with a DIFFERENT key is rejected', async () => {
      const programId = await createProgram('1000');
      const reservation = await reserve(programId, '400');

      await reservations.release(reservation.reservationId, randomUUID());
      await expect(
        reservations.release(reservation.reservationId, randomUUID()),
      ).rejects.toBeInstanceOf(ReservationAlreadyReleasedError);

      expect(await reservedOf(db.dataSource, programId)).toBe(0n);
    });

    it('release of an unknown reservation -> not found', async () => {
      await expect(reservations.release(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
        ReservationNotFoundError,
      );
    });
  });
});
