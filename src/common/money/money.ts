import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-error';

const ISO_4217_RE = /^[A-Z]{3}$/;
const INTEGER_MINOR_UNITS_RE = /^\d+$/;

/**
 * Immutable money value: integer minor units (bigint) + ISO 4217 currency.
 * Amounts are non-negative; signed ledger deltas are a persistence concern, not a Money concern.
 */
export class Money {
  private constructor(
    readonly amount: bigint,
    readonly currency: string,
  ) {}

  static of(amount: bigint, currency: string): Money {
    if (!ISO_4217_RE.test(currency)) {
      throw new InvalidMoneyError(`invalid ISO 4217 currency code: "${currency}"`);
    }
    if (amount < 0n) {
      throw new InvalidMoneyError(`amount must be non-negative, got ${amount}`);
    }
    return new Money(amount, currency);
  }

  /** Parse from the wire format: a string of integer minor units. Rejects floats, signs, exponents. */
  static fromString(amount: string, currency: string): Money {
    if (!INTEGER_MINOR_UNITS_RE.test(amount)) {
      throw new InvalidMoneyError(
        `amount must be a string of integer minor units, got "${amount}"`,
      );
    }
    return Money.of(BigInt(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.amount - other.amount;
    if (result < 0n) {
      throw new InvalidMoneyError(
        `subtraction would produce a negative amount: ${this.amount} - ${other.amount}`,
      );
    }
    return new Money(result, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  /** Wire/DB representation of the amount — string, never a JS number. */
  amountAsString(): string {
    return this.amount.toString();
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
