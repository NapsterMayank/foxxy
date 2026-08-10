import { parseInput } from '@/platform/validation/index';
import {
  foxySessionIdParamSchema,
  foxySessionListQuerySchema,
  sendFoxyMessageRequestSchema,
  startFoxySessionRequestSchema,
} from '@/shared/contracts/foxy.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/foxy.contract.ts`, where the frontend
 * imports the inferred types from — one definition, two consumers. This file
 * only binds them to the module.
 *
 * ===========================================================================
 * THE ONLY IDENTIFIER A CALLER SUPPLIES IS A SESSION ID.
 *
 * There is no student id on any of these shapes, and there must never be one:
 * the student is resolved from the SESSION COOKIE, so there is no field to
 * change in order to reach somebody else's conversations. Validating the
 * session id as a UUID here is a convenience, not a boundary — a well-formed id
 * for a session that belongs to another student is refused by
 * `assertCanAccess` with the same contentless 403 as any other cross-tenant
 * read.
 *
 * THE GRADE IS ALSO ABSENT, for the same class of reason. It comes from the
 * student's profile on every turn; a grade a caller could send is a grade a
 * caller could send wrongly, and it is the hard filter retrieval depends on.
 * ===========================================================================
 */
export const foxySchemas = {
  sessionIdParam: foxySessionIdParamSchema,
  startSession: startFoxySessionRequestSchema,
  sendMessage: sendFoxyMessageRequestSchema,
  listQuery: foxySessionListQuerySchema,
} as const;

export { parseInput };
