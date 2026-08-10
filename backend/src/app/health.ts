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

/** Structural. `app/` may not import `platform/db`, so it is described, not imported. */
export interface DatabaseHealthReport {
  readonly reachable: boolean;
  readonly migrationsApplied: boolean;
  readonly latencyMs: number;
  readonly error: string | undefined;
  readonly pools: readonly {
    readonly name: string;
    readonly max: number;
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
  }[];
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
   * READINESS. Database reachable, migrations applied, config loaded.
   *
   * 503 while shutting down, before anything else is checked — during a drain
   * the process is perfectly healthy and must still stop receiving traffic.
   */
  app.get('/health/ready', async (_request, reply: FastifyReply) => {
    if (deps.isShuttingDown()) {
      return reply.status(503).send({
        status: 'shutting_down',
        checks: { shutdown: false },
      });
    }

    const database = await deps.checkDatabase();
    const checks = {
      database: database.reachable,
      migrations: database.migrationsApplied,
      // Reaching this line proves it: `platform/config` validates at import
      // and exits the process on failure, so a running server has a valid
      // config by construction. Reported anyway — an operator reading a
      // readiness body should not have to know that.
      config: true,
    };
    const ready = Object.values(checks).every(Boolean);

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
      database: {
        latencyMs: database.latencyMs,
        ...(database.error === undefined ? {} : { error: database.error }),
      },
    });
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
    const database = await deps.checkDatabase();
    return {
      status: 'ok',
      time: deps.now().toISOString(),
      shuttingDown: deps.isShuttingDown(),
      database: {
        reachable: database.reachable,
        migrationsApplied: database.migrationsApplied,
        latencyMs: database.latencyMs,
        ...(database.error === undefined ? {} : { error: database.error }),
        pools: database.pools,
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
