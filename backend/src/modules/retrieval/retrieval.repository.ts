import { sql } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import type { Grade, LanguageCode } from '@/shared/constants/curriculum';

/**
 * ALL database access for `retrieval` — §7, rule 4.
 *
 * ===========================================================================
 * THIS RUNS ON THE `ai` POOL, AND THAT IS NOT AN IMPLEMENTATION DETAIL.
 *
 * `content` reads the same `rag_chunks` table on `core`. The pool follows the
 * CALLER'S cost profile, not the table's owner (§3.1, D-045): an HNSW scan
 * under load holds its connection for a long time, and if it held a `core` one
 * then a chapter listing — then a progress screen, then everything — would
 * queue behind vector search.
 *
 * The `ai` pool is also where `hnsw.ef_search = 100` is applied, as a
 * CONNECTION PARAMETER (D-049). Without it pgvector caps an HNSW scan at 40
 * rows however large the LIMIT, so the top-50 below would silently return 40 —
 * which reads as a thin corpus rather than as a setting. Nothing in this file
 * sets it, deliberately: a module-level `SET` is one that the second query path
 * forgets, and the connection nobody accounted for is the one that
 * under-retrieves.
 *
 * ===========================================================================
 * BOTH QUERIES RETURN `chunk_text`, AND THAT IS A DELIBERATE COST.
 *
 * Fusion needs only ids. Deduplication needs the TEXT, because a quarter of the
 * corpus is exact-duplicate passages (D-108) and the only honest way to tell
 * two copies apart from two different passages is to compare what they say.
 * Doing the comparison in SQL (`md5(chunk_text)`) would be cheaper on the wire
 * and would put the normalisation rule in two places — one in Postgres, one in
 * TypeScript — which drift, and a drifted duplicate detector silently stops
 * detecting. One implementation, in `domain/deduplicate.ts`, at the cost of up
 * to 100 chunk bodies per query.
 *
 * WHAT IS NOT RETURNED: the embedding. Fifty 1024-float arrays is several
 * megabytes per query for data nothing downstream reads.
 */

export type RetrievalDbHandle = DbHandle;

export interface SearchFilter {
  readonly grade: Grade;
  readonly subject: string;
  readonly limit: number;
}

export interface CandidateRow {
  readonly id: string;
  readonly chunkText: string;
  /**
   * Raw, from whichever half produced it. Cosine DISTANCE for dense (lower is
   * better), `ts_rank` for sparse (higher is better). Never comparable across
   * halves — see `domain/reciprocal-rank-fusion.ts`.
   */
  readonly score: number;
}

export interface RetrievalRepository {
  /** §8.4 step 3 — pgvector HNSW, top 50, hard filtered by grade and subject. */
  searchDense(queryVector: readonly number[], filter: SearchFilter): Promise<CandidateRow[]>;
  /** §8.4 step 4 — full text, top 50, the SAME filter. */
  searchSparse(
    queryText: string,
    language: LanguageCode,
    filter: SearchFilter,
  ): Promise<CandidateRow[]>;
}

/** pgvector's literal form. What the driver wants for a `::vector` cast. */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * WHICH TEXT-SEARCH CONFIGURATION THE QUERY USES, and it must match the one the
 * generated column was built with or the two tokenise differently and nothing
 * matches.
 *
 * `rag_chunks.search_vector` is `to_tsvector('simple', …)` for `language = 'hi'`
 * and `to_tsvector('english', …)` otherwise (D-040) — Postgres has no Hindi
 * stemmer, and English stemming on Devanagari is worse than none. A Hindi query
 * put through the `'english'` configuration would be stemmed against a
 * `'simple'`-indexed vector, and the symptom is silence, not an error.
 */
const TEXT_SEARCH_CONFIG: Readonly<Record<LanguageCode, 'english' | 'simple'>> = {
  en: 'english',
  hi: 'simple',
};

/**
 * The raw row shape, snake_cased as Postgres returns it.
 *
 * The index signature is required by drizzle's `execute<T>` constraint
 * (`Record<string, unknown>`) and is deliberately `unknown` rather than a
 * wider union: the three named fields are still typed, and anything else the
 * query grows has to be narrowed before it can be used.
 */
interface RawCandidate {
  id: string;
  chunk_text: string;
  score: string | number;
  [column: string]: unknown;
}

/**
 * `numeric`/`float8` arrive from node-postgres as STRINGS for some types, so
 * the score is coerced once, here, and refused if it is not a number.
 * `Number(undefined)` is `NaN`, which would sort silently and put a random row
 * on top.
 */
function toCandidate(row: RawCandidate): CandidateRow {
  const score = typeof row.score === 'number' ? row.score : Number(row.score);
  if (!Number.isFinite(score)) {
    throw new Error(`retrieval: candidate ${row.id} has a non-numeric score "${String(row.score)}"`);
  }
  return { id: row.id, chunkText: row.chunk_text, score };
}

export function createRetrievalRepository(handle: RetrievalDbHandle): RetrievalRepository {
  const { db } = handle;

  return {
    /**
     * THE HARD FILTER IS IN THE `where`, NOT APPLIED AFTERWARDS (§8.4 step 3:
     * "a grade 7 query never returns grade 9 content").
     *
     * Post-filtering a top-50 would be worse than wrong — it would be
     * intermittently wrong. The 50 nearest chunks CORPUS-WIDE are mostly the
     * wrong grade, so filtering after the fact returns two or three rows for a
     * grade 7 query and reads as thin content.
     *
     * `embedding is not null` excludes the 20 chunks that arrived without a
     * vector (D-078). They are not broken and not dropped — they are invisible
     * to THIS half and perfectly reachable by the sparse one, which is the
     * whole reason the pipeline has two halves and the reason those rows were
     * imported rather than skipped. Without the predicate, pgvector compares
     * against NULL, the distance is NULL, and the rows sort to one end
     * depending on the operator — present, unscored, and occupying slots.
     */
    async searchDense(
      queryVector: readonly number[],
      filter: SearchFilter,
    ): Promise<CandidateRow[]> {
      const literal = toVectorLiteral(queryVector);
      const result = await db.execute<RawCandidate>(sql`
        select id, chunk_text, (embedding <=> ${literal}::vector) as score
        from rag_chunks
        where is_active
          and grade = ${filter.grade}
          and subject = ${filter.subject}
          and embedding is not null
        order by embedding <=> ${literal}::vector
        limit ${filter.limit}
      `);
      return result.rows.map(toCandidate);
    },

    /**
     * `websearch_to_tsquery`, not `plainto_tsquery` and not `to_tsquery`.
     *
     * `to_tsquery` REQUIRES operator syntax and RAISES on ordinary prose — a
     * student typing "what is refraction?" would produce a syntax error, which
     * `retrieval` would surface as a failed answer. `websearch_to_tsquery`
     * accepts anything a person types, supports quoted phrases, and cannot
     * raise. For a query box the choice is not close.
     *
     * A query that reduces to NOTHING (only stopwords — "what is the") yields
     * an empty tsquery which matches nothing. That is correct, and it is why
     * the sparse half legitimately returns zero rows for some inputs without it
     * meaning anything is broken.
     */
    async searchSparse(
      queryText: string,
      language: LanguageCode,
      filter: SearchFilter,
    ): Promise<CandidateRow[]> {
      const config = TEXT_SEARCH_CONFIG[language];
      const result = await db.execute<RawCandidate>(sql`
        select id, chunk_text,
               ts_rank(search_vector, websearch_to_tsquery(${config}, ${queryText})) as score
        from rag_chunks
        where is_active
          and grade = ${filter.grade}
          and subject = ${filter.subject}
          and search_vector @@ websearch_to_tsquery(${config}, ${queryText})
        order by ts_rank(search_vector, websearch_to_tsquery(${config}, ${queryText})) desc,
                 id asc
        limit ${filter.limit}
      `);
      return result.rows.map(toCandidate);
    },
  };
}
