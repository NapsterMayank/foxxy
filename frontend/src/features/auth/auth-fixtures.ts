export type AccountRole = 'student' | 'parent';

/**
 * The role the SHELL is dressed as, read from `?role=`.
 *
 * Presentation only — it picks the heading and the illustration. The role that
 * matters is the one on the account, and it comes from the signup body or from
 * `GET /auth/me`, never from a query string anyone can edit.
 *
 * `parsePreviewState` used to live here. It drove a `?preview=` switch that
 * painted fake loading, error and rate-limited states while the screens called
 * nothing; the states are real now and come from the mutation, so a query
 * parameter that fakes them is a way to show a person an error that did not
 * happen.
 */
export function parseAccountRole(value: string | string[] | undefined): AccountRole {
  return value === 'parent' ? 'parent' : 'student';
}
