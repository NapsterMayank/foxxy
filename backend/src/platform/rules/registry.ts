import type { Rule, RuleCode, RuleVersion } from './rule';

/**
 * THE REGISTRY — the set of rules that exist, and the resolution of a code to
 * the version that applies at an instant.
 *
 * ===========================================================================
 * A DUPLICATE `(code, version)` IS REJECTED AT CONSTRUCTION, LOUDLY.
 *
 * Two rules claiming the same stamp is the one failure this mechanism cannot
 * survive: every evaluation would record a version that no longer identifies the
 * logic that ran, and every stored decision made before the collision would
 * become unreproducible — silently, and retroactively. Refusing at construction
 * turns that into a boot failure, which is a bad morning; allowing it turns it
 * into a data-integrity incident discovered months later, which is a bad quarter.
 *
 * The registry is built ONCE and is immutable. There is no `register()` that can
 * be called from a request handler: a rule set that can change between two
 * evaluations makes "same inputs, same output" false by construction.
 *
 * ===========================================================================
 * `resolve` PICKS THE HIGHEST VERSION ALREADY ACTIVE — NOT THE HIGHEST VERSION.
 *
 * A version with a future `activeFrom` is REGISTERED but not yet applied, which
 * is how a rule change ships ahead of the date it takes effect without a
 * deployment on the day. Resolving at an instant BEFORE any version was active
 * fails loudly rather than falling back to the earliest: quietly applying a rule
 * that did not exist yet would misattribute every backfilled decision.
 *
 * Pure. The instant arrives as an argument.
 */

/** Thrown when a registry is built from a rule set that cannot be trusted. */
export class DuplicateRuleError extends Error {
  readonly code: RuleCode;
  readonly version: RuleVersion;

  constructor(code: RuleCode, version: RuleVersion) {
    super(
      `platform/rules: duplicate rule ${code}@${String(version)}. ` +
        'A version identifies logic; two rules cannot share one, because every ' +
        'evaluation ever stamped with it would become ambiguous.',
    );
    this.name = 'DuplicateRuleError';
    this.code = code;
    this.version = version;
  }
}

/**
 * Thrown when a caller asks for a rule that is not registered.
 *
 * FAILS LOUDLY, deliberately. An unknown code is a typo or a deleted rule still
 * being referenced, and both are programming errors. Returning `undefined` would
 * let a caller treat "the rule did not fire" and "the rule does not exist" as
 * the same thing — the difference between a student who is fine and a check that
 * silently stopped running.
 *
 * A plain `Error` rather than one of `platform/errors`' HTTP-shaped classes:
 * those carry a status code and a client-safe payload, and this is not a request
 * fault. It is a misconfiguration that no user should ever be able to trigger.
 */
export class UnknownRuleError extends Error {
  readonly code: RuleCode;

  constructor(code: RuleCode, known: readonly RuleCode[]) {
    super(
      `platform/rules: no rule registered under "${code}". ` +
        `Registered codes: ${known.length === 0 ? '(none)' : known.join(', ')}.`,
    );
    this.name = 'UnknownRuleError';
    this.code = code;
  }
}

/** Thrown when a code exists but no version of it was active at the instant asked about. */
export class NoActiveRuleVersionError extends Error {
  readonly code: RuleCode;
  readonly at: Date;

  constructor(code: RuleCode, at: Date, earliest: Date) {
    super(
      `platform/rules: rule "${code}" has no version active at ${at.toISOString()}; ` +
        `its earliest version begins at ${earliest.toISOString()}.`,
    );
    this.name = 'NoActiveRuleVersionError';
    this.code = code;
    this.at = at;
  }
}

export interface RuleRegistry<Facts, Outcome> {
  /**
   * Every registered rule, in a STABLE order: by code, then by version, both
   * ascending. Evaluation order is a property of the engine, never of the array
   * literal a caller happened to write.
   */
  list(): readonly Rule<Facts, Outcome>[];
  /** Distinct codes, ascending. */
  codes(): readonly RuleCode[];
  /** Every version of one code, ascending. Throws if the code is unknown. */
  versionsOf(code: RuleCode): readonly Rule<Facts, Outcome>[];
  /** The highest version of `code` whose `activeFrom` is at or before `at`. */
  resolve(code: RuleCode, at: Date): Rule<Facts, Outcome>;
  /** An exact version, for replaying a stored decision. Throws if absent. */
  resolveExact(code: RuleCode, version: RuleVersion): Rule<Facts, Outcome>;
  /** Whether a code is registered at all — the non-throwing question. */
  has(code: RuleCode): boolean;
}

function compareRules<F, O>(left: Rule<F, O>, right: Rule<F, O>): number {
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }
  return left.version - right.version;
}

export function createRuleRegistry<Facts, Outcome>(
  rules: readonly Rule<Facts, Outcome>[],
): RuleRegistry<Facts, Outcome> {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!Number.isInteger(rule.version) || rule.version < 1) {
      throw new RangeError(
        `platform/rules: rule "${rule.code}" has version ${String(rule.version)}; ` +
          'versions are integers starting at 1.',
      );
    }
    const key = `${rule.code}@${String(rule.version)}`;
    if (seen.has(key)) {
      throw new DuplicateRuleError(rule.code, rule.version);
    }
    seen.add(key);
  }

  // Sorted ONCE, at construction. Every read is then a slice of a stable array,
  // so evaluation order cannot vary between two calls.
  const ordered = [...rules].sort(compareRules);
  const byCode = new Map<RuleCode, Rule<Facts, Outcome>[]>();
  for (const rule of ordered) {
    const bucket = byCode.get(rule.code) ?? [];
    bucket.push(rule);
    byCode.set(rule.code, bucket);
  }
  const codes = [...byCode.keys()].sort();

  const versionsOf = (code: RuleCode): Rule<Facts, Outcome>[] => {
    const bucket = byCode.get(code);
    if (bucket === undefined) {
      throw new UnknownRuleError(code, codes);
    }
    return bucket;
  };

  return {
    list: (): readonly Rule<Facts, Outcome>[] => ordered,
    codes: (): readonly RuleCode[] => codes,
    versionsOf,
    has: (code: RuleCode): boolean => byCode.has(code),

    resolve(code: RuleCode, at: Date): Rule<Facts, Outcome> {
      const bucket = versionsOf(code);
      // Highest version first: the newest ACTIVE version wins, and a version
      // whose activeFrom is in the future is skipped rather than applied early.
      for (let i = bucket.length - 1; i >= 0; i -= 1) {
        const candidate = bucket[i];
        if (candidate !== undefined && candidate.activeFrom.getTime() <= at.getTime()) {
          return candidate;
        }
      }
      // `versionsOf` never returns an empty bucket, so `Math.min` over the
      // mapped times needs no seed and no impossible-empty branch.
      const earliest = new Date(Math.min(...bucket.map((rule) => rule.activeFrom.getTime())));
      throw new NoActiveRuleVersionError(code, at, earliest);
    },

    resolveExact(code: RuleCode, version: RuleVersion): Rule<Facts, Outcome> {
      const found = versionsOf(code).find((rule) => rule.version === version);
      if (found === undefined) {
        throw new UnknownRuleError(`${code}@${String(version)}`, codes);
      }
      return found;
    },
  };
}
