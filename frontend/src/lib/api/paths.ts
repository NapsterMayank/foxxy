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
