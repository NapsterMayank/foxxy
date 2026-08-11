import type { PortGuard } from '../resilience/index';
import type {
  CreateSubscriptionRequest,
  CreatedSubscription,
  PaymentsPort,
  VerifiedWebhook,
  WebhookDelivery,
} from './payments.port';

/**
 * The payments port behind its bulkhead, breaker and 15s timeout (§3.3, §4, §5).
 *
 * Two deliberate asymmetries:
 *
 *  - `createSubscription` gets NO retries. §4: "none on writes — retrying a
 *    payment is worse than failing it." A failed checkout is a support ticket;
 *    a double charge is a refund, a chargeback and a customer who will not use
 *    the product again. The guard never retries on its own, and no caller may
 *    add one — `platform/retry` refuses a budget on a non-idempotent call.
 *    `cancelSubscription` is guarded on the same terms.
 *
 *    D-237 UPDATE — that first sentence is now TRUE RATHER THAN ASPIRATIONAL.
 *    `TimeoutRule.retries` used to be parsed and read by nothing, so
 *    `payments: { retries: 0 }` read as a deliberate safety property and was
 *    exactly as inert as every other row in the table: it forbade nothing,
 *    because nothing consulted it. The guard now spends the budget, and zero is
 *    a real zero — `createSubscription` and `cancelSubscription` get one
 *    attempt each even if some future call site declares them repeatable,
 *    because the PERMISSION cannot exceed the POLICY. The comment below and the
 *    behaviour of the code finally agree.
 *
 *  - `verifyWebhook` is NOT guarded. It is a local HMAC comparison with no
 *    network call in it, and routing it through a breaker would mean an open
 *    circuit could stop us verifying signatures — turning a provider outage
 *    into a security failure. Guard the calls that leave the process; nothing
 *    else.
 */
export function createGuardedPayments(inner: PaymentsPort, guard: PortGuard): PaymentsPort {
  return {
    // Forwarded, not re-derived. See `PaymentsPort.name`.
    name: inner.name,
    createSubscription(req: CreateSubscriptionRequest): Promise<CreatedSubscription> {
      return guard.run(() => inner.createSubscription(req));
    },
    cancelSubscription(providerSubscriptionId: string): Promise<void> {
      return guard.run(() => inner.cancelSubscription(providerSubscriptionId));
    },
    verifyWebhook(delivery: WebhookDelivery): VerifiedWebhook | null {
      return inner.verifyWebhook(delivery);
    },
  };
}
