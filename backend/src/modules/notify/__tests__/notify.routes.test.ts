import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { errorResponseSchema } from '@/shared/contracts/identity.contract';
import {
  listNotificationsResponseSchema,
  markAllReadResponseSchema,
  markReadResponseSchema,
  unreadCountResponseSchema,
} from '@/shared/contracts/notify.contract';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';

/**
 * notify route tests — the HTTP surface.
 *
 * Every success response is parsed with the SHARED CONTRACT SCHEMA rather than
 * checked field by field, the same rule the learner routes follow: if a route
 * and the schema the frontend imports ever disagree, these tests fail instead
 * of the frontend doing so at runtime.
 *
 * ===========================================================================
 * THE THING THIS FILE PROVES THAT THE SERVICE TESTS CANNOT.
 *
 * The service tests construct an actor and hand it in. That is the right shape
 * for a service test and it means the ROUTE's own claim — "the recipient comes
 * from the SESSION, never from the path or the body" — is never exercised. Here
 * the only way to become an actor is to hold a session cookie, so a route that
 * started reading a `userId` from the query string would have to be caught
 * here or not at all.
 *
 * There is deliberately NO test for an endpoint that sends a notification,
 * because there is deliberately no such endpoint. `send` is a system call; a
 * route for it would let any authenticated caller write into anybody's inbox.
 * The assertion that it stays absent is at the bottom of this file.
 */

let harness: AppHarness;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
});

const MESSAGE = {
  title: { en: 'Your weekly summary', hi: 'आपका साप्ताहिक सारांश' },
  body: { en: 'Asha completed 4 missions.', hi: 'आशा ने 4 मिशन पूरे किए।' },
} as const;

function get(url: string, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

function post(url: string, cookie?: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url,
    // Every state-changing request carries an `Origin`, because every real one
    // does — the origin check (§6.10) refuses one that arrives without a
    // recognised origin.
    headers: { origin: HARNESS_ORIGIN },
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

async function student(email: string): Promise<HarnessAccount> {
  return onboardAccount(harness, email, 'student');
}

/** Sends through the module the harness built, which is the one the app serves. */
async function sendTo(account: HarnessAccount, kind = 'digest_ready'): Promise<string> {
  const result = await harness.notify.service.send({
    recipientUserId: account.userId,
    kind: kind as 'digest_ready',
    ...MESSAGE,
  });
  if (result.notificationId === null) throw new Error('the send was suppressed');
  return result.notificationId;
}

describe('GET /api/v1/notifications', () => {
  it('returns the contract shape, newest first, with both languages', async () => {
    const account = await student('nr1@example.test');
    await sendTo(account);

    const response = await get('/api/v1/notifications', account.cookie);

    expect(response.statusCode).toBe(200);
    const body = listNotificationsResponseSchema.parse(response.json());
    expect(body.notifications).toHaveLength(1);
    expect(body.unreadCount).toBe(1);
    // BOTH LANGUAGES on the wire — the client picks. Rendering server-side
    // would freeze the language at write time, so a preference change would
    // apply only to future notifications.
    expect(body.notifications[0]?.title).toEqual(MESSAGE.title);
    expect(body.notifications[0]?.body).toEqual(MESSAGE.body);
  });

  it('strips internal delivery bookkeeping from `data`', async () => {
    // `_delivery` lives inside the same jsonb column the client reads. The
    // repository strips any `_`-prefixed key on the way out; this is the
    // assertion that the stripping survives the route.
    const account = await student('nr2@example.test');
    const id = await sendTo(account);
    await harness.notify.service.deliver(
      await harness.container.jobQueue
        .claim('test-worker', ['notify.deliver_notification'], harness.clock.now())
        .then((job) => {
          if (job === null) throw new Error('no delivery job was queued');
          return job;
        }),
    );

    const body = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications', account.cookie)).json(),
    );
    expect(body.notifications[0]?.id).toBe(id);
    expect(Object.keys(body.notifications[0]?.data ?? {}).some((key) => key.startsWith('_'))).toBe(
      false,
    );
  });

  it('offers a cursor ONLY when the page was full', async () => {
    // A short page is the end of the list. Handing back a cursor for it makes
    // every client issue one more request that always returns nothing.
    const account = await student('nr3@example.test');
    await sendTo(account);

    const full = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications?limit=1', account.cookie)).json(),
    );
    expect(full.nextBefore).not.toBeNull();

    const short = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications?limit=20', account.cookie)).json(),
    );
    expect(short.nextBefore).toBeNull();
  });

  it('400s an unusable limit rather than quietly capping it', async () => {
    const account = await student('nr4@example.test');
    const response = await get('/api/v1/notifications?limit=10000', account.cookie);
    expect(response.statusCode).toBe(400);
    errorResponseSchema.parse(response.json());
  });

  it('401s with NO cookie, and returns no notifications at all', async () => {
    const account = await student('nr5@example.test');
    await sendTo(account);

    const response = await get('/api/v1/notifications');

    expect(response.statusCode).toBe(401);
    // The refusal must not carry the thing it refused. A 401 that helpfully
    // included the list would be the whole leak in one response.
    expect(response.body).not.toContain('weekly summary');
    expect(response.body).not.toContain(account.userId);
  });

  it('shows one caller NOTHING of another caller inbox', async () => {
    // The recipient comes from the session. There is no field on this request a
    // caller could change to reach somebody else, which is what makes the
    // service's `assertCanAccess` a second lock rather than the only one.
    const mine = await student('nr6a@example.test');
    const theirs = await student('nr6b@example.test');
    await sendTo(theirs);

    const body = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications', mine.cookie)).json(),
    );
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });
});

describe('GET /api/v1/notifications/unread-count', () => {
  it('returns the badge for the caller', async () => {
    const account = await student('nr7@example.test');
    await sendTo(account);

    const response = await get('/api/v1/notifications/unread-count', account.cookie);
    expect(response.statusCode).toBe(200);
    expect(unreadCountResponseSchema.parse(response.json()).unreadCount).toBe(1);
  });

  it('401s without a session', async () => {
    expect((await get('/api/v1/notifications/unread-count')).statusCode).toBe(401);
  });
});

describe('POST /api/v1/notifications/:id/read', () => {
  it('marks one read and is IDEMPOTENT — always 200, never 409', async () => {
    // A client that taps twice, or replays after a dropped connection, has done
    // nothing wrong. `changed` carries the distinction for whoever wants it.
    const account = await student('nr8@example.test');
    const id = await sendTo(account);

    const first = await post(`/api/v1/notifications/${id}/read`, account.cookie);
    const second = await post(`/api/v1/notifications/${id}/read`, account.cookie);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(markReadResponseSchema.parse(first.json()).changed).toBe(true);

    const repeat = markReadResponseSchema.parse(second.json());
    expect(repeat.changed).toBe(false);
    expect(repeat.unreadCount).toBe(0);
  });

  it('403s on another caller notification, carrying nothing about it', async () => {
    const owner = await student('nr9a@example.test');
    const intruder = await student('nr9b@example.test');
    const id = await sendTo(owner);

    const response = await post(`/api/v1/notifications/${id}/read`, intruder.cookie);

    expect(response.statusCode).toBe(403);
    errorResponseSchema.parse(response.json());
    expect(response.body).not.toContain(owner.userId);
    expect(response.body).not.toContain('weekly summary');
    // Still unread for its owner — a denied write must change nothing.
    expect(
      unreadCountResponseSchema.parse(
        (await get('/api/v1/notifications/unread-count', owner.cookie)).json(),
      ).unreadCount,
    ).toBe(1);
  });

  it('gives a MISSING id the IDENTICAL 403, not a 404', async () => {
    // Byte-identical, not merely similar. A 404 for the first would be an
    // oracle for "does this notification id exist", and ids are guessable in
    // bulk in a way that names are not.
    const owner = await student('nr10a@example.test');
    const intruder = await student('nr10b@example.test');
    const id = await sendTo(owner);

    const somebodyElses = await post(`/api/v1/notifications/${id}/read`, intruder.cookie);
    const missing = await post(
      '/api/v1/notifications/33333333-3333-4333-8333-333333333333/read',
      intruder.cookie,
    );

    expect(missing.statusCode).toBe(somebodyElses.statusCode);
    expect(missing.json()).toEqual(somebodyElses.json());
  });

  it('400s a malformed id — which is a different question from a forbidden one', async () => {
    const account = await student('nr11@example.test');
    const response = await post('/api/v1/notifications/not-a-uuid/read', account.cookie);
    expect(response.statusCode).toBe(400);
    errorResponseSchema.parse(response.json());
  });

  it('401s without a session', async () => {
    const account = await student('nr12@example.test');
    const id = await sendTo(account);
    expect((await post(`/api/v1/notifications/${id}/read`)).statusCode).toBe(401);
  });
});

describe('POST /api/v1/notifications/read-all', () => {
  it('clears the caller badge and NOBODY ELSE', async () => {
    const mine = await student('nr13a@example.test');
    const theirs = await student('nr13b@example.test');
    await sendTo(mine);
    await sendTo(theirs);

    const response = await post('/api/v1/notifications/read-all', mine.cookie);

    expect(response.statusCode).toBe(200);
    const body = markAllReadResponseSchema.parse(response.json());
    expect(body.marked).toBe(1);
    expect(body.unreadCount).toBe(0);

    expect(
      unreadCountResponseSchema.parse(
        (await get('/api/v1/notifications/unread-count', theirs.cookie)).json(),
      ).unreadCount,
    ).toBe(1);
  });

  it('is idempotent — a repeat marks 0 and still succeeds', async () => {
    const account = await student('nr14@example.test');
    await sendTo(account);

    await post('/api/v1/notifications/read-all', account.cookie);
    const repeat = await post('/api/v1/notifications/read-all', account.cookie);

    expect(repeat.statusCode).toBe(200);
    expect(markAllReadResponseSchema.parse(repeat.json()).marked).toBe(0);
  });

  it('401s without a session', async () => {
    expect((await post('/api/v1/notifications/read-all')).statusCode).toBe(401);
  });
});

describe('there is NO endpoint that sends a notification', () => {
  it('refuses a POST to /api/v1/notifications, session or not', async () => {
    // §8.9's public interface has more members than the HTTP surface, and the
    // gap is deliberate. `send` is a system call — `billing` on a failed charge,
    // `identity` on a link request, the worker on a digest. A route for it would
    // let any authenticated caller write arbitrary text into anybody's inbox,
    // and this assertion is what makes somebody adding one have to delete a test
    // that says why they should not.
    const account = await student('nr15@example.test');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/notifications',
      headers: { origin: HARNESS_ORIGIN },
      payload: { recipientUserId: account.userId, kind: 'digest_ready', ...MESSAGE },
      cookies: { [TEST_COOKIE_NAME]: account.cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});
