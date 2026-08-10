import type { Clock } from '@/platform/clock/index';
import type { Logger } from '@/platform/logger/index';
import type { AnomalyRuleRegistry } from './domain/anomaly-rules';
import { detectFromFacts } from './domain/detect-anomalies';
import type { SignalsRepository } from './signals.repository';
import type { AnomalySignal, AnomalyWindow, StudentActivityFacts } from './signals.types';

/**
 * `signals` — the one use case.
 *
 * ===========================================================================
 * THE CLOCK IS READ HERE AND NOWHERE DEEPER.
 *
 * `detectAnomalies` takes an explicit window, so the ordinary call is fully
 * deterministic. The clock is used for ONE thing: the instant the detection is
 * evaluated FOR, which selects the active rule version. It is injected, so a
 * test fixes it and gets byte-identical output — and no rule and no domain
 * function can reach a clock at all.
 *
 * ===========================================================================
 * NOTHING IS DECIDED HERE. The service loads two facts and calls a pure
 * function. Every threshold, every comparison and every reason string lives in
 * `domain/`. A conditional in this file that suppresses or adds a signal is the
 * regression — it would be a rule with no code, no version and no audit trail.
 */

export interface SignalsService {
  /**
   * Every anomaly for one student over one window.
   *
   * A student with no history returns an EMPTY LIST, not an error. That is the
   * state of every account on its first day.
   */
  detectAnomalies(studentUserId: string, window: AnomalyWindow): Promise<readonly AnomalySignal[]>;
}

export interface SignalsServiceDeps {
  readonly repository: SignalsRepository;
  readonly registry: AnomalyRuleRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function createSignalsService(deps: SignalsServiceDeps): SignalsService {
  const { repository, registry, clock, logger } = deps;

  return {
    async detectAnomalies(
      studentUserId: string,
      window: AnomalyWindow,
    ): Promise<readonly AnomalySignal[]> {
      if (window.to.getTime() < window.from.getTime()) {
        throw new RangeError(
          'signals.detectAnomalies: the window ends before it begins. ' +
            'A reversed window silently returns no sessions, which reads as a healthy student.',
        );
      }

      const [sessions, lastActivityAt] = await Promise.all([
        repository.listSessionsInWindow(studentUserId, window),
        repository.getLastActivityAt(studentUserId),
      ]);

      const facts: StudentActivityFacts = {
        studentUserId,
        window,
        sessions,
        lastActivityAt,
      };

      const signals = detectFromFacts(registry, facts, clock.now());

      if (signals.length > 0) {
        // COUNTS AND STAMPS ONLY. The reason strings are PII-free by
        // construction, but a log line is the easiest place for that guarantee to
        // be undone by somebody adding "just the student's name for context".
        logger.info(
          {
            studentUserId,
            signalCount: signals.length,
            ruleStamps: [...new Set(signals.map((signal) => signal.ruleStamp))],
          },
          'signals: anomalies detected',
        );
      }

      return signals;
    },
  };
}
