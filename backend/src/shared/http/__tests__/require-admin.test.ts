import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@/platform/errors/index';
import { PLATFORM_ROLES } from '@/shared/constants/roles';
import { createRequireAdmin } from '../require-admin';

/**
 * =============================================================================
 * THE ADMIN GATE. Three properties, and the third is the one that decays.
 *
 *  1. `super_admin` passes.
 *  2. EVERY other role is refused — asserted over `PLATFORM_ROLES` rather than
 *     over a list written here, so a role added in Phase 1 or Phase 4 is denied
 *     by default and this test starts covering it the day it is declared. A
 *     hand-written list would have to be remembered, and D-075 is the record of
 *     what happens to lists that have to be remembered.
 *  3. THE REFUSAL IS A 404 AND CARRIES NOTHING. The tempting future edit is
 *     "make the error say why, it was confusing to debug" — which converts the
 *     gate back into a 403 wearing a 404's status code, because the body then
 *     confirms the route exists. Pinned here so that edit fails a test instead
 *     of shipping.
 * =============================================================================
 */

function requestWith(role: string | undefined): FastifyRequest {
  return {
    actor:
      role === undefined
        ? undefined
        : { userId: '11111111-1111-4111-8111-111111111111', role, tenantId: 'tenant' },
  } as unknown as FastifyRequest;
}

const REPLY = {} as FastifyReply;

/** A session validator that succeeds and attaches nothing further. */
const passingSession = vi.fn(async () => {
  /* the actor is already on the request in these tests */
});

describe('createRequireAdmin', () => {
  it('lets a super_admin through', async () => {
    const requireAdmin = createRequireAdmin({ requireSession: passingSession });
    await expect(requireAdmin(requestWith('super_admin'), REPLY)).resolves.toBeUndefined();
  });

  it.each(PLATFORM_ROLES.filter((role) => role !== 'super_admin'))(
    'refuses %s',
    async (role) => {
      const requireAdmin = createRequireAdmin({ requireSession: passingSession });
      await expect(requireAdmin(requestWith(role), REPLY)).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it('refuses a request with no actor at all', async () => {
    // Reachable when a session validator resolves without attaching one. It is
    // a wiring defect rather than a caller condition, and it must still be a
    // deny — a gate that falls open when its input is missing is not a gate.
    const requireAdmin = createRequireAdmin({ requireSession: passingSession });
    await expect(requireAdmin(requestWith(undefined), REPLY)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses with a 404 whose message discloses nothing', async () => {
    const requireAdmin = createRequireAdmin({ requireSession: passingSession });
    const error = await requireAdmin(requestWith('student'), REPLY).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(NotFoundError);
    const notFound = error as NotFoundError;
    expect(notFound.httpStatus).toBe(404);
    // The SAFE message is what the caller receives. It must not name the role,
    // the requirement, or the word admin.
    expect(notFound.safeMessage).toBe('Not found.');
    expect(notFound.safeMessage.toLowerCase()).not.toContain('admin');
    expect(notFound.safeMessage.toLowerCase()).not.toContain('role');
    // The LOG message is where the detail belongs, and it should still have it.
    expect(notFound.message).toContain('student');
  });

  it('runs the session check first and lets its rejection through untouched', async () => {
    // `requireSession` clears the session cookie on rejection. Swallowing that
    // and answering 404 instead would leave a browser retrying a dead token for
    // ever, so the 401 must survive this gate rather than be flattened into it.
    const sessionFailure = new Error('session rejected');
    const failingSession = vi.fn(() => Promise.reject(sessionFailure));
    const requireAdmin = createRequireAdmin({ requireSession: failingSession });

    await expect(requireAdmin(requestWith('super_admin'), REPLY)).rejects.toBe(sessionFailure);
    expect(failingSession).toHaveBeenCalledTimes(1);
  });
});
