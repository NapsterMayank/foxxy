import type { AuditPort } from '@/platform/audit/index';
import { NotFoundError, ValidationError } from '@/platform/errors/index';
import type {
  AdminActivityResponse,
  AdminAuditResponse,
  AdminChatSessionDetailResponse,
  AdminChatSessionsResponse,
  AdminContentCoverageResponse,
  AdminPracticeSessionsResponse,
  AdminSubscriptionsResponse,
  AdminTraceResponse,
  AdminUserDetailResponse,
  AdminUsersResponse,
  RevealRequest,
  RevealResponse,
} from '@/shared/contracts/admin.contract';
import type { AdminDataRepository, TraceRow } from './admin.data.repository';
import { decodeCursor, nextCursor, type Cursor } from './domain/cursor';
import { maskEmail, maskName, redactText } from './domain/masking';
import { isRevealable, type RevealResourceType } from './domain/reveal';
import type { AdminActor } from './admin.types';

/**
 * =============================================================================
 * admin — THE DATA READS, MASKED HERE AND NOWHERE ELSE.
 *
 * The repository returns raw rows. This layer is the only place they are turned
 * into DTOs, and every DTO it produces is already masked. There is no unmasked
 * response shape in the contract for these routes, so a component cannot
 * accidentally render one and a network tab cannot contain one.
 *
 * The reveal endpoint is the deliberate exception and it lives in its own
 * method with its own audit action — because the difference between "an
 * operator can see this" and "an operator saw this and said why" is the entire
 * privacy story of this panel.
 * =============================================================================
 */

/** The driver hands back `Date` or wire text for a `timestamptz` (D-305). */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string): string {
  return toDate(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * One trace row to its redacted DTO.
 *
 * SHARED BY BOTH TRACE PATHS — by id and by message id — rather than mapped
 * twice. Two mappings of one row is how a field ends up redacted on one route
 * and raw on the other, and the one that leaks is whichever was added second by
 * somebody copying the first and editing it.
 */
function toTrace(row: TraceRow): AdminTraceResponse {
  return {
    id: row.id,
    messageId: row.message_id,
    grade: row.grade,
    subject: row.subject,
    model: row.model,
    abstained: row.abstained,
    abstainReason: row.abstain_reason,
    retrievedCount: row.retrieved_count,
    citationCount: row.citation_count,
    fabricatedCitationCount: row.fabricated_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    createdAt: toIso(row.created_at),
    // Shape only — presence and length. Never the text.
    query: redactText(row.query),
    prompt: redactText(row.prompt),
    answer: redactText(row.answer),
  };
}

/** A page request, already validated by the route's schema. */
export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface AdminDataService {
  users(actor: AdminActor, page: PageRequest): Promise<AdminUsersResponse>;
  user(actor: AdminActor, id: string): Promise<AdminUserDetailResponse>;
  activity(actor: AdminActor, learnerId: string, page: PageRequest): Promise<AdminActivityResponse>;
  practiceSessions(
    actor: AdminActor,
    page: PageRequest,
    studentUserId: string | null,
  ): Promise<AdminPracticeSessionsResponse>;
  chatSessions(
    actor: AdminActor,
    page: PageRequest,
    studentUserId: string | null,
  ): Promise<AdminChatSessionsResponse>;
  chatSession(actor: AdminActor, id: string): Promise<AdminChatSessionDetailResponse>;
  trace(actor: AdminActor, id: string): Promise<AdminTraceResponse>;
  traceByMessage(actor: AdminActor, messageId: string): Promise<AdminTraceResponse>;
  subscriptions(actor: AdminActor, page: PageRequest): Promise<AdminSubscriptionsResponse>;
  audit(actor: AdminActor, page: PageRequest): Promise<AdminAuditResponse>;
  contentCoverage(actor: AdminActor): Promise<AdminContentCoverageResponse>;
  reveal(actor: AdminActor, request: RevealRequest): Promise<RevealResponse>;
}

export interface AdminDataServiceDeps {
  readonly repository: AdminDataRepository;
  readonly audit: AuditPort;
}

export function createAdminDataService(deps: AdminDataServiceDeps): AdminDataService {
  const { repository, audit } = deps;

  const record = async (
    actor: AdminActor,
    resourceType: string,
    resourceId: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    await audit.record({
      actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
      action: 'admin.read',
      resourceType,
      resourceId,
      metadata,
    });
  };

  /** `undefined` cursor means the first page; anything else must decode. */
  const cursorOf = (page: PageRequest): Cursor | null =>
    page.cursor === undefined ? null : decodeCursor(page.cursor);

  const asKeyset = (cursor: Cursor | null): { at: Date; id: string } | null =>
    cursor === null ? null : { at: cursor.createdAt, id: cursor.id };

  return {
    async users(actor, page): Promise<AdminUsersResponse> {
      const rows = await repository.users(page.limit, asKeyset(cursorOf(page)));
      await record(actor, 'users', null, { count: rows.length });

      const items = rows.map((row) => ({
        id: row.id,
        emailMasked: maskEmail(row.email),
        role: row.role,
        tenantId: row.tenant_id,
        emailVerified: row.email_verified_at !== null,
        createdAt: toIso(row.created_at),
      }));

      return {
        items,
        nextCursor: nextCursor(
          rows.map((row) => ({ createdAt: toDate(row.created_at), id: row.id })),
          page.limit,
        ),
      };
    },

    async user(actor, id): Promise<AdminUserDetailResponse> {
      const row = await repository.user(id);
      if (row === null) throw new NotFoundError('Not found.');

      const [learner, counts] = await Promise.all([
        repository.learner(id),
        repository.userCounts(id),
      ]);

      await record(actor, 'user', id, {
        hasLearnerProfile: learner !== null,
        practiceSessions: counts.practiceSessions,
        chatSessions: counts.chatSessions,
      });

      return {
        user: {
          id: row.id,
          emailMasked: maskEmail(row.email),
          role: row.role,
          tenantId: row.tenant_id,
          emailVerified: row.email_verified_at !== null,
          createdAt: toIso(row.created_at),
        },
        learner:
          learner === null
            ? null
            : {
                displayNameMasked: maskName(learner.display_name),
                grade: learner.grade,
                board: learner.board,
                preferredLanguage: learner.preferred_language,
                subjects: learner.subjects ?? [],
              },
        counts,
      };
    },

    /**
     * ONE LEARNER'S DAY, CHAT AND PRACTICE TOGETHER — the D-401 view.
     *
     * `visits` counts DISTINCT non-null visit ids in the page, which is the
     * number the whole column exists to produce: "four activities, two
     * sittings" rather than "four things at some point on Tuesday". Nulls are
     * excluded rather than counted as one shared visit — a row written before
     * D-401, or by a client that sent no header, belongs to a visit nobody
     * knows, and lumping them together would invent a sitting.
     */
    async activity(actor, learnerId, page): Promise<AdminActivityResponse> {
      const [rows, visits] = await Promise.all([
        repository.activity(learnerId, page.limit, asKeyset(cursorOf(page))),
        repository.visitCount(learnerId),
      ]);
      // Rows the view cannot attribute to any sitting: written before D-401, or
      // by a caller that sent no header. Reported SEPARATELY rather than folded
      // into `visits`, because lumping unknowns together would invent a sitting
      // that never happened.
      const unattributed = rows.filter((row) => row.visit_id === null).length;

      await record(actor, 'learner.activity', learnerId, {
        count: rows.length,
        visits,
        unattributed,
      });

      return {
        items: rows.map((row) => ({
          kind: row.kind === 'chat' ? ('chat' as const) : ('practice' as const),
          refId: row.ref_id,
          visitId: row.visit_id,
          chapterId: row.chapter_id,
          startedAt: toIso(row.started_at),
          lastEventAt: toIsoOrNull(row.last_event_at),
          outcome: row.outcome,
        })),
        visits,
        unattributedOnPage: unattributed,
        nextCursor: nextCursor(
          rows.map((row) => ({ createdAt: toDate(row.started_at), id: row.ref_id })),
          page.limit,
        ),
      };
    },

    async practiceSessions(actor, page, studentUserId): Promise<AdminPracticeSessionsResponse> {
      const rows = await repository.practiceSessions(
        page.limit,
        asKeyset(cursorOf(page)),
        studentUserId,
      );
      await record(actor, 'practice.sessions', studentUserId, { count: rows.length });

      return {
        items: rows.map((row) => ({
          id: row.id,
          studentUserId: row.student_user_id,
          chapterId: row.chapter_id,
          visitId: row.visit_id,
          startedAt: toIso(row.started_at),
          submittedAt: toIsoOrNull(row.submitted_at),
          scorePercent: row.score_percent,
          xpEarned: row.xp_earned,
          isValid: row.is_valid,
          invalidReason: row.invalid_reason,
          questionsServed: row.questions_served,
          targetQuestionCount: row.target_question_count,
        })),
        /**
         * KEYED ON `started_at`, MATCHING THE ORDER BY — D-403.
         *
         * The list used to order by `created_at` while the only index on this
         * table was `(student_user_id, started_at DESC)`. Two timestamps, one
         * index, the wrong one named, and a sequential scan on every page.
         *
         * `started_at` is also the more honest column: it is written from the
         * injected clock at the moment the session begins, where `created_at`
         * is a row-insert default. A cursor must key on whatever the ORDER BY
         * uses or it skips and repeats rows.
         */
        nextCursor: nextCursor(
          rows.map((row) => ({ createdAt: toDate(row.started_at), id: row.id })),
          page.limit,
        ),
      };
    },

    async chatSessions(actor, page, studentUserId): Promise<AdminChatSessionsResponse> {
      const rows = await repository.chatSessions(
        page.limit,
        asKeyset(cursorOf(page)),
        studentUserId,
      );
      await record(actor, 'foxy.sessions', studentUserId, { count: rows.length });

      return {
        items: rows.map((row) => ({
          id: row.id,
          studentUserId: row.student_user_id,
          visitId: row.visit_id,
          mode: row.mode,
          subject: row.subject,
          chapterId: row.chapter_id,
          language: row.language,
          startedAt: toIso(row.started_at),
          lastMessageAt: toIsoOrNull(row.last_message_at),
          messageCount: Number(row.message_count),
          abstentions: Number(row.abstentions),
        })),
        nextCursor: nextCursor(
          rows.map((row) => ({ createdAt: toDate(row.started_at), id: row.id })),
          page.limit,
        ),
      };
    },

    /**
     * A TRANSCRIPT WITH NO TRANSCRIPT IN IT.
     *
     * The turns come back with role, length, timing, which button produced them
     * and whether Foxy abstained — everything needed to see the SHAPE of a
     * conversation that went wrong. The text itself is never put on the wire,
     * and there is no field on the response that could hold it.
     */
    async chatSession(actor, id): Promise<AdminChatSessionDetailResponse> {
      const row = await repository.chatSession(id);
      if (row === null) throw new NotFoundError('Not found.');

      const turns = await repository.chatTurns(id);
      await record(actor, 'foxy.session', id, { turns: turns.length });

      return {
        session: {
          id: row.id,
          studentUserId: row.student_user_id,
          visitId: row.visit_id,
          mode: row.mode,
          subject: row.subject,
          chapterId: row.chapter_id,
          language: row.language,
          startedAt: toIso(row.started_at),
          lastMessageAt: toIsoOrNull(row.last_message_at),
          messageCount: Number(row.message_count),
          abstentions: Number(row.abstentions),
        },
        turns: turns.map((turn) => ({
          /**
           * THE JOIN THAT WAS MISSING IN ONE DIRECTION.
           *
           * A trace carries its `messageId`, so trace -> message worked. The
           * turn carried no id, so message -> trace did not — an operator who
           * spotted an abstained, zero-citation turn could not open the trace
           * that explains it, and had to go and find a trace id in the logs.
           * That is the single most likely reason to be on this screen at all.
           */
          messageId: turn.id,
          role: turn.role,
          length: turn.content.length,
          createdAt: toIso(turn.created_at),
          action: turn.action,
          abstained: turn.abstained,
          citationCount: turn.citation_count,
        })),
      };
    },

    /**
     * THE DEBUGGING SURFACE, KEPT USABLE AND KEPT REDACTED.
     *
     * `retrieval_traces` deliberately carries no student identifier, so this row
     * is already pseudonymous — reaching it means going message -> session ->
     * student, which is itself an audited path. What survives is the numbers
     * that actually explain a bad answer: how many chunks were retrieved, how
     * many citations survived verification, how many the model invented and had
     * stripped, and whether it abstained.
     *
     * The three text columns become shapes. `prompt` in particular is the most
     * useful column in the table and is a template full of textbook passages
     * and learner context; its LENGTH is a real signal and its content is not
     * ours to display on a dashboard.
     */
    async trace(actor, id): Promise<AdminTraceResponse> {
      const row = await repository.trace(id);
      if (row === null) throw new NotFoundError('Not found.');

      await record(actor, 'foxy.trace', id, {
        abstained: row.abstained,
        fabricated: row.fabricated_count,
      });

      return toTrace(row);
    },

    /**
     * The same trace, reached from the turn that produced it.
     *
     * Shares `toTrace` with `trace()` rather than mapping twice — two mappings
     * of one row is how a field gets redacted on one path and not the other.
     */
    async traceByMessage(actor, messageId): Promise<AdminTraceResponse> {
      const row = await repository.traceByMessage(messageId);
      if (row === null) throw new NotFoundError('Not found.');

      await record(actor, 'foxy.trace', row.id, {
        viaMessage: true,
        abstained: row.abstained,
        fabricated: row.fabricated_count,
      });
      return toTrace(row);
    },

    async subscriptions(actor, page): Promise<AdminSubscriptionsResponse> {
      const rows = await repository.subscriptions(page.limit, asKeyset(cursorOf(page)));
      await record(actor, 'billing.subscriptions', null, { count: rows.length });

      return {
        items: rows.map((row) => ({
          id: row.id,
          subjectUserId: row.subject_user_id,
          payerKind: row.payer_kind,
          planCode: row.plan_code,
          status: row.status,
          provider: row.provider,
          amountMinorUnits: row.amount_minor_units,
          currency: row.currency,
          currentPeriodEnd: toIsoOrNull(row.current_period_end),
          cancelledAt: toIsoOrNull(row.cancelled_at),
          createdAt: toIso(row.created_at),
        })),
        nextCursor: nextCursor(
          rows.map((row) => ({ createdAt: toDate(row.created_at), id: row.id })),
          page.limit,
        ),
      };
    },

    /**
     * THE AUDIT LOG, INCLUDING THIS READ OF IT.
     *
     * Reading the record is itself recorded, one row later. That is not a
     * curiosity: an operator who could review the trail without appearing in it
     * would have a blind spot shaped exactly like themselves.
     *
     * `metadata` is passed through UNCHANGED and needs no masking, because the
     * column's contract is identifiers and counts only and `platform/audit`
     * scrubs on the way in. If PII were ever to appear here, masking it on read
     * would be treating the symptom — the fix is at the write.
     */
    async audit(actor, page): Promise<AdminAuditResponse> {
      const rows = await repository.auditEntries(page.limit, asKeyset(cursorOf(page)));
      await record(actor, 'audit', null, { count: rows.length });

      return {
        items: rows.map((row) => ({
          id: row.id,
          actorUserId: row.actor_user_id,
          actorRole: row.actor_role,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          tenantId: row.tenant_id,
          metadata: row.metadata,
          createdAt: toIso(row.created_at),
        })),
        nextCursor: nextCursor(
          rows.map((row) => ({ createdAt: toDate(row.created_at), id: row.id })),
          page.limit,
        ),
      };
    },

    async contentCoverage(actor): Promise<AdminContentCoverageResponse> {
      const [row, byGrade] = await Promise.all([
        repository.coverage(),
        repository.coverageByGradeSubject(),
      ]);

      await record(actor, 'content.coverage', null, {
        questions: Number(row.questions_total),
        withMisconceptions: Number(row.questions_with_misconceptions),
      });

      return {
        questions: {
          total: Number(row.questions_total),
          active: Number(row.questions_active),
          heldOut: Number(row.questions_held_out),
          withMisconceptions: Number(row.questions_with_misconceptions),
        },
        chapters: {
          total: Number(row.chapters_total),
          withQuestions: Number(row.chapters_with_questions),
          withConcepts: Number(row.chapters_with_concepts),
          withChunks: Number(row.chapters_with_chunks),
        },
        chunks: {
          total: Number(row.chunks_total),
          embedded: Number(row.chunks_embedded),
        },
        byGradeSubject: byGrade.map((entry) => ({
          grade: entry.grade,
          subjectCode: entry.subject_code,
          chapters: Number(entry.chapters),
          questions: Number(entry.questions),
        })),
      };
    },
    /**
     * =========================================================================
     * THE ONE ROAD TO AN UNMASKED VALUE.
     *
     * Order matters here and is not incidental:
     *
     *   1. THE FIELD MATRIX IS CHECKED FIRST, before any row is loaded. An
     *      unknown pairing is refused while the sensitive value is still in the
     *      database rather than in this process's memory.
     *   2. The value is loaded, one narrow query per field.
     *   3. THE AUDIT ROW IS WRITTEN BEFORE THE RESPONSE IS BUILT. `record()`
     *      never throws by contract, so this cannot fail the request — but the
     *      ordering still matters for the reader of this code: there is no
     *      branch on which a value is returned and the writing-down is skipped.
     *
     * WHAT THE AUDIT ROW SAYS: who, which resource, which FIELDS, and the
     * reason code. Not the value — writing the revealed email into the audit
     * log would defeat the entire mechanism by making the log a second copy of
     * everything anybody ever looked at.
     * =========================================================================
     */
    async reveal(actor, request): Promise<RevealResponse> {
      // The zod enum and the reveal matrix are the same closed set by
      // construction, so no cast is needed — and if they ever drift, this line
      // is where the compiler says so.
      const resourceType: RevealResourceType = request.resourceType;

      for (const field of request.fields) {
        if (!isRevealable(resourceType, field)) {
          throw new ValidationError('That field cannot be revealed.', {
            message: `admin.reveal: ${resourceType}.${field} is not in the reveal matrix`,
          });
        }
      }

      const revealed: Record<string, string | string[]> = {};

      for (const field of request.fields) {
        if (resourceType === 'user' && field === 'email') {
          const email = await repository.revealUserEmail(request.resourceId);
          if (email === null) throw new NotFoundError('Not found.');
          revealed[field] = email;
        } else if (resourceType === 'learner' && field === 'displayName') {
          const name = await repository.revealLearnerName(request.resourceId);
          if (name === null) throw new NotFoundError('Not found.');
          revealed[field] = name;
        } else if (resourceType === 'chat_session' && field === 'transcript') {
          const lines = await repository.revealTranscript(request.resourceId);
          revealed[field] = [...lines];
        } else if (resourceType === 'retrieval_trace') {
          const trace = await repository.revealTrace(request.resourceId);
          if (trace === null) throw new NotFoundError('Not found.');
          revealed[field] = trace[field as 'query' | 'prompt' | 'answer'];
        }
      }

      await audit.record({
        actor: { userId: actor.userId, role: actor.role, tenantId: actor.tenantId },
        action: 'admin.revealed',
        resourceType,
        resourceId: request.resourceId,
        // FIELD NAMES AND A REASON CODE. Never the value — an audit log that
        // recorded what was revealed would be a second copy of everything
        // anybody ever looked at, with weaker access control than the first.
        metadata: { fields: [...request.fields], reasonCode: request.reasonCode },
      });

      return {
        resourceType,
        resourceId: request.resourceId,
        revealed,
        reasonCode: request.reasonCode,
        auditedAs: 'admin.revealed',
      };
    },
  };
}
