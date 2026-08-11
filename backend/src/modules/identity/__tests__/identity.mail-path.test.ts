import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DependencyError } from '@/platform/errors/index';
import type { MailMessage, MailPort } from '@/platform/mail/index';
import {
  MAIL_DEFERRED_METRIC,
  MAIL_FAILED_METRIC,
  type IdentityService,
} from '../identity.service';
import type { RequestContext } from '../identity.types';
import { startIdentityHarness, type IdentityHarness } from './harness';

/**
 * =============================================================================
 * MAIL IS NOT ON THE REQUEST PATH — D-217 and D-218.
 *
 * Two defects with one shape, and this file is the proof for both. Neither was
 * visible to the existing suite, for the same reason in both cases: the harness
 * substitutes `RecordingMail`, whose `send` never fails and returns in
 * microseconds. Against that fake, a bare awaited send and a deferred one are
 * indistinguishable — the outage branch never ran and the latency term was
 * zero. Every test in the module passed over both defects.
 *
 * So this file supplies the fake that CAN see them:
 *
 *   `LatentMail.failWith`  makes the provider fail, which is D-217 — a provider
 *                          blip used to 500 the signup AFTER committing the
 *                          user row, taking the address hostage.
 *   `LatentMail.delayMs`   models the SMTP round trip, which is D-218 — the
 *                          send used to be the dominant term in the response
 *                          time of exactly one branch of `requestPasswordReset`
 *                          and of exactly one branch of `signup`, which is an
 *                          account-existence oracle measurable from anywhere.
 *
 * NO TEST HERE SLEEPS. The delay lives inside the port, where it models a real
 * dependency; the tests await work, never the clock.
 * =============================================================================
 */

/**
 * A mail port that can be slow, can fail, and can be waited on.
 *
 * `drain` is what makes the deferred-failure assertions deterministic without a
 * timer: `deferMail` attaches its handler to the promise `send` returned, so a
 * test that awaits the SAME promise is queued behind that handler and observes
 * the metric it emitted.
 */
class LatentMail implements MailPort {
  /** Every message handed to `send`, in order, whatever the outcome. */
  readonly sent: MailMessage[] = [];
  /** Milliseconds the "SMTP round trip" takes. */
  delayMs = 0;
  /** What the provider does: succeed, fail transiently, or fail as a bug. */
  failWith: 'none' | 'dependency' | 'programming' = 'none';

  private inFlight: Promise<unknown>[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    const outcome = new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        if (this.failWith === 'dependency') {
          reject(new DependencyError('smtp', { message: 'provider refused the connection' }));
          return;
        }
        if (this.failWith === 'programming') {
          reject(new TypeError('template data is not an object'));
          return;
        }
        resolve();
      };
      if (this.delayMs === 0) {
        settle();
        return;
      }
      setTimeout(settle, this.delayMs);
    });
    this.inFlight.push(outcome.catch(() => undefined));
    return outcome;
  }

  /** Settles every send issued so far, then flushes the deferral handlers. */
  async drain(): Promise<void> {
    const pending = this.inFlight;
    this.inFlight = [];
    await Promise.all(pending);
    // One extra microtask turn: `deferMail`'s handler is attached to the same
    // promise and runs before this continuation, but its own body awaits
    // nothing, so a single turn is enough and is deterministic.
    await Promise.resolve();
  }

  reset(): void {
    this.sent.length = 0;
    this.inFlight = [];
    this.delayMs = 0;
    this.failWith = 'none';
  }
}

const GOOD_PASSWORD = 'vermillion-otter-49';
const ALLOWED_ORIGIN = 'http://app.test';

/**
 * The modelled SMTP round trip. Large enough to dominate every other term in
 * these two endpoints (a couple of indexed statements against a local Postgres)
 * and small enough that the file stays fast.
 */
const MAIL_LATENCY_MS = 150;

let harness: IdentityHarness;
let service: IdentityService;
const mail = new LatentMail();

beforeAll(async () => {
  harness = await startIdentityHarness({ mail });
  service = harness.identity.service;
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

beforeEach(async () => {
  await harness.reset();
  mail.reset();
});

function contextFor(label: string): RequestContext {
  return { ipHash: `mail-path-${label}`, userAgent: 'vitest' };
}

async function countRows(table: string): Promise<number> {
  const result = await harness.postgres.client.query<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Median rather than mean: one scheduler hiccup must not move the result. */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

// ---------------------------------------------------------------------------

describe('D-217: a mail outage degrades to "verification queued", never to a failed signup', () => {
  /**
   * THE defect test.
   *
   * Re-applying the defect — `await mail.send(...)` in place of the
   * `deferMail(...)` call in `signup` — turns this red with a 502 escaping a
   * method whose user row is already committed.
   */
  it('SIGNUP STILL SUCCEEDS WHEN THE PROVIDER IS DOWN, and the token is persisted', async () => {
    mail.failWith = 'dependency';

    await expect(
      service.signup(
        { email: 'outage@example.test', password: GOOD_PASSWORD, role: 'student' },
        contextFor('outage'),
      ),
    ).resolves.toBeUndefined();

    // The account exists AND the token that recovers it exists. Either one
    // alone would be the trap: a user row with no token is an address taken
    // hostage, which is the outcome the defect produced.
    expect(await countRows('users')).toBe(1);
    expect(await countRows('email_verification_tokens')).toBe(1);
  });

  it('returns the identical 201 body it returns when mail is healthy', async () => {
    const healthy = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/signup',
      payload: { email: 'healthy@example.test', password: GOOD_PASSWORD, role: 'student' },
    });

    mail.failWith = 'dependency';
    const degraded = await harness.app.inject({
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
      url: '/api/v1/auth/signup',
      payload: { email: 'degraded@example.test', password: GOOD_PASSWORD, role: 'student' },
    });

    expect(healthy.statusCode).toBe(201);
    expect(degraded.statusCode).toBe(201);
    expect(degraded.body).toBe(healthy.body);
  });

  it('emits the deferral metric, so a silent outage is not silent', async () => {
    mail.failWith = 'dependency';

    await service.signup(
      { email: 'metric@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('metric'),
    );
    await mail.drain();

    expect(harness.metrics.countOf(MAIL_DEFERRED_METRIC)).toBe(1);
    expect(harness.metrics.countOf(MAIL_FAILED_METRIC)).toBe(0);
    expect(
      harness.metrics.emitted.find((entry) => entry.metric === MAIL_DEFERRED_METRIC)?.tags,
    ).toEqual({ template: 'email-verification' });
  });

  /**
   * The separation of the two metrics is the point, and it is a rule the fix
   * had to get right rather than a nicety: "the provider is down" and "we built
   * a message the mailer cannot accept" are different pages in a runbook, and
   * folding the second into the first hides a permanent bug inside a
   * transient-failure dashboard.
   */
  it('does NOT fold a programming error into the outage metric', async () => {
    mail.failWith = 'programming';

    await service.signup(
      { email: 'bug@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('bug'),
    );
    await mail.drain();

    expect(harness.metrics.countOf(MAIL_FAILED_METRIC)).toBe(1);
    expect(harness.metrics.countOf(MAIL_DEFERRED_METRIC)).toBe(0);
  });

  it('never logs the recipient or the verification token when a send fails', async () => {
    mail.failWith = 'dependency';
    await service.signup(
      { email: 'quiet@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('quiet'),
    );
    await mail.drain();

    const verifyUrl = mail.sent.at(-1)?.data.verifyUrl ?? '';
    const token = new URL(verifyUrl).searchParams.get('token') ?? '';
    const logged = JSON.stringify(harness.logger.lines);

    expect(token.length).toBeGreaterThan(0);
    expect(logged).not.toContain('quiet@example.test');
    expect(logged).not.toContain(token);
  });

  it('keeps the duplicate-address notice off the critical path too', async () => {
    await service.signup(
      { email: 'dup@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('dup-first'),
    );

    // The SECOND signup takes the existing-address branch, whose only outbound
    // effect is the notice to the account's owner. A failing notice must not
    // turn the enumeration defence into a 502 that says "this address exists".
    mail.failWith = 'dependency';
    await expect(
      service.signup(
        { email: 'dup@example.test', password: GOOD_PASSWORD, role: 'student' },
        contextFor('dup-second'),
      ),
    ).resolves.toBeUndefined();
    await mail.drain();

    expect(await countRows('users')).toBe(1);
    expect(harness.metrics.countOf(MAIL_DEFERRED_METRIC)).toBe(1);
  });

  it('RESET REQUESTS SURVIVE THE SAME OUTAGE, with the reset token persisted', async () => {
    await service.signup(
      { email: 'reset@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('reset-signup'),
    );

    mail.failWith = 'dependency';
    await expect(
      service.requestPasswordReset({ email: 'reset@example.test' }, contextFor('reset-request')),
    ).resolves.toBeUndefined();
    await mail.drain();

    expect(await countRows('password_reset_tokens')).toBe(1);
    expect(harness.metrics.countOf(MAIL_DEFERRED_METRIC)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('D-218: neither forgot-password nor signup is a latency oracle', () => {
  const SAMPLES = 7;

  /**
   * THE NOISE ANCHOR, and it is why these ratios are stable where a raw one is
   * not.
   *
   * `login`'s timing test can divide two medians directly because both of its
   * branches perform an Argon2id verification: the signal is tens of
   * milliseconds and the noise is a rounding error. Here BOTH branches are a
   * couple of local statements — hundreds of MICROseconds — so a raw ratio
   * divides noise by noise. Measured on the fixed code it swings between 1 and
   * 12 depending on what the machine was doing, which would be a test that goes
   * red for reasons unrelated to the property and gets ignored within a week.
   *
   * Adding a floor to both medians before dividing bounds the estimator by the
   * resolution of the measurement instead of by the smaller sample. It costs
   * nothing in sensitivity for the thing being detected: the defect puts
   * `MAIL_LATENCY_MS` on ONE branch, and 155/6 is still enormous.
   *
   * -------------------------------------------------------------------------
   * WHY THE FLOOR IS 5 AND NOT 1.
   *
   * At 1 ms this was the only assertion in the file that failed under a FULL
   * suite run while passing every time in isolation — observed at 12.48 against
   * a bound of 10, with both ABSOLUTE assertions (the load-bearing ones) green
   * by two orders of magnitude on the same run. That is the anchor failing to
   * anchor, not the property failing to hold: `vitest run` puts several
   * Postgres containers and every other suite on the same machine, and the
   * signup case's stated residual — two INSERTs against one that fails on a
   * unique index — is about six milliseconds there. A 1 ms floor against a 6 ms
   * residual leaves the ratio being set by whichever branch happened to be
   * sub-millisecond, which is precisely the "divides noise by noise" failure
   * this constant was introduced to prevent. It was under-sized for the case it
   * had to cover.
   *
   * THIS IS NOT A LOOSENED BOUND, and `rejects a defect-sized asymmetry` below
   * is what makes that checkable rather than assertable: at a 5 ms floor the
   * defect still clears both ratio bounds by 3-5x. The absolute assertions,
   * which are the ones the header calls load-bearing, are untouched.
   * -------------------------------------------------------------------------
   */
  const NOISE_FLOOR_MS = 5;

  /** The median ratio, anchored. See `NOISE_FLOOR_MS`. */
  function anchoredRatio(left: number, right: number): number {
    const high = Math.max(left, right) + NOISE_FLOOR_MS;
    const low = Math.min(left, right) + NOISE_FLOOR_MS;
    return high / low;
  }

  /**
   * THE ANCHOR'S OWN GUARD — the assertion that keeps `NOISE_FLOOR_MS` honest.
   *
   * Raising a noise floor to stop a flake is one edit away from raising it
   * until nothing can fail, and the two edits look identical in a diff. So the
   * estimator is exercised directly, against the shape the DEFECT produces:
   * `MAIL_LATENCY_MS` awaited on one branch and not the other, on top of the
   * residual each case already has. Both bounds in this file — 5 for forgot, 10
   * for signup — must still reject it, with room to spare.
   *
   * Pure arithmetic, no clock, no sleep: it asks whether the instrument can
   * still see the thing, not how fast this machine is today.
   */
  it('rejects a defect-sized asymmetry at the floor it is configured with', () => {
    // forgot: both branches are a couple of local statements (~1 ms); the
    // defect adds the synchronous send to the KNOWN branch alone.
    expect(anchoredRatio(1 + MAIL_LATENCY_MS, 1)).toBeGreaterThan(5);
    // signup: ~6 ms residual on the fresh branch before the defect is added.
    expect(anchoredRatio(7 + MAIL_LATENCY_MS, 1)).toBeGreaterThan(10);

    // …and the residual ALONE, with no defect, stays inside both bounds — the
    // other direction, without which the two lines above could be satisfied by
    // a floor of zero.
    expect(anchoredRatio(2, 1)).toBeLessThan(5);
    expect(anchoredRatio(7, 1)).toBeLessThan(10);
  });

  /**
   * THE defect test for `requestPasswordReset`.
   *
   * The two response BODIES are byte-identical — `identity.security.test.ts`
   * asserts that — and the TIMING was not: an unknown address returned after one
   * indexed SELECT, a known one after a token INSERT and a synchronous SMTP
   * round trip. That is the enumeration answer the identical body exists to
   * withhold, delivered by the clock.
   *
   * THE ABSOLUTE DELTA IS THE LOAD-BEARING ASSERTION and the ratio is the
   * secondary one, deliberately in that order. Both branches now cost a couple
   * of local statements, so their medians are small numbers whose RATIO is
   * noisy by construction — a 0.8 ms branch against a 1.9 ms branch is a ratio
   * of 2.4 and means nothing. What must be true is that neither branch carries
   * the SEND, and the send is `MAIL_LATENCY_MS`; a delta far below that is the
   * statement that it is gone.
   *
   * Re-applying the defect — `await mail.send(...)` in place of `deferMail(...)`
   * in `requestPasswordReset` — puts 150 ms on the known branch alone and turns
   * this red on both assertions.
   */
  it('ANSWERS A KNOWN AND AN UNKNOWN ADDRESS IN THE SAME TIME', async () => {
    // One account per sample: `forgot` is limited 3/hour per EMAIL as well as
    // per IP, so reusing one address would measure the rate limiter instead.
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await service.signup(
        { email: `known-${sample}@example.test`, password: GOOD_PASSWORD, role: 'student' },
        contextFor(`seed-${sample}`),
      );
    }

    mail.delayMs = MAIL_LATENCY_MS;
    const known: number[] = [];
    const unknown: number[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const context = contextFor(`timing-forgot-${sample}`);

      const startKnown = performance.now();
      await service.requestPasswordReset({ email: `known-${sample}@example.test` }, context);
      known.push(performance.now() - startKnown);

      const startUnknown = performance.now();
      await service.requestPasswordReset({ email: `absent-${sample}@example.test` }, context);
      unknown.push(performance.now() - startUnknown);
    }

    const knownMedian = median(known);
    const unknownMedian = median(unknown);

    // Neither branch may carry the send: the delta must be a small fraction of
    // it, and neither median may approach it.
    expect(Math.abs(knownMedian - unknownMedian)).toBeLessThan(MAIL_LATENCY_MS / 3);
    expect(Math.max(knownMedian, unknownMedian)).toBeLessThan(MAIL_LATENCY_MS / 3);
    expect(anchoredRatio(knownMedian, unknownMedian)).toBeLessThan(5);

    // And the sends did happen — this measures a deferred send, not a missing
    // one. Without this the test would pass just as well against a mailer that
    // was never called.
    await mail.drain();
    expect(mail.sent.filter((message) => message.template === 'password-reset')).toHaveLength(
      SAMPLES,
    );
  }, 120_000);

  /**
   * THE defect test for `signup`, and the asymmetry is the same one: the
   * new-account branch generated a token, INSERTED it and sent the verification
   * mail; the existing-address branch sent a notice. The send dominated both,
   * and under the defect it was awaited, so the two branches were separated by
   * whatever the provider took to accept one message versus the other.
   *
   * Re-applying the defect at the verification-mail call site alone — the
   * original line 369 — turns this red.
   */
  it('ANSWERS A NEW AND AN ALREADY-REGISTERED ADDRESS IN THE SAME TIME', async () => {
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await service.signup(
        { email: `taken-${sample}@example.test`, password: GOOD_PASSWORD, role: 'student' },
        contextFor(`seed-signup-${sample}`),
      );
    }

    mail.delayMs = MAIL_LATENCY_MS;
    const fresh: number[] = [];
    const taken: number[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      // `signup` is limited 3/hour per IP, so every sample gets its own.
      const startFresh = performance.now();
      await service.signup(
        { email: `fresh-${sample}@example.test`, password: GOOD_PASSWORD, role: 'student' },
        contextFor(`timing-fresh-${sample}`),
      );
      fresh.push(performance.now() - startFresh);

      const startTaken = performance.now();
      await service.signup(
        { email: `taken-${sample}@example.test`, password: GOOD_PASSWORD, role: 'student' },
        contextFor(`timing-taken-${sample}`),
      );
      taken.push(performance.now() - startTaken);
    }

    const freshMedian = median(fresh);
    const takenMedian = median(taken);

    /**
     * THE RESIDUAL IS NAMED RATHER THAN HIDDEN. The two branches are not free of
     * each other: the new-account path performs two INSERTs (the user and the
     * verification token) where the taken path performs one INSERT that fails on
     * the unique index. Measured in this harness — a Postgres in a container,
     * which is slower than any production socket — that residual is about six
     * milliseconds, and the anchored ratio sits near 6.
     *
     * Which is why the bound is 10 and not 2. A bound tightened to the number
     * currently measured would be a bound that goes red on a slow CI agent, and
     * a timing test that cries wolf is a timing test that gets deleted. What the
     * bound has to separate is the residual from the DEFECT, and the defect is
     * `MAIL_LATENCY_MS` on one branch alone: it takes the ratio to roughly 75
     * and the delta to 150 ms. Both assertions below have two orders of
     * magnitude of daylight around them.
     */
    expect(Math.abs(freshMedian - takenMedian)).toBeLessThan(MAIL_LATENCY_MS / 3);
    expect(Math.max(freshMedian, takenMedian)).toBeLessThan(MAIL_LATENCY_MS / 3);
    expect(anchoredRatio(freshMedian, takenMedian)).toBeLessThan(10);

    await mail.drain();
    expect(mail.sent.filter((message) => message.template === 'email-verification')).toHaveLength(
      SAMPLES * 2,
    );
  }, 120_000);

  /**
   * THE SAME PROPERTY FOR THE ENDPOINT ADDED BY D-291.
   *
   * A resend endpoint is an enumeration oracle by default: one branch mints a
   * token and mails it, the other does nothing at all. It is built with D-218's
   * shape for that reason — both counters consumed first, the token generated
   * BEFORE the existence branch, and the send deferred — and this is the
   * assertion that the shape survived.
   *
   * Re-applying the defect at the resend call site (`await mail.send(...)` in
   * place of `deferMail(...)` in `resendVerification`) puts `MAIL_LATENCY_MS` on
   * the unverified branch alone and turns this red.
   */
  it('RESEND ANSWERS AN UNVERIFIED AND AN UNKNOWN ADDRESS IN THE SAME TIME', async () => {
    // Each seed gets its own IP: signup is 3/hour per IP.
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await service.signup(
        { email: `pending-${sample}@example.test`, password: GOOD_PASSWORD, role: 'student' },
        contextFor(`seed-resend-${sample}`),
      );
    }

    mail.delayMs = MAIL_LATENCY_MS;
    const pending: number[] = [];
    const unknown: number[] = [];

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      // A fresh IP per sample: the resend is 10/hour per IP AND per address, and
      // a limiter rejection would be the fastest branch of all.
      const context = contextFor(`timing-resend-${sample}`);

      const startPending = performance.now();
      await service.resendVerification({ email: `pending-${sample}@example.test` }, context);
      pending.push(performance.now() - startPending);

      const startUnknown = performance.now();
      await service.resendVerification({ email: `missing-${sample}@example.test` }, context);
      unknown.push(performance.now() - startUnknown);
    }

    const pendingMedian = median(pending);
    const unknownMedian = median(unknown);

    // Neither branch may carry the send. Same bounds and same reasoning as
    // forgot-password above: the residual is one small transaction.
    expect(Math.abs(pendingMedian - unknownMedian)).toBeLessThan(MAIL_LATENCY_MS / 3);
    expect(Math.max(pendingMedian, unknownMedian)).toBeLessThan(MAIL_LATENCY_MS / 3);
    expect(anchoredRatio(pendingMedian, unknownMedian)).toBeLessThan(10);

    // And the sends really happened — this measures a deferred send, not a
    // missing one.
    await mail.drain();
    expect(mail.sent.filter((message) => message.template === 'email-verification')).toHaveLength(
      SAMPLES * 2,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------

/**
 * =============================================================================
 * D-291 — THE RECOVERY PATH D-217 SAID ALREADY EXISTED.
 *
 * D-217's reasoning for a fire-and-forget verification email is quoted in
 * `identity.service.ts` and reads, in as many words: "the RECOVERY PATH ALREADY
 * EXISTS AND DOES NOT DEPEND ON IT — the verification and reset tokens are
 * committed rows, so a resend re-mails the token that is already persisted."
 *
 * There was no resend. Seven `/auth/*` routes — signup, verify, login, logout,
 * logout-all, forgot-password, reset-password — and not one of them re-mailed
 * anything. An auditor confirmed it against a real server with mail down:
 *
 *     MAIL-DOWN signup:  201 {"status":"ok","message":"Check your email…"}
 *     MAIL-DOWN user row created: { n: 1 }
 *     MAIL-DOWN queued jobs: []
 *
 * The account survived the outage exactly as D-217 designed, and was useless:
 * address taken, verification email gone, no way to ask for another, and no way
 * to sign up again. The tests below are the outage-to-recovery journey end to
 * end, in the one file that can make the provider fail.
 * =============================================================================
 */
describe('D-291: a resend rescues the account a mail outage left unverifiable', () => {
  /** Pulls the token out of the most recent verification email. */
  function lastVerifyToken(): string {
    const verifyUrl = mail.sent.at(-1)?.data.verifyUrl ?? '';
    return verifyUrl === '' ? '' : (new URL(verifyUrl).searchParams.get('token') ?? '');
  }

  it('DELIVERS A WORKING TOKEN AFTER A SIGNUP WHOSE EMAIL WAS LOST', async () => {
    // 1. Signup during the outage. The account is created; the email is not.
    mail.failWith = 'dependency';
    await service.signup(
      { email: 'stranded@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('stranded-signup'),
    );
    await mail.drain();

    expect(await countRows('users')).toBe(1);
    // The mailer was CALLED and the send failed, so nothing usable reached the
    // user. This is the state the audit found on a real server.
    expect(harness.metrics.countOf(MAIL_DEFERRED_METRIC)).toBe(1);

    // 2. The provider comes back and the user asks again. Before D-291 there was
    //    no endpoint to ask, and this account stayed unverifiable forever.
    mail.reset();
    await service.resendVerification(
      { email: 'stranded@example.test' },
      contextFor('stranded-resend'),
    );
    await mail.drain();

    const resent = mail.sent.filter((message) => message.template === 'email-verification');
    expect(resent).toHaveLength(1);

    // 3. The token WORKS: it verifies the address and issues a session. A resend
    //    that mailed an unusable link would satisfy every assertion above.
    const result = await service.verifyEmail(lastVerifyToken(), contextFor('stranded-verify'));
    expect(result.user.email).toBe('stranded@example.test');
    expect(result.user.emailVerifiedAt).not.toBeNull();
    expect(result.session.token.length).toBeGreaterThan(0);
  });

  it('RETIRES THE TOKEN IT REPLACES, so an old mailed link stops working', async () => {
    /**
     * The reissue is a REPLACEMENT, not an addition, and it happens in one
     * transaction. A resend that merely inserted a second row would leave every
     * previously mailed link live — so a token sitting in a forwarded message or
     * a mail archive would still verify the account long after the user asked
     * for a new one.
     *
     * This also documents why "reuses the persisted token if it is still valid"
     * cannot be implemented literally: the table stores a SHA-256 OF the token
     * and never the token, so there is nothing in a surviving row to re-mail.
     */
    await service.signup(
      { email: 'replaced@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('replaced-signup'),
    );
    await mail.drain();
    const firstToken = lastVerifyToken();

    await service.resendVerification(
      { email: 'replaced@example.test' },
      contextFor('replaced-resend'),
    );
    await mail.drain();
    const secondToken = lastVerifyToken();

    expect(secondToken).not.toBe(firstToken);
    // Two rows, one live: the retired one is marked consumed, never deleted.
    expect(await countRows('email_verification_tokens')).toBe(2);

    await expect(service.verifyEmail(firstToken, contextFor('replaced-old'))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    await expect(
      service.verifyEmail(secondToken, contextFor('replaced-new')),
    ).resolves.toMatchObject({ user: { email: 'replaced@example.test' } });
  });

  it('SENDS NOTHING for an unknown address and nothing for a verified one', async () => {
    // Both resolve, both silently. The observable difference an attacker would
    // want is whether an email was sent, and neither of these sends one.
    await service.signup(
      { email: 'done@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('done-signup'),
    );
    await mail.drain();
    await service.verifyEmail(lastVerifyToken(), contextFor('done-verify'));
    mail.reset();

    await expect(
      service.resendVerification({ email: 'nobody@example.test' }, contextFor('resend-unknown')),
    ).resolves.toBeUndefined();
    await expect(
      service.resendVerification({ email: 'done@example.test' }, contextFor('resend-verified')),
    ).resolves.toBeUndefined();
    await mail.drain();

    expect(mail.sent).toHaveLength(0);
    // And no token was minted for either — a verified account must not acquire a
    // live verification link it never asked for.
    expect(await countRows('email_verification_tokens')).toBe(1);
  });

  it('SURVIVES THE OUTAGE ITSELF: a failing resend still persists its token', async () => {
    await service.signup(
      { email: 'twice-down@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('twice-signup'),
    );
    await mail.drain();
    harness.metrics.clear();

    mail.failWith = 'dependency';
    await expect(
      service.resendVerification({ email: 'twice-down@example.test' }, contextFor('twice-resend')),
    ).resolves.toBeUndefined();
    await mail.drain();

    // Same contract as signup: a provider outage degrades to "queued", never to
    // a failed request, and the deferral is counted rather than silent.
    expect(harness.metrics.countOf(MAIL_DEFERRED_METRIC)).toBe(1);
    expect(harness.metrics.countOf(MAIL_FAILED_METRIC)).toBe(0);
    expect(await countRows('email_verification_tokens')).toBe(2);
  });

  it('never logs the recipient or the resent token', async () => {
    await service.signup(
      { email: 'quiet-resend@example.test', password: GOOD_PASSWORD, role: 'student' },
      contextFor('quiet-resend-signup'),
    );
    await mail.drain();

    await service.resendVerification(
      { email: 'quiet-resend@example.test' },
      contextFor('quiet-resend'),
    );
    await mail.drain();

    const token = lastVerifyToken();
    const logged = JSON.stringify(harness.logger.lines);
    expect(token.length).toBeGreaterThan(0);
    expect(logged).not.toContain('quiet-resend@example.test');
    expect(logged).not.toContain(token);
  });
});
