import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFoxyStream, MAX_ANSWER_CHARS } from '../hooks/use-foxy-stream';

/**
 * ===========================================================================
 * EVERY CASE IN PLAN §7 IS A TEST HERE. That is the plan's own instruction:
 * "cases that must be handled — each one is a test".
 *
 * The hook is driven through a REAL `ReadableStream` and a real `fetch` shape,
 * because the failures worth catching are all about arrival timing: a frame
 * split across chunks, a body that ends without `done`, a citation that lands
 * after the text it belongs to. A hand-rolled "call the frame handler" fake
 * cannot express any of them.
 * ===========================================================================
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function encodeFrame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A stream the test pushes into, so arrival order is the thing under test. */
function controllableStream(): {
  body: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
  fail: (error: Error) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    body,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function streamingResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

function rejectedResponse(status: number, code: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve({ error: { code, message: 'safe message' } }),
  } as unknown as Response;
}

describe('the ordinary turn', () => {
  it('appends tokens and completes on done', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'What is photosynthesis?' });
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('token', { text: 'Plants ' }));
      stream.push(encodeFrame('token', { text: 'make food.' }));
    });

    await waitFor(() => {
      expect(result.current.messages.at(-1)?.text).toBe('Plants make food.');
    });

    act(() => {
      stream.push(encodeFrame('done', { messageId: 'server-1', abstained: false }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    const [question, answer] = result.current.messages;
    expect(question).toMatchObject({ role: 'user', text: 'What is photosynthesis?' });
    expect(answer).toMatchObject({
      role: 'assistant',
      text: 'Plants make food.',
      status: 'complete',
      serverId: 'server-1',
    });
    expect(result.current.error).toBeNull();
  });
});

describe('CASE: the connection drops mid-stream', () => {
  it('keeps the partial text visible and offers retry', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'why' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('token', { text: 'Because the ' }));
    });
    await waitFor(() => {
      expect(result.current.messages.at(-1)?.text).toBe('Because the ');
    });

    // The body simply ends. No `done`, no `error` — what a dropped connection
    // actually looks like from the reader's side.
    act(() => {
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    // NEVER SILENTLY DISCARDED. The student watched these words arrive.
    expect(result.current.messages.at(-1)).toMatchObject({
      text: 'Because the ',
      status: 'failed',
    });
  });
});

describe('CASE: the user sends again while streaming', () => {
  it('refuses the second send rather than interleaving two streams', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'first' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      void result.current.send({ text: 'second' });
    });

    // One request, one user message. Two interleaved streams in one bubble
    // cannot be untangled afterwards, so the second is refused at the door.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});

describe('CASE: the server abstains', () => {
  it('renders the abstention as an answer, not an error', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'who won the match' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(
        encodeFrame('abstention', {
          messageId: 'server-9',
          reason: 'not_in_corpus',
          text: 'I could not find this in your textbook.',
        }),
      );
      stream.push(encodeFrame('done', { messageId: 'server-9', abstained: true }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    /*
     * A SUCCESSFUL ANSWER. `error` stays null and the message completes — an
     * abstention rendered as a failure destroys exactly the trust that
     * abstaining exists to build.
     */
    expect(result.current.error).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({
      role: 'assistant',
      abstained: true,
      status: 'complete',
      text: 'I could not find this in your textbook.',
    });
  });
});

describe('CASE: the server errors before any token', () => {
  it('leaves no empty assistant bubble behind', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'hello' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('error', { code: 'model_unavailable', partial: false }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.messages.filter((message) => message.role === 'assistant')).toHaveLength(
      0,
    );
  });

  it('turns a pre-stream rejection into a typed ApiError', async () => {
    // A daily cap, a bad session, a safety refusal — refused before the stream
    // opens, so it comes back as an ordinary status code and must reach §5.6's
    // treatment table like any other request.
    fetchMock.mockResolvedValue(rejectedResponse(429, 'RATE_LIMIT_EXCEEDED'));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    await act(async () => {
      await result.current.send({ text: 'again' });
    });

    expect(result.current.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(result.current.messages.filter((message) => message.role === 'assistant')).toHaveLength(
      0,
    );
  });
});

describe('CASE: citations arrive after the text', () => {
  it('attaches them by message id, not by position', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'explain' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('token', { text: 'Photosynthesis.' }));
      stream.push(
        encodeFrame('citation', {
          messageId: 'server-7',
          citation: { chunkId: 'c1', chapterNumber: 4, chapterTitle: 'Plants' },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.messages.at(-1)?.citations).toHaveLength(1);
    });

    // The id from the citation frame binds the bubble to the stored message,
    // and a SECOND citation for the same id must still land on it.
    act(() => {
      stream.push(
        encodeFrame('citation', {
          messageId: 'server-7',
          citation: { chunkId: 'c2', chapterNumber: 5, chapterTitle: 'Food' },
        }),
      );
      stream.push(encodeFrame('done', { messageId: 'server-7', abstained: false }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      serverId: 'server-7',
      citations: [
        { chunkId: 'c1', chapterNumber: 4, chapterTitle: 'Plants' },
        { chunkId: 'c2', chapterNumber: 5, chapterTitle: 'Food' },
      ],
    });
  });
});

describe('CASE: a very long answer', () => {
  it('caps the text rather than growing without bound', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'everything' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    const chunk = 'x'.repeat(5_000);
    act(() => {
      for (let index = 0; index < 6; index += 1) {
        stream.push(encodeFrame('token', { text: chunk }));
      }
    });

    await waitFor(() => {
      expect(result.current.messages.at(-1)?.truncated).toBe(true);
    });
    expect(result.current.messages.at(-1)?.text).toHaveLength(MAX_ANSWER_CHARS);
  });
});

describe('CASE: the user navigates away', () => {
  it('aborts the request on unmount', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result, unmount } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'leaving' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    const signal = (fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('cancelling keeps what arrived and reports no error', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'stop halfway' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('token', { text: 'Half an answer' }));
    });
    await waitFor(() => {
      expect(result.current.messages.at(-1)?.text).toBe('Half an answer');
    });

    act(() => {
      result.current.cancel();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
    // The student chose to stop it. Erasing the text would look like a crash.
    expect(result.current.error).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({
      text: 'Half an answer',
      status: 'complete',
    });
  });
});

describe('frames that must not break the stream', () => {
  it('ignores an unrecognised frame type and keeps going', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });
    act(() => {
      void result.current.send({ text: 'hi' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      // A sixth frame type from a newer backend. Deployed clients must survive
      // it — that guarantee is why the parser drops unknown types.
      stream.push(encodeFrame('telemetry', { latencyMs: 12 }));
      stream.push(encodeFrame('token', { text: 'still here' }));
      stream.push(encodeFrame('done', { messageId: 'server-1', abstained: false }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      text: 'still here',
      status: 'complete',
    });
    expect(result.current.error).toBeNull();
  });

  it('ignores a citation addressed to a different message', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });
    act(() => {
      void result.current.send({ text: 'hi' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('token', { text: 'answer' }));
      stream.push(
        encodeFrame('citation', {
          messageId: 'server-1',
          citation: { chunkId: 'mine', chapterNumber: 1, chapterTitle: 'A' },
        }),
      );
      // Now bound to server-1. A citation for another message is not ours.
      stream.push(
        encodeFrame('citation', {
          messageId: 'server-OTHER',
          citation: { chunkId: 'theirs', chapterNumber: 2, chapterTitle: 'B' },
        }),
      );
      stream.push(encodeFrame('done', { messageId: 'server-1', abstained: false }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
    expect(result.current.messages.at(-1)?.citations).toEqual([
      { chunkId: 'mine', chapterNumber: 1, chapterTitle: 'A' },
    ]);
  });

  it('treats a done with no content as a completed turn, not an error', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });
    act(() => {
      void result.current.send({ text: 'hi' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.push(encodeFrame('done', { messageId: 'server-1', abstained: false }));
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('reports a stream failure when the body closes having said nothing', async () => {
    const stream = controllableStream();
    fetchMock.mockResolvedValue(streamingResponse(stream.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });
    act(() => {
      void result.current.send({ text: 'hi' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      stream.close();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    // No bubble to mark failed, so only the error state carries it.
    expect(result.current.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('errors when the response carries no body at all', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response);

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });
    await act(async () => {
      await result.current.send({ text: 'hi' });
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it('reports a transport failure without leaving the UI streaming', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });
    await act(async () => {
      await result.current.send({ text: 'hi' });
    });

    expect(result.current.error?.status).toBe(0);
    expect(result.current.isStreaming).toBe(false);
  });
});

describe('retry', () => {
  it('does nothing when nothing has been sent', async () => {
    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    await act(async () => {
      await result.current.retry();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancelling with nothing in flight is a no-op', () => {
    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      result.current.cancel();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages).toEqual([]);
  });


  it('drops the whole failed turn so the question is not asked twice on screen', async () => {
    const failing = controllableStream();
    const succeeding = controllableStream();
    fetchMock
      .mockResolvedValueOnce(streamingResponse(failing.body))
      .mockResolvedValueOnce(streamingResponse(succeeding.body));

    const { result } = renderHook(() => useFoxyStream(SESSION_ID), { wrapper });

    act(() => {
      void result.current.send({ text: 'ask once' });
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });
    act(() => {
      failing.push(encodeFrame('token', { text: 'partial' }));
      failing.close();
    });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    act(() => {
      void result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    act(() => {
      succeeding.push(encodeFrame('token', { text: 'a real answer' }));
      succeeding.push(encodeFrame('done', { messageId: 'server-2', abstained: false }));
      succeeding.close();
    });
    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    expect(result.current.messages.map((message) => message.text)).toEqual([
      'ask once',
      'a real answer',
    ]);
  });
});
