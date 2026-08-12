import type { ReactNode } from 'react';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * THE BADGE PRIMITIVE — plan §4, tier 1, and the one primitive carrying a
 * PRODUCT CONSTRAINT rather than only a visual one.
 *
 * §9.1: "Note the client's constraint: NO HARSH RED 'Wrong'. The incorrect-
 * answer state uses `--info` with 'Not yet' copy, never `--danger`."
 *
 * So `danger` exists here for destructive state — a cancelled subscription, a
 * revoked link — and `info` is what an incorrect answer uses. A primitive
 * cannot enforce which one a caller picks, but naming them apart is what makes
 * the wrong choice visible in review instead of invisible in a class list.
 * ===========================================================================
 *
 * A badge is TEXT, not a control. If it needs a click it is a `Button` with a
 * different skin, and making a badge clickable is how a 44px target quietly
 * becomes a 20px one.
 */

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'info' | 'danger';

export interface BadgeProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly tone?: BadgeTone;
  /**
   * Announced to assistive technology in place of the visible text.
   *
   * A badge reading "4/5" beside a heading is meaningless read aloud on its
   * own; `srLabel` is where "four of five days practised" goes.
   */
  readonly srLabel?: string;
}

const tones: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-canvas text-muted',
  brand: 'bg-brand-subtle text-brand-strong',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-info/10 text-info',
  danger: 'bg-danger/10 text-danger',
};

export function Badge({ children, className, tone = 'neutral', srLabel }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold',
        tones[tone],
        className,
      )}
      data-tone={tone}
    >
      {srLabel === undefined ? (
        children
      ) : (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="sr-only">{srLabel}</span>
        </>
      )}
    </span>
  );
}
