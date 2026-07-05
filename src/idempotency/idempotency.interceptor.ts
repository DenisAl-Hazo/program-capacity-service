import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, of } from 'rxjs';
import { IdempotencyService } from './idempotency.service';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

/**
 * Fast path for duplicate mutations: enforces the Idempotency-Key header and replays
 * the stored response for already-processed keys. Concurrent duplicates that slip past
 * this pre-check are caught by the unique constraint inside the service transaction.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotencyService: IdempotencyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const key = request.header(IDEMPOTENCY_KEY_HEADER);
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `${IDEMPOTENCY_KEY_HEADER} header is required on mutating endpoints (max ${MAX_KEY_LENGTH} chars)`,
      );
    }

    const requestHash = this.idempotencyService.computeRequestHash({
      params: request.params,
      body: request.body,
    });
    const existing = await this.idempotencyService.findByKey(key);
    if (existing) {
      this.idempotencyService.assertSameRequest(existing, requestHash);
      const response = http.getResponse<Response>();
      response.status(existing.responseStatus ?? 200);
      return of(existing.responseBody);
    }

    return next.handle();
  }
}
