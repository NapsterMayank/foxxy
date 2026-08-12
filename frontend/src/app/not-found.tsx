import { ButtonLink } from '@/components/ui/button-link';
import { getServerT } from '@/lib/i18n/server';

export default async function NotFoundPage() {
  const t = await getServerT();

  return (
    <main className="grid min-h-screen place-items-center px-4 py-16">
      <section className="w-full max-w-xl rounded-card border border-line bg-surface p-8 text-center shadow-raised sm:p-12">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand">{t('notFound.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">
          {t('notFound.title')}
        </h1>
        <p className="mt-4 text-base leading-7 text-muted">{t('notFound.description')}</p>
        <ButtonLink className="mt-8" href="/" label={t('notFound.action')}>
          {t('notFound.action')}
        </ButtonLink>
      </section>
    </main>
  );
}
