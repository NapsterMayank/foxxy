import type { LanguageCode } from '@/shared/constants/curriculum';

/**
 * STEP 1 OF THE PIPELINE — normalise the query, detect the language.
 *
 * Pure. No I/O, no clock, no database.
 *
 * ===========================================================================
 * WHY THE NORMALISED FORM IS RECORDED SEPARATELY IN THE TRACE.
 *
 * The text sent to the embedding model is NOT the text the student typed, and
 * that difference is the first place a bad answer can come from. A trace that
 * records only the original query cannot distinguish "the student asked a bad
 * question" from "we mangled it before embedding it" — and those have opposite
 * fixes. §8.4's trace therefore carries both, and this function is the only
 * thing that produces the second.
 */

/**
 * The ceiling on what is embedded.
 *
 * Not a safety limit — a COST and QUALITY one. Voyage prices by token, and an
 * essay pasted into the chat box embeds to the centroid of everything in it,
 * which is near nothing in particular. A truncated query is recorded as
 * truncated in the trace rather than silently shortened, because "why did this
 * return nothing" and "the question was 4,000 characters long" belong together.
 */
export const MAX_QUERY_CHARS = 1000;

export interface NormalisedQuery {
  /** Exactly what is embedded and what the full-text query is built from. */
  readonly text: string;
  /** Which text-search configuration the sparse half must use. */
  readonly language: LanguageCode;
  /** True when `MAX_QUERY_CHARS` bit. Recorded in the trace. */
  readonly truncated: boolean;
  /** True when nothing usable is left. The pipeline abstains without calling out. */
  readonly isEmpty: boolean;
}

/**
 * DEVANAGARI, U+0900..U+097F.
 *
 * The detection is deliberately about SCRIPT rather than about language, and
 * the distinction is the whole reason this is three lines rather than a
 * dependency. What the answer actually selects is the Postgres text-search
 * configuration: `'english'` stems and strips English stopwords, which is
 * actively wrong for Devanagari, so Hindi chunks were indexed with `'simple'`
 * (D-040). Script is exactly what that decision turns on.
 *
 * HINGLISH — Hindi written in Latin letters — therefore reads as `'en'` here,
 * and that is correct for this purpose: `'simple'` on Latin text would stop
 * matching English chunks by stem, which is most of the corpus. It is NOT
 * correct as a claim about what language the student is speaking, and nothing
 * downstream may use this value to choose a reply language.
 */
// Built with `new RegExp` from an ASCII escape rather than as a literal
// character class: written literally the range endpoints are two invisible
// combining marks, and a reviewer cannot tell a correct range from a
// mistyped one.
const DEVANAGARI = new RegExp('[\u0900-\u097F]', 'u');

export function detectLanguage(text: string): LanguageCode {
  return DEVANAGARI.test(text) ? 'hi' : 'en';
}

/**
 * Trim, collapse runs of whitespace, and NFKC-normalise.
 *
 * CASE IS PRESERVED. Postgres lower-cases inside `to_tsquery`, and voyage-3 is
 * trained on natural text where capitalisation carries information; folding it
 * here would help neither half and would make the trace disagree with what was
 * actually sent.
 *
 * NFKC rather than NFC because the corpus arrived from four sources: the same
 * Devanagari cluster can be encoded pre-composed or with combining marks, and
 * two byte sequences that render identically must not be two different queries.
 */
export function normaliseQuery(raw: string): NormalisedQuery {
  const collapsed = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const truncated = collapsed.length > MAX_QUERY_CHARS;
  const text = truncated ? collapsed.slice(0, MAX_QUERY_CHARS).trimEnd() : collapsed;

  return {
    text,
    language: detectLanguage(text),
    truncated,
    isEmpty: text.length === 0,
  };
}
