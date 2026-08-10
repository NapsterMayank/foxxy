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
      return guard.run(() => inner.send(message));
    },
  };
}
