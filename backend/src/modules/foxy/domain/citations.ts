/**
 * CITATION EXTRACTION AND VERIFICATION.
 *
 * ===========================================================================
 * "THAT VERIFICATION STEP IS THE DIFFERENCE BETWEEN A CITATION AND A
 * DECORATION. A LANGUAGE MODEL WILL HAPPILY INVENT A PAGE NUMBER." — plan §8.5.
 *
 * The model is asked to mark every claim with `[chunk:<id>]`, where `<id>` is
 * the identifier of one of the passages it was given. Two things then happen,
 * and the ORDER of them is the whole design:
 *
 *   1. The marker is REMOVED from the text before the text reaches the student.
 *      A citation is structured data on the message, not punctuation in the
 *      prose — the client renders it as a chapter reference, not as `[chunk:7f…]`.
 *   2. The id is checked against the set of ids that were ACTUALLY RETRIEVED for
 *      this turn. An id that was not retrieved is DROPPED, and recorded on the
 *      trace as fabricated. It never becomes a citation on the message, and it
 *      never reaches the client.
 *
 * ===========================================================================
 * WHY THE ID AND NOT AN INDEX.
 *
 * `[chunk:1]` would be easier for the model to produce and is exactly what makes
 * verification worthless: with three passages in the prompt, a model that
 * invents an index is right by accident a third of the time. A fabricated UUID
 * is fabricated with certainty, so the check has no lucky path.
 *
 * ===========================================================================
 * WHY THIS IS ALSO A STREAM FILTER, AND NOT ONLY A POST-PROCESSOR.
 *
 * The answer is STREAMED. If the raw tokens are forwarded and the citations
 * verified at the end, then a fabricated marker has already been shown to the
 * student — "stripped before the response is sent" would be false, in the one
 * place it is most load-bearing. So the filter is INCREMENTAL: it withholds any
 * trailing text that could still turn out to be the start of a marker, emits
 * everything else immediately, and resolves each marker the moment it closes.
 *
 * The cost is a few characters of latency at a `[`. That is the correct trade:
 * the alternative is showing a child a citation that does not exist.
 * ===========================================================================
 */

/** The marker the model is instructed to emit. */
export const CITATION_OPEN = '[chunk:';
const CITATION_CLOSE = ']';

/**
 * The longest id this will wait for before giving up and treating the text as
 * ordinary prose.
 *
 * WITHOUT THIS, A SINGLE `[chunk:` WITH NO CLOSING BRACKET SWALLOWS THE REST OF
 * THE ANSWER. The student sees the response stop mid-sentence and never resume,
 * with no error anywhere — the worst failure shape there is. A UUID is 36
 * characters; 80 is generous and finite.
 */
export const MAX_CITATION_ID_CHARS = 80;

export interface Citation {
  readonly chunkId: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
}

/** The minimum a chunk must expose to become a citation. */
export interface CitableChunk {
  readonly id: string;
  readonly chapterNumber: number | null;
  readonly chapterTitle: string | null;
}

export interface FilterOutput {
  /** Text safe to send to the student. Never contains a marker or part of one. */
  readonly text: string;
  /** Citations resolved in this step, in first-seen order, deduplicated. */
  readonly citations: readonly Citation[];
  /** Ids the model cited that were never retrieved. Recorded, never shown. */
  readonly fabricated: readonly string[];
}

const EMPTY: FilterOutput = Object.freeze({
  text: '',
  citations: Object.freeze([]),
  fabricated: Object.freeze([]),
});

export interface CitationFilter {
  /** Feeds one streamed chunk in and gets back what is safe to emit. */
  push(chunk: string): FilterOutput;
  /**
   * Ends the stream.
   *
   * Any text still held back — an unterminated `[chunk:` — is RELEASED AS
   * ORDINARY TEXT rather than discarded. Discarding it would silently truncate
   * an answer whose only sin was a bracket, and the student would have no way
   * to know a sentence went missing.
   */
  flush(): FilterOutput;
  /** Every citation resolved so far, deduplicated, in first-seen order. */
  citations(): readonly Citation[];
  /** Every fabricated id seen so far, deduplicated. */
  fabricated(): readonly string[];
}

/**
 * Builds the filter for ONE turn, bound to the chunks that turn retrieved.
 *
 * The allowed set is passed in rather than looked up, because the only correct
 * answer to "was this chunk retrieved" is "was it retrieved FOR THIS TURN". A
 * filter that could consult the corpus would happily verify a citation to a
 * passage the model was never shown, which is a fabrication that passes.
 */
export function createCitationFilter(chunks: readonly CitableChunk[]): CitationFilter {
  const byId = new Map<string, CitableChunk>(chunks.map((chunk) => [chunk.id, chunk]));
  const seenCitations = new Map<string, Citation>();
  const seenFabricated = new Set<string>();

  /** Text held back because it might be the beginning of a marker. */
  let pending = '';

  function resolve(rawId: string): { citation?: Citation; fabricated?: string } {
    const id = rawId.trim();
    const chunk = byId.get(id);
    if (chunk === undefined) {
      // THE FABRICATION BRANCH. Recorded, never emitted, never shown.
      if (id.length > 0) seenFabricated.add(id);
      return { fabricated: id };
    }
    const citation: Citation = {
      chunkId: chunk.id,
      chapterNumber: chunk.chapterNumber,
      chapterTitle: chunk.chapterTitle,
    };
    if (!seenCitations.has(chunk.id)) seenCitations.set(chunk.id, citation);
    return { citation };
  }

  /**
   * How much of the tail could still be the start of `[chunk:`.
   *
   * Held back so that a marker split across two streamed chunks — which is the
   * normal case, not the edge case, because a model emits a few characters at a
   * time — is not emitted as literal text before its other half arrives.
   */
  function unsafeTailLength(text: string): number {
    const maximum = Math.min(CITATION_OPEN.length - 1, text.length);
    for (let length = maximum; length > 0; length -= 1) {
      if (CITATION_OPEN.startsWith(text.slice(text.length - length))) return length;
    }
    return 0;
  }

  function drain(): FilterOutput {
    let emitted = '';
    const citations: Citation[] = [];
    const fabricated: string[] = [];

    for (;;) {
      const open = pending.indexOf(CITATION_OPEN);
      if (open === -1) {
        // No marker in flight. Emit everything except a tail that could still
        // be the first characters of one.
        const hold = unsafeTailLength(pending);
        emitted += pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        break;
      }

      // Everything BEFORE the marker is ordinary prose and goes out now. It
      // must not wait for the marker to close: a model that opens a citation
      // and pauses would otherwise stall the sentence in front of it.
      emitted += pending.slice(0, open);
      pending = pending.slice(open);

      const close = pending.indexOf(CITATION_CLOSE, CITATION_OPEN.length);
      if (close === -1) {
        // Not closed yet. If it has already run past any plausible id length it
        // is not a marker at all — release the literal opener and keep scanning,
        // rather than swallowing the rest of the answer (MAX_CITATION_ID_CHARS).
        if (pending.length - CITATION_OPEN.length > MAX_CITATION_ID_CHARS) {
          emitted += pending.slice(0, CITATION_OPEN.length);
          pending = pending.slice(CITATION_OPEN.length);
          continue;
        }
        break;
      }

      const rawId = pending.slice(CITATION_OPEN.length, close);
      pending = pending.slice(close + CITATION_CLOSE.length);

      const resolved = resolve(rawId);
      if (resolved.citation !== undefined) {
        const found = resolved.citation;
        if (!citations.some((existing) => existing.chunkId === found.chunkId)) {
          citations.push(found);
        }
      } else if (resolved.fabricated !== undefined && resolved.fabricated.length > 0) {
        if (!fabricated.includes(resolved.fabricated)) fabricated.push(resolved.fabricated);
      }
    }

    return { text: emitted, citations, fabricated };
  }

  return {
    push(chunk: string): FilterOutput {
      if (chunk.length === 0) return EMPTY;
      pending += chunk;
      return drain();
    },

    flush(): FilterOutput {
      const drained = drain();
      // Whatever is left is prose, including an unterminated marker. Released,
      // never discarded — see the note on `flush` above.
      const remainder = pending;
      pending = '';
      return {
        text: drained.text + remainder,
        citations: drained.citations,
        fabricated: drained.fabricated,
      };
    },

    citations(): readonly Citation[] {
      return [...seenCitations.values()];
    },

    fabricated(): readonly string[] {
      return [...seenFabricated];
    },
  };
}

/**
 * The whole-string form, for a non-streamed answer and for tests that care
 * about the result rather than the arrival.
 *
 * Built ON the filter rather than beside it. A second implementation of the
 * same rule is a second implementation that drifts — and the one that drifts is
 * always the one not currently being worked on.
 */
export function verifyCitations(
  text: string,
  chunks: readonly CitableChunk[],
): { readonly text: string; readonly citations: readonly Citation[]; readonly fabricated: readonly string[] } {
  const filter = createCitationFilter(chunks);
  const first = filter.push(text);
  const last = filter.flush();
  return {
    text: first.text + last.text,
    citations: filter.citations(),
    fabricated: filter.fabricated(),
  };
}
