import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressScreen } from '../progress-screen';

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const chapters = [
  {
    chapterId: '11111111-1111-4111-8111-111111111111',
    chapterTitleEn: 'Life Processes',
    chapterTitleHi: 'जैव प्रक्रम',
    evidence: 'strong',
    attempts: 4,
    lastPractisedAt: '2026-08-12T09:00:00.000Z',
    nextReviewAt: '2026-08-21T09:00:00.000Z',
  },
  {
    chapterId: '22222222-2222-4222-8222-222222222222',
    chapterTitleEn: 'Fractions',
    chapterTitleHi: null,
    evidence: 'needs_another_session',
    attempts: 1,
    lastPractisedAt: null,
    nextReviewAt: null,
  },
];

const history = {
  sessions: [
    {
      sessionId: '33333333-3333-4333-8333-333333333333',
      chapterId: chapters[0].chapterId,
      chapterTitleEn: 'Life Processes',
      chapterTitleHi: 'जैव प्रक्रम',
      startedAt: '2026-08-12T09:00:00.000Z',
      submittedAt: '2026-08-12T09:12:00.000Z',
      scorePercent: 83,
      xpAwarded: 110,
      isValid: true,
      invalidReason: null,
    },
    {
      sessionId: '44444444-4444-4444-8444-444444444444',
      chapterId: chapters[1].chapterId,
      chapterTitleEn: 'Fractions',
      chapterTitleHi: null,
      startedAt: '2026-08-10T09:00:00.000Z',
      submittedAt: '2026-08-10T09:01:00.000Z',
      scorePercent: 100,
      xpAwarded: 0,
      isValid: false,
      invalidReason: 'too_fast',
    },
  ],
};

function progress(overrides: Record<string, unknown> = {}) {
  return { chapters, totalXp: 420, xpToday: 30, sessionsCompleted: 7, ...overrides };
}

function route(handlers: { progress?: () => Response; history?: () => Response } = {}) {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('/practice/history')
        ? (handlers.history ?? (() => json(history)))()
        : (handlers.progress ?? (() => json(progress())))(),
    ),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the progress screen', () => {
  it('shows the XP figures and the sessions completed', async () => {
    route();
    render(<ProgressScreen />);

    expect(await screen.findByText('420')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  /*
   * §10.4: "mastery bars reflect the data". The bar is a RANK IN A NAMED
   * SEQUENCE and the label is the information — §9.1 forbids the percentage a
   * filled bar is one refactor from becoming.
   */
  it('shows evidence as a word, never as a percentage', async () => {
    route();
    const { container } = render(<ProgressScreen />);

    expect(await screen.findByText('Strong evidence')).toBeInTheDocument();
    expect(screen.getByText('Needs another session')).toBeInTheDocument();
    expect(container.textContent).not.toContain('%');
    // `scorePercent` is on every history entry and is never rendered.
    expect(container.textContent).not.toContain('83');
  });

  it('says when a chapter has never been practised instead of showing a blank date', async () => {
    route();
    render(<ProgressScreen />);

    expect(await screen.findByText(/Not practised yet/)).toBeInTheDocument();
    expect(screen.getByText(/Last practised 12 August/)).toBeInTheDocument();
  });

  it('names the day a review falls due', async () => {
    route();
    render(<ProgressScreen />);

    expect(await screen.findByText('Review due 21 August')).toBeInTheDocument();
  });

  /*
   * §10.4: "empty state before any practice". Emptiness is NO SESSIONS, not no
   * chapters — a student with subjects and no practice has chapters, all of
   * them `not_assessed`, and a grid of grey badges answers "how am I doing"
   * worse than one sentence.
   */
  it('invites a first session when nothing has been practised', async () => {
    route({ progress: () => json(progress({ sessionsCompleted: 0, totalXp: 0, xpToday: 0 })) });
    render(<ProgressScreen />);

    expect(await screen.findByText('No practice yet')).toBeInTheDocument();
    expect(screen.queryByText('Strong evidence')).not.toBeInTheDocument();
  });

  it('reports a failure with a retry', async () => {
    route({ progress: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<ProgressScreen />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Progress could not load');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /*
   * An invalid session is "did not count", never a score of zero. A zero is a
   * judgement about the answers; the truth is the attempt was not counted.
   */
  it('marks an uncounted session as uncounted rather than as zero', async () => {
    route();
    render(<ProgressScreen />);

    expect(await screen.findByText('110 XP')).toBeInTheDocument();
    expect(screen.getByText('Did not count')).toBeInTheDocument();
    expect(screen.queryByText('0 XP')).not.toBeInTheDocument();
  });

  /*
   * History is supporting detail. A failed history must not take the XP figures
   * down with it, and an error banner for it would suggest they are suspect.
   */
  it('keeps the figures when the history fails', async () => {
    route({ history: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<ProgressScreen />);

    expect(await screen.findByText('420')).toBeInTheDocument();
    expect(screen.queryByText('Recent sessions')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads in Hindi, including the chapter title and the date', async () => {
    route();
    render(<ProgressScreen />, { language: 'hi' });

    expect(await screen.findByText('पक्का प्रमाण')).toBeInTheDocument();
    expect(screen.getAllByText('जैव प्रक्रम').length).toBeGreaterThan(0);
    // `chapterTitleHi` is nullable, so an untranslated chapter falls back to
    // NCERT's own English wording rather than rendering an empty heading.
    expect(screen.getAllByText('Fractions').length).toBeGreaterThan(0);
  });
});

describe('recovering from a failure', () => {
  it('refetches when the parent presses retry', async () => {
    let fail = true;
    route({
      progress: () =>
        fail ? json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) : json(progress()),
    });
    render(<ProgressScreen />);

    await screen.findByRole('alert');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('420')).toBeInTheDocument();
  });
});
