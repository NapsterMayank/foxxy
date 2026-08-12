import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * tenants — 05-ROADMAP.md §8, the `tenant_id` hook.
 *
 * ===========================================================================
 * WHY THIS LANDS NOW, BEFORE ANY OF IT IS USED.
 *
 * The roadmap is blunt about it: `tenant_id` "is the one item on this roadmap
 * that is genuinely expensive to retrofit. Adding it to every table after real
 * student data exists means a migration across every row, every query and every
 * authorisation check, with no safe intermediate state."
 *
 * The "no safe intermediate state" half is the part that costs money. A
 * retrofit has to add the column, backfill it, make it NOT NULL, and repoint
 * every query and every authorisation decision — and between the first and the
 * last of those steps the system is running with SOME queries tenant-scoped and
 * some not. That window is where one school sees another school's students, and
 * it cannot be closed with a feature flag because it spans a schema change.
 *
 * Landing it before the first real row means there is no backfill, no window
 * and no ordering problem. The cost today is this file, six ALTER TABLEs and
 * one branch in `platform/authz`.
 *
 * ===========================================================================
 * NOT NULL, WITH A DEFAULT — tightened by migration 0008, decision D-073.
 *
 * The columns landed NULLABLE for one build cycle, on the argument that
 * requiring a tenant would force every insert path in three modules to change
 * on the same day. D-073 rejects that as a resting state: `tenant_id` was added
 * early to AVOID a migration across every table once real student data exists,
 * and a nullable column with a lenient guard does not avoid that migration, it
 * defers it — while reading as complete. The cost is still owed and the tracker
 * says it is paid.
 *
 * So every one of the six columns is now NOT NULL. The DEFAULT stays, and it is
 * not a licence to omit the value: it is the backstop that makes the backfill in
 * 0008 a metadata-only change and that keeps a hand-written INSERT in a psql
 * session from failing. Application inserts supply the tenant EXPLICITLY, from
 * the authenticated actor.
 *
 * THE ENFORCEMENT THAT MATTERS IS STILL NOT THE COLUMN. It is `platform/authz`:
 * a mismatch between the actor's tenant and the resource's tenant is denied
 * before any allow rule is considered, and — since D-073 — so is a MISSING
 * tenant on either side. The column is where the fact lives; the guard is what
 * makes it a boundary.
 *
 * ===========================================================================
 * THIS FILE IMPORTS NOTHING FROM THE REST OF THE SCHEMA, on purpose.
 *
 * `identity`, `learner` and `practice` all need to reference `tenants`. If
 * `tenants` in turn referenced `users`, the schema barrel would contain a
 * cycle — and under drizzle-kit's CommonJS transpilation a schema cycle is a
 * temporal-dead-zone crash at generate time, not a warning. Same reasoning as
 * the note at the top of `shared/constants/curriculum.ts`.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL-safe, stable, human-readable. Becomes the white-label subdomain. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tenants_slug_unique').on(table.slug),
    check('tenants_slug_check', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check('tenants_name_check', sql`length(btrim(${table.name})) > 0`),
  ],
);

/**
 * The fixed id of the single seeded tenant.
 *
 * A literal rather than a lookup, written identically in the migration, the
 * schema and the tests. Every row created before multi-tenancy exists belongs
 * to it, and a deployment that cannot find this row has a BROKEN database
 * rather than an empty one — which is a better thing to discover at boot than
 * to paper over with a runtime "find or create".
 */
export const DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111';

export type TenantRow = typeof tenants.$inferSelect;
export type NewTenantRow = typeof tenants.$inferInsert;
