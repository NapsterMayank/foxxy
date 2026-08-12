import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import { DependencyError, ValidationError } from '../../errors/index';
import { MemoryMetrics } from '../memory-metrics';
import { PLATFORM_METRICS } from '../metrics.port';
import { classifyPortFailure, createPortFailureBridge } from '../port-failure-bridge';

/**
 * `platform.port.call_failed` — the counter that makes a FAST dependency
 * failure visible. 04-RESILIENCE-PLAN.md §5.
 *
 * ===========================================================================
 * WHAT THIS IS FOR, STATED AS THE MEASUREMENT THAT PROMPTED IT.
 *
 * `dependency.errors` was the sum of three counters, all of them emitted by the
 * GUARD when the guard refuses or abandons a call: a timeout, a breaker
 * rejection, a concurrency rejection. A call the DEPENDENCY refuses increments
 * none of them — it returns in milliseconds, well inside its timeout, and the
 * breaker files the failure privately until it transitions at five.
 *
 * Driven against the real production wiring with a failing port, an auditor read:
 *
 *     EMBED-DOWN turn:      502 DEPENDENCY_FAILURE
 *     EMBED-DOWN metrics_events: []
 *     PAY-DOWN checkout:    502 DEPENDENCY_FAILURE
 *     PAY-DOWN metrics_events: []
 *
 * Connection refused, DNS failure and provider-500 are the commonest shape an
 * outage takes, and they were the one shape no alert rule could see.
 *
 * ===========================================================================
 * THE DISJOINTNESS IS THE LOAD-BEARING PROPERTY, so it is tested hardest.
 *
 * The collector SUMS four counters. If this one also fired for a timeout, every
 * timeout would be worth two dependency errors and the paging threshold would
 * mean half what it says — a number people quietly stop believing.
 */

const clock = new FixedClock('2026-08-10T00:00:00.000Z');

function metrics(): MemoryMetrics {
  return new MemoryMetrics({ clock });
}

/** Exactly what `withTimeout` throws. */
function timeoutError(port = 'embed'): DependencyError {
  return new DependencyError(port, {
    message: `${port} timed out after 5000ms`,
    details: { port, timeoutMs: 5_000 },
  });
}

/** Exactly what the breaker's `reject()` throws. */
function breakerRejection(port = 'embed'): DependencyError {
  return new DependencyError(port, {
    message: `circuit breaker for "${port}" is open`,
    details: { breaker: port, state: 'open' },
  });
}

/** Exactly what the limiter's overflow throws. */
function concurrencyRejection(port = 'embed'): DependencyError {
  return new DependencyError(port, {
    message: `Concurrency limit reached for "${port}"`,
    details: { port, max: 8, inFlight: 8 },
  });
}

/** What a dead provider actually produces. */
function connectionRefused(port = 'embed'): DependencyError {
  return new DependencyError(port, {
    message: 'connect ECONNREFUSED 127.0.0.1:443',
    details: { port },
  });
}

describe('classifyPortFailure', () => {
  it.each([
    ['a timeout', timeoutError(), 'timeout'],
    ['a breaker rejection', breakerRejection(), 'breaker'],
    ['a concurrency rejection', concurrencyRejection(), 'concurrency'],
    ['connection refused', connectionRefused(), 'call'],
  ] as const)('classifies %s as %s', (_label, error, expected) => {
    expect(classifyPortFailure(error)).toBe(expected);
  });

  /**
   * An adapter that never wrapped its failure must still count. Requiring the
   * wrapper would make the counter depend on every adapter author having
   * remembered, and the adapter that forgot is the one whose outage goes unseen.
   */
  it('counts a plain Error as a call failure rather than ignoring it', () => {
    expect(classifyPortFailure(new Error('getaddrinfo ENOTFOUND api.example.test'))).toBe('call');
    expect(classifyPortFailure(new ValidationError('bad input'))).toBe('call');
    expect(classifyPortFailure('not an error at all')).toBe('call');
    expect(classifyPortFailure(undefined)).toBe('call');
  });

  it('does not classify by message text — a DependencyError with no details counts', () => {
    // The word "timeout" in the message must not make this a timeout. Message
    // matching breaks silently the first time somebody improves an error string.
    const error = new DependencyError('embed', { message: 'upstream timeout, probably' });
    expect(classifyPortFailure(error)).toBe('call');
  });
});

describe('createPortFailureBridge', () => {
  it('EMITS for a fast failure — the shape that produced an empty table', () => {
    const sink = metrics();
    createPortFailureBridge(sink)('embed', connectionRefused());
    expect(sink.totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(1);
  });

  it('tags the port, so a dead payments host is distinguishable from a dead cache', () => {
    const sink = metrics();
    const record = createPortFailureBridge(sink);
    record('payments', connectionRefused('payments'));
    record('embed', connectionRefused('embed'));

    const tagged = sink
      .snapshot()
      .filter((series) => series.name === PLATFORM_METRICS.PORT_CALL_FAILED)
      .map((series) => series.tags.port)
      .sort();
    expect(tagged).toEqual(['embed', 'payments']);
  });

  /**
   * THE DISJOINTNESS TEST. Each of these is already counted by its own metric;
   * emitting here as well would double every one of them inside
   * `dependency.errors`.
   */
  it.each([
    ['a timeout (already platform.port.timeout)', timeoutError()],
    ['a breaker rejection (already platform.breaker.rejected)', breakerRejection()],
    ['a concurrency rejection (already platform.concurrency.rejected)', concurrencyRejection()],
  ] as const)('does NOT emit for %s', (_label, error) => {
    const sink = metrics();
    createPortFailureBridge(sink)('embed', error);
    expect(sink.totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(0);
  });

  it('counts four fast failures as four, so a recovered outage still leaves a trace', () => {
    // The payments case from the audit: four checkouts fail, the provider comes
    // back, and the breaker never transitions because it never reached five.
    const sink = metrics();
    const record = createPortFailureBridge(sink);
    for (let i = 0; i < 4; i += 1) record('payments', connectionRefused('payments'));
    expect(sink.totalFor(PLATFORM_METRICS.PORT_CALL_FAILED)).toBe(4);
  });
});
