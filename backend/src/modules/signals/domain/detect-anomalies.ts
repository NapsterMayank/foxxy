import { evaluateAll } from '@/platform/rules/index';
import type { AnomalySignal, StudentActivityFacts } from '../signals.types';
import type { AnomalyRuleRegistry } from './anomaly-rules';

/**
 * DETECTION — run the rule set over one student's facts and stamp every finding.
 *
 * ===========================================================================
 * THE STAMP IS APPLIED HERE, FROM THE EVALUATION, NOT FROM THE RULE.
 *
 * `platform/rules` returns the `(code, version)` it actually ran. This function
 * copies that onto each finding rather than asking the rule what version it is —
 * a rule that reported its own version could disagree with the one it was
 * registered under, and the disagreement would be invisible because the only
 * evidence would be the field that lied.
 *
 * ===========================================================================
 * NO HISTORY PRODUCES NO SIGNALS, NOT AN ERROR.
 *
 * A student who has never practised is the normal state of every account on its
 * first day. Every rule is still EVALUATED for them — the audit trail records
 * four considered-and-did-not-fire entries — and the returned signal list is
 * empty. An exception here would make the ordinary case the loud one.
 *
 * ===========================================================================
 * THE ORDER IS THE REGISTRY'S, AND THEN THE RULE'S.
 *
 * Signals come out grouped by rule code (ascending, from the registry) and within
 * a rule in the order it produced them, which is chapter-id order. Two runs over
 * the same facts return the same list in the same order, which is what makes a
 * stored detection comparable with a later one.
 *
 * Pure: facts and the instant are arguments.
 */
export function detectFromFacts(
  registry: AnomalyRuleRegistry,
  facts: StudentActivityFacts,
  at: Date,
): readonly AnomalySignal[] {
  const evaluations = evaluateAll(registry, facts, at);
  const signals: AnomalySignal[] = [];

  for (const evaluation of evaluations) {
    // A non-match carries a null outcome by construction. It stays in the audit
    // trail inside `evaluations`; it contributes no signal here.
    if (!evaluation.matched || evaluation.outcome === null) {
      continue;
    }
    for (const finding of evaluation.outcome) {
      signals.push({
        ...finding,
        studentUserId: facts.studentUserId,
        ruleCode: evaluation.ruleCode,
        ruleVersion: evaluation.ruleVersion,
        ruleStamp: evaluation.ruleStamp,
        detectedAt: evaluation.evaluatedAt,
      });
    }
  }

  return signals;
}
