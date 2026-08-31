import next from 'eslint-config-next';

/**
 * The admin app's lint config.
 *
 * Deliberately thinner than `frontend/`'s: this app has no i18n, no visual
 * baselines and no bundle budget, because it is an internal tool with one user.
 * What it does keep is the isolation rule, enforced by `check:isolation` rather
 * than here — see that script for why a deployment property is checked by
 * walking the tree instead of by a lint rule.
 */
const config = [
  ...next,
  {
    // GENERATED contracts are a verbatim copy of the backend, kept honest by
    // `contracts:check`. Linting them would produce findings whose only fix is
    // editing a file the generator overwrites.
    ignores: ['.next/**', 'node_modules/**', 'src/lib/api/generated/**'],
  },
];

// NAMED, not anonymous: `import/no-anonymous-default-export` is right that a
// bare array default has no name in a stack trace or an editor jump.
export default config;
