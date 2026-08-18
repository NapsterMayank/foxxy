import type { MailMessage, MailTemplate } from './mail.port';

/**
 * The rendered bodies for the four transactional templates — D-226.
 *
 * ===========================================================================
 * THEY LIVE IN CODE, IN PLAIN TEXT, ON PURPOSE.
 *
 * `MailPort` is a template-shaped port: `{ to, template, data }`, with the
 * templates enumerated in a union. The union exists so that a provider can own
 * the DESIGN of the email while the application owns which one is sent and with
 * what fields. Google Workspace SMTP is not a template provider — it is a pipe —
 * so the rendering has to happen somewhere, and this is the smallest somewhere:
 * one function, no engine, no partials, no runtime file reads.
 *
 * Plain text rather than HTML because every one of these is a single sentence
 * and a link. An HTML body would need a text alternative anyway (spam filters
 * score multipart-with-no-text badly), so the HTML would be the second copy of
 * the same sentence, and the second copy is the one that goes stale.
 *
 * ===========================================================================
 * A MISSING FIELD THROWS. It does not render as an empty string.
 *
 * The common template defect is a renamed field at a call site, and its
 * signature without this is a verification email containing the word
 * `undefined` where the link should be — which is delivered, accepted,
 * reported as sent, and completely useless. `requireField` makes that a loud
 * failure at send time, which the guarded port turns into a `DependencyError`
 * the caller already knows how to defer.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
}

function requireField(message: MailMessage, field: string): string {
  const value = message.data[field];
  if (value === undefined || value.length === 0) {
    // The FIELD NAME, never the value: the values here are a verification
    // token and a reset token, and this message reaches a log.
    throw new Error(
      `mail template "${message.template}" requires a non-empty "${field}" field`,
    );
  }
  return value;
}

const SIGNATURE = '\n\nFoxxy\nThis is an automated message; replies are not read.\n';

/**
 * TOTAL over `MailTemplate`, and the type is what keeps it total.
 *
 * `Record<MailTemplate, …>` means adding a member to the union is a compile
 * error here rather than a runtime "unknown template" on the one send that uses
 * it. A `switch` with a `default` would have compiled and shipped.
 */
const RENDERERS: Readonly<Record<MailTemplate, (message: MailMessage) => RenderedMail>> = {
  'email-verification': (message) => ({
    subject: 'Verify your email address',
    text:
      'Welcome to Foxxy.\n\nConfirm this address to finish setting up your account:\n' +
      `${requireField(message, 'verifyUrl')}\n\n` +
      'The link expires in 24 hours. If you did not create an account, ignore this email.' +
      SIGNATURE,
  }),

  /**
   * The guardian-link second factor — migration 0007.
   *
   * IT NAMES THE CHILD AND SAYS WHAT PRESSING ON WILL GRANT. An OTP email that
   * says only "your code is 123456" is a code somebody types reflexively; a
   * parent who is being socially engineered into linking to a child that is not
   * theirs needs the child's name in front of them to notice.
   *
   * It also states the do-nothing path, because the safe action for a parent who
   * did not ask for this is to ignore it — and unlike a verification link, an
   * unused OTP leaves no trace they could be worried about.
   */
  'guardian-link-otp': (message) => ({
    subject: 'Your Foxxy verification code',
    text:
      'Use this code to finish linking your account to ' +
      `${requireField(message, 'studentName')}:\n\n` +
      `${requireField(message, 'otp')}\n\n` +
      'It expires in 10 minutes and can be used once. Once linked you will be able to see ' +
      'their weekly learning summary.\n\n' +
      'If you did not request this, ignore this email — nothing has been shared.' +
      SIGNATURE,
  }),

  'password-reset': (message) => ({
    subject: 'Reset your Foxxy password',
    text:
      'A password reset was requested for this address.\n\n' +
      `${requireField(message, 'resetUrl')}\n\n` +
      'The link expires in one hour and can be used once. If this was not you, no action is ' +
      'needed — your password has not changed.' +
      SIGNATURE,
  }),

  /**
   * The email sent to the OWNER of an address somebody tried to sign up with.
   *
   * It deliberately carries no token and no action. Signup must not reveal
   * whether an address is registered, so the reply to the person at the browser
   * is identical either way, and this is what makes that safe rather than
   * merely quiet — the real owner is told.
   */
  'signup-attempt-on-existing-account': (message) => ({
    subject: 'Someone tried to sign up with your email address',
    text:
      'An account already exists for this address, so nothing was created.\n\n' +
      `If it was you, sign in instead:\n${requireField(message, 'appUrl')}\n\n` +
      'If it was not, you do not need to do anything. Nobody can access your account with ' +
      'this email alone.' +
      SIGNATURE,
  }),

  /**
   * The generic product notification, mapped here by `notify-channel`'s email
   * adapter. Its `data` carries a pre-rendered title and body in the
   * recipient's language, so this renderer composes rather than writes.
   */
  'weekly-digest': (message) => ({
    subject: requireField(message, 'title'),
    text: `${requireField(message, 'body')}${SIGNATURE}`,
  }),
};

export function renderMail(message: MailMessage): RenderedMail {
  return RENDERERS[message.template](message);
}
