import { LANGUAGES, type LanguageCode } from '@/lib/api/generated/constants/curriculum';
import { en, type Dictionary } from './dictionaries/en';
import { hi } from './dictionaries/hi';

/**
 * ===========================================================================
 * THE TRANSLATION FUNCTION — plan §8.
 *
 * Pure, with no React in it, so the same code answers on the server, in a
 * client component and in a test. Everything React-shaped lives in
 * `i18n-provider.tsx`.
 *
 * THE LANGUAGE VOCABULARY COMES FROM THE BACKEND. `LANGUAGES` is generated
 * from `shared/constants/curriculum.ts`, the same list the database CHECK
 * constraint is built from — so the frontend cannot offer a language a profile
 * cannot store, which is the mismatch open item 34 already found once (the
 * onboarding form submitted `english`/`hindi` against a contract accepting
 * `en`/`hi`).
 * ===========================================================================
 */

export type { LanguageCode };
export const languages = LANGUAGES;
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/**
 * The cookie the switch writes and the server reads.
 *
 * IT LIVES HERE, IN A MODULE WITH NO `'use client'`, and that is not tidiness.
 * It used to be exported from `i18n-provider.tsx`, which IS a client module —
 * and a value imported from a client module into a server module does not
 * arrive as a string. `cookies().get(...)` was therefore looking up a client
 * reference, finding nothing, and every server render fell back to English
 * while the page-level cookie read (which used the literal) worked perfectly.
 * The symptom was `<html lang="en">` with Hindi content underneath it.
 */
export const LANGUAGE_COOKIE = 'foxxy_lang';

const dictionaries: Readonly<Record<LanguageCode, Dictionary>> = { en, hi };

export function dictionaryFor(language: LanguageCode): Dictionary {
  return dictionaries[language];
}

export function isLanguage(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Every leaf path in the dictionary, as a dotted string union.
 *
 * This is what makes `t('auth.loginTitle')` autocomplete and `t('auth.loginTitel')`
 * a BUILD failure. A stringly-typed translator moves that mistake to runtime,
 * where it renders either nothing or the key itself in front of a user.
 */
export type TranslationKey<T = Dictionary> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${TranslationKey<T[K]>}`;
}[keyof T & string];

/** Values substituted into `{placeholder}` slots. */
export type TranslationValues = Readonly<Record<string, string | number>>;

function lookup(dictionary: Dictionary, key: string): string | undefined {
  let current: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * `{name}` slots, filled from `values`.
 *
 * A slot with no value is left AS IT IS RATHER THAN BLANKED. "Good afternoon,
 * {name}" is obviously broken and gets fixed; "Good afternoon," reads like a
 * design choice and ships.
 */
function interpolate(template: string, values: TranslationValues | undefined): string {
  if (values === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

export interface Translator {
  (key: TranslationKey, values?: TranslationValues): string;
}

export function createTranslator(language: LanguageCode): Translator {
  const dictionary = dictionaryFor(language);

  return function t(key: TranslationKey, values?: TranslationValues): string {
    const direct = lookup(dictionary, key);
    if (direct !== undefined) return interpolate(direct, values);

    /*
     * MISSING KEY. §8: "falls back to English and warns in development. It must
     * never render a raw key to a user."
     *
     * With `hi` typed as `Dictionary` this is unreachable for a literal key —
     * the compiler already refused. It exists for keys built at runtime, and
     * for the window between a dictionary being edited and the types catching
     * up.
     */
    const fallback = lookup(en, key);
    if (fallback !== undefined) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`i18n: missing "${key}" in "${language}", falling back to English.`);
      }
      return interpolate(fallback, values);
    }

    if (process.env.NODE_ENV !== 'production') {
      console.warn(`i18n: unknown key "${key}".`);
    }
    /*
     * EMPTY, NEVER THE KEY. A raw `auth.loginTitle` on screen is worse than a
     * gap: it looks like a data leak to a user and like working software to
     * whoever screenshotted it.
     */
    return '';
  };
}
