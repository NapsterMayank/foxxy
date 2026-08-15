/**
 * Every endpoint path the product calls, below the version prefix.
 *
 * ===========================================================================
 * WHY THESE ARE CONSTANTS AND NOT STRINGS AT THE CALL SITE.
 *
 * One of them is LOAD-BEARING IN TWO PLACES AT ONCE. `POST /auth/login` is
 * called by the auth feature and is also the single exception in
 * `providers.tsx`'s 401 handler — a 401 from it is a credential verdict about
 * a session that never existed, and every other 401 in the product is a
 * session that has ended. Those two files must agree on the string forever;
 * a literal in each is a rename away from a wrong-password message that clears
 * the query cache and reports itself as an expired session.
 *
 * `providers.tsx` is app-level infrastructure and must not import a feature to
 * learn a path, so the constant lives here, where both sides may reach it.
 * ===========================================================================
 */

export const authPaths = {
  signup: '/auth/signup',
  login: '/auth/login',
  logout: '/auth/logout',
  me: '/auth/me',
  verify: '/auth/verify',
  resendVerification: '/auth/resend-verification',
  forgotPassword: '/auth/forgot-password',
  resetPassword: '/auth/reset-password',
} as const;

export const learnerPaths = {
  onboarding: '/me/onboarding',
  profile: '/me/profile',
} as const;

export const linkPaths = {
  submit: '/links/submit',
} as const;

/**
 * Foxy — build-order step 9.
 *
 * `messages` IS NOT CALLED BY `apiRequest`. It is the SSE endpoint and the
 * streaming client reads its body rather than parsing one, so it builds its own
 * URL from `apiBaseUrl`. It is listed here anyway because the deployment proxy
 * matches on this path (open item 24, D-142) and a path that only exists inside
 * a template literal in one hook is a path nobody finds when narrowing that
 * matcher.
 */
/**
 * Billing — build-order step 13.
 *
 * NO WEBHOOK PATH HERE. `/webhooks/billing` is server-to-server and the browser
 * must never call it; listing it beside the routes this client uses would be an
 * invitation. Its path also carries a security property the backend documents
 * at length — the CSRF origin check exempts `^/api/v\d+/webhooks/` and nothing
 * wider — which belongs with the route, not with a client.
 */
export const billingPaths = {
  plans: '/billing/plans',
  status: '/billing/status',
  subscribe: '/billing/subscribe',
  cancel: '/billing/cancel',
} as const;

/**
 * Parent — build-order step 12.
 *
 * `consentRevoke` IS A POST AND NOT A DELETE, and the route says why: the link
 * row is not deleted, it moves to `revoked`, and the record that access once
 * existed is part of what a consent trail is for. A `DELETE` here would be a
 * client asserting an erasure the server deliberately does not perform.
 */
export const parentPaths = {
  children: '/parent/children',
  snapshot: (childId: string) => `/parent/children/${encodeURIComponent(childId)}/snapshot`,
  digest: (childId: string) => `/parent/children/${encodeURIComponent(childId)}/digest`,
  transcript: (childId: string) => `/parent/children/${encodeURIComponent(childId)}/transcript`,
  consent: (childId: string) => `/parent/children/${encodeURIComponent(childId)}/consent`,
  consentRevoke: (childId: string) =>
    `/parent/children/${encodeURIComponent(childId)}/consent/revoke`,
} as const;

/**
 * Practice — build-order step 10.
 *
 * SEVEN ROUTES AND NO HINT ROUTE. `practice.contract.ts` defines
 * `hintQuerySchema` and `hintResponseSchema`, and `practice.routes.ts` registers
 * nothing that serves them — the hint ladder is contracted and unrouted. It is
 * also unpopulated (`hint_level_1..3` are NULL on all 3,791 source questions,
 * open item 13), so a hint affordance today would be a button that 404s to
 * fetch content that does not exist. Recorded rather than stubbed.
 */
export const practicePaths = {
  mission: '/practice/mission',
  sessions: '/practice/sessions',
  session: (sessionId: string) => `/practice/sessions/${encodeURIComponent(sessionId)}`,
  answers: (sessionId: string) => `/practice/sessions/${encodeURIComponent(sessionId)}/answers`,
  submit: (sessionId: string) => `/practice/sessions/${encodeURIComponent(sessionId)}/submit`,
  history: '/practice/history',
  progress: '/practice/progress',
} as const;

export const foxyPaths = {
  sessions: '/foxy/sessions',
  session: (sessionId: string) => `/foxy/sessions/${encodeURIComponent(sessionId)}`,
  messages: (sessionId: string) => `/foxy/sessions/${encodeURIComponent(sessionId)}/messages`,
  capabilities: '/foxy/capabilities',
} as const;
