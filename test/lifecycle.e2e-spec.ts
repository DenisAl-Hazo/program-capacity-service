/**
 * Full HTTP lifecycle against the REAL AppModule (guards, pipes, interceptors, filter).
 * Requires the compose Postgres to be running: `docker compose up -d postgres`.
 * Jest sets NODE_ENV=test, which disables the Kafka consumer.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
// The CLI data-source is the only DataSource that registers migrations (the runtime
// module deliberately doesn't — migrations are an explicit operation, DECISIONS.md).
import migrationDataSource from '../src/database/data-source';

describe('Program capacity lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    token = jwt.sign({ sub: 'e2e-lifecycle' }, process.env.JWT_SECRET as string, {
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      expiresIn: '10m',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  function authed(method: 'post' | 'get', url: string): request.Test {
    return request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);
  }

  it('rejects unauthenticated mutations with 401', async () => {
    await request(app.getHttpServer()).post('/programs').send({}).expect(401);
  });

  it('rejects mutations without an Idempotency-Key header with 400', async () => {
    await authed('post', '/programs')
      .send({ name: `p-${randomUUID()}`, totalLimit: '1000', baseCurrency: 'USD' })
      .expect(400);
  });

  it('runs the full lifecycle: create -> reserve -> replay -> release', async () => {
    // 1. Create a program with 1,000,000 USD-cents capacity.
    const createResponse = await authed('post', '/programs')
      .set('Idempotency-Key', randomUUID())
      .send({ name: `p-${randomUUID()}`, totalLimit: '1000000', baseCurrency: 'USD' })
      .expect(201);
    const programId = (createResponse.body as { programId: string }).programId;

    // 2. Reserve 10,000 EUR-cents; converted at the seeded rate 1.0865 -> 10865 USD-cents.
    const reserveKey = randomUUID();
    const reserveBody = { invoiceId: `inv-${randomUUID()}`, amount: '10000', currency: 'EUR' };
    const reserveResponse = await authed('post', `/programs/${programId}/reservations`)
      .set('Idempotency-Key', reserveKey)
      .send(reserveBody)
      .expect(201);
    const reservation = reserveResponse.body as {
      reservationId: string;
      amountBase: string;
      fxRate: string | null;
    };
    expect(reservation.amountBase).toBe('10865');
    expect(reservation.fxRate).not.toBeNull();

    // 3. Retry with the SAME key and body: replayed, not re-executed.
    const replayResponse = await authed('post', `/programs/${programId}/reservations`)
      .set('Idempotency-Key', reserveKey)
      .send(reserveBody)
      .expect(201);
    expect(replayResponse.body).toEqual(reserveResponse.body);

    // 4. Same key, different body: 409 conflict.
    await authed('post', `/programs/${programId}/reservations`)
      .set('Idempotency-Key', reserveKey)
      .send({ ...reserveBody, amount: '999' })
      .expect(409);

    // 5. Availability reflects exactly one reservation.
    const availability = await authed('get', `/programs/${programId}/availability`).expect(200);
    expect(availability.body).toMatchObject({
      totalLimit: '1000000',
      reserved: '10865',
      available: '989135',
    });

    // 6. Release; capacity returns in full — no FX drift.
    await authed('post', `/reservations/${reservation.reservationId}/release`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    const after = await authed('get', `/programs/${programId}/availability`).expect(200);
    expect(after.body).toMatchObject({ reserved: '0', available: '1000000' });

    // 7. Double release is a 409.
    await authed('post', `/reservations/${reservation.reservationId}/release`)
      .set('Idempotency-Key', randomUUID())
      .expect(409);
  });

  it('maps domain errors: oversubscription -> 409, unknown FX pair -> 422', async () => {
    const createResponse = await authed('post', '/programs')
      .set('Idempotency-Key', randomUUID())
      .send({ name: `p-${randomUUID()}`, totalLimit: '100', baseCurrency: 'USD' })
      .expect(201);
    const programId = (createResponse.body as { programId: string }).programId;

    await authed('post', `/programs/${programId}/reservations`)
      .set('Idempotency-Key', randomUUID())
      .send({ invoiceId: `inv-${randomUUID()}`, amount: '500', currency: 'USD' })
      .expect(409);

    await authed('post', `/programs/${programId}/reservations`)
      .set('Idempotency-Key', randomUUID())
      .send({ invoiceId: `inv-${randomUUID()}`, amount: '10', currency: 'JPY' })
      .expect(422);
  });
});
