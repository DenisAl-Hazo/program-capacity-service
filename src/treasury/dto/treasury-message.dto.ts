import { plainToInstance, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { DomainError } from '../../common/errors/domain-error';

/** Message that cannot ever succeed — route to DLQ and ack, do not retry. */
export class PoisonMessageError extends DomainError {}

export const TREASURY_MESSAGE_TYPES = ['CAPACITY_DELTA', 'RECONCILIATION_SNAPSHOT'] as const;
export type TreasuryMessageType = (typeof TREASURY_MESSAGE_TYPES)[number];

export class TreasuryDeltaDto {
  @IsIn(['RESERVE', 'RELEASE'])
  direction!: 'RESERVE' | 'RELEASE';

  @Matches(/^[1-9]\d*$/, { message: 'amount must be a positive integer string of minor units' })
  amount!: string;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class TreasurySnapshotDto {
  @Matches(/^\d+$/, { message: 'totalLimit must be an integer string of minor units' })
  totalLimit!: string;

  @Matches(/^\d+$/, { message: 'reserved must be an integer string of minor units' })
  reserved!: string;

  @Matches(/^[A-Z]{3}$/)
  baseCurrency!: string;
}

export class TreasuryMessageDto {
  @IsIn(TREASURY_MESSAGE_TYPES)
  type!: TreasuryMessageType;

  @IsUUID()
  programId!: string;

  /** Monotonic per-program version from treasury — the ordering source of truth. */
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;

  @ValidateIf((o: TreasuryMessageDto) => o.type === 'CAPACITY_DELTA')
  @IsDefined({ message: 'delta payload is required for CAPACITY_DELTA' })
  @ValidateNested()
  @Type(() => TreasuryDeltaDto)
  delta?: TreasuryDeltaDto;

  @ValidateIf((o: TreasuryMessageDto) => o.type === 'RECONCILIATION_SNAPSHOT')
  @IsDefined({ message: 'snapshot payload is required for RECONCILIATION_SNAPSHOT' })
  @ValidateNested()
  @Type(() => TreasurySnapshotDto)
  snapshot?: TreasurySnapshotDto;
}

/** Decode + schema-validate a raw Kafka payload. Throws PoisonMessageError on any defect. */
export function parseTreasuryMessage(raw: Buffer | string | null | undefined): TreasuryMessageDto {
  if (raw === null || raw === undefined || raw.length === 0) {
    throw new PoisonMessageError('empty message payload');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new PoisonMessageError('payload is not valid JSON');
  }

  const dto = plainToInstance(TreasuryMessageDto, parsed);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join('; '))
      .filter(Boolean)
      .join(' | ');
    throw new PoisonMessageError(`schema validation failed: ${details}`);
  }
  return dto;
}
