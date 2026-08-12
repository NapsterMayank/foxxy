import type { ZodError, ZodIssue } from 'zod';

/**
 * ===========================================================================
 * ZOD ISSUES → ONE ISSUE PER FIELD.
 *
 * Plan §5.6 requires a 400 to "map onto the form, never a page-level error".
 * THE BACKEND CANNOT SUPPLY THAT MAPPING. Its wire envelope is
 * `{ error: { code, message } }` and nothing else — `AppError.details` exists
 * but `toClientPayload()` deliberately drops it, so a validation failure
 * arrives as one prose sentence with no field attached to it.
 *
 * So the field errors come from validating with the GENERATED REQUEST SCHEMA
 * before the request goes out. That is not a workaround: the schema is the
 * backend's own, copied by `contracts:sync` and drift-tested, so the rules are
 * identical by construction rather than by discipline. A 400 that survives it
 * means the client and the server disagree — a defect, not a typo — and the
 * screens render that as a form-level message.
 *
 * ---------------------------------------------------------------------------
 * ONE ISSUE PER FIELD, AND IT IS THE FIRST.
 *
 * A field can fail several rules at once — an empty password is both too short
 * and not a password — and showing every message turns a form into a wall.
 * `FormField` takes a single `error` string for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE ISSUE IS RETURNED, NOT ITS MESSAGE.
 *
 * `issue.message` is the ENGLISH sentence written in the backend's contract
 * ("Use at least 10 characters."). Rendering it would put untranslated English
 * in front of a Hindi-speaking child, and the user-facing-string lint rule
 * cannot see it because it arrives in a variable. Callers map `(field, issue)`
 * onto a dictionary key instead.
 * ===========================================================================
 */

export type FieldIssues = Readonly<Record<string, ZodIssue>>;

/**
 * Keyed by the FIRST path segment, so a nested failure still lands on the
 * control the person can actually see. A form has one input named `subjects`,
 * not one named `subjects.2`.
 *
 * An issue with an empty path — a `.refine` on the object as a whole, such as
 * "provide at least one field" — is dropped here on purpose. It belongs to no
 * control, and attaching it to an arbitrary one would point at a field that is
 * not the problem. Callers check `error.issues` themselves for those.
 */
export function fieldIssues(error: ZodError): FieldIssues {
  const issues: Record<string, ZodIssue> = {};

  for (const issue of error.issues) {
    const [field] = issue.path;
    if (typeof field !== 'string') continue;
    if (field in issues) continue;
    issues[field] = issue;
  }

  return issues;
}

/** True when the error carries at least one issue no control can display. */
export function hasFormLevelIssue(error: ZodError): boolean {
  return error.issues.some((issue) => issue.path.length === 0);
}
