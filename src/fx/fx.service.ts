import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnsupportedCurrencyPairError } from '../common/errors/domain-error';
import { Money } from '../common/money/money';
import { convertMinorUnits } from './fx-conversion';
import { FxRate } from './fx-rate.entity';

export interface FxConversion {
  /** Converted amount in the target currency's minor units. */
  amountBase: bigint;
  /** Rate used, null when no conversion happened (same currency). */
  fxRate: string | null;
  fxRateAsOf: Date | null;
}

@Injectable()
export class FxService {
  constructor(@InjectRepository(FxRate) private readonly fxRateRepository: Repository<FxRate>) {}

  /** Convert to the target currency, persisting evidence of the rate used. */
  async convert(money: Money, targetCurrency: string): Promise<FxConversion> {
    if (money.currency === targetCurrency) {
      return { amountBase: money.amount, fxRate: null, fxRateAsOf: null };
    }

    const rate = await this.fxRateRepository.findOneBy({
      fromCurrency: money.currency,
      toCurrency: targetCurrency,
    });
    if (!rate) {
      throw new UnsupportedCurrencyPairError(money.currency, targetCurrency);
    }

    return {
      amountBase: convertMinorUnits(money.amount, rate.rate),
      fxRate: rate.rate,
      fxRateAsOf: rate.asOf,
    };
  }
}
