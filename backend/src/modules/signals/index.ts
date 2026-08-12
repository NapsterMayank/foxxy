import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import { createAnomalyRuleRegistry } from './domain/anomaly-rules';
import { createSignalsRepository, type SignalsDbHandle } from './signals.repository';
import { createSignalsService, type SignalsService } from './signals.service';
import type { AntiCheatEdge } from './signals.types';

/**
 * ============================================================================
 * signals — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else in
 * this directory is private.
 *
 * Owns: basic anomaly detection over practice history — inactivity, mastery
 * drop, unusually fast completion, repeated struggle. Roadmap scope: "Anomaly
 * rules — basic — reuse anti-cheat, add inactivity and mastery drop"
 * (PROGRESS.md §6, 1.5 days).
 *
 * NO HTTP ENDPOINTS. Detection is called in-process by whatever notifies a
 * teacher or a parent. An endpoint would be a way to ask about a student the
 * caller may not be entitled to see, and that boundary already exists elsewhere.
 * ============================================================================
 *
 * THE THREE THINGS ABOUT THIS MODULE MOST LIKELY TO BE UNDONE BY ACCIDENT.
 *
 * 1. THE ANTI-CHEAT FLOOR IS INJECTED, NEVER COPIED. `practice` authored and
 *    tested it; `signals` only sits above it. There is deliberately NO DEFAULT
 *    for `antiCheat` — a missing edge is a compile error, because a default
 *    would be the second copy of a constant, and two copies of a threshold
 *    drift silently. The symptom of that drift is a signal that quietly stops
 *    agreeing with the rejection it is defined relative to.
 *
 * 2. EVERY SIGNAL CARRIES `code@version`. An escalation a teacher disagrees with
 *    must be traceable to a specific version of a specific rule, or the only
 *    available reply is "the system decided". Changing a threshold means a NEW
 *    RULE VERSION, never an edit — see `platform/rules`.
 *
 * 3. `evidence` IS `Record<string, number>` AND THAT IS A PRIVACY MECHANISM, not
 *    a style. Numbers cannot carry a name, an email, a phone number or a typed
 *    answer. A free-text evidence field would be the shortest path from a
 *    detection to a P13 breach in a notification payload.
 */

export interface SignalsModuleDeps {
  /** §3.1: the `core` pool. Small indexed reads over one student's sessions. */
  readonly db: SignalsDbHandle;
  /**
   * `practice`'s anti-cheat floor and verdict. REQUIRED — see note 1.
   *
   * Wired at the composition root from `practice`'s domain, so there is exactly
   * one definition of "too fast" in the system.
   */
  readonly antiCheat: AntiCheatEdge;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface SignalsModule {
  /** The only object other modules should hold. */
  readonly service: SignalsService;
}

export function createSignalsModule(deps: SignalsModuleDeps): SignalsModule {
  return {
    service: createSignalsService({
      repository: createSignalsRepository(deps.db),
      registry: createAnomalyRuleRegistry(deps.antiCheat),
      clock: deps.clock,
      logger: deps.logger,
    }),
  };
}

/**
 * ---------------------------------------------------------------------------
 * The one use case.
 *
 *   detectAnomalies(studentUserId, window)
 *       Typed signals, each with a reason assembled from numbers only and a
 *       `code@version` stamp. A student with no history returns an empty list.
 * ---------------------------------------------------------------------------
 */
export type { SignalsService } from './signals.service';
export type { SignalsRepository } from './signals.repository';

export { ANOMALY_KINDS } from './signals.types';
export type {
  AnomalyFinding,
  AnomalyKind,
  AnomalySignal,
  AnomalyWindow,
  AntiCheatEdge,
  ResponseFact,
  SessionFact,
  StudentActivityFacts,
} from './signals.types';

/**
 * The thresholds and the rules.
 *
 * Exported so that a caller rendering "why was I told this" can quote the same
 * numbers the rules used, and so a future admin surface can display the rule set
 * without a second copy of it. A consumer that hardcodes `7` instead of
 * importing `INACTIVITY_DAYS` has recreated the magic number this file exists to
 * remove.
 */
export {
  FAST_COMPLETION_FLOOR_MULTIPLE,
  INACTIVITY_DAYS,
  MASTERY_DROP_MIN_PERCENTAGE_POINTS,
  MS_PER_DAY,
  REPEATED_STRUGGLE_SESSIONS,
  STRUGGLE_SCORE_PERCENT,
} from './domain/thresholds';

export {
  ANOMALY_RULES_V1_ACTIVE_FROM,
  createAnomalyRuleRegistry,
  createFastCompletionRule,
  inactivityRule,
  masteryDropRule,
  repeatedStruggleRule,
} from './domain/anomaly-rules';
export type { AnomalyRule, AnomalyRuleRegistry } from './domain/anomaly-rules';

export { detectFromFacts } from './domain/detect-anomalies';
