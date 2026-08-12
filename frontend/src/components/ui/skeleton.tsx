import { cx } from '@/lib/utils/cx';

/**
 * A placeholder for content that has not arrived — plan §4, tier 1.
 *
 * ===========================================================================
 * IT IS `aria-hidden`, ALWAYS, AND THAT IS THE WHOLE POINT.
 *
 * A skeleton is a picture of absent content. Announced, it is a stream of
 * nothing — "blank blank blank" — while the real content is still loading. The
 * announcement belongs to ONE element that owns the whole region
 * (`LoadingState`, or a container with `aria-busy`), not to each grey box.
 *
 * So `Skeleton` is decoration by construction, and any screen using bare
 * skeletons without a surrounding busy region is silent to a screen reader.
 * `LoadingState` exists so that is never the shape a screen ends up in.
 * ===========================================================================
 *
 * The pulse is a Tailwind animation, and `globals.css` already stops every
 * animation under `prefers-reduced-motion` — so nothing here needs to know
 * about that preference, and nothing here may reintroduce motion that ignores
 * it.
 */

export type SkeletonShape = 'text' | 'block' | 'circle';

export interface SkeletonProps {
  readonly className?: string;
  readonly shape?: SkeletonShape;
}

const shapes: Readonly<Record<SkeletonShape, string>> = {
  text: 'h-4 w-full rounded-full',
  block: 'h-panel w-full rounded-card',
  circle: 'size-avatar rounded-full',
};

export function Skeleton({ className, shape = 'text' }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx('block animate-pulse bg-line', shapes[shape], className)}
      data-shape={shape}
    />
  );
}
