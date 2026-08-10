import { describe, expect, it } from 'vitest';
import { NOTIFY_KIND_VALUES } from '@/shared/contracts/notify.contract';
import {
  KIND_POLICY,
  NOTIFY_KINDS,
  isNotifyKind,
  toChannelPolicy,
} from '../domain/kinds';

/**
 * The routing table — §8.9, and 05-ROADMAP.md §4's Phase 2 claim that "adding a
 * channel then becomes one adapter".
 *
 * These tests are about the SHAPE of the table, not about any particular row's
 * contents. A row's channel list is a product decision and will change; the
 * properties below are what make changing it cheap and safe.
 */

describe('the kind set', () => {
  it('matches the wire contract exactly', () => {
    // `shared/` may not import from `modules/`, so the kind list is written out
    // in both places. THIS TEST IS THE ONLY THING STOPPING THEM DRIFTING — and
    // the drift would be silent in the worst direction: a kind the module knows
    // and the contract rejects turns a working notification into a 500 in the
    // response serialiser, long after it was written.
    expect([...NOTIFY_KINDS].sort()).toEqual([...NOTIFY_KIND_VALUES].sort());
  });

  it('accepts a known kind and refuses an unknown one', () => {
    expect(isNotifyKind('digest_ready')).toBe(true);
    expect(isNotifyKind('something.new')).toBe(false);
  });

  it('has a policy row for every kind', () => {
    // `Record<NotifyKind, KindPolicy>` makes this a compile error too. Asserted
    // anyway because the compiler cannot see a row added with a spread or built
    // from a loop, and a kind with no row is a `TypeError` at the point of
    // sending rather than at the point of adding.
    for (const kind of NOTIFY_KINDS) {
      expect(KIND_POLICY[kind]).toBeDefined();
    }
  });
});

describe('every row is well formed', () => {
  it('never lists in-app as a channel', () => {
    // THE INVARIANT THIS FILE EXISTS TO PROTECT. In-app is written
    // synchronously by `send`, before any remote channel is attempted. If a row
    // listed it, the delivery job would fan out over it too and write a SECOND
    // row for the same notification — a duplicate that no test of the sending
    // path would notice, because the first row is correct.
    for (const kind of NOTIFY_KINDS) {
      expect(KIND_POLICY[kind].channels).not.toContain('in-app');
    }
  });

  it('never lists the same channel twice', () => {
    // A duplicate would send two emails and count one delivery.
    for (const kind of NOTIFY_KINDS) {
      const channels = KIND_POLICY[kind].channels;
      expect(new Set(channels).size).toBe(channels.length);
    }
  });

  it('gives every kind a positive daily cap', () => {
    // A cap of 0 silences a kind entirely, which is a decision that should be
    // made by removing the kind rather than by a number nobody reads.
    for (const kind of NOTIFY_KINDS) {
      expect(KIND_POLICY[kind].dailyCap).toBeGreaterThan(0);
    }
  });

  it('marks the three link kinds as security and nothing else', () => {
    // Quiet hours are bypassed by exactly these. Widening the set is how
    // "urgent" comes to mean "everything" and a user mutes the product; the
    // test is here so that widening it is a deliberate edit rather than a
    // reflex when somebody's notification arrives late.
    const security = NOTIFY_KINDS.filter((kind) => KIND_POLICY[kind].urgency === 'security');
    expect([...security].sort()).toEqual(['link_approved', 'link_requested', 'link_revoked']);
  });

  it('leaves payment_failed ORDINARY', () => {
    // Account-critical, not account-security. Nobody's data is at risk and the
    // grace period is measured in days; waking a parent at 02:00 about a card
    // decline is how a product teaches people to mute it.
    expect(KIND_POLICY.payment_failed.urgency).toBe('ordinary');
  });

  it('allows a row with NO remote channels', () => {
    // `streak_reminder` is in-app only, and that is a legitimate row rather than
    // an oversight — a daily email about a missed streak is the fastest way to
    // be marked as spam. It also means the cheapest notification in the product
    // costs one INSERT and no queue row at all.
    expect(KIND_POLICY.streak_reminder.channels).toEqual([]);
  });
});

describe('toChannelPolicy — the handover to the dispatcher', () => {
  it('produces one entry per kind, carrying that kind list', () => {
    const policy = toChannelPolicy();
    expect(Object.keys(policy).sort()).toEqual([...NOTIFY_KINDS].sort());
    expect(policy.digest_ready).toEqual(KIND_POLICY.digest_ready.channels);
  });

  it('carries a channel the product does not use today', () => {
    // THE PHASE 2 REHEARSAL, at the table level. Adding WhatsApp to a row is a
    // one-line edit and it arrives at the dispatcher intact — no code in this
    // module has to learn what a WhatsApp template is.
    const policy = toChannelPolicy({
      ...KIND_POLICY,
      digest_ready: { ...KIND_POLICY.digest_ready, channels: ['whatsapp', 'email'] },
    });
    expect(policy.digest_ready).toEqual(['whatsapp', 'email']);
  });
});
