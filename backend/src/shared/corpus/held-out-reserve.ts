/**
 * THE HELD-OUT RESERVE — PER CHAPTER, NEVER GLOBAL (D-079).
 *
 * ===========================================================================
 * THIS DECISION CANNOT BE REVISITED, WHICH IS WHY IT IS A MODULE AND NOT A
 * `.slice()` INSIDE THE IMPORTER.
 *
 * A held-out question is one reserved for independent mastery checks and never
 * served in practice. The moment it is served it may have been memorised, and
 * it can never measure anything again — for that student, permanently. There is
 * no cleanup and no recovery: you cannot un-serve a question. So the reserve
 * has to be chosen before the bank is first served, and it has to be chosen
 * once.
 *
 * ===========================================================================
 * WHY PER CHAPTER AND NOT 30% OF THE BANK.
 *
 * The median pilot chapter has ~30.5 valid questions, which sounds comfortable.
 * The median is not the problem. ~41 of ~134 chapters have FEWER THAN 15, and a
 * global 30% draw would take its share from wherever the questions happen to be
 * — leaving some chapters with a full reserve and no practice, and others with
 * practice and no reserve, entirely by accident of the draw.
 *
 * A chapter is the unit a student practises and the unit mastery is measured
 * over. A reserve that is not per chapter is not a reserve, it is a lottery.
 *
 * ===========================================================================
 * THE THRESHOLD, AND WHY BELOW IT THE ANSWER IS "NONE" RATHER THAN "FEWER".
 *
 * Below `MIN_QUESTIONS_FOR_RESERVE` a chapter gets NO reserve at all and is
 * flagged not-demo-ready. The alternative — reserve one or two anyway — is
 * strictly worse in both directions at once: it takes questions away from a
 * chapter that already has too few to practise, AND a two-question mastery
 * check measures nothing, so the cost is paid and the benefit is not received.
 *
 * 15 is the floor because a 30% reserve of 15 is 4 held out and 11 to practise,
 * and 4 is the smallest check anybody would read a result from. It is a
 * judgement, it is written down, and it is one constant.
 *
 * ===========================================================================
 * THE RESERVE ONLY EVER GROWS. IT IS MONOTONIC, AND THAT COST A REWRITE.
 *
 * D-047 established "the last slice of a stable order" for the dev seed, and
 * the first draft of this module reused it: sort the ids, take the last 30%.
 * That is stable when the source does not change, and a test written for the
 * case where it DOES change failed immediately.
 *
 * The scenario is not exotic — it is the plan. D-079 decided that thin pilot
 * chapters get MORE QUESTIONS GENERATED rather than a smaller reserve, so
 * re-importing a grown chapter is the expected path, not an edge case. With a
 * last-slice rule, a chapter going from 20 questions to 30 recomputes its
 * reserve as the last 9 of the new sorted order — and the 6 that were reserved
 * before are no longer reserved. The next practice session serves them. They
 * are contaminated, permanently, and nothing anywhere reports it.
 *
 * So the reserve takes the CURRENT reserve as an input and is only ever added
 * to. A question that has ever been held out stays held out — including when
 * its chapter has since fallen below the threshold, because "we no longer need
 * this reserve" is not a reason to serve a question, and un-reserving is the one
 * operation that can never be undone.
 *
 * Passing the current reserve in, rather than reading it from a database in
 * here, keeps this a pure function — the same inputs give the same plan, which
 * is what makes the import re-runnable and what makes this testable at all.
 */

/** Below this many valid questions, a chapter gets no reserve at all. */
export const MIN_QUESTIONS_FOR_RESERVE = 15;

/** The share of each eligible chapter's questions reserved for mastery checks. */
export const HELD_OUT_SHARE = 0.3;

/** The bar a chapter must clear to be worth demonstrating (all three, not any). */
export const DEMO_MIN_QUESTIONS = 20;
export const DEMO_MIN_CHUNKS = 20;
export const DEMO_MIN_CONCEPTS = 3;

export interface ChapterReserve {
  /** Stable chapter key, as produced by `chapterKeyOf`. */
  readonly chapterKey: string;
  readonly totalQuestions: number;
  /** Source ids reserved for mastery checks. Never served in practice. */
  readonly heldOut: readonly string[];
  /**
   * True when the chapter has too few questions to support a NEW reserve.
   * No question is newly held out for these; anything already held out stays.
   */
  readonly belowThreshold: boolean;
  /** Ids newly added to the reserve by this run. Empty on an unchanged re-run. */
  readonly newlyHeldOut: readonly string[];
}

/**
 * Chooses the reserve for one chapter, given whatever is already reserved.
 *
 * `alreadyHeldOut` is the reserve as it stands — on a first import it is empty,
 * on a re-run it is what the database holds. It is INTERSECTED with the current
 * question ids rather than trusted wholesale, so an id that has left the source
 * does not linger in the plan; and it is never subtracted from, which is the
 * monotonicity the header is about.
 *
 * `Math.ceil` rather than `Math.round`: at 15 questions, 30% is 4.5, and
 * rounding down to 4 would give the smallest permitted chapter the weakest
 * check. Ceiling errs toward measurement, which is the side to err on — a
 * chapter may be thin on practice and may not be thin on evidence.
 *
 * The top-up is taken from the END of the sorted remainder, which keeps a first
 * import identical to the old last-slice behaviour and therefore keeps the dev
 * seed's worked example (D-047) meaningful.
 */
export function chooseReserve(
  chapterKey: string,
  questionIds: readonly string[],
  alreadyHeldOut: ReadonlySet<string> = new Set(),
): ChapterReserve {
  const ids = [...questionIds].sort();
  const totalQuestions = ids.length;
  const kept = ids.filter((id) => alreadyHeldOut.has(id));

  if (totalQuestions < MIN_QUESTIONS_FOR_RESERVE) {
    // Below the threshold nothing NEW is reserved — but nothing is released
    // either. A question that has been reserved has been kept back from
    // practice; serving it now because its chapter shrank is the contamination
    // this module exists to prevent, arriving by the back door.
    return {
      chapterKey,
      totalQuestions,
      heldOut: kept,
      belowThreshold: true,
      newlyHeldOut: [],
    };
  }

  const target = Math.ceil(totalQuestions * HELD_OUT_SHARE);
  const shortfall = target - kept.length;

  const candidates = ids.filter((id) => !alreadyHeldOut.has(id));
  const newlyHeldOut = shortfall > 0 ? candidates.slice(Math.max(0, candidates.length - shortfall)) : [];

  return {
    chapterKey,
    totalQuestions,
    heldOut: [...kept, ...newlyHeldOut].sort(),
    belowThreshold: false,
    newlyHeldOut,
  };
}

/** Chooses the reserve for every chapter, keyed by chapter. */
export function planReserves(
  questionIdsByChapter: ReadonlyMap<string, readonly string[]>,
  alreadyHeldOut: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, ChapterReserve> {
  const plan = new Map<string, ChapterReserve>();

  for (const [chapterKey, ids] of questionIdsByChapter) {
    plan.set(chapterKey, chooseReserve(chapterKey, ids, alreadyHeldOut));
  }

  return plan;
}

/** Every reserved id across every chapter, for a single `is_held_out` update. */
export function allHeldOutIds(plan: ReadonlyMap<string, ChapterReserve>): readonly string[] {
  return [...plan.values()].flatMap((reserve) => [...reserve.heldOut]);
}

export interface ChapterReadiness {
  readonly chapterKey: string;
  readonly questions: number;
  readonly chunks: number;
  readonly concepts: number;
  /** Has chunks AND concepts AND enough questions to support a reserve. */
  readonly reserveReady: boolean;
  /** Clears the demo bar: enough questions, enough chunks, enough concepts. */
  readonly demoReady: boolean;
}

/**
 * Scores every chapter against the two bars the import has to report on.
 *
 * TWO bars and not one, because they answer different questions. `reserveReady`
 * is "can this chapter carry the one-way door?" — it is about the reserve and it
 * gates a decision that cannot be undone. `demoReady` is "is this chapter worth
 * putting in front of somebody?" — it is about the product and it can be fixed
 * later by generating more content.
 *
 * Both are computed from counts the caller supplies rather than from the
 * database, so this stays a pure function and the numbers in the report come
 * from the same code path the reserve was chosen by.
 */
export function scoreReadiness(
  counts: ReadonlyMap<
    string,
    { readonly questions: number; readonly chunks: number; readonly concepts: number }
  >,
): readonly ChapterReadiness[] {
  return [...counts.entries()]
    .map(([chapterKey, count]) => ({
      chapterKey,
      questions: count.questions,
      chunks: count.chunks,
      concepts: count.concepts,
      reserveReady:
        count.chunks > 0 && count.concepts > 0 && count.questions >= MIN_QUESTIONS_FOR_RESERVE,
      demoReady:
        count.questions >= DEMO_MIN_QUESTIONS &&
        count.chunks >= DEMO_MIN_CHUNKS &&
        count.concepts >= DEMO_MIN_CONCEPTS,
    }))
    .sort((a, b) => a.chapterKey.localeCompare(b.chapterKey));
}
