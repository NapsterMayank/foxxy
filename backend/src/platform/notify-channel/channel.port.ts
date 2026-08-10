/**
 * platform/notify-channel — one interface for every way a message can reach a
 * person.
 *
 * 05-ROADMAP.md §8, row 2: "Notification CHANNEL PORT — email, in-app,
 * WhatsApp, push. 0.5 d now. Cost later: REWRITE EVERY CALL SITE." §4 is
 * specific about why: Phase 2 delivers the parent weekly digest over WhatsApp
 * because "parents open WhatsApp; they do not open email", and "adding a
 * channel then becomes one adapter. Without it, every notification call site
 * has to be rewritten."
 *
 * ===========================================================================
 * WHAT "REWRITE EVERY CALL SITE" ACTUALLY MEANS, because half a day is a small
 * enough number to be dismissed.
 *
 * Without this port, `parent.sendWeeklyDigest` calls `mail.send(...)`. It now
 * contains an email template name, an email-shaped payload and a `to` address.
 * When WhatsApp arrives, that function has to learn what a WhatsApp template
 * is, which channel this parent prefers, and what to do when one channel fails
 * and the other has not been tried. So does the mission nudge. So does the
 * teacher alert. Each one grows the same branch, slightly differently, and the
 * differences are where the bugs live.
 *
 * With it, they call `dispatcher.send(recipient, message)` and the branch
 * exists once.
 *
 * ===========================================================================
 * EVERY MESSAGE CARRIES BOTH LANGUAGES, AND IT IS A TYPE ERROR NOT TO.
 *
 * `BilingualText` requires `en` AND `hi`. There is no partial form, no
 * `Partial<>`, and no default that silently fills one in.
 *
 * This is P7 ("all user-facing text supports Hindi and English") converted from
 * a rule people are asked to remember into one the compiler enforces. The way
 * P7 decays is never a decision — it is a notification added under time
 * pressure with English text and a `// TODO: hi`, which renders perfectly for
 * the person who wrote it and is invisible in review. Making the second
 * language a required property means that notification does not compile.
 *
 * The `notifications` table repeats the rule as four NOT NULL columns with a
 * non-empty CHECK, because a type does not survive a raw INSERT.
 */

import type { LanguageCode } from '../../shared/constants/curriculum';

/**
 * Text in both languages the product ships in.
 *
 * NOT `Record<LanguageCode, string>`, even though that is what it currently
 * means. A mapped type over a union silently gains a member the day a third
 * language is added to `LANGUAGES` — and every existing message object would
 * then fail to compile at once, in the middle of an unrelated change. Naming
 * the two explicitly means adding Marathi is a deliberate edit to this type
 * with the compiler listing exactly what must be revisited.
 */
export interface BilingualText {
  readonly en: string;
  readonly hi: string;
}

/**
 * Technical terms are NOT translated (P7) — CBSE, XP, Bloom's. Nothing in this
 * file enforces that; it is stated here because this is where somebody writing
 * a message will be looking.
 */
export interface ChannelMessage {
  /**
   * What kind of message this is: 'parent.weekly_digest',
   * 'student.mission_nudge'. The dispatcher routes on it, and the in-app
   * adapter stores it so a client can group and filter.
   */
  readonly kind: string;
  readonly title: BilingualText;
  readonly body: BilingualText;
  /**
   * Structured payload for the client to act on — identifiers and counts,
   * never prose and never PII. Scrubbed through `platform/pii` by the adapters
   * that persist it.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Who the message is for.
 *
 * It carries the addresses for EVERY channel rather than one resolved address,
 * because the dispatcher — not the caller — decides which channels to use. A
 * caller that had to pass an email address would already have made that
 * decision, which is the coupling this port removes.
 *
 * All addresses are optional: a student may have no phone number, a parent may
 * have no verified email. An adapter asked to send to a recipient it has no
 * address for reports a clean failure rather than throwing.
 */
export interface ChannelRecipient {
  readonly userId: string;
  readonly tenantId?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly pushToken?: string | null;
  /** Which language to render. Defaults to 'en' when absent. */
  readonly language?: LanguageCode;
}

export const CHANNEL_NAMES = ['email', 'in-app', 'whatsapp', 'push'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

/**
 * The outcome of one delivery attempt.
 *
 * A RESULT, not an exception, and the distinction is load-bearing. "This parent
 * has no phone number" is an ordinary, expected outcome of trying to reach them
 * on WhatsApp — it is not exceptional and it must not unwind the dispatcher
 * mid-fan-out, because the email that would have reached them is attempted
 * after it.
 *
 * Genuine faults — a dead provider, an unimplemented channel — still THROW,
 * and the dispatcher catches them per channel. The rule is: a result describes
 * a delivery that was attempted and did not land; a throw describes a channel
 * that could not be used at all.
 */
export interface ChannelResult {
  readonly channel: ChannelName;
  readonly delivered: boolean;
  /** Provider reference, where one exists. For support and reconciliation. */
  readonly reference?: string;
  /** Why it did not land. Operator-facing; never shown to a user. */
  readonly reason?: string;
}

export interface Channel {
  readonly name: ChannelName;
  send(recipient: ChannelRecipient, message: ChannelMessage): Promise<ChannelResult>;
}

/** Picks the recipient's language, defaulting to English. */
export function textFor(text: BilingualText, language: LanguageCode | undefined): string {
  return language === 'hi' ? text.hi : text.en;
}
