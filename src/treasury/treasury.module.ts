import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CapacityLedgerEntry } from '../ledger/capacity-ledger-entry.entity';
import { Program } from '../programs/program.entity';
import { TreasuryConsumerService } from './treasury.consumer';
import { TreasuryProcessor } from './treasury.processor';

@Module({
  imports: [TypeOrmModule.forFeature([Program, CapacityLedgerEntry])],
  providers: [TreasuryProcessor, TreasuryConsumerService],
  exports: [TreasuryProcessor],
})
export class TreasuryModule {}
