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
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IdempotencyKeyParam } from '../idempotency/idempotency-key.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ReservationResponse } from './dto/reservation-response.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('programs/:programId/reservations')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Reserve capacity for an approved invoice (atomic check)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique per request; retries must resend the same key + body',
  })
  @ApiResponse({
    status: 201,
    description: 'Capacity reserved; cross-currency amounts converted with the persisted FX rate',
  })
  @ApiResponse({
    status: 409,
    description: 'Insufficient capacity, duplicate invoice, or key reuse',
  })
  @ApiResponse({ status: 422, description: 'Unknown FX pair' })
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
  @ApiOperation({
    summary: 'Release a reservation (returns exactly the amount held — no FX drift)',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique per request; retries must resend the same key',
  })
  @ApiResponse({ status: 200, description: 'Capacity returned' })
  @ApiResponse({ status: 409, description: 'Already released (with a different key)' })
  release(
    @Param('id', ParseUUIDPipe) reservationId: string,
    @IdempotencyKeyParam() idempotencyKey: string,
  ): Promise<ReservationResponse> {
    return this.reservationsService.release(reservationId, idempotencyKey);
  }
}
