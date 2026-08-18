import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileIdentity } from '../components/profile-identity';

/**
 * The header identity. One assertion carries the whole component: it must
 * never render a name it made up. The screen it replaced greeted every user in
 * the product as "Aarav".
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
  displayName: 'Meera',
  grade: '10',
  board: 'CBSE',
  preferredLanguage: 'en',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-12T09:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProfileIdentity', () => {
  it('renders the signed-in name and links to the profile', async () => {
    fetchMock.mockResolvedValueOnce(json({ profile }));

    render(<ProfileIdentity roleLabel="Student" />);

    expect(await screen.findByText('Meera')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/student/profile');
  });

  it('says "your account" rather than inventing a name when there is no profile', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'NOT_FOUND' } }, 404));

    render(<ProfileIdentity roleLabel="Student" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(await screen.findByText(/your account/i)).toBeTruthy();
    expect(screen.queryByText('Aarav')).toBeNull();
  });
});
