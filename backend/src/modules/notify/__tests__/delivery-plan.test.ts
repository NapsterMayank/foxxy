import { describe, expect, it } from 'vitest';
import { planDelivery } from '../domain/delivery-plan';
import { KIND_POLICY } from '../domain/kinds';
import { DEFAULT_PREFERENCES } from '../domain/preferences';

/**
 * The delivery plan — the one function that decides which remote channels a
 * notification uses and when.
 *
 * Pure, so every case below names an exact instant. IST is UTC+5:30:
 *   18:00 UTC = 23:30 IST  → inside the default 21:00-07:00 window
 *   06:30 UTC = 12:00 IST  → outside it
 */

const NIGHT = new Date('2026-06-01T18:00:00.000Z');
const NOON = new Date('2026-06-01T06:30:00.000Z');

describe('channel selection comes from the table', () => {
  it('uses the row for the kind', () => {
    const plan = planDelivery({ kind: 'digest_ready', preferences: DEFAULT_PREFERENCES, at: NOON });
    expect(plan.channels).toEqual(KIND_POLICY.digest_ready.channels);
  });

  it('returns no channels for an in-app-only kind', () => {
    // `streak_reminder`. An empty plan means "enqueue no delivery job", not
    // "this person was told nothing" — the in-app row was already written.
    const plan = planDelivery({
      kind: 'streak_reminder',
      preferences: DEFAULT_PREFERENCES,
      at: NOON,
    });
    expect(plan.channels).toEqual([]);
    expect(plan.deferred).toBe(false);
  });

  it('honours an opt-out', () => {
    const plan = planDelivery({
      kind: 'digest_ready',
      preferences: { ...DEFAULT_PREFERENCES, optOut: ['email'] },
      at: NOON,
    });
    expect(plan.channels).toEqual([]);
  });

  it('cannot opt IN to a channel the table did not choose', () => {
    // Preference FILTERS; it never extends. A user opting in to a channel the
    // product does not use for that kind would be asking for a message that has
    // no template. `optOut: []` is the closest thing to an opt-in the type
    // allows, and it changes nothing.
    const plan = planDelivery({
      kind: 'digest_ready',
      preferences: { ...DEFAULT_PREFERENCES, optOut: [] },
      at: NOON,
    });
    expect(plan.channels).toEqual(KIND_POLICY.digest_ready.channels);
  });

  it('takes a substituted table, so the service never has to name a channel', () => {
    // THE PHASE 2 REHEARSAL at the planning layer: WhatsApp arrives as a row.
    const plan = planDelivery({
      kind: 'digest_ready',
      preferences: DEFAULT_PREFERENCES,
      at: NOON,
      policy: {
        ...KIND_POLICY,
        digest_ready: { ...KIND_POLICY.digest_ready, channels: ['whatsapp', 'email'] },
      },
    });
    expect(plan.channels).toEqual(['whatsapp', 'email']);
  });
});

describe('quiet hours', () => {
  it('DEFERS an ordinary kind raised inside the window', () => {
    // Deferred, not dropped. The naive implementation returns an empty channel
    // list here, and it is wrong in a way that is invisible: the notification
    // is silently never emailed and the only trace is that nobody reacted.
    const plan = planDelivery({
      kind: 'digest_ready',
      preferences: DEFAULT_PREFERENCES,
      at: NIGHT,
    });

    expect(plan.deferred).toBe(true);
    expect(plan.channels).toEqual(KIND_POLICY.digest_ready.channels);
    // 07:00 IST the next morning.
    expect(plan.sendAfter.toISOString()).toBe('2026-06-02T01:30:00.000Z');
  });

  it('does NOT defer a security kind raised inside the window', () => {
    // A parent-link request is about who can see a child's data. Eight hours in
    // which somebody may have gained access to a minor's records unremarked is
    // not a trade worth making for a quieter phone.
    const plan = planDelivery({
      kind: 'link_requested',
      preferences: DEFAULT_PREFERENCES,
      at: NIGHT,
    });

    expect(plan.deferred).toBe(false);
    expect(plan.sendAfter).toEqual(NIGHT);
    expect(plan.channels).toEqual(KIND_POLICY.link_requested.channels);
  });

  it('does not defer an ordinary kind raised OUTSIDE the window', () => {
    const plan = planDelivery({
      kind: 'digest_ready',
      preferences: DEFAULT_PREFERENCES,
      at: NOON,
    });
    expect(plan.deferred).toBe(false);
    expect(plan.sendAfter).toEqual(NOON);
  });

  it('does not defer when the user has turned quiet hours off', () => {
    const plan = planDelivery({
      kind: 'digest_ready',
      preferences: { ...DEFAULT_PREFERENCES, quietHours: null },
      at: NIGHT,
    });
    expect(plan.deferred).toBe(false);
    expect(plan.sendAfter).toEqual(NIGHT);
  });

  it('evaluates the window in the USER timezone, not the server one', () => {
    // 18:00 UTC is 23:30 in Kolkata and 18:00 in London. The same instant, the
    // same window, two different answers — which is the whole reason the window
    // is stored in local hours.
    const kolkata = planDelivery({
      kind: 'digest_ready',
      preferences: DEFAULT_PREFERENCES,
      at: NIGHT,
    });
    const london = planDelivery({
      kind: 'digest_ready',
      preferences: { ...DEFAULT_PREFERENCES, timezone: 'Europe/London' },
      at: NIGHT,
    });

    expect(kolkata.deferred).toBe(true);
    expect(london.deferred).toBe(false);
  });

  it('reports an EMPTY plan as not deferred, even at night', () => {
    // There is no delivery to defer. Counting it as a deferral would overstate
    // how often quiet hours actually fire, on the one metric an operator would
    // use to decide whether the window is too wide.
    const plan = planDelivery({
      kind: 'streak_reminder',
      preferences: DEFAULT_PREFERENCES,
      at: NIGHT,
    });
    expect(plan.channels).toEqual([]);
    expect(plan.deferred).toBe(false);
  });
});
