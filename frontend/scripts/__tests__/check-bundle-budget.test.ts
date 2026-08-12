import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ROUTE_BUDGET_BYTES,
  SHARED_BUDGET_BYTES,
  measure,
  sharedFilesOf,
  violationsOf,
} from '../check-bundle-budget.mjs';

/**
 * THE BUNDLE BUDGET GATE — plan §10.7.
 *
 * The gate itself runs in CI against a real build. What is tested here is its
 * ARITHMETIC, against a synthetic `.next` on disk — because a budget check that
 * is only ever exercised by the thing it guards has never been observed to
 * fail, and §10.7's own rule is that a gate that has never failed is not known
 * to work.
 *
 * The assets below are INCOMPRESSIBLE random bytes on purpose. Repeated text
 * gzips to almost nothing, which would make a "300 kB" fixture pass a 180 kB
 * budget and prove the opposite of what the test claims.
 */

let buildDir: string;

function incompressible(bytes: number): Buffer {
  /*
   * A chained SHA-256, which is deterministic AND has no structure gzip can
   * exploit. A linear congruential generator was tried first and compressed
   * 40 kB down to 11 kB — its low bits are far too regular — which made the
   * fixture prove the opposite of what the test claims.
   */
  const chunks: Buffer[] = [];
  let digest = createHash('sha256').update('bundle-budget-seed').digest();
  let produced = 0;
  while (produced < bytes) {
    chunks.push(digest);
    produced += digest.length;
    digest = createHash('sha256').update(digest).digest();
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

async function writeBuild(files: Record<string, number>, manifest: unknown): Promise<void> {
  for (const [file, size] of Object.entries(files)) {
    const path = join(buildDir, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, incompressible(size));
  }
  await writeFile(join(buildDir, 'app-build-manifest.json'), JSON.stringify(manifest));
}

beforeEach(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'budget-'));
});

afterEach(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

describe('what counts as shared', () => {
  it('is the files every route loads, and nothing else', () => {
    expect(
      sharedFilesOf({
        '/a': ['framework.js', 'main.js', 'a.js'],
        '/b': ['framework.js', 'main.js', 'b.js'],
      }),
    ).toEqual(['framework.js', 'main.js']);
  });

  it('is empty when there are no routes rather than throwing', () => {
    expect(sharedFilesOf({})).toEqual([]);
  });

  it('is the whole set when there is one route', () => {
    expect(sharedFilesOf({ '/a': ['x.js'] })).toEqual(['x.js']);
  });
});

describe('measuring a build', () => {
  it('counts root files into every route, and counts each file once', async () => {
    await writeBuild(
      { 'static/root.js': 40_000, 'static/a.js': 10_000, 'static/b.js': 20_000 },
      {
        rootMainFiles: ['static/root.js'],
        // `/a` lists the root file again — the union must not double-count it.
        pages: { '/a': ['static/root.js', 'static/a.js'], '/b': ['static/b.js'] },
      },
    );

    const { routes, sharedBytes } = await measure(buildDir);
    const byRoute = Object.fromEntries(routes.map((entry) => [entry.route, entry.bytes]));

    // Random bytes barely compress, so sizes land within a few percent.
    expect(sharedBytes).toBeGreaterThan(39_000);
    expect(sharedBytes).toBeLessThan(42_000);
    expect(byRoute['/a']).toBeGreaterThan(49_000);
    expect(byRoute['/b']).toBeGreaterThan(59_000);
  });

  it('refuses a build whose manifest names a file that is not there', async () => {
    // A half-written build. Treating the missing file as zero bytes would turn
    // a broken build into a passing budget.
    await writeFile(
      join(buildDir, 'app-build-manifest.json'),
      JSON.stringify({ rootMainFiles: [], pages: { '/a': ['static/ghost.js'] } }),
    );

    await expect(measure(buildDir)).rejects.toThrow(/not in/);
  });

  it('says what to run when there is no manifest at all', async () => {
    await expect(measure(buildDir)).rejects.toThrow(/npm run build/);
  });
});

describe('the budgets are enforced, not reported', () => {
  it('passes a build inside both budgets', () => {
    expect(
      violationsOf({
        routes: [{ route: '/student', bytes: ROUTE_BUDGET_BYTES - 1 }],
        sharedBytes: SHARED_BUDGET_BYTES - 1,
      }),
    ).toEqual([]);
  });

  it('fails a route one byte over, and names it', () => {
    const violations = violationsOf({
      routes: [
        { route: '/student', bytes: ROUTE_BUDGET_BYTES + 1 },
        { route: '/login', bytes: 1_000 },
      ],
      sharedBytes: 1_000,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('/student');
  });

  it('fails an over-budget shared chunk separately from the routes', () => {
    // The shared chunk is the one every route pays for, so it is called out on
    // its own rather than as "all twelve routes are too big".
    const violations = violationsOf({
      routes: [{ route: '/student', bytes: 1_000 }],
      sharedBytes: SHARED_BUDGET_BYTES + 1,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('shared chunk');
  });

  it('holds the plan\'s numbers', () => {
    // Pinned so a raise is a visible diff with a reason, not a silent drift.
    expect(ROUTE_BUDGET_BYTES).toBe(184_320);
    expect(SHARED_BUDGET_BYTES).toBe(122_880);
  });
});
