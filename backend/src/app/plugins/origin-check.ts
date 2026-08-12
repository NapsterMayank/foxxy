import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../../platform/errors/index';

/**
 * Cross-site request forgery — the second half of §6.10.
 *
 * The row reads "`sameSite=lax` PLUS an origin check on state-changing
 * requests". Only the cookie attribute was built; this is the other half, and
 * the two are not redundant:
 *
 *  - `sameSite=lax` is the browser's promise. It is `lax` rather than `strict`
 *    on purpose, so that following the verification link from an email arrives
 *    authenticated (§6.1) — which means the cookie IS sent on a top-level
 *    cross-site GET.
 *  - This check is our own. It does not depend on the browser honouring an
 *    attribute, it covers the ecosystem of clients that treat `sameSite`
 *    loosely, and it is the layer that still holds if a future route is added
 *    that a `lax` cookie would have reached.
 *
 * SHARED, not identity-specific. It lives in `app/plugins` and is registered
 * once on the server, so every module built after this one inherits it without
 * anybody remembering to. A CSRF defence that each module opts into is a CSRF
 * defence that the twelfth module forgets.
 */

/**
 * Only these carry side effects. A GET is unaffected — the product has no
 * state-changing GET, and if one is ever added, this check is not the thing
 * that should be relaxed to accommodate it.
 */
const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * THE PAYMENT-WEBHOOK EXEMPTION, and the compensating control.
 *
 * Razorpay, Stripe and every other provider POSTs server-to-server. There is
 * no browser and therefore no `Origin` header, so an origin check would reject
 * every real payment event — a 403 that a provider retries for hours while
 * subscriptions silently fail to activate.
 *
 * The compensating control is HMAC SIGNATURE VERIFICATION, which is strictly
 * stronger than an origin check here: the origin header is a hint from a
 * browser, whereas the signature proves possession of a shared secret. The
 * webhook route MUST verify it before doing anything else, and
 * `platform/payments` deliberately leaves `verifyWebhook` outside the circuit
 * breaker so an outage can never stop us checking a signature (D-029).
 *
 * The exemption is a PATH PREFIX and nothing wider. If a second unauthenticated
 * server-to-server endpoint appears, it gets its own entry and its own
 * documented compensating control — never a loosened pattern.
 */
export const WEBHOOK_PATH_PATTERN = /^\/api\/v\d+\/webhooks\//;

export interface OriginCheckOptions {
  /**
   * The WRITE allow-list — `config.http.corsWriteOrigins`, plus `APP_URL`.
   *
   * NOT the CORS list. That distinction is the whole of open item 1: one list
   * served both, so adding a partner origin for a read-only integration also
   * handed it state-changing rights across the entire API, silently, in a commit
   * that looked like a read integration.
   *
   * This hook is the only place the write grant is enforced, so this is the only
   * place the write list is read. An origin on the read list but not this one
   * can GET and cannot POST — which is the grant somebody was trying to express
   * and previously could not.
   *
   * From `platform/config`, never hardcoded.
   */
  readonly origins: readonly string[];
  /** Paths exempt from the check. Defaults to the webhook prefix above. */
  readonly exemptPaths?: readonly RegExp[];
}

/** Trailing slashes only; scheme and host are compared verbatim. */
function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function pathOf(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * The request's origin: the `Origin` header, or the origin part of `Referer`.
 *
 * `Referer` is the documented fallback because a handful of privacy tools and
 * older clients strip `Origin` on same-site requests. `null` — the literal
 * string a sandboxed iframe or a redirected cross-origin request sends — is
 * NOT an origin and must not be treated as one.
 */
export function originOfRequest(headers: {
  origin?: string | string[] | undefined;
  referer?: string | string[] | undefined;
}): string | null {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    return normaliseOrigin(origin);
  }

  const referer = Array.isArray(headers.referer) ? headers.referer[0] : headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Registers the check as an `onRequest` hook.
 *
 * `onRequest` rather than `preHandler` deliberately: it runs BEFORE the body is
 * parsed and before any route-level authentication, so a forged cross-site
 * request is refused without this process spending anything on it. The plan
 * calls it a "shared preHandler", which describes the SHAPE — one hook, every
 * route, defined once — rather than the lifecycle slot. Recorded as D-035.
 *
 * A missing origin is a REJECTION, not a pass. "No header, so it cannot be a
 * browser, so allow it" is exactly the reasoning an attacker relies on: a
 * `<form>` POST from another site is a browser request and the check must be
 * the thing that stops it, not a header the attacker chooses whether to send.
 */
export function registerOriginCheck(app: FastifyInstance, options: OriginCheckOptions): void {
  const allowed = new Set(options.origins.map(normaliseOrigin));
  const exempt = options.exemptPaths ?? [WEBHOOK_PATH_PATTERN];

  app.addHook('onRequest', (request: FastifyRequest, _reply, done: (error?: Error) => void) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) {
      done();
      return;
    }

    const path = pathOf(request.url);
    if (exempt.some((pattern) => pattern.test(path))) {
      done();
      return;
    }

    const origin = originOfRequest(request.headers);
    if (origin === null || !allowed.has(origin)) {
      // The log line records that an origin was absent or unrecognised. It does
      // NOT record the value: an attacker controls it, and echoing attacker
      // input into a log is how log injection starts.
      done(
        new ForbiddenError({
          message: `Origin check failed for ${request.method} ${path}: ${
            origin === null ? 'no Origin or Referer header' : 'origin not on the allow-list'
          }`,
        }),
      );
      return;
    }

    done();
  });
}
