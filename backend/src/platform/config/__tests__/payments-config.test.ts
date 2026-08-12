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

  /**
   * =========================================================================
   * D-253 — REFUSES AT BOOT, NAMING THE ENTRY. It used to drop and shrug.
   *
   * This case previously asserted `{ yearly: 'plan_DEF' }` from
   * `'monthly:,:plan_X,yearly:plan_DEF'` — two pairs silently discarded, a
   * successful parse, a healthy boot, and a checkout that fails for the first
   * customer who tries to pay. The old reasoning ("dropping it makes the
   * adapter refuse the checkout with a message that names the plan code") is
   * right about the message and wrong about the AUDIENCE: the person who reads
   * it is a paying customer, not an operator, and by then the deployment has
   * been reporting itself healthy for however long it has been up.
   *
   * `RAZORPAY_PLAN_IDS=monthly=plan_x` — an `=` where a `:` belongs — is one
   * keystroke and used to parse to `{}`.
   * =========================================================================
   */
  it.each([
    ['no `:` separator', 'monthly=plan_x', /no `:` separator/],
    ['an empty plan id', 'monthly:,yearly:plan_DEF', /empty plan id/],
    ['an empty plan code', ':plan_X,yearly:plan_DEF', /empty plan code/],
    ['a trailing comma', 'monthly:plan_ABC,', /stray or trailing comma/],
    ['a doubled comma', 'monthly:plan_ABC,,yearly:plan_DEF', /stray or trailing comma/],
    ['a set-but-empty value', '', /set but empty/],
    ['a second `:`', 'monthly:plan:ABC', /more than one `:` separator/],
  ])('REFUSES TO BOOT on %s', (_label, value, expected) => {
    expect(() => parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: value })).toThrow(expected);
  });

  it('names the offending entry, not just the variable', () => {
    // "RAZORPAY_PLAN_IDS is malformed" sends an operator to re-read a variable
    // they have already read twice. The entry is what they can act on.
    expect(() => parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: 'monthly=plan_x' })).toThrow(
      /"monthly=plan_x"/,
    );
  });

  it('REFUSES a duplicated plan code — the silent one', () => {
    // The old behaviour let the later pair win with no signal at all. Half the
    // variable was decoration and the value itself did not show which half, so
    // even reading it carefully told you nothing.
    expect(() =>
      parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: 'monthly:plan_A,monthly:plan_B' }),
    ).toThrow(/duplicate plan code "monthly"/);
  });

  it('surfaces the refusal in the SAME aggregated report as every other variable', () => {
    // Validated in the schema rather than only in `toConfig`, so an operator
    // fixing four variables is told about all four at once instead of finding
    // the fourth on the next restart.
    expect(() => parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: 'monthly=plan_x' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('still accepts an ABSENT variable — "no plan map" is a legitimate state', () => {
    // Every non-production environment. Refusing here would be a restart loop
    // on a variable that is allowed not to exist.
    const config = parseConfig(BASE);
    expect(config.payments.razorpayPlanIds).toEqual({});
  });

  it('is frozen, like every other configuration value', () => {
    const config = parseConfig({ ...BASE, RAZORPAY_PLAN_IDS: 'monthly:plan_ABC' });
    expect(Object.isFrozen(config.payments.razorpayPlanIds)).toBe(true);
  });
});
