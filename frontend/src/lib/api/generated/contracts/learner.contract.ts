/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

import { z } from 'zod';
import { isGrade, isLanguageCode, type Grade, type LanguageCode } from '../constants/curriculum';

/**
 * The learner wire contract — every request and response shape for the learner
 * module, defined once.
 *
 * 00-ARCHITECTURE.md §1: the frontend imports the INFERRED TYPES from here.
 * Never hand-write a type on the frontend that the backend already defines.
 */

/**
 * ===========================================================================
 * GRADE. READ THIS BEFORE CHANGING OR REMOVING `gradeSchema`.
 *
 * Plan §8.2 requires that "grade 6 as a NUMBER is rejected". THIS SCHEMA IS
 * THE ONLY THING IN THE ENTIRE SYSTEM THAT CAN ENFORCE THAT. It is not a
 * convenience wrapper in front of a database constraint that would catch the
 * same mistake — the database provably cannot catch it.
 *
 * The finding, measured and asserted in
 * `tests/integration/learner-content-migration.test.ts` (D-038): the `grade`
 * column is `text` with a CHECK on '6'..'12', and
 *
 *     insert into students (..., grade) values (..., 6)
 *
 * SUCCEEDS, storing '6'. Postgres has an assignment cast from integer to text
 * and applies it silently, so by the time the CHECK runs the value is already
 * a legal string. node-postgres arrives at the same place by another road,
 * sending a JavaScript `6` as an untyped parameter that Postgres infers as
 * text.
 *
 * So the database owns the VALUE domain — '5', '13', '05', '6 ' and 'Class 6'
 * are all refused, on every write path, forever — and this schema owns the
 * TYPE. Delete it and JSON numbers start reaching the column, where they are
 * silently converted and never seen again. The failure that follows is not a
 * crash: `"6" !== 6` in any downstream comparison makes a filter match
 * nothing, so it surfaces as an empty question list for one cohort and reads
 * as missing content rather than as a bug.
 *
 * `z.string()` is the load-bearing part — it is what rejects the number. The
 * `.refine` narrows the value domain to match the CHECK. A `z.enum` would do
 * both, but it needs the grade list written out a second time as a mutable
 * tuple, and a second copy of a closed set is a copy that drifts from the
 * constraint enforcing it (D-037).
 * ===========================================================================
 */
export const gradeSchema: z.ZodType<Grade, z.ZodTypeDef, unknown> = z
  .string({ invalid_type_error: 'Grade must be a string, for example "8" — never the number 8.' })
  .refine(isGrade, { message: 'Grade must be one of "6" to "12".' });

/** Same shape, same reason: the language code is a string, never an index. */
export const languageSchema: z.ZodType<LanguageCode, z.ZodTypeDef, unknown> = z
  .string({ invalid_type_error: 'Language must be a string, "en" or "hi".' })
  .refine(isLanguageCode, { message: 'Language must be "en" or "hi".' });

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(80, 'Use at most 80 characters.');

/**
 * A subject code. Deliberately open text rather than an enum: the CBSE subject
 * set differs by grade and stream and is expected to grow, and a new subject
 * must not require a migration AND a contract change AND a deploy.
 */
export const subjectCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'A subject code cannot be empty.')
  .max(40, 'A subject code is at most 40 characters.');

export const boardSchema = z.string().trim().min(1).max(40);

/**
 * Mastery, 0..1 inclusive.
 *
 * The schema REFUSES an out-of-range value rather than silently clamping it. A
 * caller sending 1.4 has a bug, and clamping at the boundary would hide it
 * while writing a plausible-looking 1.0. The clamp in `domain/mastery.ts`
 * exists for a different case: values COMPUTED inside the system, where
 * floating-point arithmetic can land a hair outside the range.
 */
export const masteryScoreSchema = z
  .number({ invalid_type_error: 'Mastery must be a number between 0 and 1.' })
  .min(0, 'Mastery cannot be below 0.')
  .max(1, 'Mastery cannot be above 1.');

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const studentProfileSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  /** A STRING. See the block comment above. */
  grade: z.string(),
  board: z.string(),
  preferredLanguage: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type StudentProfile = z.infer<typeof studentProfileSchema>;

export const profileResponseSchema = z.object({ profile: studentProfileSchema });
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

/**
 * A PATCH: every field optional, but at least one present.
 *
 * The "at least one" rule is not pedantry. An empty body would otherwise be a
 * successful update that changed nothing, and the caller — a form that failed
 * to serialise its state — would be told everything went fine.
 *
 * `board` is absent on purpose. It is chosen at onboarding and changing it
 * re-points the entire curriculum a student sees; that is a migration, not a
 * profile edit.
 */
export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    grade: gradeSchema.optional(),
    preferredLanguage: languageSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Provide at least one field to update.',
  );
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * Onboarding — profile and subjects in one call, and IDEMPOTENT.
 *
 * Idempotence is a product requirement, not an implementation detail. This is
 * the first screen after email verification, on Indian mobile networks, and a
 * retried POST is normal: the user taps twice, the connection drops after the
 * write but before the response, the app resumes from a cold start. A second
 * call must not create a duplicate and — much more importantly — must not
 * RESET anything the student has since earned.
 */
export const onboardingRequestSchema = z.object({
  displayName: displayNameSchema,
  grade: gradeSchema,
  preferredLanguage: languageSchema.optional(),
  board: boardSchema.optional(),
  subjects: z
    .array(subjectCodeSchema)
    .min(1, 'Choose at least one subject.')
    .max(20, 'Choose at most 20 subjects.'),
});
export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;

export const onboardingResponseSchema = z.object({
  profile: studentProfileSchema,
  subjects: z.array(z.string()),
  /**
   * `false` when the profile already existed and this call changed nothing.
   *
   * Surfaced rather than hidden so the client can tell "you are now set up"
   * from "you were already set up" without guessing — and so a test can prove
   * the second call was genuinely a no-op.
   */
  created: z.boolean(),
});
export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;

export const subjectsResponseSchema = z.object({ subjects: z.array(z.string()) });
export type SubjectsResponse = z.infer<typeof subjectsResponseSchema>;

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

export const chapterMasterySchema = z.object({
  chapterId: z.string().uuid(),
  masteryScore: z.number(),
  attempts: z.number().int(),
  lastPractisedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type ChapterMastery = z.infer<typeof chapterMasterySchema>;

export const masteryResponseSchema = z.object({ mastery: z.array(chapterMasterySchema) });
export type MasteryResponse = z.infer<typeof masteryResponseSchema>;
