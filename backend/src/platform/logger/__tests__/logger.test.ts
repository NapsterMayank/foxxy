import { describe, expect, it } from 'vitest';
import { createLogger, buildLoggerOptions } from '../logger';
import { REDACT_CENSOR, REDACT_PATHS, SENSITIVE_KEY_LIST } from '../redaction';
import { FakeLogger } from '../fake-logger';

/** Captures pino output as parsed JSON objects. */
function captureLogger(): { logger: ReturnType<typeof createLogger>; lines: unknown[] } {
  const lines: unknown[] = [];
  const logger = createLogger(
    { level: 'trace', env: 'test' },
    {
      write(chunk: string): void {
        lines.push(JSON.parse(chunk));
      },
    },
  );
  return { logger, lines };
}

describe('redaction configuration', () => {
  it('covers every sensitive key named in the plan', () => {
    for (const key of [
      'password',
      'token',
      'email',
      'phone',
      'authorization',
      'cookie',
      'otp',
      'apiKey',
    ]) {
      expect(SENSITIVE_KEY_LIST).toContain(key);
    }
  });

  it('registers each sensitive key at the root and one and two levels deep', () => {
    expect(REDACT_PATHS).toContain('password');
    expect(REDACT_PATHS).toContain('*.password');
    expect(REDACT_PATHS).toContain('*.*.password');
  });

  it('redacts request authorization and cookie headers', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
    expect(REDACT_PATHS).toContain('req.headers.cookie');
  });

  it('configures redaction once, at construction', () => {
    const options = buildLoggerOptions({ level: 'info', env: 'test' });
    expect(options.redact).toMatchObject({ censor: REDACT_CENSOR, remove: false });
  });
});

describe('the real logger', () => {
  it('emits JSON with the level and the environment', () => {
    const { logger, lines } = captureLogger();
    logger.info({ userCount: 3 }, 'hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', env: 'test', msg: 'hello', userCount: 3 });
  });

  it.each(['password', 'token', 'email', 'phone', 'otp', 'apiKey', 'authorization', 'cookie'])(
    'redacts a top-level %s field',
    (key) => {
      const { logger, lines } = captureLogger();
      logger.info({ [key]: 'the-secret-value' });
      expect(JSON.stringify(lines[0])).not.toContain('the-secret-value');
      expect(JSON.stringify(lines[0])).toContain(REDACT_CENSOR);
    },
  );

  it('redacts a nested email one level deep', () => {
    const { logger, lines } = captureLogger();
    logger.info({ user: { id: 'u1', email: 'child@example.com' } });
    const output = JSON.stringify(lines[0]);
    expect(output).not.toContain('child@example.com');
    expect(output).toContain('u1');
  });

  it('redacts a nested token two levels deep', () => {
    const { logger, lines } = captureLogger();
    logger.info({ ctx: { session: { tokenHash: 'abc123secret' } } });
    expect(JSON.stringify(lines[0])).not.toContain('abc123secret');
  });

  it('leaves non-sensitive fields intact', () => {
    const { logger, lines } = captureLogger();
    logger.info({ chapterId: 'ch-7', grade: '7' });
    expect(lines[0]).toMatchObject({ chapterId: 'ch-7', grade: '7' });
  });

  it('carries the request id on a child logger', () => {
    const { logger, lines } = captureLogger();
    logger.child({ requestId: 'req-1' }).warn({}, 'careful');
    expect(lines[0]).toMatchObject({ requestId: 'req-1', level: 'warn' });
  });

  it('respects the configured level', () => {
    const lines: unknown[] = [];
    const logger = createLogger(
      { level: 'warn', env: 'test' },
      {
        write(chunk: string): void {
          lines.push(JSON.parse(chunk));
        },
      },
    );
    logger.info({}, 'suppressed');
    logger.warn({}, 'emitted');
    expect(lines).toHaveLength(1);
  });
});

describe('FakeLogger', () => {
  it('records level, payload and message', () => {
    const fake = new FakeLogger();
    fake.error({ code: 'BOOM' }, 'it broke');
    expect(fake.lines).toEqual([
      { level: 'error', bindings: {}, obj: { code: 'BOOM' }, msg: 'it broke' },
    ]);
  });

  it('records every level', () => {
    const fake = new FakeLogger();
    fake.fatal({});
    fake.error({});
    fake.warn({});
    fake.info({});
    fake.debug({});
    fake.trace({});
    expect(fake.lines.map((line) => line.level)).toEqual([
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ]);
  });

  it('merges child bindings and shares the parent buffer', () => {
    const fake = new FakeLogger({ service: 'api' });
    fake.child({ requestId: 'req-9' }).info({}, 'in child');
    expect(fake.lines).toHaveLength(1);
    expect(fake.lines[0]?.bindings).toEqual({ service: 'api', requestId: 'req-9' });
  });
});
