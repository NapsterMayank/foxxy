import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

/**
 * audit_log — 05-ROADMAP.md §8, and Phase 4's "audited 'view as', complete
 * audit log".
 *
 * ===========================================================================
 * APPEND-ONLY, AND ENFORCED BY A TRIGGER RATHER THAN BY CONVENTION.
 *
 * `question_responses` is append-only by convention, and its header explains
 * why that was the right call there: one writer, and a trigger would have had
 * to exempt an FK cascade. NEITHER holds here.
 *
 * Every module will eventually write to this table, so "one writer" is false on
 * day one. And an audit log's whole value is that it says what happened even
 * when the person reading it would rather it said something else — a log that
 * the application can UPDATE is a log that a bug, or a person with a database
 * connection, can quietly correct. Migration 0005 installs a BEFORE UPDATE and
 * a BEFORE DELETE trigger that raise unconditionally.
 *
 * TRUNCATE IS DELIBERATELY NOT BLOCKED, and this is a decision rather than an
 * oversight. TRUNCATE fires only statement-level triggers and requires table
 * ownership, which the application role does not hold in a real deployment. It
 * is therefore already a DBA-only operation, and it is the only mechanism left
 * for retention and for resetting a test database — since DELETE, the obvious
 * alternative, is now refused. Blocking it would leave the table with no legal
 * way to ever shrink.
 *
 * ===========================================================================
 * NO PII. EVER. `metadata` HOLDS IDENTIFIERS AND COUNTS.
 *
 * This is not a style preference. The table records actions taken against
 * MINORS' accounts and is the artefact you hand a school or a regulator; the
 * moment it contains an email address or a phone number it becomes a
 * subject-access-request liability and a breach amplifier — the one table that
 * is never deleted is the worst possible place to keep personal data.
 *
 * The rule is enforced in code, not by hope: `platform/audit` scrubs every
 * metadata payload through `platform/pii` before the insert, dropping
 * PII-shaped KEYS outright and redacting PII-shaped VALUES. A test drives an
 * email address and a phone number through `record()` and asserts neither
 * reaches the row.
 *
 * ===========================================================================
 * `actor_user_id` HAS NO FOREIGN KEY, and that is load-bearing.
 *
 * With `ON DELETE CASCADE`, deleting a user would delete their audit trail —
 * which is the one thing an audit log must not do, and it would additionally
 * be a DELETE, which the trigger refuses, so account deletion would fail.
 * `ON DELETE SET NULL` fails the same way: it is an UPDATE. Any referential
 * action at all turns "delete my account" into "the audit trigger raised", so
 * the column is a bare uuid and the trail outlives the actor.
 *
 * `tenant_id` keeps its foreign key: it is `ON DELETE RESTRICT`, which never
 * writes to this table, and a tenant with audit history should not be
 * deletable anyway.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for system actions — the worker has no user. See the note above. */
    actorUserId: uuid('actor_user_id'),
    /** Denormalised: the role AT THE TIME, which a later role change must not rewrite. */
    actorRole: text('actor_role'),
    /** Dotted and past-tense: `identity.password_reset`, `identity.link_revoked`. */
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    /** Text, not uuid: some resources are keyed by a code or a composite. */
    resourceId: text('resource_id'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('audit_log_action_check', sql`length(btrim(${table.action})) > 0`),
    check('audit_log_resource_type_check', sql`length(btrim(${table.resourceType})) > 0`),
    // `metadata` must be an OBJECT. A bare array or scalar is still legal jsonb
    // and would break every `metadata->>'key'` read with a type error rather
    // than a null.
    check('audit_log_metadata_object_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    /** "What happened in this tenant, newest first" — the compliance read. */
    index('audit_log_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    /** "What did this person do" — the support and investigation read. */
    index('audit_log_actor_created_idx').on(table.actorUserId, table.createdAt.desc()),
    /** "What happened to this thing" — the per-resource history read. */
    index('audit_log_resource_idx').on(table.resourceType, table.resourceId),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
