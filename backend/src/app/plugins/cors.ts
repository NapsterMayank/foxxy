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
    allowedHeaders: ['content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
}
