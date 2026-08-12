import { DependencyError } from '../errors/index';
import type { Channel, ChannelName } from './channel.port';

/**
 * `whatsapp` and `push` — DECLARED, NOT IMPLEMENTED.
 *
 * Both are Phase 2 and Phase 3 respectively. Neither can be built now: WhatsApp
 * needs Business API onboarding through a provider and Meta template approval,
 * which 05-ROADMAP.md §4 flags as taking days and being "outside our control";
 * push needs a mobile application to hold the token.
 *
 * ===========================================================================
 * WHY THEY EXIST AT ALL, RATHER THAN SIMPLY BEING ABSENT.
 *
 * Because `ChannelName` includes them, and a union member with no
 * implementation is a `Map.get` that returns `undefined` at some future call
 * site. What happens next depends entirely on who wrote that call site: an
 * optional chain, a silent skip, a crash. The dispatcher's channel lookup would
 * have to handle "this channel does not exist" as a case distinct from "this
 * channel failed", and the two are indistinguishable to the caller.
 *
 * With these, the union is total. Every `ChannelName` resolves to a `Channel`,
 * the dispatcher has one failure path instead of two, and asking for WhatsApp
 * today produces a clear, typed, LOUD refusal.
 *
 * ===========================================================================
 * THEY THROW. THEY DO NOT RETURN `{ delivered: false }`.
 *
 * This is the whole point of the file and it is worth being explicit.
 *
 * `{ delivered: false, reason: 'not implemented' }` is a SILENT FAILURE wearing
 * the costume of a handled one. The dispatcher would record it, move on, and
 * report a perfectly ordinary partial delivery — identical in shape to "this
 * parent has no phone number". Six months later somebody enables WhatsApp in a
 * policy, nothing errors, and every WhatsApp digest is quietly not sent. The
 * dashboard shows delivery attempts. The parents receive nothing.
 *
 * `DependencyError` instead: 502, a named dependency, and the message says what
 * is wrong and what to do. If it is ever thrown in production, the channel was
 * configured before it was built — which is a deployment mistake that should
 * page somebody, not degrade quietly.
 */

function createUnimplementedChannel(name: ChannelName, phase: string, blockedBy: string): Channel {
  return {
    name,
    send(): Promise<never> {
      return Promise.reject(
        new DependencyError(name, {
          message:
            `Notification channel "${name}" is declared but NOT IMPLEMENTED (${phase}). ` +
            `Blocked by: ${blockedBy}. ` +
            'It throws rather than reporting a failed delivery so that enabling it ' +
            'before it exists is loud instead of silently dropping every message.',
          details: { channel: name, phase, blockedBy },
        }),
      );
    },
  };
}

/**
 * WhatsApp — Phase 2, 23 days, and the highest-leverage channel in the Indian
 * market: 05-ROADMAP.md §4 expects the WhatsApp digest alone to "move parent
 * engagement more than any in-app work".
 */
export function createWhatsAppChannel(): Channel {
  return createUnimplementedChannel(
    'whatsapp',
    'Phase 2',
    'Business API onboarding through a provider and Meta template approval, which take days and are outside our control — start early (05-ROADMAP.md §4)',
  );
}

/** Push — Phase 3, and one of the three things a PWA cannot do well. */
export function createPushChannel(): Channel {
  return createUnimplementedChannel(
    'push',
    'Phase 3',
    'a native mobile application to hold the device token (05-ROADMAP.md §5)',
  );
}
