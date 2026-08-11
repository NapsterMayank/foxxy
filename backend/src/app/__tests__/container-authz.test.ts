import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { ForbiddenError } from '@/platform/errors/index';
import type { Actor } from '@/platform/authz/index';
import { UNWIRED_LINK_READER, createContainer, type Container } from '../container';

/**
 * =============================================================================
 * `container.authz` IS THE CONTENT-ONLY GUARD, AND IT SAYS SO — D-324.
 *
 * WHAT WAS WRONG. The composition root built it as
 *
 *     // The link reader is wired to the identity repository in build step 4.
 *     const authz = createAccessGuard({ readLinkStatus: () => null });
 *
 * Build step 4 shipped. The line did not change. That is the same shape as
 * D-257's `readPlan: () => null`, one file over, and it was harmless ONLY BY
 * ACCIDENT: every module builds its own per-call guard from its own async link
 * edge, and the single consumer of this member asks about `{ kind: 'content' }`
 * — the one resource kind whose rules never consult a link.
 *
 * But it is a PUBLIC MEMBER OF `Container`, TYPED `AccessGuard`. The next
 * caller to reach for it instead of building their own would have received a
 * boundary that denies EVERY APPROVED PARENT, with no error, no log line and
 * nothing that looks different from a correct refusal.
 *
 * -----------------------------------------------------------------------------
 * WHY IT THROWS RATHER THAN BEING REMOVED OR "WIRED PROPERLY".
 *
 * It cannot be wired properly HERE. `LinkStatusReader` is SYNCHRONOUS and every
 * real link status is a database read; no module is constructed in the
 * composition root, so there is nothing to read it with. A correct reader is
 * not merely missing at this seam, it is not expressible at it.
 *
 * So the reader now throws a NAMED error. Both postures are fail-closed; only
 * one of them can be told apart from a genuine authorisation decision.
 * =============================================================================
 */

let container: Container | undefined;

function makeContainer(): Container {
  const clock = new FixedClock('2026-06-01T09:00:00.000Z');
  container = createContainer(
    parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5433/unused',
      REDIS_URL: 'redis://localhost:6379',
      CORS_READ_ORIGINS: 'http://localhost:3000',
      CORS_WRITE_ORIGINS: 'http://localhost:3000',
      SESSION_COOKIE_NAME: 'foxxy_session',
      APP_URL: 'http://app.test',
      API_URL: 'http://api.test',
    }),
    { clock, cache: new MemoryCache(clock), mail: new RecordingMail(), logger: new FakeLogger() },
  );
  return container;
}

afterEach(async () => {
  await container?.shutdown();
  container = undefined;
});

const TENANT = '22222222-2222-4222-8222-222222222222';
const PARENT: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'parent',
  tenantId: TENANT,
};
const CHILD_ID = '33333333-3333-4333-8333-333333333333';

describe('container.authz', () => {
  it('still decides the ONE resource kind it is for', () => {
    // Curriculum: no tenant, no owner, no link. This is the member's only
    // honest use and the only thing that may keep working.
    const built = makeContainer();
    expect(() => {
      built.authz.assertCanAccess(PARENT, 'read', { kind: 'content' });
    }).not.toThrow();
  });

  it('REFUSES LOUDLY on a parent-child question instead of silently denying', () => {
    /**
     * THE ASSERTION THAT PINS THE FIX. Before it, this call returned a clean
     * `ForbiddenError` — indistinguishable from "this parent has no approved
     * link" — for a parent who might be perfectly approved. The wording is
     * asserted rather than merely "it threw", because the wording is the whole
     * value: it names the seam and says what to do instead.
     */
    const built = makeContainer();
    const ask = (): void => {
      built.authz.assertCanAccess(PARENT, 'read', {
        kind: 'student-data',
        studentUserId: CHILD_ID,
        scope: 'profile',
        tenantId: TENANT,
      });
    };

    expect(ask).toThrow(UNWIRED_LINK_READER);
    // And specifically NOT the shape a real denial takes — that is the
    // confusion the old `() => null` created.
    expect(ask).not.toThrow(ForbiddenError);
  });

  it('leaves every deny that does NOT need a link exactly as it was', () => {
    // The link reader is unreachable for these, so the refusals below are real
    // authorisation decisions and must stay `ForbiddenError`. If throwing had
    // leaked into them, the guard would have turned genuine 403s into 500s.
    const built = makeContainer();
    const student: Actor = {
      userId: '44444444-4444-4444-8444-444444444444',
      role: 'student',
      tenantId: TENANT,
    };

    // A student reaching for ANOTHER student: denied before any link is read.
    expect(() => {
      built.authz.assertCanAccess(student, 'read', {
        kind: 'student-data',
        studentUserId: CHILD_ID,
        scope: 'profile',
        tenantId: TENANT,
      });
    }).toThrow(ForbiddenError);

    // A parent WRITING to a child: parent access is read-only, decided above
    // the link read.
    expect(() => {
      built.authz.assertCanAccess(PARENT, 'write', {
        kind: 'student-data',
        studentUserId: CHILD_ID,
        scope: 'profile',
        tenantId: TENANT,
      });
    }).toThrow(ForbiddenError);

    // A tenant mismatch: refused before every allow rule (§7).
    expect(() => {
      built.authz.assertCanAccess(PARENT, 'read', {
        kind: 'student-data',
        studentUserId: CHILD_ID,
        scope: 'profile',
        tenantId: '55555555-5555-4555-8555-555555555555',
      });
    }).toThrow(ForbiddenError);
  });
});
