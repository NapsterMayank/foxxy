import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  MasteryResponse,
  OnboardingResponse,
  ProfileResponse,
  StudentProfile,
} from '@/shared/contracts/learner.contract';
import { learnerSchemas, parseInput } from './learner.schema';
import type { LearnerService } from './learner.service';
import type {
  ChapterMasteryRecord,
  LearnerActor,
  StudentProfileRecord,
} from './learner.types';

/**
 * HTTP only — §2, layer table.
 *
 * Every handler does three things: validate the input, call ONE service
 * method, format the result. There is no `if` about a business rule in this
 * file and no database access, and the access checks are all in the service —
 * a route that decided access would be a second place access is decided, which
 * is the one thing §7 exists to prevent.
 *
 * All four endpoints are `/me/…`. The student id comes from the SESSION, never
 * from the path or the body, so there is no identifier a caller could change
 * to reach someone else's data. The service still calls `assertCanAccess` on
 * every one of them; belt and braces is correct here, because the day someone
 * adds `/students/:id/profile` the guard is already in the right place.
 */

const API_PREFIX = '/api/v1';

function toStudentProfile(profile: StudentProfileRecord): StudentProfile {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    grade: profile.grade,
    board: profile.board,
    preferredLanguage: profile.preferredLanguage,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function toMastery(record: ChapterMasteryRecord): MasteryResponse['mastery'][number] {
  return {
    chapterId: record.chapterId,
    masteryScore: record.masteryScore,
    attempts: record.attempts,
    lastPractisedAt: record.lastPractisedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Reads the actor the session preHandler attached.
 *
 * Throws rather than returning undefined: reaching a handler with no actor
 * means the preHandler was omitted, which is a wiring bug that must fail
 * loudly rather than quietly degrade into an unauthenticated read.
 */
function requireActor(request: FastifyRequest): LearnerActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('learner routes: missing the requireSession preHandler');
  }
  return actor;
}

export interface LearnerRoutesDeps {
  readonly service: LearnerService;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export function registerLearnerRoutes(app: FastifyInstance, deps: LearnerRoutesDeps): void {
  const authenticated = { preHandler: deps.requireSession };

  /** §8.2 — the caller's own profile. */
  app.get(`${API_PREFIX}/me/profile`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const profile = await deps.service.getProfile(actor, actor.userId);
    const body: ProfileResponse = { profile: toStudentProfile(profile) };
    return reply.status(200).send(body);
  });

  /** §8.2 — a partial update. At least one field, enforced by the schema. */
  app.patch(`${API_PREFIX}/me/profile`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const input = parseInput(learnerSchemas.updateProfile, request.body);
    const profile = await deps.service.updateProfile(actor, actor.userId, input);
    const body: ProfileResponse = { profile: toStudentProfile(profile) };
    return reply.status(200).send(body);
  });

  /**
   * §8.2 — onboarding. IDEMPOTENT, and always 200.
   *
   * NOT 201-then-200: the status code does not vary with whether the profile
   * already existed. A client retrying after a dropped connection cannot tell
   * which of its two attempts arrived, so a status that differs between them
   * is a difference it can only misread. `created` in the body carries that
   * information for the client that genuinely wants it.
   */
  app.post(`${API_PREFIX}/me/onboarding`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const input = parseInput(learnerSchemas.onboarding, request.body);
    const result = await deps.service.createProfile(actor, input);
    const body: OnboardingResponse = {
      profile: toStudentProfile(result.profile),
      subjects: [...result.subjects],
      created: result.created,
    };
    return reply.status(200).send(body);
  });

  /** §8.2 — mastery per chapter, for the progress screen. */
  app.get(`${API_PREFIX}/me/mastery`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const mastery = await deps.service.getMastery(actor, actor.userId);
    const body: MasteryResponse = { mastery: mastery.map(toMastery) };
    return reply.status(200).send(body);
  });
}
