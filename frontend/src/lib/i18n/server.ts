import { cookies } from 'next/headers';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  createTranslator,
  isLanguage,
  type LanguageCode,
  type Translator,
} from './translate';

/**
 * The server half of i18n — plan §8.
 *
 * ===========================================================================
 * SERVER COMPONENTS CANNOT USE `useT()`.
 *
 * Hooks need a client component, and most pages here are server components by
 * design (§2: "app/ is ROUTING ONLY. thin."). Two entry points to the same
 * dictionaries, therefore — but ONE translator implementation, in
 * `translate.ts`, so the two cannot disagree about a fallback or an
 * interpolation.
 *
 * The alternative — making every page a client component so it can call a hook
 * — would ship the whole dictionary to the browser for a page that renders
 * static text, on a 4G connection, to save one import here.
 * ===========================================================================
 */

export async function getServerLanguage(): Promise<LanguageCode> {
  const store = await cookies();
  const value = store.get(LANGUAGE_COOKIE)?.value;
  return isLanguage(value) ? value : DEFAULT_LANGUAGE;
}

/** The translator for the current request. */
export async function getServerT(): Promise<Translator> {
  return createTranslator(await getServerLanguage());
}
