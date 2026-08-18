import type { ChapterProgress } from '@/lib/api/generated/contracts/practice.contract';

/**
 * ===========================================================================
 * WHERE THE STUDENT LEFT OFF.
 *
 * The most recently practised chapter, or `null`. `lastPractisedAt` is
 * nullable per chapter — every chapter of a subject appears in the ledger from
 * the moment the subject does, whether or not it has ever been opened — so
 * "the first chapter in the list" is not an answer, and neither is "the one
 * with the most attempts".
 *
 * TIES ARE BROKEN BY ORDER, NOT LEFT TO CHANCE. Two chapters can share a
 * timestamp (the same submission second, in a seeded database, more often than
 * in life). `>` keeps the FIRST of them rather than the last, so the sentence
 * on the dashboard does not change between two renders of identical data.
 * ===========================================================================
 */
export function lastPractised(
  chapters: readonly ChapterProgress[],
): ChapterProgress | null {
  let latest: ChapterProgress | null = null;

  for (const chapter of chapters) {
    if (chapter.lastPractisedAt === null) continue;
    if (latest === null || chapter.lastPractisedAt > (latest.lastPractisedAt as string)) {
      latest = chapter;
    }
  }

  return latest;
}
