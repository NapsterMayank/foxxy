import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import { createTranslator } from '@/lib/i18n/translate';
import { foxyErrorMessage } from '../lib/foxy-messages';

const t = createTranslator('en');

function error(init: Partial<ConstructorParameters<typeof ApiError>[0]> = {}): ApiError {
  return new ApiError({
    status: 500,
    code: 'UNKNOWN',
    message: 'operator sentence, never rendered',
    method: 'POST',
    ...init,
  });
}

describe('foxy error copy', () => {
  it('never renders the backend message', () => {
    expect(foxyErrorMessage(error(), t)).not.toContain('operator sentence');
  });

  it('names the wait when the backend gave one', () => {
    const message = foxyErrorMessage(
      error({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 30 }),
      t,
    );

    expect(message).toContain('30');
  });

  it('falls back to a wait without a number when the header was absent', () => {
    const message = foxyErrorMessage(error({ status: 429, code: ERROR_CODES.RATE_LIMIT }), t);

    expect(message).toBe('That was quick. Wait a moment before asking again.');
  });

  it('tells the student to reword a refused turn rather than reporting a fault', () => {
    const message = foxyErrorMessage(error({ status: 403, code: ERROR_CODES.FORBIDDEN }), t);

    expect(message).toBe('That question could not be sent. Try rewording it.');
  });

  it('sends the student to a new conversation when this one is gone', () => {
    const message = foxyErrorMessage(error({ status: 404, code: ERROR_CODES.NOT_FOUND }), t);

    expect(message).toContain('Start a new one.');
  });

  it('names a dependency failure as busy rather than broken', () => {
    const message = foxyErrorMessage(error({ status: 503, code: ERROR_CODES.DEPENDENCY }), t);

    expect(message).toBe('Foxy is busy right now. Try again in a moment.');
  });

  /*
   * A 401 redirects — `providers.tsx` owns that — but the screen renders for a
   * frame or two on the way out. A treatment that threw would crash it there.
   */
  it('renders rather than throwing on an expiring session', () => {
    const message = foxyErrorMessage(error({ status: 401, code: ERROR_CODES.UNAUTHENTICATED }), t);

    expect(message).toBe('Something interrupted the answer. Try asking again.');
  });

  it('says nothing about the daily cap, because it cannot tell', () => {
    // The allowance refusal and a pace limit are one code at this seam. The
    // screen states the cap from `usage.remaining` instead — see the header of
    // `foxy-messages.ts`.
    const message = foxyErrorMessage(
      error({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 40_000 }),
      t,
    );

    expect(message).not.toContain('tomorrow');
  });
});

describe('the caller’s own generic sentence', () => {
  /*
   * Opening a conversation and taking a turn both fail generically, and they
   * are not the same event: one never started, the other stopped. The default
   * wording belongs to the turn, so the start panel names its own.
   */
  it('is used for a treatment with no specific copy', () => {
    const message = foxyErrorMessage(error({ status: 500 }), t, {
      fallback: 'foxy.errorStartFailed',
    });

    expect(message).toBe('The conversation could not be started. Try again.');
  });

  it('never overrides a treatment that has its own sentence', () => {
    const message = foxyErrorMessage(
      error({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 30 }),
      t,
      { fallback: 'foxy.errorStartFailed' },
    );

    expect(message).toContain('30');
  });
});
