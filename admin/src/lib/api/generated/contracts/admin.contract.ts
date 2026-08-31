/**
 * GENERATED — DO NOT EDIT.
 *
 * Source of truth: backend/src/shared/. Regenerate with
 * `npm run contracts:sync` from `admin/`. `contracts-drift.test.ts`
 * fails when this file and its backend original disagree.
 */

import { z } from 'zod';

/**
 * The admin wire contract — the operations surface, defined once.
 *
 * ===========================================================================
 * THIS FOLDER IS COPIED INTO A BROWSER BUNDLE. That is true of every file here
 * and it is the reason `practice.contract.ts` carries no `correctIndex`; the
 * same rule bites differently on this one.
 *
 * The admin app is not public, but "not public" is a deployment posture and
 * this is a type declaration — the two have different lifetimes. So the shapes
 * below name only what an operator is allowed to see, and the MASKED variants
 * are the default rather than the exception. A field that arrives here raw
 * arrives raw in a browser, and the reveal endpoint exists precisely so that
 * unmasking is a request somebody makes on the record rather than a property of
 * a list they happened to open.
 * ===========================================================================
 *
 * ===========================================================================
 * EVERYTHING HERE IS A READ. There is no mutation shape in this file and there
 * is not meant to be one. `POST /admin/monitoring/dry-run` is the only POST and
 * it writes nothing — it is a POST because it EXECUTES, and that cost should be
 * visible at the call site rather than hidden behind a GET that looks free.
 * ===========================================================================
 */

/** A UUID path parameter. */
export const adminIdParamSchema = z.object({ id: z.string().uuid() });
export type AdminIdParam = z.infer<typeof adminIdParamSchema>;

/**
 * Keyset pagination, matching the shape already used on notifications.
 *
 * `cursor` is opaque to the caller on purpose. It encodes the ordering columns
 * of the row it points at, and a client that parsed it would be depending on an
 * ordering the server must stay free to change.
 */
export const adminPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type AdminPageQuery = z.infer<typeof adminPageQuerySchema>;

// ============================================================================
// MONITORING
// ============================================================================

/**
 * One alert signal as an operator sees it.
 *
 * `value` IS NULLABLE AND THAT IS THE INTERESTING CASE. A signal that could not
 * be measured this cycle disables every rule watching it, silently — which
 * looks exactly like a healthy signal unless the difference is on the wire.
 * `failureReason` carries why, and the UI is required to render an unmeasured
 * signal differently from a quiet one.
 */
export const adminSignalSchema = z.object({
  name: z.string(),
  value: z.number().nullable(),
  failureReason: z.string().nullable(),
  /** The rule ids that watch this signal. Empty means nothing does — an orphan. */
  watchedBy: z.array(z.string()),
  range: z.object({ min: z.number(), max: z.number().nullable(), unit: z.string() }).nullable(),
});
export type AdminSignal = z.infer<typeof adminSignalSchema>;

export const adminSignalsResponseSchema = z.object({
  signals: z.array(adminSignalSchema),
  /** The window the counting signals summed over, in minutes. */
  windowMinutes: z.number(),
  collectedAt: z.string(),
});
export type AdminSignalsResponse = z.infer<typeof adminSignalsResponseSchema>;

/** Both languages, because both are what would actually be delivered. */
export const bilingualSchema = z.object({ en: z.string(), hi: z.string() });

export const adminRuleSchema = z.object({
  id: z.string(),
  signal: z.string(),
  comparison: z.enum(['gte', 'lte']),
  threshold: z.number(),
  severity: z.enum(['page', 'ticket']),
  cooldownSeconds: z.number(),
  title: bilingualSchema,
  body: bilingualSchema,
  runbook: z.string(),
  /** Delivery order for this severity, from ALERT_CHANNEL_POLICY. */
  channels: z.array(z.string()),
});
export type AdminRule = z.infer<typeof adminRuleSchema>;

export const adminRulesResponseSchema = z.object({
  rules: z.array(adminRuleSchema),
  /**
   * Stated on the wire rather than left for the reader to know.
   *
   * `CooldownLedger` is an in-memory object owned by an evaluator PROCESS. Run
   * with `--loop` it works; run with `--once` from a cron it starts empty every
   * time, so a sustained breach pages on every tick regardless of the number in
   * `cooldownSeconds`. The panel shows cooldowns as CONFIGURED and says so,
   * because a live cooldown view would be a guess dressed as a fact.
   */
  cooldownsAreProcessLocal: z.literal(true),
});
export type AdminRulesResponse = z.infer<typeof adminRulesResponseSchema>;

export const adminDryRunResponseSchema = z.object({
  /** Rules that WOULD have fired. Nothing was delivered. */
  wouldFire: z.array(
    z.object({
      ruleId: z.string(),
      severity: z.enum(['page', 'ticket']),
      signal: z.string(),
      value: z.number(),
      threshold: z.number(),
      title: bilingualSchema,
      body: bilingualSchema,
      runbook: z.string(),
    }),
  ),
  /** Signals that could not be measured — see `adminSignalSchema.value`. */
  blindSpots: z.array(z.object({ signal: z.string(), reason: z.string() })),
  evaluatedRules: z.number(),
  windowMinutes: z.number(),
  ranAt: z.string(),
  /** Always false. On the wire so the UI can state it rather than imply it. */
  delivered: z.literal(false),
});
export type AdminDryRunResponse = z.infer<typeof adminDryRunResponseSchema>;

export const adminJobsResponseSchema = z.object({
  byStatus: z.array(z.object({ status: z.string(), kind: z.string(), count: z.number() })),
  deadLetters: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      attempts: z.number(),
      lastError: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
  /** Age of the oldest claimable job, in seconds. Null when the queue is empty. */
  oldestPendingSeconds: z.number().nullable(),
});
export type AdminJobsResponse = z.infer<typeof adminJobsResponseSchema>;

export const adminWorkersResponseSchema = z.object({
  workers: z.array(
    z.object({
      workerId: z.string(),
      status: z.string(),
      startedAt: z.string(),
      lastBeatAt: z.string(),
      ageSeconds: z.number(),
      jobsProcessed: z.number(),
      stale: z.boolean(),
    }),
  ),
  /**
   * ZERO WORKERS IS THE LOUDEST CASE, not the quietest. A fleet that never
   * started, one that died, and one cleanly stopped and never replaced are the
   * same outage to a learner waiting for a mastery update.
   */
  noneRunning: z.boolean(),
  /**
   * The threshold `stale` was computed against, in seconds.
   *
   * On the wire so a screen can NAME the number without keeping its own copy.
   * A second constant in the client is how a dashboard and a pager come to
   * disagree about one word while reading the same data.
   */
  staleAfterSeconds: z.number(),
});
export type AdminWorkersResponse = z.infer<typeof adminWorkersResponseSchema>;

export const adminMetricsResponseSchema = z.object({
  metrics: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      total: z.number(),
      occurrences: z.number(),
      lastRecordedAt: z.string(),
    }),
  ),
  windowMinutes: z.number(),
});
export type AdminMetricsResponse = z.infer<typeof adminMetricsResponseSchema>;

export const adminHealthResponseSchema = z.object({
  ready: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string().nullable(),
      durationMs: z.number().nullable(),
    }),
  ),
});
export type AdminHealthResponse = z.infer<typeof adminHealthResponseSchema>;

// ============================================================================
// OVERVIEW
// ============================================================================

export const adminOverviewResponseSchema = z.object({
  counts: z.object({
    users: z.number(),
    students: z.number(),
    parents: z.number(),
    practiceSessions: z.number(),
    chatSessions: z.number(),
    questions: z.number(),
    chapters: z.number(),
    /**
     * ACTIVE chunks only. `content/coverage` reports `chunks.total` over ALL of
     * them, so the two screens legitimately differ — the name says which is
     * which rather than leaving a reader to discover the gap by subtraction.
     */
    ragChunksActive: z.number(),
    activeSubscriptions: z.number(),
  }),
  firingNow: z.number(),
  blindSpots: z.number(),
  workersRunning: z.number(),
  jobsPending: z.number(),
  generatedAt: z.string(),
});
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;

// ============================================================================
// PEOPLE, LEARNING, MONEY AND THE RECORD
//
// EVERY SHAPE BELOW IS MASKED, and the masking happens in the service before
// these objects exist. There is no `email` field on the wire and no `content`
// field on a message — not a masked one, none. A field that is absent from this
// file cannot be leaked by a component that forgot to hide it.
//
// The unmasked value is reachable through `POST /admin/reveal`, one resource
// and one named field at a time, on the record.
// ============================================================================

/** The envelope every admin list shares. */
const pageOf = <T extends z.ZodTypeAny>(item: T): z.ZodObject<{
  items: z.ZodArray<T>;
  nextCursor: z.ZodNullable<z.ZodString>;
}> =>
  z.object({
    items: z.array(item),
    /** Null when this was the last page. */
    nextCursor: z.string().nullable(),
  });

export const adminUserSchema = z.object({
  id: z.string().uuid(),
  /** `a•••@e•••.test` — first character and TLD, never the local part. */
  emailMasked: z.string(),
  role: z.string(),
  tenantId: z.string().uuid(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUsersResponseSchema = pageOf(adminUserSchema);
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

export const adminUserDetailResponseSchema = z.object({
  user: adminUserSchema,
  /** Present only when the account has a learner profile. */
  learner: z
    .object({
      displayNameMasked: z.string(),
      grade: z.string(),
      board: z.string(),
      preferredLanguage: z.string(),
      subjects: z.array(z.string()),
    })
    .nullable(),
  counts: z.object({
    practiceSessions: z.number(),
    chatSessions: z.number(),
    sessions: z.number(),
  }),
});
export type AdminUserDetailResponse = z.infer<typeof adminUserDetailResponseSchema>;

/**
 * One learner's day, chat and practice together — the D-401 view.
 *
 * This is the endpoint that view was built for. Its comment said "operations
 * and psql, not a route"; an audited, role-gated, deliberately cross-tenant
 * admin route IS operations, and the comment has been amended to say so rather
 * than quietly contradicted.
 */
export const adminActivitySchema = z.object({
  kind: z.enum(['chat', 'practice']),
  refId: z.string().uuid(),
  visitId: z.string().uuid().nullable(),
  chapterId: z.string().uuid().nullable(),
  startedAt: z.string(),
  lastEventAt: z.string().nullable(),
  outcome: z.string(),
});
export type AdminActivity = z.infer<typeof adminActivitySchema>;

export const adminActivityResponseSchema = z.object({
  items: z.array(adminActivitySchema),
  /**
   * Distinct sittings for this learner over their WHOLE history — not this page.
   *
   * The page-local version was wrong in two directions: a visit spanning a page
   * boundary got counted twice by a reader walking pages, and a learner with
   * more visits than fit on a page was under-reported. The question is about
   * the learner, so it is asked of the learner.
   */
  visits: z.number(),
  /** Rows on THIS page that belong to no known sitting. See the service. */
  unattributedOnPage: z.number(),
  nextCursor: z.string().nullable(),
});
export type AdminActivityResponse = z.infer<typeof adminActivityResponseSchema>;

export const adminPracticeSessionSchema = z.object({
  id: z.string().uuid(),
  studentUserId: z.string().uuid(),
  chapterId: z.string().uuid(),
  visitId: z.string().uuid().nullable(),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  scorePercent: z.number().nullable(),
  xpEarned: z.number().nullable(),
  isValid: z.boolean().nullable(),
  invalidReason: z.string().nullable(),
  questionsServed: z.number(),
  targetQuestionCount: z.number(),
});
export type AdminPracticeSession = z.infer<typeof adminPracticeSessionSchema>;

export const adminPracticeSessionsResponseSchema = pageOf(adminPracticeSessionSchema);
export type AdminPracticeSessionsResponse = z.infer<typeof adminPracticeSessionsResponseSchema>;

export const adminChatSessionSchema = z.object({
  id: z.string().uuid(),
  studentUserId: z.string().uuid(),
  visitId: z.string().uuid().nullable(),
  mode: z.string(),
  subject: z.string(),
  chapterId: z.string().uuid().nullable(),
  language: z.string(),
  startedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  messageCount: z.number(),
  abstentions: z.number(),
});
export type AdminChatSession = z.infer<typeof adminChatSessionSchema>;

export const adminChatSessionsResponseSchema = pageOf(adminChatSessionSchema);
export type AdminChatSessionsResponse = z.infer<typeof adminChatSessionsResponseSchema>;

/**
 * A transcript with NO TRANSCRIPT IN IT.
 *
 * Role, length and timing per turn, and nothing else. A partial mask of prose
 * is not a mask — the opening characters of a child's message routinely carry
 * the name, the question and the distress.
 */
export const adminChatSessionDetailResponseSchema = z.object({
  session: adminChatSessionSchema,
  turns: z.array(
    z.object({
      /** Reaches the trace that explains this turn. See the service's note. */
      messageId: z.string().uuid(),
      role: z.string(),
      length: z.number(),
      createdAt: z.string(),
      action: z.string().nullable(),
      abstained: z.boolean(),
      citationCount: z.number(),
    }),
  ),
});
export type AdminChatSessionDetailResponse = z.infer<typeof adminChatSessionDetailResponseSchema>;

/**
 * The retrieval trace — the debugging surface, kept usable and kept redacted.
 *
 * `retrieval_traces` carries no student identifier by design, so reaching one
 * means going message -> session -> student, which is the audited path. The
 * numbers below are what actually explain a bad answer: which chunks were
 * retrieved, which citations survived verification, which were fabricated and
 * stripped, and whether the model was called at all.
 */
export const adminTraceResponseSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  grade: z.string(),
  subject: z.string(),
  model: z.string(),
  abstained: z.boolean(),
  abstainReason: z.string().nullable(),
  retrievedCount: z.number(),
  citationCount: z.number(),
  fabricatedCitationCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  latencyMs: z.number(),
  createdAt: z.string(),
  /** Shape only — presence and length. Never the text. */
  query: z.object({ present: z.boolean(), length: z.number() }),
  prompt: z.object({ present: z.boolean(), length: z.number() }),
  answer: z.object({ present: z.boolean(), length: z.number() }),
});
export type AdminTraceResponse = z.infer<typeof adminTraceResponseSchema>;

export const adminSubscriptionSchema = z.object({
  id: z.string().uuid(),
  subjectUserId: z.string().uuid(),
  /**
   * THE ENUMS, NOT `z.string()`.
   *
   * These were widened when this file was written and that was a mistake with a
   * cost: a screen colouring `past_due` amber has no way to know it has covered
   * every state, so a status added later renders silently uncoloured. The
   * database CHECK constraint is the closed set; the wire should say the same
   * thing the column does.
   */
  payerKind: z.enum(['user', 'school']),
  planCode: z.string(),
  status: z.enum(['pending', 'active', 'past_due', 'cancelled', 'expired']),
  provider: z.string(),
  amountMinorUnits: z.number(),
  currency: z.string(),
  currentPeriodEnd: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminSubscription = z.infer<typeof adminSubscriptionSchema>;

export const adminSubscriptionsResponseSchema = pageOf(adminSubscriptionSchema);
export type AdminSubscriptionsResponse = z.infer<typeof adminSubscriptionsResponseSchema>;

export const adminAuditEntrySchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorRole: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  tenantId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
});
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;

export const adminAuditResponseSchema = pageOf(adminAuditEntrySchema);
export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;

/**
 * WHERE THE CONTENT IS THIN — the report `ops:status` computes and nothing
 * surfaces.
 *
 * A feature looks built and behaves empty when the columns behind it are NULL.
 * D-077 is the standing example: `distractor_misconceptions` is NULL on every
 * imported question, so misconception remediation is wired end to end and has
 * nothing to say. This makes that visible without running a script.
 */
export const adminContentCoverageResponseSchema = z.object({
  questions: z.object({
    total: z.number(),
    active: z.number(),
    heldOut: z.number(),
    withMisconceptions: z.number(),
  }),
  chapters: z.object({
    total: z.number(),
    withQuestions: z.number(),
    withConcepts: z.number(),
    withChunks: z.number(),
  }),
  chunks: z.object({ total: z.number(), embedded: z.number() }),
  byGradeSubject: z.array(
    z.object({
      grade: z.string(),
      subjectCode: z.string(),
      chapters: z.number(),
      questions: z.number(),
    }),
  ),
});
export type AdminContentCoverageResponse = z.infer<typeof adminContentCoverageResponseSchema>;

// ============================================================================
// REVEAL — the one road to an unmasked value.
//
// The request names ONE resource and the fields wanted from it, and carries a
// reason from a closed set. The response carries exactly those fields and
// nothing else. Both halves are deliberate: a reveal that returned the whole
// row would make "reveal one field" impossible to audit honestly.
// ============================================================================

export const REVEAL_REASONS = [
  'support_request',
  'incident',
  'data_request',
  'quality_review',
  'abuse_report',
] as const;

export const revealRequestSchema = z.object({
  resourceType: z.enum(['user', 'learner', 'chat_session', 'retrieval_trace']),
  resourceId: z.string().uuid(),
  fields: z.array(z.string().min(1).max(64)).min(1).max(8),
  /**
   * A CODE, NOT PROSE. `audit_log.metadata` is identifiers and counts only, and
   * a typed justification is free text — which during an incident is exactly
   * where a learner's name ends up. See `domain/reveal.ts`.
   */
  reasonCode: z.enum(REVEAL_REASONS),
});
export type RevealRequest = z.infer<typeof revealRequestSchema>;

export const revealResponseSchema = z.object({
  resourceType: z.string(),
  resourceId: z.string().uuid(),
  /** Only the fields asked for. A string, or an array for a transcript. */
  revealed: z.record(z.union([z.string(), z.array(z.string())])),
  reasonCode: z.string(),
  /** Echoed so the UI can show what was written down, not just what was shown. */
  auditedAs: z.literal('admin.revealed'),
});
export type RevealResponse = z.infer<typeof revealResponseSchema>;
