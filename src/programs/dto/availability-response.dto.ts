import { Program } from '../program.entity';

/** All amounts are strings of integer minor units — never JSON numbers. */
export interface AvailabilityResponse extends Record<string, unknown> {
  programId: string;
  baseCurrency: string;
  totalLimit: string;
  reserved: string;
  available: string;
  appliedVersion: string;
  asOf: string;
}

export function toAvailabilityResponse(program: Program): AvailabilityResponse {
  return {
    programId: program.id,
    baseCurrency: program.baseCurrency,
    totalLimit: program.totalLimit.toString(),
    reserved: program.reserved.toString(),
    available: (program.totalLimit - program.reserved).toString(),
    appliedVersion: program.appliedVersion.toString(),
    asOf: program.updatedAt.toISOString(),
  };
}
