/**
 * DEPLOYABLE ISOLATION — 06-FRONTEND-SEPARATION-PLAN.md, enforced as a §10.7
 * CI gate ("`website/` and `frontend/` import each other" fails the build).
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT AN ESLINT RULE.
 *
 * The separation is a DEPLOYMENT property, not a style one: the product image
 * is built from `frontend/` alone, and the marketing image from `website/`
 * alone. An import that crosses between them type-checks, lints, passes every
 * unit test, and fails in Docker — where the other directory does not exist.
 *
 * ESLint can express "do not import that path", but it only sees files it is
 * configured to lint. This walks the source tree itself, so a file nobody
 * remembered to include in the lint config is still checked.
 *
 * THE ONE PERMITTED CROSSING is `src/lib/api/generated/`, which is a COPY of
 * the backend's contracts committed into this repository — no import leaves the
 * directory at build time. `contracts-drift.test.ts` keeps it honest.
 * ===========================================================================
 *
 *   node scripts/check-app-isolation.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const sourceRoot = join(appRoot, 'src');

/** Import specifiers no file in this application may name. */
const FORBIDDEN = [
  { pattern: /(^|['"( ])\.\.\/(\.\.\/)*website\//, why: 'the marketing application' },
  { pattern: /(^|['"( ])\.\.\/(\.\.\/)*backend\//, why: 'the backend package' },
  { pattern: /from\s+['"]website\//, why: 'the marketing application' },
  { pattern: /from\s+['"]backend\//, why: 'the backend package' },
];

/**
 * Any import that climbs out of `src/`.
 *
 * Not a style rule: `../../..` reaching the repository root is exactly how the
 * first cross-package import gets written, and it is invisible in review
 * because it looks like an ordinary relative path.
 */
const ESCAPING_IMPORT = /from\s+['"](\.\.\/){3,}/;

async function* sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(path);
      continue;
    }
    if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry.name)) yield path;
  }
}

async function main() {
  const violations = [];

  for await (const path of sourceFiles(sourceRoot)) {
    const contents = await readFile(path, 'utf8');
    const shown = relative(appRoot, path).replaceAll('\\', '/');

    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(contents)) {
        violations.push(`${shown} imports from ${why}`);
      }
    }
    if (ESCAPING_IMPORT.test(contents)) {
      violations.push(`${shown} has a relative import climbing out of src/`);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `Deployable isolation broken:\n${violations.map((line) => `  ${line}`).join('\n')}\n\n` +
        'The product image is built from frontend/ alone. An import that crosses out of ' +
        'it compiles here and fails in Docker, where the other directory does not exist.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('deployable isolation intact\n');
}

await main();
