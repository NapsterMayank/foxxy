import { createHash } from 'node:crypto';

/**
 * STEP 6 OF THE PIPELINE — collapse duplicate passages. AFTER fusion, BEFORE
 * truncation.
 *
 * Pure. No I/O.
 *
 * ===========================================================================
 * WHY THIS STEP EXISTS AT ALL: A QUARTER OF THE CORPUS IS DUPLICATED.
 *
 * 1,199 of 4,686 imported chunks are exact text duplicates — the same NCERT
 * passages ingested twice under two `chapter_title` conventions
 * (`'Science - Chapter 10'` and `'The Human Eye and the Colourful World'` are
 * the same Grade 10 chapter). The effective distinct corpus is ~3,487 (D-108).
 * The manual vector probe run during the import returned the same passage TWICE
 * in its top six.
 *
 * With N = 3, that is not cosmetic. Two of the three slots the language model
 * is given can be the same paragraph, so a third of the evidence has been spent
 * saying one thing twice — and the answer looks WELL-GROUNDED while resting on
 * one source. Retrieval also LOOKS better than it is: a duplicate that appears
 * in both halves scores as a strong consensus hit when it is one document
 * counted twice.
 *
 * ===========================================================================
 * THE ORDER OF THE STEPS IS THE DECISION, NOT THE HASHING.
 *
 * BEFORE fusion would deduplicate two lists that have not yet agreed about
 * anything, so a duplicate's rank in the dense half would be decided without
 * reference to the sparse half — and the copy that survives could be the one
 * the other half never saw.
 *
 * AFTER truncation is worse: the top 3 would be cut first and the duplicates
 * removed second, so a query whose top three are all the same passage returns
 * ONE chunk. Retrieval would appear to have a thin corpus, which is exactly
 * D-108's failure mode wearing a different hat.
 *
 * So: fuse, deduplicate, then take N. Every distinct passage that earned a slot
 * gets one.
 *
 * ===========================================================================
 * WHAT COUNTS AS "THE SAME PASSAGE".
 *
 * Normalised text, hashed. NOT the embedding, NOT a similarity threshold.
 * D-108's duplicates are EXACT text; a near-duplicate detector would need a
 * cutoff nobody has measured, and a wrong cutoff silently deletes a genuinely
 * different passage — which is unrecoverable from the result, because the
 * dropped chunk is not in it.
 *
 * The normalisation is deliberately narrow: case-folded, whitespace collapsed,
 * NFKC. Anything wider (stripping punctuation, say) starts merging passages
 * that differ in ways a student would notice.
 */

/** The canonical form two copies of the same passage must agree on. */
export function normaliseChunkText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** SHA-256 of the normalised text. Hex, so it is greppable in a trace. */
export function hashChunkText(text: string): string {
  return createHash('sha256').update(normaliseChunkText(text), 'utf8').digest('hex');
}

export interface DeduplicableCandidate {
  readonly id: string;
  readonly chunkText: string;
  readonly fusedScore: number;
}

export interface DuplicateGroup {
  /** The instance that survived — the highest-scoring one. */
  readonly keptId: string;
  /** Everything collapsed into it, in the order it was encountered. */
  readonly collapsedIds: readonly string[];
  readonly textHash: string;
}

export interface DeduplicationResult<T extends DeduplicableCandidate> {
  readonly kept: T[];
  /**
   * How many candidates were REMOVED — not how many groups had duplicates.
   * Three copies of one passage is two collapsed, and the trace has to say two
   * or the number cannot be reconciled against the candidate count.
   */
  readonly duplicatesCollapsed: number;
  readonly groups: DuplicateGroup[];
}

/**
 * Keeps the highest-scoring instance of each distinct passage.
 *
 * The input is SORTED HERE rather than assumed sorted. The caller does hand
 * fused output in descending order today, but "keep the highest-scoring
 * instance" would then be a property of the caller rather than of this
 * function — and the day someone deduplicates an unsorted list, the wrong copy
 * survives and nothing fails. The sort is stable on ties, so equal scores keep
 * their incoming order.
 */
export function deduplicateByText<T extends DeduplicableCandidate>(
  candidates: readonly T[],
): DeduplicationResult<T> {
  const ordered = [...candidates].sort((a, b) => b.fusedScore - a.fusedScore);

  const kept: T[] = [];
  const byHash = new Map<string, { readonly keptId: string; readonly collapsedIds: string[] }>();

  for (const candidate of ordered) {
    const textHash = hashChunkText(candidate.chunkText);
    const existing = byHash.get(textHash);
    if (existing === undefined) {
      byHash.set(textHash, { keptId: candidate.id, collapsedIds: [] });
      kept.push(candidate);
    } else {
      existing.collapsedIds.push(candidate.id);
    }
  }

  const groups: DuplicateGroup[] = [...byHash.entries()]
    .filter(([, group]) => group.collapsedIds.length > 0)
    .map(([textHash, group]) => ({
      textHash,
      keptId: group.keptId,
      collapsedIds: [...group.collapsedIds],
    }));

  return {
    kept,
    duplicatesCollapsed: candidates.length - kept.length,
    groups,
  };
}
