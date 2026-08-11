/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

export const ERROR_CODES = {
  VALIDATION: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT: 'RATE_LIMIT_EXCEEDED',
  DEPENDENCY: 'DEPENDENCY_FAILURE',
  INTERNAL: 'INTERNAL_ERROR',
} as const;

/**
 * Every code the API can return. `5.6`'s treatment table switches over this,
 * so a code the backend adds and the frontend does not handle is a TYPE ERROR
 * rather than a screen that renders nothing.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
