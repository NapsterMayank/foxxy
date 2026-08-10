import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  applyAllMigrations,
  readDownMigration,
  readMigration,
  splitStatements,
  startTestPostgres,
  type TestPostgres,
} from '../helpers/postgres';

/**
 * THE COLLAPSE IS PROVEN BY DIFF, NOT ASSERTED (D-091).
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR.
 *
 * Migrations 0000-0008 were collapsed into a single `0000_baseline`. The claim
 * that has to be true for that to have been safe is not "the baseline looks
 * right" and not "db:generate emits nothing" — it is that a database built by
 * the baseline is the SAME DATABASE as one built by applying the nine
 * superseded migrations in order.
 *
 * "The same" is not a judgement anybody should be making by eye across 536
 * lines of DDL. So both are built here, side by side, on real Postgres, and the
 * two schemas are read back OUT OF THE CATALOGUE and compared: every column
 * with its type, nullability, default and generation expression; every
 * constraint with its full expression; every index definition; every trigger;
 * every function body; every table and column comment; the extensions; and the
 * one row of seed data. If they differ, the diff names the object.
 *
 * The superseded chain is therefore not archaeology. It is the ORACLE, and
 * deleting it would delete the only evidence the collapse was sound.
 *
 * ===========================================================================
 * TWO DIFFERENCES ARE EXPECTED, AND BOTH ARE ASSERTED RATHER THAN HIDDEN.
 *
 * A comparison that quietly normalises away whatever it finds inconvenient is
 * not a proof, it is a ritual. So the two known divergences are named, pinned
 * by their own tests, and justified — and anything else at all fails.
 *
 * (1) ORDINAL COLUMN POSITION.
 *
 *     The chain ADDED `tenant_id` and the five evidence columns by ALTER TABLE,
 *     so they landed at the end of each table. The baseline CREATEs each table
 *     whole, so they land where the TypeScript schema declares them. Every
 *     other property of every column — name, type, nullability, default,
 *     generated expression — is identical, which is what the bulk comparison
 *     checks, keyed by NAME rather than by position.
 *
 *     Ordinal position is reachable through exactly two constructs: `SELECT *`
 *     and an INSERT with no column list. Drizzle emits neither; every query in
 *     this codebase names its columns, and `.returning()` projects by name.
 *     Freezing the accidental attnum ordering of an ALTER-based history into
 *     the baseline would also mean every FUTURE `db:generate` — which orders by
 *     schema declaration — reintroduces the difference. So the difference is
 *     accepted, and its scope is asserted below rather than assumed.
 *
 * (2) FOUR INDEXES: `DESC` vs `DESC NULLS LAST`.
 *
 *     THIS ONE IS A DEFECT THE COLLAPSE FOUND, not a cost of it. The TypeScript
 *     schema says `.desc()`, which drizzle-kit emits as `DESC NULLS LAST`. The
 *     hand-written 0005 and 0007 wrote a bare `DESC`, which in Postgres means
 *     NULLS FIRST. Schema and SQL had drifted, and nothing could have noticed:
 *     `generate` reads the schema and the snapshot, never the SQL, and no test
 *     compared an index definition to the database.
 *
 *     The baseline follows the SCHEMA, because the schema is what the snapshot
 *     is serialised from and therefore what every future migration is diffed
 *     against. Making the baseline match the drifted SQL instead would leave
 *     the database disagreeing with the schema permanently.
 *
 *     The divergence is unreachable in practice — all four ordering columns are
 *     NOT NULL, so there is no null for the two orderings to disagree about —
 *     and there is a test below that asserts exactly that, so "unreachable" is
 *     a checked claim and not a reassuring sentence.
 */

/** The four indexes where the superseded SQL drifted from the TypeScript schema. */
interface IndexDrift {
  readonly index: string;
  readonly table: string;
  readonly orderedBy: string;
}

const NULLS_ORDER_DRIFT: readonly IndexDrift[] = [
  { index: 'audit_log_actor_created_idx', table: 'audit_log', orderedBy: 'created_at' },
  { index: 'audit_log_tenant_created_idx', table: 'audit_log', orderedBy: 'created_at' },
  { index: 'metrics_events_name_recorded_idx', table: 'metrics_events', orderedBy: 'recorded_at' },
  { index: 'notifications_recipient_created_idx', table: 'notifications', orderedBy: 'created_at' },
];

const DRIFTED_INDEX_NAMES: ReadonlySet<string> = new Set(
  NULLS_ORDER_DRIFT.map((entry) => entry.index),
);

const BASELINE = '0000_baseline.sql';

async function applyBaseline(client: pg.Client): Promise<void> {
  for (const statement of splitStatements(readMigration(BASELINE))) {
    await client.query(statement);
  }
}

interface Catalogue {
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
  readonly functions: readonly string[];
  readonly comments: readonly string[];
  readonly extensions: readonly string[];
  readonly tenants: readonly string[];
}

async function rows(client: pg.Client, sql: string): Promise<string[]> {
  const result = await client.query<{ line: string }>(sql);
  return result.rows.map((row) => row.line);
}

/**
 * Reads the schema back out of the catalogue rather than out of `pg_dump`.
 *
 * `pg_dump` was the obvious tool and is the wrong one here: it is not on the
 * PATH of the machine running vitest (Postgres lives in a container), its output
 * carries a per-run `\restrict` nonce and a server version banner, and it orders
 * columns by attnum — which is precisely the one property that is allowed to
 * differ. Querying the catalogue directly gives a comparison whose scope is
 * chosen deliberately instead of inherited from a dump format.
 */
async function readCatalogue(client: pg.Client): Promise<Catalogue> {
  return {
    // Keyed and ORDERED BY NAME, not attnum — see divergence (1) in the header.
    columns: await rows(
      client,
      `select format(
         '%s.%s :: %s :: %s :: default=%s :: generated=%s',
         c.table_name, c.column_name, c.data_type,
         case when c.is_nullable = 'YES' then 'NULL' else 'NOT NULL' end,
         coalesce(c.column_default, '-'),
         coalesce(c.generation_expression, '-')
       ) as line
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
       order by c.table_name, c.column_name`,
    ),
    constraints: await rows(
      client,
      `select format('%s.%s :: %s', rel.relname, con.conname, pg_get_constraintdef(con.oid)) as line
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       where rel.relnamespace = 'public'::regnamespace
       order by rel.relname, con.conname`,
    ),
    indexes: await rows(
      client,
      `select format('%s :: %s', indexname, indexdef) as line
       from pg_indexes where schemaname = 'public' order by indexname`,
    ),
    triggers: await rows(
      client,
      `select format('%s :: %s', tgname, pg_get_triggerdef(oid)) as line
       from pg_trigger
       where not tgisinternal and tgrelid::regclass::text not like 'pg\\_%'
       order by tgname`,
    ),
    functions: await rows(
      client,
      // Extension-owned routines are excluded through pg_depend rather than by
      // name: `citext` installs ~50 functions AND the `min`/`max` aggregates
      // into `public`, and `pg_get_functiondef` raises on an aggregate — so an
      // unfiltered query does not merely return noise, it errors. Comparing
      // extension internals would also be comparing the extension's version,
      // which is a property of the image and not of these migrations.
      `select format('%s :: %s', p.proname, pg_get_functiondef(p.oid)) as line
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and not exists (
           select 1 from pg_depend d
           where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
         )
       order by p.proname`,
    ),
    comments: await rows(
      client,
      `select format('%s :: %s :: %s', c.relname, coalesce(a.attname, '<table>'), d.description) as line
       from pg_description d
       join pg_class c on c.oid = d.objoid
       left join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid
       where c.relnamespace = 'public'::regnamespace
       order by c.relname, coalesce(a.attname, '')`,
    ),
    extensions: await rows(client, `select extname as line from pg_extension order by extname`),
    // The one row of seed data. A schema comparison would pass with an empty
    // `tenants` table, and every insert path in the product depends on that row
    // existing (D-061) — so the data is part of what "equivalent" has to mean.
    tenants: await rows(
      client,
      `select format('%s|%s|%s', id, slug, name) as line from tenants order by id`,
    ),
  };
}

function withoutDriftedIndexes(catalogue: Catalogue): Catalogue {
  return {
    ...catalogue,
    indexes: catalogue.indexes.filter(
      (line) => !DRIFTED_INDEX_NAMES.has(line.slice(0, line.indexOf(' ::'))),
    ),
  };
}

let chain: TestPostgres;
let baseline: TestPostgres;
let chainCatalogue: Catalogue;
let baselineCatalogue: Catalogue;

beforeAll(async () => {
  [chain, baseline] = await Promise.all([startTestPostgres(), startTestPostgres()]);

  // The superseded side is DISCOVERED, never listed — that set has its own
  // journal and `listMigrations('superseded')` cross-checks against it (D-046,
  // D-075).
  await applyAllMigrations(chain.client, 'superseded');

  // The baseline side names ONE migration, which the D-075 lint rule permits
  // and which is correct here rather than merely allowed. This test compares
  // the chain to THE BASELINE, not to "whatever the migrations directory
  // currently holds" — the moment a real 0001 lands on top, applying the whole
  // current set would make this fail for a reason that has nothing to do with
  // the collapse, and the obvious repair would be to delete the test.
  await applyBaseline(baseline.client);

  [chainCatalogue, baselineCatalogue] = await Promise.all([
    readCatalogue(chain.client),
    readCatalogue(baseline.client),
  ]);
}, 120_000);

afterAll(async () => {
  await Promise.all([chain.stop(), baseline.stop()]);
});

describe('the baseline is schema-equivalent to the chain it replaced', () => {
  it('has the same columns, with the same types, defaults and generation expressions', () => {
    expect(baselineCatalogue.columns).toEqual(chainCatalogue.columns);
  });

  it('has the same constraints, expression for expression', () => {
    // This is the load-bearing one. Every CHECK in this schema encodes a
    // product rule — the grade domain, the four-option rule, the misconception
    // key set — and a CHECK that silently went missing in the collapse is a rule
    // that stops being enforced with nothing failing.
    expect(baselineCatalogue.constraints).toEqual(chainCatalogue.constraints);
  });

  it('has the same indexes, apart from the four with the known NULLS-order drift', () => {
    expect(withoutDriftedIndexes(baselineCatalogue).indexes).toEqual(
      withoutDriftedIndexes(chainCatalogue).indexes,
    );
  });

  it('has the same triggers and the same function bodies', () => {
    // The audit_log append-only guarantee is a trigger, not a convention
    // (D-063). Losing it in a collapse would leave the table writable by
    // anything, and only a test that reads the catalogue would notice.
    expect(baselineCatalogue.triggers).toEqual(chainCatalogue.triggers);
    expect(baselineCatalogue.functions).toEqual(chainCatalogue.functions);
  });

  it('has the same table and column comments', () => {
    // The comments are where the rules that cannot be expressed as constraints
    // live — the misconception key alignment, "never write to search_vector",
    // "no PII in audit metadata". They are read at a psql prompt during an
    // incident, which is exactly when nobody has the source open.
    expect(baselineCatalogue.comments).toEqual(chainCatalogue.comments);
  });

  it('has the same extensions', () => {
    expect(baselineCatalogue.extensions).toEqual(chainCatalogue.extensions);
    expect(baselineCatalogue.extensions).toContain('vector');
    expect(baselineCatalogue.extensions).toContain('citext');
  });

  it('has the same seeded tenant row', () => {
    expect(baselineCatalogue.tenants).toEqual(chainCatalogue.tenants);
    expect(baselineCatalogue.tenants).toHaveLength(1);
  });

  it('compares something: the catalogue is not vacuously empty', () => {
    // Every assertion above passes trivially against two empty databases. This
    // is what makes them mean anything.
    expect(chainCatalogue.columns.length).toBeGreaterThan(150);
    expect(chainCatalogue.constraints.length).toBeGreaterThan(80);
    expect(chainCatalogue.indexes.length).toBeGreaterThan(40);
  });
});

describe('the two known divergences are exactly as documented', () => {
  it('differs on ordinal position only for columns the chain added by ALTER', async () => {
    /**
     * Divergence (1), pinned. The set of columns whose ordinal position moved is
     * asserted to be exactly the tenancy and evidence columns — so if a future
     * edit reorders anything else, this fails and names it.
     */
    const positions = async (client: pg.Client): Promise<Map<string, number>> => {
      const result = await client.query<{ key: string; pos: string }>(
        `select format('%s.%s', c.table_name, c.column_name) as key,
                c.ordinal_position::text as pos
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`,
      );
      return new Map(result.rows.map((row) => [row.key, Number(row.pos)]));
    };

    const chainPositions = await positions(chain.client);
    const baselinePositions = await positions(baseline.client);

    const moved = [...chainPositions.entries()]
      .filter(([key, pos]) => baselinePositions.get(key) !== pos)
      .map(([key]) => key)
      .sort();

    expect(moved).toEqual([
      'chapter_mastery.tenant_id',
      'chapter_mastery.updated_at',
      // `link_code` moved for a second, subtler reason than the ALTERs: 0001
      // DROPPED `code_expires_at` (D-023), and a dropped column keeps its
      // attnum forever, so everything after it in the chain's `parent_child_links`
      // sits one place further along than in a table created fresh.
      'parent_child_links.link_code',
      'parent_child_links.tenant_id',
      'question_responses.answer_changed',
      'question_responses.confidence',
      'question_responses.created_at',
      'question_responses.explanation_format_used',
      'question_responses.first_selected_index',
      'question_responses.hint_level_used',
      'question_responses.tenant_id',
      'student_subjects.created_at',
      'student_subjects.tenant_id',
      'students.created_at',
      'students.tenant_id',
      'students.updated_at',
      'users.created_at',
      'users.email_verified_at',
      'users.tenant_id',
    ]);
  });

  it('differs on NULLS order for exactly four indexes, all on NOT NULL columns', async () => {
    /**
     * Divergence (2), pinned from both ends.
     *
     * The first half asserts the difference is what it is claimed to be — a
     * bare `DESC` in the chain, `DESC NULLS LAST` in the baseline, in exactly
     * these four indexes and nowhere else.
     *
     * The second half is the half that makes it acceptable: the ordering column
     * is NOT NULL in both databases, so there is no null for NULLS FIRST and
     * NULLS LAST to sort differently. If somebody ever makes one of those
     * columns nullable, this test fails and the divergence stops being free.
     */
    const defs = async (client: pg.Client): Promise<Map<string, string>> => {
      const result = await client.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes where schemaname = 'public'`,
      );
      return new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    };

    const chainDefs = await defs(chain.client);
    const baselineDefs = await defs(baseline.client);

    const differing = [...chainDefs.entries()]
      .filter(([name, def]) => baselineDefs.get(name) !== def)
      .map(([name]) => name)
      .sort();

    expect(differing).toEqual([...NULLS_ORDER_DRIFT].map((entry) => entry.index).sort());

    for (const { index, table, orderedBy } of NULLS_ORDER_DRIFT) {
      expect(chainDefs.get(index)).toContain(`${orderedBy} DESC)`);
      expect(baselineDefs.get(index)).toContain(`${orderedBy} DESC NULLS LAST)`);

      const nullable = await baseline.client.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = $1 and column_name = $2`,
        [table, orderedBy],
      );
      expect(nullable.rows).toHaveLength(1);
      expect(nullable.rows[0]?.is_nullable).toBe('NO');
    }
  });
});

describe('the baseline rolls back and re-applies', () => {
  it('leaves nothing behind, and can be applied again on top of itself', async () => {
    /**
     * Plan §4 rule 4. A forward migration nobody has ever reversed is one whose
     * object list has quietly drifted from the schema — a table created and not
     * dropped survives the rollback, and the re-apply then fails on "already
     * exists". That failure is the point of running this.
     *
     * It runs on the baseline database, last, because it destroys it.
     */
    for (const statement of splitStatements(
      readDownMigration(BASELINE.replace(/\.sql$/, '.down.sql')),
    )) {
      await baseline.client.query(statement);
    }

    const left = await baseline.client.query<{ count: string }>(
      `select count(*)::text as count from pg_tables where schemaname = 'public'`,
    );
    expect(left.rows[0]?.count).toBe('0');

    await applyBaseline(baseline.client);

    const back = await readCatalogue(baseline.client);
    expect(back.columns).toEqual(baselineCatalogue.columns);
    expect(back.constraints).toEqual(baselineCatalogue.constraints);
    expect(back.triggers).toEqual(baselineCatalogue.triggers);
    expect(back.tenants).toEqual(baselineCatalogue.tenants);
  }, 60_000);
});
