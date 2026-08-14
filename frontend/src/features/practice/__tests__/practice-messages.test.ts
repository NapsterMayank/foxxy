import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import { createTranslator } from '@/lib/i18n/translate';
import { invalidReasonMessage, practiceErrorMessage } from '../lib/practice-messages';

const t = createTranslator('en');
const hi = createTranslator('hi');

function error(init: Partial<ConstructorParameters<typeof ApiError>[0]> = {}): ApiError {
  return new ApiError({
    status: 500,
    code: 'UNKNOWN',
    message: 'operator sentence, never rendered',
    method: 'POST',
    ...init,
  });
}

describe('practice error copy', () => {
  it('never renders the backend message', () => {
    expect(practiceErrorMessage(error(), t)).not.toContain('operator sentence');
  });

  /*
   * A 409 IS TWO DIFFERENT EVENTS. On `/answers` it is D-281 refusing a second
   * answer — the thing that used to let a session answered entirely wrong score
   * 100%. On `/submit` it is a session already finished. Only the caller knows
   * which request it made.
   */
  it('lets the caller say which conflict happened', () => {
    const answerConflict = practiceErrorMessage(
      error({ status: 409, code: ERROR_CODES.CONFLICT }),
      t,
      { conflict: 'practice.errorAnswerConflict' },
    );
    const submitConflict = practiceErrorMessage(
      error({ status: 409, code: ERROR_CODES.CONFLICT }),
      t,
      { conflict: 'practice.errorSubmitConflict' },
    );

    expect(answerConflict).toBe('This question already has an answer, and answers cannot be changed.');
    expect(submitConflict).toBe('This session was already finished.');
  });

  it('has a conflict sentence even when the caller names none', () => {
    const message = practiceErrorMessage(error({ status: 409, code: ERROR_CODES.CONFLICT }), t);

    expect(message).toBe('That was already recorded. Carry on from where the screen is now.');
  });

  it('names the wait when the backend gave one', () => {
    const message = practiceErrorMessage(
      error({ status: 429, code: ERROR_CODES.RATE_LIMIT, retryAfterSeconds: 12 }),
      t,
    );

    expect(message).toContain('12');
  });

  it('sends the student to a new session when this one is gone', () => {
    const message = practiceErrorMessage(error({ status: 404, code: ERROR_CODES.NOT_FOUND }), t);

    expect(message).toContain('Start a new one.');
  });

  it('uses the caller’s fallback for a treatment with no copy of its own', () => {
    const message = practiceErrorMessage(error(), t, { fallback: 'practice.errorStartFailed' });

    expect(message).toBe('The practice session could not be started. Try again.');
  });
});

describe('why an attempt did not count', () => {
  it('says nothing when the attempt was valid', () => {
    expect(invalidReasonMessage(null, t)).toBe('');
  });

  it('explains what to do differently, never the reason code', () => {
    const message = invalidReasonMessage('too_fast', t);

    expect(message).toContain('Take your time');
    expect(message).not.toContain('too_fast');
  });

  it('covers the same-answer rule', () => {
    expect(invalidReasonMessage('all_same_answer', t)).toContain('same option');
  });

  /*
   * `invalidReason` is a plain `string` on the wire — the anti-cheat union is
   * not on the contract — so this table CANNOT be exhaustive. §10.4 still
   * requires that an invalid attempt shows its reason, and a raw code shown to
   * a child is not showing a reason.
   */
  it('still says something for a rule this build has never heard of', () => {
    const message = invalidReasonMessage('response_count_mismatch', t);

    expect(message).toBe('Something about this attempt could not be counted. Try the chapter again.');
    expect(message).not.toContain('response_count_mismatch');
  });

  it('speaks Hindi to a Hindi reader', () => {
    expect(invalidReasonMessage('too_fast', hi)).toContain('आराम से');
  });
});

describe('the treatments practice can meet', () => {
  it('waits without a number when the header was absent', () => {
    const message = practiceErrorMessage(error({ status: 429, code: ERROR_CODES.RATE_LIMIT }), t);

    expect(message).toBe('That was quick. Wait a moment and try again.');
  });

  it('names a dependency failure as unavailable rather than broken', () => {
    const message = practiceErrorMessage(error({ status: 503, code: ERROR_CODES.DEPENDENCY }), t);

    expect(message).toBe('Something we rely on is unavailable right now. Try again shortly.');
  });

  /*
   * A 400 here is CONTRACT DRIFT, not a typo: the body was built from the
   * generated schema and parsed by it before leaving. There is nothing for the
   * student to correct, so it must not point at a control.
   */
  it('reads a rejected body as generic, because nothing on screen caused it', () => {
    const message = practiceErrorMessage(error({ status: 400, code: ERROR_CODES.VALIDATION }), t);

    expect(message).toBe('Something went wrong. Try again.');
  });

  it('renders rather than throwing on an expiring session', () => {
    const message = practiceErrorMessage(
      error({ status: 401, code: ERROR_CODES.UNAUTHENTICATED }),
      t,
    );

    expect(message).toBe('Something went wrong. Try again.');
  });

  it('reads a refused state change without signing anybody out', () => {
    const message = practiceErrorMessage(error({ status: 403, code: ERROR_CODES.FORBIDDEN }), t);

    expect(message).toBe('Something went wrong. Try again.');
  });
});
