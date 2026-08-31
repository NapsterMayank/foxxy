import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  type RevealResponse,
  type AdminActivityResponse,
  type AdminAuditResponse,
  type AdminChatSessionDetailResponse,
  type AdminChatSessionsResponse,
  type AdminContentCoverageResponse,
  type AdminPracticeSessionsResponse,
  type AdminSubscriptionsResponse,
  type AdminTraceResponse,
  type AdminUserDetailResponse,
  type AdminUsersResponse,
  type AdminDryRunResponse,
  type AdminHealthResponse,
  type AdminJobsResponse,
  type AdminMetricsResponse,
  type AdminOverviewResponse,
  type AdminRulesResponse,
  type AdminSignalsResponse,
  type AdminWorkersResponse,
} from '@/shared/contracts/admin.contract';
import type { SessionPreHandler } from '@/shared/http/require-admin';
import { adminSchemas, parseInput } from './admin.schema';
import type { AdminDataService, PageRequest } from './admin.data.service';
import type { AdminService } from './admin.service';
import type { AdminActor } from './admin.types';

/**
 * =============================================================================
 * admin HTTP — every route behind one gate.
 *
 * `ADMIN_PREFIX` is a constant rather than eight literals, and
 * `admin-routes-are-gated.test.ts` walks Fastify's own route table asserting
 * that everything registered under it carries `requireAdmin`. So the gate is
 * not "applied carefully"; it is applied provably, and a ninth route added
 * without it fails the build rather than shipping an open door.
 *
 * Handlers here do exactly what every other module's do: validate, call ONE
 * service method, format. No access decision is made in this file — the gate is
 * a preHandler and the audit is in the service, which is the only arrangement
 * that survives somebody adding a route in a hurry.
 * =============================================================================
 */

const API_PREFIX = '/api/v1';
export const ADMIN_PREFIX = `${API_PREFIX}/admin`;

export interface AdminRoutesDeps {
  readonly service: AdminService;
  readonly data: AdminDataService;
  /**
   * The reveal-specific throttle. Injected as a plain function so this file
   * needs no cache and no limiter construction — see `REVEAL_LIMIT`.
   *
   * @throws RateLimitError when the actor has spent their hourly allowance.
   */
  readonly throttleReveal: (actorUserId: string) => Promise<void>;
  /** The composed gate: session, then `super_admin`, else 404. */
  readonly requireAdmin: SessionPreHandler;
}

/**
 * Reads the actor the gate attached.
 *
 * Throws rather than returning undefined: reaching a handler with no actor
 * means the preHandler was omitted, which is a wiring defect. On THIS surface a
 * silent fallback would be an unauthenticated read of every learner in the
 * product, so the failure is loud by construction.
 */
function requireAdminActor(request: FastifyRequest): AdminActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('admin routes: missing the requireAdmin preHandler');
  }
  return { userId: actor.userId, role: actor.role, tenantId: actor.tenantId };
}

/** limit and cursor, validated. An invalid cursor is a 400, not page one. */
function pageOf(request: FastifyRequest): PageRequest {
  const query = parseInput(adminSchemas.pageQuery, request.query);
  return { limit: query.limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) };
}

/**
 * An optional narrowing by learner, never an authorisation.
 *
 * Absent means every learner, which is what an operations list is for. The
 * filter exists so one learner's sessions can be pulled up without paging; it
 * grants nothing, because the caller already reached a route only a
 * super_admin can reach.
 */
function studentFilter(request: FastifyRequest): string | null {
  const parsed = parseInput(adminSchemas.studentFilter, request.query);
  return parsed.studentUserId ?? null;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const gated = { preHandler: deps.requireAdmin };

  /** Counts, what is firing, and what is not being measured. */
  app.get(`${ADMIN_PREFIX}/overview`, gated, async (request, reply) => {
    const body: AdminOverviewResponse = await deps.service.overview(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /** Every signal's live value beside the range its rules must sit inside. */
  app.get(`${ADMIN_PREFIX}/monitoring/signals`, gated, async (request, reply) => {
    const body: AdminSignalsResponse = await deps.service.signals(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /** The rules themselves — threshold, severity, runbook, delivery order. */
  app.get(`${ADMIN_PREFIX}/monitoring/rules`, gated, async (request, reply) => {
    const body: AdminRulesResponse = await deps.service.rules(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /**
   * A POST on a read-only surface, deliberately.
   *
   * It writes nothing and delivers nothing — see the service. It is a POST
   * because it EXECUTES a collection cycle against the live database and the
   * readiness endpoint, and that cost belongs in the method rather than hidden
   * behind a GET that a browser might prefetch.
   */
  app.post(`${ADMIN_PREFIX}/monitoring/dry-run`, gated, async (request, reply) => {
    const body: AdminDryRunResponse = await deps.service.dryRun(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /** Queue depth by status and kind, dead letters, and the backlog age. */
  app.get(`${ADMIN_PREFIX}/monitoring/jobs`, gated, async (request, reply) => {
    const body: AdminJobsResponse = await deps.service.jobs(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /** Heartbeats, with the same staleness threshold the pager uses. */
  app.get(`${ADMIN_PREFIX}/monitoring/workers`, gated, async (request, reply) => {
    const body: AdminWorkersResponse = await deps.service.workers(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /** Recent `metrics_events`, grouped. The exceptional events, not per-request. */
  app.get(`${ADMIN_PREFIX}/monitoring/metrics`, gated, async (request, reply) => {
    const body: AdminMetricsResponse = await deps.service.metrics(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  /** Readiness as the alert collector sees it — one answer, not a second one. */
  app.get(`${ADMIN_PREFIX}/monitoring/health`, gated, async (request, reply) => {
    const body: AdminHealthResponse = await deps.service.health(requireAdminActor(request));
    return reply.status(200).send(body);
  });

  // ==========================================================================
  // DATA. Every response below is masked in the service; there is no unmasked
  // shape for these routes in the contract at all.
  // ==========================================================================

  app.get(`${ADMIN_PREFIX}/users`, gated, async (request, reply) => {
    const body: AdminUsersResponse = await deps.data.users(
      requireAdminActor(request),
      pageOf(request),
    );
    return reply.status(200).send(body);
  });

  app.get(`${ADMIN_PREFIX}/users/:id`, gated, async (request, reply) => {
    const params = parseInput(adminSchemas.idParam, request.params);
    const body: AdminUserDetailResponse = await deps.data.user(
      requireAdminActor(request),
      params.id,
    );
    return reply.status(200).send(body);
  });

  /** One learner's day, chat and practice together — the D-401 view. */
  app.get(`${ADMIN_PREFIX}/learners/:id/activity`, gated, async (request, reply) => {
    const params = parseInput(adminSchemas.idParam, request.params);
    const body: AdminActivityResponse = await deps.data.activity(
      requireAdminActor(request),
      params.id,
      pageOf(request),
    );
    return reply.status(200).send(body);
  });

  app.get(`${ADMIN_PREFIX}/practice/sessions`, gated, async (request, reply) => {
    const body: AdminPracticeSessionsResponse = await deps.data.practiceSessions(
      requireAdminActor(request),
      pageOf(request),
      studentFilter(request),
    );
    return reply.status(200).send(body);
  });

  app.get(`${ADMIN_PREFIX}/foxy/sessions`, gated, async (request, reply) => {
    const body: AdminChatSessionsResponse = await deps.data.chatSessions(
      requireAdminActor(request),
      pageOf(request),
      studentFilter(request),
    );
    return reply.status(200).send(body);
  });

  /** The transcript's SHAPE. No message text is on this response. */
  app.get(`${ADMIN_PREFIX}/foxy/sessions/:id`, gated, async (request, reply) => {
    const params = parseInput(adminSchemas.idParam, request.params);
    const body: AdminChatSessionDetailResponse = await deps.data.chatSession(
      requireAdminActor(request),
      params.id,
    );
    return reply.status(200).send(body);
  });

  app.get(`${ADMIN_PREFIX}/foxy/traces/:id`, gated, async (request, reply) => {
    const params = parseInput(adminSchemas.idParam, request.params);
    const body: AdminTraceResponse = await deps.data.trace(
      requireAdminActor(request),
      params.id,
    );
    return reply.status(200).send(body);
  });

  /**
   * THE TRACE BEHIND ONE TURN — the link the session screen could not build.
   *
   * A separate route rather than widening `/traces/:id` to accept either kind
   * of id: one parameter meaning two things is resolved by guessing, and the
   * guess turns a typo into an ambiguous 404.
   */
  app.get(`${ADMIN_PREFIX}/foxy/messages/:id/trace`, gated, async (request, reply) => {
    const params = parseInput(adminSchemas.idParam, request.params);
    const body: AdminTraceResponse = await deps.data.traceByMessage(
      requireAdminActor(request),
      params.id,
    );
    return reply.status(200).send(body);
  });

  app.get(`${ADMIN_PREFIX}/billing/subscriptions`, gated, async (request, reply) => {
    const body: AdminSubscriptionsResponse = await deps.data.subscriptions(
      requireAdminActor(request),
      pageOf(request),
    );
    return reply.status(200).send(body);
  });

  /** The record, including this read of it — see the service. */
  app.get(`${ADMIN_PREFIX}/audit`, gated, async (request, reply) => {
    const body: AdminAuditResponse = await deps.data.audit(
      requireAdminActor(request),
      pageOf(request),
    );
    return reply.status(200).send(body);
  });

  app.get(`${ADMIN_PREFIX}/content/coverage`, gated, async (request, reply) => {
    const body: AdminContentCoverageResponse = await deps.data.contentCoverage(
      requireAdminActor(request),
    );
    return reply.status(200).send(body);
  });

  /**
   * THE ONE ROAD TO AN UNMASKED VALUE — D-402.
   *
   * A POST because it is an ACT, not a lookup: it names a reason, it is written
   * down, and it should not be something a browser can prefetch or a link can
   * carry. The body is validated here; the field matrix and the audit row are
   * in the service, where the value actually is.
   */
  app.post(`${ADMIN_PREFIX}/reveal`, gated, async (request, reply) => {
    const actor = requireAdminActor(request);
    // BEFORE the body is parsed and before any row is loaded: a refused reveal
    // must not have read the value it refused to return.
    await deps.throttleReveal(actor.userId);
    const body: RevealResponse = await deps.data.reveal(
      actor,
      parseInput(adminSchemas.reveal, request.body),
    );
    return reply.status(200).send(body);
  });
}
