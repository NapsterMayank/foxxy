import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  SPARSE_RANK_NORMALISATION,
  buildDenseQuery,
  buildSparseQuery,
  type SearchFilter,
} from '../retrieval.repository';

/**
 * =============================================================================
 * THE SQL, IN THE FAST LANE. NO DATABASE, NO DOCKER.
 *
 * WHY THIS FILE EXISTS. Two properties of the retrieval SQL were covered ONLY
 * by `tests/integration/retrieval-search.test.ts`, which needs a real Postgres
 * with pgvector and is therefore skipped on every machine without Docker and in
 * every lane that does not start one:
 *
 *   · the hard grade/subject filter — §8.4's "a grade 7 query never returns
 *     grade 9 content", which is a CONTENT-SAFETY property, not a quality one;
 *   · which text-search configuration each language uses (D-040), where the
 *     symptom of getting it wrong is silence rather than an error.
 *
 * A property whose only test is one that usually does not run is a property
 * with no test most of the time. So the query construction is a pure function
 * and this file renders it through drizzle's OWN `PgDialect` — the same
 * component that produces the string the driver sends — and asserts on the
 * emitted SQL and its parameters.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It cannot tell you the query runs,
 * that `search_vector` exists, that the HNSW index is used, or that
 * `hnsw.ef_search` is in effect. Those need a real server and remain the
 * integration suite's job. This is not a replacement for that suite; it is a
 * replacement for that suite being the ONLY copy.
 * =============================================================================
 */

const dialect = new PgDialect();

function render(query: Parameters<PgDialect['sqlToQuery']>[0]): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql: sql.replace(/\s+/gu, ' ').trim(), params };
}

const GRADE_7: SearchFilter = { grade: '7', subject: 'science', limit: 50 };

describe('the hard grade + subject filter is IN THE WHERE, in both halves', () => {
  /**
   * Post-filtering a top-50 would be worse than wrong, it would be
   * intermittently wrong: the 50 nearest chunks corpus-wide are mostly the
   * wrong grade, so filtering afterwards returns two or three rows and reads as
   * thin content rather than as a bug.
   */
  it('constrains grade and subject in the dense query, before the limit', () => {
    const { sql, params } = render(buildDenseQuery([0.1, 0.2], GRADE_7));

    expect(sql).toMatch(/where[\s\S]*grade = \$\d+[\s\S]*subject = \$\d+/u);
    expect(sql.indexOf('grade =')).toBeLessThan(sql.indexOf('limit'));
    expect(params).toContain('7');
    expect(params).toContain('science');
  });

  it('constrains grade and subject in the sparse query too — the SAME filter', () => {
    const { sql, params } = render(buildSparseQuery('what is heat', 'en', GRADE_7));

    expect(sql).toMatch(/chunks\.grade = \$\d+/u);
    expect(sql).toMatch(/chunks\.subject = \$\d+/u);
    expect(params).toContain('7');
    expect(params).toContain('science');
  });

  it('passes the grade as a STRING, never as an integer', () => {
    // Grades are `'6'`..`'12'` everywhere. An integer here is a type mismatch
    // against a text column, which Postgres resolves by casting — silently, and
    // differently depending on the plan.
    const { params } = render(buildDenseQuery([0.1], GRADE_7));

    expect(params.some((value) => value === 7)).toBe(false);
    expect(params).toContain('7');
  });

  it('excludes NULL-embedding rows from the DENSE half only', () => {
    // D-078: 20 active chunks arrived without a vector. Invisible to pgvector,
    // perfectly reachable by full text — which is half the reason there are two
    // halves.
    expect(render(buildDenseQuery([0.1], GRADE_7)).sql).toContain('embedding is not null');
    expect(render(buildSparseQuery('heat', 'en', GRADE_7)).sql).not.toContain('embedding');
  });

  it('filters on `is_active` in both halves', () => {
    expect(render(buildDenseQuery([0.1], GRADE_7)).sql).toContain('is_active');
    expect(render(buildSparseQuery('heat', 'en', GRADE_7)).sql).toContain('is_active');
  });
});

describe('the sparse half is OR, not AND — the 44% abstention defect', () => {
  /**
   * `websearch_to_tsquery` ANDs every non-stopword. On the 54-question
   * in-corpus golden set that returned ZERO candidates for 24 of them (44%),
   * mean 3.87 against a limit of 50 — while the corpus answers all 54. After
   * this query: 0 of 54 zero, mean 49.19.
   */
  it('does not put `websearch_to_tsquery` in the matching predicate', () => {
    const { sql } = render(buildSparseQuery('mendel pea plants experiments', 'en', GRADE_7));

    expect(sql).not.toContain('websearch_to_tsquery');
    expect(sql).not.toContain('plainto_tsquery');
  });

  it('builds the query by OR-ing the lexemes of the SAME tsvector the index uses', () => {
    // `to_tsvector(config, query)` rather than a TypeScript tokeniser: the
    // query and `rag_chunks.search_vector` then tokenise identically by
    // construction rather than by two implementations agreeing.
    const { sql } = render(buildSparseQuery('mendel pea plants', 'en', GRADE_7));

    expect(sql).toContain('unnest(to_tsvector(');
    expect(sql).toContain("string_agg(quote_literal(lexeme), ' | ')");
  });

  it('NEVER USES `to_tsquery` ON RAW USER TEXT, which raises on ordinary prose', () => {
    // The property the original `websearch_to_tsquery` choice was made for, and
    // the one this change had to preserve: "what is refraction?" must not be a
    // syntax error surfaced to a student as a failed answer. The only cast is
    // applied to an aggregate of Postgres-quoted lexemes.
    const { sql } = render(buildSparseQuery('what is refraction? & | ! ( )', 'en', GRADE_7));

    expect(sql).not.toMatch(/to_tsquery\(\s*\$\d+/u);
    expect(sql).toContain('expression::tsquery');
  });

  it('turns a query with no lexemes into NULL rather than casting an empty string', () => {
    // "the a of and" reduces to nothing. The `case` short-circuits it and the
    // `where` rejects the row before any cast is attempted.
    const { sql } = render(buildSparseQuery('the a of and', 'en', GRADE_7));

    expect(sql).toContain("case when expression = '' then null else expression::tsquery end");
    expect(sql).toContain('query.tsq is not null');
  });
});

describe('the ranking function — the ts_rank saturation defect', () => {
  it('uses ts_rank_cd, NOT the saturating ts_rank', () => {
    /**
     * `ts_rank` returns `float4` and pins to exactly 1.0 for any well-matched
     * document. Measured on "what is refraction of light" (grade 10 science):
     * twelve chunks tied at exactly 1.0, so the top twelve were ordered by the
     * `id asc` tiebreak — by random UUID — and the chunk stating the laws of
     * refraction sat at rank 14 with 0.9999998. `ts_rank_cd` put it at 2.
     */
    const { sql } = render(buildSparseQuery('refraction of light', 'en', GRADE_7));

    expect(sql).toContain('ts_rank_cd(');
    expect(sql).not.toMatch(/[^_]ts_rank\(/u);
  });

  it('applies the length + bounding normalisation flags — 1 | 32', () => {
    // 1 = divide by 1 + log(document length), which stops a long chunk that
    // repeats one lexeme outranking a short one that answers the question.
    // 32 = divide by rank + 1, bounding the score into [0, 1).
    expect(SPARSE_RANK_NORMALISATION).toBe(1 | 32);
    expect(render(buildSparseQuery('heat', 'en', GRADE_7)).params).toContain(33);
  });

  it('orders by score first and by id only as a TIEBREAK', () => {
    const { sql } = render(buildSparseQuery('heat', 'en', GRADE_7));

    expect(sql).toMatch(/order by score desc, chunks\.id asc/u);
  });
});

describe('the text-search configuration must match the indexed one — D-040', () => {
  /**
   * `rag_chunks.search_vector` is `to_tsvector('simple', …)` for Hindi rows and
   * `to_tsvector('english', …)` otherwise. Postgres has no Hindi stemmer, and
   * English stemming on Devanagari is worse than none. A Hindi query put
   * through `'english'` is stemmed against a `'simple'`-indexed vector, and the
   * symptom is SILENCE — no error, no rows, indistinguishable from a corpus
   * that lacks the content.
   */
  it("uses 'english' for en", () => {
    expect(render(buildSparseQuery('what is heat', 'en', GRADE_7)).params).toContain('english');
  });

  it("uses 'simple' for hi", () => {
    const { params } = render(buildSparseQuery('ऊष्मा क्या है', 'hi', GRADE_7));

    expect(params).toContain('simple');
    expect(params).not.toContain('english');
  });
});

describe('the candidate limit reaches the query', () => {
  it('is a parameter, not an interpolated literal', () => {
    const { sql, params } = render(
      buildSparseQuery('heat', 'en', { grade: '7', subject: 'science', limit: 25 }),
    );

    expect(sql).toMatch(/limit \$\d+/u);
    expect(params).toContain(25);
  });

  it('reaches the dense half identically', () => {
    const { params } = render(
      buildDenseQuery([0.1], { grade: '9', subject: 'mathematics', limit: 50 }),
    );

    expect(params).toContain(50);
  });
});

describe('what is NOT selected', () => {
  it('never returns the embedding — fifty 1024-float arrays nothing reads', () => {
    const { sql } = render(buildDenseQuery([0.1], GRADE_7));

    expect(sql).not.toMatch(/select[\s\S]*?, embedding[ ,]/u);
  });

  it('DOES return chunk_text in both halves, because deduplication needs it', () => {
    // A quarter of the corpus is exact-duplicate passages (D-108) and the only
    // honest way to tell two copies from two passages is to compare what they
    // say — in one implementation, in `domain/deduplicate.ts`.
    expect(render(buildDenseQuery([0.1], GRADE_7)).sql).toContain('chunk_text');
    expect(render(buildSparseQuery('heat', 'en', GRADE_7)).sql).toContain('chunk_text');
  });
});
