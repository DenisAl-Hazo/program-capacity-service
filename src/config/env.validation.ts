import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),

  KAFKA_BROKERS: Joi.string().required(),
  KAFKA_CLIENT_ID: Joi.string().required(),
  KAFKA_GROUP_ID: Joi.string().required(),
  KAFKA_TREASURY_TOPIC: Joi.string().required(),
  KAFKA_DLQ_TOPIC: Joi.string().required(),

  JWT_SECRET: Joi.string().min(16).required(),
  JWT_ISSUER: Joi.string().required(),
  JWT_AUDIENCE: Joi.string().required(),
  JWT_EXPIRES_IN: Joi.string().default('3600s'),
});

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
    treasuryTopic: string;
    dlqTopic: string;
  };
  jwt: {
    secret: string;
    issuer: string;
    audience: string;
    expiresIn: string;
  };
}

export const appConfigFactory = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: process.env.DATABASE_URL!,
  kafka: {
    brokers: process.env.KAFKA_BROKERS!.split(',').map((b) => b.trim()),
    clientId: process.env.KAFKA_CLIENT_ID!,
    groupId: process.env.KAFKA_GROUP_ID!,
    treasuryTopic: process.env.KAFKA_TREASURY_TOPIC!,
    dlqTopic: process.env.KAFKA_DLQ_TOPIC!,
  },
  jwt: {
    secret: process.env.JWT_SECRET!,
    issuer: process.env.JWT_ISSUER!,
    audience: process.env.JWT_AUDIENCE!,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '3600s',
  },
});
