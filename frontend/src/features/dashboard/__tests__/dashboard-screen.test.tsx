import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardScreen } from '../dashboard-screen';

/**
 * ===========================================================================
 * THE STUDENT DASHBOARD — open item 51.
 *
 * The assertions are about what this screen is no longer allowed to do: greet
 * a student by a name nobody supplied, name a chapter nobody chose, or claim a
 * week of practice that no endpoint carries.
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

const mission = {
  mission: {
    chapterId: '11111111-1111-4111-8111-111111111111',
    chapterNumber: 3,
    chapterTitleEn: 'Life Processes',
    chapterTitleHi: 'जैव प्रक्रम',
    subjectCode: 'science',
    reason: 'due_review',
    reasonEn: 'You practised this three days ago and it is due for review.',
    reasonHi: 'आपने इसे तीन दिन पहले किया था और अब दोहराव का समय है।',
    evidence: 'developing',
    suggestedQuestionCount: 8,
  },
};

const progress = {
  chapters: [
    {
      chapterId: '11111111-1111-4111-8111-111111111111',
      chapterTitleEn: 'Life Processes',
      chapterTitleHi: 'जैव प्रक्रम',
      evidence: 'developing',
      attempts: 3,
      lastPractisedAt: '2026-08-12T09:00:00.000Z',
      nextReviewAt: null,
    },
    {
      chapterId: '22222222-2222-4222-8222-222222222222',
      chapterTitleEn: 'Fractions',
      chapterTitleHi: null,
      evidence: 'not_assessed',
      attempts: 0,
      lastPractisedAt: null,
      nextReviewAt: null,
    },
  ],
  totalXp: 420,
  xpToday: 30,
  sessionsCompleted: 7,
};

const profile = {
  profile: {
    userId: '33333333-3333-4333-8333-333333333333',
    displayName: 'Meera',
    grade: '10',
    board: 'CBSE',
    preferredLanguage: 'en',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T09:00:00.000Z',
  },
};

/** Routes the three parallel reads by path, since their order is not fixed. */
function serve(
  overrides: {
    mission?: Response;
    progress?: Response;
    profile?: Response;
  } = {},
): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/practice/mission')) {
      return Promise.resolve(overrides.mission ?? json(mission));
    }
    if (url.includes('/practice/progress')) {
      return Promise.resolve(overrides.progress ?? json(progress));
    }
    return Promise.resolve(overrides.profile ?? json(profile));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DashboardScreen', () => {
  it('greets the signed-in student and shows the mission the server chose', async () => {
    serve();

    render(<DashboardScreen />);

    expect(await screen.findByText(/hello, meera/i)).toBeTruthy();
    expect(screen.getByText(/chapter 3 · life processes/i)).toBeTruthy();
    expect(screen.getByText(/due for review/i)).toBeTruthy();
    expect(screen.getByText(/8 questions/i)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /start practice/i }).getAttribute('href'),
    ).toBe('/student/practice');
  });

  it('never invents a name when the profile is missing', async () => {
    serve({ profile: json({ error: { code: 'NOT_FOUND' } }, 404) });

    render(<DashboardScreen />);

    expect(await screen.findByText(/^hello$/i)).toBeTruthy();
    expect(screen.queryByText(/aarav/i)).toBeNull();
  });

  it('shows the ledger figures and where the student left off', async () => {
    serve();

    render(<DashboardScreen />);

    expect(await screen.findByText('420')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/life processes · practised/i)).toBeTruthy();
  });

  it('says nothing has been practised rather than picking an unpractised chapter', async () => {
    serve({
      progress: json({
        ...progress,
        chapters: progress.chapters.map((c) => ({ ...c, lastPractisedAt: null })),
        sessionsCompleted: 0,
      }),
    });

    render(<DashboardScreen />);

    expect(await screen.findByText(/have not finished a practice session/i)).toBeTruthy();
  });

  it('renders without the ledger when the ledger fails, and keeps the mission', async () => {
    serve({ progress: json({ error: { code: 'INTERNAL' } }, 500) });

    render(<DashboardScreen />);

    expect(await screen.findByText(/chapter 3 · life processes/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/have not finished a practice session/i)).toBeTruthy());
    expect(screen.queryByText('420')).toBeNull();
  });

  it('says so plainly when there is nothing to practise', async () => {
    serve({ mission: json({ mission: null }) });

    render(<DashboardScreen />);

    expect(await screen.findByText(/nothing to practise yet/i)).toBeTruthy();
  });

  it('offers a retry when the mission itself fails', async () => {
    serve({ mission: json({ error: { code: 'INTERNAL' } }, 500) });

    render(<DashboardScreen />);

    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('reads the Hindi chapter title and reason when the interface is Hindi', async () => {
    serve();

    render(<DashboardScreen />, { language: 'hi' });

    // Twice on purpose: the mission names it, and the "where you left off"
    // line names the same chapter — both in Hindi.
    expect((await screen.findAllByText(/जैव प्रक्रम/)).length).toBe(2);
    expect(screen.getByText(/दोहराव का समय है/)).toBeTruthy();
  });
});
