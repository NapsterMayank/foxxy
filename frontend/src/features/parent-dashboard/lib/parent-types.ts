import type { z } from 'zod';
import type { childrenResponseSchema } from '@/lib/api/generated/contracts/parent.contract';

/**
 * One child, as the dashboard passes it around.
 *
 * DERIVED FROM THE GENERATED RESPONSE rather than declared. `parentChildSchema`
 * is not exported as a type by the contract — only `ChildrenResponse` is — and
 * re-declaring the five fields here would be §12's forbidden "hand-written type
 * for data the backend already defines". Indexing the array element keeps one
 * definition: a field added or retyped upstream arrives here with no edit.
 */
export type ParentChild = z.infer<typeof childrenResponseSchema>['children'][number];
