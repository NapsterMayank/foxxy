import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

export interface CorsOptions {
  /**
   * The READ allow-list — `config.http.corsReadOrigins`, the wider of the two.
   *
   * CORS is the outer gate: it decides whether a browser at this origin may
   * talk to the API at all. Whether it may CHANGE anything is a separate,
   * narrower decision made by `origin-check.ts` against the WRITE list.
   *
   * The methods below therefore still include POST/PATCH/PUT/DELETE for every
   * read origin, and that is correct rather than a leak: passing CORS is not
   * authorisation. A read-only origin's POST is answered by the browser's
   * preflight, reaches `onRequest`, and is refused there with a 403 before the
   * body is parsed. Restricting the METHOD list per origin instead would move a
   * security decision into a header the browser is trusted to honour.
   */
  readonly origins: readonly string[];
}

/**
 * CORS with an explicit allow-list — never a reflected origin and never `*`.
 * `credentials: true` is required because the session lives in an httpOnly
 * cookie, and the browser refuses to send credentials to a wildcard origin.
 */
export async function registerCors(app: FastifyInstance, options: CorsOptions): Promise<void> {
  await app.register(cors, {
    origin: [...options.origins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    /**
     * `x-visit-id` is D-401's correlation header. Without it here the browser's
     * preflight refuses the header and the column silently stays NULL in
     * production while every backend test — which uses `app.inject`, and
     * `app.inject` does not enforce CORS — passes. That is the exact failure
     * shape the SSE note below records; this line is the lesson applied.
     *
     * The client sends it ONLY on requests that already carry a body, so it
     * adds no preflight that `content-type` was not causing anyway.
     */
    allowedHeaders: ['content-type', 'x-request-id', 'x-visit-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });

  /**
   * ==========================================================================
   * THE STREAMING ROUTE NEEDS ITS CORS HEADERS SET ON THE RAW SOCKET.
   *
   * `@fastify/cors` adds them in an `onSend` hook. `foxy`'s message route
   * HIJACKS the reply — it owns the socket so it can push SSE frames — and a
   * hijacked reply never reaches `onSend`. So the product's ONE streaming
   * endpoint went out with no `access-control-allow-origin` while every other
   * route had one, and every browser blocked every Foxy turn.
   *
   * Nothing caught it. `app.inject` does not enforce CORS, curl does not either,
   * and the backend tests are all one or the other. It took driving the real UI
   * against the real API.
   *
   * `reply.raw.setHeader` survives the hijack because Node MERGES headers set
   * this way with the ones passed to `writeHead`. The hook is scoped to the SSE
   * path so no ordinary route gets a second copy of these headers.
   *
   * The allow-list lives HERE and only here — the route must not learn it, or
   * there would be two places that decide which origins may read.
   * ==========================================================================
   */
  const allowed = new Set(options.origins);
  const SSE_PATH = /^\/api\/v\d+\/foxy\/sessions\/[^/]+\/messages$/;

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined || !allowed.has(origin)) return;
    if (!SSE_PATH.test(request.url.split('?')[0] ?? '')) return;

    reply.raw.setHeader('access-control-allow-origin', origin);
    reply.raw.setHeader('access-control-allow-credentials', 'true');
    // Without `vary`, a cache could serve one origin's response to another.
    reply.raw.setHeader('vary', 'Origin');
  });
}
