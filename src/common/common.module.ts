import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env.validation';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        pinoHttp: {
          level: configService.get('logLevel', { infer: true }),
          redact: ['req.headers.authorization'],
          genReqId: (req) =>
            (req.headers['x-correlation-id'] as string | undefined) ??
            `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          customProps: (req) => ({
            correlationId: req.headers['x-correlation-id'] ?? req.id,
          }),
        },
      }),
    }),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*splat}');
  }
}
