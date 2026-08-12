import { DependencyError, ValidationError } from '../errors/index';
import type { LlmChunk, LlmCompletion, LlmProvider, LlmRequest } from './llm.port';

/**
 * A DETERMINISTIC language-model provider — the fake every test uses.
 *
 * ===========================================================================
 * WHY IT IS SCRIPTED RATHER THAN GENERATIVE.
 *
 * Plan §5 says the test fake "returns a scripted response", and the word that
 * matters is SCRIPTED. `foxy`'s hardest properties are all assertions about
 * exactly what came back — that a fabricated citation was stripped, that a mode
 * produced its own prompt shape, that a mid-stream failure left the tokens that
 * had already arrived intact. None of those can be asserted against a provider
 * whose output varies.
 *
 * The same seed always yields exactly the same frames, on every machine and
 * every run. There is no `Math.random()` here and there must never be one.
 *
 * ===========================================================================
 * WHAT IT IS NOT.
 *
 * NOT A MODEL. It does not read the prompt except to record it. A test that
 * asserts "Foxy explained photosynthesis correctly" against this fake is
 * asserting something about the fake. What it CAN prove is everything around
 * the model: the order of the pipeline, the citation verification, the trace,
 * the SSE frames and every failure branch.
 *
 * ===========================================================================
 * THE FAILURE INJECTORS ARE THE POINT, NOT AN EXTRA.
 *
 * `failAfter` cuts the stream mid-sentence, which is the §8.5 case that must
 * "yield a graceful partial response rather than a 500". `failImmediately`
 * covers "the model was never reachable". Both are exercised by the service
 * suite; without them those branches would be untested and would be discovered
 * in production, at 2am, by a student.
 */

/** The model name the fake reports. Deliberately not a real model id. */
export const FAKE_LLM_MODEL = 'deterministic-fake-llm';

export interface FakeLlmOptions {
  /**
   * The text the fake streams, split into chunks on whitespace.
   *
   * A function so a test can vary the answer BY REQUEST — the citation tests
   * need a response that cites `[chunk:<a real id>]` and the fabrication test
   * needs one that cites an id that was never retrieved, and both have to be
   * derivable from the prompt the service actually assembled.
   */
  readonly respond?: (req: LlmRequest) => string;
  /**
   * Emit this many chunks, then throw. `undefined` means never fail.
   *
   * 0 means "fail before the first token", which is a DIFFERENT case from
   * failing after two: one is an error state with nothing to show, the other is
   * a partial answer that must be kept.
   */
  readonly failAfter?: number;
  /** Rejects `complete()` and `stream()` before doing anything at all. */
  readonly failImmediately?: boolean;
  readonly model?: string;
}

/** Every call the fake saw, in order. Read by tests; never by production. */
export interface FakeLlmRecorder {
  readonly requests: LlmRequest[];
  /** How many times the model was asked for anything at all. */
  readonly callCount: () => number;
}

export interface FakeLlm extends LlmProvider {
  readonly recorder: FakeLlmRecorder;
}

const DEFAULT_ANSWER =
  'Photosynthesis is how a plant makes its own food using sunlight, water and carbon dioxide.';

/**
 * Splits on spaces and keeps the space, so `chunks.join('')` reconstructs the
 * answer byte for byte. A splitter that dropped the separator would make every
 * assertion about the assembled text quietly wrong by one space per token.
 */
function toChunks(text: string): string[] {
  const parts = text.split(' ');
  return parts.map((part, index) => (index === parts.length - 1 ? part : `${part} `));
}

/** A crude but STABLE token count. Never a random number, never a real tokeniser. */
export function fakeTokenCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
}

export function createFakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const model = options.model ?? FAKE_LLM_MODEL;
  const respond = options.respond ?? ((): string => DEFAULT_ANSWER);
  const requests: LlmRequest[] = [];

  function record(req: LlmRequest): void {
    if (req.messages.length === 0) {
      // Refused rather than answered. An empty conversation has no answer, only
      // an arbitrary one, and a provider that replies anyway hides a prompt
      // assembly bug behind a plausible-looking response.
      throw new ValidationError('A model request needs at least one message.', {
        message: 'createFakeLlm: refused an empty message list',
      });
    }
    requests.push(req);
  }

  return {
    recorder: {
      requests,
      callCount: (): number => requests.length,
    },

    // `async`, so a refused request REJECTS rather than throwing synchronously.
    // `stream` below is the opposite on purpose — it records eagerly — and the
    // asymmetry is the difference between "returns a promise" and "returns a
    // lazy iterable", not an inconsistency.
    async complete(req: LlmRequest): Promise<LlmCompletion> {
      record(req);
      if (options.failImmediately === true) {
        throw new DependencyError('llm', { message: 'fake llm: forced failure' });
      }
      const text = respond(req);
      return await Promise.resolve({
        text,
        inputTokens: fakeTokenCount(req.messages.map((message) => message.content).join(' ')),
        outputTokens: fakeTokenCount(text),
        model,
      });
    },

    stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      // RECORDED EAGERLY, before the generator is iterated. `stream()` returning
      // a lazy iterable means a test that never consumes it would otherwise see
      // `callCount() === 0` — and "the model was never called" is precisely the
      // assertion the abstention test makes, so it has to mean what it says.
      record(req);

      const failImmediately = options.failImmediately === true;
      const failAfter = options.failAfter;
      const chunks = toChunks(respond(req));

      async function* iterate(): AsyncGenerator<LlmChunk> {
        // `await` on a resolved promise, so the generator is genuinely
        // asynchronous and the consumer's interleaving matches production.
        await Promise.resolve();
        if (failImmediately) {
          throw new DependencyError('llm', { message: 'fake llm: forced failure' });
        }
        let emitted = 0;
        for (const text of chunks) {
          if (failAfter !== undefined && emitted >= failAfter) {
            throw new DependencyError('llm', {
              message: `fake llm: forced failure after ${String(emitted)} chunks`,
            });
          }
          emitted += 1;
          yield { text };
        }
        if (failAfter !== undefined && emitted >= failAfter) {
          throw new DependencyError('llm', {
            message: `fake llm: forced failure after ${String(emitted)} chunks`,
          });
        }
      }

      return { [Symbol.asyncIterator]: iterate };
    },
  };
}
