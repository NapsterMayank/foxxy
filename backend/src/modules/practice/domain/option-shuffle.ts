import { OPTIONS_PER_QUESTION } from '@/shared/constants/curriculum';

/**
 * OPTION SHUFFLING, AND THE CANONICAL INDEX — D-058.
 *
 * ===========================================================================
 * THE ONE RULE. Shuffling is a PRESENTATION concern. Every index this system
 * persists — `practice_responses.selected_index`,
 * `practice_responses.first_selected_index` — is the ORIGINAL index from
 * `questions.options`, never the position the student saw it in.
 *
 * The reason is `questions.distractor_misconceptions`, which is a jsonb object
 * KEYED BY ORIGINAL OPTION INDEX (D-048). Store a shuffled index and every
 * misconception lookup returns the code for a different distractor. Nothing
 * errors. The data stays perfectly plausible: a student who confused mass with
 * weight is recorded as having made a unit-conversion error, the parent digest
 * names the wrong misconception, and the remediation sends them somewhere
 * useless. There is no way to detect it afterwards and no way to repair it,
 * because the shuffle map that would have translated it is gone.
 *
 * So the map is RETAINED on the session (`practice_sessions.option_order`) and
 * every selection is translated back through `toCanonicalIndex` before anything
 * is written.
 * ===========================================================================
 *
 * PURE, INCLUDING THE RANDOMNESS. §2's layer table forbids a domain function
 * from generating a random number, and that is not pedantry here: a shuffle
 * that cannot be reproduced is a shuffle that cannot be tested, and the test
 * that matters is the one proving a REORDERING map still stores the original
 * index. `buildShuffle` takes the random fractions as an argument; the service
 * supplies them.
 */

/**
 * Presentation position -> ORIGINAL index.
 *
 * `map[0] === 2` means "the option shown first is `options[2]`". A permutation
 * of `0..n-1`, always — `assertShuffleMap` is what makes that a checked claim
 * rather than an assumption, because the map arrives back from a jsonb column.
 */
export type ShuffleMap = readonly number[];

/** No shuffle at all. Used when a caller deliberately wants the authored order. */
export function identityShuffle(optionCount: number = OPTIONS_PER_QUESTION): ShuffleMap {
  return Array.from({ length: optionCount }, (_unused, index) => index);
}

/**
 * A Fisher-Yates shuffle driven by SUPPLIED randomness.
 *
 * `fractions` are values in [0, 1), one per swap — `optionCount - 1` of them.
 * Too few THROWS rather than falling back to a default, because a silent
 * fallback here means "sometimes the options are not shuffled", which is
 * invisible in production and indistinguishable from a working shuffle in a
 * test.
 */
export function buildShuffle(
  optionCount: number,
  fractions: readonly number[],
): ShuffleMap {
  if (!Number.isInteger(optionCount) || optionCount < 1) {
    throw new RangeError(
      `buildShuffle: optionCount must be a positive integer, received ${String(optionCount)}.`,
    );
  }

  const required = optionCount - 1;
  if (fractions.length < required) {
    throw new RangeError(
      `buildShuffle: needs ${required} random fractions for ${optionCount} options, received ${fractions.length}.`,
    );
  }

  const map = Array.from({ length: optionCount }, (_unused, index) => index);

  for (let position = optionCount - 1; position > 0; position -= 1) {
    const fraction = fractions[optionCount - 1 - position] ?? 0;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
      throw new RangeError(
        `buildShuffle: every fraction must be in [0, 1), received ${String(fraction)}.`,
      );
    }
    const target = Math.floor(fraction * (position + 1));
    const held = indexAt(map, position);
    map[position] = indexAt(map, target);
    map[target] = held;
  }

  return map;
}

/** Rejects anything that is not a permutation of `0..count-1`. */
export function assertShuffleMap(value: unknown, optionCount: number): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== optionCount) {
    throw new RangeError(
      `assertShuffleMap: expected a permutation of ${optionCount} indices, received ${JSON.stringify(
        value,
      )}.`,
    );
  }

  const seen = new Set<number>();
  for (const entry of value as unknown[]) {
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) >= optionCount) {
      throw new RangeError(
        `assertShuffleMap: ${String(entry)} is not an index in 0..${optionCount - 1}.`,
      );
    }
    if (seen.has(entry as number)) {
      throw new RangeError(`assertShuffleMap: index ${String(entry)} appears twice.`);
    }
    seen.add(entry as number);
  }
}

/** The options in the order the student saw them. */
export function applyShuffle<T>(options: readonly T[], map: ShuffleMap): T[] {
  assertShuffleMap(map, options.length);
  return map.map((original) => options[original] as T);
}

/**
 * THE TRANSLATION. Presentation index -> original index.
 *
 * Called on every selection before anything is persisted. There is deliberately
 * no default and no fallback: an out-of-range presentation index throws, because
 * the alternative — clamping to 0 — writes a real-looking answer nobody gave.
 */
export function toCanonicalIndex(map: ShuffleMap, presentationIndex: number): number {
  return indexAt(map, presentationIndex);
}

/**
 * One bounds-checked read, shared by the shuffle and by the translation.
 *
 * Shared deliberately rather than duplicated. `!` is banned outside tests, and
 * the other obvious form — `map[i] ?? 0` — would silently return a real-looking
 * answer nobody gave. Because the public translation DELEGATES to this, its
 * refusal path is exercised by the ordinary out-of-range tests instead of being
 * an untested branch only the shuffle could reach.
 */
function indexAt(map: ShuffleMap, position: number): number {
  const value = Number.isInteger(position) ? map[position] : undefined;
  if (value === undefined) {
    throw new RangeError(
      `toCanonicalIndex: ${String(position)} is not a position in a ${map.length}-option question.`,
    );
  }
  return value;
}

/**
 * The inverse: original index -> the position the student saw it in.
 *
 * Needed only to render a result screen that highlights the correct option in
 * the order it was shown. Nothing persists its output.
 */
export function toPresentationIndex(map: ShuffleMap, canonicalIndex: number): number {
  const position = map.indexOf(canonicalIndex);
  if (position === -1) {
    throw new RangeError(
      `toPresentationIndex: original index ${String(canonicalIndex)} is not in this shuffle map.`,
    );
  }
  return position;
}
