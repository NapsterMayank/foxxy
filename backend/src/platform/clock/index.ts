/**
 * platform/clock — the current time, injected.
 *
 * Looks like over-engineering; is not. Without it there is no deterministic
 * test for session expiry, token lifetime, or digest week boundaries.
 * Domain functions never read the clock: the time is passed in.
 */
export interface Clock {
  now(): Date;
}

export function createSystemClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
  };
}

/**
 * Test fake. Starts at a fixed instant and only moves when told to.
 */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Moves time forward. Negative values are rejected — time is not a slider. */
  advanceMs(milliseconds: number): void {
    if (milliseconds < 0) {
      throw new RangeError('FixedClock.advanceMs: time does not move backwards');
    }
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }

  /** Jumps to an absolute instant. */
  setTo(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : new Date(instant.getTime());
  }
}

/**
 * Waiting, injected — the other half of the clock.
 *
 * Retry backoff has to wait. §9.5 of the implementation plan bans `sleep` in a
 * test outright, and §11 of the resilience plan requires the delay SEQUENCE and
 * the jitter BOUNDS to be asserted. Both are only possible if the wait itself
 * is a port: production waits on a timer, a test records the requested delay,
 * advances the FixedClock by it, and returns immediately.
 */
export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

export function createRealSleeper(): Sleeper {
  return {
    sleep(milliseconds: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  };
}

/**
 * Test fake. Records every requested delay and moves the clock forward by it,
 * so elapsed-time logic downstream (a circuit breaker's open interval, say)
 * observes the wait without anybody actually waiting.
 */
export class RecordingSleeper implements Sleeper {
  readonly delays: number[] = [];

  constructor(private readonly clock?: FixedClock) {}

  sleep(milliseconds: number): Promise<void> {
    this.delays.push(milliseconds);
    this.clock?.advanceMs(milliseconds);
    return Promise.resolve();
  }
}
