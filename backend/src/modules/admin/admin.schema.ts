import { parseInput } from '@/platform/validation/index';
import { z } from 'zod';
import {
  adminIdParamSchema,
  adminPageQuerySchema,
  revealRequestSchema,
} from '@/shared/contracts/admin.contract';

/**
 * The module's validation boundary.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS RATHER THAN CALLING `schema.parse()` IN THE ROUTE.
 *
 * Because `.parse()` throws a raw `ZodError`, and a raw `ZodError` reaching the
 * error plugin is a 500. Every malformed admin request — a non-uuid in a path,
 * an unknown reason code, a missing field — answered "the server is broken"
 * instead of "your request is wrong.
 *
 * That was live for the length of one commit and the tests caught it, which is
 * the only reason this comment is retrospective rather than a bug report.
 * `platform/validation`'s `parseInput` is the shared wrapper that turns a Zod
 * failure into a `ValidationError`, and every other module has used it from the
 * start. This one now does too.
 *
 * ON THIS SURFACE THE DIFFERENCE MATTERS MORE THAN USUAL: a 500 is an error a
 * caller retries and an operator investigates. A stream of them from a mistyped
 * uuid would send somebody hunting a fault that does not exist, during the
 * incident they opened the panel for.
 * =============================================================================
 */
export const adminSchemas = {
  idParam: adminIdParamSchema,
  pageQuery: adminPageQuerySchema,
  reveal: revealRequestSchema,
  /** `?studentUserId=` — an optional narrowing, never an authorisation. */
  studentFilter: z.object({ studentUserId: z.string().uuid().optional() }),
} as const;

export { parseInput };
