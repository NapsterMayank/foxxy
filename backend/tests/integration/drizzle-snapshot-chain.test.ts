import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downDirFor, listMigrations, migrationsDirFor } from '../helpers/postgres';

/**
 * THE DRIZZLE SNAPSHOT CHAIN.
 *
 * ===========================================================================
 * THE TRAP THIS GUARDS.
 *
 * `drizzle-kit generate` does not read the database and does not read the
 * migration SQL. It serialises the TypeScript schema, diffs it against the
 * snapshot belonging to the LAST journal entry, and writes the difference.
 *
 * Migrations 0004-0007 were hand-written rather than generated, so no snapshot
 * was ever written for them and the chain stopped at 0003. The next
 * `db:generate` would therefore have diffed the current schema against
 * `0003_snapshot.json` and re-emitted all four migrations as one new file —
 * DDL that has already been applied, presented as pending work. Applying it
 * would have failed on the first `CREATE TABLE tenants`; the damage is that it
 * looks exactly like a legitimate migration and the reviewer has to know this
 * paragraph to tell the difference.
 *
 * ===========================================================================
 * THE HOLE IS NOW CLOSED BY COLLAPSE, NOT BY RECONSTRUCTION (D-091).
 *
 * D-081 recorded that per-migration snapshots for 0004-0007 could not be
 * reconstructed — those schema states were never committed, and drizzle-kit
 * cannot infer them, so the chain was LINKED (0008.prevId = 0003.id) rather
 * than gapless. That was accepted as a residue and offered to the user as a
 * decision.
 *
 * The decision came back: collapse. 0000-0008 are now ONE baseline migration
 * plus ONE snapshot whose `prevId` is the zero UUID, so the chain has no holes
 * because it has no interior. The superseded files live in
 * `drizzle/_superseded/`, out of the runner's reach and out of the journal.
 *
 * These tests therefore now assert a stronger property than they used to: not
 * "the snapshots that exist link up" but "every journal entry has a snapshot".
 * Weakening them back is how the hole gets dug again.
 */

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

interface Snapshot {
  readonly id: string;
  readonly prevId: string;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function metaDir(): string {
  return resolve(process.cwd(), migrationsDirFor('current'), 'meta');
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(resolve(metaDir(), '_journal.json'), 'utf8')) as Journal;
}

function snapshotFiles(): string[] {
  return readdirSync(metaDir())
    .filter((name) => name.endsWith('_snapshot.json'))
    .sort();
}

function readSnapshot(name: string): Snapshot {
  return JSON.parse(readFileSync(resolve(metaDir(), name), 'utf8')) as Snapshot;
}

describe('every journal entry has a snapshot', () => {
  it('is the invariant that makes db:generate trustworthy', () => {
    /**
     * THE ONE THAT MATTERS. `generate` diffs against the snapshot for the last
     * entry; if that file is absent it silently falls back to the newest one it
     * can find and re-emits everything in between.
     *
     * This test is what fails the next time somebody hand-writes a migration
     * without regenerating the snapshot — which is how the chain broke, and
     * which nothing previously noticed.
     *
     * Before the collapse this could only be asserted of the LAST entry,
     * because 0004-0007 had no snapshots. It is asserted of EVERY entry now,
     * and that is the whole gain from collapsing.
     */
    const expected = readJournal()
      .entries.map((entry) => `${String(entry.idx).padStart(4, '0')}_snapshot.json`)
      .sort();

    expect(snapshotFiles()).toEqual(expected);
  });
});

describe('the snapshots form an unbroken chain', () => {
  it('roots the first snapshot at the zero UUID', () => {
    // A first snapshot whose prevId is anything else is a snapshot that
    // believes it has a predecessor — which after a collapse means a stale file
    // survived the move, and `generate` would diff against a schema state no
    // migration in the directory produces.
    const first = snapshotFiles()[0];
    expect(first).toBeDefined();
    expect(readSnapshot(first ?? '').prevId).toBe(ZERO_UUID);
  });

  it('links each snapshot to its predecessor by prevId', () => {
    const files = snapshotFiles();

    for (let i = 1; i < files.length; i += 1) {
      const previous = readSnapshot(files[i - 1] ?? '');
      const current = readSnapshot(files[i] ?? '');
      expect({ file: files[i], prevId: current.prevId }).toEqual({
        file: files[i],
        prevId: previous.id,
      });
    }
  });

  it('has a snapshot index for every snapshot that is a real journal entry', () => {
    // A stray snapshot for a migration that does not exist would be diffed
    // against by `generate` and would produce a wrong migration silently.
    const journalIndexes = new Set(readJournal().entries.map((entry) => entry.idx));
    for (const file of snapshotFiles()) {
      expect(journalIndexes).toContain(Number(file.slice(0, 4)));
    }
  });
});

describe('the journal and the migration files agree', () => {
  it('names every .sql file on disk, contiguously, in order', () => {
    // `listMigrations()` throws when the two disagree; this asserts the
    // mechanism is live rather than vacuously satisfied by an empty directory.
    const applied = listMigrations();
    expect(applied.length).toBe(readJournal().entries.length);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.map((name) => Number(name.slice(0, 4)))).toEqual(
      applied.map((_, position) => position),
    );
  });

  it('has a hand-written down migration for every forward one', () => {
    /**
     * Plan §4 rule 4 — every migration must run forward AND backward. Drizzle
     * generates no down migrations, so each is written by hand, and "written by
     * hand" is exactly the kind of step that gets skipped on the migration
     * somebody is in a hurry about.
     */
    const down = readdirSync(resolve(process.cwd(), downDirFor('current'))).sort();
    for (const forward of listMigrations()) {
      expect(down).toContain(forward.replace(/\.sql$/, '.down.sql'));
    }
  });
});

describe('the superseded chain is kept whole', () => {
  /**
   * The superseded files are the ORACLE `baseline-collapse.test.ts` diffs
   * against. An oracle that has lost a file is an oracle that silently agrees
   * with whatever it is checking, so the same journal/directory cross-check is
   * applied to it — `listMigrations('superseded')` throws if they disagree.
   */
  it('still cross-checks against its own journal', () => {
    const superseded = listMigrations('superseded');
    expect(superseded.length).toBeGreaterThan(1);
    expect(superseded.map((name) => Number(name.slice(0, 4)))).toEqual(
      superseded.map((_, position) => position),
    );
  });

  it('keeps a down migration for every superseded forward one', () => {
    const down = readdirSync(resolve(process.cwd(), downDirFor('superseded'))).sort();
    for (const forward of listMigrations('superseded')) {
      expect(down).toContain(forward.replace(/\.sql$/, '.down.sql'));
    }
  });

  it('is excluded from the runner: no superseded file is in the live journal', () => {
    // The failure this catches is a superseded migration being re-applied on
    // top of the baseline, which would fail on "already exists" in the best
    // case and silently double-apply DDL in the worst.
    const live = new Set(listMigrations());
    for (const superseded of listMigrations('superseded')) {
      expect(live.has(superseded)).toBe(false);
    }
  });
});
