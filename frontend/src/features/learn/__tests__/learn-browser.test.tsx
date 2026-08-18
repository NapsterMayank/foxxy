import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearnBrowser } from '../learn-browser';

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
  profile: {
    userId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Riya',
    grade: '10',
    board: 'CBSE',
    preferredLanguage: 'en',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
};

const chapters = {
  chapters: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      grade: '10',
      subjectCode: 'science',
      chapterNumber: 1,
      titleEn: 'Chemical Reactions',
      titleHi: 'रासायनिक अभिक्रियाएँ',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      grade: '10',
      subjectCode: 'science',
      chapterNumber: 2,
      titleEn: 'Acids and Bases',
      titleHi: null,
    },
  ],
};

function route(handlers: { profile?: () => Response; chapters?: () => Response } = {}) {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('/content/chapters')
        ? (handlers.chapters ?? (() => json(chapters)))()
        : (handlers.profile ?? (() => json(profile)))(),
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

describe('the subject browser', () => {
  it('offers the subjects as links, not as a dropdown', async () => {
    route();
    render(<LearnBrowser subject={null} />);

    /*
     * LINKS, because choosing a subject is a NAVIGATION. It changes what the
     * page is about and belongs in history — that is what the old dropdown lost.
     */
    const science = await screen.findByRole('link', { name: 'Science' });
    expect(science).toHaveAttribute('href', '/student/learn?subject=science');
    expect(screen.getByRole('link', { name: 'Mathematics' })).toBeInTheDocument();
  });

  it('asks for a subject before fetching any chapters', async () => {
    route();
    render(<LearnBrowser subject={null} />);

    expect(await screen.findByText('Pick a subject to see its chapters.')).toBeInTheDocument();
    // The chapter query stays disabled without a subject — firing it would send
    // a request the API answers with a 400.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/content/chapters'))).toBe(
        false,
      );
    });
  });

  it('lists the chapters of the chosen subject, numbered', async () => {
    route();
    render(<LearnBrowser subject="science" />);

    const first = await screen.findByRole('link', { name: /Chemical Reactions/ });
    expect(first).toHaveAttribute(
      'href',
      '/student/learn/science/22222222-2222-4222-8222-222222222222',
    );
    // The NUMBER is the anchor a student navigates by — they are told "do
    // chapter 6", not the title, and 63 of the 137 titles are placeholders.
    expect(first).toHaveTextContent('1');
    expect(screen.getByRole('link', { name: /Acids and Bases/ })).toBeInTheDocument();
  });

  /*
   * THE GRADE COMES FROM THE PROFILE AND IS NEVER CHOSEN. A Grade 10 student
   * browsing Grade 6 chapters would be reading the wrong textbook with nothing
   * on screen to say so.
   */
  it('asks for the chapters of the student’s own grade', async () => {
    route();
    render(<LearnBrowser subject="science" />);

    await screen.findByRole('link', { name: /Chemical Reactions/ });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/content/chapters'));
    expect(String(call?.[0])).toContain('grade=10');
    expect(String(call?.[0])).toContain('subject=science');
  });

  it('says so when a subject has no chapters yet', async () => {
    route({ chapters: () => json({ chapters: [] }) });
    render(<LearnBrowser subject="science" />);

    expect(
      await screen.findByText('There are no chapters for your grade in this subject yet.'),
    ).toBeInTheDocument();
  });

  it('offers a retry when the chapters fail to load', async () => {
    route({ chapters: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<LearnBrowser subject="science" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This could not be loaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('reads in Hindi, falling back for an untranslated chapter title', async () => {
    route();
    render(<LearnBrowser subject="science" />, { language: 'hi' });

    expect(await screen.findByRole('link', { name: /रासायनिक अभिक्रियाएँ/ })).toBeInTheDocument();
    // `titleHi` is nullable — NCERT's own English wording beats an empty row.
    expect(screen.getByRole('link', { name: /Acids and Bases/ })).toBeInTheDocument();
  });

  it('marks the chosen subject as the current page', async () => {
    route();
    render(<LearnBrowser subject="science" />);

    const science = await screen.findByRole('link', { name: 'Science' });
    expect(science).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Mathematics' })).not.toHaveAttribute('aria-current');
  });
});

describe('when the profile itself fails', () => {
  /*
   * The grade comes from the profile, so without it there is no chapter list to
   * ask for — the whole screen fails rather than showing an empty subject.
   */
  it('reports the failure and offers a retry', async () => {
    route({ profile: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<LearnBrowser subject="science" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This could not be loaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // No chapter request was made — the query stays disabled without a grade.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/content/chapters'))).toBe(
      false,
    );
  });

  it('recovers when the retry succeeds', async () => {
    let failing = true;
    route({
      profile: () =>
        failing ? json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) : json(profile),
    });
    render(<LearnBrowser subject="science" />);

    await screen.findByRole('alert');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: /Chemical Reactions/ })).toBeInTheDocument();
  });
});
