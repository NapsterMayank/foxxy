import { randomUUID } from 'node:crypto';

/**
 * platform/idGen — identifier generation, injected.
 *
 * Anything ordered by id is untestable without this. The counter fake makes
 * generated ids predictable and readable in assertions.
 */
export interface IdGen {
  uuid(): string;
}

export function createUuidGen(): IdGen {
  return {
    uuid(): string {
      return randomUUID();
    },
  };
}

/**
 * Test fake. Emits a valid, deterministic UUID sequence:
 * 00000000-0000-4000-8000-000000000001, ...000002, and so on.
 *
 * Version-4 and variant bits are set so the values pass a uuid column check.
 */
export class CounterIdGen implements IdGen {
  private counter: number;

  constructor(start = 0) {
    this.counter = start;
  }

  uuid(): string {
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${suffix}`;
  }

  /** The number of ids handed out so far. */
  get issued(): number {
    return this.counter;
  }

  reset(start = 0): void {
    this.counter = start;
  }
}
