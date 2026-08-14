import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FoxyChat } from '@/features/foxy/foxy-chat';
import { getServerT } from '@/lib/i18n/server';

export const metadata: Metadata = {
  title: 'Ask Foxy',
};

/**
 * Build-order step 9.
 *
 * A SERVER COMPONENT holding the heading, with one client island under it. The
 * transcript needs a stream and the heading does not, and shipping the heading
 * to the browser to keep them together would be a page that cannot render
 * before JavaScript does.
 */
export default async function FoxyPage() {
  const t = await getServerT();

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="rounded-card bg-brand p-6 text-white shadow-raised sm:p-8">
        <p className="text-sm font-semibold text-white">{t('foxy.eyebrow')}</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {t('foxy.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-white">{t('foxy.description')}</p>
      </section>

      {/*
        `FoxyChat` reads the open conversation from `useSearchParams`.

        THE BOUNDARY IS NOT WHAT MAKES THIS ROUTE DYNAMIC — every route in this
        application already is, because the server reads the language cookie to
        pick a dictionary. It is here so the heading above streams while the
        client island is still resolving, and so that if a future render mode
        ever does make static generation possible, `useSearchParams` fails
        loudly at this boundary instead of silently opting the whole page out.
      */}
      <Suspense fallback={<p className="text-sm text-muted">{t('foxy.loadingTranscript')}</p>}>
        <FoxyChat />
      </Suspense>
    </div>
  );
}
