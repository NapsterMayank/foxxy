import { describe, expect, it } from 'vitest';
import { MAX_HINT_LEVEL } from '@/shared/constants/practice';
import {
  availableHintLevels,
  resolveHint,
  type QuestionHints,
} from '../domain/hint-ladder';

/**
 * The hint ladder, and the corpus that does not have one (D-077).
 *
 * The whole point of these tests is the DEGRADED case, because the degraded
 * case is production: `hint_level_1..3` and `solution_steps` are NULL on all
 * 3,791 source questions. A test suite that only exercised a fully authored
 * question would be testing a state the product has never been in.
 */

const EMPTY: QuestionHints = {
  hintLevel1: null,
  hintLevel2: null,
  hintLevel3: null,
  solutionSteps: null,
  workedExample: null,
  prerequisiteConceptTitle: null,
};

const AUTHORED: QuestionHints = {
  hintLevel1: 'Look at the units before you calculate.',
  hintLevel2: 'The question gives you a distance and a time.',
  hintLevel3: null,
  solutionSteps: ['Convert 90 km/h into metres per second.', 'Divide the distance by that speed.'],
  workedExample: 'A car covering 120 km in 2 hours travels at 60 km/h.',
  prerequisiteConceptTitle: 'Unit conversion',
};

describe('resolveHint — THE DEGRADED CORPUS, which is the current state', () => {
  it('reports every rung unavailable when nothing is authored', () => {
    for (let level = 1; level <= MAX_HINT_LEVEL; level += 1) {
      expect(resolveHint(EMPTY, level).available).toBe(false);
    }
  });

  it('says the rung is NOT AUTHORED rather than pretending it is out of range', () => {
    // The distinction is the whole reason two reasons exist: one is a content
    // gap to be filled, the other is a caller error. Collapsed into one, the gap
    // hides behind what looks like a bounds check.
    const outcome = resolveHint(EMPTY, 1);
    expect(outcome).toEqual({
      available: false,
      level: 1,
      name: 'directional',
      reason: 'not_authored',
    });
  });

  it('offers no hint levels at all for an unauthored question', () => {
    expect(availableHintLevels(EMPTY)).toEqual([]);
  });

  it('NEVER invents text', () => {
    for (let level = 1; level <= MAX_HINT_LEVEL; level += 1) {
      const outcome = resolveHint(EMPTY, level);
      expect(outcome).not.toHaveProperty('text');
    }
  });
});

describe('resolveHint — an authored question', () => {
  it('serves the directional hint at level 1', () => {
    expect(resolveHint(AUTHORED, 1)).toEqual({
      available: true,
      level: 1,
      name: 'directional',
      text: AUTHORED.hintLevel1,
    });
  });

  it('serves the highlight at level 2', () => {
    const outcome = resolveHint(AUTHORED, 2);
    expect(outcome.available).toBe(true);
    expect(outcome).toMatchObject({ name: 'highlight' });
  });

  it('serves ONLY the first solution step at level 3', () => {
    const outcome = resolveHint(AUTHORED, 3);
    expect(outcome).toEqual({
      available: true,
      level: 3,
      name: 'partial_step',
      text: 'Convert 90 km/h into metres per second.',
    });
  });

  it('serves an ANALOGOUS worked example at level 4, not this question', () => {
    const outcome = resolveHint(AUTHORED, 4);
    expect(outcome).toMatchObject({ available: true, name: 'worked_example' });
    // The example is about a different car at a different speed. It cannot be
    // this question's answer because it is not derived from this question.
    expect(outcome).not.toMatchObject({ text: AUTHORED.solutionSteps?.[1] });
  });

  it('names the prerequisite at level 5', () => {
    expect(resolveHint(AUTHORED, 5)).toEqual({
      available: true,
      level: 5,
      name: 'prerequisite',
      text: 'Unit conversion',
    });
  });

  it('lists exactly the rungs that have content', () => {
    expect(availableHintLevels(AUTHORED)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('resolveHint — NEVER REVEALS THE ANSWER', () => {
  it('refuses the partial step when the solution is a single step', () => {
    // A one-step solution IS the answer. Serving it under the label "partial
    // step" would hand over the thing the ladder exists to withhold.
    const oneStep: QuestionHints = { ...EMPTY, solutionSteps: ['The answer is 25 m/s.'] };
    expect(resolveHint(oneStep, 3)).toEqual({
      available: false,
      level: 3,
      name: 'partial_step',
      reason: 'would_reveal_answer',
    });
  });

  it('distinguishes "would reveal" from "not authored" — they need opposite fixes', () => {
    const noSteps: QuestionHints = { ...EMPTY, solutionSteps: [] };
    expect(resolveHint(noSteps, 3)).toMatchObject({ reason: 'not_authored' });
  });

  it('serves the first of many steps, never the last', () => {
    const many: QuestionHints = {
      ...EMPTY,
      solutionSteps: ['step one', 'step two', 'the answer is 25 m/s'],
    };
    const outcome = resolveHint(many, 3);
    expect(outcome).toMatchObject({ available: true, text: 'step one' });
  });

  it('prefers an authored level-3 hint over the solution steps', () => {
    const authoredThree: QuestionHints = {
      ...EMPTY,
      hintLevel3: 'Start by converting the units.',
      solutionSteps: ['step one', 'step two'],
    };
    expect(resolveHint(authoredThree, 3)).toMatchObject({ text: 'Start by converting the units.' });
  });
});

describe('resolveHint — bounds', () => {
  it('reports above_ladder past the top rung', () => {
    expect(resolveHint(AUTHORED, MAX_HINT_LEVEL + 1)).toEqual({
      available: false,
      level: MAX_HINT_LEVEL + 1,
      name: null,
      reason: 'above_ladder',
    });
  });

  it('reports above_ladder for level 0 — 0 means no hint, not a rung', () => {
    expect(resolveHint(AUTHORED, 0)).toMatchObject({ reason: 'above_ladder' });
  });

  it('reports above_ladder for a negative or fractional level', () => {
    expect(resolveHint(AUTHORED, -1)).toMatchObject({ reason: 'above_ladder' });
    expect(resolveHint(AUTHORED, 1.5)).toMatchObject({ reason: 'above_ladder' });
  });

  it('treats whitespace-only authored text as unauthored', () => {
    expect(resolveHint({ ...EMPTY, hintLevel1: '   ' }, 1)).toMatchObject({
      reason: 'not_authored',
    });
  });
});
