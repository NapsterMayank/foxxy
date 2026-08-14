/**
 * ===========================================================================
 * AN ISO TIMESTAMP AS A DATE SOMEBODY READS.
 *
 * ---------------------------------------------------------------------------
 * `Intl` WITH THE READER'S LANGUAGE, NEVER `toLocaleDateString()` WITH THE
 * BROWSER'S.
 *
 * The interface language and the device locale are chosen separately by every
 * browser, so a Hindi reader on an en-US phone would get "August 21" in the
 * middle of a Hindi sentence. The language of the interface is the language of
 * its dates.
 *
 * `en-IN`/`hi-IN` rather than `en`/`hi`: the audience is Indian, and `en-US`
 * would render "August 21" where every reader here writes "21 August".
 *
 * ---------------------------------------------------------------------------
 * AN UNPARSEABLE VALUE IS RETURNED AS IT CAME.
 *
 * `new Date('nonsense')` is `Invalid Date` and `Intl` renders it as the literal
 * string "Invalid Date" — an English phrase, untranslated, in front of a child.
 * Returning the original at least fails as obviously wrong data rather than as
 * a sentence the interface appears to have chosen.
 * ===========================================================================
 */
export function formatDayAndMonth(iso: string, language: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  return new Intl.DateTimeFormat(language === 'hi' ? 'hi-IN' : 'en-IN', {
    day: 'numeric',
    month: 'long',
  }).format(parsed);
}
