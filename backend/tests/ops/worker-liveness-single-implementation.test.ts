import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * =============================================================================
 * ONE WORKER-LIVENESS READ, NOT TWO — D-333.
 *
 * `readWorkerLiveness` in `platform/jobs/heartbeat.ts` is the per-worker,
 * `status <> 'stopped'` liveness query. It had ZERO CALLERS, and beside it
 * `scripts/ops/alert-sources.ts` carried a SECOND COPY of the same query with
 * all of them — under a comment explaining that the shared one could not be used
 * because it threw (D-305: `last_beat_at` declared `Date` while the driver hands
 * back wire text for a `timestamptz`).
 *
 * That defect is repaired. What remained was the more dangerous half: two
 * implementations of "which workers are alive", free to drift. The drift is not
 * hypothetical — the duplicate ALREADY had two defects the shared one did not
 * (`max()` across all rows, so one healthy replica hid every dead one; and no
 * status filter, so a cleanly stopped worker read as a pulse). Both were fixed
 * in the copy. Nothing forced the copy and the original to agree, and nothing
 * would have forced the NEXT fix into both.
 *
 * THIS TEST IS A DRIFT GUARD, AND IT IS STATIC ON PURPOSE. The behavioural
 * assertions live in `alert-sources.test.ts` (six of them, against a real
 * database) and in `worker-shutdown.test.ts` (`readWorkerLiveness` against the
 * real driver). Neither can fail merely because a second copy of the query was
 * reintroduced — a correct duplicate passes every behavioural test there is, on
 * the day it is written. It is the day AFTER that costs, and only a structural
 * assertion can see it coming.
 * =============================================================================
 */

const ALERT_SOURCES = join(process.cwd(), 'src', 'platform', 'alerts', 'alert-sources.ts');

function source(): string {
  return readFileSync(ALERT_SOURCES, 'utf8');
}

/**
 * The file with its comments removed.
 *
 * Necessary, not fastidious: this file's prose explains the very defects being
 * banned — it quotes `max(last_beat_at)` and `status <> 'stopped'` to say why
 * they were wrong. A scan that read the comments would ban the explanation along
 * with the code, and the usual response to that is to delete the explanation.
 */
function code(): string {
  return source()
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

describe('the alert evaluator reads worker liveness through platform/jobs (D-333)', () => {
  it('imports readWorkerLiveness', () => {
    expect(source()).toMatch(/import\s*\{[^}]*readWorkerLiveness[^}]*\}\s*from/u);
  });

  it('carries no second SQL query against worker_heartbeats', () => {
    // The collector's own comment used to say the shared function "is not reused
    // here". If that ever becomes true again, this is the line that says so.
    const sqlReferences = code().match(/from\s+worker_heartbeats/giu) ?? [];
    expect(sqlReferences).toEqual([]);
  });

  it('does not reintroduce the two defects the duplicate had', () => {
    // `max(last_beat_at)` — one healthy replica hides any number of dead ones.
    expect(code()).not.toMatch(/max\s*\(\s*last_beat_at\s*\)/iu);
    // A `stopped` row keeps its `last_beat_at` forever: counting it reads a
    // tombstone as a pulse. The filter now lives in `readWorkerLiveness`.
    expect(code()).not.toMatch(/status\s*<>\s*'stopped'/iu);
  });
});
