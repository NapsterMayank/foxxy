import type { PortGuard } from '../resilience/index';
import type { MailMessage, MailPort } from './mail.port';

/**
 * The mail port behind its bulkhead, breaker and 10s timeout (§3.3, §4, §5).
 *
 * The concurrency limit here is 5 — the lowest of any port — and that is not
 * a typo. §3.3's overflow behaviour for `mail` is "enqueue for the worker
 * instead", because nothing about sending an email needs to happen inside the
 * request that triggered it. The caller catches `DependencyError` and defers.
 *
 * The rule this protects is §15 of the implementation plan by another name:
 * a mail outage must degrade to "verification queued, signup completes",
 * never to "signup fails". A user who cannot create an account does not come
 * back; a user whose email arrives four minutes late does.
 */
export function createGuardedMail(inner: MailPort, guard: PortGuard): MailPort {
  return {
    send(message: MailMessage): Promise<void> {
      /**
       * DELIBERATELY NOT `idempotent: true` — D-237.
       *
       * `mail`'s §4 rule carries the largest retry budget in the table,
       * `retries: 3`, and this is the single most dangerous place it could
       * have been spent. An SMTP send that TIMES OUT has very often been
       * accepted: the message went, the acknowledgement did not. Three retries
       * on top of that sends a verification link up to four times, from a
       * change whose stated purpose was reliability — and a password-reset link
       * arriving four times is a security signal a user cannot interpret.
       *
       * The correct answer for mail is not a retry, it is §3.3's overflow
       * behaviour, which this port already has: the caller catches
       * `DependencyError` and DEFERS TO THE WORKER, where the job queue's own
       * at-least-once semantics and de-duplication apply. A retry here would be
       * a second, worse delivery mechanism competing with the good one.
       *
       * The budget therefore stays unspent, which is a decision and is why it
       * is written down. `retries: 3` remains the ceiling if a genuinely
       * repeatable mail operation ever exists.
       */
      return guard.run(() => inner.send(message));
    },
  };
}
