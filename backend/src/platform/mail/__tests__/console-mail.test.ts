import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleMail } from '../mail.port';

/**
 * D-179 — `createConsoleMail` is the DEFAULT adapter at the composition root
 * and there is no Resend adapter yet, so every notification email in every
 * environment that has not overridden `mail` goes through it. It used to print
 * the recipient's address and the whole rendered `data` — body text, and the
 * verification token inside it — to stdout, which in a container is the log
 * stream. It bypassed `platform/logger` entirely, so none of the redaction
 * configured there applied.
 *
 * The suite never saw it because every harness substitutes `RecordingMail`.
 * That is exactly why this test asserts on the ADAPTER, with stdout captured.
 */

const RECIPIENT = 'aditi.sharma@example.com';
const TOKEN = 'hu06Wi4jXIIzTob9Hy_62bR1ywlxI9E6dpRRdOjhMeg';
const BODY = 'Hello Aditi, tap the link below to verify your email address.';

function capture(): { readonly output: () => string; readonly restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const restore = (): void => {
    spy.mockRestore();
  };
  return { output: (): string => chunks.join(''), restore };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createConsoleMail', () => {
  it('writes neither the recipient address nor any field value to stdout', async () => {
    const captured = capture();
    await createConsoleMail().send({
      to: RECIPIENT,
      template: 'email-verification',
      data: { name: 'Aditi', title: 'Verify your email', body: BODY, verifyUrl: TOKEN },
    });
    const output = captured.output();
    captured.restore();

    // NEGATIVE CONTROL: the adapter did write something, so the absences below
    // are absences from real output rather than from silence.
    expect(output).toContain('MAIL (dev adapter, not sent)');

    expect(output).not.toContain(RECIPIENT);
    expect(output).not.toContain('aditi.sharma');
    expect(output).not.toContain('Aditi');
    expect(output).not.toContain(BODY);
    expect(output).not.toContain(TOKEN);
  });

  it('still says enough to debug with: template, recipient domain, and field names', async () => {
    const captured = capture();
    await createConsoleMail().send({
      to: RECIPIENT,
      template: 'password-reset',
      data: { name: 'Aditi', resetUrl: TOKEN },
    });
    const output = captured.output();
    captured.restore();

    expect(output).toContain('password-reset');
    expect(output).toContain('[REDACTED]@example.com');
    // The KEYS are kept — a missing template field is the common bug and its
    // name is enough to see it. The VALUES are what carried the body.
    expect(output).toContain('2 field(s), values redacted: name, resetUrl');
  });

  it('says nothing at all about a recipient that is not address-shaped', async () => {
    const captured = capture();
    await createConsoleMail().send({
      to: 'not-an-address',
      template: 'weekly-digest',
      data: {},
    });
    const output = captured.output();
    captured.restore();

    expect(output).not.toContain('not-an-address');
    expect(output).toContain('to:       [REDACTED]');
  });
});
