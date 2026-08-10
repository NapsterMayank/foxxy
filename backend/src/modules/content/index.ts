import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Logger } from '@/platform/logger/index';
import { createContentRepository, type ContentDbHandle } from './content.repository';
import { registerContentRoutes } from './content.routes';
import { createContentService, type ContentService } from './content.service';

/**
 * ============================================================================
 * content — THE PUBLIC SURFACE.
 *
 * This is the only file another module may import (00-ARCHITECTURE.md,
 * Foundation 1, enforced by ESLint `no-restricted-imports`). Everything else
 * in this directory is private.
 *
 * Owns: chapters, questions and RAG chunks (plan §8.3). Calls no other module.
 * ============================================================================
 *
 * THE ONE RULE IN THIS MODULE THAT CANNOT BE UNDONE LATER.
 *
 * `getQuestionsForChapter` never returns a held-out question, and has no
 * parameter that could make it. The reserve exists so mastery can be measured
 * with questions a student has never practised; serving one in practice
 * contaminates it permanently, for that student, with no way back. The
 * reserve is reached only through the separately named
 * `getHeldOutQuestionsForChapter`. The full reasoning is at the top of
 * `content.service.ts` — read it before adding any parameter to either.
 *
 * ON POOLS, because `content` and `retrieval` read the same table and get
 * different pools (§3.1, D-045): content is ordinary request traffic and runs
 * on `core`; retrieval's vector search runs on `ai`. The pool follows the
 * CALLER'S cost profile, not the table's owner — otherwise a slow HNSW scan
 * holds `core` connections and every chapter listing queues behind it. That is
 * the row of §3.1 easiest to get backwards.
 */

export interface ContentModuleDeps {
  /** §3.1: content is ordinary request traffic and gets the `core` pool. */
  readonly db: ContentDbHandle;
  readonly logger: Logger;
  /** Identity's session validator, injected at the composition root. */
  readonly requireSession: preHandlerAsyncHookHandler;
}

export interface ContentModule {
  /** Every content use-case. The only object other modules should hold. */
  readonly service: ContentService;
  /** Registers the two `/content/chapters…` endpoints under `/api/v1`. */
  registerRoutes(app: FastifyInstance): void;
}

export function createContentModule(deps: ContentModuleDeps): ContentModule {
  const service = createContentService({
    repository: createContentRepository(deps.db),
    logger: deps.logger,
  });

  return {
    service,
    registerRoutes(app: FastifyInstance): void {
      registerContentRoutes(app, { service, requireSession: deps.requireSession });
    },
  };
}

/**
 * ---------------------------------------------------------------------------
 * The use-cases, as named in §8.3. Each is reached through `module.service`.
 *
 *   listChapters                   Active chapters, optionally filtered by
 *                                  grade and subject. Withdrawn chapters are
 *                                  never listed.
 *   getChapter                     One active chapter. A withdrawn one is a
 *                                  404, indistinguishable from absent.
 *   getQuestionsForChapter         PRACTICE questions for a chapter, hard
 *                                  filtered by grade and subject. Inactive and
 *                                  HELD-OUT questions are never returned, and
 *                                  no argument can change that.
 *   getHeldOutQuestionsForChapter  The reserve, for independent mastery checks
 *                                  only. Deliberately hard to reach.
 *   getChunksByIds                 Hydrates corpus chunks by id — what
 *                                  `retrieval` calls once it has ranked. Text
 *                                  and citation fields only, no embeddings.
 * ---------------------------------------------------------------------------
 */
export type { ContentService } from './content.service';
export { DEFAULT_QUESTION_LIMIT } from './content.service';

/** Chapters, questions and chunks as other modules see them. */
export type {
  ChapterFilter,
  ChapterRecord,
  ChunkRecord,
  QuestionQuery,
  QuestionRecord,
} from './content.types';
