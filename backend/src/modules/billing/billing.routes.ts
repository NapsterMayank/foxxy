import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  BillingStatusResponse,
  CancelResponse,
  SubscribeResponse,
  WebhookResponse,
} from '@/shared/contracts/billing.contract';
import { requireActor as requireRequestActor } from '@/shared/http/require-actor';
import { billingSchemas, parseInput } from './billing.schema';
import type { BillingService } from './billing.service';
import type { BillingActor } from './billing.types';

/**
 * HTTP only — §2, layer table.
 *
 * Every handler does three things: validate the input, call ONE service method,
 * format the result. There is no `if` about a business rule in this file, no
 * arithmetic, and no database access. The access decisions are all in the
 * service, because a route that decided access would be a second place access
 * is decided.
 *
 * ============================================================================
 * THE WEBHOOK PATH IS `/api/v1/webhooks/billing`, NOT `/api/v1/billing/webhook`,
 * AND THE DIFFERENCE IS A SECURITY PROPERTY RATHER THAN A PREFERENCE.
 *
 * Plan §8.8 writes the endpoint as `POST /billing/webhook`. That path would
 * have been BROKEN IN PRODUCTION AND GREEN IN DEVELOPMENT, for a reason nothing
 * in the plan mentions: `app/plugins/origin-check.ts` exempts state-changing
 * requests from the CSRF origin check by the path pattern
 * `^/api/v\d+/webhooks/` and by nothing else. A payment provider POSTs
 * server-to-server and sends no browser `Origin`, so a webhook route outside
 * that prefix is refused 403 — for every genuine delivery, which the provider
 * then retries for hours while subscriptions silently fail to activate.
 *
 * The two available fixes were: widen the exemption pattern, or name the
 * endpoint so the existing pattern covers it. The plugin's own header answers
 * that — "the exemption is a PATH PREFIX and nothing wider… never a loosened
 * pattern" — so the endpoint moved. `billing.routes.test.ts` asserts both
 * halves: that this exact path is exempt, and that `/api/v1/billing/webhook`
 * is NOT, so a future rename cannot silently reintroduce the 403.
 *
 * ============================================================================
 * THE WEBHOOK IS THE ONLY ROUTE IN THE PRODUCT THAT RECEIVES A RAW BODY.
 *
 * §8.8 rule 1: the signature is verified BEFORE anything is parsed. The
 * signature is an HMAC over the exact bytes, so parsing and re-serialising
 * changes whitespace and key order and the digest never matches — and the fix
 * somebody then reaches for is to verify the re-serialised form, which verifies
 * a string the provider never sent.
 *
 * So the webhook is registered inside an ENCAPSULATED Fastify scope with its
 * own content-type parser that hands the body through as a string. The
 * encapsulation matters: a global `addContentTypeParser` would turn every other
 * route in the application into a raw-body route.
 * ============================================================================
 */

const API_PREFIX = '/api/v1';

/** The exempt prefix, matched by `WEBHOOK_PATH_PATTERN`. Not a coincidence. */
export const BILLING_WEBHOOK_PATH = `${API_PREFIX}/webhooks/billing`;

/**
 * D-263 — one implementation, in `shared/http`, bound to this module's name and
 * actor type. Three other modules carried a byte-identical copy of the body.
 */
function requireActor(request: FastifyRequest): BillingActor {
  return requireRequestActor(request, 'billing');
}

export interface BillingRoutesDeps {
  readonly service: BillingService;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export async function registerBillingRoutes(
  app: FastifyInstance,
  deps: BillingRoutesDeps,
): Promise<void> {
  const authenticated = { preHandler: deps.requireSession };

  /**
   * §8.8 — start a checkout.
   *
   * THE SUBJECT IS THE SESSION'S USER, always. There is no field in the request
   * a caller could set to subscribe somebody else — and no `payer` field
   * either, because a client choosing who to charge is a client choosing whose
   * card to use.
   */
  app.post(`${API_PREFIX}/billing/subscribe`, authenticated, async (request, reply) => {
    const body = parseInput(billingSchemas.subscribe, request.body);
    const { subscription, checkoutUrl } = await deps.service.createSubscription(
      requireActor(request),
      body.planCode,
    );

    const payload: SubscribeResponse = {
      subscriptionId: subscription.id,
      status: subscription.status,
      planCode: subscription.planCode,
      checkoutUrl,
      // Echoed so a school-paid seat renders honestly. Without it the client
      // would have to infer who pays from the role, which is the assumption
      // this module exists not to make.
      payer: { kind: subscription.payer.kind },
    };
    // 201: a subscription resource now exists, in `pending`. It grants nothing.
    return reply.status(201).send(payload);
  });

  /** §8.8 — status AND entitlements, from one row at one instant. */
  app.get(`${API_PREFIX}/billing/status`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const body: BillingStatusResponse = await deps.service.getSubscriptionStatus(
      actor,
      actor.userId,
    );
    return reply.status(200).send(body);
  });

  /**
   * §8.8 — cancel. 200, with the date access actually ends.
   *
   * Not 204: "you keep access until the 14th" is the single most important
   * thing to tell somebody who has just cancelled, and an empty body would make
   * the client guess it.
   */
  app.post(`${API_PREFIX}/billing/cancel`, authenticated, async (request, reply) => {
    const actor = requireActor(request);
    const subscription = await deps.service.cancelSubscription(actor, actor.userId);
    const body: CancelResponse = {
      subscriptionId: subscription.id,
      status: subscription.status,
      accessUntil: subscription.currentPeriodEnd?.toISOString() ?? null,
    };
    return reply.status(200).send(body);
  });

  /**
   * §8.8 — THE PROVIDER'S CALLBACK. Unauthenticated by definition.
   *
   * Registered in its own encapsulated scope so the raw-body parser applies
   * HERE AND NOWHERE ELSE — see the header.
   */
  await app.register((instance: FastifyInstance, _opts, done: () => void) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, next) => {
        // Handed through UNPARSED. This is the whole point of the scope.
        next(null, body);
      },
    );

    instance.post(BILLING_WEBHOOK_PATH, async (request, reply) => {
      const rawBody = typeof request.body === 'string' ? request.body : '';
      const signature = headerValue(request, 'x-razorpay-signature');
      const eventId = headerValue(request, 'x-razorpay-event-id');

      const outcome = await deps.service.handleWebhook({
        rawBody,
        signature,
        eventId: eventId.length > 0 ? eventId : null,
      });

      const body: WebhookResponse = { received: outcome.result !== 'rejected' };

      /**
       * THREE OUTCOMES, TWO STATUS CODES, AND NO DETAIL IN EITHER.
       *
       *  rejected  400 — the signature did not verify. NOT 401/403: those
       *                  invite a retry loop against an endpoint that has no
       *                  credentials to fix. The body says nothing about why.
       *  duplicate 200 — already processed. The provider MUST stop retrying,
       *                  and it only stops on a 2xx.
       *  processed 200 — recorded, and applied if there was anything to apply.
       *
       * A FAILURE NEVER REACHES HERE. It propagates out of the service to the
       * error handler and becomes a 5xx, which is §8.8 rule 4: the provider
       * retries, and rule 2's unique constraint makes the retry a no-op. There
       * is no `catch` in this handler, deliberately — a catch that answered 200
       * would be exactly the swallowed error the rule forbids.
       */
      return reply.status(outcome.result === 'rejected' ? 400 : 200).send(body);
    });

    done();
  });
}

/** A header as a single string. Fastify hands arrays for repeated headers. */
function headerValue(request: FastifyRequest, name: string): string {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return typeof raw === 'string' ? raw : '';
}
