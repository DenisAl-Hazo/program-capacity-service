import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { CommonModule } from './common/common.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { ProgramsModule } from './programs/programs.module';
import { ReservationsModule } from './reservations/reservations.module';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    IdempotencyModule,
    ProgramsModule,
    ReservationsModule,
  ],
})
export class AppModule {}
