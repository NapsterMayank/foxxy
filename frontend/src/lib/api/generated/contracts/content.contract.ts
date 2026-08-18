/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `frontend/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

import { z } from 'zod';
import { isGrade, type Grade } from '../constants/curriculum';

/**
 * The content wire contract — every request and response shape for the content
 * module, defined once.
 *
 * 00-ARCHITECTURE.md §1: the frontend imports the INFERRED TYPES from here.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY ABSENT: A QUESTION SHAPE.
 *
 * §8.3 gives this module exactly two endpoints, both about chapters. Questions
 * are served to a student by `practice`, which owns the session, the shuffle
 * and the anti-cheat rules — and which must never send `correct_index` to a
 * client before the answer is submitted.
 *
 * A `questionSchema` here would be a wire shape with no endpoint behind it,
 * sitting in the shared contract folder that the FRONTEND imports from. It
 * would be picked up, and the first thing it would be used for is a client
 * that fetches questions directly. `getQuestionsForChapter` is a module-to-
 * module interface: its type lives in `content.types.ts`, on the server, where
 * the frontend cannot reach it.
 * ===========================================================================
 */

/** A grade in a query string: a STRING, always. See `learner.contract.ts`. */
export const gradeQuerySchema: z.ZodType<Grade, z.ZodTypeDef, unknown> = z
  .string({ invalid_type_error: 'Grade must be a string, for example "8".' })
  .refine(isGrade, { message: 'Grade must be one of "6" to "12".' });

export const subjectQuerySchema = z.string().trim().toLowerCase().min(1).max(40);

/**
 * The chapter list filter.
 *
 * BOTH FILTERS ARE OPTIONAL AT THE SCHEMA LEVEL and both are applied when
 * present. An unfiltered list is a legitimate request — an admin-ish "what
 * exists" view — and the result is bounded by `limit` rather than by pretending
 * a filter is mandatory.
 *
 * Query-string values arrive as strings, which is exactly what these schemas
 * expect: there is no `z.coerce` on grade, and there must not be, or `?grade=8`
 * and a JSON body carrying the number 8 would start behaving differently.
 */
export const chapterListQuerySchema = z.object({
  grade: gradeQuerySchema.optional(),
  subject: subjectQuerySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ChapterListQuery = z.infer<typeof chapterListQuerySchema>;

export const chapterIdParamSchema = z.object({ id: z.string().uuid() });
export type ChapterIdParam = z.infer<typeof chapterIdParamSchema>;

/**
 * A chapter, as a client sees it.
 *
 * `titleHi` is NULLABLE and stays that way. P7 requires a bilingual UI, but a
 * Hindi title that has not been written yet must be ABSENT rather than an
 * English string wearing a Hindi field name: null is a visible gap the UI can
 * fall back from, while a copied English title is a silent claim to have
 * translated it.
 */
export const chapterSchema = z.object({
  id: z.string().uuid(),
  /** A STRING, "6".."12". */
  grade: z.string(),
  subjectCode: z.string(),
  chapterNumber: z.number().int(),
  titleEn: z.string(),
  titleHi: z.string().nullable(),
});
export type Chapter = z.infer<typeof chapterSchema>;

export const chapterResponseSchema = z.object({ chapter: chapterSchema });
export type ChapterResponse = z.infer<typeof chapterResponseSchema>;

export const chaptersResponseSchema = z.object({ chapters: z.array(chapterSchema) });
export type ChaptersResponse = z.infer<typeof chaptersResponseSchema>;

/**
 * ===========================================================================
 * A CONCEPT — one step of a chapter's walkthrough.
 *
 * `chapter_concepts` has held 639 of these since the corpus import, every one
 * with an English explanation and 629 with Hindi, and until now NO ENDPOINT
 * SERVED THEM. The content was written, imported, indexed and stranded.
 *
 * ---------------------------------------------------------------------------
 * BILINGUAL FIELDS ARE SENT AS PAIRS, NOT RESOLVED ON THE SERVER.
 *
 * `parent.contract.ts` sends `{ en, hi }` because its prose is generated per
 * child and both halves are guaranteed. Here the Hindi is CORPUS CONTENT and
 * `explanationHi` is genuinely absent for some rows, so the pair is
 * `hi: string | null` and the client falls back — the same shape `chapterSchema`
 * above already uses for `titleHi`, and for the same reason.
 *
 * Resolving language on the server would need the request to carry it, and the
 * one place that already knows a reader's language is the client.
 *
 * ---------------------------------------------------------------------------
 * `commonMistakes` IS AN ARRAY AND NEVER NULL. The column is `jsonb NOT NULL
 * DEFAULT '[]'` precisely so that "none recorded" has one representation; the
 * wire keeps that promise rather than reintroducing the choice.
 * ===========================================================================
 */
export const chapterConceptSchema = z.object({
  id: z.string().uuid(),
  /**
   * Ordinal within the chapter, and NULLABLE because the source repeats and
   * omits them. The client orders by the array it is given, not by this number.
   */
  conceptNumber: z.number().int().nullable(),
  titleEn: z.string(),
  titleHi: z.string().nullable(),
  learningObjective: z.string().nullable(),
  explanationEn: z.string().nullable(),
  explanationHi: z.string().nullable(),
  exampleContent: z.string().nullable(),
  keyFormula: z.string().nullable(),
  commonMistakes: z.array(z.string()),
});
export type ChapterConcept = z.infer<typeof chapterConceptSchema>;

export const chapterConceptsResponseSchema = z.object({
  chapter: chapterSchema,
  concepts: z.array(chapterConceptSchema),
});
export type ChapterConceptsResponse = z.infer<typeof chapterConceptsResponseSchema>;
