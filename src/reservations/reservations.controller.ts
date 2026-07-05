import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyKeyParam } from '../idempotency/idempotency-key.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationResponse } from './dto/reservation-response.dto';
import { ReservationsService } from './reservations.service';

@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('programs/:programId/reservations')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  reserve(
    @Param('programId', ParseUUIDPipe) programId: string,
    @Body() dto: CreateReservationDto,
    @IdempotencyKeyParam() idempotencyKey: string,
  ): Promise<ReservationResponse> {
    return this.reservationsService.reserve(programId, dto, idempotencyKey);
  }

  @Post('reservations/:id/release')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(IdempotencyInterceptor)
  release(
    @Param('id', ParseUUIDPipe) reservationId: string,
    @IdempotencyKeyParam() idempotencyKey: string,
  ): Promise<ReservationResponse> {
    return this.reservationsService.release(reservationId, idempotencyKey);
  }
}
