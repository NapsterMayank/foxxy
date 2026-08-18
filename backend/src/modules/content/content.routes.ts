import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  ChapterConceptsResponse,
  Chapter,
  ChapterResponse,
  ChaptersResponse,
} from '@/shared/contracts/content.contract';
import { contentSchemas, parseInput } from './content.schema';
import type { ContentService } from './content.service';
import type { ChapterRecord, ContentActor } from './content.types';

/**
 * HTTP only — §2, layer table.
 *
 * Two endpoints, both read-only, exactly as §8.3 specifies. There is no route
 * that serves questions: a question carries `correct_index`, and `practice`
 * owns the session, the shuffle and the anti-cheat rules that make serving one
 * safe. `getQuestionsForChapter` is a module-to-module call and stays one.
 */

const API_PREFIX = '/api/v1';

function toChapter(record: ChapterRecord): Chapter {
  return {
    id: record.id,
    grade: record.grade,
    subjectCode: record.subjectCode,
    chapterNumber: record.chapterNumber,
    titleEn: record.titleEn,
    titleHi: record.titleHi,
  };
}

function requireActor(request: FastifyRequest): ContentActor {
  const actor = request.actor;
  if (actor === undefined) {
    throw new Error('content routes: missing the requireSession preHandler');
  }
  return actor;
}

export interface ContentRoutesDeps {
  readonly service: ContentService;
  readonly requireSession: preHandlerAsyncHookHandler;
}

export function registerContentRoutes(app: FastifyInstance, deps: ContentRoutesDeps): void {
  const authenticated = { preHandler: deps.requireSession };

  /**
   * §8.3 — the chapter list, optionally filtered by grade and subject.
   *
   * AUTHENTICATED, even though curriculum belongs to no student. The syllabus
   * is not a secret, but an open endpoint that lists it is a free scraping
   * target with a database query behind it, and the rate limits in §6.9 are
   * keyed on a session. Nothing here justifies a public surface.
   */
  app.get(`${API_PREFIX}/content/chapters`, authenticated, async (request, reply) => {
    const query = parseInput(contentSchemas.chapterList, request.query);
    const chapters = await deps.service.listChapters(requireActor(request), query);
    const body: ChaptersResponse = { chapters: chapters.map(toChapter) };
    return reply.status(200).send(body);
  });

  /** §8.3 — one chapter. A withdrawn chapter is a 404; see the service. */
  app.get(`${API_PREFIX}/content/chapters/:id`, authenticated, async (request, reply) => {
    const { id } = parseInput(contentSchemas.chapterIdParam, request.params);
    const chapter = await deps.service.getChapter(requireActor(request), id);
    const body: ChapterResponse = { chapter: toChapter(chapter) };
    return reply.status(200).send(body);
  });

  /**
   * ======================================================================
   * §8.3 — a chapter's CONCEPTS, which is the study walkthrough.
   *
   * `chapter_concepts` has held 639 of these since the corpus import — every
   * one with an English explanation, 629 with Hindi — and no endpoint served
   * them. The content was written, imported, indexed and stranded; this route
   * is the whole of what was missing.
   *
   * The BILINGUAL FIELDS GO OUT AS PAIRS rather than resolved: the Hindi here
   * is corpus content and is genuinely absent on some rows, so the client
   * falls back, exactly as it already does for `titleHi` on a chapter.
   * ======================================================================
   */
  app.get(`${API_PREFIX}/content/chapters/:id/concepts`, authenticated, async (request, reply) => {
    const { id } = parseInput(contentSchemas.chapterIdParam, request.params);
    const { chapter, concepts } = await deps.service.getChapterConcepts(requireActor(request), id);

    const body: ChapterConceptsResponse = {
      chapter: toChapter(chapter),
      concepts: concepts.map((concept) => ({
        id: concept.id,
        conceptNumber: concept.conceptNumber,
        titleEn: concept.titleEn,
        titleHi: concept.titleHi,
        learningObjective: concept.learningObjective,
        explanationEn: concept.explanationEn,
        explanationHi: concept.explanationHi,
        exampleContent: concept.exampleContent,
        keyFormula: concept.keyFormula,
        commonMistakes: [...concept.commonMistakes],
      })),
    };
    return reply.status(200).send(body);
  });
}
