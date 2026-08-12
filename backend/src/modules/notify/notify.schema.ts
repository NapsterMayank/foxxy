import { parseInput } from '@/platform/validation/index';
import { listNotificationsQuerySchema } from '@/shared/contracts/notify.contract';
import { z } from 'zod';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/notify.contract.ts` because the frontend
 * imports the inferred types from there — one definition, two consumers. This
 * file only binds them to the module and adds the one shape that is a URL
 * parameter rather than a wire body.
 */

/**
 * A notification id from the path.
 *
 * `.uuid()` rather than `.string()`, and it is not decoration: without it a
 * malformed id reaches the repository and Postgres refuses the comparison with
 * a raw type error, which the error handler maps to a 500. A 400 is the honest
 * answer for "that is not an identifier", and it is also the answer that does
 * not distinguish a well-formed id belonging to someone else from a malformed
 * one — the deny path for the former is a 403, which is where it should be.
 */
export const notificationIdParamSchema = z.object({
  id: z.string().uuid('That is not a notification id.'),
});

export const notifySchemas = {
  listQuery: listNotificationsQuerySchema,
  idParam: notificationIdParamSchema,
} as const;

export { parseInput };
