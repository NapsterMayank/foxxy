/**
 * =============================================================================
 * MASKING HAPPENS HERE, WHICH IS TO SAY: ON THE SERVER, BEFORE THE BYTES LEAVE.
 *
 * The tempting shape is to send the real values and let the admin app render
 * dots. That is not masking; it is a CSS effect. The raw email would sit in the
 * network tab, in the response cache, in a HAR file attached to a bug report,
 * and in whatever the browser extension somebody installed can read. A value
 * that reaches the client is disclosed whatever the component does with it.
 *
 * So these functions run in the service, the DTO carries only their output, and
 * `admin-masking.test.ts` asserts the raw values are absent from the RESPONSE
 * BYTES rather than merely hidden in the rendered page.
 *
 * -----------------------------------------------------------------------------
 * THEY ARE NOT ANONYMISATION AND MUST NOT BE MISTAKEN FOR IT.
 *
 * A masked email is still a strong pseudonym: the same address always produces
 * the same mask, so an operator can tell two rows apart and can recognise a
 * return visit. That is the point — an operations screen where every learner
 * looked identical would be useless. What masking buys is that reading a LIST
 * does not disclose a hundred addresses, and that seeing one requires asking
 * for it on the record.
 *
 * The unmasked value is reachable through `POST /admin/reveal`, which writes an
 * audit row naming the actor, the subject and the reason. That is the design:
 * not "an operator cannot see this", but "an operator cannot see this by
 * accident, and never without it being written down."
 * =============================================================================
 */

/** What a masked field looks like when there is nothing to mask. */
const EMPTY = '—';

/**
 * `a•••@e•••.test`
 *
 * FIRST CHARACTER AND THE FULL TLD SURVIVE, and both choices are deliberate:
 *
 *   the first character   makes two different addresses distinguishable at a
 *                         glance, which is what an operator scanning a list
 *                         actually needs.
 *   the TLD               makes `@example.test` obvious, so a seeded or
 *                         synthetic account is not mistaken for a real learner
 *                         during an incident. That has cost time before.
 *
 * The local part's LENGTH IS NOT PRESERVED — always three dots, never one per
 * character. Length is a real signal about the underlying value and there is no
 * reason to leak it.
 */
export function maskEmail(email: string | null): string {
  if (email === null || email.trim().length === 0) return EMPTY;

  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    // Not shaped like an address. Mask the whole thing rather than guessing —
    // an unparseable value is exactly the one most likely to be something
    // unexpected, and unexpected is not a reason to disclose it.
    return `${email.slice(0, 1)}•••`;
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot === -1 ? '' : domain.slice(dot);

  return `${local.slice(0, 1)}•••@${domain.slice(0, 1)}•••${tld}`;
}

/**
 * `Aarav Sharma` -> `A.S.`
 *
 * Initials rather than a first name: a first name plus a school and a grade is
 * frequently enough to identify a child, and an operations list shows all
 * three together.
 */
export function maskName(name: string | null): string {
  if (name === null) return EMPTY;

  const initials = name
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    // `codePointAt` rather than `part[0]` or a spread: an initial in Devanagari
    // or an emoji is more than one UTF-16 code unit, and slicing one off yields
    // half a character. One code point is the smallest honest "first letter".
    .map((part) => `${String.fromCodePoint(part.codePointAt(0) ?? 0)}.`)
    .join('');

  return initials.length === 0 ? EMPTY : initials;
}

/**
 * What is left of a message once its text is removed.
 *
 * =============================================================================
 * THE TEXT IS NOT RETURNED AT ALL — NOT MASKED, ABSENT.
 *
 * Every other function here transforms a value. This one refuses to carry it.
 * A child's conversation with Foxy is the most sensitive data in the product,
 * and a partial mask of prose is not a mask: the first characters of a sentence
 * routinely contain the name, the question and the distress.
 *
 * `length` is kept because it is genuinely operational — a one-character turn
 * and a nine-hundred-character turn are different events when you are looking
 * at why a session went wrong — and because it discloses nothing on its own.
 * =============================================================================
 */
export interface RedactedMessage {
  readonly role: string;
  readonly length: number;
  readonly createdAt: string;
}

export function redactMessage(input: {
  role: string;
  content: string;
  createdAt: Date;
}): RedactedMessage {
  return {
    role: input.role,
    length: input.content.length,
    createdAt: input.createdAt.toISOString(),
  };
}

/**
 * A free-text field reduced to its shape.
 *
 * Used for the retrieval trace's `query`, `prompt` and `answer` — the columns
 * that exist to debug a bad answer and that contain, in order, a child's own
 * words, a template full of textbook passages, and a model's reply.
 */
export function redactText(value: string | null): { present: boolean; length: number } {
  return { present: value !== null, length: value?.length ?? 0 };
}
