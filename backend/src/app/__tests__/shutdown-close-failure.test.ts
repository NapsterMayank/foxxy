import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { FakeLogger } from '../../platform/logger/index';
import { createShutdownController } from '../shutdown';

/**
 * D-304 — `app.close()` REJECTING MUST NOT SKIP THE REST OF THE SHUTDOWN.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN FILE, AND WHY IT USES A REAL FASTIFY INSTANCE.
 *
 * `shutdown.test.ts` proves the happy path: SIGTERM mid-request drains, closes
 * resources and exits 0. It never asks what happens when the drain itself
 * fails, and the answer was: `run()` threw at the bare `await withDeadline(
 * app.close(), …)`, so `closeResources()` never ran and `exit(0)` never ran.
 * The pools stayed held on the database until it timed them out and the process
 * sat there until the orchestrator's SIGKILL — the exact outcome that file's
 * own header says the deadline exists to avoid, reached through a different
 * door. It had been flagged by an earlier audit and was unchanged.
 *
 * A REAL Fastify instance with a real `onClose` hook, not a stub with a
 * rejecting `close`. The failure mode is "some plugin's teardown throws", and
 * plugin teardown is a Fastify mechanism — a hand-written stub would prove that
 * a rejecting function rejects, which nobody doubted, and would not prove that
 * this is reachable from the way the app is actually assembled.
 */

let app: FastifyInstance;
let logger: FakeLogger;
let exitCodes: number[];
let closedResources: number;

beforeEach(() => {
  app = Fastify();
  logger = new FakeLogger();
  exitCodes = [];
  closedResources = 0;
});

afterEach(async () => {
  // The controller already closed it in most tests; closing twice is harmless
  // and this keeps a failed assertion from leaking a server.
  await app.close().catch(() => undefined);
});

function build(onCloseBehaviour: 'reject' | 'resolve'): ReturnType<typeof createShutdownController> {
  app.addHook('onClose', () => {
    if (onCloseBehaviour === 'reject') {
      return Promise.reject(new Error('cache client already gone'));
    }
    return Promise.resolve();
  });

  return createShutdownController({
    app,
    logger,
    drainTimeoutMs: 15_000,
    closeResources: () => {
      closedResources += 1;
      return Promise.resolve();
    },
    // Injected: a real `process.exit` would take the test runner with it.
    exit: (code) => exitCodes.push(code),
  });
}

describe('a plugin onClose hook that rejects', () => {
  it('still closes resources and still exits 0', async () => {
    // The two lines that were skipped. Releasing the pools is the ONLY thing
    // standing between a failed drain and connections held on the database
    // until it times them out, and exiting is what stops the orchestrator
    // escalating to SIGKILL.
    const controller = build('reject');
    await app.listen({ port: 0, host: '127.0.0.1' });

    await controller.shutdown('SIGTERM');

    expect(closedResources).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('reports the failed drain as a failure, not as a timeout', async () => {
    // "The drain timed out" and "the drain blew up" are different incidents.
    // Sharing one message would make the second unreadable at 2am, and the
    // completion line has to say the drain did NOT succeed — reporting
    // `drained: true` for a drain that threw would be worse than silence.
    const controller = build('reject');
    await app.listen({ port: 0, host: '127.0.0.1' });

    await controller.shutdown('SIGTERM');

    const failure = logger.lines.find((line) =>
      (line.msg ?? '').startsWith('the http drain failed'),
    );
    expect(failure?.level).toBe('error');
    expect(failure?.obj.err).toBe('cache client already gone');

    const complete = logger.lines.find((line) => line.msg === 'shutdown complete');
    expect(complete?.obj.drained).toBe(false);
  });

  it('flips readiness to 503 before any of it, exactly as on the happy path', async () => {
    // Step 1 is first for a reason: the load balancer has to stop routing
    // before the socket closes. A failing drain must not delay it.
    const controller = build('reject');
    await app.listen({ port: 0, host: '127.0.0.1' });

    const shutting = controller.shutdown('SIGTERM');
    expect(controller.isShuttingDown()).toBe(true);
    await shutting;
  });

  it('is still idempotent — a second signal does not close resources twice', async () => {
    // An orchestrator that sends SIGTERM then SIGINT is ordinary, and the
    // second call would otherwise `pool.end()` an already-ended pool.
    const controller = build('reject');
    await app.listen({ port: 0, host: '127.0.0.1' });

    await Promise.all([controller.shutdown('SIGTERM'), controller.shutdown('SIGINT')]);

    expect(closedResources).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('exits 0 even when closing the resources ALSO fails', async () => {
    // Both halves failing at once is the deploy-during-a-database-outage case.
    // There is nothing left to clean up at that point and nothing useful left
    // to do except say so and go, so that the orchestrator's next step is a
    // replacement process rather than a SIGKILL against this one.
    app.addHook('onClose', () => Promise.reject(new Error('cache client already gone')));
    const controller = createShutdownController({
      app,
      logger,
      drainTimeoutMs: 15_000,
      closeResources: () => Promise.reject(new Error('pool.end failed')),
      exit: (code) => exitCodes.push(code),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });

    await controller.shutdown('SIGTERM');

    expect(
      logger.lines.some((line) => line.msg === 'failed to close resources during shutdown'),
    ).toBe(true);
    expect(exitCodes).toEqual([0]);
  });

  it('does not mask a successful drain — the control case', async () => {
    // The guard must not turn every drain into a reported failure. Without
    // this, the fix above would be satisfied by a version that never reports
    // `drained: true` at all.
    const controller = build('resolve');
    await app.listen({ port: 0, host: '127.0.0.1' });

    await controller.shutdown('SIGTERM');

    const complete = logger.lines.find((line) => line.msg === 'shutdown complete');
    expect(complete?.obj.drained).toBe(true);
    expect(closedResources).toBe(1);
    expect(exitCodes).toEqual([0]);
  });
});
