import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateReservationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  invoiceId!: string;

  /** Positive integer minor units as a string — floats and zero are rejected. */
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer of minor units, as a string',
  })
  amount!: string;

  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
}
