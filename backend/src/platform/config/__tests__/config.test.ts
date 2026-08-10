import { describe, expect, it } from 'vitest';
import { parseConfig, formatEnvErrors } from '../load-config';

const VALID: Record<string, string> = {
  DATABASE_URL: 'postgres://foxxy:pw@localhost:5432/foxxy',
  REDIS_URL: 'redis://localhost:6379',
  CORS_READ_ORIGINS: 'http://localhost:3000',
  CORS_WRITE_ORIGINS: 'http://localhost:3000',
  SESSION_COOKIE_NAME: 'foxxy_session',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
};

/** A copy of VALID with one variable absent. */
function without(key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(VALID).filter(([name]) => name !== key));
}

describe('parseConfig — required variables', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = parseConfig(VALID);
    expect(config.env).toBe('development');
    expect(config.server.port).toBe(4000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.log.level).toBe('info');
    expect(config.db.poolMax).toBe(10);
    expect(config.db.ssl).toBe(false);
    expect(config.http.timeoutMs).toBe(10_000);
    expect(config.http.maxRetries).toBe(2);
    expect(config.session.ttlDays).toBe(30);
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'CORS_READ_ORIGINS',
    'CORS_WRITE_ORIGINS',
    'SESSION_COOKIE_NAME',
    'APP_URL',
    'API_URL',
  ])(
    'refuses to build a config when %s is missing',
    (key) => {
      expect(() => parseConfig(without(key))).toThrow(/Invalid environment configuration/);
    },
  );

  it('names the missing variable in the error message', () => {
    expect(() => parseConfig(without('DATABASE_URL'))).toThrow(/DATABASE_URL/);
  });

  it('reports every missing variable at once, not just the first', () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });
});

describe('parseConfig — validation', () => {
  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() => parseConfig({ ...VALID, DATABASE_URL: 'mysql://localhost/foxxy' })).toThrow(
      /postgres/,
    );
  });

  it('rejects a REDIS_URL that is not a redis connection string', () => {
    expect(() => parseConfig({ ...VALID, REDIS_URL: 'http://localhost:6379' })).toThrow(/redis/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseConfig({ ...VALID, NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects a port outside the valid range', () => {
    expect(() => parseConfig({ ...VALID, PORT: '70000' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseConfig({ ...VALID, PORT: 'four-thousand' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an empty CORS_READ_ORIGINS', () => {
    expect(() => parseConfig({ ...VALID, CORS_READ_ORIGINS: '' })).toThrow(/CORS_READ_ORIGINS/);
  });

  it('rejects an empty CORS_WRITE_ORIGINS', () => {
    expect(() => parseConfig({ ...VALID, CORS_WRITE_ORIGINS: '' })).toThrow(/CORS_WRITE_ORIGINS/);
  });

  /**
   * WRITE MUST BE A SUBSET OF READ — open item 1.
   *
   * An origin allowed to POST must be able to read the response to its POST, so
   * a write grant that is not also a read grant is not a stricter policy, it is
   * a broken one: the browser makes the request, the server acts on it, and the
   * CORS layer then refuses to let the caller see what happened.
   */
  it('rejects a write origin that is not also a read origin', () => {
    expect(() =>
      parseConfig({
        ...VALID,
        CORS_READ_ORIGINS: 'http://app.test',
        CORS_WRITE_ORIGINS: 'http://partner.test',
      }),
    ).toThrow(/CORS_WRITE_ORIGINS/);
  });

  it('accepts a write list that is a strict subset of the read list', () => {
    const config = parseConfig({
      ...VALID,
      CORS_READ_ORIGINS: 'http://app.test,http://partner.test',
      CORS_WRITE_ORIGINS: 'http://app.test',
    });
    expect(config.http.corsReadOrigins).toEqual(['http://app.test', 'http://partner.test']);
    expect(config.http.corsWriteOrigins).toEqual(['http://app.test']);
  });

  /**
   * The retired variable fails LOUDLY rather than being ignored.
   *
   * A stale `CORS_ORIGINS` sitting in a production environment while the
   * operator believes it is allowing an origin is the worst of both worlds — and
   * in this case what they believe is that an origin is permitted when it is
   * not.
   */
  it('REFUSES to start when the retired CORS_ORIGINS is still set', () => {
    expect(() => parseConfig({ ...VALID, CORS_ORIGINS: 'http://app.test' })).toThrow(
      /CORS_ORIGINS has been split/,
    );
  });
});

describe('parseConfig — coercion', () => {
  it('coerces PORT to a number', () => {
    expect(parseConfig({ ...VALID, PORT: '4000' }).server.port).toBe(4000);
  });

  it('coerces DATABASE_SSL to a boolean', () => {
    expect(parseConfig({ ...VALID, DATABASE_SSL: 'true' }).db.ssl).toBe(true);
    expect(parseConfig({ ...VALID, DATABASE_SSL: 'false' }).db.ssl).toBe(false);
  });

  it('splits each origin list on commas and trims every entry', () => {
    const config = parseConfig({
      ...VALID,
      CORS_READ_ORIGINS: 'http://a.test , http://b.test,  http://c.test ',
      CORS_WRITE_ORIGINS: ' http://a.test ',
    });
    expect(config.http.corsReadOrigins).toEqual([
      'http://a.test',
      'http://b.test',
      'http://c.test',
    ]);
    expect(config.http.corsWriteOrigins).toEqual(['http://a.test']);
  });

  it('sets isProduction and isTest from NODE_ENV', () => {
    expect(parseConfig({ ...VALID, NODE_ENV: 'production' }).isProduction).toBe(true);
    expect(parseConfig({ ...VALID, NODE_ENV: 'test' }).isTest).toBe(true);
    expect(parseConfig(VALID).isProduction).toBe(false);
  });
});

describe('parseConfig — immutability', () => {
  it('returns a frozen object', () => {
    const config = parseConfig(VALID);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.db)).toBe(true);
    expect(Object.isFrozen(config.http.corsReadOrigins)).toBe(true);
    expect(Object.isFrozen(config.http.corsWriteOrigins)).toBe(true);
  });
});

describe('formatEnvErrors', () => {
  it('produces a multi-line message that points at .env.example', () => {
    const message = formatEnvErrors([{ path: 'DATABASE_URL', message: 'Required' }]);
    expect(message).toContain('The server cannot start');
    expect(message).toContain('  - DATABASE_URL: Required');
    expect(message).toContain('.env.example');
  });
});
