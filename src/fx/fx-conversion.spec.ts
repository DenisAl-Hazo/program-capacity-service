import { InvalidMoneyError } from '../common/errors/domain-error';
import { convertMinorUnits } from './fx-conversion';

describe('convertMinorUnits', () => {
  it('converts with an 8-decimal rate exactly', () => {
    // 10000 EUR-cents * 1.0865 = 10865 USD-cents, no rounding needed
    expect(convertMinorUnits(10000n, '1.08650000')).toBe(10865n);
  });

  it('rounds half-up: exactly .5 goes up', () => {
    // 5 * 0.5 = 2.5 -> 3
    expect(convertMinorUnits(5n, '0.50000000')).toBe(3n);
  });

  it('rounds down below the midpoint', () => {
    // 5 * 0.49999999 = 2.49999995 -> 2
    expect(convertMinorUnits(5n, '0.49999999')).toBe(2n);
  });

  it('rounds up above the midpoint', () => {
    // 1 * 0.9204 = 0.9204 -> 1
    expect(convertMinorUnits(1n, '0.92040000')).toBe(1n);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    // 9007199254740993 * 2 — impossible with JS floats, exact with bigint
    expect(convertMinorUnits(9007199254740993n, '2')).toBe(18014398509481986n);
  });

  it('supports integer and short-fraction rates', () => {
    expect(convertMinorUnits(100n, '2')).toBe(200n);
    expect(convertMinorUnits(100n, '1.5')).toBe(150n);
  });

  it('zero amount converts to zero', () => {
    expect(convertMinorUnits(0n, '1.08650000')).toBe(0n);
  });

  it.each(['-1', '1,5', '1.123456789', 'abc', ''])('rejects malformed rate "%s"', (rate) => {
    expect(() => convertMinorUnits(100n, rate)).toThrow(InvalidMoneyError);
  });

  it('rejects negative amounts', () => {
    expect(() => convertMinorUnits(-1n, '1.5')).toThrow(InvalidMoneyError);
  });
});
