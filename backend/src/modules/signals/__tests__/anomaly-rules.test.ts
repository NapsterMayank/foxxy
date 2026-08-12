import { describe, expect, it } from 'vitest';
import { MIN_AVERAGE_MS_PER_QUESTION, validateAttempt } from '@/modules/practice/domain/anti-cheat';
import {
  ANOMALY_RULES_V1_ACTIVE_FROM,
  createAnomalyRuleRegistry,
} from '../domain/anomaly-rules';
import { detectFromFacts } from '../domain/detect-anomalies';
import {
  FAST_COMPLETION_FLOOR_MULTIPLE,
  INACTIVITY_DAYS,
  MASTERY_DROP_MIN_PERCENTAGE_POINTS,
  MS_PER_DAY,
  REPEATED_STRUGGLE_SESSIONS,
  STRUGGLE_SCORE_PERCENT,
} from '../domain/thresholds';
import type {
  AnomalySignal,
  AntiCheatEdge,
  ResponseFact,
  SessionFact,
  StudentActivityFacts,
} from '../signals.types';

/**
 * THE EDGE IS BUILT FROM `practice`'s REAL FUNCTIONS, not from a stub.
 *
 * A fake floor would let this suite pass while the two constants disagreed in
 * production, which is the precise failure the injected edge exists to prevent.
 * The test file may reach into `practice/domain` (test files are exempt from the
 * module-boundary rule); production code goes through the edge.
 */
const realAntiCheat: AntiCheatEdge = {
  minimumAverageMsPerQuestion: MIN_AVERAGE_MS_PER_QUESTION,
  isAttemptValid: (responses, questionCount) =>
    validateAttempt(responses, questionCount).isValid,
};

const registry = createAnomalyRuleRegistry(realAntiCheat);

const STUDENT = '11111111-1111-1111-1111-111111111111';
const CHAPTER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAPTER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const WINDOW_END = new Date('2026-08-01T00:00:00.000Z');
const WINDOW_START = new Date(WINDOW_END.getTime() - 30 * MS_PER_DAY);
/** After `ANOMALY_RULES_V1_ACTIVE_FROM`, so version 1 resolves. */
const EVALUATED_AT = new Date('2026-09-01T00:00:00.000Z');

function daysBefore(days: number): Date {
  return new Date(WINDOW_END.getTime() - days * MS_PER_DAY);
}

function responses(count: number, msEach: number, index = 0): ResponseFact[] {
  return Array.from({ length: count }, (_unused, i) => ({
    // Varied indices, so `practice`'s all-same-answer rule does not fire and
    // confuse a test that is about speed.
    selectedIndex: (index + i) % 4,
    timeSpentMs: msEach,
  }));
}

function session(overrides: Partial<SessionFact> = {}): SessionFact {
  const base: SessionFact = {
    sessionId: `session-${String(overrides.scorePercent ?? 0)}-${String(
      overrides.submittedAt?.getTime() ?? 0,
    )}`,
    chapterId: CHAPTER_A,
    submittedAt: daysBefore(1),
    scorePercent: 80,
    isValid: true,
    questionCount: 10,
    responses: responses(10, 30_000),
  };
  return { ...base, ...overrides };
}

function facts(overrides: Partial<StudentActivityFacts> = {}): StudentActivityFacts {
  return {
    studentUserId: STUDENT,
    window: { from: WINDOW_START, to: WINDOW_END },
    sessions: [],
    lastActivityAt: daysBefore(1),
    ...overrides,
  };
}

function detect(input: StudentActivityFacts): readonly AnomalySignal[] {
  return detectFromFacts(registry, input, EVALUATED_AT);
}

function kinds(signals: readonly AnomalySignal[]): string[] {
  return signals.map((signal) => signal.kind);
}

// ===========================================================================

describe('thresholds are named constants, not magic numbers', () => {
  it('holds the agreed values', () => {
    expect(INACTIVITY_DAYS).toBe(7);
    expect(MASTERY_DROP_MIN_PERCENTAGE_POINTS).toBe(15);
    expect(FAST_COMPLETION_FLOOR_MULTIPLE).toBe(2);
    expect(STRUGGLE_SCORE_PERCENT).toBe(40);
    expect(REPEATED_STRUGGLE_SESSIONS).toBe(3);
  });

  it('does NOT define an anti-cheat floor of its own — it uses practice’s', () => {
    // The fast-completion ceiling is DERIVED from the injected floor. If signals
    // ever grows its own copy, this relationship is where it will show.
    const ceiling = realAntiCheat.minimumAverageMsPerQuestion * FAST_COMPLETION_FLOOR_MULTIPLE;
    expect(realAntiCheat.minimumAverageMsPerQuestion).toBe(MIN_AVERAGE_MS_PER_QUESTION);
    expect(ceiling).toBe(6_000);
  });

  it('keeps the mastery-drop threshold above one question on a ten-question set', () => {
    // The rationale in thresholds.ts, asserted: below 10 the rule fires on noise.
    expect(MASTERY_DROP_MIN_PERCENTAGE_POINTS).toBeGreaterThan(100 / 10);
  });
});

describe('a student with no history', () => {
  it('produces NO signals rather than an error', () => {
    const signals = detect(facts({ sessions: [], lastActivityAt: null }));
    expect(signals).toEqual([]);
  });

  it('is not reported as inactive — "never started" is not "stopped"', () => {
    const signals = detect(facts({ sessions: [], lastActivityAt: null }));
    expect(kinds(signals)).not.toContain('inactivity');
  });
});

describe('rule 1 — inactivity', () => {
  it('does NOT fire one day below the threshold', () => {
    const signals = detect(
      facts({ lastActivityAt: daysBefore(INACTIVITY_DAYS - 1), sessions: [] }),
    );
    expect(kinds(signals)).not.toContain('inactivity');
  });

  it('FIRES exactly at the threshold — the boundary is inclusive', () => {
    const signals = detect(facts({ lastActivityAt: daysBefore(INACTIVITY_DAYS), sessions: [] }));
    expect(kinds(signals)).toContain('inactivity');
  });

  it('fires beyond the threshold and reports the real number of days', () => {
    const signals = detect(facts({ lastActivityAt: daysBefore(21), sessions: [] }));
    const signal = signals.find((s) => s.kind === 'inactivity');
    expect(signal?.evidence.daysInactive).toBe(21);
    expect(signal?.evidence.thresholdDays).toBe(INACTIVITY_DAYS);
    expect(signal?.chapterId).toBeNull();
  });

  it('measures to the window END, not to a clock', () => {
    const early = detect(facts({ lastActivityAt: daysBefore(10), sessions: [] }));
    const later = detect({
      ...facts({ lastActivityAt: daysBefore(10), sessions: [] }),
      window: { from: WINDOW_START, to: new Date(WINDOW_END.getTime() + 5 * MS_PER_DAY) },
    });
    expect(early.find((s) => s.kind === 'inactivity')?.evidence.daysInactive).toBe(10);
    expect(later.find((s) => s.kind === 'inactivity')?.evidence.daysInactive).toBe(15);
  });
});

describe('rule 2 — mastery drop', () => {
  const twoSessions = (first: number, second: number): SessionFact[] => [
    session({ sessionId: 's1', submittedAt: daysBefore(5), scorePercent: first }),
    session({ sessionId: 's2', submittedAt: daysBefore(4), scorePercent: second }),
  ];

  it('does NOT fire one point below the threshold', () => {
    const drop = MASTERY_DROP_MIN_PERCENTAGE_POINTS - 1;
    const signals = detect(facts({ sessions: twoSessions(80, 80 - drop) }));
    expect(kinds(signals)).not.toContain('mastery_drop');
  });

  it('FIRES exactly at the threshold', () => {
    const signals = detect(
      facts({ sessions: twoSessions(80, 80 - MASTERY_DROP_MIN_PERCENTAGE_POINTS) }),
    );
    expect(kinds(signals)).toContain('mastery_drop');
  });

  it('does not fire when the score IMPROVES', () => {
    const signals = detect(facts({ sessions: twoSessions(40, 90) }));
    expect(kinds(signals)).not.toContain('mastery_drop');
  });

  it('compares CONSECUTIVE sessions, not best against latest', () => {
    // 90 then 88 then 86: never a 15-point step, though the total fall is 4.
    const signals = detect(
      facts({
        sessions: [
          session({ sessionId: 'a', submittedAt: daysBefore(6), scorePercent: 90 }),
          session({ sessionId: 'b', submittedAt: daysBefore(5), scorePercent: 88 }),
          session({ sessionId: 'c', submittedAt: daysBefore(4), scorePercent: 86 }),
        ],
      }),
    );
    expect(kinds(signals)).not.toContain('mastery_drop');
  });

  it('only compares sessions on the SAME chapter', () => {
    const signals = detect(
      facts({
        sessions: [
          session({ sessionId: 'a', chapterId: CHAPTER_A, scorePercent: 95 }),
          session({ sessionId: 'b', chapterId: CHAPTER_B, scorePercent: 30 }),
        ],
      }),
    );
    expect(kinds(signals)).not.toContain('mastery_drop');
  });

  it('SKIPS an abandoned session rather than scoring it zero', () => {
    const signals = detect(
      facts({
        sessions: [
          session({ sessionId: 'a', submittedAt: daysBefore(6), scorePercent: 80 }),
          session({ sessionId: 'b', submittedAt: daysBefore(5), scorePercent: null }),
          session({ sessionId: 'c', submittedAt: daysBefore(4), scorePercent: 78 }),
        ],
      }),
    );
    expect(kinds(signals)).not.toContain('mastery_drop');
  });

  it('reports the two scores and the drop', () => {
    const signals = detect(facts({ sessions: twoSessions(90, 60) }));
    const signal = signals.find((s) => s.kind === 'mastery_drop');
    expect(signal?.evidence.previousScorePercent).toBe(90);
    expect(signal?.evidence.currentScorePercent).toBe(60);
    expect(signal?.evidence.dropPercentagePoints).toBe(30);
    expect(signal?.chapterId).toBe(CHAPTER_A);
  });
});

describe('rule 3 — unusually fast completion, above the anti-cheat floor', () => {
  const ceiling = MIN_AVERAGE_MS_PER_QUESTION * FAST_COMPLETION_FLOOR_MULTIPLE;

  it('does NOT fire exactly at the ceiling — the boundary is exclusive', () => {
    const signals = detect(
      facts({ sessions: [session({ responses: responses(10, ceiling), isValid: true })] }),
    );
    expect(kinds(signals)).not.toContain('fast_completion');
  });

  it('FIRES one millisecond below the ceiling', () => {
    const signals = detect(
      facts({ sessions: [session({ responses: responses(10, ceiling - 1), isValid: true })] }),
    );
    expect(kinds(signals)).toContain('fast_completion');
  });

  it('SKIPS an attempt practice already rejected — it is not double-reported', () => {
    const signals = detect(
      facts({
        sessions: [
          session({ responses: responses(10, MIN_AVERAGE_MS_PER_QUESTION - 1), isValid: false }),
        ],
      }),
    );
    expect(kinds(signals)).not.toContain('fast_completion');
  });

  it('asks the injected edge when practice never recorded a verdict', () => {
    // isValid null, and the attempt is below practice's floor: the edge must
    // reject it, so no signal. A signals-local floor would get this wrong.
    const signals = detect(
      facts({
        sessions: [
          session({
            responses: responses(10, MIN_AVERAGE_MS_PER_QUESTION - 500),
            isValid: null,
          }),
        ],
      }),
    );
    expect(kinds(signals)).not.toContain('fast_completion');
  });

  it('fires for a null-verdict attempt that the edge accepts', () => {
    const signals = detect(
      facts({ sessions: [session({ responses: responses(10, ceiling - 500), isValid: null })] }),
    );
    expect(kinds(signals)).toContain('fast_completion');
  });

  it('ignores a session with no responses rather than dividing by zero', () => {
    const signals = detect(
      facts({ sessions: [session({ responses: [], questionCount: 0 })] }),
    );
    expect(kinds(signals)).not.toContain('fast_completion');
  });

  it('reports the floor it sits above, so the relationship is visible', () => {
    const signals = detect(
      facts({ sessions: [session({ responses: responses(10, 4_000), isValid: true })] }),
    );
    const signal = signals.find((s) => s.kind === 'fast_completion');
    expect(signal?.evidence.averageMsPerQuestion).toBe(4_000);
    expect(signal?.evidence.antiCheatFloorMs).toBe(MIN_AVERAGE_MS_PER_QUESTION);
    expect(signal?.evidence.ceilingMs).toBe(ceiling);
  });
});

describe('rule 4 — repeated struggle (the teacher-escalation trigger)', () => {
  const failing = (n: number, chapterId = CHAPTER_A): SessionFact[] =>
    Array.from({ length: n }, (_unused, i) =>
      session({
        sessionId: `fail-${String(i)}`,
        chapterId,
        submittedAt: daysBefore(10 - i),
        scorePercent: STRUGGLE_SCORE_PERCENT - 10,
      }),
    );

  it('does NOT fire one session below the threshold', () => {
    const signals = detect(facts({ sessions: failing(REPEATED_STRUGGLE_SESSIONS - 1) }));
    expect(kinds(signals)).not.toContain('repeated_struggle');
  });

  it('FIRES exactly at the threshold', () => {
    const signals = detect(facts({ sessions: failing(REPEATED_STRUGGLE_SESSIONS) }));
    expect(kinds(signals)).toContain('repeated_struggle');
  });

  it('counts a session AT the failing score — the boundary is inclusive', () => {
    const signals = detect(
      facts({
        sessions: Array.from({ length: REPEATED_STRUGGLE_SESSIONS }, (_unused, i) =>
          session({
            sessionId: `edge-${String(i)}`,
            submittedAt: daysBefore(10 - i),
            scorePercent: STRUGGLE_SCORE_PERCENT,
          }),
        ),
      }),
    );
    expect(kinds(signals)).toContain('repeated_struggle');
  });

  it('does not count a session one point above the failing score', () => {
    const signals = detect(
      facts({
        sessions: Array.from({ length: REPEATED_STRUGGLE_SESSIONS }, (_unused, i) =>
          session({
            sessionId: `pass-${String(i)}`,
            submittedAt: daysBefore(10 - i),
            scorePercent: STRUGGLE_SCORE_PERCENT + 1,
          }),
        ),
      }),
    );
    expect(kinds(signals)).not.toContain('repeated_struggle');
  });

  it('counts failures per CHAPTER, not across the student', () => {
    const signals = detect(
      facts({
        sessions: [...failing(2, CHAPTER_A), ...failing(2, CHAPTER_B)],
      }),
    );
    expect(kinds(signals)).not.toContain('repeated_struggle');
  });

  it('does NOT require the failures to be consecutive', () => {
    const signals = detect(
      facts({
        sessions: [
          session({ sessionId: 'f1', submittedAt: daysBefore(9), scorePercent: 20 }),
          session({ sessionId: 'p1', submittedAt: daysBefore(8), scorePercent: 75 }),
          session({ sessionId: 'f2', submittedAt: daysBefore(7), scorePercent: 25 }),
          session({ sessionId: 'f3', submittedAt: daysBefore(6), scorePercent: 30 }),
        ],
      }),
    );
    expect(kinds(signals)).toContain('repeated_struggle');
  });

  it('raises one signal per struggling chapter, in a stable chapter order', () => {
    const signals = detect(
      facts({ sessions: [...failing(3, CHAPTER_A), ...failing(3, CHAPTER_B)] }),
    );
    const struggles = signals.filter((s) => s.kind === 'repeated_struggle');
    expect(struggles).toHaveLength(2);
    expect(struggles.map((s) => s.chapterId)).toEqual([CHAPTER_A, CHAPTER_B]);
  });
});

describe('every signal carries a rule version', () => {
  it('stamps code, version and code@version', () => {
    const signals = detect(facts({ lastActivityAt: daysBefore(30), sessions: [] }));
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.ruleVersion).toBe(1);
      expect(signal.ruleStamp).toBe(`${signal.ruleCode}@${String(signal.ruleVersion)}`);
      expect(signal.detectedAt).toEqual(EVALUATED_AT);
      expect(signal.studentUserId).toBe(STUDENT);
    }
  });

  it('stamps every kind with its own code', () => {
    const signals = detect(
      facts({
        lastActivityAt: daysBefore(30),
        sessions: [
          session({ sessionId: 'a', submittedAt: daysBefore(12), scorePercent: 90 }),
          session({ sessionId: 'b', submittedAt: daysBefore(11), scorePercent: 20 }),
          session({ sessionId: 'c', submittedAt: daysBefore(10), scorePercent: 20 }),
          session({
            sessionId: 'd',
            submittedAt: daysBefore(9),
            scorePercent: 20,
            responses: responses(10, 4_000),
          }),
        ],
      }),
    );
    const stamps = new Map(signals.map((s) => [s.kind, s.ruleStamp]));
    expect(stamps.get('inactivity')).toBe('inactivity@1');
    expect(stamps.get('mastery_drop')).toBe('mastery_drop@1');
    expect(stamps.get('repeated_struggle')).toBe('repeated_struggle@1');
    expect(stamps.get('fast_completion')).toBe('fast_completion@1');
  });

  it('produces NOTHING before the rules were active — no signal is ever unstamped', () => {
    const beforeRelease = new Date(ANOMALY_RULES_V1_ACTIVE_FROM.getTime() - 1);
    expect(
      detectFromFacts(registry, facts({ lastActivityAt: daysBefore(30) }), beforeRelease),
    ).toEqual([]);
  });
});

describe('determinism', () => {
  it('repeated detection over the same facts returns an identical result', () => {
    const input = facts({
      lastActivityAt: daysBefore(30),
      sessions: [...failingPair(), session({ sessionId: 'z', scorePercent: 20 })],
    });
    expect(detect(input)).toEqual(detect(input));
  });

  it('the order does not depend on the order sessions arrived in per chapter', () => {
    const a = detect(
      facts({ sessions: [...repeatFail(CHAPTER_B), ...repeatFail(CHAPTER_A)] }),
    );
    const b = detect(
      facts({ sessions: [...repeatFail(CHAPTER_A), ...repeatFail(CHAPTER_B)] }),
    );
    expect(a.map((s) => s.chapterId)).toEqual(b.map((s) => s.chapterId));
  });
});

function failingPair(): SessionFact[] {
  return [
    session({ sessionId: 'p1', submittedAt: daysBefore(9), scorePercent: 90 }),
    session({ sessionId: 'p2', submittedAt: daysBefore(8), scorePercent: 20 }),
  ];
}

function repeatFail(chapterId: string): SessionFact[] {
  return Array.from({ length: REPEATED_STRUGGLE_SESSIONS }, (_unused, i) =>
    session({
      sessionId: `${chapterId}-${String(i)}`,
      chapterId,
      submittedAt: daysBefore(10 - i),
      scorePercent: 10,
    }),
  );
}

describe('NO PII in any signal payload (P13)', () => {
  const banned = /name|email|phone|address|dob|birth|parent|guardian|password|token/i;

  const everySignal = (): readonly AnomalySignal[] =>
    detect(
      facts({
        lastActivityAt: daysBefore(30),
        sessions: [
          session({ sessionId: 'a', submittedAt: daysBefore(12), scorePercent: 90 }),
          session({ sessionId: 'b', submittedAt: daysBefore(11), scorePercent: 20 }),
          session({ sessionId: 'c', submittedAt: daysBefore(10), scorePercent: 20 }),
          session({
            sessionId: 'd',
            submittedAt: daysBefore(9),
            scorePercent: 20,
            responses: responses(10, 4_000),
          }),
        ],
      }),
    );

  it('every evidence VALUE is a finite number — a name cannot be stored in one', () => {
    for (const signal of everySignal()) {
      for (const value of Object.values(signal.evidence)) {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('no evidence KEY names a personal field', () => {
    for (const signal of everySignal()) {
      for (const key of Object.keys(signal.evidence)) {
        expect(key).not.toMatch(banned);
      }
    }
  });

  it('no reason string carries a personal field, a title or free text from content', () => {
    for (const signal of everySignal()) {
      expect(signal.reason).not.toMatch(banned);
      // Reasons are assembled from numbers and fixed words only, so no uuid
      // (a session or chapter id) can appear in the human-readable sentence.
      expect(signal.reason).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });

  it('the whole serialised payload contains no personal field', () => {
    const serialised = JSON.stringify(everySignal());
    expect(serialised).not.toMatch(banned);
  });

  it('carries the identifiers it needs to be actionable, and only those', () => {
    const signal = everySignal()[0];
    expect(signal?.studentUserId).toBe(STUDENT);
    expect(Object.keys(signal ?? {}).sort()).toEqual([
      'chapterId',
      'detectedAt',
      'evidence',
      'kind',
      'reason',
      'ruleCode',
      'ruleStamp',
      'ruleVersion',
      'studentUserId',
    ]);
  });
});
