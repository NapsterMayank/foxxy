'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toApiError } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { FoxyAction } from '@/lib/api/generated/constants/foxy';
import type {
  FoxyCitationDto,
  FoxyStreamFrameDto,
} from '@/lib/api/generated/contracts/foxy.contract';
import { foxyKeys } from '@/lib/api/query-keys';
import { apiBaseUrl, apiVersionPrefix } from '@/lib/config/env';
import { readFrames } from '../lib/sse';

/**
 * ===========================================================================
 * THE FOXY STREAMING CLIENT — 02-FRONTEND-IMPLEMENTATION-PLAN.md §7.
 *
 * Every one of §7's seven cases is handled here and named at the line that
 * handles it. They are not edge cases: five of the seven happen on a normal
 * phone on a normal network, and each one has a wrong behaviour that looks
 * reasonable while destroying something.
 *
 *   drop mid-stream        keep the partial text, offer retry. Discarding it
 *                          throws away an answer the student watched arrive.
 *   navigate away          abort. No state update on an unmounted component.
 *   send while streaming    refuse. Two interleaved streams in one message is
 *                          unrecoverable — there is no way to tell them apart
 *                          afterwards.
 *   abstention             render as an ANSWER. It is a successful response,
 *                          and showing it as an error destroys the trust the
 *                          abstention exists to build.
 *   error before a token   an error state, NOT an empty bubble.
 *   late citations         attach BY MESSAGE ID, never by position.
 *   very long answer       cap. A low-end Android must not jank.
 *
 * ---------------------------------------------------------------------------
 * THE ASSISTANT BUBBLE IS CREATED LAZILY, ON THE FIRST TOKEN.
 *
 * That single decision is what makes "error before any token" produce an error
 * state rather than an empty bubble with a spinner in it — there is nothing to
 * leave behind, because nothing was created.
 * ===========================================================================
 */

/**
 * The point at which an answer stops being an answer.
 *
 * §7 says "virtualise or cap"; a cap is one constant and virtualisation is a
 * dependency plus a scroll container, and nothing the backend can produce comes
 * near this — the model is bounded by its own token limit. It exists so that a
 * runaway or hostile stream cannot grow a React string until the tab dies.
 */
export const MAX_ANSWER_CHARS = 20_000;

export interface FoxyStreamMessage {
  /** Stable for React. Assigned locally, never from the server. */
  readonly localId: string;
  /** The server's id, once a frame has carried it. Citations match on this. */
  readonly serverId: string | null;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly citations: readonly FoxyCitationDto[];
  readonly abstained: boolean;
  readonly status: 'streaming' | 'complete' | 'failed';
  /** True when `MAX_ANSWER_CHARS` stopped the text growing. */
  readonly truncated: boolean;
}

export interface FoxySendInput {
  readonly text?: string;
  readonly action?: FoxyAction;
}

export interface FoxyStreamState {
  readonly messages: readonly FoxyStreamMessage[];
  readonly isStreaming: boolean;
  /** Set when a turn failed. Cleared by the next `send` or `retry`. */
  readonly error: ApiError | null;
  readonly send: (input: FoxySendInput) => Promise<void>;
  /** Re-sends the last input. No-op when nothing has been sent. */
  readonly retry: () => Promise<void>;
  readonly cancel: () => void;
}

/** A stream that failed after tokens arrived, versus before any did. */
const PARTIAL_FAILURE = 'The answer stopped part way through.';
const STREAM_FAILURE = 'The answer could not be delivered.';

function nextLocalId(counter: { value: number }): string {
  counter.value += 1;
  return `local-${String(counter.value)}`;
}

export function useFoxyStream(sessionId: string): FoxyStreamState {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<readonly FoxyStreamMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef<FoxySendInput | null>(null);
  const localIdCounter = useRef({ value: 0 });
  /**
   * CASE: the user navigates away. Every state setter checks this, because a
   * frame can arrive between the abort and the reader noticing it — and a
   * `setState` after unmount is both a React warning and, on a slow device, a
   * render of a screen that is gone.
   */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (!mountedRef.current) return;
    setIsStreaming(false);
    /*
     * A cancelled turn is NOT an error and the partial text stays. The student
     * chose to stop it; erasing what arrived would look like a crash.
     */
    setMessages((current) =>
      current.map((message) =>
        message.status === 'streaming' ? { ...message, status: 'complete' } : message,
      ),
    );
  }, []);

  const run = useCallback(
    async (input: FoxySendInput): Promise<void> => {
      // CASE: send while streaming. Refused rather than queued — a queue would
      // still have to decide which answer a late citation belongs to.
      if (abortRef.current !== null) return;

      lastInputRef.current = input;
      setError(null);
      setIsStreaming(true);

      const userMessage: FoxyStreamMessage = {
        localId: nextLocalId(localIdCounter.current),
        serverId: null,
        role: 'user',
        text: input.text ?? '',
        citations: [],
        abstained: false,
        status: 'complete',
        truncated: false,
      };
      setMessages((current) => [...current, userMessage]);

      const controller = new AbortController();
      abortRef.current = controller;

      /** The assistant bubble, created on the first frame that has content. */
      let assistantLocalId: string | null = null;
      let sawToken = false;
      /**
       * Whether the turn reached a definite end — `done`, an abstention, or an
       * `error` frame.
       *
       * A PLAIN LOCAL, and it has to be. The obvious alternative is to look at
       * the messages afterwards and see whether anything is still `streaming`,
       * which does not work: a `setMessages` updater runs during React's render
       * pass, not at the call site, so a flag set inside one is still false on
       * the next line. That mistake produces a stream that drops silently —
       * the exact failure §7 says must never happen.
       */
      let settled = false;

      const ensureAssistant = (): string => {
        if (assistantLocalId !== null) return assistantLocalId;
        const localId = nextLocalId(localIdCounter.current);
        assistantLocalId = localId;
        setMessages((current) => [
          ...current,
          {
            localId,
            serverId: null,
            role: 'assistant',
            text: '',
            citations: [],
            abstained: false,
            status: 'streaming',
            truncated: false,
          },
        ]);
        return localId;
      };

      const updateAssistant = (
        change: (message: FoxyStreamMessage) => FoxyStreamMessage,
        localId: string,
      ): void => {
        if (!mountedRef.current) return;
        setMessages((current) =>
          current.map((message) => (message.localId === localId ? change(message) : message)),
        );
      };

      const applyFrame = (frame: FoxyStreamFrameDto): void => {
        switch (frame.type) {
          case 'token': {
            sawToken = true;
            const localId = ensureAssistant();
            updateAssistant((message) => {
              if (message.text.length >= MAX_ANSWER_CHARS) {
                return message.truncated ? message : { ...message, truncated: true };
              }
              const text = (message.text + frame.text).slice(0, MAX_ANSWER_CHARS);
              return { ...message, text, truncated: text.length >= MAX_ANSWER_CHARS };
            }, localId);
            return;
          }

          case 'abstention': {
            settled = true;
            // CASE: the server abstains. A COMPLETE, SUCCESSFUL ANSWER. It gets
            // the assistant's own styling; `abstained` is for wording, not for
            // an error treatment.
            const localId = ensureAssistant();
            updateAssistant(
              (message) => ({
                ...message,
                serverId: frame.messageId,
                text: frame.text,
                abstained: true,
                status: 'complete',
              }),
              localId,
            );
            return;
          }

          case 'citation': {
            /*
             * CASE: citations arrive after the text. Matched on `messageId` and
             * NEVER on arrival position — position is only correct while
             * exactly one turn is in flight and nothing was dropped, which is
             * the condition under which every ordering bug looks fine.
             */
            if (!mountedRef.current) return;
            setMessages((current) =>
              current.map((message) => {
                const matchesServerId = message.serverId === frame.messageId;
                const isUnclaimedInFlight =
                  message.serverId === null &&
                  message.status === 'streaming' &&
                  message.localId === assistantLocalId;
                if (!matchesServerId && !isUnclaimedInFlight) return message;
                return {
                  ...message,
                  // The first frame carrying an id is what binds the bubble to
                  // the stored message; every later citation matches on it.
                  serverId: frame.messageId,
                  citations: [...message.citations, frame.citation],
                };
              }),
            );
            return;
          }

          case 'done': {
            settled = true;
            if (assistantLocalId !== null) {
              updateAssistant(
                (message) => ({
                  ...message,
                  serverId: frame.messageId,
                  abstained: message.abstained || frame.abstained,
                  status: message.status === 'failed' ? 'failed' : 'complete',
                }),
                assistantLocalId,
              );
            }
            return;
          }

          case 'error': {
            /*
             * A MID-STREAM FAILURE IS A FRAME, NOT A STATUS CODE. By the time
             * the stream has begun the response is committed with a 200 and
             * there is no status left to change — so `partial` is the only
             * thing distinguishing "failed before saying anything" from "failed
             * halfway", and §7 gives those two different behaviours.
             */
            settled = true;
            if (!mountedRef.current) return;
            if (frame.partial && assistantLocalId !== null) {
              updateAssistant((message) => ({ ...message, status: 'failed' }), assistantLocalId);
            }
            setError(
              new ApiError({
                status: 200,
                code: 'UNKNOWN',
                message: frame.partial ? PARTIAL_FAILURE : STREAM_FAILURE,
                method: 'POST',
              }),
            );
            return;
          }

          default:
            // An unrecognised frame type. IGNORED, so the backend can add one
            // without breaking clients already in the field (§7).
            return;
        }
      };

      try {
        const response = await fetch(
          `${apiBaseUrl}${apiVersionPrefix}/foxy/sessions/${encodeURIComponent(sessionId)}/messages`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify(input),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          // CASE: the server rejects BEFORE any byte of the stream — a daily
          // cap, an invalid session, a safety refusal. The error goes through
          // the same typed path as every other request, so §5.6's table
          // applies. No assistant bubble was created.
          throw await toApiError(response, 'POST');
        }
        if (response.body === null) {
          throw new ApiError({ status: 200, code: 'UNKNOWN', message: STREAM_FAILURE, method: 'POST' });
        }

        await readFrames(response.body, applyFrame);

        /*
         * CASE: the connection drops mid-stream. The body ended with no `done`,
         * no abstention and no `error` frame — which is what a dropped
         * connection looks like from the reader's side, and is otherwise
         * indistinguishable from a completed answer.
         *
         * The text STAYS VISIBLE and the turn is retryable. It also covers a
         * body that closes having said nothing at all, where there is no bubble
         * to mark and only the error state to show.
         */
        if (!settled && mountedRef.current) {
          if (assistantLocalId !== null) {
            updateAssistant((message) => ({ ...message, status: 'failed' }), assistantLocalId);
          }
          setError(
            new ApiError({
              status: 200,
              code: 'UNKNOWN',
              message: assistantLocalId === null ? STREAM_FAILURE : PARTIAL_FAILURE,
              method: 'POST',
            }),
          );
        }
      } catch (cause) {
        // An abort is the user's own doing — `cancel` already settled the
        // state, and reporting it as a failure would put an error under a
        // message they chose to stop.
        const aborted = cause instanceof DOMException && cause.name === 'AbortError';
        if (!aborted && mountedRef.current) {
          if (sawToken && assistantLocalId !== null) {
            updateAssistant((message) => ({ ...message, status: 'failed' }), assistantLocalId);
          }
          setError(
            cause instanceof ApiError
              ? cause
              : new ApiError({
                  status: 0,
                  code: 'UNKNOWN',
                  message: sawToken ? PARTIAL_FAILURE : STREAM_FAILURE,
                  method: 'POST',
                }),
          );
        }
      } finally {
        abortRef.current = null;
        if (mountedRef.current) {
          setIsStreaming(false);
          /*
           * The turn is stored server-side, so the cached session is now stale.
           * Invalidating rather than hand-writing the message into the cache
           * keeps ONE definition of what a stored turn looks like — the
           * server's — and a refresh shows exactly what a reload would.
           */
          void queryClient.invalidateQueries({ queryKey: foxyKeys.session(sessionId) });
        }
      }
    },
    [queryClient, sessionId],
  );

  const send = useCallback((input: FoxySendInput) => run(input), [run]);

  const retry = useCallback(async (): Promise<void> => {
    const last = lastInputRef.current;
    if (last === null) return;
    /*
     * THE WHOLE FAILED TURN IS DROPPED, question included — not just the
     * assistant bubble.
     *
     * `run` appends the user message itself, so removing only the failed answer
     * would leave the question on screen and then add it a second time. The
     * student sees their own words twice and no explanation, which reads as the
     * app having lost track of the conversation.
     */
    setMessages((current) => {
      const withoutFailed = current.filter((message) => message.status !== 'failed');
      const tail = withoutFailed.at(-1);
      return tail?.role === 'user' ? withoutFailed.slice(0, -1) : withoutFailed;
    });
    await run(last);
  }, [run]);

  return { messages, isStreaming, error, send, retry, cancel };
}
