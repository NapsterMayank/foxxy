import nodemailer from 'nodemailer';
import { renderMail } from './mail-templates';
import type { MailMessage, MailPort } from './mail.port';

/**
 * THE REAL MAIL ADAPTER — SMTP. D-226.
 *
 * ===========================================================================
 * WHAT WAS BROKEN, BECAUSE IT IS THE WORST DEFECT IN THIS CODEBASE'S HISTORY.
 *
 * `platform/mail` shipped with a console adapter, a guard, and NO REAL
 * IMPLEMENTATION. The composition root defaulted to `createConsoleMail()` with
 * no environment gate at all. So in production:
 *
 *   - `signup` wrote a verification token to the database and printed its link
 *     to stdout. Nobody could ever verify an address.
 *   - `forgotPassword` did the same with a reset link.
 *   - Every probe was green, every metric was healthy, `mail.send` resolved,
 *     and the breaker never opened, because nothing ever failed.
 *
 * The entire acquisition funnel was dead and the system reported itself
 * perfectly healthy. `RESEND_API_KEY` was being passed by the deployment and
 * silently ignored, which is how it went unnoticed: the variable's presence was
 * the evidence people were reading.
 *
 * ===========================================================================
 * SMTP RATHER THAN AN HTTP VENDOR API.
 *
 * The owner intends to send through Google Workspace, so the transport is
 * SMTP with an app password. That is not a compromise — it is the version of
 * this adapter with the fewest moving parts: no SDK, no vendor auth model, no
 * webhook, and switching provider is four environment variables and no code.
 *
 * The PORT SHAPE IS UNCHANGED. `MailPort` still takes `{ to, template, data }`,
 * so nothing upstream of the composition root knows this exists.
 *
 * ===========================================================================
 * THE TRANSPORT IS INJECTED, AND THAT IS WHAT MAKES THIS TESTABLE.
 *
 * `createSmtpMail` takes a `MailTransport` — a one-method structural interface —
 * and `createNodemailerTransport` is the only thing in the file that touches
 * nodemailer. A test supplies its own recorder and asserts on the envelope that
 * WOULD have been sent. NO TEST IN THIS REPOSITORY EVER OPENS A SOCKET TO AN
 * SMTP SERVER, and the seam is what guarantees it rather than a convention.
 */

/** Exactly what an SMTP send needs. Structural, so a test fake is three lines. */
export interface MailEnvelope {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailTransport {
  sendMail(envelope: MailEnvelope): Promise<void>;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** The visible From address. May be an alias of `user`. */
  readonly from: string;
}

/**
 * The one function that knows nodemailer exists.
 *
 * `secure` is derived rather than configured: 465 is implicit TLS and every
 * other port (587, 25) is STARTTLS-upgraded. Making it a variable would add a
 * setting whose only wrong value produces a hang, and whose right value is
 * always a function of the port.
 *
 * `requireTLS` is set so that a server which does not offer STARTTLS is a
 * FAILURE rather than a silent downgrade to plaintext. Sending a password-reset
 * link in the clear because the peer declined an upgrade is precisely the kind
 * of quiet degradation this file exists to stop.
 */
export function createNodemailerTransport(smtp: SmtpConfig): MailTransport {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.password },
  });

  return {
    async sendMail(envelope: MailEnvelope): Promise<void> {
      await transporter.sendMail({
        from: envelope.from,
        to: envelope.to,
        subject: envelope.subject,
        text: envelope.text,
      });
    },
  };
}

export interface SmtpMailOptions {
  readonly transport: MailTransport;
  /** The visible From address, from `SMTP_FROM`. */
  readonly from: string;
}

/**
 * HEADER INJECTION IS CHECKED HERE, NOT LEFT TO THE LIBRARY.
 *
 * `to` reaches this adapter from a signup form. A CR or LF inside it is how an
 * attacker appends `Bcc:` to the message — the classic SMTP header injection —
 * and the identity module's own validation is upstream of a port that any
 * future caller could reach without it. Rejecting here means the guarantee
 * belongs to the adapter that builds the envelope.
 *
 * Rejected rather than stripped: an address containing a newline is not an
 * address with a typo, it is an attack or a serious bug, and silently
 * "fixing" it would deliver a message to a sanitised version of an address
 * nobody asked for.
 */
function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    // The FIELD, never the value. The value is an email address (PII) or a
    // rendered subject that can carry one, and this message reaches a log.
    throw new Error(`mail ${field} contains a line break; refusing to build an SMTP envelope`);
  }
}

export function createSmtpMail(options: SmtpMailOptions): MailPort {
  const { transport, from } = options;
  assertNoHeaderInjection(from, 'from');

  return {
    async send(message: MailMessage): Promise<void> {
      assertNoHeaderInjection(message.to, 'recipient');
      const rendered = renderMail(message);
      assertNoHeaderInjection(rendered.subject, 'subject');

      await transport.sendMail({
        from,
        to: message.to,
        subject: rendered.subject,
        text: rendered.text,
      });
    },
  };
}
