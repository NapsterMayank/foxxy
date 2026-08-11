import { describe, expect, it } from 'vitest';
import { createSmtpMail, type MailEnvelope, type MailTransport } from '../smtp-mail';
import type { MailMessage } from '../mail.port';

/**
 * =============================================================================
 * THE REAL MAIL ADAPTER — D-226.
 *
 * WHAT IT REPLACES. `platform/mail` shipped a console adapter, a guard, and NO
 * REAL IMPLEMENTATION, and the composition root defaulted to the console one
 * with no environment gate. Production printed verification and password-reset
 * links to stdout and delivered nothing, while `mail.send` resolved, the
 * breaker stayed closed and every probe stayed green. The entire acquisition
 * funnel was dead and the system reported itself perfectly healthy.
 *
 * NO TEST IN THIS FILE OPENS A SOCKET. `createSmtpMail` takes a `MailTransport`
 * — a one-method structural interface — and `createNodemailerTransport` is the
 * only function in the module that touches nodemailer. The seam is what
 * guarantees no mail is ever sent from a test, rather than a convention that
 * somebody eventually forgets.
 * =============================================================================
 */

const FROM = 'Foxxy <no-reply@foxxy.app>';

/** Records the envelope that WOULD have been sent. Three lines, because of the seam. */
class RecordingTransport implements MailTransport {
  readonly sent: MailEnvelope[] = [];

  sendMail(envelope: MailEnvelope): Promise<void> {
    this.sent.push(envelope);
    return Promise.resolve();
  }
}

/** A transport that fails, the way an unreachable SMTP server does. */
class FailingTransport implements MailTransport {
  sendMail(): Promise<void> {
    return Promise.reject(new Error('connect ETIMEDOUT 142.250.185.109:587'));
  }
}

function verification(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'aditi.sharma@example.com',
    template: 'email-verification',
    data: { verifyUrl: 'https://foxxy.app/verify?token=abc123' },
    ...overrides,
  };
}

describe('createSmtpMail builds and hands over an envelope', () => {
  it('sends ONE message per call, with the configured From', async () => {
    // The property the whole defect was about: something actually leaves the
    // process. Before this adapter existed, `send` resolved having done nothing.
    const transport = new RecordingTransport();

    await createSmtpMail({ transport, from: FROM }).send(verification());

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.from).toBe(FROM);
    expect(transport.sent[0]?.to).toBe('aditi.sharma@example.com');
  });

  it('renders the template, so the body carries the link the user must click', async () => {
    // The failure this catches is a delivered email containing the word
    // `undefined` where the verification link should be — accepted by the
    // server, reported as sent, and completely useless.
    const transport = new RecordingTransport();

    await createSmtpMail({ transport, from: FROM }).send(verification());

    const envelope = transport.sent[0];
    expect(envelope?.subject).toBe('Verify your email address');
    expect(envelope?.text).toContain('https://foxxy.app/verify?token=abc123');
    expect(envelope?.text).not.toContain('undefined');
  });

  it('renders each of the four templates with its own subject', async () => {
    // `MailTemplate` is a union and the renderer table is `Record<MailTemplate, …>`,
    // so a new member is a compile error rather than a runtime "unknown
    // template" on the one send that uses it. This asserts the table is
    // actually WIRED, which the type cannot.
    const transport = new RecordingTransport();
    const mail = createSmtpMail({ transport, from: FROM });

    await mail.send(verification());
    await mail.send({
      to: 'a@example.com',
      template: 'password-reset',
      data: { resetUrl: 'https://foxxy.app/reset?token=xyz' },
    });
    await mail.send({
      to: 'a@example.com',
      template: 'signup-attempt-on-existing-account',
      data: { appUrl: 'https://foxxy.app' },
    });
    await mail.send({
      to: 'a@example.com',
      template: 'weekly-digest',
      data: { title: 'Your week', body: 'Aditi practised on four days.' },
    });

    expect(transport.sent.map((envelope) => envelope.subject)).toEqual([
      'Verify your email address',
      'Reset your Foxxy password',
      'Someone tried to sign up with your email address',
      'Your week',
    ]);
  });

  it('propagates a transport failure rather than swallowing it', async () => {
    // The guarded port turns this into a `DependencyError`, which the identity
    // service catches and defers. An adapter that swallowed it would recreate
    // the original defect exactly: send reports success, nothing is delivered.
    const mail = createSmtpMail({ transport: new FailingTransport(), from: FROM });

    await expect(mail.send(verification())).rejects.toThrow(/ETIMEDOUT/u);
  });
});

/**
 * =============================================================================
 * A MISSING FIELD IS A LOUD FAILURE, NOT AN EMPTY STRING.
 *
 * The common template defect is a renamed field at a call site. Without this,
 * its signature is a verification email whose link reads `undefined` — which is
 * delivered, accepted, and reported as sent.
 * =============================================================================
 */
describe('template fields', () => {
  it('refuses to send when a required field is missing', async () => {
    const transport = new RecordingTransport();
    const mail = createSmtpMail({ transport, from: FROM });

    await expect(mail.send({ ...verification(), data: {} })).rejects.toThrow(/verifyUrl/u);
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses an empty field, which renders identically to a missing one', async () => {
    const transport = new RecordingTransport();
    const mail = createSmtpMail({ transport, from: FROM });

    await expect(mail.send({ ...verification(), data: { verifyUrl: '' } })).rejects.toThrow(
      /verifyUrl/u,
    );
    expect(transport.sent).toHaveLength(0);
  });

  it('names the FIELD in the error and never the value', async () => {
    // The values here are a verification token and a reset token, and this
    // message reaches a log.
    const mail = createSmtpMail({ transport: new RecordingTransport(), from: FROM });

    await expect(
      mail.send({
        to: 'a@example.com',
        template: 'password-reset',
        data: { wrongName: 'super-secret-reset-token' },
      }),
    ).rejects.toThrow(/^(?!.*super-secret-reset-token).*resetUrl.*$/su);
  });
});

/**
 * =============================================================================
 * SMTP HEADER INJECTION — checked in the adapter, not left to the library.
 *
 * `to` reaches this port from a signup form. A CR or LF inside it is how an
 * attacker appends `Bcc:` to the message. The identity module's validation is
 * upstream of a port any future caller could reach without it, so the guarantee
 * belongs to the code that builds the envelope.
 * =============================================================================
 */
describe('header injection', () => {
  it.each([
    ['carriage return', 'victim@example.com\rBcc: attacker@evil.test'],
    ['line feed', 'victim@example.com\nBcc: attacker@evil.test'],
    ['CRLF', 'victim@example.com\r\nBcc: attacker@evil.test'],
  ])('refuses a recipient containing a %s', async (_label, address) => {
    const transport = new RecordingTransport();
    const mail = createSmtpMail({ transport, from: FROM });

    await expect(mail.send(verification({ to: address }))).rejects.toThrow(/line break/u);
    // REJECTED, not stripped: an address with a newline is an attack or a
    // serious bug, and "fixing" it would deliver to an address nobody asked for.
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses a From containing a line break, at construction', () => {
    // Checked once when the adapter is built rather than on every send: the
    // From address comes from configuration and cannot change afterwards.
    expect(() =>
      createSmtpMail({ transport: new RecordingTransport(), from: 'a@b.test\r\nBcc: c@d.test' }),
    ).toThrow(/line break/u);
  });

  it('does not put the offending address in the error message', async () => {
    // The value is an email address. This message reaches a log.
    const mail = createSmtpMail({ transport: new RecordingTransport(), from: FROM });

    await expect(
      mail.send(verification({ to: 'victim@example.com\nBcc: attacker@evil.test' })),
    ).rejects.toThrow(/^(?!.*attacker@evil\.test).*$/su);
  });

  it('refuses a rendered SUBJECT containing a line break', async () => {
    // `weekly-digest` composes its subject from caller-supplied data, so the
    // subject is as reachable from outside as the recipient is.
    const transport = new RecordingTransport();
    const mail = createSmtpMail({ transport, from: FROM });

    await expect(
      mail.send({
        to: 'a@example.com',
        template: 'weekly-digest',
        data: { title: 'Your week\r\nBcc: attacker@evil.test', body: 'x' },
      }),
    ).rejects.toThrow(/line break/u);
    expect(transport.sent).toHaveLength(0);
  });
});
