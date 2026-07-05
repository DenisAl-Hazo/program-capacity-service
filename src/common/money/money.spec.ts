import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-error';
import { Money } from './money';

describe('Money', () => {
  describe('of', () => {
    it('creates money from bigint minor units and ISO currency', () => {
      const money = Money.of(1_000_000_00n, 'USD');

      expect(money.amount).toBe(100000000n);
      expect(money.currency).toBe('USD');
    });

    it('rejects negative amounts', () => {
      expect(() => Money.of(-1n, 'USD')).toThrow(InvalidMoneyError);
    });

    it.each(['usd', 'US', 'USDT', 'U1D', ''])('rejects invalid currency "%s"', (currency) => {
      expect(() => Money.of(1n, currency)).toThrow(InvalidMoneyError);
    });
  });

  describe('fromString', () => {
    it('parses a string of integer minor units', () => {
      expect(Money.fromString('1000000000', 'EUR').amount).toBe(1000000000n);
    });

    it('parses amounts beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
      const money = Money.fromString('9007199254740993', 'USD');

      expect(money.amount).toBe(9007199254740993n);
      expect(money.amountAsString()).toBe('9007199254740993');
    });

    it.each(['1.5', '-3', '1e5', '', ' 1', '1 ', '+1', '0x10', 'NaN'])(
      'rejects non-integer amount "%s"',
      (amount) => {
        expect(() => Money.fromString(amount, 'USD')).toThrow(InvalidMoneyError);
      },
    );

    it('accepts zero', () => {
      expect(Money.fromString('0', 'USD').isZero()).toBe(true);
    });
  });

  describe('arithmetic', () => {
    it('adds amounts of the same currency', () => {
      const result = Money.of(100n, 'USD').add(Money.of(250n, 'USD'));

      expect(result.equals(Money.of(350n, 'USD'))).toBe(true);
    });

    it('subtracts amounts of the same currency', () => {
      const result = Money.of(350n, 'USD').subtract(Money.of(100n, 'USD'));

      expect(result.equals(Money.of(250n, 'USD'))).toBe(true);
    });

    it('rejects subtraction that would go negative', () => {
      expect(() => Money.of(100n, 'USD').subtract(Money.of(101n, 'USD'))).toThrow(
        InvalidMoneyError,
      );
    });

    it('rejects addition across currencies', () => {
      expect(() => Money.of(100n, 'USD').add(Money.of(100n, 'EUR'))).toThrow(CurrencyMismatchError);
    });

    it('rejects subtraction across currencies', () => {
      expect(() => Money.of(100n, 'USD').subtract(Money.of(1n, 'EUR'))).toThrow(
        CurrencyMismatchError,
      );
    });

    it('rejects comparison across currencies', () => {
      expect(() => Money.of(100n, 'USD').greaterThan(Money.of(1n, 'EUR'))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('comparison', () => {
    it('compares amounts of the same currency', () => {
      expect(Money.of(2n, 'USD').greaterThan(Money.of(1n, 'USD'))).toBe(true);
      expect(Money.of(1n, 'USD').greaterThan(Money.of(2n, 'USD'))).toBe(false);
    });

    it('equals requires same amount and currency', () => {
      expect(Money.of(1n, 'USD').equals(Money.of(1n, 'USD'))).toBe(true);
      expect(Money.of(1n, 'USD').equals(Money.of(1n, 'EUR'))).toBe(false);
      expect(Money.of(1n, 'USD').equals(Money.of(2n, 'USD'))).toBe(false);
    });
  });
});
