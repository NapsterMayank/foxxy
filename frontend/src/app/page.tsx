import Link from 'next/link';
import { ParentIllustration, StudentIllustration } from '@/components/ui/role-illustrations';
import { RoleCard } from '@/components/ui/role-card';
import { getServerT } from '@/lib/i18n/server';

export default async function RoleSelectionPage() {
  const t = await getServerT();

  return (
    <main className="mx-auto flex min-h-screen max-w-shell flex-col px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <header className="flex items-center justify-between" aria-label={t('common.brand')}>
        <span className="text-lg font-extrabold tracking-tight text-ink">
          <span className="text-logo">{t('common.brandPrefix')}</span>
          {t('common.brandSuffix')}
        </span>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center py-12 sm:py-16">
        <div className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">{t('home.eyebrow')}</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            {t('home.title')}
          </h1>
          <p className="mt-4 text-base leading-7 text-muted sm:text-lg">{t('home.description')}</p>
        </div>

        <div className="mt-8 grid gap-6 sm:mt-12 sm:grid-cols-2">
          <RoleCard
            action={t('home.student.action')}
            description={t('home.student.description')}
            href="/login?role=student"
            illustration={<StudentIllustration />}
            label={t('home.student.label')}
            theme="student"
          />
          <RoleCard
            action={t('home.parent.action')}
            description={t('home.parent.description')}
            href="/login?role=parent"
            illustration={<ParentIllustration />}
            label={t('home.parent.label')}
            theme="parent"
          />
        </div>

        <p className="mt-8 text-center text-sm text-muted">
          {t('home.accountPrompt')}{' '}
          <Link className="font-semibold text-brand underline-offset-4 hover:underline" href="/signup">
            {t('home.accountAction')}
          </Link>
        </p>
      </section>
    </main>
  );
}
