import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  CurrencyMismatchError,
  DomainError,
  DuplicateInvoiceError,
  IdempotencyConflictError,
  InsufficientCapacityError,
  InvalidMoneyError,
  ProgramNotFoundError,
  ReservationAlreadyReleasedError,
  ReservationNotFoundError,
} from '../errors/domain-error';

interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  correlationId?: string;
  timestamp: string;
  path: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { statusCode, message } = this.resolve(exception);

    const errorName = exception instanceof Error ? exception.name : 'Error';

    if (statusCode >= 500) {
      this.logger.error(
        {
          correlationId: request.headers['x-correlation-id'],
          path: request.url,
          err: exception instanceof Error ? exception.message : String(exception),
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const body: ErrorResponseBody = {
      statusCode,
      message,
      error: errorName,
      correlationId: request.headers['x-correlation-id'] as string | undefined,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(statusCode).json(body);
  }

  private resolve(exception: unknown): { statusCode: number; message: string | string[] } {
    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      const message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : ((exceptionResponse as { message?: string | string[] }).message ?? exception.message);
      return { statusCode: exception.getStatus(), message };
    }

    if (exception instanceof DomainError) {
      return { statusCode: this.domainStatus(exception), message: exception.message };
    }

    // Unknown error: generic message only — never leak internals to the client.
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }

  private domainStatus(exception: DomainError): number {
    if (
      exception instanceof ProgramNotFoundError ||
      exception instanceof ReservationNotFoundError
    ) {
      return HttpStatus.NOT_FOUND;
    }
    if (
      exception instanceof InsufficientCapacityError ||
      exception instanceof DuplicateInvoiceError ||
      exception instanceof ReservationAlreadyReleasedError ||
      exception instanceof IdempotencyConflictError
    ) {
      return HttpStatus.CONFLICT;
    }
    if (exception instanceof CurrencyMismatchError) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }
    if (exception instanceof InvalidMoneyError) {
      return HttpStatus.BAD_REQUEST;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
