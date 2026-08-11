import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { notifyUnauthenticated, resetUnauthenticatedListeners } from '../session-events';
import { SessionProvider, useSession } from '../session-provider';

/**
 * SESSION STATE — plan §5.5.
 *
 * The first test is the one that matters: `loading` must not redirect. §5.5
 * calls that "the single most common bug in cookie-session applications", and
 * its signature is that every user is signed out by pressing refresh — which
 * looks like a backend session bug and is not one.
 */

const replace = vi.fn();
let pathname = '/student';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

const fetchMock = vi.fn();

function Probe() {
  const { status, user } = useSession();
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'status' }, status),
    createElement('span', { 'data-testid': 'user' }, user?.email ?? 'none'),
  );
}

function renderProvider(): { queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionProvider, null, createElement(Probe) as ReactNode),
    ),
  );
  return { queryClient };
}

function userResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'kid@example.test',
          role: 'student',
          emailVerifiedAt: '2026-08-01T00:00:00.000Z',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      }),
  } as unknown as Response;
}

function unauthenticatedResponse(): Response {
  return {
    ok: false,
    status: 401,
    headers: new Headers(),
    json: () => Promise.resolve({ error: { code: 'UNAUTHENTICATED', message: 'Auth required.' } }),
  } as unknown as Response;
}

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  pathname = '/student';
  resetUnauthenticatedListeners();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the bootstrap', () => {
  it('reports loading before the answer arrives, and never redirects', async () => {
    // A request that never settles — the state every page load starts in.
    fetchMock.mockReturnValue(new Promise(() => undefined));

    renderProvider();

    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(replace).not.toHaveBeenCalled();
  });

  it('reports the authenticated user once the bootstrap returns', async () => {
    fetchMock.mockResolvedValue(userResponse());

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });
    expect(screen.getByTestId('user')).toHaveTextContent('kid@example.test');
    expect(replace).not.toHaveBeenCalled();
  });

  it('asks exactly once, with credentials, at the bootstrap endpoint', async () => {
    fetchMock.mockResolvedValue(userResponse());

    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/me');
    // Without this the request is anonymous and the symptom is "randomly
    // logged out" — see the client's header comment.
    expect(init.credentials).toBe('include');
  });

  it('reports unauthenticated on a 401 without retrying it', async () => {
    fetchMock.mockResolvedValue(unauthenticatedResponse());

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    });
    // A 401 is an ANSWER. Retrying it delays the redirect by the whole backoff
    // schedule and hammers the auth pool with a question already answered.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mid-session expiry', () => {
  it('clears the query cache and redirects carrying ?next=', async () => {
    fetchMock.mockResolvedValue(userResponse());
    const { queryClient } = renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    // Something a previous user's screen had fetched.
    queryClient.setQueryData(['practice', 'history'], { sessions: ['secret'] });

    act(() => {
      notifyUnauthenticated();
    });

    /*
     * THE CACHE CLEAR IS NOT TIDINESS. On a shared family device the next
     * person to sign in would otherwise see this data rendered from cache
     * before their own first request returns.
     */
    await waitFor(() => {
      expect(queryClient.getQueryData(['practice', 'history'])).toBeUndefined();
    });
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fstudent');
  });

  it('does not append ?next= when already on the login route', async () => {
    pathname = '/login';
    fetchMock.mockResolvedValue(unauthenticatedResponse());
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    });

    act(() => {
      notifyUnauthenticated();
    });

    // `?next=/login` would send a successful sign-in straight back to the form.
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('survives a burst of parallel 401s', async () => {
    fetchMock.mockResolvedValue(userResponse());
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    // Every in-flight request failing at once is the ordinary case on an
    // expired session, not an edge one.
    act(() => {
      notifyUnauthenticated();
      notifyUnauthenticated();
      notifyUnauthenticated();
    });

    expect(replace).toHaveBeenCalledWith('/login?next=%2Fstudent');
  });
});

describe('useSession outside the provider', () => {
  it('throws rather than reporting a signed-in user as signed out', () => {
    // A default would be indistinguishable from a real signed-out user, and
    // would send a signed-in person to login because a provider was missing.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(createElement(Probe))).toThrow(/useSession must be used/);
    error.mockRestore();
  });
});

describe('ApiError plumbing', () => {
  it('is what the providers detect a 401 by', () => {
    const error = new ApiError({
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Auth required.',
      method: 'GET',
    });
    expect(error.status).toBe(401);
  });
});
