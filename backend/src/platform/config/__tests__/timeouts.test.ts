import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_CONCURRENCY_LIMITS,
  DEFAULT_TIMEOUT_POLICY,
  parseBreakerPolicy,
  parseConcurrencyLimits,
  parseTimeoutPolicy,
  timeoutRuleSchema,
} from '../timeouts';

/**
 * 04-RESILIENCE-PLAN.md §4 — "Timeouts are configuration, not constants
 * scattered through the code."
 *
 * These tests are the transcription check. The table in §4 is the contract; if
 * somebody edits a number here, one of these fails and they have to go and
 * change the plan too. That is the point — a policy that drifts away from its
 * document silently is a policy nobody can reason about during an incident.
 */

describe('the timeout policy matches the §4 table, row for row', () => {
  it.each([
    ['postgres', 2_000, 10_000, 0],
    ['postgresVector', 2_000, 5_000, 0],
    ['cache', 500, 1_000, 1],
    ['llm', 3_000, 30_000, 1],
    ['embed', 2_000, 5_000, 2],
    ['mail', 3_000, 10_000, 3],
    ['payments', 3_000, 15_000, 0],
  ] as const)('%s: connect %ims, total %ims, %i retries', (port, connectMs, totalMs, retries) => {
    expect(DEFAULT_TIMEOUT_POLICY[port]).toMatchObject({ connectMs, totalMs, retries });
  });

  it('gives streaming 8s to the first token and 60s in total', () => {
    expect(DEFAULT_TIMEOUT_POLICY.llmStreaming).toMatchObject({
      connectMs: 3_000,
      firstTokenMs: 8_000,
      totalMs: 60_000,
    });
  });

  it('never retries a stream once it has begun', () => {
    // Restarting a stream mid-sentence shows the student two different half
    // answers. §4: "none once streaming has begun".
    expect(DEFAULT_TIMEOUT_POLICY.llmStreaming.retries).toBe(0);
  });

  it('never retries a payment write', () => {
    // "retrying a payment is worse than failing it."
    expect(DEFAULT_TIMEOUT_POLICY.payments.retries).toBe(0);
  });

  it('gives vector search a SHORTER budget than ordinary queries', () => {
    // §3.1 caps how many connections vector search may hold; this caps how
    // long it may hold one.
    expect(DEFAULT_TIMEOUT_POLICY.postgresVector.totalMs).toBeLessThan(
      DEFAULT_TIMEOUT_POLICY.postgres.totalMs,
    );
  });
});

describe('the policy is validated, not merely declared', () => {
  it('accepts the shipped policy', () => {
    expect(() => parseTimeoutPolicy(DEFAULT_TIMEOUT_POLICY)).not.toThrow();
  });

  it('rejects a connect budget larger than the whole call', () => {
    expect(() => timeoutRuleSchema.parse({ connectMs: 5_000, totalMs: 1_000, retries: 0 })).toThrow(
      /connectMs must not exceed totalMs/,
    );
  });

  it('rejects a first-token deadline beyond the total', () => {
    expect(() =>
      timeoutRuleSchema.parse({
        connectMs: 1_000,
        totalMs: 10_000,
        retries: 0,
        firstTokenMs: 20_000,
      }),
    ).toThrow(/firstTokenMs must not exceed totalMs/);
  });

  it('rejects a zero timeout', () => {
    expect(() => timeoutRuleSchema.parse({ connectMs: 0, totalMs: 1_000, retries: 0 })).toThrow();
  });

  it('rejects a negative retry count', () => {
    expect(() =>
      timeoutRuleSchema.parse({ connectMs: 100, totalMs: 1_000, retries: -1 }),
    ).toThrow();
  });

  it('rejects a policy with a port missing', () => {
    const { cache: _cache, ...incomplete } = DEFAULT_TIMEOUT_POLICY;
    expect(() => parseTimeoutPolicy(incomplete)).toThrow();
  });

  it('every rule keeps connect within total', () => {
    for (const rule of Object.values(DEFAULT_TIMEOUT_POLICY)) {
      expect(rule.connectMs).toBeLessThanOrEqual(rule.totalMs);
    }
  });
});

describe('the concurrency limits match §3.3', () => {
  it.each([
    ['llm', 20],
    ['embed', 10],
    ['mail', 5],
    ['payments', 5],
  ] as const)('%s is capped at %i in flight', (port, max) => {
    expect(DEFAULT_CONCURRENCY_LIMITS[port]).toBe(max);
  });

  it('caps every guarded port, including the two §3.3 does not name', () => {
    // A limit nobody reaches costs nothing. A port with NO limit is the one
    // that takes the process down.
    for (const max of Object.values(DEFAULT_CONCURRENCY_LIMITS)) {
      expect(max).toBeGreaterThan(0);
    }
  });

  it('rejects a zero limit', () => {
    expect(() => parseConcurrencyLimits({ ...DEFAULT_CONCURRENCY_LIMITS, llm: 0 })).toThrow();
  });
});

describe('the breaker policy matches §5', () => {
  it('opens at 5 failures in 30 seconds', () => {
    expect(DEFAULT_BREAKER_POLICY.failureThreshold).toBe(5);
    expect(DEFAULT_BREAKER_POLICY.failureWindowMs).toBe(30_000);
  });

  it('opens at a 50% failure rate over 20 calls', () => {
    expect(DEFAULT_BREAKER_POLICY.failureRateThreshold).toBe(0.5);
    expect(DEFAULT_BREAKER_POLICY.rollingWindowSize).toBe(20);
  });

  it('half-opens after 30 seconds with 3 trial calls', () => {
    expect(DEFAULT_BREAKER_POLICY.openMs).toBe(30_000);
    expect(DEFAULT_BREAKER_POLICY.halfOpenTrials).toBe(3);
  });

  it('caps the doubled wait at 5 minutes', () => {
    expect(DEFAULT_BREAKER_POLICY.maxOpenMs).toBe(300_000);
  });

  it('rejects an open interval beyond its own ceiling', () => {
    expect(() =>
      parseBreakerPolicy({ ...DEFAULT_BREAKER_POLICY, openMs: 600_000 }),
    ).toThrow(/openMs must not exceed maxOpenMs/);
  });

  it('rejects a failure rate outside 0..1', () => {
    expect(() =>
      parseBreakerPolicy({ ...DEFAULT_BREAKER_POLICY, failureRateThreshold: 1.5 }),
    ).toThrow();
  });
});
