'use client';

import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from '@/lib/utils/cx';
import { useField } from './field-context';

/**
 * ===========================================================================
 * TEXT ENTRY — plan §4, tier 1.
 *
 * TWO THINGS HERE ARE NOT COSMETIC.
 *
 * `text-base` — 16px. Mobile Safari ZOOMS THE PAGE when a focused input's font
 * is below 16px, and the zoom is not undone on blur: the user is left on a
 * horizontally scrolled layout they did not ask for. Every "why does the form
 * jump on iPhone" bug is this. §9.1 sets 16px as the body minimum for the same
 * reason from the other direction — the readers are children on small phones.
 *
 * `min-h-control` — 44px, §12, on every interactive element.
 *
 * The invalid state comes from `FormField` through context rather than from a
 * prop, so a field cannot be visibly red while `aria-invalid` says otherwise.
 * ===========================================================================
 */

const base =
  'w-full min-h-control rounded-card border bg-surface px-4 py-3 text-base font-normal text-ink outline-none transition-surface duration-micro placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60';

const valid = 'border-line focus:border-brand focus:ring-4 focus:ring-brand/15';
const invalid = 'border-danger focus:border-danger focus:ring-4 focus:ring-danger/15';

/** The attributes every field type takes from the surrounding `FormField`. */
function fieldAttributes(field: ReturnType<typeof useField>) {
  if (field === null) return {};
  return {
    id: field.id,
    'aria-describedby': field.describedBy,
    'aria-invalid': field.invalid ? (true as const) : undefined,
    required: field.required,
  };
}

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, type = 'text', ...props }: InputProps) {
  const field = useField();
  return (
    <input
      className={cx(base, field?.invalid === true ? invalid : valid, className)}
      type={type}
      {...fieldAttributes(field)}
      {...props}
    />
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, rows = 4, ...props }: TextareaProps) {
  const field = useField();
  return (
    <textarea
      className={cx(base, field?.invalid === true ? invalid : valid, className)}
      rows={rows}
      {...fieldAttributes(field)}
      {...props}
    />
  );
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, ...props }: SelectProps) {
  const field = useField();
  return (
    <select
      className={cx(base, field?.invalid === true ? invalid : valid, className)}
      {...fieldAttributes(field)}
      {...props}
    >
      {children}
    </select>
  );
}
