import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WEBHOOK SIGNATURE VERIFICATION — HMAC-SHA256, local, no network.
 *
 * ===========================================================================
 * THIS IS THE COMPENSATING CONTROL FOR THE CSRF EXEMPTION.
 *
 * `app/plugins/origin-check.ts` exempts `/api/v1/webhooks/` from the origin
 * check, because a payment provider POSTs server-to-server and sends no browser
 * `Origin` header. That exemption is only defensible because THIS runs instead,
 * and it is strictly stronger: an origin header is a hint from a browser,
 * whereas a signature proves possession of a shared secret.
 *
 * Which means the webhook route is, at that moment, an UNAUTHENTICATED PUBLIC
 * ENDPOINT that anybody on the internet can POST arbitrary bytes to. Everything
 * this file does is written on that assumption.
 * ===========================================================================
 *
 * THREE PROPERTIES, EACH OF WHICH HAS BEEN GOT WRONG IN PUBLISHED CODE:
 *
 * 1. THE COMPARISON IS TIMING-SAFE. `expected === given` leaks the correct
 *    prefix through response timing, one hex character at a time, which is a
 *    tractable forgery in a few thousand requests. `timingSafeEqual` requires
 *    equal-length buffers, so the length check happens first and separately —
 *    and a length mismatch is not a timing leak, because the length of a
 *    SHA-256 hex digest is public.
 *
 * 2. IT IS COMPUTED OVER THE RAW BYTES. Parsing then re-serialising the body
 *    changes whitespace and key order, so the digest would never match — and
 *    the "fix" somebody reaches for is to verify the re-serialised form, which
 *    verifies a string the provider never sent.
 *
 * 3. AN EMPTY SECRET NEVER VERIFIES. HMAC with an empty key is perfectly valid
 *    arithmetic and produces a digest an attacker can compute, so a deployment
 *    that forgot to set the secret would accept EVERY forged webhook while
 *    every test still passed. That is refused here rather than assumed away.
 */

/** The digest a provider should have sent for this body. Lower-case hex. */
export function computeSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * True when `signature` is the HMAC-SHA256 of `rawBody` under `secret`.
 *
 * Returns a boolean rather than throwing: a forged signature is an ordinary,
 * expected event on a public endpoint, not an exceptional one.
 */
export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  // Property 3. A missing secret is a configuration failure that must not
  // degrade into "accepts everything".
  if (secret.length === 0) return false;

  const expected = computeSignature(rawBody, secret);

  // `timingSafeEqual` throws on differing lengths, so the length is compared
  // first. Digest length is public information; the CONTENT is what must not
  // leak through timing.
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length) return false;

  return timingSafeEqual(given, want);
}
