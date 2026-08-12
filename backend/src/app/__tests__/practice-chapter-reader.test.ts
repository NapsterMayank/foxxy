import { describe, expect, it } from 'vitest';
import { ConflictError, DependencyError, ForbiddenError, NotFoundError } from '../../platform/errors/index';
import { createPracticeChapterReader } from '../routes';

/**
 * =============================================================================
 * ONLY A MISSING CHAPTER BECOMES `null` — D-325, PROVEN. D-334.
 *
 * The `content` → `practice` chapter edge translates one module's exception into
 * another module's value. It was a BARE `catch`, which meant EVERY failure
 * became "there is no such chapter":
 *
 *   pool exhausted        → student sees "chapter not found"
 *   statement timeout     → student sees "chapter not found"
 *   breaker open          → student sees "chapter not found"
 *   ForbiddenError        → student sees "chapter not found"
 *
 * Nothing propagated, no breaker counted a failure it should have counted, no
 * metric moved, and the student was told the chapter does not exist — the one
 * answer guaranteed to make them stop looking. `platform/db` under load would
 * have presented as a curriculum that had quietly emptied.
 *
 * The narrowing to `if (error instanceof NotFoundError)` was already correct
 * when this file was written. What it was not, was PROVABLE: it lived in a
 * closure inside `buildModules`, reachable only through a container, a real
 * content module and a database that could be made to fail in two
 * distinguishable ways. So nothing tested it, and `catch {}` and the narrowed
 * version were indistinguishable to the suite — which is precisely how the bare
 * catch survived as long as it did.
 *
 * Lifting it to a named export (the D-257 move, after the same class of silent
 * defect) turns it into the tests below: no container, no database, no
 * infrastructure. The value of this file is the NEGATIVE cases — every one of
 * them was a 404 before D-325, and every one of them would be a 404 again the
 * moment somebody "simplified" the catch.
 * =============================================================================
 */

interface FakeChapter {
  readonly id: string;
  readonly title: string;
}

const ACTOR = { userId: 'user-1', role: 'student' } as const;
const CHAPTER: FakeChapter = { id: 'ch-1', title: 'Light — Reflection and Refraction' };

function createPracticeChapterReaderFor(
  behaviour: (actor: typeof ACTOR, chapterId: string) => Promise<FakeChapter>,
): (actor: typeof ACTOR, chapterId: string) => Promise<FakeChapter | null> {
  return createPracticeChapterReader(behaviour);
}

/**
 * Fails with whatever it is given, the way a failing dependency does.
 *
 * `throw` rather than `Promise.reject`: one of the cases below rejects with a
 * STRING on purpose — `instanceof` is false for it, and the branch it must not
 * take is the one returning `null` — and `prefer-promise-reject-errors` is right
 * that production code should never do that, which is why the non-Error case is
 * expressed as a throw inside an async function instead of arguing with the rule.
 */
function fails(
  error: unknown,
): (actor: typeof ACTOR, chapterId: string) => Promise<FakeChapter | null> {
  return createPracticeChapterReaderFor(() => {
    throw error;
  });
}

describe('the chapter edge passes a real chapter straight through (D-334)', () => {
  it('returns the chapter unchanged', async () => {
    await expect(
      createPracticeChapterReaderFor(() => Promise.resolve(CHAPTER))(ACTOR, 'ch-1'),
    ).resolves.toEqual(CHAPTER);
  });

  it('forwards the actor and the chapter id, unmodified', async () => {
    const seen: { actor: unknown; chapterId: string }[] = [];
    const read = createPracticeChapterReaderFor((actor, chapterId) => {
      seen.push({ actor, chapterId });
      return Promise.resolve(CHAPTER);
    });

    await read(ACTOR, 'ch-42');

    expect(seen).toEqual([{ actor: ACTOR, chapterId: 'ch-42' }]);
  });
});

describe('a WITHDRAWN chapter becomes null — the one translation (D-334)', () => {
  it('turns NotFoundError into null, so practice can use its own wording', async () => {
    // A session whose chapter was withdrawn mid-flight must not surface
    // content's 404 — practice has its own message for it.
    await expect(fails(new NotFoundError('Chapter not found.'))(ACTOR, 'ch-1')).resolves.toBeNull();
  });
});

describe('every OTHER failure propagates — D-334, and this is the defect', () => {
  it('a DEPENDENCY failure is NOT a missing chapter', async () => {
    // Pool exhaustion, statement timeout, breaker open. Swallowing this is what
    // made a database under load look like an empty curriculum.
    const outage = new DependencyError('postgres');

    await expect(fails(outage)(ACTOR, 'ch-1')).rejects.toBe(outage);
  });

  it('a FORBIDDEN chapter is NOT a missing chapter', async () => {
    // The difference between "you may not read this" and "this does not exist"
    // is the difference between a permissions bug an operator can see and one
    // that presents as missing content.
    const denied = new ForbiddenError({ message: 'Actor may not read content' });

    await expect(fails(denied)(ACTOR, 'ch-1')).rejects.toBe(denied);
  });

  it('a plain Error — a bug in content — is NOT a missing chapter', async () => {
    // The most important case, because it is the one nobody anticipates. An
    // undefined property read inside `content` must reach the error handler as
    // a 500, not be laundered into a 404 that looks like ordinary content churn.
    const bug = new TypeError("Cannot read properties of undefined (reading 'grade')");

    await expect(fails(bug)(ACTOR, 'ch-1')).rejects.toBe(bug);
  });

  it('a CONFLICT is NOT a missing chapter', async () => {
    const conflict = new ConflictError('Concurrent update.');

    await expect(fails(conflict)(ACTOR, 'ch-1')).rejects.toBe(conflict);
  });

  it('a non-Error rejection still propagates rather than becoming null', async () => {
    // `instanceof` on a string is false, and the branch it must NOT take is the
    // one that returns null.
    await expect(fails('database is closed')(ACTOR, 'ch-1')).rejects.toBe('database is closed');
  });
});
