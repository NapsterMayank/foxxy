import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  ListNotificationsResponse,
  MarkAllReadResponse,
  MarkReadResponse,
  Notification,
  UnreadCountResponse,
} from '@/shared/contracts/notify.contract';
import { requireActor as requireRequestActor } from '@/shared/http/require-actor';
import { notifySchemas, parseInput } from './notify.schema';
import type { NotifyService } from './notify.service';
import type { NotificationRecord, NotifyActor } from './notify.types';

/**
 * HTTP only — §2, layer table.
 *
 * Every handler does three things: validate the input, call ONE service method,
 * format the result. There is no `if` about a business rule in this file and no
 * database access, and the access checks are all in the service — a route that
 * decided access would be a second place access is decided, which is the one
 * thing §7 exists to prevent.
 *
 * ===========================================================================
 * THERE IS NO ENDPOINT FOR `send`, AND THERE MUST NOT BE.
 *
 * §8.9's public interface has five members and only four of them are reachable
 * over HTTP. `send` is a system call — `billing` on a failed charge, `identity`
 * on a link request, the worker on a digest — and a route for it would let any
 * authenticated caller write into anybody's inbox with arbitrary text. The
 * absence is the design; see the long note in `notify.service.ts`.
 *
 * ===========================================================================
 * EVERY ROUTE IS SCOPED TO THE CALLER BY CONSTRUCTION.
 *
 * The recipient comes from the SESSION, never from the path or the body. Only
 * `POST /:id/read` carries an identifier, and its owner is read from the row
 * before anything else happens. So there is no field a caller could change to
 * reach someone else's notifications — and the service still calls
 * `assertCanAccess` on all four, because the day somebody adds an admin view
 * the guard is already in the right place.
 */

const API_PREFIX = '/api/v1';

function toNotification(record: NotificationRecord): Notification {
  return {
    id: record.id,
    kind: record.kind,
    // BOTH LANGUAGES on the wire. The client picks; the server does not decide
    // for it — a row read after a language change must render in the new one.
    title: { en: record.title.en, hi: record.title.hi },
    body: { en: record.body.en, hi: record.body.hi },
    data: record.data,
    readAt: record.readAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Reads the actor the session preHandler attached — D-263.
 *
 * The body used to be a fourth copy of a function that also existed in `parent`,
 * `billing` and `foxy`, differing only in the module name in the error string.
 * It now binds `shared/http`'s single implementation; the local name and the
 * `NotifyActor` return type are kept so every call site below reads unchanged
 * and so this module still states its own actor type at its own boundary.
 */
function requireActor(request: FastifyRequest): NotifyActor {
  return requireRequestActor(request, 'notify');
}

export interface NotifyRoutesDeps {
  readonly service: NotifyService;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export function registerNotifyRoutes(app: FastifyInstance, deps: NotifyRoutesDeps): void {
  const authenticated = { preHandler: deps.requireSession };

  /** §8.9 — the caller's notifications, newest first, keyset-paginated. */
  app.get(`${API_PREFIX}/notifications`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const query = parseInput(notifySchemas.listQuery, request.query);

    /**
     * THE CURSOR IS REBUILT AS A PAIR OR NOT AT ALL — D-259.
     *
     * `listNotificationsQuerySchema` has already refused a request carrying only
     * one half, so `beforeId` is present exactly when `before` is. Testing both
     * here is what makes that a fact the compiler can see rather than one this
     * file is trusting the schema for.
     */
    const before =
      query.before === undefined || query.beforeId === undefined
        ? undefined
        : { createdAt: new Date(query.before), id: query.beforeId };

    const result = await deps.service.listForUser(actor, {
      limit: query.limit,
      before,
    });

    const body: ListNotificationsResponse = {
      // Both halves, or two nulls. They are one value and the schema forbids a
      // client sending back half of it.
      notifications: result.notifications.map(toNotification),
      nextBefore: result.nextCursor?.createdAt.toISOString() ?? null,
      nextBeforeId: result.nextCursor?.id ?? null,
      unreadCount: result.unreadCount,
    };
    return reply.status(200).send(body);
  });

  /** §8.9 — the unread badge. A count over a partial index, nothing more. */
  app.get(`${API_PREFIX}/notifications/unread-count`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const body: UnreadCountResponse = { unreadCount: await deps.service.getUnreadCount(actor) };
    return reply.status(200).send(body);
  });

  /**
   * §8.9 — mark one read. IDEMPOTENT, and always 200.
   *
   * Not 204-then-409 for a second call: a client that taps twice, or replays
   * after a dropped connection, has done nothing wrong. `changed` carries the
   * distinction for whoever wants it.
   */
  app.post(`${API_PREFIX}/notifications/:id/read`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const params = parseInput(notifySchemas.idParam, request.params);

    const result = await deps.service.markRead(actor, params.id);
    const body: MarkReadResponse = { changed: result.changed, unreadCount: result.unreadCount };
    return reply.status(200).send(body);
  });

  /** §8.9 — clear the badge. Also idempotent; `marked` is 0 on a repeat. */
  app.post(`${API_PREFIX}/notifications/read-all`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const result = await deps.service.markAllRead(actor);
    const body: MarkAllReadResponse = { marked: result.marked, unreadCount: result.unreadCount };
    return reply.status(200).send(body);
  });
}
