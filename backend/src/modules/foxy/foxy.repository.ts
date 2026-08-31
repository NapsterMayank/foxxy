import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DbExecutor, DbHandle } from '@/platform/db/index';
import { schema } from '@/platform/db/index';
import type { LanguageCode, Subject } from '@/shared/constants/curriculum';
import type { FoxyAction, FoxyMode } from '@/shared/constants/foxy';
import type { Citation } from './domain/citations';
import type { MessageRecord, SessionRecord, TraceInput } from './foxy.types';

/**
 * ALL database access for the foxy module — §7, rule 4.
 *
 * Enforced by ESLint: `@/platform/db` and `drizzle-orm` are importable only
 * from a `*.repository.ts` file.
 *
 * ===========================================================================
 * THREE TABLES, ALL OWNED BY THIS MODULE. Nothing else is read and nothing else
 * is written — `foxy` reaches `learner`, `identity` and `retrieval` through
 * injected functions, never through their tables.
 *
 * EVERY QUERY IS SCOPED BY TENANT AS WELL AS BY THE OWNER. The tenant predicate
 * is belt-and-braces, never the belt: `assertCanAccess` has already refused a
 * cross-tenant caller before any of these run (D-091). But the day one of these
 * methods is copied into a new one, the predicate travelling with it costs
 * nothing — and the alternative, "enforced by remembering to write it", is
 * exactly what `platform/authz` exists to remove.
 * ===========================================================================
 *
 * ===========================================================================
 * THE ASSISTANT MESSAGE AND ITS TRACE ARE WRITTEN IN ONE TRANSACTION.
 *
 * `retrieval_traces.message_id` is NOT NULL, so a trace cannot exist without its
 * message — but a MESSAGE CAN EXIST WITHOUT ITS TRACE if the two are separate
 * statements and the second fails. That is the shape of the bug that matters:
 * the answer a student was shown is stored, and the only record of WHY it said
 * that is missing, for precisely the turns where something went wrong.
 *
 * §8.5 requires a trace row for every turn. One transaction is what makes that
 * a property of the database rather than of the service's error handling.
 * ===========================================================================
 */

const { chatSessions, chatMessages, retrievalTraces } = schema;

export type FoxyDbHandle = DbHandle;

export interface NewSession {
  readonly studentUserId: string;
  readonly tenantId: string;
  readonly mode: FoxyMode;
  readonly subject: Subject;
  readonly chapterId: string | null;
  readonly language: LanguageCode;
  readonly startedAt: Date;
  /** D-401. `null` when the caller sent no usable `X-Visit-Id`. */
  readonly visitId: string | null;
}

export interface NewMessage {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly action: FoxyAction | null;
  readonly citations: readonly Citation[];
  readonly abstained: boolean;
  readonly createdAt: Date;
}

export interface FoxyRepository {
  createSession(input: NewSession): Promise<SessionRecord>;
  findSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(
    studentUserId: string,
    tenantId: string,
    limit: number,
  ): Promise<readonly SessionRecord[]>;
  listMessages(sessionId: string, tenantId: string): Promise<readonly MessageRecord[]>;
  insertMessage(input: NewMessage): Promise<MessageRecord>;
  /** One transaction. See the header — this is why it is one method. */
  insertMessageWithTrace(
    input: NewMessage,
    trace: (messageId: string) => TraceInput,
  ): Promise<MessageRecord>;
  countTraces(messageId: string): Promise<number>;
  touchSession(sessionId: string, at: Date): Promise<void>;
}

interface SessionRow {
  id: string;
  studentUserId: string;
  tenantId: string;
  mode: string;
  subject: string;
  chapterId: string | null;
  language: string;
  startedAt: Date;
  lastMessageAt: Date | null;
}

/**
 * Maps a session row.
 *
 * `mode`, `subject` and `language` are CAST rather than re-validated. Each is
 * constrained by a CHECK in migration 0005 built from the same `shared/`
 * constant this file's types come from, so a row that violated one could not
 * have been inserted. Re-validating here would put the same rule in two places
 * with one of them eventually falling behind.
 */
function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    studentUserId: row.studentUserId,
    tenantId: row.tenantId,
    mode: row.mode as FoxyMode,
    subject: row.subject as Subject,
    chapterId: row.chapterId,
    language: row.language as LanguageCode,
    startedAt: row.startedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

interface MessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  action: string | null;
  citations: unknown;
  abstained: boolean;
  createdAt: Date;
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    action: row.action === null ? null : (row.action as FoxyAction),
    // The SHAPE is enforced by `domain/citations.ts` on the way in and by the
    // jsonb array CHECK in the database. `?? []` covers a NULL that the NOT NULL
    // constraint makes impossible — cheap, and the alternative is a crash in a
    // transcript render.
    citations: (row.citations ?? []) as Citation[],
    abstained: row.abstained,
    createdAt: row.createdAt,
  };
}

export function createFoxyRepository(handle: FoxyDbHandle): FoxyRepository {
  // `handle.db` is the drizzle client and `handle.withTransaction` is the only
  // way a transaction is opened in this codebase. Bound locally so every query
  // below reads the same as it does in every other repository.
  const db = handle.db;

  async function insertMessageRow(
    executor: DbExecutor,
    input: NewMessage,
  ): Promise<MessageRecord> {
    const [row] = await executor
      .insert(chatMessages)
      .values({
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        role: input.role,
        content: input.content,
        action: input.action,
        citations: [...input.citations],
        abstained: input.abstained,
        createdAt: input.createdAt,
      })
      .returning();

    if (row === undefined) {
      throw new Error('foxy repository: message insert returned no row');
    }
    return toMessageRecord(row);
  }

  return {
    async createSession(input: NewSession): Promise<SessionRecord> {
      const [row] = await db
        .insert(chatSessions)
        .values({
          studentUserId: input.studentUserId,
          tenantId: input.tenantId,
          mode: input.mode,
          subject: input.subject,
          chapterId: input.chapterId,
          language: input.language,
          startedAt: input.startedAt,
          visitId: input.visitId,
        })
        .returning();

      if (row === undefined) {
        throw new Error('foxy repository: session insert returned no row');
      }
      return toSessionRecord(row);
    },

    /**
     * BY ID ALONE, with no tenant predicate — deliberately.
     *
     * The service authorises against the tenant ON THE ROW, which is the
     * strongest available form of "the tenant comes from the data": it is the
     * tenant the session was actually filed under, not one looked up beside it.
     * Filtering here instead would turn a cross-tenant read into a 404, and a
     * 404 that depends on the caller's tenant is a session-existence oracle.
     * `practice.loadSession` takes the same shape for the same reason.
     */
    async findSession(sessionId: string): Promise<SessionRecord | null> {
      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
      return row === undefined ? null : toSessionRecord(row);
    },

    async listSessions(
      studentUserId: string,
      tenantId: string,
      limit: number,
    ): Promise<readonly SessionRecord[]> {
      const rows = await db
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.studentUserId, studentUserId),
            eq(chatSessions.tenantId, tenantId),
          ),
        )
        .orderBy(desc(chatSessions.startedAt))
        .limit(limit);
      return rows.map(toSessionRecord);
    },

    async listMessages(sessionId: string, tenantId: string): Promise<readonly MessageRecord[]> {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.tenantId, tenantId)))
        /**
         * OLDEST FIRST, BY `seq` AND NOT BY `created_at`.
         *
         * A transcript is read in the order it happened and the prompt's
         * history window slices the END of this list, so the order is
         * load-bearing twice. `created_at` cannot express it: a question and
         * its reply can share a millisecond — always under a fixed clock,
         * intermittently in production — and the rows then come back in
         * whatever order the plan produced. `seq` is the insertion order and
         * is what "oldest first" actually means here.
         */
        .orderBy(asc(chatMessages.seq));
      return rows.map(toMessageRecord);
    },

    async insertMessage(input: NewMessage): Promise<MessageRecord> {
      return await insertMessageRow(db, input);
    },

    async insertMessageWithTrace(
      input: NewMessage,
      trace: (messageId: string) => TraceInput,
    ): Promise<MessageRecord> {
      return await handle.withTransaction(async (tx) => {
        const message = await insertMessageRow(tx, input);
        const row = trace(message.id);
        await tx.insert(retrievalTraces).values({
          messageId: row.messageId,
          tenantId: row.tenantId,
          query: row.query,
          rewrittenQuery: row.rewrittenQuery,
          grade: row.grade,
          subject: row.subject,
          retrieved: [...row.retrieved],
          citations: [...row.citations],
          fabricatedCitations: [...row.fabricatedCitations],
          prompt: row.prompt,
          answer: row.answer,
          abstained: row.abstained,
          abstainReason: row.abstainReason,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          latencyMs: row.latencyMs,
        });
        return message;
      });
    },

    /** Used by the test that asserts one trace exists per turn. */
    async countTraces(messageId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(retrievalTraces)
        .where(eq(retrievalTraces.messageId, messageId));
      return row?.count ?? 0;
    },

    async touchSession(sessionId: string, at: Date): Promise<void> {
      await db
        .update(chatSessions)
        .set({ lastMessageAt: at })
        .where(eq(chatSessions.id, sessionId));
    },
  };
}
