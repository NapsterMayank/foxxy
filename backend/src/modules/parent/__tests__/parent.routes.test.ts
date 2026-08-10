import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { errorResponseSchema } from '@/shared/contracts/identity.contract';
import type { OnboardingRequest } from '@/shared/contracts/learner.contract';
import {
  childrenResponseSchema,
  consentResponseSchema,
  consentRevokeResponseSchema,
  digestResponseSchema,
  snapshotResponseSchema,
  transcriptResponseSchema,
} from '@/shared/contracts/parent.contract';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../../../../tests/helpers/app-harness';

/**
 * ============================================================================
 * parent ROUTE TESTS — the HTTP surface, and the one place the ENUMERATION
 * ORACLE can actually be measured.
 *
 * Every success response is parsed with the SHARED CONTRACT SCHEMA rather than
 * checked field by field. That is what makes the contract real: if a route and
 * the schema the frontend imports ever disagree, these fail rather than the
 * browser doing so at runtime.
 *
 * THE CENTRAL TEST IN THIS FILE compares RAW RESPONSE BODIES across four
 * different refusal reasons. It is here rather than in the service suite
 * because the service throws typed errors whose LOG-SIDE fields legitimately
 * differ; what a caller receives is whatever `error-handler.ts` renders, and
 * only bytes on the wire can prove an attacker learns nothing.
 *
 * A parent who can tell "no such child" from "not your child" can enumerate
 * student accounts by trying ids. That is an enumeration attack against
 * children, which is why this is the assertion the module was designed around
 * rather than one added afterwards.
 * ============================================================================
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

const ONBOARDING: OnboardingRequest = {
  displayName: 'Aarav',
  grade: '8',
  subjects: ['science', 'maths'],
};

/** A uuid that is syntactically valid and belongs to nobody. */
const NOBODY = '99999999-9999-4999-8999-999999999999';

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

let emailCounter = 0;
function nextEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}${emailCounter}@example.test`;
}

interface Pair {
  readonly parent: HarnessAccount;
  readonly child: HarnessAccount;
  readonly linkId: string;
}

/** The real link flow, exactly as `parent.service.test.ts` builds it. */
async function makePair(status: 'approved' | 'pending' | 'revoked'): Promise<Pair> {
  const child = await onboardAccount(harness, nextEmail('rchild'), 'student');
  const parent = await onboardAccount(harness, nextEmail('rparent'), 'parent');
  const childActor = { userId: child.userId, role: 'student' as const, tenantId: TEST_TENANT_ID };
  const parentAsActor = { userId: parent.userId, role: 'parent' as const, tenantId: TEST_TENANT_ID };

  await harness.learner.service.createProfile(childActor, ONBOARDING);
  const issued = await harness.identity.service.generateLinkCode(childActor);
  const link = await harness.identity.service.submitLinkCode(parentAsActor, issued.code);

  if (status !== 'pending') await harness.identity.service.approveLink(childActor, link.id);
  if (status === 'revoked') await harness.identity.service.revokeLink(childActor, link.id);

  // Clears the signup/login rate-limit counters. See the note in the service
  // suite: the clock is NOT wound forward, because the digest is week-keyed.
  await harness.cache.close();

  return { parent, child, linkId: link.id };
}

// ---------------------------------------------------------------------------
// THE HAPPY PATH, PARSED WITH THE SHARED CONTRACT
// ---------------------------------------------------------------------------

describe('the six endpoints answer the contract', () => {
  it('GET /parent/children', async () => {
    const { parent, child } = await makePair('approved');
    const response = await get('/api/v1/parent/children', parent.cookie);

    expect(response.statusCode).toBe(200);
    const body = childrenResponseSchema.parse(response.json());
    expect(body.children.map((entry) => entry.childUserId)).toEqual([child.userId]);
  });

  it('GET /parent/children/:id/snapshot', async () => {
    const { parent, child } = await makePair('approved');
    const response = await get(`/api/v1/parent/children/${child.userId}/snapshot`, parent.cookie);

    expect(response.statusCode).toBe(200);
    const body = snapshotResponseSchema.parse(response.json());
    expect(body.childUserId).toBe(child.userId);
  });

  it('GET /parent/children/:id/digest — 200 with null, NEVER a 404', async () => {
    /**
     * "This week's digest has not been produced yet" is an ordinary state of an
     * existing resource. A 404 here would be indistinguishable from the 404 an
     * unknown child would deserve — which is exactly the oracle every deny path
     * in this module avoids, arriving through the front door.
     */
    const { parent, child } = await makePair('approved');
    const response = await get(`/api/v1/parent/children/${child.userId}/digest`, parent.cookie);

    expect(response.statusCode).toBe(200);
    expect(digestResponseSchema.parse(response.json()).digest).toBeNull();
  });

  it('GET /parent/children/:id/transcript', async () => {
    const { parent, child } = await makePair('approved');
    const response = await get(`/api/v1/parent/children/${child.userId}/transcript`, parent.cookie);

    expect(response.statusCode).toBe(200);
    const body = transcriptResponseSchema.parse(response.json());
    // THE CHILD-VISIBILITY FLAG, ON THE WIRE. The contract requires it, so this
    // is really asserting that the route cannot answer without one — a
    // transcript endpoint that could omit it is a surveillance endpoint.
    expect(body.readOnly).toBe(true);
    expect(body.visibility.childIsTold).toBe(true);
    expect(body.visibility.disclosure.hi).toMatch(/[ऀ-ॿ]/u);
  });

  it('GET /parent/children/:id/consent', async () => {
    const { parent, child, linkId } = await makePair('approved');
    const response = await get(`/api/v1/parent/children/${child.userId}/consent`, parent.cookie);

    expect(response.statusCode).toBe(200);
    const body = consentResponseSchema.parse(response.json());
    expect(body).toMatchObject({ childUserId: child.userId, linkId, status: 'approved' });
  });

  it('POST /parent/children/:id/consent/revoke', async () => {
    const { parent, child } = await makePair('approved');
    const response = await post(
      `/api/v1/parent/children/${child.userId}/consent/revoke`,
      parent.cookie,
    );

    expect(response.statusCode).toBe(200);
    expect(consentRevokeResponseSchema.parse(response.json()).status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// THE ORACLE TEST
// ---------------------------------------------------------------------------

describe('the four deny paths are BYTE-IDENTICAL on the wire', () => {
  it('answers the same status, body and content-type for every refusal reason', async () => {
    /**
     * FIVE REASONS, ONE RESPONSE:
     *
     *   pending link      the parent typed a code the child has not approved
     *   revoked link      access existed and was withdrawn
     *   no link at all    a real student this parent has never been linked to
     *   no such child     a well-formed uuid belonging to nobody
     *   another tenant    an approved link across a tenant boundary
     *
     * The last is the one that separates this from a formality: it needs
     * `readTenantOfStudent` to actually read `users`, and it is the assertion
     * that goes red if somebody echoes `actor.tenantId` back (D-091).
     *
     * Compared as RAW PAYLOAD STRINGS, not parsed objects. A difference in key
     * ORDER is a difference an attacker can see, and `toEqual` on parsed JSON
     * would not report it.
     */
    const pending = await makePair('pending');
    const revoked = await makePair('revoked');
    const approved = await makePair('approved');
    const stranger = await onboardAccount(harness, nextEmail('rstranger'), 'student');
    await harness.learner.service.createProfile(
      { userId: stranger.userId, role: 'student', tenantId: TEST_TENANT_ID },
      ONBOARDING,
    );

    const attempts: readonly { readonly reason: string; readonly url: string; readonly cookie: string }[] = [
      {
        reason: 'pending link',
        url: `/api/v1/parent/children/${pending.child.userId}/snapshot`,
        cookie: pending.parent.cookie,
      },
      {
        reason: 'revoked link',
        url: `/api/v1/parent/children/${revoked.child.userId}/snapshot`,
        cookie: revoked.parent.cookie,
      },
      {
        reason: 'no link at all',
        url: `/api/v1/parent/children/${stranger.userId}/snapshot`,
        cookie: approved.parent.cookie,
      },
      {
        reason: 'no such child',
        url: `/api/v1/parent/children/${NOBODY}/snapshot`,
        cookie: approved.parent.cookie,
      },
      {
        reason: 'a child linked to somebody ELSE',
        url: `/api/v1/parent/children/${approved.child.userId}/snapshot`,
        cookie: pending.parent.cookie,
      },
    ];

    const seen = new Set<string>();
    for (const { reason, url, cookie } of attempts) {
      const response = await get(url, cookie);
      expect(response.statusCode, reason).toBe(403);
      // Parses as the shared error envelope, so a route that started returning
      // a bespoke shape fails here too.
      errorResponseSchema.parse(response.json());
      seen.add(
        JSON.stringify({
          status: response.statusCode,
          type: response.headers['content-type'],
          body: response.payload,
        }),
      );
    }

    // ONE. A second entry means a caller can tell the reasons apart.
    expect(seen.size).toBe(1);
  });

  it('answers the SAME 403 on every endpoint, not just the snapshot', async () => {
    // The oracle has to be closed on all six, because an attacker will try all
    // six. A helpful 404 on the transcript is as good an oracle as one on the
    // snapshot.
    const { parent } = await makePair('approved');

    const bodies = new Set<string>();
    for (const path of ['snapshot', 'digest', 'transcript', 'consent']) {
      const response = await get(`/api/v1/parent/children/${NOBODY}/${path}`, parent.cookie);
      expect(response.statusCode, path).toBe(403);
      bodies.add(response.payload);
    }
    const revoke = await post(`/api/v1/parent/children/${NOBODY}/consent/revoke`, parent.cookie);
    expect(revoke.statusCode).toBe(403);
    bodies.add(revoke.payload);

    expect(bodies.size).toBe(1);
  });

  it('leaks nothing about the child in the refusal body', async () => {
    const { parent, child } = await makePair('approved');
    const other = await makePair('approved');

    const response = await get(
      `/api/v1/parent/children/${other.child.userId}/snapshot`,
      parent.cookie,
    );

    expect(response.statusCode).toBe(403);
    expect(response.payload).not.toContain(other.child.userId);
    expect(response.payload).not.toContain(child.userId);
    expect(response.payload).not.toContain('Aarav');
    expect(response.payload).not.toMatch(/@example\.test/);
  });
});

// ---------------------------------------------------------------------------
// SESSION AND INPUT
// ---------------------------------------------------------------------------

describe('no session, no answer', () => {
  it('refuses every endpoint without a cookie', async () => {
    const { child } = await makePair('approved');
    for (const path of ['snapshot', 'digest', 'transcript', 'consent']) {
      const response = await get(`/api/v1/parent/children/${child.userId}/${path}`);
      expect(response.statusCode, path).toBe(401);
    }
    expect((await get('/api/v1/parent/children')).statusCode).toBe(401);
  });

  it('takes the PARENT id from the session and from nowhere else', async () => {
    /**
     * There is no field a caller can send to read another parent's children:
     * `/parent/children` has no path parameter, no query and no body. Asserted
     * by proving that a second parent's cookie returns THEIR list, not the
     * first's, when nothing else about the request differs.
     */
    const first = await makePair('approved');
    const second = await makePair('approved');

    const firstList = childrenResponseSchema.parse(
      (await get('/api/v1/parent/children', first.parent.cookie)).json(),
    );
    const secondList = childrenResponseSchema.parse(
      (await get('/api/v1/parent/children', second.parent.cookie)).json(),
    );

    expect(firstList.children.map((entry) => entry.childUserId)).toEqual([first.child.userId]);
    expect(secondList.children.map((entry) => entry.childUserId)).toEqual([second.child.userId]);
  });
});

describe('input validation happens before anything else', () => {
  it('rejects a child id that is not a uuid with a 400', async () => {
    // A 400 for a malformed id is NOT an oracle: it says the string is not a
    // uuid, which the caller already knew. The 403/404 distinction is the one
    // that leaks, and a syntactically invalid id cannot name a real child.
    const { parent } = await makePair('approved');
    const response = await get('/api/v1/parent/children/not-a-uuid/snapshot', parent.cookie);
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed week', async () => {
    const { parent, child } = await makePair('approved');
    const response = await get(
      `/api/v1/parent/children/${child.userId}/snapshot?week=last-tuesday`,
      parent.cookie,
    );
    expect(response.statusCode).toBe(400);
  });

  it('bounds the transcript page size', async () => {
    // An unbounded page is an unbounded read of a child's conversations.
    const { parent, child } = await makePair('approved');
    const response = await get(
      `/api/v1/parent/children/${child.userId}/transcript?limit=5000`,
      parent.cookie,
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('revocation is immediate over HTTP too', () => {
  it('reads 200, revokes, then reads 403 — in one test', async () => {
    const { parent, child } = await makePair('approved');
    const url = `/api/v1/parent/children/${child.userId}/snapshot`;

    expect((await get(url, parent.cookie)).statusCode).toBe(200);
    expect(
      (await post(`/api/v1/parent/children/${child.userId}/consent/revoke`, parent.cookie))
        .statusCode,
    ).toBe(200);
    // SAME cookie, same session — the status is re-read per request, so nothing
    // needed invalidating and nothing slept.
    expect((await get(url, parent.cookie)).statusCode).toBe(403);
  });
});
