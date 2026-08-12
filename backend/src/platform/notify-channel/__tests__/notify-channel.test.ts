import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../clock/index';
import { DependencyError } from '../../errors/index';
import { FakeLogger } from '../../logger/index';
import { RecordingMail } from '../../mail/index';
import { MemoryMetrics } from '../../metrics/index';
import { PLATFORM_METRICS } from '../../metrics/metrics.port';
import type { Channel, ChannelMessage, ChannelName, ChannelRecipient } from '../channel.port';
import { textFor } from '../channel.port';
import { DEFAULT_CHANNELS, createNotificationDispatcher } from '../dispatcher';
import { createEmailChannel } from '../email-channel';
import { createPushChannel, createWhatsAppChannel } from '../unimplemented-channels';

/**
 * 05-ROADMAP.md §8, row 2: the notification CHANNEL PORT, "0.5 d now / rewrite
 * every call site later".
 *
 * The tests are about the three properties that make the half-day worth
 * spending: both languages are mandatory, an unimplemented channel is LOUD
 * rather than silent, and one channel's failure never hides another's.
 */

const RECIPIENT: ChannelRecipient = {
  userId: 'user-1',
  email: 'parent@example.test',
  language: 'en',
};

const MESSAGE: ChannelMessage = {
  kind: 'parent.weekly_digest',
  title: { en: 'This week', hi: 'इस सप्ताह' },
  body: { en: 'Asha completed 4 missions.', hi: 'आशा ने 4 मिशन पूरे किए।' },
};

describe('every message carries both languages', () => {
  it('renders the recipient language and keeps both available', () => {
    expect(textFor(MESSAGE.title, 'en')).toBe('This week');
    expect(textFor(MESSAGE.title, 'hi')).toBe('इस सप्ताह');
  });

  it('defaults to English when the recipient has no preference', () => {
    // `undefined` is a real state — a user who never opened settings — and it
    // must render something rather than nothing.
    expect(textFor(MESSAGE.body, undefined)).toBe('Asha completed 4 missions.');
  });

  it('rejects a single-language message AT THE TYPE LEVEL', () => {
    // This test cannot fail at runtime; it documents a COMPILE-TIME guarantee,
    // which is the guarantee that actually matters.
    //
    // P7 does not decay by decision. It decays when somebody adds a
    // notification under time pressure with English text and a `// TODO: hi` —
    // which renders perfectly for the person who wrote it and is invisible in
    // review. `BilingualText` requires both properties, so that notification
    // does not compile.
    //
    // The directives sit on the two offending PROPERTIES rather than on the
    // declaration, because `@ts-expect-error` suppresses the error on the line
    // that follows it and TypeScript reports a missing property at the property
    // site. If either line ever stops erroring, the type has been widened and
    // P7 has lost its mechanical enforcement — which is what the "unused
    // directive" failure would then be telling us.
    const englishOnly: ChannelMessage = {
      kind: 'x',
      // @ts-expect-error `hi` is required on BilingualText.
      title: { en: 'Only English' },
      // @ts-expect-error `hi` is required on BilingualText.
      body: { en: 'Only English' },
    };
    expect(englishOnly.kind).toBe('x');
  });
});

describe('unimplemented channels THROW rather than reporting a failed delivery', () => {
  it('rejects a WhatsApp send with a DependencyError naming the blocker', async () => {
    // The alternative — `{ delivered: false, reason: 'not implemented' }` — is
    // a silent failure wearing the costume of a handled one. The dispatcher
    // would record it and move on, identical in shape to "this parent has no
    // phone number". Six months later somebody enables WhatsApp in a policy,
    // nothing errors, and every digest is quietly not sent.
    const channel = createWhatsAppChannel();
    await expect(channel.send(RECIPIENT, MESSAGE)).rejects.toThrow(DependencyError);
  });

  it('rejects a push send the same way', async () => {
    await expect(createPushChannel().send(RECIPIENT, MESSAGE)).rejects.toThrow(DependencyError);
  });

  it('says what is missing and what it is waiting for', async () => {
    // If this is ever thrown in production, the channel was configured before
    // it was built — a deployment mistake that should page somebody. The error
    // has to be readable at 2am by whoever is holding the pager.
    try {
      await createWhatsAppChannel().send(RECIPIENT, MESSAGE);
      expect.unreachable('expected a DependencyError');
    } catch (error) {
      const dependency = error as DependencyError;
      expect(dependency.dependency).toBe('whatsapp');
      expect(dependency.message).toContain('NOT IMPLEMENTED');
      expect(dependency.message).toContain('Meta template approval');
      // The CLIENT sees nothing about our roadmap.
      expect(dependency.safeMessage).toBe('A required service is unavailable. Please try again.');
    }
  });
});

describe('the email channel', () => {
  it('delegates to the existing mail port', async () => {
    const mail = new RecordingMail();
    const result = await createEmailChannel({ mail }).send(RECIPIENT, MESSAGE);

    expect(result).toEqual({ channel: 'email', delivered: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe('parent@example.test');
    expect(mail.sent[0]?.data.title).toBe('This week');
  });

  it('renders the recipient language, not always English', async () => {
    const mail = new RecordingMail();
    await createEmailChannel({ mail }).send({ ...RECIPIENT, language: 'hi' }, MESSAGE);
    expect(mail.sent[0]?.data.title).toBe('इस सप्ताह');
  });

  it('reports a missing address as a RESULT, never as a throw', async () => {
    // A recipient with no email is ordinary and expected — a student who signed
    // up on a parent's phone may genuinely have none. Throwing would abort a
    // fan-out that still has an in-app delivery to attempt.
    const mail = new RecordingMail();
    const result = await createEmailChannel({ mail }).send({ userId: 'u' }, MESSAGE);

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('no email address');
    expect(mail.sent).toHaveLength(0);
  });
});

/** A channel that records what it was asked to deliver. */
function fakeChannel(name: ChannelName, behaviour: 'ok' | 'fail' | 'throw'): Channel {
  return {
    name,
    send(): Promise<{ channel: ChannelName; delivered: boolean; reason?: string }> {
      if (behaviour === 'throw') return Promise.reject(new Error(`${name} exploded`));
      return Promise.resolve({
        channel: name,
        delivered: behaviour === 'ok',
        ...(behaviour === 'fail' ? { reason: 'declined' } : {}),
      });
    },
  };
}

function buildDispatcher(
  behaviours: Readonly<Record<ChannelName, 'ok' | 'fail' | 'throw'>>,
  policy: Readonly<Record<string, readonly ChannelName[]>> = {},
) {
  const logger = new FakeLogger();
  const metrics = new MemoryMetrics({ clock: new FixedClock() });
  const dispatcher = createNotificationDispatcher({
    channels: {
      email: fakeChannel('email', behaviours.email),
      'in-app': fakeChannel('in-app', behaviours['in-app']),
      whatsapp: fakeChannel('whatsapp', behaviours.whatsapp),
      push: fakeChannel('push', behaviours.push),
    },
    policy,
    logger,
    metrics,
  });
  return { dispatcher, logger, metrics };
}

const ALL_OK = { email: 'ok', 'in-app': 'ok', whatsapp: 'ok', push: 'ok' } as const;

describe('the dispatcher selects channels by kind and by preference', () => {
  it('uses the policy for a known kind', () => {
    const { dispatcher } = buildDispatcher(ALL_OK, {
      'parent.weekly_digest': ['whatsapp', 'email', 'in-app'],
    });
    expect(dispatcher.channelsFor('parent.weekly_digest')).toEqual([
      'whatsapp',
      'email',
      'in-app',
    ]);
  });

  it('falls back to IN-APP ONLY for an unregistered kind', () => {
    // The conservative default, deliberately. An unknown kind is a message
    // somebody added without registering it; delivering it to an inbox or a
    // phone would mean an unreviewed notification reaching a parent.
    const { dispatcher } = buildDispatcher(ALL_OK);
    expect(dispatcher.channelsFor('something.new')).toEqual(DEFAULT_CHANNELS);
    expect(DEFAULT_CHANNELS).toEqual(['in-app']);
  });

  it('honours an opt-out', () => {
    const { dispatcher } = buildDispatcher(ALL_OK, {
      'parent.weekly_digest': ['email', 'in-app'],
    });
    expect(
      dispatcher.channelsFor('parent.weekly_digest', { optOut: ['email'] }),
    ).toEqual(['in-app']);
  });

  it('REFUSES to let a user opt out of in-app', () => {
    // Opting out of an in-app notification is opting out of a page in the
    // application — the user simply does not open it. Allowing it would create
    // the state "the system needed to tell you something and had nowhere to put
    // it", and the message would be DISCARDED rather than merely unread.
    const { dispatcher } = buildDispatcher(ALL_OK, {
      'parent.weekly_digest': ['email', 'in-app'],
    });
    expect(
      dispatcher.channelsFor('parent.weekly_digest', { optOut: ['email', 'in-app'] }),
    ).toEqual(['in-app']);
  });

  it('cannot opt IN to a channel the policy did not choose', () => {
    // Preference FILTERS the policy; it never extends it. A user opting in to a
    // channel the product does not use for that kind would be asking for a
    // message that has no template.
    const { dispatcher } = buildDispatcher(ALL_OK, { 'x.y': ['in-app'] });
    expect(dispatcher.channelsFor('x.y', { optOut: [] })).toEqual(['in-app']);
  });
});

describe("one channel's failure never stops another", () => {
  it('still writes the in-app row when email THROWS', async () => {
    // This is what makes an unimplemented WhatsApp channel safe to leave in a
    // policy by accident: it throws loudly, it is recorded loudly, and the
    // deliveries beside it still happen.
    const { dispatcher, logger } = buildDispatcher(
      { ...ALL_OK, email: 'throw' },
      { 'parent.weekly_digest': ['email', 'in-app'] },
    );

    const outcome = await dispatcher.send(RECIPIENT, MESSAGE);

    expect(outcome.delivered).toBe(true);
    expect(outcome.results.map((result) => result.delivered)).toEqual([false, true]);
    expect(logger.lines.some((line) => line.obj.event === 'notify.channel_failed')).toBe(true);
  });

  it('counts sent and failed deliveries per channel', async () => {
    const { dispatcher, metrics } = buildDispatcher(
      { ...ALL_OK, email: 'fail' },
      { 'parent.weekly_digest': ['email', 'in-app'] },
    );

    await dispatcher.send(RECIPIENT, MESSAGE);

    expect(metrics.totalFor(PLATFORM_METRICS.NOTIFY_SENT)).toBe(1);
    expect(metrics.totalFor(PLATFORM_METRICS.NOTIFY_FAILED)).toBe(1);
  });

  it('logs at ERROR when the message reached nobody', async () => {
    // Distinct from a partial failure. It means the person was not told
    // something the system decided they needed to know, and nobody will notice
    // from the outside.
    const { dispatcher, logger } = buildDispatcher(
      { email: 'fail', 'in-app': 'throw', whatsapp: 'fail', push: 'fail' },
      { 'parent.weekly_digest': ['email', 'in-app'] },
    );

    const outcome = await dispatcher.send(RECIPIENT, MESSAGE);

    expect(outcome.delivered).toBe(false);
    const undeliverable = logger.lines.find((line) => line.obj.event === 'notify.undeliverable');
    expect(undeliverable?.level).toBe('error');
  });

  it('never logs the recipient', async () => {
    // A failure log is the easiest place to forget that an address is PII.
    const { dispatcher, logger } = buildDispatcher(
      { ...ALL_OK, email: 'throw' },
      { 'parent.weekly_digest': ['email', 'in-app'] },
    );

    await dispatcher.send(RECIPIENT, MESSAGE);

    const serialised = JSON.stringify(logger.lines);
    expect(serialised).not.toContain('parent@example.test');
    expect(serialised).not.toContain('user-1');
  });
});
