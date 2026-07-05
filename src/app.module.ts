import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { CommonModule } from './common/common.module';
import { FxModule } from './fx/fx.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { ProgramsModule } from './programs/programs.module';
import { ReservationsModule } from './reservations/reservations.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    FxModule,
    IdempotencyModule,
    ProgramsModule,
    ReservationsModule,
    TreasuryModule,
  ],
})
export class AppModule {}
