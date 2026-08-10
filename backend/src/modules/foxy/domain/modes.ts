import { FOXY_MODES, type FoxyMode } from '@/shared/constants/foxy';

/**
 * THE THREE MODES — what each one asks the model to be.
 *
 * ===========================================================================
 * A MODE IS A SHAPE, NOT A TOPIC.
 *
 * All three modes read the SAME retrieved passages under the SAME grade and
 * subject filter. What differs is the shape of the turn: `doubt` answers a
 * question, `explain` walks through an idea, `practice` asks rather than tells.
 *
 * That distinction is what keeps this file from becoming a second retrieval
 * configuration. A mode that changed which chunks were fetched would be a
 * second retrieval path, and `retrieval`'s own header is explicit that there is
 * one pipeline and an `if (mode === …)` in it is the regression.
 * ===========================================================================
 *
 * TOTAL over `FoxyMode` for the same reason `ACTION_SPECS` is: adding a mode
 * without a row here is a compile error rather than a mode that silently
 * inherits a default persona.
 */

export interface ModeSpec {
  readonly code: FoxyMode;
  /**
   * The mode's contribution to the system prompt. Appended AFTER the persona
   * and the safety rails, so it can never loosen them — it can only say what
   * kind of turn this is.
   */
  readonly instruction: string;
  readonly maxTokens: number;
  readonly temperature: number;
}

export const MODE_SPECS: Readonly<Record<FoxyMode, ModeSpec>> = Object.freeze({
  doubt: {
    code: 'doubt',
    instruction:
      'The student has asked a specific question. Answer exactly that question, using only the ' +
      'reference passages. Be direct: give the answer first, then one or two sentences of ' +
      'explanation. If the passages do not contain the answer, say so plainly.',
    maxTokens: 700,
    temperature: 0.3,
  },
  explain: {
    code: 'explain',
    instruction:
      'The student wants to be walked through an idea. Build it up in small numbered steps, ' +
      'each step one short paragraph, each grounded in the reference passages. End with one ' +
      'sentence that says what the whole idea means in plain words.',
    maxTokens: 900,
    temperature: 0.3,
  },
  practice: {
    code: 'practice',
    instruction:
      'The student wants to be quizzed. Ask ONE question drawn from the reference passages, ' +
      'then stop. When the student answers, say whether it is right, explain briefly why, and ' +
      'ask the next question. Never reveal an answer before the student has attempted it.',
    // Short, and the shortest of the three. See `quiz_me` in `actions.ts`: a
    // generous budget on a question-asking turn is an invitation to answer the
    // question, which defeats the entire mode.
    maxTokens: 400,
    temperature: 0.3,
  },
});

export function modeSpec(mode: FoxyMode): ModeSpec {
  return MODE_SPECS[mode];
}

/** Every mode, in the order the client renders them. */
export function listModes(): readonly ModeSpec[] {
  return FOXY_MODES.map((code) => MODE_SPECS[code]);
}
