import type { ButtonHTMLAttributes } from 'react';
import { cx } from '@/lib/utils/cx';

export function Button({ className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        'inline-flex min-h-control items-center justify-center rounded-full bg-brand px-6 py-3 text-sm font-semibold text-white shadow-raised transition-surface duration-150 hover:bg-brand-strong hover:shadow-overlay focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-press disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      data-motion="press"
      type={type}
      {...props}
    />
  );
}
