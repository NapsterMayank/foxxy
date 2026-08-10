import { parseInput } from '@/platform/validation/index';
import {
  childIdParamSchema,
  transcriptQuerySchema,
  weekQuerySchema,
} from '@/shared/contracts/parent.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/parent.contract.ts`, where the frontend
 * imports the inferred types from — one definition, two consumers. This file
 * only binds them to the module.
 *
 * THE CHILD ID IS THE ONLY IDENTIFIER A CALLER SUPPLIES, and validating it as a
 * UUID here is a convenience, not a boundary: a well-formed id for a child this
 * parent has no link to is refused by `assertCanAccess` with the same
 * contentless 403 as a malformed one gets a 400. The access decision is never
 * made in this file or the one that uses it.
 */
export const parentSchemas = {
  childIdParam: childIdParamSchema,
  weekQuery: weekQuerySchema,
  transcriptQuery: transcriptQuerySchema,
} as const;

export { parseInput };
