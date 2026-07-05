import { InvalidMoneyError } from '../common/errors/domain-error';

const RATE_SCALE = 8;
const RATE_DENOMINATOR = 10n ** BigInt(RATE_SCALE);
const RATE_RE = /^\d+(\.\d{1,8})?$/;

/**
 * Convert integer minor units with a decimal rate string using pure bigint math.
 * Rounding: half-up on the converted minor units (DECISIONS.md §6). No floats, ever.
 */
export function convertMinorUnits(amount: bigint, rate: string): bigint {
  if (amount < 0n) {
    throw new InvalidMoneyError(`conversion amount must be non-negative, got ${amount}`);
  }
  if (!RATE_RE.test(rate)) {
    throw new InvalidMoneyError(`invalid FX rate format: "${rate}"`);
  }

  const [integerPart, fractionPart = ''] = rate.split('.');
  const scaledRate =
    BigInt(integerPart) * RATE_DENOMINATOR + BigInt(fractionPart.padEnd(RATE_SCALE, '0'));

  return (amount * scaledRate + RATE_DENOMINATOR / 2n) / RATE_DENOMINATOR;
}
