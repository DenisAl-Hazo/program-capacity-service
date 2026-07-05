import { parseTreasuryMessage, PoisonMessageError } from './treasury-message.dto';

const validDelta = {
  type: 'CAPACITY_DELTA',
  programId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  version: 5,
  idempotencyKey: 'evt-1',
  delta: { direction: 'RESERVE', amount: '1000', currency: 'USD' },
};

const validSnapshot = {
  type: 'RECONCILIATION_SNAPSHOT',
  programId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  version: 9,
  snapshot: { totalLimit: '100000', reserved: '2500', baseCurrency: 'USD' },
};

describe('parseTreasuryMessage', () => {
  it('parses a valid capacity delta', () => {
    const dto = parseTreasuryMessage(Buffer.from(JSON.stringify(validDelta)));

    expect(dto.type).toBe('CAPACITY_DELTA');
    expect(dto.version).toBe(5);
    expect(dto.delta?.amount).toBe('1000');
  });

  it('parses a valid reconciliation snapshot', () => {
    const dto = parseTreasuryMessage(Buffer.from(JSON.stringify(validSnapshot)));

    expect(dto.type).toBe('RECONCILIATION_SNAPSHOT');
    expect(dto.snapshot?.reserved).toBe('2500');
  });

  it.each([
    ['empty payload', null],
    ['not JSON', Buffer.from('not-json{')],
    [
      'missing delta for CAPACITY_DELTA',
      Buffer.from(JSON.stringify({ ...validDelta, delta: undefined })),
    ],
    [
      'float amount',
      Buffer.from(
        JSON.stringify({ ...validDelta, delta: { ...validDelta.delta, amount: '10.5' } }),
      ),
    ],
    [
      'negative amount',
      Buffer.from(JSON.stringify({ ...validDelta, delta: { ...validDelta.delta, amount: '-10' } })),
    ],
    [
      'bad currency',
      Buffer.from(
        JSON.stringify({ ...validDelta, delta: { ...validDelta.delta, currency: 'usd' } }),
      ),
    ],
    ['missing version', Buffer.from(JSON.stringify({ ...validDelta, version: undefined }))],
    ['non-integer version', Buffer.from(JSON.stringify({ ...validDelta, version: 1.5 }))],
    ['bad program id', Buffer.from(JSON.stringify({ ...validDelta, programId: '42' }))],
    ['unknown type', Buffer.from(JSON.stringify({ ...validDelta, type: 'SOMETHING_ELSE' }))],
    [
      'snapshot reserved not integer',
      Buffer.from(
        JSON.stringify({
          ...validSnapshot,
          snapshot: { ...validSnapshot.snapshot, reserved: '1e5' },
        }),
      ),
    ],
  ])('rejects %s as poison', (_name, payload) => {
    expect(() => parseTreasuryMessage(payload)).toThrow(PoisonMessageError);
  });
});
