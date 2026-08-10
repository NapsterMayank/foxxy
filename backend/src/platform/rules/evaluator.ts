import type { RuleRegistry } from './registry';
import { type Rule, type RuleCode, type RuleEvaluation, ruleStamp } from './rule';

/**
 * THE EVALUATOR — apply rules to facts and record what produced the answer.
 *
 * ===========================================================================
 * DETERMINISM IS THE CONTRACT, AND IT HAS THREE PARTS.
 *
 * 1. THE INSTANT IS AN ARGUMENT. Nothing here reads a clock. `evaluateAll(facts,
 *    at)` is a pure function of two values, so a decision made in March can be
 *    replayed in September and must produce the same bytes.
 *
 * 2. THE ORDER IS THE REGISTRY'S, NOT THE CALLER'S. Rules are evaluated in the
 *    registry's stable (code, version) order. A caller cannot influence it by
 *    reordering an array literal, which means a merge that reshuffles a rule list
 *    cannot change any outcome.
 *
 * 3. EVERY RULE IS EVALUATED. There is no short-circuit on first match, because
 *    "which rules did NOT fire" is half the audit trail, and because a
 *    first-match engine makes every outcome depend on order in a way that a
 *    reviewer cannot see from the rule alone. A caller wanting the first match
 *    takes the first element of a list it can already read.
 *
 * ===========================================================================
 * THE STAMP IS APPLIED HERE, NOT BY THE RULE.
 *
 * A rule that wrote its own version could disagree with the version it was
 * registered under — and the disagreement would be invisible, because the only
 * evidence would be the field that lied. The evaluator holds the rule object it
 * actually ran and stamps from that.
 *
 * ===========================================================================
 * A THROWING CONDITION IS NOT CAUGHT.
 *
 * A predicate that raises is a bug in a pure function over facts the caller
 * supplied. Swallowing it would record `matched: false` — an assertion that the
 * rule looked and found nothing — which is a false entry in an audit trail. A
 * false audit entry is worse than a failed evaluation, so it propagates.
 */

/**
 * Applies ONE rule to one set of facts.
 *
 * Exported because replaying a stored decision needs exactly this: the caller
 * has a stamp, resolves the exact version from the registry, and re-runs it
 * against the recorded facts.
 */
export function evaluateRule<Facts, Outcome>(
  rule: Rule<Facts, Outcome>,
  facts: Facts,
  at: Date,
): RuleEvaluation<Outcome> {
  const matched = rule.condition(facts);
  return {
    ruleCode: rule.code,
    ruleVersion: rule.version,
    ruleStamp: ruleStamp(rule.code, rule.version),
    matched,
    // The action runs ONLY on a match. An action with a side effect would break
    // purity, and an action that is expensive should not be paid for by a rule
    // that did not fire.
    outcome: matched ? rule.action(facts) : null,
    evaluatedAt: new Date(at.getTime()),
  };
}

/**
 * Applies the ACTIVE version of every registered code, in the registry's order.
 *
 * One evaluation per CODE, not per rule row: evaluating three versions of the
 * same rule against the same facts would produce three contradictory audit
 * entries for one decision. `at` selects which version each code resolves to,
 * which is the entire reason `activeFrom` exists.
 *
 * Codes whose earliest version begins after `at` are SKIPPED rather than failing
 * the batch — a rule that did not exist yet cannot have an opinion about the
 * past, and a backfill over historical facts must not be blocked by a rule
 * shipped last week. Asking for such a code BY NAME still throws, because that
 * is a caller asserting the rule applies.
 */
export function evaluateAll<Facts, Outcome>(
  registry: RuleRegistry<Facts, Outcome>,
  facts: Facts,
  at: Date,
): readonly RuleEvaluation<Outcome>[] {
  const evaluations: RuleEvaluation<Outcome>[] = [];
  for (const code of registry.codes()) {
    const active = activeVersionOrNull(registry, code, at);
    if (active === null) {
      continue;
    }
    evaluations.push(evaluateRule(active, facts, at));
  }
  return evaluations;
}

/** Every evaluation that matched, in the same stable order. A convenience, not a filter policy. */
export function matchedOnly<Outcome>(
  evaluations: readonly RuleEvaluation<Outcome>[],
): readonly RuleEvaluation<Outcome>[] {
  return evaluations.filter((evaluation) => evaluation.matched);
}

/**
 * The active version of a code, or `null` when none is active yet.
 *
 * The non-throwing counterpart to `registry.resolve`, used by `evaluateAll` to
 * skip not-yet-active codes. Kept separate so that `resolve`'s loud failure is
 * preserved for callers who named the rule themselves.
 */
export function activeVersionOrNull<Facts, Outcome>(
  registry: RuleRegistry<Facts, Outcome>,
  code: RuleCode,
  at: Date,
): Rule<Facts, Outcome> | null {
  if (!registry.has(code)) {
    return null;
  }
  const versions = registry.versionsOf(code);
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const candidate = versions[i];
    if (candidate !== undefined && candidate.activeFrom.getTime() <= at.getTime()) {
      return candidate;
    }
  }
  return null;
}
