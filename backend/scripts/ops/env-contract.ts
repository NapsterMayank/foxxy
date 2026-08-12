/**
 * THE PRODUCTION ENVIRONMENT CONTRACT — the variables without which the
 * composition root refuses to construct, in one place, with the reason each one
 * is fatal rather than merely absent.
 *
 * =============================================================================
 * WHY THIS FILE IS A LIST AT ALL, GIVEN D-075.
 *
 * D-075 is "never hardcode what can be discovered", and it has been evaded three
 * separate ways in this repository. This list looks like a fourth. It is not,
 * and the distinction is worth being precise about, because getting it wrong in
 * either direction is expensive.
 *
 * The AUTHORITY on which variables are required in production is
 * `src/app/container.ts` — it is the code that throws. That authority lives in
 * TypeScript source, which is NOT present in the runtime image: the Dockerfile
 * copies `dist/` and `dist-ops/` and deliberately leaves `src/` behind. So a
 * pre-flight that runs inside the production container cannot read the
 * authority. It can only carry a copy.
 *
 * A copy that can drift silently is the defect. A copy whose drift FAILS THE
 * BUILD is a cache. So:
 *
 *   - this list is the copy, used at runtime by `preflight-env.ts`
 *   - `env-contract-check.ts` parses container.ts and config.schema.ts in CI,
 *     where the source does exist, and fails if this list, compose.prod.yml,
 *     docker/.env.prod.example or backend/.env.example has fallen behind it
 *
 * The drift window is therefore one CI run, not one production incident. When
 * the SMTP boot refusal lands under `src/platform/mail`, the check turns red on
 * the merge that adds it — naming the variable — rather than at 3am on the
 * deploy that ships it.
 *
 * DO NOT add a variable here without also adding it to `docker/compose.prod.yml`
 * and both `.env.example` files. The check will tell you if you forget; it is
 * cheaper to remember.
 */

export interface RequiredVar {
  /** The environment variable name, exactly as `container.ts` names it. */
  readonly name: string;
  /**
   * What goes wrong when it is absent — the DEGRADED BEHAVIOUR, not the words
   * "it is required". Every entry below shares one property: the failure has no
   * symptom. That is why each is a boot refusal instead of a warning.
   */
  readonly why: string;
}

export const PRODUCTION_REQUIRED: readonly RequiredVar[] = Object.freeze([
  Object.freeze({
    name: 'VOYAGE_API_KEY',
    why:
      'the deterministic embedding fake is used instead, and every query embeds into a vector ' +
      'space unrelated to the corpus — retrieval returns confident, wrong chunks with no error, ' +
      'no timeout and no metric (container.ts, the `embed` adapter choice)',
  }),
  Object.freeze({
    name: 'LLM_API_KEY',
    why:
      'the scripted fake is used instead, and every student receives the same canned sentence — ' +
      'streamed, cited, and indistinguishable from a working tutor (container.ts, the `llm` ' +
      'adapter choice)',
  }),
  Object.freeze({
    name: 'RAZORPAY_KEY_ID',
    why:
      'the payments fake is used instead, and it happily creates subscriptions and happily ' +
      'verifies webhooks signed with a secret we chose — entitlements granted against payments ' +
      'that never happened (container.ts, the `payments` adapter choice)',
  }),
  Object.freeze({
    name: 'RAZORPAY_KEY_SECRET',
    why: 'same as RAZORPAY_KEY_ID — all three credentials are required together',
  }),
  Object.freeze({
    name: 'RAZORPAY_WEBHOOK_SECRET',
    why:
      'same as RAZORPAY_KEY_ID, and it is a DIFFERENT secret from RAZORPAY_KEY_SECRET, set per ' +
      'endpoint in the Razorpay dashboard. Supplying the API secret in its place fails every ' +
      'genuine webhook signature check while checkout keeps working',
  }),
  /**
   * NOT one of container.ts's boot refusals, and included here anyway.
   *
   * container.ts argues, correctly, that the plan map is excluded because an
   * empty map is a LOUD failure — `createSubscription` refuses a code it cannot
   * resolve — whereas missing credentials are a SILENT fallback, and only the
   * silent one needs a boot gate.
   *
   * The gap that reasoning leaves is WHO the failure is loud to. `{}` is loud
   * to the first customer who reaches checkout, in a paid funnel, on a
   * deployment that has been reporting itself healthy since it started. Moving
   * it to boot costs nothing and changes the audience from a customer to an
   * operator (D-253).
   */
  Object.freeze({
    name: 'RAZORPAY_PLAN_IDS',
    why:
      'the plan map resolves to {} and every checkout fails on a plan code it cannot map — a ' +
      'failure that is loud to a paying customer and silent to us until they tell us',
  }),
  /**
   * THE SMTP CREDENTIALS — D-226, D-254.
   *
   * Four entries rather than one, because the pre-flight's job is to name the
   * variable an operator has to go and set, and "SMTP is misconfigured" is not
   * a name. `SMTP_PORT` is absent from this list on purpose: it has a schema
   * default of 587 that is correct for every STARTTLS provider including
   * Google Workspace, so an unset value is a decision rather than an omission.
   *
   * These are enforced HERE before `container.ts` grows its own refusal for
   * them, and that ordering is deliberate rather than a race: the pre-flight is
   * a separate container that exits non-zero and blocks api, worker and alerts
   * via `service_completed_successfully`, so the stack already refuses to start
   * without them. When the composition-root refusal lands it will phrase itself
   * as "`SMTP_HOST` is required in production", `env-contract-check.ts` will
   * extract it, find it already present here, and pass — the two converge
   * instead of colliding.
   */
  Object.freeze({
    name: 'SMTP_HOST',
    why:
      'the console mail adapter is used instead: verification links and password-reset links are ' +
      'PRINTED TO STDOUT, `mail.send` resolves, the breaker never opens and every probe stays ' +
      'green while the entire signup funnel is dead. It is also the transport every page-severity ' +
      'alert rides on, so the monitoring goes silent with it (platform/mail/smtp-mail.ts)',
  }),
  Object.freeze({
    name: 'SMTP_USER',
    why: 'same as SMTP_HOST — the account the app authenticates to the relay as',
  }),
  Object.freeze({
    name: 'SMTP_PASSWORD',
    why:
      'same as SMTP_HOST. For Google Workspace this is an APP PASSWORD, not the account ' +
      'password; the account password fails authentication on every send',
  }),
  Object.freeze({
    name: 'SMTP_FROM',
    why:
      'same as SMTP_HOST. A SEPARATE variable from SMTP_USER because Workspace allows sending as ' +
      'an alias, and the envelope sender and the visible From are not the same thing to a ' +
      'receiving spam filter',
  }),
]);

/**
 * Variables that are optional by design and passed through anyway.
 *
 * Listed so `env-contract-check.ts` can tell "deliberately optional" apart from
 * "forgotten", and so that a reader of compose.prod.yml can see that the absence
 * of `:?` on them was a decision.
 */
export const PRODUCTION_OPTIONAL: readonly string[] = Object.freeze([
  'LLM_MODEL',
  'LLM_BASE_URL',
]);
