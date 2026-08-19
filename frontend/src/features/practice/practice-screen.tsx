'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { Button } from '@/components/ui/button';
import type {
  AnswerResult,
  PracticeQuestion,
  SubmissionResult,
} from '@/lib/api/generated/contracts/practice.contract';
import { useT } from '@/lib/i18n/i18n-provider';
import { AnswerFeedback } from './components/answer-feedback';
import { MissionCard } from './components/mission-card';
import { QuestionCard } from './components/question-card';
import { SessionSummary } from './components/session-summary';
import {
  useMission,
  usePracticeSession,
  useStartPracticeSession,
  useSubmitAnswer,
  useSubmitPracticeSession,
} from './hooks/use-practice-session';
import { practiceErrorMessage } from './lib/practice-messages';
import { elapsedMsBetween } from './lib/question-timer';

/**
 * ===========================================================================
 * THE PRACTICE SCREEN — build-order step 10.
 *
 * Three states in one component because they are one journey: the mission, the
 * questions, the result. Splitting them into three routes would put a
 * navigation between "answer" and "see what you got", and the back button would
 * then land a student inside a session they had already submitted.
 *
 * ---------------------------------------------------------------------------
 * THE SESSION ID IS IN THE URL, as it is for Foxy (D-352) — a practice session
 * is a server-side resource with frozen question order, and a refresh that lost
 * its id would strand it half-answered with no way back to it.
 *
 * ---------------------------------------------------------------------------
 * ANSWERS ARE KEPT BY QUESTION ID, NEVER BY POSITION.
 *
 * The same rule as Foxy's citations, for the same reason: position is only
 * correct while nothing has been re-ordered or skipped, which is the condition
 * under which every ordering bug looks fine.
 * ===========================================================================
 */

export const PRACTICE_SESSION_PARAM = 'session';

export function PracticeScreen() {
  const t = useT();
  const router = useRouter();
  const sessionId = useSearchParams().get(PRACTICE_SESSION_PARAM);

  const mission = useMission();
  const startSession = useStartPracticeSession();
  const session = usePracticeSession(sessionId);
  const answerMutation = useSubmitAnswer();
  const submitMutation = useSubmitPracticeSession();

  /*
   * THE CURRENT QUESTION, NOT AN INDEX INTO A LIST THE CLIENT NEVER HOLDS.
   * A session now arrives with ONE question; each answer's response carries the
   * next one the server chose (or `null` when the session is over). `null` here
   * means "still on the question the session was seeded with".
   */
  const [currentQuestion, setCurrentQuestion] = useState<PracticeQuestion | null>(null);
  /*
   * ANSWERED-SO-FAR, AS OF THE START OF THE CURRENTLY DISPLAYED QUESTION. The
   * session's own `answeredCount` is a one-time snapshot from the GET and
   * never refetched mid-session (see `usePracticeSession`'s
   * `staleTime: Infinity`), so this is what carries the count forward across
   * an `advance()` for a question that has not been answered yet. The
   * session's `targetQuestionCount` needs no such carrying: it is fixed for
   * the whole session, so it is read straight off `session.data` below.
   */
  const [progress, setProgress] = useState<{ readonly answeredCount: number } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [results, setResults] = useState<Readonly<Record<string, AnswerResult>>>({});
  const [summary, setSummary] = useState<SubmissionResult | null>(null);
  /*
   * WHEN THE CURRENT QUESTION WAS PUT ON SCREEN. State and not a ref: it is
   * read inside an event handler, changed by one, and `react-hooks/refs` refuses
   * a ref read during render — the same wall D-351 hit.
   */
  const [questionShownAt, setQuestionShownAt] = useState(() => Date.now());

  if (summary !== null) return <SessionSummary result={summary} />;

  if (sessionId === null) {
    return (
      <MissionStep
        error={
          startSession.error === null
            ? null
            : practiceErrorMessage(startSession.error, t, {
                fallback: 'practice.errorStartFailed',
              })
        }
        isPending={startSession.isPending}
        mission={mission}
        onStart={(chapterId, questionCount) => {
          startSession.mutate(
            { chapterId, questionCount },
            {
              onSuccess: (response) => {
                setQuestionShownAt(Date.now());
                router.replace(
                  `/student/practice?${PRACTICE_SESSION_PARAM}=${encodeURIComponent(response.session.id)}`,
                );
              },
            },
          );
        }}
      />
    );
  }

  if (session.isPending) return <LoadingState label={t('practice.loadingSession')} />;

  if (session.error !== null) {
    return (
      <ErrorState
        description={practiceErrorMessage(session.error, t)}
        onRetry={() => {
          void session.refetch();
        }}
        retryLabel={t('practice.retryAction')}
        title={t('practice.errorTitle')}
      />
    );
  }

  /*
   * ===========================================================================
   * RESUMING: THE OPEN QUESTION IS THE LAST ONE SERVED, NEVER THE FIRST.
   *
   * The session id is in the URL, so a refresh, a back-navigation or an app
   * restart mid-session re-enters here with `currentQuestion` back to `null`.
   * This used to fall back to `questions[0]` — a question that has already been
   * answered on any session past its first — and every route forward from it
   * was a 409: the answer endpoint refuses a second answer (D-281) and there is
   * no Next button until an answer lands.
   *
   * The serving loop is what makes the right question identifiable from what
   * the client already holds: `questions` carries exactly what has been SERVED,
   * and at most ONE served question is ever unanswered. So
   * `answeredCount === questions.length` means everything served is answered —
   * there is nothing to show and the session is ready to submit — and otherwise
   * the open one is the last served.
   * ===========================================================================
   */
  const served = session.data.session.questions;
  const everythingServedIsAnswered =
    served.length > 0 && session.data.session.answeredCount >= served.length;
  const question = currentQuestion ?? (everythingServedIsAnswered ? null : (served.at(-1) ?? null));

  if (question === null) {
    if (everythingServedIsAnswered) {
      // Resumed with every served question answered. Submitting is the only
      // thing left, and it is the student's tap rather than a render-time
      // side effect — a session must not be finished by a page load.
      return (
        <div className="space-y-4">
          <p className="text-sm leading-body text-ink">{t('practice.resumeReadyDescription')}</p>
          <Button
            disabled={submitMutation.isPending}
            onClick={() => {
              submitMutation.mutate(sessionId, {
                onSuccess: (response) => {
                  setSummary(response.result);
                },
              });
            }}
          >
            {t('practice.finishAction')}
          </Button>
          {submitMutation.error === null ? null : (
            <p className="text-sm font-semibold text-danger" role="alert">
              {practiceErrorMessage(submitMutation.error, t, {
                conflict: 'practice.errorSubmitConflict',
                fallback: 'practice.errorGeneric',
              })}
            </p>
          )}
        </div>
      );
    }

    // An empty session is a server-side condition, not a student one. It has no
    // recovery on this screen beyond starting again elsewhere.
    return (
      <EmptyState
        description={t('practice.missionNoneDescription')}
        title={t('practice.missionNoneTitle')}
      />
    );
  }

  /*
   * The same question, bound AFTER the null check above so the handlers below
   * can read it. A closure cannot re-derive a narrowing made by an early
   * return in the branchy block above it.
   */
  const openQuestion: PracticeQuestion = question;

  const result = results[question.id] ?? null;
  const isLast = result !== null && result.nextQuestion === null;

  /*
   * BEFORE THIS QUESTION'S OWN RESULT ARRIVES, the number on screen reads the
   * count carried forward from the question before it (or the session's
   * snapshot, for the very first question). Once answered, `result.
   * answeredCount` — server truth — takes over directly, which is also why
   * the number does not jump when the "Next" button is pressed:
   * `result.answeredCount` already counts the question being displayed.
   *
   * The total does not need any of that: `targetQuestionCount` is fixed for
   * the whole session and the session response carries it from the start —
   * unlike `answeredCount`, there is no "before the first answer" gap to fall
   * back for (Task 7 fix-up: this used to guess from the day's mission, which
   * is a different number the moment a session outlives it).
   */
  const priorAnsweredCount = progress?.answeredCount ?? session.data.session.answeredCount;
  const questionNumber = result?.answeredCount ?? priorAnsweredCount + 1;
  const questionCount = session.data.session.targetQuestionCount;

  function answer(): void {
    if (selectedIndex === null) return;

    answerMutation.mutate(
      {
        sessionId: sessionId ?? '',
        answer: {
          questionId: openQuestion.id,
          selectedIndex,
          timeSpentMs: elapsedMsBetween(questionShownAt, Date.now()),
          hintLevelUsed: 0,
        },
      },
      {
        onSuccess: (answered) => {
          setResults((current) => ({ ...current, [answered.questionId]: answered }));
        },
      },
    );
  }

  function advance(): void {
    if (result === null) return;

    // `nextQuestion === null` means the target length was reached or the
    // chapter has nothing left to serve — the client submits on seeing it.
    if (result.nextQuestion === null) {
      submitMutation.mutate(sessionId ?? '', {
        onSuccess: (response) => {
          setSummary(response.result);
        },
      });
      return;
    }
    setProgress({ answeredCount: result.answeredCount });
    setCurrentQuestion(result.nextQuestion);
    setSelectedIndex(null);
    setQuestionShownAt(Date.now());
  }

  const turnError = answerMutation.error ?? submitMutation.error;

  return (
    <div className="space-y-6">
      <QuestionCard
        isAnswering={answerMutation.isPending}
        onAnswer={answer}
        onSelect={setSelectedIndex}
        question={question}
        questionCount={questionCount}
        questionNumber={questionNumber}
        result={result}
        selectedIndex={selectedIndex}
      />

      {result === null ? null : (
        <AnswerFeedback
          correctOptionText={question.options[result.correctPresentationIndex] ?? ''}
          isLast={isLast}
          onNext={advance}
          result={result}
        />
      )}

      {/*
        A FAILED ANSWER OR SUBMIT SITS BESIDE THE QUESTION AND NEVER REPLACES
        IT. The student's selection is still on screen and still correct; an
        error state in place of the card would throw away the one thing they
        would need to try again.
      */}
      {turnError === null ? null : (
        <div className="rounded-card border border-danger bg-surface p-4" role="alert">
          <p className="text-sm leading-body text-ink">
            {practiceErrorMessage(turnError, t, {
              conflict:
                answerMutation.error === null
                  ? 'practice.errorSubmitConflict'
                  : 'practice.errorAnswerConflict',
              fallback:
                answerMutation.error === null
                  ? 'practice.errorGeneric'
                  : 'practice.errorAnswerFailed',
            })}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              if (answerMutation.error !== null) answer();
              else advance();
            }}
            variant="secondary"
          >
            {t('practice.retryAction')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The mission, and the three states it can be in. Split out to keep the journey readable. */
function MissionStep({
  error,
  isPending,
  mission,
  onStart,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly mission: ReturnType<typeof useMission>;
  readonly onStart: (chapterId: string, questionCount: number) => void;
}) {
  const t = useT();

  if (mission.isPending) return <LoadingState label={t('practice.loadingSession')} />;

  if (mission.error !== null) {
    return (
      <ErrorState
        description={practiceErrorMessage(mission.error, t)}
        onRetry={() => {
          void mission.refetch();
        }}
        retryLabel={t('practice.retryAction')}
        title={t('practice.errorTitle')}
      />
    );
  }

  /*
   * `mission: null` IS AN ANSWER, NOT AN ERROR. The contract says so — "null
   * when the student has no chapters at all, said plainly, not faked" — so it
   * renders as an empty state with a next step rather than as a failure.
   */
  if (mission.data.mission === null) {
    return (
      <EmptyState
        description={t('practice.missionNoneDescription')}
        title={t('practice.missionNoneTitle')}
      />
    );
  }

  const chosen = mission.data.mission;

  return (
    <div className="space-y-4">
      <MissionCard
        isPending={isPending}
        mission={chosen}
        onStart={() => {
          onStart(chosen.chapterId, chosen.suggestedQuestionCount);
        }}
      />
      {error === null ? null : (
        <p className="text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
