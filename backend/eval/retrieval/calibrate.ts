import { createHttpClient } from '../../src/platform/http/index';
import { createVoyageEmbed } from '../../src/platform/embed/index';
import { calibrate, toMeasuredThreshold } from '../../src/modules/retrieval/index';
import { IN_CORPUS_QUESTIONS } from './golden/in-corpus';
import { OFF_SYLLABUS_QUESTIONS } from './golden/off-syllabus';
import { createHarness, scoreSet, toSamples } from './harness';

/**
 * =============================================================================
 * THRESHOLD CALIBRATION — §8.4, "measured, never guessed".
 *
 *     VOYAGE_API_KEY=... npm run eval:retrieval:calibrate
 *
 * =============================================================================
 * IT REFUSES TO RUN WITHOUT A KEY, AND THAT REFUSAL IS THE POINT.
 *
 * The obvious convenience — fall back to the deterministic fake so the harness
 * "works" today — produces two distributions that differ only by chance, a
 * threshold placed between two noise clouds, and a `MEASURED` provenance block
 * full of real-looking numbers that mean nothing at all. That is strictly worse
 * than having no threshold, because nobody reading the constant afterwards can
 * tell. The previous system's year-long silent filter began as exactly this
 * kind of convenience.
 *
 * So: no key, no run, non-zero exit.
 *
 * =============================================================================
 * WHAT IT DOES NOT DO: adopt the number.
 *
 * It PRINTS the `MEASURED` provenance block. A human pastes it into
 * `src/modules/retrieval/domain/abstain-threshold.ts`, flips the test that
 * asserts UNCALIBRATED, and writes the measurement into the comment beside the
 * constant. Automating that last step would let a bad run — a half-imported
 * corpus, a rate-limited half of the questions — silently change what students
 * are told, and the diff would be a number.
 * =============================================================================
 */

/** §8.4 step 7's launch N. The scores are the same at any N; this is for the trace. */
const TOP_N = 3;

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function fixed(value: number): string {
  return value.toFixed(6);
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.VOYAGE_API_KEY;

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    line('DATABASE_URL is not set. This harness reads the real corpus.');
    return 1;
  }

  if (apiKey === undefined || apiKey.trim().length === 0) {
    line('=============================================================');
    line('VOYAGE_API_KEY is not set — CALIBRATION CANNOT RUN.');
    line('');
    line('This is deliberate. Falling back to the deterministic fake would');
    line('produce two distributions that differ only by chance and a');
    line('threshold placed between two noise clouds — a number with the');
    line('shape of a measurement and none of the content.');
    line('');
    line('The sparse half needs no embeddings and CAN be measured today:');
    line('    npm run eval:retrieval:sparse');
    line('=============================================================');
    return 1;
  }

  const harness = createHarness({
    databaseUrl,
    embed: createVoyageEmbed({
      // The same client the application uses: timeout, jittered retry, and —
      // when the composition root supplies one — the circuit breaker.
      http: createHttpClient({ timeoutMs: 15_000, maxRetries: 2 }),
      apiKey,
    }),
  });

  try {
    const corpusSize = await harness.pools.core.pool.query<{ n: string }>(
      `select count(*)::text as n from rag_chunks where is_active`,
    );
    const corpusChunkCount = Number(corpusSize.rows[0]?.n ?? '0');

    line(`Corpus: ${String(corpusChunkCount)} active chunks`);
    line(`Scoring ${String(IN_CORPUS_QUESTIONS.length)} in-corpus questions...`);
    const inCorpus = await scoreSet(harness.service, IN_CORPUS_QUESTIONS, TOP_N);

    line(`Scoring ${String(OFF_SYLLABUS_QUESTIONS.length)} off-syllabus questions...`);
    const offSyllabus = await scoreSet(harness.service, OFF_SYLLABUS_QUESTIONS, TOP_N);

    const report = calibrate({
      inCorpus: toSamples(inCorpus),
      offSyllabus: toSamples(offSyllabus),
    });

    line();
    line('--- IN CORPUS -----------------------------------------------');
    for (const entry of inCorpus) {
      line(
        `${fixed(entry.result.trace.topFusedScore ?? 0)}  ` +
          `${entry.question.grade}/${entry.question.subject}  ` +
          entry.question.query,
      );
    }
    line();
    line('--- OFF SYLLABUS --------------------------------------------');
    for (const entry of offSyllabus) {
      line(
        `${fixed(entry.result.trace.topFusedScore ?? 0)}  ` +
          `${entry.question.grade}/${entry.question.subject}  ` +
          entry.question.query,
      );
    }

    line();
    line('--- DISTRIBUTIONS -------------------------------------------');
    line(
      `in-corpus     n=${String(report.inCorpus.count)}  min=${fixed(report.inCorpus.min)}  ` +
        `p5=${fixed(report.inCorpus.p5)}  median=${fixed(report.inCorpus.median)}  ` +
        `p95=${fixed(report.inCorpus.p95)}  max=${fixed(report.inCorpus.max)}`,
    );
    line(
      `off-syllabus  n=${String(report.offSyllabus.count)}  min=${fixed(report.offSyllabus.min)}  ` +
        `p5=${fixed(report.offSyllabus.p5)}  median=${fixed(report.offSyllabus.median)}  ` +
        `p95=${fixed(report.offSyllabus.p95)}  max=${fixed(report.offSyllabus.max)}`,
    );
    line();
    line(`separated:              ${String(report.separated)}`);
    line(`suggested threshold:    ${fixed(report.suggestedThreshold)}`);
    line(`off-syllabus abstained: ${(report.offSyllabusAbstainRate * 100).toFixed(1)}%`);
    line(`in-corpus FALSE abstain:${(report.inCorpusFalseAbstainRate * 100).toFixed(1)}%  <-- the expensive mistake`);

    if (!report.separated) {
      line();
      line('*** THE TWO DISTRIBUTIONS OVERLAP AT THE 5/95 EDGES. ***');
      line('The suggested value is where they are equally wrong. Read both');
      line('error rates above before adopting it, and consider whether the');
      line('off-syllabus set is hard enough — a set of gibberish separates');
      line('cleanly and calibrates nothing.');
    }

    const measured = toMeasuredThreshold(report, {
      measuredAt: new Date().toISOString().slice(0, 10),
      corpusChunkCount,
      embeddingModel: 'voyage-3',
    });

    line();
    line('--- PASTE INTO domain/abstain-threshold.ts -------------------');
    line(JSON.stringify(measured, null, 2));
    line();
    line('Then: write the two distributions above into the comment beside the');
    line('constant, and flip the UNCALIBRATED assertion in');
    line('__tests__/abstain-threshold.test.ts. Both by hand, on purpose.');

    return 0;
  } finally {
    await harness.close();
  }
}

const exitCode = await main();
process.exitCode = exitCode;
