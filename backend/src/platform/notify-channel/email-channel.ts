import type { MailPort, MailTemplate } from '../mail/index';
import {
  textFor,
  type Channel,
  type ChannelMessage,
  type ChannelRecipient,
  type ChannelResult,
} from './channel.port';

/**
 * The email channel — a thin adapter over the existing `platform/mail` port.
 *
 * ===========================================================================
 * IT DELEGATES RATHER THAN REPLACING. `platform/mail` stays exactly as it is.
 *
 * `mail` is a TEMPLATE-shaped port: `{ to, template, data }`, with the templates
 * enumerated in a union. That shape is right for transactional identity email —
 * verification, reset, "somebody tried to sign up with your address" — where the
 * body is fixed, legally sensitive, and lives with the provider.
 *
 * `notify-channel` is a MESSAGE-shaped port: title and body, in two languages,
 * for the same content delivered over email or WhatsApp or a push notification.
 * That shape is right for product notifications, where the content is composed
 * by the sender and only the transport differs.
 *
 * They are not the same port and neither should be bent into the other. Identity
 * keeps calling `mail.send` directly; nothing about signup changes. This adapter
 * exists so that a PRODUCT notification can reach an inbox, and it does so by
 * mapping onto the one generic template.
 *
 * ===========================================================================
 * THE CONSEQUENCE, STATED HONESTLY: `MailPort.data` is
 * `Record<string, string>`, so `ChannelMessage.data` cannot travel through it.
 * Only the rendered title and body do. That is adequate for every notification
 * that exists (all zero of them) and will need revisiting when a real templated
 * digest is built — at which point `mail` grows a `weekly-digest` template with
 * its own fields, which is exactly the change it is shaped for.
 *
 * Recorded here rather than discovered later, because the alternative is
 * somebody widening `MailPort.data` to `unknown` to make one notification work
 * and quietly removing the type safety from the signup emails.
 */

/**
 * The one template a generic notification maps onto.
 *
 * `weekly-digest` already exists in `MailTemplate`, added when the port was
 * written and never used. It is reused rather than a new `notification` member
 * being added, because adding a template that the provider has no matching
 * design for produces an email that renders as raw fields.
 */
const NOTIFICATION_TEMPLATE: MailTemplate = 'weekly-digest';

export interface EmailChannelOptions {
  readonly mail: MailPort;
}

export function createEmailChannel(options: EmailChannelOptions): Channel {
  return {
    name: 'email',

    async send(recipient: ChannelRecipient, message: ChannelMessage): Promise<ChannelResult> {
      // NOT AN EXCEPTION. A recipient with no email address is an ordinary,
      // expected outcome — a student who signed up on a parent's phone may
      // genuinely have none — and throwing would abort a fan-out that still has
      // an in-app delivery to attempt. See `ChannelResult` in the port.
      const to = recipient.email;
      if (to === undefined || to === null || to.length === 0) {
        return { channel: 'email', delivered: false, reason: 'no email address on file' };
      }

      // `mail.send` is already wrapped in its concurrency limit, its circuit
      // breaker and its timeout by the composition root (`createGuardedMail`),
      // so a dead provider fails fast here rather than holding the caller. A
      // genuine send failure THROWS, and the dispatcher catches it per channel.
      await options.mail.send({
        to,
        template: NOTIFICATION_TEMPLATE,
        data: {
          kind: message.kind,
          title: textFor(message.title, recipient.language),
          body: textFor(message.body, recipient.language),
          language: recipient.language ?? 'en',
        },
      });

      return { channel: 'email', delivered: true };
    },
  };
}
