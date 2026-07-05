import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyKeyParam } from '../idempotency/idempotency-key.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { AvailabilityResponse } from './dto/availability-response.dto';
import { CreateProgramDto } from './dto/create-program.dto';
import { ProgramResponse } from './dto/program-response.dto';
import { ProgramsService } from './programs.service';

@Controller('programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() dto: CreateProgramDto,
    @IdempotencyKeyParam() idempotencyKey: string,
  ): Promise<ProgramResponse> {
    return this.programsService.create(dto, idempotencyKey);
  }

  @Get(':id/availability')
  availability(@Param('id', ParseUUIDPipe) programId: string): Promise<AvailabilityResponse> {
    return this.programsService.getAvailability(programId);
  }
}
