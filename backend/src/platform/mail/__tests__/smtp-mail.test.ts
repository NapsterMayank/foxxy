import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_POLICY } from '../../config/timeouts';
import {
  SMTP_TIMEOUT_DEFAULTS,
  createNodemailerTransport,
  createSmtpMail,
  type MailEnvelope,
  type MailTransport,
  type SmtpConfig,
  type SmtpTransportFactory,
  type SmtpTransportOptions,
} from '../smtp-mail';
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

/**
 * =============================================================================
 * THE SOCKET HAS A DEADLINE — D-332.
 *
 * `createNodemailerTransport` set NO `connectionTimeout`, NO `greetingTimeout`
 * and NO `socketTimeout`. nodemailer's defaults are effectively "wait for the
 * OS", which for a silently dropped TCP connection is minutes.
 *
 * The expensive consequence is not signup. It is that the ALERT EVALUATOR
 * awaits `deliver()` inside `runCycle`, and its loop awaits `runCycle` — so one
 * wedged SMTP socket stalls EVERY rule: readiness, pool saturation, backup age.
 * The monitoring goes dark at precisely the moment something is wrong enough to
 * be sending mail about it. `createGuardedMail` bounds the caller's wait, and
 * that is real, but a race cannot close a socket: the wedged connection keeps
 * its file descriptor and one of the five `mail` concurrency slots regardless.
 *
 * HOW THIS IS TESTED WITHOUT A SOCKET, stated plainly because the honesty of the
 * second test depends on it. `createNodemailerTransport` now takes a transport
 * FACTORY, defaulting to nodemailer's. The tests supply their own, so:
 *
 *  - the first test asserts the exact deadlines handed to the transport. That is
 *    the whole of what this adapter controls; enforcing them is nodemailer's job
 *    and is not re-implemented here.
 *  - the second drives a send that never settles through a fake which applies
 *    the `socketTimeout` IT WAS GIVEN, the way a real socket does. It is a
 *    contract test — "the number we hand over is the number that bounds the
 *    send" — and it goes red when the option is absent, because the fake then
 *    has no deadline to apply and the promise hangs forever, which is exactly
 *    the production behaviour being pinned.
 *
 * NO `sleep`, per §9.5: the budget is spent with vitest's fake timers.
 * =============================================================================
 */

const SMTP: SmtpConfig = {
  host: 'smtp.gmail.com',
  port: 587,
  user: 'no-reply@foxxy.app',
  password: 'app-password',
  from: FROM,
};

/** Every options object a factory was handed, for assertion. */
function recordingFactory(): {
  readonly options: SmtpTransportOptions[];
  readonly factory: SmtpTransportFactory;
} {
  const options: SmtpTransportOptions[] = [];
  return {
    options,
    factory: (given) => {
      options.push(given);
      return { sendMail: () => Promise.resolve(undefined) };
    },
  };
}

/**
 * A send that never completes, bounded only by the `socketTimeout` it was
 * configured with — a wedged socket, in the small.
 *
 * The option is read through a widened type ON PURPOSE. The defect being pinned
 * is an ABSENT value, and reading it at its declared `number` would make the
 * fake assume the very thing under test.
 */
const hangingFactory: SmtpTransportFactory = (given) => ({
  sendMail: () =>
    new Promise((_resolve, reject) => {
      const budget = (given as { socketTimeout?: number }).socketTimeout;
      if (budget === undefined) return; // No deadline: hangs forever, as production did.
      setTimeout(() => {
        reject(new Error('Socket timeout'));
      }, budget);
    }),
});

const ENVELOPE: MailEnvelope = {
  from: FROM,
  to: 'aditi.sharma@example.com',
  subject: 'Verify your email',
  text: 'https://foxxy.app/verify?token=abc123',
};

describe('createNodemailerTransport sets all three socket deadlines — D-332', () => {
  it('passes connectionTimeout, greetingTimeout and socketTimeout to the transport', () => {
    const { options, factory } = recordingFactory();

    createNodemailerTransport(SMTP, factory);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      connectionTimeout: SMTP_TIMEOUT_DEFAULTS.connectionTimeoutMs,
      greetingTimeout: SMTP_TIMEOUT_DEFAULTS.greetingTimeoutMs,
      socketTimeout: SMTP_TIMEOUT_DEFAULTS.socketTimeoutMs,
    });
  });

  it('defaults come from the §4 mail row, not from a number invented here', () => {
    // The point of the default is that it is the SAME budget the port guard
    // uses. Two independently chosen numbers for one dependency's patience is
    // how a socket outlives the call that opened it.
    expect(SMTP_TIMEOUT_DEFAULTS.connectionTimeoutMs).toBe(DEFAULT_TIMEOUT_POLICY.mail.connectMs);
    expect(SMTP_TIMEOUT_DEFAULTS.greetingTimeoutMs).toBe(DEFAULT_TIMEOUT_POLICY.mail.connectMs);
    expect(SMTP_TIMEOUT_DEFAULTS.socketTimeoutMs).toBe(DEFAULT_TIMEOUT_POLICY.mail.totalMs);
  });

  it('an explicit budget overrides the default, including a deliberate zero', () => {
    // `??`, not `||`. A caller asking for no patience at all is probably wrong,
    // but substituting ten seconds for their zero would be a second wrong.
    const { options, factory } = recordingFactory();

    createNodemailerTransport(
      { ...SMTP, connectionTimeoutMs: 1_500, greetingTimeoutMs: 0, socketTimeoutMs: 4_000 },
      factory,
    );

    expect(options[0]).toMatchObject({
      connectionTimeout: 1_500,
      greetingTimeout: 0,
      socketTimeout: 4_000,
    });
  });

  it('still carries STARTTLS and the derived `secure`, so the deadlines cost no security', () => {
    const { options, factory } = recordingFactory();
    createNodemailerTransport(SMTP, factory);
    expect(options[0]).toMatchObject({ secure: false, requireTLS: true });

    const implicit = recordingFactory();
    createNodemailerTransport({ ...SMTP, port: 465 }, implicit.factory);
    expect(implicit.options[0]).toMatchObject({ secure: true, requireTLS: false });
  });
});

describe('a wedged SMTP socket rejects within its budget — D-332', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects once the socket budget is spent, instead of hanging forever', async () => {
    const transport = createNodemailerTransport({ ...SMTP, socketTimeoutMs: 4_000 }, hangingFactory);

    const send = transport.sendMail(ENVELOPE);
    const settled = send.then(
      () => 'resolved',
      () => 'rejected',
    );

    // One millisecond short: still waiting. Without this the test would pass
    // against a transport that rejected instantly for some unrelated reason.
    await vi.advanceTimersByTimeAsync(3_999);
    await expect(
      Promise.race([settled, Promise.resolve('pending')]),
    ).resolves.toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBe('rejected');
  });

  it('bounds the DEFAULT-configured transport too — nobody has to remember', async () => {
    // The production path: `container.ts` supplies the budget, but a caller that
    // supplies nothing must still get one. "A call without a timeout is a
    // defect" cannot be satisfiable by omission.
    const transport = createNodemailerTransport(SMTP, hangingFactory);

    const settled = transport.sendMail(ENVELOPE).then(
      () => 'resolved',
      () => 'rejected',
    );

    await vi.advanceTimersByTimeAsync(SMTP_TIMEOUT_DEFAULTS.socketTimeoutMs);
    await expect(settled).resolves.toBe('rejected');
  });
});
