/**
 * Fixture factories, plus the insert helpers that put them in a database.
 *
 * One entry point so a test writes a single import, and so
 * `scripts/seed-dev.ts` builds development data through EXACTLY the same
 * factories the tests use. That last part is deliberate: seed data that is
 * built separately drifts from test data, and the drift is discovered when a
 * developer hits a constraint violation that no test reproduces.
 */
export { makeChapter, makeQuestion, makeRagChunk, makeStudent, misconceptionsFor } from './content';
export type {
  ChapterFixture,
  QuestionFixture,
  RagChunkFixture,
  StudentFixture,
} from './content';
export { cosineSimilarity, makeEmbedding, toVectorLiteral } from './embedding';
export {
  insertChapter,
  insertQuestion,
  insertRagChunk,
  insertStudent,
  insertUser,
  type SqlRunner,
} from './insert';
