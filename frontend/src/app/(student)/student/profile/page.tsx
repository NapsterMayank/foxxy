import type { Metadata } from 'next';
import { ProfileScreen } from '@/features/profile/profile-screen';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Your profile',
};

/**
 * `/student/profile` — reached from the student's own name in the header, not
 * from the navigation. Mobile navigation is five columns and a profile is not
 * a sixth destination beside Learn and Practice; it is where your account
 * lives, which is what a name in a header means everywhere else.
 */
export default async function StudentProfilePage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('profileScreen.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t('profileScreen.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-white">
          {t('profileScreen.description')}
        </p>
      </section>

      <ProfileScreen />
    </div>
  );
}
