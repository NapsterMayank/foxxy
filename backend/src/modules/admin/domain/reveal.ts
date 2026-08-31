/**
 * =============================================================================
 * REVEAL — the one road to an unmasked value, with a gate on it.
 *
 * Every admin list and detail response is masked. This is the deliberate
 * exception, and its whole design is about making the exception COST something:
 * one request, one resource, named fields, a stated reason, and an audit row
 * that survives the operator who wrote it.
 *
 * The point is not "an operator cannot see this". They can — they have a
 * database credential, and a panel that pretended otherwise would be security
 * theatre aimed at the wrong threat. The point is that seeing it is a
 * deliberate act rather than a side effect of opening a list, and that "who
 * read that child's conversation, and why" has an answer.
 *
 * -----------------------------------------------------------------------------
 * THE FIELD MATRIX IS CLOSED, and that is what makes this endpoint reviewable.
 *
 * A generic "reveal any column of any table" would be one endpoint that can
 * read the entire database, including the password hashes. What can be
 * unmasked is enumerated below and is exactly the set that was masked in the
 * first place — nothing here exposes a column no admin response already
 * mentions in redacted form.
 * =============================================================================
 */

/**
 * WHY THE REASON IS A CODE AND NOT PROSE.
 *
 * `audit_log.metadata`'s contract is absolute: "IDENTIFIERS AND COUNTS ONLY.
 * Never an email, a phone number, a name, or free text a user typed." A typed
 * justification is free text, and free text typed during an incident is exactly
 * where a learner's name ends up.
 *
 * A closed set obeys that rule and is strictly more useful anyway: "show me
 * every reveal filed as an abuse_report last month" is a query against a code
 * and a grep against prose. The UI may collect a longer explanation for a human
 * to read elsewhere; it is not stored here.
 */
/**
 * =============================================================================
 * REVEAL IS THROTTLED SEPARATELY, AND FAR HARDER THAN THE REST OF THE PANEL.
 *
 * Every admin route already inherits the global authenticated limiter. That
 * limit is sized for reading screens, and reading screens is not the threat
 * here: the threat is ENUMERATION — one email per request, patiently, each one
 * dutifully writing an audit row that says a decision was made.
 *
 * An audit trail records enumeration; it does not prevent it, and a trail of
 * four hundred identical `support_request` reveals is evidence discovered
 * afterwards. A low ceiling makes the same behaviour take long enough to be
 * noticed while it happens, and it costs a legitimate operator nothing: reading
 * one child's email during a support call is one request, not thirty.
 *
 * Per ACTOR rather than per IP — an operator has one account and may move
 * between networks, and the account is what the audit row names.
 * =============================================================================
 */
export const REVEAL_LIMIT = { max: 30, windowSeconds: 3_600 } as const;

export const REVEAL_REASONS = [
  'support_request',
  'incident',
  'data_request',
  'quality_review',
  'abuse_report',
] as const;
export type RevealReason = (typeof REVEAL_REASONS)[number];

/**
 * What may be unmasked, per resource.
 *
 * Each entry mirrors something a masked response already showed in redacted
 * form — `emailMasked`, `displayNameMasked`, a turn's `length`, a trace's
 * `{present, length}`. There is no entry here for a column the panel does not
 * otherwise acknowledge, and adding one should feel like a decision.
 */
export const REVEALABLE = {
  /** The account's address, behind `emailMasked`. */
  user: ['email'],
  /** The learner's name, behind `displayNameMasked`. Keyed by user id. */
  learner: ['displayName'],
  /** Every turn's text, behind the transcript's per-turn `length`. */
  chat_session: ['transcript'],
  /** The three text columns behind a trace's `{present, length}` shapes. */
  retrieval_trace: ['query', 'prompt', 'answer'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type RevealResourceType = keyof typeof REVEALABLE;

export const REVEAL_RESOURCE_TYPES = Object.keys(REVEALABLE) as RevealResourceType[];

/**
 * Whether `field` may be revealed for `resourceType`.
 *
 * Checked in the service against this table rather than against the request, so
 * an unknown pairing is refused before any row is loaded — the failure happens
 * before the sensitive value is in memory, not after.
 */
export function isRevealable(resourceType: RevealResourceType, field: string): boolean {
  return (REVEALABLE[resourceType] as readonly string[]).includes(field);
}
