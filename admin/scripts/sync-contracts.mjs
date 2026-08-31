/**
 * Copies the backend wire contracts into `src/lib/api/generated/`.
 *
 * ===========================================================================
 * WHY A GENERATOR AND NOT AN IMPORT.
 *
 * `02-FRONTEND-IMPLEMENTATION-PLAN.md` §5.1 is absolute: a type the backend
 * returns is defined ONCE, in `backend/src/shared/contracts/`, and a
 * hand-written mirror on the frontend is forbidden — mirrors drift, and the
 * drift surfaces in production.
 *
 * A direct `import` across the two packages is the obvious way to honour that
 * and it cannot work here: `frontend/Dockerfile` copies `frontend/` and nothing
 * else, so `../backend/src` does not exist inside the image and the production
 * build would fail on a path that resolves perfectly on a developer's machine.
 * §5.1 anticipates exactly this — "if the two packages cannot import from each
 * other directly, generate the types from the backend contracts as a build
 * step — but there is still exactly one definition".
 *
 * So: the backend files are copied verbatim, committed, and `--check` proves
 * the copy is current. Backend still owns every declaration. The frontend never
 * edits a generated file; `contracts-drift.test.ts` fails the build if anyone
 * does, and fails it again if the backend changes and this is not re-run.
 * ===========================================================================
 *
 *   node scripts/sync-contracts.mjs           write
 *   node scripts/sync-contracts.mjs --check   verify, non-zero on any diff
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const backendShared = resolve(appRoot, '..', 'backend', 'src', 'shared');
const backendErrors = resolve(
  appRoot,
  '..',
  'backend',
  'src',
  'platform',
  'errors',
  'app-error.ts',
);
const outRoot = join(appRoot, 'src', 'lib', 'api', 'generated');

/**
 * The constants the contracts import. Copied whole rather than tree-shaken:
 * a partial copy is a second place to decide what a `Grade` is.
 */
const CONSTANT_FILES = ['curriculum.ts', 'foxy.ts', 'practice.ts', 'roles.ts'];

const BANNER = `/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * \`npm run contracts:sync\` from \`admin/\`. \`contracts-drift.test.ts\`
 * fails when this file and its backend original disagree.
 */

`;

/** The `ERROR_CODES` object, lifted out of the backend's error hierarchy. */
async function extractErrorCodes() {
  const source = await readFile(backendErrors, 'utf8');
  const start = source.indexOf('export const ERROR_CODES = {');
  if (start === -1) {
    throw new Error(
      `ERROR_CODES declaration not found in ${backendErrors}. ` +
        'It was renamed or moved; fix this script rather than hand-writing the union.',
    );
  }
  const end = source.indexOf('} as const;', start);
  if (end === -1) {
    throw new Error(
      `ERROR_CODES in ${backendErrors} no longer ends with "} as const;". ` +
        'Fix this script rather than hand-writing the union.',
    );
  }
  const declaration = source.slice(start, end + '} as const;'.length);

  return `${declaration}

/**
 * Every code the API can return. \`5.6\`'s treatment table switches over this,
 * so a code the backend adds and the frontend does not handle is a TYPE ERROR
 * rather than a screen that renders nothing.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
`;
}

async function collect() {
  const files = new Map();

  for (const name of CONSTANT_FILES) {
    files.set(
      join('constants', name),
      BANNER + (await readFile(join(backendShared, 'constants', name), 'utf8')),
    );
  }

  const contractDir = join(backendShared, 'contracts');
  const contractNames = (await readdir(contractDir))
    .filter((name) => name.endsWith('.contract.ts'))
    .sort();
  if (contractNames.length === 0) {
    throw new Error(`No contracts found in ${contractDir}.`);
  }
  for (const name of contractNames) {
    files.set(join('contracts', name), BANNER + (await readFile(join(contractDir, name), 'utf8')));
  }

  files.set('error-codes.ts', BANNER + (await extractErrorCodes()));

  return files;
}

async function main() {
  const check = process.argv.includes('--check');
  const files = await collect();
  const stale = [];

  for (const [relative, contents] of files) {
    const target = join(outRoot, relative);
    let current = null;
    try {
      current = await readFile(target, 'utf8');
    } catch {
      current = null;
    }
    if (current === contents) continue;

    if (check) {
      stale.push(relative);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
    process.stdout.write(`wrote ${relative}\n`);
  }

  if (check && stale.length > 0) {
    process.stderr.write(
      `Generated contracts are stale:\n${stale.map((name) => `  ${name}`).join('\n')}\n` +
        'Run `npm run contracts:sync` and commit the result.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(check ? 'contracts up to date\n' : 'contracts synced\n');
}

await main();
