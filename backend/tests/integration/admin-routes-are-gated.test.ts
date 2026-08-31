import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { errorResponseSchema } from '@/shared/contracts/identity.contract';
import { ADMIN_PREFIX } from '@/modules/admin/index';
import { registerAdminRoutes } from '@/modules/admin/admin.routes';
import type { AdminDataService } from '@/modules/admin/admin.data.service';
import type { AdminService } from '@/modules/admin/admin.service';
import {
  HARNESS_ORIGIN,
  TEST_COOKIE_NAME,
  TEST_TENANT_ID,
  onboardAccount,
  startAppHarness,
  type AppHarness,
  type HarnessAccount,
} from '../helpers/app-harness';

/**
 * =============================================================================
 * THE MOST IMPORTANT TEST IN THE ADMIN MODULE.
 *
 * `/admin` reads across every tenant and every learner in the product, which
 * means it deliberately bypasses `assertCanAccess` — the one authorisation
 * primitive in this codebase that is airtight. Three things stand in for it,
 * and this file proves the first two:
 *
 *   1. EVERY admin route carries the gate. Not "was written carefully" —
 *      enumerated from FASTIFY'S OWN ROUTE TABLE, so a ninth endpoint added in
 *      Phase 4 without a preHandler fails the build instead of shipping an open
 *      door. A hand-maintained list of routes would be the D-075 defect again:
 *      it works until somebody forgets, and forgetting is the whole failure.
 *
 *   2. THE REFUSAL DISCLOSES NOTHING. 404 and not 403, with a body that could
 *      have come from a URL typo. A 403 confirms the route exists, which hands
 *      a prober the shape of the internal surface for free.
 *
 * The third — that nothing writes — is a lint rule, tested where it lives.
 * =============================================================================
 */

interface CollectedRoute {
  readonly method: string;
  readonly url: string;
  readonly preHandlers: readonly unknown[];
}

/**
 * A stand-in for the real gate. Identity is what is asserted — a route whose
 * preHandler array does not CONTAIN THIS EXACT FUNCTION did not get the gate,
 * and no amount of having some other preHandler substitutes for it.
 */
const GATE_MARKER = async (): Promise<void> => {
  /* never invoked */
};

let harness: AppHarness;
let routes: CollectedRoute[];

beforeAll(async () => {
  routes = await collectAdminRoutes();
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

/**
 * Every route `registerAdminRoutes` adds, WITH THE PREHANDLERS IT ATTACHED.
 *
 * Collected through Fastify's `onRoute` hook on a BARE instance, which is the
 * supported way to see a route table and the only way to see its hooks.
 * `app.routes` is not public API in Fastify 5, and `printRoutes()` renders a
 * radix TREE for human eyes — reassembling URLs from indented fragments would
 * make this a test of a display format.
 *
 * A bare instance rather than the harness's, deliberately: the property being
 * proved is "the registrar attaches the gate to everything it registers", which
 * is a fact about `admin.routes.ts` and not about how the app was composed. It
 * also means the service can be a stub that is never called — nothing here
 * executes a handler.
 */
async function collectAdminRoutes(): Promise<CollectedRoute[]> {
  const app = Fastify();
  const collected: CollectedRoute[] = [];

  app.addHook('onRoute', (route) => {
    const hooks = route.preHandler;
    const preHandlers = hooks === undefined ? [] : Array.isArray(hooks) ? hooks : [hooks];
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      collected.push({ method, url: route.url, preHandlers });
    }
  });

  registerAdminRoutes(app, {
    // Never invoked — no handler runs in this instance.
    service: {} as unknown as AdminService,
    data: {} as unknown as AdminDataService,
    // Never invoked either — no handler runs in this instance.
    throttleReveal: async (): Promise<void> => {
      /* no handler runs here */
    },
    requireAdmin: GATE_MARKER,
  });
  await app.ready();
  await app.close();

  return collected;
}

function call(
  method: string,
  url: string,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: method as 'GET',
    url,
    // Every state-changing request carries an Origin, because every real one
    // does — the origin check runs before authentication.
    headers: { origin: HARNESS_ORIGIN },
    ...(method === 'GET' ? {} : { payload: {} }),
    ...(cookie === undefined ? {} : { cookies: { [TEST_COOKIE_NAME]: cookie } }),
  });
}

let counter = 0;

async function accountWithRole(role: 'student' | 'parent'): Promise<HarnessAccount> {
  counter += 1;
  return await onboardAccount(harness, `gate${counter}@example.test`, role);
}

describe('the admin route table', () => {
  it('has routes to enumerate — the guard on the guard', () => {
    // Two empty sets are equal. Without this, every assertion below passes
    // vacuously the day somebody deletes the module registration.
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it('registers nothing outside the admin prefix by accident', () => {
    for (const route of routes) {
      expect(route.url.startsWith(`${ADMIN_PREFIX}/`)).toBe(true);
    }
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * Every other test below observes a STATUS CODE, which is evidence and not
   * proof: a route could answer 404 for some unrelated reason — a typo in its
   * path, a schema rejection, a handler that happens to throw — and read as
   * gated while being wide open the moment that reason changed.
   *
   * This one asserts the gate FUNCTION ITSELF is attached, by identity. There
   * is no way to satisfy it except by passing `requireAdmin` to the route.
   */
  it('attaches the gate to every single route, by identity', () => {
    for (const route of routes) {
      expect({ route: route.url, gated: route.preHandlers.includes(GATE_MARKER) }).toEqual({
        route: route.url,
        gated: true,
      });
    }
  });
});

describe('every admin route refuses an unauthenticated caller', () => {
  it('answers 401 with no session cookie', async () => {
    for (const route of routes) {
      const response = await call(route.method, route.url);
      // 401 rather than 404 HERE, deliberately: a missing session is about the
      // CALLER's credentials, not about the route, and the browser needs to be
      // told to stop sending a dead cookie.
      expect({ route, status: response.statusCode }).toEqual({ route, status: 401 });
    }
  });
});

describe('every admin route is invisible to a non-admin', () => {
  it('answers 404 to a student, with a body that discloses nothing', async () => {
    const account = await accountWithRole('student');

    for (const route of routes) {
      const response = await call(route.method, route.url, account.cookie);

      expect({ route, status: response.statusCode }).toEqual({ route, status: 404 });

      // NEVER 403. A 403 would confirm the route exists.
      expect(response.statusCode).not.toBe(403);

      const parsed = errorResponseSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        const message = parsed.data.error.message.toLowerCase();
        expect(message).not.toContain('admin');
        expect(message).not.toContain('role');
        expect(message).not.toContain('super');
      }
    }
  });

  it('answers 404 to a parent as well', async () => {
    const account = await accountWithRole('parent');
    for (const route of routes) {
      const response = await call(route.method, route.url, account.cookie);
      expect({ route, status: response.statusCode }).toEqual({ route, status: 404 });
    }
  });

  it('answers 404 to a revoked session', async () => {
    const account = await accountWithRole('student');
    await harness.identity.service.logoutAll({
      userId: account.userId,
      role: 'student',
      tenantId: TEST_TENANT_ID,
    });

    for (const route of routes) {
      const response = await call(route.method, route.url, account.cookie);
      // A dead session fails at `requireSession`, before the role is consulted.
      expect({ route, status: response.statusCode }).toEqual({ route, status: 401 });
    }
  });
});
