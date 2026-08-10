/**
 * The Foxy vocabulary — the small closed sets the database CHECK constraints,
 * the Zod contract and the prompt assembler all have to agree on.
 *
 * They live in `shared/` for the reason given at the top of `curriculum.ts`:
 * modules CANNOT import `platform/db` (ESLint `no-restricted-imports`, plan
 * §7.4), so a constant declared beside the tables is a constant every module
 * re-declares — and a re-declared closed set drifts from the CHECK enforcing it.
 *
 * ===========================================================================
 * FOXY IS A GUIDED INTERFACE, NOT AN OPEN CHATBOT. THIS FILE IS WHERE THAT IS
 * TRUE OR FALSE.
 *
 * The specification is explicit: three modes and a FIXED ACTION SET. Not "a
 * chat box that also has some buttons" — the buttons are the product, and the
 * free-text box exists inside a mode that scopes it.
 *
 * That is not a UI preference. It is the reason this system can be evaluated at
 * all: a fixed action set means a bounded number of prompt shapes, each of which
 * can be reviewed once and tested forever. An open chatbot has an unbounded
 * number, so "is the tutor safe" stops being a question anybody can answer and
 * becomes a question about whatever the student happened to type.
 *
 * It is also cheaper and safer. Six actions cost six prompt templates; open chat
 * costs a moderation budget and an incident channel.
 *
 * ADDING A VALUE TO EITHER LIST IS A PRODUCT DECISION, not a refactor. A new
 * action needs a prompt shape, a max-token budget, a test that it produces its
 * own shape, and a translation. The CHECK constraint is what makes the database
 * refuse a value nobody wrote those four things for.
 * ===========================================================================
 */

/**
 * The three modes — plan §4, `chat_sessions.mode` CHECK.
 *
 *   doubt     "ask me anything" — the student brings a question.
 *   explain   "walk me through" — the student brings a topic.
 *   practice  "quiz me" — Foxy asks and the student answers.
 *
 * `practice` here is a CONVERSATIONAL drill and is NOT the `practice` module.
 * The module scores, awards XP and writes mastery; this mode does none of those
 * things and must never be made to, because a question asked conversationally
 * has no shuffle map, no anti-cheat timing and no held-out reserve — so a score
 * derived from it would be a number with no evidence behind it.
 */
export const FOXY_MODES = ['doubt', 'explain', 'practice'] as const;
export type FoxyMode = (typeof FOXY_MODES)[number];

export function isFoxyMode(value: unknown): value is FoxyMode {
  return typeof value === 'string' && (FOXY_MODES as readonly string[]).includes(value);
}

/**
 * THE FIXED ACTION SET — the six buttons, and the entire vocabulary of a turn
 * that is not free text.
 *
 *   simpler    Explain more simply
 *   visual     Show visually
 *   example    Give another example
 *   hindi      Explain in Hindi
 *   quiz_me    Ask me a question
 *   confused   I am confused
 *
 * The codes are short and stable; the LABELS are bilingual and live in
 * `modules/foxy/domain/actions.ts` beside the prompt each one produces, because
 * a label and its prompt drifting apart is how a button starts doing something
 * other than what it says.
 *
 * `hindi` IS AN ACTION RATHER THAN A SETTING on purpose. A student who wants one
 * explanation in Hindi is not changing their account language, and making them
 * do so would be a settings trip in the middle of a doubt. The session's
 * language is the default; this overrides it for one turn.
 */
export const FOXY_ACTIONS = ['simpler', 'visual', 'example', 'hindi', 'quiz_me', 'confused'] as const;
export type FoxyAction = (typeof FOXY_ACTIONS)[number];

export function isFoxyAction(value: unknown): value is FoxyAction {
  return typeof value === 'string' && (FOXY_ACTIONS as readonly string[]).includes(value);
}

/** `chat_messages.role` — plan §4. The wire words, not display words. */
export const FOXY_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type FoxyMessageRole = (typeof FOXY_MESSAGE_ROLES)[number];

/**
 * The SSE frame types — 02-FRONTEND-IMPLEMENTATION-PLAN.md §7.
 *
 * Declared here rather than in the module because the frontend imports the
 * inferred type from `shared/`, and because §7's rule that "an unrecognised
 * event type is ignored rather than thrown" only buys anything if both sides
 * agree on what the recognised ones are today.
 *
 * `abstention` IS ITS OWN FRAME AND NOT AN `error`. An abstention is a
 * successful answer that happens to say "I could not find this in your
 * textbook"; routing it through `error` would make the client render a retry
 * button for a response that will never change.
 */
export const FOXY_FRAME_TYPES = ['token', 'citation', 'abstention', 'done', 'error'] as const;
export type FoxyFrameType = (typeof FOXY_FRAME_TYPES)[number];

/**
 * How many messages of history are replayed into a prompt.
 *
 * SMALL, AND DELIBERATELY SO. Every extra turn is tokens on every subsequent
 * request, and the retrieved passages — not the conversation — are what an
 * answer is supposed to be grounded in. A long history quietly becomes the
 * dominant context, and the model starts answering from what it said before
 * rather than from the textbook, which is exactly how a grounded tutor turns
 * into a confident one.
 */
export const FOXY_HISTORY_TURNS = 6;

/**
 * The daily message allowance per plan — §8.5, "daily usage limits per plan".
 *
 * A DAY, not an hour, and counted in `platform/cache` under a key that expires
 * (00-ARCHITECTURE.md §7: counters never live in process memory, because an
 * in-memory counter stops working the moment a second instance runs and it
 * fails SILENTLY — the limit reads as enforced and is not).
 *
 * `billing` does not exist yet, so every account resolves to `free` through the
 * injected plan reader. That is stated as a default rather than hidden as one:
 * when billing lands it supplies the real reader and nothing else changes.
 */
export const FOXY_PLANS = ['free', 'plus'] as const;
export type FoxyPlan = (typeof FOXY_PLANS)[number];

export const FOXY_DAILY_MESSAGE_LIMIT: Readonly<Record<FoxyPlan, number>> = Object.freeze({
  free: 20,
  plus: 200,
});

/**
 * The longest question this product accepts, in characters.
 *
 * Here rather than in the module because BOTH the Zod contract (which the
 * frontend imports) and the safety classifier apply it, and two copies of a
 * limit are two limits. The contract rejects a longer body with a 400; the
 * classifier refuses it as `empty` for the case where text reaches the service
 * by some other route.
 *
 * It is a cost rule with a safety consequence: a ten-thousand-character
 * "question" is either a paste of somebody else's homework or an attempt to
 * push the system prompt out of the context window.
 */
export const MAX_QUESTION_CHARS = 1000;
