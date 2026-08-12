'use client';

import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n/i18n-provider';

interface ErrorPageProps {
  error: Error & { digest?: string };
  retry: () => void;
}

export default function ErrorPage({ retry }: ErrorPageProps) {
  const t = useT();

  return (
    <main className="grid min-h-screen place-items-center px-4 py-16">
      <section className="w-full max-w-xl rounded-card border border-line bg-surface p-8 text-center shadow-raised sm:p-12">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand">{t('error.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">
          {t('error.title')}
        </h1>
        <p className="mt-4 text-base leading-7 text-muted">{t('error.description')}</p>
        <Button className="mt-8" onClick={retry}>
          {t('error.action')}
        </Button>
      </section>
    </main>
  );
}
