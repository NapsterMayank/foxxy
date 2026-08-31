/**
 * Every admin endpoint, in one place.
 *
 * String-building at a call site is how a typo becomes a 404 that reads as
 * "not permitted" on this surface — see the note on `ApiError` in `client.ts`.
 */
export const adminPaths = {
  overview: '/admin/overview',
  signals: '/admin/monitoring/signals',
  rules: '/admin/monitoring/rules',
  dryRun: '/admin/monitoring/dry-run',
  jobs: '/admin/monitoring/jobs',
  workers: '/admin/monitoring/workers',
  metrics: '/admin/monitoring/metrics',
  health: '/admin/monitoring/health',
  users: '/admin/users',
  user: (id: string) => `/admin/users/${encodeURIComponent(id)}`,
  learnerActivity: (id: string) => `/admin/learners/${encodeURIComponent(id)}/activity`,
  practiceSessions: '/admin/practice/sessions',
  foxySessions: '/admin/foxy/sessions',
  foxySession: (id: string) => `/admin/foxy/sessions/${encodeURIComponent(id)}`,
  foxyTrace: (id: string) => `/admin/foxy/traces/${encodeURIComponent(id)}`,
  /** The trace behind one turn — D-403. See the session screen. */
  foxyTraceByMessage: (messageId: string) =>
    `/admin/foxy/messages/${encodeURIComponent(messageId)}/trace`,
  subscriptions: '/admin/billing/subscriptions',
  audit: '/admin/audit',
  contentCoverage: '/admin/content/coverage',
  reveal: '/admin/reveal',
} as const;
