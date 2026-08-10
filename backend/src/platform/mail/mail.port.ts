/**
 * platform/mail — the outbound email port.
 *
 * INTERFACE plus a development adapter. The Resend adapter lands with the
 * identity module (build step 4); until then the dev adapter prints to stdout
 * so the whole signup flow can be exercised with no API key and no external
 * call.
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
 * Development adapter. Writes the message to stdout.
 *
 * Uses `process.stdout` rather than `console` deliberately: `no-console` is an
 * error everywhere in this codebase, and this is transport, not logging.
 */
export function createConsoleMail(): MailPort {
  return {
    send(message: MailMessage): Promise<void> {
      process.stdout.write(
        `\n--- MAIL (dev adapter, not sent) ---\n` +
          `to:       ${message.to}\n` +
          `template: ${message.template}\n` +
          `data:     ${JSON.stringify(message.data)}\n` +
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
