import { describe, expect, it } from 'vitest';
import { FOXY_DAILY_MESSAGE_LIMIT, FOXY_PLANS, type FoxyPlan } from '@/shared/constants/foxy';
import { decideUsage } from '../domain/usage';

/**
 * =============================================================================
 * THE DAILY ALLOWANCE, PINNED TO LITERALS — D-321.
 *
 * WHY THIS FILE EXISTS. An audit changed `free: 20 -> 5000` and
 * `plus: 200 -> 9000` and every one of the 2,500-odd tests in this repository
 * stayed green. Not because the limit is untested — it is tested in several
 * places — but because every one of those places referenced
 * `FOXY_DAILY_MESSAGE_LIMIT.free` rather than a number. A symbol-relative
 * assertion moves with the symbol, so a suite made entirely of them can pin the
 * PLUMBING perfectly while saying nothing whatsoever about the VALUE.
 *
 * The single absolute claim that did exist anywhere was `plus > free`
 * (`app/__tests__/foxy-plan-reader.test.ts`), and it is satisfied by any
 * ordered pair — 5000/9000 included. A free tier of five thousand messages a
 * day is not a cap. It is an unmetered model budget with a comment on it, and
 * the comment said 20.
 *
 * -----------------------------------------------------------------------------
 * THIS FILE IS ALLOWED TO BE ANNOYING. THAT IS THE FEATURE.
 *
 * Changing either number is a COMMERCIAL decision — it changes what a paying
 * customer receives and what the free tier costs to serve — so it must fail a
 * test that names itself, not slide through as a constant edit. If you are here
 * because you changed the numbers deliberately, change them here too and record
 * why in the decision log.
 * =============================================================================
 */

describe('the Foxy daily message allowance', () => {
  it('is 20 a day on free and 200 a day on plus — LITERALS, not references', () => {
    // Deliberately not `FOXY_DAILY_MESSAGE_LIMIT.free` on both sides. The whole
    // defect was a suite that compared the constant to itself.
    expect(FOXY_DAILY_MESSAGE_LIMIT.free).toBe(20);
    expect(FOXY_DAILY_MESSAGE_LIMIT.plus).toBe(200);
  });

  it('keeps the free cap SMALL ENOUGH TO BIND — a cap nobody reaches is not a cap', () => {
    /**
     * The property `plus > free` cannot express. The free tier's purpose is to
     * bound what an unpaid account can spend on a model; a ceiling above what a
     * determined student could reach in a sitting bounds nothing, and its
     * failure mode is a bill rather than a broken test.
     *
     * 60 is the ceiling on the ceiling, not a target: a student sending one
     * message a minute for an hour straight is already an implausible session,
     * so anything above that is decorative. The shipped 20 sits comfortably
     * inside it.
     */
    expect(FOXY_DAILY_MESSAGE_LIMIT.free).toBeLessThanOrEqual(60);
    // And it has to be usable — a cap of 1 is a different defect with the same
    // shape, and would make the free tier a demo rather than a product.
    expect(FOXY_DAILY_MESSAGE_LIMIT.free).toBeGreaterThanOrEqual(10);
  });

  it('makes plus a MEANINGFUL multiple of free, not a rounding difference', () => {
    // 5000 vs 9000 is 1.8x. Structurally a paid tier; commercially nothing.
    // D-257 closed "every paying customer silently received the free tier"; if
    // the paid tier is not worth buying, that fix bought nothing either.
    expect(FOXY_DAILY_MESSAGE_LIMIT.plus / FOXY_DAILY_MESSAGE_LIMIT.free).toBeGreaterThanOrEqual(5);
  });

  it('is TOTAL over the plan vocabulary, so a new plan cannot arrive capless', () => {
    // `Record<FoxyPlan, number>` makes this a compile error rather than a
    // runtime one; asserted anyway because `FOXY_PLANS` and `FoxyPlan` are two
    // declarations of one closed set and this is where they are compared.
    for (const plan of FOXY_PLANS) {
      const limit: number = FOXY_DAILY_MESSAGE_LIMIT[plan satisfies FoxyPlan];
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
    expect(Object.keys(FOXY_DAILY_MESSAGE_LIMIT).sort()).toEqual([...FOXY_PLANS].sort());
  });

  it('is the number the usage rule actually enforces, at the boundary', () => {
    /**
     * The literals above pin the TABLE. This pins that the table is what
     * decides, at the one message that matters: the 20th is allowed and the
     * 21st is not.
     *
     * Without this, a correct table and a service that read a different number
     * would both be green.
     */
    const free = FOXY_DAILY_MESSAGE_LIMIT.free;

    expect(decideUsage(free - 1, 'free').allowed).toBe(true);
    expect(decideUsage(free - 1, 'free').limit).toBe(20);
    expect(decideUsage(free, 'free').allowed).toBe(false);
    expect(decideUsage(free, 'free').remaining).toBe(0);

    expect(decideUsage(free, 'plus').allowed).toBe(true);
    expect(decideUsage(FOXY_DAILY_MESSAGE_LIMIT.plus, 'plus').allowed).toBe(false);
    expect(decideUsage(0, 'plus').limit).toBe(200);
  });
});
