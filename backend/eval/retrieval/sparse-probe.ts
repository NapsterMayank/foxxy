import { createRetrievalRepository } from '../../src/modules/retrieval/retrieval.repository';
import {
  deduplicateByText,
  fuse,
  normaliseQuery,
} from '../../src/modules/retrieval/index';
import { createDbPools } from '../../src/platform/db/index';
import { IN_CORPUS_QUESTIONS } from './golden/in-corpus';

/**
 * =============================================================================
 * THE SPARSE HALF, MEASURED TODAY, AGAINST THE REAL CORPUS.
 *
 *     npm run eval:retrieval:sparse
 *
 * =============================================================================
 * WHY THIS EXISTS SEPARATELY FROM `calibrate.ts`.
 *
 * Calibration is blocked on `VOYAGE_API_KEY` because half the pipeline cannot
 * run without embedding a query. THE OTHER HALF NEEDS NOTHING. Full-text
 * search over `rag_chunks.search_vector` works today, against all 4,686 real
 * chunks, and everything downstream of it — the hard grade/subject filter,
 * ranking, deduplication, truncation — can be exercised and looked at.
 *
 * "Blocked on a key" is a reason to defer the dense half. It is not a reason to
 * defer knowing whether the sparse half returns sensible rows, and "the query
 * executed" is not that knowledge. This prints the actual passages so a human
 * can read them and say whether they answer the question.
 *
 * =============================================================================
 * IT ALSO MEASURES THE DEDUPLICATION EFFECT (D-108).
 *
 * 1,199 of 4,686 chunks are exact text duplicates. This reports, per query, how
 * many of the fused candidates collapsed and what the top 3 looks like with and
 * without the collapse — which is the only way "deduplication is worth doing"
 * stops being an assertion.
 *
 * READ-ONLY. There is no write path in this file and there must never be one:
 * the development corpus took a day to obtain.
 * =============================================================================
 */

const CANDIDATE_LIMIT = 50;
const TOP_N = 3;
/** Enough queries to see a pattern, few enough to read the output. */
const SAMPLE_SIZE = 8;

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function excerpt(text: string, width = 150): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width)}...`;
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

    const totals = await pools.core.pool.query<{ chunks: string; embedded: string }>(
      `select count(*)::text as chunks,
              count(*) filter (where embedding is not null)::text as embedded
         from rag_chunks where is_active`,
    );
    line(
      `Corpus: ${totals.rows[0]?.chunks ?? '?'} active chunks, ` +
        `${totals.rows[0]?.embedded ?? '?'} embedded`,
    );
    line('SPARSE HALF ONLY — no embeddings, no API key. The dense half is blocked.');

    let collapsedTotal = 0;
    let candidateTotal = 0;
    let queriesWithDuplicates = 0;

    for (const question of IN_CORPUS_QUESTIONS.slice(0, SAMPLE_SIZE)) {
      const normalised = normaliseQuery(question.query);
      const sparse = await repository.searchSparse(normalised.text, normalised.language, {
        grade: question.grade,
        subject: question.subject,
        limit: CANDIDATE_LIMIT,
      });

      // The dense list is EMPTY, so fusion degenerates to the sparse ranking.
      // Deliberately still run through `fuse` rather than around it: the
      // measurement has to describe the code that ships, not a shortcut.
      const fused = fuse(
        [],
        sparse.map((row) => row.id),
      );
      const textById = new Map(sparse.map((row) => [row.id, row.chunkText]));
      const deduplicated = deduplicateByText(
        fused.map((candidate) => ({
          id: candidate.id,
          chunkText: textById.get(candidate.id) ?? '',
          fusedScore: candidate.fusedScore,
        })),
      );

      candidateTotal += fused.length;
      collapsedTotal += deduplicated.duplicatesCollapsed;
      if (deduplicated.duplicatesCollapsed > 0) queriesWithDuplicates += 1;

      line();
      line('=============================================================');
      line(`Q  ${question.query}`);
      line(`   grade ${question.grade} / ${question.subject} — expected: ${question.note}`);
      line(
        `   candidates=${String(fused.length)}  ` +
          `duplicates collapsed=${String(deduplicated.duplicatesCollapsed)}  ` +
          `distinct=${String(deduplicated.kept.length)}`,
      );

      if (fused.length === 0) {
        line('   NO ROWS — the sparse half found nothing. Retrieval would abstain.');
        continue;
      }

      const withoutDedup = fused.slice(0, TOP_N);
      const withDedup = deduplicated.kept.slice(0, TOP_N);

      line();
      line('   TOP 3 WITHOUT DEDUPLICATION:');
      for (const [index, candidate] of withoutDedup.entries()) {
        line(`   ${String(index + 1)}. ${excerpt(textById.get(candidate.id) ?? '')}`);
      }
      line();
      line('   TOP 3 WITH DEDUPLICATION:');
      for (const [index, candidate] of withDedup.entries()) {
        line(`   ${String(index + 1)}. ${excerpt(candidate.chunkText)}`);
      }
    }

    line();
    line('=============================================================');
    line('DEDUPLICATION EFFECT ACROSS THE SAMPLE');
    line(`  queries:                 ${String(SAMPLE_SIZE)}`);
    line(`  fused candidates:        ${String(candidateTotal)}`);
    line(`  duplicates collapsed:    ${String(collapsedTotal)}`);
    line(
      `  share collapsed:         ${
        candidateTotal === 0 ? 'n/a' : `${((collapsedTotal / candidateTotal) * 100).toFixed(1)}%`
      }`,
    );
    line(`  queries with duplicates: ${String(queriesWithDuplicates)} of ${String(SAMPLE_SIZE)}`);

    return 0;
  } finally {
    await pools.close();
  }
}

const exitCode = await main();
process.exitCode = exitCode;
