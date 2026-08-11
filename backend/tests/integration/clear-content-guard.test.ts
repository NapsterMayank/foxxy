import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/platform/config/load-config';
import { assertNotProduction } from '../../scripts/clear-content';

/**
 * =============================================================================
 * `clear-content` REFUSES TO RUN AGAINST PRODUCTION — D-234.
 *
 * `seed-dev.ts` has carried this guard since it was written. `clear-content.ts`
 * did not, and it is by far the more dangerous of the two:
 *
 *   seed-dev       inserts six fake chapters. Embarrassing, and reversible.
 *   clear-content  `TRUNCATE ... CASCADE` over six content tables, reaching
 *                  `chapter_mastery` — every student's learning history — with
 *                  no confirmation step and no backup step.
 *
 * The realistic accident is not somebody typing this at a production shell. It
 * is a `DATABASE_URL` still exported in a terminal from an earlier task, and
 * the command running EXACTLY AS DESIGNED against the wrong database.
 *
 * The corpus at risk is 137 chapters, 4,686 rag chunks and 2,741 questions, and
 * producing it cost a paid embedding run.
 *
 * THIS FILE TOUCHES NO DATABASE. It asserts on the pure guard, which is why the
 * guard was extracted into a function in the first place — an `if` inside a
 * non-exported `main` could only have been tested by actually running the
 * TRUNCATE, so it would have shipped untested, which is the shape of every
 * defect in this codebase's audit history.
 * =============================================================================
 */

describe('assertNotProduction', () => {
  it('THROWS for production — the named test the guard exists for', () => {
    expect(() => {
      assertNotProduction('production');
    }).toThrow(/refuses to run/u);
  });

  it('says what it would have destroyed, so the message is actionable', () => {
    // An error reading "refused" alone invites `NODE_ENV=development` and a
    // second attempt. Naming `chapter_mastery` is what makes somebody stop.
    expect(() => {
      assertNotProduction('production');
    }).toThrow(/chapter_mastery/u);
  });

  it.each(['development', 'test'])('permits %s, which is what the command is for', (env) => {
    expect(() => {
      assertNotProduction(env);
    }).not.toThrow();
  });

  it('is fed by the same validated enum the boot gates use', () => {
    // `config.env` is a zod enum of exactly these three values, so the equality
    // check cannot be defeated by casing or whitespace — the parser rejects
    // anything else before this function is reached. Asserted here rather than
    // trusted, because the guard's correctness depends on that narrowing and
    // the two files are edited independently.
    const base: Record<string, string> = {
      DATABASE_URL: 'postgres://foxxy:pw@127.0.0.1:1/foxxy',
      REDIS_URL: 'redis://localhost:6379',
      CORS_READ_ORIGINS: 'http://localhost:3000',
      CORS_WRITE_ORIGINS: 'http://localhost:3000',
      SESSION_COOKIE_NAME: 'foxxy_session',
      APP_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:4000',
    };

    expect(() => parseConfig({ ...base, NODE_ENV: 'PRODUCTION' })).toThrow();
    expect(() => parseConfig({ ...base, NODE_ENV: 'pre-production' })).toThrow();
    expect(parseConfig({ ...base, NODE_ENV: 'test' }).env).toBe('test');
  });
});
