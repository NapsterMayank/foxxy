import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAllMigrations,
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';
import { insertChapter, makeChapter } from '../fixtures/index';

/**
 * Migration 0003 — `questions.distractor_misconceptions` as a jsonb OBJECT
 * keyed by option index.
 *
 * THE POINT OF THIS FILE, stated plainly, because a constraint test that is
 * only about entry counts misses it entirely:
 *
 * Under the previous positional array, reordering a question's options — or
 * correcting `correct_index` — re-pointed every misconception code at a
 * different option, and NOTHING FAILED. No error, no type mismatch, no row
 * count change. The only observable effect was the weekly parent digest naming
 * the wrong misconception, which is the single output this product exists to
 * get right. There is no way to write a test that catches that under the array
 * shape, because there is nothing to catch: the data is not wrong, the
 * convention about how to read it is.
 *
 * The last describe block below is therefore the load-bearing one. It is not
 * "the constraint accepts an object"; it is "the failure mode no longer
 * exists", demonstrated by asking the database which option a code describes
 * and getting the same answer before and after a reorder.
 */

let postgres: TestPostgres;

async function run(sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await postgres.client.query(statement);
  }
}

let chapterCounter = 0;
async function freshChapter(): Promise<string> {
  chapterCounter += 1;
  return insertChapter(
    postgres.client,
    makeChapter(`mis${chapterCounter}`, { chapterNumber: chapterCounter }),
  );
}

/** Inserts a question with a hand-written misconception payload. */
async function insertWithCodes(
  chapterId: string,
  correctIndex: number,
  codes: unknown,
): Promise<void> {
  await postgres.client.query(
    `insert into questions (
        chapter_id, question_text, options, correct_index, explanation,
        difficulty, bloom_level, distractor_misconceptions
     ) values ($1, 'Q?', $2::jsonb, $3, 'Because.', 'medium', 'understand', $4::jsonb)`,
    [
      chapterId,
      JSON.stringify(['a', 'b', 'c', 'd']),
      correctIndex,
      codes === null ? null : JSON.stringify(codes),
    ],
  );
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

describe('the object shape is accepted', () => {
  it('accepts three entries keyed by the three wrong options', async () => {
    const chapterId = await freshChapter();
    await expect(
      insertWithCodes(chapterId, 1, {
        '0': 'confuses_mass_weight',
        '2': 'unit_conversion_step',
        '3': 'sign_error_negative',
      }),
    ).resolves.toBeUndefined();
  });

  it('still accepts NULL, because the codes are authored later', async () => {
    // Unchanged by 0003 on purpose. Absent is honest; a row of placeholder
    // codes would be a silent claim to have diagnosed something.
    const chapterId = await freshChapter();
    await expect(insertWithCodes(chapterId, 0, null)).resolves.toBeUndefined();
  });

  it('rejects the OLD positional array outright', async () => {
    // The two shapes must not be simultaneously legal. A column that accepts
    // both is a column every reader has to branch on, and the branch is
    // exactly the convention this migration removed.
    const chapterId = await freshChapter();
    await expect(insertWithCodes(chapterId, 1, ['a', 'b', 'c'])).rejects.toThrow(
      /questions_distractor_misconceptions_check/,
    );
  });
});

describe('exactly three entries', () => {
  it('rejects two entries — one per wrong option, not "some"', async () => {
    const chapterId = await freshChapter();
    await expect(insertWithCodes(chapterId, 1, { '0': 'a', '2': 'b' })).rejects.toThrow(
      /questions_distractor_misconceptions_check/,
    );
  });

  it('rejects four entries, which would have to include the correct option', async () => {
    const chapterId = await freshChapter();
    await expect(
      insertWithCodes(chapterId, 1, { '0': 'a', '1': 'b', '2': 'c', '3': 'd' }),
    ).rejects.toThrow(/questions_distractor_misconceptions_check/);
  });

  it('rejects an empty object', async () => {
    const chapterId = await freshChapter();
    await expect(insertWithCodes(chapterId, 1, {})).rejects.toThrow(
      /questions_distractor_misconceptions_check/,
    );
  });
});

describe('every key is an option index', () => {
  it('rejects a key of "4" — there is no fifth option', async () => {
    // The boundary one past the end. `correct_index` is capped at 3 and there
    // are exactly four options, so "4" can only be an authoring slip — and an
    // unconstrained key is a code that describes nothing and is never shown.
    const chapterId = await freshChapter();
    await expect(insertWithCodes(chapterId, 1, { '0': 'a', '2': 'b', '4': 'c' })).rejects.toThrow(
      /questions_distractor_misconceptions_check/,
    );
  });

  it('rejects a non-numeric key', async () => {
    const chapterId = await freshChapter();
    await expect(
      insertWithCodes(chapterId, 1, { '0': 'a', '2': 'b', option3: 'c' }),
    ).rejects.toThrow(/questions_distractor_misconceptions_check/);
  });
});

describe('the correct option has no misconception', () => {
  it('rejects a key equal to correct_index', async () => {
    // THE RULE THAT EARNS THE SHAPE CHANGE. A correct answer cannot carry a
    // misconception, and a payload claiming otherwise is an author who has
    // mistaken which option is right — caught here rather than surfacing as a
    // nonsense sentence in a parent digest.
    const chapterId = await freshChapter();
    await expect(insertWithCodes(chapterId, 2, { '0': 'a', '2': 'b', '3': 'c' })).rejects.toThrow(
      /questions_distractor_misconceptions_check/,
    );
  });

  it('rejects correcting correct_index onto an option that already has a code', async () => {
    // The corruption path, now closed. Under the array shape this UPDATE
    // succeeded and silently shifted all three codes by one position. Now the
    // author is forced to correct the codes in the same edit.
    const chapterId = await freshChapter();
    await insertWithCodes(chapterId, 1, { '0': 'a', '2': 'b', '3': 'c' });

    await expect(
      postgres.client.query(
        `update questions set correct_index = 3 where chapter_id = $1`,
        [chapterId],
      ),
    ).rejects.toThrow(/questions_distractor_misconceptions_check/);
  });
});

describe('reordering options no longer mislabels a misconception', () => {
  it('keeps each code attached to its own option across a reorder', async () => {
    // The regression this whole migration exists for, in one test.
    //
    // Question: options [mass, weight, volume, density], correct = 0, and the
    // code for option 1 ("weight") is `confuses_mass_weight`.
    //
    // An editor then reorders the options — a content fix, not a schema
    // change — so "weight" moves from index 1 to index 3 and the correct
    // answer moves with it. Under the positional array, `confuses_mass_weight`
    // was element 0 and after the reorder element 0 describes a different
    // option: every code is wrong, and nothing anywhere raises.
    //
    // Under the object shape the code has to be MOVED to the new key or the
    // constraint refuses the row, so the pairing survives by construction.
    const chapterId = await freshChapter();

    await postgres.client.query(
      `insert into questions (
          chapter_id, question_text, options, correct_index, explanation,
          difficulty, bloom_level, distractor_misconceptions
       ) values ($1, 'Which is a force?', $2::jsonb, 0, 'Because.', 'medium', 'understand', $3::jsonb)`,
      [
        chapterId,
        JSON.stringify(['mass', 'weight', 'volume', 'density']),
        JSON.stringify({
          '1': 'confuses_mass_weight',
          '2': 'confuses_volume_mass',
          '3': 'confuses_density_mass',
        }),
      ],
    );

    const misconceptionFor = async (option: string): Promise<string | undefined> => {
      const result = await postgres.client.query<{
        options: string[];
        codes: Record<string, string>;
      }>(
        `select options, distractor_misconceptions as codes
           from questions where chapter_id = $1`,
        [chapterId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('question missing');
      return row.codes[String(row.options.indexOf(option))];
    };

    expect(await misconceptionFor('weight')).toBe('confuses_mass_weight');

    // The reorder: [density, volume, weight, mass]. `mass` is still correct,
    // now at index 3, and the codes are re-keyed to match.
    await postgres.client.query(
      `update questions
          set options = $2::jsonb, correct_index = 3, distractor_misconceptions = $3::jsonb
        where chapter_id = $1`,
      [
        chapterId,
        JSON.stringify(['density', 'volume', 'weight', 'mass']),
        JSON.stringify({
          '0': 'confuses_density_mass',
          '1': 'confuses_volume_mass',
          '2': 'confuses_mass_weight',
        }),
      ],
    );

    // Same question of the data, same answer. The array shape could not have
    // survived this without a convention nobody enforces.
    expect(await misconceptionFor('weight')).toBe('confuses_mass_weight');
  });

  it('refuses a reorder that forgets to re-key the codes', async () => {
    // The other half, and the reason the first half holds: forgetting is now
    // an error rather than a silent relabelling. Here the options are reordered
    // so that `mass` (correct) lands on index 3, but the codes are left as they
    // were — and key "3" is now the correct option.
    const chapterId = await freshChapter();
    await insertWithCodes(chapterId, 0, { '1': 'a', '2': 'b', '3': 'c' });

    await expect(
      postgres.client.query(`update questions set correct_index = 3 where chapter_id = $1`, [
        chapterId,
      ]),
    ).rejects.toThrow(/questions_distractor_misconceptions_check/);
  });
});

describe('0003_misconception_object — rollback', () => {
  it('restores the array constraint and re-applies cleanly', async () => {
    const chapterId = await freshChapter();

    // THE ROLLBACK IS SHAPE-BLIND, and this line is the proof rather than
    // housekeeping: `ADD CONSTRAINT` validates every existing row, so the
    // object-shaped questions the tests above wrote make the rollback FAIL
    // outright. That is the documented behaviour (see the down-migration
    // header) and the reason this change is free only while the bank is empty.
    await postgres.client.query(`delete from questions`);

    await run(readDownMigration('0003_misconception_object.down.sql', 'superseded'));

    // Rolled back: the array is legal again and the object is not.
    await expect(insertWithCodes(chapterId, 1, ['a', 'b', 'c'])).resolves.toBeUndefined();
    await expect(insertWithCodes(chapterId, 1, { '0': 'a', '2': 'b', '3': 'c' })).rejects.toThrow(
      /questions_distractor_misconceptions_check/,
    );

    // The comment is restored too, not left describing a shape that no longer
    // applies. A stale comment on this column is worse than none.
    const description = await postgres.client.query<{ description: string }>(
      `select col_description('questions'::regclass, attnum) as description
         from pg_attribute
        where attrelid = 'questions'::regclass and attname = 'distractor_misconceptions'`,
    );
    expect(description.rows[0]?.description).toContain('SKIPPING correct_index');

    // Forward again. The rows written while rolled back hold the ARRAY shape
    // and would fail the object constraint, so they are cleared first — which
    // is precisely the data migration this change avoids by landing before the
    // bank is authored (see the down-migration header).
    await postgres.client.query(`delete from questions where chapter_id = $1`, [chapterId]);
    await run(readMigration('0003_misconception_object.sql', 'superseded'));

    await expect(
      insertWithCodes(chapterId, 1, { '0': 'a', '2': 'b', '3': 'c' }),
    ).resolves.toBeUndefined();
  }, 120_000);
});
