import type { BilingualTextWire } from '@/lib/api/generated/contracts/parent.contract';
import type { LanguageCode } from '@/lib/i18n/translate';

/**
 * ===========================================================================
 * SERVER PROSE, IN THE READER'S LANGUAGE.
 *
 * Every piece of narrative on the parent wire is `{ en, hi }` and BOTH ARE
 * REQUIRED — `bilingualTextSchema` puts `min(1)` on each. That is P7 made
 * structural: `notify` learned the cost of an optional Hindi field, which is a
 * Hindi field that is empty in production.
 *
 * ---------------------------------------------------------------------------
 * THE FALLBACK IS STILL HERE, AND IT IS NOT DEAD CODE.
 *
 * The schema guarantees a non-empty `hi` for anything that reached
 * `apiRequest` — but this same shape is rendered from fixtures in tests, from a
 * cache written by an older build, and from whatever a future endpoint sends
 * before its own schema is tightened. A blank paragraph where a parent expects
 * a sentence about their child is a worse failure than the same sentence in the
 * wrong language.
 * ===========================================================================
 */
export function bilingual(text: BilingualTextWire, language: LanguageCode): string {
  if (language === 'hi') return text.hi.trim() === '' ? text.en : text.hi;
  return text.en.trim() === '' ? text.hi : text.en;
}
