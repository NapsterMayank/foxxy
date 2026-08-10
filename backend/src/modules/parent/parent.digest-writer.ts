import { DependencyError } from '@/platform/errors/index';
import type { LlmProvider } from '@/platform/llm/index';
import type { BilingualText } from '@/platform/notify-channel/index';
import { DIGEST_LINE_COUNT, composeDigest, type DigestDraft } from './domain/digest-content';
import { improvedChapters, strugglingChapters, type DigestEvidence } from './domain/digest-evidence';

/**
 * THE DIGEST WRITER PORT — one interface, two adapters, and a gate neither can
 * get past.
 *
 * ===========================================================================
 * WHY A PORT WHEN THERE IS NO MODEL YET.
 *
 * `platform/llm` is an INTERFACE with no adapter (build step 7) and there is no
 * API key. The tempting shape is "write the digest with string templates now,
 * swap in the model later", and the reason that shape is wrong is not
 * aesthetic: the swap would land in the middle of the SERVICE, so everything
 * around it — the evidence assembly, the honesty gate, the persistence, the
 * idempotence — would be re-tested on the day the model arrives, which is the
 * day nobody has time to re-test anything.
 *
 * With the port, the whole pipeline is exercised today by
 * `createEvidenceDigestWriter`, and swapping in a model is ONE argument at the
 * composition root. `createLlmDigestWriter` below is already written and
 * already tested against a fake `LlmProvider`, so "changing one adapter" is a
 * demonstrated claim rather than an intention.
 * ===========================================================================
 *
 * ===========================================================================
 * NEITHER ADAPTER IS TRUSTED. `checkDigestHonesty` runs on the output of BOTH,
 * in the service, and refuses a percentage or an unobserved misconception
 * whoever wrote it. See the header of `domain/digest-honesty.ts` for why that
 * is not "the LLM check".
 * ===========================================================================
 */

export interface DigestWriter {
  /** The adapter's name, for logs and metrics. Never a model identifier. */
  readonly kind: 'evidence' | 'llm';
  write(evidence: DigestEvidence): Promise<DigestDraft>;
}

/**
 * THE DEFAULT — composes the digest from the evidence, deterministically.
 *
 * Not a placeholder. It reads real rows, names a real misconception when one
 * was observed, and says what improved when none was (D-077). A model would
 * write more fluently; it would not know anything this does not.
 */
export function createEvidenceDigestWriter(): DigestWriter {
  return {
    kind: 'evidence',
    write(evidence: DigestEvidence): Promise<DigestDraft> {
      return Promise.resolve(composeDigest(evidence));
    },
  };
}

/**
 * THE PROMPT'S FACTS — what a model is allowed to be told.
 *
 * COUNTS AND CHAPTER TITLES ONLY. No name, no email, no user id, no session id.
 * `platform/llm`'s port states the rule and this is where it is obeyed: "It may
 * see the student's question and the retrieved passages. It must NEVER see a
 * name, an email address, a phone number, or an account identifier."
 *
 * Chapter titles are CBSE curriculum, identical for every child in the country,
 * and are not identifying.
 */
export function digestFacts(evidence: DigestEvidence): string {
  const improved = improvedChapters(evidence.chapters);
  const struggling = strugglingChapters(evidence.chapters);
  const misconception = evidence.misconceptions[0];

  const lines = [
    `days_practised: ${evidence.activity.daysPractised}`,
    `sessions_finished: ${evidence.activity.sessions}`,
    `questions_answered: ${evidence.activity.questionsAnswered}`,
    `chapters_worked_on: ${evidence.activity.chaptersTouched}`,
    `answers_corrected_by_the_child: ${evidence.recoveries}`,
    `hints_asked_for: ${evidence.hintsUsed}`,
    `chapters_that_improved: ${improved.map((c) => c.title.en).join(', ') || 'none'}`,
    `chapters_still_hard: ${struggling.map((c) => c.title.en).join(', ') || 'none'}`,
    misconception === undefined
      ? 'observed_misconception: none'
      : `observed_misconception: ${misconception.code} (${misconception.description}) in ${misconception.chapterTitle.en}`,
  ];
  return lines.join('\n');
}

const SYSTEM_PROMPT = [
  'You write a five-line weekly note from a tutoring app to an Indian parent of a school child.',
  'RULES, all of them absolute:',
  '- Never state a percentage, a score, a mark or an "N out of M".',
  '- Never use education jargon: mastery, percentile, Bloom, IRT, cognitive.',
  '- Never invent a misconception. Name one ONLY if observed_misconception is not "none".',
  '- Never invent any fact that is not in the facts below.',
  '- Refer to the child as "your child". You do not know their name.',
  '- Line 5 is one concrete action a parent can do this evening without a printer.',
  'Answer in EXACTLY this format, with no other text:',
  'EN1: .. EN5:, HI1: .. HI5: (Hindi, Devanagari), ACTION_EN:, ACTION_HI:, MISCONCEPTION: <code or NONE>',
].join('\n');

/** How many tokens a five-line note in two languages can possibly need. */
const DIGEST_MAX_TOKENS = 700;

function readField(fields: ReadonlyMap<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value.trim().length === 0) {
    // A DependencyError, not an InternalError: the model is an external system
    // and a malformed completion is that system failing, not this one. The
    // caller falls back or fails loudly; it never stores a half-parsed digest.
    throw new DependencyError('llm', {
      message: `parent.digest-writer: the model omitted ${key}`,
    });
  }
  return value.trim();
}

/**
 * Parses the strict format above.
 *
 * STRICT ON PURPOSE. A lenient parser that "does its best" with a malformed
 * completion is how three of the five lines end up empty and the fourth ends up
 * being the model apologising. Anything unexpected is a `DependencyError`.
 */
export function parseDigestCompletion(text: string): DigestDraft {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+[0-9]*)\s*:\s*(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) fields.set(match[1], match[2] ?? '');
  }

  const lines: BilingualText[] = [];
  for (let index = 1; index <= DIGEST_LINE_COUNT; index += 1) {
    lines.push({ en: readField(fields, `EN${index}`), hi: readField(fields, `HI${index}`) });
  }

  const rawCode = fields.get('MISCONCEPTION')?.trim() ?? 'NONE';

  return {
    lines,
    suggestedAction: {
      en: readField(fields, 'ACTION_EN'),
      hi: readField(fields, 'ACTION_HI'),
    },
    misconceptionCode: rawCode === '' || rawCode.toUpperCase() === 'NONE' ? null : rawCode,
  };
}

/**
 * THE ADAPTER THAT SWAPS IN A REAL MODEL.
 *
 * One argument at the composition root — `writer: createLlmDigestWriter(llm)` —
 * and nothing else in this module changes. The honesty gate in the service
 * still refuses a percentage or an invented misconception, so the worst a bad
 * model can do is fail loudly.
 */
export function createLlmDigestWriter(llm: LlmProvider): DigestWriter {
  return {
    kind: 'llm',
    async write(evidence: DigestEvidence): Promise<DigestDraft> {
      const completion = await llm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: digestFacts(evidence) },
        ],
        maxTokens: DIGEST_MAX_TOKENS,
        // Deterministic: the same week must produce the same digest, because
        // `generateDigest` is idempotent per (parent, child, week) and a second
        // run that produced different words would make "nothing changed"
        // impossible to assert.
        temperature: 0,
      });
      return parseDigestCompletion(completion.text);
    },
  };
}
