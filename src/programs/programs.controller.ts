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
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IdempotencyKeyParam } from '../idempotency/idempotency-key.decorator';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { AvailabilityResponse } from './dto/availability-response.dto';
import { CreateProgramDto } from './dto/create-program.dto';
import { ProgramResponse } from './dto/program-response.dto';
import { ProgramsService } from './programs.service';

@ApiTags('programs')
@ApiBearerAuth()
@Controller('programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Create a financing program' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique per request; retries must resend the same key + body',
  })
  @ApiResponse({
    status: 201,
    description: 'Program created (amounts are strings of integer minor units)',
  })
  @ApiResponse({ status: 409, description: 'Idempotency-Key reused with a different body' })
  create(
    @Body() dto: CreateProgramDto,
    @IdempotencyKeyParam() idempotencyKey: string,
  ): Promise<ProgramResponse> {
    return this.programsService.create(dto, idempotencyKey);
  }

  @Get(':id/availability')
  @ApiOperation({ summary: 'Current total / reserved / available capacity' })
  @ApiResponse({ status: 200, description: 'Availability with applied treasury version' })
  @ApiResponse({ status: 404, description: 'Unknown program' })
  availability(@Param('id', ParseUUIDPipe) programId: string): Promise<AvailabilityResponse> {
    return this.programsService.getAvailability(programId);
  }
}
