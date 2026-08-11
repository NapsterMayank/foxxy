import { beforeEach, describe, expect, it } from 'vitest';
import { RecordingAudit } from '@/platform/audit/index';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { FakeLogger } from '@/platform/logger/index';
import { createFakePayments, type FakePayments } from '@/platform/payments/index';
import { createRateLimiter, type RateLimiter } from '@/platform/rate-limit/index';
import type { BillingRepository } from '../billing.repository';
import {
  BILLING_AUDIT_ACTIONS,
  WEBHOOK_REJECTION_RATE_LIMIT,
  WEBHOOK_REJECTION_RATE_LIMIT_KEY,
  createBillingService,
  type BillingService,
} from '../billing.service';

/**
 * =============================================================================
 * D-258 — THE PUBLIC WEBHOOK'S REJECTION BUDGET.
 *
 * `POST /api/v1/webhooks/billing` is the only endpoint in the product that is
 * unauthenticated by design, exempt from the CSRF origin check, and reachable by
 * anyone on the internet. It had no rate limit of ANY kind, and every delivery
 * whose signature failed wrote a durable `audit_log` row — so an anonymous
 * caller chose the growth rate of an append-only table. The global authenticated
 * throttle in `app/server.ts` cannot cover it: that hook returns immediately for
 * a request carrying no actor, and a webhook carries none by definition.
 *
 * -----------------------------------------------------------------------------
 * NO DATABASE, DELIBERATELY, AND THE REPOSITORY IS A LANDMINE.
 *
 * A rejected webhook must never reach storage — the signature fails before any
 * lookup — so every method of the repository below THROWS. That turns "the
 * rejection path does no database work" from a claim in a comment into a
 * property this file would fail on. It also means these assertions run in
 * milliseconds and cannot be taken out by an unrelated container problem.
 *
 * THE SIGNATURES ARE REAL. `createFakePayments` shares
 * `platform/payments/signature.ts` with the Razorpay adapter — same HMAC, same
 * timing-safe comparison — so "forged" here means genuinely forged rather than
 * "a stub that was told to say no".
 *
 * THE CLOCK IS INJECTED AND THERE IS NO `sleep`. A window is crossed by
 * advancing `FixedClock`, which is exact where a sleep is merely probable.
 * =============================================================================
 */

const NOW = new Date('2026-08-11T09:00:00.000Z');
const WEBHOOK_SECRET = 'whsec_test_d258';

/** Every method throws. Reaching storage on a rejection is the defect. */
function landmineRepository(): BillingRepository {
  const refuse = (name: string): never => {
    throw new Error(`billing repository was reached on a rejected webhook: ${name}`);
  };
  return {
    withTransaction: () => refuse('withTransaction'),
    createSubscription: () => refuse('createSubscription'),
    attachProviderId: () => refuse('attachProviderId'),
    findLiveForSubject: () => refuse('findLiveForSubject'),
    findLatestForSubject: () => refuse('findLatestForSubject'),
    findById: () => refuse('findById'),
    lockByProviderId: () => refuse('lockByProviderId'),
    insertPaymentEvent: () => refuse('insertPaymentEvent'),
    updateSubscriptionState: () => refuse('updateSubscriptionState'),
    countEventsFor: () => refuse('countEventsFor'),
  };
}

interface Fixture {
  readonly service: BillingService;
  readonly audit: RecordingAudit;
  readonly clock: FixedClock;
  readonly payments: FakePayments;
  readonly limiter: RateLimiter;
  readonly logger: FakeLogger;
}

function fixture(): Fixture {
  const clock = new FixedClock(NOW);
  const cache = new MemoryCache(clock);
  const logger = new FakeLogger();
  const audit = new RecordingAudit();
  const payments = createFakePayments({ secret: WEBHOOK_SECRET, planCodes: ['monthly'] });

  const limiter = createRateLimiter({
    cache,
    clock,
    logger,
    fallbackMetric: 'billing.webhook_rate_limit.in_process_fallback',
  });

  const service = createBillingService({
    repository: landmineRepository(),
    payments,
    clock,
    logger,
    readTenantOfUser: () => Promise.resolve(null),
    resolvePayer: () => Promise.resolve(null),
    audit,
    rateLimiter: limiter,
  });

  return { service, audit, clock, payments, limiter, logger };
}

/** A delivery whose signature is not the one the secret would produce. */
function forged(index: number): { rawBody: string; signature: string; eventId: string } {
  return {
    rawBody: JSON.stringify({ event: 'subscription.activated', id: `evt_forged_${String(index)}` }),
    signature: 'deadbeef'.repeat(8),
    eventId: `evt_forged_${String(index)}`,
  };
}

function rejectionRows(audit: RecordingAudit): number {
  return audit.find(BILLING_AUDIT_ACTIONS.WEBHOOK_REJECTED).length;
}

describe('the webhook rejection budget bounds the audit table (D-258)', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  it('audits the FIRST forged delivery, so a single probe is never invisible', async () => {
    const outcome = await f.service.handleWebhook(forged(1));

    expect(outcome.result).toBe('rejected');
    expect(rejectionRows(f.audit)).toBe(1);
  });

  it('STOPS WRITING AUDIT ROWS once the budget is spent, however long the flood runs', async () => {
    // THE DEFECT, EXACTLY: without the limiter this loop writes 200 durable
    // rows, and a real attacker's loop does not stop at 200.
    const attempts = WEBHOOK_REJECTION_RATE_LIMIT.limit + 170;
    for (let i = 0; i < attempts; i += 1) {
      await f.service.handleWebhook(forged(i));
    }

    expect(rejectionRows(f.audit)).toBe(WEBHOOK_REJECTION_RATE_LIMIT.limit);
    // The table stopped growing; the endpoint did not stop answering.
    expect(rejectionRows(f.audit)).toBeLessThan(attempts);
  });

  it('answers a throttled forgery IDENTICALLY to an audited one', async () => {
    // If the response changed under load, an attacker could find the threshold
    // by watching for it — and the provider would be told something untrue.
    const first = await f.service.handleWebhook(forged(0));

    for (let i = 1; i <= WEBHOOK_REJECTION_RATE_LIMIT.limit + 5; i += 1) {
      await f.service.handleWebhook(forged(i));
    }
    const throttled = await f.service.handleWebhook(forged(999));

    expect(throttled).toStrictEqual(first);
    expect(throttled.result).toBe('rejected');
  });

  it('keeps LOGGING every rejection even when the durable write is suppressed', async () => {
    // Suppressing the row must not suppress the signal. A log line is bounded by
    // the log pipeline; an append-only table is not.
    const attempts = WEBHOOK_REJECTION_RATE_LIMIT.limit + 20;
    for (let i = 0; i < attempts; i += 1) {
      await f.service.handleWebhook(forged(i));
    }

    const warned = f.logger.lines.filter(
      (line) => line.obj.event === 'billing.webhook_rejected',
    );
    expect(warned).toHaveLength(attempts);
    expect(rejectionRows(f.audit)).toBe(WEBHOOK_REJECTION_RATE_LIMIT.limit);
  });

  it('REFILLS on the next window, so a rotated secret is still investigable', async () => {
    for (let i = 0; i < WEBHOOK_REJECTION_RATE_LIMIT.limit + 5; i += 1) {
      await f.service.handleWebhook(forged(i));
    }
    expect(rejectionRows(f.audit)).toBe(WEBHOOK_REJECTION_RATE_LIMIT.limit);

    // No sleep: the window is crossed by moving the injected clock.
    f.clock.setTo(
      new Date(NOW.getTime() + (WEBHOOK_REJECTION_RATE_LIMIT.windowSeconds + 1) * 1000),
    );
    await f.service.handleWebhook(forged(1000));

    expect(rejectionRows(f.audit)).toBe(WEBHOOK_REJECTION_RATE_LIMIT.limit + 1);
  });

  it('spends the budget on a CONSTANT key, not one the caller controls', async () => {
    /**
     * The property that makes the limit a limit. Every forged delivery below
     * carries a DIFFERENT `eventId` and a different body — the two things an
     * attacker can vary freely. If the key were derived from either of them,
     * each request would open a fresh budget and the audit table would grow
     * exactly as it did before the fix.
     */
    for (let i = 0; i < WEBHOOK_REJECTION_RATE_LIMIT.limit + 40; i += 1) {
      await f.service.handleWebhook({
        rawBody: JSON.stringify({ nonce: i, event: 'subscription.activated' }),
        signature: `forged${String(i)}`.padEnd(64, '0'),
        eventId: `evt_unique_${String(i)}`,
      });
    }

    expect(rejectionRows(f.audit)).toBe(WEBHOOK_REJECTION_RATE_LIMIT.limit);
    // Named explicitly, so a rename that reintroduced a caller-controlled key
    // has to change this line too.
    expect(WEBHOOK_REJECTION_RATE_LIMIT_KEY).toBe('billing:webhook:rejected');
  });

  it('NEVER charges a genuine delivery, so a flood cannot starve the provider', async () => {
    // Exhaust the budget with forgeries first.
    for (let i = 0; i < WEBHOOK_REJECTION_RATE_LIMIT.limit + 10; i += 1) {
      await f.service.handleWebhook(forged(i));
    }

    // A genuinely signed delivery now arrives. It must not be throttled — the
    // budget is spent AFTER the signature check and only on the failing branch.
    // It reaches the repository, which is a landmine, and that is the proof it
    // got past the limiter rather than being turned away by it.
    const genuine = f.payments.delivery({
      id: 'evt_real_1',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-11T09:00:00.000Z',
    });

    await expect(f.service.handleWebhook(genuine)).rejects.toThrow(
      /billing repository was reached/u,
    );
  });
});
