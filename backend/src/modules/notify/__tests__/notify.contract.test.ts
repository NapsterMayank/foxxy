import { describe, expect, it } from 'vitest';
import {
  NOTIFY_KIND_VALUES,
  bilingualTextSchema,
  listNotificationsQuerySchema,
  markReadResponseSchema,
  notificationSchema,
  notifyKindSchema,
} from '@/shared/contracts/notify.contract';
import { KIND_POLICY, NOTIFY_KINDS } from '../domain/kinds';

/**
 * The notify wire contract.
 *
 * THIS FILE IS NAMED IN `notify.contract.ts` ITSELF as the mechanism that stops
 * the wire enum and the module's routing table from drifting: `shared/` may not
 * import from `modules/`, so the kind list is written out twice on purpose, and
 * the only thing keeping the two copies equal is an assertion. Without it the
 * duplication is not a deliberate decoupling — it is just a copy waiting to go
 * stale, and the failure it produces is a kind the server accepts over HTTP and
 * then cannot route, or a kind the product raises internally that no client can
 * parse.
 */

describe('the kind enum on the wire matches the routing table', () => {
  it('has EXACTLY the same kinds, in the same order', () => {
    // Order too, not just membership. The two lists are read side by side by
    // anybody adding a kind, and a set-equality assertion would let them fall
    // out of step in a way that makes the next diff harder to review.
    expect([...NOTIFY_KIND_VALUES]).toEqual([...NOTIFY_KINDS]);
  });

  it('gives every wire kind a routing policy', () => {
    // The direction that actually breaks at runtime: a kind a client may send
    // or receive, for which nothing decides channels, urgency or a cap.
    for (const kind of NOTIFY_KIND_VALUES) {
      expect(KIND_POLICY[kind]).toBeDefined();
    }
  });

  it('rejects a kind the server cannot route', () => {
    expect(notifyKindSchema.safeParse('promotional_blast').success).toBe(false);
    expect(notifyKindSchema.safeParse('').success).toBe(false);
  });
});

describe('both languages are required ON THE WIRE (P7)', () => {
  it('accepts a message carrying both', () => {
    const parsed = bilingualTextSchema.parse({ en: 'Ready', hi: 'तैयार' });
    expect(parsed.hi).toBe('तैयार');
  });

  it('REJECTS an English-only message', () => {
    // The third layer of the same rule. The type stops it compiling, the CHECK
    // constraint stops a raw INSERT, and this stops a response assembled by
    // hand — each catches a class of mistake the others structurally cannot
    // see.
    expect(bilingualTextSchema.safeParse({ en: 'Ready' }).success).toBe(false);
  });

  it('REJECTS a blank Hindi string, which is how a NOT NULL gets satisfied', () => {
    expect(bilingualTextSchema.safeParse({ en: 'Ready', hi: '' }).success).toBe(false);
  });

  it('rejects a notification whose body is single-language', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'digest_ready',
      title: { en: 'T', hi: 'ट' },
      data: {},
      readAt: null,
      createdAt: '2026-06-01T09:00:00.000Z',
    };
    expect(notificationSchema.safeParse({ ...base, body: { en: 'B' } }).success).toBe(false);
    expect(notificationSchema.safeParse({ ...base, body: { en: 'B', hi: 'ब' } }).success).toBe(true);
  });
});

describe('list pagination is keyset and bounded', () => {
  it('defaults to a page size a client never has to ask for', () => {
    expect(listNotificationsQuerySchema.parse({}).limit).toBe(20);
  });

  it('coerces the limit from a query string, which is always text', () => {
    expect(listNotificationsQuerySchema.parse({ limit: '5' }).limit).toBe(5);
  });

  it('REFUSES an unbounded page rather than silently capping it', () => {
    // A caller asking for 10,000 has a bug or an intent; answering 100 to both
    // hides the first and does not stop the second. It is refused so the caller
    // finds out.
    expect(listNotificationsQuerySchema.safeParse({ limit: 10_000 }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('requires the cursor to be a timestamp, not an id', () => {
    // Keyset over `created_at desc`. An id here would scan nothing and return
    // an empty page that looks like the end of the list.
    expect(listNotificationsQuerySchema.safeParse({ before: 'not-a-time' }).success).toBe(false);
    expect(
      listNotificationsQuerySchema.safeParse({ before: '2026-06-01T09:00:00.000Z' }).success,
    ).toBe(true);
  });
});

describe('marking read is a 200 with a boolean, never an error', () => {
  it('carries `changed` so a repeat is distinguishable without being a failure', () => {
    expect(markReadResponseSchema.parse({ changed: false, unreadCount: 0 }).changed).toBe(false);
  });

  it('refuses a negative unread count', () => {
    expect(markReadResponseSchema.safeParse({ changed: true, unreadCount: -1 }).success).toBe(false);
  });
});
