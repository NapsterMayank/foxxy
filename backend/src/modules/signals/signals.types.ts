import type { RuleCode, RuleStamp, RuleVersion } from '@/platform/rules/index';

/**
 * `signals` — the shapes crossing the module boundary.
 *
 * ===========================================================================
 * `evidence` IS `Record<string, number>` AND THAT IS A PRIVACY MECHANISM.
 *
 * Every signal has to explain itself, and the cheap way to do that is a free-text
 * field — which is how a student's name, a chapter title, a typed answer or a
 * parent's phone number ends up in a notification payload, a log line and an
 * analytics export. Constraining the evidence to NUMBERS makes that structurally
 * impossible rather than a matter of review discipline: there is no way to put a
 * name in a `number`.
 *
 * `reason` is the one string, and it is assembled from these numbers and nothing
 * else. A rule that interpolates a title or an answer into it has broken P13, and
 * the test that asserts the payload contains no PII is what catches it.
 *
 * The uuids (`studentUserId`, `chapterId`) are identifiers, not PII: they carry
 * no meaning outside a database that already applies the tenancy guard, and a
 * signal that could not say WHO it was about would be unusable.
 */

/** The window a detection ran over. Injected — nothing here reads a clock. */
export interface AnomalyWindow {
  readonly from: Date;
  readonly to: Date;
}

export const ANOMALY_KINDS = [
  'inactivity',
  'mastery_drop',
  'fast_completion',
  'repeated_struggle',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/** The two response fields the anti-cheat edge reads. Mirrors `practice`'s own shape. */
export interface ResponseFact {
  readonly selectedIndex: number;
  readonly timeSpentMs: number;
}

/** One submitted session, reduced to what the rules read. */
export interface SessionFact {
  readonly sessionId: string;
  readonly chapterId: string;
  readonly submittedAt: Date;
  /** Null when a session was abandoned. A rule needing a score must skip those. */
  readonly scorePercent: number | null;
  /** `practice`'s verdict, already recorded. Null when never evaluated. */
  readonly isValid: boolean | null;
  readonly questionCount: number;
  readonly responses: readonly ResponseFact[];
}

/**
 * Everything the rules are allowed to know.
 *
 * `lastActivityAt` may fall OUTSIDE the window — that is the point of it. A
 * student inactive for three weeks has no sessions in a one-week window, and
 * inactivity computed from an empty list alone cannot tell that apart from a
 * student who has never started.
 */
export interface StudentActivityFacts {
  readonly studentUserId: string;
  readonly window: AnomalyWindow;
  /** Submitted sessions inside the window, OLDEST FIRST. Order is load-bearing. */
  readonly sessions: readonly SessionFact[];
  /** The most recent submission at any time, or null for a student with no history. */
  readonly lastActivityAt: Date | null;
}

/** One finding. A rule may produce several — one per chapter, typically. */
export interface AnomalyFinding {
  readonly kind: AnomalyKind;
  /** Null for a whole-student signal such as inactivity. */
  readonly chapterId: string | null;
  /** Assembled from `evidence` only. See the header. */
  readonly reason: string;
  /** Numbers only, by type. This is what makes the payload PII-free by construction. */
  readonly evidence: Readonly<Record<string, number>>;
}

/**
 * A finding, stamped with the rule version that produced it.
 *
 * The stamp is not decoration: an escalation a teacher disagrees with has to be
 * traceable to a specific version of a specific rule, or the only possible reply
 * is "the system decided".
 */
export interface AnomalySignal extends AnomalyFinding {
  readonly studentUserId: string;
  readonly ruleCode: RuleCode;
  readonly ruleVersion: RuleVersion;
  readonly ruleStamp: RuleStamp;
  /** The instant the detection ran FOR — the injected one, never `now`. */
  readonly detectedAt: Date;
}

/**
 * THE INJECTED EDGE ONTO `practice`.
 *
 * `signals` must decide whether an attempt was "unusually fast BEYOND the
 * anti-cheat floor", which means it needs the floor and the verdict — both of
 * which `practice` already owns, authored and tested (`domain/anti-cheat.ts`).
 *
 * IT IS AN EDGE AND NOT AN IMPORT for two reasons. The module boundary
 * (00-ARCHITECTURE.md, Foundation 1) forbids reaching into another module's
 * internals; and a COPY of the floor would be worse than either — two constants
 * that drift, where the drift is silent and the symptom is a signal that quietly
 * stops agreeing with the rejection it is supposed to sit just above.
 *
 * THERE IS NO DEFAULT. A missing edge is a compile error, not a fallback, because
 * a fallback would be the copy this exists to prevent.
 */
export interface AntiCheatEdge {
  /** `practice`'s `MIN_AVERAGE_MS_PER_QUESTION`. Read, never redefined. */
  readonly minimumAverageMsPerQuestion: number;
  /** `practice`'s `validateAttempt`. The verdict, not a reimplementation of it. */
  isAttemptValid(responses: readonly ResponseFact[], questionCount: number): boolean;
}
