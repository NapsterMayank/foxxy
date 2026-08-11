import { z } from 'zod';
import { PLATFORM_ROLES } from '../constants/roles';

/**
 * The identity wire contract — every request and response shape for the
 * identity module, defined once.
 *
 * 00-ARCHITECTURE.md §1: the frontend imports the INFERRED TYPES from this
 * file. Never hand-write a type on the frontend that the backend already
 * defines. One definition, two consumers.
 *
 * Nothing here may ever describe a session token. The token travels only in an
 * httpOnly cookie; putting it in a body defeats the cookie entirely (§6.4).
 */

/** Roles are fixed at signup. A person who is both holds two accounts. */
export const roleSchema = z.enum(['student', 'parent']);
export type Role = z.infer<typeof roleSchema>;

/**
 * EVERY role the `users.role` COLUMN accepts — ten values, not two — D-293.
 *
 * ===========================================================================
 * THIS IS NOT `roleSchema` AND MUST NEVER BECOME IT.
 *
 * `roleSchema` above is what a SELF-SERVICE SIGNUP accepts, and it is exactly
 * `student` and `parent`. Pointing the signup request at the schema below would
 * compile, insert, and hand the internet a `super_admin` dropdown — the trap
 * `shared/constants/roles.ts` spells out at length and that a test in
 * `tests/integration/identity-audit.test.ts` exists to catch.
 *
 * This one describes what comes OUT of the database. The CHECK constraint on
 * `users.role` is built from `PLATFORM_ROLES` (migration 0005), so a row may
 * legitimately carry any of the ten. Every type that DESCRIBES A ROW must
 * therefore be this wide, or the compiler is being told something the database
 * does not guarantee — see `identity.repository.ts` and the same lesson learned
 * once already in `platform/authz/can-access.ts`, where a `teacher` row
 * arriving as a value the compiler believed impossible would have been treated
 * as a PARENT by an "if student … otherwise parent" branch.
 *
 * Built FROM the constant rather than retyped, so widening the column widens
 * this in the same commit and cannot widen signup at all.
 */
export const platformRoleSchema = z.enum(PLATFORM_ROLES);
export type PlatformRoleValue = z.infer<typeof platformRoleSchema>;

export const linkStatusSchema = z.enum(['pending', 'approved', 'revoked']);
export type LinkStatusValue = z.infer<typeof linkStatusSchema>;

/**
 * Email normalisation happens at the schema boundary — trim and lowercase —
 * so no downstream code has to remember to do it. The `citext` column is the
 * backstop, not the only defence.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address.');

/**
 * Minimum 10 characters, NO character-class rules (§6.2). Length beats
 * complexity, and complexity rules push people towards `Passw0rd!`.
 *
 * The common-password rejection is a domain rule, not a schema rule — it is
 * applied in the service so the message can be specific.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200, 'Use at most 200 characters.');

/** 6 characters from an unambiguous alphabet. Normalised to upper case. */
export const linkCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(6, 'A link code is 6 characters.');

export const opaqueTokenSchema = z.string().trim().min(1).max(512);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema,
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

/**
 * The signup response is CONSTANT.
 *
 * A brand-new signup and a signup on an address that already has an account
 * return byte-identical bodies and the same 201 status. Anything else lets
 * anyone discover which addresses have accounts — a genuine privacy problem on
 * a platform used by children (§6.2, "the enumeration trap").
 */
export const signupResponseSchema = z.object({
  status: z.literal('ok'),
  message: z.string(),
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;

export const verifyQuerySchema = z.object({ token: opaqueTokenSchema });
export type VerifyQuery = z.infer<typeof verifyQuerySchema>;

/**
 * Login does NOT apply the strength schema to the password field.
 *
 * If it did, a password that is merely too short would be rejected with a 400
 * describing the policy before the credentials were ever checked — a different
 * response shape for a different input class, which is exactly the kind of
 * observable difference §6.4 works to remove.
 */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * The authenticated account's own profile. No token, ever.
 *
 * `role` is `platformRoleSchema`, NOT `roleSchema` — D-293. This object
 * describes a row that already exists rather than an input being accepted, and
 * the column holds ten values. Declaring it as the two SIGNUP roles was a claim
 * about the database that the database does not make: the day an operator grants
 * a `teacher`, that account logs in and this field carries `'teacher'` whatever
 * the type says. Widening it changes no byte on the wire today (nothing grants a
 * non-signup role yet) and stops the type from lying the moment something does.
 *
 * Signup is unaffected: `signupRequestSchema` above still uses `roleSchema`.
 */
export const userProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: platformRoleSchema,
  emailVerifiedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const loginResponseSchema = z.object({ user: userProfileSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const okResponseSchema = z.object({ status: z.literal('ok') });
export type OkResponse = z.infer<typeof okResponseSchema>;

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/**
 * THE RECOVERY PATH D-217 ASSUMED AND NOBODY BUILT — D-291.
 *
 * D-217 took mail off the signup request path so that a provider outage could
 * not 500 a signup whose user row was already committed. Its reasoning rested,
 * in as many words, on a path that did not exist: "the RECOVERY PATH ALREADY
 * EXISTS … a resend re-mails the token that is already persisted." There were
 * seven `/auth/*` routes and none of them resent anything, so a signup during an
 * outage produced an account whose address was taken, whose verification mail
 * was gone, and which could neither be verified nor signed up for again.
 *
 * The request carries an email and nothing else, and the RESPONSE IS CONSTANT —
 * identical for an unknown address, an already-verified one and one awaiting
 * verification. Anything else turns this endpoint into the account-enumeration
 * oracle that `forgot-password` and `signup` are shaped to avoid, and this one
 * would leak a second bit besides existence: whether the address is verified.
 */
export const resendVerificationRequestSchema = z.object({ email: emailSchema });
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: opaqueTokenSchema,
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

// ---------------------------------------------------------------------------
// Parent-child linking
// ---------------------------------------------------------------------------

/** What a student receives after asking for a code. Shared out of band. */
export const linkCodeResponseSchema = z.object({
  code: z.string(),
  expiresAt: z.string().datetime(),
});
export type LinkCodeResponse = z.infer<typeof linkCodeResponseSchema>;

/**
 * The student's outstanding code, or `null` when they have none.
 *
 * Separate from `linkCodeResponseSchema` because "you have no live code" is a
 * legitimate answer with a 200, not an error — and because a screen that
 * re-issued on every render would invalidate the code the parent is part-way
 * through typing (D-012).
 */
export const activeLinkCodeResponseSchema = z.object({
  code: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
export type ActiveLinkCodeResponse = z.infer<typeof activeLinkCodeResponseSchema>;

export const submitLinkRequestSchema = z.object({ code: linkCodeSchema });
export type SubmitLinkRequest = z.infer<typeof submitLinkRequestSchema>;

/**
 * A link as either party sees it.
 *
 * `status` is always present because a parent must be able to see that the
 * request is still `pending` — a code alone grants nothing (§6.8).
 */
export const linkSchema = z.object({
  id: z.string().uuid(),
  parentUserId: z.string().uuid(),
  studentUserId: z.string().uuid(),
  status: linkStatusSchema,
  approvedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Link = z.infer<typeof linkSchema>;

export const linkResponseSchema = z.object({ link: linkSchema });
export type LinkResponse = z.infer<typeof linkResponseSchema>;

export const linkIdParamSchema = z.object({ id: z.string().uuid() });
export type LinkIdParam = z.infer<typeof linkIdParamSchema>;

/**
 * A parent's approved children.
 *
 * Deliberately thin: identifiers and link metadata only. Names, grades and
 * progress belong to `learner`, behind its own access check.
 */
export const linkedChildSchema = z.object({
  linkId: z.string().uuid(),
  studentUserId: z.string().uuid(),
  approvedAt: z.string().datetime().nullable(),
});
export type LinkedChild = z.infer<typeof linkedChildSchema>;

export const linkedChildrenResponseSchema = z.object({
  children: z.array(linkedChildSchema),
});
export type LinkedChildrenResponse = z.infer<typeof linkedChildrenResponseSchema>;

/**
 * The error envelope every failure uses, rendered by the single Fastify error
 * handler. The frontend branches on `code`, never on prose.
 *
 * `EMAIL_NOT_VERIFIED` is surfaced through this shape so the frontend can
 * offer to resend the verification email (§6.4, step 5).
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /**
     * A narrower machine-readable reason, present only where the frontend has
     * a specific recovery action to offer. Today that is exactly one value.
     */
    reason: z.literal('EMAIL_NOT_VERIFIED').optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
