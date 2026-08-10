import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors/index';
import { createFakePayments, FAKE_PROVIDER } from '../fake-payments';
import { computeSignature } from '../signature';

/**
 * THE FAKE IS THE THING MOST OF THE BILLING SUITE RUNS AGAINST, so its own
 * fidelity is load-bearing.
 *
 * The property under test here is NOT "it returns canned values". It is that
 * the fake CANNOT BE TALKED INTO ACCEPTING AN UNSIGNED WEBHOOK — because if it
 * could, every "a forged signature is rejected" test elsewhere would pass
 * against a service with the check deleted.
 */

const SECRET = 'fake-secret';

function build(): ReturnType<typeof createFakePayments> {
  return createFakePayments({ secret: SECRET, planCodes: ['monthly', 'yearly'] });
}

describe('createSubscription', () => {
  it('issues deterministic ids in creation order', async () => {
    const payments = build();
    const req = {
      planCode: 'monthly',
      payer: { kind: 'user', id: 'u1' },
      subjectUserId: 'u1',
      amountMinorUnits: 29_900,
      currency: 'INR',
      idempotencyKey: 'k1',
    } as const;

    await expect(payments.createSubscription(req)).resolves.toEqual({
      providerSubscriptionId: 'sub_fake_1',
      checkoutUrl: 'https://pay.fake.test/sub_fake_1',
      provider: FAKE_PROVIDER,
    });
    await expect(
      payments.createSubscription({ ...req, idempotencyKey: 'k2' }),
    ).resolves.toMatchObject({ providerSubscriptionId: 'sub_fake_2' });
    expect(payments.created).toHaveLength(2);
  });

  it('refuses an unknown plan, as the real adapter does', async () => {
    const payments = build();
    await expect(
      payments.createSubscription({
        planCode: 'enterprise',
        payer: { kind: 'school', id: 'school-1' },
        subjectUserId: 'u1',
        amountMinorUnits: 1,
        currency: 'INR',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('carries a SCHOOL payer with a different subject — the B2B shape', async () => {
    const payments = build();
    await payments.createSubscription({
      planCode: 'yearly',
      payer: { kind: 'school', id: 'school-1' },
      subjectUserId: 'student-9',
      amountMinorUnits: 299_000,
      currency: 'INR',
      idempotencyKey: 'k',
    });
    expect(payments.created[0]?.payer).toEqual({ kind: 'school', id: 'school-1' });
    expect(payments.created[0]?.subjectUserId).toBe('student-9');
  });
});

describe('cancelSubscription is idempotent', () => {
  it('records repeats and never throws', async () => {
    const payments = build();
    await payments.cancelSubscription('sub_fake_1');
    await payments.cancelSubscription('sub_fake_1');
    expect(payments.cancelled).toEqual(['sub_fake_1', 'sub_fake_1']);
  });
});

describe('verifyWebhook uses the real HMAC', () => {
  it('accepts a delivery it signed itself', () => {
    const payments = build();
    const delivery = payments.delivery({
      id: 'evt_1',
      event: 'subscription.activated',
      subscriptionId: 'sub_fake_1',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    });

    expect(payments.verifyWebhook(delivery)).toMatchObject({
      providerEventId: 'evt_1',
      kind: 'subscription.activated',
      providerSubscriptionId: 'sub_fake_1',
    });
    expect(payments.verifyWebhook(delivery)?.currentPeriodEnd?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('rejects a hand-written signature', () => {
    const payments = build();
    const { rawBody } = payments.delivery({ id: 'evt_1', event: 'subscription.charged' });
    expect(payments.verifyWebhook({ rawBody, signature: 'x'.repeat(64) })).toBeNull();
  });

  it('rejects a body edited after signing — the replay-onto-new-bytes attack', () => {
    const payments = build();
    const delivery = payments.delivery({ id: 'evt_1', event: 'subscription.charged' });
    const tampered = delivery.rawBody.replace('charged', 'activated');
    expect(
      payments.verifyWebhook({ rawBody: tampered, signature: delivery.signature }),
    ).toBeNull();
  });

  it('rejects a signature made with another secret', () => {
    const payments = build();
    const rawBody = JSON.stringify({ id: 'e', event: 'subscription.charged' });
    expect(
      payments.verifyWebhook({ rawBody, signature: computeSignature(rawBody, 'other') }),
    ).toBeNull();
  });

  it('maps an event name it does not know to `unknown`', () => {
    const payments = build();
    expect(payments.verifyWebhook(payments.delivery({ id: 'e', event: 'invoice.weird' }))).
      toMatchObject({ kind: 'unknown', providerEventName: 'invoice.weird' });
  });

  it('a signature-valid non-JSON body throws rather than verifying', () => {
    const payments = build();
    const rawBody = 'nope';
    expect(() =>
      payments.verifyWebhook({ rawBody, signature: payments.sign(rawBody) }),
    ).toThrow(ValidationError);
  });

  it('ignores an unparseable currentPeriodEnd rather than emitting an Invalid Date', () => {
    const payments = build();
    const verified = payments.verifyWebhook(
      payments.delivery({ id: 'e', event: 'subscription.charged', currentPeriodEnd: 'tomorrow' }),
    );
    expect(verified?.currentPeriodEnd).toBeNull();
  });
});

describe('failNextCreate', () => {
  it('injects one failure and then recovers', async () => {
    const payments = build();
    payments.failNextCreate(new Error('gateway down'));
    const req = {
      planCode: 'monthly',
      payer: { kind: 'user', id: 'u1' },
      subjectUserId: 'u1',
      amountMinorUnits: 1,
      currency: 'INR',
      idempotencyKey: 'k',
    } as const;
    await expect(payments.createSubscription(req)).rejects.toThrow('gateway down');
    await expect(payments.createSubscription(req)).resolves.toMatchObject({
      providerSubscriptionId: 'sub_fake_1',
    });
  });

  it('reset clears the recordings', async () => {
    const payments = build();
    await payments.cancelSubscription('s');
    payments.reset();
    expect(payments.cancelled).toHaveLength(0);
  });
});
