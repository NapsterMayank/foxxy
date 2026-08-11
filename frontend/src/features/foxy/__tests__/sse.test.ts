import { describe, expect, it } from 'vitest';
import { createFrameDecoder, parseFrame, readFrames } from '../lib/sse';

/**
 * The SSE parser — plan §7.
 *
 * The case that matters most is FRAME REASSEMBLY. Every other test here would
 * also pass against a naive `chunk.split('\n\n')` parser; the split-mid-field
 * tests are the ones that fail against it, and they are the ones that describe
 * what a real network does.
 */

function frame(type: string, payload: Record<string, unknown> = {}): string {
  const body = JSON.stringify({ type, ...payload });
  return `event: ${type}\ndata: ${body}\n\n`;
}

describe('parseFrame', () => {
  it('reads the type from the JSON body', () => {
    expect(parseFrame(frame('token', { text: 'hi' }).trimEnd())).toEqual({
      type: 'token',
      text: 'hi',
    });
  });

  it('joins multiple data lines, as a proxy may re-wrap them', () => {
    const json = JSON.stringify({ type: 'token', text: 'hello' });
    const split = `event: token\ndata: ${json.slice(0, 10)}\ndata: ${json.slice(10)}`;
    // Two `data:` lines join with a newline, which is not valid JSON here —
    // what is asserted is that BOTH lines are read, not just the first.
    expect(parseFrame(split)).toBeNull();

    const wrapped = `event: token\ndata: ${json}`;
    expect(parseFrame(wrapped)).toEqual({ type: 'token', text: 'hello' });
  });

  it('ignores an unrecognised frame type instead of throwing', () => {
    // The guarantee that lets the backend add a sixth frame type without
    // breaking clients already installed on phones.
    expect(parseFrame('event: telemetry\ndata: {"type":"telemetry","n":1}')).toBeNull();
  });

  it('ignores malformed JSON instead of throwing', () => {
    expect(parseFrame('event: token\ndata: {"type":"token",')).toBeNull();
  });

  it('ignores a frame with no data line', () => {
    expect(parseFrame(': keep-alive comment')).toBeNull();
  });
});

describe('createFrameDecoder', () => {
  it('emits nothing until a frame is terminated', () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('event: token\ndata: {"type":"token","text":"a"}')).toEqual([]);
    expect(decoder.push('\n\n')).toEqual([{ type: 'token', text: 'a' }]);
  });

  it('reassembles a frame split mid-field across three chunks', () => {
    const decoder = createFrameDecoder();
    const whole = frame('token', { text: 'photosynthesis' });
    const a = whole.slice(0, 12);
    const b = whole.slice(12, 30);
    const c = whole.slice(30);

    expect(decoder.push(a)).toEqual([]);
    expect(decoder.push(b)).toEqual([]);
    expect(decoder.push(c)).toEqual([{ type: 'token', text: 'photosynthesis' }]);
  });

  it('emits several frames arriving in one chunk, in order', () => {
    const decoder = createFrameDecoder();
    const chunk = frame('token', { text: 'a' }) + frame('token', { text: 'b' });
    expect(decoder.push(chunk)).toEqual([
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
    ]);
  });

  it('normalises CRLF, which a proxy is entitled to rewrite', () => {
    const decoder = createFrameDecoder();
    const crlf = frame('token', { text: 'a' }).replaceAll('\n', '\r\n');
    expect(decoder.push(crlf)).toEqual([{ type: 'token', text: 'a' }]);
  });

  it('flushes a complete frame left unterminated by a truncated stream', () => {
    const decoder = createFrameDecoder();
    expect(decoder.push('event: token\ndata: {"type":"token","text":"last"}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ type: 'token', text: 'last' }]);
  });
});

describe('readFrames', () => {
  it('decodes multi-byte characters split across chunk boundaries', async () => {
    // Devanagari, which is three bytes per character in UTF-8 — this product
    // runs in Hindi as well as English, and a per-chunk decode produces a
    // replacement character in the middle of a word.
    const payload = frame('token', { text: 'नमस्ते' });
    const bytes = new TextEncoder().encode(payload);
    const cut = 30;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });

    const seen: unknown[] = [];
    await readFrames(body, (received) => seen.push(received));
    expect(seen).toEqual([{ type: 'token', text: 'नमस्ते' }]);
  });
});
