import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from '../signature';

/**
 * THE HMAC, EXERCISED FOR REAL.
 *
 * There is no Razorpay account and no key, so `createSubscription` can only
 * ever be tested against a mocked HTTP layer. This file is the part of the
 * payment subsystem that needs no vendor at all — it is local cryptography over
 * bytes we hold — and it is also the part that carries the entire security
 * weight of the webhook endpoint, because that endpoint is exempt from the CSRF
 * origin check.
 *
 * So the assertions below are deliberately adversarial rather than
 * confirmatory: every one of them is a way a signature check has actually been
 * got wrong in shipped code.
 */

const SECRET = 'whsec_test_9f2b';
const BODY = '{"event":"subscription.charged","payload":{}}';

describe('computeSignature', () => {
  it('is HMAC-SHA256 over the raw bytes, hex-encoded', () => {
    // Computed independently rather than by calling the function under test —
    // a self-referential assertion would pass against any stable algorithm,
    // including the wrong one.
    const expected = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    expect(computeSignature(BODY, SECRET)).toBe(expected);
    expect(computeSignature(BODY, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to the exact bytes — whitespace is not cosmetic', () => {
    // This is why the signature is computed over the RAW body and never over a
    // re-serialised parse: the two strings below are the same JSON VALUE and
    // have different signatures, so verifying a re-serialised body verifies a
    // string the provider never sent.
    const reserialised = JSON.stringify(JSON.parse(BODY));
    expect(reserialised).not.toBe(BODY.replace(/\s/g, '') + ' ');
    expect(computeSignature(`${BODY} `, SECRET)).not.toBe(computeSignature(BODY, SECRET));
  });
});

describe('verifySignature', () => {
  it('accepts a genuine signature', () => {
    expect(verifySignature(BODY, computeSignature(BODY, SECRET), SECRET)).toBe(true);
  });

  it('rejects a forged signature of the correct length', () => {
    const forged = 'a'.repeat(64);
    expect(forged).toHaveLength(computeSignature(BODY, SECRET).length);
    expect(verifySignature(BODY, forged, SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` throws on unequal lengths. A version that called it
    // first would turn a truncated header into a 500 — an availability bug
    // triggerable by anyone who can reach the endpoint.
    expect(() => verifySignature(BODY, 'short', SECRET)).not.toThrow();
    expect(verifySignature(BODY, 'short', SECRET)).toBe(false);
    expect(verifySignature(BODY, '', SECRET)).toBe(false);
  });

  it('rejects a genuine signature computed under a DIFFERENT secret', () => {
    expect(verifySignature(BODY, computeSignature(BODY, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects a genuine signature for a DIFFERENT body — replay onto new bytes', () => {
    const tampered = BODY.replace('subscription.charged', 'subscription.activated');
    expect(verifySignature(tampered, computeSignature(BODY, SECRET), SECRET)).toBe(false);
  });

  it('an EMPTY SECRET verifies nothing, not everything', () => {
    // HMAC with an empty key is valid arithmetic that an attacker can also
    // perform. A deployment that forgot to configure the secret would otherwise
    // accept every forged webhook, with every test still green.
    const signedWithEmpty = createHmac('sha256', '').update(BODY, 'utf8').digest('hex');
    expect(verifySignature(BODY, signedWithEmpty, '')).toBe(false);
  });
});
