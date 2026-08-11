import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateMigrationState,
  readMigrationManifest,
  type MigrationManifest,
} from '../migration-manifest';

/**
 * =============================================================================
 * "FULLY MIGRATED", NOT "MIGRATED AT ALL" — D-231.
 *
 * WHAT THE CHECK USED TO BE, in `db/health.ts`:
 *
 *     migrationsApplied = (rows[0]?.count ?? 0) > 0;
 *
 * ONE ROW. A database with `0000_baseline` applied and the other five pending
 * satisfied it, so `/health/ready` returned 200 and the load balancer routed
 * live traffic into a schema with no `practice`, `parent`, `billing` or `foxy`
 * tables. The failure then arrives as 500s on whichever endpoint touches a
 * missing table first — which reads as an application bug rather than as a
 * deploy that did not finish, and is therefore debugged in the wrong place for
 * as long as it takes somebody to think of it.
 *
 * The migration step is deliberately NOT run on boot (see the Dockerfile), so
 * "code deployed, migrations not" is a REACHABLE state by design. Readiness is
 * the thing that is supposed to notice.
 * =============================================================================
 */

const MANIFEST: MigrationManifest = Object.freeze({
  expected: Object.freeze([1000, 2000, 3000, 4000, 5000, 6000]),
  // Deliberately NOT migration-shaped names. D-075 forbids a test hardcoding a
  // list of real migrations — that is a second source of truth which breaks on
  // every new one. This fixture is about the journal's SHAPE, so placeholders
  // that cannot be mistaken for the real set are the honest choice.
  tags: Object.freeze(['one', 'two', 'three', 'four', 'five', 'six']),
  known: true,
});

describe('evaluateMigrationState — the rule the old `> 0` replaced', () => {
  it('is ready only when EVERY expected migration is applied', () => {
    expect(evaluateMigrationState(MANIFEST, [...MANIFEST.expected])).toEqual({
      fullyApplied: true,
      missingCount: 0,
    });
  });

  it('REFUSES a half-migrated database — the exact defect', () => {
    // The baseline applied and the rest pending. This is what returned 200.
    const state = evaluateMigrationState(MANIFEST, [1000]);

    expect(state.fullyApplied).toBe(false);
    expect(state.missingCount).toBe(5);
  });

  it('refuses when a SINGLE migration in the middle is missing', () => {
    // The realistic partial failure: a migration that errored, leaving the ones
    // before and after it applied. Row-counting cannot see this at all — the
    // count is 5, which is emphatically "> 0".
    const applied = MANIFEST.expected.filter((when) => when !== 3000);

    expect(evaluateMigrationState(MANIFEST, applied)).toEqual({
      fullyApplied: false,
      missingCount: 1,
    });
  });

  it('refuses an empty database', () => {
    expect(evaluateMigrationState(MANIFEST, []).fullyApplied).toBe(false);
  });

  it('ACCEPTS extra applied migrations — a rolling deploy is not a failure', () => {
    // The new schema runs alongside the old code for a few seconds by design.
    // Failing readiness on the OLD replicas during that window would take the
    // service down in the middle of a successful deploy. Missing is fatal;
    // extra is expected.
    const state = evaluateMigrationState(MANIFEST, [...MANIFEST.expected, 7000, 8000]);

    expect(state.fullyApplied).toBe(true);
    expect(state.missingCount).toBe(0);
  });

  it('does not care about ORDER', () => {
    // Set membership on a number. No hashing, no per-file reads, and no
    // agreement needed about how the database sorts them.
    const shuffled = [...MANIFEST.expected].reverse();
    expect(evaluateMigrationState(MANIFEST, shuffled).fullyApplied).toBe(true);
  });

  describe('when the journal could not be read', () => {
    const unknown: MigrationManifest = Object.freeze({
      expected: Object.freeze([]),
      tags: Object.freeze([]),
      known: false,
    });

    it('falls back to the weaker "something has been applied" rule', () => {
      // Stated in ONE place rather than at the call site, so there is a single
      // definition of the fallback. `createContainer` refuses to boot in
      // production rather than rely on it.
      expect(evaluateMigrationState(unknown, [1000]).fullyApplied).toBe(true);
      expect(evaluateMigrationState(unknown, []).fullyApplied).toBe(false);
    });
  });
});

describe('readMigrationManifest — where the expected set comes from', () => {
  function journalDir(contents: string | null): string {
    const root = mkdtempSync(join(tmpdir(), 'foxxy-journal-'));
    if (contents !== null) {
      mkdirSync(join(root, 'meta'), { recursive: true });
      writeFileSync(join(root, 'meta', '_journal.json'), contents);
    }
    return root;
  }

  it('reads drizzle\'s own journal, which is what the migrator writes from', () => {
    // `when` is exactly the value the migrator puts in
    // `drizzle.__drizzle_migrations.created_at`, so the comparison needs no
    // hashing and no per-migration file read.
    const dir = journalDir(
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, when: 1737000000000, tag: 'first', breakpoints: true },
          { idx: 1, when: 1737000000001, tag: 'second', breakpoints: true },
        ],
      }),
    );

    const manifest = readMigrationManifest(dir);

    expect(manifest.known).toBe(true);
    expect(manifest.expected).toEqual([1737000000000, 1737000000001]);
    expect(manifest.tags).toEqual(['first', 'second']);
  });

  it('reads the REAL journal that ships with this repository', () => {
    // The folder travels with the image (`COPY drizzle ./drizzle`) precisely so
    // the SQL matches the code, and this reads the same copy — so the
    // expectation and the artefact cannot drift. A test against a fixture alone
    // would keep passing if the real journal moved or changed shape.
    const manifest = readMigrationManifest('./drizzle/migrations');

    expect(manifest.known).toBe(true);
    expect(manifest.expected.length).toBeGreaterThan(0);
    expect(manifest.expected).toHaveLength(manifest.tags.length);
  });

  it.each([
    ['a missing folder', null],
    ['unparseable JSON', '{ not json'],
    ['an unexpected shape', JSON.stringify({ entries: 'nope' })],
    ['no entries at all', JSON.stringify({ entries: [] })],
    ['entries missing `when`', JSON.stringify({ entries: [{ idx: 0, tag: 'x' }] })],
  ])('reports `known: false` for %s rather than throwing', (_label, contents) => {
    // The three failure causes are deliberately not distinguished: they have
    // the same remedy (ship the folder), and a caller that branched on which
    // one occurred would be making a decision it has no use for.
    const manifest = readMigrationManifest(journalDir(contents));

    expect(manifest.known).toBe(false);
    expect(manifest.expected).toEqual([]);
  });
});
