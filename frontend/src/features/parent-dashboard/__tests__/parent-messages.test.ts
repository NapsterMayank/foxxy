import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import { createTranslator } from '@/lib/i18n/translate';
import { parentErrorMessage } from '../lib/parent-messages';

const t = createTranslator('en');

function error(init: Partial<ConstructorParameters<typeof ApiError>[0]> = {}): ApiError {
  return new ApiError({
    status: 500,
    code: 'UNKNOWN',
    message: 'operator sentence, never rendered',
    method: 'GET',
    ...init,
  });
}

describe('parent dashboard error copy', () => {
  it('never renders the backend message', () => {
    expect(parentErrorMessage(error(), t)).not.toContain('operator sentence');
  });

  /*
   * A 403 on a GET is usually the CHILD having revoked the link — a right the
   * product gives the child and the parent cannot override. It reads as a state
   * rather than a fault, and it says who can restore it.
   */
  it('explains a withdrawn link as a state, and says only the child can restore it', () => {
    const message = parentErrorMessage(error({ status: 403, code: ERROR_CODES.FORBIDDEN }), t);

    expect(message).toBe(
      'You no longer have access to this child’s learning. Only your child can give it again.',
    );
  });

  /*
   * The SAME code on a POST is a different event: the backend returns 403
   * before 401 on state-changing requests, so this is usually a stale page
   * rather than a withdrawn permission — and telling a parent their access was
   * removed when it was not would be a false alarm about their own child.
   */
  it('reads a refused revoke as a stale page, not as a withdrawn link', () => {
    const message = parentErrorMessage(
      error({ status: 403, code: ERROR_CODES.FORBIDDEN, method: 'POST' }),
      t,
    );

    expect(message).toBe('That request was refused. Reload the page and try again.');
  });

  it('names the wait when the backend gave one', () => {
    expect(
      parentErrorMessage(error({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 9 }), t),
    ).toContain('9');
  });

  it('waits without a number when the header was absent', () => {
    expect(parentErrorMessage(error({ status: 429, code: ERROR_CODES.RATE_LIMIT }), t)).toBe(
      'Too many requests. Wait a moment and try again.',
    );
  });

  it('names a dependency failure as unavailable rather than broken', () => {
    expect(parentErrorMessage(error({ status: 503, code: ERROR_CODES.DEPENDENCY }), t)).toBe(
      'Something we rely on is unavailable right now. Try again shortly.',
    );
  });

  it('says plainly when something is gone', () => {
    expect(parentErrorMessage(error({ status: 404, code: ERROR_CODES.NOT_FOUND }), t)).toBe(
      'This is no longer available.',
    );
  });

  it('renders rather than throwing on an expiring session', () => {
    expect(parentErrorMessage(error({ status: 401, code: ERROR_CODES.UNAUTHENTICATED }), t)).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('reads a rejected body as generic, because nothing on screen caused it', () => {
    expect(parentErrorMessage(error({ status: 400, code: ERROR_CODES.VALIDATION }), t)).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('treats a conflict as generic rather than inventing a parent-specific case', () => {
    expect(parentErrorMessage(error({ status: 409, code: ERROR_CODES.CONFLICT }), t)).toBe(
      'Something went wrong. Try again.',
    );
  });
});
