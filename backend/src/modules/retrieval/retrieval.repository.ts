import { sql, type SQL } from 'drizzle-orm';
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
 * CONNECTION PARAMETER (D-049) — as is `worker`, which is the pool this
 * repository is built on in the background process. Without it pgvector caps an
 * HNSW scan at 40 rows however large the LIMIT, so the top-50 below would
 * silently return 40 — which reads as a thin corpus rather than as a setting.
 * That is not hypothetical: the parameter was on `ai` alone until 10 August
 * 2026, and the worker process therefore ran this file's dense query at
 * pgvector's default the whole time. Nothing in this file sets it,
 * deliberately: a module-level `SET` is one that the second query path forgets,
 * and the connection nobody accounted for is the one that under-retrieves.
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
   * better), `ts_rank_cd` for sparse (higher is better). Never comparable
   * across halves — see `domain/reciprocal-rank-fusion.ts`. Nothing downstream
   * ranks on this: it exists so a trace can be read.
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

/**
 * =============================================================================
 * THE `ts_rank_cd` NORMALISATION FLAGS — `1 | 32`, and both bits are load
 * bearing.
 *
 *   1   divide by `1 + log(document length)`. Without it a long chunk that
 *       happens to repeat one query lexeme many times outranks a short chunk
 *       that answers the question, because cover density accumulates with
 *       length. Measured on "prove that root 2 is an irrational number"
 *       (grade 9 mathematics): without bit 1 the algebra-identities chunk full
 *       of the lexeme `2` takes rank 1; with it the actual proof rises.
 *
 *   32  divide by `rank + 1`, bounding the score into [0, 1).
 *
 * WHY NOT `ts_rank`, WHICH IS WHAT THIS USED TO USE. `ts_rank` saturates. It
 * returns `float4`, and for any well-matched document the value pins to exactly
 * 1.0 — measured on "what is refraction of light" (grade 10 science), TWELVE
 * chunks tied at exactly 1.0, so the top twelve were ordered by the `id asc`
 * tiebreak, i.e. by random UUID, and the chunk that actually states the laws of
 * refraction sat at rank 14 with 0.9999998 — below any cut. That is not a
 * ranking, it is a shuffle with a ranking's shape.
 *
 * `ts_rank_cd(…, 1 | 32)` on the same three probe queries produced TWELVE
 * DISTINCT scores in the top twelve for all three, and moved the laws-of-
 * refraction chunk from 14 to 2.
 * =============================================================================
 */
export const SPARSE_RANK_NORMALISATION = 33;

/**
 * The dense half's SQL, built separately from its execution so the hard
 * grade/subject filter is assertable WITHOUT a database.
 *
 * The filter used to be reachable only through the Docker-gated integration
 * suite, which means on any machine without Docker — and in any CI lane that
 * skips it — "a grade 7 query never returns grade 9 content" was an unchecked
 * claim. `__tests__/retrieval.repository.test.ts` renders these through
 * drizzle's own `PgDialect` and asserts the `where` on the emitted SQL. That is
 * not a substitute for the integration test (it cannot tell you the query
 * RUNS); it is a substitute for the integration test being the only copy.
 */
export function buildDenseQuery(
  queryVector: readonly number[],
  filter: SearchFilter,
): SQL {
  const literal = toVectorLiteral(queryVector);
  return sql`
    select id, chunk_text, (embedding <=> ${literal}::vector) as score
    from rag_chunks
    where is_active
      and grade = ${filter.grade}
      and subject = ${filter.subject}
      and embedding is not null
    order by embedding <=> ${literal}::vector
    limit ${filter.limit}
  `;
}

/**
 * =============================================================================
 * THE SPARSE HALF IS `OR`, NOT `AND`, AND THAT IS THE WHOLE FIX.
 *
 * `websearch_to_tsquery` ANDs every non-stopword it finds. For
 *
 *     "what did mendel find out from his experiments on pea plants"
 *
 * it produces `'mendel' & 'find' & 'experi' & 'pea' & 'plant'`, and NO chunk in
 * grade 10 science satisfies all five — while the corpus contains, verbatim,
 * "Mendel used a number of contrasting visible characters of garden peas –
 * round/wrinkled seeds, tall…". Six chunks match `mendel`. Eighty-nine match
 * `mendel | pea | plants`. Zero match the conjunction. The sparse half returned
 * nothing and the abstention read as missing content.
 *
 * MEASURED over the 54-question in-corpus golden set (10 August 2026):
 *
 *                          zero candidates      mean candidates (limit 50)
 *   AND (`websearch`)      24 of 54  (44%)      3.87
 *   OR  (this query)        0 of 54  ( 0%)      49.19
 *
 * The recall is not free and the cost is stated: an OR query returns
 * near-anything, so DISCRIMINATION MOVES ENTIRELY INTO THE RANKING. That is why
 * `ts_rank_cd` above is not a cosmetic change bundled in with this one — with
 * the saturating `ts_rank` an OR query would be fifty rows in random order.
 * Downstream, RRF only ever reads the ORDER, and a candidate at rank 50 of one
 * list contributes 1/110 — so extra recall at the bottom is close to free while
 * extra recall in the top ten is the entire point.
 *
 * -----------------------------------------------------------------------------
 * HOW THE `OR` QUERY IS BUILT, AND WHY NOT WITH `to_tsquery`.
 *
 * `to_tsquery` REQUIRES operator syntax and RAISES on ordinary prose — "what is
 * refraction?" is a syntax error, surfaced to a student as a failed answer.
 * That property is why `websearch_to_tsquery` was chosen and it is KEPT here:
 * nothing below can raise on user input.
 *
 * The lexemes come from `to_tsvector(config, query)` — the same parser and the
 * same dictionary that built `rag_chunks.search_vector`, so the two tokenise
 * identically by construction rather than by agreement. Postgres quotes each
 * lexeme itself via `quote_literal`, and a tsvector lexeme cannot contain a
 * backslash or a space (the parser treats both as token separators), so the
 * aggregate is always a well-formed tsquery. A query that reduces to NOTHING —
 * only stopwords, or only punctuation — yields the empty string, and the
 * `case` turns that into `null`, which the `where` rejects before any cast is
 * attempted. Verified against `''`, `'the a of and'`, Devanagari under the
 * `simple` configuration, and `'"quoted phrase" -excluded term & | ! ( )'`:
 * zero rows, no error.
 *
 * WHAT IS DELIBERATELY LOST: websearch's negation. `-term` becomes an ordinary
 * OR term rather than an exclusion. Ranked last among the lexemes it barely
 * affects the order, and the alternative — parsing the `!` back out of a
 * tsquery's text form — is a second, fragile tokeniser in TypeScript for a
 * syntax a student typing into a chat box does not use.
 * =============================================================================
 */
export function buildSparseQuery(
  queryText: string,
  language: LanguageCode,
  filter: SearchFilter,
): SQL {
  const config = TEXT_SEARCH_CONFIG[language];
  return sql`
    with lexemes as (
      select coalesce(string_agg(quote_literal(lexeme), ' | '), '') as expression
      from unnest(to_tsvector(${config}, ${queryText}))
    ),
    query as (
      select case when expression = '' then null else expression::tsquery end as tsq
      from lexemes
    )
    select chunks.id,
           chunks.chunk_text,
           ts_rank_cd(chunks.search_vector, query.tsq, ${SPARSE_RANK_NORMALISATION}) as score
    from rag_chunks chunks, query
    where query.tsq is not null
      and chunks.is_active
      and chunks.grade = ${filter.grade}
      and chunks.subject = ${filter.subject}
      and chunks.search_vector @@ query.tsq
    order by score desc, chunks.id asc
    limit ${filter.limit}
  `;
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
     * `embedding is not null` excludes the 20 ACTIVE chunks that arrived
     * without a vector (D-078, headline figure corrected 10 August 2026: the
     * entry's "2,564" described the source export, not what landed. Measured
     * against this corpus — 4,686 rows imported, 4,403 active, 20 of those with
     * a NULL vector). They are not broken and not dropped — they are invisible
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
      const result = await db.execute<RawCandidate>(buildDenseQuery(queryVector, filter));
      return result.rows.map(toCandidate);
    },

    /**
     * OR semantics over the query's lexemes, ranked by `ts_rank_cd`. The two
     * decisions and the numbers behind them are on `buildSparseQuery` above.
     *
     * A query that reduces to NOTHING (only stopwords — "what is the") still
     * returns zero rows, and that is still correct: there is no term to match
     * on. What no longer happens is a query with five perfectly good terms
     * returning zero rows because no single chunk contains all five.
     */
    async searchSparse(
      queryText: string,
      language: LanguageCode,
      filter: SearchFilter,
    ): Promise<CandidateRow[]> {
      const result = await db.execute<RawCandidate>(
        buildSparseQuery(queryText, language, filter),
      );
      return result.rows.map(toCandidate);
    },
  };
}
