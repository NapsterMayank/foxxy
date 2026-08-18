import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterWalkthrough } from '../chapter-walkthrough';

const CHAPTER_ID = '22222222-2222-4222-8222-222222222222';
const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function concept(number: number, overrides: Record<string, unknown> = {}) {
  return {
    /*
     * A REAL UUID, because `chapterConceptSchema.id` is `z.string().uuid()` and
     * `apiRequest` validates every response. A `concept-1` fixture is rejected
     * before it reaches the component, which renders as "nothing works" — the
     * schema doing exactly its job on the test's own bad data.
     */
    id: `0000000${String(number)}-0000-4000-8000-000000000000`,
    conceptNumber: number,
    titleEn: `Concept ${String(number)}`,
    titleHi: `विचार ${String(number)}`,
    learningObjective: null,
    explanationEn: `Explanation ${String(number)}.`,
    explanationHi: null,
    exampleContent: null,
    keyFormula: null,
    commonMistakes: [],
    ...overrides,
  };
}

function body(concepts: unknown[]) {
  return {
    chapter: {
      id: CHAPTER_ID,
      grade: '10',
      subjectCode: 'science',
      chapterNumber: 1,
      titleEn: 'Chemical Reactions',
      titleHi: 'रासायनिक अभिक्रियाएँ',
    },
    concepts,
  };
}

function route(response: () => Response) {
  fetchMock.mockImplementation(() => Promise.resolve(response()));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the chapter walkthrough', () => {
  /*
   * ONE CONCEPT PER SCREEN. A chapter is seven concepts on average; rendering
   * all seven is a page a student scrolls past, and rendering one is a thing
   * they finish.
   */
  it('shows one concept at a time, with its position', async () => {
    route(() => json(body([concept(1), concept(2), concept(3)])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    expect(await screen.findByText('Idea 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Concept 1')).toBeInTheDocument();
    expect(screen.queryByText('Concept 2')).not.toBeInTheDocument();
  });

  it('moves forward and back through the chapter', async () => {
    route(() => json(body([concept(1), concept(2), concept(3)])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    await screen.findByText('Concept 1');
    // No way back from the first concept — a disabled button would be a control
    // that never does anything.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next idea' }));
    expect(await screen.findByText('Concept 2')).toBeInTheDocument();
    expect(screen.getByText('Idea 2 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Concept 1')).toBeInTheDocument();
  });

  /*
   * A CHAPTER ENDS IN A HANDOFF, NOT A DEAD END. Reading is half the loop — the
   * pedagogy is read then practise — so the last card offers practice rather
   * than leaving the student on a screen with nothing to press.
   */
  it('offers practice instead of “next” on the last concept', async () => {
    route(() => json(body([concept(1), concept(2)])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Next idea' }));

    expect(await screen.findByText('Idea 2 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next idea' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Practise this' })).toHaveAttribute(
      'href',
      '/student/practice',
    );
  });

  /*
   * THE REASON THIS SCREEN IS AN ENTRY POINT. Foxy's own start panel defaults to
   * the first subject alphabetically — MATHEMATICS — so a science question asked
   * from a fresh conversation retrieved against the maths corpus and abstained
   * with `chunks=0`. Arriving from a chapter means the subject is never guessed.
   */
  it('sends the subject to Foxy, so nothing is guessed from a dropdown', async () => {
    route(() => json(body([concept(1)])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    expect(await screen.findByRole('link', { name: 'Ask Foxy about this' })).toHaveAttribute(
      'href',
      '/student/foxy?subject=science',
    );
  });

  it('renders the extras only when the corpus has them', async () => {
    route(() =>
      json(
        body([
          concept(1, {
            learningObjective: 'Understand chemical change.',
            keyFormula: '2H₂ + O₂ → 2H₂O',
            exampleContent: 'Iron rusting.',
            commonMistakes: ['forgets to balance'],
          }),
        ]),
      ),
    );
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    expect(await screen.findByText('Understand chemical change.')).toBeInTheDocument();
    expect(screen.getByText('2H₂ + O₂ → 2H₂O')).toBeInTheDocument();
    expect(screen.getByText('Iron rusting.')).toBeInTheDocument();
    expect(screen.getByText('forgets to balance')).toBeInTheDocument();
  });

  it('omits the extras rather than rendering empty headings', async () => {
    route(() => json(body([concept(1)])));
    const { container } = render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    await screen.findByText('Concept 1');
    expect(container.textContent).not.toContain('Formula');
    expect(container.textContent).not.toContain('Watch out for');
  });

  /*
   * Ten of the 137 chapters have no concepts. The endpoint answers 200 with an
   * empty list precisely so this can be said honestly — content missing, not a
   * chapter missing. A 404 would tell a student the chapter does not exist.
   */
  it('says the reading is missing, and still offers practice', async () => {
    route(() => json(body([])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    expect(await screen.findByText('This chapter has no reading yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Practise this chapter' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('links back to the chapter list of the same subject', async () => {
    route(() => json(body([concept(1)])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    expect(await screen.findByRole('link', { name: '← All chapters' })).toHaveAttribute(
      'href',
      '/student/learn?subject=science',
    );
  });

  it('offers a retry when the chapter fails to load', async () => {
    route(() => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('This could not be loaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /*
   * Hindi here is CORPUS CONTENT and genuinely absent on some rows. Falling back
   * to English beats a blank card; hiding the concept would silently shorten a
   * chapter for Hindi readers.
   */
  it('falls back to English when a concept has no Hindi explanation', async () => {
    route(() => json(body([concept(1)])));
    render(<ChapterWalkthrough chapterId={CHAPTER_ID} subject="science" />, { language: 'hi' });

    expect(await screen.findByText('विचार 1')).toBeInTheDocument();
    expect(screen.getByText('Explanation 1.')).toBeInTheDocument();
  });
});
