import { createContainer } from './app/container';
import { buildModules } from './app/routes';
import { config } from './platform/config/index';
import { createWorker } from './worker/worker';

/**
 * The WORKER process entry point — 04-RESILIENCE-PLAN.md §3.2.
 *
 * ===========================================================================
 * A SECOND ENTRY POINT, NOT A SECOND CODEBASE.
 *
 * It shares `platform/` and the composition root with `src/main.ts`, so it gets
 * the same validated config, the same pools, the same logger, the same clock
 * and the same metrics. What it does not get is a listener: this process serves
 * no HTTP, holds no request state, and answers no probe.
 *
 * That is what makes §3.2's promise true — "if it dies, jobs pause and resume.
 * USERS SEE NOTHING" — and it is only true because the job state lives in the
 * database rather than in the process.
 *
 * Run it with `npm run worker`. It is a SEPARATE deployment unit from the API,
 * scaled separately, and it must not be started inside the API container "just
 * for now": doing that puts the digest queries back in the same process as
 * request handling and quietly gives up the isolation.
 *
 * ===========================================================================
 * IT USES THE `worker` POOL. SIX CONNECTIONS (§3.1).
 *
 * Reached as `container.pools.worker` rather than through `poolFor(module)`,
 * because the worker is not a module and never should be one — `poolFor` takes
 * a `ModuleName`, and adding 'worker' to that union would let a MODULE ask for
 * the worker pool, which is precisely the mix-up §3.1 exists to prevent.
 *
 * ===========================================================================
 * THE SHUTDOWN PATH IS §12 STEPS 3-5, AND IT IS SHORTER THAN THE API'S.
 *
 * There is no readiness flag to flip and no HTTP drain, because there is no
 * load balancer routing to this process. What replaces them is the heartbeat
 * row moving to `stopped`, done inside `worker.stop()` before the pool closes.
 *
 * SIGTERM AND SIGINT ARE BOTH HANDLED, and the handler is IDEMPOTENT — an
 * orchestrator that sends SIGTERM twice, or SIGTERM then SIGINT, must not start
 * two drains. `runner.stop()` guarantees that; this file guarantees it does not
 * call `exit` twice.
 */
async function main(): Promise<void> {
  /**
   * `role: 'worker'` — D-228, and it is not decoration.
   *
   * Both entry points call `createContainer`, and before the role existed both
   * built all four pools at full size: 44 connections each, so 88 of a default
   * `max_connections=100` with a single replica of each, and 132 during a
   * rolling api deploy. Crossing that limit is not one slow module — it is
   * every checkout in every pool failing at once, plus a `psql` that cannot
   * connect to diagnose it.
   *
   * A worker serves no login and holds no sessions, so `auth` and `core` are
   * trimmed to what a background sweep needs. Stated here rather than inferred,
   * because the default is `'api'` and an api mis-trimmed to two auth
   * connections would throttle login.
   */
  const container = createContainer(config, { role: 'worker' });

  /**
   * The SAME dependency graph the API builds, on the `worker` pool.
   *
   * `buildModules` is the one file that knows which module depends on which, so
   * the worker goes through it rather than assembling `notify` by hand — a
   * second wiring site is a second place to update, and the copy belonging to
   * whichever process is not being worked on is the one that silently rots.
   *
   * `forWorker: true` swaps every repository onto `pools.worker` (§3.1:
   * "digests must never compete with live traffic"). No `digest` source is
   * passed, so the digest handlers are not registered and the weekly scan is
   * not scheduled — that arrives with the `parent` module.
   */
  const modules = buildModules(container, { forWorker: true });

  const worker = createWorker({
    config,
    notify: modules.notify,
    // §3.1 — the `worker` pool, capped at six, so a runaway job can never
    // starve login or ordinary request traffic.
    db: container.pools.worker,
    clock: container.clock,
    logger: container.logger,
    metrics: container.metrics,
  });

  let stopping = false;

  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;

    void (async (): Promise<void> => {
      try {
        // §12 step 3 — finish the current job, up to 30 s; claim no new ones.
        await worker.stop(reason);
      } catch (error) {
        container.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'worker shutdown failed',
        );
      }
      try {
        // §12 step 4. `container.shutdown()` uses `allSettled`, so a cache that
        // is already gone cannot stop the pools closing.
        await container.shutdown();
      } catch (error) {
        container.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'failed to close worker resources',
        );
      }
      // §12 step 5.
      process.exit(0);
    })();
  };

  // Installed BEFORE the loop starts, so a SIGTERM arriving during startup
  // drains cleanly instead of killing the process mid-boot. Same reasoning as
  // `controller.listen()` before `app.listen()` in `src/main.ts`.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  await worker.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Fatal worker startup error:\n${message}\n`);
  process.exit(1);
});
