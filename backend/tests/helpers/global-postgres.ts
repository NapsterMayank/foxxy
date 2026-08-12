import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * ONE Postgres container for the entire test run.
 *
 * Vitest runs test files in parallel workers. Before this existed, every file
 * that wanted a database started its own container, and four simultaneous
 * starts raced on testcontainers' Ryuk reaper — the run failed with "Failed to
 * connect to Reaper" rather than any test failing. That is the worst kind of
 * red: nothing is wrong with the code, and the signal is noise.
 *
 * One container, started once here, plus a fresh DATABASE per test file (see
 * `startTestPostgres`), gives full isolation without the race and without
 * paying container startup four times.
 *
 * The URL reaches test files through vitest's `provide`/`inject` channel
 * rather than an environment variable — `process.env` is read in exactly one
 * place in this codebase, and a test helper is not it.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection string for the shared container's `postgres` database. */
    postgresAdminUrl: string;
  }
}

const IMAGE = 'pgvector/pgvector:pg16';
const USER = 'test';
const PASSWORD = 'test';

let container: StartedTestContainer | undefined;

interface GlobalSetupContext {
  provide: (key: 'postgresAdminUrl', value: string) => void;
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new GenericContainer(IMAGE)
    .withEnvironment({
      POSTGRES_USER: USER,
      POSTGRES_PASSWORD: PASSWORD,
      POSTGRES_DB: 'postgres',
      // The container is thrown away at the end of the run, so durability
      // buys nothing and costs real time on every INSERT.
      POSTGRES_INITDB_ARGS: '--nosync',
    })
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'full_page_writes=off',
      '-c',
      /**
       * `max_connections` RAISED FROM THE DEFAULT 100, because the default is
       * no longer enough — and the way it fails is worth recording.
       *
       * Vitest runs these files in parallel and each database-backed file holds
       * its own connections. A file built on `app-harness` creates the full set
       * of §3.1 pools (10 + 20 + 8 + 6 = 44 potential connections) and there are
       * now nine such files, alongside the queue, sweeper, audit and migration
       * suites — plus `pool-bulkhead`, which deliberately SATURATES a pool as
       * the thing it is testing.
       *
       * When the ceiling is reached, the symptom is not "too many clients".
       * It is `Connection terminated unexpectedly` inside a `beforeAll`, which
       * reads as a broken migration or a flaky container, and it moves between
       * files from run to run because it lands on whichever file happened to
       * connect last. One run red, the next green, nothing wrong with the code:
       * exactly the class of noise the one-container change above was made to
       * remove.
       *
       * 200 is headroom rather than a measurement — the point is that the test
       * harness should never be the constraint. It says NOTHING about
       * production, where §3.1's 44 total is deliberate and sized against a real
       * `max_connections` with room left for `psql`.
       *
       * NOTE THE `-c` ON ITS OWN LINE ABOVE. Omitting it — which is easy to do
       * when a comment this long sits between the flag and its value — passes
       * `max_connections=200` as a bare argument, `postgres` refuses to start,
       * and the ONLY symptom is testcontainers reporting
       *
       *     Log stream ended and message "/database system is ready to accept
       *     connections/" was not received
       *
       * with `Test Files: no tests`. Nothing mentions the argument, no container
       * survives to inspect, and the message points at the wait strategy rather
       * than at the command. Verified by starting the image by hand with the
       * same flags, which works.
       */
      'max_connections=200',
    ])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  provide(
    'postgresAdminUrl',
    `postgres://${USER}:${PASSWORD}@${container.getHost()}:${String(
      container.getMappedPort(5432),
    )}/postgres`,
  );
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = undefined;
}
