import { describe, expect, it } from 'vitest';
import { countByReason, partitionQuestions } from '../question-eligibility';
import type { SourceQuestion } from '../source-shapes';

/**
 * ~1,045 of the ~3,791 in-scope source questions carry an EMPTY options array.
 * They violate P6 and the four-option CHECK, they cannot be answered, and they
 * cannot be repaired by an import.
 *
 * The tests that matter here are not the ones proving they are excluded. They
 * are the ones proving they are REPORTED — a `.filter()` would satisfy every
 * assertion about the eligible half and lose the 1,045 ids the regeneration job
 * needs to target.
 */

function question(overrides: Partial<SourceQuestion> = {}): SourceQuestion {
  return {
    id: 'src-1',
    grade: '6',
    subject: 'math',
    chapter_number: 1,
    question_text: 'What is 2 + 2?',
    options: ['3', '4', '5', '6'],
    correct_answer_index: 1,
    explanation: 'Two plus two is four.',
    difficulty: 'easy',
    bloom_level: 'remember',
    ...overrides,
  };
}

describe('partitionQuestions — the optionless 1,045', () => {
  it('excludes a question with an EMPTY options array', () => {
    const { eligible, excluded } = partitionQuestions([question({ options: [] })]);

    expect(eligible).toEqual([]);
    expect(excluded).toEqual([{ id: 'src-1', reason: 'options-wrong-count' }]);
  });

  it('reports every excluded id, so regeneration has something to target', () => {
    /**
     * THE POINT OF THE MODULE. A chapter that lost all fifteen of its questions
     * to this rule looks exactly like a chapter that never had any — unless the
     * ids come out.
     */
    const rows = [
      question({ id: 'keep-1' }),
      question({ id: 'drop-1', options: [] }),
      question({ id: 'drop-2', options: [] }),
      question({ id: 'keep-2' }),
    ];

    const { eligible, excluded } = partitionQuestions(rows);

    expect(eligible.map((q) => q.sourceId)).toEqual(['keep-1', 'keep-2']);
    expect(excluded.map((e) => e.id)).toEqual(['drop-1', 'drop-2']);
  });

  it('accounts for every input row exactly once', () => {
    // An import that silently loses a row it neither imported nor reported is
    // the failure mode this whole module exists to make impossible.
    const rows = [
      question({ id: 'a' }),
      question({ id: 'b', options: [] }),
      question({ id: 'c', grade: '11' }),
      question({ id: 'd', subject: 'history_sr' }),
    ];

    const { eligible, excluded } = partitionQuestions(rows);

    expect(eligible.length + excluded.length).toBe(rows.length);
    expect([...eligible.map((q) => q.sourceId), ...excluded.map((e) => e.id)].sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('summarises by reason for the report header', () => {
    const { excluded } = partitionQuestions([
      question({ id: 'a', options: [] }),
      question({ id: 'b', options: [] }),
      question({ id: 'c', grade: '12' }),
    ]);

    expect(countByReason(excluded)).toEqual({
      'options-wrong-count': 2,
      'grade-outside-pilot': 1,
    });
  });
});

describe('partitionQuestions — every rejection maps to a real constraint', () => {
  it('refuses options that are not an array at all', () => {
    const { excluded } = partitionQuestions([question({ options: { a: 1 } })]);
    expect(excluded[0]?.reason).toBe('options-not-an-array');
  });

  it('reports a three-option question as a COUNT problem, not an emptiness one', () => {
    /**
     * D-039 in miniature. Two overlapping checks that can both refuse the same
     * row make the message name whichever ran first — and a three-option
     * question reported as "an option was empty" sends whoever reads the report
     * looking for the wrong defect. The count is checked before the contents so
     * the reason is always the specific one.
     */
    const { excluded } = partitionQuestions([question({ options: ['a', 'b', 'c'] })]);
    expect(excluded[0]?.reason).toBe('options-wrong-count');
  });

  it('refuses an empty or whitespace option', () => {
    expect(partitionQuestions([question({ options: ['a', '', 'c', 'd'] })]).excluded[0]?.reason).toBe(
      'options-empty-string',
    );
    expect(
      partitionQuestions([question({ options: ['a', '   ', 'c', 'd'] })]).excluded[0]?.reason,
    ).toBe('options-empty-string');
  });

  it('refuses a non-string option', () => {
    const { excluded } = partitionQuestions([question({ options: ['a', 4, 'c', 'd'] })]);
    expect(excluded[0]?.reason).toBe('options-empty-string');
  });

  it('refuses four options that are not DISTINCT', () => {
    /**
     * The rule D-039 could not express as a CHECK — a CHECK may not contain a
     * subquery and distinctness needs aggregation — and which has had nowhere to
     * live since (open item 4). The import is a write path, so it lives here.
     *
     * It matters because a duplicated option makes a question with two correct
     * answers, one of which is scored wrong.
     */
    const { excluded } = partitionQuestions([question({ options: ['4', '4', '5', '6'] })]);
    expect(excluded[0]?.reason).toBe('options-not-distinct');
  });

  it('refuses a correct index that points outside the four options', () => {
    for (const index of [-1, 4, 99, 1.5, null]) {
      const { excluded } = partitionQuestions([question({ correct_answer_index: index })]);
      expect(excluded[0]?.reason).toBe('correct-index-out-of-range');
    }
  });

  it('refuses an empty stem or explanation', () => {
    expect(partitionQuestions([question({ question_text: '  ' })]).excluded[0]?.reason).toBe(
      'question-text-empty',
    );
    expect(partitionQuestions([question({ explanation: null })]).excluded[0]?.reason).toBe(
      'explanation-empty',
    );
  });

  it('refuses a difficulty or bloom level outside the vocabulary', () => {
    expect(partitionQuestions([question({ difficulty: 'trivial' })]).excluded[0]?.reason).toBe(
      'difficulty-invalid',
    );
    // NOT Bloom levels at all, and both are really in the corpus — one question
    // each. No alias is invented for them: `infer` sits between understand and
    // analyse and `predict` between apply and evaluate, and either guess would
    // be written into data that later drives question selection.
    for (const level of ['infer', 'predict', 'trivia', null]) {
      expect(partitionQuestions([question({ bloom_level: level })]).excluded[0]?.reason).toBe(
        'bloom-level-invalid',
      );
    }
  });

  it('stores the British spelling, and accepts the American one the source uses', () => {
    /**
     * CHANGED 10 August 2026 against the measured extract (D-098). This test
     * used to assert that `analyze` was REJECTED — a reasonable-looking rule
     * written before anybody counted, and one that would have silently dropped
     * **735 of the 2,746 importable questions**, a quarter of the bank, over a
     * spelling.
     *
     * `analyze` and `analyse` are the same Bloom level. Folding one onto the
     * other merges nothing that was distinct, which is the test every alias in
     * `normalise.ts` has to pass. What is stored is the British spelling the
     * CHECK constraint enforces.
     */
    expect(partitionQuestions([question({ bloom_level: 'analyse' })]).eligible[0]?.bloomLevel).toBe(
      'analyse',
    );
    expect(partitionQuestions([question({ bloom_level: 'analyze' })]).eligible[0]?.bloomLevel).toBe(
      'analyse',
    );
  });

  it('maps the integer difficulty scale the source really uses', () => {
    // D-098: `question_bank.difficulty` is an integer, not a word. 4 and 5 are
    // clamped to `hard` — 15 rows, and the alternative is excluding them.
    const of = (difficulty: number | string): string | undefined =>
      partitionQuestions([question({ difficulty })]).eligible[0]?.difficulty;

    expect([of(1), of(2), of(3), of(4), of(5)]).toEqual([
      'easy',
      'medium',
      'hard',
      'hard',
      'hard',
    ]);
    expect(partitionQuestions([question({ difficulty: 0 })]).excluded[0]?.reason).toBe(
      'difficulty-invalid',
    );
  });

  it('tolerates casing and padding on the two vocabulary fields', () => {
    const { eligible } = partitionQuestions([
      question({ difficulty: ' Medium ', bloom_level: 'APPLY' }),
    ]);
    expect(eligible[0]?.difficulty).toBe('medium');
    expect(eligible[0]?.bloomLevel).toBe('apply');
  });
});

describe('partitionQuestions — the eligible half is fully normalised', () => {
  it('carries the canonical chapter key, not the source spelling', () => {
    const { eligible } = partitionQuestions([question({ grade: 'Grade 8', subject: 'math' })]);

    expect(eligible[0]?.chapter).toEqual({
      grade: '8',
      subject: 'mathematics',
      chapterNumber: 1,
    });
  });

  it('produces exactly four options as a tuple, so the index cannot overrun', () => {
    const { eligible } = partitionQuestions([question()]);
    expect(eligible[0]?.options).toHaveLength(4);
    expect(eligible[0]?.options[eligible[0].correctIndex]).toBe('4');
  });
});
