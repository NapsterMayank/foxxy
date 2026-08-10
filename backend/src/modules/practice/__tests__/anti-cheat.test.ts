import { describe, expect, it } from 'vitest';
import {
  MIN_AVERAGE_MS_PER_QUESTION,
  SAME_ANSWER_MIN_QUESTIONS,
  validateAttempt,
  type AttemptResponse,
} from '../domain/anti-cheat';
import { buildShuffle } from '../domain/option-shuffle';

/**
 * §8.6: "each anti-cheat rule both passing and failing · exactly 3 identical
 * answers is allowed, 4 is not".
 *
 * Each of the three rules gets a pass case, a fail case and — for the two with
 * thresholds — the exact boundary on both sides. A threshold tested only from
 * one side is a threshold that can be off by one forever.
 */

function response(selectedIndex: number, timeSpentMs: number): AttemptResponse {
  return { selectedIndex, presentationIndex: selectedIndex, timeSpentMs };
}

/** A response whose screen position and stored index deliberately DISAGREE. */
function tapped(
  presentationIndex: number,
  selectedIndex: number,
  timeSpentMs: number = MIN_AVERAGE_MS_PER_QUESTION * 2,
): AttemptResponse {
  return { selectedIndex, presentationIndex, timeSpentMs };
}

/** n varied answers, each comfortably above the time floor. */
function honest(count: number): AttemptResponse[] {
  return Array.from({ length: count }, (_unused, index) =>
    response(index % 4, MIN_AVERAGE_MS_PER_QUESTION * 2),
  );
}

/** Real time generous enough that the clamp never decides anything. */
function ampleWindow(responses: readonly AttemptResponse[]): number {
  return responses.reduce((sum, r) => sum + r.timeSpentMs, 0);
}

// ===========================================================================
// THE CONSTANTS, PINNED TO LITERALS
// ===========================================================================

describe('the thresholds are the numbers §8.6 specifies', () => {
  /**
   * LITERALS, IN THE MODULE THAT OWNS THEM.
   *
   * Every threshold test below is written in terms of the constants, which is
   * correct — it is what makes them boundary tests rather than magic-number
   * tests — and it also means the whole file passes unchanged if either
   * constant moves. `SAME_ANSWER_MIN_QUESTIONS` was demonstrably free to move
   * from 3 to 10 with 219/219 still green, and the test named "ALLOWS exactly 3"
   * would then have been asserting that ten identical answers are allowed while
   * still reporting itself as testing three.
   *
   * `MIN_AVERAGE_MS_PER_QUESTION` was pinned only incidentally, in
   * `app/__tests__/routes.test.ts`, which is a test about module wiring. A
   * threshold has to be pinned where it is authored.
   */
  it('pins the time floor at 3000 ms', () => {
    expect(MIN_AVERAGE_MS_PER_QUESTION).toBe(3_000);
  });

  it('pins the same-answer rule to apply only ABOVE 3 questions', () => {
    expect(SAME_ANSWER_MIN_QUESTIONS).toBe(3);
  });
});

describe('validateAttempt — rule 3: response count equals question count', () => {
  it('accepts an attempt with one response per question', () => {
    expect(validateAttempt(honest(5), 5)).toEqual({ isValid: true });
  });

  it('rejects too few responses', () => {
    expect(validateAttempt(honest(4), 5)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });

  it('rejects too many responses', () => {
    expect(validateAttempt(honest(6), 5)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });

  it('is checked FIRST, so a mismatched set is never judged on its timing', () => {
    // Every response here is instant AND identical, so both other rules would
    // also fire. The count rule has to win: an average over the wrong set is a
    // number about nothing, and reporting "too fast" would send a support agent
    // to the wrong question entirely.
    const responses = [response(0, 0), response(0, 0)];
    expect(validateAttempt(responses, 10)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });
});

describe('validateAttempt — rule 1: at least 3 seconds average per question', () => {
  it('accepts an attempt exactly AT the floor', () => {
    const responses = [
      response(0, MIN_AVERAGE_MS_PER_QUESTION),
      response(1, MIN_AVERAGE_MS_PER_QUESTION),
    ];
    expect(validateAttempt(responses, 2)).toEqual({ isValid: true });
  });

  it('rejects an attempt one millisecond below the floor', () => {
    const responses = [
      response(0, MIN_AVERAGE_MS_PER_QUESTION),
      response(1, MIN_AVERAGE_MS_PER_QUESTION - 2),
    ];
    expect(validateAttempt(responses, 2)).toEqual({ isValid: false, reason: 'too_fast' });
  });

  it('is an AVERAGE, so one quick answer among slow ones is fine', () => {
    // A student who reads the whole set first and then answers the last one
    // quickly is not cheating. A per-question floor would refuse them.
    const responses = [
      response(0, MIN_AVERAGE_MS_PER_QUESTION * 5),
      response(1, MIN_AVERAGE_MS_PER_QUESTION * 5),
      response(2, 200),
    ];
    expect(validateAttempt(responses, 3)).toEqual({ isValid: true });
  });

  it('rejects a whole attempt answered instantly', () => {
    const responses = [response(0, 0), response(1, 0), response(2, 0)];
    expect(validateAttempt(responses, 3)).toEqual({ isValid: false, reason: 'too_fast' });
  });
});

describe('validateAttempt — rule 2: not every answer in the same SCREEN POSITION', () => {
  function allSame(count: number): AttemptResponse[] {
    return Array.from({ length: count }, () => response(2, MIN_AVERAGE_MS_PER_QUESTION * 2));
  }

  it('ALLOWS exactly 3 identical answers — and 3 is the literal number', () => {
    // With three four-option questions, all-the-same happens by chance about
    // once in sixteen honest attempts. A rule that fails one honest student in
    // sixteen is a rule that gets switched off.
    //
    // THE LITERAL 3 IS WRITTEN OUT. Phrased as `allSame(SAME_ANSWER_MIN_QUESTIONS)`
    // this test passes at any threshold, including 10, while still calling
    // itself the test for 3.
    expect(validateAttempt(allSame(3), 3)).toEqual({ isValid: true });
    expect(SAME_ANSWER_MIN_QUESTIONS).toBe(3);
  });

  it('REJECTS 4 identical answers — and 4 is the literal number', () => {
    expect(validateAttempt(allSame(4), 4)).toEqual({
      isValid: false,
      reason: 'all_same_answer',
    });
  });

  it('allows 4 answers where one differs', () => {
    const responses = allSame(4);
    responses[3] = response(0, MIN_AVERAGE_MS_PER_QUESTION * 2);
    expect(validateAttempt(responses, 4)).toEqual({ isValid: true });
  });

  it('allows 1 and 2 identical answers', () => {
    expect(validateAttempt(allSame(1), 1)).toEqual({ isValid: true });
    expect(validateAttempt(allSame(2), 2)).toEqual({ isValid: true });
  });

  // -------------------------------------------------------------------------
  // THE DEFECT: THE RULE READ THE WRONG INDEX
  // -------------------------------------------------------------------------

  it('FIRES on the same screen position even when every canonical index differs', () => {
    /**
     * THE BORED TAP-THROUGH, EXACTLY AS IT ARRIVES.
     *
     * Options are shuffled per question, so "the third one, six times" is six
     * DIFFERENT canonical indices. Read canonically the rule sees perfect
     * variety and passes; read as positions it sees one position six times.
     * Measured over 20,000 simulated attempts, the canonical reading fired
     * 14 times — 0.07%.
     */
    const responses = [
      tapped(2, 0),
      tapped(2, 3),
      tapped(2, 1),
      tapped(2, 2),
      tapped(2, 0),
      tapped(2, 3),
    ];
    expect(new Set(responses.map((r) => r.selectedIndex)).size).toBeGreaterThan(1);

    expect(validateAttempt(responses, 6, ampleWindow(responses))).toEqual({
      isValid: false,
      reason: 'all_same_answer',
    });
  });

  it('does NOT fire on an honest attempt whose canonical indices happen to be uniform', () => {
    /**
     * THE INVERSE FALSE POSITIVE, which is the half that reached real students.
     *
     * A full-marks attempt on a chapter whose authored `correct_index` is the
     * same for every question stores the same canonical index every time — and
     * the student tapped four different places to do it. The canonical reading
     * rejected that attempt and scored it zero.
     */
    const responses = [tapped(0, 1), tapped(3, 1), tapped(1, 1), tapped(2, 1)];
    expect(new Set(responses.map((r) => r.selectedIndex)).size).toBe(1);

    expect(validateAttempt(responses, 4, ampleWindow(responses))).toEqual({ isValid: true });
  });

  it('SKIPS the rule rather than falling back when a response has no screen position', () => {
    // `signals` re-validates stored rows, which carry only the canonical index.
    // Falling back to it there would reinstate both failures above for that
    // caller alone, silently.
    const responses: AttemptResponse[] = Array.from({ length: 6 }, () => ({
      selectedIndex: 2,
      timeSpentMs: MIN_AVERAGE_MS_PER_QUESTION * 2,
    }));
    expect(validateAttempt(responses, 6)).toEqual({ isValid: true });
  });

  it('skips the rule when only SOME responses carry a screen position', () => {
    const responses: AttemptResponse[] = [
      tapped(2, 0),
      tapped(2, 1),
      { selectedIndex: 2, timeSpentMs: MIN_AVERAGE_MS_PER_QUESTION * 2 },
      tapped(2, 3),
    ];
    expect(validateAttempt(responses, 4)).toEqual({ isValid: true });
  });
});

// ===========================================================================
// RULE 1'S SERVER-SIDE BACKSTOP
// ===========================================================================

describe('validateAttempt — the claimed total is CLAMPED to real elapsed time', () => {
  /** Six questions each claiming 12s — 72s of claimed work. */
  function claiming12s(): AttemptResponse[] {
    return Array.from({ length: 6 }, (_unused, index) => tapped(index % 4, index % 4, 12_000));
  }

  it('REJECTS six questions claiming 12s each inside a two-second session', () => {
    // The exact case the contract promised was guarded and was not. 2,000 ms of
    // real time over 6 questions is 333 ms each, well under the floor.
    expect(validateAttempt(claiming12s(), 6, 2_000)).toEqual({
      isValid: false,
      reason: 'too_fast',
    });
  });

  it('accepts the same claim when the session really did last that long', () => {
    expect(validateAttempt(claiming12s(), 6, 72_000)).toEqual({ isValid: true });
  });

  it('accepts a claim SMALLER than the real window — a paused tab is honest', () => {
    // 6 x 4s claimed inside a session left open for an hour. The clamp is a
    // ceiling, never a floor: it must not start requiring students to account
    // for wall-clock time they spent away from the screen.
    const responses = Array.from({ length: 6 }, (_unused, index) =>
      tapped(index % 4, index % 4, 4_000),
    );
    expect(validateAttempt(responses, 6, 60 * 60 * 1_000)).toEqual({ isValid: true });
  });

  it('is exact at the boundary: real elapsed equal to the floor total passes', () => {
    const responses = Array.from({ length: 4 }, (_unused, index) =>
      tapped(index, index, 30_000),
    );
    const floorTotal = MIN_AVERAGE_MS_PER_QUESTION * 4;
    expect(validateAttempt(responses, 4, floorTotal)).toEqual({ isValid: true });
    expect(validateAttempt(responses, 4, floorTotal - 1)).toEqual({
      isValid: false,
      reason: 'too_fast',
    });
  });

  it('imposes no ceiling at all when the caller has no server clock reading', () => {
    // `signals` reads `SessionFact`s that carry no `startedAt`. It must not
    // invent a window, and omitting one must not change its verdicts.
    expect(validateAttempt(claiming12s(), 6)).toEqual({ isValid: true });
  });

  it('treats a zero-length session as too fast rather than as vacuously fine', () => {
    expect(validateAttempt(claiming12s(), 6, 0)).toEqual({
      isValid: false,
      reason: 'too_fast',
    });
  });

  it('rejects a negative or non-finite window rather than clamping it silently', () => {
    expect(() => validateAttempt(honest(2), 2, -1)).toThrow(RangeError);
    expect(() => validateAttempt(honest(2), 2, Number.NaN)).toThrow(RangeError);
  });

  it('still reports the COUNT rule first, even with an impossible window', () => {
    // Order stays load-bearing: an average over the wrong set is a number about
    // nothing, whatever the clock says.
    expect(validateAttempt(claiming12s(), 10, 0)).toEqual({
      isValid: false,
      reason: 'response_count_mismatch',
    });
  });
});

describe('validateAttempt — edges', () => {
  it('treats an empty attempt as vacuously valid rather than as a cheat', () => {
    // It scores zero on its own merits. Calling it a cheat would put an
    // accusation on a session where nothing happened.
    expect(validateAttempt([], 0)).toEqual({ isValid: true });
  });

  it('rejects a negative question count', () => {
    expect(() => validateAttempt([], -1)).toThrow(RangeError);
  });

  it('rejects a fractional question count', () => {
    expect(() => validateAttempt([], 2.5)).toThrow(RangeError);
  });
});

// ===========================================================================
// THE FIRING RATE, BY SIMULATION
// ===========================================================================

describe('rule 2 firing rate over many sessions with REAL per-question shuffles', () => {
  /**
   * THE MEASUREMENT THAT FOUND THE DEFECT, RUN AS A TEST.
   *
   * A single hand-written case proves the rule can fire. It does not prove the
   * rule fires OFTEN ENOUGH to be worth having, and that is precisely where the
   * canonical-index version failed: it was correct on every example anybody
   * wrote and caught 0.1% of the behaviour it exists for, because a per-question
   * shuffle map turns one screen position into six different canonical indices.
   *
   * SEEDED, so this is a deterministic assertion and not a flake. The same
   * simulation against production `Math.random` (20,000 trials) reads
   * 20000/20000 for same-position tapping and 16/20000 for honest play.
   */
  const OPTIONS = 4;
  const QUESTIONS = 6;
  const TRIALS = 4_000;

  /** A small LCG. Reproducible everywhere, unlike `Math.random`. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
  }

  function simulate(pickPosition: (random: () => number) => number): {
    fired: number;
    trials: number;
  } {
    const random = seeded(20_260_810);
    let fired = 0;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const responses: AttemptResponse[] = Array.from({ length: QUESTIONS }, () => {
        // ONE MAP PER QUESTION, built exactly as `startSession` builds them.
        const map = buildShuffle(OPTIONS, [random(), random(), random()]);
        const presentationIndex = pickPosition(random);
        return {
          selectedIndex: map[presentationIndex]!,
          presentationIndex,
          timeSpentMs: MIN_AVERAGE_MS_PER_QUESTION * 4,
        };
      });

      const window = responses.reduce((sum, r) => sum + r.timeSpentMs, 0);
      if (!validateAttempt(responses, QUESTIONS, window).isValid) {
        fired += 1;
      }
    }

    return { fired, trials: TRIALS };
  }

  it('fires on EVERY session where the student taps the same position', () => {
    const { fired, trials } = simulate(() => 2);
    expect(fired).toBe(trials);
  });

  it('fires on well under 1% of honest random play', () => {
    // The floor is 4/4^6 ≈ 0.098% — four positions that could be repeated, out
    // of 4^6 equally likely sequences. Unavoidable with four options, and the
    // reason the rule is off at three questions where it would be ~6%.
    const { fired, trials } = simulate((random) => Math.floor(random() * OPTIONS));
    expect(fired / trials).toBeLessThan(0.01);
  });

  it('would fire on almost NOTHING if it read the canonical index instead', () => {
    /**
     * THE MUTATION, RUN RATHER THAN DESCRIBED. This is the shipped rule,
     * reproduced here over the same simulated sessions: a student tapping one
     * position six times, judged by the index that got stored.
     */
    const random = seeded(20_260_810);
    let fired = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const canonicals = Array.from({ length: QUESTIONS }, () => {
        const map = buildShuffle(OPTIONS, [random(), random(), random()]);
        return map[2]!;
      });
      if (canonicals.every((index) => index === canonicals[0])) {
        fired += 1;
      }
    }
    expect(fired / TRIALS).toBeLessThan(0.01);
  });
});
