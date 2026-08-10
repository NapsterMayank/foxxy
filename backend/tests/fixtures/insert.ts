import type { ChapterFixture, QuestionFixture, RagChunkFixture, StudentFixture } from './content';
import { toVectorLiteral } from './embedding';

/**
 * Insert helpers for the fixtures.
 *
 * Structurally typed against `query`, so a `pg.Client`, a `pg.Pool` or a
 * transaction all satisfy it without this file importing the driver.
 */
export interface SqlRunner {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Narrowed rather than cast. `as { id: string }[]` would compile and then
 * return `undefined` as a string the moment a statement lost its RETURNING
 * clause, and the failure would surface several inserts later as a foreign key
 * violation pointing at the wrong table.
 */
function firstId(rows: readonly unknown[], what: string): string {
  const row = rows[0];
  if (row === null || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') {
    throw new Error(`insert of ${what} returned no id`);
  }
  return row.id;
}

/**
 * A `users` row, so a student profile has something to hang off.
 *
 * `password_hash` is a placeholder and the account CANNOT log in: producing a
 * real Argon2 hash here would make every fixture pay tens of milliseconds for
 * a credential no test uses. Anything testing authentication goes through the
 * identity harness, which owns that path.
 */
export async function insertUser(
  sql: SqlRunner,
  email: string,
  role: 'student' | 'parent' = 'student',
): Promise<string> {
  const result = await sql.query(
    `insert into users (email, password_hash, role, email_verified_at)
       values ($1, 'fixture$not-a-real-hash', $2, now())
       returning id`,
    [email, role],
  );
  return firstId(result.rows, 'users');
}

export async function insertStudent(
  sql: SqlRunner,
  userId: string,
  fixture: StudentFixture,
): Promise<string> {
  await sql.query(
    `insert into students (user_id, display_name, grade, board, preferred_language)
       values ($1, $2, $3, $4, $5)`,
    [
      userId,
      fixture.displayName,
      // Passed as the STRING it is. node-postgres would happily serialise a
      // number into the same wire form, which is why the module's Zod contract
      // — not this line — is what rejects a JSON number.
      fixture.grade,
      fixture.board,
      fixture.preferredLanguage,
    ],
  );
  return userId;
}

export async function insertChapter(sql: SqlRunner, fixture: ChapterFixture): Promise<string> {
  const result = await sql.query(
    `insert into chapters (grade, subject_code, chapter_number, title_en, title_hi, is_active)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
    [
      fixture.grade,
      fixture.subjectCode,
      fixture.chapterNumber,
      fixture.titleEn,
      fixture.titleHi,
      fixture.isActive,
    ],
  );
  return firstId(result.rows, 'chapters');
}

export async function insertQuestion(
  sql: SqlRunner,
  chapterId: string,
  fixture: QuestionFixture,
): Promise<string> {
  const result = await sql.query(
    `insert into questions (
        chapter_id, question_text, options, correct_index, explanation,
        difficulty, bloom_level, is_active, distractor_misconceptions, is_held_out
     ) values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10)
       returning id`,
    [
      chapterId,
      fixture.questionText,
      JSON.stringify(fixture.options),
      fixture.correctIndex,
      fixture.explanation,
      fixture.difficulty,
      fixture.bloomLevel,
      fixture.isActive,
      fixture.distractorMisconceptions === null
        ? null
        : JSON.stringify(fixture.distractorMisconceptions),
      fixture.isHeldOut,
    ],
  );
  return firstId(result.rows, 'questions');
}

/**
 * `search_vector` is NOT in this statement and must never be: the column is
 * GENERATED ALWAYS ... STORED, and naming it in an INSERT is an error. The
 * corpus import script has the same restriction — see the header of migration
 * 0002.
 */
export async function insertRagChunk(
  sql: SqlRunner,
  fixture: RagChunkFixture,
  chapterId: string | null = null,
): Promise<string> {
  const result = await sql.query(
    `insert into rag_chunks (
        chapter_id, chunk_text, chunk_index, chunk_type, board, grade, subject,
        chapter_number, chapter_title, topic, concept, difficulty_level,
        content_layer, language, embedding, embedding_model, embedded_at,
        word_count, token_count, quality_score, is_active
     ) values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15::vector, $16, now(),
        $17, $18, $19, $20
     ) returning id`,
    [
      chapterId,
      fixture.chunkText,
      fixture.chunkIndex,
      fixture.chunkType,
      fixture.board,
      fixture.grade,
      fixture.subject,
      fixture.chapterNumber,
      fixture.chapterTitle,
      fixture.topic,
      fixture.concept,
      fixture.difficultyLevel,
      fixture.contentLayer,
      fixture.language,
      toVectorLiteral(fixture.embedding),
      fixture.embeddingModel,
      fixture.wordCount,
      fixture.tokenCount,
      fixture.qualityScore,
      fixture.isActive,
    ],
  );
  return firstId(result.rows, 'rag_chunks');
}
