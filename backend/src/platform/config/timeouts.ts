import { z } from 'zod';

/**
 * THE TIMEOUT POLICY — 04-RESILIENCE-PLAN.md §4.
 *
 * "Every outbound call has a timeout. A call without one is a defect."
 *
 * Every timeout in the system is declared here and nowhere else. The plan is
 * explicit that timeouts are *configuration*, not constants scattered through
 * the code — a number written at a call site is a number nobody can find
 * during an incident, and it is how two callers of the same dependency end up
 * with different patience.
 *
 * This file is data plus a schema. It contains no behaviour, which is why it
 * is allowed to sit in `platform/`.
 *
 * The concurrency limits (§3.3) and the circuit-breaker thresholds (§5) live
 * here for the same reason: they are operational policy, they are validated at
 * boot, and an incident should never involve grepping for them.
 */

/** One dependency's patience. */
export const timeoutRuleSchema = z
  .object({
    /** How long to wait for a connection to be established. */
    connectMs: z.number().int().min(1),
    /** How long the whole call may take, connection included. */
    totalMs: z.number().int().min(1),
    /**
     * Attempts AFTER the first. `0` means "never retry".
     *
     * A non-zero value here is a statement that the call is idempotent.
     * Retrying a non-idempotent write is forbidden by §4 and is enforced by
     * `platform/retry`, which refuses a retry budget on a non-idempotent call.
     */
    retries: z.number().int().min(0).max(5),
    /**
     * Streaming only: the deadline for the FIRST token. A stream that has
     * begun is not allowed to be killed by `totalMs` mid-sentence, so the two
     * deadlines are separate.
     */
    firstTokenMs: z.number().int().min(1).optional(),
  })
  .refine((rule) => rule.connectMs <= rule.totalMs, {
    message: 'connectMs must not exceed totalMs — a connect budget larger than the whole call',
  })
  .refine((rule) => rule.firstTokenMs === undefined || rule.firstTokenMs <= rule.totalMs, {
    message: 'firstTokenMs must not exceed totalMs',
  });

export type TimeoutRule = z.infer<typeof timeoutRuleSchema>;

export const timeoutPolicySchema = z.object({
  /** Ordinary queries. `totalMs` is applied as the Postgres statement timeout. */
  postgres: timeoutRuleSchema,
  /**
   * Vector search gets a SHORTER statement timeout than everything else.
   *
   * §3.1: a slow HNSW query under load is the single most likely way to
   * consume a pool. Capping the `ai` pool bounds how many it can hold; this
   * bounds how long it can hold one.
   */
  postgresVector: timeoutRuleSchema,
  cache: timeoutRuleSchema,
  llm: timeoutRuleSchema,
  llmStreaming: timeoutRuleSchema,
  embed: timeoutRuleSchema,
  mail: timeoutRuleSchema,
  payments: timeoutRuleSchema,
  /** The default for `platform/http` when a caller names no dependency. */
  http: timeoutRuleSchema,
});

export type TimeoutPolicy = z.infer<typeof timeoutPolicySchema>;

/** The table in §4, transcribed. Row for row. */
export const DEFAULT_TIMEOUT_POLICY: TimeoutPolicy = {
  postgres: { connectMs: 2_000, totalMs: 10_000, retries: 0 },
  postgresVector: { connectMs: 2_000, totalMs: 5_000, retries: 0 },
  cache: { connectMs: 500, totalMs: 1_000, retries: 1 },
  llm: { connectMs: 3_000, totalMs: 30_000, retries: 1 },
  llmStreaming: { connectMs: 3_000, totalMs: 60_000, retries: 0, firstTokenMs: 8_000 },
  embed: { connectMs: 2_000, totalMs: 5_000, retries: 2 },
  mail: { connectMs: 3_000, totalMs: 10_000, retries: 3 },
  // "none on writes — retrying a payment is worse than failing it."
  payments: { connectMs: 3_000, totalMs: 15_000, retries: 0 },
  http: { connectMs: 2_000, totalMs: 10_000, retries: 2 },
};

/**
 * Max in-flight calls per port — §3.3.
 *
 * On overflow the call is rejected immediately with `DependencyError`. It is
 * never queued: unbounded queueing is what converts a slow dependency into a
 * dead process, because every queued caller is also holding a request, a
 * socket and a stack.
 */
export const concurrencyLimitsSchema = z.object({
  llm: z.number().int().min(1),
  embed: z.number().int().min(1),
  mail: z.number().int().min(1),
  payments: z.number().int().min(1),
  /**
   * §3.3 names four ports. `cache` and `http` are capped here too, generously,
   * so that every guarded port has the same shape and no port can be wired up
   * with a bulkhead missing. A limit nobody reaches costs nothing; a port
   * with no limit at all is the one that takes the process down.
   */
  cache: z.number().int().min(1),
  http: z.number().int().min(1),
});

export type ConcurrencyLimits = z.infer<typeof concurrencyLimitsSchema>;

export const DEFAULT_CONCURRENCY_LIMITS: ConcurrencyLimits = {
  llm: 20,
  embed: 10,
  mail: 5,
  payments: 5,
  cache: 100,
  http: 50,
};

/** Circuit-breaker thresholds — §5. One set, applied to every port. */
export const breakerPolicySchema = z
  .object({
    /** Consecutive-window failures that trip the breaker. */
    failureThreshold: z.number().int().min(1),
    /** The window those failures must fall inside. */
    failureWindowMs: z.number().int().min(1),
    /** How many recent calls the failure-RATE rule looks at. */
    rollingWindowSize: z.number().int().min(1),
    /** The rate, over a full rolling window, that trips the breaker. */
    failureRateThreshold: z.number().min(0).max(1),
    /** How long the breaker stays open before the first trial call. */
    openMs: z.number().int().min(1),
    /** Trial calls allowed in half-open. All must succeed to close. */
    halfOpenTrials: z.number().int().min(1),
    /** Ceiling on the doubled open interval. */
    maxOpenMs: z.number().int().min(1),
  })
  .refine((policy) => policy.openMs <= policy.maxOpenMs, {
    message: 'openMs must not exceed maxOpenMs',
  });

export type BreakerPolicy = z.infer<typeof breakerPolicySchema>;

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  failureWindowMs: 30_000,
  rollingWindowSize: 20,
  failureRateThreshold: 0.5,
  openMs: 30_000,
  halfOpenTrials: 3,
  maxOpenMs: 300_000,
};

/**
 * Validates the whole policy at boot.
 *
 * The policy is a constant, so this can only fail when somebody edits the
 * table above — which is exactly when it should fail, loudly, rather than at
 * 2am on the one path that reads the value.
 */
export function parseTimeoutPolicy(input: unknown): TimeoutPolicy {
  return timeoutPolicySchema.parse(input);
}

export function parseConcurrencyLimits(input: unknown): ConcurrencyLimits {
  return concurrencyLimitsSchema.parse(input);
}

export function parseBreakerPolicy(input: unknown): BreakerPolicy {
  return breakerPolicySchema.parse(input);
}
