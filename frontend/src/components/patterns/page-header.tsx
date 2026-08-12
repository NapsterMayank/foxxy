import type { ReactNode } from 'react';
import { cx } from '@/lib/utils/cx';

/**
 * The heading block every page starts with — plan §4.
 *
 * ===========================================================================
 * IT RENDERS THE `<h1>`, AND IT IS THE ONLY THING THAT SHOULD.
 *
 * One h1 per page, always present, always first in the outline. Screens that
 * each write their own heading drift into two h1s (a title and a section that
 * felt important) or none (a dashboard whose biggest text is a number), and
 * both are invisible until somebody navigates by headings.
 *
 * `actions` sits AFTER the title in the DOM and before it visually only at wide
 * widths. Reading order follows the DOM, so a keyboard user reaches the page
 * title before the buttons that act on it — which is the order that makes sense
 * when you cannot see the layout.
 * ===========================================================================
 */

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Buttons or links acting on the whole page. */
  readonly actions?: ReactNode;
  readonly className?: string;
  /** An id so a skip link or an anchor can target the heading. */
  readonly id?: string;
}

export function PageHeader({ actions, className, id, subtitle, title }: PageHeaderProps) {
  return (
    <header className={cx('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-3xl" id={id}>
          {title}
        </h1>
        {subtitle === undefined ? null : (
          <p className="mt-2 max-w-prose text-base leading-body text-muted">{subtitle}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
      )}
    </header>
  );
}
