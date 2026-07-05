import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { IDEMPOTENCY_KEY_HEADER } from './idempotency.interceptor';

/** Extracts the Idempotency-Key header; presence is enforced by IdempotencyInterceptor. */
export const IdempotencyKeyParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.header(IDEMPOTENCY_KEY_HEADER) as string;
  },
);
