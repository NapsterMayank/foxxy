'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * THE THREE STATES EVERY DATA SCREEN HAS — plan §4 and §12.
 *
 * Loading, empty and error "all exist and are all tested" is in the definition
 * of done for every feature. Built once, here, because the alternative is
 * observable: the fifth screen invents its own spinner, its own empty wording
 * and its own retry button, and the product reads as five products.
 *
 * They live in ONE FILE on purpose. They are the same decision seen three ways
 * — "there is nothing to show yet, and here is why" — and splitting them into
 * three files invites three different shapes.
 *
 * ---------------------------------------------------------------------------
 * NONE OF THEM CONTAINS A USER-FACING STRING.
 *
 * Every word is a prop. §12 forbids literal user-facing text in components, and
 * a shared component is the worst place to break that rule: one hard-coded
 * "Something went wrong" is untranslatable on every screen at once.
 * ===========================================================================
 */

export interface LoadingStateProps {
  /** Announced while loading. The screen is silent without it. */
  readonly label: string;
  /** How many skeleton rows to draw. Match the shape of what is coming. */
  readonly rows?: number;
  readonly className?: string;
}

export function LoadingState({ className, label, rows = 3 }: LoadingStateProps) {
  return (
    <div
      /*
       * ONE busy region for the whole block. `Skeleton` is `aria-hidden` by
       * construction, so this element is the only thing a screen reader has to
       * go on — without it the page is a silent grey rectangle.
       */
      aria-busy="true"
      aria-live="polite"
      className={cx('space-y-4', className)}
      data-state="loading"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} shape="block" />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
  /** Decorative. Never the only carrier of meaning. */
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ action, className, description, icon, title }: EmptyStateProps) {
  return (
    <div
      className={cx('mx-auto max-w-prose px-4 py-12 text-center', className)}
      data-state="empty"
    >
      {icon === undefined ? null : (
        <div aria-hidden="true" className="mx-auto mb-6 text-brand">
          {icon}
        </div>
      )}
      {/*
        `<p>` and not a heading: an empty state can appear inside a section that
        already has one, and a second h2 in the same region breaks the outline.
      */}
      <p className="text-xl font-bold tracking-tight text-ink">{title}</p>
      <p className="mt-3 text-base leading-body text-muted">{description}</p>
      {action === undefined ? null : <div className="mt-8">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title: string;
  readonly description: string;
  readonly retryLabel: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}

export function ErrorState({
  className,
  description,
  onRetry,
  retryLabel,
  title,
}: ErrorStateProps) {
  return (
    <div
      className={cx('mx-auto max-w-prose px-4 py-12 text-center', className)}
      data-state="error"
      /*
       * `alert`, so it is announced when it replaces the loading state. An error
       * a screen reader user has to go looking for is an error they will not
       * find — they have no visual cue that the region changed at all.
       */
      role="alert"
    >
      <p className="text-xl font-bold tracking-tight text-ink">{title}</p>
      <p className="mt-3 text-base leading-body text-muted">{description}</p>
      {/*
        NO RETRY BUTTON WITHOUT A HANDLER. A button that does nothing is worse
        than none: it makes a dead end look like a recoverable one, and the user
        presses it repeatedly. Some failures genuinely are not retryable — a 403
        will not become a 200 — and those callers pass no `onRetry`.
      */}
      {onRetry === undefined ? null : (
        <Button className="mt-8" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
