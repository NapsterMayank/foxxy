import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyPanel } from '@/features/auth/verify-panel';

let search = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => '/verify',
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  search = new URLSearchParams();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('email verification', () => {
  it('says the link is incomplete rather than sitting blank with no token', () => {
    render(<VerifyPanel />);

    expect(screen.getByRole('alert')).toHaveTextContent('This link is incomplete.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('spends the token from the URL and confirms', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    search = new URLSearchParams('token=opaque-verification-token');

    render(<VerifyPanel />);

    expect(await screen.findByText('Your email is verified. Sign in to continue.')).toBeInTheDocument();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/auth/verify?token=opaque-verification-token');
    // A GET: the person clicked a link in an email, and the browser navigated.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
  });

  /*
   * VERIFICATION CONSUMES THE TOKEN, so a second call fails where the first
   * succeeded. React double-invokes effects on mount in development, and
   * without the guard the failure paints over the success — in development
   * only, which is the worst place for a bug to live.
   */
  it('fires exactly once even when the effect runs twice', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    search = new URLSearchParams('token=opaque-verification-token');

    const { rerender } = render(<VerifyPanel />);
    rerender(<VerifyPanel />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Your email is verified.');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains a spent link and still offers the way out', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'No such token.' } }),
    );
    search = new URLSearchParams('token=already-used');

    render(<VerifyPanel />);

    expect(
      await screen.findByText('This link has expired or has already been used.'),
    ).toBeInTheDocument();
    // The resend form is the recovery §5.6 requires, and it is still on screen.
    expect(screen.getByRole('button', { name: 'Send the link again' })).toBeInTheDocument();
  });

  it('validates the resend address before asking for anything', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } }));
    search = new URLSearchParams('token=already-used');

    render(<VerifyPanel />);
    await screen.findByRole('button', { name: 'Send the link again' });
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText(/^Email address/), { target: { value: 'not-an-email' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Send the link again' }));

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * THE SAME SENTENCE WHETHER OR NOT THE ADDRESS EXISTS. The endpoint returns
   * a constant response so this screen cannot become an oracle for which
   * addresses have accounts, or — a second bit — which are already verified.
   */
  it('reports a resend without confirming anything about the address', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } }));
    search = new URLSearchParams('token=already-used');

    render(<VerifyPanel />);
    await screen.findByRole('button', { name: 'Send the link again' });

    fetchMock.mockResolvedValue(jsonResponse(202, { status: 'ok' }));
    fireEvent.change(screen.getByLabelText(/^Email address/), {
      target: { value: 'nobody@example.com' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Send the link again' }));

    expect(
      await screen.findByText('If that address needs verifying, a new link is on its way.'),
    ).toBeInTheDocument();
  });
});
