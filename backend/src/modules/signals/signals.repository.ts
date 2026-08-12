import { and, asc, desc, eq, gte, isNotNull, lte } from 'drizzle-orm';
import type { DbHandle } from '@/platform/db/index';
import { practiceResponses, practiceSessions } from '@/platform/db/schema/practice';
import type { AnomalyWindow, ResponseFact, SessionFact } from './signals.types';

/**
 * ALL database access for `signals` — §7, rule 4.
 *
 * ===========================================================================
 * IT READS `practice`'s TABLES AND CALLS NONE OF `practice`'s CODE.
 *
 * That is the convention this codebase already runs (`retrieval` reads
 * `rag_chunks`, which `content` owns): a repository may read a table, but the
 * module boundary forbids reaching into another module's functions. The one
 * piece of `practice` LOGIC that `signals` needs — the anti-cheat floor and
 * verdict — arrives as an injected edge instead of being reimplemented here.
 *
 * ===========================================================================
 * ONLY SUBMITTED SESSIONS. `submitted_at is not null`.
 *
 * An open session is a student mid-practice. Counting it would make every rule
 * fire on somebody who is using the product at that moment, which is the exact
 * inverse of what these rules are for.
 *
 * ===========================================================================
 * `lastActivityAt` IS QUERIED SEPARATELY AND WITHOUT THE WINDOW, DELIBERATELY.
 *
 * Inactivity is the one rule whose evidence is necessarily OUTSIDE the window: a
 * student who last practised five weeks ago has nothing in a one-week window, and
 * an empty window is also what a brand-new account looks like. Two different
 * facts, one empty list — so the last submission is fetched unbounded, and the
 * rules can tell "stopped" from "never started".
 */

export type SignalsDbHandle = DbHandle;

export interface SignalsRepository {
  /** Submitted sessions in the window, OLDEST FIRST, with their responses attached. */
  listSessionsInWindow(studentUserId: string, window: AnomalyWindow): Promise<SessionFact[]>;
  /** The most recent submission at ANY time, or null for a student with no history. */
  getLastActivityAt(studentUserId: string): Promise<Date | null>;
}

export function createSignalsRepository(handle: SignalsDbHandle): SignalsRepository {
  const { db } = handle;

  return {
    async listSessionsInWindow(
      studentUserId: string,
      window: AnomalyWindow,
    ): Promise<SessionFact[]> {
      const sessions = await db
        .select({
          sessionId: practiceSessions.id,
          chapterId: practiceSessions.chapterId,
          submittedAt: practiceSessions.submittedAt,
          scorePercent: practiceSessions.scorePercent,
          isValid: practiceSessions.isValid,
          questionIds: practiceSessions.questionIds,
        })
        .from(practiceSessions)
        .where(
          and(
            eq(practiceSessions.studentUserId, studentUserId),
            isNotNull(practiceSessions.submittedAt),
            gte(practiceSessions.submittedAt, window.from),
            lte(practiceSessions.submittedAt, window.to),
          ),
        )
        // Oldest first: `mastery_drop` compares ADJACENT sessions, so the order
        // is not presentation, it is the input to the rule.
        .orderBy(asc(practiceSessions.submittedAt), asc(practiceSessions.id));

      if (sessions.length === 0) {
        return [];
      }

      // One read for every response in the window, grouped in memory. The
      // alternative is a query per session, which is the N+1 this avoids; the
      // window is a handful of sessions per student, so the set is small.
      const responses = await db
        .select({
          sessionId: practiceResponses.sessionId,
          selectedIndex: practiceResponses.selectedIndex,
          timeSpentMs: practiceResponses.timeSpentMs,
        })
        .from(practiceResponses)
        .where(eq(practiceResponses.studentUserId, studentUserId));

      const bySession = new Map<string, ResponseFact[]>();
      for (const row of responses) {
        const bucket = bySession.get(row.sessionId) ?? [];
        bucket.push({ selectedIndex: row.selectedIndex, timeSpentMs: row.timeSpentMs });
        bySession.set(row.sessionId, bucket);
      }

      return sessions.map((session) => ({
        sessionId: session.sessionId,
        chapterId: session.chapterId,
        // Non-null by the `isNotNull` predicate above; the column type is still
        // nullable, and a cast would be a lie the compiler cannot check.
        submittedAt: session.submittedAt ?? new Date(0),
        scorePercent: session.scorePercent,
        isValid: session.isValid,
        questionCount: session.questionIds.length,
        responses: bySession.get(session.sessionId) ?? [],
      }));
    },

    async getLastActivityAt(studentUserId: string): Promise<Date | null> {
      const rows = await db
        .select({ submittedAt: practiceSessions.submittedAt })
        .from(practiceSessions)
        .where(
          and(
            eq(practiceSessions.studentUserId, studentUserId),
            isNotNull(practiceSessions.submittedAt),
          ),
        )
        .orderBy(desc(practiceSessions.submittedAt))
        .limit(1);

      return rows[0]?.submittedAt ?? null;
    },
  };
}
