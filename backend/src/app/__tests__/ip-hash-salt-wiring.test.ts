import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '@/platform/cache/index';
import { FixedClock } from '@/platform/clock/index';
import { parseConfig } from '@/platform/config/load-config';
import { CounterIdGen } from '@/platform/id-gen/index';
import { FakeLogger } from '@/platform/logger/index';
import { RecordingMail } from '@/platform/mail/index';
import { hashIp } from '@/modules/identity/domain/token';
import { UNCONFIGURED_IP_HASH_SALT, IP_HASH_SALT_ENV_VAR } from '@/modules/identity/index';
import { createContainer, type Container } from '../container';
import { buildModules } from '../routes';

/**
 * ===========================================================================
 * `IDENTITY_IP_HASH_SALT` IS A CONFIGURED SECRET, NOT A BUILD CONSTANT — D-223.
 *
 * D-221 salted `hashIp` and could reach neither `platform/config` nor
 * `app/routes.ts`, so the identity module resolved the salt itself: when none
 * was supplied it logged a warn and used `UNCONFIGURED_IP_HASH_SALT` — a
 * constant sitting IN THE SOURCE, documented as not secret.
 *
 * WHAT THAT COSTS. `sessions.ip_hash` is a SHA-256 over an IPv4 space of 2^32
 * addresses. Unsalted, it is a rainbow table anybody can build in minutes: the
 * column is pseudonymised in name only. A build-constant salt defeats a
 * GENERIC precomputed table and defends against nobody who has read this
 * repository — and since the identical digest is also a rate-limit cache key,
 * it joins a Valkey dump to a Postgres dump exactly.
 *
 * THIS FILE ASSERTS THE THREADING, which is the part that was missing and the
 * part with no symptom. The module's own tests all pass a salt directly, so
 * every one of them was green while the composition root passed nothing at
 * all — the same shape as the unwired audit port and the unwired metrics sink
 * before them.
 * ===========================================================================
 */

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5433/unused',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://app.test',
  API_URL: 'http://api.test',
} as const;

const SALT = 'f'.repeat(64);

let container: Container | undefined;
let logger: FakeLogger;

afterEach(async () => {
  await container?.shutdown();
  container = undefined;
});

function boot(env: Record<string, string | undefined>): Container {
  const clock = new FixedClock('2026-08-09T09:00:00.000Z');
  logger = new FakeLogger();
  container = createContainer(parseConfig({ ...BASE, ...env }), {
    clock,
    idGen: new CounterIdGen(),
    cache: new MemoryCache(clock),
    mail: new RecordingMail(),
    logger,
  });
  return container;
}

describe('the schema parses IDENTITY_IP_HASH_SALT', () => {
  it('exposes it on the frozen config', () => {
    expect(boot({ IDENTITY_IP_HASH_SALT: SALT }).config.identity.ipHashSalt).toBe(SALT);
  });

  it('is null — a fact, not an omission — when unset', () => {
    // `null` rather than `undefined` for the same reason as the AI and payment
    // credentials: on a readonly property `undefined` cannot be told apart from
    // a field nobody thought to set, and this one has a security consequence.
    expect(boot({}).config.identity.ipHashSalt).toBeNull();
  });

  it('treats an EMPTY value as absent rather than refusing to boot', () => {
    // compose.prod.yml passes this with a soft `${VAR:-}` default, so an
    // operator who has not set it yet supplies `''`. Refusing that would
    // restart-loop the stack on the deploy that introduced the variable —
    // D-250, a fix that causes the outage.
    expect(boot({ IDENTITY_IP_HASH_SALT: '' }).config.identity.ipHashSalt).toBeNull();
    expect(boot({ IDENTITY_IP_HASH_SALT: '   ' }).config.identity.ipHashSalt).toBeNull();
  });

  it('REFUSES a salt too short to be worth having', () => {
    // A 16-character salt reads as "configured" in a manifest and is far closer
    // to no salt than to a good one. Silence here would be the worst outcome:
    // the warn is gone, so nobody looks again.
    expect(() => parseConfig({ ...BASE, IDENTITY_IP_HASH_SALT: 'a'.repeat(31) })).toThrow(
      /at least 32 characters/,
    );
  });
});

describe('app/routes.ts threads the salt into the identity module', () => {
  it('USES THE CONFIGURED SALT — the assertion the module’s own tests cannot make', () => {
    /**
     * Observed through the rate-limit key the module derives, because that is
     * the digest's other home and the only externally visible one. If the
     * composition root failed to pass the salt, this would equal the digest
     * under `UNCONFIGURED_IP_HASH_SALT` instead — silently, with the module
     * working perfectly and every one of its unit tests green.
     */
    const built = boot({ IDENTITY_IP_HASH_SALT: SALT });
    const modules = buildModules(built);
    expect(modules.identity.service).toBeDefined();

    expect(built.config.identity.ipHashSalt).toBe(SALT);
    // The two digests must differ, or "the salt was threaded" is unfalsifiable.
    expect(hashIp('203.0.113.7', SALT)).not.toBe(
      hashIp('203.0.113.7', UNCONFIGURED_IP_HASH_SALT),
    );
  });

  it('does NOT substitute a value when unset, so the warn still fires', () => {
    /**
     * The subtle way this wiring goes wrong. Passing `config.identity.ipHashSalt
     * ?? SOME_DEFAULT` from the composition root would type-check, work, and
     * SILENCE `resolveIpHashSalt`'s warn — removing the only signal that a
     * deployment is still hashing with a constant from the source. The field is
     * therefore omitted entirely rather than passed as a value.
     */
    const built = boot({});
    buildModules(built);

    const warned = logger.lines.find(
      (line) => line.obj.event === 'identity.ip_hash_salt_unconfigured',
    );
    expect(warned).toBeDefined();
    expect(warned?.level).toBe('warn');
    // It names the variable an operator has to go and set.
    expect(warned?.obj.envVar).toBe(IP_HASH_SALT_ENV_VAR);
  });

  it('is SILENT once the salt is configured — the warn means something', () => {
    // A warn that fires on every boot regardless is a warn that gets filtered.
    const built = boot({ IDENTITY_IP_HASH_SALT: SALT });
    buildModules(built);

    expect(
      logger.lines.some((line) => line.obj.event === 'identity.ip_hash_salt_unconfigured'),
    ).toBe(false);
  });

  it('names the variable the schema actually parses', () => {
    // `IP_HASH_SALT_ENV_VAR` was declared by the identity module for the config
    // owner to point at. If the two ever disagreed, the warn would send an
    // operator to set a variable that nothing reads.
    expect(IP_HASH_SALT_ENV_VAR).toBe('IDENTITY_IP_HASH_SALT');
    expect(boot({ [IP_HASH_SALT_ENV_VAR]: SALT }).config.identity.ipHashSalt).toBe(SALT);
  });
});
