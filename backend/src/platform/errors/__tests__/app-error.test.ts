import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  DependencyError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnauthenticatedError,
  ValidationError,
  isAppError,
  toAppError,
} from '../app-error';

describe('the error hierarchy', () => {
  it.each([
    [new ValidationError(), 400, 'VALIDATION_ERROR'],
    [new UnauthenticatedError(), 401, 'UNAUTHENTICATED'],
    [new ForbiddenError(), 403, 'FORBIDDEN'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new RateLimitError(), 429, 'RATE_LIMIT_EXCEEDED'],
    [new DependencyError('llm'), 502, 'DEPENDENCY_FAILURE'],
    [new InternalError(), 500, 'INTERNAL_ERROR'],
  ])('maps %s to its status and code', (error, status, code) => {
    expect(error.httpStatus).toBe(status);
    expect(error.code).toBe(code);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
  });

  it('names each error after its class', () => {
    expect(new ValidationError().name).toBe('ValidationError');
    expect(new DependencyError('mail').name).toBe('DependencyError');
  });
});

describe('message versus safeMessage', () => {
  it('keeps the detailed message out of the client payload', () => {
    const error = new ValidationError('The request is invalid.', {
      message: 'grade must be a string, received number 6',
    });
    expect(error.message).toBe('grade must be a string, received number 6');
    expect(error.safeMessage).toBe('The request is invalid.');
    expect(error.toClientPayload()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'The request is invalid.' },
    });
  });

  it('defaults message to safeMessage when no detail is supplied', () => {
    const error = new NotFoundError('Chapter not found.');
    expect(error.message).toBe('Chapter not found.');
  });

  it('gives ForbiddenError a contentless safe message — no enumeration leak', () => {
    const error = new ForbiddenError({ message: 'parent p1 has a pending link to student s9' });
    expect(error.safeMessage).toBe('Forbidden.');
    expect(JSON.stringify(error.toClientPayload())).not.toContain('s9');
  });

  it('never reveals which dependency failed to the client', () => {
    const error = new DependencyError('voyage');
    expect(error.dependency).toBe('voyage');
    expect(error.safeMessage).not.toContain('voyage');
  });

  it('tells the client nothing at all on an internal error', () => {
    const error = new InternalError({ message: 'connection pool exhausted at pool.ts:41' });
    expect(error.safeMessage).toBe('Something went wrong.');
    expect(JSON.stringify(error.toClientPayload())).not.toContain('pool.ts');
  });
});

describe('optional fields', () => {
  it('carries retryAfterSeconds on a rate-limit error', () => {
    expect(new RateLimitError(90).retryAfterSeconds).toBe(90);
    expect(new RateLimitError().retryAfterSeconds).toBeUndefined();
  });

  it('carries structured details for the log side only', () => {
    const error = new ConflictError('Already exists.', { details: { table: 'users' } });
    expect(error.details).toEqual({ table: 'users' });
    expect(JSON.stringify(error.toClientPayload())).not.toContain('users');
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new DependencyError('cache', { cause });
    expect(error.cause).toBe(cause);
  });

  it('leaves details undefined when none are given', () => {
    expect(new ValidationError().details).toBeUndefined();
  });
});

describe('isAppError', () => {
  it('recognises an AppError', () => {
    expect(isAppError(new ForbiddenError())).toBe(true);
  });

  it('rejects a plain Error, a string, null and undefined', () => {
    expect(isAppError(new Error('nope'))).toBe(false);
    expect(isAppError('nope')).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const error = new NotFoundError();
    expect(toAppError(error)).toBe(error);
  });

  it('wraps a plain Error as an InternalError, keeping the message for the log', () => {
    const result = toAppError(new Error('relation "users" does not exist'));
    expect(result).toBeInstanceOf(InternalError);
    expect(result.message).toBe('relation "users" does not exist');
    expect(result.safeMessage).toBe('Something went wrong.');
    expect(result.httpStatus).toBe(500);
  });

  it('wraps a non-Error throw', () => {
    const result = toAppError('a bare string was thrown');
    expect(result).toBeInstanceOf(InternalError);
    expect(result.message).toContain('a bare string was thrown');
  });

  it('wraps null', () => {
    expect(toAppError(null)).toBeInstanceOf(InternalError);
  });
});
