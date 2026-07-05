import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateProgramDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /** Integer minor units as a string — floats are rejected at the boundary. */
  @Matches(/^\d+$/, { message: 'totalLimit must be a string of integer minor units' })
  totalLimit!: string;

  @Matches(/^[A-Z]{3}$/, { message: 'baseCurrency must be an ISO 4217 code' })
  baseCurrency!: string;
}
