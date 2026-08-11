import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { errorResponseSchema } from '@/shared/contracts/identity.contract';
import { listNotificationsResponseSchema } from '@/shared/contracts/notify.contract';
import {
  TEST_COOKIE_NAME,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';

/**
 * =============================================================================
 * D-259 — THE KEYSET CURSOR NAMED FEWER COLUMNS THAN THE SORT, AND SKIPPED ROWS.
 *
 * `NotifyRepository.list` has always ordered by `(created_at desc, id desc)`.
 * Its cursor was `created_at` alone, applied as `created_at < :before`. A cursor
 * over one column against a sort over two DOES NOT NAME A ROW — it names an
 * instant, and every row sharing that instant falls on the excluded side of `<`.
 *
 * So: a page ends on one of two notifications written at the same instant. The
 * next page asks for rows strictly OLDER than that instant. The twin — which
 * sorts immediately after the page's last row, and was never returned — is on
 * neither page. It is skipped permanently, and both pages look perfectly
 * ordinary from the outside.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SETUP BELOW IS THE REALISTIC CASE RATHER THAN A CONTRIVED ONE.
 *
 * `notifications.created_at` defaults to `now()`, which does not advance inside
 * a transaction, and every notification in this suite is written against an
 * INJECTED `FixedClock` that returns one instant until it is moved. A bulk send
 * in production writes a batch the same way. Identical timestamps are the normal
 * case here, not a corner of it — which is exactly why the defect was invisible:
 * the tests that existed paged lists whose rows happened to be distinct.
 *
 * THE ASSERTION IS ABOUT IDENTITY, NOT COUNT. A test that only compared page
 * sizes would pass while returning the wrong rows; every case below collects the
 * ids across pages and compares the SET against what was written.
 * =============================================================================
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

function get(url: string, cookie: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'GET',
    url,
    cookies: { [TEST_COOKIE_NAME]: cookie },
  });
}

/**
 * The kinds these tests fill a list with, and WHY THERE ARE THREE OF THEM.
 *
 * `KIND_POLICY` caps each kind at five sends per user per day, and the cap is
 * real — `send` returns a suppressed result rather than a row. Rotating across
 * three link kinds gives fifteen notifications, which is more than any case
 * below needs, without weakening the cap or reaching past the service to insert
 * rows directly. Inserting directly would also defeat the point: these must be
 * rows the product actually wrote.
 *
 * All three share `urgency: 'security'`, so none of them is deferred by quiet
 * hours — the list is fully populated at the instant it is written.
 */
const FILLER_KINDS = ['link_requested', 'link_approved', 'link_revoked'] as const;

/**
 * Writes `count` notifications WITHOUT MOVING THE CLOCK.
 *
 * The harness clock is fixed, so every row lands on the same `created_at` — the
 * condition the old cursor could not represent.
 */
async function sendSameInstant(
  account: HarnessAccount,
  count: number,
): Promise<readonly string[]> {
  const perKind = FILLER_KINDS.length * 5;
  if (count > perKind) {
    throw new Error(`sendSameInstant: ${String(count)} exceeds the ${String(perKind)} daily caps`);
  }

  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await harness.notify.service.send({
      recipientUserId: account.userId,
      // Rotated rather than batched, so the rows are interleaved across kinds
      // and a cursor that accidentally depended on kind ordering would show up.
      kind: FILLER_KINDS[i % FILLER_KINDS.length] ?? 'link_requested',
      ...MESSAGE,
    });
    if (result.notificationId === null) throw new Error('the send was suppressed');
    ids.push(result.notificationId);
  }
  return ids;
}

/** Pages the endpoint to exhaustion, carrying BOTH halves of the cursor back. */
async function pageThrough(
  cookie: string,
  limit: number,
): Promise<{ readonly ids: readonly string[]; readonly pages: number }> {
  const ids: string[] = [];
  let cursor = '';
  let pages = 0;

  for (;;) {
    const response = await get(`/api/v1/notifications?limit=${String(limit)}${cursor}`, cookie);
    expect(response.statusCode).toBe(200);
    const body = listNotificationsResponseSchema.parse(response.json());
    pages += 1;
    for (const notification of body.notifications) ids.push(notification.id);

    // The two halves are null together or present together — the contract
    // refuses anything else, so this is a single decision rather than two.
    if (body.nextBefore === null || body.nextBeforeId === null) break;
    cursor = `&before=${encodeURIComponent(body.nextBefore)}&beforeId=${body.nextBeforeId}`;

    // A guard against a cursor that fails to advance. Without it, a regression
    // that returned the same page forever would hang the suite rather than fail
    // it, and a hang is a much worse signal than a red assertion.
    if (pages > 50) throw new Error('pagination did not terminate');
  }

  return { ids, pages };
}

describe('GET /api/v1/notifications paginates without skipping rows (D-259)', () => {
  it('RETURNS BOTH ROWS when a page boundary lands between two identical timestamps', async () => {
    /**
     * THE DEFECT, MINIMALLY.
     *
     * Two notifications, one instant, one row per page. Page one returns the
     * one that sorts first. The old cursor then asked for `created_at <` that
     * shared instant, which excludes its twin — so page two was empty and the
     * second notification was returned by no page at all.
     */
    const account = await onboardAccount(harness, 'pg1@example.test', 'student');
    const written = await sendSameInstant(account, 2);

    const first = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications?limit=1', account.cookie)).json(),
    );
    expect(first.notifications).toHaveLength(1);
    expect(first.nextBefore).not.toBeNull();
    expect(first.nextBeforeId).not.toBeNull();

    const second = listNotificationsResponseSchema.parse(
      (
        await get(
          `/api/v1/notifications?limit=1&before=${encodeURIComponent(
            first.nextBefore ?? '',
          )}&beforeId=${first.nextBeforeId ?? ''}`,
          account.cookie,
        )
      ).json(),
    );

    expect(second.notifications).toHaveLength(1);
    // THE ASSERTION THE OLD CURSOR FAILED. Not "two pages were returned" —
    // the two pages together must be the two rows that were written.
    expect([...first.notifications, ...second.notifications].map((n) => n.id).sort()).toEqual(
      [...written].sort(),
    );
  });

  it('returns EVERY row across pages when every timestamp in the list is identical', async () => {
    // Nine rows sharing one instant, paged three at a time. The old cursor lost
    // the whole of pages two and three: `created_at <` the shared instant
    // matches nothing, so the second request came back empty.
    const account = await onboardAccount(harness, 'pg2@example.test', 'student');
    const written = await sendSameInstant(account, 9);

    const { ids, pages } = await pageThrough(account.cookie, 3);

    expect([...ids].sort()).toEqual([...written].sort());
    // No row appears twice either — a cursor that overlapped instead of
    // skipping would satisfy the set comparison above but not this.
    expect(new Set(ids).size).toBe(written.length);
    expect(pages).toBeGreaterThan(1);
  });

  it('does not skip when the boundary falls between DISTINCT timestamps either', async () => {
    // The case that already worked, kept so the fix cannot be "make ties work
    // by breaking everything else". The clock moves between sends here.
    const account = await onboardAccount(harness, 'pg3@example.test', 'student');
    const written: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      // A second between each, so no two rows share a `created_at`.
      harness.clock.advanceMs(1_000);
      const result = await harness.notify.service.send({
        recipientUserId: account.userId,
        // Rotated for the same daily-cap reason as `sendSameInstant`.
        kind: FILLER_KINDS[i % FILLER_KINDS.length] ?? 'link_requested',
        ...MESSAGE,
      });
      if (result.notificationId === null) throw new Error('the send was suppressed');
      written.push(result.notificationId);
    }

    const { ids } = await pageThrough(account.cookie, 2);
    expect([...ids].sort()).toEqual([...written].sort());
  });

  it('400s a HALF-SUPPLIED cursor rather than answering the question that skipped rows', async () => {
    /**
     * `before` without `beforeId` IS the old request. Answering it would mean
     * silently running the defective comparison for any client that had not
     * been updated — a wrong answer instead of an error, which is the shape the
     * whole defect came in. The contract refuses it at the edge.
     */
    const account = await onboardAccount(harness, 'pg4@example.test', 'student');
    await sendSameInstant(account, 2);

    const onlyBefore = await get(
      `/api/v1/notifications?limit=1&before=${encodeURIComponent(new Date().toISOString())}`,
      account.cookie,
    );
    expect(onlyBefore.statusCode).toBe(400);
    errorResponseSchema.parse(onlyBefore.json());

    const onlyId = await get(
      '/api/v1/notifications?limit=1&beforeId=00000000-0000-4000-8000-000000000000',
      account.cookie,
    );
    expect(onlyId.statusCode).toBe(400);
    errorResponseSchema.parse(onlyId.json());
  });

  it('offers BOTH halves of the cursor or NEITHER, never one', async () => {
    const account = await onboardAccount(harness, 'pg5@example.test', 'student');
    await sendSameInstant(account, 2);

    const full = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications?limit=1', account.cookie)).json(),
    );
    expect(full.nextBefore === null).toBe(full.nextBeforeId === null);
    expect(full.nextBefore).not.toBeNull();

    const short = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications?limit=20', account.cookie)).json(),
    );
    // A short page is the end of the list: no cursor, and no half of one.
    expect(short.nextBefore).toBeNull();
    expect(short.nextBeforeId).toBeNull();
  });

  it('keeps a cursor SCOPED to its owner — another account cannot resume with it', async () => {
    // The cursor is data from a row. It must not become a way to reach rows the
    // caller could not otherwise see; the tenant and recipient predicates are
    // ANDed with the cursor rather than replaced by it.
    const mine = await onboardAccount(harness, 'pg6@example.test', 'student');
    const theirs = await onboardAccount(harness, 'pg7@example.test', 'student');
    await sendSameInstant(mine, 3);

    const page = listNotificationsResponseSchema.parse(
      (await get('/api/v1/notifications?limit=1', mine.cookie)).json(),
    );
    const resumed = listNotificationsResponseSchema.parse(
      (
        await get(
          `/api/v1/notifications?limit=10&before=${encodeURIComponent(
            page.nextBefore ?? '',
          )}&beforeId=${page.nextBeforeId ?? ''}`,
          theirs.cookie,
        )
      ).json(),
    );

    expect(resumed.notifications).toHaveLength(0);
  });
});
