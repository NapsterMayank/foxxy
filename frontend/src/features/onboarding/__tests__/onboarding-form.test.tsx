import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingForm } from '@/features/onboarding/onboarding-form';
import { ERROR_CODES } from '@/lib/api/generated/error-codes';

/**
 * ===========================================================================
 * ONBOARDING AGAINST THE LIVE CLIENT — build-order step 8.
 *
 * The two roles do not share an endpoint. A student creates a learner profile;
 * a parent claims a link code, which produces a `pending` link that grants
 * nothing until the child approves it.
 * ===========================================================================
 */

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/onboarding',
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

function label(text: string): RegExp {
  return new RegExp(`^${text}`);
}

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the student journey', () => {
  /*
   * THE SUBJECT LIST IS THE PILOT SCOPE, FROM THE GENERATED CONSTANT.
   * The presentational form offered English and Social Science as well; both
   * would have written a subject with no chapters, no questions and no corpus
   * behind it, and a student would have met that as an empty practice screen.
   */
  it('offers only the subjects the backend has content for', () => {
    render(<OnboardingForm role="student" />);

    expect(screen.getByRole('checkbox', { name: 'Mathematics' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Science' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'English' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Social Science' })).not.toBeInTheDocument();
  });

  it('refuses to submit with no subject chosen, and says which control', () => {
    render(<OnboardingForm role="student" />);

    fireEvent.change(screen.getByLabelText(label('Display name')), { target: { value: 'Asha' } });
    fireEvent.change(screen.getByLabelText(label('Grade')), { target: { value: '8' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }));

    expect(screen.getByText('Choose at least one subject.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /*
   * GRADE TRAVELS AS A STRING. `gradeSchema` is `z.string().refine(isGrade)`
   * for a measured reason (D-038): Postgres casts the integer 6 to '6'
   * silently, so a JSON number reaches the column, and every later comparison
   * against '6' matches nothing — an empty question list for one cohort, which
   * reads as missing content rather than as a bug.
   */
  it('sends the profile with the grade as a string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        profile: {
          userId: '11111111-1111-4111-8111-111111111111',
          displayName: 'Asha',
          grade: '8',
          board: 'CBSE',
          preferredLanguage: 'en',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
        subjects: ['mathematics'],
        created: true,
      }),
    );

    render(<OnboardingForm role="student" />);
    fireEvent.change(screen.getByLabelText(label('Display name')), { target: { value: 'Asha' } });
    fireEvent.change(screen.getByLabelText(label('Grade')), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mathematics' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/me/onboarding');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.grade).toBe('8');
    expect(body.subjects).toEqual(['mathematics']);
  });
});

describe('the parent journey', () => {
  it('asks for the link code and nothing the backend cannot store', () => {
    render(<OnboardingForm role="parent" />);

    expect(screen.getByLabelText(label('Child invitation code'))).toBeInTheDocument();
    // There is no parent profile endpoint anywhere in the backend, so a name
    // field here would be collected and dropped.
    expect(screen.queryByLabelText(label('Your name'))).not.toBeInTheDocument();
  });

  it('will not submit without the guardian confirmation', () => {
    render(<OnboardingForm role="parent" />);

    fireEvent.change(screen.getByLabelText(label('Child invitation code')), {
      target: { value: 'AB12CD' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }));

    expect(
      screen.getByText('Confirm you are the parent or guardian to continue.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* `linkCodeSchema` upper-cases, and the backend looks up nothing else. */
  it('upper-cases the code on the way out', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        link: {
          id: '22222222-2222-4222-8222-222222222222',
          parentUserId: '33333333-3333-4333-8333-333333333333',
          studentUserId: '44444444-4444-4444-8444-444444444444',
          status: 'pending',
          approvedAt: null,
          revokedAt: null,
          createdAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    );

    render(<OnboardingForm role="parent" />);
    fireEvent.change(screen.getByLabelText(label('Child invitation code')), {
      target: { value: 'ab12cd' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ code: 'AB12CD' });
  });

  /*
   * A LINK IS `pending` AND GRANTS NOTHING (§6.8). Copy that said "connected"
   * would be describing consent the student has not given.
   */
  it('names the approval that still has to happen', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        link: {
          id: '22222222-2222-4222-8222-222222222222',
          parentUserId: '33333333-3333-4333-8333-333333333333',
          studentUserId: '44444444-4444-4444-8444-444444444444',
          status: 'pending',
          approvedAt: null,
          revokedAt: null,
          createdAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    );

    render(<OnboardingForm role="parent" />);
    fireEvent.change(screen.getByLabelText(label('Child invitation code')), {
      target: { value: 'AB12CD' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }));

    expect(
      await screen.findByText(
        'Request sent. Your child approves it from their account before you see anything.',
      ),
    ).toBeInTheDocument();
  });

  it('tells a parent to ask for a fresh code when the old one is gone', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: ERROR_CODES.NOT_FOUND, message: 'No such code.' } }),
    );

    render(<OnboardingForm role="parent" />);
    fireEvent.change(screen.getByLabelText(label('Child invitation code')), {
      target: { value: 'AB12CD' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }));

    expect(
      await screen.findByText('That code is not valid. Ask your child for a fresh one.'),
    ).toBeInTheDocument();
  });
});
