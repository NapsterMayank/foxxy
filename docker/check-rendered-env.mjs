#!/usr/bin/env node
/**
 * THE RENDERED PRODUCTION ENVIRONMENT MUST BE BOOTABLE, NOT MERELY VALID.
 *
 *     docker compose -f compose.prod.yml --env-file .env.prod config --format json \
 *       | node check-rendered-env.mjs
 *
 * Run by the `infra` job in `.github/workflows/ci.yml`, immediately after the
 * step that asserts `compose.prod.yml` parses.
 *
 * =============================================================================
 * THE TWO CLAIMS ARE DIFFERENT, AND ONLY ONE OF THEM WAS BEING MADE.
 *
 * `docker compose config` proves the file is well-formed and that every
 * `${VAR:?...}` has a value. It proves nothing about whether the application can
 * start with the result, because to compose every value is just a string.
 *
 * `LLM_MODEL: ''` is the case that matters. `config` is perfectly happy with it.
 * The application is not: these variables are `z.string().min(1).optional()`,
 * and OPTIONAL MEANS ABSENT — an empty string is not absent, it is a PRESENT
 * value that fails `min(1)` and stops the process before it serves a request.
 *
 * `.env.prod.example` carried exactly that:
 *
 *     LLM_MODEL=
 *     LLM_BASE_URL=
 *
 * and that file is what an operator copies to `.env.prod`. So FOLLOWING THE
 * DOCUMENTATION produced a stack that could not boot — the D-250 crash loop
 * rebuilt inside the file written to document its fix. Measured, not reasoned:
 * with those two lines present the container receives `LLM_MODEL=""` and the
 * schema reports `LLM_MODEL: String must contain at least 1 character(s)`.
 *
 * `compose.prod.yml` uses the bare `KEY:` form for optional variables precisely
 * so an unset one stays unset. That only works if the env file does not assign
 * them empty — the two halves have to agree, and nothing made them. This checks
 * the RENDERED RESULT, which is the only place the disagreement is visible.
 *
 * THE FIX for a variable this flags is to COMMENT THE ASSIGNMENT OUT in
 * `docker/.env.prod.example`, with its placeholder shape, and leave the bare
 * `KEY:` in `compose.prod.yml`.
 *
 * =============================================================================
 * IT SELF-TESTS, BECAUSE A CHECK THAT INSPECTS NOTHING REPORTS A PASS.
 *
 * Two gates in this repository were found green while enforcing nothing: an
 * ESLint rule whose `files` pattern matched no file, and `ci.yml`'s own
 * shell-syntax loop, which iterated over an empty `git ls-files` and reported
 * success on a script containing a deliberate syntax error. A rendered compose
 * file whose shape has changed — a different key for the environment map, an
 * array form instead of an object — would make the loop below find zero values
 * and print a pass. So the floors are asserted and the failure says why.
 */

const MIN_SERVICES = 5;
const MIN_VALUES = 20;

function fail(message) {
  process.stderr.write(`\nrendered-env: FAIL\n\n${message}\n\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
if (raw.trim().length === 0) {
  fail(
    'nothing arrived on stdin. Pipe `docker compose config --format json` into this script.\n' +
      'An empty input must not be read as an empty problem list.',
  );
}

let rendered;
try {
  rendered = JSON.parse(raw);
} catch (error) {
  fail(`stdin was not JSON: ${error.message}. Did the compose invocation omit --format json?`);
}

const services = rendered.services ?? {};
const names = Object.keys(services);
if (names.length < MIN_SERVICES) {
  fail(
    `only ${names.length} service(s) found in the rendered compose file, expected at least ` +
      `${MIN_SERVICES}. The output shape has changed and this check is inspecting almost ` +
      'nothing — which would otherwise print a pass.',
  );
}

const empty = [];
let inspected = 0;
for (const name of names) {
  const environment = services[name]?.environment ?? {};
  // The object form is what `--format json` emits. An ARRAY (`KEY=value`
  // strings) would silently iterate as indices and compare nothing, so the
  // shape is asserted rather than assumed.
  if (Array.isArray(environment)) {
    fail(
      `service '${name}' rendered its environment as an ARRAY. This check reads the object ` +
        'form; over an array it would compare list indices and find nothing wrong, forever.',
    );
  }
  for (const [key, value] of Object.entries(environment)) {
    inspected += 1;
    if (value === '') empty.push(`${name}.${key}`);
  }
}

if (inspected < MIN_VALUES) {
  fail(
    `only ${inspected} environment value(s) inspected across ${names.length} service(s), ` +
      `expected at least ${MIN_VALUES}. The backend services pass far more than that, so this ` +
      'is a broken extraction rather than a lean deployment.',
  );
}

if (empty.length > 0) {
  fail(
    `${empty.length} environment value(s) render as an EMPTY STRING:\n` +
      empty.map((entry) => `  - ${entry}`).join('\n') +
      '\n\nAn empty string REACHES THE CONTAINER and fails `z.string().min(1)`, so the process ' +
      'exits at boot and `restart: unless-stopped` loops it. Optional means ABSENT, not blank.\n' +
      'Fix: comment the assignment out in docker/.env.prod.example (keep its placeholder shape) ' +
      'and leave the bare `KEY:` form in docker/compose.prod.yml.',
  );
}

process.stdout.write(
  `rendered-env: PASS — ${inspected} environment value(s) across ${names.length} service(s), ` +
    'none empty\n',
);
