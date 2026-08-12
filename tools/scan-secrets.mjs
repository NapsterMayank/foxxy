#!/usr/bin/env node
/**
 * SECRET SCANNER — fails the build on a credential-shaped value in a tracked
 * file.
 *
 *   node tools/scan-secrets.mjs              scan the working tree
 *   node tools/scan-secrets.mjs --self-test  prove every rule fires, then scan
 *
 * =============================================================================
 * WHY THIS EXISTS. D-096, verbatim:
 *
 *   "The connection string was pasted into `backend/.env.example`, which is
 *    TRACKED and was already staged, rather than `backend/.env`, which is
 *    gitignored. ... STANDING RULE: `.env.example` documents variable NAMES and
 *    placeholder shapes. A real value in it is a defect regardless of whether
 *    the repository is private. Worth an automated check — a pre-commit scan
 *    rejecting anything in `.env.example` that looks like a credential."
 *
 * It was caught by eye. The next one will not be, because the next one will be
 * in a diff that is 400 lines long and looks like an infrastructure change.
 *
 * =============================================================================
 * WHAT IT SCANS.
 *
 *   1. Every TRACKED `.env*` file, at any depth, line by line. This is the
 *      high-signal surface: a `.env*` file exists to hold credentials, so any
 *      value in a tracked one that is not visibly a placeholder is a finding.
 *
 *   2. Every tracked text file, for a small set of UNAMBIGUOUS provider token
 *      shapes (`sk-…`, `rzp_live_…`, `AKIA…`, a three-part JWT). These patterns
 *      do not occur in prose, so they can be scanned repository-wide without
 *      the false positives that would get the check switched off.
 *
 * The split is deliberate. A scanner that flags anything high-entropy across a
 * whole repository produces a wall of findings on hashes, UUIDs, base64 test
 * fixtures and minified assets — and a check nobody can keep green is a check
 * somebody deletes.
 *
 * =============================================================================
 * WHY `git ls-files` AND NOT A DIRECTORY WALK.
 *
 * Because the thing that matters is whether a secret is IN THE REPOSITORY, and
 * that is exactly what "tracked" means. A real `.env` on a developer's disk is
 * gitignored and none of anybody's business; a placeholder file that has been
 * filled in and committed is the incident. Walking the filesystem would report
 * every developer's private `.env` as a failure and teach everyone to ignore it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SELF_TEST = process.argv.includes('--self-test');

// --- what counts as a placeholder --------------------------------------------
//
// Placeholders come first in every check. `backend/.env.example` legitimately
// documents a Supabase pooler string whose password reads `[YOUR-PASSWORD]`,
// and flagging that would be flagging the correct behaviour.
const PLACEHOLDER_PATTERNS = [
  /^$/,
  /^<[^>]*>$/, //            <generate-a-32-byte-random-password>
  /^\[[^\]]*\]$/, //         [YOUR-PASSWORD]
  /^\$\{[^}]*\}$/, //        ${FROM_SOMEWHERE_ELSE}
  /^(your|my|the)[-_]/i,
  /^(change|replace)[-_]?(me|this)/i,
  /^(placeholder|example|sample|dummy|redacted|todo|tbd|none|null|unset)$/i,
  /^x{3,}$/i,
  /^\*{3,}$/,
];

/**
 * Values that are real, committed, and CORRECT to have committed.
 *
 * An allow-list rather than a heuristic, because "looks like a development
 * password" is not a property a regular expression can decide. Every entry is
 * a local-only default that appears in `docker/compose.yml` and grants access
 * to nothing outside a developer's laptop.
 *
 * Adding to this list should feel uncomfortable. That is the intended
 * ergonomics: it is the one place where a reviewer is being asked to agree that
 * a literal secret-shaped value is safe.
 */
const ALLOWED_VALUES = new Set([
  'foxxy_dev_password', // docker/compose.yml default, localhost only
  'foxxy', // POSTGRES_USER / POSTGRES_DB
  'foxxy_session', // cookie NAME, not a value
  'selftest', // this scanner's own fixtures
]);

/** Hosts that cannot be reached from outside the machine or the compose network. */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'postgres',
  'valkey',
  'redis',
  'db',
  'cache',
  'backend-api',
]);

const SECRET_KEY_PATTERN =
  /(PASSWORD|PASSWD|SECRET|TOKEN|_KEY|APIKEY|API_KEY|CREDENTIAL|PASSPHRASE|PRIVATE|DSN|AUTH)$/i;

/** Unambiguous provider token shapes. Scanned repository-wide. */
const TOKEN_PATTERNS = [
  { name: 'OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Razorpay LIVE key', pattern: /\brzp_live_[A-Za-z0-9]{10,}\b/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Resend API key', pattern: /\bre_[A-Za-z0-9]{24,}\b/ },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/** Files exempt from the repository-wide token scan: they DEFINE the patterns. */
const TOKEN_SCAN_EXEMPT = [/^tools\/scan-secrets\.mjs$/];

const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mp3|wasm|node|lock)$/i;

function isPlaceholder(value) {
  const trimmed = stripQuotes(value.trim());
  if (ALLOWED_VALUES.has(trimmed)) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * A URL with an embedded password. THE D-096 SHAPE, exactly.
 *
 * The host check is what keeps `postgres://foxxy:foxxy_dev_password@localhost`
 * out of the findings while catching the same string pointed at a pooler on the
 * public internet — which is the difference between a documented dev default
 * and a live credential.
 */
function findUrlCredential(value) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@([^/\s:]+)/i.exec(stripQuotes(value.trim()));
  if (match === null) return null;
  const [, userInfo, host] = match;
  const separator = userInfo.indexOf(':');
  if (separator === -1) return null; // user, no password
  const password = userInfo.slice(separator + 1);
  if (password.length === 0 || isPlaceholder(password)) return null;
  if (LOCAL_HOSTS.has(host.toLowerCase())) return null;
  return `connection string with an embedded password for a NON-LOCAL host (${host})`;
}

/**
 * The line-scanning rule, over CONTENT rather than a path.
 *
 * Separated from the file read for one reason: the self-test drives these exact
 * rules against fixtures without writing anything to disk. A self-test that
 * exercised a re-implementation of the rules would prove that the
 * re-implementation works.
 */
function scanEnvContent(path, content, findings) {
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;

    const withoutExport = trimmed.replace(/^export\s+/, '');
    const separator = withoutExport.indexOf('=');
    if (separator === -1) return;

    const key = withoutExport.slice(0, separator).trim();
    const value = withoutExport.slice(separator + 1).trim();
    const at = { file: path, line: index + 1, key };

    const urlFinding = findUrlCredential(value);
    if (urlFinding !== null) {
      findings.push({ ...at, reason: urlFinding });
      return;
    }

    if (!SECRET_KEY_PATTERN.test(key)) return;
    if (isPlaceholder(value)) return;

    // Eight characters: below that it cannot be a usable credential, and the
    // false positives (a short value under a key that happens to end in _KEY)
    // are not worth the noise.
    if (stripQuotes(value).length < 8) return;

    findings.push({
      ...at,
      reason:
        `'${key}' holds a non-placeholder value in a TRACKED file. ` +
        `A tracked .env* documents variable NAMES and placeholder SHAPES only (D-096).`,
    });
  });
}

function scanEnvFile(path, findings) {
  scanEnvContent(path, readFileSync(path, 'utf8'), findings);
}

function scanForTokens(path, findings) {
  if (TOKEN_SCAN_EXEMPT.some((pattern) => pattern.test(path))) return;
  if (BINARY_EXTENSIONS.test(path)) return;
  try {
    if (statSync(path).size > 2_000_000) return;
  } catch {
    return; // deleted between ls-files and here
  }

  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  if (content.includes('\u0000')) return; // binary despite the extension

  content.split(/\r?\n/).forEach((line, index) => {
    for (const { name, pattern } of TOKEN_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          file: path,
          line: index + 1,
          key: name,
          reason: `${name} found in a tracked file`,
        });
      }
    }
  });
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return output.split('\u0000').filter((name) => name.length > 0);
}

function isEnvFile(path) {
  const base = path.split('/').pop() ?? '';
  return base === '.env' || base.startsWith('.env.');
}

function scanRepository() {
  const findings = [];
  for (const path of trackedFiles()) {
    if (isEnvFile(path)) scanEnvFile(path, findings);
    scanForTokens(path, findings);
  }
  return findings;
}

// =============================================================================
// SELF-TEST — the check that the check works.
//
// Five pieces of enforcement in this repository have looked installed and
// enforced nothing. A secret scanner is a particularly bad candidate for the
// sixth, because its healthy output and its broken output are the same empty
// list.
//
// So every rule is driven against a fixture that MUST produce a finding, and
// against one that must NOT. `--self-test` runs them before scanning, and CI
// runs it that way.
// =============================================================================
function selfTest() {
  const cases = [
    {
      name: 'the D-096 shape: a real password in a pooler connection string',
      content:
        'SOURCE_DATABASE_URL=postgresql://postgres.abcd:Hunter2Hunter2@aws-1-ap-south-1.pooler.supabase.com:5432/postgres',
      expectFinding: true,
    },
    {
      name: 'a documented placeholder password in the same shape',
      content:
        'SOURCE_DATABASE_URL=postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres',
      expectFinding: false,
    },
    {
      name: 'the committed localhost dev default',
      content: 'DATABASE_URL=postgres://foxxy:foxxy_dev_password@localhost:5433/foxxy',
      expectFinding: false,
    },
    {
      name: 'a filled-in POSTGRES_PASSWORD',
      content: 'POSTGRES_PASSWORD=x7Qv2LmZp0RtYu9A',
      expectFinding: true,
    },
    {
      name: 'a placeholder POSTGRES_PASSWORD',
      content: 'POSTGRES_PASSWORD=<generate-a-32-byte-random-password>',
      expectFinding: false,
    },
    {
      name: 'an empty optional key',
      content: 'RESEND_API_KEY=',
      expectFinding: false,
    },
    {
      name: 'a commented-out real value',
      content: '# RAZORPAY_KEY_SECRET=abcdefghijklmnop',
      expectFinding: false,
    },
    {
      name: 'a non-secret variable with a real value',
      content: 'SESSION_COOKIE_NAME=foxxy_session',
      expectFinding: false,
    },
  ];

  let failures = 0;
  process.stdout.write('secret-scan self-test:\n');

  for (const testCase of cases) {
    const findings = [];
    // THE SAME FUNCTION THE REAL SCAN USES, given content instead of a path.
    // Nothing is written to disk, and — more importantly — nothing is
    // re-implemented here: a self-test against a copy of the rules proves the
    // copy works.
    scanEnvContent('(fixture)', testCase.content, findings);

    const fired = findings.length > 0;
    const ok = fired === testCase.expectFinding;
    if (!ok) failures += 1;
    process.stdout.write(
      `  ${ok ? 'ok  ' : 'FAIL'}  ${testCase.expectFinding ? 'must flag    ' : 'must not flag'}  ${testCase.name}\n`,
    );
  }

  // Repository-wide token patterns.
  const tokenCases = [
    { name: 'JWT', content: 'X=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno' },
    { name: 'Razorpay live key', content: 'key = "rzp_live_A1b2C3d4E5f6G7"' },
    { name: 'AWS access key id', content: 'AKIAIOSFODNN7EXAMPLE' },
  ];
  for (const testCase of tokenCases) {
    const fired = TOKEN_PATTERNS.some(({ pattern }) => pattern.test(testCase.content));
    if (!fired) failures += 1;
    process.stdout.write(
      `  ${fired ? 'ok  ' : 'FAIL'}  must flag     token pattern: ${testCase.name}\n`,
    );
  }

  if (failures > 0) {
    process.stderr.write(
      `\nsecret-scan SELF-TEST FAILED: ${failures} case(s). The scanner is not enforcing what it claims.\n`,
    );
    process.exit(2);
  }
  process.stdout.write('secret-scan self-test: all cases behaved as required\n\n');
}

// --- main ---------------------------------------------------------------------
if (SELF_TEST) selfTest();

const findings = scanRepository();

if (findings.length === 0) {
  process.stdout.write('secret-scan: clean — no credential-shaped values in tracked files\n');
  process.exit(0);
}

process.stderr.write(`\nsecret-scan: ${findings.length} FINDING(S)\n\n`);
for (const finding of findings) {
  process.stderr.write(`  ${finding.file}:${finding.line}\n    ${finding.reason}\n\n`);
}
process.stderr.write(
  'A tracked .env* file documents variable NAMES and PLACEHOLDER SHAPES. A real value in\n' +
    'one is a defect regardless of whether the repository is private (D-096).\n\n' +
    'If a finding is a false positive, add the exact value to ALLOWED_VALUES in\n' +
    'tools/scan-secrets.mjs — in a commit whose diff makes a reviewer look at it.\n\n' +
    'IF A REAL CREDENTIAL WAS COMMITTED: rotate it first. Removing it from the file does\n' +
    'not remove it from the history.\n',
);
process.exit(1);
