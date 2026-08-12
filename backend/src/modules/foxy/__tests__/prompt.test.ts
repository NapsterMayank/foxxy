import { describe, expect, it } from 'vitest';
import { FOXY_ACTIONS, FOXY_HISTORY_TURNS, FOXY_MODES } from '@/shared/constants/foxy';
import { ACTION_SPECS } from '../domain/actions';
import { MODE_SPECS } from '../domain/modes';
import {
  FOXY_MAX_TEMPERATURE,
  PromptIdentityLeak,
  PromptSafetyViolation,
  assemblePrompt,
  assertNoIdentity,
  renderSentPrompt,
  toLlmRequest,
  type AssembledPrompt,
  type PromptChunk,
  type PromptInput,
} from '../domain/prompt';

/**
 * ============================================================================
 * PROMPT ASSEMBLY.
 *
 * Two things are pinned here, and they are unrelated to each other except that
 * both are invisible when they break:
 *
 *  1. EACH MODE AND EACH ACTION PRODUCES ITS OWN PROMPT SHAPE (§8.5's test
 *     list). A mode whose instruction silently stopped reaching the prompt
 *     would produce answers that are perfectly plausible and in the wrong shape
 *     — nothing errors, and nobody notices for months.
 *
 *  2. NO IDENTITY EVER REACHES THE MODEL (00-ARCHITECTURE.md §0: "never a name,
 *     email, phone number, or account identifier"). The check runs on the
 *     assembled prompt rather than on its inputs, because the failure it guards
 *     against is somebody adding a field to a template — not somebody
 *     deliberately passing a name.
 * ============================================================================
 */

const CHUNK: PromptChunk = {
  id: '11111111-1111-4111-8111-111111111111',
  chunkText: 'Light bends when it passes from one medium into another.',
  chapterNumber: 10,
  chapterTitle: 'The Human Eye',
};

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    mode: 'doubt',
    grade: '8',
    subject: 'science',
    language: 'en',
    question: 'why does light bend',
    history: [],
    chunks: [CHUNK],
    ...overrides,
  };
}

describe('each mode produces its own prompt shape', () => {
  it('puts every mode’s own instruction into the system prompt, and no other mode’s', () => {
    for (const mode of FOXY_MODES) {
      const assembled = assemblePrompt(input({ mode }));
      expect(assembled.system).toContain(MODE_SPECS[mode].instruction);

      for (const other of FOXY_MODES) {
        if (other === mode) continue;
        expect(assembled.system).not.toContain(MODE_SPECS[other].instruction);
      }
    }
  });

  it('gives each mode its own token budget and temperature', () => {
    for (const mode of FOXY_MODES) {
      const assembled = assemblePrompt(input({ mode }));
      expect(assembled.maxTokens).toBe(MODE_SPECS[mode].maxTokens);
      expect(assembled.temperature).toBe(MODE_SPECS[mode].temperature);
    }
  });

  it('keeps every temperature at or below 0.5 — a grounded tutor is not creative', () => {
    for (const mode of FOXY_MODES) {
      expect(MODE_SPECS[mode].temperature).toBeLessThanOrEqual(0.5);
    }
    for (const action of FOXY_ACTIONS) {
      expect(ACTION_SPECS[action].temperature).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('each action produces its own prompt shape', () => {
  it('appends its own instruction and nobody else’s', () => {
    for (const action of FOXY_ACTIONS) {
      const assembled = assemblePrompt(input({ action }));
      expect(assembled.system).toContain(ACTION_SPECS[action].instruction);

      for (const other of FOXY_ACTIONS) {
        if (other === action) continue;
        expect(assembled.system).not.toContain(ACTION_SPECS[other].instruction);
      }
    }
  });

  it('lets the action’s budget win over the mode’s — a button is more specific', () => {
    const assembled = assemblePrompt(input({ mode: 'explain', action: 'quiz_me' }));
    expect(assembled.maxTokens).toBe(ACTION_SPECS.quiz_me.maxTokens);
    expect(assembled.maxTokens).not.toBe(MODE_SPECS.explain.maxTokens);
  });

  it('`hindi` forces the response language for ONE turn without changing the session', () => {
    const assembled = assemblePrompt(input({ language: 'en', action: 'hindi' }));
    expect(assembled.language).toBe('hi');
    expect(assembled.system).toContain('Devanagari');
  });

  it('leaves the session language alone for every other action', () => {
    for (const action of FOXY_ACTIONS) {
      if (action === 'hindi') continue;
      expect(assemblePrompt(input({ language: 'en', action })).language).toBe('en');
    }
  });
});

describe('the rails are stated BEFORE the mode and the action', () => {
  it('states the persona, the scope, the grounding rule and the safety rails first', () => {
    const assembled = assemblePrompt(input({ mode: 'practice', action: 'confused' }));
    const system = assembled.system;

    const grounding = system.indexOf('Answer ONLY from the reference passages');
    const rails = system.indexOf('between 11 and 18 years old');
    const mode = system.indexOf(MODE_SPECS.practice.instruction);
    const action = system.indexOf(ACTION_SPECS.confused.instruction);

    expect(grounding).toBeGreaterThan(-1);
    expect(rails).toBeGreaterThan(grounding);
    // An instruction cannot un-say a rule that precedes it as reliably as it can
    // add to one. Putting the rails after the mode is how a "practice" mode
    // quietly acquires permission to ask about anything.
    expect(mode).toBeGreaterThan(rails);
    expect(action).toBeGreaterThan(mode);
  });

  it('names the student’s grade and subject, and says Foxy is not a person', () => {
    const assembled = assemblePrompt(input({ grade: '10', subject: 'mathematics' }));
    expect(assembled.system).toContain('Class 10');
    expect(assembled.system).toContain('mathematics');
    expect(assembled.system).toContain('not a human teacher');
  });

  it('tells the model how to cite, using the marker the filter parses', () => {
    expect(assemblePrompt(input()).system).toContain('[chunk:<id>]');
  });

  it('includes the passage text and its chapter, so a citation can be resolved', () => {
    const system = assemblePrompt(input()).system;
    expect(system).toContain(CHUNK.chunkText);
    expect(system).toContain(CHUNK.id);
    expect(system).toContain('Chapter 10 — The Human Eye');
  });

  it('falls back to the title alone when a chunk has no chapter number', () => {
    const system = assemblePrompt(
      input({ chunks: [{ ...CHUNK, chapterNumber: null, chapterTitle: 'Light' }] }),
    ).system;
    expect(system).toContain('source="Light"');
  });

  it('falls back to NCERT when a chunk has neither', () => {
    const system = assemblePrompt(
      input({ chunks: [{ ...CHUNK, chapterNumber: null, chapterTitle: null }] }),
    ).system;
    expect(system).toContain('source="NCERT"');
  });
});

describe('the history window', () => {
  it('takes the MOST RECENT turns, not the first', () => {
    const history = Array.from({ length: FOXY_HISTORY_TURNS + 4 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${String(index)}`,
    }));

    const assembled = assemblePrompt(input({ history }));

    // +1 for the question itself.
    expect(assembled.messages).toHaveLength(FOXY_HISTORY_TURNS + 1);
    expect(assembled.messages[0]?.content).toBe('turn 4');
    // A window taken from the FRONT would freeze the conversation at its
    // opening and drift further from the student's position every turn.
    expect(assembled.messages.map((message) => message.content)).not.toContain('turn 0');
  });

  it('puts the question last, as the turn being answered', () => {
    const assembled = assemblePrompt(input({ question: 'why does light bend' }));
    expect(assembled.messages.at(-1)).toEqual({ role: 'user', content: 'why does light bend' });
  });
});

describe('no identity ever reaches the model', () => {
  it('refuses an email address', () => {
    expect(() => { assertNoIdentity('write to aarav@example.test'); }).toThrow(PromptIdentityLeak);
  });

  it('refuses a phone number', () => {
    expect(() => { assertNoIdentity('call me on +91 98765 43210'); }).toThrow(PromptIdentityLeak);
  });

  it('refuses an account identifier', () => {
    expect(() => { assertNoIdentity('user 11111111-1111-4111-8111-111111111111'); }).toThrow(
      PromptIdentityLeak,
    );
  });

  it('carries the KIND and never the offending text', () => {
    try {
      assertNoIdentity('aarav@example.test');
      expect.unreachable('assertNoIdentity should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptIdentityLeak);
      // A log line containing the address it just refused to send would be the
      // same leak by a different route (P13).
      expect((error as Error).message).not.toContain('aarav@example.test');
      expect((error as PromptIdentityLeak).kind).toBe('email');
    }
  });

  it('does NOT refuse ordinary syllabus words that look like names', () => {
    expect(() => { assertNoIdentity('Newton and Ashoka and Bharat'); }).not.toThrow();
    expect(() => { assertNoIdentity('the value of pi is 3.14159'); }).not.toThrow();
  });

  it('refuses a PASSAGE carrying an email or a phone number', () => {
    expect(() =>
      assemblePrompt(input({ chunks: [{ ...CHUNK, chunkText: 'Write to ncert@example.test' }] })),
    ).toThrow(PromptIdentityLeak);
    expect(() =>
      assemblePrompt(input({ chunks: [{ ...CHUNK, chunkText: 'Call +91 98765 43210' }] })),
    ).toThrow(PromptIdentityLeak);
  });

  it('ALLOWS the chunk id, which is a UUID and belongs in the passage header', () => {
    // The citation scheme depends on it. The identity guard therefore runs on
    // the sections and not on the passage block's ids — see `assemblePrompt`.
    expect(() => assemblePrompt(input())).not.toThrow();
    expect(assemblePrompt(input()).system).toContain(CHUNK.id);
  });

  it('never mentions a student name, because it is never given one', () => {
    // Foxy CANNOT greet a student by name. That is the cost of §0's rule and it
    // is the cost being paid on purpose.
    const assembled = assemblePrompt(input());
    expect(assembled.system).toContain('do not know the student’s name');
  });
});

/**
 * ===========================================================================
 * THE REQUEST BUILDER — the one place an assembled prompt becomes something the
 * model can be sent.
 *
 * Everything above this line is a property of a PURE FUNCTION, and an audit
 * showed exactly what that is worth on its own: replacing the request literal
 * in `foxy.service.ts` with one that dropped the system message and set
 * `temperature: 1.5` left all 170 tests green. The persona, the scope, the
 * grounding rule and the age rails were all still asserted — on a value nobody
 * was obliged to send.
 * ===========================================================================
 */
describe('toLlmRequest — what is actually sent', () => {
  it('puts the system prompt FIRST, as a system message', () => {
    const request = toLlmRequest(assemblePrompt(input()));
    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages[0]?.content).toContain('You are Foxy');
    expect(request.messages[0]?.content).toContain(
      'Answer ONLY from the reference passages given below',
    );
    // Exactly one. A second system message is how a later edit contradicts the
    // rails without appearing to touch them.
    expect(request.messages.filter((message) => message.role === 'system')).toHaveLength(1);
  });

  it('keeps the conversation in order behind it, ending with the question', () => {
    const assembled = assemblePrompt(
      input({ history: [{ role: 'user', content: 'earlier' }], question: 'why does light bend' }),
    );
    const request = toLlmRequest(assembled);
    expect(request.messages.map((message) => message.role)).toEqual(['system', 'user', 'user']);
    expect(request.messages.at(-1)?.content).toBe('why does light bend');
  });

  it('carries the assembled budget and temperature, unchanged', () => {
    const assembled = assemblePrompt(input({ mode: 'practice' }));
    const request = toLlmRequest(assembled);
    expect(request.maxTokens).toBe(assembled.maxTokens);
    expect(request.temperature).toBe(assembled.temperature);
  });

  it('every mode and every action ships at or under the temperature ceiling', () => {
    for (const mode of FOXY_MODES) {
      expect(MODE_SPECS[mode].temperature).toBeLessThanOrEqual(FOXY_MAX_TEMPERATURE);
      expect(toLlmRequest(assemblePrompt(input({ mode }))).temperature).toBeLessThanOrEqual(
        FOXY_MAX_TEMPERATURE,
      );
    }
    for (const action of FOXY_ACTIONS) {
      expect(ACTION_SPECS[action].temperature).toBeLessThanOrEqual(FOXY_MAX_TEMPERATURE);
      expect(toLlmRequest(assemblePrompt(input({ action }))).temperature).toBeLessThanOrEqual(
        FOXY_MAX_TEMPERATURE,
      );
    }
  });

  it('REFUSES to send a prompt with no system message', () => {
    // Unreachable through `assemblePrompt` today, and that is the point: the
    // guard is for the edit that makes it reachable.
    const broken: AssembledPrompt = {
      system: '   ',
      messages: [{ role: 'user', content: 'why does light bend' }],
      maxTokens: 700,
      temperature: 0.3,
      language: 'en',
    };
    expect(() => toLlmRequest(broken)).toThrow(PromptSafetyViolation);
    try {
      toLlmRequest(broken);
    } catch (error) {
      expect((error as PromptSafetyViolation).reason).toBe('no-system-message');
      // The prompt is never in the message — a log line is not a safe place
      // for one (P13).
      expect((error as Error).message).not.toContain('why does light bend');
    }
  });

  it('REFUSES a temperature above the ceiling', () => {
    const assembled = assemblePrompt(input());
    expect(() => toLlmRequest({ ...assembled, temperature: 1.5 })).toThrow(PromptSafetyViolation);
    // The ceiling itself is inclusive: 0.5 is `example`'s legitimate value.
    expect(() =>
      toLlmRequest({ ...assembled, temperature: FOXY_MAX_TEMPERATURE }),
    ).not.toThrow();
  });

  it('REFUSES a non-positive token budget', () => {
    const assembled = assemblePrompt(input());
    expect(() => toLlmRequest({ ...assembled, maxTokens: 0 })).toThrow(PromptSafetyViolation);
  });
});

describe('renderSentPrompt — the forensic record', () => {
  it('renders the messages it is given, role by role', () => {
    const rendered = renderSentPrompt([
      { role: 'system', content: 'RULES' },
      { role: 'user', content: 'QUESTION' },
    ]);
    expect(rendered).toContain('system: RULES');
    expect(rendered).toContain('user: QUESTION');
  });

  it('records the SYSTEM message, because that is what a bad answer is debugged from', () => {
    const request = toLlmRequest(assemblePrompt(input()));
    const rendered = renderSentPrompt(request.messages);
    for (const message of request.messages) expect(rendered).toContain(message.content);
    expect(rendered).toContain('Answer ONLY from the reference passages given below');
  });

  it('is empty for no messages rather than inventing a record', () => {
    expect(renderSentPrompt([])).toBe('');
  });
});
