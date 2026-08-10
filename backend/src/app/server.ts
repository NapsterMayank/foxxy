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
    trustProxy: true,
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
