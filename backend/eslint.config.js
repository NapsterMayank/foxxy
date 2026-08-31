// ESLint flat config.
//
// The four boundary rules below are the mechanical half of the architecture
// (00-ARCHITECTURE.md, Foundations 1-3). Each one has been demonstrated to
// fail on a deliberate violation — see README, "Verifying the boundary rules".
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Foundation 1 — a module exposes exactly one public file, `index.ts`.
 * Any import that reaches past it is rejected.
 *
 * NOTE ON PATTERN SYNTAX, learned the hard way: ESLint matches these with
 * gitignore-style globs (the `ignore` package), NOT minimatch. Extglob such as
 * "!(index)" does NOT work — a leading "!" is a negation, so a pattern like
 * "../[star]/!(index)" silently matches nothing and the rule looks
 * authoritative while enforcing zero.
 * Every pattern below was verified to fire on a real violation.
 *
 * This pair of patterns covers the alias and root-relative forms:
 *   '@/modules/foxy/foxy.service'   alias — the canonical cross-module form
 *   'src/modules/foxy/domain/x'     root-relative
 *
 * The relative form ('../foxy/foxy.service') is caught by
 * MODULE_ESCAPE_PATTERNS below instead. It cannot be expressed here: a
 * gitignore pattern that matches a directory matches everything beneath it, so
 * "../[star]/[star]" also swallows a perfectly legal
 * "../../platform/errors/index". A rule with false positives gets switched off,
 * which is worse than one that is narrow.
 */
const MODULE_BOUNDARY_PATTERNS = [
  {
    group: ['@/modules/*/*', '!@/modules/*/index', 'src/modules/*/*', '!src/modules/*/index'],
    message:
      'Module boundary: import a module only through its index.ts (e.g. "@/modules/foxy"). See 00-ARCHITECTURE.md, Foundation 1.',
  },
];

/**
 * The other half of Foundation 1, applied inside `src/modules/` only.
 *
 * From within a module, anything OUTSIDE that module is imported through the
 * `@/` alias — `@/platform/...`, `@/shared/...`, or `@/modules/<name>` (its
 * index, and nothing deeper). Relative paths stay inside the module.
 *
 * This is what actually stops `../identity/identity.service`, and it makes
 * every cross-module edge greppable: search for `@/modules/` and you have the
 * complete dependency graph.
 */
const MODULE_ESCAPE_PATTERNS = [
  {
    group: ['../../**', '../*/*'],
    message:
      'From inside a module, reach outside it only through the "@/" alias — "@/platform/...", "@/shared/...", or "@/modules/<name>" (index only). Relative paths stay within the module.',
  },
];

/** Foundation: process.env is read exactly once, in platform/config. */
const ENV_PATTERNS = [
  {
    group: ['node:process', 'process'],
    message:
      'process.env is read only in src/platform/config. Import the frozen `config` object instead.',
  },
];

/**
 * Section 7.4 — no database access outside a repository.
 *
 * D-181 — THE MESSAGE USED TO CLAIM MORE THAN THE RULE ENFORCED. It said
 * "*.repository.ts files only", and it was applied under `src/app/**` and
 * `src/modules/**` and nowhere else: `src/platform/**`, `src/shared/**` and
 * `src/worker/**` were unpoliced, and three files import `drizzle-orm` outside
 * a repository today. A rule whose text overstates its scope is worse than a
 * narrow rule, because everyone downstream reads the text and believes it.
 *
 * Both halves are now true. The scope is widened to ALL of `src/**` (see the
 * `src/**` block below), and the two directories that genuinely cannot comply
 * yet are named here and exempted explicitly further down, so the gap is
 * visible in the same file as the claim rather than inferred from its absence.
 */
const DB_PATTERNS = [
  {
    group: [
      '@/platform/db',
      '@/platform/db/*',
      '**/platform/db',
      '**/platform/db/*',
      'drizzle-orm',
      'drizzle-orm/*',
      'pg',
    ],
    message:
      'Database access lives in *.repository.ts files only, plus platform/db itself and the ' +
      'two exemptions written down in eslint.config.js (platform/jobs, worker/ — the queue, ' +
      'heartbeat and session sweeper, D-181). Tests are outside this rule by design. ' +
      'See 01-BACKEND-IMPLEMENTATION-PLAN.md, Section 7.4.',
  },
];

/**
 * D-182 — `globalThis.process.env` needs no import, so the import rule cannot
 * see it, and `no-restricted-properties` matches the IDENTIFIER `process`, so
 * it cannot see it either. `globalThis.process` is a different member
 * expression that resolves to the same object.
 *
 * Three shapes, all of which exited 0 before this:
 *
 *     globalThis.process.env.DATABASE_URL     // member expression
 *     globalThis['process'].env.DATABASE_URL  // computed, same thing
 *     const p = process; p.env.DATABASE_URL   // aliased through a binding
 *
 * The third selector also catches `const { env } = process`, which is the same
 * evasion with destructuring instead of a property read.
 *
 * These are SYNTAX rules, not import rules, which means they must be repeated
 * into every `no-restricted-syntax` declaration below — that rule does not
 * merge across config objects, it replaces. That is why each declaration
 * spreads these arrays instead of listing entries inline.
 */
const ENV_ACCESS_SYNTAX = [
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='process']",
    message:
      'process.env is read only in src/platform/config, and `globalThis.process` is still ' +
      'process. Import the frozen `config` object instead.',
  },
  {
    selector: "MemberExpression[computed=true][property.value='process']",
    message:
      "process.env is read only in src/platform/config, and `globalThis['process']` is still " +
      'process. Import the frozen `config` object instead.',
  },
  {
    selector: "VariableDeclarator[init.type='Identifier'][init.name='process']",
    message:
      'Aliasing `process` to a local binding evades the process.env rule. process.env is read ' +
      'only in src/platform/config; import the frozen `config` object instead.',
  },
];

/**
 * D-183 — `no-restricted-imports` inspects `ImportDeclaration` and nothing
 * else. A dynamic `import()` is an `ImportExpression`, so this single line
 * defeated the module boundary, the module-escape rule, the process.env rule
 * and the database rule simultaneously:
 *
 *     await import('@/modules/knowledge/knowledge.service');   // exited 0
 *
 * There is no legitimate lazy import inside the server. The whole graph is
 * constructed once, at boot, by the composition root; deferring a module load
 * would buy nothing and would move a wiring failure from startup to whenever
 * the first request happens to reach it. So the form is banned outright rather
 * than filtered by specifier — a filter would be a SECOND list of restricted
 * paths, drifting against the first.
 *
 * `scripts/` is exempted below and keeps two deliberate dynamic imports: they
 * defer `platform/config`'s eager, process-exiting environment read until the
 * script has decided it actually needs it.
 */
const DYNAMIC_IMPORT_SYNTAX = [
  {
    selector: 'ImportExpression',
    message:
      'Dynamic import() bypasses every boundary rule — no-restricted-imports only inspects ' +
      'static ImportDeclaration nodes, so import() defeats the module surface, the module ' +
      'escape rule, the process.env rule and the database rule at once (D-183). Use a static ' +
      'import.',
  },
];

/**
 * D-075 — no test may hardcode a LIST of migrations.
 *
 * This defect has now appeared three times: the identity harness (D-046),
 * `pool-bulkhead.test.ts` (D-072), and `link-code-repository.test.ts` (found in
 * this wave). Each time it was fixed and each time it came back somewhere else,
 * because "remember to use `applyAllMigrations`" is a convention and conventions
 * are exactly what this codebase does not rely on.
 *
 * It is a nasty defect because it is GREEN. A harness that applies only the
 * migrations it names runs its whole suite against a schema missing a table, and
 * nothing fails until some unrelated migration adds a column that Drizzle's
 * `.returning()` projects — at which point the error surfaces several layers
 * from its cause.
 *
 * WHAT THIS BANS AND WHAT IT DELIBERATELY DOES NOT.
 *
 * Banned: an ARRAY LITERAL containing a migration filename. That is the shape of
 * every occurrence of the defect — a list, iterated, applied by hand.
 *
 * Allowed: naming ONE migration, e.g. `readMigration('0000_identity.sql')`. A
 * migration's own forward/rollback test legitimately names its subject, and
 * banning that would either be ignored or would delete the migration tests.
 *
 * The distinction is not a compromise. One name is a REFERENCE to a specific
 * migration; a list is a claim about WHICH MIGRATIONS EXIST — a second source of
 * truth, and second sources of truth drift.
 *
 * Verified to fire on a real violation before being trusted (D-005).
 */
const MIGRATION_LIST_PATTERNS = [
  {
    selector: "ArrayExpression > Literal[value=/^[0-9]{4}_[a-z0-9_]+(\\.down)?(\\.sql)?$/]",
    message:
      'D-075: no test may hardcode a LIST of migrations. Use applyAllMigrations() or ' +
      'listMigrations() from tests/helpers/postgres.ts, which discover them from the ' +
      "directory and cross-check drizzle's journal. Naming ONE migration is still fine — " +
      'a migration test may name its own subject.',
  },
  {
    // D-180 — the same list, written with backticks. `ArrayExpression > Literal`
    // does not match a `TemplateLiteral`, and backticks are idiomatic enough
    // that neither prettier nor eslint pushes back on them.
    selector:
      "ArrayExpression > TemplateLiteral > TemplateElement[value.cooked=/^[0-9]{4}_[a-z0-9_]+(\\.down)?(\\.sql)?$/]",
    message:
      'D-075: no test may hardcode a LIST of migrations — backticks are still a list. Use ' +
      'applyAllMigrations() or listMigrations() from tests/helpers/postgres.ts, which discover ' +
      "them from the directory and cross-check drizzle's journal.",
  },
];

/**
 * D-075, STRENGTHENED — the array rule above was evaded, twice, for two years.
 *
 * ===========================================================================
 * WHAT THE ARRAY RULE MISSED.
 *
 * It bans an array literal of migration filenames, because that is the shape
 * every occurrence of the defect had taken. `foundation-hooks-migration.test.ts`
 * and `learner-content-migration.test.ts` had the same defect written
 * VERTICALLY instead:
 *
 *     await run(readDownMigration('0008_tenant_not_null.down.sql', 'superseded'));
 *     await run(readDownMigration('0007_notify_metrics_jobs.down.sql', 'superseded'));
 *     await run(readDownMigration('0006_evidence_capture.down.sql', 'superseded'));
 *     ...
 *
 * Ten hand-ordered migration names, maintained by hand, broken by every new
 * migration — and not one array literal in sight, so the rule that exists to
 * catch exactly this reported nothing. Both files were patched by adding one
 * more name, twice each, which is the D-075 loop running inside the guard
 * against D-075.
 *
 * ===========================================================================
 * WHERE THE LINE IS, AND WHY IT IS THERE.
 *
 * The distinction the original rule draws is still the right one: one name is a
 * REFERENCE to a specific migration, a list is a CLAIM ABOUT WHICH MIGRATIONS
 * EXIST. So this rule counts DISTINCT migrations per file, where
 * `0002_practice.sql` and `0002_practice.down.sql` count as one — a migration's
 * own test must be able to name its subject in both directions.
 *
 * TWO are allowed. A migration test legitimately needs a PREREQUISITE (usually
 * the baseline) plus its SUBJECT, and `pedagogy-migration.test.ts` and
 * `practice-migration.test.ts` are both written that way, correctly.
 *
 * THREE is a chain. There is no honest reason to name three migrations: at that
 * point the file is reconstructing the applied set by hand, and
 * `applyAllMigrations()` — which discovers the set and cross-checks Drizzle's
 * journal — is what it actually wants.
 *
 * Verified to fire on a real violation before being trusted (D-005): pointed at
 * the pre-rewrite `foundation-hooks-migration.test.ts` it reports 6.
 */
/**
 * D-180 — THE FOURTH RECURRENCE, and the third evasion of a guard whose entire
 * detection surface was the word `Literal`.
 *
 * The array rule and this chain rule both matched `Literal` nodes ending in
 * `.sql`. Three shapes walked past both, and every one of them is something an
 * ordinary editor writes without thinking:
 *
 *     run(readDownMigration(`0008_tenant_not_null.down.sql`, 'superseded'));  // backticks
 *     ['0009_a', '0010_b'].map((s) => `${s}.sql`);                            // suffix added later
 *     readMigration('0013_e' + EXT);                                          // suffix concatenated
 *
 * Two changes close all three. The visitor now reads static `TemplateLiteral`
 * quasis as well as `Literal` strings, and `.sql` is OPTIONAL in the pattern —
 * because in the last two shapes the extension is not in the string at all. A
 * bare `0013_e` is already a complete migration identity; the extension is
 * decoration that the defect had learned to hide behind.
 *
 * The cost of making `.sql` optional is that a string which merely LOOKS like a
 * migration stem now counts. That shape is `0000_lower_snake` and nothing else,
 * and three of them in one file is the thing being banned anyway.
 */
const MIGRATION_NAME = /^([0-9]{4}_[a-z0-9_]+?)(\.down)?(\.sql)?$/;
const MAX_MIGRATIONS_NAMED_PER_FILE = 2;

/**
 * =============================================================================
 * `admin` READS. IT DOES NOT WRITE, AND THAT IS THE LOAD-BEARING CLAIM.
 *
 * The admin routes deliberately bypass `assertCanAccess` — an operations
 * surface reads across every tenant by definition, so the one authorisation
 * primitive in this codebase that is airtight cannot guard them. Three things
 * stand in for it (D-402):
 *
 *   1. the `requireAdmin` gate is the only door, proved by route enumeration
 *   2. every read writes an audit row
 *   3. NOTHING WRITES
 *
 * Property 3 is the one a comment cannot hold. It is one `update` away from
 * being false, the diff that adds it looks helpful ("just let an operator
 * deactivate a bad question"), and the moment it lands the admin module is a
 * cross-tenant mutation surface with no `assertCanAccess` anywhere near it.
 *
 * So it is a lint rule. A write in an admin repository fails the build, and the
 * message says where the write belongs instead: in the module that owns the
 * table, behind that module's own guard.
 *
 * WHAT IT MATCHES: `.insert(`, `.update(`, `.delete(` — the drizzle builders —
 * and a raw `sql` template whose first keyword is INSERT, UPDATE, DELETE,
 * TRUNCATE, MERGE, DROP, ALTER, CREATE or GRANT. Both, because this module uses
 * both styles and blocking only one would be theatre.
 *
 * WHAT IT CANNOT MATCH is a write assembled at runtime out of fragments. That
 * is accepted: this rule is a ratchet against the easy accident, not a sandbox
 * against a determined author. A determined author is what code review is for.
 * =============================================================================
 */
const WRITE_METHODS = new Set(['insert', 'update', 'delete']);
const WRITE_SQL = /^\s*(insert|update|delete|truncate|merge|drop|alter|create|grant)\b/i;

const adminReadOnlyPlugin = {
  rules: {
    'no-writes': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          write:
            'D-402: the admin module READS and never writes, and this is a {{what}}. ' +
            'The admin routes deliberately bypass assertCanAccess because an operations ' +
            'surface is cross-tenant by definition; "nothing writes" is one of the three ' +
            'properties standing in for it, alongside the requireAdmin gate and the audit ' +
            'row per read. A write here would be a cross-tenant mutation with no ' +
            'authorisation primitive anywhere near it. Put it in the module that OWNS the ' +
            'table, behind that module\'s own guard, and have admin read the result.',
        },
      },
      create(context) {
        return {
          /** Drizzle: `db.insert(...)`, `tx.update(...)`, `db.delete(...)`. */
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || callee.computed) return;
            const property = callee.property;
            if (property.type !== 'Identifier') return;
            if (!WRITE_METHODS.has(property.name)) return;
            context.report({ node, messageId: 'write', data: { what: `.${property.name}() call` } });
          },
          /** Raw SQL: sql`update ...`, however it is indented. */
          TaggedTemplateExpression(node) {
            const tag = node.tag;
            const tagName =
              tag.type === 'Identifier'
                ? tag.name
                : tag.type === 'MemberExpression' && tag.property.type === 'Identifier'
                  ? tag.property.name
                  : null;
            if (tagName !== 'sql') return;

            const first = node.quasi.quasis[0];
            const cooked = first === undefined ? null : first.value.cooked;
            if (typeof cooked !== 'string') return;
            if (!WRITE_SQL.test(cooked)) return;
            context.report({ node, messageId: 'write', data: { what: 'writing SQL statement' } });
          },
        };
      },
    },
  },
};

const migrationChainPlugin = {
  rules: {
    'no-migration-chain': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          chain:
            'D-075: this file names {{count}} different migrations ({{names}}). More than ' +
            `${MAX_MIGRATIONS_NAMED_PER_FILE} is not a reference, it is a hand-maintained LIST of which ` +
            'migrations exist — a second source of truth that breaks on every new one. ' +
            'Use applyAllMigrations() or listMigrations() from tests/helpers/postgres.ts, ' +
            'which discover the set from the directory and cross-check drizzle\'s journal. ' +
            'A migration test may still name its own subject plus one prerequisite.',
        },
      },
      create(context) {
        /** @type {Map<string, import('estree').Node>} */
        const seen = new Map();
        /**
         * @param {string} value
         * @param {import('estree').Node} node
         */
        const consider = (value, node) => {
          const match = MIGRATION_NAME.exec(value);
          if (match === null) return;
          const stem = match[1];
          if (!seen.has(stem)) seen.set(stem, node);
        };
        return {
          Literal(node) {
            if (typeof node.value !== 'string') return;
            consider(node.value, node);
          },
          // D-180: backticks. Every static piece of a template literal is
          // considered, so both `0008_x.down.sql` (one quasi, no expressions)
          // and `${stem}.sql` (whose stem arrives as a Literal elsewhere and is
          // counted there) are covered.
          TemplateElement(node) {
            const cooked = node.value.cooked;
            if (typeof cooked !== 'string') return;
            consider(cooked, node);
          },
          'Program:exit'(node) {
            if (seen.size <= MAX_MIGRATIONS_NAMED_PER_FILE) return;
            context.report({
              node,
              messageId: 'chain',
              data: {
                count: String(seen.size),
                names: [...seen.keys()].sort().join(', '),
              },
            });
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    // `dist-ops/` is build OUTPUT, like `dist/` — the compiled operational entry
    // points (migrations, the alert evaluator) that the production image runs
    // with `--omit=dev`, where tsx does not exist. Omitting it here made `npm
    // run lint` report 256 errors in generated JavaScript.
    ignores: [
      'dist/**',
      'dist-ops/**',
      'coverage/**',
      'node_modules/**',
      'drizzle/**',
      'eslint.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // --- Conventions, Section 3 -------------------------------------
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true, named: true } }],
      'import/no-default-export': 'off', // covered by no-restricted-exports without the plugin
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-console': 'error',

      // --- Boundary rule 1: module public surface ---------------------
      'no-restricted-imports': ['error', { patterns: MODULE_BOUNDARY_PATTERNS }],
    },
  },

  // --- Boundary rule 2: process.env only in platform/config ----------
  // Applied everywhere, then relaxed for platform/config below.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'process.env is read only in src/platform/config. Import the frozen `config` object instead.',
        },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [...MODULE_BOUNDARY_PATTERNS, ...ENV_PATTERNS] },
      ],
      // D-182 / D-183 — the two ways past the rules above that inspect only
      // imports and only the identifier `process`.
      'no-restricted-syntax': ['error', ...ENV_ACCESS_SYNTAX, ...DYNAMIC_IMPORT_SYNTAX],
    },
  },
  {
    // `scripts/` keeps two deliberate dynamic imports (D-183): they defer
    // platform/config's eager, process-exiting environment read until the
    // script has decided it needs it. The env-access selectors still apply.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...ENV_ACCESS_SYNTAX],
    },
  },

  // --- Boundary rule 3: db client only in repositories ---------------
  {
    // D-181 — ALL of src/, not just app/ and modules/. The rule's own message
    // always said "repositories only"; until now it was applied to two
    // subtrees out of five, so platform/, shared/ and worker/ could import
    // drizzle freely while reading a rule that said they could not. The two
    // directories that cannot comply today are exempted by name below.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...MODULE_BOUNDARY_PATTERNS, ...ENV_PATTERNS, ...DB_PATTERNS] },
      ],
    },
  },
  {
    files: ['src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...MODULE_BOUNDARY_PATTERNS, ...ENV_PATTERNS, ...DB_PATTERNS],
        },
      ],
    },
  },
  {
    // Inside a module: boundary + escape + env + db, all four.
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...MODULE_BOUNDARY_PATTERNS,
            ...MODULE_ESCAPE_PATTERNS,
            ...ENV_PATTERNS,
            ...DB_PATTERNS,
          ],
        },
      ],
    },
  },
  {
    // Repositories are the sanctioned place for database access.
    // The composition root is the other: it is what BUILDS the db handle and
    // hands it to repositories. Narrowed to that one file on purpose — if this
    // list ever grows, the boundary has stopped meaning anything.
    //
    // `src/platform/**` JOINED THE GLOB WHEN ALERTING MOVED INTO `src/`.
    //
    // `platform/alerts/alerts.repository.ts` reads `metrics_events` and
    // `pg_stat_activity`; those queries were legal under `scripts/`, where this
    // rule does not reach, and became illegal the moment the module moved so the
    // API could run a dry-run evaluation.
    //
    // The one-line alternative was to add `platform/alerts` to the D-181 block
    // below, whose own closing sentence is "adding a fourth is not". So the SQL
    // was put in a file named for what it is instead. This widening is NOT a
    // fourth exemption: an exemption lets a file break the rule, and this lets a
    // file KEEP it. After the change the boundary is stronger than before,
    // because "SQL lives in a *.repository.ts" is now true of all of `src/`
    // rather than of `src/modules/` with a quiet hole beside it.
    files: ['src/modules/**/*.repository.ts', 'src/platform/**/*.repository.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...MODULE_BOUNDARY_PATTERNS, ...MODULE_ESCAPE_PATTERNS, ...ENV_PATTERNS] },
      ],
    },
  },
  {
    files: ['src/app/container.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...MODULE_BOUNDARY_PATTERNS, ...ENV_PATTERNS] },
      ],
    },
  },

  // --- Exemptions ----------------------------------------------------
  {
    // platform/config is the one place allowed to read the environment.
    files: ['src/platform/config/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-imports': ['error', { patterns: MODULE_BOUNDARY_PATTERNS }],
      // The env-access selectors come off with the property rule, for the same
      // reason. The dynamic-import ban does not: it is unrelated to config.
      'no-restricted-syntax': ['error', ...DYNAMIC_IMPORT_SYNTAX],
    },
  },
  {
    // platform/db *is* the database port; it necessarily imports drizzle and pg.
    files: ['src/platform/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...MODULE_BOUNDARY_PATTERNS, ...ENV_PATTERNS] },
      ],
    },
  },
  {
    // D-181, THE NAMED GAP. Widening the database rule to all of `src/**`
    // caught three files that import `drizzle-orm` outside a repository and
    // predate the widening:
    //
    //   src/platform/jobs/postgres-queue.ts          the job queue IS storage
    //   src/platform/jobs/heartbeat.ts               ditto
    //   src/worker/jobs/expired-session-sweeper.ts   a background DELETE
    //
    // They are exempted rather than rewritten because rewriting them is a
    // separate change with its own review. This block is the whole point of
    // the D-181 fix: the exemption is WRITTEN DOWN, next to the rule, so the
    // rule's message and the rule's reach agree. Deleting these three
    // directories from this list is the follow-up; adding a fourth is not.
    files: ['src/platform/jobs/**/*.ts', 'src/worker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...MODULE_BOUNDARY_PATTERNS, ...ENV_PATTERNS] },
      ],
    },
  },
  {
    // Config files at the repo root legitimately configure tooling.
    files: ['*.ts', '*.config.ts', 'drizzle.config.ts', 'vitest.config.ts'],
    rules: {
      'no-restricted-exports': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    /**
     * D-402 — the admin module reads and never writes. See the rule definition
     * near the top of this file for why a comment could not have held this.
     *
     * Scoped to the REPOSITORIES rather than to the whole module: they are the
     * only files with a database handle, so they are the only files that could
     * write. Scoping wider would flag `Array.prototype.delete`-shaped calls in
     * a service and teach people to disable the rule.
     */
    files: ['src/modules/admin/**/*.repository.ts'],
    plugins: { admin: adminReadOnlyPlugin },
    rules: {
      'admin/no-writes': 'error',
    },
  },
  {
    // Tests may reach into a module's internals of the module they test,
    // and may talk to a real database.
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', 'tests/**/*.ts'],
    plugins: { migrations: migrationChainPlugin },
    rules: {
      'no-restricted-imports': ['error', { patterns: [...ENV_PATTERNS] }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // D-075 — see MIGRATION_LIST_PATTERNS at the top of this file. Catches
      // the list written HORIZONTALLY, as an array literal (quotes or
      // backticks, D-180).
      //
      // The env and dynamic-import selectors are RESPREAD here on purpose:
      // `no-restricted-syntax` replaces across config objects rather than
      // merging, so a declaration that lists only the migration patterns
      // silently switches the other two off for every test file — which is
      // most of the repository.
      'no-restricted-syntax': [
        'error',
        ...MIGRATION_LIST_PATTERNS,
        ...ENV_ACCESS_SYNTAX,
        ...DYNAMIC_IMPORT_SYNTAX,
      ],
      // D-075 strengthened — catches the same list written VERTICALLY, as a
      // sequence of calls. See `migrationChainPlugin` at the top of this file.
      'migrations/no-migration-chain': 'error',
    },
  },

  prettier,
);
