import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { isUniqueViolation } from '../common/database/pg-errors';
import {
  CurrencyMismatchError,
  DuplicateInvoiceError,
  InsufficientCapacityError,
  ProgramNotFoundError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../common/errors/domain-error';
import { Money } from '../common/money/money';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { CapacityLedgerEntry } from '../ledger/capacity-ledger-entry.entity';
import { Program } from '../programs/program.entity';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationResponse, toReservationResponse } from './dto/reservation-response.dto';
import { Reservation } from './reservation.entity';

@Injectable()
export class ReservationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
  ) {}

  async reserve(
    programId: string,
    dto: CreateReservationDto,
    idempotencyKey: string,
  ): Promise<ReservationResponse> {
    const requested = Money.fromString(dto.amount, dto.currency);
    const requestHash = this.idempotency.computeRequestHash({ programId, ...dto });

    try {
      return await this.dataSource.transaction(async (manager) => {
        const program = await manager.getRepository(Program).findOneBy({ id: programId });
        if (!program) {
          throw new ProgramNotFoundError(programId);
        }
        // Cross-currency conversion lands with the FX phase; until then reject explicitly.
        if (requested.currency !== program.baseCurrency) {
          throw new CurrencyMismatchError(program.baseCurrency, requested.currency);
        }
        const amountBase = requested.amount;

        const reservationRepo = manager.getRepository(Reservation);
        const reservation = await reservationRepo.save(
          reservationRepo.create({
            programId,
            invoiceId: dto.invoiceId,
            amount: requested.amount,
            currency: requested.currency,
            amountBase,
            fxRate: null,
            fxRateAsOf: null,
            status: 'RESERVED',
            releasedAt: null,
          }),
        );

        await this.applyCapacityDelta(manager, programId, amountBase);

        await manager.getRepository(CapacityLedgerEntry).insert({
          programId,
          reservationId: reservation.id,
          entryType: 'RESERVE',
          amount: requested.amount,
          currency: requested.currency,
          amountBase,
          fxRate: null,
          fxRateAsOf: null,
          source: 'API',
          idempotencyKey,
        });

        const response = toReservationResponse(reservation);
        await this.idempotency.saveResult(manager, {
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      // Retry with the same key (incl. concurrent duplicates): replay the committed response.
      const replayed = await this.idempotency.tryReplay<ReservationResponse>(
        idempotencyKey,
        requestHash,
      );
      if (replayed) {
        return replayed;
      }
      if (isUniqueViolation(error, 'uq_reservations_program_invoice')) {
        throw new DuplicateInvoiceError(dto.invoiceId);
      }
      throw error;
    }
  }

  async release(reservationId: string, idempotencyKey: string): Promise<ReservationResponse> {
    const requestHash = this.idempotency.computeRequestHash({ reservationId });

    try {
      return await this.dataSource.transaction(async (manager) => {
        const reservation = await manager.getRepository(Reservation).findOne({
          where: { id: reservationId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!reservation) {
          throw new ReservationNotFoundError(reservationId);
        }
        if (reservation.status === 'RELEASED') {
          throw new ReservationAlreadyReleasedError(reservationId);
        }

        const releasedAt = new Date();
        await manager
          .getRepository(Reservation)
          .update({ id: reservationId }, { status: 'RELEASED', releasedAt });

        // Returns exactly what was held at reservation time — no FX re-conversion drift.
        await this.applyCapacityDelta(manager, reservation.programId, -reservation.amountBase);

        await manager.getRepository(CapacityLedgerEntry).insert({
          programId: reservation.programId,
          reservationId: reservation.id,
          entryType: 'RELEASE',
          amount: reservation.amount,
          currency: reservation.currency,
          amountBase: -reservation.amountBase,
          fxRate: reservation.fxRate,
          fxRateAsOf: reservation.fxRateAsOf,
          source: 'API',
          idempotencyKey,
        });

        reservation.status = 'RELEASED';
        reservation.releasedAt = releasedAt;
        const response = toReservationResponse(reservation);
        await this.idempotency.saveResult(manager, {
          key: idempotencyKey,
          requestHash,
          responseStatus: 200,
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      const replayed = await this.idempotency.tryReplay<ReservationResponse>(
        idempotencyKey,
        requestHash,
      );
      if (replayed) {
        return replayed;
      }
      throw error;
    }
  }

  /**
   * THE atomic capacity operation. The WHERE clause makes overdraw impossible under
   * concurrency: the check and the write are one statement, and the CHECK constraint
   * on programs.reserved is the last-resort backstop.
   */
  private async applyCapacityDelta(
    manager: EntityManager,
    programId: string,
    delta: bigint,
  ): Promise<void> {
    // TypeORM returns [rows, rowCount] for UPDATE statements on the pg driver.
    const [rows] = await manager.query<[Array<{ reserved: string }>, number]>(
      `UPDATE programs
          SET reserved = reserved + $1, updated_at = now()
        WHERE id = $2
          AND reserved + $1 <= total_limit
          AND reserved + $1 >= 0
        RETURNING reserved`,
      [delta.toString(), programId],
    );

    if (rows.length === 0) {
      throw new InsufficientCapacityError(programId);
    }
  }
}
