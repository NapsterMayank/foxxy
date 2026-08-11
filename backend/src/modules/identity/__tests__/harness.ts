import type { FastifyInstance } from 'fastify';
import { DEFAULT_TENANT_ID } from '@/platform/db/schema/tenants';
import { MemoryCache, type CachePort } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { CounterIdGen } from '@/platform/id-gen/index';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail, type MailPort } from '@/platform/mail/index';
import { createContainer, type Container } from '../../../app/container';
import { createServer } from '../../../app/server';
import { createIdentityModule, type IdentityModule } from '../index';
import type { MetricsSink } from '../identity.rate-limit';
import type { PasswordHasher } from '../identity.types';
import { applyAllMigrations, startTestPostgres } from '../../../../tests/helpers/postgres';
import type { TestPostgres } from '../../../../tests/helpers/postgres';

/**
 * The identity service-test harness.
 *
 * A REAL Postgres, in a container (§9.1). The database is never faked: a fake
 * hides exactly the bugs worth finding here — the UNIQUE constraint that
 * closes the signup race, the `FOR UPDATE` that makes token consumption single
 * use, and whether "delete every session" really happens inside the same
 * transaction as the password write.
 *
 * Everything else IS faked, because everything else is slow, costly or
 * non-deterministic: the clock, the cache, the mailer, the id generator.
 */

/**
 * A deterministic stand-in for Argon2id.
 *
 * Argon2 at the OWASP parameters costs tens of milliseconds by design, and a
 * suite that creates a few dozen accounts would spend nearly all of its time
 * inside it. Slow suites get skipped, and a skipped suite protects nothing.
 *
 * The REAL hasher is exercised where it is the thing under test: the parameter
 * assertions and the login timing test both use `createArgon2PasswordHasher`.
 */
export class FakeHasher implements PasswordHasher {
  /** Every verify call, in order — this is how the timing defence is observed. */
  readonly verifyCalls: { hash: string; password: string }[] = [];
  readonly hashCalls: string[] = [];

  hash(password: string): Promise<string> {
    this.hashCalls.push(password);
    return Promise.resolve(`fake$${password}`);
  }

  verify(hash: string, password: string): Promise<boolean> {
    this.verifyCalls.push({ hash, password });
    return Promise.resolve(hash === `fake$${password}`);
  }

  dummyHash(): Promise<string> {
    return Promise.resolve('fake$__dummy__');
  }
}

export const TEST_COOKIE_NAME = 'foxxy_session';

/**
 * The tenant every harness account belongs to - D-073.
 *
 * The literal that migration 0004 seeds, imported from the schema rather than
 * retyped, because three copies of a UUID is three chances for one of them to
 * be a different UUID.
 */
export const TEST_TENANT_ID = DEFAULT_TENANT_ID;

/**
 * A SECOND tenant, created on demand by `createSecondTenant` below.
 *
 * Fixed rather than generated so that a failing cross-tenant assertion names a
 * value a reader can grep for.
 */
export const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

/**
 * The salt every harness account's identifier hashes use — D-221.
 *
 * Fixed and explicit rather than left to the module's unconfigured fallback, so
 * that a test asserting "the digest is not the bare SHA-256" is asserting about
 * a salt it can name.
 */
export const TEST_IP_HASH_SALT = 'harness-ip-hash-salt';

/** Records every metric the module emits. Assertions run against `counts`. */
export class RecordingMetrics implements MetricsSink {
  readonly emitted: { metric: string; tags: Readonly<Record<string, string>> | undefined }[] = [];

  increment(metric: string, tags?: Readonly<Record<string, string>>): void {
    this.emitted.push({ metric, tags });
  }

  countOf(metric: string): number {
    return this.emitted.filter((entry) => entry.metric === metric).length;
  }

  clear(): void {
    this.emitted.length = 0;
  }
}

export interface IdentityHarness {
  readonly postgres: TestPostgres;
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly identity: IdentityModule;
  readonly clock: FixedClock;
  readonly cache: MemoryCache;
  readonly mail: RecordingMail;
  readonly logger: FakeLogger;
  readonly hasher: FakeHasher;
  /** Every metric the module emitted — the mail-deferral signal lives here. */
  readonly metrics: RecordingMetrics;
  /** Empties every identity table and the cache. Call between tests. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const IDENTITY_TABLES = [
  'sessions',
  'email_verification_tokens',
  'password_reset_tokens',
  'parent_child_links',
  // Link codes are ROWS now, not cache entries (D-012), so they need emptying
  // between tests like every other table.
  'link_codes',
  'users',
] as const;

export async function startIdentityHarness(
  options: {
    hasher?: PasswordHasher;
    /**
     * Substitute the cache the MODULE receives — used to prove that login
     * survives a cache outage on the in-process rate-limit fallback
     * (04-RESILIENCE-PLAN.md §11). `harness.cache` still refers to the
     * MemoryCache, so `reset()` behaves the same either way.
     */
    cache?: CachePort;
    /**
     * Substitute the mail port the MODULE receives — used to prove that signup
     * survives a mail outage (D-217) and that the send is off the request path
     * (D-218). `harness.mail` still refers to the `RecordingMail`, so a test
     * that overrides this asserts against its own fake.
     */
    mail?: MailPort;
  } = {},
): Promise<IdentityHarness> {
  const postgres = await startTestPostgres();

  /**
   * EVERY migration, discovered from the directory — never a list written out
   * here.
   *
   * This harness used to name its migrations: `['0000_identity.sql']`. When
   * `0001_link_codes` was added the list was not updated, and every identity
   * service test then ran against a schema with no `link_codes` table. Nothing
   * went red, because the tests that would have caught it were the ones the
   * migration was written for. `applyAllMigrations` removes the list entirely,
   * so the failure mode has nowhere to live.
   */
  await applyAllMigrations(postgres.client);

  const clock = new FixedClock('2026-06-01T09:00:00.000Z');
  const cache = new MemoryCache(clock);
  const mail = new RecordingMail();
  const logger = new FakeLogger();
  const hasher = new FakeHasher();
  const metrics = new RecordingMetrics();

  const config = parseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: postgres.url,
    REDIS_URL: 'redis://localhost:6379',
    CORS_READ_ORIGINS: 'http://localhost:3000',
    CORS_WRITE_ORIGINS: 'http://localhost:3000',
    SESSION_COOKIE_NAME: TEST_COOKIE_NAME,
    APP_URL: 'http://app.test',
    API_URL: 'http://api.test',
  });

  const container = createContainer(config, {
    clock,
    cache,
    mail,
    logger,
    idGen: new CounterIdGen(),
  });

  const identity = createIdentityModule({
    db: container.poolFor('identity'),
    cache: options.cache ?? cache,
    mail: options.mail ?? mail,
    clock,
    logger,
    session: { name: TEST_COOKIE_NAME, ttlDays: config.session.ttlDays, secure: true },
    defaultTenantId: config.tenancy.defaultTenantId,
    urls: { apiBaseUrl: 'http://api.test', appBaseUrl: 'http://app.test' },
    hasher: options.hasher ?? hasher,
    metrics,
    ipHashSalt: TEST_IP_HASH_SALT,
  });

  const app = await createServer(container, { modules: { identity } });
  await app.ready();

  return {
    postgres,
    container,
    app,
    identity,
    clock,
    cache,
    mail,
    logger,
    hasher,
    metrics,
    async reset(): Promise<void> {
      await postgres.client.query(
        `truncate table ${IDENTITY_TABLES.join(', ')} restart identity cascade`,
      );
      await cache.close();
      mail.sent.length = 0;
      metrics.clear();
      hasher.verifyCalls.length = 0;
      hasher.hashCalls.length = 0;
      clock.setTo('2026-06-01T09:00:00.000Z');
    },
    async stop(): Promise<void> {
      await app.close();
      await container.shutdown();
      await postgres.stop();
    },
  };
}

/**
 * Inserts a SECOND tenant, for the cross-tenant tests.
 *
 * A real row rather than a bare UUID: `users.tenant_id` carries a foreign key to
 * `tenants` with ON DELETE RESTRICT, so a test that moved an account to an
 * invented tenant would fail on the constraint rather than on the rule it was
 * written to check - and would read as if tenancy were broken.
 */
export async function createSecondTenant(harness: {
  postgres: { client: { query(sql: string, values?: unknown[]): Promise<unknown> } };
}): Promise<string> {
  await harness.postgres.client.query(
    `insert into tenants (id, slug, name) values ($1, 'other', 'Other tenant')
       on conflict (id) do nothing`,
    [OTHER_TENANT_ID],
  );
  return OTHER_TENANT_ID;
}

/** Pulls the session cookie value out of a `set-cookie` header. */
export function sessionCookieFrom(setCookie: string | string[] | undefined): string | null {
  if (setCookie === undefined) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    const match = new RegExp(`${TEST_COOKIE_NAME}=([^;]*)`).exec(header);
    if (match?.[1] !== undefined && match[1].length > 0) return match[1];
  }
  return null;
}
