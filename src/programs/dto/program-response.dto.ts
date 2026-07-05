import { Program } from '../program.entity';

/** All amounts are strings of integer minor units — never JSON numbers. */
export interface ProgramResponse extends Record<string, unknown> {
  programId: string;
  name: string;
  baseCurrency: string;
  totalLimit: string;
  reserved: string;
  available: string;
  appliedVersion: string;
  createdAt: string;
}

export function toProgramResponse(program: Program): ProgramResponse {
  return {
    programId: program.id,
    name: program.name,
    baseCurrency: program.baseCurrency,
    totalLimit: program.totalLimit.toString(),
    reserved: program.reserved.toString(),
    available: (program.totalLimit - program.reserved).toString(),
    appliedVersion: program.appliedVersion.toString(),
    createdAt: program.createdAt.toISOString(),
  };
}
