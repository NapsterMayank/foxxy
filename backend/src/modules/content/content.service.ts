import { createAccessGuard, type AccessGuard } from '@/platform/authz/index';
import { NotFoundError } from '@/platform/errors/index';
import type { Logger } from '@/platform/logger/index';
import type { ChapterListQuery } from '@/shared/contracts/content.contract';
import type { ContentRepository } from './content.repository';
import type {
  ChapterRecord,
  ChunkRecord,
  ContentActor,
  QuestionQuery,
  QuestionRecord,
} from './content.types';

/**
 * The content use-cases — 01-BACKEND-IMPLEMENTATION-PLAN.md §8.3.
 *
 * ===========================================================================
 * THE HELD-OUT RESERVE IS THE ONE RULE IN THIS FILE THAT CANNOT BE UNDONE.
 *
 * `getQuestionsForChapter` — the name every caller reaches for, the name
 * `practice` will use — EXCLUDES held-out questions. Not by default. Not
 * behind a flag. It has no parameter that could include them, so there is no
 * way to write the mistake.
 *
 * The reserve exists so that mastery can be measured with questions the
 * student has never practised (PROGRESS.md §8, one-way door 2). The moment a
 * held-out question is served in practice it may have been memorised, and it
 * can never measure anything again — for that student, permanently. You cannot
 * un-serve a question, so there is no recovery and no cleanup: the reserve
 * simply gets smaller until independent measurement stops being possible.
 *
 * A boolean parameter — `getQuestionsForChapter(query, { includeHeldOut })` —
 * would put that outcome one forgotten argument away, and forgetting an
 * argument is not a rare event. The held-out pool is reached through a
 * DIFFERENTLY NAMED function, `getHeldOutQuestionsForChapter`, which is
 * impossible to call by accident and greppable in one search when the time
 * comes to audit who touches the reserve.
 * ===========================================================================
 *
 * Content is not owned by any student, so every method authorises against the
 * `content` resource: any authenticated actor may READ, nobody may write
 * (D-003 — nothing in the product authors curriculum over the API).
 */

export interface ContentServiceDeps {
  readonly repository: ContentRepository;
  readonly logger: Logger;
}

/** How many questions a single request may draw. */
export const DEFAULT_QUESTION_LIMIT = 20;

export interface ContentService {
  listChapters(actor: ContentActor, query: ChapterListQuery): Promise<ChapterRecord[]>;
  getChapter(actor: ContentActor, chapterId: string): Promise<ChapterRecord>;
  /**
   * PRACTICE questions. NEVER returns a held-out question — see the file note.
   */
  getQuestionsForChapter(
    actor: ContentActor,
    query: Omit<QuestionQuery, 'limit'> & { limit?: number },
  ): Promise<QuestionRecord[]>;
  /**
   * The HELD-OUT reserve, for independent mastery checks only.
   *
   * Separately named on purpose. If you are reading this because autocomplete
   * offered it: serving one of these in ordinary practice contaminates it
   * permanently.
   */
  getHeldOutQuestionsForChapter(
    actor: ContentActor,
    query: Omit<QuestionQuery, 'limit'> & { limit?: number },
  ): Promise<QuestionRecord[]>;
  getChunksByIds(actor: ContentActor, ids: readonly string[]): Promise<ChunkRecord[]>;
}

export function createContentService(deps: ContentServiceDeps): ContentService {
  const { repository } = deps;

  /**
   * The content guard, built ONCE.
   *
   * Unlike student data, the decision here depends on nothing that can change
   * between requests — there is no link status to read at query time — so
   * there is nothing to rebuild per call. The reader is a function that is
   * never invoked on this path; passing one that throws would be a trap for
   * whoever adds a student-scoped resource to this module later, so it simply
   * reports "no link".
   */
  const guard: AccessGuard = createAccessGuard({ readLinkStatus: () => null });

  function authoriseRead(actor: ContentActor): void {
    guard.assertCanAccess(actor, 'read', { kind: 'content' });
  }

  return {
    async listChapters(actor: ContentActor, query: ChapterListQuery): Promise<ChapterRecord[]> {
      authoriseRead(actor);
      return repository.listChapters({
        grade: query.grade,
        subjectCode: query.subject,
        limit: query.limit,
      });
    },

    /**
     * One chapter.
     *
     * A WITHDRAWN CHAPTER IS A 404, not a 200 with `isActive: false`. The
     * repository filters on `is_active`, so this method cannot distinguish
     * "withdrawn" from "never existed" — which is the intended behaviour:
     * telling them apart would let anyone enumerate withdrawn content, and
     * "this chapter has been withdrawn" is not information a student can act
     * on.
     */
    async getChapter(actor: ContentActor, chapterId: string): Promise<ChapterRecord> {
      authoriseRead(actor);
      const chapter = await repository.findChapterById(chapterId);
      if (chapter === null) {
        throw new NotFoundError('Chapter not found.', {
          message: 'Chapter lookup matched no active row',
        });
      }
      return chapter;
    },

    async getQuestionsForChapter(
      actor: ContentActor,
      query: Omit<QuestionQuery, 'limit'> & { limit?: number },
    ): Promise<QuestionRecord[]> {
      authoriseRead(actor);
      // 'practice' is hardcoded, and there is no parameter that could change
      // it. This is the whole protection.
      return repository.findQuestions(
        {
          chapterId: query.chapterId,
          grade: query.grade,
          subjectCode: query.subjectCode,
          limit: query.limit ?? DEFAULT_QUESTION_LIMIT,
        },
        'practice',
      );
    },

    async getHeldOutQuestionsForChapter(
      actor: ContentActor,
      query: Omit<QuestionQuery, 'limit'> & { limit?: number },
    ): Promise<QuestionRecord[]> {
      authoriseRead(actor);
      return repository.findQuestions(
        {
          chapterId: query.chapterId,
          grade: query.grade,
          subjectCode: query.subjectCode,
          limit: query.limit ?? DEFAULT_QUESTION_LIMIT,
        },
        'held-out',
      );
    },

    /**
     * §8.3 — hydrate chunks by id. What `retrieval` will call.
     *
     * ON THE POOL, because it looks inconsistent and is not: this runs on
     * `core`, while `retrieval` runs its vector search on `ai` (§3.1, D-045).
     * The pool follows the CALLER'S COST PROFILE, not the table's owner. A
     * primary-key lookup of fifty ids is ordinary cheap traffic; the HNSW scan
     * that produced those ids is not, and letting it hold `core` connections
     * would queue chapter listings behind vector search.
     */
    async getChunksByIds(actor: ContentActor, ids: readonly string[]): Promise<ChunkRecord[]> {
      authoriseRead(actor);
      return repository.findChunksByIds(ids);
    },
  };
}
