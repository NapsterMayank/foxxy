import { type Rule, createRuleRegistry, type RuleRegistry } from '@/platform/rules/index';
import type {
  AnomalyFinding,
  AntiCheatEdge,
  SessionFact,
  StudentActivityFacts,
} from '../signals.types';
import {
  FAST_COMPLETION_FLOOR_MULTIPLE,
  INACTIVITY_DAYS,
  MASTERY_DROP_MIN_PERCENTAGE_POINTS,
  MS_PER_DAY,
  REPEATED_STRUGGLE_SESSIONS,
  STRUGGLE_SCORE_PERCENT,
} from './thresholds';

/**
 * THE FOUR MVP ANOMALY RULES, expressed as `platform/rules` rules.
 *
 * ===========================================================================
 * BASIC, DETERMINISTIC, EXPLAINABLE — in that order of priority.
 *
 * None of these is clever. Every one is a comparison against a named constant
 * over facts that were already recorded, and that is deliberate: the output of
 * this module can end with a teacher being told a child is struggling, and a
 * model nobody can explain has no business making that call. The sophisticated
 * version — IRT calibration, multi-factor weighting — is explicitly deferred
 * until real usage data exists (PROGRESS.md §6).
 *
 * ===========================================================================
 * `activeFrom` IS ONE SHARED DATE, AND IT IS THE PAST.
 *
 * All four ship together as version 1, so they share the instant they became
 * active. It is set to the date they were authored rather than to "now" — a
 * computed `activeFrom` would make the rule set depend on when the process
 * started, which is the same defect as reading a clock inside a rule.
 *
 * ===========================================================================
 * EVERY RULE RETURNS A LIST, INCLUDING WHEN IT IS EMPTY.
 *
 * A rule matches when it found something, and the evaluator records the negative
 * too. So "mastery_drop@1 looked at this student and found nothing" is a fact in
 * the audit trail, distinguishable from "mastery_drop was never run" — which is
 * what a silently skipped check looks like.
 *
 * Pure: every input arrives in `facts`, the anti-cheat edge is bound at
 * construction, and nothing reads a clock.
 */

/** The instant version 1 of every rule below became active. Fixed, never computed. */
export const ANOMALY_RULES_V1_ACTIVE_FROM = new Date('2026-08-10T00:00:00.000Z');

/** A rule over student activity. `platform/rules` supplies the mechanism. */
export type AnomalyRule = Rule<StudentActivityFacts, readonly AnomalyFinding[]>;
export type AnomalyRuleRegistry = RuleRegistry<StudentActivityFacts, readonly AnomalyFinding[]>;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Sessions grouped by chapter, each group preserving the oldest-first order. */
function groupByChapter(
  sessions: readonly SessionFact[],
): ReadonlyMap<string, readonly SessionFact[]> {
  const groups = new Map<string, SessionFact[]>();
  for (const session of sessions) {
    const bucket = groups.get(session.chapterId) ?? [];
    bucket.push(session);
    groups.set(session.chapterId, bucket);
  }
  return groups;
}

/**
 * Chapter ids in a STABLE order.
 *
 * Iteration order of a Map is insertion order, which here is the order the
 * database returned rows in — not something to build a deterministic output on.
 * Sorting costs nothing at these sizes and makes the finding list reproducible.
 */
function sortedChapterIds(groups: ReadonlyMap<string, readonly SessionFact[]>): string[] {
  return [...groups.keys()].sort();
}

/**
 * RULE 1 — INACTIVITY. No submitted session for `INACTIVITY_DAYS`.
 *
 * Measured from `lastActivityAt`, which may predate the window, to the window's
 * END rather than to a clock. A student with NO history produces nothing at all:
 * "has never started" is an onboarding fact, not an anomaly, and reporting it
 * here would bury the students who did start and then stopped.
 */
export const inactivityRule: AnomalyRule = {
  code: 'inactivity',
  version: 1,
  activeFrom: ANOMALY_RULES_V1_ACTIVE_FROM,
  // Condition and action share ONE function, so they cannot disagree. Writing
  // the predicate twice — once as a boolean, once re-derived inside the action —
  // is how a rule ends up matching and then producing nothing.
  condition: (facts) => findInactivity(facts).length > 0,
  action: findInactivity,
};

function findInactivity(facts: StudentActivityFacts): AnomalyFinding[] {
  if (facts.lastActivityAt === null) {
    return [];
  }
  const days = daysBetween(facts.lastActivityAt, facts.window.to);
  if (days < INACTIVITY_DAYS) {
    return [];
  }
  return [
    {
      kind: 'inactivity',
      chapterId: null,
      reason: `No practice session for ${String(days)} days; the threshold is ${String(
        INACTIVITY_DAYS,
      )}.`,
      evidence: { daysInactive: days, thresholdDays: INACTIVITY_DAYS },
    },
  ];
}

/**
 * RULE 2 — MASTERY DROP. A score falling across two CONSECUTIVE sessions on the
 * same chapter by at least `MASTERY_DROP_MIN_PERCENTAGE_POINTS`.
 *
 * CONSECUTIVE, not best-versus-latest. Comparing a latest score against a
 * personal best would fire for every student who ever had a lucky set, and would
 * keep firing forever afterwards. Adjacent pairs ask a narrower and more useful
 * question: did something get worse between one sitting and the next.
 *
 * Sessions with no score are SKIPPED, not treated as zero — an abandoned session
 * is not a bad one, and scoring it zero would manufacture a drop out of a student
 * closing the app.
 */
export const masteryDropRule: AnomalyRule = {
  code: 'mastery_drop',
  version: 1,
  activeFrom: ANOMALY_RULES_V1_ACTIVE_FROM,
  condition: (facts) => findMasteryDrops(facts).length > 0,
  action: (facts) => findMasteryDrops(facts),
};

function findMasteryDrops(facts: StudentActivityFacts): AnomalyFinding[] {
  const groups = groupByChapter(facts.sessions);
  const findings: AnomalyFinding[] = [];

  for (const chapterId of sortedChapterIds(groups)) {
    const scored = (groups.get(chapterId) ?? []).filter(
      (session): session is SessionFact & { scorePercent: number } => session.scorePercent !== null,
    );
    // Walked with a running `previous` rather than by index: indexing under
    // `noUncheckedIndexedAccess` yields `T | undefined` and forces a guard the
    // loop bounds have already made impossible — an unreachable branch no test
    // can cover.
    let previous: (SessionFact & { scorePercent: number }) | null = null;
    for (const current of scored) {
      if (previous === null) {
        previous = current;
        continue;
      }
      const drop = previous.scorePercent - current.scorePercent;
      if (drop >= MASTERY_DROP_MIN_PERCENTAGE_POINTS) {
        findings.push({
          kind: 'mastery_drop',
          chapterId,
          reason:
            `Score fell ${String(drop)} points between two consecutive sessions ` +
            `(${String(previous.scorePercent)}% to ${String(current.scorePercent)}%); ` +
            `the threshold is ${String(MASTERY_DROP_MIN_PERCENTAGE_POINTS)}.`,
          evidence: {
            previousScorePercent: previous.scorePercent,
            currentScorePercent: current.scorePercent,
            dropPercentagePoints: drop,
            thresholdPercentagePoints: MASTERY_DROP_MIN_PERCENTAGE_POINTS,
          },
        });
      }
      // Advance regardless of whether this pair was a drop: the comparison is
      // between ADJACENT sessions, so every session becomes the next previous.
      previous = current;
    }
  }

  return findings;
}

/**
 * RULE 3 — UNUSUALLY FAST COMPLETION, strictly ABOVE the anti-cheat floor.
 *
 * The floor and the verdict both come from the injected `practice` edge. This
 * rule adds ONE thing: a multiple. It never re-derives what "too fast" means,
 * because `practice` already decided that and a second answer would eventually
 * disagree with the first.
 *
 * An attempt `practice` already REJECTED is skipped. It has been scored zero and
 * recorded with its reason; re-reporting it as an anomaly would double-count a
 * single event and send a teacher after something the system already handled.
 */
export function createFastCompletionRule(antiCheat: AntiCheatEdge): AnomalyRule {
  const ceiling = antiCheat.minimumAverageMsPerQuestion * FAST_COMPLETION_FLOOR_MULTIPLE;

  const find = (facts: StudentActivityFacts): AnomalyFinding[] => {
    const findings: AnomalyFinding[] = [];
    for (const session of facts.sessions) {
      if (session.responses.length === 0) {
        continue;
      }
      // The edge decides validity. `isValid === false` means practice already
      // rejected it; `null` means it was never evaluated, so ask the edge.
      const valid =
        session.isValid ?? antiCheat.isAttemptValid(session.responses, session.questionCount);
      if (!valid) {
        continue;
      }
      const totalMs = session.responses.reduce((sum, r) => sum + r.timeSpentMs, 0);
      const averageMs = Math.round(totalMs / session.responses.length);
      if (averageMs < ceiling) {
        findings.push({
          kind: 'fast_completion',
          chapterId: session.chapterId,
          reason:
            `Answered in ${String(averageMs)}ms per question on average, below the ` +
            `${String(ceiling)}ms mark, while still passing the ` +
            `${String(antiCheat.minimumAverageMsPerQuestion)}ms validity floor.`,
          evidence: {
            averageMsPerQuestion: averageMs,
            ceilingMs: ceiling,
            antiCheatFloorMs: antiCheat.minimumAverageMsPerQuestion,
            floorMultiple: FAST_COMPLETION_FLOOR_MULTIPLE,
            questionCount: session.responses.length,
          },
        });
      }
    }
    return findings;
  };

  return {
    code: 'fast_completion',
    version: 1,
    activeFrom: ANOMALY_RULES_V1_ACTIVE_FROM,
    condition: (facts) => find(facts).length > 0,
    action: find,
  };
}

/**
 * RULE 4 — REPEATED STRUGGLE. `REPEATED_STRUGGLE_SESSIONS` sessions at or below
 * `STRUGGLE_SCORE_PERCENT` on the same chapter.
 *
 * THIS IS THE TEACHER-ESCALATION TRIGGER, which is why it counts failures on ONE
 * chapter rather than across a subject: "struggling in science" is not something
 * a teacher can act on in a lesson, and "failed chapter 4 three times" is.
 *
 * The failures need not be consecutive. A student who fails, scrapes a pass, then
 * fails twice more has still failed three times, and requiring an unbroken run
 * would reset the count on exactly the moment of partial progress that makes the
 * pattern worth reporting.
 */
export const repeatedStruggleRule: AnomalyRule = {
  code: 'repeated_struggle',
  version: 1,
  activeFrom: ANOMALY_RULES_V1_ACTIVE_FROM,
  condition: (facts) => findRepeatedStruggle(facts).length > 0,
  action: (facts) => findRepeatedStruggle(facts),
};

function findRepeatedStruggle(facts: StudentActivityFacts): AnomalyFinding[] {
  const groups = groupByChapter(facts.sessions);
  const findings: AnomalyFinding[] = [];

  for (const chapterId of sortedChapterIds(groups)) {
    const failures = (groups.get(chapterId) ?? []).filter(
      (session) => session.scorePercent !== null && session.scorePercent <= STRUGGLE_SCORE_PERCENT,
    );
    if (failures.length >= REPEATED_STRUGGLE_SESSIONS) {
      findings.push({
        kind: 'repeated_struggle',
        chapterId,
        reason:
          `${String(failures.length)} sessions at or below ${String(STRUGGLE_SCORE_PERCENT)}% ` +
          `on this chapter; the escalation threshold is ${String(REPEATED_STRUGGLE_SESSIONS)}.`,
        evidence: {
          failedSessions: failures.length,
          thresholdSessions: REPEATED_STRUGGLE_SESSIONS,
          failingScorePercent: STRUGGLE_SCORE_PERCENT,
        },
      });
    }
  }

  return findings;
}

/**
 * The MVP rule set.
 *
 * Built through `createRuleRegistry`, so a duplicate `(code, version)` added by a
 * later change is rejected at construction rather than producing two findings
 * stamped identically.
 */
export function createAnomalyRuleRegistry(antiCheat: AntiCheatEdge): AnomalyRuleRegistry {
  return createRuleRegistry<StudentActivityFacts, readonly AnomalyFinding[]>([
    inactivityRule,
    masteryDropRule,
    createFastCompletionRule(antiCheat),
    repeatedStruggleRule,
  ]);
}
