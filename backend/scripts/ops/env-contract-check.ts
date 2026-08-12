/**
 * THE ENVIRONMENT CONTRACT CHECK — a CI gate, not a runtime one.
 *
 *     npm run ops:env-contract
 *
 * =============================================================================
 * THE DEFECT IT EXISTS TO PREVENT, STATED PRECISELY.
 *
 * `docker/compose.prod.yml` passed VOYAGE_API_KEY, LLM_API_KEY and
 * RESEND_API_KEY. `src/app/container.ts` refused to construct in production
 * without VOYAGE_API_KEY, LLM_API_KEY *and all three Razorpay credentials*. The
 * two files disagreed, nothing compared them, and the disagreement was only
 * observable by deploying: api and worker threw inside the composition root and
 * restart-looped forever (D-250).
 *
 * That is not a mistake anyone made carelessly. It is what happens when the list
 * of required variables lives in TypeScript and the list of supplied variables
 * lives in YAML and no mechanism relates them. Adding the missing lines fixes
 * today; this file is what stops it recurring, and there is a specific,
 * imminent instance to stop: an SMTP mail adapter is landing under
 * `src/platform/mail` in this same wave, with its own production boot refusal.
 * Whoever adds it will not be editing compose.prod.yml.
 *
 * =============================================================================
 * WHY IT RUNS IN CI AND NOT IN THE CONTAINER.
 *
 * The authority is the TypeScript source. The Dockerfile copies `dist/` and
 * `dist-ops/` and deliberately leaves `src/` behind, so nothing running in a
 * production container can read it. CI has the whole repository, so the
 * comparison happens there and the runtime pre-flight carries a cached copy —
 * `scripts/ops/env-contract.ts` — whose staleness is exactly what this file
 * makes fatal.
 *
 * =============================================================================
 * IT SELF-TESTS, BECAUSE A CHECK THAT MATCHES NOTHING REPORTS A PASS.
 *
 * Two gates in this repository were found green while enforcing nothing: an
 * ESLint rule whose files pattern matched no file, and `ci.yml`'s shell-syntax
 * loop, which iterated over an empty `git ls-files` and reported success on a
 * script containing a deliberate syntax error. Every extraction below therefore
 * asserts a plausible minimum on what it found, and says so when it fails.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRODUCTION_OPTIONAL, PRODUCTION_REQUIRED } from './env-contract';

/**
 * Schema variables that production deliberately does NOT pass, each with the
 * reason it is safe.
 *
 * An ALLOW-LIST rather than a heuristic, and the ergonomics are intended to be
 * mildly uncomfortable: the default answer for a new variable is "compose must
 * pass it", and opting out means writing down why in a file a reviewer reads.
 * Everything here has a schema default that production is content with, so an
 * unset value is a decision rather than an omission.
 */
const NOT_PASSED_BY_DESIGN: Readonly<Record<string, string>> = Object.freeze({
  // DATABASE_POOL_MAX WAS EXEMPTED HERE AND IS NOT ANY MORE — D-228.
  //
  // The reason it carried ("schema default 10; used only by migrations and
  // scripts, not the app") was true when it was written and both halves stopped
  // being true: the default is 40, and it is now the ENFORCED per-process
  // ceiling across all four bulkhead pools rather than a variable nothing read.
  // An exemption whose justification has expired is worse than no exemption —
  // it is a reviewer's reason not to look. compose.prod.yml passes it.
  DATABASE_POOL_AUTH_MAX: 'schema default 10 — the §3.1 bulkhead table, retunable without a deploy',
  DATABASE_POOL_CORE_MAX: 'schema default 20 — as above',
  DATABASE_POOL_AI_MAX: 'schema default 8 — as above',
  DATABASE_POOL_WORKER_MAX: 'schema default 6 — as above',
  DATABASE_HNSW_EF_SEARCH: 'schema default 100, which is already above the largest retrieval LIMIT (D-041)',
  HTTP_TIMEOUT_MS: 'schema default 10000',
  HTTP_MAX_RETRIES: 'schema default 2',
  SESSION_TTL_DAYS: 'schema default 30',
  SHUTDOWN_DRAIN_TIMEOUT_MS: 'schema default 15000, and compose stop_grace_period is set to exceed it',
  SHUTDOWN_WORKER_TIMEOUT_MS: 'schema default 30000, and compose stop_grace_period is set to exceed it',
  CORS_ORIGINS: 'RETIRED. Declared in the schema solely so a deployment still carrying it fails loudly; passing it would be the failure',
  // THE ALTERNATIVE TO A VARIABLE THAT *IS* PASSED. The schema refuses
  // TRUSTED_PROXY_CIDRS and TRUSTED_PROXY_HOPS together — they are two ways to
  // express one setting, and with both present one would be silently ignored.
  // compose.prod.yml passes HOPS=1 (exactly one proxy, caddy). Passing this one
  // as well would make the stack refuse to boot, so its absence is the decision.
  TRUSTED_PROXY_CIDRS:
    'MUTUALLY EXCLUSIVE with TRUSTED_PROXY_HOPS, which compose.prod.yml does pass (=1, caddy). Passing both is a boot refusal by design (D-227)',
  SMTP_PORT: 'schema default 587 — STARTTLS, correct for Google Workspace and every other relay this deployment would use; 465 is the only other sensible value and it is set per-deployment',
});

/** Repository root — the directory holding `docker/compose.prod.yml`. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'docker', 'compose.prod.yml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not find docker/compose.prod.yml above ${process.cwd()}. Run this from the repository ` +
      'or from backend/.',
  );
}

function read(path: string): string {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Every `.ts` under a directory, excluding tests. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(path);
        continue;
      }
      if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(path);
    }
  };
  walk(dir);
  return found;
}

interface Findings {
  /** Variables the source says are required in production. */
  readonly requiredBySource: ReadonlySet<string>;
  /** Every variable declared in the env schema. */
  readonly declared: ReadonlySet<string>;
}

/**
 * The two extractions, from the two authorities.
 *
 * RULE A — prose. `container.ts` phrases every refusal as
 * "`NAME` is required in production", and so does its error message. Scanned
 * across all of `src/` rather than just `container.ts`, because the next boot
 * refusal may not be written there — the SMTP one may well live in
 * `platform/mail`.
 *
 * RULE B — a bare quoted identifier. The payments refusal names its variable
 * through a template expression (`${paymentsMissing} is required...`), so Rule A
 * cannot see it; the NAMES are string literals in the ternary above it. Matching
 * only a quote-delimited, wholly-uppercase token is what keeps `NODE_ENV` out —
 * it appears in these files only inside longer sentences.
 */
function extract(root: string): Findings {
  const requiredBySource = new Set<string>();

  const prose = /\b([A-Z][A-Z0-9_]{2,})\b is required in production/g;
  const literal = /(['"])([A-Z][A-Z0-9_]{2,})\1/g;

  const schemaPath = join(root, 'backend', 'src', 'platform', 'config', 'config.schema.ts');
  const schemaSource = read(schemaPath);

  const declared = new Set<string>();
  const declaration = /^ {2}([A-Z][A-Z0-9_]*):\s*z\b/gm;
  for (const match of schemaSource.matchAll(declaration)) {
    const name = match[1];
    if (name !== undefined) declared.add(name);
  }
  if (declared.size < 20) {
    throw new Error(
      `only ${declared.size} variable(s) extracted from config.schema.ts — the declaration ` +
        'pattern has stopped matching. A contract check that reads an empty contract passes ' +
        'everything; failing instead.',
    );
  }

  let scanned = 0;
  for (const path of sourceFiles(join(root, 'backend', 'src'))) {
    const source = read(path);
    scanned += 1;
    for (const match of source.matchAll(prose)) {
      const name = match[1];
      if (name !== undefined && declared.has(name)) requiredBySource.add(name);
    }
    if (path.endsWith('container.ts')) {
      for (const match of source.matchAll(literal)) {
        const name = match[2];
        if (name !== undefined && declared.has(name)) requiredBySource.add(name);
      }
    }
  }
  if (scanned < 50) {
    throw new Error(
      `only ${scanned} source file(s) scanned under backend/src — the walk found almost nothing, ` +
        'so a pass here would mean nothing.',
    );
  }
  if (requiredBySource.size === 0) {
    throw new Error(
      'no production boot refusal was found anywhere in backend/src. container.ts has three of ' +
        'them, so the extraction patterns have stopped matching and this gate is enforcing ' +
        'nothing.',
    );
  }

  return { requiredBySource, declared };
}

function main(): void {
  const root = repoRoot();
  const compose = read(join(root, 'docker', 'compose.prod.yml'));
  const composeExample = read(join(root, 'docker', '.env.prod.example'));
  const backendExample = read(join(root, 'backend', '.env.example'));

  const { requiredBySource, declared } = extract(root);
  const contract = new Set(PRODUCTION_REQUIRED.map((entry) => entry.name));
  const failures: string[] = [];

  // --- 1. The cached contract has not fallen behind the source ---------------
  for (const name of requiredBySource) {
    if (!contract.has(name)) {
      failures.push(
        `${name}: backend/src declares it REQUIRED IN PRODUCTION, but it is not in ` +
          "PRODUCTION_REQUIRED (scripts/ops/env-contract.ts). The runtime pre-flight cannot " +
          'read src/ — the image does not contain it — so an entry here is how the pre-flight ' +
          'learns about it. Add it, with the degraded behaviour it prevents.',
      );
    }
  }

  // --- 2. Compose passes every variable the app declares ---------------------
  //
  // The broadest of the three, and the one that catches a boot requirement
  // nobody wrote a refusal for: a variable that exists in the schema and is
  // absent from production is a variable running on its default, whether or not
  // anyone decided that.
  for (const name of declared) {
    if (name in NOT_PASSED_BY_DESIGN) continue;
    const passed = new RegExp(`^\\s*${name}:`, 'm').test(compose);
    if (!passed) {
      failures.push(
        `${name}: declared in config.schema.ts and NOT passed by docker/compose.prod.yml. ` +
          'Either pass it in the x-backend-env block, or add it to NOT_PASSED_BY_DESIGN in ' +
          'scripts/ops/env-contract-check.ts with the reason its schema default is right for ' +
          'production. Silence is the one option that is not available.',
      );
    }
  }

  // --- 3. Every required variable is documented, with a placeholder ----------
  for (const entry of PRODUCTION_REQUIRED) {
    if (!new RegExp(`^\\s*${entry.name}:`, 'm').test(compose)) {
      failures.push(`${entry.name}: in PRODUCTION_REQUIRED but not passed by compose.prod.yml.`);
    }
    if (!new RegExp(`^${entry.name}=`, 'm').test(composeExample)) {
      failures.push(
        `${entry.name}: not documented in docker/.env.prod.example. An operator filling in a new ` +
          'deployment reads that file; a variable missing from it is a variable they will not set.',
      );
    }
  }
  for (const name of [...contract, ...PRODUCTION_OPTIONAL]) {
    if (!new RegExp(`^#? ?${name}=`, 'm').test(backendExample)) {
      failures.push(
        `${name}: not present in backend/.env.example. That file is the developer-facing surface ` +
          'of the same contract; a variable that only production knows about is a variable a ' +
          'developer discovers by breaking production.',
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      [
        '',
        `env-contract: FAIL — ${failures.length} problem(s).`,
        '',
        ...failures.map((failure) => `  - ${failure}`),
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  process.stdout.write(
    `env-contract: PASS — ${requiredBySource.size} boot refusal(s) found in backend/src, ` +
      `${contract.size} contract entr(ies), ${declared.size} schema variable(s), all passed by ` +
      'compose.prod.yml and documented in both example files\n',
  );
}

main();
