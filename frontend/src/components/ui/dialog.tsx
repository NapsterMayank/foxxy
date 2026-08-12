'use client';

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * THE DIALOG PRIMITIVE — plan §4, tier 1.
 *
 * NOT the native `<dialog>` element, and the reason is worth stating because
 * native is the right instinct: `showModal()` gives a focus trap, Escape
 * handling and an inert background for free. It is not implemented in jsdom
 * (checked — jsdom 25 has no `showModal`), so every behaviour below would have
 * to be tested against a polyfill instead of against the real thing. A modal
 * whose focus trap is only ever exercised by a fake is a modal with no tested
 * focus trap, and this is the one component where that trap IS the component.
 *
 * FOUR BEHAVIOURS, each with a failure that is invisible to a sighted mouse
 * user and total to everyone else:
 *
 *   focus moves IN        otherwise the keyboard user is still behind the
 *                         dialog, tabbing through content they cannot see
 *   focus is TRAPPED      otherwise Tab walks out into the page behind and the
 *                         dialog becomes an unclosable overlay
 *   focus RETURNS         otherwise closing drops the user at the top of the
 *                         document, having lost their place entirely
 *   Escape CLOSES         the one gesture every user already knows
 *
 * Background scroll is locked while open, because a modal that scrolls the page
 * underneath it is how a phone user loses the dialog off the top of the screen.
 * ===========================================================================
 */

export interface DialogProps {
  readonly children: ReactNode;
  /** Accessible name. Rendered as the heading unless `hideTitle`. */
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Footer controls. Kept separate so the layout cannot drift per caller. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

/** Everything focusable, in DOM order. Used for the trap and the initial focus. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

export function Dialog({ children, className, footer, onClose, open, title }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  /*
   * Remembered on the render that OPENS the dialog, not in the close handler:
   * by the time it closes, focus is inside the dialog and the element that
   * opened it is no longer `document.activeElement`.
   */
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    // The panel itself carries `tabIndex={-1}`, so there is always somewhere to
    // put focus even in a dialog with no controls at all.
    (focusableWithin(panel ?? document.body)[0] ?? panel)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;
      const focusable = focusableWithin(panel);
      if (focusable.length === 0) {
        // Nothing to move to; keep focus on the panel rather than letting the
        // browser walk into the page behind.
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;

      /*
       * THE WRAP IS EXPLICIT IN BOTH DIRECTIONS. Handling only forward Tab
       * leaves Shift+Tab escaping backwards out of the top of the dialog, which
       * is the half-implemented trap almost every hand-rolled modal ships with.
       */
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last?.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;
  // `createPortal` needs a document; on the server there is none, and a dialog
  // has nothing to show before hydration anyway.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-10 grid place-items-center bg-ink/40 p-4"
      /*
       * The backdrop closes on a click on ITSELF, never on a click that merely
       * bubbled out of the panel — `event.target === event.currentTarget`. The
       * bubbling version dismisses the dialog when someone finishes a text
       * selection inside it, losing whatever they typed.
       */
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={cx(
          'w-full max-w-lg rounded-card border border-line bg-surface p-6 shadow-modal',
          className,
        )}
        onKeyDown={onKeyDown}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-xl font-bold tracking-tight text-ink" id={titleId}>
          {title}
        </h2>
        <div className="mt-4 text-base leading-body text-muted">{children}</div>
        {footer === undefined ? null : (
          <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
