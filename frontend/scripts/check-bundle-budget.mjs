/**
 * FIRST-LOAD JS BUDGETS — 02-FRONTEND-IMPLEMENTATION-PLAN.md §10.7.
 *
 * ===========================================================================
 *   per route   <= 180 kB gzipped
 *   shared      <= 120 kB gzipped
 *
 * Both target a mid-range Android phone on 2-5 Mbps, which is what the primary
 * users have. The plan is explicit that these are starting values rather than
 * sacred ones — but that "a raise requires a recorded reason, the same
 * discipline the backend applies to its caps. Silent drift is how a
 * 4G-targeted app becomes unusable on 4G."
 *
 * So the numbers live HERE, in one place, and raising one is a diff somebody
 * has to justify rather than a default nobody notices.
 * ===========================================================================
 *
 * WHAT IS MEASURED. `.next/app-build-manifest.json` lists the client JS files
 * each route loads. A route's first load is the union of its own files and the
 * root files every route carries; the shared figure is the files common to
 * every route. Sizes are gzipped, because that is what crosses the network —
 * comparing raw bytes would flatter every budget by roughly threefold.
 *
 *   node scripts/check-bundle-budget.mjs [--dir .next] [--json]
 */

import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');

/** Gzipped bytes. The plan's numbers, in one place. */
export const ROUTE_BUDGET_BYTES = 180 * 1024;
export const SHARED_BUDGET_BYTES = 120 * 1024;

function parseArgs(argv) {
  const dirIndex = argv.indexOf('--dir');
  return {
    dir: dirIndex === -1 ? join(frontendRoot, '.next') : resolve(argv[dirIndex + 1]),
    json: argv.includes('--json'),
  };
}

/**
 * Gzipped size of one built asset.
 *
 * Default compression level, not 9: a CDN compresses at its own default, and a
 * budget measured at a level nobody serves at is a budget that quietly allows
 * more than it says.
 */
async function gzippedSize(buildDir, file) {
  const path = join(buildDir, file);
  try {
    await stat(path);
  } catch {
    // A manifest entry with no file on disk means the build did not finish.
    // Reporting it as zero would turn a broken build into a passing budget.
    throw new Error(`Manifest lists ${file} but it is not in ${buildDir}.`);
  }
  return gzipSync(await readFile(path)).length;
}

export function sharedFilesOf(routeFiles) {
  const routes = Object.values(routeFiles);
  if (routes.length === 0) return [];
  return routes.reduce((common, files) => common.filter((file) => files.includes(file)));
}

export async function measure(buildDir) {
  const manifestPath = join(buildDir, 'app-build-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `No ${manifestPath}. Run \`npm run build\` first — this gate measures the ` +
        'production bundle and has nothing to measure without one.',
    );
  }

  const rootFiles = Array.isArray(manifest.rootMainFiles) ? manifest.rootMainFiles : [];
  const routeFiles = Object.fromEntries(
    Object.entries(manifest.pages ?? {}).map(([route, files]) => [
      route,
      [...new Set([...rootFiles, ...files])],
    ]),
  );

  const sizes = new Map();
  const sizeOf = async (file) => {
    if (!sizes.has(file)) sizes.set(file, await gzippedSize(buildDir, file));
    return sizes.get(file);
  };

  const shared = sharedFilesOf(routeFiles);
  let sharedBytes = 0;
  for (const file of shared) sharedBytes += await sizeOf(file);

  const routes = [];
  for (const [route, files] of Object.entries(routeFiles)) {
    let bytes = 0;
    for (const file of files) bytes += await sizeOf(file);
    routes.push({ route, bytes });
  }
  routes.sort((a, b) => b.bytes - a.bytes);

  return { routes, sharedBytes };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

export function violationsOf({ routes, sharedBytes }) {
  const violations = [];
  if (sharedBytes > SHARED_BUDGET_BYTES) {
    violations.push(
      `shared chunk is ${kb(sharedBytes)}, over the ${kb(SHARED_BUDGET_BYTES)} budget`,
    );
  }
  for (const { route, bytes } of routes) {
    if (bytes > ROUTE_BUDGET_BYTES) {
      violations.push(`${route} first load is ${kb(bytes)}, over the ${kb(ROUTE_BUDGET_BYTES)} budget`);
    }
  }
  return violations;
}

async function main() {
  const { dir, json } = parseArgs(process.argv.slice(2));
  const measured = await measure(dir);
  const violations = violationsOf(measured);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ...measured, violations }, null, 2)}\n`);
  } else {
    process.stdout.write(`shared: ${kb(measured.sharedBytes)} / ${kb(SHARED_BUDGET_BYTES)}\n`);
    for (const { route, bytes } of measured.routes) {
      const marker = bytes > ROUTE_BUDGET_BYTES ? 'FAIL' : ' ok ';
      process.stdout.write(`${marker} ${route}: ${kb(bytes)} / ${kb(ROUTE_BUDGET_BYTES)}\n`);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`\nBundle budget exceeded:\n${violations.map((v) => `  ${v}`).join('\n')}\n`);
    process.stderr.write(
      '\nRaising a budget is allowed and must be deliberate: change the constant in ' +
        'scripts/check-bundle-budget.mjs and say why in the commit.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nbundle budgets met\n');
}

// Only when run directly, so the test can import `measure` without executing.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
