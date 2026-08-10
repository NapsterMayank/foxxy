import { parseInput } from '@/platform/validation/index';
import { subscribeRequestSchema } from '@/shared/contracts/billing.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/billing.contract.ts`, where the frontend
 * imports the inferred types from — one definition, two consumers. This file
 * only binds them to the module.
 *
 * ===========================================================================
 * THE WEBHOOK BODY IS DELIBERATELY NOT VALIDATED HERE, AND THAT IS NOT AN
 * OVERSIGHT.
 *
 * Everything else in this codebase parses its input at the edge. The webhook
 * must not: §8.8 rule 1 says the SIGNATURE is verified before anything is
 * parsed, and a Zod schema running in the route would parse attacker-controlled
 * bytes before the HMAC had said they were ours. The webhook route therefore
 * takes the RAW body and hands it straight to `verifyWebhook`, which is the
 * only thing allowed to look at it first.
 * ===========================================================================
 */
export const billingSchemas = {
  subscribe: subscribeRequestSchema,
} as const;

export { parseInput };
