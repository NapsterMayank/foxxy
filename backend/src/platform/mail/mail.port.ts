/**
 * platform/mail — the outbound email port.
 *
 * INTERFACE plus a DEVELOPMENT adapter. The real one is `smtp-mail.ts`.
 *
 * This header used to say "the Resend adapter lands with the identity module
 * (build step 4)". It never did. The console adapter below stayed the default
 * at the composition root with NO ENVIRONMENT GATE, so production printed
 * verification and password-reset links to stdout and delivered nothing, while
 * every health probe stayed green (D-226). The gate now lives in
 * `createContainer`, which refuses to boot in production without SMTP
 * configuration — the same treatment `embed`, `llm` and `payments` already had.
 *
 * `createConsoleMail` remains, and remains the default OUTSIDE production, so
 * the signup flow can still be exercised end to end with no credentials and no
 * external call.
 */
export type MailTemplate =
  | 'email-verification'
  | 'password-reset'
  | 'signup-attempt-on-existing-account'
  | 'weekly-digest';

export interface MailMessage {
  readonly to: string;
  readonly template: MailTemplate;
  readonly data: Readonly<Record<string, string>>;
}

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

/**
 * D-179 — the recipient's address and the message body are not debug output.
 *
 * `createConsoleMail` is the DEFAULT adapter at the composition root and no
 * Resend adapter exists yet, so this is the adapter every notification email
 * goes through. It used to print the recipient address and the full rendered
 * `data` — title, body, and the verification token inside it — to stdout, on
 * every send, in every environment that had not overridden `mail`. Stdout is
 * collected: in a container it is the log stream, which means addresses and
 * bodies landed wherever logs land, having bypassed `platform/logger` and its
 * redaction entirely. The test suite never saw it because the harness
 * substitutes `RecordingMail`.
 *
 * What a development adapter is FOR is confirming that a send happened, for
 * which template, and roughly to whom. That is what it prints now:
 *
 *     to:       [REDACTED]@example.com   <- domain only; the person is gone
 *     template: email-verification
 *     data:     3 field(s): name, title, verifyUrl   <- keys, never values
 *
 * The KEYS are kept and the VALUES are not, because a missing field is the
 * common template bug and its name is enough to see it. The values are where
 * the body and the credential are.
 */
const REDACTED = '[REDACTED]';

function maskRecipient(address: string): string {
  const at = address.lastIndexOf('@');
  // No '@' means it is not an address shape at all; say nothing about it.
  if (at <= 0) return REDACTED;
  return `${REDACTED}${address.slice(at)}`;
}

/**
 * Development adapter. Announces the message on stdout without its contents.
 *
 * Uses `process.stdout` rather than `console` deliberately: `no-console` is an
 * error everywhere in this codebase, and this is transport, not logging.
 */
export function createConsoleMail(): MailPort {
  return {
    send(message: MailMessage): Promise<void> {
      const keys = Object.keys(message.data).sort();
      process.stdout.write(
        `\n--- MAIL (dev adapter, not sent) ---\n` +
          `to:       ${maskRecipient(message.to)}\n` +
          `template: ${message.template}\n` +
          `data:     ${keys.length} field(s), values redacted: ${keys.join(', ')}\n` +
          `------------------------------------\n\n`,
      );
      return Promise.resolve();
    },
  };
}

/** Test fake. Records every call; asserts run against `sent`. */
export class RecordingMail implements MailPort {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}
