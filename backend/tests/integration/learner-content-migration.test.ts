import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAllMigrations,
  listMigrations,
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';
import {
  cosineSimilarity,
  insertChapter,
  insertQuestion,
  insertRagChunk,
  insertStudent,
  insertUser,
  makeChapter,
  makeEmbedding,
  makeQuestion,
  makeRagChunk,
  makeStudent,
  toVectorLiteral,
} from '../fixtures/index';

/**
 * Migration 0002 — the `learner` and `content` schemas.
 *
 * Two things are proven here, and they are different things.
 *
 * FIRST, plan §4 rule 4: the migration applies, rolls back, and re-applies.
 * That is the bottom describe block.
 *
 * SECOND, and the larger half: THE CONSTRAINTS ACTUALLY REJECT BAD DATA. A
 * CHECK constraint that was never fired against a violation is indistinguishable
 * from a comment. Every one of these was written because the value it rejects
 * would otherwise have reached a student — a grade stored as an integer that
 * silently matches nothing, a question with three options that renders a broken
 * quiz, a mastery of 1.5 in a parent report.
 */

let postgres: TestPostgres;

async function run(sql: string): Promise<void> {
  for (const statement of splitStatements(sql)) {
    await postgres.client.query(statement);
  }
}

async function tableNames(): Promise<string[]> {
  const result = await postgres.client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

let emailCounter = 0;
async function freshStudent(grade: '6' | '7' | '8' | '9' | '10' | '11' | '12' = '8'): Promise<string> {
  emailCounter += 1;
  const userId = await insertUser(postgres.client, `student${emailCounter}@example.test`);
  return insertStudent(postgres.client, userId, makeStudent(`s${emailCounter}`, { grade }));
}

beforeAll(async () => {
  postgres = await startTestPostgres();
  await applyAllMigrations(postgres.client);
/**
 * `0002_practice` COMES OFF FIRST — the D-106 rule, one migration later.
 *
 * This harness applies the CURRENT migration set, whose newest member renames
 * `question_responses` to `practice_responses` (D-057). Everything below is
 * about the world BEFORE that rename — it exercises the superseded 0004-0008
 * chain, which names the old table throughout and which cannot be edited.
 *
 * Peeling the newer migration off is what a real rollback does, in the order a
 * real rollback does it. The alternatives are both worse: rewriting these
 * assertions to the new name would make them claim to test SQL that does not
 * mention it, and editing the superseded files would destroy the oracle
 * `baseline-collapse.test.ts` diffs the baseline against.
 */
  await run(readDownMigration('0002_practice.down.sql'));
}, 180_000);

afterAll(async () => {
  await postgres.stop();
}, 60_000);

describe('the migration list is discovered, never hardcoded', () => {
  /**
   * THIS TEST USED TO BE PART OF THE PROBLEM IT WAS WRITTEN TO PREVENT.
   *
   * It asserted `listMigrations()` against a literal list of eight filenames —
   * so every new migration made it red, and the fix was always to paste one more
   * string in. A test that has to be edited by every migration is a second
   * source of truth about which migrations exist, which is the exact defect
   * D-046, D-072 and D-075 are about, wearing the costume of the test that
   * guards against it.
   *
   * It now asserts the PROPERTIES that make discovery correct, all of which hold
   * for any number of migrations:
   *
   *   - every `.sql` file in the directory is returned, and nothing else;
   *   - the order is the journal's, which is the order Drizzle applies;
   *   - the numeric prefixes are contiguous from 0000, so a lost or duplicated
   *     journal entry is caught rather than silently skipped.
   *
   * `listMigrations()` itself throws when the directory and the journal disagree
   * — that is the mechanism. This is the test that the mechanism is real.
   */
  it('returns exactly the .sql files on disk', () => {
    const onDisk = readdirSync(resolve(process.cwd(), 'drizzle/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    expect([...listMigrations()].sort()).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it('returns them in journal order, contiguously numbered from 0000', () => {
    const indexes = listMigrations().map((name) => Number(name.slice(0, 4)));
    expect(indexes).toEqual(indexes.map((_, position) => position));
  });

  it('leaves the applied schema carrying tenancy, which every later table depends on', async () => {
    /**
     * ONE named assertion, deliberately, rather than the whole list.
     *
     * It used to name the two migration FILES that deliver tenancy — 0004 adds
     * `tenant_id`, 0008 makes it NOT NULL — and the collapse (D-091) broke it,
     * because those files are now `drizzle/_superseded/` and the live directory
     * holds one baseline. That break was the test telling the truth about
     * itself: naming a file was still a claim about which migrations exist, a
     * softer version of exactly the second source of truth this describe block
     * is about.
     *
     * So it asserts the OUTCOME instead — the harness left a database whose
     * `users.tenant_id` is present and NOT NULL. That is what the file names
     * were ever a proxy for, it holds for any arrangement of migrations, and it
     * fails for the real reason: a harness that skipped the tenancy DDL would
     * otherwise fail several layers away, in `createUser`, when Drizzle's
     * `.returning()` projected a column the database had never been given
     * (D-072).
     */
    const result = await postgres.client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'users' and column_name = 'tenant_id'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.is_nullable).toBe('NO');
  });
});

describe('0002_learner_content — forward', () => {
  it('creates the seven new tables alongside the six identity ones', async () => {
    // The foundation-hook migrations (0004-0007) add nine more: `tenants`, the
    // `schools`/`classes`/`class_enrolments` stub, `audit_log`,
    // `notifications`, `metrics_events`, `worker_heartbeats` and `jobs`, and
    // `0001_pedagogy` adds three: `chapter_concepts`, `concept_graph`,
    // `misconception_patterns`. They are asserted here rather than only in
    // their own suites because this is the one place that reads the WHOLE
    // applied schema, and a table that appears without anybody noticing is how
    // a stub becomes drift.
    expect(await tableNames()).toEqual([
      'audit_log',
      'chapter_concepts',
      'chapter_mastery',
      'chapters',
      'class_enrolments',
      'classes',
      'concept_graph',
      'email_verification_tokens',
      'jobs',
      'link_codes',
      'metrics_events',
      'misconception_patterns',
      'notifications',
      'parent_child_links',
      'password_reset_tokens',
      'question_responses',
      'questions',
      'rag_chunks',
      'schools',
      'sessions',
      'student_subjects',
      'students',
      'tenants',
      'users',
      'worker_heartbeats',
    ]);
  });

  it('stores every grade column as text, never as an integer', async () => {
    const result = await postgres.client.query<{ table_name: string; data_type: string }>(
      `select table_name, data_type from information_schema.columns
        where table_schema = 'public' and column_name = 'grade'
        order by table_name`,
    );
    // `classes` (migration 0005) is a STUB that nothing reads — and it is in
    // this list precisely because it is a stub. The temptation with a stub is
    // to leave the constraint off "until it is used"; plan §3's failure mode is
    // that an integer grade does not error, it silently matches nothing. A stub
    // typed more loosely than the table it will eventually join against is a
    // stub that imports bad data on its first day of real use.
    expect(result.rows).toEqual([
      { table_name: 'chapters', data_type: 'text' },
      { table_name: 'classes', data_type: 'text' },
      { table_name: 'rag_chunks', data_type: 'text' },
      { table_name: 'students', data_type: 'text' },
    ]);
  });

  it('gives rag_chunks.embedding exactly 1024 dimensions', async () => {
    // The width matches voyage-3 and the existing corpus exactly. Anything
    // else turns a straight import into a paid re-embedding run.
    const result = await postgres.client.query<{ type: string }>(
      `select format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
        where c.relname = 'rag_chunks' and a.attname = 'embedding'`,
    );
    expect(result.rows[0]?.type).toBe('vector(1024)');
  });

  it('creates the HNSW index with the chosen build parameters', async () => {
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'rag_chunks' and indexname = 'rag_chunks_embedding_hnsw'`,
    );
    const definition = result.rows[0]?.indexdef ?? '';
    expect(definition).toContain('USING hnsw');
    expect(definition).toContain('vector_cosine_ops');
    expect(definition).toContain("m='16'");
    expect(definition).toContain("ef_construction='128'");
  });

  it('leaves the HNSW index UNPARTITIONED while the filter index IS partial', async () => {
    // Deliberate asymmetry. A partial index cannot serve a query that omits
    // its predicate; the fallback for the filter index is a cheap sequential
    // scan of a small table, and the fallback for the vector index is a scan
    // of every embedding — which against the `ai` pool's 5s statement timeout
    // reads as an outage rather than a slow query.
    const result = await postgres.client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'rag_chunks'`,
    );
    const byName = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('rag_chunks_embedding_hnsw')).not.toContain('WHERE');
    expect(byName.get('rag_chunks_grade_subject_idx')).toContain('WHERE is_active');
  });

  it('indexes search_vector with GIN', async () => {
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'rag_chunks' and indexname = 'rag_chunks_search_vector_gin'`,
    );
    expect(result.rows[0]?.indexdef).toContain('USING gin');
  });

  it('keeps the keying rule for distractor_misconceptions in the database', async () => {
    // The rule lives in a column COMMENT as well as in the source, because the
    // person who needs it most is holding a psql prompt and cannot see the
    // TypeScript. Migration 0003 REPLACED this comment when the column stopped
    // being a positional array; a stale comment on this column is worse than
    // none, because the reader is about to hand-author codes against it.
    const result = await postgres.client.query<{ description: string }>(
      `select col_description('questions'::regclass, attnum) as description
         from pg_attribute
        where attrelid = 'questions'::regclass and attname = 'distractor_misconceptions'`,
    );
    expect(result.rows[0]?.description).toContain('KEYED BY OPTION INDEX');
    expect(result.rows[0]?.description).not.toContain('SKIPPING correct_index');
  });
});

describe('grades are strings — the CHECK constraints', () => {
  it('COERCES a bare integer 6 to the string "6" — the database cannot refuse it', async () => {
    // A finding, not a preference, and it moves where the second defence has
    // to live. Postgres has an ASSIGNMENT CAST from integer to text and
    // applies it silently, so `values (6)` is accepted and '6' is stored. The
    // column type cannot see the caller's mistake, and neither can the CHECK,
    // because by the time it runs the value is already text.
    //
    // The consequence for §8.2's "grade 6 as a number is rejected": that rule
    // is enforceable ONLY by the learner module's Zod contract. This test
    // exists so the limit is written down and asserted rather than assumed
    // away by someone reading the CHECK and concluding it is covered.
    const userId = await insertUser(postgres.client, 'int-grade@example.test');
    await postgres.client.query(
      `insert into students (user_id, display_name, grade) values ($1, 'X', 6)`,
      [userId],
    );
    const result = await postgres.client.query<{ grade: string }>(
      `select grade from students where user_id = $1`,
      [userId],
    );
    expect(result.rows[0]?.grade).toBe('6');
    expect(typeof result.rows[0]?.grade).toBe('string');
  });

  it('still rejects an out-of-range integer, so the VALUE domain holds either way', async () => {
    // The half the database CAN defend. However the caller typed it, a grade
    // the product does not serve never reaches the column.
    const userId = await insertUser(postgres.client, 'int-grade-5@example.test');
    await expect(
      postgres.client.query(
        `insert into students (user_id, display_name, grade) values ($1, 'X', 5)`,
        [userId],
      ),
    ).rejects.toThrow(/students_grade_check/);
  });

  it('accepts every grade from "6" to "12"', async () => {
    for (const grade of ['6', '7', '8', '9', '10', '11', '12'] as const) {
      await expect(freshStudent(grade)).resolves.toBeTruthy();
    }
  });

  it('rejects "5" — below the range the product serves', async () => {
    const userId = await insertUser(postgres.client, 'grade5@example.test');
    await expect(
      postgres.client.query(
        `insert into students (user_id, display_name, grade) values ($1, 'X', '5')`,
        [userId],
      ),
    ).rejects.toThrow(/students_grade_check/);
  });

  it('rejects "13" — above it', async () => {
    const userId = await insertUser(postgres.client, 'grade13@example.test');
    await expect(
      postgres.client.query(
        `insert into students (user_id, display_name, grade) values ($1, 'X', '13')`,
        [userId],
      ),
    ).rejects.toThrow(/students_grade_check/);
  });

  it('rejects "08" and "8 " — the near-misses a bulk import produces', async () => {
    for (const grade of ['08', '8 ']) {
      emailCounter += 1;
      const userId = await insertUser(postgres.client, `near${emailCounter}@example.test`);
      await expect(
        postgres.client.query(
          `insert into students (user_id, display_name, grade) values ($1, 'X', $2)`,
          [userId, grade],
        ),
      ).rejects.toThrow(/students_grade_check/);
    }
  });

  it('applies the same rule to chapters and rag_chunks', async () => {
    await expect(
      insertChapter(postgres.client, makeChapter('bad', { grade: '5' as never })),
    ).rejects.toThrow(/chapters_grade_check/);

    await expect(
      insertRagChunk(postgres.client, makeRagChunk('bad', { grade: '5' as never })),
    ).rejects.toThrow(/rag_chunks_grade_check/);
  });
});

describe('a question must have exactly four options — §8.3', () => {
  let chapterId: string;

  beforeEach(async () => {
    chapterId = await insertChapter(
      postgres.client,
      makeChapter(`opts-${String(Date.now())}-${String(Math.random())}`, {
        chapterNumber: (emailCounter += 1),
      }),
    );
  });

  it('accepts a well-formed four-option question', async () => {
    await expect(
      insertQuestion(postgres.client, chapterId, makeQuestion('good')),
    ).resolves.toBeTruthy();
  });

  it('REJECTS a question with three options', async () => {
    // The requirement §8.3 names. Enforced by Postgres, so the bulk import and
    // the 2am psql session are covered too, not just the validated code path.
    await expect(
      insertQuestion(
        postgres.client,
        chapterId,
        makeQuestion('three', { options: ['a', 'b', 'c'] }),
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('rejects a question with five options', async () => {
    await expect(
      insertQuestion(
        postgres.client,
        chapterId,
        makeQuestion('five', { options: ['a', 'b', 'c', 'd', 'e'] }),
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('rejects options that are a JSON object rather than an array', async () => {
    // This one caught a real defect. Written as `jsonb_typeof(x) = 'array' AND
    // jsonb_array_length(x) = 4`, the constraint produced the raw error
    // `cannot get array length of a non-array` instead of naming itself,
    // because POSTGRES DOES NOT GUARANTEE THE EVALUATION ORDER OF `AND`. The
    // constraint is a CASE now, which does guarantee it.
    await expect(
      postgres.client.query(
        `insert into questions (chapter_id, question_text, options, correct_index, explanation, difficulty, bloom_level)
           values ($1, 'q', '{"a":1,"b":2,"c":3,"d":4}'::jsonb, 0, 'e', 'easy', 'apply')`,
        [chapterId],
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('rejects an empty-string option', async () => {
    await expect(
      insertQuestion(
        postgres.client,
        chapterId,
        makeQuestion('empty', { options: ['a', '', 'c', 'd'] }),
      ),
    ).rejects.toThrow(/questions_options_check/);
  });

  it('REJECTS correct_index of 4 — one past the last option', async () => {
    await expect(
      insertQuestion(postgres.client, chapterId, makeQuestion('four', { correctIndex: 4 })),
    ).rejects.toThrow(/questions_correct_index_check/);
  });

  it('rejects a negative correct_index', async () => {
    await expect(
      insertQuestion(postgres.client, chapterId, makeQuestion('neg', { correctIndex: -1 })),
    ).rejects.toThrow(/questions_correct_index_check/);
  });

  it('accepts correct_index at both ends of the range', async () => {
    for (const correctIndex of [0, 3]) {
      await expect(
        insertQuestion(
          postgres.client,
          chapterId,
          makeQuestion(`edge${String(correctIndex)}`, { correctIndex }),
        ),
      ).resolves.toBeTruthy();
    }
  });
});

describe('the one-way doors', () => {
  let chapterId: string;

  beforeEach(async () => {
    chapterId = await insertChapter(
      postgres.client,
      makeChapter('doors', { chapterNumber: (emailCounter += 1) }),
    );
  });

  it('stores exactly three misconception codes, keyed by the wrong options', async () => {
    const id = await insertQuestion(
      postgres.client,
      chapterId,
      makeQuestion('mis', { correctIndex: 1 }),
    );
    const result = await postgres.client.query<{ codes: Record<string, string> }>(
      `select distractor_misconceptions as codes from questions where id = $1`,
      [id],
    );
    expect(Object.keys(result.rows[0]?.codes ?? {}).sort()).toEqual(['0', '2', '3']);
  });

  it('allows NULL, because the codes are authored later', async () => {
    // Absent is honest. A row of placeholder codes would be a silent claim to
    // have diagnosed something.
    await expect(
      insertQuestion(
        postgres.client,
        chapterId,
        makeQuestion('null', { distractorMisconceptions: null }),
      ),
    ).resolves.toBeTruthy();
  });

  it('defaults is_held_out to false, so reserving is always deliberate', async () => {
    const id = await insertQuestion(postgres.client, chapterId, makeQuestion('held'));
    const result = await postgres.client.query<{ is_held_out: boolean }>(
      `select is_held_out from questions where id = $1`,
      [id],
    );
    expect(result.rows[0]?.is_held_out).toBe(false);
  });

  it('indexes chapter, is_active and is_held_out together for the serving query', async () => {
    const result = await postgres.client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'questions' and indexname = 'questions_chapter_active_held_out_idx'`,
    );
    expect(result.rows[0]?.indexdef).toContain('chapter_id, is_active, is_held_out');
  });

  it('refuses to delete a question that has responses — the calibration record', async () => {
    // ON DELETE RESTRICT. Withdrawing a question is `is_active = false`;
    // deleting it destroys the evidence of how hard it really was.
    const studentId = await freshStudent();
    const questionId = await insertQuestion(postgres.client, chapterId, makeQuestion('resp'));
    await postgres.client.query(
      `insert into question_responses
         (student_user_id, question_id, selected_index, is_correct, time_spent_ms, authored_difficulty)
       values ($1, $2, 1, false, 4200, 'medium')`,
      [studentId, questionId],
    );

    await expect(
      postgres.client.query(`delete from questions where id = $1`, [questionId]),
    ).rejects.toThrow(/question_responses_question_id_questions_id_fk/);
  });

  it('takes a student’s responses with them when the account is deleted', async () => {
    const studentId = await freshStudent();
    const questionId = await insertQuestion(postgres.client, chapterId, makeQuestion('priv'));
    await postgres.client.query(
      `insert into question_responses
         (student_user_id, question_id, selected_index, is_correct, time_spent_ms, authored_difficulty)
       values ($1, $2, 0, true, 5000, 'easy')`,
      [studentId, questionId],
    );

    await postgres.client.query(`delete from users where id = $1`, [studentId]);

    const remaining = await postgres.client.query(
      `select 1 from question_responses where student_user_id = $1`,
      [studentId],
    );
    expect(remaining.rowCount).toBe(0);
  });

  it('rejects a selected_index of 4 on a response', async () => {
    const studentId = await freshStudent();
    const questionId = await insertQuestion(postgres.client, chapterId, makeQuestion('sel'));
    await expect(
      postgres.client.query(
        `insert into question_responses
           (student_user_id, question_id, selected_index, is_correct, time_spent_ms, authored_difficulty)
         values ($1, $2, 4, false, 1000, 'easy')`,
        [studentId, questionId],
      ),
    ).rejects.toThrow(/question_responses_selected_index_check/);
  });
});

describe('mastery is bounded to 0..1', () => {
  let chapterId: string;
  let studentId: string;

  beforeEach(async () => {
    chapterId = await insertChapter(
      postgres.client,
      makeChapter('mastery', { chapterNumber: (emailCounter += 1) }),
    );
    studentId = await freshStudent();
  });

  async function setMastery(score: string): Promise<void> {
    await postgres.client.query(
      `insert into chapter_mastery (student_user_id, chapter_id, mastery_score, attempts)
         values ($1, $2, $3, 1)`,
      [studentId, chapterId, score],
    );
  }

  it('REJECTS a mastery_score of 1.5', async () => {
    // §8.2 says the module clamps. The CHECK is what turns a clamping bug into
    // a loud failure instead of a 150% mastery in a parent report.
    await expect(setMastery('1.5')).rejects.toThrow(/chapter_mastery_score_check/);
  });

  it('rejects a negative mastery_score', async () => {
    await expect(setMastery('-0.1')).rejects.toThrow(/chapter_mastery_score_check/);
  });

  it('accepts both ends of the range exactly', async () => {
    await expect(setMastery('0')).resolves.toBeUndefined();
    await postgres.client.query(`delete from chapter_mastery where student_user_id = $1`, [
      studentId,
    ]);
    await expect(setMastery('1')).resolves.toBeUndefined();
  });

  it('rejects a negative attempt count', async () => {
    await expect(
      postgres.client.query(
        `insert into chapter_mastery (student_user_id, chapter_id, mastery_score, attempts)
           values ($1, $2, 0.5, -1)`,
        [studentId, chapterId],
      ),
    ).rejects.toThrow(/chapter_mastery_attempts_check/);
  });

  it('reads a student’s mastery through an index, not a sequential scan', async () => {
    // The property the "index on student_user_id" requirement was after. It is
    // already delivered by the composite primary key, whose leading column is
    // student_user_id, so a second index would cost writes and answer nothing
    // new. Asserting the PLAN pins the property rather than the mechanism.
    await setMastery('0.5');
    const result = await postgres.client.query<{ 'QUERY PLAN': string }>(
      `explain (costs off) select * from chapter_mastery where student_user_id = $1`,
      [studentId],
    );
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index (Only )?Scan/);
  });
});

describe('a chapter’s natural key is unique', () => {
  it('refuses a second chapter with the same grade, subject and number', async () => {
    const fixture = makeChapter('dup', { chapterNumber: 900 });
    await insertChapter(postgres.client, fixture);
    await expect(insertChapter(postgres.client, fixture)).rejects.toThrow(
      /chapters_grade_subject_number_unique/,
    );
  });

  it('allows the same number in a different subject', async () => {
    await insertChapter(postgres.client, makeChapter('a', { chapterNumber: 901 }));
    await expect(
      insertChapter(postgres.client, makeChapter('b', { chapterNumber: 901, subjectCode: 'maths' })),
    ).resolves.toBeTruthy();
  });
});

describe('rag_chunks — both halves of the hybrid retrieval pipeline', () => {
  let chapterId: string;

  beforeAll(async () => {
    chapterId = await insertChapter(
      postgres.client,
      makeChapter('rag', { chapterNumber: 800, subjectCode: 'science', grade: '8' }),
    );
    await insertRagChunk(
      postgres.client,
      makeRagChunk('photosynthesis', {
        chunkText:
          'Photosynthesis is the process by which green plants use sunlight to make their own food from carbon dioxide and water.',
        topic: 'Photosynthesis',
      }),
      chapterId,
    );
    await insertRagChunk(
      postgres.client,
      makeRagChunk('friction', {
        chunkText:
          'Friction is the force that opposes the relative motion of two surfaces in contact with each other.',
        topic: 'Friction',
        concept: 'Forces',
      }),
      chapterId,
    );
    await insertRagChunk(
      postgres.client,
      makeRagChunk('grade9-chunk', {
        chunkText: 'Newton’s second law relates force, mass and acceleration.',
        grade: '9',
        topic: 'Laws of motion',
      }),
      chapterId,
    );
  }, 60_000);

  it('generates search_vector without anyone writing to it', async () => {
    const result = await postgres.client.query<{ search_vector: string }>(
      `select search_vector from rag_chunks where topic = 'Photosynthesis'`,
    );
    // Stemmed and weighted: 'photosynthesi' is the English stem, weight A
    // because it appears in the topic.
    expect(result.rows[0]?.search_vector).toContain('photosynthesi');
  });

  it('REFUSES a direct write to search_vector', async () => {
    await expect(
      postgres.client.query(
        `update rag_chunks set search_vector = to_tsvector('english', 'tampered') where topic = 'Friction'`,
      ),
    ).rejects.toThrow(/can only be updated to DEFAULT/i);
  });

  it('recomputes search_vector when chunk_text changes', async () => {
    // The reason the column is generated at all. A hand-maintained tsvector
    // goes stale on the first forgotten update, and a stale tsvector does not
    // fail — the chunk simply stops appearing in keyword search, forever.
    const id = await insertRagChunk(
      postgres.client,
      makeRagChunk('stale-check', { chunkText: 'Original wording about magnets.', topic: null }),
      chapterId,
    );
    await postgres.client.query(
      `update rag_chunks set chunk_text = 'Replacement wording about electricity.' where id = $1`,
      [id],
    );
    const result = await postgres.client.query<{ search_vector: string }>(
      `select search_vector from rag_chunks where id = $1`,
      [id],
    );
    expect(result.rows[0]?.search_vector).toContain('electr');
    expect(result.rows[0]?.search_vector).not.toContain('magnet');
  });

  it('answers a FULL-TEXT query against a fixture chunk', async () => {
    const result = await postgres.client.query<{ topic: string }>(
      `select topic from rag_chunks
        where search_vector @@ plainto_tsquery('english', 'green plants sunlight food')
          and is_active
        order by ts_rank(search_vector, plainto_tsquery('english', 'green plants sunlight food')) desc`,
    );
    expect(result.rows[0]?.topic).toBe('Photosynthesis');
  });

  it('answers a VECTOR SIMILARITY query and ranks the seeded chunk first', async () => {
    // The synthetic embeddings are deterministic, so "nearest to the vector
    // seeded 'friction'" is a fact, not a coin toss.
    const probe = toVectorLiteral(makeEmbedding('friction'));
    const result = await postgres.client.query<{ topic: string; distance: number }>(
      `select topic, embedding <=> $1::vector as distance
         from rag_chunks
        where is_active and embedding is not null
        order by embedding <=> $1::vector
        limit 3`,
      [probe],
    );
    expect(result.rows[0]?.topic).toBe('Friction');
    expect(Number(result.rows[0]?.distance)).toBeCloseTo(0, 5);
  });

  it('keeps unrelated seeds near-orthogonal, so a similarity test can fail', () => {
    // A generator producing all-positive vectors would score every pair around
    // 0.75 and the test above could never distinguish anything.
    const similarity = cosineSimilarity(makeEmbedding('friction'), makeEmbedding('photosynthesis'));
    expect(Math.abs(similarity)).toBeLessThan(0.2);
  });

  it('hard-filters by grade: a grade 8 query never returns grade 9 content', async () => {
    // §8.4 step 3. The filter is the constraint the whole retrieval design
    // rests on, and it is applied here at the same layer the index serves.
    const probe = toVectorLiteral(makeEmbedding('grade9-chunk'));
    const result = await postgres.client.query<{ grade: string }>(
      `select grade from rag_chunks
        where is_active and grade = '8' and subject = 'science'
        order by embedding <=> $1::vector
        limit 5`,
      [probe],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.grade === '8')).toBe(true);
  });

  it('rejects an embedding of the wrong width', async () => {
    // 1024 is load-bearing: it is what voyage-3 produced for the existing
    // corpus, and it is why the import is a copy rather than a re-embedding.
    await expect(
      insertRagChunk(
        postgres.client,
        makeRagChunk('wrong-width', { embedding: makeEmbedding('x', 768) }),
      ),
    ).rejects.toThrow(/expected 1024 dimensions/);
  });

  it('keeps a chunk when its chapter is deleted, nulling the link', async () => {
    // ON DELETE SET NULL. A chunk whose chapter row goes away is still
    // retrievable content; losing it to a cascade would silently shrink the
    // corpus.
    const doomed = await insertChapter(
      postgres.client,
      makeChapter('doomed', { chapterNumber: 801 }),
    );
    const chunkId = await insertRagChunk(postgres.client, makeRagChunk('orphan'), doomed);
    await postgres.client.query(`delete from chapters where id = $1`, [doomed]);

    const result = await postgres.client.query<{ chapter_id: string | null }>(
      `select chapter_id from rag_chunks where id = $1`,
      [chunkId],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.chapter_id).toBeNull();
  });
});

describe('0002_learner_content — rollback', () => {
  it('drops every new table and re-applies cleanly', async () => {
    /**
     * `0001_pedagogy` COMES OFF FIRST, and that ordering is the point.
     *
     * This harness applies the CURRENT migration set, which now ends with
     * `0001_pedagogy` — three tables whose `chapter_id` references `chapters`.
     * 0002's own down migration therefore cannot drop `chapters`: Postgres
     * refuses with "other objects depend on it", which is exactly right and is
     * the reason a rollback is exercised at all.
     *
     * The tempting repair is `drop ... cascade` in 0002's down file. That would
     * silently delete a LATER migration's tables from inside an EARLIER
     * migration's rollback, and would keep doing so for every migration added
     * after it — the failure would move from a loud error here to no error
     * anywhere. Peeling the newer migration off first is what a real rollback
     * does, in the order a real rollback does it.
     */
    await run(readDownMigration('0001_pedagogy.down.sql'));
    await run(readDownMigration('0002_learner_content.down.sql', 'superseded'));

    const afterRollback = await tableNames();
    for (const table of [
      'students',
      'student_subjects',
      'chapter_mastery',
      'chapters',
      'questions',
      'rag_chunks',
      'question_responses',
    ]) {
      expect(afterRollback).not.toContain(table);
    }
    // The identity tables are untouched — a rollback that takes out migration
    // 0000 with it is not a rollback.
    expect(afterRollback).toContain('users');
    expect(afterRollback).toContain('link_codes');

    // Forward again on the rolled-back schema: a rollback that cannot be
    // followed by a re-apply is not a rollback.
    //
    // BOTH migrations, in order. 0002's down drops `questions` outright, so it
    // takes 0003's constraint with it and needs no separate rollback — but
    // re-applying only 0002 would leave this database holding the SUPERSEDED
    // positional-array constraint, which is a quietly wrong schema for
    // anything that runs afterwards.
    await run(readMigration('0002_learner_content.sql', 'superseded'));
    await run(readMigration('0003_misconception_object.sql', 'superseded'));
    // And 0001 back on top, in the order it came off.
    await run(readMigration('0001_pedagogy.sql'));
    expect(await tableNames()).toContain('rag_chunks');
    expect(await tableNames()).toContain('chapter_concepts');
  }, 120_000);
});
