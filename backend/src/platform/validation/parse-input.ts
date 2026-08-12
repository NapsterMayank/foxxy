import type { z } from 'zod';
import { ValidationError } from '../errors/index';

/**
 * platform/validation — the one parse helper every module's routes use.
 *
 * WHY THIS IS IN PLATFORM AND NOT IN EACH MODULE (D-050). It began as a
 * private function in `identity.schema.ts`, which was correct while identity
 * was the only module with routes. `learner` and `content` are the second and
 * third, and the alternative to moving it is three copies of the same fifteen
 * lines.
 *
 * Three copies is not a tidiness problem. This function decides what a client
 * is told when its request is malformed, and that is a disclosure decision: a
 * copy that drifts into including the received VALUE in the message is a copy
 * that echoes a password back in a 400. Deciding it once, in one file, is the
 * only way that stays true across eleven modules.
 *
 * It contains no business rule — it turns a `ZodError` into an `AppError` —
 * so it belongs in platform under the §2 layer table.
 */

/**
 * Parses input at the HTTP boundary.
 *
 * The client is told WHICH FIELD failed and the SCHEMA'S OWN MESSAGE, and
 * nothing else. That is safe by construction: both describe the request the
 * caller has just sent, never any stored state, so nothing about whether an
 * account or a student exists can be inferred from a shape error. The received
 * value is deliberately absent — echoing it back is how a validation message
 * ends up quoting a password in a log aggregator.
 */
export function parseInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data as z.infer<TSchema>;
  }

  const first = result.error.issues[0];
  const field = first === undefined ? 'request' : first.path.join('.');
  const detail = first === undefined ? 'is invalid' : first.message;

  throw new ValidationError(field.length > 0 ? `${field}: ${detail}` : detail, {
    message: `Validation failed: ${result.error.issues.length} issue(s)`,
  });
}
