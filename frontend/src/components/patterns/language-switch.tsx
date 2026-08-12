'use client';

import { useRouter } from 'next/navigation';
import { useLanguage, useT } from '@/lib/i18n/i18n-provider';
import { languages, type LanguageCode } from '@/lib/i18n/translate';
import { cx } from '@/lib/utils/cx';

/**
 * ===========================================================================
 * THE LANGUAGE SWITCH — build-order step 5, "switching language re-renders
 * every string".
 *
 * TWO THINGS HAPPEN ON A SWITCH, and both are needed.
 *
 *  1. The context updates, so every CLIENT component re-renders immediately.
 *  2. `router.refresh()`, so every SERVER component re-renders too. Server
 *     components read the cookie, not the context — without the refresh the
 *     page ends up half translated, and which half depends on where the
 *     component happens to live. That is the worst possible outcome: it looks
 *     like a translation gap rather than a plumbing bug.
 *
 * ---------------------------------------------------------------------------
 * EACH LANGUAGE IS NAMED IN ITSELF — "English" and "हिन्दी", never "Hindi".
 *
 * Somebody who reads only Hindi cannot find a button labelled with an English
 * word for their own language. This is the one place where NOT translating the
 * label is the accessible choice, and it is why both names sit in `common`
 * with the same value in both dictionaries.
 * ===========================================================================
 */

const nameKeys = {
  en: 'common.english',
  hi: 'common.hindi',
} as const;

export interface LanguageSwitchProps {
  readonly className?: string;
}

export function LanguageSwitch({ className }: LanguageSwitchProps) {
  const { language, setLanguage } = useLanguage();
  const router = useRouter();
  const t = useT();

  const choose = (next: LanguageCode): void => {
    if (next === language) return;
    setLanguage(next);
    // See the header: server components read the cookie, not the context.
    router.refresh();
  };

  return (
    <div
      aria-label={t('common.languageLabel')}
      className={cx('inline-flex items-center gap-1 rounded-full bg-canvas p-1', className)}
      role="group"
    >
      {languages.map((code) => (
        <button
          aria-pressed={code === language}
          className={cx(
            'min-h-control min-w-control rounded-full px-4 py-2 text-sm font-semibold transition-surface duration-micro focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25',
            code === language ? 'bg-brand text-brand-fg' : 'text-muted hover:text-brand-strong',
          )}
          key={code}
          onClick={() => {
            choose(code);
          }}
          type="button"
        >
          {t(nameKeys[code])}
        </button>
      ))}
    </div>
  );
}
