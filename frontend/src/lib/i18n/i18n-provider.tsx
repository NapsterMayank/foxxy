'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  createTranslator,
  isLanguage,
  type LanguageCode,
  type Translator,
} from './translate';

/**
 * ===========================================================================
 * LANGUAGE AS CROSS-CUTTING CLIENT STATE — plan §6's table, "language, theme,
 * toasts → React Context, one per concern".
 *
 * The chosen language is written to a COOKIE rather than to `localStorage`,
 * and that is the whole design:
 *
 *  - the SERVER renders in the right language on the first paint, because it
 *    can read a cookie and cannot read `localStorage`. With `localStorage` the
 *    first render is always English and then flips, which is a visible flash
 *    on every page load for every Hindi user.
 *  - `<html lang>` is correct from the first byte, so a screen reader picks the
 *    right voice for the first sentence rather than reading Devanagari with an
 *    English one.
 *
 * IT IS NOT httpOnly AND MUST NOT BE. The switch runs in the browser and has to
 * write it. Nothing about a display language is a secret; the session cookie —
 * which IS a secret — is a different cookie with different flags.
 * ===========================================================================
 */

/** A year. A person's language does not change per session. */
const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface I18nState {
  readonly language: LanguageCode;
  readonly t: Translator;
  readonly setLanguage: (language: LanguageCode) => void;
}

const I18nContext = createContext<I18nState | null>(null);

export function readLanguageCookie(cookie: string): LanguageCode {
  const match = new RegExp(`(?:^|; )${LANGUAGE_COOKIE}=([^;]*)`).exec(cookie);
  const value = match?.[1] === undefined ? null : decodeURIComponent(match[1]);
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

export function I18nProvider({
  children,
  initialLanguage,
}: Readonly<{ children: ReactNode; initialLanguage: LanguageCode }>) {
  const [language, setLanguageState] = useState<LanguageCode>(initialLanguage);

  const setLanguage = useCallback((next: LanguageCode) => {
    setLanguageState(next);

    if (typeof document === 'undefined') return;
    document.cookie = `${LANGUAGE_COOKIE}=${next}; path=/; max-age=${String(LANGUAGE_COOKIE_MAX_AGE)}; samesite=lax`;
    /*
     * `<html lang>` IS UPDATED HERE rather than left to the next full load.
     * It drives screen-reader pronunciation and the browser's own hyphenation;
     * a page whose strings are Hindi and whose `lang` still says `en` is read
     * aloud with an English voice, which is unintelligible rather than merely
     * wrong.
     */
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<I18nState>(
    () => ({ language, t: createTranslator(language), setLanguage }),
    [language, setLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nState {
  const value = useContext(I18nContext);
  if (value === null) {
    // A default would silently render English inside an unwrapped subtree,
    // which is exactly the bug this system exists to prevent.
    throw new Error('useT/useLanguage must be used inside <I18nProvider>.');
  }
  return value;
}

/** The translation function. Re-created per language, so a switch re-renders. */
export function useT(): Translator {
  return useI18n().t;
}

export function useLanguage(): { language: LanguageCode; setLanguage: (next: LanguageCode) => void } {
  const { language, setLanguage } = useI18n();
  return { language, setLanguage };
}
