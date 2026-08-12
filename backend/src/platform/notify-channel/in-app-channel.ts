import type { Clock } from '../clock/index';
import type { DbHandle } from '../db/index';
import { schema } from '../db/index';
import { scrubRecord } from '../pii/index';
import type { Channel, ChannelMessage, ChannelRecipient, ChannelResult } from './channel.port';

/**
 * The in-app channel — one row in `notifications`.
 *
 * ===========================================================================
 * THE ONLY CHANNEL THAT CANNOT FAIL FOR A REASON OUTSIDE OUR CONTROL.
 *
 * Email needs a provider. WhatsApp needs Meta's approval and a template they
 * signed off. Push needs a device token that expires without telling anyone.
 * This one needs an INSERT.
 *
 * That makes it the correct FALLBACK in the dispatcher's channel list, and it
 * is why the default policy in `dispatcher.ts` includes it for every message
 * kind rather than treating it as one option among equals: a notification that
 * reached nobody because the mail provider was down is a notification the user
 * still finds when they next open the app.
 *
 * ===========================================================================
 * IT WRITES BOTH LANGUAGES, NOT THE RENDERED ONE.
 *
 * The email channel renders `recipient.language` and sends one string, because
 * an email is a thing that has already been sent. A notification row is READ
 * LATER — potentially after the user has changed their language preference, and
 * potentially by a parent and a student with different preferences looking at
 * related data.
 *
 * Storing the rendered string would freeze the language at write time and make
 * a preference change apply only to future notifications, which is the kind of
 * half-working behaviour that produces a bug report nobody can reproduce.
 */

const { notifications } = schema;

export interface InAppChannelOptions {
  readonly db: DbHandle;
  readonly clock: Clock;
}

export function createInAppChannel(options: InAppChannelOptions): Channel {
  const { db, clock } = options;

  return {
    name: 'in-app',

    async send(recipient: ChannelRecipient, message: ChannelMessage): Promise<ChannelResult> {
      // Identifiers and counts only, same rule and same scrubber as
      // `audit_log.metadata`. A notification payload is a tempting place to
      // stash "the child's name, so the client does not have to fetch it", and
      // that is exactly how a name ends up in a table with a weaker access
      // model than the one it came from.
      const { value: data } = scrubRecord(message.data ?? {});

      const rows = await db.db
        .insert(notifications)
        .values({
          recipientUserId: recipient.userId,
          tenantId: recipient.tenantId ?? null,
          kind: message.kind,
          titleEn: message.title.en,
          bodyEn: message.body.en,
          titleHi: message.title.hi,
          bodyHi: message.body.hi,
          data,
          // The injected clock, not `defaultNow()` — D-019: two clocks either
          // side of one comparison is a defect that only shows under skew, and
          // "notifications since I last looked" is exactly such a comparison.
          createdAt: clock.now(),
        })
        .returning({ id: notifications.id });

      const id = rows[0]?.id;
      if (id === undefined) {
        // Unreachable: an INSERT ... RETURNING either returns a row or throws.
        // Reported as a failed result rather than asserted, because this is a
        // delivery path and the dispatcher's job is to try the next channel,
        // not to unwind.
        return { channel: 'in-app', delivered: false, reason: 'insert returned no row' };
      }

      return { channel: 'in-app', delivered: true, reference: id };
    },
  };
}
