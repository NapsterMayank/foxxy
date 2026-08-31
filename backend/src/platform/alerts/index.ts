/**
 * platform/alerts — the rules, the signal collection, and the evaluator.
 *
 * ===========================================================================
 * WHY THIS LIVES IN `src/` AND NOT IN `scripts/ops/`, WHERE IT WAS BUILT.
 *
 * It was an operations concern reachable only by an operations script, which
 * was true and sufficient right up to the moment the admin panel needed to show
 * an operator what the alerting system currently thinks. `src/` may not import
 * from `scripts/` — a script is a program, not a library, and a dependency
 * pointing that way makes the API's behaviour depend on a file nothing else
 * builds or type-checks as part of the server.
 *
 * So the three files MOVED, unchanged apart from their import paths, and
 * `scripts/ops/alert-evaluator-main.ts` became a caller of this module rather
 * than its owner. Nothing about the rules, the thresholds or the delivery path
 * changed in the move, which is what makes it reviewable: `git log --follow`
 * shows a rename, not a rewrite.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PIECES, AND THE SEAM BETWEEN THEM THAT MATTERS.
 *
 *   alert-rules      WHAT would fire. Pure: `evaluate(rules, signals, now)`
 *                    takes numbers and returns alerts. No IO, no clock, no
 *                    database.
 *   alert-sources    WHAT IS TRUE right now. `collectSignals()` reads the
 *                    database, the readiness endpoint and the backup directory,
 *                    and reports both the values AND the ones it could not
 *                    measure.
 *   alert-evaluator  WHO IS TOLD. Cooldowns, severity-to-channel policy, and
 *                    delivery through the notify-channel port.
 *
 * COLLECTION AND EVALUATION ARE SEPARABLE FROM DELIVERY, and that seam is what
 * makes a dry run honest. A dry run is `collectSignals()` then `evaluate()`,
 * with NO dispatcher constructed at all — not one that is built and then not
 * called, which is a delivery that is one refactor away from happening by
 * accident. If nothing constructs a dispatcher, nothing can deliver.
 * ===========================================================================
 */

export {
  ALERT_RULES,
  COOLDOWN_BOUNDS,
  CooldownLedger,
  SIGNALS,
  SIGNAL_RANGES,
  assertRulesAreSatisfiable,
  evaluate,
} from './alert-rules';
export type {
  Alert,
  AlertRule,
  AlertSeverity,
  Comparison,
  SignalName,
  SignalRange,
  Signals,
} from './alert-rules';

export { collectSignals, createFsBackupAgeSource, producibleSignals } from './alert-sources';
export type { CollectedSignals, SignalCollectionOptions } from './alert-sources';

export {
  ALERT_CHANNEL_POLICY,
  ALERT_KIND_PAGE,
  ALERT_KIND_TICKET,
  createAlertEvaluator,
  withRunbookLine,
} from './alert-evaluator';
export type { AlertEvaluator, AlertEvaluatorOptions, CycleResult } from './alert-evaluator';
