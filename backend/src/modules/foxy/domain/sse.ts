import type { FoxyFrameType } from '@/shared/constants/foxy';
import type { AbstentionReason } from './abstention';
import type { Citation } from './citations';

/**
 * THE SSE WIRE FORMAT — 02-FRONTEND-IMPLEMENTATION-PLAN.md §7.
 *
 * ===========================================================================
 * FIVE FRAME TYPES, AND `abstention` IS NOT `error`.
 *
 *   token       one piece of the answer. Append it.
 *   citation    a verified reference. Attach it BY MESSAGE ID, never by
 *               position — §7's own rule, and the reason `messageId` is on the
 *               frame rather than implied by arrival order.
 *   abstention  a complete, successful answer that says "I could not find this
 *               in your textbook". Renders as an answer. No retry button.
 *   done        the turn is over. Carries the message id so the client can
 *               reconcile what it built with what was stored.
 *   error       something failed. May arrive AFTER tokens, in which case the
 *               tokens already shown are correct and must be kept.
 *
 * The client ignores an unrecognised type rather than throwing, so a sixth
 * frame can be added without breaking a deployed app. That guarantee only means
 * anything if this file is the single definition of the five that exist today,
 * which is why the type list lives in `shared/` and is imported here.
 * ===========================================================================
 *
 * ===========================================================================
 * A MID-STREAM FAILURE IS AN `error` FRAME FOLLOWED BY `done` — NEVER A 500.
 *
 * §8.5: "a mid-stream model failure yields a graceful partial response rather
 * than a 500". By the time a stream has begun the response has already been
 * committed with a 200 and headers flushed; there is no status code left to
 * change. Anything that fails afterwards has to be said IN the stream, and the
 * student keeps every token that arrived.
 *
 * `error` therefore carries a `partial: true` flag. The client needs to tell
 * "this failed before it said anything" (show an error with a retry) from "this
 * failed halfway" (keep the text, offer to continue) — §7's table lists those as
 * two different required behaviours, and nothing else on the wire distinguishes
 * them.
 * ===========================================================================
 *
 * NO PII ON ANY FRAME. Ids and text the student wrote or was shown, and nothing
 * else. In particular the `error` frame carries a CODE, never an exception
 * message: an upstream error string can contain a URL, a key fragment or the
 * prompt.
 */

export interface TokenFrame {
  readonly type: 'token';
  readonly text: string;
}

export interface CitationFrame {
  readonly type: 'citation';
  /** Attach BY THIS ID, never by arrival position. §7. */
  readonly messageId: string;
  readonly citation: Citation;
}

export interface AbstentionFrame {
  readonly type: 'abstention';
  readonly messageId: string;
  readonly reason: AbstentionReason;
  /** The full, fixed sentence. Already in the student's language. */
  readonly text: string;
}

export interface DoneFrame {
  readonly type: 'done';
  readonly messageId: string;
  /** True when the turn ended in an abstention. */
  readonly abstained: boolean;
}

export interface ErrorFrame {
  readonly type: 'error';
  /** A stable code, never an exception message. See the header. */
  readonly code: 'model_unavailable' | 'internal';
  /** True when tokens had already been sent. See the header. */
  readonly partial: boolean;
}

export type FoxyFrame = TokenFrame | CitationFrame | AbstentionFrame | DoneFrame | ErrorFrame;

/**
 * One frame as SSE bytes.
 *
 * `event:` AND `data:`, both. A client written against `data:` alone still
 * works because the type is inside the JSON too — the duplication is
 * deliberate, since `EventSource`-style consumers dispatch on `event:` while
 * the fetch-based reader §7 mandates parses the JSON.
 *
 * The trailing BLANK LINE is what terminates a frame. Omitting it produces a
 * stream that looks correct in a terminal and never dispatches in a browser.
 */
export function encodeFrame(frame: FoxyFrame): string {
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * The SSE headers, in one place.
 *
 * `X-Accel-Buffering: no` is not decoration. Nginx and several reverse proxies
 * buffer a response body by default, which turns a token stream into one large
 * delivery at the end — the streaming works perfectly in development and
 * silently stops streaming in production, with no error and no way to see it
 * from the application side.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

/** Narrowing helper, used by tests that assert on a collected frame list. */
export function isFrameOfType<T extends FoxyFrameType>(
  frame: FoxyFrame,
  type: T,
): frame is Extract<FoxyFrame, { type: T }> {
  return frame.type === type;
}
