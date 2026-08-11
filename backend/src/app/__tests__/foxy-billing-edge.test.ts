import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import type { Actor } from '@/platform/authz/index';
import { FREE_PLAN_CODE } from '@/modules/billing/index';
import type { Entitlements } from '@/shared/contracts/billing.contract';
import type * as foxyModule from '@/modules/foxy/index';
import type { PlanReader } from '@/modules/foxy/index';
import { createContainer, type Container } from '../container';
import { buildModules } from '../routes';

/**
 * =============================================================================
 * D-257 — THE COMPOSITION ROOT MUST HAND FOXY A READER THAT ASKS BILLING.
 *
 * `foxy-plan-reader.test.ts` proves `createFoxyPlanReader` translates
 * entitlements into an allowance correctly. That is the easy half, and it is NOT
 * the half that shipped broken. What shipped broken was the BINDING: `readPlan`
 * was wired to `() => Promise.resolve(null)`, which is a perfectly valid
 * `PlanReader`, satisfies the type, passes every foxy test, and gives every
 * paying customer the free tier forever.
 *
 * A unit test of the translator cannot see that, because the translator was
 * never called. So this file intercepts `createFoxyModule` and inspects the
 * `readPlan` that `buildModules` ACTUALLY PASSES — then drives it and asserts it
 * reached billing. A stand-in returning a constant fails here and nowhere else.
 *
 * -----------------------------------------------------------------------------
 * NO DATABASE. `pg.Pool` connects lazily and nothing below issues a query: the
 * captured reader is driven against a billing service whose `getEntitlements` is
 * replaced, which is the only method it consults.
 *
 * The interception is of `createFoxyModule` rather than of billing, because the
 * question is "what did the composition root give foxy" — and that is an
 * argument, not a behaviour, so an argument is what gets captured.
 * =============================================================================
 */

vi.mock('@/modules/foxy/index', async (importOriginal) => {
  const actual = await importOriginal<typeof foxyModule>();
  return {
    ...actual,
    createFoxyModule: vi.fn((deps: Parameters<typeof actual.createFoxyModule>[0]) => {
      capturedReadPlan = deps.readPlan;
      return actual.createFoxyModule(deps);
    }),
  };
});

/**
 * What the last `buildModules` handed foxy.
 *
 * Read through a function rather than directly, because it is assigned inside
 * the mock factory — a path the compiler cannot see, so a direct read would be
 * narrowed to `undefined` and the guard below would look like dead code.
 */
let capturedReadPlan: PlanReader | undefined;
function lastCapturedReadPlan(): PlanReader | undefined {
  return capturedReadPlan;
}

let container: Container | undefined;

const ACTOR: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'student',
  tenantId: '22222222-2222-4222-8222-222222222222',
};

function makeContainer(): Container {
  const clock = new FixedClock('2026-06-01T09:00:00.000Z');
  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5433/unused',
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: 'foxxy_session',
    APP_URL: 'http://app.test',
    API_URL: 'http://api.test',
  });
  container = createContainer(config, {
    clock,
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
    logger: new FakeLogger(),
  });
  return container;
}

interface Captured {
  readonly readPlan: PlanReader;
  readonly asked: { actor: Actor; subjectUserId: string }[];
  /** Replaces what billing answers, without touching the database. */
  answer(entitlements: Entitlements): void;
}

/**
 * Builds the production graph and returns the `readPlan` foxy was handed, with
 * billing's `getEntitlements` swapped for a recorder.
 */
function captureEdge(): Captured {
  capturedReadPlan = undefined;
  const modules = buildModules(makeContainer());

  const readPlan = lastCapturedReadPlan();
  if (readPlan === undefined) {
    throw new Error('buildModules did not construct the foxy module');
  }

  const asked: { actor: Actor; subjectUserId: string }[] = [];
  // The FREE GRANT, which is what `resolveEntitlements` returns for an account
  // with no subscription — a real plan code, not a null, because billing always
  // has an answer.
  let reply: Entitlements = {
    planCode: FREE_PLAN_CODE,
    isPaid: false,
    features: ['practice.basic', 'foxy.basic'],
    activeUntil: null,
  };

  // The reader reaches billing through a THUNK — `() => billing.service` — so
  // replacing the method on the live service object is exactly what a real call
  // would find. Casting away `readonly` is the point of the test, not a
  // shortcut around it.
  (modules.billing.service as { getEntitlements: unknown }).getEntitlements = (
    actor: Actor,
    subjectUserId: string,
  ): Promise<Entitlements> => {
    asked.push({ actor, subjectUserId });
    return Promise.resolve(reply);
  };

  return {
    readPlan,
    asked,
    answer(entitlements: Entitlements): void {
      reply = entitlements;
    },
  };
}

afterEach(async () => {
  await container?.shutdown();
  container = undefined;
  capturedReadPlan = undefined;
});

describe('buildModules wires foxy’s plan reader to billing (D-257)', () => {
  it('CONSULTS BILLING rather than answering from a stand-in', async () => {
    // THE ASSERTION THE DEFECT FAILS. `() => Promise.resolve(null)` never asks
    // anybody anything, so `asked` stays empty.
    const edge = captureEdge();

    await edge.readPlan(ACTOR, ACTOR.userId);

    expect(edge.asked).toHaveLength(1);
  });

  it('asks about the ACTOR themselves, carrying the session actor through', async () => {
    // The resolution of the signature mismatch that produced the defect: no
    // system principal is minted, so nothing in the product gains the ability to
    // read a third party's entitlements.
    const edge = captureEdge();

    await edge.readPlan(ACTOR, ACTOR.userId);

    expect(edge.asked[0]?.actor).toBe(ACTOR);
    expect(edge.asked[0]?.subjectUserId).toBe(ACTOR.userId);
  });

  it('returns the PAID allowance for a grant carrying `foxy.unlimited`', async () => {
    const edge = captureEdge();
    edge.answer({
      planCode: 'monthly',
      isPaid: true,
      features: ['practice.basic', 'foxy.basic', 'foxy.unlimited'],
      activeUntil: '2026-09-01T09:00:00.000Z',
    });

    await expect(edge.readPlan(ACTOR, ACTOR.userId)).resolves.toBe('plus');
  });

  it('returns the FREE allowance for a grant without it', async () => {
    const edge = captureEdge();

    await expect(edge.readPlan(ACTOR, ACTOR.userId)).resolves.toBe('free');
  });

  it('never resolves `null` — the shape the service had to default', async () => {
    // `PlanReader` permits null ("no answer, assume free"), and the stand-in
    // exploited exactly that. This reader always has an answer, because billing
    // returns the free grant rather than nothing.
    const edge = captureEdge();

    await expect(edge.readPlan(ACTOR, ACTOR.userId)).resolves.not.toBeNull();
  });
});
