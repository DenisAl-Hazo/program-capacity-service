export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class ProgramNotFoundError extends DomainError {
  constructor(programId: string) {
    super(`program ${programId} not found`);
  }
}

export class ReservationNotFoundError extends DomainError {
  constructor(reservationId: string) {
    super(`reservation ${reservationId} not found`);
  }
}

export class InsufficientCapacityError extends DomainError {
  constructor(programId: string) {
    super(`insufficient capacity on program ${programId}`);
  }
}

export class DuplicateInvoiceError extends DomainError {
  constructor(invoiceId: string) {
    super(`invoice ${invoiceId} already has a reservation for this program`);
  }
}

export class ReservationAlreadyReleasedError extends DomainError {
  constructor(reservationId: string) {
    super(`reservation ${reservationId} is already released`);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super('idempotency key was already used with a different request body');
  }
}
