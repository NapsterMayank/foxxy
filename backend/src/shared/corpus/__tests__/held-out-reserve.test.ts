import { describe, expect, it } from 'vitest';
import {
  allHeldOutIds,
  chooseReserve,
  planReserves,
  scoreReadiness,
  DEMO_MIN_CHUNKS,
  DEMO_MIN_CONCEPTS,
  DEMO_MIN_QUESTIONS,
  HELD_OUT_SHARE,
  MIN_QUESTIONS_FOR_RESERVE,
} from '../held-out-reserve';

/**
 * D-079 — THE ONE-WAY DOOR.
 *
 * A served question may have been memorised and can never measure anything
 * again, for that student, permanently. There is no cleanup. So these tests are
 * not about a percentage being right; they are about the reserve being STABLE,
 * PER CHAPTER, and ABSENT rather than token where a chapter cannot afford one.
 */

function ids(count: number, prefix = 'q'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);
}

describe('chooseReserve — the share', () => {
  it('reserves ~30% of a healthy chapter', () => {
    const reserve = chooseReserve('6|mathematics|1', ids(30));
    expect(reserve.heldOut).toHaveLength(9);
    expect(reserve.belowThreshold).toBe(false);
    expect(reserve.totalQuestions).toBe(30);
  });

  it('rounds UP, so the smallest permitted chapter still has a readable check', () => {
    // 15 x 0.3 is 4.5. Rounding down would give the thinnest permitted chapter
    // the weakest possible mastery check; a chapter may be thin on practice and
    // may not be thin on evidence.
    const reserve = chooseReserve('6|mathematics|1', ids(15));
    expect(reserve.heldOut).toHaveLength(5);
    expect(Math.ceil(15 * HELD_OUT_SHARE)).toBe(5);
  });

  it('leaves the majority for practice at every size above the threshold', () => {
    for (const size of [15, 16, 20, 31, 75]) {
      const reserve = chooseReserve('k', ids(size));
      expect(reserve.heldOut.length).toBeLessThan(size - reserve.heldOut.length);
    }
  });
});

describe('chooseReserve — the threshold', () => {
  it('gives a chapter below the threshold NO reserve, and flags it', () => {
    /**
     * ~41 of the ~134 pilot chapters are here. The alternative — reserve one or
     * two anyway — is worse in both directions at once: it takes questions from
     * a chapter that already cannot fill a practice session, AND a two-question
     * mastery check measures nothing. The cost is paid; the benefit is not.
     */
    const reserve = chooseReserve('9|science|12', ids(14));
    expect(reserve.heldOut).toEqual([]);
    expect(reserve.belowThreshold).toBe(true);
    expect(reserve.totalQuestions).toBe(14);
  });

  it('is exactly at 15, not around 15', () => {
    expect(chooseReserve('k', ids(MIN_QUESTIONS_FOR_RESERVE - 1)).belowThreshold).toBe(true);
    expect(chooseReserve('k', ids(MIN_QUESTIONS_FOR_RESERVE)).belowThreshold).toBe(false);
  });

  it('handles a chapter with one question and one with none', () => {
    expect(chooseReserve('k', ids(1)).heldOut).toEqual([]);
    expect(chooseReserve('k', []).belowThreshold).toBe(true);
  });
});

describe('chooseReserve — stability, which is the property that cannot be recovered', () => {
  it('returns the same reserve for the same ids in a different order', () => {
    /**
     * A reserve that depends on extract order is a reserve that MOVES between
     * runs — and a question that moves out of the reserve is served, which
     * contaminates it permanently. That failure is caused by the mechanism meant
     * to prevent it, and nothing about it is visible at the time.
     */
    const forwards = chooseReserve('k', ids(21));
    const backwards = chooseReserve('k', [...ids(21)].reverse());
    const shuffled = chooseReserve('k', [...ids(21)].sort(() => 0.5 - Math.random()));

    expect(backwards.heldOut).toEqual(forwards.heldOut);
    expect(shuffled.heldOut).toEqual(forwards.heldOut);
  });

  it('is a pure function of the ids: repeated calls never diverge', () => {
    const first = chooseReserve('k', ids(40));
    for (let run = 0; run < 5; run += 1) {
      expect(chooseReserve('k', ids(40)).heldOut).toEqual(first.heldOut);
    }
  });

  it('keeps the whole previous reserve when the chapter GAINS questions', () => {
    /**
     * THIS TEST FOUND A REAL DEFECT AND IS THE REASON THE MODULE IS SHAPED THE
     * WAY IT IS.
     *
     * The first implementation was D-047's "sort the ids, take the last 30%",
     * with no notion of an existing reserve. Under that rule a chapter growing
     * from 20 questions to 30 recomputes its reserve as the last 9 of the NEW
     * order — and the 6 reserved before are no longer reserved. The next
     * practice session serves them. They are contaminated permanently and
     * nothing reports it.
     *
     * It is not an edge case, it is the plan: D-079 decided thin chapters get
     * MORE QUESTIONS GENERATED rather than a smaller reserve, so re-importing a
     * grown chapter is the expected path.
     */
    const before = chooseReserve('k', ids(20));
    const after = chooseReserve('k', [...ids(20), ...ids(10, 'r')], new Set(before.heldOut));

    for (const id of before.heldOut) {
      expect(after.heldOut).toContain(id);
    }
    expect(after.heldOut.length).toBeGreaterThanOrEqual(before.heldOut.length);
  });

  it('adds nothing on an unchanged re-run, which is what idempotent means here', () => {
    const first = chooseReserve('k', ids(30));
    const second = chooseReserve('k', ids(30), new Set(first.heldOut));

    expect(second.heldOut).toEqual(first.heldOut);
    expect(second.newlyHeldOut).toEqual([]);
  });

  it('tops the reserve up to the new 30%, not past it', () => {
    const before = chooseReserve('k', ids(20)); // 6 held out
    const after = chooseReserve('k', [...ids(20), ...ids(10, 'r')], new Set(before.heldOut));

    expect(after.heldOut).toHaveLength(Math.ceil(30 * HELD_OUT_SHARE));
    expect(after.newlyHeldOut).toHaveLength(9 - 6);
  });

  it('NEVER releases a reserved question, even when the chapter drops below the threshold', () => {
    /**
     * The back-door version of the same failure. A chapter that shrinks — a
     * batch of questions withdrawn as wrong, say — falls under 15 and would,
     * under any "recompute from scratch" rule, have its reserve emptied and
     * every one of those questions served.
     *
     * "We no longer need this reserve" is not a reason to serve a question.
     * Un-reserving is the one operation that cannot be undone.
     */
    const before = chooseReserve('k', ids(20));
    const shrunk = chooseReserve('k', ids(10), new Set(before.heldOut));

    expect(shrunk.belowThreshold).toBe(true);
    expect(shrunk.newlyHeldOut).toEqual([]);
    // Only the ids that still exist in the source survive; the rest are gone
    // from the source, not released.
    expect(shrunk.heldOut).toEqual(before.heldOut.filter((id) => ids(10).includes(id)));
  });

  it('drops a previously reserved id that no longer exists in the source', () => {
    // The intersection half. A reserve that accumulates ids the source has
    // deleted is a reserve whose count no longer means anything.
    const reserve = chooseReserve('k', ids(20), new Set(['gone-1', 'gone-2']));
    expect(reserve.heldOut).not.toContain('gone-1');
  });
});

describe('planReserves — per chapter, never global', () => {
  it('decides each chapter on its own question count', () => {
    /**
     * The whole point of D-079. A global 30% draw over these three chapters
     * would take 12 of 40 from wherever they happened to fall — plausibly all
     * from the healthy chapter, or worse, 3 from the chapter that has 6.
     */
    const plan = planReserves(
      new Map([
        ['6|mathematics|1', ids(30, 'a')],
        ['6|mathematics|2', ids(6, 'b')],
        ['9|science|4', ids(15, 'c')],
      ]),
    );

    expect(plan.get('6|mathematics|1')?.heldOut).toHaveLength(9);
    expect(plan.get('6|mathematics|2')?.heldOut).toHaveLength(0);
    expect(plan.get('6|mathematics|2')?.belowThreshold).toBe(true);
    expect(plan.get('9|science|4')?.heldOut).toHaveLength(5);
  });

  it('never reserves an id belonging to another chapter', () => {
    const plan = planReserves(
      new Map([
        ['a', ids(20, 'a')],
        ['b', ids(20, 'b')],
      ]),
    );

    expect(plan.get('a')?.heldOut.every((id) => id.startsWith('a-'))).toBe(true);
    expect(plan.get('b')?.heldOut.every((id) => id.startsWith('b-'))).toBe(true);
  });

  it('flattens to a de-duplicated set of ids for a single update', () => {
    const plan = planReserves(
      new Map([
        ['a', ids(20, 'a')],
        ['b', ids(20, 'b')],
      ]),
    );
    const flat = allHeldOutIds(plan);

    expect(flat).toHaveLength(12);
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe('scoreReadiness — the two bars, which answer different questions', () => {
  const counts = (questions: number, chunks: number, concepts: number) =>
    new Map([['k', { questions, chunks, concepts }]]);

  it('marks a chapter reserve-ready only with chunks AND concepts AND 15 questions', () => {
    expect(scoreReadiness(counts(15, 1, 1))[0]?.reserveReady).toBe(true);
    expect(scoreReadiness(counts(14, 99, 99))[0]?.reserveReady).toBe(false);
    expect(scoreReadiness(counts(99, 0, 99))[0]?.reserveReady).toBe(false);
    expect(scoreReadiness(counts(99, 99, 0))[0]?.reserveReady).toBe(false);
  });

  it('requires ALL THREE demo minimums, not any of them', () => {
    expect(
      scoreReadiness(counts(DEMO_MIN_QUESTIONS, DEMO_MIN_CHUNKS, DEMO_MIN_CONCEPTS))[0]?.demoReady,
    ).toBe(true);
    expect(
      scoreReadiness(counts(DEMO_MIN_QUESTIONS - 1, 999, 999))[0]?.demoReady,
    ).toBe(false);
    expect(
      scoreReadiness(counts(999, DEMO_MIN_CHUNKS - 1, 999))[0]?.demoReady,
    ).toBe(false);
    expect(
      scoreReadiness(counts(999, 999, DEMO_MIN_CONCEPTS - 1))[0]?.demoReady,
    ).toBe(false);
  });

  it('separates the two bars: reserve-ready does not imply demo-ready', () => {
    // A chapter with 15 questions, 3 chunks and 1 concept can carry the one-way
    // door and is not worth showing anybody. Collapsing the two into one number
    // would either block the reserve on cosmetics or claim readiness it lacks.
    const [chapter] = scoreReadiness(counts(15, 3, 1));
    expect(chapter?.reserveReady).toBe(true);
    expect(chapter?.demoReady).toBe(false);
  });

  it('returns a stable order regardless of map insertion order', () => {
    const forwards = scoreReadiness(
      new Map([
        ['9|science|1', { questions: 1, chunks: 1, concepts: 1 }],
        ['6|mathematics|1', { questions: 1, chunks: 1, concepts: 1 }],
      ]),
    );
    expect(forwards.map((entry) => entry.chapterKey)).toEqual(['6|mathematics|1', '9|science|1']);
  });
});
