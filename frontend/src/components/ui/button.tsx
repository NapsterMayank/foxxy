import type { ButtonHTMLAttributes } from 'react';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * THE BUTTON PRIMITIVE — plan §4, tier 1.
 *
 * It knows NOTHING. Not what a quiz is, not what a subscription is, not which
 * theme it is inside. The moment a primitive imports a feature type the tier
 * system has collapsed and every primitive becomes coupled to everything.
 *
 * Three variants and no more, because a fourth is almost always a fifth
 * opinion about hierarchy rather than a real need. `primary` is the one action
 * a screen wants; `secondary` is the alternative; `quiet` is for actions that
 * must be available without competing (dismiss, skip, show more).
 *
 * `danger` IS DELIBERATELY ABSENT. Destructive confirmation lives in
 * `ConfirmDialog`, which owns the whole interaction — the wording, the
 * two-step, the focus handling — and a red button available everywhere is an
 * invitation to build the one-step version of it. See `patterns/confirm-dialog`.
 * ===========================================================================
 */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** Stretches to the container. The common mobile case, so it is a prop. */
  readonly fullWidth?: boolean;
}

/**
 * `min-h-control` and `min-w-control` are 44px — §12, on EVERY interactive
 * element at every breakpoint. Not a suggestion: below it, a child on a phone
 * misses.
 */
const base =
  'inline-flex min-h-control min-w-control items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-surface duration-micro focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100';

/**
 * Semantic tokens only. A hard-coded `purple-600` renders wrong in the parent
 * application, which is why `architecture/semantic-tailwind-only` rejects the
 * literal — but the rule cannot see inside `cx()`, so this table is where the
 * discipline actually lives.
 */
const variants: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-brand text-brand-fg shadow-raised hover:bg-brand-strong hover:shadow-overlay',
  secondary: 'border border-line bg-surface text-ink hover:border-brand hover:text-brand-strong',
  quiet: 'text-brand hover:bg-brand-subtle hover:text-brand-strong',
};

export function Button({
  className,
  fullWidth = false,
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cx(base, variants[variant], fullWidth && 'w-full', className)}
      data-motion="press"
      data-variant={variant}
      /*
       * DEFAULTS TO `button`, NOT `submit`.
       *
       * A bare <button> inside a form submits it. A "show hint" control that
       * submits the practice answers is data loss wearing the shape of a
       * styling bug, and it only happens on the screens that have forms.
       */
      type={type}
      {...props}
    />
  );
}
