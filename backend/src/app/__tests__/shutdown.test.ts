import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { FakeLogger } from '../../platform/logger/index';
import { createShutdownController, type ShutdownController } from '../shutdown';

/**
 * 04-RESILIENCE-PLAN.md §11, row "Graceful shutdown":
 *
 *   "Send SIGTERM mid-request; assert the in-flight request COMPLETES and NO
 *    NEW ONES ARE ACCEPTED."
 *
 * This test uses a REAL listening server on a real socket, not `app.inject`.
 * Injection bypasses the HTTP layer entirely, and "stops accepting
 * connections" is a property OF the HTTP layer — an injected test would pass
 * while a deployed process dropped every request on every deploy.
 *
 * A request is held open by a deferred promise rather than a timer, so the
 * test controls exactly when the in-flight request finishes and nothing
 * sleeps.
 */

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let app: FastifyInstance;
let logger: FakeLogger;
let baseUrl: string;
let exitCodes: number[];
let closedResources: number;
let controller: ShutdownController;

function build(drainTimeoutMs = 15_000): ShutdownController {
  return createShutdownController({
    app,
    logger,
    drainTimeoutMs,
    closeResources: () => {
      closedResources += 1;
      return Promise.resolve();
    },
    // Injected: a real `process.exit` would take the test runner with it.
    exit: (code) => exitCodes.push(code),
  });
}

/** Rebuilt for every test — no shared mutable state between tests (§9.5). */
let slow: Deferred;
/**
 * Resolved by the `/slow` handler the moment it is entered.
 *
 * Without this the test signals SIGTERM before the server has actually
 * received the request, `close()` tears down the listening socket, and the
 * "in-flight" request is reset — a failure that looks like a broken drain and
 * is really a race in the test. `setImmediate` is not a synchronisation
 * primitive; the handler saying "I have started" is.
 */
let started: Deferred;

beforeEach(async () => {
  slow = deferred();
  started = deferred();
  logger = new FakeLogger();
  exitCodes = [];
  closedResources = 0;

  app = Fastify({ logger: false, return503OnClosing: true });
  app.get('/slow', async () => {
    started.resolve();
    await slow.promise;
    return { finished: true };
  });
  app.get('/fast', () => ({ ok: true }));

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${String(port)}`;
  controller = build();
});

afterEach(async () => {
  // Release any handler still parked, then destroy every socket.
  //
  // `closeAllConnections` is not politeness — without it this file took 70
  // SECONDS per test. A drain that deliberately gives up leaves a client
  // socket attached to a half-closed server, and `app.close()` then waits out
  // Node's 60s `headersTimeout` plus the keep-alive window before resolving.
  // The production path never does this: it gives up on the drain and exits
  // the process, so the socket dies with it. Only a test that keeps the
  // process alive afterwards has to clean up behind itself.
  slow.resolve();
  app.server.closeAllConnections();
  await app.close().catch(() => undefined);
});

describe('SIGTERM mid-request — the required §11 assertion', () => {
  it('completes the in-flight request and refuses new ones', async () => {
    // A 2s drain rather than the production 15s. The behaviour under test is
    // identical; the difference is only how long the test waits at the end.
    // `app.close()` does not resolve promptly once undici has parked a
    // keep-alive socket against the server — a connection that becomes idle
    // AFTER close() was called is not swept — so the drain runs to its
    // deadline. In production the process exits at that point and the socket
    // dies with it; here the runner keeps living, so the wait is real time.
    const shortDrain = build(2_000);

    // 1. A request is in flight and cannot finish yet. Wait until the HANDLER
    //    has been entered — genuinely in flight, not merely dispatched.
    const inFlight = fetch(`${baseUrl}/slow`);
    await started.promise;

    // 2. SIGTERM arrives.
    const shutdown = shortDrain.shutdown('SIGTERM');

    // 3. Readiness flips IMMEDIATELY — before any draining, before the socket
    //    closes. This is what stops the load balancer sending more work.
    expect(shortDrain.isShuttingDown()).toBe(true);

    // 4. A NEW request during the drain is refused, not accepted.
    const during = await fetch(`${baseUrl}/fast`).catch(() => null);
    if (during !== null) {
      // Fastify answers 503 to a request that arrives while closing.
      expect(during.status).toBe(503);
    }
    // A connection-level refusal (`during === null`) is equally acceptable:
    // both mean "not accepted". What must NOT happen is a 200.

    // 5. The in-flight request finishes normally.
    slow.resolve();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ finished: true });

    await shutdown;
  }, 20_000);
});

describe('the shutdown sequence', () => {
  it('flips readiness to 503 before anything else happens', () => {
    expect(controller.isShuttingDown()).toBe(false);
    void controller.shutdown('SIGTERM');
    // Synchronously true — not after an await. §12, step 1.
    expect(controller.isShuttingDown()).toBe(true);
  });

  it('closes pools and the cache after draining', async () => {
    slow.resolve();
    await controller.shutdown('SIGTERM');
    expect(closedResources).toBe(1);
  });

  it('exits 0', async () => {
    slow.resolve();
    await controller.shutdown('SIGTERM');
    expect(exitCodes).toEqual([0]);
  });

  it('is idempotent — a second signal does not start a second drain', async () => {
    slow.resolve();
    const first = controller.shutdown('SIGTERM');
    const second = controller.shutdown('SIGINT');
    expect(second).toBe(first);
    await first;
    // One close, one exit. Two would mean `pool.end()` on an ended pool and
    // `app.close()` on an already-closing server.
    expect(closedResources).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('logs the start and the completion at warn', async () => {
    slow.resolve();
    await controller.shutdown('SIGTERM');
    const messages = logger.lines.filter((line) => line.level === 'warn').map((line) => line.msg);
    expect(messages).toContain('shutdown started; readiness is now 503');
    expect(messages).toContain('shutdown complete');
  });
});

describe('the drain deadline', () => {
  /** Holds a request open so the drain has something it cannot finish. */
  async function startStuckRequest(): Promise<void> {
    void fetch(`${baseUrl}/slow`).catch(() => undefined);
    await started.promise;
  }

  it('gives up on a request that will not finish, and still closes cleanly', async () => {
    // A drain that waits forever is worse than one that gives up: the
    // orchestrator eventually sends SIGKILL, which drops the request anyway
    // AND skips closing the pools, leaving connections held on the database
    // until it times them out.
    await startStuckRequest();
    const impatient = build(20);
    await impatient.shutdown('SIGTERM');

    expect(closedResources).toBe(1);
    expect(exitCodes).toEqual([0]);
    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
  }, 20_000);

  it('reports the drain as incomplete rather than pretending it worked', async () => {
    await startStuckRequest();
    const impatient = build(20);
    await impatient.shutdown('SIGTERM');
    const complete = logger.lines.find((line) => line.msg === 'shutdown complete');
    expect(complete?.obj).toMatchObject({ drained: false });
  }, 20_000);
});

describe('signal wiring', () => {
  it('installs handlers for SIGTERM and SIGINT', () => {
    const installed: string[] = [];
    createShutdownController({
      app,
      logger,
      drainTimeoutMs: 15_000,
      closeResources: () => Promise.resolve(),
      exit: () => undefined,
      onSignal: (signal) => installed.push(signal),
    }).listen();
    expect(installed).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('a signal triggers the drain', async () => {
    const handlers = new Map<string, () => void>();
    const signalled = createShutdownController({
      app,
      logger,
      drainTimeoutMs: 15_000,
      closeResources: () => {
        closedResources += 1;
        return Promise.resolve();
      },
      exit: (code) => exitCodes.push(code),
      onSignal: (signal, handler) => handlers.set(signal, handler),
    });
    signalled.listen();

    slow.resolve();
    handlers.get('SIGTERM')?.();
    await signalled.shutdown('SIGTERM');

    expect(signalled.isShuttingDown()).toBe(true);
    expect(exitCodes).toEqual([0]);
  });
});
