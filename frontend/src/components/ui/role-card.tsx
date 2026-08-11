import type { ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/button-link';

interface RoleCardProps {
  action: string;
  description: string;
  href: string;
  illustration: ReactNode;
  label: string;
  theme: 'student' | 'parent';
}

export function RoleCard({ action, description, href, illustration, label, theme }: RoleCardProps) {
  return (
    <article
      className="group flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface shadow-raised transition-surface duration-transition hover:-translate-y-1 hover:shadow-overlay"
      data-motion="lift"
      data-theme={theme}
    >
      <div className="grid min-h-48 place-items-center bg-brand-subtle p-8 text-brand" aria-hidden="true">
        {illustration}
      </div>
      <div className="flex flex-1 flex-col items-center p-6 text-center sm:p-8">
        <h2 className="text-xl font-bold tracking-tight text-ink">{label}</h2>
        <p className="mt-3 max-w-xs text-base leading-6 text-muted">{description}</p>
        <ButtonLink className="mt-6 w-full" href={href} label={action}>
          {action}
          <span aria-hidden="true" className="ml-2">
            →
          </span>
        </ButtonLink>
      </div>
    </article>
  );
}
