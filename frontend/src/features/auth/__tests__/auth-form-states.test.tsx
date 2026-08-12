import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthForm, safeNextPath } from '@/features/auth/auth-form';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';

/**
 * ===========================================================================
 * AUTH FORMS AGAINST THE LIVE CLIENT — build-order steps 7-8.
 *
 * These replace the `?preview=` suite, which asserted that a fixture string
 * painted a fixture banner. Every state here comes from a request: a real
 * schema rejecting real input, or a real status code arriving at the mutation.
 * ===========================================================================
 */

const replace = vi.fn();
let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => '/login',
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * ANCHORED, NOT EXACT AND NOT SUBSTRING.
 *
 * `FormField` renders a required marker inside the `<label>`, so the label's
 * text is "Email address*" and an exact match finds nothing. A substring match
 * has the opposite problem: "New password" also matches "Confirm new
 * password". Anchoring at the start is the only form that hits exactly one.
 */
function typeInto(label: string, value: string): void {
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  fireEvent.change(screen.getByLabelText(pattern), { target: { value } });
}

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  search = new URLSearchParams();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('client-side validation', () => {
  /*
   * THE REASON THIS IS CLIENT-SIDE AT ALL. The backend's error envelope is
   * `{ error: { code, message } }` — no field is named in it — so a 400 cannot
   * be mapped onto a control. The generated request schema can, and it is the
   * backend's own schema, so the rules cannot drift.
   */
  it('shows a per-field message and sends nothing', () => {
    render(<AuthForm kind="login" role="student" />);

    typeInto('Email address', 'not-an-email');
    typeInto('Password', 'whatever');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a password the contract would reject, with the contract’s own rule', () => {
    render(<AuthForm kind="signup" role="student" />);

    typeInto('Email address', 'learner@example.com');
    typeInto('Password', 'short');
    typeInto('Confirm password', 'short');
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));

    // 10, from `passwordSchema` — not the 8 the presentational form claimed.
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('catches a confirmation mismatch before the schema sees anything', () => {
    render(<AuthForm kind="signup" role="student" />);

    typeInto('Email address', 'learner@example.com');
    typeInto('Password', 'a-long-enough-password');
    typeInto('Confirm password', 'a-different-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByText('Passwords must match.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sign-in', () => {
  const profile = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'learner@example.com',
    role: 'student',
    emailVerifiedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  it('honours ?next= after a successful sign-in', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: profile }));
    search = new URLSearchParams('next=%2Fpractice%2Fsession');

    render(<AuthForm kind="login" role="student" />);
    typeInto('Email address', 'learner@example.com');
    typeInto('Password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/practice/session');
    });
  });

  it('falls back to the role home when there is no ?next=', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { user: { ...profile, role: 'parent' } }));

    render(<AuthForm kind="login" role="parent" />);
    typeInto('Email address', 'parent@example.com');
    typeInto('Password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/parent');
    });
  });

  /*
   * A 401 ON THE SIGN-IN REQUEST IS A VERDICT ON WHAT WAS TYPED, and §5.6's
   * `session-expired` treatment — correct everywhere else — would tell someone
   * standing on the login page that they had been signed out.
   */
  it('reads a 401 as wrong credentials, not as an expired session', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Login failed.' } }),
    );

    render(<AuthForm kind="login" role="student" />);
    typeInto('Email address', 'learner@example.com');
    typeInto('Password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('That email and password do not match an account.'),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers the verification recovery when the address is unverified', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'Verify your email.', reason: 'EMAIL_NOT_VERIFIED' },
      }),
    );

    render(<AuthForm kind="login" role="student" />);
    typeInto('Email address', 'learner@example.com');
    typeInto('Password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Your email address is not verified yet.')).toBeInTheDocument();
  });

  it('shows the wait when the backend rate-limits, with its own number', async () => {
    fetchMock.mockResolvedValue(
      // The WIRE value, `RATE_LIMIT_EXCEEDED` — not the key `RATE_LIMIT` it is
      // reached by. A code the client does not recognise becomes `UNKNOWN` and
      // falls to the generic message, so getting this wrong in a test is
      // indistinguishable from getting the treatment wrong in the product.
      jsonResponse(
        429,
        { error: { code: ERROR_CODES.RATE_LIMIT, message: 'Slow down.' } },
        { 'retry-after': '45' },
      ),
    );

    render(<AuthForm kind="login" role="student" />);
    typeInto('Email address', 'learner@example.com');
    typeInto('Password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Too many attempts. Try again in 45 seconds.')).toBeInTheDocument();
  });
});

describe('the recovery screens say the same thing either way', () => {
  it('reports a sent reset without confirming the address exists', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));

    render(<AuthForm kind="forgot-password" role="student" />);
    typeInto('Email address', 'nobody@example.com');
    fireEvent.submit(screen.getByRole('button', { name: 'Send reset link' }));

    expect(
      await screen.findByText('If that address has an account, reset instructions are on their way.'),
    ).toBeInTheDocument();
  });

  it('takes the reset token from the URL, never from a control', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    search = new URLSearchParams('token=opaque-reset-token');

    render(<AuthForm kind="reset-password" role="student" />);
    typeInto('New password', 'a-long-enough-password');
    typeInto('Confirm new password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Save new password' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'opaque-reset-token',
      password: 'a-long-enough-password',
    });
  });

  it('explains a reset link that has already been used', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'No such token.' } }),
    );
    search = new URLSearchParams('token=spent-token');

    render(<AuthForm kind="reset-password" role="student" />);
    typeInto('New password', 'a-long-enough-password');
    typeInto('Confirm new password', 'a-long-enough-password');
    fireEvent.submit(screen.getByRole('button', { name: 'Save new password' }));

    expect(
      await screen.findByText('This link has expired or has already been used.'),
    ).toBeInTheDocument();
  });
});

/**
 * `?next=` ARRIVES IN A URL ANYONE CAN SEND TO ANYONE.
 *
 * The protocol-relative case is the one a "starts with /" check waves through,
 * and it is a full origin change — which is an open redirect on the one screen
 * where the person has just typed their password.
 */
describe('safeNextPath', () => {
  it('accepts a same-document path', () => {
    expect(safeNextPath('/parent/child/123')).toBe('/parent/child/123');
  });

  it('refuses another origin, however it is spelled', () => {
    expect(safeNextPath('//evil.example/login')).toBeNull();
    expect(safeNextPath('https://evil.example/login')).toBeNull();
    expect(safeNextPath('javascript:alert(1)')).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });
});
