import { ValueTransformer } from 'typeorm';

/**
 * Postgres BIGINT round-trips as a string in the pg driver; this keeps entity
 * fields as native bigint so money math never touches JS number.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value?: bigint | null): string | null | undefined =>
    value === null || value === undefined ? value : value.toString(),
  from: (value?: string | null): bigint | null | undefined =>
    value === null || value === undefined ? value : BigInt(value),
};
