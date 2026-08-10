/**
 * platform/rules — THE SHAPES. A versioned, deterministic rule and its result.
 *
 * ===========================================================================
 * THIS FILE CARRIES NO BUSINESS RULES, AND THAT IS THE WHOLE POINT.
 *
 * It is `platform/`, so it holds the MECHANISM and nothing a product manager
 * would recognise. There is no threshold here, no "three days", no subject, no
 * grade. A rule about students lives in the module that owns students —
 * `signals` is the first — and imports this to be evaluated. The day a constant
 * with a pedagogical meaning appears in this directory, the boundary is gone and
 * every module inherits every other module's policy.
 *
 * ===========================================================================
 * THE VERSION IS NOT METADATA. IT IS THE PRODUCT.
 *
 * Every evaluation records the `(code, version)` that produced it. That single
 * stamp is the difference between "the system flagged this student" and "rule
 * `inactivity@2`, active from 1 March, flagged this student" — the first is
 * unfalsifiable and the second can be argued with, reproduced, and rolled back.
 * A support conversation, a parent complaint and a regression triage all need
 * the same thing: which version of which rule looked at these facts.
 *
 * So the stamp is not optional, cannot be omitted by a caller, and is produced
 * by the evaluator rather than by the rule — a rule that stamped itself could
 * lie about its own version.
 *
 * ===========================================================================
 * PURE. NO I/O, NO CLOCK, NO RANDOMNESS.
 *
 * `activeFrom` makes a rule time-dependent, which is exactly why the evaluator
 * takes the instant as an ARGUMENT and never reads a clock. Two evaluations of
 * the same facts at the same instant must produce byte-identical results forever,
 * including after the rule set has grown. A `Date.now()` anywhere in this
 * directory makes yesterday's decision unreproducible, which makes the audit
 * trail decorative.
 */

/** A rule's stable identity across all its versions. */
export type RuleCode = string;

/**
 * A monotonically increasing integer, per code. Not semver.
 *
 * Semver encodes compatibility, and there is no such thing as a
 * backwards-compatible change to a rule: any edit that could change an outcome
 * is a new version, and any edit that could not is not worth a version at all.
 * One integer removes the argument about whether a threshold change is a minor
 * or a patch.
 */
export type RuleVersion = number;

/**
 * The audit stamp, `code@version` — one string, because it is written to one
 * column and read by a human.
 *
 * Two columns would be normalised and would also be two things to forget to
 * select, two things to index, and two things that can disagree. One opaque,
 * parseable token is cheaper to carry through a log line, a notification payload
 * and a support ticket.
 */
export type RuleStamp = string;

export function ruleStamp(code: RuleCode, version: RuleVersion): RuleStamp {
  return `${code}@${String(version)}`;
}

/**
 * Splits a stamp. Returns `null` rather than throwing on a malformed one —
 * parsing is usually done over stored data, where a bad row should be reportable
 * rather than fatal to the whole read.
 */
export function parseRuleStamp(
  stamp: RuleStamp,
): { readonly code: RuleCode; readonly version: RuleVersion } | null {
  const at = stamp.lastIndexOf('@');
  if (at <= 0 || at === stamp.length - 1) {
    return null;
  }
  const code = stamp.slice(0, at);
  const raw = stamp.slice(at + 1);
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return { code, version: Number(raw) };
}

/**
 * A rule.
 *
 * `Facts` is whatever the owning module measured; `Outcome` is whatever it wants
 * back. Both are generic because `platform/` must not know either — the moment
 * this file names a concrete fact type it has acquired a domain.
 *
 * `condition` and `action` are SEPARATE, and the separation is load-bearing: it
 * is what allows an evaluation to record "this rule was considered and did not
 * match", which is a different and much more useful fact than the rule's absence
 * from a result list.
 */
export interface Rule<Facts, Outcome> {
  readonly code: RuleCode;
  readonly version: RuleVersion;
  /** Pure predicate over the facts. Must not read a clock or mutate anything. */
  readonly condition: (facts: Facts) => boolean;
  /** Runs only when `condition` returned true. Pure. */
  readonly action: (facts: Facts) => Outcome;
  /**
   * The instant this version starts applying, inclusive.
   *
   * A rule is never edited in place: a threshold change is a NEW version with a
   * later `activeFrom`, which leaves last month's decisions explainable by the
   * version that actually made them. Editing in place makes every historical
   * decision look like it was made by today's rule, and the audit trail becomes
   * a claim nobody can check.
   */
  readonly activeFrom: Date;
}

/**
 * The record of one rule being applied to one set of facts.
 *
 * `matched: false` is RETAINED rather than filtered away. "Rule `too_fast@1` saw
 * these facts and did not fire" is the answer to the most common question asked
 * of a rules engine, and a caller that only wants matches can filter; a caller
 * that wants the negative cannot recover it from a filtered list.
 */
export interface RuleEvaluation<Outcome> {
  readonly ruleCode: RuleCode;
  readonly ruleVersion: RuleVersion;
  /** `code@version`. The column that makes the decision explainable. */
  readonly ruleStamp: RuleStamp;
  readonly matched: boolean;
  /** The action's result, or `null` when the condition did not match. */
  readonly outcome: Outcome | null;
  /**
   * The instant the evaluation was made FOR — the injected one, not "now".
   *
   * Copied into the result so a stored evaluation can be replayed exactly: the
   * facts and this timestamp are the complete input.
   */
  readonly evaluatedAt: Date;
}
