import type { Clock } from '../clock/index';
import type { TimeoutRule } from '../config/index';
import type { PortGuard } from '../resilience/index';
import { withTimeout } from '../resilience/index';
import type { LlmChunk, LlmCompletion, LlmProvider, LlmRequest } from './llm.port';

/**
 * The LLM port behind its bulkhead, breaker and timeouts — §3.3, §4, §5.
 *
 * THIS WRAPPER EXISTS BEFORE THE ADAPTER DOES, deliberately. `llm` is an
 * interface with no implementation yet (build step 7). Wiring the resilience
 * into the interface rather than into each adapter means the adapter that
 * lands later cannot be written without it: whoever builds it hands the
 * provider to this function at the composition root and gets the breaker, the
 * limit and both timeouts for free.
 *
 * The alternative — "we'll add the breaker when we add the adapter" — is how
 * the least reliable dependency in the system (§2, F1: "High" likelihood)
 * ends up being the only one without protection.
 *
 * Streaming is treated differently from completion, per §4:
 *   - non-streaming: one 30s budget for the whole call.
 *   - streaming: 8s TO THE FIRST TOKEN, 60s total, and NO retry once the
 *     stream has begun. A stream cut off mid-sentence and restarted shows the
 *     student two different half-answers.
 */
export interface GuardedLlmOptions {
  readonly guard: PortGuard;
  readonly clock: Clock;
  /** §4, "LLM — non-streaming". */
  readonly completion: TimeoutRule;
  /** §4, "LLM — streaming". `firstTokenMs` is required here. */
  readonly streaming: TimeoutRule;
}

export function createGuardedLlm(inner: LlmProvider, options: GuardedLlmOptions): LlmProvider {
  const { guard, clock } = options;
  const firstTokenMs = options.streaming.firstTokenMs ?? options.streaming.totalMs;

  return {
    complete(req: LlmRequest): Promise<LlmCompletion> {
      return guard.run(() => inner.complete(req), { timeoutMs: options.completion.totalMs });
    },

    stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      async function* iterate(): AsyncGenerator<LlmChunk> {
        // A slot is held for the LIFETIME of the stream, not for one promise.
        // `run` would release it at the first token, which would let an
        // unbounded number of open streams sit behind a limit of 20.
        const release = guard.limiter.acquire();
        try {
          const iterator = inner.stream(req)[Symbol.asyncIterator]();
          const startedAt = clock.now().getTime();

          // The first token is the part that fails, so it is the part the
          // breaker counts. Once tokens are flowing, a slow model is a slow
          // answer, not a broken dependency.
          const first = await guard.breaker.execute(() =>
            withTimeout(guard.name, firstTokenMs, () => iterator.next()),
          );
          if (first.done === true) return;
          yield first.value;

          for (;;) {
            const remaining = options.streaming.totalMs - (clock.now().getTime() - startedAt);
            if (remaining <= 0) {
              // Deliberately ends the stream rather than throwing: the student
              // has already been shown a partial answer, and §6's degradation
              // rule 1 is "degrade, never lie" — a truncated answer is honest,
              // a 500 after 400 visible tokens is not.
              return;
            }
            const next = await withTimeout(guard.name, remaining, () => iterator.next());
            if (next.done === true) return;
            yield next.value;
          }
        } finally {
          release();
        }
      }

      return { [Symbol.asyncIterator]: iterate };
    },
  };
}
