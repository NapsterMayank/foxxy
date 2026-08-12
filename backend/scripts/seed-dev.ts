/**
 * Seeds a development database with a small, realistic content set.
 *
 * Run with `npm run db:seed` AFTER `npm run db:migrate`.
 *
 * WHY THIS EXISTS: the real NCERT corpus is not available yet — PROGRESS.md §2
 * has it blocked on credentials for the existing Supabase project, and nine of
 * the eleven remaining backend modules sit behind it. Without seed data the
 * only options are to stop, or to build `retrieval`, `practice` and `foxy`
 * against an empty database and discover on import day whether any of it
 * works. This is the third option.
 *
 * WHAT IT IS NOT: a substitute for the corpus. The embeddings are
 * deterministic synthetic vectors (see `tests/fixtures/embedding.ts`) that
 * carry no meaning, so this data exercises the PLUMBING — the pgvector column,
 * the HNSW index, the distance operator, the hybrid fusion arithmetic — and
 * says nothing whatever about retrieval QUALITY. In particular the abstention
 * threshold in plan §8.4 must be measured against the real corpus. A threshold
 * calibrated against these vectors would be a number with the shape of a
 * measurement and none of the content.
 *
 * IT BUILDS THROUGH THE TEST FIXTURE FACTORIES ON PURPOSE. Seed data written
 * separately drifts from test data, and the drift surfaces as a developer
 * hitting a constraint violation that no test reproduces. One set of factories
 * means the CHECK constraints are satisfied in exactly one place.
 *
 * Idempotent: it removes what it previously seeded, then re-inserts.
 */
import { createDb } from '../src/platform/db/index';
import { config } from '../src/platform/config/index';
import {
  insertChapter,
  insertQuestion,
  insertRagChunk,
  makeChapter,
  makeQuestion,
  makeRagChunk,
  type SqlRunner,
} from '../tests/fixtures/index';
import type { BloomLevel, Difficulty, Grade } from '../src/shared/constants/curriculum';

const GRADE: Grade = '8';
const SUBJECTS = ['science', 'maths'] as const;
const CHAPTERS_PER_SUBJECT = 3;
const QUESTIONS_PER_CHAPTER = 20;
const CHUNKS_PER_CHAPTER = 30;

/**
 * ~30% of each chapter's questions are reserved as check-only (PROGRESS.md §8).
 *
 * 6 of 20 here. The reserve is seeded rather than left to the practice module
 * because a held-out pool that is created "later" is created after the bank
 * has already been served, and by then every question in it is contaminated.
 *
 * PROGRESS.md §8 attaches a precondition worth repeating: before committing to
 * 30% against the REAL bank, count questions per chapter. If the median is
 * under 15, reserving 30% leaves practice too thin and more questions have to
 * be authored first.
 */
const HELD_OUT_PER_CHAPTER = 6;

const CHAPTER_TITLES: Readonly<Record<(typeof SUBJECTS)[number], readonly string[]>> = {
  science: ['Force and Pressure', 'Friction', 'Sound'],
  maths: ['Rational Numbers', 'Linear Equations', 'Understanding Quadrilaterals'],
};

const CHAPTER_TITLES_HI: Readonly<Record<(typeof SUBJECTS)[number], readonly string[]>> = {
  science: ['बल तथा दाब', 'घर्षण', 'ध्वनि'],
  maths: ['परिमेय संख्याएँ', 'रैखिक समीकरण', 'चतुर्भुजों को समझना'],
};

const DIFFICULTY_CYCLE: readonly Difficulty[] = ['easy', 'easy', 'medium', 'medium', 'hard'];
const BLOOM_CYCLE: readonly BloomLevel[] = [
  'remember',
  'understand',
  'apply',
  'analyse',
  'evaluate',
  'create',
];

function pick<T>(cycle: readonly T[], index: number): T {
  const value = cycle[index % cycle.length];
  if (value === undefined) throw new Error('empty cycle');
  return value;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Removes anything a previous run seeded.
 *
 * `practice_responses` (renamed from `question_responses` by migration 0002,
 * D-057) is cleared FIRST and explicitly. Its question foreign key is ON DELETE
 * RESTRICT, so deleting the chapters would otherwise fail with a constraint
 * error that reads like a bug in this script rather than like the deliberate
 * protection it is. Its own session foreign key CASCADES, so the sessions go
 * with it and need no separate statement.
 */
async function clearPreviousSeed(sql: SqlRunner): Promise<void> {
  await sql.query(
    `delete from practice_responses
      where question_id in (
        select q.id from questions q
        join chapters c on c.id = q.chapter_id
        where c.grade = $1 and c.subject_code = any($2::text[])
      )`,
    [GRADE, [...SUBJECTS]],
  );
  await sql.query(`delete from rag_chunks where grade = $1 and subject = any($2::text[])`, [
    GRADE,
    [...SUBJECTS],
  ]);
  // Questions cascade from chapters.
  await sql.query(`delete from chapters where grade = $1 and subject_code = any($2::text[])`, [
    GRADE,
    [...SUBJECTS],
  ]);
}

async function seed(sql: SqlRunner): Promise<void> {
  await clearPreviousSeed(sql);

  let chapterCount = 0;
  let questionCount = 0;
  let heldOutCount = 0;
  let chunkCount = 0;

  for (const subject of SUBJECTS) {
    for (let number = 1; number <= CHAPTERS_PER_SUBJECT; number += 1) {
      const titleEn = CHAPTER_TITLES[subject][number - 1] ?? `${subject} chapter ${number}`;
      const titleHi = CHAPTER_TITLES_HI[subject][number - 1] ?? null;

      const chapterId = await insertChapter(
        sql,
        makeChapter(`${subject}-${String(number)}`, {
          grade: GRADE,
          subjectCode: subject,
          chapterNumber: number,
          titleEn,
          titleHi,
        }),
      );
      chapterCount += 1;

      for (let q = 0; q < QUESTIONS_PER_CHAPTER; q += 1) {
        // The held-out reserve is the LAST slice rather than a random one, so
        // a re-run reserves exactly the same questions. A shifting reserve
        // would mean a question that was check-only yesterday is served today
        // — contaminating it, which is the failure the reserve exists to stop.
        const isHeldOut = q >= QUESTIONS_PER_CHAPTER - HELD_OUT_PER_CHAPTER;

        await insertQuestion(
          sql,
          chapterId,
          makeQuestion(`${subject}-${String(number)}-q${String(q)}`, {
            questionText: `[${titleEn}] Practice question ${String(q + 1)}?`,
            correctIndex: q % 4,
            difficulty: pick(DIFFICULTY_CYCLE, q),
            bloomLevel: pick(BLOOM_CYCLE, q),
            isHeldOut,
          }),
        );
        questionCount += 1;
        if (isHeldOut) heldOutCount += 1;
      }

      for (let c = 0; c < CHUNKS_PER_CHAPTER; c += 1) {
        await insertRagChunk(
          sql,
          makeRagChunk(`${subject}-${String(number)}-c${String(c)}`, {
            grade: GRADE,
            subject,
            chapterNumber: number,
            chapterTitle: titleEn,
            topic: titleEn,
            concept: `${titleEn} — concept ${String(c + 1)}`,
            chunkIndex: c,
            chunkText: `${titleEn}: passage ${String(c + 1)}. Synthetic development text standing in for NCERT content until the corpus import lands.`,
          }),
          chapterId,
        );
        chunkCount += 1;
      }
    }
  }

  log(
    `Seeded ${String(chapterCount)} chapters, ${String(questionCount)} questions ` +
      `(${String(heldOutCount)} held out, ${String(Math.round((heldOutCount / questionCount) * 100))}%), ` +
      `${String(chunkCount)} chunks.`,
  );
  log('Embeddings are SYNTHETIC. Do not calibrate retrieval thresholds against them.');
}

async function main(): Promise<void> {
  if (config.env === 'production') {
    throw new Error('seed-dev refuses to run against NODE_ENV=production.');
  }

  const handle = createDb(config.db);
  try {
    await seed(handle.pool);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Seed failed: ${message}\n`);
  process.exit(1);
});
