import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAppHarness, type AppHarness } from '../../../../tests/helpers/app-harness';

/**
 * =============================================================================
 * D-261 — THE DATABASE HALF OF DIGEST IDEMPOTENCE, VERIFIED IN THE SCHEMA.
 *
 * D-211 added a behavioural test: two repository-level generations for the same
 * (parent, child, week) must leave one row, unchanged. That test asserts an
 * OUTCOME, and an outcome can be produced by more than one mechanism — an
 * application-level pre-check that happens to answer first, an `ON CONFLICT`
 * clause naming an index that does not exist and therefore never fires, or the
 * constraint genuinely doing its job. It cannot tell those apart, and the whole
 * claim of D-211 is that the constraint is "the only thing that can settle" a
 * genuinely concurrent pair.
 *
 * SO THIS FILE ASKS POSTGRES DIRECTLY, against the schema the migrations
 * produced. It is the difference between "the test passes" and "the constraint
 * exists" — which is exactly the distinction that made this worth re-checking,
 * because the two have diverged in this repository before (D-046, D-075: a
 * harness that named its migrations ran a whole suite against a schema missing a
 * table and stayed green).
 *
 * -----------------------------------------------------------------------------
 * RESULT: THE CONSTRAINT IS REAL. `weekly_digests_week_key`, UNIQUE over
 * `(parent_user_id, student_user_id, week_start)`, declared in
 * `src/platform/db/schema/parent.ts` and emitted by
 * `drizzle/migrations/0003_parent.sql`. Nothing needed fixing; what was missing
 * was anything that would notice if it were dropped.
 *
 * THE COLUMN LIST IS ASSERTED, NOT JUST THE NAME. A constraint that kept its
 * name and lost `student_user_id` would give a parent with two children ONE
 * digest a week covering one child, which is a silent under-delivery rather than
 * an error — the failure mode `0003_parent.sql`'s own header calls out.
 * =============================================================================
 */

let harness: AppHarness;

beforeAll(async () => {
  harness = await startAppHarness();
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

interface ConstraintRow {
  readonly conname: string;
  readonly contype: string;
  /**
   * COMMA-JOINED IN SQL, not a Postgres array.
   *
   * The harness client is a bare `pg.Client` with no type parsers installed, so
   * a `text[]` arrives as the literal string `{a,b,c}` and an array assertion
   * against it fails for a reason that has nothing to do with the constraint.
   * Joining server-side keeps the assertion about the schema.
   */
  readonly columns: string;
}

/** Constraints on a table, with their column lists, in declaration order. */
async function constraintsOn(table: string): Promise<readonly ConstraintRow[]> {
  const result = await harness.postgres.client.query<ConstraintRow>(
    `select c.conname,
            c.contype::text as contype,
            (
              select string_agg(a.attname, ',' order by k.ord)
              from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a
                on a.attrelid = c.conrelid and a.attnum = k.attnum
            ) as columns
     from pg_constraint c
     where c.conrelid = $1::regclass`,
    [table],
  );
  return result.rows;
}

describe('weekly digest idempotence is enforced by the SCHEMA, not only by code', () => {
  it('has a UNIQUE constraint on (parent_user_id, student_user_id, week_start)', async () => {
    const unique = (await constraintsOn('weekly_digests')).filter((row) => row.contype === 'u');

    expect(unique).toHaveLength(1);
    expect(unique[0]?.conname).toBe('weekly_digests_week_key');
    // ORDER MATTERS to the index this backs, and the columns matter to the
    // meaning: dropping `student_user_id` would silently give a parent with two
    // children one digest a week.
    expect(unique[0]?.columns).toBe('parent_user_id,student_user_id,week_start');
  });

  it('REFUSES a duplicate row at the database, with no application code involved', async () => {
    /**
     * The constraint is DECLARED — the test above proves that. This one proves
     * it is ENFORCED, which is a different claim: a constraint can exist as
     * `NOT VALID`, or be attached to a partition nobody writes to, and still
     * appear in `pg_constraint` exactly as a working one does.
     *
     * IT RUNS AGAINST A COPY, `LIKE weekly_digests INCLUDING ALL`. That clause
     * carries the constraints, defaults and indexes across but NOT the foreign
     * keys — which is precisely what is wanted here. Satisfying four FKs would
     * mean building a parent, a student, a link and a chapter, and every one of
     * those is a place for this test to fail for a reason that has nothing to do
     * with the uniqueness it exists to check.
     *
     * The transaction is rolled back, so the schema this suite shares is
     * untouched.
     */
    const client = harness.postgres.client;
    await client.query('begin');
    try {
      await client.query(
        'create temporary table digest_constraint_probe (like weekly_digests including all) on commit drop',
      );

      const values = `(
        '11111111-1111-4111-8111-111111111111'::uuid,
        '22222222-2222-4222-8222-222222222222'::uuid,
        date '2026-08-10',
        'summary en', 'summary hi', 'action en', 'action hi'
      )`;
      const insert = `insert into digest_constraint_probe
        (parent_user_id, student_user_id, week_start,
         summary_en, summary_hi, suggested_action_en, suggested_action_hi)
        values ${values}`;

      await client.query(insert);
      // THE SECOND ONE MUST BE REFUSED. `23505` is `unique_violation`; asserting
      // the code rather than the message keeps this independent of Postgres's
      // wording and of the server's locale.
      await expect(client.query(insert)).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.query('rollback');
    }
  });
});
