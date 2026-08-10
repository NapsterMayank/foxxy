/**
 * THE CORPUS IMPORT. Streams `.corpus-extract/` into local Postgres.
 *
 * Run with `npm run db:import-corpus`, after `npm run db:migrate`.
 *
 * ===========================================================================
 * WHAT THIS FILE IS AND IS NOT.
 *
 * It is the WRITING half. Every DECISION — normalisation, chapter derivation,
 * which questions are eligible, which are held out, what counts as ready — is
 * made by `src/shared/corpus/`, which is pure, tested, and has no idea a
 * database exists. This file reads files, calls `buildStreamedImportPlan`, and
 * writes rows. If you find yourself adding an `if` here that decides something
 * about the CONTENT, it belongs in the shared layer.
 *
 * ===========================================================================
 * THREE PROPERTIES THIS SCRIPT HAS TO HAVE, AND HOW EACH IS OBTAINED.
 *
 * (1) IT MUST NOT LOAD 66 MB OF EMBEDDINGS INTO MEMORY.
 *
 *     `chunks.ndjson` is 4,686 rows of 1,024 floats. Parsed whole that is
 *     several hundred megabytes of JavaScript numbers before a single row is
 *     written. So the chunk file is read TWICE, a line at a time:
 *
 *       pass 1 — derive the chapter set. Keeps only a summary per chunk
 *                (chapter key, title, index): no vector survives the pass.
 *       pass 2 — insert. One row's vector is resident at a time, batched into
 *                multi-row INSERTs.
 *
 *     Two passes over a 66 MB file cost about a second. The alternative — one
 *     pass, buffering — costs the memory this design exists to avoid. The other
 *     four files total 6.6 MB and are read whole, because nothing is gained by
 *     streaming them.
 *
 * (2) RUNNING IT TWICE MUST PRODUCE AN IDENTICAL DATABASE.
 *
 *     `questions` and `rag_chunks` have random-uuid primary keys and no source
 *     column, so a plain INSERT duplicates the corpus on every re-run. Every id
 *     here is instead a deterministic UUIDv5 of the source id
 *     (`shared/corpus/deterministic-id.ts`), written with `ON CONFLICT (id) DO
 *     UPDATE`. Combined with the plan being a pure function of the extract,
 *     that makes the second run a no-op that rewrites the same values.
 *
 *     RECONCILIATION, not just upsert: rows in a content table that are NOT in
 *     the extract are DELETED. That is what removes `db:seed`'s 6 chapters, 120
 *     questions and 180 synthetic chunks without anybody having to remember to
 *     run `db:clear-content` first — and it is also what stops a shrinking
 *     extract leaving orphans behind.
 *
 * (3) THE HELD-OUT RESERVE MUST NEVER SHRINK.
 *
 *     `held-out-reserve.ts` is monotonic only if it is TOLD what is already
 *     reserved. So the existing reserve is read out of the database BEFORE the
 *     transaction opens and passed into the plan, and the SQL says
 *     `is_held_out = questions.is_held_out or excluded.is_held_out` so that even
 *     a plan built without it cannot un-reserve a question. Two independent
 *     guards, because un-serving a question is impossible: once practice has
 *     shown it, it can never measure anything again.
 *
 * ===========================================================================
 * ONE TRANSACTION. All of it, including the index rebuild.
 *
 * A half-imported corpus is worse than none: chapters with no questions read as
 * a content gap rather than as a failed import, and the reserve would be
 * recorded over a bank that is not all there. 70 MB of write-ahead log is a
 * cheap price for "it either all landed or none of it did".
 */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  buildStreamedImportPlan,
  planChunk,
  summariseChunk,
  type ChunkChapterSummary,
  type PlannedChunk,
  type StreamedImportPlan,
} from '../src/shared/corpus/import-plan';
import { corpusId } from '../src/shared/corpus/deterministic-id';
import { parseVectorText, toVectorText } from '../src/shared/corpus/vector-text';
import { countByReason } from '../src/shared/corpus/question-eligibility';
import { allHeldOutIds } from '../src/shared/corpus/held-out-reserve';
import type {
  SourceChapterConcept,
  SourceChunk,
  SourceConceptEdge,
  SourceMisconception,
  SourceQuestion,
} from '../src/shared/corpus/source-shapes';
import type { ChapterKeyRejection } from '../src/shared/corpus/normalise';

const DEFAULT_EXTRACT_DIR = resolve(process.cwd(), '.corpus-extract');

/**
 * WHERE THE EXTRACT IS, AS AN ARGUMENT RATHER THAN A CONSTANT.
 *
 * `.corpus-extract/` is 77 MB and gitignored, so it exists on exactly one
 * machine. A test that could only run against it would be a test that never
 * runs in CI — and "the import is covered" would be a claim resting on a
 * directory nobody else has. The directory is therefore a parameter:
 * `corpus-import.test.ts` drives this same code over a small synthetic extract
 * it writes itself, and `corpus-import-real.test.ts` drives it over the real
 * one when it happens to be present.
 */
export interface ImportPaths {
  readonly extractDir: string;
  readonly reportDir: string;
}

function pathsFor(extractDir: string = DEFAULT_EXTRACT_DIR): ImportPaths {
  return { extractDir, reportDir: resolve(extractDir, 'reports') };
}

/** Rows per multi-row INSERT. 100 × ~20 columns is well inside the 65,535 parameter ceiling. */
const CHUNK_BATCH = 100;
const ROW_BATCH = 500;

/**
 * Raised only for the HNSW build, and only for that transaction.
 *
 * pgvector builds the graph in memory when it fits and spills to disk when it
 * does not, and the spilled build is many times slower. 4,686 × 1,024 float4 is
 * ~19 MB of vectors, so 256 MB is ample headroom for the graph on top. `SET
 * LOCAL`, so the connection returns to the server default afterwards — and
 * deliberately not `SET`, which would leave a 256 MB setting on a pooled
 * connection for whatever ran next.
 */
const HNSW_BUILD_WORK_MEM = '256MB';

interface ChunkStreamOutcome {
  readonly summaries: readonly ChunkChapterSummary[];
  readonly rejected: readonly { readonly id: string; readonly reason: ChapterKeyRejection }[];
  readonly withoutEmbedding: readonly string[];
  /** Our deterministic ids for every chunk pass 1 accepted — the reconcile keep-list. */
  readonly importedIds: readonly string[];
  readonly linesRead: number;
}

/** Reads an NDJSON file a line at a time, yielding parsed rows. */
async function* readNdjson<T>(paths: ImportPaths, fileName: string): AsyncGenerator<T> {
  const stream = createReadStream(resolve(paths.extractDir, fileName), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) {
      continue;
    }
    try {
      yield JSON.parse(line) as T;
    } catch (error: unknown) {
      // Naming the line is the difference between a fixable report and a
      // 66 MB file somebody has to bisect by hand.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${fileName} line ${String(lineNumber)} is not valid JSON: ${message}`);
    }
  }
}

async function readAll<T>(paths: ImportPaths, fileName: string): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of readNdjson<T>(paths, fileName)) {
    rows.push(row);
  }
  return rows;
}

/** Pass 1: derive the chapter set without keeping a single vector. */
async function streamChunkSummaries(paths: ImportPaths): Promise<ChunkStreamOutcome> {
  const summaries: ChunkChapterSummary[] = [];
  const rejected: { readonly id: string; readonly reason: ChapterKeyRejection }[] = [];
  const withoutEmbedding: string[] = [];
  const importedIds: string[] = [];
  let linesRead = 0;

  for await (const row of readNdjson<SourceChunk>(paths, 'chunks.ndjson')) {
    linesRead += 1;
    const outcome = planChunk(row);
    if (!outcome.ok) {
      rejected.push({ id: row.id, reason: outcome.reason });
      continue;
    }

    // The vector is read only to CLASSIFY it here — parsed, width-checked, and
    // dropped. Pass 2 parses it again for the insert. Parsing twice is the
    // price of not holding 4,666 of them at once.
    const parsed = parseVectorText(row.embedding);
    if (!parsed.ok) {
      throw new Error(`chunk ${row.id}: ${parsed.reason}`);
    }
    if (parsed.vector === null) {
      withoutEmbedding.push(row.id);
    }

    importedIds.push(corpusId('chunk', row.id));
    summaries.push(summariseChunk(outcome.chunk));
  }

  return { summaries, rejected, withoutEmbedding, importedIds, linesRead };
}

function chapterIdOf(chapterKey: string): string {
  return corpusId('chapter', chapterKey);
}

/** A multi-row INSERT ... ON CONFLICT, built from a column list and rows of values. */
async function insertBatch(
  client: pg.ClientBase,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  onConflict: string,
  casts: Readonly<Record<string, string>> = {},
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const row of rows) {
    const placeholders = row.map((value, index) => {
      values.push(value);
      const cast = casts[columns[index] ?? ''];
      return cast === undefined ? `$${String(values.length)}` : `$${String(values.length)}::${cast}`;
    });
    tuples.push(`(${placeholders.join(', ')})`);
  }

  await client.query(
    `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')} ${onConflict}`,
    values,
  );
}

/**
 * Deletes every row of `table` whose id is not in `keepIds`.
 *
 * Via a TEMP TABLE rather than `id <> all($1::uuid[])`, because the keep list
 * runs to 4,686 entries and an unindexed array scan per row turns a delete into
 * a quadratic one. `on commit drop` ties the temp table's life to the import's
 * transaction, so a failed import leaves nothing behind.
 */
async function reconcileDelete(
  client: pg.ClientBase,
  table: string,
  keepIds: readonly string[],
): Promise<number> {
  const temp = `keep_${table}`;
  await client.query(`create temp table ${temp} (id uuid primary key) on commit drop`);

  for (let index = 0; index < keepIds.length; index += ROW_BATCH) {
    const slice = keepIds.slice(index, index + ROW_BATCH);
    await insertBatch(
      client,
      temp,
      ['id'],
      slice.map((id) => [id]),
      'on conflict do nothing',
      { id: 'uuid' },
    );
  }

  const { rowCount } = await client.query(
    `delete from ${table} t where not exists (select 1 from ${temp} k where k.id = t.id)`,
  );

  return rowCount ?? 0;
}

interface ImportCounts {
  readonly chapters: number;
  readonly chunks: number;
  readonly questions: number;
  readonly concepts: number;
  readonly conceptEdges: number;
  readonly misconceptions: number;
  readonly heldOut: number;
  readonly deleted: Readonly<Record<string, number>>;
}

async function writeRows(
  client: pg.ClientBase,
  plan: StreamedImportPlan,
): Promise<Omit<ImportCounts, 'chunks'>> {
  const deleted: Record<string, number> = {};

  // ORDER: chapters first, because deleting a chapter cascades to its
  // questions, concepts and edges and nulls its chunks' `chapter_id`. Doing it
  // the other way round would delete rows twice and report the wrong numbers.
  deleted.chapters = await reconcileDelete(
    client,
    'chapters',
    plan.chapters.map((chapter) => chapterIdOf(chapter.chapterKey)),
  );

  await insertBatch(
    client,
    'chapters',
    ['id', 'grade', 'subject_code', 'chapter_number', 'title_en'],
    plan.chapters.map((chapter) => [
      chapterIdOf(chapter.chapterKey),
      chapter.chapter.grade,
      chapter.chapter.subject,
      chapter.chapter.chapterNumber,
      chapter.titleEn,
    ]),
    'on conflict (id) do update set title_en = excluded.title_en, updated_at = now()',
    { id: 'uuid' },
  );

  // Concepts, edges, misconceptions.
  deleted.chapter_concepts = await reconcileDelete(
    client,
    'chapter_concepts',
    plan.concepts.map((concept) => corpusId('concept', concept.sourceId)),
  );
  for (let index = 0; index < plan.concepts.length; index += ROW_BATCH) {
    await insertBatch(
      client,
      'chapter_concepts',
      [
        'id',
        'chapter_id',
        'concept_number',
        'slug',
        'title_en',
        'title_hi',
        'learning_objective',
        'explanation_en',
        'explanation_hi',
        'example_content',
        'key_formula',
        'common_mistakes',
      ],
      plan.concepts.slice(index, index + ROW_BATCH).map((concept) => [
        corpusId('concept', concept.sourceId),
        chapterIdOf(concept.chapterKey),
        concept.conceptNumber,
        concept.slug,
        concept.conceptName,
        concept.conceptNameHi,
        concept.learningObjective,
        concept.explanationEn,
        concept.explanationHi,
        concept.exampleContent,
        concept.keyFormula,
        JSON.stringify(concept.commonMistakes),
      ]),
      `on conflict (id) do update set
         chapter_id = excluded.chapter_id,
         concept_number = excluded.concept_number,
         slug = excluded.slug,
         title_en = excluded.title_en,
         title_hi = excluded.title_hi,
         learning_objective = excluded.learning_objective,
         explanation_en = excluded.explanation_en,
         explanation_hi = excluded.explanation_hi,
         example_content = excluded.example_content,
         key_formula = excluded.key_formula,
         common_mistakes = excluded.common_mistakes,
         updated_at = now()`,
      { id: 'uuid', chapter_id: 'uuid', common_mistakes: 'jsonb' },
    );
  }

  deleted.concept_graph = await reconcileDelete(
    client,
    'concept_graph',
    plan.conceptEdges.map((edge) => corpusId('edge', edge.sourceId)),
  );
  for (let index = 0; index < plan.conceptEdges.length; index += ROW_BATCH) {
    await insertBatch(
      client,
      'concept_graph',
      [
        'id',
        'chapter_id',
        'concept_code',
        'concept_name',
        'prerequisite_codes',
        'bloom_level',
        'cognitive_load',
      ],
      plan.conceptEdges.slice(index, index + ROW_BATCH).map((edge) => [
        corpusId('edge', edge.sourceId),
        chapterIdOf(edge.chapterKey),
        edge.conceptCode,
        edge.conceptName,
        [...edge.prerequisiteCodes],
        edge.bloomLevel,
        edge.cognitiveLoad,
      ]),
      `on conflict (id) do update set
         chapter_id = excluded.chapter_id,
         concept_code = excluded.concept_code,
         concept_name = excluded.concept_name,
         prerequisite_codes = excluded.prerequisite_codes,
         bloom_level = excluded.bloom_level,
         cognitive_load = excluded.cognitive_load,
         updated_at = now()`,
      { id: 'uuid', chapter_id: 'uuid', prerequisite_codes: 'text[]' },
    );
  }

  deleted.misconception_patterns = await reconcileDelete(
    client,
    'misconception_patterns',
    plan.misconceptions.map((pattern) => corpusId('misconception', pattern.sourceId)),
  );
  for (let index = 0; index < plan.misconceptions.length; index += ROW_BATCH) {
    await insertBatch(
      client,
      'misconception_patterns',
      [
        'id',
        'subject_code',
        'concept_code',
        'pattern_code',
        'description',
        'detection_rule',
        'remediation_strategy',
        'remediation_concept_codes',
        'severity',
        'is_orphan',
      ],
      plan.misconceptions.slice(index, index + ROW_BATCH).map((pattern) => [
        corpusId('misconception', pattern.sourceId),
        pattern.subject,
        pattern.conceptCode,
        pattern.patternCode,
        pattern.description,
        pattern.detectionRule === null ? null : JSON.stringify(pattern.detectionRule),
        pattern.remediationStrategy,
        [...pattern.remediationConceptCodes],
        pattern.severity,
        pattern.orphan,
      ]),
      `on conflict (id) do update set
         subject_code = excluded.subject_code,
         concept_code = excluded.concept_code,
         pattern_code = excluded.pattern_code,
         description = excluded.description,
         detection_rule = excluded.detection_rule,
         remediation_strategy = excluded.remediation_strategy,
         remediation_concept_codes = excluded.remediation_concept_codes,
         severity = excluded.severity,
         is_orphan = excluded.is_orphan,
         updated_at = now()`,
      {
        id: 'uuid',
        detection_rule: 'jsonb',
        remediation_concept_codes: 'text[]',
      },
    );
  }

  // Questions LAST of the small tables, because the reserve is applied with
  // them and the reserve is the one decision that cannot be taken back.
  const heldOut = new Set(allHeldOutIds(plan.reserves));

  deleted.questions = await reconcileDelete(
    client,
    'questions',
    plan.questions.map((question) => corpusId('question', question.sourceId)),
  );
  for (let index = 0; index < plan.questions.length; index += ROW_BATCH) {
    await insertBatch(
      client,
      'questions',
      [
        'id',
        'chapter_id',
        'question_text',
        'options',
        'correct_index',
        'explanation',
        'difficulty',
        'bloom_level',
        'is_held_out',
      ],
      plan.questions.slice(index, index + ROW_BATCH).map((question) => [
        corpusId('question', question.sourceId),
        chapterIdOf(
          `${question.chapter.grade}|${question.chapter.subject}|${String(question.chapter.chapterNumber)}`,
        ),
        question.questionText,
        JSON.stringify(question.options),
        question.correctIndex,
        question.explanation,
        question.difficulty,
        question.bloomLevel,
        heldOut.has(question.sourceId),
      ]),
      // `is_held_out` is OR-ed, never assigned. The plan is already monotonic
      // (it is given the current reserve), and this is the second, independent
      // guard: even a plan built with no knowledge of the existing reserve
      // cannot release a question that has been kept back from practice.
      `on conflict (id) do update set
         chapter_id = excluded.chapter_id,
         question_text = excluded.question_text,
         options = excluded.options,
         correct_index = excluded.correct_index,
         explanation = excluded.explanation,
         difficulty = excluded.difficulty,
         bloom_level = excluded.bloom_level,
         is_held_out = questions.is_held_out or excluded.is_held_out,
         updated_at = now()`,
      { id: 'uuid', chapter_id: 'uuid', options: 'jsonb' },
    );
  }

  return {
    chapters: plan.chapters.length,
    questions: plan.questions.length,
    concepts: plan.concepts.length,
    conceptEdges: plan.conceptEdges.length,
    misconceptions: plan.misconceptions.length,
    heldOut: heldOut.size,
    deleted,
  };
}

const CHUNK_COLUMNS = [
  'id',
  'chapter_id',
  'chunk_text',
  'chunk_index',
  'chunk_type',
  'board',
  'grade',
  'subject',
  'chapter_number',
  'chapter_title',
  'topic',
  'concept',
  'difficulty_level',
  'content_layer',
  'language',
  'embedding',
  'embedding_model',
  'word_count',
  'token_count',
  'quality_score',
  'is_active',
] as const;

const CHUNK_UPSERT = `on conflict (id) do update set
  chapter_id = excluded.chapter_id,
  chunk_text = excluded.chunk_text,
  chunk_index = excluded.chunk_index,
  chunk_type = excluded.chunk_type,
  board = excluded.board,
  grade = excluded.grade,
  subject = excluded.subject,
  chapter_number = excluded.chapter_number,
  chapter_title = excluded.chapter_title,
  topic = excluded.topic,
  concept = excluded.concept,
  difficulty_level = excluded.difficulty_level,
  content_layer = excluded.content_layer,
  language = excluded.language,
  embedding = excluded.embedding,
  embedding_model = excluded.embedding_model,
  word_count = excluded.word_count,
  token_count = excluded.token_count,
  quality_score = excluded.quality_score,
  is_active = excluded.is_active,
  updated_at = now()`;

/**
 * `search_vector` is ABSENT from `CHUNK_COLUMNS` and that is load-bearing.
 *
 * It is `GENERATED ALWAYS ... STORED` (D-040). Writing to it is not a mistake
 * Postgres tolerates — it is an error — but the more important point is why the
 * column is generated at all: a hand-maintained tsvector goes stale the first
 * time somebody edits `chunk_text` and forgets, and a stale tsvector does not
 * fail. The chunk simply stops appearing in keyword search, for ever, silently.
 */
function chunkValues(chunk: PlannedChunk, embedding: readonly number[] | null): unknown[] {
  return [
    corpusId('chunk', chunk.sourceId),
    chapterIdOf(chunk.chapterKey),
    chunk.chunkText,
    chunk.chunkIndex,
    chunk.chunkType,
    chunk.board,
    chunk.grade,
    chunk.subject,
    chunk.chapterNumber,
    chunk.chapterTitle,
    chunk.topic,
    chunk.concept,
    chunk.difficultyLevel,
    chunk.contentLayer,
    chunk.language,
    embedding === null ? null : toVectorText(embedding),
    chunk.embeddingModel,
    chunk.wordCount,
    chunk.tokenCount,
    chunk.qualityScore,
    chunk.isActive,
  ];
}

/** Pass 2: stream the chunk file again, inserting in batches. */
async function writeChunks(
  client: pg.ClientBase,
  paths: ImportPaths,
  keepIds: readonly string[],
): Promise<number> {
  await reconcileDelete(client, 'rag_chunks', keepIds);

  let written = 0;
  let batch: unknown[][] = [];

  const flush = async (): Promise<void> => {
    await insertBatch(client, 'rag_chunks', CHUNK_COLUMNS, batch, CHUNK_UPSERT, {
      id: 'uuid',
      chapter_id: 'uuid',
      embedding: 'vector',
    });
    written += batch.length;
    batch = [];
  };

  for await (const row of readNdjson<SourceChunk>(paths, 'chunks.ndjson')) {
    const outcome = planChunk(row);
    if (!outcome.ok) {
      continue;
    }

    const parsed = parseVectorText(row.embedding);
    if (!parsed.ok) {
      throw new Error(`chunk ${row.id}: ${parsed.reason}`);
    }

    batch.push(chunkValues(outcome.chunk, parsed.vector));
    if (batch.length >= CHUNK_BATCH) {
      await flush();
    }
  }

  await flush();

  return written;
}

/**
 * Drops the HNSW index, runs `build`, and recreates it from its OWN recorded
 * definition.
 *
 * Recreating from `pg_indexes.indexdef` rather than from a string written here
 * is the whole point: an index rebuilt from a hand-copied `create index` in a
 * script is an index that drifts from the migration the moment either is
 * edited, and nothing would notice — a differently-parameterised HNSW returns
 * slightly worse neighbours, which reads as a retrieval-quality problem.
 *
 * Building AFTER the rows are in, rather than inserting into a live index, is
 * the standard bulk-load shape: one graph build over 4,686 vectors instead of
 * 4,686 incremental insertions into a graph that is being rebalanced.
 */
async function rebuildVectorIndex(
  client: pg.ClientBase,
  build: () => Promise<number>,
): Promise<{ readonly written: number; readonly indexDef: string }> {
  const { rows } = await client.query<{ readonly indexdef: string }>(
    `select indexdef from pg_indexes where schemaname = 'public' and indexname = $1`,
    ['rag_chunks_embedding_hnsw'],
  );

  const indexDef = rows[0]?.indexdef;
  if (indexDef === undefined) {
    throw new Error(
      'rag_chunks_embedding_hnsw does not exist. Run `npm run db:migrate` before importing.',
    );
  }

  await client.query('drop index rag_chunks_embedding_hnsw');
  const written = await build();

  await client.query(`set local maintenance_work_mem = '${HNSW_BUILD_WORK_MEM}'`);
  await client.query(indexDef);

  return { written, indexDef };
}

interface Report {
  readonly generatedAt: string;
  readonly counts: ImportCounts;
  readonly manifestComparison: Readonly<Record<string, { source: number; imported: number }>>;
  readonly excludedQuestions: Readonly<Record<string, number>>;
  readonly chunksWithoutEmbedding: readonly string[];
  readonly chapterQuality: {
    readonly total: number;
    readonly reserveReady: number;
    readonly demoReady: number;
    readonly withPlaceholderTitle: number;
  };
}

interface SourceCounts {
  readonly chunks: number;
  readonly questions: number;
  readonly concepts: number;
  readonly conceptEdges: number;
  readonly misconceptions: number;
}

function writeReports(
  paths: ImportPaths,
  plan: StreamedImportPlan,
  counts: ImportCounts,
  source: SourceCounts,
): Report {
  mkdirSync(paths.reportDir, { recursive: true });

  // THE EXCLUDED QUESTIONS ARE A FILE, NOT A LOG LINE (question-eligibility.ts
  // header). A number in a log cannot be fed back into the regeneration job
  // that has to target exactly these ids.
  writeFileSync(
    resolve(paths.reportDir, 'excluded-questions.ndjson'),
    plan.excludedQuestions.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );

  writeFileSync(
    resolve(paths.reportDir, 'chunks-without-embedding.txt'),
    plan.chunksWithoutEmbedding.join('\n') + '\n',
    'utf8',
  );

  writeFileSync(
    resolve(paths.reportDir, 'chapter-readiness.ndjson'),
    plan.readiness.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );

  writeFileSync(
    resolve(paths.reportDir, 'held-out-reserve.ndjson'),
    [...plan.reserves.values()].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );

  const report: Report = {
    generatedAt: new Date().toISOString(),
    counts,
    // EVERY SOURCE FIGURE IS THE NUMBER OF LINES ACTUALLY READ, never a number
    // copied from `manifest.json`. Comparing the manifest to itself is the one
    // check that cannot fail, and it is the one that would have been written.
    manifestComparison: {
      chunks: { source: source.chunks, imported: counts.chunks },
      questions: { source: source.questions, imported: counts.questions },
      concepts: { source: source.concepts, imported: counts.concepts },
      conceptEdges: { source: source.conceptEdges, imported: counts.conceptEdges },
      misconceptions: { source: source.misconceptions, imported: counts.misconceptions },
    },
    excludedQuestions: countByReason(plan.excludedQuestions),
    chunksWithoutEmbedding: plan.chunksWithoutEmbedding,
    chapterQuality: {
      total: plan.chapters.length,
      reserveReady: plan.readiness.filter((entry) => entry.reserveReady).length,
      demoReady: plan.readiness.filter((entry) => entry.demoReady).length,
      withPlaceholderTitle: plan.chapters.filter((chapter) => chapter.titleIsPlaceholder).length,
    },
  };

  writeFileSync(resolve(paths.reportDir, 'import-report.json'), JSON.stringify(report, null, 2), 'utf8');

  return report;
}

export async function importCorpus(
  client: pg.ClientBase,
  extractDir: string = DEFAULT_EXTRACT_DIR,
): Promise<Report> {
  const paths = pathsFor(extractDir);
  const chunkStream = await streamChunkSummaries(paths);

  const [questions, concepts, conceptEdges, misconceptions] = await Promise.all([
    readAll<SourceQuestion>(paths, 'questions.ndjson'),
    readAll<SourceChapterConcept>(paths, 'concepts.ndjson'),
    readAll<SourceConceptEdge>(paths, 'concept-graph.ndjson'),
    readAll<SourceMisconception>(paths, 'misconceptions.ndjson'),
  ]);

  // READ THE EXISTING RESERVE BEFORE THE TRANSACTION. The reserve is monotonic
  // only when it is told what is already held out; called with nothing, a
  // second import over a chapter that has grown recomputes the reserve from
  // scratch and releases questions that have been kept back from practice.
  const { rows: reserved } = await client.query<{ readonly id: string }>(
    'select id::text as id from questions where is_held_out',
  );
  const reservedIds = new Set(reserved.map((row) => row.id));
  const alreadyHeldOut = new Set(
    questions.map((row) => row.id).filter((id) => reservedIds.has(corpusId('question', id))),
  );

  const plan = buildStreamedImportPlan(
    { questions, concepts, conceptEdges, misconceptions },
    chunkStream,
    { alreadyHeldOut },
  );

  await client.query('begin');
  let counts: ImportCounts;
  try {
    const small = await writeRows(client, plan);

    const { written } = await rebuildVectorIndex(client, async () =>
      writeChunks(client, paths, chunkStream.importedIds),
    );

    counts = { ...small, chunks: written };
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  }

  // ANALYZE outside the transaction: the planner statistics are not part of the
  // import's atomicity, and without them the first vector query on a table that
  // was empty a second ago is planned against a row estimate of zero.
  await client.query('analyze rag_chunks, questions, chapters, chapter_concepts');

  return writeReports(paths, plan, counts, {
    chunks: chunkStream.linesRead,
    questions: questions.length,
    concepts: concepts.length,
    conceptEdges: conceptEdges.length,
    misconceptions: misconceptions.length,
  });
}

async function main(): Promise<void> {
  // IMPORTED HERE, NOT AT THE TOP. `platform/config` validates the whole
  // environment and calls `process.exit(1)` when a variable is missing — which
  // is right for a server and wrong for a module the integration tests import
  // for its one exported function. A top-level import made loading this file
  // kill the test runner.
  const { config } = await import('../src/platform/config/index');
  const client = new pg.Client({ connectionString: config.db.url });
  await client.connect();
  try {
    const report = await importCorpus(client);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nReports written to ${pathsFor().reportDir}\n`);
  } finally {
    await client.end();
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Corpus import failed: ${message}\n`);
    process.exit(1);
  });
}
