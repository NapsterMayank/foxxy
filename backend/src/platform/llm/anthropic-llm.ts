import { DependencyError, ValidationError } from '../errors/index';
import type { HttpClient } from '../http/index';
import type { LlmChunk, LlmCompletion, LlmProvider, LlmRequest } from './llm.port';

/**
 * THE REAL language-model adapter — the Anthropic Messages API.
 *
 * ===========================================================================
 * NOT CALLED BY ANY TEST, AND THAT IS THE POINT.
 *
 * There is no API key. Every test here drives a FAKE `HttpClient` and a fake
 * `fetch`, so the adapter is fully exercised — success, non-2xx, malformed
 * body, an empty completion, a truncated SSE frame, a mid-stream error event,
 * a transport failure — without a single byte leaving the machine. The
 * composition root is the only place that constructs it, and it refuses to be
 * constructed without a key.
 *
 * This mirrors `platform/embed/voyage-embed.ts` exactly, deliberately. That is
 * the pattern for "a paid dependency we cannot call yet", and having two
 * different patterns for the same problem is how one of them rots.
 *
 * ===========================================================================
 * THE VENDOR IS A CONFIG VALUE, NOT A COMMITMENT.
 *
 * 00-ARCHITECTURE.md §0 approves "a language model API" without naming one and
 * requires it to be replaceable by one adapter file. `baseUrl` and `model` are
 * both overridable, and everything vendor-shaped in this file is confined to
 * two functions: `toWireBody` and `parseSseEvent`. Swapping vendors is those
 * two functions plus a new file; nothing above `LlmProvider` changes.
 *
 * ===========================================================================
 * WHAT MAY BE SENT, AND WHAT MAY NOT.
 *
 * §0's table: the model "may see the student's question and the retrieved
 * textbook passages. NEVER a name, email, phone number, or account identifier."
 * This file cannot enforce that — it sends the messages it is handed — so the
 * enforcement lives where the messages are BUILT (`modules/foxy/domain/prompt.ts`)
 * and is tested there. What this file does is refuse to log a request body, so
 * the adapter can never become the leak by way of an error message.
 *
 * ===========================================================================
 * RESILIENCE IS NOT IMPLEMENTED HERE, DELIBERATELY.
 *
 * Timeouts, retry and the circuit breaker live in the injected `HttpClient` and
 * in `createGuardedLlm` (04-RESILIENCE-PLAN.md §3.3, §4, §5). An adapter that
 * grew its own retry loop would stack two backoff curves onto a dependency that
 * is already struggling, and only one of them would be visible in the metrics.
 *
 * ONE EXPLICIT NON-OVERRIDE: `complete()` does NOT set `idempotent: true`.
 * `platform/http` refuses to retry a POST, and that is right here — a completion
 * costs money per call and repeating one is a charge, not a free retry.
 * `stream()` bypasses the client entirely (see below) and is never retried once
 * a token has been shown, per §4.
 */

/** The default model. A config value, not a commitment — see the header. */
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

/** The vendor's REST base. Overridable so a test never needs a URL matcher. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

/** The version header the Messages API requires on every request. */
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicLlmOptions {
  /** Carries the timeout, the jittered retry and the breaker. */
  readonly http: HttpClient;
  /**
   * The streaming path needs the RESPONSE BODY AS A STREAM, and `HttpClient`
   * returns a fully-buffered string — correctly, because buffering is what
   * makes retry and timeout uniform for every other caller.
   *
   * So streaming takes `fetch` directly, and takes it as an INJECTED
   * dependency rather than reaching for the global: that is what lets every
   * branch below be tested with no network. The guard wrapping this provider
   * still supplies the first-token timeout, the total budget, the breaker and
   * the concurrency slot (`createGuardedLlm`), so nothing is unprotected — the
   * only thing skipped is the buffering, which is the thing streaming exists
   * to avoid.
   */
  readonly fetchImpl?: typeof fetch;
  /** Never logged — see the header of `platform/pii`. */
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

/** The vendor's request shape. The ONE place the wire format is decided. */
function toWireBody(req: LlmRequest, model: string, stream: boolean): Record<string, unknown> {
  // The Messages API takes the system prompt as a TOP-LEVEL FIELD, not as a
  // message with `role: 'system'`. A system message left in the array is
  // rejected with a 400 that reads like an auth problem.
  const system = req.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = req.messages.filter((message) => message.role !== 'system');

  return {
    model,
    max_tokens: req.maxTokens,
    ...(system.length === 0 ? {} : { system }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    messages: conversation.map((message) => ({ role: message.role, content: message.content })),
    ...(stream ? { stream: true } : {}),
  };
}

function headersFor(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/**
 * The non-streaming response, NARROWED rather than cast.
 *
 * `as AnthropicResponse` would compile and then hand `undefined` to a caller
 * that is about to persist it as a student's answer. A malformed response has
 * to fail here, where the cause is one line away.
 */
function narrowCompletion(body: string, model: string): LlmCompletion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new DependencyError('llm', {
      message: 'The model returned a body that is not JSON',
      cause,
    });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new DependencyError('llm', { message: 'The model response is not an object' });
  }

  const record = parsed as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) {
    throw new DependencyError('llm', { message: 'The model response has no `content` array' });
  }

  const text = content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const value = (block as Record<string, unknown>).text;
      return typeof value === 'string' ? value : '';
    })
    .join('');

  if (text.length === 0) {
    // An EMPTY completion is a failure, not an answer. Passing it through would
    // show a student an empty bubble that looks like a rendering bug, and would
    // persist a blank assistant message that nothing can distinguish from a
    // model that genuinely had nothing to say.
    throw new DependencyError('llm', {
      message: 'The model returned no text — refused rather than shown as an empty answer',
    });
  }

  const usage = record.usage;
  const usageRecord =
    typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
  const inputTokens = usageRecord.input_tokens;
  const outputTokens = usageRecord.output_tokens;
  const reported = record.model;

  return {
    text,
    // ZERO WHEN ABSENT, never NaN. These land in a trace column; `Number(x)` on
    // an absent field yields NaN, which Postgres rejects on an integer column —
    // turning a missing usage field into a failed answer.
    inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
    model: typeof reported === 'string' ? reported : model,
  };
}

/**
 * One SSE `data:` payload -> the text it carries, or null.
 *
 * EXPORTED FOR TESTING, because it is where the vendor's stream format lives
 * and because every interesting stream failure is a malformed frame. Returning
 * null for anything unrecognised is deliberate: the vendor adds event types
 * (`ping`, `message_start`, `content_block_start`) and an adapter that threw on
 * an unknown one would break on their next release rather than on ours.
 */
export function parseSseEvent(payload: string): { readonly text: string } | null {
  if (payload === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A frame we cannot parse is SKIPPED, not fatal. A truncated final frame on
    // an otherwise complete answer must not discard the answer.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (record.type === 'error') {
    // THE ONE EVENT THAT IS FATAL. The vendor reports mid-stream failures as a
    // frame rather than as a transport error, so a parser that ignored unknown
    // types would silently truncate the answer and call it complete.
    throw new DependencyError('llm', { message: 'The model reported an error mid-stream' });
  }

  if (record.type !== 'content_block_delta') return null;
  const delta = record.delta;
  if (typeof delta !== 'object' || delta === null) return null;
  const text = (delta as Record<string, unknown>).text;
  return typeof text === 'string' && text.length > 0 ? { text } : null;
}

/**
 * Turns a byte stream into SSE `data:` payloads.
 *
 * BUFFERS ACROSS CHUNK BOUNDARIES. A network chunk can split a frame mid-field,
 * and a parser that assumes whole frames per chunk works perfectly in
 * development and corrupts under real conditions — the exact hazard
 * 02-FRONTEND-IMPLEMENTATION-PLAN.md §7 warns the client about. The server side
 * has it too, and it is the same bug.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
  } finally {
    // Released even when the consumer abandons the stream — an unreleased
    // reader holds the socket open, and a `for await` that breaks early is
    // exactly what a cancelled Foxy turn does.
    reader.releaseLock();
  }
}

export function createAnthropicLlm(options: AnthropicLlmOptions): LlmProvider {
  const model = options.model ?? ANTHROPIC_MODEL;
  const baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  if (options.apiKey.trim().length === 0) {
    // At CONSTRUCTION, not at first call. A missing key discovered on the first
    // student question is an outage; discovered at boot it is a deployment that
    // refuses to start, which is the whole point of `platform/config`.
    throw new ValidationError('An API key is required to construct the language-model adapter.', {
      message: 'createAnthropicLlm: apiKey is empty',
    });
  }

  return {
    async complete(req: LlmRequest): Promise<LlmCompletion> {
      const response = await options.http.request({
        method: 'POST',
        url: `${baseUrl}/messages`,
        headers: headersFor(options.apiKey),
        body: toWireBody(req, model, false),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new DependencyError('llm', {
          // The STATUS, never the body: some providers echo the key back in
          // their error text, and the body may contain the prompt.
          message: `The model API responded ${String(response.status)}`,
          details: { status: response.status },
        });
      }

      return narrowCompletion(response.body, model);
    },

    stream(req: LlmRequest): AsyncIterable<LlmChunk> {
      async function* iterate(): AsyncGenerator<LlmChunk> {
        /**
         * D-262, step 3 of 3 — THE SIGNAL REACHES THE SOCKET.
         *
         * This is the only line in the three-file fix that actually stops
         * anything. `LlmRequest.signal` and `guarded-llm`'s controller are
         * plumbing; `fetch` honouring an `AbortSignal` by tearing down the
         * connection and erroring the `ReadableStream` is the mechanism. Until
         * this argument existed, `guarded-llm` could abort all it liked and the
         * vendor went on streaming to a reader nobody was draining.
         *
         * `complete()` needs no equivalent: it goes through `options.http`,
         * which is `createHttpClient` behind `guard.run`, and that path already
         * receives and forwards `withTimeout`'s signal.
         */
        const response = await doFetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: headersFor(options.apiKey),
          body: JSON.stringify(toWireBody(req, model, true)),
          ...(req.signal === undefined ? {} : { signal: req.signal }),
        });

        if (!response.ok) {
          throw new DependencyError('llm', {
            message: `The model API responded ${String(response.status)}`,
            details: { status: response.status },
          });
        }
        if (response.body === null) {
          throw new DependencyError('llm', { message: 'The model API returned no stream body' });
        }

        for await (const payload of readSseFrames(response.body)) {
          const chunk = parseSseEvent(payload);
          if (chunk !== null) yield chunk;
        }
      }

      return { [Symbol.asyncIterator]: iterate };
    },
  };
}
