import Fastify, { type FastifyInstance } from 'fastify';
import { createRateLimiter } from '../platform/rate-limit/index';
import type { Container } from './container';
import { registerHealthRoutes } from './health';
import { registerAuthenticatedRateLimit } from './plugins/authenticated-rate-limit';
import { registerCors } from './plugins/cors';
import { registerErrorHandler } from './plugins/error-handler';
import { registerOriginCheck } from './plugins/origin-check';
import { registerRequestId } from './plugins/request-id';
import { registerRoutes, type Modules } from './routes';

export interface ServerOptions {
  /**
   * The application's modules. Omit them for the bare server — health, the
   * error handler and the request-id hook — which is what the server's own
   * tests exercise.
   *
   * `Partial` so a module's own test harness can register just that module.
   * Production builds this through `buildModules`, whose return type is total,
   * so a real deployment still cannot drop one by omission.
   */
  readonly modules?: Partial<Modules>;
  /**
   * Read by `/health/ready` on every request (04-RESILIENCE-PLAN.md §12,
   * step 1). Passed in rather than owned here because the shutdown controller
   * needs the server in order to drain it, and the server needs the
   * controller's answer — the closure breaks the cycle.
   *
   * Defaults to "not shutting down", which is right for a test that never
   * shuts anything down.
   */
  readonly isShuttingDown?: () => boolean;
}

/**
 * The config value in the shape Fastify's option takes — D-227.
 *
 * A copy rather than the frozen array, because Fastify's type is a mutable
 * `string[]` and handing it a frozen one would be a lie the compiler cannot
 * see. `false` and a hop count pass through unchanged.
 *
 * `true` is not reachable from here by construction: `Config['http']`'s union
 * is `false | readonly string[] | number`, so "believe everyone" is not a value
 * this function can produce. That is the defect closed in the type rather than
 * in a review comment.
 */
function toFastifyTrustProxy(value: false | readonly string[] | number): boolean | string[] | number {
  // Narrowed by TYPE rather than by `Array.isArray`, which widens a readonly
  // tuple to `any[]` and costs the type safety this function exists to keep.
  if (value === false) return false;
  if (typeof value === 'number') return value;
  return [...value];
}

/**
 * Builds the Fastify instance.
 *
 * Session validation is NOT registered here as a global plugin. It belongs to
 * the identity module, which owns it, and is attached per-route as a
 * preHandler — so a route is authenticated because someone wrote it down, not
 * because it happened to sit under a prefix where a hook was installed.
 *
 * Fastify's own logger is disabled: logging goes through `platform/logger`,
 * which is where redaction is configured. Two loggers means one of them is
 * not redacting.
 */
export async function createServer(
  container: Container,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    /**
     * WHOSE `X-Forwarded-For` WE BELIEVE — D-227.
     *
     * =======================================================================
     * THIS WAS `true`, AND `true` MEANS "BELIEVE ANY CLIENT".
     *
     * `request.ip` is what every IP-keyed rate limit is hashed from — signup
     * 3/h, login 5/15min, forgot-password 3/h — via `hashIp`. With
     * `trustProxy: true` Fastify takes the leftmost address of a header the
     * CLIENT supplies, so a caller that sends a different forged
     * `X-Forwarded-For` on every request lands in a different bucket on every
     * request. All three limits collapse to no limit at all, and there is no
     * error, no log line and no metric: the limiter is still installed, still
     * counting, and counting a fresh key each time. That is the ninth instance
     * of this codebase's recurring shape — enforcement that looks present and
     * enforces nothing.
     *
     * =======================================================================
     * THE DEFAULT IS NOW "TRUST NOBODY", AND THAT IS THE SAFE WRONG ANSWER.
     *
     * `config.http.trustProxy` is `false` unless an operator has configured
     * `TRUSTED_PROXY_CIDRS` or `TRUSTED_PROXY_HOPS`. Unconfigured behind a
     * proxy, every request keys on the proxy's socket address, so the whole
     * fleet shares one bucket and the limits are too STRICT. That is a visible,
     * complainable failure. Trusting a forged header is an invisible one, and
     * between a default that over-blocks and a default that silently stops
     * blocking, only one of them gets noticed.
     */
    trustProxy: toFastifyTrustProxy(container.config.http.trustProxy),
    bodyLimit: 1_048_576, // 1 MiB
    // §12: a request arriving mid-drain is answered 503 rather than accepted
    // into a server that is closing. This is Fastify's default; it is stated
    // explicitly because graceful shutdown depends on it and a future options
    // change that flipped it would break the drain silently.
    return503OnClosing: true,
  });

  registerRequestId(app, { idGen: container.idGen, logger: container.logger });
  registerErrorHandler(app);
  // THE READ LIST. CORS is the outer gate: may this browser talk to us at all.
  await registerCors(app, { origins: container.config.http.corsReadOrigins });

  // §6.10, CSRF row: `sameSite=lax` PLUS an origin check on state-changing
  // requests — and THE WRITE LIST, which is the narrower one (open item 1). A
  // partner origin added for a read-only integration lands in the read list
  // only, so it can GET and cannot POST. `APP_URL` is included because the
  // browser application must be able to post to its own API even if somebody
  // trims the allow-list; both come from config, never from code.
  registerOriginCheck(app, {
    origins: [...container.config.http.corsWriteOrigins, container.config.urls.app],
  });

  /**
   * THE GLOBAL AUTHENTICATED THROTTLE — §6.9, last row.
   *
   * BEFORE any route is registered, and that ordering is load-bearing: the
   * plugin works by appending itself to each route's `preHandler` chain through
   * an `onRoute` hook, and `onRoute` only fires for routes added AFTER it. A
   * route registered above this line would silently be unthrottled.
   *
   * Health routes get it too and are unaffected — they carry no actor, so the
   * hook returns immediately.
   */
  registerAuthenticatedRateLimit(app, {
    limiter: createRateLimiter({
      cache: container.cache,
      clock: container.clock,
      logger: container.logger,
      metrics: {
        increment: (metric: string, tags?: Readonly<Record<string, string>>): void => {
          container.metrics.counter(metric, 1, tags);
        },
      },
      // A DISTINCT metric name from identity's. "Authentication has degraded to
      // a per-instance limiter" and "the global backstop has" are different
      // pages in a runbook, and one name for both makes the alert unactionable.
      fallbackMetric: 'app.authenticated_rate_limit.in_process_fallback',
    }),
  });

  registerHealthRoutes(app, {
    env: container.config.env,
    now: () => container.clock.now(),
    checkDatabase: () => container.databaseProbe.check(),
    // D-230 — readiness covers the cache too. Without it a replica whose
    // Valkey is gone stays in rotation answering logins on a per-instance
    // rate-limit fallback that admits N x the configured limit.
    checkCache: () => container.cacheProbe.check(),
    breakers: () => container.resilience.snapshots(),
    // §5 — the counters behind the breaker states. Read from the live process's
    // memory, never from `metrics_events`: this endpoint has to be answerable
    // when the database is the thing that is broken.
    metrics: () => container.metricsSnapshot(),
    isShuttingDown: options.isShuttingDown ?? ((): boolean => false),
  });

  if (options.modules !== undefined) {
    await registerRoutes(app, options.modules);
  }

  return app;
}
