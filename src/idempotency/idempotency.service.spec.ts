import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService.computeRequestHash', () => {
  const service = new IdempotencyService(null as never);

  it('is stable regardless of object key order', () => {
    const a = service.computeRequestHash({
      params: { programId: 'abc' },
      body: { amount: '100', currency: 'USD', invoiceId: 'inv-1' },
    });
    const b = service.computeRequestHash({
      params: { programId: 'abc' },
      body: { invoiceId: 'inv-1', currency: 'USD', amount: '100' },
    });
    expect(a).toBe(b);
  });

  it('differs when the body changes', () => {
    const base = service.computeRequestHash({
      params: { programId: 'abc' },
      body: { amount: '100' },
    });
    const changed = service.computeRequestHash({
      params: { programId: 'abc' },
      body: { amount: '101' },
    });
    expect(base).not.toBe(changed);
  });
});
