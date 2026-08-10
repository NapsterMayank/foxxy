import { describe, expect, it } from 'vitest';
import { DependencyError, ValidationError } from '../../errors/index';
import type { HttpClient, HttpRequest, HttpResponse } from '../../http/index';
import {
  ANTHROPIC_MODEL,
  ANTHROPIC_VERSION,
  createAnthropicLlm,
  parseSseEvent,
  readSseFrames,
} from '../anthropic-llm';
import type { LlmRequest } from '../llm.port';

/**
 * THE REAL ADAPTER, FULLY TESTED, WITH NO API KEY AND NO NETWORK.
 *
 * Every test here drives a recording `HttpClient` or an injected `fetch`.
 * Nothing in this file can reach a vendor; if it ever could, the suite would
 * start costing money per run and would fail on a machine with no key — which
 * is the state of every machine today, and the reason the fake exists.
 *
 * This mirrors `platform/embed/__tests__/voyage-embed.test.ts` deliberately.
 * Two different patterns for "a paid dependency we cannot call yet" is how one
 * of them rots.
 */

interface Recorded {
  readonly requests: HttpRequest[];
}

function fakeHttp(
  respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): HttpClient & Recorded {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      return await respond(req);
    },
  };
}

function completionBody(text = 'Refraction is the bending of light.'): string {
  return JSON.stringify({
    id: 'msg_1',
    model: ANTHROPIC_MODEL,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 120, output_tokens: 42 },
  });
}

const REQUEST: LlmRequest = {
  messages: [
    { role: 'system', content: 'You are Foxy.' },
    { role: 'user', content: 'what is refraction' },
  ],
  maxTokens: 512,
  temperature: 0.3,
};

/** A `Response`-shaped object carrying a byte stream, with no network. */
function streamingResponse(frames: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function textDelta(text: string): string {
  return sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
}

async function collect(iterable: AsyncIterable<{ readonly text: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) out.push(chunk.text);
  return out;
}

describe('the language-model adapter — construction', () => {
  it('refuses to be constructed without a key, at construction rather than at first call', () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: completionBody() }));
    expect(() => createAnthropicLlm({ http, apiKey: '   ' })).toThrow(ValidationError);
  });
});

describe('the language-model adapter — complete()', () => {
  it('returns the text and the token counts from a well-formed response', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: completionBody() }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });

    const completion = await llm.complete(REQUEST);

    expect(completion.text).toBe('Refraction is the bending of light.');
    expect(completion.inputTokens).toBe(120);
    expect(completion.outputTokens).toBe(42);
    expect(completion.model).toBe(ANTHROPIC_MODEL);
  });

  it('sends the system prompt as a top-level field, not as a message', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: completionBody() }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });

    await llm.complete(REQUEST);

    const body = http.requests[0]?.body as Record<string, unknown>;
    expect(body.system).toBe('You are Foxy.');
    expect(body.messages).toEqual([{ role: 'user', content: 'what is refraction' }]);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.3);
  });

  it('sends the version header and the key header the API requires', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: completionBody() }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });

    await llm.complete(REQUEST);

    expect(http.requests[0]?.headers?.['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(http.requests[0]?.headers?.['x-api-key']).toBe('test-key');
  });

  it('does NOT mark the completion POST idempotent — a repeat is a charge, not a free retry', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: completionBody() }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });

    await llm.complete(REQUEST);

    expect(http.requests[0]?.idempotent).toBeUndefined();
  });

  it('raises a DependencyError carrying the status and NOT the body on a non-2xx', async () => {
    const http = fakeHttp(() => ({
      status: 401,
      headers: {},
      body: 'invalid x-api-key: sk-secret-value',
    }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });

    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(DependencyError);
    await expect(llm.complete(REQUEST)).rejects.toMatchObject({
      details: { status: 401 },
    });
    // The body echoed the key back. It must not travel with the error.
    await llm.complete(REQUEST).catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain('sk-secret-value');
    });
  });

  it('raises rather than narrowing a body that is not JSON', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: '<html>gateway</html>' }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });
    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(DependencyError);
  });

  it('raises when the response has no content array', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: {}, body: JSON.stringify({ id: 'x' }) }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });
    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(DependencyError);
  });

  it('refuses an EMPTY completion rather than showing a student an empty bubble', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ content: [{ type: 'text', text: '' }] }),
    }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });
    await expect(llm.complete(REQUEST)).rejects.toBeInstanceOf(DependencyError);
  });

  it('reports zero tokens rather than NaN when usage is absent', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ content: [{ type: 'text', text: 'hello' }] }),
    }));
    const llm = createAnthropicLlm({ http, apiKey: 'test-key' });

    const completion = await llm.complete(REQUEST);

    expect(completion.inputTokens).toBe(0);
    expect(completion.outputTokens).toBe(0);
    expect(Number.isNaN(completion.outputTokens)).toBe(false);
  });
});

describe('the language-model adapter — stream()', () => {
  it('yields the text of every delta frame, in order', async () => {
    const llm = createAnthropicLlm({
      http: fakeHttp(() => ({ status: 200, headers: {}, body: '' })),
      apiKey: 'test-key',
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          streamingResponse([
            sse({ type: 'message_start' }),
            textDelta('Refraction '),
            textDelta('bends '),
            textDelta('light.'),
            sse({ type: 'message_stop' }),
          ]),
        ),
    });

    expect(await collect(llm.stream(REQUEST))).toEqual(['Refraction ', 'bends ', 'light.']);
  });

  it('buffers a frame SPLIT ACROSS CHUNK BOUNDARIES rather than corrupting it', async () => {
    const whole = textDelta('Refraction bends light.');
    const cut = Math.floor(whole.length / 2);
    const llm = createAnthropicLlm({
      http: fakeHttp(() => ({ status: 200, headers: {}, body: '' })),
      apiKey: 'test-key',
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(streamingResponse([whole.slice(0, cut), whole.slice(cut)])),
    });

    expect(await collect(llm.stream(REQUEST))).toEqual(['Refraction bends light.']);
  });

  it('raises on a non-2xx before any token is yielded', async () => {
    const llm = createAnthropicLlm({
      http: fakeHttp(() => ({ status: 200, headers: {}, body: '' })),
      apiKey: 'test-key',
      fetchImpl: (): Promise<Response> => Promise.resolve(streamingResponse([], 503)),
    });

    await expect(collect(llm.stream(REQUEST))).rejects.toBeInstanceOf(DependencyError);
  });

  it('raises when the response carries no stream body', async () => {
    const llm = createAnthropicLlm({
      http: fakeHttp(() => ({ status: 200, headers: {}, body: '' })),
      apiKey: 'test-key',
      fetchImpl: (): Promise<Response> => Promise.resolve(new Response(null, { status: 200 })),
    });

    await expect(collect(llm.stream(REQUEST))).rejects.toBeInstanceOf(DependencyError);
  });

  it('raises on a mid-stream error frame — the tokens before it are still yielded', async () => {
    const llm = createAnthropicLlm({
      http: fakeHttp(() => ({ status: 200, headers: {}, body: '' })),
      apiKey: 'test-key',
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          streamingResponse([
            textDelta('Refraction '),
            sse({ type: 'error', error: { type: 'overloaded_error' } }),
            textDelta('never arrives'),
          ]),
        ),
    });

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of llm.stream(REQUEST)) seen.push(chunk.text);
      })(),
    ).rejects.toBeInstanceOf(DependencyError);
    expect(seen).toEqual(['Refraction ']);
  });
});

describe('parseSseEvent — the vendor format, isolated', () => {
  it('skips an unrecognised event type rather than throwing on it', () => {
    expect(parseSseEvent(JSON.stringify({ type: 'ping' }))).toBeNull();
    expect(parseSseEvent(JSON.stringify({ type: 'content_block_start' }))).toBeNull();
  });

  it('skips an unparseable frame rather than discarding a complete answer', () => {
    expect(parseSseEvent('{"type":"content_bl')).toBeNull();
  });

  it('skips the [DONE] sentinel', () => {
    expect(parseSseEvent('[DONE]')).toBeNull();
  });

  it('skips a delta with no text and a delta whose text is empty', () => {
    expect(parseSseEvent(JSON.stringify({ type: 'content_block_delta', delta: {} }))).toBeNull();
    expect(
      parseSseEvent(JSON.stringify({ type: 'content_block_delta', delta: { text: '' } })),
    ).toBeNull();
    expect(
      parseSseEvent(JSON.stringify({ type: 'content_block_delta', delta: null })),
    ).toBeNull();
  });

  it('skips a payload that parses to something that is not an object', () => {
    expect(parseSseEvent('42')).toBeNull();
    expect(parseSseEvent('null')).toBeNull();
  });

  it('throws on the error event, which is the one frame that is fatal', () => {
    expect(() => parseSseEvent(JSON.stringify({ type: 'error' }))).toThrow(DependencyError);
  });
});

describe('readSseFrames — the transport, isolated', () => {
  it('ignores lines that are not `data:`', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode('event: ping\nid: 7\ndata: {"a":1}\n\n'));
        controller.close();
      },
    });

    const frames: string[] = [];
    for await (const frame of readSseFrames(body)) frames.push(frame);

    expect(frames).toEqual(['{"a":1}']);
  });

  it('releases the reader when the consumer abandons the stream early', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode('data: one\n\ndata: two\n\n'));
        controller.close();
      },
    });

    for await (const frame of readSseFrames(body)) {
      expect(frame).toBe('one');
      break;
    }

    // A second reader can only be acquired if the first was released.
    expect(() => body.getReader()).not.toThrow();
  });
});
