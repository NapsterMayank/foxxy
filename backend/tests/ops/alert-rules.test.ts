/**
 * Tests for the alerting RULES — 04-RESILIENCE-PLAN.md §5.
 *
 * The rules are pure, so every threshold, every severity and every cooldown is
 * asserted here with no container, no clock and no network.
 *
 * The most important test in this file is `assertRulesAreSatisfiable`: it is
 * the guard against the failure this codebase keeps rediscovering — enforcement
 * that looks installed and enforces nothing. An alert rule watching a signal
 * nothing emits never fires, and a rule that never fires is indistinguishable
 * from a system that is never unhealthy.
 */
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../src/platform/clock/index';
import {
  ALERT_RULES,
  COOLDOWN_BOUNDS,
  CooldownLedger,
  SIGNALS,
  SIGNAL_RANGES,
  assertRulesAreSatisfiable,
  evaluate,
  type AlertRule,
  type AlertSeverity,
  type Comparison,
} from '../../src/platform/alerts/index';
import { producibleSignals } from '../../src/platform/alerts/index';
import { ALERT_CHANNEL_POLICY, ALERT_KIND_PAGE, ALERT_KIND_TICKET } from '../../src/platform/alerts/index';

/** Every signal the shipped collectors can produce, with a backup dir configured. */
const PRODUCIBLE = producibleSignals({ backupDir: '/backup' });

const clock = new FixedClock('2026-08-10T00:00:00.000Z');

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'test_rule',
    signal: 'test.signal',
    comparison: 'gte',
    threshold: 10,
    severity: 'page',
    cooldownSeconds: 600,
    title: { en: 'Test', hi: 'परीक्षण' },
    body: { en: 'value {value} threshold {threshold}', hi: 'मान {value} सीमा {threshold}' },
    runbook: 'docs/runbooks/incident-response.md#test',
    ...overrides,
  };
}

describe('evaluate', () => {
  it('fires when a gte rule is at or above its threshold', () => {
    expect(evaluate([rule()], { 'test.signal': 10 }, clock.now())).toHaveLength(1);
    expect(evaluate([rule()], { 'test.signal': 11 }, clock.now())).toHaveLength(1);
  });

  it('does not fire below the threshold', () => {
    expect(evaluate([rule()], { 'test.signal': 9 }, clock.now())).toHaveLength(0);
  });

  it('supports lte rules', () => {
    const r = rule({ comparison: 'lte', threshold: 5 });
    expect(evaluate([r], { 'test.signal': 5 }, clock.now())).toHaveLength(1);
    expect(evaluate([r], { 'test.signal': 6 }, clock.now())).toHaveLength(0);
  });

  /**
   * THE ONE THAT MATTERS MOST. An absent signal must not be read as zero.
   *
   * "The database is unreachable, so I counted zero breaker transitions" would
   * otherwise be reported as good news, produced by the exact fault the rule is
   * supposed to detect.
   */
  it('never fires on an ABSENT signal, and does not treat absent as zero', () => {
    const lte = rule({ comparison: 'lte', threshold: 5 });
    expect(evaluate([lte], {}, clock.now())).toHaveLength(0);
    // Proof that the rule WOULD have fired had the signal been present and zero.
    expect(evaluate([lte], { 'test.signal': 0 }, clock.now())).toHaveLength(1);
  });

  it('substitutes {value} and {threshold} in BOTH languages (P7)', () => {
    const [alert] = evaluate([rule()], { 'test.signal': 42 }, clock.now());
    expect(alert?.body.en).toBe('value 42 threshold 10');
    expect(alert?.body.hi).toBe('मान 42 सीमा 10');
  });

  it('formats a fraction to two places rather than 0.9333333333', () => {
    const [alert] = evaluate(
      [rule({ signal: 'ratio', threshold: 0.9 })],
      { ratio: 0.93333333 },
      clock.now(),
    );
    expect(alert?.body.en).toBe('value 0.93 threshold 0.90');
  });

  it('fires every matching rule, so a signal can carry both a ticket and a page threshold', () => {
    const fired = evaluate(
      [
        rule({ id: 'low', threshold: 10, severity: 'ticket' }),
        rule({ id: 'high', threshold: 100, severity: 'page' }),
      ],
      { 'test.signal': 150 },
      clock.now(),
    );
    expect(fired.map((alert) => alert.ruleId).sort()).toEqual(['high', 'low']);
  });
});

describe('CooldownLedger', () => {
  it('delivers once, then suppresses until the cooldown expires', () => {
    const ledger = new CooldownLedger();
    const local = new FixedClock('2026-08-10T00:00:00.000Z');
    const r = rule({ cooldownSeconds: 600 });

    expect(ledger.shouldDeliver(r, local.now())).toBe(true);
    local.advanceSeconds(599);
    expect(ledger.shouldDeliver(r, local.now())).toBe(false);
    local.advanceSeconds(1);
    expect(ledger.shouldDeliver(r, local.now())).toBe(true);
  });

  it('cooldowns are per rule, not global', () => {
    const ledger = new CooldownLedger();
    expect(ledger.shouldDeliver(rule({ id: 'a' }), clock.now())).toBe(true);
    expect(ledger.shouldDeliver(rule({ id: 'b' }), clock.now())).toBe(true);
  });

  it('clearing a recovered rule lets it alert immediately when it recurs', () => {
    const ledger = new CooldownLedger();
    const r = rule({ cooldownSeconds: 3600 });
    expect(ledger.shouldDeliver(r, clock.now())).toBe(true);
    expect(ledger.shouldDeliver(r, clock.now())).toBe(false);
    ledger.clear(r.id);
    expect(ledger.shouldDeliver(r, clock.now())).toBe(true);
  });
});

describe('assertRulesAreSatisfiable', () => {
  it('rejects a rule watching a signal nothing produces', () => {
    expect(() =>
      { assertRulesAreSatisfiable([rule({ signal: 'nobody.emits.this' })], ['a.real.signal']); },
    ).toThrow(/can never fire/);
  });

  /**
   * `a.real.signal` was a made-up name here until the reachability half landed.
   * It has to be a REAL signal now, because a signal with no declared range is
   * itself rejected — see 'refuses a producible signal that has no declared
   * range' below. That tightening is the point, not an inconvenience: an
   * invented signal name is exactly what a typo produces.
   */
  it('accepts rules whose signals are all produced', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ signal: SIGNALS.BREAKER_OPENED, threshold: 1 })],
        [SIGNALS.BREAKER_OPENED],
      );
    }).not.toThrow();
  });

  /**
   * The real configuration, checked. Without this the whole guard is a function
   * nobody calls with the production arguments.
   *
   * `backupDir` is supplied because the backup-age signal is only produced when
   * a directory is configured — which is itself the orphan-rule problem one
   * level up, and is why `producibleSignals` takes the option rather than
   * claiming the signal unconditionally.
   */
  it('the SHIPPED rules are all satisfiable by the SHIPPED collectors', () => {
    expect(() =>
      { assertRulesAreSatisfiable(ALERT_RULES, producibleSignals({ backupDir: '/backup' })); },
    ).not.toThrow();
  });

  it('without a backup directory the backup rule is correctly reported as unsatisfiable', () => {
    expect(() =>
      { assertRulesAreSatisfiable(ALERT_RULES, producibleSignals({ backupDir: undefined })); },
    ).toThrow(/backup\.age_hours/);
  });

  /**
   * =========================================================================
   * THE HALF THAT WAS MISSING, AND THAT MADE THE WHOLE GUARD WALK-PAST-ABLE.
   *
   * The name check alone accepts `readiness.failing >= 1000000`. Every signal
   * name correct, every rule permanently disabled, and this file's own header
   * calling itself "the guard against enforcement that looks installed and
   * enforces nothing".
   */
  it('rejects a gte threshold ABOVE the signal ceiling — the disabled-rule shape', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ id: 'inflated', signal: SIGNALS.READINESS_FAILING, threshold: 1_000_000 })],
        PRODUCIBLE,
      );
    }).toThrow(/can never fire/);
  });

  it('rejects a ratio threshold of 99.0 — unreachable by arithmetic, not merely strict', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ id: 'ratio', signal: SIGNALS.DB_POOL_SATURATION, threshold: 99 })],
        PRODUCIBLE,
      );
    }).toThrow(/outside the reachable range 0\.5\.\.1/);
  });

  it('rejects an age threshold of 360000 hours — 41 years is not a stricter backup alert', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ id: 'ancient', signal: SIGNALS.BACKUP_AGE_HOURS, threshold: 360_000 })],
        PRODUCIBLE,
      );
    }).toThrow(/can never fire/);
  });

  it('rejects an lte threshold BELOW the floor, the mirror of the gte case', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [
          rule({
            id: 'floor',
            signal: SIGNALS.DB_POOL_SATURATION,
            comparison: 'lte',
            threshold: -1,
          }),
        ],
        PRODUCIBLE,
      );
    }).toThrow(/can never fire/);
  });

  it('accepts a threshold at each end of the declared range — the bounds are inclusive', () => {
    const range = SIGNAL_RANGES[SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS];
    expect(() => {
      assertRulesAreSatisfiable(
        [
          rule({ id: 'floor', signal: SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS, threshold: range.min }),
          rule({ id: 'ceil', signal: SIGNALS.WORKER_HEARTBEAT_AGE_SECONDS, threshold: range.max }),
        ],
        PRODUCIBLE,
      );
    }).not.toThrow();
  });

  /**
   * A cooldown is the third way to silence a rule while leaving it in the
   * config. `cooldownSeconds: 21_600_000` is 250 days and satisfies `> 0`.
   */
  it('rejects a cooldown long enough to silence the rule for eight months', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ signal: SIGNALS.BACKUP_AGE_HOURS, threshold: 36, cooldownSeconds: 21_600_000 })],
        PRODUCIBLE,
      );
    }).toThrow(/cooldownSeconds/);
  });

  it('rejects a cooldown shorter than an evaluation interval', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ signal: SIGNALS.BREAKER_OPENED, threshold: 1, cooldownSeconds: 1 })],
        PRODUCIBLE,
      );
    }).toThrow(/cooldownSeconds/);
  });

  /**
   * "Cannot be checked" must never quietly become "is fine". That inversion is
   * the same one `evaluate()` refuses one layer down when it declines to read an
   * absent signal as zero.
   */
  it('refuses a producible signal that has no declared range rather than passing it', () => {
    expect(() => {
      assertRulesAreSatisfiable(
        [rule({ id: 'undeclared', signal: 'newly.added.signal' })],
        ['newly.added.signal'],
      );
    }).toThrow(/no entry in SIGNAL_RANGES/);
  });

  it('every signal the collectors can produce has a declared range', () => {
    const declared = new Set(Object.keys(SIGNAL_RANGES));
    for (const signal of PRODUCIBLE) {
      expect(declared, signal).toContain(signal);
    }
  });
});

/**
 * =============================================================================
 * THE AUDITOR'S MUTATION, RE-APPLIED IN FULL.
 *
 * An auditor inflated every shipped threshold to an unreachable value and
 * downgraded ten of the eleven `page` rules to `ticket`. 23 of 23 tests passed.
 * The entire alert set was disabled and the suite reported it healthy.
 *
 * This describe block IS that mutation. It must be red on the mutated set and
 * green on the shipped one, and it is the single test that proves the other
 * twenty-three were count-shaped.
 */
describe('the auditor mutation — every threshold inflated, every page downgraded', () => {
  /** Typed once so the mutation needs no inline assertion. */
  const TICKET: AlertSeverity = 'ticket';

  /** `1 -> 1000000`, `0.9 -> 99.0`, `36 -> 360000`, `page -> ticket`. */
  function inflate(source: readonly AlertRule[]): AlertRule[] {
    return source.map((r) => ({
      ...r,
      threshold: r.threshold < 1 ? 99 : r.threshold * 1_000_000,
      severity: TICKET,
    }));
  }

  it('the satisfiability guard now REJECTS the inflated set', () => {
    expect(() => {
      assertRulesAreSatisfiable(inflate(ALERT_RULES), PRODUCIBLE);
    }).toThrow(/can never fire/);
  });

  it('names every inflated rule, not just the first — an operator fixes them in one pass', () => {
    let message = '';
    try {
      assertRulesAreSatisfiable(inflate(ALERT_RULES), PRODUCIBLE);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    for (const r of ALERT_RULES) {
      expect(message, r.id).toContain(r.id);
    }
  });

  it('the severity downgrade is caught by the per-rule pin, which a `some` cannot see', () => {
    const downgraded: readonly AlertRule[] = ALERT_RULES.map((r) => ({
      ...r,
      severity: r.id === 'readiness_failing' ? r.severity : TICKET,
    }));
    // The old assertion — `some(r => r.severity === 'page')` — still passes on
    // this, because ONE page rule survives. That is the defect, demonstrated.
    expect(downgraded.some((r) => r.severity === 'page')).toBe(true);
    // The pin does not.
    const pagesNow = downgraded.filter((r) => r.severity === 'page').map((r) => r.id);
    const pagesExpected = ALERT_RULES.filter((r) => r.severity === 'page').map((r) => r.id);
    expect(pagesNow).not.toEqual(pagesExpected);
  });
});

/**
 * =============================================================================
 * THE PER-RULE PIN — every shipped rule's threshold, severity and comparison,
 * as literals. Shaped after `src/platform/config/__tests__/timeouts.test.ts`,
 * which pins the §4 timeout table row for row and for the same reason.
 *
 * Not derived from `ALERT_RULES`. A table built out of the thing it checks
 * checks nothing — it is the shape that let eleven inflated thresholds through.
 * These numbers are transcribed by hand; changing one means changing it here
 * too, in a diff a reviewer sees.
 */
describe('the shipped rules match the table, row for row', () => {
  it.each([
    ['readiness_failing', 'readiness.failing', 'gte', 1, 'page', 300],
    ['db_pool_saturated', 'db.pool_saturation', 'gte', 0.9, 'page', 600],
    ['breaker_opened', 'breaker.opened', 'gte', 1, 'page', 900],
    ['rate_limit_fallback', 'rate_limit.fallback', 'gte', 1, 'page', 900],
    ['worker_heartbeat_stale', 'worker.heartbeat_age_seconds', 'gte', 300, 'page', 1_800],
    ['backup_stale', 'backup.age_hours', 'gte', 36, 'page', 21_600],
    ['dependency_error_rate_high', 'dependency.errors', 'gte', 50, 'page', 900],
    ['job_dead_letter_storm', 'job.dead_lettered', 'gte', 10, 'page', 1_800],
    ['job_dead_lettered', 'job.dead_lettered', 'gte', 1, 'ticket', 3_600],
    ['dependency_errors_elevated', 'dependency.errors', 'gte', 10, 'ticket', 3_600],
    ['notify_delivery_failing', 'notify.failed', 'gte', 5, 'ticket', 3_600],
    ['notify_undeliverable', 'notify.undeliverable', 'gte', 1, 'ticket', 3_600],
  ] as const)(
    '%s watches %s %s %d as a %s, cooling down for %ds',
    (id, signal, comparison, threshold, severity, cooldownSeconds) => {
      const found = ALERT_RULES.find((r) => r.id === id);
      expect(found, `rule '${id}' has been renamed or removed`).toBeDefined();
      expect(found?.signal).toBe(signal satisfies string);
      expect(found?.comparison).toBe(comparison satisfies Comparison);
      expect(found?.threshold).toBe(threshold);
      expect(found?.severity).toBe(severity satisfies AlertSeverity);
      expect(found?.cooldownSeconds).toBe(cooldownSeconds);
    },
  );

  /**
   * The table above is only a pin if it is TOTAL. A rule added without a row
   * here would be unpinned, which is where this started.
   */
  it('pins every shipped rule — the table is exhaustive, not a sample', () => {
    const pinned = [
      'readiness_failing',
      'db_pool_saturated',
      'breaker_opened',
      'rate_limit_fallback',
      'worker_heartbeat_stale',
      'backup_stale',
      'dependency_error_rate_high',
      'job_dead_letter_storm',
      'job_dead_lettered',
      'dependency_errors_elevated',
      'notify_delivery_failing',
      'notify_undeliverable',
    ];
    expect(ALERT_RULES.map((r) => r.id).sort()).toEqual([...pinned].sort());
  });

  /**
   * The exact page/ticket partition, by id. `some(severity === 'page')` is
   * satisfied by one surviving page rule while ten are downgraded; this is not.
   */
  it('pins WHICH rules page, not merely that one of them does', () => {
    expect(ALERT_RULES.filter((r) => r.severity === 'page').map((r) => r.id).sort()).toEqual(
      [
        'backup_stale',
        'breaker_opened',
        'db_pool_saturated',
        'dependency_error_rate_high',
        'job_dead_letter_storm',
        'rate_limit_fallback',
        'readiness_failing',
        'worker_heartbeat_stale',
      ].sort(),
    );
  });

  it('every shipped threshold sits inside its own declared range', () => {
    for (const r of ALERT_RULES) {
      const range = SIGNAL_RANGES[r.signal as keyof typeof SIGNAL_RANGES];
      expect(range, `${r.id} watches an undeclared signal`).toBeDefined();
      expect(r.threshold, r.id).toBeGreaterThanOrEqual(range.min);
      expect(r.threshold, r.id).toBeLessThanOrEqual(range.max);
    }
  });

  it('every shipped cooldown sits inside the cooldown bounds', () => {
    for (const r of ALERT_RULES) {
      expect(r.cooldownSeconds, r.id).toBeGreaterThanOrEqual(COOLDOWN_BOUNDS.minSeconds);
      expect(r.cooldownSeconds, r.id).toBeLessThanOrEqual(COOLDOWN_BOUNDS.maxSeconds);
    }
  });
});

describe('the shipped rule set', () => {
  it('covers every condition 04-RESILIENCE-PLAN.md section 5 names', () => {
    const covered = new Set(ALERT_RULES.map((r) => r.signal));
    expect(covered).toContain(SIGNALS.BREAKER_OPENED);
    expect(covered).toContain(SIGNALS.RATE_LIMIT_FALLBACK);
    expect(covered).toContain(SIGNALS.JOB_DEAD_LETTERED);
    expect(covered).toContain(SIGNALS.READINESS_FAILING);
    expect(covered).toContain(SIGNALS.DB_POOL_SATURATION);
    expect(covered).toContain(SIGNALS.DEPENDENCY_ERRORS);
    // D-146, closed. "A notification reached nobody" had no metric and therefore
    // no rule; both exist now.
    expect(covered).toContain(SIGNALS.NOTIFY_UNDELIVERABLE);
  });

  it('has unique rule ids — a duplicate would share a cooldown and silence one of them', () => {
    const ids = ALERT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every rule points at a runbook anchor', () => {
    for (const r of ALERT_RULES) {
      expect(r.runbook, r.id).toMatch(/^docs\/runbooks\/.+#.+$/);
    }
  });

  it('every rule is bilingual with real Devanagari, not a copy of the English (P7)', () => {
    for (const r of ALERT_RULES) {
      expect(r.title.hi.length, r.id).toBeGreaterThan(0);
      expect(r.body.hi.length, r.id).toBeGreaterThan(0);
      expect(r.title.hi, r.id).not.toBe(r.title.en);
      expect(r.body.hi, r.id).toMatch(/[ऀ-ॿ]/);
    }
  });

  it('every rule has a non-zero cooldown — a flapping dependency must not become a flapping pager', () => {
    for (const r of ALERT_RULES) {
      expect(r.cooldownSeconds, r.id).toBeGreaterThan(0);
    }
  });

  /**
   * The page/ticket split is a real split, not a field everybody sets to 'page'.
   * If every rule pages, the pager gets ignored and the next real outage arrives
   * as a notification somebody swipes away.
   */
  it('is a genuine split: at least one page rule and at least one ticket rule', () => {
    expect(ALERT_RULES.some((r) => r.severity === 'page')).toBe(true);
    expect(ALERT_RULES.some((r) => r.severity === 'ticket')).toBe(true);
  });
});

describe('the channel policy', () => {
  it('pages reach email AND leave a durable in-app record', () => {
    expect(ALERT_CHANNEL_POLICY[ALERT_KIND_PAGE]).toEqual(['email', 'in-app']);
  });

  it('tickets are filed in-app and do NOT send email', () => {
    expect(ALERT_CHANNEL_POLICY[ALERT_KIND_TICKET]).toEqual(['in-app']);
  });

  it('declares a policy for both kinds — an unknown kind falls back to in-app only, which would silently downgrade a page', () => {
    expect(Object.keys(ALERT_CHANNEL_POLICY).sort()).toEqual([ALERT_KIND_PAGE, ALERT_KIND_TICKET].sort());
  });
});
