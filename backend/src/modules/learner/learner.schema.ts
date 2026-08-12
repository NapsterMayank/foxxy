import { parseInput } from '@/platform/validation/index';
import {
  onboardingRequestSchema,
  updateProfileRequestSchema,
} from '@/shared/contracts/learner.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/learner.contract.ts` because the
 * frontend imports the inferred types from there — one definition, two
 * consumers. This file only binds them to the module.
 *
 * `learnerSchemas.onboarding` and `.updateProfile` are the ONLY two doors
 * through which a grade can enter this system, and `gradeSchema` behind them
 * is the sole enforcement of §8.2's "grade 6 as a NUMBER is rejected" — the
 * database provably cannot do it (D-038). The long note is in the contract,
 * beside the schema itself, so it cannot be separated from what it explains.
 */
export const learnerSchemas = {
  onboarding: onboardingRequestSchema,
  updateProfile: updateProfileRequestSchema,
} as const;

export { parseInput };
