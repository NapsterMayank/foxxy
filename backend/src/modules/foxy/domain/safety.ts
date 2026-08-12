import type { LanguageCode } from '@/shared/constants/curriculum';
import { MAX_QUESTION_CHARS } from '@/shared/constants/foxy';

/**
 * THE SAFETY CLASSIFIER — it runs BEFORE the model, and that ordering is the
 * whole of its value.
 *
 * ===========================================================================
 * WHY BEFORE, AND NOT AFTER.
 *
 * A classifier that inspects the model's OUTPUT is a filter; a classifier that
 * inspects the INPUT is a boundary. The difference matters for three separate
 * reasons, and the third is the one that decided it:
 *
 *  1. An input the product will not answer costs nothing if it never reaches
 *     the model. Filtering afterwards pays for the tokens either way.
 *  2. A refusal composed here is written by us, in both languages, and reads the
 *     same every time. A refusal composed by the model is whatever the model
 *     said today.
 *  3. THE HARM CASE. A child asking about self-harm must be answered by a fixed
 *     sentence pointing at a trusted adult — not by a language model improvising
 *     under a tutoring persona. That is not a filtering problem and it must
 *     never depend on a model behaving well.
 *
 * ===========================================================================
 * IT IS DELIBERATELY BLUNT, AND ITS FAILURE MODE IS DELIBERATELY CHOSEN.
 *
 * This is keyword and pattern matching, not a model. It WILL let some off-scope
 * input through — that is what the grounding does next: an off-syllabus question
 * retrieves nothing above the threshold and ABSTAINS, which is the second lock
 * on the same door and the one that catches everything subtle.
 *
 * So this classifier is tuned to catch the things abstention cannot catch —
 * harm, adult content, and requests for personal contact — and to be reluctant
 * elsewhere. A false positive here is worse than it sounds: a child asked a
 * legitimate biology question about reproduction, which IS in the CBSE syllabus,
 * and was refused. Every list below was written with that specific student in
 * mind.
 * ===========================================================================
 *
 * NO PII IS EVER LOGGED FROM HERE. The verdict carries a CATEGORY and never the
 * text that triggered it (P13, and `platform/pii`'s header). The text is the
 * one thing that would make this useful to tune and the one thing that would
 * turn a safety log into a transcript of what children ask when frightened.
 */

/** Why an input was refused. A closed set, so a caller cannot invent a reason. */
export const SAFETY_CATEGORIES = ['harm', 'adult', 'personal_contact', 'empty'] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export interface SafetyVerdict {
  readonly allowed: boolean;
  /** Present only on a refusal. Never carries the input text. */
  readonly category?: SafetyCategory;
}

export interface BilingualMessage {
  readonly en: string;
  readonly hi: string;
}

/**
 * Re-exported so this file reads completely on its own.
 *
 * The VALUE lives in `shared/constants/foxy.ts` because the Zod contract — which
 * the frontend imports — applies the same limit, and two copies of a limit are
 * two limits that eventually disagree.
 */
export { MAX_QUESTION_CHARS };

/**
 * Patterns matched against the NORMALISED input (lowercased, punctuation
 * collapsed). Word-boundary anchored, because unanchored substrings are how a
 * classifier refuses "class", "assessment" and "Scunthorpe".
 */
const HARM_PATTERNS: readonly RegExp[] = [
  /\bkill (?:myself|me)\b/u,
  /\bsuicide\b/u,
  /\bself[ -]?harm\b/u,
  /\bcut myself\b/u,
  /\bend my life\b/u,
  /\bhow to make a bomb\b/u,
  /\bhow to make (?:a )?(?:gun|explosive)s?\b/u,
  /\bhurt (?:someone|somebody|him|her|them)\b/u,
];

const ADULT_PATTERNS: readonly RegExp[] = [
  /\bporn\b/u,
  /\bpornography\b/u,
  /\bnude\b/u,
  /\bsexy\b/u,
  /\bsext\b/u,
];

/**
 * Requests to move the conversation off the platform, or to hand over contact
 * details. Refused in BOTH directions — a student asking for Foxy's phone
 * number and a student offering their own are the same failure.
 */
const PERSONAL_CONTACT_PATTERNS: readonly RegExp[] = [
  /\b(?:whatsapp|telegram|instagram|snapchat)\b/u,
  /\b(?:your|ur) (?:phone|mobile|number|address|email)\b/u,
  /\bmeet me\b/u,
  /\bmy (?:phone number|mobile number|home address)\b/u,
];

/** Lowercase, collapse whitespace, strip most punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Classifies one student input.
 *
 * PURE, and takes no clock, no logger and no config. It is the single most
 * security-relevant function in this module and it must be exhaustively testable
 * with a table of strings.
 */
export function classifyInput(text: string): SafetyVerdict {
  const normalised = normalise(text);
  if (normalised.length === 0 || text.length > MAX_QUESTION_CHARS) {
    return { allowed: false, category: 'empty' };
  }
  // HARM IS CHECKED FIRST. An input matching both harm and adult patterns is a
  // harm case, and the harm response is the one that points at a trusted adult.
  if (HARM_PATTERNS.some((pattern) => pattern.test(normalised))) {
    return { allowed: false, category: 'harm' };
  }
  if (ADULT_PATTERNS.some((pattern) => pattern.test(normalised))) {
    return { allowed: false, category: 'adult' };
  }
  if (PERSONAL_CONTACT_PATTERNS.some((pattern) => pattern.test(normalised))) {
    return { allowed: false, category: 'personal_contact' };
  }
  return { allowed: true };
}

/**
 * WHAT THE STUDENT IS TOLD, VERBATIM, IN BOTH LANGUAGES.
 *
 * Fixed strings rather than generated text. A refusal is the moment the product
 * is least able to afford improvisation, and a child reading two different
 * refusals for the same thing on two days learns that the rule is arbitrary.
 *
 * THE `harm` MESSAGE NAMES A REAL, FREE, INDIAN HELPLINE. Tele-MANAS is the
 * Government of India's national mental-health helpline (14416), which is
 * reachable at no cost from any Indian number. A refusal that says only "I
 * cannot help with that" to a child who has just said they want to hurt
 * themselves is worse than no product at all.
 */
const REFUSALS: Readonly<Record<SafetyCategory, BilingualMessage>> = Object.freeze({
  harm: {
    en:
      'I am not the right one to help with this, and I do not want you to be alone with it. ' +
      'Please talk to a parent, a teacher, or any adult you trust — today. In India you can ' +
      'also call Tele-MANAS free on 14416, at any hour. I will be here for your studies when ' +
      'you come back.',
    hi:
      'इसमें मैं तुम्हारी सही मदद नहीं कर सकता, और मैं नहीं चाहता कि तुम इसे अकेले झेलो। ' +
      'कृपया आज ही अपने माता-पिता, किसी शिक्षक, या किसी भी भरोसेमंद बड़े व्यक्ति से बात करो। ' +
      'भारत में तुम किसी भी समय Tele-MANAS को 14416 पर मुफ़्त कॉल भी कर सकते हो। ' +
      'तुम्हारी पढ़ाई के लिए मैं यहीं रहूँगा।',
  },
  adult: {
    en: 'I can only help with your CBSE school subjects. Let us go back to your chapter.',
    hi: 'मैं सिर्फ़ तुम्हारे CBSE स्कूल विषयों में मदद कर सकता हूँ। चलो अपने अध्याय पर वापस चलते हैं।',
  },
  personal_contact: {
    en:
      'I am an AI study helper inside Alfanumrik, so I have no phone number and we cannot talk ' +
      'anywhere else. Please never share your own contact details here either. Shall we ' +
      'continue with your chapter?',
    hi:
      'मैं Alfanumrik के अंदर एक AI पढ़ाई सहायक हूँ, इसलिए मेरा कोई फ़ोन नंबर नहीं है और हम कहीं ' +
      'और बात नहीं कर सकते। कृपया अपनी संपर्क जानकारी भी यहाँ कभी साझा मत करो। ' +
      'क्या हम अध्याय जारी रखें?',
  },
  empty: {
    en: 'I did not catch a question there. Try typing it again, a little shorter.',
    hi: 'मुझे वहाँ कोई सवाल नहीं मिला। इसे थोड़ा छोटा करके फिर से लिखो।',
  },
});

export function refusalMessage(category: SafetyCategory, language: LanguageCode): string {
  return REFUSALS[category][language];
}

/** Both languages at once, for a caller that stores the pair. */
export function refusalMessages(category: SafetyCategory): BilingualMessage {
  return REFUSALS[category];
}
