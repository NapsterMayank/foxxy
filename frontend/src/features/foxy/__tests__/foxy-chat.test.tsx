import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderClient as render } from '@test/setup/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoxyChat } from '../foxy-chat';

/**
 * ===========================================================================
 * THE FOXY SCREEN, END TO END WITHOUT A NETWORK — build-order step 9.
 *
 * The pieces are tested in isolation elsewhere; what only this file can check
 * is that they are WIRED to each other and to the two shapes the server sends:
 * a JSON capabilities document, and an SSE body arriving in pieces.
 *
 * `fetch` is driven by URL rather than by call order, because the screen issues
 * capabilities, transcript and stream requests concurrently and an
 * order-dependent fake would be asserting React's scheduling.
 * ===========================================================================
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

let search = new URLSearchParams();
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => '/student/foxy',
}));

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function capabilities(remaining = 18) {
  return {
    modes: [{ code: 'doubt' }, { code: 'explain' }, { code: 'practice' }],
    actions: [{ code: 'simpler', label: { en: 'Explain more simply', hi: 'और आसान भाषा में' } }],
    usage: { plan: 'free', used: 20 - remaining, limit: 20, remaining },
  };
}

function encodeFrame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A body the test pushes into, so partial arrival is the thing under test. */
function controllableStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    body,
    push: async (text: string) => {
      await act(async () => {
        controller.enqueue(encoder.encode(text));
        await Promise.resolve();
      });
    },
    close: async () => {
      await act(async () => {
        controller.close();
        await Promise.resolve();
      });
    },
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every route the screen can call, answered by URL. */
function route(
  handlers: {
    capabilities?: () => Response;
    transcript?: () => Response;
    stream?: () => Response;
    startSession?: () => Response;
  } = {},
) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/foxy/capabilities')) {
      return Promise.resolve((handlers.capabilities ?? (() => json(capabilities())))());
    }
    if (url.includes('/messages')) {
      return Promise.resolve((handlers.stream ?? (() => json({})))());
    }
    if (url.endsWith('/foxy/sessions') && init?.method === 'POST') {
      return Promise.resolve(
        (handlers.startSession ??
          (() =>
            json(
              {
                session: {
                  id: SESSION_ID,
                  mode: 'doubt',
                  subject: 'science',
                  chapterId: null,
                  language: 'en',
                  startedAt: '2026-08-14T09:00:00.000Z',
                  lastMessageAt: null,
                },
              },
              201,
            )))(),
      );
    }
    return Promise.resolve(
      (handlers.transcript ??
        (() =>
          json({
            session: {
              id: SESSION_ID,
              mode: 'doubt',
              subject: 'science',
              chapterId: null,
              language: 'en',
              startedAt: '2026-08-14T09:00:00.000Z',
              lastMessageAt: null,
            },
            messages: [],
          })))(),
    );
  });
}

/** Opens the screen on an existing conversation, as a refresh would. */
function openSession(): void {
  search = new URLSearchParams(`session=${SESSION_ID}`);
}

describe('starting a conversation', () => {
  it('offers the start panel before a session exists', async () => {
    route();
    render(<FoxyChat />);

    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
  });

  /*
   * THE ID GOES INTO THE URL, not into component state. §7 point 5 asks that a
   * refresh show the same history, and a refresh with the id in `useState`
   * drops the student back here with their turns stranded on the server.
   */
  it('puts the new session in the URL so a refresh can resume it', async () => {
    route();
    render(<FoxyChat />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(`/student/foxy?session=${SESSION_ID}`);
    });
  });

  it('says so when the conversation could not be started, and stays on the panel', async () => {
    route({ startSession: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    render(<FoxyChat />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));

    /*
     * "The conversation could not be started" and NOT the turn wording. Nothing
     * had started, so an "the answer stopped part way" sentence would describe
     * an event that never happened — the defect this assertion caught.
     */
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The conversation could not be started. Try again.',
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });
});

describe('a turn, from typing to citation', () => {
  it('streams tokens into a bubble and attaches the citation that follows', async () => {
    const stream = controllableStream();
    openSession();
    route({ stream: () => ({ ok: true, status: 200, body: stream.body }) as unknown as Response });

    render(<FoxyChat />);

    const box = await screen.findByLabelText('Your question');
    fireEvent.change(box, { target: { value: 'What is photosynthesis?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The student's own words appear immediately, before any frame arrives.
    expect(await screen.findByText('What is photosynthesis?')).toBeInTheDocument();

    await stream.push(encodeFrame('token', { text: 'Plants make ' }));
    await stream.push(encodeFrame('token', { text: 'their own food.' }));

    expect(await screen.findByText('Plants make their own food.')).toBeInTheDocument();
    expect(screen.getByTestId('foxy-streaming')).toBeInTheDocument();

    // §7: citations arrive AFTER the text and attach by message id.
    await stream.push(
      encodeFrame('citation', {
        messageId: 'm1',
        citation: { chunkId: 'c1', chapterNumber: 6, chapterTitle: 'Life Processes' },
      }),
    );
    await stream.push(encodeFrame('done', { messageId: 'm1', abstained: false }));
    await stream.close();

    expect(await screen.findByText('Chapter 6: Life Processes')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('foxy-streaming')).not.toBeInTheDocument();
    });
  });

  /*
   * §7: "connection drops mid-stream — keep the partial text visible and offer
   * retry. NEVER SILENTLY DISCARD IT." The screen's half of that promise is
   * that the error goes BESIDE the transcript and does not replace it.
   */
  it('keeps a half-finished answer on screen and offers retry beside it', async () => {
    const stream = controllableStream();
    openSession();
    route({ stream: () => ({ ok: true, status: 200, body: stream.body }) as unknown as Response });

    render(<FoxyChat />);

    fireEvent.change(await screen.findByLabelText('Your question'), {
      target: { value: 'Explain fractions' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await stream.push(encodeFrame('token', { text: 'A fraction is' }));
    // The body ends with no `done`, no abstention and no error frame — which is
    // exactly what a dropped connection looks like from the reader's side.
    await stream.close();

    expect(await screen.findByRole('alert')).toHaveTextContent('Foxy could not answer');
    expect(screen.getByText('A fraction is')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders an abstention as an answer, with no retry offered', async () => {
    const stream = controllableStream();
    openSession();
    route({ stream: () => ({ ok: true, status: 200, body: stream.body }) as unknown as Response });

    render(<FoxyChat />);

    fireEvent.change(await screen.findByLabelText('Your question'), {
      target: { value: 'Who won the 2026 election?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await stream.push(
      encodeFrame('abstention', {
        messageId: 'm1',
        reason: 'not_in_corpus',
        text: 'I could not find this in your textbook.',
      }),
    );
    await stream.close();

    expect(await screen.findByText('Not found in your textbook')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  /*
   * A rejection BEFORE the stream begins is an ordinary typed error and must
   * produce no bubble at all — §7's "error before any token: error state, not
   * an empty bubble".
   */
  it('reports a pre-stream rejection without leaving an empty bubble behind', async () => {
    openSession();
    route({
      stream: () =>
        json({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'too fast' } }, 429),
    });

    render(<FoxyChat />);

    fireEvent.change(await screen.findByLabelText('Your question'), {
      target: { value: 'Another question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That was quick.');
    // One article: the student's question. No assistant bubble was created.
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('sends the action code when a button is pressed, not free text', async () => {
    const stream = controllableStream();
    openSession();
    route({ stream: () => ({ ok: true, status: 200, body: stream.body }) as unknown as Response });

    render(<FoxyChat />);

    fireEvent.click(await screen.findByRole('button', { name: 'Explain more simply' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/messages'));
      expect(call).toBeDefined();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ action: 'simpler' });
    });

    await stream.close();
  });
});

describe('the daily allowance', () => {
  it('states what is left before it runs out', async () => {
    openSession();
    route({ capabilities: () => json(capabilities(3)) });

    render(<FoxyChat />);

    expect(await screen.findByTestId('foxy-usage')).toHaveTextContent(
      '3 of 20 messages left today',
    );
  });

  /*
   * The cap is stated as a FACT FROM THE SERVER and enforced before a turn is
   * attempted. It is not inferred from a rate-limit error, because the backend
   * raises the allowance refusal and a pace limit as the same code — see the
   * header of `foxy-messages.ts`.
   */
  it('closes the composer and the buttons when nothing is left', async () => {
    openSession();
    route({ capabilities: () => json(capabilities(0)) });

    render(<FoxyChat />);

    expect(await screen.findByTestId('foxy-usage')).toHaveTextContent(
      'You have used all of today’s messages.',
    );
    expect(screen.getByLabelText('Your question')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Explain more simply' })).toBeDisabled();
  });
});

describe('the screen’s own failures', () => {
  it('cannot render without capabilities, and says so with a retry', async () => {
    route({
      capabilities: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
    });

    render(<FoxyChat />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Foxy could not load.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the stored transcript when a refresh reopens a conversation', async () => {
    openSession();
    route({
      transcript: () =>
        json({
          session: {
            id: SESSION_ID,
            mode: 'doubt',
            subject: 'science',
            chapterId: null,
            language: 'en',
            startedAt: '2026-08-14T09:00:00.000Z',
            lastMessageAt: '2026-08-14T09:05:00.000Z',
          },
          messages: [
            {
              id: 'm-old',
              role: 'user',
              text: 'What is a cell?',
              action: null,
              citations: [],
              abstained: false,
              createdAt: '2026-08-14T09:04:00.000Z',
            },
            {
              id: 'm-old-a',
              role: 'assistant',
              text: 'A cell is the smallest unit of life.',
              action: null,
              citations: [],
              abstained: false,
              createdAt: '2026-08-14T09:05:00.000Z',
            },
          ],
        }),
    });

    render(<FoxyChat />);

    expect(await screen.findByText('A cell is the smallest unit of life.')).toBeInTheDocument();
    expect(screen.getByText('What is a cell?')).toBeInTheDocument();
  });

  it('invites a first question when a new conversation has none', async () => {
    openSession();
    route();

    render(<FoxyChat />);

    expect(await screen.findByText('Ask your first question')).toBeInTheDocument();
  });
});
