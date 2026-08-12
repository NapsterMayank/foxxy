/**
 * The application error hierarchy — 01-BACKEND-IMPLEMENTATION-PLAN.md §5.
 *
 * Two messages, deliberately:
 *   `message`     goes to the logs. May contain detail useful to an engineer.
 *   `safeMessage` goes to the client. Must leak nothing — no identifiers,
 *                 no internal state, no stack trace.
 *
 * Every failure in the codebase throws one of these. Never a bare string.
 */

/** Machine-readable codes. The frontend branches on these, not on prose. */
export const ERROR_CODES = {
  VALIDATION: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  DEPENDENCY: 'DEPENDENCY_FAILURE',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppErrorOptions {
  /** Detail for the log line. Defaults to the safe message. */
  readonly message?: string;
  /** Structured detail for the log line. Never sent to the client. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** The underlying error, preserved for the log. */
  readonly cause?: unknown;
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  /** The only text that may reach a client. */
  abstract readonly safeMessage: string;

  readonly details: Readonly<Record<string, unknown>> | undefined;

  protected constructor(message: string, options?: AppErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options?.details;
    Error.captureStackTrace(this, new.target);
  }

  /** The client-facing body. Contains the code and the safe message only. */
  toClientPayload(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.safeMessage } };
  }
}

/** Narrowing helper — `instanceof` across module boundaries is fragile. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 400 — the request did not satisfy its schema or a stated rule. */
export class ValidationError extends AppError {
  readonly code = ERROR_CODES.VALIDATION;
  readonly httpStatus = 400;
  readonly safeMessage: string;

  constructor(safeMessage = 'The request is invalid.', options?: AppErrorOptions) {
    super(options?.message ?? safeMessage, options);
    this.safeMessage = safeMessage;
  }
}

/** 401 — no valid session. Says nothing about whether an account exists. */
export class UnauthenticatedError extends AppError {
  readonly code = ERROR_CODES.UNAUTHENTICATED;
  readonly httpStatus = 401;
  readonly safeMessage: string;

  constructor(safeMessage = 'Authentication required.', options?: AppErrorOptions) {
    super(options?.message ?? safeMessage, options);
    this.safeMessage = safeMessage;
  }
}

/**
 * 403 — authenticated, but not permitted.
 *
 * The safe message is fixed and contentless on purpose. "That student exists
 * but is not linked to you" is an enumeration leak wearing a different hat
 * (§7, rule 2).
 */
export class ForbiddenError extends AppError {
  readonly code = ERROR_CODES.FORBIDDEN;
  readonly httpStatus = 403;
  readonly safeMessage = 'Forbidden.';

  constructor(options?: AppErrorOptions) {
    super(options?.message ?? 'Forbidden.', options);
  }
}

/** 404 — the resource does not exist, or the actor may not know that it does. */
export class NotFoundError extends AppError {
  readonly code = ERROR_CODES.NOT_FOUND;
  readonly httpStatus = 404;
  readonly safeMessage: string;

  constructor(safeMessage = 'Not found.', options?: AppErrorOptions) {
    super(options?.message ?? safeMessage, options);
    this.safeMessage = safeMessage;
  }
}

/** 409 — the request conflicts with current state (e.g. a unique violation). */
export class ConflictError extends AppError {
  readonly code = ERROR_CODES.CONFLICT;
  readonly httpStatus = 409;
  readonly safeMessage: string;

  constructor(
    safeMessage = 'The request conflicts with the current state.',
    options?: AppErrorOptions,
  ) {
    super(options?.message ?? safeMessage, options);
    this.safeMessage = safeMessage;
  }
}

/** 429 — too many requests. `retryAfterSeconds` populates the header. */
export class RateLimitError extends AppError {
  readonly code = ERROR_CODES.RATE_LIMIT;
  readonly httpStatus = 429;
  readonly safeMessage = 'Too many requests. Please try again later.';
  readonly retryAfterSeconds: number | undefined;

  constructor(retryAfterSeconds?: number, options?: AppErrorOptions) {
    super(options?.message ?? 'Rate limit exceeded.', options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 502 — an external system we depend on failed or timed out. */
export class DependencyError extends AppError {
  readonly code = ERROR_CODES.DEPENDENCY;
  readonly httpStatus = 502;
  readonly safeMessage = 'A required service is unavailable. Please try again.';
  /** Which dependency. Log only — never sent to the client. */
  readonly dependency: string;

  constructor(dependency: string, options?: AppErrorOptions) {
    super(options?.message ?? `Dependency failed: ${dependency}`, options);
    this.dependency = dependency;
  }
}

/** 500 — anything we did not anticipate. The client is told nothing. */
export class InternalError extends AppError {
  readonly code = ERROR_CODES.INTERNAL;
  readonly httpStatus = 500;
  readonly safeMessage = 'Something went wrong.';

  constructor(options?: AppErrorOptions) {
    super(options?.message ?? 'Internal error.', options);
  }
}

/**
 * Normalises any thrown value into an AppError. Anything unrecognised becomes
 * an InternalError so no internal message or stack can reach a client.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new InternalError({ message: value.message, cause: value });
  }
  return new InternalError({ message: `Non-error thrown: ${String(value)}`, cause: value });
}
