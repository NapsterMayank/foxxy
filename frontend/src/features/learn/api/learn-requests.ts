import { apiRequest } from '@/lib/api/client';
import {
  chapterConceptsResponseSchema,
  chaptersResponseSchema,
  type ChapterConceptsResponse,
  type ChaptersResponse,
} from '@/lib/api/generated/contracts/content.contract';
import { contentPaths } from '@/lib/api/paths';

/**
 * ===========================================================================
 * THE SYLLABUS, AS A STUDENT BROWSES IT — the `learn` feature.
 *
 * Two calls: the chapters of one subject, and the concepts of one chapter.
 * Both response schemas are generated.
 *
 * ---------------------------------------------------------------------------
 * THE GRADE IS ALWAYS PASSED AND NEVER CHOSEN BY THE STUDENT.
 *
 * It comes from the profile, exactly as it does when Foxy opens a session —
 * "a grade a caller could choose is a grade a caller could choose wrongly", and
 * a Grade 8 student browsing Grade 6 chapters would be reading the wrong
 * textbook with nothing on screen to say so.
 * ===========================================================================
 */

export function getChapters(grade: string, subject: string): Promise<ChaptersResponse> {
  const query = new URLSearchParams({ grade, subject }).toString();
  return apiRequest({ path: `${contentPaths.chapters}?${query}`, schema: chaptersResponseSchema });
}

export function getChapterConcepts(chapterId: string): Promise<ChapterConceptsResponse> {
  return apiRequest({
    path: contentPaths.concepts(chapterId),
    schema: chapterConceptsResponseSchema,
  });
}
