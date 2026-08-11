import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE GENERATED CONTRACTS MUST MATCH THE BACKEND — plan §5.1.
 *
 * `src/lib/api/generated/` is a COPY, and a copy that nothing checks is a
 * hand-written mirror with extra steps: the backend changes a field, the
 * frontend keeps compiling against the old shape, and the disagreement is
 * discovered by a user. This test runs the generator in `--check` mode, so a
 * stale copy — or an edit made directly to a generated file — fails the build
 * with the command that fixes it.
 *
 * It SKIPS when `../backend` is absent rather than failing. The frontend image
 * builds from `frontend/` alone, and a check that cannot run there must not
 * turn into a red suite that teaches people to ignore it. CI checks out the
 * whole repository, so the gate is real where it matters.
 */
const frontendRoot = resolve(__dirname, '..', '..', '..', '..');
const backendContracts = resolve(frontendRoot, '..', 'backend', 'src', 'shared', 'contracts');

describe('generated contracts', () => {
  it.skipIf(!existsSync(backendContracts))(
    'are identical to the backend originals',
    () => {
      expect(() => {
        execFileSync(process.execPath, ['scripts/sync-contracts.mjs', '--check'], {
          cwd: frontendRoot,
          stdio: 'pipe',
        });
      }).not.toThrow();
    },
  );
});
