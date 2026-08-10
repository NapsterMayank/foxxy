import { sql } from 'drizzle-orm';
import { createDbPools } from '../../src/platform/db/index';
import { normaliseQuery } from '../../src/modules/retrieval/index';
import { createRetrievalRepository } from '../../src/modules/retrieval/retrieval.repository';
import { IN_CORPUS_QUESTIONS } from './golden/in-corpus';
import { OFF_SYLLABUS_QUESTIONS } from './golden/off-syllabus';
import type { GoldenQuestion } from './golden/types';

/**
 * =============================================================================
 * THE SPARSE HALF'S RECALL, BEFORE AND AFTER, ON THE WHOLE GOLDEN SET.
 *
 *     npm run eval:retrieval:recall
 *
 * =============================================================================
 * WHAT THIS MEASURES AND WHY IT IS A PERMANENT TOOL RATHER THAN A ONE-OFF.
 *
 * The sparse half used `websearch_to_tsquery`, which ANDs every non-stopword.
 * On 10 August 2026 that returned ZERO candidates for 24 of the 54 in-corpus
 * golden questions — 44% — while the corpus answers all 54. The fix was OR
 * semantics with `ts_rank_cd` doing the discrimination
 * (`retrieval.repository.ts`), and the number that proves it is a count, not an
 * opinion.
 *
 * It stays because that number is the FIRST thing to regress if the sparse
 * query is ever "simplified" back toward a conjunction, and because it is
 * cheap: full-text search needs no API key, so this runs anywhere the
 * development database runs. Calibration needs `VOYAGE_API_KEY`; this does not.
 *
 * THE "BEFORE" QUERY IS SPELLED OUT BELOW, DELIBERATELY. It is the superseded
 * implementation, kept in this file and nowhere else, so the comparison is
 * against what actually shipped rather than against a description of it. It is
 * dead code in the sense that nothing in `src/` can reach it, and live code in
 * the sense that the claim "OR retrieves more" is re-derived every run rather
 * than remembered.
 *
 * READ-ONLY. There is no write path in this directory and there must never be
 * one — the development corpus took a day to obtain.
 * =============================================================================
 */

const CANDIDATE_LIMIT = 50;

interface Counts {
  readonly zero: number;
  readonly total: number;
  readonly meanCandidates: number;
}

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function summarise(counts: readonly number[]): Counts {
  const total = counts.length;
  if (total === 0) return { zero: 0, total: 0, meanCandidates: 0 };
  const zero = counts.filter((count) => count === 0).length;
  const sum = counts.reduce((running, count) => running + count, 0);
  return { zero, total, meanCandidates: sum / total };
}

function report(label: string, counts: Counts): void {
  const percent = counts.total === 0 ? 0 : (counts.zero / counts.total) * 100;
  line(
    `  ${label.padEnd(24)} zero candidates ${String(counts.zero).padStart(3)} of ` +
      `${String(counts.total).padStart(3)} (${percent.toFixed(1).padStart(5)}%)   ` +
      `mean ${counts.meanCandidates.toFixed(2).padStart(6)}`,
  );
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    line('DATABASE_URL is not set. This probe reads the real corpus.');
    return 1;
  }

  const pools = createDbPools({
    url: databaseUrl,
    ssl: false,
    sizes: { auth: 1, core: 2, ai: 2, worker: 1 },
    statementTimeoutMs: 30_000,
    vectorStatementTimeoutMs: 30_000,
    connectTimeoutMs: 5_000,
    hnswEfSearch: 100,
  });

  try {
    const repository = createRetrievalRepository(pools.ai);
    const { db } = pools.ai;

    /**
     * THE SUPERSEDED QUERY, verbatim in its matching semantics: every lexeme
     * ANDed by `websearch_to_tsquery`. Only the count is taken — the ranking is
     * not part of this comparison, which is about how many rows exist at all.
     */
    const countUnderAndSemantics = async (question: GoldenQuestion): Promise<number> => {
      const normalised = normaliseQuery(question.query);
      const config = normalised.language === 'hi' ? 'simple' : 'english';
      const result = await db.execute<{ n: number }>(sql`
        select count(*)::int as n
        from (
          select 1
          from rag_chunks
          where is_active
            and grade = ${question.grade}
            and subject = ${question.subject}
            and search_vector @@ websearch_to_tsquery(${config}, ${normalised.text})
          limit ${CANDIDATE_LIMIT}
        ) capped
      `);
      return result.rows[0]?.n ?? 0;
    };

    const countUnderShippedQuery = async (question: GoldenQuestion): Promise<number> => {
      const normalised = normaliseQuery(question.query);
      const rows = await repository.searchSparse(normalised.text, normalised.language, {
        grade: question.grade,
        subject: question.subject,
        limit: CANDIDATE_LIMIT,
      });
      return rows.length;
    };

    const corpus = await pools.core.pool.query<{ active: string; embedded: string }>(
      `select count(*)::text as active,
              count(*) filter (where embedding is not null)::text as embedded
         from rag_chunks where is_active`,
    );
    line(
      `Corpus: ${corpus.rows[0]?.active ?? '?'} active chunks, ` +
        `${corpus.rows[0]?.embedded ?? '?'} with an embedding`,
    );
    line(`Candidate limit: ${String(CANDIDATE_LIMIT)} per half`);
    line();

    for (const [name, questions] of [
      ['IN CORPUS', IN_CORPUS_QUESTIONS],
      ['OFF SYLLABUS', OFF_SYLLABUS_QUESTIONS],
    ] as const) {
      const before: number[] = [];
      const after: number[] = [];
      for (const question of questions) {
        before.push(await countUnderAndSemantics(question));
        after.push(await countUnderShippedQuery(question));
      }

      line(`--- ${name} (n=${String(questions.length)}) ---------------------------`);
      report('BEFORE — AND semantics', summarise(before));
      report('AFTER  — shipped query', summarise(after));

      if (name === 'IN CORPUS') {
        line();
        line('  Questions the AND query could not answer at all:');
        questions.forEach((question, index) => {
          if (before[index] !== 0) return;
          line(
            `    ${String(after[index] ?? 0).padStart(3)} now  (0 before)  ` +
              `${question.grade}/${question.subject}  ${question.query}`,
          );
        });
      }
      line();
    }

    /**
     * The off-syllabus numbers are NOT a regression, and printing them without
     * this note would invite reading them as one. Under AND, every off-syllabus
     * question returned zero sparse rows — but so did 44% of the in-corpus set,
     * so the "abstention" was a broken retriever rather than a judgement. The
     * dense half returns 50 rows for any input regardless, so `no-candidates`
     * was never the mechanism that refused an off-syllabus question. That
     * mechanism is the measured threshold in
     * `domain/abstain-threshold.ts`, and it can only exist once both halves
     * return something to score.
     */
    line('Off-syllabus rejection is the THRESHOLD\'s job, not the retriever\'s:');
    line('the dense half returns 50 rows for any input, so zero total candidates');
    line('was never how an off-syllabus question got refused. See');
    line('`npm run eval:retrieval:calibrate`.');

    return 0;
  } finally {
    await pools.close();
  }
}

const exitCode = await main();
process.exitCode = exitCode;
