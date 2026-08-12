import { describe, expect, it } from 'vitest';
import { authFieldMessage, authFormMessage } from '@/features/auth/lib/auth-messages';
import { ApiError } from '@/lib/api/errors';
import {
  loginRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
} from '@/lib/api/generated/contracts/identity.contract';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';
import { fieldIssues } from '@/lib/forms/field-issues';
import { createTranslator } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * EVERY TREATMENT HAS COPY, AND NONE OF IT COMES FROM THE SERVER.
 *
 * §5.6: "NEVER render a server message to a user". The backend's `message` is
 * `safeMessage` — written for an operator, not translated, and not written for
 * this screen. A missing branch here is a screen that renders it anyway or
 * renders nothing, so the table is tested the same way `errors.ts` is.
 * ===========================================================================
 */

const t = createTranslator('en');
const hi = createTranslator('hi');

function apiError(
  code: Parameters<typeof errorWith>[0],
  extras: { method?: string; retryAfterSeconds?: number | null; reason?: 'EMAIL_NOT_VERIFIED' } = {},
): ApiError {
  return errorWith(code, extras);
}

function errorWith(
  code: ApiError['code'],
  extras: { method?: string; retryAfterSeconds?: number | null; reason?: 'EMAIL_NOT_VERIFIED' },
): ApiError {
  return new ApiError({
    status: 400,
    code,
    message: 'a server sentence nobody should ever read',
    method: extras.method ?? 'POST',
    reason: extras.reason ?? null,
    retryAfterSeconds: extras.retryAfterSeconds ?? null,
  });
}

describe('authFormMessage', () => {
  it('reads a 401 on sign-in as a credential verdict, and anywhere else as generic', () => {
    const error = apiError(ERROR_CODES.UNAUTHENTICATED);

    expect(authFormMessage(error, t, { credentialVerdict: true })).toBe(
      'That email and password do not match an account.',
    );
    // Without the flag it must NOT claim the credentials were wrong — the
    // caller is the only thing that knows whether a session was involved.
    expect(authFormMessage(error, t)).toBe('Something went wrong. Try again.');
  });

  it('puts the unverified-email recovery ahead of the code, as the table does', () => {
    const error = apiError(ERROR_CODES.FORBIDDEN, { reason: 'EMAIL_NOT_VERIFIED' });
    expect(authFormMessage(error, t)).toBe('Your email address is not verified yet.');
  });

  it('uses the backend’s own wait when it sends one, and a generic wait when it does not', () => {
    expect(
      authFormMessage(apiError(ERROR_CODES.RATE_LIMIT, { retryAfterSeconds: 30 }), t),
    ).toBe('Too many attempts. Try again in 30 seconds.');

    expect(authFormMessage(apiError(ERROR_CODES.RATE_LIMIT), t)).toBe(
      'Too many attempts. Wait a moment and try again.',
    );
  });

  it('covers every remaining treatment an auth screen can reach', () => {
    expect(authFormMessage(apiError(ERROR_CODES.DEPENDENCY), t)).toBe(
      'Something we rely on is unavailable right now. Try again shortly.',
    );
    expect(authFormMessage(apiError(ERROR_CODES.FORBIDDEN), t)).toBe(
      'That request was refused. Reload the page and try again.',
    );
    expect(authFormMessage(apiError(ERROR_CODES.FORBIDDEN, { method: 'GET' }), t)).toBe(
      'Something went wrong. Try again.',
    );
    expect(authFormMessage(apiError(ERROR_CODES.NOT_FOUND), t)).toBe(
      'This link has expired or has already been used.',
    );
    expect(authFormMessage(apiError(ERROR_CODES.VALIDATION), t)).toBe(
      'Something went wrong. Try again.',
    );
    expect(authFormMessage(apiError(ERROR_CODES.CONFLICT), t)).toBe(
      'Something went wrong. Try again.',
    );
    expect(authFormMessage(apiError(ERROR_CODES.INTERNAL), t)).toBe(
      'Something went wrong. Try again.',
    );
    expect(authFormMessage(apiError('UNKNOWN'), t)).toBe('Something went wrong. Try again.');
  });

  it('answers in the reader’s language, not the server’s', () => {
    expect(authFormMessage(apiError(ERROR_CODES.UNAUTHENTICATED), hi, { credentialVerdict: true })).toBe(
      'यह ईमेल और पासवर्ड किसी खाते से मेल नहीं खाते।',
    );
  });
});

describe('authFieldMessage', () => {
  it('says "fill this in" for a field that is absent rather than wrong', () => {
    const parsed = loginRequestSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const issues = fieldIssues(parsed.error);
    expect(authFieldMessage('email', issues.email!, t)).toBe('Fill this in to continue.');
    expect(authFieldMessage('password', issues.password!, t)).toBe('Fill this in to continue.');
  });

  it('names the rule the contract actually enforces', () => {
    const short = signupRequestSchema.safeParse({
      email: 'learner@example.com',
      password: 'short',
      role: 'student',
    });
    if (short.success) throw new Error('a five-character password must not pass');
    expect(authFieldMessage('password', fieldIssues(short.error).password!, t)).toBe(
      'Use at least 10 characters.',
    );

    const long = signupRequestSchema.safeParse({
      email: 'learner@example.com',
      password: 'x'.repeat(201),
      role: 'student',
    });
    if (long.success) throw new Error('a 201-character password must not pass');
    expect(authFieldMessage('password', fieldIssues(long.error).password!, t)).toBe(
      'Use at most 200 characters.',
    );
  });

  it('separates a malformed address from an absent one', () => {
    const parsed = loginRequestSchema.safeParse({ email: 'nope', password: 'a-real-password' });
    if (parsed.success) throw new Error('"nope" is not an email address');
    expect(authFieldMessage('email', fieldIssues(parsed.error).email!, t)).toBe(
      'Enter a valid email address.',
    );
  });

  it('explains a broken reset link rather than pointing at a control', () => {
    const parsed = resetPasswordRequestSchema.safeParse({ password: 'a-long-enough-password' });
    if (parsed.success) throw new Error('a reset without a token must not pass');
    expect(authFieldMessage('token', fieldIssues(parsed.error).token!, t)).toBe(
      'Fill this in to continue.',
    );
  });

  it('falls back to the generic required message for a field it has no rule for', () => {
    const parsed = signupRequestSchema.safeParse({
      email: 'learner@example.com',
      password: 'a-long-enough-password',
      role: 'super_admin',
    });
    if (parsed.success) throw new Error('signup must not accept a platform role');
    expect(authFieldMessage('role', fieldIssues(parsed.error).role!, t)).toBe(
      'Fill this in to continue.',
    );
  });
});
