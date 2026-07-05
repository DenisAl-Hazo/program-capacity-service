import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/env.validation';

function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Program Capacity Service')
    .setDescription(
      'Tracks financing-program credit capacity: reservations, releases, availability. ' +
        'All amounts are strings of integer minor units (cents). All mutations require an ' +
        '`Idempotency-Key` header; every route except /health requires a bearer token ' +
        '(`npm run token:dev`).',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  setupSwagger(app);

  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get('port', { infer: true });

  await app.listen(port);
}

void bootstrap();
