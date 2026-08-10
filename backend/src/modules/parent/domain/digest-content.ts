import type { BilingualText } from '@/platform/notify-channel/index';
import {
  improvedChapters,
  pickMisconception,
  strugglingChapters,
  type ChapterWeek,
  type DigestEvidence,
  type MisconceptionSighting,
} from './digest-evidence';

/**
 * THE WEEKLY DIGEST — five lines, a named misconception where one exists, and
 * one concrete action.
 *
 * ===========================================================================
 * THIS FILE IS THE PRODUCT. §8.7, stated exactly:
 *
 *   "She is confusing mass with weight — ask her which one changes on the
 *    Moon" is useful to a parent; "60 percent in Science" is not.
 *
 * So: NEVER A PERCENTAGE, never a score, never a mastery figure, never a
 * ranking against other children. `assertDigestIsHonest` refuses a draft that
 * contains one, and it refuses drafts from this composer as readily as from a
 * language model — see the note there about why the gate is not "for the LLM".
 * ===========================================================================
 *
 * ===========================================================================
 * MOST WEEKS WILL HAVE NO MISCONCEPTION, AND THAT IS SAID OUT LOUD RATHER THAN
 * PAPERED OVER.
 *
 * `questions.distractor_misconceptions` is NULL corpus-wide (D-077), so
 * `evidence.misconceptions` is empty for essentially every real week today.
 * The composer handles it the way `practice`'s hint ladder handles its own
 * missing content (D-115): it DEGRADES — it says what improved instead, and it
 * says plainly that no specific mix-up was spotted.
 *
 * It never invents one. A fabricated misconception is worse than none at all,
 * because a parent cannot tell it apart from a real one and will act on it —
 * and the action they take is to correct a child who was not making that
 * mistake.
 * ===========================================================================
 *
 * NO NAMES. The digest says "your child", never the child's name. Two reasons,
 * and the second is the load-bearing one: the same text is persisted through
 * `notify`'s payload and is the text a real LLM adapter would be asked to
 * write, and `platform/llm`'s port is explicit that the model "must NEVER see a
 * name, an email address, a phone number, or an account identifier". A digest
 * that carries a name cannot be handed to the writer port at all.
 *
 * Pure: no I/O, no clock (`weekStart` arrives on the evidence), no randomness.
 */

/** Exactly five lines. §8.7 says five; a test asserts five. */
export const DIGEST_LINE_COUNT = 5;

/** What any digest writer must produce — the deterministic one and, later, the model. */
export interface DigestDraft {
  /** Exactly `DIGEST_LINE_COUNT` lines, both languages, in order. */
  readonly lines: readonly BilingualText[];
  /**
   * The code of the misconception this digest names, or null when none was
   * observed. NULL IS THE COMMON CASE and it is honest (D-077).
   */
  readonly misconceptionCode: string | null;
  readonly suggestedAction: BilingualText;
}

function chapterTitle(chapter: ChapterWeek): BilingualText {
  return chapter.title;
}

/** Line 1 — effort, in counts a parent can picture. */
function effortLine(evidence: DigestEvidence): BilingualText {
  const { activity } = evidence;
  if (activity.sessions === 0) {
    return {
      en: 'Your child did not finish a practice session this week.',
      hi: 'आपके बच्चे ने इस सप्ताह कोई अभ्यास सत्र पूरा नहीं किया।',
    };
  }
  return {
    en:
      `Your child practised on ${activity.daysPractised} ` +
      `${activity.daysPractised === 1 ? 'day' : 'days'} and answered ` +
      `${activity.questionsAnswered} questions.`,
    hi:
      `आपके बच्चे ने ${activity.daysPractised} दिन अभ्यास किया और ` +
      `${activity.questionsAnswered} प्रश्न हल किए।`,
  };
}

/** Line 2 — what went well. Named from a chapter, or honestly absent. */
function wentWellLine(evidence: DigestEvidence, improved: readonly ChapterWeek[]): BilingualText {
  const best = improved[0];
  if (best !== undefined) {
    const title = chapterTitle(best);
    return {
      en: `They got noticeably better at ${title.en}.`,
      hi: `${title.hi} में उनका प्रदर्शन साफ़ तौर पर बेहतर हुआ।`,
    };
  }

  if (evidence.recoveries > 0) {
    // A REAL, MEASURED THING that is easy to overlook: changing a wrong first
    // answer to a right one is the skill, not the score.
    return {
      en:
        `They changed their mind and got the answer right ${evidence.recoveries} ` +
        `${evidence.recoveries === 1 ? 'time' : 'times'} — that is them checking their own work.`,
      hi:
        `${evidence.recoveries} बार उन्होंने अपना पहला उत्तर बदलकर सही उत्तर चुना — ` +
        `यह अपनी ग़लती ख़ुद पकड़ना है।`,
    };
  }

  const steady = evidence.chapters[0];
  if (steady !== undefined) {
    const title = chapterTitle(steady);
    return {
      en: `They kept working on ${title.en} this week.`,
      hi: `इस सप्ताह उन्होंने ${title.hi} पर काम जारी रखा।`,
    };
  }

  // NOTHING HAPPENED. Said so, rather than reaching for encouragement that is
  // not supported by a row.
  return {
    en: 'There is nothing new from this week to report.',
    hi: 'इस सप्ताह की कोई नई बात बताने को नहीं है।',
  };
}

/** Line 3 — where it is hard. */
function hardLine(evidence: DigestEvidence, struggling: readonly ChapterWeek[]): BilingualText {
  if (evidence.activity.sessions === 0) {
    return {
      en: 'Without a session this week we cannot say what is giving them trouble.',
      hi: 'इस सप्ताह कोई सत्र न होने से यह नहीं कहा जा सकता कि उन्हें क्या कठिन लग रहा है।',
    };
  }

  const hardest = struggling[0];
  if (hardest !== undefined) {
    const title = chapterTitle(hardest);
    return {
      en: `${title.en} is still hard going.`,
      hi: `${title.hi} अब भी कठिन लग रहा है।`,
    };
  }

  return {
    en: 'Nothing looked especially hard this week.',
    hi: 'इस सप्ताह कुछ भी ख़ास कठिन नहीं दिखा।',
  };
}

/**
 * Line 4 — THE DIAGNOSIS, or the honest substitute.
 *
 * This is the line §8.7 is about, and it is also the line most likely to be
 * "improved" into a lie. The `null` branch does NOT guess at a misconception
 * from a low score: a low score says a child got questions wrong, and which
 * wrong idea produced them is exactly the thing the data does not contain
 * (D-077).
 */
function diagnosisLine(
  misconception: MisconceptionSighting | null,
  improved: readonly ChapterWeek[],
  evidence: DigestEvidence,
): BilingualText {
  if (misconception !== null) {
    return {
      en: `They are mixing up ${misconception.description} in ${misconception.chapterTitle.en}.`,
      hi:
        `${misconception.chapterTitle.hi} में वे ` +
        `${misconception.descriptionHi ?? misconception.description} को लेकर गड़बड़ा रहे हैं।`,
    };
  }

  const best = improved[0];
  if (best !== undefined) {
    return {
      en:
        `We have not spotted a specific mix-up this week, so here is what moved instead: ` +
        `${chapterTitle(best).en}.`,
      hi:
        `इस सप्ताह कोई ख़ास ग़लतफ़हमी नहीं पकड़ी गई, इसलिए जो बेहतर हुआ वह यह है: ` +
        `${chapterTitle(best).hi}।`,
    };
  }

  if (evidence.hintsUsed > 0) {
    return {
      en:
        `We have not spotted a specific mix-up this week. They asked for ` +
        `${evidence.hintsUsed} ${evidence.hintsUsed === 1 ? 'hint' : 'hints'}, which is the ` +
        `right thing to do when stuck.`,
      hi:
        `इस सप्ताह कोई ख़ास ग़लतफ़हमी नहीं पकड़ी गई। उन्होंने ${evidence.hintsUsed} बार संकेत ` +
        `माँगा, जो अटकने पर करने की सही बात है।`,
    };
  }

  return {
    en: 'We have not spotted a specific mix-up this week.',
    hi: 'इस सप्ताह कोई ख़ास ग़लतफ़हमी नहीं पकड़ी गई।',
  };
}

/**
 * Line 5 — ONE CONCRETE ACTION.
 *
 * One, and it must be doable this evening without a worksheet, a login or a
 * printer. "Support their learning journey" is not an action; "ask them which
 * one changes on the Moon" is.
 */
function actionOf(
  misconception: MisconceptionSighting | null,
  struggling: readonly ChapterWeek[],
  evidence: DigestEvidence,
): BilingualText {
  if (misconception !== null) {
    return {
      en:
        `Ask them to explain ${misconception.description} to you in their own words — ` +
        `the mix-up will show up in the first sentence.`,
      hi:
        `उनसे कहिए कि ${misconception.descriptionHi ?? misconception.description} को अपने ` +
        `शब्दों में समझाएँ — पहली ही पंक्ति में गड़बड़ी दिख जाएगी।`,
    };
  }

  const hardest = struggling[0];
  if (hardest !== undefined) {
    const title = chapterTitle(hardest);
    return {
      en: `Sit with them for ten minutes on ${title.en} and ask them to talk one question through out loud.`,
      hi: `${title.hi} पर दस मिनट उनके साथ बैठिए और एक प्रश्न बोल-बोलकर हल करवाइए।`,
    };
  }

  if (evidence.activity.sessions === 0) {
    return {
      en: 'Pick one ten-minute slot with them this week — the same time each day is what makes it stick.',
      hi: 'इस सप्ताह उनके साथ दस मिनट का एक समय तय कीजिए — रोज़ एक ही समय होने से आदत बनती है।',
    };
  }

  const talkAbout = evidence.chapters[0];
  if (talkAbout !== undefined) {
    const title = chapterTitle(talkAbout);
    return {
      en: `Ask them to teach you the trickiest thing they met in ${title.en} this week.`,
      hi: `उनसे कहिए कि इस सप्ताह ${title.hi} में जो सबसे मुश्किल बात मिली, वह आपको सिखाएँ।`,
    };
  }

  return {
    en: 'Ask them what they would like to start with this week, and put it in the calendar together.',
    hi: 'उनसे पूछिए कि इस सप्ताह वे किससे शुरू करना चाहेंगे, और उसे साथ मिलकर तय कीजिए।',
  };
}

/**
 * Composes the digest from evidence, deterministically.
 *
 * THE SAME EVIDENCE ALWAYS PRODUCES THE SAME FIVE LINES. That is not a
 * nice-to-have: `generateDigest` is idempotent per (parent, child, week), and
 * a composer whose output wandered would make "the second run changed nothing"
 * impossible to assert.
 */
export function composeDigest(evidence: DigestEvidence): DigestDraft {
  const improved = improvedChapters(evidence.chapters);
  const struggling = strugglingChapters(evidence.chapters);
  const misconception = pickMisconception(evidence.misconceptions);

  return {
    lines: [
      effortLine(evidence),
      wentWellLine(evidence, improved),
      hardLine(evidence, struggling),
      diagnosisLine(misconception, improved, evidence),
      actionOf(misconception, struggling, evidence),
    ],
    misconceptionCode: misconception?.code ?? null,
    suggestedAction: actionOf(misconception, struggling, evidence),
  };
}
