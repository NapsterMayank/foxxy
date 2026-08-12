import { FOXY_ACTIONS, type FoxyAction } from '@/shared/constants/foxy';

/**
 * THE FIXED ACTION SET — the six buttons, and everything each one means.
 *
 * ===========================================================================
 * WHY THE LABEL AND THE INSTRUCTION LIVE IN THE SAME OBJECT.
 *
 * A button that says "Explain more simply" and sends an instruction that says
 * something else is a lie the product tells in its own interface, and it is a
 * lie nobody notices — the answer still looks like an answer. Keeping the two
 * one literal apart makes them reviewable together and makes a drift a diff.
 *
 * ===========================================================================
 * WHY THIS IS A TABLE AND NOT A `switch`.
 *
 * `Record<FoxyAction, ActionSpec>` is TOTAL. Adding a value to `FOXY_ACTIONS`
 * without adding its row here is a compile error, so an action can never reach
 * the prompt assembler without a label, an instruction and a token budget. A
 * `switch` with a `default` would instead give the new action whatever the
 * default happened to be, silently.
 * ===========================================================================
 *
 * ON THE TOKEN BUDGETS. They are not uniform because the actions are not:
 * "Give another example" is two sentences and a worked case; "I am confused" is
 * a re-explanation from the beginning and needs room. A single generous budget
 * for all six would pay for the longest on every turn, and a single tight one
 * would truncate the answers that most need not to be truncated.
 *
 * ON TEMPERATURE. Everything factual sits at 0.3. Only `example` is higher, and
 * only slightly: generating a SECOND example that is genuinely different from
 * the first is the one place where determinism is the failure mode rather than
 * the goal. Nothing here goes above 0.5 — a tutor grounded in retrieved
 * passages has no business being creative about what the passages say.
 */

export interface BilingualLabel {
  readonly en: string;
  readonly hi: string;
}

export interface ActionSpec {
  readonly code: FoxyAction;
  /** What the button says. Bilingual, because P7 has no exceptions. */
  readonly label: BilingualLabel;
  /**
   * The instruction appended to the system prompt for this turn.
   *
   * Written as a constraint on FORM, never on CONTENT. "Use shorter sentences"
   * is safe; "simplify the physics" would invite the model to restate the
   * textbook rather than quote it, which is how a grounded answer becomes an
   * ungrounded one while still carrying citations.
   */
  readonly instruction: string;
  readonly maxTokens: number;
  readonly temperature: number;
  /**
   * Forces the response language for THIS TURN ONLY, overriding the session's.
   *
   * Only `hindi` sets it. A student who wants one explanation in Hindi is not
   * changing their account language, and sending them to settings mid-doubt is
   * the kind of friction that ends a session.
   */
  readonly forceLanguage?: 'hi';
}

export const ACTION_SPECS: Readonly<Record<FoxyAction, ActionSpec>> = Object.freeze({
  simpler: {
    code: 'simpler',
    label: { en: 'Explain more simply', hi: 'और आसान भाषा में समझाओ' },
    instruction:
      'Re-explain your previous answer in simpler language. Use short sentences and everyday ' +
      'words. Do not add new facts that are not in the reference passages.',
    maxTokens: 600,
    temperature: 0.3,
  },
  visual: {
    code: 'visual',
    label: { en: 'Show visually', hi: 'चित्र जैसा समझाओ' },
    instruction:
      'Describe the idea visually in words the student can picture or sketch: name the parts, ' +
      'say where each one sits, and describe what moves or changes. Do not claim to be showing ' +
      'an image, and do not invent a diagram that is not described in the reference passages.',
    maxTokens: 700,
    temperature: 0.3,
  },
  example: {
    code: 'example',
    label: { en: 'Give another example', hi: 'एक और उदाहरण दो' },
    instruction:
      'Give one more example of the same idea, DIFFERENT from any example already given in ' +
      'this conversation. Prefer an example from everyday Indian life. Keep it short and work ' +
      'through it step by step.',
    maxTokens: 600,
    // The one action where repeating yourself IS the failure. See the header.
    temperature: 0.5,
  },
  hindi: {
    code: 'hindi',
    label: { en: 'Explain in Hindi', hi: 'हिंदी में समझाओ' },
    instruction:
      'Answer entirely in Hindi (Devanagari script). Keep standard technical terms in English ' +
      'where a Hindi translation would confuse a CBSE student — for example "photosynthesis", ' +
      '"velocity", "CBSE".',
    maxTokens: 700,
    temperature: 0.3,
    forceLanguage: 'hi',
  },
  quiz_me: {
    code: 'quiz_me',
    label: { en: 'Ask me a question', hi: 'मुझसे एक सवाल पूछो' },
    instruction:
      'Ask the student exactly ONE question about the material in the reference passages. Ask ' +
      'it and stop — do not answer it, do not give the options away, and do not ask a second ' +
      'question.',
    // SHORT ON PURPOSE. One question is one or two sentences; a large budget
    // here is an invitation to answer the question the model just asked, which
    // is the single most common failure of a conversational quiz.
    maxTokens: 250,
    temperature: 0.3,
  },
  confused: {
    code: 'confused',
    label: { en: 'I am confused', hi: 'मुझे समझ नहीं आया' },
    instruction:
      'The student has said they are confused. Start again from the beginning of the idea, ' +
      'assume nothing from the previous answer, and build up in small steps. Be encouraging ' +
      'and never suggest the student should already have understood.',
    maxTokens: 800,
    temperature: 0.3,
  },
});

/** The six buttons, in the order the client renders them. */
export function listActions(): readonly ActionSpec[] {
  return FOXY_ACTIONS.map((code) => ACTION_SPECS[code]);
}

export function actionSpec(action: FoxyAction): ActionSpec {
  return ACTION_SPECS[action];
}

/**
 * The text stored as the student's message for a button press.
 *
 * A BUTTON STILL WRITES A MESSAGE ROW. The alternative — an assistant reply with
 * no preceding student turn — makes the transcript unreadable to a parent and
 * makes the conversation history handed to the model incoherent, because it
 * would show two assistant turns in a row with nothing between them.
 *
 * Stored in the student's own language, because the transcript is read by the
 * student and by their parent, not by the model.
 */
export function actionMessageText(action: FoxyAction, language: 'en' | 'hi'): string {
  return ACTION_SPECS[action].label[language];
}
