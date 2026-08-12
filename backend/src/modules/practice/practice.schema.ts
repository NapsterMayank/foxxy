import { parseInput } from '@/platform/validation/index';
import {
  historyQuerySchema,
  sessionIdParamSchema,
  startSessionRequestSchema,
  submitAnswerRequestSchema,
} from '@/shared/contracts/practice.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/practice.contract.ts`, where the
 * frontend imports the inferred types from — one definition, two consumers.
 * This file only binds them to the module.
 *
 * `submitAnswer` is the one worth reading twice: its `selectedIndex` is bounded
 * to 0..3 by `OPTIONS_PER_QUESTION`, which is the presentation range, and the
 * service translates it into the canonical range through the session's shuffle
 * map. A schema that let a wider index through would produce a
 * `toCanonicalIndex` throw rather than a wrong answer — loud either way, which
 * is the intent.
 */
export const practiceSchemas = {
  startSession: startSessionRequestSchema,
  submitAnswer: submitAnswerRequestSchema,
  sessionIdParam: sessionIdParamSchema,
  historyQuery: historyQuerySchema,
} as const;

export { parseInput };
