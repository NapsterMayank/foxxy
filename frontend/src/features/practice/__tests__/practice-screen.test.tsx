import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PracticeScreen } from '../practice-screen';

/**
 * ===========================================================================
 * THE PRACTICE JOURNEY, END TO END WITHOUT A NETWORK — build-order step 10.
 *
 * Mission → questions → result, driven by URL rather than by call order,
 * because several requests are in flight at once and an order-dependent fake
 * would be asserting React's scheduling.
 * ===========================================================================
 */

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const Q1 = '11111111-1111-4111-8111-111111111111';
const Q2 = '33333333-3333-4333-8333-333333333333';

let search = new URLSearchParams();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => '/student/practice',
}));

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
    chapterId: '44444444-4444-4444-8444-444444444444',
    chapterNumber: 6,
    chapterTitleEn: 'Life Processes',
    chapterTitleHi: 'जैव प्रक्रम',
    subjectCode: 'science',
    reason: 'due_review',
    reasonEn: 'You practised this three weeks ago.',
    reasonHi: 'आपने इसे तीन हफ़्ते पहले किया था।',
    evidence: 'developing',
    suggestedQuestionCount: 2,
  },
};

/*
 * ONE FIXTURE QUESTION EACH — a session now arrives with a single question,
 * not the whole set, so `sessionWith` below takes exactly the ones that are
 * "on the wire so far" rather than the full plan.
 */
function question(id: string, questionText: string, options: string[]) {
  return {
    id,
    questionText,
    options,
    difficulty: 'medium',
    bloomLevel: 'understand',
    hintLevelsAvailable: [],
  };
}

const Q1_QUESTION = question(Q1, 'Which part of a plant makes food?', [
  'Root',
  'Leaf',
  'Stem',
  'Flower',
]);
const Q2_QUESTION = question(Q2, 'What gas do leaves take in?', [
  'Oxygen',
  'Carbon dioxide',
  'Nitrogen',
  'Helium',
]);

function sessionWith(questions: ReturnType<typeof question>[], targetQuestionCount = 2) {
  return {
    session: {
      id: SESSION_ID,
      chapterId: mission.mission.chapterId,
      startedAt: '2026-08-15T09:00:00.000Z',
      submittedAt: null,
      answeredCount: 0,
      questions,
      targetQuestionCount,
    },
  };
}

const sessionBody = sessionWith([Q1_QUESTION]);

/**
 * `nextQuestion` is the whole point of Task 7: `null` means the session is
 * over, and anything else is the question the server has decided to serve
 * next — the client shows it only once this same call resolves.
 */
function answerBody(
  questionId: string,
  isCorrect: boolean,
  overrides: {
    nextQuestion?: ReturnType<typeof question> | null;
    answeredCount?: number;
    questionCount?: number;
  } = {},
) {
  return {
    result: {
      questionId,
      isCorrect,
      correctPresentationIndex: 1,
      explanation: 'Leaves hold the chlorophyll.',
      decision: isCorrect ? 'advance' : 'remediate_general',
      misconceptionCode: null,
      answeredCount: overrides.answeredCount ?? 1,
      questionCount: overrides.questionCount ?? 2,
      nextQuestion: overrides.nextQuestion ?? null,
    },
  };
}

const submissionBody = {
  result: {
    sessionId: SESSION_ID,
    scorePercent: 50,
    correctCount: 1,
    questionCount: 2,
    xpAwarded: 30,
    xpEarned: 30,
    dailyCapReached: false,
    isValid: true,
    invalidReason: null,
    evidence: 'developing',
    nextReviewAt: '2026-08-21T04:30:00.000Z',
  },
};

const fetchMock = vi.fn();
/** Every answer body the screen posted, for the timing assertions. */
const answersSent: Record<string, unknown>[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  answersSent.length = 0;
  search = new URLSearchParams();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function route(
  handlers: {
    mission?: () => Response;
    session?: () => Response;
    start?: () => Response;
    answer?: () => Response;
    submit?: () => Response;
  } = {},
) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);

    if (target.includes('/practice/mission')) {
      return Promise.resolve((handlers.mission ?? (() => json(mission)))());
    }
    if (target.includes('/answers')) {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      answersSent.push(sent);
      /*
       * The reply ECHOES the question id it was sent. An earlier version of
       * this fake always answered as question one, so the second question never
       * matched a result and the finish button never appeared — the screen
       * keys answers by question id, and a fake that ignores the id cannot
       * exercise that.
       *
       * The default `nextQuestion` walks Q1 -> Q2 -> null, so the two-question
       * journey (answer, "Next question", answer, "Finish and see my result")
       * works out of the box for tests that do not care what is served next.
       */
      return Promise.resolve(
        (
          handlers.answer ??
          (() =>
            json(
              answerBody(String(sent.questionId), false, {
                nextQuestion: sent.questionId === Q1 ? Q2_QUESTION : null,
                answeredCount: sent.questionId === Q1 ? 1 : 2,
                questionCount: 2,
              }),
            ))
        )(),
      );
    }
    if (target.includes('/submit')) {
      return Promise.resolve((handlers.submit ?? (() => json(submissionBody)))());
    }
    if (target.endsWith('/practice/sessions') && init?.method === 'POST') {
      return Promise.resolve((handlers.start ?? (() => json(sessionBody, 201)))());
    }
    return Promise.resolve((handlers.session ?? (() => json(sessionBody)))());
  });
}

function openSession(): void {
  search = new URLSearchParams(`session=${SESSION_ID}`);
}

describe('choosing what to practise', () => {
  it('shows the mission with the server’s own reason sentence', async () => {
    route();
    render(<PracticeScreen />);

    expect(await screen.findByText('Life Processes')).toBeInTheDocument();
    // Derived from this student's rows. A local template keyed on `reason`
    // would replace a specific true sentence with a generic one.
    expect(screen.getByText('You practised this three weeks ago.')).toBeInTheDocument();
    expect(screen.getByText('2 questions')).toBeInTheDocument();
  });

  it('says plainly when there is nothing to practise, rather than failing', async () => {
    route({ mission: () => json({ mission: null }) });
    render(<PracticeScreen />);

    expect(await screen.findByText('Nothing is waiting for you yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts the session with the chapter and the suggested question count', async () => {
    route();
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start practice' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/practice/sessions') && (init as RequestInit).method === 'POST',
      );
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        chapterId: mission.mission.chapterId,
        questionCount: 2,
      });
    });

    expect(replace).toHaveBeenCalledWith(`/student/practice?session=${SESSION_ID}`);
  });

  it('stays on the mission and says so when the session cannot be started', async () => {
    route({ start: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start practice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The practice session could not be started.',
    );
    expect(screen.getByRole('button', { name: 'Start practice' })).toBeInTheDocument();
  });
});

describe('answering', () => {
  /*
   * §10.4: "the timer records per question". The value is CLIENT-SUPPLIED and
   * the contract is honest that a client can lie — the server clamps the
   * claimed total to its own wall clock — but it still has to be a real
   * measurement of this question rather than a constant.
   */
  it('records how long this question took, not the whole session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-15T09:00:00.000Z'));

    openSession();
    route();
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    vi.setSystemTime(new Date('2026-08-15T09:00:08.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));

    await waitFor(() => {
      expect(answersSent).toHaveLength(1);
    });
    expect(answersSent[0]).toMatchObject({
      questionId: Q1,
      selectedIndex: 1,
      timeSpentMs: 8_000,
      hintLevelUsed: 0,
    });
  });

  it('discloses the answer and explains it once the student commits', async () => {
    openSession();
    route();
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Root' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Not this time.');
    expect(screen.getByText('Leaves hold the chlorophyll.')).toBeInTheDocument();
    // Named in words, never as "option B": the letter is a position in a
    // shuffle unique to this session.
    expect(screen.getByRole('status')).toHaveTextContent('The answer is: Leaf');
  });

  /*
   * §10.4: "cannot submit before all are answered". The last question's button
   * is the only one that finishes the session, and it does not appear until the
   * question before it has been answered.
   */
  it('does not offer to finish until the last question has been answered', async () => {
    openSession();
    route();
    render(<PracticeScreen />);

    expect(await screen.findByText('Question 1 of 2')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Finish and see my result' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));

    // Still not: this is question one of two, so the next step is the next
    // question rather than the result.
    expect(await screen.findByRole('button', { name: 'Next question' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Finish and see my result' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the question on screen when an answer fails, and retries it', async () => {
    openSession();
    route({ answer: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That answer was not recorded.');
    // The selection is still there and still correct. An error state in place
    // of the card would throw away the one thing needed to try again.
    expect(screen.getByRole('radio', { name: 'Leaf' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /*
   * D-281. A second answer is refused with a 409, and the sentence has to say
   * WHICH conflict — "this question already has an answer" and not "this
   * session was already finished".
   */
  it('explains a refused second answer as an answer conflict', async () => {
    openSession();
    route({ answer: () => json({ error: { code: 'CONFLICT', message: 'x' } }, 409) });
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('answers cannot be changed');
  });
});

describe('advancing on the question the server chose', () => {
  /*
   * The session arrives with ONE question. The next one comes back on the
   * answer, so the client never holds a question the student has not reached
   * — no local list to walk, no prefetch ahead of the answer that produces it.
   */
  it('moves on to the question the server chose, without asking for the set up front', async () => {
    openSession();
    route({
      answer: () =>
        json(
          answerBody(Q1, true, { nextQuestion: Q2_QUESTION, answeredCount: 1, questionCount: 6 }),
        ),
    });
    render(<PracticeScreen />);

    expect(await screen.findByText(Q1_QUESTION.questionText)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next question' }));

    expect(await screen.findByText(Q2_QUESTION.questionText)).toBeInTheDocument();
  });

  it('submits when the server says there is no next question', async () => {
    openSession();
    route({
      answer: () =>
        json(answerBody(Q1, true, { nextQuestion: null, answeredCount: 1, questionCount: 1 })),
    });
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish and see my result' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/submit'))).toBe(true);
    });
  });

  /*
   * Controller ruling on the task-7 review: the total shown before the first
   * answer must be the session's OWN `targetQuestionCount`, not a guess
   * inferred from today's mission — a session can outlive the mission that
   * started it. Mission fetch fails outright here, so there is no mission
   * data of any kind to fall back to.
   */
  it('shows the true target before any answer, with no mission data available', async () => {
    openSession();
    route({
      mission: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
      session: () => json(sessionWith([Q1_QUESTION], 6)),
    });
    render(<PracticeScreen />);

    expect(await screen.findByText('Question 1 of 6')).toBeInTheDocument();
  });
});

describe('the result', () => {
  it('submits after the last question and shows score, XP and evidence', async () => {
    openSession();
    route();
    render(<PracticeScreen />);

    // Question one.
    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next question' }));

    // Question two — the last, so the button finishes the session.
    expect(await screen.findByText('Question 2 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Carbon dioxide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish and see my result' }));

    expect(await screen.findByText('Session complete')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 correct')).toBeInTheDocument();
    expect(screen.getByText('30 XP')).toBeInTheDocument();
    expect(screen.getByText('Developing')).toBeInTheDocument();
  });

  it('shows why an attempt did not count', async () => {
    openSession();
    route({
      submit: () =>
        json({
          result: { ...submissionBody.result, isValid: false, invalidReason: 'too_fast', xpAwarded: 0 },
        }),
    });
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next question' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Carbon dioxide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish and see my result' }));

    expect(await screen.findByText('This attempt did not count')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Take your time');
  });

  it('says the session is gone rather than showing an empty screen', async () => {
    openSession();
    route({ session: () => json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404) });
    render(<PracticeScreen />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This practice session is no longer available.',
    );
  });
});

describe('recovering from a failed submit', () => {
  /*
   * The retry beside a failed SUBMIT re-runs the submit, not the answer — the
   * two share one banner and one button, and sending the wrong one would ask
   * the server to record an answer it already has (a 409 the student cannot
   * act on).
   */
  it('re-submits rather than re-answering', async () => {
    let fail = true;
    openSession();
    route({
      submit: () =>
        fail ? json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) : json(submissionBody),
    });
    render(<PracticeScreen />);

    fireEvent.click(await screen.findByRole('radio', { name: 'Leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next question' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Carbon dioxide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish and see my result' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Session complete')).toBeInTheDocument();
  });
});
