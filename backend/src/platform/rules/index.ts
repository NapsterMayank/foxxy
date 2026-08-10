/**
 * ============================================================================
 * platform/rules — a versioned, deterministic rules engine. FOUNDATION ONLY.
 *
 * This is the MECHANISM, not a library of rules. It holds no threshold, no
 * subject, no grade and no student — `platform/` cannot know about any of them.
 * The first consumer is `modules/signals`, which supplies its own rules and its
 * own named constants.
 *
 * Roadmap scope: "Rules engine — foundation only — versioned evaluator, rule
 * version stamped on every decision" (PROGRESS.md §6, 2 days).
 * ============================================================================
 *
 * THE FOUR PROPERTIES, AND WHAT BREAKS EACH.
 *
 * 1. DETERMINISTIC. Same facts, same instant, same output — always. Nothing
 *    reads a clock; the instant is an argument. A `Date.now()` added anywhere in
 *    this directory makes every stored decision unreproducible, which makes the
 *    audit trail decorative rather than evidential.
 *
 * 2. EVERY EVALUATION CARRIES `code@version`. That stamp is the difference
 *    between "the system flagged this student" and a claim that can be argued
 *    with, replayed and rolled back. The evaluator stamps from the rule object it
 *    actually ran — a rule that stamped itself could lie.
 *
 * 3. VERSIONS ARE ADDED, NEVER EDITED. A threshold change is a new version with
 *    a later `activeFrom`. Editing a rule in place makes last month's decisions
 *    look like today's rule made them, and nobody can tell afterwards.
 *
 * 4. ORDER IS THE REGISTRY'S. Rules evaluate in stable (code, version) order,
 *    sorted once at construction. A caller reordering an array literal cannot
 *    change an outcome, so a merge conflict resolved the wrong way cannot either.
 */

export { ruleStamp, parseRuleStamp } from './rule';
export type { Rule, RuleCode, RuleEvaluation, RuleStamp, RuleVersion } from './rule';

export {
  DuplicateRuleError,
  NoActiveRuleVersionError,
  UnknownRuleError,
  createRuleRegistry,
} from './registry';
export type { RuleRegistry } from './registry';

export { activeVersionOrNull, evaluateAll, evaluateRule, matchedOnly } from './evaluator';
