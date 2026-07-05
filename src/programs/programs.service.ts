import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Money } from '../common/money/money';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { CreateProgramDto } from './dto/create-program.dto';
import { ProgramResponse, toProgramResponse } from './dto/program-response.dto';
import { Program } from './program.entity';

@Injectable()
export class ProgramsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(dto: CreateProgramDto, idempotencyKey: string): Promise<ProgramResponse> {
    const totalLimit = Money.fromString(dto.totalLimit, dto.baseCurrency);
    const requestHash = this.idempotency.computeRequestHash(dto);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const repository = manager.getRepository(Program);
        const program = await repository.save(
          repository.create({
            name: dto.name,
            totalLimit: totalLimit.amount,
            reserved: 0n,
            baseCurrency: dto.baseCurrency,
            appliedVersion: 0n,
          }),
        );

        const response = toProgramResponse(program);
        await this.idempotency.saveResult(manager, {
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      const replayed = await this.idempotency.tryReplay<ProgramResponse>(
        idempotencyKey,
        requestHash,
      );
      if (replayed) {
        return replayed;
      }
      throw error;
    }
  }
}
