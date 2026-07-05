import { Reservation } from '../reservation.entity';

/** All amounts are strings of integer minor units — never JSON numbers. */
export interface ReservationResponse extends Record<string, unknown> {
  reservationId: string;
  programId: string;
  invoiceId: string;
  status: string;
  amount: string;
  currency: string;
  /** Amount held against capacity, in the program's base currency. */
  amountBase: string;
  fxRate: string | null;
  createdAt: string;
  releasedAt: string | null;
}

export function toReservationResponse(reservation: Reservation): ReservationResponse {
  return {
    reservationId: reservation.id,
    programId: reservation.programId,
    invoiceId: reservation.invoiceId,
    status: reservation.status,
    amount: reservation.amount.toString(),
    currency: reservation.currency,
    amountBase: reservation.amountBase.toString(),
    fxRate: reservation.fxRate,
    createdAt: reservation.createdAt.toISOString(),
    releasedAt: reservation.releasedAt ? reservation.releasedAt.toISOString() : null,
  };
}
