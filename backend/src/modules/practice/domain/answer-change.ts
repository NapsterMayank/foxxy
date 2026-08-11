/**
 * WHICH OPTION THE STUDENT PICKED FIRST, DERIVED FROM WHAT THE SERVER ITSELF
 * RECORDED — D-282.
 *
 * ===========================================================================
 * THIS FILE EXISTS BECAUSE THE TWO COLUMNS IT FEEDS USED TO BE CLIENT TESTIMONY.
 *
 * `practice_responses.first_selected_index` and `.answer_changed` are the only
 * record that a student wavered. `schema/practice.ts` says it plainly: a student
 * who practised in September and changed four answers leaves no trace of it
 * unless the columns were written in September. There is no query, no export and
 * no vendor that recovers them afterwards.
 *
 * They were nonetheless populated from an OPTIONAL REQUEST FIELD — whatever the
 * client volunteered — and an audit of an honest end-to-end journey found them
 * NULL on five of six responses. A column that is unrecoverable, load-bearing
 * for the parent digest's misconception query, and usually empty is worse than
 * absent: the report it feeds silently under-counts and nothing says so.
 *
 * The server already holds every answer the session has recorded. That is the
 * authoritative history, and it is the only one a student cannot edit. So the
 * derivation lives here, is pure, and takes the PRIOR RECORDED ANSWER rather
 * than anything off the wire.
 * ===========================================================================
 *
 * ===========================================================================
 * THE FIRST INDEX IS CARRIED FORWARD, NOT RE-READ FROM THE PRIOR SELECTION.
 *
 * On a third answer to the same question the first choice is the one recorded on
 * the FIRST answer, which by then is two selections behind. `prior.selectedIndex`
 * would name the second. So the chain is `prior.firstSelectedIndex` when it is
 * known and `prior.selectedIndex` only as the seed for a prior row that predates
 * this derivation. Reading the wrong one loses exactly the diagnosis the column
 * exists to keep, and produces a value that is individually plausible.
 *
 * `practice` refuses a second answer today (D-281), so the carry-forward branch
 * is unreachable through the HTTP surface. It is written and tested anyway: it
 * is the half of the fix that survives if the immutability rule is ever relaxed,
 * and a rule enforced in exactly one place is a rule one edit from being gone.
 * ===========================================================================
 *
 * Every index here is CANONICAL (D-058). The service translates out of
 * presentation space before it calls this.
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** The answer already recorded for this question, as the session holds it. */
export interface PriorSelection {
  /** CANONICAL. The selection the prior answer settled on. */
  readonly selectedIndex: number;
  /**
   * CANONICAL. The first choice that prior answer already carried forward.
   *
   * Null only for a row written before this derivation existed, where the
   * prior selection is the best available seed.
   */
  readonly firstSelectedIndex: number | null;
}

/** What gets written to `first_selected_index` and `answer_changed`. */
export interface AnswerChange {
  /**
   * NEVER NULL. Where there is no prior answer the first choice IS this one,
   * which is a statement about the student rather than a missing observation —
   * and the previous code's `null` said "the client did not tell us", which is
   * a statement about the client.
   */
  readonly firstSelectedIndex: number;
  /** `firstSelectedIndex !== selectedIndex`. The CHECK constraint agrees. */
  readonly answerChanged: boolean;
}

function assertCanonicalIndex(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `deriveAnswerChange: ${name} must be a non-negative integer, received ${String(value)}.`,
    );
  }
}

/**
 * Derives the change-of-mind evidence for one answer.
 *
 * `prior` is `undefined` when this question has not been answered in this
 * session yet — the ordinary case, and the only one reachable while D-281's
 * immutability rule stands.
 */
export function deriveAnswerChange(
  prior: PriorSelection | undefined,
  selectedIndex: number,
): AnswerChange {
  assertCanonicalIndex('selectedIndex', selectedIndex);

  if (prior === undefined) {
    return { firstSelectedIndex: selectedIndex, answerChanged: false };
  }

  const carried = prior.firstSelectedIndex ?? prior.selectedIndex;
  assertCanonicalIndex('prior first selection', carried);

  return { firstSelectedIndex: carried, answerChanged: carried !== selectedIndex };
}
