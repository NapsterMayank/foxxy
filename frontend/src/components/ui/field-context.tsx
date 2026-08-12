'use client';

import { createContext, useContext } from 'react';

/**
 * ===========================================================================
 * HOW A FIELD FINDS ITS LABEL, ITS HINT AND ITS ERROR.
 *
 * `FormField` (a pattern) owns the ids; `Input` (a primitive) needs them. The
 * obvious wiring — `FormField` clones its child and injects props — breaks the
 * moment a caller wraps the input in a div, and it fails silently: the label
 * still looks attached and is no longer announced.
 *
 * THE CONTEXT LIVES HERE, IN `components/ui`, AND NOT IN `components/patterns`
 * — deliberately. A primitive importing from `patterns/` would invert the tier
 * order in §4 and make every primitive depend on the pattern layer. This way
 * the primitive owns the contract and the pattern fills it in, which is the
 * direction the tiers already run.
 *
 * A field with NO provider still works: `useField` returns nulls, the input
 * renders unadorned, and a caller doing their own labelling is not fought.
 * ===========================================================================
 */

export interface FieldState {
  readonly id: string;
  /** Ids of the hint and error text, for `aria-describedby`. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
}

const FieldContext = createContext<FieldState | null>(null);

export const FieldProvider = FieldContext.Provider;

export function useField(): FieldState | null {
  return useContext(FieldContext);
}
