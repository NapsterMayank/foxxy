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

/** Section 7.4 — no database access outside a repository. */
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
      'Database access lives in *.repository.ts files only (plus platform/db itself). See 01-BACKEND-IMPLEMENTATION-PLAN.md, Section 7.4.',
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
    selector: "ArrayExpression > Literal[value=/^[0-9]{4}_[a-z0-9_]+\\.sql$/]",
    message:
      'D-075: no test may hardcode a LIST of migrations. Use applyAllMigrations() or ' +
      'listMigrations() from tests/helpers/postgres.ts, which discover them from the ' +
      "directory and cross-check drizzle's journal. Naming ONE migration is still fine — " +
      'a migration test may name its own subject.',
  },
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'drizzle/**', 'eslint.config.js'],
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
    },
  },

  // --- Boundary rule 3: db client only in repositories ---------------
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
    files: ['src/modules/**/*.repository.ts'],
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
    // Config files at the repo root legitimately configure tooling.
    files: ['*.ts', '*.config.ts', 'drizzle.config.ts', 'vitest.config.ts'],
    rules: {
      'no-restricted-exports': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    // Tests may reach into a module's internals of the module they test,
    // and may talk to a real database.
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...ENV_PATTERNS] }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // D-075 — see MIGRATION_LIST_PATTERNS at the top of this file.
      'no-restricted-syntax': ['error', ...MIGRATION_LIST_PATTERNS],
    },
  },

  prettier,
);
