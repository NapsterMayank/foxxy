'use client';

import { useId, type ReactNode } from 'react';
import { FieldProvider } from '@/components/ui/field-context';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * FORM FIELD — plan §4, "used by every form".
 *
 * `<FormField label error hint>{children}</FormField>` — the signature the plan
 * names, and the ids are wired through context so the input can be wrapped in
 * anything without silently losing its label. See `ui/field-context.tsx`.
 *
 * THE ERROR IS `role="alert"` AND THE HINT IS NOT. A hint is present before
 * anything goes wrong and announcing it on render talks over the label; an
 * error appears BECAUSE something went wrong and the person needs to know
 * without hunting for it.
 *
 * BOTH are in `aria-describedby` when both exist, and the ERROR COMES FIRST —
 * a screen reader reads them in the order listed, and "enter a valid email"
 * matters more than "we never share your address".
 *
 * ---------------------------------------------------------------------------
 * `error` IS A STRING, NOT A BOOLEAN.
 *
 * §5.6: a 400 maps field errors onto the form, never a page-level error. A
 * boolean would let a screen render a red border with no message, which tells
 * the user something is wrong and not what — the single most common form
 * defect, and the hardest to notice in review because the border is visible
 * and the missing sentence is not.
 * ===========================================================================
 */

export interface FormFieldProps {
  readonly children: ReactNode;
  readonly label: string;
  /** The message itself. Its presence is what marks the field invalid. */
  readonly error?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly className?: string;
}

export function FormField({
  children,
  className,
  error,
  hint,
  label,
  required = false,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [error === undefined ? null : errorId, hint === undefined ? null : hintId]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className={cx('block', className)}>
      <label className="block text-sm font-semibold text-ink" htmlFor={id}>
        {label}
        {required ? (
          <>
            {/*
              The asterisk is decoration; "required" is the fact. A screen
              reader gets it from `aria-required` on the control, which the
              context sets — announcing a lone "*" is noise.
            */}
            <span aria-hidden="true" className="ml-1 text-danger">
              *
            </span>
          </>
        ) : null}
      </label>

      <div className="mt-2">
        <FieldProvider value={{ id, describedBy, invalid: error !== undefined, required }}>
          {children}
        </FieldProvider>
      </div>

      {hint === undefined ? null : (
        <p className="mt-2 text-sm leading-body text-muted" id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="mt-2 text-sm font-semibold leading-body text-danger" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
