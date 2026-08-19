import { z } from 'zod';
import { OPTIONS_PER_QUESTION } from '../constants/curriculum';
import {
  EVIDENCE_LABELS,
  MAX_HINT_LEVEL,
  MISSION_REASONS,
  NEXT_DECISIONS,
  RESPONSE_CONFIDENCES,
  type EvidenceLabel,
} from '../constants/practice';

/**
 * The practice wire contract — every request and response shape for §8.6,
 * defined once. The frontend imports the INFERRED TYPES from here
 * (00-ARCHITECTURE.md §1).
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY ABSENT, AND IS THE MOST IMPORTANT PROPERTY OF THIS FILE.
 *
 * NO `correctIndex`. NO `explanation`. NO `distractorMisconceptions`. Not on
 * the session, not on a question, not anywhere a client can reach before it has
 * submitted an answer.
 *
 * This folder is imported by the frontend. A field that exists here exists in
 * the browser, and a `correctIndex` in the browser is a quiz with no questions
 * in it — no amount of care in the component prevents somebody reading the
 * network tab. The server-side question shape, which does carry those fields,
 * lives in `modules/content/content.types.ts` and cannot be imported from the
 * client (see the note at the top of `content.contract.ts`, which makes the
 * same argument and is the reason there is no question shape there either).
 *
 * The answer is disclosed by `POST /sessions/:id/answers`, per answer, AFTER
 * the student has committed to one.
 * ===========================================================================
 *
 * ===========================================================================
 * EVERY INDEX ON THIS WIRE IS A PRESENTATION INDEX. Every index in the database
 * is the canonical one (D-058). The translation happens in the service, in one
 * place, and the two vocabularies never meet: a client knows only "the third
 * option I was shown", and the server knows only "options[1]".
 *
 * That is why `options` below is described as shuffled and why nothing on this
 * wire is ever compared to a stored index without going through the session's
 * shuffle map.
 * ===========================================================================
 */

/** A UUID path parameter. */
export const sessionIdParamSchema = z.object({ id: z.string().uuid() });
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

/** How many questions a practice session draws when the caller does not say. */
export const DEFAULT_SESSION_QUESTION_COUNT = 6;
export const MIN_SESSION_QUESTION_COUNT = 1;
export const MAX_SESSION_QUESTION_COUNT = 20;

export const startSessionRequestSchema = z.object({
  chapterId: z.string().uuid(),
  questionCount: z
    .number()
    .int()
    .min(MIN_SESSION_QUESTION_COUNT)
    .max(MAX_SESSION_QUESTION_COUNT)
    .default(DEFAULT_SESSION_QUESTION_COUNT),
});
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;

/**
 * One answer.
 *
 * `selectedIndex` is a PRESENTATION position — where the option appeared on the
 * student's screen. The service translates it through the session's shuffle map
 * before anything is stored.
 *
 * ===========================================================================
 * NEITHER `answerChanged` NOR `firstSelectedIndex` IS ON THIS REQUEST — D-282.
 *
 * `answerChanged` never was: it is derivable from the two indices, a CHECK
 * constraint enforces that they agree, and a client that could send it
 * independently is a client that can make them disagree.
 *
 * `firstSelectedIndex` WAS, and it was the same mistake one field over. It is
 * the client's testimony about its own past, unverifiable, and an audit of an
 * honest end-to-end journey found it absent on five of six responses — so the
 * one column that records a change of mind, and that cannot be reconstructed
 * later, was usually empty. The server holds every answer the session recorded;
 * it derives both fields from that (`domain/answer-change.ts`) and no longer
 * asks.
 *
 * An old client that still sends the field is unaffected: zod strips unknown
 * keys, so the value is ignored rather than rejected.
 * ===========================================================================
 */
export const submitAnswerRequestSchema = z.object({
  questionId: z.string().uuid(),
  selectedIndex: z.number().int().min(0).max(OPTIONS_PER_QUESTION - 1),
  /**
   * Milliseconds on this question. CLIENT-SUPPLIED, and the anti-cheat rules
   * read it, which is worth being honest about: a client can lie. It is still
   * worth collecting — it catches the script and the bored tap-through, which
   * is what the rules are for.
   *
   * THE SERVER-SIDE BACKSTOP IS REAL AND NAMED. `submitSession` computes
   * `now - practice_sessions.started_at` from the injected clock and passes it
   * to `validateAttempt` as `realElapsedMs`, which CLAMPS the claimed total to
   * it before averaging. A claim smaller than the wall clock stands (a paused
   * tab is honest); a claim larger than it cannot buy a pass. This sentence was
   * once a description of a guard that did not exist — six questions claiming
   * twelve seconds each passed inside a two-second session — so if you change
   * the service, change this too or delete it.
   */
  timeSpentMs: z.number().int().min(0).max(60 * 60 * 1000),
  hintLevelUsed: z.number().int().min(0).max(MAX_HINT_LEVEL).default(0),
  confidence: z.enum(RESPONSE_CONFIDENCES).nullish(),
  explanationFormatUsed: z.string().trim().min(1).max(40).nullish(),
});
export type SubmitAnswerRequest = z.infer<typeof submitAnswerRequestSchema>;

/** A hint request. `level` is 1-based; 0 means "no hint" and is not requestable. */
export const hintQuerySchema = z.object({
  questionId: z.string().uuid(),
  level: z.coerce.number().int().min(1).max(MAX_HINT_LEVEL),
});
export type HintQuery = z.infer<typeof hintQuerySchema>;

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/**
 * A question, AS A CLIENT SEES IT.
 *
 * `options` are already shuffled. There is no field here from which the answer
 * can be derived, and there must never be one — see the file header.
 */
export const practiceQuestionSchema = z.object({
  id: z.string().uuid(),
  questionText: z.string(),
  /** SHUFFLED for this session. Position n is presentation index n. */
  options: z.array(z.string()),
  difficulty: z.string(),
  bloomLevel: z.string(),
  /**
   * Which rungs of the hint ladder have authored content for this question.
   *
   * Usually EMPTY today (D-077), and sent anyway so the interface can offer
   * exactly the hints that exist instead of five buttons of which four
   * apologise.
   */
  hintLevelsAvailable: z.array(z.number().int()),
});
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;

export const practiceSessionSchema = z.object({
  id: z.string().uuid(),
  chapterId: z.string().uuid(),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  questions: z.array(practiceQuestionSchema),
  /** How many of them have an answer recorded so far. */
  answeredCount: z.number().int(),
});
export type PracticeSession = z.infer<typeof practiceSessionSchema>;

export const practiceSessionResponseSchema = z.object({ session: practiceSessionSchema });
export type PracticeSessionResponse = z.infer<typeof practiceSessionResponseSchema>;

/**
 * What comes back from one answer. The answer is disclosed here and not before.
 *
 * ===========================================================================
 * DISCLOSURE CLOSES THE RECORD — D-281.
 *
 * `isCorrect`, `correctPresentationIndex` and `explanation` below are the answer
 * key for one question, handed to the client the moment it commits. That is
 * deliberate — immediate feedback is the pedagogy of the guided-practice step —
 * and it is only defensible because THE ANSWER IT REVEALS CAN NO LONGER BE
 * CHANGED. A second answer to the same question is refused with 409.
 *
 * The two used to coexist: the key was disclosed here and a re-answer replaced
 * the previous one wholesale. Six questions answered wrong, six responses read
 * for the revealed position, six re-answers submitted with it — 100%, six
 * correct, full XP, and six database rows that look like a flawless first
 * attempt. Mastery, the parent digest and the retention schedule all read those
 * rows.
 * ===========================================================================
 */
export const answerResultSchema = z.object({
  questionId: z.string().uuid(),
  isCorrect: z.boolean(),
  /** The PRESENTATION position of the correct option, for the feedback overlay. */
  correctPresentationIndex: z.number().int(),
  explanation: z.string(),
  decision: z.enum(NEXT_DECISIONS),
  misconceptionCode: z.string().nullable(),
  answeredCount: z.number().int(),
  /** The session's TARGET length (Task 5) — not how many have been served so far. */
  questionCount: z.number().int(),
  /**
   * The question to show next, chosen from this answer by the ladder.
   *
   * NULL means the session is over — the target length was reached, or the
   * chapter has nothing left to serve. The client submits when it sees null.
   *
   * Disclosing the previous answer's key here is safe for the same reason it
   * always was (D-281): the key that is revealed can no longer be changed, and
   * the question arriving alongside it has revealed nothing.
   */
  nextQuestion: practiceQuestionSchema.nullable(),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;

/** A hint, or an honest statement that there is not one. */
export const hintResponseSchema = z.object({
  level: z.number().int(),
  available: z.boolean(),
  /** Present only when `available`. Never generated, never the answer. */
  text: z.string().nullable(),
  /** Present only when not available: why. */
  reason: z.string().nullable(),
});
export type HintResponse = z.infer<typeof hintResponseSchema>;

export const submissionResultSchema = z.object({
  sessionId: z.string().uuid(),
  scorePercent: z.number().int(),
  correctCount: z.number().int(),
  questionCount: z.number().int(),
  /**
   * What was actually added to the ledger, after the daily cap.
   *
   * THE SAME NAME MEANS THE SAME NUMBER ON `HistoryEntry` — D-283. It did not:
   * this shape's `xpEarned` was the UNCAPPED figure and history's `xpEarned` was
   * the awarded one, so a capped session reported 110 here and 0 there under one
   * name in one file. History's field is now `xpAwarded` and matches this.
   */
  xpAwarded: z.number().int(),
  /**
   * What the session was worth BEFORE the cap. Equal to `xpAwarded` usually.
   *
   * Kept separate so the interface can say "you earned 110, 20 of it withheld
   * because today's cap is full" rather than silently showing a smaller number
   * than the arithmetic on screen produces.
   */
  xpEarned: z.number().int(),
  dailyCapReached: z.boolean(),
  isValid: z.boolean(),
  /** Which anti-cheat rule failed. Null on a valid attempt. */
  invalidReason: z.string().nullable(),
  /** A word, never a percentage. */
  evidence: z.enum(EVIDENCE_LABELS),
  /** When this chapter comes back round. ISO 8601. */
  nextReviewAt: z.string(),
});
export type SubmissionResult = z.infer<typeof submissionResultSchema>;

export const submissionResponseSchema = z.object({ result: submissionResultSchema });
export type SubmissionResponse = z.infer<typeof submissionResponseSchema>;

export const historyEntrySchema = z.object({
  sessionId: z.string().uuid(),
  chapterId: z.string().uuid(),
  chapterTitleEn: z.string(),
  chapterTitleHi: z.string().nullable(),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  scorePercent: z.number().int().nullable(),
  /**
   * What the ledger was actually credited for this session — D-283.
   *
   * NAMED `xpAwarded`, not `xpEarned`, and the rename is the whole point. This
   * reads `practice_sessions.xp_earned`, which stores the POST-CAP amount, while
   * `SubmissionResult.xpEarned` is the PRE-CAP one. Two different numbers under
   * one name in one contract file: a capped session returned 110 from submit and
   * 0 from history, and a client rendering its own history showed 0 for a
   * session the student had just been congratulated on. The column keeps its
   * name; the wire no longer lies about which number it carries.
   *
   * Null until the session is submitted.
   */
  xpAwarded: z.number().int().nullable(),
  isValid: z.boolean().nullable(),
  invalidReason: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyResponseSchema = z.object({ sessions: z.array(historyEntrySchema) });
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/**
 * Progress per chapter — the shape the progress screen and, later, the parent
 * snapshot read.
 *
 * `evidence` IS A WORD. There is no `masteryPercent` here and there must not be
 * one: plan §8.7 is explicit that a summary "names a misconception and one
 * concrete action — never a percentage", and a number on this response is a
 * number that ends up on a screen.
 */
export const chapterProgressSchema = z.object({
  chapterId: z.string().uuid(),
  chapterTitleEn: z.string(),
  chapterTitleHi: z.string().nullable(),
  evidence: z.enum(EVIDENCE_LABELS),
  attempts: z.number().int(),
  lastPractisedAt: z.string().nullable(),
  nextReviewAt: z.string().nullable(),
});
export type ChapterProgress = z.infer<typeof chapterProgressSchema>;

export const progressResponseSchema = z.object({
  chapters: z.array(chapterProgressSchema),
  /** The SUM of the XP ledger. Never a counter column. */
  totalXp: z.number().int(),
  /** How much of today's cap has been used. */
  xpToday: z.number().int(),
  sessionsCompleted: z.number().int(),
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

/**
 * Today's Mission.
 *
 * BOTH LANGUAGES ARE REQUIRED at the type level (P7). `notify` learned the cost
 * of the alternative: an optional Hindi field is a Hindi field that is empty in
 * production, on the one screen the client cares most about.
 */
export const missionSchema = z.object({
  chapterId: z.string().uuid(),
  chapterNumber: z.number().int(),
  chapterTitleEn: z.string(),
  chapterTitleHi: z.string().nullable(),
  subjectCode: z.string(),
  reason: z.enum(MISSION_REASONS),
  /** Derived from this student's own rows. Never a generic message. */
  reasonEn: z.string().min(1),
  reasonHi: z.string().min(1),
  evidence: z.enum(EVIDENCE_LABELS),
  suggestedQuestionCount: z.number().int(),
});
export type Mission = z.infer<typeof missionSchema>;

export const missionResponseSchema = z.object({
  /** Null when the student has no chapters at all — said plainly, not faked. */
  mission: missionSchema.nullable(),
});
export type MissionResponse = z.infer<typeof missionResponseSchema>;

/** Re-exported so a client has one import for the label union. */
export type { EvidenceLabel };
