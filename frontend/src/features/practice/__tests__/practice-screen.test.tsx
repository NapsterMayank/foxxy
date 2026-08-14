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

const sessionBody = {
  session: {
    id: SESSION_ID,
    chapterId: mission.mission.chapterId,
    startedAt: '2026-08-15T09:00:00.000Z',
    submittedAt: null,
    answeredCount: 0,
    questions: [
      {
        id: Q1,
        questionText: 'Which part of a plant makes food?',
        options: ['Root', 'Leaf', 'Stem', 'Flower'],
        difficulty: 'medium',
        bloomLevel: 'understand',
        hintLevelsAvailable: [],
      },
      {
        id: Q2,
        questionText: 'What gas do leaves take in?',
        options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Helium'],
        difficulty: 'medium',
        bloomLevel: 'remember',
        hintLevelsAvailable: [],
      },
    ],
  },
};

function answerBody(questionId: string, isCorrect: boolean) {
  return {
    result: {
      questionId,
      isCorrect,
      correctPresentationIndex: 1,
      explanation: 'Leaves hold the chlorophyll.',
      decision: isCorrect ? 'advance' : 'remediate_general',
      misconceptionCode: null,
      answeredCount: 1,
      questionCount: 2,
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
       */
      return Promise.resolve(
        (handlers.answer ?? (() => json(answerBody(String(sent.questionId), false))))(),
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
