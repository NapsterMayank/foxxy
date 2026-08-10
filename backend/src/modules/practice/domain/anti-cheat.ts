/**
 * ANTI-CHEAT — the three checks from §8.6, applied to a whole attempt.
 *
 *   1. average time is at least 3 seconds per question, BOUNDED BY REAL TIME
 *   2. not every answer in the same SCREEN POSITION, when there are MORE THAN
 *      3 questions
 *   3. response count equals question count
 *
 * ===========================================================================
 * WHAT THESE ARE AND ARE NOT. They do not detect a determined cheat; a student
 * who wants to game them can wait four seconds and vary a position. They detect
 * the two things that actually happen at scale — a script, and a bored tap
 * through — and they do it cheaply and without accusing anyone. An attempt that
 * fails is SCORED ZERO AND RECORDED WITH ITS REASON, never deleted and never
 * silently discarded: the responses are evidence, and the reason is what makes
 * a support conversation possible.
 *
 * THE ORDER OF THE CHECKS IS LOAD-BEARING. Count first — an average over the
 * wrong number of responses is a number about nothing, and "all the same
 * position" over a partial set says nothing either. Only once the set is known
 * to be complete do the other two mean anything.
 * ===========================================================================
 *
 * ===========================================================================
 * RULE 2 READS THE PRESENTATION INDEX, NOT THE CANONICAL ONE. THIS IS THE
 * WHOLE POINT OF THE RULE AND IT WAS ONCE THE OTHER WAY ROUND.
 *
 * Options are shuffled PER QUESTION (`practice.service.ts` builds one map per
 * question and stores them all on the session), so "the third option every
 * time" — the bored tap-through this rule exists to catch — lands on a
 * DIFFERENT canonical index for each question. Evaluated over canonical
 * indices the rule therefore almost never fires on the behaviour it targets,
 * and instead fires on honest attempts whose authored `correct_index` happens
 * to be uniform.
 *
 * Measured by simulation, 20,000 attempts x 6 four-option questions, a student
 * tapping the SAME SCREEN POSITION every time, production `Math.random`:
 *
 *     over canonical indices         21/20000 =   0.105%  <- what shipped
 *     over presentation indices   20000/20000 = 100.000%  <- what is here now
 *
 * And on honest random play (a uniformly random position each question):
 *
 *     over canonical indices         13/20000 =   0.065%
 *     over presentation indices      16/20000 =   0.080%
 *
 * i.e. the rule went from catching essentially nothing it aims at to catching
 * all of it, at an unchanged false-positive cost — 4/4^6 ≈ 0.098% is the floor
 * four options and six questions make unavoidable, and is exactly why the rule
 * is switched off at 3 questions, where it would be 4/4^3 ≈ 6%.
 *
 * The canonical reading also had the INVERSE failure, which is the half that
 * reached real students: a full-marks attempt on a chapter whose authored
 * `correct_index` happens to be uniform stores one canonical index every time,
 * and was rejected and scored zero for it.
 *
 * NOTHING ABOUT D-058 CHANGES. The canonical index is still the only index
 * PERSISTED; `selectedIndex` below is that value and is carried here unchanged
 * so a caller reading a stored response still has it. The presentation index is
 * a VALIDATION input only, derived from the session's own shuffle map, and is
 * never written anywhere.
 * ===========================================================================
 *
 * ===========================================================================
 * RULE 1 IS BOUNDED BY REAL ELAPSED TIME.
 *
 * `timeSpentMs` is client-supplied and a client can lie. Six questions each
 * claiming 12 seconds used to pass inside a two-second session, which made
 * rule 1 a check on a number the cheat controls.
 *
 * `realElapsedMs` — `now - session.started_at`, both from the injected clock —
 * is the server's authoritative ceiling. The claimed total is CLAMPED to it
 * rather than compared against it: a client number SMALLER than reality is
 * ordinary and honest (a paused tab, a student who walked away), and only a
 * claim LARGER than the wall clock is impossible. This is the backstop
 * `shared/contracts/practice.contract.ts` describes.
 * ===========================================================================
 *
 * Pure: no I/O, no clock (elapsed time arrives as a number), no randomness.
 */

/**
 * The minimum average, in milliseconds, across the whole attempt.
 *
 * PINNED TO THE LITERAL 3_000 in `__tests__/anti-cheat.test.ts`. It used to be
 * pinned only incidentally in `app/__tests__/routes.test.ts` — a test about
 * module wiring — and could be moved to 300 with every practice test still
 * green.
 */
export const MIN_AVERAGE_MS_PER_QUESTION = 3_000;

/**
 * The same-POSITION rule applies only ABOVE this many questions.
 *
 * "not every answer the same, when there are more than 3 questions" — so
 * exactly 3 identical answers is allowed and 4 is not. With three four-option
 * questions, all-the-same happens by chance on 4/4^3 ≈ 6% of honest attempts,
 * and a rule that fails one honest student in sixteen is a rule that gets
 * switched off. At six questions the same figure is 4/4^6 ≈ 0.098%.
 *
 * PINNED TO THE LITERAL 3 in `__tests__/anti-cheat.test.ts`. It was previously
 * free to move to 10 with the whole suite green, because every test that
 * referenced it was written in terms of it.
 */
export const SAME_ANSWER_MIN_QUESTIONS = 3;

export const ANTI_CHEAT_REASONS = [
  'response_count_mismatch',
  'too_fast',
  'all_same_answer',
] as const;
export type AntiCheatReason = (typeof ANTI_CHEAT_REASONS)[number];

/** The only three fields the checks read. Everything else about a response is irrelevant here. */
export interface AttemptResponse {
  /**
   * The CANONICAL option index (D-058) — the one that is persisted.
   *
   * RULE 2 DOES NOT READ THIS. It is here because a stored response has it and
   * because losing it from this shape would invite somebody to persist the
   * presentation index instead, which is the D-058 catastrophe.
   */
  readonly selectedIndex: number;
  /**
   * The SCREEN POSITION the student tapped — what rule 2 is actually about.
   *
   * OPTIONAL ONLY BECAUSE ONE CALLER CANNOT SUPPLY IT. `modules/signals`
   * re-validates rows read back from `practice_responses`, which stores the
   * canonical index and nothing else; the shuffle map that would translate it
   * lives on the session row and signals does not read it. Every caller that
   * HAS a session — which is every caller that can reject a submission — must
   * supply this.
   *
   * When it is absent for any response the rule is SKIPPED, not silently
   * re-run over canonical indices. Running it over canonical indices is the
   * defect this field exists to fix: measured at 0.07% detection of the
   * behaviour it targets while rejecting honest full-marks attempts. A check
   * that wrong is worse than no check, because its verdict gets believed.
   */
  readonly presentationIndex?: number;
  readonly timeSpentMs: number;
}

export type AttemptValidity =
  | { readonly isValid: true }
  | { readonly isValid: false; readonly reason: AntiCheatReason };

/**
 * Runs all three checks and reports the FIRST failure.
 *
 * One reason rather than a list, because the reason is written to
 * `practice_sessions.invalid_reason` and read by a human deciding what to say
 * to a student. "Too fast, and every answer was B" is not more actionable than
 * "too fast"; it is just longer.
 */
export function validateAttempt(
  responses: readonly AttemptResponse[],
  questionCount: number,
  /**
   * Real wall-clock milliseconds between `session.started_at` and now, from the
   * server's own clock — the ceiling on what the client may claim.
   *
   * OPTIONAL FOR THE SAME ONE CALLER as `presentationIndex`: `signals` holds
   * `SessionFact`s that carry no `startedAt`, so it has no authoritative window
   * to impose and must not invent one. Omitting it means "I have no server
   * clock reading for this attempt", NOT "there is no limit" — every caller
   * that holds a session row has one and must pass it.
   */
  realElapsedMs?: number,
): AttemptValidity {
  if (realElapsedMs !== undefined && (!Number.isFinite(realElapsedMs) || realElapsedMs < 0)) {
    throw new RangeError(
      `validateAttempt: realElapsedMs must be a non-negative finite number, received ${String(
        realElapsedMs,
      )}.`,
    );
  }

  if (!Number.isInteger(questionCount) || questionCount < 0) {
    throw new RangeError(
      `validateAttempt: questionCount must be a non-negative integer, received ${String(
        questionCount,
      )}.`,
    );
  }

  // --- 3. response count equals question count ------------------------------
  // First, because the other two are meaningless over the wrong set.
  if (responses.length !== questionCount) {
    return { isValid: false, reason: 'response_count_mismatch' };
  }

  // An empty attempt is vacuously consistent. It scores zero on its own merits
  // (`calculateScore(0, 0)`), which is the honest outcome — calling it a cheat
  // would put an accusation on a session where nothing happened.
  if (responses.length === 0) {
    return { isValid: true };
  }

  // --- 1. average time at least 3 seconds per question ----------------------
  // AVERAGE, not per-question. A student who reads the whole set first and then
  // answers the last four quickly is not cheating, and a per-question floor
  // would refuse them.
  //
  // CLAMPED to the server's own elapsed window when the caller has one. The
  // client may claim LESS than the wall clock — a paused tab is honest — and
  // never more.
  const claimedMs = responses.reduce((sum, response) => sum + response.timeSpentMs, 0);
  const effectiveMs = realElapsedMs === undefined ? claimedMs : Math.min(claimedMs, realElapsedMs);
  if (effectiveMs / responses.length < MIN_AVERAGE_MS_PER_QUESTION) {
    return { isValid: false, reason: 'too_fast' };
  }

  // --- 2. not every answer in the same SCREEN POSITION, above 3 questions ---
  // Over presentation indices, because the shuffle map differs per question and
  // the same screen position is a different canonical index each time. See the
  // file header for the measured firing rates either way.
  if (responses.length > SAME_ANSWER_MIN_QUESTIONS) {
    const positions = responses.map((response) => response.presentationIndex);
    const first = positions[0];
    // Skipped rather than fallen back when any response lost its position. A
    // fallback here reinstates the defect, silently, for whichever caller
    // forgot the field.
    if (first !== undefined && positions.every((position) => position === first)) {
      return { isValid: false, reason: 'all_same_answer' };
    }
  }

  return { isValid: true };
}
