/**
 * platform/pii — one place that decides what personal data looks like.
 *
 * ===========================================================================
 * WHY THIS IS SEPARATE FROM `platform/logger/redaction.ts`.
 *
 * They solve the same problem at different layers and neither can do the
 * other's job. Pino's `redact` works on a fixed list of PATHS, resolved when
 * the logger is built — it is fast, it is the right tool for log objects whose
 * shape is known, and it cannot see inside a `Record<string, unknown>` that a
 * caller assembled at runtime.
 *
 * `audit_log.metadata` and `metrics_events.tags` are exactly that: arbitrary
 * jsonb, written by any module, PERSISTED FOREVER. A path list cannot cover
 * them because nobody knows the paths in advance.
 *
 * So this module works on VALUES rather than paths, and it is used at the two
 * write sites where the data outlives the process.
 *
 * ===========================================================================
 * TWO MECHANISMS, BECAUSE ONE IS NOT ENOUGH.
 *
 *   BY KEY   — a key whose NAME says it holds personal data is dropped whole,
 *              whatever it contains. `{ email: 'a@b.c' }` and
 *              `{ email: 'unknown' }` are both dropped: the second is harmless
 *              today, and the day it stops being harmless nobody will revisit
 *              this decision.
 *
 *   BY VALUE — a value that LOOKS like an email address or a phone number is
 *              replaced with a marker, whatever key it arrived under. This is
 *              what catches `{ note: 'contacted at a@b.c' }`, which no key list
 *              can.
 *
 * Key-dropping is deliberately more aggressive than value-redaction. Losing a
 * metadata key costs a slightly less useful audit row; keeping one costs a
 * permanent record of a child's phone number.
 *
 * ===========================================================================
 * REDACT, DO NOT REJECT — and this was a real decision.
 *
 * The alternative was to throw when PII is detected. Rejected, because the
 * caller is a privileged action: password reset, link revocation, logout-all.
 * Throwing would mean that a mistake in AUDIT METADATA fails the SECURITY
 * OPERATION — a bug in the record of the thing breaking the thing itself. The
 * password reset must succeed; the audit row must be clean; those are both
 * achievable and rejecting achieves only the second.
 *
 * It is not silent. `scrubRecord` reports what it changed, and `platform/audit`
 * logs at `warn` and emits a metric whenever anything was scrubbed, because a
 * module putting PII into an audit payload is a defect somebody has to fix at
 * the source. Redaction is the safety net, not the design.
 *
 * ===========================================================================
 * WHAT THIS IS NOT. It is not a guarantee. A determined caller can defeat any
 * pattern matcher — 'a (at) b (dot) c' passes straight through. The rule that
 * actually protects the data is "metadata is identifiers and counts", stated on
 * the column comment and in review. This catches the accident, not the intent.
 */

export const PII_REDACTED = '[redacted]';

/**
 * Key names that are dropped outright, matched case-insensitively against the
 * key with separators removed — so `email`, `Email`, `user_email`, `userEmail`
 * and `EMAIL_ADDRESS` are all caught by the single entry `email`.
 *
 * Deliberately short. A long list is a list nobody reads and everybody trusts.
 */
export const PII_KEY_FRAGMENTS: readonly string[] = [
  'email',
  'phone',
  'mobile',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'ipaddress',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'username',
  'address',
  'dob',
  'dateofbirth',
];

/**
 * An email address, loosely. Deliberately loose: this is a detector, not a
 * validator, and a detector that misses `a@b.c` because it is not a real
 * top-level domain has failed at its only job.
 */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * An Indian mobile number in the shapes people actually type: 10 digits
 * starting 6-9, optionally with +91 / 0091 / 0 in front and spaces or hyphens
 * anywhere inside.
 *
 * ===========================================================================
 * THE BOUNDARY IS `[\w-]`, NOT `\d`, AND THAT IS A FIX RATHER THAN A CHOICE.
 *
 * This pattern used to anchor on `(?<!\d)` / `(?!\d)`, with a comment claiming
 * that stopped it firing on "a UUID fragment or a millisecond timestamp". It
 * did not, because the pattern allows `-` as an INTERNAL separator and a UUID is
 * hyphen-separated hex. `07416683-378b-4bff-…` contains the run `07416683-378`,
 * which is a leading `0`, then `74`, then eight more digits across a hyphen —
 * a textbook match. Measured: 1.99% of random UUIDs matched.
 *
 * The damage was not a noisy log. `audit_log` is APPEND-ONLY (D-063) and its
 * metadata is identifiers by design (D-064), so one row in fifty had an
 * identifier silently replaced with `[redacted]`, permanently, with no way to
 * recover it — and it surfaced as an intermittently failing test, because
 * whether it happened depended on which UUID `gen_random_uuid()` produced.
 *
 * A digit boundary cannot express the intent. The intent is "this run of digits
 * is the whole token", and a token boundary is what says so: a real phone number
 * is never immediately adjacent to a letter, a digit or a hyphen, and an
 * identifier that contains a phone-shaped run always is. Verified against every
 * shape people actually type — bare, `+91`, `0091`, leading `0`, and grouped
 * with spaces or hyphens — and against 300,000 random UUIDs and timestamps,
 * where it now matches none.
 */
const PHONE_PATTERN = /(?<![\w-])(?:(?:\+|00)?91[\s-]?|0)?[6-9]\d(?:[\s-]?\d){8}(?![\w-])/;

/** Normalises a key for matching: lower case, separators and digits removed. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

/** True when the KEY NAME says the value is personal data. */
export function isPiiKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return PII_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/** True when the VALUE looks like an email address or a phone number. */
export function looksLikePii(value: string): boolean {
  return EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value);
}

/**
 * The outcome of scrubbing, so the caller can be loud about it.
 *
 * `changed` rather than "was PII found": the caller needs to know whether the
 * value it is about to persist differs from the value it was handed, which is
 * the question that matters and the only one it can act on.
 */
export interface ScrubResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly changed: boolean;
  /** Keys dropped or redacted, for the warning. NEVER the values. */
  readonly affectedKeys: readonly string[];
}

/**
 * Depth limit for nested objects.
 *
 * Metadata is meant to be flat — identifiers and counts. A bound exists because
 * an unbounded recursive walk over caller-supplied jsonb is a stack-overflow
 * lever, and because anything nested five deep is not metadata, it is a payload
 * dump that should not be in an audit row at all.
 */
const MAX_DEPTH = 5;

function scrubValue(value: unknown, depth: number, affected: string[], path: string): unknown {
  if (typeof value === 'string') {
    if (looksLikePii(value)) {
      affected.push(path);
      return PII_REDACTED;
    }
    return value;
  }

  // Numbers, booleans and null pass through untouched. A number cannot be an
  // email address, and redacting counts would defeat the purpose of the table.
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    affected.push(path);
    return PII_REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      scrubValue(entry, depth + 1, affected, `${path}[${String(index)}]`),
    );
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      if (isPiiKey(key)) {
        affected.push(childPath);
        continue;
      }
      out[key] = scrubValue(entry, depth + 1, affected, childPath);
    }
    return out;
  }

  // undefined, functions, symbols, bigint. None is representable in jsonb, and
  // guessing at a representation is how a `[object Object]` ends up in a
  // permanent record.
  affected.push(path);
  return PII_REDACTED;
}

/**
 * Scrubs a metadata or tag record. PII-shaped keys are DROPPED; PII-shaped
 * values are REPLACED with `[redacted]`.
 */
export function scrubRecord(input: Readonly<Record<string, unknown>>): ScrubResult {
  const affected: string[] = [];
  const value = scrubValue(input, 0, affected, '') as Record<string, unknown>;
  return { value, changed: affected.length > 0, affectedKeys: affected };
}

/**
 * The same scrub for a flat string map — metric tags, which are always
 * `Record<string, string>`.
 *
 * A separate function rather than a cast because the return type matters to the
 * caller: `MetricsPort` tags are strings all the way down, and a scrub that
 * widened them to `unknown` would push the cast into every adapter.
 */
export function scrubTags(input: Readonly<Record<string, string>>): {
  readonly tags: Readonly<Record<string, string>>;
  readonly changed: boolean;
} {
  const out: Record<string, string> = {};
  let changed = false;
  for (const [key, value] of Object.entries(input)) {
    if (isPiiKey(key)) {
      changed = true;
      continue;
    }
    if (looksLikePii(value)) {
      changed = true;
      out[key] = PII_REDACTED;
      continue;
    }
    out[key] = value;
  }
  return { tags: out, changed };
}
