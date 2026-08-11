import {
  FOXY_FRAME_TYPES,
  type FoxyFrameType,
} from '@/lib/api/generated/constants/foxy';
import type { FoxyStreamFrameDto } from '@/lib/api/generated/contracts/foxy.contract';

/**
 * ===========================================================================
 * THE SSE FRAME PARSER — 02-FRONTEND-IMPLEMENTATION-PLAN.md §7.
 * Build-order step 0, and the piece the plan says to read before writing a line.
 *
 * `EventSource` CANNOT BE USED. The endpoint is a POST and `EventSource` is
 * GET-only; there is no server-sent-events-over-POST in the browser API.
 * Reaching for it is the default instinct and it simply cannot work here. So
 * the frames are parsed by hand from a `fetch` body reader, and the two things
 * `EventSource` gave for free are ours: FRAME REASSEMBLY and RECONNECTION.
 *
 * ---------------------------------------------------------------------------
 * BUFFERING ACROSS CHUNK BOUNDARIES IS THE WHOLE POINT OF THIS FILE.
 *
 * A network chunk can split a frame anywhere — mid-field, mid-JSON, between the
 * two newlines that terminate it. A parser that assumes one chunk is a whole
 * frame works perfectly against a fast local server and corrupts under real
 * conditions, on someone else's phone, intermittently. The decoder below holds
 * a buffer and emits only frames it has seen terminated.
 *
 * ---------------------------------------------------------------------------
 * AN UNRECOGNISED FRAME TYPE IS IGNORED, NEVER THROWN.
 *
 * §7: the backend must be able to add a sixth frame type without breaking
 * deployed clients. A client that throws on an unknown `event:` turns an
 * additive backend change into an outage for everyone who has not reloaded.
 * The same rule covers malformed JSON: skip the frame, keep the stream.
 * ===========================================================================
 */

const FRAME_TYPES: ReadonlySet<string> = new Set<string>(FOXY_FRAME_TYPES);

function isFrameType(value: unknown): value is FoxyFrameType {
  return typeof value === 'string' && FRAME_TYPES.has(value);
}

/**
 * The `data:` payload of one frame, already reassembled.
 *
 * SSE allows several `data:` lines per event, joined with newlines. The backend
 * sends one, but a proxy is entitled to re-wrap them and a parser that reads
 * only the first would silently truncate JSON.
 */
function dataOf(rawFrame: string): string | null {
  const parts: string[] = [];
  for (const line of rawFrame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    // One optional space after the colon is part of the framing, not the data.
    parts.push(line.slice(5).replace(/^ /, ''));
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * Turns a frame's JSON into a typed frame, or null.
 *
 * The `type` inside the JSON is authoritative rather than the `event:` line.
 * The backend sends both deliberately (`encodeFrame` in the backend's `sse.ts`),
 * and if they ever disagree the body is what carries the rest of the fields.
 */
export function parseFrame(rawFrame: string): FoxyStreamFrameDto | null {
  const data = dataOf(rawFrame);
  if (data === null || data.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as { type?: unknown };
  if (!isFrameType(candidate.type)) return null;

  return payload as FoxyStreamFrameDto;
}

export interface FrameDecoder {
  /** Frames completed by this chunk, in order. May be empty. */
  push(chunk: string): FoxyStreamFrameDto[];
  /**
   * Frames left in the buffer when the body ends without a trailing blank line.
   *
   * A well-behaved server always terminates the last frame, so this is normally
   * empty — but a truncated stream that happens to contain a complete frame
   * should still deliver it rather than discard a token the student was owed.
   */
  flush(): FoxyStreamFrameDto[];
}

export function createFrameDecoder(): FrameDecoder {
  let buffer = '';

  function drain(force: boolean): FoxyStreamFrameDto[] {
    const frames: FoxyStreamFrameDto[] = [];
    // `\r\n` normalised first: a proxy may rewrite line endings, and a
    // separator search that only knows `\n\n` would then never fire at all.
    buffer = buffer.replaceAll('\r\n', '\n');

    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = parseFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      if (frame !== null) frames.push(frame);
      separator = buffer.indexOf('\n\n');
    }

    if (force && buffer.trim().length > 0) {
      const frame = parseFrame(buffer);
      buffer = '';
      if (frame !== null) frames.push(frame);
    }

    return frames;
  }

  return {
    push(chunk: string): FoxyStreamFrameDto[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): FoxyStreamFrameDto[] {
      return drain(true);
    },
  };
}

/**
 * Reads a streamed response body and hands each frame to `onFrame`.
 *
 * `TextDecoder` with `{ stream: true }` rather than `response.text()`: a
 * multi-byte UTF-8 character can be split across chunks, and decoding each
 * chunk independently produces a replacement character in the middle of a
 * Devanagari word — which is exactly the language half this product runs in.
 */
export async function readFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: FoxyStreamFrameDto) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames = createFrameDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of frames.push(decoder.decode(value, { stream: true }))) onFrame(frame);
    }
    for (const frame of frames.push(decoder.decode())) onFrame(frame);
    for (const frame of frames.flush()) onFrame(frame);
  } finally {
    // Releases the lock even when the caller aborted, so the connection can be
    // torn down instead of held by a reader nobody owns any more.
    reader.releaseLock();
  }
}
