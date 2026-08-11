import { describe, expect, it } from 'vitest';
import {
  FORGOT_PASSWORD_RATE_LIMIT,
  LINK_CODE_RATE_LIMIT,
  LINK_SUBMIT_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  LOGOUT_RATE_LIMIT,
  SIGNUP_RATE_LIMIT,
  TOKEN_ENDPOINT_RATE_LIMIT,
  type RateLimitRule,
} from '@/shared/constants/rate-limits';

/**
 * =============================================================================
 * THE RATE-LIMIT NUMBERS THEMSELVES — D-292.
 *
 * An auditor multiplied three limits by a hundred — `SIGNUP` 3 → 300, `LOGOUT`
 * 30 → 3000, `TOKEN_ENDPOINT` 10 → 1000 — and ALL 2,530 TESTS PASSED.
 *
 * The reason is a shape, not an omission, and it is worth stating precisely
 * because it looks like thorough testing right up until you mutate something:
 *
 *     for (let attempt = 0; attempt < SIGNUP_RATE_LIMIT.limit; attempt += 1) {
 *       await service.signup(...);
 *     }
 *     await expect(service.signup(...)).rejects.toMatchObject({ code: RATE_LIMIT });
 *
 * That loop asserts the limiter is INTERNALLY CONSISTENT — that whatever number
 * the constant holds, the next request past it is refused. It cannot observe the
 * number. Raise the constant to 300 and the loop obligingly runs 300 times and
 * still watches the 301st get refused. Every such test stays green while signup
 * becomes account farming at 300 accounts per hour per IP, plus a mail bomb,
 * since every signup sends a verification email.
 *
 * `TOKEN_ENDPOINT_RATE_LIMIT` had no test at ALL — it guards `verify`,
 * `reset-password` and now `resend-verification`, which is to say every endpoint
 * that redeems or re-mails a credential.
 *
 * The contrast the audit drew is the fix. `LOGIN`, `LINK_CODE`, `LINK_SUBMIT`,
 * `FORGOT_PASSWORD` and `AUTHENTICATED` all went RED under the same mutation,
 * because somewhere a test NAMES THE LITERAL — "allows five in an hour and
 * REJECTS the sixth". This file extends that to the whole table, in the one
 * place where the numbers can be read side by side.
 *
 * WHY A TABLE HERE AND BEHAVIOUR ELSEWHERE. These assertions pin the POLICY —
 * what the numbers are. They deliberately do not exercise the limiter, because a
 * test that did both would be a test you could satisfy by changing either. The
 * behavioural half — "three signups an hour, the fourth is refused", driven by
 * hardcoded counts rather than by the constant — lives in
 * `identity.service.test.ts` under the same decision, so an inflation has to get
 * past two independent kinds of test rather than one.
 *
 * A DELIBERATE change to any number below changes this file in the same commit,
 * and that is the point: the diff then says "the policy changed" out loud
 * instead of saying "a constant moved" quietly.
 * =============================================================================
 */

const HOUR = 3600;
const FIFTEEN_MINUTES = 900;

/** The §6.9 table, transcribed. Named values, never `RULE.limit`. */
const POLICY: readonly { name: string; rule: RateLimitRule; limit: number; window: number }[] = [
  // --- The three that were unpinned. --------------------------------------
  { name: 'SIGNUP — 3 per hour per IP', rule: SIGNUP_RATE_LIMIT, limit: 3, window: HOUR },
  { name: 'LOGOUT — 30 per hour per IP', rule: LOGOUT_RATE_LIMIT, limit: 30, window: HOUR },
  {
    name: 'TOKEN_ENDPOINT — 10 per hour per IP',
    rule: TOKEN_ENDPOINT_RATE_LIMIT,
    limit: 10,
    window: HOUR,
  },
  // --- The five that were already load-bearing, kept here so the table is
  //     the whole table rather than the half that once went wrong. ---------
  { name: 'LOGIN — 5 per 15 minutes', rule: LOGIN_RATE_LIMIT, limit: 5, window: FIFTEEN_MINUTES },
  {
    name: 'FORGOT_PASSWORD — 3 per hour',
    rule: FORGOT_PASSWORD_RATE_LIMIT,
    limit: 3,
    window: HOUR,
  },
  { name: 'LINK_CODE — 5 per hour per student', rule: LINK_CODE_RATE_LIMIT, limit: 5, window: HOUR },
  {
    name: 'LINK_SUBMIT — 5 per hour per parent',
    rule: LINK_SUBMIT_RATE_LIMIT,
    limit: 5,
    window: HOUR,
  },
];

describe('the rate-limit policy table — D-292', () => {
  for (const entry of POLICY) {
    it(`${entry.name} — the literal, not the constant`, () => {
      expect(entry.rule.limit).toBe(entry.limit);
      expect(entry.rule.windowSeconds).toBe(entry.window);
    });
  }

  /**
   * The three inflations the audit actually performed, spelled out as the
   * outcomes rather than as numbers, because the numbers are what moved.
   */
  it('SIGNUP is not account farming: 3 an hour per IP, not 300', () => {
    expect(SIGNUP_RATE_LIMIT.limit).toBe(3);
    // Every signup sends a verification email, so this limit is a mail-bomb
    // bound as well as an account-creation bound. Both break at the same value.
    expect(SIGNUP_RATE_LIMIT.limit).toBeLessThan(10);
  });

  it('LOGOUT stays a flood bound on the `auth` pool: 30 an hour, not 3000', () => {
    // D-220: logout is unauthenticated by design and reaches the `auth` pool —
    // the one §3.1's bulkhead keeps free so login always has a connection.
    expect(LOGOUT_RATE_LIMIT.limit).toBe(30);
    expect(LOGOUT_RATE_LIMIT.limit).toBeLessThan(100);
  });

  it('TOKEN_ENDPOINT stays a credential-redemption bound: 10 an hour, not 1000', () => {
    // Guards `verify`, `reset-password` and `resend-verification` (D-291). At
    // 1000/hour the last of those is an unmetered mailer.
    expect(TOKEN_ENDPOINT_RATE_LIMIT.limit).toBe(10);
    expect(TOKEN_ENDPOINT_RATE_LIMIT.limit).toBeLessThan(30);
  });

  /**
   * The ORDERING is a policy statement too, and a cheap one to keep honest:
   * the endpoints that create accounts or spend credentials must never be more
   * permissive than the one that merely ends a session.
   */
  it('keeps the credential endpoints stricter than the session one', () => {
    expect(SIGNUP_RATE_LIMIT.limit).toBeLessThan(LOGOUT_RATE_LIMIT.limit);
    expect(TOKEN_ENDPOINT_RATE_LIMIT.limit).toBeLessThan(LOGOUT_RATE_LIMIT.limit);
    expect(FORGOT_PASSWORD_RATE_LIMIT.limit).toBeLessThanOrEqual(SIGNUP_RATE_LIMIT.limit);
  });
});
