import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHAT "MIGRATED" MEANS, read from the migrations on disk — D-231.
 *
 * ===========================================================================
 * THE CHECK THIS REPLACES ACCEPTED A HALF-MIGRATED DATABASE.
 *
 * `db/health.ts` decided readiness with:
 *
 *     migrationsApplied = (rows[0]?.count ?? 0) > 0;
 *
 * One row. A database with `0000_baseline` applied and the other five pending
 * satisfied that, so `/health/ready` returned 200 and the load balancer routed
 * live traffic into a schema missing `practice`, `parent`, `billing` and
 * `foxy`. The failure arrives as 500s on whichever endpoint touches a missing
 * table first — which looks like an application bug, not like a deploy that
 * did not finish, and is therefore debugged in the wrong place.
 *
 * The migration step is explicitly NOT run on boot (see the Dockerfile), so
 * "the code is deployed and the migrations are not" is a REACHABLE state by
 * design, not a hypothetical. Readiness is the thing that is supposed to
 * notice.
 *
 * ===========================================================================
 * WHERE THE EXPECTED SET COMES FROM.
 *
 * Drizzle's journal, `<migrations>/meta/_journal.json`, is the authoritative
 * list of what this build EXPECTS. Its `when` values are exactly what the
 * migrator writes into `drizzle.__drizzle_migrations.created_at`, so the
 * comparison is set membership on a number and needs no hashing, no file reads
 * per migration, and no agreement about ordering.
 *
 * The folder travels with the image (`COPY drizzle ./drizzle`) precisely so
 * that the SQL matches the code. This reads the same copy, which means the
 * expectation and the artefact cannot drift.
 *
 * ===========================================================================
 * READ ONCE, AT BOOT. NEVER PER PROBE.
 *
 * A readiness endpoint that hits the filesystem on every request is a
 * readiness endpoint that a health checker can turn into disk load. It is also
 * a place for a partially-written file to produce a flapping probe. The
 * manifest cannot change while the process runs, so it is read at construction
 * and held.
 */

interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

interface Journal {
  readonly entries?: readonly JournalEntry[];
}

export interface MigrationManifest {
  /** `created_at` values the database must contain. Empty means "unknown". */
  readonly expected: readonly number[];
  /** Human-readable tags, for the log line when readiness fails. */
  readonly tags: readonly string[];
  /**
   * False when the journal could not be read.
   *
   * NOT an error, and not silently "everything is fine" either. The caller
   * decides: `createContainer` refuses to boot in production, because a
   * production image without its own migration journal cannot answer the
   * question readiness exists to answer; development and tests fall back to the
   * weaker "the table exists and has rows" check and say so.
   */
  readonly known: boolean;
}

const EMPTY: MigrationManifest = Object.freeze({
  expected: Object.freeze([]),
  tags: Object.freeze([]),
  known: false,
});

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.when === 'number' && typeof entry.tag === 'string';
}

/**
 * Parses the journal. Returns a manifest with `known: false` on any failure —
 * missing file, unreadable file, unexpected shape.
 *
 * Deliberately does not distinguish those three. They have the same remedy
 * (ship the folder), and a caller that branched on which one occurred would be
 * making a decision it has no use for.
 */
export function readMigrationManifest(migrationsDir: string): MigrationManifest {
  let raw: string;
  try {
    raw = readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8');
  } catch {
    return EMPTY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }

  if (typeof parsed !== 'object' || parsed === null) return EMPTY;
  const entries = (parsed as Journal).entries;
  if (!Array.isArray(entries)) return EMPTY;

  const valid = entries.filter(isJournalEntry);
  if (valid.length === 0) return EMPTY;

  return Object.freeze({
    expected: Object.freeze(valid.map((entry) => entry.when)),
    tags: Object.freeze(valid.map((entry) => entry.tag)),
    known: true,
  });
}

export interface MigrationState {
  /** True only when every expected migration is present in the database. */
  readonly fullyApplied: boolean;
  /** How many of the expected set are missing. Zero when fully applied. */
  readonly missingCount: number;
}

/**
 * FULLY migrated, not "migrated at all".
 *
 * Pure, so the rule can be asserted directly rather than inferred from an
 * endpoint's status code. That matters here more than usual: the defect this
 * replaces was a comparison (`> 0`) that read as a check and enforced almost
 * nothing, and a pure function is the only version of it that a mutation test
 * can point at.
 *
 * EXTRA applied migrations are NOT a failure. A rolling deploy runs the new
 * schema alongside the old code for a few seconds by design, and failing
 * readiness on the OLD replicas during that window would take the service down
 * in the middle of a successful deploy. Missing is fatal; extra is expected.
 */
export function evaluateMigrationState(
  manifest: MigrationManifest,
  applied: readonly number[],
): MigrationState {
  if (!manifest.known) {
    // The expected set is unknown, so the strongest honest statement is "some
    // migration has been applied". Stated here rather than at the call site so
    // there is one definition of the fallback.
    const any = applied.length > 0;
    return { fullyApplied: any, missingCount: any ? 0 : 1 };
  }

  const present = new Set(applied);
  const missing = manifest.expected.filter((when) => !present.has(when));
  return { fullyApplied: missing.length === 0, missingCount: missing.length };
}
