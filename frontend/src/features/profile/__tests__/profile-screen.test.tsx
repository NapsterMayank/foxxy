import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileScreen } from '../profile-screen';

/**
 * ===========================================================================
 * THE PROFILE SCREEN.
 *
 * The assertions that matter are about WHAT IS SENT, not about what is drawn:
 *
 *  - a save carries the fields that changed and nothing else, so a student who
 *    fixes a spelling does not silently rewrite their grade;
 *  - a form with nothing changed cannot be submitted at all, because the
 *    contract refuses an empty PATCH and the honest answer to "save what?" is
 *    a disabled button rather than a 400;
 *  - a 404 is NOT an error. It is a student who has not finished onboarding,
 *    and the screen sends them there instead of telling them something broke.
 * ===========================================================================
 */

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const profile = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Aarav',
  grade: '10',
  board: 'CBSE',
  preferredLanguage: 'en',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-12T09:00:00.000Z',
};

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProfileScreen', () => {
  it('shows the profile the server holds', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileScreen />);

    const name = await screen.findByLabelText(/display name/i);
    expect((name as HTMLInputElement).value).toBe('Aarav');
    expect((screen.getByLabelText(/^grade/i) as HTMLSelectElement).value).toBe('10');
    expect((screen.getByLabelText(/english/i) as HTMLInputElement).checked).toBe(true);
    // The board is stated and NOT editable — no input, just the fact.
    expect(screen.getByText('CBSE')).toBeTruthy();
  });

  it('cannot be saved until something changes', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileScreen />);

    const save = await screen.findByRole('button', { name: /save changes/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(await screen.findByLabelText(/display name/i), {
      target: { value: 'Aarav K' },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends only the field that changed', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileScreen />);

    fireEvent.change(await screen.findByLabelText(/display name/i), {
      target: { value: 'Aarav K' },
    });

    fetchMock.mockResolvedValueOnce(json({ profile: { ...profile, displayName: 'Aarav K' } }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ displayName: 'Aarav K' });
    expect(await screen.findByText(/profile is updated/i)).toBeTruthy();
  });

  it('sends a grade and a language when those are what moved', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileScreen />);

    fireEvent.change(await screen.findByLabelText(/^grade/i), { target: { value: '9' } });
    /*
     * BY VALUE, NOT BY LABEL. The Hindi option is labelled "हिन्दी" in BOTH
     * dictionaries — §8 keeps a language's own name in that language, so a
     * student scanning the list finds it whichever way the interface is set.
     * A test matching /hindi/i would be asserting an English label that must
     * never exist.
     */
    const hindi = screen
      .getAllByRole('radio')
      .find((radio) => (radio as HTMLInputElement).value === 'hi');
    fireEvent.click(hindi as HTMLElement);

    fetchMock.mockResolvedValueOnce(
      json({ profile: { ...profile, grade: '9', preferredLanguage: 'hi' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ grade: '9', preferredLanguage: 'hi' });
  });

  it('reports a refused save without losing what was typed', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileScreen />);

    const name = await screen.findByLabelText(/display name/i);
    fireEvent.change(name, { target: { value: 'Aarav K' } });

    fetchMock.mockResolvedValueOnce(json({ error: { code: 'INTERNAL' } }, 500));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText(/display name/i) as HTMLInputElement).value).toBe('Aarav K');
  });

  it('refuses an empty name in the client, before the network', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileScreen />);

    fireEvent.change(await screen.findByLabelText(/display name/i), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/enter the name you want to be called/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 as unfinished onboarding, not as a failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'NOT_FOUND' } }, 404));

    render(<ProfileScreen />);

    expect(await screen.findByText(/no profile yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('offers a retry when the read genuinely fails', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'INTERNAL' } }, 500));

    render(<ProfileScreen />);

    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
  });
});
