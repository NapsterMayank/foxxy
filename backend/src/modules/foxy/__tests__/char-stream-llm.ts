import { DependencyError, ValidationError } from '@/platform/errors/index';
import type { FakeLlm, LlmChunk, LlmCompletion, LlmRequest } from '@/platform/llm/index';

/**
 * ============================================================================
 * A SCRIPTED MODEL THAT STREAMS ONE CHARACTER AT A TIME.
 *
 * `createFakeLlm` splits its answer on `' '`. `[chunk:<uuid>]` contains no
 * space, so under that fake A CITATION MARKER ALWAYS ARRIVES WHOLE — and an
 * audit proved what that costs: replacing foxy's incremental citation filter
 * with a post-hoc one (buffer the whole answer, strip once) failed exactly one
 * test, and only on an incidental token count. Every assertion about "the
 * marker never reaches the student" was being satisfied by the splitter rather
 * than by the filter.
 *
 * A real model splits markers mid-token routinely: `[chu`, `nk:7f`, `3a…`. One
 * character per chunk is the harshest and most honest version of that, and it
 * is deterministic — the same string always produces the same frames.
 *
 * WHY IT ALSO COUNTS WHAT IT HAS YIELDED. "The filter is incremental" is not a
 * statement about the final text; a post-hoc filter produces exactly the same
 * final text. It is a statement about WHEN text reaches the student: the first
 * visible token must arrive while the model is still streaming. `yielded()`
 * makes that observable without a clock and without a `sleep`.
 * ============================================================================
 */

export interface CharStreamLlm extends FakeLlm {
  /** Chunks the model has actually handed out so far. Read between frames. */
  readonly yielded: () => number;
  /** How many chunks this answer will produce in total. */
  readonly total: () => number;
}

/**
 * Builds the fake. `respond` receives the real request, so a test can cite an
 * id the service genuinely retrieved rather than one the test invented.
 */
export function createCharStreamLlm(respond: (req: LlmRequest) => string): CharStreamLlm {
  const requests: LlmRequest[] = [];
  let yielded = 0;
  let total = 0;

  function record(req: LlmRequest): void {
    // The same refusal `createFakeLlm` makes, and for the same reason: a
    // provider that answers an empty conversation hides a prompt-assembly bug
    // behind a plausible-looking response.
    if (req.messages.length === 0) {
      throw new ValidationError('A model request needs at least one message.', {
        message: 'createCharStreamLlm: refused an empty message list',
      });
    }
    requests.push(req);
  }

  return {
    recorder: {
      requests,
      callCount: (): number => requests.length,
    },
    yielded: (): number => yielded,
    total: (): number => total,

    complete(req: LlmRequest): Promise<LlmCompletion> {
      record(req);
      const text = respond(req);
      return Promise.resolve({ text, inputTokens: 0, outputTokens: text.length, model: 'char-fake' });
    },

    stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      // Recorded EAGERLY, exactly as `createFakeLlm` does — "the model was never
      // called" has to mean what it says even for a stream nobody drains.
      record(req);
      const answer = respond(req);
      // UTF-16 code units, deliberately: this fake exists to split a marker in
      // the harshest place possible, and `[chunk:<uuid>]` is pure ASCII. A
      // locale-aware segmenter would group characters and split LESS.
      const characters = Array.from(
        { length: answer.length },
        (_unused, index) => answer.charAt(index),
      );
      total = characters.length;
      yielded = 0;

      async function* iterate(): AsyncGenerator<LlmChunk> {
        await Promise.resolve();
        for (const text of characters) {
          yielded += 1;
          yield { text };
        }
      }

      return { [Symbol.asyncIterator]: iterate };
    },
  };
}

/** A stream that dies mid-marker, so the held-back text is never released. */
export function createCharStreamLlmFailingAt(
  respond: (req: LlmRequest) => string,
  failAfter: number,
): CharStreamLlm {
  const base = createCharStreamLlm(respond);
  return {
    ...base,
    stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      const inner = base.stream(req);
      async function* iterate(): AsyncGenerator<LlmChunk> {
        let emitted = 0;
        for await (const chunk of inner) {
          if (emitted >= failAfter) {
            throw new DependencyError('llm', { message: 'char fake: forced failure' });
          }
          emitted += 1;
          yield chunk;
        }
      }
      return { [Symbol.asyncIterator]: iterate };
    },
  };
}
