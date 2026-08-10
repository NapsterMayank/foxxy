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
  CooldownLedger,
  SIGNALS,
  assertRulesAreSatisfiable,
  evaluate,
  type AlertRule,
} from '../../scripts/ops/alert-rules';
import { producibleSignals } from '../../scripts/ops/alert-sources';
import { ALERT_CHANNEL_POLICY, ALERT_KIND_PAGE, ALERT_KIND_TICKET } from '../../scripts/ops/alert-evaluator';

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

  it('accepts rules whose signals are all produced', () => {
    expect(() =>
      { assertRulesAreSatisfiable([rule({ signal: 'a.real.signal' })], ['a.real.signal']); },
    ).not.toThrow();
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
