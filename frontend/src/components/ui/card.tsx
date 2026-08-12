import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/utils/cx';

/**
 * The surface every block of content sits on — plan §4, tier 1.
 *
 * ===========================================================================
 * `as` EXISTS BECAUSE THE RIGHT ELEMENT DEPENDS ON THE CONTENT, NOT THE LOOK.
 *
 * A card holding one self-contained thing is an `<article>`; a card grouping a
 * labelled region is a `<section>`; a card that is pure layout is a `<div>`.
 * Hard-coding `<div>` and letting callers "fix it later" produces a document
 * with no landmarks at all, which is invisible on screen and total on a screen
 * reader.
 * ===========================================================================
 *
 * `padded={false}` is for a card whose child owns the edges — an illustration
 * well, a table that bleeds to the border. Without it, callers reach for
 * negative margins, which is how a layout starts overflowing at 360px.
 */

export interface CardProps extends HTMLAttributes<HTMLElement> {
  readonly as?: ElementType;
  readonly children: ReactNode;
  /** Raised is the default. `flat` is for a card inside another surface. */
  readonly elevation?: 'flat' | 'raised';
  readonly padded?: boolean;
}

export function Card({
  as: Element = 'div',
  children,
  className,
  elevation = 'raised',
  padded = true,
  ...props
}: CardProps) {
  return (
    <Element
      className={cx(
        'rounded-card border border-line bg-surface',
        elevation === 'raised' ? 'shadow-raised' : 'shadow-none',
        padded && 'p-4 sm:p-6',
        className,
      )}
      {...props}
    >
      {children}
    </Element>
  );
}
