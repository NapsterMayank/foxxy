import {
  HINT_LEVELS,
  MAX_HINT_LEVEL,
  type HintLevelName,
} from '@/shared/constants/practice';

/**
 * THE HINT LADDER — the client's five levels, and the data that is not there.
 *
 * ===========================================================================
 * READ THIS BEFORE "FIXING" THE EMPTY RUNGS. D-077, measured not guessed:
 * across all 3,791 source questions, `hint_level_1`, `hint_level_2`,
 * `hint_level_3` and `solution_steps` are NULL, and
 * `distractor_misconceptions` is NULL on all 2,741 that were imported. The 57
 * misconception patterns exist, but nothing links a pattern to a distractor.
 *
 * The ladder therefore DEGRADES rather than pretends. A rung with no authored
 * content reports `available: false` with a reason, and the interface says so.
 *
 * TWO THINGS THIS FILE WILL NOT DO, EVER.
 *
 * 1. INVENT A HINT. A generated-on-the-spot hint is indistinguishable to a
 *    student from an authored one, and a wrong hint is worse than no hint —
 *    it teaches the misconception instead of correcting it. When the pedagogy
 *    generation pass of 05-ROADMAP.md §6 fills these columns, the rungs light
 *    up with no change here.
 *
 * 2. REVEAL THE ANSWER. Every rung is bounded by construction rather than by
 *    review: the partial-step rung serves the FIRST step only and is
 *    unavailable when the solution has just one step (a single step IS the
 *    answer); the worked-example rung serves a separate ANALOGOUS example and
 *    never this question's solution; and no rung ever reads `correct_index`,
 *    `explanation` or `options`. Those fields are not even parameters here,
 *    which is the strongest form the rule can take — it cannot be violated by
 *    a caller passing the wrong thing.
 * ===========================================================================
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** Everything a question carries that a hint may be drawn from. Nothing else. */
export interface QuestionHints {
  readonly hintLevel1: string | null;
  readonly hintLevel2: string | null;
  readonly hintLevel3: string | null;
  /** The full solution, step by step. Only `steps[0]` is ever served. */
  readonly solutionSteps: readonly string[] | null;
  /** A worked ANALOGOUS example. Never this question's own solution. */
  readonly workedExample: string | null;
  /** Where level 5 sends the student. Null when no prerequisite is known. */
  readonly prerequisiteConceptTitle: string | null;
}

export type HintUnavailableReason =
  /** Above the top rung. A request for level 6 of a 5-rung ladder. */
  | 'above_ladder'
  /**
   * The rung exists and nobody has written its content — the common case today
   * (D-077). DISTINCT from `above_ladder` on purpose: one is a caller error and
   * the other is a content gap, and collapsing them would hide the gap behind
   * what looks like a bounds check.
   */
  | 'not_authored'
  /** The partial-step rung on a one-step solution: serving it is the answer. */
  | 'would_reveal_answer';

export type HintOutcome =
  | {
      readonly available: true;
      readonly level: number;
      readonly name: HintLevelName;
      readonly text: string;
    }
  | {
      readonly available: false;
      readonly level: number;
      readonly name: HintLevelName | null;
      readonly reason: HintUnavailableReason;
    };

/**
 * Resolves one rung.
 *
 * `level` is 1-based and matches `practice_responses.hint_level_used`, where 0
 * means "no hint asked for" and is the absence of a rung rather than a rung.
 * A request for 0 or below is `above_ladder` from the other end — there is no
 * level to serve, and inventing one would be the same mistake as inventing
 * content.
 */
export function resolveHint(hints: QuestionHints, level: number): HintOutcome {
  // The bounds check and the lookup are ONE step. Splitting them leaves a second
  // place that believes the level is in range, which then needs an assertion to
  // say so — an assertion whose truth lives several lines away.
  const name = Number.isInteger(level) && level >= 1 ? HINT_LEVELS[level - 1] : undefined;
  if (name === undefined) {
    return { available: false, level, name: null, reason: 'above_ladder' };
  }

  switch (name) {
    case 'directional':
      return textOrGap(level, name, hints.hintLevel1);

    case 'highlight':
      return textOrGap(level, name, hints.hintLevel2);

    case 'partial_step':
      return partialStep(level, name, hints);

    case 'worked_example':
      return textOrGap(level, name, hints.workedExample);

    case 'prerequisite':
      return textOrGap(level, name, hints.prerequisiteConceptTitle);
  }
}

/**
 * The highest rung that has content, or 0 when none does.
 *
 * What the interface needs in order to say "2 hints available" honestly rather
 * than offering five buttons of which three apologise.
 */
export function availableHintLevels(hints: QuestionHints): number[] {
  const levels: number[] = [];
  for (let level = 1; level <= MAX_HINT_LEVEL; level += 1) {
    if (resolveHint(hints, level).available) {
      levels.push(level);
    }
  }
  return levels;
}

function textOrGap(level: number, name: HintLevelName, value: string | null): HintOutcome {
  const text = value?.trim() ?? '';
  if (text.length === 0) {
    return { available: false, level, name, reason: 'not_authored' };
  }
  return { available: true, level, name, text };
}

/**
 * Level 3 — the first step of the solution, and only when there is more than
 * one.
 *
 * A one-step solution IS the answer, so serving it as a "partial step" would
 * hand over the thing the ladder exists to withhold, under a label that says it
 * is not doing that. `would_reveal_answer` names the refusal rather than
 * reporting the rung as unauthored, because the two need opposite fixes: one
 * needs content written, the other needs the solution broken into steps.
 */
function partialStep(level: number, name: HintLevelName, hints: QuestionHints): HintOutcome {
  const authored = hints.hintLevel3?.trim() ?? '';
  if (authored.length > 0) {
    return { available: true, level, name, text: authored };
  }

  const steps = (hints.solutionSteps ?? []).map((step) => step.trim()).filter((s) => s.length > 0);

  // Destructured rather than indexed, so `first` is narrowed by the language
  // instead of asserted by the reader.
  const [first, ...rest] = steps;
  if (first === undefined) {
    return { available: false, level, name, reason: 'not_authored' };
  }
  if (rest.length === 0) {
    return { available: false, level, name, reason: 'would_reveal_answer' };
  }

  return { available: true, level, name, text: first };
}
