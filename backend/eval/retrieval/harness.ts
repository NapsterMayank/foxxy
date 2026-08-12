import { createSystemClock } from '../../src/platform/clock/index';
import { createDbPools, type DbPools } from '../../src/platform/db/index';
import { createLogger } from '../../src/platform/logger/index';
import { createDeterministicEmbed, type EmbeddingProvider } from '../../src/platform/embed/index';
import {
  createRetrievalModule,
  type RetrievalResult,
  type RetrievalService,
  type RetrievedChunkRecord,
} from '../../src/modules/retrieval/index';
import type { ScoreSample } from '../../src/modules/retrieval/index';
import type { GoldenQuestion } from './golden/types';

/**
 * =============================================================================
 * THE EVAL HARNESS — the half of calibration that needs the world.
 *
 * The ARITHMETIC lives in `src/modules/retrieval/domain/calibration.ts`, is
 * pure, and is unit tested today. This file is what connects it to a real
 * database, real chunks and (when a key exists) real query embeddings.
 *
 * It reads the corpus and nothing else. There is no write path in this
 * directory, deliberately: the development database holds an import that took a
 * day to obtain, and an eval harness is exactly the kind of tool that acquires
 * a `--reset` flag one afternoon.
 * =============================================================================
 */

export interface HarnessOptions {
  readonly databaseUrl: string;
  readonly embed: EmbeddingProvider;
  /** Defaults to 3 — §8.4's launch N. The sweep raises it. */
  readonly topN?: number;
}

export interface Harness {
  readonly service: RetrievalService;
  readonly pools: DbPools;
  close(): Promise<void>;
}

/**
 * Builds the module against the REAL database, wired the way `app/routes.ts`
 * will wire it: the `ai` pool, `hnsw.ef_search` from the same default the
 * application uses, and `getChunksByIds` bound to a hydration query.
 *
 * The configuration is passed in rather than read from `platform/config`
 * because that module requires the full production environment — CORS origins,
 * a session cookie name, a Redis URL — none of which an offline read-only
 * measurement has any business demanding.
 */
export function createHarness(options: HarnessOptions): Harness {
  const pools = createDbPools({
    url: options.databaseUrl,
    ssl: false,
    // D-238 — verification is on by default now; this URL is plaintext anyway.
    sslCa: null,
    sslInsecure: false,
    // D-228 — the per-process budget. 'api' here because nothing in this
    // file claims a job, and the ceiling is deliberately above the sum so
    // the sizes below are what actually gets opened.
    role: 'api',
    maxConnections: 100,
    sizes: { auth: 1, core: 2, ai: 4, worker: 1 },
    statementTimeoutMs: 30_000,
    vectorStatementTimeoutMs: 30_000,
    connectTimeoutMs: 5_000,
    // The same 100 the application ships (D-049). Hardcoding a different value
    // here would calibrate a threshold against a retriever nobody runs.
    hnswEfSearch: 100,
  });

  const readChunks = async (ids: readonly string[]): Promise<RetrievedChunkRecord[]> => {
    if (ids.length === 0) return [];
    const result = await pools.core.pool.query<{
      id: string;
      chapter_id: string | null;
      chunk_text: string;
      chunk_index: number;
      grade: string;
      subject: string;
      chapter_number: number | null;
      chapter_title: string | null;
      topic: string | null;
      concept: string | null;
      language: string | null;
      quality_score: number | null;
    }>(
      `select id, chapter_id, chunk_text, chunk_index, grade, subject, chapter_number,
              chapter_title, topic, concept, language, quality_score
         from rag_chunks
        where id = any($1::uuid[]) and is_active`,
      [[...ids]],
    );
    return result.rows.map((row) => ({
      id: row.id,
      chapterId: row.chapter_id,
      chunkText: row.chunk_text,
      chunkIndex: row.chunk_index,
      grade: row.grade as RetrievedChunkRecord['grade'],
      subject: row.subject,
      chapterNumber: row.chapter_number,
      chapterTitle: row.chapter_title,
      topic: row.topic,
      concept: row.concept,
      language: row.language ?? 'en',
      qualityScore: row.quality_score,
    }));
  };

  const { service } = createRetrievalModule({
    db: pools.ai,
    embed: options.embed,
    readChunks,
    clock: createSystemClock(),
    // `error` so a 70-question run prints its report and not 70 debug lines.
    logger: createLogger({ level: 'error', env: 'eval' }),
  });

  return {
    service,
    pools,
    close: () => pools.close(),
  };
}

export interface ScoredQuestion {
  readonly question: GoldenQuestion;
  readonly result: RetrievalResult;
}

/**
 * Scores a golden set, SEQUENTIALLY.
 *
 * Not `Promise.all`: 70 concurrent embed calls is a rate-limit response from
 * Voyage, and a rate-limited call that retries produces a latency number in the
 * trace that describes the harness rather than the pipeline.
 */
export async function scoreSet(
  service: RetrievalService,
  questions: readonly GoldenQuestion[],
  topN: number,
): Promise<ScoredQuestion[]> {
  const scored: ScoredQuestion[] = [];
  for (const question of questions) {
    const result = await service.search(question.query, {
      grade: question.grade,
      subject: question.subject,
      topN,
    });
    scored.push({ question, result });
  }
  return scored;
}

/** The shape `calibrate()` consumes. */
export function toSamples(scored: readonly ScoredQuestion[]): ScoreSample[] {
  return scored.map((entry) => ({
    query: entry.question.query,
    topFusedScore: entry.result.trace.topFusedScore,
  }));
}

/**
 * The embedding provider the harness will use, and the reason a run without a
 * key must FAIL rather than fall back.
 *
 * `createDeterministicEmbed` produces reproducible vectors with NO SEMANTICS.
 * Calibrating against it would produce two distributions that differ only by
 * chance, a threshold placed between two noise clouds, and a `MEASURED`
 * provenance block full of real-looking numbers that mean nothing. That is a
 * strictly worse outcome than having no threshold, because it cannot be
 * spotted by reading the constant.
 *
 * So: the calibration entry point REFUSES to run without `VOYAGE_API_KEY`. The
 * fake is exported only for the sparse-only probe, which does not embed at all.
 */
export { createDeterministicEmbed };
