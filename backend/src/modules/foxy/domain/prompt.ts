import type { LlmMessage, LlmRequest } from '@/platform/llm/index';
import type { Grade, LanguageCode } from '@/shared/constants/curriculum';
import { FOXY_HISTORY_TURNS, type FoxyAction, type FoxyMode } from '@/shared/constants/foxy';
import { actionSpec } from './actions';
import { CITATION_OPEN } from './citations';
import { modeSpec } from './modes';

/**
 * PROMPT ASSEMBLY — the one place a message is built for the model.
 *
 * ===========================================================================
 * WHAT MAY BE SENT, STATED AS A RULE THIS FILE ENFORCES.
 *
 * 00-ARCHITECTURE.md §0: the model "may see the student's question and the
 * retrieved textbook passages. NEVER a name, email address, phone number, or
 * account identifier."
 *
 * `assertNoIdentity` below is that sentence as a function, and it runs on the
 * assembled prompt rather than on its parts — because the failure this guards
 * against is somebody adding a field to a template, not somebody deliberately
 * passing a name. It throws rather than redacting: a prompt that silently had a
 * student's name removed is a prompt somebody built wrong and will build wrong
 * again.
 *
 * There is one deliberate consequence worth stating: FOXY DOES NOT KNOW THE
 * STUDENT'S NAME, and cannot greet them by it. That is the cost of the rule and
 * it is a cost worth paying.
 * ===========================================================================
 *
 * ===========================================================================
 * THE SYSTEM PROMPT IS ASSEMBLED IN A FIXED ORDER, AND THE ORDER IS THE POINT.
 *
 *   1  persona and identity     — who Foxy is, and that Foxy is not a person
 *   2  scope                    — CBSE, this grade, this subject, nothing else
 *   3  grounding rule           — answer ONLY from the passages below
 *   4  citation rule            — how to cite, and that uncited claims are wrong
 *   5  safety rails             — age, tone, and what to do when unsure
 *   6  language                 — which language to answer in
 *   7  mode                     — what shape this turn takes
 *   8  action                   — what this button asked for
 *   9  the passages
 *
 * The MODE and the ACTION come last so they can specialise the turn. They can
 * never loosen 1-6, because those are already stated — an instruction cannot
 * un-say a rule that precedes it as reliably as it can add to one, and putting
 * the rails after the mode is how a "practice" mode quietly acquires permission
 * to ask about anything.
 * ===========================================================================
 */

export interface PromptChunk {
  readonly id: string;
  readonly chunkText: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
}

export interface PromptTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface PromptInput {
  readonly mode: FoxyMode;
  /** `undefined` for a free-text turn. */
  readonly action?: FoxyAction;
  readonly grade: Grade;
  readonly subject: string;
  readonly language: LanguageCode;
  /** The student's question, or the label of the button they pressed. */
  readonly question: string;
  /** Oldest first. Truncated to `FOXY_HISTORY_TURNS` — see the constant. */
  readonly history: readonly PromptTurn[];
  /** Top N, in fused order. Never empty — an empty set means abstain. */
  readonly chunks: readonly PromptChunk[];
}

export interface AssembledPrompt {
  readonly system: string;
  readonly messages: readonly PromptTurn[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly language: LanguageCode;
}

const LANGUAGE_RULE: Readonly<Record<LanguageCode, string>> = Object.freeze({
  en: 'Answer in clear, simple English. Keep sentences short.',
  hi:
    'Answer in Hindi, in Devanagari script. Keep standard technical terms in English where a ' +
    'Hindi translation would confuse a CBSE student.',
});

/**
 * WHAT LOOKS LIKE A PERSON RATHER THAN A QUESTION.
 *
 * Deliberately narrow and deliberately structural: an email address, a phone
 * number, and a UUID. It does not attempt to detect NAMES, because a classifier
 * that flagged names would flag "Newton", "Bharat" and "Ashoka" and would refuse
 * half the history syllabus.
 *
 * The UUID pattern is the one that matters most in practice. It is the shape of
 * every identifier in this system — user ids, session ids, tenant ids — and a
 * template that accidentally interpolated one would leak an account identifier
 * to a third party with no other symptom.
 *
 * `chunkId`s ARE UUIDs and DO appear in the prompt, by design: the citation
 * scheme depends on it. So the check runs on the parts of the prompt that are
 * NOT the passage block. See `assertNoIdentity`'s signature.
 */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
const PHONE = /(?:\+?\d[ -]?){9,}\d/u;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;

export class PromptIdentityLeak extends Error {
  readonly kind: 'email' | 'phone' | 'identifier';

  constructor(kind: 'email' | 'phone' | 'identifier') {
    // THE OFFENDING TEXT IS NOT IN THE MESSAGE. This error is logged, and a log
    // line containing the email address it just refused to send would be the
    // same leak by a different route (P13).
    super(`prompt assembly refused: the prompt carries a ${kind}`);
    this.name = 'PromptIdentityLeak';
    this.kind = kind;
  }
}

/**
 * Refuses a prompt fragment that carries identity.
 *
 * EXPORTED, because it is asserted directly by its own tests and because the
 * service calls it on the student's own question too — a student who types
 * their phone number into a chat has not consented to it being sent to a third
 * party, and the safety classifier's `personal_contact` category catches the
 * intent while this catches the digits.
 */
export function assertNoIdentity(fragment: string): void {
  if (EMAIL.test(fragment)) throw new PromptIdentityLeak('email');
  // THE UUID CHECK RUNS BEFORE THE PHONE CHECK, and the order is not cosmetic.
  // `11111111-1111-4111-8111-111111111111` is digits and hyphens, so it matches
  // the phone pattern too — and reporting an account identifier as a "phone
  // number" would send whoever investigates it looking for the wrong bug.
  if (UUID.test(fragment)) throw new PromptIdentityLeak('identifier');
  if (PHONE.test(fragment)) throw new PromptIdentityLeak('phone');
}

/** The passage block, and the only place a chunk id is allowed to appear. */
function renderChunks(chunks: readonly PromptChunk[]): string {
  return chunks
    .map((chunk) => {
      const where =
        chunk.chapterNumber === null
          ? (chunk.chapterTitle ?? 'NCERT')
          : `Chapter ${String(chunk.chapterNumber)}${chunk.chapterTitle === null ? '' : ` — ${chunk.chapterTitle}`}`;
      return `<<<passage id=${chunk.id} source="${where}">>>\n${chunk.chunkText}\n<<<end>>>`;
    })
    .join('\n\n');
}

/**
 * Builds the system prompt and the message list for one turn.
 *
 * PURE. No clock, no logger, no database, no config. Every property §8.5 asks
 * to be tested — "each mode produces its own prompt shape" — is a property of
 * this function's return value, and that is only assertable if it depends on
 * nothing else.
 */
export function assemblePrompt(input: PromptInput): AssembledPrompt {
  const mode = modeSpec(input.mode);
  const action = input.action === undefined ? null : actionSpec(input.action);
  const language = action?.forceLanguage ?? input.language;

  const sections: string[] = [
    // 1 — persona and identity.
    'You are Foxy, a friendly study helper inside the Alfanumrik app. ' +
      'You are an AI assistant, not a human teacher. If a student asks whether you are a ' +
      'real person, say plainly that you are not. Never claim to be their teacher, and never ' +
      'claim to have met them.',

    // 2 — scope.
    `You are helping a CBSE student in Class ${input.grade} with ${input.subject}. ` +
      'Stay inside the CBSE syllabus for that class and that subject. ' +
      'Do not discuss anything outside school study.',

    // 3 — grounding. The rule the whole product rests on.
    'Answer ONLY from the reference passages given below. They are from the student’s own ' +
      'NCERT textbook. Do not use anything you know that is not in them. If the passages do ' +
      'not contain the answer, say so plainly and stop — do not fill the gap.',

    // 4 — citation.
    `Mark every factual sentence with the id of the passage it came from, written as ` +
      `${CITATION_OPEN}<id>]. Use the id exactly as it appears in the passage header. ` +
      'A sentence with no marker will be treated as unsupported.',

    // 5 — safety rails.
    'The student is between 11 and 18 years old. Keep the language and the examples suitable ' +
      'for that age. Be warm and encouraging, and never make a student feel slow. ' +
      'If you are not sure, say “I am not sure about this — check with your teacher.” ' +
      'You do not know the student’s name and must not ask for it, or for any other personal ' +
      'detail.',

    // 6 — language.
    LANGUAGE_RULE[language],

    // 7 — mode.
    mode.instruction,
  ];

  // 8 — action, when a button produced this turn.
  if (action !== null) sections.push(action.instruction);

  // Every section above is a constant or a curriculum value. Checked anyway:
  // the point of the guard is the template somebody edits later.
  for (const section of sections) assertNoIdentity(section);

  /**
   * 9 — the passages.
   *
   * CHECKED FIELD BY FIELD RATHER THAN ON THE RENDERED BLOCK, because the block
   * contains the chunk id — a UUID, which the citation scheme depends on and
   * which is also digits and hyphens, so it matches the phone pattern. Checking
   * the rendered string would refuse every prompt this system will ever build.
   *
   * The FIELDS still get the email and phone checks, and they are not
   * theoretical: NCERT front matter carries publisher contact details, and a
   * chunk that swept one up would send it to a third party on every turn.
   */
  for (const chunk of input.chunks) {
    for (const field of [chunk.chunkText, chunk.chapterTitle ?? '']) {
      if (EMAIL.test(field)) throw new PromptIdentityLeak('email');
      if (PHONE.test(field)) throw new PromptIdentityLeak('phone');
    }
  }
  const passages = renderChunks(input.chunks);

  const system = `${sections.join('\n\n')}\n\nReference passages:\n\n${passages}`;

  // The MOST RECENT turns, not the first. A window taken from the front would
  // freeze the conversation at its opening and drift further from the student's
  // actual position with every turn.
  const history = input.history.slice(-FOXY_HISTORY_TURNS);
  const messages: PromptTurn[] = [...history, { role: 'user', content: input.question }];

  return {
    system,
    messages,
    // The ACTION's budget wins when there is one: a button is a more specific
    // statement of intent than the mode it happened to be pressed in.
    maxTokens: action?.maxTokens ?? mode.maxTokens,
    temperature: action?.temperature ?? mode.temperature,
    language,
  };
}

/**
 * THE CEILING ON CREATIVITY.
 *
 * "A tutor grounded in retrieved passages has no business being creative about
 * what the passages say" — `actions.ts`. Every mode and every action ships at
 * or under this today; the constant exists so that the day one of them does not,
 * the request is refused rather than sent.
 */
export const FOXY_MAX_TEMPERATURE = 0.5;

/**
 * Refused when a turn would be sent to the model outside its safety envelope.
 *
 * NOT a `ValidationError`: nothing the student typed caused it and there is
 * nothing they could type differently. It is a programming error in a spec
 * table, and it must read like one.
 */
export class PromptSafetyViolation extends Error {
  readonly reason: 'temperature' | 'max-tokens' | 'no-system-message';

  constructor(reason: 'temperature' | 'max-tokens' | 'no-system-message') {
    // The offending VALUE is not in the message: a prompt fragment must never
    // reach a log line (P13), and the reason is what an investigator acts on.
    super(`foxy refused to send a request: ${reason}`);
    this.name = 'PromptSafetyViolation';
    this.reason = reason;
  }
}

/**
 * Turns an assembled prompt into THE REQUEST THAT IS SENT. The only builder.
 *
 * ===========================================================================
 * WHY THIS EXISTS AS A FUNCTION RATHER THAN AN OBJECT LITERAL AT THE CALL SITE.
 *
 * `assemblePrompt` is exhaustively tested as a pure function, and every one of
 * those tests is a statement about a value that NOBODY HAD TO SEND. An audit
 * replaced the literal that used to sit in `foxy.service.ts` with one that
 * dropped the system message and raised the temperature to 1.5, and all 170
 * tests stayed green: the persona, the CBSE scope, the grounding rule, the
 * citation instruction and the age rails were all still asserted — on an object
 * the model never saw.
 *
 * With one builder there is one place to assert on, one place to mutate, and
 * the three invariants below are checked on the way past rather than hoped for.
 * ===========================================================================
 */
export function toLlmRequest(prompt: AssembledPrompt): LlmRequest {
  if (prompt.system.trim().length === 0) throw new PromptSafetyViolation('no-system-message');
  if (prompt.temperature > FOXY_MAX_TEMPERATURE) throw new PromptSafetyViolation('temperature');
  if (prompt.maxTokens <= 0) throw new PromptSafetyViolation('max-tokens');

  return {
    // THE SYSTEM MESSAGE IS FIRST AND IS NOT OPTIONAL. It carries the persona,
    // the grade and subject scope, the grounding rule, the citation instruction
    // and the age rails — and since the abstain threshold catches only about a
    // third of off-syllabus questions (the measured distributions overlap; see
    // `retrieval/domain/abstain-threshold.ts`), the grounding rule is the only
    // thing between a weak retrieval hit and an ungrounded answer to a child.
    messages: [
      { role: 'system', content: prompt.system },
      ...prompt.messages.map((turn) => ({ role: turn.role, content: turn.content })),
    ],
    maxTokens: prompt.maxTokens,
    temperature: prompt.temperature,
  };
}

/**
 * Renders THE REQUEST THAT WAS SENT for the trace's `prompt` column.
 *
 * TAKES MESSAGES, NOT AN `AssembledPrompt`, and that is the entire point. The
 * trace used to be re-derived from `prompt.system` at persistence time, so the
 * forensic record described a request rather than recording one — under the
 * audit's mutation the trace asserted a system prompt the model never received.
 * A self-consistent lie is worse than a missing column: it is the artefact
 * somebody will trust at 2am while debugging a bad answer given to a child.
 *
 * Feed it `request.messages` and nothing else.
 */
export function renderSentPrompt(messages: readonly LlmMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n\n---\n\n');
}
