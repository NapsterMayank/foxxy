import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@/shared/constants/curriculum';
import { FOXY_ACTIONS, FOXY_FRAME_TYPES, FOXY_MODES } from '@/shared/constants/foxy';
import {
  ABSTENTION_REASONS,
  abstentionMessage,
  abstentionMessages,
  fromRetrievalReason,
} from '../domain/abstention';
import { ACTION_SPECS, actionMessageText, listActions } from '../domain/actions';
import { MODE_SPECS, listModes } from '../domain/modes';
import { SSE_HEADERS, encodeFrame, isFrameOfType, type FoxyFrame } from '../domain/sse';

/**
 * The three small closed vocabularies, plus the wire format.
 *
 * Nothing here is clever. All of it is the kind of thing that breaks silently:
 * a Hindi field holding English, a frame missing its terminating blank line, an
 * action whose label and instruction have drifted apart.
 */

describe('abstention is a first-class answer', () => {
  it('has fixed wording in BOTH languages for every reason — P7 has no exceptions', () => {
    for (const reason of ABSTENTION_REASONS) {
      const text = abstentionMessages(reason);
      expect(text.en.trim().length).toBeGreaterThan(0);
      expect(text.hi).toMatch(/[ऀ-ॿ]/u);
      for (const language of LANGUAGES) {
        expect(abstentionMessage(reason, language).length).toBeGreaterThan(0);
      }
    }
  });

  it('ENDS WITH A NEXT STEP rather than only saying "I do not know"', () => {
    // "I do not know" is honest and useless. A child who is stuck needs to be
    // told what to try — that is the difference between abstention as a product
    // decision and abstention as a failure message.
    expect(abstentionMessage('no_results', 'en')).toMatch(/Check whether|ask me again/u);
    expect(abstentionMessage('below_threshold', 'en')).toMatch(/different words|name the chapter/u);
    expect(abstentionMessage('out_of_scope', 'en')).toMatch(/Add it in/u);
  });

  it('says it will not guess, rather than guessing', () => {
    expect(abstentionMessage('no_results', 'en')).toMatch(/not going to guess/u);
    expect(abstentionMessage('below_threshold', 'en')).toMatch(/rather say so than guess/u);
  });

  it('translates retrieval’s hyphenated vocabulary into this module’s', () => {
    expect(fromRetrievalReason('below-threshold')).toBe('below_threshold');
    expect(fromRetrievalReason('no-candidates')).toBe('no_results');
  });

  it('maps an UNRECOGNISED retrieval reason to the SAFER of the two', () => {
    // `no_results` is true of any abstention; `below_threshold` implies a near
    // miss that may not have happened.
    expect(fromRetrievalReason(null)).toBe('no_results');
    expect(fromRetrievalReason('something-new')).toBe('no_results');
  });
});

describe('the fixed action set', () => {
  it('exposes exactly the six actions, in a stable order', () => {
    expect(listActions().map((action) => action.code)).toEqual([...FOXY_ACTIONS]);
  });

  it('gives every action a bilingual label and a non-empty instruction', () => {
    for (const action of FOXY_ACTIONS) {
      const spec = ACTION_SPECS[action];
      expect(spec.label.en.trim().length).toBeGreaterThan(0);
      expect(spec.label.hi).toMatch(/[ऀ-ॿ]/u);
      expect(spec.instruction.trim().length).toBeGreaterThan(0);
      expect(spec.maxTokens).toBeGreaterThan(0);
    }
  });

  it('stores a button press as the label in the STUDENT’s language', () => {
    // A button still writes a message row: an assistant reply with no preceding
    // student turn makes the transcript unreadable to a parent and the history
    // handed to the model incoherent.
    expect(actionMessageText('simpler', 'en')).toBe(ACTION_SPECS.simpler.label.en);
    expect(actionMessageText('simpler', 'hi')).toBe(ACTION_SPECS.simpler.label.hi);
  });

  it('keeps `quiz_me` on a SHORT budget — a long one invites answering itself', () => {
    expect(ACTION_SPECS.quiz_me.maxTokens).toBeLessThan(ACTION_SPECS.confused.maxTokens);
  });

  it('raises the temperature ONLY for `example`, where repeating is the failure', () => {
    for (const action of FOXY_ACTIONS) {
      if (action === 'example') continue;
      expect(ACTION_SPECS[action].temperature).toBe(0.3);
    }
    expect(ACTION_SPECS.example.temperature).toBeGreaterThan(0.3);
  });

  it('makes `hindi` the only action that forces a language', () => {
    for (const action of FOXY_ACTIONS) {
      expect(ACTION_SPECS[action].forceLanguage).toBe(action === 'hindi' ? 'hi' : undefined);
    }
  });
});

describe('the three modes', () => {
  it('exposes exactly the three modes, in a stable order', () => {
    expect(listModes().map((mode) => mode.code)).toEqual([...FOXY_MODES]);
  });

  it('gives every mode its own non-empty instruction', () => {
    const instructions = FOXY_MODES.map((mode) => MODE_SPECS[mode].instruction);
    expect(new Set(instructions).size).toBe(FOXY_MODES.length);
  });

  it('tells `practice` never to reveal an answer before an attempt', () => {
    expect(MODE_SPECS.practice.instruction).toMatch(/[Nn]ever reveal an answer/u);
  });
});

describe('the SSE wire format', () => {
  const FRAMES: readonly FoxyFrame[] = [
    { type: 'token', text: 'Light bends.' },
    {
      type: 'citation',
      messageId: 'm1',
      citation: { chunkId: 'c1', chapterNumber: 10, chapterTitle: 'The Human Eye' },
    },
    { type: 'abstention', messageId: 'm1', reason: 'no_results', text: 'I could not find this.' },
    { type: 'done', messageId: 'm1', abstained: false },
    { type: 'error', code: 'model_unavailable', partial: true },
  ];

  it('covers every declared frame type and nothing else', () => {
    expect(FRAMES.map((frame) => frame.type).sort()).toEqual([...FOXY_FRAME_TYPES].sort());
  });

  it('emits `event:` and `data:` and TERMINATES WITH A BLANK LINE', () => {
    for (const frame of FRAMES) {
      const encoded = encodeFrame(frame);
      expect(encoded.startsWith(`event: ${frame.type}\n`)).toBe(true);
      expect(encoded).toContain('data: {');
      // Omitting this produces a stream that looks correct in a terminal and
      // never dispatches in a browser.
      expect(encoded.endsWith('\n\n')).toBe(true);
    }
  });

  it('repeats the type INSIDE the JSON, so a `data:`-only parser still works', () => {
    for (const frame of FRAMES) {
      const payload = encodeFrame(frame).split('data: ')[1] ?? '';
      expect(JSON.parse(payload.trim())).toMatchObject({ type: frame.type });
    }
  });

  it('carries a messageId on every frame the client attaches by id', () => {
    // §7: "Citations arrive after the text — attach by message id, never by
    // position."
    expect(encodeFrame(FRAMES[1]!)).toContain('"messageId":"m1"');
    expect(encodeFrame(FRAMES[3]!)).toContain('"messageId":"m1"');
  });

  it('carries a CODE on the error frame and never an exception message', () => {
    const encoded = encodeFrame({ type: 'error', code: 'internal', partial: false });
    expect(encoded).toContain('"code":"internal"');
    expect(encoded).not.toMatch(/stack|Error:/u);
  });

  it('distinguishes a failure before any token from one halfway through', () => {
    expect(encodeFrame({ type: 'error', code: 'internal', partial: false })).toContain(
      '"partial":false',
    );
    expect(encodeFrame({ type: 'error', code: 'internal', partial: true })).toContain(
      '"partial":true',
    );
  });

  it('sets the headers a proxy needs in order NOT to buffer the stream', () => {
    expect(SSE_HEADERS['content-type']).toContain('text/event-stream');
    expect(SSE_HEADERS['cache-control']).toContain('no-transform');
    // Without this, nginx buffers the body and the token stream becomes one
    // large delivery at the end — perfect in development, silently broken in
    // production, and invisible from the application side.
    expect(SSE_HEADERS['x-accel-buffering']).toBe('no');
  });

  it('narrows a frame by type', () => {
    const frame = FRAMES[0]!;
    expect(isFrameOfType(frame, 'token')).toBe(true);
    expect(isFrameOfType(frame, 'error')).toBe(false);
  });
});
