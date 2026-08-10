/**
 * THE IMPORT PLAN — everything the corpus import decides, as a pure function.
 *
 * ===========================================================================
 * WHY THE DECISIONS ARE SEPARATED FROM THE WRITING.
 *
 * An importer that normalises, derives, chooses the reserve and INSERTs in one
 * pass has no state anybody can look at. Its decisions exist only as their
 * effects, so the only way to check "did it hold out the right questions?" is
 * to query the database afterwards and hope the answer is legible — and the one
 * decision here that cannot be undone (the reserve, D-079) is the one that
 * deserves the most scrutiny before it is written, not after.
 *
 * `buildImportPlan` takes an extract and returns every decision as data. It
 * touches no database, no clock and no randomness, so the same extract always
 * produces the same plan — which is also what makes the import re-runnable
 * (`is_held_out` cannot drift between runs) and what makes all of this testable
 * without the source being reachable.
 *
 * ===========================================================================
 * CHAPTERS ARE DERIVED FIRST, AND FROM ALL THREE SOURCES.
 *
 * Our `chapters` table is empty; the source has no chapters table to copy. A
 * chapter exists here if any of chunks, questions or concepts refers to it.
 * Deriving from ONE source would silently drop the chapters only the other two
 * know about, and every chunk whose chapter is missing loses its `chapter_id`.
 */

import {
  chapterKeyOf,
  normaliseChapterNumber,
  toChapterKey,
  type ChapterKey,
  type ChapterKeyRejection,
} from './normalise';
import {
  partitionQuestions,
  type EligibleQuestion,
  type ExcludedQuestion,
} from './question-eligibility';
import {
  planReserves,
  scoreReadiness,
  type ChapterReadiness,
  type ChapterReserve,
} from './held-out-reserve';
import { normaliseEmbeddingModel, normaliseSubject } from './normalise';
import type {
  SourceChapterConcept,
  SourceChunk,
  SourceConceptEdge,
  SourceExtract,
  SourceMisconception,
} from './source-shapes';

export interface PlannedChapter {
  readonly chapterKey: string;
  readonly chapter: ChapterKey;
  /**
   * The best title any source offered, or a generated one.
   *
   * `chapters.title_en` is NOT NULL with a non-empty CHECK, and only
   * `rag_content_chunks` carries a title at all. A chapter known solely from
   * `question_bank` therefore has no title and would abort the insert — so it
   * gets `Chapter <n>`, which is honest, sorts correctly, and is visibly a
   * placeholder rather than a plausible wrong title.
   */
  readonly titleEn: string;
  /** True when the title is the generated placeholder, so the report can count them. */
  readonly titleIsPlaceholder: boolean;
}

export interface PlannedChunk {
  readonly sourceId: string;
  readonly chapterKey: string;
  readonly chunkText: string;
  readonly chunkIndex: number;
  readonly chunkType: string;
  readonly board: string;
  readonly grade: string;
  readonly subject: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string | null;
  readonly topic: string | null;
  readonly concept: string | null;
  readonly difficultyLevel: number | null;
  readonly contentLayer: string | null;
  readonly language: string | null;
  readonly embedding: readonly number[] | null;
  readonly embeddingModel: string | null;
  readonly wordCount: number | null;
  readonly tokenCount: number | null;
  readonly qualityScore: number | null;
  readonly isActive: boolean;
}

export interface PlannedConcept {
  readonly sourceId: string;
  readonly chapterKey: string;
  readonly conceptName: string;
  readonly conceptNameHi: string | null;
  /** Position within its chapter. Not unique across chapters. */
  readonly conceptNumber: number | null;
  readonly slug: string | null;
  readonly learningObjective: string | null;
  readonly explanationEn: string | null;
  readonly explanationHi: string | null;
  readonly exampleContent: string | null;
  readonly keyFormula: string | null;
  /** Always an array — an absent list is `[]`, never null. See `narrowStringList`. */
  readonly commonMistakes: readonly string[];
}

export interface PlannedConceptEdge {
  readonly sourceId: string;
  readonly chapterKey: string;
  readonly conceptCode: string;
  readonly conceptName: string | null;
  readonly prerequisiteCodes: readonly string[];
  /**
   * Carried through UNVALIDATED, unlike a question's bloom level.
   *
   * A question's bloom level drives selection, so an unrecognised one excludes
   * the question. An edge's is descriptive metadata on a graph nothing reads
   * yet; normalising it would mean dropping edges over a label, and an edge
   * dropped is a prerequisite relationship nobody can recover.
   */
  readonly bloomLevel: string | null;
  readonly cognitiveLoad: number | null;
}

export interface PlannedMisconception {
  readonly sourceId: string;
  readonly subject: string;
  readonly conceptCode: string | null;
  /** The source column is `pattern_code` (D-098), and so is ours. */
  readonly patternCode: string;
  readonly description: string | null;
  /**
   * NO HINDI DESCRIPTION EXISTS IN THE SOURCE — not "is usually null", does not
   * exist as a column (D-098). Recorded here as a P7 gap rather than modelled
   * as a field that would always be null.
   */
  readonly detectionRule: unknown;
  readonly remediationStrategy: string | null;
  readonly remediationConceptCodes: readonly string[];
  readonly severity: number | null;
  /** True when `conceptCode` matches no `concept_graph.concept_code` in scope. */
  readonly orphan: boolean;
}

export interface ImportPlan {
  readonly chapters: readonly PlannedChapter[];
  readonly chunks: readonly PlannedChunk[];
  readonly concepts: readonly PlannedConcept[];
  readonly conceptEdges: readonly PlannedConceptEdge[];
  readonly questions: readonly EligibleQuestion[];
  readonly misconceptions: readonly PlannedMisconception[];
  readonly reserves: ReadonlyMap<string, ChapterReserve>;
  readonly readiness: readonly ChapterReadiness[];
  readonly excludedQuestions: readonly ExcludedQuestion[];
  /** Ids of chunks imported with a NULL embedding, so they can be re-embedded. */
  readonly chunksWithoutEmbedding: readonly string[];
  readonly rejectedChunks: readonly { readonly id: string; readonly reason: ChapterKeyRejection }[];
  readonly rejectedConcepts: readonly {
    readonly id: string;
    readonly reason: ChapterKeyRejection;
  }[];
  readonly rejectedConceptEdges: readonly {
    readonly id: string;
    readonly reason: ChapterKeyRejection;
  }[];
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Narrows an `unknown` jsonb list to the non-empty strings in it.
 *
 * Returns `[]` for anything that is not an array, and drops non-string
 * elements rather than stringifying them — `"[object Object]"` in a
 * common-mistakes list is worse than an absent entry, because it looks like
 * content.
 */
function narrowStringList(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const values: unknown[] = raw;
  const out: string[] = [];
  for (const value of values) {
    const text = nonEmpty(typeof value === 'string' ? value : null);
    if (text !== null) {
      out.push(text);
    }
  }

  return out;
}

export type PlannedChunkResult =
  | { readonly ok: true; readonly chunk: PlannedChunk }
  | { readonly ok: false; readonly reason: ChapterKeyRejection };

/**
 * Plans ONE chunk. Exported because `chunks.ndjson` is 66 MB and is streamed.
 *
 * `buildImportPlan` takes a whole `SourceExtract` in memory, which is right for
 * the four small files and impossible for the chunks: 4,666 × 1,024 doubles is
 * a few hundred megabytes of JavaScript numbers before anything is written. The
 * importer therefore reads chunks a line at a time and calls this per row, so
 * only ONE embedding is resident at a time.
 *
 * The singular function is the shared implementation rather than a parallel
 * one — `planChunks` below is a fold over it, so the streaming path and the
 * in-memory path cannot drift.
 */
export function planChunk(row: SourceChunk): PlannedChunkResult {
  const key = toChapterKey(row);
  if (!key.ok) {
    return { ok: false, reason: key.reason };
  }

  const text = nonEmpty(row.chunk_text);
  if (text === null) {
    // `rag_chunks.chunk_text` is NOT NULL with a non-empty CHECK. A blank
    // chunk is unreachable content whichever way it is stored, so it is
    // reported as a chapter-key rejection rather than given a reason nothing
    // else uses.
    return { ok: false, reason: 'chapter-number-invalid' };
  }

  return {
    ok: true,
    chunk: {
      sourceId: row.id,
      chapterKey: chapterKeyOf(key.key),
      chunkText: text,
      chunkIndex: typeof row.chunk_index === 'number' && row.chunk_index >= 0 ? row.chunk_index : 0,
      chunkType: nonEmpty(row.chunk_type) ?? 'paragraph',
      board: nonEmpty(row.board) ?? 'CBSE',
      grade: key.key.grade,
      subject: key.key.subject,
      chapterNumber: key.key.chapterNumber,
      chapterTitle: nonEmpty(row.chapter_title),
      topic: nonEmpty(row.topic),
      concept: nonEmpty(row.concept),
      difficultyLevel: row.difficulty_level,
      contentLayer: nonEmpty(row.content_layer),
      // `language` deliberately carries no vocabulary check — grade is a product
      // invariant, language is a label, and an unexpected 'en-IN' must not block
      // the import (0002's header).
      language: nonEmpty(row.language),
      embedding: row.embedding,
      // Normalised even when the vector is absent: a chunk stamped
      // `voyage/voyage-3` with no vector is still a chunk we know the intended
      // model for, and that is what the re-embedding job reads.
      embeddingModel: normaliseEmbeddingModel(row.embedding_model),
      wordCount: row.word_count,
      tokenCount: row.token_count,
      qualityScore: row.quality_score,
      isActive: row.is_active ?? true,
    },
  };
}

/**
 * The summary of a chunk that survives streaming: everything chapter derivation
 * needs, and nothing that is 1,024 numbers wide.
 */
export interface ChunkChapterSummary {
  readonly chapterKey: string;
  readonly chapter: ChapterKey;
  readonly chapterTitle: string | null;
  readonly chunkIndex: number;
}

/** Reduces a planned chunk to the part chapter derivation reads. */
export function summariseChunk(chunk: PlannedChunk): ChunkChapterSummary {
  return {
    chapterKey: chunk.chapterKey,
    chapter: {
      grade: chunk.grade as ChapterKey['grade'],
      subject: chunk.subject as ChapterKey['subject'],
      chapterNumber: chunk.chapterNumber,
    },
    chapterTitle: chunk.chapterTitle,
    chunkIndex: chunk.chunkIndex,
  };
}

function planConcepts(rows: readonly SourceChapterConcept[]): {
  readonly planned: PlannedConcept[];
  readonly rejected: { readonly id: string; readonly reason: ChapterKeyRejection }[];
} {
  const planned: PlannedConcept[] = [];
  const rejected: { readonly id: string; readonly reason: ChapterKeyRejection }[] = [];

  for (const row of rows) {
    const key = toChapterKey(row);
    if (!key.ok) {
      rejected.push({ id: row.id, reason: key.reason });
      continue;
    }

    // `title`, NOT `concept_name` — the column this used to read does not
    // exist, and every one of the 639 concepts would have been "rejected" for
    // a missing name (D-098).
    const name = nonEmpty(row.title);
    if (name === null) {
      rejected.push({ id: row.id, reason: 'chapter-number-invalid' });
      continue;
    }

    planned.push({
      sourceId: row.id,
      chapterKey: chapterKeyOf(key.key),
      conceptName: name,
      conceptNameHi: nonEmpty(row.title_hi),
      conceptNumber: normaliseChapterNumber(row.concept_number),
      slug: nonEmpty(row.slug),
      learningObjective: nonEmpty(row.learning_objective),
      explanationEn: nonEmpty(row.explanation),
      explanationHi: nonEmpty(row.explanation_hi),
      exampleContent: nonEmpty(row.example_content),
      keyFormula: nonEmpty(row.key_formula),
      commonMistakes: narrowStringList(row.common_mistakes),
    });
  }

  return { planned, rejected };
}

function planConceptEdges(rows: readonly SourceConceptEdge[]): {
  readonly planned: PlannedConceptEdge[];
  readonly rejected: { readonly id: string; readonly reason: ChapterKeyRejection }[];
} {
  const planned: PlannedConceptEdge[] = [];
  const rejected: { readonly id: string; readonly reason: ChapterKeyRejection }[] = [];

  for (const row of rows) {
    // THE HYBRID TABLE. Grades spelled 'Grade 6', subjects spelled 'math'.
    // `toChapterKey` handles it without a special case because neither
    // normaliser was ever told which table it was serving.
    const key = toChapterKey(row);
    if (!key.ok) {
      rejected.push({ id: row.id, reason: key.reason });
      continue;
    }

    const code = nonEmpty(row.concept_code);
    if (code === null) {
      rejected.push({ id: row.id, reason: 'chapter-number-invalid' });
      continue;
    }

    planned.push({
      sourceId: row.id,
      chapterKey: chapterKeyOf(key.key),
      conceptCode: code,
      conceptName: nonEmpty(row.concept_name),
      prerequisiteCodes: narrowStringList(row.prerequisite_codes),
      bloomLevel: nonEmpty(row.bloom_level),
      cognitiveLoad: typeof row.cognitive_load === 'number' ? row.cognitive_load : null,
    });
  }

  return { planned, rejected };
}

function planMisconceptions(
  rows: readonly SourceMisconception[],
  knownConceptCodes: ReadonlySet<string>,
): PlannedMisconception[] {
  const planned: PlannedMisconception[] = [];

  for (const row of rows) {
    // No grade column exists on this table, so subject is the only scope there
    // is. An unrecognised subject is a skip, not a guess.
    const subject = normaliseSubject(row.subject);
    // `pattern_code`, NOT `misconception_code` — see D-098. Under the old name
    // all 57 rows skipped silently, and "0 misconceptions imported" is
    // indistinguishable from "the source has none".
    const code = nonEmpty(row.pattern_code);
    if (subject === null || code === null) {
      continue;
    }

    const conceptCode = nonEmpty(row.concept_code);

    planned.push({
      sourceId: row.id,
      subject,
      conceptCode,
      patternCode: code,
      description: nonEmpty(row.description),
      detectionRule: row.detection_rule ?? null,
      remediationStrategy: nonEmpty(row.remediation_strategy),
      remediationConceptCodes: narrowStringList(row.remediation_concept_codes),
      severity: typeof row.severity === 'number' ? row.severity : null,
      // ORPHANS ARE IMPORTED, FLAGGED, AND COUNTED — not dropped. Only ~18 of
      // ~48 concept codes resolve against `concept_graph`. A misconception whose
      // concept is not in the graph is still a real, human-authored description
      // of how students get something wrong; the broken link is a fact about the
      // source, and recording it is what lets somebody fix it later.
      orphan: conceptCode === null || !knownConceptCodes.has(conceptCode),
    });
  }

  return planned;
}

/**
 * Derives the chapter set from all four chapter-bearing sources.
 *
 * The title is taken from whichever chunk offers one, preferring the LOWEST
 * chunk index so the choice does not depend on extract order. Chapters known
 * only from questions, concepts or the graph get a placeholder, which is
 * counted.
 *
 * Takes chunk SUMMARIES rather than planned chunks, because the chunk file is
 * streamed and the vectors are gone by the time this runs.
 */
function deriveChapters(
  chunkSummaries: readonly ChunkChapterSummary[],
  concepts: readonly PlannedConcept[],
  questions: readonly EligibleQuestion[],
  edges: readonly PlannedConceptEdge[],
): PlannedChapter[] {
  const keys = new Map<string, ChapterKey>();
  const titles = new Map<string, { readonly title: string; readonly at: number }>();

  const remember = (chapterKey: string, chapter: ChapterKey): void => {
    if (!keys.has(chapterKey)) {
      keys.set(chapterKey, chapter);
    }
  };

  for (const summary of chunkSummaries) {
    remember(summary.chapterKey, summary.chapter);

    if (summary.chapterTitle !== null) {
      const current = titles.get(summary.chapterKey);
      if (current === undefined || summary.chunkIndex < current.at) {
        titles.set(summary.chapterKey, { title: summary.chapterTitle, at: summary.chunkIndex });
      }
    }
  }

  for (const question of questions) {
    remember(chapterKeyOf(question.chapter), question.chapter);
  }

  const parseKey = (chapterKey: string): ChapterKey | null => {
    const [grade, subject, number] = chapterKey.split('|');
    if (grade === undefined || subject === undefined || number === undefined) {
      return null;
    }
    return {
      grade: grade as ChapterKey['grade'],
      subject: subject as ChapterKey['subject'],
      chapterNumber: Number(number),
    };
  };

  for (const source of [...concepts, ...edges]) {
    const chapter = parseKey(source.chapterKey);
    if (chapter !== null) {
      remember(source.chapterKey, chapter);
    }
  }

  return [...keys.entries()]
    .map(([chapterKey, chapter]) => {
      const title = titles.get(chapterKey)?.title;
      return {
        chapterKey,
        chapter,
        titleEn: title ?? `Chapter ${String(chapter.chapterNumber)}`,
        titleIsPlaceholder: title === undefined,
      };
    })
    .sort((a, b) => a.chapterKey.localeCompare(b.chapterKey));
}

/**
 * Everything a streaming pass over `chunks.ndjson` has to remember.
 *
 * All four fields are O(chunks) in COUNT and O(1) in vector width — no
 * embedding survives the pass, which is the whole reason the streaming path
 * exists.
 */
export interface ChunkStreamSummary {
  readonly summaries: readonly ChunkChapterSummary[];
  readonly rejected: readonly { readonly id: string; readonly reason: ChapterKeyRejection }[];
  /** Ids imported with a NULL embedding, so they can be re-embedded (D-078). */
  readonly withoutEmbedding: readonly string[];
}

/** The plan minus the chunk rows themselves, which the streaming path writes as it reads. */
export type StreamedImportPlan = Omit<ImportPlan, 'chunks'>;

/**
 * Options every entry point shares.
 *
 * `alreadyHeldOut` is what makes a RE-RUN safe. `held-out-reserve.ts` is
 * monotonic only if it is told what is already reserved; called with nothing,
 * a second import over a grown chapter recomputes the reserve from scratch and
 * un-reserves questions that have been kept back from practice — the exact
 * contamination that module exists to prevent, arriving through its own default
 * argument. The importer reads `questions.is_held_out` from the database and
 * passes it here.
 */
export interface ImportPlanOptions {
  readonly alreadyHeldOut?: ReadonlySet<string>;
}

/**
 * The plan, from an extract whose chunks have already been streamed away.
 *
 * This is the real entry point; `buildImportPlan` is the in-memory convenience
 * over it. Both go through here, so the streaming path and the whole-extract
 * path cannot decide different things.
 */
export function buildStreamedImportPlan(
  extract: Omit<SourceExtract, 'chunks'>,
  chunkStream: ChunkStreamSummary,
  options: ImportPlanOptions = {},
): StreamedImportPlan {
  const concepts = planConcepts(extract.concepts);
  const conceptEdges = planConceptEdges(extract.conceptEdges);
  const { eligible: questions, excluded: excludedQuestions } = partitionQuestions(extract.questions);

  const chapters = deriveChapters(
    chunkStream.summaries,
    concepts.planned,
    questions,
    conceptEdges.planned,
  );

  const misconceptions = planMisconceptions(
    extract.misconceptions,
    new Set(conceptEdges.planned.map((edge) => edge.conceptCode)),
  );

  // The reserve is chosen over ELIGIBLE questions only. Counting the optionless
  // 1,045 toward the threshold would let a chapter with 14 usable questions and
  // 6 broken ones cross the bar and reserve questions it cannot spare.
  const idsByChapter = new Map<string, string[]>();
  for (const question of questions) {
    const key = chapterKeyOf(question.chapter);
    const bucket = idsByChapter.get(key);
    if (bucket === undefined) {
      idsByChapter.set(key, [question.sourceId]);
    } else {
      bucket.push(question.sourceId);
    }
  }

  const counts = new Map<string, { questions: number; chunks: number; concepts: number }>();
  const bump = (key: string, field: 'questions' | 'chunks' | 'concepts'): void => {
    const current = counts.get(key) ?? { questions: 0, chunks: 0, concepts: 0 };
    current[field] += 1;
    counts.set(key, current);
  };

  for (const chapter of chapters) {
    counts.set(chapter.chapterKey, { questions: 0, chunks: 0, concepts: 0 });
  }
  for (const summary of chunkStream.summaries) {
    bump(summary.chapterKey, 'chunks');
  }
  for (const concept of concepts.planned) {
    bump(concept.chapterKey, 'concepts');
  }
  for (const question of questions) {
    bump(chapterKeyOf(question.chapter), 'questions');
  }

  return {
    chapters,
    concepts: concepts.planned,
    conceptEdges: conceptEdges.planned,
    questions,
    misconceptions,
    reserves: planReserves(idsByChapter, options.alreadyHeldOut ?? new Set()),
    readiness: scoreReadiness(counts),
    excludedQuestions,
    chunksWithoutEmbedding: chunkStream.withoutEmbedding,
    rejectedChunks: chunkStream.rejected,
    rejectedConcepts: concepts.rejected,
    rejectedConceptEdges: conceptEdges.rejected,
  };
}

/**
 * The plan, from a whole extract held in memory.
 *
 * Used by the tests and by anything small enough to fit. The importer does NOT
 * use it — see the header of `planChunk`.
 */
export function buildImportPlan(
  extract: SourceExtract,
  options: ImportPlanOptions = {},
): ImportPlan {
  const planned: PlannedChunk[] = [];
  const rejected: { readonly id: string; readonly reason: ChapterKeyRejection }[] = [];

  for (const row of extract.chunks) {
    const outcome = planChunk(row);
    if (outcome.ok) {
      planned.push(outcome.chunk);
    } else {
      rejected.push({ id: row.id, reason: outcome.reason });
    }
  }

  const streamed = buildStreamedImportPlan(
    extract,
    {
      summaries: planned.map(summariseChunk),
      rejected,
      withoutEmbedding: planned
        .filter((chunk) => chunk.embedding === null)
        .map((chunk) => chunk.sourceId),
    },
    options,
  );

  return { ...streamed, chunks: planned };
}
