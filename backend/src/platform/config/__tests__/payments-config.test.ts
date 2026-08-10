import { describe, expect, it } from 'vitest';
import { parseConfig } from '../load-config';

/**
 * The payment credentials in `platform/config`.
 *
 * They are OPTIONAL in the schema and REQUIRED in production by an explicit
 * boot check in the composition root — the same split `VOYAGE_API_KEY` uses,
 * and for a stronger reason: with no credentials and no boot check, production
 * would fall back to the deterministic payment fake, which happily "creates
 * subscriptions" and happily verifies webhooks signed with a secret we chose.
 * Entitlements would be granted against payments that never happened.
 */

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5432/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'https://app.foxxy.test',
  API_URL: 'https://api.foxxy.test',
} as const;

describe('the payment credentials are absent-by-default and typed as null', () => {
  it('parses with none of them set', () => {
    const config = parseConfig({ ...BASE });
    // `null`, not `undefined`: "this deployment has no key" is a fact, and a
    // fact is what the boot check reads.
    expect(config.payments.razorpayKeyId).toBeNull();
    expect(config.payments.razorpayKeySecret).toBeNull();
    expect(config.payments.razorpayWebhookSecret).toBeNull();
    expect(config.payments.razorpayPlanIds).toEqual({});
  });

  it('carries all three secrets through when they are set', () => {
    const config = parseConfig({
      ...BASE,
      RAZORPAY_KEY_ID: 'rzp_live_x',
      RAZORPAY_KEY_SECRET: 'secret_x',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_x',
    });
    expect(config.payments.razorpayKeyId).toBe('rzp_live_x');
    // The webhook secret is a DIFFERENT secret from the API secret. Reading one
    // where the other belongs makes every genuine webhook fail its signature
    // check while everything else about the integration works.
    expect(config.payments.razorpayWebhookSecret).toBe('whsec_x');
    expect(config.payments.razorpayWebhookSecret).not.toBe(config.payments.razorpayKeySecret);
  });
});

describe('RAZORPAY_PLAN_IDS', () => {
  it('parses comma-separated code:plan_id pairs', () => {
    const config = parseConfig({
      ...BASE,
      RAZORPAY_PLAN_IDS: 'monthly:plan_ABC, yearly:plan_DEF',
    });
    expect(config.payments.razorpayPlanIds).toEqual({
      monthly: 'plan_ABC',
      yearly: 'plan_DEF',
    });
  });

  it('drops a malformed pair rather than inventing a plan id', () => {
    // A half-parsed pair would map a plan code to an empty string, and an empty
    // Razorpay plan id is a create that fails at the vendor with a message
    // nobody connects back to this variable. Dropping it makes the adapter
    // refuse the checkout with a message that names the plan code.
    const config = parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: 'monthly:,:plan_X,yearly:plan_DEF' });
    expect(config.payments.razorpayPlanIds).toEqual({ yearly: 'plan_DEF' });
  });

  it('is frozen, like every other configuration value', () => {
    const config = parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: 'monthly:plan_ABC' });
    expect(Object.isFrozen(config.payments.razorpayPlanIds)).toBe(true);
  });
});
