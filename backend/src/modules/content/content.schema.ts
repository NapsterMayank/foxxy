import { parseInput } from '@/platform/validation/index';
import {
  chapterIdParamSchema,
  chapterListQuerySchema,
} from '@/shared/contracts/content.contract';

/**
 * The module's validation boundary.
 *
 * The SHAPES live in `shared/contracts/content.contract.ts` because the
 * frontend imports the inferred types from there. This file only binds them to
 * the module.
 */
export const contentSchemas = {
  chapterList: chapterListQuerySchema,
  chapterIdParam: chapterIdParamSchema,
} as const;

export { parseInput };
