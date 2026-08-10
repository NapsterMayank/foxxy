import type { FastifyInstance } from 'fastify';
import type { Logger } from '../platform/logger/index';

/**
 * Graceful shutdown — 04-RESILIENCE-PLAN.md §12.
 *
 * On SIGTERM:
 *   1. Mark the process as shutting down, so `/health/ready` answers 503
 *      IMMEDIATELY. This happens first and it is the step that matters most:
 *      the load balancer has to stop sending new work before the socket
 *      closes, or the requests it sends in between are simply lost.
 *   2. Stop accepting connections and drain what is in flight, up to 15s.
 *   3. Close the database pools and the cache connection.
 *   4. Exit 0.
 *
 * Without this, every deploy drops requests. It is a small amount of code that
 * makes routine deploys invisible instead of user-visible — and "invisible
 * deploys" is what lets a team deploy often enough to fix things quickly,
 * which is worth more than the code itself.
 *
 * There is a real ordering subtlety in step 2. Fastify's `close()` both stops
 * accepting and waits for in-flight requests, and with `return503OnClosing`
 * (its default) a request that arrives DURING the drain is answered 503 rather
 * than accepted or dropped. That is what "no new ones are accepted" means
 * concretely, and it is why the drain window is a good thing rather than a
 * window of ambiguity.
 */

export interface ShutdownOptions {
  readonly app: FastifyInstance;
  readonly logger: Logger;
  /** Closes pools, cache, and anything else the container owns. */
  readonly closeResources: () => Promise<void>;
  /** §12, step 2. */
  readonly drainTimeoutMs: number;
  /** Injected so a test never terminates the test runner. */
  readonly exit?: (code: number) => void;
  /** Injected for the same reason. */
  readonly onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

export interface ShutdownController {
  /** What `/health/ready` reads. True from the instant a signal arrives. */
  isShuttingDown(): boolean;
  /** Runs the sequence. Idempotent — a second SIGTERM does not restart it. */
  shutdown(reason: string): Promise<void>;
  /** Installs SIGTERM and SIGINT handlers. */
  listen(): void;
}

/**
 * Waits for `promise`, but not forever.
 *
 * A drain that never finishes is worse than a drain that gives up: the
 * orchestrator eventually sends SIGKILL, which drops the in-flight requests
 * anyway AND skips closing the pools, leaving connections held on the database
 * until it times them out. Better to stop waiting at 15s and close cleanly.
 */
async function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createShutdownController(options: ShutdownOptions): ShutdownController {
  const { app, logger, closeResources, drainTimeoutMs } = options;
  const exit = options.exit ?? ((code: number): void => process.exit(code));

  let shuttingDown = false;
  let running: Promise<void> | undefined;

  async function run(reason: string): Promise<void> {
    // Step 1, and it is deliberately the FIRST line: readiness must flip
    // before any awaiting happens. Doing it after `app.close()` starts would
    // leave a window where the balancer still routes to a closing socket.
    shuttingDown = true;
    logger.warn({ reason, drainTimeoutMs }, 'shutdown started; readiness is now 503');

    const drained = await withDeadline(app.close(), drainTimeoutMs);
    if (!drained) {
      logger.error(
        { reason, drainTimeoutMs },
        'drain deadline exceeded; closing resources with requests still in flight',
      );
    }

    try {
      await closeResources();
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'failed to close resources during shutdown',
      );
    }

    logger.warn({ reason, drained }, 'shutdown complete');
    exit(0);
  }

  /**
   * Idempotent. An orchestrator that sends SIGTERM twice, or SIGTERM followed
   * by SIGINT, must not start two drains — the second would call `app.close()`
   * on an already-closing server and `pool.end()` on an already-ended pool.
   */
  function shutdown(reason: string): Promise<void> {
    running ??= run(reason);
    return running;
  }

  return {
    isShuttingDown(): boolean {
      return shuttingDown;
    },

    shutdown,

    listen(): void {
      const install =
        options.onSignal ??
        ((signal: NodeJS.Signals, handler: () => void): void => {
          process.on(signal, handler);
        });

      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        install(signal, () => {
          void shutdown(signal);
        });
      }
    },
  };
}
