import nodemailer from 'nodemailer';
// The §4 timeout table, not a number invented here. See `SMTP_TIMEOUT_DEFAULTS`.
// Imported from the module rather than from `config/index`, which loads and
// validates the whole environment as an import side effect.
import { DEFAULT_TIMEOUT_POLICY } from '../config/timeouts';
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
  /**
   * ==========================================================================
   * THE SOCKET'S OWN DEADLINES — D-332. §4: "every outbound call has a timeout.
   * A call without one is a defect."
   *
   * This transport had NONE of the three. nodemailer's own defaults for
   * `connectionTimeout`, `greetingTimeout` and `socketTimeout` are effectively
   * "wait for the OS", which for a silently dropped TCP connection is minutes.
   *
   * TWO CONSEQUENCES, AND THE SECOND ONE IS THE EXPENSIVE ONE.
   *
   *  1. Signup and password-reset mail inherit the hang. A request holds a
   *     connection, a pool slot and a stack for as long as the socket wedges.
   *
   *  2. THE ALERT EVALUATOR AWAITS `deliver()` INSIDE `runCycle`, and the loop
   *     awaits `runCycle`. One wedged SMTP socket therefore stalls EVERY rule —
   *     readiness, pool saturation, backup age — so the monitoring goes dark at
   *     exactly the moment something is wrong enough to be sending mail about.
   *
   * `createGuardedMail` bounds the CALLER's wait via the port guard, and that is
   * genuinely load-bearing, but a race only stops us waiting: it cannot close
   * the socket. The wedged connection stays open, holding a file descriptor and
   * one of the five `mail` concurrency slots until the OS gives up. A
   * socket-level deadline is strictly better than an outer race, and having both
   * is better still — the guard bounds the request, these bound the resource.
   *
   * OPTIONAL WITH DEFAULTS rather than required, and the defaults are not
   * invented here: they are the §4 `mail` row (`connectMs` / `totalMs`) that
   * every other mail deadline in the system already comes from. A caller that
   * forgets therefore still gets a deadline, which is the point — "a call
   * without one is a defect" must not be satisfiable by omission.
   * ==========================================================================
   */
  readonly connectionTimeoutMs?: number;
  /** How long to wait for the server's SMTP banner after connecting. */
  readonly greetingTimeoutMs?: number;
  /** How long a socket may sit idle mid-conversation before it is destroyed. */
  readonly socketTimeoutMs?: number;
}

/**
 * The §4 `mail` row, applied at the socket — D-332.
 *
 * `connectMs` bounds the TCP connect and, separately, the wait for the banner:
 * a server that accepts a connection and then never greets is the same outage as
 * one that never accepts, and neither deserves more patience than the other.
 * `totalMs` bounds socket idleness, because it is the whole call's budget and
 * there is nothing left to spend once it is gone.
 */
export const SMTP_TIMEOUT_DEFAULTS = Object.freeze({
  connectionTimeoutMs: DEFAULT_TIMEOUT_POLICY.mail.connectMs,
  greetingTimeoutMs: DEFAULT_TIMEOUT_POLICY.mail.connectMs,
  socketTimeoutMs: DEFAULT_TIMEOUT_POLICY.mail.totalMs,
});

/**
 * Exactly the nodemailer options this adapter sets, named structurally so the
 * transport can be faked — see `SmtpTransportFactory`.
 */
export interface SmtpTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly auth: { readonly user: string; readonly pass: string };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
}

/** The one method this adapter uses of whatever nodemailer hands back. */
export interface SmtpSender {
  sendMail(message: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
  }): Promise<unknown>;
}

/**
 * How a transport is constructed — D-332, and the seam that makes the deadlines
 * assertable.
 *
 * Without it, "does this transport carry a socket timeout" is answerable only by
 * opening a socket to a real SMTP server that hangs, which no test in this
 * repository is allowed to do. With it, a test supplies its own factory, reads
 * the options it was handed, and can drive a send that never settles.
 */
export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpSender;

const nodemailerFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

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
 *
 * All three socket deadlines are set here — D-332. See `SmtpConfig` for why a
 * transport without them stalls the alert evaluator as well as signup.
 */
export function createNodemailerTransport(
  smtp: SmtpConfig,
  createTransport: SmtpTransportFactory = nodemailerFactory,
): MailTransport {
  const transporter = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.password },
    // D-332. `??`, not `||`: a caller that means "no patience at all" is wrong,
    // but silently substituting ten seconds for their zero would be a second
    // wrong on top of it.
    connectionTimeout: smtp.connectionTimeoutMs ?? SMTP_TIMEOUT_DEFAULTS.connectionTimeoutMs,
    greetingTimeout: smtp.greetingTimeoutMs ?? SMTP_TIMEOUT_DEFAULTS.greetingTimeoutMs,
    socketTimeout: smtp.socketTimeoutMs ?? SMTP_TIMEOUT_DEFAULTS.socketTimeoutMs,
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
