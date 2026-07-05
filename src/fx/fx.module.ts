import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FxRate } from './fx-rate.entity';
import { FxService } from './fx.service';

@Module({
  imports: [TypeOrmModule.forFeature([FxRate])],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
