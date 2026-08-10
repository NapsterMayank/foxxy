import type {
  ChapterNodeId,
  ConceptCode,
  LearningPathResult,
} from './domain/chapter-graph';

/**
 * `knowledge` — the shapes crossing the module boundary.
 *
 * THE NAMING IS THE CONTRACT. `ConceptCode` is a handle into `concept_graph` and
 * reaches nothing else; `ChapterDescriptor` is what a student can actually be
 * shown, because `chapter_id` is the only key that reaches content. A learning
 * path is a list of CHAPTERS and the type says so — see the header of
 * `domain/chapter-graph.ts` for why it cannot be finer.
 */

/** A chapter, hydrated enough to render without a second lookup. */
export interface ChapterDescriptor {
  readonly chapterId: ChapterNodeId;
  readonly grade: string;
  readonly subjectCode: string;
  readonly chapterNumber: number;
  readonly titleEn: string;
  readonly titleHi: string | null;
}

/**
 * A `chapter_concepts` row.
 *
 * NOTE THE ABSENCE OF A CODE. This table has no code column — its identity is a
 * title and an ordinal — which is precisely why it does not join to
 * `concept_graph`. A caller holding one of these cannot ask the graph about it,
 * and no field here pretends otherwise.
 */
export interface ChapterConcept {
  readonly id: string;
  readonly chapterId: ChapterNodeId;
  readonly conceptNumber: number | null;
  readonly titleEn: string;
  readonly titleHi: string | null;
  readonly learningObjective: string | null;
}

/** A learning path with its chapters hydrated, or the reason there is none. */
export type HydratedLearningPath =
  | { readonly ok: true; readonly path: readonly ChapterDescriptor[] }
  | {
      readonly ok: false;
      readonly reason: 'cycle';
      /**
       * The closed chapter path that contradicts itself, hydrated so the
       * diagnosis is readable without a second query. This is the whole value of
       * reporting a cycle rather than an empty list.
       */
      readonly cycle: readonly ChapterDescriptor[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown_chapter';
      readonly chapterId: ChapterNodeId;
    };

export type { ChapterNodeId, ConceptCode, LearningPathResult };
