import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Three health endpoints, three different questions — 04-RESILIENCE-PLAN.md §8.
 *
 * | endpoint        | question                    | on failure                  |
 * |-----------------|-----------------------------|-----------------------------|
 * | `/health/live`  | is the process alive?       | orchestrator RESTARTS it    |
 * | `/health/ready` | should it receive traffic?  | load balancer STOPS ROUTING |
 * | `/health/deps`  | what is the state of things?| nothing. observability only |
 *
 * THE TRAP, stated plainly because getting it backwards is a self-inflicted
 * outage: **liveness must never touch an external system.** If `/health/live`
 * checked the database, a ten-second database blip would fail liveness on
 * every instance simultaneously, the orchestrator would restart all of them at
 * once, and the ten-second blip becomes a multi-minute outage in which the
 * database — now facing a fleet of cold processes all reconnecting — may not
 * recover at all.
 *
 * Readiness is the opposite: it SHOULD check the database, because an
 * instance that cannot reach it should stop receiving traffic. It just must
 * not be restarted for it. Those two behaviours are why there are two
 * endpoints and not one.
 *
 * `/health/deps` is never used for routing. The moment an orchestrator is
 * pointed at it, an LLM provider's bad afternoon starts restarting the
 * application.
 */

/**
 * Structural. `app/` may not import `platform/db`, so it is described, not
 * imported.
 *
 * `error: string | undefined` USED TO BE HERE and used to be rendered verbatim
 * into both `/health/ready` and `/health/deps` — see D-229 and the header of
 * `platform/db/health.ts`. It carried the host, the port and the database
 * username to any unauthenticated caller the moment the database went down. It
 * is replaced by a closed classification which cannot grow a hostname because
 * it is not a string.
 */
export type DependencyFailure = 'unreachable' | 'timeout' | 'schema_incomplete';

export interface DatabaseHealthReport {
  readonly reachable: boolean;
  readonly migrationsApplied: boolean;
  readonly latencyMs: number;
  readonly failure: DependencyFailure | null;
  readonly pools: readonly {
    readonly name: string;
    readonly max: number;
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
  }[];
}

/**
 * THE CACHE HALF OF READINESS — D-230.
 *
 * `/health/ready` checked the database and NOT the cache, and the cache is
 * where every rate-limit counter lives. A replica whose Valkey connection is
 * gone stayed in the load balancer's rotation serving requests on the
 * in-process fallback — which is per-instance, resets on restart, and admits N
 * times the configured limit across N replicas. The limiter's own header calls
 * that "a silent security downgrade"; readiness is what makes it not silent,
 * because it takes the degraded instance out of rotation instead of leaving it
 * to answer login attempts.
 */
export interface CacheHealthReport {
  readonly reachable: boolean;
  readonly latencyMs: number;
  readonly failure: DependencyFailure | null;
}

export interface BreakerReport {
  readonly name: string;
  readonly state: string;
  readonly recentFailures: number;
  readonly failureRate: number;
  readonly retryAt: Date | null;
}

/**
 * One metric series, flattened for the response.
 *
 * Structural, like `DatabaseHealthReport` above: `app/` describes what it needs
 * rather than importing `platform/metrics`, so the endpoint's response shape is
 * visible in this file instead of being inherited from a port.
 */
export interface MetricReport {
  readonly name: string;
  readonly kind: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly count: number;
  readonly value: number;
  readonly lastAt: string;
}

export interface HealthDeps {
  readonly env: string;
  readonly now: () => Date;
  readonly checkDatabase: () => Promise<DatabaseHealthReport>;
  /**
   * §8 — readiness must cover the cache too. See `CacheHealthReport`.
   *
   * Required, not optional. An optional readiness dependency is one that a
   * future call site omits by accident, and the omission looks exactly like a
   * healthy system.
   */
  readonly checkCache: () => Promise<CacheHealthReport>;
  readonly breakers: () => readonly BreakerReport[];
  /**
   * THE LIVE PROCESS'S OWN COUNTERS — 04-RESILIENCE-PLAN.md §5.
   *
   * Read from memory, never from `metrics_events`. The whole purpose of this
   * endpoint is to be answerable when things are broken, and the most common
   * breakage is the database — an endpoint that queried a table to report that
   * the database is unreachable would be unavailable exactly when it is needed.
   *
   * Optional so that a test asserting readiness behaviour is not obliged to
   * build a metrics port to do it.
   */
  readonly metrics?: () => readonly MetricReport[];
  /**
   * True from the moment SIGTERM arrives. §12, step 1: readiness must go 503
   * IMMEDIATELY, before the drain starts, so the load balancer stops sending
   * new work while in-flight requests finish.
   */
  readonly isShuttingDown: () => boolean;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  /**
   * LIVENESS. Touches nothing external — no database, no cache, no breaker.
   *
   * Reaching this handler at all is the proof: the event loop is turning and
   * the HTTP server is answering. There is nothing else worth asking, and
   * everything else worth asking belongs to readiness.
   */
  app.get('/health/live', () => {
    return { status: 'ok', env: deps.env, time: deps.now().toISOString() };
  });

  /**
   * READINESS. Database reachable, FULLY migrated, and the cache reachable.
   *
   * "Fully migrated" is D-231: this used to accept any single row in
   * `__drizzle_migrations`, so a half-applied deploy reported ready and traffic
   * was routed into a schema missing four modules' tables. The cache check is
   * D-230: without it, an instance whose Valkey is gone stayed in rotation
   * serving logins on a per-instance rate-limit fallback.
   *
   * 503 while shutting down, before anything else is checked — during a drain
   * the process is perfectly healthy and must still stop receiving traffic.
   */
  app.get('/health/ready', async (_request, reply: FastifyReply) => {
    if (deps.isShuttingDown()) {
      return reply.status(503).send({ status: 'shutting_down' });
    }

    /**
     * CONCURRENT, and both are awaited before either is judged.
     *
     * Sequencing them would make a readiness probe cost the sum of two
     * deadlines while a load balancer holds the connection open, and the
     * database probe already has its own deadline. `allSettled` is not needed:
     * neither check rejects — each returns its own failure classification —
     * which is a property of those two functions and is why this can be a
     * plain `all`.
     */
    const [database, cache] = await Promise.all([deps.checkDatabase(), deps.checkCache()]);

    const ready =
      database.reachable && database.migrationsApplied && cache.reachable;

    /**
     * A STATUS AND NOTHING ELSE — D-229.
     *
     * This body used to carry a `checks` map and a `database` object with the
     * raw pg error in it. Readiness is consumed by a load balancer, which reads
     * the STATUS CODE and nothing else; the body was for humans, and the humans
     * it reached included anyone who could open a socket to the service. Every
     * detail an operator needs is on `/health/deps`, which is the endpoint that
     * exists for that question — and even there it is a classification, never a
     * vendor message.
     */
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

  /**
   * DEPENDENCIES. Everything, plus circuit-breaker state. Always 200.
   *
   * Always 200 on purpose: this endpoint reports that something is broken. If
   * it returned a failure status, somebody would eventually wire a probe to
   * it, and a degraded dependency would start restarting healthy processes —
   * the precise mistake §8 is written to prevent.
   */
  app.get('/health/deps', async () => {
    const [database, cache] = await Promise.all([deps.checkDatabase(), deps.checkCache()]);
    return {
      status: 'ok',
      time: deps.now().toISOString(),
      shuttingDown: deps.isShuttingDown(),
      /**
       * WHICH dependency is unhealthy, never WHY in vendor terms — D-229.
       *
       * `failure` is a closed union: 'unreachable' | 'timeout' |
       * 'schema_incomplete'. That is enough to route an operator to the right
       * runbook page and carries no host, no port, no username and no private
       * address. The vendor detail belongs in the process's own logs, which
       * are authenticated; this endpoint is not.
       */
      database: {
        reachable: database.reachable,
        migrationsApplied: database.migrationsApplied,
        latencyMs: database.latencyMs,
        failure: database.failure,
        pools: database.pools,
      },
      cache: {
        reachable: cache.reachable,
        latencyMs: cache.latencyMs,
        failure: cache.failure,
      },
      breakers: deps.breakers().map((breaker) => ({
        name: breaker.name,
        state: breaker.state,
        recentFailures: breaker.recentFailures,
        failureRate: Number(breaker.failureRate.toFixed(3)),
        retryAt: breaker.retryAt?.toISOString() ?? null,
      })),
      /**
       * §5's other half. The breaker block above says what state each
       * dependency is in RIGHT NOW; this says what has been happening — how
       * many times a breaker has tripped, how many calls were refused without
       * a network attempt, how many rate-limit fallbacks have fired.
       *
       * A breaker that is closed at the moment you look, having opened eleven
       * times in the last hour, is indistinguishable from a healthy one without
       * these counters. That is the "silent outage" §5 names.
       *
       * NO PII: every tag has already been through `platform/pii`, and this
       * endpoint is reachable by anything that can reach the service.
       */
      metrics: deps.metrics?.() ?? [],
    };
  });

  /**
   * DEPRECATED alias for `/health/live`.
   *
   * Kept because something is always pointed at `/health` — a compose file, a
   * dashboard, an uptime monitor — and removing it in the same change that
   * introduces the replacement means the outage is caused by the fix. It
   * aliases LIVENESS, never readiness: anything currently probing `/health`
   * is doing so as a liveness check, and silently upgrading it to one that
   * touches the database would introduce the exact trap §8 warns about.
   */
  app.get('/health', () => {
    return { status: 'ok', env: deps.env, time: deps.now().toISOString() };
  });
}
